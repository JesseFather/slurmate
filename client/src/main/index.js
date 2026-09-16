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

const { app, BrowserWindow, dialog, ipcMain, session: electronSession, safeStorage, shell, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

const config = require('./config.js');
const keys = require('./keys.js');
const hosts = require('./hosts.js');
const { createBackend } = require('./backend.js');
const { SessionController, State } = require('./session.js');
const { ShellWindow } = require('./windows.js');
const { installMenu, attachKeyGuard } = require('./shortcuts.js');
const weblogin = require('./weblogin.js');
const plugins = require('./plugins/index.js');
const pluginInstall = require('./plugins/install.js');
const sitePluginSync = require('./site-plugins.js');
// ★ 从模块上摘下来，而不是在函数里写 `plugins.shortDigest` —— `pluginsView()` 里
//   有一个同名的局部数组（那些插件记录），函数内写 `plugins.` 会指到它身上。
const shortDigest = plugins.shortDigest;

const DEMO_FLAG = process.argv.includes('--demo');

let win = null;
let backend = null;
let controller = null;
let cfgDir = null;
let cfg = null;
let whoami = null;
let partitions = [];
/**
 * 本站点的插件清单，来自 `op_plugins`。`null` = 还没问到（或守护进程太旧，
 * 不支持这个 op）—— 那时按"站点没说"处理，而不是当成"一个都没有"。
 *
 * ★ 界面上的按钮由**四个条件的求交**决定：客户端扫到的插件 ∩ 站点装着且开着 ∩
 *   用户在本机没关掉 ∩ 站点为它装了作业侧。所以见 pluginsView() —— 那里把条件
 *   分别报给界面、由界面决定怎么画，而不是在这里合并成一个布尔。
 *
 *   四个条件来自**三方**（客户端 / 站点 / 用户），其中站点占了两个 —— 而那两个
 *   要做的**事**不一样（一个是管理员的开关，一个是部署有没有跟上），所以界面上
 *   也必须是两句不同的话。
 */
let sitePlugins = null;
let quitting = false;

/**
 * 上一次站点对账的结果。`null` = 还没同步过。
 *
 * ★ 它是**三态**的载体，别把它压成一个布尔：`supported: false` 与
 *   `supported: true && failed.length` 是两件完全不同的事（一个是"这个站点的
 *   守护进程太旧"，一个是"它答应发但这次没发成"），而"本机没有这个插件"在界面上
 *   长得都一样。压成一个布尔之后，后两种会被合并成一句笼统的"同步失败"。
 */
let siteSync = null;

/**
 * 待同意的那些（暂存树还在磁盘上，等用户点）。
 *
 * ★ 换连接、断开、重新对账都会把它清掉 —— 它描述的是**这一次连接**的现场。
 */
let pendingConsent = [];

/**
 * 连接世代号。**世代守卫**：用户在下载途中切连接/断开，下载回调仍在跑，
 * 最后 `reload()` 一次 —— A 站点的插件会被当成 B 站点的写进台账。每次对账
 * 带一个世代号，回调里比对，不匹配整个丢弃。
 */
let connectGeneration = 0;

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

    // ★ 池目录依赖 cfgDir（演示模式尤其），而注册表是在**模块加载期**建的，那时
    //   cfgDir 还是 null。所以拿到真路径之后重新扫一遍 —— 否则演示模式会去读
    //   进程当前目录下的 `./plugins`，而那是谁的地方说不清。
    //
    // 建目录在前：**装第一个插件之前，用户得先有个地方放它**，而"池在哪"这个
    // 问题的答案不能是一个不存在的路径。
    ensurePoolDir();
    registry.reload();

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
        // ★ 演示站点的**分发源** = 仓库里的 `plugins/`。那是一份**独立于本机池**
        //   的真实文件（真的 sha256、真的字节），于是「站点有而本机没有」这条最
        //   重要的路径在演示里真的走得到：池空 + 开发者模式关着，站点照样报两个
        //   插件，对账真的把它们取下来、真的要求同意。
        //   打包之后没有仓库目录 ⇒ 返回 null ⇒ 站点回落到"只报池里那些，且不发
        //   文件"，界面会说明这一点。
        sitePluginDir: () => {
          const d = path.join(__dirname, '..', '..', '..', 'plugins');
          try { return fs.statSync(d).isDirectory() ? d : null; } catch { return null; }
        },
        // ★ 演示站点报哪些插件，兜底那份 = **本机池里装了什么**。只在仓库目录
        //   不存在时才用得上（打包版）。传函数而不是快照：用户可以在演示进行中
        //   装/卸插件，站点的清单应该跟着变。
        sitePlugins: () => registry.list().map((p) => ({
          id: p.id, name: p.name, version: p.version,
          displayName: p.displayName,
          surface: p.contributes.surface,
          submitPubkey: p.contributes.submitPubkey,
          login: p.contributes.login,
        })),
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
      onOwned: (action) => { if (action === 'reload') win.reloadSurface(); },
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
      // 演示站点也真的走一遍分发（分发源是仓库里的 `plugins/`，见 backend-fake）。
      reconcileSitePlugins();
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
  // ★ 先把世代号推一格：上一次连接的插件对账可能还在后台取文件，而它带回来的
  //   东西属于**上一个**站点。见 reconcileSitePlugins 的世代守卫。
  connectGeneration += 1;
  pendingConsent = [];
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
    // 站点分发：连上之后才开始，**不 await**（理由见 reconcileSitePlugins）。
    reconcileSitePlugins();
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
 * @returns {Promise<{ok:boolean, partitions:Array, error:string|null}>}
 */
async function loadPartitions() {
  let resp;
  try {
    resp = await backend.rpc({ op: 'partitions' });
  } catch (e) {
    return { ok: false, partitions: [], error: `取分区列表失败：${e.message}` };
  }
  if (!resp || !resp.ok) {
    const detail = (resp && resp.error && resp.error.detail) || '控制节点没有说明原因';
    return { ok: false, partitions: [], error: `取分区列表失败：${detail}` };
  }
  return { ok: true, partitions: (resp.data && resp.data.partitions) || [], error: null };
}

/**
 * 取本站点的插件清单（`op_plugins`）。
 *
 * ★ **它失败不是错误**，所以这里不推通知：守护进程比客户端旧时（v0.2 及以前）
 *   根本没有这个 op，会回 `unknown_op`。那时按"站点没说"处理 —— 界面回落到
 *   "只画客户端自己认识、且用户没关掉的那些"，也就是这次升级之前的行为。
 *   为一件"你的服务端版本旧"弹一条 error，是把升级的节奏问题说成故障。
 *
 * @returns {Promise<{ok:boolean, plugins:Array|null, error:string|null}>}
 */
async function loadPlugins() {
  let resp;
  try {
    resp = await backend.rpc({ op: 'plugins' });
  } catch (e) {
    return { ok: false, plugins: null, error: e.message };
  }
  if (!resp || !resp.ok) {
    const detail = (resp && resp.error && resp.error.detail) || '控制节点没有说明原因';
    return { ok: false, plugins: null, error: detail };
  }
  return { ok: true, plugins: (resp.data && resp.data.plugins) || [], error: null };
}

/**
 * 刷新全局的分区列表与插件清单。
 *
 * ★ 分区失败要**说出来**（此前 `resp.ok && resp.data.partitions || []` 会把失败
 *   静默成一个空列表，界面显示「这台集群没有任何分区」—— 一句系统并不知道的话）。
 *   插件失败则不必，理由见 loadPlugins()。
 */
async function refreshPartitions() {
  const r = await loadPartitions();
  partitions = r.partitions;
  if (!r.ok && win) win.pushNotice('error', r.error);

  const p = await loadPlugins();
  // null（问到但站点没返回清单 / 问不到）与 []（站点真的一个插件都没有）不同，
  // 但对界面是同一件事：没有站点信息可用。留 null 让调用方能分辨。
  sitePlugins = p.ok ? { plugins: p.plugins || [] } : null;
  return r;
}

// ── 站点分发 ────────────────────────────────────────────────────────────────

/** 上一次对账的 promise。**只给测试用**（真机上没人等它）。 */
let siteSyncPromise = null;

/**
 * 和站点对一次账：把该分发的插件取下来、该回收的回收。
 *
 * ★ **不挂在 `refreshPartitions()` 旁边。** 那是热路径（`doConnect` / `app:connect` /
 *   `app:partitions` 都调它），界面每刷一次分区就会跑一遍全目录哈希。这里只在
 *   **每次连接一次**。
 *
 * ★ **不 await**：真集群上每一份文件都是一次独立的 `ssh` exec，十几份就是几秒 ——
 *   让"连接"这个动作卡在插件下载上，是把一个后台的事变成前台的事。跑完推一份
 *   新的视图给界面（见 `pushPlugins`）。
 *
 * ★ **下载失败绝不回退到本机池**（见 site-plugins.js 的文件头）。开发者模式的开关
 *   是**用户的设置**，不是站点的能力 —— 关着的时候一个插件都没有，那是正确的、
 *   必须如实说出来的结果。
 */
function reconcileSitePlugins() {
  const gen = ++connectGeneration;
  siteSyncPromise = (async () => {
    const conn = config.activeConnection(cfg);
    if (!conn || !backend || !backend.connected) return null;
    const key = sitePluginSync.siteKeyOf(conn);
    const label = sitePluginSync.siteLabelOf(conn);
    const siteRoot = ensureSitePoolDir();
    const stagingRoot = siteStagingDir();
    if (!siteRoot || !stagingRoot) {
      siteSync = { supported: false, reason: 'no_dir', syncedAt: Date.now(), label,
                   error: '本机建不出站点插件目录，所以这个站点的插件装不下来。' };
      return siteSync;
    }

    let r;
    try {
      r = await sitePluginSync.sync({
        rpc: (req) => backend.rpc(req),
        siteKey: key,
        siteLabel: label,
        siteRoot,
        stagingRoot,
        trusted: (id, version, digest) => config.isTrusted(cfg, id, version, digest),
        generation: gen,
        stale: () => gen !== connectGeneration,
        // ★ 「文件都下来了」**不等于**「装上了」：`reload()` 从不抛，坏插件进
        //   `errors`。所以换入之后逐个复查 —— 拿得到才算成功。
        verify: (landed) => {
          if (gen !== connectGeneration) return [];
          registry.reload();
          const failed = [];
          for (const e of landed) {
            const p = registry.get(e.id, e.version);
            if (!p) {
              failed.push({ ...e, why: '文件都下来了，但注册表没有收下它 —— '
                + '多半是清单或客户端代码不合法，看下面「插件没有加载」那几条。' });
            } else if (p.active === false) {
              failed.push({ ...e, why: '文件都下来了，但它的代码还没有经过你的同意。' });
            }
          }
          return failed;
        },
      });
    } catch (e) {
      siteSync = { supported: false, reason: 'internal', syncedAt: Date.now(), label,
                   error: `站点插件对账时出错：${e.message}` };
      win && win.pushNotice('error', siteSync.error);
      return siteSync;
    }

    // ★ 世代守卫：连接已经换了一条 ⇒ 这一次的结果整个丢弃（界面上的东西也会被
    //   下一次对账覆盖），一个通知都不推。
    if (gen !== connectGeneration) return null;

    pendingConsent = r.pendingConsent || [];
    siteSync = {
      supported: r.supported,
      reason: r.reason,
      error: r.error,
      label,
      key,
      syncedAt: Date.now(),
      limits: r.limits,
      added: r.added, kept: r.kept, reclaimed: r.reclaimed, failed: r.failed,
      recordOk: Boolean(r.record && r.record.ok),
      recordWhy: (r.record && r.record.why) || null,
      notices: r.notices || [],
    };

    if (r.error) win && win.pushNotice('warn', r.error);
    for (const n of (r.notices || [])) win && win.pushNotice('warn', n);
    for (const f of (r.failed || [])) {
      win && win.pushNotice('error', `没能装上「${f.title || f.name || f.id}」：${f.why}`);
    }
    if (r.reclaimed && r.reclaimed.length) {
      win && win.pushNotice('info',
        `站点不再需要的 ${r.reclaimed.length} 个插件版本已经清掉了。`);
    }
    if (pendingConsent.length) {
      win && win.pushNotice('warn',
        `本站要给你 ${pendingConsent.length} 个插件，每一个都要你先点一下同意`
        + '（它们的客户端代码会在你这台机器上运行）。见插件那一栏。');
    }
    win && win.pushPlugins(pluginsView());
    return siteSync;
  })().catch((e) => {
    // 兜底：对账自己出错不该把任何东西带崩，也不该变成一个没人处理的 rejection。
    siteSync = { supported: false, reason: 'internal', syncedAt: Date.now(),
                 error: `站点插件对账时出错：${e.message}` };
    return siteSync;
  });
  return siteSyncPromise;
}

/**
 * 演示调试开关要作用在池里的**哪一个**插件上：调用方给短名，不给就取列表里第一个。
 * 基座里没有插件名可写，所以"是哪一个"只可能由调用方说。
 *
 * 一个都没装时**如实返回一条 error**，而不是静默地什么也没发生 —— 后者会让调试的人
 * 以为是界面没刷新，然后去查一个不存在的问题。
 *
 * @returns {{plugin: object}|{error: string}}
 */
function pickPoolPlugin(name) {
  const list = registry.list();
  const plugin = name ? list.find((p) => p.name === name) : list[0];
  if (plugin) return { plugin };
  return {
    error: list.length
      ? `本机没有装短名为「${name}」的插件。`
      : '本机一个插件都没有 —— 先装一个，这个开关才有对象。',
  };
}

/**
 * 递给界面的插件视图。**界面不做任何推导** —— 它手里那份随时可能已经陈旧，
 * 而"哪些按钮该出现"是四个条件的求交（见 pluginsView）—— 它们来自三方，其中
 * 站点占两个。
 *
 * ★ `defaults` 是**管理员设定的策略**，不是用户偏好。界面只读地显示它，提交时
 *   靠【省略】cpus/mem 字段让服务端填当下那份默认值 —— 不是把这两个数字发回去。
 *   两者不等价：管理员把默认从 2 核改成 4 核之后，回发旧值的客户端会把它**永远
 *   钉死**在 2 核，而"省略"永远拿到当下的默认。只有用户当场点开「高级选项」，
 *   才发明确值。
 */
function pluginsView() {
  const site = new Map(((sitePlugins && sitePlugins.plugins) || [])
    .filter((x) => x && typeof x.name === 'string')
    .map((x) => [x.name, x]));
  const siteKnown = Boolean(sitePlugins && Array.isArray(sitePlugins.plugins));

  // ★ 一张表，每条带**两个**开关，界面自己决定怎么画。
  //
  //   不在这里替界面过滤掉任何一条：**"看不见"与"看得见但灰着"告诉用户的事
  //   完全不同** —— 站点没开 → 去找管理员；本机关了 → 自己打开就行；客户端
  //   不认得 → 该升级。三种都过滤掉，用户面对的就是"按钮凭空少了一个"。
  // ★ **不带钩子的那些不进这一列**（`active === false`）：它们是"代码还没过同意闸"
  //   的站点插件，界面上由**待同意**那一块专门画（见 panel.js 的 renderConsent）。
  //   两处都画的话，用户会看到同一个插件两个块，而其中一块说不出自己为什么灰着 ——
  //   `WHY_NOT_RUNNABLE` 那四句话说的是"起不来"，而"还没同意"是"还没到手"，
  //   硬塞进去就把两件事糊在一起了（`test/renderer.test.mjs` 正钉着那四句话）。
  const records = registry.list();
  const plugins = records.filter((p) => p.active !== false).map((plugin) => {
    const s = site.get(plugin.name) || null;
    // 本机开关按 **id** 记 —— 理由见 app:setPluginEnabled。
    const locallyEnabled = config.pluginEnabledLocally(cfg, plugin.id);
    // 站点清单**拿不到**时（守护进程太旧，没有这个 op）按"站点没说"算 true。
    // 算 false 的话，升级客户端会让老服务端的用户一个按钮都看不到。
    const siteEnabled = siteKnown ? Boolean(s && s.enabled) : true;
    // 站点侧「现在提交得出去吗」—— 开了 **且** 有作业侧实现。守护进程把这两件事
    // 合成**一个**字段发下来（它是唯一同时知道两者的那一方），客户端**不自己拿
    // `enabled` 推** —— 要推的话还得知道"这个插件有没有 job/start.sh"，而客户端
    // 根本看不见那件事（它不读池里那一半）。
    //
    // ★ 同一条三态纪律，同一个理由：**缺席 ≠ 否**。老守护进程不报这个字段
    //   （`undefined !== false`）⇒ 按"站点没说"算可以提交。反过来算的话，升级
    //   客户端会让所有老服务端的插件按钮在某一刻同时变灰。
    const canSubmit = siteKnown ? Boolean(!s || s.can_submit !== false) : true;
    return {
      // 身份：`id` 是铸造出来的全球唯一标识，`version` 是这一版的号。界面把两者
      // 都显示出来 —— 池里可以并存同一个插件的多个版本，只显示名字的话用户分不清
      // 自己看到的是哪一版。
      id: plugin.id,
      version: plugin.version,
      // 站点内用的短名。配置块名、提交时的 service_kind 都是它。
      name: plugin.name,
      // 客户端认得的插件用**它自己的**标题：那个才对应它实际会做的事。
      title: plugin.displayName,
      description: plugin.description,
      source: plugin.source,
      sources: plugin.sources,
      // ★ **来源标签在主进程算，不在界面里算。**
      //
      //   在此之前界面里有一句 `p.source === 'pool' ? '站点分发' : …`，而池曾经是
      //   唯一的来源 —— 那句话恒为真、且恒为假话（用户自己从本地目录装进去的插件
      //   也会被标成"站点分发"）。一个永远显示、并且永远说错的标签，比没有标签更糟。
      //
      //   现在真的有两个来源了，判据换成"**是不是真的有两个**"：只有一个来源时
      //   返回 null（不贴），贴着只会让人以为自己看到的是两条不同的来路。
      sourceLabel: sourceLabelOf(plugin.sources),
      hasClientCode: plugin.hasClientCode,
      surface: plugin.contributes.surface,
      // 站点那边报的是哪一版。**这是"站点升级了而本机还是旧的"的唯一线索** ——
      // 两半代码是配套的，对不上时必须让用户看得见。
      siteVersion: (s && s.version) || null,
      siteEnabled,
      siteKnown,
      locallyEnabled,
      // 站点装了它、也开着，但**没有作业侧实现** ⇒ 提交必被拒（守护进程回
      // code 4 / service_kind_no_job）。界面据此把按钮置灰并给出那一句话 ——
      // 目标是不让用户在**提交失败时**才第一次知道。
      canSubmit,
      // 默认资源是**管理员设定的策略**，不是用户偏好。界面只读地显示它，提交时靠
      // 【省略】cpus/mem 让服务端填当下那份默认值 —— 不是把这两个数字发回去。
      // 回发旧值的客户端会把管理员的改动**永远钉死**。拿不到就是 null，不编一个。
      defaults: (s && s.defaults) || null,
      // 能不能真的起一个会话 —— 三个条件都成立。界面画"启动"按钮时看这个。
      // 三个条件各有各的主语（站点 / 用户 / 站点的部署状态），所以界面上那三句
      // 解释也必须是三句不同的话。
      runnable: siteEnabled && locallyEnabled && canSubmit,
    };
  });

  // 站点报了、而本客户端**池里没有对应那一版**的。按 `(id, 版本)` 算，不是按名字
  // —— 名字对得上而版本对不上，同样是"你用不了它"，而按名字判会把它当成有。
  //
  // ★ **只看 `enabled` 的那些。** `op_plugins` 按协议**必须报全部插件、包括
  //   `enabled:false` 的**，而这里以前不过滤 —— 于是"站点关掉一个插件"会被界面说成
  //   "站点有而本机没有 ⇒ 升级客户端"，**永远挂着**。管理员关掉它是它不该出现，
  //   不是客户端缺了东西。
  const missing = [...site.values()]
    .filter((p) => p.enabled !== false)
    .filter((p) => !(p.id && p.version && registry.get(p.id, p.version)))
    .map((p) => ({
      name: p.name, title: p.title, id: p.id || null, version: p.version || null,
      enabled: true,
      // ★ 站点**愿不愿意发**这一份，与"本机有没有"是两件事，而它们的出路不同：
      //   愿意发 ⇒ 等对账/点同意；不愿意发 ⇒ 这一版你只能自己想办法（升级客户端，
      //   或者问管理员为什么这个插件没有文件清单）。
      distributed: Array.isArray(p.files),
    }));

  return {
    plugins,
    // **这是升级提示的唯一来源** —— 过滤掉它们，用户就永远不知道自己少了什么。
    missing,
    // 池里同 `(id, 版本)` 撞了（两个不同的东西在抢同一个身份）而被全部跳过的，
    // 以及插件目录里扫到的坏文件。它们被跳过了，客户端照常工作 —— 但必须说出来，
    // 否则用户面对的症状只是"加了插件它就是不生效"。
    errors: registry.errors,
    // 池**在哪**、里面**有没有东西**。
    //
    // ★ 这两条是承重的：本机一个插件都没装时，站点上**每一个**插件都会落进
    //   `missing`，于是界面会把它们全都说成「本站有而本机没有 —— 升级客户端」。
    //   而真相是「你还没装插件」—— 那两件事的行动完全不同（去装 vs 去升级）。
    //   界面靠 `installedCount === 0` 分岔，见 panel.js 的 renderPlugins。
    poolDir: poolDir(),
    // ★ 只数**能用的**那些。把待同意的也算进去的话，「一个插件都没装」的空态再也
    //   走不到 —— 而那个空态正是用户第一次打开客户端时要看的那块地方。
    installedCount: plugins.length,
    // 池里有、但**还没过同意闸**的。它与"没装"必须分得开：一个是去点同意，
    // 一个是去同步/去装。
    inertCount: records.length - plugins.length,

    // ── 站点分发那一节 ──
    //
    // ★ 三条「你没有这个插件」的理由**必须分开报**，因为它们要做的事不同：
    //     站点守护进程太旧   → 找管理员升级站点
    //     站点支持但没下来    → 看下面 `failed` 里那一句（可能是网络、可能是配置）
    //     开发者模式关着而池里有 → 自己勾一下开发模式（**只在第三条成立时才能这么说**）
    //   合并成一句"同步失败"的话，用户就只能一个个试。
    site: siteSync ? {
      supported: siteSync.supported,
      reason: siteSync.reason || null,
      error: siteSync.error || null,
      label: siteSync.label || null,
      syncedAt: siteSync.syncedAt || null,
      failed: siteSync.failed || [],
      reclaimed: (siteSync.reclaimed || []).length,
      recordOk: siteSync.recordOk !== false,
      // 池里每个版本**被哪些站点要** —— 这是那一栏唯一值得显示的东西，它解释了
      // "为什么这台机器上有两个版本"。读自快照表（`.sites.json`）。
      versions: siteVersions(),
    } : null,
    dev: {
      on: devMode(),
      // ★ 演示模式恒开，而那是因为"从源码跑演示的人就在写插件"—— 如实说出来，
      //   别让用户以为自己勾过。
      forced: DEMO_FLAG,
      poolDir: poolDir(),
      poolCount: (() => {
        try { return registry.list().filter((p) => p.source === 'pool').length; }
        catch { return 0; }
      })(),
      sitePoolDir: sitePoolDir(),
    },
    // 待同意的：**不下发暂存路径** —— 那是主进程的现场，界面不需要知道它在哪。
    consent: pendingConsent.map((p) => ({
      id: p.id, version: p.version, name: p.name, title: p.title,
      digest: shortDigest(p.digest), fullDigest: p.digest,
      siteLabel: p.siteLabel, fileCount: (p.files || []).length,
      // 同 (id, 版本) 以前同意过吗？—— 有的话这一次**内容变了**，界面上要说出来。
      previous: (() => {
        const e = cfg && cfg.trustedPlugins && cfg.trustedPlugins[config.trustKey(p.id, p.version)];
        return e ? { digest: shortDigest(e.digest), at: e.at } : null;
      })(),
    })),
  };
}

/**
 * 来源翻成人话。**只在真的有两个来源时才用得上**（见 sourceLabelOf）。
 */
const SOURCE_LABEL = {
  site: '站点分发',
  pool: '本机安装',
};

/**
 * 给插件贴的来源标签 —— 单来源时是 `null`（**不贴**）。
 *
 * ★ 判据是"来源数 > 1"，不是"来源是谁"：只有一个来源时，标签描述的是**每一块
 *   都有的那件事**，说了等于没说，还让人以为自己看到的是两条不同的来路。
 */
function sourceLabelOf(sources) {
  const s = Array.isArray(sources) ? sources : [];
  if (s.length < 2) return null;
  return s.map((x) => SOURCE_LABEL[x] || x).join(' + ');
}

/**
 * 池里每个 `<id>/<版本>` 被**哪些站点**要 —— 读自快照表。
 *
 * ★ 读不出来就返回空数组，并且**不编**。它只有显示用途（"为什么这台机器上有两个
 *   版本"），而回收那条路自己会去判"记录读不出来就不回收"。
 */
function siteVersions() {
  const root = sitePoolDir();
  if (!root) return [];
  const rr = sitePluginSync.readRecord(sitePluginSync.recordPathOf(root));
  if (!rr.ok) return [];
  const wanters = new Map();
  for (const [key, s] of Object.entries(rr.record.sites || {})) {
    for (const [id, v] of Object.entries((s && s.wants) || {})) {
      const k = `${id}@${v}`;
      if (!wanters.has(k)) wanters.set(k, []);
      wanters.get(k).push((s && s.label) || key);
    }
  }
  return sitePluginSync.listPooled(root).map((it) => ({
    id: it.id, version: it.version,
    wantedBy: wanters.get(`${it.id}@${it.version}`) || [],
  }));
}

// 登录机制（`webLogin`）在 `weblogin.js` 里 —— 它是**通用**的，契约由插件自己的
// 清单提供。基座这一层不知道任何一个具体网页服务的端点或字段名。

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
 * ★ 有且只有一条致命前提：**绝不能对正被那块界面用着的那个 partition 做**。
 *   那会把用户当前的会话连 cookie 带 localStorage 一起抽掉，而症状只是
 *   「页面莫名其妙坏了」。所以先跟窗口对一下现在用的是哪个。
 *
 * 不 await：删一个组不该因为磁盘慢而卡住界面。
 */
function clearLayoutStorage(layoutId) {
  const partition = config.partitionForLayout(layoutId);
  if (win && win.surfacePartition === partition) return;
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
 * @param {string} serviceKind 这一次要哪个**插件**（注册表里的名字）。
 *        省略 = 缺省插件 —— 与这个参数存在之前的行为一致。
 */
async function startSession(resources, serviceKind) {
  // ★ 认不出的服务种类**在提交之前**就拦住。走到提交再让服务端回一句
  //   `bad_service_kind` 也行，但那要花掉一整趟往返，而且用户看到的是一个
  //   关于"服务种类"的错误、而他刚才点的可能是一个界面上的按钮。
  //
  // ★ 省略 serviceKind = **缺省插件**，不是"未知"。这与这个参数存在之前的行为
  //   完全一致（那时的界面只能起一个插件），所以老界面、老测试、以及任何还在用
  //   单参数调用的地方都不会因此坏掉。而传一个**认不出的名字**是另一回事 ——
  //   那是明确的错误，必须拦住。
  const wanted = serviceKind === undefined
    ? (registry.defaultPlugin() || {}).name
    : serviceKind;
  // ★ 提交时只知道**短名**（配置块名、界面按钮上那个）。短名是站点内唯一的，
  //   而本机可能并存同一个插件的多个版本 —— 取版本最高的那一个：站点那边跑的
  //   通常就是它。版本对不上时下面会明确说出来（但**不拦**，见 warnVersionDrift）。
  const plugin = pickForSubmit(wanted);
  if (!plugin) {
    // ★ 「一个插件都没装」与「不认识这个名字」是**两件事**，行动也不同（去装一个
    //   vs 换个按钮点）。以前这里只印一句「本版支持：（一个都没有）」—— 那既是
    //   一句错话（本版没有"支持"任何东西，是**你还没装**），也没给出路。
    // ★ 第三种情况：**它就在本机，只是还没同意**。与"没有这个插件"必须分得开 ——
    //   一个是去点同意，一个是去同步/去装。含糊的一句"不认识这种服务"会让用户
    //   跑去重新同步，而同步本来就已经成功了。
    const held = registry.list().find((p) => p.name === wanted && p.active === false);
    if (held) {
      win.pushNotice('error',
        `「${held.displayName}」${held.version} 已经取回本机了，但它的客户端代码`
        + '还没有经过你的同意，所以没有加载。到插件那一栏点一下同意再试。');
      return null;
    }
    // `active !== false` 的那些才算"装上了"：只剩待同意的插件时，用户面对的
    // 就是"一个能用的都没有"，走下面那条空态才对。
    if (!registry.list().some((p) => p.active !== false)) {
      // ★ 出路取决于**站点说了什么**，不是取决于我们猜。站点支持分发而本机还没有
      //   那些插件 ⇒ "去同步/去同意"；站点不分发 ⇒ 只能自己装（而默认不加载本机池，
      //   所以要先把开发者模式打开）。
      const canSync = Boolean(siteSync && siteSync.supported);
      win.pushNotice('error',
        '本机还没有装上任何插件，所以没有可以提交的服务。'
        + (canSync
          ? '本站会分发插件 —— 用插件那一栏的「重新同步」取一次，'
            + '带客户端代码的要你点一下同意。'
          : `把插件目录放进 ${poolDir() || '插件池'}（界面上的「打开插件目录」能直接打开它），`
            + '再到插件那一栏把「也加载本机插件目录」勾上。'));
    } else {
      win.pushNotice('error',
        `这个客户端不认识「${wanted || '（未指定）'}」这种服务，已阻止提交。`
        + `本机装的是：${registry.list().map((p) => p.displayName).join('、')}。`);
    }
    return null;
  }
  warnVersionDrift(plugin);

  // ★ 布局组是**按插件**的：跑在浏览器里的插件要一个（端口 = origin = 一份
  //   编辑器布局），不跑浏览器的不给 —— 给它一个组只会凭空造出一个永远不会被
  //   创建的存储分区，并让「运行中切布局」去挪一个正在用的隧道端口。
  const layoutId = plugin.contributes.layout ? layoutForSession() : null;

  // 插件的提交前准备（sshd 要在这里备好那把一次性密钥：没有它守护进程会拒绝
  // 这次提交，而那要花掉一整趟往返）。**先备好再提交**是硬要求。
  let sshPubkey = null;
  if (plugin.prepare) {
    const pre = plugin.prepare(pluginContext(plugin));
    if (!pre || !pre.ok) {
      win.pushNotice('error', (pre && pre.message) || '提交前的准备失败，已中止。');
      return null;
    }
    sshPubkey = pre.sshPubkey || null;
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
        // 端口要**持久化** —— 变了 origin 就变，浏览器存在 localStorage 里的
        // 编辑器布局会重置。记住它，下次还用同一个。
        // （没有布局组的插件走下面那条 onRelayPort，它的端口属于别的地方。）
        if (!id) return;
        config.setLayoutPort(cfgDir, cfg, id, port);
      },
      // 没有布局组的插件：端口不由我们记，交给插件自己的 attach() 去处理
      // （sshd 把它写进用户那份 ssh 配置，见 sshconfig.js）。
      // 这里只需要「重新渲染一次」，插件按当前端口重写它那份配置；
      // 端口和主机公钥都没变时它会自己跳过（那正是 ctx.once() 的用处）。
      onRelayPort: () => onSessionChange(controller.snapshot()),
      // 端口顺移时必须跳过别的布局组占着的端口，否则两个组会声称同一个端口，
      // 每次启动谁先绑谁赢，布局在两个 origin 之间反复横跳。排除集里要**摘掉自己**，
      // 不然自己那个端口会被当成「别人的」而永远绑不上。
      //
      // 没有布局组的插件 layoutId 是 null，于是这里排除掉**全部**布局端口 ——
      // 正是要的：它绝不能落到某个布局组的端口上。
      getExcludedPorts: () => config.usedLayoutPorts(cfg, controller && controller.layoutId),
    });
    controller.on('change', onSessionChange);
    controller.on('retarget', () => onSessionChange(controller.snapshot()));
  }
  // ★ **在这里捕获插件对象**，之后所有状态变化都用它，不再查注册表。
  //
  //   站点升级插件之后池里会有同一个 id 的新版本，而一个**已经跑着**的会话用的是
  //   它起时那一版 —— 作业侧与客户端侧是配套的两半，中途换掉这一半，轻则行为诡异、
  //   重则对接不上。捕获之后，**升级插件对正在跑的会话完全没有影响**。
  //
  //   顺带得到一个好性质：把一个插件从池里卸掉，正在跑的会话也完全不受影响 ——
  //   它手里已经攥着那个对象了。
  controller.plugin = plugin;
  // ★ 这里**没有** else 分支。走到 else 的唯一可能是「已经有一个会话在跑」，
  //   而那种情况下 controller.start() 会抛「会话已在进行中」—— 这正是双击
  //   「开始」时该有的表现。在 else 里顺手改一下运行中会话的 layoutId 是纯副作用：
  //   它会把这个正在跑的会话挪到另一个布局组上，而用户什么都没要求。

  // 首选端口也是**按插件**的：跑浏览器的用工位组的端口，其余用它自己声明的那个。
  // 插件没声明时给 0，交给隧道模块自己顺移。
  const preferredPort = plugin.preferredPort
    ? plugin.preferredPort(pluginContext(plugin), layoutId)
    : 0;
  const snap = await controller.start(resources, {
    preferredPort,
    serviceKind: plugin.name,
    needsPubkey: plugin.contributes.submitPubkey,
    sshPubkey,
  });
  if (!snap) onSessionChange(controller.snapshot());
  return snap;
}

/**
 * 提交时该用本机的哪一个插件。
 *
 * ★ **优先按站点报的 `(id, 版本)` 挑**，而不是"同名里版本最高的那个"：那个才是
 *   这个会话真会跑的那一版，而客户端的 `prepare()`、`preferredPort()` 必须与服务端
 *   即将起的那份**配套**。同名多 id 只可能出现在"站点分发的插件覆盖了内建同名插件"
 *   这种情形上，那时按名字挑纯属碰运气。
 *
 * 站点没报（老守护进程、或还没连上）时才退回按短名取版本最高的那个。
 */
function pickForSubmit(name) {
  const s = ((sitePlugins && sitePlugins.plugins) || []).find((p) => p.name === name);
  if (s && s.id && s.version) {
    const hit = usable(registry.get(s.id, s.version));
    if (hit) return hit;
  }
  return usable(registry.latestByName(name));
}

/**
 * 这一份**能不能拿去开会话**。
 *
 * ★ `active === false`（站点分发的、代码还没过同意闸的那一份）**绝不能**出手 ——
 *   它一个钩子都没有，拿它去接一个会话等于用半个插件去对接一个作业。`resolve()`
 *   在"接回旧会话"那条路上已经拒了，这里是**提交**那条路，两条都得拒。
 *
 * ★ 它出现在 `list()` 里是**有意的**（用户要看得见它才能点同意），所以每个"从
 *   注册表取一个来用"的地方都要过这一道 —— 见 pickForSubmit 与 startSession。
 */
function usable(p) {
  return (p && p.active !== false) ? p : null;
}

/**
 * 站点那边的版本和本机这一份对不上时，**说出来但放行**。
 *
 * ★ 为什么放行：站点升级插件不该让所有人的客户端当场变成砖头。而作业侧与客户端侧
 *   是配套的两半，真的对不上时会话起来之后**解析不到那一版**，那时会有另一句更
 *   准确的话（"站点用的是 X 版，本机只有 Y 版"）—— 用户仍然接得上隧道、停得掉
 *   会话，只是用不了那个界面。
 *
 * ★ 为什么还是要说：不说的话，用户看到的是"点了开始、作业起来了、界面一片白"，
 *   而根因一个字都不在里面。这正是这个项目一路在清的那类症状。
 *
 * 老守护进程不报版本（`siteVersion` 为 null）时不说话 —— 那不是漂移，是信息缺失。
 */
function warnVersionDrift(plugin) {
  const site = ((sitePlugins && sitePlugins.plugins) || []).find((p) => p.name === plugin.name);
  const siteVersion = site && site.version;
  if (!siteVersion || siteVersion === plugin.version) return;
  if (!registry.once(`${plugin.id}@${siteVersion}`, 'version-drift')) return;
  win.pushNotice('warn',
    `站点那边的「${plugin.displayName}」是 ${siteVersion} 版，本机这一份是 `
    + `${plugin.version} 版。会话仍然会起，但作业侧和客户端侧是配套的两半，`
    + '对不上的话界面可能连不上 —— 升级客户端通常就好了。');
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
    win.hideSurface();
  }

  // ── 唯一的服务分派点 ──
  //
  // ★ 插件对象是在**会话创建时捕获**的（见 startSession / tryReattach），这里只用
  //   它，**不再查注册表**。查了会坏事：站点升级插件之后池里会出现同一个 id 的新
  //   版本，而一个**已经跑着**的会话用的是它起时那一版 —— 作业侧与客户端侧是配套
  //   的两半，中途换掉客户端这一半，轻则行为诡异、重则对接不上。捕获之后，
  //   **站点升级插件对一个正在跑的会话完全没有影响**。
  //
  // ★ 不分流的后果不是崩溃，而是**误导**：跑在浏览器里的那条路会拿会话口令去
  //   POST 一个 SSH 端口，然后弹一句语义完全错误的「自动登录失败」；反过来
  //   另一边会去建一个 WebContentsView 加载一个根本不说 HTTP 的端口。
  //
  // ★ 这里**没有**任何插件名。注册表回答的是"这个会话归哪个插件"，所以加第三个
  //   插件时这一段一行都不用改 —— 要动的是 plugins/ 下多一个目录。
  const plugin = (controller && controller.plugin) || null;
  win.setSessionService(plugin);        // 关窗文案要用（见 windows.js）
  if (snap.state === State.RUNNING && snap.origin) {
    if (!plugin) {
      // 未知服务：**绝不建界面**（那个端口上跑的可能是任何东西），也绝不 POST 口令。
      // 但上一个会话留下的那块界面必须收掉 —— 它盖在面板上，用户会以为那还是
      // 自己的会话。
      win.hideSurface();
      await warnUnknownService(snap);
    } else if (plugin.contributes.surface) {
      await ensureSurface(plugin, snap);
      if (plugin.attach) await plugin.attach(pluginContext(plugin), snap);
    } else {
      // 这个插件不要界面（比如中转站）：把上一个会话留下的那块收掉，否则它盖在
      // 面板上，而用户在这个会话里根本不需要它。
      win.hideSurface();
      if (plugin.attach) await plugin.attach(pluginContext(plugin), snap);
    }
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
 * 插件注册表。**两个根**，两条来路。
 *
 *   `site`  站点池 —— 站点分发的插件落在这里（见 site-plugins.js）。**恒在**。
 *   `pool`  本机池 —— 用户自己装的那些。**要开发者模式开关才加载**（`dir()` 返回
 *           null 就是"这次不加载"，那是一个静默的合法状态）。
 *
 * ★ 基座自己不带任何插件 —— 一个都没有是**正常状态**，不是安装包坏了。
 *   `src/main/plugins/` 那个目录是框架（注册表 + ulid.js + 安装器），不是插件目录，
 *   所以它压根不作为根传进来。
 *
 * ★ 两个根**不是洁癖**：回收只该删站点拥有的那些，而用户手装的那一份不在任何站点
 *   记录里、引用数天然是 0 —— 合并成一个目录就等于"回收会把用户自己的东西删掉"。
 *
 * ★ 根的**集合**固定，能变的只有"这次加不加载"（`dir` 是个函数）。所以切开发者
 *   模式只需要 `registry.reload()`，**不重建 Registry** —— 重建会清掉 `notices`，
 *   用户会把已经看过的通知重看一遍。
 *
 * 放在模块级是因为它**跨会话存活**：去重槽（`once`）跟着插件走。
 */
const registry = new plugins.Registry([
  // 传**函数**而不是路径：cfgDir 要等 app ready 之后才定下来，在这里当场算会算出
  // 一个 null 路径（见 plugins/index.js 的 scanRoot）。
  { dir: sitePoolDir, source: 'site' },
  { dir: () => (devMode() ? poolDir() : null), source: 'pool' },
], {
  /**
   * 同意闸。**带客户端代码的站点插件，没同意过就不加载。**
   *
   * ★ 只对 `source === 'site'` 问。本机池那一份是**用户自己**从本地目录拷进去的
   *   —— 让用户"同意自己刚放进去的东西"是一句空话，只会训练他闭着眼睛点同意。
   *
   * ★ 判据是**全长摘要**（见 config.isTrusted）。这里拿到的是 `inspectDir` 从
   *   磁盘上算出来的那个值，不是站点自报的。
   *
   * ★ `cfg` 在模块加载期还是 null（注册表在那一刻就构造了）—— 那时一个插件都
   *   加载不了，与"没同意"同归一处，是正确的默认。
   */
  allows: (entry) => entry.source !== 'site'
    || !cfg
    || config.isTrusted(cfg, entry.plugin.id, entry.plugin.version, entry.digest),
});

/**
 * **池**目录 —— 装进来的插件都落在这里，不分是从哪来的。
 *
 * ★ 一个池而不是按来源分目录，这是有意的：`id` 是铸造出来的全球唯一标识，所以
 *   「同一个插件被两个站点分发」在池里天然就是同一条（只多记一个来源），而
 *   「两个站点各写一个 jupyter」是两条不同的记录，并存、各自标明来源。
 *
 * ★ 演示模式落在它自己的目录里 —— 演示绝不去读用户真实的那份池。
 */
function poolDir() {
  // ★ 整个包在 try 里：这个函数是在**模块加载期**被调用的（见下面 registry 的构造），
  //   而那时 app 可能还没 ready。真抛出来就不是"池扫不到"，而是**整个客户端起不来** ——
  //   为了一个次要功能赌上启动路径不值当。拿不到就当没有池（loadRoot 会记一条）。
  try {
    return DEMO_FLAG
      ? path.join(cfgDir || '.', 'plugins')
      : path.join(app.getPath('home'), '.slurmate', 'plugins');
  } catch {
    return null;
  }
}

/**
 * **站点池** —— 站点分发的插件落在这里。与用户自己的池分开，理由见 registry 的注释。
 *
 * ★ 演示模式落在它自己的目录里（与 poolDir 同一个道理）：演示绝不去读、更不去
 *   写用户真实的那份站点池。
 */
function sitePoolDir() {
  try {
    return DEMO_FLAG
      ? path.join(cfgDir || '.', 'site-plugins')
      : path.join(app.getPath('home'), '.slurmate', 'site-plugins');
  } catch {
    // ★ 拿不到就返回 null，而 null 在那条路上意味着"这个根这次不加载"。
    //   把一个次要功能的失败变成**整个客户端起不来**不值当（与 poolDir 同理）。
    return null;
  }
}

/** 暂存根：站点池的**兄弟目录**（换入用的 `rename` 要求同一个文件系统）。 */
function siteStagingDir() {
  const pool = sitePoolDir();
  return pool ? path.join(path.dirname(pool), '.site-staging') : null;
}

/**
 * 开发者模式：**本机池加不加载**。
 *
 * ★ 它是**用户的设置**，不是站点的能力 —— 所以老守护进程 + 关着开关 = 一个插件
 *   都没有。那是正确的、必须如实说出来的结果，不是需要被"兜"掉的失败。
 * ★ 演示模式**恒开**：从源码跑的人就是在写插件，而演示池里那几个就是他要看的东西。
 */
function devMode() {
  return DEMO_FLAG || Boolean(cfg && cfg.devPlugins);
}

/** 把站点池建出来（0700）。对账之前得先有个地方放东西。 */
function ensureSitePoolDir() {
  const dir = sitePoolDir();
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch (e) {
    win && win.pushNotice('warn', `站点插件目录 ${dir} 建不出来：${e.message}`);
    return null;
  }
}

/**
 * 把池目录建出来（0700）。**装第一个插件之前，用户得先有个地方放它。**
 *
 * 以前这里只读不写，所以池目录不存在、界面上也没有任何东西告诉你该往哪放 ——
 * 「池是安装点」这句话在代码里落不了地。
 */
function ensurePoolDir() {
  const dir = poolDir();
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch (e) {
    win && win.pushNotice('warn', `插件目录 ${dir} 建不出来：${e.message}`);
    return null;
  }
}

/**
 * 让窗口里那块界面与快照一致。**幂等**，每次状态变化都可以调。
 *
 * ★ 这是**框架**的事，不是插件的事 —— URL 来自 `contributes.surface.path`，
 *   存储分区来自框架的布局组。这个分工的用处很具体：一个**没有客户端代码**的
 *   声明式插件照样能开界面，因为开界面本来就不需要代码，只需要一句声明。
 *
 * 判定两件事：url 变没变、partition 变没变。前者只需重新 loadURL；**后者必须
 * 销毁重建** —— partition 是构造期属性（见 windows.js 的 showSurface）。
 *
 * ★ 这也是唯一的入口。windows.js 的 pushState 里那条「origin 变了就 loadURL」的
 *   自动 retarget 已经删掉了：它不换 partition、也不重跑登录，两条路并存必然分叉。
 */
async function ensureSurface(plugin, snap) {
  const surface = plugin.contributes.surface;
  if (!surface) return;

  // 分区：要布局组的用布局组的分区（同一个组的若干条连接共用一份 localStorage，
  // 这是布局组存在的全部理由）；不要的用**按插件**的一份 —— 一个网页应用自己的
  // 状态该跟它自己走，跟会话走会在每次重开时重置。
  const partition = plugin.contributes.layout
    ? config.partitionForLayout(snap.layoutId)
    : `persist:plugin-${plugin.id}`;

  // 换布局组 = 换分区 = 销毁重建。用户看得见的那件事（编辑器布局重置了）必须
  // 说出来，否则他只会觉得"我的设置莫名其妙没了"。
  const rebuilt = win.hasSurface() && win.surfacePartition !== partition;
  await win.showSurface({ url: snap.origin + surface.path, partition, demo: DEMO_FLAG });
  if (rebuilt) {
    win.pushNotice('info', '已切换到新的布局组，页面已重新加载。');
  }
}

/**
 * 递给插件的**全部能力**。
 *
 * ★ 插件拿到的是这个对象，而不是整个模块作用域。这不是洁癖：它把"一个插件能
 *   碰什么"变成一份看得见的清单，而 Phase 3 的进程隔离就是把这份清单变成一条
 *   IPC 协议。
 *
 * ★ 每次调用都**新建**一个 —— `cfg` 是会变的（换一条连接就换一份），而插件里的
 *   `await` 可能跨越那个变化。所以 cfg/cfgDir 用 getter 现取，不用快照。
 *
 * ★ `once()` 按插件名分桶：两个插件各记各的"上次值"，共用一个槽会互相冲掉。
 *
 * ★ **插件能用的一切都在这里。** 它不能 `require` 客户端的源码 —— 插件装在池里
 *   （`~/.slurmate/plugins/<id>/<版本>/`），相对路径指不到客户端；就算指得到，
 *   那种依赖也是无法检查的。所以缺什么就在这里加什么，而不是让插件绕过这份清单。
 */
function pluginContext(plugin) {
  return {
    win,
    config,
    /** 框架的 SSH 钥匙工具箱（ed25519 ↔ OpenSSH 格式）。纯 Node `crypto`，
     *  没有任何"读到客户端自己那把私钥"的入口 —— 见 keys.js。 */
    keys,
    get cfg() { return cfg; },
    get cfgDir() { return cfgDir; },
    demo: DEMO_FLAG,
    session: () => (controller && controller.session) || null,
    whoami: () => whoami,
    /** 写本地文件用的家目录。演示模式必须落在它自己的目录里 —— 见 sshd 插件。 */
    home: () => (DEMO_FLAG ? cfgDir : app.getPath('home')),
    /**
     * 自动登录。契约由**框架**从当前插件自己的清单里取，不由插件传进来 ——
     * 插件没法把这个参数传错，也没法去登别人的页面。
     */
    login: (ses, origin, password) =>
      weblogin.webLogin(ses, origin, password, plugin.contributes.login),
    notice: (kind, text) => win.pushNotice(kind, text),
    // 分桶用的是 `id@版本`，不是短名 —— 池里可以并存同一个插件的多个版本，而
    // "这个版本已经说过这句话了"与"那个版本说过了"是两件事。
    once: (key) => registry.once(plugins.bucketOf(plugin), key),
  };
}

/**
 * 这个会话的插件我们**不认识** —— 站点开了它，而本客户端的注册表里没有。
 *
 * ★ 这里**什么都不做**，正是要害。那个端口上跑的可能是任何东西，而任何做法都是
 *   系统在声称一件它并不知道的事：拿口令去 POST 一个 SSH 端口，或者给一个 HTTP
 *   端口配主机公钥。用户看到的是莫名其妙的报错，而根因一个字都不在里面。
 *   所以如实说出来，并且**只留「结束会话」这一条路**。
 *
 * ★ 这一条同时是"站点装了新插件而客户端没跟上"的**唯一提示来源** —— 说清楚是
 *   哪种情况，用户才知道该升级客户端还是该找管理员。所以它会把站点那边认得的
 *   名字列出来。
 */
async function warnUnknownService(snap) {
  const key = `unknown|${snap.sessionId}`;
  if (!registry.once('__unknown__', key)) return;

  win.pushNotice('warn',
    `这个会话的服务类型未知（作业 ${snap.jobId || '?'}）—— ${unknownWhy(snap)}\n`
    + '作业本身是正常的：你可以结束它，或者直接连 127.0.0.1 上看它到底是什么。'
    + '（能结束、能看，是因为状态、心跳和结束这三件事**从不查插件** —— 只认会话号。）');
}

/**
 * 「为什么用不了它」，按**具体到什么程度**从高到低挑一句。
 *
 * ★ 第一档最要紧：站点正在分发的那个插件，本机缺的正是**它需要的那一版**。
 *   这时能说出"本站的「Jupyter」是 2.0.0 版，本机没有这一版" —— 用户照着升级
 *   客户端就行了。这一档要拿**会话自己带的解析键**去站点清单里找，而不是泛泛地
 *   列一遍本站有哪些插件。
 *
 * ★ 而会话带的那个键**必须**是权威：站点会升级，所以"现在再看一眼站点有哪些插件"
 *   可能已经和这个会话提交时不是一回事了。所以站点清单只用来把 id 翻成人看的标题，
 *   判定始终以会话自带的 `(id, 版本)` 为准。
 */
function unknownWhy(snap) {
  const missing = pluginsView().missing;
  const ref = typeof snap.servicePlugin === 'string' ? snap.servicePlugin : null;
  const at = ref ? ref.lastIndexOf('@') : -1;
  const id = at > 0 ? ref.slice(0, at) : null;

  if (id) {
    const hit = missing.find((p) => p.id === id);
    if (hit) {
      return `本站的「${hit.title}」是 ${hit.version} 版，而本机没有这一版`
        + ' —— 升级客户端之后就能用它。';
    }
    const known = registry.list().filter((p) => p.id === id);
    if (known.length) {
      const versions = known.map((p) => p.version).join('、');
      return `这个会话要在 ${ref.slice(at + 1)} 版上跑，而本机只有 ${versions} 版。`
        + '作业侧与客户端侧是配套的两半，对不上就用不了 —— 升级客户端通常就好了。';
    }
    return `这个会话来自一个本机没有的插件（${id}）。`;
  }

  if (missing.length) {
    const names = missing.map((p) => (p.version ? `${p.title} ${p.version} 版` : p.title));
    return `本站开了这个客户端没有的插件：${names.join('、')}。升级客户端之后就能用它。`;
  }
  // 最后才用解析那一刻留下的说法（它只有 id，没有标题）。
  if (controller && controller.pluginWhy) return `${controller.pluginWhy}。`;
  return '它多半是别的进程提交的，控制节点没有关于它的记录。';
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
    // ★ 不写服务名：崩掉的是**框架建的那块视图**，它加载谁的页面取决于当前这个
    //   会话是哪个插件 —— 对着一个 Jupyter 会话说"code-server 页面崩溃了"，
    //   用户会去查一个跟这件事无关的东西。
    win.pushNotice('error',
      `会话页面崩溃了（${payload && payload.reason}）。可以点「重新加载页面」恢复。`);
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

  // ★ 用**注册表**归一，而不是在会话对象上直接判。四种输入四种答案，理由见
  //   plugins/index.js 的 resolve()：`<id>@<版本>` 查池；老守护进程没有这个字段
  //   时按短名找内建的；服务端明说不知道（null）时**绝不猜**。
  //
  //   `why` 是"明确要某一版而它不在"时的一句人话，一路带到 warnUnknownService ——
  //   在这里重新推一遍是不行的，站点会升级，那时的站点清单已经和这个会话提交时
  //   不是一回事了。
  const { plugin, why } = registry.resolve(s.service_kind, s.service_plugin);

  // ★ 认不出的插件**照样要把隧道接起来**，这一条是承重的。
  //
  //   不接的话：服务端明明有一个会话在跑（占着那个名额，于是"单一启动"会拒绝
  //   下一次提交），而客户端表现得像什么都没有 —— 用户既看不到它、也不知道为什么
  //   下一个起不来。接起来之后他至少有一条出路：直接连 127.0.0.1:端口 看看那
  //   到底是什么，或者把它结束掉。
  //
  //   而"客户端不知道该怎么**用**它"这件事由 _renderSession 去说 —— 那里对未知
  //   服务只解释、不动作（绝不建 WebView、绝不 POST 口令）。
  //
  // 不跑浏览器的插件不走布局组（见 startSession）。这里**不需要**有连接也能接上，
  // 因为它的端口不是布局端口，没有「该用哪个组」这个问题。
  const layoutId = (plugin && plugin.contributes.layout) ? activeLayoutId() : null;
  if (plugin && plugin.contributes.layout && !layoutId) return;   // 没配置连接，接不上

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
      if (!id) return;                 // 没有布局组的插件，没有东西可记
      config.setLayoutPort(cfgDir, cfg, id, port);
    },
    onRelayPort: () => onSessionChange(controller.snapshot()),
    getExcludedPorts: () => config.usedLayoutPorts(cfg, controller && controller.layoutId),
    // 接上来的这个会话是哪个插件的 —— 快照要靠它分派（见 serviceKind 的说明）。
    // 认不出时**原样**记下，于是界面仍然得出「未知」。
    requestedKind: plugin ? plugin.name : s.service_kind,
    needsPubkey: Boolean(plugin && plugin.contributes.submitPubkey),
  });
  controller.on('change', onSessionChange);
  controller.sessionId = s.session_id;
  controller.session = s;
  // ★ 与 startSession 同一件事：**在这里捕获**，之后状态变化都用它，不再查注册表。
  //   对"接上一个上次没关干净的会话"这条路径尤其要紧 —— 站点可能就在这中间升级了
  //   插件，而那个作业跑的还是旧版。
  controller.plugin = plugin;
  controller.pluginWhy = why;

  // 认不出的插件用**非布局组**的基准端口：它的端口绝不能落进任何布局组（否则会与
  // 那个组的 origin 撞上），而它自己听在哪个端口我们并不知道。
  const preferredPort = (plugin && plugin.preferredPort)
    ? plugin.preferredPort(pluginContext(plugin), layoutId)
    : config.RELAY_PORT_BASE;
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
    plugins: pluginsView(),
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
    // ★ 不参与布局的插件（没有布局组的那些）**不能走 relisten**：它的端口不在任何
    //   布局组里，relisten 会去挪一个正在被使用的隧道端口 —— 而它对外的那份配置是
    //   隧道起来时才写的，挪完那一瞬间用户手上的连接指向一个没人监听的端口。
    //   所以那种会话只改配置、不动会话本身。
    //
    //   判据是 layoutId 有没有（框架的事实），不是"是哪个插件"（那是插件名）。
    const sessionInLayout = sessionLive && controller.layoutId !== null;
    const outsideLayout = sessionLive && !sessionInLayout;

    if (isActive && controller && sessionLive && !outsideLayout) {
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
    } else if (isActive && controller && !outsideLayout) {
      controller.setLayout(target.id);      // 没有会话在跑：只改标记，下次开会话就用它
    }
    // outsideLayout 时两条都不走：配置照改（下次起 code-server 就用新组了），
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
    return { ...res, whoami, partitions, plugins: pluginsView() };
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
    return { ...res, whoami, partitions, plugins: pluginsView() };
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
    sitePlugins = null;           // 断开之后就没有「站点开了哪些插件」可谈了
    // 待同意的那些是**这一次连接**的现场：换代 + 丢掉它们的暂存树（那是**我们
    // 自己的**草稿纸，删它不算"删站点的东西"）。不清的话，用户会看到一个来自
    // 已经断掉的站点的"同意"按钮。
    connectGeneration += 1;
    for (const p of pendingConsent) sitePluginSync.discardStaged(p.stagedDir);
    pendingConsent = [];
    siteSync = null;
    return { ok: true, released };
  });

  // ── 会话 ──
  // ok 现在**如实反映查询本身成不成功**（此前恒为 true，失败被吞成空分区列表）。
  // partitions 仍然是数组，空数组表示「取不到」而不是「没有分区」—— 区别在 error 里。
  send('app:partitions', async () => {
    const r = await refreshPartitions();
    return { ok: r.ok, partitions: r.partitions, plugins: pluginsView(), error: r.error };
  });

  /**
   * 起一个会话。
   *
   * @param {object} resources 高级选项里的临时覆盖（省略字段 = 用服务端默认）
   * @param {string} [serviceKind] 插件名。**省略 = 缺省插件**（标了 legacyDefault
   *        的那一个），与这个参数存在之前的行为一致。
   */
  send('app:start', async (resources, serviceKind) => {
    const snap = await startSession(resources, serviceKind);
    return { ok: Boolean(snap), snapshot: controller && controller.snapshot() };
  });

  /**
   * 本机要不要这个插件。**不影响服务端** —— 站点仍然可以提交那个插件的会话
   * （用户自己用 CLI 就行），这里只是让客户端不再给出那个按钮。
   */
  // ★ 开关按 **id** 记，不按短名。池是全局的：两个站点可以各有一个叫 `jupyter`
  //   的插件而它们是两个不同的东西（两个 id），按短名记会让一个站点的开关管到
  //   另一个站点的那个。而"我要不要这个插件"针对的是**插件本身**，不是某个站点
  //   给它起的名字。代价是 config.json 里那个键是一个 ULID —— 那个文件由界面改，
  //   不需要人去认它。
  send('app:setPluginEnabled', async (id, enabled) => {
    if (typeof id !== 'string' || !registry.list().some((p) => p.id === id)) {
      return { ok: false, error: `本客户端的插件里没有 id 为 ${JSON.stringify(id)} 的。` };
    }
    if (typeof enabled !== 'boolean') {
      return { ok: false, error: 'enabled 必须是 true 或 false。' };
    }
    config.setPluginEnabled(cfgDir, cfg, id, enabled);
    return { ok: true, plugins: pluginsView() };
  });

  /**
   * 从**一个目录**装一个插件。不给路径就弹一个选目录的框。
   *
   * ★ 这是**本机池**那一半动作，走的是界面上的「开发者」一节（默认关着）。
   *
   * ★ **站点分发不走这里。** 那条注释以前写着"将来分发走的是同一个 installFrom"
   *   —— 现在分发接上了，而它**没有**复用这个函数：这个函数的语义是"用户挑的
   *   目录装进用户自己的池"，与分发（站点说了算、按引用计数回收、换入前要过
   *   同意闸）**相反**。照那句旧注释去复用的人，会把"拒绝覆盖内容不同的同版本"
   *   当成一个 bug —— 而那正是分发**要**的行为（站点换了内容就得重新同意）。
   *   分发在 site-plugins.js，落另一个根。
   */
  send('app:installPlugin', async (srcDir) => {
    let dir = srcDir;
    if (!dir) {
      const r = await dialog.showOpenDialog(win.win, {
        title: '选择插件目录（里面要有 plugin.json）',
        buttonLabel: '装这个',
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      dir = r.filePaths[0];
    }
    const res = pluginInstall.installFrom(ensurePoolDir(), dir);
    if (!res.ok) {
      win.pushNotice('error', res.error);
      return { ok: false, error: res.error };
    }
    registry.reload();
    win.pushNotice('ok', res.already
      ? `${res.plugin.displayName} ${res.plugin.version} 之前就装过，内容一致，没动它。`
      : `已装好 ${res.plugin.displayName} ${res.plugin.version}（${res.plugin.name}）。`);
    return { ok: true, plugins: pluginsView() };
  });

  /**
   * 从池里拿掉一个版本。
   *
   * ★ **不影响正在跑的会话**：会话在创建时就把插件对象攥在手里了（见 controller.plugin），
   *   之后状态变化都用它、不再查表。所以卸载之后那个会话照常被管理、也停得掉 ——
   *   这正是"插件增减不许崩"的最后一格。
   */
  send('app:uninstallPlugin', async (id, version) => {
    const res = pluginInstall.uninstall(poolDir(), id, version);
    if (!res.ok) {
      win.pushNotice('error', res.error);
      return { ok: false, error: res.error };
    }
    registry.reload();
    win.pushNotice('info', `已从本机卸掉 ${id}@${version}。`);
    return { ok: true, plugins: pluginsView() };
  });

  /** 重新扫一遍池。用户手工往里放了东西之后，不用重启客户端。 */
  send('app:rescanPlugins', async () => {
    registry.reload();
    const n = registry.list().length;
    win.pushNotice('info', `已重新扫描插件目录：本机现在有 ${n} 个插件。`);
    return { ok: true, plugins: pluginsView() };
  });

  // ── 站点分发 ──

  /** 手动重新对一次账（界面上那个「重新同步」）。 */
  send('app:syncPlugins', async () => {
    if (!backend || !backend.connected) {
      return { ok: false, error: '还没连上站点 —— 插件是从站点取回来的。' };
    }
    const r = await reconcileSitePlugins();
    if (!r) return { ok: false, error: '这次对账已经作废了（连接换了一条）。' };
    return { ok: true, plugins: pluginsView() };
  });

  /**
   * 同意一个待分发的插件。
   *
   * ★ **落点是有讲究的**：下载后、暂存里验完、`rename` 之前。见 site-plugins.js。
   *
   * ★ **写台账在激活之前。** 反过来（先激活后写）崩在中间 ⇒ 下次启动它是"没同意"
   *   而用户明明点过 ⇒ 会反复问，或者被后来的人"修"成默认同意。选前者。
   *
   * ★ **同意动作绑定到摘要值**：`acceptStaged` 会再核一遍暂存里那份的摘要与对话框
   *   里那个值相同，不同就拒绝 —— 用户同意的是他看到的那个摘要，不是"这个
   *   (id, 版本) 上碰巧躺着的东西"。
   */
  send('app:consentPlugin', async (id, version) => {
    const hit = pendingConsent.find((p) => p.id === id && p.version === version);
    if (!hit) return { ok: false, error: '没有这个待同意的插件（可能已经同意过、或者重新同步过了）。' };

    const mv = sitePluginSync.acceptStaged({
      stagedDir: hit.stagedDir, siteRoot: sitePoolDir(),
      id, version, digest: hit.digest,
    });
    if (!mv.ok) {
      win.pushNotice('error', mv.error);
      return { ok: false, error: mv.error };
    }
    // 换入成功之后再记台账：记完之后它才会被 allows() 放行（下一次 reload）。
    const t = config.trustPlugin(cfgDir, cfg, id, version, mv.digest, hit.siteLabel);
    if (!t.ok) {
      win.pushNotice('error', t.error);
      return { ok: false, error: t.error };
    }
    // ★ **同意这一步也要记进引用表**，不只是"装上"那一步。不记的话，在"刚同意、
    //   还没重新对账"这段窗口里它在引用表上不存在 —— 换到另一个站点时会被按
    //   "没人要它"回收掉。理由见 site-plugins.js 的 noteConsent。
    const nc = sitePluginSync.noteConsent({
      siteRoot: sitePoolDir(), siteKey: hit.siteKey, siteLabel: hit.siteLabel,
      id, version,
    });
    if (!nc.ok) win.pushNotice('warn', `插件装上了，但引用表没能更新（${nc.why}）。`);
    pendingConsent = pendingConsent.filter((p) => !(p.id === id && p.version === version));
    registry.reload();
    const p = registry.get(id, version);
    if (!p || p.active === false) {
      const why = `同意之后它仍然没有被加载 —— 看「插件没有加载」那几条。`;
      win.pushNotice('error', why);
      return { ok: false, error: why, plugins: pluginsView() };
    }
    win.pushNotice('ok', `已同意并装上「${p.displayName}」${p.version}。`);
    return { ok: true, plugins: pluginsView() };
  });

  /** 不同意。**删掉的是暂存里那一份**（我们自己的草稿纸），站点那一份一个字节没动。 */
  send('app:rejectPlugin', async (id, version) => {
    const hit = pendingConsent.find((p) => p.id === id && p.version === version);
    if (!hit) return { ok: false, error: '没有这个待同意的插件。' };
    sitePluginSync.discardStaged(hit.stagedDir);
    pendingConsent = pendingConsent.filter((p) => !(p.id === id && p.version === version));
    win.pushNotice('info', `没有同意「${hit.title || hit.name}」，它在暂存里那一份已经删掉了。`);
    return { ok: true, plugins: pluginsView() };
  });

  /**
   * 开发者模式：本机池加不加载。
   *
   * ★ 它是**用户的设置，不是站点的能力** —— 所以"关着 + 老守护进程 = 一个插件都
   *   没有"是正确结果，不是需要被兜掉的失败（见 site-plugins.js 的文件头）。
   */
  send('app:setDevPlugins', async (on) => {
    if (typeof on !== 'boolean') return { ok: false, error: 'on 必须是 true 或 false。' };
    if (DEMO_FLAG) return { ok: false, error: '演示模式下这一项恒开。' };
    config.setDevPlugins(cfgDir, cfg, on);
    registry.reload();
    const n = registry.list().filter((p) => p.source === 'pool').length;
    win.pushNotice('info', on
      ? `开发者模式已打开：本机插件目录里有 ${n} 个插件被加载了。`
      : '开发者模式已关掉：本机插件目录不再加载，插件只认站点分发的那一份。');
    return { ok: true, plugins: pluginsView() };
  });

  /** 在文件管理器里打开池目录 —— "我该往哪放"这个问题的最终答案。 */
  send('app:openPluginDir', async () => {
    const dir = ensurePoolDir();
    if (!dir) return { ok: false, error: '插件目录拿不到。' };
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true, path: dir };
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

  send('app:reload', async () => { await win.reloadSurface(); return { ok: true }; });

  send('app:openExternal', async (url) => { await shell.openExternal(url); return { ok: true }; });

  // 演示模式的调试控制 —— 复现那些在真机上极难复现的状态
  send('app:debug', async (what, arg) => {
    if (backend.kind !== 'demo') return { ok: false, error: '仅演示模式可用' };
    if (what === 'daemon-down') backend.debugDaemonDown(20000);
    else if (what === 'tunnel-down') backend.debugTunnelDown(15000);
    else if (what === 'reap') backend.debugReap();
    else if (what === 'reset') backend.debugReset();
    // 让演示站点"装了本客户端不认识的插件" / "把某个插件关掉" ——
    // 这两条路是"插件增减不许崩"的验收路径，必须能在演示模式下走到。
    else if (what === 'extra-plugin') backend.debugAddSitePlugin('jupyter', 'JupyterLab');
    // ★ 站点侧那三个开关作用在**哪一个**插件上由调用方指定（不指定就取列表里
    //   第一个）—— 基座里没有插件名可写。一个都没装时这些开关无事可做，如实
    //   说出来，而不是静默地什么也没发生。
    else if (what === 'site-plugin-off' || what === 'site-plugin-no-job') {
      const picked = pickPoolPlugin(arg);
      if (picked.error) return { ok: false, error: picked.error };
      // 这两件事**不一样**，所以是两个开关、两个 debug 方法：`off` 是管理员的
      // 开关（界面说"本站没开放它，找管理员"）；`no-job` 是本站部署没跟上
      // （界面说"装了它，但它没有作业侧实现"—— 管理员去开一下开关没用）。
      if (what === 'site-plugin-off') backend.debugDisableSitePlugin(picked.plugin.name);
      else backend.debugSitePluginNoJob(picked.plugin.name);
    }
    // 演示「守护进程太旧，连 plugins 这个 op 都没有」—— 那条路上**每一个**字段
    // 都是缺的，而客户端的纪律是"缺席 ≠ 否"。
    else if (what === 'old-daemon') backend.debugOldDaemon(true);
    // ★ 与上一条是**两件事**：这一档有 `plugins`、但没有 `limits`（v0.5 的守护
    //   进程）。客户端的处理必须一样（回退），但代码路径不同（一个是 unknown_op，
    //   一个是字段缺席）—— 只造其中一条的话，另一条上的退化没人看得见。
    else if (what === 'old-distribute') backend.debugOldDistribute(true);
    // 站点报了一个超过单文件上限的文件 ⇒ 「站点支持分发，但这一份装不上」。
    else if (what === 'plugin-too-big') backend.debugBloatPlugin(arg || null);
    // 限流不是失败：假后端先回几次 rate_limited，对账必须**退避之后照样成功**。
    else if (what === 'rate-limited') backend.debugRateLimit(Number(arg) || 3);
    // 把仓库里的示例插件装进演示池。
    //
    // ★ 这不是"演示模式自带的假插件"—— 它装的是**真的**那两个插件，走的是真的
    //   安装路径（installFrom）。演示池为空时，这是本机唯一能看见界面的办法，
    //   顺带也就把"手工安装"那条路本身验了一遍。
    //
    // 打包之后没有仓库目录，所以它只在从源码跑的时候有用 —— 那正是它的用途。
    else if (what === 'install-samples') {
      const src = path.join(__dirname, '..', '..', '..', 'plugins');
      let names;
      try {
        names = fs.readdirSync(src).filter((n) => fs.existsSync(path.join(src, n, 'plugin.json')));
      } catch {
        return { ok: false, error: `这台机器上找不到示例插件目录 ${src}（打包之后就没有它了）。` };
      }
      if (!names.length) return { ok: false, error: `${src} 里一个插件都没有。` };
      const done = [];
      for (const n of names) {
        const r = pluginInstall.installFrom(ensurePoolDir(), path.join(src, n));
        if (!r.ok) {
          win.pushNotice('error', r.error);
          return { ok: false, error: r.error };
        }
        done.push(`${r.plugin.name} ${r.plugin.version}${r.already ? '（已有）' : ''}`);
      }
      registry.reload();
      win.pushNotice('ok', `已把示例插件装进演示池：${done.join('、')}。`);
      return { ok: true, plugins: pluginsView() };
    }
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
  webLogin: weblogin.webLogin,
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
     *
     * ★ 但光把引用清掉还不够：真机上重启时**这个进程整个没了**，它的监听套接字、
     *   轮询、心跳跟着一起消失；只在同一个进程里换个引用的话，模拟出来的现场是
     *   **两个客户端同时在跑** —— 旧的那个还占着端口在监听、还在轮询状态，收尾时
     *   进程退不掉（症状是整个测试文件凭空多花几十秒，而每条用例自己都是绿的）。
     *   所以旧的先 `abandon()` —— 只释放本地资源，一个字都不发给服务端。
     */
    reattach: async () => {
      const old = controller;
      controller = null;
      if (old) await old.abandon();
      return tryReattach();
    },
    /** 插件注册表。测试用它验证「未知插件不崩」「重新扫描模拟装/卸插件」。 */
    getRegistry: () => registry,
    /** 界面会看到的插件视图（四个条件求交的结果，见 pluginsView）。 */
    getPluginsView: () => pluginsView(),
    /** 站点通报的插件清单（op_plugins 的原始响应）。 */
    getSitePlugins: () => sitePlugins,
    /**
     * 等这一次站点对账跑完。
     *
     * ★ 真机上**没有人等它**（它是后台的，跑完推一份视图给界面就完了）。测试必须
     *   等 —— 不等的话断言的是"下载还没跑完的那一刻"，而那种用例红或绿都说明不了
     *   任何事。
     */
    awaitSiteSync: () => (siteSyncPromise || Promise.resolve(null)),
    /** 上一次对账的结果（三态的原样）。 */
    getSiteSync: () => siteSync,
    /** 待同意的那些。 */
    getPendingConsent: () => pendingConsent,
    /** 站点池与暂存目录在哪（测试要直接看盘上的东西）。 */
    getSitePoolDir: () => sitePoolDir(),
    getSiteStagingDir: () => siteStagingDir(),
  },
};
