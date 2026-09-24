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
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');
const DAEMON = path.join(ROOT, 'cluster', 'slurmate-sessiond');
const PANEL_HTML = path.join(ROOT, 'client', 'src', 'renderer', 'panel.html');
const FAKE = path.join(ROOT, 'client', 'src', 'main', 'backend-fake.js');

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
