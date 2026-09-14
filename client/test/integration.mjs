/**
 * integration.mjs —— 端到端跑一遍**除 Electron 之外**的全部链路。
 *
 * 覆盖：演示后端 → SessionController 状态机 → Tunnel（真的本地中继）→
 *       演示 code-server（真的 HTTP）→ 登录契约 → goodbye → 释放。
 *
 * 这台机器上没有 Xvfb，Electron 界面跑不了。但界面之下的每一层都能在这里真跑，
 * 所以这一层出问题一定不是「Electron 的锅」—— 这正是分层验证的意义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FakeBackend, DEMO_PASSWORD } = require('../src/main/backend-fake.js');
const { SessionController, State, QUEUED_POLL_MS } = require('../src/main/session.js');
const { Tunnel } = require('../src/main/tunnel.js');
const { SESSION_COOKIE } = require('../src/main/login.js');

const NO_REDIRECT = { redirect: 'manual' };

/** 拿一个当前空闲的端口，当作「槽位绑定端口」。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** 等一个条件成立，超时则抛错。 */
async function until(fn, { timeout = 15000, interval = 60, what = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待「${what}」超时（${timeout}ms）`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** session.js 里的定时器都 unref 了（Electron 里这是对的），测试里得自己撑住事件循环。 */
function keepAlive() {
  const t = setInterval(() => {}, 1000);
  return () => clearInterval(t);
}

/**
 * 起一个演示后端，并**把清理注册到 t.after**。
 * 必须在 after 里清理而不是在测试体末尾：断言失败会抛异常，末尾的清理就跑不到，
 * 演示后端那个 HTTP 服务会一直挂着，让整个测试进程不退出（我第一版就踩了这个）。
 */
async function makeBackend(t, opts = {}) {
  const backend = new FakeBackend({ rpcLatencyMs: 0, ...opts });
  await backend.connect({ user: 'demo' });
  t.after(async () => { await backend.close(); });
  return backend;
}

test('隧道：目标解析必须是字面 IPv4，否则拒绝', () => {
  assert.deepEqual(Tunnel.parseTarget('192.0.2.11:55017'),
    { host: '192.0.2.11', port: 55017, raw: '192.0.2.11:55017' });

  // ★ 这几条是安全关键。解析节点名会让客户端用的地址与 nft 里的 ip daddr 分叉，
  //   而 ACL 失效的表现是「一切正常，只是没有保护」。
  for (const bad of ['node01:55017', 'localhost:55017', 'example.com:55017', '']) {
    assert.throws(() => Tunnel.parseTarget(bad), /IPv4|格式|为空/, `应拒绝 ${JSON.stringify(bad)}`);
  }
  // IPv6 也会被拒 —— 本方案只处理字面 IPv4
  assert.throws(() => Tunnel.parseTarget('::1:55017'), /IPv4/);
  // 端口越界
  assert.throws(() => Tunnel.parseTarget('203.0.113.5:0'), /端口/);
  assert.throws(() => Tunnel.parseTarget('203.0.113.5:99999'), /端口/);
});

test('隧道：只听 127.0.0.1，不绑所有网卡', async () => {
  const backend = new FakeBackend();
  const t = new Tunnel({ backend });
  const port = await freePort();
  await t.start({ preferredPort: port, target: '203.0.113.9:9999' });

  // 用本机非回环地址去连，必须连不上 —— 否则等于把 IDE 挂在局域网上。
  const addrs = Object.values(require('os').networkInterfaces())
    .flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  for (const addr of addrs) {
    const reachable = await new Promise((resolve) => {
      const s = net.connect(port, addr);
      s.setTimeout(700);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
      s.once('timeout', () => { s.destroy(); resolve(false); });
    });
    assert.equal(reachable, false, `隧道不该在非回环地址 ${addr} 上可达`);
  }
  await t.stop();
});

test('全链路：提交 → 登记 → 隧道 → 登录 → 释放', async (t) => {
  t.after(keepAlive());
  const backend = await makeBackend(t, { enrollDelayMs: 300 });

  const slotPort = await freePort();
  const ctl = new SessionController({ backend, slot: 1 });
  const seen = [];
  ctl.on('change', (s) => seen.push(s.state));

  // ── 提交并一路推到 running ──
  // 不传任何资源 = 用服务端默认值（2 核 / 8G / 随机挑一个有权限的分区）。
  const snap = await ctl.start({}, { preferredPort: slotPort });
  assert.ok(snap, '启动应当成功');
  assert.equal(ctl.state, State.RUNNING);
  assert.equal(snap.localPort, slotPort, '应当用上槽位绑定的端口');
  assert.equal(snap.origin, `http://127.0.0.1:${slotPort}`);
  assert.match(snap.tunnelTarget, /^127\.0\.0\.1:\d+$/);
  assert.equal(snap.demo, true);

  // ★ 服务端补的默认值必须真的落到会话上 —— 客户端不填，不等于没有值。
  assert.equal(snap.resources.cpus, 2, '默认 2 核应由服务端填');
  assert.equal(snap.resources.mem, '8G', '默认 8G 应由服务端填');
  // ★ 分区是从有权限的列表里随机挑的，所以只能断言「落在合法的那个集合里」，
  //   不能断言具体是哪一个 —— 那正是这条设计的意思。
  assert.ok(['2080TI', 'A6000', 'RTX8000'].includes(snap.partition),
    `分区应当来自有权限的集合，实际：${snap.partition}`);
  assert.notEqual(snap.partition, 'DEBUG', '没有权限的分区绝不能被选中');

  // 状态迁移确实经过了 submitting / queued
  assert.ok(seen.includes('submitting'), '应当经过 submitting');
  assert.ok(seen.includes('queued'), '应当经过 queued');

  // ── 通过**真的隧道**打 HTTP ──
  const base = snap.origin;
  const hz = await fetch(`${base}/healthz`, NO_REDIRECT);
  assert.equal(hz.status, 200, '经隧道访问 /healthz 应为 200');

  const anon = await fetch(`${base}/`, NO_REDIRECT);
  assert.equal(anon.status, 302, '未登录访问 / 应跳登录页');

  const bad = await fetch(`${base}/login`, {
    ...NO_REDIRECT, method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'nope' }).toString(),
  });
  assert.equal(bad.status, 200);
  assert.equal(bad.headers.get('set-cookie'), null);

  const good = await fetch(`${base}/login`, {
    ...NO_REDIRECT, method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: DEMO_PASSWORD }).toString(),
  });
  assert.equal(good.status, 302);
  const cookie = good.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));

  const app = await fetch(`${base}/`, { ...NO_REDIRECT, headers: { cookie } });
  assert.equal(app.status, 200, '带 cookie 应能进工作区');

  // ── 心跳 ──
  const before = ctl.snapshot().hbAgeMs;
  assert.ok(typeof before === 'number' && before < 10000, '启动后应当立刻打过一次心跳');

  // ── 释放 ──
  const res = await ctl.stop();
  assert.equal(res.ok, true);
  // ★ 返回 releasing 而不是「已结束」—— 因为 op_goodbye 的 ok:true 并不保证
  //   scancel 真的成功了（记忆 cluster-side-defects 的 F12/F13）。
  assert.equal(res.state, 'releasing');

  // 隧道必须已经关掉：再连应当失败，而不是挂住
  const afterStop = await new Promise((resolve) => {
    const s = net.connect(slotPort, '127.0.0.1');
    s.setTimeout(1500);
    s.once('connect', () => { s.destroy(); resolve('connected'); });
    s.once('error', () => resolve('refused'));
    s.once('timeout', () => { s.destroy(); resolve('hang'); });
  });
  assert.equal(afterStop, 'refused', '释放后本地端口必须立刻拒绝连接（不能挂住）');
});

test('★ 主动终止就是彻底终止：没有「保持作业运行」这条退路', async (t) => {
  t.after(keepAlive());
  const backend = await makeBackend(t, { enrollDelayMs: 200 });

  const ctl = new SessionController({ backend, slot: 1 });
  await ctl.start({}, { preferredPort: await freePort() });
  assert.equal(ctl.state, State.RUNNING);

  // 老接口上那个 farewell:false（「只关窗口，作业继续跑」）已经删掉了。
  // 就算有人照着旧代码传进来，也**必须**被当成一次正常的释放 ——
  // 一个能被用户点击触发的「不释放」开关，只会误伤：它命中的所有场景
  // 都是用户明确表达了终止意图的场景。
  const res = await ctl.stop({ farewell: false });
  assert.equal(res.ok, true);
  assert.equal(res.state, 'releasing', '必须真的走释放，不能把作业留在集群上');

  // 守护进程那边确实收到了 goodbye
  const st = await backend.rpc({ op: 'status', session_id: ctl.sessionId });
  assert.equal(st.ok, true);
  assert.notEqual(st.data.session.state, 'enrolled', '作业不应当还在跑');
});

test('★ 意外消失（没来得及发 goodbye）时作业必须还在 —— 这才是「保活」唯一该生效的场景', async (t) => {
  t.after(keepAlive());
  const backend = await makeBackend(t, { enrollDelayMs: 200 });

  const ctl = new SessionController({ backend, slot: 1 });
  await ctl.start({}, { preferredPort: await freePort() });
  assert.equal(ctl.state, State.RUNNING);

  // 模拟断电/网线被拔：进程直接没了，stop() 根本没机会被调用。
  // 这里只是「不再碰它」，然后从一个新的观察点去看守护进程那边。
  const st = await backend.rpc({ op: 'status', session_id: ctl.sessionId });
  assert.equal(st.ok, true);
  assert.equal(st.data.session.state, 'enrolled', '客户端没说话，作业就必须还活着');
  assert.ok(st.data.session.tunnel_target, '隧道目标仍应在，下次启动才能接上');

  await ctl.stop();
});

test('守护进程不可达时：不判定会话结束，且持续重试', async (t) => {
  t.after(keepAlive());
  const backend = await makeBackend(t, { enrollDelayMs: 150 });

  // 心跳间隔压到 150ms，好在测试里观察到「反复失败但不放弃」
  const ctl = new SessionController({ backend, slot: 1, heartbeatMs: 150, statusMs: 150 });
  t.after(() => ctl.stop());
  await ctl.start({}, { preferredPort: await freePort() });
  assert.equal(ctl.state, State.RUNNING);

  // 让守护进程「挂掉」
  backend.debugDaemonDown(1200);
  const probe = await backend.rpc({ op: 'ping' });
  assert.equal(probe.ok, false);
  assert.equal(probe.error.kind, 'daemon_unreachable');

  // 等心跳真的打一轮失败
  await until(() => /心跳/.test(ctl.snapshot().warning || ''),
    { what: '心跳失败被记录', timeout: 3000 });

  // ★ 核心断言：守护进程不可达【绝不能】让客户端以为会话结束了。
  //   作业还在计算节点上跑，只是我们暂时问不到它。
  assert.equal(ctl.state, State.RUNNING,
    '守护进程不可达绝不能判定会话结束');
  assert.equal(ctl.snapshot().tunnelState, 'listening', '隧道不该被拆');
  assert.match(ctl.snapshot().warning, /仍在重试/);

  // 守护进程恢复后，警告应当自己消失（而不是永远挂着）
  await until(() => !/心跳/.test(ctl.snapshot().warning || ''),
    { what: '心跳恢复后警告清除', timeout: 4000 });
});

test('submit 不可重试：守门在 classify，不在调用点', async () => {
  const { Action, classify, shouldRetry } = require('../src/main/classify.js');
  const r = classify(
    { ok: false, code: 6, data: null, error: { kind: 'submit_failed', detail: 'sbatch 失败' } },
    { op: 'submit' });
  assert.equal(r.action, Action.FATAL);
  assert.equal(shouldRetry(r), false, 'submit 非幂等，超时重试会产生第二个作业');
});
