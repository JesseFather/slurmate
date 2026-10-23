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
 * plugin-host.js —— 父进程这一侧的宿主句柄。
 *
 * 它管四件事：握手、请求与超时、宿主回调的分派、宿主退出之后的收尾。
 * 插件代码不在这个进程里，这一点由构造参数 `workerPath` 与 `spawn` 保证。
 *
 * 请求表按 id 记。宿主退出时把所有未完成请求以 HOST_GONE 拒掉：留下一个
 * 永远不 resolve 的 promise 会让界面停在「准备中」，而那条会话再也不会往前走。
 */

const path = require('path');
const { spawnHost } = require('./host-spawn');
const P = require('./host-protocol');

const WORKER = path.join(__dirname, 'host-worker.js');

// 每个操作的预算。prepare 与 startLocal 是用户等着的；attach 是后台的，
// 给得宽一点，但必须有上限 —— 一个卡住的插件不许把后续状态变化堆在队列里。
const TIMEOUT = {
  prepare: 10000,
  attach: 20000,
  startLocal: 10000,
  disposeLocal: 5000,
};
const HANDSHAKE_TIMEOUT = 10000;
const BYE_TIMEOUT = 500;

// 协议上的错误是纯数据；本地一律转成 Error —— 正则断言与栈都要求它是 Error。
function localErr(e) {
  const err = new Error(e && e.message ? e.message : String(e));
  if (e && e.code) err.code = e.code;
  return err;
}

class PluginHost {
  constructor(opts) {
    this.entry = opts.entry;
    this.key = opts.key;
    this.workerPath = opts.workerPath || WORKER;
    this.spawn = opts.spawn;
    this.onCall = opts.onCall || (async () => null);
    this.onEvent = opts.onEvent || (() => {});
    this.onLog = opts.onLog || (() => {});
    this.onLost = opts.onLost || (() => {});
    this.ready = null;
    this.info = null;
    this._seq = 0;
    this._pending = new Map();
    this._bye = null;
    this._transport = null;
  }

  get pid() {
    return this._transport ? this._transport.pid : null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(v);
      };
      const kill = () => {
        try { if (this._transport) this._transport.kill(); } catch { /* 已经退出 */ }
      };
      const timer = setTimeout(() => {
        kill();
        done(reject, localErr(P.err(P.ERR.HANDSHAKE_TIMEOUT, '插件宿主没有在 10 秒内就绪')));
      }, HANDSHAKE_TIMEOUT);

      let transport;
      try {
        transport = spawnHost(this.workerPath, {
          spawn: this.spawn,
          serviceName: `slurmate-plugin-${this.key}`,
        });
      } catch (e) {
        done(reject, localErr(P.err(P.ERR.SPAWN_FAILED, e.message)));
        return;
      }
      this._transport = transport;
      transport.onExit(({ code, signal }) => this._lost(code, signal));
      transport.onMessage((m) => {
        if (!m || m.v !== P.PROTOCOL) {
          this._fatal(P.err(P.ERR.BAD_VERSION, `协议版本不一致（${m && m.v}）`));
          return;
        }
        if (m.t === 'ready') {
          if (!m.ok) {
            // 握手失败时宿主还活着等消息；不杀掉会留下一个没有会话的进程。
            kill();
            done(reject, localErr(m.error || P.err(P.ERR.INVALID_EXPORTS, '插件没有就绪')));
            return;
          }
          this.info = m.exports || {};
          done(resolve, this.info);
          return;
        }
        this._onMessage(m);
      });

      transport.send(P.msg('init', {
        entry: this.entry,
        key: this.key,
        keysPath: path.join(__dirname, '..', 'keys.js'),
        mainDir: path.join(__dirname, '..'),
      }));
    });
    return this.ready;
  }

  _onMessage(m) {
    if (m.t === 'res') {
      const p = this._pending.get(m.id);
      if (!p) return;
      this._pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.value);
      else {
        p.reject(this._err(m.error));
      }
      return;
    }
    if (m.t === 'call') {
      this._answerCall(m);
      return;
    }
    if (m.t === 'event') {
      if (m.type === 'notice') this.onEvent(m.s, m.kind, m.text);
      return;
    }
    if (m.t === 'log') {
      this.onLog(m.level, m.text);
      return;
    }
    if (m.t === 'bye-ack') {
      if (this._bye) this._bye();
      return;
    }
    if (m.t === 'fatal') {
      this._fatal(this._err(m.error));
    }
  }

  async _answerCall(m) {
    let out;
    try {
      if (!P.CALLS.includes(m.member)) {
        throw P.err(P.ERR.BAD_MEMBER, `宿主请求了不认识的成员：${m.member}`);
      }
      const value = await this.onCall(m.s, m.member, m.args || []);
      out = { v: P.PROTOCOL, t: 'callres', id: m.id, ok: true, value: value === undefined ? null : value };
    } catch (e) {
      // 跨进程那边只认纯数据；Error 实例过 IPC 会丢掉 message/code。
      out = {
        v: P.PROTOCOL,
        t: 'callres',
        id: m.id,
        ok: false,
        error: { code: (e && e.code) || P.ERR.THREW, message: (e && e.message) || String(e) },
      };
    }
    if (!this.dead) this._send(out);
  }

  _err(e) {
    if (!e) return localErr(P.err(P.ERR.THREW, '插件宿主报了一个空错误'));
    if (e instanceof Error) return e;
    return localErr(e);
  }

  _send(m) {
    if (this.dead || !this._transport) return;
    try {
      this._transport.send(m);
    } catch {
      // 宿主已经退出；退出事件会把未完成的请求收掉。
    }
  }

  request(session, op, ctx, args, timeoutMs) {
    if (!P.OPS.includes(op)) {
      return Promise.reject(localErr(P.err(P.ERR.BAD_MEMBER, `不认识的操作：${op}`)));
    }
    if (this.dead) {
      return Promise.reject(localErr(P.err(P.ERR.HOST_GONE, '插件进程已经退出')));
    }
    const id = `p${++this._seq}`;
    const ms = timeoutMs || TIMEOUT[op] || 10000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        this._send(P.msg('cancel', { id, reason: 'timeout' }));
        reject(localErr(P.err(P.ERR.TIMEOUT, `${op} 超过 ${ms} 毫秒没有返回`)));
      }, ms);
      this._pending.set(id, { resolve, reject, timer, op, session });
      this._send(P.req(id, session, op, ctx, args));
    });
  }

  // 会话上下文变了时主动下发；宿主不需要回复。
  patch(session, ctx) {
    this._send(P.msg('patch', { s: session, ctx }));
  }

  sessionClosed(session) {
    this._send(P.msg('session-closed', { s: session }));
  }

  _lost(code, signal) {
    if (this.dead) return;
    this.dead = true;
    const why = localErr(P.err(P.ERR.HOST_GONE,
      `插件进程已退出（code=${code === null ? 'null' : code}${signal ? `，signal=${signal}` : ''}）`));
    this._rejectAll(why);
    if (this._bye) this._bye();
    if (!this._closing) this.onLost(why);
  }

  _fatal(e) {
    this._rejectAll(localErr(e));
    try { if (this._transport) this._transport.kill(); } catch { /* 已经退出 */ }
  }

  _rejectAll(e) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this._pending.clear();
  }

  async close() {
    if (this.dead) return;
    this._closing = true;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, BYE_TIMEOUT);
      this._bye = () => { clearTimeout(timer); resolve(); };
      this._send(P.msg('bye'));
    });
    if (!this.dead) {
      this.dead = true;
      try { this._transport.kill(); } catch { /* 已经退出 */ }
      this._rejectAll(localErr(P.err(P.ERR.HOST_GONE, '插件进程已退出')));
    }
  }
}

module.exports = { PluginHost, TIMEOUT, HANDSHAKE_TIMEOUT };
