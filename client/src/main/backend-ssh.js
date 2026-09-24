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
 *      #   ★ 必须**原样**用下面这条：外层双引号保住内层单引号，否则本地 shell 会先把
 *      #     引号吃掉，ssh 发过去的是另一个命令串，验的就不是客户端真正发的那个了。
 *      ssh -T -p 10100 user@<登录节点> \
 *          -- "/bin/bash -c '/usr/local/bin/slurmate rpc'" <<< '{"op":"ping"}'
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
 * ── 两条链路：exec 与常驻通道 ─────────────────────────────────────────────
 *
 * 一次 `slurmate rpc` = 一个 exec channel = sshd fork + PAM session + bash +
 * python3 冷启动。而守护进程是**单线程同步**的，tick 里的 phase_running 会为
 * 所有用户的所有会话各 fork 一次 squeue。所以高频轮询是在给这个循环加压，
 * 受害的是所有人。
 *
 * 这一版加了第二条链路：`slurmate stream`，**一条**常驻连接承载很多请求，
 * 服务端还能主动推。收益不只是省掉每次的 python 冷启动 —— session.js 的
 * 60 秒对账从此由推送驱动（快照 30 秒一次、有变化 2 秒内到），exec 只在
 * **实质变化**时发生。
 *
 * ★★ 而 exec 那条链路**没有删，它是退路**。"起不来就退回去"不是容错装饰：
 *    常驻通道会因为"登录节点上的 CLI 还是旧的（没有 `stream` 这个子命令）"、
 *    "ForceCommand 拦了"、"守护进程没在跑"而起不来，这几种情况下客户端必须
 *    照常能用。判据在 session.js 的推送看门狗（`PUSH_STALE_MS`）—— 一条推送
 *    都没收到时，那边的对账**逐字回到从前**。
 *
 * ── 提交（submit）的特殊约束 ────────────────────────────────────────────
 *
 * `op_submit` **非幂等**，且 `count_active` 只数 ACL_STATES（`submitted` 不在内），
 * 配额拦不住并发的第二个。所以：超时必须 ≥ 45s，**超时绝不重试**，
 * 改为调一次不带 session_id 的 status 去认领。见 session.js 的 SUBMIT_TIMEOUT_MS。
 */

const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const ssh2 = require('ssh2');

const { Backend, KIND } = require('./backend.js');

/**
 * 固定 argv。**常量**，不接受任何用户输入拼接。
 *
 * ★ 显式走 `/bin/bash -c`，不用「登录 shell 是什么就用什么」。
 *
 *   sshd 执行 exec 请求的方式是 `$SHELL -c "<命令串>"`，而 `$SHELL` 来自
 *   /etc/passwd —— 在 HPC 登录节点上经常是 zsh。zsh 与 bash 并非完全互通，
 *   同一条命令串在一边能跑、在另一边是语法错误。我们发的是**写死的**命令串，
 *   一旦它用上某个 shell 的方言，症状会是「在这台机器上能连、换一台就认证失败」
 *   这类指不回根因的问题。把解释器钉死，等于把这条变量从等式里去掉。
 *
 *   ★ 但它**挡不住 rc 文件**，别把这两件事混起来：sshd 仍然先用登录 shell 解释
 *     整个命令串，所以 zsh 的 `~/.zshenv` 照样会被 source（zsh 连非交互、非登录的
 *     `-c` 都会读它 —— 这是它与 bash 的一处真实差异，bash 的 `-c` 不读任何 rc）。
 *     `~/.zshenv` 若往 stdout 打印东西，就会混进 RPC 的应答里。
 *     那一条由下面的应答解析兜底（从后往前找第一个合法信封），不是靠这里换 shell。
 *
 *   `/bin/bash` 在 Linux 上不存在的概率很低；真没有的话，命令会以
 *   「没有返回可解析的应答」明确失败，而不是静默连上。
 */
const RPC_CMD = "/bin/bash -c '/usr/local/bin/slurmate rpc'";

/**
 * 常驻通道的命令行。同样是**编译期常量**，与 `RPC_CMD` 只有子命令那一个词不同。
 *
 * ★ 两条命令共用同一个二进制路径，而**分头写死是有意的**（而不是拼出来的）：
 *   上面那条用例的判据是"这一串是常量、不含任何模板语法"，拼出来的写法会让
 *   "用户输入永远不出现在命令串里"这条性质从**看一眼就知道**变成**要推理**。
 *   代价是路径写了两遍 —— 所以有一条用例钉住"两者只差最后那个词"。
 */
const STREAM_CMD = "/bin/bash -c '/usr/local/bin/slurmate stream'";

const READY_TIMEOUT_MS = 20000;
const KEEPALIVE_INTERVAL_MS = 10000;
const KEEPALIVE_COUNT_MAX = 6;
/** 单次应答的上限。正常响应是几百字节；超过这个数说明对面回的不是我们的协议。 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/**
 * 常驻通道的**探针**超时：建起来之后先问一句 `ping`，答得上来才算这条通道可用。
 *
 * ★ 必须有这一句，否则"通道起来了"与"通道能用"会被当成同一件事 ——
 *   `exec` 请求成功只说明**命令被启动了**，而 `slurmate stream` 完全可能
 *   立刻报错退出（旧 CLI 没有这个子命令时 argparse 就是这样：一行 usage、
 *   退出码 2）。不探针的话，第一条真请求才会发现，而那时客户端已经在
 *   等一个永远不会来的响应了。
 *
 * 取 8 秒：这一问走的是已经建好的 SSH 连接，正常是几十毫秒。
 */
const STREAM_PROBE_MS = 8000;

/**
 * 常驻通道上**单条请求**的兜底超时。
 *
 * ★★ 它是**兜底**，不是语义上的超时 —— 语义超时在调用点各自有
 *    （submit 45 秒、goodbye 10 秒、claim 20 秒，见 session.js）。
 *    取一个比它们都大的值，否则它会**抢先**切断一条合法请求，而症状是
 *    "提交超时"——一句把根因指向集群的话。这里真正要防的是另一件事：
 *    一条永远不回答的请求会把 `_pending` 撑住、让调用方的 `await` 永远挂着。
 *    （exec 那条路上不需要它：通道断了 Node 会报错；常驻通道上断了也会，
 *    但"对面活着而这一条没答"只有超时能收。）
 */
const RPC_TIMEOUT_MS = 180000;

/** 常驻通道断了之后重开的间隔，照抄 SSH 重连那套退避。 */
const STREAM_REOPEN_MIN_MS = 2000;
const STREAM_REOPEN_MAX_MS = 60000;
/**
 * 连续失败多少次之后不再重开。
 *
 * ★ 必须有个头。**登录节点上的 CLI 是旧的**（没有 `stream` 这个子命令）时，
 *   每一次重开都是一次注定失败的 exec —— 而它换来的是**每分钟多 fork 一个
 *   python**，比这一版想省掉的那个还贵。那种情况下正确的是：记下原因、退回
 *   exec、不再试。
 * ★ 而"连着三次都失败"与"曾经成功过又断了"要分得开：后者会把计数清零，
 *   于是重开一条曾经好用的通道永远有配额（见 `_openStream` 成功那一支）。
 */
const STREAM_ATTEMPT_MAX = 3;

/**
 * 一行是不是协议消息。**这条判据只有一份** —— exec 那条路（从一坨噪声里挑信封）
 * 与常驻通道（每一行都过一遍）都用它。
 *
 * ★ 两处各写一遍的后果不是"多几行"，是**两条链路对"什么算一条消息"给出不同答案**
 *   —— 而那正好是 `rid` 回填、推送识别、噪声丢弃三件事共同依赖的那一条。
 *
 * 判据（两种形状，缺一不可）：
 *
 * - **响应**：对象、且 `ok` 是布尔。只看"是个 JSON 对象"太松 —— rc 文件里打印一段
 *   恰好是对象的 JSON，会被当成守护进程的应答送进 classify()，然后被解释成一个
 *   关于协议的错误，而真正的原因（shell 环境不干净）连提都不会被提到。
 * - **通知**：对象、`push` 是字符串、`seq` 是数字。通知**没有 `ok`**，所以上面那
 *   一条接不住它。加这一条会不会让 exec 那条路把通知误当应答？不会，而且是**结构性
 *   的**：通知只发给**订阅过**的连接，订阅的判据是"这个连接发过带 `rid` 的请求"
 *   （见守护进程的 `handle_line`），而 exec 那条路每次都是新连接、永远不带 `rid`。
 *
 * @returns {object|null} 这一行对应的消息；是噪声就返回 null
 */
function parseEnvelopeLine(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.ok === 'boolean') return obj;
  if (typeof obj.push === 'string' && typeof obj.seq === 'number') return obj;
  return null;
}

/**
 * 从命令的原始 stdout 里挑出协议应答。
 *
 * ★ 这是「这台机器的 shell 环境干不干净」与「协议解析」之间唯一的一道缝，
 *   所以规则要写死在这里，而不是散在回调里靠运气。
 *
 * 规则：**从后往前**找第一个 `parseEnvelopeLine` 认得的行。
 *
 * 从后往前：sshd 用**登录 shell** 解释我们发过去的命令串，登录 shell 的 rc 文件
 * 可能在应答**之前**打印东西（zsh 的 `~/.zshenv` 连 `-c` 都会读）。取「最后一行」
 * 是个碰巧够用的启发式，从后往前扫才两边都不怕。
 *
 * @returns {{found:true, envelope:object} | {found:false, lines:string[]}}
 */
function pickEnvelope(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = parseEnvelopeLine(lines[i]);
    if (obj) return { found: true, envelope: obj };
  }
  return { found: false, lines };
}

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

/**
 * 「本机已被另一个客户端顶掉」的信封。
 *
 * ★★ 它**必须与 `transportError` 分开**。两者都会让调用方停下来，但含义差得很远：
 *   传输失败是**暂时**的（该重试，而且我们确实在重连），被顶掉是**终局**的
 *   —— 在用户手动点「连接」之前，重试一万次也都是同一个结果。
 *   合成一个的话，`classify` 会把"你被顶掉了"当成网络抖动，于是界面显示
 *   「重试中……」，而它永远不会成功，也永远不会说清为什么。
 */
function displacedError(detail) {
  return { ok: false, code: null, data: null, error: { kind: 'displaced', detail } };
}

/** ssh2 在「服务器拒绝了所有认证方式」时抛的原话。 */
const AUTH_FAILED_RE = /all configured authentication methods failed/i;

/**
 * 把认证失败翻译成能指向根因的话。
 *
 * ★ 「All configured authentication methods failed」是 ssh2 的原话，唯一含义是
 *   **服务器拒绝了客户端出示的全部认证方式**。这里只配了公钥一种，所以它就是
 *   「服务器不认这把钥匙」—— 既不是网络不通，也不是协议不匹配。
 *
 *   问题在于这句话**完全不提用的是哪把钥匙**，于是用户唯一能做出的反应是反复重试。
 *   所以这里把指纹和公钥原样给出来，并列出三条要核对的实事：它们分别对应三种
 *   完全不同的修法，而在这句英文报错里长得一模一样。
 *
 * （纯函数，导出给测试钉住 —— 这段文案是这个项目里唯一能帮上「认证失败」的地方。）
 */
function authFailureDetail(info) {
  const who = `${info.user}@${info.host}:${info.port}`;
  const line = info.publicKeyLine || '（没能取到公钥）';
  return `登录节点拒绝了这把公钥（${who}）。\n`
    + `客户端出示的是 ${info.keyType || '未知类型'}，指纹 ${info.keyFingerprint || '未知'}：\n`
    + `${line}\n`
    + '请依次核对这三件事 —— 它们的修法完全不同：\n'
    + '① 上面这个指纹就是你注册进 IDM 的那一把吗？把公钥粘进这条命令即可核对：\n'
    + `   ssh-keygen -lf <(echo '${line}')\n`
    + '② 注册确实生效了吗（有的 IDM 要重新登录一次才开始下发公钥）；\n'
    + '③ 这个端口上的 sshd 允许纯公钥认证吗 —— 有的集群在这个端口上还要求额外一步\n'
    + '   验证，那种情况下只配公钥是不够的。\n'
    + '这条连接的公钥可以在它的「编辑」里看到并复制。';
}

/**
 * 常驻通道的**客户端这一半**：一条 duplex 上跑多个请求，并收服务端主动推的消息。
 *
 * 它只认字节与行，不认识 SSH —— 传进来的就是一个 duplex（ssh2 的 channel、或者
 * 用例里的一对 `PassThrough`）。**这样它才验得了**：真起一条 SSH 才能跑的话，
 * `rid` 关联、乱序响应、断开时在途请求的下场，这几条最要紧的性质一条都测不到。
 *
 * ── 它保证的四件事 ────────────────────────────────────────────────────────
 *
 * 1. **`rid` 关联**。每条请求一个自增的 `rid`，响应按 `rid` 回到它自己的 Promise
 *    上。并发发出去的请求**不保证**按序回来，也不该假设。
 * 2. **断开时在途请求全部拿到答复**。它们拿到的是 `kind='transport'` 的信封，
 *    不是永远挂着。★ 这条是承重的：常驻通道上"断了"与"没答"是两件事，
 *    漏掉它的症状是 `await` 永远不回、调用方的定时器一轮轮往上叠。
 * 3. **多字节字符不会被撕开**。见 `_dec`。
 * 4. **一行有多长是有上限的**。见 `MAX_RESPONSE_BYTES` 那一条。
 */
class ResidentChannel {
  /**
   * @param {object} stream  duplex（可写请求、可读消息）
   * @param {object} opts
   *   onNotify {function}  收到一条通知时调用（`{push, seq, at, sessions, stale?}`）
   *   onClose  {function}  这条通道死了（参数是原因字符串）。**无论是谁先动的手**
   *                        ——对端关了、写失败了、超长了，都走这一个出口。
   *   client   {object}     这台电脑的客户端身份 `{id, name}`。**每一条请求都带上它**
   *                         （见 request()）。
   */
  constructor(stream, opts = {}) {
    this._stream = stream;
    this._onNotify = opts.onNotify || (() => {});
    this._onClose = opts.onClose || (() => {});
    this._client = opts.client || null;
    /** rid → {resolve, timer}。**只有**在途的请求在里面。 */
    this._pending = new Map();
    this._nextRid = 1;
    /** 半个行。只会有半个 —— 完整行当场处理掉。 */
    this._buf = '';
    this.dead = null;
    /**
     * ★★ 必须用 `StringDecoder`，不能 `chunk.toString('utf8')` 了事。
     *
     *   一个 UTF-8 字符会被 TCP/SSH 从**中间**切开，而每一片各转一次字符串就会
     *   各自变出一个 U+FFFD。症状是插件标题、分区名、`note` 里偶尔出现一个""，
     *   **而且是间歇性的** —— 取决于分片边界落在哪，本地永远复现不了。
     *
     *   ★ exec 那条路从前就是这么坏的（`stdout += d` 里 `d` 是 Buffer，
     *     隐式 `toString('utf8')`），只是没人注意：那边的响应里恰好没有中文，
     *     直到 `op_plugins` 开始带中文标题。这里两处一起修 —— "怎么把字节拼成
     *     一行"是一条规矩，两份实现会漂。
     */
    this._dec = new StringDecoder('utf8');
    this._bind();
  }

  _bind() {
    this._stream.on('data', (d) => this._onData(d));
    this._stream.on('error', (e) => this._die(
      '常驻通道出错：' + ((e && e.message) || '未知错误')));
    this._stream.on('close', () => this._die('常驻通道已关闭'));
    // 写侧的错误（对端已经走了）也要走同一个出口，否则它是个没人处理的 'error'
    // —— 在 Electron 主进程里那是一条 uncaught exception。
    if (this._stream.stdin && typeof this._stream.stdin.on === 'function') {
      this._stream.stdin.on('error', (e) => this._die(
        '常驻通道写入失败：' + ((e && e.message) || '未知错误')));
    }
  }

  _onData(d) {
    if (this.dead) return;
    this._buf += this._dec.write(d);
    // ★ 上限判在**拼出来的那一整行**上，而不是单个 chunk 上：chunk 的大小由
    //   传输层决定（几 KiB），拿它当判据等于没判。
    if (this._buf.length > MAX_RESPONSE_BYTES) {
      return this._die('常驻通道上有一行过大，已中止（对面回的可能不是 Slurmate 的协议）。');
    }
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).trim();
      this._buf = this._buf.slice(i + 1);
      if (line) this._onLine(line);
      if (this.dead) return;
    }
  }

  _onLine(line) {
    const env = parseEnvelopeLine(line);
    // 噪声（登录 shell 的 rc 文件在通道起来之前打印的东西）—— 丢掉，与 exec
    // 那条路同一条规则。
    if (!env) return;
    if (env.rid !== undefined && env.rid !== null) {
      const p = this._pending.get(env.rid);
      // ★ 找不到就丢掉。这条**不是**漏网的响应，而是**迟到的**：它已经超时、
      //   调用方早就拿到了 transport 错误。当成通知处理的话，一个迟到的响应
      //   会被读成一条推送。
      if (!p) return;
      this._pending.delete(env.rid);
      clearTimeout(p.timer);
      p.resolve(env);
      return;
    }
    if (typeof env.push === 'string') {
      this._onNotify(env);
    }
    // 既没有 rid 也不是通知：丢掉。（守护进程只会发这两种。）
  }

  /** 客户端侧的 `request()` 与守护进程的 `resp["rid"] = rid` 是同一件事的两半。 */
  request(req, timeoutMs = RPC_TIMEOUT_MS) {
    if (this.dead) return Promise.resolve(transportError(this.dead));
    const rid = this._nextRid++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(rid);
        resolve(transportError(
          `常驻通道上这条请求超过 ${Math.round(timeoutMs / 1000)} 秒没有得到应答。`));
      }, timeoutMs);
      timer.unref?.();
      this._pending.set(rid, { resolve, timer });
      // ★ **`rid` 只从这条路径上发。** 它在守护进程那边是"这条连接从此收推送"
      //   的判据，而 exec 那条路是**一次性的**：带上它，守护进程会把推送写进一条
      //   已经没人读的连接。见 rpc() 里那一句。
      try {
        // ★★ `client` 与 `rid` **只在同一条路径上、同一个理由上发出去**：
        //   守护进程认身份的判据就是"这条连接发过带 rid 的请求"（见
        //   register_client）。exec 那条路上一个都不带 —— 带上 `rid` 会让守护
        //   进程把推送写进一条已经没人读的连接；带上 `client` 会让**每一次 exec
        //   退路都顶掉自己那条常驻通道**（同一个 client_id 又"连上来了"）。
        this._stream.write(JSON.stringify(
          this._client ? { ...req, rid, client: this._client } : { ...req, rid }
        ) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(rid);
        resolve(transportError('写入常驻通道失败：' + ((e && e.message) || '未知错误')));
      }
    });
  }

  /**
   * @param {string}  why
   * @param {boolean} deliberate  是不是**我们自己**关的（探针失败、后端在拆）
   *
   * ★ 这个区分是承重的：调用方（`SshBackend`）拿到 non-deliberate 的关闭会**重开**
   *   一条。把它和"自己关的"混在一起，探针一失败就会变成重开风暴 —— 而风暴的症状
   *   是登录节点上每两秒一个 `slurmate stream` 进程，日志里什么都没有。
   */
  _die(why, deliberate = false) {
    if (this.dead) return;
    this.dead = why;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.resolve(transportError(why));
    }
    this._pending.clear();
    this._onClose(why, deliberate);
  }

  /** 主动关掉（探针失败、后端在拆）。已死的通道上什么都不做。 */
  close() {
    if (this.dead) return;
    // ★ 先判死再关流：反过来的话，`close()` 触发的 'close' 事件会先跑进 `_die`，
    //   于是这次关闭的原因被记成"对端关了"，而它其实是我们自己关的 ——
    //   排查的时候这两个原因的下一步完全不同。
    this._die('常驻通道已被客户端关闭', true);
    try { this._stream.close?.(); } catch { /* 尽力 */ }
  }
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
    /**
     * 握手问到的基座版本（三态，见 `connect()` 的接口注释）。
     *
     * ★ 它是**这一条连接**的事实，所以要跟 `_conn` 同生共死：断开时清掉，
     *   否则下一条连接会把上一条的版本号报出去 —— 而"上一条是哪一台"这件事
     *   在两条连接之间没有任何保证。
     */
    this._daemonVersion = null;
    // 调用方（index.js 的启动接续）问的是「有没有连上」，不是「你的私有字段叫什么」。
    // 见 backend.js 接口注释。连接中途断开时 `_conn` 会被置回 null（:309、:501），
    // 所以这个 getter 跟着它就是准的。
    this._closed = false;
    this._reconnectTimer = null;
    this._attempt = 0;
    this._lastHostKey = null;   // { fingerprint, algorithm } —— 供界面展示

    /**
     * 常驻通道（`slurmate stream`）。**没有它一切照常** —— `rpc()` 会走 exec。
     *
     * ★ 它跟 `_conn` 同生共死：SSH 断了它就没了，`_conn` 重建时要重新开一条。
     */
    this._resident = null;
    /** 常驻通道**没能**建起来的原因。给诊断用 —— 它不是错误，只是一种降级。 */
    this.residentError = null;
    this._streamTimer = null;
    this._streamAttempt = 0;
    /**
     * 被另一个客户端顶掉了（`{reason, by, at}`），没被顶就是 `null`。
     *
     * ★★ 这是一个**终态**，不是一个降级：进入之后 `rpc()` 一律拒绝、常驻通道
     *    也不再重开。**关键在于它不能让调用方悄悄退回 exec。**
     *
     *    少了这条，被顶掉的客户端会安静地走 exec 继续干活 —— 界面完全正常、
     *    心跳照发、状态照查，而"你已经被另一台电脑接管了"这件事**一个字都不
     *    会出现**。那正是这一版最该避免的失败形态：一个只在协议层成立、
     *    在界面上看不见的状态。
     */
    this._displaced = null;
  }

  /**
   * 常驻通道现在是不是可用。界面与用例问的是这个，不是私有字段叫什么。
   *
   * ★ 三态是**故意**的：`null` = 还没试过（还没连上登录节点），`false` = 试过、
   *   不通，`true` = 在。把"还没试"和"试过不通"合并成 `false`，会让启动阶段
   *   的日志说出一句当时并不成立的话。
   */
  get resident() { return this._resident ? true : (this._conn ? false : null); }

  /** 被另一个客户端顶掉了没有。`{reason, by, at}`，没被顶就是 `null`。 */
  get displaced() { return this._displaced; }

  /**
   * 调用方（index.js 的启动接续）问的是「有没有连上」，不是「你的私有字段叫什么」。
   * 见 backend.js 的接口注释。连接中途断开时 `_conn` 会被置回 null，所以跟着它就是准的。
   */
  get connected() { return Boolean(this._conn); }

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
    // ★★ **这里是"被顶掉"唯一的出口，而它必须是显式的用户动作。**
    //   自动重连（`_openOnce` 那条路）走不到这里 —— 这正是要的：被顶掉的客户端
    //   不自动回来。用户点「连接」才会走到这一行。
    this._displaced = null;
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
    // parseKey 在输入里含多把密钥时返回**数组**。不先摊平的话，下面 `.isPrivateKey()`
    // 会在数组上抛 TypeError，穿出「不抛异常」的契约。
    const key = Array.isArray(parsed)
      ? parsed.find((k) => k && typeof k.isPrivateKey === 'function' && k.isPrivateKey())
      : parsed;
    if (parsed instanceof Error || !key) {
      return {
        ok: false,
        code: 'bad_private_key',
        error: '本机保存的 SSH 私钥无法解析（'
             + (parsed instanceof Error ? parsed.message : '不是私钥') + '）。'
             + '请在这一条连接的「编辑」里重新生成密钥，并把新的公钥重新注册到 IDM。',
      };
    }
    // 记下**这次真正出示的是哪把钥匙**。认证失败时唯一有价值的线索就是它 ——
    // 没有它，用户只能对着一句「认证失败」反复重试。
    this._offeredKey = {
      keyType: key.type || null,
      keyFingerprint: hostKeyFingerprint(key.getPublicSSH()),
      publicKeyLine: (() => {
        const blob = key.getPublicSSH();
        return Buffer.isBuffer(blob) ? `${key.type} ${blob.toString('base64')} slurmate` : null;
      })(),
    };
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
    // ★ 短路这一支**也必须带上 `daemonVersion`**。少了它，调用方（index.js 的
    //   版本闸）在"已经连着、再连一次"时会拿到 `undefined`，而 `undefined` 在
    //   那条判定的三态里是"答了却没有版本号" ⇒ 每一次重连都误报一句
    //   "对面不是我们的守护进程"。它连的明明就是上一次那一台。
    if (this._conn) {
      return Promise.resolve({
        ok: true, whoami: this._whoami, daemonVersion: this._daemonVersion,
      });
    }
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
      let rejected = null;       // 主机密钥被拒时的原因

      const done = (res) => { if (!settled) { settled = true; resolve(res); } };

      client.on('ready', async () => {
        this._conn = client;
        this._attempt = 0;
        this._emitState(true, `${user}@${host}:${port}`);

        // ★★ **先把常驻通道建起来（尽力而为）**，再走下面那套握手。
        //
        //   放在这里而不是 connect() 的开头：它要在 SSH 通了**之后**、第一条
        //   RPC **之前**。放后面的话，握手那两条（ping/whoami）会白走一次 exec，
        //   而它们正是最该走常驻通道的那两条 —— 每次连接都多 fork 一个 python。
        //
        //   ★ 它**绝不**让 connect() 失败：建不起来就退回去用 exec，而"为什么
        //     建不起来"记在 `residentError` 里。理由见文件头那一段。
        await this._openStream();

        // ★ 版本握手 —— **在 whoami 之前**问一次 ping。
        //
        //   `ping` 与它返回的 `version` **自初始提交起就在**，所以这一问对
        //   **每一个曾经部署过的守护进程**都有效 —— 这正是"客户端要能兼容老版本
        //   服务端"那条要求能成立的前提。反过来（让守护进程问客户端）做不到：
        //   老客户端不带版本，见 docs/PROTOCOL.md。
        //
        //   ★ **判定不在这里**：规则在 plugins/index.js 的 `versionCheck` 里，
        //     闸在 index.js —— 演示后端也要过同一道闸，而 index.js 是这两个后端
        //     唯一的交汇点。这里只负责"把版本问出来"，以及把"问不到"的几种情况
        //     分开（它们是三个不同的结论，不是一个）。
        const ping = await this.rpc({ op: 'ping' });
        const noPing = Boolean(ping && !ping.ok && ping.error
          && ping.error.kind === 'unknown_op');
        // 三态（`undefined` ≠ `null`，本仓库的老纪律）：
        //   字符串    —— 问到了；
        //   null      —— 没问到（对面根本没有 `ping` 这个 op）；
        //   undefined —— 答了一个对象，但里面没有 `version`。
        // 后两者都不是"旧"，`versionCheck` 会给它们各自一个名字。
        let daemonVersion = null;
        if (ping && ping.ok) {
          daemonVersion = (ping.data || {}).version;
        } else if (!noPing) {
          // 问不到、也不是"对面没有这个 op" ⇒ 这条链路本身有问题。
          // 与下面 whoami 的失败走同一条路：**如实报告**，别以为连上了。
          const why = (ping && ping.error && (ping.error.detail || ping.error.kind))
            || '未知原因';
          try { client.end(); } catch { /* 尽力 */ }
          this._conn = null;
          return done({
            ok: false,
            code: 'rpc_unavailable',
            error: `已连上 ${host}，但无法执行 \`${RPC_CMD}\`：${why}`,
          });
        }

        // 顺手拿一次 whoami：它既验证「RPC 这条链路真的通」（而不只是 SSH 握手成功），
        // 又给界面提供账户与分区权限。**失败要如实报告** —— 这条链路不通时，
        // 界面必须知道，而不是以为连上了。
        const resp = await this.rpc({ op: 'whoami' });
        if (resp && resp.ok) {
          this._whoami = resp.data;
          this._daemonVersion = daemonVersion;
          return done({ ok: true, whoami: resp.data, daemonVersion });
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
        const msg = (e && e.message) || '未知错误';
        // ★ 认证失败要单独识别。ssh2 的原话（「All configured authentication
        //   methods failed」）直接透出去，用户看到的是又一句不指向任何根因的英文，
        //   而它的真实含义很具体：**服务器不认这把钥匙**。
        if (AUTH_FAILED_RE.test(msg)) {
          const { user, host, port } = this._profile;
          return done({
            ok: false,
            code: 'auth_failed',
            error: authFailureDetail({ user, host, port, ...(this._offeredKey || {}) }),
          });
        }
        done({ ok: false, error: `SSH 连接失败：${msg}` });
      });

      client.on('close', () => {
        if (this._conn === client) {
          this._conn = null;
          this._whoami = null;
          this._daemonVersion = null;   // 与 _conn 同生共死，理由见构造器
          // ★ 常驻通道也同生共死，而且要**先摘掉重开定时器** —— 不摘的话，SSH
          //   断开之后那个定时器会去重开一条属于**上一条 SSH 连接**的通道，
          //   而它现在连 `_conn` 都是 null，只会在日志里留下一句莫名其妙的失败。
          this._teardownStream();
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

  // ── 常驻通道 ────────────────────────────────────────────────────────────
  /**
   * 建一条常驻通道，并**探一次针**证明它真的能用。
   *
   * 尽力而为：任何一步失败都只是把 `_resident` 留在 null（于是 `rpc()` 走 exec），
   * 并把原因记进 `residentError`。它**不抛异常**、也**不**让 connect() 失败。
   *
   * ★ 探针（一句 `ping`）不是多余的谨慎：`exec` 成功只说明**命令被启动了**。
   *   旧 CLI 上 `slurmate stream` 会立刻以 argparse 的退出码 2 结束（一行 usage
   *   进 stderr），而那条通道在客户端看来与一条正常的通道别无二致 —— 直到第一条
   *   真请求永远等不到响应。见 STREAM_PROBE_MS。
   *
   * @returns {Promise<boolean>} 这条通道现在可用吗
   */
  _openStream() {
    // ★ `_displaced` 与 `_closed` 同一档：被顶掉之后**再也不开**这条通道。
    //   少这一句的话，顶替事件之后那次正常的"通道断了 ⇒ 重开"会立刻把连接
    //   建回来，而守护进程那边会把它当成**同一个客户端又连上来了**，
    //   于是让当前那个客户端让位 —— 两边互相顶，**没有终点**。
    if (this._resident || !this._conn || this._closed || this._displaced) {
      return Promise.resolve(false);
    }
    const conn = this._conn;
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = (v) => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        resolve(v);
      };
      // ★★ 外层的兜底：`conn.exec` 的回调**不保证会来** —— SSH 连接正好在那一瞬间
      //    断掉时它永远不触发。没有它，`connect()` 的 ready 处理会停在这里，
      //    而 `readyTimeout` 只管握手那一段，管不到这里 ——
      //    用户看到的是"点了没反应"，没有任何地方报错。
      //    ★ 它比探针宽 2 秒：正常情况下结束这次等待的**总是**探针。
      timer = setTimeout(() => {
        this.residentError = '建立常驻通道时超时（命令通道没有回应）';
        this._scheduleStreamReopen();
        done(false);
      }, STREAM_PROBE_MS + 2000);
      timer.unref?.();
      try {
        conn.exec(STREAM_CMD, (err, stream) => {
          // 兜底已经先把话说完了：这条通道现在属于一个已经结束的等待，
          // 别把它挂上去（那正是"挂上一条死通道"的另一种形态）。
          if (settled) { try { stream?.close?.(); } catch { /* 尽力 */ } return; }
          if (err) {
            this.residentError = '无法在登录节点上执行命令：' + err.message;
            this._scheduleStreamReopen();
            return done(false);
          }
          const ch = new ResidentChannel(stream, {
            // ★ 两种通知在这里分道，见 `_onResidentNotify`。
            onNotify: (msg) => this._onResidentNotify(msg),
            onClose: (why, deliberate) => this._onResidentClose(ch, why, deliberate),
            // 这台电脑是谁。**每一条请求都带上**（见 ResidentChannel.request）。
            client: this._opts.client || null,
          });
          ch.request({ op: 'ping' }, STREAM_PROBE_MS).then((resp) => {
            // ★ 判据是"**对面**答了一个信封"，**不是** `ok:true`：限流
            //   （`rate_limited`）也是一次正常的往返，它同样证明这条通道是通的。
            //   拿 `ok` 去判会把一次限流记成"这是条坏通道"，然后降级一整个进程。
            //
            // ★★ 而 `kind: 'transport'` 必须**排除掉** —— 那是**我们自己**合成的
            //    信封（见 `transportError`），通道一死 `request()` 就立刻拿它结账。
            //    它有布尔 `ok`（false），所以只判 `typeof ok === 'boolean'` 的话，
            //    **一条刚建立就死掉的通道会被判成可用**：`_resident` 挂上去，
    //    此后每一条 rpc 都发进一条死通道，而 `resident` 还报 true。
            //    这个 `kind` 是客户端独有的，守护进程从不发（它的所有错误都走
            //    `_err(code, kind)`，kind 是 `not_found` / `rate_limited` 那几种）。
            const fromPeer = resp && typeof resp.ok === 'boolean'
              && !(resp.error && resp.error.kind === 'transport');
            if (fromPeer) {
              this._resident = ch;
              this.residentError = null;
              this._streamAttempt = 0;
              return done(true);
            }
            this.residentError = (resp && resp.error
              && (resp.error.detail || resp.error.kind)) || '这条通道没有应答';
            ch.close();
            // ★ 失败也要排下一次：这一句覆盖的是"**登录节点上的守护进程正好在
            //   重启**"这一类**暂时**的失败。而"CLI 是旧的"那种**永久**的失败由
            //   `_scheduleStreamReopen` 里的次数上限挡住 —— 两者的现场一模一样
            //   （一行 usage + 退出码 2），区分不了，所以只能靠"试几次就不再试"。
            this._scheduleStreamReopen();
            done(false);
          });
        });
      } catch (e) {
        this.residentError = '建立常驻通道时出错：' + ((e && e.message) || '未知错误');
        this._scheduleStreamReopen();
        done(false);
      }
    });
  }

  /**
   * 常驻通道断了。
   *
   * ★ **不放弃**：SSH 本身还活着的话就再开一条。只降级不回补的话，这条通道一辈子
   *   只坏一次，客户端此后永远按 60 秒轮询 —— 也就是**静默地**退回到这一版之前
   *   的行为，而界面上没有任何东西会提这件事。
   *
   * ★ 我们自己关的（探针失败、后端在拆）**不重开**：那两种情况下重开都是错的，
   *   而探针失败重开还会变成一个重开风暴。
   */
  _onResidentClose(ch, why, deliberate) {
    if (this._resident === ch) this._resident = null;
    if (deliberate || this._closed || !this._conn) return;
    this.residentError = why;
    this._scheduleStreamReopen();
  }

  /**
   * 常驻通道上来了一个通知。**两种通知在这里分道。**
   *
   * ★ `sessions` 往上抛（那是 session.js 的事）；`displaced` 留在这里 ——
   *   它是**这台客户端**的状态，不是某一条会话的状态。抛给 session.js 的话，
   *   每个控制器都会各自处理一遍"我被顶掉了"，而它们谁也停不掉别人。
   */
  _onResidentNotify(msg) {
    if (msg && msg.push === 'displaced') return this._onDisplaced(msg);
    this.emit('notify', msg);
  }

  _onDisplaced(msg) {
    if (this._displaced) return;                     // 只认第一条
    const by = (msg && msg.by) || null;
    const reason = (msg && msg.reason) || '另一个客户端接管了';
    const who = (by && by.name) || '另一台电脑';
    this._displaced = {
      reason,
      by,
      at: (msg && typeof msg.at === 'number')
        ? msg.at : Math.floor(Date.now() / 1000),
      /**
       * ★★ 那句人话**在这里只写一遍**。它有两个去处（拒绝 `rpc()` 时的原因、
       *    诊断），而"被谁顶的"这个信息只在通知里 —— 少了它，用户看到的是
       *    「被顶掉了」却不知道被谁顶的，下一步就是重启客户端，然后再被顶一次。
       *    写两遍就会漂，漂的方向永远是其中一处少了 `who`。
       */
      detail: `本机已被「${who}」上的客户端顶掉（${reason}）。`
            + '这个动作没有发出去 —— 点「连接」取回之后再做一次。',
    };
    // ★ 先拆通道、再抛事件：订阅方（index.js）收到事件会立刻停掉所有会话的
    //   定时器，而那条通道对谁都没用了。让它活着的话，它会在关闭之前再送一条
    //   推送进来 —— 而那时订阅方已经不在听了（那条推送就此消失，没有任何痕迹）。
    this.residentError = '已被另一个客户端顶掉';
    this._teardownStream();
    this.emit('displaced', this._displaced);
  }

  _scheduleStreamReopen() {
    if (this._closed || !this._conn || this._streamTimer || this._displaced) return;
    // 连着失败够多次就不再试 —— 见 STREAM_ATTEMPT_MAX。此后这一条 SSH 连接上
    // 一直走 exec，而这正是"从前的行为"，不是坏掉的状态。
    if (this._streamAttempt >= STREAM_ATTEMPT_MAX) return;
    const delay = Math.min(
      STREAM_REOPEN_MIN_MS * (2 ** this._streamAttempt), STREAM_REOPEN_MAX_MS);
    this._streamAttempt += 1;
    this._streamTimer = setTimeout(() => {
      this._streamTimer = null;
      if (this._closed || !this._conn) return;
      this._openStream().catch(() => { /* 下一次 close 会再排 */ });
    }, delay);
    this._streamTimer.unref?.();
  }

  /** 拆掉常驻通道与它的重开定时器。**不重开。** */
  _teardownStream() {
    if (this._streamTimer) { clearTimeout(this._streamTimer); this._streamTimer = null; }
    this._streamAttempt = 0;
    const ch = this._resident;
    this._resident = null;
    if (ch) { try { ch.close(); } catch { /* 尽力 */ } }
  }

  /**
   * 发一次 RPC。
   *
   * **契约：不抛异常。** 传输层失败返回一个 `kind='transport'` 的信封，由
   * classify.js 统一分类 —— 调用方（session.js）从不 try/catch rpc 的返回值。
   */
  async rpc(req) {
    // ★★ 被顶掉之后**一律拒绝，绝不退回 exec**。
    //
    //   退回去的后果是具体的：这个客户端会安静地继续干活（心跳照发、状态照查、
    //   界面完全正常），而"你已经被另一台电脑接管了"**一个字都不会出现**。
    //   那正是这一版最该避免的形态 —— 一个只在协议层成立、在界面上看不见的状态。
    //
    //   ★ 拒绝也是**对的语义**：手动点「停止会话」这类动作会让守护进程 scancel
    //     用户的作业，而用户此刻以为自己在另一台电脑上操作。
    if (this._displaced) {
      return displacedError(this._displaced.detail);
    }
    // ★★ 常驻通道在，就走它。**这是这一版唯一改变行为的一行。**
    //
    //   判据是"现在有没有一条活的常驻通道"，而它是一条**每时每刻都在变**的事实：
    //   没建起来、断了、正在重开，都落到下面那条 exec 路上 ——
    //   于是"降级"不需要任何一处 try/catch，它就是同一个函数的下一个分支。
    if (this._resident && !this._resident.dead) {
      return this._resident.request(req);
    }
    let conn;
    try {
      conn = await this._ensure();
    } catch (e) {
      return transportError(e.message);
    }
    if (!conn) return transportError('尚未连接到登录节点');

    // ★★★ **exec 这条路上永远不发 `rid`。**
    //
    //   它在守护进程那边是"这条连接从此收推送"的判据（见 handle_line），而这条
    //   连接是**一次性的**：发了 `rid`，守护进程会把推送写进一条马上要被关掉的
    //   连接。更糟的是那条连接上的响应**与推送共用同一个输出队列** —— 于是
    //   一次恰好落在 tick 上的推送会被读成这条请求的应答。
    //
    //   写成"复制一份再删掉"而不是"要求调用方别传"：调用方（session.js）
    //   只发业务字段，但**不变量不能住在调用方的自觉里**。
    //
    // ★★ `client` 与 `rid` 在这里是**同一条规矩**：它也一样只在常驻通道上发。
    //    守护进程那边的门槛是 `conn.subscribed`（"这条连接发过带 rid 的请求"），
    //    所以今天即使漏了这一行也不会出事 —— 但那正是"两层各守一半"，
    //    而两层里任何一层被下一个人改掉，症状都是「客户端每降级一次 exec，
    //    就把自己那条常驻通道顶掉一次」。
    const body = { ...req };
    delete body.rid;
    delete body.client;

    return new Promise((resolve) => {
      conn.exec(RPC_CMD, (err, stream) => {
        if (err) return resolve(transportError('无法在登录节点上执行命令：' + err.message));

        let stdout = '';
        let stderr = '';
        let gotExit = false;
        let finished = false;
        // ★ 与常驻通道同一个理由（见 ResidentChannel 里的 `_dec`）：按 chunk 各转一次
        //   字符串会把跨边界的多字节字符撕成 U+FFFD，而那是**间歇性**的。
        const dec = new StringDecoder('utf8');
        const finish = (res) => { if (!finished) { finished = true; resolve(res); } };

        stream.on('data', (d) => {
          stdout += dec.write(d);
          if (stdout.length > MAX_RESPONSE_BYTES) {
            try { stream.close(); } catch { /* 尽力 */ }
            finish(transportError('应答过大，已中止（对面回的可能不是 Slurmate 的协议）。'));
          }
        });
        stream.stderr.on('data', (d) => { stderr += d; });
        stream.on('exit', () => { gotExit = true; });
        stream.on('error', (e) => finish(transportError('通道出错：' + e.message)));
        stream.on('close', () => {
          stdout += dec.end();     // 最后那几个字节（同样可能是半个字符）
          // 不因为「没收到 exit 事件」就当成失败 —— 宁可不丢一个合法应答。
          const picked = pickEnvelope(stdout);
          if (picked.found) return finish(picked.envelope);

          // 一行都没解析出来。把**原始输出**一并报出来，别只留一句「解析失败」——
          // 这正是「rc 文件污染 / 守护进程没装 / 被 guard 拦了 / python 崩了」
          // 四种情况的共同现场，而它们的修法完全不同。
          const parts = ['登录节点没有返回可解析的应答'];
          if (!gotExit) parts.push('（命令通道被关闭，未收到退出状态）');
          const errText = stderr.trim().split('\n').slice(0, 3).join(' / ');
          if (errText) parts.push('：' + errText);
          else if (picked.lines.length === 0) parts.push('（输出为空）');
          else {
            parts.push(`（收到 ${picked.lines.length} 行输出，都不是协议应答：`
              + picked.lines.slice(0, 3).join(' / ').slice(0, 200) + '）');
          }
          finish(transportError(parts.join('')));
        });

        // 请求体走 **stdin**，绝不进命令行 —— argv 是常量这件事靠这里保持。
        stream.end(JSON.stringify(body) + '\n');
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
    this._teardownStream();
    const c = this._conn;
    this._conn = null;
    this._whoami = null;
    this._daemonVersion = null;   // 与 _conn 同生共死，理由见构造器
    if (c) { try { c.end(); } catch { /* 尽力而为 */ } }
  }
}

/** 已实现。上面的三条实测假设与固定 argv 都到位了。 */
function isImplemented() {
  return true;
}

module.exports = {
  isImplemented, SshBackend, RPC_CMD, STREAM_CMD,
  hostKeyFingerprint, hostKeyAlgorithm,
  displacedError,     // 同上：「被顶掉」与「传输失败」必须分得开
  pickEnvelope,       // 导出给测试：它是纯函数，规则又值得钉住
  parseEnvelopeLine,  // 同上：exec 与常驻通道共用同一条「什么算一条消息」的判据
  ResidentChannel,    // 同上：它只认字节与行，所以不连 SSH 也验得了
  authFailureDetail,  // 同上：这是「认证失败」唯一能指向根因的东西
  AUTH_FAILED_RE,
  RPC_TIMEOUT_MS, STREAM_PROBE_MS,
};
