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
 * renderer-dom.test.mjs —— 真的把 panel.js 跑起来，在一个人造 DOM 上。
 *
 * ── 为什么还需要这一组（renderer.test.mjs 已经在查了）────────────────────────
 *
 * 那一组是文本比对：id 对不对得上、有没有内联 style、四句话重没重。它拦不住
 * 一类错误：函数体里引用了一个不存在的变量。
 *
 * 这不是假想的。P1 那次改名（`layout` → `workspace`）把连接行那个下拉的变量从
 * `lay` 改成了 `pick`，漏掉两处引用。后果是 `renderConnections` 一进循环就抛
 * `ReferenceError: lay is not defined` —— 而它是画第一屏的函数：用户打开客户端
 * 看到的是一块白板。全套 560 条用例一条都没红：本机起不了 Electron，
 * 而那批文本判据读的是源码文本，它不会执行任何一个函数。
 *
 * 所以这一组的判据只有一句话：那几个 render 函数跑得起来，而且画出了该画的东西。
 * 它不需要浏览器，只要一个人造 DOM（见下面 `fakeDom`）。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────────
 *
 *   · 它不判界面好不好用（那只能人工跑一遍），只判"不白屏"与"画出来了"。
 *   · `init()` 那一行被摘掉再求值：它要的是整个启动序列（桥、后端、状态机），
 *     而这一组要的是那几个 render 函数。摘掉之后必须断言真的摘掉了 ——
 *     摘不掉的话整份文件会在 `init()` 里炸，而那看起来也像"跑过了"。
 *   · 文件末尾那条自检（拿一个故意的 `ReferenceError` 验架子）是这一组的前提：
 *     一个抓不住 P1 那个缺陷的架子，等于没有架子。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'panel.js'), 'utf8');
/**
 * 两个渲染页面共用的那三个小东西（`cel` / `na` / `agoText`）。
 *
 * 必须一起载进来，而且顺序在前：`panel.html` 就是这么排的（见那里那段
 *    注释），而这位置一旦反了 `panel.js` 一进来就 ReferenceError。
 * 少了它，"面板上某一块真的画出来了"这类断言会在一个空壳上通过 ——
 *      因为用到它的那几条路径一进去就抛，而 harness 把它们咽在 Promise 里了。
 */
const DOM_SRC = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'dom.js'), 'utf8');

/** 摘掉最后那一行 `init().catch(...)`。 */
function withoutInit(src) {
  const out = src.replace(/^init\(\)\.catch\([\s\S]*$/m, '');
  assert.notEqual(out, src, '没摘到 init() —— panel.js 末尾那一行的形状变了，'
    + '这一组会在启动序列里炸，而"炸了"与"跑过了"在这里长得相同');
  assert.equal(/\ninit\(\)/.test(out), false, '还有第二处 init() 调用');
  return out;
}

// ── 人造 DOM ────────────────────────────────────────────────────────────────
//
// 刻意做得很浅：每个元素只记下几个这一组真会读的属性（className / textContent /
// children / value），其余一律是能收能放的字段。不做松散代理 —— 代理会把
// `undefined.foo` 变成一次成功的取值，而那正是这一组要抓的东西。

function mkEl(tag) {
  const e = {
    tagName: String(tag).toUpperCase(),
    children: [], dataset: {}, attrs: {},
    _text: '', className: '', value: '', title: '', type: '', disabled: false,
    onclick: null, onchange: null, oninput: null, onkeydown: null, oncancel: null,
    style: {},
    open: false,
    // <dialog> 的那两个方法：`askFork` 会真的调用它们，缺了就是一次 TypeError
    // ——而"那一格按下去炸了"与"按下去没反应"在这一组眼里必须分得开。
    showModal() { e.open = true; },
    close() { e.open = false; },
    append(...kids) { for (const k of kids) e.adopt(k); },
    prepend(k) {
      if (k && typeof k === 'object') k.parentNode = e;
      e.children.unshift(k);
    },
    appendChild(k) { e.adopt(k); return k; },
    // `parentNode` / `insertBefore` / `nextSibling` / `contains` / `focus` 是被
    //   两段式确认（panel.js 的 `armConfirm`）拉进来的：它要把那一行确认插到
    //   那颗按钮后面，并把按钮自己留在 DOM 里（只加一个 class 不显示）。
    //   没有这几样的话，那一段代码一进去就 TypeError —— 而"炸了"与"守住了"
    //   在这一组眼里必须分得开。
    adopt(k) {
      // 字符串按文本节点收 —— 真的 DOM 就是这样，而 `append(图, '连接中…')`
      //   那一类写法在这一组里要能测得到（连接中的那颗按钮就是这么写的）。
      if (typeof k === 'string') k = { nodeType: 3, textContent: k };
      if (k && typeof k === 'object') { k.parentNode = e; e.children.push(k); }
      return k;
    },
    insertBefore(k, ref) {
      const i = ref ? e.children.indexOf(ref) : -1;
      if (i < 0) return e.adopt(k);
      if (k && typeof k === 'object') k.parentNode = e;
      e.children.splice(i, 0, k);
      return k;
    },
    get parentNode() { return e._parent || null; },
    set parentNode(p) { e._parent = p; },
    get nextSibling() {
      const p = e._parent;
      if (!p) return null;
      const i = p.children.indexOf(e);
      return i < 0 ? null : (p.children[i + 1] || null);
    },
    contains(k) {
      if (k === e) return true;
      return e.children.some((c) => c && typeof c.contains === 'function' && c.contains(k));
    },
    focus() { e._focused = true; },
    // 元素级的监听。两条边栏（`rail-left` / `rail-right`）的 `mouseenter`
    //   走的是这一对 —— `bindEvents()` 一跑就要用它，缺了就是一次 TypeError，
    //   而那看起来像"这一组用例本身坏了"，与"守住了"分不开。
    //   与 `doc._ls`（文档级那两条）分开记：它们是两码事，混在一起数不清。
    _ls: [],
    addEventListener(t, f) { e._ls.push([t, f]); },
    removeEventListener(t, f) {
      const i = e._ls.findIndex((x) => x[0] === t && x[1] === f);
      if (i >= 0) e._ls.splice(i, 1);
    },
    // 真的从父节点摘掉自己。壳里它是空的（`remove() {}`），而两段式确认
    //   靠"这一行还在不在"判可退 —— 摘不掉的壳会让"收起"这件事测不出来。
    remove() {
      const p = e._parent;
      if (!p) return;
      const i = p.children.indexOf(e);
      if (i >= 0) p.children.splice(i, 1);
      e._parent = null;
    },
    get lastChild() { return e.children[e.children.length - 1] || null; },
    setAttribute(k, v) { e.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(e.attrs, k) ? e.attrs[k] : null; },
    // 数量那一格（GRES 的「几个」）在没有选中任何卡的时候会把 `max` 摘掉 ——
    //   而那一格现在是每一块画出来的时候就会走一遍（`applyGresMaxFor`），所以这个
    //   法子从"用不到"变成了"一画就调"。缺了它就是一次 TypeError，看起来像"这一组
    //   用例本身坏了"，与"守住了"分不开。
    removeAttribute(k) { delete e.attrs[k]; },
    querySelectorAll() { return []; },
    // 给一个非零的矩形：这样 drawWorkspaceLines 那条路真的会走完
    // （全零的话它在 `if (!base.width)` 就返回了，而那条路正是"线画不画得出来"）。
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 120, bottom: 20, width: 120, height: 20 };
    },
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
    // 文本节点参与拼接，元素孩子不参与 —— 与真的 DOM 同一句话。只拼文本节点
    //   是有意收窄的：这一组里 `textContent` 的断言读的都是"这个元素自己写着
    //   什么"，把子树全拼进来会让它们悄悄变宽。
    get() {
      return e._text + e.children
        .map((c) => (c && c.nodeType === 3 ? c.textContent : ''))
        .join('');
    },
    set(v) {
      e._text = String(v);
      // 被清掉的那些孩子要脱离文档（`parentNode` 归零）—— 两段式确认收
      //   第一段时用的就是"这一行还在不在文档里"，而"清空 textContent"是重画
      //   一整块最常用的写法。
      for (const k of e.children) if (k && typeof k === 'object') k._parent = null;
      e.children.length = 0;
    },
  });
  return e;
}

/**
 * 把 panel.js 在一个假环境里跑起来，返回：
 *   · `ctx`   —— vm 上下文（要读/写里面那些顶层 `let` 就靠 `runInContext`）
 *   · `byId`  —— id → 元素（`$()` 拿到的那些）
 *   · `run`   —— 求值一段表达式（用来设 `boot` / `form` 这些顶层绑定）
 */
function boot(src) {
  const byId = new Map();
  const doc = {
    createElement: (t) => mkEl(t),
    createElementNS: (ns, t) => mkEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, mkEl('div'));
      return byId.get(id);
    },
    querySelectorAll: () => [],
    // 两段式确认在捕获阶段挂一个"点到别处就收起"的监听（见 armConfirm）。
    //   壳里这两条只记账：本机没有事件循环，而"点别处收起"那件事由那条真实的
    //   几何判据在真机上守，这里要守的是"挂上了、也摘掉了"。
    addEventListener(t, f) { doc._ls.push([t, f]); },
    removeEventListener(t, f) {
      const i = doc._ls.findIndex((x) => x[0] === t && x[1] === f);
      if (i >= 0) doc._ls.splice(i, 1);
    },
    _ls: [],
    body: mkEl('body'),
  };
  const ctx = vm.createContext({
    document: doc,
    window: { slurmate: {}, confirm: () => true },
    requestAnimationFrame: (f) => { f(); return 1; },
    setTimeout, clearTimeout, console, Promise, JSON, Math, Number, String, Object, Array,
  });
  vm.runInContext(DOM_SRC, ctx, { filename: 'dom.js' });
  vm.runInContext(withoutInit(src), ctx, { filename: 'panel.js' });
  return {
    byId, doc,
    run: (expr) => vm.runInContext(expr, ctx),
    fn: (name) => vm.runInContext(name, ctx),
  };
}

const CONNS = [
  { id: 'c1', user: 'alice', host: '198.51.100.7', port: 10100, workspaceId: 'w000000000001' },
  { id: 'c2', user: 'bob', host: '198.51.100.9', port: 10100, workspaceId: 'w000000000002' },
];
/** 两份数据，各归一个工作区。`refs` 是那张引用表（`插件 id → 数据 id`）。 */
const SPACES = [
  { id: 's000000000001', pluginId: 'p1', group: 'editor', ports: [18080] },
  { id: 's000000000002', pluginId: 'p1', group: 'editor', ports: [18081] },
];
const WSS = [
  { id: 'w000000000001', name: '工作区 1', refCount: 1, members: ['c1'], soleOwnerId: 'c1',
    refs: { p1: 's000000000001' }, spaces: ['s000000000001'] },
  { id: 'w000000000002', name: '工作区 2', refCount: 1, members: ['c2'], soleOwnerId: 'c2',
    refs: { p1: 's000000000002' }, spaces: ['s000000000002'] },
];

/** 一份界面视图（`pluginsView` 的形状，只留这一组用例真读到的那些格）。 */
const PV = {
  plugins: [
    { id: 'p1', name: 'cs', title: '编辑器', version: '1.0.0', description: '',
      ports: 1, group: 'editor', runnable: true, hasClientCode: true,
      siteEnabled: true, siteKnown: true, locallyEnabled: true, canSubmit: true,
      defaults: null },
    // 不要数据空间的那一种：它没有「用哪一份数据」这一格。
    { id: 'p2', name: 'relay', title: '中转站', version: '1.0.0', description: '',
      ports: 0, group: 'relay', runnable: true, hasClientCode: false,
      siteEnabled: true, siteKnown: true, locallyEnabled: true, canSubmit: true,
      defaults: null },
  ],
  errors: [], problems: [], missing: [], consent: [], inert: [], site: null,
};

/** 起一个装好数据的 panel.js。`extra` 是往 vm 里再跑的一段赋值（设 form / wsPicked…）。 */
function start(bootObj, extra = '') {
  const h = boot(SRC);
  h.run(`boot = ${JSON.stringify(bootObj)}; connected = false;`
    + 'lastProbe = []; lastSnap = null; SESS = { sessions: [], front: null };');
  if (extra) h.run(extra);
  return h;
}

/**
 * 把 `bindEvents()` 在假环境里真的跑一遍 —— 它就是真机上启动的第一件事。
 *
 * 这一组从前只测得到"某个 render 函数画出了什么"。而"点下去走的是哪条路"
 *   落在绑定上，绑定在 `bindEvents()` 里，不跑它就一个都测不到。
 *
 * 它同时是那条缺陷的守卫：绑定从前排在 `init()` 那几个 `await` 的后面，
 *   一次 reject 就让整块都不执行。这里从"跑不跑得完"那一侧判 —— 跑得完，
 *   那几格就有动作（见下面那条"bootstrap 挂了"的用例）。
 *
 * 那几样是壳里没有、而 `bindEvents` 会碰的运行期接口（真机上由 preload 提供）。
 */
function bindAll(bootObj, extra = '') {
  const h = start(bootObj, extra);
  h.run('window.addEventListener = () => {};'
    + 'window.slurmate.onSite = () => {}; window.slurmate.onStates = () => {};'
    + 'window.slurmate.onSiteClosed = () => {};'
    + 'window.slurmate.onNotice = () => {}; window.slurmate.onPlugins = () => {};');
  h.fn('bindEvents')();
  return h;
}

test('第一屏画得出来（这一条就是 P1 那个白屏缺陷的守卫）', () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  // 从前这里抛 `ReferenceError: lay is not defined`，而它是画第一屏的函数：
  // 用户打开客户端看到的是一块白板，560 条用例一条都不红。
  assert.doesNotThrow(() => h.fn('renderConnections')(CONNS),
    'renderConnections 抛了 —— 第一屏会是一块白板');

  const rows = h.byId.get('conn-list').children;
  assert.equal(rows.length, 2, '两条连接就该画两行');
  // 而每一行里都不该再有一个下拉：那个「这条连接用哪个工作区」搬进了
  //   连接表单（「③ 工作区」）。它留下的是一类缺陷（一个改了名却没改全的变量），
  //   而这一条把它钉在"画出来的东西"上 —— 不是钉在源码文本上。
  for (const r of rows) {
    assert.equal(childrenOf(r).some((x) => x.tagName === 'SELECT'), false,
      '连接行里不该再有下拉（工作区那一格在连接表单里）');
  }
});

test('「新建连接」的显隐只有一处判据：表单开着', () => {
  // 两处会改到它：打开表单、收起表单。各写一遍 `classList.add/remove` 会漂，
  //   判据只有 `syncNewButton()` 这一份。
  const h = start();
  h.run('form = { open: false };');
  h.fn('syncNewButton')();
  assert.equal(h.byId.get('btn-new').classList.contains('hidden'), false,
    '表单收着 —— 那颗按钮要露着');

  h.run('form = { open: true };');
  h.fn('syncNewButton')();
  assert.equal(h.byId.get('btn-new').classList.contains('hidden'), true,
    '表单开着时它收起来（表单自己就是新建那一件事）');
});

test('两段式确认：第一次只是把那一格换成一行确认，第二次才真的做', () => {
  // 这一条守的是设计律 2：代价大的动作由"必须先经过的那一步"承载。
  //   第一段可退（点到别处、按 Esc、「取消」都回到原样），第二段才不可逆 ——
  //   而 `window.confirm` 给不了两段：框弹出来的时候用户已经按下去了。
  //
  // 四条判据，缺一条这条规矩就不成立：
  //   · 第一下一个请求都不发（"点了就发"= 没有第二段）；
  //   · 那一行里要说出后果（只说"确定吗"，用户答不了）；
  //   · 第二下才发，而且恰好一次；
  //   · 原来那颗按钮还在 DOM 里（只加一个 class 不显示）—— 删掉它的话，
  //     `renderSnapshot` 下一次按 `running` 去 toggle 它的 `hidden` 就作用在 null 上。
  //
  // 载体是状态条上的「结束会话」（`#sb-end`）：留下的五处两段式里，它是唯一
  //   一颗固定在 HTML 里的按钮 —— 另外四处（断开也固定，但切走工作区的第一段
  //   挂在运行期画的那个下拉上，插件数据与「删除一条连接」那两颗按钮也是运行期
  //   画的）驱动起来都要先把一整块画出来。机制是同一份（`armConfirm`），所以拿它
  //   当代表最省事也最直接。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'SESS = { sessions: [{ slot: "s1", live: true }], front: "s1" };'
    + 'window.__calls = [];'
    + 'window.slurmate.stop = (slot) => { window.__calls.push(slot);'
    + ' return Promise.resolve({ ok: true }); };');
  // 那一行确认是 `insertBefore(cluster, anchor.nextSibling)` 插进去的，锚点
  //   得真的在文档里才看得见它。壳里 `$()` 现造的元素没有父节点。
  h.run("document.body.append($('sb-end'));");
  const end = h.byId.get('sb-end');

  const clusterOf = () => {
    const p = end.parentNode;
    return p.children[p.children.indexOf(end) + 1];
  };

  // ── 第一段 ──
  end.onclick();
  assert.equal(h.run('window.__calls.length'), 0,
    '第一次不许发 —— 它是第一段，只把那一格换成一行确认');
  assert.notEqual(h.run('armed'), null, '第一段要挂在 armed 上（否则没有任何内容收得掉它）');
  assert.equal(end.classList.contains('armed-off'), true,
    '原来那颗按钮留在 DOM 里、只是不显示');
  const cluster = clusterOf();
  assert.ok(cluster, '那一行确认要插在锚点后面');
  assert.equal(cluster.className, 'armed');
  const why = cluster.children[0]._text;
  assert.match(why, /作业会被取消/, '后果要说出来 —— 只说"确定吗"，用户答不了');
  // 条数那一格（`liveCount()`）长在「断开」那一行上（它一次结束好几条），
  //   而这条挂的是「结束这一条会话」—— 判据在那一条用例里。
  assert.match(h.run("$('sb-end').onclick.toString()"), /armConfirm/,
    '状态条那颗「结束会话」走的是两段式（不是直接 endFrontSession）');

  // 那一行里两颗按钮必须长得不一样：一颗是不可逆的第二段（danger），
  //   一颗是回到原样（ghost）。画成一样的，用户分不清自己按下去的是哪个 ——
  //   而这一整条规矩（不可逆的动作要有"必须先经过的那一步"）要成立，靠的正是
  //   "第二段看得出来是第二段"。
  assert.match(cluster.children[1].className, /danger/,
    '第二段那颗按钮要是 danger —— 它才是不可逆的那一步');
  assert.match(cluster.children[2].className, /ghost/,
    '而「取消」是 ghost：它与第二段不是同一类动作');

  // ── 取消：一行收掉，回到原样，一个字节都没发 ──
  cluster.children[2].onclick();
  assert.equal(h.run('armed'), null, '取消之后不该还挂着一个第一段');
  assert.equal(end.classList.contains('armed-off'), false, '取消之后那颗按钮要回来');
  assert.equal(end.parentNode.children.includes(cluster), false, '那一行要从 DOM 里摘掉');
  assert.equal(h.run('window.__calls.length'), 0, '取消 = 什么都没发生');
  assert.equal(h.run('document._ls.length'), 0,
    '那两个"点别处 / 按 Esc"的监听也要一起摘掉 —— 每点一次多挂一个，它们会越攒越多');

  // ── 第二段 ──
  end.onclick();
  const p = clusterOf().children[1].onclick();
  assert.equal(h.run('armed'), null, '执行的那一刻要先把这一行收掉');
  assert.equal(h.run('document._ls.length'), 0);
  return p.then(() => {
    assert.deepEqual(h.run('JSON.parse(JSON.stringify(window.__calls))'), ['s1'],
      '第二次才发，而且恰好一次（发的正是前台那一条的槽）');
    assert.equal(h.run('document._ls.length'), 0);
  });
});

test('「删除一条连接」走两段式：第一次只摆一行确认，第二次才真的删', () => {
  // 它是运行期画出来的那一颗（在 `renderConnections` 里），没有 id 可找 ——
  //   得先把那一屏画出来，再从行里把它取出来。上面那条用的 `#sb-end` 是固定的。
  //
  // 为什么它要两段式（判据是代价，不是"不可逆"）：删掉一条连接会
  //   作废它的私钥（拿去 IDM 注册过的那把公钥就此失效），而它若是某个工作区
  //   最后一个主人，那个工作区的两份数据也一起清。这两样都不是"再建一条就是"。
  const named = [{ ...CONNS[0], label: '集群 A' }, CONNS[1]];
  const h = start({ connections: named, workspaces: WSS, activeConnectionId: 'c1' },
    'window.__deleted = [];'
    + 'window.slurmate.deleteConnection = (id) => { window.__deleted.push(id);'
    + '  return Promise.resolve({ ok: true, connections: [], activeConnectionId: null,'
    + '    keyDeleted: true }); };');
  h.fn('renderConnections')(named);

  const row = h.byId.get('conn-list').children[0];
  // 行里的顺序是 `li.append(t, m, main, edit, del)` 最后一颗就是「删除」。
  const del = row.children[row.children.length - 1];
  assert.equal(del.textContent, '删除', '行里最后一颗按钮应当是「删除」');
  const clusterOf = () => row.children[row.children.indexOf(del) + 1];

  // ── 第一段 ──
  del.onclick();
  assert.equal(h.run('window.__deleted.length'), 0,
    '第一次不许发 —— 它是第一段，只把那一格换成一行确认');
  const cluster = clusterOf();
  assert.ok(cluster && cluster.className === 'armed', '那一行确认要插在锚点后面');
  assert.equal(del.classList.contains('armed-off'), true,
    '原来那颗按钮留在 DOM 里、只是不显示');
  const why = cluster.children[0]._text;
  assert.match(why, /私钥一并作废/, '第一段要说清代价 —— 只说"确定吗"，用户答不了');
  // 而这句里的名字必须是这一行上印着的那个（有备注就是备注）：印地址的话，
  //   它指的就是一条"在这一屏上未找到"的连接。
  assert.equal(row.children[0]._text, '集群 A', '有备注的那一行印的就是备注');
  assert.equal(why.includes('集群 A'), true, '确认那一行要点名这一行上印着的那个名字');
  assert.equal(why.includes('alice@'), false, '而不是回落成地址');
  // 独占工作区那一条（`soleOwnerId` 与主进程数的是同一件事）
  assert.equal(why.includes('工作区 1'), true, '独占的工作区会跟着删 —— 这一句要说出来');
  assert.equal(why.includes('写在磁盘上的文件'), true, '磁盘上那一份也要说到');

  // ── 退回去：一个字节都没发 ──
  cluster.children[2].onclick();
  assert.equal(h.run('armed'), null, '取消之后不该还挂着一个第一段');
  assert.equal(del.classList.contains('armed-off'), false, '取消之后那颗按钮要回来');
  assert.equal(row.children.includes(cluster), false, '那一行要从 DOM 里摘掉');
  assert.equal(h.run('window.__deleted.length'), 0, '取消 = 什么都没发生');
  assert.equal(h.run('document._ls.length'), 0, '那两个"点别处 / 按 Esc"的监听也要摘干净');

  // ── 第二段：这才真的删 ──
  del.onclick();
  const p = clusterOf().children[1].onclick();
  assert.equal(h.run('armed'), null, '执行的那一刻要先把这一行收掉');
  return p.then(() => {
    assert.deepEqual(h.run('JSON.parse(JSON.stringify(window.__deleted))'), ['c1'],
      '第二次才发，而且恰好一次、发的正是这一条');
    assert.equal(h.byId.get('conn-list').children.length, 0,
      '删完那一行就没了 —— 列表按主进程回的那份重画');
  });
});

test('第一段退回去时，`onDisarm` 要把那一格拨回原样（切走工作区靠它）', () => {
  // 「切走工作区」的第一段挂在一个下拉上，而那个下拉停在用户刚选的
  //   "待定"的新值上 —— 那不是已发生的事。退回去（取消 / 点别处 / Esc / 被重画
  //   收掉）时如果不把它拨回旧值，界面就在说一件没发生的事。
  //   这正是 `armConfirm` 那个 `onDisarm` 存在的唯一理由。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.run("document.body.append($('sb-end'));");
  h.run('window.__revert = () => { window.__revN = (window.__revN || 0) + 1; };');
  h.fn('armConfirm')(h.byId.get('sb-end'), {
    why: '后果', yes: '切走', run: () => {}, onDisarm: h.run('window.__revert'),
  });
  h.run('window.__revN = 0;');
  h.run('armed.disarm()');
  assert.equal(h.run('window.__revN'), 1, '退回去要调 `onDisarm`');

  // 而第二段执行时不许调 —— 那一格已经被改动了，"拨回旧值"会让界面
  //   说一件没发生的事。
  h.fn('armConfirm')(h.byId.get('sb-end'), {
    why: '后果', yes: '切走', run: () => {}, onDisarm: h.run('window.__revert'),
  });
  h.run('window.__revN = 0;');
  h.run('armed.disarm(true)');
  assert.equal(h.run('window.__revN'), 0,
    '第二段（`disarm(true)`）不许跑 `onDisarm` —— 动作已经发生了');
});

test('切走工作区：主进程回 would_discard 时不弹框，摆一行确认，第二趟才带 confirmDiscard', async () => {
  // 这一条替掉的是从前那句 `window.confirm`。它守三件事：
  //   · 第一下不弹框、也不发第二次请求 —— 只是把那一格摆成一行确认；
  //   · 退回去要调 `revert`（把那一格拨回原样）；
  //   · 第二趟恰好带 `confirmDiscard: true` 再发一次。
  //   判定权在主进程（`would_discard` 是它算的），界面只负责问 —— 所以这条
  //     路的形状是"先发、被拒了再问、答了再发"，不是"先问再发"。
  // 状态条那个下拉 2026-10-18 删掉了，入口只剩连接表单里的「保存」；这一条
  //   直接驱动 `applyWorkspace`，与表单那条路是同一份实现。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'window.__calls = []; window.__asked = 0; window.__revN = 0;'
    + 'window.__revert = () => { window.__revN += 1; };'
    + 'window.slurmate.states = () => Promise.resolve({ sessions: [], front: null });'
    + 'window.slurmate.setConnectionWorkspace = (p) => {'
    + '  window.__calls.push(JSON.parse(JSON.stringify(p)));'
    + '  if (p.confirmDiscard) {'
    + `    return Promise.resolve({ ok: true, workspaces: ${JSON.stringify(WSS)},`
    + `      connections: ${JSON.stringify(CONNS)} }); }`
    + '  return Promise.resolve({ ok: false, code: "would_discard",'
    + '    workspaceName: "工作区 1" });'
    + '};'
    + 'window.confirm = () => { window.__asked += 1; return true; };');

  h.run("document.body.append($('btn-save'));");
  const anchor = h.byId.get('btn-save');
  const run = () => h.fn('applyWorkspace')('c1', 'w000000000002',
    { anchor, revert: h.run('window.__revert') });

  const r1 = await run();
  assert.equal(r1.armed, true, '被拒之后要摆出第一段');
  assert.equal(h.run('window.__asked'), 0,
    '不许弹 `window.confirm` —— 它给不了两段，而这正是这条路从前最别扭的地方');
  assert.equal(h.run('window.__calls.length'), 1, '第一次只发那一次（照常提交，判定权在主进程）');
  assert.equal(h.run('window.__calls[0].confirmDiscard'), undefined,
    '第一趟不许带 confirmDiscard —— 它是"照常试一次"');
  const p = anchor.parentNode;
  const cluster = p.children[p.children.indexOf(anchor) + 1];
  assert.match(cluster.children[0]._text, /工作区 1/, '第一段要说出哪一个工作区会没');

  // ── 退回去：调 revert，一个请求都不多发 ──
  cluster.children[2].onclick();
  assert.equal(h.run('armed'), null, '取消之后不该还挂着第一段');
  assert.equal(h.run('window.__revN'), 1,
    '退回去要把那一格拨回原样 —— 留着待定的新值就是界面在说一件没发生的事');
  assert.equal(h.run('window.__calls.length'), 1, '取消 = 什么都没发生');

  // ── 答"切走"：第二趟照常先发一次，再恰好带 confirmDiscard 发一次 ──
  await run();
  assert.equal(h.run('window.__calls.length'), 2,
    '第二趟也照常先提交一次（判定权始终在主进程）');
  const p2 = anchor.parentNode;
  const again = p2.children[p2.children.indexOf(anchor) + 1];
  await again.children[1].onclick();
  assert.equal(h.run('window.__calls.length'), 3, '答「切走」之后恰好再发一次');
  assert.equal(h.run('window.__calls[2].confirmDiscard'), true,
    '第二趟必须明确带上 confirmDiscard —— 少这一格就是同一个框弹两遍');
  assert.equal(h.run('window.__asked'), 0, '全程没有弹过框');
});

test('新建连接时端口预填 22 —— 通用默认，不是某个集群的端口', async () => {
  // 这一格的占位符从前写着某个开发集群的端口（10100），而占位符只在格子空着时
  //   看得见 —— 于是"默认"看起来像"我们推荐这个数"，而用户从那里拿到的是一个
  //   只在那一个集群上成立的答案。现在它是填好的 22（SSH 自己的默认端口）。
  const h = bindAll({}, 'window.slurmate.newKey = () => Promise.resolve({ ok: true,'
    + ' key: { fingerprint: "SHA256:aaa", publicKey: "ssh-ed25519 AAAA x" } });'
    + 'window.slurmate.defaultWorkspace = () => Promise.resolve({ ok: true, workspaceId: null });');
  await h.fn('openNewForm')();
  assert.equal(h.run("$('f-port').value"), '22');
  // 其余几格照旧清空 —— 预填地址会让「新建」悄悄变成「又存一遍」。
  assert.equal(h.run("$('f-host').value"), '');
  assert.equal(h.run("$('f-user').value"), '');
});

test('bootstrap 挂了，界面照样点得动（一次 reject 不许拆掉整块监听）', async () => {
  // 这条就是用户报的那个缺陷：主界面（连接列表）上点标题那一行没有反应。
  //   根因形状 —— 绑定从前排在 `init()` 那几个 `await` 的后面，于是
  //   `bootstrap()` 或 `openNewForm()`（里面有 `await newKey()`，在 Windows 上
  //   走 DPAPI）任何一次 reject，`init()` 就在那一行整体中止，2950 行往后
  //   一个监听都不挂，而唯一的症状是提示流里多一行字。
  //   现在分成 `bindEvents()`（纯同步，先跑）与 `bootUI()`（所有 await）。
  const h = bindAll({}, 'window.slurmate.bootstrap ='
    + ' () => Promise.reject(new Error("假装获取失败"));'
    + 'window.slurmate.pluginData = () => Promise.resolve({});');

  // ── 让 bootUI 照真机那条路失败 ──
  await h.fn('bootUI')().then(
    () => { throw new Error('bootUI 本该 reject'); },
    (e) => h.fn('onInitFailed')(e));

  // ── 那几格必须仍然有动作 ──
  // 判据落在 `bindEvents()` 真的跑完了：它同步挂完所有监听，而 `bootUI` 的
  //   失败发生在它之后。入口取 `#btn-new` —— 它固定在 panel.html 里。
  // 「关于」那颗不在这条判据里：它的展开与收起是 CSS（悬停 / 聚焦），
  //   一颗监听都不需要，所以"bootstrap 失败让它变哑"这件事在它身上不成立。
  const nx = h.run("$('btn-new')");
  assert.equal(typeof nx.onclick, 'function',
    '「新建连接」仍然要挂着动作 —— 首屏数据无法获取不该让界面变成哑的');

  // ── 而失败本身第一眼看得见（不再只滚进提示流）──
  const banner = h.byId.get('fatal-banner');
  assert.equal(banner.classList.contains('hidden'), false,
    '初始化失败要有一块常驻的地方说出来 —— 提示流会滚过去、也会被顶下去');
  assert.match(h.byId.get('fatal-why').textContent, /假装获取失败/,
    '而原因要照原话说出来');
});

test('关于卡片里的版本号是主进程给的那一个，缺了就照实说', () => {
  // 2026-10-18：用户报「关于里面的信息不对」。卡片里那一格版本读的是
  //   `app:bootstrap` 的 `version`（主进程的 `app.getVersion()`），界面不另写
  //   一个串 —— 写了就会漂，而且漂的方向是"界面上写着 A、装上去的是 B"。
  const h = start({});
  h.run('boot = { version: "9.9.9" };');
  h.fn('renderAbout')();
  assert.equal(h.byId.get('about-ver').textContent, '版本 9.9.9');

  h.run('boot = {};');
  h.fn('renderAbout')();
  assert.equal(h.byId.get('about-ver').textContent, '版本未知',
    '没有版本号时说「未知」，不猜一个数 —— 读成"这就是这一版"是最坏的一种');

  h.run('boot = null;');
  h.fn('renderAbout')();
  assert.equal(h.byId.get('about-ver').textContent, '版本未知',
    '连启动信息都没有的时候同样如此（它够得着在被赋值之前被调用）');
});

test('重画会把没走完的第一段收掉（重画的就是它挂身的那一片）', () => {
  // 不收的后果是静默的：那一行连同确认一起被丢掉，而 `armed` 还指着它 ——
  //   用户接着点"别处"收的是一个已经不在文档里的节点，看起来像没反应；
  //   更糟的是 `armed` 从此不为 null，下一次点另一处时 `disarmArmed()`
  //   先把这个幽灵收掉（白做一次），真正的第二段反而没了。
  //
  // 重画连接列表时必须先收：它重画的正是断开 / 探测那些第一段挂身的那一片。
  //   （从前还有第二处 —— `renderWorkspaceSelectors`；那一格 2026-10-18 随状态条
  //   的工作区下拉一起删掉了。）
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'SESS = { sessions: [{ slot: "s1", live: true }], front: "s1" };'
    + 'window.slurmate.stop = () => Promise.resolve({ ok: true });');
  h.run("document.body.append($('sb-end'));");
  const end = h.byId.get('sb-end');

  end.onclick();
  assert.notEqual(h.run('armed'), null, '前提：这里确实有一个没走完的第一段');
  h.fn('renderConnections')(CONNS);               // 探测 / 删掉一条 / 连上一条都会走这里
  assert.equal(h.run('armed'), null, '重画连接列表之前必须先把它收掉');
  assert.equal(h.run('document._ls.length'), 0);
  assert.equal(end.classList.contains('armed-off'), false,
    '那颗按钮的 class 也要拨回来 —— 残留的 `armed-off` 属于'
    + '"那颗按钮永远不显示"这一类看不见的坏法');

  end.onclick();
  assert.notEqual(h.run('armed'), null, '（前提）再摆一个');
  h.fn('renderConnections')(CONNS);
  assert.equal(h.run('armed'), null, '再收一次也相同 —— 它每次都先收');
});

test('「站点版本过高」那一句：正文只剩一行，理由挂 title', () => {
  // 这一条守的是"一段 → 一行 title"这个改动本身。原来那段话有三个句子
  //   （事实 / 为什么获取失败 / 该怎么办），而它读起来像一段讨论。
  //
  //   而它必须分叉：两种情形要用户做的事方向相反（升级客户端 /
  //     升级没用，得找管理员）。指错了方向，用户会去做一件解决不了问题的事 ——
  //     所以正文那一行必须是那个方向，理由放在 title 里。
  //
  //   判据是"正文短 + title 非空"，不是"某句话在不在"：后者在"整段又长回来"
  //     的时候照样绿。
  const h = start({ connections: [], workspaces: [], activeConnectionId: null });
  const show = (verdict) => {
    h.fn('renderSitePlugins')({ sitePoolDir: '/p',
      site: { label: '本站', reason: 'site_too_new', daemonVersionVerdict: verdict,
        versions: [], strays: [] } });
    return childrenOf(h.byId.get('site-plugins')).find((x) => x.className === 'why');
  };

  const cross = show('cross_major');
  assert.ok(cross, '跨大版本那一支要画出一句话');
  assert.match(cross._text, /请升级这个客户端/, '这一支的动作是"升级客户端"');
  assert.equal(cross._text.length <= 60, true,
    `正文只剩一行：${cross._text.length} 个字 —— 又长回去了。`
    + '理由进 title（下面那一句判它）');
  assert.match(cross.title || '', /大版本/,
    '理由要挂在 `title` 上 —— 若没有它，这一行就是一个没有出处的断言');

  const other = show('same_major');
  assert.match(other._text, /升级客户端解决不了/,
    '另一支必须明确否掉"升级客户端" —— 那是用户看了这句话唯一会去做的事，'
    + '而它对"站点自己不一致"这种情况没有用');
  assert.equal(other._text.length <= 60, true, '正文同样只留一行');
  assert.match(other.title || '', /站点自己不一致/,
    '而"凭什么这么判"要说得出来 —— 判定归握手（`daemonVersionVerdict`），'
    + '界面只负责按它选一句话');
});

test('「站点分发」那一块：一切正常时整块不画，出问题时只画问题那几句',
  () => {
    // 用户 2026-10-16 报的原话：「真实客户端这个站点分发的框应该整个不存在，
    //   但这里还是画出来了」。那一屏上它说的是「站点 … · 上次同步 … /
    //   本站支持分发插件。」—— 站点侧自检的口吻，而"本站会分发插件"上面那一块
    //   已经说过了。
    //
    // 而它承载的【问题】不跟着消失：站点太旧/太新、这一轮有包装不上、快照表
    //   读不到、本机那一份不见了 —— 那些照旧说。
    const h = start({ connections: [], workspaces: [], activeConnectionId: null });
    const draw = (site) => h.fn('renderSitePlugins')({ sitePoolDir: '/p', site });
    const all = () => childrenOf(h.byId.get('site-plugins'));
    const words = () => all().map((x) => x._text || '').join('|');
    const allGood = { label: 'hfu@h.example.com:22', syncedAt: Date.now(),
      supported: true, versions: [{ version: '1.0.0', wantedBy: ['本站'] }],
      strays: [] };

    // ① 一切正常：整块不存在（这一条就是用户要的那件事）。
    draw(allGood);
    assert.deepEqual(all(), [], `一切正常时一个格子都不许画：${words()}`);

    // ② 出问题（快照表读不到）：说问题，不附带"一切正常"那几行。
    draw({ ...allGood, snapshotOk: false, versions: [] });
    assert.match(words(), /站点分发/, '要有标题 —— 否则读者不知道这句话说的是哪一块');
    assert.match(words(), /快照表读取失败/);
    assert.equal(/上次同步/.test(words()), false, '「一切正常」那几行不跟着回来');
    assert.equal(all().some((x) => x._text === '1.0.0'), false, '版本清单不画');
    assert.equal(all().some((x) => x.tagName === 'BUTTON'), false,
      '这一块里一颗按钮都没有 —— 「重新同步」在整屏底部，不在这一块里');

    // ③ 站点太新时那句"升级客户端"要说 —— 它是用户唯一能做的动作。
    draw({ ...allGood, reason: 'site_too_new', daemonVersionVerdict: 'cross_major' });
    assert.match(words(), /请升级这个客户端/);
  });

test('「重新同步」在整屏底部挨着「检查集群」：点它走那条对账 IPC，回来的视图当场画上去',
  async () => {
    // 用户 2026-10-18：站点上装了插件的新版本之后界面不主动刷新，而「重新同步」
    //   这颗按钮已经不在界面上了。站点的插件清单不在任何轮询里（30 秒那一拍问的
    //   是集群现状，不取插件），所以这一颗是"现在就去问"的唯一入口 —— 它要常驻，
    //   而且与「检查集群」同一行。文案在 panel.html 里，这里判的是绑定与结果。
    const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
      spaces: SPACES });
    h.run('window.__sync = 0; window.slurmate.syncPlugins = () => {'
      + '  window.__sync += 1; return Promise.resolve(window.__result); };');
    const btn = h.byId.get('btn-sync-plugins');
    assert.ok(btn && typeof btn.onclick === 'function',
      '底部那一行要有这颗按钮 —— bindEvents 绑的就是它');
    assert.ok(h.byId.get('btn-doctor'), '「检查集群」也在那一行里');

    // ① 成功：返回的视图当场画上去（不靠下一次推送）
    h.run(`window.__result = ${JSON.stringify({ ok: true, plugins: {
      ...PV, plugins: PV.plugins.map((p) => ({ ...p, version: '2.0.0' })),
    } })};`);
    await btn.onclick();
    assert.equal(h.run('window.__sync'), 1, '点一次就走那条 IPC');
    assert.match(childrenOf(h.byId.get('plugin-blocks')).map((x) => x._text || '').join('|'),
      /v2\.0\.0/, '回来的那份视图要当场画上去');

    // ② 没连上站点：主进程那句话原样说出来（界面不自己编一句）
    h.run('window.__result = { ok: false, error: "还没连上站点，插件是从站点取回来的。" };');
    await btn.onclick();
    const said = childrenOf(h.doc.getElementById('notices')).map((x) => x._text || '').join('\n');
    assert.match(said, /还没连上站点/, '失败要说清为什么');
  });

test('插件块把名额说到前面：满员时按钮灰着，结束一条就回来', () => {
  // 账本 S42：上限从前只在点下去之后由服务端拦（`4 quota_active`）。现在那一行
  //   说得出"这台电脑上已经有几个"，按钮一起灰掉。
  //   数只来自本机手里的会话（`pluginActiveCount`）—— 所以它只说「这台电脑上」，
  //   别的电脑上的会话它数不到，那种情况下按钮仍然亮着、由服务端拒。
  const h = start({ connections: [], workspaces: [], activeConnectionId: null });
  const PVQ = {
    ...PV,
    plugins: [{ ...PV.plugins[0], maxSessions: 2 }, { ...PV.plugins[1], maxSessions: 2 }],
  };
  h.run(`SESS = ${JSON.stringify({
    sessions: [
      { slot: 'a', live: true, snap: { servicePlugin: 'p1@1.0.0' } },
      { slot: 'b', live: true, snap: { servicePlugin: 'p1@1.0.0' } },
    ],
    front: 'a',
    panelFront: false,
  })};`);
  h.run(`renderPlugins(${JSON.stringify(PVQ)});`);

  const blocks = () => childrenOf(h.byId.get('plugin-blocks'))
    .filter((x) => x.className === 'plug' || x.className === 'plug plug-off');
  const blockOf = (title) => blocks().find((b) => childrenOf(b)
    .some((x) => x.tagName === 'H3' && x._text === title));
  const startBtn = (b) => childrenOf(b)
    .find((x) => x.tagName === 'BUTTON' && x._text === '开始会话');
  const metaText = (b) => childrenOf(b)
    .filter((x) => (x.className || '').startsWith('plug-meta'))
    .map((x) => childrenOf(x).map((y) => y._text).join('|'))
    .join('|');

  const p1 = blockOf('编辑器');
  assert.ok(p1, '前置：编辑器那一块画出来了');
  assert.equal(startBtn(p1).disabled, true,
    '这个插件上已经两个（上限 2）：按钮必须灰着，不能等点下去才被拒');
  assert.match(metaText(p1), /这台电脑上已经有 2 个（上限 2）/,
    `满员那一行要说出现在有几个：${metaText(p1)}`);
  assert.match(startBtn(p1).title || '', /到本站上限/,
    '灰着的时候要说出为什么');

  // 数按插件 id 归并：另一个插件上有会话不该把这一块也灰掉。
  const p2 = blockOf('中转站');
  assert.equal(startBtn(p2).disabled, false, '其他插件不跟着灰');
  assert.match(metaText(p2), /最多同时 2 个会话/,
    '没到上限的那一块只说上限，不报一个会过期的数');
  assert.equal(/这台电脑上已经有/.test(metaText(p2)), false);

  // 结束一条：`renderSessions` 会调 `syncPluginQuota`，就地改回来。
  h.run(`renderSessions({ sessions: [
    { slot: 'a', live: true, snap: { servicePlugin: 'p1@1.0.0' } }], front: 'a' });`);
  assert.equal(startBtn(blockOf('编辑器')).disabled, false,
    '结束一条之后按钮要回来 —— 那个数跟着会话表走');
  assert.match(metaText(blockOf('编辑器')), /最多同时 2 个会话/);
});

test('本机插件：没有作业侧但有 startLocal 时，按钮写「在本机打开」且可点', () => {
  // F52 ②：只有客户端一半的插件不再是死路。站点说 `can_submit: false`，
  //   而客户端看见 `startLocal` 时，界面给一个本机入口；没有钩子的仍然是灰的。
  const h = start({ connections: [], workspaces: [], activeConnectionId: null });
  const PL = {
    ...PV,
    plugins: [
      { id: 'p3', name: 'local-demo', title: '本机样例', version: '1.0.0',
        description: '', ports: 1, group: 'local-demo', runnable: true,
        hasClientCode: true, siteEnabled: true, siteKnown: true, locallyEnabled: true,
        canSubmit: false, hasLocalEntry: true, defaults: { cpus: 1, mem: '1G' }, maxSessions: 2 },
      { id: 'p4', name: 'half', title: '只有一半', version: '1.0.0',
        description: '', ports: 0, group: null, runnable: false,
        hasClientCode: true, siteEnabled: true, siteKnown: true, locallyEnabled: true,
        canSubmit: false, hasLocalEntry: false, defaults: { cpus: 1, mem: '1G' } },
    ],
  };
  h.run(`renderPlugins(${JSON.stringify(PL)});`);
  const blocks = () => childrenOf(h.byId.get('plugin-blocks'))
    .filter((x) => x.className === 'plug' || x.className === 'plug plug-off');
  const blockOf = (title) => blocks().find((b) => childrenOf(b)
    .some((x) => x.tagName === 'H3' && x._text === title));
  const btnOf = (b) => childrenOf(b)
    .find((x) => x.tagName === 'BUTTON'
      && (x._text === '在本机打开' || x._text === '开始会话'));

  const local = blockOf('本机样例');
  assert.ok(local, '前置：本机插件那一块画出来了');
  assert.equal(btnOf(local)._text, '在本机打开');
  assert.equal(btnOf(local).disabled, false, '有本机入口就可点');
  assert.match(childrenOf(local).find((x) => x.className === 'why')._text,
    /只在本机运行/);
  assert.equal(childrenOf(local).some((x) => x.tagName === 'DETAILS'), false,
    '本机插件不画作业的高级选项');
  assert.equal(/最多同时/.test(childrenOf(local).map((x) => x._text || '').join('|')),
    false, '本机插件不占站点名额');

  const half = blockOf('只有一半');
  assert.ok(half);
  assert.equal(btnOf(half)._text, '开始会话', '没有本机入口时仍是作业那颗按钮');
  assert.equal(btnOf(half).disabled, true, '它无法启动');
  assert.match(childrenOf(half).find((x) => x.className === 'why')._text,
    /没有提供本机入口/);
});

test('S34：会话标签与「剩余时间」的说明真的长在界面上', () => {
  const h = start({ connections: [], workspaces: [], activeConnectionId: null });
  // ① 会话标签：输入法失效时的恢复动作
  h.run("SCREEN = 'plugins';");
  h.run('SESS = { sessions: [{ slot: "a", service: "编辑器", live: true,'
    + ' snap: { state: "running" } }], front: "a" };');
  h.fn('renderTabs')();
  // 「面板」排第一（固定的回程），会话标签跟在它后面。
  const tab = h.byId.get('session-tabs').children[1];
  assert.equal(tab.textContent, '编辑器');
  assert.match(tab.title || '', /输入法无效时先点击编辑区/);

  // ② 「剩余时间」为「未知」时的说明
  h.run(`renderKv(${JSON.stringify({
    state: 'running', sessionId: 's1', jobId: '42', partition: 'A6000',
    node: 'n1', tunnelTarget: '192.0.2.1:55001', localPort: 18090,
    resources: { cpus: 1, mem: '1G' }, expiresAt: undefined,
    jobText: '运行中', suspended: null, hbAgeMs: 100, tunnelState: 'listening',
  })});`);
  const kv = childrenOf(h.byId.get('kv'));
  const i = kv.findIndex((x) => x.tagName === 'DT' && x._text === '剩余时间');
  assert.ok(i >= 0, '前提：剩余时间那一行在');
  assert.match(kv[i + 1].title || '', /站点本次未提供剩余时间；「未知」不代表已到期/);
});

test('「检查集群」把守护进程的版本、对账时间与"还没有登记上"一起说出来', async () => {
  // 用户 2026-10-19 第二次真机：「检查通过：0 条 ACL 规则，0 个活跃会话」，
  //   而眼前正卡着一条作业在跑的会话。体检要说得出这两件事：站点上是哪一版、
  //   有没有会话停在"已提交、还没有登记上"那一段；对账抛了异常要算问题。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  const btn = h.byId.get('btn-doctor');
  const said = () => childrenOf(h.doc.getElementById('notices'))
    .map((x) => x._text || '').join('\n');
  const answer = (data) => h.run(`window.__doctor = ${JSON.stringify(data)};`
    + 'window.slurmate.doctor = () => Promise.resolve({ ok: true, data: window.__doctor });');

  answer({ socket: true, table: true, rules_readable: true, rules_count: 0,
    active_sessions: 0, pending_sessions: 1, consistent: true,
    existing: { codeserver_table: true, portdaemon_table: true },
    version: '0.32', tick_age_seconds: 2, last_tick_error: null,
    checked: 12, problems: [], auth_mode_none: 0 });
  await btn.onclick();
  // 「检查了 N 项」是这一屏上唯一能把"检查跑了、没有发现"与"检查没跑"
  //   分开的东西 —— 少了它，一个什么都不做的 doctor 与一个健康的 doctor
  //   在界面上逐字相同。
  assert.match(said(), /检查了 12 项/, said());
  assert.match(said(), /0 条 ACL 规则/, said());
  assert.match(said(), /1 个还没有登记上/, said());
  assert.match(said(), /守护进程 0\.32/, said());
  assert.match(said(), /上一次对账在 2 秒前/, said());

  answer({ socket: true, table: true, rules_readable: true, rules_count: 0,
    active_sessions: 0, pending_sessions: 1, consistent: true,
    existing: { codeserver_table: true, portdaemon_table: true },
    version: '0.32', tick_age_seconds: 2, last_tick_error: null,
    checked: 12, problems: [], auth_mode_none: 2 });
  await btn.onclick();
  assert.match(said(), /2 条关闭了口令/, said());

  // 判定在守护进程那一侧，界面只把 `problems` 说出来 —— 它不再自己重算
  //   一遍（同一条规矩两份实现，漂开的那天界面说"通过"而服务端说"有问题"）。
  answer({ socket: true, table: true, rules_readable: true, rules_count: 0,
    active_sessions: 0, pending_sessions: 1, consistent: true,
    existing: { codeserver_table: true, portdaemon_table: true },
    version: '0.32', tick_age_seconds: 2,
    checked: 12, auth_mode_none: 0,
    problems: [{ key: 'tick_error',
      detail: '最近一次对账出错：IntegrityError: UNIQUE constraint failed' }] });
  await btn.onclick();
  assert.match(said(), /检查发现问题/, said());
  assert.match(said(), /IntegrityError/, said());

  // 没有 `problems` 的是旧守护进程。此时不能拿"没报问题"当"没有问题"——
  //   那正好是这一版要消灭的那种假绿。
  answer({ socket: true, table: true, rules_readable: true, rules_count: 0,
    active_sessions: 0, pending_sessions: 0, consistent: true,
    existing: { codeserver_table: true, portdaemon_table: true },
    version: '0.32', tick_age_seconds: 2, last_tick_error: null });
  await btn.onclick();
  assert.match(said(), /版本过低/, said());
});

test('状态条右侧那两颗：只在会话页面盖着时露，写的是「停止该作业」', async () => {
  // 用户 2026-10-18 定的形状：web-demo 那类作业页面上给一颗「停止该作业」——
  //   快速结束眼前这一条的机会；插件页与作业页都不给（前者没有页面可重载、
  //   也没有作业可停，后者自己那一屏上就有大按钮）。「结束会话」这个名字不再出现。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'window.__stops = []; window.slurmate.stop = (slot) => {'
    + '  window.__stops.push(slot); return Promise.resolve({ ok: true }); };'
    + 'window.slurmate.jobs = () => Promise.resolve({ ok: true, jobs: [], at: 1 });');
  h.run("document.body.append($('sb-end')); document.body.append($('sb-reload'));");
  const btn = h.byId.get('sb-end');
  const reload = h.byId.get('sb-reload');
  // `hasSurface` 认的是插件清单里的 `surface`（与「重新加载」同一份判据）。
  h.run("lastPlugins = { plugins: [{ name: 'web-demo', surface: { kind: 'web', path: '/' } }] };");
  const snap = { state: 'running', slot: 's1', sessionId: 'sess-a', jobId: '11',
                 serviceKind: 'web-demo' };

  // ── 会话页面盖着：两颗都在，「停止该作业」 ──
  h.run("SCREEN = 'plugins'; SESS = { sessions: [{ slot: 's1', live: true }],"
    + " front: 's1', panelFront: false };");
  h.fn('renderSnapshot')(snap);
  assert.equal(btn._text, '停止该作业');
  assert.equal(btn.classList.contains('hidden'), false);
  assert.equal(reload.classList.contains('hidden'), false, '页面盖着时「重新加载」要在');

  // 第二段停的是眼前这一条（前台 s1）
  btn.onclick();
  const cluster = (() => {
    const p = btn.parentNode;
    return p.children[p.children.indexOf(btn) + 1];
  })();
  assert.match(cluster.children[0]._text, /作业会被取消/);
  assert.equal(cluster.children[1]._text, '停止');
  await cluster.children[1].onclick();
  assert.equal(JSON.stringify(h.run('window.__stops')), '["s1"]',
    `停的是眼前的这一条：${JSON.stringify(h.run('window.__stops'))}`);

  // ── 面板抬起来：两颗都不在 ──
  h.run('SESS.panelFront = true;');
  h.fn('renderSnapshot')(snap);
  assert.equal(btn.classList.contains('hidden'), true, '插件页上不该有会话动作');
  assert.equal(reload.classList.contains('hidden'), true, '插件页上不该有「重新加载」');

  // ── 排队中：还没有页面，面板就是眼前的这一块 —— 同样不在 ──
  h.run('SESS.panelFront = false;');
  h.fn('renderSnapshot')({ ...snap, state: 'queued' });
  assert.equal(btn.classList.contains('hidden'), true,
    '排队中还没有页面，用户看着的是面板');
  assert.equal(reload.classList.contains('hidden'), true);

  // ── 作业那一屏：它自己那一屏上就有大按钮，状态条这一颗不露 ──
  const rows = [
    { session_id: 'sess-a', slot: 's1', live: true, attached: true, job_id: '11' },
    { session_id: 'sess-b', slot: 's2', live: true, attached: true, job_id: '22' },
  ];
  h.run(`SCREEN = 'jobs'; SESS.panelFront = true; JOBS = ${JSON.stringify({
    list: rows, at: 1, error: null, selected: 'sess-b',
  })};`);
  h.fn('renderJobsSelection')();
  assert.equal(btn.classList.contains('hidden'), true,
    '作业页有自己的大按钮，状态条这一颗不再露');
  assert.equal(reload.classList.contains('hidden'), true);
});

test('状态条上的「临时离开」：页面盖着时露，两段式，第二段才走', async () => {
  // 2026-10-25 用户：那块页面上只有「重新加载」与「停止该作业」，回面板的路
  //   只写在标签「面板」的 title 里 —— 要先知道去点它。这一颗把那条路摆出来。
  //   它与「重新加载」同一种配色（ghost）：它不结束作业，只是本机走开。
  //   两段式（`armConfirm`）：它会停心跳，没人回来接着看的后果要说出来。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'window.__leaves = 0; window.slurmate.leave = () => {'
    + ' window.__leaves += 1; return Promise.resolve({ ok: true }); };'
    + 'window.slurmate.jobs = () => Promise.resolve({ ok: true, jobs: [], at: 1 });');
  h.run("document.body.append($('sb-leave'));");
  const leave = h.byId.get('sb-leave');
  h.run("lastPlugins = { plugins: [{ name: 'web-demo', surface: { kind: 'web', path: '/' } }] };");
  const snap = { state: 'running', slot: 's1', sessionId: 'sess-a', jobId: '11',
                 serviceKind: 'web-demo' };

  // ── 页面盖着：它在 ──
  h.run("SCREEN = 'plugins'; SESS = { sessions: [{ slot: 's1', live: true }],"
    + " front: 's1', panelFront: false };");
  h.fn('renderSnapshot')(snap);
  assert.equal(leave.classList.contains('hidden'), false,
    '页面盖着时它是回面板的那条路');
  // 它的配色与 title 长在 panel.html 上（这一组的壳不解析 HTML），
  //   那两条由 renderer.test.mjs 对着文件判。

  // ── 第一段 ──
  leave.onclick();
  assert.equal(h.run('window.__leaves'), 0, '第一次不许走 —— 它是第一段');
  const cluster = (() => {
    const p = leave.parentNode;
    return p.children[p.children.indexOf(leave) + 1];
  })();
  assert.equal(cluster.className, 'armed');
  assert.match(cluster.children[0]._text, /35 分钟/, '后果要说出来');
  assert.match(cluster.children[0]._text, /作业继续在集群上跑/);

  // ── 第二段 ──
  await cluster.children[1].onclick();
  assert.equal(h.run('window.__leaves'), 1, '第二段才真的走，而且恰好一次');

  // ── 面板抬上来：它不在（那时面板本来就看得见）──
  h.run("SESS.panelFront = true; SESS.sessions = [{ slot: 's1', live: true }];");
  h.fn('renderSnapshot')(snap);
  assert.equal(leave.classList.contains('hidden'), true);
});

test('排队中：状态条说得出作业在跑、以及站点那边为什么还没有登记', () => {
  // 用户 2026-10-19 真机：作业正常运行、日志照常输出，界面上只有「排队中」。
  //   作业状态（`jobText`）与守护进程给的原因（`enrollProblem`）都要露出来 ——
  //   否则用户无从判断是在等资源、还是卡在登记这一步。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.run("SCREEN = 'plugins'; SESS = { sessions: [], front: null, panelFront: true };");
  h.fn('renderSnapshot')({
    state: 'queued', jobId: '11', jobState: 'RUNNING', jobTerminal: false,
    jobText: '运行中', enrollProblem: 'mode_too_open', resources: {}, gresText: null,
  });
  const detail = h.byId.get('sb-detail')._text || '';
  assert.match(detail, /作业 11/, `作业号要在：${detail}`);
  assert.match(detail, /运行中/, '作业那一侧的真实状态要说出来');
  assert.match(detail, /站点还没有完成登记：mode_too_open/, detail);

  // 原因那一格缺席（老站点不发），而作业已经在跑：这一句仍然要说。
  //   判据在客户端这一侧：作业状态是站点给的，两边都答得上来。
  h.fn('renderSnapshot')({
    state: 'queued', jobId: '11', jobState: 'RUNNING', jobTerminal: false,
    jobText: '运行中', resources: {}, gresText: null,
  });
  assert.match(h.byId.get('sb-detail')._text || '', /站点还没有完成登记/);

  // 作业还没开始跑：不说这句 —— 那时"排队中"就是全部的事实。
  h.fn('renderSnapshot')({
    state: 'queued', jobId: '11', jobState: 'PENDING', jobTerminal: false,
    jobText: '排队中 · 在等空闲资源', resources: {}, gresText: null,
  });
  assert.equal(/站点还没有完成登记/.test(h.byId.get('sb-detail')._text || ''), false);
});

test('作业那一屏开着时，活会话的集合一变就重取一次列表', () => {
  // 用户 2026-10-18：排队中的作业不在作业那一屏上。提交返回之前那一屏是空的，
  //   而它不跟着状态推送更新 —— 于是一个刚排队起来的作业要等到手动「刷新」
  //   才出现。判据是活会话的集合变没变，不是每一份推送都问一次。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'window.__jobsCalls = 0; window.slurmate.jobs = () => {'
    + '  window.__jobsCalls += 1; return Promise.resolve({ ok: true, jobs: [], at: 1 }); };'
    // 重取列表那一趟还会重取本机的会话视图（见 `refreshJobs`）：真机上那是主进程
    //   手上的权威一份，这里给一份同形状的空表。
    + 'window.slurmate.states = () =>'
    + ' Promise.resolve({ sessions: [], front: null, panelFront: true });');
  h.run("SCREEN = 'jobs';");
  h.fn('renderSessions')({ sessions: [], front: null });
  const after = h.run('window.__jobsCalls');
  assert.ok(after >= 1, '进作业屏第一次要问一次');

  h.fn('renderSessions')({ sessions: [], front: null });
  assert.equal(h.run('window.__jobsCalls'), after, '集合没变就不许再问');

  // 提交了一条（还在排队、本机接着它）→ 当场重取
  h.fn('renderSessions')({
    sessions: [{ slot: 's9', live: true, service: '编辑器', snap: null }], front: 's9',
  });
  assert.equal(h.run('window.__jobsCalls'), after + 1,
    '新出现一条会话，作业列表要重取 —— 排队中的那一条就是这样出现的');
});

test('插件那一块上的删除：删掉本机那一份走两段式，第一次点不发请求',
  async () => {
    // 删掉本机那一份（§5.3，撤回同意）是这块上唯一的删除动作 —— 站点那一侧的
    //   撤是管理员的事，客户端这一侧没有那条路（0.27 删掉了假站点之后，
    //   连测试界面上的入口也不在了）。
    const h = bindAll({ connections: [], workspaces: [], activeConnectionId: null });
    h.run('window.__drop = []; window.__result = { ok: true };'
      + 'window.slurmate.dropPluginVersion = (id, version) => {'
      + '  window.__drop.push([id, version]); return Promise.resolve(window.__result); };');

    // 一块最简的插件（字段照 `pluginsView()` 给的那一份，一个不少）——
    //   `ports: 0` 不画"用哪一份数据"那一格，`runnable: false` 不画高级选项。
    const P = { id: '01M2JKM1M1M1M1M1M1M1M1M1M7', version: '1.0.0', name: 'demo-box',
      title: '示例盒子', description: '', hasClientCode: true,
      surface: { kind: 'web', path: '/' }, ports: 0, group: null,
      siteVersion: '1.0.0', siteEnabled: true, siteKnown: true, locallyEnabled: true,
      canSubmit: true, defaults: { cpus: 2, mem: '8G', time: '12:00:00' },
      defaultsGresText: null, runnable: false };

    const lastRow = (root) => childrenOf(root).filter((x) => x.className === 'plug-actions').pop();
    const btn = (root, text) => childrenOf(lastRow(root))
      .find((x) => x.tagName === 'BUTTON' && x._text === text);
    const armedIn = (root) => childrenOf(lastRow(root)).find((x) => x.className === 'armed');
    const d = h.fn('pluginBlock')(P);

    assert.ok(btn(d, '删掉本机这一份'), '这里必须能删掉本机那一份');
    assert.equal(btn(d, '从站点撤掉'), undefined,
      '站点那一侧的撤不该出现在界面上 —— 它是管理员的事');

    // 两段式：第一次点只摆出确认，一个请求都不发。
    await btn(d, '删掉本机这一份').onclick();
    assert.equal(h.run('window.__drop.length'), 0, '第一次点不许发请求');
    assert.ok(armedIn(d), '第一次点要摆出那一行确认');
    assert.match(childrenOf(armedIn(d)).map((x) => x._text || '').join(''),
      /站点上那一份不受影响/, '确认那一行要说清站点那一边不受影响');
    await childrenOf(armedIn(d))
      .find((x) => x.tagName === 'BUTTON' && x._text === '删掉').onclick();
    assert.equal(h.run('JSON.stringify(window.__drop)'),
      JSON.stringify([[P.id, P.version]]), '第二点要带着 id 与版本走 `dropPluginVersion`');

    // 「取消」回到原样，什么都不发。
    await btn(d, '删掉本机这一份').onclick();
    childrenOf(armedIn(d)).find((x) => x.tagName === 'BUTTON' && x._text === '取消').onclick();
    assert.equal(h.run('window.__drop.length'), 1, '取消不发请求');
    assert.equal(armedIn(d), undefined, '取消之后那一行要收掉');
    assert.ok(btn(d, '删掉本机这一份'), '原来那颗按钮要回来');
  });

test('「端口被占」那一行是三选一：三颗都当场生效，而且它不是失败', async () => {
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES },
  'window.__starts = [];'
  + 'window.__reply = { ok: false, code: "port_conflict",'
  + '  port: { want: 18080, spaceId: "s000000000001" }, sessions: [], front: null,'
  + '  error: "首选端口 18080 被其他程序占用（它是这份数据在浏览器里的地址）。" };'
  + 'window.slurmate.start = (res, kind, choice) => {'
  + '  window.__starts.push([kind, choice]); return Promise.resolve(window.__reply); };'
  + 'window.slurmate.partitions = () => Promise.resolve({ ok: true, plugins: null });');

  const row = h.doc.getElementById('sb-port');
  const notices = () => childrenOf(h.doc.getElementById('notices'));
  const sent = (i) => h.run(`JSON.stringify(window.__starts[${i}])`);
  const btn = h.doc.getElementById('start-btn');
  // 那几格高级选项现在是每一块自己一份（`startWith` 读的就是它）——
  //   这里现造一份用：它在真机上是 pluginBlock 画出来的那一份。
  const adv = h.fn('pluginAdv')().st;

  // 开局没有待答的一问。不在这一层判"那一行是收着的" —— 这个架子不解析
  //   `panel.html`，`#sb-port` 身上那个 `hidden` 类是 HTML 写的，在这里根本看不见。
  //   那一半由 `renderer.test.mjs` 从源码文本上钉（id 在不在、三颗按钮叫什么）。
  assert.equal(h.run('portAsk'), null, '开局不该有待答的一问');

  // ── ① 被挡下，摆出那一行，理由照念主进程给的那句 ──
  await h.fn('startWith')('cs', adv, btn);
  assert.equal(h.run('window.__starts.length'), 1);
  assert.equal(sent(0), '["cs",null]',
    '第一趟不带作答 —— 要不要问是主进程按后端与那一份数据判的，界面不猜');
  assert.equal(row.classList.contains('hidden'), false, '被挡下时那一行要摆出来');
  assert.match(h.doc.getElementById('sb-port-why')._text, /18080/, '理由里要念出那个端口');
  assert.match(h.doc.getElementById('sb-port-why')._text, /被其他程序占用/,
    '那句话由主进程给（端口是主进程的事实），界面照念，不自己编一句');
  // 三颗按钮各自说清代价 —— 这是"把警告变成动作的前置状态"，不是装饰。
  assert.match(h.doc.getElementById('sb-port-shift').title || '', /布局/,
    '「启动」要说清它的代价（origin 变了，编辑器布局会重置）');
  assert.match(h.doc.getElementById('sb-port-shift').title || '', /回到/,
    '还要说清它是暂时的：端口没有被改掉，下次启动会回到原处');
  // 中间那一颗是这一行上唯一会改配置的一颗，所以它的话必须说清"不可逆"
  //    （原来那个端口与它上面那份布局都回不来）—— 只写"记住"是不够的。
  assert.match(h.doc.getElementById('sb-port-remember').title || '', /不可逆/,
    '「记住并启动」要说清它不可逆 —— 那是它与「启动」唯一的分界');
  assert.match(h.doc.getElementById('sb-port-remember').title || '', /18080/,
    '还要念出原来那个端口：用户就是拿它对照着决定要不要改');
  assert.match(h.doc.getElementById('sb-port-abort').title || '', /不会出现作业/,
    '「取消」要说清它真的什么都没做');
  // 而它不是失败：这一支不该去刷新插件清单（那是"提交被拒"才有的事）。
  assert.equal(h.run('window.__starts.length'), 1, '只走了一趟 IPC，没有其他条目跟着发');

  // ── ② 答「启动」，带 `'shift'` 重发一次，而且重发的还是同一个插件 ──
  await h.doc.getElementById('sb-port-shift').onclick();
  assert.equal(h.run('window.__starts.length'), 2, '应答一次正好重发一次');
  assert.equal(sent(1), '["cs","shift"]',
    '那个作答是用户的意思：主进程据此顺移，不再问第二遍');

  // ── ②b 答「记住并启动」，带 `'remember'` 重发，而它仍然只发一趟 ──
  //    两个作答走的是同一条重发路（`startWith`），分别只在那个字符串上：
  //      界面这一层不做任何"要不要写配置"的判断 —— 写配置那一步在主进程里，而且
  //      排在绑定成功之后（它才知道隧道真绑上了哪个端口）。
  await h.doc.getElementById('sb-port-remember').onclick();
  assert.equal(h.run('window.__starts.length'), 3, '答「记住…」同样只重发一次');
  assert.equal(sent(2), '["cs","remember"]',
    '那个作答要说清是哪一种：主进程据此把新端口记进配置，而这是不可逆的一步');

  // ── ③ 这一趟成了，那一行收掉 ──
  h.run('window.__reply = { ok: true, slot: 1, sessions: [], front: null };');
  await h.doc.getElementById('sb-port-shift').onclick();
  assert.equal(row.classList.contains('hidden'), true, '成了就不该再挂着那一行');

  // ── ④ 答「取消」，就地收掉，一个字节都不发，而且说一句实话 ──
  h.run('window.__reply = { ok: false, code: "port_conflict",'
    + '  port: { want: 18080, spaceId: "s000000000001" }, sessions: [], front: null,'
    + '  error: "首选端口 18080 被其他程序占用（它是这份数据在浏览器里的地址）。" };');
  await h.fn('startWith')('cs', adv, btn);
  assert.equal(row.classList.contains('hidden'), false, '前提：这一趟又被挡下了');
  const calls = h.run('window.__starts.length');
  const before = notices().length;
  await h.doc.getElementById('sb-port-abort').onclick();
  assert.equal(h.run('window.__starts.length'), calls,
    '「取消」不跟主进程说话 —— 因为此刻本来就没有要撤的动作');
  assert.equal(row.classList.contains('hidden'), true, '那一行要收掉');
  // 提示流是 prepend（新的在最前），所以"这一下新出来的"是开头那几条 ——
  //   取尾巴会把上一次那一句当成这一次说的。
  const said = notices().slice(0, notices().length - before)
    .flatMap((x) => childrenOf(x)).map((x) => x._text || '').join('\n');
  assert.match(said, /没有提交/,
    '用户刚点过「开始会话」而界面静了下来，要说清那是"没起来"而不是"起来了"');

  // ── ⑤ 别的失败不摆这一行（它不是"被端口挡住"，三个答案都不成立）──
  h.run('window.__reply = { ok: false, code: "rejected", error: "版本不一致。" };');
  await h.fn('startWith')('cs', adv, btn);
  assert.equal(row.classList.contains('hidden'), true,
    '只有 `port_conflict` 才摆这一行 —— 其他失败摆它等于给两个不成立的答案');

  // ── ⑥ 走开（换屏 / 连上 / 断开都走这条路），那一行收掉 ──
  h.run('window.__reply = { ok: false, code: "port_conflict",'
    + '  port: { want: 18080, spaceId: "s000000000001" }, sessions: [], front: null,'
    + '  error: "首选端口 18080 被其他程序占用（它是这份数据在浏览器里的地址）。" };');
  await h.fn('startWith')('cs', adv, btn);
  assert.equal(row.classList.contains('hidden'), false, '前提：这一趟又被挡下了');
  h.fn('showScreen')('conns');
  assert.equal(row.classList.contains('hidden'), true,
    '走到其他屏去了，那一问就该收掉 —— 它问的是当前这条连接的那些数据的端口，'
    + '把一个问题留着等答，而它描述的那一条可能已经不是他现在看的这一条了');
});

test('同意那一段的安全警告压到两行以内（它曾经是三句）', () => {
  // 这是这一版唯一的安全边界（进程隔离还没做），所以它留着；但它原来是
  //   三句 —— 第三句讲的是"不同意会怎样"，而那件事那颗按钮自己的措辞已经说了
  //   （「不同意，删掉本机这一份」）。按钮能说清的事不必再写一句在旁边。
  //
  //   判据用句数而不是字数：字数会随措辞漂，而"两行以内"约束的正是句子数。
  const h = start({ connections: [], workspaces: [], activeConnectionId: null });
  h.fn('renderConsent')({ consent: [{
    id: 'p1', name: 'p1', title: '编辑器', version: '1.0.0', fileCount: 3,
    existing: false, siteLabel: '本站', digest: 'abcdef0123456789', digestAlg: 1,
    previous: null, fingerprint: null,
  }] });
  const warn = childrenOf(h.byId.get('plugin-consent'))
    .find((x) => /^同意之后/.test(x._text || ''));
  assert.ok(warn, '同意那一块里未找到那句警告了 —— 它是用户做决定时缺不得的一条信息');
  assert.match(warn._text, /没有进程隔离/, '必须说清"目前没有进程隔离"');
  assert.match(warn._text, /在这台机器上运行/, '必须说清客户端代码会在本机运行');
  assert.equal((warn._text.match(/。/g) || []).length, 2,
    `这一句应当是两句：现在 ${JSON.stringify(warn._text)}　——`
    + '第三句讲"不同意会怎样"，而那件事按钮自己会说了');
});

test('映射图：三列两段线 —— 连接 / 工作区 / 数据', () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES });
  h.fn('renderConnections')(CONNS);

  assert.equal(h.byId.get('wmap-conns').children.length, 2, '左列两条连接');
  assert.equal(h.byId.get('wmap-workspaces').children.length, 2, '中列两个工作区');
  assert.equal(h.byId.get('wmap-spaces').children.length, 2, '右列两份数据');
  // 数据那一列说的是"这一份是谁的、有几个工作区指着它"——端口就是它的对外身份
  const sp0 = h.byId.get('wmap-spaces').children[0];
  assert.match(sp0.children[0].textContent, /18080/);
  assert.match(sp0.children[1].textContent, /1 个工作区/);

  // renderWorkspaceMap 结尾是 requestAnimationFrame(drawWorkspaceLines)，而架子里的
  // rAF 是立刻执行的 —— 所以矩形非零时线就该已经画好了。
  // 两段线各两条：连接→工作区、工作区→数据。少了第二段的话，图上"哪个工作区
  //   指着哪一份"就只剩一列孤零零的方框，而这张图存在的理由正是那一段。
  const lines = h.byId.get('wmap-lines').children;
  assert.equal(lines.length, 4, '两段关系各两条线');
  assert.match(lines[0].attrs.d, /^M [\d.]+ [\d.]+ C /, '线是三次贝塞尔');
  assert.equal(lines[0].attrs.class, 'edge cur', '正连着的那条要高亮');
  assert.equal(lines[1].attrs.class, 'edge');
  for (const l of lines.slice(2)) assert.equal(l.attrs.class, 'edge', '数据那一段不高亮');
});

test('同一份数据被两个工作区指着，两条线汇到同一个节点', () => {
  // 这就是这张图存在的全部理由：在下拉框里，"我和 2 号工作区共用同一份登录
  //   状态"这件事一个字都看不出来。
  const shared = [
    WSS[0],
    { ...WSS[1], refs: { p1: 's000000000001' }, spaces: ['s000000000001'] },
  ];
  const h = start({ connections: CONNS, workspaces: shared, activeConnectionId: 'c1',
    spaces: [SPACES[0]] });
  h.fn('renderConnections')(CONNS);
  assert.equal(h.byId.get('wmap-spaces').children.length, 1, '只有一份数据');
  assert.match(h.byId.get('wmap-spaces').children[0].children[1].textContent, /2 个工作区/);
  const lines = h.byId.get('wmap-lines').children;
  // 2 条（连接→工作区）+ 2 条（两个工作区都指向同一份）—— 它们是同一个终点：
  // 那正是"共用"在图上长的样子。
  assert.equal(lines.length, 4);
  assert.equal(lines[2].attrs.d.split('C')[1], lines[3].attrs.d.split('C')[1],
    '两条线的终点必须重合（同一份数据）');
});

test('连接进行中要说一声：按钮灰着写「连接中…」，出结果才还原', async () => {
  // 2026-10-16 用户报的第 7 条："点「连接」之后没有任何提示，于是会重复点"。
  // 一次连接可能要几十秒（主进程那边 `READY_TIMEOUT_MS` 是 20 秒），而从前那一段
  //   时间里界面一个字都不说。这里用一个由用例控制的 promise 把它卡在中间 ——
  //   只有卡住了才看得到那个状态。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    // 每次要一个"闸"，用例握着它的把手。两条入口各要一个：同一个 promise 只能
    //   resolve 一次，共用一个的话第二次就卡不住了。
    'window.__gate = () => { let release;'
    + ' const p = new Promise((r) => { release = r; });'
    + ' window.__release = release; return p; };'
    + 'window.slurmate.setActiveConnection = () => Promise.resolve({ ok: true });'
    + 'window.slurmate.connect = () => window.__gate().then(() => ({'
    + " ok: false, error: '假装连不上' }));"
    // 存这一趟不卡：它是本地的一次 IPC，而这一条判据管的是"连的那几秒"。
    + 'window.slurmate.saveConnection = () => Promise.resolve({'
    + ' ok: true, created: true, connections: boot.connections,'
    + ' workspaces: boot.workspaces, connection:'
    + " { id: 'c9', user: 'carol', host: '198.51.100.11', port: 10100 } });");
  const flush = () => new Promise((r) => setTimeout(r, 0));
  // 最新的那条在最前（`notice` 是 `prepend`），正文是第二个孩子。
  const said = () => h.byId.get('notices').children
    .map((x) => (x.children[1] || {}).textContent || '').join('\n');
  // 列表整块会被重画，所以每一问都要重新取一次那一行上的按钮，不能攥着旧的 ——
  //   攥着旧的话，下面那两条"还原了没有"判的是一颗已经不在屏幕上的按钮。
  const rowBtn = () => childrenOf(h.byId.get('conn-list').children[0])
    .find((x) => x.tagName === 'BUTTON');

  // ── 入口一：列表行上那颗「连接」 ──
  h.fn('renderConnections')(CONNS);
  assert.equal(rowBtn().textContent, '连接', '平时它写着「连接」');
  const pending = rowBtn().onclick();
  await flush();
  assert.equal(rowBtn().disabled, true,
    '连的这几秒里那颗按钮要灰着 —— 不灰，用户会再点一次');
  assert.equal(rowBtn().textContent, '连接中…', '而它要写着「连接中…」');
  assert.ok(said().includes('正在连接 alice@198.51.100.7…'),
    '日志里要说清正在连哪一台，实际写着：' + said());
  h.run('window.__release()');
  await pending;
  assert.equal(rowBtn().disabled, false, '出结果之后要还原');
  assert.equal(rowBtn().textContent, '连接', '连同那句话一起还原');

  // ── 入口二：表单里那颗「保存并连接」 ──
  // 表单里的几格是手写的：真机上它们由 openNewForm 填，而那一趟会顺手生成一把
  //   密钥 —— 那与这条判据无关，在这里补桩只是把这条用例弄脆。
  h.run('form = { open: true, mode: "new", id: null };'
    + '$("btn-save").textContent = "保存并连接";'
    + '$("f-user").value = "carol"; $("f-host").value = "198.51.100.11";'
    + '$("f-port").value = "10100"; $("f-workspace").value = "";');
  const save = h.byId.get('btn-save');
  const pending2 = save.onclick();
  await flush();
  assert.equal(save.disabled, true, '表单那一颗也要灰着');
  assert.equal(save.textContent, '连接中…');
  assert.ok(said().includes('正在连接 carol@198.51.100.11…'),
    '日志里说的是这一条，实际写着：' + said());
  h.run('window.__release()');
  await pending2;
  assert.equal(save.disabled, false);
  assert.equal(save.textContent, '保存并连接',
    '还原成它原来那句话 —— 写成「连接」，用户会以为这颗按钮换了意思');
});

test('保存连接之后，界面手里的工作区表跟着回包换', async () => {
  // 只换 `connections` 的话，映射图与下一次打开的表单读的仍是启动时那一份：
  //   用户看到一张缺了中间一列的图（2026-10-20 报的"首页的工作区都不显示"）。
  const NEW_WS = { id: 'w000000000009', name: '工作区 9', refCount: 1,
    members: ['c9'], soleOwnerId: 'c9', refs: {}, spaces: [] };
  const NEW_CONN = { id: 'c9', user: 'carol', host: '198.51.100.11', port: 10100,
    workspaceId: NEW_WS.id };
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'window.slurmate.saveConnection = () => Promise.resolve({'
    + ' ok: true, created: true, connection: ' + JSON.stringify(NEW_CONN) + ','
    + ' connections: boot.connections.concat([' + JSON.stringify(NEW_CONN) + ']),'
    + ' workspaces: boot.workspaces.concat([' + JSON.stringify(NEW_WS) + ']) });'
    + 'window.slurmate.setActiveConnection = () => Promise.resolve({ ok: true });'
    + 'window.slurmate.connect = () => Promise.resolve('
    + '{ ok: false, error: "假装连不上" });');
  h.run('form = { open: true, mode: "new", id: null };'
    + '$("f-user").value = "carol"; $("f-host").value = "198.51.100.11";'
    + '$("f-port").value = "10100"; $("f-workspace").value = "";');
  await h.byId.get('btn-save').onclick();
  assert.equal(h.byId.get('wmap-workspaces').children.length, WSS.length + 1,
    '保存之后映射图要用回包里那份工作区表 —— 少了它，首页的工作区那一列是空的');
});

test('连接表单里的「③ 工作区」：三种取值各有各的那一句后果', () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });

  // ── 新建：初值跟随默认 ──
  h.run('form = { open: true, mode: "new", id: null }; wsPicked = ""; wsDefault = null;');
  h.fn('renderFormWorkspace')();
  const sel = h.byId.get('f-workspace');
  const opts = sel.children;
  assert.equal(opts[0].value, '', '第一项是"跟随默认"');
  assert.equal(opts[0].textContent, '默认：新建一个空白工作区', '默认是"新建"时要说出来');
  assert.equal(opts[opts.length - 1].value, '__new__', '最后一项是"＋ 新建空白工作区…"');
  assert.equal(opts.length, 2 + WSS.length, '默认 + 两个工作区 + 新建');
  assert.equal(sel.value, '', '初值选中"跟随默认"');
  assert.match(h.byId.get('ws-hint').textContent, /会新建一个空白工作区/);

  // 默认值一变（用户敲了地址），那一项的标签要跟着变 —— 这一格显示的是
  //   "按现在这个地址会落到哪儿"，显示错了就是"界面在说一件不成立的事"。
  //   工作区在这里显示成用它的那条连接（`w2` 是 `c2`，见上面 `CONNS` 与
  //   `WSS`）—— 2026-10-17 起工作区不再有「工作区 N」那个显示名。
  h.run('wsDefault = "w000000000002";');
  h.fn('renderFormWorkspace')();
  assert.equal(h.byId.get('f-workspace').children[0].textContent,
    '默认：bob@198.51.100.9');
  assert.match(h.byId.get('ws-hint').textContent, /会落在「bob@198\.51\.100\.9」/);

  // ── 用户显式挑一个：不再跟随默认 ──
  h.run('wsPicked = "w000000000001";');
  h.fn('renderFormWorkspace')();
  assert.equal(h.byId.get('f-workspace').value, 'w000000000001');
  assert.match(h.byId.get('ws-hint').textContent, /会用「alice@198\.51\.100\.7」/);

  // ── 用户要一个新的：那一项要被真的选中，不能被吞回去 ──
  //   一个"未找到就空着"的兜底如果写成了 `list.some(id === keep)`，那么
  //     `__new__` 这个不在列表里的值会被悄悄换成空串 —— 界面回到"默认"，
  //     而保存时发上去的就是"没表态"，用户点的那一项从头到尾没生效。
  h.run('wsPicked = "__new__";');
  h.fn('renderFormWorkspace')();
  assert.equal(h.byId.get('f-workspace').value, '__new__',
    '选了「＋ 新建空白工作区…」就该停在那一项上');
  assert.match(h.byId.get('ws-hint').textContent, /保存后会新建一个空白工作区/);

  // ── 编辑：没有"跟随默认"那一项，初值是这条连接自己的工作区 ──
  h.run('form = { open: true, mode: "edit", id: "c1" }; wsPicked = "";');
  h.fn('renderFormWorkspace')();
  const sel2 = h.byId.get('f-workspace');
  assert.equal(sel2.children.some((o) => o.value === ''), false,
    '编辑时没有"跟随默认"—— 这条连接已经有一个了，那一格答的是"要不要换"');
  assert.equal(sel2.value, 'w000000000001', '初值是它现在那个');
  assert.equal(h.byId.get('ws-hint').textContent, '不变。');

  // 换一个：那一句话必须说清"原来那个里面的东西不会跟着走" ——
  //   换工作区 = 换 origin = 浏览器重新加载，这是用户按下保存之前唯一的机会。
  h.run('wsPicked = "w000000000002";');
  h.fn('renderFormWorkspace')();
  assert.match(h.byId.get('ws-hint').textContent, /切到「bob@198\.51\.100\.9」/);
  assert.match(h.byId.get('ws-hint').textContent, /不会跟着走/);
});

test('停在连接那一屏时不画会话标签', () => {
  // 用户 2026-10-19 真机：连接卡在主页上，上栏却已经冒出会话标签。第一屏是
  //   "还没进去"的那一屏，那里不该有可切的东西 —— 连接成没成与会话接没接
  //   回来是两件事，界面不能把后者的进展画在前者的屏上。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.run("SCREEN = 'conns';");
  h.run('SESS = { sessions: [{ slot: "a", service: "编辑器", live: true, snap: {} }],'
    + ' front: "a" };');
  h.fn('renderTabs')();
  const box = h.byId.get('session-tabs');
  assert.equal(box.classList.contains('hidden'), true, '第一屏上不该有标签');
  assert.equal(box.children.length, 0, '一个都不许画（不是画好再藏起来）');

  h.run("SCREEN = 'plugins';");
  h.fn('renderTabs')();
  assert.equal(box.classList.contains('hidden'), false, '进了插件页才出现');
});

test('顶栏标签：同一个插件开两份时，两个标签必须分得开', () => {
  // 这一条守的是多开（`contributes.concurrent: true`：第二份拿到自己的
  //   临时数据 = 自己的槽，于是两条同时在跑）。标签上写的是插件的显示名，
  //   于是两个标签一模一样 —— 而它们指着两份不同的数据、两个不同的本地端口。
  //   用户点哪一个都有一半概率点错，而"点错了"的表现是"我的编辑器里东西不对了"。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.run("SCREEN = 'plugins';");
  h.run('SESS = { sessions: ['
    + '{ slot: "a", service: "编辑器", live: true, snap: { localPort: 18080 } },'
    + '{ slot: "b", service: "编辑器", live: true, snap: { localPort: 18081 } }'
    + '], front: "a" };');
  h.fn('renderTabs')();
  // 「面板」排第一（它是一颗固定的回程），会话标签跟在它后面。
  const tabs = h.byId.get('session-tabs').children;
  assert.equal(tabs.length, 3, '两条会话两个标签，加一颗「面板」');
  assert.equal(tabs[0].textContent, '面板');
  assert.notEqual(tabs[1].textContent, tabs[2].textContent,
    '同名时必须补区分符 —— 两个完全相同的标签等于没有标签');
  assert.match(tabs[1].textContent, /18080/, '区分符是本地端口');
  assert.match(tabs[2].textContent, /18081/);
  // 而不同名时一个字都不加：给每一条都挂一个端口，等于把"这两条需要分"
  // 说给所有人听（设计律：非必要不提示）。
  h.run(`SESS = { sessions: [
    { slot: 'a', service: '编辑器', live: true, snap: { localPort: 18080 } },
    { slot: 'b', service: '中转站', live: true, snap: {} } ], front: 'a' };`);
  h.fn('renderTabs')();
  const t2 = h.byId.get('session-tabs').children;
  assert.equal(t2[1].textContent, '编辑器', '不重名就不加字');
  assert.equal(t2[2].textContent, '中转站');
  // 一条会话、而本机还不知道它那个插件（`lastPlugins` 为空 —— 对不上插件
  //   的时候就是这样）：它跑着，标签要露 —— 用户 2026-10-18：在运行的作业要
  //   一直挂在上栏。「面板」那一颗与它认不认得出插件无关（栏在，它就在）。
  h.run(`SESS = { sessions: [
    { slot: 'a', service: '编辑器', live: true, snap: { localPort: 18080 } } ], front: 'a' };`);
  h.fn('renderTabs')();
  const t3 = h.byId.get('session-tabs').children;
  assert.equal(h.byId.get('session-tabs').classList.contains('hidden'), false,
    '跑着的会话就要在栏上，哪怕本机认不出它的插件');
  assert.equal(t3[0].textContent, '面板', '「面板」与"认不认得出插件"无关');
  assert.equal(t3[1].disabled, false,
    '插件认不出来 = 不知道它有没有页面，那时不许把标签按死');
});

test('一条会话也露标签：那颗「面板」是回到插件页与作业页的唯一入口', async () => {
  // 真机（2026-10-18）：只有一条 web-demo 会话时，标签栏从前整条收着 ——
  //   而那一块原生视图从 y=30 往下盖住整个窗口主体。于是起完会话就回不到
  //   插件页与作业页，连"现在跑的是哪一条"都看不见。用户报的原话是
  //   "没有显示这个插件的标签，而且没有返回到插件或者作业页面的按钮或方式"。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'window.__shown = 0; window.__front = null;'
    + 'window.slurmate.showPanel = () => { window.__shown += 1;'
    + ' return Promise.resolve({ ok: true }); };'
    + 'window.slurmate.setFront = (slot) => { window.__front = slot; };'
    + 'lastPlugins = { plugins: ['
    + '{ id: "p1", name: "cs", title: "编辑器", surface: { path: "/" } },'
    + '{ id: "p2", name: "relay", title: "中转站" } ] };'
    + "SCREEN = 'plugins'; connected = true;");
  const tabs = () => h.byId.get('session-tabs').children;
  const panelTab = () => tabs().filter((b) => b.textContent === '面板');

  // ── ① 一条带页面的会话：栏要露，插件名那颗与「面板」那颗都在 ──
  h.run(`SESS = { sessions: [
    { slot: 'a', service: '编辑器', live: true,
      snap: { serviceKind: 'cs', localPort: 18080 } } ], front: 'a' };`);
  h.fn('renderTabs')();
  assert.equal(h.byId.get('session-tabs').classList.contains('hidden'), false,
    '有页面盖着面板时这一条栏必须露 —— 它是这个窗口里唯一的出路');
  assert.equal(tabs()[0].textContent, '面板', '「面板」排第一：它是一个固定的回程（用户 2026-10-18）');
  assert.equal(tabs()[1].textContent, '编辑器', '会话标签跟在它后面（新开的往后加）');
  assert.equal(panelTab().length, 1);
  assert.match(panelTab()[0].className, /\bpanel\b/,
    '它自己的类要挂上 —— 与会话标签做的是相反的事，长相加一个虚线边');

  // ── ② 点「面板」：只抬面板，不切会话、不换屏 ──
  h.run("$('screen-plugins').classList.remove('hidden'); $('screen-jobs').classList.add('hidden');");
  await panelTab()[0].onclick();
  assert.equal(h.run('window.__shown'), 1, '点它要调 `showPanel`');
  assert.equal(h.run('window.__front'), null, '它不是会话标签：不许调 setFront（那会把面板再盖回去）');
  assert.equal(h.byId.get('screen-plugins').classList.contains('hidden'), false,
    '回到用户离开时的那一屏（不换屏）');

  // ── ③ 会话标签照旧把页面抬上来（从面板走回页面的那条路）──
  tabs()[1].onclick();
  assert.equal(h.run('window.__front'), 'a');

  // ── ④ 抬不起来要说出来：静默失败与"这一颗本来就没事可做"长得一样 ──
  h.run("window.slurmate.showPanel = () => Promise.resolve({ ok: false, error: '假装抬不起来' });");
  await panelTab()[0].onclick();
  const last = () => h.byId.get('notices').children[0].children[1].textContent;
  assert.match(last(), /假装抬不起来/);

  // ── ⑤ 没有界面的插件（中转站那类）：标签在、灰掉、点不动；「面板」照样在 ──
  //
  // 用户 2026-10-27：只跑着一个没有界面的插件时，上栏只剩一颗点不动的插件
  //   标签，而回面板的那颗按钮整个不见了 —— 那一屏没有任何出路。
  h.run(`SESS = { sessions: [
    { slot: 'b', service: '中转站', live: true,
      snap: { serviceKind: 'relay', localPort: 18081, state: 'running' } } ], front: 'b' };`);
  h.fn('renderTabs')();
  assert.equal(h.byId.get('session-tabs').classList.contains('hidden'), false,
    '跑着的会话要一直挂在上栏 —— 没有页面也是');
  assert.equal(panelTab().length, 1, '「面板」不能消失 —— 它是这个窗口的固定回程');
  assert.equal(tabs()[1].textContent, '中转站', '那个插件的标签也要在：它是"这一条在跑"的记号');
  assert.equal(tabs()[1].disabled, true, '它没有可切过去的页面，所以不许点');
  assert.match(tabs()[1].className, /\bnopage\b/, '灰掉：与"已结束"（dead）是两件事');
  assert.match(tabs()[1].title, /没有界面/, '灰按钮要说原因，不然读起来像"它坏了"');
  // 而点「面板」照旧有用：面板就是此刻该露的那一屏。
  h.run("window.slurmate.showPanel = () => { window.__shown += 1;"
    + ' return Promise.resolve({ ok: true }); };');
  await panelTab()[0].onclick();
  assert.equal(h.run('window.__shown'), 2, '「面板」抬得起来 —— 那一屏不是死路');
});

test('右栏整条只在有作业在跑的时候亮（那时它才有内容可说）', () => {
  // 2026-10-11 改：上色的对象从那个 6px 的圆点换成了边栏自己 ——
  //   10px 宽的一条边上再放一个 6px 的点，看起来跟没有一样（用户报的原话）。
  //   于是这个壳里取的元素也跟着换，而判据一个字没变（三档、各是什么）。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  const rail = () => h.byId.get('rail-right').className;
  // 一条会话都没有
  h.run('SESS = { sessions: [], front: null };');
  h.fn('renderRails')();
  assert.equal(rail(), 'rail rail-r', '没作业就不亮');
  // 有一条活的
  h.run('SESS = { sessions: [{ slot: "a", service: "编辑器", live: true, snap: {} }], front: "a" };');
  h.fn('renderRails')();
  assert.equal(rail(), 'rail rail-r hot', '有作业在跑才亮');
  // 而"已经结束但记录还在"那一条不算：`live` 是主进程给的判据，
  //   拿"这张表非空"当判据的话，一个只剩尸体的槽会让右栏一直亮着。
  h.run('SESS = { sessions: [{ slot: "a", service: "编辑器", live: false, snap: {} }], front: "a" };');
  h.fn('renderRails')();
  assert.equal(rail(), 'rail rail-r', '结束了的会话不算"有作业在跑"');
});

test('第二屏那颗「临时离开」只在真有作业在跑时出现', () => {
  // 2026-10-11：它从第一屏搬到了第二屏的标题带上，判据也从 `connected`
  //   （那一屏只有连着才进得来，于是那个条件恒为真）换成了有没有作业在跑 ——
  //   没有作业可"离开"的时候摆一颗按下去什么也不发生的按钮，是在说一件不成立的事。
  //   而它必须挂在 `renderSessions` 那一路上：作业会在用户待在这一屏的时候
  //     起停（另一台电脑接管、作业自己跑完、从作业那一屏起了一条新的）。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  const hidden = () => h.byId.get('btn-leave').classList.contains('hidden');
  h.fn('renderSessions')({ sessions: [], front: null });
  assert.equal(hidden(), true, '没有作业可"离开"的时候不摆它');
  h.fn('renderSessions')({ sessions: [
    { slot: 'a', service: '编辑器', live: true, snap: {} }], front: 'a' });
  assert.equal(hidden(), false, '有作业在跑才出现');
  // 而"已经结束但记录还在"那一条不算 —— 与右栏那一条同一个判据
  //   （`hasRunningSession()` 就是 `liveCount() > 0`，不是各写一遍）。
  h.fn('renderSessions')({ sessions: [
    { slot: 'a', service: '编辑器', live: false, snap: {} }], front: 'a' });
  assert.equal(hidden(), true, '结束了的会话不算"有作业在跑"');
});

test('连上之后才有两条边栏，而且它们是在状态条下面那一段', () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  // 没连上：`body` 上没有那个 class，两条栏由 CSS 收起来。
  h.fn('renderConnections')(CONNS);
  assert.equal(h.run('document.body.classList.contains("connected")'), false,
    '没连上就不该有边栏');
  // 走 `setConnected`（2026-10-11 起那一格只有这一个入口）：它顺手把跟着
  //   `connected` 走的东西当场重画 —— 两条边栏。
  //   裸赋值 + 重画列表那条老路已经删掉了（两处各写一遍迟早漂开）。
  h.run('setConnected(true);');
  assert.equal(h.run('document.body.classList.contains("connected")'), true,
    '连上之后两条栏才出现');
});

test('插件块上的并发上限：站点报了就说，没说就一个字都不说', () => {
  // 站点给这个插件设的会话上限（`maxSessions`，真站点那一格是插件配置里的
  //   `max_sessions`）。它是管理员设的政策，与上面那句「默认 2 核 / 8G」同一类
  //   —— 所以并排只读地摆着，不进按钮的文案。
  //
  // 而"站点没说"那一档是这一条的重点：补一个 1 的话，那会是一句编出来的政策，
  //   而用户会拿它当本站的规定（老守护进程根本报不出这一格）。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  // 那一块里只有一条 `.plug-meta`（几格事实）—— 三颗按钮搬去 `.plug-actions` 了。
  const factsOf = (i) => childrenOf(h.byId.get('plugin-blocks').children[i])
    .filter((x) => x.className === 'plug-meta')[0];
  const wordsOf = (e) => childrenOf(e).map((x) => x.textContent).join(' ｜ ');

  h.fn('renderPlugins')({ ...PV,
    plugins: PV.plugins.map((p) => ({ ...p, maxSessions: 2 })) });
  assert.match(wordsOf(factsOf(0)), /最多同时 2 个会话/,
    `站点报了就要画出来：${wordsOf(factsOf(0))}`);

  h.fn('renderPlugins')({ ...PV,
    plugins: PV.plugins.map((p) => ({ ...p, maxSessions: null })) });
  assert.doesNotMatch(wordsOf(factsOf(0)), /最多同时/,
    `站点没说就一个字都不说：${wordsOf(factsOf(0))}`);
});

test('插件块上的「用哪一份数据」：三种取值各发各的，一个都不许合并', async () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES },
  'lastPlugins = { plugins: [{ id: "p1", title: "编辑器" }, { id: "p2", title: "中转站" }] };'
  + 'window.__calls = [];'
  + 'window.slurmate.setWorkspaceRef = (p) => { window.__calls.push(p);'
  + ' return Promise.resolve({ ok: true, droppedOld: false }); };');
  h.fn('renderPlugins')(PV);

  const blocks = h.byId.get('plugin-blocks').children;
  assert.equal(blocks.length, 2);
  const selOf = (b) => childrenOf(b).find((x) => x.className === 'plug-space') || null;
  // 按 class 找，不按"块里第一个 SELECT"找：块里现在还有一个 GRES 下拉（高级选项
  //   那一格，v0.18 起长在每一块里）—— 而这条用例问的是数据那一格。
  // 发出去的那个对象是在 vm 另一个 Realm 里造的，`deepStrictEqual` 会拿原型
  //   去比，于是两个字段完全一样的对象也说"不相等"。所以比字段时走一趟 JSON。
  const raw = (i) => h.run(`window.__calls[${i}]`);
  const sent = (i) => JSON.parse(JSON.stringify(raw(i)));
  // 而"键在不在"必须查在原对象上 —— `JSON.stringify` 会把值为 `undefined`
  //    的键整个丢掉，于是"没有 `spaceId` 这个键"与"有、值是 undefined"在
  //    `sent()` 眼里长得一模一样。第一版的判据就戴了这个遮罩：把界面那边改成
  //    「永远发一个 `spaceId: undefined`」时它照样绿。见下面第 ③ 段。

  // 不要数据空间的插件没有这一格（`ports: 0`）。画一个空下拉等于凭空许诺
  //   一个不存在的东西 —— 它没有存储、没有端口，也就没有"用哪一份"。
  assert.equal(selOf(blocks[1]), null, '0 个端口的插件不该有那一格');

  const sel = selOf(blocks[0]);
  assert.ok(sel, '要数据的插件必须有那一格');
  // 选项 = 这个插件的两份 + 「另开一份」。没有"跟随默认"那一项 ——
  // 这个工作区已经指着一份了，再摆一个"默认"只会让下拉停在一个不生效的值上。
  assert.deepEqual(sel.children.map((o) => o.value),
    ['s000000000001', 's000000000002', '__new_space__']);
  assert.equal(sel.value, 's000000000001', '初值是它现在指着的那一份');
  // 「还有谁在用」：s2 被 2 号工作区指着，而那个工作区显示的是用它那条连接的名字
  //   （2026-10-17 起工作区不再有「工作区 N」那个显示名，见 panel.js 的
  //   `workspaceLabel`）。s1 没有别人 —— 两句话必须分开，因为用户按它决定
  //   "改这一格会不会动到别人"。
  assert.match(sel.children[0].textContent, /数据 1 · 端口 18080$/);
  assert.match(sel.children[1].textContent,
    /数据 2 · 端口 18081（「bob@198\.51\.100\.9」也在用）/);

  // ── ① 选另一份已存在的，发一个数据 id ──
  //   `connectionId` 也一起发：主进程要拿它回答"这张表是替哪一条连接改的"
  //     （共用的一张表要分叉时，得指名分给谁）—— 它不拿"谁活跃"去猜。
  sel.value = 's000000000002';
  await sel.onchange();
  assert.deepEqual(sent(0),
    { workspaceId: 'w000000000001', pluginId: 'p1', connectionId: 'c1',
      spaceId: 's000000000002' });

  // ── ② 选「另开一份」，发 `null`（不是空串、也不是某个 id）──
  sel.value = '__new_space__';
  await sel.onchange();
  assert.deepEqual(sent(1),
    { workspaceId: 'w000000000001', pluginId: 'p1', connectionId: 'c1', spaceId: null });

  // ── ③ 这一格还没有值（引用表里没有这个插件），发的是没有 spaceId 这个键 ──
  //   这一条是整个协议里最容易写错的一格：「没表态」与「要一个新的」合并成一种
  //     值时，用户点了「另开一份」而系统理解成"什么都不做"（或者反过来，用户什么都
  //     没做而系统又开了一份）—— 两边都不报错。
  const empty = WSS.map((l) => ({ ...l, refs: {}, spaces: [] }));
  h.run(`boot = { connections: ${JSON.stringify(CONNS)}, workspaces: ${JSON.stringify(empty)},`
    + ` activeConnectionId: 'c1', spaces: ${JSON.stringify(SPACES)} };`);
  h.fn('renderPlugins')(PV);
  const sel2 = selOf(h.byId.get('plugin-blocks').children[0]);
  assert.equal(sel2.children[0].value, '', '还没有值，第一项是"跟随默认"');
  assert.match(sel2.children[0].textContent, /第一次开会话时新建一份/);
  assert.equal(sel2.value, '', '初值选中"跟随默认"');
  assert.equal(sel2.children.length, 4, '默认 + 两份数据 + 另开一份');

  // 选「跟随默认」（什么都没改）
  sel2.value = '';
  await sel2.onchange();
  // 查在原对象上（`sent` 会把这一格抹平，见上面那段）：
  assert.equal('spaceId' in raw(2), false,
    '「没表态」必须是键缺席 —— 界面不许把一个显式的 `spaceId: undefined` 发出去：'
    + '那是"这一格有值、值是空的"，它与"这一格没有值"是不是同一件事，取决于传输层'
    + '怎么看待 undefined（跨 IPC 一路序列化下来，两种形状能不能分开不由我们说了算）。'
    + '而这一格一旦被读成"要一个新的"，用户什么都没做、每开一次会话就多一份数据。');

  // 而这一格还没有值的时候选「另开一份」，发的仍然是 `null`
  sel2.value = '__new_space__';
  await sel2.onchange();
  assert.deepEqual(sent(3),
    { workspaceId: 'w000000000001', pluginId: 'p1', connectionId: 'c1', spaceId: null });

  // ── ④ 一条连接都没有，整格不画 ──
  h.run('boot = { connections: [], workspaces: [], activeConnectionId: null, spaces: [] };');
  h.fn('renderPlugins')(PV);
  assert.equal(selOf(h.byId.get('plugin-blocks').children[0]), null,
    '没有活跃连接时那一格没有对象 —— 画一个空的等于凭空许诺');
});

test('高级选项：一块一份，两块各填各的，值不串到另一块', async () => {
  // 2026-10-11 加（界面第三轮 F4）。那几格从前是全屏共用的一份，长在第二屏
  //   最底下 —— 而它喂的是某一块的「开始会话」。三四个插件并排时，"我填的 4 核
  //   是给谁的"在界面上根本表达不出来。
  //
  //   这条盯的是串味：甲填的 4 核出现在乙的提交里，而界面上一切正常、
  //     两个下拉也各自显示着各自的值。判据只能是"按下去之后发出去的那一份"。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES },
  'window.__subs = [];'
  + 'window.slurmate.start = (res, kind, port) => { window.__subs.push({ res, kind, port });'
  + '  return Promise.resolve({ ok: true }); };');
  h.fn('renderPlugins')(PV);
  // 分区表是站点级的（全局一份），它到得比插件块早或晚都可能 —— 这里刻意在
  // 块画好之后才给，验的是"它变了，每一块里那一格都跟着换"。
  h.fn('renderPartitions')([
    { name: 'gpu', allowed: true,
      gres: [{ name: 'gpu', type: 'a100', per_node_max: 4, label: 'a100' }] },
    { name: 'cpu', allowed: false, reason: '这个分区要另外申请' },
  ]);

  const kidsOf = (e) => (e.children || []).filter((k) => k && k.tagName);
  const blockOf = (i) => h.byId.get('plugin-blocks').children[i];
  const advOf = (b) => kidsOf(b).find((x) => x.className === 'plug-adv');
  /** 那一块里那几格：CPU / 内存 / GRES / 数量 / 分区（`field()` 造 div>label+控件）。 */
  const cellsOf = (b) => {
    const row = childrenOf(advOf(b)).find((x) => x.className === 'row');
    return kidsOf(row).map((w) => kidsOf(w)[1]);
  };
  const btnOf = (b) => kidsOf(
    kidsOf(b).find((x) => x.className === 'plug-actions')).find((x) => x.tagName === 'BUTTON');

  const [b0, b1] = [blockOf(0), blockOf(1)];
  const a0 = cellsOf(b0);
  const a1 = cellsOf(b1);
  assert.equal(a0.length, 5, '一块里那几格：CPU / 内存 / GRES / 数量 / 分区');
  assert.notEqual(advOf(b0), advOf(b1), '两块各有一份，不是同一个元素被塞两次');

  // ── 两块里那一格都要跟着站点给的分区表走 ──
  for (const a of [a0, a1]) {
    assert.deepEqual(a[4].children.map((o) => o.value), ['', 'gpu', 'cpu']);
    assert.match(a[4].children[2].textContent, /cpu（无权限）/);
    assert.equal(a[4].children[2].disabled, true, '没权限的那个选项要灰着');
    assert.equal(a[4].children[2].title, '这个分区要另外申请',
      '而灰着必须给出理由 —— 让用户猜为什么点不动是不行的');
  }

  // ── 甲填满 ──
  a0[0].value = '4';        // CPU 核数
  a0[1].value = '16G';      // 内存
  a0[4].value = 'gpu';      // 分区换了，它自己那一格的 GRES 跟着换
  a0[4].onchange();
  assert.deepEqual(a0[2].children.map((o) => o.value), ['', 'none', '0'],
    '这个分区的 GRES：默认 / 不占 / a100（下标就是选项的 value）');
  a0[2].value = '0';
  a0[2].onchange();
  assert.equal(a0[3].disabled, false, '选择了卡，数量那一格才填得动');
  assert.equal(a0[3].max, '4', '上限来自服务端给的 per_node_max，不是写死的数');
  a0[3].value = '2';

  // ── 乙一个字没动：它那几格必须是它自己的样子 ──
  assert.deepEqual([a1[0].value, a1[1].value, a1[4].value], ['', '', '']);
  assert.equal(a1[2].value, '', '乙的 GRES 还停在"用插件的默认"');
  assert.equal(a1[3].disabled, true, '而乙的数量那一格还是灰的（甲选择了卡不影响它）');

  const sent = (i) => JSON.parse(JSON.stringify(h.run(`window.__subs[${i}]`)));
  await btnOf(b0).onclick();
  await btnOf(b1).onclick();
  assert.deepEqual(sent(0), {
    res: { cpus: 4, mem: '16G', partition: 'gpu',
      gres: { name: 'gpu', type: 'a100', count: 2 } },
    kind: 'cs', port: null,
  }, '甲交出去的是甲填的那一份');
  assert.deepEqual(sent(1), { res: {}, kind: 'relay', port: null },
    '乙那一块什么都没填，发的是空对象：留空不是"0 核"，是"让服务端用它自己'
    + '的默认值"。若串味这里会看到甲的那 4 核');
});

test('三格滑块：停在站点那份默认上，拖动它就把值写进那一格，框让位给读数', () => {
  // 2026-10-16 用户要的（"CPU 数量、GPU 数量、内存大小都采用拖进度条的方式"）。
  // 四条判据是三条决定加一条老语义：
  //   · 滑块停在站点按插件定的那份默认上，而且那份默认变了它跟着走
  //     （所以它不是一个写死的起点）；
  //   · 拖动就是把值写进那一格（提交那一侧读的仍然是那一格，见 `startWith`）；
  //   · 装了滑块的格子不再摆那个输入框，位置由标签右端那个读数说
  //     （用户同一天要的："托条旁边不要再留输入框，但要显示出来现在在什么位置"）；
  //   · 而"留空即默认"一个字没变 —— 停在默认位置不等于那一格里有字。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES });
  const a = h.fn('pluginAdv')({ cpus: 2, mem: '8G', time: '12:00:00',
    gpus: { name: 'gpu', type: null, count: 1 } });
  const st = a.st;
  const cells = childrenOf(a.box).find((x) => x.className === 'row').children;
  const rangeOf = (i) => childrenOf(cells[i]).find((x) => x.type === 'range');
  // 那一格本来的输入框，以及标签右端那个读数。
  const boxOf = (i) => childrenOf(cells[i])
    .find((x) => x.tagName === 'INPUT' && x.type !== 'range');
  const valOf = (i) => childrenOf(cells[i]).find((x) => x.className === 'adv-val');

  // ── CPU：档位表是 1 2 4 8 12 …，2 那一档是下标 1 ──
  assert.equal(rangeOf(0).value, '1', 'CPU 那条停在站点的默认（2 核）上，不是起点上');
  assert.equal(st.cpus.value, '', '而那一格里仍然一个字都没有 —— 留空即默认');
  assert.equal(rangeOf(0).max, '17',
    '还没选分区时用退路 64：1 2 4 8 12 16 20 24（8 档）+ 28 32 … 64（10 档）共 18 档');
  // 装了滑块的格子不再摆那个输入框，位置改由滑块旁边那个读数说。
  //   输入框还在 DOM 里（提交那一侧读的就是它），所以判的是"画不画得出来"。
  assert.equal(boxOf(0).classList.contains('hidden'), true,
    '装了滑块就不再摆那个输入框（用户 2026-10-16：托条旁边不要再留输入框）');
  assert.equal(valOf(0).textContent, '2',
    '读数写着滑块停在哪儿，也就是将要发出去的那个数');
  rangeOf(0).value = '3';                    // 下标 3 = 8 核
  rangeOf(0).oninput();
  assert.equal(st.cpus.value, '8', '拖动它就是把值写进那一格');
  assert.equal(valOf(0).textContent, '8', '读数跟着滑块走');
  // 反过来：用户直接打字，滑块跟着挪（只挪位置，不改他打的字）。
  //   那一格上的监听是 `addEventListener('input', …)` 挂的（不是 `oninput`），
  //   这个架子把它记在 `_ls` 里。
  const typed = (ctrl) => ctrl._ls.filter((x) => x[0] === 'input').forEach((x) => x[1]());
  st.cpus.value = '20';
  typed(st.cpus);
  assert.equal(rangeOf(0).value, '6', '手打 20 核之后滑块移到 20 那一档（下标 6）');
  st.cpus.value = '7';                       // 不在档位上
  typed(st.cpus);
  assert.equal(rangeOf(0).value, '6', '打了一个不在档位上的数时滑块不动，也不改他打的数');
  assert.equal(st.cpus.value, '7');

  // ── 内存：顶是分区里最大的那种节点，默认是站点那份 `defaults.mem` ──
  assert.equal(rangeOf(1), undefined, '还没选分区时没有顶 —— 那条滑块不画');
  assert.equal(boxOf(1).classList.contains('hidden'), false,
    '而没有滑块的时候，那一格留着的仍是那个输入框：`512M` 这种写法要写得进去');
  assert.equal(valOf(1).textContent, '', '那时也没有读数，标签那一行与从前相同');
  h.fn('renderPartitions')([
    { name: 'normal', allowed: true, mem_per_node_mb: 128000, cpus_per_node: 64,
      gres: [{ name: 'gpu', type: null, per_node_max: 8, total: 8 }] },
    { name: 'big', allowed: true, mem_per_node_mb: 191000, cpus_per_node: 128,
      gres: [] },
  ]);
  // 随机分区：两个顶都取有权限分区里的最大值（不是最小值）。
  assert.equal(rangeOf(0).max, '33',
    '随机分区时 CPU 滑块顶 = 各分区最大值 128（1 2 4 … 24 + 28…128 共 34 档）');
  assert.equal(rangeOf(1).max, '185',
    '随机分区时内存滑块顶 = 各分区最大值（191000 MB → 186 GB，下标 0…185）');
  st.part.value = 'normal';
  st.part.onchange();
  assert.equal(rangeOf(1).max, '124', '128000 MB → 125 个整 GB，下标 0…124');
  assert.equal(rangeOf(1).value, '7', '停在默认的 8G 上');
  assert.equal(valOf(1).textContent, '8G', '读数写的是将要发出去的那个写法');
  rangeOf(1).value = '15';
  rangeOf(1).oninput();
  assert.equal(st.mem.value, '16G',
    '写回那一格的必须是 Slurm 认的写法（`--mem=16` 是 16 MB，不能只写数字）');
  assert.equal(valOf(1).textContent, '16G', '读数跟着走');

  // ── 数量：只在点名了那张卡、而且正是插件默认的那张卡时才有得停 ──
  assert.equal(rangeOf(3), undefined, '没点名卡就没有"几个"可言，滑块与那一格一起灰着');
  assert.equal(boxOf(3).classList.contains('hidden'), false,
    '它露出来的是那个数字框（灰着），不是滑块');
  st.gres.value = '0';                       // 第一项，正好是默认那张 `gpu`
  st.gres.onchange();
  assert.ok(rangeOf(3), '点了名、而且就是插件默认的那张卡 → 有滑块');
  assert.equal(rangeOf(3).value, '0', '停在默认的 1 张上');
  assert.equal(rangeOf(3).max, '7', '顶是服务端给的 per_node_max（8 张），与数字框同一处');
  assert.equal(boxOf(3).classList.contains('hidden'), true, '数字框跟着让位给滑块');
  rangeOf(3).value = '3';
  rangeOf(3).oninput();
  assert.equal(st.gresN.value, '4');
  assert.equal(valOf(3).textContent, '4', '读数就是将要发出去的那个数');

  // ── 换一个分区：顶跟着换，而这一格里的字与滑块的位置都留在原处 ──
  st.part.value = 'big';
  st.part.onchange();
  assert.equal(rangeOf(1).max, '185', '191000 MB（186.5 GB）向下取整到 186 GB');
  assert.equal(rangeOf(1).value, '15', '而滑块还停在刚才拖到的 16G 上，没有弹回默认');
  assert.equal(st.mem.value, '16G');
  assert.equal(rangeOf(3), undefined, '换分区会把 GRES 那一格清掉，数量那条跟着消失');
  assert.equal(boxOf(3).classList.contains('hidden'), false, '框露回来了');
  assert.equal(valOf(3).textContent, '',
    '读数也清掉：留着上一个分区算出来的 4，它会读成这一格现在的取值');
});

test('滑块画不出来就不画：站点没给默认、默认不在档位上、或者不是默认的那张卡', () => {
  // 画一个停在错位置上的滑块比不画更坏：用户会照着它按下去，而那个数不是
  //   站点说的默认。所以装不上的四种情况一律不画，只留原来那个输入框。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES });
  const cellsOf = (box) => childrenOf(box).find((x) => x.className === 'row').children;
  const rangeOf = (cells, i) => childrenOf(cells[i]).find((x) => x.type === 'range');
  const boxOf = (cells, i) => childrenOf(cells[i])
    .find((x) => x.tagName === 'INPUT' && x.type !== 'range');

  // ① 站点那份默认整个拿不到（老守护进程的 `defaults` 是 null）
  const a1 = h.fn('pluginAdv')(null);
  assert.equal(rangeOf(cellsOf(a1.box), 0), undefined, '没有默认值就没有滑块，一格都没有');
  assert.equal(boxOf(cellsOf(a1.box), 0).classList.contains('hidden'), false,
    '没装滑块的格子照旧只有那个输入框 —— 那是它唯一能填的地方');

  // ② 默认不在档位上 → 插进去，滑块停得在它上面（6 核不是 1/2/4/8 那张表上的数）
  const a2 = h.fn('pluginAdv')({ cpus: 6, mem: '512M', gpus: null });
  const c2 = cellsOf(a2.box);
  assert.equal(rangeOf(c2, 0).value, '3', '6 核插在 4 与 8 之间，滑块停在它上面');
  assert.equal(rangeOf(c2, 1), undefined, '`512M` 不是整 GB —— 内存那条不画');
  assert.equal(rangeOf(c2, 3), undefined, '`gpus: null` 是"本站没配默认卡"，不画');

  // ③ 默认超出了上限（CPU 那一格的上限是那个有人交叉盯着的常量）
  const a3 = h.fn('pluginAdv')({ cpus: 999, mem: '8G' });
  assert.equal(rangeOf(cellsOf(a3.box), 0), undefined,
    '默认比上限还大时不画 —— 装了它也只能停在一个服务端会钳掉的数上');

  // ④ 选了另一张卡：照样有滑块（数量这一格本来就是必填），初值 1。
  //    站点给的"默认几个"只属于它点名的那张卡；换了卡就没有那个数，
  //    替它沿用别处的默认等于替站点定政策 —— 所以停 1，让用户自己拖。
  const a4 = h.fn('pluginAdv')({ cpus: 2, mem: '8G',
    gpus: { name: 'gpu', type: null, count: 1 } });
  h.fn('renderPartitions')([
    { name: 'mixed', allowed: true, mem_per_node_mb: 262144, cpus_per_node: 128,
      gres: [{ name: 'gpu', type: 'rtx8000', per_node_max: 4, total: 4 },
             { name: 'mps', type: null, per_node_max: 100, total: 100 }] },
  ]);
  a4.st.part.value = 'mixed';
  a4.st.part.onchange();
  const c4 = cellsOf(a4.box);
  a4.st.gres.value = '1';                    // `mps`，不是默认那张 `gpu`
  a4.st.gres.onchange();
  assert.ok(rangeOf(c4, 3), '点名了卡就有滑块 —— 这一格本来就是必填');
  assert.equal(rangeOf(c4, 3).value, '0', '没有对应的默认数量时停在 1 张');
  assert.equal(a4.st.gresN.value, '1', '初值要写进控件：不拖直接提交也得有个数');
  a4.st.gres.value = '0';                    // `gpu:rtx8000`
  a4.st.gres.onchange();
  assert.ok(rangeOf(c4, 3), '型号也不一致时照样有滑块');
  assert.equal(a4.st.gresN.value, '1');
});

test('同一份插件清单不重画：展开着的高级选项不许自己合上，填了一半的值不许被清掉',
  () => {
    // 2026-10-16 用户报的三条（"展开着的「高级选项」自己合上"、"滚动位置与列表跳动"、
    //   "填了一半的值回到空白"）是同一个根因：站点每次对账之后都会把整个视图
    //   推过来，而视图一个字都没变的时候从前也照样把这一屏拆了重画一遍。
    // 判据落在"那一块还是不是同一个元素"上 —— 重建一次就是换一个元素，而展开状态
    //   与填进去的值都挂在那一个元素上，于是它们一起没了。查"值还在不在"是不够的：
    //   把值搬进一份缓存、元素照旧重建，那样写也会绿。
    const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
      spaces: SPACES });
    h.fn('renderPlugins')(PV);
    const blockOf = (i) => h.byId.get('plugin-blocks').children[i];
    // 按 class 里的一个记号找：`adv-body` 那一格同时带着 `hidden`，
    //   整串比对会把展开着的那一层也漏掉。
    const has = (x, cls) => (x.className || '').split(/\s+/).indexOf(cls) >= 0;
    const advOf = (b) => childrenOf(b).find((x) => has(x, 'plug-adv'));
    const toggleOf = (b) => childrenOf(b).find((x) => has(x, 'adv-toggle'));
    const bodyOf = (b) => childrenOf(b).find((x) => has(x, 'adv-body'));

    const first = blockOf(0);
    const adv = advOf(first);
    // 展开那一块走用户那条路：点那颗开关（2026-10-18 起它不是 `<details>` 了）。
    toggleOf(first).onclick();
    assert.equal(bodyOf(first).classList.contains('hidden'), false,
      '（前提：它现在是展开着的）');
    const cells = childrenOf(adv).find((x) => x.className === 'row').children;
    cells[0].children[1].value = '7';        // CPU 那一格填到一半

    // 站点推下一份 —— 内容与上一份逐字相同，但是另一个对象（真机上那就是另一次
    //   IPC 反序列化出来的那一份）。
    h.fn('renderPlugins')(JSON.parse(JSON.stringify(PV)));

    assert.equal(blockOf(0), first, '同一份内容不该换掉那一块');
    assert.equal(bodyOf(first).classList.contains('hidden'), false,
      '展开着的还在展开着');
    assert.equal(cells[0].children[1].value, '7', '填了一半的值还在原处');

    // 反过来：内容真的变了就必须重画。少了这一半，上面那三条可以拿"永远不画"换来。
    h.fn('renderPlugins')({ ...PV,
      plugins: PV.plugins.map((p) => ({ ...p, version: '2.0.0' })) });
    assert.notEqual(blockOf(0), first, '换了内容就要重画');

    // 清空那一支也一样：`renderPlugins(null)` 之后再来一份与清空前逐字相同的视图，
    //   必须真的画出来 —— 跳过的话屏幕上是一块空列表，没有一句话解释它为什么空着。
    h.fn('renderPlugins')(null);
    assert.equal(h.byId.get('plugin-blocks').children.length, 0, 'null 就是清空');
    h.fn('renderPlugins')(PV);
    assert.equal(h.byId.get('plugin-blocks').children.length, 2, '清空之后同一份要重画');
  });

test('高级选项收起就退回默认；离开插件屏时也收起来', () => {
  // 2026-10-18 用户报的两条：「调整完，收起，再打开应该恢复默认，可是并没有」，
  //   以及「连切换页面再回来都没有恢复默认」。定下的状态只有两档：收着 = 全是
  //   默认，展开着 = 可能填着值；离开插件那一屏也就是把它收起来。
  //   判据是那一格真的被清空、滑块真的回到站点那份默认 —— 不是"重画了一遍"。
  const view = JSON.parse(JSON.stringify(PV));
  view.plugins[0].defaults = { cpus: 2, mem: '8G', time: '12:00:00',
    gpus: { name: 'gpu', type: null, count: 1 } };
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES },
  'window.slurmate.jobs = () => Promise.resolve({ ok: false,'
  + ' error: { detail: "没有站点" } });');
  h.fn('renderPlugins')(view);
  h.fn('renderPartitions')([
    { name: 'normal', allowed: true, mem_per_node_mb: 128000, cpus_per_node: 64,
      gres: [{ name: 'gpu', type: null, per_node_max: 8, total: 8 }] },
  ]);
  const block = () => h.byId.get('plugin-blocks').children[0];
  // 按 class 里的一个记号找（`adv-body` 那一格同时带着 `hidden`）。
  const find = (b, cls) => childrenOf(b).find(
    (x) => (x.className || '').split(/\s+/).indexOf(cls) >= 0);
  const toggle = () => find(block(), 'adv-toggle');
  const body = () => find(block(), 'adv-body');
  const row = () => find(body(), 'row');
  const cell = (i) => row().children.filter((k) => k && k.tagName)[i];
  const ctrl = (i) => childrenOf(cell(i)).find((x) =>
    (x.tagName === 'INPUT' || x.tagName === 'SELECT') && x.type !== 'range');
  const range = (i) => childrenOf(cell(i)).find((x) => x.type === 'range');
  const val = (i) => find(cell(i), 'adv-val');

  const fill = () => {
    const r0 = range(0);
    r0.value = '3'; r0.oninput();              // CPU 8 核
    const p = ctrl(4);
    p.value = 'normal'; p.onchange();          // 挑一个分区（内存滑块才有顶）
    const m = range(1);
    m.value = '15'; m.oninput();               // 内存 16G
    const g = ctrl(2);
    g.value = '0'; g.onchange();               // 第一张卡
    const n = range(3);
    n.value = '1'; n.oninput();                // 2 张
  };
  const assertDefault = (when) => {
    assert.equal(ctrl(0).value, '', `CPU 那一格要清空（${when}）`);
    assert.equal(ctrl(1).value, '', `内存要清空（${when}）`);
    assert.equal(ctrl(4).value, '', `分区要回到「不点名」那一项（${when}）`);
    assert.equal(ctrl(2).value, '', `GRES 要回到「用插件的默认」（${when}）`);
    assert.equal(ctrl(3).value, '', `数量要清空（${when}）`);
    assert.equal(ctrl(3).disabled, true, `而它要回到灰的（${when}）`);
    assert.equal(range(0).value, '1', `CPU 滑块要停回默认的 2 核（${when}）`);
    assert.equal(val(0).textContent, '2', `读数要写回默认值（${when}）`);
  };

  // ① 收起 = 不要这一份了。填进去的值不许留着 —— 它们会在下一次
  //   「开始会话」时被发出去，而界面上只剩一行收着的「高级选项」。
  toggle().onclick();
  assert.equal(body().classList.contains('hidden'), false, '（前提：点开了）');
  fill();
  assert.equal(val(0).textContent, '8', '（前提：填进去了）');
  toggle().onclick();
  assert.equal(body().classList.contains('hidden'), true, '收起');
  assertDefault('收起之后');

  // ② 切换页面再回来（用户点的那一条）。这一屏的 DOM 一直留在文档里，
  //   切走只是加一个 `hidden` —— 不在切走那一刻把它收起来，切回来时面板还开着、
  //   值也还在。
  h.fn('showScreen')('plugins');    // 前提：真的站在插件这一屏上
  toggle().onclick();
  fill();
  h.fn('showScreen')('jobs');
  assert.equal(body().classList.contains('hidden'), true,
    '离开那一屏时它要收起来 —— 收起就是退回默认');
  h.fn('showScreen')('plugins');
  assert.equal(body().classList.contains('hidden'), true, '回来时仍然是收着的');
  assertDefault('离开再回来之后');
});

test('会话页面盖上来也算离开插件那一屏：高级选项跟着收起来', () => {
  // 2026-10-30 用户：填完高级选项、点「开始会话」，页面盖上来，再点「面板」回来
  //   —— 那几格还开着、填进去的值还在。
  // 根因是"离开"从来没发生过：插件那一屏的 DOM 一直在文档里，`showScreen` 切走
  //   只加一个 `hidden`，而会话页面是盖在上面的，路由那一层一步都没动。
  // 判据落在"离开"上，所以盖上来那一下也要走同一条 `collapse()`。
  const view = JSON.parse(JSON.stringify(PV));
  view.plugins[0].surface = true;              // 编辑器那块有页面
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.fn('renderPlugins')(view);
  h.fn('renderPartitions')([
    { name: 'normal', allowed: true, mem_per_node_mb: 128000, cpus_per_node: 64, gres: [] },
  ]);
  const block = () => h.byId.get('plugin-blocks').children[0];
  const find = (b, cls) => childrenOf(b).find(
    (x) => (x.className || '').split(/\s+/).indexOf(cls) >= 0);
  const toggle = () => find(block(), 'adv-toggle');
  const body = () => find(block(), 'adv-body');
  const cell = (i) => find(body(), 'row').children.filter((k) => k && k.tagName)[i];
  const ctrl = (i) => childrenOf(cell(i)).find((x) =>
    (x.tagName === 'INPUT' || x.tagName === 'SELECT') && x.type !== 'range');

  const snap = (over) => ({ state: 'running', sessionId: 'sess-a', jobId: '42',
    serviceKind: 'cs', partition: 'normal', hbAgeMs: 1000, ...over });
  const push = (panelFront) => h.fn('renderSessions')({
    sessions: [{ slot: 'a', service: '编辑器', live: true, snap: snap() }],
    front: 'a', panelFront,
  });

  h.run("SCREEN = 'plugins';");
  toggle().onclick();
  ctrl(0).value = '8';                          // CPU 那一格填到一半
  assert.equal(body().classList.contains('hidden'), false, '（前提：点开了）');

  // 页面盖上来：前台那条在跑、插件有页面、面板没被抬上来。
  push(false);
  assert.equal(body().classList.contains('hidden'), true,
    '盖上来就是离开了这一屏 —— 那几格要收起来');
  assert.equal(ctrl(0).value, '', '收起就是退回默认，填进去的值不许留着');

  // 反过来的那一半：面板抬回来不再把它清一遍（那会把用户重新填的抹掉），
  //   而它本来就是收着的。
  ctrl(0).value = '6';
  push(true);
  assert.equal(body().classList.contains('hidden'), true, '回来时仍然是收着的');
  assert.equal(ctrl(0).value, '6', '抬回面板那一次不该再清一遍 —— 那一格是用户刚填的');
});

test('提交成功之后当场收起高级选项（那几格只对下一次「开始会话」有效）', async () => {
  // 2026-10-30 用户：点完「开始会话」，那几格还开着、填进去的值还在。留着不收的话，
  //   用户从会话页面点「面板」回来，看到的是几格"看起来还要被发出去"的设置 ——
  //   而它们其实已经用掉了。
  const view = JSON.parse(JSON.stringify(PV));
  view.plugins[0].surface = true;
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'window.slurmate.start = () => Promise.resolve({ ok: true, slot: 1,'
    + ' sessions: [], front: null });');
  h.fn('renderPlugins')(view);
  const block = () => h.byId.get('plugin-blocks').children[0];
  const find = (b, cls) => childrenOf(b).find(
    (x) => (x.className || '').split(/\s+/).indexOf(cls) >= 0);
  const body = () => find(block(), 'adv-body');
  const ctrl = (i) => childrenOf(find(body(), 'row').children.filter((k) => k && k.tagName)[i])
    .find((x) => (x.tagName === 'INPUT' || x.tagName === 'SELECT') && x.type !== 'range');

  find(block(), 'adv-toggle').onclick();
  ctrl(0).value = '8';
  assert.equal(body().classList.contains('hidden'), false, '（前提：点开了、也填了）');

  await h.fn('startWith')('cs', h.run('advCells[0]'), h.doc.getElementById('start-btn'));

  assert.equal(body().classList.contains('hidden'), true, '交出去之后要收起来');
  assert.equal(ctrl(0).value, '', '收起就是退回默认');
});

test('分区下拉里那个「不点名」的选项按声明的能力分两种说法', () => {
  // 同一句话在两版服务端上是两件事：0.37 起，不点名 = 把候选整列交给 Slurm；
  //   老守护进程那边是它自己从有权限的里挑一个。客户端不拿版本号猜
  //   （`0.y` 期间那条比较连拦都不拦），按 `caps` 声明说。
  // 这一条同时是那条声明唯一的消费者：没有它，`caps` 就是一段没人读的字节。
  const view = JSON.parse(JSON.stringify(PV));
  view.plugins[0].defaults = { cpus: 2, mem: '8G', time: '12:00:00',
    gpus: { name: 'gpu', type: null, count: 1 } };
  const parts = [{ name: 'normal', allowed: true, mem_per_node_mb: 128000,
    cpus_per_node: 64, gres: [{ name: 'gpu', type: null, per_node_max: 8, total: 8 }] }];
  const firstOption = (h) => {
    const block = h.byId.get('plugin-blocks').children[0];
    const find = (b, cls) => childrenOf(b).find(
      (x) => String(x.className || '').split(/\s+/).indexOf(cls) >= 0);
    const row = find(find(block, 'adv-body'), 'row');
    const cell = row.children.filter((k) => k && k.tagName)[4];
    const sel = childrenOf(cell).find((x) => x.tagName === 'SELECT');
    return sel.children[0];
  };

  const h1 = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES }, 'daemonCaps = ["submit.any_partition"];');
  h1.fn('renderPlugins')(view);
  h1.fn('renderPartitions')(parts);
  assert.equal(firstOption(h1).textContent, '（不点名，由 Slurm 在有权限的里选择）',
    '对面声明了 submit.any_partition：不点名就是把那一列交给 Slurm 选择');

  const h2 = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES }, 'daemonCaps = null;');
  h2.fn('renderPlugins')(view);
  h2.fn('renderPartitions')(parts);
  assert.equal(firstOption(h2).textContent, '（不点名，由站点的守护进程选择）',
    '对面没声明（老守护进程）：它自己选择，而不是 Slurm');
});

test('共用的那张表：先弹框问「一起改还是分一张自己的」，选完才带 scope 重发', async () => {
  // 主进程第一发回 `shared`（这张表还有别的连接在用）。界面不许替用户选一个：
  // 选错的那一个会让另外几条连接跟着一起变，而它们各自的界面上什么都没发生 ——
  // 用户要到下一次开会话时才发现自己动了别人的数据。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES },
  'window.__calls = [];'
  + 'window.__replies = ['
  + '  { ok: false, code: "shared", workspaceName: "工作区 1", others: ["c2"] },'
  + '  { ok: true, droppedOld: false, forked: "工作区 3" }'
  + '];'
  + 'window.slurmate.setWorkspaceRef = (p) => { window.__calls.push(p);'
  + ' return Promise.resolve(window.__replies.shift()); };');

  const raw = (i) => h.run(`window.__calls[${i}]`);
  const sent = (i) => JSON.parse(JSON.stringify(raw(i)));
  const body = () => h.byId.get('notices').children[0].children[1].textContent;

  const p = h.run('applyPluginSpace("w000000000001","p1","s000000000002")');
  await new Promise((r) => setImmediate(r));       // 让第一发走完，框弹出来

  const dlg = h.byId.get('fork-dlg');
  assert.equal(dlg.open, true, '共用的一张表必须先问 —— 替用户选一个就是把别人改了');
  // 名字由界面取（同一条 `connLabel` 规则），主进程只回 id ——
  //   两处各拼一遍备注/地址的回落规则迟早会漂开。
  assert.match(h.byId.get('fork-body').textContent, /bob@198\.51\.100\.9:10100/,
    '要说得出"还有谁在用" —— 只说"还有 1 条连接"等于没说');
  assert.equal(raw(1), undefined, '还没选之前不许发第二发');
  assert.deepEqual(sent(0), { workspaceId: 'w000000000001', pluginId: 'p1',
    connectionId: 'c1', spaceId: 's000000000002' }, '第一发不带 scope');

  // ── 选「只改这条连接」，带 scope: 'fork' ──
  h.run('$("fork-one").onclick()');
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(dlg.open, false, '选完要把框关掉');
  assert.deepEqual(sent(1), { workspaceId: 'w000000000001', pluginId: 'p1',
    connectionId: 'c1', spaceId: 's000000000002', scope: 'fork' });
  // 分叉这件事要说出来，而且要说清"数据没复制" —— 否则用户会以为
  //   自己刚才复制了一份存储（那正是他不会轻易按的一个键）。
  assert.match(body(), /分了一张自己的表/);
  assert.match(body(), /数据还是同一份/);

  // ── 取消（含 Esc）：什么都不发，那一格由调用方拨回去 ──
  h.run('window.__replies = [{ ok: false, code: "shared", workspaceName: "工作区 1",'
    + ' others: ["c2"] }]; window.__calls.length = 0;');
  const q = h.run('applyPluginSpace("w000000000001","p1","s000000000002")');
  await new Promise((r2) => setImmediate(r2));
  assert.equal(h.byId.get('fork-dlg').open, true);
  h.run('$("fork-dlg").oncancel()');               // Esc 走的是 cancel 事件
  assert.equal((await q).ok, false);
  assert.equal(h.run('window.__calls.length'), 1, '取消之后不许再发一发');

  // ── 选「全部一起改」，scope: 'all'，而且第二问（would_discard）要把它带上 ──
  //   这一格是最容易漏的：`would_discard` 的重试如果只补 `confirmDiscard`、
  //     丢了 `scope`，请求会被 `shared` 再拦一次 —— 用户看到同一个框弹两遍，
  //     而"再选一次"的结果与上一次未必一样。
  h.run('window.__replies = ['
    + '  { ok: false, code: "shared", workspaceName: "工作区 1", others: ["c2"] },'
    + '  { ok: false, code: "would_discard", error: "换掉之后它会被删掉" },'
    + '  { ok: true, droppedOld: true, forked: null }'
    + ']; window.__calls.length = 0;');
  const s = h.run('applyPluginSpace("w000000000001","p1","s000000000002")');
  await new Promise((r3) => setImmediate(r3));
  h.run('$("fork-all").onclick()');
  assert.equal((await s).ok, true);
  assert.equal(raw(1).scope, 'all');
  assert.equal(raw(2).scope, 'all', '第二问的重试必须把 scope 一起带上');
  assert.equal(raw(2).confirmDiscard, true);
  assert.match(body(), /已经删掉/);
});

test('这个架子真的抓得住 P1 那个缺陷（拿一个故意的错来验）', () => {
  // 一条抓不住真缺陷的守卫等于没有守卫。这里把 P1 那个错误原样放回去：
  //   一个从未声明过的变量，出现在画第一屏的那条路上。
  const broken = SRC.replace('    li.append(t, m, main, edit, del);',
    '    li.append(t, m, lay, main, edit, del);');
  assert.notEqual(broken, SRC, '锚点没改到 —— 这条自检是假的，下面那句恒真');
  const h = boot(broken);
  h.run('boot = { connections: [], workspaces: [], activeConnectionId: null };');
  const conn = { id: 'c1', user: 'a', host: 'h.example', port: 22, workspaceId: 'w1' };
  assert.throws(() => h.fn('renderConnections')([conn]), /lay is not defined/,
    '架子没执行到那条路 —— 那一组守卫是假的');
});

/** 一个元素的所有后代（深度优先）。 */
function childrenOf(e) {
  const out = [];
  for (const k of e.children || []) {
    if (!k || typeof k !== 'object' || !k.tagName) continue;
    out.push(k, ...childrenOf(k));
  }
  return out;
}

test('作业结束之后失败原因不再消失（从前它恰好在那一刻被藏起来）', () => {
  // 这一条守的是一个"最该看见的时候看不见"的缺陷：`#kv`（含「作业状态」那一句，
  //    也就是 `jobstate.js` 译好的失败原因与退出码）从前的可见性判据是
  //    `st !== 'ended'` —— 而作业一结束会话就进 `ended` 原因当场消失。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.run("SCREEN = 'jobs';"
    + "SESS = { sessions: [{ slot: 'a', service: '编辑器', live: false, snap: null }],"
    + " front: 'a' };");
  h.fn('renderSnapshot')({
    state: 'ended', sessionId: 's1', jobId: '42',
    jobText: '被抢占（Slurm: PREEMPTED）', jobExitCode: '143:0',
    hbAgeMs: 1000, tunnelState: 'stopped', resources: {}, gresText: null,
  });
  assert.equal(h.byId.get('job-detail').classList.contains('hidden'), false,
    '结束之后那一格仍然要露 —— 失败原因正是在那一刻才要看');
  const kv = h.byId.get('kv');
  assert.match(kv._text || childrenOf(kv).map((x) => x._text).join(' '), /作业状态/,
    '而「作业状态」那一行要在里面');

  // 反过来的那一半：`idle`（还没有过任何会话）仍然不露 —— 那时没有任何东西可说。
  h.run("SESS = { sessions: [], front: null };");
  h.fn('renderSnapshot')(null);
  assert.equal(h.byId.get('job-detail').classList.contains('hidden'), true,
    '一会儿都没跑过的时候不该摆一个空的详情块');
});

test('分区还没定下来时写「待定」，并把交给 Slurm 的那几个念出来', () => {
  // 2026-10-30：缺省提交把几个候选一起交给 Slurm（`-p A,B`），落到哪个要等
  //   作业进队列才知道。那时干摆一个「—」与"查不到"长得一模一样，而
  //   `partitions` 就在手边 —— 说得出交给它的是哪几个。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.run("SCREEN = 'jobs'; SESS = { sessions: [], front: null };");
  const base = { state: 'queued', sessionId: 's1', jobId: '42',
    jobText: '等待调度', hbAgeMs: 1000, tunnelState: 'stopped',
    resources: {}, gresText: null };
  const kv = () => childrenOf(h.byId.get('kv')).map((x) => x._text || '').join(' ');

  h.fn('renderSnapshot')({ ...base, partition: null,
    partitions: ['A6000', 'RTX8000'] });
  assert.match(kv(), /待定（A6000 \/ RTX8000）/, kv());

  // 定下来之后就是那个名字，不再有「待定」—— 两个都在的话，界面在说
  //   "还没定，而它是 A6000"。
  h.fn('renderSnapshot')({ ...base, partition: 'A6000', partitions: null });
  assert.match(kv(), /A6000/, kv());
  assert.equal(/待定/.test(kv()), false, kv());
});

test('作业列表里点另一条：高亮与下面的详情都跟着走', () => {
  // 2026-10-17 真机：多条记录时点一条，选择（与「选中的那一条」那一块）
  //   不跟着变。这里钉两件事：高亮立刻换（不等那次 IPC），详情换成本行。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.run("SCREEN = 'jobs'; SESS = { sessions: [], front: null };"
    + "JOBS = { error: null, at: Date.now(), selected: 'sess-a', list: ["
    + "{ session_id: 'sess-a', state: 'released', state_text: '已结束', live: false,"
    + "  attached: false, job_id: '41', partition: 'A6000', node: 'n1',"
    + "  expires_at: 100, job_state: 'COMPLETED', job_text: '完成',"
    + "  resources: { cpus: 2, mem: '8G', gres: null }, gres_text: null },"
    + "{ session_id: 'sess-b', state: 'rejected', state_text: '已拒绝', live: false,"
    + "  attached: false, job_id: '42', partition: 'RTX8000', node: 'n2',"
    + "  expires_at: null, job_state: 'CANCELLED', job_text: '已结束（被取消）',"
    + "  resources: { cpus: 2, mem: '8G', gres: null }, gres_text: null }"
    + "] };");
  // 行的高亮走的是 `className` 字符串（`jobRow` 一次拼好），不是
  //   `classList` 那一组方法 —— 判据跟着它自己的写法走。
  const on = (el) => /\bon\b/.test(el.className);
  h.fn('renderJobs')();
  assert.equal(h.byId.get('job-list').children.length, 2, '两行都要画出来');
  assert.equal(on(h.byId.get('job-list').children[0]), true,
    '前提：一开始是第一行选中');

  h.byId.get('job-list').children[1].onclick();
  const after = h.byId.get('job-list');
  assert.equal(on(after.children[1]), true,
    '点了第二条，高亮要跟过去 —— 本地事实，不该等一次 IPC');
  assert.equal(on(after.children[0]), false);

  const kvText = childrenOf(h.byId.get('kv')).map((x) => x._text || '').join(' ');
  assert.match(kvText, /sess-b/, '下面的详情要跟着选中的那一条走');
  assert.match(kvText, /42/);
});

test('「刷新」连本机那几条会话的视图一起重取：下面那一块跟着变', async () => {
  // 2026-10-30 用户：作业那一屏的「刷新」只换了列表，选中那条的详情要再点一次
  //   「面板」才更新。
  // 根因：详情有一半来自本机的会话视图（隧道、本地地址、上次心跳只有本机有），
  //   而那一份只在状态真的变过时由主进程推过来 —— 只重问站点（`op:list`），
  //   详情读的仍是上一次推送的那一份。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'window.__jobCalls = 0; window.__stateCalls = 0;'
    + 'window.slurmate.jobs = () => { window.__jobCalls += 1;'
    + ' return Promise.resolve({ ok: true, at: 1, jobs: [{'
    + ' session_id: "sess-a", slot: "s1", job_id: "42", partition: "normal",'
    + ' node: "n1", live: true, attached: true, job_text: "完成" }] }); };'
    + 'window.slurmate.states = () => { window.__stateCalls += 1;'
    + ' return Promise.resolve({ front: "s1", panelFront: true, sessions: [{'
    + '  slot: "s1", service: "编辑器", live: true, snap: { state: "running",'
    + '   sessionId: "sess-a", jobId: "42", partition: "normal", node: "n1",'
    + '   jobText: "完成", hbAgeMs: 1000, tunnelState: "listening",'
    + '   resources: {}, gresText: null } }] }); };');
  h.run("SCREEN = 'jobs'; JOBS = { list: [{ session_id: 'sess-a', slot: 's1',"
    + " job_id: '42', partition: 'normal', node: 'n1', live: true, attached: true,"
    + " job_text: '运行中' }], at: 1, error: null, selected: 'sess-a' };"
    + "SESS = { sessions: [{ slot: 's1', service: '编辑器', live: true, snap: {"
    + " state: 'running', sessionId: 'sess-a', jobId: '42', partition: 'normal',"
    + " node: 'n1', jobText: '运行中', hbAgeMs: 90000, tunnelState: 'listening',"
    + " resources: {}, gresText: null } }], front: 's1', panelFront: true };");
  h.fn('renderJobs')();
  const kv = () => childrenOf(h.byId.get('kv')).map((x) => x._text || '').join(' ');

  await h.byId.get('btn-jobs-refresh').onclick();

  assert.equal(h.run('window.__jobCalls'), 1, '（前提：问了一次站点）');
  assert.equal(h.run('window.__stateCalls'), 1,
    '本机会话的视图也要重取一次 —— 详情那一块读的是它');
  assert.match(kv(), /完成/, '详情要跟着换成新的那一条（作业状态）');
  assert.equal(/运行中/.test(kv()), false, '上一次推送的那一份不许留在下面');
});

test('作业列表那一屏的「结束」也走两段式：点错一次就是一条跑到一半的作业没了', async () => {
  // 2026-10-25 用户：这一颗从前点一下就结束。它旁边紧挨着「重新加载」与
  //   「接管」，而它长得没什么特别 —— 代价是集群上那条作业被取消。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'window.__stops = []; window.slurmate.stop = (slot) => {'
    + ' window.__stops.push(slot); return Promise.resolve({ ok: true }); };'
    + 'window.slurmate.jobs = () => Promise.resolve({ ok: true, jobs: [], at: 1 });'
    // 结束之后那一趟重取也会重取本机的会话视图（见 `refreshJobs`）。
    + 'window.slurmate.states = () =>'
    + ' Promise.resolve({ sessions: [], front: null, panelFront: true });');
  h.run("document.body.append($('btn-jobs-end'));");
  const btn = h.byId.get('btn-jobs-end');
  const rows = [{ session_id: 'sess-a', slot: 's1', live: true, attached: true,
                  job_id: '11' }];
  h.run(`SCREEN = 'jobs'; JOBS = ${JSON.stringify({
    list: rows, at: 1, error: null, selected: 'sess-a',
  })};`);
  h.fn('renderJobsSelection')();

  // ── 第一段 ──
  btn.onclick();
  assert.equal(h.run('window.__stops.length'), 0, '第一次不许结束 —— 它是第一段');
  const p = btn.parentNode;
  const cluster = p.children[p.children.indexOf(btn) + 1];
  assert.ok(cluster && cluster.className === 'armed', '那一行确认要插在按钮后面');
  assert.match(cluster.children[0]._text, /作业会被取消/, '后果要说出来');

  // ── 第二段 ──
  await cluster.children[1].onclick();
  assert.equal(JSON.stringify(h.run('window.__stops')), '["s1"]',
    '第二段才结束，而且停的是选中的那一条');
});

test('作业结束的那一刻那一句进提示流，而且好坏按退出码分', () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  const notices = () => h.byId.get('notices').children.map(
    (n) => (n.children || []).map((c) => c._text).join(' '));
  h.run("SCREEN = 'jobs';"
    + "SESS = { sessions: [{ slot: 'a', live: false, snap: null }], front: 'a' };");

  const ended = (slot, ec) => h.fn('renderSnapshot')({
    state: 'ended', sessionId: 's1', jobId: '42', jobText: `结束了（退出码 ${ec}）`,
    jobExitCode: ec, hbAgeMs: 0, tunnelState: 'stopped', resources: {},
  });

  ended('a', '143:0');
  const after1 = notices();
  assert.match(after1[0] || '', /结束了/);
  assert.match(after1[0] || '', /错误/, '非零退出码，那一档是「错误」，不是一句平静的信息');
  assert.equal(after1.length, 1);

  // 同一份快照再来一次（推送会反复来）不许再报一遍 —— 判据是"上一轮还不是
  //   终态"，不是"状态是 ended"；后者会在每一次推送时都重复一遍。
  ended('a', '143:0');
  assert.equal(notices().length, 1, '同一件事只说一次');

  // 而干净收尾是 info 那一档
  h.run("SESS = { sessions: [{ slot: 'b', live: false, snap: null }], front: 'b' };");
  ended('b', '0:0');
  const n0 = notices()[0] || '';
  assert.match(n0, /0:0/);
  assert.equal(/错误/.test(n0), false, '`0:0` 是干净收尾 —— 报成错误会让用户去查一个不存在的问题');
});

test('没见过的提示档按「信息」画，不把那个词塞进 className', () => {
  // `kind` 从主进程那条通道来，而那条通道没有类型。它直接拼进 className 的话，
  //   一个没见过的值就是一个没有定义的类 —— 那句提示既没有颜色也没有图标，
  //   现场看起来像"样式坏了"（账本 S31 T1）。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.fn('notice')('evil', '一句话');
  const last = h.byId.get('notices').children[0];
  assert.equal(last.className, 'notice info',
    '未知那一档要落到「信息」，而不是原样拼进类名');
  const tag = (last.children || [])[0];
  assert.equal(tag._text, '信息', '标签也要是那一档的名字，不是一个没人认识的字');
});

test('「查看日志」按需取一次：三态各不相同，空的那一块不出现', async () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.run("SCREEN = 'jobs';"
    + "SESS = { sessions: [{ slot: 'a', live: false, snap: { sessionId: 's1' } }], front: 'a' };");
  const shown = () => {
    const b = h.byId.get('joblog-body');
    return [b._text].concat(childrenOf(b).map((x) => x._text)).join(' | ');
  };

  // ① 两份都有；`.err` 是 `null` 那一块不出现（设计律 1：空框在说"本该有东西"）
  h.run('window.slurmate.jobLog = async () => ({ ok: true, data: {'
    + " out: { path: '/h/.slurmate/logs/slurm-1.out', bytes: 40000, lines: 200,"
    + " truncated: true, mtime: 1, text: '宿主的一行\\n服务的一行', why: null },"
    + ' err: null } });');
  await h.run('loadJobLog()');
  assert.match(shown(), /标准输出/);
  assert.match(shown(), /服务的一行/);
  assert.match(shown(), /这是尾部/, '拿不全的时候必须说出来 —— 若不说用户会以为那就是全部');
  assert.equal(/标准错误/.test(shown()), false, '`.err` 是 null，那一块不出现');

  // ② 「获取失败」与「确实没有」长得不一样（并成一句的话，一个模式不对的日志
  //    会被读成"这台站点上没有日志"）
  h.run('window.slurmate.jobLog = async () => ({ ok: true, data: {'
    + " out: { path: '/h/a.out', bytes: null, lines: null, truncated: null,"
    + " mtime: null, text: null, why: 'component_group_or_world_writable' },"
    + ' err: null } });');
  await h.run('loadJobLog()');
  assert.match(shown(), /获取失败：component_group_or_world_writable/);
  assert.match(shown(), /\/h\/a\.out/, '路径要给出来（可复制）');

  // ③ 两份都没有，一句"还没有写出任何内容"，而不是一个空框
  h.run("window.slurmate.jobLog = async () => ({ ok: true, data: { out: null, err: null } });");
  await h.run('loadJobLog()');
  assert.match(shown(), /还没有输出任何内容/);

  // ④ 整条 op 失败（老守护进程没有这个能力），如实说，不画空框
  h.run("window.slurmate.jobLog = async () => ({ ok: false, unsupported: true,"
    + " error: '这个站点的守护进程版本过低，不支持插件分发。' });");
  await h.run('loadJobLog()');
  assert.match(shown(), /这个站点的守护进程版本过低/);
});

test('日志跟着选中的那一条走：切换作业时重取，没打开过就不取', async () => {
  // 2026-10-25 用户：在作业列表里换一条，下面那块日志还是上一条的 ——
  //   高亮着 B、摆着 A 的输出，而它看起来就像"B 的日志"。
  const rows = [
    { session_id: 'sess-a', slot: 's1', live: true, attached: true, job_id: '41' },
    { session_id: 'sess-b', slot: 's2', live: true, attached: true, job_id: '42' },
  ];
  const open = (extra) => {
    const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
      extra);
    h.run("SCREEN = 'jobs'; SESS = { sessions: [], front: null };"
      + "window.__asked = [];"
      + "window.slurmate.jobLog = (a) => { window.__asked.push(a.session_id);"
      + " return Promise.resolve({ ok: true, data: { out: null, err: null } }); };"
      + `JOBS = ${JSON.stringify({ error: null, at: Date.now(), selected: 'sess-a',
                                   list: rows })};`);
    h.fn('renderJobs')();
    return h;
  };
  const asked = (h) => JSON.parse(JSON.stringify(h.run('window.__asked')));

  // ── 没打开过：切换不该顺手取一次（那是一次真的 RPC）──
  const idle = open('');
  idle.byId.get('job-list').children[1].onclick();
  await idle.run('new Promise((r) => setTimeout(r, 0))');
  assert.deepEqual(asked(idle), [], '日志没开着，切换作业不该发起任何请求');

  // ── 开着：跟着选中的那一条重取 ──
  const h = open('');
  await h.run('loadJobLog()');
  assert.deepEqual(asked(h), ['sess-a'], '先取的是选中的那一条');
  h.byId.get('job-list').children[1].onclick();
  await h.run('new Promise((r) => setTimeout(r, 0))');
  assert.deepEqual(asked(h), ['sess-a', 'sess-b'],
    '切到哪一条，日志就该重取哪一条 —— 不是把上一条留着');
});

test('「获取失败」的三种情况，三句不同，各有各的出路', () => {
  // 2026-10-14 加。那三态从前被合成一个布尔（`missing[].distributed`），于是
  //   界面只有一句话可说，而它对其中两种是错的：`package: null`（站点此刻生产
  //   不出来）不是「站点的清单里没有它的包」。用户照着那句话去做，会去问管理员
  //   一件管理员改不了的事 —— 而他要做的其实是再同步一次。
  // 正文是文本节点（`createTextNode`），不是元素 —— 人造 DOM 里它只有
  //   `textContent` 而没有 `_text`，所以两样都要读。
  const textOf = (el) => (el ? (el._text || el.textContent || '')
    + (el.children || []).map(textOf).join('') : '');
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES });
  const one = (delivery, title) => ({ name: title, title, id: 'x' + delivery,
    version: '1.0.0', enabled: true, delivery });

  h.fn('renderPlugins')({ ...PV, missing: [
    one('absent', '甲'), one('not_ready', '乙'), one('unusable', '丙'),
  ] });
  const text = textOf(h.byId.get('plugin-issues'));

  assert.match(text, /本站没有分发它/, '键根本不出现，出路是问管理员');
  assert.match(text, /现在发不出来/, '`null`，出路是再同步一次');
  assert.match(text, /读不懂/, '读不懂，出路是升级客户端');
  assert.equal(/清单里没有它的包/.test(text), false,
    '那句是"缺席"那一态，拿它来说 `null` 就是说了一件不成立的事');

  // 而"站点愿意发、本机还没取回来"那一种仍然走上面那条（`package`）。
  h.fn('renderPlugins')({ ...PV, missing: [one('package', '丁')] });
  const text2 = textOf(h.byId.get('plugin-issues'));
  assert.match(text2, /丁/, '愿意发的那一条仍然要说出来（本机还没有它）');
  assert.equal(/本站没有分发它/.test(text2), false, '它不属于"获取失败"那一类');
});

test('没加载上的那些收在一个能展开的框里：抬头一直在，点开看是哪几个', () => {
  // 用户 2026-10-16：未能加载的"应该给个列表或者什么方式显示出来，但可以藏一下，
  //   不要太明显，但不应该完全不显示"。
  // 两句都要判：抬头在（少了它就是完全不显示），条文在框里面（少了它还是没收）。
  const textOf = (el) => (el ? (el._text || el.textContent || '')
    + (el.children || []).map(textOf).join('') : '');
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES });
  h.fn('renderPlugins')({ ...PV,
    errors: ['C:\\pool\\a.splug：这个包的清单不是合法的 JSON'],
    problems: ['/srv/plugins/b.splug：它与池里那份撞了 id'] });

  const folds = childrenOf(h.byId.get('plugin-issues'))
    .filter((x) => x.tagName === 'DETAILS');
  assert.equal(folds.length, 2, '两组各收一个框');
  const headOf = (d) => childrenOf(d).find((x) => x.tagName === 'SUMMARY').textContent;
  assert.deepEqual(folds.map(headOf),
    ['插件没有加载', '插件有问题（已跳过，其余插件照常工作）'],
    '抬头就是原来那两句，一个字不改（它们与守护进程逐字相同，见 renderer.test.mjs）');
  const bodyOf = (d) => childrenOf(d).find((x) => x.className === 'issue-body');
  assert.match(textOf(bodyOf(folds[0])), /a\.splug：这个包的清单不是合法的 JSON/,
    '原样报下来的那一句进框里，含它自己的路径 —— 界面不改写');
  assert.match(textOf(bodyOf(folds[1])), /b\.splug：它与池里那份撞了 id/);
  assert.equal(folds.some((d) => d.open), false,
    '默认收着：它不阻塞任何操作，而一字排开摆在插件列表头上像"这个客户端坏了"');
});

test('【接管】只在看护者不是本机时可用 —— 它也是把会话接回来的入口', () => {
  // 2026-10-20 起：看护者为空时心跳不再自动认领，接管是唯一把控制权拿回本机的
  //   入口。于是两种场合都要亮：另一台电脑在看，以及没人在看。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  const row = (over) => ({
    session_id: 'sess-a', slot: 's1', live: true, attached: false,
    job_id: '11', keeper: 'other', keeper_is_me: false, ...over,
  });
  const draw = (r) => {
    h.run(`SCREEN = 'jobs'; JOBS = ${JSON.stringify({
      list: [r], at: 1, error: null, selected: 'sess-a',
    })};`);
    h.fn('renderJobsSelection')();
  };

  // ① 本机还没接着它、而看护者是别人 —— 接管可用，而且它会把会话接回来。
  draw(row({ attached: false, keeper: 'other' }));
  // 按钮是 `renderJobsSelection` 第一次 `$()` 时才被建出来的（人造 DOM 按需建）。
  const btn = h.byId.get('btn-jobs-takeover');
  assert.equal(btn.disabled, false, '没接着的会话，接管就是把它接回来的入口');
  assert.match(btn.title, /并把它接回来/);

  // ② 没人在看 —— 心跳不再自动认领，接管同样可用。
  draw(row({ keeper: null }));
  assert.equal(btn.disabled, false, '看护者为空时接管是唯一当家的入口');
  assert.match(btn.title, /看护者换成这台电脑/);

  // ③ 本机在看它 —— 空动作。
  draw(row({ keeper: 'me', keeper_is_me: true, attached: true }));
  assert.equal(btn.disabled, true);
  assert.match(btn.title, /已经在看它了/);

  // ④ 另一台电脑在看、而本机已经接着它 —— 仍然可用。
  draw(row({ keeper: 'other', attached: true }));
  assert.equal(btn.disabled, false, '另一台电脑正看着它时，接管才是要做的事');
  assert.match(btn.title, /看护者换成这台电脑/);
});

test('切标签：推送里的 panelFront 当场决定状态条右侧那两颗在不在', () => {
  // 用户 2026-10-18：从会话页面点「面板」回来，上栏那两颗不跟着变；
  //   再从插件页点回会话标签，也不变。它们的显隐跟着"页面在不在眼前"走，
  //   而那个事实随每一份会话状态推送（`panelFront`）一起到。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.run("lastPlugins = { plugins: [{ name: 'web-demo', surface: { kind: 'web', path: '/' } }] };"
    + "SCREEN = 'plugins';");
  const push = (panelFront) => h.fn('renderSessions')({
    sessions: [{ slot: 's1', live: true, snap: { state: 'running', slot: 's1',
      serviceKind: 'web-demo', sessionId: 'sess-a' } }],
    front: 's1', panelFront,
  });
  const btn = () => h.byId.get('sb-end');
  const reload = () => h.byId.get('sb-reload');

  push(false);
  assert.equal(btn().classList.contains('hidden'), false, '会话页面在眼前：结束会话在');
  assert.equal(reload().classList.contains('hidden'), false, '会话页面在眼前：重新加载在');

  push(true);
  assert.equal(btn().classList.contains('hidden'), true, '面板抬起来：结束会话收掉');
  assert.equal(reload().classList.contains('hidden'), true, '面板抬起来：重新加载收掉');

  push(false);
  assert.equal(btn().classList.contains('hidden'), false, '切回会话标签：两颗回来');
  assert.equal(reload().classList.contains('hidden'), false);
});

test('作业那一页点一条正在跑的作业：只换选中，不把页面切过去', () => {
  // 用户 2026-10-18：在作业页点一条正在跑的作业会直接跳进它的页面 ——
  //   那一跳之后上栏的按钮就没机会点了。这一页的选中只该让高亮与下面的详情
  //   跟过去；切页面只在上栏的标签上做。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'window.__front = null; window.slurmate.setFront = (s) => { window.__front = s; };');
  h.run("SCREEN = 'jobs'; SESS = { sessions: [{ slot: 's1', live: true,"
    + " snap: { state: 'running', sessionId: 'sess-a', slot: 's1', jobId: '11' } }],"
    + " front: 's1', panelFront: true };");
  h.run(`JOBS = ${JSON.stringify({
    list: [{ session_id: 'sess-a', slot: 's1', live: true, attached: true, job_id: '11',
             state: 'enrolled', state_text: '运行中', partition: 'A6000',
             resources: { cpus: 2, mem: '8G' }, keeper_text: '本机在看', keeper_is_me: true }],
    at: 1, error: null, selected: null,
  })};`);
  h.fn('renderJobs')();

  h.byId.get('job-list').children[0].onclick();
  assert.equal(h.run('JOBS.selected'), 'sess-a', '选中要换过去');
  assert.equal(h.run('window.__front'), null,
    '选中不许调 setFront —— 页面只从上栏的标签切');
  const kv = childrenOf(h.byId.get('kv')).map((x) => x._text || '').join(' ');
  assert.match(kv, /11/, '下面的详情要跟着选中的那一条');
});

test('重连之后：会话表从主进程取一次，标签栏不会空着', async () => {
  // 真机（2026-10-18）：临时离开再连上，界面直接进了 web-demo 的页面，
  //   而上栏没有标签、也没有「面板」—— 过一会又出现。那是界面在 `connect`
  //   返回之后把会话表清空了：主进程接回来的那几条被这一清从界面上删掉，
  //   下一次推送（心跳）才补回来。现在连上之后直接拉一次权威的会话表。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'window.slurmate.states = () => Promise.resolve({'
    + ' sessions: [{ slot: "a", service: "编辑器", live: true,'
    + '   snap: { serviceKind: "cs", state: "running", localPort: 18080 } }],'
    + ' front: "a", panelFront: false });'
    + 'lastPlugins = { plugins: [{ id: "p1", name: "cs", title: "编辑器",'
    + ' surface: { path: "/" } }] };'
    + 'connected = false;');
  await h.fn('handleConnectResult')({
    ok: true, whoami: { user: 'alice', account: 'acct' }, partitions: [],
  });
  assert.equal(h.run('SESS.sessions.length'), 1,
    '接回来的会话要在界面上 —— 若清空，标签栏与「面板」会一起没');
  assert.equal(h.byId.get('session-tabs').classList.contains('hidden'), false,
    '标签栏要露出来，那颗「面板」才有地方点');
});
