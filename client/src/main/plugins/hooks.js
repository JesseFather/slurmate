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
 * hooks.js —— 插件客户端钩子的清单与导出校验。
 *
 * 这一份同时被主进程（注册表）与插件宿主进程使用：主进程用它判断一份代码
 * 能不能加载，宿主用它判断加载进来的模块是不是一个合法插件。
 *
 * 校验规则只有一份，理由与「同一个键的规矩散在三处」那一类问题相同：
 * 两处各写一遍，改了一处另一处不会红，症状是「主进程放行了、宿主拒了」
 * 或者反过来。
 */

// 允许导出的键（这是全部）。多一个都拒：静默忽略会让旧插件看起来装上了，
// 而它写的东西从头到尾没有生效。
const CLIENT_HOOKS = ['prepare', 'attach', 'closeWarning', 'startLocal'];

// 必须是函数的三个钩子。closeWarning 是数据，不在此列。
const FUNCTION_HOOKS = ['prepare', 'attach', 'startLocal'];

function keysProblem(obj, allowed, what) {
  const bad = Object.keys(obj).filter((k) => !allowed.includes(k));
  return bad.length ? `${what}里有认不得的键：${bad.join('、')}（认识的只有 ${allowed.join('、')}）` : null;
}

/**
 * 校验一个已经加载的插件模块。
 *
 * 返回 `{ hooks }` 或 `{ error }`。`hooks` 里的每一项可能为 null；
 * 主进程与宿主都只按这三个键挂载，不直接碰原模块。
 */
function validateClientModule(mod, where) {
  if (!mod || typeof mod !== 'object' || Array.isArray(mod)) {
    return { error: `${where}：必须导出一个对象（可以一个钩子都不写）` };
  }
  const why = keysProblem(mod, CLIENT_HOOKS, '导出的对象');
  if (why) return { error: `${where}：${why}` };
  for (const k of FUNCTION_HOOKS) {
    if (mod[k] !== undefined && typeof mod[k] !== 'function') {
      return { error: `${where}：${k} 必须是一个函数` };
    }
  }
  if (mod.closeWarning !== undefined) {
    const cw = mod.closeWarning;
    if (!cw || typeof cw.message !== 'string' || typeof cw.detail !== 'string') {
      return { error: `${where}：closeWarning 必须是 {message, detail} 两个字符串` };
    }
  }
  return {
    hooks: {
      prepare: mod.prepare || null,
      attach: mod.attach || null,
      closeWarning: mod.closeWarning || null,
      startLocal: mod.startLocal || null,
    },
  };
}

module.exports = { CLIENT_HOOKS, FUNCTION_HOOKS, keysProblem, validateClientModule };
