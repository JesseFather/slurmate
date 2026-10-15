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
 * fixture.mjs — 探针要画的那几屏的内容。
 *
 * 两半来源不同，所以分开写，各自的诚实程度也不一样：
 *
 *   插件数据那一块由真正的审计函数算（`plugin-data-audit.js` 的 `audit()`），
 *     不是手抄一份行的形状。探针要是手抄，审计改了字段而夹具没跟上，红的是探针，
 *     而它会被人当成探针坏了。调真函数之后，夹具永远与那一块同形。
 *
 *   第二屏与作业屏的视图对象手写。它们平时由主进程的 `pluginsView()` /
 *     `sessionsView()` 算出来，而那两段要 Electron，进不了页面。手写的这几份
 *     按源码里的字段抄，且刻意往长了造：这些用例要问的是"内容长了会不会伸出去"，
 *     一份短夹具只会让每一条都绿。
 *
 * 脱敏：路径里不带真实用户名（这个仓库是公开的）。长度照真值给，形状照真值给，
 *   只有那两段可识别的东西换掉。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dataAudit = require(path.join(here, '../../client/src/main/plugin-data-audit.js'));

// Windows 上那份分区目录根。用户报的那一行就长在这里。
const WIN_ROOT = 'C:\\Users\\user\\AppData\\Roaming\\Slurmate\\Partitions';
// 一个已经不在本机的插件，它的数据还在盘上。三段身份：插件 id、共享组、数据空间。
const LOST_ID = '01m4x3bpny0363sf5qmfw89zgt';
const LOST_NAME = `${LOST_ID}@editor@s68e0e62c66a1`;

/**
 * 清不掉的那一条。
 *
 * 它的形状照真事给：`e.message` 里路径出现两遍，是 Node 自己的 `fs.rmSync`
 *   构造 message 的方式（上游在新版本里去掉了其中一份，出问题的那台 Windows 上
 *   那份 Electron 自带的 Node 还没有那个修复）。探针要的是它的长度，不是它的措辞。
 */
function stuckError() {
  const p = `${WIN_ROOT}\\${LOST_NAME}`;
  return `目录未能删掉：EPERM, Permission denied: \\\\?\\${p} '${p}'`;
}

/**
 * 一个断点都没有的长串。
 *
 * 它在这份夹具里是造出来的，这点要说明白：真实那些长串今天都还有断点
 *   （Windows 路径在反斜杠处就断开了，用户 2026-10-15 报的那一条长路径正是
 *   这样折成两行的，它没有把卡片顶出去）。
 *
 * 留着它是因为 `#panel` 上那条 `overflow-wrap: anywhere` 只在这种串上才起作用，
 *   而少了这一格，那条规则就没有任何东西看着：拿掉它，探针照样全绿
 *   （实测过），于是下一个人可以把那条规则删掉而没有任何反应。
 *   形状做成摘要那一类（base64 样的连续字符），长度按能把面板撑破来给。
 */
const UNBREAKABLE = 'k9Fq3ZmT0w'.repeat(22);

/** 本机的插件数据那一块。 */
export function buildPluginData() {
  const report = dataAudit.audit({
    plugins: [], spaces: [], workspaces: [], connections: [],
    names: [LOST_NAME], dataNames: [], why: null, held: [],
  });
  return {
    ...report,
    roots: { partition: WIN_ROOT, data: null },
    reclaimed: {
      count: 0, items: [],
      failed: [{
        name: LOST_NAME,
        label: `插件 ${LOST_ID} 的数据`,
        error: `${stuckError()} ${UNBREAKABLE}`,
      }],
    },
  };
}

/**
 * 第二屏的视图对象。
 *
 * 三块各造一个最坏形状：一个名字很长的、一个站点没开的、一个起不来的。
 *   字段照 `index.js` 的 `pluginsView()` 抄，一个不多一个不少。
 */
export function buildPluginsView() {
  const one = (o) => Object.assign({
    id: '01m4x3bpny0363sf5qmfw89zgt', version: '1.0.0', name: 'code-server',
    title: '浏览器里的编辑器', description: '',
    hasClientCode: true, surface: { kind: 'web', path: '/' },
    ports: 1, group: 'editor',
    siteVersion: '1.0.0', siteEnabled: true, siteKnown: true, locallyEnabled: true,
    canSubmit: true,
    defaults: { cpus: 2, mem: '8G', time: '12:00:00', gpus: null },
    defaultsGresText: null, runnable: true,
  }, o);

  return {
    plugins: [
      one({
        title: '浏览器里的编辑器（一整个名字都很长的插件标题，用来撑宽那一行）',
        description: '这个插件的说明也可以很长，长到它在窄窗口里必须自己折行，'
          + '而不是把旁边那几格顶出去。',
      }),
      one({
        id: '01m4x3bpny0363sf5qmfw89zgt2', version: '2.0.0', name: 'sshd',
        title: 'SSH 服务', description: '', ports: 0, group: null,
        surface: { kind: 'none', path: '' },
        siteEnabled: false,
        why: '站点上这个插件现在是关着的，所以提交不了。开它要找管理员。',
      }),
      one({
        id: '01m4x3bpny0363sf5qmfw89zgt3', version: '3.0.0', name: 'jupyter',
        title: '笔记本服务', description: '', canSubmit: false, runnable: false,
      }),
    ],
    problems: [
      { kind: 'engine', title: '引擎不满足', detail: '这个插件要的客户端版本比本机的新，'
        + '所以它没有被加载。升级客户端之后再同步一次。' },
    ],
    sitePlugins: { plugins: [], problems: [] },
    siteKnown: true,
    partitions: [],
    dev: true,
  };
}

/**
 * 作业屏：三行，把 `jobRow` 的几条分支都走到，内容照长的造。
 *
 * 字段照 `panel.js` 的 `jobRow` 抄：`service` / `state_text` / `job_id` /
 *   `partition` / `node` / `expires_at` / `live` / `attached` / `keeper_text` /
 *   `keeper_is_me` / `session_id`。少了哪一个，那一格就少画一块，而少画的那些
 *   正是这一条检查要量的东西。
 *
 * 三行分别是：本机接着的（最全）、本机没接着的（多一句警告）、已经结束的
 *   （少"谁在看"那一格）。
 */
export function buildJobs() {
  const soon = Date.now() + 11 * 3600 * 1000 + 59 * 60 * 1000;
  return [
    {
      session_id: '01m4x3bpny0363sf5qmfw89zgt', live: true, attached: true,
      service: '浏览器里的编辑器（这个名字很长，长到那一行必须自己安排）',
      state_text: '运行中', state: 'running',
      job_id: 1234567, partition: 'normal', node: 'node01', expires_at: soon,
      keeper_text: '这台电脑在看', keeper_is_me: true,
    },
    {
      session_id: '01m4x3bpny0363sf5qmfw89zgt2', live: true, attached: false,
      service: 'SSH 服务', state_text: '提交中', state: 'submitted',
      job_id: 7654321, partition: 'gpu-long', node: 'node-with-a-long-name02',
      expires_at: soon, keeper_text: '另一台电脑在看：another-workstation',
      keeper_is_me: false,
    },
    {
      session_id: '01m4x3bpny0363sf5qmfw89zgt3', live: false, attached: true,
      service: '笔记本服务', state_text: '已结束', state: 'ended',
      job_id: 1111111, partition: 'normal', node: 'node03',
      expires_at: null, keeper_text: null, keeper_is_me: false,
    },
  ];
}

/**
 * 状态条上那条三选一。
 *
 * `error` 是主进程给的原话，长度不由界面定，所以这里给一句长的：
 *   那一行长在 30px 的状态条里，是"理由挤掉按钮"最容易发生的地方。
 */
export function buildPortAsk() {
  return {
    error: '首选端口 18080 被其他程序占用，而那个程序一直没有退出。'
      + '这一格要让用户选：只换这一次，还是把这份数据的端口永久改掉。',
    port: { want: 18080 },
  };
}

/** 交给页面的那一份。 */
export function buildPageFixture() {
  return {
    pluginData: buildPluginData(),
    pluginsView: buildPluginsView(),
    jobs: buildJobs(),
    portAsk: buildPortAsk(),
  };
}
