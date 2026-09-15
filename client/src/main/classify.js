'use strict';
/**
 * classify.js —— 把一次 RPC 的结果分类成【客户端可行动作】。
 *
 * 为什么这个文件必须单独存在、必须是纯函数：
 *
 * 「守护进程没回话」和「守护进程说了不行」在整个客户端里是最容易写错、又最难通过
 * 点界面发现的地方。前者要重试且【绝不能】因此判定会话结束；后者要停止重试并原样
 * 把中文 detail 展示给用户。八种情况混在一起，写错了的表现是「界面一切正常，只是
 * 会话在某处悄悄死了」—— 正是这个项目一路在清的那类失败。
 *
 * 所以它不碰网络、不碰界面、不碰时间，只做一次映射。test/classify.test.mjs 穷举它。
 *
 * 契约来源：cluster/slurmate:35-41（退出码）、cluster/slurmate:137-151（_code_to_exit）、
 *           cluster/slurmate-sessiond:1599-1627（dispatch 的 _err 构造）。
 */

/** 客户端可能采取的动作。名字即语义，不要加别的。 */
const Action = {
  OK: 'ok',                             // 成功
  TRANSPORT: 'transport',               // 传输层坏了：ssh 断、stdout 空、非 JSON
  DAEMON_DOWN: 'daemon_down',           // 守护进程不可达 —— 【不是】会话没了
  RATE_LIMITED: 'rate_limited',         // 限流，退避重试，不要弹错给用户
  RETRY_SOON: 'retry_soon',             // 暂时性：端口池空、Slurm 忙
  RETRY_BACKOFF: 'retry_backoff',       // 退避重试：内部错误
  SESSION_GONE: 'session_gone',         // 会话不存在了（not_found）—— 终局
  QUOTA_OR_PERMISSION: 'quota_or_permission', // 配额/账户/分区：要用户去解决
  FATAL: 'fatal',                       // 客户端 bug 或不可重试的失败
};

/** 默认退避时长（毫秒）。调用方可以按需覆盖。 */
const BACKOFF_MS = {
  [Action.RATE_LIMITED]: 5000,
  [Action.RETRY_SOON]: 5000,
  [Action.RETRY_BACKOFF]: 3000,
};

/**
 * @param {object|null} resp   守护进程返回的 JSON（{ok,code,data,error}）；传输失败时传 null
 * @param {object}      ctx    { op: 'submit'|'status'|'heartbeat'|'goodbye'|'purposes'|'whoami'|'doctor',
 *                               transportError: Error|null }
 * @returns {{action:string, code:number|null, kind:string|null, message:string,
 *            retryAfterMs:number|null, idempotent:boolean}}
 */
function classify(resp, ctx) {
  const op = (ctx && ctx.op) || '';
  const transportError = (ctx && ctx.transportError) || null;

  // ── 1. 传输层 ────────────────────────────────────────────────────────────
  // 注意：这里【不】区分「ssh 断了」和「守护进程没回话」—— 两者在客户端看来是同
  // 一种东西（请求没得到应答），处理方式也一样（重试，且不动心跳）。真正要区分的是
  // 下面第 2 条：守护进程【明确地】通过 JSON 告诉我们它不可达。
  if (transportError) {
    return mk(Action.TRANSPORT, null, 'transport_error',
      '与登录节点通信失败：' + transportError.message, ctx);
  }
  if (!resp || typeof resp !== 'object') {
    return mk(Action.TRANSPORT, null, 'empty_response',
      '登录节点没有返回任何应答（连接可能已断开）', ctx);
  }
  // 后端已经判定为传输层失败时，它可以合成一个 kind='transport' 的信封返回
  // （而不是抛异常 —— 后端的契约是「rpc 不抛异常」）。这里认这个标记，
  // 好让「命令没跑起来」「stdout 不是 JSON」这类失败带上**具体原因**，
  // 而不是退化成上面那句笼统的「没有返回任何应答」。
  if (resp.ok === false && resp.error && resp.error.kind === 'transport') {
    return mk(Action.TRANSPORT, null, 'transport',
      resp.error.detail || '与登录节点通信失败', ctx);
  }

  // ── 2. 成功 ──────────────────────────────────────────────────────────────
  if (resp.ok === true) {
    return mk(Action.OK, 0, null, '', ctx);
  }

  const code = typeof resp.code === 'number' ? resp.code : null;
  const err = resp.error || {};
  const kind = typeof err.kind === 'string' ? err.kind : null;
  // detail 是守护进程写的中文，可直接展示给用户（见 cluster/slurmate-sessiond 的 _err 调用点）
  const detail = typeof err.detail === 'string' && err.detail ? err.detail : null;
  const message = detail || kind || '未知错误';

  // ── 3. 守护进程不可达（code 5 的两种含义必须分开）──────────────────────
  // 这是本文件存在的首要理由：code 5 同时被用于「连不上守护进程」和「端口池耗尽」，
  // 而处理方式完全相反 —— 前者要退避重试并【保持心跳】；后者只是等一下。
  // 靠 kind 区分，绝不靠 code。
  if (code === 5) {
    if (kind === 'daemon_unreachable') {
      return mk(Action.DAEMON_DOWN, code, kind,
        '控制节点上的 Slurmate 守护进程没有响应。你的作业仍在运行。', ctx);
    }
    if (kind === 'no_port') {
      return mk(Action.RETRY_SOON, code, kind, message, ctx);
    }
    return mk(Action.RETRY_BACKOFF, code, kind, message, ctx);
  }

  // ── 4. 会话不存在 ────────────────────────────────────────────────────────
  if (code === 3) {
    return mk(Action.SESSION_GONE, code, kind, message, ctx);
  }

  // ── 5. 客户端 bug ────────────────────────────────────────────────────────
  // 重试只会重复同一个错误，白白消耗 RPC 配额（max_rpc_per_second = 10）。
  if (code === 2) {
    return mk(Action.FATAL, code, kind, message, ctx);
  }

  // ── 6. 配额 / 账户 / 分区 ────────────────────────────────────────────────
  if (code === 4) {
    if (kind === 'throttled') {
      // 被熔断了，等一会儿会自动恢复，不是用户能解决的问题
      return mk(Action.RETRY_BACKOFF, code, kind, message, ctx, 60000);
    }
    return mk(Action.QUOTA_OR_PERMISSION, code, kind, message, ctx);
  }

  // ── 7. Slurm 侧失败 ──────────────────────────────────────────────────────
  // submit 在这里【必须】不可重试：op_submit 每次调用都生成新 sid、插新行、提交新
  // 作业（cluster/slurmate-sessiond 的 op_submit），而 count_active 只数 ACL_STATES，
  // 拦不住并发的第二个（见 docs/KNOWN-ISSUES.md 的 F14）。一次超时重试就是两个作业。
  if (code === 6) {
    if (op === 'submit') {
      return mk(Action.FATAL, code, kind, message, ctx);
    }
    return mk(Action.RETRY_BACKOFF, code, kind, message, ctx);
  }

  // ── 8. 限流 ──────────────────────────────────────────────────────────────
  if (code === 7) {
    return mk(Action.RATE_LIMITED, code, kind, message, ctx);
  }

  // ── 9. 守护进程内部异常 ──────────────────────────────────────────────────
  if (code === 9) {
    return mk(Action.RETRY_BACKOFF, code, kind, message, ctx);
  }

  // 未知 code：当作不可重试。宁可停下来让人看见，也不要盲目重试掩盖问题。
  return mk(Action.FATAL, code, kind, message, ctx);
}

function mk(action, code, kind, message, ctx, retryOverride) {
  const op = (ctx && ctx.op) || '';
  return {
    action,
    code,
    kind,
    message,
    retryAfterMs: retryOverride !== undefined ? retryOverride : (BACKOFF_MS[action] || null),
    // 供调用方断言：只有幂等的 op 才允许自动重试。
    idempotent: op !== 'submit',
  };
}

/** 该动作是否应当自动重试（且允许重试）。 */
function shouldRetry(result) {
  if (!result || !result.idempotent) return false;
  return result.action === Action.TRANSPORT
      || result.action === Action.DAEMON_DOWN
      || result.action === Action.RATE_LIMITED
      || result.action === Action.RETRY_SOON
      || result.action === Action.RETRY_BACKOFF;
}

module.exports = { Action, classify, shouldRetry, BACKOFF_MS };
