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
 * sessionstate.test.mjs —— **会话状态**那张表，以及它与另外两处的逐字一致性。
 *
 * ★★ 为什么这一条测试值得单独一个文件：同一份状态词表在这个仓库里有**三处**，
 *   而它们住在三个**独立分发**的程序里，没有共享代码的路：
 *
 *       守护进程 `cluster/slurmate-sessiond`   —— 定义（`ST_*` 那一组常量）
 *       命令行   `cluster/slurmate`            —— `human_state()` 那张表
 *       客户端   `src/main/sessionstate.js`    —— 同一张表
 *
 *   于是这份重复是**结构性的**，删不掉；能做的只有把它**钉住**。
 *   漂开的后果不是风格问题：同一台集群上，用户在命令行看到「连接中断（作业仍在
 *   运行）」而在界面上看到「已结束」，他会去重新提交一个还在烧着 GPU 的作业。
 *   （同一形状的先例是 `cluster/slurmate` 的 `parse_gres_spec` 与守护进程的
 *   `gres_spec()` —— 那一对也有一条跨文件的往返用例钉着。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..', '..');

const { sessionStateText, SESSION_STATE_TEXT } =
  require('../src/main/sessionstate.js');

// ── 单元 ────────────────────────────────────────────────────────────────────

test('认得的状态译成人话，认不得的原样印出去（不猜）', () => {
  assert.equal(sessionStateText('enrolled'), '运行中');
  assert.equal(sessionStateText('released'), '已结束');

  // ★★ 这一句是这张表里最要紧的一句：`suspect` 是「**我们**不知道它还在不在」，
  //   不是「它没了」。印成一句光秃秃的「连接中断」，用户会去重新提交一个作业 ——
  //   而原来那个还在跑。
  const sus = sessionStateText('suspect');
  assert.match(sus, /作业仍在运行/,
    `会话 suspect ≠ 作业没了，这句话必须带上后半句：${JSON.stringify(sus)}`);

  // ★ 认不出来的一律原样印。守护进程可以比这个客户端新，而"印一个我不认识的
  //   状态名"是诚实的，"猜一个可能是错的说法"不是。
  assert.equal(sessionStateText('SOMETHING_NEW'), 'SOMETHING_NEW');
  assert.equal(sessionStateText(''), '');
  assert.equal(sessionStateText(null), '');
});

test('★ 这张表只译**会话**状态，不译作业状态（两张表别混）', () => {
  // 会话状态是小写单词，Slurm 作业状态是大写枚举。混进来的症状是"作业状态那一行
  // 永远显示原文"（查表查不到），而两边看起来都对。
  for (const k of Object.keys(SESSION_STATE_TEXT)) {
    assert.match(k, /^[a-z_]+$/, `${k} 不像一个会话状态`);
  }
  for (const s of ['RUNNING', 'PENDING', 'OUT_OF_MEMORY']) {
    assert.equal(sessionStateText(s), s, '作业状态不该在这张表里被译');
  }
});

// ── ★★ 跨文件：三处必须说同一件事 ───────────────────────────────────────────

/** 从 `cluster/slurmate-sessiond` 抠出 `ST_XXX = "..."` 那一组常量。 */
function daemonStates() {
  const src = fs.readFileSync(path.join(REPO, 'cluster', 'slurmate-sessiond'), 'utf8');
  const out = {};
  for (const m of src.matchAll(/^ST_[A-Z_]+ = "([a-z_]+)"/gm)) out[m[1]] = true;
  return out;
}

/** 从 `cluster/slurmate` 抠出 `human_state()` 里那张 `{...}.get(...)` 字面量。 */
function cliStates() {
  const src = fs.readFileSync(path.join(REPO, 'cluster', 'slurmate'), 'utf8');
  const fn = /def human_state\(state\):[\s\S]*?\.get\(state, state\)/.exec(src);
  assert.ok(fn, 'cluster/slurmate 里找不到 human_state() —— 结构变了就更新这条检查');
  const body = /\{([\s\S]*?)\}/.exec(fn[0]);
  const dict = body[1];
  const out = {};
  for (const m of dict.matchAll(/"([a-z_]+)":\s*"([^"]*)"/g)) out[m[1]] = m[2];
  assert.ok(Object.keys(out).length >= 5,
    `从 human_state() 里只抠出 ${Object.keys(out).length} 条 —— 正则多半没匹配上`);
  return out;
}

test('★★ 同一张会话状态表：守护进程、命令行、客户端三处逐字相同', () => {
  const daemon = daemonStates();
  const cli = cliStates();
  const client = SESSION_STATE_TEXT;

  assert.ok(Object.keys(daemon).length >= 5,
    `从守护进程里只抠出 ${Object.keys(daemon).length} 个会话状态 —— 正则多半没匹配上`);

  // ① 守护进程定义了哪些状态 ⇒ 另外两处一个都不能漏。
  const missCli = Object.keys(daemon).filter((s) => !(s in cli));
  const missClient = Object.keys(daemon).filter((s) => !(s in client));
  assert.deepEqual(missCli, [],
    `守护进程定义了而命令行没译的状态：${missCli.join('、')}（会原样印出去）`);
  assert.deepEqual(missClient, [],
    `守护进程定义了而客户端没译的状态：${missClient.join('、')}（会原样印出去）`);

  // ② 反过来：多译了一个守护进程根本没有的状态 —— 那多半是打字打错了一个字母，
  //    而它的表现是"某个状态永远查不到"（静默）。
  const extraCli = Object.keys(cli).filter((s) => !(s in daemon));
  const extraClient = Object.keys(client).filter((s) => !(s in daemon));
  assert.deepEqual(extraCli, [], `命令行译了一个守护进程没有的状态：${extraCli.join('、')}`);
  assert.deepEqual(extraClient, [], `客户端译了一个守护进程没有的状态：${extraClient.join('、')}`);

  // ③ 逐字相同 —— 这一条才是要害：同一台集群上，同一个状态在命令行和界面上
  //    不能有两个名字。
  assert.deepEqual(client, cli,
    '客户端与命令行的会话状态表必须逐字相同（同一条会话不能有两个名字）');
});
