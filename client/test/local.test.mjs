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
 * local.test.mjs —— 本机插件（没有作业侧）的控制器那一条路。
 *
 * 它守的是三件事：
 *   ① 本机会话不碰任何 RPC（没有 submit / status / heartbeat / goodbye）；
 *   ② 插件交出来的 origin 只认回环 http，其它一律进 error 并收尾；
 *   ③ 停止与放弃只 dispose 一次，迟到的启动结果也要收。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionController, State } = require('../src/main/session.js');

class StubBackend extends EventEmitter {
  constructor() {
    super();
    this.kind = 'fake';
    this.calls = [];
  }

  get connected() { return true; }

  async rpc(req) {
    this.calls.push(req);
    return { ok: true, code: 0, data: {}, error: null };
  }
}

const ctx = () => ({ dataDir: () => '/tmp/slurmate-local-test' });

function make(extra = {}) {
  return new SessionController({ backend: new StubBackend(), spaceId: 'sp1', ...extra });
}

const good = (origin, onDispose) => ({
  ok: true,
  origin,
  dispose: onDispose,
});

test('本机插件：startLocal 进 running，零 RPC，也不起心跳与轮询', async () => {
  const c = make();
  let disposed = 0;
  const snap = await c.startLocal(
    () => good('http://127.0.0.1:55221', () => { disposed += 1; }),
    ctx(), { port: 55221, serviceKind: 'local-demo' });

  assert.equal(snap.state, State.RUNNING);
  assert.equal(snap.origin, 'http://127.0.0.1:55221');
  assert.equal(snap.localPort, 55221);
  assert.equal(snap.tunnelState, 'local');
  assert.equal(snap.local, true);
  assert.equal(snap.sessionId, null);
  assert.equal(snap.jobId, null);
  assert.equal(c.backend.calls.length, 0, '本机会话一个 RPC 都不发');
  assert.equal(c._hbTimer, null);
  assert.equal(c._statusTimer, null);

  await c.stop();
  assert.equal(c.state, State.ENDED);
  assert.equal(disposed, 1);
  assert.equal(c.backend.calls.length, 0, '停止也不发 goodbye');
});

test('本机插件：origin 只认 http://127.0.0.1:<端口>', async () => {
  for (const origin of [
    'https://127.0.0.1:55221',
    'http://localhost:55221',
    'http://127.0.0.1',
    'http://127.0.0.1:55221/editor',
    'http://user:pw@127.0.0.1:55221',
    'not a url',
  ]) {
    const c = make();
    let disposed = 0;
    const snap = await c.startLocal(
      () => good(origin, () => { disposed += 1; }), ctx(), {});
    assert.equal(snap, null, `${origin} 不该被接受`);
    assert.equal(c.state, State.ERROR, origin);
    assert.equal(disposed, 1, `${origin}：已经交出来的 dispose 要收`);
  }
});

test('本机插件：钩子抛错、返回 !ok、超时都进 error', async () => {
  const c1 = make();
  assert.equal(await c1.startLocal(() => { throw new Error('boom'); }, ctx(), {}), null);
  assert.equal(c1.state, State.ERROR);
  assert.match(c1.error, /boom/);

  const c2 = make();
  assert.equal(await c2.startLocal(() => ({ ok: false, message: '端口被占' }), ctx(), {}), null);
  assert.equal(c2.state, State.ERROR);
  assert.match(c2.error, /端口被占/);

  const c3 = make({ localMs: 40 });
  let late = 0;
  assert.equal(await c3.startLocal(
    () => new Promise((r) => setTimeout(
      () => r(good('http://127.0.0.1:55223', () => { late += 1; })), 120)),
    ctx(), {}), null);
  assert.equal(c3.state, State.ERROR);
  await new Promise((r) => setTimeout(r, 160));
  assert.equal(late, 1, '超时之后才交出来的资源也要收');
});

test('本机插件：stop 与 abandon 只 dispose 一次', async () => {
  const c = make();
  let disposed = 0;
  await c.startLocal(() => good('http://127.0.0.1:55224', () => { disposed += 1; }), ctx(), {});
  await c.stop();
  await c.abandon();
  assert.equal(disposed, 1);

  const c2 = make();
  let disposed2 = 0;
  await c2.startLocal(() => good('http://127.0.0.1:55225', () => { disposed2 += 1; }), ctx(), {});
  await c2.abandon();
  assert.equal(disposed2, 1);
  assert.equal(c2.backend.calls.length, 0);
});

test('本机插件：relisten 明确拒绝，不落到「还没有隧道目标」', async () => {
  const c = make();
  await c.startLocal(() => good('http://127.0.0.1:55226', () => {}), ctx(), {});
  const r = await c.relisten('sp2', 55227, new Set());
  assert.equal(r.ok, false);
  assert.match(r.error, /本机会话/);
});
