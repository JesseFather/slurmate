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
 * 本机样例：只有客户端一半的插件。
 *
 * 它演示 `startLocal` 的形状：在回环地址上起一个页面，返回 origin 与一个幂等的
 *   dispose。没有作业侧，也不该有 —— 这正是站点报 `can_submit: false` 的那种插件。
 *
 * 它住在 `tools/fixtures/`，不进基座分发，只给用例用。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

function startLocal(ctx, opts = {}) {
  return new Promise((resolve) => {
    let dataDir = null;
    try {
      dataDir = ctx.dataDir();
    } catch {
      dataDir = null;
    }

    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>本机样例</title>'
        + '<p>本机插件正在运行。</p>');
    });
    srv.on('error', (e) => {
      resolve({ ok: false, message: `监听回环端口失败：${e.message}` });
    });

    const port = Number.isInteger(opts.port) && opts.port > 0 ? opts.port : 0;
    srv.listen(port, '127.0.0.1', () => {
      let done = false;
      resolve({
        ok: true,
        origin: `http://127.0.0.1:${srv.address().port}`,
        dispose: () => {
          if (done) return;
          done = true;
          if (dataDir) {
            try {
              fs.mkdirSync(dataDir, { recursive: true });
              fs.appendFileSync(path.join(dataDir, 'disposed'), '1\n');
            } catch {
              /* 夹具的落盘标记，写不进去不影响 stop 的语义 */
            }
          }
          if (srv.listening) srv.close();
          if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
        },
      });
    });
  });
}

module.exports = { startLocal };
