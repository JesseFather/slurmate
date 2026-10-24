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
 * relay-demo 的客户端侧 —— 测试夹具。
 *
 * 它扮的是"没有界面的中转站"：端口一个都不要（`contributes.ports = 0`），
 *   但要一把公钥（`contributes.submitPubkey`），因为提交时守护进程会要它。
 *
 * 公钥只求形状对：假站点与集群测试都只判这一次提交带没带，不拿它去登录。
 *   生成走框架给的 `ctx.keys`，与真插件用的是同一条路。
 *
 * `attach` 不连任何东西：它把"框架这次递进来的连接"记在插件数据目录里，
 *   好让基座套件验那条接缝（`ctx.connection()` 是这条会话的，不是当前活跃的）。
 *   观察靠文件，不靠返回值 —— `attach` 的返回值按契约被忽略。
 */

const fs = require('fs');
const path = require('path');

let pubkey = null;
let attachSeq = 0;

module.exports = {
  closeWarning: {
    message: '关闭窗口会结束这个中转会话。',
    detail: '你用这个中转站连着的终端与远程窗口会当场断开，作业也会被取消。',
  },

  prepare,
  attach,
};

/** 提交之前要的那把公钥。第二次起复用，与真插件"只生成一次"同形。 */
function prepare(ctx) {
  if (!pubkey) {
    try {
      pubkey = ctx.keys.generate().publicKeyLine;
    } catch (e) {
      return { ok: false, message: `夹具生成密钥失败：${e.message}` };
    }
  }
  return { ok: true, sshPubkey: pubkey };
}

/**
 * 没有界面，也就没有要接上的东西。把这一次拿到的连接写进数据目录，
 *   基座那条接缝用例读的就是它（每次状态变化都会调，所以每次都要重写）。
 */
function attach(ctx, snap) {
  const c = ctx.connection() || {};
  const dir = ctx.dataDir();
  fs.mkdirSync(dir, { recursive: true });
  // 原子写：先落临时文件再改名。直接 writeFileSync 会先把目标截成 0 字节，
  //   而基座套件在另一个进程里轮询这个文件 —— 它可能在截断与写完之间读到空文件。
  const final = path.join(dir, 'attach.json');
  const tmp = path.join(dir, `attach.json.${process.pid}.${attachSeq++}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({
    user: c.user || null,
    host: c.host || null,
    port: c.port || null,
    serviceKind: (snap && snap.serviceKind) || null,
  }));
  fs.renameSync(tmp, final);
}
