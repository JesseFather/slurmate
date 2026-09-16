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

test('★ 来源标签：界面只画，判定在主进程 —— 而且单来源时不贴', () => {
  // ★ 这条检查**翻过面了**，按它自己当年写下的方式翻的。
  //
  //   上一版它断言"panel.js 里不许出现 `p.source`"，理由是那时的客户端只注册了
  //   一个 root（池），于是 `source === 'pool'` **恒为真** —— 一个永远显示、
  //   并且永远说错的标签比没有标签更糟。它当年把话说完了：将来真的有了第二个
  //   root，**正确的做法不是删掉这条检查**，而是把标签按那时的 `sources` 加回来，
  //   再改成一条正面用例。现在（站点分发 + 本机池）就是那个时候。
  //
  //   ★ 判定**搬到了主进程**（`pluginsView()` 的 `sourceLabel`），因为判据是
  //     "有几个来源"，而只有主进程知道注册表挂了几个 root。界面留在文本检查层面
  //     能验的东西只有"它只画、不判"。
  const code = stripJsComments(js);

  // ① 界面**不再**自己按来源分支 —— 那种分支曾经恒为真。
  assert.equal(/\bp\.source\b/.test(code), false,
    'panel.js 又在自己判来源了 —— 判定归主进程（pluginsView 的 sourceLabel），'
    + '界面只负责画');
  assert.equal(/\bp\.sources\b/.test(code), false,
    'panel.js 在读 sources —— 它拿不到"有几个 root"这个事实，判定会与它分家');

  // ② 但它**必须画**那个标签（否则第二个来源进来时界面上什么也看不出来）。
  assert.match(code, /p\.sourceLabel/, 'panel.js 没有画 sourceLabel —— 有两个来源时用户分不清哪一份是谁给的');
  assert.ok(/['"]plug-src['"]/.test(code), 'sourceLabel 那个 <span> 的 class 不见了');
});

test('★ 站点分发那四条桥同时登记在 preload 与 panel.js 两侧', () => {
  // 少一边都是「点了没反应」：preload 少了 → 调不到方法；panel.js 少了 → 没有入口。
  for (const m of ['syncPlugins', 'consentPlugin', 'rejectPlugin', 'setDevPlugins', 'onPlugins']) {
    assert.ok(bridgeMethods().has(m), `preload 没暴露 ${m}`);
  }
  assert.ok(bridgeCalls().has('syncPlugins'), 'panel.js 没有调用 syncPlugins');
  assert.ok(bridgeCalls().has('consentPlugin'), 'panel.js 没有调用 consentPlugin');
  assert.ok(bridgeCalls().has('rejectPlugin'), 'panel.js 没有调用 rejectPlugin');
  assert.ok(bridgeCalls().has('setDevPlugins'), 'panel.js 没有调用 setDevPlugins');
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
