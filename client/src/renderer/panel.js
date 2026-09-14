'use strict';
/**
 * panel.js —— 面板页逻辑。
 *
 * 面板有四种形态，由 session:state 驱动切换：
 *   登录节点 → 开始开发 → 会话进行中 → 结束/错误
 *
 * ★ 登录节点这一屏的第一眼必须是**已保存的连接** —— 用户每次打开客户端要做的事
 *   是「连上上次那台」，不是「再填一遍地址」。公钥和地址表单折进「新建连接」里，
 *   那是第一次使用时才走一遍的流程。
 *
 * ★ 密钥是**按连接**的（见 main/config.js）。所以「新建」与「编辑」共用同一块表单，
 *   各自展现自己那一把钥匙：新建时是刚生成、还没有归属的那把，编辑时是这条连接的
 *   那把。界面上没有「全局密钥」这个概念 —— 重新生成只影响当前这一条。
 *
 * ★ 地址栏永远不预填。预填上一个连接的地址，用户不改直接点保存，得到的只是
 *   「又存了一条一样的」，而他以为自己新建了一条。
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

/**
 * 「新建／编辑」表单的状态。
 *   mode='new'  → 展示那把还没有归属的密钥（新建时生成的）
 *   mode='edit' → 展示 id 指向的那条连接的密钥
 * id 始终是「当前正在编辑哪条连接」，新建时为 null —— 它是保存时告诉主进程
 * 「改哪一条」的唯一依据，搞错就会把 A 的地址写到 B 头上。
 */
let form = { open: false, mode: 'new', id: null };

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
  $('sec-connect').classList.toggle('hidden', !idle);
  // 会话一起来就把表单收掉 —— 它只在「还没连上」这一屏里说得通
  if (!idle) closeForm();
  // 「开始开发」只在真的连上之后才出现 —— 连不上就没有分区可挑，
  // 摆一个按不动的按钮只会让人以为客户端坏了。
  $('sec-purpose').classList.toggle('hidden', !(idle && connected));
  $('sec-session').classList.toggle('hidden', !(s && st !== 'idle' && st !== 'ended'));

  if (s && st !== 'idle' && st !== 'ended') renderKv(s);
}

/**
 * 打开「新建」表单。
 *
 * ★ 密钥**在这一步生成**，早于用户填地址 —— 他得先把公钥复制去 IDM 注册，
 *   回来才连得上。所以这一步是异步的：公钥框会先显示「正在生成密钥…」。
 *   主进程那边是幂等的：已经有一把还没归属的密钥就复用它，不会又换一把
 *   （那会作废用户可能已经注册好的公钥）。
 */
async function openNewForm() {
  form = { open: true, mode: 'new', id: null };
  $('sec-form').classList.remove('hidden');
  $('btn-new').classList.add('hidden');

  $('form-title').textContent = '新建连接';
  $('form-hint').textContent =
    '两步：把下面的公钥注册到你的 IDM 账户，再填登录节点的地址。';
  $('btn-save').textContent = '保存并连接';
  // 地址栏一律清空 —— 见文件头：预填上一条的地址会让「新建」悄悄变成「又存一遍」
  $('f-label').value = '';
  $('f-user').value = '';
  $('f-host').value = '';
  $('f-port').value = '';
  $('key-hint').textContent = '正在生成密钥…';
  hideKeyMessages();
  renderConnEmpty();

  const r = await window.slurmate.newKey();
  if (!form.open || form.mode !== 'new') return;    // 用户已经关掉或切走了
  if (!r || !r.ok) return showKeyError((r && r.error) || '生成密钥失败。');
  $('key-hint').textContent = r.generated
    ? '这把密钥属于下面这条新连接，还没有别的连接用它。'
    : '这把密钥是上次「新建」时生成的（如果你已经把它注册过了，直接往下填就行）。';
  renderKey(r.key);
}

/** 打开某条连接的编辑表单。 */
async function openEditForm(c) {
  form = { open: true, mode: 'edit', id: c.id };
  $('sec-form').classList.remove('hidden');
  $('btn-new').classList.add('hidden');

  $('form-title').textContent = '编辑连接';
  $('form-hint').textContent = '改这里的地址只影响这一条连接。';
  $('btn-save').textContent = '保存';
  $('f-label').value = c.label || '';
  $('f-user').value = c.user;
  $('f-host').value = c.host;
  $('f-port').value = c.port;
  $('key-hint').textContent = '正在读取密钥…';
  hideKeyMessages();
  renderConnEmpty();

  const r = await window.slurmate.publicKey({ connectionId: c.id });
  if (!form.open || form.mode !== 'edit' || form.id !== c.id) return;
  if (!r || !r.ok) return showKeyError((r && r.error) || '读取密钥失败。');
  $('key-hint').textContent = r.key.missing
    ? '这条连接还没有密钥。点「重新生成密钥…」生成一把，再把公钥注册到 IDM。'
    : '这是这条连接自己的密钥。重新生成只作废它，其他连接不受影响。';
  renderKey(r.key);
}

/** 收起表单，回到「已保存的连接」那一屏。 */
function closeForm() {
  form = { open: false, mode: 'new', id: null };
  $('sec-form').classList.add('hidden');
  $('btn-new').classList.remove('hidden');
  renderConnEmpty();
}

/** 「一条连接都没有」时的引导语。表单开着的时候它得指向表单，而不是那个已被收起的按钮。 */
function renderConnEmpty() {
  $('conn-empty').textContent = form.open
    ? '还没有保存任何登录节点。填好下面的用户名、主机和端口，点「保存并连接」。'
    : '还没有保存任何登录节点。点右上角的「新建连接」填一个 —— 只需要用户名、主机和端口。';
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

/** 清掉密钥区那几条提示。**切换表单时必须先清** —— 否则上一把钥匙的毛病会留在屏幕上。 */
function hideKeyMessages() {
  for (const id of ['key-error', 'key-nopersist']) {
    const el = $(id);
    el.classList.add('hidden');
    el.classList.remove('alarm');
    el.textContent = '';
  }
  $('key-fp').textContent = '—';
}

function showKeyError(text) {
  const err = $('key-error');
  err.textContent = text;
  err.classList.remove('hidden');
}

/**
 * 渲染一把密钥。
 * @param {{publicKey, fingerprint, persisted, error, detail, missing}} k
 */
function renderKey(k) {
  hideKeyMessages();
  // ★ 只显示指纹，**不显示公钥本身**：所有 ed25519 公钥的前 40 个字符逐字相同
  //   （`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI` 是固定的），于是「换了一把钥匙」
  //   在一个文本框里看起来毫无变化 —— 而这是最要命的一种变化，用户会以为还是
  //   原来那把，实际拿去认证的已经不是了，症状只有「认证失败」。
  //   指纹短、每一位都随机，拿去和 IDM 里那条一比对就知道对不对。
  $('key-fp').textContent = k.fingerprint || '—';

  if (k.error) {
    // 密钥在，但读不出来。这是**唯一**一条会走到「重新生成」的路，
    // 而点下去会作废用户已经注册到 IDM 的那把公钥 —— 必须说清楚。
    showKeyError((k.detail || '这把密钥不可用。')
      + ' 若确认要重新生成（你会需要把新的公钥重新注册到 IDM），点上面的「重新生成密钥…」。');
    return;
  }
  // 还没有密钥。由 key-hint 说明该怎么办，这里再喊一遍只会重复。
  if (k.missing) return;

  // 密钥存不下来（这台机器没有凭据库）。必须**说出来**，不能只是没保存成功。
  //
  // 这里曾经摆着一个「私钥保存方式」下拉框，让用户在加密／明文／不保存之间选。
  // 那等于把「你的私钥会以明文躺在磁盘上」包装成一个需要用户自己权衡的选项 ——
  // 选明文的那个用户并不知道自己在放弃什么。现在只有加密一种方式，
  // 存不了就如实讲清楚后果，没有第二个选项可以让人选错。
  if (k.persisted === false) {
    const np = $('key-nopersist');
    // 「没有凭据库」和「有凭据库但这次写失败了」是两种不同的毛病，修法也不同，
    // 所以文案要分开 —— 一句笼统的「保存失败」指不回根因。
    //
    // ★ 这条必须**显眼**（.alarm），因为它预告的正是后面那个「认证失败」：
    //   密钥存不下来 → 下次启动换一把 → 已经注册到 IDM 的那把公钥作废。
    //   写成一行灰字时，用户会一路读到「认证失败」才回头，而那时已经指不回这里了。
    const tail = '下次启动会重新生成一把新密钥，你注册到 IDM 的那把公钥随之作废 ——'
      + '到时候你看到的只会是「认证失败」。';
    np.textContent = boot.secureStorageAvailable
      ? '注意：私钥这次没能保存到本机。' + tail
      : '注意：这台机器上没有可用的系统凭据库，私钥存不下来（只能留在内存里）。' + tail;
    np.classList.add('alarm');
    np.classList.remove('hidden');
  }
}

// ── 连接列表 ────────────────────────────────────────────────────────────────
function renderConnections(list) {
  const box = $('conn-list');
  box.textContent = '';
  $('conn-empty').classList.toggle('hidden', list.length > 0);

  for (const c of list) {
    const li = document.createElement('li');
    // 「当前」和「已连接」是两回事：断开之后活动连接还是它，但没有连着。
    const live = c.id === boot.activeConnectionId && connected;
    li.className = 'conn' + (live ? ' active' : '');

    const t = document.createElement('span');
    t.className = 't';
    // 有备注就显示备注 —— 用户给它起了名，就是为了不必再读地址。
    // 没起名才回落成地址。**两者取其一，不并排显示**：并排等于把备注降级成一个
    // 前缀，那这个名字就白起了，用户还是得去读那串地址。
    t.textContent = c.label || `${c.user}@${c.host}:${c.port}`;
    // 地址仍然在，只是不占地方 —— 鼠标停一下就能看到。
    t.title = `${c.user}@${c.host}:${c.port}`;

    const probe = lastProbe.find((p) => p.id === c.id);
    const m = document.createElement('span');
    m.className = 'm';
    if (live) {
      m.textContent = '已连接';
      m.classList.add('good');
    } else if (!probe) {
      m.textContent = '未探测';
    } else if (probe.reachable) {
      m.textContent = `可达 · ${probe.rttMs}ms`;
    } else {
      m.textContent = `不可达：${probe.error || '失败'}`;
      m.classList.add('bad');
    }

    // 主动断开。断的只是客户端这一跳 —— 作业还在集群上跑着，
    // 再点「连接」会重新接上它。会话进行中不给断（主进程也会拒）。
    const main = document.createElement('button');
    main.className = 'tiny' + (live ? ' ghost danger-ghost' : '');
    main.textContent = live ? '断开' : '连接';
    main.onclick = () => (live ? doDisconnect() : doConnectTo(c));

    // 编辑：地址 / 这条连接自己的密钥。
    const edit = document.createElement('button');
    edit.className = 'ghost tiny';
    edit.textContent = '编辑';
    edit.onclick = () => openEditForm(c);

    const del = document.createElement('button');
    del.className = 'ghost tiny danger-ghost';
    del.textContent = '删除';
    del.disabled = live;              // 连着的时候先断开再删，别让作业失去主人
    del.onclick = async () => {
      // 删除现在连带销毁这条连接的私钥，所以要先问一句 —— 它是一条不可逆的操作，
      // 而且用户已经拿去 IDM 注册过的公钥会就此作废（重新建一条要重新注册）。
      const sure = window.confirm(
        `删除「${c.user}@${c.host}:${c.port}」？\n\n`
        + '这条连接的私钥会一起删掉。你注册到 IDM 的那把公钥随之作废，'
        + '重建一条需要重新注册。');
      if (!sure) return;
      const r = await window.slurmate.deleteConnection(c.id);
      if (!r.ok) return notice('error', r.error);
      boot.connections = r.connections;
      boot.activeConnectionId = r.activeConnectionId;
      // 正在编辑的就是这一条 —— 表单不能再留在一个已经不存在的条目上
      if (form.open && form.mode === 'edit' && form.id === c.id) closeForm();
      renderConnections(boot.connections);
      notice('info', r.keyDeleted
        ? '已删除该连接，它的私钥也一并删掉了。'
        : '已删除该连接。');
    };

    li.append(t, m, main, edit, del);
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
    renderConnections(boot.connections);
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

  // ★ bootstrap 里**没有**公钥 —— 密钥是按连接的，界面在打开某条连接的表单时
  //   单独去问（app:publicKey / app:newKey）。曾经这里从 bootstrap 读全局的
  //   keyFingerprint，而字段名对不上，于是指纹从来没在首屏出现过；
  //   现在那条路径整个不存在了，每个字段都是问出来的、当场渲染的。
  renderConnections(boot.connections);
  renderPartitions(boot.partitions || []);
  renderConnEmpty();
  // 一条连接都没有 —— 第一眼就是「新建」，不然用户对着空列表找不到入口
  if ((boot.connections || []).length === 0) await openNewForm();

  // 当前表单在操作哪把密钥。新建时是那把还没有归属的，编辑时是这条连接的。
  const keyPayload = () =>
    (form.mode === 'edit' && form.id ? { connectionId: form.id } : undefined);

  // ── 事件 ──
  $('btn-new').onclick = () => openNewForm();
  $('btn-cancel-form').onclick = () => closeForm();

  $('btn-copykey').onclick = async () => {
    const r = await window.slurmate.copyPublicKey(keyPayload());
    notice(r.ok ? 'ok' : 'error', r.ok ? '公钥已复制到剪贴板。' : (r && r.error) || '复制失败。');
  };

  $('btn-regen').onclick = async () => {
    const which = form.mode === 'edit' ? '这条连接的' : '这把';
    const yes = window.confirm(
      `重新生成会作废${which}密钥。\n\n`
      + '你必须把新的公钥重新注册到 IDM，否则连不上。\n\n确定要重新生成吗？');
    if (!yes) return;
    const r = await window.slurmate.regenerateKey(keyPayload());
    if (!r || !r.key || !r.key.publicKey) {
      return notice('error', (r && r.error) || '重新生成失败。');
    }
    renderKey(r.key);
    if (r.ok) {
      notice('warn', '已生成新密钥。请把上面的新公钥重新注册到 IDM，然后重新连接。');
    } else {
      // 存不下去也要说清楚 —— 用户此刻正拿着这把新公钥去注册，
      // 而它下次启动就会消失，这个后果必须当场讲。
      notice('error', '已生成新密钥，但它没能保存到本机（没有可用的系统凭据库）——'
        + '关闭客户端后这把密钥就没了。请先把上面的公钥注册到 IDM。');
    }
  };

  $('btn-save').onclick = async () => {
    const label = $('f-label').value.trim();
    const user = $('f-user').value.trim();
    const host = $('f-host').value.trim();
    const port = Number($('f-port').value);
    if (!user || !host) return notice('error', '请先填写用户名和主机。');
    // 端口不给默认值：编一个默认端口出来，用户会以为「填不填都行」，
    // 而错端口的表现是连接超时 —— 一个指不回这里的原因。
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return notice('error', '端口请填 1-65535 之间的整数（集群登录节点监听的端口）。');
    }

    // ★ 备注这一栏的传法在两种模式下不同，因为**空备注的含义不同**：
    //   编辑时那一栏就是当前值，清空即清空，必须原样传上去；
    //   新建时留空只表示「这次没起名」，不该拿它把已有条目的备注冲掉。
    const editing = form.mode === 'edit' && form.id ? form.id : null;
    const input = { user, host, port };
    if (editing) input.id = editing;
    if (editing || label) input.label = label;

    const saved = await window.slurmate.saveConnection(input);
    if (!saved.ok) return notice('error', saved.error);
    boot.connections = saved.connections;
    boot.activeConnectionId = saved.connection.id;
    renderConnections(boot.connections);

    if (editing) {
      const wasLive = connected && saved.connection.id === boot.activeConnectionId;
      closeForm();
      notice('ok', '已保存这条连接。');
      if (wasLive) {
        // 地址改了但 SSH 连接还挂在旧地址上。不说的话，用户会以为改动没生效。
        notice('info', '这条连接正连着 —— 新地址要重新点一次「连接」才会生效。');
      }
      return;
    }

    notice('info', saved.created ? '已保存这条连接。' : '这条连接之前就保存过了，直接用它。');
    await handleConnectResult(
      await window.slurmate.connect({ connectionId: saved.connection.id }));
    // ★ 无论连上没连上，表单都收起来。
    //   此前没连上时会把表单再摆回来，用户看到的是「刚保存完又弹出一个新建连接」——
    //   像是什么都没存进去。这条连接已经在右上角下面的列表里了，它有「连接」「编辑」
    //   两个按钮；连不上时日志里那条错误会说清楚下一步该做什么。
    closeForm();
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
  // connected 是刚刚才定下来的，而连接列表在上面就已经渲染过了 ——
  // 补一次，否则自动接上会话时那一条不会显示「已连接」
  renderConnections(boot.connections);
  renderSnapshot(s || { state: 'idle', demo: boot.demo });
}

/** 连上列表里的某一条。点它就等于把它设为当前连接。 */
async function doConnectTo(c) {
  const r = await window.slurmate.setActiveConnection(c.id);
  if (!r.ok) return notice('error', r.error);
  boot.activeConnectionId = c.id;
  renderConnections(boot.connections);
  await handleConnectResult(await window.slurmate.connect({ connectionId: c.id }));
}

/**
 * 主动断开。
 *
 * ★ 断开 = **彻底终止**。还有会话的话先取消作业、释放资源，再拆连接。
 *   「断开」和「结束会话」在这里是同一件事的两种说法，因为对用户来说
 *   它们的意思本来就一样：我不要了。凡是用户主动表达的终止，都不该留下
 *   一个还在集群上占着资源的作业。
 *
 *   反过来，合盖/断网/断电时这个函数不会被调用 —— 那条路走守护进程的
 *   suspect/orphaned 容错窗口，客户端下次启动自动接回。
 */
async function doDisconnect() {
  const r = await window.slurmate.disconnect();
  if (!r || !r.ok) return notice('error', (r && r.error) || '断开失败。');
  connected = false;
  whoami = null;
  const rel = r.released;
  if (rel && !rel.ok) {
    notice('error', rel.detail);          // 释放没成功必须说，不能吞掉
  } else if (rel && rel.state === 'releasing') {
    notice('info', '已断开连接，并请求释放会话。请以状态条变为「已结束」为准。');
  } else {
    notice('info', '已断开与登录节点的连接。');
  }
  renderConnections(boot.connections);
  renderSnapshot({ state: 'idle', demo: boot.demo });
}

async function endSession() {
  const res = await window.slurmate.stop();
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
