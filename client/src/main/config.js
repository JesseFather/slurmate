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

const SCHEMA = 5;   // 2：profile → connections；3：永远加密保存；4：每条连接一把密钥；
                    // 5：**布局组**（layouts[] + connections[].layoutId）取代 slots

// 私钥在磁盘上的存放形态。**只有一种能写**：encrypted。
// 'plain' 只是读取兼容 —— 旧版本的界面上有一个「明文保存（不推荐）」的选项，
// 别人机器上可能还留着那样一份文件。读得出来就必须读出来：报「读不出来」的后果是
// 用户以为密钥丢了，跑去重新生成、重新注册。读到时带上 legacy:true，由调用方加密重存。
const SECRET_ENCRYPTED = 'encrypted';
const LEGACY_SECRET_PLAIN = 'plain';

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
};

// ── 底层：原子写 + 显式权限 ──────────────────────────────────────────────────
function ensureDir(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch { /* Windows 上会失败，可忽略 */ }
}

function writeAtomic(file, text, mode) {
  ensureDir(path.dirname(file), 0o700);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode });
  try { fs.chmodSync(tmp, mode); } catch { /* Windows */ }
  fs.renameSync(tmp, file);
  // rename 之后权限已经是对的，但有些平台会继承旧文件的 mode —— 再确保一次
  try { fs.chmodSync(file, mode); } catch { /* Windows */ }
}

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

const LAYOUT_PORT_BASE = 18080;   // 与旧 slotPort 的 base 一致 —— 升级不换端口

/**
 * 迁移出来的那个布局组的保留 id。
 *
 * ★ 必须是**字面量**，不能是随机值：loadConfig 自己不写盘（见文件头原则三条），若这里
 *   合成随机 id，那么「读完配置、一次都没保存就退出」→ 下次启动换一个 id → 换 partition
 *   → 上一轮刚攒的布局凭空消失。这个坑很隐蔽，症状只是「布局又没了」。
 */
const LEGACY_LAYOUT_ID = 'legacy-1';

/**
 * 迁移出来的那个组的浏览器存储身份，以及 partition 名的**唯一例外**。
 *
 * partition 名就是 Electron 的存储目录名，所以「新 id → 新目录 → 天然空白」是
 * 「新建空白布局真的空白」的全部依据 —— 若按端口命名，A 组被回收后端口被新组 B 复用，
 * B 就会继承 A 的 localStorage 和登录 cookie。所以新组一律用 persist:layout-<id>。
 *
 * 但迁移出来的那个组**不改名**：用户的编辑器布局就躺在 persist:slot-1 里，改名等于把
 * 布局扔掉一次，而这个代价没有任何必要。
 *
 * 这不是「两套命名规则并存」：slot-1 只可能被这一个组用（loadLayouts 只在磁盘上还没有
 * layouts、且有 slots 时才合成它，一旦保存过就再也不会），而新组的 id 是 `l` + 随机 hex，
 * 永远撞不上 legacy-1。所以旧数据不可能被复活到新组头上。
 * 与 LEGACY_SECRET_PLAIN（旧明文密钥必须读得出来）、PENDING_ID 是同一类东西：
 * 一个为期永久的兼容别名。
 */
const LEGACY_PARTITION = 'persist:slot-1';

function partitionForLayout(id) {
  return id === LEGACY_LAYOUT_ID ? LEGACY_PARTITION : 'persist:layout-' + id;
}

/** 随机、**永不复用**。复用会让一个已回收组的存储复活到新组头上。 */
function newLayoutId() {
  return 'l' + crypto.randomBytes(6).toString('hex');
}

/** 规整一个布局组；字段不合法则返回 null（与 normalizeConnection 同规矩，不静默填空）。 */
function normalizeLayout(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : (fallbackId || newLayoutId()),
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
 * 那就等于每次启动都可能换 origin。EADDRINUSE 交给隧道顺移 + 写回来处理。
 */
function nextLayoutPort(cfg) {
  const used = usedLayoutPorts(cfg, null);
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

/** 取一个组配置的端口。组不存在时回落基址 —— 调用方应先确认组存在。 */
function layoutPort(cfg, id) {
  const l = findLayout(cfg, id);
  return l ? l.port : LAYOUT_PORT_BASE;
}

/**
 * 端口变了 origin 就变，code-server 的编辑器布局会全部重置 —— 所以必须持久化。
 * 与旧的 setSlotPort 理由完全相同（那个函数就是为这件事存在的）。
 *
 * 注意：这里自己 saveConfig 是**安全**的。端口写回只可能发生在「正在被某个连接指着的组」
 * 上（引用计数 ≥ 1），所以它不会与 pruneLayouts 冲突。改 hostKeys 的两个函数同理。
 * 会改变**引用计数**的改动才必须走 index.js 的 commitConfig()。
 */
function setLayoutPort(dir, cfg, id, port) {
  cfg.layouts = (cfg.layouts || []).map((l) => (l.id === id ? { ...l, port } : l));
  saveConfig(dir, cfg);
}

/** 改一条连接指向哪个组。**不落盘** —— 由调用方统一走 commitConfig()。 */
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

/** schema ≤ 4 的槽位 1 端口。沿用旧 slotPort 的校验；非法/缺失回落基址。 */
function legacySlotPort(slots) {
  const s = slots && slots['1'];
  return (s && Number.isInteger(s.port) && s.port >= 1024 && s.port <= 65535)
    ? s.port : LAYOUT_PORT_BASE;
}

/**
 * 解析布局组列表。三种来源，优先级从高到低。
 *
 * ★ 迁移这一路的两条要求，缺一条老用户的布局就会丢一次：
 *   ① 组 id 用**字面量** LEGACY_LAYOUT_ID（见上，确定性）；
 *   ② 端口**原样继承** slots["1"].port（不是回落 18080）—— 端口是 origin 的一半。
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
  } else if (raw.slots && typeof raw.slots === 'object') {
    // schema ≤ 4。全仓只有槽位 1 被用过（index.js 里三处写死 slot: 1）。
    out.push({ id: LEGACY_LAYOUT_ID, name: '默认布局', port: legacySlotPort(raw.slots) });
  }
  // 兜底：有连接却一个组都没有（手改过配置，或从更旧、没有槽位的版本上来）。
  // 这里用随机 id 更安全 —— 绝不能复活 legacy-1。
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
 * 读配置。
 *
 * 含一处**一次性迁移**：schema 1 的 `profile` + `extraHosts` 合并成 `connections`。
 * 不迁移的后果不是数据丢失那么明显 —— 是用户打开界面发现「之前填的地址没了」，
 * 而没有任何提示说为什么。
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

  // 连接列表：先取新格式，再补旧格式。
  // 去重按**两个**维度：id（同一个条目被写了两遍），以及身份
  // （user@host:port —— 旧版本每点一次「保存并连接」就新建一条，
  //   配置里可能已经攒了一串完全一样的条目。这里顺手清掉，
  //   否则用户升级完看到的还是那一堆，会以为修了个寂寞）。
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
  } else {
    // schema 1 的模型是「一个账号 + 若干备用地址」：账号在 profile 里，
    // extraHosts 只描述地址（没有 user 字段）。
    // 所以迁移时必须把 user/port **继承**过去 —— 否则这些条目会因为缺用户名
    // 被 normalizeConnection 判为不合法而丢掉，而用户看到的只是「我配的地址没了」，
    // 没有任何提示说为什么。
    const base = (raw.profile && typeof raw.profile === 'object') ? raw.profile : null;
    if (base && base.host) push(base);
    if (Array.isArray(raw.extraHosts)) {
      raw.extraHosts.forEach((h) => push(base ? { ...base, ...h } : h));
    }
  }

  cfg.connections = list;
  cfg.activeConnectionId = list.some((c) => c.id === raw.activeConnectionId)
    ? raw.activeConnectionId
    : (list[0] ? list[0].id : null);

  // 布局组必须在连接之后解析：迁移那一路要读 connections 才能把每条连接收束到一个
  // 存在的组里，而 connections 侧的去重可能已经剔掉了几条。
  // 旧的 slots 到这里自然消失（只认已知键，不写回），不需要显式删除。
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
// 旧形态（schema ≤ 3）是 { schema, mode, data } 一份全局密钥，见 migrateLegacySecret。

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
  // 写下去的就是新格式。旧格式那两个字段（data/mode）**不保留** ——
  // 能走到「已经写下新格式、旧格式那份还躺着」这一步，只可能是「有密钥但没有
  // 任何连接」的配置，而旧版本的界面根本不让人在没有连接的情况下配密钥。
  // 真正有可能带旧格式的用户，在 bootstrap 时就已经被 migrateLegacySecret 搬完了。
  writeSecretFile(dir, { schema: SCHEMA, keys });
  return { ok: true, mode: SECRET_ENCRYPTED };
}

/**
 * 取一条密钥。
 * @returns {{ok:true, value:string, mode:string, legacy?:true} | {ok:false, reason:string}}
 */
function getKey(dir, cryptoSafe, id) {
  const raw = readSecretFile(dir);
  if (!raw) return { ok: false, reason: 'not_saved' };
  const entry = raw.keys && raw.keys[id];
  if (!entry || typeof entry !== 'object' || typeof entry.data !== 'string') {
    return { ok: false, reason: 'not_saved' };
  }
  if (entry.mode === LEGACY_SECRET_PLAIN) {
    // 旧版本写下的明文。现在不再产生这种文件，但已经存在的那一份必须读得出来。
    // legacy:true 是在告诉调用方：这东西还以明文躺着，有条件就加密重存一遍。
    return { ok: true, value: entry.data, mode: LEGACY_SECRET_PLAIN, legacy: true };
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

/**
 * 把旧版本那份**全局**密钥搬到新格式里。
 *
 * 旧格式里一把密钥服务所有连接，所以这里把它原样复制给每一条已有连接 ——
 * 那正是升级前的事实，复制之后每一条的行为都不变，用户也不必重新注册。
 * 之后各条可以各自「重新生成」，互不影响。
 *
 * 一条连接都没有时**什么也不做**（把文件留着），等有了第一条再搬 ——
 * 那时它会被交给那条连接。删掉它则等于让用户已经注册过的公钥凭空消失。
 *
 * @returns {{migrated:boolean, count?:number, deferred?:boolean}}
 */
function migrateLegacySecret(dir, ids) {
  const raw = readSecretFile(dir);
  if (!raw || typeof raw.data !== 'string') return { migrated: false };
  if (raw.mode !== SECRET_ENCRYPTED && raw.mode !== LEGACY_SECRET_PLAIN) {
    return { migrated: false };
  }
  if (!Array.isArray(ids) || ids.length === 0) return { migrated: false, deferred: true };

  // 保留文件里已有的条目（正常情况下不会有 —— 见 setKey 的注释），只补缺的那些。
  // 手改过的文件不该因为一次迁移就丢掉别的密钥。
  const keys = (raw.keys && typeof raw.keys === 'object') ? { ...raw.keys } : {};
  let added = 0;
  for (const id of ids) {
    if (keys[id]) continue;
    keys[id] = { mode: raw.mode, data: raw.data };
    added += 1;
  }
  if (added === 0) return { migrated: false };
  writeSecretFile(dir, { schema: SCHEMA, keys });
  return { migrated: true, count: added };
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

module.exports = {
  SCHEMA, DEFAULTS, SECRET_ENCRYPTED, LEGACY_SECRET_PLAIN, PENDING_ID,
  loadConfig, saveConfig,
  // 布局组
  LAYOUT_PORT_BASE, LEGACY_LAYOUT_ID, LEGACY_PARTITION, partitionForLayout,
  newLayoutId, normalizeLayout, findLayout, usedLayoutPorts, nextLayoutPort,
  nextLayoutName, layoutPort, setLayoutPort, setConnectionLayout,
  pruneLayouts, layoutPlan,
  activeConnection, newConnectionId, normalizeConnection,
  connectionKey, upsertConnection,
  checkHostKey, rememberHostKey, forgetHostKey, hostKeyId,
  setKey, getKey, deleteKey, hasKey, migrateLegacySecret, readSecretFile,
  addPendingGoodbye, listPendingGoodbye, removePendingGoodbye,
  // 导出给测试用
  _internal: { writeAtomic, readJson, configPath, secretPath, pendingGoodbyePath },
};
