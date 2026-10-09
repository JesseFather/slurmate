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

'use strict';
/**
 * hover.js —— 浮窗那一层（两条边栏滑出来的那块）。
 *
 * 左边 = **站点状态**，右边 = **作业输出**。一次只露一块。
 *
 * ★★ **它不自己向后端问话。** 数据由主进程推 —— `op_cluster` 什么时候该问、
 *    问到了什么、有多旧，都由主进程那一处决定（`index.js` 的 `refreshSite`）。
 *    浮窗自己再拉一次的话，同一份答案就有了第二个取数点，而它与"什么时候该问"
 *    那条判据必然漂开：某一次浮窗里是新的、面板上的圆点是旧的，而两个都在说
 *    "现在"。
 *
 * ★ 开关由主进程说了算（`hover:state`）：收起判据是**鼠标几何**，那在窗口那一层
 *   （见 windows.js 的 `_startCursorWatch`）。这一页只负责画。
 *
 * ★ 三态是承重的，与服务端逐字同一条规矩：
 *     键不在 / `undefined`   = 【取不到】→ `na(...)` 那一行
 *     `null` / `[]` / `{}`    = 【确实没有】
 *   把前者画成后者，用户会去查一个不存在的问题。
 */

const $ = (id) => document.getElementById(id);

/** 最近一次推来的站点状态与链路状态。两样都在，因为浮窗里画的是它们的合影。 */
let SITE = { data: null, error: null };
let LINK = { connected: false, detail: null, hbAgeMs: null, rttMs: null, probeError: null };

// ── 开 / 关 ────────────────────────────────────────────────────────────────
window.hover.onState((m) => {
  const open = Boolean(m && m.open);
  const side = open ? m.side : null;
  $('pane-left').classList.toggle('hidden', side !== 'left');
  $('pane-right').classList.toggle('hidden', side !== 'right');
  // ★ 打开时把这一块重画一遍：收起期间推来的数据是丢掉的（没有读者），
  //   而"打开的那一瞬间是空的"看起来就像坏了。
  if (side === 'left') { renderLink(); renderCluster(); }
});

window.hover.onData((m) => {
  if (!m) return;
  if (m.cluster !== undefined) {
    SITE = { data: m.cluster, error: m.clusterError || null };
  }
  if (m.link !== undefined) LINK = Object.assign({}, LINK, m.link);
  renderLink();
  renderCluster();
});

// ── 链路 ──────────────────────────────────────────────────────────────────
/**
 * 链路那一行。
 *
 * ★ 它与下面那些格子**不是一个时间尺度**：链路状态是主进程**事件驱动**推来的
 *   （后端掉线的那一刻），而集群那一份最多可能旧 5 分钟（服务端的慢钟）。
 *   所以它单独占一行、而且排在最上面 —— 用户第一眼要回答的是"现在还通不通"。
 */
function renderLink() {
  const box = $('cl-link');
  box.textContent = '';
  const up = LINK.connected;
  box.append(cel('span', up ? 'ok' : 'bad', up ? '已连接' : '已断开'));
  const bits = [];
  if (up && typeof LINK.hbAgeMs === 'number') {
    bits.push(`心跳 ${Math.max(0, Math.round(LINK.hbAgeMs / 1000))} 秒前`);
  }
  if (typeof LINK.rttMs === 'number') bits.push(`延迟 ${LINK.rttMs}ms`);
  if (LINK.probeError) bits.push(`探测失败：${LINK.probeError}`);
  if (!up && LINK.detail) bits.push(LINK.detail);
  box.append(cel('span', null, bits.length ? `　·　${bits.join('　·　')}` : ''));
}

$('cl-probe').onclick = async () => {
  const btn = $('cl-probe');
  btn.disabled = true;
  try {
    const r = await window.hover.probe();
    LINK = Object.assign({}, LINK, r && r.ok
      ? { rttMs: r.rttMs, probeError: null }
      : { rttMs: null, probeError: (r && r.error) || '没有回应' });
  } finally {
    btn.disabled = false;
    renderLink();
  }
};

// ── 站点状态 ──────────────────────────────────────────────────────────────
//
// ★ 这一整块是从 `panel.js` **搬**过来的（从前它是盖在三屏上面的
//   `#sec-cluster`）。搬而不是抄：同一份数据只留一个渲染实现 —— 两份的漂开形态
//   是"浮窗说是这样、面板说是那样"，而两边都标着"现在"。

/**
 * 节点忙闲：`{counts: {base_state: n}, flags: {后缀: n}}` 画成一行。
 *
 * ★ 后缀**只做展示**，而且与计数分开画（`idle 1  drain 1  （后缀 *×1）`）——
 *   把它并进状态名里等于对它做了一次判定，而它跨 Slurm 版本含义不一致
 *   （见 `Slurm.node_table()`）。这里一个字都不解释它是什么意思。
 */
function nodeCountsText(n) {
  const c = Object.entries((n && n.counts) || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`);
  const f = Object.entries((n && n.flags) || {})
    .sort()
    .map(([k, v]) => `${k}×${v}`);
  if (!c.length) return null;
  return c.join('  ') + (f.length ? `  （后缀 ${f.join(' ')}）` : '');
}

/** 分区一块：名字一行、节点一行、队列一行、GRES 一行。 */
function partitionBlock(name, info, nodes, queue, gres) {
  const row = cel('div', 'crow');
  row.append(cel('span', 'nm', name));

  const bits = [];
  if (info.state) bits.push(info.state);
  if (info.is_default) bits.push('默认');
  bits.push(info.max_time ? `时限 ${info.max_time}` : '无时限');
  if (typeof info.nodes === 'number') bits.push(`${info.nodes} 节点`);
  row.append(cel('span', 'dim', '  ' + bits.join('  ·  ')));

  const nc = nodeCountsText(nodes && nodes[name]);
  row.append(cel('div', 'dim', `节点　${nc || '（这一格没有数据）'}`));

  const q = queue && queue.depth && queue.depth[name];
  const qs = q ? `排队 ${q.pending}　在跑 ${q.running}`
    + (q.other ? `　其它 ${q.other}` : '') : '（这一格没有数据）';
  row.append(cel('div', 'dim', `队列　${qs}`));

  const g = gres && gres[name];
  // ★ 三态：`gres` 整个键缺席 = 取不到；`[]` = 这个分区确实一张卡都没有。
  const gs = !gres ? '取不到'
    : (g === undefined ? '（不在 GRES 清单里）'
      : (g.length ? g.map((e) => `${e.label || e.name} ×${e.per_node_max}/节点`).join('，')
        : '确实一张都没有'));
  row.append(cel('div', 'dim', `GRES　${gs}`));
  return row;
}

/** 把整份 `op_cluster` 的答案画出来。**纯函数式地照着数据画，不做任何判定。** */
function renderCluster() {
  const box = $('cl-body');
  box.textContent = '';

  if (SITE.error) {
    $('cl-health').textContent = '取不到';
    $('cl-health').className = 'st bad';
    box.append(cel('p', 'bad', `取不到集群信息：${SITE.error}`));
    return;
  }
  const d = SITE.data;
  if (!d) {
    $('cl-health').textContent = '正在取…';
    $('cl-health').className = 'st';
    return;
  }

  const h = d.health;
  $('cl-health').textContent = h
    ? `控制器${h.up ? '在线' : '连不上'}`
    : '控制器状态取不到';
  $('cl-health').className = 'st' + (h && !h.up ? ' bad' : '');
  if (h) box.append(cel('p', 'sub', `取数于 ${agoText(h.at) || '刚刚'}`));

  // 控制器与版本：两个**互相独立**的格子，所以各说各的。
  if (!h) box.append(na('控制器状态（scontrol ping）'));
  else if (!h.up) box.append(cel('p', 'bad', '控制器连不上 —— 提交、心跳、查询都会失败。'));

  const ver = cel('div', 'ctable');
  ver.append(cel('div', 'k', 'Slurm'));
  ver.append(cel('div', null, d.version || '取不到'));
  ver.append(cel('div', 'k', '分区表'), cel('div', null,
    d.partitions ? `${Object.keys(d.partitions).length} 个` +
      (agoText(d.taken && d.taken.partitions) ? `（${agoText(d.taken.partitions)}）` : '')
      : '取不到'));
  box.append(ver);

  // ── 分区 ──
  box.append(cel('h3', null, '分区'));
  if (!d.partitions) {
    box.append(na('分区列表（scontrol show partition）'));
  } else if (!Object.keys(d.partitions).length) {
    box.append(cel('p', 'sub', '这台集群确实一个分区都没有。'));
  } else {
    const names = Object.keys(d.partitions).sort(
      (a, b) => (Number(Boolean(d.partitions[b].is_default))
        - Number(Boolean(d.partitions[a].is_default))) || a.localeCompare(b));
    for (const n of names) {
      box.append(partitionBlock(n, d.partitions[n], d.nodes, d.queue, d.gres));
    }
    if (!d.nodes) box.append(na('节点忙闲（sinfo -N）'));
    if (!d.queue) box.append(na('队列（squeue）'));
    if (!d.gres) box.append(na('GRES 清单（scontrol show node）'));
  }

  // ── 我自己 ──
  box.append(cel('h3', null, '我的'));
  const me = d.me || {};
  const mine = cel('div', 'ctable');
  mine.append(cel('div', 'k', '账户'), cel('div', null,
    me.account || (me.account_error ? '无' : '取不到')));
  if (me.account_error) mine.append(cel('div', 'k', ''), cel('div', 'bad', me.account_error));
  // ★ 三态：`null` = 不限（这是**答案**，不是没问到）。
  mine.append(cel('div', 'k', '可提交分区'), cel('div', null,
    me.allowed_partitions === undefined ? '取不到'
      : (me.allowed_partitions === null ? '不限制'
        : me.allowed_partitions.join('，') || '一个都没有')));
  mine.append(cel('div', 'k', '公平份额'), cel('div', null,
    me.fairshare ? `${me.fairshare.fair_share || '—'}`
      + `（账户 ${me.fairshare.account || '—'}，`
      + `已用 ${me.fairshare.effectv_usage || '—'}）` : '取不到'));
  if (typeof me.pending_count === 'number') {
    const fi = Object.entries(me.first_in || {})
      .map(([p, i]) => `${p} 第 ${i} 位`).join('，');
    mine.append(cel('div', 'k', '排队中'), cel('div', null,
      `${me.pending_count} 条` + (fi ? `（${fi}）` : '')));
    // ★ 一行，不是一段 —— 而这一行是**必要**的：不说的话"第 3 位"会被读成
    //   "还有 3 个就到我了"，而它们完全可能同时开跑、也可能一个都不开。
    mine.append(cel('div', 'k', ''), cel('div', 'sub', '名次，不是还要等多久。'));
  }
  box.append(mine);
  if (me.pending_count === undefined) box.append(na('排队名次（squeue）'));
}
