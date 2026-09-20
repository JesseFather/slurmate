'use strict';
/**
 * session.js —— 会话编排与心跳。
 *
 * 状态机（客户端侧）：
 *
 *   idle ─start()→ submitting ─→ queued ─(拿到 tunnel_target)→ running ─stop()→ releasing → ended
 *                       │            │                              │
 *                       └────────────┴────── 失败/被回收 ────────────┴──→ error
 *
 * ── 本文件里三个「静默失败」的防线 ─────────────────────────────────────────
 *
 * 1. **心跳**。守护进程判活只看 `last_hb_socket`（客户端经 unix socket 发的那个），
 *    **完全不读作业写的 `.jobhb` 文件**。停发心跳 → 300 秒后 `suspect`、
 *    1800 秒后 `orphaned` + scancel。而界面在此期间**一切正常** —— 这正是最危险的地方。
 *    所以心跳由本类用**单一 Map**持有，与窗口是否可见完全无关；发 goodbye 前先停；
 *    并且用 status 回来的 `last_hb_at` 交叉校验「心跳到底有没有落地」。
 *
 * 2. **submit 非幂等**。`op_submit` 每次调用都生成新 sid、插新行、提交新作业；
 *    而 `count_active` 只数 ACL_STATES，`submitted` 不在内，所以配额拦不住第二个。
 *    → 超时 45s（比 CLI 内部的 40s 长）、**超时绝不重试**、用 status 认领。
 *
 * 3. **`released` 不代表作业已停**。守护进程的 `phase_release` 只删规则、删文件、
 *    置 released，从不确认 `scancel` 真的成功（`docs/KNOWN-ISSUES.md` 的 F12 / F13）。
 *    所以「正在释放」和「已结束」必须是两个状态，且不能自己宣布成功。
 */

const { EventEmitter } = require('events');
const { Action, classify, shouldRetry } = require('./classify.js');
const { Tunnel } = require('./tunnel.js');

const State = {
  IDLE: 'idle',
  SUBMITTING: 'submitting',
  QUEUED: 'queued',        // 守护进程 state=submitted，还没登记
  RUNNING: 'running',      // 拿到 tunnel_target 了
  RELEASING: 'releasing',
  ENDED: 'ended',
  ERROR: 'error',
};

/** 心跳间隔。suspect_after=300s，留 6 倍余量。 */
const HEARTBEAT_MS = 45000;
/**
 * 稳定态刷新间隔（剩余时间、续期次数、tunnel_target 变化、被回收检测）。
 *
 * 60 秒而不是 30：一次 status = 一个 SSH exec channel = sshd fork + PAM session +
 * bash + python3 冷启动，而守护进程是**单线程同步**的，它的每个 tick 会为所有用户的
 * 所有会话各 fork 一次 squeue。稳定态下 `tunnel_target` 拿到就不会变，30 秒一次
 * 纯属给这个循环加压，受害的是所有人。
 */
const STATUS_MS = 60000;
/** 等待登记时的轮询间隔。这一段是唯一需要密集轮询的时期。 */
const QUEUED_POLL_MS = 3000;
/** submit 超时。**必须比 `slurmate` 内部的 40s socket 超时长**，否则会在守护进程
 *  还在跑 sbatch 的时候放弃，然后——按大多数重试逻辑——重试，于是两个作业。 */
const SUBMIT_TIMEOUT_MS = 45000;
/** status.last_hb_at 落后我们最近一次成功心跳超过这个值，说明心跳没落地。 */
const HB_STALE_SLACK_MS = 90000;

class SessionController extends EventEmitter {
  /**
   * @param {object} opts
   *   backend, layoutId, onTunnelPort, onRelayPort
   *   getExcludedPorts {() => Set<number>}  「别的布局组占着的端口」，由 index.js
   *                                        提供 —— 控制器不认识 config，所以注入。
   *   heartbeatMs / statusMs / queuedPollMs  可注入的节奏，仅供测试缩短用。
   *                                          生产值见文件顶部的常量。
   *
   * layoutId 是**布局组**的 id（见 config.js）：它决定本地监听端口、从而决定
   * 浏览器 origin 与存储分区。控制器自己不解释它，只原样带给 onTunnelPort。
   *
   * ★ 中转站会话的 layoutId 是 **null**。布局组存在的全部理由是「浏览器按 origin
   *   隔离 localStorage，所以端口 = 一份编辑器布局」，而中转站没有浏览器 ——
   *   给它分配一个布局组，等于凭空造出一个永远不会被创建的存储分区，还会让
   *   「运行中切布局」那条路去挪一个 ssh 隧道在用的端口。所以中转站的端口不走
   *   onTunnelPort，走 onRelayPort（见 _announcePort）。
   */
  constructor({ backend, layoutId, onTunnelPort, onRelayPort, getExcludedPorts,
                heartbeatMs, statusMs, queuedPollMs,
                requestedKind, needsPubkey }) {
    super();
    this.backend = backend;
    this.layoutId = layoutId;
    this.onTunnelPort = onTunnelPort || (() => {});
    this.onRelayPort = onRelayPort || (() => {});
    this.getExcludedPorts = getExcludedPorts || (() => new Set());
    this.heartbeatMs = heartbeatMs || HEARTBEAT_MS;
    this.statusMs = statusMs || STATUS_MS;
    this.queuedPollMs = queuedPollMs || QUEUED_POLL_MS;

    this.state = State.IDLE;
    this.sessionId = null;
    this.session = null;          // 最近一次 status 的会话视图
    this.tunnel = new Tunnel({ backend });
    this.error = null;
    this.warning = null;

    /**
     * 本次会话请求的服务种类。服务端一旦回答了就以**它**为准（见 serviceKind）。
     *
     * ★ 这里**不能**有默认值。从前它默认 `'code-server'`，那是在这个文件里写死
     *   了一个插件名；而"什么都不请求"和"请求 code-server"是两回事，前者根本
     *   不该产生一个会话。`start()` 一定会赋值。
     */
    this._requestedKind = requestedKind || null;
    /** 这个插件提交时要不要公钥。由调用方从插件元数据里取，这里不认插件名。 */
    this._needsPubkey = Boolean(needsPubkey);
    this._tunnelPort = null;
    this._heartbeatAt = 0;        // 最近一次心跳成功的时间（毫秒）
    this._hbTimer = null;
    this._statusTimer = null;
    this._lastTarget = null;
    this._stopped = false;

    this.tunnel.on('state', (s) => {
      this._emit();
      if (s.state === 'down') {
        this.warning = '隧道断开，正在重试。作业未受影响，仍在计算节点上运行。';
        this._emit();
      } else if (s.state === 'listening' && this.warning && /隧道断开/.test(this.warning)) {
        this.warning = null;
        this._emit();
      }
    });
    this.tunnel.on('error', (e) => {
      this.warning = '隧道错误：' + (e.code || e.message);
      this._emit();
    });
  }

  // ── 服务种类 ────────────────────────────────────────────────────────────
  /**
   * 本次会话提供的是哪种服务 —— **原样**，不归一、不认名字。
   *
   * ★ 归一（服务端没说 → 未知、认不出的名字 → 未知）是**注册表**的事，
   *   见 plugins/index.js 的 `resolve()`。这里保持原样有两个理由：
   *
   *   一是这个文件不该认识任何插件名 —— 它对"服务种类"的全部知识就是"有这么
   *   一个字符串"，以及（下面）"这个插件用不用布局组"。加第三个插件时它一行
   *   都不用改。
   *
   *   二是**"服务端没说"要原样传下去**：注册表拿 `null`（守护进程明说它不知道）
   *   与"这个键根本不存在"当同一件事（都是"服务端没说"，都不猜），而这里一旦
   *   替它填上一个值，那个事实就没了。
   *
   * 服务端一旦回答了就以它为准：`_requestedKind` 只是「还没拿到 status 之前」
   * 的临时答案，而唯一权威的来源是会话视图里的 `service_kind`。
   */
  serviceKind() {
    const s = this.session || {};
    return 'service_kind' in s ? s.service_kind : this._requestedKind;
  }

  /**
   * 本次会话用的插件**是哪一版** —— `"<id>@<版本>"`。这是会话的解析键。
   *
   * ★ 三态与 `serviceKind()` 一样：
   *     `undefined` 这个字段还不存在（更旧的守护进程）
   *     `null`      守护进程**明说**它不知道
   *     字符串       解析键
   *
   *   后两种在注册表那边是同一个答案（不猜）—— 但**都要原样传下去**，理由见
   *   `serviceKind()` 那一段。
   *
   * ★ 为什么必须是**会话**带着版本、而不是客户端去问站点"现在是哪一版"：
   *   `op_plugins` 报的是站点**当前**的清单，而一个跑着的作业用的是它**提交时**
   *   那一版 —— 作业侧与客户端侧是配套的两半。站点一升级插件，按"当前清单"解析
   *   已跑的会话就会把新版本的客户端代码接到旧版本的作业实现上。
   */
  servicePlugin() {
    const s = this.session || {};
    return 'service_plugin' in s ? s.service_plugin : undefined;
  }

  // ── 对外快照（界面唯一的数据来源）─────────────────────────────────────────
  snapshot() {
    const s = this.session || {};
    return {
      state: this.state,
      // 中转站会话是 null（见构造函数的说明）。
      layoutId: this.layoutId,
      // 已归一的三种取值之一。界面据此决定「连接」该做什么，**不要**自己猜：
      // null（服务端明说不知道）与 'code-server' 是完全不同的两件事。
      serviceKind: this.serviceKind(),
      // 会话的**解析键**（`<id>@<版本>`）。同样是三态，理由见 servicePlugin()。
      servicePlugin: this.servicePlugin(),
      sshHostKey: typeof s.ssh_host_key === 'string' ? s.ssh_host_key : null,
      sessionId: this.sessionId,
      jobId: s.job_id || null,
      // 本次实际落在哪个分区/节点 —— 因为默认是「从有权限的分区里随机挑」，
      // 用户事先不知道会落到哪种卡上，界面上必须显示出来。
      partition: s.partition || null,
      resources: s.resources || null,
      node: s.node || null,
      tunnelTarget: s.tunnel_target || null,
      localPort: this._tunnelPort,
      origin: this.tunnel.origin,
      // expires_at / job_state / time_limit 在 show_job 失败时**整个 key 不存在**
      // （cluster/slurmate-sessiond:1678-1687）。所以这里必须容忍 undefined，
      // 界面显示「剩余时间未知」而不是 0。
      expiresAt: typeof s.expires_at === 'number' ? s.expires_at : null,
      jobState: s.job_state || null,
      timeLimit: s.time_limit || null,
      renewCount: typeof s.renew_count === 'number' ? s.renew_count : null,
      lastHbAt: s.last_hb_at || null,
      hbAgeMs: this._heartbeatAt ? Date.now() - this._heartbeatAt : null,
      tunnelState: this.tunnel.state,
      backendKind: this.backend.kind,
      error: this.error,
      warning: this.warning,
      // ★ 「这一次会话不是在真集群上跑的」。界面据此挂那条横幅与状态条标记。
      //
      //   判据是**后端身份**，不是"用户开着那个开关"—— `fake` 只可能由开发者模式
      //   进来（见 backend.js 的 createBackend），两者今天恒等；但开关是**要重启
      //   才生效**的，而界面手里那份开关状态可能是"刚改过、还没重启"。拿它去判的话，
      //   改了开关还没重启的那段时间里，界面会对着一个真集群说"这是假的"。
      dev: this.backend.kind === 'fake',
    };
  }

  _emit() { this.emit('change', this.snapshot()); }

  _setState(st, extra = {}) {
    this.state = st;
    Object.assign(this, extra);
    this._emit();
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  /**
   * 提交并一路推到 running。
   *
   * @param {object} resources 高级选项里的**临时**覆盖：{cpus, mem, gpus, partition, time}
   *   全部可选。**缺省由服务端填**（2 CPU / 8G / 从有权限的分区里随机挑一个）——
   *   默认值不由客户端填，否则一个改过的客户端省略字段就能要到整机。
   *   只传用户**真的填了**的键，不要用 undefined 覆盖服务端的默认值。
   * @param {object} opts { preferredPort, serviceKind, sshPubkey }
   */
  async start(resources, opts = {}) {
    if (this.state !== State.IDLE && this.state !== State.ENDED && this.state !== State.ERROR) {
      throw new Error('会话已在进行中');
    }
    this._stopped = false;
    this.error = null;
    this.warning = null;
    this._requestedKind = opts.serviceKind || null;
    this._needsPubkey = Boolean(opts.needsPubkey);
    this._setState(State.SUBMITTING);

    // 只带上真正有值的键。带 `cpus: undefined` 会让 JSON.stringify 直接丢掉它，
    // 但带 `cpus: null` 不会 —— 而服务端会把 null 当成「用户要了 0 核」。
    const req = { op: 'submit' };
    for (const k of ['cpus', 'mem', 'gpus', 'partition', 'time']) {
      const v = resources && resources[k];
      if (v !== undefined && v !== null && v !== '') req[k] = v;
    }

    // 服务种类与公钥。**先校验再提交** —— 服务端也会校验（回 code 2），
    // 但走到那里已经花掉一次 sbatch 往返，而这里缺公钥只可能是调用方写错了。
    // 「要不要公钥」由调用方从插件元数据里取（`needsPubkey`），这里不认插件名。
    if (this._requestedKind) req.service_kind = this._requestedKind;
    if (this._needsPubkey) {
      if (!opts.sshPubkey) {
        this._setState(State.ERROR, {
          error: '内部错误：这个服务需要公钥，但调用方没有准备，已阻止提交。',
        });
        return null;
      }
      req.ssh_pubkey = opts.sshPubkey;
    }

    // ── 提交 ──
    let resp;
    try {
      resp = await withTimeout(
        this.backend.rpc(req),
        SUBMIT_TIMEOUT_MS);
    } catch (e) {
      // ★ 超时【绝不重试】。改为认领：调一次不带 session_id 的 status，
      //   看守护进程是不是其实已经建好了会话（响应丢了而已）。
      const claimed = await this._claim();
      if (claimed) {
        this.warning = '提交响应超时，但已在控制节点上找到刚创建的会话，继续接管。';
        return this._afterSubmit(opts);
      }
      this._setState(State.ERROR, {
        error: '提交超时且未能认领会话。请稍后用「查看状态」确认是否有多余作业，'
             + '或在控制节点上运行 squeue 检查。',
      });
      return null;
    }

    const c = classify(resp, { op: 'submit' });
    if (c.action !== Action.OK) {
      this._setState(State.ERROR, { error: c.message });
      return null;
    }

    // ★ 服务端替我们做了决定时必须说出来：截断了时间上限、把无法识别的内存
    //   换成了默认值、或者分区权限查不到因而交给了 Slurm 的默认分区。
    //   这些都不妨碍连上，但用户会以为自己要到了 —— 静默地替他决定，
    //   正是这个项目一路在清的那类问题。协议里 `warning` 这个字段存在的唯一
    //   理由就是被显示出来；不接它，它就只是一段写给读代码的人看的注释。
    if (resp.data.warning) this.warning = resp.data.warning;

    this.sessionId = resp.data.session_id;
    this._setState(State.QUEUED);
    return this._afterSubmit(opts);
  }

  /** 提交成功之后：等登记 → 开隧道 → 起心跳。 */
  async _afterSubmit(opts) {
    const ok = await this._waitForEnroll();
    if (!ok) return null;
    return this._bringUpTunnel(opts.preferredPort);
  }

  /**
   * 认领：不带 session_id 的 status 会返回该 uid 最新的活跃会话
   * （cluster/slurmate-sessiond:1699-1710）。用于「submit 响应丢了但会话其实建好了」。
   */
  async _claim() {
    try {
      const resp = await withTimeout(this.backend.rpc({ op: 'status' }), 20000);
      const c = classify(resp, { op: 'status' });
      if (c.action !== Action.OK) return false;
      const s = resp.data && resp.data.session;
      if (!s || !s.session_id) return false;
      this.sessionId = s.session_id;
      this._setState(State.QUEUED);
      return true;
    } catch {
      return false;
    }
  }

  /** 等待守护进程登记完成（tunnel_target 出现）。 */
  _waitForEnroll() {
    return new Promise((resolve) => {
      const poll = async () => {
        if (this._stopped) return resolve(false);
        const resp = await this.backend.rpc({ op: 'status', session_id: this.sessionId });
        const c = classify(resp, { op: 'status' });

        if (c.action === Action.OK) {
          const s = resp.data.session;
          if (!s) {
            this._setState(State.ERROR, { error: '会话在控制节点上已不存在。' });
            return resolve(false);
          }
          this.session = s;
          if (s.tunnel_target) {
            this._setState(State.RUNNING);
            return resolve(true);
          }
          if (['released', 'rejected', 'expired', 'orphaned'].includes(s.state)) {
            this._setState(State.ERROR, {
              error: `会话已结束（${s.state}）` + (s.note ? `：${s.note}` : ''),
            });
            return resolve(false);
          }
          this._setState(State.QUEUED);
        } else if (c.action === Action.SESSION_GONE) {
          this._setState(State.ERROR, { error: '会话已不存在。' });
          return resolve(false);
        } else if (c.action === Action.QUOTA_OR_PERMISSION || c.action === Action.FATAL) {
          this._setState(State.ERROR, { error: c.message });
          return resolve(false);
        } else {
          // 传输层/守护进程不可达 —— 继续等，不要判定失败。
          // 这一段守护进程可能正在重启，而作业还在跑。
          this.warning = c.message;
          this._emit();
        }
        setTimeout(poll, this.queuedPollMs).unref?.();
      };
      poll();
    });
  }

  /**
   * 本地端口变了，通知外面去把它记下来。**两条路，语义完全不同**：
   *
   *   有布局组 → 端口就是 origin，必须写回布局组（config.json），否则下次启动
   *              会绑回旧端口、浏览器布局跟着重置一次。
   *   没有布局组 → 端口要写进**用户那份 ssh 配置**的 Port 那一行。它不进
   *              config.json（那个插件没有布局组，见构造函数）。
   *
   * ★ 判据是 `this.layoutId` **有没有**，不是"是哪个插件"。这两个条件今天恰好
   *   等价（跑在浏览器里的插件才需要布局组），但前者是框架的事实，后者是一个
   *   插件名 —— 用名字判，加第三个插件时这里就得改。
   */
  _announcePort(port) {
    if (this.layoutId) this.onTunnelPort(this.layoutId, port);
    else this.onRelayPort(port);
  }

  /** 建立隧道并开始心跳。 */
  async _bringUpTunnel(preferredPort) {
    const target = this.session.tunnel_target;
    try {
      const { port, shifted } = await this.tunnel.start({
        preferredPort: preferredPort || 18080,
        target,
        excludePorts: this.getExcludedPorts(),
      });
      this._tunnelPort = port;
      this._lastTarget = target;
      this._announcePort(port);
      if (shifted && this.layoutId) {
        // 换端口意味着 origin 变了，浏览器存在 localStorage 里的编辑器布局会重置。
        // 用户有权知道为什么 —— 别让它变成一个「怎么布局又乱了」的谜。
        // ★ 没有布局组的插件不适用：那边没有浏览器，名字恒定，端口在底下漂移
        //   是无害的 —— 对它报"布局会重置"是一句纯粹的错误信息。
        this.warning = `首选端口被占用，已改用 ${port}。`
                     + `由于浏览器按端口隔离本地存储，编辑器的布局与最近打开的文件会重置一次。`;
      }
    } catch (e) {
      this._setState(State.ERROR, { error: '建立隧道失败：' + e.message });
      return null;
    }
    this._setState(State.RUNNING);
    this._startHeartbeat();
    this._startStatusPoll();
    return this.snapshot();
  }

  // ── 换布局组（运行中）────────────────────────────────────────────────────
  /**
   * 只把本地监听挪到另一个端口。**不碰会话、不碰心跳、不发任何 RPC。**
   *
   * 这就是「运行中切换布局组」的全部机制：Slurm 作业、控制节点那边的 session、
   * sessionId、tunnel_target 全程不变 —— 变的只有浏览器这一侧的 origin 与存储分区。
   * 所以它是可断言的：切换前后 sessionId/state 不变，且 RPC 调用数增量为 0。
   *
   * **失败必须回滚**：先 stop 再 start，中间失败时用**空排除集**把原来的端口绑回来
   * （不能带原来的排除集 —— 里面含着自己旧组的端口，那会把它跳过）。
   * 回滚也失败就进 ERROR 态：绝不留在「状态是 running、实际没有监听」那种状态，
   * 那会让界面显示一切正常而页面根本打不开。
   */
  async relisten(newLayoutId, preferredPort, excludePorts) {
    const target = this.session && this.session.tunnel_target;
    if (!target) return { ok: false, error: '还没有隧道目标，无法切换布局组。' };
    const prevLayout = this.layoutId;
    const prevPort = this._tunnelPort;

    await this.tunnel.stop();
    try {
      const { port, shifted } = await this.tunnel.start({
        preferredPort, target, excludePorts });
      // ★ 先把 layoutId 换成新的，再写回端口 —— onTunnelPort 是拿 layoutId 当键的，
      //   顺序反了会把新端口记到**旧**组名下，于是两个组的端口互相错位，
      //   下次启动各自绑到对方的 origin 上。
      this.layoutId = newLayoutId;
      this._tunnelPort = port;
      this.onTunnelPort(newLayoutId, port);
      this._emit();
      return { ok: true, port, shifted };
    } catch (e) {
      try {
        // 回滚：原来的端口和原来的组都放回去（同理，先还原 layoutId 再写回）
        const back = await this.tunnel.start({ preferredPort: prevPort, target });
        this.layoutId = prevLayout;
        this._tunnelPort = back.port;
        this.onTunnelPort(prevLayout, back.port);
        this._emit();
      } catch (e2) {
        this._setState(State.ERROR, {
          error: `切换布局组失败，且原端口 ${prevPort} 也绑不回来了：${e2.message}。`
               + '作业未受影响，请重新连接。',
        });
        return { ok: false, error: e.message, fatal: true };
      }
      return { ok: false, error: e.message };
    }
  }

  /** 换一个布局组 id。**只改标记与快照**，端口由 relisten 负责。 */
  setLayout(layoutId) {
    this.layoutId = layoutId;
    this._emit();
  }

  // ── 心跳 ────────────────────────────────────────────────────────────────
  _startHeartbeat() {
    if (this._hbTimer) return;                    // 幂等：绝不允许同一个会话有两个心跳
    const beat = async () => {
      if (this._stopped || !this.sessionId) return;
      const resp = await this.backend.rpc({ op: 'heartbeat', session_id: this.sessionId });
      const c = classify(resp, { op: 'heartbeat' });
      if (c.action === Action.OK) {
        this._heartbeatAt = Date.now();
        if (this.warning && /心跳/.test(this.warning)) this.warning = null;
      } else if (c.action === Action.SESSION_GONE) {
        // 会话没了，心跳没有意义了。**但不能因此判定作业已停** —— 只报告事实。
        this._stopHeartbeat();
        this.warning = '控制节点上已找不到该会话，心跳停止。';
      } else {
        // 传输层失败 / 守护进程不可达：**继续重试，绝不放弃**。
        // 这一段正是 300 秒闪断窗口要覆盖的情况。
        this.warning = '心跳发送失败（' + c.message + '），仍在重试。';
      }
      this._emit();
    };
    this._hbTimer = setInterval(beat, this.heartbeatMs);
    this._hbTimer.unref?.();
    beat();                        // 立刻打一次，别等 45 秒
  }

  _stopHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
  }

  // ── 状态轮询 ────────────────────────────────────────────────────────────
  _startStatusPoll() {
    if (this._statusTimer) return;
    const tick = async () => {
      if (this._stopped || !this.sessionId) return;
      const resp = await this.backend.rpc({ op: 'status', session_id: this.sessionId });
      const c = classify(resp, { op: 'status' });

      if (c.action === Action.OK) {
        const s = resp.data.session;
        if (s) {
          // 口令只在 ACL_STATES 才返回。**不能**用新响应里的 undefined 覆盖已有值 ——
          // 否则一次 NFS 抖动之后，自动重登就会因为没口令而失败。
          if (typeof s.auth_password !== 'string' && this.session && this.session.auth_password) {
            s.auth_password = this.session.auth_password;
          }
          this.session = s;

          // tunnel_target 变了（作业重启换了节点/端口）→ 重建隧道。
          // 不做这件事的表现是**页面卡住、没有任何报错**。
          if (s.tunnel_target && s.tunnel_target !== this._lastTarget) {
            this.warning = `隧道目标已变更（${this._lastTarget} → ${s.tunnel_target}），正在重建。`;
            this._lastTarget = s.tunnel_target;
            const prevPort = this._tunnelPort;
            try {
              await this.tunnel.stop();
              // ★ 必须**接住返回值**。丢掉它的后果是 this._tunnelPort 停在旧值，
              //   于是 snapshot().localPort 从此指向一个没人监听的端口 ——
              //   界面上「本地地址」那一栏是死的，而没有任何报错。
              const { port, shifted } = await this.tunnel.start({
                preferredPort: prevPort, target: s.tunnel_target,
                excludePorts: this.getExcludedPorts() });
              this._tunnelPort = port;
              // 端口顺移必须**写回去**：code-server 那边 origin 就是端口，配置里
              // 那份一旦与实际分叉，下次启动会绑回配置的端口、布局跟着重置一次，
              // 而用户不知道为什么；中转站那边则是 ssh 配置里的 Port 行。
              this._announcePort(port);
              if (shifted && this.layoutId) {
                this.warning = `隧道重建时端口 ${prevPort} 被占用，已改用 ${port}。`
                             + `浏览器按端口隔离本地存储，编辑器布局会重置一次。`;
              }
            } catch (e) {
              this.warning = '隧道重建失败：' + e.message;
            }
            this.emit('retarget', this.snapshot());
          }

          if (['released', 'rejected', 'expired'].includes(s.state)) {
            this._stopHeartbeat();
            this._stopStatusPoll();
            // ★ 会话结束了，本地监听必须一起收掉。留着它的后果不是「多占一个端口」：
            //   浏览器仍然连得上本地端口，却会被 dial 接到一个已经不存在的目标上 ——
            //   表现是「页面打不开，但也不报错」。端口只在 stop() 里释放是不够的，
            //   会话被守护进程回收（超时、孤儿、被拒）时根本不会走到 stop()。
            await this.tunnel.stop();
            this._setState(State.ENDED);
            return;
          }
          if (s.state === 'releasing') {
            this._stopHeartbeat();          // 已在释放，心跳没有意义了
            this._setState(State.RELEASING);
            return;
          }

          // 交叉校验：守护进程记的 last_hb_at 应该跟得上我们自己的心跳。
          // 落后太多说明心跳根本没落地（比如守护进程在写 DB 前崩了）——
          // 这条断言把一个纯静默的失败变成可见的告警。
          if (this._heartbeatAt && typeof s.last_hb_at === 'number') {
            const daemonAge = Date.now() - s.last_hb_at * 1000;
            if (daemonAge > HB_STALE_SLACK_MS) {
              this.warning = `控制节点记录的心跳已过期 ${Math.round(daemonAge / 1000)} 秒 —— `
                           + `心跳可能没有真正送达，会话可能被判定为断开。`;
            }
          }
        }
      } else if (c.action === Action.SESSION_GONE) {
        this._stopHeartbeat();
        this._stopStatusPoll();
        await this.tunnel.stop();     // 同上：会话都没了，监听没有理由留着
        this._setState(State.ERROR, { error: '会话已不存在。' });
        return;
      } else if (![Action.DAEMON_DOWN, Action.TRANSPORT, Action.RATE_LIMITED].includes(c.action)) {
        this.warning = c.message;
      }
      this._emit();
    };
    this._statusTimer = setInterval(tick, this.statusMs);
    this._statusTimer.unref?.();
  }

  _stopStatusPoll() {
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }
  }

  // ── 停止 ────────────────────────────────────────────────────────────────
  /**
   * **只释放本地资源，一个字都不发给服务端。**
   *
   * ★ 这不是给用户的第二条路 —— 那条"只关窗口、作业继续跑"的路被明确删掉了
   *   （见下面 stop() 的说明）。它只有一个用处：**模拟客户端重启**。
   *
   *   真机上重启时这个进程整个没了，它的监听套接字、轮询、心跳跟着一起消失；
   *   而测试是在**同一个进程里**把 controller 换掉，不显式关掉旧的那份资源，
   *   模拟出来的现场就变成了**两个客户端同时在跑**：旧的那个还占着一个端口在
   *   监听、还在轮询状态，收尾时进程退不掉（表现为整个测试文件多花几十秒）。
   */
  async abandon() {
    this._stopped = true;
    this._stopHeartbeat();
    this._stopStatusPoll();
    await this.tunnel.stop();
  }

  /**
   * 结束会话并释放资源。**只有一个语义：彻底终止。**
   *
   * ★ 这里曾经有一条 `farewell=false` 的分支（「只关窗口，作业继续跑」）。它被删掉了。
   *
   *   保留一条「不释放」的路径，前提是它能被可靠地触发在正确的时机上。而它不能：
   *   真正需要保住作业的情形是**客户端没能说上话** —— 断电、睡眠、网线被拔、
   *   进程被 kill -9。那些情况下根本没有代码会跑到这里来，这条分支在里面
   *   一次都不会被用到；反过来，能被它命中的只有「用户明确表达了终止意图」。
   *   于是它成了纯粹的误伤面：用户点了关闭或断开，作业却留在集群上继续占着
   *   12 小时的资源，而界面上什么都没有。
   *
   *   意外消失那条路径由守护进程的 suspect(300s)/orphaned(1800s) 容错窗口覆盖
   *   （见文件头第 1 条），客户端再提供一个「主动保活」的开关是多余且有害的。
   */
  async stop() {
    this._stopped = true;
    this._stopHeartbeat();          // ★ 必须在 goodbye 之前停。
    this._stopStatusPoll();         //    否则残留心跳收到 code:3 会被误判成出错。

    await this.tunnel.stop();

    if (!this.sessionId) {
      this._setState(State.ENDED);
      return { ok: true, state: 'ended', detail: '没有进行中的会话。' };
    }

    let resp;
    try {
      resp = await withTimeout(
        this.backend.rpc({ op: 'goodbye', session_id: this.sessionId }), 10000);
    } catch (e) {
      this._setState(State.ENDED);
      return {
        ok: false, state: 'unknown',
        detail: '会话未释放：' + e.message
              + '。作业可能仍在运行，将在约 31 分钟后被自动回收，期间持续占用节点。',
      };
    }

    const c = classify(resp, { op: 'goodbye' });
    if (c.action === Action.OK) {
      // ★ 注意：ok:true **不等于作业真的被取消了**。
      //   守护进程的 op_goodbye 丢弃 scancel 的返回值（docs/KNOWN-ISSUES.md 的 F12），
      //   而 phase_release 从不确认作业是否真的没了（F13）。所以这里只能说「已请求释放」。
      this._setState(State.RELEASING);
      return { ok: true, state: 'releasing', detail: '已请求释放，等待控制节点确认。' };
    }
    if (c.action === Action.SESSION_GONE) {
      this._setState(State.ENDED);
      return { ok: true, state: 'gone', detail: '会话在控制节点上已不存在。' };
    }

    this._setState(State.ENDED);
    return {
      ok: false, state: 'unknown',
      detail: '释放失败：' + c.message
            + '。作业可能仍在运行，将在约 31 分钟后被自动回收。',
    };
  }

}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`超时（${ms}ms）`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// ★ `HEARTBEAT_MS` 删了：它只是构造函数的**缺省值**（`heartbeatMs || HEARTBEAT_MS`），
//   而用例要调心跳节奏时走的是构造参数，不是这个常量。
module.exports = { SessionController, State, STATUS_MS, QUEUED_POLL_MS, SUBMIT_TIMEOUT_MS };
