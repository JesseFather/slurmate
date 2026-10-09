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
 * renderer-dom.test.mjs —— **真的把 panel.js 跑起来**，在一个人造 DOM 上。
 *
 * ── 为什么还需要这一组（renderer.test.mjs 已经在查了）────────────────────────
 *
 * 那一组是**文本比对**：id 对不对得上、有没有内联 style、四句话重没重。它拦不住
 * 一类错误：**函数体里引用了一个不存在的变量**。
 *
 * 这不是假想的。P1 那次改名（`layout` → `workspace`）把连接行那个下拉的变量从
 * `lay` 改成了 `pick`，**漏掉两处引用**。后果是 `renderConnections` 一进循环就抛
 * `ReferenceError: lay is not defined` —— 而它是画**第一屏**的函数：用户打开客户端
 * 看到的是一块白板。全套 560 条用例**一条都没红**：本机起不了 Electron，
 * 而那批文本判据读的是**源码文本**，它不会执行任何一个函数。
 *
 * 所以这一组的判据只有一句话：**那几个 render 函数跑得起来，而且画出了该画的东西。**
 * 它不需要浏览器，只要一个人造 DOM（见下面 `fakeDom`）。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────────
 *
 *   · 它**不判**界面好不好用（那只能人工跑一遍），只判"不白屏"与"画出来了"。
 *   · `init()` 那一行被摘掉再求值：它要的是整个启动序列（桥、后端、状态机），
 *     而这一组要的是那几个 render 函数。摘掉之后**必须**断言真的摘掉了 ——
 *     摘不掉的话整份文件会在 `init()` 里炸，而那看起来也像"跑过了"。
 *   · 文件末尾那条自检（拿一个故意的 `ReferenceError` 验架子）是这一组的**前提**：
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
 * ★★ **必须一起载进来**，而且顺序在前：`panel.html` 就是这么排的（见那里那段
 *    注释），而这位置一旦反了 `panel.js` 一进来就 ReferenceError。
 *    ★ 少了它，"面板上某一块真的画出来了"这类断言会在一个**空壳**上通过 ——
 *      因为用到它的那几条路径一进去就抛，而 harness 把它们咽在 Promise 里了。
 */
const DOM_SRC = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'dom.js'), 'utf8');

/** 摘掉最后那一行 `init().catch(...)`。 */
function withoutInit(src) {
  const out = src.replace(/^init\(\)\.catch\([\s\S]*$/m, '');
  assert.notEqual(out, src, '没摘到 init() —— panel.js 末尾那一行的形状变了，'
    + '这一组会在启动序列里炸，而"炸了"与"跑过了"在这里长得一样');
  assert.equal(/\ninit\(\)/.test(out), false, '还有第二处 init() 调用');
  return out;
}

// ── 人造 DOM ────────────────────────────────────────────────────────────────
//
// 刻意做得很浅：每个元素只记下几个这一组真会读的属性（className / textContent /
// children / value），其余一律是能收能放的字段。**不做**松散代理 —— 代理会把
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
    // ★ `parentNode` / `insertBefore` / `nextSibling` / `contains` / `focus` 是被
    //   **两段式确认**（panel.js 的 `armConfirm`）拉进来的：它要把那一行确认插到
    //   那颗按钮**后面**，并把按钮自己留在 DOM 里（只加一个 class 不显示）。
    //   没有这几样的话，那一段代码一进去就 TypeError —— 而"炸了"与"守住了"
    //   在这一组眼里必须分得开。
    adopt(k) {
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
    // ★ 元素级的监听。**两条边栏**（`rail-left` / `rail-right`）的 `mouseenter`
    //   走的是这一对 —— `bindEvents()` 一跑就要用它，缺了就是一次 TypeError，
    //   而那看起来像"这一组用例本身坏了"，与"守住了"分不开。
    //   ★ 与 `doc._ls`（文档级那两条）分开记：它们是两码事，混在一起数不清。
    _ls: [],
    addEventListener(t, f) { e._ls.push([t, f]); },
    removeEventListener(t, f) {
      const i = e._ls.findIndex((x) => x[0] === t && x[1] === f);
      if (i >= 0) e._ls.splice(i, 1);
    },
    // ★ **真的**从父节点摘掉自己。壳里它是空的（`remove() {}`），而两段式确认
    //   靠"这一行还在不在"判可退 —— 摘不掉的壳会让"收起"这件事**测不出来**。
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
    querySelectorAll() { return []; },
    // 给一个**非零**的矩形：这样 drawWorkspaceLines 那条路真的会走完
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
    get() { return e._text; },
    set(v) {
      e._text = String(v);
      // ★ 被清掉的那些孩子要**脱离文档**（`parentNode` 归零）—— 两段式确认收
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
    // ★ 两段式确认在**捕获阶段**挂一个"点到别处就收起"的监听（见 armConfirm）。
    //   壳里这两条只记账：本机没有事件循环，而"点别处收起"那件事由那条**真实的
    //   几何判据**在真机上守，这里要守的是"挂上了、也摘掉了"。
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
/** 两份数据，**各归一个工作区**。`refs` 是那张引用表（`插件 id → 数据 id`）。 */
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
    // 不要数据空间的那一种：它**没有**「用哪一份数据」这一格。
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
 * 把 `bindEvents()` 在假环境里**真的跑一遍** —— 它就是真机上启动的第一件事。
 *
 * ★ 这一组从前只测得到"某个 render 函数画出了什么"。而"点下去走的是哪条路"
 *   落在**绑定**上，绑定在 `bindEvents()` 里 ⇒ 不跑它就一个都测不到。
 *
 * ★★ 它同时是那条缺陷的守卫：绑定从前排在 `init()` 那几个 `await` 的**后面**，
 *   一次 reject 就让整块都不执行。这里从"跑不跑得完"那一侧判 —— 跑得完，
 *   那几格就有动作（见下面那条"bootstrap 挂了"的用例）。
 *
 * 那几样是壳里没有、而 `bindEvents` 会碰的运行期接口（真机上由 preload 提供）。
 */
function bindAll(bootObj, extra = '') {
  const h = start(bootObj, extra);
  h.run('window.addEventListener = () => {};'
    + 'window.slurmate.onSite = () => {}; window.slurmate.onStates = () => {};'
    + 'window.slurmate.onNotice = () => {}; window.slurmate.onPlugins = () => {};');
  h.fn('bindEvents')();
  return h;
}

test('★★ 第一屏画得出来（这一条就是 P1 那个白屏缺陷的守卫）', () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  // 从前这里抛 `ReferenceError: lay is not defined`，而它是画**第一屏**的函数：
  // 用户打开客户端看到的是一块白板，560 条用例一条都不红。
  assert.doesNotThrow(() => h.fn('renderConnections')(CONNS),
    'renderConnections 抛了 —— 第一屏会是一块白板');

  const rows = h.byId.get('conn-list').children;
  assert.equal(rows.length, 2, '两条连接就该画两行');
  // ★ 而**每一行里都不该再有一个下拉**：那个「这条连接用哪个工作区」搬进了
  //   连接表单（「③ 工作区」）。它留下的是一类缺陷（一个改了名却没改全的变量），
  //   而这一条把它钉在"画出来的东西"上 —— 不是钉在源码文本上。
  for (const r of rows) {
    assert.equal(childrenOf(r).some((x) => x.tagName === 'SELECT'), false,
      '连接行里不该再有下拉（工作区那一格在连接表单里）');
  }
});

test('★★ 两段式确认：第一下只是把那一格换成一行确认，第二下才真的做', () => {
  // ★★ 这一条守的是**设计律 2**：代价大的动作由"必须先经过的那一步"承载。
  //   第一段可退（点到别处、按 Esc、「取消」都回到原样），第二段才不可逆 ——
  //   而 `window.confirm` 给不了两段：框弹出来的时候用户**已经按下去**了。
  //
  // ★ 四条判据，缺一条这条规矩就不成立：
  //   · 第一下**一个请求都不发**（"点了就发"= 没有第二段）；
  //   · 那一行里要**说出后果**（只说"确定吗"，用户答不了）；
  //   · 第二下才发，而且**恰好一次**；
  //   · 原来那颗按钮**还在 DOM 里**（只加一个 class 不显示）—— 删掉它的话，
  //     `renderSnapshot` 下一次按 `running` 去 toggle 它的 `hidden` 就作用在 null 上。
  //
  // ★★ 载体是状态条上的「结束会话」（`#sb-end`）：留下的四处两段式里，它是唯一
  //   一颗**固定在 HTML 里**的按钮 —— 另外三处（断开也固定，但切走工作区的第一段
  //   挂在运行期画的那个下拉上、插件数据那颗按钮也是运行期画的）驱动起来都要先
  //   把一整块画出来。机制是同一份（`armConfirm`），所以拿它当代表最省事也最直接。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'SESS = { sessions: [{ slot: "s1", live: true }], front: "s1" };'
    + 'window.__calls = [];'
    + 'window.slurmate.stop = (slot) => { window.__calls.push(slot);'
    + ' return Promise.resolve({ ok: true }); };');
  // ★ 那一行确认是 `insertBefore(cluster, anchor.nextSibling)` 插进去的 ⇒ 锚点
  //   得**真的在文档里**才看得见它。壳里 `$()` 现造的元素没有父节点。
  h.run("document.body.append($('sb-end'));");
  const end = h.byId.get('sb-end');

  const clusterOf = () => {
    const p = end.parentNode;
    return p.children[p.children.indexOf(end) + 1];
  };

  // ── 第一段 ──
  end.onclick();
  assert.equal(h.run('window.__calls.length'), 0,
    '★★ 第一下**不许**发 —— 它是第一段，只把那一格换成一行确认');
  assert.notEqual(h.run('armed'), null, '第一段要挂在 armed 上（否则没有任何东西收得掉它）');
  assert.equal(end.classList.contains('armed-off'), true,
    '★ 原来那颗按钮留在 DOM 里、只是不显示');
  const cluster = clusterOf();
  assert.ok(cluster, '那一行确认要插在锚点后面');
  assert.equal(cluster.className, 'armed');
  const why = cluster.children[0]._text;
  assert.match(why, /作业会被取消/, '后果要说出来 —— 只说"确定吗"，用户答不了');
  // ★ 条数那一格（`liveCount()`）长在「断开」那一行上（它一次结束好几条），
  //   而这条挂的是「结束这一条会话」—— 判据在那一条用例里。
  assert.match(h.run("$('sb-end').onclick.toString()"), /armConfirm/,
    '★ 状态条那颗「结束会话」走的是两段式（不是直接 endFrontSession）');

  // ★ 那一行里两颗按钮**必须长得不一样**：一颗是不可逆的第二段（danger），
  //   一颗是回到原样（ghost）。画成一样的，用户分不清自己按下去的是哪个 ——
  //   而这一整条规矩（不可逆的动作要有"必须先经过的那一步"）要成立，靠的正是
  //   "第二段看得出来是第二段"。
  assert.match(cluster.children[1].className, /danger/,
    '★ 第二段那颗按钮要是 danger —— 它才是不可逆的那一下');
  assert.match(cluster.children[2].className, /ghost/,
    '而「取消」是 ghost：它与第二段不是同一类动作');

  // ── 取消：一行收掉，回到原样，一个字节都没发 ──
  cluster.children[2].onclick();
  assert.equal(h.run('armed'), null, '取消之后不该还挂着一个第一段');
  assert.equal(end.classList.contains('armed-off'), false, '取消之后那颗按钮要回来');
  assert.equal(end.parentNode.children.includes(cluster), false, '那一行要从 DOM 里摘掉');
  assert.equal(h.run('window.__calls.length'), 0, '取消 = 什么都没发生');
  assert.equal(h.run('document._ls.length'), 0,
    '★ 那两个"点别处 / 按 Esc"的监听也要一起摘掉 —— 每点一次多挂一个，它们会越攒越多');

  // ── 第二段 ──
  end.onclick();
  const p = clusterOf().children[1].onclick();
  assert.equal(h.run('armed'), null, '执行的那一下要先把这一行收掉');
  assert.equal(h.run('document._ls.length'), 0);
  return p.then(() => {
    assert.deepEqual(h.run('JSON.parse(JSON.stringify(window.__calls))'), ['s1'],
      '★ 第二下才发，而且恰好一次（发的正是**前台那一条**的槽）');
    assert.equal(h.run('document._ls.length'), 0);
  });
});

test('★★ 第一段退回去时，`onDisarm` 要把那一格拨回原样（切走工作区靠它）', () => {
  // ★★ 「切走工作区」的第一段挂在一个**下拉**上，而那个下拉停在用户刚选的
  //   "待定"的新值上 —— 那不是已发生的事。退回去（取消 / 点别处 / Esc / 被重画
  //   收掉）时如果不把它拨回旧值，界面就在说一件没发生的事。
  //   ⇒ 这正是 `armConfirm` 那个 `onDisarm` 存在的唯一理由。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.run("document.body.append($('sb-end'));");
  h.run('window.__revert = () => { window.__revN = (window.__revN || 0) + 1; };');
  h.fn('armConfirm')(h.byId.get('sb-end'), {
    why: '后果', yes: '切走', run: () => {}, onDisarm: h.run('window.__revert'),
  });
  h.run('window.__revN = 0;');
  h.run('armed.disarm()');
  assert.equal(h.run('window.__revN'), 1, '★ 退回去要调 `onDisarm`');

  // ★ 而**第二段执行时不许调** —— 那一格已经被改动了，"拨回旧值"会让界面
  //   说一件没发生的事。
  h.fn('armConfirm')(h.byId.get('sb-end'), {
    why: '后果', yes: '切走', run: () => {}, onDisarm: h.run('window.__revert'),
  });
  h.run('window.__revN = 0;');
  h.run('armed.disarm(true)');
  assert.equal(h.run('window.__revN'), 0,
    '★★ 第二段（`disarm(true)`）不许跑 `onDisarm` —— 动作已经发生了');
});

test('★★ 切走工作区：主进程回 would_discard 时**不弹框**，摆一行确认，第二趟才带 confirmDiscard', async () => {
  // ★★ 这一条替掉的是从前那句 `window.confirm`。它守三件事：
  //   · 第一下**不弹框**、也不发第二次请求 —— 只是把那一格摆成一行确认；
  //   · 下拉**停在新值上**（那是"待定"，不是已发生的事），退回去才拨回来；
  //   · 第二趟**恰好带 `confirmDiscard: true`** 再发一次。
  //   ★ 判定权在主进程（`would_discard` 是它算的），界面只负责问 —— 所以这条
  //     路的形状是"先发、被拒了再问、答了再发"，不是"先问再发"。
  const h = bindAll({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' },
    'window.__calls = []; window.__asked = 0;'
    + 'window.slurmate.states = () => Promise.resolve({ sessions: [], front: null });'
    + 'window.slurmate.setConnectionWorkspace = (p) => {'
    + '  window.__calls.push(JSON.parse(JSON.stringify(p)));'
    + '  if (p.confirmDiscard) {'
    // ★ 这两份数据得**内联**进去：`WSS` / `CONNS` 是这一侧的常量，
    //   不是 vm 上下文里的名字 —— 直接写名字是一次 `ReferenceError`，
    //   而那看起来像"这条用例坏了"，与"守住了"分不开。
    + `    return Promise.resolve({ ok: true, workspaces: ${JSON.stringify(WSS)},`
    + `      connections: ${JSON.stringify(CONNS)} }); }`
    + '  return Promise.resolve({ ok: false, code: "would_discard",'
    + '    workspaceName: "工作区 1" });'
    + '};'
    // ★ 壳里 `window.confirm` 默认是 `() => true` —— 换成一个会记账的，
    //   这样"到底有没有弹框"才是**测出来**的，而不是假设的。
    + 'window.confirm = () => { window.__asked += 1; return true; };');

  h.fn('renderWorkspaceSelectors')();
  const sel = h.byId.get('sb-workspace');
  assert.equal(sel.value, 'w000000000001',
    '（前提）那一格显示的是这条连接当前的工作区');
  h.run("document.body.append($('sb-workspace'));");

  sel.value = 'w000000000002';
  await sel.onchange();

  assert.equal(h.run('window.__asked'), 0,
    '★★ 不许弹 `window.confirm` —— 它给不了两段，而这正是这条路从前最别扭的地方');
  assert.equal(h.run('window.__calls.length'), 1, '第一下只发那一次（照常提交，判定权在主进程）');
  assert.equal(h.run('window.__calls[0].confirmDiscard'), undefined,
    '第一趟**不许**带 confirmDiscard —— 它是"照常试一次"');
  assert.notEqual(h.run('armed'), null, '被拒之后要摆出第一段');
  assert.equal(h.byId.get('sb-workspace').value, 'w000000000002',
    '★ 下拉**停在待定的新值上** —— 它不是已发生的事，是"你要是确定就是这个"');
  const p = sel.parentNode;
  const cluster = p.children[p.children.indexOf(sel) + 1];
  assert.match(cluster.children[0]._text, /工作区 1/, '第一段要说出**哪一个**工作区会没');

  // ── 退回去：下拉拨回真值，一个请求都不多发 ──
  cluster.children[2].onclick();
  assert.equal(h.run('armed'), null, '取消之后不该还挂着第一段');
  assert.equal(h.byId.get('sb-workspace').value, 'w000000000001',
    '★★ 退回去要把下拉**拨回真正的当前值** —— 留着待定的新值就是界面在说一件没发生的事');
  assert.equal(h.run('window.__calls.length'), 1, '取消 = 什么都没发生');

  // ── 答"切走"：第二趟照常先发一次，再**恰好**带 confirmDiscard 发一次 ──
  const n0 = h.run('window.__calls.length');
  sel.value = 'w000000000002';
  await sel.onchange();
  assert.equal(h.run('window.__calls.length'), n0 + 1,
    '第二趟也照常先提交一次（判定权始终在主进程）');
  const p2 = sel.parentNode;
  const again = p2.children[p2.children.indexOf(sel) + 1];
  await again.children[1].onclick();
  assert.equal(h.run('window.__calls.length'), n0 + 2, '答「切走」之后**恰好**再发一次');
  assert.equal(h.run(`window.__calls[${n0 + 1}].confirmDiscard`), true,
    '★★ 第二趟必须**明确**带上 confirmDiscard —— 少这一格就是同一个框弹两遍');
  assert.equal(h.run('window.__asked'), 0, '全程没有弹过框');
});

test('★★ bootstrap 挂了，界面**照样点得动**（一次 reject 不许拆掉整块监听）', async () => {
  // ★★ 这条就是用户报的那个缺陷：主界面（连接列表）上点标题那一行没有反应。
  //   根因形状 —— 绑定从前排在 `init()` 那几个 `await` 的**后面**，于是
  //   `bootstrap()` 或 `openNewForm()`（里面有 `await newKey()`，在 Windows 上
  //   走 DPAPI）任何一次 reject，`init()` 就在那一行整体中止，**2950 行往后
  //   一个监听都不挂**，而唯一的症状是提示流里多一行字。
  //   ⇒ 现在分成 `bindEvents()`（纯同步，先跑）与 `bootUI()`（所有 await）。
  const h = bindAll({}, 'window.slurmate.bootstrap ='
    + ' () => Promise.reject(new Error("假装取不到"));'
    + 'window.slurmate.pluginData = () => Promise.resolve({});');

  // ── 让 bootUI 照真机那条路失败 ──
  await h.fn('bootUI')().then(
    () => { throw new Error('bootUI 本该 reject'); },
    (e) => h.fn('onInitFailed')(e));

  // ── 那几格必须仍然有动作 ──
  // ★ 一律走 `$()` 取元素：`byId` 是**取过才有**的缓存，而 `sec-about` 只在
  //   `toggleAbout` 被调用时才第一次被取到。
  const head = h.run("$('about-head')");
  assert.equal(typeof head.onclick, 'function',
    '★★ 标题那一行仍然要挂着动作 —— 首屏数据拿不到**不该**让入口变成哑的');
  // ★ 壳里的 `$()` 是**现造**一个空元素，它不会去读 panel.html —— 所以
  //   `hidden` 那一格得自己摆成初始状态（真机上由 panel.html 上的 class 给）。
  h.run("$('sec-about').classList.add('hidden');");
  assert.equal(h.run("$('sec-about').classList.contains('hidden')"), true, '（前提：它本来是收着的）');
  head.onclick();
  assert.equal(h.run("$('sec-about').classList.contains('hidden')"), false,
    '★★ 点下去要开 —— 用户报的就是"点了没反应"');

  // ── 而失败本身第一眼看得见（不再只滚进提示流）──
  const banner = h.byId.get('fatal-banner');
  assert.equal(banner.classList.contains('hidden'), false,
    '★ 初始化失败要有一块**常驻**的地方说出来 —— 提示流会滚过去、也会被顶下去');
  assert.match(h.byId.get('fatal-why').textContent, /假装取不到/,
    '而原因要照原话说出来');
});

test('★★ 重画会把没走完的第一段收掉（重画的就是它挂身的那一片）', () => {
  // ★ 不收的后果是**静默的**：那一行连同确认一起被丢掉，而 `armed` 还指着它 ——
  //   用户接着点"别处"收的是一个已经不在文档里的节点，看起来像没反应；
  //   更糟的是 `armed` 从此不为 null，下一次点另一处时 `disarmArmed()`
  //   先把**这个幽灵**收掉（白做一次），真正的第二段反而没了。
  //
  // ★★ 两条路各自都判，因为它们重画的是**不同的**一片：
  //   · `renderConnections` —— 收掉挂在连接列表那一片上的第一段；
  //   · `renderWorkspaceSelectors` —— 它重画的正是切走工作区第一段挂身的那一格
  //     （状态条那个下拉）。不收的话，"待定"的那行确认会与刚被拨回真值的下拉
  //     同时摆在界面上 —— 界面在说一件没发生的事。
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
    '★ 那颗按钮的 class 也要拨回来 —— 残留的 `armed-off` 属于'
    + '"那颗按钮永远不显示"这一类看不见的坏法');

  end.onclick();
  assert.notEqual(h.run('armed'), null, '（前提）再摆一个');
  h.fn('renderWorkspaceSelectors')();
  assert.equal(h.run('armed'), null,
    '★★ 重画工作区那个下拉之前也必须先收掉 —— 它重画的正是那一段挂身的一格');
});

test('★★ 「站点太新」那一句：正文只剩一行，理由挂 title', () => {
  // ★★ 这一条守的是"一段 → 一行 title"这个改动**本身**。原来那段话有三个句子
  //   （事实 / 为什么取不回来 / 该怎么办），而它读起来像一段讨论。
  //
  //   ★ 而它必须**分叉**：两种情形要用户做的事**方向相反**（升级客户端 /
  //     升级没用，得找管理员）。指错了方向，用户会去做一件解决不了问题的事 ——
  //     所以正文那一行必须是**那个方向**，理由放在 title 里。
  //
  //   ★ 判据是"正文短 + title 非空"，不是"某句话在不在"：后者在"整段又长回来"
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
    `★ 正文只剩**一行**：${cross._text.length} 个字 —— 又长回去了。`
    + '理由进 title（下面那一句判它）');
  assert.match(cross.title || '', /大版本/,
    '★ 理由要挂在 `title` 上 —— 没有它的话，这一行就是一个没有出处的断言');

  const other = show('same_major');
  assert.match(other._text, /升级客户端解决不了它/,
    '★ 另一支必须**明确否掉**"升级客户端" —— 那是用户看了这句话唯一会去做的事，'
    + '而它对"站点自己不一致"这种情况没有用');
  assert.equal(other._text.length <= 60, true, '正文同样只留一行');
  assert.match(other.title || '', /站点自己不一致/,
    '★ 而"凭什么这么判"要说得出来 —— 判定归握手（`daemonVersionVerdict`），'
    + '界面只负责按它选一句话');
});

test('★★ 同意那一段的安全警告压到两行以内（它曾经是三句）', () => {
  // ★ 这是这一版唯一的安全边界（进程隔离还没做），所以它**留着**；但它原来是
  //   三句 —— 第三句讲的是"不同意会怎样"，而那件事那颗按钮自己的措辞已经说了
  //   （「不同意，删掉本机这一份」）。按钮能说清的事不必再写一句在旁边。
  //
  //   ★ 判据用**句数**而不是字数：字数会随措辞漂，而"两行以内"约束的正是句子数。
  const h = start({ connections: [], workspaces: [], activeConnectionId: null });
  h.fn('renderConsent')({ consent: [{
    id: 'p1', name: 'p1', title: '编辑器', version: '1.0.0', fileCount: 3,
    existing: false, siteLabel: '本站', digest: 'abcdef0123456789', digestAlg: 1,
    previous: null, fingerprint: null,
  }] });
  const warn = childrenOf(h.byId.get('plugin-consent'))
    .find((x) => /^同意之后/.test(x._text || ''));
  assert.ok(warn, '同意那一块里找不到那句警告了 —— 它是用户做决定时缺不得的一条信息');
  assert.match(warn._text, /没有进程隔离/, '★ 必须说清"目前没有进程隔离"');
  assert.match(warn._text, /在你这台机器上运行/, '★ 必须说清客户端代码会在本机运行');
  assert.equal((warn._text.match(/。/g) || []).length, 2,
    `★ 这一句应当是**两句**：现在 ${JSON.stringify(warn._text)}　——`
    + '第三句讲"不同意会怎样"，而那件事按钮自己会说了');
});

test('★ 映射图：三列两段线 —— 连接 / 工作区 / 数据', () => {
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
  // rAF 是**立刻执行**的 —— 所以矩形非零时线就该已经画好了。
  // ★ 两段线各两条：连接→工作区、工作区→数据。少了第二段的话，图上"哪个工作区
  //   指着哪一份"就只剩一列孤零零的方框，而这张图存在的理由正是那一段。
  const lines = h.byId.get('wmap-lines').children;
  assert.equal(lines.length, 4, '两段关系各两条线');
  assert.match(lines[0].attrs.d, /^M [\d.]+ [\d.]+ C /, '线是三次贝塞尔');
  assert.equal(lines[0].attrs.class, 'edge cur', '正连着的那条要高亮');
  assert.equal(lines[1].attrs.class, 'edge');
  for (const l of lines.slice(2)) assert.equal(l.attrs.class, 'edge', '数据那一段不高亮');
});

test('★★ 同一份数据被两个工作区指着 ⇒ 两条线汇到同一个节点', () => {
  // ★ 这就是这张图存在的**全部理由**：在下拉框里，"我和 2 号工作区共用同一份登录
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
  // 2 条（连接→工作区）+ 2 条（两个工作区都指向同一份）—— 它们是**同一个终点**：
  // 那正是"共用"在图上长的样子。
  assert.equal(lines.length, 4);
  assert.equal(lines[2].attrs.d.split('C')[1], lines[3].attrs.d.split('C')[1],
    '★ 两条线的终点必须重合（同一份数据）');
});

test('★★ 连接表单里的「③ 工作区」：三种取值各有各的那一句后果', () => {
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

  // ★ 默认值一变（用户敲了地址），那一项的**标签**要跟着变 —— 这一格显示的是
  //   "按现在这个地址会落到哪儿"，显示错了就是"界面在说一件不成立的事"。
  h.run('wsDefault = "w000000000002";');
  h.fn('renderFormWorkspace')();
  assert.equal(h.byId.get('f-workspace').children[0].textContent, '默认：工作区 2');
  assert.match(h.byId.get('ws-hint').textContent, /会落在「工作区 2」/);

  // ── 用户显式挑一个：不再跟随默认 ──
  h.run('wsPicked = "w000000000001";');
  h.fn('renderFormWorkspace')();
  assert.equal(h.byId.get('f-workspace').value, 'w000000000001');
  assert.match(h.byId.get('ws-hint').textContent, /会用「工作区 1」/);

  // ── 用户要一个**新的**：那一项要被真的选中，不能被吞回去 ──
  //   ★ 一个"找不到就空着"的兜底如果写成了 `list.some(id === keep)`，那么
  //     `__new__` 这个**不在列表里**的值会被悄悄换成空串 —— 界面回到"默认"，
  //     而保存时发上去的就是"没表态"，用户点的那一项从头到尾没生效。
  h.run('wsPicked = "__new__";');
  h.fn('renderFormWorkspace')();
  assert.equal(h.byId.get('f-workspace').value, '__new__',
    '★ 选了「＋ 新建空白工作区…」就该停在那一项上');
  assert.match(h.byId.get('ws-hint').textContent, /保存后会新建一个空白工作区/);

  // ── 编辑：没有"跟随默认"那一项，初值是这条连接自己的工作区 ──
  h.run('form = { open: true, mode: "edit", id: "c1" }; wsPicked = "";');
  h.fn('renderFormWorkspace')();
  const sel2 = h.byId.get('f-workspace');
  assert.equal(sel2.children.some((o) => o.value === ''), false,
    '编辑时没有"跟随默认"—— 这条连接已经有一个了，那一格答的是"要不要换"');
  assert.equal(sel2.value, 'w000000000001', '初值是它现在那个');
  assert.equal(h.byId.get('ws-hint').textContent, '不变。');

  // ★ 换一个：那一句话必须说清"原来那个里面的东西不会跟着走" ——
  //   换工作区 = 换 origin = 浏览器**重新加载**，这是用户按下保存之前唯一的机会。
  h.run('wsPicked = "w000000000002";');
  h.fn('renderFormWorkspace')();
  assert.match(h.byId.get('ws-hint').textContent, /切到「工作区 2」/);
  assert.match(h.byId.get('ws-hint').textContent, /不会跟着走/);
});

test('★ 状态条那个选择器：共用同一份工作区列表，选中"该选的那个"', () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c2' });
  h.fn('renderWorkspaceSelectors')();
  const sel = h.byId.get('sb-workspace');
  assert.equal(sel.value, 'w000000000002', '没有会话时用活跃连接那个');
  assert.equal(sel.children.length, WSS.length + 1, '工作区 + 「＋ 新建空白工作区…」');
  // 找不到就不选（宁可空着）—— 停在一个并不生效的值上，用户会以为自己已经切过去了
  h.run('boot = { connections: [], workspaces: [], activeConnectionId: null };');
  h.fn('renderWorkspaceSelectors')();
  assert.equal(h.byId.get('sb-workspace').value, '');
});

test('★★ 顶栏标签：同一个插件开两份时，两个标签必须分得开', () => {
  // ★★ 这一条守的是**多开**（`contributes.concurrent: true`：第二份拿到自己的
  //   临时数据 = 自己的槽，于是两条同时在跑）。标签上写的是插件的显示名，
  //   于是**两个标签一模一样** —— 而它们指着两份不同的数据、两个不同的本地端口。
  //   用户点哪一个都有一半概率点错，而"点错了"的表现是"我的编辑器里东西不对了"。
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.run('SESS = { sessions: ['
    + '{ slot: "a", service: "编辑器", live: true, snap: { localPort: 18080 } },'
    + '{ slot: "b", service: "编辑器", live: true, snap: { localPort: 18081 } }'
    + '], front: "a" };');
  h.fn('renderTabs')();
  const tabs = h.byId.get('session-tabs').children;
  assert.equal(tabs.length, 2, '两条会话两个标签');
  assert.notEqual(tabs[0].textContent, tabs[1].textContent,
    '★ 同名时必须补区分符 —— 两个一模一样的标签等于没有标签');
  assert.match(tabs[0].textContent, /18080/, '区分符是本地端口');
  assert.match(tabs[1].textContent, /18081/);
  // 而**不同名时一个字都不加**：给每一条都挂一个端口，等于把"这两条需要分"
  // 说给所有人听（设计律：非必要不提示）。
  h.run(`SESS = { sessions: [
    { slot: 'a', service: '编辑器', live: true, snap: { localPort: 18080 } },
    { slot: 'b', service: '中转站', live: true, snap: {} } ], front: 'a' };`);
  h.fn('renderTabs')();
  const t2 = h.byId.get('session-tabs').children;
  assert.equal(t2[0].textContent, '编辑器', '不重名就不加字');
  assert.equal(t2[1].textContent, '中转站');
  // 一条会话时整条栏收起来：它不提供任何选择，只占掉 30px 里的一行地方。
  h.run(`SESS = { sessions: [
    { slot: 'a', service: '编辑器', live: true, snap: { localPort: 18080 } } ], front: 'a' };`);
  h.fn('renderTabs')();
  assert.ok(h.byId.get('session-tabs').classList.contains('hidden'));
});

test('★★ 右栏那个点只在**有作业在跑**的时候亮（那时它才有内容可说）', () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  const dot = () => h.byId.get('rail-right-dot').className;
  // 一条会话都没有
  h.run('SESS = { sessions: [], front: null };');
  h.fn('renderRails')();
  assert.equal(dot(), 'rail-dot', '没作业就不亮');
  // 有一条活的
  h.run('SESS = { sessions: [{ slot: "a", service: "编辑器", live: true, snap: {} }], front: "a" };');
  h.fn('renderRails')();
  assert.equal(dot(), 'rail-dot hot', '有作业在跑才亮');
  // ★ 而"已经结束但记录还在"那一条**不算**：`live` 是主进程给的判据，
  //   拿"这张表非空"当判据的话，一个只剩尸体的槽会让右栏一直亮着。
  h.run('SESS = { sessions: [{ slot: "a", service: "编辑器", live: false, snap: {} }], front: "a" };');
  h.fn('renderRails')();
  assert.equal(dot(), 'rail-dot', '结束了的会话不算"有作业在跑"');
});

test('★★ 连上之后才有两条边栏，而且它们是在状态条**下面**那一段', () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  // 没连上：`body` 上没有那个 class，两条栏由 CSS 收起来。
  h.fn('renderConnections')(CONNS);
  assert.equal(h.run('document.body.classList.contains("connected")'), false,
    '没连上就不该有边栏');
  h.run('connected = true;');
  h.fn('renderConnections')(CONNS);
  assert.equal(h.run('document.body.classList.contains("connected")'), true,
    '连上之后两条栏才出现');
});

test('★★ 插件块上的「用哪一份数据」：三种取值各发各的，一个都不许合并', async () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1',
    spaces: SPACES },
  'lastPlugins = { plugins: [{ id: "p1", title: "编辑器" }, { id: "p2", title: "中转站" }] };'
  + 'window.__calls = [];'
  + 'window.slurmate.setWorkspaceRef = (p) => { window.__calls.push(p);'
  + ' return Promise.resolve({ ok: true, droppedOld: false }); };');
  h.fn('renderPlugins')(PV);

  const blocks = h.byId.get('plugin-blocks').children;
  assert.equal(blocks.length, 2);
  const selOf = (b) => childrenOf(b).find((x) => x.tagName === 'SELECT') || null;
  // ★ 发出去的那个对象是在 vm 另一个 Realm 里造的，`deepStrictEqual` 会拿**原型**
  //   去比，于是两个字段完全一样的对象也说"不相等"。所以比字段时走一趟 JSON。
  const raw = (i) => h.run(`window.__calls[${i}]`);
  const sent = (i) => JSON.parse(JSON.stringify(raw(i)));
  // ★★ 而**"键在不在"必须查在原对象上** —— `JSON.stringify` 会把值为 `undefined`
  //    的键**整个丢掉**，于是"没有 `spaceId` 这个键"与"有、值是 undefined"在
  //    `sent()` 眼里长得一模一样。第一版的判据就戴了这个遮罩：把界面那边改成
  //    「永远发一个 `spaceId: undefined`」时它**照样绿**。见下面第 ③ 段。

  // ★ 不要数据空间的插件**没有这一格**（`ports: 0`）。画一个空下拉等于凭空许诺
  //   一个不存在的东西 —— 它没有存储、没有端口，也就没有"用哪一份"。
  assert.equal(selOf(blocks[1]), null, '★ 0 个端口的插件不该有那一格');

  const sel = selOf(blocks[0]);
  assert.ok(sel, '要数据的插件必须有那一格');
  // 选项 = 这个插件的两份 + 「另开一份」。★ **没有"跟随默认"那一项** ——
  // 这个工作区已经指着一份了，再摆一个"默认"只会让下拉停在一个不生效的值上。
  assert.deepEqual(sel.children.map((o) => o.value),
    ['s000000000001', 's000000000002', '__new_space__']);
  assert.equal(sel.value, 's000000000001', '初值是它现在指着的那一份');
  // ★ 「还有谁在用」：s2 被 2 号工作区指着，s1 没有别人 —— 两句话必须**分开**，
  //   因为用户按它决定"改这一格会不会动到别人"。
  assert.match(sel.children[0].textContent, /数据 1 · 端口 18080$/);
  assert.match(sel.children[1].textContent, /数据 2 · 端口 18081（「工作区 2」也在用）/);

  // ── ① 选另一份已存在的 ⇒ 发一个**数据 id** ──
  //   ★ `connectionId` 也一起发：主进程要拿它回答"这张表是替**哪一条**连接改的"
  //     （共用的一张表要分叉时，得指名分给谁）—— 它不拿"谁活跃"去猜。
  sel.value = 's000000000002';
  await sel.onchange();
  assert.deepEqual(sent(0),
    { workspaceId: 'w000000000001', pluginId: 'p1', connectionId: 'c1',
      spaceId: 's000000000002' });

  // ── ② 选「另开一份」⇒ 发 `null`（**不是**空串、也不是某个 id）──
  sel.value = '__new_space__';
  await sel.onchange();
  assert.deepEqual(sent(1),
    { workspaceId: 'w000000000001', pluginId: 'p1', connectionId: 'c1', spaceId: null });

  // ── ③ 这一格还没有值（引用表里没有这个插件）⇒ 发的是**没有 spaceId 这个键** ──
  //   ★ 这一条是整个协议里最容易写错的一格：「没表态」与「要一个新的」合并成一种
  //     值时，用户点了「另开一份」而系统理解成"什么都不做"（或者反过来，用户什么都
  //     没做而系统又开了一份）—— 两边都不报错。
  const empty = WSS.map((l) => ({ ...l, refs: {}, spaces: [] }));
  h.run(`boot = { connections: ${JSON.stringify(CONNS)}, workspaces: ${JSON.stringify(empty)},`
    + ` activeConnectionId: 'c1', spaces: ${JSON.stringify(SPACES)} };`);
  h.fn('renderPlugins')(PV);
  const sel2 = selOf(h.byId.get('plugin-blocks').children[0]);
  assert.equal(sel2.children[0].value, '', '还没有值 ⇒ 第一项是"跟随默认"');
  assert.match(sel2.children[0].textContent, /第一次开会话时新建一份/);
  assert.equal(sel2.value, '', '初值选中"跟随默认"');
  assert.equal(sel2.children.length, 4, '默认 + 两份数据 + 另开一份');

  // 选「跟随默认」（什么都没改）
  sel2.value = '';
  await sel2.onchange();
  // ★ 查在**原对象**上（`sent` 会把这一格抹平，见上面那段）：
  assert.equal('spaceId' in raw(2), false,
    '★ 「没表态」必须是**键缺席** —— 界面不许把一个显式的 `spaceId: undefined` 发出去：'
    + '那是"这一格有值、值是空的"，它与"这一格没有值"是不是同一件事，取决于**传输层**'
    + '怎么看待 undefined（跨 IPC 一路序列化下来，两种形状能不能分开不由我们说了算）。'
    + '而这一格一旦被读成"要一个新的"，用户什么都没做、每开一次会话就多一份数据。');

  // 而这一格还没有值的时候选「另开一份」，发的仍然是 `null`
  sel2.value = '__new_space__';
  await sel2.onchange();
  assert.deepEqual(sent(3),
    { workspaceId: 'w000000000001', pluginId: 'p1', connectionId: 'c1', spaceId: null });

  // ── ④ 一条连接都没有（开发者模式）⇒ 整格不画 ──
  h.run('boot = { connections: [], workspaces: [], activeConnectionId: null, spaces: [] };');
  h.fn('renderPlugins')(PV);
  assert.equal(selOf(h.byId.get('plugin-blocks').children[0]), null,
    '★ 没有活跃连接时那一格没有对象 —— 画一个空的等于凭空许诺');
});

test('★★ 共用的那张表：先弹框问「一起改还是分一张自己的」，选完才带 scope 重发', async () => {
  // 主进程第一发回 `shared`（这张表还有别的连接在用）。界面**不许**替用户选一个：
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
  assert.equal(dlg.open, true, '★ 共用的一张表必须先问 —— 替用户选一个就是把别人改了');
  // ★ 名字由**界面**取（同一条 `connLabel` 规则），主进程只回 id ——
  //   两处各拼一遍备注/地址的回落规则迟早会漂开。
  assert.match(h.byId.get('fork-body').textContent, /bob@198\.51\.100\.9:10100/,
    '要说得出"还有谁在用" —— 只说"还有 1 条连接"等于没说');
  assert.equal(raw(1), undefined, '★ 还没选之前不许发第二发');
  assert.deepEqual(sent(0), { workspaceId: 'w000000000001', pluginId: 'p1',
    connectionId: 'c1', spaceId: 's000000000002' }, '第一发不带 scope');

  // ── 选「只改这条连接」⇒ 带 scope: 'fork' ──
  h.run('$("fork-one").onclick()');
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(dlg.open, false, '选完要把框关掉');
  assert.deepEqual(sent(1), { workspaceId: 'w000000000001', pluginId: 'p1',
    connectionId: 'c1', spaceId: 's000000000002', scope: 'fork' });
  // ★ 分叉这件事要**说出来**，而且要说清"数据没复制" —— 否则用户会以为
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
  assert.equal(h.run('window.__calls.length'), 1, '★ 取消之后不许再发一发');

  // ── 选「全部一起改」⇒ scope: 'all'，而且**第二问（would_discard）要把它带上** ──
  //   ★ 这一格是最容易漏的：`would_discard` 的重试如果只补 `confirmDiscard`、
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
  assert.equal(raw(2).scope, 'all', '★ 第二问的重试必须把 scope 一起带上');
  assert.equal(raw(2).confirmDiscard, true);
  assert.match(body(), /已经删掉/);
});

test('★★ 这个架子真的抓得住 P1 那个缺陷（拿一个故意的错来验）', () => {
  // ★ 一条抓不住真缺陷的守卫等于没有守卫。这里把 P1 那个错误**原样放回去**：
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

test('★★ 作业**结束之后**失败原因不再消失（从前它恰好在那一刻被藏起来）', () => {
  // ★★ 这一条守的是一个"最该看见的时候看不见"的缺陷：`#kv`（含「作业状态」那一句，
  //    也就是 `jobstate.js` 译好的失败原因与退出码）从前的可见性判据是
  //    `st !== 'ended'` —— 而作业一结束会话就进 `ended` ⇒ **原因当场消失**。
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
    '★ 结束之后那一格仍然要露 —— 失败原因正是在那一刻才要看');
  const kv = h.byId.get('kv');
  assert.match(kv._text || childrenOf(kv).map((x) => x._text).join(' '), /作业状态/,
    '而「作业状态」那一行要在里面');

  // ★ 反过来的那一半：`idle`（还没有过任何会话）仍然不露 —— 那时没有任何东西可说。
  h.run("SESS = { sessions: [], front: null };");
  h.fn('renderSnapshot')(null);
  assert.equal(h.byId.get('job-detail').classList.contains('hidden'), true,
    '一会儿都没跑过的时候不该摆一个空的详情块');
});

test('★★ 作业结束的那一刻那一句进提示流，而且**好坏按退出码分**', () => {
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
  assert.match(after1[0] || '', /错误/, '★ 非零退出码 ⇒ 那一档是「错误」，不是一句平静的信息');
  assert.equal(after1.length, 1);

  // ★ 同一份快照再来一次（推送会反复来）**不许再报一遍** —— 判据是"上一轮还不是
  //   终态"，不是"状态是 ended"；后者会在每一次推送时都重复一遍。
  ended('a', '143:0');
  assert.equal(notices().length, 1, '同一件事只说一次');

  // 而干净收尾是 info 那一档
  h.run("SESS = { sessions: [{ slot: 'b', live: false, snap: null }], front: 'b' };");
  ended('b', '0:0');
  const n0 = notices()[0] || '';
  assert.match(n0, /0:0/);
  assert.equal(/错误/.test(n0), false, '★ `0:0` 是干净收尾 —— 报成错误会让用户去查一个不存在的问题');
});

test('★★ 「看作业日志」按需取一次：三态各不相同，空的那一块不出现', async () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.run("SCREEN = 'jobs';"
    + "SESS = { sessions: [{ slot: 'a', live: false, snap: { sessionId: 's1' } }], front: 'a' };");
  const shown = () => {
    const b = h.byId.get('joblog-body');
    return [b._text].concat(childrenOf(b).map((x) => x._text)).join(' | ');
  };

  // ① 两份都有；`.err` 是 `null` ⇒ 那一块**不出现**（设计律 1：空框在说"本该有东西"）
  h.run('window.slurmate.jobLog = async () => ({ ok: true, data: {'
    + " out: { path: '/h/.slurmate/logs/slurm-1.out', bytes: 40000, lines: 200,"
    + " truncated: true, mtime: 1, text: '宿主的一行\\n服务的一行', why: null },"
    + ' err: null } });');
  await h.run('loadJobLog()');
  assert.match(shown(), /标准输出/);
  assert.match(shown(), /服务的一行/);
  assert.match(shown(), /这是尾部/, '★ 拿不全的时候必须说出来 —— 不说的话用户会以为那就是全部');
  assert.equal(/标准错误/.test(shown()), false, '`.err` 是 null ⇒ 那一块不出现');

  // ② 「取不到」与「确实没有」长得**不一样**（并成一句的话，一个模式不对的日志
  //    会被读成"这台站点上没有日志"）
  h.run('window.slurmate.jobLog = async () => ({ ok: true, data: {'
    + " out: { path: '/h/a.out', bytes: null, lines: null, truncated: null,"
    + " mtime: null, text: null, why: 'component_group_or_world_writable' },"
    + ' err: null } });');
  await h.run('loadJobLog()');
  assert.match(shown(), /取不到：component_group_or_world_writable/);
  assert.match(shown(), /\/h\/a\.out/, '路径要给出来（可复制）');

  // ③ 两份都没有 ⇒ 一句"还没有写出任何东西"，而不是一个空框
  h.run("window.slurmate.jobLog = async () => ({ ok: true, data: { out: null, err: null } });");
  await h.run('loadJobLog()');
  assert.match(shown(), /还没有写出任何东西/);

  // ④ 整条 op 失败（老守护进程没有这个能力）⇒ 如实说，不画空框
  h.run("window.slurmate.jobLog = async () => ({ ok: false, unsupported: true,"
    + " error: '这个站点太旧' });");
  await h.run('loadJobLog()');
  assert.match(shown(), /这个站点太旧/);
});
