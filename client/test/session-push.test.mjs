/**
 * session-push.test.mjs —— 客户端**消费推送**的那一半。
 *
 * ★★ 这一份守的是这一版最容易静默出错的地方：那些**只有推送这条路**上才会
 *    发生、而它们坏了界面上一切正常的东西。逐条列在下面每个用例的注释里。
 *
 * ★ 而最要紧的一条性质在最后：**推送不来的时候，对账必须与这一版之前逐字相同。**
 *   它不是容错，是这一版能成立的前提（登录节点上的 CLI 可能是旧的）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionController, State, PUSH_STALE_MS } =
  require('../src/main/session.js');

/** 这些代码里的定时器都 unref 了（Electron 主进程里应用自己撑着事件循环）。 */
function keepAlive() {
  const h = setInterval(() => {}, 1000);
  return () => clearInterval(h);
}

/** 一个只记账的后端。`rpc` 回什么由用例给。 */
class StubBackend extends EventEmitter {
  constructor() {
    super();
    this.kind = 'fake';
    this.label = '桩';
    this.calls = [];
    this.reply = null;          // (req) => 响应
  }

  get connected() { return true; }

  async rpc(req) {
    this.calls.push(req);
    return this.reply ? this.reply(req) : ok({ session: null });
  }

  count(op) { return this.calls.filter((c) => c.op === op).length; }
}

const ok = (data) => ({ ok: true, code: 0, data, error: null });

/** 一条会话视图，形状照守护进程的 `session_view`。 */
function view(extra = {}) {
  return {
    session_id: 's1', job_id: '42', state: 'enrolled',
    partition: 'A6000', node: 'node01', node_ip: '192.0.2.11', service_port: 55001,
    tunnel_target: '192.0.2.11:55001', resources: { cpus: 2, mem: '8G', gres: null },
    job_state: 'RUNNING', job_terminal: false, renew_count: 0, last_hb_at: 1000,
    auth_password: 'pw-secret', ssh_host_key: 'ssh-ed25519 AAAA',
    ...extra,
  };
}

/** 把控制器推到 RUNNING —— 推送只在那一档上做事。 */
function running(backend, init = {}) {
  const ctrl = new SessionController({ backend, layoutId: 'L1' });
  ctrl.state = State.RUNNING;
  ctrl.sessionId = 's1';
  ctrl.session = view(init);
  ctrl._lastTarget = ctrl.session.tunnel_target;
  ctrl._watchBackend(true);
  return ctrl;
}

/**
 * 一条推送。`sessions` 省略时给一条本会话的最新视图。
 *
 * ★★ 不管调用方给的是什么，这里都把**秘密摘掉** —— 因为真守护进程渲染推送用的是
 *    `with_secret=False`（与 `list` 同构），口令与作业内主机公钥**永远不会出现**。
 *
 *   ★ 这一层是**被变异验证逼出来的**：夹具里图省事把 `ssh_host_key` 留着的话，
 *     "推送里缺了它就要保留旧值"那条规矩**永远走不到** —— 变异把保留逻辑整个删掉，
 *     用例照样全绿。夹具比真集群**干净**，真缺陷就在用例里隐形
 *     （仓库里 F26 就是这么活下来的）。
 */
function push(ctrl, sessions, extra = {}) {
  const list = (sessions === undefined ? [view(init0(ctrl))] : sessions)
    .map((s) => {
      const d = { ...s };
      delete d.auth_password;
      delete d.ssh_host_key;
      return d;
    });
  ctrl.backend.emit('notify', {
    push: 'sessions', seq: extra.seq || 1, at: 1,
    sessions: list,
    ...(extra.stale ? { stale: extra.stale } : {}),
  });
}

/** 本会话当前视图的"原样"版本（用来造一条没有变化的推送）。 */
function init0(ctrl) {
  const s = { ...ctrl.session };
  delete s.auth_password;
  delete s.ssh_host_key;
  return s;
}

const tick = () => new Promise((r) => setImmediate(r));

// ── 刷新视图 ──────────────────────────────────────────────────────────────
test('★★ 推送让作业状态立刻更新，而且**一次 status 都不问**', async (t) => {
  // ★ 这就是常驻通道省下来的那个 exec：从前 job_state 要等下一轮 60 秒的
  //   status 才会变，而现在它随推送（有变化 2 秒内）就到。
  t.after(keepAlive());
  const b = new StubBackend();
  const ctrl = running(b);
  const before = ctrl.snapshot().jobText;
  push(ctrl, [view({ job_state: 'COMPLETED', job_terminal: true })]);
  await tick();
  assert.equal(b.count('status'), 0, '刷新视图不该产生一次 RPC');
  assert.notEqual(ctrl.snapshot().jobText, before, '界面上的那句话必须跟着变');
  assert.equal(ctrl.session.job_state, 'COMPLETED');
});

test('★★ 推送里**没有口令**（结构性质）⇒ 旧口令必须留着', async (t) => {
  // ★ 守护进程渲染推送用的是 `with_secret=False`，所以口令**永远不会**出现在
  //   推送里。合并时把它当成"这次没有"用 undefined 覆盖掉，后果不是少显示一格：
  //   自动重登失败 ⇒ **页面打不开**，而界面上一切正常。
  t.after(keepAlive());
  const b = new StubBackend();
  const ctrl = running(b);
  assert.equal(ctrl.session.auth_password, 'pw-secret', '前提：一开始是有口令的');
  push(ctrl, [view({ job_state: 'COMPLETED', job_terminal: true })]);
  await tick();
  assert.equal(ctrl.session.auth_password, 'pw-secret', '口令不许被推送抹掉');
  assert.equal(ctrl.session.ssh_host_key, 'ssh-ed25519 AAAA', '作业内主机公钥同理');
});

test('★ 换了会话就**不**保留旧口令（拿旧口令打新作业是另一回事）', async (t) => {
  t.after(keepAlive());
  const b = new StubBackend();
  const ctrl = running(b);
  ctrl.sessionId = 's2';
  push(ctrl, [view({ session_id: 's2', auth_password: undefined })]);
  await tick();
  assert.equal(ctrl.session.auth_password, undefined);
});

test('★★ 推送里找不到本会话 ⇒ 什么都不做（**绝不能**读成"会话没了"）', async (t) => {
  // ★ 快照和 `list` 一样**截断到最近 50 条**，而那是同一个 uid 的全部会话 ——
  //   一个多开的用户完全可能排到 50 名之外。读成"会话没了"的后果是客户端自己
  //   拆掉隧道、界面上写"会话已不存在"，**而作业还在跑**。
  t.after(keepAlive());
  const b = new StubBackend();
  const ctrl = running(b);
  const before = { state: ctrl.state, session: ctrl.session };
  push(ctrl, [view({ session_id: '别的会话' }), view({ session_id: '还有一个' })]);
  await tick();
  assert.equal(ctrl.state, State.RUNNING, '状态不许动');
  assert.equal(ctrl.session, before.session, '视图不许动');
  assert.equal(b.count('status'), 0, '不确认就不该去问 —— 没有"可疑"这回事');
});

test('★ 空列表同理：那是"这一批里没有"，不是"你没有会话"', async (t) => {
  t.after(keepAlive());
  const b = new StubBackend();
  const ctrl = running(b);
  push(ctrl, []);
  await tick();
  assert.equal(ctrl.state, State.RUNNING);
  assert.equal(b.count('status'), 0);
});

// ── 实质变化 ⇒ 去要一份权威视图 ───────────────────────────────────────────
test('★ 推送里 state 变了 ⇒ 去要一份权威视图（那一条才带口令）', async (t) => {
  // 越过 ACL 边界意味着口令可能刚出现（排队 → 已登记），而推送**结构上**
  // 不带口令 —— 所以这一刻必须去问 status。
  t.after(keepAlive());
  const b = new StubBackend();
  b.reply = () => ok({ session: view({ state: 'suspect' }) });
  const ctrl = running(b);
  push(ctrl, [view({ state: 'suspect' })]);
  await tick(); await tick();
  assert.equal(b.count('status'), 1, 'state 变了必须升级成一次权威查询');
});

test('★ 推送里 tunnel_target 变了 ⇒ 同样升级，而且**真的会去重建隧道**', async (t) => {
  t.after(keepAlive());
  // ★ 这条断言的不只是"多问了一次 status"，而是"那条**既有的**重建路真的被走到了"
  //   ——升级如果只更新视图不触发 `_statusOnce()`，隧道就留在一个已经没有作业的
  //   节点上，而界面上一切正常（页面打不开，但也不报错）。
  //
  // ★ 这里把隧道换成一个**记账的桩**，不听真端口：那一段（真的 listen / 顺移 /
  //   回滚）是 `tunnel.js` 自己的事，integration.mjs 里端到端跑过。在这里听一个
  //   真端口会让这条用例依赖"18080 空着"，而它不空。
  const b = new StubBackend();
  const moved = { node_ip: '192.0.2.99', tunnel_target: '192.0.2.99:55001' };
  b.reply = () => ok({ session: view(moved) });
  const ctrl = running(b);
  ctrl._tunnelPort = 18080;
  const starts = [];
  const stops = [];
  ctrl.tunnel = {
    state: 'listening', origin: null,
    on() {},
    async stop() { stops.push(1); },
    async start(opts) { starts.push(opts); return { port: 18080, shifted: false }; },
  };

  push(ctrl, [view(moved)]);
  const deadline = Date.now() + 5000;
  while (!starts.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(b.count('status'), 1, '必须先升级成一次权威查询');
  assert.equal(stops.length, 1, '重建之前要先停掉旧的监听');
  assert.deepEqual(starts[0].target, '192.0.2.99:55001', '要指向**新**的目标');
  assert.equal(ctrl.session.tunnel_target, '192.0.2.99:55001');
});

test('★ job_state 变了**不**升级（推送那份比 status 更新，不是更旧）', async (t) => {
  // 快照里的作业信息来自本 tick 已经取过的那一份（至多旧 2 秒），而 status
  // 会现查一次 —— 为一个再常见不过的状态迁移去 fork 一个 scontrol，是把
  // 常驻通道省下来的东西又还回去。
  t.after(keepAlive());
  const b = new StubBackend();
  const ctrl = running(b);
  push(ctrl, [view({ job_state: 'PENDING' })]);
  await tick();
  assert.equal(b.count('status'), 0);
  assert.equal(ctrl.session.job_state, 'PENDING');
});

test('★ 同时只允许一次 status 在飞（两条在飞的会各自覆盖视图，顺序无保证）', async (t) => {
  t.after(keepAlive());
  const b = new StubBackend();
  let resolveFirst = null;
  b.reply = () => new Promise((r) => { resolveFirst = () => r(ok({ session: view() })); });
  const ctrl = running(b);
  ctrl._statusOnce();
  ctrl._statusOnce();
  ctrl._statusOnce();
  assert.equal(b.count('status'), 1, '第二次起必须被挡掉');
  resolveFirst();
  await tick(); await tick();
  assert.equal(ctrl._statusBusy, false, '无论走哪条 return，忙标志都要清掉');
});

// ── 与轮询的关系：这是这一版最要紧的一条 ─────────────────────────────────
test('★★ 推送不来的时候，status 轮询与这一版之前**逐字相同**', async (t) => {
  // ★★ 旧 CLI 上没有 `stream` 子命令、老守护进程、常驻通道起不来 —— 那些情况下
  //    一条推送都不会来。这条就是"降级之后客户端照常能用"的凭据。
  t.after(keepAlive());
  const b = new StubBackend();
  b.reply = () => ok({ session: view() });
  const ctrl = new SessionController({ backend: b, layoutId: 'L1', statusMs: 20 });
  ctrl.state = State.RUNNING;
  ctrl.sessionId = 's1';
  ctrl.session = view();
  ctrl._lastTarget = ctrl.session.tunnel_target;
  ctrl._watchBackend(true);          // 订阅了，但这个后端一条推送都不发
  ctrl._startStatusPoll();
  t.after(() => ctrl._stopStatusPoll());
  await new Promise((r) => setTimeout(r, 90));
  assert.ok(b.count('status') >= 3, `轮询必须照常跑，实际 ${b.count('status')} 次`);
});

test('★ 推送健康时，到点的轮询**不问**（这就是省下来的那个 exec）', async (t) => {
  t.after(keepAlive());
  const b = new StubBackend();
  b.reply = () => ok({ session: view() });
  const ctrl = new SessionController({ backend: b, layoutId: 'L1', statusMs: 20 });
  ctrl.state = State.RUNNING;
  ctrl.sessionId = 's1';
  ctrl.session = view();
  ctrl._lastTarget = ctrl.session.tunnel_target;
  ctrl._watchBackend(true);
  ctrl._startStatusPoll();
  t.after(() => ctrl._stopStatusPoll());
  // 每 10 毫秒喂一条推送（没有变化的那种），全程压在 statusMs 之内
  const feed = setInterval(() => push(ctrl), 10);
  t.after(() => clearInterval(feed));
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(b.count('status'), 0, '推送在喂的时候一次都不该问');
});

test('★★ 推送停了超过看门狗 ⇒ 轮询自己接上（不是静默地不更新了）', async (t) => {
  // ★ 通道断了、守护进程重启 —— 这些都会让推送停掉。不接上的后果是**界面从此
  //   冻在最后一帧上**，而它看起来只像是"作业一直没变"。
  t.after(keepAlive());
  const b = new StubBackend();
  b.reply = () => ok({ session: view() });
  const ctrl = new SessionController({
    backend: b, layoutId: 'L1', statusMs: 20, pushStaleMs: 45 });
  ctrl.state = State.RUNNING;
  ctrl.sessionId = 's1';
  ctrl.session = view();
  ctrl._lastTarget = ctrl.session.tunnel_target;
  ctrl._watchBackend(true);
  ctrl._startStatusPoll();
  t.after(() => ctrl._stopStatusPoll());
  push(ctrl);                                   // 喂一条，让它先"健康"起来
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(b.count('status'), 0, '前提：健康的这一段确实不问');
  await new Promise((r) => setTimeout(r, 60));  // 越过看门狗
  assert.ok(b.count('status') >= 1, '看门狗过了之后必须自己接上');
});

test('★ 看门狗必须**严格大于**守护进程的快照周期', () => {
  // 守护进程保证"哪怕什么都没变也每 30 秒推一条"。取小了会把**正常的空闲**
  // 读成"通道坏了"，于是每一轮都去问一次 —— 把这一版省下来的东西原样还回去。
  // （跨文件那一半在 cluster 用例 26.18 里。）
  assert.ok(PUSH_STALE_MS > 30000, `看门狗 ${PUSH_STALE_MS}ms 太短`);
});

// ── 别的 ──────────────────────────────────────────────────────────────────
test('★ `stale` 要说出来（不说的话，画面比服务端旧而用户无从知道）', async (t) => {
  t.after(keepAlive());
  const b = new StubBackend();
  const ctrl = running(b);
  push(ctrl, undefined, { stale: { dropped: 4, from: 1 } });
  await tick();
  assert.match(ctrl.warning, /4 条/);
});

test('★ 排队那一段不消费推送（那一段由 _waitForEnroll 的轮询负责）', async (t) => {
  t.after(keepAlive());
  const b = new StubBackend();
  const ctrl = new SessionController({ backend: b, layoutId: 'L1' });
  ctrl.state = State.QUEUED;
  ctrl.sessionId = 's1';
  ctrl._watchBackend(true);
  push(ctrl, [view({ job_state: 'PENDING' })]);
  await tick();
  assert.equal(ctrl.session, null, '排队期推送不该改视图');
  assert.equal(b.count('status'), 0);
});

test('★ stop() 之后退订：释放期的推送不许再写一个没人看的状态', async (t) => {
  t.after(keepAlive());
  const b = new StubBackend();
  const ctrl = running(b);
  assert.equal(b.listenerCount('notify'), 1);
  await ctrl.stop();
  assert.equal(b.listenerCount('notify'), 0, '拆的时候必须退订（不然监听器只增不减）');
  const seen = ctrl.session;
  push(ctrl, [view({ job_state: 'COMPLETED', job_terminal: true })]);
  await tick();
  assert.equal(ctrl.session, seen, '退订之后推送不该再改任何东西');
});

test('★★ 心跳有没有落地那条校验，推送那条路上也要生效', async (t) => {
  // ★ 它守的是最危险的那件事：心跳不落地 ⇒ 300 秒 suspect ⇒ 1800 秒自动 scancel。
  //   如果这条校验只留在轮询里，那么"推送健康"（也就是这一版**最正常**的状态）
  //   恰恰是它**静默失效**的那种状态。
  t.after(keepAlive());
  const b = new StubBackend();
  const ctrl = running(b);
  ctrl._heartbeatAt = Date.now();
  const ancient = Math.floor(Date.now() / 1000) - 600;
  push(ctrl, [view({ last_hb_at: ancient })]);
  await tick();
  assert.match(ctrl.warning, /心跳已过期/);
});

test('★ 等登记那段轮询也走同一个合并入口（口令不许被一次抖动抹掉）', async (t) => {
  // ★ 判据不是"能不能连上"：那一轮轮询每 3 秒一次，而口令要等状态越过 ACL
  //   边界才出现。直接赋值的话，一次读会话文件失败（NFS 抖动）就会把它抹掉，
  //   而**登记完成之后轮询就停了** —— 此后没有任何一条路会把它拿回来。
  t.after(keepAlive());
  const b = new StubBackend();
  let polls = 0;
  b.reply = (req) => {
    if (req.op !== 'status') return ok({});
    polls += 1;
    return polls === 1
      // 第一次：口令有了，但还没登记完
      ? ok({ session: view({ tunnel_target: null, auth_password: 'pw-secret' }) })
      // 第二次：登记完了，而这一次读会话文件失败了（没有口令）
      : ok({ session: view({ auth_password: undefined }) });
  };
  const ctrl = new SessionController({ backend: b, layoutId: 'L1', queuedPollMs: 10 });
  ctrl.sessionId = 's1';
  t.after(() => { ctrl._stopped = true; });
  const enrolled = await ctrl._waitForEnroll();
  assert.equal(enrolled, true, '第二次就该登记完');
  assert.equal(ctrl.state, State.RUNNING);
  assert.equal(ctrl.session.auth_password, 'pw-secret', '口令不许被那一次抖动抹掉');
});
