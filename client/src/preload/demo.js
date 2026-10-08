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
 * preload/demo.js —— **只在开发者模式下**注入给那个假的 code-server 页面。
 *
 * 作用只有一个：把「被外壳吞掉的按键」推给页面，好让你在同一屏里对照 ——
 * 左边是页面收到的，右边是外壳吞掉的。这是快捷键接管是否生效的判定依据。
 *
 * ⚠️ 真实模式下**绝不注入任何 preload** 给 code-server 页面 —— 那会污染 IDE。
 *    这个区别在 windows.js 的 showSurface 里由 `demo` 参数控制。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('slurmateDemo', {
  onSwallowed: (fn) => {
    const h = (_e, desc) => fn(desc);
    ipcRenderer.on('demo:swallowed', h);
    return () => ipcRenderer.removeListener('demo:swallowed', h);
  },
});
