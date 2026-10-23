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
 * host-protocol.js —— 主进程与插件宿主之间的消息形状。
 *
 * 只有这一个文件定义消息。两边各写一遍的风险与「同一条规矩两份实现」相同：
 * 改了一处，另一处不会红，症状是某个钩子永远超时。
 *
 * 版本号跟着协议走：形状改了就加一，握手时两边逐字比对，不同就拒。
 */

const PROTOCOL = 1;

// 错误码。父侧把宿主给的原始 message 包成一句人话，不在这里写文案。
const ERR = {
  BAD_VERSION: 'BAD_VERSION',
  BAD_MESSAGE: 'BAD_MESSAGE',
  HANDSHAKE_TIMEOUT: 'HANDSHAKE_TIMEOUT',
  SPAWN_FAILED: 'SPAWN_FAILED',
  LOAD_FAILED: 'LOAD_FAILED',
  INVALID_EXPORTS: 'INVALID_EXPORTS',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  HOST_GONE: 'HOST_GONE',
  SESSION_GONE: 'SESSION_GONE',
  BAD_MEMBER: 'BAD_MEMBER',
  THREW: 'THREW',
};

// 父进程发给宿主的操作。只允许这四个：钩子之外的东西不走这条通道。
const OPS = ['prepare', 'attach', 'startLocal', 'disposeLocal'];

// 宿主可以回调父进程的成员。它是 ctx 里唯一需要往返的两项。
const CALLS = ['login', 'reloadSurface'];

function msg(t, extra) {
  return { v: PROTOCOL, t, ...(extra || {}) };
}

function req(id, session, op, ctx, args) {
  return msg('req', { id, s: session, op, ctx, args: args || {} });
}

function res(id, ok, value, error) {
  return ok
    ? msg('res', { id, ok: true, value: value === undefined ? null : value })
    : msg('res', { id, ok: false, error });
}

function call(id, session, member, args) {
  return msg('call', { id, s: session, member, args: args || [] });
}

function err(code, message) {
  return { code, message: message || code };
}

module.exports = { PROTOCOL, ERR, OPS, CALLS, msg, req, res, call, err };
