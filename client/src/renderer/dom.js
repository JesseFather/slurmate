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

'use strict';
/**
 * dom.js —— 两个渲染页面共用的三个小东西。
 *
 * ★ **为什么会有这个文件**：面板（`panel.html`）与浮窗（`hover.html`）是两个
 *   renderer 进程，它们画的是同一类东西 —— 站点那一份现状。那一段本来只有面板
 *   在画，浮窗接手之后如果各写一份，"取不到 / 确实没有"这条三态规矩就会在两边
 *   漂开，而它漂开的形态正是这个仓库一路在清的那类：**一处把"没问到"画成了"没有"**。
 *
 * ★ 它是**普通脚本**（不是模块）：两个页面各自 `<script src="dom.js">` 在最前面
 *   引一次，后面那个脚本直接用这些名字。仓库里没有打包器，加一个模块系统只为了
 *   三个函数不划算。
 */

/** 造一个元素。职责很小，但要造几十个 —— 手写三行的地方容易漏掉 `textContent`
 *  而改用 `innerHTML`，那正是这里唯一不能出的事。 */
function cel(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

/**
 * 「取不到」那一行 —— 三态规矩里**缺席**那一态的写法。
 *
 * ★ 与「确实没有」必须长得不一样：把"问不到"画成"没有"，用户会去查一个不存在的
 *   问题（"为什么这台集群没有分区"），而真正的原因在守护进程那一侧。
 *   **每一次缺席都要说清是哪一格**，否则用户只知道"少了点东西"。
 */
function na(what) {
  return cel('p', 'na', `取不到：${what}。这一格是「没问到」，不是「没有」。`);
}

/** 一个时间戳有多旧。服务端的慢钟是 5 分钟，所以"这一份有多旧"是用户要看的。 */
function agoText(ts) {
  if (typeof ts !== 'number') return null;
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 90) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  return m < 90 ? `${m} 分钟前` : `${Math.floor(m / 60)} 小时前`;
}
