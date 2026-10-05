/**
 * sessionstate.js —— 把**会话**的状态（守护进程那一侧的状态机）译成给人看的一句话。
 *
 * ★ 与 `jobstate.js` 是**两张不同的表**，别合并：那边译的是 **Slurm 作业**的状态
 *   （`PENDING` / `RUNNING` / `OUT_OF_MEMORY`…），这边译的是 **Slurmate 会话**的状态
 *   （`reserved` / `enrolled` / `suspect`…）。同一条会话在同一个时刻，两个状态可以
 *   差得很远：会话是 `suspect`（心跳丢了，我们不知道它还在不在），而作业是
 *   `RUNNING`（Slurm 知道它好好地跑着）。把它们印成一句话，就是把"我们不知道"
 *   说成"它没了"。
 *
 * ★★ 与 `cluster/slurmate` 的 `human_state()` 是**同一张表的第二份**。那一边是
 *   命令行，这一边是界面 —— 而它们是**两个独立安装的程序**，没有共享代码的路
 *   （客户端不带 CLI，见 `docs/DOC-LAYOUT.md` 那一份按分发单元分的文档）。
 *   于是这条重复是**结构性的**，只能靠一条跨文件用例钉住（`boot.test.mjs` 里
 *   「同一张会话状态表，两边逐字相同」）—— 同一条会话在命令行和界面上不能有两个
 *   名字，那不是风格问题：用户在命令行看到「连接中断（作业仍在运行）」，
 *   在界面上看到「已结束」，他会去查一个不存在的问题。
 *
 * ★ 认不出来的状态一律**原样印出去**，不猜。守护进程可以比这个客户端新，
 *   而"印一个我不认识的状态名"是诚实的。
 */

/** 会话状态 → 那句话。取值只有 9 种，见集群侧 `ST_*` 那一组常量。 */
const SESSION_STATE_TEXT = {
  reserved: '已分配端口',
  submitted: '已提交，等待调度',
  enrolled: '运行中',
  // ★ 这一句是全表里最要紧的一句：`suspect` 是"**我们**不知道它还在不在"，
  //   不是"它没了"。印成「连接中断」而不补后半句，用户会去重新提交一个作业 ——
  //   而原来那个还在烧着 GPU。
  suspect: '连接中断（作业仍在运行）',
  orphaned: '判定异常退出，正在释放',
  releasing: '正在释放',
  released: '已结束',
  rejected: '已拒绝',
  expired: '已过期',
};

/**
 * @param {string} state 守护进程给的会话状态
 * @returns {string} 给人看的一句话（认不出来就原样返回）
 */
function sessionStateText(state) {
  const s = typeof state === 'string' ? state.trim() : '';
  if (!s) return '';
  return SESSION_STATE_TEXT[s] || s;
}

module.exports = { sessionStateText, SESSION_STATE_TEXT };
