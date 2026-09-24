/**
 * displaced.test.mjs —— 客户端「被另一个客户端顶掉」的那一半（v0.8 阶段 4）。
 *
 * ★★ 这一份守的是**这个功能唯一要传达的东西**：用户换了一台电脑，另一台不该
 *    假装一切正常。所以每一个用例都在问同一句话的某一个侧面：
 *    「**少了这一格，界面上会看不出什么？**」
 *
 * ★★★ 而里面最要紧的一条**不是界面**，是这一条：
 *
 *      被顶掉的客户端**绝不能给那些会话发 `goodbye`**。
 *
 *    `goodbye` 会让守护进程的 `phase_release` 删掉 ACL **并 scancel 作业** ——
 *    而用户以为自己只是换了个地方看。守护进程那一侧堵不住这件事（它按
 *    `session_id` 记账，分辨不了那个 `goodbye` 是谁发的），所以这一半只能在
 *    客户端堵。见 `SessionController.suspend()` 与 `stop()` 顶上那道闸。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionController, State } = require('../src/main/session.js');
const { Backend } = require('../src/main/backend.js');
const { Action, classify, shouldRetry } = require('../src/main/classify.js');
const sshBackend = require('../src/main/backend-ssh.js');
const { FakeBackend } = require('../src/main/backend-fake.js');

/**
 * 这些代码里的定时器都 unref 了（Electron 主进程里应用自己撑着事件循环），
 * 而 `node --test` 不会 —— 不撑住的话用例会在第一个 await 处被判为"事件循环空了"。
 */
function keepAlive(t) {
  const h = setInterval(() => {}, 1000);
  t.after(() => clearInterval(h));
}

const ok = (data) => ({ ok: true, code: 0, data, error: null });

/** 一条会话视图，形状照守护进程的 `session_view`。 */
function view(extra = {}) {
  return {
    session_id: 's1', job_id: '42', state: 'enrolled',
    partition: 'A6000', node: 'node01', node_ip: '192.0.2.11', service_port: 55001,
    tunnel_target: '192.0.2.11:55001', resources: { cpus: 2, mem: '8G', gres: null },
    job_state: 'RUNNING', job_terminal: false, renew_count: 0, last_hb_at: 1000,
    ...extra,
  };
}

/** 一个只记账的后端。 */
class StubBackend extends EventEmitter {
  constructor() {
    super();
    this.kind = 'fake';
    this.calls = [];
  }

  get connected() { return true; }

  async rpc(req) { this.calls.push(req); return ok({ session: view() }); }

  count(op) { return this.calls.filter((c) => c.op === op).length; }
}

/**
 * 把控制器推到 RUNNING。
 *
 * ★ 隧道换成一个记账的桩，而**不是**留着真的 `Tunnel`：真的那个在没有
 *   `_tunnelPort` 时会 `listen(0)`，于是**永远有一个监听套接字活着**，
 *   整个测试进程退不掉（上一版就撞过一次，表现为文件多花几十秒）。
 */
function running(backend) {
  const ctrl = new SessionController({ backend, layoutId: 'L1' });
  ctrl.state = State.RUNNING;
  ctrl.sessionId = 's1';
  ctrl.session = view();
  ctrl._lastTarget = ctrl.session.tunnel_target;
  const stops = [];
  ctrl.tunnel = {
    state: 'listening', origin: null,
    on() {},
    async stop() { stops.push(1); },
    async start() { return { port: 18080, shifted: false }; },
  };
  ctrl.tunnelStops = stops;
  return ctrl;
}

// ── 1. 分类：被顶掉不是「网络抖了一下」──────────────────────────────────────
test('★★★ 被顶掉的信封归为**不可重试**，而且原样用后端写好的那句话', () => {
  // ★ 这一条如果与 transport 混起来，界面会一直显示「重试中……」——
  //   而它永远不会成功（要等用户手动点「连接」），也永远不会说清为什么。
  const err = sshBackend.displacedError('本机已被「乙机」上的客户端顶掉。');
  const c = classify(err, { op: 'heartbeat' });
  assert.equal(c.kind, 'displaced');
  assert.equal(c.action, Action.FATAL, '不可重试：在用户动手之前，重试一万次都是同一个结果');
  assert.equal(shouldRetry(c), false);
  assert.equal(c.message, '本机已被「乙机」上的客户端顶掉。');
});

test('★★★ 被顶掉的判据是 `kind`，**压过 code** —— 一个会重试的 code 也不行', () => {
  // ★ 这一条让上面那个分支**不是等价变异**：本文件的第二条纪律是"必须靠 kind
  //   而不是 code"（`code 5` 有两个相反的含义）。被顶掉这件事不该因为对面捎带
  //   了一个可重试的 code 就变成"重试中……"—— 而它永远不会成功。
  for (const code of [5, 6, 7, 9]) {
    const c = classify({ ok: false, code, data: null,
                         error: { kind: 'displaced', detail: '被顶掉了' } },
                       { op: 'submit' });
    assert.equal(c.action, Action.FATAL, `code ${code} 不许把它变成可重试`);
    assert.equal(shouldRetry(c), false);
    assert.equal(c.kind, 'displaced');
  }
});

test('★ 传输失败仍然是可重试的 —— 两者必须分得开', () => {
  const c = classify({ ok: false, code: null, data: null,
                       error: { kind: 'transport', detail: '连接断了' } },
                     { op: 'heartbeat' });
  assert.equal(c.action, Action.TRANSPORT);
  assert.equal(shouldRetry(c), true, '传输失败是暂时的：我们在重连');
});

// ── 2. 常驻通道上的顶替通知 ─────────────────────────────────────────────────
class FakeDuplex extends EventEmitter {
  constructor() {
    super();
    this.written = '';
    this.closed = false;
  }

  write(s) { this.written += s; return true; }
  close() { this.closed = true; this.emit('close'); }
  feed(s) { this.emit('data', Buffer.from(s, 'utf8')); }

  answer(payload) {
    const last = this.written.split('\n').filter(Boolean).pop();
    const rid = last ? JSON.parse(last).rid : null;
    this.feed(JSON.stringify({ ...payload, rid }) + '\n');
  }

  lines() { return this.written.split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
}

const PONG = { ok: true, code: 0, data: { pong: true, version: '0.8' }, error: null };

function fakeConn() {
  const c = {
    execs: [],
    streamChannel: null,
    execStream: null,
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
      this.emit('data', Buffer.from(this._reply + '\n', 'utf8'));
      this.emit('exit', 0);
      this.emit('close');
    });
  }

  close() { this.emit('close'); }
}

const CLIENT = { id: 'm-aaaa', name: '甲机' };

function connectedBackend(opts = {}) {
  const b = new sshBackend.SshBackend({ client: CLIENT, ...opts });
  b._conn = fakeConn();
  b._profile = { user: 'u', host: 'h', port: 1 };
  b._closed = false;
  return b;
}

/** 开通道并让探针通过。 */
async function withChannel(b) {
  const opened = b._openStream();
  b._conn.streamChannel.answer(PONG);
  assert.equal(await opened, true, '前提：常驻通道建起来了');
  return b._conn.streamChannel;
}

/**
 * 喂一条顶替通知，**并当场断言它真的生效了**。
 *
 * ★★ 那个 `assert` 不是装饰：少了它，一条"分道写坏了"的变异会让后面那些用例
 *    的前提不成立（`_displaced` 没置上）⇒ `rpc()` 落到常驻通道上等一个永远不来的
 *    应答 ⇒ **整个文件挂住**。而"挂住"与"守住了"在输出上是一样的。
 *    （变异验证里 ⑱ 那条就是这么挂的：90 秒超时。）
 */
function pushDisplaced(b, ch, extra = {}) {
  ch.feed(JSON.stringify({ push: 'displaced', seq: 1, at: 100,
                           reason: '另一个客户端接管了',
                           by: { id: 'm-bbbb', name: '乙机' }, ...extra }) + '\n');
  assert.ok(b.displaced, '前提：这条推送之后必须真的被顶掉（否则后面的断言都是空转）');
}

test('★★ 顶替通知**不往会话那一路抛**（它是这台客户端的状态，不是某条会话的）', async (t) => {
  keepAlive(t);
  const b = connectedBackend();
  const notifies = [];
  const displaced = [];
  b.on('notify', (m) => notifies.push(m));
  b.on('displaced', (m) => displaced.push(m));
  const ch = await withChannel(b);

  pushDisplaced(b, ch);

  assert.equal(notifies.length, 0, '抛给 session.js 的话，每个控制器都会各自处理一遍「我被顶掉了」');
  assert.equal(displaced.length, 1);
  assert.equal(b.displaced.reason, '另一个客户端接管了');
  assert.equal(b.displaced.by.name, '乙机', '要说得出**是谁**顶的');
});

test('★★ 而普通的快照推送照旧往上抛（分道不是"拦截所有通知"）', async (t) => {
  keepAlive(t);
  const b = connectedBackend();
  const notifies = [];
  b.on('notify', (m) => notifies.push(m));
  const ch = await withChannel(b);

  ch.feed(JSON.stringify({ push: 'sessions', seq: 1, at: 100, sessions: [] }) + '\n');

  assert.equal(notifies.length, 1);
  assert.equal(b.displaced, null);
});

test('★★★ 被顶掉之后 rpc **一律拒绝**，绝不退回 exec', async (t) => {
  keepAlive(t);
  const b = connectedBackend();
  const ch = await withChannel(b);
  pushDisplaced(b, ch);
  b._conn.execs.length = 0;

  const resp = await b.rpc({ op: 'heartbeat', session_id: 's1' });

  assert.equal(resp.ok, false);
  assert.equal(resp.error.kind, 'displaced');
  assert.match(resp.error.detail, /乙机/, '要说清是被谁顶的');
  assert.match(resp.error.detail, /点「连接」/, '要说清怎么回去');
  // ★★ 这一句是承重的：退回去的话界面完全正常，而"你已经被接管了"一个字都不出现。
  assert.equal(b._conn.execs.length, 0, '一条 exec 都不许发出去');
});

test('★★★ 被顶掉之后**不再重开常驻通道**（这就是"不自动重连"）', async (t) => {
  keepAlive(t);
  const b = connectedBackend();
  const ch = await withChannel(b);
  b._streamAttempt = 0;
  pushDisplaced(b, ch);

  assert.equal(b._streamTimer, null, '排了重开就等着互相顶吧');
  assert.equal(await b._openStream(), false);
  assert.equal(b._conn.execs.filter((c) => c === sshBackend.STREAM_CMD).length, 1,
    '只该有最开始那一条 —— 顶替之后一条都不许再开');
  assert.equal(b.resident, false);
});

test('★★ 通道是**先**拆掉、再抛事件的（订阅方拿到事件时通道已经没了）', async (t) => {
  keepAlive(t);
  const b = connectedBackend();
  const ch = await withChannel(b);
  let residentWhenFired = 'unset';
  b.on('displaced', () => { residentWhenFired = b._resident; });

  pushDisplaced(b, ch);

  assert.equal(residentWhenFired, null);
  assert.equal(ch.closed, true, '那条通道对谁都没用了');
});

test('★ 顶替只认第一条（重复通知不会把状态改回去）', async (t) => {
  keepAlive(t);
  const b = connectedBackend();
  const ch = await withChannel(b);
  const seen = [];
  b.on('displaced', (m) => seen.push(m));

  pushDisplaced(b, ch);
  const first = b.displaced;
  b._onDisplaced({ reason: '别的', by: { name: '丙机' } });

  assert.equal(seen.length, 1);
  assert.equal(b.displaced, first);
  assert.equal(b.displaced.by.name, '乙机');
});

// ── 3. 身份：只从常驻通道发出去 ─────────────────────────────────────────────
test('★★★ `client` 与 `rid` **只在同一条路径上**发出去', async (t) => {
  keepAlive(t);
  const b = connectedBackend();

  // ① 常驻通道：每一条请求都带着身份
  //    ★ 必须**回一条应答**：常驻通道上的请求会一直等（默认 180 秒），
  //      不回的话这条用例挂在那里，而症状是"整个文件跑了三分钟"。
  const ch = await withChannel(b);
  const pending = b.rpc({ op: 'ping' });
  ch.answer(PONG);
  await pending;
  const asked = ch.lines().pop();
  assert.deepEqual(asked.client, CLIENT);
  assert.equal(typeof asked.rid, 'number');

  // ② exec 退路：一个都不带
  //
  //    ★★ **调用方必须显式把这两个都传进去。** 写成 `{op:'ping'}` 的话，
  //       `rpc()` 里那两行 `delete` 删的是**本来就不存在的东西** —— 于是删掉它们
  //       不会有任何断言变红（一条**等价变异**，也就是没人守着的代码）。
  //       `rid` 那一条在 `backend-ssh.test.mjs` 里就是这么写的，这里照抄那个形状。
  b._resident = null;
  b._teardownStream();
  b._conn.execStream = null;
  await b.rpc({ op: 'ping', rid: 999, client: CLIENT });
  const body = JSON.parse(b._conn.execStream.sentBody);
  assert.equal(body.rid, undefined, 'rid 是订阅的判据，一次性连接上带了它就会收到推送');
  // ★★ 带上 `client` 的话，守护进程会把**每一次 exec 退路**读成
  //    "同一个客户端又连上来了"，于是把客户端自己那条常驻通道顶掉 ——
  //    症状是「通道时好时坏」，而两边各自的日志都自洽。
  assert.equal(body.client, undefined, 'exec 退路上带身份 = 每降级一次就把自己顶掉一次');
});

// ── 4. 「重新连接」是唯一的出口 ─────────────────────────────────────────────
test('★★ 只有 connect() 能清掉「被顶掉」（自动重连那条路走不到它）', async (t) => {
  keepAlive(t);
  const b = connectedBackend();
  const ch = await withChannel(b);
  pushDisplaced(b, ch);
  assert.ok(b.displaced);

  // ★ 自动重连（_openOnce / _scheduleStreamReopen）与 connect() 是两条路：
  //   前者**永远清不掉它** —— 被顶掉的客户端不许自己回来。
  b._scheduleStreamReopen();
  assert.ok(b.displaced, '自动那条路不许把它清掉');
  assert.equal(b._streamTimer, null);

  // connect() 才是那扇门。这里它会在私钥那一步就失败（没给私钥），
  // 而**清掉 displaced 发生在它之前** —— 那正是要的次序。
  await b.connect({ user: 'u', host: 'h', port: 1 });
  assert.equal(b.displaced, null);
});

// ── 5. 会话那一半：suspend() ────────────────────────────────────────────────
test('★★ suspend() 停下心跳、对账与订阅，并把原因写给界面', async () => {
  const b = new StubBackend();
  const c = running(b);
  c._startHeartbeat();
  c._startStatusPoll();
  c._watchBackend(true);
  assert.equal(b.listenerCount('notify'), 1, '前提：先订上');

  c.suspend('本机已被「乙机」上的客户端顶掉。');

  assert.equal(c._hbTimer, null, '心跳必须停 —— 那边已经接手了');
  assert.equal(c._statusTimer, null, '对账也必须停 —— 否则每一轮都是一次注定失败的重试');
  assert.equal(b.listenerCount('notify'), 0, '退订：不然监听器只增不减');
  assert.equal(c.snapshot().suspended, '本机已被「乙机」上的客户端顶掉。');
  // ★★ 而 `snapshot()` 里那一个是给**界面**的，这一个 `c.suspended` 是给
  //    `index.js` 的两处守卫用的（收尾时跳过它、接手前 abandon 它）。
  //    少了它那两处读到 `undefined` ⇒ 恒为假 ⇒ 用户点了「连接」一条会话都接不回来，
  //    而没有一个字会报错。**它们必须是同一个东西**，不是两份各写一遍的状态。
  assert.equal(c.suspended, c.snapshot().suspended);
  assert.match(c.snapshot().warning, /乙机/, '界面要看得到原因');
  assert.equal(c.tunnelStops.length, 0, '★ 隧道**不拆** —— 用户可能还开着那个页面在看');
});

test('★ suspend() 幂等：只记第一条原因', () => {
  const c = running(new StubBackend());
  c.suspend('第一条');
  c.suspend('第二条');
  assert.equal(c.snapshot().suspended, '第一条');
});

test('★★★ 被顶掉的会话，stop() **一个 goodbye 都不发**', async () => {
  // ★★★ 这是这一份里最要紧的一条。`goodbye` 会让守护进程的 phase_release
  //      删掉 ACL **并 scancel 作业** —— 而用户以为自己只是换了个地方看。
  //      守护进程分辨不了那个 goodbye 是谁发的（它按 session_id 记账），
  //      所以这一半只能在客户端堵：**根本不进收尾流程**。
  const b = new StubBackend();
  const c = running(b);
  c.suspend('本机已被「乙机」上的客户端顶掉。');
  b.calls.length = 0;

  const r = await c.stop();

  assert.equal(b.count('goodbye'), 0, '发了它，用户的作业就没了');
  assert.equal(b.calls.length, 0, '一个字都不该发给服务端');
  assert.equal(r.ok, false);
  assert.match(r.detail, /作业仍在运行/);
  // ★ 状态**不许**被写成 ENDED —— 那是「作业结束了」这句不成立的话，
  //   而用户会照着它去重新提交一个。
  assert.equal(c.state, State.RUNNING);
  assert.equal(c.tunnelStops.length, 0);
});

test('★ 对照：没被顶掉的会话照常发 goodbye（那道闸不是把 stop 关掉了）', async () => {
  const b = new StubBackend();
  const c = running(b);
  b.calls.length = 0;

  await c.stop();

  assert.equal(b.count('goodbye'), 1);
});

test('★★ 两条会话里只被顶掉一条 ⇒ 另一条照常收尾（那道闸是按会话拦的）', async () => {
  const b = new StubBackend();
  const live = running(b);
  const gone = running(b);
  gone.suspend('本机已被「乙机」上的客户端顶掉。');

  await live.stop();
  await gone.stop();

  assert.equal(b.count('goodbye'), 1, '两条里只该发一条 —— 发两条就是把好人也一起停了');
  assert.equal(gone.tunnelStops.length, 0, '被顶掉的那条：隧道不动');
  assert.equal(live.tunnelStops.length, 1, '另一条照常收尾');
});

// ── 6. 假后端：同一条契约，否则开发者模式里这条路根本走不到 ──────────────────
test('★★ 假后端也实现 displaced：能造出来、能拒绝、能复位', async (t) => {
  keepAlive(t);
  const b = new FakeBackend({ client: CLIENT, rpcLatencyMs: 0 });
  // ★★ 收尾挂在 `t.after` 上，**不是**函数末尾那一次 `await b.close()`。
  //    写在末尾的话，一条断言红掉就跳过了它，而假后端那个 HTTP 服务还开着 ⇒
  //    `node --test` 的子进程**永远不退**。变异验证里这条就挂了两分半，
  //    而"某条断言红了"与"整个文件跑不完"在输出上长得完全一样。
  t.after(() => b.close());
  const seen = [];
  b.on('displaced', (m) => seen.push(m));
  assert.equal(b.displaced, null);
  await b.connect({ user: 'demo', host: '127.0.0.1', port: 1 });

  b.debugDisplace('乙机');

  assert.equal(seen.length, 1);
  assert.equal(b.displaced.by.name, '乙机');
  const resp = await b.rpc({ op: 'heartbeat' });
  assert.equal(resp.ok, false);
  assert.equal(resp.error.kind, 'displaced', '与真后端**逐字同一条规矩**');
  assert.equal(b.connected, true, '★ 它不是「断开连接」：SSH 那条链路好好的');

  assert.equal(b._pushTimer, null, '也不再推快照 —— 真守护进程在顶替的同时就把订阅摘了');

  b.debugReset();
  assert.equal(b.displaced, null);
  const after = await b.rpc({ op: 'ping' });
  assert.equal(after.ok, true, '复位之后照常干活');
});

test('★★ 假后端重连时清掉 displaced（与真后端同一条出口）', async (t) => {
  keepAlive(t);
  const b = new FakeBackend({ client: CLIENT, rpcLatencyMs: 0 });
  t.after(() => b.close());     // 同上：红了也要收，否则子进程不退
  b.debugDisplace('乙机');
  await b.connect({ user: 'demo', host: '127.0.0.1', port: 1 });
  assert.equal(b.displaced, null);
});

test('★ 假后端收下了身份 —— 不收的话「身份根本没送到后端」在开发者模式里看不出来', () => {
  assert.deepEqual(new FakeBackend({ client: CLIENT })._client, CLIENT);
});

// ── 7. 接口：少实现要**响亮地坏**，不是静默地"永远没被顶掉" ──────────────────
test('★★ 基类的 displaced 抛异常（少实现 = 界面看起来一切正常）', () => {
  class Bare extends Backend {}
  const b = new Bare();
  assert.throws(() => b.displaced, /未实现/);
});
