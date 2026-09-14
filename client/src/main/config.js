'use strict';
/**
 * config.js —— 本地配置与凭据的持久化。
 *
 * 两条设计原则，都是被这个项目里反复出现的「静默失败」逼出来的：
 *
 * 1. **写盘一律原子**（写临时文件 + rename），且**显式 chmod**。`writeFileSync` 的
 *    mode 参数在文件已存在时不生效 —— 光靠它会让一个曾经 0644 的凭据文件永远是 0644。
 *
 * 2. **口令存储绝不静默降级**。Linux 上没有 keyring 时 `safeStorage.isEncryptionAvailable()`
 *    返回 false；此时【不能】悄悄改成明文写盘。调用方必须拿到一个明确的结果，由界面
 *    让用户选「不保存」还是「明文保存」。悄悄写明文，正是我们一路在清的那类问题。
 */

const fs = require('fs');
const path = require('path');

const SCHEMA = 1;

const PASSWORD_MODE = {
  ASK: 'ask',              // 还没决定（首次设置时问用户）
  NONE: 'none',            // 不保存
  ENCRYPTED: 'encrypted',  // safeStorage
  PLAIN: 'plain',          // 明文，0600，用户明确选择过
};

const DEFAULTS = {
  schema: SCHEMA,
  profile: { user: '', host: '', port: 10100 },
  slots: {},                       // { "1": { port: 18080 } }  —— 槽位 → 实际本地端口
  maxSessions: 1,
  passwordMode: PASSWORD_MODE.ASK,
  extraHosts: [],                  // [{ host, port, label, priority }]
  shortcutDiag: false,
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

// ── 配置 ────────────────────────────────────────────────────────────────────
function configPath(dir) { return path.join(dir, 'config.json'); }

function loadConfig(dir) {
  const raw = readJson(configPath(dir));
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULTS);
  return {
    ...structuredClone(DEFAULTS),
    ...raw,
    schema: SCHEMA,
    profile: { ...DEFAULTS.profile, ...(raw.profile || {}) },
    slots: (raw.slots && typeof raw.slots === 'object') ? raw.slots : {},
    extraHosts: Array.isArray(raw.extraHosts) ? raw.extraHosts : [],
  };
}

function saveConfig(dir, cfg) {
  writeAtomic(configPath(dir), JSON.stringify({ ...cfg, schema: SCHEMA }, null, 2), 0o600);
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

// ── 凭据 ────────────────────────────────────────────────────────────────────
function secretPath(dir) { return path.join(dir, 'secrets.json'); }

/**
 * 存口令。
 *
 * @param {object|null} crypto  Electron 的 safeStorage 封装：{ encrypt(str)->Buffer, decrypt(Buffer)->str }
 *                              传 null 表示这台机器上没有可用的安全存储。
 * @returns {{ok:true, mode:string} | {ok:false, reason:string}}
 *
 * **调用方必须先读返回值**。mode='plain' 只有在用户明确同意后才允许传入。
 */
function setPassword(dir, crypto, mode, password) {
  if (mode === PASSWORD_MODE.NONE) {
    clearPassword(dir);
    return { ok: true, mode };
  }
  if (mode === PASSWORD_MODE.ENCRYPTED) {
    if (!crypto) {
      // 绝不降级成明文 —— 明确失败，让界面去问用户
      return { ok: false, reason: 'no_secure_storage' };
    }
    let buf;
    try {
      buf = crypto.encrypt(password);
    } catch (e) {
      return { ok: false, reason: 'encrypt_failed: ' + e.message };
    }
    writeAtomic(secretPath(dir),
      JSON.stringify({ schema: SCHEMA, mode, data: buf.toString('base64') }), 0o600);
    return { ok: true, mode };
  }
  if (mode === PASSWORD_MODE.PLAIN) {
    writeAtomic(secretPath(dir),
      JSON.stringify({ schema: SCHEMA, mode, data: password }), 0o600);
    return { ok: true, mode };
  }
  return { ok: false, reason: 'bad_mode: ' + mode };
}

/**
 * 取口令。
 * @returns {{ok:true, password:string, mode:string} | {ok:false, reason:string}}
 */
function getPassword(dir, crypto) {
  const raw = readJson(secretPath(dir));
  if (!raw || typeof raw !== 'object' || typeof raw.data !== 'string') {
    return { ok: false, reason: 'not_saved' };
  }
  if (raw.mode === PASSWORD_MODE.PLAIN) {
    return { ok: true, password: raw.data, mode: PASSWORD_MODE.PLAIN };
  }
  if (raw.mode === PASSWORD_MODE.ENCRYPTED) {
    if (!crypto) {
      return { ok: false, reason: 'no_secure_storage' };
    }
    try {
      return { ok: true, password: crypto.decrypt(Buffer.from(raw.data, 'base64')),
               mode: PASSWORD_MODE.ENCRYPTED };
    } catch (e) {
      // 换过机器、换过用户、keyring 被重置 —— 都会走到这里
      return { ok: false, reason: 'decrypt_failed: ' + e.message };
    }
  }
  return { ok: false, reason: 'bad_mode: ' + raw.mode };
}

function clearPassword(dir) {
  try { fs.unlinkSync(secretPath(dir)); } catch { /* 本来就不存在 */ }
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
  SCHEMA, DEFAULTS, PASSWORD_MODE,
  loadConfig, saveConfig, slotPort, setSlotPort,
  setPassword, getPassword, clearPassword,
  addPendingGoodbye, listPendingGoodbye, removePendingGoodbye,
  // 导出给测试用
  _internal: { writeAtomic, readJson, configPath, secretPath },
};
