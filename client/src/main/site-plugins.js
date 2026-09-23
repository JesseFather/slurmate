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
 *
 * ── 一条投递方式：整个包 ────────────────────────────────────────────────────
 *
 *   `package` + `plugin_package`   一次 RPC 拿到整个 `.splug`（容器的字节）
 *
 * ★ **拿的是包，不是"照着清单拼出来的字节"，这不是"快"的问题。** 包才是作者发布
 *   的那个构件：它是签名的载体（§4.2），它的内容摘要（§3.4）是"是不是同一份东西"
 *   的判据。客户端要能**自己**解析、自己重算摘要、自己验签，手里就必须有容器本身
 *   —— 一堆散装字节谁也证明不了什么。
 *
 * ★ v0.6 曾经有**第二条**路（`files` 清单 + `plugin_file` 一份一次，N 次 RPC），
 *   那是加法过渡的形状：老客户端只看 `files`，新客户端看 `package`。**它在 v0.7
 *   被删掉了**，两侧一起。删它的理由不是省事 —— 留着它不只是多一条代码路径，
 *   是多一条**验签绕得过去**的路。今天这一份实现只在"包是用读不懂的格式写的"
 *   （`package.format` 比认识的**新**）时失败，而**没有退路可退**：那个变化在
 *   v0.6 是"退回逐份取"，今天只能明确地拒绝并让用户升级客户端。这是删掉第二条
 *   路的**代价**，写在这里而不是含糊过去。
 *
 * ★ 池里一个版本是**两样挨着**：
 *
 *   <站点池>/<id>/<版本>/        解出来的树 —— `require()` 用的是它
 *   <站点池>/<id>/<版本>.splug   包本身 —— 它与树一起换入，也一起被回收
 *
 *   "删掉本机那一份"（§5.3）= **树**不在了 ⇒ 同意作废（见下一节）。包文件单独
 *   不在了**不算**撤回：能加载的是树，包是它的来路凭证；那件事会被如实报出来
 *   （`listPooled` 的 `hasPackage`），但既不会让用户重新同意一遍，也不会被
 *   **静默取回来**。
 *
 * ── 删除 = 撤回同意（§5.3）──────────────────────────────────────────────────
 *
 * ★ 对账时发现"台账里信任着这个 `(id, 版本)`，而池里没有它" ⇒ **台账那条必须
 *   消失**，于是同一个对账里它自然走进待同意 —— 不需要另写一条"撤回"的规则，
 *   它就是"没有台账条目"那一格。
 *
 *   不这么做的话：用户删掉池里那一份，下一次对账会按"摘要与台账相符"**静默装
 *   回来、一个字都不问**。那不是"当作从来没有过"，那是"用户想让它消失，它自己
 *   回来了"。
 *
 * ★ 也**绝不**在文案里断言是用户删的：客户端不知道原因（可能是我们自己回收的、
 *   可能是同步失败、可能是他删的），它只知道"不在了"。
 *
 * ★ 只对**本站点这一轮报出来的**那些判 —— 别的站点的台账条目这一轮管不着。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const plugins = require('./plugins/index.js');
const atomicWrite = require('./atomic-write.js');

/**
 * 延迟取读包那一半。
 *
 * ★ 这两个模块**互相 require**（`plugin-package.js` 要用 `checkRelPath`，理由写在
 *   那边文件头），构成一个环。Node 的环在 `module.exports = {...}` 那一刻是会咬人
 *   的：先加载的那个拿到的可能是**稍后会被整个替换掉**的 exports 对象，于是
 *   `PP.parsePackage` 是 `undefined` —— 而报错会出现在一个看起来毫无关系的地方。
 *   在**调用时**才取，就一定是在两边都加载完之后。
 */
function PP() { return require('./plugin-package.js'); }

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
 *
 * ★ `package_bytes` 是**另一笔账**：前面四个数说的是**负载内部**（解出来那些），
 *   它说的是**链路上**——整包一次发，base64 之后还要大三分之一，得装得进一条应答。
 *   所以它不能由 `total_bytes` 推出来，只能各报各的。
 *
 *   这个数取 4 MiB。★ **它不是"三处同一个数"** —— 这句话从前写在这里，而它是错的：
 *   守护进程的 `PLUGIN_PACKAGE_MAX_BYTES` 是 **2 MiB**，CLI 的
 *   `RPC_MAX_RESPONSE_BYTES` 是 **4 MiB**，而这里也是 4 MiB。真正的关系只有两条，
 *   而且方向不同：
 *
 *     · **本站通报的那个 ≤ 客户端这个**（2 MiB ≤ 4 MiB）。客户端这一份必须
 *       **不小于**站点报得出来的那个，小了就等于单方面拒绝一个合规站点发得出来
 *       的包。它是一道**兜底**，不是判据 —— 判据是 `limits.package_bytes`。
 *     · **包上限 × 4/3 + 信封 ≤ CLI 的读上限**（约 2.7 MiB ≤ 4 MiB，余量约 1.5 倍）。
 *       那一条由 `cluster/test-sessiond-logic.py` 的 19.11d **跨文件**钉着。
 *
 *   三处分别在 JS / Python 里，没有共享机制 —— 所以上面这两条是**要人看图**
 *   的关系，不是抄写。
 */
const HARD_LIMITS = {
  file_bytes: 256 * 1024,
  total_bytes: 1 << 20,
  max_files: 256,
  max_depth: 8,
  package_bytes: 4 << 20,
};

const MAX_SEGMENT_BYTES = 255;

/** Windows 上不合法或会被静默改名的东西。Linux 上永远测不出来，而客户端发三平台。 */
const WIN_BAD_CHARS = /[\\:*?"<>|]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 退避重试的等待。**限流不是失败。**
 *
 * 守护进程的桶是 `MAX_RPC_PER_SECOND = 10`（按 uid），而**一次对账是 1 次
 * `plugins` + 1 次 `list` + 每个待装的插件一次 `plugin_package`** —— 今天离桶还
 * 很远。★ 但这条退避**不能因此删掉**：v0.6 时一次对账是 `1 + 1 + N`（每份文件一次
 * `plugin_file`），两个插件就是 11 次，**正好压在桶边上** —— 那是这条纪律被写下来
 * 的原因，而桶是按"人点一下按钮"设计的，从来没有一个 op 是批量传输。谁要是引回
 * 一条按份数伸缩的路，这条退避就是唯一还站着的东西。
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
  if (!Array.isArray(files)) return { ok: false, why: '这一份里没有可读的文件清单' };
  if (files.length > limits.max_files) {
    return { ok: false, why: `这一份有 ${files.length} 份文件，超过上限 ${limits.max_files} 份` };
  }
  const out = [];
  let total = 0;
  for (const f of files) {
    if (!f || typeof f !== 'object') return { ok: false, why: '清单里有一项不是对象' };
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

// ── 整包：第二条投递方式 ────────────────────────────────────────────────────
//
// 站点在 `op_plugins` 的每一项上多报一个 `package`（`{format, bytes, digest}`），
// 顶层 `limits` 多报一个 `package_bytes`。三个字段都是**站点自述**，所以客户端
// 全部要自己再算一遍（见 fetchPackage）—— 这里做的只是"按自述先把明显不成立的
// 挡在外面"，省掉一次注定失败的传输。

/**
 * 站点自述的那个 `package` 说得通吗？
 *
 * @returns {null|{why:string, tooNew?:boolean}} `null` = 说得通。
 */
function packageMetaProblem(pkg, limits) {
  const bad = (why, tooNew) => ({ why, tooNew: tooNew === true });
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return bad('package 不是一个对象');
  }
  if (!Number.isInteger(pkg.format) || pkg.format < 1) {
    return bad(`package.format 是 ${JSON.stringify(pkg.format)}，不是正整数`);
  }
  const FORMAT = PP().FORMAT;
  // ★ 两个方向**不是同一件事**，所以不合并：
  //   比认识的新 ⇒ 格式演进了，客户端落后 —— 这是**可以回退**的那一种（见文件头）；
  //   比认识的旧/不认识 ⇒ 站点发了一个本实现根本没有过的说法，说不清它是什么。
  if (pkg.format > FORMAT) {
    return bad(`这一份包用的是格式 ${pkg.format}，而本客户端只认识 ${FORMAT} ——`
      + '站点的守护进程比这个客户端新', true);
  }
  if (pkg.format < FORMAT) {
    return bad(`package.format = ${pkg.format}，本客户端不认识（只认识 ${FORMAT}）`);
  }
  if (!Number.isInteger(pkg.bytes) || pkg.bytes <= 0) {
    return bad(`package.bytes 是 ${JSON.stringify(pkg.bytes)}，不是正的字节数`);
  }
  if (pkg.bytes > limits.package_bytes) {
    return bad(`站点说它这个包有 ${pkg.bytes} 字节，超过本客户端收得下的 `
      + `${limits.package_bytes} 字节`);
  }
  if (typeof pkg.digest !== 'string' || !/^[0-9a-f]{64}$/.test(pkg.digest)) {
    return bad('package.digest 不是 64 位十六进制的内容摘要');
  }
  return null;
}

/**
 * 这一份**能不能取**。**界面也用这个判据**（`missing[].distributed`），所以它导出。
 *
 * ★ 判据全是**协议事实**，与"这次下载失败了"毫无关系（见文件头第三个「不」）：
 *
 *   · `p.package` 是一个形状说得通的对象 ⇒ 这一份分发得出来
 *   · `p.package === null` ⇒ 站点**此刻**生产不出这一份（比如包在它启动之后被换掉
 *     了）—— 这**不是**"这个站点没有这个能力"，后者由顶层有没有 `limits` 回答。
 *     三态纪律：缺席（`undefined`）≠ 否（`null`），别把两者读成同一件事。
 *   · 这个键根本不出现 ⇒ 这一份不分发（跳过它，**不是**记一条失败）
 *
 * ★ **返回值里那个 `mode` 只剩一个可能的值**，而它留着是因为调用方判的是
 *   `del.mode` 真不真：v0.6 它是 `'package' | 'files' | null` 三态，今天是两态。
 *   名字改成 `mode` 之外的东西会动到三处调用方与界面那个判据，而它没有换来
 *   任何东西 —— 那两态的形状仍然需要**一个**字段来表达。
 *
 * @returns {{mode:'package'|null, why?:string}}
 */
function deliveryOf(p, limits) {
  const hasPkg = p.package !== undefined && p.package !== null;
  if (!hasPkg) return { mode: null };
  const bad = packageMetaProblem(p.package, limits);
  if (!bad) return { mode: 'package' };
  // ★ v0.6 这里还有一条退路：「格式太新」时退回逐份取。**没有退路了** ——
  //   `files` 那条路已经删掉。所以"站点比客户端新"从一条**提示**升级成一条
  //   **明确的失败**：用户能做的事只有升级客户端，而界面必须这么说。
  return { mode: null, why: bad.why, tooNew: bad.tooNew === true };
}

/**
 * 包里那些记录 → `(path, size, sha256)` 三元组，`size` 是**数**不是 BigInt。
 *
 * ★ `parsePackage` 已经把这些 size 逐个夹在 `Number.MAX_SAFE_INTEGER` 之内了
 *   （超了就是 `length`，它当场拒绝），所以这里的 `Number()` 不会失精。
 *   下游（`checkDeclared`、`verifyStaged`）吃的是同一种形状，而这不是碰巧：
 *   `verifyStaged` 是对着**磁盘上那棵树**核，`checkDeclared` 是对着**包里的记录**
 *   核，两者要比出"同一份东西"来，前提就是这里的形状与它们一致。
 */
function fileListOf(pkg) {
  return pkg.files.map((f) => ({ path: f.path, size: Number(f.size), sha256: f.sha256 }));
}

// ── 快照表 ──────────────────────────────────────────────────────────────────

function recordPathOf(siteRoot) { return path.join(siteRoot, RECORD_NAME); }

/**
 * 原子写快照表。**不用 `writeFileSync` 直接覆盖** —— 半份记录会让池子的引用表凭空变少。
 *
 * ★ 实现搬去了 `atomic-write.js`（框架里唯一的那一份）。留下这个三行的适配，与
 *   `config.js` 里那一个同形，理由也一样：**"写不下去必须炸"是这里的策略** ——
 *   下面两个调用点都 `try/catch` 了它，并拿 `e.message` 去告诉用户"这一次不会回收
 *   任何版本"。通用实现只返回结构化结果，不替调用方决定这件事。
 */
const writeJsonAtomic = (file, obj) => atomicWrite.writeAtomicOrThrow(
  file, JSON.stringify(obj, null, 2), { mode: 0o600 });

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

/**
 * 池里每一个 `<id>/<版本>`，以及谁在要它。
 *
 * ★ `hasPackage` = 旁边那个 `<版本>.splug` 在不在。它只用于**如实报告**（见文件头
 *   那一段）：包单独不在了不构成撤回，也不会被静默取回来 —— 但它是一件用户看得见
 *   的事实（他打开那个目录就会发现少了一个文件），所以不能瞒着。
 */
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
      // ★ 只认**目录**：旁边的 `<版本>.splug` 是这一份的包，不是另一份插件。
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      out.push({ id, version, dir, hasPackage: fs.existsSync(pkgPathOf(siteRoot, id, version)) });
    }
  }
  return out;
}

/** 池里那一份包的位置 —— **一个函数**，写与读、换入与回收都走它。 */
function pkgPathOf(siteRoot, id, version) {
  return path.join(siteRoot, id, `${version}.splug`);
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

/**
 * 暂存里的四道校验。**通过了才换入。**
 *
 * ★ 顺序错了就没救：先 `rename` 再校验的话，一棵已经进了站点目录的坏树按"站点
 *   不会主动删东西"那条规则就只能让它躺着。
 *
 * ★ `declared` 可以是 `null` —— 那是"**没有另一份可比的清单**"，只发生在一种
 *   情况下：本机那一份**只有解出来的树、包不在了**（见 sync 第 3 步）。那时
 *   ①② 跳过，只剩 ③④，而"内容有没有被动过"由**台账里那个摘要**回答（摘要是
 *   从磁盘上算的）。返回值里带 `compared:false`，让调用方能如实说出来 ——
 *   一次"少做了一半校验"的核对，不许看起来与做全了的那次一样。
 */
function verifyStaged(destDir, declared, expect) {
  const want = Array.isArray(declared) ? declared : null;
  if (want) {
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
    const wantMap = new Map(want.map((f) => [f.path, f]));
    const missing = [...wantMap.keys()].filter((p) => !have.has(p));
    const extra = [...have.keys()].filter((p) => !wantMap.has(p));
    const differs = [...wantMap.keys()].filter((p) => have.has(p)
      && (have.get(p).sha256 !== wantMap.get(p).sha256 || have.get(p).size !== wantMap.get(p).size));
    const odd = files.filter((f) => f.kind !== 'f').map((f) => f.path);
    if (missing.length || extra.length || differs.length || odd.length) {
      const bits = [];
      if (missing.length) bits.push(`少 ${missing.join('、')}`);
      if (extra.length) bits.push(`多 ${extra.join('、')}`);
      if (differs.length) bits.push(`对不上 ${differs.join('、')}`);
      if (odd.length) bits.push(`非普通文件 ${odd.join('、')}`);
      return { ok: false, why: `写下去之后与声明的不一致：${bits.join('；')}` };
    }
  }
  // ③ 清单级校验 —— **但不执行代码**（`inspectDir` 只编译）。
  //    于是"清单合法而 client/index.js 有语法错"会在这里就被抓到。
  const r = plugins.inspectDir(destDir);
  if (r.error) return { ok: false, why: `这份插件用不了：${r.error}` };
  // ④ 身份要对得上：这一份必须**自报**是站点说的那个 `(id, 版本)`。
  //    `dest` 那条路径是拿 id/版本拼出来的，而拼出来的路径与目录里的东西是两回事。
  if (expect && (r.entry.plugin.id !== expect.id || r.entry.plugin.version !== expect.version)) {
    return { ok: false, why: `这份自报的是 ${r.entry.plugin.id}@${r.entry.plugin.version}，`
      + `而站点说的是 ${expect.id}@${expect.version}` };
  }
  return { ok: true, entry: r.entry, compared: Boolean(want) };
}

/**
 * 整包一次取。**一条 RPC**（v0.6 那条逐份取的路是 N 条，已删）。
 *
 * ★ 这里做的每一件事都是"**自己算一遍**"：自己数字节、自己解析容器、自己逐份校
 *   sha256、自己重算内容摘要、自己验签。站点自述的那几个数一个都不当判据 ——
 *   它们只用来**比对**：对不上就说明"站点说它发的是什么"与"它实际发的是什么"
 *   不是一回事，那种时候唯一正确的动作是拒绝。
 *
 * ★ 解出来的树与包**都落到暂存**，一起等着过闸或换入（见 acceptStaged）。
 */
async function fetchPackage(rpc, p, meta, dir, pkgFile, limits, ctx) {
  if (ctx.stale()) return { ok: false, why: '连接已经换了一条，这次对账作废' };
  const resp = await rpcWithBackoff(rpc, { op: 'plugin_package', id: p.id, version: p.version });
  if (!resp || !resp.ok) {
    const d = (resp && resp.error && resp.error.detail) || '控制节点没有说明原因';
    return { ok: false, why: `取整包失败：${d}` };
  }
  const data = resp.data || {};
  if (typeof data.data !== 'string') {
    return { ok: false, why: '取整包的响应里没有 data' };
  }
  const buf = Buffer.from(data.data, 'base64');
  // 与上一轮 `op_plugins` 里记下的那个数比 —— 那是**两个独立时刻的两个说法**。
  if (buf.length !== meta.bytes) {
    return { ok: false,
      why: `整包收到 ${buf.length} 字节，而站点在插件清单里报的是 ${meta.bytes} 字节` };
  }
  const parsed = PP().parsePackage(buf);
  if (!parsed.ok) return { ok: false, why: `这一份包读不了（${parsed.code}）：${parsed.why}` };
  // ★ 内容摘要必须与站点自述的一致。**这不是在比容器字节的 sha256** —— 摘要盖的是
  //   内容（§3.4）：给同一份负载补一个签名块会改变容器长度而摘要一个字都不变，
  //   那正是"摘要不变 ⇒ 还是同一份构件"这条规则的样子。
  if (parsed.digest !== meta.digest) {
    return { ok: false, why: `整包的内容摘要是 ${parsed.digest}，而站点报的是 `
      + `${meta.digest} —— 这两次说的不是同一份东西` };
  }
  // ★ 响应**自己报的那两个数**也要核 —— 它是关于同一份东西的**第三个说法**
  //   （`op_plugins` 里一次、这次响应里一次、以及我们自己算出来的）。三次说法
  //   不一致 = 这个站点讲不圆自己的故事，而那种时候该做的事是拒绝，不是挑一个信。
  //   缺席 = 这个版本的守护进程不报它（三态纪律：缺席 ≠ 否），那就跳过。
  if (Number.isInteger(data.bytes) && data.bytes !== buf.length) {
    return { ok: false, why: `取整包的响应里说它发了 ${data.bytes} 字节，实际是 `
      + `${buf.length} 字节` };
  }
  if (typeof data.digest === 'string' && data.digest !== parsed.digest) {
    return { ok: false, why: `取整包的响应里报的内容摘要是 ${data.digest}，`
      + `而这一份包算出来是 ${parsed.digest}` };
  }
  // 负载内部那几条上限（单文件多大、一共几份、加起来多少、路径多深）在这里执行。
  // ★ **这是它们今天唯一的执行点。** v0.6 时守护进程在 `plugin_file` 那一条上也
  //   执行一次（超了回 code 4）；那条路删掉之后，本站**只通报、不拦截**这几个数
  //   （唯一拦得住的是整包上限 `package_bytes`）。所以一个负载超限的包**装得上、
  //   发得出**，而每一个客户端都会在**这里**拒收 —— `--check-plugins` 会对它打 ⚠。
  const chk = checkDeclared(fileListOf(parsed), limits);
  if (!chk.ok) return { ok: false, why: `这一份包里的内容不合规：${chk.why}` };

  try {
    // ★ 铺树用 `unpackTo` —— **只有那一份实现**（权限位 `0644` 在这里定死，
    //   而权限位进摘要：两份实现漂开的那天，同一份内容会算出两个摘要）。
    const u = PP().unpackTo(parsed, buf, dir);
    if (!u.ok) return { ok: false, why: u.why };
    fs.writeFileSync(pkgFile, buf, { mode: 0o644 });
  } catch (e) {
    return { ok: false, why: `写到暂存失败：${e.message}` };
  }

  // ★ **校验我写下的，不是校验我收到的。** 与 verifyStaged 同一个理由：磁盘满的
  //   时候 `writeFileSync` 会留下半份文件然后抛错，而不抛的那种更坏。
  const again = PP().readPackageFile(pkgFile);
  if (!again.ok) return { ok: false, why: `写下去的包读不回来：${again.why}` };
  if (again.digest !== parsed.digest) {
    return { ok: false,
      why: `写下去的包与收到的那一份不是同一份（${again.digest} ≠ ${parsed.digest}）` };
  }
  return { ok: true, files: chk.files, pkg: parsed };
}

/** 某一份包记录的字节由 `plugin-package.js` 的 `dataOf` 取（**只有那一份实现**）。 */

/**
 * §5.4：这一份的签名者，与本机钉住的那把是同一把吗。
 *
 * ★ `pkg` 为 `null` 表示"这一份**不是以一个包的形式来的**"。今天调用的两处都
 *   一定拿得到包（唯一那条路就是取整包），所以 `null` 只在**调用方手里那个包读不动**
 *   时出现；而 `keyVerdict` 那时对钉过的 id 给出 `unsigned`，也就是**拒绝** ——
 *   这是对的。
 *
 *   ★ v0.6 时这个 `null` 有第二个来源：逐份取那条路**根本没有包**。那条路同时是
 *     §5.4 的一个**绕过口**（拿散装字节冒充一个"没签名"的构件），所以当时它在
 *     这里被判拒 —— 而 v0.7 把那条路整个删掉了，这个缺口因此**关在结构里**，
 *     不再靠这一句判断挡着。
 */
function pinVerdict(o, p, pkg) {
  const pinned = (typeof o.pinnedKey === 'function') ? o.pinnedKey(p.id) : undefined;
  return PP().keyVerdict(pinned, pkg);
}

/**
 * 一次 RPC，撞上限流就退避重试。**限流不是失败。**
 */
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
 *   forgetTrust        {Function} `(id, version) → {had:boolean}`：把这个 `(id, 版本)`
 *                      的同意台账条目**删掉**。§5.3：本机那一份不在了 ⇒ 同意作废。
 *                      只在"池里没有这一份"时被调用；没有条目时返回 `had:false`。
 *   pinnedKey          {Function} `(id) → string|undefined`：本机钉住的公钥指纹
 *                      （§5.4）。`undefined` = 从没钉过。见 config.pinnedKeyOf。
 *   protectedVersions  {Set<string>} 活会话引用的 `<id>@<版本>`（来自 `op:list`）
 *   keepSites          {string[]} 现在**还存在**的那些连接的站点键（见 `siteKeyOf`）。
 *                      给出它就顺手把记录里已经不在其中的站点条目删掉（第 5 步）。
 *                      ★ **省略 ≠ 空**：省略 = 不知道（一条都不删）—— 与
 *                      "读不到记录就不回收"同一条纪律，因为删条目会让版本失去引用。
 *   generation         {number}  这次对账属于哪一代连接
 *   stale              {Function} `() → boolean`：连接是否已经换了一条
 *   verify             {Function} `(entries) → failed[]`：换入之后复查注册表
 *   now                {Function} `() → number`（测试用）
 */
async function sync(o) {
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const stale = typeof o.stale === 'function' ? o.stale : () => false;
  const forgetTrust = typeof o.forgetTrust === 'function'
    ? o.forgetTrust : () => ({ had: false });
  const ctx = { stale };
  const siteRoot = o.siteRoot;
  const stagingRoot = o.stagingRoot;

  const out = {
    supported: false, reason: null, error: null,
    added: [], kept: [], pendingConsent: [], reclaimed: [], failed: [], withdrawn: [],
    forgotSites: [], notices: [], record: null, limits: { ...HARD_LIMITS },
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
      const pkgDest = pkgPathOf(siteRoot, p.id, p.version);
      const fail = (why) => out.failed.push({
        id: p.id, version: p.version, name: p.name, title: p.title, why,
      });

      // ── 1. 这一份分发得出来吗 ──
      const del = deliveryOf(p, out.limits);
      if (!del.mode) {
        // ★ 站点报了这个插件、却没给它任何可分发的东西 ⇒ **这一份不分发**，跳过它。
        //   这不是失败：`op_plugins` 报的是"本站装了哪些插件"，而分发是**另一件事**
        //   （老守护进程、或者调试里造的那种条目就长这样）。记成失败的话，用户会
        //   看到一条"没能装上 X"，而其实站点从来没有说要发它。
        //   界面用 `missing[].distributed` 把这两种情况分开说。
        //
        // ★ 而 `del.why` 非空时它是**一条真失败**：说的是"站点报了这一份，而我们
        //   读不懂它"（格式比客户端新、自述的三个数不自洽……）。v0.6 这一格里还有
        //   "退回逐份取"那条路，所以其中一种（站点太新）只是**一句提示**；今天没有
        //   退路了，它和其他几种一样是失败 —— 但**要分开说**，因为用户能做的事
        //   完全不同（升级客户端 vs 找管理员）。
        if (del.why) {
          if (del.tooNew && !out.reason) out.reason = 'site_too_new';
          fail(`站点报的这一份不能用：${del.why}`);
        }
        continue;
      }

      // ── 2. 本机那一份不在了 ⇒ 同意作废（§5.3，见文件头那一节）──
      const exists = fs.existsSync(dest);
      if (!exists) {
        const w = forgetTrust(p.id, p.version);
        if (w && w.had) {
          out.withdrawn.push({ id: p.id, version: p.version, name: p.name, title: p.title });
          out.notices.push(`本机那一份 ${label} 不在了，它上一次的同意已经作废 ——`
            + '下面会重新问你一次。');
        }
      }

      // ── 3. **已经有一份** —— 增量。逐文件比，对得上就不重下 ──
      if (exists) {
        // ★ 核对的判据是**本机那个包** —— 它是上一次下来、逐份校过的那一份。
        //
        //   v0.6 这里先看站点这一轮报的逐份清单（`p.files`），本机没有包时才退到
        //   磁盘上那个。**今天只剩后一半**：`files` 那个字段没有了，而这里本来
        //   也不该信它 —— 拿站点这一轮的自述去核**磁盘上**那一份，是让"对面说的"
        //   当"本机有的"的判据。本机那个包是**上一次真下载到、逐字节校过**的东西，
        //   它才是这里的正确答案。
        const rd = fs.existsSync(pkgDest) ? PP().readPackageFile(pkgDest) : null;
        const pkgOnDisk = (rd && rd.ok) ? rd : null;
        if (rd && !rd.ok) {
          out.notices.push(`本机那一份 ${label} 旁边的 ${p.version}.splug 读不出来`
            + `（${rd.why}）—— 树本身照样核，但那个包已经不能当来路凭证了。`);
        }
        // ★ 包不在了**不算撤回**（见文件头）：能加载的是树，包是它的来路凭证。
        //   那时没有"另一份清单"可比（`decl = null`），于是"内容有没有被动过"
        //   只剩**台账里那个摘要**回答 —— 摘要是从**磁盘上**算的，动过就变，
        //   对不上就会走进下面的待同意（原地认领）。**少做的那一半要说得出来**。
        if (!pkgOnDisk) {
          out.notices.push(`本机那一份 ${label} 旁边没有它的包（只剩解出来的树）——`
            + '这一次只能核内容摘要，没法逐份比对。');
        }
        const decl = pkgOnDisk ? fileListOf(pkgOnDisk) : null;
        // 给**界面**看的那份清单。没有包时从树上现读一份出来 —— 它只用来画那个
        // "你要同意的是这几份文件"，**不参与任何判定**（所以它是另一个变量）。
        // 读不出来就是空列表：那是显示上的缺省，不是一条校验结论。
        const display = decl || (() => {
          try {
            return plugins.readPluginFiles(dest).filter((f) => f.kind === 'f')
              .map((f) => ({ path: f.path }));
          } catch { return []; }
        })();

        const r = verifyStaged(dest, decl, { id: p.id, version: p.version });
        if (r.ok && o.trusted(p.id, p.version, r.entry.digest)) {
          out.kept.push({ id: p.id, version: p.version, name: p.name, title: p.title, dir: dest });
          continue;
        }
        if (!r.ok) {
          // ★ **绝不静默覆盖。** 站点改了内容却没升版本号是**站点的错**，而覆盖的
          //   后果是一条正在跑的旧会话配上新的客户端那一半 —— 正是 PROTOCOL.md 里
          //   "两半是配套的"那条注释在防的事。
          fail(`本机已有 ${label}，但它的内容与站点现在报的不一样（${r.why}）。`
            + '同一个版本号只能对应一份内容 —— 请管理员升版本号之后重新部署。');
          continue;
        }

        // ★ **同意闸的第二个落点：本机已经有一份、而台账对不上。**
        //
        //   这一段以前不存在，而它不在的后果是**这个插件在界面上彻底看不见**：
        //   它进了池子（`active:false`），于是 `missing` 不认领它（那边要求
        //   `registry.get` 取不到）；它又在 `plugins` 那一列之外。两条路都不在，
        //   用户连"点同意"的入口都没有，重新同步也救不回来。
        //
        //   摘要换一次公式、或者用户删过 `config.json` 里那一条，这条路就会对
        //   **每一个**站点的**每一个**插件成立 —— 集体消失、无从恢复。
        const pv = pinVerdict(o, p, pkgOnDisk);
        if (!pv.ok) { fail(pv.why); continue; }
        out.pendingConsent.push({
          id: p.id, version: p.version, name: p.name, title: p.title,
          digest: r.entry.digest,
          // ★ `existing`：这一份**已经在池里**，点同意时是"原地认领"而不是换入
          //   （见 acceptStaged），点不同意时删的也是池里那一份（见 index.js）。
          existing: true,
          stagedDir: dest, stagedPkg: null,
          fingerprint: pv.fingerprint,
          siteKey: o.siteKey, siteLabel: o.siteLabel,
          files: display.map((f) => f.path),
          // ★ 让界面能说出"这一份我们只核了摘要"—— 少做的那一半不能瞒着。
          compared: r.compared,
        });
        continue;
      }

      // ── 4. **没有** —— 把整个包取到暂存 ──
      const staged = path.join(stagingDir, p.id, p.version);
      const stagedPkg = path.join(stagingDir, p.id, `${p.version}.splug`);
      try {
        fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
      } catch (e) {
        fail(`暂存目录建不出来：${e.message}`);
        continue;
      }

      // ★ v0.6 这里是一个二选一（整包 / 逐份），而逐份那条路上还有一条**交叉
      //   判据**：站点在 `op_plugins` 里给的那份清单必须与整包说的描述同一份东西。
      //   今天只剩一条路，那份清单也没有了 —— 于是这一处**只剩下"自己算一遍"**：
      //   `fetchPackage` 自己数字节、自己解析、自己逐份校 sha256、自己重算摘要。
      //   丢掉的那条交叉判据**不是损失**：它防的是"两份自述互相矛盾"，而矛盾需要
      //   两个来源；今天本站的每一个说法都拿去与**我们算出来的那个**比了。
      const got = await fetchPackage(o.rpc, p, p.package, staged, stagedPkg, out.limits, ctx);
      if (!got.ok) { fail(got.why); continue; }
      const pkg = got.pkg;
      const decl = got.files;

      const vr = verifyStaged(staged, decl, { id: p.id, version: p.version });
      if (!vr.ok) { fail(vr.why); continue; }
      const digest = vr.entry.digest;

      const pv = pinVerdict(o, p, pkg);
      if (!pv.ok) { fail(pv.why); continue; }

      if (!o.trusted(p.id, p.version, digest)) {
        // ★ **同意闸的主落点：下载后、暂存验完、rename 之前。**
        //
        //   下载**前**问不行：那时手里只有 (id, 版本, 名字)，**没有摘要** ——
        //   摘要是从字节算出来的，于是"内容变了要重新同意"这条需求直接无法实现。
        //   激活前（reload 之前）问也太晚：`require()` 就是执行。
        //
        //   代价写在明处：未同意的站点仍然能往磁盘写**有界的**字节
        //   （max_files / total_bytes 之下，暂存目录 0700）。见 SECURITY.md。
        out.pendingConsent.push({
          id: p.id, version: p.version, name: p.name, title: p.title,
          digest, stagedDir: staged,
          stagedPkg,
          existing: false,
          fingerprint: pv.fingerprint,
          siteKey: o.siteKey, siteLabel: o.siteLabel,
          files: decl.map((f) => f.path),
        });
        continue;
      }

      const mv = acceptStaged({
        stagedDir: staged, stagedPkg, siteRoot,
        id: p.id, version: p.version, digest,
      });
      if (!mv.ok) { fail(mv.error); continue; }
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

      // ── 站点表**不是只增的**：连接没了的条目，连它的 `wants` 一起删掉 ──
      //
      // ★ 站点键是 `sha256(user@host:port)`，所以**改一次主机名/端口/用户名就是另一个
      //   键**。旧条目留在这里的后果很具体：它的 `wants` 继续为那些版本计引用 ⇒
      //   那一版**永远不会被回收**，而面板上永远显示「被 `<旧标签>` 要」。
      //
      // ★ 这与上面那条"指针只前进、绝不清空"**不是同一件事**，别合并：那一条说的是
      //   「**同一个站点**这一轮没报某个插件，不构成删除它的理由」（它随时可能再打开）；
      //   这里删的是**站点本身** —— 它对应的连接已经不在配置里，没有任何东西还会来问
      //   它要插件。★ 调用方算的是**全部**连接（不是只有当前这一条），所以当前这个站点
      //   一定在 `keepSites` 里；不成立的话这一行会把刚写好的那一条当场删掉。
      if (Array.isArray(o.keepSites)) {
        const keep = new Set(o.keepSites);
        for (const k of Object.keys(record.sites)) {
          if (keep.has(k)) continue;
          out.forgotSites.push(k);
          delete record.sites[k];
        }
      }

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
          // ★ 包是与树**一起**换入的，所以回收时也一起走。留下一个没有树的
          //   `<版本>.splug` 就是池里一份**谁也看不见**的残留（`listPooled` 只认
          //   目录）—— 用户打开那个目录会看到一个说不清是什么的文件。
          fs.rmSync(pkgPathOf(siteRoot, it.id, it.version), { force: true });
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
 * 把一份**验过的**构件收下。**同意动作走的就是这里。**
 *
 * 两种情形，写法不同而判据相同：
 *
 *   ① **换入**（`existing` 假）：暂存里那一棵树 `rename` 进池子，包跟着一起。
 *      目标是**一个全新的键**（版本不可变 ⇒ 同名版本已经存在是"拒绝"，
 *      不是"覆盖"），所以 `rename` 覆盖的是一个不存在的目标 —— POSIX 与
 *      Windows 都成立。需要"旧的先 rename 走、新的再 rename 进来"那种两步的
 *      只有删旧，而删旧是独立的收尾步骤。
 *
 *   ② **原地认领**（`existing` 真）：树**已经在池里**（它上一次下来过、只是台账
 *      对不上，见 sync 的第 4 步）。这时源与目标是同一个路径，没有 `rename` 可做
 *      ——要做的只有一件事：**再核一遍摘要**。
 *
 * ★ 两种情形都**必须**在收下之前再核一遍摘要与对话框里那个值相同。用户同意的是
 *   他看到的那个摘要，不是"这个 (id, 版本) 上碰巧躺着的东西"。
 */
function acceptStaged(o) {
  if (o.existing) {
    let st;
    try { st = fs.statSync(o.stagedDir); } catch {
      return { ok: false, error: '本机那一份已经不在了 —— 请重新同步一次。' };
    }
    if (!st.isDirectory()) return { ok: false, error: '本机那一份不是一个目录。' };
    const r = plugins.inspectDir(o.stagedDir);
    if (r.error) return { ok: false, error: `本机那一份用不了：${r.error}` };
    if (r.entry.plugin.id !== o.id || r.entry.plugin.version !== o.version) {
      return { ok: false, error: `本机那一份自报的是 ${r.entry.plugin.id}@${r.entry.plugin.version}，`
        + `与要同意的 ${o.id}@${o.version} 不一致。` };
    }
    if (o.digest && r.entry.digest !== o.digest) {
      return { ok: false, error: '本机那一份在你点同意之后变过了 —— 请重新同步一次再决定。' };
    }
    return { ok: true, dir: o.stagedDir, digest: r.entry.digest };
  }

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
    // ★ **包先落，树后落。** 反过来（先树后包）在包那一步失败时，池里会留下一棵
    //   **没有来路凭证**的树，而收尾只剩两条路：删掉刚下来的东西，或者留着一个
    //   半份。这个顺序下最坏的结果是池里多一个孤儿 `.splug` —— 它谁也看不见
    //   （`listPooled` 只认目录），而下一次同步会把包 `rename` 覆盖过去。
    if (o.stagedPkg) {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(o.stagedPkg, pkgPathOf(o.siteRoot, o.id, o.version));
    }
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

/** 不要一份待同意的草稿了（用户点了"不同意"，或者它已经作废）。 */
function discardStaged(stagedDir, stagedPkg) {
  if (typeof stagedDir !== 'string' || !stagedDir) return { ok: false, error: '没有指定要丢掉哪一份。' };
  try {
    fs.rmSync(stagedDir, { recursive: true, force: true });
    // 整包下来的那一份草稿也一起走 —— 留着它就是暂存里一份没人认领的字节，
    // 而暂存目录每次对账开头都会整个清掉（clearStaging），所以它本来也活不过一轮。
    if (typeof stagedPkg === 'string' && stagedPkg) fs.rmSync(stagedPkg, { force: true });
  } catch (e) {
    return { ok: false, error: `删不掉 ${stagedDir}：${e.message}` };
  }
  return { ok: true };
}

/**
 * 不要**池里**那一份了（用户对一个"已在本机"的待同意项点了"不同意"）。
 *
 * ★ 与 `discardStaged` 是两件事，别合并：那个删的是我们自己的**草稿纸**，这个删的
 *   是**池里的一个构件**。留下的后果是反过来的 —— 草稿留着只是占地方，而池里那
 *   一份留着就是"一个用户在界面上拒绝了、却仍然躺在磁盘上的插件"，而且它下次还会
 *   以同一个形状回来（台账里没有它，树还在）⇒ 用户点一百次不同意也去不掉。
 *
 * ★ 删**树与包两样**。站点那一份一个字节没动 —— 下一次对账还会把它取回来、
 *   再问一次。这正是 §5.3 要的：删除是一个没说出口的决定，而对账不认识它。
 */
function dropPooledVersion(siteRoot, id, version) {
  if (typeof id !== 'string' || typeof version !== 'string' || !id || !version) {
    return { ok: false, error: 'id 与版本都必须是字符串。' };
  }
  try {
    fs.rmSync(path.join(siteRoot, id, version), { recursive: true, force: true });
    fs.rmSync(pkgPathOf(siteRoot, id, version), { force: true });
    try { fs.rmdirSync(path.join(siteRoot, id)); } catch { /* 还有别的版本 */ }
  } catch (e) {
    return { ok: false, error: `删不掉 ${path.join(siteRoot, id, version)}：${e.message}` };
  }
  return { ok: true };
}

module.exports = {
  sync, acceptStaged, discardStaged, dropPooledVersion, noteConsent,
  siteKeyOf, siteLabelOf,
  readRecord, writeJsonAtomic, recordPathOf, listPooled, pkgPathOf,
  checkRelPath, checkDeclared, caseCollisions, effectiveLimits,
  deliveryOf, packageMetaProblem, fileListOf, pinVerdict, verifyStaged,
  HARD_LIMITS, RECORD_NAME, LOCK_NAME,
};
