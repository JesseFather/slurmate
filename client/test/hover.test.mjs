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
 * hover.test.mjs —— 浮窗那一层（两条边栏滑出来的那块）真的跑起来画一遍。
 *
 * 它守的是站点状态那一块搬过一次家这件事：从前它在面板里
 *   （`#sec-cluster`），现在它是一个独立的 renderer。搬家最容易丢的不是代码，
 *   是三态那条规矩 —— 「获取失败」与「确实没有」在这一块里长得一样（都是一片空），
 *   而把前者画成后者，用户会去查一个不存在的问题。
 *
 * 所以这一组只判两件事：
 *   1. 数据缺席时，每一格都有一行说"获取失败"（而不是画成空的）；
 *   2. 而那几行在「确实没有」时不许出现。
 *
 * 它跑的是真的 `hover.js` + `dom.js`（在一个人造 DOM 上），不是文本比对 ——
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
  // 顺序是承重的：`cel` / `na` / `agoText` 是普通脚本之间的全局名字
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
  /** 与 `text` 同一趟走，但不加分隔符 —— 右栏那两块是追加式画出来的，
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

/** 一份 `op_cluster` 的答案。`omit` 里列出的格子整个键都不给（= 获取失败）。 */
function cluster(omit = []) {
  const d = {
    at: Math.floor(Date.now() / 1000),
    now: Math.floor(Date.now() / 1000),
    health: { up: true, at: Math.floor(Date.now() / 1000) },
    version: 'slurm-wlm 23.11.4',
    partitions: { gpu: { state: 'UP', is_default: true, max_time: '1-00:00:00', nodes: 12 },
      cpu: { state: 'UP', is_default: false, max_time: '7-00:00:00', nodes: 40 } },
    nodes: { gpu: { counts: { idle: 10, mixed: 2 }, flags: {},
      // `%C` 累加：空闲 640 / 总 672。cpu 那个分区故意不给 `cpus` ——
      //   同一份夹具里要能画得出"这一格没有数据"，否则那一支永远走不到。
      cpus: { allocated: 32, idle: 640, other: 0, total: 672 },
      // `Memory - AllocMem` 累加：合计 80000 MB、单节点最多 60000 MB
      //   （78.1 / 58.6 GB）。
      mem_free: { sum: 80000, max: 60000 } },
    cpu: { counts: { idle: 38, allocated: 2 }, flags: {} } },
    mem: { gpu: 128000, cpu: 191000 },
    // 两个分区，数字故意不一样：下面那条"合计"的判据要能分出"加起来了"与
    //   "只画了其中一个"（一个分区的话，两种写法印出来一模一样）。
    queue: { depth: { gpu: { pending: 0, running: 3, other: 0 },
      cpu: { pending: 5, running: 1 } } },
    // `used` / `free` 来自 `sinfo -O` 的 `GresUsed`（Slurm 按节点算好的）。
    gres: { gpu: [{ name: 'gpu', label: 'gpu:a6000', per_node_max: 4,
      total: 48, used: 16, free: 32 }] },
    taken: {},
    me: { account: 'lab', allowed_partitions: null,
      fairshare: { account: 'lab', fair_share: 0.42 },
      // 这两格也要给：它们缺席时那一块会画一行"获取失败"（`pending_count ===
      //   undefined` 就是"这一格没问到"），而那是对的 —— 所以"数据齐全"
      //   这份夹具必须把它们带上，否则下面那条"不该有获取失败"判的就是别的东西。
      pending_count: 0, first_in: {} },
  };
  for (const k of omit) delete d[k];
  return d;
}

test('hover.js 用到的每个 id 都在 hover.html 里，桥上的每个方法都在 preload 里', () => {
  // 这两条是跨文件的，而它们守的是同一类静默失败：`$('cl-bdoy')` 打错一个
  //   字母，`getElementById` 返回 null，`box.textContent = ''` 当场抛 —— 或者更坏，
  //   一个 `?.` 兜住之后浮窗永远空白，而没有任何地方报错。
  //   panel.js 那一对在 renderer.test.mjs 里，这一对跟着它。
  const src = read('hover.js');
  const html = read('hover.html');
  const used = new Set([...src.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(used.size >= 5, `抽到的 id 不足（${used.size}），正则多半没匹配上`);
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

test('hover.html 里不许有内联样式（CSP 会把它们静默丢掉）', () => {
  // 面板那一侧的同一条在 renderer.test.mjs 里，理由逐字相同：CSP 没有
  //   'unsafe-inline'，`style="..."` 会被静默丢弃，表现是"布局莫名其妙不对"，
  //   而控制台之外没有任何提示。
  const html = read('hover.html');
  // 查之前先去掉注释：解释这条规矩的那段注释里必须能写出 `style="..."` 这个
  //   样子，不然没法说清禁的是什么。查的是真标记。
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.equal(/\sstyle="/.test(markup), false, '浮窗页面里不许出现内联 style');
  assert.match(markup, /<link rel="stylesheet" href="hover.css">/, '样式要走外链');
  // 还有一条更细的：样式块也不行。`<style>` 同样要 'unsafe-inline'，
  //   而它比 `style=` 更容易被顺手写进去。
  assert.equal(/<style[\s>]/.test(markup), false, '也不许用内联 <style> 块');
});

test('数据齐的时候，画得出来而且不抛（浮窗白屏的守卫）', () => {
  const h = boot();
  assert.doesNotThrow(() => h.subs.data({ cluster: cluster(), link: { connected: true } }));
  const t = h.text('cl-body');
  assert.match(t, /gpu/, '分区要画出来');
  assert.match(t, /23\.11\.4/, 'Slurm 版本');
  assert.match(t, /lab/, '账户');
  // 每一格有自己的钟；控制器那一句只说它自己，不写成"这一页是 N 秒前取的"。
  assert.match(h.text('cl-body'), /控制器：.*问过/);
});

test('分区要报 CPU / 内存 / GRES 的余量，内存还要报容量', () => {
  const h = boot();
  h.subs.data({ cluster: cluster(), link: { connected: true } });
  const t = h.text('cl-body');
  assert.ok(t.includes('CPU　空闲 640 / 672 核（已分配 32）'), `CPU 余量那一行：${t}`);
  assert.ok(t.includes('内存　每节点最多 125 GB'), `内存那一行：${t}`);
  // 余量：合计 + 单节点最多（用户 2026-10-19 选的口径）。
  assert.ok(t.includes('可分配合计 78.1 GB（单节点最多 58.6 GB）'),
    `内存余量那一格：${t}`);
  // 191000 MB 不是整 GB，留一位小数（真机上很常见）。
  assert.ok(t.includes('内存　每节点最多 186.5 GB'), `非整 GB 那一格：${t}`);
  assert.ok(t.includes('gpu:a6000 ×4/节点，共 48，可用 32'), `GRES 总量与余量：${t}`);
  // 那一格没有 `cpus` / `mem_free` 时只少余量，不把容量那一行也带走。
  assert.equal(/内存　每节点最多 186.5 GB　可分配合计/.test(t), false,
    '没有 mem_free 的分区不写余量（缺席不是 0）');
  // 没有 `cpus` 的那一格要说"没有数据"，不许画成 0 ——
  //   0 的意思是"确实一核都不剩"，那是另一句话。
  assert.ok(t.includes('CPU　（这一格没有数据）'), `缺 %C 的分区：${t}`);
  assert.equal(/CPU　空闲 0/.test(t), false, '缺席不许画成 0');

  // 整份 `mem` 没问到：分区里那一格说"没有数据"，底部再点名是哪一格失败。
  const d = cluster();
  delete d.mem;
  h.subs.data({ cluster: d, link: { connected: true } });
  assert.match(h.text('cl-body'), /获取失败：每节点内存/);
  assert.ok(h.text('cl-body').includes('内存　（这一格没有数据）'));
});

test('队列那一行是全集群合计，而且写明是全部用户的', () => {
  // 那一格从前只能一个一个分区去看（每个分区一行），而用户问的是"这台集群
  //   现在排了多少"。合计必须是加起来的：一个分区的话，"加起来"与"只画了一个"
  //   印出来一模一样，所以夹具里放了两个、数字不同。
  const h = boot();
  h.subs.data({ cluster: cluster(), link: { connected: true } });
  const t = h.text('cl-body');
  const Q = '　';
  assert.ok(t.includes(`排队 5${Q}在跑 4${Q}（全部用户）`),
    `合计那一行要在（排队 0+5、在跑 3+1）：${t}`);
  // 分区自己那一行照旧只说它自己 —— 两个数必须是不同的两个数。
  assert.ok(t.includes(`排队 5${Q}在跑 1`), `cpu 那一行是它自己的数：${t}`);
});

test('键缺席 = 「获取失败」，而且每一格都要说出来', () => {
  // 这是搬家最容易丢的那条规矩。全缺的时候，用户必须能一句一句读到
  //    "哪一格没问到"，而不是面对一片空白去猜"是不是这台集群本来就没有"。
  const h = boot();
  h.subs.data({ cluster: cluster(['health', 'partitions', 'nodes', 'queue', 'gres']),
    link: { connected: true } });
  const t = h.text('cl-body');
  assert.match(t, /获取失败：控制器状态/, '控制器那一格');
  assert.match(t, /获取失败：分区列表/, '分区那一格');
  assert.match(t, /不是「没有」/, '而且要说清这是"没问到"，不是"没有"');
  assert.match(h.text('cl-health'), /获取失败/);
});

test('而「确实没有」的时候，那几行一个字都不许出现', () => {
  // 反过来的一半，缺了它上面那条就是一句空话：「获取失败」那几行如果无论如何都画，
  // 它会在数据齐全的时候也说"没问到"，而那同样是替集群说了一句不成立的话。
  const h = boot();
  h.subs.data({ cluster: cluster(), link: { connected: true } });
  assert.equal(/获取失败：/.test(h.text('cl-body')), false,
    '数据齐全时不该有任何一行"获取失败"');
  // 三态里的第三态：`{}` = 确实没有（一个分区都没有），与"获取失败"不同。
  const d = cluster();
  d.partitions = {};
  h.subs.data({ cluster: d, link: { connected: true } });
  assert.match(h.text('cl-body'), /确实一个分区都没有/);
  assert.equal(/获取失败：分区/.test(h.text('cl-body')), false);
});

test('链路断了就说断了 —— 它与集群那一份不是一个时间尺度', () => {
  const h = boot();
  h.subs.data({ cluster: cluster(), link: { connected: false, detail: '连接已断开' } });
  assert.match(h.text('cl-link'), /已断开/);
  assert.match(h.text('cl-link'), /连接已断开/, '原因也要露出来');
  h.subs.data({ link: { connected: true, hbAgeMs: 12000, rttMs: 33 } });
  assert.match(h.text('cl-link'), /已连接/);
  assert.match(h.text('cl-link'), /心跳 12 秒前/);
  assert.match(h.text('cl-link'), /延迟 33ms/);
});

test('获取失败集群信息时，那一句是错误，不是空白', () => {
  const h = boot();
  h.subs.data({ cluster: null, clusterError: '守护进程没有响应', link: { connected: true } });
  assert.match(h.text('cl-body'), /获取集群信息失败：守护进程没有响应/);
});

test('账户为空时，那一格答「无」，原因另起一行', () => {
  // `account` 为空而 `account_error` 有值 = 服务端确实答了，答案是"没有账户"。
  //   它与"获取失败"（两个都空）是两件事，也与有账户（显示账户名）是三件事。
  //   这一态在测试后端里永远不出现（`account_error` 恒为 `null`），所以界面
  //   这一支必须自己有一条判据 —— 否则它是一片没人走过的代码（账本 S41）。
  const h = boot();
  const d = cluster();
  d.me.account = null;
  d.me.account_error = '账户服务未响应（sacctmgr 超时）';
  h.subs.data({ cluster: d, link: { connected: true } });
  const t = h.text('cl-body');
  assert.ok(t.includes('账户 | 无'), `账户那一格是「无」：${t}`);
  assert.equal(/账户 \| 获取失败/.test(t), false,
    '答了「没有账户」就不许说成「获取失败」');
  assert.ok(t.includes('账户服务未响应（sacctmgr 超时）'), `原因要原样摆出来：${t}`);
});

// ── 右栏：作业输出 ──────────────────────────────────────────────────────────

/** 一格日志。`text` 走 `op_job_log` 给的那个形状（止于换行，见 paintHalf）。 */
const cellOf = (text, extra = {}) => Object.assign({
  path: '/h/.slurmate/logs/slurm-1.out', bytes: 100, lines: text.split('\n').length,
  truncated: false, mtime: 1, text, why: null,
}, extra);

/**
 * 推一份右边那一栏的数据。`out` / `err` 是日志的两格，而推过去的那个信封里
 * `out` 是 `{out, err}` 整个容器 —— 与 `index.js` 的 `pushOutToHover` 逐字同形。
 * 夹具这里包错一层的话，`renderOut` 拿到的是"一格"，于是每一块都判成 absent，
 *   而症状是"右栏永远说还没有写出任何内容" —— 一个看起来像后端没数据的现象。
 */
const pushOut = (h, out, err, more = {}) => h.subs.data(
  Object.assign({ side: 'right', out: { out, err }, outLines: 200 }, more));

test('右栏两块各画各的，而空的那一块不出现', () => {
  const h = boot();
  pushOut(h, cellOf('宿主的一行\n服务的一行\n'), cellOf('认证被拒\n'));
  assert.match(h.text('out-out'), /服务的一行/);
  assert.match(h.text('out-err'), /认证被拒/);
  assert.doesNotMatch(h.text('out-out'), /认证被拒/, '两块不许串');
  assert.equal(h.byId.get('out-half-err').classList.contains('hidden'), false);

  // 空的那一块不出现（设计律 1）—— 一个空的输出框是在说"这里本该有东西"，
  //   而 `.err` 在正常情况下就是空的。
  pushOut(h, cellOf('宿主的一行\n'), null);
  assert.equal(h.byId.get('out-half-err').classList.contains('hidden'), true,
    '`.err` 是 null，那一块不出现');
});

test('「获取失败」与「确实没有」在右栏里长得必须不同', () => {
  const h = boot();
  pushOut(h, cellOf('', { text: null, why: 'component_group_or_world_writable',
                          bytes: null, lines: null }), null);
  assert.match(h.text('out-out'), /获取失败：component_group_or_world_writable/,
    '文件在、但读不了 —— 要说清是哪一条判据');
  assert.equal(h.byId.get('out-half-out').classList.contains('hidden'), false);

  // 而"确实没有这一份"是不出现，不是一行"获取失败"
  pushOut(h, null, null);
  assert.equal(h.byId.get('out-half-err').classList.contains('hidden'), true);
  assert.doesNotMatch(h.text('out-out'), /获取失败/, '确实没有 ≠ 获取失败');
});

test('追加式绘制：第二帧只接新行，不重画（重画会毁掉用户正在拖的选区）', () => {
  const h = boot();
  const box = () => h.byId.get('out-out');
  pushOut(h, cellOf('A\nB\nC\n'), null);
  assert.equal(h.raw('out-out'), 'A\nB\nC');
  const nodes1 = box().children.length;

  pushOut(h, cellOf('A\nB\nC\nD\nE\n'), null);
  const t = h.raw('out-out');
  assert.equal(t, 'A\nB\nC\nD\nE', '新的两行要接上去，而且接在旧的那一段之后');
  assert.equal((t.match(/C/g) || []).length, 1, '不许把已经画过的重画一遍（重复）');
  assert.equal(box().children.length, nodes1 + 1,
    '只追加了一个节点 —— 若整块重画节点数会变（而那正是毁掉选区的那种做法）');
});

test('窗口滑动之后仍然接得上（尾部视图最常见的那一帧）', () => {
  const h = boot();
  // 第一帧给 1..5，第二帧服务端只回 3..8（`lines` 是窗口，窗口会滑）
  pushOut(h, cellOf('1\n2\n3\n4\n5\n'), null);
  pushOut(h, cellOf('3\n4\n5\n6\n7\n8\n'), null);
  assert.equal(h.raw('out-out'), '1\n2\n3\n4\n5\n6\n7\n8',
    '滑掉的那两行留在 DOM 里（用户翻上去还看得到），新接上的是 6/7/8');
  assert.equal((h.raw('out-out').match(/5/g) || []).length, 1,
    '重叠的那一段不许画第二遍（拿"上一次的末尾"与"这一次的开头"对一遍正是为此）');
});

test('不衔接就整块重画（文件被截断过 / 换过一份）', () => {
  const h = boot();
  pushOut(h, cellOf('甲\n乙\n丙\n'), null);
  pushOut(h, cellOf('戊\n己\n庚\n'), null);
  assert.equal(h.raw('out-out'), '戊\n己\n庚',
    '不相干的两段粘在一起比重新画一遍更坏');
  assert.equal(/[甲乙丙]/.test(h.raw('out-out')), false, '旧的整段要被换掉，不是接在后面');
});

test('末尾那半行不画 —— 它下一次会以完整的样子再出现一遍', () => {
  // 作业正把一行写了一半（还没有换行符）时，日志文件里就是"半句话"。
  //   画出去的话：中间那一刻显示的是半句，而下一帧那一行会完整地再出现一次
  //   （两行一模一样的开头），看起来像服务把同一句说了两遍。
  //   服务端那一头"丢掉窗口开头那半行"是同一条规矩的另一半。
  const h = boot();
  pushOut(h, cellOf('A\nB\n半'), null);
  assert.equal(h.raw('out-out'), 'A\nB', '没写完的那一行不许画出去');
  pushOut(h, cellOf('A\nB\n半行写完了\n'), null);
  assert.equal(h.raw('out-out'), 'A\nB\n半行写完了', '写完了才出现，而且只出现一次');
});

test('「只在贴底时自动滚」—— 用户翻上去看历史时不许把他拽回来', () => {
  const h = boot();
  // 先画一次：元素是 `getElementById` 按需建的，没画过之前 `byId` 里没有它。
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
  assert.equal(box().scrollTop, 10, '用户在看历史 —— 拽回去就是把他正在读的那一段抽走');
});

test('右栏「更多」按下去走桥上的 more()（浮窗自己不去问后端）', async () => {
  const h = boot();
  assert.equal(await h.byId.get('out-more').onclick(), undefined);
  assert.equal(h.calls.more, 1);
});

test('浮窗的滚动条也是我们自己画的，而且永远占着那条槽', () => {
  // 2026-10-11：浮窗是另一个文档（另一个 BrowserWindow），它有自己那份样式表
  //   —— 面板那一边（app.css）画的滚动条管不到这里，所以这一套得在这儿再写一遍。
  //   这也是这个文件头那句"与面板同一套配色"的同一个理由。
  const css = read('hover.css');
  assert.match(css, /::-webkit-scrollbar\s*\{\s*width:\s*\d+px/,
    '宽度要自己定死（若不写露出来的就是系统那一条）');
  assert.match(css, /::-webkit-scrollbar-thumb\s*\{[^}]*border-radius/,
    '滑块要是我们的');
  // 作业输出是一行一行长出来的：不留那条槽，正文会在每一条新输出到来时缩一下。
  const at = css.indexOf('.body {');
  assert.notEqual(at, -1, 'hover.css 里应当有 .body 那一条规则');
  const block = css.slice(at, css.indexOf('}', at));
  assert.match(block, /scrollbar-gutter:\s*stable/,
    '右栏那一块要永远留着那条槽 —— 输出是一行一行长出来的，若不留正文会跟着缩');
  // 同上：`scrollbar-width` / `scrollbar-color` 一旦出现就会盖掉上面那一套。
  for (const f of ['width', 'color']) {
    assert.equal(new RegExp(`scrollbar-${f}\\s*:`).test(css), false,
      `不许写 scrollbar-${f} —— 它会盖掉 ::-webkit-scrollbar 那一套`);
  }
});
