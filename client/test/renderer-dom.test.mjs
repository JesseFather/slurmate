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
    onclick: null, onchange: null, oninput: null, oncancel: null, style: {},
    open: false,
    // <dialog> 的那两个方法：`askFork` 会真的调用它们，缺了就是一次 TypeError
    // ——而"那一格按下去炸了"与"按下去没反应"在这一组眼里必须分得开。
    showModal() { e.open = true; },
    close() { e.open = false; },
    append(...kids) { for (const k of kids) e.children.push(k); },
    prepend(k) { e.children.unshift(k); },
    appendChild(k) { e.children.push(k); return k; },
    remove() {},
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
    set(v) { e._text = String(v); e.children.length = 0; },
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
    addEventListener() {},
    body: mkEl('body'),
  };
  const ctx = vm.createContext({
    document: doc,
    window: { slurmate: {}, confirm: () => true },
    requestAnimationFrame: (f) => { f(); return 1; },
    setTimeout, clearTimeout, console, Promise, JSON, Math, Number, String, Object, Array,
  });
  vm.runInContext(withoutInit(src), ctx, { filename: 'panel.js' });
  return {
    byId,
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
