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

const SCHEMA = 3;   // 2：profile → connections；3：删掉「私钥保存方式」（永远加密保存）

// 私钥在磁盘上的存放形态。**只有一种能写**：encrypted。
// 'plain' 只是读取兼容 —— 旧版本的界面上有一个「明文保存（不推荐）」的选项，
// 别人机器上可能还留着那样一份文件。读得出来就必须读出来：报「读不出来」的后果是
// 用户以为密钥丢了，跑去重新生成、重新注册。读到时带上 legacy:true，由调用方加密重存。
const SECRET_ENCRYPTED = 'encrypted';
const LEGACY_SECRET_PLAIN = 'plain';

const DEFAULTS = {
  schema: SCHEMA,
  // 登录节点连接条目。支持多条是因为同一个登录节点常有多个入口
  // （内网、公网域名、跳板机），换网络环境时不该重新填一遍。
  connections: [],          // [{ id, label, user, host, port }]
  activeConnectionId: null,
  // 主机密钥指纹（TOFU）。键是 "host:port"，值是 "SHA256:…"。
  // ssh2 默认【不校验】主机密钥，不自己存一份就等于裸奔（见 backend-ssh.js）。
  hostKeys: {},
  slots: {},                // { "1": { port: 18080 } } —— 槽位 → 实际本地端口
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

/** 把任意输入规整成一条合法连接；字段不合法则返回 null（由调用方报错，不静默填空）。 */
function normalizeConnection(raw, fallbackId) {
  if (!raw || typeof raw !== 'object') return null;
  const user = String(raw.user || '').trim();
  const host = String(raw.host || '').trim();
  const port = Number(raw.port);
  if (!user || !host) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : (fallbackId || newConnectionId()),
    label: String(raw.label || '').trim() || host,
    user, host, port,
  };
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
  if (raw.slots && typeof raw.slots === 'object') cfg.slots = raw.slots;
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

  return cfg;
}

/**
 * 新增一条连接，或复用已有那条一模一样的。
 *
 * ★ 这是「相同条目检测」的落点。判断依据是 user@host:port，不是 id：
 *   界面上不修改任何字段、连点两次「保存并连接」，不该得到两条一样的条目 ——
 *   列表会越点越长，而用户分不清该点哪一条。
 *
 * @returns {{connection:object, created:boolean}|null}  输入不合法时返回 null
 */
function upsertConnection(cfg, input) {
  const conn = normalizeConnection(input, input && input.id);
  if (!conn) return null;

  const key = connectionKey(conn);
  const idx = cfg.connections.findIndex((c) => c.id === conn.id || connectionKey(c) === key);

  if (idx < 0) {
    cfg.connections = [...cfg.connections, conn];
    return { connection: conn, created: true };
  }

  const prev = cfg.connections[idx];
  // 复用旧条目：**id 用回旧的那个**（可能已经被 activeConnectionId 之类引用着）。
  // label 只在这次给了一个有意义的名字时才覆盖 —— 界面上的表单没有「备注」这一栏，
  // 传进来的 label 就是 host；拿它把用户手写的「内网」冲掉是静默的信息丢失。
  const next = {
    ...prev,
    user: conn.user,
    host: conn.host,
    port: conn.port,
    label: (conn.label && conn.label !== conn.host) ? conn.label : prev.label,
  };
  cfg.connections = cfg.connections.map((c, i) => (i === idx ? next : c));
  return { connection: next, created: false };
}

function saveConfig(dir, cfg) {
  writeAtomic(configPath(dir), JSON.stringify({ ...cfg, schema: SCHEMA }, null, 2), 0o600);
}

function activeConnection(cfg) {
  return (cfg.connections || []).find((c) => c.id === cfg.activeConnectionId) || null;
}

/**
 * 取槽位的本地端口。**必须持久化** —— 端口变了 origin 就变，code-server 存在
 * localStorage 里的编辑器布局会全部重置。所以这里不做「每次重算」，而是记住。
 */
function slotPort(cfg, slot, base = 18080) {
  const s = cfg.slots[String(slot)];
  if (s && Number.isInteger(s.port) && s.port >= 1024 && s.port <= 65535) return s.port;
  return base + (slot - 1);
}

function setSlotPort(dir, cfg, slot, port) {
  cfg.slots = { ...cfg.slots, [String(slot)]: { port } };
  saveConfig(dir, cfg);
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

// ── 凭据（SSH 私钥）────────────────────────────────────────────────────────
function secretPath(dir) { return path.join(dir, 'secrets.json'); }

/**
 * 存凭据（当前只有一样：SSH 私钥的 PEM 文本）。
 *
 * **只有加密一种方式。** 界面上不再有「保存方式」这个下拉框 —— 一个需要用户
 * 在「安全」和「不安全」之间做选择的设计，本身就是设计失败：选明文的那个用户
 * 并不知道自己在放弃什么，而选加密的那个也不该为此感到庆幸。
 *
 * @param {object|null} cryptoSafe  Electron 的 safeStorage 封装：
 *                                  { encrypt(str)->Buffer, decrypt(Buffer)->str }
 *                                  传 null 表示这台机器上没有可用的安全存储。
 * @returns {{ok:true, mode:'encrypted'} | {ok:false, reason:string}}
 *
 * **调用方必须先读返回值**：这台机器存不了密钥时，唯一诚实的做法是如实说出来，
 * 而不是降级成明文让它「看起来存上了」。
 */
function setSecret(dir, cryptoSafe, value) {
  if (!cryptoSafe) return { ok: false, reason: 'no_secure_storage' };
  let buf;
  try {
    buf = cryptoSafe.encrypt(value);
  } catch (e) {
    return { ok: false, reason: 'encrypt_failed: ' + e.message };
  }
  writeAtomic(secretPath(dir),
    JSON.stringify({ schema: SCHEMA, mode: SECRET_ENCRYPTED, data: buf.toString('base64') }), 0o600);
  return { ok: true, mode: SECRET_ENCRYPTED };
}

/**
 * 取凭据。
 * @returns {{ok:true, value:string, mode:string, legacy?:true} | {ok:false, reason:string}}
 */
function getSecret(dir, cryptoSafe) {
  const raw = readJson(secretPath(dir));
  if (!raw || typeof raw !== 'object' || typeof raw.data !== 'string') {
    return { ok: false, reason: 'not_saved' };
  }
  if (raw.mode === LEGACY_SECRET_PLAIN) {
    // 旧版本写下的明文。现在不再产生这种文件，但已经存在的那一份必须读得出来。
    // legacy:true 是在告诉调用方：这东西还以明文躺着，有条件就加密重存一遍。
    return { ok: true, value: raw.data, mode: LEGACY_SECRET_PLAIN, legacy: true };
  }
  if (raw.mode !== SECRET_ENCRYPTED) {
    return { ok: false, reason: 'bad_mode: ' + raw.mode };
  }
  if (!cryptoSafe) {
    return { ok: false, reason: 'no_secure_storage' };
  }
  try {
    return { ok: true, value: cryptoSafe.decrypt(Buffer.from(raw.data, 'base64')),
             mode: SECRET_ENCRYPTED };
  } catch (e) {
    // 换过机器、换过用户、keyring 被重置 —— 都会走到这里
    return { ok: false, reason: 'decrypt_failed: ' + e.message };
  }
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
  SCHEMA, DEFAULTS, SECRET_ENCRYPTED,
  loadConfig, saveConfig, slotPort, setSlotPort,
  activeConnection, newConnectionId, normalizeConnection,
  connectionKey, upsertConnection,
  checkHostKey, rememberHostKey, forgetHostKey, hostKeyId,
  setSecret, getSecret,
  addPendingGoodbye, listPendingGoodbye, removePendingGoodbye,
  // 导出给测试用
  _internal: { writeAtomic, readJson, configPath, secretPath, pendingGoodbyePath },
};
