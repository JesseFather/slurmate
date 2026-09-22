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

test('★ 来源标签整个没了：界面不许自己按来源分支', () => {
  // ★ 这条检查翻过两次面，两次都是按它自己当年写下的方式翻的，把过程留着：
  //
  //   ① 最早它断言"panel.js 里不许出现 `p.source`" —— 那时只注册了一个 root，
  //      于是 `source === 'pool'` **恒为真**：一个永远显示、并且永远说错的标签
  //      比没有标签更糟。它当年把话说完了 —— 将来真的有了第二个 root，**正确的
  //      做法不是删掉这条检查**，而是把标签按那时的 `sources` 加回来。
  //   ② 后来真有了第二个 root（站点分发 + 本机池），判定搬到了主进程
  //      （`pluginsView()` 的 `sourceLabel`），这条改成"界面只画、不判"。
  //   ③ 现在**第二个 root 也没了** —— 本机池整个删掉，只剩站点池一个。于是那个
  //      数组恒为一项、那个标签恒为 `null`，`sourceLabelOf` 恒返回 null。
  //      **留着一套永远说不出话的字段，与留一个永远说错的标签是同一类东西。**
  //      所以标签连同它那半判定一起删了。
  //
  //   ★ 而这条检查**留着**，因为它的理由还在：界面不许自己按"这份东西从哪来"
  //     分支。哪天有人把来源标签加回界面，它必须红 —— 那时正确的做法是先回答
  //     "有几个根、它们各自凭什么免同意"（§5.2 禁止任何例外）。
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
  //   是**静默的**（单向检查看不见它）。本机池那五个入口整个删掉了，两边都不该
  //   再有任何一处留着。
  for (const m of ['installPlugin', 'uninstallPlugin', 'rescanPlugins',
                   'openPluginDir', 'setDevPlugins']) {
    assert.equal(bridgeMethods().has(m), false,
      `preload 还暴露着 ${m} —— 本机池那五个入口整个删掉了`);
  }

  const code = stripJsComments(js);
  // ★ 这一串里**从前有「开发者模式」**（旧那一个：一个"也加载本机插件目录"的
  //   复选框）。它随本机池一起没了 —— 而后来**另一个**开发者模式在同一个位置上
  //   长了出来（见「★ 开发者模式的三个动词」那一条）：它换的是整个后端，不是
  //   多加载一个目录。所以这四个字今天出现在 panel.js 里是**对的**；真正的判据是
  //   "有没有那个教用户往目录里放东西的入口"，也就是下面这几串。
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
  // ★ 标题里的"四条"从前是**错的**：列表里有五项（多出一个 setDevPlugins）。
  //   那个开关随本机池删掉之后，这个标题第一次是真的。
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

test('★ 主进程发来的 warn 不许被折成 info（显示成信息的失败 = 被吞掉的失败）', () => {
  // 这一条钉的是一处**真的发生过**的错：`onNotice` 从前把除 ok/error 之外的一切都画成
  // 「信息」，于是"布局组已删除，但它的浏览器存储没能清干净"这条**警告**在日志里长成了
  // 「信息」—— 而 `notice()` 的标签表里 `warn: '注意'` 一直是一段死代码（没人产生得了
  // 那个 kind）。一条显示成信息的失败，与一条被吞掉的失败是同一件事。
  assert.match(js, /\['ok', 'error', 'warn'\]\s*\.includes\(n\.kind\)/,
    'onNotice 那条路要把 warn 原样传下去 —— 折成 info 的话，主进程说的"注意"就没了');
  assert.equal(/n\.kind === 'ok' \? 'ok' : n\.kind === 'error' \? 'error' : 'info'/.test(js),
    false, '又回到那个三元表达式了');
});
