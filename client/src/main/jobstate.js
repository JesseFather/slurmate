/**
 * jobstate.js —— 把 Slurm 的作业状态译成**给人看的一句话**。
 *
 * 从前界面直接印 `jobState` 的原文大写枚举（`PENDING` / `RUNNING` / `OUT_OF_MEMORY`），
 * 那是 Slurm 说给管理员听的话，不是给用集群的人听的话。这一模块把它译成中文，
 * 并把「为什么还没跑」那一句（`Reason`）一并说出来 —— 那是排队的人最想知道的。
 *
 * ★★ 一条不变量：**本模块不做任何生命周期判定。**
 *    "这个作业算不算结束了"由守护进程判（`job_is_terminal()`），它把结论放在
 *    `job_terminal` 里发过来。这里只照着念。
 *    自己再实现一遍的理由曾经看起来成立（状态名都在手上），代价是**两处判据会漂**，
 *    漂的方向是界面说"已结束（被抢占）"而作业几分钟后又回来了 ——
 *    而 PREEMPTED / TIMEOUT 到底算不算结束取决于 `Requeue`，客户端手上根本没有那个字段。
 *
 * ★ 认不出来的状态一律**原样印出去**，不猜。这个模块会随着 Slurm 的版本落后，
 *   而"印一个我不认识的状态名"是诚实的，"猜一个可能是错的说法"不是。
 */

/**
 * 非终态 → 那一档的说法。分档只影响措辞，不影响任何判定。
 *
 * 分档的依据是"用户该做什么"：
 *   在等 —— 什么也做不了，等着（或者去解决 Reason 说的那件事）
 *   在跑 —— 可以连上去干活了
 *   暂停 —— 作业还在，但没在算（被抢占/被挂起）
 *   收尾 —— 快结束了，别急着判它成功还是失败
 */
const WAITING = {
  PENDING: '排队中',
  CONFIGURING: '正在准备运行环境',
  REQUEUE_HOLD: '排队中（被挂起）',
  REQUEUE_FED: '排队中（依赖已满足）',
  POWER_UP_NODE: '等待节点开机',
};

const RUNNING = {
  RUNNING: '运行中',
  RESIZING: '运行中（正在调整资源）',
  SIGNALING: '运行中（正在发送信号）',
  STAGE_OUT: '正在收尾',
  COMPLETING: '正在收尾',
};

const PAUSED = {
  SUSPENDED: '已暂停（资源被让出去了）',
  STOPPED: '已暂停（被挂起）',
  REQUEUED: '被抢占，正在重新排队',
  SPECIAL_EXIT: '已退出，等待重新排队',
};

/**
 * 真终态 → 结束的原因。说得出具体原因就说，说不出来就说"已结束"。
 *
 * ★ 这一张表是**措辞**表，不是判据表 —— 状态在不在这里只决定说哪句话，
 *   不决定它算不算结束（那由 `job_terminal` 说了算）。
 */
const ENDED = {
  COMPLETED: '已结束',
  CANCELLED: '已结束（被取消）',
  FAILED: '已结束（失败）',
  TIMEOUT: '已结束（超时）',
  NODE_FAIL: '已结束（节点故障）',
  BOOT_FAIL: '已结束（节点启动失败）',
  DEADLINE: '已结束（到截止时间）',
  OUT_OF_MEMORY: '已结束（内存不足）',
  LAUNCH_FAILED: '已结束（没能启动）',
  REVOKED: '已结束（被撤销）',
  PREEMPTED: '已结束（被抢占）',
};

/**
 * 排队原因 → 那句话。
 *
 * ★ 最要紧的是最后那一类：**等下去没有用**的原因。用户看到"排队中"会一直等，
 *   而作业被 hold 住、或者账户到了限额时，等多久都不会开始 —— 那正是他需要
 *   有人告诉他的那一句。
 */
const REASON = {
  // 等下去有用
  Resources: '在等空闲资源',
  Priority: '优先级不够，排在别人后面',
  Dependency: '在等前置作业',
  Reservation: '在等预约时段开始',
  Licenses: '在等许可证',
  ReqNodeNotAvail: '指定要求的节点当前不可用',
  NodeDown: '节点故障，正在等别的节点',
  BeginTime: '还没到它的开始时间',
  // ★ 等下去没用
  JobHeldUser: '被挂起了（hold），不 release 就不会开始',
  JobHeldAdmin: '被管理员挂起了（hold），等没有用',
  AssocGrpCPUMinutesLimit: '账户的 CPU 额度用完了，等没有用',
  AssocGrpCPURunMinutesLimit: '账户的 CPU 额度用完了，等没有用',
  AssocGrpGRESMinutesLimit: '账户的 GPU 额度用完了，等没有用',
  AssocGrpGRESRunMinutesLimit: '账户的 GPU 额度用完了，等没有用',
  AssocGrpMemLimit: '账户的内存额度用完了，等没有用',
  AssocGrpNodeLimit: '账户的节点额度用完了，等没有用',
  AssocMaxJobsLimit: '账户的作业数到上限了，等没有用',
  AssocMaxSubmitJobLimit: '你提交的作业数到上限了，等没有用',
  QOSMaxJobsPerUserLimit: '你的作业数到了 QOS 上限，等没有用',
  QOSMaxCpuPerUserLimit: '你的 CPU 用量到了 QOS 上限，等没有用',
  QOSMaxGRESPerUser: '你的 GPU 用量到了 QOS 上限，等没有用',
  PartitionDown: '整个分区当前不可用',
  PartitionInactive: '整个分区当前不可用',
};

/**
 * `jobState` + `jobTerminal` + `jobReason` + `jobExitCode` + `jobRestarts`
 * → 一句话。
 *
 * @param {object} snap 会话快照（`session.js` 的 `snapshot()`）
 * @returns {string|null} 没有作业状态时给 null（界面照旧显示「—」）
 */
function jobText(snap) {
  const s = snap || {};
  const raw = typeof s.jobState === 'string' ? s.jobState.trim().toUpperCase() : '';
  if (!raw) return null;

  // ★ 老守护进程（0.7 及更早）**不发 `job_terminal`**。那时我们手上只有一个状态名，
  //   而"算不算结束"的判据不在客户端 —— 所以这里也**不猜**：把原文印出去。
  //   客户端与守护进程总是一起升的，这条退路只在"新客户端对着没升的站点"时走到。
  if (typeof s.jobTerminal !== 'boolean') return raw;

  let text = s.jobTerminal
    ? (ENDED[raw] || '已结束')
    : (WAITING[raw] || RUNNING[raw] || PAUSED[raw] || raw);

  const why = typeof s.jobReason === 'string' ? s.jobReason.trim() : '';
  if (why && !s.jobTerminal) {
    // 认不出来的原因**原样带上**：Slurm 的原因有好几十种，而且各站点版本不同，
    // 宁可让用户看到 `AssocGrpGRESMinutesLimit` 这样的原文，也别什么都不说 ——
    // 那正是"排队中"三个字最让人无从下手的地方。
    text += ` · ${REASON[why] || why}`;
  }

  // 退出码只在**结束了**之后才有意义（没结束时它恒为 0:0）。
  const code = typeof s.jobExitCode === 'string' ? s.jobExitCode.trim() : '';
  if (s.jobTerminal && code && code !== '0:0') text += `（退出码 ${code}）`;

  // 重启过就要说 —— 作业被重新排队之后，跑着的东西是**新的**，
  // 用户在 code-server 里没保存的状态已经没了，而他不会知道。
  const n = Number.parseInt(s.jobRestarts, 10);
  if (Number.isFinite(n) && n > 0) text += ` · 已重启 ${n} 次`;

  return text;
}

module.exports = { jobText, WAITING, RUNNING, PAUSED, ENDED, REASON };
