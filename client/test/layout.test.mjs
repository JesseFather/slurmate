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
 * layout.test.mjs —— 窗口里那几块原生视图的摆位。
 *
 * ★ 这一组判据是**补上的**：这几条算式原先埋在 `windows.js` 的 `_layout()` 里，
 *   而那个文件一 `require` 就要 Electron ⇒ 本机（没有图形环境）根本进不去 ⇒
 *   **一个判据都没有**。而它们算错的症状是"插件页面被边栏压住一角"，不报错、
 *   不崩溃、在真机上极不显眼。
 *
 * ★ 还有一条**跨文件**的：同一组数字（状态条 30px、边栏 10px）在三个地方出现 ——
 *   `layout.js`（原生视图让开多少）、`app.css`（那两条栏画多宽）、`panel.html`
 *   （状态条的高度由 CSS 变量给）。对不上的表现是插件页面被压住一角，或者两条栏
 *   外面露出一线背景色。`limits.test.mjs` 钉的是同类的另一组数，这条跟着它。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  STATUS_BAR_HEIGHT, RAIL_W, HOVER_W, railRect, stageRect, hoverRect, inHoverZone,
} = require('../src/main/layout.js');

const W = 1280;
const H = 860;

test('★★ 主体那块：上面让开状态条，左右各让开一条边栏', () => {
  const r = stageRect(W, H);
  assert.equal(r.y, STATUS_BAR_HEIGHT, '顶边要让开状态条');
  assert.equal(r.x, RAIL_W, '左边要让开左栏');
  assert.equal(r.width, W - 2 * RAIL_W, '宽度要扣掉**两条**栏');
  assert.equal(r.height, H - STATUS_BAR_HEIGHT);
  // ★ 右边那条栏的内侧 = 主体块的右边界。差一个像素的话，右边会露出一线背景色。
  assert.equal(r.x + r.width, W - RAIL_W);
});

test('★ 过小的窗口不产生负宽度（缩到极小也不许抛）', () => {
  for (const [w, h] of [[0, 0], [8, 5], [RAIL_W, STATUS_BAR_HEIGHT]]) {
    const r = stageRect(w, h);
    assert.ok(r.width >= 0 && r.height >= 0, `${w}×${h} 的宽度/高度不能是负的`);
  }
});

test('★★ 浮窗贴着**那一条栏的内侧**，高度与主体齐平', () => {
  const l = hoverRect(W, H, 'left');
  assert.equal(l.x, RAIL_W, '左栏的浮窗紧挨着左栏的右边');
  assert.equal(l.y, STATUS_BAR_HEIGHT);
  assert.equal(l.height, H - STATUS_BAR_HEIGHT);
  assert.equal(l.width, HOVER_W);

  const r = hoverRect(W, H, 'right');
  assert.equal(r.x + r.width, W - RAIL_W, '右栏的浮窗紧挨着右栏的左边');
  assert.equal(r.width, HOVER_W);
  // ★ 两边对称：左栏的浮窗与右栏的浮窗只差一个镜像。
  assert.equal(r.x, W - RAIL_W - HOVER_W);
});

test('★ 窗口窄到放不下时，浮窗让步 —— 但不能盖住两条栏', () => {
  const w = 2 * RAIL_W + 100;
  const r = hoverRect(w, H, 'left');
  assert.ok(r.width <= 100, '让它缩到可用宽度');
  assert.ok(r.x + r.width <= w - RAIL_W, '★ 不许盖到右栏上（那会让收起它的地方够不着）');
  // 宽窗口下才用满 HOVER_W
  assert.equal(hoverRect(W, H, 'left').width, HOVER_W);
});

test('★★ 收起判据：栏里算在里面，浮窗里也算，两者之间不算', () => {
  const y = STATUS_BAR_HEIGHT + 5;
  assert.ok(inHoverZone(W, H, 'left', 1, y), '鼠标在栏上');
  assert.ok(inHoverZone(W, H, 'left', RAIL_W + 5, y), '鼠标在浮窗里');
  // ★ 这条是"移开就收"的正身：中间那一大片不属于它。
  assert.ok(!inHoverZone(W, H, 'left', W / 2, y), '鼠标在窗口中间 —— 该收');
  // 状态条不算：用户移上去点会话标签时，浮窗不该赖着不走。
  assert.ok(!inHoverZone(W, H, 'left', 1, 5), '鼠标在状态条上 —— 该收');
  // 右栏那一边同理，而且**左栏开着时鼠标跑到右栏去**也要收。
  assert.ok(!inHoverZone(W, H, 'left', W - 2, y), '鼠标跑去右栏 —— 该收');
  assert.ok(inHoverZone(W, H, 'right', W - 2, y));
});

test('★ 边界取闭区间 —— 压在浮窗最外那一列像素上仍算在里面', () => {
  const y = STATUS_BAR_HEIGHT + 5;
  const r = hoverRect(W, H, 'left');
  assert.ok(inHoverZone(W, H, 'left', r.x + r.width, y), '右边界');
  assert.ok(inHoverZone(W, H, 'left', r.x, y), '左边界');
  assert.ok(!inHoverZone(W, H, 'left', r.x + r.width + 1, y), '再往外一格就不算了');
});

test('★ 一条栏就是窗口边缘那一条，且不越过状态条', () => {
  const l = railRect(W, H, 'left');
  assert.equal(l.x, 0);
  assert.equal(l.width, RAIL_W);
  assert.equal(l.y, STATUS_BAR_HEIGHT);
  const r = railRect(W, H, 'right');
  assert.equal(r.x, W - RAIL_W);
  assert.equal(r.x + r.width, W);
});

test('★★ 同一组数字在三个文件里必须一致（对不上的症状是"页面被压住一角"）', () => {
  const css = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'app.css'), 'utf8');
  const railPx = /--rail-w:\s*(\d+)px/.exec(css);
  const barPx = /--bar-h:\s*(\d+)px/.exec(css);
  assert.ok(railPx, 'app.css 里要有 --rail-w');
  assert.ok(barPx, 'app.css 里要有 --bar-h');
  assert.equal(Number(railPx[1]), RAIL_W,
    '★ app.css 的 --rail-w 与 layout.js 的 RAIL_W 是一个数：'
    + '前者画那两条栏，后者决定原生视图让开多少 —— 不等的话，插件页面被边栏压住一角');
  assert.equal(Number(barPx[1]), STATUS_BAR_HEIGHT,
    'app.css 的 --bar-h 与 layout.js 的 STATUS_BAR_HEIGHT 是一个数');
});
