#!/usr/bin/env node
'use strict';
/**
 * slurmate-packer.js —— 插件作者的打包器。
 *
 * ── 它是谁的 ────────────────────────────────────────────────────────────────
 *
 * ★ **这是作者的工具，不是部署工具。** 它跑在**你**的机器上（写插件的那台），
 *   产出 `.splug` 之后发布到网站 / GitHub；管理员下载下来交给安装器。
 *   **服务器上从头到尾没有源码树** —— 所以 `cluster/deploy.sh` 永不打包。
 *
 * ★ **单文件、零依赖**：只用 `crypto` / `fs` / `os` / `path` / `child_process`。
 *   下载这个文件夹就能用（`node slurmate-packer.js …`）。所以它**不**从
 *   `client/` 里 import 任何东西 —— 那会让"下载这个文件夹"变成"下载整个仓库"。
 *   代价是几处常量在这里有第二份（跳过表、版本号形状），
 *   由 `.github/workflows/checks.yml` 里的 lint 与 `tools/conformance/` 的向量钉住。
 *
 * ── 六个动词 ────────────────────────────────────────────────────────────────
 *
 *   init    铸一个 id（只在源码树里没有的时候）并**插入**写回 plugin.json，
 *           同时给血统表记一条。`--fork` / `--adopt` 是 §2.5 那次"停下来问"的
 *           两个答案（这是另一个东西 / 这是同一个东西、记录丢了）
 *   keygen  给这个 id 定一把 Ed25519 钥匙：公钥进血统表，私钥进钥匙库
 *           （库里已经有一把就认它 —— 〈换机器 = 复制 .pem〉那条路）
 *   build   从一个**提交**打出一个 `.splug`（它**不看钥匙库**）
 *   sign    给一个已经打好的包盖上签名（**不改内容摘要**，所以不必重新打包）
 *   verify  校验一个 `.splug`：逐份字节、内容摘要、签名、血统表与签名者对得上吗
 *   inspect 把人该看的东西打出来（作者拿它对着规范逐行核对）
 *
 * ★ **写树的动词与打包的动词不能合并。** `init` / `keygen` 会弄脏源码树，
 *   而 §3.5 要求打包的输入是一个**干净的提交** —— 一条命令做完两件事必然自相
 *   矛盾。所以它们只改树、把树弄脏，然后**停下来让你提交**。
 *
 * ★ **`sign` 是独立的一步，因为签名不改内容摘要**（§4.2：它盖的是摘要那 32 个
 *   字节，不覆盖信封）。两个后果：`build` 的输出只是 (提交, 选项) 的函数，
 *   与这台机器上有什么钥匙无关；而"给已经打好的包补签名"是合法的（§2.4 之下
 *   它还是同一份构件）。
 *
 * ── 三条容易写错的地方，先说清楚 ────────────────────────────────────────────
 *
 * ★ **不用 `git archive`。** 它会读 `.gitattributes` 的 `export-ignore` /
 *   `export-subst`，于是**包的负载可以被仓库里一份属性文件改掉** —— 少了或多
 *   几份文件，而打包的人看不出来。这里走 `git ls-tree -r -z` + `git cat-file`，
 *   `.gitattributes` 一个字都不参与。（它本身还在跳过表里。）
 *
 * ★ **排序按 UTF-8 字节，不按 JS 的 `<`。** JS 的 `<` 比的是 **UTF-16 码元**，
 *   与 UTF-8 字节序在非 BMP 字符上给出**相反的答案** —— 于是同一棵树在两台机器上
 *   会算出两个摘要。全仓唯一正确的写法是 `Buffer.compare`。
 *
 * ★ **路径取自 `ls-tree`，不取自 `readdir`。** macOS 的文件系统会把文件名做 NFD
 *   归一化，`readdir` 拿到的字节与 git 里存的不一样 ⇒ 同一棵树在不同机器上摘
 *   不同。`ls-tree` 给的是 git 里存的那串字节。
 *
 * 用法见 `packer/README.md`。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ==============================================================================
//  容器格式（docs/PLUGIN-SPEC.md 附录 A）
// ==============================================================================

/** 8 字节。带 `\x1a\r\n` 是为了让文本工具一眼看出"这是二进制"，且能被老式工具截断。 */
const MAGIC = Buffer.from('splug\x1a\r\n', 'latin1');
const FORMAT = 1;
const HEADER_BYTES = 20;
/** 摘要的字节数。sha256 ⇒ 32。 */
const DIGEST_BYTES = 32;
const SIG_BYTES = 1 + 32 + 64;              // alg u8 | pubkey 32 | sig 64
const SIG_ALG_ED25519 = 1;
/** Ed25519 裸公钥的 SPKI 前缀 —— Node 只认 DER，裸 32 字节要包一层。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * 拒绝的理由词表。**三份实现共用这一份**，字面相同 —— 于是"同一个坏包在三端
 * 得到同一个答案"变成一句可以断言的话，而不是一句期望。
 *
 * ★ 词表是规范的一部分（附录 A.4）：判**的次序**也是。一个包同时犯两条时，
 *   先判哪条决定了拿到哪个词，所以次序写死在附录里，三端照抄。
 */
const R = {
  LENGTH: 'length',        // 长度对不上：尾随字节、截断、Σsize 与负载不符
  MAGIC: 'magic',          // 魔数不对
  FORMAT: 'format',        // format 不是本实现认识的那个（"站点太新"的来源）
  RECORD: 'record',        // 记录表本身读不完整
  PATH: 'path',            // 某条路径不合 §3.3
  DUPLICATE: 'duplicate',  // 两条路径重复（逐字，或只差 ASCII 大小写）
  CONTENT: 'content',      // 某一份的字节与记录里的 sha256 不符
  MANIFEST: 'manifest',    // 负载里没有可解析的 plugin.json
  SIGNATURE: 'signature',  // 签名块不合形状，或验不过
};

const MANIFEST = 'plugin.json';
const CLIENT_ENTRY = 'client/index.js';
const JOB_ENTRY = 'job/start.sh';

/**
 * ★ 血统表：**在源码树里**、提交进版本控制（§2.5）。
 *
 * 它在插件目录的根上，所以它**也是负载的一部分**（§3.6：负载 = 源码树 − 跳过集，
 * 而它不在跳过集里）。这是故意的，两个好处：
 *
 *   1. "这个 id 是谁签的"跟着包走 —— `sign` 不必知道源码树在哪就能核对血统；
 *   2. 包自己带着它，于是 `verify` / `inspect` 能发现"表里说归 K1、
 *      而签这个包的是 K2"这种陈旧。
 *
 * 代价说在明处：**它是内容**，所以给它加一条记录就是在改内容 ⇒ §2.4 要你升版本号。
 * 所以正常的次序是「init → keygen → 提交 → build」，而不是"发出去之后再补签"。
 */
const LINEAGE_FILE = 'lineage.json';
const LINEAGE_SCHEMA = 1;

// ==============================================================================
//  §3.2 / §3.3：路径与条目的规则
// ==============================================================================

/**
 * 深度上限（§3.3）。与客户端 `site-plugins.js` 的 `max_depth` 是同一个数。
 */
const MAX_DEPTH = 8;
const MAX_SEGMENT_BYTES = 255;

/**
 * 跳过集合：**不进负载**的那几个名字。与客户端 `plugins/index.js` 的 `COPY_SKIP`
 * 和守护进程的 `PLUGIN_COPY_SKIP` 逐字相同 —— CI 有一条 lint 比对三份。
 *
 * ★ 它与 §3.3 里"禁止出现下列跳过集合里的任何一段"是**同一条规则的两种用法**：
 *   打包器**排除**它们，读方**拒绝**含它们的包。同一份名单，两个方向。
 */
const COPY_SKIP = new Set(['.git', '.github', '.gitignore', '.gitattributes', 'node_modules']);

/** Windows 保留名（§3.3）。不区分大小写，含带扩展名的形式。 */
const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const WIN_BAD_CHARS = /[:*?"<>|]/;

/**
 * 一条相对路径合不合 §3.3。返回 `null`（可以）或一句为什么不行。
 *
 * ★ 这一份与客户端的 `checkRelPath` 是**同一条规则的两份实现**，而它们是
 *   `tools/conformance/` 那份向量里的"坏包"用例钉住的：一个路径不合规的包，
 *   三端必须都拒、且给出同一个理由词。
 */
function checkRelPath(rel, maxDepth) {
  if (typeof rel !== 'string' || !rel) return '路径是空的';
  if (rel.includes('\0')) return '路径里有 NUL';
  if (rel.includes('\\')) return '路径里有反斜杠（不翻译成 / —— 一侧翻译另一侧不翻译就是歧义）';
  if (rel.startsWith('/')) return '路径是绝对的';
  if (rel.endsWith('/')) return '路径以 / 结尾';
  if (rel.includes('//')) return '路径里有连续的两个 /';
  const segs = rel.split('/');
  if (segs.length > maxDepth) return `路径有 ${segs.length} 层，超过上限 ${maxDepth}`;
  for (const s of segs) {
    if (!s || s === '.' || s === '..') return '路径里有空的、"." 或 ".." 这一段';
    if (Buffer.byteLength(s, 'utf8') > MAX_SEGMENT_BYTES) {
      return `路径里有一段超过 ${MAX_SEGMENT_BYTES} 字节`;
    }
    if (WIN_BAD_CHARS.test(s)) return '路径里有 Windows 上不合法的字符（: * ? " < > |）';
    if (WIN_RESERVED.test(s)) return `${JSON.stringify(s)} 是 Windows 的保留名`;
    if (/[ .]$/.test(s)) return '路径里有一段以空格或点结尾（Windows 上会被静默改名）';
    if (COPY_SKIP.has(s)) return `${JSON.stringify(s)} 不在分发范围内`;
  }
  return null;
}

/**
 * ASCII-only 的小写折叠（§3.3 的"只差大小写"判据）。
 *
 * ★ **不能**用 `String.prototype.toLowerCase()`：它是**全 Unicode** 的，
 *   于是 `İ`（U+0130）与 `i` 会折叠到一起，`K`（U+212A KELVIN）与 `k` 也是。
 *   三个实现只要有一个用了它，就会出现"一边收、一边拒"，而这是一条**拒绝**规则。
 *   ASCII-only 的折叠在三种语言里逐字节相同，没有区域设置、没有版本差异。
 */
function foldAscii(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

// ==============================================================================
//  §3.4：内容摘要
// ==============================================================================

/**
 * 内容摘要 = sha256( 按路径排序后，逐份拼接「路径UTF-8 ‖ 0x00 ‖ sha256(内容) 小写hex ‖ 0x0A」)
 *
 * ★ 排序按 **UTF-8 字节**（见文件头那条）。★ **不含**容器字节、信封头、时间戳、
 *   打包器版本、目录名 —— 于是"同一棵树谁在哪台机器上打包都是同一个摘要"。
 */
function contentDigest(files) {
  // ★ **在这里排序**，不是在调用方。记录表里的次序是**别人给的**：
  //   一个手写的包完全可以把它们按别的次序排。摘要要是跟着记录表的次序走，
  //   同一个包就会算出两个摘要 —— 而签名盖的是摘要，于是它**先**以
  //   "签名验不过"的形式响，排查的人会去查钥匙。（这个 bug 真的写出来过：
  //   早先版本忘了这一行，用例当场抓住。）
  const sorted = sortByPathBytes(files);
  const h = crypto.createHash('sha256');
  for (const f of sorted) {
    h.update(Buffer.from(f.path, 'utf8'));
    h.update(Buffer.from([0x00]));
    h.update(Buffer.from(f.sha256, 'ascii'));
    h.update(Buffer.from([0x0a]));
  }
  return h.digest('hex');
}

/** §3.4 的排序判据。★ 必须是这一个，不是 `a < b`。 */
function sortByPathBytes(files) {
  return files.slice().sort((a, b) => Buffer.compare(
    Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ==============================================================================
//  签名块（附录 A.3）
// ==============================================================================

/**
 * 绕开 Node 的 DER 要求：把 32 字节裸公钥包成 SPKI。
 * 前缀是 Ed25519 的固定 AlgorithmIdentifier，12 个字节。
 */
function ed25519PublicKey(raw32) {
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw32]), format: 'der', type: 'spki',
  });
}

/**
 * 验一段 Ed25519 签名。**签名的是内容摘要那 32 个字节的原值**，不是它的十六进制
 * 写法（附录 A.3 写死了是哪一个 —— 两种写法只能选一种）。
 */
function verifyEd25519(raw32, msg, sig) {
  try {
    return crypto.verify(null, msg, ed25519PublicKey(raw32), sig) === true;
  } catch {
    return false;                     // 公钥不是一条合法曲线点之类 —— 一律当"验不过"
  }
}

/** 公钥指纹：`sha256(32 字节裸公钥)` 的小写十六进制。给人核对用的那一串。 */
function fingerprint(raw32) {
  return sha256(raw32);
}

/** 从一块签名块里取出 `{alg, pubkey, sig}`；不合形状时返回 `null`。 */
function parseSigBlock(buf) {
  if (buf.length !== SIG_BYTES) return null;
  if (buf[0] !== SIG_ALG_ED25519) return null;    // 认不得的算法**拒绝**，不忽略
  return { alg: buf[0], pubkey: buf.subarray(1, 33), sig: buf.subarray(33, 97) };
}

// ==============================================================================
//  组装与解析
// ==============================================================================

/**
 * 把一组 `{path, data, sha256}` 组装成包字节。
 *
 * 布局（附录 A.2）：
 *
 *   头 20B：magic(8) | format(u32) | file_count(u32) | sig_len(u32)
 *   记录表：逐份 pathlen(u16) | path | size(u64) | sha256(32)
 *   签名块：sig_len 字节（0 就是没有）
 *   负载：  按**记录的同一顺序**逐份拼接
 *
 * 所以 `20 + Σ(2+路径长+8+32) + sig_len + Σsize == 文件长度`，一个字节不多不少。
 */
function buildPackage(files, sigBlock) {
  const sig = sigBlock || Buffer.alloc(0);
  const recs = [];
  let total = HEADER_BYTES + sig.length;
  for (const f of files) {
    const pb = Buffer.from(f.path, 'utf8');
    const rec = Buffer.alloc(2 + pb.length + 8 + DIGEST_BYTES);
    rec.writeUInt16BE(pb.length, 0);
    pb.copy(rec, 2);
    rec.writeBigUInt64BE(BigInt(f.data.length), 2 + pb.length);
    Buffer.from(f.sha256, 'hex').copy(rec, 2 + pb.length + 8);
    recs.push(rec);
    total += rec.length + f.data.length;
  }
  const out = Buffer.alloc(total);
  MAGIC.copy(out, 0);
  out.writeUInt32BE(FORMAT, 8);
  out.writeUInt32BE(files.length, 12);
  out.writeUInt32BE(sig.length, 16);
  let off = HEADER_BYTES;
  for (const rec of recs) { rec.copy(out, off); off += rec.length; }
  sig.copy(out, off); off += sig.length;
  for (const f of files) { f.data.copy(out, off); off += f.data.length; }
  return out;
}

/**
 * 严格解析一个包。**按附录 A.4 的次序判**，返回
 * `{ok:true, format, files, sig, digest, payloadOf}` 或 `{ok:false, code, why}`。
 *
 * ★ 这个次序是规范的一部分：一个包同时犯两条时，先判哪条决定了拿到哪个理由词。
 *   三份实现照抄同一次序，"同一个坏包在三端得到同一个答案"才是可以断言的。
 *
 * ★ **尾随字节、空洞、多余记录一律拒绝** —— 信封不进摘要，所以信封里任何一个
 *   "被忽略的字节"都是无认证的夹带面（§3.6）。
 */
function parsePackage(buf) {
  const bad = (code, why) => ({ ok: false, code, why });

  // 1 长度不足以放下头部
  if (buf.length < HEADER_BYTES) return bad(R.LENGTH, `只有 ${buf.length} 字节，连 ${HEADER_BYTES} 字节的头都放不下`);
  // 2 魔数
  if (!buf.subarray(0, 8).equals(MAGIC)) return bad(R.MAGIC, '魔数不对，这不是一个 .splug');
  // 3 format
  const format = buf.readUInt32BE(8);
  if (format !== FORMAT) return bad(R.FORMAT, `format = ${format}，本实现只认识 ${FORMAT}`);

  const fileCount = buf.readUInt32BE(12);
  const sigLen = buf.readUInt32BE(16);

  // 4 记录表读得完吗
  const files = [];
  let off = HEADER_BYTES;
  for (let i = 0; i < fileCount; i++) {
    if (off + 2 > buf.length) return bad(R.RECORD, `第 ${i} 条记录的表头就越过了文件末尾`);
    const pathlen = buf.readUInt16BE(off);
    const end = off + 2 + pathlen + 8 + DIGEST_BYTES;
    if (end > buf.length) return bad(R.RECORD, `第 ${i} 条记录（路径 ${pathlen} 字节）越过了文件末尾`);
    const raw = buf.subarray(off + 2, off + 2 + pathlen);
    const p = raw.toString('utf8');
    // 路径必须是合法的 UTF-8：不是的话 `toString` 会把坏字节换成 U+FFFD，而那是
    // **悄悄改了一个字节** —— 摘要按它算，于是两边算的就不是同一份东西。
    if (!Buffer.from(p, 'utf8').equals(raw)) {
      return bad(R.PATH, `第 ${i} 条记录的路径不是合法的 UTF-8`);
    }
    files.push({
      path: p,
      size: buf.readBigUInt64BE(off + 2 + pathlen),
      sha256: buf.subarray(off + 2 + pathlen + 8, end).toString('hex'),
      offset: 0,                                   // 5 之后再填
    });
    off = end;
  }

  // 5 长度必须**精确**
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
      + (want < BigInt(buf.length) ? '（多出来的字节没有任何声明 —— 信封里不许有白送的字节）' : '（负载被截断了）'));
  }

  // 6 路径规则
  const seen = new Map();
  for (const f of files) {
    const why = checkRelPath(f.path, MAX_DEPTH);
    if (why) return bad(R.PATH, `${JSON.stringify(f.path)}：${why}`);
  }
  // 7 重复路径（逐字，或只差 ASCII 大小写）
  for (const f of files) {
    const k = foldAscii(f.path);
    if (seen.has(k)) {
      const prev = seen.get(k);
      return bad(R.DUPLICATE, prev === f.path
        ? `${JSON.stringify(f.path)} 出现了两次 —— 解出来的树是歧义的`
        : `${JSON.stringify(prev)} 与 ${JSON.stringify(f.path)} 只差大小写 —— 落盘时会互相覆盖，`
          + '而摘要按落盘之后算，于是"同意的"与"装上的"可以不是同一棵树');
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
      return bad(R.CONTENT, `${JSON.stringify(f.path)} 的字节与记录里的 sha256 不符（记录 ${f.sha256}，实际 ${got}）`);
    }
    pay += n;
  }

  // 9 负载里必须有 plugin.json，且是合法的 JSON **对象**
  const mf = files.find((f) => f.path === MANIFEST);
  if (!mf) return bad(R.MANIFEST, `负载里没有 ${MANIFEST}`);
  let manifest;
  try {
    manifest = JSON.parse(buf.subarray(mf.offset, mf.offset + Number(mf.size)).toString('utf8'));
  } catch (e) {
    return bad(R.MANIFEST, `${MANIFEST} 不是合法的 JSON：${e.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return bad(R.MANIFEST, `${MANIFEST} 的最外层不是一个 JSON 对象`);
  }

  // 10 有签名块就验它
  let sig = null;
  if (sigLen !== 0) {
    const block = buf.subarray(off, off + sigLen);
    const parsed = parseSigBlock(block);
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
    sig = { alg: parsed.alg, pubkey: parsed.pubkey, fingerprint: fingerprint(parsed.pubkey) };
  }

  return {
    ok: true,
    format,
    fileCount,
    files,
    sig,
    manifest,
    /** 记录表的末尾 —— 签名块就从这里开始（`sign` 要往这里插，附录 A.3）。 */
    tableEnd: off,
    /** 负载的第一字节 —— 签名块占 `[tableEnd, payloadStart)`（可能是 0 字节）。 */
    payloadStart: off + sigLen,
    /** 内容摘要 —— 判"是不是同一份构件"的**唯一**判据（§3.4）。 */
    digest: contentDigest(files),
    payloadOf: (p) => {
      const f = files.find((x) => x.path === p);
      return f ? buf.subarray(f.offset, f.offset + Number(f.size)) : null;
    },
  };
}

// ==============================================================================
//  §3.5：从一个提交读那棵树
// ==============================================================================

function git(repo, args, opts) {
  return execFileSync('git', ['-C', repo].concat(args),
    Object.assign({ maxBuffer: 1 << 28 }, opts || {}));
}

function repoRootOf(dir) {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  } catch {
    throw new Error(`${dir} 不在一个 git 仓库里 —— 打包的输入必须是一个提交（§3.5）`);
  }
}

/**
 * 这个目录相对仓库根的位置（`/` 分隔，git 要的形态）。
 */
function relToRepo(repo, dir) {
  const rel = path.relative(repo, path.resolve(dir)).split(path.sep).join('/');
  return rel === '.' ? '' : rel;
}

/**
 * ★ §3.5：工作树必须干净。**只判这个插件目录那一份** —— 仓库别处脏不该拦住
 *   你打包（你改的可能是客户端），而这一份脏了就说明"提交里的那棵树"与
 *   "你看到的这棵树"不是一回事，那正是 §3.5 要拦的。
 */
function ensureClean(repo, rel) {
  const args = ['status', '--porcelain', '--'].concat(rel ? [rel] : []);
  const out = git(repo, args).toString('utf8').trim();
  if (out) {
    throw new Error(
      `${rel || '仓库根'} 相对工作树不干净：\n`
      + out.split('\n').map((l) => `    ${l}`).join('\n')
      + '\n  §3.5 要求打包的输入是一个**提交**，不是工作树。先提交（或 stash）再来。');
  }
}

/**
 * 一个提交里某个子目录的文件清单：`[{pathBytes, path, mode, oid}]`。
 *
 * ★ `-z` 不能省：路径里可以有换行与引号，不带 `-z` 时 git 会**加引号并转义**，
 *   于是拿到的路径与真实字节不是一回事。
 * ★ `toString('latin1')` 是为了**逐字节**切分（`\0` 与 `\t` 都是单字节），
 *   切完再按 UTF-8 解码每一步。用 `'utf8'` 切会在多字节字符上错位。
 */
function lsTree(repo, commit, subdir) {
  const spec = subdir ? `${commit}:${subdir}` : commit;
  const out = git(repo, ['ls-tree', '-r', '-z', spec]);
  const entries = [];
  for (const rec of out.toString('latin1').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) throw new Error(`git ls-tree 的一条记录里没有 TAB：${JSON.stringify(rec.slice(0, 80))}`);
    const meta = rec.slice(0, tab).split(' ');
    entries.push({
      mode: meta[0],
      type: meta[1],
      oid: meta[2],
      pathBytes: Buffer.from(rec.slice(tab + 1), 'latin1'),
      path: Buffer.from(rec.slice(tab + 1), 'latin1').toString('utf8'),
    });
  }
  return entries;
}

/** 一次 `git cat-file --batch` 取回全部 blob 的字节。 */
function catBlobs(repo, oids) {
  const map = new Map();
  if (!oids.length) return map;
  const input = Buffer.from(oids.map((o) => `${o}\n`).join(''), 'ascii');
  const out = git(repo, ['cat-file', '--batch'], { input });
  let off = 0;
  while (off < out.length) {
    const nl = out.indexOf(0x0a, off);
    if (nl < 0) throw new Error('git cat-file --batch 的输出不完整');
    const header = out.toString('latin1', off, nl);
    const parts = header.split(' ');
    const size = Number(parts[2]);
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`git cat-file --batch 的表头看不懂：${JSON.stringify(header)}`);
    }
    const start = nl + 1;
    map.set(parts[0], out.subarray(start, start + size));
    off = start + size + 1;                      // 内容后面跟一个换行
  }
  return map;
}

/**
 * 读出一个提交里那个插件目录的**负载**（§3.6：负载逐字节等于源码树）。
 *
 * 返回 `{files, skipped, notes}`：
 *   `skipped` —— 被跳过表排除的条目（**要说出来**，不能静默少东西）
 *   `notes`   —— 归一化之类"确实丢了信息"的事（权限位）
 *
 * ★ **负载的字节取自 git 里的 blob，不是 checkout 之后的字节。** 两者在
 *   `text=auto` 之类的属性下可以不同（检出时行尾被改过），而 §3.4 要的是
 *   "谁在哪台机器上打包都是同一个摘要" —— 只有 blob 满足这一条。
 *
 * ★ **空目录不可能出现**：git 根本不存它。§3.2 那句"禁止空目录 —— 它没有
 *   表达形式"在这里是**结构性**的，不是纪律性的。
 */
function readTree(repo, commit, subdir) {
  const entries = lsTree(repo, commit, subdir);
  const skipped = [];
  const notes = [];
  const keep = [];
  for (const e of entries) {
    if (e.mode === '120000') {
      throw new Error(`${JSON.stringify(e.path)} 是一个符号链接（mode 120000）——`
        + ' 包里的负载只允许普通文件（§3.2），而"它是指向 x 的链接"与"它的内容恰好是 x"'
        + '是两份行为完全不同的东西。请把它换成一份普通文件。');
    }
    if (e.mode === '160000') {
      throw new Error(`${JSON.stringify(e.path)} 是一个 gitlink（mode 160000）—— 子模块进不了负载，`
        + ' 请把那份代码直接放进这棵树。');
    }
    if (e.type !== 'blob') {
      throw new Error(`${JSON.stringify(e.path)} 在 git 里不是一个 blob（type ${e.type}）`);
    }
    const segs = e.pathBytes.toString('utf8').split('/');
    if (segs.some((s) => COPY_SKIP.has(s))) {
      skipped.push(e.path);
      continue;
    }
    // ★ 输出不能是自己输入的一部分：作者把上一次的 `.splug` 落在插件树里再打包，
    //   它会被当成普通文件进负载 ⇒ 摘要每次都不一样，而"同一台机器打两次得到
    //   两个包"是第一号现场。这里排掉它，并且**说出来**。
    if (e.pathBytes.toString('latin1').endsWith('.splug')) {
      skipped.push(e.path);
      continue;
    }
    if (!Buffer.from(e.path, 'utf8').equals(e.pathBytes)) {
      throw new Error(`${JSON.stringify(e.pathBytes.toString('latin1'))} 不是合法的 UTF-8 路径 ——`
        + ' 包里的路径必须是 UTF-8 字节（附录 A.2）');
    }
    const why = checkRelPath(e.path, MAX_DEPTH);
    if (why) throw new Error(`${JSON.stringify(e.path)}：${why}`);
    if (e.mode === '100755') {
      notes.push(`${e.path} 在版本控制里是 100755；包里的权限位由格式定死 0644（§3.2），这一位**丢掉了**`);
    } else if (e.mode !== '100644') {
      throw new Error(`${JSON.stringify(e.path)} 的 mode 是 ${e.mode}，本实现只认识 100644 / 100755`);
    }
    keep.push(e);
  }

  // ★ 重复路径的判据是 ASCII-only 折叠（见 foldAscii 那段注释）。
  const seen = new Map();
  for (const e of keep) {
    const k = foldAscii(e.path);
    if (seen.has(k)) {
      throw new Error(`源码树里 ${JSON.stringify(seen.get(k))} 与 ${JSON.stringify(e.path)} 只差大小写 ——`
        + ' 它们在 macOS / Windows 的磁盘上会互相覆盖，而摘要按磁盘算（§3.3）。');
    }
    seen.set(k, e.path);
  }

  const blobs = catBlobs(repo, keep.map((e) => e.oid));
  const files = keep.map((e) => {
    const data = blobs.get(e.oid);
    if (!data) throw new Error(`取不到 ${JSON.stringify(e.path)} 的内容（${e.oid}）`);
    return { path: e.path, data, sha256: sha256(data) };
  });
  return { files: sortByPathBytes(files), skipped, notes };
}

// ==============================================================================
//  id 与版本号
// ==============================================================================

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const MAX_TIME = 2 ** 48 - 1;
/** 插件版本：三段（§2.3 的前半段）。 */
const PLUGIN_VERSION_RE = /^(?:0|[1-9][0-9]*)\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
/** 框架版本：两段（§2.3.1）。`engines.slurmate` 比的就是它。 */
const FRAMEWORK_VERSION_RE = /^(?:0|[1-9][0-9]*)\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;

/**
 * `engines.slurmate` 的**形状**判定：没有形状问题返回 `null`，否则一句话。
 *
 * ★ 打包器**只判形状，不判满足**。满足性取决于"目标站点是哪一版"，而打包时那个
 *   站点还不存在 —— 同一个包装到 0.6 的站点上是好的，装到 0.4 上就装不上。
 *   所以这个函数**没有 host 参数**，也永远不会说"不满足"。
 *
 * ★ 但形状**必须**在这里判，因为读不懂的范围串（`^0.5`、`>=0.5.0`）是**规范**的
 *   拒绝（§2.3.1 明令不支持 `^` / `~` / `||` / 逗号 / 三段）。不拦的话，作者
 *   一路绿灯把包发出去，而拒绝要等到**别人的站点**上才出现，还长得像一句
 *   "本站版本低" —— 一个形状错误被说成一个版本问题。
 *
 * ★ 判据必须与另外两端**逐条一致**（客户端 `enginesProblem`、守护进程
 *   `engines_problem`），共用 tools/version-fixtures.json 的 `engines` 段。
 *   各写各的下一次就会漂成"同一个包，打包器说行、客户端说不行" —— 那正是
 *   规范 §0.2 承诺"三端同一个答案"要防的事。
 */
function enginesShapeProblem(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(manifest, 'engines')) return null;
  const eng = manifest.engines;
  if (!eng || typeof eng !== 'object' || Array.isArray(eng)) {
    return 'engines 必须是一个对象，如 {"slurmate": ">=0.5"}';
  }
  const extra = Object.keys(eng).filter((k) => k !== 'slurmate');
  if (extra.length) {
    return `engines 里有认不得的键：${extra.join('、')}（认识的只有 slurmate）`;
  }
  if (!Object.prototype.hasOwnProperty.call(eng, 'slurmate')) return null;
  const rng = eng.slurmate;
  if (typeof rng !== 'string' || !rng.trim()) {
    return 'engines.slurmate 必须是一个非空字符串，如 ">=0.5"';
  }
  for (const p of rng.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?(.*)$/.exec(p);
    if (!(m && FRAMEWORK_VERSION_RE.test(m[2]))) {
      return `看不懂的范围片段 ${JSON.stringify(p)}（版本号是 x.y 形式）`;
    }
  }
  return null;
}

/** 铸一个 ULID。与 `client/src/main/plugins/ulid.js` 同一个编码，两份实现的用例同一组夹具。 */
function mintUlid(now) {
  let v = Number.isFinite(now) ? now : Date.now();
  if (!(v >= 0 && v <= MAX_TIME)) throw new Error(`时间戳 ${v} 编不进 48 位`);
  let time = '';
  for (let i = 0; i < 10; i++) { time = ENCODING[v % 32] + time; v = Math.floor(v / 32); }
  const b = crypto.randomBytes(10);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    const bit = i * 5;
    rand += ENCODING[(((b[bit >> 3] << 8) | (b[(bit >> 3) + 1] || 0)) >> (11 - (bit & 7))) & 31];
  }
  return time + rand;
}

/**
 * ★ **插入**写回 `"id"`，不是解析再序列化（§2.1）。
 *
 * `JSON.parse` 再 `JSON.stringify` 会重排键序、把 `\u` 转义还原成字符、
 * 把 `1e3` 写成 `1000` —— 于是"只改了一个键"对任何一份真实的清单都是假的。
 * 这里只做一次文本插入，缩进取自**文件里已有的**那一行。
 */
function insertId(text, id) {
  const brace = text.indexOf('{');
  if (brace < 0) throw new Error('plugin.json 的最外层不是一个对象（找不到 `{`）');
  const rest = text.slice(brace + 1);
  const nl = text.indexOf('\n', brace);
  const lf = nl < 0 ? '\n' : (text[nl - 1] === '\r' ? '\r\n' : '\n');

  // 一行一个键（真实的清单都是这样）。插在第一行的**行首**，缩进取自那一行。
  const firstNl = rest.indexOf('\n');
  const close = rest.indexOf('}');
  const multi = firstNl >= 0 && (close < 0 || firstNl < close);
  if (!multi) {
    // `{}` / `{ }` / `{ "name": "x" }` 这一类：贴着 `{` 插，不擅自拆行。
    // 造出来的仍然是一份合法的 JSON，而且其余字节一个都没动。
    const body = rest.replace(/^[ \t]*/, '');
    const empty = body.startsWith('}');
    return `${text.slice(0, brace + 1)} "id": ${JSON.stringify(id)}`
      + `${empty ? '' : ','}${rest.replace(/^[ \t]+/, ' ')}`;
  }
  const m = /\n([ \t]*)\S/.exec(rest);
  const indent = (m && m[1]) || '  ';
  const at = brace + 1 + m.index + 1 + indent.length;    // 第一行的**行首**
  const head = text.slice(0, at);
  const tail = text.slice(at);
  // ★ 逗号**总是**要加：`id` 插在第一个键**之前**，所以它永远不是最后一个键
  //   （上面那个 `multi` 判据已经保证这棵树里至少有一个键）。早先这里写的是
  //   "看 tail 里有没有逗号"—— 于是单键的清单（`{ "a": 1 }` 多行写法）会漏掉
  //   逗号，产出一份**不合法的 JSON**。这正是"不要手搓字符串拼接"的那类教训：
  //   能靠结构推出来的东西，别去正则里猜。
  return `${head}"id": ${JSON.stringify(id)},${lf}${indent}${tail}`;
}

/** 从一段 JSON 文本里读清单 —— 只解析，不改写。 */
function readManifest(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`读不到 ${file}：${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} 不是合法的 JSON：${e.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${file} 的最外层不是一个 JSON 对象`);
  }
  return { text, obj };
}

// ==============================================================================
//  作者机器上的两样东西，以及树里的那一张表
//
//  三张表，三种生命周期，分开放：
//
//    血统表   id → 签名者公钥        在**源码树里**、提交进 git（§2.5）
//    发布表   (id, 版本) → 内容摘要   作者机器上，**不进树**（每打一次就变）
//    私钥     ——                     作者机器上，**不进树**（§4.1）
//
//  ★ 血统表在树里，是因为 clone 要带着它走 —— 那正是 §2.5 说的"分支判定必须
//    本地可判"。发布表与私钥不能进树，因为进树就会把树弄脏，而 §3.5 拒绝脏树。
// ==============================================================================

/**
 * 打包器在这台机器上的家：`<home>/keys/<id>.pem` 与 `<home>/releases.json`。
 *
 * 默认 `~/.config/slurmate/packer`。`--home` 或 `$SLURMATE_PACKER_HOME` 可以换掉 ——
 * ★ **用例与 CI 必须换掉**：不换的话跑一次测试就往作者的家目录里写字，而且第二次
 *   跑会因为发布表里已经有那一版而**拒绝打包**（那正是它该做的事，但在测试里是噪音）。
 */
function packerHome(opt) {
  if (opt && opt.home) return path.resolve(opt.home);
  if (process.env.SLURMATE_PACKER_HOME) return path.resolve(process.env.SLURMATE_PACKER_HOME);
  return path.join(os.homedir(), '.config', 'slurmate', 'packer');
}

// ── 私钥 ─────────────────────────────────────────────────────────────────────

function keyFilePath(home, id) { return path.join(home, 'keys', `${id}.pem`); }

/** 公钥的 32 个**裸字节** —— 附录 A.3 要的就是这个形状，指纹也是对它算的。 */
function rawPubOf(keyObject) {
  const der = crypto.createPublicKey(keyObject).export({ format: 'der', type: 'spki' });
  if (der.length !== ED25519_SPKI_PREFIX.length + 32
      || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new Error('这把钥匙的公钥不是 Ed25519 的 SPKI 形状（44 字节、前缀 302a300506032b6570032100）');
  }
  return der.subarray(ED25519_SPKI_PREFIX.length);
}

function saveKey(home, id, privateKey) {
  const file = keyFilePath(home, id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);        // umask 可能把它削掉，显式再来一次
  return file;
}

/** 本机有没有这个 id 的私钥。**读不动要抛**（那不是"没有"）。 */
function loadKey(home, id) {
  const file = keyFilePath(home, id);
  let pem;
  try { pem = fs.readFileSync(file); } catch { return null; }
  try { return { file, key: crypto.createPrivateKey(pem) }; }
  catch (e) {
    throw new Error(`${file} 读不成一把私钥：${e.message}\n`
      + '  它是打包器写的 PKCS#8 PEM。换机器的方式是**整份复制这个文件**（§4.1）。');
  }
}

// ── 血统表（在树里）──────────────────────────────────────────────────────────

function lineagePath(dir) { return path.join(dir, LINEAGE_FILE); }

/** 读一棵树里的血统表。**文件不在 ⇒ `obj: null`** —— 新树就是这样，不是错误。 */
function readLineage(dir) {
  const file = lineagePath(dir);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return { file, obj: null }; }
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) {
    throw new Error(`${file} 不是合法的 JSON：${e.message}\n`
      + '  这份表是打包器写的，**别手改**。真弄坏了就删掉它，下一次 init 会停下来问。');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)
      || !obj.lineage || typeof obj.lineage !== 'object' || Array.isArray(obj.lineage)) {
    throw new Error(`${file} 的形状不对。它应该长这样：\n`
      + '    { "schema": 1, "lineage": { "<id>": { "key": "<64 位十六进制公钥>" | null } } }');
  }
  return { file, obj };
}

/** 这个 id 在血统表里的那一条。**`undefined` = 不认识它** —— 那就是 §2.5 的判据。 */
function lineageEntry(obj, id) {
  if (!obj || !obj.lineage) return undefined;
  return Object.prototype.hasOwnProperty.call(obj.lineage, id) ? obj.lineage[id] : undefined;
}

function writeLineage(dir, lineage) {
  fs.writeFileSync(lineagePath(dir),
    `${JSON.stringify({ schema: LINEAGE_SCHEMA, lineage }, null, 2)}\n`, 'utf8');
}

/**
 * ★ §2.5 的那次"停下来问"。**这是本文件里最要紧的一段话。**
 *
 * 规范：一棵树带着 id、而血统表不认识它时，打包器**禁止**静默换 id、也**禁止**
 * 静默沿用 id，**必须**停下来把两种可能连同各自的后果说清，由作者决定。
 *
 * ★ 两条路的后果**相反**，所以这件事不能替你选：真分身铸新 id 是**正解**；
 *   而"我丢了钥匙 / 这条记录不在了"铸新 id 是**代价**（所有已同意的用户重新
 *   同意一次，正在跑的会话变成"未知服务"）。把后者按前者处理，就是把
 *   "我丢了钥匙"说成"我换了个插件"。
 */
function lineageStopAndAsk(detail) {
  throw new Error(
    `${detail}\n`
    + '\n§2.5：这一条不许静默处理，因为两种可能的后果相反：\n'
    + '\n  ① 这**是另一个东西**（复制来的 plugin.json，或者一次真分身）\n'
    + '     ⇒ 铸一个新的 id：`init <插件目录> --fork`。\n'
    + '        两个不同的东西抢同一个 (id, 版本)，会让一个站点把另一个站点正在用的\n'
    + '        插件弄坏（§2.4、§2.6）—— 这一条要拦的就是它。\n'
    + '\n  ② 这**是同一个插件**，只是这条记录不在了（换了机器 / 表被删过 / 你正在用\n'
    + '     另一把钥匙签）\n'
    + '     ⇒ 先把记录找回来：血统表**应当**提交在版本控制里（§2.5），私钥**应当**\n'
    + '        有备份（§4.1）。找回来之后这里什么都不用改。\n'
    + '     ⇒ 找不回来（比如这个 id 是**在血统表存在之前**铸的）⇒ `init <插件目录>\n'
    + '        --adopt`：承认这个 id 归这棵树，给它补一条记录。\n'
    + '     ⇒ 找不回来而又要**换一把钥匙**：只剩 `--fork`，而代价是\n'
    + '        **所有已同意的用户要重新同意一次**，正在跑的会话变成"未知服务"。\n');
}

// ── 发布表（在这台机器上）────────────────────────────────────────────────────
//
// ★ 它挡的是**手滑**，不是攻击 —— 与 install.js 那条"绝不覆盖内容不同的同版本"
//   自带的是同一个保留：它不进树（每打一次就变，进树就把树弄脏、与 §3.5 打架），
//   所以换一台机器就没有它。
//
// ★ 它守的是 §2.4：一个 (id, 版本) 只有一份内容。而"改了内容"里最容易被忘掉的
//   一种，是**往树里加了一个文件**（比如给老插件补一条血统记录）—— 那会让同一个
//   版本号算出第二个摘要，而按 §2.4 收包方**两个都不加载**。

function releasesPath(home) { return path.join(home, 'releases.json'); }

function readReleases(home) {
  const file = releasesPath(home);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { ok: true, file, map: new Map() };   // 没打过 = 正常
    return { ok: false, file, why: e.message };
  }
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { return { ok: false, file, why: `不是合法的 JSON（${e.message}）` }; }
  const map = new Map();
  const table = (obj && obj.releases && typeof obj.releases === 'object') ? obj.releases : {};
  for (const [k, v] of Object.entries(table)) {
    if (v && typeof v === 'object' && typeof v.digest === 'string') map.set(k, v);
  }
  return { ok: true, file, map };
}

function writeReleases(home, map) {
  const file = releasesPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const releases = {};
  for (const k of [...map.keys()].sort()) releases[k] = map.get(k);   // 排一下序，diff 好看
  fs.writeFileSync(file, `${JSON.stringify({ schema: 1, releases }, null, 2)}\n`, 'utf8');
}

/**
 * 判 §2.4。返回 `{note, rel}`：`note` 是一句**要打出来**的话（没有就是 `null`），
 * `rel` 是待写回的发布表（读不动时是 `null`）。
 */
function oneContentPerVersion(home, id, version, digest, out, opts) {
  const rel = readReleases(home);
  if (!rel.ok) {
    // ★ 读不动时**不拦**，但一定要**说出来**：一条静默消失的防线比没有更糟 ——
    //   它让人以为还有。所以这一句不是可选的。
    return { rel: null, note: `发布表读不动（${rel.why}）—— 这一次 §2.4 那条检查**没有生效**` };
  }
  const key = `${id}@${version}`;
  const prev = rel.map.get(key);
  if (prev && prev.digest !== digest && !opts.reuseVersion) {
    throw new Error(
      `这个 (id, 版本) 在这台机器上已经打过，而内容和这一次不一样：\n`
      + `    ${key}\n`
      + `    记过的   ${prev.digest}`
      + (prev.at ? `（${new Date(prev.at).toISOString().slice(0, 10)}，落在 ${prev.out || '?'}）` : '')
      + `\n    这一次   ${digest}\n`
      + '\n§2.4：一个 (id, 版本) 只有一份内容 —— 改了内容的**任何**字节就必须升版本号。\n'
      + '  不升的话，拿过旧那一份的人和拿到新那一份的人会各说各话，而按 §2.4 客户端\n'
      + '  **两个都不加载**。\n'
      + '  ★ 最容易被忘掉的一种"改了内容"：往树里加了一个文件（比如给老插件补一条血统记录）。\n'
      + '\n★ 如果这一版**从来没发出去过**（没有站点分过、没有人装过），加\n'
      + '  `--reuse-version` 覆盖这条记录，然后照常发。\n');
  }
  rel.map.set(key, { digest, at: Date.now(), out });
  return { rel, note: null };
}

// ==============================================================================
//  六个动词
// ==============================================================================

/**
 * ★ `--fork`：把树里那个 id **换掉**（§2.5 里"真分身"那条路）。
 *
 * 与 `insertId` 同一条纪律：**只动那一个值**，其余字节一个都不许动。所以这里做的是
 * "已知旧值"的定点替换，不是 `JSON.parse` 再 `stringify` —— 后者会重排键序、把
 * `\u` 转义还原成汉字、把 `1e3` 写成 `1000`（见 insertId 那段注释）。
 */
function replaceId(text, oldId, newId) {
  const quoted = JSON.stringify(oldId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`("id"[ \\t]*:[ \\t]*)${quoted}(?=[ \\t]*[,}])`, 'g');
  const hits = text.match(re);
  if (!hits || hits.length !== 1) {
    throw new Error(`plugin.json 里的 "id": ${JSON.stringify(oldId)} 找到了 ${hits ? hits.length : 0} 处，`
      + '而 --fork 只认恰好一处 —— 这份清单不是打包器写出来的那一份。');
  }
  return text.replace(re, `$1${JSON.stringify(newId)}`);
}

function cmdInit(dir, opts) {
  const mfFile = path.join(dir, MANIFEST);
  const { text, obj } = readManifest(mfFile);
  const hasId = Object.prototype.hasOwnProperty.call(obj, 'id')
    && obj.id !== null && obj.id !== '';
  const { file: lfile, obj: lobj } = readLineage(dir);

  if (hasId && !opts.fork) {
    const id = String(obj.id);
    if (!ULID_RE.test(id)) {
      throw new Error(`plugin.json 里的 id ${JSON.stringify(obj.id)} 不是一个 ULID（26 个 Crockford base32 字符）。\n`
        + '  §2.1：id 铸一次、此后永不改变。要换 id 就是铸一个新的（§2.5 的分身），不是改一个字符。');
    }
    const entry = lineageEntry(lobj, id);
    if (entry === undefined && !opts.adopt) {
      lineageStopAndAsk(`这个插件带着 id ${id}，而血统表里没有它的那一条：\n`
        + `    血统表  ${lfile}${lobj ? '' : '（文件不存在）'}`);
    }
    if (entry === undefined) {
      // ★ `--adopt`：§2.5 那次"停下来问"的**第二个答案**（"这是同一个插件"）。
      //   没有它的话，那个答案在工具里**没有可执行的形式** —— 作者只能手写
      //   `lineage.json`，而手写一张由机器维护的表正是 typo 走进安全判据的路。
      //
      //   ★ 它**不**证明这棵树就是当初铸这个 id 的那一棵：打包器判不了这件事
      //     （这就是为什么那次要停下来问）。它记录的是**作者的一次声明**。
      //     真正守这件事的是客户端那张按 id 的钉表（§5.4）。
      const repo = repoRootOf(dir);
      const rel = relToRepo(repo, dir);
      ensureClean(repo, rel);
      const lineage = { ...(lobj ? lobj.lineage : {}) };
      lineage[id] = { key: null };
      writeLineage(dir, lineage);
      console.log(`--adopt：给 ${id} 在血统表里补了一条（钥匙还没定）。`);
      console.log(`    血统表  ${path.join(rel || '.', LINEAGE_FILE)}`);
      console.log('');
      console.log('★ 它记下的是**你的一次声明**："这个 id 归这棵树"。');
      console.log('  ★ 它**不**证明这棵树就是当初铸出这个 id 的那一棵 —— 打包器判不了这件事，');
      console.log('    所以刚才才停下来问。真正守这件事的是客户端那张按 id 的钉表（§5.4）：');
      console.log('    换了一把钥匙签，老用户会拒绝，而没有任何本地操作能绕过它。');
      console.log('★ 树现在是脏的：先提交，再 `keygen` / `build`。');
      return 0;
    }
    console.log(`这个插件已经有 id 了：${id}`);
    console.log('  §2.1：id 铸一次、此后永不改变。什么都不做。');
    console.log(`  血统表  ${lfile} 里记着它${entry.key ? '' : '（还没定钥匙）'}`);
    return 0;
  }

  const repo = repoRootOf(dir);
  const rel = relToRepo(repo, dir);
  ensureClean(repo, rel);                       // §2.1「应当拒绝在源码树不干净时铸 id」

  const oldId = hasId ? String(obj.id) : null;
  const id = mintUlid();
  fs.writeFileSync(mfFile, oldId === null ? insertId(text, id) : replaceId(text, oldId, id), 'utf8');

  const lineage = (lobj && lobj.lineage) ? { ...lobj.lineage } : {};
  lineage[id] = { key: null };
  writeLineage(dir, lineage);

  const mfRel = path.join(rel || '.', MANIFEST);
  const linRel = path.join(rel || '.', LINEAGE_FILE);
  if (oldId === null) {
    console.log(`铸了一个 id 并写回 ${mfRel}：`);
    console.log(`    ${id}`);
  } else {
    console.log(`分身：把 id 换掉了，并写回 ${mfRel}：`);
    console.log(`    ${oldId}  →  ${id}`);
    console.log('★ 旧的 id **留在血统表里** —— 那是它的祖先，不是要被抹掉的东西。');
    console.log('★ §2.5 的代价，说在明处：所有已同意过那个 id 的用户要**重新同意一次**，');
    console.log('  正在跑的会话会变成"未知服务"。');
  }
  console.log('');
  console.log(`血统表 ${linRel} 里给它记了一条（钥匙还没定）：`);
  console.log(`    { "${id}": { "key": null } }`);
  console.log('');
  console.log('★ 写回是**插入/替换**，不是重新序列化整份 JSON —— 其余字节一个都没动。');
  console.log('★ 树现在是脏的，而且**必须脏**：请先提交，再 `keygen` / `build`。');
  console.log('  §3.5 要求打包的输入是一个提交，所以这些动词不能合并成一条命令。');
  return 0;
}

/**
 * `keygen`：给这个 id 铸一把签名钥匙。
 *
 * ★ 为什么不是 `init` 顺手做掉：`init` 管的是 §2.1（id），而签名是**可选**的
 *   （§4.1）—— 一条命令顺带铸钥匙，会让"我没打算签名"变成"我说不清我有没有签"。
 *   两个动词都只弄脏树一次，都提示你提交，代价一样。
 */
function cmdKeygen(dir, opts) {
  const { obj } = readManifest(path.join(dir, MANIFEST));
  const id = String(obj.id || '');
  if (!ULID_RE.test(id)) {
    throw new Error(`${MANIFEST} 里还没有一个合法的 id —— 先跑 init（§2.1）。`);
  }
  const { file: lfile, obj: lobj } = readLineage(dir);
  const entry = lineageEntry(lobj, id);
  if (entry === undefined) {
    lineageStopAndAsk(`这个插件带着 id ${id}，而血统表里没有它的那一条：\n`
      + `    血统表  ${lfile}${lobj ? '' : '（文件不存在）'}`);
  }
  if (entry.key) {
    const fp = fingerprint(Buffer.from(String(entry.key), 'hex'));
    throw new Error(`这个 id 已经有钥匙了：\n`
      + `    指纹    ${fp}\n`
      + `    记在    ${lfile}\n`
      + '\n§4.1：换一把钥匙**不是升级，是断了血统** —— 老用户会拒绝（§5.4），\n'
      + '  也就是说这里铸的这把钥匙发出去的包，装得上的人一个都没有。\n'
      + '  真的丢了私钥 ⇒ `init <插件目录> --fork`（代价：所有用户重新同意一次）。\n'
      + '  有备份 ⇒ 把那份 .pem 复制成\n'
      + `    ${keyFilePath(packerHome(opts), id)}\n`
      + '  然后直接 `sign` —— 什么都不用改。');
  }

  const repo = repoRootOf(dir);
  const rel = relToRepo(repo, dir);
  ensureClean(repo, rel);                  // 与 init 同一条：改身份之前树要是干净的

  const home = packerHome(opts);
  const kf = keyFilePath(home, id);
  const mine = loadKey(home, id);           // 读不动会抛，不会当成"没有"
  const lineage = { ...(lobj ? lobj.lineage : {}) };
  const linRel = path.join(rel || '.', LINEAGE_FILE);

  if (mine) {
    // ★ 库里**已经**有这一把：**认它**，不铸新的。
    //   这条路的来处是 §4.1 那句"换机器的方式是复制私钥" —— 作者把 .pem 拷过来，
    //   而血统表里这一条还没记。铸一把新的会把拷过来的那一份变成孤儿，而它才是
    //   老用户钉住的那一把。所以这里做的事只是**把它记下来**。
    const raw = rawPubOf(mine.key);
    lineage[id] = { key: raw.toString('hex') };
    writeLineage(dir, lineage);
    console.log(`钥匙库里已经有一把了 —— 就认它，**没有**铸新的：`);
    console.log(`    指纹    ${fingerprint(raw)}`);
    console.log(`    私钥    ${kf}`);
    console.log(`    记进了  ${linRel}`);
    console.log('');
    console.log('★ 这是"换机器"那条路（§4.1）：把 .pem 整份复制过来，再跑一次 keygen。');
    console.log('★ 树现在是脏的：先提交，再 `build` / `sign`。');
    return 0;
  }

  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = rawPubOf(privateKey);
  saveKey(home, id, privateKey);
  lineage[id] = { key: raw.toString('hex') };
  writeLineage(dir, lineage);

  console.log(`铸了一把 Ed25519 钥匙，公钥写进了 ${linRel}：`);
  console.log(`    指纹    ${fingerprint(raw)}`);
  console.log(`    私钥    ${kf}（0600）`);
  console.log('');
  console.log('★ **私钥要备份。** 丢了它就是血统断了：老用户会拒绝你签的任何东西，');
  console.log('  你只能给这个插件铸一个新 id，让所有人重新同意一遍（§4.1）。');
  console.log('  换机器的方式是把这个 .pem **整份复制**过去，不是在新机器上再铸一把。');
  console.log('★ 树现在是脏的：先提交，再 `build` / `sign`。');
  return 0;
}

function defaultOut(dir, version) {
  return path.join(path.dirname(path.resolve(dir)),
    `${path.basename(path.resolve(dir))}-${version}.splug`);
}

function cmdBuild(dir, opts) {
  const repo = repoRootOf(dir);
  const rel = relToRepo(repo, dir);
  ensureClean(repo, rel);
  const commit = opts.commit || 'HEAD';

  // 清单从**那个提交**里读 —— 工作树里那份可能还没提交
  const entries = lsTree(repo, commit, rel);
  if (!entries.length) throw new Error(`${commit}:${rel || '.'} 里一个文件都没有 —— 目录还没提交？`);

  const { files, skipped, notes } = readTree(repo, commit, rel);
  const mf = files.find((f) => f.path === MANIFEST);
  if (!mf) throw new Error(`${commit}:${rel} 里没有 ${MANIFEST} —— 一个插件必须有清单（§3.1）`);

  let manifest;
  try {
    manifest = JSON.parse(mf.data.toString('utf8'));
  } catch (e) {
    throw new Error(`${MANIFEST} 不是合法的 JSON：${e.message}`);
  }
  // ★ 这两条**拿原串比**，不 `String(...)` 强转。强转是一个假入口：
  //   `["1.0.0"]` 经 `String()` 变成 `"1.0.0"` 于是**打包器收下**，而客户端
  //   （`typeof mf.version !== 'string'`）与守护进程（`need_str`）都会拒 ——
  //   又一个"一侧收下、另一侧拒了"，而且它只在包真的发出去之后才发作。
  //   与 §2.3「只校验，不归一化」是同一条纪律。
  if (typeof manifest.id !== 'string' || !ULID_RE.test(manifest.id)) {
    throw new Error(`${MANIFEST} 里的 id ${JSON.stringify(manifest.id)} 不是一个 ULID —— 先跑 init（§2.1）`);
  }
  if (typeof manifest.version !== 'string' || !PLUGIN_VERSION_RE.test(manifest.version)) {
    throw new Error(`${MANIFEST} 里的 version ${JSON.stringify(manifest.version)} 不合 x.y.z 的形状（§2.3）`);
  }
  const engWhy = enginesShapeProblem(manifest);
  if (engWhy) throw new Error(`${MANIFEST} 里的 ${engWhy}（§2.3.1）`);

  // §2.5：这个 id 得在这棵树**这个提交**的血统表里。表从提交里读（不是从盘上）——
  // 于是"我们判的那张表"与"进负载的那张表"是同一次读出来的同一份字节。
  const linFile = files.find((f) => f.path === LINEAGE_FILE);
  let lineage = null;
  if (linFile) {
    try { lineage = JSON.parse(linFile.data.toString('utf8')); } catch { lineage = null; }
  }
  if (lineageEntry(lineage, manifest.id) === undefined) {
    lineageStopAndAsk(`这个插件的 id ${String(manifest.id)}，在这个提交的血统表里没有那一条：\n`
      + `    id      ${String(manifest.id)}\n`
      + `    血统表  ${commit}:${rel ? `${rel}/` : ''}${LINEAGE_FILE}`
      + (linFile ? '（有这份文件，但里面没有这一条）' : '（这个提交里没有这份文件）'));
  }

  const out = path.resolve(opts.out || defaultOut(dir, manifest.version));
  // ★ 包**禁止**落在自己的源码树里：它下一次就会被当成一份普通文件进负载，
  //   于是摘要每次都变。这是"同一输入产出不同包"的第一号现场，所以在写之前拦。
  const inTree = path.relative(path.resolve(dir), out);
  if (inTree && !inTree.startsWith('..') && !path.isAbsolute(inTree)) {
    throw new Error(`输出的包在插件自己的源码树里（${inTree}）——\n`
      + '  下一次打包时它会被当成一份普通文件进负载，摘要于是每次都变。\n'
      + `  换一个位置（默认是 ${defaultOut(dir, manifest.version)}），或者用 --out 指定。`);
  }

  const digest = contentDigest(files);
  const home = packerHome(opts);

  // §2.4：同一个 (id, 版本) 不许有第二份内容。**先判后写** —— 写下去再判，
  // 那个包已经在磁盘上了，而"报错"与"产出"同时发生是最难收拾的一种状态。
  const rec = oneContentPerVersion(home, manifest.id, manifest.version, digest, out, opts);
  if (rec.note) notes.push(rec.note);

  const pkg = buildPackage(files);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, pkg);

  if (rec.rel) {
    try {
      writeReleases(home, rec.rel.map);
    } catch (e) {
      console.log(`  ⚠ 发布表写不下去（${e.message}）—— 下一次打这个版本时 §2.4 那条检查不会生效`);
    }
  }

  console.log(`打好了：${out}`);
  console.log(`  id       ${manifest.id}`);
  console.log(`  名字     ${manifest.name}（${manifest.displayName}）`);
  console.log(`  版本     ${manifest.version}`);
  console.log(`  内容摘要 ${digest}`);
  const payload = files.reduce((a, f) => a + f.data.length, 0);
  console.log(`  ${files.length} 份文件 / ${humanBytes(pkg.length)}`
    + `（负载 ${humanBytes(payload)} + 信封 ${humanBytes(pkg.length - payload)}）`);
  console.log(`  输入     ${commit}:${rel || '.'}`);
  for (const n of notes) console.log(`  ⚠ ${n}`);
  if (skipped.length) {
    console.log(`  跳过 ${skipped.length} 项（不在分发范围内）：${skipped.slice(0, 5).join('、')}`);
  }
  if (files.some((f) => f.path === CLIENT_ENTRY)) console.log('  有客户端侧 client/index.js');
  if (files.some((f) => f.path === JOB_ENTRY)) {
    console.log('  有作业侧 job/start.sh（★ 它的 0755 没进包 —— 作业脚本是被拼进 sbatch 的，不靠权限位）');
  }
  const entry = lineageEntry(lineage, manifest.id);
  if (!entry.key) {
    console.log('  签名     （没有）—— §4.1 允许，但客户端第一次见它会"首次即信任"。');
    console.log('           要签就 `sign <包>`（它**不改内容摘要**，所以不必重新打包）。');
  } else {
    console.log('  签名     （还没签）—— 血统表说这个 id 归 '
      + `${fingerprint(Buffer.from(String(entry.key), 'hex'))}，跑 \`sign ${path.basename(out)}\` 盖上。`);
  }
  return 0;
}

/** 血统表里那一条记的公钥，转成 32 字节；记坏了就抛。 */
function entryKeyBytes(entry, where) {
  const hex = String(entry.key).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`${where} 里这一条的公钥不是一个 64 位十六进制的裸公钥：${JSON.stringify(entry.key)}`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * 从包的**负载**里读血统表里这个 id 的那一条。
 *
 * ★ 表在负载里（见 `LINEAGE_FILE` 那段），所以 `sign` 不必知道源码树在哪 ——
 *   别人打好的包也签得动。`undefined` = 不认识这个 id ⇒ §2.5 停下来问。
 */
function lineageEntryOfPackage(r, id) {
  const raw = r.payloadOf(LINEAGE_FILE);
  if (!raw) return undefined;
  let obj;
  try { obj = JSON.parse(raw.toString('utf8')); } catch { return undefined; }
  return lineageEntry(obj, id);
}

/**
 * `sign`：给一个已经打好的包盖上签名。
 *
 * ★ 它**不改内容摘要** —— 签名盖的是摘要（§4.2），而摘要是负载算出来的。
 *   所以"给一个已经打好的包补签名"是合法的：按 §2.4，它还是同一份构件。
 *   这也是 `sign` 能是一个**独立动词**的全部理由（`build` 只管内容）。
 *
 * ★ 也正因为如此，`build` **不**看钥匙库：它的输出只是 (提交, 选项) 的函数，
 *   与这台机器上有什么钥匙无关。§3.5 那句"同一输入逐字节相同"因此没有星号。
 */
function cmdSign(file, opts) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    console.error(`读不到 ${file}：${e.message}`);
    return 2;
  }
  const r = parsePackage(buf);
  if (!r.ok) {
    console.error(`✗ ${file}：不合规（${r.code}）—— ${r.why}`);
    return 1;
  }
  const id = String(r.manifest.id || '');
  if (!ULID_RE.test(id)) {
    throw new Error(`包里的 ${MANIFEST} 的 id ${JSON.stringify(r.manifest.id)} 不是一个 ULID（§2.1）——`
      + '不签一份身份都立不住的清单。');
  }

  const entry = lineageEntryOfPackage(r, id);
  if (entry === undefined) {
    lineageStopAndAsk(`这个包的负载里那份 ${LINEAGE_FILE} 没有这个 id 那一条：\n`
      + `    id  ${id}\n`
      + `    包  ${file}`);
  }
  const where = `${path.basename(file)} 里的 ${LINEAGE_FILE}`;
  if (!entry.key) {
    throw new Error(`血统表说这个 id **不签名**，而 sign 只按血统表办事：\n`
      + `    ${id}  →  { "key": null }\n`
      + `    （${where}）\n`
      + '\n两条路，看你想要哪一条：\n'
      + '  · 这个插件本来就不签名（§4.1 允许）⇒ 什么都不用做，这个包照样能发。\n'
      + '    客户端第一次见它会"首次即信任"（§5.4）。\n'
      + '  · 现在想开始签 ⇒ 在源码树里 `keygen <插件目录>`，提交，再 `build` 一个\n'
      + '    **新版本号**。血统表在负载里，给它补上钥匙就是改了内容 ⇒ §2.4。\n'
      + '    ★ 已经发出去的那一版**不能**这样补：那会让同一个版本号出现两份内容。\n');
  }

  const home = packerHome(opts);
  const entryRaw = entryKeyBytes(entry, where);
  const k = loadKey(home, id);
  if (!k) {
    throw new Error(`本机没有这个 id 的私钥：\n`
      + `    应该有    ${keyFilePath(home, id)}\n`
      + `    血统表说  ${fingerprint(entryRaw)}\n`
      + '\n§4.1：私钥属于**这个插件**，换机器的方式是把它**整份复制**过去。\n'
      + '  · 有备份 ⇒ 复制到上面那个路径，再跑一次 sign。\n'
      + '  · 找不回来 ⇒ 血统断了：老用户会拒绝你签的任何东西（§5.4），只能\n'
      + '    `init <插件目录> --fork` 铸新 id，代价是所有用户重新同意一次（§2.5）。\n'
      + '  ★ 在这里另铸一把新钥匙没有用 —— 客户端钉住的是**旧**那一把。');
  }
  const raw = rawPubOf(k.key);
  if (!raw.equals(entryRaw)) {
    throw new Error(`本机那把私钥与血统表里的不是同一把：\n`
      + `    血统表    ${fingerprint(entryRaw)}\n`
      + `    本机钥匙  ${fingerprint(raw)}   （${k.file}）\n`
      + '\n两份记录分家了，先弄清哪一份是对的（血统表在版本控制里，看得见历史），\n'
      + '再决定是找回对的私钥，还是走 §2.5 的 --fork。**不要**在这里覆盖任何一份。');
  }

  // Ed25519 是**确定性**签名：同一个包同一把钥匙签两次，逐字节相同。
  // 所以 sign 不需要任何随机源，也不会破坏 §3.5 那条"同输入同输出"。
  const sig = crypto.sign(null, Buffer.from(r.digest, 'hex'), k.key);
  const sigBlock = Buffer.concat([Buffer.from([SIG_ALG_ED25519]), raw, sig]);
  const head = Buffer.from(buf.subarray(0, HEADER_BYTES));
  head.writeUInt32BE(sigBlock.length, 16);
  // 签名块插在**记录表之后、负载之前**（附录 A.2/A.3），已有的签名块被换掉。
  const out = Buffer.concat([
    head, buf.subarray(HEADER_BYTES, r.tableEnd), sigBlock, buf.subarray(r.payloadStart),
  ]);

  // ★ 自己读回来一遍：拼接出错的话，错误应该在这里响，而不是在别人机器上响。
  const back = parsePackage(out);
  if (!back.ok) throw new Error(`签名之后这个包自己读不回来了（${back.code}）—— 这是打包器的 bug`);
  if (back.digest !== r.digest) {
    throw new Error('签名改了内容摘要 —— 那是打包器的 bug（§4.2：签名盖摘要，不覆盖信封）');
  }

  const outFile = path.resolve(opts.out || file);
  fs.writeFileSync(outFile, out);

  console.log(`签好了：${outFile}`);
  console.log(`  签名者   ${fingerprint(raw)}`);
  console.log(`  内容摘要 ${r.digest}`);
  console.log('           ★ 与签之前**一字不差** —— 签名盖的是摘要，不覆盖信封（§4.2）。');
  console.log(`  信封     ${HEADER_BYTES} + ${r.tableEnd - HEADER_BYTES}（记录表） + ${sigBlock.length}（签名块）`
    + ` + ${out.length - r.payloadStart - sigBlock.length}（负载）`);
  if (outFile === path.resolve(file)) {
    console.log('  原地     未签名的那些字节被换掉了；摘要是同一个，所以按 §2.4 它还是同一份构件。');
    console.log('           （想要不带签名的那一份：`build` 会逐字节重现它。）');
  }
  return 0;
}

function cmdVerify(file, opts) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    console.error(`读不到 ${file}：${e.message}`);
    return 2;
  }
  const r = parsePackage(buf);
  if (!r.ok) {
    console.error(`✗ ${file}：不合规（${r.code}）—— ${r.why}`);
    return 1;
  }
  let bad = 0;
  console.log(`✓ ${file} 能解析`);
  console.log(`  内容摘要 ${r.digest}`);
  console.log(`  ${r.fileCount} 份文件 / ${humanBytes(buf.length)}`);
  if (r.sig) {
    console.log(`  签名     Ed25519，签名者 ${r.sig.fingerprint}`);
  } else {
    console.log('  签名     （没有）—— §4.1 允许，但客户端第一次见它会"首次即信任"');
  }
  if (opts.expectDigest && opts.expectDigest !== r.digest) {
    console.error(`✗ 内容摘要不是期望的那个：期望 ${opts.expectDigest}`);
    bad = 1;
  }
  if (opts.expectSigner) {
    if (!r.sig) {
      console.error(`✗ 期望签名者是 ${opts.expectSigner}，而这个包没签名`);
      bad = 1;
    } else if (r.sig.fingerprint !== opts.expectSigner) {
      console.error(`✗ 签名者不是期望的那一把：期望 ${opts.expectSigner}，实际 ${r.sig.fingerprint}`);
      bad = 1;
    }
  }
  // §2.5：包里那份血统表说这个 id 归谁 —— 与**签这个包的人**对得上吗。
  // 这是 §2.5 判据的第二个落点（第一个是打包时的"停下来问"），而且是唯一一个
  // 在**已经打好的包**上还能查的地方。
  if (r.sig) {
    const entry = lineageEntryOfPackage(r, String(r.manifest.id || ''));
    if (entry && entry.key) {
      const want = entryKeyBytes(entry, `包里的 ${LINEAGE_FILE}`);
      if (!want.equals(r.sig.pubkey)) {
        console.error(`✗ 包里那份 ${LINEAGE_FILE} 说这个 id 归 ${fingerprint(want)}，`);
        console.error(`  而这个包的签名者是 ${r.sig.fingerprint} —— 两份记录分家了（§2.5）。`);
        console.error('  换一把钥匙不是升级，是断了血统：客户端钉住的是旧那一把，会直接拒绝。');
        bad = 1;
      }
    }
  }
  // §3.6 的"负载等于源码树"—— 部署期做不了这件事（那里没有源码树），
  // 所以它的用例住在这里、住在 CI 里。源码在这台机器上，这一条才判得了。
  if (opts.against) {
    const dir = opts.against.replace(/@[^@]*$/, '');
    const ref = opts.against.includes('@') ? opts.against.slice(opts.against.lastIndexOf('@') + 1) : (opts.commit || 'HEAD');
    const repo = repoRootOf(dir);
    const rel = relToRepo(repo, dir);
    const tree = readTree(repo, ref, rel);
    const a = tree.files.map((f) => `${f.path}\0${f.sha256}`).join('\n');
    const b = r.files.map((f) => `${f.path}\0${f.sha256}`).join('\n');
    if (a === b) {
      console.log(`✓ 负载与 ${ref}:${rel || '.'} 逐字节相同（§3.6）`);
    } else {
      console.error(`✗ 负载与 ${ref}:${rel || '.'} 不是同一棵树`);
      const only = (x, y) => x.filter((l) => !y.includes(l));
      for (const l of only(tree.files.map((f) => `${f.path}\0${f.sha256}`), r.files.map((f) => `${f.path}\0${f.sha256}`))) {
        console.error(`    只在源码树里：${l.split('\0')[0]}`);
      }
      for (const l of only(r.files.map((f) => `${f.path}\0${f.sha256}`), tree.files.map((f) => `${f.path}\0${f.sha256}`))) {
        console.error(`    只在包里：  ${l.split('\0')[0]}`);
      }
      bad = 1;
    }
  }
  return bad ? 1 : 0;
}

function cmdInspect(file, opts) {
  const buf = fs.readFileSync(file);
  if (opts.json) {
    const r = parsePackage(buf);
    if (!r.ok) {
      console.log(JSON.stringify({ ok: false, code: r.code, why: r.why }, null, 2));
      return 1;
    }
    const le = lineageEntryOfPackage(r, String(r.manifest.id || ''));
    console.log(JSON.stringify({
      ok: true,
      format: r.format,
      bytes: buf.length,
      digest: r.digest,
      manifest: r.manifest,
      sig: r.sig ? { alg: 'Ed25519', fingerprint: r.sig.fingerprint } : null,
      lineage: le ? { key: le.key || null,
                      fingerprint: le.key ? fingerprint(Buffer.from(String(le.key), 'hex')) : null } : null,
      files: r.files.map((f) => ({ path: f.path, size: Number(f.size), sha256: f.sha256 })),
    }, null, 2));
    return 0;
  }
  const r = parsePackage(buf);
  if (!r.ok) {
    console.error(`✗ 这个包不合规（${r.code}）—— ${r.why}`);
    return 1;
  }
  const le = lineageEntryOfPackage(r, String(r.manifest.id || ''));
  console.log(`${file}`);
  console.log(`  容器     format ${r.format}，${humanBytes(buf.length)}`);
  console.log(`  内容摘要 ${r.digest}`);
  console.log(`  签名     ${r.sig ? `Ed25519，签名者 ${r.sig.fingerprint}` : '（没有）'}`);
  if (le) {
    if (!le.key) {
      console.log(`  血统     ${LINEAGE_FILE} 说这个 id 不签名（"key": null）`);
    } else {
      const lf = fingerprint(Buffer.from(String(le.key), 'hex'));
      const clash = r.sig && !r.sig.pubkey.equals(Buffer.from(String(le.key), 'hex'));
      console.log(`  血统     ${LINEAGE_FILE} 说这个 id 归 ${lf}`
        + (clash ? '  ★ 与签名者不符（§2.5）' : ''));
    }
  } else {
    console.log(`  血统     ${LINEAGE_FILE} 里没有这个 id —— 这张表不认识它（§2.5）`);
  }
  console.log('');
  console.log(`  清单（${MANIFEST}，它自己也在下面这份清单里）`);
  for (const [k, v] of Object.entries(r.manifest)) {
    console.log(`    ${k.padEnd(14)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  console.log('');
  console.log(`  负载 ${r.fileCount} 份 —— **就是这些，没有别的**（§3.6）`);
  for (const f of r.files) {
    console.log(`    ${String(f.size).padStart(8)}  ${f.sha256.slice(0, 12)}…  ${f.path}`);
  }
  return 0;
}

// ==============================================================================
//  入口
// ==============================================================================

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function usage(code) {
  const out = code ? console.error : console.log;
  out(`slurmate-packer —— 插件作者的打包器（单文件、零依赖）

用法：
  node slurmate-packer.js init    <插件目录> [--fork]
  node slurmate-packer.js keygen  <插件目录>
  node slurmate-packer.js build   <插件目录> [--commit <ref>] [--out <文件>] [--reuse-version]
  node slurmate-packer.js sign    <包> [--out <文件>]
  node slurmate-packer.js verify  <包> [--expect-digest <hex>] [--expect-signer <指纹>]
                                       [--against <插件目录>[@<ref>]]
  node slurmate-packer.js inspect <包> [--json]

  --home <目录> 可以跟在任何动词后面（等价于 $SLURMATE_PACKER_HOME）。默认
  ~/.config/slurmate/packer，里面是 keys/<id>.pem（私钥）与 releases.json（发布表）。
  ★ 这两样**不进源码树**：进了就把树弄脏，而 §3.5 拒绝脏树。

  init     铸一个 id（只在树里没有的时候）并**插入**写回 plugin.json，同时给血统表
           记一条。它会弄脏树，所以之后要你自己提交 —— 与 build 分成两个动词是故意的。
           树里**已经有** id 而血统表不认识它时，它会停下来问（§2.5），而两个答案是：
           --fork   承认这是**另一个插件**：把 id 换掉（代价：所有已同意的用户要
                    重新同意一次）。
           --adopt  承认这是**同一个插件**、只是这条记录不在了（比如 id 是在血统表
                    存在之前铸的）：给它补一条记录。
  keygen   给这个 id 定一把 Ed25519 钥匙：公钥写进血统表，私钥进钥匙库（0600）。
           钥匙库里已经有一把（§4.1 的〈换机器 = 复制 .pem〉）就**认它**，不铸新的。
           一个 id 只有一把 —— 丢了私钥就只能 --fork（§4.1）。
  build    从一个**提交**打出 .splug。工作树脏时拒绝（§3.5）。它**不看钥匙库**：
           输出只是 (提交, 选项) 的函数。
  sign     给一个已经打好的包盖签名。它**不改内容摘要**（§4.2），所以不必重新打包。
  verify   逐份校字节、算内容摘要、验签，并核对包里的血统表与签名者对不对得上。
           --against 顺带判 §3.6。
  inspect  打出包里到底有什么 —— 作者拿它对着规范逐行核对。

规范：docs/PLUGIN-SPEC.md（尤其 §2、§3、§4、附录 A）。`);
  return code;
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opt.json = true;
    else if (a === '--fork') opt.fork = true;
    else if (a === '--adopt') opt.adopt = true;
    else if (a === '--reuse-version') opt.reuseVersion = true;
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--commit') opt.commit = argv[++i];
    else if (a === '--out') opt.out = argv[++i];
    else if (a === '--against') opt.against = argv[++i];
    else if (a === '--expect-digest') opt.expectDigest = argv[++i];
    else if (a === '--expect-signer') opt.expectSigner = argv[++i];
    else if (a === '-h' || a === '--help') { usage(0); process.exit(0); }
    else if (a.startsWith('-')) throw new Error(`不认识的选项 ${a}`);
    else pos.push(a);
  }
  return { pos, opt };
}

function main(argv) {
  const { pos, opt } = parseArgs(argv);
  const [verb, target] = pos;
  if (!verb || verb === 'help') return usage(verb ? 0 : 2);
  try {
    if (verb === 'init') {
      if (!target) throw new Error('init 要一个插件目录');
      return cmdInit(target, opt);
    }
    if (verb === 'keygen') {
      if (!target) throw new Error('keygen 要一个插件目录');
      return cmdKeygen(target, opt);
    }
    if (verb === 'build') {
      if (!target) throw new Error('build 要一个插件目录');
      return cmdBuild(target, opt);
    }
    if (verb === 'sign') {
      if (!target) throw new Error('sign 要一个包');
      return cmdSign(target, opt);
    }
    if (verb === 'verify') {
      if (!target) throw new Error('verify 要一个包');
      return cmdVerify(target, opt);
    }
    if (verb === 'inspect') {
      if (!target) throw new Error('inspect 要一个包');
      return cmdInspect(target, opt);
    }
    throw new Error(`不认识的动词 ${verb}`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  MAGIC, FORMAT, HEADER_BYTES, SIG_BYTES, SIG_ALG_ED25519, R,
  COPY_SKIP, PLUGIN_VERSION_RE, FRAMEWORK_VERSION_RE, ULID_RE, LINEAGE_FILE,
  LINEAGE_SCHEMA, enginesShapeProblem,
  checkRelPath, foldAscii, contentDigest, sortByPathBytes,
  buildPackage, parsePackage, fingerprint, verifyEd25519,
  mintUlid, insertId, replaceId,
  packerHome, keyFilePath, releasesPath, rawPubOf, saveKey, loadKey,
  readLineage, lineageEntry, writeLineage, lineageEntryOfPackage,
  readReleases, writeReleases,
  ED25519_SPKI_PREFIX,
};
