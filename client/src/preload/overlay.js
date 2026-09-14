'use strict';
/**
 * preload/overlay.js —— 断线遮罩的桥。
 *
 * 遮罩是一个**独立的 webContents**，物理上盖在 code-server 视图之上。
 * 之所以不往 code-server 页面里注入 DOM：那会在下一次 code-server 升级后碎掉，
 * 还会污染 VS Code 自己的 webview 状态。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onText: (fn) => {
    const h = (_e, text) => fn(text);
    ipcRenderer.on('overlay:text', h);
    return () => ipcRenderer.removeListener('overlay:text', h);
  },
});
