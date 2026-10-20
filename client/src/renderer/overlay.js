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
 * overlay.js —— 提示页（断线、页面打不开）。
 *
 * 它是一个独立的 webContents，物理盖在插件那块页面之上。这样做而不是往那块
 * 页面里注入 DOM，是因为注入会在那款软件下一次升级后碎掉，还会污染它自己的
 * webview 状态。
 *
 * 这一页刻意做得很薄：外壳推来两行字，它照着印。任何逻辑都不放在这里 ——
 * 它盖着的那块页面才是用户真正在用的那一个，而"什么时候该露这一页"是窗口
 * 那一层的事（见 layout.js 的 `overlayVisible`）。
 */

const titleEl = document.getElementById('title');
const textEl = document.getElementById('text');

window.overlay.onShow((msg) => {
  titleEl.textContent = (msg && msg.title) || '连接暂时中断';
  textEl.textContent = (msg && msg.text) || '正在重新连接…';
});
