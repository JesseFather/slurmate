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
 * preload/hover.js —— 浮窗那一层（两条边栏滑出来的那块）的桥。
 *
 * ★ 它是一个**独立的 webContents**，理由与遮罩一模一样：浮窗要浮在**插件那块
 *   原生视图之上**，而画在面板的 DOM 里够不着那个位置。
 *
 * ★ 桥很窄，只有三样：
 *   · 开 / 关（主进程说，因为收起判据是**鼠标几何**，那在窗口那一层）
 *   · 数据（也是主进程推 —— 它是唯一向后端问话的地方，浮窗不去自己拉）
 *   · 「测一次延迟」（一个用户按下去的按钮，那是一次明确的动作，不是查询）
 *
 * ★ **不让浮窗自己去问 `op_cluster`**：那样同一份答案会有一个第二个取数点，
 *   而它与主进程那个"什么时候该问"的判据必然漂开（见 hover.js 的文件头）。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hover', {
  /** 开、关、以及"被钉住了没有"。`{open, side, pinned}`。 */
  onState: (fn) => {
    const h = (_e, m) => fn(m);
    ipcRenderer.on('hover:state', h);
    return () => ipcRenderer.removeListener('hover:state', h);
  },
  /** 主进程推来的数据。`{side, ...}` —— 站点状态那一份是 `cluster`。 */
  onData: (fn) => {
    const h = (_e, m) => fn(m);
    ipcRenderer.on('hover:data', h);
    return () => ipcRenderer.removeListener('hover:data', h);
  },
  /** 对**当前活跃连接**测一次延迟（TCP + 读 SSH banner）。用户按的那一下才有。 */
  probe: () => ipcRenderer.invoke('app:probeActive'),
});
