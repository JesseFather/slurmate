/**
 * resident-channel.test.mjs —— 常驻通道**客户端那一半**的字节层。
 *
 * ★ 这一份之所以验得了，是因为 `ResidentChannel` 只认字节与行、不认识 SSH：
 *   传进去的就是一个 duplex。真起一条 SSH 才跑得起来的话，下面这几条**最要紧**
 *   的性质一条都测不到 —— 而它们的坏法全是静默的：
 *
 *   - 断开时在途请求**永远挂着**（`await` 不回，调用方的定时器一轮轮往上叠）
 *   - 迟到的响应被当成一条**通知**处理
 *   - 一个多字节字符被两个 chunk 从中间切开 ⇒ 界面上出现一个 ""，
 *     而且是**间歇性**的，本地永远复现不了
 *
 * ★ 真 SSH 那一层只在 backend-ssh.test.mjs 里验（用一条假 conn），
 *   而那一条验的是别的东西：什么时候走通道、什么时候退回 exec。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ResidentChannel, parseEnvelopeLine, RPC_TIMEOUT_MS } =
  require('../src/main/backend-ssh.js');

/** 一个够用的 duplex：能写、能喂数据、能关。**不做任何流控**。 */
class FakeDuplex extends EventEmitter {
  constructor() {
    super();
    this.written = '';
    this.closed = false;
  }

  write(s) { this.written += s; return true; }
  close() { this.closed = true; this.emit('close'); }
  /** 把服务端要说的话送进来（**按原样**，一个字节都不合并）。 */
  feedRaw(buf) { this.emit('data', Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8')); }
  feed(s) { this.feedRaw(Buffer.from(s, 'utf8')); }
  /** 已经写出去的那几行，解析成对象。 */
  sent() {
    return this.written.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
}

/**
 * 所有用例都过这一层。
 *
 * ★ `backend-ssh.js` 里的定时器都 `unref` 了 —— 在 Electron 主进程里这是对的
 *   （应用自己撑着事件循环）。而测试进程没有别的事可做，于是 node:test 会在一条
 *   Promise 还没落地的时候报「事件循环已经空了」，把用例**取消**掉。
 *   同一形状的 `keepAlive` 在 integration.mjs 里也有。
 */
function keepAlive() {
  const t = setInterval(() => {}, 1000);
  return () => clearInterval(t);
}

/** 直接调 `test` 的用例都得自己撑住事件循环，见上。 */
const t2 = (name, fn) => test(name, (t) => { t.after(keepAlive()); return fn(t); });

function makeChannel(extra = {}) {
  const stream = new FakeDuplex();
  const notes = [];
  const closes = [];
  const ch = new ResidentChannel(stream, {
    onNotify: (m) => notes.push(m),
    onClose: (why, deliberate) => closes.push({ why, deliberate }),
    ...extra,
  });
  return { stream, ch, notes, closes };
}

/** 一个应答信封。 */
const okEnv = (rid, data = {}) => JSON.stringify({ ok: true, code: 0, data, error: null, rid });
const pushEnv = (seq, sessions = []) =>
  JSON.stringify({ push: 'sessions', seq, at: 1, sessions });

// ── 一行的判据：两种形状，缺一不可 ────────────────────────────────────────
t2('★ 一行的判据认得两种形状：响应（带布尔 ok）与通知（push + seq）', () => {
  assert.ok(parseEnvelopeLine('{"ok":true,"code":0}'), '响应要认得');
  assert.ok(parseEnvelopeLine('{"push":"sessions","seq":3,"sessions":[]}'), '通知要认得');
  // 下面这些都不是我们的消息，必须返回 null —— 返回一个对象就等于把它送进
  // classify()，然后被解释成一个关于协议的错误，而真正的原因（噪声）不会被提到。
  assert.equal(parseEnvelopeLine('{"hello":"world"}'), null);
  assert.equal(parseEnvelopeLine('[1,2,3]'), null);
  assert.equal(parseEnvelopeLine('"一个字符串"'), null);
  assert.equal(parseEnvelopeLine('{"push":"sessions"}'), null, '没有 seq 不算通知');
  assert.equal(parseEnvelopeLine('{"ok":"yes"}'), null, 'ok 必须是布尔');
  assert.equal(parseEnvelopeLine('这不是 JSON'), null);
});

// ── rid 关联 ──────────────────────────────────────────────────────────────
t2('每条请求一个自增 rid，写出去的行里有它', async () => {
  const { stream, ch } = makeChannel();
  const p1 = ch.request({ op: 'ping' });
  const p2 = ch.request({ op: 'ping' });
  assert.deepEqual(stream.sent().map((m) => m.rid), [1, 2]);
  stream.feed(okEnv(2, { which: 'second' }) + '\n');
  stream.feed(okEnv(1, { which: 'first' }) + '\n');
  assert.equal((await p1).data.which, 'first');
  assert.equal((await p2).data.which, 'second');
});

t2('★★ 响应乱序回来也各归各的（并发发出去的请求不许按序假设）', async () => {
  const { stream, ch } = makeChannel();
  const ps = [ch.request({ op: 'a' }), ch.request({ op: 'b' }), ch.request({ op: 'c' })];
  for (const rid of [3, 1, 2]) stream.feed(okEnv(rid, { rid }) + '\n');
  const got = await Promise.all(ps);
  assert.deepEqual(got.map((r) => r.data.rid), [1, 2, 3]);
});

t2('通知不进任何 pending，走 onNotify', async () => {
  const { stream, ch, notes } = makeChannel();
  const p = ch.request({ op: 'status' });
  stream.feed(pushEnv(7, [{ session_id: 's1' }]) + '\n');
  stream.feed(okEnv(1, { fine: true }) + '\n');
  assert.equal((await p).data.fine, true);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].seq, 7);
  assert.deepEqual(notes[0].sessions, [{ session_id: 's1' }]);
});

t2('★ 迟到的响应被丢掉，**不会**被当成一条通知', async () => {
  // 超时之后调用方早就拿到 transport 错误了。这条响应回来时 Map 里已经没有它 ——
  // 此时"没有 rid"和"rid 认不出来"是两件完全不同的事，混起来就会凭空冒出一条通知。
  const { stream, ch, notes } = makeChannel();
  const p = ch.request({ op: 'slow' }, 10);
  assert.equal((await p).ok, false);
  stream.feed(okEnv(1, { too: 'late' }) + '\n');
  assert.equal(notes.length, 0, '迟到的响应不是通知');
});

// ── 分帧 ──────────────────────────────────────────────────────────────────
t2('一个 chunk 里多条消息、一条消息跨多个 chunk，都拼得出来', async () => {
  const { stream, ch, notes } = makeChannel();
  const p = ch.request({ op: 'x' });
  stream.feed(okEnv(1, { n: 1 }).slice(0, 12));
  stream.feed(okEnv(1, { n: 1 }).slice(12) + '\n' + pushEnv(2) + '\n' + pushEnv(3) + '\n');
  assert.equal((await p).data.n, 1);
  assert.deepEqual(notes.map((m) => m.seq), [2, 3]);
});

t2('★★ 一个多字节字符被 chunk 从中间切开，**不许**变成 U+FFFD', async () => {
  // 这是真会发生的：分片边界由传输层决定，落在哪个字节上完全随机 ——
  // 所以坏法是**间歇性**的，而症状是插件标题/分区名里偶尔多一个 ""。
  const { stream, ch } = makeChannel();
  const p = ch.request({ op: 'plugins' });
  const line = Buffer.from(okEnv(1, { title: '代码服务器 · A6000 分区' }) + '\n', 'utf8');
  // 从每个字节位置切一刀，逐条验 —— 只挑一个位置的话，这个用例自己也是碰运气。
  for (let i = 1; i < line.length; i++) {
    const { stream: s2, ch: ch2 } = makeChannel();
    const p2 = ch2.request({ op: 'plugins' });
    s2.feedRaw(line.subarray(0, i));
    s2.feedRaw(line.subarray(i));
    const got = await p2;
    assert.equal(got.data.title, '代码服务器 · A6000 分区',
      `在第 ${i} 个字节处切开之后标题被撕坏了`);
  }
  stream.feedRaw(line);
  assert.equal((await p).data.title, '代码服务器 · A6000 分区');
});

t2('噪声行（登录 shell 的 rc 文件打印的东西）被忽略', async () => {
  const { stream, ch, notes } = makeChannel();
  const p = ch.request({ op: 'ping' });
  stream.feed('/etc/zshenv 说了句话\n{"hello":"world"}\n');
  stream.feed(okEnv(1, { pong: true }) + '\n');
  assert.equal((await p).data.pong, true);
  assert.equal(notes.length, 0);
});

// ── 断开与上限 ────────────────────────────────────────────────────────────
t2('★★ 通道断了 ⇒ 在途请求**全部**拿到答复，不是永远挂着', async () => {
  // ★ 这条是承重的：漏掉它的症状是 `await` 永远不回，而调用方（心跳那一类
  //   定时器）会一轮轮往上叠新的请求 —— 每 45 秒一条，永远不清理。
  const { stream, ch } = makeChannel();
  const a = ch.request({ op: 'a' });
  const b = ch.request({ op: 'b' });
  stream.emit('close');
  const [ra, rb] = await Promise.all([a, b]);
  for (const r of [ra, rb]) {
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, 'transport', '必须是传输层错误，交给 classify 分类');
  }
  assert.equal(ch.dead, '常驻通道已关闭');
});

t2('断开之后新发的请求立刻拿到错误，不再往一条死通道上写', async () => {
  const { stream, ch } = makeChannel();
  stream.emit('close');
  const before = stream.written;
  const r = await ch.request({ op: 'x' });
  assert.equal(r.ok, false);
  assert.equal(stream.written, before, '死了就不该再写');
});

t2('★ 一行超过上限 ⇒ 判死（而不是让缓冲区无限涨）', async () => {
  const { stream, ch } = makeChannel();
  const p = ch.request({ op: 'big' });
  stream.feed('x'.repeat(5 * 1024 * 1024));
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error.detail, /一行过大/);
});

t2('★ 自己 close() 记成 deliberate —— 调用方据此**不重开**', async () => {
  // 混起来的后果具体：探针失败时客户端会去重开，而重开又失败又一秒一条 ——
  // 登录节点上每两秒一个 `slurmate stream` 进程，日志里什么都没有。
  const { ch, closes } = makeChannel();
  ch.close();
  assert.deepEqual(closes, [{ why: '常驻通道已被客户端关闭', deliberate: true }]);
});

t2('对端关掉是 **non**-deliberate（这条才该重开）', async () => {
  const { stream, closes } = makeChannel();
  stream.emit('close');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].deliberate, false);
});

t2('写完超时不影响通道本身，只丢那一条请求', async () => {
  // 一条请求超时**不是**通道坏了（submit 合法地要跑 45 秒）。判死通道的话，
  // 一次慢提交会把所有人都从常驻通道上踢回 exec。
  const { stream, ch } = makeChannel();
  const slow = ch.request({ op: 'slow' }, 10);
  assert.equal((await slow).ok, false);
  assert.equal(ch.dead, null, '通道还活着');
  const p = ch.request({ op: 'fast' });
  stream.feed(okEnv(2, { fine: true }) + '\n');   // rid 2 —— 超时那条吃掉了 1
  assert.equal((await p).data.fine, true);
});

t2('兜底的请求超时比任何一个调用点的语义超时都长', () => {
  // 语义超时在调用点（submit 45s / goodbye 10s / claim 20s）。兜底比它们短的
  // 后果是**它抢先切断一条合法请求**，而用户看到的是"提交超时"——
  // 一句把根因指向集群的话。
  assert.ok(RPC_TIMEOUT_MS > 60000, `兜底超时太小了：${RPC_TIMEOUT_MS}`);
});
