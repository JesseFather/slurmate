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

test('panel.html 里没有内联 style —— CSP 会静默丢掉它', () => {
  // 先把注释去掉：文件头那段注释里就写着 `style="..."` 这几个字，
  // 它是在**解释**这条禁令，不是在违反它。
  const bare = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.equal(/style\s*=/.test(bare), false,
    'panel.html 出现了内联 style —— CSP 无 unsafe-inline，它会被静默丢弃，'
    + '表现是布局莫名其妙不对而没有任何提示。样式一律写进 app.css。');
});

test('映射图的样式在 app.css 里，且连线显式 fill:none', () => {
  for (const sel of ['.lmap-lines', '.lnode', '#statusbar .sb-sel']) {
    assert.ok(css.includes(sel), `app.css 缺少 ${sel}`);
  }
  // SVG <path> 的默认填充是黑色，不是透明。少了这一条，每条连线都会糊成一块黑斑。
  assert.match(css, /\.lmap-lines\s+\.edge\s*\{[^}]*fill:\s*none/,
    '.edge 必须显式 fill:none');
  // 连线的坐标是「节点的 getBoundingClientRect 减去容器的」—— 所以 SVG 必须
  // 绝对定位并贴着容器左上角。掉了这两条，SVG 会变成 grid 的第三个子项被排到
  // 两列下面去，而坐标仍按容器算：线会画到框外面，且不报任何错。
  assert.match(css, /\.lmap\s*\{[^}]*position:\s*relative/, '.lmap 必须是定位容器');
  assert.match(css, /\.lmap-lines\s*\{[^}]*position:\s*absolute/, '.lmap-lines 必须绝对定位');
});

test('panel.js 不用 window.prompt —— 它在 Electron 里直接抛异常', () => {
  // 不是返回 null，是抛 "prompt() is and will not be supported"。
  // 改名走的是页面内的 <input>（见 startRename）。
  assert.equal(/window\.prompt\s*\(/.test(js), false);
});

test('新增的两个布局通道同时登记在 preload 与 panel.js 两侧', () => {
  // 少一边都是「点了没反应」：preload 少了 → 调不到方法；panel.js 少了 → 没有入口。
  for (const m of ['setConnectionLayout', 'renameLayout']) {
    assert.ok(bridgeMethods().has(m), `preload 没暴露 ${m}`);
  }
  assert.ok(bridgeCalls().has('setConnectionLayout'), 'panel.js 没有调用 setConnectionLayout');
  assert.ok(bridgeCalls().has('renameLayout'), 'panel.js 没有调用 renameLayout');
});
