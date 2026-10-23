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

// 插件宿主的协议与 ctx 行为。纯 Node：不 require electron，走 child_process.fork。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginHost } from '../src/main/plugins/plugin-host.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-host-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function pluginSource(body) {
  const dir = path.join(TMP, `p${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const entry = path.join(dir, 'index.js');
  fs.writeFileSync(entry, body);
  return { dir, entry };
}

function ctxFor(extra = {}) {
  return {
    connection: { id: 'c1', label: '站点', user: 'u', host: 'h', port: 22 },
    session: { session_id: 7, state: 'running' },
    whoami: { user: 'u', home: '/home/u' },
    home: { ok: true, value: '/home/u' },
    dataDir: { ok: true, value: '/home/u/.slurmate/plugin-data/x' },
    ...extra,
  };
}

async function hostFor(entry, opts = {}) {
  const host = new PluginHost({
    entry,
    key: opts.key || 'demo@1.0.0',
    onCall: opts.onCall || (async () => null),
    onEvent: opts.onEvent || (() => {}),
    onLog: opts.onLog || (() => {}),
    onLost: opts.onLost || (() => {}),
  });
  const info = await host.start();
  return { host, info };
}

test('握手拿回钩子表与 closeWarning', async () => {
  const { entry } = pluginSource(`
    module.exports = {
      prepare: () => ({ ok: true }),
      closeWarning: { message: '还有会话', detail: '关掉就断了' },
    };
  `);
  const { host, info } = await hostFor(entry);
  try {
    assert.deepEqual(info.has, { prepare: true, attach: false, startLocal: false });
    assert.deepEqual(info.closeWarning, { message: '还有会话', detail: '关掉就断了' });
  } finally {
    await host.close();
  }
});

test('导出里有认不得的键：加载失败并点名', async () => {
  const { entry } = pluginSource(`module.exports = { start: () => {} };`);
  await assert.rejects(hostFor(entry), /认不得的键：start/);
});

test('模块自身抛错：报加载失败', async () => {
  const { entry } = pluginSource(`throw new Error('炸了');`);
  await assert.rejects(hostFor(entry), /加载失败.*炸了/);
});

test('prepare 看到父进程下发的 ctx，返回值原样带回', async () => {
  const { dir, entry } = pluginSource(`
    const fs = require('fs');
    module.exports = {
      prepare(ctx) {
        fs.writeFileSync(${JSON.stringify(path.join(TMP, 'seen.json'))}, JSON.stringify({
          connection: ctx.connection(),
          session: ctx.session(),
          whoami: ctx.whoami(),
          home: ctx.home(),
          dataDir: ctx.dataDir(),
          keys: Object.keys(ctx.keys).sort(),
        }));
        return { ok: true, sshPubkey: 'ssh-ed25519 AAAA demo' };
      },
    };
  `);
  const { host } = await hostFor(entry);
  try {
    const out = await host.request('s1', 'prepare', ctxFor(), {}, 5000);
    assert.deepEqual(out, { ok: true, sshPubkey: 'ssh-ed25519 AAAA demo' });
    const seen = JSON.parse(fs.readFileSync(path.join(TMP, 'seen.json'), 'utf8'));
    assert.equal(seen.connection.host, 'h');
    assert.equal(seen.session.session_id, 7);
    assert.equal(seen.dataDir, '/home/u/.slurmate/plugin-data/x');
    assert.ok(seen.keys.includes('generate'));
    assert.ok(seen.keys.includes('fingerprintOf'));
    assert.equal(dir.startsWith(TMP), true);
  } finally {
    await host.close();
  }
});

test('ctx 的取值失败时说得出是哪一项', async () => {
  const { entry } = pluginSource(`
    module.exports = {
      prepare(ctx) {
        try { ctx.dataDir(); } catch (e) { return { ok: false, message: e.message }; }
        return { ok: true };
      },
    };
  `);
  const { host } = await hostFor(entry);
  try {
    const out = await host.request('s1', 'prepare', ctxFor({ dataDir: { ok: false, error: '数据根不可用' } }), {}, 5000);
    assert.deepEqual(out, { ok: false, message: '数据根不可用' });
  } finally {
    await host.close();
  }
});

test('notice 走单向事件，once 在宿主里去重', async () => {
  const seen = [];
  const { entry } = pluginSource(`
    module.exports = {
      attach(ctx) {
        ctx.notice('info', '第一次');
        ctx.notice('warn', ctx.once('k') ? '去重后第一次' : '不该出现');
        ctx.notice('warn', ctx.once('k') ? '不该出现' : '去重后第二次');
      },
    };
  `);
  const { host } = await hostFor(entry, { onEvent: (s, kind, text) => seen.push([s, kind, text]) });
  try {
    await host.request('s1', 'attach', ctxFor(), { snap: { sessions: [] } }, 5000);
    assert.deepEqual(seen, [
      ['s1', 'info', '第一次'],
      ['s1', 'warn', '去重后第一次'],
      ['s1', 'warn', '去重后第二次'],
    ]);
  } finally {
    await host.close();
  }
});

test('login 与 reloadSurface 回到父进程，并把结果带回来', async () => {
  const calls = [];
  const { entry } = pluginSource(`
    module.exports = {
      async attach(ctx) {
        const a = await ctx.login('http://127.0.0.1:9');
        const b = await ctx.win.reloadSurface();
        ctx.notice('info', JSON.stringify({ a, b }));
      },
    };
  `);
  const seen = [];
  const { host } = await hostFor(entry, {
    onCall: async (s, member, args) => {
      calls.push([s, member, args]);
      return member === 'login' ? { ok: true } : 'reloaded';
    },
    onEvent: (s, kind, text) => seen.push(JSON.parse(text)),
  });
  try {
    await host.request('s1', 'attach', ctxFor(), { snap: {} }, 5000);
    assert.deepEqual(calls, [
      ['s1', 'login', ['http://127.0.0.1:9']],
      ['s1', 'reloadSurface', []],
    ]);
    assert.deepEqual(seen, [{ a: { ok: true }, b: 'reloaded' }]);
  } finally {
    await host.close();
  }
});

test('startLocal 交出 token，dispose 只执行一次', async () => {
  const marker = path.join(TMP, 'disposed');
  const { entry } = pluginSource(`
    const fs = require('fs');
    module.exports = {
      startLocal(ctx, { port }) {
        return {
          ok: true,
          origin: 'http://127.0.0.1:' + port,
          dispose() { fs.appendFileSync(${JSON.stringify(marker)}, 'x'); },
        };
      },
    };
  `);
  const { host } = await hostFor(entry);
  try {
    const out = await host.request('s1', 'startLocal', ctxFor(), { port: 4321 }, 5000);
    assert.equal(out.ok, true);
    assert.equal(out.origin, 'http://127.0.0.1:4321');
    assert.equal(out.hasDispose, true);
    const a = await host.request('s1', 'disposeLocal', ctxFor(), { token: out.token }, 5000);
    const b = await host.request('s1', 'disposeLocal', ctxFor(), { token: out.token }, 5000);
    assert.deepEqual(a, { disposed: true });
    assert.deepEqual(b, { disposed: false });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'x');
  } finally {
    await host.close();
  }
});

test('同一个宿主上的 prepare 串行执行', async () => {
  const order = path.join(TMP, 'order.log');
  const { entry } = pluginSource(`
    const fs = require('fs');
    module.exports = {
      async prepare(ctx) {
        fs.appendFileSync(${JSON.stringify(order)}, 'in\\n');
        await new Promise((r) => setTimeout(r, 60));
        fs.appendFileSync(${JSON.stringify(order)}, 'out\\n');
        return { ok: true };
      },
    };
  `);
  const { host } = await hostFor(entry);
  try {
    await Promise.all([
      host.request('s1', 'prepare', ctxFor(), {}, 5000),
      host.request('s2', 'prepare', ctxFor(), {}, 5000),
    ]);
    assert.equal(fs.readFileSync(order, 'utf8'), 'in\nout\nin\nout\n');
  } finally {
    await host.close();
  }
});

test('超时的请求被拒，宿主仍可继续服务', async () => {
  const { entry } = pluginSource(`
    module.exports = {
      async prepare(ctx) {
        await new Promise((r) => setTimeout(r, 150));
        return { ok: true };
      },
    };
  `);
  const { host } = await hostFor(entry);
  try {
    await assert.rejects(
      host.request('s1', 'prepare', ctxFor(), {}, 40),
      /超过 0 秒没有返回|TIMEOUT|没有返回/);
    const out = await host.request('s2', 'prepare', ctxFor(), {}, 5000);
    assert.deepEqual(out, { ok: true });
  } finally {
    await host.close();
  }
});

test('宿主被杀：未完成的请求以 HOST_GONE 拒掉', async () => {
  let lost = null;
  const { entry } = pluginSource(`
    module.exports = {
      prepare() { return new Promise(() => {}); },
    };
  `);
  const { host } = await hostFor(entry, { onLost: (e) => { lost = e; } });
  const pending = host.request('s1', 'prepare', ctxFor(), {}, 5000);
  await new Promise((r) => setTimeout(r, 80));
  process.kill(host.pid, 'SIGKILL');
  await assert.rejects(pending, /插件进程已退出/);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(lost && lost.code === 'HOST_GONE');
});
