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

/**
 * stub.js — 页面里的 `window.slurmate`。
 *
 * 它必须在 `panel.js` 之前加载：那一段末尾就是 `init()`，而 `init()` 第一件事
 *   是问 `window.slurmate.bootstrap()`。桩晚一步，面板就在起点炸掉，探针量到的
 *   是一张失败横幅，而那不是排布的问题。
 *
 * 只有三个方法给真的返回值（`bootstrap` / `pluginData` / `states`）：
 *   它们决定了探针要量的那几屏长什么样。其余一律回 `null`，靠一个 Proxy 兜住 ——
 *   兜住而不是逐个列出来，是因为这里要防的不是"新加了一个 API 忘了写进桩"，
 *   而是"桩回的形状不对"。前者会当场抛（失败横幅 + 探针报出来），后者才是静默的。
 *   `on*` 那几个是订阅，返回一个退订函数，不是 Promise。
 *
 * 它不模拟任何行为：点了「同意」不会真的同意。探针量的是排布。
 */
(function () {
  'use strict';

  var F = window.__PROBE_FIXTURE || {};
  var calls = [];
  window.__PROBE_CALLS = calls;

  /** 开发者模式那一段要的三格。`saved !== on` 会把「有改动等着重启」那一条露出来。 */
  var DEV = { saved: true, on: true, dir: 'C:\\Users\\user\\AppData\\Roaming\\Slurmate\\dev-sandbox' };

  var shaped = {
    bootstrap: function () {
      calls.push('bootstrap');
      return Promise.resolve({
        dev: true,
        developerMode: DEV,
        connections: [],
        partitions: [],
        plugins: F.pluginsView || {},
      });
    },
    pluginData: function () { calls.push('pluginData'); return Promise.resolve(F.pluginData || {}); },
    states: function () { calls.push('states'); return Promise.resolve({ sessions: [], front: null }); },
    // 作业那一屏是 `showScreen('jobs')` 自己重问一次画出来的（`refreshJobs`），
    //   所以这一位必须答出作业，不然那一格画出来的是"一条都没有"。
    jobs: function () {
      calls.push('jobs');
      return Promise.resolve({ ok: true, jobs: F.jobs || [], at: Date.now() });
    },
  };

  window.slurmate = new Proxy(shaped, {
    get: function (t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      if (/^on[A-Z]/.test(k)) return function () { return function () {}; };
      return function () {
        calls.push(k);
        return Promise.resolve(null);
      };
    },
  });
}());
