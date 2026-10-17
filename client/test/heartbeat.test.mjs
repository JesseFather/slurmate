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
 * heartbeat.test.mjs —— 心跳失败时，界面那句警告该说什么、不该说什么。
 *
 * 已知的两种失败在界面上是同一块东西（`snapshot().warning` → 整屏遮罩），
 *   而它们的含义正好相反：
 *
 *     传输层断了 / 守护进程不可达 → 连接真的出了问题，要说
 *     站点限流（code 7）         → 连接是好的，只是这一拍被拒，不该说
 *
 * 后者的代价在 2026-10-18 真机上量到了：接回站点那一阵的突发打满站点的桶，
 *   心跳被回 `rate_limited`，界面立刻挂出「连接暂时中断」，而下一拍成功要等
 *   四十五秒 —— 用户盯着一句不成立的话，遮罩才自己消失。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionController, State } = require('../src/main/session.js');

const ok = (data) => ({ ok: true, code: 0, data, error: null });
const limited = () => ({ ok: false, code: 7, error: { kind: 'rate_limited' } });

/** 一条会话视图，形状照守护进程的 `session_view`（只留快照用到的那些格）。 */
function view() {
  return {
    session_id: 's1', job_id: '42', state: 'enrolled',
    partition: 'A6000', node: 'node01', node_ip: '192.0.2.11', service_port: 55001,
    tunnel_target: '192.0.2.11:55001', resources: { cpus: 2, mem: '8G', gres: null },
    job_state: 'RUNNING', job_terminal: false, renew_count: 0, last_hb_at: 1000,
  };
}

/** 只记账的后端；`reply` 决定下一次 `rpc` 回什么。 */
class StubBackend extends EventEmitter {
  constructor() {
    super();
    this.kind = 'fake';
    this.reply = null;
  }

  get connected() { return true; }

  async rpc() { return this.reply || ok({ session: view() }); }
}

function running(backend) {
  const ctrl = new SessionController({ backend, workspaceId: 'L1' });
  ctrl.state = State.RUNNING;
  ctrl.sessionId = 's1';
  ctrl.session = view();
  ctrl._lastTarget = ctrl.session.tunnel_target;
  ctrl.tunnel = { state: 'listening', origin: null, on() {}, async stop() {}, async start() {} };
  return ctrl;
}

test('心跳被限流不是断线：一拍不说，连着两拍才进 warning；恢复之后撤掉', async () => {
  const b = new StubBackend();
  const c = running(b);
  b.reply = limited();

  await c._beat();
  assert.equal(c.snapshot().warning, null,
    '一次限流不许挂出「连接暂时中断」—— 那一刻连接是好的');

  await c._beat();
  assert.match(c.snapshot().warning || '', /限流/,
    '连着两拍都被限流（九十秒没有一次成功心跳）就该让人知道');
  assert.match(c.snapshot().warning, /仍在重试/);

  b.reply = null;
  await c._beat();
  assert.equal(c.snapshot().warning, null, '下一拍成功，那句话要跟着撤掉');
  assert.equal(c._rateLimitedBeats, 0, '计数器归零 —— 下一次限流重新从一拍算起');
});
