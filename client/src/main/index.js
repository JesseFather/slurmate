'use strict';
/**
 * index.js —— 主进程入口。
 *
 * 职责：单实例锁、生命周期、后端选择、密钥与连接的管理、把 SessionController 和
 * ShellWindow 接起来、以及 code-server 的自动登录（POST /login + 查 cookie jar）。
 *
 * ── 身份体系：这里不认识任何 IDM ─────────────────────────────────────────────
 *
 * 客户端**不知道** FreeIPA / LDAP / Kerberos 的存在，也不该知道 —— 别的集群未必用
 * 这一套。它只知道「用户名 + 主机 + 端口 + 一把私钥」。首次使用时生成密钥、
 * 把公钥显示出来让用户自己去注册；改密码、设邮箱那些事归 IDM 自己的网页管，
 * 客户端从「账户已经配好了」开始。
 *
 * ── 密钥的纪律 ────────────────────────────────────────────────────────────
 *
 * **每条连接一把**，私钥由客户端生成并自托管。存法只有加密一种。
 *
 * 1. **有安全存储就直接加密存盘**，不打扰用户。
 * 2. **没有安全存储就留在内存里**，由界面如实说明 —— 绝不静默写明文。
 * 3. **读不出来的密钥绝不自动覆盖**。文件在但解不开（换机器、keyring 被重置）时，
 *    生成新密钥会让用户已经注册进 IDM 的那把静默失效，而症状只是「认证失败」。
 *    这种情况必须报错，让用户自己决定。
 * 4. **「没有」和「读不出来」必须分开。** 前者生成一把是安全的（没有东西可毁），
 *    后者生成一把就是在毁东西。`ensureKey` 只在 `not_saved` 时才生成。
 *
 * 「新建连接」这条路上还有一条特殊约定：密钥在**用户点保存之前**就生成好了
 * （存在 PENDING_ID 这个保留位上），因为用户必须先把公钥拿去 IDM 注册、
 * 回来再填地址。否则「保存并连接」的第一次尝试必然认证失败。
 *
 * ── 演示模式的三重互锁 ────────────────────────────────────────────────────
 * 做了假后端却不标注，正是这个项目一路在清的那类问题：**系统声称了不成立的事**。
 * 所以演示模式有：① 独立的配置命名空间（demo-config，绝不污染真配置）
 * ② 窗口标题与状态条用真实模式绝不会出现的颜色标注
 * ③ `--demo` 命令行开关。并且**绝不**在真实后端出错时静默退回演示。
 */

const { app, BrowserWindow, ipcMain, session: electronSession, safeStorage, shell, clipboard } = require('electron');
const path = require('path');

const config = require('./config.js');
const keys = require('./keys.js');
const hosts = require('./hosts.js');
const { createBackend } = require('./backend.js');
const { SessionController, State } = require('./session.js');
const { ShellWindow } = require('./windows.js');
const { installMenu, attachKeyGuard } = require('./shortcuts.js');
const { LOGIN_PATH, PASSWORD_FIELD, SESSION_COOKIE, loginSucceeded } = require('./login.js');

const DEMO_FLAG = process.argv.includes('--demo');

let win = null;
let backend = null;
let controller = null;
let cfgDir = null;
let cfg = null;
let whoami = null;
let partitions = [];
let quitting = false;

/**
 * 这台机器没有凭据库时，密钥只能留在内存里 —— 按 id 记着。
 *
 * 少了它，演示模式（safeStorage 不可用）下每连一次就会换一把钥匙，
 * 而用户明明刚从界面上把上一把复制去注册过。症状仍然只是「认证失败」。
 */
const memKeys = new Map();

// ── 单实例锁 ────────────────────────────────────────────────────────────────
// 满足「限制用户只能启动一次软件」。第二次启动时聚焦已有窗口，而不是开第二个。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.win.isDestroyed()) {
      if (win.win.isMinimized()) win.win.restore();
      win.win.focus();
    }
  });
  bootstrap();
}

function bootstrap() {
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    installMenu();

    // 演示模式用独立目录 —— 否则演示里配的用户名/端口会污染真连接
    cfgDir = DEMO_FLAG
      ? path.join(app.getPath('userData'), 'demo-config')
      : app.getPath('userData');
    cfg = config.loadConfig(cfgDir);

    // 旧版本（schema ≤ 3）只有一把**全局**私钥。搬到新格式：原样复制给每一条已有
    // 连接 —— 那正是升级前的事实，复制完每条的行为都不变，用户也不必重新去 IDM
    // 注册一遍。一条连接都没有时它会被留在原地，等有了第一条再搬。
    config.migrateLegacySecret(cfgDir, cfg.connections.map((c) => c.id));

    backend = createBackend({
      demo: DEMO_FLAG,
      demoConfig: {
        // 只影响演示后端「登记」要等多久，好让你（和测试）能看到排队态，
        // 或者反过来跳过它。真实后端完全不读这个。
        enrollDelayMs: Number.isFinite(Number(process.env.SLURMATE_DEMO_ENROLL_MS))
          ? Number(process.env.SLURMATE_DEMO_ENROLL_MS) : undefined,
      },
    });

    win = new ShellWindow({
      onClose: handleWindowClose,
      onAction: handleWindowAction,
    });

    // 快捷键拦截：黑名单 + 诊断。
    //
    // ★ 诊断**只装在演示模式**。它的用途是「验证按键到底有没有直达页面」，而那件
    //   事只在拿演示后端做对照时才需要看；真实模式里用户是在干活，不是在校验外壳。
    //   常开的代价很具体：每按一次带修饰键的键、每按一次 F 键都往日志里写一行，
    //   而按住 Ctrl 时操作系统会**连续**产生 keyDown —— 日志会被
    //   「已放行：Ctrl+Control」刷满，把真正要紧的消息顶掉。
    //   被我们**吞掉**的键（F12 之类）仍然照报：那是在解释「为什么按了没反应」，
    //   是用户自己触发的、想问的问题。
    attachKeyGuard(win.win.webContents, {
      onOwned: (action) => { if (action === 'reload') win.reloadCodeServer(); },
      onBlocked: (desc) => {
        win.pushNotice('key-blocked', desc);
        if (backend.kind === 'demo') win.pushSwallowed(desc);
      },
      ...(backend.kind === 'demo'
        ? { onSeen: (desc) => win.pushNotice('key-seen', desc) }
        : {}),
    });

    registerIpc();

    win.pushState(null);
    await announceBackend();

    // 启动时看看有没有「上次没关干净的会话」—— 自动接上，而不是让用户重新提交
    await tryReattach();
  });

  app.on('before-quit', async (e) => {
    if (quitting || !controller) return;
    quitting = true;
    e.preventDefault();
    win.setBusy(false);
    let res = { ok: true };
    try {
      res = await controller.stop();
    } catch (err) {
      res = { ok: false, detail: err.message };
    }
    if (!res.ok && controller.sessionId) {
      // 落盘待补发。**下次启动时补发** —— 这就是「跨崩溃的可靠投递」。
      // 注意：绝不用 process.on('exit') 做这件事，那里只能跑同步代码，发不出网络请求。
      config.addPendingGoodbye(cfgDir, controller.sessionId);
    }
    app.exit(0);
  });
}

// ── 密钥 ────────────────────────────────────────────────────────────────────

/** 「读不出来」的四种原因，各自该怎么跟用户说 —— 它们修法完全不同。 */
function keyErrorDetail(reason) {
  const tail = '重新生成会作废你已经注册到 IDM 的那把公钥 —— 请确认后再来。';
  if (reason === 'no_secure_storage') {
    return '本机保存过一把私钥，但这台机器现在没有可用的凭据库，解不开它。' + tail;
  }
  if (/^decrypt_failed/.test(reason)) {
    return '本机保存的私钥解密失败（凭据库可能被重置过）。' + tail;
  }
  if (/^bad_mode/.test(reason)) {
    return '本机保存的私钥文件格式无法识别。' + tail;
  }
  return '本机保存的私钥不可用。' + tail;
}

/**
 * 解析一条连接（或「新建」位）的密钥。**只读，不生成。**
 *
 * ★ 返回值的 error 字段把四种情况分开了，调用方必须区别对待：
 *     not_saved         → 确实还没有。生成一把是**安全**的（没有东西可毁）。
 *     no_secure_storage → 文件在，但这台机器没有凭据库，解不开 → 绝不覆盖
 *     decrypt_failed    → 文件在，但 keyring 变了 → 绝不覆盖
 *     bad_key_format    → 文件在，但内容不是我们能认的私钥 → 绝不覆盖
 *
 * @returns {{ok:true, privateKeyPem, publicKeyLine, fingerprint, persisted:boolean}
 *          | {ok:false, error:string, detail?:string}}
 */
function resolveKey(id) {
  const cached = memKeys.get(id);
  if (cached) return cached;

  const got = config.getKey(cfgDir, secureCrypto(), id);
  if (!got.ok) {
    if (got.reason === 'not_saved') return { ok: false, error: 'not_saved' };
    return { ok: false, error: got.reason, detail: keyErrorDetail(got.reason) };
  }

  // 旧版本允许「明文保存」，磁盘上可能有这么一份。既然已经读出来了，
  // 就别让它继续以明文躺着 —— 顺手加密重存。存不下去（这台机器没有凭据库）
  // 也不当作失败：密钥本身是可用的，为一件副产品把用户拦在门外不值当，
  // 记一个标记，由调用方如实告诉他。
  let legacyPlain = false;
  let migrated = false;
  if (got.legacy) {
    if (config.setKey(cfgDir, secureCrypto(), id, got.value).ok) migrated = true;
    else legacyPlain = true;
  }

  if (!keys.isUsablePrivatePem(got.value)) {
    return { ok: false, error: 'bad_key_format',
             detail: '本机保存的私钥无法解析。它可能被截断或改写过。' + keyErrorDetail('') };
  }
  const line = keys.publicKeyLineFromPrivatePem(got.value);
  if (!line) {
    return { ok: false, error: 'bad_key_format',
             detail: '本机保存的私钥推不出公钥。' + keyErrorDetail('') };
  }

  return {
    ok: true,
    privateKeyPem: got.value,
    publicKeyLine: line,
    fingerprint: keys.fingerprintOf(line),
    persisted: true,
    legacyPlain,
    migrated,
  };
}

/** 生成一把新密钥并尽量存下来。存不下来就留在内存里（见 memKeys）。 */
function generateKey(id) {
  const gen = keys.generate();
  const saved = config.setKey(cfgDir, secureCrypto(), id, gen.privateKeyPem);
  const info = {
    ok: true,
    privateKeyPem: gen.privateKeyPem,
    publicKeyLine: gen.publicKeyLine,
    fingerprint: gen.fingerprint,
    persisted: saved.ok,
    saveError: saved.ok ? null : saved.reason,
    generated: true,
  };
  // 缓存里**抹掉 generated**：那个标志的含义是「刚刚生成了一把，用户还没注册过」，
  // 只对产生它的那一次调用成立。留着它，同一条警告会在每次连接时重放一遍 ——
  // 而第二次起它已经不再是真的了。
  if (!saved.ok) memKeys.set(id, { ...info, generated: false });
  return info;
}

/**
 * 取密钥，**没有才生成**。
 *
 * 这条分界线是整个密钥管理的要害：「没有」生成是安全的，「读不出来」生成是在
 * 悄悄毁掉用户已经注册过的公钥，而症状只是「认证失败」，指不回根因。
 */
function ensureKey(id) {
  const r = resolveKey(id);
  if (r.ok) {
    // 旧版本留下的痕迹。只在真有这回事时才说话 —— 一条每次都出现的提示，
    // 和没有提示是一回事。
    if (r.migrated) win.pushNotice('info', '本机保存的私钥此前是明文，已改为加密保存。');
    if (r.legacyPlain) {
      win.pushNotice('warn',
        '本机保存的私钥仍是明文：这台机器没有可用的系统凭据库，加密存不了。'
        + '密钥可以正常使用，但它在磁盘上是可读的。');
    }
    return r;
  }
  if (r.error !== 'not_saved') return r;
  return generateKey(id);
}

/** 界面要的那几个字段。**不生成** —— 只有「新建」与「重新生成」两个入口才生成。 */
function keyView(id) {
  const r = resolveKey(id);
  if (!r.ok) {
    return {
      publicKey: null, fingerprint: null, persisted: false,
      error: r.error === 'not_saved' ? null : r.error,
      detail: r.detail || null,
      missing: r.error === 'not_saved',
    };
  }
  return {
    publicKey: r.publicKeyLine, fingerprint: r.fingerprint,
    persisted: r.persisted, error: null, detail: null, missing: false,
  };
}

/** 作废一条密钥、换一把新的。**必须由用户显式发起**（界面上带确认的按钮）。 */
function regenerateKey(id) {
  memKeys.delete(id);
  const info = generateKey(id);
  return {
    ok: info.persisted,
    reason: info.saveError,
    publicKey: info.publicKeyLine,
    fingerprint: info.fingerprint,
    persisted: info.persisted,
  };
}

// ── 后端选择与告知 ──────────────────────────────────────────────────────────
async function announceBackend() {
  if (backend.kind === 'demo') {
    // ★ 演示后端**也要** connect —— 它在那一步启动本地 HTTP 服务并分配端口。
    //   曾经这里在演示模式下提前 return，结果是 service_port 恒为 0，
    //   隧道目标变成 "127.0.0.1:0"，会话在「运行中」之后立刻报端口不合法。
    //   演示模式不等于「不需要初始化」。
    const res = await backend.connect({ user: 'demo', host: '127.0.0.1', port: 1 });
    if (res.ok) {
      whoami = res.whoami;
      await refreshPartitions();
    }
    win.pushNotice('demo', '演示模式 · 未连接集群');
    win.setTitle('Slurmate — 演示模式 · 未连接集群');
    return;
  }

  const conn = config.activeConnection(cfg);
  if (!conn) {
    // 一条连接都没配 —— 这是**真实状态**，不是错误。如实说出来，
    // 而不是显示一句笼统的「连接失败」让用户去猜。
    win.pushNotice('info', '还没有配置登录节点。请在下方填写用户名、主机与端口。');
    win.setTitle('Slurmate — 未配置连接');
    return;
  }
  await doConnect(conn);
}

/** 真正发起一次连接（含主机密钥裁决）。 */
async function doConnect(conn, extra = {}) {
  // 这条连接自己的那把私钥。没有就生成一把 —— 但**读不出来时绝不生成**
  // （见 ensureKey）：那会作废用户已经注册到 IDM 的公钥，而症状只是「认证失败」。
  const key = ensureKey(conn.id);
  if (!key.ok) {
    return { ok: false, code: 'key_unavailable', error: key.detail || key.error };
  }
  if (key.generated) {
    // 走到这儿说明配置里这条连接本来没有密钥（手改过配置，或从更旧的版本升上来）。
    // 新公钥用户还没注册过，所以这一次连接**注定**会认证失败 —— 与其让他自己
    // 从报错里猜，不如现在就说清楚。
    //
    // 只在「刚生成」这一次说：见 generateKey 里为什么缓存要抹掉这个标志。
    win.pushNotice('warn',
      `这条连接此前没有密钥，已生成一把新的（指纹 ${key.fingerprint}）。`
      + (key.persisted
        ? ''
        : '这台机器没有可用的系统凭据库，私钥存不下来 —— 关闭客户端后它会消失。')
      + '请先在「编辑」里复制它的公钥、注册到你的 IDM 账户，否则连不上。');
  }

  const res = await backend.connect(
    { user: conn.user, host: conn.host, port: conn.port },
    {
      privateKey: key.privateKeyPem,
      hostKeyCheck: (fp) => config.checkHostKey(cfg, conn.host, conn.port, fp).status,
      expectedHostKey: (config.checkHostKey(cfg, conn.host, conn.port, '') || {}).expected,
      ...extra,
    });

  if (res.ok) {
    whoami = res.whoami;
    await refreshPartitions();
    win.setTitle(`Slurmate — ${conn.user}@${conn.host}`);
  } else if (res.code === 'host_key_unknown' || res.code === 'host_key_changed') {
    // 主机密钥要用户拍板 —— 这不是「连接失败」，是一个待确认的安全决定。
    // 所以不设成 error 标题，界面会弹一个专门的确认框。
    win.setTitle('Slurmate — 等待确认主机密钥');
  } else {
    win.setTitle('Slurmate — 未连接');
  }
  return res;
}

async function refreshPartitions() {
  // op 名从 purposes 改成 partitions：新协议里不再有「用途」这一层，
  // 分区直接来自 Slurm（并与该用户的 association 求交）。
  const resp = await backend.rpc({ op: 'partitions' });
  partitions = (resp && resp.ok && resp.data && resp.data.partitions) || [];
  return partitions;
}

/**
 * 登录：POST /login，然后用 **cookie jar** 判定成败。
 *
 * ★ 绝不能看状态码。实测（code-server 4.135.0）：口令错误时返回的是 **HTTP 200**，
 *   只是没有 Set-Cookie。任何 `if (status === 200) 成功` 都会在口令错时报成功，
 *   然后用户看到一个「已登录但满屏登录页」的窗口。
 *
 * ★ 也绝不能解析响应头的 set-cookie：Electron `net` 模块在这件事上不可靠
 *   （electron#20631）。查 jar 既避开这个坑，又更贴近我们真正关心的问题 ——
 *   cookie 到底进没进去。
 */
async function performLogin(ses, origin, password) {
  if (!password) return { ok: false, reason: 'no_password' };
  let status = null;
  try {
    const res = await ses.fetch(origin + LOGIN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ [PASSWORD_FIELD]: password }).toString(),
      redirect: 'manual',
    });
    status = res.status;
  } catch (e) {
    return { ok: false, reason: 'fetch_failed: ' + e.message };
  }

  const cookies = await ses.cookies.get({ name: SESSION_COOKIE, url: origin });
  if (loginSucceeded(cookies)) return { ok: true, status };

  // 到这儿说明没拿到 cookie。可能是口令错，也可能是 code-server 升级改了端点或字段名。
  // 两者要分开告诉用户 —— 「密码不对」和「客户端版本不匹配」是完全不同的行动。
  return { ok: false, reason: 'no_cookie', status };
}

// ── 会话编排 ────────────────────────────────────────────────────────────────
async function startSession(resources) {
  if (!controller || [State.ENDED, State.ERROR, State.IDLE].includes(controller.state)) {
    controller = new SessionController({
      backend,
      slot: 1,
      onTunnelPort: (slot, port) => {
        // 端口要**持久化** —— 变了 origin 就变，code-server 存在 localStorage 里的
        // 编辑器布局会重置。记住它，下次还用同一个。
        config.setSlotPort(cfgDir, cfg, slot, port);
      },
    });
    controller.on('change', onSessionChange);
    controller.on('retarget', () => onSessionChange(controller.snapshot()));
  }

  const preferredPort = config.slotPort(cfg, 1);
  const snap = await controller.start(resources, { preferredPort });
  if (!snap) onSessionChange(controller.snapshot());
  return snap;
}

/**
 * 状态变化的唯一渲染入口。
 *
 * ★ 整体包 try/catch：这是一个 async 的**事件处理器**，抛出去就变成
 *   unhandledRejection —— 在 Electron 里表现为「界面某处悄悄不更新了」，
 *   而控制台里只有一条谁也不看的警告。宁可把它变成面板上看得见的一条错误。
 */
async function onSessionChange(snap) {
  try {
    await _renderSession(snap);
  } catch (e) {
    win.pushNotice('error', '更新界面时出错：' + e.message);
  }
}

async function _renderSession(snap) {
  win.pushState(snap);

  if (snap.state === State.RUNNING && snap.origin && !win.hasCodeView()) {
    await openCodeServer(snap);
  }
  if (snap.state === State.RUNNING && snap.warning) {
    await win.showOverlay(snap.warning);
    win.setBusy(true);
  } else if (snap.state === State.RUNNING) {
    win.hideOverlay();
    win.setBusy(false);
  }

  const titles = {
    [State.SUBMITTING]: '正在提交…',
    [State.QUEUED]: `排队中 — 作业 ${snap.jobId || ''}`,
    [State.RELEASING]: '正在释放…',
    [State.ENDED]: '已结束',
  };
  const demoPrefix = snap.demo ? '[演示] ' : '';
  win.setTitle(demoPrefix + 'Slurmate — ' + (titles[snap.state] || snap.node || '就绪'));
}

async function openCodeServer(snap) {
  // 演示模式下给 code-server 页面注入一个只读的小桥，用来接收「被外壳吞掉的按键」，
  // 好让你在同一屏里对照验证快捷键。**真实模式绝不注入** —— 那会污染 IDE。
  const partition = 'persist:slot-' + snap.slot;
  await win.showCodeServer(snap.origin, partition, snap.demo);

  const ses = win.codeSession;
  if (!ses) return;

  const password = controller.session && controller.session.auth_password;
  const authMode = (controller.session && controller.session.auth_mode) || 'password';

  if (authMode === 'none') {
    // auth_mode 可能是 none（配置改一行就能退回）。此时不要 POST /login。
    return;
  }

  const res = await performLogin(ses, snap.origin, password);
  if (res.ok) {
    win.pushNotice('ok', '已自动登录 code-server。');
    await win.reloadCodeServer();
  } else if (res.reason === 'no_cookie') {
    win.pushNotice('error',
      `自动登录失败（HTTP ${res.status}，未拿到会话 cookie）。`
      + `可能是会话口令已变化，或 code-server 升级后改动了登录端点。`);
  } else if (res.reason === 'no_password') {
    win.pushNotice('error',
      '控制节点还没返回会话口令。可能需要稍等片刻，或查看「状态」。');
  } else {
    win.pushNotice('error', '自动登录出错：' + res.reason);
  }
}

// ── 关闭 ────────────────────────────────────────────────────────────────────
/**
 * 关窗 = 结束会话并释放资源。
 *
 * **没有「保留作业」这条分支** —— 见 session.js 的 stop()：真正需要保住作业的
 * 是「客户端没能说上话」那种情况（断电、睡眠、网线被拔），而那些情况下这里的
 * 代码根本不会被执行到。能给这条分支投票的只有用户的主动点击，于是它只会误伤。
 */
async function handleWindowClose() {
  win.setBusy(false);
  try {
    if (controller) {
      const res = await controller.stop();
      if (!res.ok) {
        win.pushNotice('error', res.detail);
        if (controller.sessionId) config.addPendingGoodbye(cfgDir, controller.sessionId);
      }
    }
  } finally {
    // 后端的收尾也要做：演示后端有一个真的在监听的 HTTP 服务，
    // 不关的话进程里会留着一个没人管的监听套接字。
    try { await backend.close(); } catch { /* 尽力而为 */ }
  }
  win.forceClose();
  app.quit();
}

function handleWindowAction(action, payload) {
  if (action === 'renderer-gone') {
    win.pushNotice('error',
      `code-server 页面崩溃了（${payload && payload.reason}）。可以点「重新加载页面」恢复。`);
  }
}

// ── 重新接管上次的会话 ──────────────────────────────────────────────────────
/**
 * 启动时查一次 status（不带 session_id，守护进程会返回该 uid 最新的活跃会话）。
 * 有活着的会话就自动接上 —— 这正是「仅关闭窗口，保持作业运行」那条路的意义所在。
 */
async function tryReattach() {
  if (backend.kind === 'demo') return;
  if (!backend._conn) return;          // 没连上就别问了

  // 先把上次没发出去的 goodbye 补上
  for (const item of config.listPendingGoodbye(cfgDir)) {
    const resp = await backend.rpc({ op: 'goodbye', session_id: item.session_id });
    if (resp && (resp.ok || (resp.error && resp.error.kind === 'not_found'))) {
      config.removePendingGoodbye(cfgDir, item.session_id);
    }
  }

  const resp = await backend.rpc({ op: 'status' });
  if (!resp || !resp.ok) return;
  const s = resp.data && resp.data.session;
  if (!s || !s.tunnel_target) return;

  win.pushNotice('info', `发现仍在运行的会话（作业 ${s.job_id}），正在重新接上。`);
  controller = new SessionController({
    backend, slot: 1,
    onTunnelPort: (slot, port) => config.setSlotPort(cfgDir, cfg, slot, port),
  });
  controller.on('change', onSessionChange);
  controller.sessionId = s.session_id;
  controller.session = s;
  controller.state = State.RUNNING;
  const preferredPort = config.slotPort(cfg, 1);
  await controller._bringUpTunnel(preferredPort);
  await openCodeServer(controller.snapshot());
}

// ── IPC ─────────────────────────────────────────────────────────────────────
function registerIpc() {
  const send = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
    try { return await fn(...args); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // ★ 这里**不再有**公钥字段：密钥是按连接存的，界面在打开某条连接的表单时
  //   单独问（app:publicKey / app:newKey）。全局一份公钥的写法会让人以为
  //   「注册一次，所有连接都用它」—— 那是上一个版本的行为。
  send('app:bootstrap', async () => ({
    demo: backend.kind === 'demo',
    backendLabel: backend.label,
    connections: cfg.connections,
    activeConnectionId: cfg.activeConnectionId,
    // ★ 这里**不再有** connection（活动连接那条本身）：它此前唯一的用途是把地址
    //   预填进「新建」表单，而那个行为正是要删掉的（不改就保存 = 又存一条一样的）。
    whoami,
    partitions,
    // 方法名是 isEncryptionAvailable，不是 isAvailable。
    // 写错的表现是「明明有凭据库却报告没有」，用户会被误导去找一个不存在的开关。
    secureStorageAvailable: secureAvailable(),
    slotPort: config.slotPort(cfg, 1),
    version: app.getVersion(),
  }));

  send('app:probeHosts', async () => hosts.probeAll(cfg.connections));

  // ── 连接条目的增删改 ──
  send('app:saveConnection', async (input) => {
    // created=false 表示这条连接本来就在（同一个人、同一台主机、同一个端口）。
    // 界面据此说明「已存在，直接用它」，而不是让列表里悄悄多出一条一模一样的。
    const up = config.upsertConnection(cfg, input);
    if (!up) {
      return { ok: false, error: '连接信息不完整：用户名、主机、端口（1-65535）都必填。' };
    }
    if (up.conflict) {
      // 编辑时把地址改成了另一条已有的连接。两条同身份、各带一把密钥，
      // 界面完全看不出差别 —— 与其替用户挑一条，不如让他自己决定。
      const c = up.conflict;
      return {
        ok: false, code: 'duplicate',
        error: `已经有一条 ${c.user}@${c.host}:${c.port} 了（备注「${c.label}」）。`
             + '同一个人在同一台机器上只保留一条 —— 请改掉这里的地址，'
             + '或者先把那一条删掉。',
      };
    }

    if (up.created) {
      // 把「新建」时生成的那把密钥交给这条连接。
      // ★ 顺序要紧：密钥必须**先于**用户的第一次连接尝试就位，因为公钥得先拿去
      //   IDM 注册。所以它在用户点开「新建」时就已经生成好了（PENDING_ID 那个位）。
      //   这里绝不另生成一把 —— 那会作废用户可能已经注册好的那把。
      const pending = config.getKey(cfgDir, secureCrypto(), config.PENDING_ID);
      if (pending.ok) config.setKey(cfgDir, secureCrypto(), up.connection.id, pending.value);
      const mem = memKeys.get(config.PENDING_ID);
      if (mem) memKeys.set(up.connection.id, { ...mem });
      config.deleteKey(cfgDir, config.PENDING_ID);
      memKeys.delete(config.PENDING_ID);

      // 没有「新建位」的密钥，说明这是从更旧的版本上来的第一条连接 ——
      // 把旧格式那份全局密钥交给它，用户不必重新注册。
      if (!pending.ok && !mem) {
        config.migrateLegacySecret(cfgDir, [up.connection.id]);
      }
    }

    if (!cfg.activeConnectionId) cfg.activeConnectionId = up.connection.id;
    config.saveConfig(cfgDir, cfg);
    return {
      ok: true, connection: up.connection, created: up.created,
      connections: cfg.connections,
      key: keyView(up.connection.id),
    };
  });

  send('app:deleteConnection', async (id) => {
    cfg.connections = cfg.connections.filter((c) => c.id !== id);
    if (cfg.activeConnectionId === id) {
      cfg.activeConnectionId = cfg.connections[0] ? cfg.connections[0].id : null;
    }
    config.saveConfig(cfgDir, cfg);
    // 这条连接的密钥跟着走 —— 留着它既无用，又会在界面上留下一条看不见的凭据。
    // 两处都要清：落盘的那份，以及「这台机器没有凭据库」时留在内存里的那份。
    const gone = config.deleteKey(cfgDir, id).removed;
    const memGone = memKeys.delete(id);
    return {
      ok: true, connections: cfg.connections,
      activeConnectionId: cfg.activeConnectionId, keyDeleted: gone || memGone,
    };
  });

  send('app:setActiveConnection', async (id) => {
    if (!cfg.connections.some((c) => c.id === id)) {
      return { ok: false, error: '这条连接不存在。' };
    }
    cfg.activeConnectionId = id;
    config.saveConfig(cfgDir, cfg);
    return { ok: true, activeConnectionId: id };
  });

  // ── 连接 ──
  send('app:connect', async (payload) => {
    let conn = config.activeConnection(cfg);
    if (payload && payload.connectionId) {
      conn = cfg.connections.find((c) => c.id === payload.connectionId) || conn;
    }
    if (!conn) return { ok: false, error: '还没有配置登录节点。', code: 'no_connection' };

    // 显式点名要连哪一条，就是「这条是我要用的」。不跟着改的话，
    // 下次启动自动重连会连到另一台上去 —— 而用户完全看不出为什么。
    if (cfg.activeConnectionId !== conn.id) {
      cfg.activeConnectionId = conn.id;
      config.saveConfig(cfgDir, cfg);
    }

    const res = await doConnect(conn);
    return { ...res, whoami, partitions };
  });

  /**
   * 用户确认了一个新主机密钥。**记住它**再重连 —— 只记住用户确认的那一个指纹，
   * 不做「以后都信任这台主机」这种模糊承诺。
   */
  send('app:trustHostKey', async (fingerprint) => {
    const conn = config.activeConnection(cfg);
    if (!conn) return { ok: false, error: '还没有配置登录节点。' };
    if (!fingerprint || typeof fingerprint !== 'string') {
      return { ok: false, error: '缺少要信任的指纹。' };
    }
    config.rememberHostKey(cfgDir, cfg, conn.host, conn.port, fingerprint);
    const res = await doConnect(conn, { trustHostKey: fingerprint });
    return { ...res, whoami, partitions };
  });

  /**
   * 忘掉某台主机已记录的指纹（服务器重装后用）。
   * 刻意做成一个**显式**动作：默认路径上，指纹变了就是拒绝连接。
   */
  send('app:forgetHostKey', async () => {
    const conn = config.activeConnection(cfg);
    if (!conn) return { ok: false, error: '还没有配置登录节点。' };
    config.forgetHostKey(cfgDir, cfg, conn.host, conn.port);
    return { ok: true };
  });

  // ── 密钥（按连接）──
  //
  // 两个 id 位：某条连接的 id，或 PENDING_ID（「新建」表单上那把还没有归属的）。
  // null / 省略 = PENDING_ID。

  /** 把界面给的 id 归一：null 表示「新建位」。不存在则返回 null（由调用方报错）。 */
  const keyTarget = (payload) => {
    const id = payload && payload.connectionId;
    if (!id) return config.PENDING_ID;
    return cfg.connections.some((c) => c.id === id) ? id : null;
  };

  /**
   * 查一条密钥的公钥。**不生成** —— 界面上「看」这个动作不该产生副作用，
   * 否则用户点开编辑看一眼，就作废了别的东西。
   */
  send('app:publicKey', async (payload) => {
    const id = keyTarget(payload);
    if (!id) return { ok: false, error: '这条连接不存在。' };
    return { ok: true, key: keyView(id) };
  });

  /**
   * 「新建连接」时生成（或取回）那把还没有归属的密钥。
   *
   * ★ 生成发生在**用户填地址之前**：他要把公钥复制去 IDM 注册，回来才能连上。
   *   generated=false 表示这把是上次新建时留下的 —— 用户可能已经注册过它，
   *   界面据此说明「已经注册过就直接用」。绝不在这里无声地换一把。
   */
  send('app:newKey', async () => {
    const existed = Boolean(memKeys.get(config.PENDING_ID))
      || config.hasKey(cfgDir, config.PENDING_ID);
    const r = ensureKey(config.PENDING_ID);
    if (!r.ok) return { ok: false, error: r.detail || r.error };
    return {
      ok: true, generated: !existed,
      key: {
        publicKey: r.publicKeyLine, fingerprint: r.fingerprint,
        persisted: r.persisted, error: null, detail: null, missing: false,
      },
    };
  });

  send('app:copyPublicKey', async (payload) => {
    const id = keyTarget(payload);
    if (!id) return { ok: false, error: '这条连接不存在。' };
    const v = keyView(id);
    if (!v.publicKey) return { ok: false, error: v.detail || '这条连接还没有公钥。' };
    clipboard.writeText(v.publicKey);
    return { ok: true };
  });

  /**
   * 作废这条连接的密钥、换一把新的，并加密存盘。
   *
   * ★ 它会作废用户已经注册到 IDM 的那把公钥，一旦悄悄发生，表现只是「认证失败」，
   *   指不回根因。所以界面上是一个带确认的按钮，而这是唯一的生成入口。
   *   同理，密钥**读不出来**时也是走这里，不做任何自动覆盖。
   */
  send('app:regenerateKey', async (payload) => {
    const id = keyTarget(payload);
    if (!id) return { ok: false, error: '这条连接不存在。' };
    const r = regenerateKey(id);
    // 存不下去也要把新公钥给出去：用户此刻正需要把它注册到 IDM，
    // 至于「这台机器存不了」，由界面另外如实说明。
    return {
      ok: r.ok, reason: r.reason,
      key: {
        publicKey: r.publicKey, fingerprint: r.fingerprint,
        persisted: r.persisted, error: null, detail: null, missing: false,
      },
    };
  });

  /**
   * 主动断开与登录节点的连接。
   *
   * ★ 这也是**一次彻底的终止**：只要还有会话（哪怕它已经出错，作业却可能还在
   *   集群上跑着），就先把作业取消、资源释放掉，再拆连接。
   *   断开等于「我不要了」，不等于「我先走开，你继续烧着」。
   *
   *   注意它与「意外消失」的分工：断电、睡眠、网线被拔时这个方法根本不会被调用，
   *   那种情况靠守护进程的 suspect/orphaned 容错窗口兜底，客户端下次启动自动接回。
   */
  send('app:disconnect', async () => {
    let released = { ok: true, detail: '' };
    if (controller && controller.sessionId) {
      released = await controller.stop();
      // 释放失败要说出来。守护进程的 released 并不保证作业真的停了
      // （见 memory cluster-side-defects），所以不能在这里宣布成功。
      if (!released.ok) win.pushNotice('error', released.detail);
    }
    await backend.close();
    whoami = null;
    partitions = [];
    return { ok: true, released };
  });

  // ── 会话 ──
  send('app:partitions', async () => ({ ok: true, partitions: await refreshPartitions() }));

  send('app:start', async (resources) => {
    const snap = await startSession(resources);
    return { ok: Boolean(snap), snapshot: controller && controller.snapshot() };
  });

  send('app:state', async () => (controller ? controller.snapshot() : null));

  send('app:doctor', async () => {
    const resp = await backend.rpc({ op: 'doctor' });
    return resp;
  });

  // 只有一个语义：结束会话并释放资源。没有「保持作业运行」的开关。
  send('app:stop', async () => {
    if (!controller) return { ok: true };
    return controller.stop();
  });

  send('app:reload', async () => { await win.reloadCodeServer(); return { ok: true }; });

  send('app:openExternal', async (url) => { await shell.openExternal(url); return { ok: true }; });

  // 演示模式的调试控制 —— 复现那些在真机上极难复现的状态
  send('app:debug', async (what) => {
    if (backend.kind !== 'demo') return { ok: false, error: '仅演示模式可用' };
    if (what === 'daemon-down') backend.debugDaemonDown(20000);
    else if (what === 'tunnel-down') backend.debugTunnelDown(15000);
    else if (what === 'reap') backend.debugReap();
    else if (what === 'reset') backend.debugReset();
    else return { ok: false, error: '未知的调试动作' };
    return { ok: true };
  });
}

/** safeStorage 是否可用。任何异常都当作不可用 —— 宁可让用户手动选，也不要误判为可用。 */
function secureAvailable() {
  try {
    return typeof safeStorage.isEncryptionAvailable === 'function'
        && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 把 safeStorage 包成 config.js 期望的 {encrypt, decrypt}。不可用时返回 null。 */
function secureCrypto() {
  if (!secureAvailable()) return null;
  return {
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  };
}

module.exports = {
  performLogin,
  /**
   * 仅供测试使用的接缝。
   *
   * 为什么需要它：演示后端会起一个真的在监听的 HTTP 服务，测试进程如果关不掉它
   * 就不会退出（`node --test` 会一直等下去）。生产代码不依赖这里任何东西 ——
   * 生产路径靠 `handleWindowClose` / `before-quit` 里的 `backend.close()`。
   */
  _test: {
    getBackend: () => backend,
    getController: () => controller,
    getWindow: () => win,
    /** 一条连接的密钥（读不到就返回错误对象）。测试用它核对「按连接隔离」。 */
    getKey: (id) => resolveKey(id || config.PENDING_ID),
    getCfg: () => cfg,
    getCfgDir: () => cfgDir,
  },
};
