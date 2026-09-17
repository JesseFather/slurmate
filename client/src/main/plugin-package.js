'use strict';
/**
 * plugin-package.js —— 读一个 `.splug`。
 *
 * ── 它是什么 ────────────────────────────────────────────────────────────────
 *
 * 严格解析容器（docs/PLUGIN-SPEC.md 附录 A）、**逐份用记录里的 sha256 校字节**、
 * 算内容摘要（§3.4）、验签（§4.2）。它**不执行任何东西**，也**不落盘** ——
 * 把负载写出来是调用方的事，那一步要与同意闸绑在一起（§5.2）。
 *
 * ── ★ 这个阶段它没有调用方，这是刻意的 ──────────────────────────────────────
 *
 * 读包的能力**必须先于任何一条线落地**。反过来（先让站点开始发包、再让客户端
 * 学会认包）中间会开一个窗口：那个窗口里客户端拿到的是它读不懂的字节，而它
 * 唯一能说的话是"校验不过"—— 一句既不准确、又指不回根因的话。
 *
 * 所以这一版只落 reader 与用例；`site-plugins.js` 走 `files` 那条老路**一个字
 * 没动**。★ reader 有用例、没有调用方，是**过渡期的正常状态**，不是半成品。
 *
 * ── ★ 它与 `packer/slurmate-packer.js` 是同一条规则的**两份实现** ──────────
 *
 * 这是没办法的事：打包器要"下载这个文件夹就能用"，所以它不 import 客户端里的
 * 任何东西。两份解析器漂开的后果很具体 —— **同一个包，打包器说它合规、客户端
 * 说它不合规**，而用户看到的是"作者说打好了、我就是装不上"。
 *
 * 钉住它们的是 `tools/conformance/`：一份固定的输入树、一份期望的包字节、
 * 一批坏包，**每一条都带一个期望的理由词**，两端各跑一遍。所以下面这个 `R`
 * 词表与判**的次序**必须与打包器、与守护进程逐字一致 —— 次序也是规范的一部分
 * （附录 A.4），一个包同时犯两条时，先判哪条决定了拿到哪个词。
 *
 * ── 那些"看起来多余"的检查 ──────────────────────────────────────────────────
 *
 * `checkRelPath` 在客户端侧是**再判一遍**：服务端可能被换过，"对面已经判过"
 * 不构成省略的理由（与 `validate_session()` 对会话文件的态度同源）。
 */

const crypto = require('crypto');
const fs = require('fs');
const plugins = require('./plugins/index.js');
const sitePlugins = require('./site-plugins.js');

// ==============================================================================
//  容器常量（附录 A）
// ==============================================================================

/** 8 字节。末三字节是 `\x1a\r\n` —— 让文本工具一眼看出"这是二进制"。 */
const MAGIC = Buffer.from('splug\x1a\r\n', 'latin1');
/** 本实现认识的容器格式版本。别的值 ⇒ **拒绝**（客户端那一态叫"站点太新"）。 */
const FORMAT = 1;
const HEADER_BYTES = 20;
/** 签名块：alg(u8) | 公钥(32) | 签名(64)。 */
const SIG_BYTES = 97;
const SIG_ALG_ED25519 = 1;
/** Ed25519 裸公钥的 SPKI 前缀 —— Node 只认 DER。12 字节，与打包器那一份逐字相同。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const MANIFEST = 'plugin.json';

/** §3.3 的深度上限。与 site-plugins.js 的 `HARD_LIMITS.max_depth` 是同一个数。 */
const MAX_DEPTH = 8;

// ── ★ 这个读方**不**执行"单文件多少字节 / 一共几份"那三个上限 ──────────────
//
// 那三个数在**协议**里是站点自述的 `limits`（客户端取两者中更严的）。包模式下的
// 规矩是它们变成**负载内**规则、由打包器与读方执行、不再走线 —— 而那要等
// `limits` 里多出 `package_bytes`、两侧的投递方式都切过去之后才成立。
//
// ★ 今天不收它们**不是**一个敞口，理由是可推的：`file_count` 被长度方程夹住了
//   （每条记录至少 42 字节，而整张记录表必须放得进这个文件），所以一个包能声明的
//   份数天然不超过 `(文件长度 − 20) / 42`；而这个函数吃的是一段**已经在内存里**的
//   字节，它的规模由调用方决定。真正需要"份数上限"的是**收下来的包文件**有多大 ——
//   那是链路约束，跟着 `package_bytes` 一起进来。

/**
 * 拒绝的理由词表。**三份实现字面相同**（见文件头）。
 *
 * ★ 它同时是一句对用户的话的原材料：将来界面上那一句"这个包为什么装不上"
 *   应当直接由这个词与它带的那句 `why` 拼出来，而不是另写一套文案 ——
 *   另写的那套迟早与这里的判据分家，而分家之后用户看到的是"校验失败"四个字。
 */
const R = {
  LENGTH: 'length',        // 长度对不上：尾随字节、截断、Σsize 与负载不符
  MAGIC: 'magic',          // 魔数不对
  FORMAT: 'format',        // format 不是本实现认识的那个（「站点太新」的来源）
  RECORD: 'record',        // 记录表本身读不完整
  PATH: 'path',            // 某条路径不合 §3.3
  DUPLICATE: 'duplicate',  // 两条路径重复（逐字，或只差 ASCII 大小写）
  CONTENT: 'content',      // 某一份的字节与记录里的 sha256 不符
  MANIFEST: 'manifest',    // 负载里没有可解析的 plugin.json
  SIGNATURE: 'signature',  // 签名块不合形状，或验不过
};

// ==============================================================================
//  §3.4：内容摘要
// ==============================================================================

/**
 * 内容摘要 = sha256( 按路径排序后，逐份拼接「路径UTF-8 ‖ 0x00 ‖ sha256(内容)小写hex ‖ 0x0A」)
 *
 * ★ 排序按 **UTF-8 字节**（`Buffer.compare`），**不是** `a < b`：JS 的 `<` 比的是
 *   UTF-16 码元，与 UTF-8 字节序在非 BMP 字符上给出**相反的答案**。用 `<` 排的
 *   实现会在 `😀.txt` 与 `￿.txt` 这类名字上算出另一个摘要 —— 而那种 bug 只在
 *   有人恰好用了 emoji 文件名时才出现。`tools/conformance/` 的输入树里有这一对。
 *
 * ★ **不含**容器字节、信封头、签名、时间戳、打包器版本、目录名。签名**盖**的
 *   就是这个值（§4.2），所以两者绝不能互相包含。
 */
function contentDigest(files) {
  const sorted = files.slice().sort((a, b) => Buffer.compare(
    Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  const h = crypto.createHash('sha256');
  for (const f of sorted) {
    h.update(Buffer.from(f.path, 'utf8'));
    h.update(Buffer.from([0x00]));
    h.update(Buffer.from(f.sha256, 'ascii'));
    h.update(Buffer.from([0x0a]));
  }
  return h.digest('hex');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ==============================================================================
//  签名（附录 A.3）
// ==============================================================================

/** 公钥指纹：`sha256(32 字节裸公钥)` 的小写十六进制。给人核对的那一串（§4.1）。 */
function fingerprint(raw32) {
  return sha256(raw32);
}

/**
 * 验一段 Ed25519 签名。**签名的是内容摘要那 32 个字节的原值**，不是它的十六进制
 * 写法（附录 A.3 写死了是哪一个）。
 *
 * ★ 验不过一律返回 `false`，**不抛**：一个畸形公钥不是"程序出错了"，是"这个包
 *   的签名不成立"。抛出去的话调用方要写 try/catch，而漏掉的那个 catch 会变成崩溃。
 */
function verifyEd25519(raw32, msg, sig) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw32]), format: 'der', type: 'spki',
    });
    return crypto.verify(null, msg, key, sig) === true;
  } catch {
    return false;
  }
}

/** 从一块签名块里取出 `{alg, pubkey, sig}`；不合形状返回 `null`。 */
function parseSigBlock(buf) {
  if (buf.length !== SIG_BYTES) return null;
  if (buf[0] !== SIG_ALG_ED25519) return null;   // 认不得的算法**拒绝**，不忽略
  return { alg: buf[0], pubkey: buf.subarray(1, 33), sig: buf.subarray(33, 97) };
}

// ==============================================================================
//  解析
// ==============================================================================

/**
 * 严格解析一个包。**按附录 A.4 的次序判**。
 *
 * 返回 `{ok:true, format, files, sig, manifest, digest}` 或 `{ok:false, code, why}`。
 * `files` 里每一项是 `{path, size, sha256, offset}`，`offset` 是它在**原始
 * buffer** 里的起点 —— 取字节用 `dataOf(buf, f)`，这个模块不替你复制一遍。
 */
function parsePackage(buf) {
  const bad = (code, why) => ({ ok: false, code, why });
  if (!Buffer.isBuffer(buf)) return bad(R.LENGTH, '不是一段字节');

  // 1 长度不足以放下头部
  if (buf.length < HEADER_BYTES) {
    return bad(R.LENGTH, `只有 ${buf.length} 字节，连 ${HEADER_BYTES} 字节的头都放不下`);
  }
  // 2 魔数
  if (!buf.subarray(0, 8).equals(MAGIC)) return bad(R.MAGIC, '魔数不对，这不是一个 .splug');
  // 3 format
  const format = buf.readUInt32BE(8);
  if (format !== FORMAT) {
    return bad(R.FORMAT, `format = ${format}，本实现只认识 ${FORMAT}`);
  }

  const fileCount = buf.readUInt32BE(12);
  const sigLen = buf.readUInt32BE(16);

  // 4 记录表读得完吗
  const files = [];
  let off = HEADER_BYTES;
  for (let i = 0; i < fileCount; i++) {
    if (off + 2 > buf.length) return bad(R.RECORD, `第 ${i} 条记录的表头就越过了文件末尾`);
    const pathlen = buf.readUInt16BE(off);
    const end = off + 2 + pathlen + 8 + 32;
    if (end > buf.length) {
      return bad(R.RECORD, `第 ${i} 条记录（路径 ${pathlen} 字节）越过了文件末尾`);
    }
    const raw = buf.subarray(off + 2, off + 2 + pathlen);
    const p = raw.toString('utf8');
    // ★ 不合法的 UTF-8 会被 `toString` **悄悄换成 U+FFFD** —— 摘要把那个替换字符
    //   算进去，于是两端算的不是同一份东西。所以要在**解码之前**比字节。
    if (!Buffer.from(p, 'utf8').equals(raw)) {
      return bad(R.PATH, `第 ${i} 条记录的路径不是合法的 UTF-8`);
    }
    files.push({
      path: p,
      size: buf.readBigUInt64BE(off + 2 + pathlen),
      sha256: buf.subarray(off + 2 + pathlen + 8, end).toString('hex'),
      offset: 0,                                   // 第 8 步再填
    });
    off = end;
  }

  // 5 长度必须**精确**（尾随字节、空洞、截断一律在这里响）
  let sum = 0n;
  for (const f of files) {
    if (f.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      return bad(R.LENGTH, `${f.path} 声明的 ${f.size} 字节超出了一次能读进内存的范围`);
    }
    sum += f.size;
  }
  const want = BigInt(off + sigLen) + sum;
  if (want !== BigInt(buf.length)) {
    return bad(R.LENGTH,
      `头部+记录表+签名块+Σsize = ${want} 字节，而文件是 ${buf.length} 字节`
      + (want < BigInt(buf.length)
        ? '（多出来的字节**没有任何声明** —— 信封里不许有白送的字节，§3.6）'
        : '（负载被截断了）'));
  }

  // 6 路径规则（§3.3，客户端侧**再判一遍**）
  for (const f of files) {
    const why = sitePlugins.checkRelPath(f.path, MAX_DEPTH);
    if (why) return bad(R.PATH, `${JSON.stringify(f.path)}：${why}`);
  }
  // 7 重复路径
  const seen = new Map();
  for (const f of files) {
    // ★ `plugins.foldAscii`，不是 `toLowerCase()` —— 见 plugins/index.js 里那段。
    const k = plugins.foldAscii(f.path);
    if (seen.has(k)) {
      const prev = seen.get(k);
      return bad(R.DUPLICATE, prev === f.path
        ? `${JSON.stringify(f.path)} 出现了两次 —— 解出来的树是歧义的`
        : `${JSON.stringify(prev)} 与 ${JSON.stringify(f.path)} 只差大小写 —— 落盘时会互相覆盖，`
          + '而摘要按落盘之后算，于是"你同意的"与"实际装上的"可以不是同一棵树');
    }
    seen.set(k, f.path);
  }

  // 8 逐份用记录里的 sha256 校字节
  let pay = off + sigLen;
  for (const f of files) {
    f.offset = pay;
    const n = Number(f.size);
    const got = sha256(buf.subarray(pay, pay + n));
    if (got !== f.sha256) {
      return bad(R.CONTENT,
        `${JSON.stringify(f.path)} 的字节与记录里的 sha256 不符（记录 ${f.sha256}，实际 ${got}）`);
    }
    pay += n;
  }

  // 9 负载里必须有 plugin.json，且是合法的 JSON **对象**
  const mf = files.find((f) => f.path === MANIFEST);
  if (!mf) return bad(R.MANIFEST, `负载里没有 ${MANIFEST}`);
  let manifest;
  try {
    manifest = JSON.parse(dataOf(buf, mf).toString('utf8'));
  } catch (e) {
    return bad(R.MANIFEST, `${MANIFEST} 不是合法的 JSON：${e.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return bad(R.MANIFEST, `${MANIFEST} 的最外层不是一个 JSON 对象`);
  }

  // 10 有签名块就验它
  let sig = null;
  if (sigLen !== 0) {
    const parsed = parseSigBlock(buf.subarray(off, off + sigLen));
    if (!parsed) {
      return bad(R.SIGNATURE,
        `签名块 ${sigLen} 字节，不是一个合法的 Ed25519 签名块（本格式是 ${SIG_BYTES} 字节、alg=1）`);
    }
    const digest = contentDigest(files);
    if (!verifyEd25519(parsed.pubkey, Buffer.from(digest, 'hex'), parsed.sig)) {
      return bad(R.SIGNATURE,
        `签名验不过 —— 它盖的必须是这个包的内容摘要（${digest}），`
        + `签的人是 ${fingerprint(parsed.pubkey)}`);
    }
    sig = {
      alg: parsed.alg,
      pubkey: Buffer.from(parsed.pubkey),
      fingerprint: fingerprint(parsed.pubkey),
    };
  }

  return {
    ok: true,
    format,
    fileCount,
    files,
    sig,
    manifest,
    /** 内容摘要 —— 判"是不是同一份构件"的**唯一**判据（§3.4）。 */
    digest: contentDigest(files),
  };
}

/** 某一份的字节。★ 只在解析**通过之后**调用 —— 它按记录里的 size 切片。 */
function dataOf(buf, f) {
  return buf.subarray(f.offset, f.offset + Number(f.size));
}

/**
 * 从磁盘读一个包文件。读不动是 `{ok:false, code:'length'}` 而不是抛 ——
 * 调用方（同意界面、对账）一律按"这个包不成立"处理，不写 try/catch。
 */
function readPackageFile(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { ok: false, code: R.LENGTH, why: `读不到 ${file}：${e.message}` };
  }
  return parsePackage(buf);
}

module.exports = {
  MAGIC, FORMAT, HEADER_BYTES, SIG_BYTES, SIG_ALG_ED25519, MAX_DEPTH, MANIFEST, R,
  contentDigest, parsePackage, dataOf, readPackageFile,
  parseSigBlock, fingerprint, verifyEd25519,
};
