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
 * overlay.js —— 断线遮罩。
 *
 * 遮罩是一个独立的 webContents，物理盖在 code-server 视图之上。这样做而不是往
 * code-server 页面里注入 DOM，是因为注入会在下一次 code-server 升级后碎掉，
 * 还会污染 VS Code 自己的 webview 状态。
 *
 * 这个页面**刻意做得很薄**：只显示一行外壳推过来的文字。任何逻辑都不放在这里，
 * 因为它盖着的那个页面才是用户真正在用的东西。
 */

const el = document.getElementById('text');

window.overlay.onText((text) => {
  el.textContent = text || '正在重新连接…';
});
