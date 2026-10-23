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

// 插件宿主的生命周期：复用、升级、退休、收尾。纯 Node，起真的子进程。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry } = require('../src/main/plugins/index.js');
const SLOT = require('../src/main/plugin-slot.js');
const PPACK = require('../src/main/plugin-package.js');
const ULID = require('../src/main/plugins/ulid.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-life-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function writePlugin(root, { id = ULID.mint(), version = '1.0.0', src = 'module.exports = {};\n' } = {}) {
  const slot = SLOT.slotNameOf(id, version);
  const dir = path.join(root, slot);
  fs.mkdirSync(path.join(dir, 'client'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id, name: 'demo', displayName: '演示', version,
    contributes: { concurrent: false },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'client', 'index.js'), src);
  const P = require('../src/main/plugins/index.js');
  const files = P.readPluginFiles(dir).filter((f) => f.kind === 'f')
    .map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
  const rec = { schema: SLOT.RECORD_SCHEMA, format: PPACK.FORMAT, envelope: null, files };
  const w = SLOT.writeRecordFile(SLOT.recordPathOf(root, id, version), rec);
  assert.ok(w.ok, w.error);
  return { id, version, dir };
}

test('同摘要的 reload 复用同一个宿主（不重启进程、不清 once 表）', async () => {
  const pool = fs.mkdtempSync(path.join(TMP, 'pool-'));
  writePlugin(pool);
  const reg = new Registry([{ dir: pool, source: 'site' }]);
  await reg.ready;
  const first = reg.list()[0];
  assert.ok(first && first.host, '应当建出一个宿主');
  await first.ready;
  const pid = first.host.pid;

  await reg.reload();
  const again = reg.list()[0];
  assert.equal(again.host, first.host, '第二次扫描必须复用宿主');
  assert.equal(again.host.pid, pid, '进程号也不变');
  await reg.closeAll();
});

test('新版本起新宿主；旧版本有活会话就先不退', async () => {
  const pool = fs.mkdtempSync(path.join(TMP, 'pool-'));
  const a = writePlugin(pool, { version: '1.0.0' });
  const live = new Set([`${a.id}@1.0.0`]);
  const lost = [];
  const reg = new Registry([{ dir: pool, source: 'site' }], {
    liveKeys: () => live,
    onHostLost: (p, e) => lost.push([p && p.version, e.message]),
  });
  await reg.ready;
  const oldPlugin = reg.get(a.id, '1.0.0');
  await oldPlugin.ready;
  const oldHost = oldPlugin.host;

  writePlugin(pool, { id: a.id, version: '1.1.0' });
  await reg.reload();
  assert.ok(reg.get(a.id, '1.1.0'), '新版本要进来');
  assert.ok(reg.hosts.has(`${a.id}@1.0.0`), '两个版本各有宿主');

  // 旧版本从池里消失（卸载/被回收），而它上面还有一条活会话：宿主不许退。
  SLOT.removeRecordFile(SLOT.recordPathOf(pool, a.id, '1.0.0'));
  fs.rmSync(SLOT.treeDirOf(pool, a.id, '1.0.0'), { recursive: true, force: true });
  await reg.reload();
  assert.equal(reg.get(a.id, '1.0.0'), null, '旧版本不在注册表里了');
  assert.ok(reg.hosts.has(`${a.id}@1.0.0`),
    `有活会话时旧宿主还留在池里（hosts=${[...reg.hosts.keys()]} lost=${JSON.stringify(lost)}）`);

  live.clear();
  await reg.reload();
  assert.equal(reg.hosts.has(`${a.id}@1.0.0`), false,
    `最后一条会话结束后旧宿主退出（hosts=${[...reg.hosts.keys()]}）`);
  await reg.closeAll();
});

test('closeAll 收掉所有宿主，且不再上报成崩溃', async () => {
  const pool = fs.mkdtempSync(path.join(TMP, 'pool-'));
  writePlugin(pool);
  const lost = [];
  const reg = new Registry([{ dir: pool, source: 'site' }], {
    onHostLost: (p, e) => lost.push(e),
  });
  await reg.ready;
  const p = reg.list()[0];
  await p.ready;
  const host = p.host;
  await reg.closeAll();
  assert.equal(host.dead, true);
  assert.deepEqual(lost, [], '主动关闭不是崩溃');
});
