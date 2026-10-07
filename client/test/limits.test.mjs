/**
 * limits.test.mjs —— 那几个"同一个数写了两遍"的地方。
 *
 * ★★ 这些数此前**没有任何交叉校验**：`tools/checks.yml` 只比对四处版本号与几个
 *   COPY_SKIP 集合。而它们的漂法是静默的 —— 服务端钳到 64、界面上写 32，
 *   表现是"我明明填了 32 却拿到了 64"？不，是**反过来**：界面拦住了用户，
 *   而服务端那道闸从此再也没人走到过。两个方向都不会红任何东西。
 *
 * ★ 这一份用例是**跨文件**的，它读的是源码文本 —— 与 19.11d 那条（CLI 与守护
 *   进程各写一遍的读上限）同一形状。判据是"两处的数必须相等"，而不是"某个数
 *   等于多少"：值本身可以改，改一处漏另一处不行。
 *
 * ★ 而 **GRES 没有上限写在这里**，那是有意的：一个作业能要几个由**集群自己配了
 *   几个**决定（`per_node_max`），代码里写死一个数就是替所有站点做同一个决定
 *   —— 从前那个 `MAX_GPUS_REQUEST = 8` 正是这么来的，每节点 16 张卡的站点也只能
 *   要 8 张。所以这里最后两条断言守的是"它**没有**回来"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');
const DAEMON = path.join(ROOT, 'cluster', 'slurmate-sessiond');
const PANEL_HTML = path.join(ROOT, 'client', 'src', 'renderer', 'panel.html');
const FAKE = path.join(ROOT, 'client', 'src', 'main', 'backend-fake.js');
const LIMITS_JSON = path.join(ROOT, 'tools', 'plugin-limits.json');

const daemon = fs.readFileSync(DAEMON, 'utf8');
const html = fs.readFileSync(PANEL_HTML, 'utf8');
const fake = fs.readFileSync(FAKE, 'utf8');

/** 从源码里抠一个 `[const] 名字 = 数字` 的常量。抠不到就抛（不返回 undefined）。 */
function constOf(src, name, file) {
  const m = new RegExp(`^(?:const\\s+)?${name}\\s*=\\s*(\\d+)`, 'm').exec(src);
  assert.ok(m, `${file} 里找不到 ${name} —— 正则没匹配上，还是它改名了？`);
  return Number(m[1]);
}

test('★★ MAX_CPUS_REQUEST：守护进程、界面、假后端三处一致', () => {
  const d = constOf(daemon, 'MAX_CPUS_REQUEST', 'slurmate-sessiond');
  // 界面那一格：`<input ... id="f-cpus" min="1" max="64" ...>`
  const m = /id="f-cpus"[^>]*\bmax="(\d+)"/.exec(html);
  assert.ok(m, 'panel.html 里 #f-cpus 上没有 max —— 那用户就看不到上限了');
  assert.equal(Number(m[1]), d,
    `界面上限 ${m[1]} 与服务端的 MAX_CPUS_REQUEST ${d} 不一致：`
    + '用户照着界面填，而服务端按另一个数钳制');
  const f = /clampInt\(req && req\.cpus, DEFAULTS\.cpus, 1, (\d+)\)/.exec(fake);
  assert.ok(f, 'backend-fake.js 里 cpus 的钳制那一行找不到（改过写法？）');
  assert.equal(Number(f[1]), d,
    `假后端钳到 ${f[1]}、服务端钳到 ${d} —— 假后端会比真站点宽松或更严，`
    + '而开发者模式的全部价值就是它演的是同一件事');
});

test('★★ MAX_GRES_COUNT：守护进程与假后端一致', () => {
  const d = constOf(daemon, 'MAX_GRES_COUNT', 'slurmate-sessiond');
  const f = constOf(fake, 'MAX_GRES_COUNT', 'backend-fake.js');
  assert.equal(f, d, `假后端 ${f} / 服务端 ${d}`);
  // 它必须是**量级护栏**、不是策略：`mps:100` 这种按份额计的 GRES 是正常的，
  // 所以这个数得比任何真实配置都宽。写小了会在真站点上挡住合法的提交。
  assert.ok(d >= 1024, `MAX_GRES_COUNT = ${d} 太紧，会挡住 mps 这类按份额计的 GRES`);
});

test('★ 界面上 GRES 的上限是**从服务端来的**，不是写死的', () => {
  const m = /id="f-gres-n"[^>]*/.exec(html);
  assert.ok(m, 'panel.html 里找不到 #f-gres-n（数量那一格）');
  assert.equal(/\bmax="/.test(m[0]), false,
    '数量那一格的 max 写死在 HTML 里了 —— 它必须跟着服务端给的 per_node_max 走 '
    + '（同一个集群上不同分区的上限可以不同）');
  // 而那个 max 确实是被设上去的（在 panel.js 里）。
  const js = fs.readFileSync(path.join(ROOT, 'client', 'src', 'renderer', 'panel.js'),
    'utf8');
  assert.match(js, /cnt\.max = String\(e\.per_node_max\)/,
    'panel.js 要拿 per_node_max 设 max —— 那一格是这一版唯一的上限来源');
});

test('★ 旧的 `GPU 数` 那一格整个不存在了（不是一个数字输入框）', () => {
  assert.equal(/id="f-gpus"/.test(html), false,
    'panel.html 里还有 #f-gpus —— GRES 是"名字 + 型号 + 数量"，不是"GPU 数"');
});

// ── ★★ 插件负载的上限：三侧各持一份常量，书面判据在 tools/ ──────────────────
//
// 客户端（`HARD_LIMITS`）、守护进程（`PLUGIN_*`）、打包器（`MAX_*`）各写一遍，
// 而**它们共同指向的那句话**在 `tools/plugin-limits.json`。三处分别在 JS 与
// Python 里、三个都是**分发单元**（装出去的机器上没有 tools/），所以谁也读不到
// 谁 —— 与 COPY_SKIP 同一个处境，代价也一样：漂开是**静默**的。
//
// 漂开的样子很具体：客户端收下一个站点根本发不出来的负载；或者打包器打出一个
// **任何站点都拒收**的包（"明明合规却装不上"）。两种都不会红任何东西，直到有人
// 真的把一个插件发布出去。
//
// ★ 判据不是"某个数等于多少"，是"三处说的是同一组数"：值本身可以改（v0.10 就把
//   `total_bytes` 从 1 MiB 提到了现在这个值），改一处漏另一处不行。

test('★★ 负载上限：客户端与假站点都得与书面判据逐字一致', () => {
  const rules = JSON.parse(fs.readFileSync(LIMITS_JSON, 'utf8'));
  const H = require('../src/main/site-plugins.js').HARD_LIMITS;

  for (const k of ['file_bytes', 'total_bytes', 'max_files', 'max_depth']) {
    assert.equal(H[k], rules.load[k],
      `客户端 HARD_LIMITS.${k} = ${H[k]}，而 tools/plugin-limits.json 写的是 `
      + `${rules.load[k]} —— 两处说的是同一条规则，改一处就得改另一处`);
  }
  // ★ 这一条**不是**相等：客户端那份 `package_bytes` 是**兜底**，判据是站点自述的
  //   那个（见 HARD_LIMITS 上面那段）。它只能**不小于**站点报得出来的最大值。
  assert.ok(H.package_bytes >= rules.package.max_bytes,
    `客户端兜底的 package_bytes ${H.package_bytes} 小于站点报得出来的 `
    + `${rules.package.max_bytes} —— 那就是单方面拒绝一个合规站点发得出来的包`);

  // 假站点报的数：★ 它演的是**真站点**，所以得与真站点报的逐字相同。两个方向都
  //   是坏事 —— 报得更松 ⇒ 开发时通过、真机上被拒；报得更严 ⇒ 作者会去改一个
  //   没问题的插件。（`file_bytes` 不在此列，见 backend-fake.js 里那段。）
  const F = require('../src/main/backend-fake.js');
  const demo = F.DEMO_SITE_LIMITS;
  assert.equal(demo.total_bytes, rules.load.total_bytes, '假站点的 total_bytes');
  assert.equal(demo.max_files, rules.load.max_files, '假站点的 max_files');
  assert.equal(demo.package_bytes, rules.package.max_bytes, '假站点的 package_bytes');
  assert.ok(demo.file_bytes > rules.load.file_bytes,
    '★ 假站点的 file_bytes 是**刻意**报得比真站点松的（好让"服务端只能收紧"那条 '
    + '在假站点里也走得到）；它要是变成"更严"，这个刻意的不对称就没了');
});

test('★★ 深度上限在客户端里是**两份** —— 解析包那一份也得对得上', () => {
  const rules = JSON.parse(fs.readFileSync(LIMITS_JSON, 'utf8'));
  // ★ 这一份此前**没有任何东西盯着**：`plugin-package.js` 把它传给共享的
  //   `sitePlugins.checkRelPath`，所以它就是"读一个包时允许多深"的那个数；而
  //   `tools/conformance/` 的坏包向量里**没有**一条"路径超过深度"的用例（查过了），
  //   于是它漂开不会红任何东西。同一个数在客户端有两份，漂开之后"解析包"与
  //   "执行上限"会用两个深度 —— 而这是一条**拒绝**规则。
  const src = fs.readFileSync(
    path.join(ROOT, 'client', 'src', 'main', 'plugin-package.js'), 'utf8');
  const m = /^const MAX_DEPTH = (\d+);$/m.exec(src);
  assert.ok(m, 'plugin-package.js 里找不到 `const MAX_DEPTH = <数字>;` —— 它改了形状？');
  assert.equal(Number(m[1]), rules.load.max_depth,
    `plugin-package.js 的 MAX_DEPTH = ${m[1]}，而书面判据写的是 `
    + `${rules.load.max_depth}（site-plugins.js 那一份已经对上了，这一份没有）`);
});

test('★★ 负载上限 + 信封最坏情况 ≤ 包上限 —— 这三者是一条**推出来**的关系', () => {
  const rules = JSON.parse(fs.readFileSync(LIMITS_JSON, 'utf8'));
  const { format: f, load, package: pkg } = rules;

  // 附录 A.1：包 = 头 ‖ 记录表 Σ(2 + pathlen + 8 + 32) ‖ 签名 ‖ 负载。
  // §3.3：路径最长 max_depth 段、每段 max_segment_bytes 字节 ⇒ 最长路径。
  const pathBytes = load.max_depth * f.max_segment_bytes + (load.max_depth - 1);
  // ★ v0.13：签名那一项按**最长**的一块算（`188 + 255`），因为签名块的长度现在随
  //   版本号变（A.3）。书面判据那一格因此叫 `signature_max_bytes`。
  const env = f.header_bytes + f.signature_max_bytes
    + load.max_files * (f.record_overhead_bytes + pathBytes);
  assert.equal(env, pkg.envelope_max_bytes,
    `按附录 A.1 与 §3.3 算出来的信封最坏情况是 ${env}，而书面判据写的是 `
    + `${pkg.envelope_max_bytes} —— 改 §3.3 的深度/段长、或改份数上限，这个数会跟着动`);

  assert.equal(load.total_bytes, pkg.max_bytes - env,
    `负载上限应当是"包上限 − 信封最坏情况" = ${pkg.max_bytes - env}，而书面判据写的是 `
    + `${load.total_bytes}`);

  // ★ 而且客户端**自己算出来的**那个数也得落在这条关系上 —— 不是抄来的。
  const H = require('../src/main/site-plugins.js').HARD_LIMITS;
  // ★ 客户端的 HARD_LIMITS 是从 site-plugins.js 自己那两个常量推出来的（那里刻意
  //   又写了一遍 —— `PP()` 惰性 require 不能用来求模块级常量，见那边的注记），
  //   所以这里钉住"那两遍写的是同一对数"。
  assert.equal(pkg.max_bytes - H.total_bytes, env,
    `site-plugins.js 自己算出来的信封最坏情况（${pkg.max_bytes - H.total_bytes}）`
    + `与书面判据（${env}）对不上 —— 那两处是同一个推导的两份写法`);
  assert.ok(H.total_bytes + env <= pkg.max_bytes,
    `客户端的 total_bytes ${H.total_bytes} 加上信封最坏情况 ${env} 已经超过包上限 `
    + `${pkg.max_bytes} —— 按协议上限做出来的包会**送不出去**，而症状是作者那边一句话`
    + '说不清的"明明合规却装不上"');
});
