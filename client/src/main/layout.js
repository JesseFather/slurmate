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
 * layout.js —— 窗口里那几块原生视图摆在哪（纯函数，不含 Electron）。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────
 *
 * 这几条算式在真机上的失败形态极不显眼：算错一个内边距，插件那块页面就被
 * 边栏压住一角，或者遮罩少盖一条缝 —— 两种都不报错、不崩溃，只是"看起来有点怪"。
 * 而它们原先散在 `windows.js` 的 `_layout()` 里，那个文件一 `require` 就要
 * Electron，本机（没有图形环境）根本进不去，一个判据都没有。
 *
 * 抽到这里之后，它是一段可以逐个数断言的纯算术。
 *
 * ── 形状 ──────────────────────────────────────────────────────────────────
 *
 * ```
 * ┌───────────────────────────────────────────┐
 * │ 状态条（STATUS_BAR_HEIGHT）                │
 * ├──┬─────────────────────────────────┬──────┤
 * │左│                                 │  右  │
 * │栏│   stage：插件那块界面 / 遮罩      │  栏  │
 * │  │                                 │      │
 * └──┴─────────────────────────────────┴──────┘
 *      └── hover：浮窗，贴在栏的内侧
 * ```
 *
 * 主界面上没有两条栏这件事不在这里：插件视图与遮罩只在会话跑着的时候
 *   存在，所以它们的矩形是常量；"没连上就不画边栏"是面板那一侧的 CSS。
 *   把"现在连没连上"塞进这个文件，等于让摆位去依赖一个它会过期的状态。
 */

'use strict';

/** 顶部状态条的高度。它是面板自己的像素，永远在。 */
const STATUS_BAR_HEIGHT = 30;

/**
 * 两条边栏的宽度。
 *
 * 它很窄（10px）是刻意的：那是占位边框，不是内容区。窗口主体要留给插件那块
 *   界面，而鼠标停到这条边上会滑出浮窗 —— 那才是看内容的地方。
 */
const RAIL_W = 10;

/**
 * 浮窗的宽度。
 *
 * 定死，不做可拖宽：浮窗是临时的，一个能改宽度的临时东西只会让人误以为
 *   它是个可以布置的面板。等真的需要常驻面板时再谈。
 */
const HOVER_W = 340;

/** 一条边栏：窗口左边缘或右边缘那一条。 */
function railRect(w, h, side) {
  const height = Math.max(0, h - STATUS_BAR_HEIGHT);
  const x = side === 'right' ? Math.max(0, w - RAIL_W) : 0;
  return { x, y: STATUS_BAR_HEIGHT, width: Math.min(RAIL_W, Math.max(0, w)), height };
}

/**
 * 窗口主体那块：插件声明的界面，以及盖在它上面的遮罩。
 *
 * 两者用同一个矩形是承重的：遮罩的职责是"插件的内容现在不该被看见"，
 *   而两条边栏不是插件的内容 —— 那上面是站点状态与输出，断线的时候恰恰最该看得见。
 *   让遮罩盖满整个窗口，等于把用户唯一能自救的那两块像素一起涂掉。
 */
function stageRect(w, h) {
  const height = Math.max(0, h - STATUS_BAR_HEIGHT);
  const width = Math.max(0, w - 2 * RAIL_W);
  return { x: RAIL_W, y: STATUS_BAR_HEIGHT, width, height };
}

/**
 * 浮窗：贴在那一条栏的内侧，高度与主体齐平。
 *
 * 宽度取 `min(HOVER_W, 可用宽度)` —— 窗口窄到放不下时才让步。不让步的话，
 *   一个 640px 宽的窗口上浮窗会从左栏一直盖到右栏，两条栏都够不着了，
 *   而"够不着"的表现是用户点不到收起它的地方。
 */
function hoverRect(w, h, side) {
  const height = Math.max(0, h - STATUS_BAR_HEIGHT);
  const usable = Math.max(0, w - 2 * RAIL_W);
  const width = Math.min(HOVER_W, usable);
  const x = side === 'right' ? Math.max(RAIL_W, w - RAIL_W - width) : RAIL_W;
  return { x, y: STATUS_BAR_HEIGHT, width, height };
}

/**
 * 遮罩现在该不该露。
 *
 * 两条判据缺一不可：有一句话要说（`text` 非空），并且屏幕主体不是面板
 *   （`panelFront` 为假）。第二条是用户 2026-10-18 报的那一条 —— 断网之后
 *   点状态条上的「面板」回不到别的页面：会话页让开了，遮罩没让开，一整块
 *   "连接暂时中断"留在原处，看起来像那颗按钮点了没反应。
 *
 * 遮罩与面板是同一块矩形上的两层，而"谁在上面"只能由窗口这一层回答
 *   —— 面板那一侧看不见遮罩，也没有办法把自己抬到它上面。
 */
function overlayVisible({ text, panelFront }) {
  return Boolean(text) && !panelFront;
}

/**
 * 鼠标在不在「那一条栏 ∪ 它那个浮窗」里面。`x` / `y` 是窗口内容区里的坐标。
 *
 * 这一条是浮窗的唯一收起判据（见 windows.js 的 `_watchCursor`）。不用
 *   `mouseleave` 是因为浮窗是原生视图：鼠标一进它，栏那一格就收不到事件了，
 *   两个 renderer 之间必然有一段交接的真空，而它的表现是浮窗闪一下就没了。
 *   几何判定没有交接。
 *
 * 边界取闭区间：鼠标压在浮窗最右边那一列像素上时仍然算"在里面"。
 *   开区间的话，用户沿着浮窗边缘移动会一路被判成离开。
 */
function inHoverZone(w, h, side, x, y) {
  const rail = railRect(w, h, side);
  const panel = hoverRect(w, h, side);
  return inRect(rail, x, y) || inRect(panel, x, y);
}

function inRect(r, x, y) {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

module.exports = {
  STATUS_BAR_HEIGHT, RAIL_W, HOVER_W,
  railRect, stageRect, hoverRect, inHoverZone, overlayVisible,
};
