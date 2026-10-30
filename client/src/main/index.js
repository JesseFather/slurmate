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
 * index.js —— 主进程入口。
 *
 * 职责：单实例锁、生命周期、后端选择、密钥与连接的管理、把 SessionController 和
 * ShellWindow 接起来、以及 web-demo 的自动登录（POST /login + 查 cookie jar）。
 *
 * ── 身份体系：这里不认识任何 IDM ─────────────────────────────────────────────
 *
 * 客户端不知道 FreeIPA / LDAP / Kerberos 的存在，也不该知道 —— 别的集群未必用
 * 这一套。它只知道「用户名 + 主机 + 端口 + 一把私钥」。首次使用时生成密钥、
 * 把公钥显示出来让用户自己去注册；改密码、设邮箱那些事归 IDM 自己的网页管，
 * 客户端从「账户已经配好了」开始。
 *
 * ── 密钥的纪律 ────────────────────────────────────────────────────────────
 *
 * 每条连接一把，私钥由客户端生成并自托管。存法只有加密一种。
 *
 * 1. 有安全存储就直接加密存盘，不打扰用户。
 * 2. 没有安全存储就留在内存里，由界面如实说明 —— 绝不静默写明文。
 * 3. 读不出来的密钥绝不自动覆盖。文件在但解不开（换机器、keyring 被重置）时，
 *    生成新密钥会让用户已经注册进 IDM 的那把静默失效，而症状只是「认证失败」。
 *    这种情况必须报错，让用户自己决定。
 * 4. 「没有」和「读不出来」必须分开。前者生成一把是安全的（没有东西可毁），
 *    后者生成一把就是在毁东西。`ensureKey` 只在 `not_saved` 时才生成。
 *
 * 「新建连接」这条路上还有一条特殊约定：密钥在用户点保存之前就生成好了
 * （存在 PENDING_ID 这个保留位上），因为用户必须先把公钥拿去 IDM 注册、
 * 回来再填地址。否则「保存并连接」的第一次尝试必然认证失败。
 *
 * ── 测试后端 ──────────────────────────────────────────────────────────────
 *
 * 测试进程用 `SLURMATE_TEST_BACKEND=1` 启动时，客户端不连集群，改用
 *   `backend-fake.js` 那个本地假站点。它只服务客户端自己的测试：打包版里
 *   `app.isPackaged` 为真，这个开关无论怎么设都不生效，假站点那几个模块也不在
 *   安装包里。
 *
 * 它不给用户用，界面上没有入口，也没有"这次读哪一份配置"的分叉：测试用临时
 *   `userData`，与用户自己那份目录不相干。
 *
 * 没有真后端时静默退到假站点仍然是错的：用户会以为连上了集群，其实在跟一个
 *   本地假服务打交道（见 backend.js 的 createBackend）。
 */

const { app, BrowserWindow, ipcMain, session: electronSession, safeStorage, shell, clipboard,
        dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./config.js');
const pluginData = require('./plugin-data.js');
const dataAudit = require('./plugin-data-audit.js');
const keys = require('./keys.js');
const hosts = require('./hosts.js');
// `KIND` 也引进来：主进程里有好几处要问"这是不是那个假后端"。写字面量
//   `'fake'` 的话，将来改这个名字会漏掉一处，而漏掉的那一处不会有任何提示。
const { createBackend, KIND } = require('./backend.js');
const { SessionController, State, SERVER_LIVE_STATES, HEARTBEAT_MS } = require('./session.js');
const { probeLocalPort } = require('./tunnel.js');
const { gresLabel, gresText } = require('./gres.js');
const { jobText } = require('./jobstate.js');
const { sessionStateText } = require('./sessionstate.js');
const { ShellWindow } = require('./windows.js');
const { installMenu, attachKeyGuard } = require('./shortcuts.js');
const weblogin = require('./weblogin.js');
const plugins = require('./plugins/index.js');
const sitePluginSync = require('./site-plugins.js');
// 从模块上摘下来，而不是在函数里写 `plugins.shortDigest` —— `pluginsView()` 里
//   有一个同名的局部数组（那些插件记录），函数内写 `plugins.` 会指到它身上。
const shortDigest = plugins.shortDigest;

/**
 * 这次进程是不是在跑测试后端。
 *
 * 判据两条同时成立：环境变量是测试设的，而且这不是打包版。第二条是承重的 ——
 *   安装包里没有假站点那几个模块，任何环境变量都不该把客户端带到那条路上。
 * 值在 `bootstrap` 里定，之后不再变（换后端要重建整个客户端）。
 */
let testBackend = false;

let win = null;
let backend = null;
/**
 * 这台电脑的客户端身份 `{id, name}`。
 *
 * `id` 是稳定的（落在数据目录的 `client-id.json` 里），`name` 只用于显示
 *   （主机名）。服务端拿 `id` 排席位 —— 所以它不能每次启动重新生成：
 *   那会让这台电脑每次都算"一台新电脑"，把另一台正在用的顶掉，而用户什么都没做。
 *
 * `cfgDir` 一拿到就赋值（见 bootstrap 与 `userDataDir`）。
 */
let clientIdentity = null;
/**
 * 活着的会话：槽 → 记录（槽见 `plugin-data.js` 的 `slotOf`）。
 *
 * 每个槽一份记录，而不是当前那一个会话那份单值 —— 单值能成立，靠的是
 *   "同一时刻只有一个会话"这条假设，而假设不是判据 ——
 *   它的失败形态是：起中转站时把 web-demo 那块界面收掉、关窗只掐断两条会话里
 *   的一条、插件拿错别人的会话口令。
 *
 * 键是槽而不是 sessionId：会话在提交回来之前还没有 id，而"这个槽被占了"
 *   从用户按下「开始」那一刻起就必须成立。
 *
 * 记录里留着 `plugin`，纪律是起它那一刻捕获：之后所有状态变化都用它、
 *   不再查注册表（站点会升级，而一个跑着的会话用的是它提交时那一份代码）。
 */
let sessions = new Map();
// 正在准备中的槽。插件 prepare 改成异步之后，认领与写表之间会经过一次等待，
// 而槽的可见性不能再靠「这一段没有 await」来保证（见 docs/CONTRACT.md §3.1.1）。
const startingSlots = new Map();
/**
 * 「只保活、不接管」的那些会话：`session_id` 的集合。
 *
 * 连上站点时（`tryReattach`）看护者不是本机的那几条不接回来 —— 不建隧道、
 *   不建页面、不上标签。但作业不能因为没人续命而被回收，所以这里替它发心跳。
 *   看护者为空时这一拍刷新 `last_hb_socket`；看护者是别人时服务端回 `ignored`，
 *   照收不误 —— 等那台电脑一走、看护者变空，下一拍自动接上，
 *   不必重新连接。
 *
 * 它与 `sessions` 是两回事：集合里的会话没有 controller、没有本地记录。
 *   用户点「接管」之后才从集合里删掉，再走 `reattachOne` 建出记录。
 *
 * 空手超时（`EMPTY_HANDS_MS`）到点时这个集合连同定时器一起清掉 ——
 *   否则一个客户端可以一直开着，永远替一条没人看的作业续命。
 */
let keepAliveSids = new Set();
let keepAliveTimer = null;
/**
 * 临时的那些数据：`id → {id, pluginId, group, ports}`，形状与 `config.normalizeSpace`
 * 的产物逐字同形（于是凡是拿一份数据去用的地方，拿到临时的也不需要分支）。
 *
 * 只在内存里，一个字都不落盘。它不是"一份还没保存的数据"，而是故意不存在于
 *   配置里的一种数据：配置里的数据有引用计数、会被 `pruneSpaces` 回收、会被对账
 *   当成"该有的" —— 而临时那一份的全部意义就是"它属于这一次会话，会话结束就没了"。
 *   落盘会让它在下次启动时变成一份真的数据（没有任何工作区指着它，当场被回收，
 *   但那之前 `workspacePlan` 会把它报给界面，用户看到一堆自己没建过的东西）。
 *
 * 谁能进来只有一个来源：`claimSpace` 造它。它今天只服务一件事 ——
 *   一个声明了 `concurrent: true` 的插件要开第二份时，给第二份一个自己的
 *   数据（= 一个自己的端口 = 一个自己的 origin = 一份空的浏览器存储）。
 *
 * "这条会话是不是临时的"这个问题只问这一个 Map（见 `sessionViews`）——
 *   绝不在会话记录上再存一个布尔：两份状态会漂，而漂的后果是漏回收（留一份
 *   永远没人清的目录）或者误回收（把持久那份的数据删掉）。
 */
let tempSpaces = new Map();
let cfgDir = null;
let cfg = null;
/**
 * 钉子表：`id → 公钥指纹`（§5.4）。单独一个文件，见 config.js 那一段。
 *
 * 它不是 `cfg` 的一部分，所以这里单独持有一份。`pinPluginKey` 就地改这个
 *   对象并且落盘 —— 也就是注册表那边（`allows`）看到的永远是当下的那一份。
 *
 * 模块加载期是 `{}`（空表）：那时 `cfgDir` 还没定下来。空表 = "从没钉过"，
 *   而在能拿到真表之前一个插件都加载不了，两者同归一处。
 */
let pins = {};
/**
 * 上一次运行登记下来的、还没删掉的目录（`[{place, name, label}]`）。
 *
 * 单独一个文件，与钉子同一个形状（见 `config.js` 那一段）。这里持有一份，
 *   与 `pins` 同一条理由：`cfgDir` 在模块加载期还没定下来，那时它是空的。
 * 空表与"没有东西待删"同归一处 —— 两者要做的事都是"什么都不做"。
 */
let pendingRemovals = [];
let whoami = null;
/**
 * 后端正连着的那条连接的 id（没连着时 `null`）。
 *
 * 它与 `cfg.activeConnectionId` 是两个问题，别合并：那个字段答的是"下一次
 *   要用哪一条"（界面在连之前就把它改掉了 —— `doConnectTo` 正是先
 *   `setActiveConnection` 再 `connect`），而这个答的是"现在在哪一条上"。
 *   换站点时要收的是后者的尾巴：上一个站点那些会话记录带着它的 `session_id`。
 * 拿 `cfg.activeConnectionId` 去判"换没换"会在界面那条路上永远判不出来
 *     （那一刻它已经等于目标了）。
 *
 * 与 `whoami` 同生共死：`doConnect` 成功那一刻写，`teardownConnection` 清。
 */
let connectedConnId = null;
/**
 * 有一条连接正在连（`app:connect` 那一段）。
 *
 * 同一时刻只允许一条：两次连接同时在飞的时候，后一条会换掉活跃连接、动本机的
 *   会话记录，而前一条返回时又把界面按它自己的结果画一遍 —— 用户 2026-10-19
 *   真机：第一条停在排队上，这时点第二条居然进去了，退出之后又连回第一条。
 * 界面那一侧也会灰掉其余入口（见 panel.js 的 `connectTo`），这一格是权威。
 */
let connectInFlight = false;
let partitions = [];
/**
 * 这台机器的 `userData`（app ready 之前就读到的那一份）。
 *
 * 只取一次，之后所有地方都用它 —— 算 `cfgDir`、放待删清单、读客户端身份。
 * 取两次的漂法是静默的：两份字符串理论上可以是两个目录，于是一处读、另一处写。
 */
let userDataDir = null;

/**
 * 站点现状（`op_cluster` 那一份）与链路现状。两者一起喂给边栏浮窗与左栏那个圆点。
 *
 * 取数点只有这一处。浮窗不自己拉（见 hover.js 的文件头），面板也不拉：
 *    `op_cluster` 是"现在这台集群怎么样"，而它每一格都有自己的钟（服务端 2s / 30s /
 *    300s 三层）。两个取数点必然漂成两句话，而两句都标着"现在"。
 *
 * `data` 与 `error` 分开存，不合成一个。`data: null` 有两种意思 ——
 *   "还没问到"与"问失败了" —— 而它们在界面上是不同的话（"读取中…" vs "获取失败"）。
 */
let site = { data: null, error: null, at: 0 };
let siteTimer = null;
let siteFetching = false;

/**
 * 链路现状。它不是"上一次点连接成没成"，而是此刻这条链路活没活。
 *
 * 这一格原先根本不存在：后端的 `on('state')` 一直在发，而全仓库没有一个
 *    订阅者。于是 SSH 掉线在界面上是一个静默事件 —— 界面照旧显示"已连接"，
 *    直到某一次操作失败（而那时用户已经在怀疑别的东西了）。
 */
let link = { connected: false, detail: null };

/**
 * 「站点上已经没有 Slurmate」这一类收尾，每条连接只做一次。
 *
 * 后端只广播一次 `definitive`，但收尾是异步的（忘会话、关页面）；这面旗子
 * 防的是收尾途中再来一条状态事件又走一遍。`doConnect` 时复位。
 */
let definitiveHandled = false;

/**
 * 多久问一次站点现状。
 *
 * 间隔跟着通道走，这不是优化，是"不在别人的登录节点上每 30 秒 fork 一次"：
 *   · 常驻通道在（`backend.resident === true`）—— 一次 RPC 是往已有 duplex 上写一行，
 *     30 秒一次基本免费；
 *   · 退化成了 exec —— 一次 RPC = 一个 SSH channel = sshd fork + PAM + bash +
 *     python3 冷启动。那是 `status` 轮询从 30s 被提到 60s 的同一个理由
 *     （见 session.js 的 `STATUS_MS` 注释），这里取 120s。
 * `null`（这个后端没说）按最保守的那一档 —— 见 backend.js 的 `resident`。
 */
const SITE_POLL_MS = 30000;
const SITE_POLL_EXEC_MS = 120000;

function sitePollMs() {
  return backend && backend.resident === true ? SITE_POLL_MS : SITE_POLL_EXEC_MS;
}

/**
 * 站点上的插件清单变了没有；变了就补一次对账。
 *
 * 什么时候问（用户 2026-10-27 定的）：连接时取一次、点「重新同步」取一次、
 *   点「开始会话」时顺手再问一次。不做定时轮询 —— 那一趟问的只是"变了没有"，
 *   而大部分时候的答案是"没变"；退化成 exec 时一次 RPC 就是一个 fork，
 *   为了一个不常发生的变化在别人的登录节点上多跑一趟不划算。
 *
 * 为什么要有这一趟：插件清单从前只在连接时取一次。于是一个已经连着的客户端
 *   在站点升级插件之后完全不知道 —— 要断开重连才看得见新版，旧版什么时候消失
 *   也跟着拖到那一刻。
 *
 * 问不到就当没变：不触发对账，也不把界面手里那份擦掉（"没问到"不等于"没有"，
 *   与三态那一条同源）。
 *
 * 这一趟只认"当前这条连接的那个站点"。别的连接条目的 `wants` 一个字都不动 ——
 *   对账写的是 `sites[本站点键].wants`，而"要不要删某一版"看的是所有站点加起来
 *   的引用（见 site-plugins.js 第 5 步）：另一个站点那边没有升级，它要的那一版
 *   就还在。
 */
async function checkSitePlugins() {
  if (!backend || !backend.connected || !sitePlugins) return false;
  const p = await loadPlugins();
  if (!p.ok) return false;
  const before = pluginKeySet(sitePlugins.plugins);
  const after = pluginKeySet(p.plugins);
  if (before.size === after.size && [...after].every((k) => before.has(k))) return false;
  reconcileSitePlugins();
  return true;
}

/** 一份 `op_plugins` 清单里"站点此刻要分发的那些版本"的集合。 */
function pluginKeySet(list) {
  return new Set((list || [])
    .filter((x) => x && x.enabled !== false && x.id && x.version)
    .map((x) => `${x.id}@${x.version}`));
}
/**
 * 本站点的插件清单，来自 `op_plugins`。`null` = 还没问到（或守护进程太旧，
 * 不支持这个 op）—— 那时按"站点没说"处理，而不是当成"一个都没有"。
 *
 * 界面上的按钮由四个条件的求交决定：客户端扫到的插件 ∩ 站点装着且开着 ∩
 *   用户在本机没关掉 ∩ 站点为它装了作业侧。所以见 pluginsView() —— 那里把条件
 *   分别报给界面、由界面决定怎么画，而不是在这里合并成一个布尔。
 *
 *   四个条件来自三方（客户端 / 站点 / 用户），其中站点占了两个 —— 而那两个
 *   要做的事不一样（一个是管理员的开关，一个是部署有没有跟上），所以界面上
 *   也必须是两句不同的话。
 */
let sitePlugins = null;
let quitting = false;

/**
 * 上一次站点对账的结果。`null` = 还没同步过。
 *
 * 它是三态的载体，别把它压成一个布尔：`supported: false` 与
 *   `supported: true && failed.length` 是两件完全不同的事（一个是"这个站点的
 *   守护进程太旧"，一个是"它答应发但这次没发成"），而"本机没有这个插件"在界面上
 *   长得都一样。压成一个布尔之后，后两种会被合并成一句笼统的"同步失败"。
 */
let siteSync = null;
/**
 * 连接期那次版本判定的结论（`applyVersionGate` 填，见那里）。
 *
 * 它是一个连接级的事实，不是每一轮同步的事实 —— 所以不塞进 `siteSync`
 *   （那是"这一轮同步看到了什么"），而是与它并列地进视图。
 * 断开时清掉：它说的是"这一条连接对面是谁"，连着的那条没了它就不再成立。
 */
let versionVerdict = null;

/**
 * 握手时报上来的守护进程版本（`applyVersionGate` 填）。
 *
 * 给「检查集群」那一颗用：站点那一侧装的到底是哪一版，是排查"新包装上了没有"
 *   的第一个问题，而体检的其余几格都答不了它。老守护进程不在 `doctor` 的
 *   回包里报 `version`，那一格就由这里补上（握手时问到的版本仍然是真的）。
 */
let connectedDaemonVersion = null;

/**
 * 握手时对面声明支撑的几样东西（`ping` 应答里的 `caps`，`applyVersionGate` 填）。
 *
 * 它是"对面支持什么"的唯一来源。`null` 是缺席：老守护进程不报 `caps`，
 *   那时按基线处理 —— 缺席不是"全都支持"，也不是"全都不支持"。
 * 与 `connectedDaemonVersion` 一样是连接级事实，断开时清掉。
 */
let connectedDaemonCaps = null;

/**
 * 待同意的那些（暂存树还在磁盘上，等用户点）。
 *
 * 换连接、断开、重新对账都会把它清掉 —— 它描述的是这一次连接的现场。
 */
let pendingConsent = [];

/**
 * 连接世代号。世代守卫：用户在下载途中切连接/断开，下载回调仍在跑，
 * 最后 `reload()` 一次 —— A 站点的插件会被当成 B 站点的写进台账。每次对账
 * 带一个世代号，回调里比对，不匹配整个丢弃。
 */
let connectGeneration = 0;

/**
 * 这一次运行里，对账收掉了哪些没人管的数据（`reclaimOrphans` 维护的那一格）。
 *
 * 它是一格模块状态而不是回包里现算的一个值，有两个理由：
 *   · 两个处理器都要给出它 —— `app:pluginData` 是产生它的那一次，而
 *     `app:deletePluginData` 要用它重画同一块（回包形状必须逐字相同，见那两处
 *     的注释与 `boot.test.mjs` 里那条按 `panel.js` 现读字段的用例）；
 *   · 它是累计的（`count` / `items` 只增不减）。只报"最近一次"的话，
 *     用户手动删掉一份、界面重画一次，那一行就凭空消失了 —— 而它说的是
 *     "这一次运行发生过什么"，与用户刚做的动作无关。
 *
 * `failed` 是例外，它只报最近一次：那些东西现在还在盘上，是一件当前状态
 *   而不是一件发生过的事（累计的话同一份会每轮重复出现一次）。这条不对称是故意的。
 *
 * 它不落盘：客户端没有日志文件，"留痕"的落点就是面板上那一行。跨重启的那
 *   部分由守护进程那边的日志去管，客户端这一侧不做第二份状态。
 */
let lastReclaim = { count: 0, items: [], failed: [] };

/**
 * 这台机器没有凭据库时，密钥只能留在内存里 —— 按 id 记着。
 *
 * 少了它，没有凭据库的机器（测试桩里 safeStorage 一律不可用）上每连一次就会换
 * 一把钥匙，而用户明明刚从界面上把上一把复制去注册过。症状仍然只是「认证失败」。
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
  // `bootstrap` 现在是异步的（注册表要等插件宿主握手）。它失败时说一句，
  //   而不是留一个没人接的 rejection。
  bootstrap().catch((e) => {
    if (win) win.pushNotice('error', `启动时出错：${e.message}`);
  });
}

async function bootstrap() {
  userDataDir = app.getPath('userData');

  // 测试后端只在源码树里、只由测试进程打开。打包版里 `app.isPackaged` 为真，
  //   这个开关无论怎么设都不生效；而安装包里本来也没有假站点那几个模块。
  testBackend = !app.isPackaged && process.env.SLURMATE_TEST_BACKEND === '1';

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    installMenu();

    cfgDir = userDataDir;
    cfg = config.loadConfig(cfgDir);
    // 钉子在另一个文件里（见 config.js 那一段）：`loadConfig` 只认已知键，
    //   读一遍 `config.json` 再存一遍就会把不认识的那张表抹掉，而"钉子全没了"
    //   = §2.5 的分身判据有了一个重置按钮。所以它自己一个文件、自己一次读。
    pins = config.loadPinnedKeys(cfgDir);
    pendingRemovals = config.loadPendingRemovals(cfgDir);

    // 池目录依赖 cfgDir，而注册表是在模块加载期建的，那时 cfgDir 还是 null。
    //   所以拿到真路径之后重新扫一遍。
    ensureSitePoolDir();
    await registry.reload();

    // 上一次没删掉的那些目录，趁现在删 —— 这一句的位置就是它的全部理由，
    //   必须在任何一块界面被建出来之前。见 `sweepPendingRemovals`。
    sweepPendingRemovals();

    // 身份在建后端之前取好：它要作为构造参数交给后端（见 backend.js 的
    //   接口注释 —— 身份是"这台电脑"的属性，不是"这次连接"的，而一个后端会被
    //   重连很多次）。
    clientIdentity = {
      id: config.loadClientId(cfgDir),
      // 主机名是给人看的（界面上"正在被 X 看"那一句）。获取失败不是错误 ——
      // 那么多半是容器/异常环境，回一句"另一台电脑"仍然说得清。
      name: os.hostname() || '另一台电脑',
    };

    backend = createBackend({
      test: testBackend,
      ssh: { client: clientIdentity },
      fake: {
        client: clientIdentity,
        // 只影响假站点「登记」要等多久，好让测试能看到排队态，或者反过来跳过它。
        //   真实后端完全不读这个。
        enrollDelayMs: Number.isFinite(Number(process.env.SLURMATE_TEST_ENROLL_MS))
          ? Number(process.env.SLURMATE_TEST_ENROLL_MS) : undefined,
        // 假站点上那两个目录，两个角色是分开的（见下面那一段的注释）：
        //   `samplePluginsDir` 是测试夹具住的地方（从源码跑时才有），
        //   `siteInstalledDir` 是装上去的东西落的地方（测试用的 userData 里）。
        //   都是一份真实文件（真的 sha256、真的字节），于是「站点有而本机没有」这条
        //   最重要的路径真的走得到：池空的时候站点照样报那些插件，对账真的把它们
        //   取下来、真的要求同意。
        //
        // 传函数而不是路径：夹具那棵树只在源码树里有，而"这个目录现在在哪／在不在"
        //   必须是每次现算的结果。
        samplePluginsDir,
        siteInstalledDir,
        // 假站点真的把插件的作业侧跑起来（见 backend-fake.js 的 `_startJob`），
        //   而作业要有地方待：它会写出会话文件与两条作业日志，还会有一个家目录
        //   （插件的 `start_*` 会往里写东西）。三样都落在 cfgDir 下 —— 测试用的是
        //   临时 userData，不碰用户自己的目录。
        jobsDir: siteJobsDir,
      },
    });

    win = new ShellWindow({
      onClose: handleWindowClose,
      onAction: handleWindowAction,
    });

    /**
     * 链路状态：后端一直在发，从前没有一个收件人。
     *
     * 订阅点是这里（`main()` 里，两个后端唯一的交汇处）—— 假后端也走同一条，
     *   否则"开发模式能跑、真集群跑不了"又会在这个接缝上重演一次。
     *
     * 它做三件事，每一件都对应一个"不说就没人知道"的事实：
     *   · 推给面板（浮窗里那一行"已连接 / 已断开"）
     *   · 重算左栏那个圆点（链路断了它就是红的，不管集群那一份有多旧）
     *   · 链路回来时立刻问一次站点现状 —— 掉线期间那份是旧的，而用户此刻正
     *     盯着圆点看
     */
    backend.on('state', (s) => {
      const was = link.connected;
      link = {
        connected: Boolean(s && s.connected),
        detail: (s && s.detail) || null,
      };
      if (win) {
        win.pushConn(link);
        pushSiteDot();
        if (win.hoverOpenSide() === 'left') pushSiteToHover('left');
      }
      // 刚连上（或刚重连上）的那一刻补一次：`startSitePoll` 那个定时器要等到
      // 下一拍，而圆点在那之前是灰的。
      if (!was && link.connected) refreshSite();
      // 站点上没有本系统的命令：这条路不会自己好，收尾一次。
      if (s && s.definitive && !definitiveHandled) {
        definitiveHandled = true;
        handleSiteGone(link.detail || '站点上已经没有 Slurmate。')
          .catch((e) => {
            win.pushNotice('error', '断开时出错：'
              + (e && e.message ? e.message : String(e)));
          });
      }
    });

    // 本机池那个目录不再被读了，说一句。它是用户自己装插件的地方。
    //   目录不删 —— 升级上来的人那里可能真的躺着东西（那是他们自己的文件，
    //   删它是另一回事）。
    //   只在真的有东西时说：空目录、或者从来没用过本机池的人，不该看见一条
    //     关于它的话 —— 那是噪音，而且会让人以为自己做错了什么。
    warnLegacyPool();

    // 快捷键拦截：黑名单 + 诊断。
    //
    // 诊断只报"被我们吞掉的键"（F12 那类）。那是在解释「为什么按了没反应」——
    //   是用户自己触发的、想问的问题。
    // 放行的键不上报。从前测试后端下连"这个键直达了页面"也写一行日志，用来核对
    //   拦截器到底有没有挡住不该挡的键 —— 那件事已经核完了，而它今天的代价很具体：
    //   每按一次带修饰键的键、每按一次 F 键都往日志里写一行，把真正要紧的消息顶掉
    //   （用户 2026-10-16 报的就是这个）。
    attachKeyGuard(win.win.webContents, {
      // 「重新加载」这个键打的是前台那一块 —— 屏幕只有一块，而用户按
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
    });

    registerIpc();

    // 测试后端那条连接。播在这里，不是 `loadConfig` 里：配置模块不该知道测试
    //   夹具的存在。放在这个位置有两个理由：`win` 已经在了，而第一屏还没拿到数据
    //   （`app:bootstrap` 由渲染进程发，它在窗口加载完之后）。
    if (testBackend) ensureTestConnection();

    // 开局那一屏：零条会话（`_sessions` 空，关窗不会问，正是要的）。
    win.setSessions([]);
    win.pushSessions([], null);
    await announceBackend();

    // 接回上次会话这一步跟着用户点的那一次连接走（见 doConnect）。启动这
    //   一路上一步网络动作都没有，这是「不自动连」的全部内容。
  });

  app.on('before-quit', async (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    win.setBusy(false);
    // 走唯一那份实现（见 `stopAllSessions`）。各写一遍的话，只停一个而
    //   剩下的会话会在控制节点上停在一个"客户端已经退出、而它还以为有人连着"的
    //   状态，要等 1800 秒的孤儿判定才被 scancel。
    if (sessions.size) {
      try {
        for (const { sessionId, res } of await stopAllSessions()) {
          if (!res.ok && sessionId) {
            // 落盘待补发。下次启动时补发 —— 这就是「跨崩溃的可靠投递」。
            // 注意：绝不用 process.on('exit') 做这件事，那里只能跑同步代码，发不出网络请求。
            config.addPendingGoodbye(cfgDir, sessionId);
          }
        }
      } catch (err) {
        // 退出这条路绝不能因为收尾失败就走不掉：用户按的是关闭，不是"重试释放"。
        win.pushNotice('error', '结束会话时出错：' + err.message);
      }
    }
    // 插件宿主一律收掉：没有会话时也要收，否则那几个进程会留到主进程退出。
    await registry.closeAll();
    app.exit(0);
  });
}

// ── 密钥 ────────────────────────────────────────────────────────────────────

/** 「读不出来」的四种原因，各自该怎么跟用户说 —— 它们修法完全不同。 */
function keyErrorDetail(reason) {
  const tail = '重新生成会作废已经注册到 IDM 的那把公钥，请确认后再来。';
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
 * 解析一条连接（或「新建」位）的密钥。只读，不生成。
 *
 * 返回值的 error 字段把四种情况分开了，调用方必须区别对待：
 *     not_saved         → 确实还没有。生成一把是安全的（没有东西可毁）。
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

  // 明文存的密钥不再读（理由见 config.js 里 SECRET_ENCRYPTED 那段）：
  // 它与别的认不出的 mode 走同一条路，报 bad_mode。

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
  // 缓存里抹掉 generated：那个标志的含义是「刚刚生成了一把，用户还没注册过」，
  // 只对产生它的那一次调用成立。留着它，同一条警告会在每次连接时重放一遍 ——
  // 而第二次起它已经不再是真的了。
  if (!saved.ok) memKeys.set(id, { ...info, generated: false });
  return info;
}

/**
 * 取密钥，没有才生成。
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

/** 界面要的那几个字段。不生成 —— 只有「新建」与「重新生成」两个入口才生成。 */
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

/** 作废一条密钥、换一把新的。必须由用户显式发起（界面上带确认的按钮）。 */
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
/**
 * 启动时只告知，不连接。
 *
 * 打开客户端不自动连上任何东西。若把"打开客户端"与"连上某个站点"合成同
 *   一个动作，用户就没有机会先看一眼自己配了哪几个站点、哪一台是上次用的，也没法
 *   在连错的那一台上一键退回来。
 *
 * 而「这台电脑在看哪个作业」是服务端记得住、用户点得动的一格（看护者）。
 *   接管必须是用户的一个动作 —— 打开客户端就自动连上、自动接管一次，正是要
 *   拆掉的那个形状。
 *
 * 测试后端走的是同一条路：假站点在连接列表里是一条普通连接，由测试播种，
 *   连接同样发生在 `doConnect()` 里。启动这一路上没有一次 `backend.connect()`。
 */
async function announceBackend() {
  const conn = config.activeConnection(cfg);
  if (!conn) {
    // 一条连接都没配 —— 这是真实状态，不是错误。如实说出来，
    // 而不是显示一句笼统的「连接失败」让用户去猜。
    win.pushNotice('info', '还没有配置登录节点。点「新建连接」填一个，'
      + '只要用户名、主机和端口。');
    win.setTitle('Slurmate — 未配置连接');
    return;
  }
  win.setTitle('Slurmate — 未连接');
}

/**
 * 版本闸 —— 唯一一处执行「服务端要求客户端不低于它自己」的地方。
 *
 * 它住在这里（而不是两个后端各自的 `connect` 里），因为这里（index.js）是
 *   假站点与真实后端唯一的交汇点。同一条规则写在两处，下一次就会漂成
 *   "测试里说得通、真机上不生效"，而假站点的全部价值就是它演的是同一件事。
 *
 * 判定在 `plugins/index.js` 的 `versionCheck` 里 —— 规则只有那一份书面形式，
 *   判据是 `tools/version-fixtures.json` 的 `check` 段。
 *
 * 它发生在任何会话之前，这一点是"拦住"能成立的全部理由：连接没成就从来
 *   没有 `submit` 没有 `session_id` 没有心跳，于是也不会经由 `orphan_after`
 *   把用户正在跑的作业 scancel 掉。判定只在连接时做一次，绝不在会话进行中
 *   重新判定（守护进程被就地升级会断开连接，走重连，那时再判，那才是对的
 *   时机；在心跳那条路上判会把用户的作业判没）。
 *
 * 只有 `client_behind` 拦人，而 0.x 内测期那一格连它也不拦（见
 *   `versionCheck` 里那条例外）—— 那时它必须出一次声：文档写的是"只说明、
 *   不拦"，少了"说明"就变成两头都不做，用户拿旧客户端连新站点什么都看不到。
 * 另外四种态各自大声说明，但都放行 —— 它们要么是"缺席"（没问到 / 读不到
 *   自己），要么是两个大版本之间不保证、也不断言不兼容。把它们也拦掉，就等于
 *   把"我们不知道"说成"不行"。
 */
async function applyVersionGate(res) {
  const mine = plugins.hostVersion();
  const g = plugins.versionCheck(mine, res.daemonVersion);
  const theirs = JSON.stringify(res.daemonVersion);
  // 记下来给界面用（`site_too_new` 那一句要拿它说准，见 panel.js）。
  versionVerdict = g.verdict;
  connectedDaemonVersion = typeof res.daemonVersion === 'string'
    ? res.daemonVersion : null;
  connectedDaemonCaps = Array.isArray(res.daemonCaps)
    ? res.daemonCaps.filter((c) => typeof c === 'string') : null;

  if (g.blocked) {
    // 先把连接关掉：绝不留一条"连上了、但不许用"的连接在那儿占着守护进程的
    // 配额与端口池。close() 会把重连也停掉（它置 _closed），所以不会变成
    // 每隔几秒敲一次守护进程的循环。
    await backend.close();
    return {
      ok: false,
      code: 'client_behind',
      error: `集群上的服务端是 ${res.daemonVersion}，而这个客户端是 ${mine}。`
        + '同一个大版本内，服务端要求客户端不低于它自己（两端是一起升的，'
        + '而这个客户端不保证读得懂更新的一版）。请升级客户端之后重连。',
    };
  }

  if (g.verdict === 'cross_major') {
    win.pushNotice('warn',
      `这个集群的服务端是 ${res.daemonVersion}，本客户端是 ${mine}。两端的大版本不同。`
      + (g.order < 0
        ? '服务端更新，本客户端不一定兼容它。'
        : '这个集群是更老的一代；本客户端不一定兼容它。')
      + '（大版本不同不等于不兼容，所以这一次照常连。多个集群之间大版本不同是正常的。）');
  } else if (g.verdict === 'unknown_server') {
    win.pushNotice('info',
      `没有问到站点的基座版本（对面的守护进程没有 \`ping\` 这个 op，也就是比本客户端旧），`
      + '所以这一次没有做版本判定。判定也不会因此变松：一个连 `ping` 都没有的'
      + '守护进程不可能比本客户端新。');
  } else if (g.verdict === 'not_our_daemon') {
    win.pushNotice('warn',
      `站点答的版本号 ${theirs} 不合 x.y 的形状，这条链路上答话的恐怕不是 `
      + 'Slurmate 的守护进程。这一次没有做版本判定：那不是"通过了"，是"没判"。');
  } else if (g.verdict === 'unknown_host') {
    win.pushNotice('warn',
      '本客户端读取自己的版本号失败（client/package.json），所以这一次没有做版本判定。'
      + '插件仍然可以同步，但一个都无法安装：装之前要拿本客户端的版本去比'
      + '插件声明的引擎范围，而那个版本现在读取失败。');
  } else if (g.verdict === 'client_behind') {
    // 走得到这里只有一个原因：大版本是 0（内测期），那条要求降级成了说明。
    //   1.0 之后这一支永远到不了 —— 那时 `blocked` 为真，上面就返回了。
    win.pushNotice('warn',
      `这个集群的服务端是 ${res.daemonVersion}，本客户端是 ${mine}。`
      + '0.x 是内测期：客户端落后只提示、不拦。客户端落后时不保证读得懂'
      + '较新的一版，请升级客户端。');
  }
  return res;
}

/** 真正发起一次连接（含主机密钥裁决）。 */
async function doConnect(conn, extra = {}) {
  // 先把世代号推一格：上一次连接的插件对账可能还在后台取文件，而它带回来的
  //   东西属于上一个站点。见 reconcileSitePlugins 的世代守卫。
  connectGeneration += 1;
  definitiveHandled = false;
  pendingConsent = [];
  // 这条连接自己的那把私钥。没有就生成一把 —— 但读不出来时绝不生成
  // （见 ensureKey）：那会作废用户已经注册到 IDM 的公钥，而症状只是「认证失败」。
  //
  // 测试后端那条连接不要密钥：假站点不做认证（`backend-fake.js` 的 `connect`
  //   连 `privateKey` 都不读）。为一条永远不会认证的连接造一把私钥，等于在密钥表
  //   里留一份永远没人用的凭据，而测试还会多看到一句"请把公钥注册到 IDM"——
  //   那是在让人去注册一把没有任何用处的公钥。
  const key = (testBackend && conn.id === TEST_CONNECTION_ID) ? { ok: true } : ensureKey(conn.id);
  if (!key.ok) {
    return { ok: false, code: 'key_unavailable', error: key.detail || key.error };
  }
  if (key.generated) {
    // 走到这儿说明配置里这条连接本来没有密钥（手改过配置，或从更旧的版本升上来）。
    // 新公钥用户还没注册过，所以这一次连接注定会认证失败 —— 与其让他自己
    // 从报错里猜，不如现在就说清楚。
    //
    // 只在「刚生成」这一次说：见 generateKey 里为什么缓存要抹掉这个标志。
    win.pushNotice('warn',
      `这条连接此前没有密钥，已生成一把新的（指纹 ${key.fingerprint}）。`
      + (key.persisted
        ? ''
        : '这台机器没有可用的系统凭据库，私钥存不下来，关闭客户端后它会消失。')
      + '请先在「编辑」里复制它的公钥、注册到 IDM 账户，否则连不上。');
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
    // 版本闸在最前面：不通过就到这里为止，一次会话都不建。
    const gated = await applyVersionGate(res);
    if (!gated.ok) {
      win.pushNotice('error', gated.error);
      win.setTitle('Slurmate — 未连接');
      return gated;
    }
    whoami = res.whoami;
    connectedConnId = conn.id;      // 见它的声明处：换站点时要收的就是这一条的尾巴
    // 建作业日志目录那一次在后端里已经【发起】了（`backend-ssh.js` 的
    //   `_openOnce`，热身，不等它），这里一个字都不收、也不报。该说话的地方是
    //   提交那一步（`session.js`），因为那一步才是"目录必须在"的那一步；
    //   在连接这一刻报，症状是用户看到一条"失败"，而目录其实是有的 ——
    //   真机 2026-10-16 就是这样：客户端报超时，而目录真的建出来了。
    // 站点现状从"连上"这一刻开始问。它不 await：那是一个每 30 秒重来一次
    // 的轮询，而连接这条路上等着的是一个用户。第一次问的结果到了就推给界面。
    startSitePoll();
    await refreshPartitions();
    // 站点分发：连上之后才开始，不 await（理由见 reconcileSitePlugins）。
    reconcileSitePlugins();
    win.setTitle(`Slurmate — ${conn.user}@${conn.host}`);
    // 「接上上次的会话」这一步的触发点是"用户显式点了这条连接"。
    //
    //   启动不连站点，接回就必然挂在这一次连接上：用户点「连接」＝"我要用
    //   这个站点"，而"这个站点上还有我的作业在跑"是紧接着必须发生的事（不接回 =
    //   没有心跳 = 1800 秒后作业被 scancel）。
    //
    //   它不 await。连接成没成与那几条会话接没接回来是两件事，而用户点完
    //     「连接」要的是"进去"（用户 2026-10-19：停在主页上，上栏却已经有标签）。
    //     接回一条会话要建隧道、登录取 cookie，是秒级的事，几条就是几倍；
    //     把它排在连接前面，连接这条路上就一直在等一件用户没在等的事。
    //     界面这就切到插件页，会话一条一条接回来时自己出现在上栏。
    //
    //   `tryReattach` 自己会推通知说"正在逐个接上"；接回来的那些可能正是另一台
    //     电脑在看的（用户 2026-10-18 的第三种重登录），所以这里只把面板抬起来，
    //     不把用户推进任何一条会话的页面。
    win.showPanel();
    // 空手计时从"连上"这一刻起算。`tryReattach` 接回本机看护的会话时，
    //   `onSessionChange` 会把表撤掉；接不回来的那些不计控制权。
    if (hasControl()) disarmEmptyHands(); else armEmptyHands();
    tryReattach().catch((e) => {
      // 接回失败不能把这次连接说成失败：连接本身是好的，只是上次那几条
      // 会话没接回来（它们仍然在集群上跑，下一次连接会再试一遍）。
      win.pushNotice('error', '接上已有的会话时出错：' + ((e && e.message) || e));
    });
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
 * 取分区列表与默认资源。不碰全局状态、不弹通知 —— 纯查询，好测。
 *
 * 分区直接来自 Slurm（并与该用户的 association 求交）—— 协议里没有「用途」
 * 这一层。
 *
 * 失败必须说出来。写成 `resp.ok && resp.data.partitions || []` 的话，守护
 *   进程不可达或权限不足时会静默得到空数组，界面于是显示「这台集群没有任何分区」，
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
  return { ok: true, partitions: withGresLabels((resp.data && resp.data.partitions) || []), error: null };
}

/**
 * 给每个分区的 GRES 清单补一个 `label`（`gpu` / `gpu:a100`）。
 *
 * 补在这里而不是面板里：面板是普通 `<script>`，用不了模块；而"名字怎么拼"
 *   在客户端只该有一处（`gres.js`）。
 * `gres` 这个键可能整个不存在 —— 服务端查不到集群的 GRES 时它是缺席的
 *   （协议的三态：缺席 ≠ 空数组）。那就原样留着缺席：`[]` 的意思是"这个
 *   分区确实一张卡都没有"，界面要说的话完全不同，不能在这里把它抹平。
 */
function withGresLabels(list) {
  return list.map((p) => {
    if (!Array.isArray(p.gres)) return p;
    return { ...p, gres: p.gres.map((e) => ({ ...e, label: gresLabel(e) })) };
  });
}

/**
 * 同上，但用在 `op_cluster` 那一份上（它是 `{分区: [描述项]}`，不是一张分区表）。
 *
 * 原地改，而且缺席就什么都不做：`gres` 这个键不存在 = 获取失败，而我们的
 *   判据是 `undefined` / `null` —— 补一个 `{}` 进去会把它变成"确实一个都没有"，
 *   那正是三态里最不该犯的那一次混淆。
 */
function withGresCatalogLabels(cat) {
  if (!cat || typeof cat !== 'object') return;
  for (const [name, entries] of Object.entries(cat)) {
    if (!Array.isArray(entries)) continue;
    cat[name] = entries.map((e) => ({ ...e, label: gresLabel(e) }));
  }
}

/**
 * 取本站点的插件清单（`op_plugins`）。
 *
 * 它失败不是错误，所以这里不推通知：守护进程比客户端旧时根本没有这个 op，
 *   会回 `unknown_op`。那时按"站点没说"处理 —— 界面回落到"只画客户端自己认识、
 *   且用户没关掉的那些"。为一件"你的服务端版本旧"弹一条 error，是把升级的节奏
 *   问题说成故障。
 *
 * `problems` 必须一路带出去（账本 F22）：它是"本站还有几个包没能加载、
 *   为什么"，与 `plugins`（能用的那些）是两件事。守护进程那一侧加了它、
 *   也写清了"加了这个字段就必须有人读它"—— 在这里丢掉的话，界面看到的仍然
 *   只是「本站没有这个插件」，而真相是「本站有两个、因为撞名/撞 id 没被加载」，
 *   运维的排查方向从第一步就是错的。算出来了没送出去 = F35 那个形状。
 *
 *   缺失（老守护进程不报这个键）按空处理，不按"未知"：客户端对"本站的包
 *   有没有装坏"这件事没有别的来源，画一句"本站可能有插件没加载"是凭空
 *   造一个怀疑；而真有问题时新守护进程会报出来。
 *
 * @returns {Promise<{ok:boolean, plugins:Array|null, problems:Array|null, error:string|null}>}
 */
async function loadPlugins() {
  let resp;
  try {
    resp = await backend.rpc({ op: 'plugins' });
  } catch (e) {
    return { ok: false, plugins: null, problems: null, error: e.message };
  }
  if (!resp || !resp.ok) {
    const detail = (resp && resp.error && resp.error.detail) || '控制节点没有说明原因';
    return { ok: false, plugins: null, problems: null, error: detail };
  }
  const d = resp.data || {};
  return {
    ok: true,
    plugins: d.plugins || [],
    problems: Array.isArray(d.problems) ? d.problems : [],
    error: null,
  };
}

/**
 * 刷新全局的分区列表与插件清单。
 *
 * 分区失败要说出来（`resp.ok && resp.data.partitions || []` 会把失败静默
 *   成一个空列表，界面显示「这台集群没有任何分区」—— 一句系统并不知道的话）。
 *   插件失败则不必，理由见 loadPlugins()。
 */
async function refreshPartitions() {
  const r = await loadPartitions();
  partitions = r.partitions;
  if (!r.ok && win) win.pushNotice('error', r.error);

  const p = await loadPlugins();
  // null（问到但站点没返回清单 / 问不到）与 []（站点真的一个插件都没有）不同，
  // 但对界面是同一件事：没有站点信息可用。留 null 让调用方能分辨。
  //
  // `problems` 与 `plugins` 一起收着走：它是同一个应答里的两半（能用的
  //   与没能加载的），分两处存会让它们来自两个时刻 —— 而 `pluginsView()` 一次
  //   要把两半都画出来。
  sitePlugins = p.ok ? { plugins: p.plugins || [], problems: p.problems || [] } : null;
  return r;
}

// ── 站点分发 ────────────────────────────────────────────────────────────────

/** 上一次对账的 promise。只给测试用（真机上没人等它）。 */
let siteSyncPromise = null;
/** 有一轮对账在飞。同一时刻只跑一轮 —— 理由见 `reconcileSitePlugins`。 */
let siteSyncRunning = false;
/** 在飞那一轮结束之后还要再跑一轮（会话刚结束这一类"错过了一拍"的请求）。 */
let siteSyncAgain = false;

/**
 * 和站点对一次账：把该分发的插件取下来、该回收的回收。
 *
 * 不挂在 `refreshPartitions()` 旁边。那是热路径（`doConnect` / `app:connect` /
 *   `app:partitions` 都调它），界面每刷一次分区就会跑一遍全目录哈希。这里只在
 *   每次连接一次。
 *
 * 不 await：真集群上每一份文件都是一次独立的 `ssh` exec，十几份就是几秒 ——
 *   让"连接"这个动作卡在插件下载上，是把一个后台的事变成前台的事。跑完推一份
 *   新的视图给界面（见 `pushPlugins`）。
 *
 * 下载失败绝不回退到本机池（见 site-plugins.js 的文件头）。没有站点的时候
 *   一个插件都没有，那是正确的、必须如实说出来的结果。
 *
 * 同一时刻只跑一轮。它开头会 `++connectGeneration`，而那一个世代号正是在飞
 *   那一轮"这次还算不算数"的守卫 —— 第二轮一进来，第一轮就会把自己当成
 *   "连接换了一条"整份丢弃。所以后来的请求只记一个待办，由在飞那一轮结束时
 *   再排一次（见 `.finally`）。
 */
function reconcileSitePlugins() {
  if (siteSyncRunning) {
    siteSyncAgain = true;
    return siteSyncPromise;
  }
  siteSyncRunning = true;
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
        // 全部连接的站点键，不是只有当前这一条：池是公共的，另一条连接要的
        //   版本也得留着。对账据此把记录里那些"连接已经没了"的站点条目删掉 ——
        //   站点键含 `user@host:port`，所以改一次主机名就是另一个键，而旧条目留着
        //   会让它那些版本永远不会被回收（见 site-plugins.js 第 5 步）。
        keepSites: (cfg.connections || []).map((c) => sitePluginSync.siteKeyOf(c)),
        trusted: (id, version, digest) => config.isTrusted(cfg, id, version, digest),
        // §5.3：本机那一份不在了，台账那条一并消失，同一个对账里它走进待同意。
        // 删就删在信任判定的前面，所以"静默装回来"这条路结构上不存在。
        forgetTrust: (id, version) => config.forgetPlugin(cfgDir, cfg, id, version),
        // §5.4：本机钉住的那把公钥。`undefined` = 从没钉过（首次即信任）。
        pinnedKey: (id) => config.pinnedKeyOf(pins, id),
        generation: gen,
        stale: () => gen !== connectGeneration,
        // 「文件都下来了」不等于「装上了」：`reload()` 从不抛，坏插件进
        //   `errors`。所以换入之后逐个复查 —— 拿得到才算成功。
        verify: async (landed) => {
          if (gen !== connectGeneration) return [];
          await registry.reload();
          const failed = [];
          for (const e of landed) {
            const p = registry.get(e.id, e.version);
            if (!p) {
              failed.push({ ...e, why: '文件都下来了，但注册表没有收下它：'
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

    // 世代守卫：连接已经换了一条，这一次的结果整个丢弃（界面上的东西也会被
    //   下一次对账覆盖），一个通知都不推。
    if (gen !== connectGeneration) return null;

    pendingConsent = r.pendingConsent || [];
    // 界面手里那份「本站有哪些插件」也换成这一轮取回来的那一份。
    //   它从前只在连接时取（`refreshPartitions`），于是装完一个插件、点「重新同步」
    //   之后界面还是旧的，要断开重连才更新 —— 而"同步"这个词承诺的正是立刻对齐。
    //   `null` = 这一轮没问到，那就留着上一次的：一次问不到不该把界面擦成空的。
    if (r.plugins) sitePlugins = { plugins: r.plugins, problems: r.problems || [] };
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
      snapshotOk: Boolean(r.snapshot && r.snapshot.ok),
      snapshotWhy: (r.snapshot && r.snapshot.why) || null,
      // 池里"不是槽位"的那几项的名字。只报不删（§5.1：手工放置必须不产生
      //   任何效果，而删掉它是一种效果）—— 报出来只是为了让"池里到底有什么"这个
      //   问题有一个诚实的答案，不然它们会静静地躺在那儿、谁也不知道。
      poolStrays: r.poolStrays || [],
      notices: r.notices || [],
    };

    if (r.error) win && win.pushNotice('warn', r.error);
    for (const n of (r.notices || [])) win && win.pushNotice('warn', n);
    for (const f of (r.failed || [])) {
      win && win.pushNotice('error', `未能装上「${f.title || f.name || f.id}」：${f.why}`);
    }
    if (r.reclaimed && r.reclaimed.length) {
      win && win.pushNotice('info',
        `站点不再需要的 ${r.reclaimed.length} 个插件版本已经清掉了。`);
    }
    if (pendingConsent.length) {
      win && win.pushNotice('warn',
        `本站要给你 ${pendingConsent.length} 个插件，每一个都要你先确认同意`
        + '（它们的客户端代码会在你这台机器上运行）。见插件那一栏。');
    }
    win && win.pushPlugins(pluginsView());
    return siteSync;
  })().catch((e) => {
    // 兜底：对账自己出错不该把任何东西带崩，也不该变成一个没人处理的 rejection。
    siteSync = { supported: false, reason: 'internal', syncedAt: Date.now(),
                 error: `站点插件对账时出错：${e.message}` };
    return siteSync;
  }).finally(() => {
    siteSyncRunning = false;
    // 在飞期间有人要再对一次（多半是又一条会话结束了）：那一轮已经看不到
    //   这一条的状态，所以补一轮。
    if (siteSyncAgain) {
      siteSyncAgain = false;
      scheduleSiteReclaim();
    }
  });
  return siteSyncPromise;
}

/** 池里这个 id 有几版。读不到目录 = 0（"没有"与"读不动"在这一格等价：都不会回收）。 */
function pooledVersionCount(id) {
  const root = sitePoolDir();
  if (!root || !id) return 0;
  try {
    return sitePluginSync.listPooled(root).filter((x) => x.id === id).length;
  } catch {
    return 0;
  }
}

let siteReclaimTimer = null;

/**
 * 会话结束之后补一次对账 —— 让"没人再引用它"的那一版当场被回收。
 *
 * 回收只认引用（站点快照表里的 `wants` 与 `op:list` 报的活会话），而
 *   "一条会话走完了"这件事从前不触发对账：于是会话手里那一版在新版装上来之后
 *   一直躺在池里，界面上两颗同名的块并排，要等下一次连上站点才收掉
 *   （用户 2026-10-27：升级插件之后旧版本必须断开重连才消失）。
 *
 * 隔一小会儿再跑，不立刻跑：一次「结束会话」可能连着结束几条（关窗、断开），
 *   而它们该合成一轮对账。代价只是旧版本晚一秒消失。
 */
function scheduleSiteReclaim() {
  if (siteReclaimTimer) return;
  siteReclaimTimer = setTimeout(() => {
    siteReclaimTimer = null;
    if (quitting || !backend || !backend.connected) return;
    reconcileSitePlugins();
  }, 800);
  if (siteReclaimTimer.unref) siteReclaimTimer.unref();
}

/**
 * 调试开关要作用在哪一个插件上：调用方给短名，不给就取列表里第一个。
 * 基座里没有插件名可写，所以"是哪一个"只可能由调用方说。
 *
 * 名字只说"挑一个插件"，不要带"池"：那会让人以为它跟"插件从哪来"有关，
 *   而"哪来的"今天不是一条轴。
 *
 * 一个都没装时如实返回一条 error，而不是静默地什么也没发生 —— 后者会让调试的人
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
      : '本机一个插件都没有，先装一个，这个开关才有对象。',
  };
}

/**
 * 递给界面的插件视图。界面不做任何推导 —— 它手里那份随时可能已经陈旧，
 * 而"哪些按钮该出现"是四个条件的求交（见 pluginsView）—— 它们来自三方，其中
 * 站点占两个。
 *
 * `defaults` 是管理员设定的策略，不是用户偏好。界面只读地显示它，提交时
 *   靠【省略】cpus/mem 字段让服务端填当下那份默认值 —— 不是把这两个数字发回去。
 *   两者不等价：管理员把默认从 2 核改成 4 核之后，回发旧值的客户端会把它永远
 *   钉死在 2 核，而"省略"永远拿到当下的默认。只有用户当场点开「高级选项」，
 *   才发明确值。
 */
function pluginsView() {
  // 收表的键是 `id`，不是短名。短名不再是唯一的（两个不同的插件可以
  //   同名，站点里用 id 各配一块），按短名收会让后一条静默盖掉
  //   前一条 —— 于是界面上少一个插件、而少掉的那个恰好是"站点开着、本机也装着"
  //   的那一个时，用户面对的是"按钮凭空没了一个"，没有任何一句话解释它去哪了。
  //   `missing` 那一列也从这张表来，所以它同样会少报一个。
  //
  //   按 id 收之后，池里同一个 id 的多个版本仍然都拿到同一个站点条目 ——
  //   这正是 `siteVersion` 那一格要的（站点报的是那个 id 的版本）。
  const site = new Map(((sitePlugins && sitePlugins.plugins) || [])
    .filter((x) => x && typeof x.id === 'string')
    .map((x) => [x.id, x]));
  const siteKnown = Boolean(sitePlugins && Array.isArray(sitePlugins.plugins));

  // 一张表，每条带两个开关，界面自己决定怎么画。
  //
  //   不在这里替界面过滤掉任何一条："看不见"与"看得见但灰着"告诉用户的事
  //   完全不同 —— 站点没开 → 去找管理员；本机关了 → 自己打开就行；客户端
  //   不认得 → 该升级。三种都过滤掉，用户面对的就是"按钮凭空少了一个"。
  // 不带钩子的那些不进这一列（`active === false`）：它们是"代码还没过同意闸"
  //   的站点插件，界面上由待同意那一块专门画（见 panel.js 的 renderConsent）。
  //   两处都画的话，用户会看到同一个插件两个块，而其中一块说不出自己为什么灰着 ——
  //   `WHY_NOT_RUNNABLE` 那四句话说的是"起不来"，而"还没同意"是"还没到手"，
  //   硬塞进去就把两件事糊在一起了（`test/renderer.test.mjs` 正钉着那四句话）。
  const records = registry.list();
  const plugins = records.filter((p) => p.active !== false).map((plugin) => {
    // 按 id 取站点那一份 —— 短名会撞（见上面收表那段），而"站点报的这条
    // 说的是池里哪一个"只能由身份回答。
    const s = site.get(plugin.id) || null;
    // 本机开关按 id 记 —— 理由见 app:setPluginEnabled。
    const locallyEnabled = config.pluginEnabledLocally(cfg, plugin.id);
    // 站点清单拿不到时（守护进程太旧，没有这个 op）按"站点没说"算 true。
    // 算 false 的话，升级客户端会让老服务端的用户一个按钮都看不到。
    const siteEnabled = siteKnown ? Boolean(s && s.enabled) : true;
    // 站点侧「现在提交得出去吗」—— 开了 且 有作业侧实现。守护进程把这两件事
    // 合成一个字段发下来（它是唯一同时知道两者的那一方），客户端不自己拿
    // `enabled` 推 —— 要推的话还得知道"这个插件有没有 job/start.sh"，而客户端
    // 根本看不见那件事（它不读池里那一半）。
    //
    // 同一条三态纪律，同一个理由：缺席 ≠ 否。老守护进程不报这个字段
    //   （`undefined !== false`），按"站点没说"算可以提交。反过来算的话，升级
    //   客户端会让所有老服务端的插件按钮在某一刻同时变灰。
    const canSubmit = siteKnown ? Boolean(!s || s.can_submit !== false) : true;
    return {
      // 身份：`id` 是铸造出来的全球唯一标识，`version` 是这一版的号。界面把两者
      // 都显示出来 —— 池里可以并存同一个插件的多个版本，只显示名字的话用户分不清
      // 自己看到的是哪一版。
      id: plugin.id,
      version: plugin.version,
      // 站点内用的短名。那份插件配置的文件名、提交时的 service_kind 都是它。
      name: plugin.name,
      // 客户端认得的插件用它自己的标题：那个才对应它实际会做的事。
      title: plugin.displayName,
      description: plugin.description,
      hasClientCode: plugin.hasClientCode,
      surface: plugin.contributes.surface,
      // 这一份数据要几个端口（`contributes.ports`，已在校验时落成具体的数）。
      //   界面拿它决定画不画「这个插件用哪一份数据」那一格：0 个端口的插件
      //   根本没有那一份数据，画一个空下拉等于凭空许诺一个不存在的东西。
      ports: plugin.contributes.ports,
      // 共享组由 `plugin-data.js` 现算，界面不自己推：它是身份的中间那一段，
      //   而界面拿它做的事只有一件 —— 把"这个插件现在读得到的那几份数据"筛出来。
      //   筛错了比不筛更坏：列一份指过去也读不通的数据，用户点下去只会得到一句报错。
      //   不要数据空间的那些（`ports: 0`）给 `null`，不给一个 `'default'`：
      //     它们根本没有那一份数据，"这个插件的共享组是 default"是一句不成立的话。
      group: pluginData.needsSpace(plugin) ? pluginData.groupOf(plugin) : null,
      // 站点那边报的是哪一版。这是"站点升级了而本机还是旧的"的唯一线索 ——
      // 两半代码是配套的，对不上时必须让用户看得见。
      siteVersion: (s && s.version) || null,
      siteEnabled,
      siteKnown,
      locallyEnabled,
      // 站点装了它、也开着，但没有作业侧实现，提交必被拒（守护进程回
      // code 4 / service_kind_no_job）。界面据此把按钮置灰并给出那一句话 ——
      // 目标是不让用户在提交失败时才第一次知道。
      canSubmit,
      // 默认资源是管理员设定的策略，不是用户偏好。界面只读地显示它，提交时靠
      // 【省略】cpus/mem 让服务端填当下那份默认值 —— 不是把这两个数字发回去。
      // 回发旧值的客户端会把管理员的改动永远钉死。拿不到就是 null，不编一个。
      defaults: (s && s.defaults) || null,
      // 站点给这个插件设的并发上限（协议里的 `max_sessions`）。与 `defaults`
      //   同一类：管理员设的政策，不是用户偏好，界面只读地显示。
      // 它已经是一个数：守护进程把"插件那一份没写就跟随主配置"解析掉了，
      //   客户端不自己算 —— 主配置那个值不在任何应答里，这里拿不到用来推的东西。
      // 缺席（老守护进程报不出这一格）就是 null。不许补一个 1：那会是一句编出来的
      //   政策，而用户会拿它当本站的规定。
      maxSessions: (s && typeof s.max_sessions === 'number') ? s.max_sessions : null,
      // GRES 那一格要过客户端唯一的那处拼法（`gres.js` 的 `gresText`）——
      //   与 `session.js` 给会话快照加 `gresText` 走同一条路（见 `renderKv` 那句
      //   注释）。少了这一步，界面要么自己拼一个 `name:type × n`（那是第二个拼法），
      //   要么显示一个裸对象。
      //   `null` = 没配 / 没要（确定的事实），`undefined` 那一格不来 = 老守护
      //     进程（它没有 `defaults.gpus`）—— 两种都不说 GRES，理由与 cpus/mem 同。
      defaultsGresText: gresText(s && s.defaults && s.defaults.gpus),
      // 这个插件有没有本机入口（客户端钩子 `startLocal`）。它只在站点报
      //   `can_submit: false` 时才有意义：有作业侧的插件仍走作业。
      hasLocalEntry: Boolean(plugin.hasLocalEntry),
      // 能不能真的起一个会话。三个条件都成立；本机插件不要求 `canSubmit`
      //   —— 它本来就没有作业可提交。三个条件各有各的主语（站点 / 用户 /
      //   站点的部署状态），所以界面上那几句解释也必须是几句不同的话。
      runnable: siteEnabled && locallyEnabled
        && (canSubmit || plugin.hasLocalEntry),
    };
  });

  // 站点报了、而本客户端池里没有对应那一版的。按 `(id, 版本)` 算，不是按名字
  // —— 名字对得上而版本对不上，同样是"你用不了它"，而按名字判会把它当成有。
  //
  // 只看 `enabled` 的那些。 `op_plugins` 按协议必须报全部插件、包括
  //   `enabled:false` 的；不过滤的话，"站点关掉一个插件"会被界面说成"站点有而
  //   本机没有，升级客户端"，永远挂着。管理员关掉它是它不该出现，
  //   不是客户端缺了东西。
  const missing = [...site.values()]
    .filter((p) => p.enabled !== false)
    .filter((p) => !(p.id && p.version && registry.get(p.id, p.version)))
    .map((p) => ({
      name: p.name, title: p.title, id: p.id || null, version: p.version || null,
      enabled: true,
      // 站点愿不愿意发这一份，与"本机有没有"是两件事，而它们的出路不同：
      //   愿意发，等对账/点同意；不愿意发，这一版你只能自己想办法（升级客户端，
      //   或者问管理员为什么这个站点不分发它）。
      //
      // ❗ 判据必须问 `deliveryOf`，不能在这里现写一个。「能不能分发」这个问题
      //   只有一处答案，而它在那里。
      //   带出来的是四态里的哪一态，不是一个布尔：三条"获取失败"的出路不同
      //   （不分发 / 此刻发不出来 / 读不懂），合成一个布尔就等于把出路指错了。
      delivery: sitePluginSync.deliveryOf(p, sitePluginSync.HARD_LIMITS).state,
    }));

  // ── 池里那些没被加载的（`active: false`）───────────────────────────────
  //
  // 这一列不是美化项：少了它，"池里有一份、台账对不上"的站点插件两条路都不
  //   在，后果是一个真的洞 ——
  //
  //     `plugins` 那一列把 `active === false` 的滤掉了；`missing` 又要求
  //     `registry.get` 那儿没有它 —— 而它恰恰在注册表里（`active: false` 的那
  //     一条）。于是界面上彻底看不见，连"点同意"的入口都没有，重新同步也救不回来。
  //
  //   摘要换一次公式，这条路会一次性对每个用户的每个插件成立 ——
  //     集体消失、无从恢复。
  //
  // 待同意的那些不在这里：它们由 `consent` 那一块专门画（那里有"同意"
  //   按钮）。两处都画的话，用户会看到同一个插件两个块，而各自说着一半的话。
  const pendingKeys = new Set(pendingConsent.map((p) => `${p.id}@${p.version}`));
  const inert = records
    .filter((p) => p.active === false && !pendingKeys.has(`${p.id}@${p.version}`))
    .map((p) => ({
      id: p.id, version: p.version, name: p.name, title: p.displayName,
      // 为什么它没被加载。今天只有一种：代码还没过同意闸，而站点此刻没有在
      // 报它（所以没有"同意"这个入口）。写成字段而不是让界面去猜 —— 界面手里
      // 那份视图随时可能陈旧。
      why: 'unconsented',
    }));

  return {
    plugins,
    // 这是升级提示的唯一来源 —— 过滤掉它们，用户就永远不知道自己少了什么。
    missing,
    // 池里同 `(id, 版本)` 撞了（两个不同的东西在抢同一个身份）而被全部跳过的，
    // 以及插件目录里扫到的坏文件。它们被跳过了，客户端照常工作 —— 但必须说出来，
    // 否则用户面对的症状只是"加了插件它就是不生效"。
    //
    // 与下面那个 `problems` 必须分开，它们是两侧的同一类事：
    //   这一列是本机池里的（客户端自己扫出来的），`problems` 是站点报的
    //   （守护进程加载不了的包）。合成一列的话，"是本站装坏了还是我这儿坏了"
    //   就没有答案 —— 而两者的出路完全不同（找管理员 vs 重新同步）。
    errors: registry.errors,
    // ── 站点级的插件问题（账本 F22）────────────────────────────────
    //
    // 那些没能加载的站点侧包（同 id 两个包、不是一个包、清单读不出来……）
    // 与原因。`plugins` 那一列里每一条都是能用的，这里说的是"另外还有些
    // 用不了的、以及为什么"。
    //
    // 守护进程早就把它算出来并放进应答了，而这条路必须是通的：
    //   `loadPlugins()` 少取一个字段，运维在客户端上看到的就只是「本站没有这个
    //   插件」—— 排查方向从第一步就是错的。
    //
    // 界面必须画它（见 panel.js 的 renderPlugins）：加了这个字段而没有人
    //   读，就是又一个 F35（算出来了、没送出去）。所以这条链的每一节都有一条
    //   打在线上的用例，而不只是打在函数返回值上。
    problems: (sitePlugins && sitePlugins.problems) || [],
    // 池在哪 —— 站点分发那一栏用它判断"要不要画那一块"（见 panel.js 的
    // renderSitePlugins）。它在这里而不是在 `site` 里面：站点连不上时那一栏
    // 照样得画，因为池里可能已经有东西了。
    //
    // 这里给的是"池在哪"，不是"我该往哪放"。后者没有答案，也不该有 ——
    //   插件只有一条来的路（站点分发），用户没有任何需要往目录里放东西的场合
    //   （§5.1）。
    sitePoolDir: sitePoolDir(),
    // 这一条是承重的：本机一个插件都没装时，站点上每一个插件都会落进
    //   `missing`，于是界面会把它们全都说成「本站有而本机没有 —— 升级客户端」。
    //   而真相是「你还没装插件」—— 那两件事的行动完全不同（去拿 vs 去升级）。
    //   界面靠 `installedCount === 0` 分岔，见 panel.js 的 renderPlugins。
    //   只数能用的那些。把待同意的也算进去的话，「一个插件都没装」的空态
    //   再也走不到 —— 而那个空态正是用户第一次打开客户端时要看的那块地方。
    installedCount: plugins.length,
    // 这里给的是下面那个 `inert` 列表，不是一个计数：界面要画的是"是哪一个、
    //   为什么"，而一个数说不出这两件事。
    // 而这一列是那些没能走进"待同意"的：站点此刻不报它们，所以连点同意的
    //   入口都没有。界面必须把它们画出来并给一个出口（删掉本机那一份）。
    inert,

    // ── 站点分发那一节 ──
    //
    // 两条「你没有这个插件」的理由必须分开报，因为它们要做的事不同：
    //     站点守护进程太旧   → 找管理员升级站点
    //     站点支持但没下来    → 看下面 `failed` 里那一句（可能是网络、可能是配置）
    //   合并成一句"同步失败"的话，用户就只能一个个试。
    //
    // 只有上面两条：池里有什么就加载什么，没有"关着不加载"这一态。
    site: siteSync ? {
      supported: siteSync.supported,
      reason: siteSync.reason || null,
      error: siteSync.error || null,
      label: siteSync.label || null,
      syncedAt: siteSync.syncedAt || null,
      // 连接期那次版本判定（见 applyVersionGate）。界面用它把 `site_too_new`
      // 那一句说准 —— 那是唯一一处界面的说法取决于握手结论的地方，理由见
      // panel.js 里那一段：握过手就说明服务端不新，于是"站点太新"只能是别的原因。
      daemonVersionVerdict: versionVerdict,
      // 对面声明支持什么。界面据此决定用不用新行为（例如分区下拉里那个
      //   "不点名"选项指的是 Slurm 还是守护进程）。缺席时按基线处理。
      daemonCaps: connectedDaemonCaps,
      failed: siteSync.failed || [],
      // 视图这一份不带回回收的数 —— 回收的后果用户看得到的是下面
      //   `versions` 那一栏（哪几个版本还在、还被谁要），一个数说不出这些。
      // §5.3：本机那一份不在了，同意作废。只报数，文案在界面里 ——
      // 而那条文案绝不断言是谁删的（客户端不知道原因）。
      withdrawn: (siteSync.withdrawn || []).length,
      snapshotOk: siteSync.snapshotOk !== false,
      // 池里每个版本被哪些站点要 —— 这是那一栏唯一值得显示的东西，它解释了
      // "为什么这台机器上有两个版本"。读自快照表（`.sites.json`）。
      versions: siteVersions(),
      // 池里不是槽位的那几项 —— 只报不删，见 site-plugins.js 的 sweepPool。
      strays: siteSync.poolStrays || [],
    } : null,
    // 待同意的：不下发暂存路径 —— 那是主进程的现场，界面不需要知道它在哪。
    consent: pendingConsent.map((p) => ({
      id: p.id, version: p.version, name: p.name, title: p.title,
      // `digest` 是给人一眼分得开的短形；`fullDigest` 是不截断的 64 位，
      // 界面把它整串画出来（见 panel.js 那一处）—— 它是用户与站点 `--check-plugins`
      // 报的那一串逐个字符核对的凭据，也是同意闸唯一能给的证据。
      digest: shortDigest(p.digest), fullDigest: p.digest,
      // 这个摘要是哪一个公式算出来的。界面拿它比对上一次那条的 `alg` ——
      //   不同就说明"我们换了一把尺子"，那是另一件事，不能说成"内容变了"。
      digestAlg: config.TRUST_ALG,
      // 本机已经有一份（只是台账对不上），还是刚取回来的一份草稿：
      //   前者点同意是"原地认领"、点不同意是"删掉池里那一份"；后者是"换入"与
      //   "丢掉草稿"。两件事，文案与后果都不同，所以界面必须分得开。
      existing: Boolean(p.existing),
      // §5.4：这一份是谁签的。`null` = 没有签名 —— 那句话必须说清"没有签名"，
      // 而不是留白（留白会被读成"还没显示出来"）。
      fingerprint: p.fingerprint || null,
      siteLabel: p.siteLabel, fileCount: (p.files || []).length,
      // 同 (id, 版本) 以前同意过吗？—— 有的话这一次内容变了，界面上要说出来。
      previous: (() => {
        const e = cfg && cfg.trustedPlugins && cfg.trustedPlugins[config.trustKey(p.id, p.version)];
        return e ? { digest: shortDigest(e.digest), at: e.at, alg: config.trustAlgOf(e) } : null;
      })(),
    })),
  };
}

/**
 * 池里每个已提交的槽位（`<id>_<版本>`）被哪些站点要 —— 读自快照表。
 *
 * 这一列只有"被哪些站点要"，没有"旁边那个 `.splug` 在不在"—— 容器不落盘之后
 *   没有那个文件，而"有树没有记录表"也不是一个状态（见 site-plugins.js 的文件头）。
 *
 * 快照表读不出来就返回空数组，并且不编。它只有显示用途（"为什么这台机器上
 *   有两个版本"），而回收那条路自己会去判"读不出来就不回收"。
 */
function siteVersions() {
  const root = sitePoolDir();
  if (!root) return [];
  const rr = sitePluginSync.readSnapshot(sitePluginSync.snapshotPathOf(root));
  if (!rr.ok) return [];
  const wanters = new Map();
  for (const [key, s] of Object.entries(rr.snapshot.sites || {})) {
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

// 登录机制（`webLogin`）在 `weblogin.js` 里 —— 它是通用的，契约由插件自己的
// 清单提供。基座这一层不知道任何一个具体网页服务的端点或字段名。

// ── 工作区与数据空间 ────────────────────────────────────────────────────────
//
// 工作区 = 一张引用表（哪条连接算同一个，由用户说了算）；数据空间 = 一份存储 +
// 它自己的端口（一份 = 一个插件在某一个工作区里的那一份数据）。
// 模型与纯函数在 config.js 的那两节；这里只做编排：谁指向谁、什么时候回收、回收时清理什么。

/**
 * 这次会话该用哪个工作区。
 *
 * 有连接就用它的工作区（正常路径）。没有连接时（测试后端里的那种现场）也必须
 * 能开会话 —— 所以退回到「已有的第一个工作区，没有就建一个」。
 * 这样造出来的工作区没有任何连接指着它，能活过下一次 commitConfig 靠的是
 *   `liveWorkspaceIds`（那条活会话）—— 不是"一条连接都没有就不回收"那条例外，
 *   它已经整条删掉了。少了 `liveWorkspaceIds` 那一层，每次改动都会换一张引用表。
 *
 * 收的是那条连接，不是"当前活跃的那条" —— 多开之后两者会分家。调用方读一次、
 *   让工作区与 `ctx.connection()` 共用同一个对象，它们就不会指向两条连接。
 */
function workspaceForSession(conn) {
  const id = conn ? conn.workspaceId : null;
  if (id) return id;
  if (cfg.workspaces[0]) return cfg.workspaces[0].id;
  const workspace = {
    id: config.newWorkspaceId(),
    name: config.nextWorkspaceName(cfg),
  };
  cfg.workspaces = [...cfg.workspaces, workspace];
  config.saveConfig(cfgDir, cfg);
  return workspace.id;
}

/**
 * 给一条新建的连接定下它的工作区。三种来路，按优先级：
 *
 *   ① `want` 是一个工作区 id，用它（界面在表单里显式选了那一个）
 *   ② `want === null` 建一个空白工作区（界面选了「＋ 新建空白工作区…」）
 *   ③ `want === undefined` 界面没表态，走默认规则
 *      （`config.defaultWorkspaceFor`：同址已有连接 → 活跃连接的 → 都没有就建一个）
 *
 * 「没表态」与「要一个新的」是两件事，所以一个用缺席、一个用 `null` 表示。
 *   混起来的话，「同址已有连接」那条默认规则会被表单里那个默认选中项悄悄吃掉 ——
 *   而它正是这次重做要修的那个症状（连同一台机器两次，拿到两份空白存储）。
 *
 * 默认规则本身在 `config.js` 里，因为界面也要读它（表单那个下拉要把默认值
 *   显示出来）。这里只负责把它落成配置。
 *
 * `want` 那个工作区存不存在由调用方先查（`app:saveConnection` 在动配置之前
 *   就查了）—— 那条路报错时不该留下半截改动。这里再查一次是给 ③ 用的：默认规则
 *   给出的 id 可能已经没了（工作区被回收），那时落回 ② 。
 */
function ensureConnectionWorkspace(conn, want) {
  if (conn.workspaceId && config.findWorkspace(cfg, conn.workspaceId)) return conn.workspaceId;

  let pick = want === undefined ? config.defaultWorkspaceFor(cfg, conn) : want;
  // 测试夹具那条连接不参与默认规则（与从前那条内置连接同一条理由）：
  //   它指向本机的假站点，与用户真正要连的集群是两个站点。让用户的第一条连接
  //   落进它的工作区，那个工作区就永远收不掉。
  if (isTestWorkspace(pick)) pick = null;
  if (pick && config.findWorkspace(cfg, pick)) {
    config.setConnectionWorkspace(cfg, conn.id, pick);
    return pick;
  }
  const workspace = {
    id: config.newWorkspaceId(),
    name: config.nextWorkspaceName(cfg),   // 必须在入列之前算，否则会把自己算进去
  };
  cfg.workspaces = [...cfg.workspaces, workspace];
  config.setConnectionWorkspace(cfg, conn.id, workspace.id);
  return workspace.id;
}

/** 测试后端那条连接：测试夹具用的固定 id，`newConnectionId()` 铸不出它。 */
const TEST_CONNECTION_ID = '__test__';
const TEST_CONNECTION = { user: 'demo', host: '127.0.0.1', port: 1, label: '本机假站点' };

/**
 * 测试后端那条连接 —— 只在 `testBackend` 里播种，幂等。
 *
 * 它是一条普通连接：能改、能删、没有保留位。测试夹具自己保证不会把它删掉；
 *   删掉了就由 `_test.seedTestConnection()` 再播一次。
 *
 * 它播在这里而不是 `config.js`：配置模块不该知道测试夹具的存在。放在这个位置
 *   有两个理由：`win` 已经在了，而第一屏还没拿到数据。
 */
function isTestWorkspace(id) {
  if (!testBackend || !id) return false;
  const c = (cfg.connections || []).find((x) => x.id === TEST_CONNECTION_ID);
  return Boolean(c && c.workspaceId === id);
}

function ensureTestConnection() {
  if (!testBackend) return;
  const id = TEST_CONNECTION_ID;
  const hit = cfg.connections.find((c) => c.id === id);
  // 幂等：已经播好、工作区还在，一个字节都不写。
  if (hit && hit.workspaceId && config.findWorkspace(cfg, hit.workspaceId)) return;

  cfg.connections = cfg.connections.filter((c) => c.id !== id);
  const conn = { id, ...TEST_CONNECTION, workspaceId: null };
  cfg.connections = [...cfg.connections, conn];
  if (!cfg.activeConnectionId) cfg.activeConnectionId = id;
  // 自己占一个工作区：与一条用户连接共用的话，"删掉那条连接，它独占的工作区
  //   连同里面的数据一起清"会静默地不成立（这条还指着它，引用计数不归零）。
  ensureConnectionWorkspace(conn, null);
  commitConfig();
}

/**
 * 这个工作区里，这个插件该用哪一份数据 —— 没有就地建一份，并落盘。
 *
 * 第二段（共享组）由 `pluginData.groupOf` 现算，交给 `config.spaceFor` 与记着的那一份
 *   对照 —— 对不上就新开一份，见那个函数的注释。
 * 端口个数同样由清单现算（`pluginData.portCountOf`）—— 一份新建的数据要几个端口
 *   是作者的话，而哪几个由 `config.assignSpacePorts` 按这台机器当前的占用算出来。
 * 落盘是承重的：这一份的 id 决定分区与目录名，下一次启动要能算出同一个名字。
 *   不写的话下一次开会话会铸一个新的，用户上一轮攒的布局凭空消失（且不报错）。
 */
function spaceForSession(workspaceId, plugin) {
  const r = config.spaceFor(cfg, workspaceId, plugin.id, pluginData.groupOf(plugin),
    pluginData.portCountOf(plugin), usedSpacePortsAll(null));
  if (!r) return null;
  if (r.created) config.saveConfig(cfgDir, cfg);
  return r.space;
}

/**
 * 一份数据（持久的或临时的）—— 两个来源合成一次查找。
 *
 * 它不是 `config.findSpace` 的替代品：那一个的语义是"配置里的"，要保持干净
 *   （对账、`workspacePlan` 那些读者要的就是那个意思）。这一层负责把第二个来源并进来。
 */
function findSpaceAll(spaceId) {
  if (!spaceId) return null;
  return config.findSpace(cfg, spaceId) || tempSpaces.get(spaceId) || null;
}

/**
 * 这个工作区里，这个插件有没有活会话在跑。
 *
 * 它是"改这个插件的引用之前要先看一眼"的那道闸，判据必须比
 *   `liveSessionOnWorkspace` 窄一格：那个问的是"这个工作区有没有人在用"（换工作区
 *   时问的，代价是挪端口），而这里问的是"我接下来要改的那一格有没有人正攥着"。
 * 不窄的话，同一个工作区里跑着另一个插件时，连"给这个插件换一份数据"都做不了
 *   —— 那两件事之间没有任何牵连。
 *
 * 两句话都要有，缺一不可（`||` 的两边）：
 *   · 持久那一份：会话手里的 `spaceId` 就在这个工作区的引用表里 —— 正常路径。
 *   · 临时副本（`claimSpace` 造的那些）：它不在引用表里，可它是从这个工作区里
 *     那一份拷出来的。少这一句的后果不是"拒绝失效"，而是误放行：用户趁多开时
 *     改掉引用，那条会话结束之后再接回来时，`reattachOne` 会按新的引用去算
 *     分区与数据目录，而作业实际跑在旧的那一份上 —— 接不回来，且看不出为什么。
 */
function liveSessionForPlugin(workspaceId, pluginId) {
  const ws = config.findWorkspace(cfg, workspaceId);
  if (!ws) return null;
  const ids = new Set(Object.values(ws.refs || {}));
  for (const rec of sessions.values()) {
    if (!occupied(rec.slot)) continue;
    if (!rec.plugin || rec.plugin.id !== pluginId) continue;
    const sid = rec.controller && rec.controller.spaceId;
    if (sid && ids.has(sid)) return rec;
    if (sid && tempSpaces.has(sid)) {
      const conn = (cfg.connections || []).find((c) => c.id === rec.connectionId);
      if (conn && conn.workspaceId === workspaceId) return rec;
    }
  }
  return null;
}

/**
 * 这一份数据被哪个工作区引用着（那个工作区的名字）。只用来把话说清楚 ——
 * 引用表是"哪几个工作区算同一个"那张表，而用户认的是工作区的名字，不是数据 id。
 * 没人引用时返回 `null`（临时那一份就是这样：它不属于任何工作区）。
 */
function workspaceNameOf(spaceId) {
  const ws = (cfg.workspaces || []).find(
    (l) => Object.values(l.refs || {}).includes(spaceId));
  return ws ? ws.name : null;
}

/**
 * 这个工作区里有没有活会话在跑。
 *
 * 判据是"有一条活会话拿着这个工作区引用着的某一份数据"，不是"这条连接是不是
 *   活跃的那条" —— 后者在多开下会把另一条连接那个工作区里的会话当成这一个的。
 * 也不是"有会话的 spaceId 等于工作区 id"：会话跑在数据上，一个工作区
 *   可以同时指着好几份（每个插件一份），而 id 是两套。
 *
 * @returns {object|null} 挡着的那一条会话记录
 */
function liveSessionOnWorkspace(workspaceId) {
  const ws = config.findWorkspace(cfg, workspaceId);
  if (!ws) return null;
  const ids = new Set(Object.values(ws.refs || {}));
  return [...sessions.values()].find((r) => occupied(r.slot)
    && r.controller && r.controller.spaceId && ids.has(r.controller.spaceId)) || null;
}

/**
 * 一份数据听在哪个端口。
 *
 * 没有回落分支，找不到就抛。而理由不是洁癖：一条回落的实现会把
 *   答案写成 `SPACE_PORT_BASE`（18080），而它在临时那一份这条路上
 *   够得着 —— 临时那份不在 `cfg.spaces` 里，于是每一份临时数据都会"回落到"
 *   18080，也就是持有者那一份自己的端口。症状有两条，都很难查：终端上推一条
 *   "端口被占、布局会重置"的假警报（而那个端口根本没有被抢），以及同一份配置
 *   在不同启动顺序下得到不同的 origin（localStorage 于是时有时无）。
 *   宁可停下来，也不要一个看起来像端口冲突的错。
 *
 * 它是唯一的取端口入口。别再长出第二条取端口的函数 —— 一条会回落到基址
 *   （`SPACE_PORT_BASE`）的实现够得着临时那一份这条新路，而它给出的答案是持有者
 *   那个端口（见上）。
 *
 * `ports` 是列表（个数由清单声明，见 `plugin-data.js` 的 `portCountOf`；上界今天
 *   是 1），而第一格就是那个 origin。
 * 取第一格而不是"唯一那一格"是有意的：列表的形状从第一天就在（见
 *     `config.js` 的 `normalizeSpace`），而"框架兑现得了几个"夹在清单校验那一侧
 *     （`MAX_PLUGIN_PORTS`）。上界挪动的那一天，这个函数是唯一要跟着改的地方。
 */
function spacePortOf(spaceId) {
  const s = findSpaceAll(spaceId);
  if (s) return s.ports[0];
  throw new Error(`获取数据 ${spaceId} 的端口失败：它既不在配置里，也不是一份`
    + '本进程还在用的临时数据。（临时那份只活在内存里，进程一重启它就不存在了'
    + '，那时应当重新认领，而不是去问一份已经没有的数据。）');
}

/**
 * 现在所有还占着端口的数据：配置里的 ∪ 临时那些。
 *
 * 三个读者全都走这一个入口（`excludedPortsFor`、`app:setConnectionWorkspace`、
 *   新建临时那一份时挑端口）。少一个的后果都是静默的：
 *   · 隧道顺移时会挑走一份临时数据的端口 —— 而那条监听是活的，于是顺移绑不上，
 *     用户看到"页面忽然打不开"，两边的日志里一个字都不提端口冲突；
 *   · 两份临时数据拿到同一个首选端口 —— 第二份起来时第一份的 origin 被顶掉。
 *
 * 它不是 `config.usedSpacePorts` 的替代品：那一个的语义是"配置里的"，
 *   要保持干净（它还有别的读者）。这一层负责把第二个来源并进来。
 *
 * @param {string|null} [exceptId] 摘掉自己那一份（顺移时自己那个端口不能被当成
 *        "别人的"，否则永远绑不上）。
 */
function usedSpacePortsAll(exceptId) {
  const s = config.usedSpacePorts(cfg, exceptId);
  for (const [id, t] of tempSpaces) {
    if (id === exceptId) continue;
    for (const p of t.ports) s.add(p);
  }
  return s;
}

/**
 * 给这一次会话认领一份数据。
 *
 * ── 认领规则（唯一的实现，`startSession` 与 `reattachOne` 都走它）────────
 *
 * 持有者身份只在开局那一刻确定：开局时那份数据上没有活会话，它就是持有者，
 * 用工作区那张引用表指着的那一份（与这个机制存在之前逐字相同）；已经有，这是一份
 * 临时数据，给它一个新造的、只在内存里的。
 *
 * 已经开着的那一份永不接任。一个正在跑的会话手里攥着它那份数据的 id（分区、数据
 *   目录、外面那个 origin 都从它算），把"持有者"这个身份挪到它头上等于在运行时
 *   迁移一份被活进程持有的存储 —— 做不到，而硬做的症状是页面忽然空掉。所以持有者
 *   结束之后，还开着的那一份接着当临时的，下一个新开的会话才认领持有者。
 *
 * 分两处写必然漂：一处判 `occupied`、一处判 `sessions.has`；一处拷数据、一处不拷。
 *   而漂的后果是静默的 —— `reattachOne` 那一侧漂了，重启之后 N 条会话全部落进
 *   同一个槽，只接回第一条，其余的在集群上继续跑而心跳没了（1800 秒后 scancel）。
 *
 * `concurrent !== true` 的插件恒返回 base：它不能同时开两份（第二份对它是同一份
 *   数据上的两条会话），那正是槽闸要拒的 —— 交给槽闸拒（它的文案说得出是哪一个挡住了），
 *   而不是在这里悄悄给它一份假数据。
 *
 * 它会造一份临时数据，所以只在"这次会话确实要起"的路径上调（槽闸之前那一步），
 *   不要拿它去问"会是什么" —— 那样每问一次就漏一份临时数据。
 *
 * @param {object} baseSpace 引用表指着的那一份（调用方已经保证这个插件要数据空间）
 * @param {object} plugin
 * @returns {object} 这次会话用的那一份
 */
function claimSpace(baseSpace, plugin, taken) {
  const busy = taken || occupied;
  if (!pluginData.canOpenSecond(plugin)) return baseSpace;
  if (!busy(pluginData.slotOf(baseSpace.id))) return baseSpace;
  const t = {
    id: config.newSpaceId(),
    pluginId: baseSpace.pluginId,
    group: baseSpace.group,
    // 端口要跳过两个来源：配置里那些数据，以及本进程里已经活着的临时那些。
    //   少了后者，两份临时数据会拿到同一个首选端口（见 `usedSpacePortsAll`）。
    //   个数跟着持有者那一份走，不跟着清单现算：临时这份必须与 base 同形，
    //     否则"多开＝同一份数据的副本"这件事在端口个数上就先不一致了。
    ports: config.assignSpacePorts(cfg, baseSpace.ports.length, usedSpacePortsAll(null)),
  };
  tempSpaces.set(t.id, t);
  return t;
}

/**
 * 把这一份临时数据的全部痕迹收掉：注册表里那一格，以及它名下的两个落点
 * （浏览器存储分区 + 插件的插件数据目录）。
 *
 * 用 `Map.delete` 的返回值当"只回收一次"的旗子，不在会话记录上再存一个
 *   `rec.reclaimed`：两份状态会漂，而漂的后果正是这个函数要防的那件事 ——
 *   多回收一次会把另一个已经复用了这个 id 的会话的数据删掉，少回收一次
 *   会漏一份永远没人清的目录。旗子和事实是同一个东西时，它不会漂。
 *
 * 调用点的次序是承重的：必须排在 `win.destroySurface(slot)` 之后。
 *   排在前面的话，`livePartitions()` 还看得见那块视图，分区那一半被静默跳过，
 *   每一次回收都在盘上留一份垃圾（而它看起来像"没清干净"，不像"顺序错了"）。
 *
 * 不是临时那些时什么都不做（持久的有它自己的回收路径：引用计数、
 *   或者用户删掉最后一条连接）。
 */
function releaseEphemeral(spaceId) {
  const t = tempSpaces.get(spaceId);
  if (!t || !tempSpaces.delete(spaceId)) return;
  clearSpaceStorage(t);
}

/**
 * 把持有者那份插件数据拷一份当临时那一份的起点。
 *
 * 拷的是那个工作区上这个插件那一份（引用表指着的那一份），不是
 *   "持有者那条会话的" —— 持有者可能是另一个插件（同一个工作区上，web-demo 与
 *   别人可以各有一份身份）。按会话去拷会拷到别人的数据。
 *
 * 同步（`fs.cpSync`），而且调用点与认领之间不许有 `await`：两条
 *   `app:start` 同时在飞时，若在"那份数据上有没有活会话"与 `sessions.set` 之间
 *   让出控制权，两条都会看到"没有持有者"，都用引用表那一份，后一条把前一条的
 *   记录顶掉，前一条的作业从此没有心跳、1800 秒后被 `scancel`，而界面上只有
 *   一条会话。异步拷贝会把那个窗口打开。
 *
 * 源目录不存在（`ENOENT`）= 没有起点，不是错误 —— 持有者可能还什么都没写过。
 *   空目录对插件是一个有定义的状态：它本来就是自己按需建的。
 *   真拷不出来（权限、空间）时照起会话 + 一条 warn：这一份本来就是临时的，
 *   因为读不到起点而拒绝开局，代价比"起点是空的"大得多。
 */
function snapshotTempData(plugin, baseSpace, tempSpace) {
  const root = pluginDataRoot();
  if (!root) return;
  const nameOf = (s) => pluginData.dataDirNameOf(pluginData.identityOf(plugin, s));
  try {
    fs.cpSync(path.join(root, nameOf(baseSpace)), path.join(root, nameOf(tempSpace)),
      { recursive: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return;      // 没有起点：这一份本来就是空的
    win.pushNotice('warn',
      `「${plugin.displayName || plugin.name}」这份临时副本未能获取起点数据`
      + `（${e.message}），它会从空白开始。`);
  }
}

/**
 * 所有会改变引用计数的改动都必须走这里，而不是直接 config.saveConfig。
 * 漏掉一处的后果是某个工作区/某一份数据永远不被回收 —— 它占着一个端口和一份浏览器存储。
 *
 * 反过来，rememberHostKey / forgetHostKey 内部自己 saveConfig 是安全的：
 * 改主机密钥与引用计数无关。那不是漏改。
 *
 * 而端口没有写盘点 —— 它在数据被创建时定下来、此后只读
 *   （见 config.js 的 `assignSpacePorts`），所以 `pruneSpaces` 之外没有任何东西
 *   需要为它操心。
 */
function commitConfig() {
  // 两层回收，次序是承重的：工作区先走，它那张引用表跟着消失；然后才数
  //    "还有没有工作区指着这一份数据"。
  //   · 工作区那一层只解引用、不碰数据 —— 它名下那些数据可能还被别的工作区指着。
  //   · 两层各自都有"活会话拿着"这一条 —— 少了它，把一条非活跃连接切到别的
  //     工作区会让旧工作区引用计数归零、被回收，而那条会话还跑在它指过的
  //     那一份数据上（`clearSpaceStorage` 会把它脚下的存储抽掉）。
  //     两层各数各的，因为它们认的不是同一样东西（一个按工作区 id，一个按数据 id）。
  const { removed } = config.pruneWorkspaces(cfg, liveWorkspaceIds());
  const { removed: goneSpaces } = config.pruneSpaces(cfg, liveSpaceIds());
  try {
    config.saveConfig(cfgDir, cfg);
  } catch (e) {
    // 界面显示「已保存」而磁盘上没写，正是这个项目一路在清的那类问题。
    win.pushNotice('error',
      '配置未能写入磁盘：' + e.message + '（本次改动重启后会丢失）');
  }
  for (const s of goneSpaces) clearSpaceStorage(s);
  reportReclaimed(removed, goneSpaces);
  return removed;
}

/**
 * 此刻正被活会话用着的那些工作区 id。
 *
 * 它是 `liveSpaceIds()` 的姊妹，不是它的副本 —— 两者判据同源（同一个
 *   `occupied`），问的却不是一件事：那一个问"哪几份数据正被拿着"（`pruneSpaces`
 *   按数据 id 认），这一个问"哪几张引用表里躺着那些数据"（`pruneWorkspaces`
 *   按工作区 id 认）。会话手里是一个 `spaceId`，工作区只能由它反查 —— 查不到就
 *   不保留，那一格与 `liveSessionOnWorkspace` 用的是同一个反查。
 *
 * 少了它，一个没有连接指着的工作区会在下一次 commitConfig 时被收掉，
 *   连同它指着的那些数据 —— 而那条会话正跑在上面。
 */
function liveWorkspaceIds() {
  const keep = new Set();
  for (const ws of cfg.workspaces || []) {
    if (liveSessionOnWorkspace(ws.id)) keep.add(ws.id);
  }
  return keep;
}

/**
 * 真的收掉了东西，就说一句。没东西被收就不出声 —— 每一次改动都推一句"什么都没删"
 * 会把日志刷成噪声，而用户就不再读它了。
 *
 * 落在 `#notices`（那个日志区），不是模态框：这是一件已经发生的事，不是要用户
 *   做决定的事。该在动手之前拦下来的那两处（`would_discard`）已经问过了。
 *
 * 两层分开说，因为它们是两件不同的事：工作区没了不等于它的数据没了
 *   （那些数据可能还被别的工作区指着），反之数据的引用计数归零也一定是先有表没了。
 *   合成一句"回收了 N 项"的话，用户就分不出自己那份额外的布局是不是还在。
 */
function reportReclaimed(workspaces, spaces) {
  const parts = [];
  for (const ws of workspaces) parts.push(`工作区「${ws.name}」`);
  for (const s of spaces) parts.push(`「${spaceLabelOf(s)}」`);
  if (!parts.length) return;
  win.pushNotice('info', `${parts.join('、')}没有谁在用了，已经收掉，`
    + '它们的浏览器存储（登录状态、窗口布局）与插件写在磁盘上的文件一起没了。');
}

/**
 * 一份数据在人面前的名字（"<插件>的一份数据"）。
 *
 * 一处定义：回收提示与回收失败的报错都要说得出"是哪一份"，各写一遍的话，
 *   两处会慢慢漂开，而阅读者会把它们当成两样东西。
 */
function spaceLabelOf(space) {
  const plugin = registry.list().find((p) => p.id === space.pluginId) || null;
  return plugin
    ? `${plugin.displayName || plugin.name}的一份数据`
    : `插件 ${space.pluginId} 的一份数据`;
}

/**
 * 此刻正被活会话拿着的那些数据 id。
 *
 * 只有「还活着」的那些算数（判据与 `liveDataDirs()` 同一个 `occupied`）。
 *   已经走到终态的会话记录还留在表里（界面要显示"已结束"），而它名下的数据
 *   从那一刻起是真的没人用了 —— 把它也算成持有者，那一份就永远收不掉。
 * 而这一格够得着：用户结束最后一个会话、再删掉最后一条连接，
 *   "删条目就删数据"那件事就不发生了，而界面上一切正常。
 */
function liveSpaceIds() {
  const keep = new Set();
  for (const rec of sessions.values()) {
    if (!occupied(rec.slot)) continue;
    if (rec.controller && rec.controller.spaceId) keep.add(rec.controller.spaceId);
  }
  return keep;
}

/**
 * 回收一份数据之后的卫生清理 —— 两个根一起清：浏览器存储分区，以及基座
 * 给那个插件建的数据目录（`ctx.dataDir()` 给的那个）。
 *
 * 不是正确性必需 —— 名字永不复用（数据 id 与 partition 都是），残留数据永远
 * 不会被新的数据读到。是隐私：那个分区里躺着 web-demo 的登录 cookie，那个目录里
 * 躺着插件自己的东西（那个插件自己的钥匙、别的插件的缓存）。
 *
 * 有且只有一条致命前提：绝不能对正被用着的那一份做。那会把一条正在跑的
 *   会话脚下的数据抽掉，而症状只是「页面莫名其妙坏了」或「ssh 忽然认证失败」。
 *   所以两半各有各的守卫：分区看 `livePartitions()`（窗口持有），数据目录看
 *   `liveDataDirs()`（会话持有）—— 两者的判据不同，理由见各自那一段。
 *
 * 什么时候会发生：`commitConfig` 里那一层真的回收了数据的时候（最后一个
 *   指着它的工作区没了 —— 而工作区自己又是被 `pruneWorkspaces` 收掉的）。
 *
 * 判据只认那一份数据自己（`pluginId` / `group` / `id`），而不是"注册表里哪些
 *   插件按工作区分" —— 后者要多一次注册表查询，而且插件卸掉之后就问不出来了。
 *   消息面要不要动（有没有分区），由注册表回答（见下面那两处）。
 *
 * 不 await：删一份数据不该因为磁盘慢而卡住界面。
 *
 * @param {object} space 那一份数据（`{id, pluginId, group, ports}`）
 */
function clearSpaceStorage(space) {
  if (!space) return;
  const plugin = registry.list().find((p) => p.id === space.pluginId) || null;
  const label = spaceLabelOf(space);
  const identity = [space.pluginId, space.group, space.id];

  // ── ① 浏览器存储分区 ────────────────────────────────────────────────────
  //
  // 只对有界面的插件做：没有界面就从来没有分区（`ensureSurface` 第一行就返回了），
  //   而 `fromPartition` 会把目录建出来 —— 给一份没有分区的数据"清分区"，等于
  //   在盘上凭空造一个没人认得的目录。
  // 插件不在注册表里（用户卸了它）时也不做：那时我们既不知道它有没有界面，
  //   也不该替它造一个目录。盘上那一半由对账收（它会把那一份判成孤儿）。
  if (plugin && pluginData.hasSurface(plugin)) {
    const partition = pluginData.partitionOf(identity);
    // 正被那块界面用着的分区不能碰（抽掉它会把用户当前那份数据连 cookie
    //   一起弄坏，而症状只是「页面莫名其妙坏了」）。要跳过的是这一个分区，
    //   不是整件事。
    //
    //   判据是"任何一块界面"（`livePartitions()`），不是"那一块"。
    //
    //   跳过仍然是静默的，但那不等于"清理在瞒着用户"：这条路是"开关工作区 /
    //     删连接"带出来的，而那两步在动手之前都已经问过用户了（`would_discard`
    //     那个确认框）。用户主动发起的删除是另一条路（`app:deletePluginData`），
    //     那一条碰到同样的情形会明确拒绝并说清原因 —— 静默只在这一条路上关掉。
    if (!livePartitions().has(pluginData.foldAscii(partition))) {
      const name = pluginData.diskNameOf(identity);
      const root = partitionsRoot().root;
      const r = root
        ? removePlaceAt('partition', root, name, label)
        : { ok: false, pending: false,
            error: '本机的分区目录未找到，所以这一份未能删掉。' };
      // 两条路分开说：删掉了不说话（这一段本来就不是用户发起的，它只是
      //   "回收之后顺手把地面扫了"）；没删掉但登记上了，说清它被推迟了 ——
      //   "推迟"与"失败"在用户那里是两句不同的话。
      if (!r.ok) {
        win.pushNotice('error', `${label}已经回收，但那份浏览器存储未能清干净：${r.error}`);
      } else if (r.pending) {
        win.pushNotice('info',
          `${label}已经回收。那份浏览器存储安排在下一次启动时清掉。`);
      }
    }
  }

  // ── ② 插件写在磁盘上的那一份（`plugin-data/`）────────────────────────────
  //
  // 判据不是"有没有界面"：没有界面的插件照样可能在磁盘上留一份 ——
  //   它没有分区，但有数据目录。
  // 路径现算（与 `ctx.dataDir()` 同一个表达式），绝不从分区名拼 —— 分区名里
  //   插件 id 那一段是大写的，拼出来会静默落空，而 `force` 把 ENOENT 吞掉，
  //   于是"删成功"而目录还在。
  // 整段只报不抛：`commitConfig` 的调用点在 IPC 的成功路径上，这里抛出去
  //   会把「删除连接」变成一句失败，而配置其实已经删了、也存了。
  //
  //   而失败的那条路走的是 `removeDirChecked` 的返回值，不是异常（它自己
  //     把 `rmSync` 包住了）—— 所以 `catch` 这一段是够不着的：今天块里没有
  //     任何一个调用会抛。留着它是因为这里是一条破坏性路径上的成功路径，
  //     而"抛出去"在这里的代价是一句说谎的错误信息（删成功了却说失败）。
  //   别为这个 catch 写用例：没有任何变异打得红它，写出来的只会是一条
  //     看起来在守什么、其实什么也没守的用例。"删不动"那一条真实的路由
  //     `boot.test.mjs` 的〈磁盘删不动时只报、不抛〉守着（它断言的是提示与
  //     IPC 仍然成功）。
  try {
    const root = pluginDataRoot();
    if (root) {
      const name = pluginData.dataDirNameOf(identity);
      if (!liveDataDirs().has(name)) {
        const r = removePlaceAt('data', root, name, label);
        if (!r.ok) {
          win.pushNotice('error', `${label}已经回收，但那份磁盘数据未能清干净：${r.error}`);
        } else if (r.pending) {
          win.pushNotice('info', `${label}已经回收。那份磁盘数据安排在下一次启动时清掉。`);
        }
      }
    }
  } catch (e) {
    win.pushNotice('error', `${label}已经回收，但磁盘上那份数据未能清干净：${e.message}`);
  }
}

// ── 本机的插件数据：对账与删除 ──────────────────────────────────────────────
/**
 * 分区目录的根（并顺带核对一遍命名约定）。
 *
 * 探针必须是该有的身份：`fromPartition` 可能把目录建出来，而编造一个名字
 *   去问，就等于凭空造一份不在"该有的"清单里的目录 —— 用户下次打开客户端会
 *   多看到一行"没人用的数据"，而那一行是我们自己造的。
 */
function partitionsRoot() {
  const probePlugin = registry.list().find(pluginData.hasSurface);
  let probe = null;
  if (probePlugin) {
    if (!pluginData.needsSpace(probePlugin)) {
      probe = pluginData.partitionOf(pluginData.identityOf(probePlugin));
    } else {
      // 探针要用一份真的数据（`cfg.spaces` 里那一条），不是一个现编的 id ——
      //   编一个的话，`fromPartition` 会把那个目录建出来，而它不在"该有的"清单里
      //   用户下次打开客户端多看到一行"没人用的数据"，而那一行是我们自己造的。
      //   一份数据都没有（全新安装、还没开过会话），没有该有的身份可问：
      //   不探，用兜底那条路。
      const s = (cfg && cfg.spaces || [])[0];
      if (s) probe = pluginData.partitionOf(pluginData.identityOf(probePlugin, s));
    }
  }
  let fallbackRoot = null;
  try {
    fallbackRoot = path.join(app.getPath('sessionData'), 'Partitions');
  } catch { /* 老 Electron 上没有这个键：那就没有根 */ }
  return dataAudit.partitionRoot({ session: electronSession, probe, fallbackRoot });
}

/**
 * 基座给插件的数据目录的根（`ctx.dataDir()` 与对账必须同源）。
 *
 * 它跟着 `cfgDir` 走，而 `cfgDir` 就是这一次启动的 `userData`；测试用的是
 *   临时 `userData`，与用户自己那份目录不相干。与 `sitePoolDir()` 同一条理由。
 * 根名 `plugin-data` 只有这一处。给插件的那条路与对账这一条各算一遍，正是这个
 *   仓库最怕的那类漂移：两边会慢慢变成两个目录，而症状是"界面上说没有，插件却在写"。
 *
 * @returns {string|null} `null` = 还不知道（配置目录还没定下来）—— 见 `ctx.dataDir()`
 */
function pluginDataRoot() {
  return cfgDir ? path.join(cfgDir, 'plugin-data') : null;
}

/**
 * 本机插件数据的对账：谁在用、还剩几份。这个函数自己只读，不改任何东西 ——
 * 动手删的是它的两个调用方：`reclaimOrphans()`（自动，只收没人管的那一档）与
 * `app:deletePluginData`（用户点的，那一档由 `deletionVerdict` 判）。
 *
 * 两个根一起查：Electron 的存储分区，以及基座给插件的数据目录。一份身份可能
 *   在两个根下各有一半（浏览器攒的那半 + 插件自己写的那半），所以行由两个根的名字
 *   并起来算（见 `plugin-data-audit.js`）。
 *
 * 它不塞进 `app:bootstrap`：那一次载荷是"启动信息"，而这里要做磁盘 I/O、
 *   还包含一次可能失败的探测 —— 挂上去会让"面板打不开"与"磁盘慢"变成同一件事。
 *   界面进来之后单独拉一次（`app:pluginData`）。
 */
/**
 * 从磁盘名清单里剔掉那些已经登记"下一次启动时删"的。
 *
 * 少了这一步，界面会死循环：用户点「删除」→ 目录删不掉、但登记上了 →
 *   下一轮对账照旧把那一行列出来（那一行还在盘上）→ 用户再点一次。
 *   而"登记上了"这件事本来就要说出来（见 `deferred`），所以剔掉它不损失可见性：
 *   那一行从"没人用的数据"挪到"安排在下一次启动时清掉"，两处都在这一屏上。
 *
 * 比的是磁盘上的目录名（折叠过的那一份）—— 登记时存的就是它。
 */
function withoutPending(list, place) {
  if (!Array.isArray(list)) return list;
  const gone = new Set(pendingRemovals.filter((x) => x.place === place).map((x) => x.name));
  return gone.size ? list.filter((n) => !gone.has(n)) : list;
}

function auditPluginData() {
  const spaces = (cfg && cfg.spaces) || [];
  const pr = partitionsRoot();
  const dataRoot = pluginDataRoot();
  let names = null;
  let why = pr.why || null;
  let dataNames = null;
  let dataWhy = null;
  // ── 两根都查 ──────────────────────────────────────────────────────────
  //
  // 存储分区那一根与插件自己的数据根，判据相同：认得出主人的留，认不出的
  //   登记成下一次启动再删。这里不再有"某个模式下不查某一根"的例外 ——
  //   那种例外曾经让一份数据在两个模式之间被单方面收掉（用户 2026-10-16 报的）。
  if (pr.root) {
    const r = dataAudit.listDirs(pr.root);
    names = withoutPending(r.names, 'partition');
    why = r.why || why;
  }
  if (dataRoot) {
    const r = dataAudit.listDirs(dataRoot);
    dataNames = withoutPending(r.names, 'data');
    dataWhy = r.why;
  }
  return {
    ...dataAudit.audit({
      plugins: registry.list(), spaces, workspaces: cfg.workspaces, connections: cfg.connections,
      names, why, dataNames, dataWhy,
      // 现在正被活会话拿着的（两个根都要）—— 少了它，一份正在被写的
      //    数据会被摆上一个删除按钮。两个根各有各的持有者，所以两句都要：
      //    · `livePartitions()`：浏览器存储分区（窗口持有，见它那段注释）；
      //    · `liveDataDirs()`：插件数据目录（会话持有 —— 没有界面的插件、
      //      以及临时实例，在窗口里都没有位置）。
      //    只给前者的后果够得着：`boot.test.mjs` 里那个没有界面的 `headless`
      //    夹具活着的时候就能被删掉。
      // 顺序无关（`audit` 内部收成一个集合），折过没折过也无关（它自己再折一遍）。
      held: [...livePartitions(), ...liveDataDirs()],
    }),
    // 两根都给出去：删除要按行的 `places` 分派，而它需要知道每一根在哪。
    roots: { partition: pr.root, data: dataRoot },
  };
}

/**
 * 把没人认领的孤儿收掉 —— 本版唯一会删用户数据的一步。
 *
 * 判据三层，缺一不可（前两层在 `plugin-data-audit.js`，第三层是这里的 `held`）：
 *
 *     磁盘上有 ∖ 当前注册表算得出 ∖ 没有任何活会话认领
 *
 * 只收 `reclaimable` 那一档（`orphan` / `legacy`）—— 不是"界面上可删的全删"：
 *   `unused` 的那个工作区还在配置里，下一次有连接指过去就会读它（见那个函数的注释）。
 *
 * 时机与对账同一次（`app:pluginData`）。对账本身就是"打开客户端时跑一次"
 *   （保留 ⑪），所以这条判据没有多出一个时机、也没有多出一份状态。
 * 次序是承重的：先收、再对账。反过来的话，回给界面的 `rows` 里还列着刚刚
 *   被收掉的那些，用户点一下「删掉这一份」会拿到一句"它已经不在清单里了"。
 *
 * 删的是自动化，不是可见性：这份记录一路送到面板上（"本次启动清掉了 N 份
 *   没人管的数据"）。用户看不见的删除，与"数据自己消失了"是同一件事 —— 这正是
 *   账本 F35 那个形状的另一面。
 *
 * 清不掉的那些如实带回去（`failed`），不当成功：`removeDirChecked` 复核过
 *   "它真的不在了"，而报成功却还在的话，下一次对账会把同一行再列出来。
 *
 * @returns {Promise<{count: number, items: Array<{name, label}>,
 *                    failed: Array<{name, label, error}>}>}
 *          累计到这一次运行上（见 `lastReclaim` 那段）
 */
async function reclaimOrphans() {
  const report = auditPluginData();
  const items = [];
  const failed = [];
  for (const row of report.rows.filter(dataAudit.reclaimable)) {
    // 串行：一份一份地删。并行没有收益（一轮通常只有个位数），而串行让失败停在
    // 那一份上，`failed` 里的次序也就是盘上的次序。
    const r = await clearOneRow(row, report.roots);
    if (r.ok) items.push({ name: row.name, label: row.label });
    else failed.push({ name: row.name, label: row.label, error: r.error });
  }
  // 累加到"这一次运行"上（`count` / `items`），而 `failed` 是覆盖（只报
  //   最近一次仍在盘上的那些）—— 两条不同的意思，见 `lastReclaim` 那段。
  lastReclaim = {
    count: lastReclaim.count + items.length,
    items: [...lastReclaim.items, ...items],
    failed,
  };
  return lastReclaim;
}

/**
 * 删一个目录，并复核它真的不在了。
 *
 * 复核不是多余的：Windows 上有句柄时 `rm` 会删一半然后抛（`force` 只吞 `ENOENT`），
 *   Linux 上删掉之后 Chromium 可能把同一个目录再写出来。报成功而它还在的话，下一次
 *   对账会把同一行再列出来 —— 用户会以为"我明明删过了"。
 */
function removeDirChecked(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    // 报的是结果，不是那一坨原话：`e.message` 里带着整条路径、而且这条路径
    //   Windows 上出现两遍（`fs.rmSync` 构造 message 的方式），界面上那一行
    //   会长到没法读。路径用户已经在清单里看见了，这里只需要"为什么"。
    return { ok: false, error: `目录删除失败（${e.code || '未给出原因'}）。` };
  }
  return fs.existsSync(dir)
    ? { ok: false, error: '目录删除失败（删掉之后又出现）。' }
    : { ok: true, error: null };
}

/**
 * 删一个落点，删不动就登记成"下一次启动时删"。
 *
 * 传进来的根由调用方算好（`auditPluginData` 已经算过一遍，别在这里再算一次 ——
 *   分区那个根要问 Electron，而"问"这个动作本身会唤醒一个分区）。
 *
 * @param {'partition'|'data'} place
 * @param {string} root
 * @param {string} name 磁盘上的目录名
 * @param {string} label 给人看的那一句（登记时要存下来，见 `config.js` 那一段）
 * @returns {{ok: boolean, pending: boolean, error: string|null}}
 *          `ok` 且 `pending` = 这一次没删掉，但已经安排在下一次启动时删。
 *          `ok` 且非 `pending` = 真的删掉了。
 */
function removePlaceAt(place, root, name, label) {
  const r = removeDirChecked(path.join(root, name));
  if (r.ok) return { ok: true, pending: false, error: null };
  config.recordPendingRemoval(cfgDir, pendingRemovals, place, name, label);
  return { ok: true, pending: true, error: r.error };
}

/**
 * 上一次运行登记下来的那些目录，这一次开机补删。
 *
 * 时机就是它的全部理由：必须在任何一块界面被建出来之前跑。Chromium 只要醒着
 *   （某块插件界面被显示过，或者问过一次分区根），它就攥着那个分区目录里的
 *   句柄到进程结束 —— Windows 上被打开的文件删不掉（EPERM），而 Electron 没有
 *   销毁 session 的 API。启动这一路上还没有任何会话、任何界面，所以此刻它们是
 *   自由的。这一句排在 `registry.reload()` 之后（分区根要问注册表里的一个身份）、
 *   排在 `new ShellWindow` 之前。
 *
 * 删掉的从清单里划掉，删不掉的留着 —— 下一轮再试。一份永远删不掉的目录于是
 *   会在每一次启动时说一句，而不是静静地留在盘上（那与"我没删过它"同形）。
 *
 * 它报的份数累加进 `lastReclaim`：那正是"本次运行清掉了什么"，而这一批
 *   上一次就已经被判成没人管了。
 */
function sweepPendingRemovals() {
  if (!pendingRemovals.length) return { count: 0, items: [] };
  const done = [];
  for (const it of pendingRemovals.slice()) {
    const root = it.place === 'partition' ? partitionsRoot().root : pluginDataRoot();
    if (!root) continue;
    if (!removeDirChecked(path.join(root, it.name)).ok) continue;
    config.forgetPendingRemoval(cfgDir, pendingRemovals, it.place, it.name);
    done.push({ name: it.name, label: it.label || it.name });
  }
  if (done.length) {
    lastReclaim = {
      count: lastReclaim.count + done.length,
      items: [...lastReclaim.items, ...done],
      failed: lastReclaim.failed,
    };
  }
  return { count: done.length, items: done };
}

/**
 * 现在有几份在等着下一次启动时清掉（给界面的那一份）。
 *
 * 它与 `lastReclaim` 答的是两个问题：那一格是"已经发生了什么"，这一格是
 *   "还欠着什么"。分开说，是因为它们要用户做的事不同 —— 前者什么都不用做，
 *   后者要他知道"这一份今天还留在盘上"。
 */
function deferredRemovals() {
  return {
    count: pendingRemovals.length,
    items: pendingRemovals.map((x) => ({
      name: x.name, label: x.label || x.name, place: x.place,
    })),
  };
}

/**
 * 清掉一行插件数据 —— 按它的 `places` 分派到各个落点。
 *
 * 一份数据的两个落点是一起删的：只删浏览器那一半的话，下一次对账会把同一行
 *   再带回来（`places` 里还剩 `data`），而用户会以为"我明明删过了"。
 *
 * 这里从前有一支 `clearPartitionStorage`，它先 `fromPartition(...).clearStorageData()`
 *   再删目录。那一支整个删掉了，理由是次序错了：`fromPartition` 正是让 Chromium
 *   打开那个目录、攥住里面句柄的动作，于是紧接着的 `rmSync` 在 Windows 上必然
 *   EPERM（用户 2026-10-15 报的那一条）。而它想解决的那件事（"让 Chromium 松手"）
 *   在删目录这条路上本来就不成立 —— Electron 没有销毁 session 的 API，一个被
 *   唤醒过的 context 会活到进程结束。所以现在只有一条路：直接删目录，删不动就
 *   登记，下一次启动时删（见 `removePlaceAt` 与 `sweepPendingRemovals`）。
 *
 * 根由调用方给（`auditPluginData` 已经算过一遍）：分区那个根要问 Electron 一个
 *   该有的身份，而"问"这个动作本身会把那个分区建出来 —— 删除这一条路上，
 *   少唤醒一个是一个。
 *
 * @param {object} row   `audit` 算出来的那一行（用它里面的 `name` 与 `places`）
 * @param {{partition: string|null, data: string|null}} roots 两个根
 * @returns {{ok: boolean, pending: boolean, error: string|null}}
 *          `ok` 为假 = 这一次没删成、也没能登记（根取不到）。`ok` 且 `pending`
 *          = 已经登记在下一次启动时删。两者都假 = 真的删掉了。
 */
function clearOneRow(row, roots) {
  const places = Array.isArray(row.places) ? row.places : [];
  let pending = false;
  for (const place of ['partition', 'data']) {
    if (!places.includes(place)) continue;
    const root = roots && roots[place];
    if (!root) {
      return { ok: false, pending,
        error: place === 'partition'
          ? '本机的分区目录未找到，所以这一份未能删掉。'
          : '本机的插件数据目录未找到，所以这一份未能删掉。' };
    }
    const r = removePlaceAt(place, root, row.name, row.label);
    if (!r.ok) return { ok: false, pending, error: r.error };
    if (r.pending) pending = true;
  }
  return { ok: true, pending, error: null };
}

// ── 会话表 ──────────────────────────────────────────────────────────────────
/**
 * 这个槽还占着吗。
 *
 * 判据是"上一个会话已经完了"：ENDED / ERROR / IDLE / RELEASING 都算。
 *
 * `RELEASING` 那一档尤其要紧 —— 从点「结束会话」到站点确认之间隔着一段真的
 *   释放流程，把它当成"还占着"会让「结束会话」变成一道单向门：用户结束掉一个，
 *   那个槽在释放走完之前都开不了新的（而走完要多快取决于站点）。
 */
function occupied(slot) {
  const rec = sessions.get(slot);
  if (rec && rec.reserved) return true;
  const c = rec && rec.controller;
  return Boolean(c)
    && ![State.ENDED, State.ERROR, State.IDLE, State.RELEASING].includes(c.state);
}

/**
 * 这个槽现在被占着吗（本人手里的预留不算）。
 *
 * 预留与豁免必须成对：`claimSpace` 在并发时靠它判断该不该拿临时那一份，
 *   而刚刚写下预留的那一条自己不能被自己的预留挡住。
 */
function slotTaken(slot, token) {
  if (occupied(slot)) return true;
  const holder = startingSlots.get(slot);
  return Boolean(holder) && holder !== token;
}

/**
 * 界面的那一份视图。一次给全。
 *
 * `live` 与"有没有记录"是两件事：已经结束的记录还要显示（用户要看"已结束"，
 *   也要在那里点「重新开始」），而它不占着槽。
 */
function sessionViews() {
  return [...sessions.values()].map((rec) => ({
    slot: rec.slot,
    service: rec.plugin ? (rec.plugin.displayName || rec.plugin.name) : null,
    live: occupied(rec.slot),
    // 这一份是不是临时数据（第二份、数据是一份副本、会话结束就没了）。
    //   判据只有一个来源：那张临时数据注册表。不要在会话记录上另存一个布尔
    //   —— 两份状态会漂，而漂的后果是"界面说它是临时的，而它其实已经变成持久的"
    //   或者反过来（用户据此以为自己的改动会留下，或者以为不会）。
    temporary: Boolean(rec.controller && tempSpaces.has(rec.controller.spaceId)),
    snap: rec.controller ? rec.controller.snapshot() : null,
  }));
}

/**
 * 「作业列表」那一屏的数据：把服务端的 `op:list` 与本机的会话表合起来。
 *
 * 为什么以服务端那一份为准，而不是直接画本机的会话表：
 *
 *   本机那张表（`sessionViews`）回答的是"这个客户端在管哪几条会话"，而作业列表
 *   要回答的是"这个站点上我还有哪些作业"。两者在正常情况下一样，差在三种场合，
 *   而三种都真的会发生：
 *     · 上一台电脑提交的、本机刚连上还没来得及接的；
 *     · 本机认不出插件（`registry.resolve` 给了 `why`）因而 `reattachOne` 早退的；
 *     · 刚刚结束、本机记录已经收掉、而服务端还留着那一行（`released_keep`）的。
 *   只画本机那一份的话，这三种里用户看到的都是"我没有作业了" —— 而作业还在。
 *
 * 而动作仍然只给本机接着的那些（`attached`）。理由不是省事：结束一条会话
 *   走的是 `SessionController.stop()`，而它要心跳、要隧道、要那条会话的完整视图；
 *   给一条没接着的会话再写一条"直接发 goodbye"的短路，就是同一条规矩的第二份
 *   实现 —— 而它漂开的方向是"界面说结束了、作业还在烧"。
 *   没接着的那些照实说出来（`attached:false`），出路是重连一次（`doConnect`
 *   会跑 `tryReattach`），而不是在这里再造一个入口。
 *
 * `keeper` 原样带出去（一个 `client_id` 或 `null`），判等只在这里做一次 ——
 *   界面不认识别人的 `client_id`，它能说的只有"一台不是本机的电脑"。
 */
function jobsView(rows) {
  const me = clientIdentity && clientIdentity.id;
  const bySession = new Map();
  for (const rec of sessions.values()) {
    if (rec.controller && rec.controller.sessionId) {
      bySession.set(rec.controller.sessionId, rec);
    }
  }
  return (rows || []).map((r) => {
    const sid = r && r.session_id;
    const rec = bySession.get(sid) || null;
    // 认插件走注册表那一份实现（`resolve`），不在会话列表里另写一套按
    //   `service_kind` 抄名字的逻辑 —— 认不出时它给的 `why` 是给人看的那句话。
    const { plugin } = registry.resolve(r.service_kind, r.service_plugin);
    const live = SERVER_LIVE_STATES.includes(r.state);
    return {
      session_id: sid,
      state: r.state,
      // 会话状态译成人话 —— 与作业状态（`job_state`）是两张表，别混：
      //   会话 `suspect` 的时候作业可能好好地跑着（见 sessionstate.js）。
      state_text: sessionStateText(r.state),
      live,
      job_id: r.job_id || null,
      partition: r.partition || null,
      node: r.node || null,
      expires_at: typeof r.expires_at === 'number' ? r.expires_at : null,
      job_state: r.job_state || null,
      // 作业状态那一句与快照里用同一个译法（`jobstate.js`）。界面在「选中的那
      //   一条」里要画它 —— 而那一块可能指向一条本机没接着的记录，它没有
      //   本地快照可用（2026-10-17 真机：点别的记录，详情不跟着变）。
      job_text: jobText({
        jobState: r.job_state, jobTerminal: r.job_terminal,
        jobReason: r.job_reason, jobExitCode: r.job_exit_code,
        jobRestarts: r.job_restarts, timeLimit: r.time_limit,
      }),
      resources: r.resources || null,
      gres_text: gresText((r.resources || {}).gres),
      // 认得出插件就给名字，认不出给 null —— 界面据此说「本机没有这个插件」，
      // 而不是编一个名字出来。
      service: plugin ? (plugin.displayName || plugin.name) : null,
      service_kind: r.service_kind || null,
      attached: Boolean(rec),
      slot: rec ? rec.slot : null,
      keeper: r.keeper || null,
      // 「谁在看」只有三句话，而它们是三件不同的事：本机在看 / 另一台电脑
      //   在看（那台也许多半已经断了网）/ 没人在看（倒计时正在跑）。
      //   压成一个布尔会让后两种糊成"不是本机"，而用户要做的事完全不同。
      // keeper 为空时再分一格：本机正替它保活的话，「没人在看」是一句假话 ——
      //   作业确实有人在续命，只是没有人当家。
      keeper_text: !live ? null
        : (r.keeper ? (r.keeper === me ? '本机在看' : '另一台电脑在看')
          : (keepAliveSids.has(sid) ? '没人接管（本机在保活）' : '没人在看')),
      keepalive: keepAliveSids.has(sid),
      keeper_is_me: Boolean(me) && r.keeper === me,
    };
  });
}

/**
 * 把已经结束的记录收掉。
 *
 * 槽是淘汰制的：一个槽的上一轮记录留着，是为了让界面能显示"已结束 + 重新开始"；
 * 而只要用户开始了新的一轮，那一屏就没有意义了。
 * （只有一个会话时这是自动的 —— 新 controller 直接顶掉旧的。多开之后要有人做。）
 */
function reapSessions() {
  for (const [slot, rec] of sessions) {
    if (occupied(slot)) continue;
    closeHostSession(rec);
    sessions.delete(slot);
  }
}

/**
 * 现在真的被某一块界面用着的那些分区（一组折叠过的名字）。
 *
 * 为什么是"一组"而不是"那一个"：前台只是"哪一块盖在上面"。判据不能跟着
 *   前台走 —— 回收一个工作区时，被抽掉的是"正在跑的那块页面"脚下的
 *   localStorage，而它完全可能就是后台那一个。
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
 * 现在真的有一条活会话落在上面的那些插件数据目录（折叠过的目录名）。
 *
 * 它是 `livePartitions()` 的姊妹，不是它的副本 —— 判据不同：
 *   · 分区是窗口持有的（构造 WebContentsView 时定下来），所以那里问的是
 *     "哪块视图显示着哪个分区"；
 *   · 插件数据目录不由窗口持有 —— 它由 `ctx.dataDir()` 现算，唯一的主人是
 *     那条会话。拿前者当后者用会静默失效：一个没有界面的插件（要工作区却
 *     没有 `surface`）在窗口里没有位置，于是它正在用的那份目录会被当成没人用的。
 *
 * 一条活会话要报两个落点：它被交给过的每一个，以及现在这一个。
 *   两者不是同一件事，各有一条自己的理由，缺一条都会删掉活数据。
 *
 *   ① 被交给过的（认领）—— 这是事实。一条会话一生里会被交给若干个目录
 *   （`ctx.dataDir()` 每次现算），而插件进程手里攥着的是它那一次拿到的那个路径：
 *   框架这边算出"它现在应该在别处"，不等于那个进程不在旧路径上写。所以"这条会话
 *   被交给过哪些落点"只能记下来，算不出来。
 *
 *   ② 现在这一个 —— 这是推论。会话刚被挪到另一个实例键（`relisten`）、而
 *   插件还没来得及调 `ctx.dataDir()` 时，新那个落点已经被交出去了吗？还没有 ——
 *   但它下一秒就会有，而空目录对插件是一个有定义的状态（它自己按需建）。
 * 这一条还有第二个作用：没有实例段的那些插件（`concurrent: false` 的那种）
 *   照样有一个目录（`<id>@<共享组>`）。按 `needsSpace` 把它们整个跳过的
 *   话，它们在"该有的"那张表里的那一格就只靠这个身份撑着 —— 于是插件一离开
 *   注册表（用户卸了那个版本、或者作者升了版本而新版改掉了共享组），一条正在
 *   跑的会话脚下的那份数据就没任何东西护着了。那不是"漏删"，那是把用户正在写
 *   的钥匙与 ssh 配置删掉。
 *
 * 只增不减：一条会话用过的落点只增不减，所以护着的范围只会变大。方向是
 *   故意的 —— 多护一份的代价是它晚一轮被收掉，漏护一份的代价是删掉用户正在
 *   写的数据。晚收的那一份会在那条会话结束之后的某一次对账里被 `reclaimOrphans`
 *   收走（它那时才真的没人认领了）。
 *
 * 少了它的症状是静默的：回收一个工作区、或者一次对账，把一条正在跑的会话脚下
 *   那份数据删掉（`ssh slurmate` 忽然认证失败、编辑器状态没了），而用户只点过
 *   "换工作区"或"删连接"。这条路径今天够得着：
 *     ① 会话跑在 C1 的工作区上 → ② 把活跃连接切成 C2（不动引用计数、不停会话）
 *     → ③ 从 C1 改工作区：`isActive` 是假、不走 relisten，而 C1 原来那个工作区
 *     引用计数归零、被回收。
 *
 * 它够不着的那一格：会话记录已经收了（`occupied` 为假）而它的插件进程还
 *   活着 —— 今天不存在（`stopAllSessions` 之后紧接着就是 `app.exit(0)`）。
 */
/**
 * 此刻有活会话落在上面的那些插件：`插件 id → [槽位, …]`。
 *
 * 它是 `livePartitions()` / `liveDataDirs()` 那一族的第三个成员，判据同样与它们
 *   不同：那两个护的是数据（分区目录、数据目录），这一个护的是代码 ——
 *   插件那一份客户端代码被删掉之后，`registry.reload()` 会让一条正在跑的会话
 *   脚下的插件从注册表里消失。
 *
 * 只认"还活着"的那些（判据与 `liveSpaceIds()` 同一个 `occupied`）：已经走到终态的
 *   会话记录还留在表里（界面要显示"已结束"），而它不再占着那个插件。
 *
 * 认不出的服务（`rec.plugin` 为空）跳过：它没有插件，也就无所谓"哪一个插件在跑"。
 */
function livePlugins() {
  const out = new Map();
  for (const [slot, rec] of sessions) {
    if (!occupied(slot) || !rec.plugin) continue;
    const id = rec.plugin.id;
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(slot);
  }
  return out;
}

function liveDataDirs() {
  const out = new Set();
  for (const rec of sessions.values()) {
    if (!occupied(rec.slot) || !rec.controller) continue;
    const p = rec.plugin;
    if (!p) continue;                    // 认不出的服务：它没有插件，也就没有目录
    // ① 事实：这条会话被交给过的那些落点（起点那一次，以及每一次 dataDir()）。
    for (const name of rec.claims || []) out.add(name);
    // ② 推论：现在这一刻按同样的输入算出来的那一个。拿不到那一份数据时只跳过它
    //    （① 已经在上面收过了）—— 那一条会话连 `ctx.dataDir()` 都调不通。
    const space = findSpaceAll(rec.controller.spaceId);
    if (pluginData.needsSpace(p) && !space) continue;
    out.add(pluginData.dataDirNameOf(pluginData.identityOf(p, space)));
  }
  return out;
}

/**
 * 把这一条会话此刻的数据落点记下来（认领）。
 *
 * 算的是同一个表达式 `ctx.dataDir()` 用的那一个（`dataDirNameOf(identityOf(…))`）
 *   —— 分开算的话，"护着的"与"交出去的"会漂开，而漂开的症状正是这条判据要防的
 *   那件事（护了个寂寞）。
 *
 * 要工作区的插件必须拿得到那一份数据（`spaceFor` 保证工作区里它有一份）；
 *   真拿不到时不记，也不抛 —— 那一条会话连 `ctx.dataDir()` 都调不通，
 *   它的下场由那一次的抛去说，不该在会话刚建出来时就把它拦下。
 */
function claimDataDir(rec, plugin, space) {
  if (!rec || !rec.claims || !plugin) return;
  if (pluginData.needsSpace(plugin) && !space) return;
  rec.claims.add(pluginData.dataDirNameOf(pluginData.identityOf(plugin, space)));
}

/**
 * 这一次会话的端口排除集：别人已经拿走的都不许碰。
 *
 * 「别人」不止别的那几份数据。只排别的数据端口的话，中转站从中转基准端口起，
 *   而没有任何东西把它从数据隧道的候选里排除掉。数据隧道从数据端口一路 +1 往上探
 *   （`tunnel.js` 的 `PORT_SCAN_LIMIT`），撞上就把那条监听抢过来，而症状是"页面忽然打不开"，
 *   两边的日志里一个字都不提端口冲突。
 *
 * 而"别人的"端口现在有两个来源（配置里的 + 临时那些），所以这里走
 *   `usedSpacePortsAll` 而不是 `config.usedSpacePorts` —— 见那个函数的注释。
 */
function excludedPortsFor(spaceId, except) {
  const s = usedSpacePortsAll(spaceId);
  for (const other of sessions.values()) {
    if (other === except) continue;
    const p = other.controller && other.controller.snapshot().localPort;
    if (p) s.add(p);
  }
  return s;
}

/** 一条会话正在用的那份数据要排除掉哪些端口 —— 隧道绑定时用。 */
function excludedPortsOfRec(rec) {
  return excludedPortsFor(rec.controller && rec.controller.spaceId, rec);
}

// ── 会话编排 ────────────────────────────────────────────────────────────────
/**
 * 起一个会话。
 *
 * @param {object} resources 高级选项里的临时覆盖（见 session.js 的 start）
 * @param {string} serviceKind 这一次要哪个插件（注册表里的名字）。必填。
 * @param {string} [portChoice] 用户在「端口被占」那一行上答过的（只认 `'shift'`）。
 *        见下面那一节 —— 它唯一的作用是不再问第二遍。
 * @returns {Promise<{slot, snap}|{conflict:{want,spaceId}}|null>}
 *   `conflict` 这一支表示"首选端口被占着，等用户答"，此刻什么都没提交。
 */
/** 站点清单里这一条；拿不到清单时返回 `null`（与 `pluginsView()` 同一口径）。 */
function siteEntryFor(plugin) {
  if (!sitePlugins || !Array.isArray(sitePlugins.plugins)) return null;
  return sitePlugins.plugins.find((x) => x && x.id === plugin.id) || null;
}

/**
 * 这个插件此刻走不走本机入口。
 *
 * 四个条件与 `pluginsView()` 的 `local` / `runnable` 同源：
 *   插件导出 `startLocal`、站点明确说 `can_submit: false`（没有作业侧）、
 *   站点开着它、本机也开着它。有作业侧的插件永远走作业 —— 两者都声明时
 *   作业优先，避免同一个插件因为多了一个钩子就换了执行位置。
 */
function localOutletFor(plugin) {
  if (!plugin.hasLocalEntry) return false;
  const s = siteEntryFor(plugin);
  const known = Boolean(sitePlugins && Array.isArray(sitePlugins.plugins));
  if (!known || !s) return false;
  if (s.enabled === false) return false;
  if (s.can_submit !== false) return false;
  return config.pluginEnabledLocally(cfg, plugin.id);
}

async function startSession(resources, serviceKind, portChoice) {
  // 必须写明要哪一个插件。
  //
  //   省略服务种类就去猜一个缺省的话，问题在于缺省是"本站的缺省服务是哪一
  //   个"，而那是站点的事（配置里的 `default_plugin`，见 cluster/slurmate），
  //   不是某个客户端本地的约定。两边各存一份的代价是漂开时静默 —— 客户端的缺省
  //   与站点的缺省可以指向两个不同的插件，而没有东西会红（账本 S19）。
  //
  //   界面上走不到这里：每个启动按钮绑的都是 `startWith(p.name, btn)`，服务名
  //     永远显式传。所以走到这里的是调用方漏传了参数，而那件事必须当场说清 ——
  //     让它落到下面那条"不认识这种服务"上，报出来的是一句关于"服务种类"的话，
  //     而根因是少了一个实参。
  if (typeof serviceKind !== 'string' || !serviceKind) {
    win.pushNotice('error', '开会话必须写明用哪一个插件（服务种类），'
      + '这一条请求没有写。这是调用方漏传了参数，与站点无关。');
    return null;
  }
  // 认不出的服务种类在提交之前就拦住。走到提交再让服务端回一句
  //   `bad_service_kind` 也行，但那要花掉一整趟往返，而且用户看到的是一个
  //   关于"服务种类"的错误、而他刚才点的可能是一个界面上的按钮。
  //
  // 提交时只知道短名（那份配置的文件名、界面按钮上那个），而本机可能并存同一个
  //   插件的多个版本 —— 站点报了的话就按它报的那个 `(id, 版本)` 取，否则取版本
  //   最高的那一个。版本对不上时下面会明确说出来（但不拦，见 warnVersionDrift）。
  //
  //   短名可以撞，所以 `pickForSubmit` 在同名多条时不猜，把 id 列出来
  //     交给下面那一支说清楚。
  const pick = pickForSubmit(serviceKind);
  const plugin = pick.plugin;
  if (!plugin) {
    // ── 站点的短名有歧义（一种合法的站点）──────────────────────────
    //
    // 这一支必须排在最前，而且必须自己有一句话：落到下面任何一支都是
    //   指错方向 —— "不认识这种服务"会让用户以为客户端太旧，"一个都没装"会让
    //   他去重新同步，而两件事都不是。真相是这个短名在站点里指两个东西，
    //   要做的事是让管理员在站点配置里改用 id（或者把其中一个改个短名）。
    //
    // 也不替用户挑一个：站点那一侧同样会拒（`resolve_plugin_spec`），
    //   挑了只是把一次必然的失败提前到本地、还顺手掩盖了原因。
    if (pick.ambiguous.length) {
      win.pushNotice('error',
        `本站有 ${pick.ambiguous.length} 个插件都叫「${serviceKind}」，所以这个名字`
        + '指不出是哪一个，提交已经拦下。要请管理员在站点配置里改用插件的 id：'
        + `${pick.ambiguous.join('、')}。`);
      return null;
    }
    // 「一个插件都没装」与「不认识这个名字」是两件事，行动也不同（去装一个
    //   vs 换个按钮点）。含糊的一句「本版支持：（一个都没有）」既是一句错话
    //   （本版没有"支持"任何东西，是你还没装），也没给出路。
    // 第三种情况：它就在本机，只是还没同意。与"没有这个插件"必须分得开 ——
    //   一个是去点同意，一个是去同步/去装。含糊的一句"不认识这种服务"会让用户
    //   跑去重新同步，而同步本来就已经成功了。
    const held = registry.list().find((p) => p.name === serviceKind && p.active === false);
    if (held) {
      win.pushNotice('error',
        `「${held.displayName}」${held.version} 已经取回本机了，但它的客户端代码`
        + '还没有经过你的同意，所以没有加载。到插件那一栏确认同意再试。');
      return null;
    }
    // `active !== false` 的那些才算"装上了"：只剩待同意的插件时，用户面对的
    // 就是"一个能用的都没有"，走下面那条空态才对。
    if (!registry.list().some((p) => p.active !== false)) {
      // 出路只有一条：站点分发。站点不分发时，只能如实说"这条路走不通"，
      //   而不是给一个用户照着做也做不到的动作（§5.1 那条说的正是这件事）。
      const canSync = Boolean(siteSync && siteSync.supported);
      win.pushNotice('error',
        '本机还没有装上任何插件，所以没有可以提交的服务。'
        + (canSync
          ? '本站会分发插件。用插件那一栏的「重新同步」取一次，'
            + '带客户端代码的要先确认同意。'
          : '而这个站点不分发插件。插件只能由站点发下来，所以客户端这一侧'
            + '没有其他办法。请联系这个站点的管理员。'));
    } else {
      win.pushNotice('error',
        `这个客户端不认识「${serviceKind}」这种服务，已阻止提交。`
        + `本机装的是：${registry.list().map((p) => p.displayName).join('、')}。`);
    }
    return null;
  }
  warnVersionDrift(plugin);

  // 插件代码在独立进程里。握手没过（加载失败、导出不合法、超时）就不能
  //   拿它去接会话 —— 否则失败会推迟到 prepare，而那时槽已经占住了。
  if (plugin.ready) {
    try {
      await plugin.ready;
    } catch (e) {
      win.pushNotice('error', `「${plugin.displayName || plugin.name}」没有加载成功：${e.message}`);
      return null;
    }
  }

  // 这一次会话是哪条连接的 —— 读一次，两处共用：工作区从它算，
  //   `ctx.connection()` 也从它来。分两处读会让它们指向两条不同的连接。
  //
  //   读的是当前活跃连接：会话就是从界面上那个连接起的。这个读法有代价 ——
  //     切活跃连接不影响已经在跑的会话，所以重连接回来的会话可能拿到"不是它自己的"
  //     那条（见 `connectionFor()`）。
  const conn = config.activeConnection(cfg);
  const isLocal = localOutletFor(plugin);

  // 本机插件由站点分发，入口也只在该站点的那一屏上。没有连接就没有可归属的
  //   站点；允许它照样启动会让"离开站点之后本机服务还在跑"变成一条正常路径。
  if (isLocal && (!conn || !backend || !backend.connected)) {
    win.pushNotice('error', '本机插件需要先连接站点才能打开。');
    return null;
  }

  // 工作区是按插件的：跑在浏览器里的插件要一个（端口 = origin = 一份
  //   编辑器布局），不跑浏览器的不给 —— 给它一个只会凭空造出一份永远不会被
  //   创建的存储，并让「运行中切工作区」去挪一个正在用的隧道端口。
  const baseWorkspaceId = pluginData.needsSpace(plugin) ? workspaceForSession(conn) : null;
  // 而工作区里还要有这个插件的那一份数据 —— 端口、分区、数据目录全从它算。
  //   `spaceForSession` 会在没有时就地建一份并落盘（`0.y` 不迁移，所以每一份都是新的）。
  const baseSpace = baseWorkspaceId === null
    ? null : spaceForSession(baseWorkspaceId, plugin);

  // 认领（见 `claimSpace`）：持有者身份只在这一刻确定。上面那一份是
  //    "引用表指着的那一份"，而这一行回答的是"这一次会话用哪一份数据" —— 那一份上
  //    已经有活会话时，这一份是临时数据（一个只在内存里的新 id、新端口、
  //    空的浏览器存储、持有者那份数据的快照）。
  //    它与下面那道槽闸的次序是承重的：认领先发生，于是"能多开"的插件拿到
  //    一份新数据、槽闸放行；"不能多开"的插件拿到原来那一份，槽闸照旧拒它并说出原因。
  // 预留：在第一次等待之前把槽占住。`prepare` 现在要过进程边界，认领与写表
  //   之间必然会经过一次等待；槽的可见性从这里起由 `startingSlots` 保证，
  //   不再靠"这一段恰好没有 await"（见 docs/CONTRACT.md §3.1.1）。
  const startToken = {};
  const baseSlot = pluginData.slotOf(baseSpace && baseSpace.id);
  // 别的启动已经占着这个槽时不要覆盖它的预留：覆盖之后，两条都会看到
  //   「持有者是我自己」，于是都拿到原来那一份数据。
  if (!slotTaken(baseSlot, startToken)) startingSlots.set(baseSlot, startToken);
  const space = baseSpace === null
    ? null : claimSpace(baseSpace, plugin, (s) => slotTaken(s, startToken));

  // ── 槽：一个活跃会话占一份「一个就够」的资源，同一个槽只能有一个 ──────────
  //
  // 判据与逐条理由见 `plugin-data.js` 的 `slotOf`。这里只做一件事：拒绝，并说出
  // 是哪一个挡住了。只说一句「会话已在进行中」对用户毫无用处：它不说是哪个
  // 会话挡着，也不说该怎么办。而多开的代价更大：被拒绝的那条会静默地顶掉一条
  // 正在跑的。
  const slot = pluginData.slotOf(space && space.id);
  if (slot !== baseSlot) {
    // 用了临时那一份：持有者仍然占着 base，改为占临时这个槽。
    if (startingSlots.get(baseSlot) === startToken) startingSlots.delete(baseSlot);
    startingSlots.set(slot, startToken);
  }
  if (slotTaken(slot, startToken)) {
    if (startingSlots.get(slot) === startToken) startingSlots.delete(slot);
    if (space && space.id !== (baseSpace && baseSpace.id)) releaseEphemeral(space.id);
    const other = sessions.get(slot);
    const who = other && other.plugin
      ? `「${other.plugin.displayName || other.plugin.name}」` : '另一个会话';
    win.pushNotice('error', space
      ? `${who}正用着「${workspaceNameOf(space.id) || '那个工作区'}」里`
        + `「${plugin.displayName || plugin.name}」那一份数据。一份数据就是一个本地端口、`
        + '一份浏览器存储，所以同一时刻只能有一个会话用它。先结束那一个，'
        + '或者到「工作区」那一栏给这条连接换一个工作区。'
      : `${who}正占着中转站的位置。不要工作区的会话共用同一份对外身份`
        + '（同一个 ssh 别名、同一个基准端口），所以同一时刻只能有一个，'
        + '先结束那一个。');
    return null;
  }
  // 上一个已经结束的那个记录该走了（它是给界面看"已结束"用的，新的一轮开始了）。
  reapSessions();

  // 本地端口不是插件的事（插件没有取端口的钩子）：要工作区的会话用那份数据
  // 自己的端口（它就是 origin），不要工作区的用中转基准端口。
  //
  // 必须判 null：不要工作区的会话拿的是 `RELAY_PORT_BASE`，而它绝不能落到
  //   某一份数据的端口上 —— 那条路径不报错，症状是"浏览器那一块打到 ssh 端口
  //   上，页面打不开"。
  //   而 `spacePortOf` 那条路连回落都没有（找不到就抛）：临时那份不在配置里，
  //     一条会回落到基址（18080）的实现会让每一份临时的都从 18080 起扫，也就是
  //     持有者自己那个端口。
  //
  // 本机插件没有隧道：`ports: 1` 用那份数据自己的端口，`ports: 0` 不给端口
  //   （插件自选）。后者不得回落到 `RELAY_PORT_BASE` —— 那是中转站共用的基准端口。
  const preferredPort = space
    ? spacePortOf(space.id)
    : (isLocal ? null : config.RELAY_PORT_BASE);

  // ── 端口冲突：在提交之前问 ──────────────────────────────────────────
  //
  // 一份数据的端口是它被创建时定下来的，此后只读（`config.js` 的
  // `assignSpacePorts`）。而真正的绑定发生在提交与登记之后
  // （`session.js` 的 `_bringUpTunnel`）—— 所以"要不要换一个（只换这一次，还是记住
  // 新配置）"这个问题必须在这里问：等到绑定那一刻，作业已经在集群上了，用户答
  // "取消"就是一句空话。
  //
  // 只对持久的那份数据问，判据是两个框架事实，永远不是插件名：
  //   · 没有数据空间（中转站）—— 它用的是那个共用的基准端口，无所谓"这一份数据的
  //     地址"，顺移也不改变任何持久的东西；
  //   · 临时副本（多开的第二份）—— 它只活在这一次会话里，端口是当场从空位里挑的。
  //   两者都照旧自动避让（顺移 + 如实说明），不问。
  //
  // 探测用的是 `probeLocalPort`，不是"查一下谁在听"之类的近似判据：它试绑的是
  //   `127.0.0.1:<port>`，与隧道同一个地址，而且只认 EADDRINUSE / EACCES ——
  //   近似判据报出来的问题会与接下来真绑时撞上的不是同一件事。
  //
  // 排除集与隧道绑定时用的是同一份来源：别的工作区占着的端口由分配器负责
  //   跳过，那是照旧的静默顺移，不是冲突 —— 在这里问一句"要不要临时换"，
  //   等于把一个已经由分配器答过的问题再问用户一遍。
  //
  // `'shift'` 与 `'remember'` 用户已经答过了（界面把那一下重发到这里）：
  //    不再探、不再问 —— 否则一个真被占着的端口会让那一行永远问下去。
  //    两者的分别不在这一层（这里对它们做的是同一件事：别拦他）：`'remember'`
  //      还多一步"把新端口记进配置"，而那一步排在绑定成功之后（见下面那一段）
  //      —— 此刻还没有"新端口"这回事。
  const persistentSpace = Boolean(space) && !tempSpaces.has(space.id);
  const answered = portChoice === 'shift' || portChoice === 'remember';
  // 本机插件不探端口：端口要么是那份数据自己的（`ports: 1`，插件自己绑），
  //   要么由插件自选；沿用隧道那套「换一个还是记住」只会问一个不存在的选择。
  if (!isLocal && persistentSpace && !answered
      && !excludedPortsFor(space.id, null).has(preferredPort)) {
    let probe;
    try {
      probe = await probeLocalPort(preferredPort);
    } catch (e) {
      // 探不动不是"端口被占"：报成冲突会让用户去关一个无关的程序。
      if (startingSlots.get(slot) === startToken) startingSlots.delete(slot);
      win.pushNotice('error', `探测本地端口 ${preferredPort} 失败：${e.message}`);
      return null;
    }
    if (!probe.free) {
      // 此刻什么都没有发生：没有作业、没有会话记录、没有占位、配置一个字
      //   都没动。这正是「取消」能是字面意思的原因 —— 界面那一行三选一，答
      //   「取消」就地回退，没有任何东西要撤。
      if (startingSlots.get(slot) === startToken) startingSlots.delete(slot);
      return { conflict: { want: preferredPort, spaceId: space.id } };
    }
  }

  // `claims` = 这条会话用过的插件数据落点（认领，见 `liveDataDirs` 那段）。
  //   它随这条记录生、随这条记录死 —— 记录一收，会话的插件进程也就没了，
  //   那些目录从那一刻起是真的没人用了。
  const rec = { slot, plugin, pluginWhy: null, controller: null,
                connectionId: conn ? conn.id : null, claims: new Set() };
  claimDataDir(rec, plugin, space);

  // RELEASING 也算「上一个会话已经完了」。不加它的话：断开之后 controller 停在
  //   releasing（心跳与推送都停了，只剩那个释放期的短轮询在等站点确认），而这里
  //   会复用那个 controller，接着 controller.start() 抛「会话已在进行中」——
  //   于是「断开」成了一道单向门，用户必须重启客户端才能再开会话。
  //   让新会话拿一个新 controller 之后，若旧作业还没被守护进程收掉，用户会拿到
  //   服务端那句准确的「已有 1 个活跃会话（上限 1）」，而不是一句指不回根因的话。
  // 在这里捕获插件对象（塞进 `rec`），之后所有状态变化都用它，不再查注册表。
  //
  //   站点升级插件之后池里会有同一个 id 的新版本，而一个已经跑着的会话用的是
  //   它起时那一版 —— 作业侧与客户端侧是配套的两半，中途换掉这一半，轻则行为诡异、
  //   重则对接不上。捕获之后，升级插件对正在跑的会话完全没有影响。
  //
  //   顺带得到一个好性质：把一个插件从池里卸掉，正在跑的会话也完全不受影响 ——
  //   它手里已经攥着那个对象了。
  // 这一段（controller 的构造与 `sessions.set`）排在 `prepare()` 之前，
  //    是为了 `ctx.dataDir()`。 那个能力从 `rec.controller.spaceId` 现算第三段，
  //    而 `prepare()` 若跑在 controller 构造之前，一个「要数据空间
  //    （`ports` > 0）又带 `prepare()`」的插件，一提交就撞上 `identityOf`
  //    那个"没有给出那一份数据"的抛 —— 也就是说这种插件根本提交不出去。
  //    （今天声明了 `prepare` 的插件 `ports` 都是 `0`，这条路上还没有人踩到过。）
  //
  //    `rec.controller.spaceId` 是唯一的第三段来源，不要在 `rec` 上另存
  //      一个：两份会在 `relisten` 改了 controller 那一份之后分家，
  //      而 `liveDataDirs()` 走的是 controller 那个 —— 于是它看不见这条会话正用着
  //      的目录，回收一份数据时把正在跑的数据删掉。

  rec.controller = new SessionController({
      backend,
      spaceId: space ? space.id : null,
      // 不要工作区的插件：实际端口要交给插件自己去落（写进它自己那份配置）。
      // 这里只需要「重新渲染一次」，插件按当前端口重写它需要的那份；端口和
      // 主机公钥都没变时它会自己跳过（那正是 ctx.once() 的用处）。
      //
      // 要工作区的会话没有对应的回调 —— 端口是那份数据的只读属性，顺移只影响
      //   这一次会话，实际值在快照里。见 session.js 的 `_announcePort`。
      onRelayPort: () => onSessionChange(slot),
      // 端口顺移时必须跳过别的那几份数据占着的端口，否则两份会声称同一个端口，
      // 每次启动谁先绑谁赢，会话在两个 origin 之间反复横跳。排除集里要摘掉自己，
      // 不然自己那个端口会被当成「别人的」而永远绑不上。
      //
      // 不要工作区的插件 spaceId 是 null，于是这里排除掉全部数据端口 ——
      // 正是要的：它绝不能落到某一份数据的端口上。
      // 多开之后「别人」不止别的那几份，见 `excludedPortsFor`。
      getExcludedPorts: () => excludedPortsOfRec(rec),
  });
  rec.controller.on('change', () => onSessionChange(slot));
  rec.controller.on('retarget', () => onSessionChange(slot));
  // 预留转交给会话记录：`occupied()` 从这一刻起认 `reserved`，
  //   一直认到 controller 把状态改成 SUBMITTING（那是同步发生的，见下面）。
  if (startingSlots.get(slot) === startToken) startingSlots.delete(slot);
  rec.reserved = true;
  sessions.set(slot, rec);

  // 临时那一份：开局把持有者那份插件数据拷一份当起点。
  //    同步（见 `snapshotTempData`），而且必须在 `sessions.set` 与 `prepare`
  //    之间不留 `await` —— 这一段就是那条"两条 `app:start` 同时在飞"的竞态窗口，
  //    让出控制权会让后一条顶掉前一条的记录（前一条的作业从此没有心跳）。
  //
  //    判据是"认领给的与引用表指着的不是同一份"，而不是问 `tempSpaces`：
  //    两者今天等价，但将来多一个临时来源时，这一行仍然说得对。
  if (baseSpace && space.id !== baseSpace.id) {
    snapshotTempData(plugin, baseSpace, space);
  }

  // 插件的提交前准备（需要公钥的插件要在这里备好那把一次性密钥：没有它守护进程会拒绝
  // 这次提交，而那要花掉一整趟往返）。先备好再提交是硬要求。
  //
  // 排在槽那道闸之后：为一个马上会被拒的会话去生成一把钥匙，是在磁盘上留一个
  //   用户没要求过的副作用。
  //
  // 失败时要把刚才那两条记录撤掉：槽里留着一条假记录，那个槽再也开不了
  //   新的（用户看到的是"某某正占着那份数据"，而那个会话根本不存在）；临时那份
  //   留着，注册表里多一格、数据目录永远没人回收（面板上那一行还删不掉 ——
  //   `held` 会护着它）。
  let sshPubkey = null;
  if (plugin.prepare) {
    const pre = await plugin.prepare(pluginCtxData(rec), String(rec.slot));
    if (!pre || !pre.ok) {
      closeHostSession(rec);
      sessions.delete(slot);
      releaseEphemeral(space && space.id);
      win.pushNotice('error', (pre && pre.message) || '提交前的准备失败，已中止。');
      return null;
    }
    sshPubkey = pre.sshPubkey || null;
  }

  // `preferredPort` 在上面（端口那道闸那一节）就算出来了 —— 探测要用它。
  //
  // 点「开始会话」是用户唯一一次说"我要用这个站点的插件"：顺手问一次站点
  //   清单，变了就补一次对账（见 `checkSitePlugins`）。不 await —— 会话该起就
  //   起，用的是池里此刻那一版；对账在后台把新版取回来、把没人再要的旧版收掉。
  // 本机插件不问：它一个 RPC 都不该发（见 boot 用例〈本机插件：站点报
  //   can_submit=false，点「在本机打开」不提交作业〉）。
  if (!isLocal) checkSitePlugins();

  // 本机插件走 `startLocal()`：不提交、不建隧道、不起心跳。两条路返回同一种
  //   快照，所以下面的失败清理与界面切换都只有一份。
  const snap = isLocal
    ? await rec.controller.startLocal(
      (ctx, opts) => plugin.startLocal(ctx, opts, String(rec.slot)),
      pluginCtxData(rec), {
        port: preferredPort,
        serviceKind: plugin.name,
      })
    : await rec.controller.start(resources, {
        preferredPort,
        serviceKind: plugin.name,
        needsPubkey: plugin.contributes.submitPubkey,
        sshPubkey,
        // 用户在那道闸上答过的（没问过就是 null）。见 `SessionController._portChoice`。
        portChoice,
      });
  // controller 的两个入口都在函数体开头同步把状态改成 SUBMITTING；
  //   那之后槽由状态本身占着，预留可以交了。
  rec.reserved = false;
  if (!snap && !rec.controller.sessionId) {
    // 这一次在服务端没有留下任何东西（被 quota / 权限 / 校验拒掉，或者压根没提交
    //   出去）。那条记录与临时那一份都只是这一趟的产物：留着它们，界面上会多出
    //   一颗「死标签」—— 用户看到第二条会话，以为新的被排着队（2026-10-18 真机：
    //   站点把插件上限设成 1，再点一次「开始会话」就是这样）；临时那一份还会一直
    //   占着一个端口，直到进程退出。
    //
    // 原因推进提示流：记录一收，它就没有别的地方可以显示了。
    // 已经有 `sessionId` 的那些不走这一支 —— 服务端确实建了一条会话（提交超时后
    //   认领到的、或者被拒到终态的），那条记录要留着让人看见它、接上它、结束它。
    const why = (rec.controller.snapshot() || {}).error || '会话没有起来。';
    closeHostSession(rec);
    sessions.delete(slot);
    // 次序与回收那份临时数据的那几处相同：先拆视图，再删数据（见 releaseEphemeral）。
    //   这一趟本来就没有视图，这一句是给"槽被上一轮留下过一块"那种情况兜底。
    win.destroySurface(slot);
    releaseEphemeral(space && space.id);
    win.pushNotice('error', why);
    await onSessionChange(slot);          // 把那一颗死标签从界面上撤掉
    return null;
  }
  if (!snap) onSessionChange(slot);

  // ── 「记住并启动」：把这份数据的首选端口改成隧道真正绑上的那一个 ──
  //
  // 提交返回时作业可能还在排队，那一刻没有"新端口"可记。所以这里只挂一个待办，
  //   等状态真的到 running 再记（`applyPendingRemember`）—— 直接读 `localPort`
  //   会读到 null，待办当场丢掉，用户下次开局还会被问一遍，却以为自己答过了。
  if (snap && !isLocal && portChoice === 'remember' && persistentSpace) {
    rec.pendingRememberPort = { spaceId: space.id, preferred: preferredPort };
    applyPendingRemember(rec);
  }

  // 排队中也要把控制权交回界面：那条会话已经在服务端上了，作业开始之后
  //   页面会自己打开（见 `_afterSubmit`）。这句话让人知道现在能做什么。
  if (snap && snap.state === State.QUEUED) {
    win.pushNotice('info', `会话已提交，正在排队（作业 ${snap.jobId || '—'}）。`
      + '作业开始之后页面会自己打开，这期间可以照常做其他事。');
  }

  // 回槽：界面拿它指着说"我起的是这一个"（`app:start` 的回包）。
  return { slot, snap };
}

/**
 * 把「记住并启动」的待办落下来。
 *
 * 写的是隧道真绑上的那个端口（快照里的 `localPort`），不是按顺移规则重算一遍 ——
 *   同一条规则不许有两份实现，而两份漂开的形态是"记下来的端口没人在用"。
 * `localPort === preferred` 时什么也不做（这一趟没有顺移）。
 * 写不进去要如实说出来：用户点的是"记住"，没记住的话，他下次开局还会被问一遍，
 *   却以为自己已经答过了。
 */
function applyPendingRemember(rec) {
  const p = rec.pendingRememberPort;
  if (!p || !rec.controller) return;
  const snap = rec.controller.snapshot();
  if (!snap) return;
  if ([State.RELEASING, State.ENDED, State.ERROR, State.IDLE].includes(snap.state)) {
    delete rec.pendingRememberPort;      // 会话没等到 running：没有端口可记
    return;
  }
  if (snap.state !== State.RUNNING || !snap.localPort) return;
  delete rec.pendingRememberPort;
  if (snap.localPort === p.preferred) return;
  const wrote = config.recordSpacePort(cfg, p.spaceId, snap.localPort);
  if (!wrote.ok) {
    win.pushNotice('error', `端口未能记进配置：${wrote.error}`
      + `　这一次会话照常跑着（用的是 ${snap.localPort}），但下次启动还会问你一次。`);
  } else {
    commitConfig();
    win.pushNotice('info', `这份数据的端口已记成 ${snap.localPort}`
      + `（原来是 ${p.preferred}），下次启动直接用它，不会再问。`);
  }
}

/**
 * 提交时该用本机的哪一个插件。
 *
 * 优先按站点报的 `(id, 版本)` 挑，而不是"同名里版本最高的那个"：那个才是
 *   这个会话真会跑的那一版，而客户端的 `prepare()` 必须与服务端即将起的那份
 *   配套。
 *
 *   （两个不同的插件可以合法地同名并存，所以"短名对上多份"是一条正常的
 *   路，不是边角情形。）
 *
 * 同名多条时不许猜。站点报了两条同名而 id 不同的插件时，短名传上去
 *   站点自己也会拒（`resolve_plugin_spec` 那条歧义规则，把几个 id 一起列
 *   出来）。而客户端在这里 `find` 一个的后果比"提交失败"重得多：本机拿 A
 *   的客户端代码去对接站点起的 B 的作业 —— 两半本该配套，而错配是静默的。
 *
 * 歧义时返回 `{plugin: null, ambiguous: [...]}`，让调用方把那几个 id 说出来。
 *
 * 站点没报（老守护进程、或还没连上）时才退回按短名取版本最高的那个 —— 那一格
 * 没有歧义可言：老守护进程按短名去重，同一短名它只可能起一个。
 *
 * @returns {{plugin: object|null, ambiguous: string[]}}
 */
function pickForSubmit(name) {
  const named = ((sitePlugins && sitePlugins.plugins) || []).filter((p) => p.name === name);
  if (named.length > 1) {
    return { plugin: null, ambiguous: named.map((p) => p.id).filter(Boolean) };
  }
  const s = named[0];
  if (s && s.id && s.version) {
    const hit = usable(registry.get(s.id, s.version));
    if (hit) return { plugin: hit, ambiguous: [] };
  }
  return { plugin: usable(registry.latestByName(name)), ambiguous: [] };
}

/**
 * 这一份能不能拿去开会话。
 *
 * `active === false`（站点分发的、代码还没过同意闸的那一份）绝不能出手 ——
 *   它一个钩子都没有，拿它去接一个会话等于用半个插件去对接一个作业。`resolve()`
 *   在"接回旧会话"那条路上已经拒了，这里是提交那条路，两条都得拒。
 *
 * 它出现在 `list()` 里是有意的（用户要看得见它才能点同意），所以每个"从
 *   注册表取一个来用"的地方都要过这一道 —— 见 pickForSubmit 与 startSession。
 */
function usable(p) {
  return (p && p.active !== false) ? p : null;
}

/**
 * 站点那边的版本和本机这一份对不上时，说出来但放行。
 *
 * 为什么放行：站点升级插件不该让所有人的客户端当场变成砖头。而作业侧与客户端侧
 *   是配套的两半，真的对不上时会话起来之后解析不到那一版，那时会有另一句更
 *   准确的话（"站点用的是 X 版，本机只有 Y 版"）—— 用户仍然接得上隧道、停得掉
 *   会话，只是用不了那个界面。
 *
 * 为什么还是要说：不说的话，用户看到的是"点了开始、作业起来了、界面一片白"，
 *   而根因一个字都不在里面。这正是这个项目一路在清的那类症状。
 *
 * 老守护进程不报版本（`siteVersion` 为 null）时不说话 —— 那不是漂移，是信息缺失。
 *
 * 找站点那一条按 `id`，不按短名：短名会撞，按名字找会拿到
 *   另一个插件的那一条，于是这句话会说"站点那边是 X 版"——而 X 版是隔壁那个
 *   插件的版本号。一句说错对象的警告比不说更坏：它把用户指去升级一个本来就
 *   没问题的插件。按 id 找之后，"找不到"就如实变成不说话（`siteVersion` 为 null）。
 */
function warnVersionDrift(plugin) {
  const site = ((sitePlugins && sitePlugins.plugins) || []).find((p) => p.id === plugin.id);
  const siteVersion = site && site.version;
  if (!siteVersion || siteVersion === plugin.version) return;
  if (!registry.once(`${plugin.id}@${siteVersion}`, 'version-drift')) return;
  win.pushNotice('warn',
    `站点那边的「${plugin.displayName}」是 ${siteVersion} 版，本机这一份是 `
    + `${plugin.version} 版。会话仍然会起，但作业侧和客户端侧是配套的两半，`
    + '不一致时界面可能连不上，升级客户端通常就好了。');
}

/**
 * 状态变化的唯一渲染入口。
 *
 * 整体包 try/catch：这是一个 async 的事件处理器，抛出去就变成
 *   unhandledRejection —— 在 Electron 里表现为「界面某处悄悄不更新了」，
 *   而控制台里只有一条谁也不看的警告。宁可把它变成面板上看得见的一条错误。
 */
async function onSessionChange(slot) {
  try {
    // 「记住并启动」的待办：排队中的那条到了 running 才记（见它的说明）。
    const rec0 = sessions.get(slot);
    if (rec0) applyPendingRemember(rec0);
    await _renderSession(slot);
    // 一条会话走完了（结束、或者出错停在那儿）：它冻在站点里那个 `id@版本`
    //   从此不再被任何会话引用。那一版该不该回收只有对账下得了（回收只认引用），
    //   而"会话结束"从前不触发对账 —— 于是新版装上来、旧版一直躺在池里，界面上
    //   两颗同名的块并排，要等下一次连上站点才收掉（用户 2026-10-27）。
    // 只在这一条第一次走到终态时排一次：`onSessionChange` 在终态上还会被叫很多次。
    const done = sessions.get(slot);
    const doneState = done && done.controller ? done.controller.snapshot().state : null;
    if (done && !done.reclaimQueued
        && (doneState === State.ENDED || doneState === State.ERROR)) {
      done.reclaimQueued = true;
      // 池里只有这一版时什么都不会被回收，那一趟白跑（它要把整池哈希一遍）。
      //   这条判据也让"平时的结束会话"与"刚升级完插件"这两件事分开。
      if (done.plugin && pooledVersionCount(done.plugin.id) > 1) scheduleSiteReclaim();
    }
    // 一次推全部 —— 面板那一屏要显示的是"这个窗口里有几个会话、各自什么样"，
    // 而不是"最后动过的那一个"。
    const views = sessionViews();
    // 窗口那一层要的两件事（几条活着、各自的 closeWarning）走这一份；界面要的
    // 那一份走 pushSessions。分开：前者是"关窗会掐断什么"，后者是"画什么"。
    win.setSessions(views.map((v) => {
      const rec = sessions.get(v.slot) || {};
      const c = rec.controller;
      return {
        // 「本机在看」才算一条：被接管的、以及接上来还没心跳成功的那一段，
        //   都不属于本机 —— 关窗确认与收尾只该数、只该结束本机真正在看的那几条
        //   （见 `SessionController.watching`）。
        live: v.live && Boolean(c) && c.watching,
        // 本机会话没有作业，关窗确认不能再说「作业会被取消」。
        onHost: Boolean(c && c.isLocal()),
        service: v.service,
        plugin: rec.plugin || null,
      };
    }));
    // 前台换到一条接回来的会话时，面板不让开 —— 用户没有点过它的标签，
    //   而"连上站点就自动进了插件页面"正是这一格漏出来的（见 windows.js 的
    //   `pushSessions` 与用户 2026-10-20 报的那一条）。
    const f = frontSlot();
    const frec = f ? sessions.get(f) : null;
    win.pushSessions(views, f, { reveal: !(frec && frec.adopted) });
    // 手里有控制权就把空手表撤掉；没有就重新起表（见 `EMPTY_HANDS_MS`）。
    if (hasControl()) disarmEmptyHands();
    else if (backend.connected) armEmptyHands();
    // 「作业一结束右栏就收起来」那条规矩的落点。判据与面板上那个点、以及
    //   `startOutPoll` 自己那一条同源（有没有作业在跑）—— 三处各写一份的话，
    //   漂的那一处表现为"作业停了，浮窗还挂在那儿显示旧内容"，看起来像它还在跑。
    //   位置在这里而不是 `startOutPoll` 的定时器里：那个定时器 1.5 秒才看一眼，
    //     而"结束了"这件事本身有推送，不必等下一拍。
    if (win.hoverOpenSide() === 'right'
        && ![...sessions.keys()].some((k) => occupied(k))) {
      win.hideHover();
    }
  } catch (e) {
    win.pushNotice('error', '更新界面时出错：' + e.message);
  }
}

/**
 * 正盖在面板上的那一个槽。
 *
 * 它是界面的事实，不是框架的事实 —— 别拿它决定行为（停哪个作业、用哪份
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
 * 调一次插件的 attach。
 *
 * 它从前是渲染里的一行 `await`，失败就和渲染一起被那句「更新界面时出错」吞掉。
 *   三件事因此分开，每一件都对应一个真机现场：
 *
 *   · attach 不是渲染。它失败时界面这一轮该照常更新 —— 状态、标签、提示页
 *     都是这次渲染的产物，而插件那一步（多半是自动登录）与它们没有关系。
 *
 *   · 同一条会话同时只跑一次。隧道断着的时候浏览器每重连一次就发一次状态变化，
 *     而每一次 attach 都要等到登录超时才回来；不去重的话它们在同一份会话上
 *     排队，界面上是一条接一条相同的错误（用户 2026-10-26 报的就是这个）。
 *     在飞期间到来的变化只记一个待办，这一轮结束后用此刻的快照补一次 ——
 *     直接丢掉的话，最后一次变化可能等不到下一拍（心跳 45 秒）。
 *
 *   · 同一条错误只说一遍。下一次调用会再试，成功之后那句记录清掉。
 *
 * 这三格记在会话记录上，是这一处私有的运行时状态（不落盘、不对外）。
 */
async function runAttach(rec, plugin, snap) {
  if (!plugin || !plugin.attach) return;
  if (rec.attachBusy) { rec.attachAgain = true; return; }
  rec.attachBusy = true;
  try {
    await plugin.attach(pluginCtxData(rec), snap, String(rec.slot));
    rec.attachError = null;
  } catch (e) {
    const text = (e && e.message) || String(e);
    if (rec.attachError !== text) {
      rec.attachError = text;
      win.pushNotice('warn',
        `「${plugin.displayName || plugin.name}」的插件动作未能完成：${text}。`
        + '界面照常更新；下一次状态变化会再试。');
    }
  } finally {
    rec.attachBusy = false;
    if (rec.attachAgain) {
      rec.attachAgain = false;
      // 只在这一条还在跑的时候补：在飞那一段时间里它可能已经结束（或正在
      //   释放），那时 attach 的条件不成立了。
      const fresh = rec.controller && rec.controller.snapshot();
      if (fresh && fresh.state === State.RUNNING) {
        await runAttach(rec, rec.plugin || plugin, fresh);
      }
    }
  }
}

/**
 * 画这一条会话。
 *
 * 参数是槽，不是快照 —— 这一点是故意的。收一个裸 `snap` 的签名会把"这是
 *   哪一条会话的"变成一个无从回答的问题：里面每一句 `win.hideSurface()`、
 *   `win.setSessionService(plugin)`、`controller.plugin` 都在暗中假设"只有一个会话"。
 *   收槽之后，这些句子必须先答出那个问题才写得出来。
 */
async function _renderSession(slot) {
  const rec = sessions.get(slot);
  if (!rec || !rec.controller) return;          // 记录已经收了：什么都不画
  const snap = rec.controller.snapshot();

  // 会话没有了（结束/出错/正在释放），或者压根还没起来：这一条会话的页面背后的
  // 服务器已经不存在了 —— 隧道在 stop() 的最开头就停了 —— 收起它那一块，
  // 把窗口主体还给面板，而面板上正是「重新开始」那几个按钮。
  //
  // RELEASING 也要算在内，而且它才是在真机上最先到达的那一个：stop() 发出
  //   goodbye 之后状态就是 releasing，而它要等下一次 status 轮询（60 秒）才可能
  //   变成 ended。只收 ENDED 的话，用户点了「结束会话」之后还要盯着一块打不开的
  //   页面最多一分钟。
  //
  // 收的是这一个槽，不是"窗口里那一块"。收"窗口里那一块"是静默的
  //   越权：甲会话结束，把乙会话那块正跑着的页面一起销毁掉 —— 通知、状态条
  //   全都正常，只有用户的编辑器没了，而出路（重新加载）正压在那块页面底下。
  if ([State.RELEASING, State.ENDED, State.ERROR, State.IDLE].includes(snap.state)) {
    win.destroySurface(slot);
    // 临时那一份到这里就没了（这一条会话结束了，那份副本的使命也就完了）。
    //
    //    必须排在 `destroySurface` 之后，次序是承重的：那个调用会销毁这一块
    //      视图，而 `releaseEphemeral` 里 `clearSpaceStorage` 拿 `livePartitions()`
    //      当"正被用着"的守卫。排在前面的话那块视图还在，分区那一半被静默跳过
    //      每一次回收都在盘上留一份垃圾，而它看起来像"没清干净"，不像"顺序错了"。
    //
    //    传的是 `rec.controller.spaceId`（这一次会话的那一份），不是"当前
    //      活跃连接那个工作区指着的那一份" —— 多开时后者是别人的，传错会把别人那份
    //      正在跑的数据清掉。
    releaseEphemeral(rec.controller.spaceId);
  }

  // ── 唯一的服务分派点 ──
  //
  // 插件对象是在会话创建时捕获的（见 startSession / tryReattach），这里只用
  //   它，不再查注册表。查了会坏事：站点升级插件之后池里会出现同一个 id 的新
  //   版本，而一个已经跑着的会话用的是它起时那一版 —— 作业侧与客户端侧是配套
  //   的两半，中途换掉客户端这一半，轻则行为诡异、重则对接不上。捕获之后，
  //   站点升级插件对一个正在跑的会话完全没有影响。
  //
  // 不分流的后果不是崩溃，而是误导：跑在浏览器里的那条路会拿会话口令去
  //   POST 一个 SSH 端口，然后弹一句语义完全错误的「自动登录失败」；反过来
  //   另一边会去建一个 WebContentsView 加载一个根本不说 HTTP 的端口。
  //
  // 这里没有任何插件名。注册表回答的是"这个会话归哪个插件"，所以加第三个
  //   插件时这一段一行都不用改 —— 要动的是插件自己那一棵树。
  // 被接管：这一块页面不再归本机操作。直接收掉，而不是盖一层提示页 ——
  //   用户 2026-10-20 报的是"上栏说被接管，而我完全可以正常使用"。
  //   隧道不拆：重新接管之后要接着用它，而 `suspend()` 本来就特意没拆。
  //   收掉之后 `hasSurface` 为假，下面那段提示页也没有可盖的东西。
  const handedOff = Boolean(snap.suspended);
  if (handedOff) win.destroySurface(slot);

  const plugin = rec.plugin;
  if (!handedOff && snap.state === State.RUNNING && snap.origin) {
    if (!plugin) {
      // 未知服务：绝不建界面（那个端口上跑的可能是任何东西），也绝不 POST 口令。
      // 但它自己那一块必须收掉（上面那道状态闸已经收过了）。
      win.destroySurface(slot);
      await warnUnknownService(slot, snap);
    } else if (plugin.contributes.surface) {
      await ensureSurface(rec, snap);
      await runAttach(rec, plugin, snap);
    } else {
      // 这个插件不要界面（比如中转站）：它自己那一块收掉。
      //
      // 收的是这一个槽：收"窗口里那一块"是一次越权 —— 起一个没有界面的插件时
      //    （以及它每次心跳、每次隧道重建时）会把 web-demo 那块正跑着的页面
      //    一起销毁，而用户看到的是"我的编辑器忽然没了"，日志里一个字都没有。
      win.destroySurface(slot);
      await runAttach(rec, plugin, snap);
    }
  }

  // 提示页与忙碌位跟着前台那一条走：两者都占满整块界面，而屏幕只有一块。
  if (slot === frontSlot()) {
    // 提示页只盖「插件那块页面」，而且只在页面真的用不了时挂：隧道断了，或者
    //   这一块加载失败、停在空白页上。
    //
    //   心跳被限流、状态问不到这类警告不在这里挂 —— 那时页面照常能用，而整块
    //   盖住它等于替用户把编辑器关了一次（用户 2026-10-21 报的"什么也点不了"）。
    //   那几句话由状态条那一行说（见 panel.js 的 `renderSnapshot`）。
    //
    //   没有页面可盖时（未知服务、不要界面的插件）也不挂：整块提示页只会把唯一
    //   能操作的面板涂掉 —— 用户 2026-10-18 在真机上就是这样被困住的：
    //   状态条上只剩一颗「未知服务」的标签，屏幕上除了那句「连接暂时中断」
    //   什么都没有，连「面板」那一颗都不在（它只在有页面盖着时才画）。
    const covered = win.hasSurface(slot);
    if (snap.state === State.RUNNING && covered) {
      // 网络回来这一刻，断网期间坏掉的那块页面先试着重新打开（页面活着就什么都
      //   不做）。提示页留到它真的加载完再收 —— 状态条先恢复、画面后回来，中间
      //   隔着一段空白，而这段时间不能没有任何解释（用户 2026-10-18 报的：
      //   "左侧条已经恢复，画面就应该回来了"）。见 windows.js 的 `recoverSurface`。
      //
      //   隧道还断着就不试：那一次重载必然失败，两次机会白白用完（`reloadTries`）。
      // 本机会话没有隧道，`'local'` 也是「页面可用」的一档 —— 否则它会被
      //   读成「连接断了」，页面一建好就整块盖住。
      const pageUsable = snap.tunnelState === 'listening'
        || snap.tunnelState === 'local';
      const waiting = pageUsable
        ? await win.recoverSurface(slot, snap.tunnelState === 'local'
          ? '本机插件页面正在重新加载。' : '网络已经回来，等页面加载完。')
        : false;
      if (waiting) {
        win.setBusy(true);
      } else if (!pageUsable || win.surfaceBroken(slot)) {
        await win.showOverlay(slot, snap.tunnelState === 'local' ? {
          title: '本机插件页面打不开',
          text: '可重新加载，或结束会话后重新打开。',
        } : {
          title: pageUsable ? '页面暂时打不开' : '连接暂时中断',
          text: snap.warning || '页面现在打不开，正在重试。',
        });
        // 这一支不点亮任务栏（用户 2026-10-27）。它是一段"坏了"的状态，
        //   而不是"正在做什么"：断网、页面停在一张空页上，这两件事可以持续
        //   到用户下次回来。点亮它的话，用户离开窗口之后看到的就是任务栏那颗
        //   图标一直在转 —— 提示"有活动"，而真实的动作一个都没有。
        // 断着这件事由提示页与左栏说（用户回来时它们就摆在眼前）；
        //   任务栏那颗灯只留给真的在飞的那一步：`waiting`（页面正在重载）。
        win.setBusy(false);
      } else {
        win.hideOverlay();
        win.setBusy(false);
      }
    } else {
      // 排队、提交中、被接管、结束，或者本来就没有页面：前台那一句提示必须跟着
      //   收 —— 否则它会停在上一条会话的那句话上，盖住底下本该露出来的面板。
      win.hideOverlay();
      win.setBusy(false);
    }
  }
}

/**
 * 插件注册表。一个根，一条来路。
 *
 *   `site`  站点池 —— 站点分发的插件落在这里（见 site-plugins.js）。唯一的根。
 *
 * 一个插件都没有是正常状态，不是安装包坏了。
 *   `src/main/plugins/` 那个目录是框架（注册表 + ulid.js + 安装器），不是插件目录，
 *   所以它压根不作为根传进来。
 *
 * 根的集合固定，能变的只有"这次加不加载"（`dir` 是个函数）。所以一次重新
 *   扫描只需要 `registry.reload()`，不重建 Registry —— 重建会清掉 `notices`，
 *   用户会把已经看过的通知重看一遍。
 *
 * 放在模块级是因为它跨会话存活：去重槽（`once`）跟着插件走。
 */
const registry = new plugins.Registry([
  // 传函数而不是路径：cfgDir 要等 app ready 之后才定下来，在这里当场算会算出
  // 一个 null 路径（见 plugins/index.js 的 scanRoot）。
  //
  // 只有一个根。再加一个根（能从本机塞插件进去的那种）就整类绕过同意
  //   闸，而 `packer/docs/PLUGIN-SPEC.md` §5.2 明文写着「禁止给任何一类插件
  //   开免同意的口子」。要多加一个根，先回答 §5.2 那个问题：它上面每一份凭什么
  //   免同意？答不上来就不许加。
  { dir: sitePoolDir, source: 'site' },
], {
  /**
   * 同意闸。每一个插件、每一条来路，没同意过就不加载。
   *
   * 这里没有例外。给某一类插件开免同意（"用户自己刚放进去的，让他同意自己
   *   是空话"）看着无害，代价却是把一条没有分支的规则变成一条有例外的规则，
   *   而 §5.2 紧跟着那句禁令写了理由：「规则一有分支，绕过它的路就会长出来」。
   *
   * 判据是全长摘要（见 config.isTrusted）。这里拿到的是 `inspectDir` 从
   *   磁盘上算出来的那个值，不是站点自报的。
   *
   * `cfg` 在模块加载期还是 null（注册表在那一刻就构造了）—— 那时一个插件都
   *   加载不了。判据收成 fail-closed：读不到台账 = 没同意过。写成
   *   `!cfg ||` 放行的话，这条闸就有了一个缺口 —— 那一刻算出来的路径
   *   （`sitePoolDir()` 依赖 cfgDir，而 cfgDir 那时还是 null）几乎必然不存在，
   *   缺口平时不显形，但它就是缺口。
   */
  allows: (entry) => Boolean(cfg)
    && config.isTrusted(cfg, entry.plugin.id, entry.plugin.version, entry.digest),
  // 插件宿主的四路回调与「还有哪些键有活会话」。
  onHostCall: (plugin, session, member, args) => hostCall(plugin, session, member, args),
  onHostEvent: (plugin, session, kind, text) => { if (win) win.pushNotice(kind, text); },
  onHostLog: (plugin, level, text) => pushPluginLog(plugin, level, text),
  onHostLost: (plugin, err) => hostLost(plugin, err),
  liveKeys: () => livePluginKeys(),
});

/**
 * 池目录 —— 装进来的插件都落在这里。今天只有一条来路：站点分发。
 *
 * `~/.slurmate/plugins` 那个目录不删 —— 升级上来的用户那里可能真的躺着东西。
 *   删用户的文件是另一回事；处理是"不再读它"，并在启动时说一句（见 bootstrap）。
 */
function sitePoolDir() {
  try {
    const home = app.getPath('home');
    // 家目录必须是绝对的。相对的那一个会让池子跟着"当前工作目录"跑 ——
    //   一个对账（后台跑的）落在一个谁也想不到的地方，而且换一次启动目录就
    //   换一处池子。判据与插件 `ctx.home()` 那条同源（那里是拒绝，这里是
    //   "这个根这次不加载"）。
    if (!home || !path.isAbsolute(home)) return null;
    return path.join(home, '.slurmate', 'site-plugins');
  } catch {
    // 拿不到就返回 null，而 null 在那条路上意味着"这个根这次不加载"。
    //   把一个次要功能的失败变成整个客户端起不来不值当。
    return null;
  }
}

/**
 * 说一句：`~/.slurmate/plugins`不再被读了。
 *
 * 只在那个目录真的有东西时说。空目录、或者从来没用过本机池的人，不该看见
 *   一条关于它的通知 —— 那是噪音，而且会让人以为自己做错了什么。
 *
 * 措辞只说事实：那个东西不再生效了、里面的文件还在原处。不许断言"是谁放的、
 *   为什么"，也不许建议"可以删掉" —— 客户端不知道，而且那是用户自己的目录。
 *
 * 这一条是给"从更早的版本升上来"的机器用的兼容外壳：确定没有那种机器之后，
 *   它连同调用点一起删。
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
    return;                                        // 不存在，更没什么好说的
  }
  win && win.pushNotice('info',
    `${dir} 里的插件不再被加载了，客户端现在只认站点分发的插件。`
    + '那个目录没有被动过，里面的文件还在原处。');
}

// ── 测试后端：假站点上那两个目录 ────────────────────────────────────────────
//
// 两处，两个角色，别再合成一个：
//
//   · `siteInstalledDir()` —— 装上去的东西。这才是"站点上有什么"的答案，
//     而它只有一条来的路：测试顺手调 `backend.installPlugins`，与真站点上管理员
//     `slurmate plugin install` 同形。落在临时 userData 里。
//   · `samplePluginsDir()` —— 测试夹具住的地方（`tools/fixtures/plugins/`）。
//     那两棵是两套件共用的夹具，安装包里没有它们 —— 那是对的，不是降级。
//     从源码跑时它们在场。
//
// 这两处只服务测试后端；安装包里既没有假站点，也没有它们。

/**
 * 测试接缝：把夹具那一棵换掉（`null` = 恢复默认）。
 *
 * 用例要造"站上一个插件都没有"的现场（那里放一个空目录），而真机上那意味着
 *   换一棵树 + 重启 —— 一个进程里 index.js 只加载一次。它只动夹具那一处：
 *   装上去的东西在临时 userData 里，用例自己那份本来就是空的。
 */
let sampleDirOverride = null;

/**
 * 测试夹具住的地方 —— 仓库里的 `tools/fixtures/plugins/`。打包版没有它，而那是对的。
 *
 * 传函数而不是路径的地方（backend-fake）看的是每次现算：从源码跑与从安装包
 *   跑是两个事实。返回 `null` = 这个位置不存在（安装包里没有它）。
 */
function samplePluginsDir() {
  if (sampleDirOverride !== null) return sampleDirOverride || null;
  const d = path.join(__dirname, '..', '..', '..', 'tools', 'fixtures', 'plugins');
  try { return fs.statSync(d).isDirectory() ? d : null; } catch { return null; }
}

/**
 * 装上去的东西落在哪 —— 测试后端自己的一处。
 *
 * 目录由 `installPlugins` 自己建（它落东西之前先确保那处存在）。这里只回答
 *   "在哪"：一个还不存在的目录不是错误，而是"这个站点上还没装过东西"。
 */
function siteInstalledDir() {
  try { return path.join(cfgDir || '.', 'site-installed'); } catch { return null; }
}

/**
 * 假站点上作业侧那一处的根 —— 会话文件、作业日志、以及那个假用户的家目录。
 *
 * 与上面那个目录同一条理由：只在测试后端的临时 userData 里。这里面是真的
 *   进程写出来的东西（插件的 `job/start.sh` 在这台机器上真的跑起来），
 *   而不是演出来的账。
 */
function siteJobsDir() {
  try { return path.join(cfgDir || '.', 'site-jobs'); } catch { return null; }
}

/** 暂存根：站点池的兄弟目录（换入用的 `rename` 要求同一个文件系统）。 */
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
 * 让窗口里那块界面与快照一致。幂等，每次状态变化都可以调。
 *
 * 这是框架的事，不是插件的事 —— URL 来自 `contributes.surface.path`，
 *   存储分区来自框架的工作区。这个分工的用处很具体：一个没有客户端代码的
 *   声明式插件照样能开界面，因为开界面本来就不需要代码，只需要一句声明。
 *
 * 判定两件事：url 变没变、partition 变没变。前者只需重新 loadURL；后者必须
 * 销毁重建 —— partition 是构造期属性（见 windows.js 的 showSurface）。
 *
 * 这也是唯一的入口。若让 windows.js 的 pushState 在 origin 变化时自动 loadURL，
 *   那条路不换 partition、也不重跑登录，两条路并存必然分叉。
 */
async function ensureSurface(rec, snap) {
  const plugin = rec.plugin;
  const surface = plugin.contributes.surface;
  if (!surface) return;

  // 分区：由那份数据自己长出来（见 plugin-data.js）。一分数据一份分区 ——
  // 一个工作区里两个不同的插件各有各的一份（所以它们能同时跑），而"这几条连接算
  // 同一个"由用户那张引用表说了算。
  //
  // 分区名由那份数据的身份长出来（见 plugin-data.js），不是一个硬编码的
  //   三元表达式：跨版本共享与否、第三段是什么，都该由作者与用户说，而"加一个
  //   作者写了却没人读的字段"正是这个仓库一路在删的形状。
  const partition = pluginData.partitionOf(
    pluginData.identityOf(plugin, findSpaceAll(snap.spaceId)));

  // 换工作区 = 换那一份数据 = 换分区 = 销毁重建。用户看得见的那件事（编辑器布局
  // 重置了）必须说出来，否则他只会觉得"我的设置莫名其妙没了"。
  //
  // 判据是这一个槽自己的分区，不是"窗口里那一块"的分区 —— 后者在多开下
  //   会拿到别人的分区：该重建的判定成"没变"（页面继续跑在旧分区里，而界面上
  //   完全看不出区别，正是上面那句注释说的那件事），不该重建的被判成"变了"。
  const has = win.hasSurface(rec.slot);
  const rebuilt = has && win.surfacePartition(rec.slot) !== partition;
  // `demo` 这个参数是 windows.js 的：true 时给那块视图注入 `preload/demo.js`，
  // 好把「被外壳吞掉的按键」推回面板（对照用）。只有测试后端才要这份诊断 ——
  // 判据跟着这次会话的后端走（`snap.dev`）。
  await win.showSurface({
    slot: rec.slot, url: snap.origin + surface.path, partition, demo: snap.dev,
    // 本机起的那条才把页面推上来；接上来的那条留在面板上（用户点标签再过去）。
    reveal: !rec.adopted,
  });
  if (rebuilt) {
    win.pushNotice('info', '已切换到新的工作区，页面已重新加载。');
  }
}

/**
 * 递给插件的钥匙工具箱，只有契约 §4.2 的那六个函数。
 *
 * 不是把 `keys.js` 的模块对象直接递出去：那个对象上还有 `_internal`（给本仓库
 *   的用例用的），而插件拿到它就看到了一份没有写进契约的表。这个对象是冻结的，
 *   而且所有会话共用同一个 —— 插件改不动 `generate` 之类的成员。
 */
const PLUGIN_KEYS = Object.freeze({
  generate: keys.generate,
  publicKeyLine: keys.publicKeyLine,
  publicKeyLineFromPrivatePem: keys.publicKeyLineFromPrivatePem,
  isUsablePrivatePem: keys.isUsablePrivatePem,
  fingerprintOf: keys.fingerprintOf,
  isValidPublicKeyLine: keys.isValidPublicKeyLine,
});

/**
 * 递给插件的全部能力。
 *
 * 插件拿到的是这个对象，而不是整个模块作用域。这不是洁癖：它把"一个插件能
 *   碰什么"变成一份看得见的清单，而 Phase 3 的进程隔离就是把这份清单变成一条
 *   IPC 协议。
 *
 * 每次调用都新建一个 —— `cfg` 是会变的（换一条连接就换一份），而插件里的
 *   `await` 可能跨越那个变化。所以 cfg/cfgDir 用 getter 现取，不用快照。
 *
 * `once()` 按插件名分桶：两个插件各记各的"上次值"，共用一个槽会互相冲掉。
 *
 * 参数是那一条会话的记录，不是插件对象 —— 因为这里每一个"我"都必须是这一条
 *   会话的：`session()` 是它的会话视图，`win` 是它那块界面。收 `plugin` 再去读
 *   模块级的"当前会话"的话，失败形态不是崩溃：是 web-demo 拿着另一条会话的
 *   口令去 POST，然后弹一句"控制节点还没返回会话口令"。
 *
 * 插件能用的一切都在这里。它不能 `require` 客户端的源码 —— 插件装在池里
 *   （`~/.slurmate/site-plugins/<id>_<版本>/`），相对路径指不到客户端；就算指得到，
 *   那种依赖也是无法检查的。所以缺什么就在这里加什么，而不是让插件绕过这份清单。
 */
/**
 * 递给插件的那一份上下文（纯数据，可跨进程）。
 *
 * 它不再是一个带活对象的 `ctx`：插件进程只能拿到值，拿不到 Electron 的
 *   session、也拿不到口令。需要往返的两件事（重新加载页面、自动登录）走
 *   宿主的回调通道，见 `hostCall`。
 *
 * 每一项都在每次钩子调用前现算：`cfg` 会变，而插件里的 await 可能跨过那个变化。
 */
function pluginCtxData(rec) {
  return {
    connection: connectionFor(rec),
    session: sessionForPlugin(rec),
    whoami: whoami ? { ...whoami } : null,
    home: homeFor(),
    dataDir: dataDirFor(rec, rec.plugin),
  };
}

/** 这一条会话属于哪条连接（只读副本）。 */
function connectionFor(rec) {
  const c = (cfg.connections || []).find((x) => x.id === rec.connectionId);
  return c ? Object.freeze({
    id: c.id, label: c.label, user: c.user, host: c.host, port: c.port,
  }) : null;
}

/** 会话视图的副本。口令不过进程边界 —— 插件要登录就走 `ctx.login(origin)`。 */
function sessionForPlugin(rec) {
  const s = rec.controller && rec.controller.session;
  if (!s) return null;
  const copy = { ...s };
  delete copy.auth_password;
  return copy;
}

/** 用户家目录。取不到或不是绝对路径时把原因带回去，由插件那边原样抛。 */
function homeFor() {
  try {
    const h = app.getPath('home');
    if (typeof h !== 'string' || !h || !path.isAbsolute(h)) {
      return { ok: false, error: '用户的家目录不是一个绝对路径（' + JSON.stringify(h)
        + '），插件不能用它拼路径。' };
    }
    return { ok: true, value: h };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 这个插件自己的数据目录（绝对路径），同时认领它。
 *
 * 与 `claimDataDir` 共用同一个表达式：分开算会让「护着的」与「交出去的」
 *   漂开，而漂开的症状正是这条判据要防的那件事。
 */
function dataDirFor(rec, plugin) {
  try {
    const root = pluginDataRoot();
    if (!root) {
      return { ok: false, error: '还不知道插件的数据目录该放在哪儿（配置目录还没定下来）。' };
    }
    const name = pluginData.dataDirNameOf(pluginData.identityOf(
      plugin, findSpaceAll(rec.controller && rec.controller.spaceId)));
    if (rec.claims) rec.claims.add(name);
    return { ok: true, value: path.join(root, name) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 宿主回调：只允许两件事，而且都绑在这一条会话上。 */
function hostCall(plugin, session, member, args) {
  const rec = sessions.get(session);
  // 比的是身份，不是对象：`reload()` 会为同一个键建一个新的插件对象，而会话
  //   手里捕获的是它开始那一刻那一个。按对象比会把「装/删了别的插件」误判成
  //   「你这条会话没了」。
  const same = rec && rec.plugin && plugin
    && plugins.bucketOf(rec.plugin) === plugins.bucketOf(plugin);
  if (!same) {
    const e = new Error('这条会话已经结束');
    e.code = 'SESSION_GONE';
    throw e;
  }
  if (member === 'reloadSurface') return reloadSurfaceFor(rec, plugin);
  if (member === 'login') return loginFor(rec, plugin, args && args[0]);
  const e = new Error(`不认识的成员：${member}`);
  e.code = 'BAD_MEMBER';
  throw e;
}

/**
 * 重新加载这一条会话的页面。
 *
 * 有登录契约的插件只在页面还停在登录表单上时才真的重载 —— 它的用途是
 *   "登录之后把页面带回应用"，而 attach 每次状态变化都会被调（心跳 45 秒、
 *   推送 30 秒），无条件重载就是页面每半分钟白一次（2026-10-17 真机）。
 */
async function reloadSurfaceFor(rec, plugin) {
  const contract = plugin.contributes && plugin.contributes.login;
  if (contract && !weblogin.isLoginPath(win.surfaceURL(rec.slot), contract.path)) return;
  await win.reloadSurface(rec.slot);
}

/**
 * 自动登录。口令由主进程自己从会话里取，插件只给 origin。
 *
 * origin 必须是这条会话此刻的 origin：否则插件可以让主进程拿着用户的口令
 *   去 POST 任意地址。
 */
async function loginFor(rec, plugin, origin) {
  if (typeof origin !== 'string' || !origin) return { ok: false, reason: 'bad_origin' };
  let want;
  try { want = new URL(origin).origin; } catch { return { ok: false, reason: 'bad_origin' }; }
  const ses = win.surfaceSession(rec.slot);
  const url = win.surfaceURL(rec.slot);
  if (!ses || !url) return { ok: false, reason: 'no_surface' };
  let now;
  try { now = new URL(url).origin; } catch { return { ok: false, reason: 'no_surface' }; }
  if (now !== want) return { ok: false, reason: 'bad_origin' };
  const password = rec.controller && rec.controller.session
    && rec.controller.session.auth_password;
  return weblogin.webLogin(ses, origin, password, plugin.contributes && plugin.contributes.login);
}

/** 告诉宿主这一条会话结束了：它会收掉这条会话留下的本机资源。 */
function closeHostSession(rec) {
  if (rec && rec.plugin && rec.plugin.host) {
    rec.plugin.host.sessionClosed(String(rec.slot));
  }
}

/**
 * 客户端对外的版本号：两段（可以带发布后缀）。
 *
 * `app.getVersion()` 读的是 `client/package.json` 的 `version`，而那个字段必须
 *   是三段 —— npm 与 electron-builder 都要求语义化版本，写两段会被
 *   `fixVersionField` 当场拒掉，一个安装包都打不出来。它是整套版本号里唯一
 *   绕不过去的三段，而且只是那个包的载体，不是另一个号。
 * 第三段固定是 `.0`（`.github/workflows/checks.yml` 断言这一点）。对用户没有
 *   意义的那个数字带出去，只会让人以为存在一个"补丁级"。
 * 切法与 `client/src/main/plugins/index.js` 的 `hostVersion()` 是同一刀：前两段
 *   就是协议版本。读不到或形状不认识时原样给 —— 不猜。
 */
function wireVersion(v) {
  const s = typeof v === 'string' ? v : '';
  const m = /^(\d+)\.(\d+)\.\d+(-.*)?$/.exec(s);
  return m ? `${m[1]}.${m[2]}${m[3] || ''}` : s;
}

/**
 * 诊断材料。只写"客户端知道什么"，不写凭据、口令与密钥。
 *
 * 排版按"人拿它去贴进一个问题单"来定：一节一段，每条一行，没有 JSON 括号。
 */
function diagnosticsText() {
  const lines = [];
  const raw = (typeof app.getVersion === 'function' && app.getVersion()) || '';
  const ver = wireVersion(raw) || '未知';
  lines.push('# Slurmate 诊断材料', '');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push(`客户端版本：${ver}`);
  lines.push(`平台：${process.platform} ${process.arch}，Node ${process.versions.node}`);
  lines.push('');

  lines.push('## 连接');
  const active = cfg && cfg.activeConnectionId;
  for (const c of (cfg && cfg.connections) || []) {
    lines.push(`- ${c.label || '(无标签)'} ${c.user}@${c.host}:${c.port}`
      + (c.id === active ? '（活跃）' : ''));
  }
  if (!lines.length || lines[lines.length - 1] === '## 连接') lines.push('- （没有保存的连接）');
  lines.push('');

  lines.push('## 插件');
  for (const p of registry.list()) {
    const state = p.active === false ? '未加载' : '已加载';
    lines.push(`- ${p.name} ${p.version} id=${p.id} ${state}`
      + ` 本机入口=${p.hasLocalEntry ? '有' : '无'}`);
  }
  if (!registry.list().length) lines.push('- （本机没有插件）');
  lines.push('');

  lines.push('## 会话');
  for (const v of sessionViews()) {
    const snap = v.snap || {};
    lines.push(`- ${v.slot} ${v.service || '未知服务'} 状态=${snap.state || '未知'}`
      + ` 作业=${snap.jobId || '无'} 端口=${snap.localPort || '无'}`
      + (v.temporary ? ' 临时数据' : ''));
  }
  if (!sessionViews().length) lines.push('- （没有会话）');
  lines.push('');

  lines.push('## 插件宿主日志（最近 200 条）');
  if (!pluginLogs.length) lines.push('- （没有）');
  for (const l of pluginLogs) {
    lines.push(`- ${l.at} ${l.plugin || ''} ${l.level} ${l.text}`);
  }
  return lines.join('\n') + '\n';
}

/** 还有活会话的插件键。退休的宿主靠它判断能不能退出。 */
function livePluginKeys() {
  const out = new Set();
  for (const rec of sessions.values()) {
    if (!rec.plugin || !rec.controller) continue;
    if ([State.ENDED, State.ERROR, State.IDLE, State.RELEASING].includes(rec.controller.state)) continue;
    out.add(plugins.bucketOf(rec.plugin));
  }
  return out;
}

/** 插件宿主退出：作业会话继续跑，插件能力停止；本机会话没有页面可用。 */
function hostLost(plugin, err) {
  if (!plugin) return;
  const key = plugin ? plugins.bucketOf(plugin) : null;
  for (const rec of sessions.values()) {
    if (!rec.plugin || !rec.controller) continue;
    if (key && plugins.bucketOf(rec.plugin) !== key) continue;
    if (rec.controller.isLocal && rec.controller.isLocal()) {
      rec.controller._setState(State.ERROR, { error: '本机插件进程已退出，页面不可用。' });
    } else {
      rec.controller.warning = '插件进程已退出：插件功能停止，会话仍在运行。';
      onSessionChange(rec.slot);
    }
  }
  if (win) {
    win.pushNotice('error', `「${plugin.displayName || plugin.name}」的插件进程已退出；`
      + '它负责的功能停止，会话本身不受影响。');
  }
}

// 插件宿主自己的日志。只留在内存里给诊断材料用（见 app:exportDiagnostics）。
const PLUGIN_LOG_MAX = 200;
const pluginLogs = [];
function pushPluginLog(plugin, level, text) {
  pluginLogs.push({
    at: new Date().toISOString(),
    plugin: plugin ? plugins.bucketOf(plugin) : null,
    level,
    text: String(text || ''),
  });
  if (pluginLogs.length > PLUGIN_LOG_MAX) pluginLogs.splice(0, pluginLogs.length - PLUGIN_LOG_MAX);
}

/**
 * 这个会话的插件我们不认识 —— 站点开了它，而本客户端的注册表里没有。
 *
 * 这里什么都不做，正是要害。那个端口上跑的可能是任何东西，而任何做法都是
 *   系统在声称一件它并不知道的事：拿口令去 POST 一个 SSH 端口，或者给一个 HTTP
 *   端口配主机公钥。用户看到的是莫名其妙的报错，而根因一个字都不在里面。
 *   所以如实说出来，并且只留「结束会话」这一条路。
 *
 * 这一条同时是"站点装了新插件而客户端没跟上"的唯一提示来源 —— 说清楚是
 *   哪种情况，用户才知道该升级客户端还是该找管理员。所以它会把站点那边认得的
 *   名字列出来。
 */
async function warnUnknownService(slot, snap) {
  const key = `unknown|${snap.sessionId}`;
  if (!registry.once('__unknown__', key)) return;

  win.pushNotice('warn',
    `这个会话的服务类型未知（作业 ${snap.jobId || '?'}）：${unknownWhy(slot, snap)}\n`
    + '作业本身是正常的：你可以结束它，或者直接连 127.0.0.1 上看它到底是什么。'
    + '（能结束、能看，是因为状态、心跳和结束这三件事从不查插件，只认会话号。）');
}

/**
 * 「为什么用不了它」，按具体到什么程度从高到低挑一句。
 *
 * 第一档最要紧：站点正在分发的那个插件，本机缺的正是它需要的那一版。
 *   这时能说出"本站的「Jupyter」是 2.0.0 版，本机没有这一版" —— 用户照着升级
 *   客户端就行了。这一档要拿会话自己带的解析键去站点清单里找，而不是泛泛地
 *   列一遍本站有哪些插件。
 *
 * 而会话带的那个键必须是权威：站点会升级，所以"现在再看一眼站点有哪些插件"
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
      return `本站的「${hit.title}」是 ${hit.version} 版，而本机没有这一版，`
        + '升级客户端之后就能用它。';
    }
    const known = registry.list().filter((p) => p.id === id);
    if (known.length) {
      const versions = known.map((p) => p.version).join('、');
      return `这个会话要在 ${ref.slice(at + 1)} 版上跑，而本机只有 ${versions} 版。`
        + '作业侧与客户端侧是配套的两半，不一致就用不了，升级客户端通常就好了。';
    }
    return `这个会话来自一个本机没有的插件（${id}）。`;
  }

  if (missing.length) {
    const names = missing.map((p) => (p.version ? `${p.title} ${p.version} 版` : p.title));
    return `本站开了这个客户端没有的插件：${names.join('、')}。升级客户端之后就能用它。`;
  }
  // 最后才用解析那一刻留下的说法（它只有 id，没有标题）。
  // 取的是这一条会话的说法：多开时读那个全局的会把根因说成别人的。
  const rec = sessions.get(slot);
  if (rec && rec.pluginWhy) return `${rec.pluginWhy}。`;
  return '它多半是其他进程提交的，控制节点没有关于它的记录。';
}


// ── 关闭 ────────────────────────────────────────────────────────────────────
/**
 * 把所有会话停掉。返回 `[{slot, sessionId, res}]`，顺序与表里一致。
 *
 * 只此一份实现，三条路都走它：关窗收尾、退出前、主动断开。它们要做的是
 *    同一件事 —— 每一条会话都发 goodbye。各写一遍的代价已经在变异验证里
 *    现过一次形：同一个循环出现在两个地方时，改一处、另一处静默地少停一条，而
 *    用户看到的是"关掉窗口会结束会话"，集群上却还烧着一个作业（与账本 F13
 *    同一类：说了一句话，而它不成立）。
 *
 * 不跳过没有 sessionId 的那些：正在提交（还没有会话号）的那一条也要停 ——
 *   `SessionController.stop()` 自己分得清该发什么。跳过它的话，一次"提交中就关窗"
 *   会留下一个客户端已经不管、而控制节点上正在长大的会话。
 */
async function stopAllSessions() {
  const out = [];
  for (const rec of [...sessions.values()]) {
    const c = rec.controller;
    if (!c) continue;
    // 被接管的会话一条都不停。它们不归这台电脑管了，而这里的每一次
    //    `stop()` 都会给守护进程发 `goodbye` —— 那会把用户的作业 scancel 掉，
    //    而用户以为自己只是「换个地方看」。
    //    （`SessionController.stop()` 顶上还有同一道闸，这里再判一次是为了
    //     不产生一条误导的报错：它现在回的是 `ok:false`，而 `shutdown()`
    //     会把它当成失败推到界面上。）
    if (!c.watching) continue;
    out.push({ slot: rec.slot, sessionId: c.sessionId, res: await c.stop() });
  }
  // 临时那一份的后备回收。正常路径是 `_renderSession` 里那一处（会话走到终态
  //    时回收），但那一条依赖事件循环继续跑 —— 而 `before-quit` 那条路紧接着就是
  //    `app.exit(0)`，等不到。
  //
  //    与 `_renderSession` 那一处不是重复：`releaseEphemeral` 用 `Map.delete`
  //      当旗子，第二次调用是 no-op（见它的注释）。这里多一次调用换的是"进程退出
  //      这条路上也一定收干净"，而代价是零。
  //    遍历一份拷贝：`releaseEphemeral` 会改 `tempSpaces`。
  for (const id of [...tempSpaces.keys()]) releaseEphemeral(id);
  return out;
}

/**
 * 拆掉与这个站点的连接 —— 【断开】与【临时离开】共用的那一半。
 *
 * 它只做连接级的收尾：关后端、清掉"这一次连接"的现场。一条会话都不碰 ——
 *   会话怎么收由调用方在进来之前定：断开时每条一条 `goodbye`，临时离开时一个
 *   字节都不发（`abandon()`）。那两件事的差别是这一版最重的一条（见 `app:leave`）。
 *
 * 收成一份的理由与 `stopAllSessions` 逐字相同：两处各写一遍的话，下一次加了
 *   一样"连接级"的东西（比如再来一份暂存树），改了一处、另一处静默地少做一步，
 *   而症状是"临时离开之后再连回来，界面上还挂着上一个站点的东西"—— 一句指不回
 *   根因的话，因为两边都"看起来对"。
 */
/**
 * 问一次站点现状，然后喂给两个读者（左栏那个圆点、浮窗那一块）。
 *
 * 成功也覆盖，失败也覆盖：失败时把 `data` 清成 `null` 并留下 `error`
 *   —— 留着上一次那份"一切正常"是最坏的一种：圆点继续绿着，而它基于的是一次
 *   五分钟前的成功查询。三态里"获取失败"是一个要显示出来的状态，不是"保留旧值"。
 */
/**
 * 用户正要去看那块面板的时候，补一次。
 *
 * 轮询是 30 秒一拍，所以打开浮窗时手上那一份最多可能是 29 秒前的 —— 而他要看的
 *   正是"现在怎么样"。但不能每次停靠都问：鼠标沿着边栏扫过去会连着触发好几次，
 *   那就是把 30 秒一拍的轮询变成了一次连发。所以只在上一次取数超过
 *   `SITE_STALE_MS` 时补。
 */
const SITE_STALE_MS = 5000;

function refreshSiteIfStale() {
  if (Date.now() - site.at < SITE_STALE_MS) return;
  refreshSite();
}

async function refreshSite() {
  if (!backend || !backend.connected) return;
  // 一次只飞一个。两个触发点是真的会撞上的：连上那一刻 `startSitePoll`
  //   先问一次，而同一秒里后端的 `state` 事件（"连上了"）也会补一次。两次并发
  //   的 `op_cluster` 不产生错误，只是白花一个来回，而"白花一个来回"在退化成
  //   exec 的通道上是一次 sshd fork。
  if (siteFetching) return;
  siteFetching = true;
  // 整段包在 try/finally 里，只在 finally 里放旗子。中间任何一步抛出
  //    （`withGresCatalogLabels` 就在这一段的半路上），旗子会永远立着 ——
  //    而它的症状是"那个圆点从此不再更新"，一个不报错、不崩溃、只是慢慢变成
  //    一句假话的失败。轮询还在跑，只是每次都从这一句早返回出去。
  try {
    let resp = null;
    try {
      resp = await backend.rpc({ op: 'cluster' });
    } catch (e) {
      resp = { ok: false, error: { detail: (e && e.message) || '没有回应' } };
    }
    if (resp && resp.ok && resp.data) {
      // GRES 那一格要经过客户端唯一的那处拼法（`gres.js` 的 `gresLabel`），
      // 与 `loadPartitions()` 走同一条路 —— 少这一步，同一个分区在表单里显示
      // `gpu:a6000 ×4`、在浮窗里显示 `gpu ×4`。
      withGresCatalogLabels(resp.data.gres);
      site = { data: resp.data, error: null, at: Date.now() };
    } else {
      site = {
        data: null,
        error: (resp && resp.error && resp.error.detail) || '控制节点没有说明原因',
        at: Date.now(),
      };
    }
  } finally {
    siteFetching = false;
  }
  pushSiteDot();
  if (win && win.hoverOpenSide() === 'left') pushSiteToHover('left');
}

/**
 * 把站点现状推给浮窗。只在左边那一块开着的时候 —— 没有读者的时候推过去
 * 只是在两个进程之间搬字节。
 *
 * 链路那一份每次一起带上：它在浮窗里是独立的一行，而且它变的原因
 *   （掉线）与站点那一份变的原因（慢钟到点）毫无关系。
 */
function pushSiteToHover(side) {
  if (!win || side !== 'left') return;
  win.pushHoverData({
    side: 'left',
    cluster: site.data,
    clusterError: site.error,
    link: hoverLink(),
  });
}

/**
 * 链路那一份给浮窗看的样子。
 *
 * 「最近一次心跳多久以前」取自前台那一条会话的快照 —— 心跳是逐会话的，
 *   而这个界面同时只连一个站点、能看见的也只有前台那一条。没有会话时它是
 *   `null`（而不是 0）：`null` 说的是"没有心跳可谈"，`0` 说的是"刚刚跳过一次"。
 */
function hoverLink() {
  const slot = frontSlot();
  const rec = slot ? sessions.get(slot) : null;
  const snap = rec && rec.controller ? rec.controller.snapshot() : null;
  return {
    connected: Boolean(link.connected),
    detail: link.detail,
    hbAgeMs: snap ? snap.hbAgeMs : null,
  };
}

// ── 右栏：作业输出 ──────────────────────────────────────────────────────────
//
// 间隔跟着通道形态走，判据与 `sitePollMs()` 逐字相同（`backend.resident`）：
//    常驻通道健康时 1.5 秒；退化成 exec 时 10 秒。1.5 秒一次 exec 不是"实时"，
//    那是每 1.5 秒 fork 一个 python —— 会话里那条 `status` 从 30s 提到 60s 正是
//    为同一件事。
//
// 它只在右栏开着的时候跑（`win.hoverOpenSide() === 'right'`）。没有读者的时候
//   轮询只是在两个进程之间搬字节，还白花一次 RPC。
//
// 「作业一结束右栏就收了」那条规矩的落点在这里：定时器自己发现前台那条不再活着，
//   停掉并把最后取回的那一段留在 `out.data` 里（作业屏按需再取一次走的是同一条 op，
//   见 `app:jobLog`）。
const OUT_POLL_MS = 1500;
const OUT_POLL_EXEC_MS = 10000;
const OUT_LINES = 200;
const OUT_LINES_MORE = 2000;
const OUT_STALE_MS = 5000;
let out = { slot: null, data: null, error: null, unsupported: false, at: 0 };
let outTimer = null;
let outFetching = false;
let outLines = OUT_LINES;

function outPollMs() {
  return backend && backend.resident === true ? OUT_POLL_MS : OUT_POLL_EXEC_MS;
}

/** 前台那一条的会话记录（没有会话时 null）。 */
function frontRec() {
  const slot = frontSlot();
  return slot ? (sessions.get(slot) || null) : null;
}

async function refreshOut() {
  const slot = frontSlot();
  const rec = slot ? sessions.get(slot) : null;
  const c = rec && rec.controller;
  if (!c) {
    out = { slot, data: null, error: null, unsupported: false, at: Date.now() };
    pushOutToHover();
    return;
  }
  // 本机会话没有作业，也就没有作业日志。不发那条 RPC（它会回「还没有登记」）。
  if (typeof c.isLocal === 'function' && c.isLocal()) {
    out = { slot, data: null, error: '本机会话没有作业日志', unsupported: true,
            at: Date.now() };
    pushOutToHover();
    return;
  }
  // 一次只飞一个：1.5 秒一拍，而一次 RPC 完全可能比一拍还慢（退化成 exec 时
  //   尤其如此）。并发两次的结果是"后回来的可能是更旧的一份"，而它们写的还是
  //   同一个 `out`。
  if (outFetching) return;
  outFetching = true;
  try {
    const r = await c.jobLog(outLines);
    out = {
      slot,
      data: r.ok ? r.data : null,
      error: r.ok ? null : (r.error || '没有说明原因'),
      unsupported: Boolean(r.unsupported),
      at: Date.now(),
    };
  } finally {
    outFetching = false;
  }
  pushOutToHover();
}

/** 把右栏要的那一份推给浮窗。只在右边那一块开着的时候 —— 没有读者。 */
function pushOutToHover() {
  if (!win || win.hoverOpenSide() !== 'right') return;
  win.pushHoverData({
    side: 'right',
    out: out.data,
    outError: out.error,
    outUnsupported: out.unsupported,
    outLines,
    // 前台那一条的作业号与状态 —— 右栏的标题要能说出"这是哪一份作业"。
    outJobId: (frontRec() || {}).controller
      ? (frontRec().controller.snapshot().jobId || null) : null,
  });
}

function startOutPoll() {
  stopOutPoll();
  outLines = OUT_LINES;
  refreshOut();
  outTimer = setInterval(() => {
    // 两个"该停了"的判据都在这里，而不是靠别处记得来停一次：
    //   · 右栏收起来了（浮窗收起走的是窗口那一层，主进程拿不到回调）
    //   · 前台那条不再活着（作业结束了 —— 右栏那时没有内容可说）
    if (!win || win.hoverOpenSide() !== 'right' || !occupied(frontSlot())) {
      stopOutPoll();
      return;
    }
    refreshOut();
  }, outPollMs());
  if (outTimer.unref) outTimer.unref();
}

function stopOutPoll() {
  if (outTimer) { clearInterval(outTimer); outTimer = null; }
  out = { slot: null, data: null, error: null, unsupported: false, at: 0 };
  outLines = OUT_LINES;
}

/** 用户按了「更多」：把行数提到上限再拉一次。 */
async function outMore() {
  outLines = OUT_LINES_MORE;
  await refreshOut();
  return { ok: true, lines: outLines };
}

/**
 * 左栏那个圆点该是什么颜色。不显示、不弹窗、不写日志 —— 它是状态，不是提示。
 *
 * 四态，而它们不是两两可以合并的：
 *
 *   `bad`  链路断了 —— 此刻的事实，而且是用户唯一能自己动手查的一件事
 *   `bad`  链路活着，而控制器明确连不上 —— 也是"确实有事"
 *   `na`   获取失败（整份失败，或控制器那一格缺席）—— 我们没问到
 *   `ok`   其余
 *
 * 控制器那一格缺席要判 `na`，不能判 `ok`。这是这一格最容易犯的错，
 *   也是用例抓出来的：守护进程答了话（`ok:true`）、其余格子都在、只有 `health`
 *   不在的时候，一个只看"有没有 data"的判据会亮绿灯 —— 而用户看到的是一颗
 *   安稳的绿点加一屏"获取失败：控制器状态"。那颗点说的是"站点现在怎么样"，
 *   而"我们不知道控制器在不在"不是"好"。
 *
 * 判据的次序是刻意的：链路先说话（它是此刻的事实），链路活着才轮到
 *   集群那一份。
 */
function siteDotState() {
  if (!link.connected) return 'bad';
  if (site.error) return 'na';
  if (!site.data) return 'na';
  const h = site.data.health;
  if (!h) return 'na';
  return h.up ? 'ok' : 'bad';
}

function pushSiteDot() {
  if (!win) return;
  win.pushSite({ state: siteDotState() });
}

function startSitePoll() {
  stopSitePoll();
  refreshSite();
  siteTimer = setInterval(() => {
    if (!backend || !backend.connected) { stopSitePoll(); return; }
    refreshSite();
  }, sitePollMs());
  if (siteTimer.unref) siteTimer.unref();
}

function stopSitePoll() {
  if (siteTimer) { clearInterval(siteTimer); siteTimer = null; }
  site = { data: null, error: null, at: 0 };
  pushSiteDot();
}

async function teardownConnection() {
  if (win) win.closeAllSurfaces();
  // 页面与提示页一起收。离开站点之后那几条隧道都拆了，页面再也不会被看见；
  //   留着它们只是白养 renderer 进程，而提示页会盖住回来的第一屏
  //   （用户 2026-10-21 报的"什么也点不了"）。三条路共用这里：临时离开、
  //   断开、空手超时。
  stopSitePoll();
  stopOutPoll();
  // 离开/断开之后既没有要保活的会话，也没有"空手"可计 —— 两样都从零开始。
  disarmEmptyHands();
  stopKeepAlive();
  await backend.close();
  whoami = null;
  connectedConnId = null;   // 与 whoami 同生共死，理由见它的声明处
  partitions = [];
  // 断开之后就没有「站点开了哪些插件」可谈了
  sitePlugins = null;
  // 待同意的那些是这一次连接的现场：换代 + 丢掉它们的暂存树（那是我们
  // 自己的草稿纸，删它不算"删站点的东西"）。不清的话，用户会看到一个来自
  // 已经断掉的站点的"同意"按钮。
  //
  // `existing` 的那些一个字节都不许动：它们指向的是池里那一份，
  //   不是草稿。断开一次就把它删掉，等于"断个网就丢了用户已经同意的插件"。
  connectGeneration += 1;
  for (const p of pendingConsent) {
    if (!p.existing) sitePluginSync.discardStaged(p.stagedDir);
  }
  pendingConsent = [];
  siteSync = null;
  versionVerdict = null;    // 连接级的结论，连着的那条没了它就不再成立
  connectedDaemonVersion = null;
  connectedDaemonCaps = null;
}

/**
 * 离开这个站点：本机手上那些记录一条都不留，然后拆掉连接。
 *
 * 走 `abandon()` 而不是 `stop()` —— 后者会发 `goodbye`，而 `goodbye` 会让守护
 *   进程 `scancel` 作业。这一步要的恰恰相反：用户只是从这个站点走开
 *   （回列表，或者换一个站点），不是要取消那些作业。
 *
 * 两个调用点共用这一份：`app:leave`（【临时离开】）与 `app:connect` 的
 *   「换一条连接」。两边都是本机收尾，服务端那一格一个字都不动。各写一遍的话，下一次
 *   加一样"本机这一侧"的东西（比如再来一份暂存树）就会漏掉一处，而症状是
 *   "换到另一个站点之后，界面上还挂着上一个站点的东西"。
 *
 * 判据是记录（`sessions` 那张表），不是"有没有活着的会话"：已经结束的
 *   那些记录也带着上一个站点的 `session_id`，留着它们，下一次心跳或 `goodbye`
 *   就会拿旧站点的号去打新站点的守护进程 —— 而那是各自编的号，撞上了就是一次
 *   打在别人作业上的 `scancel`。
 *
 * 而临时实例（多开时那条第二份）不回收 —— 这里与 `stopAllSessions`
 *   的最后那一步故意不一样。那边收尾时那些会话真的结束了，所以那份副本的
 *   使命也完了；这边作业还在集群上跑，用户随时可能连回来接着看，
 *   而那份副本里装着他的编辑器布局、打开的标签页、登录状态。
 * "走开"这个动作的全部意思就是什么都别动 —— 顺手删掉一份数据，
 *     正是它要避免的那件事：用户回来时东西没了，而他以为自己只是走开一会。
 *     与 `abandon()` 的另外两处调用（`tryReattach`、模拟重启）同一条取舍。
 */
async function leaveSite() {
  await forgetSessions();
  await teardownConnection();
}

/**
 * 把本机手上那些会话记录一条不留地摘掉（一个字都不发给服务端）。
 *
 * 【临时离开】与【断开】都要做这一件事，而【断开】从前漏了它：断开之后那些
 *   记录还带着这个站点的 `session_id`（状态停在 `releasing`，因为 `stop()`
 *   停掉了一切定时器）。下一次连接时 `tryReattach` 不会接它们（站点那边已经
 *   终态），但 `jobsView` 仍按 `session_id` 把它们认成「本机接着的」——
 *   于是作业列表里点一条早就结束的作业，前台会被切成那个死掉的记录，
 *   状态条显示「正在释放…」（2026-10-17 真机）。
 *
 * 跨站点那一半更重：各站点的守护进程各自编号，旧号发给新站点就是一次打在
 *   别人作业上的 `scancel`（见 `leaveSite` 的那段说明）。
 */
async function forgetSessions() {
  for (const [slot, rec] of [...sessions.entries()]) {
    // 本机会话不会经过 `_renderSession`（它马上退出循环），所以视图、插件运行时
    //   与临时数据要在这里收。次序与别处相同：销毁视图 → dispose → 回收数据；
    //   反过来会让 `livePartitions()` 还看得见那个分区，清理被静默跳过。
    const local = Boolean(rec.controller && rec.controller.isLocal());
    if (local) win.destroySurface(slot);
    if (rec.controller) await rec.controller.abandon();
    if (local) releaseEphemeral(rec.controller.spaceId);
    closeHostSession(rec);
    sessions.delete(slot);
  }
}

/**
 * 关窗 = 结束会话并释放资源。
 *
 * 没有「保留作业」这条分支 —— 见 session.js 的 stop()：真正需要保住作业的
 * 是「客户端没能说上话」那种情况（断电、睡眠、网线被拔），而那些情况下这里的
 * 代码根本不会被执行到。能给这条分支投票的只有用户的主动点击，于是它只会误伤。
 */
/**
 * 收尾：结束会话（如果还在跑）+ 拆掉后端。
 *
 * 关窗口与「立即重启」都走这里，不各写一份。「关掉窗口同样会结束会话」是
 *   给用户的承诺，而重启是同一个承诺的另一种说法 —— 两处各写一遍的话，下一次
 *   改了一处，另一处会静默地不同（比如少了那句 `addPendingGoodbye`）。
 */
async function shutdown() {
  win.setBusy(false);
  try {
    // 走唯一那份实现（见 `stopAllSessions`）。
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
    // 不写服务名：崩掉的是框架建的那块视图，它加载谁的页面取决于当前这个
    //   会话是哪个插件 —— 对着一个 Jupyter 会话说"web-demo 页面崩溃了"，
    //   用户会去查一个跟这件事无关的东西。
    win.pushNotice('error',
      `会话页面崩溃了（${payload && payload.reason}）。可以点「重新加载」恢复。`);
  }
}

// ── 重新接管上次的会话 ──────────────────────────────────────────────────────

/** 一句话说清一条失败的应答。`rate_limited` 单独译，因为它的 `detail` 是空的。 */
function whyOf(resp) {
  const e = resp && resp.error;
  if (!e) return '控制节点没有说明原因';
  if (e.detail) return e.detail;
  if (e.kind === 'rate_limited') return '站点的限流拒绝了这一次请求（连上这一刻的请求过多）';
  return e.kind ? `控制节点回了 ${e.kind}` : '控制节点没有说明原因';
}

/**
 * 发一条 RPC，撞上站点限流时等一拍再试。
 *
 * 连上站点那一刻是一次突发：握手、分区、插件清单、站点插件对账、站点现状、
 *   会话列表 —— 而守护进程的限流桶是"按 uid、1 秒滑窗"（`max_rpc_per_second`）。
 *   桶被打满时，`list` 过了、紧跟着的 `status` 被回 `rate_limited`，正是边界上
 *   最典型的样子。2026-10-18 真机：客户端安静地跳过那条会话，界面上只剩
 *   「发现一个还没结束的会话，正在重新接上」与一行「本机没接着它」——
 *   用户再连一次，还是看不到任何原因。
 *
 * 桶只按 1 秒计数，等一拍就够。三次都不行才把那条错误带出去（由调用方说话）。
 */
async function rpcAfterRateLimit(req) {
  // 等待的挡位只有一处（`site-plugins.js` 的 `RATE_BACKOFF_MS` 与那段说明）。
  //   两个调用点各写一份，下次调这个数就会漂开。
  return sitePluginSync.rpcWithBackoff((r) => backend.rpc(r), req);
}

/**
 * 保活：替那些「看护者不是本机」的会话续命，但不当家。
 *
 * 它发的就是普通心跳。看护者为空时服务端刷新 `last_hb_socket`；
 *   看护者是别人时回 `ignored` —— 那不是错误，是"还没轮到本机"，照收。
 *   两种回包都不报给用户：这是后台的一拍，不是一次操作。
 *
 * 失败也不报：与心跳那条路同一条取舍（闪断时继续重试，绝不放弃）。
 */
function startKeepAlive() {
  if (keepAliveTimer) return;
  const beat = async () => {
    if (!backend.connected) return;
    for (const sid of [...keepAliveSids]) {
      // 一条会话在两次心跳之间被用户接管、或者被另一条路结束了：
      //   集合只在这里被读，删它的是 takeover / teardown。
      if (!keepAliveSids.has(sid)) continue;
      await rpcAfterRateLimit({ op: 'heartbeat', session_id: sid });
    }
  };
  keepAliveTimer = setInterval(() => { beat(); }, HEARTBEAT_MS);
  keepAliveTimer.unref?.();
  beat();                            // 立刻打一拍，别等 45 秒
}

function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  keepAliveSids = new Set();
}

/**
 * 空手连接能挂多久：手里一条会话的控制权都没有时，到点就断开。
 *
 * 十分钟够用户看清这个站点上有哪些插件、哪些作业，并决定要不要接管。
 *   比 `suspect_after`（300 秒）长、比 `orphan_after`（1800 秒）短一半 ——
 *   它要保证的是"挂保活"这件事有尽头，而不是催用户。
 */
const EMPTY_HANDS_MS = 10 * 60 * 1000;
/** 用例要把它调小才测得到（见 `_test.setEmptyHandsMs`）；生产路径永远是上面那个。 */
let emptyHandsMs = EMPTY_HANDS_MS;
let emptyHandsTimer = null;

/** 手里有没有任何一条会话的控制权：本机提交的、或者接管回来的。 */
function hasControl() {
  for (const [slot, rec] of sessions) {
    if (rec && rec.controller && occupied(slot)) return true;
  }
  return false;
}

function disarmEmptyHands() {
  if (emptyHandsTimer) { clearTimeout(emptyHandsTimer); emptyHandsTimer = null; }
}

function armEmptyHands() {
  if (emptyHandsTimer) return;
  emptyHandsTimer = setTimeout(() => {
    emptyHandsTimer = null;
    if (!backend.connected || hasControl()) return;
    closeEmptyHandsSite().catch((e) => {
      if (win) win.pushNotice('error', '空手超时断开时出错：' + ((e && e.message) || e));
    });
  }, emptyHandsMs);
  emptyHandsTimer.unref?.();
}

/**
 * 空手超时：断开这个站点，什么都不取消。
 *
 * 保活集合里的那些本来就不归本机管 —— `forgetSessions()` 一个字都不发给
 *   服务端（它是 `abandon()`），所以这条路上没有 `goodbye`、没有 `scancel`。
 *   断开之后那条作业重新进入"没人看着它"的倒计时，而这正是用户要的：
 *   客户端不能靠一直开着替它续命。
 */
/**
 * 站点上没有本系统的命令（被卸载、或没装好）：这条路不会自己好。
 *
 * 与空手超时同一条收尾 —— 忘掉会话、关掉页面、回连接屏。
 * 不先问用户：站点已经不在，页面即使还能打开也不再受任何东西管理；
 *   文案里说清「作业可能还在跑」，那是他能据此决定下一步的唯一事实。
 */
async function handleSiteGone(reason) {
  stopKeepAlive();
  await forgetSessions();
  await teardownConnection();
  const text = reason + '作业可能还在跑，本机已经不能再管理它们。';
  if (win) {
    win.pushNotice('error', text);
    win.pushSiteClosed({ reason: text });
  }
}

async function closeEmptyHandsSite() {
  stopKeepAlive();
  const reason = '这个站点上没有一条会话由本机看护，已自动断开。'
    + '要接着看护某一条，请在作业页点「接管」。';
  await forgetSessions();
  await teardownConnection();
  win.pushNotice('info', reason);
  win.pushSiteClosed({ reason });
}

/**
 * 用户点了一次连接之后，把这个站点上还没结束的会话接回本机。
 *
 * 先 `list` 筛出还占着位置的那些，再逐个用 `status` 取完整视图 —— 两次都走
 * `rpcAfterRateLimit`，因为连上那一刻正是一次突发（见那个函数的说明）。
 * 这正是「仅关闭窗口，保持作业运行」那条路的意义所在。
 */
async function tryReattach() {
  // 「有没有连上」问后端，不去猜它的私有字段叫什么 —— 去猜（`backend._conn` 之类）
  // 的话，假后端用的是另一个内部名字，这一行会在它上面恒为真地提前返回，让整条
  // 「接上已有会话」的路在唯一能测它的地方完全不可达；而「上次没关干净的会话」
  // 恰恰是假后端存在的理由（真机上要造出这个状态极难）。
  if (!backend.connected) return;

  // 先摘掉被接管的那些记录，再接手（临时离开的那些在 `app:leave` 里
  //   就已经摘掉了，走不到这里）。
  //
  //   不摘的话接手会直接失败：那些记录仍然占着槽（`occupied()` 看的是
  //   controller 的 state，而它们停在 RUNNING），于是 `reattachOne` 会报
  //   「控制节点上还有一个会话与已经接上的占着同一个位置，没法同时接上」——
  //   用户点了「连接」、看着它连上了，却一条会话都接不回来。
  //
  //   摘的动作是 `abandon()`（一个字都不发给服务端），而不是 `stop()`：
  //     这些会话在服务端还活着，只是不归这台电脑管了。发 `goodbye` 就是 scancel。
  //     `abandon` 与 `stop` 的差别在这里是承重的，不是风格问题。
  //
  //   修隧道也在这一步（`abandon` 拆隧道）。所以它必须在确认连上了之后做：
  //     用户从被接管到点「连接」之间，可能一直开着那个页面在用 —— 提前拆掉等于
  //     把"换个地方看"变成"这边的东西全没了"。
  for (const [slot, rec] of [...sessions.entries()]) {
    const c = rec.controller;
    if (!c || !c.suspended) continue;
    await c.abandon();
    closeHostSession(rec);
    sessions.delete(slot);
  }

  // 先把上次没发出去的 goodbye 补上
  for (const item of config.listPendingGoodbye(cfgDir)) {
    const resp = await backend.rpc({ op: 'goodbye', session_id: item.session_id });
    if (resp && (resp.ok || (resp.error && resp.error.kind === 'not_found'))) {
      config.removePendingGoodbye(cfgDir, item.session_id);
    }
  }

  // 用 `list`，不是不带 session_id 的 `status`。
  //
  //   那一版 `status` 只返回最新那一条占着位置的会话。多开之后那意味着：
  //   重连只接得回一个，其余的在控制节点上继续跑而客户端不知道 —— 没有心跳
  //   300 秒 `suspect`、1800 秒 `orphaned` + `scancel`。那是用户的作业被悄悄
  //   杀掉，而界面上一个字都不会有。这一条路径是"多开"这个改动自己让它变成
  //   可达的。
  //
  //   `list` 返回该 uid 最近 50 条会话，`with_secret=False` —— 所以它只够筛出
  //   "还占着位置"的那几条；它们的完整视图（含自动登录要的口令）再逐个用带
  //   `session_id` 的 `status` 取，而那一个默认 `with_secret=True`。
  //   用现成的两条路，不为了这件事去改协议。
  const listed = await rpcAfterRateLimit({ op: 'list' });
  if (!listed || !listed.ok) {
    // 读不到列表时同样不许安静地返回：这条路径跑在"用户刚点完连接"那一刻，
    //   而它的失败形态与"这个站点上没有我的会话"逐字相同 —— 用户看到的是一个
    //   空荡荡的作业列表，而他的作业还在集群上跑着。
    win.pushNotice('error', '未能读到这个站点上的会话列表：'
      + whyOf(listed) + '。作业不受影响；再连一次这个站点会重试。');
    return;
  }
  // `releasing` 不算要接回来的那一档：它已经在拆了，接回来既没有可看的页面，
  //   也没有可做的动作（`reattachOne` 会把它当成 RUNNING 重新起一条隧道）。
  //   断开之后立刻重连时最常见的正是它 —— 上一轮刚发出去的 `goodbye` 还没走完。
  //   守护进程会把这一步走完；这期间若再提交，用户拿到的是站点那句准确的配额错误。
  const live = ((listed.data && listed.data.sessions) || [])
    .filter((r) => r && SERVER_LIVE_STATES.includes(r.state)
      && r.state !== 'releasing');
  if (!live.length) return;            // 没有活跃会话，正常路径

  // 本机已经接着的那些，一条都不再接。
  //
  //   它必须在这儿：`tryReattach()` 的触发点是用户点的那一次连接（见
  //   doConnect），而"点连接"完全可能发生在本机手上已经有会话的时候（换一条
  //   连接再换回来、连着的时候又点了一次）。少了这一句，那些会话会被再接一遍，
  //   而接第二遍的后果不是"重复显示"——
  //   `reattachOne` 里认领实例那一步看到基础槽已被占，会给它发一个临时实例
  //   （另一个工作区、另一个端口、另一份存储），于是同一个 `session_id` 上挂着两个
  //   controller、两条心跳，界面上的标签多出来一条，而两边看起来都对。
  //
  //   判据用 `sessionId`（服务端的身份），不用槽：槽是本机的事实，而"这一条
  //   我已经在管了"问的正是服务端那一条的身份。
  const have = new Set();
  for (const rec of sessions.values()) {
    if (rec.controller && rec.controller.sessionId) have.add(rec.controller.sessionId);
  }
  const fresh = live.filter((r) => !have.has(r.session_id));
  if (!fresh.length) return;           // 全都已经在手上了，正常路径

  // ── 只有看护者是本机的那几条要接回来 ──
  //
  // 其余两档都不接（用户 2026-10-20 拍板）：
  //   · 看护者是另一台电脑：接了也只会被回 `ignored`，而页面与标签已经出现；
  //   · 看护者为空：用户要的是「只保活、不自动当家」，要接手得点「接管」。
  // 两档都进保活集合 —— 别人在看时这一拍被回 `ignored`，等它一走就自动接上。
  const me = clientIdentity && clientIdentity.id;
  const mine = fresh.filter((r) => me && r.keeper === me);
  const nextKeep = new Set();
  for (const r of fresh) if (!mine.includes(r)) nextKeep.add(r.session_id);
  keepAliveSids = nextKeep;
  if (keepAliveSids.size) startKeepAlive(); else stopKeepAlive();

  if (!mine.length) {
    win.pushNotice('info', keepAliveSids.size > 1
      ? `站点上还有 ${keepAliveSids.size} 个会话，看护者不是本机：只替它们保活，`
        + '不接回来。要接手其中一条，到「作业」页点「接管」。'
      : '站点上还有一个会话，看护者不是本机：只替它保活，不接回来。'
        + '要接手，到「作业」页点「接管」。');
    return;
  }

  win.pushNotice('info', mine.length > 1
    ? `发现 ${mine.length} 个还没结束的会话，正在逐个接上。`
    : '发现一个还没结束的会话，正在重新接上。');

  for (const row of mine) {
    const one = await rpcAfterRateLimit({ op: 'status', session_id: row.session_id });
    // 读不到完整视图时不许安静地跳过去。
    //
    //   `list` 那一行只够筛出"还占着位置"的那些，接回一条会话要用的是 `status`
    //   带口令的那一份。静默跳过之后，界面上就只剩一句"发现一个还没结束的会话，
    //   正在重新接上"和一行"本机没接着它"—— 用户会以为再连一次就会好，
    //   而真正的原因一个字都不会出现（2026-10-18 真机）。
    //
    //   不把这次连接判成失败：连接是好的，那条会话也还在集群上跑着。
    if (!one || !one.ok) {
      win.pushNotice('error', `接上会话 ${row.session_id} 之前没读到它的完整信息：`
        + whyOf(one) + '。作业仍在集群上运行；再连一次这个站点会重试。');
      continue;
    }
    const view = one.data && one.data.session;
    if (!view) {
      win.pushNotice('error', `接上会话 ${row.session_id} 之前，控制节点没有给出它的视图。`
        + '作业仍在集群上运行；再连一次这个站点会重试。');
      continue;
    }
    await reattachOne(view);
  }
}

/**
 * 接上一条会话。
 *
 * @param {object} s 带 `session_id` 的完整会话视图（含口令，见 `tryReattach`）
 */
async function reattachOne(s) {
  // 用注册表归一，而不是在会话对象上直接判。三种输入三种答案，理由见
  //   plugins/index.js 的 resolve()：`<id>@<版本>` 查池；服务端没说是哪一种
  //   服务（`null`，或这个键根本不存在）时绝不猜。
  //
  //   `why` 是"明确要某一版而它不在"时的一句人话，一路带到 warnUnknownService ——
  //   在这里重新推一遍是不行的，站点会升级，那时的站点清单已经和这个会话提交时
  //   不是一回事了。
  const { plugin, why } = registry.resolve(s.service_kind, s.service_plugin);

  // 认不出的插件照样要把隧道接起来，这一条是承重的。
  //
  //   不接的话：服务端明明有一个会话在跑（占着那个名额，于是"单一启动"会拒绝
  //   下一次提交），而客户端表现得像什么都没有 —— 用户既看不到它、也不知道为什么
  //   下一个起不来。接起来之后他至少有一条出路：直接连 127.0.0.1:端口 看看那
  //   到底是什么，或者把它结束掉。
  //
  //   而"客户端不知道该怎么用它"这件事由 _renderSession 去说 —— 那里对未知
  //   服务只解释、不动作（绝不建 WebView、绝不 POST 口令）。
  //
  // 不跑浏览器的插件不走工作区（见 startSession）。这里不需要有连接也能接上，
  // 因为它的端口不是数据端口，没有「该用哪一份数据」这个问题。
  // 重启之后，"这条会话是哪条连接的"已经不知道了 —— 守护进程的会话视图里
  //   没有这个字段（它只知道是谁提交的、用的哪个插件版本）。唯一能用的是当前
  //   活跃连接，于是接回来的会话拿到的可能就是"不是它自己的"那条。
  //   这是已知的、说得出原因的一格，记在账本 S26；新开的会话没有这个问题。
  //
  //   走的是 `conn.workspaceId` 而不是 `workspaceForSession(conn)`：接回一条会话是
  //     只读的一步，不该顺手造出一个工作区来（那条路只在开会话时走）。
  //     而认领（下面那一行）会造一份临时数据 —— 那不是"顺手造一份持久的"，
  //       它是这一次接管必须要有的第三段，见那段说明。
  //   引用表里没有那一格时，先在这里补一份（下面那一支）。
  //
  //   从前这里是一句 `return`，理由是"一份数据都没建过，说明这台机器上从来没起过
  //     这个插件的会话"。那句话在一种现实里是假的：工作区换过、那份数据被删过、
  //     或者配置是手改过的 —— 会话在服务端活得好好的，引用表里却没有它的那一格。
  //     而静默返回的后果不是"少一条列表"，是这条作业在 1800 秒后被当作孤儿
  //     `scancel`，用户既接不回来、也开不了新的（站点的并发上限被它占着）。
  const conn = config.activeConnection(cfg);
  let baseSpace = (plugin && pluginData.needsSpace(plugin) && conn)
    ? config.findSpace(cfg, ((config.findWorkspace(cfg, conn.workspaceId) || {}).refs || {})[plugin.id])
    : null;
  if (plugin && pluginData.needsSpace(plugin) && !baseSpace) {
    const workspaceId = conn && config.findWorkspace(cfg, conn.workspaceId)
      ? conn.workspaceId : null;
    if (!workspaceId) {
      win.pushNotice('error', `这条会话要用「${plugin.displayName || plugin.name}」的一份数据，`
        + '而本机当前没有连接指着任何一个工作区，这条会话无法接回。作业仍在集群上运行；'
        + '回到连接列表连上一条连接之后会再试一次。');
      return;
    }
    baseSpace = spaceForSession(workspaceId, plugin);
    if (!baseSpace) {
      win.pushNotice('error', `接上这条会话之前，未能给「${plugin.displayName || plugin.name}」`
        + '建出一份数据。作业仍在集群上运行。');
      return;
    }
    win.pushNotice('warn', `这条会话用的那一份「${plugin.displayName || plugin.name}」数据`
      + '在本机的引用表里不在了，已经为它新建一份并接上。作业一个字都没动；'
      + '编辑器里的布局与打开的标签页会是新的。');
  }

  // 重连必须走同一个 `claimSpace`（不是"照抄 startSession 那两行"）。
  //
  //    临时那一份只存在于上一个进程的内存里 —— 配置里没有它。所以重启之后 N 条
  //    web-demo 会话全都算成"引用表指着的那一份"，全部落进同一个槽，只接回第一条，
  //    其余的在控制节点上继续跑、心跳没了，300 秒 `suspect`、1800 秒 `scancel`。
  //    而那条提示语还是错的（"想留住它就先用 `slurm` 把它的作业停掉" —— 那是
  //    我们自己的会话）。走到认领之后：第一条认领那一份，其余各拿一份临时的。
  //
  //    代价（账本 S26）：接回来的临时那份拿到的是新的 id，新的分区，
  //      重启前那一份 localStorage 变成孤儿（面板上看得见、删得掉）。这是"临时"的
  //      应有之义 —— 但界面上要说得出来（`temporary` 那一格就是为它留的）。
  const space = baseSpace ? claimSpace(baseSpace, plugin) : null;

  // 临时那份的起点数据：与 `startSession` 同一个函数、同一句判据（"认领给的不是
  //   引用表指着的那一份"）。重连接回来的临时那份也必须是"持有者那份的快照" ——
  //   少了这一句，同一个插件在"开局"与"重启接回"两条路上会得到两种第二份
  //   （一种有起点、一种空着），而用户看不出为什么。
  if (baseSpace && space.id !== baseSpace.id) {
    snapshotTempData(plugin, baseSpace, space);
  }

  // 还在排队（reserved/submitted）的会话也必须接上，哪怕它还没有 tunnel_target。
  //   若按 `if (!s || !s.tunnel_target) return;` 把没有 tunnel_target 的挡掉，
  //   「作业还在队列里」这种最需要说出来的情况反而完全看不见：界面照常显示
  //   「启动 web-demo」，
  //   用户一点就提交了第二个作业，而第一个还在排队。这既正是「单一启动」要防的
  //   资源占用，又恰好是「换了电脑 / 上次没关干净」最常见的形态 —— 重启客户端时
  //   作业往往还没跑起来。
  //   （`tryReattach` 筛的就是守护进程的 `OCCUPYING_STATES`，所以走到这里的一定是
  //     「还占着位置」的会话。）
  const queued = !s.tunnel_target;

  // 槽已经在表里，这一条与已经接上的某一条抢同一份资源。不覆盖：覆盖会把先接上
  // 的那条记录连同它的心跳一起丢掉（心跳一停，那个作业 1800 秒后被 scancel），
  // 而用户看到的只是"少了一个标签"。
  //
  // 判据是 `occupied(slot)`，与 `startSession` 同一口径。差别在已经结束的
  //   那些记录：
  //   它们还留在表里（界面要显示"已结束"），而它们不占着槽 ——
  //   按 `sessions.has` 去判，一条已经死掉的记录会挡住一条真会话的重连。
  //   走到这里还没被拒的，只有"`concurrent: false` 的插件、而那个槽上真的
  //     有一条活会话"（能多开的那些已经在上面的认领里各拿了一份新数据）。
  const slot = pluginData.slotOf(space && space.id);
  if (occupied(slot)) {
    const held = sessions.get(slot);
    win.pushNotice('warn',
      `控制节点上还有一个会话（作业 ${s.job_id}）与已经接上的`
      + `「${(held.plugin && (held.plugin.displayName || held.plugin.name)) || '某一条'}」`
      + '占着同一份数据，没法同时接上。它仍然在跑，会在超时后被控制节点回收。'
      + '想留住它就先用 `slurm` 把它的作业停掉。');
    return;
  }

  // `adopted`：这一条是接上来的，不是本机开的。界面那一侧靠它决定
  //   「本机没有接管」那句话，以及"新建的页面要不要把面板顶下去" ——
  //   接上来的那条可能是另一台电脑正在看的（用户 2026-10-18）。
  const rec = { slot, plugin, pluginWhy: why, controller: null, adopted: true,
                connectionId: conn ? conn.id : null, claims: new Set() };
  // 接上来的那一条也要认领，理由与 `startSession` 那一处逐字相同：它的插件进程
  //   是我们重启之前起的，而它正在写的那份目录，按当前输入可能已经算不出名字
  //   （`tryReattach` 走的正是"这一次启动"—— 上一次运行里的插件版本可能已经不在了）。
  claimDataDir(rec, plugin, space);
  rec.controller = new SessionController({
    backend, spaceId: space ? space.id : null,
    // 同上（startSession 那处）：只有不要工作区的会话要报实际端口。
    onRelayPort: () => onSessionChange(slot),
    getExcludedPorts: () => excludedPortsOfRec(rec),
    // 接上来的这个会话是哪个插件的 —— 快照要靠它分派（见 serviceKind 的说明）。
    // 认不出时原样记下，于是界面仍然得出「未知」。
    requestedKind: plugin ? plugin.name : s.service_kind,
    needsPubkey: Boolean(plugin && plugin.contributes.submitPubkey),
    // 「接上来的」而不是本机开的：服务端说看护者不是你的时候，那句话要说
    //   「本机没有接管」，不是「已被另一台电脑接管」—— 后者是一台曾经在看、
    //   又被别人拿走的电脑的情形（用户 2026-10-18 在第二台电脑上读到的正是
    //   那句不成立的话）。
    adopted: true,
  });
  rec.controller.on('change', () => onSessionChange(slot));
  rec.controller.sessionId = s.session_id;
  rec.controller.session = s;
  sessions.set(slot, rec);

  // 认不出的插件用非工作区的基准端口：它的端口绝不能落进任何工作区（否则会与
  // 那个工作区的 origin 撞上），而它自己听在哪个端口我们并不知道。有工作区的会话用它自己
  // 那个端口 —— 判据是 workspaceId 有没有（框架的事实），不是"是哪个插件"。
  // 与 `startSession` 同一条：走 `spacePortOf`（没有回落），临时那份不在
  //   配置里，回落到基址的实现会让它从 18080 起扫、撞上持有者那个端口。
  const preferredPort = space
    ? spacePortOf(space.id)
    : config.RELAY_PORT_BASE;
  if (queued) {
    // 交给现成的状态机往下走：等登记 → 建隧道 → （回到 RUNNING 时 onSessionChange
    // 会自己把视图/ssh 配置建起来，界面标题也已经有「排队中 — 作业 N」那一档）。
    rec.controller.state = State.QUEUED;
    // 预算给 0：这一条已经确认在排队，等那几秒不会让登记提前发生；
    //   而重连要逐条接，N 条就是 N 倍的等待（用户点完「连接」就进不去）。
    await rec.controller._afterSubmit({ preferredPort, enrollBudgetMs: 0 });
    return;
  }

  rec.controller.state = State.RUNNING;
  await rec.controller._bringUpTunnel(preferredPort);
  // 走同一个渲染入口（`_renderSession`），不要在各处直接调 openCodeServer ——
  //   那条直路只服务 web-demo 一种会话，而接上一个中转站会话时它会把隧道指向
  //   的 SSH 端口当成一个网页去加载。分派只有一个地方。
  await onSessionChange(slot);
}

// ── IPC ─────────────────────────────────────────────────────────────────────
function registerIpc() {
  const send = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => {
    try { return await fn(...args); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // 这里不再有公钥字段：密钥是按连接存的，界面在打开某条连接的表单时
  //   单独问（app:publicKey / app:newKey）。全局一份公钥的写法会让人以为
  //   「注册一次，所有连接都用它」。
  send('app:bootstrap', async () => ({
    connections: cfg.connections,
    activeConnectionId: cfg.activeConnectionId,
    // 这里不再有 connection（活动连接那条本身）：把地址预填进「新建」表单
    //   会让"不改就保存"变成又存一条一样的。
    whoami,
    partitions,
    // 服务端通报的默认资源（管理员设定）。界面只读地显示它，并且提交时
    // 靠【省略】cpus/mem 来使用它 —— 不是把这两个数字发回去。理由见变量声明处。
    plugins: pluginsView(),
    // 方法名是 isEncryptionAvailable，不是 isAvailable。
    // 写错的表现是「明明有凭据库却报告没有」，用户会被误导去找一个不存在的开关。
    secureStorageAvailable: secureAvailable(),
    // 工作区：已推导好的结构（每个工作区带 members / refCount / soleOwnerId）。
    // 界面只渲染、不做推导 —— 它手里那份随时可能已经陈旧（另一条连接刚被删），
    // 而「切走这个工作区会不会把它删掉」必须由主进程说了算。
    // 注意与上面的 `partitions` 不是一个东西：那是 Slurm 的分区，同词不同义。
    workspaces: config.workspacePlan(cfg),
    // 数据空间那一层（一份存储 + 它自己的端口）。界面拿它列出「这个插件现在有
    // 哪几份数据可以复用」—— 一张普通的列表，界面只做筛选与显示，不推导任何东西。
    // 不含临时那一份：它只活在内存里（`tempSpaces`），会随会话结束消失，
    //   列出来等于让用户去选一个明天不存在的东西。
    spaces: cfg.spaces,
    // 两段的那个（见 `wireVersion`）：界面与诊断都显示它。三段只活在
    //   `client/package.json` 里，那是 npm 的载体，不是第二个版本号。
    version: wireVersion(app.getVersion()),
  }));

  // 测试夹具那条不探：它是本机的假站点，探出来的"可达 / 不可达"两边都是假话。
  send('app:probeHosts', async () => hosts.probeAll(
    cfg.connections.filter((c) => !(testBackend && c.id === TEST_CONNECTION_ID))));

  // ── 连接条目的增删改 ──
  send('app:saveConnection', async (input) => {
    // 显式选的那个工作区先查存在性，查在 `upsertConnection` 之前：
    //   那一步会改 `cfg`（新条目进列表），而报错返回时不该留下半截改动。
    //   `null` = 界面要一个新的空白工作区（那一种不需要查）。
    //   只在新建时认这一格（见下面 `up.created` 那一段）。
    if (input && input.workspaceId && !config.findWorkspace(cfg, input.workspaceId)) {
      return { ok: false, error: '这个工作区不存在。' };
    }
    // created=false 表示这条连接本来就在（同一个人、同一台主机、同一个端口）。
    // 界面据此说明「已存在，直接用它」，而不是让列表里悄悄多出一条一模一样的。
    const up = config.upsertConnection(cfg, input);
    if (!up) {
      return { ok: false, error: '连接信息不完整：用户名、主机、端口（1-65535）都必填。' };
    }
    if (up.conflict) {
      const c = up.conflict;
      // 编辑时把地址改成了另一条已有的连接。两条同身份、各带一把密钥，
      // 界面完全看不出差别 —— 与其替用户挑一条，不如让他自己决定。
      return {
        ok: false, code: 'duplicate',
        error: `已经有一条 ${c.user}@${c.host}:${c.port} 了（备注「${c.label}」）。`
             + '同一个人在同一台机器上只保留一条，请改掉这里的地址，'
             + '或者先把那一条删掉。',
      };
    }

    if (up.created) {
      // 把「新建」时生成的那把密钥交给这条连接。
      // 顺序要紧：密钥必须先于用户的第一次连接尝试就位，因为公钥得先拿去
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
    // 新连接要落进一个工作区。三种来路见 `ensureConnectionWorkspace`：
    // 界面显式选的（表单里的「③ 工作区」）／界面要一个新的／界面没表态（默认规则）。
    // 「没表态」用键缺席表示 —— 不能用空串或 undefined 顶替：`null` 这个位置
    //   已经被「要一个新的空白工作区」占了。
    // 复用已有条目那条路径走不到这里（它的 workspaceId 由 upsertConnection 原样带过来）。
    if (up.created) {
      ensureConnectionWorkspace(up.connection,
        input && Object.prototype.hasOwnProperty.call(input, 'workspaceId')
          ? input.workspaceId : undefined);
      // 上面那一步通过 `setConnectionWorkspace` 换的是列表里那一份（它 map 出
      //   一份新的），所以返回给界面的那个对象要重新取一次。不取的话界面拿到的是
      //   一个 `workspaceId` 为空的连接 —— 而它明明已经落进工作区了。
      up.connection = cfg.connections.find((c) => c.id === up.connection.id) || up.connection;
    }
    commitConfig();
    return {
      ok: true, connection: up.connection, created: up.created,
      connections: cfg.connections,
      workspaces: config.workspacePlan(cfg),
      key: keyView(up.connection.id),
    };
  });

  send('app:deleteConnection', async (id) => {
    // 它的工作区里有会话在跑，就不许删。删掉的后果不是「少一条配置」：那个工作区
    //   会被回收 → 它指着的那些数据引用归零 → 浏览器存储被清 —— 而那块页面正在用
    //   那份存储。
    //   界面已经禁用了按钮，这里只是把它变成权威。
    //
    // 判据是「那个工作区里有没有会话」，不是「要删的是不是活跃连接」。
    //    后者是一个已经错了的判据，而多开把它变成一个可达的删活数据路径：
    //     ① 连接 C1（工作区 w1）活跃，起一条会话落在 w1 的某一份数据上；
    //     ② 把活跃连接切成 C2（工作区 w2）—— 这一步不动引用计数，C1 仍指着 w1；
    //     ③ 删 C1，w1 回收，它那份数据引用归零，回收，抽掉会话脚下那个分区。
    //    唯一挡着它的是 `clearSpaceStorage` 里"正被那块界面用着就不清"，而多开
    //    之后那一句只能看到前台那一块 —— 前台不是它的时候形同虚设。
    const conn = (cfg.connections || []).find((c) => c.id === id);
    const held = conn && conn.workspaceId
      && liveSessionOnWorkspace(conn.workspaceId);
    if (held) {
      return {
        ok: false, code: 'in_use',
        error: '这条连接的工作区里还有会话在跑，请先结束它再删除这条连接。',
      };
    }

    cfg.connections = cfg.connections.filter((c) => c.id !== id);
    if (cfg.activeConnectionId === id) {
      cfg.activeConnectionId = cfg.connections[0] ? cfg.connections[0].id : null;
    }
    // commitConfig 而不是 saveConfig：删掉指向它的连接之后，它的工作区引用计数归零，
    // 会被回收（连带它名下没人再引用的数据）。
    // 这里不需要为"删掉的是最后一条连接"补一步显式回收 —— 那正是
    //   `pruneWorkspaces` 那条「一条连接都没有时不回收」的豁免在时唯一的用处，
    //   而豁免已经整条删掉了（活会话现在是它的守卫）。多一步的结果是同一件事
    //   两份实现，而两份实现在"什么时候算没人用"上迟早会漂开。
    commitConfig();
    // 这条连接的密钥跟着走 —— 留着它既无用，又会在界面上留下一条看不见的凭据。
    // 两处都要清：落盘的那份，以及「这台机器没有凭据库」时留在内存里的那份。
    const gone = config.deleteKey(cfgDir, id).removed;
    const memGone = memKeys.delete(id);
    return {
      ok: true, connections: cfg.connections,
      activeConnectionId: cfg.activeConnectionId,
      workspaces: config.workspacePlan(cfg), keyDeleted: gone || memGone,
    };
  });

  send('app:setActiveConnection', async (id) => {
    if (!cfg.connections.some((c) => c.id === id)) {
      return { ok: false, error: '这条连接不存在。' };
    }
    cfg.activeConnectionId = id;
    // 这里不动引用计数（连接还是指向原来那个工作区），所以直接 saveConfig 即可 ——
    // 不是漏改。
    config.saveConfig(cfgDir, cfg);
    return { ok: true, activeConnectionId: id };
  });

  // ── 工作区 ──
  /**
   * 把一条连接指到另一个工作区。
   *
   * `workspaceId` 为空 = 新建一个空白工作区并落进去，一次原子完成。单独建出来的工作区
   * 引用计数天然是 0，紧接着的 commitConfig 会把它当场回收，用户点了会没反应 ——
   * 所以不提供独立的「新建工作区」通道。
   *
   * 步骤顺序是刻意钉死的：先做会失败的那一步（换端口），成功了才动配置。
   *   反过来的话，一旦换端口失败，配置说「在 B 工作区」而窗口还跑在 A 那份数据的
   *   origin 上，而 A 的引用计数已经是 0 → 会被回收 → 浏览器存储被清 ——
   *   把用户当前的页面连同登录 cookie 一起抽掉。这是整块改动里最危险的路径。
   *
   * 而"这个插件在新工作区里用哪一份数据"由 `spaceFor` 说了算（没有就地建一份）：
   *   那正是窗口要搬过去的那一份，也是要落盘的那一格。
   */
  /**
   * 表单里那个「③ 工作区」要在用户按保存之前就把默认值显示出来，所以它得问一句。
   *
   * 规则本身只有一份（`config.js` 的 `defaultWorkspaceFor`）—— 界面自己算一遍的话，
   *   两处会漂开，而漂开的症状是「表单里显示 A、存进去的是 B」，两边都不报错。
   * 它是一句纯查询（不落盘、不改任何东西），所以在用户敲地址的时候可以反复问。
   * 返回 `workspaceId: null` 表示"会新建一个空白工作区" —— 那是一个答案，
   *   不是"获取失败"。
   */
  send('app:defaultWorkspace', async (payload = {}) => {
    const id = config.defaultWorkspaceFor(cfg, payload);
    return { ok: true, workspaceId: isTestWorkspace(id) ? null : id };
  });

  send('app:setConnectionWorkspace', async (payload = {}) => {
    const { connectionId, workspaceId, confirmDiscard } = payload;
    const conn = cfg.connections.find((c) => c.id === connectionId);
    if (!conn) return { ok: false, error: '这条连接不存在。' };

    let target = workspaceId ? config.findWorkspace(cfg, workspaceId) : null;
    if (workspaceId && !target) return { ok: false, error: '这个工作区不存在。' };
    if (!target) {
      target = {
        id: config.newWorkspaceId(),
        name: config.nextWorkspaceName(cfg),
        refs: {},
      };
    }
    if (target.id === conn.workspaceId) {
      return { ok: true, workspaces: config.workspacePlan(cfg), connections: cfg.connections };
    }

    // 切走之后旧工作区的引用计数会归零 —— 也就是被删除。这正是「独占」那行提示要说的事。
    // 判定权在这里，不在界面：界面手里那份 refCount 随时可能已经陈旧
    //   （另一条连接刚被删），它只负责弹确认。
    const old = config.workspacePlan(cfg).find((l) => l.id === conn.workspaceId);
    if (old && old.soleOwnerId === conn.id && !confirmDiscard) {
      return {
        ok: false, code: 'would_discard',
        workspaceId: old.id, workspaceName: old.name,
        error: `「${old.name}」只有这一条连接在用，切走之后它会被删除。`,
      };
    }

    const existed = Boolean(config.findWorkspace(cfg, target.id));
    if (!existed) cfg.workspaces = [...cfg.workspaces, target];   // 还没落盘：下面的 spaceFor 要它

    const isActive = cfg.activeConnectionId === connectionId;
    // 「有没有会话在跑」这个问题问的是「这条连接的工作区里有没有会话」。
    //    拿"窗口里那一个"去判会在多开下把另一条连接那个工作区里的会话当成"这个工作区的"，
    //    于是挪一个与这条连接无关的隧道端口。
    const live = conn.workspaceId ? liveSessionOnWorkspace(conn.workspaceId) : null;
    const sessionLive = Boolean(live);
    // 不要工作区的插件不能走 relisten：它的端口不在任何工作区里，relisten 会去
    //   挪一个正在被使用的隧道端口 —— 而它对外的那份配置是隧道起来时才写的，挪完那
    //   一瞬间用户手上的连接指向一个没人监听的端口。所以那种会话只改配置、不动会话本身。
    //
    //   判据是 spaceId 有没有（框架的事实），不是"是哪个插件"（那是插件名）。
    // 本机会话同样不能走 relisten：它没有隧道，换端口就是让本地页面失联。
    //   与"不要工作区的插件"归同一档：只改配置，不动正在跑的那一条。
    const localLive = sessionLive
      && typeof live.controller.isLocal === 'function' && live.controller.isLocal();
    const sessionInWorkspace = sessionLive && !localLive
      && live.controller.spaceId !== null;
    const outsideWorkspace = sessionLive && !sessionInWorkspace;

    if (isActive && live && !outsideWorkspace) {
      // 会话要搬到新工作区里这个插件那一份上 —— 那一份可能还没有，就地建一份
      //   （`created` 只在真的建了时才落盘）。
      const moved = spaceForSession(target.id, live.plugin);
      if (!moved) {
        if (!existed) cfg.workspaces = cfg.workspaces.filter((l) => l.id !== target.id);
        return { ok: false, code: 'relisten_failed',
                 error: '换工作区失败，工作区没有改动：这个工作区不见了。' };
      }
      const excluded = usedSpacePortsAll(moved.id);
      const r = await live.controller.relisten(moved.id, moved.ports[0], excluded);
      if (!r.ok) {
        if (!existed) cfg.workspaces = cfg.workspaces.filter((l) => l.id !== target.id);
        return {
          ok: false, code: 'relisten_failed',
          error: '换端口失败，工作区没有改动：' + r.error,
        };
      }
      // 不把 r.port 写回那一份数据 —— 端口是它被创建时定下来的那个
      //   （`assignSpacePorts`），顺移只是这一次会话的事。写回会把一次暂时的冲突
      //   变成永久的 origin 变更，而冲突消失之后 origin 回不去、那份布局也跟着
      //   白丢。（`relisten` 的 warning 已经把这个取舍告诉用户了。）
    } else if (isActive && !sessionLive) {
      // 没有会话在跑：只改标记，下次开会话就用它（那时 `spaceForSession` 会建出
      // 这个插件在新工作区里的那一份）。
      // 只改标记，不碰任何会话：没有会话在跑时本来就没有"那个会话"可改，标记
      //   落在 `cfg` 里（下面那句 setConnectionWorkspace）。
    }
    // outsideWorkspace 时两条都不走：配置照改（下次起 web-demo 就用新工作区了），
    // 但这个正在跑的中转站会话不受任何影响 —— 它的 spaceId 保持 null。

    config.setConnectionWorkspace(cfg, connectionId, target.id);
    commitConfig();
    return { ok: true, workspaces: config.workspacePlan(cfg), connections: cfg.connections };
  });

  /**
   * 改一个工作区里某个插件用哪一份数据（插件块上那一格）。
   *
   * 三种取值，与「③ 工作区」那一格同一套约定（一份实现、一个约定，两处不各写一遍）：
   *
   *   键缺席（`undefined`）= 界面没表态，什么都不做（引用表原样，下次开会话时
   *                           `spaceForSession` 该建就建）。不能在界面里算好"应当
   *                           是哪一份"再发过来 —— 那个值是上一个字算的。
   *   `null`               = 要一份新的（哪怕现在已经有一份）—— 从空白开始。
   *   一个 id              = 就用那一份（先查它存不存在、是不是这个插件的）。
   *
   * 有活会话就拒（见 `liveSessionForPlugin`）。改的是"下次开会话读哪里"，
   *    而一条跑着的会话手里攥着的那一份是开局那一刻定下来的：改了这一格之后
   *    它照旧跑在旧的那一份上，一旦客户端重启、`reattachOne` 按新引用去算分区与
   *    数据目录，那条作业就接不回来了。所以不是"提示一下"，是拒。
   *
   * 换走会把旧那一份收掉（如果它没有别的工作区在引用、也没有活会话拿着）——
   *    这是 `pruneSpaces` 的规则，不是这里额外做的事。它不可逆，所以照
   *    `app:setConnectionWorkspace` 的老样子：先做，主进程回 `would_discard`，
   *    界面拿这句原话去问，用户认了再带 `confirmDiscard` 重来一次。判定权在主进程，
   *    因为界面手里那份引用计数随时可能已经陈旧。
   *
   * 第三道闸：这张表是不是被几条连接共用（`code: 'shared'`）。
   *    前面两道问的都是"这一份数据会不会没了"，这一道问的是改动会落到谁头上：
   *    表是共用的，改一格就是几条连接一起变，而另外几条的界面上什么都没发生。
   *    界面拿这句原话去问，用户选完再带 `scope` 重来一次：
   *      · `'all'`  —— 就改这张共用的表，共享者一起变；
   *      · `'fork'` —— 先给这条连接复制一张自己的表（`cloneWorkspace`），在那张上改。
   * `'fork'` 要连 `connectionId` 一起给：分叉是"给哪一条连接分"，
   *      而那件事只有界面知道（插件块画的是活跃连接那个工作区，但那是界面状态）。
   */
  send('app:setWorkspaceRef', async (payload = {}) => {
    const { workspaceId, pluginId, spaceId, confirmDiscard, scope, connectionId } = payload;
    const ws = config.findWorkspace(cfg, workspaceId);
    if (!ws) return { ok: false, error: '这个工作区不存在。' };
    // 按 id 找插件（池里可以有同名不同 id 的两个），与 `pluginsView` 同一条规矩。
    const plugin = registry.list().find((p) => p.id === pluginId);
    if (!plugin) return { ok: false, error: '本机没有这个插件。' };
    // 不要数据空间的插件没有这一格。界面不会画那一格，但这一句要留着：
    // 少它的后果是凭空造出一份这个插件永远不会去读的数据。
    if (!pluginData.needsSpace(plugin)) {
      return { ok: false, error: '这个插件不要数据空间，它没有"用哪一份数据"这回事。' };
    }

    const oldId = (ws.refs || {})[pluginId] || null;

    const live = liveSessionForPlugin(workspaceId, pluginId);
    if (live) {
      return {
        ok: false, code: 'session_running',
        error: `「${plugin.displayName || plugin.name}」在「${ws.name}」里正跑着一条会话。`
          + '换一份数据要让那条会话先结束：它手里攥着的是开局时那一份，'
          + '现在改掉，客户端重启之后那条作业就接不回来了。',
      };
    }

    // ── 定下要用哪一份 ──────────────────────────────────────────────────────
    //
    // 次序是刻意的：先查「这一份能不能用」（会失败、且一个字都不改），
    //   再问「换走会不会删掉东西」（可能被用户否掉），最后才造新的一份。
    //   反过来的话，每一次"用户点了又取消"都会在 `cfg.spaces` 里留下一份没人要的
    //   数据 —— 它虽然在下次 `commitConfig` 时会被收掉，但那中间有一段窗口里
    //   `app:bootstrap` 会把一份多余的数据报给界面。
    const group = pluginData.groupOf(plugin);
    let targetId = oldId;
    if (spaceId !== undefined && spaceId !== null) {
      const space = config.findSpace(cfg, spaceId);
      if (!space) return { ok: false, error: '这一份数据不存在。' };
      // 共享组也要对得上，判据与 `config.spaceFor` 那一支同源：作者换过共享组
      // 的那一份数据，这个插件按现在的身份读不到（路径中间那一段变了）。
      // 指过去只会得到一份"看起来换好了、开会话时又变回新的"的假动作。
      if (space.group !== group) {
        return { ok: false, error: '这一份数据与这个插件现在的版本不一致（共享组变了），不能复用。' };
      }
      targetId = space.id;
    }

    // 什么都不用改：没表态（`undefined`，于是 `targetId` 就是 `oldId`），或者
    // 选中的就是现在这一份。不落盘 —— 这一格绝大多数调用都走这里。
    // 判据里那个 `spaceId !== null` 是承重的：`null`（要一份新的）那一支在
    //   这之后才 `newSpace`，所以此刻 `targetId` 还等于 `oldId`（两者都是 null 时
    //   尤其如此 —— 那正是"这个工作区还没有这个插件的数据"这个最常见的起点）。
    //   少了它，用户点「另开一份」会得到一个静默的空操作：返回 ok，什么都没发生。
    if (spaceId !== null && targetId === oldId) {
      return { ok: true, workspaces: config.workspacePlan(cfg), spaces: cfg.spaces,
               connections: cfg.connections, droppedOld: false, forked: null };
    }

    // ── 这一格改的是一张表，而一张表可以被几条连接共用 ────────────────────
    //
    //   改它 = 那几条连接一起变。主进程不替用户拿主意，先回一句让界面问：
    //   ① 全部一起改（`scope: 'all'`）② 先给这条连接分一张自己的表（`scope: 'fork'`）。
    //
    //   「给哪一条」由 `connectionId` 指名，不拿 `activeConnectionId` 去猜 ——
    //     那是一个界面状态（用户在列表里点出来的），而这是一次会改配置的写。
    //   分叉出来的那张表指着同一批数据（`cloneWorkspace` 只复制引用），所以
    //     旧那一份数据一个字都不会动 —— 见下面那道 `would_discard`。
    //
    //   顺序是刻意的：它排在"什么都不用改"那个早返回之后 —— 没改东西就没有
    //     共享可言，为一次空操作弹一个"这会影响到别人"的框，只会训练用户闭眼点确定。
    let targetWsId = workspaceId;
    let forkedName = null;              // 分叉出来的那张表叫什么（没分叉就是 null）
    const members = config.workspacePlan(cfg).find((l) => l.id === workspaceId).members;
    if (members.length > 1 && scope !== 'all') {
      // 问"是替哪一条连接改的" —— 答不上来就不能分叉，也不该替它选一条。
      const conn = (cfg.connections || []).find((c) => c.id === connectionId);
      if (!conn || conn.workspaceId !== workspaceId) {
        return {
          ok: false,
          error: '这个工作区有几条连接在用，要改它，得指名是替哪一条连接改的。',
        };
      }
      if (!scope) {
        const others = members.filter((id) => id !== connectionId);
        return {
          ok: false, code: 'shared', workspaceId, workspaceName: ws.name,
          // 只回 id：名字由界面取（`connLabel` 那一条规则）—— 在这里再拼一遍
          //   备注/地址的回落规则，就是同一条规矩的第二份实现，而它会漂开。
          others,
          error: `「${ws.name}」这张表还有 ${others.length} 条连接在用。`
            + '改这一格，它们会一起变。',
        };
      }
      if (scope !== 'fork') {
        return { ok: false, error: 'scope 只能是 all 或 fork。' };
      }
      const copy = config.cloneWorkspace(cfg, workspaceId);
      if (!copy) return { ok: false, error: '这个工作区不存在。' };
      config.setConnectionWorkspace(cfg, connectionId, copy.id);
      targetWsId = copy.id;
      forkedName = copy.name;
    }

    // ── 换走之后旧那一份还活不活得下来（不可逆，所以要问）────────────────────
    //
    // 判据是 `pruneSpaces` 那条的反面，逐字抄过来（有工作区指着 / 有活会话拿着
    //   留着），不是另写一个"看起来等价"的判断：这两处一旦分家，这句话就会在
    //   不会删的时候说"会删掉"（或者反过来），而用户是按它做决定的。
    //   数的对象是 `targetWsId`（真正要改的那张表）—— 分叉那一支里，原来那张表
    //     还在原处指着旧那一份，于是这里自然得出"不会被删"，不必为它开特例。
    //   前面那道"有活会话就拒"已经拦掉了本工作区里同插件的那一条，所以这里的
    //   `held` 实际上够不着 —— 留着它是因为它让这条判据与 `pruneSpaces` 同形。
    const stillUses = oldId
      ? config.spaceConsumers(cfg, oldId).filter((id) => id !== targetWsId) : [];
    const held = oldId ? liveSpaceIds().has(oldId) : false;
    if (oldId && !stillUses.length && !held && !confirmDiscard) {
      return {
        ok: false, code: 'would_discard', spaceId: oldId,
        error: `「${plugin.displayName || plugin.name}」现在用的那一份数据没有其他工作区在用，`
          + '换掉之后它会被删掉：它的浏览器存储（登录状态、窗口布局）和这个插件写在'
          + '磁盘上的文件会一起没掉，找不回来。',
      };
    }

    // ── 真动手 ──────────────────────────────────────────────────────────────
    // 一次调用盖住两支：`null` 那一支造出来的那一份也走这儿指过去（`newSpace`
    //   只负责把它放进 `cfg.spaces`，指给谁是这个调用方的事）。
    // 走到这里之后的失败面已经空了（工作区/插件/那一份/共享组都在上面查过），
    //   所以分叉那一步不会留下"表分了、引用没改成"的半截状态。
    if (spaceId === null) {
      targetId = config.newSpace(cfg, plugin.id, group,
        pluginData.portCountOf(plugin), usedSpacePortsAll(null)).id;
    }
    const r = config.setWorkspaceRef(cfg, targetWsId, plugin.id, targetId);
    if (!r.ok) return r;

    commitConfig();
    // `droppedOld` 是事后数的（commitConfig 里那句 pruneSpaces 才是决定性的），
    //   不是把上面那个预判原样返回 —— 预判与事实会分家，而分家的那一格正是用户
    //   最需要听真话的地方（"我删掉了你那份数据"）。
    const droppedOld = Boolean(oldId) && !config.findSpace(cfg, oldId);
    return { ok: true, workspaces: config.workspacePlan(cfg), spaces: cfg.spaces,
             connections: cfg.connections, droppedOld,
             // 新表的名字（没分叉就是 null）——界面拿它说"表分了、数据没复制"。
             forked: forkedName };
  });

  // ── 本机的插件数据 ──
  //
  // 与 `app:bootstrap` 分开的一次单独的对账（理由见 auditPluginData 的注释）。
  //
  // 这一次对账顺手把孤儿收掉（`reclaimOrphans` 那段）：只读不收在"没人管的
  //    数据越攒越多"这件事上没有出路。收起它们的那一档与"界面上可删的"不是
  //    同一个集合（见 `plugin-data-audit.js` 的 `reclaimable`）：`unused` 那一档
  //    一个都不碰。
  //
  // 时机就是对账本身：界面在首屏之后立刻拉一次（`panel.js` 的 init），而它
  //   一次开机只发生一次（保留 ⑪）。
  //   多拉几次也无害（收掉了的就不会再被收，`lastReclaim` 只增不减），所以这一
  //     条不需要自己去数"第几次" —— 那会是一份与事实无关的状态。
  send('app:pluginData', async () => {
    await reclaimOrphans();
    const a = auditPluginData();
    // 回包的形状照界面读的那几个字段逐字给（`panel.js` 的 `renderPluginData`）
    //   —— 少给一个不会红任何东西：界面读到 `undefined`，而 `Boolean(undefined)` 是
    //   `false`，于是那条提示永远不出现、也没有任何地方报错。
    //   `allUnknown` 正是这样漏过一次（见 KNOWN-ISSUES 的 F35）：判据在 `audit()` 里
    //   算得好好的，只是没送到这里。改动这几个字段时，`client/test/boot.test.mjs` 的
    //   「回包里带着界面要读的那几个字段」那条用例会红。
    return {
      ok: true, rows: a.rows, diskChecked: a.diskChecked,
      allUnknown: a.allUnknown, why: a.why,
      // 这一次收掉了什么。界面读它、画一行（`panel.js` 的 `renderPluginData`）——
      //   少了它，删除就是用户看不见的，而那是这条律里唯一不能松的一半。
      reclaimed: lastReclaim,
      // 还欠着什么（此刻删不掉、已经安排在下一次启动时清的那些）。
      deferred: deferredRemovals(),
    };
  });

  /**
   * 删掉一份插件数据。不可逆 —— 那里面是那个插件的编辑器布局、打开的标签页和
   * 登录状态，所以界面必须先问过用户。
   */
  send('app:deletePluginData', async (payload = {}) => {
    const { name } = payload;
    // 判定权在这里（照 `app:setConnectionWorkspace` 那条形状）：界面手里那份清单
    //   随时可能已经陈旧（刚连上、刚改过配置、刚装了插件），所以重新对一遍账，
    //   只认这一次算出来的那一条。判据本身在 plugin-data-audit.js 的 deletionVerdict。
    //   于是路径只由 根 + 磁盘上的目录名 拼，而 `name` 这个字符串只用来
    //   匹配某一行 —— `{name: '../../..'}` 匹配不上任何一行。
    //   「正被用着」那一格不在这里判：`auditPluginData()` 已经把活会话拿着的
    //   名字挡在 `rows` 之外了（两个根都挡）。在这里再判一次等于留一条够不着的分支。
    const fresh = auditPluginData();
    const verdict = dataAudit.deletionVerdict({ rows: fresh.rows, name });
    if (!verdict.ok) return verdict;
    // 删哪几个落点由这一行说了算（`places`）—— 一份数据的浏览器那一半与磁盘
    // 那一半是一起删的，只删一半的话下一次对账会把同一行再带回来。
    const r = clearOneRow(verdict.row, fresh.roots);
    if (!r.ok) {
      return { ok: false, code: 'failed', error: `未能清干净：${r.error}` };
    }
    const row = verdict.row;
    const after = auditPluginData();
    // 与 `app:pluginData` 同一个形状（界面拿这份回包重画同一块，见上面的注释
    //   与 KNOWN-ISSUES 的 F35）—— 这里少一个字段，症状与那边逐字相同。
    return {
      ok: true, rows: after.rows, diskChecked: after.diskChecked,
      allUnknown: after.allUnknown, why: after.why,
      label: row.label,
      // 与 `app:pluginData` 逐字同一个字段（上面那条用例按 `panel.js` 现读的
      //   字段逐个核）。给的是这一次运行累计的结果，不是这一次删除的 ——
      //   用户接着删一份，不该把"对账收掉了什么"那句话擦掉。
      reclaimed: lastReclaim,
      // 这一次有没有被推迟。界面要说的两句话不同（"已删掉"与"已安排下一次启动
      //   时清掉"），所以这一个布尔要有 —— 让界面自己从 `deferred` 里翻一遍
      //   是把判定挪到界面，而"删掉了没有"的判定权在主进程。
      pending: r.pending,
      deferred: deferredRemovals(),
    };
  });

  // ── 连接 ──
  send('app:connect', async (payload) => {
    // 同一时刻只有一条连接在连。两次同时在飞的后果见 `connectInFlight` 的说明；
    //   这一句放在最前面 —— 连活跃连接那一格都不许先被换掉。
    if (connectInFlight) {
      return { ok: false, code: 'busy',
               error: '正在连接站点，请等这一次结束再连另一条。' };
    }
    let conn = config.activeConnection(cfg);
    if (payload && payload.connectionId) {
      conn = cfg.connections.find((c) => c.id === payload.connectionId) || conn;
    }
    if (!conn) return { ok: false, error: '还没有配置登录节点。', code: 'no_connection' };

    // 要连的是另一条连接，而本机正连着一条，这是一次换站点，
    //    而换站点的意思就是离开上一个站点。
    //
    //    它必须先于 `doConnect`，而且必须在拨号之前：本机手上那些记录
    //      还带着上一个站点的 `session_id`（各站点的守护进程各自编号），留着它们，
    //      接下来的心跳与 `goodbye` 就会拿旧站点的号去打新站点的守护进程 ——
    //      撞上了就是一次打在别的作业上的 `scancel`。`abandon()` 一个字都不发。
    //    顺带把连接现场也收掉（`whoami` / 分区 / 站点插件 / 待同意），否则
    //      它们会以"上一个站点的事实"出现在新站点这一侧。
    //    判据是 `connectedConnId`（正连着的那条），不是
    //      `cfg.activeConnectionId`（下一次要用哪一条）。界面那条路是先
    //      `setActiveConnection` 再 `connect` 的 —— 那一刻配置里已经写成目标
    //      那条了，拿它去判"换没换"会永远判不出来，于是这条收尾在界面上
    //      一次都不会发生（而在其它入口上照常发生：同一个缺陷的形态是"两条入口
    //      行为不一样"，最难查）。
    //    保守的方向是"多收一次"：`connectedConnId` 是 null 而后端说连着（比如
    //      "删掉正连着的那条连接"那条边），这里也会先收尾再连 —— 代价是一次多余的
    //      收尾，而不是把旧站点的记录带过去。
    //    它不是"一个客户端只连一个站点"那条产品约定的落点 —— 那一条现在由
    //      界面的形状保证（站在第一屏上就一定不在站点里，2026-10-11：界面那边
    //      从前还有一道 `allowSwitchTo` 的闸，随这条不变量一起删掉了）。这一句管的是
    //      另一件事：既然真要换，就把本机这一侧收干净。它是 IPC 层的防线，
    //      不该假设界面的形状 —— `app:connect` 传哪一条进来都做得到。
    connectInFlight = true;
    try {
      if (backend.connected && connectedConnId !== conn.id) await leaveSite();

      // 显式点名要连哪一条，就是「这条是我要用的」。不跟着改的话，
      // 下次启动自动重连会连到另一台上去 —— 而用户完全看不出为什么。
      if (cfg.activeConnectionId !== conn.id) {
        cfg.activeConnectionId = conn.id;
        config.saveConfig(cfgDir, cfg);
      }

      const res = await doConnect(conn);
      return { ...res, whoami, partitions, plugins: pluginsView(),
               daemonCaps: connectedDaemonCaps };
    } finally {
      connectInFlight = false;
    }
  });

  /**
   * 用户确认了一个新主机密钥。记住它再重连 —— 只记住用户确认的那一个指纹，
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
    return { ...res, whoami, partitions, plugins: pluginsView(),
             daemonCaps: connectedDaemonCaps };
  });

  /**
   * 忘掉某台主机已记录的指纹（服务器重装后用）。
   * 刻意做成一个显式动作：默认路径上，指纹变了就是拒绝连接。
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
   * 查一条密钥的公钥。不生成 —— 界面上「看」这个动作不该产生副作用，
   * 否则用户点开编辑看一眼，就作废了别的东西。
   */
  send('app:publicKey', async (payload) => {
    const id = keyTarget(payload);
    if (!id) return { ok: false, error: '这条连接不存在。' };
    return { ok: true, key: keyView(id) };
  });

  /**
   * 「新建连接」时生成那把还没有归属的密钥。
   *
   * 生成发生在用户填地址之前：他要把公钥复制去 IDM 注册，回来才能连上。
   *
   * 每问一次就换一把新的。它从前是幂等的 —— 「新建位」上还留着上一把就
   *   复用它，理由是"用户可能已经把它注册到 IDM 了，无声换一把会作废它"。
   *   那条理由的代价是：点「新建」→ 关掉表单 → 再点「新建」，公钥一模一样，
   *   而用户在界面上没有任何办法要到一把干净的钥匙（新建表单里那个
   *   「重新生成密钥」按钮，除了这一条路没有别的用处，也没有任何地方说它该按）。
   * 规矩改成（用户 2026-10-09 定的）：「新建」永远给一把新的；
   *     只有已经保存的连接才留住自己的密钥，而"要不要换掉一条已保存连接的"
   *     是那个显式的按钮（`app:regenerateKey`）。
   * 代价如实说：关掉表单就等于放弃这一把，那把公钥要是已经注册进 IDM，
   *     就得重新注册一次。界面在密钥那一行说出来，不再另加确认 ——
   *     它不是一个"丢掉了什么"的动作。
   * 这条路径不产生孤儿：先删后建，落盘的永远只有一把。
   */
  send('app:newKey', async () => {
    // 先作废上一把没归属的。它要么是上一次「新建」留下的，要么已经被
    // `app:saveConnection` 过户给某条连接了 —— 后者那次删除发生在那边，
    // 这里删的是一个本来就空的位，两条路合起来保证"至多一把"。
    config.deleteKey(cfgDir, config.PENDING_ID);
    memKeys.delete(config.PENDING_ID);
    const r = ensureKey(config.PENDING_ID);
    if (!r.ok) return { ok: false, error: r.detail || r.error };
    return {
      ok: true,
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
   * 它会作废用户已经注册到 IDM 的那把公钥，一旦悄悄发生，表现只是「认证失败」，
   *   指不回根因。所以界面上是一个带确认的按钮，而这是唯一的生成入口。
   *   同理，密钥读不出来时也是走这里，不做任何自动覆盖。
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
   * 【断开】—— 主动断开与登录节点的连接。
   *
   * 这是一次彻底的终止：只要还有会话（哪怕它已经出错，作业却可能还在
   *   集群上跑着），就先把作业取消、资源释放掉，再拆连接。
   *   断开等于「我不要了」，不等于「我先走开，你继续烧着」。
   *
   * 而「我先走开，你继续跑」这条确实存在 —— 它是旁边那个按钮
   *   （`app:leave`）。两个按钮挨在一起，而它们对作业做的事正好相反：
   *   这里每一条都发 `goodbye`（`scancel`），那里一个请求都不发（本机收尾）。
   * 所以这一条一个字都不许长成【临时离开】那样，反之亦然：它们是同一件事
   *   的两个方向，任何"统一一下"的念头都会把其中一个的语义抹掉。
   *
   *   注意它与「意外消失」的分工：断电、睡眠、网线被拔时这个方法根本不会被调用，
   *   那种情况靠守护进程的 suspect/orphaned 容错窗口兜底，客户端下次启动自动接回。
   */
  send('app:disconnect', async () => {
    let released = { ok: true, detail: '' };
    // 每一条都要停 —— 与 `shutdown()` 同一条理由：断开等于"我不要了"，
    //   不等于"我先走开，你继续烧着"。只停一个的话，剩下的那条在拆掉连接之后
    //   连心跳都没有了，只能等守护进程 1800 秒后的孤儿判定。
    for (const { res } of await stopAllSessions()) {
      // 每一条的结果都要回填，不是只在失败时 —— 只在失败时赋值的话，
      //   全都成功时 `released` 还是那个初值，于是调用方拿不到 `state`
      //   （界面靠它区分"已经释放了"与"只是请求发出去了"）。
      released = res;
      // 释放失败要说出来。`released` 不保证作业真的停了 —— `releasing` 只说明
      // "已受理"，而守护进程会在作业确认消失之前一直留在那个状态
      // （`docs/ARCHITECTURE.md` 的 §3.0），所以不能在这里宣布成功。
      if (!res.ok) win.pushNotice('error', res.detail);
    }
    // 断开之后本机不再持有任何记录。少了这一句，那些记录会以 `releasing`
    //   停着（`stop()` 之后没有人再推进它们），并且带着这个站点的 `session_id`
    //   活到下一次连接 —— 选中一条已经结束的作业，前台就被切成那个死记录
    //   （见 `forgetSessions` 的说明）。
    await forgetSessions();
    await teardownConnection();
    return { ok: true, released };
  });

  /**
   * 【临时离开】—— 回登录节点列表，作业继续在集群上跑。
   *
   * 它与【断开】的差别就是这一条的承重点：离开只是本机走开，断开是
   *   `goodbye`（那会 `scancel` 掉作业）。两个按钮在界面上挨着，而走错一个的
   *   代价是一个正在跑的作业 —— 所以它们各自只有一条实现，谁都不许顺手写
   *   第二条（与 `stopAllSessions` 同一条纪律）。
   *
   * 看护者一个字都不动（2026-10-21 用户定）。临时离开不是把管理权交出去：
   *   本机回来重连时 `keeper` 仍指向它，`tryReattach` 直接接回，不需要点
   *   「接管」。而留在原地的那个看护者也不会让作业永远活着 —— 倒计时看的是
   *   心跳，本机一走心跳就停了，300 秒 `suspect`、1800 秒 `orphaned`、
   *   然后 `scancel`。所以界面仍然要说那句话（见 panel.js 的 doLeave）：
   *   用户以为离开是免费的，合上电脑出差，回来时作业已经没了。
   *
   * 本机这一侧的收尾走 `leaveSite()`：`abandon()` 掉记录（一个字都不发给
   *   服务端）再拆连接。提交中、还没有会话号的那一条同样如此，它的结局是
   *   "在服务端长出来、然后按那条窗口被回收"—— 与"提交到一半合上电脑"逐字相同。
   */
  send('app:leave', async () => {
    await leaveSite();
    // `left` 这个形状留着：界面读它决定要不要多说一句警告。
    //   离开不再依赖任何一条服务端请求，所以这里永远是成功的。
    return { ok: true, left: { ok: true, cleared: [] } };
  });

  // ── 会话 ──
  // ok 如实反映查询本身成不成功（失败不被吞成空分区列表）。
  // partitions 仍然是数组，空数组表示「获取失败」而不是「没有分区」—— 区别在 error 里。
  send('app:partitions', async () => {
    const r = await refreshPartitions();
    return { ok: r.ok, partitions: r.partitions, plugins: pluginsView(), error: r.error };
  });

  /**
   * 起一个会话。
   *
   * @param {object} resources 高级选项里的临时覆盖（省略字段 = 用服务端默认）
   * @param {string} serviceKind 插件名（站点内的短名）。必填 —— 客户端
   *        这一侧没有"缺省插件"，缺省是站点的事（配置里的 `default_plugin`，
   *        它只作用于不带 `service_kind` 的 `slurmate submit`）。
   * @param {string} [portChoice] 用户在「端口被占」那一行上答过的：`'shift'`
   *        （启动 —— 只把这一次会话换到别的端口）或 `'remember'`（记住并启动
   *        —— 绑定成功之后把这份数据的首选端口记成新的那个）。界面上那一行重发时
   *        带上它。
   *
   * `code: 'port_conflict'` 这一支是唯一一个"没成，但也没失败"的答案：
   *   它说的是"首选端口被占着，什么都没提交，等你答"。界面上那一行三选一，
   *   三个答案都是用户主动要的（见 panel.js 的 `renderPortAsk`）—— 它不是
   *   一次确认，别照 `armConfirm`"第一下 arm、第二下执行"的路子读它。
   */
  send('app:start', async (resources, serviceKind, portChoice) => {
    const r = await startSession(resources, serviceKind, portChoice);
    if (r && r.conflict) {
      return {
        ok: false,
        code: 'port_conflict',
        // `want` 让界面能把那个端口念出来（那句后果里要用它）。
        port: r.conflict,
        sessions: sessionViews(),
        front: frontSlot(),
        // 那一行上那句后果由这一侧给（界面不自己编一句，同 `suspended` 那条
        // 规矩）。它只说为什么：两个答案各自的代价是那两颗按钮自己的事。
        // 排在状态条上那一行的正文里，所以它得短：两个答案各自的代价在那两颗
        //   按钮的 `title` 上（那是界面自己的事）。
        error: `首选端口 ${r.conflict.want} 被其他程序占用（它是这份数据在浏览器里的地址）。`,
      };
    }
    return {
      ok: Boolean(r),
      slot: r ? r.slot : null,
      sessions: sessionViews(),
      front: frontSlot(),
    };
  });

  /**
   * 本机要不要这个插件。不影响服务端 —— 站点仍然可以提交那个插件的会话
   * （用户自己用 CLI 就行），这里只是让客户端不再给出那个按钮。
   */
  // 开关按 id 记，不按短名。池是全局的：两个站点可以各有一个叫 `jupyter`
  //   的插件而它们是两个不同的东西（两个 id），按短名记会让一个站点的开关管到
  //   另一个站点的那个。而"我要不要这个插件"针对的是插件本身，不是某个站点
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

  // ── 站点分发 ──

  /** 手动重新对一次账（界面上那个「重新同步」）。 */
  send('app:syncPlugins', async () => {
    if (!backend || !backend.connected) {
      return { ok: false, error: '还没连上站点，插件是从站点取回来的。' };
    }
    const r = await reconcileSitePlugins();
    if (!r) return { ok: false, error: '这次对账已经作废了（连接换了一条）。' };
    return { ok: true, plugins: pluginsView() };
  });

  // 下面两条只服务测试后端：把 `.splug` 装到假站点上、从假站点上撤掉。
  //   界面上没有入口，打包版也没有这两条通道。
  if (testBackend) {
  /**
   * 往假站点上装一个 `.splug`。
   *
   * 装完之后走既有那条对账（`reconcileSitePlugins`），不另写一遍同步：
   *   站点报了它，与真站点逐字一样地下来、过同意闸、然后才加载。假站点的
   *   全部价值就是它演的是同一件事 —— 在这里抄一条"装完直接放进池子"的捷径，
   *   等于把下载校验与同意闸那两段整段跳过，而那两段正是最该被演的。
   *
   * 选空了（`cancelled`）不出提示：用户按了取消，那不是一次失败。
   */
  send('app:installSitePlugin', async () => {
    if (!backend || backend.kind !== KIND.FAKE) {
      return { ok: false, code: 'not_fake',
               error: '只有测试后端那个假站点上才装得了插件。真站点的插件由'
                 + '管理员在集群上用 `slurmate plugin install` 装。' };
    }
    const r = await dialog.showOpenDialog(win.win, {
      title: '选择一个 .splug 装到假站点上',
      message: '真站点上装的就是这个文件（`slurmate plugin install <文件.splug>`）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '插件包', extensions: ['splug'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) {
      return { ok: false, cancelled: true };
    }

    const out = backend.installPlugins(r.filePaths);
    if (!out.ok) return { ok: false, code: out.code, error: out.error };

    for (const c of out.unchanged) {
      win.pushNotice('info', `「${c.title}」已经在假站点上了（${c.dir}），它与`
        + '这一份是同一棵树，所以一个字节都没有写。');
    }
    if (out.installed.length) {
      const names = out.installed.map((x) => `「${x.title}」${x.version}`).join('、');
      const where = out.installed.map((x) => x.dir).join('、');
      win.pushNotice('info', `已把 ${names} 装到假站点上（${where}）。`
        + (backend.connected
          ? '站点这就报它了，接下来与真站点相同：取回来、过同意闸，然后才可用。'
          : '连上假站点之后它才会下来：插件是从站点取回来的。'));
      // `await`（与连接那一次"不 await"不同）：用户按了按钮，而这一次的结果
      //   就是"装上了没有、接下来该看哪儿"。连接那一次是后台的事，这一次不是。
      await reconcileSitePlugins();
    }
    return { ok: true, installed: out.installed, unchanged: out.unchanged,
             plugins: pluginsView() };
  });

  /**
   * 从假站点上撤掉一个插件 —— 与上面那条安装对称，
   * 而它做的是站点那一侧的事：管理员在真站点上敲的那条
   * `slurmate plugin uninstall <id>`，在测试里就是这一条。
   *
   * 它一个字都不动本机池里那一份，这不是遗漏，是这条路的定义：站点上有没有那一棵
   *   树，与本机装没装它，是两件事（`site-plugins.js` 的决定 3 —— 站点不报一个
   *   插件，不构成删掉本机那一份的理由，它随时可能再打开）。真站点上管理员撤掉
   *   之后，本机那一份照样留着、照样能用；这里必须一模一样，否则这个假站点演的
   *   就是另一件事。
   *
   * 界面上那颗「删掉本机这一份」是另一颗按钮，走 `app:dropPluginVersion`
   *   （两端都有），两件事各有各的入口。
   *
   * 权威闸门在这一侧，判据是后端种类（与装那一侧逐字同一条理由）：真站点上撤
   *   插件是管理员的事，客户端这一侧不是"藏起来了"，是真做不到 —— 那是集群上的
   *   一个目录，而客户端连的是 SSH 上的一个守护进程。
   *
   * 不判"有没有会话在跑"：它删的是站点上那一棵，而会话用的是本机那一份。
   *   那道守卫在 `app:dropPluginVersion` 上，因为那一条才真的会抽掉脚下的代码。
   */
  send('app:uninstallSitePlugin', async (id, version) => {
    if (!backend || backend.kind !== KIND.FAKE) {
      return { ok: false, code: 'not_fake',
               error: '只有测试后端那个假站点上才撤得掉插件。真站点的插件由'
                 + '管理员在集群上用 `slurmate plugin uninstall` 撤。' };
    }
    if (typeof id !== 'string' || typeof version !== 'string' || !id || !version) {
      return { ok: false, error: 'id 与版本都必须是字符串。' };
    }
    const out = backend.uninstallPlugins([`${id}@${version}`]);
    if (!out.ok) {
      win.pushNotice('error', out.error);
      return { ok: false, code: out.code, error: out.error };
    }

    const title = (out.removed[0] && out.removed[0].title) || id;
    // 那句话必须说清"本机那一份还在"：不说的话，用户看到那一块还在界面上，
    //   会以为撤掉没生效。而它确实还在 —— 撤的是站点上那一棵。
    win.pushNotice('info', `已经从假站点上撤掉「${title}」。`
      + '本机装着的那一份还在，仍然可用。');
    // 撤掉之后不对账：站点不报它不构成删除理由（决定 3），本机那一份本来就该
    //   留着。下一次对账时站点那一格会如实变成"未启用"。
    return { ok: true, removed: out.removed, problems: out.problems || [],
             plugins: pluginsView() };
  });
  }

  /**
   * 同意一个待分发的插件。
   *
   * 落点是有讲究的：下载后、暂存里验完、`rename` 之前。见 site-plugins.js。
   *
   * 写台账在激活之前。反过来（先激活后写）崩在中间，下次启动它是"没同意"
   *   而用户明明点过，会反复问，或者被后来的人"修"成默认同意。选前者。
   *
   * 同意动作绑定到摘要值：`acceptStaged` 会再核一遍暂存里那份的摘要与对话框
   *   里那个值相同，不同就拒绝 —— 用户同意的是他看到的那个摘要，不是"这个
   *   (id, 版本) 上碰巧躺着的东西"。
   */
  send('app:consentPlugin', async (id, version) => {
    const hit = pendingConsent.find((p) => p.id === id && p.version === version);
    if (!hit) return { ok: false, error: '没有这个待同意的插件（可能已经同意过、或者重新同步过了）。' };

    // ── ① 钉住签名者（§5.4）。写在最前面，在任何文件移动之前。──
    //
    //   放在前面是为了让"钉不上"这件事什么也没做就退出去：`pinPluginKey` 只在
    //   "这个 id 已经钉在另一把钥匙上"时失败，而那本来就不该走到这里（`keyVerdict`
    //   在对话框出现之前就该拦下它）。真发生了，最不该做的事是"先把构件装上去，
    //   再报告钉子不对"。
    //
    //   没签名的那一份（`fingerprint` 是 null）什么都不钉 —— §5.4 是"记下它的
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
      stagedDir: hit.stagedDir, siteRoot: sitePoolDir(),
      // 记录表草稿只在内存里活到这一刻，而下面那一次写就是提交
      //   （见 site-plugins.js 的 acceptStaged）。`existing` 那一份本来就已经提交过
      //   了，所以它没有草稿 —— 那条路只是"原地认领"。
      record: hit.record || null,
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
    // 同意这一步也要记进引用表，不只是"装上"那一步。不记的话，在"刚同意、
    //   还没重新对账"这段窗口里它在引用表上不存在 —— 换到另一个站点时会被按
    //   "没人要它"回收掉。理由见 site-plugins.js 的 noteConsent。
    const nc = sitePluginSync.noteConsent({
      siteRoot: sitePoolDir(), siteKey: hit.siteKey, siteLabel: hit.siteLabel,
      id, version,
    });
    if (!nc.ok) win.pushNotice('warn', `插件装上了，但引用表未能更新（${nc.why}）。`);
    pendingConsent = pendingConsent.filter((p) => !(p.id === id && p.version === version));
    await registry.reload();
    const p = registry.get(id, version);
    if (!p || p.active === false) {
      const why = `同意之后它仍然没有被加载，看「插件没有加载」那几条。`;
      win.pushNotice('error', why);
      return { ok: false, error: why, plugins: pluginsView() };
    }
    win.pushNotice('ok', `已同意并装上「${p.displayName}」${p.version}。`);
    // 同意之后，同一个插件的上一版可能已经没有任何站点要了 —— 而"没人要它"
    //   这个结论只有对账下得了（回收只认快照表里的引用，见 site-plugins.js 第 6 步）。
    //   不在这里补一次的话，池里会同时躺着两版、界面上两颗同名的块，要等到下一次
    //   连上站点才收掉（2026-10-18 真机：升级插件之后断开重连才变回一个）。
    //
    // 它不改变同意的结果：插件已经装上了。对账失败只补一句，下一次对账会再试。
    try {
      await reconcileSitePlugins();
    } catch (e) {
      win.pushNotice('warn', `插件装上了，但旧版本这次没收掉：${e.message}`);
    }
    // 对账在里面会重扫一次注册表，但那一步只在对账真的换了东西时发生（见
    //   site-plugins.js 第 8 步）。这里再扫一遍，是因为界面手里那份视图来自
    //   注册表 —— "装完还看见两个版本"最没必要的一种来路，就是池里已经干净了、
    //   而注册表还攥着已经删掉的那一个对象。
    await registry.reload();
    return { ok: true, plugins: pluginsView() };
  });

  /**
   * 不同意。
   *
   * 两种情形的出路不同，因为"待同意的那一份"是两样东西：
   *
   *   `existing: false` 它是一份草稿（刚取回来、在暂存里），删掉草稿。
   *                     站点那一份一个字节没动。
   *   `existing: true`  它已经在池里（上一次下来过、只是台账对不上），删掉
   *                     池里那一份。
   *
   *   后者必须真的删：留着的话它就是一个"用户在界面上拒绝了、却仍然躺在磁盘上"
   *   的插件，而且下次对账会以同一个形状回来（台账里没有它、树还在）——
   *   用户点一百次不同意也去不掉它。
   *
   * 同样不在文案里断言是他删的：这里是他点的，但"同不同意的判据"与
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
      await registry.reload();
      win.pushNotice('info', `没有同意「${hit.title || hit.name}」，本机这一份已经删掉了。`
        + '站点上那份不受影响：它还在时，下次同步会再问一次。');
    } else {
      sitePluginSync.discardStaged(hit.stagedDir);
      win.pushNotice('info', `没有同意「${hit.title || hit.name}」，它在暂存里那一份已经删掉了。`);
    }
    pendingConsent = pendingConsent.filter((p) => !(p.id === id && p.version === version));
    return { ok: true, plugins: pluginsView() };
  });

  /**
   * 删掉本机池里的一个版本 —— §5.3「删掉本机那一份 = 撤回同意」。
   *
   * 它是客户端这一侧唯一那条删除，两端都有（真站点、假站点一样）：删掉之后本机
   *   就没有它了，而站点那一边不受影响 —— 下一次对账（连上，或者点「重新同步」）
   *   站点还在分发它，于是重新下来、重新过一遍同意闸。那正是设计里那条路：
   *   删除是一个没说出口的决定，而对账不认识它。
   *
   * 两个入口画它：插件那一列里的每一块，以及「本机有 N 个插件没有被加载」
   *   那一块（见 panel.js）。后者是它从前唯一的入口 —— 那一档里的插件没有别的
   *   地方可去，而在那之前"池里有一份、台账对不上"在界面上是一片空白。
   *
   * 删完还要 `forgetPlugin`：台账里那条（如果有）一并消失。不删的话，下次对账
   *   会按"摘要与台账相符"静默装回来、一个字都不问 —— 而那正是 §5.3 要防的
   *   那一件事。删掉之后它走进待同意，用户重新点一次。
   */
  send('app:dropPluginVersion', async (id, version) => {
    if (typeof id !== 'string' || typeof version !== 'string') {
      return { ok: false, error: 'id 与版本都必须是字符串。' };
    }
    // 有会话在跑就先拦住：它删的是本机那一份代码，而 `registry.reload()` 之后
    //   那个插件就从注册表里消失了 —— 一条跑着的会话脚下会空掉。
    //   这道守卫从前不必需（那颗按钮只画在"没有被加载"的那一档上，而有会话跑着的
    //   插件一定是加载着的）；现在每一块插件上都有它，于是这一格成了必经之路。
    //   与 `app:deletePluginData` 那条守卫同一条理由：那种动作要先问过用户，
    //   而这里问不出一个有意义的"要不要"，所以给的是出路 —— 先把会话结束掉。
    const busy = livePlugins().get(id);
    if (busy && busy.length) {
      return { ok: false, code: 'in_use',
               error: '这个插件还有会话在跑，先把它结束掉再来删。' };
    }
    const d = sitePluginSync.dropPooledVersion(sitePoolDir(), id, version);
    if (!d.ok) { win.pushNotice('error', d.error); return { ok: false, error: d.error }; }
    config.forgetPlugin(cfgDir, cfg, id, version);
    await registry.reload();
    win.pushNotice('info', `本机那一份 ${version} 已经删掉了。`
      + '站点还在分发它时，下一次同步会重新问你一次。');
    return { ok: true, plugins: pluginsView() };
  });

  /**
   * 面板启动时拉一次全量。
   *
   * 回的是列表 + 哪一个是前台，不是"那一个快照"。回一个快照的失败形态不是
   *   崩溃，而是看不见：启动时自动接上来的会话里，只有最后一条会被画出来，
   *   其余的既没有标签也没有「结束会话」的入口。
   */
  send('app:states', async () => ({
    sessions: sessionViews(),
    front: frontSlot(),
    // 面板有没有抬在会话页面之上。界面靠它决定状态条右侧那两颗露不露 ——
    //   连着之后拉一次状态的那条路（`handleConnectResult`）也要拿得到它，
    //   少了这一格，重连之后那两颗会停在上一次的样子。
    panelFront: win ? win.panelFront : false,
    workspaces: config.workspacePlan(cfg),
  }));

  /**
   * 「作业列表」那一屏：这个站点上我还有哪些作业（`op:list`）。
   *
   * 它是一次真查询，不是缓存 —— 而且必须是这样。作业列表回答的是"现在有什么"，
   *   而它的变化来源有一大半在本进程之外（另一台电脑提交的、CLI 提交的、
   *   调度器把排队中的作业跑起来的）。拿本机那张会话表当答案，用户就会在
   *   "作业明明在跑"的时候看见一个空列表。
   *
   * 失败原样带回去（连 `error.kind` 一起）：界面要分得开"没连上"、"守护进程
   *   不可达"与"确实一条都没有" —— 把后者当前两者画，用户会以为作业丢了。
   */
  send('app:jobs', async () => {
    const resp = await backend.rpc({ op: 'list' });
    if (!resp || !resp.ok) return resp || { ok: false, error: { detail: '无响应' } };
    return {
      ok: true,
      jobs: jobsView((resp.data && resp.data.sessions) || []),
      at: Date.now(),
    };
  });

  /**
   * 【接管】—— 把这条会话的看护者换成这台电脑。
   *
   * 它一个字都不动会话（作业、ACL、端口、心跳时刻全都不动），这一点由守护
   *   进程那一侧保证（`op_takeover` 的 docstring）。界面要说的话也只有一句：
   *   "从现在起这台电脑在看它"。
   *
   * 而它只能走常驻通道：身份（`client`）只在常驻通道上报，走 exec 退路时
   *   会被删掉（见 backend-ssh.js 的 `rpc()`）。那时守护进程回 `no_client_id`，
   *   界面要如实说出来 —— 这条路不能悄悄降级成"什么都没发生"：用户点的是
   *   "这台电脑现在做主"，而作业那边一个字节都没变。
   *
   * 成功之后立刻打一次心跳，不等 45 秒的定时器。守护进程那边刻意没有在
   *   接管里顺手刷新 `last_hb_socket`（"接管只动一格"是一条不变量），代价是
   *   "在 1800 秒大限前 40 秒才点接管"有一个窄窗口 —— 那一半在客户端补。
   *
   * 而它必须先 `resume()`：这条会话可能正停在"被接管"那个终态上
   *   （上一台电脑把它拿走了，本机的心跳被回 `ignored`）—— 那正是用户会来点这个
   *   按钮的主要场合。不撤销那个终态的话，接管在服务端生效了、在客户端却
   *   一句都没变：心跳那道闸把它自己挡掉，界面继续写"已被另一台电脑接管"。
   */
  send('app:takeover', async (payload = {}) => {
    const sid = String((payload && payload.sessionId) || '');
    if (!sid) return { ok: false, error: { detail: '没有说清要接管哪一条会话。' } };
    const resp = await backend.rpc({ op: 'takeover', session_id: sid });
    if (resp && resp.ok) {
      // 接管成功之后它不再属于"只保活"那一档。
      keepAliveSids.delete(sid);
      if (!keepAliveSids.size) stopKeepAlive();

      let rec = [...sessions.values()].find(
        (x) => x.controller && x.controller.sessionId === sid);
      // 本机之前没有接它（看护者是别人，或者为空）：接管之后才把它接回来。
      //   少了这一步，服务端那一格已经换成本机，而本机没有隧道、没有页面，
      //   用户看到的是"接管成功，然后什么都没有"。
      if (!rec) {
        const one = await rpcAfterRateLimit({ op: 'status', session_id: sid });
        const view = one && one.ok && one.data && one.data.session;
        if (view) {
          await reattachOne(view);
          rec = [...sessions.values()].find(
            (x) => x.controller && x.controller.sessionId === sid);
        } else {
          win.pushNotice('error', '接管成功了，但未能读回这条会话的完整信息：'
            + whyOf(one) + '。再连一次这个站点会把它接回来。');
        }
      }
      // 立刻续一次命：那一条是本机接着的才打得了心跳（别的连心跳都没有）。
      if (rec && rec.controller) {
        // 先撤销「被接管」这个终态，再补那一拍 —— 顺序不能反。
        //    `_beat()` 顶上有一道闸（被接管的会话一拍都不发），反过来的话这一拍
        //    会被自己的闸挡掉，而"在 1800 秒大限前 40 秒才点接管"那个窄窗口就
        //    原样留着 —— 症状是接管成功、界面说"已接管"，而作业到点被 scancel。
        //   而它也正是"上一台电脑又要把这条会话拿回去"这条路的落点：那台机器
        //     此刻正停在 `suspend()` 的终态上，不让它出来，【接管】就对它无效。
        rec.controller.resume();
        try { await rec.controller.heartbeatNow(); } catch { /* 接管已经成功了 */ }
      }
      // 用户点的是「接管」，接下来要看的就是它 —— 与连接站点时"停在面板上"
      //   不是同一种意图：那一次用户没有点任何一条会话。
      if (rec) win.setFront(rec.slot);
      win.pushNotice('info', `已接管这条会话：从现在起由这台电脑看护它（作业一个字都没动）。`);
    }
    win.pushSessions(sessionViews(), frontSlot());
    return resp;
  });

  send('app:doctor', async () => {
    const resp = await backend.rpc({ op: 'doctor' });
    // 老守护进程的回包里没有 `version`：用握手时问到的那个号补上。体检要回答
    //   的第一个问题就是"站点上跑的是哪一版"，而那一格在三处都答得上来时不该
    //   只因为守护进程旧就空着。
    if (resp && resp.ok && resp.data && resp.data.version === undefined
        && connectedDaemonVersion) {
      resp.data.version = connectedDaemonVersion;
    }
    return resp;
  });

  /**
   * 导出诊断材料：客户端知道的那几样，落成一份文本。
   *
   * 只取客户端自己的事实：版本、平台、连接（不含凭据）、插件清单、会话视图、
   *   插件宿主的日志。站点那边的事实由「检查集群」回答，不在这里复述一份 ——
   *   两份答案漂开的时候，用户会把诊断材料当成另一个真相。
   */
  send('app:exportDiagnostics', async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let picked;
    try {
      picked = await dialog.showSaveDialog({
        defaultPath: `slurmate-diagnostics-${stamp}.txt`,
      });
    } catch (e) {
      return { ok: false, error: `未能打开保存对话框：${e.message}` };
    }
    if (!picked || picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(picked.filePath, diagnosticsText());
    } catch (e) {
      return { ok: false, error: `未能写出诊断材料：${e.message}` };
    }
    return { ok: true, path: picked.filePath };
  });

  // `app:cluster` 这个通道没有了。它原先服务的是「集群状态」那一屏，而那一屏
  //   整个搬进了左边栏的浮窗 —— 浮窗的数据由主进程推（见 `refreshSite`），不自己拉。
  //   留着它等于给同一份答案留第二个取数点，而两个取数点必然漂成两句都标着"现在"
  //   的话。三态怎么递的没有变：`refreshSite` 原样保留"获取失败"与"确实没有"的
  //   区别（见那里的注释）。

  /** 最近几天的作业（`sacct`）。按需拉 —— 不进任何一层缓存，见 op_history。 */
  send('app:history', async () => backend.rpc({ op: 'history' }));

  /**
   * 对当前活跃连接测试延迟（TCP + 读 SSH banner）。
   *
   * 与 `app:probeHosts`（探全部）分开：那个是"这一屏上哪几台通"的一次性体检，
   *   而这一条是浮窗上那个按钮 —— 用户问的是"我现在这一台，此刻，延迟多少"。
   *   拿探全部去顶替，等于为了回答一个问题去敲 N 台机器。
   */
  send('app:probeActive', async () => {
    const conn = (cfg.connections || []).find((c) => c.id === connectedConnId);
    if (!conn) return { ok: false, error: '没有连着的站点。' };
    if (testBackend && conn.id === TEST_CONNECTION_ID) {
      return { ok: false, error: '这是本机的假站点，没有可探测的地址。' };
    }
    const r = await hosts.probeHost(conn);
    return r && r.reachable
      ? { ok: true, rttMs: r.rttMs }
      : { ok: false, error: (r && r.error) || '没有回应' };
  });

  /**
   * 边栏那两格的停靠 / 钉住 / 收起。
   *
   * 收起不走这里（除了显式的那一种）：它是鼠标几何判的，在主进程那一侧
   *   （见 windows.js 的 `_startCursorWatch`）。界面只说"我停上去了"与"我点了一下"。
   */
  send('app:hover', async (payload = {}) => {
    const side = payload && payload.side;
    if (!side) { win.hideHover(); return { ok: true, pinned: null }; }
    if (side !== 'left' && side !== 'right') return { ok: false, error: '没有那一条边栏。' };
    if (payload.pin) {
      // await：`showHover` 要懒建那一层并等它 loadFile 完。不等的话，紧跟着的
      //   `pushSiteToHover` 会推给一个还不存在的 webContents（静默丢掉），
      //   而症状是"头一次点钉住，面板是空的，得挪开再停一次才好"。
      const pinned = await win.toggleHoverPin(side);
      // 解开钉住 = 收起来了（那一下不推、也不起轮询）。
      if (!pinned) return { ok: true, pinned };
      if (side === 'left') pushSiteToHover(side);
      if (side === 'right') startOutPoll();
      return { ok: true, pinned };
    }
    await win.showHover(side);
    // 两条路（停靠 / 钉住）都要做同样的事：那条"钉住走的是另一个分支"的缝
    //   漏掉任何一半，症状是"点一下钉住，右栏永远是空的"（或者左边不刷新）——
    //   而两条路在界面上看起来一样。
    if (side === 'left') { refreshSiteIfStale(); pushSiteToHover(side); }
    // 右栏一开就起轮询，而它自己会停（见 `startOutPoll` 里那两条判据）——
    //   「收起」走的是窗口那一层（鼠标几何 / Esc），主进程拿不到回调，所以停这件事
    //   只能由这个定时器自己发现。`pushSiteToHover` 那一套同理：左边那份是推
    //   过来的，右边这份要拉（它在跑着的时候一直在变）。
    if (side === 'right') startOutPoll();
    return { ok: true, pinned: null };
  });

  /** 右栏那个「更多」：把行数提到上限再拉一次（用户往上滚要更多历史时按）。 */
  send('app:outMore', async () => outMore());

  /**
   * 按需取某一个会话的作业日志（作业屏上那份详情用）。
   *
   * 它与右栏那个轮询走同一条 op，但不经过 `frontSlot()`：作业结束之后
   *   右栏就收了，而"为什么失败"恰恰在那一刻最该看得见 —— 那条会话行在站点的
   *   `released_keep` 窗口内还在，所以同一条 op 照样答得上来。
   * 这也让它能问不是前台的那一条（作业屏上点哪条就问哪条）。
   */
  send('app:jobLog', async (payload = {}) => {
    const sid = payload && payload.session_id;
    if (!sid) return { ok: false, error: '没有说清是哪一条会话。' };
    if (!backend || !backend.connected) return { ok: false, error: '没有连着的站点。' };
    const req = { op: 'job_log', session_id: sid };
    if (payload.lines) req.lines = payload.lines;
    let resp = null;
    try {
      resp = await backend.rpc(req);
    } catch (e) {
      return { ok: false, error: (e && e.message) || '没有回应' };
    }
    if (resp && resp.ok && resp.data) return { ok: true, data: resp.data };
    const err = (resp && resp.error) || {};
    if (err.kind === 'unknown_op') {
      return { ok: false, unsupported: true,
               error: '这个站点的守护进程还没有"查看日志"这个能力（升级之后才有）。' };
    }
    return { ok: false, error: err.detail || err.kind || '控制节点没有说明原因' };
  });

  /** 把某一条会话抬到面板上面。纯界面动作 —— 它不改任何框架状态。 */
  send('app:setFront', async (payload = {}) => {
    const slot = payload && payload.slot;
    if (!sessions.has(slot)) return { ok: false, error: '没有这一条会话。' };
    win.setFront(slot);
    await _renderSession(slot);
    win.pushSessions(sessionViews(), frontSlot());
    return { ok: true, front: slot };
  });

  /**
   * 反过来：把面板抬到会话页面上面。纯界面动作 —— 会话、隧道、作业一个字
   * 都不动（与 `app:setFront` 正好是一对）。
   *
   * 它存在的理由是一处物理事实：会话那块页面是原生视图，从 y=30 往下盖住
   *   整个窗口主体 —— 面板自己身上的按钮那时一个都够不着。所以"回到面板"这件事
   *   必须由窗口那一层来做（见 windows.js 的 `showPanel`）。
   *
   * 它不设条件：状态条上那颗「面板」按钮的显隐是界面的事。
   */
  send('app:showPanel', async () => {
    win.showPanel();
    // 推一份新的会话状态：`front` 一个字没变，但 `panelFront` 变了 ——
    //   状态条右侧那几颗按钮（重新加载 / 结束会话）的显隐跟着它走。
    //   少了这一句，用户点「面板」回来之后那几颗还停在会话页面时的样子。
    win.pushSessions(sessionViews(), frontSlot());
    return { ok: true };
  });

  // 只有一个语义：结束会话并释放资源。没有「保持作业运行」的开关。
  //
  // 必须指名停哪一个。省略 slot 一律拒绝，而不是"停那唯一的一个" ——
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

  // ── 测试后端的接缝 ────────────────────────────────────────────────────────
  //
  // 这几条通道只在这个进程是测试后端时注册；打包版没有它们，界面也没有入口。
  // 它们造的是真机上极难复现的状态（守护进程挂掉、旧版本、另一台电脑在看…）。
  if (testBackend) {
  send('app:debug', async (what, arg) => {
    if (!backend || backend.kind !== KIND.FAKE) return { ok: false, error: '只有测试后端能注入这些状态。' };
    if (what === 'daemon-down') backend.debugDaemonDown(20000);
    else if (what === 'tunnel-down') backend.debugTunnelDown(15000);
    else if (what === 'reap') backend.debugReap();
    // 「集群信息缺失」——真集群上要么得等一次故障、要么得把 sinfo 改名，
    //   而"把获取失败画成没有"正是这一整块最容易犯的错。它必须能立刻造出来。
    //   `arg` 指名哪一格（省略 = 全部）；`history` 那一格走的是错误不是缺席。
    else if (what === 'cluster-missing') {
      if (arg === 'history') backend.debugHistoryDown(true);
      else backend.debugClusterMissing(arg || null);
    }
    else if (what === 'reset') backend.debugReset();
    // 让假站点"装了本客户端不认识的插件" —— 这一条路是"插件增减不许崩"的验收
    //   路径，必须能在测试里走到。
    //   短名由假站点自己取（见 backend-fake 的 DEMO_EXTRA_NAME）：那一格要造的
    //     是"站点上有一个本机不认识的插件"，与它叫什么无关 —— 而基座里不许出现
    //     任何真插件的名字，所以这里连缺省值都不写。
    //   带 `arg` = 指名一个短名（DevTools 那条路，以及"要它和池里某个同名插件
    //     对上"的用例）。界面上那颗按钮不带。
    // 「这个客户端里没有带打包器」—— 安装包里漏带它时就是这副样子：站点报得出
    //   插件、却一个都发不出来。它在这台开发机上造不出来（打包器就在仓库里），
    //   而那条路上有两句话要验。
    else if (what === 'no-packer') backend.debugNoPacker(arg !== false);
    else if (what === 'extra-plugin') backend.debugAddSitePlugin(arg || null);
    // 站点侧那三个开关作用在哪一个插件上由调用方指定（不指定就取列表里
    //   第一个）—— 基座里没有插件名可写。一个都没装时这些开关无事可做，如实
    //   说出来，而不是静默地什么也没发生。
    else if (what === 'site-plugin-off' || what === 'site-plugin-no-job') {
      const picked = pickPlugin(arg);
      if (picked.error) return { ok: false, error: picked.error };
      // 这两件事不一样，所以是两个开关、两个 debug 方法：`off` 是管理员的
      // 开关（界面说"本站没开放它，找管理员"）；`no-job` 是本站部署没跟上
      // （界面说"装了它，但它没有作业侧实现"—— 管理员去开一下开关没用）。
      if (what === 'site-plugin-off') backend.debugDisableSitePlugin(picked.plugin.name);
      else backend.debugSitePluginNoJob(picked.plugin.name);
    }
    // 让假站点报一个指定的基座版本 —— 造版本握手那几态里真机上造不出来的两态
    // （站点比客户端新、以及两个大版本之间）。不传参数 = 恢复成"跟着本客户端走"。
    else if (what === 'daemon-version') backend.debugDaemonVersion(arg);
    // 造出「守护进程太旧，连 plugins 这个 op 都没有」—— 那条路上每一个字段
    // 都是缺的，而客户端的纪律是"缺席 ≠ 否"。
    else if (what === 'old-daemon') backend.debugOldDaemon(true);
    // 把每一条会话显示成「另一台电脑在看」。真集群上这一幕要两台机器
    //   才造得出来（在一台上开着、去另一台上打开），而【接管】这个按钮的全部
    //   意义就是那一刻 —— 它的判据（keeper 不是本机）在测试里必须能先看
    //   一遍。也顺便造出「本机在看 / 另一台电脑在看 / 没人在看」三句话里的
    //   第二句，否则那一句在测试里永远看不到。
    //   不带参数 = 打开（与 `extra-plugin` / `old-daemon` 那几个单向开关同一
    //   形状）：撤销它走「复位」，而不是让同一个按钮在两种意思之间来回翻 ——
    //   一个不知道自己现在是开还是关的按钮，就是一颗会骗人的按钮。
    //   传空串是第三种现场：`keeper` 为空 = 没人在看（会话是 CLI 提交
    //     的那种）。它没有按钮，在 DevTools 里 `window.slurmate.debug('foreign-keeper', '')`。
    else if (what === 'foreign-keeper') {
      backend.debugForeignKeeper(arg === undefined ? true : arg);
    }
    // 与上一条是两件事：这一档有 `plugins`、但没有 `limits`（更旧的守护
    //   进程）。客户端的处理必须一样（回退），但代码路径不同（一个是 unknown_op，
    //   一个是字段缺席）—— 只造其中一条的话，另一条上的退化没人看得见。
    else if (what === 'old-distribute') backend.debugOldDistribute(true);
    // 站点级的插件问题（账本 F22）—— 但没有按钮：这一格说的是"本站有个
    //   包坏了、坏在哪"，而假站点编不出这个事实（它的分发源是真插件，都装得好
    //   好的）。所以它只能从 DevTools 里带上一条照真守护进程措辞写的串：
    //     window.slurmate.debug('plugin-problems', '…：这是一个目录，不是一个插件包…')
    //   传空数组清掉。给一个按钮就得有默认文案，而默认文案只能是编的。
    else if (what === 'plugin-problems') backend.debugPluginProblems(arg === undefined ? [] : [arg]);
    // 站点给插件配的默认 GRES（`defaults.gpus`）。与上面那条同一个理由
    //   没有按钮：真站点上它是每个插件一份的管理员声明，而假站点只有一份
    //   全局的，编一个默认值就是演一个不存在的站点。
    //     window.slurmate.debug('default-gpus', {name:'gpu', type:'a6000', count:1})
    //   不传参数 = 清掉（"本站没配"）。
    else if (what === 'default-gpus') backend.debugDefaultGpus(arg === undefined ? null : arg);
    // 站点报了一个超过单文件上限的文件，「站点支持分发，但这一份装不上」。
    else if (what === 'plugin-too-big') backend.debugBloatPlugin(arg || null);
    // 限流不是失败：假后端先回几次 rate_limited，对账必须退避之后照样成功。
    else if (what === 'rate-limited') backend.debugRateLimit(Number(arg) || 3);
    else return { ok: false, error: '未知的调试动作' };
    return { ok: true };
  });
  }
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
   * 判据：这里只留今天真有用例踩着的入口。一个接缝成员被零个用例用到，
   *   就是"意图写了、测试没写"—— 它让下一个人以为某条用例正踩着这里，而实际上
   *   没有人守着它。
   */
  _test: {
    getBackend: () => backend,
    /**
     * 后端正连着的那条连接的 id（没连着时 null）。
     *
     * 用例要问"我们现在在哪一条上"时用它，不要用 `getCfg().activeConnectionId`
     *   —— 那个答的是"下一次要用哪一条"，而这两件事可以不一样：界面是先
     *   `setActiveConnection` 再 `connect`（见 `doConnectTo`），而只设活跃不连接
     *   的入口也不止一处。拿它当"我在哪"会让用例在那些前提下问错问题
     *   （把一次重连当成换站点，或者反过来）。
     */
    getConnectedConnId: () => connectedConnId,
    /**
     * 活着的会话：槽 → 记录。
     *
     * 用例需要的是"现在有哪几条、各自什么状态"，那正是这一份。
     */
    getSessions: () => sessions,
    /** 「只保活、不接管」的那些 `session_id`（见 `keepAliveSids`）。 */
    getKeepAlive: () => [...keepAliveSids],
    /** 把空手超时调到毫秒级 —— 生产路径上它是十分钟（见 `EMPTY_HANDS_MS`）。 */
    setEmptyHandsMs: (ms) => { emptyHandsMs = ms; },
    getEmptyHandsMs: () => emptyHandsMs,
    /** 客户端对外的版本号（两段）。用例要证明 npm 载体那个第三段不会带出去。 */
    wireVersion,
    /** 某一槽的记录（`getSessions().get(slot)` 的糖，用例里读起来短一点）。 */
    sessionAt: (slot) => sessions.get(slot),
    getWindow: () => win,
    /** 一条连接的密钥（读不到就返回错误对象）。测试用它核对「按连接隔离」。 */
    getKey: (id) => resolveKey(id || config.PENDING_ID),
    getCfg: () => cfg,
    /**
     * 插件数据目录的根。端到端用例靠它断言"插件写出来的那三个文件落在哪儿、而真正的
     * 家目录一个字节都没被碰过"。它与 `ctx.dataDir()` 同源（都走 `pluginDataRoot`）
     *   —— 各算一遍的话，用例就会守着一个用户永远拿不到的路径。
     */
    getPluginDataRoot: () => pluginDataRoot(),
    /** 钉子表（按 id 记的公钥指纹，§5.4）。它在另一个文件里，不是 cfg 的一部分。 */
    getPinnedKeys: () => pins,
    /**
     * 待删清单（此刻删不掉、安排在下一次启动时清的那些）。
     *
     * 它是那个文件的在内存里那一份，用例直接改它 —— 改完记得还原（它跨用例
     *   活着），否则后面每一条用例都会在一个凭空多出来的待删目录上跑。
     */
    getPendingRemovals: () => pendingRemovals,
    /**
     * 重跑「开机补删」那一步（`sweepPendingRemovals`）。
     *
     * 启动那一趟只发生一次（index.js 只 require 一次），所以不重新触发就没法
     *   验证它。它与启动时跑的是同一个函数、看的是同一份清单 —— 而"启动时
     *   真的调它"那一条由 `client/test/boot.test.mjs` 的源码判据守着（次序是
     *   它成立的全部理由，见那个函数的注释）。
     */
    sweepPendingRemovals: () => sweepPendingRemovals(),
    /**
     * 重跑「启动时接上已有会话」那条路（`tryReattach`）。
     *
     * 它只在启动时被调用一次，所以不重新触发就没法验证。先把表清掉是
     * 还原现场而不是绕过什么 —— 启动那一刻它本来就是空的。
     *
     * 但光把引用清掉还不够：真机上重启时这个进程整个没了，它的监听套接字、
     *   轮询、心跳跟着一起消失；只在同一个进程里换个引用的话，模拟出来的现场是
     *   两个客户端同时在跑 —— 旧的那个还占着端口在监听、还在轮询状态，收尾时
     *   进程退不掉（症状是整个测试文件凭空多花几十秒，而每条用例自己都是绿的）。
     *   所以旧的先 `abandon()` —— 只释放本地资源，一个字都不发给服务端。
     *
     * 临时那份那张表也要清，理由与 `sessions` 逐字相同：真机上重启之后
     *   它一定是空的（它只活在内存里）。不清的后果不是"用例红"那么轻 ——
     *   一份上一个进程的临时数据会跟着新认领的那些一起数，于是"重启后各拿一份"
     *   这条用例会以为认领多造了一份，而真实的路径上根本没有这一格。
     * 清的时候不回收（不调 `releaseEphemeral`）：真机上进程没了，那两份
     *   数据就留在盘上等着对账去认 —— 那正是"崩溃残留"该有的样子，别在夹具里
     *   把它抹平。
     */
    reattach: async () => {
      const old = [...sessions.values()];
      sessions = new Map();
      tempSpaces = new Map();
      for (const rec of old) if (rec.controller) await rec.controller.abandon();
      return tryReattach();
    },
    /**
     * 重跑一次测试连接的播种（它只在启动时跑一次）。
     *
     * 用例把测试连接删掉之后要靠它找回来 —— 那条路只在启动时走，不重跑就没法验。
     */
    seedTestConnection: () => ensureTestConnection(),
    /**
     * 把假站点的夹具那一棵就地换掉，并丢弃那张启动快照（传 `null` = 恢复默认那棵）。
     *
     * 用例要的现场是"站上一个插件都没有"（那里放一个空目录），而真机上那意味着
     *   换一棵树 + 重启 —— 一个进程里 index.js 只加载一次，所以只能这么造。
     * 它只动夹具那一处：装上去的东西在临时 userData 里，用例自己那份本来就是空的。
     *
     * `backend` 可能还没有（`bootstrap` 之后才建）：那种情况下这一句仍然是
     *   有效的 —— override 是每次现算的（后端建起来读的正是它），而没有后端也
     *   就没有那张快照要丢。少了这一格的话，"在第一条用例之前把树指过去"这件事
     *   根本做不到（那正是它现在的第一个调用者要做的）。
     */
    setSampleDir: (dir) => {
      sampleDirOverride = dir || null;
      if (backend) backend.forgetSiteIndex();
    },
    /** 插件注册表。测试用它验证「未知插件不崩」「重新扫描模拟装/卸插件」。 */
    getRegistry: () => registry,
    /** 界面会看到的插件视图（四个条件求交的结果，见 pluginsView）。 */
    getPluginsView: () => pluginsView(),
    /** 上一次对账的结果（三态的原样）。 */
    getSiteSync: () => siteSync,
    /**
     * 对账此刻闲着吗：没有在飞的一轮、没有待补的一轮、也没有排着的回收。
     *
     * 用例要造"池里多一版没人要的旧版本"的现场，而任何一轮对账都会当场把
     *   它收掉 —— 所以造现场之前必须确认对账真的停了，否则那条判据测的就成了
     *   "对账顺手回收了"，而不是"会话结束触发了对账"。
     */
    siteSyncIdle: () => !siteSyncRunning && !siteSyncAgain && !siteReclaimTimer,
    /**
     * 手动跑一遍"站点上的插件清单变了没有"（`checkSitePlugins`）。
     *
     * 它平时由定时器按分钟级跑，用例不能真等那一分钟。返回 `true` 表示认出了
     *   一次变化（并且已经排了一轮对账）。
     */
    checkSitePlugins: () => checkSitePlugins(),
    /**
     * 手动起一轮对账（`reconcileSitePlugins`）。
     *
     * 用例要造"两轮撞在一起"的现场：先连着调它两次，看第二条请求是另起一轮
     *   （那会把在飞那一轮作废）还是只记成待办。
     */
    reconcileSitePlugins: () => reconcileSitePlugins(),
    /** 待同意的那些。 */
    getPendingConsent: () => pendingConsent,
    /** 站点池在哪（测试要直接看盘上的东西）。 */
    getSitePoolDir: () => sitePoolDir(),
    /**
     * "装上去的东西"那一处在哪（测试要直接看盘上的东西，见 `installPlugins`）。
     *
     * 它与站点池是两个方向：站点池是客户端从站点取回来的，这一处是
     *   站点上装着的（假站点拿它当分发源）。别拿一个当另一个。
     */
    getSiteInstalledDir: () => siteInstalledDir(),
    /**
     * 临时那份数据那张注册表（`id → {id, pluginId, group, ports}`，只活在内存里）。
     *
     * 用例要断言的是"它没了"（会话结束之后回收干净），而那件事没有别的
     *   观测面：那份数据不在配置里（所以 `getCfg()` 看不见），它那条会话的记录也已经
     *   被收掉了。盘上那两半各有一条用例（目录在不在），但"注册表里那一格清了"
     *   是第三件事 —— 少了它，一条"回收时只删了磁盘、没删注册表"的实现会全绿。
     */
    getTempSpaces: () => tempSpaces,
    /**
     * 对账的 `held` 里会话那一半（`liveDataDirs()` 现在报的那些目录名）。
     *
     * 用例要断言的是"一条活会话正用着的那份数据在护着"，而那件事没有别的
     *   观测面：`app:pluginData` 那一屏会把活会话那一份从行里滤掉，隔着两层
     *   判不出来。这一格给的是判据本身。
     */
    getLiveDataDirs: () => [...liveDataDirs()],
  },
};
