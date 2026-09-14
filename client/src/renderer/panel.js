'use strict';
/**
 * panel.js —— 面板页逻辑。
 *
 * 面板有四种形态，由 session:state 驱动切换：
 *   设置（未连接）→ 用途选择 → 会话进行中 → 结束/错误
 *
 * 会话跑起来之后窗口主体会被 code-server 的 WebContentsView 整个盖住，
 * 所以「重新加载 / 结束会话」这两个必需的操作也放在状态条里 ——
 * 那是唯一始终可见的、属于我们自己的区域。
 */

const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
  idle: '未开始',
  submitting: '正在提交…',
  queued: '排队中',
  running: '运行中',
  releasing: '正在释放…',
  ended: '已结束',
  error: '出错',
};

let boot = null;
let currentPurpose = 'code';
let lastState = null;

// ── 工具 ────────────────────────────────────────────────────────────────────
function fmtLeft(expiresAt) {
  // expires_at 在 show_job 失败时**整个字段不存在**（守护进程的行为）。
  // 必须显示「未知」，而不是 0 或 NaN —— 后者会让人以为会话要到期了。
  if (typeof expiresAt !== 'number') return '未知';
  const left = expiresAt - Math.floor(Date.now() / 1000);
  if (left <= 0) return '已到期';
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
  return `${h} 小时 ${m} 分`;
}

function fmtAge(ms) {
  if (typeof ms !== 'number') return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  return `${Math.round(s / 60)} 分钟前`;
}

function notice(kind, text) {
  const box = $('notices');
  const el = document.createElement('div');
  el.className = 'notice ' + kind;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = { ok: 'OK', error: '错误', warn: '注意', info: '信息', demo: '演示' }[kind] || kind;
  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = text;              // textContent：绝不把外部文本当 HTML 插进去
  el.append(tag, body);
  box.prepend(el);
  while (box.children.length > 80) box.lastChild.remove();
}

// ── 状态渲染 ────────────────────────────────────────────────────────────────
function renderSnapshot(s) {
  lastState = s;
  const bar = $('statusbar');
  const st = s ? s.state : 'idle';
  bar.className = 's-' + st;

  $('sb-state').textContent = STATE_TEXT[st] || st;

  let detail = '';
  if (s) {
    if (st === 'running' || st === 'releasing') {
      const bits = [];
      if (s.node) bits.push(s.node);
      if (s.expiresAt !== undefined) bits.push('剩余 ' + fmtLeft(s.expiresAt));
      if (s.renewCount) bits.push('已续期 ' + s.renewCount + ' 次');
      if (s.tunnelState === 'down') bits.push('隧道断开，正在重试');
      detail = bits.join(' · ');
    } else if (st === 'queued') {
      detail = s.jobId ? `作业 ${s.jobId} · 等待调度与登记` : '等待调度';
    } else if (st === 'error') {
      detail = s.error || '';
    } else if (st === 'submitting') {
      detail = '正在向控制节点申请资源';
    }
  }
  $('sb-detail').textContent = detail;

  const running = (st === 'running' || st === 'releasing');
  $('sb-reload').classList.toggle('hidden', !running);
  $('sb-end').classList.toggle('hidden', !running);
  $('sb-demo').classList.toggle('hidden', !(s && s.demo));

  // 形态切换
  $('sec-setup').classList.toggle('hidden', Boolean(s) && st !== 'idle');
  const showPurposes = Boolean(s) && (st === 'idle');
  $('sec-purpose').classList.toggle('hidden', !showPurposes);
  $('sec-session').classList.toggle('hidden', !(s && st !== 'idle' && st !== 'ended'));

  if (s && st !== 'idle' && st !== 'ended') renderKv(s);
}

function renderKv(s) {
  const rows = [
    ['会话 ID', s.sessionId || '—'],
    ['作业 ID', s.jobId || '—'],
    ['用途 / 分区', [s.purpose, s.partition].filter(Boolean).join(' / ') || '—'],
    ['节点', s.node || '—'],
    ['隧道目标', s.tunnelTarget || '—'],
    ['本地地址', s.origin || '—'],
    ['剩余时间', fmtLeft(s.expiresAt)],
    ['作业状态', s.jobState || '—'],
    ['上次心跳', fmtAge(s.hbAgeMs)],
    ['隧道', { listening: '已连接', down: '断开，重试中', stopped: '已停止' }[s.tunnelState] || s.tunnelState],
  ];
  const dl = $('kv');
  dl.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

// ── 用途 ────────────────────────────────────────────────────────────────────
function renderPurposes(list) {
  const box = $('purposes');
  box.textContent = '';
  for (const p of list) {
    const b = document.createElement('button');
    b.className = 'purpose';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(p.key === currentPurpose));
    b.disabled = !p.allowed;

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = p.label;
    const m = document.createElement('span');
    m.className = 'm';
    // gres 是死配置（见记忆 gres-dead-config-deferred）—— 所有用途实际都拿不到 GPU。
    // 所以这里**不显示** gres，免得标签撒谎。
    m.textContent = `${p.partition} · ${p.cpus} 核 · ${p.mem}`;
    b.append(t, m);

    if (!p.allowed) {
      const why = document.createElement('span');
      why.className = 'why';
      why.textContent = p.reason || '你的账号没有这个分区的权限';
      b.append(why);
    }
    b.onclick = () => { currentPurpose = p.key; renderPurposes(list); };
    box.append(b);
  }
}

// ── 地址表 ──────────────────────────────────────────────────────────────────
function renderHosts(list) {
  const sel = $('f-host');
  sel.textContent = '';
  for (const h of list) {
    const o = document.createElement('option');
    o.value = `${h.host}:${h.port}`;
    o.textContent = h.reachable
      ? `${h.label} — ${h.host}:${h.port}（${h.rttMs}ms）`
      : `${h.label} — ${h.host}:${h.port}（不可达：${h.error || '失败'}）`;
    o.disabled = !h.reachable;
    sel.append(o);
  }
  const firstOk = list.find((h) => h.reachable);
  if (firstOk) sel.value = `${firstOk.host}:${firstOk.port}`;
}

// ── 启动 ────────────────────────────────────────────────────────────────────
async function init() {
  boot = await window.slurmate.bootstrap();

  if (boot.demo) {
    $('demo-banner').classList.remove('hidden');
    $('sec-debug').classList.remove('hidden');
    $('app-sub').textContent = '演示模式 · 未连接集群';
  } else if (boot.backendLabel) {
    $('app-sub').textContent = boot.backendLabel;
  }

  if (boot.profile && boot.profile.user) $('f-user').value = boot.profile.user;
  $('f-savepw').value = boot.savePasswordMode || 'ask';

  if (!boot.secureStorageAvailable) {
    $('securenote').textContent =
      '注意：这台机器上没有可用的系统凭据库，因此无法加密保存密码。'
      + '你可以选择「每次询问」或「不保存」；若一定要保存，只能明文写入（权限 0600）。';
  }

  renderHosts(boot.addressTable.map((h) => ({ ...h, reachable: true })));
  await doProbe();

  if (boot.purposes && boot.purposes.length) {
    renderPurposes(boot.purposes);
    renderSnapshot({ state: 'idle', demo: boot.demo });
  }

  // ── 事件 ──
  $('btn-probe').onclick = doProbe;

  $('btn-connect').onclick = async () => {
    const [host, port] = ($('f-host').value || '').split(':');
    if (!host) return notice('error', '请先选择一个可达的登录节点地址。');
    const password = $('f-pass').value;
    const res = await window.slurmate.connect({
      user: $('f-user').value.trim(), host, port: Number(port) || 10100,
    });
    if (!res.ok) return notice('error', res.error || '连接失败');
    if (res.whoami) {
      notice('ok', `已连接：${res.whoami.user}（账户 ${res.whoami.account || '未分配'}）`);
      if (!res.whoami.account) {
        notice('error', '你的账号尚未分配集群计算权限，请联系管理员 —— 否则提交作业会失败。');
      }
    }
    if (res.purposes) renderPurposes(res.purposes);
    if (password) await window.slurmate.savePassword($('f-savepw').value, password);
    renderSnapshot({ state: 'idle', demo: boot.demo });
  };

  $('btn-savepw').onclick = async () => {
    const res = await window.slurmate.savePassword($('f-savepw').value, $('f-pass').value);
    if (res.ok) notice('ok', '已保存密码设置。');
    else if (res.reason === 'no_secure_storage') {
      notice('error', '这台机器上没有可用的系统凭据库，无法加密保存。请改选「不保存」或「每次询问」。');
    } else notice('error', '保存失败：' + res.reason);
  };

  $('btn-start').onclick = async () => {
    $('btn-start').disabled = true;
    notice('info', '正在提交开发会话…');
    try {
      await window.slurmate.start(currentPurpose);
    } finally {
      $('btn-start').disabled = false;
    }
  };

  $('btn-doctor').onclick = async () => {
    const r = await window.slurmate.doctor();
    if (!r || !r.ok) return notice('error', '体检失败：' + ((r && r.error && r.error.detail) || '无响应'));
    const d = r.data;
    const bad = [];
    if (!d.socket) bad.push('socket 不存在');
    if (!d.table) bad.push('nft 表不存在');
    if (!d.rules_readable) bad.push('规则不可读');
    if (!d.consistent) bad.push(`规则数(${d.rules_count})与会话数(${d.active_sessions})不一致`);
    if (!(d.existing && d.existing.codeserver_table)) bad.push('现有的 inet codeserver 表不见了');
    if (!(d.existing && d.existing.portdaemon_table)) bad.push('现有的 port-daemon 表不见了');
    if (bad.length) notice('error', '体检发现问题：' + bad.join('；'));
    else notice('ok', `体检通过：${d.rules_count} 条 ACL 规则，${d.active_sessions} 个活跃会话。`);
  };

  $('btn-reload').onclick = () => window.slurmate.reload();
  $('sb-reload').onclick = () => window.slurmate.reload();
  $('btn-end').onclick = () => endSession();
  $('sb-end').onclick = () => endSession();

  $('btn-keep').onclick = async () => {
    const res = await window.slurmate.stop('keep');
    notice('info', (res && res.detail) || '已关闭，作业继续运行。');
  };

  for (const b of document.querySelectorAll('[data-debug]')) {
    b.onclick = async () => {
      const r = await window.slurmate.debug(b.dataset.debug);
      notice(r.ok ? 'demo' : 'error', r.ok ? '已触发：' + b.textContent : r.error);
    };
  }

  window.slurmate.onState(renderSnapshot);
  window.slurmate.onNotice((n) => {
    if (n.kind === 'demo') { $('demo-banner').classList.remove('hidden'); return; }
    if (n.kind === 'key-seen' || n.kind === 'key-blocked') {
      // 快捷键诊断：刻意记进日志，便于在真机上核对「哪些键到了页面、哪些被吞了」
      notice('info', (n.kind === 'key-blocked' ? '已拦截：' : '已放行：') + n.text);
      return;
    }
    notice(n.kind === 'ok' ? 'ok' : n.kind === 'error' ? 'error' : 'info', n.text);
  });

  // 拉一次当前状态（可能是启动时自动接上的会话）
  const s = await window.slurmate.state();
  renderSnapshot(s || { state: 'idle', demo: boot.demo });
}

async function endSession() {
  const res = await window.slurmate.stop('farewell');
  if (res && res.ok) {
    notice('info', res.detail || '已请求释放。');
    if (res.state === 'releasing') {
      notice('warn',
        '已请求释放，但这只表示控制节点开始处理 —— 它并不保证作业真的被取消了。'
        + '请以状态条变为「已结束」为准。');
    }
  } else if (res) {
    notice('error', res.detail || '释放失败。');
  }
}

async function doProbe() {
  const btn = $('btn-probe');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '探测中…';
  try {
    const list = await window.slurmate.probeHosts();
    renderHosts(list);
    const reachable = list.filter((h) => h.reachable);
    if (reachable.length === 0) {
      notice('error', '三个登录节点地址都不可达。请确认网络，或检查 /etc/hosts 与 DNS。');
    } else {
      notice('ok', `可达地址 ${reachable.length} 个，将优先使用「${reachable[0].label}」。`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

init().catch((e) => notice('error', '界面初始化失败：' + e.message));
