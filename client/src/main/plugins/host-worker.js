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
 * host-worker.js —— 插件宿主的子进程入口。
 *
 * 这个进程只做三件事：加载一个插件、按父进程的请求调钩子、把 ctx 需要的东西
 * 现算出来。它不 require `electron`：父进程那边是什么运行时与它无关。
 *
 * 钩子在这里串行执行。插件作者写入的是普通函数，两个会话同时进入同一个模块的
 * 状态是今天主进程里不会发生的事；进程边界不该把它变成可能。
 */

const { validateClientModule } = require('./hooks');
const P = require('./host-protocol');

// 两种运行时的父通道。Electron 的 utilityProcess 给 `process.parentPort`；
// child_process.fork 给 `process.send` / `process.on('message')`。
const parentPort = process.parentPort || null;
function send(m) {
  // 父进程可能已经走了；往一个关掉的通道写会抛 EPIPE，而那不该让宿主崩掉。
  try {
    if (parentPort) parentPort.postMessage(m);
    else if (process.send) process.send(m);
  } catch { /* 通道已关闭 */ }
}
function onMessage(fn) {
  if (parentPort) parentPort.on('message', (e) => fn(e && e.data !== undefined ? e.data : e));
  else process.on('message', fn);
}

let hooks = null;
let keys = null;
const sessions = new Map();
let seq = 0;
const calls = new Map();
const cancelled = new Set();
let chain = Promise.resolve();
let closing = false;

function enqueue(fn) {
  const next = chain.then(fn, fn);
  chain = next.then(() => {}, () => {});
  return next;
}

function clone(v) {
  return v === undefined ? null : structuredClone(v);
}

function stateOf(session) {
  let st = sessions.get(session);
  if (!st) {
    st = { ctx: {}, once: new Set(), tokens: new Map() };
    sessions.set(session, st);
  }
  return st;
}

function makeCtx(session) {
  const st = stateOf(session);
  const value = (slot, what) => {
    const v = st.ctx[slot];
    if (!v || !v.ok) throw new Error((v && v.error) || `无法获取${what}`);
    return v.value;
  };
  return {
    win: {
      reloadSurface: () => callParent(session, 'reloadSurface'),
    },
    connection: () => Object.freeze(clone(st.ctx.connection)),
    keys,
    session: () => clone(st.ctx.session),
    whoami: () => clone(st.ctx.whoami),
    home: () => value('home', '家目录'),
    dataDir: () => value('dataDir', '插件数据目录'),
    login: (origin) => callParent(session, 'login', [origin]),
    notice: (kind, text) => {
      send(P.msg('event', { s: session, type: 'notice', kind, text }));
    },
    // 去重表跟着宿主走：宿主重启会清空，写进契约。
    once: (key) => {
      if (st.once.has(key)) return false;
      st.once.add(key);
      return true;
    },
  };
}

function callParent(session, member, args) {
  const id = `c${++seq}`;
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject });
    send(P.call(id, session, member, args || []));
  });
}

async function disposeToken(session, token) {
  const st = sessions.get(session);
  const t = st && st.tokens.get(token);
  if (!t) return false;
  st.tokens.delete(token);
  try {
    await t.dispose();
  } catch (e) {
    send(P.msg('log', { level: 'warn', text: `dispose 抛错：${e && e.message}` }));
  }
  return true;
}

async function disposeSession(session) {
  const st = sessions.get(session);
  if (!st) return;
  for (const token of [...st.tokens.keys()]) await disposeToken(session, token);
  sessions.delete(session);
}

async function run(op, session, ctxData, args, id) {
  const st = stateOf(session);
  st.ctx = ctxData || {};
  const ctx = makeCtx(session);
  if (op === 'prepare') {
    if (!hooks.prepare) return { ok: true };
    const out = await hooks.prepare(ctx);
    if (!out || typeof out !== 'object') {
      throw P.err(P.ERR.THREW, 'prepare 必须返回 {ok: true} 或 {ok: false, message}');
    }
    return out;
  }
  if (op === 'attach') {
    if (!hooks.attach) return null;
    await hooks.attach(ctx, args.snap);
    return null;
  }
  if (op === 'startLocal') {
    if (!hooks.startLocal) {
      throw P.err(P.ERR.THREW, '这个插件没有 startLocal');
    }
    const out = await hooks.startLocal(ctx, { port: args.port });
    if (!out || typeof out !== 'object') {
      throw P.err(P.ERR.THREW, 'startLocal 必须返回 {ok: true, origin} 或 {ok: false, message}');
    }
    if (out.ok && typeof out.dispose === 'function') {
      const token = `t${++seq}`;
      st.tokens.set(token, { dispose: out.dispose });
      return { ok: true, origin: out.origin, token, hasDispose: true };
    }
    if (out.ok) return { ok: true, origin: out.origin, hasDispose: false };
    return { ok: false, message: out.message || '本机插件没有启动' };
  }
  if (op === 'disposeLocal') {
    return { disposed: await disposeToken(session, args.token) };
  }
  throw P.err(P.ERR.BAD_MEMBER, `不认识的操作：${op}`);
}

onMessage((m) => {
  if (!m || m.v !== P.PROTOCOL) {
    send(P.msg('fatal', { error: P.err(P.ERR.BAD_VERSION, `协议版本不一致（${m && m.v}）`) }));
    return;
  }
  if (m.t === 'init') {
    let mod;
    try {
      mod = require(m.entry);
    } catch (e) {
      send(P.msg('ready', { ok: false, error: P.err(P.ERR.LOAD_FAILED, `${m.entry}：加载失败（${e.message}）`) }));
      return;
    }
    const checked = validateClientModule(mod, m.entry);
    if (checked.error) {
      send(P.msg('ready', { ok: false, error: P.err(P.ERR.INVALID_EXPORTS, checked.error) }));
      return;
    }
    hooks = checked.hooks;
    try {
      // 只交契约 §4.2 的那六个函数。模块对象上还有 `_internal`（本仓库用例
      //   用的），整份递出去等于给插件看了一张没写进契约的表。
      const k = require(m.keysPath);
      keys = Object.freeze({
        generate: k.generate,
        publicKeyLine: k.publicKeyLine,
        publicKeyLineFromPrivatePem: k.publicKeyLineFromPrivatePem,
        isUsablePrivatePem: k.isUsablePrivatePem,
        fingerprintOf: k.fingerprintOf,
        isValidPublicKeyLine: k.isValidPublicKeyLine,
      });
    } catch (e) {
      send(P.msg('ready', { ok: false, error: P.err(P.ERR.LOAD_FAILED, `加载 keys.js 失败（${e.message}）`) }));
      return;
    }
    send(P.msg('ready', {
      ok: true,
      exports: {
        key: m.key,
        has: {
          prepare: Boolean(hooks.prepare),
          attach: Boolean(hooks.attach),
          startLocal: Boolean(hooks.startLocal),
        },
        closeWarning: hooks.closeWarning || null,
      },
    }));
    return;
  }
  if (m.t === 'callres') {
    const p = calls.get(m.id);
    if (!p) return;
    calls.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(m.error || P.err(P.ERR.THREW, '父进程拒绝了这次调用'));
    return;
  }
  if (m.t === 'req') {
    if (!hooks) {
      send(P.res(m.id, false, null, P.err(P.ERR.BAD_MESSAGE, '宿主还没有初始化')));
      return;
    }
    enqueue(async () => {
      if (cancelled.has(m.id)) {
        cancelled.delete(m.id);
        return;
      }
      try {
        const out = await run(m.op, m.s, m.ctx, m.args || {}, m.id);
        // 父进程已经放弃这次请求：startLocal 拿到的资源要当场收掉，
        // 不能因为没人接收就留下一个正在监听的端口。
        if (cancelled.has(m.id)) {
          cancelled.delete(m.id);
          if (m.op === 'startLocal' && out && out.token) await disposeToken(m.s, out.token);
          return;
        }
        send(P.res(m.id, true, out));
      } catch (e) {
        if (cancelled.delete(m.id)) return;
        send(P.res(m.id, false, null, e && e.code ? e : P.err(P.ERR.THREW, e && e.message ? e.message : String(e))));
      }
    });
    return;
  }
  if (m.t === 'cancel') {
    cancelled.add(m.id);
    return;
  }
  if (m.t === 'patch') {
    stateOf(m.s).ctx = m.ctx || {};
    return;
  }
  if (m.t === 'session-closed') {
    disposeSession(m.s).finally(() => {});
    return;
  }
  if (m.t === 'bye') {
    closing = true;
    Promise.all([...sessions.keys()].map((s) => disposeSession(s))).finally(() => {
      send(P.msg('bye-ack'));
      setTimeout(() => process.exit(0), 20);
    });
    return;
  }
});

// 父进程不见了（被 kill、崩溃）就自己退出：留下一个孤儿宿主会让下一次启动
// 看到两个进程，而那个孤儿已经没有会话可服务。
process.on('disconnect', () => { if (!closing) process.exit(0); });
