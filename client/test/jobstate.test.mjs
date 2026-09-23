/**
 * jobstate.test.mjs —— 作业状态那一行说的话。
 *
 * ★ 这个模块存在的理由是界面从前印的是 Slurm 的原文大写枚举
 *   （`OUT_OF_MEMORY` / `REQUEUE_HOLD`）。那是说给管理员听的话。
 *
 * ★★ 而它**不做任何生命周期判定** —— "算不算结束"由守护进程判，它把结论放在
 *    `job_terminal` 里发过来。所以这一组用例有一半在验**它照着念**：
 *    同一个状态名，`job_terminal: true` 与 `false` 必须说出两件完全不同的事。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { jobText, WAITING, RUNNING, PAUSED, ENDED, REASON } =
  require('../src/main/jobstate.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(here, '..', '..', 'cluster', 'slurmate-sessiond');

/** 造一个会话快照。字段名与 session.js 的 snapshot() 一致。 */
function snap(o) {
  return {
    jobState: null, jobTerminal: undefined, jobReason: null,
    jobExitCode: null, jobRestarts: null, ...o,
  };
}

test('没有作业状态时给 null —— 界面照旧显示「—」', () => {
  for (const bad of [null, undefined, {}, snap({}), snap({ jobState: '' }),
                     snap({ jobState: '   ' })]) {
    assert.equal(jobText(bad), null, JSON.stringify(bad));
  }
});

test('★ 每个非终态都给一句中文，而不是原文枚举', () => {
  for (const [st, want] of Object.entries({ ...WAITING, ...RUNNING, ...PAUSED })) {
    const got = jobText(snap({ jobState: st, jobTerminal: false }));
    assert.equal(got, want, st);
    assert.notEqual(got, st, `${st} 被原样印出去了 —— 那就是这一版要修的东西`);
    assert.match(got, /[一-鿿]/, `${st} 要给人看的中文`);
  }
});

test('★ 每个终态都给一句中文，且说得出**为什么结束**', () => {
  for (const [st, want] of Object.entries(ENDED)) {
    const got = jobText(snap({ jobState: st, jobTerminal: true }));
    assert.equal(got, want, st);
    assert.match(got, /[一-鿿]/, st);
    assert.notEqual(got, st, `${st} 被原样印出去了 —— 那就是这一版要修的东西`);
  }
  // 具体原因要说出来：`已结束` 三个字对一个失败的人来说什么也没说。
  for (const st of ['TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL', 'FAILED', 'PREEMPTED']) {
    assert.notEqual(jobText(snap({ jobState: st, jobTerminal: true })), '已结束',
      `${st} 要说出具体原因`);
  }
});

test('★★ 同一个状态名，job_terminal 不同就说两件完全不同的事', () => {
  // ★ 这条钉的正是"客户端不做判定"这件事：PREEMPTED 与 TIMEOUT 到底算不算结束
  //   取决于 `Requeue`，而客户端手上没有那个字段 —— 所以它只能照着念。
  //   两条都印"已结束（被抢占）"的话，作业几分钟后回来了（正是这一版要修的
  //   那个缺陷的另一半），用户已经被告知结束了。
  for (const st of ['PREEMPTED', 'TIMEOUT']) {
    const gone = jobText(snap({ jobState: st, jobTerminal: true }));
    const back = jobText(snap({ jobState: st, jobTerminal: false }));
    assert.notEqual(gone, back, `${st}: 两种判定必须说两件事`);
    assert.match(gone, /已结束/, st);
    assert.equal(/已结束/.test(back), false,
      `${st}: 判定为"没结束"时不许说出「已结束」：${back}`);
  }
  // ★ 反过来也要成立：一个**非终态**的状态名不许被印成结束。
  for (const st of Object.keys(WAITING)) {
    assert.equal(/已结束/.test(jobText(snap({ jobState: st, jobTerminal: false }))), false, st);
  }
});

test('★ 老守护进程不发 job_terminal 时印原文 —— 不猜', () => {
  // 客户端与守护进程总是一起升的，这条退路只在"新客户端对着没升的站点"时走到。
  // 那时我们手上只有一个状态名，而判据不在客户端 —— 猜一个的代价是说错话。
  assert.equal(jobText(snap({ jobState: 'PENDING' })), 'PENDING');
  assert.equal(jobText(snap({ jobState: 'OUT_OF_MEMORY' })), 'OUT_OF_MEMORY');
});

test('不认识的 Slurm 状态：原样印出去，不猜', () => {
  // 这张表会随着 Slurm 的版本落后。"印一个我不认识的状态名"是诚实的。
  assert.equal(jobText(snap({ jobState: 'SOME_FUTURE_STATE', jobTerminal: false })),
    'SOME_FUTURE_STATE');
  assert.equal(jobText(snap({ jobState: 'SOME_FUTURE_STATE', jobTerminal: true })),
    '已结束');
  // 大小写不敏感（真集群给的是大写，但这一条不该靠它）。
  assert.equal(jobText(snap({ jobState: 'pending', jobTerminal: false })), WAITING.PENDING);
});

test('★ 排队原因要说出来，尤其是「等下去没有用」的那些', () => {
  const got = jobText(snap({ jobState: 'PENDING', jobTerminal: false,
    jobReason: 'Resources' }));
  assert.equal(got, `${WAITING.PENDING} · ${REASON.Resources}`);
  // ★ 这是整张表最要紧的一类：用户看到"排队中"会一直等，而被 hold 住、
  //   或者账户到了限额时，等多久都不会开始。
  for (const r of ['JobHeldUser', 'JobHeldAdmin', 'AssocGrpCPUMinutesLimit',
                   'QOSMaxJobsPerUserLimit', 'AssocMaxSubmitJobLimit']) {
    const s = jobText(snap({ jobState: 'PENDING', jobTerminal: false, jobReason: r }));
    assert.match(s, /没有用|不会开始/, `${r} 必须说清「等下去没用」：${s}`);
  }
});

test('★ 认不出来的 Reason 原样带上 —— 宁可给原文也别什么都不说', () => {
  // Slurm 的原因有好几十种，各站点版本不同。不带它的话，用户面对的就只剩
  // "排队中"三个字，而那正是最让人无从下手的地方。
  const s = jobText(snap({ jobState: 'PENDING', jobTerminal: false,
    jobReason: 'SomeNewSlurmReason' }));
  assert.match(s, /SomeNewSlurmReason/, s);
});

test('★ 结束时才说退出码，且 0:0 不说（那是正常退出）', () => {
  assert.equal(jobText(snap({ jobState: 'FAILED', jobTerminal: true,
    jobExitCode: '1:0' })), '已结束（失败）（退出码 1:0）');
  assert.equal(jobText(snap({ jobState: 'COMPLETED', jobTerminal: true,
    jobExitCode: '0:0' })), '已结束');
  // ★ 还没结束时退出码恒为 `0:0`，说出来只会让人以为"它正常退出了"。
  assert.equal(jobText(snap({ jobState: 'RUNNING', jobTerminal: false,
    jobExitCode: '0:0' })), RUNNING.RUNNING);
});

test('★ 重启过就要说 —— 跑着的东西已经不是原来那个了', () => {
  const s = jobText(snap({ jobState: 'RUNNING', jobTerminal: false, jobRestarts: '2' }));
  assert.match(s, /已重启 2 次/, s);
  // 0 次不说（那是常态，说了只是噪音）。
  assert.equal(jobText(snap({ jobState: 'RUNNING', jobTerminal: false,
    jobRestarts: '0' })), RUNNING.RUNNING);
  // 字段缺失 / 不是数字都不许印出 "NaN"。
  for (const bad of [null, undefined, '', 'x', {}]) {
    const t = jobText(snap({ jobState: 'RUNNING', jobTerminal: false,
      jobRestarts: bad }));
    assert.equal(t, RUNNING.RUNNING, String(bad));
  }
});

test('★★ 客户端那张措辞表与守护进程的状态表对得上', () => {
  // ★ 跨文件不变量（与「跳过表两边必须逐字一致」同一个做法）。三件事：
  //
  //   ① 守护进程会**释放**的每一个状态，客户端都得说得出话（不然用户在
  //      "作业没了"之后看到的是一个英文枚举）；
  //   ② 客户端 ENDED 里多出来的状态必须是真的终态 —— 多印一句"已结束"不算错，
  //      但那张表会被人当成判据读，所以它必须与守护进程的表一致；
  //   ③ 非终态的措辞表里也不许混进终态（那会让"没结束"印成"已结束"）。
  //
  // ★ 解析的是守护进程源码里的**常量定义**，不是"文件里出现过这个字符串"。
  const src = fs.readFileSync(DAEMON, 'utf8');
  const grab = (name) => {
    const m = new RegExp(`^${name} = frozenset\\(\\(([^)]*)\\)\\)`, 'm').exec(src);
    assert.ok(m, `守护进程里找不到 ${name} —— 名字变了就更新这条检查`);
    return [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
  };
  const term = grab('TERMINAL_JOB_STATES');
  const cond = grab('CONDITIONAL_TERMINAL_JOB_STATES');
  assert.ok(term.length >= 9, `解析到的终态太少（${term.length}），正则多半没匹配上`);
  assert.ok(cond.length >= 2, `解析到的条件终态太少（${cond.length}）`);

  for (const st of [...term, ...cond]) {
    assert.ok(ENDED[st], `守护进程会为 ${st} 释放会话，而客户端说不出这句话`);
  }
  for (const st of Object.keys(ENDED)) {
    assert.ok(term.includes(st) || cond.includes(st),
      `客户端把 ${st} 说成"已结束"，而守护进程不认为它是终态 —— `
      + '一方说结束、另一方保留着会话，用户会以为出了鬼');
  }
  for (const table of [WAITING, RUNNING, PAUSED]) {
    for (const st of Object.keys(table)) {
      assert.equal(term.includes(st) || cond.includes(st), false,
        `${st} 是终态，却被放进了"还没结束"的措辞表里`);
    }
  }
});

test('★ 界面印的是 jobText，不是 jobState 原文', async () => {
  // 本机起不了 Electron（panel.js 跑不起来），所以这一条只能做文本检查。
  // 它拦的是**退回去印原文**这个退化 —— 那正是这一版要修的东西。
  const js = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'panel.js'),
    'utf8');
  assert.match(js, /\['作业状态',\s*s\.jobText\s*\|\|\s*'—'\]/,
    '作业状态那一行要印 jobText');
  assert.equal(/\['作业状态',\s*s\.jobState/.test(js), false,
    'panel.js 又在印 jobState 原文了 —— 那是 Slurm 说给管理员听的话');
});
