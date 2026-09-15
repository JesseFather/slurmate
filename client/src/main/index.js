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
const sshconfig = require('./sshconfig.js');
const { createBackend } = require('./backend.js');
const { SessionController, State } = require('./session.js');
const { ShellWindow } = require('./windows.js');
const { installMenu, attachKeyGuard } = require('./shortcuts.js');
const { LOGIN_PATH, PASSWORD_FIELD, SESSION_COOKIE, loginSucceeded } = require('./login.js');
const { SERVICE_CODE_SERVER, SERVICE_SSHD, SERVICE_UNKNOWN,
        SSH_ALIAS, serviceRoute } = require('./service.js');

const DEMO_FLAG = process.argv.includes('--demo');

let win = null;
let backend = null;
let controller = null;
let cfgDir = null;
let cfg = null;
let whoami = null;
let partitions = [];
/**
 * 服务端通报的**默认资源**（`{cpus, mem}`）。
 *
 * ★ 它是**管理员设定的策略**，不是用户偏好。所以界面只读地显示它，并且每次启动都
 *   用它 —— 靠的是提交时【省略】cpus/mem 字段让服务端填当下那份默认值，而不是把
 *   这里收到的值再发回去。两者不等价：管理员把默认从 2 核改成 4 核之后，回发旧值的
 *   客户端会把它永远钉死在 2 核，而「省略」永远拿到当下的默认。
 *   只有用户当场点开「高级选项」，才发明确值。
 *
 * ★ 服务端一直在 `op:partitions` 的响应里返回它（cluster/slurmate-sessiond:2080），
 *   而这里此前把它整个丢掉了 —— 于是界面只能把「2 核 / 8G」硬编码在文案里，
 *   管理员改了默认值，界面照样显示旧数字，而且没有任何地方会报错。
 */
let resourceDefaults = null;
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

/**
 * 取分区列表与默认资源。**不碰全局状态、不弹通知** —— 纯查询，好测。
 *
 * op 名从 purposes 改成 partitions：新协议里不再有「用途」这一层，
 * 分区直接来自 Slurm（并与该用户的 association 求交）。
 *
 * ★ 失败必须**说出来**。此前这里是 `resp.ok && resp.data.partitions || []` ——
 *   守护进程不可达或权限不足时静默得到空数组，界面于是显示「这台集群没有任何分区」，
 *   而真正的原因（连不上控制节点）一个字都没留下。用户会去查自己的分区权限，
 *   查一个根本不存在的问题。
 *
 * @returns {Promise<{ok:boolean, partitions:Array, defaults:object|null, error:string|null}>}
 */
async function loadPartitions() {
  let resp;
  try {
    resp = await backend.rpc({ op: 'partitions' });
  } catch (e) {
    return { ok: false, partitions: [], defaults: null,
             error: `取分区列表失败：${e.message}` };
  }
  if (!resp || !resp.ok) {
    const detail = (resp && resp.error && resp.error.detail) || '控制节点没有说明原因';
    return { ok: false, partitions: [], defaults: null,
             error: `取分区列表失败：${detail}` };
  }
  const data = resp.data || {};
  return { ok: true, partitions: data.partitions || [],
           defaults: data.defaults || null, error: null };
}

/** 刷新全局的分区列表与默认资源。失败时推一条 error 通知，并把 ok:false 传出去。 */
async function refreshPartitions() {
  const r = await loadPartitions();
  partitions = r.partitions;
  resourceDefaults = r.defaults;
  if (!r.ok && win) win.pushNotice('error', r.error);
  return r;
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

// ── 布局组 ──────────────────────────────────────────────────────────────────
//
// 一个组 = 一个本地端口 = 一个 origin = 一份 code-server 的编辑器布局。
// 模型与纯函数在 config.js 的「布局组」一节；这里只做编排：
// 谁指向谁、什么时候回收、回收时清理什么。

/** 当前活跃连接所属的布局组 id。没有连接时为 null。 */
function activeLayoutId() {
  const conn = config.activeConnection(cfg);
  return conn ? conn.layoutId : null;
}

/**
 * 这次会话该用哪个布局组。
 *
 * 有活跃连接就用它的组（正常路径）。但**演示模式一个连接都没有**，那里也必须能
 * 开会话 —— 所以退回到「已有的第一个组，没有就建一个」。
 * （pruneLayouts 对「一条连接都没有」的情形不回收，正是为了让这一步造出来的组
 *   能活过下一次 commitConfig，否则每次开会话都会换一个 partition。）
 */
function layoutForSession() {
  const id = activeLayoutId();
  if (id) return id;
  if (cfg.layouts[0]) return cfg.layouts[0].id;
  const layout = {
    id: config.newLayoutId(),
    name: config.nextLayoutName(cfg),
    port: config.nextLayoutPort(cfg),
  };
  cfg.layouts = [...cfg.layouts, layout];
  config.saveConfig(cfgDir, cfg);
  return layout.id;
}

/**
 * 保证这条连接落在一个**存在**的布局组里。
 *
 * 新建的连接默认落到**当前活跃连接所在的组**（用户拍板的行为）；
 * 那也为空时（第一条连接、或活跃连接指向的组已经没了）才给它建一个新的空白组。
 */
function ensureConnectionLayout(conn) {
  if (conn.layoutId && config.findLayout(cfg, conn.layoutId)) return conn.layoutId;

  const active = config.activeConnection(cfg);
  if (active && active.id !== conn.id && config.findLayout(cfg, active.layoutId)) {
    config.setConnectionLayout(cfg, conn.id, active.layoutId);
    return active.layoutId;
  }
  const layout = {
    id: config.newLayoutId(),
    name: config.nextLayoutName(cfg),   // 必须在入列之前算，否则会把自己算进去
    port: config.nextLayoutPort(cfg),
  };
  cfg.layouts = [...cfg.layouts, layout];
  config.setConnectionLayout(cfg, conn.id, layout.id);
  return layout.id;
}

/**
 * **所有会改变引用计数的改动都必须走这里**，而不是直接 config.saveConfig。
 * 漏掉一处的后果是某个组永远不被回收 —— 它占着一个端口和一份浏览器存储。
 *
 * 反过来，setLayoutPort / rememberHostKey / forgetHostKey 内部自己 saveConfig 是安全的：
 * 端口写回只可能发生在引用计数 ≥ 1 的组上，改主机密钥更与计数无关。**那不是漏改。**
 */
function commitConfig() {
  const { removed } = config.pruneLayouts(cfg);
  try {
    config.saveConfig(cfgDir, cfg);
  } catch (e) {
    // 界面显示「已保存」而磁盘上没写，正是这个项目一路在清的那类问题。
    win.pushNotice('error',
      '配置没能写入磁盘：' + e.message + '（本次改动重启后会丢失）');
  }
  for (const id of removed) clearLayoutStorage(id);
  return removed;
}

/**
 * 回收一个布局组之后的卫生清理。
 *
 * **不是正确性必需** —— partition 名永不复用，残留数据永远不会被新的组读到。
 * 是隐私：那个目录里躺着 code-server 的登录 cookie。
 *
 * ★ 有且只有一条致命前提：**绝不能对正在被 codeView 用着的那个 partition 做**。
 *   那会把用户当前的 IDE 连 cookie 带 localStorage 一起抽掉，而症状只是
 *   「页面莫名其妙坏了」。所以先跟窗口对一下现在用的是哪个。
 *
 * 不 await：删一个组不该因为磁盘慢而卡住界面。
 */
function clearLayoutStorage(layoutId) {
  const partition = config.partitionForLayout(layoutId);
  if (win && win.codePartition === partition) return;
  try {
    electronSession.fromPartition(partition).clearStorageData()
      .catch((e) => win.pushNotice('warn',
        `布局组已删除，但它的浏览器存储没能清干净（${e.message}）。`));
  } catch (e) {
    win.pushNotice('warn', `布局组已删除，但它的浏览器存储没能清干净（${e.message}）。`);
  }
}

// ── 会话编排 ────────────────────────────────────────────────────────────────
/**
 * 起一个会话。
 *
 * @param {object} resources 高级选项里的临时覆盖（见 session.js 的 start）
 * @param {'code-server'|'sshd'} serviceKind 这一次要哪种服务
 */
async function startSession(resources, serviceKind) {
  const relay = serviceKind === SERVICE_SSHD;
  // ★ 中转站**不分配布局组**：布局组是给浏览器用的（端口 = origin = 一份编辑器
  //   布局），而中转站没有浏览器。给它一个组只会凭空造出一个永远不会被创建的
  //   存储分区，并且让「运行中切布局」那条路去挪一个 ssh 隧道正在用的端口。
  const layoutId = relay ? null : layoutForSession();

  // 中转站要一把公钥交给作业。**先备好再提交** —— 没有它守护进程会拒绝这次提交
  // （code 2），而那要花掉一整趟往返。
  let sshPubkey = null;
  if (relay) {
    const home = relayHome();
    const k = sshconfig.ensureRelayKey(home);
    if (!k.ok) {
      win.pushNotice('error', `无法准备中转站用的密钥：${k.detail}`);
      return null;
    }
    sshPubkey = k.publicKeyLine;
    if (k.created) {
      win.pushNotice('info',
        `已为中转站生成一把一次性密钥，存在 ${sshconfig.pathsFor(home).identity}。`
        + '它只被写进你自己作业的 authorized_keys —— 任何登录入口都不认它，'
        + '所以要连进来仍然需要你自己那把 IDM 密钥。');
    }
  }

  // ★ RELEASING 也算「上一个会话已经完了」。不加它的话：断开之后 controller 停在
  //   releasing（stop() 连状态轮询都停了，它再也走不出去），而这里会**复用**那个
  //   controller，接着 controller.start() 抛「会话已在进行中」—— 于是「断开」成了
  //   一道单向门，用户必须重启客户端才能再开会话。
  //   让新会话拿一个新 controller 之后，若旧作业还没被守护进程收掉，用户会拿到
  //   服务端那句准确的「已有 1 个活跃会话（上限 1）」，而不是一句指不回根因的话。
  if (!controller
      || [State.ENDED, State.ERROR, State.IDLE, State.RELEASING].includes(controller.state)) {
    controller = new SessionController({
      backend,
      layoutId,
      onTunnelPort: (id, port) => {
        // 端口要**持久化** —— 变了 origin 就变，code-server 存在 localStorage 里的
        // 编辑器布局会重置。记住它，下次还用同一个。
        // （中转站走的是下面那条 onRelayPort，它的端口属于 ssh 配置，不进这里。）
        if (!id) return;                // 中转站没有布局组，没有东西可记
        config.setLayoutPort(cfgDir, cfg, id, port);
      },
      // 中转站的端口写进用户的 ssh 配置，不写进 config.json（见 sshconfig.js）。
      // 这里只需要「重新渲染一次」，配置由 ensureSshRelay 按当前端口重写；
      // 端口和主机公钥都没变时它会自己跳过（那正是它幂等的依据）。
      onRelayPort: () => onSessionChange(controller.snapshot()),
      // 端口顺移时必须跳过别的布局组占着的端口，否则两个组会声称同一个端口，
      // 每次启动谁先绑谁赢，布局在两个 origin 之间反复横跳。排除集里要**摘掉自己**，
      // 不然自己那个端口会被当成「别人的」而永远绑不上。
      //
      // 中转站的 layoutId 是 null，于是这里排除掉**全部**布局端口 —— 正是要的：
      // 它绝不能落到某个布局组的端口上。
      getExcludedPorts: () => config.usedLayoutPorts(cfg, controller && controller.layoutId),
    });
    controller.on('change', onSessionChange);
    controller.on('retarget', () => onSessionChange(controller.snapshot()));
  }
  // ★ 这里**没有** else 分支。走到 else 的唯一可能是「已经有一个会话在跑」，
  //   而那种情况下 controller.start() 会抛「会话已在进行中」—— 这正是双击
  //   「开始」时该有的表现。在 else 里顺手改一下运行中会话的 layoutId 是纯副作用：
  //   它会把这个正在跑的会话挪到另一个布局组上，而用户什么都没要求。

  const preferredPort = relay
    ? config.RELAY_PORT_BASE
    : config.layoutPort(cfg, layoutId);
  const snap = await controller.start(resources, {
    preferredPort, serviceKind: relay ? SERVICE_SSHD : SERVICE_CODE_SERVER, sshPubkey,
  });
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

  // 会话没有了（结束/出错/正在释放），或者压根还没起来：窗口里那个 code-server
  // 页面背后的服务器已经不存在了 —— 隧道在 stop() 的最开头就停了 —— 收起它，
  // 把窗口主体还给面板，而面板上正是「重新开始」那几个按钮。
  //
  // ★ RELEASING 也要算在内，而且它才是在真机上**最先到达**的那一个：stop() 发出
  //   goodbye 之后状态就是 releasing，而它要等下一次 status 轮询（60 秒）才可能
  //   变成 ended。只收 ENDED 的话，用户点了「结束会话」之后还要盯着一块打不开的
  //   页面最多一分钟。
  if ([State.RELEASING, State.ENDED, State.ERROR, State.IDLE].includes(snap.state)) {
    win.hideCodeView();
  }

  // ── 唯一的服务分派点 ──
  //
  // ★ 不分流的后果不是崩溃，而是**误导**：code-server 那条路会拿会话口令去
  //   POST 一个 SSH 端口，然后弹一句语义完全错误的「自动登录失败」；反过来
  //   中转站那边会去建一个 WebContentsView 加载一个根本不是说 HTTP 的端口。
  if (snap.state === State.RUNNING && snap.origin) {
    if (snap.serviceKind === SERVICE_SSHD) await ensureSshRelay(snap);
    else if (snap.serviceKind === SERVICE_CODE_SERVER) await ensureCodeServer(snap);
    else if (snap.serviceKind === SERVICE_UNKNOWN) await warnUnknownService(snap);
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

/**
 * 让窗口里的 code-server 视图与快照一致。**幂等**，每次状态变化都可以调。
 *
 * 判定三件事：视图在不在、origin 变没变、partition 变没变。
 * 前两者只需重新 loadURL；**第三者必须销毁重建** —— partition 是构造期属性
 * （见 windows.js 的 showCodeServer）。
 *
 * ★ 这是唯一的入口。windows.js 的 pushState 里那条「origin 变了就 loadURL」的
 *   自动 retarget 已经删掉了：它不换 partition、也不重跑登录，两条路并存必然分叉。
 */
async function ensureCodeServer(snap) {
  const partition = config.partitionForLayout(snap.layoutId);
  if (win.hasCodeView() && win.codeOrigin === snap.origin && win.codePartition === partition) {
    return;
  }
  const rebuild = win.hasCodeView() && win.codePartition !== partition;
  await openCodeServer(snap);
  if (rebuild) win.pushNotice('info', '已切换到新的布局组，编辑器页面已重新加载。');
}

// ── SSH 中转站 ──────────────────────────────────────────────────────────────
//
// 中转站**没有视图**：用户要用的东西（原生 VS Code Remote-SSH、codex）跑在他自己
// 的机器上，客户端这边唯一要做的事就是让 `ssh slurmate` 这个名字能连进来 ——
// 也就是维护那两个文件（见 sshconfig.js）。
//
// 于是「建立会话」这件事在这里的全部内容就是：写文件、告诉用户怎么用。

/**
 * 上一次**已经就服务本身通知过**的那组值（端口|用户名|主机公钥，或 unknown|会话 id）。
 *
 * 两件事靠它：值没变就不重写 ssh 配置、也不重复报同一条通知。
 * 状态变化是**频繁**的 —— 心跳告警、隧道重建、每次 status 回来都会走到渲染 ——
 * 没有这个去重，用户每 45 秒会收到一条一模一样的「中转站已就绪」，等于没有通知；
 * 顺带每次心跳都重写一遍 ssh 配置，白白惊动用户的同步/杀毒软件。
 */
let lastServiceNotice = null;

/**
 * 写 ssh 配置时用的「家目录」。
 *
 * ★ 演示模式**必须**落在它自己的配置目录里，绝不能碰真的 `~/.ssh/config` ——
 *   演示模式的一条硬纪律是「不产生任何真实副作用」（config.json 也是这么隔离的），
 *   而 `~/.ssh/config` 是用户**全部** ssh 都要经过的地方，比 config.json 严重得多。
 */
function relayHome() {
  return DEMO_FLAG ? cfgDir : app.getPath('home');
}

/**
 * 中转站就绪：把本地 ssh 配好。
 *
 * **幂等**，每次状态变化都会调（心跳告警、隧道重建都会触发）。所以：
 * 值没变就直接返回 —— 否则用户每 45 秒收到一条一模一样的通知，等于没有通知，
 * 而每次心跳都重写一遍 ssh 配置也是白白惊动用户的杀毒/同步软件。
 */
async function ensureSshRelay(snap) {
  const port = snap.localPort;
  if (!port) return;                       // 还没监听，还轮不到写配置

  // 登录节点上的用户名。用连接里那个 —— 它是用户亲手填的，而 whoami 要等一次
  // RPC 回来才有（重连上来时可能还没有）。
  const conn = config.activeConnection(cfg);
  const user = (conn && conn.user) || (whoami && whoami.user);
  if (!user) {
    win.pushNotice('error', '中转站已就绪，但不知道要用哪个用户名写 ssh 配置。');
    return;
  }

  const key = `${port}|${user}|${snap.sshHostKey || ''}`;
  if (lastServiceNotice === key) return;

  const home = relayHome();
  const inc = sshconfig.ensureInclude(home);
  const w = sshconfig.writeRelayConfig({
    home, port, user, hostKey: snap.sshHostKey,
  });

  if (!w.ok) {
    win.pushNotice('error',
      `中转站已就绪，但没能写出 ssh 配置（${w.detail || w.error}）。`
      + `你仍然可以直接连 127.0.0.1:${port} 使用它。`);
    return;
  }
  lastServiceNotice = key;

  // Include 没加上时**照样**把我们自己那份配置写好了：用户可以手工加那一行，
  // 也可以自己 ssh -F <路径>。但必须说出来 —— 不说的话他敲 `ssh slurmate` 会得到
  // 「Could not resolve hostname」，而根因是我们没能改他的文件。
  if (!inc.ok) {
    win.pushNotice('warn',
      `没能把 Include 加进 ${inc.path}（${inc.detail}）。`
      + `请手工在那个文件的**最上面**加一行：\nInclude ${sshconfig.pathsFor(home).config}`);
  } else if (inc.changed) {
    win.pushNotice('info',
      `已在 ${inc.path} 最上面加了一行 Include，指向 Slurmate 自己的 ssh 配置。`
      + '（只加了这一行，你原有的内容一个字都没动。）');
  }

  if (!w.strict) {
    win.pushNotice('warn',
      '这次没能拿到作业内 sshd 的主机公钥（控制节点没返回它 —— 守护进程可能还是'
      + '旧版本），本次连接按「首次信任」处理。它只影响第一次连接，之后会一直核对。');
  }

  win.pushNotice('ok',
    `SSH 中转站已就绪。在终端里执行 ssh ${SSH_ALIAS}，或用 VS Code 的远程连接填 `
    + `${SSH_ALIAS}（主机名就是这一个词，端口和用户名都已经配好了）。\n`
    + `会话结束前它一直有效；作业里的东西跑在作业的 cgroup 里，作业一停全部回收。`);
}

/**
 * 服务种类未知（守护进程明说不知道：会话是从 nft 规则恢复出来的）。
 *
 * ★ 这里**什么都不做**，正是要害。这台端口上跑的可能是 code-server 也可能是
 *   sshd，而两种做法用错都是系统在声称一件它并不知道的事：拿口令去 POST 一个
 *   SSH 端口，或者拿主机公钥去配一个 HTTP 端口。用户看到的是莫名其妙的报错，
 *   而根因（这个会话是别的进程提交的、我们没写过它的命令行）一个字都不在里面。
 *   所以如实说出来，并且**只留「结束会话」这一条路**。
 */
async function warnUnknownService(snap) {
  const key = `unknown|${snap.sessionId}`;
  if (lastServiceNotice === key) return;
  lastServiceNotice = key;
  win.pushNotice('warn',
    `这个会话的服务类型未知（作业 ${snap.jobId || '?'}）—— 它多半是别的进程提交的，`
    + '控制节点没有关于它的记录，所以客户端不知道该怎么连上去。\n'
    + '作业本身是正常的：你可以结束它，或者直接连 127.0.0.1 上看它到底是什么。');
}

async function openCodeServer(snap) {
  // 演示模式下给 code-server 页面注入一个只读的小桥，用来接收「被外壳吞掉的按键」，
  // 好让你在同一屏里对照验证快捷键。**真实模式绝不注入** —— 那会污染 IDE。
  // ★ partition 名按**布局组 id** 命名，不按端口。按端口命名会让「组 A 被回收后
  //   端口被新组 B 复用」时，B 的所谓「空白布局」继承 A 的 localStorage 与登录 cookie。
  const partition = config.partitionForLayout(snap.layoutId);
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
  // 「有没有连上」问后端，不去猜它的私有字段叫什么。
  // 此前这里写的是 `backend._conn` —— 那是 SSH 后端的内部名字，演示后端用的是
  // 另一个（`_connected`），于是这一行在演示模式下恒为真地提前返回；上面还有一行
  // `kind === 'demo'` 也直接 return。两重保险合起来，让整条「接上已有会话」的路
  // 在**唯一能测它的地方**完全不可达 —— 而「上次没关干净的会话」恰恰是演示后端
  // 存在的理由（真机上要造出这个状态极难）。
  if (!backend.connected) return;

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
  if (!s) return;                      // 没有活跃会话，正常路径

  // 中转站会话不走布局组（见 startSession）。这里**不需要**有连接也能接上，
  // 因为它的端口不是布局端口，没有「该用哪个组」这个问题。
  const relay = serviceRoute(s.service_kind) === SERVICE_SSHD;
  const layoutId = relay ? null : activeLayoutId();
  if (!relay && !layoutId) return;     // 没配置连接，接不上

  // ★ 还在排队（reserved/submitted）的会话**也必须接上**，哪怕它还没有 tunnel_target。
  //   此前这里写的是 `if (!s || !s.tunnel_target) return;` —— 于是「作业还在队列里」
  //   这种最需要说出来的情况反而完全看不见：界面照常显示「启动 code-server」，
  //   用户一点就提交了**第二个**作业，而第一个还在排队。这既正是「单一启动」要防的
  //   资源占用，又恰好是「换了电脑 / 上次没关干净」最常见的形态 —— 重启客户端时
  //   作业往往还没跑起来。
  //   （不带 session_id 的 status 返回的是 (reserved, submitted, enrolled, suspect,
  //     orphaned, releasing) 里最新的那条，所以走到这里的一定是「占着名额」的会话。）
  const queued = !s.tunnel_target;
  win.pushNotice('info', queued
    ? `发现一个还在排队的会话（作业 ${s.job_id}），正在重新接上。`
    : `发现仍在运行的会话（作业 ${s.job_id}），正在重新接上。`);

  controller = new SessionController({
    backend, layoutId,
    onTunnelPort: (id, port) => {
      if (!id) return;                 // 中转站没有布局组，没有东西可记
      config.setLayoutPort(cfgDir, cfg, id, port);
    },
    onRelayPort: () => onSessionChange(controller.snapshot()),
    getExcludedPorts: () => config.usedLayoutPorts(cfg, controller && controller.layoutId),
  });
  controller.on('change', onSessionChange);
  controller.sessionId = s.session_id;
  controller.session = s;

  const preferredPort = relay ? config.RELAY_PORT_BASE : config.layoutPort(cfg, layoutId);
  if (queued) {
    // 交给现成的状态机往下走：等登记 → 建隧道 → （回到 RUNNING 时 onSessionChange
    // 会自己把视图/ssh 配置建起来，界面标题也已经有「排队中 — 作业 N」那一档）。
    controller.state = State.QUEUED;
    await controller._afterSubmit({ preferredPort });
    return;
  }

  controller.state = State.RUNNING;
  await controller._bringUpTunnel(preferredPort);
  // ★ 走**同一个**渲染入口，而不是像以前那样直接调 openCodeServer。
  //   以前那条直路只服务 code-server 一种会话，而接上一个中转站会话时它会把
  //   隧道指向的 SSH 端口当成一个网页去加载。分派只有一个地方，就是 _renderSession。
  await onSessionChange(controller.snapshot());
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
    // 服务端通报的默认资源（管理员设定）。界面**只读地**显示它，并且提交时
    // 靠【省略】cpus/mem 来使用它 —— 不是把这两个数字发回去。理由见变量声明处。
    resourceDefaults,
    // 方法名是 isEncryptionAvailable，不是 isAvailable。
    // 写错的表现是「明明有凭据库却报告没有」，用户会被误导去找一个不存在的开关。
    secureStorageAvailable: secureAvailable(),
    // 布局组：**已推导**好的结构（每组带 members / refCount / soleOwnerId）。
    // 界面只渲染、不做推导 —— 它手里那份随时可能已经陈旧（另一条连接刚被删），
    // 而「切走这个组会不会把它删掉」必须由主进程说了算。
    // 注意与上面的 `partitions` 不是一个东西：那是 Slurm 的分区，同词不同义。
    layouts: config.layoutPlan(cfg),
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
    // 新连接要落进一个布局组 —— 默认是**当前活跃连接所在的组**，没有就建一个空白组。
    // 复用已有条目那条路径走不到这里（它的 layoutId 由 upsertConnection 原样带过来）。
    if (up.created) ensureConnectionLayout(up.connection);
    commitConfig();
    return {
      ok: true, connection: up.connection, created: up.created,
      connections: cfg.connections,
      layouts: config.layoutPlan(cfg),
      key: keyView(up.connection.id),
    };
  });

  send('app:deleteConnection', async (id) => {
    // ★ 正在跑的那条不许删。删掉它的后果不是「少一条配置」：它所属的布局组会
    //   引用计数归零 → 被回收 → 浏览器存储被清 —— 而用户当前的页面正在用那份存储。
    //   界面已经禁用了按钮，这里只是把它变成**权威**。
    if (controller && cfg.activeConnectionId === id
        && ![State.ENDED, State.ERROR, State.IDLE].includes(controller.state)) {
      return { ok: false, code: 'in_use', error: '这条连接正在使用中，请先断开再删除。' };
    }

    cfg.connections = cfg.connections.filter((c) => c.id !== id);
    if (cfg.activeConnectionId === id) {
      cfg.activeConnectionId = cfg.connections[0] ? cfg.connections[0].id : null;
    }
    // commitConfig 而不是 saveConfig：删掉最后一条指向它的连接之后，
    // 它的布局组引用计数归零，必须被回收（并清掉它的浏览器存储）。
    commitConfig();
    // 这条连接的密钥跟着走 —— 留着它既无用，又会在界面上留下一条看不见的凭据。
    // 两处都要清：落盘的那份，以及「这台机器没有凭据库」时留在内存里的那份。
    const gone = config.deleteKey(cfgDir, id).removed;
    const memGone = memKeys.delete(id);
    return {
      ok: true, connections: cfg.connections,
      activeConnectionId: cfg.activeConnectionId,
      layouts: config.layoutPlan(cfg), keyDeleted: gone || memGone,
    };
  });

  send('app:setActiveConnection', async (id) => {
    if (!cfg.connections.some((c) => c.id === id)) {
      return { ok: false, error: '这条连接不存在。' };
    }
    cfg.activeConnectionId = id;
    // 这里**不动引用计数**（连接还是指向原来那个组），所以直接 saveConfig 即可 ——
    // 不是漏改。
    config.saveConfig(cfgDir, cfg);
    return { ok: true, activeConnectionId: id };
  });

  // ── 布局组 ──
  /**
   * 把一条连接指到另一个布局组。
   *
   * `layoutId` 为空 = **新建一个空白组并落进去**，一次原子完成。单独建出来的组
   * 引用计数天然是 0，紧接着的 commitConfig 会把它当场回收，用户点了会没反应 ——
   * 所以不提供独立的「建组」通道。
   *
   * ★ 步骤顺序是刻意钉死的：**先做会失败的那一步（换端口），成功了才动配置**。
   *   反过来的话，一旦换端口失败，配置说「在 B 组」而窗口还跑在 A 组的 origin 上，
   *   而 A 组的引用计数已经是 0 → 会被回收 → 浏览器存储被清 ——
   *   **把用户当前的页面连同登录 cookie 一起抽掉**。这是整块改动里最危险的路径。
   */
  send('app:setConnectionLayout', async (payload = {}) => {
    const { connectionId, layoutId, confirmDiscard } = payload;
    const conn = cfg.connections.find((c) => c.id === connectionId);
    if (!conn) return { ok: false, error: '这条连接不存在。' };

    let target = layoutId ? config.findLayout(cfg, layoutId) : null;
    if (layoutId && !target) return { ok: false, error: '这个布局组不存在。' };
    if (!target) {
      target = {
        id: config.newLayoutId(),
        name: config.nextLayoutName(cfg),
        port: config.nextLayoutPort(cfg),
      };
    }
    if (target.id === conn.layoutId) {
      return { ok: true, layouts: config.layoutPlan(cfg), connections: cfg.connections };
    }

    // 切走之后旧组的引用计数会归零 —— 也就是被删除。这正是「独占」那行提示要说的事。
    // ★ 判定权在这里，不在界面：界面手里那份 refCount 随时可能已经陈旧
    //   （另一条连接刚被删），它只负责弹确认。
    const old = config.layoutPlan(cfg).find((l) => l.id === conn.layoutId);
    if (old && old.soleOwnerId === conn.id && !confirmDiscard) {
      return {
        ok: false, code: 'would_discard',
        layoutId: old.id, layoutName: old.name,
        error: `「${old.name}」只有这一条连接在用，切走之后它会被删除。`,
      };
    }

    const existed = Boolean(config.findLayout(cfg, target.id));
    if (!existed) cfg.layouts = [...cfg.layouts, target];   // 只为算排除集，还没落盘

    const isActive = cfg.activeConnectionId === connectionId;
    const sessionLive = controller
      && ![State.ENDED, State.ERROR, State.IDLE].includes(controller.state);
    // ★ 中转站会话**不参与布局**：它的端口是我们自己的 (RELAY_PORT_BASE)，不在任何
    //   布局组里。让它走下面那条 relisten，就会去挪一个用户正在用 ssh 连着的端口 ——
    //   而 ssh 配置里那一行是我们在隧道起来时才写的，挪完端口那一瞬间
    //   `ssh slurmate` 连的是一个没人监听的端口。所以这里只改配置、不动会话。
    const relayLive = sessionLive && controller.serviceKind() === SERVICE_SSHD;

    if (isActive && controller && sessionLive && !relayLive) {
      const excluded = config.usedLayoutPorts(cfg, target.id);
      const r = await controller.relisten(target.id, target.port, excluded);
      if (!r.ok) {
        if (!existed) cfg.layouts = cfg.layouts.filter((l) => l.id !== target.id);
        return {
          ok: false, code: 'relisten_failed',
          error: '换端口失败，布局组没有改动：' + r.error,
        };
      }
      target.port = r.port;                 // 可能顺移过
    } else if (isActive && controller && !relayLive) {
      controller.setLayout(target.id);      // 没有会话在跑：只改标记，下次开会话就用它
    }
    // relayLive 时两条都不走：配置照改（下次起 code-server 就用新组了），
    // 但这个正在跑的中转站会话不受任何影响 —— 它的 layoutId 保持 null。

    config.setConnectionLayout(cfg, connectionId, target.id);
    commitConfig();
    return { ok: true, layouts: config.layoutPlan(cfg), connections: cfg.connections };
  });

  /** 给布局组改名。名字只是给人看的 —— 身份永远是 id（它决定 partition，绝不复用）。 */
  send('app:renameLayout', async (payload = {}) => {
    const { layoutId, name } = payload;
    if (!config.findLayout(cfg, layoutId)) {
      return { ok: false, error: '这个布局组不存在。' };
    }
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return { ok: false, error: '名字不能为空。' };
    cfg.layouts = cfg.layouts.map((l) => (l.id === layoutId ? { ...l, name: clean } : l));
    commitConfig();
    return { ok: true, layouts: config.layoutPlan(cfg) };
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
    return { ...res, whoami, partitions, resourceDefaults };
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
    return { ...res, whoami, partitions, resourceDefaults };
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
    resourceDefaults = null;      // 断开之后就没有「服务端通报的默认值」可谈了
    return { ok: true, released };
  });

  // ── 会话 ──
  // ok 现在**如实反映查询本身成不成功**（此前恒为 true，失败被吞成空分区列表）。
  // partitions 仍然是数组，空数组表示「取不到」而不是「没有分区」—— 区别在 error 里。
  send('app:partitions', async () => {
    const r = await refreshPartitions();
    return { ok: r.ok, partitions: r.partitions,
             resourceDefaults: r.defaults, error: r.error };
  });

  /**
   * 起一个会话。
   *
   * @param {object} resources 高级选项的临时覆盖（可省略字段，由服务端填默认值）
   * @param {'code-server'|'sshd'} [serviceKind] 省略 = code-server，
   *   与这个参数存在之前的行为一致 —— 老的界面调用（只传 resources）不会因此变样。
   */
  send('app:start', async (resources, serviceKind) => {
    const snap = await startSession(resources, serviceKind);
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
    /**
     * 重跑「启动时接上已有会话」那条路（`tryReattach`）。
     *
     * 它只在启动时被调用一次，所以不重新触发就没法验证。先把 controller 清掉是
     * **还原现场**而不是绕过什么 —— 启动那一刻它本来就是 null。
     */
    reattach: () => { controller = null; return tryReattach(); },
  },
};
