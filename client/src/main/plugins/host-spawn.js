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
 * host-spawn.js —— 起一个插件宿主进程，并把两种运行时的差异挡在这一层。
 *
 * 生产是 Electron 的 `utilityProcess`；纯 Node（测试）是 `child_process.fork`。
 * 上层只认 `send` / `onMessage` / `onExit` / `kill` 四件事，不碰运行时。
 *
 * 测试注入点：`spawnHost({ spawn })`。不给 `spawn` 时按运行时自动选。
 */

const childProcess = require('child_process');

function electronUtility() {
  if (!process.versions.electron) return null;
  try {
    const electron = require('electron');
    return electron && electron.utilityProcess ? electron.utilityProcess : null;
  } catch {
    return null;
  }
}

function fromUtilityProcess(utilityProcess, workerPath, opts) {
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: opts.serviceName || 'slurmate-plugin',
    env: opts.env || process.env,
    cwd: opts.cwd || process.cwd(),
    stdio: 'pipe',
  });
  return {
    pid: child.pid,
    send: (m) => child.postMessage(m),
    onMessage: (fn) => child.on('message', fn),
    onExit: (fn) => child.on('exit', (code) => fn({ code, signal: null })),
    kill: () => { try { child.kill(); } catch { /* 已经退出 */ } },
    stderr: child.stderr || null,
  };
}

function fromFork(workerPath, opts) {
  const child = childProcess.fork(workerPath, [], {
    env: opts.env || process.env,
    cwd: opts.cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return {
    pid: child.pid,
    send: (m) => child.send(m),
    onMessage: (fn) => child.on('message', fn),
    onExit: (fn) => child.on('exit', (code, signal) => fn({ code, signal })),
    kill: () => { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } },
    stderr: child.stderr || null,
  };
}

function spawnHost(workerPath, opts = {}) {
  if (typeof opts.spawn === 'function') return opts.spawn(workerPath, opts);
  const utility = electronUtility();
  if (utility) return fromUtilityProcess(utility, workerPath, opts);
  return fromFork(workerPath, opts);
}

module.exports = { spawnHost, electronUtility };
