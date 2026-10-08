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
 * config.js —— 本地配置与凭据的持久化。
 *
 * ⚠️ 这个文件**不对用户暴露**。所有条目都在界面上，界面上没有任何「打开配置文件」
 *    的入口 —— 用户不该为了改一个地址去手编辑 JSON。
 *
 * 三条设计原则，都是被这个项目里反复出现的「静默失败」逼出来的：
 *
 * 1. **写盘一律原子**（写临时文件 + rename），且**显式 chmod**。`writeFileSync` 的
 *    mode 参数在文件已存在时不生效 —— 光靠它会让一个已经是 0644 的凭据文件永远是 0644。
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
// ★ 只为一个东西：`PLUGIN_ID_RE`（插件 id 的形状）。数据空间那张表里有一格是插件 id，
//   而它会进磁盘路径 —— `config.json` 是用户能手改的，所以那一格必须在这里查。
//   ★ 从那边**取**而不是在这里再写一条正则：插件 id 的字母表只有一份（`ulid.ENCODING`）。
const pluginData = require('./plugin-data.js');

const SCHEMA = 7;   // 2：profile → connections；3：永远加密保存；4：每条连接一把密钥；
                    // 5：**工作区**（那时叫「布局组」）取代 slots —— 键本身也换过名字
                    // 6：**站点分发**（trustedPlugins 同意台账 + devPlugins 开关）
                    // 7：**数据空间**独立成一层 —— 工作区只留一张引用表（`refs`），
                    //    端口从工作区搬到数据空间上
                    //
                    // ★ 删键**不升号**：升号是给"必须搬一次"的改动用的，不是给
                    //   "少了一个键"用的 —— 一个没人读的键下一次 saveConfig 顺手
                    //   就丢了。

// 私钥在磁盘上的存放形态。**只有一种能写、也只有一种能读**：encrypted。
//
// ★ **只有一种 mode 能读**：别的值（包括明文）一律报 `bad_mode`，**不**顺手加密
//   重存 —— 一份能被读出来继续用的明文私钥，最该做的事是**被发现**，而"顺手把它
//   加密重存"等于让它再活一轮。
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
  connections: [],          // [{ id, label, user, host, port, workspaceId }]
  activeConnectionId: null,
  // 主机密钥指纹（TOFU）。键是 "host:port"，值是 "SHA256:…"。
  // ssh2 默认【不校验】主机密钥，不自己存一份就等于裸奔（见 backend-ssh.js）。
  hostKeys: {},
  // 工作区。一个工作区 = **一张引用表**：这个工作区里，每个插件用哪一份数据。
  // ★ 它**不拥有数据**，只拥有"指向"。数组顺序即界面顺序（映射图的列序、下拉的选项序都靠它）。
  workspaces: [],           // [{ id, name, refs: { <插件 id>: <数据空间 id> } }]
  // 数据空间。一份 = 一个插件的**一份存储 + 它自己的端口**（个数由插件声明）。
  // ★ 它**不属于任何工作区** —— 一份数据可以被几个工作区同时引用，那正是这张表
  //   与 `workspaces[].refs` 分开的理由。
  spaces: [],               // [{ id, pluginId, group, ports: [18080] }]
  // 插件在本机的开关：{ 插件名: { enabled: bool } }。
  //
  // ★ 这是「安装/卸载」在客户端那一半。**缺省是"跟着站点走"**：名字不在表里
  //   = 没表过态 = 用站点说了算。所以升级不会因为多出这个字段而改变任何行为，
  //   而用户关掉一个插件之后，重启客户端它还是关着的。
  // ★ 它**不**影响服务端：站点仍然可以提交那个插件的会话（用户自己用 CLI 就行），
  //   客户端只是不再给出那个按钮。两边是两件事，见 plugins/index.js 的边界说明。
  // 键是插件的 **id**（那个铸造出来的 ULID），**不是短名**。
  // ★ 用错成**短名**的症状是"开关莫名失效"：池是全局的，两个站点可以各有一个叫
  //   jupyter 的插件而它们是两个东西 —— `pluginsView()` 与 `app:setPluginEnabled`
  //   从头到尾用的是 `plugin.id`。
  plugins: {},              // { [id]: { enabled: boolean } }
  // ★ **不给任何一类插件开免同意的口子**（`packer/docs/PLUGIN-SPEC.md` §5.2）：池里
  //   有什么就加载什么，但每一份都过同意闸。
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
 * ★ 判据必须是**全长的**摘要：拿一个截断的摘要当信任台账的键就是一个碰撞面 ——
 *   截断只留给显示。
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
// ★ 实现住在 `atomic-write.js`（框架里唯一的那一份）。
//
// ★ 留下这个三行的适配，是因为**"配置写不下去必须炸"是配置模块的策略，不是写盘的
//   策略**：通用实现只返回结构化结果（它还要服务那些"失败了就如实告诉用户"的调用
//   点），而下面那 6 个调用点靠抛异常把失败传到 IPC 处理器。
//
// ★ **权限只在目录是新建的时候设**：对一个**已经存在**的目录（比如 `userData`）
//   `chmodSync(dir, 0o700)` 会在每次写配置时改它的权限。通用实现靠 `mkdirSync` 的
//   `mode`（天生只在新建时生效）做到这一点。
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
 * **不要把空备注回落成 host** —— 那让「没起名」和「名字就叫这个地址」变得无法区分，
 * 而界面要按这个区分决定显示哪一样。label 恰好等于 host 的，也在这里一并归成「没起名」。
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
    // 指向哪个工作区。这里**绝不凭空造一个 id** —— 「连到哪个工作区」是调用方的决定，
    // 不是规整函数该猜的（与上面 label 那条同一个道理）。指向不存在的工作区由
    // loadWorkspaces 收束，不留 null 让界面去处理。
    workspaceId: (typeof raw.workspaceId === 'string' && raw.workspaceId) ? raw.workspaceId : null,
  };
}

// ── 工作区：一张引用表 ──────────────────────────────────────────────────────
//
// 一个工作区回答的是「**这几条连接算同一个**」—— 由用户说了算。它本身不拥有任何
// 东西，只拥有一张表：这个工作区里，每个插件用哪一份数据。
//
// 为什么需要「工作区」这一层：code-server（VS Code web）把 UI 布局存在浏览器 localStorage 里，
// 而 localStorage 按 **origin**（scheme://host:port）隔离 —— 客户端用隧道的本地监听端口
// 构造 origin，所以「端口不同」就等于「浏览器存储不同」。工作区把「哪条连接算同一个」变成
// 用户可控的映射：左侧连接条目、右侧工作区，多对一，引用计数归零即回收。
//
// ★ 而**端口与身份都不属于工作区** —— 它们属于数据空间（见下一节）。这一节只管
//   引用表本身：谁指着它、什么时候回收。

/**
 * 兜底那个工作区的 id：**一个常量**，不是铸出来的。
 *
 * 有连接、却一个 `workspaces[]` 都没有时（手改过配置，或者第一次配连接就写下了连接），
 * `loadWorkspaces` 就地补一个「默认工作区」。★ 它是**单例** —— 每一次补出来的都是同一个
 * 工作区，所以它就该是同一个 id。
 *
 * ★ **这与 `newWorkspaceId` 那条"永不复用"不冲突**，两者防的不是同一件事：那一条防的是
 *   "**一个随机 id 被发两次**"（A 工作区被回收之后，它的 id 落到一个**不相干**的新工作区
 *   头上，于是新工作区继承 A 的那张引用表）。这里只有一个工作区，不存在"落到别的工作区头上"。
 *
 * ★★ **这一格必须是常量，不能是 `newWorkspaceId()`（随机）**。后果不是"看起来不利索"，
 *   而是**丢数据**：`loadConfig` **自己不写盘**（见文件头那三条原则），于是
 *
 *       读完配置 → 一次都没保存就退出 → 下次启动换一个 id → 换一批数据空间
 *       ⇒ **上一轮刚攒的编辑器布局凭空消失**，且没有任何报错。
 *
 *   而随机 id 还会在「本机的插件数据」里攒下一份认不出的残留，用户得自己删。
 *
 * ★ 复用它是安全的：这一格唯一的来路是"一个工作区都没有"，而一个工作区被回收时
 *   它那张引用表跟着没了、它名下的数据空间也归零回收（见 `pruneSpaces`）。
 *
 * 形状必须满足 `WORKSPACE_ID_RE`。取全零是为了**一眼看出它不是铸的**。
 */
const DEFAULT_WORKSPACE_ID = 'w000000000000';

/**
 * 中转站隧道**优先**用的本地端口。
 *
 * ★ 它不是数据空间的端口，也**不进 config.json**。数据空间的存在理由是「浏览器按
 *   origin 隔离 localStorage，所以端口 = 一份编辑器布局」，而中转站没有浏览器 —— 它的
 *   「接口」是 ssh 配置里那个恒定别名，端口只是底下的一个实现细节，写在那边那份
 *   配置的 Port 行里。
 *
 * 所以这个值只是个**起手式**：真被占了（或撞上了某个数据空间的端口 —— 排除集里
 * 有全部数据空间端口，见 index.js 的 getExcludedPorts）隧道会顺移，然后把**实际**
 * 端口写进 ssh 配置。用户看到的永远是 `ssh slurmate` 这一个名字。
 *
 * 取 18090 而不再往上堆：数据空间从 18080 起按需递增，两边各占一段，
 * 日常看不到的碰撞由上面那条排除集兜住。
 */
const RELAY_PORT_BASE = 18090;

/**
 * 工作区 id 的**形状**。
 *
 * ★ 它**今天不进任何路径**（进路径的是数据空间 id，见 `SPACE_ID_RE`），但仍然要查：
 *   `config.json` 是**用户能手改的**，而一个畸形 id 会让「这条连接指着哪个工作区」
 *   变成一句读不懂的话，症状是界面上一片空白而没有任何报错。丢掉整个工作区、
 *   让连接收束到第一个，是一个说得清的下场。
 *
 * ★ 它钉的就是 `newWorkspaceId` 铸出来的那个形状。
 */
const WORKSPACE_ID_RE = /^w[0-9a-f]{12}$/;

/** 随机、**永不复用**。复用会让一个已回收工作区的引用表复活到新工作区头上。
 *  ——「新建空白工作区真的空白」的全部依据：若按端口命名，A 工作区被回收后端口被新工作区 B
 *  复用，B 就会继承 A 的那张表（以及它指着的那些数据）。 */
function newWorkspaceId() {
  return 'w' + crypto.randomBytes(6).toString('hex');
}

/**
 * 规整一个工作区；字段不合法则返回 null（与 normalizeConnection 同规矩，不静默填空）。
 *
 * ★ id 也要查形状（见 WORKSPACE_ID_RE）。不合法的 id **丢掉整个工作区**，与其它字段不合法
 *   时一致 —— `loadWorkspaces` 会跳过它，并把原来指着它的连接收束到第一个工作区上。不这样
 *   做的话，一个手改出来的 id 会变成一张谁也清不掉的引用表。
 *
 * ★ `refs` 里认不出形状的条目**丢掉那一格**，不丢掉整张表：一格坏掉只该让那一个插件
 *   少一份数据（下一次开会话会新开一份），不该让整个工作区连同别的插件的映射一起消失。
 *   ★ 而**指向不存在的数据空间**的那一格由 `loadConfig` 收掉（那时 `spaces` 才读完）。
 */
function normalizeWorkspace(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id
    : (typeof fallbackId === 'string' && fallbackId ? fallbackId : newWorkspaceId());
  if (!WORKSPACE_ID_RE.test(id)) return null;
  const refs = {};
  if (raw.refs && typeof raw.refs === 'object' && !Array.isArray(raw.refs)) {
    for (const [pluginId, spaceId] of Object.entries(raw.refs)) {
      if (!pluginData.PLUGIN_ID_RE.test(pluginId)) continue;
      if (typeof spaceId !== 'string' || !SPACE_ID_RE.test(spaceId)) continue;
      refs[pluginId] = spaceId;
    }
  }
  return {
    id,
    name: String(raw.name || '').trim().slice(0, 40),
    refs,
  };
}

function findWorkspace(cfg, id) {
  return ((cfg && cfg.workspaces) || []).find((l) => l.id === id) || null;
}

// ── 数据空间：一份存储 + 它自己的端口 ────────────────────────────────────────
//
// 一份数据 = 一个插件的**一份存储**（浏览器分区 + 插件数据目录），加上**它自己的端口**
// （端口 = origin = 那份浏览器存储）。它不属于任何工作区 —— 工作区只是**引用**它。
//
// ★ 为什么端口归数据、不归工作区：一个工作区里可以同时跑**两个不同的插件**
//   （数据是按插件分的），而两个会话不能共用一个端口 —— 端口是 origin，共用就等于
//   两份浏览器的数据落在同一份存储里。端口跟着数据走，这条就不需要任何检查去维持。
//
// ★ 为什么这一层独立成一张表：**一份数据可以被几个工作区同时引用**。引用计数归零
//   （没有任何工作区指着它、也没有活会话拿着它）才回收 —— 见 `pruneSpaces`。

const SPACE_PORT_BASE = 18080;   // 数据空间的起手端口，从这里往上按需递增

/**
 * 数据空间 id 的**形状**。
 *
 * ★ 它进分区名，而分区名就是磁盘上的目录名（见 plugin-data.js 的 partitionOf）——
 *   所以字符集必须钉死。`config.json` 是**用户能手改的**，没有这一条，`"id": "../x"`
 *   会一路走到路径里 —— 查"非空字符串"挡不住它。
 *
 * ★ 它钉的就是 `newSpaceId` 铸出来的那个形状。
 */
const SPACE_ID_RE = /^s[0-9a-f]{12}$/;

/** 随机、**永不复用**。复用会让一份已回收数据的存储复活到新数据头上 ——
 *  「新建一份数据真的空白」的全部依据：若按端口命名，A 回收后端口被新数据 B 复用，
 *  B 就会继承 A 的 localStorage 和登录 cookie。 */
function newSpaceId() {
  return 's' + crypto.randomBytes(6).toString('hex');
}

/**
 * 规整一份数据；字段不合法则返回 null（同 normalizeConnection 的规矩，不静默填空）。
 *
 * ★ 三格都进路径（`persist:<插件 id>@<共享组>@<数据空间 id>`），三格都要查：
 *   · `pluginId` —— 形状取自 `plugin-data.js` 的 `PLUGIN_ID_RE`（从 ULID 字母表派生，
 *     不是抄一份）；
 *   · `group`   —— 这里查的是**进路径的安全性**（长度 + 字符集），**不是**清单那条规则
 *     （"共享组名还是版本号"由 `inspectDir` 判，而一个值可能两者都是）；
 *   · `id`      —— 见 `SPACE_ID_RE`。
 *
 * ★ `ports` **必须是列表** —— 个数由清单声明（`contributes.ports`，见 `plugin-data.js`
 *   的 `portCountOf`），今天每一个插件声明的都是 0 或 1。写成"就先一个数"会让"个数"
 *   在盘上长出第二种形状，而读的人得先猜是哪一种；列表则从第一天就答得了"更多"，
 *   到时不用动 schema。
 *   ★ 而**列表不能空**：空的这一份整份丢掉（见下），于是引用表会指着一份不存在的数据。
 */
function normalizeSpace(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id
    : (typeof fallbackId === 'string' && fallbackId ? fallbackId : newSpaceId());
  if (!SPACE_ID_RE.test(id)) return null;
  if (typeof raw.pluginId !== 'string' || !pluginData.PLUGIN_ID_RE.test(raw.pluginId)) return null;
  if (typeof raw.group !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,31}$/.test(raw.group)) return null;
  const ports = (Array.isArray(raw.ports) ? raw.ports : [])
    .map(Number)
    .filter((p) => Number.isInteger(p) && p >= 1024 && p <= 65535);
  if (!ports.length) return null;
  return { id, pluginId: raw.pluginId, group: raw.group, ports };
}

function findSpace(cfg, id) {
  return ((cfg && cfg.spaces) || []).find((s) => s.id === id) || null;
}

/** 已被**其他**数据空间占用的端口。给隧道的端口顺移用 —— 见 tunnel.js 的 excludePorts。 */
function usedSpacePorts(cfg, exceptId) {
  const s = new Set();
  for (const sp of ((cfg && cfg.spaces) || [])) {
    if (!sp || sp.id === exceptId) continue;
    for (const p of (sp.ports || [])) s.add(p);
  }
  return s;
}

/**
 * 一份数据**该占哪几个端口**：从 18080 起，取 `count` 个当前没被占用的。
 * **确定性**，不探测 OS。
 *
 * 不探测的理由：探测是一次有竞态的快照，而且会让「同一份配置在不同时刻算出不同端口」——
 * 那就等于每次启动都可能换 origin。
 *
 * ★ **调用它的地方只有一个时机：一份数据被创建的时候。** 此后再没有任何东西改
 *   这些值 —— 端口是数据空间的**只读属性**（隧道顺移之后**不**把它写回来：写回来
 *   等于把一次**暂时**的冲突变成永久的 origin 变更 —— 冲突消失之后 origin 也
 *   回不去，而原来那份布局本来是可以回来的）。
 *   EADDRINUSE 由 `tunnel.js` 的顺移处理，**顺移只影响这一次会话**。
 *
 * ★ **它是"个数"唯一落地的地方。** 个数由清单声明（`plugin-data.js` 的
 *   `portCountOf`），而"哪几个"由这里算 —— 这两件事分开是有意的：前者是作者的话，
 *   后者是这台机器当前的占用情况。
 *
 * @param {number} count 要几个。**必须 ≥ 1** —— 一份数据的 ports 列表不能是空的
 *   （空列表会让 `normalizeSpace` 把整份数据丢掉，于是引用表指着一份不存在的东西）。
 *   调用方保证得到这一点：只有 `needsSpace` 为真的插件会走到这里。
 * @param {Set<number>} [extraPorts] **配置之外**还占着的端口。今天唯一的来源是
 *   临时那一份数据（它们**不在** `cfg.spaces` 里，见 index.js 的 `tempSpaces`）。
 *   ★ 不让这个函数自己去问临时那份，是因为这一层**只认配置**（`usedSpacePorts`
 *   的语义就是"配置里的"）—— 把第二个来源焊进来，这一层就再也说不清它数的是
 *   什么了。调用方把两半并好再传进来。
 *   ★ 不传 = 只有配置说了算。
 * @returns {number[]} 升序，长度等于 `count`。够不够得看 65535 那道天花板 ——
 *   取不满时返回的列表**短一截**，由 `normalizeSpace`（至少一个）与调用方各自把关。
 */
function assignSpacePorts(cfg, count, extraPorts) {
  const used = usedSpacePorts(cfg, null);
  if (extraPorts) for (const p of extraPorts) used.add(p);
  const out = [];
  let p = SPACE_PORT_BASE;
  while (out.length < count && p <= 65535) {
    if (!used.has(p)) { used.add(p); out.push(p); }
    p += 1;
  }
  return out;
}

/** 「工作区 N」，N 取当前没被占用的最小正整数。确定性、不撞名。 */
function nextWorkspaceName(cfg) {
  const taken = new Set(((cfg && cfg.workspaces) || [])
    .map((l) => /^工作区 (\d+)$/.exec((l && l.name) || ''))
    .filter(Boolean).map((m) => Number(m[1])));
  let n = 1;
  while (taken.has(n)) n += 1;
  return `工作区 ${n}`;
}

// ★ **别在这里长出一条带回落的取端口函数** —— 一条"数据空间不存在就回落到
//   `SPACE_PORT_BASE`"的路是临时那一份最危险的一格：它不在配置里，
//   于是每一份临时数据都会"回落到" 18080，也就是**持有者自己那个端口** ⇒ 每次开局
//   都推一条"端口被占、布局会重置"的**假警报**，而且同一份配置在不同启动顺序下会
//   得到不同的 origin。取端口只有一条路：`index.js` 的 `spacePortOf`（先查配置、
//   再查临时那份，都没有就抛）。

/**
 * 这个工作区里，这个插件该用**哪一份数据** —— 没有就地建一份。
 *
 * @param {string} group 这个插件**现在**算出来的共享组（`plugin-data.js` 的 `groupOf`）。
 *        ★ 由调用方给，因为这一层不认识插件，也不该认识 —— 它只管存。
 *        ★ 而它**必须**参与判据：记着的那一份共享组与现在算出来的不一致，说明作者
 *        换了共享组（或者改了 `perVersion`），那一份数据这个插件已经**读不到**了
 *        （路径的中间那一段变了），必须新开一份。继续用旧的那份会让插件读写一份
 *        它自己声明过"不再继承"的数据。
 * @param {number} count 这一份数据要几个端口（`plugin-data.js` 的 `portCountOf`）。
 *        ★ 同样由调用方给，理由同上：个数是作者的话，这一层只负责把它兑现成端口。
 * @param {Set<number>} [extraPorts] 见 `assignSpacePorts`
 * @returns {{space:object, created:boolean}|null} 工作区不存在时 null。
 *   `created` 是**给调用方省一次无谓的落盘**用的（这一格绝大多数调用都命中已有的那一份）。
 *
 * ★ **不落盘** —— 由调用方统一走 saveConfig / commitConfig（与 setConnectionWorkspace 同规矩）。
 */
function spaceFor(cfg, workspaceId, pluginId, group, count, extraPorts) {
  const ws = findWorkspace(cfg, workspaceId);
  if (!ws) return null;
  if (!ws.refs || typeof ws.refs !== 'object') ws.refs = {};
  const cur = findSpace(cfg, ws.refs[pluginId]);
  // ★ 共享组对不上（见上）时走这一支：**换掉引用、把旧那一份留给 `pruneSpaces`**。
  //   就地改 `cur.group` 是错的 —— 那等于把一份已经写好的数据改名，而它下面那份
  //   存储还在旧名字的目录里。
  if (cur && cur.group === group) return { space: cur, created: false };
  // ★ 地板，不是缺省：一张 ports 列表**不能是空的**（`normalizeSpace` 会把空的那份
  //   整份丢掉，于是引用表指着一份不存在的数据 —— 一个下次启动才会发作的静默损坏）。
  //   走到这里的调用方都保证 ≥ 1（`needsSpace`），这一句只是让"万一"有一个说得清的下场。
  const n = Number.isInteger(count) && count > 0 ? count : 1;
  const space = {
    id: newSpaceId(),
    pluginId,
    group,
    ports: assignSpacePorts(cfg, n, extraPorts),
  };
  cfg.spaces = [...(cfg.spaces || []), space];
  ws.refs[pluginId] = space.id;
  return { space, created: true };
}

/**
 * 改一条连接指向哪个工作区。**不落盘** —— 由调用方统一走 commitConfig()。
 */
function setConnectionWorkspace(cfg, connId, workspaceId) {
  if (!(cfg.connections || []).some((c) => c.id === connId)) {
    return { ok: false, error: '这条连接不存在。' };
  }
  if (workspaceId && !findWorkspace(cfg, workspaceId)) {
    return { ok: false, error: '这个工作区不存在。' };
  }
  cfg.connections = cfg.connections.map(
    (c) => (c.id === connId ? { ...c, workspaceId } : c));
  return { ok: true };
}

/** 谁在引用这一份数据 —— 指向它的工作区 id。 */
function spaceConsumers(cfg, spaceId) {
  const out = [];
  for (const l of ((cfg && cfg.workspaces) || [])) {
    if (Object.values((l && l.refs) || {}).includes(spaceId)) out.push(l.id);
  }
  return out;
}

/**
 * 回收引用计数归零的工作区。**由 index.js 在每一次会改变引用计数的改动之后统一调用**
 * （commitConfig）—— 漏掉一处的后果是某个工作区永远不被回收。
 *
 * @returns {{removed: string[]}} 被删掉的工作区 id（调用方据此清理它们名下的数据空间）
 *   ★ **它不碰数据空间**：一个被删的工作区指着的那些数据，可能还被别的工作区指着。
 *     那一层由 `pruneSpaces` 数（见它那段）。
 */
function pruneWorkspaces(cfg) {
  // ★ 一条连接都没有时**不回收**。演示模式（以及「全新安装、还没配任何连接」）
  //   会有一个不属于任何连接的工作区 —— 它是那次会话的工作区身份。在这里把它删掉，
  //   下次开会话又会造一个新的，而 id 一变引用表就变，布局白重置一次。
  //   没有任何映射关系要维护的时候，「回收」无事可做。
  if (!(cfg.connections || []).length) return { removed: [] };

  const counts = new Map();
  for (const c of (cfg.connections || [])) {
    if (c.workspaceId) counts.set(c.workspaceId, (counts.get(c.workspaceId) || 0) + 1);
  }
  const removed = [];
  cfg.workspaces = (cfg.workspaces || []).filter((l) => {
    if ((counts.get(l.id) || 0) > 0) return true;
    removed.push(l.id);
    return false;
  });
  return { removed };
}

/**
 * 回收**没人引用的**数据空间。
 *
 * ★ 判据两层，缺一不可：
 *   · **没有任何工作区指着它**（引用表是唯一的所有权凭据）；
 *   · **此刻没有活会话拿着它**（`keepIds`）—— ★ 少了这一条就是**删活数据**：
 *     "把连接切到别的工作区"会让旧工作区引用计数归零、被回收，而那条会话**还跑在**
 *     它指过的那一份数据上（`app:setConnectionWorkspace` 对非活跃连接正是这样）。
 *
 * ★ 它与 `pruneWorkspaces` 是**两层**，不是一件事：一个工作区没了，它名下那些数据
 *   只有当**没有别的工作区**也指着它们时才会跟着没。一份数据被 A、B 两个工作区引用时，
 *   删 A 不动它 —— 这条正是"引用"这个词在这里的全部意思。
 *
 * @param {Set<string>} [keepIds] 此刻正被活会话拿着的那些
 * @returns {{removed: object[]}} 被删掉的那些（调用方据此清它们的两个落点）
 */
function pruneSpaces(cfg, keepIds) {
  const referenced = new Set();
  for (const l of ((cfg && cfg.workspaces) || [])) {
    for (const sid of Object.values((l && l.refs) || {})) if (sid) referenced.add(sid);
  }
  const keep = keepIds instanceof Set ? keepIds : new Set();
  const removed = [];
  cfg.spaces = (cfg.spaces || []).filter((s) => {
    if (referenced.has(s.id) || keep.has(s.id)) return true;
    removed.push(s);
    return false;
  });
  return { removed };
}

/**
 * 给界面用的**已推导**结构。renderer 只渲染、不做任何推导 ——
 * 它手里那份 refCount 随时可能已经陈旧（另一条连接刚被删），
 * 所以「要不要二次确认」的判定权必须在主进程。
 *
 * @returns {[{id, name, refCount, members:string[], soleOwnerId:string|null, spaces:string[]}]}
 *   soleOwnerId 非 null 表示「这个工作区只被这一条连接使用，切走就会被丢弃」。
 *   `spaces` = 这个工作区指着的那些数据（界面拿它把一条会话的 `spaceId` 对回工作区）。
 *   ★ **没有 `port`** —— 端口是数据空间的属性，一个工作区可能同时有好几个。
 */
function workspacePlan(cfg) {
  return ((cfg && cfg.workspaces) || []).map((l) => {
    const members = (cfg.connections || [])
      .filter((c) => c.workspaceId === l.id).map((c) => c.id);
    return {
      id: l.id, name: l.name,
      refCount: members.length,
      members,
      soleOwnerId: members.length === 1 ? members[0] : null,
      spaces: Object.values(l.refs || {}),
    };
  });
}

/**
 * 解析数据空间列表。
 *
 * 数据空间只有**一条来路**：磁盘上的 `spaces[]`（外加 index.js 里那张**只在内存里**的
 * 临时表 —— 它不走这里，因为它本来就不该落盘）。
 */
function loadSpaces(raw) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(raw.spaces)) {
    for (const s of raw.spaces) {
      const n = normalizeSpace(s, s && s.id);
      if (!n || seen.has(n.id)) continue;
      // 端口撞车就地挪开 —— 两份数据声称同一个端口会让它们每次启动互相抢，
      // 会话在两个 origin 之间反复横跳，而界面上一切正常。
      //   ★ 整份列表一起挪（`assignSpacePorts` 按**个数**取），不是只挪撞上的那一个：
      //     逐个挪的话，剩下那几个可能仍然与别人撞。
      if (n.ports.some((p) => out.some((x) => x.ports.includes(p)))) {
        n.ports = assignSpacePorts({ spaces: out }, n.ports.length, null);
      }
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}

/**
 * 解析工作区列表。
 *
 * 工作区只有**一条来路**：磁盘上的 `workspaces[]`。一个都没有而有连接时，就地补一个默认工作区。
 *
 * @param {Array} spaces 已经解析好的数据空间 —— 引用表里指向不存在的那一格要在这里收掉
 */
function loadWorkspaces(raw, connections, spaces) {
  const out = [];
  const seen = new Set();
  const known = new Set((spaces || []).map((s) => s.id));
  if (Array.isArray(raw.workspaces)) {
    for (const l of raw.workspaces) {
      const n = normalizeWorkspace(l, l && l.id);
      if (!n || seen.has(n.id)) continue;
      seen.add(n.id);
      // ★ 指向一份**不存在**的数据的那一格收掉（手改过配置，或那一份被回收了）。
      //   留着它的症状是"这个插件忽然读回一份旧数据"或者"一条指向空气的引用" ——
      //   而 `spaceFor` 下次开会话时会新开一份，所以收掉它是**安全的那一侧**。
      for (const [pluginId, spaceId] of Object.entries(n.refs)) {
        if (!known.has(spaceId)) delete n.refs[pluginId];
      }
      out.push(n);
    }
  }
  // 兜底：有连接却一个工作区都没有（手改过配置，或第一次配连接就写下了连接）。
  // ★ id 是**常量**，不是铸出来的 —— 理由写在 `DEFAULT_WORKSPACE_ID` 那一段注释里。
  if (out.length === 0 && connections.length > 0) {
    out.push({ id: DEFAULT_WORKSPACE_ID, name: '默认工作区', refs: {} });
  }
  // 每条连接都必须落在一个**存在**的工作区里。指向不存在的工作区 = 界面上一片空白，
  // 而用户看不出为什么。在这里收束掉，而不是让 UI 去处理 null。
  const first = out[0] ? out[0].id : null;
  for (const c of connections) {
    if (!out.some((l) => l.id === c.workspaceId)) c.workspaceId = first;
  }
  return out;
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function configPath(dir) { return path.join(dir, 'config.json'); }

/**
 * 读配置。**只认已知键**（见下面那段），而且**只认当前格式** —— 旧格式读作
 * "没有配过"（0.y 不考虑兼容性）。
 */
function loadConfig(dir) {
  const raw = readJson(configPath(dir));
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULTS);

  // **只认已知键**，不用 `...raw` 整包展开。
  // 整包展开的后果不是「多几个字段」那么轻：一个不认识的键会一直跟着配置文件活
  // 下去，每次保存都被原样写回，永远不消失 —— 将来读这份配置的人会以为它还有用，
  // 去代码里找一个早就不存在的行为。
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
  // ★ **不认识的字段不要"读进来但不用"** —— 一个没有读者的字段留在这里，下一个人
  //   会以为它还有用，然后把它接回某条路上。

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

  // 数据空间必须在工作区之前解析：引用表里指向不存在的那一格要按它收掉（loadWorkspaces
  // 的第三个数）。而两者都必须在连接之后：loadWorkspaces 要读 connections 才能把每条连接
  // 收束到一个存在的工作区里，而连接侧的去重可能已经剔掉了几条。
  cfg.spaces = loadSpaces(raw);
  cfg.workspaces = loadWorkspaces(raw, list, cfg.spaces);

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
 *   allowWorkspaceChange {boolean} 复用已有条目时是否允许改它的 workspaceId。默认**不许**：
 *                               按地址命中另一条（用户没带 id）却把它的工作区改掉，
 *                               是一次完全看不见的副作用。
 *
 * 新建的那条**不在这里**决定工作区：`workspaceId` 留 null，由 index.js 的
 * ensureConnectionWorkspace 统一分配（它需要 cfg 才能建新工作区）。两处都做会让
 * 「新连接落到哪个工作区」这条策略有两个说法。
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
  // workspaceId 由 ...prev 原样带过来 —— 「按地址命中已有条目」这条路径不该顺手改它的
  // 工作区，那是一次完全看不见的副作用。要改必须显式传 allowWorkspaceChange。
  const next = { ...prev, user: conn.user, host: conn.host, port: conn.port };
  if (opts.allowWorkspaceChange && conn.workspaceId) next.workspaceId = conn.workspaceId;

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
// **只读当前形态（schema 4）** —— 别的形状读作"没有这条密钥"（见 SECRET_ENCRYPTED 那段）。

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

// ★ **导出表是这个模块对外的承诺**，所以这里只留今天真有人读的名字 —— 谁在读它，
//   是靠"整个仓库搜一遍这个标识符"量出来的，不是靠感觉。它们都还在文件里、还在被
//   本文件用着，只是不**承诺**给别人。
//
//   ★ **别为了"导出给测试用"留一个 `_internal`**：一个没人读的接缝会让读代码的人
//     以为某条用例正踩着它。`config.test.mjs` 走的是这个模块的**公开面**
//     （`loadConfig` / `saveConfig` / `setKey` / `loadPinnedKeys` …），那才是它
//     该走的路；真需要某个内部函数时，加回一行就是一次**看得出来**的动作。
module.exports = {
  SCHEMA, DEFAULTS, PENDING_ID,
  loadConfig, saveConfig,
  RELAY_PORT_BASE,
  // 工作区（一张引用表）
  newWorkspaceId, normalizeWorkspace, findWorkspace,
  nextWorkspaceName, setConnectionWorkspace,
  pruneWorkspaces, workspacePlan,
  // 数据空间（一份存储 + 它自己的端口）
  newSpaceId, SPACE_ID_RE, normalizeSpace, findSpace,
  usedSpacePorts, assignSpacePorts, spaceFor, spaceConsumers, pruneSpaces,
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
