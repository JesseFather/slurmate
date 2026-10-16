// Copyright 2026 JesseFather
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';
/**
 * backend-fake.js —— 假后端。
 *
 * ── 它不是什么 ─────────────────────────────────────────────────────────────
 * 它不是「随便返回点数据让界面能画出来」的空壳。它的 RPC 响应逐字段照着
 * `cluster/slurmate-sessiond` 的 `session_view` 和 `op_*` 构造，
 * 状态迁移照着真的状态机，并且真的起一个 HTTP 服务复刻 code-server
 * 的登录契约、真的走一遍 tunnel.js。
 *
 * 唯一被假掉的是 SSH 那一跳。
 *
 * ── 为什么值得这么做 ───────────────────────────────────────────────────────
 * 接真集群时，「会话登记超时」「守护进程挂掉」「作业被回收」「口令错」
 * 这些状态在真机上极难复现 —— 要等 30 分钟、要故意打错口令、要杀作业。
 * 有了它，这些路径在开发界面的当天就能反复走。
 *
 * ── 必须遵守 ───────────────────────────────────────────────────────────────
 * 开发者模式下界面要醒目标注「开发者模式 · 未连接集群」，用真实模式绝不会出现的
 * 颜色。做了假后端却不标注，正是这个项目一路在清的那类问题：系统声称了不成立的事。
 *
 * ── 关于分区与资源 ─────────────────────────────────────────────────────────
 * 分区不再来自「用途」配置，而是直接从 Slurm 查（守护进程侧走
 * `scontrol show partition` 并与该用户的 association 求交）。所以这里的假数据
 * 就是一份分区表 —— 字段名必须与守护进程逐字一致，否则界面会针对错误的字段名
 * 开发，接上真集群才发现对不上。
 *
 * 默认资源（2 CPU / 8G）由服务端填，客户端不填。假后端照做：
 * 请求里没给的键，就用 DEFAULTS。
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Backend, KIND } = require('./backend.js');
const pluginFiles = require('./plugins/index.js');
const fakeJob = require('./fake-job.js');
const appAssets = require('./app-assets.js');

// 假站点里"站点装了新插件"用的假 id。形状必须是合法 ULID（守护进程与客户端都会
// 校验），但没有任何东西会去核对它是不是真铸出来的 —— 也核对不了。
const DEMO_EXTRA_ID = '01M2JKM1M1M1M1M1M1M1M1M1M1';
/**
 * 上面那一条的短名与显示名。
 *
 * 它们是这个假站点自己编的，与 DEMO_EXTRA_ID 同一类东西（谁也不认识这个名字，
 *   那正是这一格要造的状态）。而基座里不许出现任何一个真插件的短名 ——
 *   一个长在框架代码里的插件名，是"基座不认识任何插件"这句话的反例，
 *   也正是这一路上一直在清的那种。
 */
const DEMO_EXTRA_NAME = 'demo-service';
const DEMO_EXTRA_TITLE = '本机没有的一个示例插件';

/**
 * 假站点里那次"变化的判据"，多久扫一遍。
 *
 * 取守护进程那个 tick 的周期（2 秒），不是因为性能，是因为要照着它演：
 *   真守护进程的推送挂在 tick 上，所以"2 秒内的多次变化只会推出一条"是它的一条
 *   真实性质（用例 26.4 钉着"每个 tick 每条连接至多一条消息"）。假站点扫得快，
 *   这条性质就演不出来，而客户端对着它调的东西（合并、升级判定）会显得比真集群
 *   更容易通过。
 */
const PUSH_SWEEP_MS = 2000;

/**
 * 与守护进程的 `SNAPSHOT_INTERVAL` 同值：哪怕什么都没变，也这么久推一条。
 *
 * 它不是"心跳"。它是让客户端那条看门狗（session.js 的 `PUSH_STALE_MS`）能
 *   把安静与通道坏了分开的那条保证 —— 少了它，一个空闲的会话会被判成
 *   "通道不通"从而退回轮询，功能不受影响，但开发者模式里那条路就再也走不到了。
 */
const PUSH_INTERVAL_MS = 30000;

/**
 * ── 假站点的整包投递 ──────────────────────────────────────────────────
 *
 * 真实的守护进程发的是一个包（`package` + `plugin_package`），假站点照着
 * 它来。假站点没有 `debugPackages` / `debugHideFiles` 这类开关：
 * 一个只能打开唯一那条路的开关，比没有它更糟。
 *
 * 包是拿仓库里那个打包器（`packer/slurmate-packer.js`）现打的，不是手搓的
 *   字节：手搓一份就等于在假站点里又实现了一遍容器格式，而它与真格式分家的那天，
 *   假站点反而会说"一切正常"。打包器导出 `buildPackage`/`contentDigest`，够用了。
 *
 * 签名钥匙由一个写死的种子推出来，不是随机生成的。理由不是"简单"：
 *   客户端在用户第一次同意时会钉住这把公钥（§5.4），此后同一个 id 的每一份
 *   都必须由同一把钥匙签。每次进程启动换一把钥匙的话，第二次启动时那把钉子就会
 *   把假站点自己的插件拒掉 —— 这个假站点会坏在一个看起来像 bug 的地方。
 *   它是模拟数据，不是密钥。
 */
const DEMO_PKG_SEED = Buffer.from('slurmate-demo-package-key-v1!!!!', 'utf8');
/** PKCS#8 里 Ed25519 私钥的头部（RFC 8410），后面接 32 字节种子。 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');


// 假站点报的插件 = 那两处目录加起来（`_siteDirs()`），两处两个角色：
//
//   · 装上去的（`siteInstalledDir`，沙盒里程序自己的一处）—— 这才是"站点上
//     有什么"的答案，而它只有一条来的路：`installPlugins`（与真站点上管理员
//     `plugin install` 同形）。
//   · 开发样例（`samplePluginsDir`，仓库里的 `plugins/`）—— 基座两端都不带
//     任何插件（`plugins/README.md` 第一行），那两棵是开发基座时用来对齐插件两侧
//     能力的样例。打包版没有它们 —— 那是对的，不是降级。
//
//   两条走不通的路值得写明，它们各自会造出一个假现场：
//
//   · 写死几个插件（名字与 id 抄那两个样例）是一句谎话 —— 基座不带插件，于是
//     满屏"本站有而本机没有"，一个故意不带插件的基座看起来像坏了。
//   · 报"本机池里装了什么" 留下一个更隐蔽的死角：站点报的就是本机有的那些，
//     于是「站点有而本机没有」这条最重要的路径在假站点里永远走不到 —— 而
//     开发者模式恰恰是这个项目里唯一能造出那些状态的地方。
//
//   所以站点从盘上读真文件（真的 sha256、真的字节），客户端真的走一遍
//   下载 → 暂存校验 → 同意闸 → 换入。这才是"它演的是生产那条路"该有的样子。
//
//   池只剩一个（站点池），于是"报本机池"读的就是站点自己刚发下去的东西 ——
//     那条路没有，也不该有。
//
//   两处都空，站点一个插件都不报，这是合法状态（一个插件都不装是合法状态）。

// 模拟用的分区表。取的是通用 GPU 型号名，不是任何特定集群的配置。
// 故意留一个 allowed:false 的，好让「没权限的分区要禁用并说明原因」这条路径
// 在开发者模式下也走得到。
//
// GRES 那一格是故意的假，而且比真集群"脏"：本机那台真集群只有不带型号的
//   `gpu`，所以"带型号"（`gpu:a6000`）与"名字不是 gpu"（`mps`）这两条路只在
//   这里走得到。夹具比现实干净，缺陷就会在用例里隐形 —— 见账本 F26。
//   形状与字段名照抄 `scontrol show node -o` 的 `Gres=` 以及守护进程的
//   `node_catalog()`（`scontrol show config` 的 GresTypes 只列名字，不带数量）。
const GRES = {
  '2080TI': [{ name: 'gpu', type: null, per_node_max: 8, total: 8 }],
  'A6000': [{ name: 'gpu', type: 'a6000', per_node_max: 4, total: 8 }],
  // 同一台集群上两种 GRES 并存，其中一种的数量是按份额算的（100 个）——
  //   一个写死的上限 8 会在这里立刻露馅。
  'RTX8000': [{ name: 'gpu', type: 'rtx8000', per_node_max: 4, total: 4 },
              { name: 'mps', type: null, per_node_max: 100, total: 100 }],
  'DEBUG': [],
};
// 每个分区里内存最大的那种节点有多少 MB（协议里那一格，同 `RealMemory=`）。
//   三种形状都要有，否则界面上那几种分支在开发者模式里一个都走不到：
//     · `128000` —— 整 GB（125 GB），滑块画得出来；
//     · `191000` —— 真机上很常见的那种不整的数（186.5 GB），顶要向下取整；
//     · 缺席（DEBUG）—— 没问到，界面不画滑块，只留输入框。
const MEM_MB = {
  '2080TI': 128000,
  'A6000': 191000,
  'RTX8000': 262144,
};
const PARTITIONS = [
  { name: '2080TI',  allowed: true,  is_default: true, max_time: '183-00:00:00', gres: GRES['2080TI'] },
  { name: 'A6000',   allowed: true,  max_time: '183-00:00:00', gres: GRES['A6000'] },
  { name: 'RTX8000', allowed: true,  max_time: '183-00:00:00', gres: GRES['RTX8000'] },
  { name: 'DEBUG',   allowed: false, reason: '你的账户没有该分区的权限', max_time: '1:00:00', gres: GRES['DEBUG'] },
];

/**
 * 假站点的节点忙闲。故意比真集群脏。
 *
 * 本机那台真集群此刻四个节点全是 `idle`/`mix`，一个带后缀的都没有 —— 于是
 * "剥掉后缀、只按 base state 计数，后缀原样留着只做展示"这条路径在真机上根本
 * 走不到，而它正是这一格唯一要验的那件事。夹具比现实干净，缺陷就会在用例里
 * 隐形（见账本 F26）。所以这里给两个带后缀的：
 *
 *   `drain*` —— 不响应（`*`）；`down~` —— 已关电（`~`）。
 *
 * 形状与守护进程 `Slurm.node_table()` 的返回逐字一致：counts 只装 base
 *   state，flags 单独一列。两者的键不相交，那是"从右往左剥"能成立的前提。
 */
const NODES = {
  '2080TI': { counts: { idle: 1, drain: 1 }, flags: { '*': 1 } },
  'A6000': { counts: { mix: 2 }, flags: {} },
  'RTX8000': { counts: { idle: 1 }, flags: {} },
  'DEBUG': { counts: { down: 1 }, flags: { '~': 1 } },
};

/**
 * 假站点的队列。同样故意脏：真集群此刻全是 `PD`，`R` 与"其余那一档"
 * （`CG` 收尾中）都走不到，而"其余那一档不并进 running"是这里唯一的判断。
 */
const QUEUE = {
  '2080TI': { pending: 4, running: 0, other: 0 },
  'A6000': { pending: 5, running: 2, other: 0 },
  'RTX8000': { pending: 0, running: 1, other: 1 },
  'DEBUG': { pending: 0, running: 0, other: 0 },
};

/** 假的 `sacct` 输出。混进两条作业步（`.0` / `.extern`）不可能 —— 那个
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

/** 服务端默认资源。客户端不填这些值 —— 缺省由服务端决定。
 *
 * `gpus: null` = 本站没给这个插件配默认卡（`null` 是"确定的事实"，
 *    与那一格整个不在是两回事 —— 后者是老守护进程）。不给它一个具体的卡是
 *    有意的：假站点里分区是随机挑的，而三个分区的 GRES 型号互不相同 ——
 *    挑任何一个都会让另外两个分区在提交时以 `bad_gres` 被拒，于是"提交成功"
 *    这条主路会在开发者模式下时灵时不灵。要验"配了默认卡"那条路，
 *    用 `debugDefaultGpus()`。 */
const DEFAULTS = { cpus: 2, mem: '8G', time: '12:00:00', gpus: null };
/** 清单里没写 `site.defaultCpus` 之类时的那一组（真站点是内建的那一份）。 */
const SITE_DEFAULTS = { cpus: DEFAULTS.cpus, mem: DEFAULTS.mem, time: DEFAULTS.time };

const DEFAULT_TIME_SECONDS = 12 * 3600;

/** `op_list` 回几条。与守护进程那个 `rows[-50:]` 同一个数。 */
const LIST_MAX = 50;

/** 假站点里「作业内 sshd」听在哪个端口。没有真的 sshd —— 见 _submit 的说明。 */
const DEMO_SSHD_PORT = 55901;
/**
 * 模拟用的主机公钥。这不是一把真钥匙 —— 只是一串形状正确的 base64。
 * 客户端会把它写进 known_hosts（形状校验是真的），但假站点里那个端口后面没有
 * 任何东西在监听，所以 `ssh slurmate` 会在连接阶段就失败。这是诚实的：
 * 开发者模式假掉的从来不只是 SSH 那一跳，而这里连那一跳后面的 sshd 也是假的。
 */
const DEMO_HOST_KEY = 'ssh-ed25519 ' + 'A'.repeat(68);

/**
 * 内存那一格：校验 + 回退。与守护进程的 `sanitize_mem` 逐字同形。
 *
 * `0`、`0G`、`8g`、`abc` 一律回退到默认值（`0` 在 Slurm 里是「整机内存」，
 *   不是零）。返回 `{mem, fell}`：`fell` 为真时调用方必须说出去 ——
 *   静默地替他决定，他就会以为自己要到了。
 */
function sanitizeMem(v, fallback) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  const m = /^([0-9]+)([KMGTP]?)$/.exec(s);
  if (m && Number(m[1]) > 0) return { mem: m[1] + m[2], fell: false };
  return { mem: fallback, fell: Boolean(s) };
}

/** 假站点自称的单文件上限。故意与守护进程那个默认值一样 —— 免得假站点里
 *  一个 200 KiB 的文件在真机上通不过。故意报得比客户端硬上限宽松，好让
 *  "服务端只能收紧、客户端取更严的那个"这条在假站点里也走得到。 */
const DEMO_FILE_BYTES = 512 * 1024;

/**
 * 假站点自称的另外三个上限。它们要与守护进程真正报的那几个数逐字相同 ——
 * 假站点的全部价值就是它演的是同一件事，而偏差是两个方向的坏事：
 *
 *   · 报得更松，开发时通过、真机上被拒；
 *   · 报得更严，开发时被拒、真机上反而能过（作者会去改一个没问题的插件）。
 *
 * `file_bytes` 不在此列（它是上面那个数）：那是刻意报得更松的，好让
 *   "服务端只能收紧、客户端取更严的那个"这条在假站点里也走得到。
 * 这几个数由 `client/test/limits.test.mjs` 与守护进程那几份跨文件钉着。
 */
const DEMO_TOTAL_BYTES = 1561905;    // = PLUGIN_TOTAL_MAX_BYTES（包上限 − 信封最坏情况）
const DEMO_MAX_FILES = 256;
const DEMO_PACKAGE_BYTES = 2 << 20;  // = PLUGIN_PACKAGE_MAX_BYTES

/** 假站点在 `plugins` 那一条里自报的那一组。导出去只给用例（limits.test.mjs
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
   *   jobsDir        {function} 作业目录的根（一条会话一个子目录）。传函数：
   *                             它在不在、在哪，都是每次现算的事实。
   */
  constructor(opts = {}) {
    super();
    this.kind = KIND.FAKE;
    this.label = '本地模拟站点';
    this.enrollDelayMs = Number.isFinite(opts.enrollDelayMs) ? opts.enrollDelayMs : 8000;
    this.rpcLatencyMs = Number.isFinite(opts.rpcLatencyMs) ? opts.rpcLatencyMs : 40;
    this.user = opts.user || 'demo';
    this._pickPartition = typeof opts.pickPartition === 'function' ? opts.pickPartition : null;
    this._jobsRoot = typeof opts.jobsDir === 'function' ? opts.jobsDir : () => null;
    /** 见 `debugNoBash`。 */
    this._noBash = false;

    /**
     * 正在跑的作业侧：`session_id → FakeJob`。
     *
     * 从前这里是一个 `_server`（一个内置的假网页服务），而每一条会话的隧道都
     *   指向它 —— 于是"点启动打开的那个页面"与是哪个插件无关。现在那条路没有了：
     *   有界面的插件真的把自己的作业侧跑起来，隧道指向它，日志是它自己说的。
     */
    this._jobs = new Map();
    /**
     * 假站点上的全部会话。
     *
     * 为什么是一张表而不是一个 `_session`：客户端那一半
     *   能不能同时挂两条会话，只有在假后端上才验得了（真集群上要造出"两个
     *   会话同时活着"极难）。留一个单值的话，多开那几条最要紧的用例
     *   根本没有办法跑起来 —— 而"用例跑不起来"与"功能是对的"在输出上长得一样。
     *
     * 每条会话自己带定时器（`_enrollTimer` / `_releaseTimer`）：把这两个字段
     *   挂在后端上，一个会话结束时 `_clearTimers()` 会把另一条会话的登记定时器
     *   一起清掉 —— 那条会话就永远停在 `submitted`，而界面上一切正常。
     */
    this._sessions = [];
    /**
     * 每人最多几条会话。与守护进程的 `max_sessions_per_user` 同一条规则，
     * 缺省也同值（1，安全侧）。用例直接把 `getBackend().maxActive = 2` 就能验多开。
     */
    this.maxActive = 1;
    /**
     * 某个插件自己的会话上限（短名 → 数字），对应真站点上插件那一份配置里的
     * `max_sessions`。没写进这张表的插件跟随 `maxActive`。
     *
     * 它是一张表而不是一个数：真站点上这一格是【每个插件一份】的，而
     *   "全局放开、唯独不让某一个插件多开"正是这一格存在的理由 ——
     *   一个数的话，开发者模式里那一档永远看不到。
     *
     * 与 `maxActive` 一样没有 `app:debug` 命令，由用例直接摆
     *   （`getBackend().pluginMaxSessions.set(…)`）：它造的是"管理员在某一份
     *   配置里写了个数"那个现场。
     */
    this.pluginMaxSessions = new Map();
    /**
     * `scancel` 这一次会不会失败。默认不失败（正常的站点上它多半成功）。
     *
     * 这个开关存在的理由与 `maxActive` 一样：真守护进程会在取消失败时
     *   回一个 `warning`（协议里那个字段，见 `op_goodbye`），而一个永远不会失败
     *   的假后端让客户端那一半根本没有办法验。假后端演的是同一件事 ——
     *   包括它失败的那一面。
     */
    this.cancelFails = false;
    this._seq = 0;
    /**
     * 这台电脑的客户端身份（见 backend.js 的接口注释）。
     *
     * 假站点真的用它：提交时写进会话行的 `keeper`（与真守护
     *   进程的 `op_submit(client_id)` 同一个位置），心跳按它判"这是不是看护者"，
     *   接管按它换人。身份不用来排席位，用来认看护者。
     *
     * 一个不看这个字段的假后端，会让"客户端身份根本没送到后端"这件事在
     *   开发者模式里完全看不出来 —— 而那正是这一版最重的一条失败形态
     *   （身份没到，看护者永远为空，谁也不认得自己的会话）。
     */
    this._client = (opts && opts.client) || null;
    /**
     * 假站点上别人的看护者（模拟另一台电脑）。`null` = 没有别人。
     *
     * 存在的理由与 `cancelFails` 一样：真集群上"这条作业被另一台电脑看着"
     *   要两台机器才造得出来，而接管这个按钮的全部意义就是那一刻。
     *   `_sessions` 里那些会话的 keeper 会被它覆盖（见 `_effKeeper`）。
     */
    this._foreignKeeper = null;
    /**
     * 集群信息里哪些格缺席（`{health:true, nodes:true, …}`）。
     *
     * 存在的理由是那一条三态规矩：「获取失败」与「确实没有」在界面上是两句
     *   不同的话。真集群上"获取失败"要么要等一次故障、要么要把 sinfo 改名 ——
     *   而它恰恰是这一整块最容易画错的那一格。见 _cluster()。
     */
    this._clusterMissing = {};
    /** `sacct` 获取失败。同上 —— 它回的是错误不是空列表，两者不能混。 */
    this._historyDown = false;

    /**
     * 推送那一半的账。
     *
     * 机制与守护进程的 `phase_push` 一样：变化的判据是渲染结果本身
     *   （一份指纹），不是"谁改过状态"。差别只有载体（那边是 tick()，这里是
     *   一个定时器）。这样写不只是省事 —— 它让"忘了在某个改动点标脏"这件事
     *   从构造上不存在，而那个漏法的症状是某个状态在界面上永远不更新。
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
     * 假站点上那两处目录（见文件头）。两处，两个角色：
     *   · `siteInstalledDir` —— 装上去的东西落的地方（也是 `installPlugins` 的落点）
     *   · `samplePluginsDir` —— 开发样例住的地方（打包版没有它，那是对的）
     *
     * 传函数而不是路径 —— 打包之后样例那棵树不存在、沙盒那处要等 userData 定下来，
     * 而"这个目录现在在哪／在不在"必须是每次现算的结果。
     */
    this._siteInstalledDir = typeof opts.siteInstalledDir === 'function'
      ? opts.siteInstalledDir : () => null;
    this._siteSampleDir = typeof opts.samplePluginsDir === 'function'
      ? opts.samplePluginsDir : () => null;
    /** 调试用：让某一份的包里多一个超过单文件上限的文件。见 debugBloatPlugin。 */
    this._bloatPlugin = null;
    /** 调试用：让站点在 `plugin_package` 上回 rate_limited 若干次。 */
    this._rateLimitBurst = 0;
    /** 假站点里被"关掉"的插件（按短名）。 */
    this._siteDisabled = new Set();
    /**
     * 假站点里装了但没有作业侧实现的插件（按短名）。
     *
     * 默认是空的：一个正常部署的站点，装了的插件就有作业脚本。这个集合是故意
     *   造那第四格状态的开关。真机上那件事来自 `install-base.sh` 有没有为这个插件生成
     *   `<ULID>.sbatch`，客户端看不见 —— 所以它只可能由站点侧合成后报下来
     *   （`op_plugins` 的 `can_submit`）。
     */
    this._siteNoJob = new Set();
    /**
     * 假站点报出去的基座版本（`ping` 的 `version`）。
     *
     * `null` = 跟着本客户端的版本走（也就是"版本一致、判定通过"）。
     *   要造"站点比客户端新"或"跨大版本"那两态，就用 `app:debug daemon-version`。
     *
     * 默认不写死假版本号 —— 一个不合 `x.y` 形状的写死值是一个睡着的错：
     *   没人读 `ping` 的 `version` 时它不响，版本握手一做就当场醒。要"报一个
     *   明显假的值"用调试开关（`app:debug daemon-version`）—— 报假版本号有用，
     *   只是不该是默认行为。
     */
    this._daemonVersion = null;
    /** 造出「守护进程太旧，根本没有 plugins 这个 op」。见 _dispatch。 */
    this._noPluginsOp = false;
    /** 造出「有 plugins 这个 op，但不会分发」（v0.5 的守护进程）。 */
    this._noDistribute = false;
    /**
     * 假站点报出来的站点级插件问题（`op_plugins` 顶层那个 `problems`）。
     *
     * 默认空的，而且在 `_noDistribute` 那一档里一律不发：那个字段是 v0.11
     *   才有的，v0.5 的守护进程报不出来 —— 让它照发就等于演了一个不存在的版本。
     *   见 `debugPluginProblems` 与 `_dispatch` 的 `case 'plugins'`。
     */
    this._pluginProblems = [];
    /**
     * 站点给插件配的默认 GRES（`defaults.gpus`）。`null` = 没配（见 DEFAULTS）。
     *
     * 真站点是每个插件一份，而假站点只有一份全局的 —— 与它给 cpus / mem /
     *   time 的待遇一样（DEFAULTS 那一份）。要验界面在"配了默认卡"时那句话怎么写，
     *   用 `debugDefaultGpus()`。
     *
     * 它不进 `_noDistribute` 那一档：`defaults.gpus` 是 v0.11 才有的格，
     *   与 `time` / `problems` 同一条 —— 那一档照发就等于演了一个不存在的版本。
     */
    this._defaultGpus = null;
    /** 打好的包，按 `(id@版本)` 缓存 —— 见 _pkgOf。 */
    this._pkgCache = new Map();
    /**
     * 打不出包的原因（`null` = 打得出来）。
     *
     * 它只有一种来源：这一份客户端里没有打包器。那种情况下站点照协议回
     *   `package: null`（"此刻生产不出来"），而客户端能说的只有"现在发不出来"
     *   —— 真正的原因在这一格，由调试那一屏与一条开机提示说出去。
     */
    this._pkgWhy = null;
    /** 造出「这个客户端里没有带打包器」——见 debugNoPacker。 */
    this._noPacker = false;
  }

  /**
   * 这一份的包（现打、缓存）。返回 `{buf, meta, fingerprint}` 或 `null`。
   *
   * 缓存不失效，与 `_siteIndex` 同一个语义：那一份索引是启动快照，而包的
   *   摘要与字节必须描述同一棵树。真守护进程那边正是这么做的
   *   （`Sessiond._plugin_cache`），"管理员就地换了文件"在两边都变成同一件事：
   *   清单、文件、包三者说的还是同一份东西，而客户端会拿到 `..._changed`。
   */
  _pkgOf(key) {
    if (this._pkgCache.has(key)) return this._pkgCache.get(key);
    const entry = this._siteIndex().get(key);
    if (!entry) return null;
    let out = null;
    // 打包器是这一份包的全部来源，所以先找它，而且找的过程不许静默失败：
    //   没有它的症状是"站点报得出插件、却一个都发不出来"，指不回这里。
    //   它在安装包里的位置见 `app-assets.js` 与 `electron-builder.yml` 的
    //   `extraResources`（那一对由 `client/test/packaging.test.mjs` 钉着）。
    const found = this._noPacker
      ? { why: appAssets.NO_PACKER } : appAssets.findPacker();
    if (!found.path) {
      this._pkgWhy = found.why;
      this._pkgCache.set(key, null);
      return null;
    }
    try {
      const packer = require(found.path);
      const files = entry.files.map((f) => {
        const data = fs.readFileSync(path.join(entry.dir, ...f.path.split('/')));
        return { path: f.path, data, sha256: f.sha256 };
      });
      // `debugBloatPlugin` 造的那一份：往包里塞一个装不下的文件。
      //   客户端读包时执行那几条负载上限（`checkDeclared`），所以它会在那里被拒
      //   —— 造的正是"站点支持分发，但这一份装不上"。
      //   它必须落在客户端侧（`client/…`）：站点发出去的包里
      //     只有客户端侧，塞在顶层的话它根本不在包里，这个调试开关就静默失效了。
      if (this._bloatPlugin === key) {
        const big = Buffer.alloc(DEMO_FILE_BYTES + 1, 0x78);
        files.push({ path: 'client/bloat.bin', data: big,
                     sha256: crypto.createHash('sha256').update(big).digest('hex') });
      }
      const priv = crypto.createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, DEMO_PKG_SEED]),
        format: 'der', type: 'pkcs8',
      });
      const pub = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' })
        .subarray(-32);
      // 签的是四元组（A.3）—— 与真守护进程、与打包器走的是同一个
      //    实现（`sideDigests` / `signedMessage` / `buildSigBlock` 都从打包器来）。
      //    假站点在这里再手搓一遍就等于又实现了一次容器格式，而它与真格式分家
      //    的那天，假站点反而会说"一切正常"。
      //    四元组算整棵树（身份），而发出去的只含客户端侧 —— 与真守护
      //      进程逐字同构（`plugin_rebuild`）。假站点要是继续发整包，它就不再是
      //      真站点的一个像样的替身了。
      const sd = packer.sideDigests(files);
      const quad = { id: entry.id, version: entry.version,
                     digestSite: sd.site, digestClient: sd.client };
      const sig = crypto.sign(null, packer.signedMessage(quad), priv);
      const send = files.filter((f) => packer.isClientSidePath(f.path));
      const buf = packer.buildPackage(send,
        packer.buildSigBlock(Object.assign({ alg: 1, pubkey: pub, sig }, quad)));
      out = {
        buf,
        // `digest` 是 `op_plugins` 报的那个 —— 发出去那一份（客户端侧）的摘要。
        meta: { format: 2, bytes: buf.length, digest: sd.client },
        fingerprint: crypto.createHash('sha256').update(pub).digest('hex'),
      };
    } catch (e) {
      // 打包器在、而这一份打不出来：照协议这只是"此刻生产不出来"
      //   （`package: null`），但原因留在这里，别吞掉 —— 下一句要能说清是
      //   "没有打包器"还是"这一棵树打不出来"。
      this._pkgWhy = `打 ${key} 的包时出错：${e.message}`;
      out = null;
    }
    this._pkgCache.set(key, out);
    return out;
  }

  /**
   * 这个冒牌站点的打包能力自述。调试那一屏与开机那条提示读它。
   *
   * `path` 为空 = 这一份客户端里没有打包器（`why` 说清是为什么）；`path` 在而
   *   `why` 非空 = 上一次打包出过错。
   */
  packerReport() {
    if (this._noPacker) return { path: null, why: appAssets.NO_PACKER };
    const f = appAssets.findPacker();
    return { path: f.path || null, why: f.path ? this._pkgWhy : f.why };
  }

  /**
   * 让假站点假装"这个客户端里没有带打包器"。
   *
   * 造的是一个真实现场（安装包里漏带了打包器），而它的症状是"站点报得出插件、
   *   客户端却一份都没收到" —— 那条路必须能走到，否则那几句提示谁也没验过。
   *   与 `debugNoBash` 同一条理由：这台开发机上是造不出这个现场的（打包器就在
   *   仓库里躺着，而"运行的是哪一份代码"不是运行时能改的）。
   *
   * 打过的包要一起作废：`_pkgCache` 里存的正是"打不打得出来"这件事的结果，
   *   不失效的话这个开关对已经报过一轮的那些静默无效 —— 而它恰恰是用来
   *   验那条路的。
   */
  debugNoPacker(on = true) {
    this._noPacker = on;
    this._pkgCache.clear();
  }

  /**
   * 假站点上那两处目录（装上去的 + 开发样例），装上去的排在前面。
   *
   * 顺序是承重的：同一个 id 在两处都有时，先扫到的那个进索引（下面 `has` 那一句
   *   决定谁赢）—— 而"站上已经有一棵"这条判据也因此看得见两处。
   */
  _siteDirs() {
    const out = [];
    for (const f of [this._siteInstalledDir, this._siteSampleDir]) {
      const d = f();
      if (d && !out.includes(d)) out.push(d);
    }
    return out;
  }

  /**
   * 假站点的分发索引：`(id@版本) → {dir, files}`，来自那两处目录。
   *
   * 这里那个 `files` 是包里的记录表（打包时要喂给打包器的负载清单），
   *   不是协议字段 —— 协议里没有 `files` 这个字段，两件事同名，所以写清楚。
   *
   * 建一次就不再失效 —— 与守护进程侧的启动快照逐字同一个语义。这样开发者模式
   *   也能演"管理员就地换了文件"那件事：清单与包永远描述同一棵树。
   */
  _siteIndex() {
    if (this._indexCache) return this._indexCache;
    const cache = new Map();
    for (const base of this._siteDirs()) {
      // 扫树的规矩只有一份（`plugins/index.js` 的 scanPluginCollection）——
      //   调试那一屏也是用它报"这个目录里读到几个插件"的。两处各写一遍的话，
      //   界面说"读到 3 个"而站点只报 2 个，谁也不知道差在哪。
      //   `skipped` 这里不用：坏清单就是发不出来的一份东西，站点不报它
      //   （与守护进程一致）；那是界面上那句"只有 N 个能用"的事。
      const { plugins: found } = pluginFiles.scanPluginCollection(base);
      for (const { dir, manifest: mf } of found) {
        let files;
        try {
          // 只取普通文件：符号链接与空目录进不了负载（格式里表达不出来），
          // 而打包器的负载只描述文件。这与守护进程读包时同一个口径 ——
          // 那边是 `package_read_file()` 读出来的记录表说了算，链接与目录在
          // 格式里根本表达不出来，不是"被跳过"。
          files = pluginFiles.readPluginFiles(dir)
            .filter((f) => f.kind === 'f')
            .map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
        } catch { continue; }
        const c = (mf.contributes && typeof mf.contributes === 'object') ? mf.contributes : {};
        const key = `${mf.id}@${mf.version}`;
        // 两处都有同一个 `id@版本` 先扫到的那个算数（装上去的排在前）。
        //   同一棵树在两处各有一份不是错误（从源码跑时把样例也装了一遍就会这样），
        //   而"站点上有哪几棵树"必须只有一个答案 —— 让后扫到的覆盖掉，
        //   会让 `installPlugins` 里那条"同 id 拒装"的判据看到一个和它刚看过的
        //   不一样的 `dir`。
        if (cache.has(key)) continue;
        cache.set(key, {
          dir, files, name: mf.name, title: mf.displayName || mf.name,
          // 「这个插件有没有作业侧」的判据是记录表里有没有那一份
          //   （`job/start.sh`）—— 与守护进程 `plugin_scan` 那一句逐字同形。
          //   从前假站点不判这一格（它也不跑作业侧，判了没用）；现在它真的起
          //     那个片段，于是这一格从"演得像"变成了它自己要知道的事实：
          //     没有作业侧的插件提交不了（`can_submit: false`），
          //     而不是"提交得出去、起来的时候说找不到那个文件"。
          hasJob: files.some((f) => f.path === pluginFiles.JOB_ENTRY),
          // 这个插件自己的默认资源，从它的清单里读（读不到就用内建那一组）。
          //   真守护进程那一侧是 `pcfg.default_*`：插件配置 ＞ 清单 ＞ 内建。
          //   假站点没有"插件配置"那一层（没有管理员），所以就是清单 ＞ 内建。
          defaults: {
            cpus: Number.isInteger(mf.site && mf.site.defaultCpus)
              ? mf.site.defaultCpus : SITE_DEFAULTS.cpus,
            mem: (mf.site && typeof mf.site.defaultMem === 'string' && mf.site.defaultMem)
              || SITE_DEFAULTS.mem,
            time: (mf.site && typeof mf.site.defaultTime === 'string' && mf.site.defaultTime)
              || SITE_DEFAULTS.time,
          },
          // 内部用（不在 `plugins` 响应里）：现打一个包要签四元组（A.3），
          //   而四元组的头两段就是这两个。从 `key` 那个串里切是不行的 —— 版本号
          //   里可能出现 `@`，而身份不该由一个给人看的字符串反推出来。
          id: mf.id, version: mf.version,
          // 内部用，不进 `plugins` 响应（见下面 case 'plugins' 的逐字段挑）。
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
   * 把那张启动快照丢掉，下一次现扫。
   *
   * 只有两个调用方，各有一条理由：
   *
   *   · `installPlugins` 装着插件 —— 站点"装完当场就报它"靠的就是这一下
   *     （真守护进程那边是 `plugin install` 之后的重载）。
   *   · 用例要换掉假站点那棵样例树（`_test.setDevSampleDir`）—— 那在真机上
   *     等于重启，而一个进程里 index.js 只加载一次。
   *
   * 除这两处没有别人该调它：这张快照是启动快照，随手丢它就等于把
   *     "清单、文件、包三者说的是同一棵树"那条保证松掉（`_pkgOf` 依赖它）。
   */
  forgetSiteIndex() {
    this._indexCache = null;
    this._pkgCache.clear();
  }

  /**
   * 假站点当前报出去的插件清单。
   *
   * 每次现算，不缓存：用户可以在开发者模式里装/卸插件，而站点"看到"的东西
   *   应该跟着变 —— 这正是真实的 `op_plugins` 的行为。
   */
  _sitePlugins() {
    // ── 分发源：盘上的真文件（装上去的那一处 + 开发样例那一处）──
    const distributed = [...this._siteIndex().entries()].map(([key, v]) => ({
      id: key.slice(0, key.lastIndexOf('@')),
      version: key.slice(key.lastIndexOf('@') + 1),
      name: v.name,
      title: v.title,
      // 每个插件一份默认资源，来自它自己的清单（`site.defaultCpus` / `defaultMem`
      //   / `defaultTime`）。真站点就是每个插件一份，而假站点从前是一份全局的 ——
      //   于是"这个站点给这个插件配了 4 核"在开发者模式里永远看不到。
      defaults: v.defaults || SITE_DEFAULTS,
      enabled: !this._siteDisabled.has(v.name),
      // 这个插件上每人最多几个会话（见 `_maxSessionsOf`）。
      max_sessions: this._maxSessionsOf(v.name),
      // 没有作业侧的插件提交不了 —— 与守护进程同一条判据（它数的是记录表里
      //   有没有 `job/start.sh`）。少这一格的话，假站点会放行一份真站点上根本
      //   提交不出去的东西，而失败出现在起会话那一步（"读不到那个片段"），
      //   指不回"这个插件没有作业侧"。
      can_submit: !this._siteDisabled.has(v.name) && !this._siteNoJob.has(v.name)
        && v.hasJob !== false,
      surface: v.surface, submitPubkey: v.submitPubkey, login: v.login,
    }));
    // 别把"客户端池里装了什么"补进站点要报的插件（那两处都空的时候，
    //   有人会觉得本机池是唯一的来源）。理由不只是"池只剩一个"：那一段让假站点的
    //   清单由客户端自己的池决定 —— 而"站点有、本机没有"这条最重要的路径
    //   正是被它盖住的（站点报的就是本机有的那些，于是 `missing` 永远是空的）。
    //   开发者模式的全部价值是它演的是同一件事，而兜底演的是一件自证成立的
    //   事。
    //
    //   打包版没有样例那棵树（基座两端都不带任何插件，那是对的），于是新装的
    //     客户端上假站点是空的 —— 一个插件都不装是合法状态，出路是去装一个。
    //     别再往回加兜底 —— 换了名字的兜底还是同一个毛病。
    //
    //   那几条调试用的假插件也过一遍 `_maxSessionsOf`：它们是在这张表还空着的
    //     时候建的，记着的那个数是当时的值。不过这一遍的话，用例摆上去的上限只在
    //     提交那一侧生效、而报出去的是另一个数 —— 那正是这一格会漂的样子。
    return [...distributed, ...this._extraSitePlugins.map((p) => ({
      ...p, max_sessions: this._maxSessionsOf(p.name),
    }))];
  }

  /**
   * 把一个 `.splug` 装到假站点上 —— 与真站点 `slurmate plugin install <文件.splug>` 同形。
   *
   * 落点是"装上去的东西"那一处（`_siteInstalledDir()`，沙盒里、程序自己的），
   *   与样例那一棵分家 —— 用户装什么，都不该动到开发样例。一棵树一个 id，与真
   *   站点一样 —— 所以"同一个 id 已经有另一棵树"是拒，不是覆盖（那棵树可能在
   *   两处中的任何一处，那句错话里印的就是它的 `dir`）。真站点上那条路是
   *   `uninstall` 之后再装，而这句话要说清删掉哪个目录。
   *
   * 两遍式（与守护进程的 `install_plugins` 逐字同形）：第一遍只把每份包铺到
   *   一个暂存目录里并逐份校验，一条不过就一个字节都不落地。于是"装了一半"
   *   这件事不会发生在一个能被读到的中间态上（`rename` 才是那一下开关）。
   *
   * 清单校验用客户端那一份（`pluginFiles.inspectDir`）。假站点没有站点侧那套
   *   （它在守护进程的 Python 里），而这是更严的那一侧：一棵客户端注定加载不了
   *   的树，让它装上去只会把失败推迟到"用户已经点过同意之后" —— 那时用户已经为
   *   一个装不上的东西负过责任了。代价如实记着：真站点上装得上、而本客户端加载
   *   不了的（比如 `engines` 不满足），这里会在装的那一刻就拒。
   *
   * @param {string[]} paths `.splug` 的路径，可以给多个（与真站点一样）。
   * @returns {{ok:true, installed:object[], unchanged:object[]}
   *          |{ok:false, code:string, error:string}}
   */
  installPlugins(paths) {
    // 惰性取，理由与 `_pkgOf` 里那句一样：这个模块在加载期与 site-plugins 那条链
    // 有来回，而它只在这一条路上用得到。
    const PP = require('./plugin-package.js');
    const list = Array.isArray(paths) ? paths : [];
    if (!list.length) return { ok: false, code: 'nothing', error: '没有选中任何 .splug。' };

    const dir = this._siteInstalledDir();
    if (!dir) {
      return { ok: false, code: 'no_dir',
               error: '无法确定插件数据的存放位置：客户端的数据目录还没定下来。' };
    }
    // 目录由这里建：它是程序自己的一处，第一次装东西之前它不存在，
    //   而"还没有这个目录"不是错误（"站点上还没装过东西"就是这个样子）。
    //
    // 这一行的价值只在出错那一条路上，写清楚免得下一个人以为它多余：
    //   正常路径上，下面铺暂存那一步（`unpackTo` 往 `dir/.slurmate-stage-…` 写）
    //   本来就会顺手把父目录造出来。所以"把它删掉"是一个等价变异 —— 用例一条
    //   都不会红（这一轮真撞上过）。留着它是因为它把"这一处建不出来"（权限、
    //   或者那个路径上躺着一个文件）变成一句说得清的错，而不是让后面某一步
    //   以一句看不出所以然的话收场。
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
    catch (e) {
      return { ok: false, code: 'no_dir',
               error: `装插件的地方「${dir}」建不出来：${e.message}` };
    }

    // ── 站上现在有哪几棵树（那两处一起扫，装上去的排在前）。一次扫完：
    //    逐份现扫的话，自己刚铺下的暂存目录会进到"站上已有的"里（它在同一个目录下）。 ──
    const onSite = this._siteDirs()
      .flatMap((d) => pluginFiles.scanPluginCollection(d).plugins);
    /** 这一次调用里出现过的 id → 是哪个文件带来的（§6.4：两个同 id 的都不装）。 */
    const seenId = new Map();

    const problems = [];
    const staged = [];          // 已经铺好、验过，还没就位的
    const unchanged = [];       // 站上本来就是这一份

    for (const p of list) {
      const base = path.basename(p);

      let buf;
      try { buf = fs.readFileSync(p); }
      catch (e) { problems.push(`${base}：读取失败：${e.message}`); continue; }

      const r = PP.parsePackage(buf);
      if (!r.ok) {
        problems.push(`${base}：不是一个合法的插件包（${r.code}）：${r.why}`);
        continue;
      }
      const { id, version } = r.manifest;
      const title = r.manifest.displayName || r.manifest.name;

      if (seenId.has(id)) {
        problems.push(`${base}：id ${id} 与 ${seenId.get(id)} 是同一个插件，两个都不装`
          + '（站点按 id 给该目录树命名，两个会互相覆盖，而覆盖是静默的）。');
        continue;
      }

      const hit = onSite.find((x) => x.manifest.id === id) || null;
      if (hit) {
        const hitTitle = hit.manifest.displayName || hit.name;
        // 是同一棵吗？比的是 §3.4 那个内容摘要 —— 站点报给客户端、签名盖着、
        // 用户同意时看的都是它。拿别的判据（比如"文件数一样"）就是第二个说法。
        let same = false;
        try {
          same = r.digest === PP.contentDigest(
            pluginFiles.readPluginFiles(hit.dir).filter((f) => f.kind === 'f')
              .map((f) => ({ path: f.path, sha256: f.sha256 })));
        } catch { same = false; }
        if (same) {
          unchanged.push({ id, version, name: r.manifest.name, title, dir: hit.dir });
          seenId.set(id, base);
          continue;
        }
        problems.push(`${base}：站点上已经有一份「${hitTitle}」，在 ${hit.dir}。`
          + (hit.manifest.version === version
            ? `版本相同（都是 ${version}）而内容不是同一份`
            : `站点那一份是 ${hit.manifest.version}，这一份是 ${version}`)
          + '。\n        一个 id 在站点上只留一份。要装这一份，先把站点上那一份'
          + `撤掉（真站点上是 \`slurmate plugin uninstall ${id}\`；这个假站点上就是`
          + '删掉那个目录），再来装。');
        continue;
      }

      // ── 铺到暂存并校验。还没有落地。──
      const stage = path.join(dir,
        `.slurmate-stage-${crypto.randomBytes(6).toString('hex')}`);
      const w = PP.unpackTo(r, buf, stage, { onto: 'site' });
      if (!w.ok) { problems.push(`${base}：${w.why}`); continue; }

      const ins = pluginFiles.inspectDir(stage);
      if (ins.error) {
        fs.rmSync(stage, { recursive: true, force: true });
        // 那句错话里带着暂存目录的路径，而那个目录此刻已经没了 —— 把它换成
        // "这一份里"，否则读的人会去找一个不存在的地方。
        problems.push(`${base}：这个包装上去本客户端也加载不了：`
          + ins.error.split(stage).join('这一份里'));
        continue;
      }

      seenId.set(id, base);
      staged.push({ stage, dest: path.join(dir, id), id, version,
                    name: r.manifest.name, title });
    }

    // ── 第一遍没过，收掉暂存，一个字节都不落地（与守护进程同一句话）。 ──
    if (problems.length) {
      for (const s of staged) fs.rmSync(s.stage, { recursive: true, force: true });
      return { ok: false, code: 'rejected', error: problems.join('\n') };
    }

    // ── 第二遍：就位。`rename` 就是那一下开关（真守护进程的 `_install_plugin_tree`
    //    同一个形状）。 ──
    const installed = [];
    for (const s of staged) {
      try {
        fs.renameSync(s.stage, s.dest);
      } catch (e) {
        fs.rmSync(s.stage, { recursive: true, force: true });
        // 已经就位的那几棵不回滚：每一棵都是完整的（`rename` 是原子的），
        //   而回滚会把"装上了两棵、第三棵没成"说成"一棵都没装" —— 后者更假。
        return { ok: false, code: 'partial', error:
          `「${s.title}」移动到 ${s.dest} 失败：${e.message}\n`
          + (installed.length
            ? `已经装上的（这几份是完整的）：${installed.map((x) => x.title).join('、')}`
            : '（还没有一棵装上去。）') };
      }
      installed.push({ id: s.id, version: s.version, name: s.name, title: s.title, dir: s.dest });
    }

    // 装完当场重扫 —— 站点"立刻报它"靠的就是这一下。少了它，用户看到的是
    //   "装上了、而站点还是没报它"，那个症状指不回这里。
    if (installed.length) this.forgetSiteIndex();

    return { ok: true, installed, unchanged };
  }

  /**
   * 从假站点上撤掉一棵插件树 —— 与真站点 `slurmate plugin uninstall <id>` 同形。
   *
   * 只能撤"装上去的"那一处（`_siteInstalledDir()`）。开发样例那一棵在仓库里，
   *   它不是装上去的 —— 撤它等于删开发者的源码树，而那与这个假站点要演的那件事
   *   （管理员在站点上装、卸）毫无关系。判据是那棵树住在哪个根下，不是它叫什么：
   *   `_siteIndex()` 里每一格都带着自己的 `dir`，而两处目录是分开的。
   *
   * 删完当场重扫，与 `installPlugins` 收尾那一句对称：站点"立刻不报它"靠的就是
   *   这一下。少了它，用户看到的是"撤掉了、而站点还在报它"，而那个症状指不回这里。
   *
   * 一次可以给多个键（与装那一侧同形），但要撤的是一棵树，不是一份包：
   *   键是 `id@版本`，而树按 id 命名（一个 id 在站点上只留一份，见 installPlugins
   *   里那条"同 id 拒装"）。版本只用来核对是同一棵。
   *
   * @param {string[]} keys `id@版本`
   * @returns {{ok:true, removed:object[], problems:string[]}
   *          |{ok:false, code:string, error:string}}
   */
  uninstallPlugins(keys) {
    const list = Array.isArray(keys) ? keys : [];
    if (!list.length) {
      return { ok: false, code: 'nothing', error: '没有指定要撤掉哪一个插件。' };
    }
    const root = this._siteInstalledDir();
    if (!root) {
      return { ok: false, code: 'no_dir',
               error: '无法确定插件数据的存放位置：客户端的数据目录还没定下来。' };
    }
    const index = this._siteIndex();
    const removed = [];
    const problems = [];
    for (const key of list) {
      const hit = index.get(key);
      if (!hit) { problems.push(`${key}：假站点上没有这一份。`); continue; }
      // 它住在哪一处：装上去的，还是开发样例。比的是父目录，不是名字前缀 ——
      //   目录名两处用的是同一个（插件 id），拿名字判分不开。
      if (path.resolve(path.dirname(hit.dir)) !== path.resolve(root)) {
        problems.push(`${hit.title}：它是开发样例，不是装上去的（在 ${hit.dir}）。`
          + '样例那一棵树在仓库里，撤它要改仓库。');
        continue;
      }
      try {
        fs.rmSync(hit.dir, { recursive: true, force: true });
      } catch (e) {
        problems.push(`${hit.title}：目录删除失败（${e.code || '未给出原因'}）。`);
        continue;
      }
      // 与撤销一份插件数据同一个动作、同一句复核（`index.js` 的 `removeDirChecked`）：
      //   Windows 上有句柄时 `rm` 会删一半然后抛，报成功而它还在的话，
      //   站点下一轮照旧报它，而用户会以为自己撤过了。
      if (fs.existsSync(hit.dir)) {
        problems.push(`${hit.title}：目录删除失败（删掉之后又出现）。`);
        continue;
      }
      removed.push({ id: hit.id, version: hit.version, title: hit.title, dir: hit.dir });
    }
    if (removed.length) this.forgetSiteIndex();
    if (!removed.length) return { ok: false, code: 'rejected', error: problems.join('\n') };
    return { ok: true, removed, problems };
  }

  /** 见 backend.js 的接口注释：调用方问「有没有连上」，不该去猜后端内部的字段名。 */
  get connected() { return this._connected; }

  /**
   * 假后端永远"常驻"：对面就是这个进程自己起的东西，一次 RPC 是一个本进程内的
   * 函数调用 —— 没有 exec 那回事，也就没有"退化"这一档。
   *
   * 不能省掉这一格而落到基类那个 `null`：那会让开发者模式按最保守的节奏
   *   跑（1.5 秒一次的轮询变成 10 秒一次），于是你在假站点上验的那套节奏
   *   与真集群上的根本不是同一套 —— 而"开发模式能跑、真集群跑不了"正是这个
   *   接缝最怕的一类。
   */
  get resident() { return true; }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  async connect(profile) {
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
    // 只取消等待登记那一拍，释放那一拍留着。
    //
    //   两者的区别是"这件事还属不属于这次连接"：
    //     · `submitted` 还等着登记 —— 连接都断了，登记已经没有意义，取消它是对的；
    //     · `releasing` 是站点自己在收尾（`scancel` 已经发出去了），它一定会
    //       在那之后变成 `released`，与客户端在不在无关。
    //
    //   一起取消的后果是假站点把一个会话留在了一个它永远不会离开的状态里，
    //   而 `_occupying()` 会把下一条用例的提交挡在「已经有 1 个会话占着位置」上
    //   —— 那个症状排查的是它自己，指不回这里。
    //   定时器是 unref 的，所以留着它不会拖住进程退出。
    for (const s of this._sessions) {
      if (s._enrollTimer) { clearTimeout(s._enrollTimer); s._enrollTimer = null; }
    }
    this._stopPushSweep();
    this._connected = false;
    // 每一个作业侧都要收掉。不关的话留下的是真的进程：端口还听着、
    //   用例跑完了而整个套件不退出 —— 而那个症状指不回这里。
    const jobs = [...this._jobs.values()];
    this._jobs.clear();
    for (const s of this._sessions) s._job = null;
    await Promise.all(jobs.map((j) => j.stop().catch(() => {})));
    this._emitState(false, '已关闭');
  }

  // ── RPC ─────────────────────────────────────────────────────────────────
  async rpc(req) {
    const op = String((req && req.op) || '');
    if (this.rpcLatencyMs > 0) await sleep(this.rpcLatencyMs);

    // 调试：模拟守护进程不可达。注意这返回的是 ok:false 的 JSON，
    // 而不是抛异常 —— 真实情况下也是守护进程/CLI 构造出这个 JSON 的
    // （cluster/slurmate:226-232），传输层异常是另一条路径。两条都要能测。
    if (Date.now() < this._daemonDownUntil) {
      return err(5, 'daemon_unreachable',
        '无法连接 Slurmate 守护进程（/run/slurmate-session/ctl.sock）：开发者模式模拟');
    }

    switch (op) {
      // 版本号今天是被读的（连接期的那次握手），所以默认报本客户端的版本
      //   —— 开发者模式的默认状态是"版本一致"，而不是"版本不明"。
      //   要造"站点更新"或"跨大版本"就用 `app:debug daemon-version <x.y>`；
      //   要造"对面答的不像我们的守护进程"，就把它设成一个不合 x.y 的值。
      case 'ping':
        return ok({
          pong: true,
          // 这里是 `pluginFiles.hostVersion()`，不是裸的 `hostVersion()`。
          //    裸的那个名字在本文件里根本不存在 —— 于是这一支一被调用就抛
          //    `ReferenceError`。
          //    而这个假后端全部的价值就是"它演的是同一件事" ——
          //      一句只在它身上不成立的协议，比没有它更坏。
          version: this._daemonVersion === null
            ? pluginFiles.hostVersion() : this._daemonVersion,
          time: nowSec(),
        });
      case 'whoami':     return this._whoami();
      case 'partitions': return ok({ partitions: this._partitions() });
      // 默认资源是按插件的，所以它跟 `plugins` 走（与守护进程逐字一致 ——
      // `partitions` 的应答里没有这个字段，见 op_partitions）。
      // 默认资源是站点设定的策略，客户端不推导 —— 假站点一律报 DEFAULTS，
      // 真实站点报它自己那份（每个插件可以不同，见 slurmate.conf.d/ 里它那一份）。
      //
      // 逐字段挑，不 `...p`：`surface` / `submitPubkey` / `login` 是客户端从
      //   清单里自己读的东西，服务端多报一份就是两份真相，而两份迟早会分叉。
      //   （真实守护进程的 op_plugins 也是这么收口的。）
      //
      //   `can_submit` 不违反上面那条：它说的是站点这一侧的事实（本站提交得出去
      //   吗），客户端无从推导 —— 见 pluginsView 里那段三态说明。
      //
      // 老守护进程根本没有这个 op，客户端拿到的是 unknown_op。这一态必须能造：
      // 那条路上每一个字段都是缺的，而"缺"必须与"否"分得开。
      case 'plugins': {
        if (this._noPluginsOp) return err(2, 'unknown_op', op);
        // ── 假站点的分发能力 ──
        //
        // 与守护进程逐字同一条纪律：`limits` 在 = 这个站点会分发；不在 = 老
        //   守护进程。客户端只看这个，不看"这次下没下下来"。
        //   `debugOldDaemon` 走的是上面那条 `unknown_op`，而这一条是更细的一档：
        //   有 `plugins` 却没有 `limits`（v0.5 的守护进程）。
        if (this._noDistribute) {
          // 这一档连 `problems` 也不发 —— 它是 v0.11 才有的字段，v0.5 的
          //   守护进程报不出来。少发它是这一档的全部意义（"字段缺席"这条路
          //   必须有人走），照发就等于演了一个不存在的版本。
          //
          // `defaults.time` 同理，而且这里逐字段挑（不用 `...DEFAULTS`）：
          //   那一格是 v0.11 才加进 `defaults` 的，v0.5 只报 cpus / mem。展开
          //   会把新字段顺手带上，于是"这一格缺席"这条路上一个用例都走不到 ——
          //   而界面恰恰必须能在它缺席时照常画出那句话。
          return ok({
            plugins: this._sitePlugins().map((p) => ({
              id: p.id, name: p.name, version: p.version, title: p.title,
              enabled: p.enabled, can_submit: p.can_submit,
              defaults: { cpus: DEFAULTS.cpus, mem: DEFAULTS.mem },
              // 这一档同样不发 `max_sessions`：v0.5 的守护进程没有这一格。
              //   理由与上面 `defaults.time` 那一条逐字相同 —— 缺席这条路必须
              //   有人走，照发就等于演了一个不存在的版本。
            })),
            enabled: this._sitePlugins().filter((p) => p.enabled).map((p) => p.name),
          });
        }
        return ok({
          plugins: this._sitePlugins().map((p) => ({
            id: p.id, name: p.name, version: p.version, title: p.title,
            enabled: p.enabled, can_submit: p.can_submit,
            // `gpus` 盖成这一站当下那一份（`debugDefaultGpus` 改的就是它）：
            //   直接 `...DEFAULTS` 的话，那个开关改了也传不下去，于是"配了默认卡"
            //   这条路上一个用例都走不到。
            // 每个插件一份（来自它自己的清单），`gpus` 盖成这一站当下那一份
            //   （`debugDefaultGpus` 改的就是它）。少了"每个插件一份"，那个
            //   开关改了也传不下去 —— 而真站点上它本来就是逐插件的。
            defaults: { ...p.defaults, gpus: this._defaultGpus },
            // 这个插件上每人最多几个会话（真站点那一格写在插件那一份配置里，
            //   见 `_sitePlugins`）。它是站点设的政策，客户端只读地显示。
            max_sessions: p.max_sessions,
            // `noPackage` 的那几条不带 `package` 这个键（见 _sitePlugins）。
            //   用 `delete` 之外的办法（展开）是因为这里在造一个新对象：
            //   挑字段而不是 `...p` 是有意的，见上面那段"逐字段挑"。
            ...(p.noPackage ? {} : (() => {
              const k = this._pkgOf(`${p.id}@${p.version}`);
              // 包在（打得出来）就是那个自述；打不出来（打包器不在、或包没了）
              //   就是 `null` —— 那是这一份此刻生产不出来，不是"本站没这个
              //   能力"。两者必须分得开，见 deliveryOf。
              return { package: k ? k.meta : null };
            })()),
          })),
          enabled: this._sitePlugins().filter((p) => p.enabled).map((p) => p.name),
          // ── 站点级的插件问题（账本 F22）───────────────────────────
          //
          // 那些没能加载的站点侧包与原因。真守护进程那边它是
          // `cfg.plugin_problems` 原样倒出来的一组字符串（`scan_plugins` 造），
          // 而它的形状是给终端的：多行、带站点上的路径。
          //
          // 假站点默认一个都报不出来 —— 它的分发源是仓库里那两个真插件，
          //   都装得好好的。要演这一格只能由用例造（`debugPluginProblems`），
          //   而造出来的字符串必须与真守护进程那几个分支的措辞同形，否则界面
          //   那一格被演的就不是真会发生的样子（〈夹具要比真集群脏〉）。
          problems: [...this._pluginProblems],
          // 假站点自报的那一组。用展开而不是逐字段写：这个对象与 DEMO_SITE_LIMITS
          //   必须是同一组数，写两遍就是两个会漂的东西。
          limits: { ...DEMO_SITE_LIMITS },
        });
      }
      /**
       * 整包一次发 —— 与守护进程的 `op_plugin_package` 同一个形状。
       *
       * 站点自述的那三个数（format/bytes/digest）不是判据，客户端会自己
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
      // 假后端不许有真站点没有的 op：一个"只在这个假后端里存在"的 op，
      //   比没有更糟 —— 它会让人以为真站点上还有那条路。
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
      case 'job_log':    return this._jobLog(req);
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
   * 让集群信息的某一格获取失败（`kind` 省略 = 全部）。
   *
   * 这一态必须能造出来：真集群上"获取失败"要么要等一次故障、要么要把 sinfo
   *   改名，而"把获取失败画成没有"正是这一整块最容易犯的错 —— 用户会去查一个
   *   不存在的问题（"为什么这台集群没有分区"）。
   */
  debugClusterMissing(kind) {
    this._clusterMissing = kind ? { [kind]: true } : {
      health: true, version: true, partitions: true, gres: true,
      nodes: true, queue: true, fairshare: true,
    };
    return Object.keys(this._clusterMissing);
  }

  /** 让 `sacct` 获取失败。它回的是错误，不是空列表 —— 两者不能混。 */
  debugHistoryDown(on = true) { this._historyDown = Boolean(on); }

  debugTunnelDown(ms = 15000) { this._tunnelDownUntil = Date.now() + ms; }

  /**
   * 让假站点假装这台机器上没有 bash。
   *
   * 作业侧是一段 shell 片段，而 Windows 上（以及 macOS 自带那个 bash 3.2 上）
   *   它跑不起来 —— 那句提示必须说得清"为什么"，而不是让作者去查自己的插件。
   * 而这个现场在开发/CI 机器上造不出来（那里一定有能用的 bash），
   *   于是那条失败路会变成一个没人跑过的分支（那句话对不对，谁也不知道）。
   *   这个开关就是让它跑得到。
   */
  debugNoBash(on = true) { this._noBash = Boolean(on); }
  /** 模拟作业被回收（比如心跳断了 30 分钟后被 scancel）。 */
  debugReap() {
    const live = this._occupying();
    if (!live.length) return false;
    // 全部收掉（不是"那一个"）。用例拿它
    //   制造"上一个会话已经走完了"的现场。
    for (const s of live) {
      this._clearTimers(s);
      // 回收 = 作业被 scancel 了，作业侧也要跟着停。漏了这一句的症状是
      //   "会话结束之后端口上还有人听着"，而下一条用例起同名会话时会撞端口。
      this._stopJob(s);
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

  /**
   * 这个插件上每人最多几个会话（真站点那一格是插件配置里的 `max_sessions`）。
   *
   * 没写进 `pluginMaxSessions` 的跟随 `maxActive`（真站点那一侧同样：
   *   插件那一份没写就跟随主配置的 `max_sessions_per_user`）。
   *
   * 解析只有这一处：`plugins` 应答里报出去的那个数与 `_submit` 拦的那个数
   *   必须是同一个 —— 分成两处写就会漂，而漂了的表现是"界面上写着 2、
   *   实际按 1 拦"（真守护进程那一侧是 `plugin_max_sessions()`，同一条纪律）。
   */
  _maxSessionsOf(name) {
    return this.pluginMaxSessions.has(name)
      ? this.pluginMaxSessions.get(name) : this.maxActive;
  }

  /** 按 session_id 找。找不到返回 null（调用方一律回 `not_found`）。 */
  _find(sid) {
    return this._sessions.find((s) => s.session_id === sid) || null;
  }
  /**
   * 让假站点"开了某个插件但本客户端不认识它"。
   *
   * 这是必须能演的一种情况：站点升级了、装了新插件，而用户的客户端还没升级。
   * 没有它，"未知服务"那条路在开发者模式下永远走不到，而那正是最需要用户看懂的一条
   * 提示（他该升级客户端，不是该找管理员）。
   *
   * 短名与显示名都可以不给（不给就用 DEMO_EXTRA_NAME）：那个调试按钮只关心
   *   "站点上多了一个本机不认识的插件"，不关心它叫什么 —— 而缺省值写在这里而不是
   *   写在调用点，是因为基座里不许出现任何真插件的名字，一个长在框架代码里的
   *   插件名正是"基座不认识任何插件"这句话的反例。
   */
  debugAddSitePlugin(name = null, title = null) {
    const short = name || DEMO_EXTRA_NAME;
    if (!this._extraSitePlugins.some((p) => p.name === short)) {
      // `noPackage`：这个站点不分发它。三态里那个 `undefined` 与 `null`
      //   （"此刻生产不出来"）是两件事，而这个假插件属于前者 —— 它压根没有包。
      //   两者今天的行为碰巧一样（都跳过），但把它们写成同一个形状，等于让这个
      //   假站点再也造不出那个区别。
      this._extraSitePlugins.push({ id: DEMO_EXTRA_ID, name: short, version: '1.0.0',
                                    title: title || short, enabled: true,
                                    can_submit: true, noPackage: true });
    }
  }
  /** 让假站点把某个插件关掉（站点装了但不允许用）。 */
  debugDisableSitePlugin(name) {
    this._siteDisabled.add(name);
    const e = this._extraSitePlugins.find((x) => x.name === name);
    if (e) { e.enabled = false; e.can_submit = false; }
  }
  /**
   * 让假站点报告「这个插件装了，但没有作业侧实现」。
   *
   * 与 `debugDisableSitePlugin` 是两件事，界面上的两句话也不同：那个说
   *   "本站没开放它，去找管理员"；这个说"本站装了它，但它没有作业侧实现"。
   *   合成一个开关的话，第四条分支永远走不到，而那句话是这次新加的。
   */
  debugSitePluginNoJob(name) {
    this._siteNoJob.add(name);
    const e = this._extraSitePlugins.find((x) => x.name === name);
    if (e) e.can_submit = false;
  }
  /** 让假站点装扮成不认识 `plugins` 这个 op 的老守护进程。 */
  debugOldDaemon(on = true) { this._noPluginsOp = on; }

  /**
   * 让假站点上每一条会话都显示成另一台电脑在看。
   *
   * 真集群上这一幕要两台机器才造得出来（在一台上开着，去另一台上打开），
   *   而「接管」这个按钮的全部意义就是那一刻 —— 它的判据（`keeper` 不是本机）
   *   与它成功之后那句「已接管」在开发者模式里必须能先看一遍。
   *
   * 关掉（`false`）时把会话行上那一格还原成它自己的值，而不是留一个刚造的
   *   假值 —— 否则"撤销"只是把别人的名字换成另一个别人的名字，而界面上看不出来。
   *
   * 传空串造的是第三种现场：没人在看（`keeper` 为空）。真集群上那一格
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
   * 让假站点报一个指定的基座版本（`ping` 的 `version`）。传 `null` 恢复成
   * "跟着本客户端走"。
   *
   * 版本握手那几态里，有两态只有这里能造：
   *   · `client_behind`（站点比客户端新，比如 0.9 对 0.7）—— 它是唯一会拦人的
   *     那一态，而真机上要造它得先让管理员升一次服务端；
   *   · `cross_major`（1.28 对 2.5）—— 用户举的就是这个例子。
   *   值原样透传（包括不合 x.y 形状的值）："答话的不像我们的守护进程"
   *   同样是必须能复现的一态。
   */
  debugDaemonVersion(v) {
    this._daemonVersion = (v === null || v === undefined) ? null : String(v);
  }

  /**
   * 让假站点装扮成「有 `plugins`、但没有 `limits`」的那一档（老守护进程
   * 没有分发能力）。
   *
   * 与 `debugOldDaemon` 是两件事，而客户端对它们的处理必须一样
   *   （都走回退），却又是两条不同的代码路径（一个 `unknown_op`，一个字段缺席）。
   *   只造其中一条的话，另一条上的退化没人看得见。
   */
  debugOldDistribute(on = true) { this._noDistribute = on; }

  /**
   * 让假站点报出站点级的插件问题（`op_plugins` 顶层的 `problems`，账本 F22）。
   *
   * 必须传参，这里没有默认值 —— 与 `debugForeignKeeper` 那种"不传就造一个
   *   演示值"的开关故意不同。理由是这一格说的是站点上的一个事实
   *   （"本站有个包坏了、坏在哪"），而假站点没有这个事实：它的分发源是仓库里
   *   那两个真插件，都装得好好的。给它编一条默认值，就是在界面上说一句关于一个
   *   不存在的站点的假话 —— 而这一格的全部价值恰恰是"让运维看到真的诊断"。
   *
   *   要演它，就从 DevTools 里 `window.slurmate.debug('plugin-problems', '…')`，
   *   串照 `cluster/slurmate-sessiond` 的 `scan_plugins()` 那几条分支的措辞写
   *   （多行、带站点上的路径 —— 界面那边是 `white-space: pre-wrap`，原样显示）。
   *
   * 传空数组 = 清掉。
   */
  debugPluginProblems(list) {
    this._pluginProblems = (list || []).map((s) => String(s));
  }

  /**
   * 让假站点报出这一站的默认 GRES（`op_plugins` 每项的 `defaults.gpus`）。
   *
   * 与 `debugPluginProblems` 同一条纪律：必须传参（`null` / 不传 = 清掉，
   *   也就是"本站没配"）。假站点没有"某个插件默认占几张卡"这个事实 ——
   *   真站点上它是每个插件一份的管理员声明，而这里只有一份全局的（见 DEFAULTS）。
   *   编一个默认值就等于演一个不存在的站点，而这一格的价值恰恰是让界面那句
   *   "默认 … / gpu:a6000 × 1"真的被画出来一次。
   *
   * 传进来的形状与协议一致：`{name, type, count}` 或 `null`。
   *   从 DevTools 里 `window.slurmate.debug('default-gpus', {name:'gpu', type:'a6000', count:1})`。
   */
  debugDefaultGpus(g) {
    this._defaultGpus = g && typeof g === 'object' ? { ...g } : null;
  }

  /**
   * 让某一份的包里多一个超过单文件上限的文件（造"这一份装不上"）。
   *
   * 它往包里加一个装不下的文件，而不是往某份清单里加一条 —— 客户端只在
   *   读包的时候执行那几条负载上限（`checkDeclared`），所以"站点报了一个
   *   装不下的东西"这件事本来就该发生在包里。
   */
  debugBloatPlugin(key = null) {
    this._bloatPlugin = key || [...this._siteIndex().keys()][0] || null;
    this._pkgCache.clear();          // 包是缓存出来的，改了负载就得重打
    return this._bloatPlugin;
  }

  /** 让接下来的 N 次 `plugin_package` 回 `rate_limited` —— 造限流。 */
  debugRateLimit(n = 3) { this._rateLimitBurst = n; }

  // 这里没有"就地换掉站点那个文件"的调试动作，虽然那是最想演的一条。
  //   原因很具体：假站点的分发源是仓库里的 `plugins/` —— 真文件。往那里
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
    this._noPacker = false;
    this._pkgCache.clear();
    this._rateLimitBurst = 0;
    // 「另一台电脑在看」那几个单向开关里唯一需要显式撤掉的一个：
    //   它改的是已有会话行上那一格（不是"以后新建的"），所以不撤掉的话
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
      // 与守护进程同形：判据是「这个账户查得到吗」。假站点这个账户是写死的
      //   常量，所以它恒为 true —— 真站点查不到时会报 false，界面据此拦住提交。
      //   假站点造不出那个现场，记在账本里。
      can_submit: true,
    });
  }

  /**
   * 假站点的集群现状（`op_cluster`）。
   *
   * 形状与守护进程逐字一致，包括"哪一格缺席"。这个假后端全部的价值就是
   *   它演的是同一件事 —— 一份只在它身上成立的协议比没有它更坏。
   *
   * 这里故意比真集群脏（同 GRES 那条注释的道理）：
   *   · 真集群上四个节点全是 `idle`/`mix`，没有一个带后缀 —— 于是
   *     "剥后缀、只按 base state 计数"这条路径在真机上根本走不到。
   *     这里给一个 `drain*`（不响应）、一个 `down~`（已关电）。
   *   · 队列里既有排队也有在跑，还有一个不是这两个的（`CG` 收尾中）——
   *     真集群上此刻全是 `PD`，那一支也走不到。
   *   · `me` 里有排队作业，于是"我排第几"算得出来。
   *
   * `debugClusterMissing` 能让任意一格缺席，因为"获取失败"与"确实没有"
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

  /** 最近几天的作业（`sacct`）。按需拉，不进任何缓存。 */
  _history() {
    if (this._historyDown) return err(6, 'history_unknown', '开发者模式：模拟获取历史失败');
    return ok({ history: HISTORY.map((h) => ({ ...h })), days: 7, limit: 30 });
  }

  /**
   * 作业日志的尾部。演的是同一件事 —— 与守护进程的 `op_job_log` 同一个形状：
   * 两份（`out` / `err`）、每一格是 `null`（没有这一份）或一个对象。
   *
   * 内容是作业侧真的写到那两个文件里的东西（宿主那一句 `exec 1>>…` 之后，
   *    服务进程继承的正是它们）。这让"边跑边刷"、"起不来为什么"、以及"服务说的
   *    原话"三件事同时成立 —— 而它们是这个假站点唯一值得存在的那条性质。
   *
   * 归属照 `_status`：找不到就 `3 not_found`。不带 `session_id` 同样是
   *   `not_found` —— 真守护进程那边没有"默认最新那条"这种缺省（日志是逐会话的），
   *   假站点要是给它一个，开发者模式里就会演出一件真集群上不会发生的事。
   */
  _jobLog(req) {
    const sid = req && req.session_id;
    const s = sid ? this._find(sid) : null;
    if (!s) return err(3, 'not_found');

    const cap = Math.max(1, Math.min(2000, Number(req && req.lines) || 200));
    const home = this._siteHome();
    if (!home) return ok({ out: null, err: null });
    const dir = path.join(home, '.slurmate', 'logs');

    // 这两个文件就是作业的日志 —— 宿主自己写的每一行、以及服务进程写的
    //    每一行，从产生那一刻起就落在它们上面（替身宿主开头那一句 `exec 1>>…`）。
    //    假站点不另记一份、也不编一行：右栏看到的就是那个服务说的话。
    //
    //    于是"边跑边刷"是真的（文件在长），"作业起不来了为什么"在跑着的时候
    //      就看得见，而作者看到的是自己进程的原话 —— 这三条从前一条都不成立
    //      （那时这里是每 2 秒编一行）。
    const cell = (p, all, at) => {
      const drop = Math.max(0, all.length - cap);
      const kept = all.slice(drop);
      return {
        path: p,
        bytes: all.reduce((n, x) => n + Buffer.byteLength(x, 'utf8') + 1, 0),
        lines: kept.length,
        truncated: drop > 0,
        mtime: at,
        text: kept.join('\n'),
        why: null,
      };
    };
    const one = (p) => {
      let text, st;
      try {
        st = fs.statSync(p);
        text = fs.readFileSync(p, 'utf8');
      } catch (e) {
        // 两种"读不到"必须分开，而它们在这一格上只差一个 `why`：
        //   · 文件不在就是 `null`。那是"确实没有这一份"（这个插件还没有作业侧，
        //     或者它一个字都还没说）—— 界面照实说"还没有输出"。
        //   · 文件在、读不出来（权限、被占着）就是一个带 `why` 的格子。那时说
        //     "没有输出"是在说一件不成立的事，而用户会去查那个不存在的输出。
        // 合成一个的后果正是这一版一直在清的那类：把"获取失败"说成"没有"。
        if (e && e.code === 'ENOENT') return null;
        return { path: p, bytes: 0, lines: 0, truncated: false,
                 mtime: null, text: null, why: `读取 ${p} 失败：${e.message}` };
      }
      const all = text.split('\n');
      if (all.length && all[all.length - 1] === '') all.pop();
      return cell(p, all, Math.floor(st.mtimeMs / 1000));
    };
    return ok({
      out: one(path.join(dir, `slurm-${s.job_id}.out`)),
      err: one(path.join(dir, `slurm-${s.job_id}.err`)),
    });
  }

  _partitions() {
    // 每一项都真的拷一份（含 GRES 那一格）：真实后端回的是刚解析出来的 JSON，
    // 谁都不与别人共享一个对象。这里共享的话，界面上一处手误的原地修改会同时
    // 改掉所有会话看到的那一份 —— 而那种 bug 在真集群上不会出现。
    // `mem_per_node_mb` 缺席时就真的不写这个键（`DEBUG` 那一项）：接口那一侧
    //   要看到的正是"这个键不在"，补一个 `undefined` 是两个不同的形状。
    return PARTITIONS.map((p) => {
      const d = { ...p, gres: p.gres.map((e) => ({ ...e })) };
      if (Number.isInteger(MEM_MB[p.name])) d.mem_per_node_mb = MEM_MB[p.name];
      return d;
    });
  }

  /**
   * 缺省分区：从该用户有权限的分区里随机挑一个。
   *
   * 为什么不是「不带 -p 交给 Slurm」：那样所有默认会话都会落在同一个默认分区，
   * 而用户明确要的是分散。随机挑的代价是用户事先不知道会落到哪种卡上 ——
   * 所以 `session_view` 里必须把实际落到的分区返回给界面显示出来。
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
    // 不写死缺省值。真实守护进程的缺省来自站点配置（`default_plugin`），
    //   没配就要求显式给；假后端没有配置可读，所以它照做同一件事：要求显式给。
    //   客户端在能解析出缺省插件时本来就会把它显式传上来。
    const kind = req && req.service_kind;
    if (!kind) {
      return err(2, 'bad_service_kind',
        '这个站点没有设缺省插件，提交时必须显式指定 service_kind');
    }
    // 按短名在假站点自己的清单里查 —— 假后端扮演的正是"一个站点"，而
    //   它演的那些插件都是它自己装的，短名不会撞（真站点允许撞，短名不再
    //   唯一了；见 `packer/docs/PLUGIN-SPEC.md` §2.2）。查不到就拒绝。
    //   这里刻意不实现真站点那套歧义规则：假后端的目的不是把站点的每一条
    //     纪律演一遍，而是让"没有集群时界面还能走通"。哪天它要演两个同名插件，
    //     那就在这里照 `resolve_plugin()` 补一次 —— 而不是现在给一个用不上的分支。
    const sitePlugin = this._sitePlugins().find((p) => p.name === kind);
    if (!sitePlugin) {
      return err(2, 'bad_service_kind', `未知的服务类型：${kind}`);
    }
    if (!sitePlugin.enabled) {
      return err(4, 'service_kind_disabled', `本站没有开放「${sitePlugin.title}」`);
    }
    // 中转站必须带公钥，且形状要对 —— 规则与守护进程的 parse_ssh_pubkey 逐字一致。
    //
    // 注释要允许并丢掉。客户端发上来的就是 OpenSSH 的一整行，而它天然带注释
    //   （`ssh-ed25519 AAAA… slurmate-20260915-1030`）。照着「68 个字符后必须结束」
    //   去写，会把客户端的公钥全部拒掉；而如果反过来原样收下，那个注释里的
    //   逗号会把 `--export=ALL,k=v,…` 劈成两个变量（守护进程那边这一步是真的，
    //   不是理论问题 —— 见 test-sessiond-logic.py 19.9）。
    // 判据是插件声明了什么，不是它叫什么名字 —— 与客户端框架同一条规矩。
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
    // 与真实守护进程一致：占着位置的（含排队中的）都算一个名额，
    // 上限来自配置键 `max_sessions_per_user`（`this.maxActive`）。
    const occ = this._occupying();
    if (occ.length >= this.maxActive) {
      return err(4, 'quota_active',
        `已经有 ${occ.length} 个会话占着位置（本站上限 ${this.maxActive}），`
        + '排队中的也算。结束一个再开下一个。');
    }
    // 这个插件自己的上限（真站点那一格是插件配置里的 `max_sessions`：没写就
    //   跟随全局，见 `_sitePlugins`）。两个上限都要过，与真站点同一条纪律。
    //
    // 放在全局那一道之后：真站点也是这个先后（全局那道在解析出插件之前就判了），
    //   而"两处都到了"时报全局那一句是对的 —— 它更宽，也更该先说。
    //
    // 按 `service_plugin` 的 id 前缀数（不是整个 `id@版本`）：站点升级插件之后，
    //   旧版本那条会话仍然占着这个名额。与真守护进程的 `count_occupying` 同一口径，
    //   包括它的那一处空白：恢复出来的会话没有 `service_plugin`，数不到任何插件头上。
    const cap = this._maxSessionsOf(sitePlugin.name);
    const held = occ.filter((s) => {
      const ref = typeof s.service_plugin === 'string' ? s.service_plugin : '';
      const at = ref.lastIndexOf('@');
      return at > 0 && ref.slice(0, at) === sitePlugin.id;
    }).length;
    if (held >= cap) {
      return err(4, 'quota_active',
        `「${sitePlugin.title}」上已经有 ${held} 个会话占着位置`
        + `（本站给这个插件的上限是 ${cap}），排队中的也算。结束一个再开下一个。`);
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
      if (!part) return err(6, 'partitions_unknown', '查询可用分区失败');
    }

    // 服务端填默认值并做上限钳制 —— 不信客户端送来的东西。
    const cpus = clampInt(req && req.cpus, DEFAULTS.cpus, 1, 64);
    // 内存那一格：与守护进程的 `sanitize_mem` 逐字同形。
    //   `--mem=0` 在 Slurm 里的含义是「该节点的全部内存」，不是零 —— 一个笔误
    //   会让开发会话吃掉整台机器。所以显式拒绝并回退，而回退必须报给用户
    //   （下面那条 `warning`）：他填了 0，以为生效了，实际拿到的是默认值。
    const memFix = sanitizeMem(req && req.mem, DEFAULTS.mem);
    const mem = memFix.mem;
    /** 服务端替用户做的那些决定。有的话要带出去 —— 静默地替他决定正是
     *  这个项目一路在清的那类问题。 */
    const warnings = [];
    if (memFix.fell) warnings.push(`内存参数无法识别，已改用 ${mem}。`);
    // GRES：与守护进程同一条规矩 —— 分区定下来之后再对账，因为上限是分区
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
      // 站点分配下去的候选端口（真守护进程那一格也是这么来的：它在登录节点
      // 上挑，够不着计算节点那一刻的端口占用）。真正交给作业的是其中实测过
      // 能绑上的那些（见 `_startJob`）。
      _candidates: fakeJob.nominalCandidates(),
      // 谁在看这条会话 —— 与真守护进程的 `op_submit(client_id)`
      //   同一个位置、同一个含义。提交这条连接的客户端就是它的第一个看护者；
      //   没有身份（CLI、老客户端），`null`，而 `null` 是合法状态：
      //   指的是"确实没人在看"，不是"不知道"。
      keeper: this._client ? this._client.id : null,
      service_kind: kind,
      // 会话的解析键：`<id>@<版本>`。守护进程在提交时从它自己那份插件
      //   清单里抄下来 —— 而"抄下来"是关键：站点之后升级了插件，这个字段
      //   仍然是提交那一刻那一版。作业侧跑的是那一版的代码，客户端这一半
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
      // 假站点必须有这个字段：没有的话客户端会走"老守护进程"那条退路，
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

    // ── 站点这一侧：把这个插件的作业侧真的跑起来 ────────────────────
    //
    // 真站点上这一步是 sbatch：作业在计算节点上挑端口、调 `start_<短名>`，服务的
    // 输出落在作业日志上，然后守护进程读会话文件把它登记进来。这里补的就是
    // 那一段（见 `fake-job.js`）—— 于是"点启动打开的那个页面"是这个插件自己
    // 的服务，右栏那些行是它自己说的话。
    //
    // 判据是 `surface`（"这个插件有一个网页界面"）：有界面的那一类真跑作业侧；
    //   没有界面的（中转站，以及调试开关造出来的那种"站点上有、本机不认识"的
    //   条目）不跑 —— 它们的隧道指向一个没有东西在监听的端口，主机公钥是一个
    //   编出来的值（记在账本 S40）。
    //
    //   这一道闸比"中转站"宽：`debugAddSitePlugin` 造的那些条目没有 `surface`，
    //     走的也是这条路（隧道接得上、会话登记得上），好几条用例靠的正是它。
    //     换成"这棵树里有没有作业侧"这条更准的判据之前，得先让那条调试开关
    //     造得出一棵真有作业侧的树 —— 见账本 S40。
    if (sitePlugin.surface) {
      this._startJob(sess, sitePlugin)
        .catch((e) => this._jobFailed(sess, `作业侧无法启动：${e.message}`));
    }

    // 登记那一步。它不再是无条件的：作业还没起来就再等一等（真守护进程每个
    // tick 都试一次，直到 `enroll_ttl` 到期）。
    sess._enrollTimer = setTimeout(() => this._enroll(sess), this.enrollDelayMs).unref?.();

    return ok({
      session_id: sid, job_id: sess.job_id, state: 'submitted',
      partition: part.name,
      resources: { cpus, mem, gres },
      // 这一格是守护进程分配的候选表（真守护进程也是这么来的：它在登录
      //   节点上挑，够不着计算节点那一刻的端口占用）。真正交给作业的是实测过
      //   能绑上的那几个（见 `_jobEnv`）—— 与真宿主逐条同形：分配是一件事，
      //   计算节点上那一趟 `port_free` 是另一件。
      candidates: sess._candidates,
      requested_time: '12:00:00',
      // 与服务端同形：有替用户做的决定就带一句出去（没有就不带这个键）。
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    });
  }

  // ── 作业侧（假站点真的跑它）─────────────────────────────────────────────

  /**
   * 起这一条会话的作业侧。调用方不 await —— 提交那条 RPC 立刻回 `submitted`
   * （真站点上 sbatch 回的正是"已提交"），作业那边跑它的。
   */
  async _startJob(sess, sitePlugin) {
    const home = this._siteHome();
    const entry = this._siteIndex().get(sess.service_plugin);
    if (!home || !entry) {
      this._jobFailed(sess, '假站点无法获取这个插件的作业目录（沙盒还没定下来？）');
      return;
    }
    const cands = await fakeJob.pickCandidates(sess._candidates);
    if (!cands.length) {
      this._jobFailed(sess, '无可用空闲端口（候选区间 '
        + `${fakeJob.PORT_MIN}–${fakeJob.PORT_MAX} 都被占着）`);
      return;
    }
    const logDir = path.join(home, '.slurmate', 'logs');
    fakeJob.pruneLogs(logDir);
    const job = new fakeJob.FakeJob({
      // 作业侧从站点那一侧那棵树里读。客户端从来不读它 —— "两半"就是这个意思。
      entry: path.join(entry.dir, ...pluginFiles.JOB_ENTRY.split('/')),
      env: this._jobEnv(sess, entry, cands, home),
      cwd: home,
      noBash: this._noBash,
      sessFile: path.join(home, '.slurmate', 'sessions', `job-${sess.job_id}.json`),
      outPath: path.join(logDir, `slurm-${sess.job_id}.out`),
      errPath: path.join(logDir, `slurm-${sess.job_id}.err`),
      onExit: (j) => this._jobEnded(sess, j),
    });
    sess._job = job;
    this._jobs.set(sess.session_id, job);

    const r = await job.start();
    if (!r.ok) { this._jobFailed(sess, r.why, r.exitCode); return; }
    // 登记那一步先到、作业后起来 —— 那时它留了个记号，这里补上。
    if (sess._waitingEnroll) { sess._waitingEnroll = false; this._enroll(sess); }
  }

  /**
   * 宿主给插件的环境（`docs/CONTRACT.md` §5.2）。
   *
   * 真站点上这一份是守护进程造的（它读站点配置、按插件的清单解析 bin），
   *   假站点在这一处把它们合起来 —— 分两个文件会让"起一个作业侧"散在两处，
   *   而这条路上只有一个读者（开发者模式）。
   *
   * 缺 `SLURMATE_GRES`：它在契约里是"带缺省"的那一档，作业侧只把它记进日志与
   *   会话文件、不做任何判断，而客户端没有那份串的拼法。见替身宿主的开头那一段。
   */
  _jobEnv(sess, entry, cands, home) {
    const env = {
      // 硬断言那四个（缺一个作业当场死）
      SLURMATE_SESSION_ID: sess.session_id,
      SLURMATE_CANDIDATES: cands.join(';'),
      SLURMATE_SERVICE_KIND: sess.service_kind,
      SLURMATE_AUTH_MODE: sess.auth_mode,
      // 带缺省的那一批
      SLURMATE_PARTITION: sess.partition,
      SLURMATE_CPUS: String(sess.resources.cpus),
      SLURMATE_MEM: sess.resources.mem,
      SLURMATE_PORT_MIN: String(fakeJob.PORT_MIN),
      SLURMATE_PORT_MAX: String(fakeJob.PORT_MAX),
      SLURMATE_PASSWORD_BYTES: '12',
      SLURMATE_SESS_DIR: path.join(home, '.slurmate', 'sessions'),
      SLURMATE_LOG_DIR: path.join(home, '.slurmate', 'logs'),
      // 作业号与节点名：真站点上由 Slurm 给。
      JOB_ID: String(sess.job_id),
      NODE: sess.node || 'localhost',
      // 家目录指到沙盒里那一处（见 `_siteHome`）：插件的 `start_*` 会往里写
      //   东西，而 `/home/demo` 在这台机器上不存在 —— 那会让一个没写错的插件
      //   在一个与它无关的原因上失败。uid/用户名跟着这个假站点自称的那一份
      //   （与 `whoami` 同源），否则会话文件里的 uid 与界面上的对不上。
      HOME: home,
      USER: this.user,
      LOGNAME: this.user,
      MY_UID: '1000',
      MY_USER: this.user,
    };
    // 插件专属那一个（`site.bin.env` 声明的名字，宿主不认识它）。
    const bin = fakeJob.resolvePluginBin(entry.manifest);
    if (bin) env[bin.env] = bin.value;
    return env;
  }

  /**
   * 登记这一步。判据是这个插件的作业侧起来了没有。
   *
   * 真守护进程每 2 秒的 tick 上做一次，判据是会话文件写着 running；
   *   还没起来就再等一个 tick（直到 `enroll_ttl` 到期才回收）。这里同形：
   *   作业还在起就留个记号，它起来时（`_startJob` 那个 then）补一次。
   */
  _enroll(sess) {
    if (sess.state !== 'submitted') return;              // 已经被别人收掉了
    const job = sess._job;
    if (job && !job.running) {
      if (job.state === 'starting') { sess._waitingEnroll = true; return; }
      return;                                            // 失败那一路已经收过尾了
    }
    sess.state = 'enrolled';
    sess.enrolled_at = nowSec();
    sess.node = sess.partition === '2080TI' ? 'node04' : 'node01';
    // 用字面 IPv4 —— tunnel.js 会用 net.isIPv4() 校验，这一步是真跑的。
    sess.node_ip = '127.0.0.1';
    if (job && job.running) {
      sess.service_port = job.port;
      // 口令是作业侧自己生成、写进会话文件的那一个（真站点上正是这么来的：
      //   宿主 `gen_password` 生成 → 导出给服务 → 写进会话文件 → 守护进程再给
      //   客户端）。从前这里是一个写死的假口令，而那个口令与隧道那头是谁无关。
      sess.auth_password = (job.info && job.info.auth_password) || null;
    } else {
      // 中转站那一类今天不跑作业侧，见 `_submit` 那一段与账本 S40。
      sess.service_port = DEMO_SSHD_PORT;
      sess.ssh_host_key = DEMO_HOST_KEY;
    }
    sess.tunnel_target = `127.0.0.1:${sess.service_port}`;
    sess.job_state = 'RUNNING';
    // 排队原因必须跟着清掉。真集群上跑起来的作业报的是 `Reason=None`
    //   （守护进程把它滤掉），不清的话开发模式里会显示
    //   「运行中 · 在等空闲资源」—— 一句自相矛盾的话，而它在真集群上不出现。
    sess.job_reason = null;
    this._emitState(true, '会话已登记');
  }

  /**
   * 服务自己没了，作业结束。
   *
   * 判据与真守护进程逐字同形（`phase_running`）：作业进了终态就释放会话，
   *   不管它是正常结束还是炸了。而"为什么"在日志里 —— 那正是作者要看的东西。
   */
  _jobEnded(sess, job) {
    if (['released', 'rejected', 'expired', 'releasing'].includes(sess.state)) return;
    this._stopJob(sess);
    this._endSession(sess, '服务退出了，作业随之结束',
      job && job.exitCode ? 'FAILED' : 'COMPLETED', job ? job.exitCode : null);
  }

  /** 作业侧没起来（起不来、或者起来的路上炸了）。会话不许判成功。 */
  _jobFailed(sess, why, code = null) {
    if (['released', 'rejected', 'expired', 'releasing'].includes(sess.state)) return;
    this._stopJob(sess);
    this._endSession(sess, why, 'FAILED', code);
  }

  /**
   * 收尾一个会话：`releasing` → `released`。
   *
   * 分两步、而且中间隔一下 —— 真守护进程释放一条会话就是这个样子（`begin_release`
   *   之后作业要先被确认停掉）。一步跳到 `released` 的话，界面上的「正在释放」
   *   那一格在开发者模式里一次都走不到，而那是用户真的会看到的一格。
   */
  _endSession(sess, note, jobState, exitCode) {
    this._clearTimers(sess);
    sess.state = 'releasing';
    sess.note = note;
    sess.tunnel_target = null;
    sess.job_state = jobState;
    sess.job_terminal = true;
    sess.job_exit_code = exitCode;
    sess.job_reason = null;
    sess._releaseTimer = setTimeout(() => {
      sess.state = 'released';
      this._emitState(false, '会话已释放');
    }, 1600).unref?.();
  }

  /**
   * 假站点上那个用户的家目录：沙盒里一处。
   *
   * 为什么不写死 `/home/demo`（`whoami` 报的那个）：插件的 `start_*` 会往家里
   *   写东西，而那台机器上没有 `/home/demo` —— 那会让一个没写错的插件在一个
   *   与它无关的原因上失败（"权限不够/目录不存在"），而作者会去改自己的代码。
   *   指到沙盒里，作业日志与会话文件就落在与真站点同形的相对位置上
   *   （`~/.slurmate/logs/slurm-<作业号>.out`），`op_job_log` 报的路径也就是真的。
   */
  _siteHome() {
    const root = this._jobsRoot();
    return root ? path.join(root, 'home') : null;
  }

  /** 把这一条会话的作业侧收掉（杀进程组）。幂等。 */
  _stopJob(sess) {
    const job = sess._job;
    if (!job) return;
    sess._job = null;
    this._jobs.delete(sess.session_id);
    job.stop().catch(() => { /* 收尾失败不该再掀波澜 */ });
  }

  _status(req) {
    const sid = req && req.session_id;
    // 不带 session_id 时回最新那条占着位置的 —— 与守护进程逐字一致。
    //   客户端要多会话走 `_list`（`tryReattach` 就是那样接回全部会话的）。
    const s = sid ? this._find(sid) : (this._occupying().slice(-1)[0] || null);
    if (sid && !s) return err(3, 'not_found');
    return ok({ session: s ? this._view(s) : null });
  }

  _list() {
    // 与守护进程的 `op_list` 逐字同形：`with_secret=False`，而且只回最后 50 条。
    //   秘密（口令、主机公钥）只走 `status` —— 那条路认的是会话号，而 list 回答
    //   的是「这台机器上都有什么」，两者不是一回事。多给一份秘密的后果是客户端
    //   养成「list 里就有口令」的假设，而真站点上那一格永远是空的。
    //   截断那 50 条也不是省事：少一个上界，客户端会拿着一个没有边的列表去画。
    return ok({
      sessions: this._sessions.slice(-LIST_MAX).map((s) => this._viewNoSecret(s)),
    });
  }

  /**
   * 心跳。判据与真守护进程的 `op_heartbeat` 逐档同构（见那一段的四档表）：
   *
   *   | 发心跳的连接 | keeper | 结果 |
   *   | 报了身份 | 空 | 接受，并认领 |
   *   | 报了身份 | 是我 | 接受 |
   *   | 报了身份 | 是别人 | 回 `ok` + `ignored`，什么都不动 |
   *   | 没报身份 | 任意 | 一律接受，keeper 不动 |
   *
   * 最后一行是承重的，别"收严"：没报身份的是 CLI 与更老的客户端，以及
   *   我们自己在常驻通道断掉之后的 exec 退路。假站点要是把它也挡掉，
   *   开发者模式里就会演出一件真集群上不会发生的事 —— 而假站点全部的价值
   *   就是它演的是同一件事。
   *
   * 也不认领没报身份的连接：`keeper` 写谁？没有名字就没人可写。
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
   * 【接管】：把这条会话的看护者换成我。一个字都不动会话。
   *
   * 与真守护进程的 `op_takeover` 同一条纪律（见那一段 docstring）：作业、ACL、
   * 端口、`last_hb_at`、`state` 一个都不动 —— 用户只是换了一台电脑看同一个
   * 作业。动了别的任何一个字，接管的语义就变成"结束并重开"。
   *
   * 没有身份不能接管（要把看护者写成谁？）—— 与心跳那条正好相反，
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
    // 别人那个"在看"要真的撤掉，否则下一次心跳还会被回 `ignored`。
    this._foreignKeeper = null;
    s.keeper = me;
    return ok({ session_id: s.session_id, keeper: me, was });
  }

  /**
   * 【临时离开】：把这几条会话的看护者置空。倒计时从这一刻起算。
   *
   * 与真守护进程的 `op_leave` 同一条纪律（见那一段 docstring）：
   *
   *   · 不校验身份 —— 它是一次放手，不是一次取得。要防的是"谁的作业被别人的
   *     心跳续了命"（那由 `_heartbeat` 管），而"我以为我不看了"这句话没有假冒的
   *     价值：它只能让作业更早被回收，且随时可以被下一个开始看它的客户端
   *     认领回去（认领那一支在 `_heartbeat` 里）。
   *   · 看护者本来就是空的，安静跳过 —— 那会被记成一次"放手"，而实际上
   *     什么都没发生。
   *   · 不加第二个超时窗口：这里只是置空，之后仍然走 suspect → orphaned →
   *     scancel 那一条（假站点里由 `debugReap` 演）。
   *
   * 覆盖层（`debugForeignKeeper`）跟着一起撤掉：它模拟的就是"服务端此刻
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
   * 这条会话现在的看护者：那一层覆盖（如果开着）优先，其次才是它自己那一格。
   *
   * 判空用的是 `!== null` 而不是真值 —— 覆盖值可以是空串，而那是一个
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
    // 只清这一条的定时器。清全部的话，另一条会话的登记定时器被清掉，
    //   它就永远停在 submitted —— 而界面上一切正常。
    this._clearTimers(s);
    // 真站点上这一步是 scancel：作业被杀，插件的服务跟着没了（那是同一件事的
    //   两端）。收在这里而不是等 released：那一刻作业侧就该停了。
    this._stopJob(s);
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
      // 真守护进程在这里说两件事，而且故意不说"作业还在跑"（它没有核对过
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
    // `active_sessions` 只数 `enrolled`（有 nft 规则的那些）—— 与守护进程一致，
    //   排队中的不算，否则体检会报"规则数与会话数不一致"。
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
   * 逐字段对齐守护进程的 session_view，包括「expires_at / job_state / time_limit
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
      // 谁在看 —— 一个 client_id，或者 null。取值只有这两种
      // （不是空串、不是 "unknown"），与守护进程那一格逐字同形。
      // 它是「接管」这个按钮的唯一判据，也是界面上「本机在看 / 另一台电脑
      //   在看 / 没人在看」那三句话的来源。
      keeper: this._effKeeper(s),
      tunnel_target: s.tunnel_target,
      // 与守护进程逐字一致：这个字段总是存在（可能是 null）。
      // null 的含义是「服务端也不知道」，客户端据此拒绝猜测该走哪条路 ——
      // 而"字段不存在"（更旧的守护进程）在客户端那边落到同一个答案：也不猜。
      service_kind: s.service_kind === undefined ? null : s.service_kind,
      // 与守护进程一致：也是总是存在（可能是 null）。null = 服务端不知道
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
      // 与守护进程一致：判定与状态一起来，客户端不做判定（见 jobstate.js）。
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
   * 推送那份视图：逐字等于 `_list` 给出的那一种。
   *
   * 守护进程的 `snapshot_for` 用的是 `session_view(s, with_secret=False)`，
   *   与 `op_list` 同构 —— 所以这里就是"先按 list 渲染，再把秘密摘掉"，
   *   而不是另写一份。另写一份的那天，推送的字段集与 list 的字段集就会分家，
   *   而症状是界面上某一格在有推送时是空的、没有推送时是满的。
   */
  _viewNoSecret(s) {
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
   * 调试开关"守护进程不可达"期间一条都不推 —— 否则那个开关只挡得住
   *   一问一答，挡不住推送，而开发者模式里就会出现"守护进程挂了、界面却还在
   *   自己更新"这种真集群上不存在的景象。
   */
  _sweepPush() {
    if (!this._connected) return;
    if (Date.now() < this._daemonDownUntil) return;
    const sessions = this._sessions.map((s) => this._viewNoSecret(s));
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
 * 框架对 GRES 数量的量级护栏。必须与守护进程的 `MAX_GRES_COUNT` 相等
 * （用例 `client/test/limits.test.mjs` 逐字比对两个文件里的这个数）——
 * 它不是站点策略：真实上限来自集群自己配了几个，由分区的 `per_node_max`
 * 给出。这一条只挡"一个天文数字"。
 */
const MAX_GRES_COUNT = 4096;

/**
 * `--gres` 的名字里允许出现的字符。与守护进程的 `GRES_FIELD_RE` 同一条规矩
 * （`:` 与 `,` 是 Slurm 自己的分隔符，不能出现在名字里）。
 */
const GRES_FIELD_RE = /^[A-Za-z0-9_]{1,32}$/;

/**
 * 把请求里的 GRES 与这个分区实际有的对一对。返回 `{gres}` 或 `{err}`。
 *
 * 逐条照着守护进程的 `clean_gres()` + `fit_gres()` 来。这个假后端的全部价值
 *   就是它演的是生产那条路：两处规则漂开的话，开发者模式里说得通的事在真机上
 *   会被拒（或反过来），而 `backend-fake.test.mjs` 只守得住字段名，守不住规则。
 * 上限从分区的清单来（`per_node_max`），不是写死一个 8 —— 与守护进程一样。
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

// 只导出真有人读的：`PARTITIONS` 不在这里，它只在本文件内被用
//   （测试要看分区表时走的是 `app:partitions` 那条真路，不是这个常量）。
module.exports = { FakeBackend, DEFAULTS,
  PUSH_INTERVAL_MS, PUSH_SWEEP_MS, DEMO_SITE_LIMITS };
