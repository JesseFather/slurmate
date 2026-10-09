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
 * hover.test.mjs —— 浮窗那一层（两条边栏滑出来的那块）**真的跑起来**画一遍。
 *
 * ★ 它守的是**站点状态那一块搬过一次家**这件事：从前它在面板里
 *   （`#sec-cluster`），现在它是一个独立的 renderer。搬家最容易丢的不是代码，
 *   是**三态那条规矩** —— 「取不到」与「确实没有」在这一块里长得一样（都是一片空），
 *   而把前者画成后者，用户会去查一个不存在的问题。
 *
 * ★ 所以这一组只判两件事：
 *   1. 数据缺席时，**每一格**都有一行说"取不到"（而不是画成空的）；
 *   2. 而那几行在「确实没有」时**不许出现**。
 *
 * ★ 它跑的是真的 `hover.js` + `dom.js`（在一个人造 DOM 上），不是文本比对 ——
 *   文本比对拦不住"函数体里引用了一个不存在的变量"，而那个症状是浮窗一片空白。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, '..', 'src', 'renderer', f), 'utf8');

function mkEl(tag) {
  const e = {
    tagName: String(tag).toUpperCase(),
    children: [], className: '', value: '', title: '', disabled: false,
    onclick: null, _text: '',
    // 右栏那两块各自滚动，"只在贴底时自动滚"要读这三个数（见 hover.js 的 atBottomOf）。
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    append(...kids) { for (const k of kids) e.children.push(k); },
    appendChild(k) { e.children.push(k); return k; },
    addEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
  };
  e.classList = {
    _s: new Set(),
    add(...cs) { for (const c of cs) e.classList._s.add(c); },
    remove(...cs) { for (const c of cs) e.classList._s.delete(c); },
    contains(c) { return e.classList._s.has(c); },
    toggle(c, on) {
      const want = on === undefined ? !e.classList._s.has(c) : on;
      if (want) e.classList._s.add(c); else e.classList._s.delete(c);
      return want;
    },
  };
  Object.defineProperty(e, 'textContent', {
    get() { return e._text; },
    set(v) { e._text = String(v); e.children.length = 0; },
  });
  return e;
}

/** 把 `dom.js` + `hover.js` 在一个人造 DOM 上跑起来，返回读文本的几个助手。 */
function boot() {
  const byId = new Map();
  const subs = {};
  const doc = {
    createElement: (t) => mkEl(t),
    // 追加式绘制就是靠文本节点把"多出来的那几行"接上去的（见 hover.js 的 paintHalf）。
    createTextNode: (t) => ({ nodeType: 3, _text: String(t), textContent: String(t) }),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, mkEl('div'));
      return byId.get(id);
    },
    body: mkEl('body'),
  };
  const win = {
    hover: {
      onState: (fn) => { subs.state = fn; },
      onData: (fn) => { subs.data = fn; },
      probe: async () => ({ ok: true, rttMs: 12 }),
      more: async () => { calls.more += 1; return { ok: true }; },
    },
  };
  const calls = { more: 0 };
  const ctx = vm.createContext({ document: doc, window: win, Date, Promise, JSON,
    Math, Number, String, Object, Array, console });
  // ★ 顺序是承重的：`cel` / `na` / `agoText` 是**普通脚本之间的全局名字**
  //   （见 dom.js 的文件头），先后反了 hover.js 一进来就 ReferenceError。
  vm.runInContext(read('dom.js'), ctx, { filename: 'dom.js' });
  vm.runInContext(read('hover.js'), ctx, { filename: 'hover.js' });
  const text = (id) => {
    const out = [];
    const walk = (e) => {
      if (!e) return;
      if (e._text) out.push(e._text);
      for (const k of e.children || []) walk(k);
    };
    walk(byId.get(id));
    return out.join(' | ');
  };
  /** 与 `text` 同一趟走，但**不加分隔符** —— 右栏那两块是**追加式**画出来的，
   *  "接上去的那一段"必须能一个字一个字地看（`text` 会在每段之间插 ` | `）。 */
  const raw = (id) => {
    const out = [];
    const walk = (e) => {
      if (!e) return;
      if (e._text) out.push(e._text);
      for (const k of e.children || []) walk(k);
    };
    walk(byId.get(id));
    return out.join('');
  };
  return { byId, text, raw, subs, calls, run: (e) => vm.runInContext(e, ctx) };
}

/** 一份 `op_cluster` 的答案。`omit` 里列出的格子**整个键都不给**（= 取不到）。 */
function cluster(omit = []) {
  const d = {
    at: Math.floor(Date.now() / 1000),
    health: { up: true, at: Math.floor(Date.now() / 1000) },
    version: 'slurm-wlm 23.11.4',
    partitions: { gpu: { state: 'UP', is_default: true, max_time: '1-00:00:00', nodes: 12 } },
    nodes: { gpu: { counts: { idle: 10, mix: 2 }, flags: {} } },
    queue: { depth: { gpu: { pending: 0, running: 3, other: 0 } } },
    gres: { gpu: [{ name: 'gpu', label: 'gpu:a6000', per_node_max: 4 }] },
    taken: {},
    me: { account: 'lab', allowed_partitions: null,
      fairshare: { account: 'lab', fair_share: 0.42 },
      // ★ 这两格也要给：它们缺席时那一块会画一行"取不到"（`pending_count ===
      //   undefined` 就是"这一格没问到"），而那是**对的** —— 所以"数据齐全"
      //   这份夹具必须把它们带上，否则下面那条"不该有取不到"判的就是别的东西。
      pending_count: 0, first_in: {} },
  };
  for (const k of omit) delete d[k];
  return d;
}

test('★ hover.js 用到的每个 id 都在 hover.html 里，桥上的每个方法都在 preload 里', () => {
  // ★ 这两条是**跨文件**的，而它们守的是同一类静默失败：`$('cl-bdoy')` 打错一个
  //   字母，`getElementById` 返回 null，`box.textContent = ''` 当场抛 —— 或者更坏，
  //   一个 `?.` 兜住之后浮窗**永远空白**，而没有任何地方报错。
  //   panel.js 那一对在 renderer.test.mjs 里，这一对跟着它。
  const src = read('hover.js');
  const html = read('hover.html');
  const used = new Set([...src.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(used.size >= 5, `抽到的 id 太少（${used.size}），正则多半没匹配上`);
  const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !defined.has(id)).sort();
  assert.deepEqual(missing, [], `hover.js 引用了 hover.html 里不存在的 id：${missing.join('、')}`);

  const preload = fs.readFileSync(
    path.join(here, '..', 'src', 'preload', 'hover.js'), 'utf8');
  const exposed = new Set([...preload.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]));
  const called = new Set([...src.matchAll(/window\.hover\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const undeclared = [...called].filter((m) => !exposed.has(m)).sort();
  assert.deepEqual(undeclared, [],
    `hover.js 调了 preload 没暴露的方法：${undeclared.join('、')}`);
});

test('★★ hover.html 里不许有内联样式（CSP 会把它们静默丢掉）', () => {
  // ★ 面板那一侧的同一条在 renderer.test.mjs 里，理由逐字相同：CSP 没有
  //   'unsafe-inline'，`style="..."` 会被**静默丢弃**，表现是"布局莫名其妙不对"，
  //   而控制台之外没有任何提示。
  const html = read('hover.html');
  // ★ 查之前先去掉注释：解释这条规矩的那段注释里**必须**能写出 `style="..."` 这个
  //   样子，不然没法说清禁的是什么。查的是真标记。
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.equal(/\sstyle="/.test(markup), false, '浮窗页面里不许出现内联 style');
  assert.match(markup, /<link rel="stylesheet" href="hover.css">/, '样式要走外链');
  // ★ 还有一条更细的：样式块也不行。`<style>` 同样要 'unsafe-inline'，
  //   而它比 `style=` 更容易被顺手写进去。
  assert.equal(/<style[\s>]/.test(markup), false, '也不许用内联 <style> 块');
});

test('★★ 数据齐的时候，画得出来而且不抛（浮窗白屏的守卫）', () => {
  const h = boot();
  assert.doesNotThrow(() => h.subs.data({ cluster: cluster(), link: { connected: true } }));
  const t = h.text('cl-body');
  assert.match(t, /gpu/, '分区要画出来');
  assert.match(t, /23\.11\.4/, 'Slurm 版本');
  assert.match(t, /lab/, '账户');
  // URL 那一行说"这一份有多旧" —— 服务端的慢钟是 5 分钟，所以它是用户要看的一格。
  assert.match(h.text('cl-body'), /取数于/);
});

test('★★ 键缺席 = 「取不到」，而且**每一格**都要说出来', () => {
  // ★★ 这是搬家最容易丢的那条规矩。全缺的时候，用户必须能一句一句读到
  //    "哪一格没问到"，而不是面对一片空白去猜"是不是这台集群本来就没有"。
  const h = boot();
  h.subs.data({ cluster: cluster(['health', 'partitions', 'nodes', 'queue', 'gres']),
    link: { connected: true } });
  const t = h.text('cl-body');
  assert.match(t, /取不到：控制器状态/, '控制器那一格');
  assert.match(t, /取不到：分区列表/, '分区那一格');
  assert.match(t, /不是「没有」/, '★ 而且要说清这是"没问到"，不是"没有"');
  assert.match(h.text('cl-health'), /取不到/);
});

test('★★ 而「确实没有」的时候，那几行**一个字都不许出现**', () => {
  // 反过来的一半，缺了它上面那条就是一句空话：「取不到」那几行如果无论如何都画，
  // 它会在数据齐全的时候也说"没问到"，而那同样是替集群说了一句不成立的话。
  const h = boot();
  h.subs.data({ cluster: cluster(), link: { connected: true } });
  assert.equal(/取不到：/.test(h.text('cl-body')), false,
    '数据齐全时不该有任何一行"取不到"');
  // 三态里的第三态：`{}` = **确实没有**（一个分区都没有），与"取不到"不同。
  const d = cluster();
  d.partitions = {};
  h.subs.data({ cluster: d, link: { connected: true } });
  assert.match(h.text('cl-body'), /确实一个分区都没有/);
  assert.equal(/取不到：分区/.test(h.text('cl-body')), false);
});

test('★★ 链路断了就说断了 —— 它与集群那一份**不是一个时间尺度**', () => {
  const h = boot();
  h.subs.data({ cluster: cluster(), link: { connected: false, detail: '连接已断开' } });
  assert.match(h.text('cl-link'), /已断开/);
  assert.match(h.text('cl-link'), /连接已断开/, '原因也要露出来');
  h.subs.data({ link: { connected: true, hbAgeMs: 12000, rttMs: 33 } });
  assert.match(h.text('cl-link'), /已连接/);
  assert.match(h.text('cl-link'), /心跳 12 秒前/);
  assert.match(h.text('cl-link'), /延迟 33ms/);
});

test('★ 取不到集群信息时，那一句是**错误**，不是空白', () => {
  const h = boot();
  h.subs.data({ cluster: null, clusterError: '守护进程没有响应', link: { connected: true } });
  assert.match(h.text('cl-body'), /取不到集群信息：守护进程没有响应/);
});

// ── 右栏：作业输出 ──────────────────────────────────────────────────────────

/** 一格日志。`text` 走 `op_job_log` 给的那个形状（**止于换行**，见 paintHalf）。 */
const cellOf = (text, extra = {}) => Object.assign({
  path: '/h/.slurmate/logs/slurm-1.out', bytes: 100, lines: text.split('\n').length,
  truncated: false, mtime: 1, text, why: null,
}, extra);

/**
 * 推一份右边那一栏的数据。`out` / `err` 是**日志的两格**，而推过去的那个信封里
 * `out` 是 `{out, err}` **整个容器** —— 与 `index.js` 的 `pushOutToHover` 逐字同形。
 * ★ 夹具这里包错一层的话，`renderOut` 拿到的是"一格"，于是每一块都判成 absent，
 *   而症状是"右栏永远说还没有写出任何东西" —— 一个看起来像后端没数据的现象。
 */
const pushOut = (h, out, err, more = {}) => h.subs.data(
  Object.assign({ side: 'right', out: { out, err }, outLines: 200 }, more));

test('★★ 右栏两块各画各的，而**空的那一块不出现**', () => {
  const h = boot();
  pushOut(h, cellOf('宿主的一行\n服务的一行\n'), cellOf('认证被拒\n'));
  assert.match(h.text('out-out'), /服务的一行/);
  assert.match(h.text('out-err'), /认证被拒/);
  assert.doesNotMatch(h.text('out-out'), /认证被拒/, '两块不许串');
  assert.equal(h.byId.get('out-half-err').classList.contains('hidden'), false);

  // ★ 空的那一块不出现（设计律 1）—— 一个空的输出框是在说"这里本该有东西"，
  //   而 `.err` 在正常情况下**就是**空的。
  pushOut(h, cellOf('宿主的一行\n'), null);
  assert.equal(h.byId.get('out-half-err').classList.contains('hidden'), true,
    '`.err` 是 null ⇒ 那一块不出现');
});

test('★★ 「取不到」与「确实没有」在右栏里长得必须不一样', () => {
  const h = boot();
  pushOut(h, cellOf('', { text: null, why: 'component_group_or_world_writable',
                          bytes: null, lines: null }), null);
  assert.match(h.text('out-out'), /取不到：component_group_or_world_writable/,
    '★ 文件在、但读不了 —— 要说清是哪一条判据');
  assert.equal(h.byId.get('out-half-out').classList.contains('hidden'), false);

  // 而"确实没有这一份"是**不出现**，不是一行"取不到"
  pushOut(h, null, null);
  assert.equal(h.byId.get('out-half-err').classList.contains('hidden'), true);
  assert.doesNotMatch(h.text('out-out'), /取不到/, '确实没有 ≠ 取不到');
});

test('★★ 追加式绘制：第二帧只接新行，不重画（重画会毁掉用户正在拖的选区）', () => {
  const h = boot();
  const box = () => h.byId.get('out-out');
  pushOut(h, cellOf('A\nB\nC\n'), null);
  assert.equal(h.raw('out-out'), 'A\nB\nC');
  const nodes1 = box().children.length;

  pushOut(h, cellOf('A\nB\nC\nD\nE\n'), null);
  const t = h.raw('out-out');
  assert.equal(t, 'A\nB\nC\nD\nE', '新的两行要接上去，而且接在旧的那一段之后');
  assert.equal((t.match(/C/g) || []).length, 1, '★ 不许把已经画过的重画一遍（重复）');
  assert.equal(box().children.length, nodes1 + 1,
    '★ 只追加了一个节点 —— 整块重画的话节点数会变（而那正是毁掉选区的那种做法）');
});

test('★★ 窗口滑动之后仍然接得上（尾部视图最常见的那一帧）', () => {
  const h = boot();
  // 第一帧给 1..5，第二帧服务端只回 3..8（`lines` 是窗口，窗口会滑）
  pushOut(h, cellOf('1\n2\n3\n4\n5\n'), null);
  pushOut(h, cellOf('3\n4\n5\n6\n7\n8\n'), null);
  assert.equal(h.raw('out-out'), '1\n2\n3\n4\n5\n6\n7\n8',
    '★ 滑掉的那两行留在 DOM 里（用户翻上去还看得到），新接上的是 6/7/8');
  assert.equal((h.raw('out-out').match(/5/g) || []).length, 1,
    '★ 重叠的那一段不许画第二遍（拿"上一次的末尾"与"这一次的开头"对一遍正是为此）');
});

test('★★ 接不上就整块重画（文件被截断过 / 换过一份）', () => {
  const h = boot();
  pushOut(h, cellOf('甲\n乙\n丙\n'), null);
  pushOut(h, cellOf('戊\n己\n庚\n'), null);
  assert.equal(h.raw('out-out'), '戊\n己\n庚',
    '★ 不相干的两段粘在一起比重新画一遍更坏');
  assert.equal(/[甲乙丙]/.test(h.raw('out-out')), false, '旧的整段要被换掉，不是接在后面');
});

test('★★ 末尾那半行不画 —— 它下一次会以完整的样子再出现一遍', () => {
  // ★ 作业正把一行写了一半（还没有换行符）时，日志文件里就是"半句话"。
  //   画出去的话：中间那一刻显示的是半句，而下一帧那一行会**完整地再出现一次**
  //   （两行一模一样的开头），看起来像服务把同一句说了两遍。
  //   服务端那一头"丢掉窗口开头那半行"是同一条规矩的另一半。
  const h = boot();
  pushOut(h, cellOf('A\nB\n半'), null);
  assert.equal(h.raw('out-out'), 'A\nB', '没写完的那一行不许画出去');
  pushOut(h, cellOf('A\nB\n半行写完了\n'), null);
  assert.equal(h.raw('out-out'), 'A\nB\n半行写完了', '写完了才出现，而且只出现一次');
});

test('★★ 「只在贴底时自动滚」—— 用户翻上去看历史时不许把他拽回来', () => {
  const h = boot();
  // ★ 先画一次：元素是 `getElementById` **按需建**的，没画过之前 `byId` 里没有它。
  pushOut(h, cellOf('A\n'), null);
  const box = () => h.byId.get('out-out');
  // 贴底：滚到底之后新的内容要把它带着走
  box().scrollHeight = 100; box().clientHeight = 100; box().scrollTop = 0;
  pushOut(h, cellOf('A\n'), null);
  pushOut(h, cellOf('A\nB\n'), null);
  assert.equal(box().scrollTop, box().scrollHeight, '贴底时要跟着走');

  // 翻上去了：不许动他的滚动位置
  box().scrollHeight = 1000; box().clientHeight = 100; box().scrollTop = 10;
  pushOut(h, cellOf('A\nB\nC\n'), null);
  assert.equal(box().scrollTop, 10, '★ 用户在看历史 —— 拽回去就是把他正在读的那一段抽走');
});

test('★ 右栏「更多」按下去走桥上的 more()（浮窗自己不去问后端）', async () => {
  const h = boot();
  assert.equal(await h.byId.get('out-more').onclick(), undefined);
  assert.equal(h.calls.more, 1);
});
