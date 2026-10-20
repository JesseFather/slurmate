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
 * preload/overlay.js —— 提示页的桥。
 *
 * 提示页是一个独立的 webContents，物理上盖在插件那块页面之上。
 * 之所以不往那块页面里注入 DOM：那会在下一次插件升级后碎掉，还会污染它自己的
 * webview 状态。
 *
 * 推过去的是一条 `{ title, text }`：标题与正文一起给，页面不用自己猜上面那行
 * 大字该写什么（猜的结果会在下一次文案改动时漂开）。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onShow: (fn) => {
    const h = (_e, msg) => fn(msg);
    ipcRenderer.on('overlay:show', h);
    return () => ipcRenderer.removeListener('overlay:show', h);
  },
});
