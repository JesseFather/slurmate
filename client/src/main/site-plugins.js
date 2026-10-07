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
 *   按规则会把整个池清空 —— 那是"因为读不到一张表而删掉用户的文件"。与**安装器
 *   织作业脚本时**那条「目录里有东西、却没有本工具的部署标记 ⇒ **中止，不是删**」
 *   是同一个先例：**不知道谁在引用的时候，唯一安全的动作是什么都不删。**
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
 * ★ **拿的是包，不是"照着清单拼出来的字节"，这不是"快"的问题。** 包才是作者发布的
 *   那个构件：它是签名的载体（§4.2），它的内容摘要（§3.4）是"是不是同一份东西"
 *   的判据。客户端要能**自己**解析、自己重算摘要、自己验签，手里就必须有容器本身
 *   —— 一堆散装字节谁也证明不了什么。
 *
 * ★ 而**收下来之后容器就退休了**：树 + 记录表取代它（见上面那一节）。"手里有
 *   容器"说的是**这一刻**，不是盘上留一份。
 *
 * ★ v0.6 曾经有**第二条**路（`files` 清单 + `plugin_file` 一份一次，N 次 RPC），
 *   那是加法过渡的形状：老客户端只看 `files`，新客户端看 `package`。**它在 v0.7
 *   被删掉了**，两侧一起。删它的理由不是省事 —— 留着它不只是多一条代码路径，
 *   是多一条**验签绕得过去**的路。今天这一份实现只在"包是用读不懂的格式写的"
 *   （`package.format` 比认识的**新**）时失败，而**没有退路可退**：那个变化在
 *   v0.6 是"退回逐份取"，今天只能明确地拒绝并让用户升级客户端。这是删掉第二条
 *   路的**代价**，写在这里而不是含糊过去。
 *
 * ── ★ 池里一个版本是一个**槽位**：一棵树 + 一张记录表 ────────────────────────
 *
 *   <站点池>/<id>_<版本>/        解出来的树 —— `require()` 用的是它
 *   <站点池>/<id>_<版本>.json    记录表 —— 这一份的**提交点**
 *
 * ★ **容器是运输形状，不是存储形状。** `.splug` 只在「站点 → 这里」这一段路上
 *   活着：取回来在**内存里**解析、逐份校 sha256、重算摘要、验签，铺成树，然后
 *   就扔了 —— 盘上不再有它的位置。从前它是两样挨着存的（树 + 那个包），而"包"
 *   那一半从来没有读者：能 `require()` 的是树，验签要的是**它盖的那几份字节**，
 *   不是容器本身。
 *
 * ★ 记录表回答"这一份该是什么"（逐份 path/size/sha256 加签名块），于是"本机这一份
 *   有没有被动过"从一个**推断**变成一次**对账**。它同时是提交点（见 plugin-slot.js）。
 *
 * ★ **一棵没有记录表的树怎么处理，两端方向相反**：这里是**我们自己的池**（唯一的
 *   写方是安装器）⇒ 清掉重取；站点那一边同样一棵没记录的树，却可能是管理员手放的
 *   东西 ⇒ 只报不删。刻意如此，理由写在 plugin-slot.js 的文件头。
 *
 * ★★ **两张表不是一回事，名字必须分开**（本文件里也是）：
 *
 *   记录表（`<id>_<版本>.json`）   **一份构件**的提交点。随那一份一起换入、一起删。
 *   快照表（`.sites.json`）        **整个池**的引用计数：哪个站点要哪一版。回收的
 *                                  唯一判据，与任何一份构件的完好与否无关。
 *
 *   ★ 合并叫"记录"的那天，症状是"删一个坏掉的插件"与"改一次回收判据"会被当成
 *     同一件事来做。
 *
 *   "删掉本机那一份"（§5.3）= **树**不在了 ⇒ 同意作废（见下一节）。记录表与树
 *   同生共死，所以**没有"有树没有记录表"这个状态** —— 记录表没了与树没了是同一
 *   件事（这一份不在了）：注册表不加载它（`findPluginDirs` 要求两样都在），回收
 *   看不见它，下一轮对账按"本机没有这一份"重新取。
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
// ★ 池的**形状**（槽位名、记录表读写）住在 `plugin-slot.js` 里，那是一个**叶子**
//   模块 —— 注册表也要用它（`findPluginDirs` 靠"旁边有没有记录表"判提交），而
//   让注册表 require 本文件会构成一个环。见那个文件的文件头。
const SLOT = require('./plugin-slot.js');
// ★ "哪个会话还算数"只有**一处定义**（那份镜像注释里写着它的来源与对应关系）。
//   在这里另写一个状态数组就是第二份实现 —— 而它漂开的方向是**把在跑的版本回收掉**。
const { SERVER_FINISHED_STATES } = require('./session.js');

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

/**
 * 快照表。放在站点池**里面**：清掉那个目录 = 引用计数与内容一起没，两者不可能
 * 各漂各的。
 *
 * ★ 它是**整个池**的账（哪个站点要哪一版），与每一份构件旁边那张**记录表**
 *   （`<id>_<版本>.json`，那一份的提交点）是两件事 —— 名字必须分开，见文件头。
 */
const SNAPSHOT_NAME = '.sites.json';
/** 对账锁。同一时刻只允许一次对账 —— 见 acquireLock。 */
const LOCK_NAME = 'lock';
const SNAPSHOT_VERSION = 1;

// ── 下面那张表里，`total_bytes` 是从哪里来的 ────────────────────────────────
//
// 书面判据在 `tools/plugin-limits.json`（本文件、守护进程、打包器三侧各持一份
// 常量，那个文件是它们共同指向的那句话）。这里把**推导**摆出来，因为它决定了
// 那个数为什么长这样、以及改 `max_files` / `max_depth` 时谁会跟着动。
//
// 附录 A.1 里信封的长度是**精确**的：
//
//     包 = 头(20) ‖ 记录表 Σ(2 + pathlen + 8 + 32) ‖ 签名(0 或 188+verlen) ‖ 负载 Σsize
//
// ⇒ 一个"负载刚好顶到 `total_bytes`"的包，其字节数是 `total_bytes + 信封`。
//   要让它**永远**装得进那个 2 MiB 的包上限，就得按信封的**最坏情况**留余量 ——
//   而最坏情况由 §3.3 决定：路径最多 8 段、每段最多 255 字节（★ 三份实现都只限
//   **逐段**、不限整条路径的长），于是最长的一条路径是 `8 × 255 + 7` = 2047 字节，
//   256 份文件的记录表就是 256 × (42 + 2047) 字节。
//
// ★ 这**不是**一个保守到没用的估计：实测一棵 256 份、路径都顶到 2047 字节的树，
//   负载只有 512 字节时包本身就有 532,515 字节。凭直觉写下的 64 KiB 余量小了约
//   8 倍 —— 照它把上限提到 `2 MiB − 64 KiB`，最坏路径下会打出约 2.44 MiB 的包，
//   而安装器**会拒**（"明明合规却装不上"）。

/** §3.3 的每段字节上限。与打包器、守护进程那两份逐字相同。 */
const MAX_SEGMENT_BYTES = 255;
/** §3.3 的深度上限。 */
const MAX_DEPTH = 8;
/** 份数上限。它既是**负载内**规则，也是信封最长时的那一项系数。 */
const MAX_FILES = 256;
/** 最长的一条路径有多少字节：`MAX_DEPTH` 段 × 每段上限 + 中间那几个 `/`。 */
const MAX_PATH_BYTES = MAX_DEPTH * MAX_SEGMENT_BYTES + (MAX_DEPTH - 1);
/**
 * 信封在**最坏情况**下占多少字节：头 + 签名 + 每份的记录（2 + 路径 + 8 + 32）。
 *
 * ★ 签名那一项 v0.13 起是 **443**（`SIG_MAX_BYTES`），不是 97：签名块盖的是四元组
 *   `{id, 版本, 站点侧摘要, 客户端侧摘要}`，长度 = `188 + 版本号的字节数`，而版本号
 *   那一段的长度是一个 u8。★ 推导见上面的注释块与 `tools/plugin-limits.json`。
 *
 * ★ 那两个数**在这里又写了一遍**（而不是问 `PP().SIG_MIN_BYTES`）：`PP()` 是惰性
 *   `require`，为的是断开 `plugin-package.js ↔ site-plugins.js` 那个环，而在模块
 *   初始化的时候调它正好把这个环**跑一遍** —— 那正是它要躲的东西。`limits.test.mjs`
 *   有一条钉住"这里那两个数与容器那一份逐字相同"。
 */
const ENVELOPE_SIG_MIN = 188;
const ENVELOPE_SIG_MAX = ENVELOPE_SIG_MIN + 255;
const ENVELOPE_MAX_BYTES = 20 + ENVELOPE_SIG_MAX + MAX_FILES * (2 + MAX_PATH_BYTES + 8 + 32);

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
 *
 * ★ `total_bytes`（v0.10 起）**是推出来的，不是挑出来的** —— 它与
 *   `package_bytes`、与信封的长度三者构成一条真的关系，见下面 ENVELOPE_MAX_BYTES。
 *   从前它是 1 MiB，一个拍出来的数：`total_bytes` 与那个 2 MiB 的包上限之间没有任何
 *   东西钉住，而"负载 1 MiB"这句话因此什么也没说明。
 */
const HARD_LIMITS = {
  file_bytes: 256 * 1024,
  total_bytes: (2 << 20) - ENVELOPE_MAX_BYTES,
  max_files: MAX_FILES,
  max_depth: MAX_DEPTH,
  package_bytes: 4 << 20,
};

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

function snapshotPathOf(siteRoot) { return path.join(siteRoot, SNAPSHOT_NAME); }

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
function readSnapshot(file) {
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
    return { ok: false, missing: false, why: `快照表不是合法的 JSON（${e.message}）` };
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)
      || !rec.sites || typeof rec.sites !== 'object' || Array.isArray(rec.sites)) {
    return { ok: false, missing: false, why: '快照表的顶层形状不对（要 {version, sites}）' };
  }
  return { ok: true, snapshot: rec };
}

function emptySnapshot() { return { version: SNAPSHOT_VERSION, sites: {} }; }

/**
 * 归一化一个站点条目。**只收认得出的形状** —— 这个文件是磁盘上的，可以被手改坏，
 * 而 `wants` 是回收唯一的判据。认不出的直接丢掉 = 回到"不回收"，那是安全的那一侧。
 */
function siteEntry(snapshot, key, label) {
  const cur = snapshot.sites[key];
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
    if (!cur.wants || typeof cur.wants !== 'object' || Array.isArray(cur.wants)) cur.wants = {};
    if (!Array.isArray(cur.distributes)) cur.distributes = [];
    if (typeof cur.label !== 'string') cur.label = label || key;
    return cur;
  }
  const fresh = { label: label || key, syncedAt: 0, wants: {}, distributes: [] };
  snapshot.sites[key] = fresh;
  return fresh;
}

/**
 * 池里那个 `<id>_<版本>` 槽位，是**哪些站点**要来的（给人看的标签列表）。
 *
 * ★ 为什么值得单独一个函数：对账撞上"本机这一份与站点现在报的不是同一份东西"时，
 *   用户（和运维）接下来要问的第一个问题就是"**这一份是谁先放进去的**"。答案一直
 *   躺在快照表里（`sites[<站点键>].wants`），只是此前没人读它。
 *
 * ★ 判据是 `wants` 而**不是**"这一轮报了它的站点"：`wants` 只在**真的把那一版拿
 *   下来**时才写（第 6 步），所以它记的正是"谁把它放进了池子"。这一轮才报它、而
 *   摘要对不上的那个站点**不在**里面 —— 那正是我们要的（它不是放进去的那个）。
 *
 * ★ 快照表读不动时（`snapshot` 是 `null`）返回空列表：那是**"不知道"**，调用方
 *   据此少说一句，而不是编一个来源出来。
 */
function sitesWanting(snapshot, id, version) {
  if (!snapshot || !snapshot.sites || typeof snapshot.sites !== 'object') return [];
  const out = [];
  for (const [key, s] of Object.entries(snapshot.sites)) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const w = s.wants;
    if (!w || typeof w !== 'object' || Array.isArray(w)) continue;
    if (w[id] !== version) continue;
    out.push(typeof s.label === 'string' && s.label ? s.label : key);
  }
  return out;
}

/**
 * 池里每一个**已提交的槽位**（`<id>_<版本>/` + 旁边那张记录表）。
 *
 * ★ 判据是**两样都在**，而这不是"更严格一点"，是提交点语义本身：树在、记录表不在
 *   ⇒ 那一次安装没提交 ⇒ 这一份**不存在**（见 plugin-slot.js）。少了这一格，
 *   回收会对着一个半成品动手，而"半成品"与"成品"在列表里长得一模一样。
 *
 * ★ **不是槽位的东西一个都不报，也不删**（旧版本的残留、用户随手放的目录）。
 *   §5.1 的措辞是「往池目录里手工放置内容**必须不产生任何效果**」—— 看不见就是
 *   不产生效果。`sweepPool` 会把它们的**名字**数出来交给界面，只是为了让"池里到底
 *   有什么"这个问题有一个诚实的答案，不是为了让它们生效。
 */
function listPooled(siteRoot) {
  const out = [];
  for (const [name, dir] of poolEntries(siteRoot)) {
    const slot = SLOT.parseSlotName(name);
    if (!slot) continue;
    if (!SLOT.readRecordFile(SLOT.recordPathOf(siteRoot, slot.id, slot.version)).ok) continue;
    out.push({ id: slot.id, version: slot.version, dir });
  }
  return out;
}

/**
 * 池的顶层逐项过一遍 → `[[名字, 全路径], …]`，**只看一层、不跟随链接**。
 *
 * ★ 单独抽出来是因为"池里有什么"这件事有两个读者（列举、清扫），而两处各写一遍
 *   `readdirSync` + `statSync` 的那天，它们的**过滤条件**就会漂开 —— 漂开的症状是
 *   一个"列举看不见、清扫却删得掉"的东西。
 */
function poolEntries(siteRoot) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(siteRoot).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    // ★ 点开头的**进不来**：`.sites.json` 是快照表，`.tmp.*` 是原子写的半成品 ——
    //   两者都不是槽位，而它们又是我们自己写的，所以不该被"来历不明"那一档收走。
    if (n.startsWith('.')) continue;
    out.push([n, path.join(siteRoot, n)]);
  }
  return out;
}

/**
 * **清扫**：把"没提交的安装"收掉，并数出"不是我们写的东西"。
 *
 * 三种东西，三种处置 —— 分开的理由是它们的**来历**不同，而"来历不明"与
 * "我们自己留下的"要用不同的动作：
 *
 *   · **槽位名 + 没有记录表** ⇒ 是我们自己崩在中间留下的（池里唯一的写方是安装器）
 *     ⇒ **删掉**。下一轮对账会把它重新取回来，而"重取"本来就会发生（它没有引用
 *     计数，快照表里也从来没有过它）。
 *   · **记录表在、树不在** ⇒ 同一个半成品的另一半（先删表再删树崩在中间）⇒
 *     把那张孤儿记录表删掉。★ 留着它的后果很具体：`listPooled` 看不见它（要求两样
 *     都在），于是它永远不会被回收 —— 池里一个谁也看不见的文件。
 *   · **名字不是槽位** ⇒ **一个字节都不动**，只把名字数出来。§5.1：手工放置必须
 *     不产生任何效果；而"删掉它"是一种效果。★ 也不报错 —— 报错等于在界面上承认
 *     这个形状有意义。
 *
 * ★ 清扫只在**持锁的对账里**跑：那是唯一一个"池里不可能有别人正在写"的时刻。
 *
 * ★ **代价写在明处**：判据是"记录表**读得动**"，所以一次**读**失败（坏道、权限、
 *   文件被别的东西占着）也会让那一份被收掉。权衡的两头是：
 *
 *   · 收掉一个其实完好的一份 ⇒ 下一轮**重新取回来**（流量，而且它本来就在站点上）；
 *   · 留着它 ⇒ 池里一个**谁也看不见、谁也收不掉**的目录（列举要求记录表读得动，
 *     回收只遍历列举得到的）—— 而且它每一轮都在那儿。
 *
 *   两害相权取前者。★ 与 `findPluginDirs` 用**同一个**判据，所以"收掉"与"加载不了"
 *   永远说的是同一件事。
 *
 * @returns {{removed:string[], strays:string[]}}
 */
function sweepPool(siteRoot) {
  const removed = [];
  const strays = [];
  for (const [name, full] of poolEntries(siteRoot)) {
    const slot = SLOT.parseSlotName(name);
    const rec = SLOT.parseRecordName(name);
    if (slot) {
      // ★ 记录表在不在**用路径问**，不用"这次 readdir 里有没有"—— 后者要求两个
      //   名字在同一批里恰好相邻地对上，而那是 readdir 的排序给不了的保证。
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isDirectory()) { strays.push(name); continue; }
      if (SLOT.readRecordFile(SLOT.recordPathOf(siteRoot, slot.id, slot.version)).ok) continue;
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(name);
      } catch { strays.push(name); }
      continue;
    }
    if (rec) {
      const tree = SLOT.treeDirOf(siteRoot, rec.id, rec.version);
      let isTree = false;
      try { isTree = fs.statSync(tree).isDirectory(); } catch { /* 树不在 */ }
      if (isTree) continue;
      if (SLOT.removeRecordFile(full).ok) removed.push(name);
      else strays.push(name);
      continue;
    }
    strays.push(name);
  }
  return { removed, strays };
}

// ── 槽位：读一张记录表、验一次签 ────────────────────────────────────────────

/**
 * 池里那一份**已提交**的记录表。返回 `{ok:true, record}` 或 `{ok:false, why}`。
 *
 * ★ 它**不建路径**（交给 `plugin-slot.js`）：`p.id` 是站点报来的字符串，直接
 *   `path.join` 的话一个 `../..` 就能让写入落到池子外面。那里要求 id 是 ULID，
 *   于是"名字安全"是结构性的，不是一份挡住想得到的写法的黑名单。
 */
function readSlot(siteRoot, id, version) {
  const p = SLOT.recordPathOf(siteRoot, id, version);
  if (!p) return { ok: false, why: `${JSON.stringify(id)}@${JSON.stringify(version)} 拼不出一个池里的路径` };
  return SLOT.readRecordFile(p);
}

/**
 * 记录表里那个 `envelope` → 与 `parsePackage()` 同形的一个签名块。
 *
 * 返回 `{ok:true, sig}`（`sig` 是 `null` = **这一份没有签名**）或
 * `{ok:false, why}`（**有一块，但读不动**）。
 *
 * ★★ 这两态**必须分开**，不能把"读不动"折成"没签名"：一个读不动的签名块只可能
 *   是**有人改过它**（我们自己写下去的那一份是解析器给的字节），而"没签名"是作者
 *   的选择。折成同一件事的后果是**下转型攻击**：把签名块删掉一位 ⇒ 变成"没签名"
 *   ⇒ 钉过的 id 会被 `keyVerdict` 拒（那一档还算对），而**没钉过的 id 会被静默
 *   收下**，此后这份构件的来源没有任何东西能证明。
 *
 * ★ 形状判据用的是**容器那一份实现**（`parseSigBlock`），不在这里另写一遍长度与
 *   alg —— 那正是"同一条规矩两份实现会漂开"的现场。
 */
function recordSig(record) {
  if (!record.envelope) return { ok: true, sig: null };
  const e = record.envelope;
  if (!Number.isInteger(e.alg) || e.alg < 0 || e.alg > 255) {
    return { ok: false, why: `记录表里那个信封的 alg 是 ${JSON.stringify(e.alg)}，不是一个字节` };
  }
  // ★ `Buffer.from(…, 'base64')` **不抛** —— 它对不合法的输入是宽容的（丢掉认不得的
  //   字符）。所以"这一段能不能用"的判据只有一个：下面那次 `parseSigBlock`（它看
  //   长度、alg、以及那两段的编码）。在这里另写一遍"base64 合不合法"就是同一条规矩
  //   的第二份实现，而两份漂开的方向是"一边收、一边拒"。
  //
  // ★ 记录表里存的是**拆开的七个字段**，而形状判据吃的是**字节**，所以这里要把它们
  //   拼回去。★ 拼不回来（id 不是 26 字节、版本超过 255 字节）与拼回来解析不了
  //   （长度对不上、alg 认不得）是**同一件事**的两个入口：这张记录表里的信封被改过。
  let blk;
  try {
    blk = PP().buildSigBlock({
      alg: e.alg,
      pubkey: Buffer.from(e.pubkey, 'base64'),
      sig: Buffer.from(e.signature, 'base64'),
      id: e.id, version: e.version,
      digestSite: e.digestSite, digestClient: e.digestClient,
    });
  } catch (err) {
    return { ok: false, why: `记录表里那个信封拼不回一个签名块（${err.message}）—— 它被改过` };
  }
  const parsed = PP().parseSigBlock(blk);
  if (!parsed) {
    return { ok: false,
      why: '记录表里那个信封不是一个合法的 Ed25519 签名块'
        + `（本格式是 ${ENVELOPE_SIG_MIN} + 版本号 字节、alg=1）—— 它被改过` };
  }
  return { ok: true,
           // ★ 形状对齐 `parsePackage()` 交出来的那个签名对象（`pubkey` /
           //   `signature` / `id` / `version` / 两个摘要 / `fingerprint`），而不是
           //   `parseSigBlock()` 自己那几个字段名 —— 下游（`keyVerdict` 与
           //   `treeSignature`）读的字段名只有一份定义，别在这里换个叫法。
           sig: { alg: parsed.alg,
                  pubkey: Buffer.from(parsed.pubkey),
                  signature: Buffer.from(parsed.sig),
                  id: parsed.id,
                  version: parsed.version,
                  digestSite: parsed.digestSite,
                  digestClient: parsed.digestClient,
                  fingerprint: PP().fingerprint(parsed.pubkey) } };
}

/**
 * 一棵树**自己**的签名对不对。
 *
 * ★★ 这一步是这一版全部意义所在，而它今天**不存在**（新增的）：签名从前是盖在
 *   **容器里的记录表**上的，而容器在盘上，所以每次对账都顺手重验一次。改成"容器
 *   只在内存里活"之后，盘上只剩一棵树 —— 于是要**显式地**从树重算内容摘要，
 *   再拿记录表里的那个签名块去验它。**签名于是直接盖在树上。**
 *
 * ★ 少了这一步会怎样：§5.4 那条"签名者不变"就只剩**指纹字符串的比较**，而指纹
 *   就写在记录表里 —— 一个能改池的人可以把它一并改掉。那不是"弱一点"，那是
 *   **没有验证**：字符串比较证明不了任何关于内容的事。
 *
 * ★ 为什么必须从**树**重算，而不是照 `record.files` 里那几个 sha256 拼一遍：
 *   后者与记录表是同一份数据，改树的人顺手改表就自洽了。从树重算之后，改动必须
 *   **同时**骗过"逐份比对"与"重算的摘要"两道，而摘要那一头连着**作者的签名**。
 *
 * ★★ v0.13：那块签名盖的是**四元组** `{id, 版本, digestSite, digestClient}`（A.3），
 *   不再是"整棵树一个摘要"。于是这里分成**两步**，次序是承重的：
 *
 *     ① 用**信封里那四个东西**拼出被签消息，验签 ⇒ "这个信封是不是作者发的"；
 *     ② 从**树**重算两侧的 §3.4 摘要，与信封里那两个比 ⇒ "树配不配得上这个信封"。
 *
 *   ①不过 ⇒ 改的是**信封**；①过而②不过 ⇒ 改的是**树**。两句话指向两个完全不同的
 *   动作（查谁动了记录表 / 重装一份），对调次序就会把它们说反。
 */
function treeSignature(treeDir, record) {
  const got = recordSig(record);
  if (!got.ok) return got;
  if (!got.sig) return { ok: true, signed: false, sig: null };
  let files;
  try {
    files = plugins.readPluginFiles(treeDir);
  } catch (e) {
    return { ok: false, why: `读不到 ${treeDir} 里的文件：${e.message}` };
  }
  // ★ 非普通文件在**逐份比对**那一关就该被拒了（`verifyStaged` 的 `odd`），所以
  //   走到这里的一定只有普通文件与目录。只喂普通文件 —— 内容摘要的定义在负载上，
  //   负载里没有目录。
  const sd = PP().sideDigests(files.filter((f) => f.kind === 'f'));

  // ① **信封本身是不是作者发的。** 盖的是四元组那串字节，而那四个东西全都来自
  //    信封（`signedMessage` 只看 `id`/`version`/两个摘要）⇒ 这一步**不需要树**，
  //    也**不依赖树对不对**。①不过 ⇒ 这张记录表里的信封被改过。
  if (!PP().verifyEd25519(got.sig.pubkey, PP().signedMessage(got.sig), got.sig.signature)) {
    return { ok: false, signed: true,
      why: `记录表里那个签名块验不过 —— 它盖的必须是 `
        + `${JSON.stringify(got.sig.id)}@${JSON.stringify(got.sig.version)} 这四个东西（A.3），`
        + `而这一块盖的不是它（签的人是 ${got.sig.fingerprint}）` };
  }

  // ② **树配不配得上这个信封。** 从树重算两侧的 §3.4 摘要，与信封里那两个比。
  //    ★ 顺序是承重的：①先判，②后判。②不过而①过 ⇒ 改的是**树**；①不过 ⇒ 改的是
  //      **信封**。两句话指向两个不同的动作（重装 / 查谁动了记录表）。
  //    ★ **哪一侧在手里就核哪一侧**：客户端侧永远在（`plugin.json` 是它的一员）；
  //      站点侧在不在，由"记录表里有没有一条**只属于站点侧**的路径"决定。阶段 4
  //      之后池子里只剩客户端侧，那一条自然为假 —— 而那时站点侧的字节也不在这里，
  //      核不了，也不必核。
  if (sd.client !== got.sig.digestClient) {
    return { ok: false, signed: true,
      why: `从树重算的**客户端侧**摘要是 ${sd.client}，而记录表里那个签名块写的是 `
        + `${got.sig.digestClient} —— 这一份构件在本机被改过`
        + `（签的人是 ${got.sig.fingerprint}）` };
  }
  const sitePresent = (record.files || []).some((f) => !PP().isClientSidePath(f.path));
  if (sitePresent && sd.site !== got.sig.digestSite) {
    return { ok: false, signed: true,
      why: `从树重算的**站点侧**摘要是 ${sd.site}，而记录表里那个签名块写的是 `
        + `${got.sig.digestSite} —— 这一份构件在本机被改过`
        + `（签的人是 ${got.sig.fingerprint}）` };
  }
  return { ok: true, signed: true, sig: got.sig, fingerprint: got.sig.fingerprint, digests: sd };
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
 * 一棵树与一张记录表**逐份**对一遍。返回 `null`（对得上）或一句为什么。
 *
 * ★ **双向**。只比一个总摘要抓不到"多出来一个文件"，而只比"记录里那几份都在"
 *   抓不到"磁盘上多出来的那些"。
 *
 * ★ **非普通文件也算不一致**：容器格式里只有普通文件与它隐含建出来的目录
 *   （附录 A），所以一棵树上出现符号链接、空目录、管道，都是**这棵树不是那一份**
 *   的证据。★ 这一条同时是内容摘要能成立的前提 —— 摘要只吃 `kind === 'f'`，
 *   于是"树里多了个链接而摘要没变"必须在这里被拒，否则摘要那一层看不见它。
 *
 * ★ 单独抽出来是因为它有两个调用点，而它们问的是**同一句话**："磁盘上这棵树是不是
 *   记录表说的那一棵"。一处是暂存里的核对（`verifyStaged`），一处是**提交那一刻**
 *   的复核（`acceptStaged`）—— 各写一遍的那天，"提交时少核了一条"不会有任何东西红。
 */
function compareTree(treeFiles, want) {
  const have = new Map(treeFiles.filter((f) => f.kind === 'f').map((f) => [f.path, f]));
  const wantMap = new Map(want.map((f) => [f.path, f]));
  const missing = [...wantMap.keys()].filter((p) => !have.has(p));
  const extra = [...have.keys()].filter((p) => !wantMap.has(p));
  const differs = [...wantMap.keys()].filter((p) => have.has(p)
    && (have.get(p).sha256 !== wantMap.get(p).sha256 || have.get(p).size !== wantMap.get(p).size));
  const odd = treeFiles.filter((f) => f.kind !== 'f').map((f) => f.path);
  if (!missing.length && !extra.length && !differs.length && !odd.length) return null;
  const bits = [];
  if (missing.length) bits.push(`少 ${missing.join('、')}`);
  if (extra.length) bits.push(`多 ${extra.join('、')}`);
  if (differs.length) bits.push(`对不上 ${differs.join('、')}`);
  if (odd.length) bits.push(`非普通文件 ${odd.join('、')}`);
  return bits.join('；');
}

/** 读一棵树并把它与那份记录逐份对一遍。返回 `null`（对得上）或一句为什么。 */
function treeFault(treeDir, want) {
  let files;
  try {
    // ★ **从磁盘重新读回来**算，不是核对手里那些 Buffer —— 那是"校验我收到的"当成
    //   "校验我写下的"，而 `writeFileSync` 在磁盘满时会留下部分文件然后抛错。
    files = plugins.readPluginFiles(treeDir);
  } catch (e) {
    return `写下去的东西读不回来：${e.message}`;
  }
  return compareTree(files, want);
}

/**
 * 暂存里的四道校验。**通过了才换入。**
 *
 * ★ 顺序错了就没救：先 `rename` 再校验的话，一棵已经进了站点池的坏树按"池里的东西
 *   不主动删"那条规则就只能让它躺着（今天它会走进"重取"那一格，但那是**收尾**，
 *   不是校验）。
 *
 * ★ `declared` 从前可以是 `null`（"本机那一份只有解出来的树、包不在了"）——
 *   **那个状态没有了**：记录表与树同生共死，所以"有一棵树可比"与"有一张表可比"
 *   是同一件事。整条"只核了一半"的分支（`compared`）跟着一起删掉：一次核对要么
 *   做全，要么这一份不成立。
 */
function verifyStaged(destDir, declared, expect) {
  const fault = treeFault(destDir, declared);
  if (fault) return { ok: false, why: `写下去之后与记录表不符：${fault}` };
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
  return { ok: true, entry: r.entry };
}

/**
 * 整包一次取。**一条 RPC**（v0.6 那条逐份取的路是 N 条，已删）。
 *
 * ★ 这里做的每一件事都是"**自己算一遍**"：自己数字节、自己解析容器、自己逐份校
 *   sha256、自己重算内容摘要、自己验签。站点自述的那几个数一个都不当判据 ——
 *   它们只用来**比对**：对不上就说明"站点说它发的是什么"与"它实际发的是什么"
 *   不是一回事，那种时候唯一正确的动作是拒绝。
 *
 * ★★ **容器到这一层为止。** 它在这里解析、验签、铺成树，然后**丢掉** ——
 *   `unpackTo` 是唯一的落盘动作，而它写的是负载，不是容器。留下来的是一棵树加
 *   一张**记录表草稿**（`recordFromPackage`），后者要等过了同意闸才落盘
 *   （见 acceptStaged）—— 在那之前它只在内存里，与容器一样。
 *
 *   ★ 这一条删掉的是**一整类状态**：从前"树下来了、包没下来"是一格真实存在的
 *     半成品（`hasPackage`、`compared`、`pkgOnDisk` 那几条分支都在伺候它）。
 *     容器不落盘之后，那格状态**表达不出来**，于是它连同它的分支一起消失。
 */
async function fetchPackage(rpc, p, meta, dir, limits, ctx) {
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

  // ★ 记录表**在落盘之前**就建好：它要带着**容器里的次序**（`parsed.files`），
  //   而不是上面那个 `chk.files`（按路径排过序的，那是校验的产物）。两者是同一批
  //   文件，但"记录表里那一份"必须是**作者发的顺序** —— 见 plugin-slot.js。
  const record = SLOT.recordFromPackage(parsed);

  try {
    // ★ 铺树用 `unpackTo` —— **只有那一份实现**（权限位 `0644` 在这里定死，
    //   而权限位进摘要：两份实现漂开的那天，同一份内容会算出两个摘要）。
    //   ★ 而**容器不落盘**：这一份字节到这里就退休了，留在树上的只有负载。
    const u = PP().unpackTo(parsed, buf, dir);
    if (!u.ok) return { ok: false, why: u.why };
  } catch (e) {
    return { ok: false, why: `写到暂存失败：${e.message}` };
  }

  // ★ **校验我写下的，不是校验我收到的。** 与别处同一个理由：磁盘满的时候
  //   `writeFileSync` 会留下半份文件然后抛错，而不抛的那种更坏。
  //
  //   ★ 从前这一步是"把包文件读回来重新解析一遍"；容器不落盘之后，它变成**从树上
  //     读回来与记录表逐份对** —— 而后者是**更强**的一条：它比的是"我写下的那棵树
  //     是不是这一份构件"，不再依赖"那个包文件还在不在、还读不读得动"。
  const fault = treeFault(dir, record.files);
  if (fault) return { ok: false, why: `写下去的树与这一份对不上：${fault}` };
  return { ok: true, record };
}

/**
 * §5.4：这一份的签名者，与本机钉住的那把是同一把吗。
 *
 * ★ 第三个参数是**一个信封**（`{alg, pubkey, signature}` 解出来的那个形状），或者
 *   `null`。今天它有两个来源，而两者说的是同一件事：
 *   · 刚取回来的那一份 —— 内存里那个容器解析出来的签名块；
 *   · 本机已有的那一份 —— **记录表里的 `envelope`**（见 `recordSig`）。
 *
 *   ★ 从前这个参数是"整个解析出来的包"，而"本机那一份"那一路要先从盘上重新解析
 *     一遍容器才拿得到它 —— 容器不落盘之后那一步没有了，而**判据一个字没变**：
 *     `keyVerdict` 读的只有 `pkg.sig.fingerprint`。
 *
 * ★ `sig` 为 `null` 表示"这一份**没有签名**" —— 对钉过的 id，`keyVerdict` 给的是
 *   `unsigned`，也就是**拒绝**，这是对的。
 *   ★ v0.6 时 `null` 有第二个来源：逐份取那条路**根本没有包**（拿散装字节冒充一个
 *     "没签名"的构件，是 §5.4 的一个绕过口）。那条路在 v0.7 删掉了，这个缺口因此
 *     **关在结构里**。★ 而今天"信封读不动"那一格**不算**没签名（见 `recordSig`）——
 *     把"读不动"折成"没签名"就是把那个绕过口重新打开一次。
 */
function pinVerdict(o, p, sig) {
  const pinned = (typeof o.pinnedKey === 'function') ? o.pinnedKey(p.id) : undefined;
  return PP().keyVerdict(pinned, sig ? { sig } : null);
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
    forgotSites: [], notices: [], snapshot: null, poolStrays: [], limits: { ...HARD_LIMITS },
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
  //
  // ★★ 但**只保护还算数的那些会话**，而这是修掉一个真账（账本 S21）：`op:'list'`
  //    回的是**最近 50 行、不分状态**（守护进程那边就是 `rows[-50:]`），所以一个
  //    早就 `released` 的会话，它那一行里的 `id@版本` 从前照样进这个集合 ⇒
  //    回收那一档**永远跳过那一版** ⇒ 池里慢慢攒下"没有任何站点要、也没有任何会话
  //    在跑"的版本，而界面上那句"没有任何站点要它（下次同步时会被回收）"对它们
  //    **是假的**。
  //
  //    ★ 判据用 `SERVER_FINISHED_STATES`（**排除已知终态**），不是"只收活状态"：
  //      守护进程哪天多出一个**客户端还不认识**的状态时，排除法会把它**护住**，
  //      而收白名单法会把它当成"不算数"—— **那一边是要回收用户正在用的东西**。
  //      与 F23 那条纪律同向：不知道谁在引用的时候，唯一安全的动作是**不删**。
  const protectedVersions = new Set(o.protectedVersions || []);
  let protectedKnown = true;
  try {
    const lr = await o.rpc({ op: 'list' });
    if (lr && lr.ok) {
      for (const s of ((lr.data && lr.data.sessions) || [])) {
        if (!s || typeof s.service_plugin !== 'string' || !s.service_plugin) continue;
        if (SERVER_FINISHED_STATES.includes(s.state)) continue;
        protectedVersions.add(s.service_plugin);
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
  // ★ 这个局部变量装的是**快照表**（整个池的引用计数），不是某一份构件的记录表 ——
  //   名字必须分开，见文件头。（`draft` 那个名字留给下面那些记录表草稿。）
  let snapshotOk = true;
  let snapshot = null;
  try {
    clearStaging(stagingRoot, lock);
    const rr = readSnapshot(snapshotPathOf(siteRoot));
    if (rr.ok) {
      snapshot = rr.snapshot;
    } else if (rr.missing && listPooled(siteRoot).length === 0) {
      // ★ "还不存在"**在池子空的时候**与"没有站点要它们"是同一件事 —— 那是第一次
      //   对账的正常状态，不是问题。这里给它一份空记录，顺便把那条"不会回收"的
      //   警告省掉：一条每次首连都出现的警告等于没有警告。
      //
      //   ★ 池子**不空**时绝不能这么算 —— 那时"记录不见了"恰恰是最危险的那一刻
      //     （引用表凭空少了一份），只能什么都不删（见文件头第一个"不"）。
      snapshot = emptySnapshot();
    } else {
      snapshotOk = false;
      out.notices.push(`读不到站点的插件快照表（${rr.why}）—— 这一次**不会回收**任何版本。`);
    }
    out.snapshot = { ok: snapshotOk, why: rr.ok ? null : rr.why };
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
    // ── 4. 池子先清扫一次（持锁 —— 所以池里不可能有别人正在写）──
    //
    // ★ 位置是承重的：**在列举之前**。清扫收掉的是"上一次崩在中间的安装"，而那些
    //   半成品如果留着，下面每一个"本机有没有这一份"的判断都要多写一条"……而且它
    //   是完整的"。扫掉之后判据只剩一条：**旁边那张记录表在不在**。
    //
    // ★ 它删的是**我们自己的半成品**（槽位名 + 没有记录表；记录表在而树不在），
    //   不是槽位的东西一个字节都不动（`sweepPool` 会把它们的名字交出来）。删了什么
    //   要说出来 —— 一次"我替你删了东西"的静默是不可接受的，哪怕那些东西确实是
    //   半成品。
    const swept = sweepPool(siteRoot);
    if (swept.removed.length) {
      out.notices.push(`池里有 ${swept.removed.length} 项是上一次没写完的安装`
        + `（${swept.removed.join('、')}）—— 已经清掉了，这一轮会重新取。`);
    }
    out.poolStrays = swept.strays;

    // ── 5. 逐个插件 ──
    const enabled = reported.filter((p) => p && p.enabled === true
      && typeof p.id === 'string' && typeof p.version === 'string');
    const seenIds = reported.filter((p) => p && typeof p.id === 'string').map((p) => p.id);

    for (const p of enabled) {
      if (stale()) break;
      const label = `${p.title || p.name || p.id} ${p.version}`;
      const fail = (why) => out.failed.push({
        id: p.id, version: p.version, name: p.name, title: p.title, why,
      });

      // ── 0. 这个标识能不能拿去拼路径 ──
      //
      // ★★ 这一格是**防御**，而且是这一版新加的。`p.id` 是**站点报来的字符串**，
      //    从前它被直接拼进 `path.join(siteRoot, p.id, p.version)` —— 一个 `../..`
      //    就能让写入落到池子外面，而铺树那一步的 `mkdirSync(recursive)` 会把中间
      //    目录**建出来**。合法的守护进程报的永远是 ULID（`PLUGIN_ID_RE` 卡着），
      //    所以这一条只可能挡住**冒充站点的人**。
      //    ★ 判据是 id 的**形状**（26 个 ULID 字符里既没有 `/` 也没有 `.`），不是
      //      一份"挡掉想得到的写法"的黑名单 —— 后者只挡得住写它的人想得到的那些。
      //    ★ 而版本那一段的**语法**（`x.y.z`）不由这里判：那是协议边界的事
      //      （清单校验那边另有一道），两条各管一件事，合并会造出一句谁也读不懂的
      //      拒绝。这里只问"这个名字能不能当文件名"。
      const tree = SLOT.treeDirOf(siteRoot, p.id, p.version);
      if (!tree) {
        fail(`站点报的这一份的标识 ${JSON.stringify(p.id)}@${JSON.stringify(p.version)}`
          + ' 不能用作插件标识（id 必须是 ULID）—— 这一份不取。');
        continue;
      }

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

      // ── 2. 本机那一份**不在了** ⇒ 同意作废（§5.3，见文件头那一节）──
      //
      // ★ 判据是"**树**在不在"，而不是"记录表在不在"：两样同生共死（见文件头），
      //   而"树在、记录表不在"不是"这一份还在"，是"这一份**没提交**"—— 那种状态
      //   由下面第 3 步按不可用收掉，走的不是这条路。
      const slot = readSlot(siteRoot, p.id, p.version);
      const treeThere = fs.existsSync(tree);
      if (!treeThere) {
        const w = forgetTrust(p.id, p.version);
        if (w && w.had) {
          out.withdrawn.push({ id: p.id, version: p.version, name: p.name, title: p.title });
          out.notices.push(`本机那一份 ${label} 不在了，它上一次的同意已经作废 ——`
            + '下面会重新问你一次。');
        }
      }

      // ── 3. 本机有一份 ⇒ **对账**，对得上就不重下 ──
      if (treeThere) {
        // ★★ 对账判**两件事**，而且它们是**两道不同的关**：
        //
        //   ① **树 vs 记录表**（`verifyStaged` 里那条逐份双向比对 + 清单 + 身份）：
        //      抓"树被动过"与"记录表被动过"—— 但**抓不到**"两边一起被改"。
        //   ② **树 vs 签名**（`treeSignature`：从树重算内容摘要，再验记录表里那个
        //      签名块）：抓的正是"两边一起被改"。签名是**作者**盖的，改池子的人改不动。
        //
        //   ★ 少了②会怎样：①的两边都在本机、都被同一个人可写 ⇒ 一份**自洽的伪造**
        //     会一路通过，而 §5.4 那条"签名者不变"只剩指纹字符串比较 —— 那等于没有
        //     验证。这一条是"容器只在内存里活"之后**必须显式补上**的那一步。
        //
        //   ★ 顺序：①不过就不必问②了。①不过时摘要必然也对不上，而那时**更有用的
        //     那句话**是"哪一份文件对不上"（①会说），不是"签名盖的不是它"。
        const rec = slot.ok ? fileListOf(slot.record) : null;
        const vr = slot.ok
          ? verifyStaged(tree, rec, { id: p.id, version: p.version })
          : { ok: false, why: `${tree} 没有一张读得动的记录表（${slot.why}）` };
        const sv = vr.ok ? treeSignature(tree, slot.record) : { ok: false, why: vr.why };
        const healthy = vr.ok && sv.ok;

        if (healthy && o.trusted(p.id, p.version, vr.entry.digest)) {
          // ★★ **站点这一轮报的，与本机躺着的是不是同一份东西** —— 这一格从 v0.7
          //    起就空着，而它是这里唯一无法从本机自证的一条。
          //
          //    v0.6 的判据是**站点这一轮报的清单**（`p.files`）：`verifyStaged(dest,
          //    declared, …)` 里的 `declared` 那时来自对面。v0.7 把 `files` 删掉之后
          //    它换成了**本机那个包**，于是这一格退化成"本机的树 vs 本机的包" ——
          //    而"站点这次说的是不是另一份内容"**再没有任何东西在看**：两个站点报
          //    同一个 `(id, 版本)` 而内容不同时，后一个会被**静默收下**（它的 `wants`
          //    还照样记在那个槽位上），一个字节都不报。
          //
          //    判据回到"对面这一轮说的"：`package.digest` 是 §3.4 的内容摘要，与
          //    **从记录表重算**出来的那个是同一个函数算的（`contentDigest`），所以
          //    两者可以直接比。摘要盖的是内容，补一个签名块不会让它变 —— 这正是
          //    "摘要相同 ⇒ 还是同一份构件"那条规则。
          //
          //    ★ 从前这里算的是"盘上那个容器解析出来的摘要"。容器不落盘之后，同一个
          //      数从**记录表**重算 —— 而 `verified` 那一关刚刚才逐份核过"记录表就是
          //      这棵树"，所以两者说的是同一件事。
          const localDigest = PP().contentDigest(rec);
          if (p.package.digest !== localDigest) {
            const owners = sitesWanting(snapshot, p.id, p.version);
            fail(`本机已有 ${label}，但它的内容与站点现在报的不一样`
              + `（站点报 ${plugins.shortDigest(p.package.digest)}，本机这一份是 `
              + `${plugins.shortDigest(localDigest)}）。`
              // ★ F20：那个槽位是**谁**先放进来的 —— 快照表里一直有这份信息
              //   （`sites[<站点键>].wants`），此前没用上，而它是管理员接着要问的
              //   第一个问题。`wants` 只在"真的把那一版拿下来了"时才写，所以它记的
              //   正是"谁把它放进了池子"，而不是"这一轮有谁报了它"。
              + (owners.length
                ? `这个槽位是 ${owners.join('、')} 要来的 —— ` : '')
              + '同一个版本号只能对应一份内容 —— 请管理员升版本号之后重新部署。');
            continue;
          }
          out.kept.push({ id: p.id, version: p.version, name: p.name, title: p.title, dir: tree });
          continue;
        }

        if (healthy) {
          // ★ **同意闸的第二个落点：本机已经有一份、而台账对不上。**
          //
          //   这一段以前不存在，而它不在的后果是**这个插件在界面上彻底看不见**：
          //   它进了池子（`active:false`），于是 `missing` 不认领它（那边要求
          //   `registry.get` 取不到）；它又在 `plugins` 那一列之外。两条路都不在，
          //   用户连"点同意"的入口都没有，重新同步也救不回来。
          //
          //   摘要换一次公式、或者用户删过 `config.json` 里那一条，这条路就会对
          //   **每一个**站点的**每一个**插件成立 —— 集体消失、无从恢复。
          // ★ 签名块从 `treeSignature` 手里拿 —— 它刚验过的那一个，而不是另取一遍。
          //   一个 `undefined` 传进来会静默变成"这一份没有签名"，而那条路对**钉过的**
          //   id 是拒绝、对没钉过的是**收下** —— 一次手滑就能把 §5.4 关掉一半。
          const pv = pinVerdict(o, p, sv.sig);
          if (!pv.ok) { fail(pv.why); continue; }
          out.pendingConsent.push({
            id: p.id, version: p.version, name: p.name, title: p.title,
            digest: vr.entry.digest,
            // ★ `existing`：这一份**已经在池里**，点同意时是"原地认领"而不是换入
            //   （见 acceptStaged），点不同意时删的也是池里那一份（见 index.js）。
            existing: true,
            stagedDir: tree,
            fingerprint: pv.fingerprint,
            siteKey: o.siteKey, siteLabel: o.siteLabel,
            files: rec.map((f) => f.path),
          });
          continue;
        }

        // ── 本机那一份**不可用**（树被动过、记录表读不动、或者两者一起被改）──
        //
        // ★ 两件硬约束，都从既有纪律推出来，见文件头那三个"不"：
        //
        //   ① **有活会话认领它时不动它。** 与 v0.12 阶段 6 那条「活会话用过的落点
        //      一个不碰」同源：换了会把正在跑的会话脚下的代码换掉。那时只能报。
        //   ② **重取失败绝不退回本机那一份动过的树。** 与"下载失败绝不退回到本机池"
        //      同源。⇒ 终点是"报不可用，等用户处理"。
        //
        // ★ 还有一条要如实说的：**重取的唯一来源是站点分发**。站点此刻若正因为
        //   自己那边对不过账而不分发这一份，重取**必然失败** ⇒ 终点仍是"不可用"。
        //   所以"重取"不是一个总能成功的修复，它是**先清掉已知不可用的那一份**，
        //   再走一遍正常的路。
        if (protectedVersions.has(`${p.id}@${p.version}`)) {
          // ★ 那句话里的原因**总是** `sv.why`：①不过时 `sv` 就是 ① 那一句
          //   （上面那行三元），②不过时它是签名那一句。写成 `sv.ok ? … : …` 会
          //   在"两道都不过"时选到同一个值，看着像在挑，其实没有第二个可能。
          fail(`本机已有的 ${label} 不可用（${sv.why}），但它正被一个`
            + '**活着的会话**用着 —— 所以没有动它（换了会把它脚下的代码换掉）。'
            + '结束那个会话之后再同步一次。');
          continue;
        }
        const gone = removeSlot(siteRoot, p.id, p.version);
        if (!gone.ok) { fail(gone.error); continue; }
        out.notices.push(`本机那一份 ${label} 不可用（${sv.why}）——`
          + '已经清掉，正在重新取一份。');
        // ★ 从这里**往下走**（不是 continue）：下面那条路要么取回来一份核过的，
        //   要么明确失败。这样"不可用"这个状态不会在池里多留一瞬。
      }

      // ── 4. **没有**（或者刚被判定不可用而收掉）—— 把整个包取到暂存 ──
      //
      // ★ 暂存里那棵树的名字**必须也是槽位名**：`acceptStaged` 拿它 `rename` 进池子，
      //   而池里的名字就是这一份的地址。暂存那一层目录带随机后缀（同一次对账里不会
      //   撞），所以两次暂存同一份不会互相覆盖。
      const staged = path.join(stagingDir, `${p.id}${SLOT.SLOT_SEP}${p.version}`);
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
      const got = await fetchPackage(o.rpc, p, p.package, staged, out.limits, ctx);
      if (!got.ok) { fail(got.why); continue; }
      const draft = got.record;

      const vr = verifyStaged(staged, draft.files, { id: p.id, version: p.version });
      if (!vr.ok) { fail(vr.why); continue; }
      const digest = vr.entry.digest;

      // ★ 签名在这一层已经**验过**（`parsePackage` 第 10 步，签的是这个包的内容
      //   摘要）—— 这里只是把那个签名块取出来，供 §5.4 判"签名者是不是同一把"。
      //   再验一遍是多余的：它是**同一个函数**刚算过的结果。
      const sg = recordSig(draft);
      if (!sg.ok) { fail(sg.why); continue; }
      const pv = pinVerdict(o, p, sg.sig);
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
          existing: false,
          fingerprint: pv.fingerprint,
          siteKey: o.siteKey, siteLabel: o.siteLabel,
          files: draft.files.map((f) => f.path),
          // ★ 记录表草稿**只在内存里**，与容器一样：它要等过了同意闸才落盘
          //   （那一次写就是提交）。见 acceptStaged。
          record: draft,
        });
        continue;
      }

      const mv = acceptStaged({
        stagedDir: staged, record: draft, siteRoot,
        id: p.id, version: p.version, digest,
      });
      if (!mv.ok) { fail(mv.error); continue; }
      out.added.push({ id: p.id, version: p.version, name: p.name, title: p.title,
                       dir: mv.dir, digest });
    }

    // ── 5. 更新记录（**必须在回收之前**）──
    if (snapshotOk) {
      const cur = siteEntry(snapshot, o.siteKey, o.siteLabel);
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
        for (const k of Object.keys(snapshot.sites)) {
          if (keep.has(k)) continue;
          out.forgotSites.push(k);
          delete snapshot.sites[k];
        }
      }

      snapshot.version = SNAPSHOT_VERSION;
      try {
        writeJsonAtomic(snapshotPathOf(siteRoot), snapshot);
      } catch (e) {
        // ★ 写不下去就**不回收**。顺序反了（先回收后写）会按一份旧引用表动手，
        //   把另一个站点还要的版本删掉 —— 这是本设计里唯一会真丢数据的地方。
        snapshotOk = false;
        out.snapshot = { ok: false, why: `写快照表失败：${e.message}` };
        out.notices.push(`记录写不下去（${e.message}）—— 这一次**不会回收**任何版本。`);
      }
    }

    // ── 6. 回收（引用计数归零才删）──
    if (!snapshotOk) {
      // 见文件头：不知道谁在引用的时候，唯一安全的动作是什么都不删。
    } else if (!protectedKnown) {
      // 活会话那张表没拿到，同样是不"不知道"。
    } else {
      const wanted = new Set();
      for (const s of Object.values(snapshot.sites)) {
        for (const [id, v] of Object.entries(s.wants || {})) wanted.add(`${id}@${v}`);
      }
      for (const it of listPooled(siteRoot)) {
        const key = `${it.id}@${it.version}`;
        if (wanted.has(key) || protectedVersions.has(key)) continue;
        // 本轮刚下来的不算 —— 它没进 wants 只可能是它上面那一步失败了。
        if (out.added.some((x) => x.id === it.id && x.version === it.version)) continue;
        if (out.pendingConsent.some((x) => x.id === it.id && x.version === it.version)) continue;
        try {
          // ★ 记录表与树**一起走**（`removeSlot`，先撤提交再删内容）。从前这里是
          //   两句 `rmSync`（树 + 那个 `.splug`），而"删了一个、另一个没删掉"是一种
          //   真实的状态 —— 它留下的残留谁也看不见（列举要求两样都在），于是它会
          //   永远躺在那儿。今天失败会说出来，下一次同步还会再试。
          const g = removeSlot(siteRoot, it.id, it.version);
          if (!g.ok) throw new Error(g.error);
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
 * 池里一个槽位**从池子里消失** —— 先撤记录表，再删树。
 *
 * ★ 次序是承重的，与站点侧那条**逐字对称**（那边是 `remove_plugin_tree`）：
 *
 *   · 先删树的话，崩在中间会留下一张指向**一棵不存在的树**的记录表；
 *   · 这个次序崩在中间，留下的是一棵**没有记录表**的树。
 *
 *   两者都正确收敛（前者被 `sweepPool` 收掉，后者按"没提交"收掉），所以**真正的
 *   理由不是崩溃收敛**，而是这一条：**记录表是提交点，撤回一个提交要发生在动它的
 *   内容之前**。先动内容再撤提交，中间那一瞬的状态是"已提交、而内容是半个"——
 *   那正是提交点这个概念存在的意义所要消灭的东西。
 *
 * ★ 返回值带**哪一步失败**：调用方要把这句话原样交给用户，而"删不掉"有两种，一种
 *   是权限、一种是文件正被占着，用户要做的事不一样。
 */
function removeSlot(siteRoot, id, version) {
  const rec = SLOT.recordPathOf(siteRoot, id, version);
  const tree = SLOT.treeDirOf(siteRoot, id, version);
  if (!rec || !tree) return { ok: false, error: '这个 (id, 版本) 拼不出池里的路径。' };
  const r = SLOT.removeRecordFile(rec);
  if (!r.ok) return { ok: false, error: `删不掉记录表 ${rec}：${r.error}` };
  try {
    fs.rmSync(tree, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: `删不掉 ${tree}：${e.message}` };
  }
  return { ok: true };
}

/**
 * 把一份**验过的**构件收下。**同意动作走的就是这里。**
 *
 * 两种情形，写法不同而判据相同：
 *
 *   ① **换入**（`existing` 假）：暂存里那一棵树 `rename` 进池子，**然后原子地写
 *      记录表** —— 那一写就是**提交**（见 plugin-slot.js）。
 *      目标是**一个全新的键**（版本不可变 ⇒ 同名版本已经存在是"拒绝"，不是
 *      "覆盖"），所以 `rename` 覆盖的是一个不存在的目标 —— POSIX 与 Windows 都
 *      成立。需要"旧的先 rename 走、新的再 rename 进来"那种两步的只有删旧，而删旧
 *      是独立的收尾步骤（`removeSlot`）。
 *
 *   ② **原地认领**（`existing` 真）：树**已经在池里**（它上一次下来过、只是台账
 *      对不上，见 sync 第 3 步）。这时源与目标是同一个路径，没有 `rename` 可做，
 *      记录表也已经在了 —— 要做的只有一件事：**再核一遍摘要**。
 *
 * ★ 两种情形都**必须**在收下之前再核一遍摘要与对话框里那个值相同。用户同意的是
 *   他看到的那个摘要，不是"这个 (id, 版本) 上碰巧躺着的东西"。
 *
 * ── ★ 换入之后崩在中间会怎样 ────────────────────────────────────────────────
 *
 * `rename` 与"写记录表"之间有一个窗口。崩在那里 ⇒ 池里多一棵**没有记录表**的树
 * ⇒ 它**不可见**（`findPluginDirs` 要求两样都在、`listPooled` 也一样），下一轮对账
 * 的 `sweepPool` 把它收掉、重新取一份。★ 这就是"提交点"要的形状：**半成品不会冒充
 * 成品**，而它自己会收敛。
 *
 * ★ 反过来（先写记录表、后 rename）**不行**：崩在中间会留下一张指向不存在的树的
 *   记录表，而按"记录表 = 已提交"那条判据，池子里会有一份**声称装好了、而内容是
 *   空的**东西。
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

  const r = plugins.inspectDir(o.stagedDir);
  if (r.error) return { ok: false, error: `暂存的那一份用不了：${r.error}` };
  if (r.entry.plugin.id !== o.id || r.entry.plugin.version !== o.version) {
    return { ok: false, error: `暂存的那一份自报的是 ${r.entry.plugin.id}@${r.entry.plugin.version}，`
      + `与要装的 ${o.id}@${o.version} 不一致。` };
  }
  if (o.digest && r.entry.digest !== o.digest) {
    return { ok: false, error: '暂存的那一份在你点同意之后变过了 —— 请重新同步一次再决定。' };
  }
  // ★ 提交之前**最后一次**逐份核对：记录表草稿说的那几份，与**此刻磁盘上**这棵树
  //   是不是同一批。它不是多余的 —— 上面的 `inspectDir` 只算了一个总摘要，而一个
  //   总摘要相等**不等于**逐份相等这件事只有在它不等的时候才成立。这一次用的是
  //   与对账**同一个函数**（`compareTree`），所以"提交时核的"与"对账时核的"是同一
  //   句话，不可能漂开。
  if (o.record) {
    const fault = treeFault(o.stagedDir, o.record.files);
    if (fault) return { ok: false, error: `暂存的那一份与它的记录表对不上：${fault}` };
  }
  const dest = SLOT.treeDirOf(o.siteRoot, o.id, o.version);
  if (!dest) return { ok: false, error: '这个 (id, 版本) 拼不出池里的路径 —— 不装。' };
  if (fs.existsSync(dest)) {
    return { ok: false, error: `${dest} 已经存在 —— 同一个版本只装一份，`
      + '要么它已经装好了，要么站点该升版本号。' };
  }
  try {
    fs.renameSync(o.stagedDir, dest);
  } catch (e) {
    // 半份树比没有更坏：它会被扫到一个残破的目录。尽力清掉，清不掉也要说出来。
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 下面会说 */ }
    return { ok: false, error: `换入 ${dest} 失败：${e.message}` };
  }
  // ★★ **这一写就是提交。** 上面那一次 `rename` 是非原子的（它会崩在中间），而这一
  //     次不是 —— 于是"装好了"有一个明确的时刻，而那个时刻之前的状态有一个名字：
  //     **没提交**。
  if (o.record) {
    const w = SLOT.writeRecordFile(SLOT.recordPathOf(o.siteRoot, o.id, o.version), o.record);
    if (!w.ok) {
      // ★ 写不下去就**把树收掉**，不留一棵没有记录表的树：它的命运本来也是被
      //   `sweepPool` 收掉，而那里会把它报成"上一次没写完的安装"——一句不准确的
      //   话。这里当场收掉，用户看到的是一句准确的失败。
      const g = removeSlot(o.siteRoot, o.id, o.version);
      return { ok: false,
        error: `装到一半停下了：树已经放好，但记录表写不下去（${w.error}${w.detail ? `：${w.detail}` : ''}）。`
          + (g.ok
            ? '已经把它撤掉了 —— 请重新同步一次。'
            // ★ 撤不掉也要说清**它会怎样**：那一份是"没提交"，所以不可见、也不会
            //   被加载，而下一次同步的清扫会把它收掉。留一句含糊的"失败了"，用户
            //   会去那个目录里找一个已经不生效的东西。
            : `而且没能撤掉（${g.error}）—— 那棵树是"没提交"的，所以不会被加载；`
              + '下一次同步会把它清掉。') };
    }
  } else {
    // ★ 没有记录表草稿 = **不可能来自同意那条路**（`sync` 一定会带上它）。走到这里
    //   说明有调用方绕过了它，而"没有记录表"恰好等于"没提交" —— 所以回报一个明确的
    //   失败，而不是留一棵谁也看不见的树。
    const g = removeSlot(o.siteRoot, o.id, o.version);
    return { ok: false,
      error: '收下一份构件时没有带记录表 —— 那一份不算装上'
        + `${g.ok ? '（已经撤掉了）' : `（而且撤不掉：${g.error}）`}。` };
  }
  return { ok: true, dir: dest, digest: r.entry.digest };
}

/**
 * 记下"这个站点拿了这一版" —— **同意那一步也要记**。
 *
 * ★ 它写的是**快照表**（回收的判据），不是那一份构件的记录表 —— 后者在
 *   `acceptStaged` 里已经随树一起提交了。两张表，两个不同的时刻，见文件头。
 *
 * ★ 不加这一步的话有一个真的洞：`wants` 是在对账里写的，而同意发生在**对账返回
 *   之后**。于是"用户刚同意、还没重新对账"这段窗口里，那个版本在引用表上**不存在**
 *   —— 下一条连接（另一个站点）对账时就会按"没人要它"把它回收掉。用户看到的是
 *   "我刚同意的插件，换了个站点就没了"。
 *
 * ★ 快照表读不出来时**什么都不写**，返回失败。这不是保守：读不出来意味着引用表的
 *   其余部分也在，而我们看不到 —— 拿一份只有自己那条的空记录覆盖上去，等于把别的
 *   站点的引用全抹掉，那正是 F23 记的那个场景。留给下一次对账（它在这种状态下
 *   本来就不回收）。
 */
function noteConsent(o) {
  const file = snapshotPathOf(o.siteRoot);
  const rr = readSnapshot(file);
  if (!rr.ok) {
    // "还不存在"是第一次对账的正常状态（池子此时要么空、要么即将被建起来），
    // 那时没有别人的引用可丢。其余情况一律不动。
    if (!rr.missing) return { ok: false, why: rr.why };
  }
  const rec = rr.ok ? rr.snapshot : emptySnapshot();
  const cur = siteEntry(rec, o.siteKey, o.siteLabel);
  cur.label = o.siteLabel || cur.label;
  cur.syncedAt = cur.syncedAt || Date.now();
  if (!cur.wants || typeof cur.wants !== 'object' || Array.isArray(cur.wants)) cur.wants = {};
  cur.wants[o.id] = o.version;
  cur.distributes = [...new Set([...(cur.distributes || []), o.id])].sort();
  try {
    writeJsonAtomic(file, rec);
  } catch (e) {
    return { ok: false, why: `写快照表失败：${e.message}` };
  }
  return { ok: true };
}

/**
 * 不要一份待同意的**草稿**了（用户点了"不同意"，或者它已经作废）。
 *
 * ★ 它删的是**暂存里那棵树**。从前的第二个参数是"那个 `.splug` 草稿"，容器不落盘
 *   之后它不存在了 —— 而这一整条路径也简单了一半：那份草稿从前是**另一个文件**，
 *   与树分开删，于是"删了一半"是一种可能的状态。
 */
function discardStaged(stagedDir) {
  if (typeof stagedDir !== 'string' || !stagedDir) return { ok: false, error: '没有指定要丢掉哪一份。' };
  try {
    fs.rmSync(stagedDir, { recursive: true, force: true });
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
 * ★ 删的是**记录表与树两样**（`removeSlot`，先表后树）。站点那一份一个字节没动 ——
 *   下一次对账还会把它取回来、再问一次。这正是 §5.3 要的：删除是一个没说出口的
 *   决定，而对账不认识它。
 */
function dropPooledVersion(siteRoot, id, version) {
  if (typeof id !== 'string' || typeof version !== 'string' || !id || !version) {
    return { ok: false, error: 'id 与版本都必须是字符串。' };
  }
  return removeSlot(siteRoot, id, version);
}


module.exports = {
  // ── 对账与三个动作（同意 / 不同意 / 删掉本机那一份）──
  sync, acceptStaged, discardStaged, dropPooledVersion, noteConsent,
  siteKeyOf, siteLabelOf,
  // ── 池的形状（槽位、记录表、清扫）──
  listPooled, sweepPool, readSlot, removeSlot,
  // ── 快照表（`.sites.json`）：整个池的引用计数，与上面那些记录表**不是一回事** ──
  readSnapshot, writeJsonAtomic, snapshotPathOf,
  // ── 给用例与目录模式用的纯函数 ──
  checkRelPath, checkDeclared, caseCollisions, effectiveLimits,
  deliveryOf, packageMetaProblem, fileListOf, pinVerdict, verifyStaged,
  compareTree, treeFault, recordSig, treeSignature,
  HARD_LIMITS, SNAPSHOT_NAME, LOCK_NAME,
};
