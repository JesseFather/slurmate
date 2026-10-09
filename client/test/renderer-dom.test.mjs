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
    onclick: null, onchange: null, oninput: null, style: {},
    append(...kids) { for (const k of kids) e.children.push(k); },
    appendChild(k) { e.children.push(k); return k; },
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
const WSS = [
  { id: 'w000000000001', name: '工作区 1', refCount: 1, members: ['c1'], soleOwnerId: 'c1', spaces: [] },
  { id: 'w000000000002', name: '工作区 2', refCount: 1, members: ['c2'], soleOwnerId: 'c2', spaces: [] },
];

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

test('★ 映射图：连接与工作区各一列，每一条连接一条线', () => {
  const h = start({ connections: CONNS, workspaces: WSS, activeConnectionId: 'c1' });
  h.fn('renderConnections')(CONNS);

  assert.equal(h.byId.get('wmap-conns').children.length, 2, '左列两条连接');
  assert.equal(h.byId.get('wmap-workspaces').children.length, 2, '右列两个工作区');
  // renderWorkspaceMap 结尾是 requestAnimationFrame(drawWorkspaceLines)，而架子里的
  // rAF 是**立刻执行**的 —— 所以矩形非零时线就该已经画好了。
  const lines = h.byId.get('wmap-lines').children;
  assert.equal(lines.length, 2, '两条连接各一条线');
  assert.match(lines[0].attrs.d, /^M [\d.]+ [\d.]+ C /, '线是三次贝塞尔');
  assert.equal(lines[0].attrs.class, 'edge cur', '正连着的那条要高亮');
  assert.equal(lines[1].attrs.class, 'edge');
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
