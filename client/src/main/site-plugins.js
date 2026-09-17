'use strict';
/**
 * site-plugins.js —— 站点分发：把站点声明要分发的插件，一份一份取到本机。
 *
 * ── 它要保证的只有一件事，而那件事不是「一次连上必定装全」 ──────────────────
 *
 * 网络会断、磁盘会满、管理员会中途改配置 —— 「必定装全」做不到，任何声称做到的
 * 实现都只是在掩盖失败。能保证的是这个项目一路在清的那一类问题：
 *
 *   **绝不谎报成功。** 任何一份文件没到手或对不上，这一次分发就报失败；
 *   而报成功的时候，磁盘上的内容**按字节**就是站点那一份。
 *
 * 四条性质合起来：① 逐文件按 sha256 校验；② 换入原子（暂存 + `rename`）；
 * ③ 幂等，重试安全；④ 每次连上重新对账，一次失败不会变成永久缺失。
 *
 * ── 引用计数：一份内容、多份引用 ─────────────────────────────────────────────
 *
 * 站点池是**一份内容**，`.sites.json` 是**快照表**（哪个站点要哪个版本）。这就是
 * ZFS 的写时复制那个形状：版本目录是写一次就不再改的块，快照持有指针，最后一个
 * 引用消失时才回收。于是"装新删旧"与"多个站点各要一版"不是两条规则，是同一条
 * 规则的两个结果。
 *
 * ★ 回收只看 `wants`（**当前启用**的那些插件要哪一版），不看 `distributes`。
 *   「站点关掉一个插件」或「站点把它整个移除」**都不构成删除理由** —— 删除的唯一
 *   理由是没有任何站点要它、也没有活会话用它。
 *
 * ── 三个「不」 ──────────────────────────────────────────────────────────────
 *
 * ★ **读不到记录就不回收，只报。** 记录丢了/坏了 ⇒ 池里每个版本的引用数都算 0，
 *   按规则会把整个池清空 —— 那是"因为读不到一张表而删掉用户的文件"。与 `deploy.sh`
 *   的「`JOBS_DIR` 有东西但没有标记 ⇒ die，不删」是同一个先例：**不知道谁在引用的
 *   时候，唯一安全的动作是什么都不删。**
 *
 * ★ **写记录在回收之前。** 反过来（先回收后写）会按一份**旧**引用表动手，把另一个
 *   站点还要的版本删掉 —— 这是这个设计里唯一会真正丢数据的地方。
 *
 * ★ **下载失败绝不退回到本机池。** 判据必须是"能力缺席"（协议事实：响应里没有
 *   `limits`），不能是"这次失败了"（瞬时事实）。合并两者等于给一个能让下载失败的
 *   人（断流、丢包、MITM）一个把用户降级到旧本地副本的开关 —— 攻击成本从"改内容"
 *   降到"让下载失败"，而后者便宜得多。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const plugins = require('./plugins/index.js');

/** 快照表。放在站点池**里面**：清掉那个目录 = 记录与内容一起没，两者不可能各漂各的。 */
const RECORD_NAME = '.sites.json';
/** 对账锁。同一时刻只允许一次对账 —— 见 acquireLock。 */
const LOCK_NAME = 'lock';
const RECORD_VERSION = 1;

/**
 * 客户端**自己**那份硬上限。
 *
 * ★ `limits` 是**被审计方的自述**，所以只能收紧不能放宽（见 effectiveLimits）。
 *   理由很具体：一个站点（或一次 MITM）可以报 10 万个 1 字节的文件，客户端会跑很
 *   久、耗尽 inode、把 `~/.slurmate` 塞满。
 */
const HARD_LIMITS = {
  file_bytes: 256 * 1024,
  total_bytes: 1 << 20,
  max_files: 256,
  max_depth: 8,
};

const MAX_SEGMENT_BYTES = 255;

/** Windows 上不合法或会被静默改名的东西。Linux 上永远测不出来，而客户端发三平台。 */
const WIN_BAD_CHARS = /[\\:*?"<>|]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 退避重试的等待。**限流不是失败。**
 *
 * 守护进程的桶是 `MAX_RPC_PER_SECOND = 10`（按 uid），而**一次对账是 1 次
 * `plugins` + 1 次 `list` + 每份文件一次 `plugin_file`** —— 两个插件就是 11 次，
 * 正好压在桶边上。这条限流是按"人点一下按钮"设计的，从来没有一个 op 是批量传输。
 *
 * ★ 撞上 `7 rate_limited` 要**等一下再来**，不是记进 `failed`：记进去的话用户看到
 *   的是一句"同步失败"，而根因与服务端一点关系都没有。桶本身不动 —— 它是 DoS
 *   护栏，全局的。
 */
const RATE_BACKOFF_MS = [200, 400, 800, 1600];

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 站点键：`sha256("user@host:port")` 的前 16 位。
 *
 * ★ **不是那个地址串本身。** 协议里没有集群身份（`whoami` 只有 uid/gid/user/home/
 *   account），而 `host` 是用户手填的字符串 —— 一个 `../..` 就能让写入落到
 *   `~/.slurmate` 外面。取哈希定长天然安全，且与 `config.checkHostKey` 的键
 *   （`host:port`）同源：两者说的都是"哪一条连接"。
 */
function siteKeyOf(conn) {
  const s = `${(conn && conn.user) || ''}@${(conn && conn.host) || ''}:${(conn && conn.port) || ''}`;
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** 站点键对应的人类可读标签（只用于显示与记录，不参与任何判定）。 */
function siteLabelOf(conn) {
  return conn ? `${conn.user}@${conn.host}:${conn.port}` : '（未知站点）';
}

// ── 路径安全（客户端侧**再判一遍**）────────────────────────────────────────
//
// ★ 服务端也可能被换过，所以"服务端已经判过"不构成省略的理由 —— 与
//   `validate_session()` 对会话文件的态度同源：**读路径本身是安全关键**。
//
// 任何一条不过 ⇒ **整份拒绝**。一个说不清的清单本身就是"这份东西不能信"。

/**
 * 检查一个声明里的相对路径。返回 `null`（可以）或一句为什么不行。
 */
function checkRelPath(rel, maxDepth) {
  if (typeof rel !== 'string' || !rel) return '路径是空的';
  if (rel.includes('\0')) return '路径里有 NUL';
  // 反斜杠**拒绝**，不翻译成 `/`：左侧不翻译而右侧翻译就是歧义的来源。
  if (rel.includes('\\')) return '路径里有反斜杠';
  if (rel.startsWith('/')) return '路径是绝对的';
  if (rel.endsWith('/')) return '路径以 / 结尾';
  if (rel.includes('//')) return '路径里有连续的两个 /';
  const segs = rel.split('/');
  if (segs.length > maxDepth) return `路径有 ${segs.length} 层，超过上限 ${maxDepth}`;
  for (const s of segs) {
    if (!s || s === '.' || s === '..') return `路径里有空的、"." 或 ".." 这一段`;
    if (Buffer.byteLength(s, 'utf8') > MAX_SEGMENT_BYTES) {
      return `路径里有一段超过 ${MAX_SEGMENT_BYTES} 字节`;
    }
    if (WIN_BAD_CHARS.test(s)) return '路径里有 Windows 上不合法的字符（: * ? " < > |）';
    if (WIN_RESERVED.test(s)) return `${JSON.stringify(s)} 是 Windows 的保留名`;
    if (/[ .]$/.test(s)) return '路径里有一段以空格或点结尾（Windows 上会被静默改名）';
    if (plugins.COPY_SKIP.has(s)) return `${JSON.stringify(s)} 不在分发范围内`;
  }
  return null;
}

/**
 * 大小写不敏感地找重复。
 *
 * ★ 真正的坑在**落盘之后**：macOS / Windows 的文件系统不区分大小写，两个只差
 *   大小写的声明会互相覆盖，而摘要是**写入之后的磁盘上**算的 —— 于是用户"同意"
 *   的是一棵与站点那棵不同的树。所以在**写入之前**（就在这张清单上）判。
 *
 * ★ 折叠用 `plugins.foldAscii`，**不是 `p.toLowerCase()`** —— 后者是全 Unicode 的，
 *   会把 `İ` 与 `K`(U+212A) 折到一起去。这里是一条**拒绝**规则：折叠口径不一致
 *   就会出现"一边收、一边拒"，也就是同一个插件在一台机器上装得上、在另一台上
 *   装不上 —— 而报错里一个字都不会提到大小写。§3.3 钉死了是 ASCII-only。
 */
function caseCollisions(paths) {
  const seen = new Map();
  const out = [];
  for (const p of paths) {
    const k = plugins.foldAscii(p);
    if (seen.has(k)) out.push([seen.get(k), p]);
    else seen.set(k, p);
  }
  return out;
}

/**
 * 把站点报的一份清单校验成**可以照着取**的形式。
 *
 * @returns {{ok:true, files:Array<{path,size,sha256}>} | {ok:false, why:string}}
 */
function checkDeclared(files, limits) {
  if (!Array.isArray(files)) return { ok: false, why: '站点没有报出这个插件的文件清单' };
  if (files.length > limits.max_files) {
    return { ok: false, why: `站点要发 ${files.length} 份文件，超过上限 ${limits.max_files} 份` };
  }
  const out = [];
  let total = 0;
  for (const f of files) {
    if (!f || typeof f !== 'object') return { ok: false, why: '文件清单里有一项不是对象' };
    const bad = checkRelPath(f.path, limits.max_depth);
    if (bad) return { ok: false, why: `${JSON.stringify(f.path)}：${bad}` };
    if (!Number.isInteger(f.size) || f.size < 0) {
      return { ok: false, why: `${f.path}：size 不是非负整数` };
    }
    if (f.size > limits.file_bytes) {
      return { ok: false, why: `${f.path} 有 ${f.size} 字节，超过单文件上限 ${limits.file_bytes} 字节` };
    }
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) {
      return { ok: false, why: `${f.path}：sha256 不是 64 位十六进制` };
    }
    total += f.size;
    if (total > limits.total_bytes) {
      return { ok: false, why: `这些文件加起来超过总字节上限 ${limits.total_bytes} 字节` };
    }
    out.push({ path: f.path, size: f.size, sha256: f.sha256 });
  }
  const dup = caseCollisions(out.map((f) => f.path));
  if (dup.length) {
    return { ok: false,
      why: `两份文件的名字只差大小写（${dup.map(([a, b]) => `${a} / ${b}`).join('、')}）——`
        + '在 macOS 与 Windows 的磁盘上它们会互相覆盖，而摘要按磁盘算，'
        + '于是"你同意的"与"实际装上的"可以不是同一棵树' };
  }
  return { ok: true, files: out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}

/** 服务端的 `limits` 只能**收紧**客户端那份硬上限。缺席 = 用客户端自己的。 */
function effectiveLimits(reported) {
  const out = { ...HARD_LIMITS };
  if (!reported || typeof reported !== 'object') return out;
  for (const k of Object.keys(HARD_LIMITS)) {
    const v = reported[k];
    if (Number.isInteger(v) && v > 0 && v < out[k]) out[k] = v;
  }
  return out;
}

// ── 快照表 ──────────────────────────────────────────────────────────────────

function recordPathOf(siteRoot) { return path.join(siteRoot, RECORD_NAME); }

/** 原子写。**不用 `writeFileSync` 直接覆盖** —— 半份记录会让池子的引用表凭空变少。 */
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 读快照表。**读不出来是一种必须被区分的状态**，不是"没有站点要它们"。
 *
 * @returns {{ok:true, record:object} | {ok:false, why:string}}
 */
function readRecord(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      // ★ "还不存在"与"坏了"**必须分得开**：前者在池子空的时候与"没有站点要它们"
      //   是同一件事（第一次对账），而后者永远不是。合并的话，每一次首次连接都会
      //   报一条"不会回收"的警告 —— 而一条天天出现的警告等于没有警告，真正的
      //   那一次会被淹掉。判定见 sync 里那一段。
      return { ok: false, missing: true, why: '记录文件还不存在' };
    }
    return { ok: false, missing: false, why: `读不到记录：${e.message}` };
  }
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch (e) {
    return { ok: false, missing: false, why: `记录不是合法的 JSON（${e.message}）` };
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)
      || !rec.sites || typeof rec.sites !== 'object' || Array.isArray(rec.sites)) {
    return { ok: false, missing: false, why: '记录的顶层形状不对（要 {version, sites}）' };
  }
  return { ok: true, record: rec };
}

function emptyRecord() { return { version: RECORD_VERSION, sites: {} }; }

/**
 * 归一化一个站点条目。**只收认得出的形状** —— 这个文件是磁盘上的，可以被手改坏，
 * 而 `wants` 是回收唯一的判据。认不出的直接丢掉 = 回到"不回收"，那是安全的那一侧。
 */
function siteEntry(record, key, label) {
  const cur = record.sites[key];
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    if (!cur.wants || typeof cur.wants !== 'object' || Array.isArray(cur.wants)) cur.wants = {};
    if (!Array.isArray(cur.distributes)) cur.distributes = [];
    if (typeof cur.label !== 'string') cur.label = label || key;
    return cur;
  }
  const fresh = { label: label || key, syncedAt: 0, wants: {}, distributes: [] };
  record.sites[key] = fresh;
  return fresh;
}

/** 池里每一个 `<id>/<版本>`，以及谁在要它。 */
function listPooled(siteRoot) {
  const out = [];
  let level1;
  try {
    level1 = fs.readdirSync(siteRoot).sort();
  } catch {
    return out;
  }
  for (const id of level1) {
    if (id.startsWith('.')) continue;                 // .sites.json、暂存目录
    const idDir = path.join(siteRoot, id);
    let st;
    try { st = fs.statSync(idDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const version of fs.readdirSync(idDir).sort()) {
      const dir = path.join(idDir, version);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      out.push({ id, version, dir });
    }
  }
  return out;
}

// ── 对账 ────────────────────────────────────────────────────────────────────

/** 拿锁。拿不到就**明确放弃并说出来** —— 不静默排队，也不并发往里写。 */
function acquireLock(stagingRoot) {
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const file = path.join(stagingRoot, LOCK_NAME);
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return { ok: true, file };
  } catch (e) {
    if (e.code === 'EEXIST') return { ok: false, why: '已经有一次对账在跑' };
    return { ok: false, why: `暂存目录用不了：${e.message}` };
  }
}

function releaseLock(lock) {
  if (!lock || !lock.ok) return;
  try { fs.unlinkSync(lock.file); } catch { /* 已经不在了 */ }
}

/**
 * 清掉上一次留下的暂存树。
 *
 * ★ 暂存是**草稿纸**，不是仓库：里面有东西只可能是"上一次对账中途没了"。所以每次
 *   对账开头都清空它（快照表在站点池里，不在暂存里，清这里一个字节的站点内容都
 *   不会少）。代价写在明处：**同意对话框里的树在重新同步之后就作废了** —— 点同意
 *   时会核一遍它还在不在，不在就说"重新同步一次"。
 */
function clearStaging(stagingRoot, lock) {
  let names;
  try { names = fs.readdirSync(stagingRoot); } catch { return; }
  for (const n of names) {
    if (lock && lock.ok && path.join(stagingRoot, n) === lock.file) continue;
    try { fs.rmSync(path.join(stagingRoot, n), { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
}

/** 一份一份取。**串行** —— 见 RATE_BACKOFF_MS 那段。 */
async function fetchFiles(rpc, p, declared, destDir, limits, ctx) {
  let total = 0;
  for (const f of declared) {
    if (ctx.stale()) return { ok: false, why: '连接已经换了一条，这次对账作废' };
    const resp = await rpcWithBackoff(rpc, {
      op: 'plugin_file', id: p.id, version: p.version, path: f.path,
    });
    if (!resp || !resp.ok) {
      const d = (resp && resp.error && resp.error.detail) || '控制节点没有说明原因';
      return { ok: false, why: `取 ${f.path} 失败：${d}` };
    }
    const data = resp.data || {};
    if (typeof data.data !== 'string') {
      return { ok: false, why: `取 ${f.path} 的响应里没有 data` };
    }
    const buf = Buffer.from(data.data, 'base64');
    // ★ **逐步用自己算出来的字节与上一轮记下的"声明值"比**，不拿响应自带的
    //   size/sha256 做判据 —— 那等于让被告当法官。
    if (buf.length !== f.size) {
      return { ok: false, why: `${f.path} 收到 ${buf.length} 字节，而声明的是 ${f.size} 字节` };
    }
    if (sha256(buf) !== f.sha256) {
      return { ok: false, why: `${f.path} 的内容与声明的 sha256 不符` };
    }
    total += buf.length;
    if (total > limits.total_bytes) {
      return { ok: false, why: `这些文件加起来超过总字节上限 ${limits.total_bytes} 字节` };
    }
    const full = path.join(destDir, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
    fs.writeFileSync(full, buf, { mode: 0o644 });
    // 显式 chmod：writeFileSync 的 mode 会被 umask 削，而**摘要里有权限位** ——
    // 不显式设的话，同一份内容在两台 umask 不同的机器上算出不同的摘要。
    try { fs.chmodSync(full, 0o644); } catch { /* Windows */ }
  }
  return { ok: true, total };
}

/**
 * 暂存里的四道校验。**通过了才换入。**
 *
 * ★ 顺序错了就没救：先 `rename` 再校验的话，一棵已经进了站点目录的坏树按"站点
 *   不会主动删东西"那条规则就只能让它躺着。
 */
function verifyStaged(destDir, declared, expect) {
  // ① **从磁盘重新读回来**算，不是核对手里那些 Buffer —— 那是"校验我收到的"当成
  //    "校验我写下的"，而 `writeFileSync` 在磁盘满时会留下部分文件然后抛错。
  let files;
  try {
    files = plugins.readPluginFiles(destDir);
  } catch (e) {
    return { ok: false, why: `写下去的东西读不回来：${e.message}` };
  }
  // ② **双向**比对。只比一个总摘要抓不到"多出来一个文件"，而只比"声明了的都在"
  //    抓不到"磁盘上多出来的那些"。
  const have = new Map(files.filter((f) => f.kind === 'f').map((f) => [f.path, f]));
  const want = new Map(declared.map((f) => [f.path, f]));
  const missing = [...want.keys()].filter((p) => !have.has(p));
  const extra = [...have.keys()].filter((p) => !want.has(p));
  const differs = [...want.keys()].filter((p) => have.has(p)
    && (have.get(p).sha256 !== want.get(p).sha256 || have.get(p).size !== want.get(p).size));
  const odd = files.filter((f) => f.kind !== 'f').map((f) => f.path);
  if (missing.length || extra.length || differs.length || odd.length) {
    const bits = [];
    if (missing.length) bits.push(`少 ${missing.join('、')}`);
    if (extra.length) bits.push(`多 ${extra.join('、')}`);
    if (differs.length) bits.push(`对不上 ${differs.join('、')}`);
    if (odd.length) bits.push(`非普通文件 ${odd.join('、')}`);
    return { ok: false, why: `写下去之后与声明的不一致：${bits.join('；')}` };
  }
  // ③ 清单级校验 —— **但不执行代码**（`inspectDir` 只编译）。
  //    于是"清单合法而 client/index.js 有语法错"会在这里就被抓到。
  const r = plugins.inspectDir(destDir, 'site');
  if (r.error) return { ok: false, why: `这份插件用不了：${r.error}` };
  // ④ 身份要对得上：这一份必须**自报**是站点说的那个 `(id, 版本)`。
  //    `dest` 那条路径是拿 id/版本拼出来的，而拼出来的路径与目录里的东西是两回事。
  if (expect && (r.entry.plugin.id !== expect.id || r.entry.plugin.version !== expect.version)) {
    return { ok: false, why: `这份自报的是 ${r.entry.plugin.id}@${r.entry.plugin.version}，`
      + `而站点说的是 ${expect.id}@${expect.version}` };
  }
  return { ok: true, entry: r.entry };
}

/** 一次 RPC，撞上限流就退避重试。**限流不是失败。** */
async function rpcWithBackoff(rpc, req) {
  let last = null;
  for (let i = 0; i <= RATE_BACKOFF_MS.length; i++) {
    if (i > 0) await sleep(RATE_BACKOFF_MS[i - 1]);
    last = await rpc(req);
    if (last && last.ok) return last;
    const kind = last && last.error && last.error.kind;
    if (kind !== 'rate_limited') return last;
  }
  return last;
}

/**
 * 对账一次。**单一入口**，依赖注入 `rpc` —— 好测，不需要真 socket。
 *
 * 顺序是承重的：读记录 → 拿站点清单 → 下载 → 暂存校验 → 换入 → **写记录** →
 * 回收 → （调用方）`reload()`。
 *
 * @param {object} o
 *   rpc                {Function} `rpc(req) → Promise<响应>`
 *   siteKey/siteLabel  {string}
 *   siteRoot           {string} 站点池（绝对路径）
 *   stagingRoot        {string} 暂存根（绝对路径，**站点池的兄弟目录**）
 *   trusted            {Function} `(id, version, digest) → boolean`
 *   protectedVersions  {Set<string>} 活会话引用的 `<id>@<版本>`（来自 `op:list`）
 *   generation         {number}  这次对账属于哪一代连接
 *   stale              {Function} `() → boolean`：连接是否已经换了一条
 *   verify             {Function} `(entries) → failed[]`：换入之后复查注册表
 *   now                {Function} `() → number`（测试用）
 */
async function sync(o) {
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const stale = typeof o.stale === 'function' ? o.stale : () => false;
  const ctx = { stale };
  const siteRoot = o.siteRoot;
  const stagingRoot = o.stagingRoot;

  const out = {
    supported: false, reason: null, error: null,
    added: [], kept: [], pendingConsent: [], reclaimed: [], failed: [],
    notices: [], record: null, limits: { ...HARD_LIMITS },
  };

  // ── 1. 站点清单 ──
  let resp;
  try {
    resp = await o.rpc({ op: 'plugins' });
  } catch (e) {
    out.reason = 'rpc_failed';
    out.error = `问站点要插件清单失败：${e.message}`;
    return out;
  }
  if (!resp || !resp.ok) {
    out.reason = 'rpc_failed';
    out.error = `问站点要插件清单失败：${(resp && resp.error && resp.error.detail)
      || '控制节点没有说明原因'}`;
    return out;
  }
  const data = resp.data || {};
  const reported = Array.isArray(data.plugins) ? data.plugins : [];

  // ★ 判据是**协议事实**：顶层有没有 `limits`。老守护进程整个字段都没有。
  //   这与"这次下载失败了"是两件完全不同的事（见文件头第三个"不"）。
  if (!data.limits || typeof data.limits !== 'object') {
    out.reason = 'old_daemon';
    out.error = '这个站点的守护进程太旧，不支持插件分发（它的插件清单里没有文件清单）。';
    return out;
  }
  out.supported = true;
  out.limits = effectiveLimits(data.limits);

  fs.mkdirSync(siteRoot, { recursive: true, mode: 0o700 });

  // ── 2. 活会话保护集 ──
  //
  // ★ 这一步是**必须**的：只靠本地 `controller.session` 只能看到当前那一条，而
  //   客户端重启之后会 `tryReattach()` 接回旧会话 —— 那些会话的 `service_plugin`
  //   只有守护进程知道。
  const protectedVersions = new Set(o.protectedVersions || []);
  let protectedKnown = true;
  try {
    const lr = await o.rpc({ op: 'list' });
    if (lr && lr.ok) {
      for (const s of ((lr.data && lr.data.sessions) || [])) {
        if (s && typeof s.service_plugin === 'string' && s.service_plugin) {
          protectedVersions.add(s.service_plugin);
        }
      }
    } else {
      protectedKnown = false;
    }
  } catch {
    protectedKnown = false;
  }
  if (!protectedKnown) {
    out.notices.push('没能从站点问到本机还管着哪些会话，所以这一次**不会回收**任何版本。');
  }

  // ── 3. 读记录 + 拿锁 ──
  const lock = acquireLock(stagingRoot);
  if (!lock.ok) {
    out.error = lock.why;
    return out;
  }
  const stagingDir = path.join(stagingRoot,
    `${o.siteKey}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  let recordOk = true;
  let record = null;
  try {
    clearStaging(stagingRoot, lock);
    const rr = readRecord(recordPathOf(siteRoot));
    if (rr.ok) {
      record = rr.record;
    } else if (rr.missing && listPooled(siteRoot).length === 0) {
      // ★ "还不存在"**在池子空的时候**与"没有站点要它们"是同一件事 —— 那是第一次
      //   对账的正常状态，不是问题。这里给它一份空记录，顺便把那条"不会回收"的
      //   警告省掉：一条每次首连都出现的警告等于没有警告。
      //
      //   ★ 池子**不空**时绝不能这么算 —— 那时"记录不见了"恰恰是最危险的那一刻
      //     （引用表凭空少了一份），只能什么都不删（见文件头第一个"不"）。
      record = emptyRecord();
    } else {
      recordOk = false;
      out.notices.push(`读不到站点的插件记录（${rr.why}）—— 这一次**不会回收**任何版本。`);
    }
    out.record = { ok: recordOk, why: rr.ok ? null : rr.why };
    return await run();
  } finally {
    releaseLock(lock);
    // 尽力删掉自己的暂存目录。**删自己的暂存不算"删站点的东西"** —— 待同意的那
    // 些要留着（它们就是这个函数交给界面的东西），所以只清这一次没被认领的部分。
    try {
      const leftovers = fs.readdirSync(stagingDir);
      if (!leftovers.length) fs.rmdirSync(stagingDir);
    } catch { /* 已经不在、或者里面还躺着待同意的树 —— 都不是问题 */ }
  }

  async function run() {
    // ── 4. 逐个插件 ──
    const enabled = reported.filter((p) => p && p.enabled === true
      && typeof p.id === 'string' && typeof p.version === 'string');
    const seenIds = reported.filter((p) => p && typeof p.id === 'string').map((p) => p.id);

    for (const p of enabled) {
      if (stale()) break;
      const label = `${p.title || p.name || p.id} ${p.version}`;
      const dest = path.join(siteRoot, p.id, p.version);

      // ★ 站点报了这个插件、却没给它文件清单 ⇒ **这一份不分发**，跳过它。
      //   这不是失败：`op_plugins` 报的是"本站装了哪些插件"，而分发是**另一件事**
      //   （老守护进程、或者调试里造的那种条目就长这样）。记成失败的话，用户会
      //   看到一条"没能装上 X"，而其实站点从来没有说要发它。
      //   界面用 `missing[].distributed` 把这两种情况分开说。
      if (p.files === undefined || p.files === null) continue;

      const chk = checkDeclared(p.files, out.limits);
      if (!chk.ok) {
        out.failed.push({ id: p.id, version: p.version, name: p.name, title: p.title,
                          why: `站点报的这一份不能用：${chk.why}` });
        continue;
      }
      const declared = chk.files;

      // **已经有一份** —— 增量。逐文件比，对得上就跳过。
      if (fs.existsSync(dest)) {
        const r = verifyStaged(dest, declared, { id: p.id, version: p.version });
        if (r.ok) {
          out.kept.push({ id: p.id, version: p.version, name: p.name, title: p.title, dir: dest });
        } else {
          // ★ **绝不静默覆盖。** 站点改了内容却没升版本号是**站点的错**，而覆盖的
          //   后果是一条正在跑的旧会话配上新的客户端那一半 —— 正是 PROTOCOL.md 里
          //   "两半是配套的"那条注释在防的事。
          out.failed.push({
            id: p.id, version: p.version, name: p.name, title: p.title,
            why: `本机已有 ${label}，但它的内容与站点现在报的不一样（${r.why}）。`
              + '同一个版本号只能对应一份内容 —— 请管理员升版本号之后重新部署。',
          });
        }
        continue;
      }

      // **没有** —— 下载到暂存。
      const staged = path.join(stagingDir, p.id, p.version);
      try {
        fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
      } catch (e) {
        out.failed.push({ id: p.id, version: p.version, name: p.name, title: p.title,
                          why: `暂存目录建不出来：${e.message}` });
        continue;
      }
      const got = await fetchFiles(o.rpc, p, declared, staged, out.limits, ctx);
      if (!got.ok) {
        out.failed.push({ id: p.id, version: p.version, name: p.name, title: p.title,
                          why: got.why });
        continue;
      }
      const vr = verifyStaged(staged, declared, { id: p.id, version: p.version });
      if (!vr.ok) {
        out.failed.push({ id: p.id, version: p.version, name: p.name, title: p.title,
                          why: vr.why });
        continue;
      }
      const digest = vr.entry.digest;

      if (!o.trusted(p.id, p.version, digest)) {
        // ★ **同意闸的落点：下载后、暂存验完、rename 之前。**
        //
        //   下载**前**问不行：那时手里只有 (id, 版本, 名字)，**没有摘要** ——
        //   摘要是从字节算出来的，于是"内容变了要重新同意"这条需求直接无法实现。
        //   激活前（reload 之前）问也太晚：`require()` 就是执行。
        //
        //   代价写在明处：未同意的站点仍然能往磁盘写**有界的**字节
        //   （max_files / total_bytes 之下，暂存目录 0700）。见 SECURITY.md。
        out.pendingConsent.push({
          id: p.id, version: p.version, name: p.name, title: p.title,
          digest, stagedDir: staged, siteKey: o.siteKey, siteLabel: o.siteLabel,
          files: declared.map((f) => f.path),
        });
        continue;
      }

      const mv = acceptStaged({ stagedDir: staged, siteRoot, id: p.id,
                                version: p.version, digest });
      if (!mv.ok) {
        out.failed.push({ id: p.id, version: p.version, name: p.name, title: p.title,
                          why: mv.error });
        continue;
      }
      out.added.push({ id: p.id, version: p.version, name: p.name, title: p.title,
                       dir: mv.dir, digest });
    }

    // ── 5. 更新记录（**必须在回收之前**）──
    if (recordOk) {
      const cur = siteEntry(record, o.siteKey, o.siteLabel);
      cur.label = o.siteLabel;
      cur.syncedAt = now();
      // ── `wants`：这个站点**当前拿着哪些版本**（回收只认它）──
      //
      // ★ **指针只在"成功拿到新版本"时移动，绝不清空。** 这一条同时挡住了三件事，
      //   而它们看起来各不相干：
      //
      //     · 站点**升级**  1.0.0 → 1.1.0：指针移过去，1.0.0 的引用归零 ⇒ 回收
      //                     （这就是"装新删旧"，它不是一个单独的规则）
      //     · 站点**关掉**或**移除**一个插件：这一轮它不在 `enabled` 里，于是指针
      //                     停在原处 ⇒ **留着不删**（决定 3：站点不报它，不构成
      //                     删除理由 —— 它随时可能再打开）
      //     · 这一轮**失败**：指针同样不动 ⇒ 一次网络抖动不会把上一次那份按
      //                     "没人要了"回收掉
      //
      //   `cur.wants = {}` + 逐条重填的写法会把后两件事都变成"删"，所以这里**不重建**。
      if (!cur.wants || typeof cur.wants !== 'object' || Array.isArray(cur.wants)) cur.wants = {};
      for (const p of enabled) {
        const ok = out.kept.some((x) => x.id === p.id && x.version === p.version)
          || out.added.some((x) => x.id === p.id && x.version === p.version);
        if (ok) cur.wants[p.id] = p.version;
      }
      // `distributes` **只增不减**：它的用处是把话说清楚（"这个插件你以前从 X 站
      // 装过，X 现在不报它了"），不参与回收判定。
      cur.distributes = [...new Set([...cur.distributes, ...seenIds])].sort();
      record.version = RECORD_VERSION;
      try {
        writeJsonAtomic(recordPathOf(siteRoot), record);
      } catch (e) {
        // ★ 写不下去就**不回收**。顺序反了（先回收后写）会按一份旧引用表动手，
        //   把另一个站点还要的版本删掉 —— 这是本设计里唯一会真丢数据的地方。
        recordOk = false;
        out.record = { ok: false, why: `写记录失败：${e.message}` };
        out.notices.push(`记录写不下去（${e.message}）—— 这一次**不会回收**任何版本。`);
      }
    }

    // ── 6. 回收（引用计数归零才删）──
    if (!recordOk) {
      // 见文件头：不知道谁在引用的时候，唯一安全的动作是什么都不删。
    } else if (!protectedKnown) {
      // 活会话那张表没拿到，同样是不"不知道"。
    } else {
      const wanted = new Set();
      for (const s of Object.values(record.sites)) {
        for (const [id, v] of Object.entries(s.wants || {})) wanted.add(`${id}@${v}`);
      }
      for (const it of listPooled(siteRoot)) {
        const key = `${it.id}@${it.version}`;
        if (wanted.has(key) || protectedVersions.has(key)) continue;
        // 本轮刚下来的不算 —— 它没进 wants 只可能是它上面那一步失败了。
        if (out.added.some((x) => x.id === it.id && x.version === it.version)) continue;
        if (out.pendingConsent.some((x) => x.id === it.id && x.version === it.version)) continue;
        try {
          fs.rmSync(it.dir, { recursive: true, force: true });
          try { fs.rmdirSync(path.dirname(it.dir)); } catch { /* 还有别的版本 */ }
          out.reclaimed.push({ id: it.id, version: it.version });
        } catch (e) {
          out.notices.push(`回收 ${key} 失败：${e.message}`);
        }
      }
    }

    // ── 7. 换上之后**逐个复查**：拿得到才算成功 ──
    //
    // `reload()` 从不抛，坏插件进 `errors`；"文件都下来了"不等于"装上了"。
    if (typeof o.verify === 'function') {
      const landed = [...out.added, ...out.kept];
      if (landed.length) {
        for (const f of (o.verify(landed) || [])) out.failed.push(f);
      }
    }
    return out;
  }
}

/**
 * 把一份**验过的暂存树**换入站点池。**同意动作走的就是这里。**
 *
 * ★ 换入这一步的目标永远是**一个全新的键**（版本不可变 ⇒ 同名版本已经存在是
 *   "拒绝"，不是"覆盖"），所以 `rename` 覆盖的是一个不存在的目标 —— POSIX 与
 *   Windows 都成立。需要"旧的先 rename 走、新的再 rename 进来"那种两步的只有
 *   删旧，而删旧是独立的收尾步骤。
 *
 * ★ **换入之前再核一遍摘要与对话框里那个值相同。** 用户同意的是他看到的那个摘要，
 *   不是"这个 (id, 版本) 上碰巧躺着的东西"。
 */
function acceptStaged(o) {
  let st;
  try { st = fs.statSync(o.stagedDir); } catch { return { ok: false, error: '暂存的那一份已经不在了 —— 请重新同步一次。' }; }
  if (!st.isDirectory()) return { ok: false, error: '暂存的那一份不是一个目录。' };

  const r = plugins.inspectDir(o.stagedDir, 'site');
  if (r.error) return { ok: false, error: `暂存的那一份用不了：${r.error}` };
  if (r.entry.plugin.id !== o.id || r.entry.plugin.version !== o.version) {
    return { ok: false, error: `暂存的那一份自报的是 ${r.entry.plugin.id}@${r.entry.plugin.version}，`
      + `与要装的 ${o.id}@${o.version} 不一致。` };
  }
  if (o.digest && r.entry.digest !== o.digest) {
    return { ok: false, error: '暂存的那一份在你点同意之后变过了 —— 请重新同步一次再决定。' };
  }

  const dest = path.join(o.siteRoot, o.id, o.version);
  if (fs.existsSync(dest)) {
    return { ok: false, error: `${dest} 已经存在 —— 同一个版本只装一份，` + '要么它已经装好了，要么站点该升版本号。' };
  }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(o.stagedDir, dest);
  } catch (e) {
    // 半份树比没有更坏：它会被扫到一个残破的目录。尽力清掉，清不掉也要说出来。
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 下面会说 */ }
    return { ok: false, error: `换入 ${dest} 失败：${e.message}` };
  }
  return { ok: true, dir: dest, digest: r.entry.digest };
}

/**
 * 记下"这个站点拿了这一版" —— **同意那一步也要记**。
 *
 * ★ 不加这一步的话有一个真的洞：`wants` 是在对账的第 5 步写的，而同意发生在
 *   **对账返回之后**。于是"用户刚同意、还没重新对账"这段窗口里，那个版本在引用表
 *   上**不存在** —— 下一条连接（另一个站点）对账时就会按"没人要它"把它回收掉。
 *   用户看到的是"我刚同意的插件，换了个站点就没了"。
 *
 * ★ 记录读不出来时**什么都不写**，返回失败。这不是保守：读不出来意味着引用表的
 *   其余部分也在，而我们看不到 —— 拿一份只有自己那条的空记录覆盖上去，等于把别的
 *   站点的引用全抹掉，那正是 F23 记的那个场景。留给下一次对账（它在这种状态下
 *   本来就不回收）。
 */
function noteConsent(o) {
  const file = recordPathOf(o.siteRoot);
  const rr = readRecord(file);
  if (!rr.ok) {
    // "还不存在"是第一次对账的正常状态（池子此时要么空、要么即将被建起来），
    // 那时没有别人的引用可丢。其余情况一律不动。
    if (!rr.missing) return { ok: false, why: rr.why };
  }
  const rec = rr.ok ? rr.record : emptyRecord();
  const cur = siteEntry(rec, o.siteKey, o.siteLabel);
  cur.label = o.siteLabel || cur.label;
  cur.syncedAt = cur.syncedAt || Date.now();
  if (!cur.wants || typeof cur.wants !== 'object' || Array.isArray(cur.wants)) cur.wants = {};
  cur.wants[o.id] = o.version;
  cur.distributes = [...new Set([...(cur.distributes || []), o.id])].sort();
  try {
    writeJsonAtomic(file, rec);
  } catch (e) {
    return { ok: false, why: `写记录失败：${e.message}` };
  }
  return { ok: true };
}

/** 不要一份待同意的树了（用户点了"不同意"，或者它已经作废）。 */
function discardStaged(stagedDir) {
  if (typeof stagedDir !== 'string' || !stagedDir) return { ok: false, error: '没有指定要丢掉哪一份。' };
  try {
    fs.rmSync(stagedDir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: `删不掉 ${stagedDir}：${e.message}` };
  }
  return { ok: true };
}

module.exports = {
  sync, acceptStaged, discardStaged, noteConsent, siteKeyOf, siteLabelOf,
  readRecord, writeJsonAtomic, recordPathOf, listPooled,
  checkRelPath, checkDeclared, caseCollisions, effectiveLimits,
  HARD_LIMITS, RECORD_NAME, LOCK_NAME,
};
