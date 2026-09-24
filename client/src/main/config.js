'use strict';
/**
 * config.js —— 本地配置与凭据的持久化。
 *
 * ⚠️ 这个文件**不对用户暴露**。所有条目都在界面上，界面上没有任何「打开配置文件」
 *    的入口 —— 用户不该为了改一个地址去手编辑 JSON。
 *
 * 三条设计原则，都是被这个项目里反复出现的「静默失败」逼出来的：
 *
 * 1. **写盘一律原子**（写临时文件 + rename），且**显式 chmod**。`writeFileSync` 的
 *    mode 参数在文件已存在时不生效 —— 光靠它会让一个曾经 0644 的凭据文件永远是 0644。
 *
 * 2. **凭据存储绝不静默降级**。Linux 上没有 keyring 时 `safeStorage.isEncryptionAvailable()`
 *    返回 false；此时【不能】悄悄改成明文写盘。调用方必须拿到一个明确的结果，
 *    由界面如实告诉用户「这台机器存不了密钥」。悄悄写明文，正是我们一路在清的那类问题。
 *
 * 3. **只存推导不出来的东西**。SSH 公钥能从私钥推出来（见 keys.js），所以这里不存它 ——
 *    存两份就可能不一致，而症状只是「认证失败」，指不回根因。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const atomicWrite = require('./atomic-write.js');

const SCHEMA = 6;   // 2：profile → connections；3：永远加密保存；4：每条连接一把密钥；
                    // 5：**布局组**（layouts[] + connections[].layoutId）取代 slots
                    // 6：**站点分发**（trustedPlugins 同意台账 + devPlugins 开关）
                    //
                    // ★ 6 之后**删掉过一个键**：`devPlugins`（本机池加不加载）。
                    //   **没有升号**，因为删键不需要迁移 —— 老 config.json 里那一条
                    //   今天没有任何读者，下一次 saveConfig 顺手就把它丢了。升号是
                    //   给"必须搬一次"的改动用的，不是给"少了一个键"用的。

// 私钥在磁盘上的存放形态。**只有一种能写、也只有一种能读**：encrypted。
//
// ★ v0.7 之前还有 'plain' —— 旧界面上有一个「明文保存（不推荐）」的选项，于是
//   磁盘上可能留着一份明文。读它的那条路删掉了。理由：一份能被读出来继续用的明文
//   私钥，最该做的事是**被发现**，而"顺手把它加密重存"等于让它再活一轮；在没有旧
//   部署的前提下（0.y），那条路只有成本。今天遇到它，与遇到别的认不出的 mode 是
//   同一条路：报 bad_mode。
const SECRET_ENCRYPTED = 'encrypted';

/**
 * 「新建连接」时先于连接存在的那把密钥，占一个保留 id。
 *
 * 为什么需要它：一条新连接的密钥必须在**用户点保存之前**就存在 —— 否则
 * 「保存并连接」的第一次尝试必然认证失败（公钥还没来得及注册）。所以流程是
 * 打开新建表单 → 生成密钥 → 用户复制去 IDM 注册 → 填地址 → 保存，一次走完。
 *
 * 它落盘的，而且**跨重启保留**：用户可能复制完公钥、去 IDM 注册、中途关掉客户端
 * 再回来。丢掉它等于让刚注册的那把公钥当场作废，而症状只是「认证失败」。
 * 连接 id 是 `c<hex>`，与它不可能相撞。
 */
const PENDING_ID = '__pending__';

const DEFAULTS = {
  schema: SCHEMA,
  // 登录节点连接条目。支持多条是因为同一个登录节点常有多个入口
  // （内网、公网域名、跳板机），换网络环境时不该重新填一遍。
  connections: [],          // [{ id, label, user, host, port, layoutId }]
  activeConnectionId: null,
  // 主机密钥指纹（TOFU）。键是 "host:port"，值是 "SHA256:…"。
  // ssh2 默认【不校验】主机密钥，不自己存一份就等于裸奔（见 backend-ssh.js）。
  hostKeys: {},
  // 布局组。一组 = 一个**永不复用**的存储身份 = 一条 code-server 的编辑器布局。
  // 数组顺序即界面顺序（映射图的列序、下拉的选项序都靠它）。
  layouts: [],              // [{ id, name, port }]
  // 插件在本机的开关：{ 插件名: { enabled: bool } }。
  //
  // ★ 这是「安装/卸载」在客户端那一半。**缺省是"跟着站点走"**：名字不在表里
  //   = 没表过态 = 用站点说了算。所以升级不会因为多出这个字段而改变任何行为，
  //   而用户关掉一个插件之后，重启客户端它还是关着的。
  // ★ 它**不**影响服务端：站点仍然可以提交那个插件的会话（用户自己用 CLI 就行），
  //   客户端只是不再给出那个按钮。两边是两件事，见 plugins/index.js 的边界说明。
  // 键是插件的 **id**（那个铸造出来的 ULID），**不是短名**。
  // ★ 这个文件头里以前写的是"插件名" —— 而 `pluginsView()` 与 `app:setPluginEnabled`
  //   从头到尾用的是 `plugin.id`。按那句注释去写代码，得到的是一个"开关莫名失效"
  //   的症状（池是全局的，两个站点可以各有一个叫 jupyter 的插件而它们是两个东西）。
  plugins: {},              // { [id]: { enabled: boolean } }
  // ★ 这里从前还有一个 `devPlugins`（"本机池加不加载"）。它随本机池一起删掉了 ——
  //   那个开关打开之后，`~/.slurmate/plugins/` 里**用户自己放进去的东西**会被加载，
  //   而且是**不过同意闸**的。`docs/PLUGIN-SPEC.md` §5.2 明文禁止给任何一类插件开
  //   免同意的口子，所以它连同它守着的那条路一起没了。今天池里有什么就加载什么。
  // 同意台账（TOFU 一致性）。`{ "<id>@<版本>": { digest, site, at } }`
  //
  // ★ 键里带**版本**：同一个插件的新版本是**另一份构件**，要重新同意一次。
  // ★ `digest` 是**全长 64 位**，由客户端**自己从磁盘上的字节算出来**。它是
  //   **一致性**判据（"和我上次同意的是不是同一份"），不是认证判据（"这是不是
  //   我以为的那个人做的"）—— 后者要签名，见 SECURITY.md。
  //   挡得住"事后偷换"，挡不住"第一次给的就是坏的"。
  trustedPlugins: {},       // { ["<id>@<版本>"]: { digest, site, at } }
};

/** 这个插件在本机开着吗？没表过态 → true（跟着站点走）。 */
function pluginEnabledLocally(cfg, name) {
  const p = (cfg && cfg.plugins && cfg.plugins[name]) || null;
  if (!p || typeof p.enabled !== 'boolean') return true;
  return p.enabled;
}

/**
 * 记下「本机要不要这个插件」。
 *
 * 只存布尔值与插件名 —— 插件名来自**注册表扫到的插件**，不是用户输入，
 * 所以这里不需要担心把任意字符串写进配置。
 */
function setPluginEnabled(dir, cfg, name, enabled) {
  if (!cfg.plugins || typeof cfg.plugins !== 'object') cfg.plugins = {};
  if (typeof enabled !== 'boolean') delete cfg.plugins[name];
  else cfg.plugins[name] = { enabled };
  saveConfig(dir, cfg);
  return cfg.plugins;
}

// ── 同意台账（站点分发的插件）────────────────────────────────────────────────
//
// 与 `hostKeys` 同一先例：一个我自己算出来的值，记在本地，下次拿它比对。
//
// ★ **一致性，不是认证。** 它挡得住"事后偷换"（同一个 id 和版本，这次的内容与
//   我上次同意的那份不一样），挡不住"第一次给的就是坏的"。要挡后者得靠签名
//   （`pinned-keys.json` 那张表 + plugin-package.js 的 keyVerdict），别把这两件事
//   写在同一个句子里。
//
// ── `alg`：这个摘要是**哪一个公式**算出来的 ────────────────────────────────
//
// ★ 台账里存的是**摘要值**，而摘要是一个**函数**的结果。函数换了公式之后，两个
//   值放在一起比就是一句假话 —— 界面上那句"内容摘要从 X 变成了 Y"会说"内容变了"，
//   而真相是"我们换了一把尺子"。
//
// ★ 所以条目里记下算它的那个公式的版本，而 `isTrusted` **要求版本相同**：不同
//   公式算出来的值本来就不该互相作证。于是换公式那天的行为是"重新问一次"（安全
//   的那一侧），而界面能如实说"这是换算法，不是内容变了"。
//
// ★ `TRUST_ALG_LEGACY` 与 `TRUST_ALG` 是**两个**常量，别合并：这个字段是在公式
//   **没变**的那一版里加进来的，所以"条目里没有 `alg`"只能解释成"当时那个公式"
//   = 1。把它默认成"当前公式"的话，换公式那天所有老条目都会被读成新公式 ——
//   而那正是这套字段要防的事。

/** 当前这个公式的版本。1 = 整棵目录的 `plugins.digestOf`。 */
const TRUST_ALG = 1;
/** 条目里没有 `alg` 时按哪个公式解释。**改公式时这一个不会跟着变。** */
const TRUST_ALG_LEGACY = 1;

function trustKey(id, version) { return `${id}@${version}`; }

/** 一条台账条目的算法版本（缺省见 TRUST_ALG_LEGACY）。 */
function trustAlgOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return Number.isInteger(entry.alg) && entry.alg > 0 ? entry.alg : TRUST_ALG_LEGACY;
}

/**
 * 台账里有这个 `(id, 版本)` 且摘要相符吗？
 *
 * ★ 判据必须是**全长的**摘要。`plugin.digest` 以前是截断到 16 位的，拿它当信任
 *   台账的键就是一个 64 位的碰撞面 —— 截断只留给显示。
 *
 * ★ **算法版本也必须相符。** 见上面那一段：不同公式算出来的两个值本来就不可比，
 *   让它们互相作证等于把"换了尺子"读成"东西变了"。
 */
function isTrusted(cfg, id, version, digest) {
  const e = (cfg && cfg.trustedPlugins && cfg.trustedPlugins[trustKey(id, version)]) || null;
  return Boolean(e && e.digest === digest && trustAlgOf(e) === TRUST_ALG);
}

/** 记下一次同意。**由调用方保证写台账发生在激活之前**（见 index.js 的同意动作）。 */
function trustPlugin(dir, cfg, id, version, digest, site) {
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, error: '摘要必须是全长的 64 位十六进制 —— 台账不接受自报的短摘要。' };
  }
  if (!cfg.trustedPlugins || typeof cfg.trustedPlugins !== 'object') cfg.trustedPlugins = {};
  cfg.trustedPlugins[trustKey(id, version)] = {
    digest, alg: TRUST_ALG, site: String(site || ''), at: Date.now(),
  };
  saveConfig(dir, cfg);
  return { ok: true };
}

/**
 * 把这个 `(id, 版本)` 的同意**撤销** —— §5.3：本机那一份不在了，同意就作废。
 *
 * ★ 只有这一个动词，没有"拔钉子"的对应物：同意是**每一次都要重新给的**
 *   （安全的那一侧），而钉子一旦钉上就只能相符（§5.4，见下面那一段）。
 *
 * ★ 删一个**不存在**的条目是合法的无操作，但要**如实报告 `had`** ——
 *   调用方（对账）拿它区分"用户删了本机那一份"与"本来就没人同意过"，
 *   而后者不该产生一条"你的同意作废了"的通知。
 *
 * ★ 只有条目真的变了才落盘。每一次对账都写一遍 `config.json` 是没必要的，
 *   而且会让"配置文件什么时候被改的"变成一条没有意义的线索。
 */
function forgetPlugin(dir, cfg, id, version) {
  const key = trustKey(id, version);
  if (!cfg || !cfg.trustedPlugins || !Object.prototype.hasOwnProperty.call(cfg.trustedPlugins, key)) {
    return { ok: true, had: false };
  }
  delete cfg.trustedPlugins[key];
  saveConfig(dir, cfg);
  return { ok: true, had: true };
}

// ── 钉子：按 **id** 记的签名公钥（§5.4）─────────────────────────────────────
//
// ★ 它与同意台账是**两张表**、而且是**两个文件**，因为它们的生命周期不同：
//
//   | 表 | 放哪 | 键 | 丢了会怎样 |
//   |---|---|---|---|
//   | 同意台账 | `config.json` 的 `trustedPlugins` | `(id, 版本)` | 重新问一次 —— **安全的那一侧** |
//   | 钉子 | `pinned-keys.json` | `id` | 静默回到"首次即信任" —— **不安全的那一侧** |
//
// ★ 钉子**不能**放进 `config.json`。`loadConfig` 只认已知键（那条纪律的用意见那段
//   注释），于是**旧版本**读一遍再存一遍就会把 `pinnedKeys` 抹掉：用户降级一次，
//   钉子全没了 —— 那就等于 §2.5 的机械判据有了一个重置按钮，只是按钮拿在另一个
//   版本手里。单独一个文件，旧版本不认识它，也就不会动它。
//
// ★ **这里没有"拔钉子"的函数，这是故意的。** §5.4 是"首次即信任"，此后只能相符；
//   一个正常的取消钉住入口会把"分身判定"变成一次点击。§5.4 自己写着这条弱点
//   **没有**本地解法，本模块不假装有（想拔只能手改那个文件 —— 那是一次明确的动作）。

const PINNED_FILE = 'pinned-keys.json';
const PINNED_SCHEMA = 1;

function pinnedKeysPath(dir) { return path.join(dir, PINNED_FILE); }

/**
 * 读钉子表。返回 `{ [id]: {fingerprint, at} }`。
 *
 * ★ **一条读不动的钉子留在表里**（`fingerprint: null`），而不是被丢掉 —— 这一条
 *   与上面那张表**恰好相反**：`trustedPlugins` 里一条残缺条目丢掉 = 重新问一次
 *   （安全的那一侧），而这里丢掉 = 下次"首次即信任"（不安全的那一侧）。
 */
function loadPinnedKeys(dir) {
  const raw = readJson(pinnedKeysPath(dir));
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const table = (raw.pinnedKeys && typeof raw.pinnedKeys === 'object'
    && !Array.isArray(raw.pinnedKeys)) ? raw.pinnedKeys : {};
  for (const [id, v] of Object.entries(table)) {
    if (!id) continue;
    // ★ 形状认不出的那一条**也留在表里**（指纹记成 `null`）。`continue` 掉它是错的，
    //   而且错在最坏的那一侧：那个 id 会退回"从来没钉过"，于是下一次收到什么都算
    //   "首次即信任"。留在表里则相反 —— `pinnedKeyOf` 给出的既不是 `undefined`
    //   也不是一个全长指纹，而 `keyVerdict` 对那样的值一律拒绝。
    const shaped = Boolean(v) && typeof v === 'object' && !Array.isArray(v);
    out[id] = {
      fingerprint: shaped && typeof v.fingerprint === 'string' ? v.fingerprint : null,
      at: shaped && Number.isFinite(v.at) ? v.at : 0,
    };
  }
  return out;
}

/**
 * 这个 id 钉住的公钥指纹。
 *
 * ★ **`undefined` 表示"从来没钉过"**，别的一律表示"钉过，值是这个"——
 *   两者必须分得开，因为调用方对它们的处理**相反**：前者是首次即信任，
 *   后者必须**相符**（而一个读不动的值永远不可能相符）。
 *
 * ★ 判"读不读得动"的地方**只有一处**，是 `plugin-package.js` 的 `keyVerdict`
 *   （那条全长十六进制的正则）。这个函数**只负责取出记录**，不做判断 ——
 *   两处都判的话，口径分家的那天没人会发现。
 */
function pinnedKeyOf(pins, id) {
  if (!pins || !Object.prototype.hasOwnProperty.call(pins, id)) return undefined;
  const e = pins[id];
  return (e && typeof e.fingerprint === 'string') ? e.fingerprint : '';
}

/**
 * 钉住一个公钥指纹。**只在第一次**（此后同一个值是无操作，不同的值被拒绝）。
 *
 * @returns {{ok:true, unchanged?:boolean} | {ok:false, error:string}}
 */
function pinPluginKey(dir, pins, id, fingerprint) {
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    return { ok: false, error: '指纹必须是全长的 64 位十六进制（= sha256(32 字节裸公钥)）。' };
  }
  const cur = pinnedKeyOf(pins, id);
  if (cur === fingerprint) return { ok: true, unchanged: true };
  if (cur !== undefined) {
    // 这一条**不是**"再钉一次"：§5.4 的判据就是"与上一次是同一把钥匙"，而换钥匙
    // 意味着作者丢了私钥、只能铸新 id（§4.1）—— 所以这里没有正当的换法。
    return { ok: false, error: `这个 id 已经钉在 ${cur || '（一条读不动的记录）'} 上了，`
      + `不接受换成 ${fingerprint} —— §5.4：首次即信任，此后只能相符。` };
  }
  pins[id] = { fingerprint, at: Date.now() };
  writeAtomic(pinnedKeysPath(dir),
    JSON.stringify({ schema: PINNED_SCHEMA, pinnedKeys: pins }, null, 2), 0o600);
  return { ok: true };
}

// ── 开发者模式的两个设置：**不在 config.json 里** ────────────────────────────
//
// ★ **为什么单独一个文件**：`developerMode` 这个键要回答的是"这次启动读**哪一份**
//   配置"（用户自己那份，还是沙盒那一份）。把它放进 `config.json`，就先得知道读
//   哪一份、才能知道读哪一份 —— 鸡生蛋。放进一个**不属于任何一份配置**的文件里，
//   这个问题不存在。
//
// ★ 顺带避掉另一个坑：那样一来这个键会在**两份**配置里都出现（同一个 DEFAULTS），
//   而只有用户那份里的值有读者。沙盒那一份会是一个没人读的 `false`，下一个人会
//   拿它去判断"开发者模式开没开"—— 而那正是这个仓库一路上在删的那种东西。
//
// ★ 形状认不出时一律按**关着**算。这是安全的那一侧：用户回到自己那份配置（看得见、
//   能干活），而不是被扔进一个连不上集群的沙盒里，还不知道为什么。
//
// ★ 与 `pinned-keys.json` 同一类东西：一个独立的小状态文件，键少、原子写、0600。
const DEV_FILE = 'dev-mode.json';

function devSettingsPath(dir) { return path.join(dir, DEV_FILE); }

/**
 * 读开发者模式的设置。
 *
 * @returns {{developerMode:boolean, pluginDir:string|null}}
 *   `pluginDir` = **假站点的插件来源**（插件作者指向自己那棵树用的）。`null`
 *   = 用默认的（仓库里的 `plugins/`）。见 index.js 的 devPluginSourceDir。
 */
function loadDevSettings(dir) {
  const raw = readJson(devSettingsPath(dir));
  const shaped = Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw);
  return {
    developerMode: shaped && raw.developerMode === true,
    pluginDir: (shaped && typeof raw.pluginDir === 'string' && raw.pluginDir)
      ? raw.pluginDir : null,
  };
}

/**
 * 写开发者模式的设置，返回**规整之后**的那一份 —— 调用方拿它更新自己手里那份，
 * 免得"我写下去的是什么"与"盘上是什么"有两份算法。
 */
function saveDevSettings(dir, s) {
  const next = {
    developerMode: Boolean(s && s.developerMode),
    pluginDir: (s && typeof s.pluginDir === 'string' && s.pluginDir) ? s.pluginDir : null,
  };
  writeAtomic(devSettingsPath(dir), JSON.stringify(next, null, 2), 0o600);
  return next;
}

// ── 这台电脑的客户端身份 ────────────────────────────────────────────────────
//
// ★ 与 `pinned-keys.json`、`dev-mode.json` 同一类：一个独立的小状态文件。
//   它**必须**是独立的一份，理由和钉子那次一模一样 —— 旧版本读一遍 `config.json`
//   再存一遍就会把不认识的东西抹掉，而"客户端身份没了"的后果是：这台电脑下次连
//   上来算**新人**，于是把**另一台**正在用的电脑顶掉。用户什么都没做。
//
// ★ 它**不是**密钥、也不是凭据：它只是一个名字，用来回答"这两个连接是不是同一台
//   电脑"。服务端拿它排席位（见 slurmate-sessiond 的 enforce_client_cap）。
//   说出去也无所谓，但它是**稳定的**，所以不能每次启动重新生成。
const CLIENT_ID_FILE = 'client-id.json';
const CLIENT_ID_SCHEMA = 1;

function clientIdPath(dir) { return path.join(dir, CLIENT_ID_FILE); }

/**
 * 取这台电脑的客户端 id。**没有就生成一个并落盘。**
 *
 * @returns {string} 形如 `m1a2b3c4d5e6`（`m` = machine）
 *
 * ★ 落盘失败也**照常返回**刚生成的那个：这一次连接是好的（席位排得对），
 *   代价只是下次启动会变成"另一台电脑"。为一件"身份没记住"把整个连接拒掉，
 *   是把一个小问题换成一个大问题 —— 而它正是那种用户完全无从理解的失败。
 */
function loadClientId(dir) {
  const raw = readJson(clientIdPath(dir));
  if (raw && typeof raw === 'object' && !Array.isArray(raw)
      && typeof raw.id === 'string' && raw.id) {
    return raw.id;
  }
  const id = 'm' + crypto.randomBytes(8).toString('hex');
  try {
    writeAtomic(clientIdPath(dir),
      JSON.stringify({ schema: CLIENT_ID_SCHEMA, id }, null, 2), 0o600);
  } catch { /* 见上：留不住身份不等于连不上 */ }
  return id;
}

// ── 底层：原子写 ────────────────────────────────────────────────────────────
//
// ★ 实现搬去了 `atomic-write.js`（框架里唯一的那一份 —— 这个文件与
//   `site-plugins.js` 从前各有一份，逐字差别好几处，而且都会漂开）。
//
// ★ 留下这个三行的适配，是因为**"配置写不下去必须炸"是配置模块的策略，不是写盘的
//   策略**：通用实现只返回结构化结果（它还要服务那些"失败了就如实告诉用户"的调用
//   点），而下面那 6 个调用点一直靠抛异常把失败传到 IPC 处理器。所以外部契约一个字
//   没变 —— 这是一次纯内部重构。
//
// ★ 顺手修掉的一个洞：从前这里有一个 `ensureDir`，它对**已经存在**的目录也
//   `chmodSync(dir, 0o700)` —— 也就是每次写配置都会去 chmod 那个 `userData`。
//   通用实现只在"这个目录是我刚建的"时设权限（`mkdirSync` 的 `mode` 天生如此）。
const writeAtomic = (file, text, mode) => atomicWrite.writeAtomicOrThrow(file, text, { mode });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;   // 不存在、或损坏 —— 都由调用方用默认值兜底
  }
}

// ── 连接条目 ────────────────────────────────────────────────────────────────

function newConnectionId() {
  return 'c' + crypto.randomBytes(6).toString('hex');
}

/**
 * 一条连接的身份：同一个人、同一台主机、同一个端口，就是同一条连接。
 *
 * ★ 身份**不是** id。id 是本地生成的，同一条连接每存一次都能拿到一个新 id ——
 *   之前界面上的「保存并连接」正是这样，点几次就攒出几条一模一样的条目。
 */
function connectionKey(c) { return `${c.user}@${c.host}:${c.port}`; }

/**
 * 把任意输入规整成一条合法连接；字段不合法则返回 null（由调用方报错，不静默填空）。
 *
 * **备注（label）为空是合法状态**，表示「用户没起名」。界面上据此回落成显示地址。
 * 这里曾经把空备注回落成 host，那让「没起名」和「名字就叫这个地址」变得无法区分 ——
 * 而界面要按这个区分决定显示哪一样。
 * 旧版本写下的 label 恰好等于 host 的那些，也在这里一并归成「没起名」。
 */
function normalizeConnection(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const user = String(raw.user || '').trim();
  const host = String(raw.host || '').trim();
  const port = Number(raw.port);
  if (!user || !host) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const label = String(raw.label || '').trim();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : (fallbackId || newConnectionId()),
    label: label === host ? '' : label,
    user, host, port,
    // 指向哪个布局组。这里**绝不凭空造一个 id** —— 「连到哪个组」是调用方的决定，
    // 不是规整函数该猜的（与上面 label 那条同一个道理）。指向不存在的组由
    // loadLayouts 收束，不留 null 让界面去处理。
    layoutId: (typeof raw.layoutId === 'string' && raw.layoutId) ? raw.layoutId : null,
  };
}

// ── 布局组 ──────────────────────────────────────────────────────────────────
//
// 一个布局组 = 一份浏览器存储 = 一份 code-server 的编辑器布局。
//
// 为什么需要「组」这一层：code-server（VS Code web）把 UI 布局存在浏览器 localStorage 里，
// 而 localStorage 按 **origin**（scheme://host:port）隔离 —— 客户端用隧道的本地监听端口
// 构造 origin，所以「端口不同」就等于「布局不同」。布局组把「哪条连接用哪个端口」变成
// 用户可控的映射：左侧连接条目、右侧布局组，多对一，引用计数归零即回收。
//
// ★ 组还担着第二个角色：它是插件运行时数据的**实例键**（见 plugin-data.js 的文件头
//   那两条轴）。两件事能共用同一个 id，正是因为它们要的是同一样东西 ——「这几条连接
//   算同一个」这件事由用户说了算，而不是某个组件自己判。这一节只管组本身（端口、
//   引用计数、回收），"一份数据落在哪个分区"在 plugin-data.js 里。

const LAYOUT_PORT_BASE = 18080;   // 布局组的起手端口，从这里往上按需递增

/**
 * 中转站隧道**优先**用的本地端口。
 *
 * ★ 它不是布局组端口，也**不进 config.json**。布局组的存在理由是「浏览器按 origin
 *   隔离 localStorage，所以端口 = 一份编辑器布局」，而中转站没有浏览器 —— 它的
 *   「接口」是 ssh 配置里那个恒定别名，端口只是底下的一个实现细节，写在那边那份
 *   配置的 Port 行里。
 *
 * 所以这个值只是个**起手式**：真被占了（或撞上了某个布局组的端口 —— 排除集里
 * 有全部布局端口，见 index.js 的 getExcludedPorts）隧道会顺移，然后把**实际**
 * 端口写进 ssh 配置。用户看到的永远是 `ssh slurmate` 这一个名字。
 *
 * 取 18090 而不再往上堆：布局组从 18080 起按需递增，两边各占一段，
 * 日常看不到的碰撞由上面那条排除集兜住。
 */
const RELAY_PORT_BASE = 18090;

/**
 * 布局组 id 的**形状**。
 *
 * ★ 它进分区名，而分区名就是磁盘上的目录名（见 plugin-data.js 的 partitionOf）——
 *   所以字符集必须钉死。`config.json` 是**用户能手改的**，在补上这一条之前
 *   `"id": "../x"` 会一路走到路径里：`normalizeLayout` 当时只查了"非空字符串"。
 *   （`persist:plugin-<ULID>` 那条之所以没事，是因为 ULID 有自己的白名单，
 *   **不是这一层在管**。）
 *
 * ★ 这是**补上从前的洞**，不是新规矩：它钉的就是 `newLayoutId` 铸出来的那个形状。
 *
 * ★ 新模型还要往同一个字符串里再塞一个作者写的组名（清单里的
 *   `contributes.data.inherit`），所以这一格必须先关上。
 */
const LAYOUT_ID_RE = /^l[0-9a-f]{12}$/;

/** 随机、**永不复用**。复用会让一个已回收组的存储复活到新组头上。
 *  ——「新建空白布局真的空白」的全部依据：若按端口命名，A 组被回收后端口被新组 B
 *  复用，B 就会继承 A 的 localStorage 和登录 cookie。 */
function newLayoutId() {
  return 'l' + crypto.randomBytes(6).toString('hex');
}

/**
 * 规整一个布局组；字段不合法则返回 null（与 normalizeConnection 同规矩，不静默填空）。
 *
 * ★ id 也要查形状（见 LAYOUT_ID_RE）。不合法的 id **丢掉整个组**，与其它字段不合法
 *   时一致 —— `loadLayouts` 会跳过它，并把原来指着它的连接收束到第一个组上。不这样
 *   做的话，一个手改出来的 id 会变成磁盘上一个谁也清不掉的目录。
 */
function normalizeLayout(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id
    : (typeof fallbackId === 'string' && fallbackId ? fallbackId : newLayoutId());
  if (!LAYOUT_ID_RE.test(id)) return null;
  return {
    id,
    name: String(raw.name || '').trim().slice(0, 40),
    port,
  };
}

function findLayout(cfg, id) {
  return ((cfg && cfg.layouts) || []).find((l) => l.id === id) || null;
}

/** 已被**其他**布局组占用的端口。给隧道的端口顺移用 —— 见 tunnel.js 的 excludePorts。 */
function usedLayoutPorts(cfg, exceptId) {
  const s = new Set();
  for (const l of ((cfg && cfg.layouts) || [])) {
    if (l && l.id !== exceptId) s.add(l.port);
  }
  return s;
}

/**
 * 下一个可用端口：从 18080 起，跳过已被占用的。**确定性**，不探测 OS。
 *
 * 不探测的理由：探测是一次有竞态的快照，而且会让「同一份配置在不同时刻算出不同端口」——
 * 那就等于每次启动都可能换 origin。
 *
 * ★ **调用它的地方只有一个时机：一个布局组被创建的时候。** 此后再没有任何东西改
 *   这个值 —— 端口是布局组的**只读属性**。（从前隧道顺移之后会把它写回来，
 *   那等于把一次**暂时**的冲突变成永久的 origin 变更：冲突消失之后 origin 也
 *   回不去，而原来那份布局本来是可以回来的。）
 *   EADDRINUSE 由 `tunnel.js` 的顺移处理，**顺移只影响这一次会话**。
 *
 * @param {Set<number>} [extraPorts] **配置之外**还占着的端口。今天唯一的来源是
 *   临时实例那些组（它们**不在** `cfg.layouts` 里，见 index.js 的 `tempLayouts`）。
 *   ★ 不让这个函数自己去问临时组，是因为这一层**只认配置**（`usedLayoutPorts`
 *   的语义就是"配置里的"）—— 把第二个来源焊进来，这一层就再也说不清它数的是
 *   什么了。调用方把两半并好再传进来。
 *   ★ 不传 = 只有配置说了算，那是这个函数从前的语义（`app:setConnectionLayout`
 *   那条路就是）。
 */
function nextLayoutPort(cfg, extraPorts) {
  const used = usedLayoutPorts(cfg, null);
  if (extraPorts) for (const p of extraPorts) used.add(p);
  let p = LAYOUT_PORT_BASE;
  while (p <= 65535 && used.has(p)) p += 1;
  return p;
}

/** 「布局 N」，N 取当前没被占用的最小正整数。确定性、不撞名。 */
function nextLayoutName(cfg) {
  const taken = new Set(((cfg && cfg.layouts) || [])
    .map((l) => /^布局 (\d+)$/.exec((l && l.name) || ''))
    .filter(Boolean).map((m) => Number(m[1])));
  let n = 1;
  while (taken.has(n)) n += 1;
  return `布局 ${n}`;
}

// ★ 这里从前有一个 `layoutPort(cfg, id)`：取一个组的端口，**组不存在时回落到
//   `LAYOUT_PORT_BASE`**。它整个删掉了 —— 而理由不是"没人用"（那只是结果）：
//   那条回落**正是**临时实例这条路上最危险的一格。临时组不在配置里，于是每一个
//   临时实例都会"回落到" 18080，也就是**持有者自己那个端口** ⇒ 每次开局都推一条
//   "端口被占、布局会重置"的**假警报**，而且同一份配置在不同启动顺序下会得到
//   不同的 origin。取端口现在只有一条路：`index.js` 的 `layoutPortOf`（先查配置、
//   再查临时组，都没有就抛）。**别在这里再长出一条带回落的取端口函数。**

/**
 * 改一条连接指向哪个组。**不落盘** —— 由调用方统一走 commitConfig()。
 */
function setConnectionLayout(cfg, connId, layoutId) {
  if (!(cfg.connections || []).some((c) => c.id === connId)) {
    return { ok: false, error: '这条连接不存在。' };
  }
  if (layoutId && !findLayout(cfg, layoutId)) {
    return { ok: false, error: '这个布局组不存在。' };
  }
  cfg.connections = cfg.connections.map(
    (c) => (c.id === connId ? { ...c, layoutId } : c));
  return { ok: true };
}

/**
 * 回收引用计数归零的组。**由 index.js 在每一次会改变引用计数的改动之后统一调用**
 * （commitConfig）—— 漏掉一处的后果是某个组永远不被回收。
 *
 * @returns {{removed: string[]}} 被删掉的组 id（调用方据此清理它们的浏览器存储）
 */
function pruneLayouts(cfg) {
  // ★ 一条连接都没有时**不回收**。演示模式（以及「全新安装、还没配任何连接」）
  //   会有一个不属于任何连接的布局组 —— 它是那次会话的布局身份。在这里把它删掉，
  //   下次开会话又会造一个新的，而 id 一变 partition 就变，布局白重置一次。
  //   没有任何映射关系要维护的时候，「回收」无事可做。
  if (!(cfg.connections || []).length) return { removed: [] };

  const counts = new Map();
  for (const c of (cfg.connections || [])) {
    if (c.layoutId) counts.set(c.layoutId, (counts.get(c.layoutId) || 0) + 1);
  }
  const removed = [];
  cfg.layouts = (cfg.layouts || []).filter((l) => {
    if ((counts.get(l.id) || 0) > 0) return true;
    removed.push(l.id);
    return false;
  });
  return { removed };
}

/**
 * 给界面用的**已推导**结构。renderer 只渲染、不做任何推导 ——
 * 它手里那份 refCount 随时可能已经陈旧（另一条连接刚被删），
 * 所以「要不要二次确认」的判定权必须在主进程。
 *
 * @returns {[{id, name, port, refCount, members:string[], soleOwnerId:string|null}]}
 *   soleOwnerId 非 null 表示「这个布局只被这一条连接使用，切走就会被丢弃」。
 */
function layoutPlan(cfg) {
  return ((cfg && cfg.layouts) || []).map((l) => {
    const members = (cfg.connections || [])
      .filter((c) => c.layoutId === l.id).map((c) => c.id);
    return {
      id: l.id, name: l.name, port: l.port,
      refCount: members.length,
      members,
      soleOwnerId: members.length === 1 ? members[0] : null,
    };
  });
}

/**
 * 解析布局组列表。
 *
 * 组只有**一条来路**：磁盘上的 `layouts[]`。一个都没有而有连接时，就地补一个默认组。
 * （0.2.0 及更早的 `slots` 那一路 —— 一个槽位、端口从配置里继承 —— 随"读旧配置"
 * 一起删掉了，见 CHANGELOG 的 0.7 那一节。）
 */
function loadLayouts(raw, connections) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(raw.layouts)) {
    for (const l of raw.layouts) {
      const n = normalizeLayout(l, l && l.id);
      if (!n || seen.has(n.id)) continue;
      // 端口撞车就地挪开 —— 两个组声称同一个端口会让它们每次启动互相抢，
      // 布局在两个 origin 之间反复横跳，而界面上一切正常。
      if (out.some((x) => x.port === n.port)) n.port = nextLayoutPort({ layouts: out });
      seen.add(n.id);
      out.push(n);
    }
  }
  // 兜底：有连接却一个组都没有（手改过配置，或第一次配连接就写下了连接）。
  if (out.length === 0 && connections.length > 0) {
    out.push({ id: newLayoutId(), name: '默认布局', port: LAYOUT_PORT_BASE });
  }
  // 每条连接都必须落在一个**存在**的组里。指向不存在的组 = 界面上一片空白，
  // 而用户看不出为什么。在这里收束掉，而不是让 UI 去处理 null。
  const first = out[0] ? out[0].id : null;
  for (const c of connections) {
    if (!out.some((l) => l.id === c.layoutId)) c.layoutId = first;
  }
  return out;
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function configPath(dir) { return path.join(dir, 'config.json'); }

/**
 * 读配置。**只认已知键**（见下面那段），而且**只认当前格式** —— 旧格式不再有读取
 * 路径，它们读作"没有配过"（0.y 不考虑兼容性，见 CHANGELOG 的 0.7 那一节）。
 */
function loadConfig(dir) {
  const raw = readJson(configPath(dir));
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULTS);

  // **只认已知键**，不用 `...raw` 整包展开。
  // 整包展开的后果不是「多几个字段」那么轻：旧版本留下的 profile / passwordMode /
  // maxSessions 会一直跟着配置文件活下去，每次保存都被原样写回，永远不消失 ——
  // 将来读这份配置的人（包括三个月后的我们）会以为它们还有用，去代码里找一个
  // 早就不存在的行为。
  const cfg = structuredClone(DEFAULTS);
  if (raw.hostKeys && typeof raw.hostKeys === 'object') cfg.hostKeys = raw.hostKeys;
  // 插件开关。**只收布尔值**：配置文件是用户可以手改的，而一个 `"enabled": "no"`
  // （字符串）会让 `if (p.enabled)` 判真 —— 用户以为关掉了，实际开着。
  // 认不出的形状直接丢掉 = 回到"跟着站点走"，那是安全的那一侧。
  if (raw.plugins && typeof raw.plugins === 'object' && !Array.isArray(raw.plugins)) {
    for (const [name, v] of Object.entries(raw.plugins)) {
      if (v && typeof v.enabled === 'boolean') cfg.plugins[name] = { enabled: v.enabled };
    }
  }
  // ★ 老 config.json 里可能还有 `devPlugins`。**不读它** —— 那个开关守的那条路
  //   已经删了。这里不要"读进来但不用"：一个没有读者的字段留在这里，下一个人会
  //   以为它还有用，然后把它接回某条路上。

  // 同意台账。**只收形状完整的条目**：`digest` 必须是全长 64 位十六进制。
  //
  // ★ 一个残缺的条目（短摘要、缺 digest）在这里丢掉**比留着安全**：留着的话它
  //   会被当成"已经同意过"，而真正的那份内容从来没被核对过。丢掉 = 回到"要重新
  //   点一次同意"，那是安全的那一侧。
  //
  // ★ `alg` 认不出的**保留条目**而不是丢掉，但把算法记成 `null`：
  //   `isTrusted` 于是不可能通过（版本对不上），而那与"丢掉"在行为上是同一件事
  //   —— 重新问一次。差别在**界面**上：留着才能说清"是换算法了"，丢掉就只剩
  //   一句"没有同意过"，而那句话把一次可解释的升级说成了一次从零开始。
  if (raw.trustedPlugins && typeof raw.trustedPlugins === 'object'
      && !Array.isArray(raw.trustedPlugins)) {
    for (const [key, v] of Object.entries(raw.trustedPlugins)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      if (typeof v.digest !== 'string' || !/^[0-9a-f]{64}$/.test(v.digest)) continue;
      if (typeof v.site !== 'string' || !v.site) continue;
      cfg.trustedPlugins[key] = { digest: v.digest, site: v.site,
                                  alg: trustAlgOf(v),
                                  at: Number.isFinite(v.at) ? v.at : 0 };
    }
  }

  // 连接列表。去重按**两个**维度：
  //   · id —— 同一个条目被写了两遍；
  //   · 身份（user@host:port）—— 一条连接的**身份就是这个三元组**，所以两条一模
  //     一样的条目是同一条连接。手改过的配置可能攒出一串，留着的话用户看到的是
  //     一堆重复项，而它们指向同一个地方。
  const list = [];
  const seen = new Set();
  const seenAddr = new Set();
  const push = (c) => {
    const n = normalizeConnection(c, c && c.id);
    if (!n) return;
    const addr = connectionKey(n);
    if (seen.has(n.id) || seenAddr.has(addr)) return;
    seen.add(n.id);
    seenAddr.add(addr);
    list.push(n);
  };
  if (Array.isArray(raw.connections)) {
    raw.connections.forEach(push);
  }

  cfg.connections = list;
  cfg.activeConnectionId = list.some((c) => c.id === raw.activeConnectionId)
    ? raw.activeConnectionId
    : (list[0] ? list[0].id : null);

  // 布局组必须在连接之后解析：loadLayouts 要读 connections 才能把每条连接收束到一个
  // 存在的组里，而连接侧的去重可能已经剔掉了几条。
  cfg.layouts = loadLayouts(raw, list);

  return cfg;
}

/**
 * 新增一条连接，或复用已有那条一模一样的。
 *
 * ★ 这是「相同条目检测」的落点。判断依据是 user@host:port，不是 id：
 *   界面上不修改任何字段、连点两次「保存并连接」，不该得到两条一样的条目 ——
 *   列表会越点越长，而用户分不清该点哪一条。
 *
 * @param {object} opts
 *   allowLayoutChange {boolean} 复用已有条目时是否允许改它的 layoutId。默认**不许**：
 *                               按地址命中另一条（用户没带 id）却把它的布局组改掉，
 *                               是一次完全看不见的副作用。
 *
 * 新建的那条**不在这里**决定布局组：`layoutId` 留 null，由 index.js 的
 * ensureConnectionLayout 统一分配（它需要 cfg 才能建新组）。两处都做会让
 * 「新连接落到哪个组」这条策略有两个说法。
 * @returns {{connection:object, created:boolean}
 *          | {conflict:object}
 *          | null}  输入不合法时返回 null
 */
function upsertConnection(cfg, input, opts = {}) {
  const conn = normalizeConnection(input, input && input.id);
  if (!conn) return null;

  const key = connectionKey(conn);
  const idx = cfg.connections.findIndex((c) => c.id === conn.id || connectionKey(c) === key);

  if (idx < 0) {
    cfg.connections = [...cfg.connections, conn];
    return { connection: conn, created: true };
  }

  const prev = cfg.connections[idx];

  // ★ 编辑场景：输入的 id 指向 A，但 user@host:port 撞上了另一条 B。
  //   照直改下去，A 和 B 会变成同一身份的两份副本 —— 之后「相同条目检测」
  //   再也说不清该复用哪一条，而且两条各有各的密钥，界面却完全看不出差别。
  //   所以明确拒绝，让用户改地址或者删掉重复的那条，而不是替他们挑一条。
  const clash = cfg.connections.find((c) => c.id !== prev.id && connectionKey(c) === key);
  if (clash) {
    return {
      conflict: {
        id: clash.id, label: clash.label,
        user: clash.user, host: clash.host, port: clash.port,
      },
    };
  }

  // 复用旧条目：**id 用回旧的那个**（可能已经被 activeConnectionId 之类引用着）。
  // layoutId 由 ...prev 原样带过来 —— 「按地址命中已有条目」这条路径不该顺手改它的
  // 布局组，那是一次完全看不见的副作用。要改必须显式传 allowLayoutChange。
  const next = { ...prev, user: conn.user, host: conn.host, port: conn.port };
  if (opts.allowLayoutChange && conn.layoutId) next.layoutId = conn.layoutId;

  // 备注按两条不同的语义处理，因为**空备注在这两条路径上意思不同**：
  //   · 编辑（输入带了 id）—— 表单里那一栏就是当前值，清空即清空，必须写回去；
  //   · 按地址判重（输入没带 id）—— 空备注只表示「这次没填」，
  //     拿它把用户手写的「内网」冲掉是静默的信息丢失。
  if (input && input.id) next.label = conn.label;
  else if (conn.label) next.label = conn.label;
  cfg.connections = cfg.connections.map((c, i) => (i === idx ? next : c));
  return { connection: next, created: false };
}

function saveConfig(dir, cfg) {
  writeAtomic(configPath(dir), JSON.stringify({ ...cfg, schema: SCHEMA }, null, 2), 0o600);
}

function activeConnection(cfg) {
  return (cfg.connections || []).find((c) => c.id === cfg.activeConnectionId) || null;
}

// ── 主机密钥指纹（TOFU）──────────────────────────────────────────────────────

function hostKeyId(host, port) { return `${host}:${port}`; }

/**
 * 核对主机密钥指纹。
 * @returns {{status:'known'|'new'|'changed', expected?:string}}
 *   new     —— 第一次见，界面让用户确认后调 rememberHostKey
 *   changed —— **必须拒绝连接**。这不是警告：主机密钥变了意味着中间人或者
 *              服务器重装，两种情况下继续连都是在把私钥认证交给不确定的对端。
 */
function checkHostKey(cfg, host, port, fingerprint) {
  const stored = (cfg.hostKeys || {})[hostKeyId(host, port)];
  if (!stored) return { status: 'new' };
  if (stored === fingerprint) return { status: 'known' };
  return { status: 'changed', expected: stored };
}

function rememberHostKey(dir, cfg, host, port, fingerprint) {
  cfg.hostKeys = { ...cfg.hostKeys, [hostKeyId(host, port)]: fingerprint };
  saveConfig(dir, cfg);
}

function forgetHostKey(dir, cfg, host, port) {
  const next = { ...cfg.hostKeys };
  delete next[hostKeyId(host, port)];
  cfg.hostKeys = next;
  saveConfig(dir, cfg);
}

// ── 凭据（SSH 私钥）：**每条连接一把** ──────────────────────────────────────
//
// 为什么按连接存，而不是全局一把：
//   · 公钥是注册在**某个账户**上的，而连接就是「哪个账户、哪台机器、哪个端口」。
//     同一账户的多条连接本就该共用、也允许各自独立作废。
//   · 「重新生成密钥」这个动作的作用域因此变成一条连接，而不是整个客户端 ——
//     作废一把钥匙不该顺带把别的连接也打断。
//
// 磁盘形态（一个文件装全部，0600）：
//   { schema: 4, keys: { "<连接 id 或 PENDING_ID>": { mode, data } } }
//
// 旧形态（schema ≤ 3）是 { schema, mode, data } 一份全局密钥。**不再读它** ——
// 它读作"没有这条密钥"（见 SECRET_ENCRYPTED 那段）。

function secretPath(dir) { return path.join(dir, 'secrets.json'); }

function readSecretFile(dir) {
  const raw = readJson(secretPath(dir));
  if (!raw || typeof raw !== 'object') return null;
  return raw;
}

function writeSecretFile(dir, obj) {
  writeAtomic(secretPath(dir), JSON.stringify(obj, null, 2), 0o600);
}

/**
 * 加密并写下一条密钥。**只有加密一种方式** —— 界面上不再有「保存方式」这个下拉框；
 * 一个需要用户在「安全」和「不安全」之间做选择的设计，本身就是设计失败。
 *
 * @param {object|null} cryptoSafe  Electron 的 safeStorage 封装：
 *                                  { encrypt(str)->Buffer, decrypt(Buffer)->str }
 *                                  传 null 表示这台机器上没有可用的安全存储。
 * @returns {{ok:true, mode:'encrypted'} | {ok:false, reason:string}}
 *
 * **调用方必须先读返回值**：这台机器存不了密钥时，唯一诚实的做法是如实说出来，
 * 而不是降级成明文让它「看起来存上了」。
 */
function setKey(dir, cryptoSafe, id, value) {
  if (!cryptoSafe) return { ok: false, reason: 'no_secure_storage' };
  let buf;
  try {
    buf = cryptoSafe.encrypt(value);
  } catch (e) {
    return { ok: false, reason: 'encrypt_failed: ' + e.message };
  }
  const raw = readSecretFile(dir);
  const keys = (raw && raw.keys && typeof raw.keys === 'object') ? { ...raw.keys } : {};
  keys[id] = { mode: SECRET_ENCRYPTED, data: buf.toString('base64') };
  // 写下去的就是当前格式：这个文件里**只有** keys 一张表。更旧的那两个顶层字段
  // （data/mode，一份全局密钥）不保留 —— 它已经没有任何读者了。
  writeSecretFile(dir, { schema: SCHEMA, keys });
  return { ok: true, mode: SECRET_ENCRYPTED };
}

/**
 * 取一条密钥。
 * @returns {{ok:true, value:string, mode:string} | {ok:false, reason:string}}
 */
function getKey(dir, cryptoSafe, id) {
  const raw = readSecretFile(dir);
  if (!raw) return { ok: false, reason: 'not_saved' };
  const entry = raw.keys && raw.keys[id];
  if (!entry || typeof entry !== 'object' || typeof entry.data !== 'string') {
    return { ok: false, reason: 'not_saved' };
  }
  if (entry.mode !== SECRET_ENCRYPTED) {
    return { ok: false, reason: 'bad_mode: ' + entry.mode };
  }
  if (!cryptoSafe) {
    return { ok: false, reason: 'no_secure_storage' };
  }
  try {
    return { ok: true, value: cryptoSafe.decrypt(Buffer.from(entry.data, 'base64')),
             mode: SECRET_ENCRYPTED };
  } catch (e) {
    // 换过机器、换过用户、keyring 被重置 —— 都会走到这里
    return { ok: false, reason: 'decrypt_failed: ' + e.message };
  }
}

/** 删掉一条密钥（连接被删除时跟着走）。文件空了就删掉文件本身。 */
function deleteKey(dir, id) {
  const raw = readSecretFile(dir);
  if (!raw || !raw.keys || !Object.prototype.hasOwnProperty.call(raw.keys, id)) {
    return { ok: true, removed: false };
  }
  const keys = { ...raw.keys };
  delete keys[id];
  if (Object.keys(keys).length === 0) {
    try { fs.unlinkSync(secretPath(dir)); } catch { /* 已经不在了 */ }
  } else {
    writeSecretFile(dir, { schema: SCHEMA, keys });
  }
  return { ok: true, removed: true };
}

/** 这条 id 下有没有密钥。**只查存在性，不解密** —— 界面上要据此决定说话的方式。 */
function hasKey(dir, id) {
  const raw = readSecretFile(dir);
  return Boolean(raw && raw.keys && raw.keys[id]);
}

// ── 待补发的 goodbye（见 session.js：断电/kill -9 时 goodbye 一定发不出去）────────
function pendingGoodbyePath(dir) { return path.join(dir, 'pending-goodbye.json'); }

function addPendingGoodbye(dir, sessionId) {
  const list = readJson(pendingGoodbyePath(dir));
  const arr = Array.isArray(list) ? list : [];
  if (!arr.some((x) => x && x.session_id === sessionId)) {
    arr.push({ session_id: sessionId, at: Date.now() });
  }
  writeAtomic(pendingGoodbyePath(dir), JSON.stringify(arr, null, 2), 0o600);
}

function listPendingGoodbye(dir) {
  const list = readJson(pendingGoodbyePath(dir));
  return Array.isArray(list) ? list.filter((x) => x && typeof x.session_id === 'string') : [];
}

function removePendingGoodbye(dir, sessionId) {
  const arr = listPendingGoodbye(dir).filter((x) => x.session_id !== sessionId);
  if (arr.length === 0) {
    try { fs.unlinkSync(pendingGoodbyePath(dir)); } catch { /* 已不存在 */ }
  } else {
    writeAtomic(pendingGoodbyePath(dir), JSON.stringify(arr, null, 2), 0o600);
  }
}

// ★ **导出表是这个模块对外的承诺**，所以这里只留今天真有人读的名字。
//
//   v0.7 之前它长得多，其中这一批**一个外部读者都没有**（谁在读它，是靠
//   "整个仓库搜一遍这个标识符"量出来的，不是靠感觉）：`SECRET_ENCRYPTED`、
//   `LAYOUT_PORT_BASE`、`newConnectionId`、`normalizeConnection`、
//   `connectionKey`、`hostKeyId`、`readSecretFile`。它们都还在文件里、还在被
//   本文件用着，只是不再**承诺**给别人。
//
//   ★ 一起删掉的还有整个 `_internal`（`writeAtomic` / `readJson` / `configPath` /
//     `secretPath` / `pendingGoodbyePath` / `pinnedKeysPath` / `PINNED_SCHEMA`）——
//     它的注释写着"导出给测试用"，而 `config.test.mjs` **一个都没用过**。那句话
//     就是"意图写了、测试没写"的原文：留着一个没人读的接缝，读代码的人会以为
//     某条用例正踩着它。`config.test.mjs` 走的是这个模块的**公开面**
//     （`loadConfig` / `saveConfig` / `setKey` / `loadPinnedKeys` …），那才是它
//     该走的路；真需要某个内部函数时，加回一行就是一次**看得出来**的动作。
module.exports = {
  SCHEMA, DEFAULTS, PENDING_ID,
  loadConfig, saveConfig,
  // 布局组
  RELAY_PORT_BASE,
  newLayoutId, normalizeLayout, findLayout, usedLayoutPorts, nextLayoutPort,
  nextLayoutName, setConnectionLayout,
  pruneLayouts, layoutPlan,
  activeConnection, upsertConnection,
  // 插件在本机的开关，与站点分发的同意台账
  pluginEnabledLocally, setPluginEnabled,
  trustKey, isTrusted, trustPlugin, forgetPlugin, trustAlgOf, TRUST_ALG, TRUST_ALG_LEGACY,
  // 钉子（按 id 记的公钥指纹）—— 单独一个文件，见那一段的注释
  loadPinnedKeys, pinnedKeyOf, pinPluginKey,
  // 开发者模式的两个设置 —— 也单独一个文件，理由见那一段（**次序**）
  loadDevSettings, saveDevSettings,
  // 这台电脑的客户端身份 —— 同样单独一个文件，理由见那一段
  loadClientId,
  checkHostKey, rememberHostKey, forgetHostKey,
  setKey, getKey, deleteKey, hasKey,
  addPendingGoodbye, listPendingGoodbye, removePendingGoodbye,
};
