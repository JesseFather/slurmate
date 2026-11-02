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
 * submit.test.mjs —— 提交超时之后那一次认领。
 *
 * 2026-11-02 真机：登录节点在 NFS 压力下卡住，提交四十五秒超时；随后那一次
 * 认领撞上同一条卡住的链路，客户端于是宣布「提交超时且未能认领会话」——
 * 而作业其实已经在跑。
 *
 * 这里钉住两件事：认领有两次机会；而「守护进程明确答了没有」是一句结论，
 * 不许被当成一次失败再问一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionController, State } = require('../src/main/session.js');

/** 这些代码里的定时器都 unref 了（Electron 主进程里应用自己撑着事件循环）。 */
function keepAlive() {
  const h = setInterval(() => {}, 1000);
  return () => clearInterval(h);
}

const ok = (data) => ({ ok: true, code: 0, data, error: null });
const transport = () => ({
  ok: false, code: null, data: null,
  error: { kind: 'transport', detail: '登录节点上的命令超过 20 秒没有应答。' },
});

/** 一个只记账的后端。`replies` 按调用次序消费，用完之后一律回「没有会话」。 */
class StubBackend extends EventEmitter {
  constructor(replies) {
    super();
    this.kind = 'fake';
    this.calls = [];
    this.replies = replies.slice();
  }

  get connected() { return true; }

  async rpc(req) {
    this.calls.push(req);
    const f = this.replies.shift();
    return f ? f(req) : ok({ session: null });
  }
}

const view = { session_id: 's-new', job_state: 'RUNNING', state: 'submitted' };

function ctrlWith(replies) {
  const backend = new StubBackend(replies);
  const ctrl = new SessionController({
    backend, workspaceId: 'L1',
    claimRetryMs: 1,        // 生产是两秒；这里只验「有没有第二次」
    statusRpcMs: 50,
  });
  ctrl._setState(State.SUBMITTING);
  return { ctrl, backend };
}

test('认领撞上一次传输失败：再问一次，不许把「没问到」当成「没有」', async () => {
  const stop = keepAlive();
  try {
    const { ctrl, backend } = ctrlWith([
      () => { throw new Error('通道没有应答'); },
      () => ok({ session: view }),
    ]);
    assert.equal(await ctrl._claim(), true);
    assert.equal(ctrl.sessionId, 's-new', '第二次拿到的会话要真的认下来');
    assert.equal(ctrl.state, State.QUEUED);
    assert.equal(backend.calls.length, 2, '第二次问是同一次认领的一部分');
    assert.ok(backend.calls.every((c) => c.op === 'status'),
      '认领只许问 status（不带 session_id）');
  } finally {
    stop();
  }
});

test('而传输层的信封（不是异常）也属于「没问到」', async () => {
  const stop = keepAlive();
  try {
    const { ctrl, backend } = ctrlWith([
      () => transport(),
      () => ok({ session: view }),
    ]);
    assert.equal(await ctrl._claim(), true);
    assert.equal(ctrl.sessionId, 's-new');
    assert.equal(backend.calls.length, 2);
  } finally {
    stop();
  }
});

test('守护进程明确答了「没有活跃会话」就不再问第二次', async () => {
  const stop = keepAlive();
  try {
    const { ctrl, backend } = ctrlWith([() => ok({ session: null })]);
    assert.equal(await ctrl._claim(), false);
    assert.equal(backend.calls.length, 1, '这是一句结论，不是一次失败');
    assert.equal(ctrl.sessionId, null);
  } finally {
    stop();
  }
});

test('两次都没有应答：认领失败，并且确实只问了两次', async () => {
  const stop = keepAlive();
  try {
    const { ctrl, backend } = ctrlWith([() => transport(), () => transport()]);
    assert.equal(await ctrl._claim(), false);
    assert.equal(backend.calls.length, 2);
    assert.equal(ctrl.sessionId, null);
  } finally {
    stop();
  }
});
