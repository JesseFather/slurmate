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
 * 左边 = **站点状态**，右边 = **作业输出**（标准输出 / 标准错误两块）。一次只露一块。
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
/** 右栏那一份：作业日志的两块。`data` 就是 `op_job_log` 的 `{out, err}`。 */
let OUT = { data: null, error: null, unsupported: false, lines: 0, jobId: null };

// ── 开 / 关 ────────────────────────────────────────────────────────────────
window.hover.onState((m) => {
  const open = Boolean(m && m.open);
  const side = open ? m.side : null;
  $('pane-left').classList.toggle('hidden', side !== 'left');
  $('pane-right').classList.toggle('hidden', side !== 'right');
  // ★ 打开时把这一块重画一遍：收起期间推来的数据是丢掉的（没有读者），
  //   而"打开的那一瞬间是空的"看起来就像坏了。
  if (side === 'left') { renderLink(); renderCluster(); }
  // ★ 打开时把这一块重画一遍：收起期间推来的数据是丢掉的（没有读者），
  //   而"打开的那一瞬间是空的"看起来就像坏了。
  if (side === 'right') renderOut();
});

window.hover.onData((m) => {
  if (!m) return;
  if (m.cluster !== undefined) {
    SITE = { data: m.cluster, error: m.clusterError || null };
  }
  if (m.link !== undefined) LINK = Object.assign({}, LINK, m.link);
  if (m.out !== undefined || m.outError !== undefined) {
    OUT = {
      data: m.out || null,
      error: m.outError || null,
      unsupported: Boolean(m.outUnsupported),
      lines: m.outLines || 0,
      jobId: m.outJobId || null,
    };
  }
  renderLink();
  renderCluster();
  renderOut();
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

// ── 右栏：作业输出 ────────────────────────────────────────────────────────
//
// ★★ **追加式绘制**，不是每轮重画。1.5 秒重画一次会把用户正在拖的选区**当场毁掉**
//    —— 而"输出要能选中复制"正是这块浮窗存在的理由之一（另一条是能滚动）。
//    所以：把这一轮拿到的尾部和**已经画进去的**那一份比对，只把多出来的那几行接上去。
//
// ★ 比对的是**行**，而且只往回找 600 行：窗口是"最后 N 行"，两次之间它只滑了几行，
//   所以重叠一定在末尾附近。找不到重叠（文件被截断过、换过一份）就整块重画 ——
//   那一次会毁掉选区，但它罕见，而"接错了"会把两段不相干的日志粘在一起。
//
// ★ **末尾那半行不画**：文件可能正被写到一半，最后一行还没有换行符。画出去的话，
//   下一次它就会以完整的样子再出现一遍（重复），而且中间那一刻显示的是半句话。
//   与服务端那边"丢掉窗口开头那半行"是同一条规矩的两头。
const OUT_MAX_LINES = 4000;
const OUT_LOOKBACK = 600;

const lastCompleteLine = (t) => {
  if (!t) return '';
  if (t.endsWith('\n')) return t;
  const i = t.lastIndexOf('\n');
  return i < 0 ? '' : t.slice(0, i + 1);
};

const atBottomOf = (el) => (el.scrollHeight - el.scrollTop - el.clientHeight) < 4;

function paintHalf(box, text) {
  const neu = lastCompleteLine(text || '').split('\n');
  if (neu.length && neu[neu.length - 1] === '') neu.pop();
  const old = box._lines || [];
  const atBottom = atBottomOf(box);

  let k = -1;
  if (old.length && neu.length) {
    const max = Math.min(old.length, neu.length);
    const floor = Math.max(1, max - OUT_LOOKBACK);
    for (let n = max; n >= floor; n -= 1) {
      let ok = true;
      for (let i = 0; i < n; i += 1) {
        if (old[old.length - n + i] !== neu[i]) { ok = false; break; }
      }
      if (ok) { k = n; break; }
    }
  }

  if (k < 0) {
    // 接不上（第一次、或者文件被截断/换过）⇒ 整块重画。
    box.textContent = '';
    box.append(document.createTextNode(neu.join('\n')));
    box._lines = neu.slice();
  } else if (k < neu.length) {
    const add = neu.slice(k);
    box.append(document.createTextNode((old.length ? '\n' : '') + add.join('\n')));
    box._lines = old.concat(add);
  }

  // 顶上的上限：钉住很久的时候，DOM 不能无限涨。★ 只在**贴底**时砍，否则用户
  // 正在看的那一段会在他眼皮底下移位。
  if (atBottom && box._lines.length > OUT_MAX_LINES) {
    box._lines = box._lines.slice(-Math.floor(OUT_MAX_LINES / 2));
    box.textContent = '';
    box.append(document.createTextNode(box._lines.join('\n')));
  }

  // ★★ **只在贴底时自动滚** —— 这是尾部视图唯一一条真正的交互规矩：用户翻上去
  //    看历史时不许把他拽回来。
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/**
 * 一块（标准输出 / 标准错误）。`cell` 是 `op_job_log` 给的那一格。
 *
 * ★ 三态怎么判在 `dom.js` 的 `logCellOf()` 里，**只此一处** —— 作业屏那一块画的是
 *   同一份数据，两处各判一遍的话，漂的那一处不会报错。
 */
function paintPane(halfId, boxId, metaId, cell) {
  const half = $(halfId);
  const box = $(boxId);
  const meta = $(metaId);
  const it = logCellOf(cell);
  meta.textContent = it.kind === 'text' ? it.meta : '';
  meta.title = it.path;

  if (it.kind === 'absent') {
    // **确实没有这一份**。空的那一块不出现（设计律 1）—— 一个空的输出框是在说
    // "这里本该有东西"，而 `.err` 在正常情况下**就是**空的。
    half.classList.add('hidden');
    box.textContent = '';
    box._lines = [];
    return;
  }
  half.classList.remove('hidden');
  if (it.kind === 'na') {
    // **取不到**：文件在，但过不了安全检查或者打不开。★ 与"确实没有"必须长得
    // 不一样 —— 并成一句的话，一个模式不对的日志会被读成"这台站点上没有日志"。
    box.textContent = '';
    box._lines = [];
    box.append(cel('p', 'na', `取不到：${it.why}`));
    meta.textContent = it.path;
    return;
  }
  paintHalf(box, it.text);
}

function renderOut() {
  const when = $('out-when');
  const d = OUT.data;
  when.textContent = '';

  if (OUT.unsupported || OUT.error) {
    // 整块取不到：两块都收起来，只留一句。**能力缺席与一次失败在这一层是同一种
    // 画法**（都看不到东西），而区别由那句话本身说清。
    $('out-half-out').classList.add('hidden');
    $('out-half-err').classList.add('hidden');
    when.className = 'dim';
    when.textContent = OUT.unsupported ? '' : '';
    const box = $('out-out');
    const half = $('out-half-out');
    half.classList.remove('hidden');
    box.textContent = '';
    box._lines = [];
    box.append(cel('p', 'na', OUT.error || '取不到'));
    $('out-out-meta').textContent = '';
    return;
  }
  if (!d) {
    when.textContent = '正在取…';
    $('out-half-err').classList.add('hidden');
    $('out-half-out').classList.remove('hidden');
    return;
  }
  if (OUT.jobId) when.textContent = `作业 ${OUT.jobId}`;
  paintPane('out-half-out', 'out-out', 'out-out-meta', d.out === undefined ? null : d.out);
  paintPane('out-half-err', 'out-err', 'out-err-meta', d.err === undefined ? null : d.err);
  // 两块都空 ⇒ 什么也不显示（一个空的输出框在说"这里本该有东西"）。
  if ($('out-half-out').classList.contains('hidden')
      && $('out-half-err').classList.contains('hidden')) {
    $('out-half-out').classList.remove('hidden');
    const box = $('out-out');
    box.textContent = '';
    box._lines = [];
    box.append(cel('p', 'sub', '这个作业还没有写出任何东西。'));
  }
}

$('out-more').onclick = async () => {
  const btn = $('out-more');
  btn.disabled = true;
  try {
    await window.hover.more();
  } finally {
    btn.disabled = false;
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
