'use strict';
/**
 * index.js —— 主进程入口。
 *
 * 职责：单实例锁、生命周期、后端选择、把 SessionController 和 ShellWindow 接起来、
 * 以及登录（POST /login + 查 cookie jar）。
 *
 * ── 演示模式的三重互锁 ─────────────────────────────────────────────────────
 * 做了假后端却不标注，正是这个项目一路在清的那类问题：**系统声称了不成立的事**。
 * 所以演示模式有：
 *   ① 独立的配置命名空间（demo-config，绝不污染真配置）
 *   ② 窗口标题与状态条用真实模式绝不会出现的颜色标注
 *   ③ `--demo` 命令行开关，或真实后端未实现时的明确降级
 * 并且**绝不**在真实后端"出错"时静默退回演示 —— 那才是最坏的情况。
 */

const { app, BrowserWindow, ipcMain, session: electronSession, safeStorage, shell } = require('electron');
const path = require('path');

const config = require('./config.js');
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
let purposes = [];
let quitting = false;

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

    // 快捷键拦截：黑名单 + 诊断。演示模式下把被吞掉的键回灌给对面页面，便于对照验证。
    attachKeyGuard(win.win.webContents, {
      onOwned: (action) => { if (action === 'reload') win.reloadCodeServer(); },
      onBlocked: (desc) => {
        win.pushNotice('key-blocked', desc);
        if (backend.kind === 'demo') win.pushSwallowed(desc);
      },
      onSeen: (desc) => win.pushNotice('key-seen', desc),
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
      res = await controller.farewellOnQuit();
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

// ── 后端选择与告知 ──────────────────────────────────────────────────────────
async function announceBackend() {
  // ★ 演示后端**也要** connect —— 它在那一步启动本地 HTTP 服务并分配端口。
  //   曾经这里在演示模式下提前 return，结果是 service_port 恒为 0，
  //   隧道目标变成 "127.0.0.1:0"，会话在「运行中」之后立刻报端口不合法。
  //   演示模式不等于「不需要初始化」。
  const res = await backend.connect(cfg.profile);

  if (!res.ok) {
    win.pushNotice('error', res.error || '无法连接登录节点');
    win.setTitle('Slurmate — 未连接');
    return;
  }

  whoami = res.whoami;
  await refreshPurposes();

  if (backend.kind === 'demo') {
    // 三重互锁之二：标题用真实模式绝不会出现的标注
    win.pushNotice('demo', '演示模式 · 未连接集群');
    win.setTitle('Slurmate — 演示模式 · 未连接集群');
  }
}

async function refreshPurposes() {
  const resp = await backend.rpc({ op: 'purposes' });
  if (resp && resp.ok) {
    purposes = resp.data.purposes || [];
  } else {
    purposes = [];
  }
  return purposes;
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
async function startSession(purpose) {
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
  const snap = await controller.start(purpose, { preferredPort });
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
async function handleWindowClose(mode) {
  win.setBusy(false);
  try {
    if (controller) {
      const res = await controller.stop({ farewell: mode === 'farewell' });
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

  send('app:bootstrap', async () => ({
    demo: backend.kind === 'demo',
    backendLabel: backend.label,
    profile: cfg.profile,
    whoami,
    purposes,
    addressTable: hosts.effectiveHosts(cfg.extraHosts),
    savePasswordMode: cfg.passwordMode,
    // 方法名是 isEncryptionAvailable，不是 isAvailable。
    // 写错的表现是「明明有凭据库却报告没有」，用户会被误导去选明文保存。
    secureStorageAvailable: secureAvailable(),
    slotPort: config.slotPort(cfg, 1),
    version: app.getVersion(),
  }));

  send('app:probeHosts', async () => hosts.probeAll(hosts.effectiveHosts(cfg.extraHosts)));

  send('app:connect', async (profile) => {
    cfg.profile = { ...cfg.profile, ...profile };
    config.saveConfig(cfgDir, cfg);
    const res = await backend.connect(cfg.profile);
    if (res.ok) {
      whoami = res.whoami;
      await refreshPurposes();
    }
    return { ...res, purposes, whoami };
  });

  send('app:purposes', async () => ({ ok: true, purposes: await refreshPurposes() }));

  send('app:start', async (purpose) => {
    const snap = await startSession(purpose);
    return { ok: Boolean(snap), snapshot: controller && controller.snapshot() };
  });

  send('app:state', async () => (controller ? controller.snapshot() : null));

  send('app:doctor', async () => {
    const resp = await backend.rpc({ op: 'doctor' });
    return resp;
  });

  send('app:stop', async (mode) => {
    if (!controller) return { ok: true };
    const res = await controller.stop({ farewell: mode !== 'keep' });
    return res;
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

  // 口令存储：绝不静默降级。安全存储不可用时由界面问用户。
  send('app:savePassword', async ({ mode, password }) => {
    const res = config.setPassword(cfgDir, secureCrypto(), mode, password);
    if (res.ok) { cfg.passwordMode = mode; config.saveConfig(cfgDir, cfg); }
    return res;
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
  },
};
