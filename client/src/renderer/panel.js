'use strict';
/**
 * panel.js —— 面板页逻辑。
 *
 * 面板有四种形态，由 session:state 驱动切换：
 *   设置（公钥 + 连接）→ 开始开发 → 会话进行中 → 结束/错误
 *
 * 会话跑起来之后窗口主体会被 code-server 的 WebContentsView 整个盖住，
 * 所以「重新加载 / 结束会话」这两个必需的操作也放在状态条里 ——
 * 那是唯一始终可见的、属于我们自己的区域。
 *
 * ★ 这个界面里**没有**任何「打开配置文件」的入口，这是有意的：
 *   所有条目都在界面上，用户不该为了改一个地址去手编辑 JSON。
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
let connected = false;
let whoami = null;
let lastProbe = [];          // 最近一次探测结果，供连接列表显示

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
  const bar = $('statusbar');
  const st = s ? s.state : 'idle';
  bar.className = 's-' + st;

  $('sb-state').textContent = STATE_TEXT[st] || st;

  let detail = '';
  if (s) {
    if (st === 'running' || st === 'releasing') {
      const bits = [];
      if (s.partition) bits.push(s.partition);
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
  const idle = !s || st === 'idle';
  $('sec-setup').classList.toggle('hidden', !idle);
  // 「开始开发」只在真的连上之后才出现 —— 连不上就没有分区可挑，
  // 摆一个按不动的按钮只会让人以为客户端坏了。
  $('sec-purpose').classList.toggle('hidden', !(idle && connected));
  $('sec-session').classList.toggle('hidden', !(s && st !== 'idle' && st !== 'ended'));

  if (s && st !== 'idle' && st !== 'ended') renderKv(s);
}

function renderKv(s) {
  const r = s.resources || {};
  const resText = [
    r.cpus ? `${r.cpus} 核` : null,
    r.mem || null,
    (typeof r.gpus === 'number' && r.gpus > 0) ? `${r.gpus} GPU` : null,
  ].filter(Boolean).join(' / ') || '—';

  const rows = [
    ['会话 ID', s.sessionId || '—'],
    ['作业 ID', s.jobId || '—'],
    // 默认是随机挑分区，所以用户事先不知道会落到哪种卡上 —— 必须显示实际结果
    ['分区', s.partition || '—'],
    ['资源', resText],
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

// ── 公钥 ────────────────────────────────────────────────────────────────────
function renderKey(info) {
  $('f-pubkey').value = info.publicKey || '';
  $('key-fp').textContent = info.fingerprint ? `指纹 ${info.fingerprint}` : '';

  const err = $('key-error');
  if (boot.keyError) {
    err.classList.remove('hidden');
    err.textContent = (boot.keyErrorDetail || '本机保存的私钥不可用。')
      + ' 若确认要重新生成（你会需要把新公钥重新注册到 IDM），点上面的「重新生成密钥…」。';
  } else {
    err.classList.add('hidden');
  }

  // 密钥没能落盘（这台机器没有凭据库）时，把「保存方式」这一块推到用户眼前 ——
  // 不静默降级是我们的原则，但如果用户看不见这个选择，原则就等于没实现。
  $('sec-secret').classList.toggle('hidden', Boolean(boot.keyError));
  if (!info.persisted && !boot.keyError) {
    $('securenote').textContent =
      '注意：这台机器上没有可用的系统凭据库，私钥还没有保存。'
      + '不保存的话，每次启动都会生成新密钥，你注册到 IDM 的那把会失效。';
  }
}

// ── 连接列表 ────────────────────────────────────────────────────────────────
function renderConnections(list) {
  const box = $('conn-list');
  box.textContent = '';
  $('conn-wrap').classList.toggle('hidden', list.length === 0);

  for (const c of list) {
    const li = document.createElement('li');
    const active = c.id === boot.activeConnectionId;
    li.className = 'conn' + (active ? ' active' : '');

    const probe = lastProbe.find((p) => p.id === c.id);
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = `${c.label} — ${c.user}@${c.host}:${c.port}`;
    const m = document.createElement('span');
    m.className = 'm';
    if (!probe) m.textContent = '未探测';
    else if (probe.reachable) m.textContent = `可达 · ${probe.rttMs}ms`;
    else m.textContent = `不可达：${probe.error || '失败'}`;
    m.classList.toggle('bad', Boolean(probe && !probe.reachable));

    const pick = document.createElement('button');
    pick.className = 'ghost tiny';
    pick.textContent = active ? '当前' : '设为当前';
    pick.disabled = active;
    pick.onclick = async () => {
      const r = await window.slurmate.setActiveConnection(c.id);
      if (!r.ok) return notice('error', r.error);
      boot.activeConnectionId = c.id;
      renderConnections(boot.connections);
    };

    const del = document.createElement('button');
    del.className = 'ghost tiny danger-ghost';
    del.textContent = '删除';
    del.onclick = async () => {
      const r = await window.slurmate.deleteConnection(c.id);
      if (!r.ok) return notice('error', r.error);
      boot.connections = r.connections;
      boot.activeConnectionId = r.activeConnectionId;
      renderConnections(boot.connections);
      notice('info', '已删除该连接。');
    };

    li.append(t, m, pick, del);
    box.append(li);
  }
}

// ── 分区 ────────────────────────────────────────────────────────────────────
function renderPartitions(list) {
  const sel = $('f-part');
  const keep = sel.value;
  sel.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '（随机挑一个有权限的）';
  sel.append(none);

  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.allowed ? p.name : `${p.name}（无权限）`;
    o.disabled = !p.allowed;
    // 禁用必须给出理由，而不是让用户猜为什么点不动
    if (!p.allowed && p.reason) o.title = p.reason;
    sel.append(o);
  }
  sel.value = keep;
}

// ── 主机密钥确认 ────────────────────────────────────────────────────────────
function askHostKey(res) {
  return new Promise((resolve) => {
    const dlg = $('hostkey-dlg');
    const changed = res.code === 'host_key_changed';

    $('hk-title').textContent = changed ? '⚠ 登录节点的主机密钥已改变' : '确认登录节点身份';
    $('hk-body').textContent = changed
      ? '这与上次连接时记录的不一致。可能是服务器重装过，也可能有人在中间拦截。'
        + '在弄清原因之前请不要继续 —— 继续就等于把这把私钥的认证交给一个不确定的对端。'
      : '这是第一次连接到这台登录节点。请核对下面的指纹（应与集群管理员公布的一致），'
        + '确认后本机才会记住它。';
    $('hk-fp').textContent = (res.hostKey && res.hostKey.fingerprint) || '（没拿到指纹）';
    $('hk-trust').textContent = changed ? '我知道服务器重装了，仍然信任' : '我核对过了，信任它';

    const finish = async (trust) => {
      $('hk-trust').onclick = null;
      $('hk-cancel').onclick = null;
      dlg.close();
      resolve(trust);
    };
    $('hk-trust').onclick = () => finish(true);
    $('hk-cancel').onclick = () => finish(false);
    dlg.showModal();
  });
}

/** 统一的连接结果处理：主机密钥要用户拍板时弹框，其余按结果报错。 */
async function handleConnectResult(res) {
  if (res.ok) {
    connected = true;
    whoami = res.whoami || null;
    const acct = whoami && whoami.account;
    notice('ok', `已连接：${(whoami && whoami.user) || ''}（账户 ${acct || '未分配'}）`);
    if (!acct) {
      notice('error', '你的账号尚未分配集群计算权限，请联系管理员 —— 否则提交作业会失败。');
    }
    if (res.partitions) renderPartitions(res.partitions);
    renderSnapshot({ state: 'idle', demo: boot.demo });
    return true;
  }

  if (res.code === 'host_key_unknown' || res.code === 'host_key_changed') {
    const trusted = await askHostKey(res);
    if (!trusted) {
      notice('info', '已取消，没有建立连接。');
      return false;
    }
    const again = await window.slurmate.trustHostKey(res.hostKey && res.hostKey.fingerprint);
    return handleConnectResult(again);
  }

  connected = false;
  notice('error', res.error || '连接失败');
  return false;
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

  renderKey(boot);
  $('f-savemode').value = boot.secretMode === 'plain' ? 'plain'
    : boot.secretMode === 'none' ? 'none' : 'encrypted';
  if (!boot.secureStorageAvailable) {
    // 连「加密保存」这个选项都不该出现在没有凭据库的机器上 ——
    // 摆在那里只会让用户选了之后收到一句失败。
    const opt = $('f-savemode').querySelector('option[value="encrypted"]');
    if (opt) { opt.disabled = true; opt.textContent = '加密保存（这台机器没有系统凭据库）'; }
  }

  if (boot.connection) {
    $('f-user').value = boot.connection.user;
    $('f-host').value = boot.connection.host;
    $('f-port').value = boot.connection.port;
  }
  renderConnections(boot.connections);
  renderPartitions(boot.partitions || []);

  // ── 事件 ──
  $('btn-copykey').onclick = async () => {
    const r = await window.slurmate.copyPublicKey();
    notice(r.ok ? 'ok' : 'error', r.ok ? '公钥已复制到剪贴板。' : r.error);
  };

  $('btn-regen').onclick = async () => {
    const yes = window.confirm(
      '重新生成会作废当前这把密钥。\n\n'
      + '你必须把新的公钥重新注册到 IDM，否则连不上。\n\n确定要重新生成吗？');
    if (!yes) return;
    const mode = $('f-savemode').value;
    const r = await window.slurmate.setSecretMode(mode, true);
    if (!r.ok) return notice('error', '重新生成失败：' + (r.reason || r.error));
    const info = await window.slurmate.publicKey();
    boot.keyError = null;
    renderKey({ ...info, publicKey: info.publicKey });
    notice('warn', '已生成新密钥。请把上面的新公钥重新注册到 IDM，然后重新连接。');
  };

  $('btn-savemode').onclick = async () => {
    const mode = $('f-savemode').value;
    const r = await window.slurmate.setSecretMode(mode, false);
    if (r.ok) {
      notice('ok', '已保存私钥的保存方式。');
      const info = await window.slurmate.publicKey();
      boot.keyPersisted = true;
      renderKey(info);
    } else if (r.reason === 'no_secure_storage') {
      notice('error', '这台机器上没有可用的系统凭据库，无法加密保存。请改选「明文保存」或「不保存」。');
    } else {
      notice('error', '保存失败：' + (r.reason || r.error));
    }
  };

  $('btn-connect').onclick = async () => {
    const user = $('f-user').value.trim();
    const host = $('f-host').value.trim();
    const port = Number($('f-port').value) || 10100;
    if (!user || !host) return notice('error', '请先填写用户名和主机。');

    const saved = await window.slurmate.saveConnection({ user, host, port, label: host });
    if (!saved.ok) return notice('error', saved.error);
    boot.connections = (boot.connections || []).filter((c) => c.id !== saved.connection.id)
      .concat(saved.connection);
    boot.activeConnectionId = saved.connection.id;
    await window.slurmate.setActiveConnection(saved.connection.id);
    renderConnections(boot.connections);

    await handleConnectResult(await window.slurmate.connect({ connectionId: saved.connection.id }));
  };

  $('btn-probe').onclick = doProbe;

  $('btn-start').onclick = async () => {
    $('btn-start').disabled = true;
    notice('info', '正在提交开发会话…');
    try {
      // 只带上真正填了的键。留空 = 让服务端用它的默认值 ——
      // 客户端不自己编默认值，否则一个改过的客户端省略字段就能要到整机。
      const res = {};
      const cpus = $('f-cpus').value.trim();
      const mem = $('f-mem').value.trim();
      const gpus = $('f-gpus').value.trim();
      const part = $('f-part').value;
      if (cpus) res.cpus = Number(cpus);
      if (mem) res.mem = mem;
      if (gpus !== '') res.gpus = Number(gpus);
      if (part) res.partition = part;

      const r = await window.slurmate.start(res);
      if (r && r.snapshot) renderSnapshot(r.snapshot);
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
  if (s && s.state && s.state !== 'idle' && s.state !== 'ended') connected = true;
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
    lastProbe = (await window.slurmate.probeHosts()) || [];
    renderConnections(boot.connections || []);

    if (lastProbe.length === 0) {
      // 「一条都没配」和「配了但都不通」是两回事，文案必须分开 ——
      // 曾经这里写死成「三个地址都不可达」，而候选其实是 0 个。
      notice('info', '还没有保存任何连接。填好上面的用户名、主机、端口，点「保存并连接」。');
      return;
    }
    const ok = lastProbe.filter((h) => h.reachable);
    if (ok.length === 0) {
      notice('error', `${lastProbe.length} 个已保存的连接都不可达。`
        + '请确认网络，或检查地址与端口是否正确。');
    } else {
      notice('ok', `${ok.length}/${lastProbe.length} 个连接可达，最快的是「${ok[0].label}」（${ok[0].rttMs}ms）。`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

init().catch((e) => notice('error', '界面初始化失败：' + e.message));
