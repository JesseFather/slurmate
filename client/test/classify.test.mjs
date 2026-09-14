import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Action, classify, shouldRetry } = require('../src/main/classify.js');

/** 构造一个守护进程风格的错误响应。字段与 cluster/slurmate-sessiond 的 _err 一致。 */
function err(code, kind, detail) {
  return { ok: false, code, data: null, error: { kind, detail: detail ?? null } };
}
/** 构造成功响应。 */
function ok(data) {
  return { ok: true, code: 0, data: data ?? {}, error: null };
}

test('成功响应', () => {
  const r = classify(ok({ session: null }), { op: 'status' });
  assert.equal(r.action, Action.OK);
  assert.equal(r.code, 0);
});

test('传输层：ssh 报错', () => {
  const r = classify(null, { op: 'status', transportError: new Error('ECONNRESET') });
  assert.equal(r.action, Action.TRANSPORT);
  assert.equal(r.code, null);
  assert.match(r.message, /ECONNRESET/);
  assert.ok(shouldRetry(r), '传输层失败必须可重试');
});

test('传输层：stdout 为空（没有应答，但不是守护进程说的）', () => {
  for (const bad of [null, undefined, '', 42]) {
    const r = classify(bad, { op: 'heartbeat' });
    assert.equal(r.action, Action.TRANSPORT, `输入 ${JSON.stringify(bad)}`);
    assert.ok(shouldRetry(r));
  }
});

test('code 5 的两种含义必须分开 —— 这是本模块存在的首要理由', () => {
  // (a) 守护进程不可达：要退避重试，且【绝不能】被当成会话结束
  const down = classify(
    err(5, 'daemon_unreachable', '无法连接 Slurmate 守护进程（/run/slurmate-session/ctl.sock）'),
    { op: 'heartbeat' });
  assert.equal(down.action, Action.DAEMON_DOWN);
  assert.notEqual(down.action, Action.SESSION_GONE);
  assert.ok(shouldRetry(down));
  assert.match(down.message, /作业仍在运行/, '文案必须安抚用户：作业没受影响');

  // (b) 端口池耗尽：只是等一下
  const noport = classify(err(5, 'no_port', '端口池暂时没有可用端口'), { op: 'submit' });
  assert.equal(noport.action, Action.RETRY_SOON);

  // 两者 code 相同、kind 不同 —— 断言它们确实走了不同分支
  assert.notEqual(down.action, noport.action);
});

test('code 3：会话不存在是终局', () => {
  const r = classify(err(3, 'not_found'), { op: 'goodbye' });
  assert.equal(r.action, Action.SESSION_GONE);
  assert.equal(shouldRetry(r), false, '会话没了就不该重试');
});

test('code 2：客户端 bug，不重试', () => {
  for (const kind of ['bad_request', 'unknown_op', 'bad_purpose', 'bad_time']) {
    const r = classify(err(2, kind, '参数不合法'), { op: 'submit' });
    assert.equal(r.action, Action.FATAL, kind);
    assert.equal(shouldRetry(r), false);
  }
});

test('code 4：配额/权限原样展示中文 detail；throttled 例外', () => {
  const quota = classify(err(4, 'quota_active', '已有 1 个活跃会话（上限 1）'), { op: 'submit' });
  assert.equal(quota.action, Action.QUOTA_OR_PERMISSION);
  assert.equal(quota.message, '已有 1 个活跃会话（上限 1）');
  assert.equal(shouldRetry(quota), false, '配额问题重试没有意义');

  const nopart = classify(err(4, 'no_partition', '你的账号没有 A6000 分区的权限'), { op: 'submit' });
  assert.equal(nopart.action, Action.QUOTA_OR_PERMISSION);

  assert.equal(classify(err(4, 'no_account', '未分配账户'), { op: 'submit' }).action,
    Action.QUOTA_OR_PERMISSION);

  // throttled 是熔断，会自动恢复，不该惊动用户
  const thr = classify(err(4, 'throttled', '请求被拒绝次数过多'), { op: 'status' });
  assert.equal(thr.action, Action.RETRY_BACKOFF);
  assert.ok(thr.retryAfterMs >= 60000);
});

test('code 6 在 submit 上必须不可重试 —— 这是最危险的一条', () => {
  // op_submit 非幂等：每次调用都新生成 sid、插新行、提交新作业。而 count_active 只数
  // ACL_STATES，(见记忆 cluster-side-defects F14) 拦不住并发的第二个。
  // 一次超时重试 = 两个作业。
  const onSubmit = classify(err(6, 'submit_failed', 'sbatch 失败'), { op: 'submit' });
  assert.equal(onSubmit.action, Action.FATAL);
  assert.equal(onSubmit.idempotent, false);
  assert.equal(shouldRetry(onSubmit), false, 'submit 绝不能自动重试');

  // 同一个 code 在幂等 op 上就可以重试
  const onStatus = classify(err(6, 'partitions_unknown', '账户服务未响应'), { op: 'status' });
  assert.equal(onStatus.action, Action.RETRY_BACKOFF);
  assert.ok(shouldRetry(onStatus));
});

test('code 7：限流要退避，且不该弹错', () => {
  const r = classify(err(7, 'rate_limited'), { op: 'heartbeat' });
  assert.equal(r.action, Action.RATE_LIMITED);
  assert.ok(shouldRetry(r));
  assert.ok(r.retryAfterMs >= 1000);
});

test('code 9：内部异常，退避重试', () => {
  const r = classify(err(9, 'internal', 'KeyError'), { op: 'status' });
  assert.equal(r.action, Action.RETRY_BACKOFF);
  assert.ok(shouldRetry(r));
});

test('未知 code 一律不可重试 —— 宁可停下来让人看见', () => {
  const r = classify(err(99, 'who_knows', '未来新增的错误码'), { op: 'status' });
  assert.equal(r.action, Action.FATAL);
  assert.equal(shouldRetry(r), false);
});

test('code 缺失时不崩，按不可重试处理', () => {
  const r = classify({ ok: false, error: { kind: 'x' } }, { op: 'status' });
  assert.equal(r.action, Action.FATAL);
  assert.equal(r.code, null);
});

test('error.detail 缺失时回落到 kind，再回落到占位文案', () => {
  assert.equal(classify(err(4, 'quota_active'), { op: 'submit' }).message, 'quota_active');
  assert.equal(classify({ ok: false, code: 4, error: {} }, { op: 'submit' }).message, '未知错误');
});

test('ctx 缺失不崩', () => {
  const r = classify(err(3, 'not_found'));
  assert.equal(r.action, Action.SESSION_GONE);
  assert.equal(r.idempotent, true, '无 op 信息时保守假设幂等（不涉及 submit）');
});

test('穷举：每个 Action 都有明确的 shouldRetry 期望', () => {
  const expected = {
    [Action.OK]: false,
    [Action.TRANSPORT]: true,
    [Action.DAEMON_DOWN]: true,
    [Action.RATE_LIMITED]: true,
    [Action.RETRY_SOON]: true,
    [Action.RETRY_BACKOFF]: true,
    [Action.SESSION_GONE]: false,
    [Action.QUOTA_OR_PERMISSION]: false,
    [Action.FATAL]: false,
  };
  for (const [action, want] of Object.entries(expected)) {
    const got = shouldRetry({ action, idempotent: true, retryAfterMs: 1000 });
    assert.equal(got, want, `${action} 的 shouldRetry 期望 ${want}，实际 ${got}`);
  }
});
