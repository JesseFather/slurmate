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
 *    置 released，从不确认 `scancel` 真的成功（见记忆 cluster-side-defects 的 F12/F13）。
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
   *   backend, slot, onTunnelPort
   *   heartbeatMs / statusMs / queuedPollMs  可注入的节奏，仅供测试缩短用。
   *                                          生产值见文件顶部的常量。
   */
  constructor({ backend, slot, onTunnelPort, heartbeatMs, statusMs, queuedPollMs }) {
    super();
    this.backend = backend;
    this.slot = slot;
    this.onTunnelPort = onTunnelPort || (() => {});
    this.heartbeatMs = heartbeatMs || HEARTBEAT_MS;
    this.statusMs = statusMs || STATUS_MS;
    this.queuedPollMs = queuedPollMs || QUEUED_POLL_MS;

    this.state = State.IDLE;
    this.sessionId = null;
    this.session = null;          // 最近一次 status 的会话视图
    this.tunnel = new Tunnel({ backend });
    this.error = null;
    this.warning = null;

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

  // ── 对外快照（界面唯一的数据来源）─────────────────────────────────────────
  snapshot() {
    const s = this.session || {};
    return {
      state: this.state,
      slot: this.slot,
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
      demo: this.backend.kind === 'demo',
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
   * @param {object} opts { preferredPort }
   */
  async start(resources, opts = {}) {
    if (this.state !== State.IDLE && this.state !== State.ENDED && this.state !== State.ERROR) {
      throw new Error('会话已在进行中');
    }
    this._stopped = false;
    this.error = null;
    this.warning = null;
    this._setState(State.SUBMITTING);

    // 只带上真正有值的键。带 `cpus: undefined` 会让 JSON.stringify 直接丢掉它，
    // 但带 `cpus: null` 不会 —— 而服务端会把 null 当成「用户要了 0 核」。
    const req = { op: 'submit' };
    for (const k of ['cpus', 'mem', 'gpus', 'partition', 'time']) {
      const v = resources && resources[k];
      if (v !== undefined && v !== null && v !== '') req[k] = v;
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

  /** 建立隧道并开始心跳。 */
  async _bringUpTunnel(preferredPort) {
    const target = this.session.tunnel_target;
    try {
      const { port, shifted } = await this.tunnel.start({
        preferredPort: preferredPort || 18080,
        target,
      });
      this._tunnelPort = port;
      this._lastTarget = target;
      this.onTunnelPort(this.slot, port);
      if (shifted) {
        // 换端口意味着 origin 变了，code-server 存在 localStorage 里的编辑器布局会重置。
        // 用户有权知道为什么 —— 别让它变成一个「怎么布局又乱了」的谜。
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
            try {
              await this.tunnel.stop();
              await this.tunnel.start({ preferredPort: this._tunnelPort, target: s.tunnel_target });
            } catch (e) {
              this.warning = '隧道重建失败：' + e.message;
            }
            this.emit('retarget', this.snapshot());
          }

          if (['released', 'rejected', 'expired'].includes(s.state)) {
            this._stopHeartbeat();
            this._stopStatusPoll();
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
   * 发 goodbye。
   *
   * @param {object} opts
   *   farewell {boolean} true = 结束会话并释放（发 goodbye）
   *                      false = 只关窗口，作业继续跑（**不发 goodbye**）
   * @returns {Promise<{ok:boolean, state:string, detail:string}>}
   *
   * 关于 farewell=false：那套 `suspect`(300s)/`orphaned`(1800s) 容错机制存在的唯一
   * 目的就是容忍客户端意外消失。主动 goodbye 会把容忍度降成 0 —— 误点 ×、笔记本
   * 合盖，都会 scancel 掉一个跑了 12 小时的作业。
   */
  async stop({ farewell = true } = {}) {
    this._stopped = true;
    this._stopHeartbeat();          // ★ 必须在 goodbye 之前停。
    this._stopStatusPoll();         //    否则残留心跳收到 code:3 会被误判成出错。

    await this.tunnel.stop();

    if (!farewell || !this.sessionId) {
      this._setState(State.ENDED);
      return { ok: true, state: 'kept', detail: '已关闭窗口，作业继续运行。' };
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
      //   守护进程的 op_goodbye 丢弃 scancel 的返回值（记忆 cluster-side-defects F12），
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

  /** 进程要退出时的兜底：尽最大努力发一次 goodbye，并把失败落盘待补发。 */
  async farewellOnQuit() {
    if (!this.sessionId) return { ok: true };
    this._stopped = true;
    this._stopHeartbeat();
    this._stopStatusPoll();
    return this.stop({ farewell: true });
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

module.exports = { SessionController, State, HEARTBEAT_MS, STATUS_MS, QUEUED_POLL_MS, SUBMIT_TIMEOUT_MS };
