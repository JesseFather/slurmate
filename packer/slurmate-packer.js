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
 * ★ **单文件、零依赖**：只用 `crypto` / `fs` / `path` / `child_process`。
 *   下载这个文件夹就能用（`node slurmate-packer.js …`）。所以它**不**从
 *   `client/` 里 import 任何东西 —— 那会让"下载这个文件夹"变成"下载整个仓库"。
 *   代价是几处常量在这里有第二份（跳过表、版本号形状），
 *   由 `.github/workflows/checks.yml` 里的 lint 与 `tools/conformance/` 的向量钉住。
 *
 * ── 四个动词 ────────────────────────────────────────────────────────────────
 *
 *   init    铸一个 id（只在源码树里没有的时候）并**插入**写回 plugin.json
 *   build   从一个**提交**打出一个 `.splug`
 *   verify  校验一个 `.splug`：逐份字节、内容摘要、签名
 *   inspect 把人该看的东西打出来（作者拿它对着规范逐行核对）
 *
 * ★ **`init` 与 `build` 是两个动词，不能合并。** 铸 id 会弄脏源码树（§2.1 要求
 *   写回），而 §3.5 要求打包的输入是一个**干净的提交** —— 一条命令做完两件事
 *   必然自相矛盾。所以：`init` 只铸 id 并把树弄脏，然后**停下来让你提交**。
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
  // ★ **在这里排序**，不是在调用方。记录表里那 11 条的次序是**别人给的**：
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
//  四个动词
// ==============================================================================

function cmdInit(dir) {
  const mfFile = path.join(dir, MANIFEST);
  const { text, obj } = readManifest(mfFile);
  if (Object.prototype.hasOwnProperty.call(obj, 'id')) {
    if (!ULID_RE.test(String(obj.id))) {
      throw new Error(`plugin.json 里的 id ${JSON.stringify(obj.id)} 不是一个 ULID（26 个 Crockford base32 字符）。\n`
        + '  §2.1：id 铸一次、此后永不改变。要换 id 就是铸一个新的（§2.5 的分身），不是改一个字符。');
    }
    console.log(`这个插件已经有 id 了：${obj.id}`);
    console.log('  §2.1：id 铸一次、此后永不改变。什么都不做。');
    return 0;
  }
  const repo = repoRootOf(dir);
  const rel = relToRepo(repo, dir);
  ensureClean(repo, rel);                       // §2.1「应当拒绝在源码树不干净时铸 id」

  const id = mintUlid();
  fs.writeFileSync(mfFile, insertId(text, id), 'utf8');
  console.log(`铸了一个 id 并写回 ${path.join(rel || '.', MANIFEST)}：`);
  console.log(`    ${id}`);
  console.log('');
  console.log('★ 写回是**插入**一行，不是重新序列化整份 JSON —— 其余字节一个都没动。');
  console.log('★ 树现在是脏的，而且**必须脏**：请先提交，再 `build`。');
  console.log('  §3.5 要求打包的输入是一个提交，所以这两个动词不能合并成一条命令。');
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
  if (!ULID_RE.test(String(manifest.id || ''))) {
    throw new Error(`${MANIFEST} 里的 id ${JSON.stringify(manifest.id)} 不是一个 ULID —— 先跑 init（§2.1）`);
  }
  if (!PLUGIN_VERSION_RE.test(String(manifest.version || ''))) {
    throw new Error(`${MANIFEST} 里的 version ${JSON.stringify(manifest.version)} 不合 x.y.z 的形状（§2.3）`);
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

  const pkg = buildPackage(files);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, pkg);

  console.log(`打好了：${out}`);
  console.log(`  id       ${manifest.id}`);
  console.log(`  名字     ${manifest.name}（${manifest.displayName}）`);
  console.log(`  版本     ${manifest.version}`);
  console.log(`  内容摘要 ${contentDigest(files)}`);
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
    console.log(JSON.stringify({
      ok: true,
      format: r.format,
      bytes: buf.length,
      digest: r.digest,
      manifest: r.manifest,
      sig: r.sig ? { alg: 'Ed25519', fingerprint: r.sig.fingerprint } : null,
      files: r.files.map((f) => ({ path: f.path, size: Number(f.size), sha256: f.sha256 })),
    }, null, 2));
    return 0;
  }
  const r = parsePackage(buf);
  if (!r.ok) {
    console.error(`✗ 这个包不合规（${r.code}）—— ${r.why}`);
    return 1;
  }
  console.log(`${file}`);
  console.log(`  容器     format ${r.format}，${humanBytes(buf.length)}`);
  console.log(`  内容摘要 ${r.digest}`);
  console.log(`  签名     ${r.sig ? `Ed25519，签名者 ${r.sig.fingerprint}` : '（没有）'}`);
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
  node slurmate-packer.js init    <插件目录>
  node slurmate-packer.js build   <插件目录> [--commit <ref>] [--out <文件>]
  node slurmate-packer.js verify  <包> [--expect-digest <hex>] [--expect-signer <指纹>]
                                       [--against <插件目录>[@<ref>]]
  node slurmate-packer.js inspect <包> [--json]

  init     铸一个 id（只在树里没有的时候）并**插入**写回 plugin.json。
           它会弄脏树，所以它之后要你自己提交 —— 与 build 分成两个动词是故意的。
  build    从一个**提交**打出 .splug。工作树脏时拒绝（§3.5）。
  verify   逐份校字节、算内容摘要、验签。--against 顺带判 §3.6。
  inspect  打出包里到底有什么 —— 作者拿它对着规范逐行核对。

规范：docs/PLUGIN-SPEC.md（尤其 §2、§3、附录 A）。`);
  return code;
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opt.json = true;
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
      return cmdInit(target);
    }
    if (verb === 'build') {
      if (!target) throw new Error('build 要一个插件目录');
      return cmdBuild(target, opt);
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
  COPY_SKIP, PLUGIN_VERSION_RE, ULID_RE,
  checkRelPath, foldAscii, contentDigest, sortByPathBytes,
  buildPackage, parsePackage, fingerprint, verifyEd25519,
  mintUlid, insertId,
};
