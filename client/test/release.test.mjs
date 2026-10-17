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
 * release.test.mjs —— 「结束会话」之后那条状态要走完。
 *
 * 这一份守的是两件在真机上一起出现的事（2026-10-17）：
 *
 *   ① 对一条已经结束的会话按「结束会话」时，守护进程回的是它自己的终态
 *      （`op_goodbye` 的原话：`{state: "rejected"}`），不是"这次释放受理了"。
 *      客户端从前只读 `ok`，于是把终态也画成「正在释放…」—— 那一句会一直挂着。
 *   ② 对一条活着的会话，`stop()` 停了心跳、推送与对账，然后就再没有人
 *      去问"释放走完了没有"。状态条于是永远停在「正在释放…」，而站点那边
 *      早就写着「已结束 / 已拒绝」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionController, State } = require('../src/main/session.js');

const ok = (data) => ({ ok: true, code: 0, data, error: null });

/** 一条会话视图，形状照守护进程的 `session_view`。 */
function view(extra = {}) {
  return {
    session_id: 's1', job_id: '42', state: 'enrolled',
    partition: 'A6000', node: 'node01', node_ip: '192.0.2.11', service_port: 55001,
    tunnel_target: '192.0.2.11:55001', resources: { cpus: 2, mem: '8G', gres: null },
    job_state: 'RUNNING', job_terminal: false, renew_count: 0, last_hb_at: 1000,
    ...extra,
  };
}

class StubBackend extends EventEmitter {
  constructor() {
    super();
    this.kind = 'fake';
    this.calls = [];
    this.reply = null;
  }

  get connected() { return true; }

  async rpc(req) {
    this.calls.push(req);
    return this.reply ? this.reply(req) : ok({ session: null });
  }

  count(op) { return this.calls.filter((c) => c.op === op).length; }
}

/**
 * 把控制器推到 RUNNING。
 *
 * 隧道换成记账的桩：真的那个会真的去监听一个端口，整个测试进程会因此多留一个
 *   套接字（与 `suspended.test.mjs` 同一份理由）。
 */
function running(backend) {
  const ctrl = new SessionController({
    backend, releaseMs: 20, heartbeatMs: 60000, statusMs: 60000,
  });
  ctrl.state = State.RUNNING;
  ctrl.sessionId = 's1';
  ctrl.session = view();
  ctrl._lastTarget = ctrl.session.tunnel_target;
  ctrl.tunnel = {
    state: 'listening', origin: null,
    on() {},
    async stop() {},
    async start() { return { port: 18080, shifted: false }; },
  };
  return ctrl;
}

test('对已经结束的会话，stop() 照守护进程的终态收尾，不再进「正在释放」', async () => {
  const b = new StubBackend();
  b.reply = (req) => (req.op === 'goodbye'
    ? ok({ state: 'rejected' })
    : ok({ session: null }));
  const c = running(b);
  const r = await c.stop();
  assert.equal(r.state, 'ended', '结果要说「已结束」，不是「已请求释放」');
  assert.equal(c.state, State.ENDED, '状态机不许停在 releasing');
  assert.equal(c._releaseTimer, null, '已经结束的会话不需要释放轮询');
  assert.match(r.detail, /已拒绝/, '要把守护进程给的终态说出来');
});

test('释放期继续问 status，直到守护进程说出终态', async () => {
  const b = new StubBackend();
  let released = false;
  b.reply = (req) => {
    if (req.op === 'goodbye') return ok({ state: 'releasing' });
    if (req.op === 'status') {
      return ok({ session: view({ state: released ? 'released' : 'releasing' }) });
    }
    return ok({ session: null });
  };
  const c = running(b);
  const r = await c.stop();
  assert.equal(r.state, 'releasing');
  assert.equal(c.state, State.RELEASING);
  assert.ok(c._releaseTimer, '要起一个短轮询 —— 否则永远走不出去');

  released = true;
  for (let i = 0; i < 200 && c.state !== State.ENDED; i++) {
    await new Promise((res) => setTimeout(res, 10));
  }
  assert.equal(c.state, State.ENDED, '守护进程说 released 之后，界面要走到已结束');
  assert.equal(c._releaseTimer, null, '走到终态之后轮询要停');
});

test('释放期的那次轮询不重建隧道（stop 已经把它拆了）', async () => {
  const b = new StubBackend();
  let started = 0;
  b.reply = (req) => {
    if (req.op === 'goodbye') return ok({ state: 'releasing' });
    if (req.op === 'status') {
      return ok({ session: view({ state: 'releasing', tunnel_target: '192.0.2.99:55009' }) });
    }
    return ok({ session: null });
  };
  const c = running(b);
  c.tunnel.start = async () => { started += 1; return { port: 18080, shifted: false }; };
  await c.stop();
  for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(started, 0, '释放期只回答「走完没有」，不许再起一条隧道');
  assert.equal(c.state, State.RELEASING);
  c._stopReleaseWatch();
});
