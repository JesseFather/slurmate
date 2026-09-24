/**
 * backend-ssh.test.mjs —— 真实后端里**不需要真连一台服务器**的那部分。
 *
 * 中心断言是主机密钥裁决，因为那是这一层唯一的安全属性：
 *   ssh2 默认【不校验】主机密钥，只走公钥认证却不校验对端，
 *   就退化成一个「不校验身份的加密连接」—— 比口令认证更糟。
 *
 * 真握手、exec channel、forwardOut 这三条只能在真集群上验（Phase 0），
 * 这里不假装测过它们。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sshBackend = require('../src/main/backend-ssh.js');
const keys = require('../src/main/keys.js');
const { Action, classify } = require('../src/main/classify.js');

/** 造一个 ssh2 风格的主机密钥 blob（string(算法名) + string(公钥)）。 */
function hostKeyBlob(algorithm = 'ssh-ed25519', raw = crypto.randomBytes(32)) {
  const { sshString } = keys._internal;
  return { blob: Buffer.concat([sshString(Buffer.from(algorithm)), sshString(raw)]), raw };
}

test('★ RPC 命令行是编译期常量，不含任何插值', () => {
  // 这条既是防注入，也是穿过 sshd 那个 ForceCommand 守卫的必要条件
  // （命令串里不能出现 code-server 字面量）。它一旦变成拼出来的字符串，
  // 两条性质同时失效。
  assert.equal(typeof sshBackend.RPC_CMD, 'string');
  assert.equal(sshBackend.RPC_CMD, "/bin/bash -c '/usr/local/bin/slurmate rpc'");
  assert.ok(!/[$`{}]/.test(sshBackend.RPC_CMD), '不得含任何模板/变量语法');
  assert.ok(!/code-server/.test(sshBackend.RPC_CMD), '不得含 code-server 字面量');

  // ★ 解释器必须是钉死的 bash，不能交给登录 shell 去挑。
  //   sshd 用 `$SHELL -c "<命令串>"` 执行 exec 请求，而 $SHELL 来自 /etc/passwd ——
  //   HPC 登录节点上常是 zsh，与 bash 并非完全互通。少了这一层，同一份客户端
  //   在不同集群上会跑出不同结果，且失败时只看得到「认证失败」。
  assert.match(sshBackend.RPC_CMD, /^\/bin\/bash -c /, '必须显式指定 bash');
  // 内层命令整体被单引号包住：否则登录 shell 会把参数拆开，`rpc` 会变成 $0
  assert.match(sshBackend.RPC_CMD, /'[^']+'$/, '内层命令必须整体加引号');
});

// ── 应答解析：这道缝挡的是「登录节点的 shell 环境不干净」──────────────────────
//
// sshd 用登录 shell 解释我们发过去的命令串，所以 rc 文件（zsh 的 ~/.zshenv 连 `-c`
// 都会读，bash 不会）可能在应答前后打印东西。取「最后一行」是碰巧够用，
// 规则必须写死并测住。

test('应答解析：干净的输出', () => {
  const r = sshBackend.pickEnvelope('{"ok":true,"code":0,"data":{"x":1}}\n');
  assert.equal(r.found, true);
  assert.equal(r.envelope.data.x, 1);
});

test('★ 应答解析：rc 文件在【前面】打印了东西也不受影响', () => {
  // 现场长这样：一句欢迎语 / 一段 module 加载信息，然后才是真正的应答
  const out = 'Welcome to node01\n'
            + 'Modules: gcc/12.2 loaded\n'
            + '{"ok":true,"code":0,"data":{"session_id":"abc"}}\n';
  const r = sshBackend.pickEnvelope(out);
  assert.equal(r.found, true, 'rc 的噪声不该让一个合法应答变成「解析失败」');
  assert.equal(r.envelope.data.session_id, 'abc');
});

test('★ 应答解析：应答【后面】还有噪声也照样找得到', () => {
  const r = sshBackend.pickEnvelope('{"ok":true,"code":0,"data":null}\nlogout\n');
  assert.equal(r.found, true);
});

test('★ 应答解析：不带布尔 ok 的 JSON 一律不认 —— 那是噪声，不是应答', () => {
  // rc 文件里打印一段 JSON（配置、状态、随便什么）是真实存在的。
  // 认了它，它就会被塞进 classify() 当成守护进程的应答，然后被解释成一个
  // 关于协议的错误 —— 而真正的原因（shell 环境不干净）连提都不会被提到。
  for (const junk of ['{"theme":"dark"}', '[1,2,3]', '"just a string"', '{}}']) {
    const r = sshBackend.pickEnvelope(junk + '\n');
    assert.equal(r.found, false, `${junk} 不该被当成应答`);
    assert.deepEqual(r.lines, [junk]);
  }
});

test('应答解析：完全不是 JSON 时把原始输出带回来（现场比结论重要）', () => {
  const r = sshBackend.pickEnvelope('bash: /usr/local/bin/slurmate: No such file\n');
  assert.equal(r.found, false);
  assert.equal(r.lines.length, 1, '要把原始行给出来，调用方才能报出真正的现场');
});

test('应答解析：空输出', () => {
  assert.deepEqual(sshBackend.pickEnvelope(''), { found: false, lines: [] });
  assert.deepEqual(sshBackend.pickEnvelope('\n  \n'), { found: false, lines: [] });
});

test('主机密钥指纹与 ssh-keygen -lf 同款：对 blob 取 SHA256', () => {
  const { blob, raw } = hostKeyBlob();
  const expected = 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  assert.equal(sshBackend.hostKeyFingerprint(blob), expected);
  // 指纹算的是**整个 blob**（含算法名），不是那 32 字节裸公钥 ——
  // 算错了会与管理员公布的指纹对不上，用户核对时会被误导
  assert.notEqual(sshBackend.hostKeyFingerprint(blob), sshBackend.hostKeyFingerprint(raw));
  assert.equal(sshBackend.hostKeyFingerprint(null), null);
  assert.equal(sshBackend.hostKeyFingerprint(Buffer.alloc(0)), null);
});

test('从主机密钥 blob 里取算法名', () => {
  assert.equal(sshBackend.hostKeyAlgorithm(hostKeyBlob('ssh-ed25519').blob), 'ssh-ed25519');
  assert.equal(sshBackend.hostKeyAlgorithm(hostKeyBlob('ssh-rsa').blob), 'ssh-rsa');
  assert.equal(sshBackend.hostKeyAlgorithm(Buffer.from([0, 0, 0])), null, '截断的输入要返回 null');
});

test('★ 第一次见到的未知主机：拒绝，并把指纹交回界面', () => {
  const b = new sshBackend.SshBackend({ hostKeyCheck: () => 'new' });
  const { blob } = hostKeyBlob();
  const verdict = b._judgeHostKey(blob);

  assert.notEqual(verdict, 'accept', '未知主机不得直接放行');
  assert.equal(verdict.code, 'host_key_unknown');
  assert.equal(verdict.hostKey.fingerprint, sshBackend.hostKeyFingerprint(blob));
  assert.equal(verdict.hostKey.algorithm, 'ssh-ed25519');
});

test('★ 用户刚确认过的那个指纹：放行 —— 且只放行这一个', () => {
  const { blob } = hostKeyBlob();
  const fp = sshBackend.hostKeyFingerprint(blob);

  const b = new sshBackend.SshBackend({ hostKeyCheck: () => 'new', trustHostKey: fp });
  assert.equal(b._judgeHostKey(blob), 'accept');

  // 换一个指纹（模拟另一台主机冒用同一次确认）必须仍被拒
  const other = hostKeyBlob();
  assert.notEqual(b._judgeHostKey(other.blob), 'accept',
    'trustHostKey 只该放行用户确认的那一个指纹');
});

test('★ 主机密钥变了：永远拒绝，且报出原指纹', () => {
  const { blob } = hostKeyBlob();
  const b = new sshBackend.SshBackend({
    hostKeyCheck: () => 'changed',
    expectedHostKey: 'SHA256:OLDFINGERPRINT',
  });
  const verdict = b._judgeHostKey(blob);

  assert.notEqual(verdict, 'accept', '变更的主机密钥绝不放行');
  assert.equal(verdict.code, 'host_key_changed');
  assert.match(verdict.error, /SHA256:OLDFINGERPRINT/, '要把原指纹给出来，用户才能判断是重装还是中间人');

  // 即使调用方误传了 trustHostKey 也不能放行 —— 变了就是变了
  const b2 = new sshBackend.SshBackend({
    hostKeyCheck: () => 'changed',
    trustHostKey: sshBackend.hostKeyFingerprint(blob),
  });
  assert.notEqual(b2._judgeHostKey(blob), 'accept',
    '「变了」不接受信任，只接受用户显式地忘掉旧指纹');
});

test('已知且一致的主机：放行', () => {
  const { blob } = hostKeyBlob();
  const b = new sshBackend.SshBackend({ hostKeyCheck: () => 'known' });
  assert.equal(b._judgeHostKey(blob), 'accept');
});

test('没提供 hostKeyCheck 时按「未知」处理，不默认放行', () => {
  const b = new sshBackend.SshBackend({});
  const verdict = b._judgeHostKey(hostKeyBlob().blob);
  assert.notEqual(verdict, 'accept', '缺少裁决函数时的默认必须是拒绝，不是放行');
  assert.equal(verdict.code, 'host_key_unknown');
});

test('连接前缺私钥/缺字段时明确失败，不去尝试握手', async () => {
  const b = new sshBackend.SshBackend({});
  const r = await b.connect({ user: 'a', host: 'h', port: 22 });
  assert.equal(r.ok, false);
  assert.match(r.error, /私钥/);

  const b2 = new sshBackend.SshBackend({ privateKey: 'x' });
  assert.equal((await b2.connect({})).ok, false);
  assert.match((await b2.connect({})).error, /不完整/);
  assert.equal((await b2.connect({ user: 'a', host: 'h', port: 0 })).ok, false);
});

test('★ 私钥解析不了时返回明确的错误，而不是抛异常穿出去', async () => {
  // 这条曾经是真 bug：ssh2 的 Client.connect() 对无法解析的私钥**同步抛异常**，
  // 而它在 Promise 执行器里 —— 于是变成 rejection 穿出「不抛异常」的契约，
  // 在真机上表现为主进程一个没人处理的 rejection，界面什么都不显示。
  const bogus = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n';
  const b = new sshBackend.SshBackend({ privateKey: bogus });
  const r = await b.connect({ user: 'a', host: 'h', port: 22 });   // 必须 resolve，不能 reject
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_private_key');
  assert.match(r.error, /私钥无法解析/);

  // 连一把**真的**密钥都不能让这条路径去碰网络：本用例里 host 是无效的，
  // 若真去握手会超时。用一把正常密钥验证它会走到握手那一步（返回的不是 bad_private_key）。
  const good = keys.generate().privateKeyPem;
  const b2 = new sshBackend.SshBackend({ privateKey: good });
  const r2 = await Promise.race([
    b2.connect({ user: 'nobody', host: '127.0.0.1', port: 1 }),
    new Promise((res) => setTimeout(() => res({ ok: false, error: '连不上' }), 3000)),
  ]);
  assert.notEqual(r2.code, 'bad_private_key', '合法私钥不该被判成格式错误');
});

test('已实现（isImplemented 为真）—— 后端选择没有"退回假后端"这一支', () => {
  // ★ 这一条守的是 `createBackend` 的**形状**：假后端只由开发者模式开关进入，
  //   而"真后端没实现"不再是一条静默的退路（那句兜底与它旁边的注释正好相反：
  //   真发生的时候，用户会以为连上了集群、其实在跟一个本地假服务打交道）。
  //   今天 `isImplemented()` 恒为真，所以那一支是死的 —— 但死的那一支也要
  //   说得出它为什么死，而这一条就是它被翻出来时会红的地方。
  assert.equal(sshBackend.isImplemented(), true);

  // ★ 同时钉住**选择器的形状**（本机跑不起真集群，所以这一条只能读源码文本）：
  //   一个没有 SSH 后端的构建必须**响亮地坏**，而不是悄悄给一个假后端。
  //   `isImplemented()` 恒为真 ⇒ 那条兜底今天走不到 ⇒ 没有任何行为用例抓得到它，
  //   而它一旦回来，症状是"用户以为连上了集群、其实在跟一个本地假服务打交道"。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'backend.js'), 'utf8');
  assert.equal((src.match(/new FakeBackend/g) || []).length, 1,
    '假后端只许在一个地方被构造');
  const atDev = src.indexOf('if (opts.dev) {');
  const atFake = src.indexOf('new FakeBackend');
  assert.ok(atDev > 0 && atFake > atDev,
    '假后端必须只由 `opts.dev`（开发者模式）那一支进来 —— 它是唯一一条路');
  const tail = src.slice(src.indexOf('if (!ssh.isImplemented())'));
  assert.match(tail, /throw new Error/,
    '没有 SSH 后端时要**响亮地坏**，不许静默退回假后端');
});

// ── 传输层失败的信封 ─────────────────────────────────────────────────────────
test('★ kind=transport 的信封被 classify 归为传输层，而不是「守护进程说了不行」', () => {
  // 后端的契约是「rpc 不抛异常」，所以传输层失败要表达成一个信封。
  // 少了这条规则，它会掉进 FATAL —— 而 FATAL 不重试。
  // 那意味着一次网络抖动就会被当成终局错误，心跳也会停。
  const env = { ok: false, code: null, data: null,
                error: { kind: 'transport', detail: '命令没跑起来' } };
  const c = classify(env, { op: 'heartbeat' });
  assert.equal(c.action, Action.TRANSPORT);
  assert.match(c.message, /命令没跑起来/, '要带上具体原因，而不是笼统的「没有返回应答」');
});

// ── 认证失败：把 ssh2 的原话翻译成能指向根因的话 ─────────────────────────────
//
// 这一节存在的理由很具体：真机上「All configured authentication methods failed」
// 是用户唯一看得到的东西，而它**完全不提用的是哪把钥匙**——于是唯一能做出的反应
// 是反复重试。这句话的真实含义很窄：服务器不认这把公钥。

test('★ ssh2 的认证失败原话被认出来', () => {
  assert.equal(sshBackend.AUTH_FAILED_RE.test('All configured authentication methods failed'), true);
  assert.equal(sshBackend.AUTH_FAILED_RE.test('all configured authentication methods failed'), true,
    '大小写不该决定识别与否');
  // 别的错误不能被误判成认证失败 —— 它们的修法完全不同
  assert.equal(sshBackend.AUTH_FAILED_RE.test('Timed out while waiting for handshake'), false);
  assert.equal(sshBackend.AUTH_FAILED_RE.test('Host verification failed'), false);
  assert.equal(sshBackend.AUTH_FAILED_RE.test('connect ECONNREFUSED'), false);
});

test('★ 认证失败的说明必须带指纹与公钥 —— 否则用户无从核对', () => {
  const { publicKeyLine, fingerprint } = keys.generate('slurmate-20260914');
  const msg = sshBackend.authFailureDetail({
    user: 'alice', host: '198.51.100.10', port: 10100,
    keyType: 'ssh-ed25519', keyFingerprint: fingerprint, publicKeyLine,
  });

  assert.match(msg, /alice@198\.51\.100\.10:10100/, '要说是对哪台机器、哪个账户被拒了');
  assert.ok(msg.includes(fingerprint), '指纹是用户唯一能拿去和 IDM 对照的东西');
  assert.ok(msg.includes(publicKeyLine), '公钥要原样给出来，用户可直接复制去核对');
  assert.match(msg, /ssh-keygen -lf/, '给一条能自己跑的核对命令，而不是让他去猜');
  // 「拒绝」而不是「连不上」—— 这两件事的下一步动作完全不同
  assert.match(msg, /拒绝/);
  assert.ok(!/无法连接|网络/.test(msg), '别把它说成网络问题');
});

test('缺字段时不抛异常，而是如实说「未知」', () => {
  const msg = sshBackend.authFailureDetail({ user: 'u', host: 'h', port: 22 });
  assert.match(msg, /u@h:22/);
  assert.match(msg, /指纹 未知/);
  assert.match(msg, /没能取到公钥/);
});

test('★ 已经连着时再连一次：返回值里**仍然**要带着 daemonVersion', async () => {
  // ★ 这一格是握手落地时才浮出来的真缺陷：`_open()` 在"已经连着"时**短路返回**，
  //   而那一支没有 `daemonVersion` —— 于是调用方（index.js 的版本闸）拿到
  //   `undefined`，而 `undefined` 在那条判定的三态里是"答了却没有版本号" ⇒
  //   **每一次重连都误报一句"对面不是我们的守护进程"**。它连的明明就是上一次
  //   那一台，而这个误报还会顺带把用户的注意力引到链路上（那句话不谈版本）。
  const b = new sshBackend.SshBackend({});
  b._conn = {};                       // 假装连着（这一支不碰网络）
  b._whoami = { user: 'x' };
  b._daemonVersion = '2.5';
  const r = await b._open();
  assert.equal(r.ok, true);
  assert.equal(r.daemonVersion, '2.5',
    '短路那一支漏了 daemonVersion ⇒ 每次重连都误报"对面不是我们的守护进程"');
});

test('★ 断开之后 daemonVersion 跟着清掉（下一条连接不许报上一条的号）', async () => {
  // 它是**这一条连接**的事实，所以要与 `_conn` 同生共死：留着的话，下一条连接
  // 会拿着上一条的版本号去做判定 —— 而"上一条是哪一台"在两条连接之间没有任何保证。
  const b = new sshBackend.SshBackend({});
  b._conn = {};
  b._daemonVersion = '2.5';
  await b.close();
  assert.equal(b._daemonVersion, null, '断开之后它必须回到"不知道"');
  assert.equal(b.connected, false);
});

// ── 两条链路：什么时候走常驻通道，什么时候退回 exec ────────────────────────
//
// ★ 这一层验的是**选择**，不是字节层 —— 字节层在 resident-channel.test.mjs 里
//   （那边不需要 SSH）。真握手仍然只能在真集群上验，这里不假装测过。

const { EventEmitter } = require('node:events');

/** 测试进程要自己撑住事件循环 —— 这里的定时器都 unref 了（理由见 session.js）。 */
function keepLoop(t) {
  const h = setInterval(() => {}, 1000);
  t.after(() => clearInterval(h));
}

/** exec 那条路的假 channel：`end(body)` 之后回一条应答并关闭。 */
class FakeExecStream extends EventEmitter {
  constructor(reply) {
    super();
    this.stderr = new EventEmitter();
    this.sentBody = null;
    this._reply = reply;
  }

  end(body) {
    this.sentBody = body;
    setImmediate(() => {
      if (this._reply !== null) this.emit('data', Buffer.from(this._reply + '\n', 'utf8'));
      this.emit('exit');
      this.emit('close');
    });
  }

  close() { /* 用例不关心 */ }
}

/** 常驻通道那条路的假 duplex。 */
class FakeDuplex extends EventEmitter {
  constructor() {
    super();
    this.written = '';
    this.closed = false;
  }

  write(s) { this.written += s; return true; }
  close() { this.closed = true; this.emit('close'); }
  feed(s) { this.emit('data', Buffer.from(s, 'utf8')); }

  /**
   * 回一条应答，**rid 回填成最后那条请求的** —— 守护进程就是这么做的
   * （`handle_line` 里 `resp["rid"] = rid`）。
   * ★ 夹具这里省掉 rid 的话，应答会被当成噪声丢掉，而症状是"探针超时"——
   *   一句指向通道的话，而问题在夹具。
   */
  answer(payload) {
    const last = this.written.split('\n').filter(Boolean).pop();
    const rid = last ? JSON.parse(last).rid : null;
    this.feed(JSON.stringify({ ...payload, rid }) + '\n');
  }
}

/** 探针与 whoami 都会用的一个正常应答。 */
const PONG = { ok: true, code: 0, data: { pong: true, version: '0.8' }, error: null };

function fakeConn() {
  const c = {
    execs: [],
    streamChannel: null,
    execStream: null,
    // 常驻通道那条 exec 给一个 duplex；其余给一条一次性的假 channel。
    exec(cmd, cb) {
      c.execs.push(cmd);
      if (cmd === sshBackend.STREAM_CMD) {
        c.streamChannel = c.streamChannel || new FakeDuplex();
        cb(null, c.streamChannel);
      } else {
        c.execStream = new FakeExecStream(JSON.stringify(PONG));
        cb(null, c.execStream);
      }
    },
  };
  return c;
}

/** 造一个"已经连着 SSH"的后端（这一层不碰网络）。 */
function connectedBackend() {
  const b = new sshBackend.SshBackend({});
  b._conn = fakeConn();
  b._profile = { user: 'u', host: 'h', port: 1 };
  b._closed = false;
  return b;
}

test('★ 两条命令只差最后一个词：同一个解释器、同一个二进制路径', () => {
  // 分头写死是有意的（上面那条用例要求它是常量），代价就是路径写了两遍 ——
  // 那就有漂的可能，而漂的表现是"其中一条链路连不上"，看起来像守护进程的问题。
  const rpc = sshBackend.RPC_CMD;
  const stream = sshBackend.STREAM_CMD;
  assert.equal(sshBackend.STREAM_CMD, "/bin/bash -c '/usr/local/bin/slurmate stream'");
  assert.ok(!/[$`{}]/.test(stream), '不得含任何模板/变量语法');
  assert.ok(!/code-server/.test(stream), '不得含 code-server 字面量');
  assert.equal(rpc.replace(/ rpc'$/, ''), stream.replace(/ stream'$/, ''),
    '两条命令除了最后那个子命令名之外必须逐字相同');
});

test('★★ exec 那条路上**永远不发 rid**（调用方传了也删掉）', async (t) => {
  keepLoop(t);
  // rid 在守护进程那边是"这条连接从此收推送"的判据，而这条连接是一次性的：
  // 发了它，守护进程会把推送写进一条马上要被关掉的连接，而推送与响应
  // **共用同一个输出队列** —— 一次恰好落在 tick 上的推送会被读成这条请求的应答。
  const b = connectedBackend();
  // ★ 先 await 再看：`rpc()` 的第一个 `await`（`_ensure()`）之前什么都没发生，
  //   同步读 `sentBody` 读到的是 null。
  const r = await b.rpc({ op: 'ping', rid: 99 });
  const sent = JSON.parse(b._conn.execStream.sentBody);
  assert.equal(sent.op, 'ping');
  assert.equal('rid' in sent, false, 'exec 那条路不许带 rid');
  assert.equal(r.ok, true);
});

test('★ 调用方传的 req 对象本身不被改写（删的是副本）', async (t) => {
  keepLoop(t);
  const b = connectedBackend();
  const req = { op: 'ping', rid: 7 };
  await b.rpc(req);
  assert.equal(req.rid, 7, '不许为了发出去而改调用方的对象');
});

test('★ 常驻通道在的时候，rpc 一次 exec 都不发', async (t) => {
  keepLoop(t);
  const b = connectedBackend();
  const opened = b._openStream();
  b._conn.streamChannel.answer(PONG);                 // 探针的应答
  assert.equal(await opened, true);
  assert.equal(b.resident, true);
  const before = b._conn.execs.length;

  const p = b.rpc({ op: 'whoami' });
  b._conn.streamChannel.answer({ ok: true, code: 0, data: { user: 'u' }, error: null });
  assert.equal((await p).data.user, 'u');
  assert.equal(b._conn.execs.length, before, '走通道就不该再 exec');
});

test('★★ 探针失败 ⇒ 不建通道、记下原因、并排一次重开', async (t) => {
  keepLoop(t);
  // ★ "通道起来了"与"通道能用"是两件事：旧 CLI 上 `slurmate stream` 会立刻以
  //   argparse 的退出码 2 结束，而那条通道在客户端看来与正常的别无二致。
  const b = connectedBackend();
  const opened = b._openStream();
  b._conn.streamChannel.emit('close');                // 立刻死了，没有应答
  assert.equal(await opened, false);
  assert.equal(b.resident, false);
  assert.match(b.residentError, /关闭/);
  assert.ok(b._streamTimer, '失败之后要排一次重开（覆盖"守护进程正在重启"）');
  b._teardownStream();
});

test('★ 重开是有上限的：连着失败够多次就不再试', async (t) => {
  keepLoop(t);
  // 上限挡的是"登录节点上的 CLI 是旧的"那种**永久**失败 —— 它和暂时的失败
  // 现场一模一样（一行 usage + 退出码 2），区分不了，只能靠次数。
  // 每一次失败的重开都是一次注定失败的 exec，也就是每分钟白 fork 一个 python。
  const b = connectedBackend();
  b._streamAttempt = 3;
  b._scheduleStreamReopen();
  assert.equal(b._streamTimer, null, '到了上限就不该再排');
});

test('★ 一次成功会把重开计数清零（曾经好用的通道永远有配额）', async (t) => {
  keepLoop(t);
  const b = connectedBackend();
  b._streamAttempt = 2;
  const opened = b._openStream();
  b._conn.streamChannel.answer(PONG);
  assert.equal(await opened, true);
  assert.equal(b._streamAttempt, 0);
  assert.equal(b.residentError, null, '建起来了就把上一条失败的原因清掉');
});

test('★ 通道断了会排重开；拆掉之后不再排', async (t) => {
  keepLoop(t);
  const b = connectedBackend();
  const opened = b._openStream();
  b._conn.streamChannel.answer(PONG);
  await opened;

  b._conn.streamChannel.emit('close');                // 对端关了（不是我们关的）
  assert.equal(b.resident, false);
  assert.ok(b._streamTimer, '对端关的必须要重开');

  b._teardownStream();
  assert.equal(b._streamTimer, null);
  // ★ 拆掉通道之后 `resident` 是 **false** 而不是 null：SSH 还连着，
  //   "连上了、但没有通道"与"还没连上"是两件事（见 resident 的三态）。
  assert.equal(b.resident, false);
  assert.equal(b._resident, null);
});

test('★ 后端自己 close() 之后不重开（也不许报"还连着"）', async (t) => {
  keepLoop(t);
  const b = connectedBackend();
  const opened = b._openStream();
  b._conn.streamChannel.answer(PONG);
  await opened;
  await b.close();
  assert.equal(b._resident, null);
  assert.equal(b._streamTimer, null, '拆了就不该再排重开');
  // resident 的三态：连接没了 ⇒ null（"还没试过/没有连接"），不是 false。
  assert.equal(b.resident, null);
});

test('★ resident 的三态分得开：还没连 / 连了但没有通道 / 通道在', async (t) => {
  keepLoop(t);
  // ★ 合成两态的话，启动阶段的日志会说出一句当时并不成立的话
  //   （"常驻通道不可用" vs "还没试过"）。
  const fresh = new sshBackend.SshBackend({});
  assert.equal(fresh.resident, null, '还没连上登录节点');
  const b = connectedBackend();
  assert.equal(b.resident, false, '连上了、但还没有通道');
  const opened = b._openStream();
  b._conn.streamChannel.answer(PONG);
  await opened;
  assert.equal(b.resident, true);
});
