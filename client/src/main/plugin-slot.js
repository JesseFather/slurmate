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
 * plugin-slot.js —— 池里一个**槽位**：一棵树，加一张记录表。
 *
 * ── 形状 ────────────────────────────────────────────────────────────────────
 *
 *   <站点池>/<id>_<版本>/        解出来的树 —— `require()` 用的是它
 *   <站点池>/<id>_<版本>.json    记录表 —— 这一份的**提交点**
 *
 * ── ★ 容器是运输形状，不是存储形状 ──────────────────────────────────────────
 *
 * 装完之后盘上**没有** `.splug`：它的两个用处（把字节从作者运到站点、从站点运到
 * 这里）都发生在别的时刻。留下的必须是一棵能直接 `require()` 的树，加一张能回答
 * "这一份该是什么"的记录表。
 *
 * ── ★ 记录表 = 提交点（与站点侧同一条规则，方向相反）──────────────────────
 *
 * 目录**没有**原子的替换原语（`rename` 的目标是非空目录时 `ENOTEMPTY`），所以
 * 把原子性缩小到"最后原子地写记录表"这一格，与数据库的 commit record 同形：
 *
 *   **树在、记录表不在 ⇒ 这一次安装没提交 ⇒ 不可见，下一轮清掉重取。**
 *
 * ★ 而**没有记录表的目录怎么处理，两端方向相反**，这是刻意的（见 site-plugins.js
 *   里 `sweepPool` 那段）：这里是**我们自己的池**，唯一的写方是安装器，所以那种
 *   目录一定是"我们自己崩在中间"留下的 —— 清掉；站点那一边同样一棵没记录的树，
 *   却可能是管理员手放的东西 —— **只报不删**。★ 下一个人会想"顺手统一一下"，
 *   而统一的方向一定是删掉别人的东西。
 *
 * ── 记录表里那两样为什么是这两样 ────────────────────────────────────────────
 *
 *   · `envelope` = 容器里那个签名块的**逐字保留**（验签要它一字不改）；
 *   · `files`    = 逐份真相，**保留容器里的次序**。
 *
 * ★ **内容摘要是派生值，不存** —— 每次从 `files`（或者干脆从树上）重算。存下来
 *   的那个摘要与 `files` 里的 sha256 一旦不符，判据就成了"以哪个为准"。
 *
 * ★ **次序留着**照站点侧同一条理由：从记录表重新打一个包必须是**逐字节**重现
 *   原件（§3.5）。客户端今天不重打包，但两端同形这件事本身就是判据 —— 形状一样
 *   的两张表，才可能用同一段代码去读、去比、去对着它说"这就是作者发的那一份"。
 *
 * ── 这个模块**是叶子** ──────────────────────────────────────────────────────
 *
 * 它只 require `fs` / `path` / 原子写 / `plugins/ulid.js`。**不许** require
 * `plugins/index.js` 或 `site-plugins.js`：那两个模块都要用它来认槽位，反过来的
 * 依赖会构成一个环，而 Node 的环在这种形状下会静默地给出**半加载的 exports**
 * （现象是一个 `undefined is not a function`，出现在一个看起来毫无关系的地方）。
 */

const fs = require('fs');
const path = require('path');
const atomicWrite = require('./atomic-write.js');
const ulid = require('./plugins/ulid.js');

/** 槽位名里 id 与版本之间那一个字符。★ ULID 的字符集里没有它，所以切在第一个就是唯一的切法。 */
const SLOT_SEP = '_';
/** 记录表的后缀。★ 与站点侧那一个**逐字相同**（`PLUGIN_RECORD_SUFFIX`）。 */
const RECORD_SUFFIX = '.json';
/** 记录表的版本。读到一个不认识的值 ⇒ **拒绝**（那是"写它的东西比这个客户端新"）。 */
const RECORD_SCHEMA = 1;

/**
 * 一张记录表最多多少字节。
 *
 * ★ **它是推出来的，不是挑出来的**：记录表里每一份只带 `path`+`size`+`sha256`，
 *   而这三样在它来源的那个包的信封里**逐字都有**、还外加了内容本身 ⇒ 一张记录表
 *   永远比它来源的那个包小。包的上限是 `HARD_LIMITS.package_bytes`（4 MiB），
 *   所以这个数取一样大就够了。
 *
 * ★ 为什么要有它：记录表是**磁盘上的 JSON**，而这个函数会 `JSON.parse` 整份。
 *   今天那条 `readPackageFile` 的路同样没有大小闸（它 `readFileSync` 一个文件），
 *   所以这不是"补上一个新洞"，是**别让 JSON 这条更容易撑大的路比它更松**。
 */
const MAX_RECORD_BYTES = 4 << 20;

/**
 * 名字里的一段能不能用。
 *
 * ★ 这是**文件名安全**，不是任何语法判据 —— 版本号的形状（`x.y.z`）由协议边界与
 *   清单校验判（`VERSION_RE`），两者是两件事，别合并：合并的那天，"一个语法上
 *   合法的版本号在某个平台上不是一个合法的文件名"会变成一个没人看得懂的拒绝。
 */
function usablePart(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 64
    && !s.includes('/') && !s.includes('\\') && !s.includes('\0')
    && !s.startsWith('.');
}

/**
 * 一个槽位叫什么。★ id 不是 ULID、或者版本那一段不是一个能当文件名的串 ⇒ `null`。
 *
 * ★ **名字安全不是靠过滤，是靠 id 的形状本身**：`isId` 要的是 26 个 ULID 字符，
 *   里面既没有 `/` 也没有 `.` —— 于是 `../..` 这类东西**根本进不来**。过滤只能
 *   挡住想得到的那些拼法，而"名字必须由一段定长字母数字开头"是结构性的。
 */
function slotNameOf(id, version) {
  return ulid.isId(id) && usablePart(version) ? `${id}${SLOT_SEP}${version}` : null;
}

/** 反过来：一个槽位名说的是哪一份。认不出来返回 `null`（**不猜**）。 */
function parseSlotName(name) {
  // ★ 记录表那个后缀是**保留的**：池里的名字只有两种形状（`<id>_<版本>` 与
  //   `<id>_<版本>.json`），而一个**树目录**的名字不许长成记录表的样子。不挡它的话
  //   `01H...._1.0.0.json` 会被读成"id=01H…，版本=1.0.0.json"——一个永远不成立的
  //   槽位，而它旁边的记录表会被当成一个来历不明的文件报出去。
  if (typeof name !== 'string' || name.endsWith(RECORD_SUFFIX)) return null;
  return splitSlot(name);
}

/** 一个记录表文件名说的是哪一份。认不出来返回 `null`。 */
function parseRecordName(name) {
  if (typeof name !== 'string' || !name.endsWith(RECORD_SUFFIX)) return null;
  return splitSlot(name.slice(0, -RECORD_SUFFIX.length));
}

/** 切一刀：`<id>_<版本>`。**两个调用方共用这一处**，所以"怎么切"只有一份实现。 */
function splitSlot(name) {
  const i = name.indexOf(SLOT_SEP);
  if (i <= 0) return null;
  const id = name.slice(0, i);
  const version = name.slice(i + 1);
  if (!ulid.isId(id) || !usablePart(version)) return null;
  return { id, version };
}

/** 池里那一棵树在哪。★★ 名字建不出来时**返回 `null`** —— 调用方据此拒绝，绝不拼半个路径。 */
function treeDirOf(poolRoot, id, version) {
  const n = slotNameOf(id, version);
  return n ? path.join(poolRoot, n) : null;
}

/** 池里那一张记录表在哪。同样可能返回 `null`。 */
function recordPathOf(poolRoot, id, version) {
  const n = slotNameOf(id, version);
  return n ? path.join(poolRoot, n + RECORD_SUFFIX) : null;
}

/**
 * 一次 `parsePackage()` 的结果 → 一份可以落盘的记录表。
 *
 * `files` **保留容器里的次序**（见文件头）。`size` 原样带着 —— 解析器给的可能是
 * BigInt，`JSON.stringify` 对它**抛**，所以这里显式转成数（`parsePackage` 已经把
 * 每个 size 夹在 `Number.MAX_SAFE_INTEGER` 之内了，超了它当场就拒）。
 */
function recordFromPackage(parsed) {
  return {
    schema: RECORD_SCHEMA,
    format: parsed.format,
    envelope: envelopeOfPackage(parsed.sig),
    files: parsed.files.map((f) => ({
      path: f.path, size: Number(f.size), sha256: f.sha256,
    })),
  };
}

/**
 * 容器里那个签名块 → 记录表里那个 `envelope`（没有签名时是 `null`）。**逐字保留**。
 *
 * ★ 这块盖的是**四元组**（`{id, 版本, digestSite, digestClient}`），所以
 *   记录表里也就多出那四个字段。★ 它们**逐字保留**，不是"重算一遍存下来"——
 *   验签要的正是作者签的那几个字节，重算出来的只是"我以为它该是什么"。
 *   两者的差别就是这一版全部意义所在（见 site-plugins.js 的 `treeSignature`）。
 */
function envelopeOfPackage(sig) {
  if (!sig) return null;
  return {
    alg: sig.alg,
    pubkey: Buffer.from(sig.pubkey).toString('base64'),
    signature: Buffer.from(sig.signature).toString('base64'),
    id: sig.id,
    version: sig.version,
    digestSite: sig.digestSite,
    digestClient: sig.digestClient,
  };
}

/**
 * 一张记录表**形状**对不对。返回 `null`（可以）或一句为什么。
 *
 * ★ 只判**结构**：`alg` 是不是 1、那两段 base64 解出来是不是 32/64 字节、签名
 *   验不验得过 —— 那些要认识**容器**（`SIG_MIN_BYTES` / `SIG_ALG_ED25519`），而认识
 *   容器的那个模块在依赖图**上面**（见文件头）。所以这个模块回答"这是不是一张
 *   记录表"，`site-plugins.js` 的 `recordSig` 回答"这张表里的签名我认不认得"。
 *   两句不同的话，两个不同的地方 —— 合并只能靠把这个常量抄一份到这里。
 */
function recordProblem(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return '最外层不是一个 JSON 对象';
  if (rec.schema !== RECORD_SCHEMA) {
    return `schema = ${JSON.stringify(rec.schema)}，本实现只认识 ${RECORD_SCHEMA}（写它的东西比这个客户端新？）`;
  }
  if (!Number.isInteger(rec.format) || rec.format < 1) {
    return `format = ${JSON.stringify(rec.format)}，不是正整数`;
  }
  if (rec.envelope !== null && rec.envelope !== undefined) {
    const e = rec.envelope;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return 'envelope 既不是 null 也不是一个对象';
    if (!Number.isInteger(e.alg)) return 'envelope.alg 不是整数';
    for (const k of ['pubkey', 'signature', 'id', 'version']) {
      if (typeof e[k] !== 'string' || !e[k]) return `envelope.${k} 不是一个非空字符串`;
    }
    for (const k of ['digestSite', 'digestClient']) {
      if (typeof e[k] !== 'string' || !/^[0-9a-f]{64}$/.test(e[k])) {
        return `envelope.${k} 不是 64 位小写十六进制`;
      }
    }
    for (const k of Object.keys(e)) {
      if (!['alg', 'pubkey', 'signature', 'id', 'version',
        'digestSite', 'digestClient'].includes(k)) {
        return `envelope 里有认不得的键：${k}`;
      }
    }
  }
  if (!Array.isArray(rec.files) || !rec.files.length) return 'files 必须是一个非空数组';
  for (let i = 0; i < rec.files.length; i++) {
    const f = rec.files[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) return `files 的第 ${i} 条不是一个对象`;
    if (typeof f.path !== 'string') return `files 的第 ${i} 条缺 path`;
    if (!Number.isInteger(f.size) || f.size < 0) return `${JSON.stringify(f.path)}：size 不是非负整数`;
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) {
      return `${JSON.stringify(f.path)}：sha256 不是 64 位小写十六进制`;
    }
    for (const k of Object.keys(f)) {
      if (!['path', 'size', 'sha256'].includes(k)) return `${JSON.stringify(f.path)}：多了一个认不得的键 ${k}`;
    }
  }
  return null;
}

/**
 * 读一张记录表。**读不动不抛**，返回 `{ok:false, why}`。
 *
 * ★ 与站点侧那份实现同一个态度：调用方（对账、界面）要能把"这一份安装不成立"
 *   当成一个**正常结果**处理。抛出去的话，一个坏掉的记录表会把整个站点的插件
 *   对账带走 —— 而它本来只是"这一个插件不可用"。
 */
function readRecordFile(file) {
  const bad = (why) => ({ ok: false, why });
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return bad(`读不到 ${file}：${e.message}`);
  }
  if (st.size > MAX_RECORD_BYTES) {
    return bad(`记录表 ${file} 有 ${st.size} 字节，超过上限 ${MAX_RECORD_BYTES}（见 MAX_RECORD_BYTES）`);
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return bad(`读不到 ${file}：${e.message}`);
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch (e) {
    return bad(`${file} 不是合法的 JSON：${e.message}`);
  }
  const problem = recordProblem(rec);
  if (problem) return bad(`${file}：${problem}`);
  return { ok: true, record: rec };
}

/**
 * 原子地写一张记录表 —— **这一写就是"提交"**。
 *
 * `atomic-write.js` 是框架里唯一那份"临时文件 → rename"的实现。这里不另写一遍：
 * 记录表能当提交点，**靠的就是那一次 rename 是原子的**，所以它必须与别处同源。
 * 写不下去时返回结构化结果，**不抛**（要不要变成异常是调用方的策略）。
 *
 * ★ `JSON.stringify` 那一步也包在里面：它在**写之前**，而"记录表序列化不了"同样是
 *   "提交没发生"。不包的话它会从一个**不抛**的函数里抛出去 —— 调用方按契约不写
 *   try/catch，于是异常一路穿到最外面，而池里那棵树已经 `rename` 进去了。
 */
function writeRecordFile(file, record) {
  let text;
  try {
    text = JSON.stringify(record, null, 2) + '\n';
  } catch (e) {
    return { ok: false, error: 'bad_record', detail: `记录表序列化不了：${e.message}` };
  }
  return atomicWrite.writeAtomic(file, text, { mode: 0o600 });
}

/** 删一张记录表。**尽力而为**：它已经不在了也算成功（撤回一个不存在的提交是空操作）。 */
function removeRecordFile(file) {
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, error: e.message };
  }
  return { ok: true };
}

module.exports = {
  SLOT_SEP, RECORD_SUFFIX, RECORD_SCHEMA, MAX_RECORD_BYTES,
  slotNameOf, parseSlotName, parseRecordName,
  treeDirOf, recordPathOf,
  recordFromPackage, envelopeOfPackage, recordProblem,
  readRecordFile, writeRecordFile, removeRecordFile,
};
