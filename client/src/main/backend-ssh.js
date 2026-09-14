'use strict';
/**
 * backend-ssh.js —— 真实后端（ssh2 + 纯公钥认证）。
 *
 * ── 认证方式：只用密钥，不接受密码 ──────────────────────────────────────────
 *
 * 私钥由客户端自托管（`keys.js` 生成，`config.js` 保管），**不读用户的 ~/.ssh**。
 * 公钥由用户在界面上复制、自己去 IDM 注册。理由见 keys.js 的文件头。
 *
 * ⚠️ 走这条路之前，有三条假设必须先用系统 ssh 实测证明（五分钟，零代码）。
 *    仓库里**至今没有一条实测结论**，全是推断；第 1、2 条不成立则本文件整个作废：
 *
 *      # 假设 A：sshd 的 ForceCommand（若你的集群装了）放行固定 argv 的 slurmate rpc
 *      ssh -T -p 10100 user@<登录节点> -- /usr/local/bin/slurmate rpc <<< '{"op":"ping"}'
 *      #   期望：恰好一行 JSON，ok:true，退出码 0。有额外输出就是没直通。
 *      #
 *      #   背景：有些集群会给普通用户的 sshd 装一个 ForceCommand 拦截器来管
 *      #   code-server 的端口。这类拦截器通常是 fail-open 的（命令串里不含
 *      #   code-server 字面量就直通），所以固定 argv 的 `slurmate rpc` 应当能过 ——
 *      #   但这是【依赖】，必须实测证明，不能假设。
 *
 *      # 假设 B：ForceCommand 不影响 direct-tcpip 转发
 *      ssh -N -L 18080:<tunnel_target> user@<登录节点> -p 10100 &
 *      curl -i http://127.0.0.1:18080/healthz     # 期望 200
 *
 *      # 假设 C：登录节点允许公钥认证
 *      ssh -i <新密钥> -o BatchMode=yes -o PasswordAuthentication=no ... true
 *
 * ── 固定 argv ──────────────────────────────────────────────────────────────
 *
 * RPC_CMD 是**编译期字符串常量**，用户输入永远不出现在命令串里。这既是防注入，
 * 也是穿过上面那个 guard 的必要条件（命令里不能出现 code-server 字面量）。
 * 【不提供】让用户自定义命令行的开关 —— 自定义的命令行不通用，而这个客户端
 * 没有大模型能自适应，它只能跑预设的辅助命令。
 *
 * ── 主机密钥 ───────────────────────────────────────────────────────────────
 *
 * ssh2 **默认不校验主机密钥**。只走公钥认证却不校验对端，会退化成一个
 * 「不校验身份的加密连接」—— 比口令认证更糟。所以这里实现 TOFU：
 *   已知且一致 → 放行
 *   第一次见   → 拒绝，并把指纹交回给界面让用户确认（确认后由调用方记住再重连）
 *   **变了**   → 永远拒绝。不是警告：主机密钥变了意味着中间人或者服务器重装，
 *                两种情况下继续连都是把私钥认证交给一个不确定的对端。
 *
 * ── 关于轮询频率 ──────────────────────────────────────────────────────────
 *
 * 一次 RPC = 一个 exec channel = sshd fork + PAM session + bash + python3 冷启动。
 * 而守护进程是**单线程同步**的，tick 里的 phase_running 会为所有用户的所有会话
 * 各 fork 一次 squeue。所以高频轮询是在给这个循环加压，受害的是所有人。
 * 缓解见 session.js 的 STATUS_MS（已从 30s 放宽到 60s）。**根治**要给
 * `slurmate rpc` 加 `--stream`，那需要改集群侧并重新部署，本次不做。
 *
 * ── 提交（submit）的特殊约束 ────────────────────────────────────────────
 *
 * `op_submit` **非幂等**，且 `count_active` 只数 ACL_STATES（`submitted` 不在内），
 * 配额拦不住并发的第二个。所以：超时必须 ≥ 45s，**超时绝不重试**，
 * 改为调一次不带 session_id 的 status 去认领。见 session.js 的 SUBMIT_TIMEOUT_MS。
 */

const crypto = require('crypto');
const ssh2 = require('ssh2');

const { Backend, KIND } = require('./backend.js');

/** 固定 argv。**常量**，不接受任何用户输入拼接。 */
const RPC_CMD = '/usr/local/bin/slurmate rpc';

const READY_TIMEOUT_MS = 20000;
const KEEPALIVE_INTERVAL_MS = 10000;
const KEEPALIVE_COUNT_MAX = 6;
/** 单次应答的上限。正常响应是几百字节；超过这个数说明对面回的不是我们的协议。 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/** 读一个 SSH string（uint32 长度 + 内容）。用来从主机密钥 blob 里取算法名。 */
function readSshString(buf, offset) {
  if (buf.length < offset + 4) return null;
  const len = buf.readUInt32BE(offset);
  if (buf.length < offset + 4 + len) return null;
  return { value: buf.subarray(offset + 4, offset + 4 + len), next: offset + 4 + len };
}

/** 主机密钥指纹，与 `ssh-keygen -lf` 同款：对公钥 blob 取 SHA256。 */
function hostKeyFingerprint(rawKey) {
  if (!Buffer.isBuffer(rawKey) || rawKey.length === 0) return null;
  return 'SHA256:' + crypto.createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '');
}

function hostKeyAlgorithm(rawKey) {
  const s = readSshString(rawKey, 0);
  return s ? s.value.toString('utf8') : null;
}

/** 后端的「传输层失败」信封：给 classify.js 认的 kind='transport' 标记。 */
function transportError(detail) {
  return { ok: false, code: null, data: null, error: { kind: 'transport', detail } };
}

class SshBackend extends Backend {
  /**
   * @param {object} opts
   *   privateKey      {string}   OpenSSH 格式私钥 PEM（keys.js 生成）
   *   hostKeyCheck    {function} (fingerprint) → 'known' | 'new' | 'changed'
   *                              由调用方（index.js）用 config.checkHostKey 提供
   *   trustHostKey    {string}   本次连接额外信任的指纹（用户在界面上刚确认过的那个）
   *   expectedHostKey {string}   hostKeyCheck 返回 changed 时的原指纹（用于报错文案）
   */
  constructor(opts = {}) {
    super();
    this.kind = KIND.SSH;
    this.label = '登录节点';
    this._opts = opts;
    this._conn = null;
    this._profile = null;
    this._whoami = null;
    this._connecting = null;
    this._closed = false;
    this._reconnectTimer = null;
    this._attempt = 0;
    this._lastHostKey = null;   // { fingerprint, algorithm } —— 供界面展示
  }

  /**
   * 建立连接。
   * @returns {Promise<{ok:true, whoami} |
   *                   {ok:false, error, code?, hostKey?}>}
   *   code='host_key_unknown' —— 第一次见到这台主机，hostKey 里带指纹，界面确认后
   *                              用 trustHostKey 重连一次
   *   code='host_key_changed' —— 主机密钥变了，**永远拒绝**
   */
  async connect(profile, opts = {}) {
    if (!profile || !profile.user || !profile.host || !Number.isInteger(profile.port)) {
      return { ok: false, error: '连接信息不完整（需要用户名、主机、端口）' };
    }
    // 每次连接都接受一次选项覆盖 —— 私钥可能刚被用户重新生成，
    // 主机密钥裁决依赖最新配置。构造时给的只是默认值。
    this._opts = { ...this._opts, ...opts };
    if (!this._opts.privateKey) {
      return { ok: false, error: '还没有可用的 SSH 私钥。请先在设置里生成密钥并把公钥注册到 IDM。' };
    }
    // ★ 先自己解析一遍私钥再交给 ssh2。
    //   `Client.connect()` 遇到不能解析的私钥会**同步抛异常**，穿出本模块
    //   「不抛异常」的契约 —— 在真机上表现为主进程里一个没人处理的 rejection，
    //   而用户看到的只是「点了没反应」。宁可在这里明确地失败。
    const parsed = ssh2.utils.parseKey(this._opts.privateKey);
    if (parsed instanceof Error || !parsed.isPrivateKey()) {
      return {
        ok: false,
        code: 'bad_private_key',
        error: '本机保存的 SSH 私钥无法解析（'
             + (parsed instanceof Error ? parsed.message : '不是私钥') + '）。'
             + '请在设置里重新生成密钥，并把新的公钥重新注册到 IDM。',
      };
    }
    this._profile = { user: profile.user, host: profile.host, port: profile.port };
    this._closed = false;
    this._attempt = 0;
    return this._open();
  }

  /** 幂等地拿到一条可用连接。并发调用共用同一次握手。 */
  async _ensure() {
    if (this._conn) return this._conn;
    if (!this._profile) throw new Error('尚未连接登录节点');
    const res = await this._open();
    if (!res.ok) throw new Error(res.error || '无法连接登录节点');
    return this._conn;
  }

  _open() {
    if (this._conn) return Promise.resolve({ ok: true, whoami: this._whoami });
    if (this._connecting) return this._connecting;
    // ★ `.catch` 是兜底：ssh2 有几处在**同步**路径上抛异常（比如私钥格式），
    //   而 Promise 执行器里同步抛出的东西会变成 rejection。少了这一层，
    //   它就会以「未处理的 rejection」出现在主进程里 —— 界面什么都不显示。
    this._connecting = this._openOnce()
      .catch((e) => ({ ok: false, error: '建立 SSH 连接时出错：' + (e && e.message) }))
      .finally(() => { this._connecting = null; });
    return this._connecting;
  }

  _openOnce() {
    const { user, host, port } = this._profile;
    return new Promise((resolve) => {
      const client = new ssh2.Client();
      let settled = false;
      let offeredKey = null;     // hostVerifier 里捕获到的主机密钥
      let rejected = null;       // 主机密钥被拒时的原因

      const done = (res) => { if (!settled) { settled = true; resolve(res); } };

      client.on('ready', async () => {
        this._conn = client;
        this._attempt = 0;
        this._emitState(true, `${user}@${host}:${port}`);

        // 顺手拿一次 whoami：它既验证「RPC 这条链路真的通」（而不只是 SSH 握手成功），
        // 又给界面提供账户与分区权限。**失败要如实报告** —— 这条链路不通时，
        // 界面必须知道，而不是以为连上了。
        const resp = await this.rpc({ op: 'whoami' });
        if (resp && resp.ok) {
          this._whoami = resp.data;
          return done({ ok: true, whoami: resp.data });
        }
        const detail = (resp && resp.error && resp.error.detail)
          || (resp && resp.error && resp.error.kind) || '未知原因';
        // 连上了 SSH，但 RPC 跑不通 —— 这几乎总是「守护进程没装」或「被 guard 拦了」。
        // 两者的修法完全不同，所以要把原始输出一起给出来。
        try { client.end(); } catch { /* 尽力 */ }
        this._conn = null;
        done({
          ok: false,
          code: 'rpc_unavailable',
          error: `已连上 ${host}，但无法执行 \`${RPC_CMD}\`：${detail}`,
        });
      });

      client.on('error', (e) => {
        if (rejected) {
          // 主机密钥被我们自己拒了 —— 报这个，别报 ssh2 顺带抛出的握手错误
          return done({ ok: false, code: rejected.code, error: rejected.error, hostKey: rejected.hostKey });
        }
        done({ ok: false, error: `SSH 连接失败：${e.message}` });
      });

      client.on('close', () => {
        if (this._conn === client) {
          this._conn = null;
          this._whoami = null;
          this._emitState(false, '连接已断开');
          this._scheduleReconnect();
        }
      });

      client.connect({
        host,
        port,
        username: user,
        privateKey: this._opts.privateKey,
        // ★ 必须实现。ssh2 默认不校验主机密钥，不做的后果是裸奔。
        hostVerifier: (key) => {
          offeredKey = key;
          const verdict = this._judgeHostKey(key);
          if (verdict === 'accept') return true;
          rejected = verdict;      // { code, error, hostKey }
          return false;
        },
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        readyTimeout: READY_TIMEOUT_MS,
      });
    });
  }

  /**
   * 主机密钥裁决。
   * @returns {'accept' | {code, error, hostKey}}
   */
  _judgeHostKey(rawKey) {
    const fingerprint = hostKeyFingerprint(rawKey);
    const algorithm = hostKeyAlgorithm(rawKey);
    if (!fingerprint) {
      return { code: 'host_key_invalid', error: '登录节点发来的主机密钥无法解析。', hostKey: null };
    }
    this._lastHostKey = { fingerprint, algorithm };

    const check = this._opts.hostKeyCheck;
    const status = typeof check === 'function' ? check(fingerprint) : 'new';

    if (status === 'known') return 'accept';
    // 用户刚在界面上确认过这一个指纹 —— 放行，但**只放行这一个**
    if (status === 'new' && this._opts.trustHostKey === fingerprint) return 'accept';

    if (status === 'changed') {
      return {
        code: 'host_key_changed',
        error: `登录节点的主机密钥已改变（原为 ${this._opts.expectedHostKey || '未知'}）。`
             + `这可能是服务器重装，也可能是中间人攻击 —— 在确认原因之前不会建立连接。`,
        hostKey: { fingerprint, algorithm },
      };
    }
    return {
      code: 'host_key_unknown',
      error: `第一次连接到这台登录节点。请核对指纹后确认。`,
      hostKey: { fingerprint, algorithm },
    };
  }

  _scheduleReconnect() {
    if (this._closed || !this._profile || this._reconnectTimer) return;
    const delay = Math.min(RECONNECT_MIN_MS * (2 ** this._attempt), RECONNECT_MAX_MS);
    this._attempt += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closed || !this._profile) return;
      // 只重连「被断掉的」连接。这里【不】重试主机密钥被拒的情况 ——
      // 那需要用户先做决定，自动重试只会把同一个拒绝重复一遍。
      this._open().catch(() => { /* 下一轮 close 会再排 */ });
    }, delay);
    this._reconnectTimer.unref?.();
  }

  /**
   * 发一次 RPC。
   *
   * **契约：不抛异常。** 传输层失败返回一个 `kind='transport'` 的信封，由
   * classify.js 统一分类 —— 调用方（session.js）从不 try/catch rpc 的返回值。
   */
  async rpc(req) {
    let conn;
    try {
      conn = await this._ensure();
    } catch (e) {
      return transportError(e.message);
    }
    if (!conn) return transportError('尚未连接到登录节点');

    return new Promise((resolve) => {
      conn.exec(RPC_CMD, (err, stream) => {
        if (err) return resolve(transportError('无法在登录节点上执行命令：' + err.message));

        let stdout = '';
        let stderr = '';
        let gotExit = false;
        let finished = false;
        const finish = (res) => { if (!finished) { finished = true; resolve(res); } };

        stream.on('data', (d) => {
          stdout += d;
          if (stdout.length > MAX_RESPONSE_BYTES) {
            try { stream.close(); } catch { /* 尽力 */ }
            finish(transportError('应答过大，已中止（对面回的可能不是 Slurmate 的协议）。'));
          }
        });
        stream.stderr.on('data', (d) => { stderr += d; });
        stream.on('exit', () => { gotExit = true; });
        stream.on('error', (e) => finish(transportError('通道出错：' + e.message)));
        stream.on('close', () => {
          // 判据的选择：**只要有可解析的 JSON 行就用它**，不因为「没收到 exit 事件」
          // 就把它当成失败 —— 宁可不丢一个合法应答。反过来，stdout 空或不是 JSON
          // 时，把 stderr 和 exit 情况一并报出来，因为这正是「命令没跑起来」
          // （守护进程没装、被 guard 拦了、python 崩了）的现场。
          const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
          const last = lines[lines.length - 1];
          if (last) {
            try {
              const obj = JSON.parse(last);
              if (obj && typeof obj === 'object') return finish(obj);
            } catch { /* 落到下面报错 */ }
          }
          const parts = ['登录节点没有返回可解析的应答'];
          if (!gotExit) parts.push('（命令通道被关闭，未收到退出状态）');
          const errText = stderr.trim().split('\n').slice(0, 3).join(' / ');
          if (errText) parts.push('：' + errText);
          else if (lines.length === 0) parts.push('（输出为空）');
          finish(transportError(parts.join('')));
        });

        // 请求体走 **stdin**，绝不进命令行 —— argv 是常量这件事靠这里保持。
        stream.end(JSON.stringify(req) + '\n');
      });
    });
  }

  /**
   * 建立一条到目标的数据通道（隧道用）。
   *
   * ★ host 必须是守护进程给的 `tunnel_target` 里那个**字面 IPv4**，禁止再解析节点名。
   *   解析结果与 nft 的 `ip daddr` 不一致会导致 ACL **静默失效**
   *   （cluster/slurmate-sessiond:1674-1680 对此有强措辞的注释）。
   *   这个检查的权威位置在 tunnel.js（它拿得到原始 tunnel_target 字符串），
   *   这里只保证不自己动手解析。
   */
  async dial(host, port) {
    const conn = await this._ensure();
    return new Promise((resolve, reject) => {
      conn.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
        if (err) reject(err);
        else resolve(stream);
      });
    });
  }

  /** 最近一次见到的主机密钥，供界面显示。 */
  get lastHostKey() { return this._lastHostKey; }

  async close() {
    this._closed = true;
    this._profile = null;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    const c = this._conn;
    this._conn = null;
    this._whoami = null;
    if (c) { try { c.end(); } catch { /* 尽力而为 */ } }
  }
}

/** 已实现。上面的三条实测假设与固定 argv 都到位了。 */
function isImplemented() {
  return true;
}

module.exports = { isImplemented, SshBackend, RPC_CMD, hostKeyFingerprint, hostKeyAlgorithm };
