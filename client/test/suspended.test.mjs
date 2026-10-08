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
 * ★ 这个状态的触发方式是**心跳的应答**：服务端在会话行上记"谁在看一条会话"，
 *   客户端从 `ignored` 逐会话地得知"我不再是看护者"；`suspend()` 做的事只有
 *   一件 —— 不给自己不再是看护者的会话发 `goodbye`。
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
    /**
     * 下一次 `rpc` 回什么。`null` = 回那条平常的成功应答。
     * ★ 心跳那几条用例要靠它造出"服务端说这一拍没算数"（`ignored`）与
     *   "传输层断了"两种应答 —— 它们都从 `rpc` 回来，而处理方式**正好相反**。
     */
    this.reply = null;
  }

  get connected() { return true; }

  async rpc(req) { this.calls.push(req); return this.reply || ok({ session: view() }); }

  count(op) { return this.calls.filter((c) => c.op === op).length; }
}

/** 传输层失败的信封 —— 后端合成它而不是抛异常（见 backend.js 的 `rpc` 契约）。 */
const transportFail = () => ({
  ok: false, code: null, error: { kind: 'transport', detail: '连接断了' },
});

/**
 * 把控制器推到 RUNNING。
 *
 * ★ 隧道换成一个记账的桩，而**不是**留着真的 `Tunnel`：真的那个在没有
 *   `_tunnelPort` 时会 `listen(0)`，于是**永远有一个监听套接字活着**，
 *   整个测试进程退不掉（上一版就撞过一次，表现为文件多花几十秒）。
 */
function running(backend) {
  const ctrl = new SessionController({ backend, workspaceId: 'L1' });
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

// ── 触发那一步：`ignored`（v0.9 阶段 6）─────────────────────────────────────
//
// ★★ 「这一拍把命续上了」与「这一拍没有算数」是**两件事**，而它们都回
//    `ok:true`。服务端拒绝一次心跳时回的是 `ok` + `ignored`（见 `op_heartbeat`
//    的 docstring：心跳不是一条会让客户端重试的请求，回错会让它退避、进而把
//    "不是看护者"演成"网络不好"）。⇒ 客户端**必须**看那一格，否则界面会显示
//    「上次心跳 3 秒前」，而真相是这条会话已经不归本机管了。

test('★★ `ignored: not_keeper` ⇒ 这条会话进入「被接管」，而且这一拍不算数', async () => {
  const b = new StubBackend();
  b.reply = ok({ state: 'enrolled', at: 1000, ignored: 'not_keeper' });
  const c = running(b);
  c._startHeartbeat();

  await c._beat();

  // ★★ 这是客户端认出「我被接管了」的**唯一**信号 —— 守护进程刻意没有为此
  //    发明一条推送（"谁在看"是会话行上的一格，而那一格变了只有正在心跳的
  //    那个人问得出来）。
  assert.match(c.suspended, /接管/, `这一刻必须转成"被接管"：${c.suspended}`);
  assert.match(c.suspended, /作业仍在运行/,
    '★ 而那句话必须带上"作业还在跑" —— 少了它，用户会去重新提交一个作业');
  assert.equal(c._heartbeatAt, 0,
    '★★ 这一拍**没有续上命**：推进 `_heartbeatAt` 等于本机自己宣称"我在看着"，'
    + '而服务端刚刚说了不是 —— 那句假话会一路传到界面上（"上次心跳 3 秒前"）');
  assert.equal(c._hbTimer, null, '心跳必须停 —— 那边已经接手了');
  assert.equal(b.listenerCount('notify'), 0, '退订：不然监听器只增不减');
  assert.equal(c.tunnelStops.length, 0, '★ 隧道**不拆** —— 用户可能还开着那个页面在看');
});

test('★ 认不出来的 `ignored` 取值：不算数，但**不**放弃这条会话', async () => {
  // ★ 三态那条纪律在这里的落点：**认不出来就别猜**。猜成"被接管了"会让本机
  //   白白放手一条其实还归自己的会话（心跳停了 ⇒ 300 秒后它真的会被判 suspect）；
  //   猜成"没事"则把一句服务端明说了的话咽掉。所以：不算数 + 原样印出来。
  const b = new StubBackend();
  b.reply = ok({ state: 'enrolled', at: 1000, ignored: '某个我们还不认识的理由' });
  const c = running(b);

  await c._beat();

  assert.equal(c._heartbeatAt, 0, '不算数就是不算数（与 `not_keeper` 同一格）');
  assert.equal(c.suspended, null, '★ 认不出来**不猜**成"被接管了"');
  assert.match(c.snapshot().warning, /某个我们还不认识的理由/, '★ 原样印出来，不吞掉');
});

test('★ 对照组：平常那一拍照旧续命（`ignored` 那一支不是把心跳关掉了）', async () => {
  const b = new StubBackend();
  const c = running(b);

  await c._beat();

  assert.ok(c._heartbeatAt > 0, '没有 `ignored` 就是一次正常的心跳');
  assert.equal(c.suspended, null);
  assert.equal(c._hbTimer, null, '★ 而它**不**会去停那个定时器（只有 suspend 才停）');
});

test('★★★ 闪断（传输失败）**不是**接管 —— 这正是那 300 秒窗口要覆盖的事', async () => {
  // ★★★ 这一条与上面第一条的对照是这一版的承重结构：
  //    · 服务端**明确**说"这一拍不算数" ⇒ 被接管，本机放手；
  //    · 连接**断了**（什么都没说） ⇒ 什么都不变，继续重试。
  //    把后者误判成前者，一次网络抖动就等于一次"这条会话不归我了"——
  //    而用户回来时作业已经在回收路上了。
  const b = new StubBackend();
  b.reply = transportFail();
  const c = running(b);
  c._startHeartbeat();

  await c._beat();

  assert.equal(c.suspended, null, '★★ 闪断**绝不能**变成"被接管"');
  assert.notEqual(c._hbTimer, null, '★ 心跳要继续重试（别等 45 秒的定时器被停掉）');
  assert.match(c.snapshot().warning, /重试/);
  assert.equal(c.tunnelStops.length, 0);
});

test('★★ 被接管之后，心跳不再发给服务端（那个定时器真的停了）', async () => {
  // ★ 上面那条断言的是 `_hbTimer === null`，而这一条走**行为**：接管之后再打
  //   一拍，`rpc` 一次都不该发生 —— 定时器停了但 `_beat()` 还能被别处调到的话，
  //   症状是"一个已经放手的会话还在每 45 秒问一次"，而那条连接上的身份不是它。
  const b = new StubBackend();
  b.reply = ok({ state: 'enrolled', at: 1000, ignored: 'not_keeper' });
  const c = running(b);
  await c._beat();
  assert.match(c.suspended, /接管/, '前提：先被接管');

  b.calls.length = 0;
  await c._beat();

  assert.equal(b.calls.length, 0, '★ 已经放手了，一拍都不该再打（`_stopped` 那类闸）');
});

test('★★ resume()：接管成功之后，停掉的四样一起开回来', async () => {
  // ★★ 少了 `resume()`，「接管」会变成一句假话：`suspend()` 是一个**终态**，
  //    而接管成功意味着服务端那一格已经换成本机了。不撤销它的话，界面会一直说
  //    "已被另一台电脑接管"、心跳一直不发 —— 而用户刚刚看到一句「已接管」。
  //    ★ 心跳不发那一条的代价不是"少几个字"：1800 秒之后作业会被当作没人看护
  //      而 `scancel` 掉，界面上仍然写着"已接管"。
  const b = new StubBackend();
  const c = running(b);
  c._startHeartbeat();
  c._startStatusPoll();
  c._watchBackend(true);
  c.suspend(REASON);
  assert.equal(c.suspended, REASON, '前提：先被接管');
  assert.equal(b.listenerCount('notify'), 0);

  c.resume();

  assert.equal(c.suspended, null);
  // ★ 检查的四样与 `suspend()` 停掉的四样**一一对应**，少开任何一样都是静默的退化。
  assert.equal(c.snapshot().warning, null, '那句原因要跟着撤掉（不然界面一直说"被接管"）');
  assert.notEqual(c._hbTimer, null,
    '★ 心跳要回来 —— 少了它，1800 秒之后作业被 scancel，而界面写着"已接管"');
  assert.notEqual(c._statusTimer, null,
    '对账也要回来（少了它，剩余时间永远停在接管那一刻，而那个数看起来完全正常）');
  assert.equal(b.listenerCount('notify'), 1, '推送订阅也要回来');

  c._stopHeartbeat();
  c._stopStatusPoll();
});

test('★ resume() 幂等，而且**不**动一个没被接管的会话', () => {
  const c = running(new StubBackend());
  c.resume();
  assert.equal(c.suspended, null);
  assert.equal(c._hbTimer, null, '★ 没被接管过的会话不该因为一次 resume 就长出心跳来');

  c.suspend(REASON);
  c.resume();
  const t = c._hbTimer;
  c.resume();
  assert.equal(c._hbTimer, t, '★ 第二次 resume 不许多出一个定时器（两个心跳=两条路）');
  c._stopHeartbeat();
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
