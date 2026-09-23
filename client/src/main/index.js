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
 * ── 开发者模式：怎么进、怎么标注、为什么要有 ──────────────────────────────
 *
 * 打开它之后客户端**不连集群**，改用 `backend-fake.js` 那个本地模拟站点。
 *
 * ★ **它是给谁的**：写插件的人、改这个客户端的人。普通用户不需要它，所以它是一个
 *   摆在界面上的开关，**默认关着、未配置时也不会自己打开**。
 *
 * ★ **入口是开关，不是命令行。** 从前是 `electron . --demo`（`package.json` 里那个
 *   `demo` 脚本）。那等于说"Windows 用户请去开一个终端"—— 而这是一个图形应用，
 *   而且它给人的感觉是"必须在安装时选好"。今天它在界面里，随时可开可关。
 *
 * ★ **三重互锁**（做了假后端却不标注，正是这个项目一路在清的那类问题：
 *   **系统声称了不成立的事**）：
 *     ① 独立的数据命名空间（`<userData>/dev-sandbox/`，**绝不**碰用户自己那份配置）
 *     ② 窗口标题、状态条标记、面板横幅，用真实模式绝不会出现的颜色（洋红）
 *     ③ 启动时那一次选择：`dev` 为真才走假后端，没有第二条路，也不会在真后端
 *        出错时静默退回来（见 backend.js 的 createBackend）。
 *
 * ★ **两个设置都是"重启后生效"**：换后端要重建整个客户端；插件来源改的是一棵树的
 *   快照。界面上明说，并且给一个「立即重启」的按钮 —— 不做静默的半生效。
 */

const { app, BrowserWindow, ipcMain, session: electronSession, safeStorage, shell, clipboard,
        dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const config = require('./config.js');
const pluginData = require('./plugin-data.js');
const dataAudit = require('./plugin-data-audit.js');
const keys = require('./keys.js');
const hosts = require('./hosts.js');
// ★ `KIND` 也引进来：主进程里有好几处要问"这是不是那个假后端"。写字面量
//   `'fake'` 的话，将来改这个名字会漏掉一处，而漏掉的那一处不会有任何提示。
const { createBackend, KIND } = require('./backend.js');
const { SessionController, State, SERVER_LIVE_STATES } = require('./session.js');
const { ShellWindow } = require('./windows.js');
const { installMenu, attachKeyGuard } = require('./shortcuts.js');
const weblogin = require('./weblogin.js');
const plugins = require('./plugins/index.js');
const sitePluginSync = require('./site-plugins.js');
// ★ 从模块上摘下来，而不是在函数里写 `plugins.shortDigest` —— `pluginsView()` 里
//   有一个同名的局部数组（那些插件记录），函数内写 `plugins.` 会指到它身上。
const shortDigest = plugins.shortDigest;

/**
 * 开发者模式：**生效值**与**盘上那个值**。
 *
 * ★ 两者必须分开，它们回答的是两个不同的问题：
 *     `on`    这次进程在不在开发者模式。启动时读一次，**之后不再变**（换后端要
 *             重建整个客户端，见 createBackend）。
 *     `saved` 用户在界面上要的是哪一个。改开关只动它。
 *   两者不同 = 有改动等着重启 —— 界面据此说「重启后生效」，而不是让人以为点了没反应。
 *   ★ 判据只有一个：**别拿 `saved` 去决定这次进程怎么跑**。
 *
 * ★ `pluginDir` 是**假站点的插件来源**（插件作者指向自己那棵树用的）。`null` =
 *   用默认的（仓库里的 `plugins/`）。同样有生效值/盘上值两份，理由同上。
 *
 * ★ 模块加载期是"关着"的：真值要等 app ready 之后读得到 userData 才知道，而
 *   `registry` 是在模块加载期构造的 —— 那一刻看到一个"关着"的世界是对的。
 */
let dev = { developerMode: false, pluginDir: null };
let devSaved = { developerMode: false, pluginDir: null };

let win = null;
let backend = null;
/**
 * 活着的会话：**槽 → 记录**（槽见 `plugin-data.js` 的 `slotOf`）。
 *
 * ★ 这里从前是 `let controller = null`。单值能成立，靠的是"同一时刻只有一个会话"
 *   这条**假设**，而假设不是判据 —— 它的失败形态是：起中转站时把 code-server 那块
 *   界面收掉、关窗只掐断两条会话里的一条、插件拿错**别人的**会话口令。
 *
 * ★ 键是**槽**而不是 sessionId：会话在提交回来之前还没有 id，而"这个槽被占了"
 *   从用户按下「开始」那一刻起就必须成立。
 *
 * ★ 记录里留着 `plugin`，与从前 `controller.plugin` 是同一条纪律：**起它那一刻
 *   捕获**，之后所有状态变化都用它、不再查注册表（站点会升级，而一个跑着的会话
 *   用的是它提交时那一份代码）。
 */
let sessions = new Map();
/**
 * **临时布局组**：`id → {id, name, port}`，形状与 `config.normalizeLayout` 的产物
 * **逐字同形**（于是凡是拿一个组去用的地方，拿到临时组也不需要分支）。
 *
 * ★ **只在内存里，一个字都不落盘。** 它不是"一个还没保存的组"，而是**故意不存在于
 *   配置里**的一种组：配置里的组有引用计数、会被 `pruneLayouts` 回收、会被对账
 *   当成"该有的" —— 而临时组的全部意义就是"它属于**这一次会话**，会话结束就没了"。
 *   落盘会让它在下次启动时变成一个真的组（引用计数 0 ⇒ 当场被回收 ⇒ 但那之前
 *   `layoutPlan` 会把它报给界面，用户看到一堆自己没建过的组）。
 *
 * ★ **谁能进来只有一个来源**：`claimInstance` 造它。它今天只服务一件事 ——
 *   一个声明了 `concurrent: true` 的插件要开第二份时，给第二份一个**自己的**
 *   实例键（= 一个自己的端口 = 一个自己的 origin = 一份空的浏览器存储）。
 *
 * ★ **"这条会话是不是临时的"这个问题只问这一个 Map**（见 `sessionViews`）——
 *   绝不在会话记录上再存一个布尔：两份状态会漂，而漂的后果是**漏回收**（留一份
 *   永远没人清的目录）或者**误回收**（把持久那份的数据删掉）。
 */
let tempLayouts = new Map();
let cfgDir = null;
let cfg = null;
/**
 * 钉子表：`id → 公钥指纹`（§5.4）。**单独一个文件**，见 config.js 那一段。
 *
 * ★ 它**不是** `cfg` 的一部分，所以这里单独持有一份。`pinPluginKey` 就地改这个
 *   对象并且落盘 —— 也就是注册表那边（`allows`）看到的永远是当下的那一份。
 *
 * ★ 模块加载期是 `{}`（空表）：那时 `cfgDir` 还没定下来。空表 = "从没钉过"，
 *   而在能拿到真表之前一个插件都加载不了，两者同归一处。
 */
let pins = {};
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
 * 连接期那次版本判定的结论（`applyVersionGate` 填，见那里）。
 *
 * ★ 它是一个**连接级**的事实，不是每一轮同步的事实 —— 所以不塞进 `siteSync`
 *   （那是"这一轮同步看到了什么"），而是与它并列地进视图。
 * ★ 断开时清掉：它说的是"这一条连接对面是谁"，连着的那条没了它就不再成立。
 */
let versionVerdict = null;

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
 * 少了它，开发者模式（测试桩里 safeStorage 一律不可用）下每连一次就会换一把钥匙，
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

    // ★ **先读开发者模式那两个设置，再决定读哪一份配置。** 次序不能反 —— 这个开关
    //   回答的正是"这次启动读哪一份"，所以它自己**不在任何一份配置里**（见
    //   config.js 的 devSettingsPath）。
    const userData = app.getPath('userData');
    devSaved = config.loadDevSettings(userData);
    dev = { ...devSaved };

    // 开发者模式用独立目录 —— 否则沙盒里配的用户名/端口会污染真连接。
    // ★ 名字里没有"demo"了：那个概念整个不存在，而这是一个**沙盒**（它持久，
    //   但不是用户真正在用的那一份数据）。
    cfgDir = dev.developerMode
      ? path.join(userData, 'dev-sandbox')
      : userData;
    cfg = config.loadConfig(cfgDir);
    // ★ 钉子在**另一个文件**里（见 config.js 那一段）：旧版本读一遍 `config.json`
    //   再存一遍就会把不认识的那张表抹掉，而"钉子全没了"= §2.5 的分身判据有了一
    //   个重置按钮。所以它自己一个文件、自己一次读。
    pins = config.loadPinnedKeys(cfgDir);

    // ★ 池目录依赖 cfgDir，而注册表是在**模块加载期**建的，那时 cfgDir 还是 null。
    //   所以拿到真路径之后重新扫一遍 —— 否则开发者模式会去读进程当前目录下的
    //   `./site-plugins`，而那是谁的地方说不清。
    ensureSitePoolDir();
    registry.reload();

    backend = createBackend({
      dev: dev.developerMode,
      fake: {
        // 只影响假站点「登记」要等多久，好让你（和测试）能看到排队态，
        // 或者反过来跳过它。真实后端完全不读这个。
        enrollDelayMs: Number.isFinite(Number(process.env.SLURMATE_DEV_ENROLL_MS))
          ? Number(process.env.SLURMATE_DEV_ENROLL_MS) : undefined,
        // ★ 假站点的**分发源**：默认是仓库里的 `plugins/`，插件作者可以在界面上
        //   改成自己那棵树（见 devPluginSourceDir）。那是一份真实文件（真的
        //   sha256、真的字节），于是「站点有而本机没有」这条最重要的路径真的走得到：
        //   池空的时候站点照样报那些插件，对账真的把它们取下来、真的要求同意。
        //
        // ★ 传**函数**而不是路径：来源可以在运行期被改（重启后生效），而"这个目录
        //   现在在哪"必须是每次现算的结果。
        sitePluginDir: devPluginSourceDir,
      },
    });

    win = new ShellWindow({
      onClose: handleWindowClose,
      onAction: handleWindowAction,
    });

    // ★ **本机池那个目录不再被读了，说一句。** 它从前是 `~/.slurmate/plugins`，
    //   用户自己装插件的地方；那条路连同"免同意"一起删掉了。**目录不删** ——
    //   0.2.0 是最后一个公开版本，而它带着本机池，所以升级上来的人那里可能真的
    //   躺着东西（那是他们自己的文件，删它是另一回事）。
    //   ★ 只在**真的有东西**时说：空目录、或者从来没用过本机池的人，不该看见一条
    //     关于它的话 —— 那是噪音，而且会让人以为自己做错了什么。
    warnLegacyPool();
    // ★ 假站点的插件来源一个插件都读不出来时**说一句**。这一步不是美化：来源可能
    //   是"安装包里根本没有仓库的 plugins/"，也可能是作者刚选错了一个目录 ——
    //   两种情况的症状都是"假站点一个插件都不报"，而界面上那句话说不清是为什么。
    warnDevPluginSource();

    // 快捷键拦截：黑名单 + 诊断。
    //
    // ★ 诊断**只装在开发者模式**。它的用途是「验证按键到底有没有直达页面」，而那件
    //   事只在拿假后端做对照时才需要看；真实模式里用户是在干活，不是在校验外壳。
    //   常开的代价很具体：每按一次带修饰键的键、每按一次 F 键都往日志里写一行，
    //   而按住 Ctrl 时操作系统会**连续**产生 keyDown —— 日志会被
    //   「已放行：Ctrl+Control」刷满，把真正要紧的消息顶掉。
    //   被我们**吞掉**的键（F12 之类）仍然照报：那是在解释「为什么按了没反应」，
    //   是用户自己触发的、想问的问题。
    attachKeyGuard(win.win.webContents, {
      // 「重新加载页面」这个键打的是**前台**那一块 —— 屏幕只有一块，而用户按
      // 快捷键时看的正是它。
      onOwned: (action) => {
        if (action !== 'reload') return;
        const slot = frontSlot();
        if (slot) win.reloadSurface(slot);
      },
      onBlocked: (desc) => {
        win.pushNotice('key-blocked', desc);
        if (backend.kind === KIND.FAKE) win.pushSwallowed(desc);
      },
      ...(backend.kind === KIND.FAKE
        ? { onSeen: (desc) => win.pushNotice('key-seen', desc) }
        : {}),
    });

    registerIpc();

    // 开局那一屏：**零条会话**（`_sessions` 空 ⇒ 关窗不会问，正是要的）。
    win.setSessions([]);
    win.pushSessions([], null);
    await announceBackend();

    // 启动时看看有没有「上次没关干净的会话」—— 自动接上，而不是让用户重新提交
    await tryReattach();
  });

  app.on('before-quit', async (e) => {
    if (quitting || !sessions.size) return;
    quitting = true;
    e.preventDefault();
    win.setBusy(false);
    // ★★ 走**唯一那份**实现（见 `stopAllSessions`）。从前这里只看那唯一的
    //   `controller`，多开之后只补一个，剩下的会话在控制节点上停在一个"客户端已经
    //   退出、而它还以为有人连着"的状态，要等 1800 秒的孤儿判定才被 scancel。
    try {
      for (const { sessionId, res } of await stopAllSessions()) {
        if (!res.ok && sessionId) {
          // 落盘待补发。**下次启动时补发** —— 这就是「跨崩溃的可靠投递」。
          // 注意：绝不用 process.on('exit') 做这件事，那里只能跑同步代码，发不出网络请求。
          config.addPendingGoodbye(cfgDir, sessionId);
        }
      }
    } catch (err) {
      // 退出这条路**绝不能因为收尾失败就走不掉**：用户按的是关闭，不是"重试释放"。
      win.pushNotice('error', '结束会话时出错：' + err.message);
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

  // 旧版本那份**明文**密钥不再读（理由见 config.js 里 SECRET_ENCRYPTED 那段）：
  // 它今天与别的认不出的 mode 走同一条路，报 bad_mode。

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
  if (r.ok) return r;
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
  if (backend.kind === KIND.FAKE) {
    // ★ 假后端**也要** connect —— 它在那一步启动本地 HTTP 服务并分配端口。
    //   曾经这里提前 return，结果是 service_port 恒为 0，
    //   隧道目标变成 "127.0.0.1:0"，会话在「运行中」之后立刻报端口不合法。
    //   开发者模式不等于「不需要初始化」。
    const res = await backend.connect({ user: 'demo', host: '127.0.0.1', port: 1 });
    if (res.ok) {
      // ★ 假后端也要过这道闸 —— 否则"版本不符会怎样"在界面上的样子没有地方能
      //   先看一遍，而它恰恰是用户会遇到、开发者却很难复现的状态。
      //   用 `app:debug daemon-version` 造。
      const gated = await applyVersionGate(res);
      if (!gated.ok) {
        win.pushNotice('error', gated.error);
        win.setTitle('Slurmate — 开发者模式 · 未连接集群');
        return;
      }
      whoami = res.whoami;
      await refreshPartitions();
      // 假站点也真的走一遍分发（分发源见 devPluginSourceDir）。
      reconcileSitePlugins();
    }
    // ★ 通知 kind `'dev'`：界面据它挂那条洋红横幅（三重互锁的第二重）。
    win.pushNotice('dev', '开发者模式 · 未连接集群');
    win.setTitle('Slurmate — 开发者模式 · 未连接集群');
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

/**
 * 版本闸 —— **唯一一处**执行「服务端要求客户端不低于它自己」的地方。
 *
 * ★ 它住在这里（而不是两个后端各自的 `connect` 里），因为这里（index.js）是
 *   假后端与真实后端**唯一的交汇点**。同一条规则写在两处，下一次就会漂成
 *   "开发者模式里说得通、真机上不生效"，而这个假后端全部的价值就是它演的是同一件事。
 *
 * ★ 判定在 `plugins/index.js` 的 `versionCheck` 里 —— 规则只有那一份书面形式，
 *   判据是 `tools/version-fixtures.json` 的 `check` 段。
 *
 * ★ **它发生在任何会话之前**，这一点是"拦住"能成立的全部理由：连接没成就从来
 *   没有 `submit` ⇒ 没有 `session_id` ⇒ 没有心跳 ⇒ 于是也不会经由 `orphan_after`
 *   把用户正在跑的作业 scancel 掉。★ **判定只在连接时做一次，绝不在会话进行中
 *   重新判定**（守护进程被就地升级会断开连接 ⇒ 走重连 ⇒ 那时再判，那才是对的
 *   时机；在心跳那条路上判会把用户的作业判没）。
 *
 * ★ 只有 `client_behind` 拦人。另外四种态各自**大声说明**，但都放行 —— 它们
 *   要么是"缺席"（没问到 / 读不到自己），要么是两个大版本之间**不保证、也不
 *   断言**不兼容。把它们也拦掉，就等于把"我们不知道"说成"不行"。
 */
async function applyVersionGate(res) {
  const mine = plugins.hostVersion();
  const g = plugins.versionCheck(mine, res.daemonVersion);
  const theirs = JSON.stringify(res.daemonVersion);
  // 记下来给界面用（`site_too_new` 那一句要拿它说准，见 panel.js）。
  versionVerdict = g.verdict;

  if (g.blocked) {
    // 先把连接关掉：绝不留一条"连上了、但不许用"的连接在那儿占着守护进程的
    // 配额与端口池。close() 会把重连也停掉（它置 _closed），所以不会变成
    // 每隔几秒敲一次守护进程的循环。
    await backend.close();
    return {
      ok: false,
      code: 'client_behind',
      error: `集群上的服务端是 ${res.daemonVersion}，而这个客户端是 ${mine} —— `
        + '同一个大版本内，服务端要求客户端不低于它自己（两端是一起升的，'
        + '而这个客户端不保证读得懂更新的一版）。请升级客户端之后重连。',
    };
  }

  if (g.verdict === 'cross_major') {
    win.pushNotice('warn',
      `这个集群的服务端是 ${res.daemonVersion}，本客户端是 ${mine} —— 两端**大版本不同**。`
      + (g.order < 0
        ? '服务端更新，本客户端不一定兼容它。'
        : '这个集群是更老的一代；本客户端不一定兼容它。')
      + '（大版本不同不等于不兼容，所以这一次照常连。多个集群之间大版本不同是正常的。）');
  } else if (g.verdict === 'unknown_server') {
    win.pushNotice('info',
      `没有问到站点的基座版本（对面的守护进程没有 \`ping\` 这个 op，也就是比本客户端旧），`
      + '所以这一次**没有做版本判定**。这不会让判定变松：一个连 `ping` 都没有的'
      + '守护进程不可能比本客户端新。');
  } else if (g.verdict === 'not_our_daemon') {
    win.pushNotice('warn',
      `站点答的版本号 ${theirs} 不合 x.y 的形状 —— 这条链路上答话的恐怕不是 `
      + 'Slurmate 的守护进程。这一次**没有做版本判定**：那不是"通过了"，是"没判"。');
  } else if (g.verdict === 'unknown_host') {
    win.pushNotice('warn',
      '本客户端读不到自己的版本号（client/package.json），所以这一次没有做版本判定。'
      + '插件仍然可以同步，但**一个都装不上** —— 装之前要拿本客户端的版本去比'
      + '插件声明的引擎范围，而那个版本现在读不到。');
  }
  return res;
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
    // ★ 版本闸在最前面：不通过就到这里为止，一次会话都不建。
    const gated = await applyVersionGate(res);
    if (!gated.ok) {
      win.pushNotice('error', gated.error);
      win.setTitle('Slurmate — 未连接');
      return gated;
    }
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
        // ★ **全部**连接的站点键，不是只有当前这一条：池是公共的，另一条连接要的
        //   版本也得留着。对账据此把记录里那些"连接已经没了"的站点条目删掉 ——
        //   站点键含 `user@host:port`，所以改一次主机名就是另一个键，而旧条目留着
        //   会让它那些版本**永远不会被回收**（见 site-plugins.js 第 5 步）。
        keepSites: (cfg.connections || []).map((c) => sitePluginSync.siteKeyOf(c)),
        trusted: (id, version, digest) => config.isTrusted(cfg, id, version, digest),
        // §5.3：本机那一份不在了 ⇒ 台账那条一并消失 ⇒ 同一个对账里它走进待同意。
        // **删就删在信任判定的前面**，所以"静默装回来"这条路结构上不存在。
        forgetTrust: (id, version) => config.forgetPlugin(cfgDir, cfg, id, version),
        // §5.4：本机钉住的那把公钥。`undefined` = 从没钉过（首次即信任）。
        pinnedKey: (id) => config.pinnedKeyOf(pins, id),
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
      withdrawn: r.withdrawn || [],
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
 * 调试开关要作用在**哪一个**插件上：调用方给短名，不给就取列表里第一个。
 * 基座里没有插件名可写，所以"是哪一个"只可能由调用方说。
 *
 * ★ 名字从前是 `pickPoolPlugin`（"池"指本机池）。池只剩一个之后，那个名字会让人
 *   以为它跟某个已经不存在的第二条来路有关系 —— 它做的只是"从注册表里挑一个"。
 *
 * 一个都没装时**如实返回一条 error**，而不是静默地什么也没发生 —— 后者会让调试的人
 * 以为是界面没刷新，然后去查一个不存在的问题。
 *
 * @returns {{plugin: object}|{error: string}}
 */
function pickPlugin(name) {
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
      // ★ 这里从前有 `source` / `sources` / `sourceLabel` 三个字段（回答"这一份是
      //   哪个池给的"）。客户端**只剩一个池**（站点池）之后它们恒为一项 / 恒为
      //   `null`，v0.7 把它们连同注册表里那个 `source` 字段一起删了 —— 一句永远
      //   说不出话的字段与一条永远说错的标签是同一类东西：看的人会以为自己看到的
      //   是两条来路。（账本 S20。）
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
      //   或者问管理员为什么这个站点不分发它）。
      //
      // ❗ 判据必须**问 `deliveryOf`**，不能在这里现写一个。它变过两次：最早是
      //    `Array.isArray(p.files)`；v0.6 两条投递方式都在，于是"能走一条就算"；
      //    v0.7 只剩包那一条。「能不能分发」这个问题只有一处答案，而它在那里。
      distributed: Boolean(sitePluginSync.deliveryOf(p, sitePluginSync.HARD_LIMITS).mode),
    }));

  // ── 池里那些**没被加载**的（`active: false`）───────────────────────────────
  //
  // ★ 这一段以前只算了一个**数**（`inertCount`），而那个数**从来没有被渲染过**
  //   （`panel.js` 里零次出现）。后果是一个真的洞：
  //
  //     `plugins` 那一列把 `active === false` 的滤掉了；`missing` 又要求
  //     `registry.get` **取不到**它 —— 而它恰恰在注册表里（`active: false` 的那
  //     一条）。于是"池里有一份、台账对不上"的站点插件**两条路都不在**：
  //     界面上彻底看不见，连"点同意"的入口都没有，重新同步也救不回来。
  //
  //   ★ 摘要换一次公式，这条路会**一次性对每个用户的每个插件成立** ——
  //     集体消失、无从恢复。所以它不是美化项。
  //
  // ★ 待同意的那些**不在这里**：它们由 `consent` 那一块专门画（那里有"同意"
  //   按钮）。两处都画的话，用户会看到同一个插件两个块，而各自说着一半的话。
  const pendingKeys = new Set(pendingConsent.map((p) => `${p.id}@${p.version}`));
  const inert = records
    .filter((p) => p.active === false && !pendingKeys.has(`${p.id}@${p.version}`))
    .map((p) => ({
      id: p.id, version: p.version, name: p.name, title: p.displayName,
      // 为什么它没被加载。今天只有一种：**代码还没过同意闸**，而站点此刻没有在
      // 报它（所以没有"同意"这个入口）。写成字段而不是让界面去猜 —— 界面手里
      // 那份视图随时可能陈旧。
      why: 'unconsented',
    }));

  return {
    plugins,
    // **这是升级提示的唯一来源** —— 过滤掉它们，用户就永远不知道自己少了什么。
    missing,
    // 池里同 `(id, 版本)` 撞了（两个不同的东西在抢同一个身份）而被全部跳过的，
    // 以及插件目录里扫到的坏文件。它们被跳过了，客户端照常工作 —— 但必须说出来，
    // 否则用户面对的症状只是"加了插件它就是不生效"。
    errors: registry.errors,
    // 池**在哪** —— 站点分发那一栏用它判断"要不要画那一块"（见 panel.js 的
    // renderSitePlugins）。它在这里而不是在 `site` 里面：**站点连不上时那一栏
    // 照样得画**，因为池里可能已经有东西了。
    //
    // ★ 从前这里还有一个 `poolDir`（本机池在哪），而它同时是"我该往哪放"那个
    //   问题的答案。**那个问题现在没有答案，也不该有** —— 插件只有一条来的路
    //   （站点分发），用户没有任何需要往目录里放东西的场合（§5.1）。
    sitePoolDir: sitePoolDir(),
    // ★ 这一条是**承重的**：本机一个插件都没装时，站点上**每一个**插件都会落进
    //   `missing`，于是界面会把它们全都说成「本站有而本机没有 —— 升级客户端」。
    //   而真相是「你还没装插件」—— 那两件事的行动完全不同（去拿 vs 去升级）。
    //   界面靠 `installedCount === 0` 分岔，见 panel.js 的 renderPlugins。
    //   ★ 只数**能用的**那些。把待同意的也算进去的话，「一个插件都没装」的空态
    //   再也走不到 —— 而那个空态正是用户第一次打开客户端时要看的那块地方。
    installedCount: plugins.length,
    // ★ 从前这里还有一个 `inertCount`（`records.length - plugins.length`），
    //   **删了**：界面一次都没读过它（`panel.js` 里零次出现）。真正要画的是下面
    //   那个 `inert` 列表 —— 一个数说不出"是哪一个、为什么"，而这一段修的那个洞
    //   恰恰需要说出是哪一个。
    // ★ 而这一列是**那些没能走进"待同意"的**：站点此刻不报它们，所以连点同意的
    //   入口都没有。界面必须把它们画出来并给一个出口（删掉本机那一份）。
    inert,

    // ── 站点分发那一节 ──
    //
    // ★ 两条「你没有这个插件」的理由**必须分开报**，因为它们要做的事不同：
    //     站点守护进程太旧   → 找管理员升级站点
    //     站点支持但没下来    → 看下面 `failed` 里那一句（可能是网络、可能是配置）
    //   合并成一句"同步失败"的话，用户就只能一个个试。
    //
    // ★ **从前这里还有第三条**（「本机池里有、但开发者模式关着 → 自己去勾一下」），
    //   它随本机池一起删掉了。今天池里有什么就加载什么，没有"关着不加载"这一态。
    site: siteSync ? {
      supported: siteSync.supported,
      reason: siteSync.reason || null,
      error: siteSync.error || null,
      label: siteSync.label || null,
      syncedAt: siteSync.syncedAt || null,
      // 连接期那次版本判定（见 applyVersionGate）。界面用它把 `site_too_new`
      // 那一句说准 —— 那是**唯一**一处界面的说法取决于握手结论的地方，理由见
      // panel.js 里那一段：握过手就说明服务端不新，于是"站点太新"只能是别的原因。
      daemonVersionVerdict: versionVerdict,
      failed: siteSync.failed || [],
      // ★ 从前这里还有一个 `reclaimed`（回收掉几个版本的**数**）。**删了**：
      //   `siteSync.reclaimed` 只被 `index.js` 的同步结果处理读过（那里用它
      //   推一条通知），视图这一份没有任何界面读它。回收的后果用户看得到的是
      //   下面 `versions` 那一栏 —— 哪几个版本还在、还被谁要。
      // §5.3：本机那一份不在了 ⇒ 同意作废。**只报数**，文案在界面里 ——
      // 而那条文案绝不断言是谁删的（客户端不知道原因）。
      withdrawn: (siteSync.withdrawn || []).length,
      recordOk: siteSync.recordOk !== false,
      // 池里每个版本**被哪些站点要** —— 这是那一栏唯一值得显示的东西，它解释了
      // "为什么这台机器上有两个版本"。读自快照表（`.sites.json`）。
      versions: siteVersions(),
    } : null,
    // 待同意的：**不下发暂存路径** —— 那是主进程的现场，界面不需要知道它在哪。
    consent: pendingConsent.map((p) => ({
      id: p.id, version: p.version, name: p.name, title: p.title,
      // `digest` 是给人一眼分得开的**短形**；`fullDigest` 是**不截断的 64 位**，
      // 界面把它整串画出来（见 panel.js 那一处）—— 它是用户与站点 `--check-plugins`
      // 报的那一串逐个字符核对的凭据，也是同意闸唯一能给的证据。
      digest: shortDigest(p.digest), fullDigest: p.digest,
      // ★ 这个摘要**是哪一个公式**算出来的。界面拿它比对上一次那条的 `alg` ——
      //   不同就说明"我们换了一把尺子"，那是**另一件事**，不能说成"内容变了"。
      digestAlg: config.TRUST_ALG,
      // ★ 本机**已经**有一份（只是台账对不上），还是刚取回来的一份草稿：
      //   前者点同意是"原地认领"、点不同意是"删掉池里那一份"；后者是"换入"与
      //   "丢掉草稿"。两件事，文案与后果都不同，所以界面必须分得开。
      existing: Boolean(p.existing),
      // §5.4：这一份是谁签的。`null` = 没有签名 —— 那句话必须说清"没有签名"，
      // 而不是留白（留白会被读成"还没显示出来"）。
      fingerprint: p.fingerprint || null,
      siteLabel: p.siteLabel, fileCount: (p.files || []).length,
      // ★ 这一份**核到什么程度**。本机只有树、包不在了时是 `false` —— 那一次
      //   只核了内容摘要，没法逐份比对。少做的那一半要在用户点同意的那一屏说
      //   出来：一次"只核了一半"的核对，不许看起来与做全了的那次一样。
      compared: p.compared !== false,
      // 同 (id, 版本) 以前同意过吗？—— 有的话这一次**内容变了**，界面上要说出来。
      previous: (() => {
        const e = cfg && cfg.trustedPlugins && cfg.trustedPlugins[config.trustKey(p.id, p.version)];
        return e ? { digest: shortDigest(e.digest), at: e.at, alg: config.trustAlgOf(e) } : null;
      })(),
    })),
  };
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
    // 旁边那个 `<版本>.splug` 在不在。**如实报**（见 site-plugins.js 的文件头）：
    // 包单独不在了不构成撤回，也不会被静默取回来 —— 但用户打开那个目录就会发现
    // 少了一个文件，所以不能瞒着不说。
    hasPackage: Boolean(it.hasPackage),
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

/**
 * 这次会话该用哪个布局组。
 *
 * 有连接就用**它**的组（正常路径）。但**开发者模式里一个连接都没有**，那里也必须能
 * 开会话 —— 所以退回到「已有的第一个组，没有就建一个」。
 * （pruneLayouts 对「一条连接都没有」的情形不回收，正是为了让这一步造出来的组
 *   能活过下一次 commitConfig，否则每次开会话都会换一个 partition。）
 *
 * ★ 收的是**那条连接**，不是"当前活跃的那条" —— 多开之后两者会分家。调用方读一次、
 *   让布局组与 `ctx.connection()` 共用**同一个**对象，它们就不会指向两条连接。
 */
function layoutForSession(conn) {
  const id = conn ? conn.layoutId : null;
  if (id) return id;
  if (cfg.layouts[0]) return cfg.layouts[0].id;
  const layout = {
    id: config.newLayoutId(),
    name: config.nextLayoutName(cfg),
    // ★ 端口要跳过**所有**还占着的（配置里的 ∪ 临时实例那些）—— 见
    //   `usedLayoutPortsAll`。只数配置里的，就会把一个活的临时实例脚下那个端口
    //   分给一个新组，而症状是两条隧道抢一个端口、谁先绑谁赢。
    port: config.nextLayoutPort(cfg, usedLayoutPortsAll(null)),
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
    port: config.nextLayoutPort(cfg, usedLayoutPortsAll(null)),   // 同上（含临时实例）
  };
  cfg.layouts = [...cfg.layouts, layout];
  config.setConnectionLayout(cfg, conn.id, layout.id);
  return layout.id;
}

/**
 * 一个布局组（**持久的或临时的**）听在哪个端口。
 *
 * ★ **没有回落分支，找不到就抛。** 这与 `config.layoutPort` 刻意相反，而理由不是
 *   洁癖：那个函数的回落值是 `LAYOUT_PORT_BASE`（18080），而它在临时组这条路上
 *   **够得着** —— 临时组不在 `cfg.layouts` 里，于是每一个临时实例都会"回落到"
 *   18080，也就是**持有者那个组自己的端口**。症状有两条，都很难查：终端上推一条
 *   "端口被占、布局会重置"的**假警报**（而那个端口根本没有被抢），以及同一份配置
 *   在不同启动顺序下得到**不同的 origin**（localStorage 于是时有时无）。
 *   宁可停下来，也不要一个看起来像端口冲突的错。
 *
 * ★ 它是**唯一**的取端口入口。从前还有一条 `config.layoutPort`（只认配置、组不在
 *   就回落到基址）—— 它已经**整个删掉**了，因为那条回落够得着**临时组**这条新路，
 *   而它给出的答案是持有者那个端口（见上）。⇒ 别再长出第二条取端口的函数。
 */
function layoutPortOf(layoutId) {
  const l = config.findLayout(cfg, layoutId);
  if (l) return l.port;
  const t = tempLayouts.get(layoutId);
  if (t) return t.port;
  throw new Error(`取不到布局组 ${layoutId} 的端口：它既不在配置里，也不是一个`
    + '本进程还在用的临时实例。（临时实例只活在内存里，进程一重启它就不存在了'
    + '—— 那时应当重新认领，而不是去问一个已经没有的组。）');
}

/**
 * 现在**所有还占着端口**的布局组：配置里的 ∪ 临时实例那些。
 *
 * ★ 三个读者**全都走这一个入口**（`excludedPortsFor`、`app:setConnectionLayout`、
 *   新建临时组时挑端口）。少一个的后果都是**静默**的：
 *   · 隧道顺移时会挑走一个临时实例的端口 —— 而那条监听是活的，于是顺移**绑不上**，
 *     用户看到"页面忽然打不开"，两边的日志里一个字都不提端口冲突；
 *   · 两条临时实例拿到同一个首选端口 —— 第二条起来时第一条的 origin 被顶掉。
 *
 * ★ 它**不是** `config.usedLayoutPorts` 的替代品：那一个的语义是"配置里的"，要
 *   保持干净（它还有别的读者）。这一层负责把第二个来源并进来。
 *
 * @param {string|null} [exceptId] 摘掉自己那一个（顺移时自己那个端口不能被当成
 *        "别人的"，否则永远绑不上）。
 */
function usedLayoutPortsAll(exceptId) {
  const s = config.usedLayoutPorts(cfg, exceptId);
  for (const [id, t] of tempLayouts) if (id !== exceptId) s.add(t.port);
  return s;
}

/**
 * 给这一次会话认领一个**实例键**（今天就是布局组 id）。
 *
 * ── 认领规则（**唯一**的实现，`startSession` 与 `reattachOne` 都走它）────────
 *
 * **持有者身份只在开局那一刻确定**：开局时那个组上**没有活会话** ⇒ 它就是持有者，
 * 用连接那个组（与这个机制存在之前**逐字相同**）；已经有 ⇒ 这是一份**临时实例**，
 * 给它一个新造的、只在内存里的临时组。
 *
 * ★ **已经开着的实例永不接任**。一个正在跑的会话手里攥着它那个组 id（分区、数据
 *   目录、外面那个 origin 都从它算），把"持有者"这个身份挪到它头上等于在运行时
 *   迁移一份被活进程持有的存储 —— 做不到，而硬做的症状是页面忽然空掉。所以持有者
 *   结束之后，还开着的那一份**接着当临时实例**，下一个**新开**的会话才认领持有者。
 *
 * ★ 分两处写必然漂：一处判 `occupied`、一处判 `sessions.has`；一处拷数据、一处不拷。
 *   而漂的后果是**静默的** —— `reattachOne` 那一侧漂了，重启之后 N 条会话全部落进
 *   同一个槽，只接回第一条，其余的在集群上继续跑而心跳没了（1800 秒后 scancel）。
 *
 * ★ `concurrent !== true` 的插件**恒返回 base**：它没有实例段（`identityOf` 不给
 *   第三段），所以"第二份"对它是**同一个身份**的两条会话 —— 那正是槽闸要拒的，
 *   交给槽闸拒（它的文案说得出是哪一个挡住了），而不是在这里悄悄给它一份假实例。
 *
 * ★ 它**会造一个临时组**，所以只在"这次会话确实要起"的路径上调（槽闸之前那一步），
 *   不要拿它去问"会是什么" —— 那样每问一次就漏一个临时组。
 *
 * @param {string} baseLayoutId 连接那个组（调用方已经保证这个插件要布局组）
 * @param {object} plugin
 * @returns {string} 这次会话的实例键
 */
function claimInstance(baseLayoutId, plugin) {
  if (!pluginData.hasInstance(plugin)) return baseLayoutId;
  if (!occupied(pluginData.slotOf(baseLayoutId))) return baseLayoutId;
  const t = {
    id: config.newLayoutId(),
    name: '临时实例',
    // ★ 端口要跳过**两个来源**：配置里那些组，以及本进程里已经活着的临时实例。
    //   少了后者，两条临时实例会拿到同一个首选端口（见 `usedLayoutPortsAll`）。
    port: config.nextLayoutPort(cfg, usedLayoutPortsAll(null)),
  };
  tempLayouts.set(t.id, t);
  return t.id;
}

/**
 * 把这一份**临时实例**的全部痕迹收掉：注册表里那一格，以及它名下的两个落点
 * （浏览器存储分区 + 各插件的插件数据目录）。
 *
 * ★ **用 `Map.delete` 的返回值当"只回收一次"的旗子**，不在会话记录上再存一个
 *   `rec.reclaimed`：两份状态会漂，而漂的后果正是这个函数要防的那件事 ——
 *   多回收一次会把**另一个**已经复用了这个 id 的实例的数据删掉，少回收一次
 *   会漏一份永远没人清的目录。旗子和事实是同一个东西时，它不会漂。
 *
 * ★ 调用点的**次序是承重的**：必须排在 `win.destroySurface(slot)` **之后**。
 *   排在前面的话，`livePartitions()` 还看得见那块视图 ⇒ 分区那一半被静默跳过 ⇒
 *   **每一次回收都在盘上留一份垃圾**（而它看起来像"没清干净"，不像"顺序错了"）。
 *
 * ★ 不是临时实例时**什么都不做**（持久的组有它自己的回收路径：引用计数、或者
 *   用户删掉最后一条连接）。
 */
function releaseEphemeral(layoutId) {
  const t = tempLayouts.get(layoutId);
  if (!t || !tempLayouts.delete(layoutId)) return;
  clearLayoutStorage(layoutId, t.name);
}

/**
 * 把持有者那份插件数据**拷一份**当临时实例的起点。
 *
 * ★ 拷的是**那个组上这个插件那一份**（`identityOf(plugin, baseLayoutId)`），不是
 *   "持有者那条会话的" —— 持有者可能是**另一个**插件（同一个组上，code-server 与
 *   别人可以各有一份身份）。按会话去拷会拷到别人的数据。
 *
 * ★ **同步**（`fs.cpSync`），而且**调用点与认领之间不许有 `await`**：两条
 *   `app:start` 同时在飞时，若在"看那个组上有没有活会话"与 `sessions.set` 之间
 *   让出控制权，两条都会看到"没有持有者" ⇒ 都用连接那个组 ⇒ 后一条把前一条的
 *   记录**顶掉**，前一条的作业从此没有心跳、1800 秒后被 `scancel`，而界面上只有
 *   一条会话。异步拷贝会把那个窗口打开。
 *
 * ★ 源目录不存在（`ENOENT`）= **没有起点，不是错误** —— 持有者可能还什么都没写过。
 *   空目录对插件是一个**有定义**的状态：它本来就是自己按需建的。
 *   真拷不出来（权限、空间）时**照起会话** + 一条 warn：这一份本来就是临时的，
 *   因为读不到起点而拒绝开局，代价比"起点是空的"大得多。
 */
function snapshotTempData(plugin, baseLayoutId, tempLayoutId) {
  const root = pluginDataRoot();
  if (!root) return;
  const nameOf = (id) => pluginData.dataDirNameOf(pluginData.identityOf(plugin, id));
  try {
    fs.cpSync(path.join(root, nameOf(baseLayoutId)), path.join(root, nameOf(tempLayoutId)),
      { recursive: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return;      // 没有起点：这一份本来就是空的
    win.pushNotice('warn',
      `「${plugin.displayName || plugin.name}」这份临时副本没能拿到起点数据`
      + `（${e.message}），它会从空白开始。`);
  }
}

/**
 * **所有会改变引用计数的改动都必须走这里**，而不是直接 config.saveConfig。
 * 漏掉一处的后果是某个组永远不被回收 —— 它占着一个端口和一份浏览器存储。
 *
 * 反过来，rememberHostKey / forgetHostKey 内部自己 saveConfig 是安全的：
 * 改主机密钥与引用计数无关。**那不是漏改。**
 *
 * ★ 而 `layouts[].port` 已经**没有**写盘点 —— 它在布局组创建时定下来、此后只读
 *   （见 config.js 的 `nextLayoutPort`），所以 `pruneLayouts` 之外没有任何东西
 *   需要为它操心。
 */
function commitConfig() {
  // ★ 组的**名字**要在 pruneLayouts 之前记下来：它一删，`cfg` 里就没有这个名字了，
  //   而清理失败时那句话要说清是**哪一个**组（"某个布局组"对用户没有用）。
  const names = new Map((cfg.layouts || []).map((l) => [l.id, l.name]));
  const { removed } = config.pruneLayouts(cfg);
  try {
    config.saveConfig(cfgDir, cfg);
  } catch (e) {
    // 界面显示「已保存」而磁盘上没写，正是这个项目一路在清的那类问题。
    win.pushNotice('error',
      '配置没能写入磁盘：' + e.message + '（本次改动重启后会丢失）');
  }
  for (const id of removed) clearLayoutStorage(id, names.get(id));
  return removed;
}

/**
 * 显式回收**一个指定的**布局组（连同它名下的数据）。
 *
 * ★ 它与 `commitConfig` 里那条**引用计数**回收不是同一件事，所以是两个入口：
 *   那一条数的是"还有几条连接指着它"，而这一条用在**数不出来**的场合 ——
 *   今天只有一个：`app:deleteConnection` 删掉了**最后一条**连接，于是
 *   `pruneLayouts` 那条「一条连接都没有时**不**回收」的守卫会把它拦下。
 *
 *   ★ 那条守卫守的是**从来没被任何连接指过**的兜底组（开发者模式、全新安装：
 *     回收掉它，下次开会话会造一个新的，id 一变 partition 就变，布局白重置一次）。
 *     而"用户亲手删掉了最后一条连接"是另一回事 —— 那个组已经没用了，而且那条
 *     连接**再建回来也是另一个组、另一份分区**，旧数据反正读不到。
 *     ★ 少了这一步，「删条目就删数据」在**只有一条连接**这个最常见的场合根本
 *     不发生 —— 而那正是用户提这件事的场景。
 */
function reclaimLayoutGroup(layoutId, layoutName) {
  if (!layoutId || !config.findLayout(cfg, layoutId)) return false;
  cfg.layouts = (cfg.layouts || []).filter((l) => l.id !== layoutId);
  try {
    config.saveConfig(cfgDir, cfg);
  } catch (e) {
    win.pushNotice('error',
      '配置没能写入磁盘：' + e.message + '（本次改动重启后会丢失）');
  }
  clearLayoutStorage(layoutId, layoutName);
  return true;
}

/**
 * 回收一个布局组之后的卫生清理 —— **两个根一起清**：浏览器存储分区，以及各插件
 * 写在这个组名下那份数据目录（`ctx.dataDir()` 给的那个）。
 *
 * **不是正确性必需** —— 名字永不复用（布局组 id 与 partition 都是），残留数据永远
 * 不会被新的组读到。是隐私：那个分区里躺着 code-server 的登录 cookie，那个目录里
 * 躺着插件自己的东西（sshd 的钥匙、别的插件的缓存）。
 *
 * ★ 有且只有一条致命前提：**绝不能对正被用着的那一份做**。那会把一条**正在跑**的
 *   会话脚下的数据抽掉，而症状只是「页面莫名其妙坏了」或「ssh 忽然认证失败」。
 *   所以两半各有各的守卫：分区看 `livePartitions()`（窗口持有），数据目录看
 *   `liveDataDirs()`（会话持有）—— 两者的判据不同，理由见各自那一段。
 *
 * ★ **什么时候会发生**：只有 `commitConfig` 里 `pruneLayouts` 真的回收了组的时候
 *   （最后一条指着它的连接被删掉、或被切到别的组）。所以"删一条 ssh 条目就删掉它的
 *   用户数据"这件事**只在那是最后一个用某个组的连接时**成立 —— 还有别的连接指着
 *   那个组时，数据留着，因为下一会话还要用它。
 *
 * 不 await：删一个组不该因为磁盘慢而卡住界面。
 *
 * @param {string} layoutId
 * @param {string} [layoutName] 那个组的名字。只为了失败时说清是**哪一份** ——
 *   `pruneLayouts` 已经把它从配置里删掉了，所以这个名字由调用方在删之前记下来。
 */
function clearLayoutStorage(layoutId, layoutName) {
  const label = layoutName ? `布局组「${layoutName}」` : '那个布局组';
  // 哪些插件的存储挂在这个组上：**有界面、而且声明了分实例**的那些。
  //   · 没有界面 ⇒ 从来没有分区（ensureSurface 第一行就返回了）；
  //   · 没声明分实例 ⇒ 只有一份存储，它不属于任何一个组 —— 跟着某个组一起清掉
  //     就是把这个插件唯一的那份数据删了。判据只能看声明，不能看"哪个插件在跑"：
  //     一个今天没在跑的插件，它的存储照样在这个组里。
  //
  // ★ 判据收在 pluginData.hasLayoutStorage 里：**"有界面 + 按布局组分"缺一不可**。
  //   回收一个组时要清的是"属于这一个组"的那些存储；没声明分实例的插件只有一份，
  //   它不属于任何组（对账那一侧用的是另一条 —— `hasSurface`）。
  const partitions = registry.list()
    .filter(pluginData.hasLayoutStorage)
    .map((p) => {
      const id = pluginData.identityOf(p, layoutId);
      // ★ 两个名字**都要**，它们不是一回事：分区名给 Electron，磁盘名给路径。
      //   分区名里插件 id 那一段是**大写**的，而磁盘上的目录是**折叠过**的 ——
      //   拿分区名去拼路径会静默落空（`force` 把 ENOENT 吞了，于是"删成功"而目录还在）。
      return { partition: pluginData.partitionOf(id), disk: pluginData.diskNameOf(id) };
    });
  const root = partitionsRoot().root;

  for (const { partition, disk } of partitions) {
    // ★ 正被那块界面用着的分区**不能碰**（抽掉它会把用户当前那份数据连 cookie
    //   一起弄坏，而症状只是「页面莫名其妙坏了」）。从前这里是 `return` —— 那时
    //   只有一个分区，跳过它就等于跳过整件事；多份之后跳过**这一个**才是它本来的
    //   意思。
    //
    //   ★★ 判据从"**那一块**界面"改成"**任何一块**界面"（`livePartitions()`）。
    //     从前 `win.surfacePartition` 只能返回一块，而那块是**前台**；多开之后
    //     前台不是它的时候，这一道就形同虚设 —— 而那正是"回收一个组，抽掉另一块
    //     正在跑的视图脚下的 localStorage"这条路径。
    //
    //   ★ 关于它够不够得着：从前这里写着"今天够不着"，而**多开让它够得着了**。
    //     完整的路径在 `app:deleteConnection` 那段注释里（切换活跃连接 → 删旧连接
    //     → 组被回收）。所以它现在是一道**正在生效**的防线，不再是一个约定。
    //
    //   ★ 跳过仍然是**静默**的，但那不等于"清理在瞒着用户"：这条路是"开关布局组 /
    //     删连接"带出来的，而那两步在动手之前都已经问过用户了（`would_discard`
    //     那个确认框）。**用户主动发起**的删除是另一条路（`app:deletePluginData`），
    //     那一条碰到同样的情形会**明确拒绝**并说清原因 —— 静默只在这一条路上关掉。
    if (livePartitions().has(pluginData.foldAscii(partition))) continue;
    clearPartitionStorage(partition, disk, root).then((r) => {
      if (!r.ok) {
        win.pushNotice('error',
          `${label}已经回收，但它那份浏览器存储没能清干净：${r.error}`);
      }
    });
  }

  // ── 插件写在磁盘上的那一份（`plugin-data/`）────────────────────────────────
  //
  // ★ 判据是 `hasInstance`，**不是** `hasLayoutStorage` —— 后者多一条"有界面"。
  //   没有界面的插件照样可能在磁盘上留一份：它没有分区，但有数据目录。
  // ★ 反过来：没声明分实例的插件**绝不能**跟着一个组被清 —— 它只有一份，不属于
  //   任何一个组（sshd 的 `<ULID>@relay` 就是）。下面那行 filter 就是那道闸；
  //   少了它，删一条连接会把 `~/.ssh/config` 那行 Include 指空。
  // ★ 路径**现算**（与 `ctx.dataDir()` 同一个表达式），绝不从分区名拼 —— 分区名里
  //   插件 id 那一段是**大写**的，拼出来会静默落空，而 `force` 把 ENOENT 吞掉，
  //   于是"删成功"而目录还在。
  // ★ 整段**只报不抛**：`commitConfig` 的调用点在 IPC 的**成功路径**上，这里抛出去
  //   会把「删除连接」变成一句失败，而配置其实已经删了、也存了。
  //
  //   ★ 而**失败的那条路走的是 `removeDirChecked` 的返回值，不是异常**（它自己
  //     把 `rmSync` 包住了）—— 所以 `catch` 这一段是**够不着的**：今天块里没有
  //     任何一个调用会抛。留着它是因为这里是一条**破坏性**路径上的**成功路径**，
  //     而"抛出去"在这里的代价是一句**说谎的**错误信息（删成功了却说失败）。
  //   ⇒ **别为这个 catch 写用例**：没有任何变异打得红它，写出来的只会是一条
  //     看起来在守什么、其实什么也没守的用例。"删不动"那一条真实的路由
  //     `boot.test.mjs` 的〈磁盘删不动时只报、不抛〉守着（它断言的是**提示**与
  //     IPC 仍然成功）。
  try {
    const root = pluginDataRoot();
    if (root) {
      const live = liveDataDirs();
      for (const p of registry.list().filter(pluginData.hasInstance)) {
        const name = pluginData.dataDirNameOf(pluginData.identityOf(p, layoutId));
        if (live.has(name)) continue;
        const r = removeDirChecked(path.join(root, name));
        if (!r.ok) {
          win.pushNotice('error', `${label}已经回收，但`
            + `「${p.displayName || p.name}」那份磁盘数据没能清干净：${r.error}`);
        }
      }
    }
  } catch (e) {
    win.pushNotice('error',
      `${label}已经回收，但磁盘上那份数据没能清干净：${e.message}`);
  }
}

// ── 本机的插件数据：对账与删除 ──────────────────────────────────────────────
/**
 * 分区目录的根（并顺带核对一遍命名约定）。
 *
 * ★ 探针必须是**该有的**身份：`fromPartition` 可能把目录建出来，而编造一个名字
 *   去问，就等于凭空造一份**不在"该有的"清单里**的目录 —— 用户下次打开客户端会
 *   多看到一行"没人用的数据"，而那一行是我们自己造的。
 */
function partitionsRoot() {
  const layouts = (cfg && cfg.layouts) || [];
  const probePlugin = registry.list().find(pluginData.hasSurface);
  let probe = null;
  if (probePlugin) {
    if (!pluginData.hasInstance(probePlugin)) {
      probe = pluginData.partitionOf(pluginData.identityOf(probePlugin));
    } else if (layouts.length) {
      probe = pluginData.partitionOf(pluginData.identityOf(probePlugin, layouts[0].id));
    }
    // 声明了分实例、而一个布局组都没有 ⇒ **没有该有的身份可问**：不探，用兜底那条路。
  }
  let fallbackRoot = null;
  try {
    fallbackRoot = path.join(app.getPath('sessionData'), 'Partitions');
  } catch { /* 老 Electron 上没有这个键：那就没有根 */ }
  return dataAudit.partitionRoot({ session: electronSession, probe, fallbackRoot });
}

/**
 * 基座给插件的数据目录的根（`ctx.dataDir()` 与对账**必须同源**）。
 *
 * ★ 一个表达式覆盖两种模式：真实模式下 `cfgDir` **就是** `userData`，开发者模式下
 *   它是 `<userData>/dev-sandbox` —— 沙盒分岔于是自动跟着走，与 `sitePoolDir()` 同一个
 *   理由（拿假后端跑，**绝不去读、更不去写**用户真实的那一份）。
 * ★ 根名 `plugin-data` **只有这一处**。给插件的那条路与对账这一条各算一遍，正是这个
 *   仓库最怕的那类漂移：两边会慢慢变成两个目录，而症状是"界面上说没有，插件却在写"。
 *
 * @returns {string|null} `null` = 还不知道（配置目录还没定下来）—— 见 `ctx.dataDir()`
 */
function pluginDataRoot() {
  return cfgDir ? path.join(cfgDir, 'plugin-data') : null;
}

/**
 * 本机插件数据的对账：**谁在用、还剩几份**。只读，不改任何东西。
 *
 * ★ **两个根一起查**：Electron 的存储分区，以及基座给插件的数据目录。一份身份可能
 *   在两个根下各有一半（浏览器攒的那半 + 插件自己写的那半），所以行由两个根的名字
 *   并起来算（见 `plugin-data-audit.js`）。
 *
 * ★ 它**不塞进 `app:bootstrap`**：那一次载荷是"启动信息"，而这里要做磁盘 I/O、
 *   还包含一次可能失败的探测 —— 挂上去会让"面板打不开"与"磁盘慢"变成同一件事。
 *   界面进来之后单独拉一次（`app:pluginData`）。
 */
function auditPluginData() {
  const layouts = (cfg && cfg.layouts) || [];
  const pr = partitionsRoot();
  const dataRoot = pluginDataRoot();
  let names = null;
  let why = pr.why || null;
  let dataNames = null;
  let dataWhy = null;
  if (dev.developerMode) {
    const sandboxWhy = '开发者模式不查磁盘：这里用的是一份沙箱配置，它里面的布局组 id 与'
      + '真实那一份对不上 —— 照它去认，真实那一份数据会整片看起来像孤儿，而删掉它们'
      + '就是毁掉真实的那一份。';
    why = sandboxWhy;
    dataWhy = sandboxWhy;
  } else {
    if (pr.root) {
      const r = dataAudit.listDirs(pr.root);
      names = r.names;
      why = r.why || why;
    }
    if (dataRoot) {
      const r = dataAudit.listDirs(dataRoot);
      dataNames = r.names;
      dataWhy = r.why;
    }
  }
  return {
    ...dataAudit.audit({
      plugins: registry.list(), layouts, connections: cfg.connections,
      names, why, dataNames, dataWhy,
      // ★★ **现在正被活会话拿着的**（两个根都要）—— 少了它，一份正在被写的
      //    数据会被摆上一个删除按钮。★ 两个根各有各的持有者，所以**两句都要**：
      //    · `livePartitions()`：浏览器存储分区（**窗口**持有，见它那段注释）；
      //    · `liveDataDirs()`：插件数据目录（**会话**持有 —— 没有界面的插件、
      //      以及临时实例，在窗口里都没有位置）。
      //    只给前者的后果**够得着**：`boot.test.mjs` 里那个没有界面的 `headless`
      //    夹具活着的时候就能被删掉。
      // ★ 顺序无关（`audit` 内部收成一个集合），折过没折过也无关（它自己再折一遍）。
      held: [...livePartitions(), ...liveDataDirs()],
    }),
    // ★ 两根都给出去：删除要按行的 `places` 分派，而它需要知道每一根在哪。
    roots: { partition: pr.root, data: dataRoot },
  };
}

/**
 * 删一个目录，并**复核**它真的不在了。
 *
 * ★ 复核不是多余的：Windows 上有句柄时 `rm` 会删一半然后抛（`force` 只吞 `ENOENT`），
 *   Linux 上删掉之后 Chromium 可能把同一个目录再写出来。报成功而它还在的话，下一次
 *   对账会把同一行再列出来 —— 用户会以为"我明明删过了"。
 */
function removeDirChecked(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    return { ok: false, error: `目录没能删掉：${e.message}` };
  }
  return fs.existsSync(dir)
    ? { ok: false, error: '目录删了又还在（多半有别的进程正拿着它）' }
    : { ok: true, error: null };
}

/**
 * 清掉一个**分区**（Electron 那一侧）：**先让它松手，再把目录删掉**。
 *
 * ★ 两件事都要做，而它们分工不同。`clearStorageData()` 的作用**不是**"清干净"
 *   （它连 HTTP 缓存都不碰 —— `storages` 里没有 `cache`），而是让 Chromium 手里
 *   那个**仍被缓存的 context 先松手**：本进程用过的分区，它的 context 会一直留着
 *   —— 那是常态，不是例外。**目录的消失是 `rmSync` 干的**：只清不删的话，那一行会
 *   永远留在对账的清单里，而用户会以为自己点了没反应。
 *
 * ★ 两条路都调它：对账里用户主动删那一行（`clearOneRow`），以及一个布局组被回收
 *   （`clearLayoutStorage`）。★ 但它**只管分区这一侧** —— 插件写在磁盘上的那份
 *   （`plugin-data/` 下）是**另一个根**，由 `clearLayoutStorage` 并列处理的另一段
 *   负责。两半的判据也不同：分区要 `hasLayoutStorage`，数据目录只要 `hasInstance`。
 *
 * @param {string} partition 完整的 `persist:…`（给 Electron 的那个名字）
 * @param {string|null} diskName 磁盘上的目录名（**折叠过**的那一份）。给不出来就只清存储、不删目录。
 * @param {string|null} root 分区目录的根
 * @returns {Promise<{ok: boolean, error: string|null}>}
 */
function clearPartitionStorage(partition, diskName, root) {
  return new Promise((resolve) => {
    let p;
    try {
      p = electronSession.fromPartition(partition).clearStorageData();
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    Promise.resolve(p).then(() => {
      // ★ 路径**只由根 + 磁盘上的那个名字拼** —— 界面给的字符串**永远进不了路径**
      //   （它们只用来**匹配**清单里的某一行，见 `app:deletePluginData`）。
      const dir = root && diskName ? path.join(root, diskName) : null;
      if (!dir) return resolve({ ok: true, error: null });
      return resolve(removeDirChecked(dir));
    }, (e) => resolve({ ok: false, error: e.message }));
  });
}

/**
 * 清掉**一行**插件数据 —— 按它的 `places` 分派到各个落点。
 *
 * ★ 一份数据的两个落点是**一起删**的：只删浏览器那一半的话，下一次对账会把同一行
 *   再带回来（`places` 里还剩 `data`），而用户会以为"我明明删过了"。
 *
 * @param {object} row   `audit` 算出来的那一行（用它里面的 `name` 与 `places`）
 * @param {{partition: string|null, data: string|null}} roots 两个根
 * @returns {Promise<{ok: boolean, error: string|null}>}
 */
async function clearOneRow(row, roots) {
  const places = Array.isArray(row.places) ? row.places : [];
  if (places.includes('partition') && roots && roots.partition) {
    const r = await clearPartitionStorage(`persist:${row.name}`, row.name, roots.partition);
    if (!r.ok) return r;
  }
  if (places.includes('data') && roots && roots.data) {
    const r = removeDirChecked(path.join(roots.data, row.name));
    if (!r.ok) return r;
  }
  return { ok: true, error: null };
}

// ── 会话表 ──────────────────────────────────────────────────────────────────
/**
 * 这个槽**还占着**吗。
 *
 * 判据与从前 `startSession` 里"能不能复用那个 controller"**逐字相同**（只是取了
 * 反）：ENDED / ERROR / IDLE / RELEASING 都算"上一个会话已经完了"。
 *
 * ★ `RELEASING` 那一档尤其要紧 —— `stop()` 之后它就再也走不出去了（状态轮询已经
 *   停了），把它当成"还占着"会让「结束会话」变成一道单向门：用户结束掉一个，
 *   那个槽就永远开不了新的。
 */
function occupied(slot) {
  const rec = sessions.get(slot);
  const c = rec && rec.controller;
  return Boolean(c)
    && ![State.ENDED, State.ERROR, State.IDLE, State.RELEASING].includes(c.state);
}

/**
 * 界面的那一份视图。**一次给全**。
 *
 * ★ `live` 与"有没有记录"是两件事：已经结束的记录**还要显示**（用户要看"已结束"，
 *   也要在那里点「重新开始」），而它不占着槽。
 */
function sessionViews() {
  return [...sessions.values()].map((rec) => ({
    slot: rec.slot,
    service: rec.plugin ? (rec.plugin.displayName || rec.plugin.name) : null,
    live: occupied(rec.slot),
    // ★ 这一份是不是**临时实例**（第二份、数据是一份副本、会话结束就没了）。
    //   判据只有**一个来源**：那张临时组注册表。**不要在会话记录上另存一个布尔**
    //   —— 两份状态会漂，而漂的后果是"界面说它是临时的，而它其实已经变成持久的"
    //   或者反过来（用户据此以为自己的改动会留下，或者以为不会）。
    temporary: Boolean(rec.controller && tempLayouts.has(rec.controller.layoutId)),
    snap: rec.controller ? rec.controller.snapshot() : null,
  }));
}

/**
 * 把已经结束的记录收掉。
 *
 * 槽是**淘汰制**的：一个槽的上一轮记录留着，是为了让界面能显示"已结束 + 重新开始"；
 * 而只要用户开始了**新的一轮**，那一屏就没有意义了。
 * （只有一个会话时这是自动的 —— 新 controller 直接顶掉旧的。多开之后要有人做。）
 */
function reapSessions() {
  for (const [slot] of sessions) if (!occupied(slot)) sessions.delete(slot);
}

/**
 * 现在**真的被某一块界面用着**的那些分区（一组折叠过的名字）。
 *
 * ★ 为什么是"一组"而不是"那一个"：窗口里那一块从前只有一个，而多开之后前台只是
 *   "哪一块盖在上面"。**判据不能跟着前台走** —— 回收一个布局组时，被抽掉的是
 *   "正在跑的那块页面"脚下的 localStorage，而它完全可能就是后台那一个。
 *   （名字两边都折叠，`plugin-data.js` 的 `foldAscii` 那一套。）
 */
function livePartitions() {
  const out = new Set();
  if (!win) return out;
  for (const rec of sessions.values()) {
    const p = win.surfacePartition(rec.slot);
    if (p) out.add(pluginData.foldAscii(p));
  }
  return out;
}

/**
 * 现在**真的有一条活会话落在上面**的那些插件数据目录（折叠过的目录名）。
 *
 * ★ 它是 `livePartitions()` 的**姊妹，不是它的副本** —— 判据不同：
 *   · 分区是**窗口**持有的（构造 WebContentsView 时定下来），所以那里问的是
 *     "哪块视图显示着哪个分区"；
 *   · 插件数据目录**不由窗口持有** —— 它由 `ctx.dataDir()` 现算，唯一的主人是
 *     那条会话。所以这里必须问"哪条**活会话**落在哪个布局组上"。
 *   拿前者当后者用会**静默失效**：一个没有界面的插件（`hasInstance` 却没有
 *   `surface`）在窗口里没有位置，于是它正在用的那份目录会被当成没人用的。
 *
 * ★ 少了它的症状也是**静默**的：回收一个组时把一条正在跑的会话脚下那份数据删掉
 *   （`ssh slurmate` 忽然认证失败、编辑器状态没了），而用户只点过"换布局组"或
 *   "删连接"。这条路径**今天够得着**：
 *     ① 会话跑在 C1 的组上 → ② 把活跃连接切成 C2（**不动引用计数、不停会话**）
 *     → ③ 从 C1 改布局组：`isActive` 是假、不走 relisten，而 C1 原来那个组
 *     引用计数归零、被回收。
 */
function liveDataDirs() {
  const out = new Set();
  for (const rec of sessions.values()) {
    if (!occupied(rec.slot) || !rec.controller) continue;
    const p = rec.plugin;
    if (!p || !pluginData.hasInstance(p) || !rec.controller.layoutId) continue;
    out.add(pluginData.dataDirNameOf(
      pluginData.identityOf(p, rec.controller.layoutId)));
  }
  return out;
}

/**
 * 这一次会话的端口排除集：**别人已经拿走的**都不许碰。
 *
 * ★ 「别人」不止别的布局组。这里从前只排别的组端口（`usedLayoutPorts`），单会话时
 *   那是完备的；多开之后不是了 —— 中转站从中转基准端口起，而**没有任何东西**把它
 *   从布局隧道的候选里排除掉。布局隧道从组端口一路 +1 往上探（`tunnel.js` 的
 *   `PORT_SCAN_LIMIT`），撞上就把那条监听抢过来，而症状是"页面忽然打不开"，
 *   两边的日志里一个字都不提端口冲突。
 *
 * ★ 而"别的布局组"现在有**两个来源**（配置里的 + 临时实例那些），所以这里走
 *   `usedLayoutPortsAll` 而不是 `config.usedLayoutPorts` —— 见那个函数的注释。
 */
function excludedPortsFor(rec) {
  const s = usedLayoutPortsAll(rec.controller && rec.controller.layoutId);
  for (const other of sessions.values()) {
    if (other === rec) continue;
    const p = other.controller && other.controller.snapshot().localPort;
    if (p) s.add(p);
  }
  return s;
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
      // ★ 出路只有**一条**：站点分发。这里从前是二分的 —— 站点不分发时，那句话
      //   教用户"把插件目录放进 `~/.slurmate/plugins`，再到插件那一栏把「也加载
      //   本机插件目录」勾上"。那三样东西（本机池、那个按钮、那个开关）已经一起
      //   删掉了，所以那一支今天必须**如实说"这条路走不通"**，而不是给一个用户
      //   照着做也做不到的动作（§5.1 那条 ★ 说的正是这件事）。
      const canSync = Boolean(siteSync && siteSync.supported);
      win.pushNotice('error',
        '本机还没有装上任何插件，所以没有可以提交的服务。'
        + (canSync
          ? '本站会分发插件 —— 用插件那一栏的「重新同步」取一次，'
            + '带客户端代码的要你点一下同意。'
          : '而这个站点**不分发**插件 —— 插件只能由站点发下来，所以客户端这一侧'
            + '没有别的办法。请联系这个站点的管理员。'));
    } else {
      win.pushNotice('error',
        `这个客户端不认识「${wanted || '（未指定）'}」这种服务，已阻止提交。`
        + `本机装的是：${registry.list().map((p) => p.displayName).join('、')}。`);
    }
    return null;
  }
  warnVersionDrift(plugin);

  // ★ 这一次会话是**哪条连接**的 —— 读一次，两处共用：布局组从它算，
  //   `ctx.connection()` 也从它来。分两处读会让它们指向两条不同的连接。
  //
  //   ★ 读的是**当前活跃连接**：会话就是从界面上那个连接起的。这个读法有代价 ——
  //     切活跃连接不影响已经在跑的会话，所以重连接回来的会话可能拿到"不是它自己的"
  //     那条（见 pluginContext 的 `connection()`）。
  const conn = config.activeConnection(cfg);

  // ★ 布局组是**按插件**的：跑在浏览器里的插件要一个（端口 = origin = 一份
  //   编辑器布局），不跑浏览器的不给 —— 给它一个组只会凭空造出一个永远不会被
  //   创建的存储分区，并让「运行中切布局」去挪一个正在用的隧道端口。
  const baseLayoutId = plugin.contributes.layout ? layoutForSession(conn) : null;

  // ★★ **认领**（见 `claimInstance`）：持有者身份只在这一刻确定。上面那一个是
  //    "连接那个组"，而这一行回答的是"**这一次会话**用哪一个实例键" —— 那个组上
  //    已经有活会话时，这一份是**临时实例**（一个只在内存里的新组、新端口、
  //    空的浏览器存储、持有者那份数据的快照）。
  //    ★ 它与下面那道槽闸的**次序是承重的**：认领先发生，于是"能多开"的插件拿到
  //    一个新组、槽闸放行；"不能多开"的插件拿到原组，槽闸照旧拒它并说出原因。
  const layoutId = baseLayoutId === null ? null : claimInstance(baseLayoutId, plugin);

  // ── ★ 槽：一个活跃会话占一份「一个就够」的资源，同一个槽只能有一个 ──────────
  //
  // 判据与逐条理由见 `plugin-data.js` 的 `slotOf`。这里只做一件事：**拒绝，并说出
  // 是哪一个挡住了**。从前这一段没有 else 分支（走到 else 的唯一可能是"已经有一个
  // 会话在跑"，而那时 `controller.start()` 会抛一句「会话已在进行中」）—— 那句话
  // 对用户毫无用处：它不说**是哪个**会话挡着，也不说该怎么办。而多开的代价更大：
  // 被拒绝的那条会静默地顶掉一条正在跑的。
  const slot = pluginData.slotOf(layoutId);
  if (occupied(slot)) {
    const other = sessions.get(slot);
    const who = other.plugin ? `「${other.plugin.displayName || other.plugin.name}」` : '另一个会话';
    win.pushNotice('error', layoutId
      ? `${who}正占着「${(config.findLayout(cfg, layoutId) || {}).name || layoutId}」`
        + '这个布局组。一个布局组就是一个本地端口、一份浏览器存储，所以同一时刻'
        + '只能有一个会话用它 —— 先结束那一个，或者到「布局」那一栏换一个组。'
      : `${who}正占着中转站的位置。不要布局组的会话共用同一份对外身份`
        + '（同一个 ssh 别名、同一个基准端口），所以同一时刻只能有一个 —— '
        + '先结束那一个。');
    return null;
  }
  // 上一个已经结束的那个记录该走了（它是给界面看"已结束"用的，新的一轮开始了）。
  reapSessions();

  const rec = { slot, plugin, pluginWhy: null, controller: null,
                connectionId: conn ? conn.id : null };

  // ★ RELEASING 也算「上一个会话已经完了」。不加它的话：断开之后 controller 停在
  //   releasing（stop() 连状态轮询都停了，它再也走不出去），而这里会**复用**那个
  //   controller，接着 controller.start() 抛「会话已在进行中」—— 于是「断开」成了
  //   一道单向门，用户必须重启客户端才能再开会话。
  //   让新会话拿一个新 controller 之后，若旧作业还没被守护进程收掉，用户会拿到
  //   服务端那句准确的「已有 1 个活跃会话（上限 1）」，而不是一句指不回根因的话。
  // ★ **在这里捕获插件对象**（塞进 `rec`），之后所有状态变化都用它，不再查注册表。
  //
  //   站点升级插件之后池里会有同一个 id 的新版本，而一个**已经跑着**的会话用的是
  //   它起时那一版 —— 作业侧与客户端侧是配套的两半，中途换掉这一半，轻则行为诡异、
  //   重则对接不上。捕获之后，**升级插件对正在跑的会话完全没有影响**。
  //
  //   顺带得到一个好性质：把一个插件从池里卸掉，正在跑的会话也完全不受影响 ——
  //   它手里已经攥着那个对象了。
  // ★★ **这一段（controller 的构造与 `sessions.set`）排在 `prepare()` **之前**，
  //    是为了 `ctx.dataDir()`。** 那个能力从 `rec.controller.layoutId` 现算实例段，
  //    而 `prepare()` 从前跑在 controller **构造之前** ⇒ 一个「能多开
  //    （`concurrent: true`）**又**带 `prepare()`」的插件，一提交就撞上 `identityOf`
  //    那个"没有给出实例"的抛 —— 也就是说**这种插件今天根本提交不出去**。
  //    （sshd 把那个抛 catch 住了，而它是 `false`，所以这条路上从来没有人踩到过。）
  //
  //    ★ `rec.controller.layoutId` 是**唯一**的实例键来源，**不要在 `rec` 上另存
  //      一个 `layoutId`**：两份会在 `relisten` 改了 controller 那一份之后分家，
  //      而 `liveDataDirs()` 走的是 controller 那个 —— 于是它看不见这条会话正用着
  //      的目录，回收一个组时**把正在跑的数据删掉**。

  rec.controller = new SessionController({
      backend,
      layoutId,
      // 没有布局组的插件：**实际**端口要交给插件自己去写进用户那份 ssh 配置
      // （见 plugins/sshd/client/sshconfig.js）。这里只需要「重新渲染一次」，插件
      // 按当前端口重写它那份配置；端口和主机公钥都没变时它会自己跳过
      // （那正是 ctx.once() 的用处）。
      //
      // ★ 有布局组的会话**没有**对应的回调 —— 端口是布局组的只读属性，顺移只影响
      //   这一次会话，实际值在快照里。见 session.js 的 `_announcePort`。
      onRelayPort: () => onSessionChange(slot),
      // 端口顺移时必须跳过别的布局组占着的端口，否则两个组会声称同一个端口，
      // 每次启动谁先绑谁赢，布局在两个 origin 之间反复横跳。排除集里要**摘掉自己**，
      // 不然自己那个端口会被当成「别人的」而永远绑不上。
      //
      // 没有布局组的插件 layoutId 是 null，于是这里排除掉**全部**布局端口 ——
      // 正是要的：它绝不能落到某个布局组的端口上。
      // ★ 多开之后「别人」不止别的布局组，见 `excludedPortsFor`。
      getExcludedPorts: () => excludedPortsFor(rec),
  });
  rec.controller.on('change', () => onSessionChange(slot));
  rec.controller.on('retarget', () => onSessionChange(slot));
  sessions.set(slot, rec);

  // ★★ **临时实例：开局把持有者那份插件数据拷一份当起点。**
  //    同步（见 `snapshotTempData`），而且**必须在 `sessions.set` 与 `prepare`
  //    之间不留 `await`** —— 这一段就是那条"两条 `app:start` 同时在飞"的竞态窗口，
  //    让出控制权会让后一条顶掉前一条的记录（前一条的作业从此没有心跳）。
  //
  //    判据是"认领给的组与连接那个组不是同一个"，而**不是**问 `tempLayouts`：
  //    两者今天等价，但将来多一个临时组的来源时，这一行仍然说得对。
  if (baseLayoutId && layoutId !== baseLayoutId) {
    snapshotTempData(plugin, baseLayoutId, layoutId);
  }

  // 插件的提交前准备（sshd 要在这里备好那把一次性密钥：没有它守护进程会拒绝
  // 这次提交，而那要花掉一整趟往返）。**先备好再提交**是硬要求。
  //
  // ★ 排在槽那道闸之后：为一个马上会被拒的会话去生成一把钥匙，是在磁盘上留一个
  //   用户没要求过的副作用。
  //
  // ★ 失败时**要把刚才那两条记录撤掉**：槽里留着一条假记录 ⇒ 那个槽再也开不了
  //   新的（用户看到的是"某某正占着这个布局组"，而那个会话根本不存在）；临时实例
  //   留着 ⇒ 注册表里多一格、数据目录永远没人回收（面板上那一行还删不掉 ——
  //   `held` 会护着它）。
  let sshPubkey = null;
  if (plugin.prepare) {
    const pre = plugin.prepare(pluginContext(rec));
    if (!pre || !pre.ok) {
      sessions.delete(slot);
      releaseEphemeral(layoutId);
      win.pushNotice('error', (pre && pre.message) || '提交前的准备失败，已中止。');
      return null;
    }
    sshPubkey = pre.sshPubkey || null;
  }

  // 本地端口**不是插件的事**（插件的 `preferredPort` 钩子已经收掉了）：有布局组的
  // 会话用布局组自己那个端口（它就是 origin），没有布局组的用中转基准端口。
  //
  // ★ **必须判 null**：没有布局组的会话拿的是 `RELAY_PORT_BASE`，而它绝不能落到
  //   某个布局组的端口上 —— 那条路径**不报错**，症状是"浏览器那一块打到 ssh 端口
  //   上，页面打不开"。
  //   ★ 而 `layoutPortOf` 那条路**连回落都没有**（找不到就抛）：临时实例不在配置里。
  //     从前那条会回落到基址（18080）的取端口函数已经**整个删掉**了 —— 它会让每一个
  //     临时实例都从 18080 起扫，也就是**持有者自己那个端口**。
  const preferredPort = layoutId
    ? layoutPortOf(layoutId)
    : config.RELAY_PORT_BASE;
  const snap = await rec.controller.start(resources, {
    preferredPort,
    serviceKind: plugin.name,
    needsPubkey: plugin.contributes.submitPubkey,
    sshPubkey,
  });
  if (!snap) onSessionChange(slot);
  // ★ 回**槽**：界面拿它指着说"我起的是这一个"（`app:start` 的回包）。
  return { slot, snap };
}

/**
 * 提交时该用本机的哪一个插件。
 *
 * ★ **优先按站点报的 `(id, 版本)` 挑**，而不是"同名里版本最高的那个"：那个才是
 *   这个会话真会跑的那一版，而客户端的 `prepare()` 必须与服务端即将起的那份
 *   **配套**。同名多 id 只可能出现在"站点分发的插件覆盖了内建同名插件"
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
async function onSessionChange(slot) {
  try {
    await _renderSession(slot);
    // 一次推**全部** —— 面板那一屏要显示的是"这个窗口里有几个会话、各自什么样"，
    // 而不是"最后动过的那一个"。
    const views = sessionViews();
    // 窗口那一层要的两件事（几条活着、各自的 closeWarning）走这一份；界面要的
    // 那一份走 pushSessions。**分开**：前者是"关窗会掐断什么"，后者是"画什么"。
    win.setSessions(views.map((v) => ({
      live: v.live,
      service: v.service,
      plugin: (sessions.get(v.slot) || {}).plugin || null,
    })));
    win.pushSessions(views, frontSlot());
  } catch (e) {
    win.pushNotice('error', '更新界面时出错：' + e.message);
  }
}

/**
 * 正盖在面板上的那一个槽。
 *
 * ★ 它是**界面的事实**，不是框架的事实 —— 别拿它决定行为（停哪个作业、用哪份
 *   cookie、清哪个分区都不许看它）。它是"哪一块视图可见"这个问题的答案，
 *   而且是窗口那一层唯一的答案：原生视图同一时刻只装得下一块。
 */
function frontSlot() {
  if (win && win.front && sessions.has(win.front)) return win.front;
  // 没有前台、或者前台那个已经被收掉了：挑第一个活着的。
  for (const [slot] of sessions) if (occupied(slot)) return slot;
  const first = sessions.keys().next();
  return first.done ? null : first.value;
}

/**
 * 画这一条会话。
 *
 * ★ 参数是**槽**，不是快照 —— 这一点是故意的。从前它收一个裸 `snap`，而那个签名
 *   把"这是哪一条会话的"变成一个**无从回答**的问题：里面每一句 `win.hideSurface()`、
 *   `win.setSessionService(plugin)`、`controller.plugin` 都在暗中假设"只有一个会话"。
 *   收槽之后，这些句子必须先答出那个问题才写得出来。
 */
async function _renderSession(slot) {
  const rec = sessions.get(slot);
  if (!rec || !rec.controller) return;          // 记录已经收了：什么都不画
  const snap = rec.controller.snapshot();

  // 会话没有了（结束/出错/正在释放），或者压根还没起来：**这一条**会话的页面背后的
  // 服务器已经不存在了 —— 隧道在 stop() 的最开头就停了 —— 收起**它那一块**，
  // 把窗口主体还给面板，而面板上正是「重新开始」那几个按钮。
  //
  // ★ RELEASING 也要算在内，而且它才是在真机上**最先到达**的那一个：stop() 发出
  //   goodbye 之后状态就是 releasing，而它要等下一次 status 轮询（60 秒）才可能
  //   变成 ended。只收 ENDED 的话，用户点了「结束会话」之后还要盯着一块打不开的
  //   页面最多一分钟。
  //
  // ★★ **收的是这一个槽，不是"窗口里那一块"。** 从前这里是 `win.hideSurface()`，
  //   而多开之后那是**静默的越权**：甲会话结束，把乙会话那块正跑着的页面一起
  //   销毁掉 —— 通知、状态条全都正常，只有用户的编辑器没了，而出路（重新加载）
  //   正压在那块页面底下。
  if ([State.RELEASING, State.ENDED, State.ERROR, State.IDLE].includes(snap.state)) {
    win.destroySurface(slot);
    // ★★ **临时实例到这里就没了**（这一条会话结束了，那份副本的使命也就完了）。
    //
    //    ★ **必须排在 `destroySurface` 之后**，次序是承重的：那个调用会销毁这一块
    //      视图，而 `releaseEphemeral` 里 `clearLayoutStorage` 拿 `livePartitions()`
    //      当"正被用着"的守卫。排在前面的话那块视图还在 ⇒ **分区那一半被静默跳过**
    //      ⇒ 每一次回收都在盘上留一份垃圾，而它看起来像"没清干净"，不像"顺序错了"。
    //
    //    ★ 传的是 `rec.controller.layoutId`（**这一次会话的**实例键），不是"当前
    //      活跃连接"那个组 —— 多开时后者是别人的，传错会把别人那份正在跑的数据清掉。
    releaseEphemeral(rec.controller.layoutId);
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
  const plugin = rec.plugin;
  if (snap.state === State.RUNNING && snap.origin) {
    if (!plugin) {
      // 未知服务：**绝不建界面**（那个端口上跑的可能是任何东西），也绝不 POST 口令。
      // 但它自己那一块必须收掉（上面那道状态闸已经收过了）。
      win.destroySurface(slot);
      await warnUnknownService(slot, snap);
    } else if (plugin.contributes.surface) {
      await ensureSurface(rec, snap);
      if (plugin.attach) await plugin.attach(pluginContext(rec), snap);
    } else {
      // 这个插件不要界面（比如中转站）：**它自己**那一块收掉。
      //
      // ★★ 这里从前是 `win.hideSurface()` —— "把窗口里那一块收掉"。多开之后那是
      //    一次**越权**：起 sshd 时（以及它每次心跳、每次隧道重建时）会把
      //    code-server 那块正跑着的页面一起销毁，而用户看到的是"我的编辑器忽然
      //    没了"，日志里一个字都没有。
      win.destroySurface(slot);
      if (plugin.attach) await plugin.attach(pluginContext(rec), snap);
    }
  }

  // 遮罩与忙碌位跟着**前台**那一条走：它们是"占满整块界面"的东西，而屏幕只有一块。
  if (slot === frontSlot()) {
    if (snap.state === State.RUNNING && snap.warning) {
      await win.showOverlay(snap.warning);
      win.setBusy(true);
    } else if (snap.state === State.RUNNING) {
      win.hideOverlay();
      win.setBusy(false);
    }
  }
}

/**
 * 插件注册表。**一个根，一条来路。**
 *
 *   `site`  站点池 —— 站点分发的插件落在这里（见 site-plugins.js）。**唯一的**根。
 *
 * ★ 这里从前还有第二个根：`pool`（本机池，用户自己装的那些，要开发者模式开关才
 *   加载）。它连同那个开关、那个安装器、以及`allows` 里那条**免同意**的分支一起
 *   删掉了 —— 理由见下面 `roots` 那一段的注释。
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
  //
  // ★ **只有一个根，这是这次删除的结论，不是"暂时只剩一个"。** 从前还有第二个根
  //   （`~/.slurmate/plugins`，"本机池"），它让用户从本机挑一个包装进去、或者干脆
  //   拷一个插件目录进去 —— 那条路**整类绕过同意闸**，而 `docs/PLUGIN-SPEC.md`
  //   §5.2 明文写着「**禁止**给任何一类插件开免同意的口子」。要多加一个根，
  //   先回答 §5.2 那个问题：它上面每一份凭什么免同意？答不上来就不许加。
  { dir: sitePoolDir, source: 'site' },
], {
  /**
   * 同意闸。**每一个插件、每一条来路，没同意过就不加载。**
   *
   * ★ 这里从前有一句 `entry.source !== 'site' || …` —— 本机池那一份不问。
   *   豁免的理由（"用户自己刚放进去的，让他同意自己是空话"）在池存在时看着成立，
   *   但它的代价是把一条**没有分支的规则**变成一条**有例外的规则**，而 §5.2 紧跟
   *   着那句禁令写了理由：「规则一有分支，绕过它的路就会长出来」。池就是那个分支，
   *   所以它连同豁免一起删掉了。
   *
   * ★ 判据是**全长摘要**（见 config.isTrusted）。这里拿到的是 `inspectDir` 从
   *   磁盘上算出来的那个值，不是站点自报的。
   *
   * ★ `cfg` 在模块加载期还是 null（注册表在那一刻就构造了）—— 那时**一个插件都
   *   加载不了**。这里从前写的是 `!cfg ||` 也就是**放行**，与它上面那句注释正好
   *   相反；今天不出事只是因为那一刻算出来的路径（`sitePoolDir()` 依赖 cfgDir，
   *   而 cfgDir 那时还是 null）几乎必然不存在。删掉池之后它就是这条闸上唯一的
   *   缺口，所以一并收成 **fail-closed**：读不到台账 = 没同意过。
   */
  allows: (entry) => Boolean(cfg)
    && config.isTrusted(cfg, entry.plugin.id, entry.plugin.version, entry.digest),
});

/**
 * **池**目录 —— 装进来的插件都落在这里。**今天只有一条来路：站点分发。**
 *
 * ★ 这里从前有两个目录：这一个，加上 `~/.slurmate/plugins`（"本机池"，用户自己
 *   挑一个包装进去、或者拷一个插件目录进去的地方）。本机池连同它那条**免同意**
 *   的路一起删掉了，理由见 registry 的注释。
 *
 * ★ `~/.slurmate/plugins` 那个目录**不删** —— 0.2.0 是最后一个公开版本，而它带着
 *   本机池，所以升级上来的用户那里可能真的躺着东西。删用户的文件是另一回事；
 *   今天的处理是"不再读它"，并在启动时说一句（见 bootstrap）。
 *
 * ★ 开发者模式落在独立命名空间里：拿假后端跑**绝不去读、更不去写**用户真实的那份池。
 */
function sitePoolDir() {
  try {
    return dev.developerMode
      ? path.join(cfgDir || '.', 'site-plugins')
      : path.join(app.getPath('home'), '.slurmate', 'site-plugins');
  } catch {
    // ★ 拿不到就返回 null，而 null 在那条路上意味着"这个根这次不加载"。
    //   把一个次要功能的失败变成**整个客户端起不来**不值当。
    return null;
  }
}

/**
 * 说一句：`~/.slurmate/plugins`（从前的"本机池"）**不再被读了**。
 *
 * ★ 只在那个目录**真的有东西**时说。空目录、或者从来没用过本机池的人，不该看见
 *   一条关于它的通知 —— 那是噪音，而且会让人以为自己做错了什么。
 *
 * ★ 措辞只说**事实**：那个东西不再生效了、里面的文件还在原处。不许断言"是谁放的、
 *   为什么"，也不许建议"可以删掉" —— 客户端不知道，而且那是用户自己的目录。
 *
 * ★ 这是 v0.2.0 之后唯一一处还知道本机池存在过的地方。等哪天确定没人再从那版
 *   升上来了，这个函数连同它的调用点一起删。
 */
function warnLegacyPool() {
  let dir;
  try {
    dir = path.join(app.getPath('home'), '.slurmate', 'plugins');
  } catch {
    return;
  }
  try {
    if (fs.readdirSync(dir).length === 0) return;   // 空目录没什么好说的
  } catch {
    return;                                        // 不存在 ⇒ 更没什么好说的
  }
  win && win.pushNotice('info',
    `${dir} 里的东西不再被加载了 —— 客户端现在只认站点分发的插件。`
    + '那个目录没有被动过，里面的文件还在原处。');
}

// ── 开发者模式：假站点的插件来源 ────────────────────────────────────────────

/**
 * 假站点默认分发哪棵树 —— **仓库里的 `plugins/`**。
 *
 * ★ 传函数而不是路径的地方（backend-fake）看的是**每次现算**：从源码跑与从安装包
 *   跑是两个事实。返回 `null` = 这个目录不存在（安装包里没有它）。
 */
function defaultDevPluginSourceDir() {
  const d = path.join(__dirname, '..', '..', '..', 'plugins');
  try { return fs.statSync(d).isDirectory() ? d : null; } catch { return null; }
}

/**
 * 假站点这次从哪个目录读插件：用户选过的那个，没选过就是默认那棵。
 *
 * ★ 用的是**生效值**（`dev`），不是盘上那个值（`devSaved`）—— 换来源要重启，
 *   理由与那个开关一样：假站点和真的守护进程一样，插件清单是**启动时的快照**。
 */
function devPluginSourceDir() {
  return dev.pluginDir || defaultDevPluginSourceDir();
}

/**
 * 「这个目录里有几个插件」—— 给界面上那个选择目录的按钮报数用。
 *
 * ★ 报的是**扫描结果**，不是站点最终报出去的清单：坏清单在这里要说出来（作者的
 *   清单里少一个字段，他要看到的是"3 个目录只有 1 个能用"，而不是一句"一个都没有"）。
 *   站点那边照守护进程的样子**静默跳过**坏清单，那是另一件事。
 *
 * @returns {{dir:string|null, plugins:string[], skipped:object[]}}
 */
function devSourceReport(dir) {
  const target = dir === undefined ? devPluginSourceDir() : dir;
  const r = plugins.scanPluginCollection(target || '');
  return {
    dir: target || null,
    plugins: r.plugins.map((p) => p.name),
    skipped: r.skipped.map((s) => ({ name: s.name, why: s.why })),
  };
}

/**
 * 开发者模式那一组字段，给界面用。**一处形状**：bootstrap 与那三个动词共用它 ——
 * 各拼一份的话，`on` 与 `saved` 迟早有一处写错，而那个错的症状是"点了一下没反应"。
 */
function devView() {
  return {
    on: dev.developerMode,
    saved: devSaved.developerMode,
    pluginDir: dev.pluginDir,
    pluginDirSaved: devSaved.pluginDir,
    defaultPluginDir: defaultDevPluginSourceDir(),
    source: devSourceReport(),
  };
}

/** 开发者模式下，假站点的插件来源一个插件都读不出来时**说一句**。 */
function warnDevPluginSource() {
  if (!dev.developerMode) return;
  const rep = devSourceReport();
  if (rep.plugins.length) return;                 // 有东西就什么都不说
  const where = rep.dir ? `「${rep.dir}」` : '默认的位置';
  const why = rep.skipped.length
    ? `那里有 ${rep.skipped.length} 个目录，但没有一个读得出清单：`
      + `${rep.skipped[0].name}：${rep.skipped[0].why}`
    : (rep.dir
      ? '那个目录里一个子目录都没有（每个子目录应该是一个插件，里面有 plugin.json）。'
      // ★ 只说**事实**（那个位置不存在），不断言"为什么" —— 那个位置的来历是
      //   "仓库里的 `plugins/`"，而不存在的原因可能是打包、可能是被人挪走了。
      : '默认那个位置（仓库里的 `plugins/`）不存在。');
  win && win.pushNotice('warn',
    `开发者模式：假站点从 ${where} 一个插件都读不出来 —— ${why}`
    + '要让它有东西分发，就在下面「插件来源」里选一个你自己的插件目录。');
}

/** 暂存根：站点池的**兄弟目录**（换入用的 `rename` 要求同一个文件系统）。 */
function siteStagingDir() {
  const pool = sitePoolDir();
  return pool ? path.join(path.dirname(pool), '.site-staging') : null;
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
async function ensureSurface(rec, snap) {
  const plugin = rec.plugin;
  const surface = plugin.contributes.surface;
  if (!surface) return;

  // 分区：**由插件自己声明的身份长出来**（见 plugin-data.js）。声明了分实例的插件
  // 按布局组分（同一个组的若干条连接共用一份 localStorage，那正是布局组存在的
  // 理由）；没声明的只有一份 —— 一个网页应用自己的状态该跟它自己走，跟会话走会在
  // 每次重开时重置。
  //
  // ★ 这里从前是一个三元表达式（`layout` 为真走 `persist:layout-<组 id>`，否则走
  //   `persist:plugin-<插件 id>`）。那两半都**硬编码**在这一个表达式里：跨版本共享
  //   与否、按不按实例分，作者一句话都说不上，而"加一个作者写了却没人读的字段"
  //   正是这个仓库一路在删的形状。
  const partition = pluginData.partitionOf(
    pluginData.identityOf(plugin, snap.layoutId));

  // 换布局组 = 换分区 = 销毁重建。用户看得见的那件事（编辑器布局重置了）必须
  // 说出来，否则他只会觉得"我的设置莫名其妙没了"。
  //
  // ★ 判据是**这一个槽**自己的分区，不是"窗口里那一块"的分区 —— 后者在多开下
  //   会拿到**别人的**分区：该重建的判定成"没变"（页面继续跑在旧分区里，而界面上
  //   完全看不出区别，正是上面那句注释说的那件事），不该重建的被判成"变了"。
  const has = win.hasSurface(rec.slot);
  const rebuilt = has && win.surfacePartition(rec.slot) !== partition;
  // `demo` 这个参数是 windows.js 的：true 时给那块视图注入 `preload/demo.js`，
  // 好把「被外壳吞掉的按键」推回面板（对照用）。只有假后端才要这份诊断 ——
  // 判据跟着**这次会话的后端**走（`snap.dev`），不是跟着那个开关走。
  await win.showSurface({
    slot: rec.slot, url: snap.origin + surface.path, partition, demo: snap.dev,
  });
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
 * ★ **参数是那一条会话的记录**，不是插件对象 —— 因为这里每一个"我"都必须是**这一条
 *   会话的**：`session()` 是它的会话视图，`win` 是它那块界面。从前这里收 `plugin`
 *   并去读模块级的"当前会话"，多开之后那句"当前"没有定义了，而失败形态不是崩溃：
 *   是 code-server 拿着**另一条会话的**口令去 POST，然后弹一句"控制节点还没返回
 *   会话口令"。
 *
 * ★ **插件能用的一切都在这里。** 它不能 `require` 客户端的源码 —— 插件装在池里
 *   （`~/.slurmate/site-plugins/<id>/<版本>/`），相对路径指不到客户端；就算指得到，
 *   那种依赖也是无法检查的。所以缺什么就在这里加什么，而不是让插件绕过这份清单。
 */
function pluginContext(rec) {
  const plugin = rec.plugin;
  return {
    /**
     * 这块界面自己的那两件事，**绑在这一条会话上**。
     *
     * ★ 从前递的是整个 `ShellWindow`。多开之后那是**张冠李戴**：`surfaceSession`
     *   会拿到"窗口里那一块"的 session，而 code-server 拿它去查 cookie jar ——
     *   查错一个分区，症状是"自动登录失败（HTTP 200，未拿到会话 cookie）"，而
     *   口令本身是对的。
     *
     * ★ 顺带收窄了：插件本来就不该碰 forceClose / pushSessions / pushNotice 那些，
     *   "能碰什么"这份清单撑大没有任何好处。
     */
    win: {
      // ★ 是**取值器**，不是方法 —— 插件那边写的是 `const ses = ctx.win.surfaceSession`。
      //   把它改成方法不会报错，只会让 `ses` 变成一个函数而一路传下去（`ctx.login`
      //   拿它当 Electron session 用），失败形态是"自动登录莫名其妙不工作"。
      get surfaceSession() { return win.surfaceSession(rec.slot); },
      reloadSurface: () => win.reloadSurface(rec.slot),
    },
    /**
     * **这一条会话属于哪条连接**（只读，拿不到就是 `null`）。
     *
     * ★ 从前插件拿的是**整个 `config` 模块**加 `ctx.cfg` —— 那既是"当前活跃连接"，
     *   又是整个 `config.json` 的**写**权（`setLayoutPort` 就是这么用的）。现在只给
     *   这一条会话**自己**那点事实，而且是**副本**：插件改一个字段不该在下一次
     *   `saveConfig` 时被原样写回磁盘 —— 那是把配置文件的写权限交给插件走一条看不见
     *   的路。
     *
     * ★ 「属于**哪条**连接」而不是"当前活跃的那条"：多开之后两者会分家 —— 会话跑在
     *   C1 上，用户把活跃连接切成 C2，按"当前"去拿会把 C2 的用户名写进 C1 那份
     *   ssh 配置。唯一的例外是**重连接回来的**会话（它不知道自己属于谁，只能取活跃
     *   连接那个），见 `reattachOne` 与账本 S26。
     *
     * ★ 只给"一条连接是什么"那几个字段。**布局组的事实不在这里** —— 那是另一条轴，
     *   而快照里已经有了（`snap.layoutId`）。在这里再放一份等于把两条轴又焊回一个
     *   对象上。
     */
    connection: () => {
      const c = (cfg.connections || []).find((x) => x.id === rec.connectionId);
      return c ? Object.freeze({
        id: c.id, label: c.label, user: c.user, host: c.host, port: c.port,
      }) : null;
    },
    /** 框架的 SSH 钥匙工具箱（ed25519 ↔ OpenSSH 格式）。纯 Node `crypto`，
     *  没有任何"读到客户端自己那把私钥"的入口 —— 见 keys.js。 */
    keys,
    dev: dev.developerMode,
    // **这一条会话的**视图。不是"当前那一个" —— 那个概念被这次改动删掉了。
    session: () => (rec.controller && rec.controller.session) || null,
    whoami: () => whoami,
    /**
     * **用户自己的**家目录。开发者模式必须落在沙盒里 —— 见 sshd 插件。
     *
     * ★ 搬家之后它的**含义收窄了**：从前它是"插件写文件用的地方"，而现在插件该写的
     *   是 `dataDir()`；这一条留给"要碰**用户自己的**文件"的场合 —— sshd 往
     *   `~/.ssh/config` 加那一行 Include 就是唯一的例子。★ 别拿它当数据目录用：
     *   它是**所有插件共用的一个根**，两个插件会在里面撞上。
     */
    home: () => (dev.developerMode ? cfgDir : app.getPath('home')),

    /**
     * **这个插件自己的**数据目录（绝对路径）。★ **目录可能还不存在** —— 由第一次
     * 写它的那次写盘建出来（`atomic-write.js` 的 `mkdir` 默认开着）。
     *
     * ★ 与 `home()` 的分工：那个是"用户的家目录"（所有插件共用），这个是"你的落点"
     *   （按身份分：插件 id / 共享组 / 可选实例）。★ 插件要存自己的东西，用这个 ——
     *   自己发明一个位置（从前 sshd 就是那样干 `~/.slurmate/ssh/` 的）会让基座既不知道
     *   它在哪儿、也没法把它列给用户看。
     *
     * ★ 路径由**身份**算出来（`plugin-data.js` 的第三个落点），所以它和对账看到的是
     *   同一个目录 —— 那是"用户看得见、删得掉"的前提。
     *
     * ★ **没有实例参数了** —— 实例由框架从**这一条会话**填（今天就是它那个布局组）。
     *   与 `login()` 同一条理由：插件没法把一个它不传的参数传错。
     *
     *   从前那个"声明了分实例却不传就抛"的设计是在守一条真实的不变量，
     *   而它**够不着**：插件要拿实例只能从 `snap.layoutId` 里拿，而 `prepare()`
     *   根本没有 `snap` —— 一个能多开、又要在提交前写数据的插件，除了猜没有别的
     *   办法。改成框架填之后，那个抛只剩最后一道（`identityOf` 自己那道，给
     *   `ensureSurface` / 对账那些走参数化的调用点用）。
     *   ★ 而框架填的那一半**有一个前提**：`rec.controller` 得先构造出来（实例读的是
     *   它那个 `layoutId`）—— 见 `startSession` 里那段次序说明。
     *
     * ★ 算不出根来的时候**抛**，不返回 null：一个 null 会让插件拼出一个**相对路径**
     *   （落进进程的 cwd 里），那比抛严重得多。
     */
    dataDir: () => {
      const root = pluginDataRoot();
      if (!root) {
        throw new Error('还不知道插件的数据目录该放在哪儿（配置目录还没定下来）。');
      }
      return path.join(root, pluginData.dataDirNameOf(
        pluginData.identityOf(plugin, rec.controller && rec.controller.layoutId)));
    },
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
async function warnUnknownService(slot, snap) {
  const key = `unknown|${snap.sessionId}`;
  if (!registry.once('__unknown__', key)) return;

  win.pushNotice('warn',
    `这个会话的服务类型未知（作业 ${snap.jobId || '?'}）—— ${unknownWhy(slot, snap)}\n`
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
function unknownWhy(slot, snap) {
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
  // ★ 取的是**这一条会话的**说法：多开时读那个全局的会把根因说成别人的。
  const rec = sessions.get(slot);
  if (rec && rec.pluginWhy) return `${rec.pluginWhy}。`;
  return '它多半是别的进程提交的，控制节点没有关于它的记录。';
}


// ── 关闭 ────────────────────────────────────────────────────────────────────
/**
 * 把**所有**会话停掉。返回 `[{slot, sessionId, res}]`，顺序与表里一致。
 *
 * ★★ **只此一份实现，三条路都走它**：关窗收尾、退出前、主动断开。它们要做的是
 *    同一件事 —— **每一条会话都发 goodbye**。各写一遍的代价已经在变异验证里
 *    现过一次形：同一个循环出现在两个地方时，改一处、另一处静默地少停一条，而
 *    用户看到的是"关掉窗口会结束会话"，集群上却还烧着一个作业（那是账本 F13
 *    的同一类：说了一句话，而它不成立）。
 *
 * ★ **不跳过没有 sessionId 的那些**：正在提交（还没有会话号）的那一条也要停 ——
 *   `SessionController.stop()` 自己分得清该发什么。跳过它的话，一次"提交中就关窗"
 *   会留下一个客户端已经不管、而控制节点上正在长大的会话。
 */
async function stopAllSessions() {
  const out = [];
  for (const rec of [...sessions.values()]) {
    const c = rec.controller;
    if (!c) continue;
    out.push({ slot: rec.slot, sessionId: c.sessionId, res: await c.stop() });
  }
  // ★★ 临时实例的**后备回收**。正常路径是 `_renderSession` 里那一处（会话走到终态
  //    时回收），但那一条依赖事件循环继续跑 —— 而 `before-quit` 那条路紧接着就是
  //    `app.exit(0)`，等不到。
  //
  //    ★ 与 `_renderSession` 那一处**不是重复**：`releaseEphemeral` 用 `Map.delete`
  //      当旗子，第二次调用是 no-op（见它的注释）。这里多一次调用换的是"进程退出
  //      这条路上也一定收干净"，而代价是零。
  //    ★ 遍历一份**拷贝**：`releaseEphemeral` 会改 `tempLayouts`。
  for (const id of [...tempLayouts.keys()]) releaseEphemeral(id);
  return out;
}

/**
 * 关窗 = 结束会话并释放资源。
 *
 * **没有「保留作业」这条分支** —— 见 session.js 的 stop()：真正需要保住作业的
 * 是「客户端没能说上话」那种情况（断电、睡眠、网线被拔），而那些情况下这里的
 * 代码根本不会被执行到。能给这条分支投票的只有用户的主动点击，于是它只会误伤。
 */
/**
 * 收尾：结束会话（如果还在跑）+ 拆掉后端。
 *
 * ★ **关窗口与「立即重启」都走这里**，不各写一份。「关掉窗口同样会结束会话」是
 *   给用户的承诺，而重启是同一个承诺的另一种说法 —— 两处各写一遍的话，下一次
 *   改了一处，另一处会静默地不同（比如少了那句 `addPendingGoodbye`）。
 */
async function shutdown() {
  win.setBusy(false);
  try {
    // ★★ 走**唯一那份**实现（见 `stopAllSessions`）。
    for (const { sessionId, res } of await stopAllSessions()) {
      if (!res.ok) {
        win.pushNotice('error', res.detail);
        if (sessionId) config.addPendingGoodbye(cfgDir, sessionId);
      }
    }
  } finally {
    // 后端的收尾也要做：假后端有一个真的在监听的 HTTP 服务，
    // 不关的话进程里会留着一个没人管的监听套接字。
    try { await backend.close(); } catch { /* 尽力而为 */ }
  }
}

async function handleWindowClose() {
  await shutdown();
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
  // 此前这里写的是 `backend._conn` —— 那是 SSH 后端的内部名字，假后端用的是
  // 另一个（`_connected`），于是这一行在假后端上恒为真地提前返回；上面还有一行
  // `kind === 'demo'` 也直接 return。两重保险合起来，让整条「接上已有会话」的路
  // 在**唯一能测它的地方**完全不可达 —— 而「上次没关干净的会话」恰恰是假后端
  // 存在的理由（真机上要造出这个状态极难）。
  if (!backend.connected) return;

  // 先把上次没发出去的 goodbye 补上
  for (const item of config.listPendingGoodbye(cfgDir)) {
    const resp = await backend.rpc({ op: 'goodbye', session_id: item.session_id });
    if (resp && (resp.ok || (resp.error && resp.error.kind === 'not_found'))) {
      config.removePendingGoodbye(cfgDir, item.session_id);
    }
  }

  // ★★ **用 `list`，不是不带 session_id 的 `status`。**
  //
  //   那一版 `status` 只返回**最新**那一条占着位置的会话。多开之后那意味着：
  //   重连只接得回一个，**其余的在控制节点上继续跑而客户端不知道** —— 没有心跳
  //   ⇒ 300 秒 `suspect`、1800 秒 `orphaned` + `scancel`。**那是用户的作业被悄悄
  //   杀掉**，而界面上一个字都不会有。这一条路径是"多开"这个改动**自己**让它变成
  //   可达的（从前服务端最多只允许一个会话）。
  //
  //   `list` 返回该 uid 最近 50 条会话，**`with_secret=False`** —— 所以它只够筛出
  //   "还占着位置"的那几条；它们的完整视图（含自动登录要的口令）再逐个用带
  //   `session_id` 的 `status` 取，而那一个默认 `with_secret=True`。
  //   用现成的两条路，不为了这件事去改协议。
  const listed = await backend.rpc({ op: 'list' });
  if (!listed || !listed.ok) return;
  const live = ((listed.data && listed.data.sessions) || [])
    .filter((r) => r && SERVER_LIVE_STATES.includes(r.state));
  if (!live.length) return;            // 没有活跃会话，正常路径

  win.pushNotice('info', live.length > 1
    ? `发现 ${live.length} 个还没结束的会话，正在逐个接上。`
    : '发现一个还没结束的会话，正在重新接上。');

  for (const row of live) {
    const one = await backend.rpc({ op: 'status', session_id: row.session_id });
    if (!one || !one.ok) continue;
    const view = one.data && one.data.session;
    if (view) await reattachOne(view);
  }
}

/**
 * 接上**一条**会话。
 *
 * @param {object} s 带 `session_id` 的完整会话视图（含口令，见 `tryReattach`）
 */
async function reattachOne(s) {
  // ★ 用**注册表**归一，而不是在会话对象上直接判。三种输入三种答案，理由见
  //   plugins/index.js 的 resolve()：`<id>@<版本>` 查池；服务端**没说**是哪一种
  //   服务（`null`，或这个键根本不存在）时**绝不猜**。
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
  // ★ **重启之后，"这条会话是哪条连接的"已经不知道了** —— 守护进程的会话视图里
  //   没有这个字段（它只知道是谁提交的、用的哪个插件版本）。唯一能用的是**当前
  //   活跃连接**，于是接回来的会话拿到的可能就是"不是它自己的"那条。
  //   这是已知的、说得出原因的一格，记在账本 S26；**新开的**会话没有这个问题。
  //
  //   ★ 走的是 `conn.layoutId` 而不是 `layoutForSession(conn)`：接回一条会话是
  //     **只读**的一步，不该顺手造出一个布局组来（那条路只在开会话时走）。
  //     ★ 而**认领**（下面那一行）会造一个**临时**组 —— 那不是"顺手造一个持久的组"，
  //       它是这一次接管**必须要有的**实例键，见那段说明。
  const conn = config.activeConnection(cfg);
  const baseLayoutId = (plugin && plugin.contributes.layout && conn)
    ? conn.layoutId : null;
  if (plugin && plugin.contributes.layout && !baseLayoutId) return;   // 没配置连接，接不上

  // ★★ **重连必须走同一个 `claimInstance`**（不是"照抄 startSession 那两行"）。
  //
  //    临时组只存在于**上一个进程的内存**里 —— 配置里没有它。所以重启之后 N 条
  //    code-server 会话全都算成"连接那个组" ⇒ 全部落进同一个槽 ⇒ **只接回第一条**，
  //    其余的在控制节点上继续跑、心跳没了 ⇒ 300 秒 `suspect`、1800 秒 **`scancel`**。
  //    而那条提示语还是错的（"想留住它就先用 `slurm` 把它的作业停掉" —— 那是
  //    **我们自己的**会话）。走到认领之后：第一条认领连接那个组，其余各拿一个临时实例。
  //
  //    ★ 代价（账本 S26）：接回来的临时实例拿到的是**新**的临时 id ⇒ 新的分区，
  //      重启前那一份 localStorage 变成孤儿（面板上看得见、删得掉）。这是"临时"的
  //      应有之义 —— 但界面上要说得出来（`temporary` 那一格就是为它留的）。
  const layoutId = baseLayoutId ? claimInstance(baseLayoutId, plugin) : null;

  // ★ 临时实例的起点数据：与 `startSession` **同一个函数、同一句判据**（"认领给的组
  //   不是连接那个组"）。★ 重连接回来的临时实例也必须是"持有者那份的快照" ——
  //   少了这一句，同一个插件在"开局"与"重启接回"两条路上会得到两种第二份
  //   （一种有起点、一种空着），而用户看不出为什么。
  if (baseLayoutId && layoutId !== baseLayoutId) {
    snapshotTempData(plugin, baseLayoutId, layoutId);
  }

  // ★ 还在排队（reserved/submitted）的会话**也必须接上**，哪怕它还没有 tunnel_target。
  //   此前这里写的是 `if (!s || !s.tunnel_target) return;` —— 于是「作业还在队列里」
  //   这种最需要说出来的情况反而完全看不见：界面照常显示「启动 code-server」，
  //   用户一点就提交了**第二个**作业，而第一个还在排队。这既正是「单一启动」要防的
  //   资源占用，又恰好是「换了电脑 / 上次没关干净」最常见的形态 —— 重启客户端时
  //   作业往往还没跑起来。
  //   （`tryReattach` 筛的就是守护进程的 `OCCUPYING_STATES`，所以走到这里的一定是
  //     「还占着位置」的会话。）
  const queued = !s.tunnel_target;

  // 槽已经在表里 ⇒ 这一条与已经接上的某一条抢同一份资源。**不覆盖**：覆盖会把先接上
  // 的那条记录连同它的心跳一起丢掉（心跳一停，那个作业 1800 秒后被 scancel），
  // 而用户看到的只是"少了一个标签"。
  //
  // ★ 判据是 `occupied(slot)`，与 `startSession` **同一口径**（从前这里是
  //   `sessions.has(slot)`，两个函数两个口径）。差别在**已经结束的那些记录**：
  //   它们还留在表里（界面要显示"已结束"），而它们**不占着槽** ——
  //   按 `sessions.has` 去判，一条已经死掉的记录会挡住一条真会话的重连。
  //   ★ 走到这里还没被拒的，只有"`concurrent: false` 的插件、而那个槽上真的
  //     有一条活会话"（能多开的那些已经在上面的认领里各拿了一个新组）。
  const slot = pluginData.slotOf(layoutId);
  if (occupied(slot)) {
    const held = sessions.get(slot);
    win.pushNotice('warn',
      `控制节点上还有一个会话（作业 ${s.job_id}）与已经接上的`
      + `「${(held.plugin && (held.plugin.displayName || held.plugin.name)) || '某一条'}」`
      + '占着同一个位置，没法同时接上。它仍然在跑，会在超时后被控制节点回收 —— '
      + '想留住它就先用 `slurm` 把它的作业停掉。');
    return;
  }

  const rec = { slot, plugin, pluginWhy: why, controller: null,
                connectionId: conn ? conn.id : null };
  rec.controller = new SessionController({
    backend, layoutId,
    // 同上（startSession 那处）：只有**没有布局组**的会话要报实际端口。
    onRelayPort: () => onSessionChange(slot),
    getExcludedPorts: () => excludedPortsFor(rec),
    // 接上来的这个会话是哪个插件的 —— 快照要靠它分派（见 serviceKind 的说明）。
    // 认不出时**原样**记下，于是界面仍然得出「未知」。
    requestedKind: plugin ? plugin.name : s.service_kind,
    needsPubkey: Boolean(plugin && plugin.contributes.submitPubkey),
  });
  rec.controller.on('change', () => onSessionChange(slot));
  rec.controller.sessionId = s.session_id;
  rec.controller.session = s;
  sessions.set(slot, rec);

  // 认不出的插件用**非布局组**的基准端口：它的端口绝不能落进任何布局组（否则会与
  // 那个组的 origin 撞上），而它自己听在哪个端口我们并不知道。有布局组的会话用组
  // 自己那个端口 —— 判据是 layoutId 有没有（框架的事实），不是"是哪个插件"。
  // ★ 与 `startSession` 同一条：走 `layoutPortOf`（**没有回落**），临时实例不在
  //   配置里，那条带回落的取端口函数（已删）会让它从 18080 起扫、撞上持有者那个端口。
  const preferredPort = layoutId
    ? layoutPortOf(layoutId)
    : config.RELAY_PORT_BASE;
  if (queued) {
    // 交给现成的状态机往下走：等登记 → 建隧道 → （回到 RUNNING 时 onSessionChange
    // 会自己把视图/ssh 配置建起来，界面标题也已经有「排队中 — 作业 N」那一档）。
    rec.controller.state = State.QUEUED;
    await rec.controller._afterSubmit({ preferredPort });
    return;
  }

  rec.controller.state = State.RUNNING;
  await rec.controller._bringUpTunnel(preferredPort);
  // ★ 走**同一个**渲染入口，而不是像以前那样直接调 openCodeServer。
  //   以前那条直路只服务 code-server 一种会话，而接上一个中转站会话时它会把
  //   隧道指向的 SSH 端口当成一个网页去加载。分派只有一个地方，就是 _renderSession。
  await onSessionChange(slot);
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
    dev: backend.kind === KIND.FAKE,
    // 开发者模式那两个设置。**`on` 与 `saved` 是两个问题**（见模块顶上的注释）：
    // `on` 是这次进程在不在开发者模式，`saved` 是用户在界面上要的是哪一个，
    // 两者不同 = 有改动等着重启。界面据此画那个复选框与「重启后生效」那一行。
    developerMode: devView(),
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
    // ★ 它的布局组上有会话在跑，就不许删。删掉的后果不是「少一条配置」：那个组会
    //   引用计数归零 → 被回收 → 浏览器存储被清 —— 而那块页面正在用那份存储。
    //   界面已经禁用了按钮，这里只是把它变成**权威**。
    //
    // ★★ 判据是「**那个布局组**上有没有会话」，不是「要删的是不是活跃连接」。
    //    后者是一个**已经错了**的判据，而多开把它变成一个**可达的删活数据**路径：
    //     ① 连接 C1（组 l1）活跃，起一条会话落在 l1；
    //     ② 把活跃连接切成 C2（组 l2）—— 这一步**不动引用计数**，C1 仍指着 l1；
    //     ③ 删 C1 ⇒ l1 计数归零 ⇒ 回收 ⇒ 抽掉会话脚下那个分区。
    //    唯一挡着它的是 `clearLayoutStorage` 里"正被那块界面用着就不清"，而多开
    //    之后那一句只能看到**前台**那一块 —— 前台不是它的时候形同虚设。
    const conn = (cfg.connections || []).find((c) => c.id === id);
    // 组的**名字**要在 commitConfig 之前记下来 —— 一回收，`cfg` 里就没有这个名字了，
    // 而清理失败时那句话要说清是**哪一个**组（"某个布局组"对用户没有用）。
    const goneLayout = conn && conn.layoutId
      ? config.findLayout(cfg, conn.layoutId) : null;
    const held = conn && conn.layoutId
      && [...sessions.values()].find((r) => occupied(r.slot)
        && r.controller && r.controller.layoutId === conn.layoutId);
    if (held) {
      return {
        ok: false, code: 'in_use',
        error: '这条连接的布局组上还有会话在跑，请先结束它再删除这条连接。',
      };
    }

    cfg.connections = cfg.connections.filter((c) => c.id !== id);
    if (cfg.activeConnectionId === id) {
      cfg.activeConnectionId = cfg.connections[0] ? cfg.connections[0].id : null;
    }
    // commitConfig 而不是 saveConfig：删掉最后一条指向它的连接之后，
    // 它的布局组引用计数归零，必须被回收（并清掉它的浏览器存储）。
    commitConfig();
    // ★ 而**删掉的可能是最后一条连接**：那一步 `pruneLayouts` 会跳过（它的守卫是给
    //   "从来没被任何连接指过的兜底组"用的，见 `reclaimLayoutGroup` 的注释），
    //   所以这里要显式回收 —— 否则"删条目就删数据"在最常见的场合（只配了一条连接）
    //   根本不发生。
    if (!cfg.connections.length && conn && conn.layoutId) {
      reclaimLayoutGroup(conn.layoutId, (goneLayout || {}).name);
    }
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
        port: config.nextLayoutPort(cfg, usedLayoutPortsAll(null)),
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
    // ★★ 「有没有会话在跑」这个问题的**对象变了**：从前是"窗口里那一个"（最多只有
    //    一个），现在是「**这条连接的布局组上**有没有会话」。判据必须跟着问题一起
    //    改 —— 前者在多开下会把另一条连接那个组上的会话当成"这个组的"，于是挪一个
    //    与这条连接无关的隧道端口。
    const live = [...sessions.values()].find((r) => occupied(r.slot)
      && r.controller && r.controller.layoutId === conn.layoutId);
    const sessionLive = Boolean(live);
    // ★ 不参与布局的插件（没有布局组的那些）**不能走 relisten**：它的端口不在任何
    //   布局组里，relisten 会去挪一个正在被使用的隧道端口 —— 而它对外的那份配置是
    //   隧道起来时才写的，挪完那一瞬间用户手上的连接指向一个没人监听的端口。
    //   所以那种会话只改配置、不动会话本身。
    //
    //   判据是 layoutId 有没有（框架的事实），不是"是哪个插件"（那是插件名）。
    const sessionInLayout = sessionLive && live.controller.layoutId !== null;
    const outsideLayout = sessionLive && !sessionInLayout;

    if (isActive && live && !outsideLayout) {
      const excluded = usedLayoutPortsAll(target.id);
      const r = await live.controller.relisten(target.id, target.port, excluded);
      if (!r.ok) {
        if (!existed) cfg.layouts = cfg.layouts.filter((l) => l.id !== target.id);
        return {
          ok: false, code: 'relisten_failed',
          error: '换端口失败，布局组没有改动：' + r.error,
        };
      }
      // ★ **不把 r.port 写回 target** —— 新组的端口是它**被创建时**定下来的那个
      //   （`nextLayoutPort`），顺移只是这一次会话的事。写回会把一次暂时的冲突
      //   变成永久的 origin 变更，而冲突消失之后 origin 回不去、那份布局也跟着
      //   白丢。（`relisten` 的 warning 已经把这个取舍告诉用户了。）
    } else if (isActive && !sessionLive) {
      // 没有会话在跑：只改标记，下次开会话就用它。
      // ★ 这里从前还有一个 `controller.setLayout(...)` —— 它改的是那个会话的
      //   `layoutId`。多开之后"那个会话"没有定义了，而**恰当地**：没有会话时
      //   本来就没什么可改的，标记落在 `cfg` 里（下面那句 setConnectionLayout）。
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

  // ── 本机的插件数据 ──
  //
  // 与 `app:bootstrap` 分开的**一次单独的对账**（理由见 auditPluginData 的注释）。
  // 只读：它不清理、不回收，只回答"本机还剩几份、哪一份没人用"。
  send('app:pluginData', async () => {
    const a = auditPluginData();
    return { ok: true, rows: a.rows, diskChecked: a.diskChecked, why: a.why };
  });

  /**
   * 删掉一份插件数据。**不可逆** —— 那里面是那个插件的编辑器布局、打开的标签页和
   * 登录状态，所以界面必须先问过用户。
   */
  send('app:deletePluginData', async (payload = {}) => {
    const { name } = payload;
    // ★ **判定权在这里**（照 `app:setConnectionLayout` 那条形状）：界面手里那份清单
    //   随时可能已经陈旧（刚连上、刚改过配置、刚装了插件），所以**重新对一遍账**，
    //   只认这一次算出来的那一条。判据本身在 plugin-data-audit.js 的 deletionVerdict。
    //   ★ 于是路径**只由 根 + 磁盘上的目录名 拼**，而 `name` 这个字符串只用来
    //   **匹配**某一行 —— `{name: '../../..'}` 匹配不上任何一行。
    //   ★ 「正被用着」那一格**不在这里判**：`auditPluginData()` 已经把活会话拿着的
    //   名字挡在 `rows` 之外了（两个根都挡）。在这里再判一次等于留一条够不着的分支。
    const fresh = auditPluginData();
    const verdict = dataAudit.deletionVerdict({ rows: fresh.rows, name });
    if (!verdict.ok) return verdict;
    // 删哪几个落点由**这一行**说了算（`places`）—— 一份数据的浏览器那一半与磁盘
    // 那一半是一起删的，只删一半的话下一次对账会把同一行再带回来。
    const r = await clearOneRow(verdict.row, fresh.roots);
    if (!r.ok) {
      return { ok: false, code: 'failed', error: `没能清干净：${r.error}` };
    }
    const row = verdict.row;
    const after = auditPluginData();
    return {
      ok: true, rows: after.rows, diskChecked: after.diskChecked, why: after.why,
      label: row.label,
    };
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
    // ★ **每一条都要停** —— 与 `shutdown()` 同一条理由：断开等于"我不要了"，
    //   不等于"我先走开，你继续烧着"。只停一个的话，剩下的那条在拆掉连接之后
    //   连心跳都没有了，只能等守护进程 1800 秒后的孤儿判定。
    for (const { res } of await stopAllSessions()) {
      // ★ **每一条的结果都要回填**，不是只在失败时 —— 只在失败时赋值的话，
      //   全都成功时 `released` 还是那个初值，于是调用方拿不到 `state`
      //   （界面靠它区分"已经释放了"与"只是请求发出去了"）。
      released = res;
      // 释放失败要说出来。守护进程的 released 并不保证作业真的停了
      // （见 docs/KNOWN-ISSUES.md 的 F12/F13），所以不能在这里宣布成功。
      if (!res.ok) win.pushNotice('error', res.detail);
    }
    await backend.close();
    whoami = null;
    partitions = [];
    sitePlugins = null;           // 断开之后就没有「站点开了哪些插件」可谈了
    // 待同意的那些是**这一次连接**的现场：换代 + 丢掉它们的暂存树（那是**我们
    // 自己的**草稿纸，删它不算"删站点的东西"）。不清的话，用户会看到一个来自
    // 已经断掉的站点的"同意"按钮。
    //
    // ★ `existing` 的那些**一个字节都不许动**：它们指向的是**池里那一份**，
    //   不是草稿。断开一次就把它删掉，等于"断个网就丢了用户已经同意的插件"。
    connectGeneration += 1;
    for (const p of pendingConsent) {
      if (!p.existing) sitePluginSync.discardStaged(p.stagedDir, p.stagedPkg);
    }
    pendingConsent = [];
    siteSync = null;
    versionVerdict = null;    // 连接级的结论，连着的那条没了它就不再成立
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
   * @param {string} [serviceKind] 插件名。**省略 = 缺省插件**（清单里标了
   *        `defaultService` 的那一个），与这个参数存在之前的行为一致。
   */
  send('app:start', async (resources, serviceKind) => {
    const r = await startSession(resources, serviceKind);
    return {
      ok: Boolean(r),
      slot: r ? r.slot : null,
      sessions: sessionViews(),
      front: frontSlot(),
    };
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

  // ★ **这里从前有五个本机池的入口**：`app:installPlugin`（从一个 `.splug` 装）、
  //   `app:uninstallPlugin`、`app:rescanPlugins`、`app:setDevPlugins`、
  //   `app:openPluginDir`。它们连同 `plugins/install.js` 整个文件一起删掉了。
  //
  //   ★ 值得记一笔它们各自的下场，因为**其中两个已经在界面上消失了很久**：
  //     · `uninstallPlugin` 渲染层零调用 —— 桥还留着，没有按钮。
  //     · `rescanPlugins` 的用途是"用户手工往池里放了东西之后重扫一遍"，而
  //       §5.1 恰恰要求那件事**不产生任何效果**，所以它连存在的理由都没有了。
  //   这就是"免同意的口子"那个分支的完整形状：**它长出来的东西比它自己多**。

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

    // ── ① 钉住签名者（§5.4）。**写在最前面，在任何文件移动之前。** ──
    //
    //   放在前面是为了让"钉不上"这件事**什么也没做**就退出去：`pinPluginKey` 只在
    //   "这个 id 已经钉在另一把钥匙上"时失败，而那本来就不该走到这里（`keyVerdict`
    //   在对话框出现之前就该拦下它）。真发生了，最不该做的事是"先把构件装上去，
    //   再报告钉子不对"。
    //
    //   ★ 没签名的那一份（`fingerprint` 是 null）**什么都不钉** —— §5.4 是"记下它的
    //     签名公钥"，而没有公钥可记。于是"作者先是裸发、后来开始签名"不会被拒绝；
    //     该被拒绝的是反过来的顺序。
    if (hit.fingerprint) {
      const pr = config.pinPluginKey(cfgDir, pins, id, hit.fingerprint);
      if (!pr.ok) {
        win.pushNotice('error', pr.error);
        return { ok: false, error: pr.error, plugins: pluginsView() };
      }
    }

    // ── ② 收下这一份（换入，或者对已在池里的那一份"原地认领"）──
    const mv = sitePluginSync.acceptStaged({
      stagedDir: hit.stagedDir, stagedPkg: hit.stagedPkg || null, siteRoot: sitePoolDir(),
      id, version, digest: hit.digest, existing: Boolean(hit.existing),
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

  /**
   * 不同意。
   *
   * ★ 两种情形的出路**不同**，因为"待同意的那一份"是两样东西：
   *
   *   `existing: false` 它是一份**草稿**（刚取回来、在暂存里）⇒ 删掉草稿。
   *                     站点那一份一个字节没动。
   *   `existing: true`  它**已经在池里**（上一次下来过、只是台账对不上）⇒ 删掉
   *                     池里那一份。
   *
   *   后者必须真的删：留着的话它就是一个"用户在界面上拒绝了、却仍然躺在磁盘上"
   *   的插件，而且下次对账会**以同一个形状回来**（台账里没有它、树还在）——
   *   用户点一百次不同意也去不掉它。
   *
   * ★ 同样**不**在文案里断言是他删的：这里是他点的，但"同不同意的判据"与
   *   "为什么本机没有那一份"是两件事，后者客户端不知道。
   */
  send('app:rejectPlugin', async (id, version) => {
    const hit = pendingConsent.find((p) => p.id === id && p.version === version);
    if (!hit) return { ok: false, error: '没有这个待同意的插件。' };
    if (hit.existing) {
      const d = sitePluginSync.dropPooledVersion(sitePoolDir(), id, version);
      if (!d.ok) { win.pushNotice('error', d.error); return { ok: false, error: d.error }; }
      // 台账里那条也一并清掉（通常是本来就没有），理由见 dropPluginVersion。
      config.forgetPlugin(cfgDir, cfg, id, version);
      registry.reload();
      win.pushNotice('info', `没有同意「${hit.title || hit.name}」，本机这一份已经删掉了。`
        + '站点上那份不受影响 —— 它还在的话，下次同步会再问你一次。');
    } else {
      sitePluginSync.discardStaged(hit.stagedDir, hit.stagedPkg);
      win.pushNotice('info', `没有同意「${hit.title || hit.name}」，它在暂存里那一份已经删掉了。`);
    }
    pendingConsent = pendingConsent.filter((p) => !(p.id === id && p.version === version));
    return { ok: true, plugins: pluginsView() };
  });

  /**
   * 删掉本机池里的一个版本 —— §5.3「删掉本机那一份 = 撤回同意」。
   *
   * ★ 界面上这个按钮挂在**没被加载的那些**上面（见 pluginsView 的 `inert`）。
   *   那些是"池里有一份、而台账对不上"的站点插件，它们没有"同意"的入口 ——
   *   因为站点此刻没有在报它们。所以对它们来说，"不要了"是唯一可做的动作，而
   *   在此之前**连这个动作都没有**：界面上一片空白。
   *
   * ★ 删完还要 `forgetPlugin`：台账里那条（如果有）一并消失。不删的话，下次对账
   *   会按"摘要与台账相符"**静默装回来、一个字都不问** —— 而那正是 §5.3 要防的
   *   那一件事。删掉之后它走进待同意，用户重新点一次。
   */
  send('app:dropPluginVersion', async (id, version) => {
    if (typeof id !== 'string' || typeof version !== 'string') {
      return { ok: false, error: 'id 与版本都必须是字符串。' };
    }
    const d = sitePluginSync.dropPooledVersion(sitePoolDir(), id, version);
    if (!d.ok) { win.pushNotice('error', d.error); return { ok: false, error: d.error }; }
    config.forgetPlugin(cfgDir, cfg, id, version);
    registry.reload();
    win.pushNotice('info', `本机那一份 ${version} 已经删掉了。`
      + '站点还在分发它的话，下一次同步会重新问你一次。');
    return { ok: true, plugins: pluginsView() };
  });

  /**
   * 面板启动时拉一次全量。
   *
   * ★ 回的是**列表 + 哪一个是前台**，不再是"那一个快照"。从前那个形状在多开下
   *   的失败形态不是崩溃，而是**看不见**：启动时自动接上来的会话里，只有最后一条
   *   会被画出来，其余的既没有标签也没有「结束会话」的入口。
   */
  send('app:states', async () => ({
    sessions: sessionViews(),
    front: frontSlot(),
    layouts: config.layoutPlan(cfg),
  }));

  send('app:doctor', async () => {
    const resp = await backend.rpc({ op: 'doctor' });
    return resp;
  });

  /** 把某一条会话抬到面板上面。**纯界面动作** —— 它不改任何框架状态。 */
  send('app:setFront', async (payload = {}) => {
    const slot = payload && payload.slot;
    if (!sessions.has(slot)) return { ok: false, error: '没有这一条会话。' };
    win.setFront(slot);
    await _renderSession(slot);
    win.pushSessions(sessionViews(), frontSlot());
    return { ok: true, front: slot };
  });

  // 只有一个语义：结束会话并释放资源。没有「保持作业运行」的开关。
  //
  // ★ 必须**指名**停哪一个。省略 slot 一律拒绝，而不是"停那唯一的一个" ——
  //   那个隐式缺省在多开下会变成"停错了另一条"，而调用方（界面）永远拿不准
  //   自己手里那个 slot 是不是还新鲜。
  send('app:stop', async (payload = {}) => {
    const slot = payload && payload.slot;
    if (!slot) return { ok: false, error: '没有说清要结束哪一条会话。' };
    const rec = sessions.get(slot);
    if (!rec || !rec.controller) return { ok: true };
    const r = await rec.controller.stop();
    win.pushSessions(sessionViews(), frontSlot());
    return r;
  });

  send('app:reload', async (payload = {}) => {
    const slot = (payload && payload.slot) || frontSlot();
    if (slot) await win.reloadSurface(slot);
    return { ok: true };
  });

  send('app:openExternal', async (url) => { await shell.openExternal(url); return { ok: true }; });

  // ── 开发者模式 ────────────────────────────────────────────────────────────
  //
  // ★ 这三个动词都**只写那个小文件**（`<userData>/dev-mode.json`，见 config.js），
  //   不碰 `cfg` —— 那个开关回答的是"这次启动读哪一份配置"，它自己不属于任何一份。
  //
  // ★ 它们都**不立即生效**。界面必须说清「重启后生效」，并且给一个重启的按钮；
  //   静默的半生效（后端没换、配置换了）是这个仓库一路上在清的那类问题。

  /**
   * 打开/关闭开发者模式。
   *
   * ★ 关掉时**不删沙盒**。里面是那个人的连接、密钥、插件与同意台账 —— 下次打开
   *   还在。它是**持久**的（这正是它叫开发者模式而不是演示的原因），而删用户的
   *   数据从来不是这个开关的职责。
   */
  send('app:setDeveloperMode', async (on) => {
    const want = Boolean(on);
    devSaved = config.saveDevSettings(app.getPath('userData'),
      { developerMode: want, pluginDir: devSaved.pluginDir });
    if (want === dev.developerMode) {
      // 改回了生效值（或者本来就想要这个）—— 没有悬着的改动，就不提"重启"那件事。
      win.pushNotice('info', want ? '开发者模式是开着的。' : '开发者模式是关着的。');
      return { ok: true, developerMode: devView() };
    }
    win.pushNotice('warn', (want ? '已打开开发者模式' : '已关闭开发者模式')
      + ' —— 重启客户端之后生效。'
      + (want ? '沙盒里的一切（连接、密钥、插件）留在本机，下次打开还在。' : ''));
    return { ok: true, developerMode: devView() };
  });

  /**
   * 选一个目录当假站点的插件来源（插件作者那条轻路径）。
   *
   * ★ **选完当场报"这个目录里读到几个插件"。** 不报的话，选错了的症状是
   *   "重启之后假站点一个插件都不报"，而那句话指不回原因 —— 作者会去查插件本身，
   *   而问题在他选的那个目录。
   *
   * ★ 一个插件都读不出来 ⇒ **不保存**，并如实说明。存下去的话它会一路生效到
   *   界面上那句"本站不分发插件"，而用户已经忘了自己选过什么。
   */
  send('app:pickDevPluginDir', async () => {
    const r = await dialog.showOpenDialog(win.win, {
      title: '选一个目录当假站点的插件来源',
      message: '每个子目录是一个插件（里面有 plugin.json）',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, cancelled: true };
    const dir = r.filePaths[0];
    const rep = devSourceReport(dir);
    if (!rep.plugins.length) {
      return { ok: false, dir, error: rep.skipped.length
        ? `「${dir}」里有 ${rep.skipped.length} 个目录，但没有一个读得出清单：`
          + `${rep.skipped[0].name}：${rep.skipped[0].why}`
        : `「${dir}」里一个插件都没有 —— 每个子目录应该是一个插件（里面有 plugin.json）。`
          + '没有保存。' };
    }
    devSaved = config.saveDevSettings(app.getPath('userData'),
      { developerMode: devSaved.developerMode, pluginDir: dir });
    win.pushNotice('info',
      `假站点的插件来源已改成「${dir}」（读到 ${rep.plugins.length} 个插件：`
      + `${rep.plugins.join('、')}）。重启客户端之后生效。`);
    return { ok: true, dir, plugins: rep.plugins, skipped: rep.skipped,
             developerMode: devView() };
  });

  /** 插件的来源改回默认（仓库里的 `plugins/`）。 */
  send('app:clearDevPluginDir', async () => {
    devSaved = config.saveDevSettings(app.getPath('userData'),
      { developerMode: devSaved.developerMode, pluginDir: null });
    const rep = devSourceReport(defaultDevPluginSourceDir());
    win.pushNotice('info', rep.dir
      ? `假站点的插件来源已改回默认的「${rep.dir}」。重启客户端之后生效。`
      : '已改回默认来源 —— 但那个位置（仓库里的 `plugins/`）不存在，所以假站点'
        + '依旧一个插件都发不出来。重启客户端之后生效。');
    return { ok: true, developerMode: devView() };
  });

  /**
   * 立即重启客户端（让上面那几个设置生效）。
   *
   * ★ 走的是与**关窗口同一套收尾**：会话还在跑就先结束它。用户点的是"重启"，
   *   那是一次明确的终止，不是断电 —— 不该指望守护进程的容错窗口替他保住作业。
   */
  send('app:restart', async () => {
    await shutdown();
    // relaunch + exit：`exit` 跳过 before-quit（那里面还会再做一遍收尾）。
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  // 开发者模式的调试控制 —— 复现那些在真机上极难复现的状态
  send('app:debug', async (what, arg) => {
    if (backend.kind !== KIND.FAKE) return { ok: false, error: '仅开发者模式可用' };
    if (what === 'daemon-down') backend.debugDaemonDown(20000);
    else if (what === 'tunnel-down') backend.debugTunnelDown(15000);
    else if (what === 'reap') backend.debugReap();
    else if (what === 'reset') backend.debugReset();
    // 让假站点"装了本客户端不认识的插件" / "把某个插件关掉" ——
    // 这两条路是"插件增减不许崩"的验收路径，必须能在开发者模式里走到。
    else if (what === 'extra-plugin') backend.debugAddSitePlugin('jupyter', 'JupyterLab');
    // ★ 站点侧那三个开关作用在**哪一个**插件上由调用方指定（不指定就取列表里
    //   第一个）—— 基座里没有插件名可写。一个都没装时这些开关无事可做，如实
    //   说出来，而不是静默地什么也没发生。
    else if (what === 'site-plugin-off' || what === 'site-plugin-no-job') {
      const picked = pickPlugin(arg);
      if (picked.error) return { ok: false, error: picked.error };
      // 这两件事**不一样**，所以是两个开关、两个 debug 方法：`off` 是管理员的
      // 开关（界面说"本站没开放它，找管理员"）；`no-job` 是本站部署没跟上
      // （界面说"装了它，但它没有作业侧实现"—— 管理员去开一下开关没用）。
      if (what === 'site-plugin-off') backend.debugDisableSitePlugin(picked.plugin.name);
      else backend.debugSitePluginNoJob(picked.plugin.name);
    }
    // 让假站点报一个指定的基座版本 —— 造版本握手那几态里真机上造不出来的两态
    // （站点比客户端新、以及两个大版本之间）。不传参数 = 恢复成"跟着本客户端走"。
    else if (what === 'daemon-version') backend.debugDaemonVersion(arg);
    // 造出「守护进程太旧，连 plugins 这个 op 都没有」—— 那条路上**每一个**字段
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
    // ★ 这里从前还有一个 `install-samples`：把仓库里那两个示例插件**直接用
    //   `installFrom` 装进池**。它随本机池一起删掉了。
    //
    //   它的注释写着"池为空时，这是本机唯一能看见界面的办法，顺带也就把
    //   手工安装那条路本身验了一遍"—— 而那正是问题：它让**测试的对照组**依赖
    //   一条马上要删掉的路。今天要让假站点有插件，走的是**站点分发**那条真路
    //   （假站点从仓库的 `plugins/` 读真文件、客户端真的下载→校验→同意→换入）。
    //   ★ 它零个用例踩过（用例只查"按钮 → 处理器"这一个方向，而它没有按钮）。
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
   * 为什么需要它：假后端会起一个真的在监听的 HTTP 服务，测试进程如果关不掉它
   * 就不会退出（`node --test` 会一直等下去）。生产代码不依赖这里任何东西 ——
   * 生产路径靠 `handleWindowClose` / `before-quit` 里的 `backend.close()`。
   *
   * ★ **判据：这里只留今天真有用例踩着的入口。** 一个接缝成员被零个用例用到，
   *   就是"意图写了、测试没写"—— 它让下一个人以为某条用例正踩着这里，而实际上
   *   没有人守着它。v0.7 因此删掉了四个（`getCfgDir`、`getSitePlugins`、
   *   `awaitSiteSync`、`getSiteStagingDir`）：最后一个尤其像那么回事，而
   *   `awaitSiteSync` 的注释还写着"测试必须等它"—— 事实上没有一条用例等过它，
   *   因为 `app:syncPlugins` 那个 IPC 处理器自己就是 await 到对账跑完才返回的。
   *   （那条注释描述的需要**曾经**是真的，只是处理器改成 await 之后就没了。）
   */
  _test: {
    getBackend: () => backend,
    /**
     * 活着的会话：**槽 → 记录**。
     *
     * ★ 从前这里叫 `getController`，回那唯一一个。多开之后"那一个"没有定义了 ——
     *   而用例需要的是"现在有哪几条、各自什么状态"，那正是这一份。
     */
    getSessions: () => sessions,
    /** 某一槽的记录（`getSessions().get(slot)` 的糖，用例里读起来短一点）。 */
    sessionAt: (slot) => sessions.get(slot),
    getWindow: () => win,
    /** 一条连接的密钥（读不到就返回错误对象）。测试用它核对「按连接隔离」。 */
    getKey: (id) => resolveKey(id || config.PENDING_ID),
    getCfg: () => cfg,
    /**
     * 插件数据目录的根。端到端用例靠它断言"插件写出来的那三个文件落在哪儿、而真正的
     * 家目录一个字节都没被碰过"。★ 它与 `ctx.dataDir()` 同源（都走 `pluginDataRoot`）
     *   —— 各算一遍的话，用例就会守着一个用户永远拿不到的路径。
     */
    getPluginDataRoot: () => pluginDataRoot(),
    /** 钉子表（按 id 记的公钥指纹，§5.4）。它在**另一个文件**里，不是 cfg 的一部分。 */
    getPinnedKeys: () => pins,
    /**
     * 重跑「启动时接上已有会话」那条路（`tryReattach`）。
     *
     * 它只在启动时被调用一次，所以不重新触发就没法验证。先把表清掉是
     * **还原现场**而不是绕过什么 —— 启动那一刻它本来就是空的。
     *
     * ★ 但光把引用清掉还不够：真机上重启时**这个进程整个没了**，它的监听套接字、
     *   轮询、心跳跟着一起消失；只在同一个进程里换个引用的话，模拟出来的现场是
     *   **两个客户端同时在跑** —— 旧的那个还占着端口在监听、还在轮询状态，收尾时
     *   进程退不掉（症状是整个测试文件凭空多花几十秒，而每条用例自己都是绿的）。
     *   所以旧的先 `abandon()` —— 只释放本地资源，一个字都不发给服务端。
     *
     * ★ **临时实例那张表也要清**，理由与 `sessions` 逐字相同：真机上重启之后
     *   它一定是空的（它只活在内存里）。不清的后果不是"用例红"那么轻 ——
     *   一个**上一个进程的**临时实例会跟着新认领的那些一起数，于是"重启后各拿一个
     *   实例"这条用例会以为认领多造了一个，而真实的路径上根本没有这一格。
     *   ★ 清的时候**不回收**（不调 `releaseEphemeral`）：真机上进程没了，那两份
     *   数据就留在盘上等着对账去认 —— 那正是"崩溃残留"该有的样子，别在夹具里
     *   把它抹平。
     */
    reattach: async () => {
      const old = [...sessions.values()];
      sessions = new Map();
      tempLayouts = new Map();
      for (const rec of old) if (rec.controller) await rec.controller.abandon();
      return tryReattach();
    },
    /** 插件注册表。测试用它验证「未知插件不崩」「重新扫描模拟装/卸插件」。 */
    getRegistry: () => registry,
    /** 界面会看到的插件视图（四个条件求交的结果，见 pluginsView）。 */
    getPluginsView: () => pluginsView(),
    /** 上一次对账的结果（三态的原样）。 */
    getSiteSync: () => siteSync,
    /** 待同意的那些。 */
    getPendingConsent: () => pendingConsent,
    /** 站点池在哪（测试要直接看盘上的东西）。 */
    getSitePoolDir: () => sitePoolDir(),
    /**
     * **临时实例**那张注册表（`id → {id, name, port}`，只活在内存里）。
     *
     * ★ 用例要断言的是"它**没了**"（会话结束之后回收干净），而那件事没有别的
     *   观测面：那个组不在配置里（所以 `getCfg()` 看不见），它那条会话的记录也已经
     *   被收掉了。盘上那两半各有一条用例（目录在不在），但"注册表里那一格清了"
     *   是第三件事 —— 少了它，一条"回收时只删了磁盘、没删注册表"的实现会全绿。
     */
    getTempLayouts: () => tempLayouts,
  },
};
