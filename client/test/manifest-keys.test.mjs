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
 * manifest-keys.test.mjs —— 「清单里认得的键」这一个**封闭集合**。
 *
 * 这一份钉两件事，缺一件另一件就是空话：
 *
 *   ① **判据只有一份书面形式**（`tools/manifest-keys.json`），客户端那五张常量表
 *      与它**逐字相同**（有序，不只是集合相等）。少了这一条，"客户端拒"与
 *      "守护进程拒"就可以各认各的键，而两边都绿。
 *
 *   ② 五个位置上各拼错一个键 ⇒ **装不上，且报错点名那个键**。少了这一条，①
 *      只是一条常量比对 —— 真接在清单那条路上的是不是这五张表，没人验。
 *
 * ★ 为什么要有 ① 而不是"两边各写一份、靠一条 lint 比对"：那是 COPY_SKIP 那个
 *   先例的形状，而它只适用于**必须住在各自文件里**的常量。这里多一份可读的
 *   JSON 的理由是"改规则"应当有一个**独立的**落点 —— 读的人不必同时读 JS 与
 *   Python 才知道认得的键有哪些。
 *
 * ★ 为什么不干脆让生产代码在运行期读那份 JSON：客户端是一个**分发单元**，
 *   运行期只读 `client/` 里的东西（唯一一处往外走的是开发者模式的
 *   `defaultDevPluginSourceDir()`，而它显式处理"安装包里没有它"）。写一条相对
 *   路径的话，从源码跑得通、**装出去就断**：键表成了空集，"什么都不拒"。
 *   完整理由写在那份 JSON 的 `_` 段里。守护进程那一侧同理（它是一个文件装到
 *   `/usr/local/sbin/`），它的用例是 `cluster/test-sessiond-logic.py` 的 19.16。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../src/main/plugins/index.js');

const KEYS_PATH = fileURLToPath(
  new URL('../../tools/manifest-keys.json', import.meta.url));
const KEYS = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));

/** 书面判据里的五张表 ↔ 客户端那五个常量。
 *  `surface` / `login` / `data` 是 `contributes` 底下的三个子对象 —— 那份 JSON
 *  把它们放在顶层，因为它们各自是一张表（与 `contributes` 那张并列，不是嵌在里面）。 */
const TABLES = [
  ['manifest', P.MANIFEST_KEYS],
  ['contributes', P.CONTRIBUTES_KEYS],
  ['surface', P.SURFACE_KEYS],
  ['login', P.LOGIN_KEYS],
  ['data', P.DATA_KEYS],
];

test('★★ 客户端那五张键表与 tools/manifest-keys.json 逐字相同（有序列出）', () => {
  for (const [name, mine] of TABLES) {
    const written = KEYS[name];
    // ★ 先验"那份 JSON 里真的有一张非空的表" —— 否则 `deepEqual([], [])` 会绿，
    //   而那正是这条用例要防的那种假通过（一个被清空的判据看起来最像通过）。
    assert.ok(Array.isArray(written) && written.length > 0,
      `tools/manifest-keys.json 的 ${name} 必须是一个非空数组：${JSON.stringify(written)}`);
    assert.ok(Array.isArray(mine) && mine.length > 0,
      `客户端导出的 ${name} 必须是一个非空数组（导出了吗？）：${JSON.stringify(mine)}`);
    // 有序比对：顺序也是判据的一部分 —— 报错里"认识的只有 …"那一串用的是它，
    // 而两侧那份文案读起来一样，排查时才有用。
    assert.deepEqual(mine, written,
      `客户端的 ${name} 与书面判据对不上 —— 改规则要同时改 `
      + `tools/manifest-keys.json 与两侧的实现`);
  }
});

// ── ② 拼错了会怎样：装不上，而且报错点名那个键 ──────────────────────────────

const ID = '01M2JKHTZGKJBFQQTWYXMQMF2V';

/** 一份**完整合法**的清单 —— 每一条反例都只在它上面动一个键名。 */
function validManifest() {
  return {
    id: ID, name: 'code-server', displayName: '开发环境', version: '1.0.0',
    description: '', author: 'slurmate',
    engines: { slurmate: '>=0.5' },
    contributes: {
      surface: { kind: 'web', path: '/' },
      login: { path: '/login', field: 'password', cookie: 'cs' },
      layout: true, submitPubkey: false, concurrent: true,
      data: { inherit: 'editor' },
    },
    site: { defaultCpus: 2, defaultMem: '8G' },
  };
}

/** 写进一个临时目录，然后走一遍**真的**校验器（不模拟它）。 */
function inspect(mf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-mk-'));
  try {
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(mf, null, 2));
    return P.inspectDir(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('★★ 五个位置各拼错一个键 ⇒ 装不上，报错点名那个键', () => {
  // ★ 正对照**必须排在最前面**：没有它，下面五条会被"什么都拒"一并满足，而
  //   那与"这一格判对了"在测试输出里长得一模一样。
  const ok = inspect(validManifest());
  assert.equal(ok.error, undefined,
    `正对照：一份完整合法的清单必须装得上，实际：${ok.error}`);

  const cases = [
    ['顶层', (m) => m.contribution = {}, 'contribution'],
    ['contributes 子键', (m) => m.contributes.contrib = 1, 'contrib'],
    ['contributes.surface 子键', (m) => m.contributes.surface.knd = 'web', 'knd'],
    ['contributes.login 子键', (m) => m.contributes.login.pathh = '/', 'pathh'],
    ['contributes.data 子键', (m) => m.contributes.data.inheritt = 'x', 'inheritt'],
  ];
  for (const [where, edit, key] of cases) {
    const mf = validManifest();
    edit(mf);
    const r = inspect(mf);
    assert.ok(r.error, `${where}：拼错成 ${key} 必须装不上`);
    assert.match(r.error, /认不得的键/,
      `${where}：要说清是"这个键我不认识"，而不是别的毛病：${r.error}`);
    assert.match(r.error, new RegExp(key),
      `${where}：报错必须**点名**那个键 —— 只说"清单有问题"等于没说：${r.error}`);
  }
});

test('★ 边界：`site` 段内部的拼错**两侧都不报**（这一段只有一侧读）', () => {
  // ★ 这一条钉的是一条**刻意留着**的不对称，不是一条保证。
  //
  //   `site` 段是站点侧读的（客户端只把它当不透明数据、只查"是不是对象"），而
  //   守护进程逐键校验它真读的那几个（defaultCpus / defaultMem / defaultEnabled…）
  //   但**不查未知键**。所以 `site.defaultCpuss` 这种拼错今天会被**静默忽略**，
  //   症状是"配了但不生效" —— 与未知键那条规则要消灭的正是同一类东西。
  //   它在账本里记着（CONTRACT.md §2 的表 T8 那一行），修不修是一个独立的决定。
  //
  //   ★ 为什么把它写成一条用例：这样**将来谁收紧了，会先看到这一行**，而不是
  //     在某次无关的改动里悄悄改掉这条边界。一条没人写下来的边界，等于没有边界。
  const mf = validManifest();
  mf.site.defaultCpuss = 4;
  const r = inspect(mf);
  assert.equal(r.error, undefined,
    '客户端今天不查 site 段内部的未知键 —— 这一条红了的话，说明有人收紧了它，'
    + `请把那件事记进账本并改掉这一条：${r.error}`);
});
