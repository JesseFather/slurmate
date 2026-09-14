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
import { createRequire } from 'node:module';

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
  assert.equal(sshBackend.RPC_CMD, '/usr/local/bin/slurmate rpc');
  assert.ok(!/[$`{}]/.test(sshBackend.RPC_CMD), '不得含任何模板/变量语法');
  assert.ok(!/code-server/.test(sshBackend.RPC_CMD), '不得含 code-server 字面量');
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

test('已实现（isImplemented 为真）—— 客户端不该再退回演示后端', () => {
  assert.equal(sshBackend.isImplemented(), true);
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
