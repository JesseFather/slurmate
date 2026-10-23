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
  child.on('error', () => {});
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
  // 父进程的存活不该被宿主进程攥住：生产里主进程本来就一直在跑，而测试里
  //   一个没关掉的宿主会让 `node --test` 不肯退出。unref 之后事件照常送达，
  //   只是它不再是"必须等它"的句柄。
  child.unref();
  if (child.channel && typeof child.channel.unref === 'function') child.channel.unref();
  for (const s of [child.stdout, child.stderr]) {
    if (s && typeof s.unref === 'function') s.unref();
  }
  if (child.stderr) child.stderr.on('data', (d) => process.stderr.write(d));
  // 宿主退出之后再发消息会拿到 EPIPE。那不是一个需要让进程崩掉的事件：
  //   退出路径本来就会把未完成的请求收掉（见 `_lost`）。
  child.on('error', () => {});
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
