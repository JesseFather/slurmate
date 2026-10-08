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
 * plugin-package.js —— 读一个 `.splug`。
 *
 * ── 它是什么 ────────────────────────────────────────────────────────────────
 *
 * 严格解析容器（packer/docs/PLUGIN-SPEC.md 附录 A）、**逐份用记录里的 sha256 校字节**、
 * 算内容摘要（§3.4）、验签（§4.2）。它**不执行任何东西**，也**不落盘** ——
 * 把负载写出来是调用方的事，那一步要与同意闸绑在一起（§5.2）。
 *
 * ★ 它还带着 `keyVerdict` —— §5.4 那条"签名者与钉住的那一把是不是同一把"。
 *   它判、**不写**：钉住发生在用户点同意的那一刻（调用方 `config.js` 的
 *   `pinPluginKey`）。这两个函数的**判据与写点分开**是故意的，见 `keyVerdict` 的注释。
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
 *
 * ── 谁在用这一份 ────────────────────────────────────────────────────────────
 *
 *   `site-plugins.js`  —— **唯一**的读者。站点分发那条路上 `plugin_package` 取回来
 *                      的字节在这里解析、验签、重算摘要，再 `unpackTo` 铺成树
 *                      （见那边的 fetchPackage）。
 *                       ★ 而**解析完就丢**：容器不落盘，留在盘上的是树加
 *                       一张记录表（`plugin-slot.js`）。
 *
 * ★ `keyVerdict`（§5.4 那三个判词）**是唯一的判据**，每一个包都过钉子：钉子防的
 *   是"远端把一个 id 换成别人做的构件"，而"用户自己在自己机器上挑了一个文件"钉不住
 *   （他本来就能改这台机器上的任何东西）。既然**每一份构件都是从远端来的**，
 *   就没有哪一条路能绕过钉子。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const plugins = require('./plugins/index.js');
const sitePlugins = require('./site-plugins.js');
// ==============================================================================
//  容器常量（附录 A）
// ==============================================================================

/** 8 字节。末三字节是 `\x1a\r\n` —— 让文本工具一眼看出"这是二进制"。 */
const MAGIC = Buffer.from('splug\x1a\r\n', 'latin1');
/** 本实现认识的容器格式版本。别的值 ⇒ **拒绝**（客户端那一态叫"站点太新"）。 */
const FORMAT = 2;
const HEADER_BYTES = 20;
const SIG_ALG_ED25519 = 1;
/** 签名块的**定长头**：`alg u8 | 公钥 32 | 签名 64`。 */
const SIG_PREFIX_BYTES = 1 + 32 + 64;
/** 块里的 `id`：**26 个 ASCII 字节**（一个 ULID 的写法）。 */
const SIG_ID_BYTES = 26;
/** `id` 之后那一段的**定长部分**：`verlen u8 | digestSite 32 | digestClient 32`。 */
const SIG_TAIL_BYTES = 1 + 32 + 32;
/**
 * 签名块的长度 = `SIG_MIN_BYTES + verlen`，而 `verlen` 是一个 **u8**：
 * 最短 **188** 字节，最长 **443**（`188 + 255`）。
 *
 * ★ 那两端的数由 `tools/plugin-limits.json` 的 `signature_max_bytes` 与 CI 的 lint
 *   在**三侧之间**钉着；这个模块自己只用到 `SIG_MIN_BYTES`（判长度）与
 *   `MAX_VERSION_BYTES`（判版本号放不放得下），所以只导出这两个 ——
 *   "一个没人读的导出就是一句没人守的承诺"。
 */
const SIG_MIN_BYTES = SIG_PREFIX_BYTES + SIG_ID_BYTES + SIG_TAIL_BYTES;
const MAX_VERSION_BYTES = 255;
/** Ed25519 裸公钥的 SPKI 前缀 —— Node 只认 DER。12 字节，与打包器那一份逐字相同。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const MANIFEST = 'plugin.json';
/** 血统表。与 `plugin.json` 一样**两侧都在**（见 site-plugins.js 的 `isClientSidePath`）。 */
const LINEAGE_FILE = 'lineage.json';

/** §3.3 的深度上限。与 site-plugins.js 的 `HARD_LIMITS.max_depth` 是同一个数。 */
const MAX_DEPTH = 8;

// ── ★ 这个读方**不**执行"单文件多少字节 / 一共几份"那三个上限 ──────────────
//
// 那三个数在**协议**里是站点自述的 `limits`。包模式下它们变成**负载内**规则：
// 由打包器与**调用方**执行（`site-plugins.js` 的 `fetchPackage` 拿包里的记录去走
// `checkDeclared` —— 与逐份那条路**同一个函数**），不再需要走线。
//
// ★ 为什么不在**这里**执行：这一层只回答"这些字节是不是一个合规的包"，而"这个
//   站点发的东西我收不收得下"是调用方的 DoS 护栏（`HARD_LIMITS` 与站点自述两者
//   取更严）。两件事混在一起，`parsePackage` 就会需要一个它不该知道的参数。
//
// ★ 而这一层不吃它们**不是**一个敞口：`file_count` 被长度方程夹住了（每条记录至少
//   42 字节，整张记录表必须放得进这个文件），真正需要"份数上限"的是**收下来的包
//   文件**有多大 —— 那是链路约束，跟着 `package_bytes` 一起判。

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

/**
 * §5.4 那三个判词。★ 它们**不是** `R` 里那九个 —— 那些是**格式**的理由
 * （包本身合不合规），这三个是**信任**的理由：包可以完全合规，而这一份不能收。
 * 混在一起会让"这个包坏了"与"这个包换人了"看起来是同一件事。
 */
const PIN = {
  UNSIGNED: 'unsigned',   // 钉过密钥，而这一份**没有签名**
  CHANGED: 'changed',     // 签名者换了人
  BROKEN: 'broken',       // 钉子表里那一条读不出来 —— 一律拒绝（见 config.js 那段）
};

/**
 * §5.4：这个包的签名者，与本机钉住的那一把是同一把吗。
 *
 * `pinned` 是 `config.js` 的 `pinnedKeyOf(pins, id)`：**`undefined` = 从没钉过**
 * （首次即信任），其余一律是"钉过、值是这个"—— 其中**不是全长十六进制的那些**
 * 表示那条记录读不动（见下）。
 *
 * 返回 `{ok:true, first, fingerprint}` 或 `{ok:false, code, pinned, got, why}`。
 * ★ `why` 是**给用户看的那句话**的原材料：它必须把两把指纹都说出来（§5.4），
 *   而且要能直接放进同意界面 —— 另写一套文案迟早与这里的判据分家。
 *
 * ★ 首次即信任（`first:true`）：调用方在这时**才**该 `pinPluginKey`。这里只判，
 *   不写 —— 写的时机与同意闸绑在一起（§5.2：先写台账、后激活）。
 *   而 `first` 时 `fingerprint` 可能是 `null`（这一份没签名）：那就**什么都不钉**，
 *   于是一个作者"先发不带签名的版本、后来开始签"不会被这里拒绝 —— 该被拒绝的是
 *   反过来的顺序（钉过之后又收到不带签名的）。
 */
function keyVerdict(pinned, pkg) {
  const got = (pkg && pkg.sig) ? pkg.sig.fingerprint : null;
  if (pinned === undefined || pinned === null) {
    return { ok: true, first: true, fingerprint: got };
  }
  if (!/^[0-9a-f]{64}$/.test(pinned)) {
    return {
      ok: false,
      code: PIN.BROKEN,
      pinned,
      got,
      why: '这个 id 的钉子读不出来（`pinned-keys.json` 里那一条的指纹不是全长十六进制）。'
        + '一条读不动的钉子只能往拒绝那一侧倒 —— 把它当成"没钉过"就等于静默地'
        + '重新"首次即信任"一次，而那正是 §2.5 的分身判定要挡的事。',
    };
  }
  if (!got) {
    return {
      ok: false,
      code: PIN.UNSIGNED,
      pinned,
      got: null,
      why: `这个 id 你以前同意过一份**带签名**的构件（签名者 ${pinned}），`
        + '而这一份没有签名。§5.4：此后这个 id 的每一份都必须由同一把钥匙签 ——'
        + '一份不带签名的构件没法证明它是同一个人做的，所以只能拒绝。',
    };
  }
  if (got === pinned) return { ok: true, first: false, fingerprint: pinned };
  return {
    ok: false,
    code: PIN.CHANGED,
    pinned,
    got,
    why: `这个 id 你以前同意的是 ${pinned} 签的，而这一份是 ${got} 签的。`
      + '内容可能与上次一模一样，但**签名的人换了** —— §5.4 要求这必须是同一个人。'
      + '（丢了私钥的作者只能给插件铸一个新 id，所以这不是一次正常的升级。）',
  };
}

/**
 * 那七个字段 → 一块签名块的字节（附录 A.3）。**`sign` 不用它**（客户端不签名），
 * 它服务的是**记录表那一条回路**：记录表里存的是拆开的字段，而形状判据必须与容器
 * 那一份**同一处实现**（`parseSigBlock`）—— 否则"什么算一块合法的签名块"就有了
 * 第二份说法，而两份漂开的方向是"一边收、一边拒"。
 *
 * ★ 拼不出来时**抛**（id 不是 26 字节、版本超过 255 字节）。调用方 `recordSig`
 *   把它折成 `{ok:false}` —— 那正是"这张记录表里的信封**被改过**"。
 */
function buildSigBlock(o) {
  const idb = Buffer.from(o.id, 'ascii');
  const ver = Buffer.from(o.version, 'utf8');
  if (idb.length !== SIG_ID_BYTES) throw new Error(`id 不是 ${SIG_ID_BYTES} 个 ASCII 字节`);
  if (ver.length > MAX_VERSION_BYTES) {
    throw new Error(`版本号超过 ${MAX_VERSION_BYTES} 字节，放不进签名块`);
  }
  const out = Buffer.alloc(SIG_MIN_BYTES + ver.length);
  out[0] = o.alg;
  Buffer.from(o.pubkey).copy(out, 1);
  Buffer.from(o.sig).copy(out, 33);
  idb.copy(out, 97);
  out[97 + SIG_ID_BYTES] = ver.length;
  ver.copy(out, 124);
  Buffer.from(o.digestSite, 'hex').copy(out, 124 + ver.length);
  Buffer.from(o.digestClient, 'hex').copy(out, 156 + ver.length);
  return out;
}

/**
 * 从一块签名块里取出那七个字段（附录 A.3）；不合形状返回 `null`。
 *
 * ```
 * alg u8(=1) ｜ pubkey 32 ｜ sig 64 ｜ id 26(ASCII) ｜ verlen u8 ｜ version ｜
 * digestSite 32 ｜ digestClient 32          长度 = 188 + verlen
 * ```
 *
 * ★ "不合形状"三种：长度不等于 `188 + verlen`、`alg` 认不得、`id`/`version` 那两段
 *   不是合法的 ASCII / UTF-8。★ 后两条靠**逐字节回比**判 —— 与路径那一条同源：
 *   `toString` 会把坏字节悄悄换成 U+FFFD，于是两端算的不是同一份东西。
 */
function parseSigBlock(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < SIG_MIN_BYTES) return null;
  if (buf[0] !== SIG_ALG_ED25519) return null;   // 认不得的算法**拒绝**，不忽略
  const verlen = buf[97 + SIG_ID_BYTES];
  if (buf.length !== SIG_MIN_BYTES + verlen) return null;
  const idRaw = buf.subarray(97, 97 + SIG_ID_BYTES);
  const id = idRaw.toString('ascii');
  if (!Buffer.from(id, 'ascii').equals(idRaw)) return null;
  const verRaw = buf.subarray(124, 124 + verlen);
  const version = verRaw.toString('utf8');
  if (!Buffer.from(version, 'utf8').equals(verRaw)) return null;
  const at = 124 + verlen;
  return {
    alg: buf[0],
    pubkey: buf.subarray(1, 33),
    sig: buf.subarray(33, 97),
    id,
    version,
    digestSite: buf.subarray(at, at + 32).toString('hex'),
    digestClient: buf.subarray(at + 32, at + 64).toString('hex'),
  };
}

/**
 * 被签的那串字节（附录 A.3）：
 *
 *     id(26) ‖ 0x00 ‖ version(verlen) ‖ 0x00 ‖ digestSite(32 原值) ‖ digestClient(32 原值)
 *
 * ★ 两个摘要是**原值**，不是十六进制写法。★ 两个 `0x00` 是**分隔符**：少了它们，
 *   `id` 与 `version` 的边界就成了"前 26 个字节"，一个改包的人可以把 id 末尾几个
 *   字节挪进 version 里，换出另一对 `(id, 版本)` 而两个 `0x00` 之外一字不改。
 */
function signedMessage(o) {
  return Buffer.concat([
    Buffer.from(o.id, 'ascii'), Buffer.from([0x00]),
    Buffer.from(o.version, 'utf8'), Buffer.from([0x00]),
    Buffer.from(o.digestSite, 'hex'), Buffer.from(o.digestClient, 'hex'),
  ]);
}

/**
 * 把一个负载**按侧**分成两半（§3.1 / §4.2）。
 *
 *   客户端侧 = `client/**` + `plugin.json` + `lineage.json`
 *   站点侧   = 其余全部
 *
 * ★ 与打包器那一份**同一条规则**（`sidesOf`），而且是**按顶层前缀**判的，不是
 *   "名字里有没有 client"：`clientfoo/x` 与 `a/client/x` 都不算客户端侧。
 * ★ 两个顶层元数据文件**两侧都在**，所以两侧**会重叠** —— 这是定义的一部分。
 */
function isClientSidePath(p) {
  return p.startsWith('client/') || p === MANIFEST || p === LINEAGE_FILE;
}

/** 分成两半，各自**保留原来的次序**。 */
function sidesOf(files) {
  return {
    site: files.filter((f) => !f.path.startsWith('client/')),
    client: files.filter((f) => isClientSidePath(f.path)),
  };
}

/** 两侧的内容摘要。空的那一侧 = `sha256("")`，**有定义**（§3.1 允许某一侧为空）。 */
function sideDigests(files) {
  const s = sidesOf(files);
  return { site: contentDigest(s.site), client: contentDigest(s.client) };
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

  // 10 有签名块。**四小步，次序是规范的一部分**（附录 A.4）：
  //    ① 形状 ② 身份（块里的 id/版本 vs 清单）③ 内容（重算的侧摘要 vs 块里那两个）
  //    ④ 密码学（验签）。①③④ 报 `signature`，②报 `manifest`。
  //
  //    ★ ② 在 ③ 前面：`id`/`version` 是"这个包**是**什么"，摘要是"它**装着**什么"。
  //      一个自己都没说清是什么的包，先说"哪一份文件对不上"是把人往错的方向带。
  let sig = null;
  if (sigLen !== 0) {
    const parsed = parseSigBlock(buf.subarray(off, off + sigLen));
    // ① 形状
    if (!parsed) {
      return bad(R.SIGNATURE,
        `签名块 ${sigLen} 字节，不是一个合法的 Ed25519 签名块`
        + `（本格式是 ${SIG_MIN_BYTES}+版本号 字节、alg=1）`);
    }
    // ② 身份：块里的 id/版本必须与清单**逐字**相同。逐**字节**比，不比字符串。
    if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string'
        || !Buffer.from(manifest.id, 'utf8').equals(Buffer.from(parsed.id, 'ascii'))
        || !Buffer.from(manifest.version, 'utf8').equals(Buffer.from(parsed.version, 'utf8'))) {
      return bad(R.MANIFEST,
        `签名块说这一份是 ${JSON.stringify(parsed.id)}@${JSON.stringify(parsed.version)}，`
        + `而负载里那份 ${MANIFEST} 说是 ${JSON.stringify(manifest.id)}@${JSON.stringify(manifest.version)}`
        + ' —— 同一个包里两处说了两个身份');
    }
    // ③ 内容：**这个包里在的那几侧**，从它们的字节重算 §3.4 摘要，与块里那两个比。
    //    ★ 客户端侧**永远在**（`plugin.json` 是它的一员，第 9 步保证它在）⇒ 那一边
    //      永远核。站点侧在不在，由"包里有没有一条**只属于站点侧**的路径"决定 ——
    //      这正是"同一个内容、两个包"（§4.2）那一格：只发客户端侧的那个包里没有
    //      `job/**`，于是它核不了、也不必核 `digestSite`。
    const sd = sideDigests(files);
    const sitePresent = files.some((f) => !isClientSidePath(f.path));
    if (sd.client !== parsed.digestClient) {
      return bad(R.SIGNATURE,
        `这一份的客户端侧算出来的内容摘要是 ${sd.client}，而签名块里写的是 `
        + `${parsed.digestClient} —— 签名盖的不是这些字节`);
    }
    if (sitePresent && sd.site !== parsed.digestSite) {
      return bad(R.SIGNATURE,
        `这一份的站点侧算出来的内容摘要是 ${sd.site}，而签名块里写的是 `
        + `${parsed.digestSite} —— 签名盖的不是这些字节`);
    }
    // ④ 验签：盖的是**四元组**那串字节，不是某一个摘要。
    if (!verifyEd25519(parsed.pubkey, signedMessage(parsed), parsed.sig)) {
      return bad(R.SIGNATURE,
        `签名验不过 —— 它盖的必须是 ${JSON.stringify(parsed.id)}@${JSON.stringify(parsed.version)}`
        + ' 这四个东西（A.3），而这一块盖的不是它。'
        + `签的人是 ${fingerprint(parsed.pubkey)}`);
    }
    sig = {
      alg: parsed.alg,
      pubkey: Buffer.from(parsed.pubkey),
      // ★ 那 64 个字节本身也要带出来：调用方要把它**逐字**存进记录表
      //   （`envelope.signature`），而"重新验一次"要的正是原件。
      signature: Buffer.from(parsed.sig),
      id: parsed.id,
      version: parsed.version,
      digestSite: parsed.digestSite,
      digestClient: parsed.digestClient,
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
 * 把解析出来的负载**写到磁盘上**。
 *
 * ★ 这是这个模块里**唯一**落盘的地方，而且它是给调用方用的 —— 上面那句"它不落盘"
 *   说的是解析本身。放在这里而不是各调用方自己写，理由是"把字节铺成一棵树"这条
 *   规则要有**一份实现**：权限位（`0644`）在这里定死，而权限位**进摘要** ——
 *   两份实现漂开的那天，同一份内容会在两台机器上算出两个摘要。
 *
 * ★ **不跟随、不链接、不建空目录**：格式里就没有这些东西（附录 A），所以这里
 *   只有普通文件与 `mkdir -p`。
 *
 * ★ 它还**拒收站点侧**（拒绝，不是过滤）—— 站点发给客户端的只该
 *   是客户端侧（`client/**` + `plugin.json` + `lineage.json`）。理由写在函数里。
 *
 * ★ 调用方**必须**在写完之后从磁盘读回来再核一遍（`plugins.readPluginFiles` 与
 *   记录表逐份比，见 `site-plugins.js` 的 `treeFault`）—— "校验我收到的"不等于
 *   "校验我写下的"，磁盘满的时候 `writeFileSync` 会留下半份文件然后抛错。
 *
 *   ★ 这条做法是**更强**的那一种：它比的是"我写下的那棵树是不是这一份构件"，
 *     而不是"包里的字节对不对"。容器不落盘（池里只有树 + 记录表），所以也只有
 *     这一种做法。
 */
function unpackTo(parsed, buf, dir) {
  // ★★ **包里不许出现站点侧路径**。
  //
  //   这是"用户机器上不该有站点端代码"这句话的**可执行形式**，也是它的回归测试。
  //   站点侧里有 `job/start.sh` 之类 —— 一份以**提交者本人**的身份在集群上执行的
  //   脚本。它会跑在谁的账号下，就决定了它有多不该躺在别人家的笔记本里。
  //
  //   ★ 它**不是**"过滤器"，是**断言**：判到了就拒掉**整份**，而不是把那几份跳过。
  //     跳过的做法会把"有人在中间塞了东西"变成"安静地少装了几份"，而客户端手里
  //     那一份构件于是与签名说的不是同一份东西了 —— 那正是最该响的时候。
  //   ★ 也不能靠"站点不会那么干"：站点是本机之外的另一个信任域，而这一条是客户端
  //     **自己**能判的、不依赖任何一方守规矩的那一条。
  const strays = parsed.files.filter((f) => !isClientSidePath(f.path));
  if (strays.length) {
    return { ok: false, why:
      `这一份包里带着站点侧的路径（${strays.map((f) => f.path).slice(0, 3).join('、')}`
      + `${strays.length > 3 ? ` 等 ${strays.length} 份` : ''}）—— `
      + '客户端只该收到客户端侧（`client/**` + `plugin.json` + `lineage.json`）。'
      + '整份拒收：站点侧代码不该到这台机器上，而"少装几份"会让本机这一份'
      + '与签名说的不是同一份构件。' };
  }
  try {
    for (const f of parsed.files) {
      const full = path.join(dir, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
      fs.writeFileSync(full, dataOf(buf, f), { mode: 0o644 });
      // 显式 chmod：writeFileSync 的 mode 会被 umask 削，而**摘要里有权限位**。
      try { fs.chmodSync(full, 0o644); } catch { /* Windows */ }
    }
  } catch (e) {
    return { ok: false, why: `写到 ${dir} 失败：${e.message}` };
  }
  return { ok: true };
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
  MAGIC, FORMAT, HEADER_BYTES, SIG_ALG_ED25519, MAX_DEPTH, MANIFEST, LINEAGE_FILE, R, PIN,
  SIG_MIN_BYTES, MAX_VERSION_BYTES,
  contentDigest, isClientSidePath, sidesOf, sideDigests,
  parsePackage, dataOf, readPackageFile, unpackTo,
  parseSigBlock, buildSigBlock, signedMessage, fingerprint, verifyEd25519, keyVerdict,
};
