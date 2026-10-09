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
    },
  };
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
  return { byId, text, subs, run: (e) => vm.runInContext(e, ctx) };
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
