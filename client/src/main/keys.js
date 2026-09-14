'use strict';
/**
 * keys.js —— SSH 密钥对的生成、封装与自托管。
 *
 * ── 为什么自己生成、自己保管，而不是用 ~/.ssh 里的密钥 ────────────────────────
 *
 * 用户已经有一把（或几把）日常登录用的密钥。Slurmate 直接拿来用有两个问题：
 * 一是权限过大（那把密钥能登所有机器，客户端只是要用它连一个登录节点），
 * 二是**生命周期错位** —— 用户换机器、换密钥、删密钥时，客户端会毫无征兆地失效，
 * 而报错只会说「认证失败」。
 *
 * 所以这里生成一把**专用**密钥：私钥由客户端自托管，公钥由用户拿去 IDM 注册。
 * 两者互不影响 —— 删掉 Slurmate 不会动用户自己的 SSH 配置，反之亦然。
 *
 * ── 为什么不用系统的 ssh-keygen ────────────────────────────────────────────
 *
 * 打包后的 Electron 应用不能假设用户机器上有它（Windows 要额外装 OpenSSH，
 * 而且路径未必在 PATH 上）。Node 内置 crypto 能生成 ed25519，但：
 *
 *   **它导出的 PKCS#8 PEM 私钥，ssh2 不认** —— 实测报 `Unsupported key format`
 *   （ssh2 1.17.0，2026-09-14 探测）。所以私钥必须手工封装成 OpenSSH 的
 *   `openssh-key-v1` 格式。这不是「更优雅的做法」，是**唯一能走通的路**。
 *
 * 手工封装的风险是「看着对、其实错」—— 拼出来的东西能被解析，但签出来的名
 * 验不过（或者更糟：签出来的名是错的，直到用户连不上才发现）。
 * 所以正确性不靠肉眼看 base64，靠 test/keys.test.mjs 里的密码学断言：
 * **用生成的私钥签名，用 Node 原生 crypto 拿对应的公开钥验签** ——
 * 对的消息必须过，篡改的消息必须不过。两件事同时成立才算对。
 *
 * ── 公钥为什么不落盘 ──────────────────────────────────────────────────────
 *
 * 公钥可以从私钥推导（openssh-key-v1 的明文体里就含公钥 blob，见 decodePrivate）。
 * 单独存一份会引入「两份数据不一致」的可能 —— 用户复制去 IDM 注册的是 A，
 * 实际连接用的是 B，而症状只是「认证失败」。推导出来的东西骗不了人。
 */

const crypto = require('crypto');

const KEY_TYPE = 'ssh-ed25519';
const RAW_KEY_LEN = 32;          // ed25519 公钥固定 32 字节
const PRIV_KEY_LEN = 64;         // ed25519 私钥 = seed(32) || pub(32)
const OPENSSH_MAGIC = Buffer.from('openssh-key-v1\0', 'binary');
const PEM_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const PEM_END = '-----END OPENSSH PRIVATE KEY-----';
const PEM_WRAP = 70;             // OpenSSH 自己的换行宽度，照抄以便 diff 友好

// ── openssh-key-v1 的底层编解码 ─────────────────────────────────────────────
// 格式就是一连串 SSH string（uint32 大端长度 + 内容），没有别的花样。

function sshString(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function readString(buf, offset) {
  if (offset + 4 > buf.length) return null;
  const len = buf.readUInt32BE(offset);
  const start = offset + 4;
  if (start + len > buf.length) return null;
  return { value: buf.subarray(start, start + len), next: start + len };
}

function readUInt32(buf, offset) {
  if (offset + 4 > buf.length) return null;
  return { value: buf.readUInt32BE(offset), next: offset + 4 };
}

// ── 生成 ────────────────────────────────────────────────────────────────────

/**
 * 从 Node 的 KeyObject 里取出 ed25519 的原生 32 字节公钥与 32 字节 seed。
 *
 * 取法依赖两个固定长度的 DER 结构，两者都是定长的（ed25519 没有可选参数）：
 *   SPKI  DER = 44 字节 = 12 字节头 + 32 字节公钥
 *   PKCS#8 DER = 48 字节 = 16 字节头 + 32 字节 seed
 * 直接用 `subarray(-32)` 取尾部，并在下面断言长度 —— 一旦将来某个 Node 版本的
 * 编码变了，这里会**明确报错**，而不是悄悄产出一把坏密钥。
 */
function extractRawKeys(privateKeyObject, publicKeyObject) {
  const spki = publicKeyObject.export({ type: 'spki', format: 'der' });
  const pkcs8 = privateKeyObject.export({ type: 'pkcs8', format: 'der' });
  if (spki.length !== 44) {
    throw new Error(`ed25519 SPKI DER 长度异常：期望 44，实得 ${spki.length}`);
  }
  if (pkcs8.length !== 48) {
    throw new Error(`ed25519 PKCS#8 DER 长度异常：期望 48，实得 ${pkcs8.length}`);
  }
  return {
    publicRaw: Buffer.from(spki.subarray(spki.length - RAW_KEY_LEN)),
    seed: Buffer.from(pkcs8.subarray(pkcs8.length - RAW_KEY_LEN)),
  };
}

/** 公钥 blob = string("ssh-ed25519") || string(pub32)。这是 SSH 协议里的标准表示。 */
function publicBlobOf(publicRaw) {
  return Buffer.concat([sshString(Buffer.from(KEY_TYPE)), sshString(publicRaw)]);
}

/**
 * 封装成 openssh-key-v1 私钥（cipher=none，即不加密 —— 加密由 safeStorage 在外面做）。
 *
 * 布局：
 *   "openssh-key-v1\0"
 *   string ciphername("none") string kdfname("none") string kdfoptions("")
 *   uint32 密钥数(1)
 *   string 公钥 blob
 *   string 私有段（下面这个）
 *
 * 私有段（未加密时就是明文）：
 *   uint32 checkint  uint32 checkint（必须相等，否则 OpenSSH 判为口令错误）
 *   string "ssh-ed25519"  string pub32  string priv64  string comment
 *   填充 1,2,3… 直到长度为 8 的倍数（"none" 的块大小是 8）
 */
function encodePrivate(seed, publicRaw, comment) {
  const keyType = Buffer.from(KEY_TYPE);
  const checkint = crypto.randomBytes(4).readUInt32BE(0);
  const checks = Buffer.alloc(8);
  checks.writeUInt32BE(checkint, 0);
  checks.writeUInt32BE(checkint, 4);

  const priv64 = Buffer.concat([seed, publicRaw]);
  const body = Buffer.concat([
    checks,
    sshString(keyType),
    sshString(publicRaw),
    sshString(priv64),
    sshString(Buffer.from(comment, 'utf8')),
  ]);

  const padLen = (8 - (body.length % 8)) % 8;
  const padding = Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1));

  const one = Buffer.alloc(4);
  one.writeUInt32BE(1, 0);

  const blob = Buffer.concat([
    OPENSSH_MAGIC,
    sshString(Buffer.from('none')),
    sshString(Buffer.from('none')),
    sshString(Buffer.alloc(0)),
    one,
    sshString(publicBlobOf(publicRaw)),
    sshString(Buffer.concat([body, padding])),
  ]);

  const b64 = blob.toString('base64').match(new RegExp(`.{1,${PEM_WRAP}}`, 'g')).join('\n');
  return `${PEM_BEGIN}\n${b64}\n${PEM_END}\n`;
}

/**
 * 解出 openssh-key-v1 里的公开信息。
 *
 * 只读**明文体**（公钥 blob 本来就在明文段里，cipher=none 时私有段也是明文）。
 * 刻意不尝试解密：带口令的私钥走不到这条路 —— 我们生成的从来不带口令，
 * 加密是 safeStorage 在文件层做的。所以遇到加密的私钥就明确返回 null，
 * 由调用方报错，而不是猜。
 */
function decodePrivate(pem) {
  if (typeof pem !== 'string') return null;
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  let blob;
  try {
    blob = Buffer.from(body, 'base64');
  } catch {
    return null;
  }
  if (blob.length < OPENSSH_MAGIC.length) return null;
  if (!blob.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) return null;

  let off = OPENSSH_MAGIC.length;
  const cipher = readString(blob, off); if (!cipher) return null; off = cipher.next;
  const kdf = readString(blob, off); if (!kdf) return null; off = kdf.next;
  const kdfOpts = readString(blob, off); if (!kdfOpts) return null; off = kdfOpts.next;
  const nkeys = readUInt32(blob, off); if (!nkeys) return null; off = nkeys.next;
  const pubBlob = readString(blob, off); if (!pubBlob) return null; off = pubBlob.next;

  const cipherName = cipher.value.toString('utf8');
  const kdfName = kdf.value.toString('utf8');
  const encrypted = !(cipherName === 'none' && kdfName === 'none');

  // 从公钥 blob 里切出 32 字节原生公钥：string(算法名) || string(pub32)
  const algo = readString(pubBlob.value, 0);
  if (!algo) return null;
  const raw = readString(pubBlob.value, algo.next);
  if (!raw || raw.value.length !== RAW_KEY_LEN) return null;
  if (algo.value.toString('utf8') !== KEY_TYPE) return null;

  let comment = null;
  if (!encrypted) {
    const privSec = readString(blob, off);
    if (privSec) {
      const p = privSec.value;
      const c1 = readUInt32(p, 0);
      const c2 = c1 && readUInt32(p, c1.next);
      const kt = c2 && readString(p, c2.next);
      const pub2 = kt && readString(p, kt.next);
      const priv64 = pub2 && readString(p, pub2.next);
      const cmt = priv64 && readString(p, priv64.next);
      if (cmt) comment = cmt.value.toString('utf8');
      const consistent = Boolean(
        c1 && c2 && c1.value === c2.value && priv64 && priv64.value.length === PRIV_KEY_LEN
      );
      if (!consistent) return null;
    }
  }

  return {
    publicRaw: Buffer.from(raw.value),
    publicBlob: Buffer.from(pubBlob.value),
    comment,
    encrypted,
  };
}

// ── 对外 API ────────────────────────────────────────────────────────────────

/**
 * 默认注释。它是公钥行里**唯一人能读的部分**，所以承担两件事：
 * 在 IDM 的列表里分辨「哪把是哪把」，以及**看出钥匙换了**。
 *
 * ★ 精确到分钟，不是只到天。只到天的话，同一天重新生成出来的两把钥匙注释完全一样，
 *   而它们的指纹和 IDM 里那条又都对不上 —— 用户面对的是「名字一样、却登不上」，
 *   指不回「其实是换了一把」。密钥换掉是这里最要命的一种变化，不能让它不可见。
 */
function defaultComment(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `slurmate-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
       + `-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** OpenSSH 的一行公钥格式：`ssh-ed25519 <base64(blob)> <comment>`。 */
function publicKeyLine(publicRaw, comment = 'slurmate') {
  return `${KEY_TYPE} ${publicBlobOf(publicRaw).toString('base64')} ${comment}`.trim();
}

/**
 * 生成一把新密钥。
 * @returns {{privateKeyPem:string, publicKeyLine:string, fingerprint:string}}
 */
function generate(comment = defaultComment()) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const { publicRaw, seed } = extractRawKeys(privateKey, publicKey);
  const privateKeyPem = encodePrivate(seed, publicRaw, comment);
  return {
    privateKeyPem,
    publicKeyLine: publicKeyLine(publicRaw, comment),
    fingerprint: fingerprintOf(publicKeyLine(publicRaw, comment)),
  };
}

/** 从私钥 PEM 推出公钥那一行。推不出来返回 null（由调用方明确报错）。 */
function publicKeyLineFromPrivatePem(pem) {
  const info = decodePrivate(pem);
  if (!info || info.encrypted) return null;
  return publicKeyLine(info.publicRaw, info.comment || 'slurmate');
}

/** 私钥是不是我们能认的、且未加密的 openssh-key-v1。 */
function isUsablePrivatePem(pem) {
  const info = decodePrivate(pem);
  return Boolean(info && !info.encrypted);
}

/**
 * 指纹（`SHA256:…`），与 `ssh-keygen -lf` 同款算法。
 * 用途是让用户在 IDM 里核对自己贴的那把对不对 —— 一串 base64 肉眼没法比。
 */
function fingerprintOf(pubLine) {
  const parts = String(pubLine).trim().split(/\s+/);
  if (parts.length < 2) return null;
  let blob;
  try {
    blob = Buffer.from(parts[1], 'base64');
  } catch {
    return null;
  }
  if (blob.length === 0) return null;
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/** 粗校验一行公钥：类型对、blob 能解出 32 字节。用于界面输入/粘贴。 */
function isValidPublicKeyLine(line) {
  const parts = String(line || '').trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== KEY_TYPE) return false;
  const info = readString(Buffer.from(parts[1], 'base64'), 0);
  if (!info || info.value.toString('utf8') !== KEY_TYPE) return false;
  const raw = readString(Buffer.from(parts[1], 'base64'), info.next);
  return Boolean(raw && raw.value.length === RAW_KEY_LEN);
}

module.exports = {
  KEY_TYPE, RAW_KEY_LEN,
  defaultComment, generate, publicKeyLine,
  publicKeyLineFromPrivatePem, isUsablePrivatePem, fingerprintOf, isValidPublicKeyLine,
  _internal: { sshString, readString, readUInt32, publicBlobOf, encodePrivate, decodePrivate, extractRawKeys },
};
