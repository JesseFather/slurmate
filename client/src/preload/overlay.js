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
