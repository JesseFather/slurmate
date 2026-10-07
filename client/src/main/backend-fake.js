'use strict';
/**
 * backend-fake.js —— 假后端。
 *
 * ── 它不是什么 ─────────────────────────────────────────────────────────────
 * 它不是「随便返回点数据让界面能画出来」的空壳。它的 RPC 响应逐字段照着
 * `cluster/slurmate-sessiond` 的 `session_view` 和 `op_*` 构造，
 * 状态迁移照着真的状态机，并且**真的起一个 HTTP 服务**复刻 code-server
 * 的登录契约、**真的走一遍 tunnel.js**。
 *
 * 唯一被假掉的是 SSH 那一跳。
 *
 * ── 为什么值得这么做 ───────────────────────────────────────────────────────
 * 接真集群时，「会话登记超时」「守护进程挂掉」「作业被回收」「口令错」
 * 这些状态在真机上极难复现 —— 要等 30 分钟、要故意打错口令、要杀作业。
 * 有了它，这些路径在开发界面的当天就能反复走。
 *
 * ── 必须遵守 ───────────────────────────────────────────────────────────────
 * 开发者模式下界面要**醒目**标注「开发者模式 · 未连接集群」，用真实模式绝不会出现的
 * 颜色。做了假后端却不标注，正是这个项目一路在清的那类问题：系统声称了不成立的事。
 *
 * ── 关于分区与资源 ─────────────────────────────────────────────────────────
 * 分区不再来自「用途」配置，而是**直接从 Slurm 查**（守护进程侧走
 * `scontrol show partition` 并与该用户的 association 求交）。所以这里的假数据
 * 就是一份分区表 —— 字段名必须与守护进程逐字一致，否则界面会针对错误的字段名
 * 开发，接上真集群才发现对不上。
 *
 * 默认资源（2 CPU / 8G）由**服务端**填，客户端不填。假后端照做：
 * 请求里没给的键，就用 DEFAULTS。
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Backend, KIND } = require('./backend.js');
const { createDemoWebService } = require('./demo-server.js');
const pluginFiles = require('./plugins/index.js');

// 假站点里"站点装了新插件"用的假 id。形状必须是合法 ULID（守护进程与客户端都会
// 校验），但没有任何东西会去核对它是不是真铸出来的 —— 也核对不了。
const DEMO_EXTRA_ID = '01M2JKM1M1M1M1M1M1M1M1M1M1';

/**
 * 假站点里那次"变化的判据"，多久扫一遍。
 *
 * ★ 取守护进程那个 tick 的周期（2 秒），**不是**因为性能，是因为要**照着它演**：
 *   真守护进程的推送挂在 tick 上，所以"2 秒内的多次变化只会推出一条"是它的一条
 *   真实性质（用例 26.4 钉着"每个 tick 每条连接至多一条消息"）。假站点扫得快，
 *   这条性质就演不出来，而客户端对着它调的东西（合并、升级判定）会显得比真集群
 *   更容易通过。
 */
const PUSH_SWEEP_MS = 2000;

/**
 * 与守护进程的 `SNAPSHOT_INTERVAL` **同值**：哪怕什么都没变，也这么久推一条。
 *
 * ★ 它不是"心跳"。它是让客户端那条看门狗（session.js 的 `PUSH_STALE_MS`）能
 *   把**安静**与**通道坏了**分开的那条保证 —— 少了它，一个空闲的会话会被判成
 *   "通道不通"从而退回轮询，功能不受影响，但开发者模式里那条路就再也走不到了。
 */
const PUSH_INTERVAL_MS = 30000;

/**
 * ── 假站点的**整包**投递 ──────────────────────────────────────────────────
 *
 * 真实的守护进程发的是**一个包**（`package` + `plugin_package`），假站点照着
 * 它来。★ v0.6 假站点默认只发 `files`、整包那条挂在 `debugPackages` 后面，
 * 理由是"两条路都要有东西在测"；**v0.7 只剩一条了**，所以那两个开关
 * （`debugPackages` / `debugHideFiles`）跟着删掉 —— 留一个只能打开唯一那条路的
 * 开关，比没有它更糟。
 *
 * ★ 包是拿**仓库里那个打包器**（`packer/slurmate-packer.js`）现打的，不是手搓的
 *   字节：手搓一份就等于在假站点里又实现了一遍容器格式，而它与真格式分家的那天，
 *   假站点反而会说"一切正常"。打包器导出 `buildPackage`/`contentDigest`，够用了。
 *
 * ★ **签名钥匙由一个写死的种子推出来**，不是随机生成的。理由不是"简单"：
 *   客户端在用户第一次同意时会**钉住这把公钥**（§5.4），此后同一个 id 的每一份
 *   都必须由同一把钥匙签。每次进程启动换一把钥匙的话，第二次启动时那把钉子就会
 *   把假站点自己的插件拒掉 —— 这个假站点会坏在一个看起来像 bug 的地方。
 *   它是**模拟数据**，不是密钥。
 */
const DEMO_PKG_SEED = Buffer.from('slurmate-demo-package-key-v1!!!!', 'utf8');
/** PKCS#8 里 Ed25519 私钥的头部（RFC 8410），后面接 32 字节种子。 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');


// ★ **假站点报的插件 = 仓库里的 `<repo>/plugins/`。** 只有一个来源。
//
//   这一段换过两次，两次都是往下更正，值得把过程留着：
//
//   ① 最早这里写死两个插件（名字与 id 与客户端内建的那两份逐字相同）。基座不再
//      自带插件之后，那份写死就变成了一句谎话 —— 满屏"本站有而本机没有"，一个
//      **故意不带插件的基座**看起来像坏了。
//   ② 改成"报本机池里装了什么"。它解决了①，却留下一个更隐蔽的死角：站点报的
//      就是本机有的那些，于是「站点有而本机没有」这条**最重要的**路径在假站点里
//      永远走不到 —— 而开发者模式恰恰是这个项目里唯一能造出那些状态的地方。
//   ③ 分发接上来之后，站点改从仓库里读**真文件**（真的 sha256、真的字节），
//      客户端真的走一遍 下载 → 暂存校验 → 同意闸 → 换入。这才是"它演的是
//      生产那条路"该有的样子。
//
//   ★ 池删掉之后，②那条路**没有了**，也不该有：它读的是客户端自己的池，而池
//     只剩一个（站点池）——留着它就是让站点报它自己刚发下去的东西。
//
//   打包之后没有仓库目录，`_sitePluginDir` 返回 null ⇒ **站点一个插件都不报**。
//   这条降级如实记在账本里（从这里跑都是源码树，所以正常的开发流程看不到它）。

// 模拟用的分区表。取的是通用 GPU 型号名，不是任何特定集群的配置。
// 故意留一个 allowed:false 的，好让「没权限的分区要禁用并说明原因」这条路径
// 在开发者模式下也走得到。
//
// ★ GRES 那一格是**故意的假**，而且比真集群"脏"：本机那台真集群只有不带型号的
//   `gpu`，所以"带型号"（`gpu:a6000`）与"名字不是 gpu"（`mps`）这两条路**只在
//   这里走得到**。夹具比现实干净，缺陷就会在用例里隐形 —— 见账本 F26。
//   形状与字段名照抄 `scontrol show node -o` 的 `Gres=` 与守护进程的
//   `gres_catalog()`（`scontrol show config` 的 GresTypes 只列名字，不带数量）。
const GRES = {
  '2080TI': [{ name: 'gpu', type: null, per_node_max: 8, total: 8 }],
  'A6000': [{ name: 'gpu', type: 'a6000', per_node_max: 4, total: 8 }],
  // ★ 同一台集群上两种 GRES 并存，其中一种的数量是**按份额**算的（100 个）——
  //   一个写死的上限 8 会在这里立刻露馅。
  'RTX8000': [{ name: 'gpu', type: 'rtx8000', per_node_max: 4, total: 4 },
              { name: 'mps', type: null, per_node_max: 100, total: 100 }],
  'DEBUG': [],
};
const PARTITIONS = [
  { name: '2080TI',  allowed: true,  is_default: true, max_time: '183-00:00:00', gres: GRES['2080TI'] },
  { name: 'A6000',   allowed: true,  max_time: '183-00:00:00', gres: GRES['A6000'] },
  { name: 'RTX8000', allowed: true,  max_time: '183-00:00:00', gres: GRES['RTX8000'] },
  { name: 'DEBUG',   allowed: false, reason: '你的账户没有该分区的权限', max_time: '1:00:00', gres: GRES['DEBUG'] },
];

/**
 * 假站点的节点忙闲。★ **故意比真集群脏。**
 *
 * 本机那台真集群此刻四个节点全是 `idle`/`mix`，**一个带后缀的都没有** —— 于是
 * "剥掉后缀、只按 base state 计数，后缀原样留着只做展示"这条路径在真机上根本
 * 走不到，而它正是这一格唯一要验的那件事。夹具比现实干净，缺陷就会在用例里
 * 隐形（见账本 F26）。所以这里给两个带后缀的：
 *
 *   `drain*` —— 不响应（`*`）；`down~` —— 已关电（`~`）。
 *
 * ★ 形状与守护进程 `Slurm.node_table()` 的返回**逐字一致**：counts 只装 base
 *   state，flags 单独一列。两者的键**不相交**，那是"从右往左剥"能成立的前提。
 */
const NODES = {
  '2080TI': { counts: { idle: 1, drain: 1 }, flags: { '*': 1 } },
  'A6000': { counts: { mix: 2 }, flags: {} },
  'RTX8000': { counts: { idle: 1 }, flags: {} },
  'DEBUG': { counts: { down: 1 }, flags: { '~': 1 } },
};

/**
 * 假站点的队列。★ 同样故意脏：真集群此刻**全是 `PD`**，`R` 与"其余那一档"
 * （`CG` 收尾中）都走不到，而"其余那一档不并进 running"是这里唯一的判断。
 */
const QUEUE = {
  '2080TI': { pending: 4, running: 0, other: 0 },
  'A6000': { pending: 5, running: 2, other: 0 },
  'RTX8000': { pending: 0, running: 1, other: 1 },
  'DEBUG': { pending: 0, running: 0, other: 0 },
};

/** 假的 `sacct` 输出。★ 混进两条**作业步**（`.0` / `.extern`）不可能 —— 那个
 *  过滤发生在守护进程里，这里已经是过滤后的形状。 */
const HISTORY = [
  { job_id: '901002', name: 'code-server', state: 'COMPLETED', exit_code: '0:0',
    elapsed: '06:38:58', end: '2026-09-22T17:17:13', partition: 'A6000' },
  { job_id: '901001', name: 'code-server', state: 'TIMEOUT', exit_code: '0:0',
    elapsed: '5-01:01:38', end: '2026-09-22T10:36:34', partition: 'A6000' },
  { job_id: '901000', name: 'code-server', state: 'FAILED', exit_code: '0:9',
    elapsed: '00:03:11', end: '2026-09-21T09:02:00', partition: '2080TI' },
];

function sumCounts(counts) {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/** 服务端默认资源。客户端**不填**这些值 —— 缺省由服务端决定。
 *
 *  ★ `gpus: null` = **本站没给这个插件配默认卡**（`null` 是"确定的事实"，
 *    与那一格整个不在是两回事 —— 后者是老守护进程）。不给它一个具体的卡是
 *    有意的：假站点里分区是**随机挑**的，而三个分区的 GRES 型号互不相同 ——
 *    挑任何一个都会让另外两个分区在提交时以 `bad_gres` 被拒，于是"提交成功"
 *    这条主路会在开发者模式下时灵时不灵。要验"配了默认卡"那条路，
 *    用 `debugDefaultGpus()`。 */
const DEFAULTS = { cpus: 2, mem: '8G', time: '12:00:00', gpus: null };

const DEFAULT_TIME_SECONDS = 12 * 3600;
const DEMO_PASSWORD = 'demo-1a2b3c4d5e6f7081';  // 固定值，方便你手动 curl 验证

/** 假站点里「作业内 sshd」听在哪个端口。**没有真的 sshd** —— 见 _submit 的说明。 */
const DEMO_SSHD_PORT = 55901;
/**
 * 模拟用的主机公钥。**这不是一把真钥匙** —— 只是一串形状正确的 base64。
 * 客户端会把它写进 known_hosts（形状校验是真的），但假站点里那个端口后面没有
 * 任何东西在监听，所以 `ssh slurmate` 会在连接阶段就失败。这是诚实的：
 * 开发者模式假掉的从来不只是 SSH 那一跳，而这里连那一跳后面的 sshd 也是假的。
 */
const DEMO_HOST_KEY = 'ssh-ed25519 ' + 'A'.repeat(68);

/** 假站点自称的单文件上限。**故意与守护进程那个默认值一样** —— 免得假站点里
 *  一个 200 KiB 的文件在真机上通不过。故意报得**比客户端硬上限宽松**，好让
 *  "服务端只能收紧、客户端取更严的那个"这条在假站点里也走得到。 */
const DEMO_FILE_BYTES = 512 * 1024;

/**
 * 假站点自称的另外三个上限。★ **它们要与守护进程真正报的那几个数逐字相同** ——
 * 假站点的全部价值就是它演的是**同一件事**，而偏差是两个方向的坏事：
 *
 *   · 报得**更松** ⇒ 开发时通过、真机上被拒；
 *   · 报得**更严** ⇒ 开发时被拒、真机上反而能过（作者会去改一个没问题的插件）。
 *
 * ★ `file_bytes` **不在此列**（它是上面那个数）：那是**刻意**报得更松的，好让
 *   "服务端只能收紧、客户端取更严的那个"这条在假站点里也走得到。
 * ★ 这几个数由 `client/test/limits.test.mjs` 与守护进程那几份**跨文件**钉着。
 */
const DEMO_TOTAL_BYTES = 1562251;    // = PLUGIN_TOTAL_MAX_BYTES（包上限 − 信封最坏情况）
const DEMO_MAX_FILES = 256;
const DEMO_PACKAGE_BYTES = 2 << 20;  // = PLUGIN_PACKAGE_MAX_BYTES

/** 假站点在 `plugins` 那一条里自报的那一组。**导出去只给用例**（limits.test.mjs
 *  拿它与 tools/plugin-limits.json 比对 —— 它是"假站点演得像不像"的唯一判据）。 */
const DEMO_SITE_LIMITS = {
  file_bytes: DEMO_FILE_BYTES,
  total_bytes: DEMO_TOTAL_BYTES,
  max_files: DEMO_MAX_FILES,
  package_bytes: DEMO_PACKAGE_BYTES,
};

class FakeBackend extends Backend {
  /**
   * @param {object} opts
   *   enrollDelayMs  {number}  'submitted' → 'enrolled' 的延迟，默认 8000（真实集群上
   *                            这个等待可能是 30–60 秒，因为 NFS 属性缓存默认 60s）
   *   rpcLatencyMs   {number}  每次 RPC 的人为延迟，默认 40（贴近真实的 exec channel 开销）
   *   user           {string}  假站点里的用户名
   *   pickPartition  {function} 覆盖随机挑分区的行为，仅供测试固定结果用
   */
  constructor(opts = {}) {
    super();
    this.kind = KIND.FAKE;
    this.label = '本地模拟站点';
    this.enrollDelayMs = Number.isFinite(opts.enrollDelayMs) ? opts.enrollDelayMs : 8000;
    this.rpcLatencyMs = Number.isFinite(opts.rpcLatencyMs) ? opts.rpcLatencyMs : 40;
    this.user = opts.user || 'demo';
    this._pickPartition = typeof opts.pickPartition === 'function' ? opts.pickPartition : null;

    this._server = null;
    /**
     * 假站点上的全部会话。
     *
     * ★ 这里从前是**一个** `_session`。多开之后那不是"少几个字段"：客户端那一半
     *   能不能同时挂两条会话，**只有在假后端上才验得了**（真集群上要造出"两个
     *   会话同时活着"极难）。留一个单值的话，本阶段最要紧的那几条用例
     *   **根本没有办法跑起来** —— 而"用例跑不起来"与"功能是对的"在输出上长得一样。
     *
     * ★ 每条会话自己带定时器（`_enrollTimer` / `_releaseTimer`）：从前那两个字段
     *   挂在后端上，一个会话结束时 `_clearTimers()` 会把**另一条**会话的登记定时器
     *   一起清掉 —— 那条会话就永远停在 `submitted`，而界面上一切正常。
     */
    this._sessions = [];
    /**
     * 每人最多几条会话。与守护进程的 `max_sessions_per_user` 同一条规则，
     * 缺省也同值（1，安全侧）。用例直接把 `getBackend().maxActive = 2` 就能验多开。
     */
    this.maxActive = 1;
    /**
     * `scancel` 这一次会不会失败。**默认不失败**（正常的站点上它多半成功）。
     *
     * ★ 这个开关存在的理由与 `maxActive` 一样：真守护进程**会**在取消失败时
     *   回一个 `warning`（协议里那个字段，见 `op_goodbye`），而一个永远不会失败
     *   的假后端让客户端那一半**根本没有办法验**。假后端演的是同一件事 ——
     *   包括它失败的那一面。
     */
    this.cancelFails = false;
    this._seq = 0;
    /**
     * 这台电脑的客户端身份（见 backend.js 的接口注释）。
     *
     * ★★ v0.9：假站点**真的用它**了 —— 提交时写进会话行的 `keeper`（与真守护
     *   进程的 `op_submit(client_id)` 同一个位置），心跳按它判"这是不是看护者"，
     *   接管按它换人。从前这里写着"假后端不用它排席位"，那句话随着自动顶替
     *   一起过期了：今天的身份不用来排席位，用来**认看护者**。
     *
     * ★ 一个不看这个字段的假后端，会让"客户端身份根本没送到后端"这件事在
     *   开发者模式里完全看不出来 —— 而那正是这一版最重的一条失败形态
     *   （身份没到 ⇒ 看护者永远为空 ⇒ 谁也不认得自己的会话）。
     */
    this._client = (opts && opts.client) || null;
    /**
     * 假站点上**别人**的看护者（模拟另一台电脑）。`null` = 没有别人。
     *
     * ★ 存在的理由与 `cancelFails` 一样：真集群上"这条作业被另一台电脑看着"
     *   要两台机器才造得出来，而**接管**这个按钮的全部意义就是那一刻。
     *   `_sessions` 里那些会话的 keeper 会被它覆盖（见 `_effKeeper`）。
     */
    this._foreignKeeper = null;
    /**
     * 集群信息里**哪些格缺席**（`{health:true, nodes:true, …}`）。
     *
     * ★ 存在的理由是那一条三态规矩：「取不到」与「确实没有」在界面上是两句
     *   不同的话。真集群上"取不到"要么要等一次故障、要么要把 sinfo 改名 ——
     *   而它恰恰是这一整块最容易画错的那一格。见 _cluster()。
     */
    this._clusterMissing = {};
    /** `sacct` 取不到。同上 —— 它回的是**错误**不是空列表，两者不能混。 */
    this._historyDown = false;

    /**
     * 推送那一半的账。
     *
     * ★ 机制与守护进程的 `phase_push` **一样**：变化的判据是**渲染结果本身**
     *   （一份指纹），不是"谁改过状态"。差别只有载体（那边是 tick()，这里是
     *   一个定时器）。这样写不只是省事 —— 它让"忘了在某个改动点标脏"这件事
     *   从构造上不存在，而那个漏法的症状是**某个状态在界面上永远不更新**。
     */
    this._pushSeq = 0;
    this._pushDigest = null;
    this._pushAt = 0;
    this._pushTimer = null;

    // 调试开关 —— 由调试面板驱动，用来复现真机上极难复现的状态
    this._daemonDownUntil = 0;
    this._tunnelDownUntil = 0;
    this._connected = false;
    /** 调试用：站点多出来的插件（模拟"站点升级了、客户端没跟上"）。 */
    this._extraSitePlugins = [];
    /**
     * 假站点的**分发源**：仓库里的 `plugins/` 目录。
     *
     * 传函数而不是路径 —— 打包之后那个目录不存在，而"不存在"必须是**每次现算**
     * 的结果（从源码跑与从安装包跑是两个事实）。
     */
    this._sitePluginDir = typeof opts.sitePluginDir === 'function'
      ? opts.sitePluginDir : () => null;
    /** 调试用：让某一份的**包**里多一个超过单文件上限的文件。见 debugBloatPlugin。 */
    this._bloatPlugin = null;
    /** 调试用：让站点在 `plugin_package` 上回 rate_limited 若干次。 */
    this._rateLimitBurst = 0;
    /** 假站点里被"关掉"的插件（按短名）。原本是直接改那个写死的数组。 */
    this._siteDisabled = new Set();
    /**
     * 假站点里**装了但没有作业侧实现**的插件（按短名）。
     *
     * ★ 默认是空的：一个正常部署的站点，装了的插件就有作业脚本。这个集合是**故意
     *   造**那第四格状态的开关。真机上那件事来自 `install-base.sh` 有没有为这个插件生成
     *   `<ULID>.sbatch`，**客户端看不见** —— 所以它只可能由站点侧合成后报下来
     *   （`op_plugins` 的 `can_submit`）。
     */
    this._siteNoJob = new Set();
    /**
     * 假站点**报出去的基座版本**（`ping` 的 `version`）。
     *
     * ★ `null` = 跟着本客户端的版本走（也就是"版本一致、判定通过"）。
     *   要造"站点比客户端新"或"跨大版本"那两态，就用 `app:debug daemon-version`。
     *
     * ★ 从前这里写死一个 `'0.6-demo'`，而它**不合 `x.y` 的形状**——那条注释
     *   自己也写着"形状跟着框架版本走（x.y）"，写反了。那时没人读 `ping` 的
     *   `version`，所以是一个睡着的错；版本握手一做，它当场就会醒。
     *   现在"报一个明显假的值"这件事仍然可以造，但它搬到了调试开关里 ——
     *   报一个假版本号是有用的，只是不该是**默认**行为。
     */
    this._daemonVersion = null;
    /** 造出「守护进程太旧，根本没有 plugins 这个 op」。见 _dispatch。 */
    this._noPluginsOp = false;
    /** 造出「有 plugins 这个 op，但不会分发」（v0.5 的守护进程）。 */
    this._noDistribute = false;
    /**
     * 假站点报出来的**站点级插件问题**（`op_plugins` 顶层那个 `problems`）。
     *
     * ★ 默认空的，而且**在 `_noDistribute` 那一档里一律不发**：那个字段是 v0.11
     *   才有的，v0.5 的守护进程报不出来 —— 让它照发就等于演了一个不存在的版本。
     *   见 `debugPluginProblems` 与 `_dispatch` 的 `case 'plugins'`。
     */
    this._pluginProblems = [];
    /**
     * 站点给插件配的**默认 GRES**（`defaults.gpus`）。`null` = 没配（见 DEFAULTS）。
     *
     * ★ 真站点是**每个插件一份**，而假站点只有一份全局的 —— 与它给 cpus / mem /
     *   time 的待遇一样（DEFAULTS 那一份）。要验界面在"配了默认卡"时那句话怎么写，
     *   用 `debugDefaultGpus()`。
     *
     * ★ 它**不进 `_noDistribute` 那一档**：`defaults.gpus` 是 v0.11 才有的格，
     *   与 `time` / `problems` 同一条 —— 那一档照发就等于演了一个不存在的版本。
     */
    this._defaultGpus = null;
    /** 打好的包，按 `(id@版本)` 缓存 —— 见 _pkgOf。 */
    this._pkgCache = new Map();
  }

  /**
   * 这一份的包（现打、缓存）。返回 `{buf, meta, fingerprint}` 或 `null`。
   *
   * ★ 缓存**不失效**，与 `_siteIndex` 同一个语义：那一份索引是启动快照，而包的
   *   摘要与字节必须描述**同一棵树**。真守护进程那边正是这么做的
   *   （`Sessiond._plugin_cache`），"管理员就地换了文件"在两边都变成同一件事：
   *   清单、文件、包三者说的还是同一份东西，而客户端会拿到 `..._changed`。
   */
  _pkgOf(key) {
    if (this._pkgCache.has(key)) return this._pkgCache.get(key);
    const entry = this._siteIndex().get(key);
    if (!entry) return null;
    let out = null;
    try {
      const packer = require('../../../packer/slurmate-packer.js');
      const files = entry.files.map((f) => {
        const data = fs.readFileSync(path.join(entry.dir, ...f.path.split('/')));
        return { path: f.path, data, sha256: f.sha256 };
      });
      // ★ `debugBloatPlugin` 造的那一份：往**包里**塞一个装不下的文件。
      //   客户端读包时执行那几条负载上限（`checkDeclared`），所以它会在那里被拒
      //   —— 造的正是"站点支持分发，但这一份装不上"。
      if (this._bloatPlugin === key) {
        const big = Buffer.alloc(DEMO_FILE_BYTES + 1, 0x78);
        files.push({ path: 'bloat.bin', data: big,
                     sha256: crypto.createHash('sha256').update(big).digest('hex') });
      }
      const digest = packer.contentDigest(files);
      const priv = crypto.createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, DEMO_PKG_SEED]),
        format: 'der', type: 'pkcs8',
      });
      const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' })
        .subarray(-32);
      const sig = crypto.sign(null, Buffer.from(digest, 'hex'), priv);
      const buf = packer.buildPackage(files,
        Buffer.concat([Buffer.from([1]), pub, sig]));
      out = {
        buf,
        meta: { format: 1, bytes: buf.length, digest },
        fingerprint: crypto.createHash('sha256').update(pub).digest('hex'),
      };
    } catch {
      // 打包器不在（打包之后的安装包里没有 `packer/`）⇒ 这个站点**不发包**。
      // 与 `_sitePluginDir` 返回 null 是同一种降级：不是错误，是"这里没有它"。
      out = null;
    }
    this._pkgCache.set(key, out);
    return out;
  }

  /**
   * 假站点的**分发索引**：`(id@版本) → {dir, files}`，来自仓库里的 `plugins/`。
   *
   * ★ 这里那个 `files` 是**包里的记录表**（打包时要喂给打包器的负载清单），
   *   **不是**协议里那个已经删掉的 `files` 字段 —— 两件事同名，所以写清楚。
   *
   * ★ 建一次就**不再失效** —— 与守护进程侧的启动快照逐字同一个语义。这样开发者模式
   *   也能演"管理员就地换了文件"那件事：清单与包永远描述**同一棵树**。
   */
  _siteIndex() {
    if (this._indexCache) return this._indexCache;
    const cache = new Map();
    const base = this._sitePluginDir();
    if (base) {
      // ★ 扫树的规矩**只有一份**（`plugins/index.js` 的 scanPluginCollection）——
      //   开发者模式那个「插件来源」也是用它报"这个目录里读到几个插件"的。两处
      //   各写一遍的话，界面说"读到 3 个"而站点只报 2 个，谁也不知道差在哪。
      //   `skipped` 这里**不用**：坏清单就是发不出来的一份东西，站点不报它
      //   （与守护进程一致）；那是界面上那句"只有 N 个能用"的事。
      const { plugins: found } = pluginFiles.scanPluginCollection(base);
      for (const { dir, manifest: mf } of found) {
        let files;
        try {
          // 只取**普通文件**：符号链接与空目录进不了负载（格式里表达不出来），
          // 而打包器的负载只描述文件。这与守护进程读**包**时同一个口径 ——
          // 那边是 `package_read_file()` 读出来的记录表说了算，链接与目录在
          // 格式里根本表达不出来，不是"被跳过"。
          files = pluginFiles.readPluginFiles(dir)
            .filter((f) => f.kind === 'f')
            .map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
        } catch { continue; }
        const c = (mf.contributes && typeof mf.contributes === 'object') ? mf.contributes : {};
        cache.set(`${mf.id}@${mf.version}`, {
          dir, files, name: mf.name, title: mf.displayName || mf.name,
          // 内部用，**不进 `plugins` 响应**（见下面 case 'plugins' 的逐字段挑）。
          surface: c.surface || null,
          submitPubkey: c.submitPubkey === true,
          login: c.login || null,
        });
      }
    }
    this._indexCache = cache;
    return cache;
  }

  /**
   * 假站点当前报出去的插件清单。
   *
   * ★ 每次现算，不缓存：用户可以在开发者模式里装/卸插件，而站点"看到"的东西
   *   应该跟着变 —— 这正是真实的 `op_plugins` 的行为。
   *
   * ★ 这一段注释**从前挂在 `_siteIndex` 上**（两份 JSDoc 挨在一起，第一份成了
   *   孤儿）。而它说的"不缓存"恰好是 `_siteIndex` 的**反面** —— 那个函数建的
   *   索引就是**建一次不再失效**的。挂错地方等于把两件事都说反了。
   */
  _sitePlugins() {
    // ── 分发源：仓库里的真文件 ──
    const distributed = [...this._siteIndex().entries()].map(([key, v]) => ({
      id: key.slice(0, key.lastIndexOf('@')),
      version: key.slice(key.lastIndexOf('@') + 1),
      name: v.name,
      title: v.title,
      enabled: !this._siteDisabled.has(v.name),
      can_submit: !this._siteDisabled.has(v.name) && !this._siteNoJob.has(v.name),
      surface: v.surface, submitPubkey: v.submitPubkey, login: v.login,
    }));
    // ★ **这里从前还有一段**：把"客户端池里装了什么"当成站点要报的插件补进来
    //   （打包版没有仓库目录时，那是唯一的来源）。它随本机池一起删掉了。
    //
    //   删它的理由不只是"池没了"：那一段让假站点的清单**由客户端自己的池决定**
    //   —— 而"站点有、本机没有"这条最重要的路径正是被它盖住的（站点报的就是本机
    //   有的那些，于是 `missing` 永远是空的）。开发者模式的全部价值是它演的是**同一
    //   件事**，而那一段演的是一件自证成立的事。
    //
    //   代价如实记着：**打包版会一个插件都不报**（仓库目录不在包里）。账本里
    //   有一条。别再往回加兜底 —— 换了名字的兜底还是同一个毛病。
    return [...distributed, ...this._extraSitePlugins];
  }

  /** 见 backend.js 的接口注释：调用方问「有没有连上」，不该去猜后端内部的字段名。 */
  get connected() { return this._connected; }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  async connect(profile) {
    if (!this._server) {
      this._server = createDemoWebService({ password: DEMO_PASSWORD });
      await this._server.listen();
    }
    this._connected = true;
    this._startPushSweep();
    this._emitState(true, '假后端已就绪');
    return {
      ok: true,
      whoami: {
        uid: 1000, gid: 1000,
        user: (profile && profile.user) || this.user,
        home: '/home/demo',
        account: 'myaccount',
        account_error: null,
        allowed_partitions: null,     // null = 不限，与 op_whoami 的语义一致
      },
      // 与真实后端同一个形状：握手要的那个版本号。见 backend.js 的接口注释。
      daemonVersion: this._daemonVersion === null
        ? pluginFiles.hostVersion() : this._daemonVersion,
    };
  }

  async close() {
    this._clearTimers();
    this._stopPushSweep();
    this._connected = false;
    if (this._server) {
      await this._server.close();
      this._server = null;
    }
    this._emitState(false, '已关闭');
  }

  // ── RPC ─────────────────────────────────────────────────────────────────
  async rpc(req) {
    const op = String((req && req.op) || '');
    if (this.rpcLatencyMs > 0) await sleep(this.rpcLatencyMs);

    // 调试：模拟守护进程不可达。**注意这返回的是 ok:false 的 JSON**，
    // 而不是抛异常 —— 真实情况下也是守护进程/CLI 构造出这个 JSON 的
    // （cluster/slurmate:226-232），传输层异常是另一条路径。两条都要能测。
    if (Date.now() < this._daemonDownUntil) {
      return err(5, 'daemon_unreachable',
        '无法连接 Slurmate 守护进程（/run/slurmate-session/ctl.sock）：开发者模式模拟');
    }

    switch (op) {
      // ★ 版本号今天**是被读的**（连接期的那次握手），所以默认报本客户端的版本
      //   —— 开发者模式的默认状态是"版本一致"，而不是"版本不明"。
      //   要造"站点更新"或"跨大版本"就用 `app:debug daemon-version <x.y>`；
      //   要造"对面答的不像我们的守护进程"，就把它设成一个不合 x.y 的值。
      case 'ping':
        return ok({
          pong: true,
          // ★★ 这里是 `pluginFiles.hostVersion()`，**不是裸的 `hostVersion()`**。
          //    裸的那个名字在本文件里根本不存在 —— 于是这一支一被调用就抛
          //    `ReferenceError`。它此前是**睡着的**：生产代码里唯一发 `ping` 的
          //    是 SSH 后端（探针与握手），而假后端没有常驻通道，所以谁都没走到
          //    这一行。v0.8 阶段 4 的用例第一次给它发了 `ping`，当场就炸。
          //    ★ 而这个假后端**全部的价值**就是"它演的是同一件事" ——
          //      一句只在它身上不成立的协议，比没有它更坏。
          //    （同文件 423 行那份一直是对的，两处一对照就知道是笔误。）
          version: this._daemonVersion === null
            ? pluginFiles.hostVersion() : this._daemonVersion,
          time: nowSec(),
        });
      case 'whoami':     return this._whoami();
      case 'partitions': return ok({ partitions: this._partitions() });
      // 默认资源是**按插件**的，所以它跟 `plugins` 走，不再挂在 `partitions` 上
      //（与守护进程逐字一致 —— 那个字段已经删掉了，见 op_partitions）。
      // 默认资源是**站点设定的策略**，客户端不推导 —— 假站点一律报 DEFAULTS，
      // 真实站点报它自己那份（每个插件可以不同，见 slurmate.conf.d/ 里它那一份）。
      //
      // ★ 逐字段挑，不 `...p`：`surface` / `submitPubkey` / `login` 是**客户端从
      //   清单里自己读**的东西，服务端多报一份就是两份真相，而两份迟早会分叉。
      //   （真实守护进程的 op_plugins 也是这么收口的。）
      //
      //   `can_submit` 不违反上面那条：它说的是**站点这一侧**的事实（本站提交得出去
      //   吗），客户端无从推导 —— 见 pluginsView 里那段三态说明。
      //
      // 老守护进程**根本没有这个 op**，客户端拿到的是 unknown_op。这一态必须能造：
      // 那条路上**每一个**字段都是缺的，而"缺"必须与"否"分得开。
      case 'plugins': {
        if (this._noPluginsOp) return err(2, 'unknown_op', op);
        // ── 假站点的**分发能力** ──
        //
        // ★ 与守护进程逐字同一条纪律：`limits` 在 = 这个站点会分发；不在 = 老
        //   守护进程。客户端**只看这个**，不看"这次下没下下来"。
        //   `debugOldDaemon` 走的是上面那条 `unknown_op`，而这一条是更细的一档：
        //   有 `plugins` 却没有 `limits`（v0.5 的守护进程）。
        if (this._noDistribute) {
          // ★ 这一档**连 `problems` 也不发** —— 它是 v0.11 才有的字段，v0.5 的
          //   守护进程报不出来。少发它是这一档的全部意义（"字段缺席"这条路
          //   必须有人走），照发就等于演了一个不存在的版本。
          //
          // ★ `defaults.time` 同理，而且这里**逐字段挑**（不用 `...DEFAULTS`）：
          //   那一格是 v0.11 才加进 `defaults` 的，v0.5 只报 cpus / mem。展开
          //   会把新字段顺手带上，于是"这一格缺席"这条路上一个用例都走不到 ——
          //   而界面恰恰必须能在它缺席时照常画出那句话。
          return ok({
            plugins: this._sitePlugins().map((p) => ({
              id: p.id, name: p.name, version: p.version, title: p.title,
              enabled: p.enabled, can_submit: p.can_submit,
              defaults: { cpus: DEFAULTS.cpus, mem: DEFAULTS.mem },
            })),
            enabled: this._sitePlugins().filter((p) => p.enabled).map((p) => p.name),
          });
        }
        return ok({
          plugins: this._sitePlugins().map((p) => ({
            id: p.id, name: p.name, version: p.version, title: p.title,
            enabled: p.enabled, can_submit: p.can_submit,
            // ★ `gpus` 盖成**这一站当下那一份**（`debugDefaultGpus` 改的就是它）：
            //   直接 `...DEFAULTS` 的话，那个开关改了也传不下去，于是"配了默认卡"
            //   这条路上一个用例都走不到。
            defaults: { ...DEFAULTS, gpus: this._defaultGpus },
            // ★ `noPackage` 的那几条**不带 `package` 这个键**（见 _sitePlugins）。
            //   用 `delete` 之外的办法（展开）是因为这里在造一个**新对象**：
            //   挑字段而不是 `...p` 是有意的，见上面那段"逐字段挑"。
            ...(p.noPackage ? {} : (() => {
              const k = this._pkgOf(`${p.id}@${p.version}`);
              // ★ 包在（打得出来）就是那个自述；打不出来（打包器不在、或包没了）
              //   就是 `null` —— 那是**这一份此刻生产不出来**，不是"本站没这个
              //   能力"。两者必须分得开，见 deliveryOf。
              return { package: k ? k.meta : null };
            })()),
          })),
          enabled: this._sitePlugins().filter((p) => p.enabled).map((p) => p.name),
          // ── ★★ 站点级的插件问题（账本 **F22**）───────────────────────────
          //
          // 那些**没能加载**的站点侧包与原因。真守护进程那边它是
          // `cfg.plugin_problems` 原样倒出来的一组字符串（`scan_plugins` 造），
          // 而它的形状是给**终端**的：多行、带站点上的路径。
          //
          // ★ 假站点默认一个都报不出来 —— 它的分发源是仓库里那两个真插件，
          //   都装得好好的。要演这一格只能由用例**造**（`debugPluginProblems`），
          //   而造出来的字符串必须与真守护进程那几个分支的措辞同形，否则界面
          //   那一格被演的就不是真会发生的样子（〈夹具要比真集群脏〉）。
          problems: [...this._pluginProblems],
          // 假站点自报的那一组。★ 用展开而不是逐字段写：这个对象与 DEMO_SITE_LIMITS
          //   必须是**同一组数**，写两遍就是两个会漂的东西。
          limits: { ...DEMO_SITE_LIMITS },
        });
      }
      /**
       * 整包一次发 —— 与守护进程的 `op_plugin_package` 同一个形状。
       *
       * ★ 站点自述的那三个数（format/bytes/digest）**不是判据**，客户端会自己
       *   数、自己解析、自己重算。"站点自报的摘要与它实际发的字节对不上"那一条
       *   由 `site-plugins.test.mjs` 的假 rpc 覆盖（那里造一个谎报只要一行）。
       */
      case 'plugin_package': {
        if (this._noDistribute || this._noPluginsOp) {
          return err(2, 'unknown_op', op);
        }
        if (this._rateLimitBurst > 0) {
          this._rateLimitBurst -= 1;
          return err(7, 'rate_limited', '开发者模式：故意打满限流桶');
        }
        const pkg = this._pkgOf(`${req.id}@${req.version}`);
        if (!pkg) return err(3, 'plugin_unknown', `${req.id}@${req.version}`);
        return ok({ format: pkg.meta.format, bytes: pkg.meta.bytes, digest: pkg.meta.digest,
                    data: pkg.buf.toString('base64') });
      }
      // ★ 这里从前还有一条 `plugin_file`（一份文件一次 RPC）。**v0.7 删掉了它，
      //   假后端跟着删** —— 一个"只在这个假后端里存在"的 op，比没有更糟：
      //   它会让人以为真站点上还有那条路。
      case 'submit':     return this._submit(req);
      case 'status':     return this._status(req);
      case 'list':       return this._list();
      case 'heartbeat':  return this._heartbeat(req);
      case 'takeover':   return this._takeover(req);
      case 'leave':      return this._leave(req);
      case 'goodbye':    return this._goodbye(req);
      case 'doctor':     return this._doctor();
      case 'cluster':    return this._cluster();
      case 'history':    return this._history();
      default:           return err(2, 'unknown_op', op);
    }
  }

  /** 建立到目标的数据通道。假站点里目标就是本地的那个假 code-server。 */
  dial(host, port) {
    return new Promise((resolve, reject) => {
      if (Date.now() < this._tunnelDownUntil) {
        reject(new Error('开发者模式：隧道被手动断开'));
        return;
      }
      const sock = net.connect(port, host);
      sock.once('connect', () => resolve(sock));
      sock.once('error', reject);
    });
  }

  // ── 调试面板用的控制 ────────────────────────────────────────────────────
  debugDaemonDown(ms = 20000) { this._daemonDownUntil = Date.now() + ms; }

  /**
   * 让集群信息的某一格**取不到**（`kind` 省略 = 全部）。
   *
   * ★ 这一态必须能造出来：真集群上"取不到"要么要等一次故障、要么要把 sinfo
   *   改名，而"把取不到画成没有"正是这一整块最容易犯的错 —— 用户会去查一个
   *   不存在的问题（"为什么这台集群没有分区"）。
   */
  debugClusterMissing(kind) {
    this._clusterMissing = kind ? { [kind]: true } : {
      health: true, version: true, partitions: true, gres: true,
      nodes: true, queue: true, fairshare: true,
    };
    return Object.keys(this._clusterMissing);
  }

  /** 让 `sacct` 取不到。它回的是**错误**，不是空列表 —— 两者不能混。 */
  debugHistoryDown(on = true) { this._historyDown = Boolean(on); }

  debugTunnelDown(ms = 15000) { this._tunnelDownUntil = Date.now() + ms; }
  /** 模拟作业被回收（比如心跳断了 30 分钟后被 scancel）。 */
  debugReap() {
    const live = this._occupying();
    if (!live.length) return false;
    // ★ **全部**收掉（从前只有一个，所以"全部"与"那一个"是同一件事）。用例拿它
    //   制造"上一个会话已经走完了"的现场。
    for (const s of live) {
      this._clearTimers(s);
      s.state = 'released';
      s.tunnel_target = null;
    }
    this._emitState(false, '会话已被回收');
    return true;
  }

  /** 还占着位置的会话（与守护进程的 `OCCUPYING_STATES` 同一个集合）。 */
  _occupying() {
    return this._sessions.filter((s) => !['released', 'rejected', 'expired'].includes(s.state));
  }

  /** 按 session_id 找。找不到返回 null（调用方一律回 `not_found`）。 */
  _find(sid) {
    return this._sessions.find((s) => s.session_id === sid) || null;
  }
  /**
   * 让假站点"开了某个插件但本客户端不认识它"。
   *
   * 这是**必须能演**的一种情况：站点升级了、装了新插件，而用户的客户端还没升级。
   * 没有它，"未知服务"那条路在开发者模式下永远走不到，而那正是最需要用户看懂的一条
   * 提示（他该升级客户端，不是该找管理员）。
   */
  debugAddSitePlugin(name, title = null) {
    if (!this._extraSitePlugins.some((p) => p.name === name)) {
      // ★ `noPackage`：**这个站点不分发它**。三态里那个 `undefined` 与 `null`
      //   （"此刻生产不出来"）是两件事，而这个假插件属于前者 —— 它压根没有包。
      //   两者今天的行为碰巧一样（都跳过），但把它们写成同一个形状，等于让这个
      //   假站点再也造不出那个区别。
      this._extraSitePlugins.push({ id: DEMO_EXTRA_ID, name, version: '1.0.0',
                                    title: title || name, enabled: true,
                                    can_submit: true, noPackage: true });
    }
  }
  /** 让假站点把某个插件**关掉**（站点装了但不允许用）。 */
  debugDisableSitePlugin(name) {
    this._siteDisabled.add(name);
    const e = this._extraSitePlugins.find((x) => x.name === name);
    if (e) { e.enabled = false; e.can_submit = false; }
  }
  /**
   * 让假站点报告「这个插件装了，但没有作业侧实现」。
   *
   * ★ 与 `debugDisableSitePlugin` 是**两件事**，界面上的两句话也不同：那个说
   *   "本站没开放它，去找管理员"；这个说"本站装了它，但它没有作业侧实现"。
   *   合成一个开关的话，第四条分支永远走不到，而那句话是这次新加的。
   */
  debugSitePluginNoJob(name) {
    this._siteNoJob.add(name);
    const e = this._extraSitePlugins.find((x) => x.name === name);
    if (e) e.can_submit = false;
  }
  /** 让假站点装扮成**不认识 `plugins` 这个 op** 的老守护进程。 */
  debugOldDaemon(on = true) { this._noPluginsOp = on; }

  /**
   * 让假站点上每一条会话都显示成**另一台电脑在看**。
   *
   * ★ 真集群上这一幕要两台机器才造得出来（在一台上开着，去另一台上打开），
   *   而「接管」这个按钮的全部意义就是那一刻 —— 它的**判据**（`keeper` 不是本机）
   *   与它成功之后那句「已接管」在开发者模式里必须能先看一遍。
   *
   * ★ 关掉（`false`）时把会话行上那一格**还原成它自己的值**，而不是留一个刚造的
   *   假值 —— 否则"撤销"只是把别人的名字换成另一个别人的名字，而界面上看不出来。
   *
   * ★ 传**空串**造的是第三种现场：**没人在看**（`keeper` 为空）。真集群上那一格
   *   出现在"会话是 CLI 提交的"（提交那条连接没有身份）—— 而它也是界面上
   *   「本机在看 / 另一台电脑在看 / 没人在看」三句话里最后一句的唯一来源。
   *   少了它，那一句在开发者模式里永远看不到（这正是"夹具要比真集群脏"那条）。
   */
  debugForeignKeeper(who) {
    if (who === undefined || who === true) {
      this._foreignKeeper = this._foreignKeeper || 'demo-other-machine-0001';
    } else if (who === false || who === null) {
      this._foreignKeeper = null;
    } else {
      this._foreignKeeper = String(who);          // '' = 没人在看
    }
  }

  /**
   * 让假站点报一个**指定的基座版本**（`ping` 的 `version`）。传 `null` 恢复成
   * "跟着本客户端走"。
   *
   * ★ 版本握手那几态里，有两态**只有这里能造**：
   *   · `client_behind`（站点比客户端新，比如 0.9 对 0.7）—— 它是唯一会拦人的
   *     那一态，而真机上要造它得先让管理员升一次服务端；
   *   · `cross_major`（1.28 对 2.5）—— 用户举的就是这个例子。
   *   值原样透传（包括**不合 x.y 形状**的值）："答话的不像我们的守护进程"
   *   同样是必须能复现的一态。
   */
  debugDaemonVersion(v) {
    this._daemonVersion = (v === null || v === undefined) ? null : String(v);
  }

  /**
   * 让假站点装扮成「有 `plugins`、但没有 `limits`」的那一档 —— 文件分发是
   * v0.6 才有的能力。
   *
   * ★ 与 `debugOldDaemon` 是**两件事**，而客户端对它们的处理**必须一样**
   *   （都走回退），却又是两条不同的代码路径（一个 `unknown_op`，一个字段缺席）。
   *   只造其中一条的话，另一条上的退化没人看得见。
   */
  debugOldDistribute(on = true) { this._noDistribute = on; }

  /**
   * 让假站点报出**站点级的插件问题**（`op_plugins` 顶层的 `problems`，账本 F22）。
   *
   * ★★ **必须传参**，这里没有默认值 —— 与 `debugForeignKeeper` 那种"不传就造一个
   *   演示值"的开关**故意不同**。理由是这一格说的是**站点上的一个事实**
   *   （"本站有个包坏了、坏在哪"），而假站点**没有**这个事实：它的分发源是仓库里
   *   那两个真插件，都装得好好的。给它编一条默认值，就是在界面上说一句关于一个
   *   不存在的站点的假话 —— 而这一格的全部价值恰恰是"让运维看到**真的**诊断"。
   *
   *   要演它，就从 DevTools 里 `window.slurmate.debug('plugin-problems', '…')`，
   *   串照 `cluster/slurmate-sessiond` 的 `scan_plugins()` 那几条分支的措辞写
   *   （多行、带站点上的路径 —— 界面那边是 `white-space: pre-wrap`，原样显示）。
   *
   * ★ 传空数组 = 清掉。
   */
  debugPluginProblems(list) {
    this._pluginProblems = (list || []).map((s) => String(s));
  }

  /**
   * 让假站点报出**这一站的默认 GRES**（`op_plugins` 每项的 `defaults.gpus`）。
   *
   * ★ 与 `debugPluginProblems` 同一条纪律：**必须传参**（`null` / 不传 = 清掉，
   *   也就是"本站没配"）。假站点**没有**"某个插件默认占几张卡"这个事实 ——
   *   真站点上它是**每个插件一份**的管理员声明，而这里只有一份全局的（见 DEFAULTS）。
   *   编一个默认值就等于演一个不存在的站点，而这一格的价值恰恰是让界面那句
   *   "默认 … / gpu:a6000 × 1"真的被画出来一次。
   *
   * ★ 传进来的形状与协议一致：`{name, type, count}` 或 `null`。
   *   从 DevTools 里 `window.slurmate.debug('default-gpus', {name:'gpu', type:'a6000', count:1})`。
   */
  debugDefaultGpus(g) {
    this._defaultGpus = g && typeof g === 'object' ? { ...g } : null;
  }

  /**
   * 让某一份的**包里**多一个**超过单文件上限**的文件（造"这一份装不上"）。
   *
   * ★ v0.6 时它是往 `files` 那份清单里加一条假的（清单里报一个装不下的文件）；
   *   清单删掉之后它改成加进**包**里 —— 而这一改让它在语义上更准：客户端今天
   *   只在**读包**的时候执行那几条负载上限（`checkDeclared`），所以"站点报了一个
   *   装不下的东西"这件事本来就该发生在包里。清单里报一个、包里没有，今天根本
   *   表达不出来。
   */
  debugBloatPlugin(key = null) {
    this._bloatPlugin = key || [...this._siteIndex().keys()][0] || null;
    this._pkgCache.clear();          // 包是缓存出来的，改了负载就得重打
    return this._bloatPlugin;
  }

  /** 让接下来的 N 次 `plugin_package` 回 `rate_limited` —— 造限流。 */
  debugRateLimit(n = 3) { this._rateLimitBurst = n; }

  // ★ 这里**没有**"就地换掉站点那个文件"的调试动作，虽然那是最想演的一条。
  //   原因很具体：假站点的分发源是**仓库里的 `plugins/`** —— 真文件。往那里
  //   写一个字节等于改用户的仓库，而那是一个调试开关绝不该有的副作用。
  //   那条路径（`9 plugin_file_changed`）由集群侧自己的用例覆盖，见
  //   `cluster/test-sessiond-logic.py` 的 19.11。

  debugReset() {
    this._daemonDownUntil = 0;
    this._tunnelDownUntil = 0;
    this._clusterMissing = {};
    this._historyDown = false;
    this._extraSitePlugins.length = 0;
    this._siteDisabled.clear();
    this._siteNoJob.clear();
    this._noPluginsOp = false;
    this._noDistribute = false;
    this._pluginProblems.length = 0;
    this._defaultGpus = null;
    this._bloatPlugin = null;
    this._pkgCache.clear();
    this._rateLimitBurst = 0;
    // ★ 「另一台电脑在看」那几个单向开关里唯一需要显式撤掉的一个：
    //   它改的是**已有会话行**上那一格（不是"以后新建的"），所以不撤掉的话
    //   下一条用例会看见上一个用例留下的"别人"。
    this._foreignKeeper = null;
    this.cancelFails = false;
  }

  // ── op 实现 ─────────────────────────────────────────────────────────────
  _whoami() {
    return ok({
      uid: 1000, gid: 1000, user: this.user,
      home: '/home/demo',
      account: 'myaccount', account_error: null,
      allowed_partitions: null,
    });
  }

  /**
   * 假站点的集群现状（`op_cluster`）。
   *
   * ★★ **形状与守护进程逐字一致，包括"哪一格缺席"。** 这个假后端全部的价值就是
   *   它演的是同一件事 —— 一份只在它身上成立的协议比没有它更坏。
   *
   * ★★ 这里**故意比真集群脏**（同 GRES 那条注释的道理）：
   *   · 真集群上四个节点全是 `idle`/`mix`，**没有一个带后缀** —— 于是
   *     "剥后缀、只按 base state 计数"这条路径在真机上根本走不到。
   *     这里给一个 `drain*`（不响应）、一个 `down~`（已关电）。
   *   · 队列里既有排队也有在跑，还有一个**不是这两个**的（`CG` 收尾中）——
   *     真集群上此刻全是 `PD`，那一支也走不到。
   *   · `me` 里有排队作业，于是"我排第几"算得出来。
   *
   * ★ `debugClusterMissing` 能让**任意一格缺席**，因为"取不到"与"确实没有"
   *   必须分得开，而这两种状态在界面上是两句不同的话。
   */
  _cluster() {
    const miss = this._clusterMissing || {};
    const data = { at: nowSec(), taken: {} };
    if (!miss.health) {
      data.health = { up: true, at: nowSec() };
      data.taken.health = nowSec();
    }
    if (!miss.version) {
      data.version = 'slurm-wlm 23.11.4（假站点）';
      data.taken.version = nowSec() - 42;
    }
    if (!miss.partitions) {
      data.partitions = {};
      for (const p of PARTITIONS) {
        data.partitions[p.name] = {
          max_time: p.max_time, is_default: Boolean(p.is_default),
          state: 'UP', nodes: NODES[p.name].counts ? sumCounts(NODES[p.name].counts) : 1,
          cpus: 40,
        };
      }
      data.taken.partitions = nowSec() - 42;
    }
    if (!miss.gres) {
      data.gres = JSON.parse(JSON.stringify(GRES));
      data.taken.gres = nowSec() - 42;
    }
    if (!miss.nodes) {
      data.nodes = JSON.parse(JSON.stringify(NODES));
      data.taken.nodes = nowSec() - 12;
    }
    if (!miss.queue) {
      data.queue = { depth: {}, pending: {}, by_user: {}, at: nowSec() };
      for (const p of PARTITIONS) {
        const d = QUEUE[p.name] || { pending: 0, running: 0, other: 0 };
        data.queue.depth[p.name] = { pending: d.pending, running: d.running, other: d.other };
        if (d.pending) {
          data.queue.pending[p.name] = Array.from(
            { length: d.pending },
            (_, i) => `${900000 + i}-${p.name}`,
          );
        }
      }
      // 我自己：排在最前面那个分区里的第 3 位，另有一个在跑。
      data.queue.by_user[this.user] = [
        data.queue.pending.A6000 ? data.queue.pending.A6000[2] : null,
        '900999',
      ].filter(Boolean);
      data.taken.queue = nowSec() - 12;
    }
    data.me = {
      account: 'myaccount', account_error: null, allowed_partitions: null,
      fairshare: miss.fairshare ? null : {
        account: 'myaccount', fair_share: '0.125000',
        raw_usage: '3072302', effectv_usage: '0.108641',
      },
    };
    if (!miss.queue) {
      const first = {};
      const q = QUEUE.A6000;
      if (q && q.pending >= 3) first.A6000 = 3;
      data.me.pending_count = q ? q.pending : 0;
      data.me.first_in = first;
    }
    return ok(data);
  }

  /** 最近几天的作业（`sacct`）。★ 按需拉，不进任何缓存。 */
  _history() {
    if (this._historyDown) return err(6, 'history_unknown', '开发者模式：模拟取不到历史');
    return ok({ history: HISTORY.map((h) => ({ ...h })), days: 7, limit: 30 });
  }

  _partitions() {
    // 每一项都**真的拷一份**（含 GRES 那一格）：真实后端回的是刚解析出来的 JSON，
    // 谁都不与别人共享一个对象。这里共享的话，界面上一处手误的原地修改会**同时
    // 改掉所有会话看到的那一份** —— 而那种 bug 在真集群上不会出现。
    return PARTITIONS.map((p) => ({ ...p, gres: p.gres.map((e) => ({ ...e })) }));
  }

  /**
   * 缺省分区：**从该用户有权限的分区里随机挑一个**。
   *
   * 为什么不是「不带 -p 交给 Slurm」：那样所有默认会话都会落在同一个默认分区，
   * 而用户明确要的是分散。随机挑的代价是用户事先不知道会落到哪种卡上 ——
   * 所以 `session_view` 里必须把**实际落到的分区**返回给界面显示出来。
   */
  _randPickPartition() {
    if (this._pickPartition) return this._pickPartition(PARTITIONS);
    const usable = PARTITIONS.filter((p) => p.allowed);
    if (usable.length === 0) return null;
    return usable[Math.floor(Math.random() * usable.length)];
  }

  _submit(req) {
    // 服务种类。照抄守护进程的判据：认不出的一律拒绝，绝不悄悄退回某一个插件 ——
    // 那会让「我要的是中转站，得到的是一个网页 IDE」变成一个不报错的错误。
    //
    // ★ **不写死缺省值**。真实守护进程的缺省来自站点配置（`default_plugin`），
    //   没配就要求显式给；假后端没有配置可读，所以它照做同一件事：要求显式给。
    //   客户端在能解析出缺省插件时本来就会把它显式传上来。
    const kind = req && req.service_kind;
    if (!kind) {
      return err(2, 'bad_service_kind',
        '这个站点没有设缺省插件，提交时必须显式指定 service_kind');
    }
    // ★ 按**短名**在假站点自己的清单里查 —— 假后端扮演的正是"一个站点"，而
    //   它演的那些插件都是它自己装的，短名不会撞（真站点**允许**撞，短名不再
    //   唯一了；见 `docs/PLUGIN-SPEC.md` §2.2）。查不到就拒绝。
    //   ★ 这里刻意**不**实现真站点那套歧义规则：假后端的目的不是把站点的每一条
    //     纪律演一遍，而是让"没有集群时界面还能走通"。哪天它要演两个同名插件，
    //     那就在这里照 `resolve_plugin()` 补一次 —— 而不是现在给一个用不上的分支。
    const sitePlugin = this._sitePlugins().find((p) => p.name === kind);
    if (!sitePlugin) {
      return err(2, 'bad_service_kind', `未知的服务类型：${kind}`);
    }
    if (!sitePlugin.enabled) {
      return err(4, 'service_kind_disabled', `本站没有开放「${sitePlugin.title}」`);
    }
    // 中转站必须带公钥，且形状要对 —— 规则与守护进程的 parse_ssh_pubkey **逐字一致**。
    //
    // ★ 注释要允许并**丢掉**。客户端发上来的就是 OpenSSH 的一整行，而它天然带注释
    //   （`ssh-ed25519 AAAA… slurmate-20260915-1030`）。照着「68 个字符后必须结束」
    //   去写，会把客户端的公钥**全部**拒掉；而如果反过来原样收下，那个注释里的
    //   逗号会把 `--export=ALL,k=v,…` 劈成两个变量（守护进程那边这一步是真的，
    //   不是理论问题 —— 见 test-sessiond-logic.py 19.9）。
    // 假服务现在扮演**这个**插件：界面路径与登录契约都来自它的清单。
    // （服务是在 connect() 里起的，那时还不知道会有哪个会话。）
    if (this._server) {
      this._server.setContract({ surface: sitePlugin.surface, login: sitePlugin.login });
    }
    // ★ 判据是插件**声明了什么**，不是它叫什么名字 —— 与客户端框架同一条规矩。
    //   `submitPubkey` 是"提交时要带公钥"，`surface` 是"有一个网页界面"。
    if (sitePlugin.submitPubkey) {
      const pk = req && req.ssh_pubkey;
      const m = typeof pk === 'string'
        ? /^ssh-ed25519 ([A-Za-z0-9+/]{68})(?:[ \t]+[^\r\n]*)?$/.exec(pk) : null;
      if (!m) {
        return err(2, 'bad_ssh_pubkey', `「${sitePlugin.title}」的会话必须带上一把合法的 ssh-ed25519 公钥`);
      }
      this._relayPubkey = 'ssh-ed25519 ' + m[1];      // 规范化：注释在这里被丢掉
    }
    // 有界面的插件要在本地有个 HTTP 服务给它。那个服务是在 connect() 里起的，
    // 没起就说明调用方漏了 connect —— 那样会产出一个 service_port=0 的会话，
    // 隧道目标变成 "127.0.0.1:0"，会话在「已登记」之后才炸。宁可在这里响亮地失败。
    // （没有界面的插件不需要它：那个端口后面不是 HTTP。）
    if (!this._server && sitePlugin.surface) {
      return err(9, 'internal', '假后端尚未 connect()，本地服务未启动');
    }
    // 与真实守护进程一致：**占着位置的**（含排队中的）都算一个名额，
    // 上限来自配置键 `max_sessions_per_user`（`this.maxActive`）。
    const occ = this._occupying();
    if (occ.length >= this.maxActive) {
      return err(4, 'quota_active',
        `已经有 ${occ.length} 个会话占着位置（本站上限 ${this.maxActive}）—— `
        + '排队中的也算。结束一个再开下一个。');
    }

    // 显式指定了分区 → 必须校验权限（fail-closed）；
    // 没指定 → 随机挑一个。这与守护进程侧的规则一致。
    let part;
    if (req && req.partition) {
      part = PARTITIONS.find((p) => p.name === String(req.partition));
      if (!part) return err(2, 'bad_partition', `未知分区：${req.partition}`);
      if (!part.allowed) return err(4, 'no_partition', part.reason || '没有该分区的权限');
    } else {
      part = this._randPickPartition();
      if (!part) return err(6, 'partitions_unknown', '查不到可用的分区');
    }

    // 服务端填默认值并做上限钳制 —— 不信客户端送来的东西。
    const cpus = clampInt(req && req.cpus, DEFAULTS.cpus, 1, 64);
    const mem = typeof (req && req.mem) === 'string' && req.mem ? req.mem : DEFAULTS.mem;
    // GRES：与守护进程同一条规矩 —— **分区定下来之后**再对账，因为上限是分区
    // 自己的（同一个集群上 2080TI 每节点 8 张、A6000 每节点 4 张）。
    const gresp = gresFor(req && req.gres, part);
    if (gresp.err) return err(2, 'bad_gres', gresp.err);
    const gres = gresp.gres;

    const sid = 'demo-' + String(++this._seq).padStart(4, '0')
              + Math.random().toString(16).slice(2, 10);
    const now = nowSec();

    const sess = {
      session_id: sid,
      job_id: 5700 + this._seq,
      state: 'submitted',
      partition: part.name,
      account: 'myaccount',
      resources: { cpus, mem, gres },
      node: null,
      node_ip: null,
      service_port: 0,
      tunnel_target: null,
      created_at: now,
      enrolled_at: null,
      last_hb_at: now,
      renew_count: 0,
      requested_time: '12:00:00',
      note: null,
      // ★★ v0.9：**谁在看这条会话** —— 与真守护进程的 `op_submit(client_id)`
      //   同一个位置、同一个含义。提交这条连接的客户端就是它的第一个看护者；
      //   没有身份（CLI、老客户端）⇒ `null`，而 `null` 是**合法状态**：
      //   指的是"确实没人在看"，不是"不知道"。
      keeper: this._client ? this._client.id : null,
      service_kind: kind,
      // ★ 会话的**解析键**：`<id>@<版本>`。守护进程在提交时从它自己那份插件
      //   清单里抄下来 —— 而"抄下来"是关键：站点之后升级了插件，这个字段
      //   仍然是**提交那一刻**那一版。作业侧跑的是那一版的代码，客户端这一半
      //   必须配同一版。
      service_plugin: `${sitePlugin.id}@${sitePlugin.version}`,
      // 与守护进程一致：要公钥的插件走公钥，永远没有口令（有口令才是错的 ——
      // 那会让界面以为可以拿它去 POST 登录）。
      auth_mode: sitePlugin.submitPubkey ? 'publickey' : 'password',
      // 内部记账：登记时决定端口与主机公钥要用。不进会话视图（_view 逐字段挑）。
      site_surface: Boolean(sitePlugin.surface),
      site_pubkey: Boolean(sitePlugin.submitPubkey),
      auth_password: null,
      ssh_host_key: null,
      job_state: 'PENDING',
      // 判定随状态一起来（守护进程那边是 `job_is_terminal()`）。
      // ★ 假站点**必须**有这个字段：没有的话客户端会走"老守护进程"那条退路，
      //   于是开发模式里看到的是状态原文，而真集群上看到的是译文 ——
      //   "开发模式验不了的那条路"正是这一版反复在清的东西。
      job_terminal: false,
      // 排队原因也带一个 —— 那是这一版新加的那句话（「在等空闲资源」），
      // 不带的话开发模式里永远看不到它。
      job_reason: 'Resources',
      job_exit_code: null,
      job_restarts: null,
      time_limit: '12:00:00',
      expires_at: now + DEFAULT_TIME_SECONDS,
    };

    this._sessions.push(sess);
    sess._enrollTimer = setTimeout(() => {
      if (!this._find(sid)) return;
      sess.state = 'enrolled';
      sess.enrolled_at = nowSec();
      sess.node = part.name === '2080TI' ? 'node04' : 'node01';
      // 假站点里 tunnel_target 指向本地的假 code-server（中转站则指向一个**没有
      // 东西在监听**的端口 —— 那边真正的 sshd 假不出来，见 DEMO_HOST_KEY）。
      // 用字面 IPv4 —— tunnel.js 会用 net.isIPv4() 校验，这一步是真跑的。
      sess.node_ip = '127.0.0.1';
      const relay = sess.site_pubkey;
      sess.service_port = relay
        ? DEMO_SSHD_PORT : (this._server ? this._server.port : 0);
      sess.tunnel_target = `127.0.0.1:${sess.service_port}`;
      if (relay) {
        sess.ssh_host_key = DEMO_HOST_KEY;
      } else {
        sess.auth_password = DEMO_PASSWORD;
      }
      sess.job_state = 'RUNNING';
      // ★ 排队原因**必须跟着清掉**。真集群上跑起来的作业报的是 `Reason=None`
      //   （守护进程把它滤掉），不清的话开发模式里会显示
      //   「运行中 · 在等空闲资源」—— 一句自相矛盾的话，而它在真集群上不出现。
      sess.job_reason = null;
      this._emitState(true, '会话已登记');
    }, this.enrollDelayMs).unref?.();

    return ok({
      session_id: sid, job_id: sess.job_id, state: 'submitted',
      partition: part.name,
      resources: { cpus, mem, gres },
      candidates: [55101, 55102, 55103, 55104, 55105, 55106],
      requested_time: '12:00:00',
    });
  }

  _status(req) {
    const sid = req && req.session_id;
    // ★ 不带 session_id 时回**最新**那条占着位置的 —— 与守护进程逐字一致。
    //   客户端要多会话走 `_list`（`tryReattach` 就是那样接回全部会话的）。
    const s = sid ? this._find(sid) : (this._occupying().slice(-1)[0] || null);
    if (sid && !s) return err(3, 'not_found');
    return ok({ session: s ? this._view(s) : null });
  }

  _list() {
    return ok({ sessions: this._sessions.map((s) => this._view(s)) });
  }

  /**
   * 心跳。**判据与真守护进程的 `op_heartbeat` 逐档同构**（见那一段的四档表）：
   *
   *   | 发心跳的连接 | keeper | 结果 |
   *   | 报了身份 | 空 | 接受，**并认领** |
   *   | 报了身份 | 是我 | 接受 |
   *   | 报了身份 | 是别人 | 回 `ok` + `ignored`，**什么都不动** |
   *   | **没报身份** | 任意 | 一律接受，keeper 不动 |
   *
   * ★★ 最后一行是承重的，别"收严"：没报身份的是 CLI 与更老的客户端，以及
   *   **我们自己在常驻通道断掉之后的 exec 退路**。假站点要是把它也挡掉，
   *   开发者模式里就会演出一件真集群上不会发生的事 —— 而假站点全部的价值
   *   就是它演的是同一件事。
   *
   * ★ 也**不认领**没报身份的连接：`keeper` 写谁？没有名字就没人可写。
   */
  _heartbeat(req) {
    const sid = req && req.session_id;
    const s = this._find(sid);
    if (!s) return err(3, 'not_found');
    const me = this._client && this._client.id;
    const keeper = this._effKeeper(s);
    if (me && keeper !== null && keeper !== me) {
      // `state` 原样返回、一个字段都不动 —— 别人的心跳既不能续命，也不能把
      // 一条 `suspect` 的会话"救"回来（那台电脑并没有在看它）。
      return ok({ state: s.state, at: nowSec(), ignored: 'not_keeper' });
    }
    s.last_hb_at = nowSec();
    if (me && keeper === null) s.keeper = me;
    if (s.state === 'suspect') s.state = 'enrolled';
    return ok({ state: s.state, at: nowSec() });
  }

  /**
   * 【接管】：把这条会话的看护者换成我。★★ **一个字都不动会话。**
   *
   * 与真守护进程的 `op_takeover` 同一条纪律（见那一段 docstring）：作业、ACL、
   * 端口、`last_hb_at`、`state` 一个都不动 —— 用户只是**换了一台电脑看同一个
   * 作业**。动了别的任何一个字，接管的语义就变成"结束并重开"。
   *
   * ★ 没有身份**不能**接管（要把看护者写成谁？）—— 与心跳那条**正好相反**，
   *   而且不是矛盾：心跳是"我在续命"（缺身份时宽进，排除错了会杀作业），
   * 接管是"我来当家"（缺身份时严出，它要往那一格里写一个名字）。
   */
  _takeover(req) {
    const me = this._client && this._client.id;
    if (!me) {
      return err(2, 'no_client_id',
        '这条连接没有自报身份（`client`），而「接管」必须知道看护者该写成谁。');
    }
    const s = this._find(req && req.session_id);
    if (!s) return err(3, 'not_found');
    if (['released', 'rejected', 'expired'].includes(s.state)) {
      return err(4, 'session_gone', `这条会话已经结束（${s.state}）。`);
    }
    const was = this._effKeeper(s);
    // 别人那个"在看"要**真的撤掉**，否则下一次心跳还会被回 `ignored`。
    this._foreignKeeper = null;
    s.keeper = me;
    return ok({ session_id: s.session_id, keeper: me, was });
  }

  /**
   * 【临时离开】：把这几条会话的看护者置空。**倒计时从这一刻起算。**
   *
   * 与真守护进程的 `op_leave` 同一条纪律（见那一段 docstring）：
   *
   *   · **不校验身份** —— 它是一次放手，不是一次取得。要防的是"谁的作业被别人的
   *     心跳续了命"（那由 `_heartbeat` 管），而"我以为我不看了"这句话没有假冒的
   *     价值：它只能让作业**更早**被回收，且随时可以被下一个开始看它的客户端
   *     认领回去（认领那一支在 `_heartbeat` 里）。
   *   · **看护者本来就是空的，安静跳过** —— 那会被记成一次"放手"，而实际上
   *     什么都没发生。
   *   · **不加第二个超时窗口**：这里只是置空，之后仍然走 suspect → orphaned →
   *     scancel 那一条（假站点里由 `debugReap` 演）。
   *
   * ★ 覆盖层（`debugForeignKeeper`）**跟着一起撤掉**：它模拟的就是"服务端此刻
   *   认为谁在看"这一格，而这一格刚刚被清空了。不清的话，界面上会停在
   *   「另一台电脑在看」，而那条会话已经没人在看了 —— 假的比真的还假。
   */
  _leave(req) {
    const got = req && req.session_ids;
    if (!Array.isArray(got) || !got.length) {
      return err(2, 'bad_request', 'leave 要带一张非空的 session_ids 清单。');
    }
    const cleared = [];
    for (const raw of got) {
      const s = this._find(String(raw || ''));
      if (!s) continue;
      if (this._effKeeper(s) === null) continue;
      this._foreignKeeper = null;
      s.keeper = null;
      cleared.push(s.session_id);
    }
    return ok({ cleared });
  }

  /**
   * 这条会话**现在**的看护者：那一层覆盖（如果开着）优先，其次才是它自己那一格。
   *
   * ★ 判空用的是 `!== null` 而不是真值 —— 覆盖值**可以是空串**，而那是一个
   *   有意义的取值（"没人在看"），不是"没有覆盖"。
   */
  _effKeeper(s) {
    if (this._foreignKeeper !== null) return this._foreignKeeper || null;
    return s.keeper === undefined ? null : s.keeper;
  }

  _goodbye(req) {
    const sid = req && req.session_id;
    const s = this._find(sid);
    if (!s) return err(3, 'not_found');
    if (['released', 'rejected', 'expired'].includes(s.state)) {
      return ok({ state: s.state });
    }
    // ★ 只清**这一条**的定时器。清全部的话，另一条会话的登记定时器被清掉，
    //   它就永远停在 submitted —— 而界面上一切正常。
    this._clearTimers(s);
    s.state = 'releasing';
    s.note = 'goodbye';
    // 真实守护进程会回 releasing，然后下一个 tick（最多 2 秒）才置 released。
    // 假后端照做 —— 界面必须把「正在释放」和「已结束」当成两个状态。
    s._releaseTimer = setTimeout(() => {
      s.state = 'released';
      s.tunnel_target = null;
      this._emitState(false, '会话已释放');
    }, 1600).unref?.();
    if (this.cancelFails) {
      // ★ 真守护进程在这里说两件事，而且**故意不说**"作业还在跑"（它没有核对过
      //   那一点：作业可能刚刚正常结束，scancel 报的只是"没有这个作业"）。
      //   它说的是"这一次没成功 + 我接下来会怎么做"。假后端照这个形状演。
      return ok({ state: 'releasing',
                  warning: 'scancel 这一次没有成功（模拟）。会话已经进入释放流程，'
                         + '守护进程会继续重试；在作业被确认消失之前，'
                         + '它不会被标成已释放。' });
    }
    return ok({ state: 'releasing' });
  }

  _doctor() {
    // ★ `active_sessions` 只数 `enrolled`（有 nft 规则的那些）—— 与守护进程一致，
    //   排队中的**不算**，否则体检会报"规则数与会话数不一致"。
    const enrolled = this._sessions.filter((s) => s.state === 'enrolled').length;
    return ok({
      socket: true, table: true, rules_readable: true,
      rules_count: enrolled,
      active_sessions: enrolled,
      consistent: true,
      port_range: [55001, 55999],
      existing: { codeserver_table: true, portdaemon_table: true },
    });
  }

  // ── 内部 ────────────────────────────────────────────────────────────────
  /**
   * 构造客户端可见的会话视图。
   * **逐字段对齐守护进程的 session_view**，包括「expires_at / job_state / time_limit
   * 只在 show_job 成功时才存在」这条 —— 所以界面必须能处理它们缺失，
   * 假站点里也照样可能缺。
   */
  _view(s) {
    const d = {
      session_id: s.session_id, job_id: s.job_id, state: s.state,
      partition: s.partition, resources: s.resources, node: s.node,
      node_ip: s.node_ip, service_port: s.service_port,
      created_at: s.created_at, enrolled_at: s.enrolled_at,
      last_hb_at: s.last_hb_at, renew_count: s.renew_count,
      requested_time: s.requested_time, note: s.note,
      auth_mode: s.auth_mode, account: s.account,
      // ★ v0.9：**谁在看** —— 一个 client_id，或者 null。取值只有这两种
      // （不是空串、不是 "unknown"），与守护进程那一格逐字同形。
      // ★ 它是「接管」这个按钮的**唯一判据**，也是界面上「本机在看 / 另一台电脑
      //   在看 / 没人在看」那三句话的来源。
      keeper: this._effKeeper(s),
      tunnel_target: s.tunnel_target,
      // 与守护进程逐字一致：这个字段**总是**存在（可能是 null）。
      // null 的含义是「服务端也不知道」，客户端据此**拒绝猜测**该走哪条路 ——
      // 而"字段不存在"（更旧的守护进程）在客户端那边落到同一个答案：也不猜。
      service_kind: s.service_kind === undefined ? null : s.service_kind,
      // 与守护进程一致：也是**总是存在**（可能是 null）。null = 服务端不知道
      // 这个会话是哪一版的插件，客户端据此拒绝猜测（只解释、不动作）。
      service_plugin: s.service_plugin === undefined ? null : s.service_plugin,
    };
    // 主机公钥只在有值时才出现 —— 与守护进程一致（空值不放进响应里，
    // 否则客户端会把它读成"公钥是空的"，那是个没法处理的输入）。
    if (typeof s.ssh_host_key === 'string' && s.ssh_host_key) {
      d.ssh_host_key = s.ssh_host_key;
    }
    if (s.job_state) {
      d.job_state = s.job_state;
      d.time_limit = s.time_limit;
      d.expires_at = s.expires_at;
      // 与守护进程一致：**判定**与状态一起来，客户端不做判定（见 jobstate.js）。
      d.job_terminal = Boolean(s.job_terminal);
      // `Reason=None` 在守护进程那边被过滤掉；这里同样只在有值时出现。
      if (s.job_reason) d.job_reason = s.job_reason;
      if (s.job_exit_code) d.job_exit_code = s.job_exit_code;
      if (s.job_restarts) d.job_restarts = s.job_restarts;
    }
    // 口令只在 ACL_STATES 才返回（真实行为）—— 假站点也照做，
    // 这样界面不会养成「任何时候都能读到口令」的错误假设。
    if (['enrolled', 'suspect', 'orphaned', 'releasing'].includes(s.state) && s.auth_password) {
      d.auth_password = s.auth_password;
    }
    return d;
  }

  // ── 推送（常驻通道的服务端那一半）─────────────────────────────────────────
  /**
   * 推送那份视图：**逐字等于 `_list` 给出的那一种**。
   *
   * ★ 守护进程的 `snapshot_for` 用的是 `session_view(s, with_secret=False)`，
   *   与 `op_list` 同构 —— 所以这里就是"先按 list 渲染，再把秘密摘掉"，
   *   而不是另写一份。另写一份的那天，推送的字段集与 list 的字段集就会分家，
   *   而症状是**界面上某一格在有推送时是空的、没有推送时是满的**。
   */
  _pushView(s) {
    const d = this._view(s);
    delete d.auth_password;
    delete d.ssh_host_key;
    return d;
  }

  _startPushSweep() {
    if (this._pushTimer) return;
    this._pushTimer = setInterval(() => this._sweepPush(), PUSH_SWEEP_MS);
    this._pushTimer.unref?.();
  }

  _stopPushSweep() {
    if (this._pushTimer) { clearInterval(this._pushTimer); this._pushTimer = null; }
  }

  /**
   * 扫一遍：变了就推，没变也每 `PUSH_INTERVAL_MS` 推一条。
   *
   * ★ 调试开关"守护进程不可达"期间**一条都不推** —— 否则那个开关只挡得住
   *   一问一答，挡不住推送，而开发者模式里就会出现"守护进程挂了、界面却还在
   *   自己更新"这种真集群上不存在的景象。
   */
  _sweepPush() {
    if (!this._connected) return;
    if (Date.now() < this._daemonDownUntil) return;
    const sessions = this._sessions.map((s) => this._pushView(s));
    const digest = crypto.createHash('sha256')
      .update(JSON.stringify(sessions)).digest('hex');
    const now = Date.now();
    const due = (now - this._pushAt) >= PUSH_INTERVAL_MS;
    if (digest === this._pushDigest && !due) return;
    this._pushDigest = digest;
    this._pushAt = now;
    this._pushSeq += 1;
    // 形状逐字照守护进程的 enqueue_push。`stale` 在这里永远不会出现：
    // 假站点没有出站队列，也就没有"水位太高丢了一条"这回事。
    this.emit('notify', {
      push: 'sessions', seq: this._pushSeq, at: nowSec(), sessions,
    });
  }

  /** 清定时器。给 `s` = 只清那一条；省略 = 全部（关后端时用）。 */
  _clearTimers(s) {
    for (const one of (s ? [s] : this._sessions)) {
      if (one._enrollTimer) { clearTimeout(one._enrollTimer); one._enrollTimer = null; }
      if (one._releaseTimer) { clearTimeout(one._releaseTimer); one._releaseTimer = null; }
    }
  }
}

/** 与守护进程的 _ok / _err 同构 */
function ok(data) { return { ok: true, code: 0, data, error: null }; }
function err(code, kind, detail) {
  return { ok: false, code, data: null, error: { kind, detail: detail ?? null } };
}
function nowSec() { return Math.floor(Date.now() / 1000); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 服务端侧的钳制：不信客户端送来的数值。 */
function clampInt(v, fallback, lo, hi) {
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
  if (!Number.isInteger(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 框架对 GRES 数量的量级护栏。★ **必须与守护进程的 `MAX_GRES_COUNT` 相等**
 * （用例 `client/test/limits.test.mjs` 逐字比对两个文件里的这个数）——
 * 它**不是**站点策略：真实上限来自集群自己配了几个，由分区的 `per_node_max`
 * 给出。这一条只挡"一个天文数字"。
 */
const MAX_GRES_COUNT = 4096;

/**
 * `--gres` 的名字里允许出现的字符。与守护进程的 `GRES_FIELD_RE` 同一条规矩
 * （`:` 与 `,` 是 Slurm 自己的分隔符，不能出现在名字里）。
 */
const GRES_FIELD_RE = /^[A-Za-z0-9_]{1,32}$/;

/**
 * 把请求里的 GRES 与**这个分区实际有的**对一对。返回 `{gres}` 或 `{err}`。
 *
 * ★ 逐条照着守护进程的 `clean_gres()` + `fit_gres()` 来。这个假后端的全部价值
 *   就是**它演的是生产那条路**：两处规则漂开的话，开发者模式里说得通的事在真机上
 *   会被拒（或反过来），而 `backend-fake.test.mjs` 只守得住字段名，守不住规则。
 * ★ 上限**从分区的清单来**（`per_node_max`），不是写死一个 8 —— 与守护进程一样。
 */
function gresFor(raw, part) {
  if (raw === undefined || raw === null || raw === '') return { gres: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { err: 'gres 必须是一个对象：{"name": …, "type": …, "count": …}' };
  }
  const name = raw.name;
  if (typeof name !== 'string' || !GRES_FIELD_RE.test(name)) {
    return { err: `gres 的 name 不合法：${JSON.stringify(name)}` };
  }
  let type = raw.type;
  if (type === '' || type === undefined) type = null;
  if (type !== null && (typeof type !== 'string' || !GRES_FIELD_RE.test(type))) {
    return { err: `gres 的 type 不合法：${JSON.stringify(type)}` };
  }
  const count = raw.count;
  if (!Number.isInteger(count) || count < 1) {
    return { err: `gres 的 count 必须是 >= 1 的整数，得到 ${JSON.stringify(count)}` };
  }
  if (count > MAX_GRES_COUNT) {
    return { err: `gres 的 count 上限是 ${MAX_GRES_COUNT}，得到 ${count}` };
  }
  const list = Array.isArray(part.gres) ? part.gres : [];
  const match = list.filter((e) => e.name === name && (!type || e.type === type));
  if (match.length === 0) {
    const have = list.map((e) => (e.type ? `${e.name}:${e.type}` : e.name));
    return { err: `分区 ${part.name} 上没有 ${type ? `${name}:${type}` : name}`
      + `（它有：${have.join('、') || '什么 GRES 都没配'}）` };
  }
  const label = type ? `${name}:${type}` : name;
  const cap = Math.max(...match.map((e) => e.per_node_max));
  if (count > cap) {
    return { err: `分区 ${part.name} 上 ${label} 每个节点最多 ${cap} 个，`
      + `你要了 ${count} 个` };
  }
  return { gres: { name, type, count } };
}

// ★ 只导出真有人读的：`PARTITIONS` 从前也在这里，而它只在**本文件内**被用
//   （测试要看分区表时走的是 `app:partitions` 那条真路，不是这个常量）。
module.exports = { FakeBackend, DEFAULTS, DEMO_PASSWORD,
  PUSH_INTERVAL_MS, PUSH_SWEEP_MS, DEMO_SITE_LIMITS };
