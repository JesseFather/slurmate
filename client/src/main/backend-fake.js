'use strict';
/**
 * backend-fake.js —— 演示后端。
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
 * 演示模式下界面要**醒目**标注「演示模式 · 未连接集群」，用真实模式绝不会出现的
 * 颜色。做了假后端却不标注，正是这个项目一路在清的那类问题：系统声称了不成立的事。
 *
 * ── 关于分区与资源 ─────────────────────────────────────────────────────────
 * 分区不再来自「用途」配置，而是**直接从 Slurm 查**（守护进程侧走
 * `scontrol show partition` 并与该用户的 association 求交）。所以这里的假数据
 * 就是一份分区表 —— 字段名必须与守护进程逐字一致，否则界面会针对错误的字段名
 * 开发，接上真集群才发现对不上。
 *
 * 默认资源（2 CPU / 8G）由**服务端**填，客户端不填。演示后端照做：
 * 请求里没给的键，就用 DEFAULTS。
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Backend, KIND } = require('./backend.js');
const { createDemoWebService } = require('./demo-server.js');
const pluginFiles = require('./plugins/index.js');

// 演示里"站点装了新插件"用的假 id。形状必须是合法 ULID（守护进程与客户端都会
// 校验），但没有任何东西会去核对它是不是真铸出来的 —— 也核对不了。
const DEMO_EXTRA_ID = '01M2JKM1M1M1M1M1M1M1M1M1M1';

/**
 * ── 演示站点的**整包**投递（默认关着）────────────────────────────────────────
 *
 * 真实的守护进程**两条投递方式都报**（`files` 与 `package`），客户端优先走包。
 * 演示站点默认只发 `files` —— 那是刻意的：两条路都要有东西在测，而默认关着的那
 * 一条（逐份取）正是已部署的 v0.6 站点走的、也是最容易在改动里悄悄烂掉的那条。
 * `debugPackages(true)` 把整包那条路打开。
 *
 * ★ 包是拿**仓库里那个打包器**（`packer/slurmate-packer.js`）现打的，不是手搓的
 *   字节：手搓一份就等于在演示里又实现了一遍容器格式，而它与真格式分家的那天，
 *   演示反而会说"一切正常"。打包器导出 `buildPackage`/`contentDigest`，够用了。
 *
 * ★ **签名钥匙由一个写死的种子推出来**，不是随机生成的。理由不是"简单"：
 *   客户端在用户第一次同意时会**钉住这把公钥**（§5.4），此后同一个 id 的每一份
 *   都必须由同一把钥匙签。每次进程启动换一把钥匙的话，第二次启动时那把钉子就会
 *   把演示站点自己的插件拒掉 —— 演示会坏在一个看起来像 bug 的地方。
 *   它是**演示数据**，不是密钥。
 */
const DEMO_PKG_SEED = Buffer.from('slurmate-demo-package-key-v1!!!!', 'utf8');
/** PKCS#8 里 Ed25519 私钥的头部（RFC 8410），后面接 32 字节种子。 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');


// ★ **演示站点报的插件 = 本机池里装了什么。**
//
//   以前这里写死两个插件（名字与 id 与客户端内建的那两份逐字相同）。基座不再
//   自带插件之后，那份写死就变成了一句谎话：它会让演示模式永远报着两个本机
//   根本没有的插件，于是满屏"本站有而本机没有"——一个**故意不带插件的基座**
//   看起来像坏了。
//
//   改成照实报告之后，演示模式反而成了「零插件」那个状态的验证手段：池空就
//   什么都画不出来（那正是要修的空态），装了就有。
//
//   真实站点的集合同样由 `op_plugins` 通报、客户端一个字都不该假定 —— 这一点
//   现在两边是同构的。
//
//   `_sitePluginsOf` 由 index.js 注入（它才知道池里有什么），默认空。
//
// ★ **分发接上来之后，演示站点多了一个独立的来源**：仓库里的 `<repo>/plugins/`。
//   这不是"为了演示好看"—— 它解决的是上一段那个注释自己留下的死角：站点报的就是
//   本机池里那些，于是「站点有而本机没有」这条**最重要的**路径在演示里永远走不到，
//   而演示模式恰恰是这个项目里唯一能造出那些状态的地方。
//
//   现在：站点从仓库里读**真文件**（真的 sha256、真的字节），客户端真的走一遍
//   下载 → 暂存校验 → 同意闸 → 换入。池空 + 开发者模式关着的时候，界面上是
//   「本站要给你两个插件，但都还没经过你的同意」—— 那是一条真话。
//
//   打包之后没有仓库目录，`_sitePluginDir` 返回 null，站点回落到只报池里那些
//   （`files` 缺席 ⇒ 客户端按"这个站点不分发插件"处理）。这一条要写在界面上。

// 演示用的分区表。取的是通用 GPU 型号名，不是任何特定集群的配置。
// 故意留一个 allowed:false 的，好让「没权限的分区要禁用并说明原因」这条路径
// 在演示模式下也走得到。
const PARTITIONS = [
  { name: '2080TI',  allowed: true,  is_default: true, max_time: '183-00:00:00' },
  { name: 'A6000',   allowed: true,  max_time: '183-00:00:00' },
  { name: 'RTX8000', allowed: true,  max_time: '183-00:00:00' },
  { name: 'DEBUG',   allowed: false, reason: '你的账户没有该分区的权限', max_time: '1:00:00' },
];

/** 服务端默认资源。客户端**不填**这些值 —— 缺省由服务端决定。 */
const DEFAULTS = { cpus: 2, mem: '8G' };

const DEFAULT_TIME_SECONDS = 12 * 3600;
const DEMO_PASSWORD = 'demo-1a2b3c4d5e6f7081';  // 固定值，方便你手动 curl 验证

/** 演示里「作业内 sshd」听在哪个端口。**没有真的 sshd** —— 见 _submit 的说明。 */
const DEMO_SSHD_PORT = 55901;
/**
 * 演示用的主机公钥。**这不是一把真钥匙** —— 只是一串形状正确的 base64。
 * 客户端会把它写进 known_hosts（形状校验是真的），但演示里那个端口后面没有
 * 任何东西在监听，所以 `ssh slurmate` 会在连接阶段就失败。这是诚实的：
 * 演示模式假掉的从来不只是 SSH 那一跳，而这里连那一跳后面的 sshd 也是假的。
 */
const DEMO_HOST_KEY = 'ssh-ed25519 ' + 'A'.repeat(68);

/** 演示站点自称的单文件上限。**故意与守护进程那个默认值一样** —— 免得演示里
 *  一个 200 KiB 的文件在真机上通不过。故意报得**比客户端硬上限宽松**，好让
 *  "服务端只能收紧、客户端取更严的那个"这条在演示里也走得到。 */
const DEMO_FILE_BYTES = 512 * 1024;

/** 一份字节的 sha256。演示后端自己也算一遍，不看清单里那个自称的值。 */
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

class FakeBackend extends Backend {
  /**
   * @param {object} opts
   *   enrollDelayMs  {number}  'submitted' → 'enrolled' 的延迟，默认 8000（真实集群上
   *                            这个等待可能是 30–60 秒，因为 NFS 属性缓存默认 60s）
   *   rpcLatencyMs   {number}  每次 RPC 的人为延迟，默认 40（贴近真实的 exec channel 开销）
   *   user           {string}  演示用户名
   *   pickPartition  {function} 覆盖随机挑分区的行为，仅供测试固定结果用
   */
  constructor(opts = {}) {
    super();
    this.kind = KIND.DEMO;
    this.label = '演示后端';
    this.enrollDelayMs = Number.isFinite(opts.enrollDelayMs) ? opts.enrollDelayMs : 8000;
    this.rpcLatencyMs = Number.isFinite(opts.rpcLatencyMs) ? opts.rpcLatencyMs : 40;
    this.user = opts.user || 'demo';
    this._pickPartition = typeof opts.pickPartition === 'function' ? opts.pickPartition : null;

    this._server = null;
    this._session = null;        // 当前的会话对象
    this._seq = 0;
    this._enrollTimer = null;
    this._releaseTimer = null;

    // 调试开关 —— 由调试面板驱动，用来复现真机上极难复现的状态
    this._daemonDownUntil = 0;
    this._tunnelDownUntil = 0;
    this._connected = false;
    /** 调试用：站点多出来的插件（模拟"站点升级了、客户端没跟上"）。 */
    this._extraSitePlugins = [];
    /**
     * 演示站点**装了**哪些插件 —— 由 index.js 传进来（它才知道池里有什么）。
     * 返回 `{id, name, version, displayName}` 的数组。
     */
    this._sitePluginsOf = typeof opts.sitePlugins === 'function' ? opts.sitePlugins : () => [];
    /**
     * 演示站点的**分发源**：仓库里的 `plugins/` 目录。
     *
     * 传函数而不是路径 —— 打包之后那个目录不存在，而"不存在"必须是**每次现算**
     * 的结果（从源码跑与从安装包跑是两个事实）。
     */
    this._sitePluginDir = typeof opts.sitePluginDir === 'function'
      ? opts.sitePluginDir : () => null;
    /** 调试用：让站点报一个**超过单文件上限**的文件。/ 让某个文件报错。 */
    this._bloatPlugin = null;
    /** 调试用：让站点在 `plugin_file` 上回 rate_limited 若干次。 */
    this._rateLimitBurst = 0;
    /** 演示站点里被"关掉"的插件（按短名）。原本是直接改那个写死的数组。 */
    this._siteDisabled = new Set();
    /**
     * 演示站点里**装了但没有作业侧实现**的插件（按短名）。
     *
     * ★ 默认是空的：一个正常部署的站点，装了的插件就有作业脚本。这个集合是**故意
     *   造**那第四格状态的开关。真机上那件事来自 `deploy.sh` 有没有为这个插件生成
     *   `<ULID>.sbatch`，**客户端看不见** —— 所以它只可能由站点侧合成后报下来
     *   （`op_plugins` 的 `can_submit`）。
     */
    this._siteNoJob = new Set();
    /** 演示「守护进程太旧，根本没有 plugins 这个 op」。见 _dispatch。 */
    this._noPluginsOp = false;
    /** 演示「有 plugins 这个 op，但不会发文件」（v0.5 的守护进程）。 */
    this._noDistribute = false;
    /** 演示**整包投递**（默认关：逐份那条路要有东西在测，见 DEMO_PKG_SEED 那段）。 */
    this._packages = false;
    /** 演示"站点只发包、不发文件"（v0.8 的形状：`files` 那条路被删掉之后）。 */
    this._hideFiles = false;
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
   * 演示站点当前报出去的插件清单。
   *
   * ★ 每次现算，不缓存：用户可以在演示进行中装/卸插件，而站点"看到"的东西
   *   应该跟着变 —— 这正是真实的 `op_plugins` 的行为。
   */
  /**
   * 演示站点的**分发索引**：`(id@版本) → {dir, files}`，来自仓库里的 `plugins/`。
   *
   * ★ 建一次就**不再失效** —— 与守护进程侧那个"启动快照"索引逐字同一个语义
   *   （见 `cluster/slurmate-sessiond` 的 `plugin_index`）。这样演示模式也能演
   *   "管理员就地换了文件"那件事：清单与文件永远描述**同一棵树**。
   */
  _siteIndex() {
    if (this._indexCache) return this._indexCache;
    const cache = new Map();
    const base = this._sitePluginDir();
    if (base) {
      let names = [];
      try { names = fs.readdirSync(base).sort(); } catch { names = []; }
      for (const n of names) {
        const dir = path.join(base, n);
        try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
        let mf;
        try {
          mf = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
        } catch { continue; }                       // 坏清单：站点不报它（与守护进程一致）
        if (!mf || typeof mf.id !== 'string' || typeof mf.version !== 'string') continue;
        let files;
        try {
          // 只报**普通文件**：符号链接与空目录不进清单（客户端没法原样重建一个链接，
          // 而清单只描述文件）。这与守护进程的 `plugin_file_index` 是同一个口径。
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

  _sitePlugins() {
    // ── 分发源：仓库里的真文件 ──
    const distributed = [...this._siteIndex().entries()].map(([key, v]) => ({
      id: key.slice(0, key.lastIndexOf('@')),
      version: key.slice(key.lastIndexOf('@') + 1),
      name: v.name,
      title: v.title,
      // ★ "只发包、不发文件"那一档：`files` 缺席（不是 `null` —— `null` 在协议里
      //   是"这一份此刻生产不出来"，两者不是一件事）。
      files: this._hideFiles ? null : (this._bloatPlugin === key
        ? [...v.files, { path: 'bloat.bin', size: 999999, sha256: 'f'.repeat(64) }]
        : v.files),
      enabled: !this._siteDisabled.has(v.name),
      can_submit: !this._siteDisabled.has(v.name) && !this._siteNoJob.has(v.name),
      surface: v.surface, submitPubkey: v.submitPubkey, login: v.login,
    }));
    // ── 池里那些**没被仓库覆盖**的（打包版没有仓库目录，演示池就是唯一来源）──
    const known = new Set(distributed.map((p) => p.id));
    const installed = this._sitePluginsOf().filter((p) => !known.has(p.id)).map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      title: p.displayName || p.name,
      // ★ 没有 `files` = **这个站点不分发这一份**。客户端据此把它算进
      //   「站点有而本机没有」，而不是当成一次下载失败。
      files: null,
      enabled: !this._siteDisabled.has(p.name),
      // ★ 与真实守护进程逐字同一个合成方式：`enabled and needs_job`。**服务端才是
      //   同时知道这两件事的那一方** —— 让客户端自己拿 enabled 去推，就多出一份
      //   会漂的推理，而多出来的那一位（有没有作业侧）客户端根本看不见。
      can_submit: !this._siteDisabled.has(p.name) && !this._siteNoJob.has(p.name),
      // ★ 内部用（决定起不起本地 HTTP 服务、要不要公钥、界面与登录契约是什么）。
      //   **不进 `plugins` 响应** —— 那两个字段是客户端从清单里自己读的，
      //   服务端多报一份就是两份真相。见下面的 case 'plugins'。
      surface: p.surface || null,
      submitPubkey: Boolean(p.submitPubkey),
      login: p.login || null,
    }));
    return [...distributed, ...installed, ...this._extraSitePlugins];
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
    this._emitState(true, '演示后端已就绪');
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
    };
  }

  async close() {
    this._clearTimers();
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
        '无法连接 Slurmate 守护进程（/run/slurmate-session/ctl.sock）：演示模式模拟');
    }

    switch (op) {
      // 版本号这里写的是一个**明显是假**的值：演示后端不是任何一版守护进程，
      // 报一个真版本号会让人以为"我连上 0.6 了"。形状跟着框架版本走（x.y），
      // 免得有人照着它去写解析。
      case 'ping':       return ok({ pong: true, version: '0.6-demo', time: nowSec() });
      case 'whoami':     return this._whoami();
      case 'partitions': return ok({ partitions: this._partitions() });
      // 默认资源是**按插件**的，所以它跟 `plugins` 走，不再挂在 `partitions` 上
      //（与守护进程逐字一致 —— 那个字段已经删掉了，见 op_partitions）。
      // 默认资源是**站点设定的策略**，客户端不推导 —— 演示站点一律报 DEFAULTS，
      // 真实站点报它自己那份（每个插件可以不同，见 slurmate.conf 的插件块）。
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
        // ── 演示站点的**分发能力** ──
        //
        // ★ 与守护进程逐字同一条纪律：`limits` 在 = 这个站点会发文件；不在 = 老
        //   守护进程。客户端**只看这个**，不看"这次下没下下来"。
        //   `debugOldDaemon` 走的是上面那条 `unknown_op`，而这一条是更细的一档：
        //   有 `plugins` 却没有 `limits`（v0.5 的守护进程）。
        if (this._noDistribute) {
          return ok({
            plugins: this._sitePlugins().map((p) => ({
              id: p.id, name: p.name, version: p.version, title: p.title,
              enabled: p.enabled, can_submit: p.can_submit, defaults: { ...DEFAULTS },
            })),
            enabled: this._sitePlugins().filter((p) => p.enabled).map((p) => p.name),
          });
        }
        return ok({
          plugins: this._sitePlugins().map((p) => ({
            id: p.id, name: p.name, version: p.version, title: p.title,
            enabled: p.enabled, can_submit: p.can_submit, defaults: { ...DEFAULTS },
            // `files: null` 的那几条**不带这个字段**（见 _sitePlugins 的说明）。
            ...(Array.isArray(p.files) ? { files: p.files } : {}),
            // ★ 两条投递方式**同时**报（真实守护进程也是这么做的）：老客户端只看
            //   `files`，新客户端优先 `package` —— 两边都不用认一个新字段。
            ...(this._packages ? (() => {
              const k = this._pkgOf(`${p.id}@${p.version}`);
              return k ? { package: k.meta } : { package: null };
            })() : {}),
          })),
          enabled: this._sitePlugins().filter((p) => p.enabled).map((p) => p.name),
          limits: {
            file_bytes: DEMO_FILE_BYTES, total_bytes: 1 << 20, max_files: 256,
            // 链路那一笔账（base64 之后要装得进一条应答），只在会发包的时候才有意义。
            ...(this._packages ? { package_bytes: 4 << 20 } : {}),
          },
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
        if (!this._packages || this._noDistribute || this._noPluginsOp) {
          return err(2, 'unknown_op', op);
        }
        if (this._rateLimitBurst > 0) {
          this._rateLimitBurst -= 1;
          return err(7, 'rate_limited', '演示模式：故意打满限流桶');
        }
        const pkg = this._pkgOf(`${req.id}@${req.version}`);
        if (!pkg) return err(3, 'plugin_unknown', `${req.id}@${req.version}`);
        return ok({ format: pkg.meta.format, bytes: pkg.meta.bytes, digest: pkg.meta.digest,
                    data: pkg.buf.toString('base64') });
      }
      // 一份一份取。**与守护进程同一个口径**：`path` 只是那张索引表的键，
      // 它绝不参与拼路径 —— 于是"路径穿越"这个词从等式里消失，而不是被过滤掉。
      case 'plugin_file': {
        if (this._noDistribute || this._noPluginsOp) return err(2, 'unknown_op', op);
        if (this._rateLimitBurst > 0) {
          this._rateLimitBurst -= 1;
          return err(7, 'rate_limited', '演示模式：故意打满限流桶');
        }
        const key = `${req.id}@${req.version}`;
        const entry = this._siteIndex().get(key);
        if (!entry) return err(3, 'plugin_unknown', `演示站点没有 ${key} 这个插件`);
        const hit = entry.files.find((f) => f.path === req.path);
        if (!hit) return err(3, 'plugin_file_unknown', String(req.path));
        if (hit.size > DEMO_FILE_BYTES) {
          return err(4, 'plugin_file_too_large',
            `${hit.path} 有 ${hit.size} 字节，超过本站的单文件上限 ${DEMO_FILE_BYTES} 字节。`);
        }
        let data;
        try {
          data = fs.readFileSync(path.join(entry.dir, ...hit.path.split('/')));
        } catch (e) {
          return err(3, 'plugin_file_unknown', hit.path);
        }
        // ★ 索引是**启动快照**（见 _siteIndex），所以"管理员就地换了文件"在这里
        //   有了名字。把对不上的字节发出去就等于谎报 —— 客户端拿到的内容会与
        //   清单里那份声明永远不一致，而症状是一句说不清的"校验失败"。
        if (data.length !== hit.size || sha256(data) !== hit.sha256) {
          return err(9, 'plugin_file_changed',
            `${hit.path} 在演示站点启动之后被换过。请重新同步一次。`);
        }
        return ok({ path: hit.path, size: hit.size, sha256: hit.sha256,
                    data: data.toString('base64') });
      }
      case 'submit':     return this._submit(req);
      case 'status':     return this._status(req);
      case 'list':       return this._list();
      case 'heartbeat':  return this._heartbeat(req);
      case 'goodbye':    return this._goodbye(req);
      case 'doctor':     return this._doctor();
      default:           return err(2, 'unknown_op', op);
    }
  }

  /** 建立到目标的数据通道。演示里目标就是本地的那个假 code-server。 */
  dial(host, port) {
    return new Promise((resolve, reject) => {
      if (Date.now() < this._tunnelDownUntil) {
        reject(new Error('演示模式：隧道被手动断开'));
        return;
      }
      const sock = net.connect(port, host);
      sock.once('connect', () => resolve(sock));
      sock.once('error', reject);
    });
  }

  // ── 调试面板用的控制 ────────────────────────────────────────────────────
  debugDaemonDown(ms = 20000) { this._daemonDownUntil = Date.now() + ms; }
  debugTunnelDown(ms = 15000) { this._tunnelDownUntil = Date.now() + ms; }
  /** 模拟作业被回收（比如心跳断了 30 分钟后被 scancel）。 */
  debugReap() {
    if (!this._session) return false;
    this._clearTimers();
    this._session.state = 'released';
    this._session.tunnel_target = null;
    this._emitState(false, '会话已被回收');
    return true;
  }
  /**
   * 让演示站点"开了某个插件但本客户端不认识它"。
   *
   * 这是**必须能演**的一种情况：站点升级了、装了新插件，而用户的客户端还没升级。
   * 没有它，"未知服务"那条路在演示模式下永远走不到，而那正是最需要用户看懂的一条
   * 提示（他该升级客户端，不是该找管理员）。
   */
  debugAddSitePlugin(name, title = null) {
    if (!this._extraSitePlugins.some((p) => p.name === name)) {
      this._extraSitePlugins.push({ id: DEMO_EXTRA_ID, name, version: '1.0.0',
                                    title: title || name, enabled: true,
                                    can_submit: true });
    }
  }
  /** 让演示站点把某个插件**关掉**（站点装了但不允许用）。 */
  debugDisableSitePlugin(name) {
    this._siteDisabled.add(name);
    const e = this._extraSitePlugins.find((x) => x.name === name);
    if (e) { e.enabled = false; e.can_submit = false; }
  }
  /**
   * 让演示站点报告「这个插件装了，但没有作业侧实现」。
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
  /** 让演示站点装扮成**不认识 `plugins` 这个 op** 的老守护进程。 */
  debugOldDaemon(on = true) { this._noPluginsOp = on; }

  /**
   * 让演示站点装扮成「有 `plugins`、但没有 `limits`」的那一档 —— 文件分发是
   * v0.6 才有的能力。
   *
   * ★ 与 `debugOldDaemon` 是**两件事**，而客户端对它们的处理**必须一样**
   *   （都走回退），却又是两条不同的代码路径（一个 `unknown_op`，一个字段缺席）。
   *   只造其中一条的话，另一条上的退化没人看得见。
   */
  debugOldDistribute(on = true) { this._noDistribute = on; }

  /** 让演示站点报一个**超过单文件上限**的文件（造"这份装不上"）。 */
  debugBloatPlugin(key = null) {
    this._bloatPlugin = key || [...this._siteIndex().keys()][0] || null;
    return this._bloatPlugin;
  }

  /** 让接下来的 N 次 `plugin_file` 回 `rate_limited` —— 造限流。 */
  debugRateLimit(n = 3) { this._rateLimitBurst = n; }

  /**
   * 让演示站点**也**用整包投递（默认关着，见 DEMO_PKG_SEED 那一段）。
   *
   * ★ 两条路都要有东西在测，所以默认**关**：逐份取那条路是已部署的 v0.6 站点走
   *   的，也是最容易在改动里悄悄烂掉的一条。打开它则走包那条 —— 包括验签与
   *   钉钉子（§5.4），那两件事**只有包那条路上才有**。
   */
  debugPackages(on = true) { this._packages = on; }

  /**
   * 演示"站点**只发包、不发文件**" —— v0.8 的形状（`files` 那条路被删掉之后）。
   *
   * ★ 与 `debugPackages` 是**两件事**，而且必须能分开造：前者是"多发一条路"，
   *   这个是"少发一条路"。合成一个开关的话，客户端在"站点只会发包"时的表现
   *   （比如"这个站点愿不愿意发这一份"那句话）永远走不到。
   */
  debugHideFiles(on = true) { this._hideFiles = on; }

  // ★ 这里**没有**"就地换掉站点那个文件"的调试动作，虽然那是最想演的一条。
  //   原因很具体：演示站点的分发源是**仓库里的 `plugins/`** —— 真文件。往那里
  //   写一个字节等于改用户的仓库，而那是一个调试开关绝不该有的副作用。
  //   那条路径（`9 plugin_file_changed`）由集群侧自己的用例覆盖，见
  //   `cluster/test-sessiond-logic.py` 的 19.11。

  debugReset() {
    this._daemonDownUntil = 0;
    this._tunnelDownUntil = 0;
    this._extraSitePlugins.length = 0;
    this._siteDisabled.clear();
    this._siteNoJob.clear();
    this._noPluginsOp = false;
    this._noDistribute = false;
    this._packages = false;
    this._hideFiles = false;
    this._bloatPlugin = null;
    this._rateLimitBurst = 0;
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

  _partitions() {
    return PARTITIONS.map((p) => ({ ...p }));
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
    //   没配就要求显式给；演示后端没有配置可读，所以它照做同一件事：要求显式给。
    //   客户端在能解析出缺省插件时本来就会把它显式传上来。
    const kind = req && req.service_kind;
    if (!kind) {
      return err(2, 'bad_service_kind',
        '这个站点没有设缺省插件，提交时必须显式指定 service_kind');
    }
    // ★ 按**短名**在演示站点自己的清单里查 —— 短名只在站点内唯一，而演示后端
    //   扮演的正是"一个站点"。查不到就拒绝。
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
      return err(9, 'internal', '演示后端尚未 connect()，本地服务未启动');
    }
    if (this._session && !['released', 'rejected', 'expired'].includes(this._session.state)) {
      // 与真实守护进程一致：max_active_per_user = 1
      return err(4, 'quota_active', '已有 1 个活跃会话（上限 1）');
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
    const gpus = req && req.gpus !== undefined && req.gpus !== null ? clampInt(req.gpus, 0, 0, 8) : null;

    const sid = 'demo-' + String(++this._seq).padStart(4, '0')
              + Math.random().toString(16).slice(2, 10);
    const now = nowSec();

    this._session = {
      session_id: sid,
      job_id: 5700 + this._seq,
      state: 'submitted',
      partition: part.name,
      account: 'myaccount',
      resources: { cpus, mem, gpus },
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
      time_limit: '12:00:00',
      expires_at: now + DEFAULT_TIME_SECONDS,
    };

    this._enrollTimer = setTimeout(() => {
      if (!this._session || this._session.session_id !== sid) return;
      this._session.state = 'enrolled';
      this._session.enrolled_at = nowSec();
      this._session.node = part.name === '2080TI' ? 'node04' : 'node01';
      // 演示里 tunnel_target 指向本地的假 code-server（中转站则指向一个**没有
      // 东西在监听**的端口 —— 那边真正的 sshd 假不出来，见 DEMO_HOST_KEY）。
      // 用字面 IPv4 —— tunnel.js 会用 net.isIPv4() 校验，这一步是真跑的。
      this._session.node_ip = '127.0.0.1';
      const relay = this._session.site_pubkey;
      this._session.service_port = relay
        ? DEMO_SSHD_PORT : (this._server ? this._server.port : 0);
      this._session.tunnel_target = `127.0.0.1:${this._session.service_port}`;
      if (relay) {
        this._session.ssh_host_key = DEMO_HOST_KEY;
      } else {
        this._session.auth_password = DEMO_PASSWORD;
      }
      this._session.job_state = 'RUNNING';
      this._emitState(true, '会话已登记');
    }, this.enrollDelayMs).unref?.();

    return ok({
      session_id: sid, job_id: this._session.job_id, state: 'submitted',
      partition: part.name,
      resources: { cpus, mem, gpus },
      candidates: [55101, 55102, 55103, 55104, 55105, 55106],
      requested_time: '12:00:00',
    });
  }

  _status(req) {
    const sid = req && req.session_id;
    if (!this._session) return ok({ session: null });
    if (sid && this._session.session_id !== sid) return err(3, 'not_found');
    return ok({ session: this._view(this._session) });
  }

  _list() {
    return ok({ sessions: this._session ? [this._view(this._session)] : [] });
  }

  _heartbeat(req) {
    const sid = req && req.session_id;
    if (!this._session || this._session.session_id !== sid) return err(3, 'not_found');
    this._session.last_hb_at = nowSec();
    if (this._session.state === 'suspect') this._session.state = 'enrolled';
    return ok({ state: this._session.state, at: nowSec() });
  }

  _goodbye(req) {
    const sid = req && req.session_id;
    if (!this._session || this._session.session_id !== sid) return err(3, 'not_found');
    if (['released', 'rejected', 'expired'].includes(this._session.state)) {
      return ok({ state: this._session.state });
    }
    this._clearTimers();
    this._session.state = 'releasing';
    this._session.note = 'goodbye';
    // 真实守护进程会回 releasing，然后下一个 tick（最多 2 秒）才置 released。
    // 演示照做 —— 界面必须把「正在释放」和「已结束」当成两个状态，
    // 因为 scancel 有可能静默失败（见 docs/KNOWN-ISSUES.md 的 F12 / F13）。
    this._releaseTimer = setTimeout(() => {
      if (!this._session) return;
      this._session.state = 'released';
      this._session.tunnel_target = null;
      this._emitState(false, '会话已释放');
    }, 1600).unref?.();
    return ok({ state: 'releasing' });
  }

  _doctor() {
    return ok({
      socket: true, table: true, rules_readable: true,
      rules_count: this._session && this._session.state === 'enrolled' ? 1 : 0,
      active_sessions: this._session && this._session.state === 'enrolled' ? 1 : 0,
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
   * 演示里也照样可能缺。
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
      tunnel_target: s.tunnel_target,
      // 与守护进程逐字一致：这个字段**总是**存在（可能是 null）。
      // null 的含义是「服务端也不知道」，客户端据此**拒绝猜测**该走哪条路 ——
      // 而"字段不存在"是另一回事（老守护进程），那时按标了 legacyDefault 的
      // 那个插件兜底（本机没装它就只解释、不动作）。
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
    }
    // 口令只在 ACL_STATES 才返回（真实行为）—— 演示也照做，
    // 这样界面不会养成「任何时候都能读到口令」的错误假设。
    if (['enrolled', 'suspect', 'orphaned', 'releasing'].includes(s.state) && s.auth_password) {
      d.auth_password = s.auth_password;
    }
    return d;
  }

  _clearTimers() {
    if (this._enrollTimer) { clearTimeout(this._enrollTimer); this._enrollTimer = null; }
    if (this._releaseTimer) { clearTimeout(this._releaseTimer); this._releaseTimer = null; }
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

module.exports = { FakeBackend, PARTITIONS, DEFAULTS, DEMO_PASSWORD };
