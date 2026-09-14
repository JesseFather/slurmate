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
const { Backend, KIND } = require('./backend.js');
const { createDemoCodeServer } = require('./demo-server.js');

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
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────
  async connect(profile) {
    if (!this._server) {
      this._server = createDemoCodeServer({ password: DEMO_PASSWORD });
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
      case 'ping':       return ok({ pong: true, version: '0.2.0-demo', time: nowSec() });
      case 'whoami':     return this._whoami();
      case 'partitions': return ok({ partitions: this._partitions(), defaults: { ...DEFAULTS } });
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
  debugReset() {
    this._daemonDownUntil = 0;
    this._tunnelDownUntil = 0;
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
    // 本地 HTTP 服务是在 connect() 里起的。没起就说明调用方漏了 connect ——
    // 那样会产出一个 service_port=0 的会话，隧道目标变成 "127.0.0.1:0"，
    // 会话在「已登记」之后才炸。宁可在这里响亮地失败。
    if (!this._server) {
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
      auth_mode: 'password',
      auth_password: null,
      job_state: 'PENDING',
      time_limit: '12:00:00',
      expires_at: now + DEFAULT_TIME_SECONDS,
    };

    this._enrollTimer = setTimeout(() => {
      if (!this._session || this._session.session_id !== sid) return;
      this._session.state = 'enrolled';
      this._session.enrolled_at = nowSec();
      this._session.node = part.name === '2080TI' ? 'node04' : 'node01';
      // 演示里 tunnel_target 指向本地的假 code-server。
      // 用字面 IPv4 —— tunnel.js 会用 net.isIPv4() 校验，这一步是真跑的。
      this._session.node_ip = '127.0.0.1';
      this._session.service_port = this._server ? this._server.port : 0;
      this._session.tunnel_target = `127.0.0.1:${this._session.service_port}`;
      this._session.auth_password = DEMO_PASSWORD;
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
    // 因为 scancel 有可能静默失败（见记忆 cluster-side-defects 的 F12/F13）。
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
    };
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
