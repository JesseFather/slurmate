/**
 * backend-fake.test.mjs —— 假后端**不许比真守护进程多知道任何东西**。
 *
 * 假后端（`client/src/main/backend-fake.js`）的存在理由是：**开发模式要在没有集群的
 * 机器上跑出真的状态机**。它的会话视图一直声称"逐字段对齐守护进程的 `session_view`"
 * —— 而那句声称在此之前**没有任何东西守着**。
 *
 * ★★ 这个方向才是危险的那一个：**假后端凭空多出一个字段** ⇒ 客户端读了它 ⇒
 *    真集群上那个字段不存在 ⇒ 只在开发模式里跑得通。而"开发模式能跑、真集群跑不了"
 *    是最难查的一类，因为它看起来完全正常。
 *    （反过来，真守护进程多一个字段是无害的：客户端对它一无所知。）
 *
 * ★ 这条不是假想的：就在写下这个文件的前一刻，给假后端手抄四个新字段时**抄错了一个**
 *   —— 作业跑起来之后 `job_reason` 没清掉，于是开发模式里会显示
 *   「运行中 · 在等空闲资源」，一句自相矛盾的话，而真集群上它不出现。
 *
 * ★ 这里只做**文本比对**（本机起不了 Electron）。它验不了字段的**值**对不对，
 *   只验"这个名字守护进程是不是真的会说"。够用 —— 名字错了才是上面那条路。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');
const FAKE = fs.readFileSync(
  path.join(ROOT, 'client', 'src', 'main', 'backend-fake.js'), 'utf8');
const DAEMON = fs.readFileSync(
  path.join(ROOT, 'cluster', 'slurmate-sessiond'), 'utf8');

/** 守护进程 `session_view()` 的**函数体**。判据只在那个函数里，别处不算。 */
function daemonViewBody() {
  // ★ 锚点是**完整签名**，这是有意的：签名变了就说明"这一份视图由谁渲染、
  //   渲染时要不要现查 Slurm"变了，而假后端演的是同一件事 —— 那正是这一条要
  //   盯住的东西。v0.8 阶段 3 加了 `job_live`（推送那条路只读本 tick 已经取过的
  //   作业信息，绝不在这里 fork），锚点跟着改；**默认值不变**，所以假后端
  //   （它演的是 `list` / `status` 那一侧）一个字都不用动。
  const at = DAEMON.indexOf(
    '    def session_view(self, s, with_secret=True, job_live=True):');
  assert.notEqual(at, -1, '守护进程里找不到 session_view() —— 改名了就更新这条检查');
  const end = DAEMON.indexOf('\n    def op_status', at);
  assert.notEqual(end, -1, '找不到 session_view() 的结尾');
  return DAEMON.slice(at, end);
}

/** 假后端 `_view()` 会写进响应里的**全部**字段名。 */
function fakeViewKeys() {
  const at = FAKE.indexOf('  _view(s) {');
  assert.notEqual(at, -1, '假后端里找不到 _view() —— 改名了就更新这条检查');
  const end = FAKE.indexOf('\n  _clearTimers', at);
  assert.notEqual(end, -1, '找不到 _view() 的结尾');
  const body = FAKE.slice(at, end);

  const keys = new Set();
  // 1. `const d = { … }` 那一段里的键。
  //    ★ 不能按行首缩进匹配：那里一行上有**两个**键
  //      （`session_id: …, job_id: …, state: …`），按行首匹配会漏掉第二个。
  //    ★ 前缀要求 `{` 或 `,`（而不是裸的 `\w+:`）—— 不然三元表达式里的
  //      `? null : s.service_kind` 会把 `null` 当成一个字段名。
  const litAt = body.indexOf('const d = {');
  assert.notEqual(litAt, -1, '_view() 里找不到 `const d = {`');
  const litEnd = body.indexOf('\n    };', litAt);
  assert.notEqual(litEnd, -1, '找不到那个对象字面量的结尾');
  for (const m of body.slice(litAt, litEnd).matchAll(/(?:[{,]|^)\s*([a-z_][a-z0-9_]*)\s*:/gm)) {
    keys.add(m[1]);
  }
  // 2. 后面那几处 `d.xxx = …`（含单行 if 后面的那种）。
  for (const m of body.matchAll(/\bd\.([a-z_][a-z0-9_]*)\s*=/g)) keys.add(m[1]);
  return keys;
}

test('假后端 _view() 抽得出的字段足够多（正则没匹配上就等于什么都没验）', () => {
  const keys = fakeViewKeys();
  assert.ok(keys.size >= 18, `只抽到 ${keys.size} 个字段：${[...keys].join('、')}`);
  // 抽几个一定有的当锚点 —— 名字被改掉时这条会红，而不是让下面那条静默变绿。
  for (const k of ['session_id', 'job_id', 'state', 'tunnel_target',
                   'auth_password', 'service_kind']) {
    assert.ok(keys.has(k), `抽不到 ${k} —— 抽取规则失效了`);
  }
});

test('★★ 假后端会发出去的每一个字段，守护进程的 session_view 都说得出', () => {
  const body = daemonViewBody();
  const missing = [...fakeViewKeys()]
    .filter((k) => !new RegExp(`\\b${k}\\b`).test(body))
    .sort();
  assert.deepEqual(missing, [],
    `假后端会发这些字段，而守护进程的 session_view() 里根本没有它们：`
    + `${missing.join('、')} —— 客户端读了它们就只在开发模式里跑得通`);
});

test('★ 作业状态那四个新字段，假后端一个都不许少', () => {
  // ★ 少一个的后果不是报错，是**开发模式里看不到那条路**：客户端会走
  //   「老守护进程」的退路（印状态原文），而真集群上看到的是译文。
  //   "开发模式验不了的那条路"正是这一版反复在清的东西。
  const keys = fakeViewKeys();
  for (const k of ['job_terminal', 'job_reason', 'job_exit_code', 'job_restarts']) {
    assert.ok(keys.has(k), `假后端的 _view() 没有给出 ${k}`);
  }
});

test('★ 假站点里的作业也带判定与原因（不然那条路一次都走不到）', () => {
  // `_view()` 会给出来不够 —— 会话对象上得有值，否则 `if (s.job_xxx)` 全不成立，
  // 开发模式里那一格永远是空的。
  assert.match(FAKE, /job_terminal:\s*false/, '假会话上要有 job_terminal');
  assert.match(FAKE, /job_reason:\s*'Resources'/, '假会话上要有一个排队原因');
  // ★ 而它**必须**在作业跑起来的时候被清掉：真集群上跑起来的作业报
  //   `Reason=None`（守护进程把它滤掉），不清的话界面会显示
  //   「运行中 · 在等空闲资源」—— 一句自相矛盾、且在真集群上不出现的话。
  assert.match(FAKE, /sess\.job_state = 'RUNNING';[\s\S]{0,400}?sess\.job_reason = null;/,
    '作业转成 RUNNING 时要把排队原因一起清掉');
});
