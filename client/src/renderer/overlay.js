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
