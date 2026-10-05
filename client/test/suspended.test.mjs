/**
 * suspended.test.mjs —— 「本机不再管这条会话」时客户端那一半的规矩。
 *
 * ★★ 这一份守的是**那个状态唯一要传达的东西**：
 *
 *      本机不再管这条会话之后，**绝不能给它发 `goodbye`**。
 *
 *    `goodbye` 会让守护进程的 `phase_release` 删掉 ACL **并 scancel 作业** ——
 *    而用户以为自己只是换了个地方看。守护进程那一侧堵不住这件事（它按
 *    `session_id` 记账，分辨不了那个 `goodbye` 是谁发的），所以这一半只能在
 *    客户端堵。见 `SessionController.suspend()` 与 `stop()` 顶上那道闸。
 *
 * ★ v0.9 换掉了这个状态的**触发方式**，而状态本身留下了。从前它由一条
 *   `push: displaced` 通知置上（服务端按 uid 顶掉整个客户端）；现在"谁在看一条
 *   会话"是**会话行上的一格**，于是"我不再是看护者"由**心跳的应答**（`ignored`）
 *   逐会话地告诉客户端 —— 名字从"被另一台电脑顶掉"收窄成"这条作业被接管了"，
 *   而 `suspend()` 做的事一个字都没变。所以这一份用例**只改措辞，不改判据**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionController, State } = require('../src/main/session.js');

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

const REASON = '这条作业已经被「乙机」上的客户端接管了。';

test('★★ suspend() 停下心跳、对账与订阅，并把原因写给界面', async () => {
  const b = new StubBackend();
  const c = running(b);
  c._startHeartbeat();
  c._startStatusPoll();
  c._watchBackend(true);
  assert.equal(b.listenerCount('notify'), 1, '前提：先订上');

  c.suspend(REASON);

  assert.equal(c._hbTimer, null, '心跳必须停 —— 那边已经接手了');
  assert.equal(c._statusTimer, null, '对账也必须停 —— 否则每一轮都是一次注定失败的重试');
  assert.equal(b.listenerCount('notify'), 0, '退订：不然监听器只增不减');
  assert.equal(c.snapshot().suspended, REASON);
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

test('★★★ 被接管的会话，stop() **一个 goodbye 都不发**', async () => {
  // ★★★ 这是这一份里最要紧的一条。`goodbye` 会让守护进程的 phase_release
  //      删掉 ACL **并 scancel 作业** —— 而用户以为自己只是换了个地方看。
  //      守护进程分辨不了那个 goodbye 是谁发的（它按 session_id 记账），
  //      所以这一半只能在客户端堵：**根本不进收尾流程**。
  const b = new StubBackend();
  const c = running(b);
  c.suspend(REASON);
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

test('★ 对照：没被接管的会话照常发 goodbye（那道闸不是把 stop 关掉了）', async () => {
  const b = new StubBackend();
  const c = running(b);
  b.calls.length = 0;

  await c.stop();

  assert.equal(b.count('goodbye'), 1);
});

test('★★ 两条会话里只被接管一条 ⇒ 另一条照常收尾（那道闸是按会话拦的）', async () => {
  const b = new StubBackend();
  const live = running(b);
  const gone = running(b);
  gone.suspend(REASON);

  await live.stop();
  await gone.stop();

  assert.equal(b.count('goodbye'), 1, '两条里只该发一条 —— 发两条就是把好人也一起停了');
  assert.equal(gone.tunnelStops.length, 0, '被接管的那条：隧道不动');
  assert.equal(live.tunnelStops.length, 1, '另一条照常收尾');
});
