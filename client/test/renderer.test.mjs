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
 * renderer.test.mjs —— 面板页的静态一致性。
 *
 * 本机没有图形环境，panel.js / panel.html 在这里根本跑不起来，所以这一组只做
 * **文本比对**。它拦的是一类在真机上很响、在本机完全无声的错误：
 *
 *   1. panel.js 引用了一个 panel.html 里不存在的元素 id
 *      → 真机上是个 TypeError，面板当场白屏，而 init() 的 catch 只报一句
 *        「界面初始化失败」，指不回是哪个 id。
 *   2. panel.js 调了一个 preload 没有暴露的桥方法
 *      → 同样是 TypeError，且要等用户点下去的那一刻才发生。
 *   3. panel.html 里出现 style="…"
 *      → CSP 没有 unsafe-inline，浏览器**静默丢弃**它，表现是布局莫名其妙不对，
 *        控制台之外没有任何提示。panel.html 文件头专门为此写了注释。
 *   4. 映射图的 CSS 丢了
 *      → SVG <path> 的默认填充是**黑色**而不是透明。少了 fill:none，
 *        每条连线都会糊成一块黑斑，而页面本身不报任何错。
 *
 * 这几条都验证不了「界面好不好用」—— 那只能人工跑一遍。它们只保证界面
 * **不白屏**，这是本机能给出的全部保证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(here, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(R, 'panel.html'), 'utf8');
const js = fs.readFileSync(path.join(R, 'panel.js'), 'utf8');
const css = fs.readFileSync(path.join(R, 'app.css'), 'utf8');
const api = fs.readFileSync(path.join(here, '..', 'src', 'preload', 'api.js'), 'utf8');

/** panel.js 里所有 $('xxx') 的字面量。 */
function idsUsed() {
  const out = new Set();
  for (const m of js.matchAll(/\$\('([^']+)'\)/g)) out.add(m[1]);
  return out;
}

/** panel.html 里所有 id="xxx"。 */
function idsDefined() {
  const out = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) out.add(m[1]);
  return out;
}

/** preload 暴露给渲染进程的方法名（对象字面量里恰好缩进两级的那些键）。 */
function bridgeMethods() {
  const out = new Set();
  for (const m of api.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)) out.add(m[1]);
  return out;
}

/** panel.js 里所有 window.slurmate.xxx( 的调用。 */
function bridgeCalls() {
  const out = new Set();
  for (const m of js.matchAll(/window\.slurmate\.([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1]);
  return out;
}

test('panel.js 用到的每个元素 id 都在 panel.html 里', () => {
  const defined = idsDefined();
  const missing = [...idsUsed()].filter((id) => !defined.has(id)).sort();
  assert.deepEqual(missing, [],
    `panel.js 引用了 panel.html 里不存在的 id：${missing.join('、')}`);
  // 反向不查：panel.html 里有 panel.js 不碰的元素（纯样式钩子）是正常的。
  assert.ok(idsUsed().size > 10, '抽取到的 id 太少，正则多半没匹配上');
});

test('panel.js 调用的每个桥方法 preload 都暴露了', () => {
  const exposed = bridgeMethods();
  const missing = [...bridgeCalls()].filter((m) => !exposed.has(m)).sort();
  assert.deepEqual(missing, [],
    `panel.js 调了 preload 没暴露的方法：${missing.join('、')}`);
  assert.ok(exposed.size > 10, '抽取到的桥方法太少，正则多半没匹配上');
});

test('★ 界面里不许写死任何插件名 —— 按钮必须由清单画出来', () => {
  // ★ 这一条守的是这次改动的要点：**站点装了哪些插件是运行期才知道的**。
  //   写死一个「开始开发」按钮的话，「站点卸掉那个插件」在界面上就变成了
  //   "点了报错"，而不是"那一块不见了" —— 而后者才是用户能正确理解的那件事。
  //
  //   查的是**带引号的字面量**（`'code-server'`），不是裸词：文件头和注释里出现
  //   插件名是在**解释**这套机制，不是在违反它（`panel.html` 顶部那条 CSP 的
  //   检查也是同样的处理）。
  for (const [what, src] of [['panel.js', js], ['panel.html', html]]) {
    for (const name of ['code-server', 'sshd']) {
      const lit = new RegExp(`['"\`]${name}['"\`]`);
      assert.equal(lit.test(src), false,
        `${what} 里出现了插件名的字面量 ${JSON.stringify(name)} —— `
        + '插件块必须从 pluginsView() 画出来，不能写死');
    }
  }
});

test('★ 插件起不来的四条原因，四句话互不相同', () => {
  // 本机跑不起 panel.js（没有图形环境），所以这一条只能做文本检查。它拦的是
  // **把四句话合并成一句**这个退化 —— 合并之后用户看到的是"这个插件用不了"，
  // 而该找管理员、该自己勾一下、该让管理员**重新部署**（不是去开开关）是三件
  // 完全不同的事，只能一个个试。四句话的**内容**对不对，本机验不了。
  const m = /const WHY_NOT_RUNNABLE = \{([\s\S]*?)\n\};/.exec(js);
  assert.ok(m, 'panel.js 里那张四句话的表不见了 —— 结构变了就更新这条检查');
  const vals = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]);
  assert.equal(vals.length, 4,
    `那张表里应当**恰好**四句话，抽到 ${vals.length} 条：${JSON.stringify(vals)}`
    + '（多抽到说明表里混进了别的字面量，少抽到说明有一句被删了）');
  assert.equal(new Set(vals).size, 4, `四句话重了：${JSON.stringify(vals)}`);
  for (const s of vals) {
    assert.ok(s.length >= 12, `这句话太短，等于什么也没说：${JSON.stringify(s)}`);
    assert.match(s, /[一-鿿]/, '要给人看的中文');
  }
  // 「没有作业侧实现」那一句要带上插件名：不带的话用户面对四个插件时不知道
  // 是哪一块灰的（同一个界面上四块长得一样）。
  assert.ok(vals.some((s) => s.includes('%s')), '「没有作业侧」那一句要留出插件名的位置');
});

/**
 * 一个 JS 文件里所有**字符串字面量**的内容（注释里的不算）。
 *
 * ★ 与 `stripJsComments` 是两件事：那个把注释挖掉、把字符串留下（用来查"某句话
 *   在不在代码里"），这个只要字符串本身。查 `**` 这种记号必须用它 —— 注释里
 *   到处都是 `**强调**`，那是写给读代码的人的，不是写给用户的。
 */
function stringLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      let buf = '';
      while (i < src.length) {
        if (src[i] === '\\') { buf += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (src[i] === q) { i++; break; }
        buf += src[i]; i++;
      }
      out.push(buf);
      continue;
    }
    i++;
  }
  return out;
}

test('★★ 界面文字里不许出现 markdown 记号 —— 那些字符串是按**字面**画的', () => {
  // ★★ 这是一个**真的发生过**的缺陷：`el()` / `cel()` / `notice()` 一律走
  //   `textContent`（那样才不会被当成 HTML 插进来），于是写进字符串里的
  //   `**强调**` 和 `★` 会在界面上**原样**显示出来 —— 用户看到的是
  //   「删掉一份**找不回来**」。
  //
  //   ★ 它在本机看不出来：没有图形环境，而所有文本判据读的都是源码 ——
  //     `**` 在源码里是**对的**（那一段注释确实在强调）。只有人眼看得见。
  //   ★ 这条判据与 docs 那三个守卫是同一类东西（`check-doc-style.py` 管的是
  //     公开文档正文里的图形符号），只是它管的是**界面**。
  const BAD = /\*\*|★/;
  for (const f of ['panel.js', 'hover.js', 'dom.js']) {
    const src = f === 'panel.js' ? js : fs.readFileSync(path.join(R, f), 'utf8');
    const hits = stringLiterals(src).filter((s) => BAD.test(s));
    assert.deepEqual(hits, [],
      `${f} 里有 ${hits.length} 处字符串带着 markdown 记号，它们会在界面上原样显示：`
      + `\n${hits.map((h) => '  · ' + h.slice(0, 90)).join('\n')}`
      + '\n★ 要强调就靠位置/颜色/措辞，不要靠记号 —— 这些字符串走的是 textContent。');
  }
});

test('panel.html 里没有内联 style —— CSP 会静默丢掉它', () => {
  // 先把注释去掉：文件头那段注释里就写着 `style="..."` 这几个字，
  // 它是在**解释**这条禁令，不是在违反它。
  const bare = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.equal(/style\s*=/.test(bare), false,
    'panel.html 出现了内联 style —— CSP 无 unsafe-inline，它会被静默丢弃，'
    + '表现是布局莫名其妙不对而没有任何提示。样式一律写进 app.css。');
});

test('映射图的样式在 app.css 里，且连线显式 fill:none', () => {
  for (const sel of ['.wmap-lines', '.wnode', '#statusbar .sb-sel']) {
    assert.ok(css.includes(sel), `app.css 缺少 ${sel}`);
  }
  // SVG <path> 的默认填充是黑色，不是透明。少了这一条，每条连线都会糊成一块黑斑。
  assert.match(css, /\.wmap-lines\s+\.edge\s*\{[^}]*fill:\s*none/,
    '.edge 必须显式 fill:none');
  // 连线的坐标是「节点的 getBoundingClientRect 减去容器的」—— 所以 SVG 必须
  // 绝对定位并贴着容器左上角。掉了这两条，SVG 会变成 grid 的第三个子项被排到
  // 两列下面去，而坐标仍按容器算：线会画到框外面，且不报任何错。
  assert.match(css, /\.wmap\s*\{[^}]*position:\s*relative/, '.wmap 必须是定位容器');
  assert.match(css, /\.wmap-lines\s*\{[^}]*position:\s*absolute/, '.wmap-lines 必须绝对定位');

  // ★★ **三列**：连接 / 工作区 / 数据。两列的话第三列会被 grid **挤到下一行**
  //   （`grid-template-columns` 只声明了两条轨道 ⇒ 第三个子项自动流到第二行），
  //   而 SVG 仍然按容器左上角算坐标 —— 于是数据那一列跑到线画的区域**下面**，
  //   看起来像"图下面多了一排盒子"，没有一行报错。
  assert.match(css, /\.wmap\s*\{[^}]*grid-template-columns:\s*1fr\s+1fr\s+1fr/,
    '★ .wmap 必须是**三**列 —— 少了第三列，数据那一列会被挤到下一行');
  for (const id of ['wmap-conns', 'wmap-workspaces', 'wmap-spaces']) {
    assert.ok(html.includes(`id="${id}"`), `panel.html 缺少 #${id}`);
  }
});

// ── ★★ 三屏（v0.9 阶段 5）────────────────────────────────────────────────────

/** 抠出某一屏那一整段（`#screen-jobs` 这类容器里没有嵌套的 `<section>`）。 */
function screenBlock(id) {
  const m = new RegExp(`<section id="${id}"[\\s\\S]*?</section>`).exec(html);
  assert.ok(m, `panel.html 里找不到 #${id} 那一屏 —— 三屏的容器改名了？`);
  return m[0];
}

test('★★ 三屏都在，而且路由只认这三个 id', () => {
  // ★★ 这一条守的是「打开客户端落在哪一屏」这件事**有唯一一处判据**。
  //   若"露哪一屏"是 renderSnapshot() 按**会话状态**算出来的（空闲露连接列表、
  //   跑起来露当前会话），"用户在哪儿"就没有地方记着 —— 他去作业列表看一眼，
  //   下一次快照回来就被弹回另一屏，而他什么都没做。
  const ids = ['screen-conns', 'screen-plugins', 'screen-jobs'];
  for (const id of ids) screenBlock(id);

  // 路由里**恰好**列着这三个 —— 少一个 = 那一屏永远藏不起来（叠在别的屏上面）；
  // 多一个（比如某个屏被拆成两半）= 露一个的时候另一个还开着。
  const fn = /function showScreen\(name\)[\s\S]*?\n\}/.exec(js);
  assert.ok(fn, 'panel.js 里应当有 showScreen()');
  const listed = [...fn[0].matchAll(/'screen-[a-z]+'/g)].map((m) => m[0]);
  assert.deepEqual(listed.sort(), ids.map((i) => `'${i}'`).sort(),
    `showScreen 里列的屏与 panel.html 里那三屏对不上：${listed.join('、')}`);

  // ★★ **「集群状态」那一层没有了**，而这一条是它留下来的坑：它从前是盖在三屏
  //   上面的一层（`CLUSTER.open ||` 那一格），而那个"第二层"的判据必须**只出现在
  //   这一句里** —— 多一处就是两个"我在哪一屏"。
  //
  //   现在站点状态搬进了边栏浮窗（另一个 renderer，`hover.html`），所以这里守的是
  //   **反面**：`showScreen` 里不许再出现任何"第二层"的判据。留着一条查
  //   `CLUSTER.open` **出现过**的断言的话，它会在删掉那一层之后永远绿 —— 而它守的
  //   那件事（只有一个地方决定露什么）恰恰是要继续守的。
  //
  //   ★ 同时钉住：三屏的显隐就是这一句，不多不少。变异：把 `key !== name` 改成
  //     常量真/假，这条当场红。
  assert.match(fn[0], /classList\.toggle\('hidden',\s*key !== name\)/,
    '三屏的显隐要在**这一句**里按路由算（不是别处，也不带第二层的条件）');
  //   ★ 查的是**用到了它**（`CLUSTER.` 这个格子、那个 id 的 DOM 查询），不是
  //     "文件里出现过这几个字"—— 注释里留着"它搬去哪了"是刻意的，而那种断言会
  //     把一段解释也判成红。
  assert.ok(!/CLUSTER\./.test(js) && !/\$\('sec-cluster'\)/.test(js),
    '「集群状态」那一层整个删掉了 —— panel.js 里不该再有那个格子或那个 DOM 查询');

  // 路由由 init() 起手 —— 少了这一句，`SCREEN` 是上次的值而 page 上是第一屏，
  // 两份"我在哪一屏"会漂，漂的形态是"点了返回，页面没动"。
  assert.match(js, /showScreen\('conns'\)/, '开局必须显式落在第一屏');

  // ★ 第二屏的标题要**带上是哪一个站点**（"我现在看的是哪一台"），而判据是
  //   **主进程给的活跃连接**，不是"我刚才点了哪一行" —— 后者在删掉一条连接、
  //   或从别处改了活跃连接之后就已经过期，而它指着的那条连接可能已经不存在了。
  assert.match(fn[0], /plugins-title/, '第二屏的标题要在路由里按当前站点写一次');
  assert.match(fn[0], /activeConnectionId/,
    '★ 而它的判据必须是**主进程给的活跃连接**，不是界面自己记的"刚才点了谁"');
});

test('★★ 用例 12：作业列表那一屏的三个动作按钮，两侧逐字相同', () => {
  // ★ 这三个按钮就是计划里那个「三个动作」：【新建】= `op_submit`、
  //   【接管】= `takeover`、【结束】= `goodbye`。
  //
  //   ★ 它比上面那条通用的 id 检查强在哪：那一条只查「panel.js 用到的 id 在
  //     panel.html 里都有」，所以**把按钮整个删掉**它一个字都不会说
  //     （用的人也一起没了）。这一条钉的是"这三个按钮必须存在、必须绑了动作、
  //     必须待在作业列表那一屏里"。
  const jobs = screenBlock('screen-jobs');
  const trio = [
    ['btn-jobs-new', '新建'],
    ['btn-jobs-takeover', '接管'],
    ['btn-jobs-end', '结束'],
  ];
  for (const [id, what] of trio) {
    assert.match(jobs, new RegExp(`id="${id}"`),
      `${what}按钮（#${id}）必须在作业列表那一屏里`);
    assert.match(js, new RegExp(`\\$\\('${id}'\\)\\.onclick\\s*=`),
      `panel.js 没有给 ${what}按钮（#${id}）绑动作 —— 点了没反应`);
  }
  // 而它们**只在这一屏里**：同一个 id 出现两次的话，`getElementById` 取到的是
  // 第一个，第二个那颗按钮永远点不动（而它看起来完全正常）。
  for (const [id] of trio) {
    const n = [...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length;
    assert.equal(n, 1, `#${id} 在 panel.html 里出现了 ${n} 次`);
  }
});

test('★ 作业列表那一屏只说服务端给的事实，不自己编', () => {
  // ★ 「会话状态」与「作业状态」是**两张表**：会话 `suspect` 的时候作业可能
  //   好好地跑着（见 src/main/sessionstate.js）。作业那一行**不做任何状态判定**，
  //   它印的是主进程译好的那一格（`state_text`）。
  //
  //   查的是 `jobRow` 这个函数体，不是整个文件 —— `STATE_TEXT`（**客户端**会话
  //   状态那张表）在状态条与标签栏里是正当用途，全局查会把那些一起误伤。
  const rowFn = /function jobRow\(j\)[\s\S]*?\n\}/.exec(js);
  assert.ok(rowFn, 'panel.js 里应当有 jobRow()');
  assert.match(rowFn[0], /j\.state_text/, '作业那一行要印主进程译好的 state_text');
  assert.equal(/STATE_TEXT/.test(rowFn[0]), false,
    '★ 作业那一行不许拿**客户端会话状态**那张表去译服务端的状态（两张表别混：'
    + '会话 suspect 的时候作业可能好好地跑着）');

  // ★ 三态：**取不到**与**确实没有**必须长得不一样。把"问不到"画成"没有作业"，
  //   用户会以为自己的作业丢了 —— 而真正的原因在连接那一侧。
  assert.match(js, /function renderJobs\(\)[\s\S]*?\$\('jobs-error'\)/,
    'renderJobs 必须把"取不到"单独画出来');

  // ★ 没接着的那些**照实说**，而且说清出路 —— 那一行的按钮是灰的，
  //   而"为什么点不动"不能靠猜（出路是重连一次，`doConnect` 会跑 tryReattach）。
  assert.match(js, /j\.attached/, 'renderJobs 必须读 attached（动作只给本机接着的那些）');
  //   ★★ 查的是**那一格元素**，不是"文件里出现过「没接着」"：`jobRow` 上面那段
  //     注释里就有这三个字，所以那种查法是一条**永远绿的空断言** —— 变异验证
  //     实测：把这一句整个删掉，查"出现过"的判据一个字都不说。
  assert.match(rowFn[0], /cel\('span',\s*'warn',/,
    '没接着的那些要真的画出一格话（`cel(\'span\', \'warn\', …)`），而不是留一个灰按钮');
  // ★ 「谁在看这条会话」也是**服务端给的事实**（`keeper_text`，由 index.js 的
  //   `jobsView` 译好）—— 界面印它，不自己按 `keeper` 编一句话。
  //   ★★ 它同时是失败形态 ③ 的另一半（"看护者清空之后界面上要画得出那句话"）：
  //      这一查落在 **`jobRow` 的函数体**里，不落在"整个文件里出现过「没人在看」"上
  //      —— 后者是一条永远绿的断言（旁边那段注释里就有那几个字）。
  assert.match(rowFn[0], /j\.keeper_text/,
    '作业那一行要印主进程译好的 keeper_text（本机在看 / 另一台电脑在看 / 没人在看）');
});

test('★★【临时离开】与【断开】：两个方向相反的动作，各自只有一个入口', () => {
  // ★★ 这两个按钮对作业做的事**正好相反** —— 一个发 `leave`（看护者置空、作业继续
  //    跑），一个发 `goodbye`（作业被 `scancel`）—— 而它们在界面上挨着。
  //    ⇒ 判据只能是"它们绑到两个不同的函数上，而且各自**只**调用自己那一个通道"。
  //      共用一个实现、或者互相调对方的通道，症状都是**"点了临时离开，作业被停了"**：
  //      一句与提示相反的、不可撤销的事实。
  const conns = screenBlock('screen-conns');
  for (const [id, what] of [['btn-leave', '临时离开'], ['btn-disconnect', '断开']]) {
    assert.match(conns, new RegExp(`id="${id}"`),
      `${what}按钮（#${id}）必须在连接列表那一屏里`);
    assert.match(js, new RegExp(`\\$\\('${id}'\\)\\.onclick\\s*=`),
      `panel.js 没给 ${what}绑动作 —— 点了没反应`);
  }

  const leaveFn = /async function doLeave\(\)[\s\S]*?\n\}/.exec(js);
  const discFn = /async function doDisconnect\(\)[\s\S]*?\n\}/.exec(js);
  assert.ok(leaveFn && discFn, 'panel.js 里应当有 doLeave() 与 doDisconnect()');
  assert.match(leaveFn[0], /slurmate\.leave\(/, '【临时离开】要发 `leave`');
  assert.equal(/slurmate\.disconnect\(/.test(leaveFn[0]), false,
    '★★ 【临时离开】**绝不许**顺手断开 —— 那会把作业 scancel 掉，而提示说它还在跑');
  assert.match(discFn[0], /slurmate\.disconnect\(/, '【断开】要发 `goodbye`');
  assert.equal(/slurmate\.leave\(/.test(discFn[0]), false,
    '★★ 【断开】**绝不许**走 `leave` 那条路 —— 那会让它和【临时离开】长得一模一样');
  // 全程只有一处调 `leave`：多一处就是"同一条规矩的第二份实现"，而它会漂。
  assert.equal([...js.matchAll(/slurmate\.leave\(/g)].length, 1,
    '`leave` 只该在 doLeave 里被调用一次');

  // ★★ 两个按钮的显隐**必须一起**跟着 `connected` 走。少了「临时离开」那一句，
  //    它会永远停在初始的 `hidden` 上 —— 一个**存在、绑了动作、但永远不出现**的
  //    按钮，比没有它更坏：读代码的人会以为这条路走得通。
  //    ★ 查的是**那一句表达式本身**，不是"函数体里出现过 `btn-leave`"（后者在
  //      下面 `renderConnections` 那一大段里到处都是，是一条永远绿的断言）。
  const rcFn = /function renderConnections\(list\)[\s\S]*?\n\}/.exec(js);
  assert.ok(rcFn, 'panel.js 里应当有 renderConnections()');
  for (const id of ['btn-leave', 'btn-disconnect']) {
    assert.match(rcFn[0],
      new RegExp(`\\$\\('${id}'\\)\\.classList\\.toggle\\('hidden',\\s*!connected\\)`),
      `#${id} 要跟着 connected 一起显隐（这一句里，不是别处）`);
  }

  // ★★ 那句最要紧的话必须**画在函数体里**（失败形态 ③ 的判据落在函数体上，
  //    不落在调用点上）：离开**不是暂停**，倒计时从这一刻起算。
  //    ★ 不说的话，用户以为离开是免费的：合上电脑出差，回来时作业已经没了，
  //      而界面上从来没有任何一句话预告过。
  //
  //    ★★ 查的是**成功那一路的那整句话**，不是"函数体里出现过「35 分钟」"：
  //      `doLeave` 里"35 分钟"出现**两次**（另一处在"没能告诉控制节点"那一路），
  //      所以查"出现过"是一条**能被等价变异蒙过去的**判据 —— 变异验证实测：
  //      把这一句整个删掉，那条查"出现过"的断言一个字都不说。
  assert.match(leaveFn[0], /35 分钟内没有人回来接着看/,
    '★★ doLeave 必须把"没人看着它 35 分钟就会被回收"说出来');
  // ★ 而按钮自己的 title 也要写出后果 —— 不点下去也看得见。
  assert.match(conns, /id="btn-leave"[\s\S]{0,240}?35 分钟/,
    '#btn-leave 的 title 里要写明后果（临时离开不是免费的）');

  // ★★ 「被接管」那句话由**主进程**给（`suspend()` 的那句原因），界面只印。
  //    两处各写一句的漂法是"主进程说被接管了、界面说被顶掉了"—— 而用户会去查
  //    一个并不存在的区别。（这一版把触发方式从"服务端顶掉整个客户端"收窄成
  //    "另一台电脑接管了这条作业"，旧措辞在界面上不该留下一处。）
  const codeOnly = stripJsComments(js);
  assert.equal(/顶掉/.test(codeOnly), false,
    '★ 界面上不该再出现"顶掉"这个说法 —— 现在发生的是**逐会话**的接管');
  assert.match(codeOnly, /s\.suspended/,
    '状态条与明细要印主进程给的那句原因，而不是自己编一句');
});

test('★★ 三处不可逆动作都走**两段式**，而且两段都收得回来', () => {
  // ★★ 设计律 2：不可逆的动作由"必须先经过的那一步"承载，而不是一句写在旁边的
  //   说明。机制本身（第一下不发请求、第二下才发、取消回到原样、两个监听摘干净）
  //   的判据在 `renderer-dom.test.mjs`；这里守的是**绑定** —— 本机跑不起
  //   `init()`（那一组用例把它整段摘掉了），所以"那颗按钮点下去走的是哪条路"
  //   只有这里判得了。
  //
  // ★ 而这条规矩最容易烂的方式是**漏一处**：三颗按钮在界面上长得都不一样，
  //   少一颗在真机上看不出来 —— 除非你真的按下去，而那时已经来不及了。
  //
  // ★★ 为什么不用 `window.confirm`：它给不了两段（框弹出来的时候用户已经按下去
  //   了），样式也不受控（Electron 里那是一块系统窗口，尺寸、语言、焦点行为都不
  //   归我们管）—— 于是同一个客户端里三处不可逆动作会长得不一样。
  for (const [id, what] of [['sb-end', '状态条上的「结束会话」'],
                            ['btn-disconnect', '「断开」']]) {
    const at = js.indexOf(`$('${id}').onclick =`);
    assert.notEqual(at, -1, `panel.js 没给${what}（#${id}）绑动作`);
    assert.match(js.slice(at, at + 700), new RegExp(`armConfirm\\(\\$\\('${id}'\\)`),
      `★★ ${what}必须走两段式 —— 它会把集群上正在跑的作业取消掉`);
  }
  assert.match(js, /armConfirm\(del,/,
    '★★ 删除连接必须走两段式 —— 它连带销毁这条连接的私钥');

  // ★★ 「断开」那一行里必须带上**有几个作业会没**。只说"确定断开吗"，用户答不了：
  //   他不知道代价是 1 个会话还是 5 个。
  const discAt = js.indexOf("$('btn-disconnect').onclick =");
  const disc = js.slice(discAt, discAt + 700);
  assert.match(disc, /liveCount\(\)/,
    '★ 条数要问 `liveCount()` —— 与 `allowSwitchTo`、`#dev-restart` **同一份定义**，'
    + '各写一遍的话，漂开的方向是"这个框说 2 条、那个框说 1 条"');
  assert.match(disc, /\$\{n\} 个会话/, '要把**几条**说出来');

  // ★★ 两条"收得回来"的规矩。写错了在真机上都是**静默**的：
  //   · 会话一停，那一格就不该再等着第二段（按下去没有对象了）；
  //   · 重画那一屏之前必须先收掉 —— 那一行连同确认一起被丢掉，而 `armed` 还指着
  //     一个不在文档里的节点：用户接着点"别处"看起来没反应，而下一次真正的第一段
  //     会被这个幽灵顶掉。
  assert.match(js, /if \(!running\) disarmArmed\(\);/,
    '★★ 会话停下之后要把那个第一段收掉（它挂在 `running` 那一格的判断里）');
  const rcFn2 = /function renderConnections\(list\)[\s\S]*?\n\}/.exec(js);
  assert.ok(rcFn2, 'panel.js 里应当有 renderConnections()');
  assert.match(rcFn2[0], /disarmArmed\(\)/,
    '★★ 重画连接列表之前先收掉没走完的第一段');
});

test('★ 「关于」的入口是标题那一行，而开发者模式整个搬进去了', () => {
  // ★ 入口**必须看得见能点**：这一屏上没有任何别的东西提示"这里可以点"，
  //   而一个看不见的入口等于没有入口（悬停变色是唯一的提示）。
  assert.match(html, /id="about-head"/, 'panel.html 里要有那个入口');
  assert.match(css, /#about-head\s*\{[^}]*cursor:\s*pointer/,
    '★ 那个入口要看得出来能点 —— 少了 cursor，它长得就是一行普通标题');
  assert.match(js, /const aboutHead = \$\('about-head'\);/,
    'panel.js 里找不到那个入口');
  assert.match(js, /aboutHead\.onclick = toggleAbout;/,
    '★ panel.js 没给它绑动作 —— 点了没反应。而那正是最难查的一种：'
    + '界面上一切正常，只是这个入口按下去什么都不发生');
  assert.match(js, /aboutHead\.onkeydown[\s\S]{0,120}?Enter/,
    '★ 它是一个 `role="button"` 的 div（button 里放不下 h1/p），所以回车那条路'
    + '要自己接 —— 不接的话它 Tab 得到、按下去没反应');

  // ★ 它装的是「关于」+ 开发者模式，而开发者模式**从前是常驻的**：搬进来之后
  //   它必须整个在 `#sec-about` **里面**。留在外面的话，"收起来"就只收掉了说明，
  //   开关还挂在主界面上 —— 而这一版的全部目的就是把主界面让出来。
  const sec = /<section id="sec-about"[\s\S]*?<\/section>/.exec(html);
  assert.ok(sec, 'panel.html 里应当有 #sec-about');
  const bare = sec[0].replace(/<!--[\s\S]*?-->/g, '');
  for (const id of ['dev-on', 'dev-pending', 'dev-restart', 'dev-src', 'dev-src-path',
                    'dev-src-count', 'dev-pick', 'dev-reset-src', 'dev-debug']) {
    assert.ok(bare.includes(`id="${id}"`),
      `#${id} 要搬进 #sec-about 里面 —— 留在外面就是"收起来了但开关还在"`);
  }
  // ★ 调试开关那 10 颗按钮一个都不许少（它们存在的全部理由就是造出真集群上造不
  //   出来的状态，少一颗就少验一条路）。数目钉着，多一颗也要看一眼。
  assert.equal([...bare.matchAll(/data-debug="/g)].length, 10,
    '调试开关那 10 颗按钮要一起搬进来');

  // ★ 状态条那格**留着**：会话跑起来之后窗口主体被原生视图盖住，那是唯一还看得见
  //   开发者模式的地方。
  assert.match(html, /id="sb-dev"/, '★ 状态条那格不能跟着搬走');
  assert.match(js, /\$\('sb-dev'\)\.classList\.toggle\('hidden',\s*!\(s && s\.dev\)\)/,
    '★ 而它仍然由前台那一条的 `dev` 驱动');

  // ★ 「从前那两段」压成了一句 —— 它是干什么的留下，它是**给谁用的**删掉（名字
  //   自己说）。★ 只数**开发者模式那一段自己**（到 `#dev-src` 为止）：底下
  //   `#dev-src` / `#dev-debug` 各自那句说明不在这条判据里，它们说的是各自那一块
  //   怎么用，不是"这个模式是什么"。
  const head = sec[0].slice(sec[0].indexOf('<h3>开发者模式</h3>'),
    sec[0].indexOf('<div id="dev-src"'));
  assert.equal([...head.matchAll(/<p class="sub">/g)].length, 1,
    '开发者模式那一段只留一句 —— 多一句就是那两段又长回来了');
});

test('★★ 删掉的那些长解释：一个都不许回来，而承重的那句换了地方住', () => {
  // ★ 这一版的减字是**逐处指定去向**的（见 plan 里那张表），而"删干净"这件事
  //   没有任何东西会替我们看着：一句话删掉之后，代码里少一行，谁也不报错。
  //   半年后有人"顺手把有用的说明加回来"，缺的就是这一条。
  //
  // ★★ 而每一条都要**说清它去哪了** —— 只判"不在"的话，把承重的那一句一起删掉
  //   也能全绿。
  const htmlBare = html.replace(/<!--[\s\S]*?-->/g, '');

  // ① `#conn-notes`（两个出口的区别 + 不会自动连）⇒ 删。
  //    承重的那一句（35 分钟被回收）搬到了 `#btn-leave` 的 title 里（下面那一条判）。
  assert.equal(htmlBare.includes('id="conn-notes"'), false,
    '★ #conn-notes 删掉了 —— "不自动连"由界面自己说（打开就停在这一屏），'
    + '"两个出口相反"由那两颗按钮的措辞与颜色说');
  assert.equal(/\$\('conn-notes'\)/.test(js), false, 'panel.js 里那一句 toggle 也要删');

  // ② `#purpose-hint`（随机挑分区 / 自动续期 / 默认资源）⇒ 删。
  //    "随机挑"在下拉的选项文字里，"默认资源"在每一块插件里。
  assert.equal(htmlBare.includes('id="purpose-hint"'), false,
    '★ #purpose-hint 删掉了（"随机挑"在下拉那一项里，默认资源在插件块里）');
  assert.equal(/purpose-hint/.test(js), false, 'panel.js 里也不该再有它');

  // ③ `#sec-workspaces` 那两段说明 ⇒ 删；**后果**（工作区什么时候被回收）改成
  //    那个标题的一行 title。
  assert.equal((screenBlock('screen-conns').match(/<p class="sub">/g) || []).length, 0,
    '★ 第一屏里那几段长说明都删掉了 —— 映射图就是那个关系');
  assert.match(html, /<h3 title="没有连接在用、也没有会话在跑的工作区会被自动删掉[^"]*">/,
    '★ 而"工作区会被自动回收"是**后果**，不是解释 —— 它要换成一个 title 留下来');

  // ④ `#sec-dev` 那个容器整个没了（内容是搬走，不是复制一份）。
  assert.equal(htmlBare.includes('id="sec-dev"'), false,
    '★ #sec-dev 那个容器删掉了 —— 内容搬进 #sec-about，留下一个空壳等于两处都能改');

  // ⑤ `#sec-data` 那段统论（"一份 = 一个插件 + 共享组 + 工作区"、"一份数据有两个
  //    落点"）⇒ 删。它说的是**每一行自己就在说**的话（`placesText` 逐行说清它在
  //    浏览器里、在磁盘上还是两处都有）。★ 而「这一轮清掉了 N 份」**留着** ——
  //    那是**结果**，不是解释。
  assert.equal(/一份 = 一个插件 \+ 共享组 \+ 工作区/.test(js), false,
    '★ #sec-data 那段统论删掉了 —— 一段说不出单行说不出的事，只会让人多读一遍');
  assert.match(js, /function placesText/,
    '★ 而"这一份在哪儿"没有跟着丢 —— 它改成**逐行**说了');

  // ⑥ 作业屏底部那一句 ⇒ 换成 `#btn-jobs-end` 的 title。
  assert.equal(/关掉窗口同样会结束会话<\/strong>/.test(html), false,
    '★ 那一句从作业屏底部搬走了 —— 它是**那颗按钮的后果**，摆在一屏末尾等于'
    + '让人先读完再回头看是哪一颗');
  const endBtn = /<button id="btn-jobs-end"[^>]*>/.exec(html);
  assert.ok(endBtn, '找不到 #btn-jobs-end');
  assert.match(endBtn[0], /title="[^"]*合盖、断网、断电不会/,
    '★★ 而它必须**搬进那颗按钮的 title** —— 只判"不在页面上"的话，'
    + '把这条承重的后果一起删掉也能全绿（同形：`#btn-leave` 的 title）');
  //   ★ 与 `#btn-leave` 那个 title 同形：都说清"另一个出口/另一条路会怎样"。
  assert.match(screenBlock('screen-jobs'), /id="btn-jobs-end"[\s\S]{0,400}?title="/,
    'title 要挂在那颗按钮自己身上');
});

test('★★ 换站点那道闸：连着一条、而它上面还有会话在跑时，不切', () => {
  // ★★ 客户端只保持**一条活跃连接**（产品约定，见 KNOWN-ISSUES 的 S26(a)）。
  //    连着 A 的时候点 B，A 上那些正在跑的会话从此**不再被这台电脑看护**
  //    （心跳没了 ⇒ 300 秒 `suspect`、1800 秒 `orphaned`、然后 `scancel`），
  //    而用户点那个按钮的时候未必是这么想的。
  //    ⇒ 有会话在跑时**不切**，并且**把话说清楚**：几条、当前是哪一条、
  //      该去按哪两个按钮。只说"确定吗"，用户答不了 —— 他不知道代价是什么。
  const gate = /function allowSwitchTo\(connId\)[\s\S]*?\n\}/.exec(js);
  assert.ok(gate, 'panel.js 里应当有 allowSwitchTo()');
  assert.match(gate[0], /liveCount\(\)/,
    '条数要问 `liveCount()` —— 与【断开】、【重启】**同一份定义**，各写一遍就会漂');
  assert.match(gate[0], /window\.alert\(/,
    '★ 用 alert 而不是 confirm：这里**没有第二个选项**可给（那句话不是"确定吗"）');
  assert.match(gate[0], /\$\{n\} 条会话/,
    '要点名**几条** —— 只说"确定吗"，用户答不了');
  assert.match(gate[0], /【临时离开】/, '要说出去哪两个按钮');
  assert.match(gate[0], /【断开】/, '★ 两个都要说 —— 一个作业继续跑，一个把作业停掉');
  assert.match(gate[0], /connLabel\(cur\)/,
    '要点名**当前连着的是哪一条** —— 这一屏上可能有好几条，说"当前这条"指不出来');

  // ★★ 判据落在**动词的次序**上：拦下时 `setActiveConnection` 一次都不许被调到 ——
  //    它一调，配置里"活跃连接"就已经是新那条了，而实际连着的是旧那条，
  //    两份事实从此对不上（下一次启动会重连到用户没打算去的那台）。
  const fn = /async function doConnectTo\(c\)[\s\S]*?\n\}/.exec(js);
  assert.ok(fn, 'panel.js 里应当有 doConnectTo()');
  const gi = fn[0].indexOf('allowSwitchTo(');
  const si = fn[0].indexOf('setActiveConnection(');
  assert.notEqual(gi, -1, 'doConnectTo 必须先过那道闸');
  assert.ok(gi < si,
    '★★ 闸要在 `setActiveConnection` **之前** —— 反过来的话，"拦下"这件事发生时'
    + '活跃连接已经被改掉了');

  // ★ 「保存并连接」是**第二个**能换站点的入口：少了这道闸，用户从「新建连接」
  //   那条路照样绕得过去，而"不许换"就成了摆设。
  const save = /\$\('btn-save'\)\.onclick = async \(\) => \{[\s\S]*?\n  \};/.exec(js);
  assert.ok(save, "panel.js 里应当有 btn-save 的处理函数");
  const bi = save[0].indexOf('allowSwitchTo(');
  assert.notEqual(bi, -1, '「保存并连接」那条路也要过同一道闸');
  const bj = save[0].indexOf('boot.activeConnectionId = saved.connection.id');
  assert.notEqual(bj, -1, '这条路上还是要把它设成活跃的（连的就是它）');
  assert.ok(bi < bj,
    '★ 闸要在**改 `boot.activeConnectionId` 之前**问 —— 改完之后"这次要连的是不是'
    + '另一条"就永远问不出真话了（那一刻它已经等于目标）');

  // ★★ 而**编辑**一条连接那条路一个字都不许碰它：那个按钮这时写的是「保存」
  //    （不是「保存并连接」），主进程那边活跃连接也一个字都没动
  //    （`app:saveConnection` 只在从来没有活跃连接时才设它）。把它指过去的话，
  //    界面会当场把一条**没连着**的连接画成「已连接」—— 而"哪一条连着"是这一屏
  //    上最要紧的一格。同一个赋值**若放在** `if (editing)` 之前，`wasLive` 那个
  //    比较就恒为真：「这条连接正连着」这句会被念给一条没连着的连接。
  const ei = save[0].indexOf('if (editing)');
  assert.notEqual(ei, -1, '编辑那条路还在这个函数里');
  assert.ok(bj > ei,
    '★★ `boot.activeConnectionId = …` 必须排在 `if (editing)` **之后**（只有真的'
    + '去连它时才设），否则编辑一条没连着的连接会把它画成「已连接」');
  const wi = save[0].indexOf('const wasLive =');
  assert.ok(wi !== -1 && wi < bj,
    '★ `wasLive` 要在**改它之前**算 —— 之后算的话那个比较恒为真');
});

test('panel.js 不用 window.prompt —— 它在 Electron 里直接抛异常', () => {
  // 不是返回 null，是抛 "prompt() is and will not be supported"。
  // 改名走的是页面内的 <input>（见 startRename）。
  assert.equal(/window\.prompt\s*\(/.test(js), false);
});

test('新增的两个工作区通道同时登记在 preload 与 panel.js 两侧', () => {
  // 少一边都是「点了没反应」：preload 少了 → 调不到方法；panel.js 少了 → 没有入口。
  for (const m of ['setConnectionWorkspace', 'renameWorkspace']) {
    assert.ok(bridgeMethods().has(m), `preload 没暴露 ${m}`);
  }
  assert.ok(bridgeCalls().has('setConnectionWorkspace'), 'panel.js 没有调用 setConnectionWorkspace');
  assert.ok(bridgeCalls().has('renameWorkspace'), 'panel.js 没有调用 renameWorkspace');
});

test('★★ 分叉弹窗的三个按钮：必须存在、必须绑了动作，而且不能有第四个答案', () => {
  // ★ 它比上面那条通用的 id 检查强在哪：那一条只查「panel.js 用到的 id 在
  //   panel.html 里都有」，所以**把一个按钮整个删掉**它一个字都不会说
  //   （用的人也一起没了）。而这一格少一个按钮的后果是：用户**没有别的路可走**，
  //   只能选剩下的那一个 —— 而"把另外几条连接一起改了"是不可逆的。
  const dlg = /<dialog id="fork-dlg">[\s\S]*?<\/dialog>/.exec(html);
  assert.ok(dlg, 'panel.html 里应当有 #fork-dlg —— 共用的一张表要靠它来问');
  const trio = [
    ['fork-all', "'all'"],
    ['fork-one', "'fork'"],
  ];
  for (const [bid, val] of trio) {
    assert.match(dlg[0], new RegExp(`id="${bid}"`), `#${bid} 必须在那个对话框里`);
    assert.match(js, new RegExp(`\\$\\('${bid}'\\)\\.onclick\\s*=\\s*\\(\\) => done\\(${val}\\)`),
      `panel.js 没有把 #${bid} 绑到 ${val} —— 点了没反应，或者绑错了答案`);
  }
  // 取消是第三个按钮，而且它**回的必须是 null**（"没选"与"选了某一边"是两件事：
  // 前者调用方什么都不发，后者要带 scope 重发一次）。
  assert.match(dlg[0], /id="fork-cancel"/);
  assert.match(js, /\$\('fork-cancel'\)\.onclick\s*=\s*\(\) => done\(null\)/);
  // Esc 也要回"没选" —— 少了这一句，Promise 永远悬着，那一格从此再也改不动。
  assert.match(js, /dlg\.oncancel\s*=\s*\(\) => resolve\(null\)/);
  // ★ 而它**不是** window.confirm：三个答案塞不进两个按钮，而"确定"在同一句话里
  //   可以指任意一个 —— 用户点下去分不清自己选的是哪个。
  //   （查的是**去掉注释**之后的那一段：解释这条禁令的那句注释本身会让检查红掉。）
  const askFn = /function askFork[\s\S]*?\n\}/.exec(stripJsComments(js))[0];
  assert.equal(/confirm\(/.test(askFn), false,
    'askFork 里不许出现 confirm —— confirm 只有两个按钮，而这里有三个答案');
});

/**
 * 去掉 JS 里的注释，字符串原样留下。
 *
 * ★ 必须去注释，否则**解释这条禁令的那段注释本身**会让检查红掉 —— 这个文件里
 *   上面那条 `style=` 的检查就踩过同一个坑（它对 HTML 先剥了注释）。
 *   括号与引号按出现顺序配对，够用；不认识的形态只会让检查**多红一次**
 *   （看得见），不会让它悄悄变绿。
 */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === c) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

test('★ 来源标签整个没了：界面不许自己按来源分支', () => {
  // ★ 这条检查的理由：界面不许自己按"这份东西从哪来"分支 —— 客户端只有一个插件根
  //   （站点池），来源不是一个可以拿来分支的事实。`sourceLabel` 那套字段同理：
  //   留着一套永远说不出话的字段，与留一个永远说错的标签是同一类东西。
  //
  //   ★ 它留着的意义是**封印**：哪天有人把来源标签加回界面，它必须红 —— 那时正确
  //     的做法是先回答"有几个根、它们各自凭什么免同意"（§5.2 禁止任何例外）。
  const code = stripJsComments(js);

  for (const bad of [/\bp\.source\b/, /\bp\.sources\b/, /\bp\.sourceLabel\b/, /plug-src/]) {
    assert.equal(bad.test(code), false,
      `panel.js 又在按来源分支了（${bad}）—— 客户端只有一个插件根（站点池），`
      + '来源不是一个可以拿来分支的事实');
  }
});

test('★ 本机池那几个入口从 preload / panel.js / panel.html 三处一起删干净了', () => {
  // ★ 与前面那条「panel.js 调用的每个桥方法 preload 都暴露了」是**一对**：
  //   那边查"面板调了而桥没了"，这边查"桥还在而面板已经不调了" —— 而后者在那边
  //   是**静默的**（单向检查看不见它）。本机池不存在，那五个入口两边都不该再有。
  for (const m of ['installPlugin', 'uninstallPlugin', 'rescanPlugins',
                   'openPluginDir', 'setDevPlugins']) {
    assert.equal(bridgeMethods().has(m), false,
      `preload 还暴露着 ${m} —— 本机池那五个入口整个删掉了`);
  }

  const code = stripJsComments(js);
  // ★ **「开发者模式」这四个字出现在 panel.js 里是对的** —— 它指的是换掉整个后端
  //   （见「★ 开发者模式的三个动词」那一条），不是多加载一个目录。真正的判据是
  //   "有没有教用户往目录里放东西的入口"，也就是下面这几串。
  for (const s of ['从一个包安装', '打开插件目录', '重新扫描',
                   '本机插件目录', '也加载本机插件目录']) {
    assert.equal(code.includes(s), false,
      `panel.js 里还有「${s}」—— 那个入口（或者那句教用户去做的话）不存在了`);
  }
  // ★ 查的是**有没有那个元素**，不是文件里有没有那串字 —— panel.html 里留了一段
  //   注释解释它去哪了，而注释里当然写着那个 id。
  const htmlBare = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.equal(htmlBare.includes('plugin-dev'), false,
    'panel.html 里还留着 #plugin-dev 那个容器');
});

test('★ 开发者模式那四个入口同时登记在 preload / panel.js / panel.html 三侧', () => {
  // 与前面那两条同一个道理：少一边就是"点了没反应"（桥没暴露 ⇒ 调不到方法；
  // 面板没调 ⇒ 没有入口；HTML 里没那个 id ⇒ 面板一上来就 TypeError 白屏）。
  //
  // ★ 这四个动词是这一版**新加**的，而且它们的"没反应"格外难查：开关点了之后
  //   界面本来就不该有变化（要重启才生效），所以"点了没反应"与"正常"长得一样。
  for (const m of ['setDeveloperMode', 'pickDevPluginDir', 'clearDevPluginDir', 'restart']) {
    assert.ok(bridgeMethods().has(m), `preload 没暴露 ${m}`);
    assert.ok(bridgeCalls().has(m), `panel.js 没有调用 ${m}`);
  }
  const htmlBare = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const id of ['dev-on', 'dev-pick', 'dev-reset-src', 'dev-restart',
                    'dev-pending', 'dev-src-count']) {
    assert.ok(htmlBare.includes(`id="${id}"`), `panel.html 缺少 #${id}`);
  }
});

test('★ 开发者模式：「想要的」与「生效的」在界面上必须分得开', () => {
  // ★ 这一节的全部难点就是两个值不是一回事（见主进程里 `dev` / `devSaved` 那段）：
  //   复选框画的是**用户要的那个**（画生效值的话，点完它会自己弹回去，看起来像
  //   开关坏了），而调试开关那一块画的是**生效值**（假后端没在跑，那些按钮按下去
  //   只会回一句"仅开发者模式可用"）。
  //
  //   把两处对调，或者全都用一个值：界面上都**不会报错**，只会"点了没反应"或者
  //   "有按钮但按下去就报错"。本机跑不起 panel.js，所以这一条只能钉住那两行文本 ——
  //   断言失败时会指回是哪一个错了。
  const code = stripJsComments(js);
  assert.match(code, /\$\('dev-on'\)\.checked = Boolean\(d\.saved\)/,
    '复选框要画 **saved**（用户要的那个），不是 on');
  assert.match(code, /\$\('dev-debug'\)\.classList\.toggle\('hidden', !d\.on\)/,
    '调试开关那一块要画 **on**（这次进程真的在不在开发者模式）');
  assert.match(code, /有改动等着重启/,
    '两侧不一致时必须说出来 —— 不说的话，用户勾了开关、界面没变，'
    + '他会以为功能坏了（更糟的是他以为没生效，重启之后进了沙盒对着假集群干活）');
});

test('★ 站点分发那四条桥同时登记在 preload 与 panel.js 两侧', () => {
  // ★ 标题里的"四条"与下面列表的项数必须一致。
  // 少一边都是「点了没反应」：preload 少了 → 调不到方法；panel.js 少了 → 没有入口。
  for (const m of ['syncPlugins', 'consentPlugin', 'rejectPlugin', 'onPlugins']) {
    assert.ok(bridgeMethods().has(m), `preload 没暴露 ${m}`);
  }
  assert.ok(bridgeCalls().has('syncPlugins'), 'panel.js 没有调用 syncPlugins');
  assert.ok(bridgeCalls().has('consentPlugin'), 'panel.js 没有调用 consentPlugin');
  assert.ok(bridgeCalls().has('rejectPlugin'), 'panel.js 没有调用 rejectPlugin');
  assert.ok(bridgeCalls().has('onPlugins'), 'panel.js 没有订阅 onPlugins');
});

test('★ 同意界面必须把「你不会得到什么保护」说出来', () => {
  // ★ 这不是文案洁癖，是**这一版唯一的安全边界**：进程隔离（S2）还没做，所以
  //   同意一个带客户端代码的插件 = 把工作站的代码执行权交给集群管理员。含糊的
  //   「是否信任此插件」会让用户以为自己在同意 A 而实际同意了 B。
  //
  //   文字检查只能验"那句话还在"，验不了它够不够清楚 —— 那是人读的。
  const code = stripJsComments(js);
  assert.match(code, /没有进程隔离/,
    '同意那一块必须说清"目前没有进程隔离" —— 那是用户在做决定时唯一缺的那条信息');
  assert.match(code, /在你这台机器上运行/,
    '同意那一块必须说清客户端代码会在本机运行');
  // 第二次之后的同意要显示**变了什么**，只显示一个新摘要等于什么也没说。
  assert.match(code, /与上次同意的一致|变成了/, '同意的界面要能说出"内容变了"');
});

test('★ 开发者模式里的每个调试按钮在主进程里都有对应的动作', () => {
  // 真机上「按钮点了没反应」与「这个动作根本不存在」长得一模一样：控制台安静，
  // 界面不动。而这些调试开关存在的**全部理由**就是造出真集群上造不出来的状态 ——
  // 一个哑按钮直接让那条状态退回"造不出来"，而这一点在本机看不出来（没有图形环境）。
  //
  // ★ 站点分发那几个尤其要紧：它们的**回退方式互不相同**（不支持分发只说一句话、
  //   插件太大与限流各自走另一条路），少一个就少验一条路。
  const main = fs.readFileSync(path.join(here, '..', 'src', 'main', 'index.js'), 'utf8');
  const buttons = new Set([...html.matchAll(/data-debug="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(buttons.size >= 4, '调试开关的按钮一个都没找到？');
  const handled = new Set([...main.matchAll(/what === '([^']+)'/g)].map((m) => m[1]));
  const missing = [...buttons].filter((b) => !handled.has(b));
  assert.deepEqual(missing, [],
    `这些按钮在主进程里没有对应的动作：${missing.join('、')}`);
});

test('★ 「站点太新」那一句必须按握手结论分叉（并钉住两种措辞）', () => {
  // ★ 加版本握手之前，"站点比客户端新"只能靠 `package.format` 比 `FORMAT` 大**推断**
  //   出来 —— 那时它是唯一能说的话。
  // ★ 握手之后，客户端手里有服务端的**真版本号**了，于是这句话必须被检验过：
  //   · 跨大版本 ⇒ "站点是新一代"是对的，那时候格式更新本就在预期之内；
  //   · 其它情形 ⇒ 握手说客户端不低于服务端，服务端**不可能更新** ⇒ 格式比客户端
  //     新只可能是**站点自己不一致**（版本号没升而格式升了）。此时说"升级客户端"
  //     会把用户指去干一件**解决不了问题**的事。
  const code = stripJsComments(js);
  assert.match(code, /site\.daemonVersionVerdict === 'cross_major'/,
    '这一句没有按握手结论分叉 —— 判定归 pluginsView（它算 daemonVersionVerdict），'
    + '界面只负责按它选一句话');
  assert.match(code, /请升级这个客户端/, '跨大版本那一支少了"升级客户端"这个动作');
  assert.match(code, /升级客户端解决不了它/,
    '另一支必须**明确否掉**"升级客户端" —— 那是用户看了这句话唯一会去做的事，'
    + '而它对"站点自己不一致"这种情况没有用');
});

test('★ 删插件数据的确认框要说清**删的是哪几样**（磁盘上那份也得讲）', () => {
  const at = js.indexOf('async function dropPluginData');
  assert.notEqual(at, -1, 'panel.js 里找不到 dropPluginData 了');
  const body = js.slice(at, at + 1200);
  // ★ 两个落点不能混成一句：浏览器那份是布局/标签页/登录状态，而磁盘那份是插件
  //   自己写的文件 —— 后者正是作者最可能放"重建不出来"的东西的地方。两者都不可逆，
  //   但**用户能预期的东西不同**，所以确认框必须分叉。
  assert.match(body, /places/, '要按 places 分叉，而不是所有情况念同一句');
  assert.match(body, /写在磁盘上的文件/, '含磁盘那一份时必须把它说出来');
  // 清单里也要说清"这一份在哪儿"（用户看到的是一行行，每行是什么得看得出来）。
  assert.match(js, /function placesText/, '清单里的每一行都要说清它在哪几个落点');
});

test('★ 删连接与切走工作区都要说清「连带删掉那个工作区的数据」，而删连接是两段式', () => {
  // ★ 这一条与 boot.test.mjs 那条**行为**断言是成对的（「删掉最后一条用某个工作区的
  //   连接 ⇒ 那个工作区的两份数据一起清掉」）。只留一边都不成立：
  //   · 只有行为断言 ⇒ 真删了而文案没提 = 没有知情同意；
  //   · 只有文本断言 ⇒ 文案说了而实现没做 = 一句不成立的承诺。
  //
  // ★ 判据必须是"**最后一条**"而不是"删一条就删数据"：还有别的连接指着那个工作区时，
  //   数据留着（下一会话还要用它）。文案说错这一点的后果与"没说"一样严重 ——
  //   它把一件**没有发生**的事告诉了用户。
  //
  // ★★ 这一版「删除连接」改成了**两段式**（见 panel.js 的 `armConfirm`）：后果那句
  //   话现在坐在第一段那一行里。判据跟着挪，而"必须说清后果"这条一个字没松。
  const delAt = js.indexOf('del.onclick = () => {');
  assert.notEqual(delAt, -1, 'panel.js 里找不到「删除连接」那一段了');
  const del = js.slice(delAt, delAt + 1800);
  assert.match(del, /soleOwnerId/,
    '判据要用 workspacePlan 的 soleOwnerId —— 它与主进程数的是同一件事');
  assert.match(del, /写在磁盘上的那些文件/, '要说到插件写在磁盘上的那一份');
  assert.match(del, /armConfirm\(del,/,
    '★ 删除连接要走两段式 —— 它是这一屏上唯一一个删掉私钥的动作');
  assert.equal(/window\.confirm/.test(del), false,
    '★ 那两处 `window.confirm` 一并去掉了：它给不了两段（框弹出来的时候用户'
    + '已经按下去了），样式也不受控（Electron 里那是一块系统窗口）');

  const cdAt = js.indexOf('function confirmDiscard');
  assert.notEqual(cdAt, -1, 'panel.js 里找不到 confirmDiscard 了');
  const cd = js.slice(cdAt, cdAt + 900);
  assert.match(cd, /插件写在磁盘上的那些文件/,
    '切走一个工作区也是回收它 —— 磁盘那一份同样会跟着走');
});

test('★ 主进程发来的 warn 不许被折成 info（显示成信息的失败 = 被吞掉的失败）', () => {
  // 这一条钉的是一处**最坏形状**：`onNotice` 若把除 ok/error 之外的一切都画成
  // 「信息」，"工作区已删除，但它的浏览器存储没能清干净"这条**警告**就会在日志里长成
  // 「信息」—— 那样 `notice()` 的标签表里 `warn: '注意'` 成了一段死代码（没人产生得了
  // 那个 kind）。一条显示成信息的失败，与一条被吞掉的失败是同一件事。
  assert.match(js, /\['ok', 'error', 'warn'\]\s*\.includes\(n\.kind\)/,
    'onNotice 那条路要把 warn 原样传下去 —— 折成 info 的话，主进程说的"注意"就没了');
  assert.equal(/n\.kind === 'ok' \? 'ok' : n\.kind === 'error' \? 'error' : 'info'/.test(js),
    false, '又回到那个三元表达式了');
});

test('★★ 多开这一份载荷：通道名与字段名，四处必须逐字一致', () => {
  // 这个文件是**唯一**的防线 —— 本机起不了 Electron，panel.js 跑不起来。
  // ★ 纯文本比对**查不出载荷字段改名**：`.snap` 与 `snap:` 都长得对。多开这一版
  //   的载荷正好是"改错了不报错、只是某一格永远显示 undefined"那一类，所以这一条
  //   要真的去比**生产端造出来的键**与**消费端读的键**。
  const main = fs.readFileSync(path.join(here, '..', 'src', 'main', 'index.js'), 'utf8');
  // ★ 发这条通道的是 **windows.js**（`pushSessions`），不是 index.js —— 写错文件的话
  //   这一条会永远红，而红的原因是"测试找错了地方"，不是代码错了。
  const winSrc = fs.readFileSync(path.join(here, '..', 'src', 'main', 'windows.js'), 'utf8');

  // 通道名：主进程发 → preload 订阅 → panel.js 用。
  assert.match(winSrc, /send\('session:states'/, 'windows.js 要发 session:states');
  assert.match(api, /'session:states'/, 'preload 要订阅 session:states');
  assert.ok(bridgeCalls().has('onStates'), 'panel.js 要用 onStates 订阅');
  // ★ 旧的单值那条路必须**删干净** —— 留着它就是留第二条路，而两条路会分叉。
  assert.equal(/'session:state'/.test(api), false, 'session:state（单数）必须删掉');
  assert.equal(/\bonState\b/.test(api), false, 'onState（单数）必须删掉');
  assert.equal(/\bstate:\s*\(\)/.test(api), false, 'state()（单数）必须删掉');

  // 字段名：panel.js 读的每一个，都必须在 index.js 的 sessionViews() 里被写出来。
  const built = /function sessionViews\(\)[\s\S]*?\n\}/.exec(main);
  assert.ok(built, 'index.js 里应当有 sessionViews()');
  for (const f of ['slot', 'service', 'live', 'temporary', 'snap']) {
    assert.match(built[0], new RegExp(`\\b${f}\\b`), `sessionViews 没给出 ${f}`);
    assert.match(js, new RegExp(`\\.${f}\\b`), `panel.js 没读 ${f}`);
  }
  // 切前台与停会话都要**指名 slot** —— 不收名字的 stop 在多开下会停错另一条。
  assert.ok(bridgeCalls().has('setFront'), 'panel.js 没有调用 setFront');
  assert.match(js, /slurmate\.stop\(slot\)/, '停会话必须把 slot 传下去');
});

test('★ 标签栏在这 30px 里 —— 它下面是原生视图，放外面等于永远点不到', () => {
  const bar = /<div id="statusbar"[\s\S]*?<\/div>/.exec(html);
  assert.ok(bar, '找不到状态条');
  assert.match(bar[0], /id="session-tabs"/,
    '会话标签必须在状态条**里面**：窗口主体被原生视图整块盖住');
  assert.match(css, /--bar-h:\s*30px/, '状态条高度还是那个常量');
});

test('★ 工作区选择器只在**前台那条会话真的有那一份数据**时露出来', () => {
  // 前台是中转站时（spaceId 为 null）选择器还露着的话，用户改了**没反应** ——
  // 那条路径（outsideWorkspace）两条分支都不走，而界面上一切正常。
  assert.match(js, /sb-workspace-wrap[\s\S]{0,260}?s\.spaceId/,
    'sb-workspace-wrap 的露出条件里必须有 spaceId');
  // ★ 而会话手里是**一份数据**、用户认的是**工作区** —— 两者由引用表对上，
  //   所以还要有一条按 id 反查的路径（`frontWorkspaceId`）。少了它，状态条上的
  //   选择器在会话跑着的时候会停在"活跃连接那个工作区"上，而那可能不是它跑的那个。
  assert.match(js, /function frontWorkspaceId\(\)[\s\S]{0,500}?lastSnap\.spaceId/,
    'frontWorkspaceId 要按那一份数据的 id 反查工作区');
});

test('★★ 「临时副本」那条提示**两处都有**，而状态条那一份是必须的', () => {
  // ★ 为什么状态条那一份不是锦上添花：会话一跑起来，窗口主体就被原生视图整块
  //   盖住（只有前台那块 setVisible(true)，从状态条下沿铺到底），面板里那一份
  //   跟着被盖住 —— 而那正是**最需要看见这句话的时候**（用户正要在里面干活）。
  //   `#sb-dev` 就是为同一件事待在那 30px 里的先例。
  //   这里测不了"看得见"（本机无图形环境），测的是**它在不在那个盒子里**。
  const bar = /<div id="statusbar"[\s\S]*?<\/div>/.exec(html);
  assert.ok(bar, '找不到状态条');
  assert.match(bar[0], /id="sb-temp"/,
    '★ 状态条里必须有一条「临时副本」，否则会话跑起来之后它就被盖住了');
  assert.match(html, /id="temp-banner"/, '面板里那一份也要在（面板还露着的时候靠它）');

  // ★ 而两条都由**前台那一条的 `temporary`** 驱动 —— 不是"发生过什么"。
  //   它是一条**常驻**状态：只要那一份还开着，这句话就成立。
  assert.match(js, /function frontTemporary\(\)[\s\S]{0,700}?temporary/,
    'frontTemporary 读的是主进程给的那一格');
  assert.match(js, /const temp = frontTemporary\(\)/,
    '前台那一条的 temporary 要先取出来（两处共用同一个值）');
  for (const id of ['sb-temp', 'temp-banner']) {
    const line = new RegExp(`\\$\\('${id}'\\)\\.classList\\.toggle\\([^)]*\\)`).exec(js);
    assert.ok(line, `${id} 要有一个 classList.toggle`);
    assert.match(line[0], /\btemp\b/,
      `${id} 的露出条件必须来自 frontTemporary()：${line[0]}`);
  }

  // ★ **颜色另起一个**：洋红在这个仓库里等于「假后端」（三重互锁的第二重），
  //   复用会把两件毫不相干的事说成一件 —— 临时副本是真实的会话、真实的作业。
  assert.match(css, /--temp:\s*#/, '要有一个自己的颜色变量');
  const tempTag = /\.temp-tag\s*\{[^}]*\}/.exec(css);
  assert.ok(tempTag, '找不到 .temp-tag 那条样式');
  assert.match(tempTag[0], /var\(--temp\)/, '它用的是自己那个颜色');
  assert.equal(/--dev/.test(tempTag[0]), false, '★ 不许复用洋红（那是假后端的记号）');
});

test('★★ 站点侧的插件问题：同一句话在守护进程与界面里逐字相同', () => {
  // ★ 这一条守的是**这条链的最后一环**：站点算出来的诊断得有人画。
  //   账本 F35 的形状就是"算出来了、没送出去"—— `audit()` 算得对、用例全绿，
  //   而那一句提示**永远到不了界面**，因为中间某一节把字段丢了。
  //
  //   ★ 本机跑不起 panel.js（没有图形环境），所以这里只能做文本检查：判"它读了
  //     那个字段、而且用的是那句话"。**字段到没到回包**由 `boot.test.mjs` 那条
  //     端到端用例判 —— 两条合起来才是完整的那条线。
  const SAID = '插件有问题（已跳过，其余插件照常工作）';

  assert.ok(js.includes(`'${SAID}'`),
    `panel.js 里没有画站点侧那几个问题（找不到 ${JSON.stringify(SAID)}）。`
    + '抬头要**原样**用守护进程那一句 —— 改写成界面口气的话，'
    + '运维会以为是另一种毛病，然后去查一条不存在的原因。');
  assert.ok(/pv\.problems/.test(js),
    'panel.js 必须读 `pv.problems`（站点侧的那些）。少了它，那个字段从守护进程'
    + '一路算到回包、却没有一个读方 —— 正是 F35 那个形状。');

  // ★ 与守护进程**逐字相同**：那句话现在有**两处**（`--check` 的 ⚠ 与 `start()`
  //   的日志）。数目也钉着 —— 添一处而不改这里，说明同一条规则多了一种说法。
  //
  //   ★ `--check-plugins` 那句（`插件错误: …`）**不在**这个数里，而且不该在：
  //     那一屏不读站点配置，它说的是"这个包本身装不装得上"，主语与时候都不同。
  const daemon = fs.readFileSync(
    path.join(here, '..', '..', 'cluster', 'slurmate-sessiond'), 'utf8');
  // ★ 匹配的是「那句话 + `：%s`」而不是整条字面量：`--check` 那一处前面还缀着
  //   `  ⚠ `（终端上的记号），照着带引号的原样找会漏掉它 —— 而漏掉之后
  //   期望值 2 会变成 1，红在一个与措辞无关的地方。
  const n = daemon.split(`${SAID}：%s`).length - 1;
  assert.equal(n, 2,
    `守护进程里那句话应当**恰好两处**（--check 与 start 的日志），实际 ${n} 处。`
    + '多出来的一处要么是新的说法（那就得想清楚界面该跟哪一句），'
    + '要么是有人把 `--check-plugins` 那句也统一了 —— 而那两句**故意不同**。');
});

test('★★ 缺省时限：界面照站点报的那一格画，缺席时不许编一个', () => {
  // ★ 这一条钉的是**到界面为止**的那一段。守护进程把 `defaults.time` 算出来、
  //   回包带上它，由 `cluster/test-sessiond-logic.py` 与 `boot.test.mjs` 判；
  //   而"界面真的把它画出来"只有这里能判 —— 本机跑不起 panel.js，所以是文本检查。
  //
  //   ★ 少了这一条，整条链断在最末一格：值一路算到客户端、进了视图、**没有一个
  //     地方显示它**，而所有用例照样绿。那正是 F35 的形状（算出来了没送出去），
  //     而它恰恰是这次加 `defaults.time` 的全部理由。
  assert.match(js, /默认 \$\{def\.cpus\} 核 \/ \$\{def\.mem\}\$\{def\.time/,
    'panel.js 里「默认 …」那句话必须把时限**接在同一句里**。'
    + '单独再写一句"默认时限 …"的话，「默认资源」这件事在界面上就有两个出处，'
    + '而站点是在同一格 `defaults` 里报的这三项。');

  // ★ 三态：`defaults.time` 缺席（v0.5 的守护进程只报 cpus / mem，见
  //   backend-fake 的 `_noDistribute` 那一档）⇒ **不说**，而不是编一个。
  //   兜底写 `def.time || '12:00:00'` 的话，用户看到一个站点从没承诺过的数字，
  //   而他的会话到点真的会被 `TimeLimit` 砍掉 —— 那时他手里那句话是假的。
  assert.ok(!/def\.time\s*\|\|/.test(js),
    '不许给缺席的那一格兜底编一个值（`def.time || …`）。'
    + '缺席 ≠ 有一个我们替他挑的默认 —— 那是两份真相，而且是错的那一份。');
});

test('★★ 缺省卡那一格：界面画主进程译好的那串，没配就不画', () => {
  // ★ 卡那一格与时限**同一句话**（`默认 2 核 / 8G / 12:00:00 / gpu:a6000 × 1`）——
  //   它们回答的是同一个问题，而站点也是在同一个 `defaults` 里报的。
  //
  //   ★ 但拼法不同：核 / 内存 / 时限都是**标量**，界面直接摆出来就对；卡是**描述符**，
  //     要译成 `gpu:a6000 × 1`，而那个译法**全客户端只有一处**（`gres.js` 的
  //     `gresText`，主进程在 `pluginsView` 里调它）。渲染层自己拼的话，同一个插件
  //     在选择器里与在插件卡片上会有两个拼法，而两边都没错、只是不一样。
  assert.match(js, /\+ \(p\.defaultsGresText \? ` \/ \$\{p\.defaultsGresText\}` : ''\)/,
    'panel.js 里「默认 …」那句话必须把**主进程译好的**卡那一串接上。'
    + '自己拼 `name:type × n` 就是第二个拼法。');

  // ★ 三态里的两态：没配（`null`）与老守护进程（那一格不在）**都不说**，
  //   而不是显示 "undefined" / "null" / 一个编出来的 `0 张`。
  assert.ok(!/defaultsGresText\s*\|\|/.test(js),
    '不许给没配的那一格兜底编一个值 —— 那会让一个不占卡的插件显示成占卡。');
});

test('★★ GRES 下拉里「用默认」与「不占」是两项 —— 发出去的东西不一样', () => {
  // ★★ 这两项**不是**同一件事（`''` 与 `none` 发出去的东西不同）：
  //     · `''`   = **不碰**（连这个字段都不发）⇒ 服务端用**这个插件的**
  //       `default_gpus`（站点可以在那个插件的配置里配默认卡，那是稀缺算力政策）。
  //     · `none` = **显式不占** ⇒ 发 `gres: null`，盖过插件的默认。
  //
  //   少了第二项，站点的默认卡就是一道用户**无法拒绝**的命令 —— 而管理员拍的是
  //   "默认"，不是"任何人都不许说不"。★ 协议那半边的判据在守护进程里
  //   （`"gres" in req`，见 `cluster/test-sessiond-logic.py` 的 N5 那条变异），
  //   这里只能钉住"界面确实发了 `null`"这半截 —— 本机跑不起 panel.js。
  assert.match(js, /none\.value = 'none'/,
    '下拉里必须有「不占」那一项（value = none）—— 它与第一项不是一回事。');
  assert.match(js, /res\.gres = null/,
    '选了「不占」要发**显式 `null`**：不发这个键的话，服务端只会照插件的默认来，'
    + '而用户恰恰是在说"我不要"。');
  assert.match(js, /gi === 'none'/,
    '默认值发 null 这条分支必须在 startWith 里真的接上（只建选项不接分支 = 没生效）。');
});

test('★★ 自动回收的留痕：清掉过东西时那一屏不许藏，而且要说得出清掉了什么', () => {
  // ★★ 这一条守的是 F35 那个形状的又一站：`reclaimOrphans` 算得对、回包里也带上了，
  //    而**界面把它藏了**。全程没有任何东西会红 —— 算的那一半有用例，丢的那一半没有。
  //
  //    具体的坑是那条"没东西可列就把这一屏收起来"的短路：自动回收把孤儿清干净之后
  //    `rows` 正好是**空的**，于是「本次运行清掉了 N 份」这句话**永远画不出来** ——
  //    而它正是「删的是自动化，不是可见性」这句唯一的兑现处。
  assert.ok(/d\.reclaimed/.test(js),
    'panel.js 必须读回包里那一格 —— 不读的话，那一步删除就是**用户看不见的**');

  const m = /if \(!rows\.length([^)]*)\)\s*\{\s*sec\.classList\.add\('hidden'\);/.exec(js);
  assert.ok(m, '找不到 renderPluginData 里"什么情况下把这一屏藏起来"那条判断');
  assert.match(m[1], /didReclaim/,
    '★★ "清单是空的就把这一屏收起来"那条短路必须把"这一次收掉过东西"算进去。'
    + `现在的条件是 \`!rows.length${m[1]}\` —— 清干净之后正好是空的，`
    + '那句留痕就永远看不见了（而那正是它唯一该出现的时候）。');

  // ★★ **那一行得挂在"收掉过东西"这个条件上，而且那个条件得是真的。**
  //   这一条是**变异验证判出来的**：上面几条全是"某句文本在不在"，而把
  //   `if (reclaimed.count > 0)` 换成 `if (false)` 之后，句句都在、**一个字都不画**，
  //   而那几条照样全绿。判"它写了"与判"它会画"是两件事。
  assert.match(js, /if \(reclaimed\.count > 0\) \{/,
    '★ 那一行前面的条件必须是 `reclaimed.count > 0` —— 去掉它（或者换成一个恒假的'
    + '条件）之后，代码还在、那句话永远不出现，而只看"文本在不在"的断言照样绿');

  // ★ 而且话要说满：几份、都是谁。只说个数字的话，用户没法判断被删的是不是
  //   他想要的东西。
  assert.match(js, /本次运行清掉了 \$\{reclaimed\.count\} 份/,
    '那一行要说出**收掉了几份**（"本次运行"——那一格是累计的，见 index.js 的 '
    + '`lastReclaim`；写成"本次启动"在第二轮对账之后就不准了）');
  assert.match(js, /reclaimed\.items/,
    '也要说得出**是哪几份**（`items` 里的 label）—— 只给个数字等于让用户干瞪眼');

  // ★ 清不掉的那一半同样要说：报成功而东西还在的话，下一次对账会把同一行再列出来，
  //   而用户会以为"我明明删过了"。
  assert.match(js, /reclaimed\.failed/,
    '没能清掉的那些也要如实说（不然它们会在下一次对账里原地复活）');
});
