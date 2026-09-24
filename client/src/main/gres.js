'use strict';
/**
 * gres.js —— GRES 描述符的**两句人话**。纯函数，没有生命周期判断。
 *
 * ★ 分工：守护进程说"这个会话的 GRES 是什么"（一个结构 `{name, type, count}`，
 *   或者 null = 不知道），这里只说"怎么把它写成一行字"。客户端**不判断**它合不
 *   合法、能不能要到 —— 那两件事一件在服务端（`clean_gres` / `fit_gres`），
 *   一件在集群（Slurm 自己在 sbatch 那一刻判）。
 *
 * ★ GRES 是**管理员自定义的**（`GresTypes` + `gres.conf`）：名字与型号随集群而
 *   定，可能是 `gpu`、`gpu:a100`，也可能是 `mps`、`shard`。所以这里**没有任何
 *   名字上的假设** —— 有型号就带上，没有就只有名字。从前客户端认的是
 *   `typeof r.gpus === 'number'`，那等于假定"GRES 只有 gpu 一种、而且不带型号"，
 *   于是带型号的集群上界面显示"没有 GPU"而作业正占着两张卡。
 *
 * ★ 为什么单独一个文件：面板页是**普通 `<script>`**，`require` 用不了；而
 *   "一串形状对不对"这种事必须有用例守着。与 jobstate.js 同一形状。
 */

/**
 * 名字（不含数量）：`gpu` 或 `gpu:a100`。给 GRES 选择器的选项标签用。
 *
 * @param {object|null} g 描述符 `{name, type, count}`
 * @returns {string|null} 拿不到名字时返回 null（界面显示 '—'，不编一个）
 */
function gresLabel(g) {
  if (!g || typeof g !== 'object' || typeof g.name !== 'string' || !g.name) {
    return null;
  }
  return g.type ? `${g.name}:${g.type}` : g.name;
}

/**
 * 一行字：`gpu:a100 × 2`。
 *
 * @param {object|null} g 描述符
 * @returns {string|null} null = 这一行不说 GRES。两条路都会到这里：**没要**
 *   （库里那一格是空的）与**无从得知**（从 nft 规则恢复出来的会话，我们没写过
 *   它的命令行）—— 它们与 cpus/mem 是同一情形，守护进程那边也是同样处理的
 *   （`session_view` 里那句注释）。所以这里不编一个数字出来，也不假装知道。
 */
function gresText(g) {
  const label = gresLabel(g);
  if (!label) return null;
  const n = g && Number.isInteger(g.count) ? g.count : null;
  return n === null ? label : `${label} × ${n}`;
}

module.exports = { gresLabel, gresText };
