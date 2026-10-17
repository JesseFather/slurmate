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
 * app-assets.js —— 测试后端要用的那两样东西，在源码树里在哪。
 *
 * 客户端的运行期只读 `client/` 里的东西，例外只有两处，而两处都只服务测试那块
 *   假站点（安装包里一个都不带，见 `electron-builder.yml` 的 `files` 排除项）：
 *
 *   · 打包器（`packer/slurmate-packer.js`）。假站点要现打一个客户端侧容器
 *     才能把插件发给客户端，而容器格式只有那一份实现。它在仓库根，不在
 *     `client/` 下 —— 测试从源码树里直接读它。
 *   · 替身宿主（`src/main/fake-job-host.sh`）。它要交给一个外部的 bash
 *     去读，而外部进程读不了 asar；测试从源码树跑，那里本来就是普通文件。
 *
 * 安装包里这两样都不在，`packaging.test.mjs` 钉着"没有一个假站点模块被带进去"。
 */

const fs = require('fs');
const path = require('path');

/**
 * 打包器在哪。`from` 是这份代码所在的那个目录，缺省 `__dirname`（测试要造现场）。
 *
 * 源码跑与安装包跑算出来的是同一个位置，所以只有一条算法：
 *   源码树里 `client/src/main` 往上三层是仓库根，安装包里
 *   `<resources>/app.asar/src/main` 往上三层是 `<resources>` —— 而
 *   `extraResources` 正是要把它放在 `<resources>/packer/`。
 */
function packerPath(from = __dirname) {
  return path.join(from, '..', '..', '..', 'packer', 'slurmate-packer.js');
}

/**
 * asar 里那个路径的解包孪生。
 *
 * 外部进程（bash）读不了 asar 里的文件，所以交给它的那一个必须落在
 *   `app.asar.unpacked/`。源码跑时这个函数什么都不做。
 */
function unpacked(p) {
  if (!p.includes('app.asar') || p.includes('app.asar.unpacked')) return p;
  return p.replace('app.asar', 'app.asar.unpacked');
}

/**
 * 找不到打包器时那句话。它只有一份 —— 测试与调试开关看到的是同一句。
 */
const NO_PACKER = '未找到打包器。假站点要现打一个客户端侧容器才能把插件发给'
  + '客户端，而容器格式只有打包器那一份实现。';

/**
 * 找打包器。返回 `{path}` 或 `{why}` —— 与 `fake-job.js` 的 `findBash()` 同形。
 *
 * 找不到时必须说得出原因：症状是"站点报得出插件却一个都发不出来"，指不回这里。
 */
function findPacker(from = __dirname) {
  const p = packerPath(from);
  try {
    if (fs.statSync(p).isFile()) return { path: p };
  } catch { /* 不在，下面给原因 */ }
  return { why: `${NO_PACKER}（未找到 ${p}）` };
}

module.exports = { packerPath, unpacked, findPacker, NO_PACKER };
