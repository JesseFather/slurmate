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
 * backend-ssh.js —— 真实后端（ssh2 + 纯公钥认证）。
 *
 * ── 认证方式：只用密钥，不接受密码 ──────────────────────────────────────────
 *
 * 私钥由客户端自托管（`keys.js` 生成，`config.js` 保管），不读用户的 ~/.ssh。
 * 公钥由用户在界面上复制、自己去 IDM 注册。理由见 keys.js 的文件头。
 *
 * ️ 走这条路之前，有三条假设必须先用系统 ssh 实测证明（五分钟，零代码）。
 *    仓库里至今没有一条实测结论，全是推断；第 1、2 条不成立则本文件整个作废：
 *
 *      # 假设 A：sshd 的 ForceCommand（若你的集群装了）放行固定 argv 的 slurmate rpc
 *      # 必须原样用下面这条：外层双引号保住内层单引号，否则本地 shell 会先把
 *      #     引号吃掉，ssh 发过去的是另一个命令串，验的就不是客户端真正发的那个了。
 *      ssh -T -p 22 user@<登录节点> \
 *          -- "/bin/bash -c '/usr/local/bin/slurmate rpc'" <<< '{"op":"ping"}'
 *      #   期望：恰好一行 JSON，ok:true，退出码 0。有额外输出就是没直通。
 *      #
 *      #   背景：有些集群会给普通用户的 sshd 装一个 ForceCommand 拦截器来管
 *      #   web-demo 的端口。这类拦截器通常是 fail-open 的（命令串里不含
 *      #   web-demo 字面量就直通），所以固定 argv 的 `slurmate rpc` 应当能过 ——
 *      #   但这是【依赖】，必须实测证明，不能假设。
 *
 *      # 假设 B：ForceCommand 不影响 direct-tcpip 转发
 *      ssh -N -L 18080:<tunnel_target> user@<登录节点> -p 22 &
 *      curl -i http://127.0.0.1:18080/healthz     # 期望 200
 *
 *      # 假设 C：登录节点允许公钥认证
 *      ssh -i <新密钥> -o BatchMode=yes -o PasswordAuthentication=no ... true
 *
 * ── 固定 argv ──────────────────────────────────────────────────────────────
 *
 * RPC_CMD 是编译期字符串常量，用户输入永远不出现在命令串里。这既是防注入，
 * 也是穿过上面那个 guard 的必要条件（命令里不能出现 web-demo 字面量）。
 * 【不提供】让用户自定义命令行的开关 —— 自定义的命令行不通用，而这个客户端
 * 没有大模型能自适应，它只能跑预设的辅助命令。
 *
 * ── 主机密钥 ───────────────────────────────────────────────────────────────
 *
 * ssh2 默认不校验主机密钥。只走公钥认证却不校验对端，会退化成一个
 * 「不校验身份的加密连接」—— 比口令认证更糟。所以这里实现 TOFU：
 *   已知且一致 → 放行
 *   第一次见   → 拒绝，并把指纹交回给界面让用户确认（确认后由调用方记住再重连）
 *   变了   → 永远拒绝。不是警告：主机密钥变了意味着中间人或者服务器重装，
 *                两种情况下继续连都是把私钥认证交给一个不确定的对端。
 *
 * ── 两条链路：exec 与常驻通道 ─────────────────────────────────────────────
 *
 * 一次 `slurmate rpc` = 一个 exec channel = sshd fork + PAM session + bash +
 * python3 冷启动。而守护进程是单线程同步的，tick 里的 phase_running 会为
 * 所有用户的所有会话各 fork 一次 squeue。所以高频轮询是在给这个循环加压，
 * 受害的是所有人。
 *
 * 第二条链路是 `slurmate stream`：一条常驻连接承载很多请求，
 * 服务端还能主动推。收益不只是省掉每次的 python 冷启动 —— session.js 的
 * 60 秒对账由推送驱动（快照 30 秒一次、有变化 2 秒内到），exec 只在
 * 实质变化时发生。
 *
 * 一条 SSH 连接上的执行只用这一条 exec：它从连上起活到断开为止，作业日志目录
 * 也在它里面建（见 `STREAM_CMD`）。于是"开一条新的 exec 很贵"这件事只在退路上
 * 成立 —— 而退路启用时，那条连接上本来就没有别的路可走。
 *
 * 而 exec 那条链路没有删，它是退路。"起不来就退回去"不是容错装饰：
 *    常驻通道会因为"登录节点上的 CLI 还是旧的（没有 `stream` 这个子命令）"、
 *    "ForceCommand 拦了"、"守护进程没在跑"而起不来，这几种情况下客户端必须
 *    照常能用。判据在 session.js 的推送看门狗（`PUSH_STALE_MS`）—— 一条推送
 *    都没收到时，那边的对账逐字回到纯 exec 轮询。
 *
 * ── 提交（submit）的特殊约束 ────────────────────────────────────────────
 *
 * `op_submit` 非幂等，且 `count_active` 只数 ACL_STATES（`submitted` 不在内），
 * 配额拦不住并发的第二个。所以：超时必须 ≥ 45s，超时绝不重试，
 * 改为调一次不带 session_id 的 status 去认领。见 session.js 的 SUBMIT_TIMEOUT_MS。
 */

const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const ssh2 = require('ssh2');

const { Backend, KIND } = require('./backend.js');

/**
 * 固定 argv。常量，不接受任何用户输入拼接。
 *
 * 显式走 `/bin/bash -c`，不用「登录 shell 是什么就用什么」。
 *
 *   sshd 执行 exec 请求的方式是 `$SHELL -c "<命令串>"`，而 `$SHELL` 来自
 *   /etc/passwd —— 在 HPC 登录节点上经常是 zsh。zsh 与 bash 并非完全互通，
 *   同一条命令串在一边能跑、在另一边是语法错误。我们发的是写死的命令串，
 *   一旦它用上某个 shell 的方言，症状会是「在这台机器上能连、换一台就认证失败」
 *   这类指不回根因的问题。把解释器钉死，等于把这条变量从等式里去掉。
 *
 * 但它挡不住 rc 文件，别把这两件事混起来：sshd 仍然先用登录 shell 解释
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
 * 作业日志目录那一条 `mkdir`。两条命令共用这一句。
 *
 * 一份规矩只有一处实现：常驻通道那条把它塞在自己前面跑（见 `STREAM_CMD`），
 *   退路那条整条就是它（见 `PREPARE_CMD`）。两处各写一遍的话，改了一处、另一处
 *   还是老路径，而症状只出现在「常驻通道建不起来」的那一类站点上。
 *
 * `umask 077` 与作业脚本里那个一致 —— 建出来的目录是 0700。
 *   `$HOME` 由内层 bash 展开（外层那对单引号里的内容是原样传过去的）。
 */
const LOGS_MKDIR = 'mkdir -p "$HOME/.slurmate/logs"';

/**
 * 会话文件目录。客户端不写它，但会把它建出来并钉成私有 ——
 *   守护进程读会话文件时只检查 `.slurmate` 及其子目录（家目录归用户处置，
 *   见 `slurmate-sessiond` 的 `load_session_file()`）。
 */
const SESS_MKDIR = 'mkdir -p "$HOME/.slurmate/sessions"';

/**
 * 把本系统自己的那三格钉成 0700。
 *
 * `mkdir -p` 只对新建目录生效；一个从前用宽松 umask 建出来的 `.slurmate`
 *   会一直保持原模式，而守护进程的检查照样会拒。客户端能保证的是自己这一格：
 *   这三级的属主是用户，客户端以他的身份执行，改得动。
 */
const HOME_PRIVATE = 'chmod 700 "$HOME/.slurmate" "$HOME/.slurmate/logs"'
  + ' "$HOME/.slurmate/sessions"';

/**
 * 常驻通道上那一段建目录的回执，走 stderr。
 *
 * 它为什么不是一条协议消息：协议那条 stdout 是守护进程的（CLI 是个字节泵，
 *   不解析、不重放，见 `cluster/slurmate` 的 `cmd_stream`）。这一句是客户端
 *   自己塞进命令串里的，回执也就走客户端自己那一条 —— stderr。
 * 两句话只有这一段 shell 与 `_onStreamStderr` 认识。
 */
const PREPARE_OK = 'slurmate prepare: ok';
const PREPARE_FAIL = 'slurmate prepare: failed';

/**
 * 常驻通道的命令行。同样是编译期常量。
 *
 * 它比 `RPC_CMD` 多一段：先把作业日志目录建出来，然后 `exec` 成
 *   `slurmate stream`。于是正常路径下一条 SSH 连接只有这一条 exec ——
 *   从连上到断开为止都是它，建目录那次冷访问也落在它里面。
 *
 * 建目录放在后台是承重的：冷挂载的第一次访问要几十秒（见 `PREPARE_TIMEOUT_MS`），
 *   而这条通道是握手要走的路 —— 等它就等于把「已连接」卡在一条 mkdir 上，
 *   真机 2026-10-16 正是这样。它的回执是一行 stderr，建不出来也拦不住通道。
 *   它自己那份兜底由客户端的 `PREPARE_TIMEOUT_MS` 管。
 *
 * 二进制路径与 `RPC_CMD` 分头写死是有意的：这一串里一个用户输入都没有，
 *   看一眼就知道。代价是路径写了两遍 —— 有一条用例钉住两者用的是同一个。
 */
const STREAM_CMD = "/bin/bash -c '"
  + '( umask 077; if ' + LOGS_MKDIR + ' && ' + SESS_MKDIR + ' && ' + HOME_PRIVATE
  + '; then printf "' + PREPARE_OK + '\\n" >&2'
  + '; else printf "' + PREPARE_FAIL + ' %s\\n" "$?" >&2; fi ) >/dev/null & '
  + "exec /usr/local/bin/slurmate stream'";

/**
 * 建作业日志目录那条退路：常驻通道建不起来时，单独开一条 exec 去建它。
 *
 * 为什么客户端要干这一件事：`sbatch -o <日志目录>/slurm-%j.out` 的父目录是
 *    Slurm 在跑作业脚本之前打开的，而作业脚本自己那一次 `mkdir -p` 排在它后面
 *    —— 目录不存在，那一次提交的作业连启动都启动不了。而守护进程建不了它：
 *    systemd 单元把整个文件系统挂成只读（`ProtectSystem=strict`），那是"root 身上没有
 *    『写用户文件』这条攻击面"那层保护。
 *
 *    于是三层里只剩客户端这一层。正常路径下这一条不跑（目录由 `STREAM_CMD`
 *    那一条 exec 建）；它跑的时候，站点上的 CLI 是旧的、或者被 guard 拦了 ——
 *    那时常驻通道根本没有，而"目录存在"这条前提仍然要成立。
 *
 * 与另外两条一样是编译期常量：不接受任何用户输入拼接。
 */
const PREPARE_CMD = "/bin/bash -c 'umask 077; " + LOGS_MKDIR + " && " + SESS_MKDIR
  + " && " + HOME_PRIVATE + "'";

const READY_TIMEOUT_MS = 20000;
const KEEPALIVE_INTERVAL_MS = 10000;
const KEEPALIVE_COUNT_MAX = 6;
/** 单次应答的上限。正常响应是几百字节；超过这个数说明对面回的不是我们的协议。 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RECONNECT_MIN_MS = 1000;
/**
 * 建日志目录那一条命令自己的兜底上限。
 *
 * 一条 `mkdir` 本该眨眼就完（本机在同一个共享盘上实测 3 毫秒），但这一条落在
 *   用户的家目录里 —— 那一次访问可能落在冷挂载上：真机 2026-10-16 就是这样，
 *   那一次 15 秒没回来。90 秒是给冷挂载留的余量。
 *
 * 它管两处：退路那条 exec 自己的超时，以及常驻通道上那句回执的等待上限
 *   （`_waitChannelPrepare`）。两处是同一件事的两种走法，所以是同一个数。
 *
 * 没有人等满它：连接不等它（见 `_openOnce`），提交之前那一次另有预算
 *   （`PREPARE_SUBMIT_BUDGET_MS`）。没有它的话，一条断在半路的 exec 会让那个
 *   promise 永远挂着，而等它的人也就永远等下去。
 */
const PREPARE_TIMEOUT_MS = 90000;
/**
 * 提交之前等那一次建目录的上限。
 *
 * 与上一个数分开，因为等它的不是同一个人：连接那一次是后台热身，没人等；
 *   提交那一次是用户按完「开始会话」在等，等满 90 秒是不可接受的。取 15 秒 ——
 *   它正是 0.22 里连接时用的那个数，也就是真机上量出来「不该那么长时间」的那个。
 *
 * 到点【放行提交】，不算失败：一条没回来的 `mkdir` 不能证明目录不在
 *   （真机 2026-10-16 就是这样，客户端报超时，而目录真的建出来了）。
 *   只有那条命令真的跑了、并明确失败（非零退出）才算数，见 `ensurePrepared()`。
 */
const PREPARE_SUBMIT_BUDGET_MS = 15000;
const RECONNECT_MAX_MS = 30000;

/**
 * 常驻通道的探针超时：建起来之后先问一句 `ping`，答得上来才算这条通道可用。
 *
 * 必须有这一句，否则"通道起来了"与"通道能用"会被当成同一件事 ——
 *   `exec` 请求成功只说明命令被启动了，而 `slurmate stream` 完全可能
 *   立刻报错退出（旧 CLI 没有这个子命令时 argparse 就是这样：一行 usage、
 *   退出码 2）。不探针的话，第一条真请求才会发现，而那时客户端已经在
 *   等一个永远不会来的响应了。
 *
 * 取 8 秒：这一问走的是已经建好的 SSH 连接，正常是几十毫秒。
 */
const STREAM_PROBE_MS = 8000;

/**
 * 常驻通道上单条请求的兜底超时。
 *
 * 它是兜底，不是语义上的超时 —— 语义超时在调用点各自有
 *    （submit 45 秒、goodbye 10 秒、claim 20 秒，见 session.js）。
 *    取一个比它们都大的值，否则它会抢先切断一条合法请求，而症状是
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
 * 必须有个头。登录节点上的 CLI 是旧的（没有 `stream` 这个子命令）时，
 *   每一次重开都是一次注定失败的 exec —— 而它换来的是每分钟多 fork 一个
 *   python，比这一版想省掉的那个还贵。那种情况下正确的是：记下原因、退回
 *   exec、不再试。
 * 而"连着三次都失败"与"曾经成功过又断了"要分得开：后者会把计数清零，
 *   于是重开一条曾经好用的通道永远有配额（见 `_openStream` 成功那一支）。
 */
const STREAM_ATTEMPT_MAX = 3;

/**
 * 等一个结果，但最多等 `budgetMs` 毫秒；到点就回一个「没等到」。
 *
 * 它与 `session.js` 的 `withTimeout` 不是同一件事：那一个超时就抛，因为调用方
 *   要的是"这一次请求没成"；这一个只是不再等 —— 那件事可能还在路上，而调用方
 *   要的是"别为它把用户挡在这儿"。
 *
 * 返回的形状与 `prepare()` 失败时那份一致（`definite: false`），于是调用方
 *   不必区分"没等到"与"还没连上"：两种都是"没拿到结论，照常往下走"。
 * 底层那个 promise 不去动它 —— 它自己有兜底超时，回来了也没人接而已。
 */
function withinBudget(p, budgetMs) {
  const noConclusion = { ok: false, error: null, definite: false };
  if (!(budgetMs > 0)) return p;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(noConclusion), budgetMs);
    timer.unref?.();      // 别为一条等不到的 promise 把事件循环撑住
    p.then((v) => { clearTimeout(timer); done(v); },
           () => { clearTimeout(timer); done(noConclusion); });
  });
}

/**
 * 建目录那件事的一个结论。
 *
 * 两条走法（exec 的退出码、常驻通道上那一行回执）都从这里长出来：`definite`
 *   是提交那一步唯一的判据，两条路各写一份的话，它的语义迟早会漂开。
 *   `detail` 是站点自己吐的那一句（只有 exec 那条路拿得到 stderr）。
 */
function prepareResult(ok, rc, detail) {
  if (ok) return { ok: true, error: null, definite: false };
  const tail = detail ? '：' + String(detail).trim().split('\n')[0] : '';
  return {
    ok: false,
    definite: true,
    error: '建作业日志目录失败（rc=' + (rc == null ? '?' : rc) + '）'
      + tail + '，家目录可写吗？',
  };
}

/**
 * 一行是不是协议消息。这条判据只有一份 —— exec 那条路（从一坨噪声里挑信封）
 * 与常驻通道（每一行都过一遍）都用它。
 *
 * 两处各写一遍的后果不是"多几行"，是两条链路对"什么算一条消息"给出不同答案
 *   —— 而那正好是 `rid` 回填、推送识别、噪声丢弃三件事共同依赖的那一条。
 *
 * 判据（两种形状，缺一不可）：
 *
 * - 响应：对象、且 `ok` 是布尔。只看"是个 JSON 对象"太松 —— rc 文件里打印一段
 *   恰好是对象的 JSON，会被当成守护进程的应答送进 classify()，然后被解释成一个
 *   关于协议的错误，而真正的原因（shell 环境不干净）连提都不会被提到。
 * - 通知：对象、`push` 是字符串、`seq` 是数字。通知没有 `ok`，所以上面那
 *   一条接不住它。加这一条会不会让 exec 那条路把通知误当应答？不会，而且是结构性
 *   的：通知只发给订阅过的连接，订阅的判据是"这个连接发过带 `rid` 的请求"
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
 * 这是「这台机器的 shell 环境干不干净」与「协议解析」之间唯一的一道缝，
 *   所以规则要写死在这里，而不是散在回调里靠运气。
 *
 * 规则：从后往前找第一个 `parseEnvelopeLine` 认得的行。
 *
 * 从后往前：sshd 用登录 shell 解释我们发过去的命令串，登录 shell 的 rc 文件
 * 可能在应答之前打印东西（zsh 的 `~/.zshenv` 连 `-c` 都会读）。取「最后一行」
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

/** ssh2 在「服务器拒绝了所有认证方式」时抛的原话。 */
const AUTH_FAILED_RE = /all configured authentication methods failed/i;

/**
 * 把认证失败翻译成能指向根因的话。
 *
 * 「All configured authentication methods failed」是 ssh2 的原话，唯一含义是
 *   服务器拒绝了客户端出示的全部认证方式。这里只配了公钥一种，所以它就是
 *   「服务器不认这把钥匙」—— 既不是网络不通，也不是协议不匹配。
 *
 *   问题在于这句话完全不提用的是哪把钥匙，于是用户唯一能做出的反应是反复重试。
 *   所以这里把指纹和公钥原样给出来，并列出三条要核对的实事：它们分别对应三种
 *   完全不同的修法，而在这句英文报错里长得一模一样。
 *
 * （纯函数，导出给测试钉住 —— 这段文案是这个项目里唯一能帮上「认证失败」的地方。）
 */
function authFailureDetail(info) {
  const who = `${info.user}@${info.host}:${info.port}`;
  const line = info.publicKeyLine || '（未能获取公钥）';
  return `登录节点拒绝了这把公钥（${who}）。\n`
    + `出示：${info.keyType || '未知类型'}，指纹 ${info.keyFingerprint || '未知'}\n`
    + `${line}\n`
    + '\n'
    + '逐条核对，三种原因的修法不同：\n'
    + '\n'
    + '1. 指纹是否与注册进 IDM 的那把一致。用这条命令核对：\n'
    + `   ssh-keygen -lf <(echo '${line}')\n`
    + '2. 注册是否生效。有的 IDM 要重新登录一次才开始下发公钥。\n'
    + '3. 这个端口上的 sshd 是否允许纯公钥认证。有的集群在这里还要额外一步验证。\n'
    + '\n'
    + '公钥可以在这条连接的「编辑」里复制。';
}

/**
 * 常驻通道的客户端这一半：一条 duplex 上跑多个请求，并收服务端主动推的消息。
 *
 * 它只认字节与行，不认识 SSH —— 传进来的就是一个 duplex（ssh2 的 channel、或者
 * 用例里的一对 `PassThrough`）。这样它才验得了：真起一条 SSH 才能跑的话，
 * `rid` 关联、乱序响应、断开时在途请求的下场，这几条最要紧的性质一条都测不到。
 *
 * ── 它保证的四件事 ────────────────────────────────────────────────────────
 *
 * 1. `rid` 关联。每条请求一个自增的 `rid`，响应按 `rid` 回到它自己的 Promise
 *    上。并发发出去的请求不保证按序回来，也不该假设。
 * 2. 断开时在途请求全部拿到答复。它们拿到的是 `kind='transport'` 的信封，
 *    不是永远挂着。这条是承重的：常驻通道上"断了"与"没答"是两件事，
 *    漏掉它的症状是 `await` 永远不回、调用方的定时器一轮轮往上叠。
 * 3. 多字节字符不会被撕开。见 `_dec`。
 * 4. 一行有多长是有上限的。见 `MAX_RESPONSE_BYTES` 那一条。
 */
class ResidentChannel {
  /**
   * @param {object} stream  duplex（可写请求、可读消息）
   * @param {object} opts
   *   onNotify {function}  收到一条通知时调用（`{push, seq, at, sessions, stale?}`）
   *   onClose  {function}  这条通道死了（参数是原因字符串）。无论是谁先动的手
   *                        ——对端关了、写失败了、超长了，都走这一个出口。
   *   onStderr {function}  通道的 stderr 上一整行（去掉行尾换行）。通道的 stderr
   *                        不是协议的一部分 —— 它是命令串里那一段 shell 回话的
   *                        地方（见 `PREPARE_OK`）。非约定行由调用方自己忽略。
   *   client   {object}     这台电脑的客户端身份 `{id, name}`。每一条请求都带上它
   *                         （见 request()）。
   */
  constructor(stream, opts = {}) {
    this._stream = stream;
    this._onNotify = opts.onNotify || (() => {});
    this._onClose = opts.onClose || (() => {});
    this._onStderr = opts.onStderr || (() => {});
    this._client = opts.client || null;
    /** rid → {resolve, timer}。只有在途的请求在里面。 */
    this._pending = new Map();
    this._nextRid = 1;
    /** 半个行。只会有半个 —— 完整行当场处理掉。 */
    this._buf = '';
    /** stderr 的那一份（与 `_buf` 分开：两条流可以交错到达）。 */
    this._errBuf = '';
    this.dead = null;
    /**
     * 必须用 `StringDecoder`，不能 `chunk.toString('utf8')` 了事。
     *
     *   一个 UTF-8 字符会被 TCP/SSH 从中间切开，而每一片各转一次字符串就会
     *   各自变出一个 U+FFFD。症状是插件标题、分区名、`note` 里偶尔出现一个""，
     *   而且是间歇性的 —— 取决于分片边界落在哪，本地永远复现不了。
     *
     * exec 那条路（`stdout += d`，`d` 是 Buffer）同样要过 `StringDecoder`，
     *     否则会各自变出 U+FFFD —— 那边的响应里恰好没有中文，所以坏得一直没人
     *     注意。两处一起修 —— "怎么把字节拼成一行"是一条规矩，两份实现会漂。
     */
    this._dec = new StringDecoder('utf8');
    /** stderr 那一侧的同一件事（`_onStderrData`）。 */
    this._errDec = new StringDecoder('utf8');
    this._bind();
  }

  _bind() {
    this._stream.on('data', (d) => this._onData(d));
    this._stream.on('error', (e) => this._die(
      '常驻通道出错：' + ((e && e.message) || '未知错误')));
    this._stream.on('close', () => this._die('常驻通道已关闭'));
    // stderr 是命令串里那一段 shell 回话的地方（见 `PREPARE_OK`）。它坏了不影响
    //   RPC：那一条流上没有协议，最坏的结果是那一行回执等不到（调用方自己有
    //   兜底超时）。所以这里不 `_die` —— 一条只用来读回执的流，不该有权关掉
    //   整条通道。
    const err = this._stream.stderr;
    if (err && typeof err.on === 'function') {
      err.on('data', (d) => this._onStderrData(d));
      err.on('error', () => { /* 见上：回执丢了，通道照旧 */ });
    }
    // 写侧的错误（对端已经走了）也要走同一个出口，否则它是个没人处理的 'error'
    // —— 在 Electron 主进程里那是一条 uncaught exception。
    if (this._stream.stdin && typeof this._stream.stdin.on === 'function') {
      this._stream.stdin.on('error', (e) => this._die(
        '常驻通道写入失败：' + ((e && e.message) || '未知错误')));
    }
  }

  /**
   * stderr 上一个 chunk。拼成整行再交出去 —— 回执是"一行"，不是"一片"。
   *
   * 缓冲有上限：那一头若是某个 rc 文件在刷屏（stderr 没人管得住），内存不该
   *   跟着涨。超过上限就丢掉已经攒着的那半行，下一行照收 —— 回执很短，
   *   它永远碰不到这个上限；碰到的只可能是噪声。
   */
  _onStderrData(d) {
    if (this.dead) return;
    this._errBuf += this._errDec.write(d);
    if (this._errBuf.length > MAX_RESPONSE_BYTES) {
      this._errBuf = '';
      return;
    }
    let i;
    while ((i = this._errBuf.indexOf('\n')) >= 0) {
      const line = this._errBuf.slice(0, i).trim();
      this._errBuf = this._errBuf.slice(i + 1);
      if (line) this._onStderr(line);
    }
  }

  _onData(d) {
    if (this.dead) return;
    this._buf += this._dec.write(d);
    // 上限判在拼出来的那一整行上，而不是单个 chunk 上：chunk 的大小由
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
      // 找不到就丢掉。这条不是漏网的响应，而是迟到的：它已经超时、
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
      // `rid` 只从这条路径上发。它在守护进程那边是"这条连接从此收推送"
      //   的判据，而 exec 那条路是一次性的：带上它，守护进程会把推送写进一条
      //   已经没人读的连接。见 rpc() 里那一句。
      try {
        // `client` 与 `rid` 只在同一条路径上、同一个理由上发出去：
        //   守护进程认身份的判据就是"这条连接发过带 rid 的请求"（见
        //   register_client）。exec 那条路上一个都不带 —— 带上 `rid` 会让守护
        //   进程把推送写进一条已经没人读的连接；带上 `client` 会让看护者那一格
        //   跟着一条下一秒就没了的连接走（它刚认领的会话立刻变成没人看）。
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
   * @param {boolean} deliberate  是不是我们自己关的（探针失败、后端在拆）
   *
   * 这个区分是承重的：调用方（`SshBackend`）拿到 non-deliberate 的关闭会重开
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
    // 先判死再关流：反过来的话，`close()` 触发的 'close' 事件会先跑进 `_die`，
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
    this._opts = opts;
    this._conn = null;
    this._profile = null;
    this._whoami = null;
    this._connecting = null;
    /**
     * 握手问到的基座版本（三态，见 `connect()` 的接口注释）。
     *
     * 它是这一条连接的事实，所以要跟 `_conn` 同生共死：断开时清掉，
     *   否则下一条连接会把上一条的版本号报出去 —— 而"上一条是哪一台"这件事
     *   在两条连接之间没有任何保证。
     */
    this._daemonVersion = null;
    // 握手问到的能力列表（`ping` 应答里的 `caps`）。与 `_daemonVersion` 一样
    //   是这一条连接的事实，同生共死。缺席（老守护进程不报）保持 `null`，
    //   调用方按基线处理 —— 不是"全都支持"。
    this._daemonCaps = null;
    // 调用方（index.js 的启动接续）问的是「有没有连上」，不是「你的私有字段叫什么」。
    // 见 backend.js 接口注释。连接中途断开时 `_conn` 会被置回 null（:309、:501），
    // 所以这个 getter 跟着它就是准的。
    this._closed = false;
    this._reconnectTimer = null;
    this._attempt = 0;
    // 「不用再重试」那一类结论（见 `_markDefinitive`）。它只由
    //   站点上没有本系统命令这一件事置位，`connect()` 时复位。
    this._definitive = false;
    // 这一次 `_open()` 是不是重连排的：自动重连时见到 cli_missing 要通知
    //   上层收尾；用户手动连接那一次只回报错，界面本来就停在连接屏上。
    this._autoReconnect = false;
    // 握手那两条（ping / whoami）走的是同一个 `rpc()`。它们失败时由
    //   `_openOnce` 自己决定怎么回报，不由 `rpc()` 顺手广播收尾。
    this._handshaking = false;
    this._lastHostKey = null;   // { fingerprint, algorithm } —— 供界面展示

    /**
     * 常驻通道（`slurmate stream`）。没有它一切照常 —— `rpc()` 会走 exec。
     *
     * 它跟 `_conn` 同生共死：SSH 断了它就没了，`_conn` 重建时要重新开一条。
     */
    this._resident = null;
    /** 常驻通道没能建起来的原因。给诊断用 —— 它不是错误，只是一种降级。 */
    this.residentError = null;
    /** 建目录那一次的 promise（`beginPrepare()` 发起，`ensurePrepared()` 等它）。 */
    this._prepareP = null;
    /**
     * 常驻通道上那句回执的等待者（见 `_waitChannelPrepare`）。
     *
     * `_prepareMark` 是它的另一半：回执可能比等待者先到 —— 通道一起来，那段
     *   shell 已经在后台跑 mkdir 了（见 `STREAM_CMD`），它完全可能赶在
     *   `beginPrepare()` 之前把那一行写上 stderr。先到的那一句记在这里，
     *   等有人来等的时候当场交账。
     */
    this._prepareDone = null;
    this._prepareMark = null;
    /** 这条连接上重试过没有（`ensurePrepared()` 只重试一次）。 */
    this._prepareRetried = false;
    this._streamTimer = null;
    this._streamAttempt = 0;
  }

  /**
   * 常驻通道现在是不是可用。界面与用例问的是这个，不是私有字段叫什么。
   *
   * 三态是故意的：`null` = 还没试过（还没连上登录节点），`false` = 试过、
   *   不通，`true` = 在。把"还没试"和"试过不通"合并成 `false`，会让启动阶段
   *   的日志说出一句当时并不成立的话。
   */
  get resident() { return this._resident ? true : (this._conn ? false : null); }

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
   *   code='host_key_changed' —— 主机密钥变了，永远拒绝
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
    // 先自己解析一遍私钥再交给 ssh2。
    //   `Client.connect()` 遇到不能解析的私钥会同步抛异常，穿出本模块
    //   「不抛异常」的契约 —— 在真机上表现为主进程里一个没人处理的 rejection，
    //   而用户看到的只是「点了没反应」。宁可在这里明确地失败。
    const parsed = ssh2.utils.parseKey(this._opts.privateKey);
    // parseKey 在输入里含多把密钥时返回数组。不先摊平的话，下面 `.isPrivateKey()`
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
    // 记下这次真正出示的是哪把钥匙。认证失败时唯一有价值的线索就是它 ——
    // 没有它，用户只能对着一句「认证失败」反复重试。
    this._offeredKey = {
      keyType: key.type || null,
      keyFingerprint: hostKeyFingerprint(key.getPublicSSH()),
      publicKeyLine: (() => {
        const blob = key.getPublicSSH();
        return Buffer.isBuffer(blob) ? `${key.type} ${blob.toString('base64')} slurmate` : null;
      })(),
    };
    // 换一台：先把上一条连接拆掉，再拨号。
    //
    //    `_open()` 在 `this._conn` 还在的时候是短路返回上一条连接的
    //    `whoami` / `daemonVersion` 的 —— 那是给"同一台机器的第二次 `connect`"
    //    准备的（每一次重连都真拨一次号没有意义）。可它不看要连的是哪一台：
    //    少了下面这一段，"换一条连接"会拿上一台的身份回来 —— 拨号次数 0、
    //    `_conn` 还是旧的那条、`_profile` 却已经写成了新的（三种事实互相矛盾），
    //    而调用方（`index.js` 的 `doConnect`）会把它当成"连上了新站点"：
    //    窗口标题写新站点、界面上新站点显示「已连接」，而每一次 RPC 都发给旧站点。
    //    这是"系统报告成功，而事情没成"里最坏的一种 —— 它连"没成"都看不出来。
    //
    //    判据是三元组而不是连接的 id：这一层不认识 id（id 是配置那一侧的事，
    //      见 backend.js 的接口注释）。同一台机器的重复 `connect` 照旧短路。
    //    位置在私钥解析之后：新那条的私钥要是不合法，本不该把旧连接拆掉。
    const sameTarget = this._profile
      && this._profile.user === profile.user
      && this._profile.host === profile.host
      && this._profile.port === profile.port;
    if (this._conn && !sameTarget) await this.close();

    this._profile = { user: profile.user, host: profile.host, port: profile.port };
    this._closed = false;
    this._definitive = false;
    this._autoReconnect = false;
    this._handshaking = false;
    this._attempt = 0;
    // 建目录那一次是跟着连接走的（它挂在 `_conn` 上）：换一条连接就必须重新
    //   发起。留着上一次那个 promise 的话，新连接的第一次提交会拿到旧连接的
    //   结论 —— 而那个结论是"成"还是"没成"都同样没有意义。
    this._prepareP = null;
    this._prepareRetried = false;
    // 回执那两个也是跟着连接走的：上一条通道上的那一句对新连接不成立。
    this._prepareDone = null;
    this._prepareMark = null;
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
    // 短路这一支也必须带上 `daemonVersion`。少了它，调用方（index.js 的
    //   版本闸）在"已经连着、再连一次"时会拿到 `undefined`，而 `undefined` 在
    //   那条判定的三态里是"答了却没有版本号"，每一次重连都误报一句
    //   "对面不是我们的守护进程"。它连的明明就是上一次那一台。
    if (this._conn) {
      return Promise.resolve({
        ok: true, whoami: this._whoami, daemonVersion: this._daemonVersion,
        daemonCaps: this._daemonCaps,
      });
    }
    if (this._connecting) return this._connecting;
    // `.catch` 是兜底：ssh2 有几处在同步路径上抛异常（比如私钥格式），
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

      const done = (res) => {
        this._handshaking = false;
        if (!settled) { settled = true; resolve(res); }
      };

      client.on('ready', async () => {
        this._conn = client;
        this._attempt = 0;
        this._emitState(true, `${user}@${host}:${port}`);

        // 先把常驻通道建起来（尽力而为），再走下面那套握手。
        //
        //   放在这里而不是 connect() 的开头：它要在 SSH 通了之后、第一条
        //   RPC 之前。放后面的话，握手那两条（ping/whoami）会白走一次 exec，
        //   而它们正是最该走常驻通道的那两条 —— 每次连接都多 fork 一个 python。
        //
        //   它绝不让 connect() 失败：建不起来就退回去用 exec，而"为什么
        //     建不起来"记在 `residentError` 里。理由见文件头那一段。
        await this._openStream();

        // 建作业日志目录（同样尽力而为 —— 见 `prepare()`）。放这儿而不是
        //   `connect()` 的开头：它要一条真的通了的 SSH 连接。
        // 而它【不等】：这条命令落在用户的家目录里，而家目录常常在共享盘上，
        //   冷挂载的第一次访问要几十秒 —— 真机 2026-10-16 就是这样，它把
        //   「已连接」整整卡住 15 秒，然后报了一条超时。
        //   "连上了"与"目录建出来了"是两件事，前者不该等后者。
        // 这一次是【热身】：它的结果没有人收，一个字的告警也不报 —— 真出事时
        //   该说话的地方是提交那一步（`session.js`），因为那一步才是"目录必须
        //   在"的那一步。在这里说话，症状是用户看到一条"失败"，而目录其实是
        //   有的（真机 2026-10-16 就是这样：报超时，而目录真的建出来了）。
        // 常驻通道在时它不开 exec：那条命令自己已经在建了（见 `STREAM_CMD`），
        //   这里只是挂上回执的等待者（见 `beginPrepare`）。
        this.beginPrepare();

        // 版本握手 —— 在 whoami 之前问一次 ping。
        //
        //   `ping` 与它返回的 `version` 每一个守护进程都有，所以这一问对
        //   任何一版都有效 —— 这正是"客户端要能兼容老版本
        //   服务端"那条要求能成立的前提。反过来（让守护进程问客户端）做不到：
        //   老客户端不带版本，见 docs/PROTOCOL.md。
        //
        //   判定不在这里：规则在 plugins/index.js 的 `versionCheck` 里，
        //     闸在 index.js —— 演示后端也要过同一道闸，而 index.js 是这两个后端
        //     唯一的交汇点。这里只负责"把版本问出来"，以及把"问不到"的几种情况
        //     分开（它们是三个不同的结论，不是一个）。
        this._handshaking = true;
        const ping = await this.rpc({ op: 'ping' });
        const noPing = Boolean(ping && !ping.ok && ping.error
          && ping.error.kind === 'unknown_op');
        // 三态（`undefined` ≠ `null`，本仓库的老纪律）：
        //   字符串    —— 问到了；
        //   null      —— 没问到（对面根本没有 `ping` 这个 op）；
        //   undefined —— 答了一个对象，但里面没有 `version`。
        // 后两者都不是"旧"，`versionCheck` 会给它们各自一个名字。
        let daemonVersion = null;
        // 能力列表与版本一样是三态：数组 = 问到了；null = 没问到（对面没有
        //   `ping`）；undefined 那一格不存在 —— 老守护进程的 `ping` 里没有
        //   `caps`，这里把它折成 `null`，调用方按基线处理。
        let daemonCaps = null;
        if (ping && ping.ok) {
          daemonVersion = (ping.data || {}).version;
          const caps = (ping.data || {}).caps;
          daemonCaps = Array.isArray(caps) ? caps.filter((c) => typeof c === 'string') : null;
        } else if (!noPing) {
          // 问不到、也不是"对面没有这个 op"，这条链路本身有问题。
          // 与下面 whoami 的失败走同一条路：如实报告，别以为连上了。
          const why = (ping && ping.error && (ping.error.detail || ping.error.kind))
            || '未知原因';
          try { client.end(); } catch { /* 尽力 */ }
          this._conn = null;
          if (ping && ping.error && ping.error.kind === 'cli_missing') {
            const detail = '站点上没有 Slurmate 的命令（可能刚被卸载或没有装好）。';
            // 自动重连时要把上层也叫醒；用户手动连接那一次只回报错。
            if (this._autoReconnect) this._markDefinitive(detail);
            return done({ ok: false, code: 'cli_missing', error: detail });
          }
          if (ping && ping.error && ping.error.kind === 'too_many_connections') {
            // 不是"这条路坏了"：站点听得见，只是它的连接数到上限。说成
            //   "已连上、但无法执行"会让用户去查安装，而该做的是关掉不用的连接。
            const detail = ping.error.detail || '站点的连接数已经到上限。';
            try { client.end(); } catch { /* 尽力 */ }
            this._conn = null;
            return done({ ok: false, code: 'conn_limit', error: `站点连接已满：${detail}` });
          }
          return done({
            ok: false,
            code: 'rpc_unavailable',
            error: `已连上 ${host}，但无法执行 \`${RPC_CMD}\`：${why}`,
          });
        }

        // 顺手拿一次 whoami：它既验证「RPC 这条链路真的通」（而不只是 SSH 握手成功），
        // 又给界面提供账户与分区权限。失败要如实报告 —— 这条链路不通时，
        // 界面必须知道，而不是以为连上了。
        const resp = await this.rpc({ op: 'whoami' });
        if (resp && resp.ok) {
          this._whoami = resp.data;
          this._daemonVersion = daemonVersion;
          this._daemonCaps = daemonCaps;
          return done({ ok: true, whoami: resp.data, daemonVersion, daemonCaps });
        }
        if (resp && resp.error && resp.error.kind === 'cli_missing') {
          const missing = '站点上没有 Slurmate 的命令（可能刚被卸载或没有装好）。';
          try { client.end(); } catch { /* 尽力 */ }
          this._conn = null;
          if (this._autoReconnect) this._markDefinitive(missing);
          return done({ ok: false, code: 'cli_missing', error: missing });
        }
        if (resp && resp.error && resp.error.kind === 'too_many_connections') {
          const detail = resp.error.detail || '站点的连接数已经到上限。';
          try { client.end(); } catch { /* 尽力 */ }
          this._conn = null;
          return done({ ok: false, code: 'conn_limit', error: `站点连接已满：${detail}` });
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
        // 认证失败要单独识别。ssh2 的原话（「All configured authentication
        //   methods failed」）直接透出去，用户看到的是又一句不指向任何根因的英文，
        //   而它的真实含义很具体：服务器不认这把钥匙。
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
          this._daemonCaps = null;      // 同上
          // 常驻通道也同生共死，而且要先摘掉重开定时器 —— 不摘的话，SSH
          //   断开之后那个定时器会去重开一条属于上一条 SSH 连接的通道，
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
        // 必须实现。ssh2 默认不校验主机密钥，不做的后果是裸奔。
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
    // 用户刚在界面上确认过这一个指纹 —— 放行，但只放行这一个
    if (status === 'new' && this._opts.trustHostKey === fingerprint) return 'accept';

    if (status === 'changed') {
      return {
        code: 'host_key_changed',
        error: `登录节点的主机密钥已改变（原为 ${this._opts.expectedHostKey || '未知'}）。`
             + `这可能是服务器重装，也可能是中间人攻击。在确认原因之前不会建立连接。`,
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
    if (this._closed || this._definitive || !this._profile || this._reconnectTimer) return;
    const delay = Math.min(RECONNECT_MIN_MS * (2 ** this._attempt), RECONNECT_MAX_MS);
    this._attempt += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closed || this._definitive || !this._profile) return;
      // 只重连「被断掉的」连接。这里【不】重试主机密钥被拒的情况 ——
      // 那需要用户先做决定，自动重试只会把同一个拒绝重复一遍。
      this._autoReconnect = true;
      this._open()
        .catch(() => { /* 下一轮 close 会再排 */ })
        .finally(() => { this._autoReconnect = false; });
    }, delay);
    this._reconnectTimer.unref?.();
  }

  /**
   * 一条「重试不会变好」的结论：站点上没有本系统的命令。
   *
   * 它只广播一次，并把重连停掉。上层（index.js）收到 `definitive: true`
   *   之后会走与空手定时器同一条收尾（忘掉会话、关页面、回连接屏）。
   * 不在这里直接关连接：`rpc()` 可能还在把这一条应答交出去，收尾由上层做。
   */
  _markDefinitive(detail) {
    if (this._definitive) return;
    this._definitive = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._emitState(false, detail, { definitive: true });
  }

  // ── 作业日志目录 ────────────────────────────────────────────────────────
  /**
   * 在站点上把这个用户的作业日志目录建出来。幂等（`mkdir -p`）。
   *
   * 一条连接上它可能被调两次：连接那一刻发起一次（`beginPrepare()`，后台热身），
   *   提交之前还没成的话再试一次（`ensurePrepared()`）。两次都是尽力而为 ——
   *   不抛异常、也不让 connect() 失败：连上是连上，而"以后提交的作业会起不来"
   *   是另一件事，该由调用方决定怎么告诉用户（`session.js` 的提交那一步）。
   *
   * 它与 `$HOME` 有关，而客户端从来不知道远端的家目录是什么（那是 NSS 的事）。
   *   所以命令串里是 `$HOME`，由远端的 bash 展开 —— 客户端一个路径都不拼。
   *
   * 结果里 `definite` 那一格是这一条的要害：`true` 说的是"站点那条命令真的跑了、
   *   并明确失败"（非零退出），`false` 说的是"没拿到结论"（超时、通道错、还没
   *   连上）。提交那一步只认前者，理由见 `ensurePrepared()`。
   */
  prepare() {
    if (!this._conn || this._closed) {
      return Promise.resolve({ ok: false, error: null, definite: false });
    }
    const conn = this._conn;
    return new Promise((resolve) => {
      let settled = false;
      const done = (res) => { if (!settled) { settled = true; resolve(res); } };
      // 兜底：`conn.exec` 的回调不保证会来（连接正好在那一瞬间断掉时它
      //   永远不触发）。没有它，这一条 promise 会永远挂着 —— 而等它的人
      //   （`ensurePrepared()`）也就跟着永远等下去。
      const timer = setTimeout(() => {
        done({ ok: false, definite: false,
               error: '建作业日志目录超时（等了 '
                 + Math.round(PREPARE_TIMEOUT_MS / 1000) + ' 秒没有回应）' });
      }, PREPARE_TIMEOUT_MS);
      // 兜底超时不替任何人撑住事件循环（与本文件其余几处定时器同一条规矩）：
      //   它等的那件事没人在等的时候，进程不该因为它多活着。
      timer.unref?.();
      conn.exec(PREPARE_CMD, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return done({ ok: false, definite: false,
                        error: '无法在登录节点上执行命令：' + err.message });
        }
        let stderr = '';
        stream.stderr.on('data', (d) => { stderr += d; });
        stream.on('error', (e) => {
          clearTimeout(timer);
          done({ ok: false, definite: false,
                 error: '建作业日志目录时通道出错：' + e.message });
        });
        stream.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) return done(prepareResult(true));
          // 走到这里才是"站点明确说了建不出来"：命令真的跑了，退出码不是 0。
          done(prepareResult(false, code, stderr));
        });
      });
    });
  }

  /**
   * 发起一次建目录，不等结果。已经在跑（或者已经跑完）的那一次直接复用它。
   *
   * 没连上、或者已经关掉时返回一个 `ok:false` 但不带 error 的结果 ——
   *   那不是"建目录失败"，是"还没有可以建的地方"：`definite` 也是 `false`，
   *   于是提交那一步照常往下走。
   *
   * 两条走法分开：常驻通道在的时候不开 exec —— 那条命令自己已经在建了
   *   （见 `STREAM_CMD`），这里只等它从 stderr 回来的那一行。通道不在时才走
   *   `prepare()` 那条退路（旧站点、被 guard 拦了）。
   */
  beginPrepare() {
    if (this._prepareP) return this._prepareP;
    if (!this._conn || this._closed) {
      return Promise.resolve({ ok: false, error: null, definite: false });
    }
    this._prepareP = this._resident ? this._waitChannelPrepare() : this.prepare();
    return this._prepareP;
  }

  /**
   * 等常驻通道上那一行回执。
   *
   * 回执可能已经先到了（后台 mkdir 比 `beginPrepare()` 快），那一份记在
   *   `_prepareMark` 里 —— 有就当场交账。
   * 剩下的就是等：上限 `PREPARE_TIMEOUT_MS`（与退路那条 exec 同一个数）。
   *   到点回一个没结论的结果，与 `prepare()` 超时那份同形 —— 调用方不必区分。
   *
   * 通道在回执之前断了也要收账（`_onResidentClose` 会调 `_settlePrepare`）：
   *   否则这一条 promise 要陪一条已经没了的通道等满 90 秒，而`ensurePrepared`
   *   那一次重试也白白晚 90 秒才开始。
   */
  _waitChannelPrepare() {
    if (this._prepareMark) {
      const mark = this._prepareMark;
      this._prepareMark = null;
      return Promise.resolve(prepareResult(mark.ok, mark.rc));
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (res) => {
        if (settled) return;
        settled = true;
        if (this._prepareDone === done) this._prepareDone = null;
        clearTimeout(timer);
        resolve(res);
      };
      const timer = setTimeout(() => done({
        ok: false, definite: false,
        error: '建作业日志目录超时（等了 '
          + Math.round(PREPARE_TIMEOUT_MS / 1000) + ' 秒没有回执）',
      }), PREPARE_TIMEOUT_MS);
      timer.unref?.();
      this._prepareDone = done;
    });
  }

  /**
   * 常驻通道的 stderr 上一整行。
   *
   * 只认 `STREAM_CMD` 里那两句回执，其余一律丢掉：那一条流上还会有登录 shell
   *   的 rc 噪声、CLI 自己的报错（「无法连接守护进程」那几条）—— 它们不是
   *   给客户端读的结论，也不该被读成结论。
   */
  _onStreamStderr(line) {
    let mark = null;
    if (line === PREPARE_OK) mark = { ok: true, rc: null };
    else if (line.startsWith(PREPARE_FAIL + ' ')) {
      // 退出码必须是数字：stderr 上也会有别人的话（rc 文件的输出、CLI 自己的
      //   报错），"以那句开头"不足以说明它是回执。
      const rc = line.slice(PREPARE_FAIL.length + 1).trim();
      if (/^\d+$/.test(rc)) mark = { ok: false, rc };
    }
    if (!mark) return;
    // 回执先于等待者到：记下来，`_waitChannelPrepare` 会当场交账。
    if (!this._prepareDone) { this._prepareMark = mark; return; }
    this._prepareDone(prepareResult(mark.ok, mark.rc));
  }

  /**
   * 把等回执的那一个收掉（常驻通道断了）。
   *
   * `definite` 是 false：通道断在回执前面，证明不了目录在不在 —— 与超时同一类。
   *   收账之后 `ensurePrepared` 那一次重试（走 exec）就能开始，而不是陪一条
   *   已经没了的通道干等。
   */
  _settlePrepare(why) {
    const done = this._prepareDone;
    if (!done) return;
    done({ ok: false, definite: false, error: why });
  }

  /**
   * 保证作业日志目录已经在站点上了。提交之前调一次，而且是有预算地等。
   *
   * 为什么要有它：目录不存在时 `sbatch -o <目录>/slurm-%j.out` 的父目录打不开，
   *   那一次提交的作业连启动都启动不了 —— 那道错只出现在作业日志里，隔着一层
   *   看不见的日志才查得到。而谁建得出来这件事只有一层：守护进程被 systemd 挂成
   *   只读（它写不了用户的家目录），作业脚本自己那一次 `mkdir -p` 排在 Slurm
   *   打开日志文件之后 —— 只剩客户端这一层。
   *
   * 两次机会：连接时发起的那一次（`beginPrepare()`）→ 它没成就再试一次。
   *   再试一次是有用的：冷挂载的第一次访问超时之后，目录的元数据已经在缓存里了，
   *   第二次通常几百毫秒就回来。一条连接上只重试一次：不设这个位的话，一个真的
   *   建不出来的家目录会在每一次提交之前都白等满一个预算。
   *
   * 等它【有预算】（`opts.budgetMs`，缺省 `PREPARE_SUBMIT_BUDGET_MS`）：到点返回
   *   一个没结论的结果，让调用方照常提交。判据是"没回来"不等于"没有" ——
   *   真机 2026-10-16 就是这样：客户端报超时，而目录真的建出来了。只有
   *   `definite` 那一种（站点明确说建不出来）才该拦住提交。
   *
   * 它只在提交之前被等（`session.js`），不在连接上等 —— 冷挂载要几十秒，
   *   而"连上了"这件事与它没有关系。
   */
  ensurePrepared(opts = {}) {
    const budget = Number.isFinite(opts.budgetMs)
      ? opts.budgetMs : PREPARE_SUBMIT_BUDGET_MS;
    return withinBudget(this._ensurePrepared(), budget);
  }

  async _ensurePrepared() {
    const first = await this.beginPrepare();
    if (first.ok) return first;
    if (!first.error) return first;          // 还没连上，没什么可重试的
    if (!this._conn || this._closed) return first;
    if (this._prepareRetried) return first;
    this._prepareRetried = true;
    this._prepareP = this.prepare();
    return this._prepareP;
  }

  // ── 常驻通道 ────────────────────────────────────────────────────────────
  /**
   * 建一条常驻通道，并探一次针证明它真的能用。
   *
   * 尽力而为：任何一步失败都只是把 `_resident` 留在 null（于是 `rpc()` 走 exec），
   * 并把原因记进 `residentError`。它不抛异常、也不让 connect() 失败。
   *
   * 探针（一句 `ping`）不是多余的谨慎：`exec` 成功只说明命令被启动了。
   *   旧 CLI 上 `slurmate stream` 会立刻以 argparse 的退出码 2 结束（一行 usage
   *   进 stderr），而那条通道在客户端看来与一条正常的通道别无二致 —— 直到第一条
   *   真请求永远等不到响应。见 STREAM_PROBE_MS。
   *
   * @returns {Promise<boolean>} 这条通道现在可用吗
   */
  _openStream() {
    if (this._resident || !this._conn || this._closed) {
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
      // 外层的兜底：`conn.exec` 的回调不保证会来 —— SSH 连接正好在那一瞬间
      //    断掉时它永远不触发。没有它，`connect()` 的 ready 处理会停在这里，
      //    而 `readyTimeout` 只管握手那一段，管不到这里 ——
      //    用户看到的是"点了没反应"，没有任何地方报错。
      //    它比探针宽 2 秒：正常情况下结束这次等待的总是探针。
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
            onNotify: (msg) => this._onResidentNotify(msg),
            onClose: (why, deliberate) => this._onResidentClose(ch, why, deliberate),
            onStderr: (line) => this._onStreamStderr(line),
            // 这台电脑是谁。每一条请求都带上（见 ResidentChannel.request）。
            client: this._opts.client || null,
          });
          ch.request({ op: 'ping' }, STREAM_PROBE_MS).then((resp) => {
            // 判据是"对面答了一个信封"，不是 `ok:true`：限流
            //   （`rate_limited`）也是一次正常的往返，它同样证明这条通道是通的。
            //   拿 `ok` 去判会把一次限流记成"这是条坏通道"，然后降级一整个进程。
            //
            // 而 `kind: 'transport'` 必须排除掉 —— 那是我们自己合成的
            //    信封（见 `transportError`），通道一死 `request()` 就立刻拿它结账。
            //    它有布尔 `ok`（false），所以只判 `typeof ok === 'boolean'` 的话，
            //    一条刚建立就死掉的通道会被判成可用：`_resident` 挂上去，
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
            // 失败也要排下一次：这一句覆盖的是"登录节点上的守护进程正好在
            //   重启"这一类暂时的失败。而"CLI 是旧的"那种永久的失败由
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
   * 不放弃：SSH 本身还活着的话就再开一条。只降级不回补的话，这条通道一辈子
   *   只坏一次，客户端此后永远按 60 秒轮询 —— 也就是静默地退回纯 exec 轮询，
   *   而界面上没有任何东西会提这件事。
   *
   * 我们自己关的（探针失败、后端在拆）不重开：那两种情况下重开都是错的，
   *   而探针失败重开还会变成一个重开风暴。
   */
  /** 常驻通道上来了一个通知。直接往上抛，一行都不留在这里。
   *
   * 通道上只有一种通知：全量快照 —— 它逐条都属于某一条会话，本来就该归
   *   `session.js`，所以直接往上抛，一行都不留在这里。
   */
  _onResidentNotify(msg) {
    this.emit('notify', msg);
  }

  _onResidentClose(ch, why, deliberate) {
    if (this._resident === ch) this._resident = null;
    // 建目录那一句回执也随这条通道走了：收账，别让等它的人陪一条没了的通道
    //   干等满 90 秒（见 `_settlePrepare`）。自己关的也一样 —— 这一条通道上
    //   不会再有回执了。
    this._settlePrepare('常驻通道断开了，建作业日志目录那一句没有等到');
    if (deliberate || this._closed || !this._conn) return;
    this.residentError = why;
    this._scheduleStreamReopen();
  }

  /** 排一次重开。只在真的能重开时才排，理由见下面那两行。 */
  _scheduleStreamReopen() {
    if (this._closed || !this._conn || this._streamTimer) return;
    // 连着失败够多次就不再试 —— 见 STREAM_ATTEMPT_MAX。此后这一条 SSH 连接上
    // 一直走 exec，这是正常的退路，不是坏掉的状态。
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

  /** 拆掉常驻通道与它的重开定时器。不重开。 */
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
   * 契约：不抛异常。传输层失败返回一个 `kind='transport'` 的信封，由
   * classify.js 统一分类 —— 调用方（session.js）从不 try/catch rpc 的返回值。
   *
   * 两条链路共用同一个预算（`timeoutMs`，缺省 `RPC_TIMEOUT_MS`）。从前只有
   *   常驻通道那条有预算，exec 那条没有 —— 而 `conn.exec` 的回调不保证会来
   *   （连接正好在那一瞬间断掉时它永远不触发，`prepare()` 早就为同一条性质
   *   加了兜底）。少了它的后果不是"慢一点"：一条送出去就没有下文的 status
   *   会让调用方永远等下去，而对账那一层是"在飞的还在飞"的闩（见 session.js
   *   的 `_statusBusy`）—— 会话从此再也收不到"作业结束了"。
   */
  async rpc(req, timeoutMs) {
    const ms = timeoutMs || RPC_TIMEOUT_MS;
    // 常驻通道在，就走它。这是这一版唯一改变行为的一行。
    //
    //   判据是"现在有没有一条活的常驻通道"，而它是一条每时每刻都在变的事实：
    //   没建起来、断了、正在重开，都落到下面那条 exec 路上 ——
    //   于是"降级"不需要任何一处 try/catch，它就是同一个函数的下一个分支。
    if (this._resident && !this._resident.dead) {
      return this._resident.request(req, ms);
    }
    let conn;
    try {
      conn = await this._ensure();
    } catch (e) {
      return transportError(e.message);
    }
    if (!conn) return transportError('尚未连接到登录节点');

    // exec 这条路上永远不发 `rid`。
    //
    //   它在守护进程那边是"这条连接从此收推送"的判据（见 handle_line），而这条
    //   连接是一次性的：发了 `rid`，守护进程会把推送写进一条马上要被关掉的
    //   连接。更糟的是那条连接上的响应与推送共用同一个输出队列 —— 于是
    //   一次恰好落在 tick 上的推送会被读成这条请求的应答。
    //
    //   写成"复制一份再删掉"而不是"要求调用方别传"：调用方（session.js）
    //   只发业务字段，但不变量不能住在调用方的自觉里。
    //
    // `client` 与 `rid` 在这里是同一条规矩：它也一样只在常驻通道上发。
    //    守护进程那边的门槛是 `conn.subscribed`（"这条连接发过带 rid 的请求"），
    //    所以今天即使漏了这一行也不会出事 —— 但那正是"两层各守一半"，
    //    而两层里任何一层被下一个人改掉，症状都是「看护者那一格跟着一条一次性的
    //    连接走」：那条连接下一秒就没了，于是它刚认领的会话立刻开始倒计时。
    const body = { ...req };
    delete body.rid;
    delete body.client;

    return new Promise((resolve) => {
      let finished = false;
      let timer = null;
      /** 命令通道。回调没来之前是 null，兜底到点时也没有东西可关。 */
      let chan = null;
      const finish = (res) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        resolve(res);
      };
      // 兜底：`conn.exec` 的回调不保证会来（理由见这个函数的注释）。
      //   到点就把这一条判成传输层失败 —— 契约里"不抛异常、返回信封"照旧。
      timer = setTimeout(() => {
        try { if (chan) chan.close(); } catch { /* 尽力 */ }
        finish(transportError(
          `登录节点上的命令超过 ${Math.round(ms / 1000)} 秒没有应答。`));
      }, ms);
      timer.unref?.();

      conn.exec(RPC_CMD, (err, stream) => {
        // 兜底已经先说完了：这条通道属于一个已经结束的等待，别把它挂上去。
        if (finished) { try { stream?.close?.(); } catch { /* 尽力 */ } return; }
        if (err) return finish(transportError('无法在登录节点上执行命令：' + err.message));
        chan = stream;

        let stdout = '';
        let stderr = '';
        let gotExit = false;
        let exitCode = null;
        // 与常驻通道同一个理由（见 ResidentChannel 里的 `_dec`）：按 chunk 各转一次
        //   字符串会把跨边界的多字节字符撕成 U+FFFD，而那是间歇性的。
        const dec = new StringDecoder('utf8');

        stream.on('data', (d) => {
          stdout += dec.write(d);
          if (stdout.length > MAX_RESPONSE_BYTES) {
            try { stream.close(); } catch { /* 尽力 */ }
            finish(transportError('应答过大，已中止（对面回的可能不是 Slurmate 的协议）。'));
          }
        });
        stream.stderr.on('data', (d) => { stderr += d; });
        stream.on('exit', (code) => {
          gotExit = true;
          if (typeof code === 'number') exitCode = code;
        });
        stream.on('error', (e) => finish(transportError('通道出错：' + e.message)));
        stream.on('close', () => {
          stdout += dec.end();     // 最后那几个字节（同样可能是半个字符）
          // 不因为「没收到 exit 事件」就当成失败 —— 宁可不丢一个合法应答。
          const picked = pickEnvelope(stdout);
          if (picked.found) return finish(picked.envelope);

          // 站点上没有本系统的命令（被卸载、或没装好）。退出码与 shell 的原话
          //   一起认：`bash -c '/usr/local/bin/slurmate rpc'` 在命令不存在时回
          //   127，stderr 是那一句 `No such file or directory`。
          //   这是「重试不会变好」的那一类，单独给一个 kind；重连由上层停掉。
          if ((exitCode === 126 || exitCode === 127)
              && /No such file or directory|not found|command not found/i.test(stderr)) {
            const detail = '站点上没有 Slurmate 的命令（可能刚被卸载或没有装好）。';
            // 握手那两条由 `_openOnce` 自己决定怎么回报（见 `_handshaking`）。
            if (!this._handshaking) this._markDefinitive(detail);
            return finish({
              ok: false, code: null, data: null,
              error: { kind: 'cli_missing', detail },
            });
          }

          // 一行都没解析出来。把原始输出一并报出来，别只留一句「解析失败」——
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

        // 请求体走 stdin，绝不进命令行 —— argv 是常量这件事靠这里保持。
        stream.end(JSON.stringify(body) + '\n');
      });
    });
  }

  /**
   * 建立一条到目标的数据通道（隧道用）。
   *
   * host 必须是守护进程给的 `tunnel_target` 里那个字面 IPv4，禁止再解析节点名。
   *   解析结果与 nft 的 `ip daddr` 不一致会导致 ACL 静默失效
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
    this._daemonCaps = null;      // 同上
    if (c) { try { c.end(); } catch { /* 尽力而为 */ } }
    // 主动关闭也要广播。`client.on('close')` 那道守卫要求 `_conn === client`，
    //   而上面刚把它清掉，所以不在这里说一声的话，左栏与浮窗那一行会一直
    //   停在「已连接」。
    this._emitState(false, '连接已关闭');
  }
}

/** 已实现。上面的三条实测假设与固定 argv 都到位了。 */
function isImplemented() {
  return true;
}

module.exports = {
  isImplemented, SshBackend, RPC_CMD, STREAM_CMD, PREPARE_CMD,
  PREPARE_OK, PREPARE_FAIL,   // 导出给测试：命令串里那两句与读它们的那一处同源
  hostKeyFingerprint, hostKeyAlgorithm,
  pickEnvelope,       // 导出给测试：它是纯函数，规则又值得钉住
  parseEnvelopeLine,  // 同上：exec 与常驻通道共用同一条「什么算一条消息」的判据
  ResidentChannel,    // 同上：它只认字节与行，所以不连 SSH 也验得了
  authFailureDetail,  // 同上：这是「认证失败」唯一能指向根因的东西
  AUTH_FAILED_RE,
  RPC_TIMEOUT_MS, STREAM_PROBE_MS,
};
