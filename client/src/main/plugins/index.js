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
 * plugins/index.js —— 插件注册表。
 *
 * 一个**插件** = 一种服务。一个会话提供哪种服务，就由哪个插件负责把它接起来。
 *
 * ── 一个插件是一个目录，三半 ────────────────────────────────────────────────
 *
 *   <插件目录>/
 *     plugin.json        清单：身份、版本、以及框架会读的那几条声明
 *     client/index.js    客户端侧代码 —— **可有可无**，没有它就是纯声明式插件
 *     job/start.sh       作业侧代码 —— **客户端不看它**，它由站点的部署脚本为
 *                        这个插件织一份 `<jobs>/<ULID>.sbatch`，一个插件一份
 *                        （见 packer/docs/README.md）。**没有它也是合法的** ——
 *                        那样的插件装得上、看得见，但提交不了
 *
 * ★ **目录名不参与任何判定。** 身份来自清单里的 `id`，版本来自 `version`。
 *   目录名纯粹是给人看的，所以仓库里一眼能看出哪个是哪个，而加载器只有一条逻辑。
 *
 * ── 基座不带插件 ────────────────────────────────────────────────────────────
 *
 * ★ **本目录（`src/main/plugins/`）是框架，不是插件目录** —— 里面只有注册表与
 *   铸造 id 的 ulid.js。一个插件都没有，这是**正常状态**，不是安装包坏了。
 *
 * ── 一个根，一条来路 ─────────────────────────────────────────────────────────
 *
 *   `~/.slurmate/site-plugins/`   站点池。**唯一的**池：一个版本是一个**槽位**
 *                                 —— 解出来的树 + 它的记录表（`<id>_<版本>/` 与
 *                                 `<id>_<版本>.json`，见 plugin-slot.js）。对账时会按
 *                                 引用计数回收不再被任何站点要的版本。
 *
 * ★ 池里**没有 `.splug`**：容器只在「站点 → 这里」这一段路上活着，装完就扔
 *   （`unpackTo` 铺出树、记录表记下它该是什么）。
 *
 * ★ **只有一个根。** 加一个新根之前先回答 §5.2 那个问题：它上面每一份凭什么免同意？
 *   答不上来就不许加 —— 理由写在 §5.2 里：「规则一有分支，绕过它的路就会长出来」，
 *   而一个免同意的池会让 §5.1 的「往池目录里手工放置内容**必须**不产生任何效果」
 *   不成立。`boot.test.mjs` 里那条 `roots` 用例钉着的就是这件事。
 *
 * ── ★ 身份是「铸造」出来的，不是「起名」出来的 ──────────────────────────────
 *
 * 一个插件的 `id` 是诞生时铸一次的 ULID（见 ulid.js），此后永不改变。名字可以
 * 随时改，`id` 不行。于是：
 *
 *   · **同一个插件**被两个站点分发 → 两边 `id` 相同 → 池里合并成一条，只多记一个
 *     来源站点。这不是因为谁记得把名字拼对了，而是因为它们本来就是同一个构件。
 *   · **两个站点各写一个 jupyter** → 两个不同的 `id` → **并存**，各自标明来源。
 *     站点升级频繁也好、拒绝升级也好，都不会把对方挤掉。
 *
 * ── ★ 池里 `(id, 版本)` 撞了怎么办 ──────────────────────────────────────────
 *
 * 这是池模型唯一的危险处。按站点分目录时，两个同名插件各在各的目录，客户端
 * **永远不会取错**，撞名最多浪费几十 KB。池里只有一份，取错就是**静默地跑了
 * 另一个插件的代码**，而用户完全看不出来。
 *
 * 规则一条：**同 `(id, 版本)` 而内容摘要不同 → 两个都不加载，并报错。**
 * 绝不挑一个。摘要相同则是同一个构件，合并（多来源）。
 *
 * ★ 这条防**意外**，不防**恶意**：它保证"撞了会被发现并说出来"，不保证"撞不上"。
 *   随机位已经让意外撞上的概率可忽略，而剩下的那种（有人抄了别人的 id）要靠
 *   **站点签名** —— 那在 `.splug` 的签名块那一层（§4、以及客户端的钉子表 §5.4），
 *   不在这里。
 *   ★ 签名是**包信封**的一部分（格式见 packer/docs/PLUGIN-SPEC.md 附录 A），与清单
 *     不在一个地方 —— **没有 `plugin.json.sig` 这个文件**，而且一个裸的清单本来就
 *     没有地方放它。
 *
 * ── 坏插件不许把客户端带崩 ──────────────────────────────────────────────────
 *
 * 每个目录单独 try/catch，不合规的**跳过它并记一条**，其余插件照常工作。这不是
 * 防御性编程，这是需求：「不能因为后来加入或者移除了某个插件而导致崩溃」。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const ulid = require('./ulid.js');
const pluginData = require('../plugin-data.js');
// ★ `plugin-slot.js` 是**叶子**（只 require fs/path/原子写/ulid），所以这一行不会
//   构成环 —— 见那个文件头最后一段。
const SLOT = require('../plugin-slot.js');

const MANIFEST = 'plugin.json';
const CLIENT_ENTRY = path.join('client', 'index.js');

/**
 * 一个插件目录里**不算插件**的东西：版本控制的内部状态，以及"依赖"那一类。
 *
 * ★ **这个集合全仓只有这一份。** 摘要（digestOf）靠它决定"算哪些"，而包解析器靠
 *   它决定"拒哪些"——两边不一致的症状是摘要永远对不上，而原因一个字都指不出来。
 *   ★ 将来若有第二个读者，从**这里**引，不另抄一份 —— 两份抄本会漂开。
 *
 * ★ 它还与**集群侧**那一份逐字对应（`cluster/slurmate-sessiond` 的
 *   `PLUGIN_COPY_SKIP`）。两处分别在 JS 和 Python 里，没有共享机制 —— 所以
 *   `.github/workflows/checks.yml` 里有一条 lint 逐项比对。不上 CI 的话，这条
 *   约定会在第一次有人加一个 `.vscode` 的时候断掉，而症状是"同步永远失败"。
 */
const COPY_SKIP = new Set(['.git', '.github', '.gitignore', '.gitattributes', 'node_modules']);

/** resolve() 认不出来时的答案。**不是**一个能提交的服务，只是客户端内部的一个
 *  判定结果 —— 所以它不可能与任何插件的名字撞上（短名里不允许出现它）。 */
const UNKNOWN = 'unknown';

// ── 清单里允许出现的东西 ────────────────────────────────────────────────────
//
// **未知键报错而不是忽略**：打错一个键名（比如
// `contribution`）不该静默变成一个"配了但不生效"的插件。
//
// ★★ 下面这五张表**不是**这条规则唯一的落点：判据的书面形式在
//    `tools/manifest-keys.json`，守护进程那一侧也持有一份同样的，而
//    `client/test/manifest-keys.test.mjs` 与 CI 的 lint 逐字比对这三处。
//    三处必须一致：只有一侧有白名单的话，"一份把 contributes 拼错的清单：客户端拒、
//    守护进程收"，而站点能把一个任何客户端都装不上的插件正常分发出去，**没有任何
//    东西会红**（账本 S12）。
//
//    ★ 为什么不直接在运行期读那份 JSON（那本来是最结实的形状）：客户端是一个
//      **分发单元**，运行期只读 `client/` 里的东西 —— 唯一一处往外走的是开发者
//      模式的 `defaultDevPluginSourceDir()`，而它**显式处理"安装包里没有它"**。
//      这里写一条 `path.join(__dirname, '..', '..', 'tools', ...)` 的话，**从源码
//      跑通、装出去就断**：这份表成了空集，于是"什么都不拒"。那条路只有装出去的
//      机器上才会露出来 —— 所以不选它。理由与代价都写在那个 JSON 的 `_` 段里。

// 顺序与那份 JSON 逐字相同（比对是**有序**的，不只是集合相等）。
const MANIFEST_KEYS = ['id', 'name', 'displayName', 'version', 'description',
  'author', 'engines', 'contributes', 'site'];
// ★ **`defaultService` 不在这个清单里**：它答的是"**本站**的缺省服务是哪一个"
//   —— 那是**站点**的事（配置里的 `default_plugin`，见 `cluster/slurmate`），不是
//   某个客户端本地的约定：两边各存一份只会漂开，而漂开时没有任何东西会红（客户端的
//   界面**从不省略**服务名，每个启动按钮绑的都是 `startWith(p.name, btn)`）。
const CONTRIBUTES_KEYS = ['surface', 'login', 'ports', 'submitPubkey',
  'concurrent', 'data'];
/**
 * 一个插件的这一份数据最多占几个本地端口。
 *
 * ★ 今天恰好是 1，而它**不是**一条产品判断 —— 框架只用得到第一个：一条会话只有一条
 *   隧道，而作业侧只报得到一个候选端口（`cluster/run.sbatch` 的 `SLURMATE_CANDIDATES`）。
 *   所以 2 是一句**框架做不到的话**，判在装之前、报出原因（见下面 `ports` 那一段）。
 *   ★ 挪这个数不需要动盘上的形状：`config.json` 里 `spaces[].ports` 从第一天就是列表。
 */
const MAX_PLUGIN_PORTS = 1;
/** `contributes.data` 里认识的键 —— 见 plugin-data.js 的文件头。
 *  ★ 这两个键答的是**同一格**（身份的第二段），所以同时写是矛盾（判定在下面）。 */
const DATA_KEYS = ['inherit', 'perVersion'];
const SURFACE_KEYS = ['kind', 'path'];
const SURFACE_KINDS = ['web'];
const LOGIN_KEYS = ['path', 'field', 'cookie'];
/**
 * 客户端代码允许导出的钩子。
 *
 * ★ **本地端口不是插件的事**：要数据空间的会话用**它那一份数据**
 *   的端口（`index.js` 的 `spacePortOf`：先查配置、再查临时那份），没有的用中转
 *   基准端口。这两个值基座自己就能算 —— 一个让插件回报端口的钩子只会让它把基座的
 *   值原样报回来。
 *   ★ **声明要几个**（`contributes.ports`）与**自报是哪几个**是两件事：前者是这个
 *     插件的界面要用几个 origin（只有作者知道），后者是这台机器此刻哪些端口空着
 *     （只有基座知道）。清单里那一格要的就是前者。
 *   ★ 从一个客户端代码导出它是**错误**（`keysProblem` 会拒），不是"被忽略" ——
 *   静默忽略会让一个旧插件看起来装上了、而它的选择从头到尾没生效。
 *
 * 插件要的"这条会话属于哪条连接"由 `ctx.connection()` 给（见 index.js 的
 * pluginContext），那是一个**读**的能力，不是一个让插件回报偏好的口子。
 */
const CLIENT_HOOKS = ['prepare', 'attach', 'closeWarning'];

/**
 * 站点短名的字符集。它进那份插件配置的**文件名**、进会话文件、进日志与报错文案 ——
 * 会在这些地方变成一个说不清的问题（空格、斜杠、大小写）。
 *
 * ★ 短名**不需要全球唯一** —— 全球唯一是 `id` 的事。两个站点各有一个 `jupyter`
 *   指的是两个不同的 `id`，客户端按来源连接区分。
 *
 * ★★ **短名不需要站点内唯一**（见 `packer/docs/PLUGIN-SPEC.md` §2.2）。守护进程
 *   **不保证**它唯一，所以本文件里任何"按短名找"的地方都必须自己处理歧义 ——
 *   拿不准就**不猜**（见 `pickForSubmit` 在歧义时返回 `{plugin: null, ambiguous: [...]}`）。
 */
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

// ── 版本号：两套方案，一条比较规则 ──────────────────────────────────────────
//
// ★ 这个仓库里有**两套**版本号。它们长得像、纪律共用，但**不是一回事**：
//
//   · **框架版本** `x.y` —— 客户端、守护进程、协议**三合一的那个号**。四处声明
//     由 CI 比对（.github/workflows/checks.yml 的「版本号」那一步）。
//     `x` 是"可以不兼容"那一档，`y` 是"加东西但不破坏兼容"那一档 ——
//     所以 **同 `x` 且客户端不低于服务端 ⇒ 保证兼容**，见 `versionCheck`。
//
//     ★ 运行期**有一条版本握手**：客户端连上时问一次 `ping`（它报 `version`，
//       所以这条规则对每一个守护进程都有效），拿双方
//       版本判一个态。★ **守护进程那一侧不做这条检查** —— 它拿不到客户端的版本
//       （老客户端不带），所以那半条要求只能由客户端自己执行。见 docs/PROTOCOL.md。
//   · **插件版本** `x.y.z` —— `(id, 版本)` 那个槽位的键，进摘要台账、进会话键。
//
// ★ **框架版本与插件版本必须分开解析**：一个 `parseVer` 同时伺候两者时，
//   `0.6` 会变成 `[0, 6]`，而它与 `[0, 6, 0]` 既不能比、也不**该**比。
//
// 两套共用的纪律（与 packer/docs/PLUGIN-SPEC.md §2.3 逐条对应）：
//   · **禁止前导零** —— 下面两条正则已经把它挡在外面；
//   · `minor` 那一段 ∈ `0..255` 用 `SEG_BYTE` 表达，`major` 无上限用 `SEG_ANY`；
//   · **逐段按十进制字符串比较**（先比长度、再比字典序），**禁止转机器整数**
//     —— IEEE 754 双精度在 2^53 以上失精，会让 `9007199254740993.0.0` 与
//     `…992.0.0` 判等，而 Python 那边的 `int` 不失精 ⇒ **两侧不一致**。
//
// ★ **只校验，不归一化**：谁都不许把 `1.256.0` 改写成 `2.0.0`。那是静默改版本号，
//   与 §2.4「一个 `(id, 版本)` 只有一份内容」直接冲突 —— 用户同意过的那个版本号
//   会在他没看见的情况下变成另一个，而"改了内容就升版本号"这条纪律就断了。
//
// ★ 结论写在 tools/version-fixtures.json 里，JS 与 Python 的用例**读同一份** ——
//   两套实现的规则必须逐条一致，而"只有一份"比"两份抄本 + 一条比对 lint"结实。

/** 一段 `0..255`，无前导零。`25[0-5] | 2[0-4]\d | 1\d\d | [1-9]\d | \d` 恰好是 0..255。 */
const SEG_BYTE = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
/** 一段**无上限**的十进制数，无前导零。 */
const SEG_ANY = '(?:0|[1-9][0-9]*)';

const FRAMEWORK_VERSION_RE = new RegExp(`^${SEG_ANY}\\.${SEG_BYTE}$`);
/** 插件版本。名字沿用旧的：清单校验、报错文案都指着它。 */
const VERSION_RE = new RegExp(`^${SEG_ANY}\\.${SEG_BYTE}\\.${SEG_BYTE}$`);

// ── 版本比较 ────────────────────────────────────────────────────────────────

/**
 * 解析一个版本号，返回**十进制字符串**的段数组；不合形状返回 `null`。
 *
 * ★ 返回字符串而不是数字，是这套规则的全部要点（见上面关于 2^53 的那段）。
 * ★ **不 trim**：`" 1.0"`、`"1.0\n"` 都不是合法版本号。**校验用的是原串** ——
 *   清单那一层是 `inspectDir` 的 `VERSION_RE.test(mf.version)`（Python 侧是
 *   `need_str`）。Python 那边若先 `strip()` 再匹配，"带空格的版本号"在
 *   一侧被收下、在另一侧被拒 —— 同一份夹具里那几条带空白的用例钉的就是它。
 *
 * ★ 这里是**第三处**同样的纪律，而它今天是**不可观测的**：所有调用方喂进来的串
 *   都已经过了上面那道门（`hostVersion()` 读的是 `package.json` 版本号的**前两段**，
 *   范围片段被 `split(/\\s+/)` 切过，`cmpPluginVer` 的两个参数来自已校验的清单）。
 *   留着它是为了不让这里悄悄变成一个**更松的入口** —— 也正因为它不可观测，
 *   夹具钉不住它，**别把它当成防线**（变异验证里把这一行改成 `.trim()` 不会让
 *   任何用例变红）。
 */
function parseVer(s, re) {
  const t = typeof s === 'string' ? s : '';
  return re.test(t) ? t.split('.') : null;
}

/** 一段的十进制字符串比较：**先比长度，再比字典序**（等价数值序，且不失精）。 */
function cmpSeg(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 逐段比较两个**同形状**的版本。参数是 `parseVer` 出来的段数组。
 *
 * ★ 段数不同**抛**，不返回 0：那只可能是一个 bug（把框架版本与插件版本比了），
 *   而返回"相等"会让它静默通过 —— 排序看着正常，只是顺序没有意义。
 */
function cmpVer(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    throw new Error(`版本段数不同，不能比：${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }
  for (let i = 0; i < a.length; i++) {
    const c = cmpSeg(a[i], b[i]);
    if (c) return c;
  }
  return 0;
}

// ── 大小写折叠：**ASCII-only** ──────────────────────────────────────────────
//
// ★ 它**搬到 plugin-data.js 去了**：身份的**磁盘落点**是折叠过的
//   （`MakePartitionName` = `EscapePath(ToLowerASCII(分区名))`），所以折叠从
//   "§3.3 的一条路径规则"变成了"身份字符串与磁盘上的名字之间的那道变换"，它必须
//   住在依赖图的下面那一层（这一层本来就 require 那个文件；反过来就是循环 require）。
//   为什么**禁止** `toLowerCase()`，那段理由住在 `plugin-data.js` 那一侧。
//
// ★ 这里只 re-export 一份：`COPY_SKIP` 与 §3.3 那条"同一个包里两条路径禁止只差
//   大小写"仍然住在这个文件里，而分发（site-plugins）与读包（plugin-package）引的是
//   `plugins.foldAscii` —— 调用点一个都没变，规则也仍然只有一份实现。
const foldAscii = pluginData.foldAscii;

/**
 * 两个**插件版本串**的大小（`Registry.list()` 的排序用）。
 *
 * ★ 不合形状就抛：走到这里说明清单校验漏了（`version` 在 `inspectDir` 里已经
 *   按 `VERSION_RE` 查过一遍）。悄悄当成相等会让"同一短名的两个版本"顺序随机。
 */
function cmpPluginVer(a, b) {
  const pa = parseVer(a, VERSION_RE);
  const pb = parseVer(b, VERSION_RE);
  if (!pa || !pb) {
    throw new Error(`插件版本号不合形状：${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }
  return cmpVer(pa, pb);
}

/**
 * `engines.slurmate` 的范围判定 —— 比的是**框架版本**（`x.y`）。
 *
 * 支持 `>= > <= < =` 这几种比较符，空格分隔，**全部满足**才算通过。
 * （`>=0.5 <0.7` 这种就够用了；故意不支持 `^` / `~` / `||` —— 那些的语义
 * 各自都有坑，而这里要的是"装之前就能判定"，不是"尽量满足"。）
 *
 * ★ 范围串本身**两侧都 trim**（它是人写的表达式，不是版本号），而片段里的
 *   版本号**一律不许 trim** —— `">= 0.5"` 是一个看不懂的片段，不是 `>=0.5`。
 */
function satisfies(version, range) {
  const v = parseVer(version, FRAMEWORK_VERSION_RE);
  if (!v) return { ok: false, why: `版本号 ${JSON.stringify(version)} 不是 x.y 形式` };
  const r = rangeProblem(range);
  if (r.why) return { ok: false, why: r.why };
  for (const p of r.parts) {
    const d = cmpVer(v, p.ver);
    const ok = p.op === '>=' ? d >= 0 : p.op === '<=' ? d <= 0
      : p.op === '>' ? d > 0 : p.op === '<' ? d < 0 : d === 0;
    if (!ok) return { ok: false, why: `本客户端是 ${version}，不满足 ${range}` };
  }
  return { ok: true };
}

/**
 * 把范围串拆成片段，**只校验形状**（与 host 无关）。返回 `{parts:[{op, ver}]}`
 * 或 `{why}`。
 *
 * ★ 与 `satisfies` 分开，不是为了复用，是因为**它俩要回答的问题不同**：
 *   `satisfies` 把"看不懂这个范围串"与"看得懂但不满足"合并成同一个 `ok:false`
 *   —— 对它的调用方而言后果确实相同（这个插件不收下）。但 `enginesProblem`
 *   必须把这两件事**分开**（`malformed` 与 `unsatisfied`），而**打包器**更要
 *   分开：一个读不懂的范围串是**形状**问题，作者在自己机器上就该看见它，
 *   而不是等包装到别人的站点上，才变成一句听起来像"本站版本低"的拒绝。
 *
 * ★ `^0.5` 是一个具体的现场：它在 `version_satisfies` 里与"不满足"长得一模一样，
 *   而它是**规范的**拒绝（§2.3.1 明令不支持 `^`）。夹具 `engines` 段里那一条
 *   把它钉成 `malformed`，正是为了不让它被当成"不满足"混过去。
 */
function rangeProblem(range) {
  const raw = String(range).trim().split(/\s+/).filter(Boolean);
  if (!raw.length) return { why: '范围是空的' };
  const parts = [];
  for (const p of raw) {
    const m = /^(>=|<=|>|<|=)?(.*)$/.exec(p);
    const c = m && parseVer(m[2], FRAMEWORK_VERSION_RE);
    if (!c) return { why: `看不懂的范围片段 ${JSON.stringify(p)}（版本号是 x.y 形式）` };
    parts.push({ op: m[1] || '=', ver: c });
  }
  return { parts };
}

/**
 * 两个**框架版本串**的大小。
 *
 * ★ `order.framework` 那六条夹具若靠 `satisfies` 的两个闭区间夹出来
 *   （`>=b` 且 `<=b`），那就是"用范围判定去测大小比较"—— 排序规则一旦写错，
 *   夹具跟着一起错，而它看不出来。两侧都走真的比较器就没有这个洞。
 *
 * 不合形状就抛，理由同 `cmpPluginVer`：走到这里说明调用方漏了一道门。
 */
function cmpFramework(a, b) {
  const pa = parseVer(a, FRAMEWORK_VERSION_RE);
  const pb = parseVer(b, FRAMEWORK_VERSION_RE);
  if (!pa || !pb) {
    throw new Error(`框架版本号不合形状：${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  }
  return cmpVer(pa, pb);
}

/**
 * `engines` 这个键**字段级**的判定：收下 ⇒ `null`，不收 ⇒ 一句为什么。
 *
 * ★ 这一条**两侧必须逐条一致**：一侧只认「`engines` 是个 dict 且 `slurmate` 是
 *   非空字符串」、其余五种形状**静默跳过**，另一侧全拒的话，
 *   `"engines": ">=0.5"`（把对象写成了字符串）就会**一侧收下、另一侧拒了** ——
 *   那个项目点名过的最坏形状，而且它恰好落在夹具够不着的空档里（`inspectDir`
 *   要读文件系统，`ranges` 那一段喂不进去）。
 *
 * ★ 抽成纯函数**不是为了整洁**，是为了让它可被夹具喂：规则要一致的两侧，判据必须
 *   能脱离文件系统被调用。见 tools/version-fixtures.json 的 `engines` 段。
 *
 * 规则：
 *   · **不出现** ⇒ 通过（可选字段）；
 *   · **出现** ⇒ 必须是普通对象（不是 null / 数组 / 标量）、**只允许 `slurmate`**
 *     这一个键、值必须是非空字符串、且能被范围解析并全部满足；
 *   · 有范围要判而 `host` 是 `null` ⇒ **拒**。★ 不是"跳过"：`>=0.0` 对任何真实
 *     host 都成立，所以它失败的原因是"判不了"，而"判不了"绝不许长得像"通过"。
 *     这一格在真实路径里对应"客户端读不到自己的 package.json"。
 *
 * ★ 返回值是 `{kind, why}` 而不是一句话：`kind` 就是夹具里那个 `kind`
 *   （`malformed` / `unsatisfied` / `unknown_host`），**判定**拿它对齐，
 *   **措辞**由各侧自己写 —— 客户端说"本客户端是…"，守护进程说"本站的守护进程是…"。
 *   把措辞塞进共用函数，等于逼两侧说同一句不该相同的话。
 *
 * ★ 参数是**整份清单**，不是 `engines` 那个值。理由：Python 那边
 *   `raw.get("engines")` 对「键不在」与「键是 null」返回同一个 `None`，而这两件事
 *   的处置**正好相反**（通过 / 拒）—— 分不出来的话，那一格就永远测不了。
 *   传整份清单，两边都能问"这个键在不在"，而夹具的那一条可以直接当清单喂进去。
 */
function enginesProblem(manifest, host) {
  const engines = manifest && typeof manifest === 'object' ? manifest.engines : undefined;
  if (engines === undefined) return null;
  if (!engines || typeof engines !== 'object' || Array.isArray(engines)) {
    return { kind: 'malformed', why: 'engines 必须是一个对象，如 {"slurmate": ">=0.5"}' };
  }
  const why = keysProblem(engines, ['slurmate'], 'engines');
  if (why) return { kind: 'malformed', why };
  const rng = engines.slurmate;
  if (rng === undefined) return null;          // 有 engines，但里面没有范围要判
  if (typeof rng !== 'string' || !rng.trim()) {
    return { kind: 'malformed', why: 'engines.slurmate 必须是一个非空字符串，如 ">=0.5"' };
  }
  // 形状先于满足：读不懂的范围串是 `malformed`，只有当它是**规范写得出**的
  // 范围、而 host 够不着时，才是 `unsatisfied`。
  const shape = rangeProblem(rng);
  if (shape.why) return { kind: 'malformed', why: shape.why };
  if (host === null || host === undefined) {
    return {
      kind: 'unknown_host',
      why: '本客户端读不到自己的版本号（client/package.json），所以判不了 '
        + `engines.slurmate = ${JSON.stringify(rng)} 满不满足它`,
    };
  }
  const r = satisfies(host, rng);
  if (r.ok) return null;
  return {
    kind: 'unsatisfied',
    why: `${r.why}（engines.slurmate 是插件自己声明的，升级客户端之后才能装它）`,
  };
}

/**
 * 握手的判定：**客户端版本 × 服务端版本 → 一个态**。
 *
 * ★ 规则只有这一处书面形式（另一处在 docs/PROTOCOL.md 的〈协议版本〉，
 *   夹具 tools/version-fixtures.json 的 `check` 段是它们的判据）：
 *
 *   · 两个 `x` 相同 ⇒ **保证兼容**，前提是客户端不低于服务端。这一格是承诺本身。
 *   · 同 `x` 而客户端更低 ⇒ 服务端要求客户端不低于它自己 ⇒ 要求用户升级。
 *     ★ 这一格**从来没有被承诺过**，所以拦它不与上面那条承诺打架 ——
 *     2.5 的服务端停 2.4 的客户端，而它承诺的是 2.5 与 2.6 一定行。
 *   · 两个 `x` 不同 ⇒ **不判为不兼容**，两个方向都放行，但都要**明确说明**。
 *     理由是一个人可能连多个集群（1.28 一个、2.5 一个），2.x 的客户端不一定
 *     兼容 1.28 ——「不一定，不是绝对不」。
 *
 * ★ `blocked` 与 `verdict` 分开，是因为它们共用同一条判定而**后果不同**：
 *   `x == 0` 是**内测期，不受版本约束**（用户明确定下），该拦的降级成说明。
 *
 * ★ 缺席不是"否"，也**不许**是"静默通过"——每一种缺席都有自己的名字：
 *   · 服务端版本 `null`（对面根本**没有** `ping` 这个 op）⇒ `unknown_server`。
 *     **它不可能比客户端新**，所以放行是对的；但要说明"这次没问到版本号、
 *     结论为什么仍然成立"。缺席的是**探测手段**，不是那条要求。
 *   · 服务端答了、但里面没有一个能用的版本号（含 `undefined`：答了对象却没有
 *     `version` 键）⇒ `not_our_daemon`。★ 这**不是"旧"** —— 它说明这条链路上
 *     答话的东西不像 Slurmate 的守护进程，所以**一个字都不许谈版本**。
 *   · 客户端版本读不到 / 读不懂（`null`，或不合形状）⇒ `unknown_host`。
 *     **连接照常** —— 读不到自己的版本不该把用户整个打死；但**插件安装要拒**，
 *     那一半在 `enginesProblem` 里（它拿不到 host 就拒）。
 *
 * ★ 参数的三态沿用这个仓库的老纪律（`undefined` ≠ `null`）：
 *   `serverVersion` 是**字符串**=问到了；`null`=没问到（对面没有 `ping`）；
 *   **其它一切**（含 `undefined`）=答了，但里面没有一个能用的版本号。
 *   分不开这几件事，"不许把跳过伪装成通过"就变成一句空话。
 */
function versionCheck(clientVersion, serverVersion) {
  if (serverVersion === null) {
    return { verdict: 'unknown_server', blocked: false, order: 0 };
  }
  const b = typeof serverVersion === 'string'
    ? parseVer(serverVersion, FRAMEWORK_VERSION_RE) : null;
  if (!b) return { verdict: 'not_our_daemon', blocked: false, order: 0 };
  if (typeof clientVersion !== 'string'
      || !parseVer(clientVersion, FRAMEWORK_VERSION_RE)) {
    return { verdict: 'unknown_host', blocked: false, order: 0 };
  }
  const order = cmpFramework(clientVersion, serverVersion);
  const major = parseVer(serverVersion, FRAMEWORK_VERSION_RE)[0];
  if (parseVer(clientVersion, FRAMEWORK_VERSION_RE)[0] !== major) {
    return { verdict: 'cross_major', blocked: false, order };
  }
  if (order >= 0) return { verdict: 'ok', blocked: false, order };
  // ★ 例外：`x == 0` 是内测期，不受版本约束 —— 每一次更新都可能有重大架构变动，
  //   所以这个阶段"客户端落后"只说明、不拦。见 docs/PROTOCOL.md。
  //   ★ 到期条件：**1.0 发布时删掉这一行**（连同 `blocked` 那个表达式），
  //     删掉会让 boot.test.mjs 里 `check` 段那两条 `blocked:false` 的红 ——
  //     于是摘除例外是一次刻意的动作，而不是一次手滑。
  const devPeriod = major === '0';
  return { verdict: 'client_behind', blocked: !devPeriod, order };
}

/**
 * 本客户端的**协议版本**（`engines.slurmate` 与 `versionCheck` 拿它比）。
 * 读不到就跳过这项检查。
 *
 * ★ 取的是 `client/package.json` 那个 `version` 的**前两段**，不是整串。
 *   那个字段是三段：npm 与 electron-builder 都要求语义化版本，写 `0.15` 会被
 *   electron-builder 的 `fixVersionField` 当场拒掉（"Invalid version"）。
 *   而协议版本是两段（docs/PROTOCOL.md §〇）。**协议版本 = 包版本的前两段** ——
 *   这条关系就落在下面这一行。
 * ★ 少切这一刀的症状指不回本文件：对站点自报 `0.15.0`，而 `FRAMEWORK_VERSION_RE`
 *   只认两段 ⇒ `parseVer` 给 null ⇒ `versionCheck` 落到 `unknown_host`，
 *   用户看到的是"对面不是我们的守护进程"。
 */
function hostVersion() {
  try {
    return require('../../../package.json').version
      .split('.').slice(0, 2).join('.');
  } catch {
    return null;
  }
}

// ── 加载 ────────────────────────────────────────────────────────────────────

/**
 * 走一遍插件目录，列出它的**组成**。**不执行任何代码。**
 *
 * 返回按相对路径（`/` 分隔）排序的数组，每项：
 *   `{path, kind:'f'|'l'|'d', mode, size, sha256, link}`
 *
 * ★ 这是摘要的原料，也是"这两棵树是不是同一棵"的唯一判据，所以规格必须写死：
 *
 *   · **`COPY_SKIP` 里的东西不进清单** —— 与安装器拷什么、与集群侧发什么，三处
 *     靠同一个集合对齐（见 COPY_SKIP）。
 *   · **符号链接进去，但不跟随**：记的是 `readlink` 那个**目标字符串**。跟随的话
 *     "A 里是链接、B 里是内容恰好等于目标串的普通文件"这两棵树会算出同一个摘要，
 *     而它们的行为天差地别（一个加载 y.js，一个导出一个字符串）。
 *   · **权限位进摘要**（`0644` vs `0755`）。不记的话"摘要相同 ⇒ 树相同"就是假的。
 *   · **空目录也进清单**（kind `d`）。否则"只差一个空目录"的两棵树摘要相同 ——
 *     而安装器的 `copyTree` 会把它建出来，两边对不上。
 *
 * ★ 读不动就**抛**，不吞。吞掉的后果是"一棵树的摘要"变成"一棵残树的摘要"——
 *   那正是这个项目里反复出现的那类谎话，而且它在摘要这一层最不容易被发现。
 */
function readPluginFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      if (COPY_SKIP.has(name)) continue;
      const full = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        out.push({ path: r, kind: 'l', mode: st.mode & 0o7777, size: 0,
                   sha256: null, link: fs.readlinkSync(full) });
      } else if (st.isDirectory()) {
        const before = out.length;
        walk(full, r);
        if (out.length === before) {
          out.push({ path: r, kind: 'd', mode: st.mode & 0o7777, size: 0,
                     sha256: null, link: null });
        }
      } else if (st.isFile()) {
        const buf = fs.readFileSync(full);
        out.push({ path: r, kind: 'f', mode: st.mode & 0o7777, size: buf.length,
                   sha256: crypto.createHash('sha256').update(buf).digest('hex'),
                   link: null });
      }
    }
  };
  walk(dir, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * 整目录的内容摘要 —— 「同一个构件」的判据。
 *
 * ★ 它从"清单 + 客户端代码两个文件"变成"整棵目录"是有硬理由的：只比那两个文件
 *   时，**多出来一个文件摘要不变**。两棵这样的树会被判成同一个构件而合并，于是
 *   "用户同意的"与"实际加载的"可以不是同一棵树。
 *
 * 字段之间用 `\0` 分隔而不是空格：路径里可以有空格，用空格分字段的话
 * `"a 644 3 x"` 这样的路径名能让两条不同的记录拼出同一个串。
 * 路径里不可能有 `\0`（它来自 `readdir`），所以 `\0` 分隔是无歧义的。
 *
 * ★ **不包含目录名**（目录名不参与任何判定）、不包含站点签名（签名的内容正是
 *   这个摘要）。池里两条摘要相同的记录是同一个东西，摘要不同就是两个东西在抢
 *   同一个 `(id, 版本)`。
 */
function digestOf(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f.kind); h.update('\0');
    h.update(f.path); h.update('\0');
    h.update(String(f.mode)); h.update('\0');
    h.update(String(f.size)); h.update('\0');
    h.update(f.sha256 || f.link || ''); h.update('\n');
  }
  return h.digest('hex');
}

function keysProblem(obj, allowed, what) {
  const bad = Object.keys(obj).filter((k) => !allowed.includes(k));
  return bad.length ? `${what}里有认不得的键：${bad.join('、')}（认识的只有 ${allowed.join('、')}）` : null;
}

/**
 * 读一个插件目录的**组成**（清单 + 文件清单 + 摘要）。返回 `{ entry }` 或 `{ error }`。
 *
 * ★ **这个函数绝不执行插件代码。** 它读清单、逐字段校验，把 `client/index.js`
 *   读成文本并**只做语法检查**（`vm.Script` 编译，不运行），再走一遍目录算摘要。
 *   真正的 `require()` 在 `activatePlugin()` 里。
 *
 *   ★ 两趟分开**不是整洁，是同意闸能成立的前提** —— 一边读 `client/index.js`
 *     一边就 `require()` 它的话，"对账结束才 reload()、没同意的不激活"这句话是
 *     **空的**：远端代码会在用户看到对话框之前就在主进程里跑完，点"不同意"什么也
 *     拦不住。所以 `inspectDir` 可以跑在**任何**目录上（包括没同意的），
 *     而 `activatePlugin` 只跑在过了闸的那些上。
 *
 * ★ 每一步失败都**说清是哪个文件的哪个键**。这个函数的报错是"加了插件它就是不
 *   生效"这个症状的**唯一**线索来源，含糊的报错等于没有报错。
 *
 * ★ `inspectDir` **不收 `source` 参数**（账本 S20）：它回答的是"这一份是哪个池给的"
 *   —— 而客户端**只剩一个池**（站点池）之后，那个值恒为一项、没有任何读者。
 *   留着它就是留一条"看起来有两条来路"的线索。★ 而根上的 `source` **留着**：
 *   它是出错时说清"哪个根"的诊断标签（见 `scanRoot`）。
 */
function inspectDir(dir) {
  const mfPath = path.join(dir, MANIFEST);
  let raw;
  try {
    raw = fs.readFileSync(mfPath, 'utf8');
  } catch (e) {
    return { error: `读不到 ${mfPath}：${e.message}` };
  }

  let mf;
  try {
    mf = JSON.parse(raw);
  } catch (e) {
    return { error: `${mfPath} 不是合法的 JSON：${e.message}` };
  }
  if (!mf || typeof mf !== 'object' || Array.isArray(mf)) {
    return { error: `${mfPath} 的顶层必须是一个对象` };
  }

  let why = keysProblem(mf, MANIFEST_KEYS, MANIFEST);
  if (why) return { error: `${mfPath}：${why}` };

  // id —— 铸造出来的全球唯一标识。见 ulid.js 的文件头。
  if (!ulid.isId(mf.id)) {
    return { error: `${mfPath}：id 必须是 26 个字符的 ULID（见 plugins/ulid.js），`
      + `现在是 ${JSON.stringify(mf.id)}` };
  }

  // name —— 站点内用的短名。那份插件配置的文件名、会话里的 service_kind 都是它。
  if (typeof mf.name !== 'string' || !NAME_RE.test(mf.name)) {
    return { error: `${mfPath}：name 必须匹配 ${NAME_RE}（小写字母开头，`
      + `只含小写字母/数字/连字符），现在是 ${JSON.stringify(mf.name)}` };
  }
  if (mf.name === UNKNOWN) {
    return { error: `${mfPath}：name 不能是 ${UNKNOWN} —— 那是"认不出来"的保留值` };
  }

  if (typeof mf.displayName !== 'string' || !mf.displayName.trim()) {
    return { error: `${mfPath}：displayName 必须是非空字符串` };
  }
  if (typeof mf.version !== 'string' || !VERSION_RE.test(mf.version)) {
    return { error: `${mfPath}：version 必须是 x.y.z 形式，`
      + `现在是 ${JSON.stringify(mf.version)}` };
  }

  for (const k of ['description', 'author']) {
    if (mf[k] !== undefined && typeof mf[k] !== 'string') {
      return { error: `${mfPath}：${k} 必须是字符串` };
    }
  }

  // engines —— 装之前就判定，而不是装上之后在某个角落炸。
  //
  // ★ 判定本身在 `enginesProblem` 里，与守护进程的 `engines_problem` **逐条一致**，
  //   判据两边共用（tools/version-fixtures.json 的 `engines` 段），措辞各写各的。
  //   判定抽成 `enginesProblem` 而不是内联：内联的规则**夹具喂不进去**
  //   （本函数要读文件系统）—— 于是"两侧必须逐条一致"的那一条，恰恰是夹具钉不住
  //   的那一条。
  //
  // ★ 注意"判不了"（读不到自己的版本号）与"不满足"是**两句不同的话**：
  //   前者是客户端这一侧的安装问题，说成"这个插件用不了"会把用户指去找作者。
  const engProblem = enginesProblem(mf, hostVersion());
  if (engProblem) return { error: `${mfPath}：${engProblem.why}` };

  // site —— **给集群侧读的那一段**：默认资源、可执行文件怎么找、那份插件配置里允许
  // 哪些键。客户端一个字都不用，但必须**接受**它（否则一份合法清单会被客户端
  // 判成"认不得的键"）。
  //
  // ★ 客户端**不做深究**：一个键名打错（`defualtCpus`）由守护进程在扫描时报错
  //   并说清是哪个目录 —— 它才是这一段的主人。每一侧只校验自己真正会读的东西，
  //   否则"客户端先升级、站点后升级"这种次序会变成一地鸡毛。
  if (mf.site !== undefined && mf.site !== null
      && (typeof mf.site !== 'object' || Array.isArray(mf.site))) {
    return { error: `${mfPath}：site 必须是一个对象（集群侧读的那一段）` };
  }

  // contributes —— 框架会读的、关于这个插件的一切声明。
  const mfc = mf.contributes === undefined ? {} : mf.contributes;
  if (!mfc || typeof mfc !== 'object' || Array.isArray(mfc)) {
    return { error: `${mfPath}：contributes 必须是一个对象` };
  }
  // ★ 改名提示要排在 `keysProblem` **之前**：否则一份老清单只会得到一句"认不得的键：
  //   layout"，而那句话**指不到新名字**。与 `data.perInstance` 那一条同一个理由。
  //   ★ 它同时是**改形**的提示（开关 → 个数），所以两个值都点出来。
  if (mfc.layout !== undefined) {
    return { error: `${mfPath}：contributes.layout 已经改名成 contributes.ports `
      + '—— 而且从**开关**变成了**个数**（这一份数据要占几个本地端口）：'
      + '要一份数据空间写 contributes.ports: 1，不要写 contributes.ports: 0' };
  }
  why = keysProblem(mfc, CONTRIBUTES_KEYS, 'contributes');
  if (why) return { error: `${mfPath}：${why}` };

  let surface = null;
  if (mfc.surface !== undefined && mfc.surface !== null) {
    const s = mfc.surface;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return { error: `${mfPath}：contributes.surface 必须是一个对象` };
    }
    why = keysProblem(s, SURFACE_KEYS, 'contributes.surface');
    if (why) return { error: `${mfPath}：${why}` };
    if (!SURFACE_KINDS.includes(s.kind)) {
      return { error: `${mfPath}：contributes.surface.kind 只能是 `
        + `${SURFACE_KINDS.join('、')}，现在是 ${JSON.stringify(s.kind)}` };
    }
    const p = s.path === undefined ? '/' : s.path;
    if (typeof p !== 'string' || !p.startsWith('/')) {
      return { error: `${mfPath}：contributes.surface.path 必须以 / 开头，`
        + `现在是 ${JSON.stringify(s.path)}` };
    }
    surface = { kind: s.kind, path: p };
  }

  // login —— 自动登录的**契约值**：往哪个路径 POST、表单字段叫什么、成功之后
  // 应该多出哪个 cookie。
  //
  // ★ 这三个值是**数据**，不是代码，这正是要点。框架实现的是「POST 一个表单、
  //   然后查 cookie」这个通用机制，具体值是插件自述的 —— 所以基座里不需要知道
  //   任何一个具体的网页服务长什么样，而任何一个 web 插件都能自动登录。
  let login = null;
  if (mfc.login !== undefined && mfc.login !== null) {
    const l = mfc.login;
    if (!l || typeof l !== 'object' || Array.isArray(l)) {
      return { error: `${mfPath}：contributes.login 必须是一个对象` };
    }
    why = keysProblem(l, LOGIN_KEYS, 'contributes.login');
    if (why) return { error: `${mfPath}：${why}` };
    // 没有界面就没有"登录"可言 —— 这一条多半是清单写错了，而不是刻意为之。
    if (!surface) {
      return { error: `${mfPath}：contributes.login 需要同时有 contributes.surface `
        + '—— 没有界面就无所谓自动登录' };
    }
    if (typeof l.path !== 'string' || !l.path.startsWith('/')) {
      return { error: `${mfPath}：contributes.login.path 必须以 / 开头，`
        + `现在是 ${JSON.stringify(l.path)}` };
    }
    for (const k of ['field', 'cookie']) {
      if (typeof l[k] !== 'string' || !l[k].trim()) {
        return { error: `${mfPath}：contributes.login.${k} 必须是非空字符串` };
      }
    }
    login = { path: l.path, field: l.field, cookie: l.cookie };
  }

  for (const k of CONTRIBUTES_KEYS) {
    if (k === 'surface' || k === 'login' || k === 'data' || k === 'ports') continue;
    if (mfc[k] !== undefined && typeof mfc[k] !== 'boolean') {
      return { error: `${mfPath}：contributes.${k} 必须是 true 或 false` };
    }
  }

  // ── ports：这一份数据要几个本地端口 ─────────────────────────────────────────
  //
  // ★ 它是**个数**，不是开关。0 = 不要数据空间（= 从前的 `layout: false`）：没有端口
  //   就没有 origin，也就没有浏览器存储可言。≥1 = 要一份数据空间，占这么多个端口。
  //
  // ★ **有缺省**（不写 = 0），与这一节里别的"事实类"声明同一条纪律：它答的是
  //   "你的界面要几个 origin"，而那是基座**算得出来**的 —— 见 `plugin-data.js`
  //   文件头那张"哪一格基座答得了吗"的表。
  //
  // ★ **上界今天恰好是 1**，而这**不是**一条产品判断：一条会话只有一条隧道、作业侧
  //   只报得到一个候选端口（`cluster/run.sbatch` 的 `SLURMATE_CANDIDATES`），所以
  //   第二个端口**框架兑现不了**。清单要一个兑现不了的数 ⇒ **拒**，而不是收下之后
  //   只兑现第一个 —— 后者正是这个仓库一路在删的「配了但不生效」，而它的症状是
  //   "插件以为自己在用第二个 origin"，没有任何东西会红。
  //   ★ 上界挪动时盘上的形状不用动：`spaces[].ports` 从第一天就是列表。
  if (mfc.ports !== undefined && mfc.ports !== null) {
    if (!Number.isInteger(mfc.ports) || mfc.ports < 0 || mfc.ports > MAX_PLUGIN_PORTS) {
      return { error: `${mfPath}：contributes.ports 必须是 0 到 ${MAX_PLUGIN_PORTS} `
        + `之间的整数（0 = 不要数据空间），现在是 ${JSON.stringify(mfc.ports)}`
        + (Number.isInteger(mfc.ports) && mfc.ports > MAX_PLUGIN_PORTS
          ? ` —— 一个插件的数据最多占 ${MAX_PLUGIN_PORTS} 个本地端口`
            + '（一条会话只有一条隧道，作业侧只报得到一个候选端口）'
          : '') };
    }
  }

  // ── concurrent：这一节里**唯一必填**的一格 ──────────────────────────────
  //
  // ★ 它答的是"**这个插件的代码**能不能同时开两份" —— 一个只有作者知道的事实。
  //   基座推不出来：「一个端口都不要」（`ports: 0`）与「不能同时开两份」是两件事，
  //   把它们焊成一件（`slotOf` 只收一个 spaceId，**看不见插件**）就会读错。
  //
  // ★ **没有缺省**，与这个清单里**别的每一格**刻意相反：它们（`ports` / `submitPubkey`
  //   / `data` 底下那两个键）缺省取哪边都是基座**算得出来**的，所以它可以填
  //   （取哪边是产品判断，见 `data` 那一段）；
  //   而这一格无论缺省取哪一边，都是基座替作者表态 —— 取"不能"，一个真能多开的
  //   作者永远不知道为什么只能开一份；取"能"，一个没想过的作者会得到一个静默的
  //   第二份。**只有他能答，所以必须他答。**
  //
  // ★ 值是**能/不能**，不是数量：能的话开多少份都是同一个逻辑，总数由站点那一侧管
  //   （`max_sessions_per_user`）。类型检查在上面那条循环里（它是布尔键）。
  if (mfc.concurrent === undefined) {
    return { error: `${mfPath}：contributes.concurrent 是**必填**的`
      + '（true = 这个插件可以同时开两份，false = 只能开一份）—— 它答的是"你的代码'
      + '能不能同时处理两份"，只有你知道，基座替你答不了' };
  }
  // ★ 这一条是**组合**判定，两侧各自都不错，错在放一起：第二份 = **第二份数据**
  //   （一份临时的副本），而一份数据存在的全部理由就是它那个端口。一个端口都不要的
  //   插件没有"第一份"可言，也就无所谓"第二份"。
  //   判在**装之前**，与 `engines` 同一条纪律。
  if (mfc.concurrent === true && !(mfc.ports >= 1)) {
    return { error: `${mfPath}：contributes.concurrent: true 要求同时有 `
      + 'contributes.ports ≥ 1 —— 第二份就是第二份**数据**（一份临时的副本），'
      + '而一个端口都不要的插件没有第二份可指（它一律只能开一份）' };
  }

  // data —— **给客户端自己读的那一段**：这个插件的运行时数据存在哪儿、和谁共用。
  //
  // ★ 它与 `site` 那一段正好相对，而**判据是同一条**：每一侧只校验自己真正会读的
  //   东西。`site` 是集群侧读的，客户端只查形状、**不做深究**（打错一个键名由守护
  //   进程在扫描时报错）；`data` 是客户端自己读的，所以客户端要**深究到底**。谁读
  //   决定了谁深究，而不是"哪一段更重要"。
  //
  // ★ 深究到什么程度：共享组的字符集（它进分区名 = 磁盘目录名），两个键的类型，以及
  //   **两个键之间的关系**。
  //   ★ 那条**组合**判定（`perInstance` 要求一个端口）现在跟着那一格在
  //     `concurrent` 上（见上面）。
  //
  // ★★ `inherit` 与 `perVersion` **答的是同一格**（身份的第二段：`plugin-data.js`
  //   的 `groupOf`），所以两个同时写是**矛盾**而不是"后者覆盖前者"。这类"两半各自
  //   都没错、错在放一起"的判定在这个函数里已经有一条先例（`concurrent` 要求
  //   端口 ≥ 1），纪律也一样：判在**装之前**，报错**点名两个键**。
  //   ★ 不判的话症状是两个都"成功"：清单里明明写着要共用一份，而实际落在哪一份
  //     取决于 `groupOf` 里两行的**先后次序** —— 一个改代码顺序就会变的结论，而
  //     没有任何东西会红。
  let data = null;
  if (mfc.data !== undefined && mfc.data !== null) {
    const d = mfc.data;
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      return { error: `${mfPath}：contributes.data 必须是一个对象` };
    }
    // ★ 改名提示要排在 `keysProblem` **之前**：否则老写法只会得到一句"认不得的键：
    //   perInstance"，而那句话**指不到新名字**（它只说"这个键我不认识"）。这一格
    //   还同时搬了家（`data` → `contributes` 底下），所以更要说出来。
    if (d.perInstance !== undefined) {
      return { error: `${mfPath}：contributes.data.perInstance 已经改名成 `
        + 'contributes.concurrent，而且从 data 里搬到了 contributes 底下 —— '
        + '值不变、意思不变：能同时开两份写 true，只能开一份写 false' };
    }
    why = keysProblem(d, DATA_KEYS, 'contributes.data');
    if (why) return { error: `${mfPath}：${why}` };
    if (d.inherit !== undefined
        && (typeof d.inherit !== 'string' || !pluginData.GROUP_RE.test(d.inherit))) {
      return { error: `${mfPath}：contributes.data.inherit 必须匹配 `
        + `${pluginData.GROUP_RE}（小写字母开头，只含小写字母/数字/连字符），`
        + `现在是 ${JSON.stringify(d.inherit)}` };
    }
    if (d.perVersion !== undefined && typeof d.perVersion !== 'boolean') {
      return { error: `${mfPath}：contributes.data.perVersion 必须是 true / false `
        + `（true = 每个版本各一份，false = 与不写它一样），`
        + `现在是 ${JSON.stringify(d.perVersion)}` };
    }
    // ★ 两个键都写 ⇒ 拒。见上面那段：它们答的是同一格，谁赢不该由代码次序决定。
    if (d.perVersion === true && d.inherit) {
      return { error: `${mfPath}：contributes.data.perVersion: true 与 `
        + `contributes.data.inherit: ${JSON.stringify(d.inherit)} 互相矛盾 —— `
        + `前一个说「每个版本各一份」，后一个说「这几个版本共用`
        + `「${d.inherit}」这一份」—— 而两者问的是同一件事（身份的第二段写什么）。`
        + `只能留一个：要每个版本各一份就写 perVersion，要共用一份就写 inherit` };
    }
    data = { inherit: d.inherit || null, perVersion: d.perVersion === true };
  }

  // 客户端代码 —— 可有可无。没有它就是**纯声明式插件**：框架按 contributes
  // 打开界面，不需要执行任何来自插件的代码。
  //
  // ★ 这里**只读、只编译，不 require**。见函数头的说明。
  const clientPath = path.join(dir, CLIENT_ENTRY);
  let clientRaw = null;
  let hasClientCode = false;
  try {
    clientRaw = fs.readFileSync(clientPath, 'utf8');
    hasClientCode = true;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return { error: `读不到 ${clientPath}：${e.message}` };
    }
  }
  if (hasClientCode) {
    // 语法错要在**装之前**就查出来。放到 activatePlugin 里查的话，"文件都下来了"
    // 会被当成对账成功，而真正的失败要等到 reload 才以一句"加载失败"出现 ——
    // 那时用户面对的是"同步完成了但插件没出现"，两件事分不开。
    try {
      new vm.Script(clientRaw, { filename: clientPath });
    } catch (e) {
      return { error: `${clientPath}：语法错（${e.message}）` };
    }
  }

  let files;
  try {
    files = readPluginFiles(dir);
  } catch (e) {
    return { error: `读不到 ${dir} 里的文件：${e.message}` };
  }
  const digest = digestOf(files);

  const plugin = {
    // ── 清单（身份与声明）──
    id: mf.id,
    name: mf.name,
    displayName: mf.displayName,
    version: mf.version,
    description: mf.description || '',
    author: mf.author || '',
    contributes: {
      surface,
      login,
      // ★ 落成**具体的数**（缺省 0），不是 `mfc.ports` —— 上面那一节查的就是它的形状，
      //   而下游（`plugin-data.js` 的 `portCountOf`、`config.js` 的 `assignSpacePorts`）
      //   要的是一个拿起来就能用的整数。与相邻那两格同一条纪律：形状在这一层查实。
      ports: Number.isInteger(mfc.ports) && mfc.ports > 0 ? mfc.ports : 0,
      submitPubkey: mfc.submitPubkey === true,
      // ★ 这一格是**必填**的，所以它在这里**总是**一个实打实的布尔 —— 上面查过
      //   "缺席"与"类型不对"两种。与它相邻的那两个（上面两行）都有安全缺省。
      concurrent: mfc.concurrent === true,
      // ★ `data` 的缺省在这里**不落成具体的值**：`null` 表示"这个插件没声明"，
      //   而"回落成版本号"是 plugin-data.js 的 identityOf 干的事。在这一层就把
      //   缺省填实，等于把那条规则抄成第二份。
      data,
    },
    // ── 加载记录 ──
    dir,
    hasClientCode,
    // ★ **全长** 64 位。截断只留给显示（见 shortDigest）—— 摘要在台账里是判据，
    //   拿 64 位当键就是一个 64 位的碰撞面。
    digest,
    /**
     * 这个插件的代码**现在允不允许加载**。
     *
     * `false` = 它出现在 `list()` 里（用户要看得见、要能点同意），但**不带任何钩子**，
     * 也**绝不进会话解析路径**（`resolve()` 会拒绝它）。见 Registry 的 allows。
     */
    active: true,
    // ── 客户端代码的钩子（全都可以没有）──
    prepare: null, attach: null, closeWarning: null,
  };
  return { entry: { plugin, dir, files, digest,
                    clientPath: hasClientCode ? clientPath : null } };
}

/** 显示用的短摘要。**只用于显示** —— 判据一律用全长的那个。 */
function shortDigest(d) {
  return typeof d === 'string' ? d.slice(0, 16) : String(d);
}

/**
 * 第二趟：真的把 `client/index.js` `require()` 进来，建出带钩子的插件对象。
 *
 * ★ **这一趟就是执行。** 它只允许跑在过了同意闸（或本来就不需要闸）的目录上 ——
 *   调用点见 Registry.reload。
 *
 * ★ 单项失败**不抛**，返回 `{error}`：一个坏插件不许把整次扫描带崩。
 */
function activatePlugin(entry) {
  if (!entry.clientPath) return { plugin: entry.plugin };

  let mod;
  try {
    // 每次都重新加载：注册表可能在同一次运行里被重建（测试会这么用），
    // 而 require 的缓存会让"删掉插件文件"在进程内看起来毫无效果。
    delete require.cache[require.resolve(entry.clientPath)];
    mod = require(entry.clientPath);
  } catch (e) {
    return { error: `${entry.clientPath}：加载失败（${e.message}）` };
  }
  if (!mod || typeof mod !== 'object' || Array.isArray(mod)) {
    return { error: `${entry.clientPath}：必须导出一个对象（可以一个钩子都不写）` };
  }
  const why = keysProblem(mod, CLIENT_HOOKS, '导出的对象');
  if (why) return { error: `${entry.clientPath}：${why}` };
  for (const k of ['prepare', 'attach']) {
    if (mod[k] !== undefined && typeof mod[k] !== 'function') {
      return { error: `${entry.clientPath}：${k} 必须是一个函数` };
    }
  }
  if (mod.closeWarning !== undefined) {
    const cw = mod.closeWarning;
    if (!cw || typeof cw.message !== 'string' || typeof cw.detail !== 'string') {
      return { error: `${entry.clientPath}：closeWarning 必须是 {message, detail} 两个字符串` };
    }
  }
  return {
    plugin: {
      ...entry.plugin,
      prepare: mod.prepare || null,
      attach: mod.attach || null,
      closeWarning: mod.closeWarning || null,
    },
  };
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 找出一个根目录下所有**已提交的槽位** —— 只认
 * `<根>/<id>_<版本>/plugin.json` **且旁边有 `<id>_<版本>.json`** 这一种形状。
 *
 * ★ 判据是**三样**，缺一不可，而它们各挡一件事：
 *
 *   · **名字是槽位的形状**（`plugin-slot.js` 的 `parseSlotName`）—— 挡住池里
 *     那些不是我们写的东西（旧版本的残留、用户随手放的目录）。
 *   · **有 `plugin.json`** —— 一棵读不出清单的树不是一个插件。
 *   · **★ 旁边那张记录表在** —— 这是**提交点**：
 *     树在、记录表不在 ⇒ 那一次安装没提交（我们自己崩在中间留下的），于是它
 *     **不可见**，下一轮对账会把它清掉重取。少了这一格，"写到一半的树"会以
 *     一个插件的身份出现，而"写到一半"与"写完了"看起来一模一样。
 *
 * ★ **旧的那种"一层"形状不许存在**（`<池>/<名字>/plugin.json`，"把插件目录整个
 *   拷进去就生效"）：插件进池子只有"安装一个包"这一个动作
 *   （`packer/docs/PLUGIN-SPEC.md` §5.1），而"同意闸没有例外"要求池里每一份都过闸
 *   （§5.2）。留着它就是留一条绕过同意闸的路 —— 用户往目录里拷一份东西，它自己
 *   就生效了，一个字都不问。别的形状**都落不进这三条判据**（名字里没有 `_`，或者
 *   不是槽位名），所以它们「什么都不发生」—— 与 §5.1 那句「必须不产生任何效果」一致。
 *
 * ★ 目录名**在这里参与判定了**（它带 `id` 与版本，见 plugin-slot.js），所以
 *   `scanRoot` 还要核一件事：它说的那个 `(id, 版本)` 必须与清单里那个**逐字相同**。
 *   名字只是**地址**，身份仍然来自清单 —— 两者不符时谁赢都不对，只有拒绝。
 *
 * ★ 用户不需要知道这个规则，也不需要知道 id 长什么样（那个目录名从不由他手写）。
 *
 * ★ **不是槽位的东西被读到时会「什么都不发生」—— 不报错，是刻意的。** 这个目录是
 *   客户端自己的工作区，往里面拷东西从来不是一条被支持的动作；为它报一条错等于
 *   在界面上承认"这个形状有意义"。§5.1 的措辞正是「必须不产生任何效果」。
 *   （服务端那边相反：`scan_plugins` 见到目录要**明确报错**，因为那是**我们自己的
 *   安装器**留下的、root 拥有的一整套副本。两边读者不同，判断也不同。）
 *
 * ★ **为什么只扫一层**：池里唯一的写方是安装器（`site-plugins.js` 的
 *   `acceptStaged`），而它写出的是**平铺**的 `<id>_<版本>/`（见 plugin-slot.js）。
 *   所以"哪些是池里的插件"这件事**看名字就够**（`parseSlotName`），不必靠"看层数"
 *   —— 两条判据之间因此没有空隙。一个两层的形状里，上面那层（`<id>/`）也从来没有
 *   过自己的含义：版本才是键的第二段。
 */
function findPluginDirs(base) {
  const out = [];
  for (const n of fs.readdirSync(base).sort()) {
    const dir = path.join(base, n);
    if (!isDir(dir)) continue;                  // 记录表、.sites.json 这些不是目录
    const slot = SLOT.parseSlotName(n);
    if (!slot) continue;                        // 不是槽位的形状 —— 不是我们写的
    // ★ 读不出清单的树不是插件。
    if (!fs.existsSync(path.join(dir, MANIFEST))) continue;
    // ★★ 判据是"记录表**读得动**"，不只是"那个文件在"：文件在而读不动 ⇒ 这一份
    //    不可用（写坏了、或者被人改过），而"不可用"与"没提交"在这里的**处置是
    //    同一条**（不加载、被清扫收掉重取）。
    //    ★★ 两处**必须用同一个判据** —— `site-plugins.js` 的 `listPooled` 用的也是
    //       这一个。分家的那天会出现一个"注册表会加载、而列举与回收都看不见它"
    //       的槽位，那种东西谁也修不掉，而它每一轮都照常被 `require()`。
    if (!SLOT.readRecordFile(SLOT.recordPathOf(base, slot.id, slot.version)).ok) continue;
    out.push({ dir, label: n, id: slot.id, version: slot.version });
  }
  return out;
}

/**
 * 扫一个**插件集合目录**：`<集合>/<任意名>/plugin.json` —— 每个子目录是一个插件。
 *
 * ★ 它与 `findPluginDirs` **不是同一个形状，别混**：
 *
 *   | | 扫的是 | 形状 | 谁在用 |
 *   |---|---|---|---|
 *   | `findPluginDirs` | **池**（客户端存插件的地方） | `<id>_<版本>/` | 注册表 |
 *   | 这个函数 | **源目录**（一棵插件树） | `<名字>/` | 打包器、假站点 |
 *
 *   差的那一层是**版本**：池要按 `(id, 版本)` 存，多版本要能并存；而一棵源树里
 *   一个插件就是一个目录，版本写在清单里。仓库的 `plugins/` 就是后者的样子。
 *
 * ★ 清单读不动的**不在这里报错**，而是记进 `skipped`：调用方分两种。假站点照着
 *   守护进程的样子**静默跳过**（那边坏清单就是发不出来的一份东西）；而开发者模式
 *   那个「插件来源」要在界面上**如实说**"这个目录里 3 个目录，只有 1 个能用"——
 *   不然插件作者看到的是一句"一个插件都没有"，而原因在他的清单里。
 *
 * @returns {{plugins:[{dir,name,manifest}], skipped:[{dir,name,why}]}}
 */
function scanPluginCollection(base) {
  const plugins = [];
  const skipped = [];
  if (typeof base !== 'string' || !base) return { plugins, skipped };
  let names = [];
  try { names = fs.readdirSync(base).sort(); } catch { return { plugins, skipped }; }
  for (const n of names) {
    const dir = path.join(base, n);
    if (!isDir(dir)) continue;
    let mf;
    try {
      mf = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    } catch (e) {
      skipped.push({ dir, name: n, why: `读不到 ${MANIFEST}：${e.message}` });
      continue;
    }
    if (!mf || typeof mf.id !== 'string' || typeof mf.version !== 'string') {
      skipped.push({ dir, name: n, why: `${MANIFEST} 里没有 id/version（形状不对）` });
      continue;
    }
    plugins.push({ dir, name: typeof mf.name === 'string' ? mf.name : n, manifest: mf });
  }
  return { plugins, skipped };
}

/**
 * 扫一个根目录，返回 `[{plugin}|{error}]`。根目录不存在**不是错误**。
 *
 * 池目录（`~/.slurmate/site-plugins/`）在第一次对账之前本来就不存在 —— 为一个
 * 还没用上的功能天天报一条错是噪音。**客户端一个插件都没装是正常状态**，不是
 * 安装包坏了。
 *
 * @param {Function} allows  `allows(entry) → boolean`：这个目录现在允许加载吗。
 *
 *   ★ **对每一个目录都问，没有例外。** 不给"纯声明式插件免同意"开口子：一个恶意
 *     的 `plugin.json` 也在往这台机器上放东西（`contributes.login` 能让客户端往
 *     一个 URL POST 一个口令 —— 那是**数据**不是代码，但仍然是站点的指令），
 *     而**规则一有分支，绕过它的路就会长出来**。
 */
function scanRoot(root, allows) {
  const out = [];
  // 根的路径**可以是函数**：客户端的池目录依赖「配置目录」，而那个要等 app ready
  // 之后才知道 —— 在模块加载期就算出来的话，第一次运行会算出一个 null 路径。
  const base = typeof root.dir === 'function' ? root.dir() : root.dir;

  // ★ `null` = **这个根这次不加载**，是一个静默的合法状态（拿不到家目录时站点池
  //   就是 null，见 index.js 的 sitePoolDir —— 一个次要功能的失败不该让整个客户端
  //   起不来）。它与"路径还没准备好"是两件事，别合并：`''` / 未定义是一次
  //   **真的没算出来**（要报），`null` 是**有意为之**（报了就是噪音，而且会让
  //   默认配置看起来像坏的）。
  if (base === null) return out;
  if (typeof base !== 'string' || !base) {
    out.push({ error: `插件根目录 ${root.source} 的路径还没准备好` });
    return out;
  }

  let dirs;
  try {
    dirs = findPluginDirs(base);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return out;
    out.push({ error: `读不到插件目录 ${base}：${e.message}` });
    return out;
  }
  for (const { dir, label, id, version } of dirs) {
    const r = inspectDir(dir);
    if (r.error) {
      out.push({ error: `${label}：${r.error.replace(`${dir}：`, '')}` });
      continue;
    }
    // ★ **名字说的是不是这一份。** 目录名（`<id>_<版本>`）是**地址**，身份来自
    //   清单 —— 两者不符时挑谁都不对：
    //     · 信名字 ⇒ 会话按 `(id, 版本)` 取到一份**自报是别的**构件；
    //     · 信清单 ⇒ 池里两份不同的东西顶着同一个键，而"哪一份在哪"说不清。
    //   所以只有拒绝。★ 它**不是**一条"防恶意"的检查（能写这个目录的人本来就能
    //   改清单），它是"池的记账必须自洽"——不自洽的那一天要在**加载**这一层就
    //   停下来，而不是等到某个会话解析到一份错的东西。
    if (r.entry.plugin.id !== id || r.entry.plugin.version !== version) {
      out.push({ error: `${label}：目录名说的是 ${id}@${version}，而里面的清单自报的是 `
        + `${r.entry.plugin.id}@${r.entry.plugin.version} —— 两者必须逐字相同` });
      continue;
    }
    // ★ 同意闸的落点。**没被允许 ⇒ 停在第一趟**：插件照样出现在 list() 里
    //   （用户要看得见它、要能点同意），但**一个钩子都没有**，`active` 为 false，
    //   于是 `resolve()` 会拒绝它 —— 宁可不做，也不能拿半个插件去接一个会话。
    if (!allows(r.entry)) {
      out.push({ plugin: { ...r.entry.plugin, active: false }, label });
      continue;
    }
    const a = activatePlugin(r.entry);
    out.push(a.error
      ? { error: `${label}：${a.error.replace(`${dir}：`, '')}` }
      : { plugin: a.plugin, label });
  }
  return out;
}

class Registry {
  /**
   * @param {Array<{dir:string|Function|null, source:string}>} [roots]
   *   **省略 = 一个插件都没有**，这是诚实默认值：基座自己不带任何插件。
   *
   *   `dir` 可以是函数，而且**可以返回 `null`** —— 那表示"这个根这次不加载"
   *   （见 scanRoot）。站点池在拿不到家目录时就靠它。
   *
   *   ★ 根的**集合**是构造期固定下来的，能变的只有"这次加不加载"。所以增删一个
   *     根不需要 `setRoots` 那种入口 —— 也不该重建 Registry：重建会清掉 `notices`，
   *     用户会把已经看过的通知重看一遍。
   *
   * @param {object} [opts]
   *   allows {Function} `allows(entry) → boolean`：这个目录的代码现在允许加载吗。
   *   **默认恒真** —— 测试自建的那些根不受影响；**产品里唯一的那一个根传了它**
   *   （见 index.js 的 registry）。
   */
  constructor(roots, opts = {}) {
    this.roots = (roots || [])
      .filter((r) => r && (typeof r.dir === 'string' || typeof r.dir === 'function'));
    this.allows = typeof opts.allows === 'function' ? opts.allows : () => true;
    this.plugins = new Map();      // `<id>@<版本>` → plugin
    this.errors = [];
    /** 每个插件**各自**的上次通知键。见 once()。 */
    this.notices = new Map();
    this.reload();
  }

  /**
   * 重新扫描。**构造时自动调用**，也可以在运行中调（测试用它模拟装/卸插件）。
   *
   * 关键性质：重新扫描**不会**清掉 notices —— 去重状态跟着插件走，不跟着
   * 这一次的对象走。否则重新扫描会让用户把已经看过的通知再看一遍。
   */
  reload() {
    const found = [];
    const errors = [];
    for (const root of this.roots) {
      for (const item of scanRoot(root, this.allows)) {
        if (item.error) errors.push(item.error);
        else found.push(item.plugin);
      }
    }

    // ── 池：按 `(id, 版本)` 归并 ──
    //
    // 同键 = 同一个构件的多个来源 → 合并成一条。
    // 同键不同摘要 = 两个不同的东西在抢同一个身份 → **两个都不加载**并报错。
    //   绝不挑一个：挑错的后果是会话的解析键指过去、客户端静默地跑了另一个
    //   插件的代码，而用户完全看不出来。宁可让这个插件暂时不可用 ——
    //   那种失败是**看得见**的（会话变成"未知服务"，仍然接得上隧道、停得掉）。
    //
    // ★ 「多个来源」今天是**够不着**的：池里一个槽位的**名字**
    //   就是 `<id>_<版本>`，而 `scanRoot` 要求名字与清单逐字相同 ⇒ 同一个
    //   `(id, 版本)` 在池里只可能有一个路径。
    //
    //   这一半**留着**，因为它不只服务"多个根"：下面那条"撞车"的分支是**账本 F20
    //   的落点** —— "本机一个槽位只能有一份内容"这句话在注册表这一侧的守卫，而身份
    //   里不带摘要正是靠那句话才成立（见 plugin-data.js 的文件头）。★ 也因为它
    //   在 `roots` 多起来的那天会立刻重新有意义（构造函数收的就是一个数组）。
    const byKey = new Map();
    for (const p of found) {
      const key = `${p.id}@${p.version}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(p);
    }

    const plugins = new Map();
    for (const [key, group] of [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const digests = [...new Set(group.map((p) => p.digest))];
      if (digests.length > 1) {
        const where = group.map((p) => `${p.dir}（摘要 ${shortDigest(p.digest)}）`).join('、');
        errors.push(`${key}：有 ${group.length} 份内容不同的副本在抢同一个 id 和版本`
          + ` —— 都没有加载。${where}。`
          + '这多半是有人抄了别人的 id，或者改了插件却没升版本号。'
          + '删掉多余的那一份，或者给改过的那份换一个新 id 再试。');
        continue;
      }
      // 摘要一致 → 同一构件，合并成一条（只多记一个来源）。
      //
      // 保留哪一个：优先**带钩子的**那个。摘要相同意味着两棵树的字节一样，所以
      // "哪一份"在内容上无所谓；但它们在**闸门**上可能不同，挑错了会把一个能用
      // 的插件变成不可用。
      //
      // ★ 只剩一个根之后，同一根下两份的 `allows` 答案必然相同 —— 所以这一行
      //   今天**恒等于 `group[0]`**。它没有被删掉，因为 `allows` 是调用方递进来的
      //   谓词（`Registry` 的默认恒真，测试也自己传），它**不保证**对两份给出同一个
      //   答案；而这一行的语义是"按闸门状态挑"，不是"按顺序挑"。真加回第二个根
      //   的那天，它就该重新有意义。
      const first = group.find((p) => p.active !== false) || group[0];
      plugins.set(key, first);
    }

    this.plugins = plugins;
    this.errors = errors;
    return this;
  }

  /**
   * 全部插件，按短名再按版本排序（顺序稳定，界面与日志才不会每次都不一样）。
   *
   * ★ 同一个短名可能有多条（池里同一个插件的多个版本）。**不要**在这里替调用方
   *   去重 —— 用户需要看到"我这儿有两个版本"，那正是他决定升级/回退的依据。
   */
  list() {
    return [...this.plugins.values()].sort((a, b) =>
      a.name.localeCompare(b.name) || cmpPluginVer(a.version, b.version));
  }

  /** 按 `(id, 版本)` 取 —— 这是**会话解析**唯一该用的查法。 */
  get(id, version) {
    return (typeof id === 'string' && typeof version === 'string'
      && this.plugins.get(`${id}@${version}`)) || null;
  }

  /** 按 `(id, 版本)` 取，取不到时返回一条能直接说给用户听的解释。 */
  missing(id, version) {
    const sameId = this.list().filter((p) => p.id === id);
    if (!sameId.length) {
      return `这个客户端里没有 ${id} 这个插件`;
    }
    return `这个客户端里只有 ${id} 的 `
      + `${sameId.map((p) => p.version).join('、')} 版，而会话用的是 ${version} 版`;
  }

  /**
   * 按**短名**取（同一个短名有多个版本时取版本最高的那个）。
   *
   * ★ 这**不是**一条会话解析路径 —— 解析永远走 `(id, 版本)`（见 resolve）。它只有
   *   两个用处：给界面画"当前版本"，以及**站点没报插件标识**时挑一份去提交
   *   （`index.js` 的 `pickForSubmit`）。
   */
  latestByName(name) {
    const hit = this.list().filter((p) => p.name === name);
    return hit.length ? hit[hit.length - 1] : null;
  }

  /**
   * 把一个会话归一成插件。**三种输入，三种答案，一种都不能合并**：
   *
   *   service_plugin 是 `<id>@<版本>`   池里查得到   → 它
   *                                     池里查不到   → UNKNOWN（并说清缺什么）
   *   service_kind 是 `null`／键不存在                → UNKNOWN，**绝不猜**（见下）
   *   其余（认不出的名字、坏掉的 `<id>@<版本>`）→ UNKNOWN，**不退回缺省**
   *
   * ★ 认不出的**不退回缺省**：那等于系统声称一件它并不知道的事，而症状是客户端
   *   拿另一个插件的代码去对接这个作业。
   *
   * ★ 服务端**没说**是哪一种服务时一律 UNKNOWN，`null`（从 nft 规则恢复出来的会话，
   *   服务端也不知道）与"这个键根本不存在"在这里是同一件事。**不要**把它兜到某个
   *   缺省插件上 —— 那违反这里的三态纪律：**缺席不等于可以猜**。
   *
   * @returns {{plugin: object|null, why: string|null}}
   *   `why` 只在"明确要某个插件而它不在"时非空 —— 那是一句能直接说给用户听的话。
   */
  resolve(serviceKind, servicePlugin) {
    if (typeof servicePlugin === 'string' && servicePlugin) {
      const at = servicePlugin.lastIndexOf('@');
      const id = at > 0 ? servicePlugin.slice(0, at) : '';
      const version = at > 0 ? servicePlugin.slice(at + 1) : '';
      if (ulid.isId(id) && VERSION_RE.test(version)) {
        const p = this.get(id, version);
        if (!p) return { plugin: null, why: this.missing(id, version) };
        return p.active === false
          ? { plugin: null, why: inertWhy(p) }
          : { plugin: p, why: null };
      }
      return { plugin: null, why: `控制节点给的插件标识 ${JSON.stringify(servicePlugin)} 认不出来` };
    }

    if (serviceKind === null || serviceKind === undefined) return { plugin: null, why: null };

    // 到这儿只剩一种形状：报了**短名**、却没有可用的 `<id>@<版本>`。短名在池里是
    // **有歧义的**（两个站点可以各有一个同名插件而它们是两个不同的东西），不足以
    // 定位一个会话用的是哪一份 —— 所以不猜，把话说出来。
    return { plugin: null,
             why: `控制节点只报了一个短名 ${JSON.stringify(serviceKind)}，`
                  + '没有报它是哪个插件、哪一版 —— 无法确定这个会话用的是哪一份代码' };
  }

  /**
   * 去重：这个键第一次出现返回 true，之后返回 false。
   *
   * 状态变化是**频繁**的（心跳、隧道重建、每次 status 回来都会走到渲染），
   * 插件在 attach() 里干的活多半是写文件或弹通知 —— 不去重的话用户每 45 秒
   * 收到一条一模一样的通知，等于没有通知，而磁盘上的文件被反复重写，
   * 白白惊动同步/杀毒软件。
   *
   * ★ 它由框架提供而不是各插件自己实现：这是**框架级的关心**（别烦用户），
   *   而且键必须按插件分桶 —— 两个插件各有各的"上次值"，共用一个槽会互相冲掉。
   *
   * @param {string} bucket 分桶用的插件标识（见 bucketOf）
   * @param {string} key    插件自己的"上次值"
   */
  once(bucket, key) {
    const k = `${bucket}|${key}`;
    if (this.notices.has(k)) return false;
    this.notices.set(k, true);
    return true;
  }
}

/**
 * 「这个插件在，但它的代码不许加载」那句话。
 *
 * ★ 与「本机没有这个插件」**必须分得开**：一个是"去装/去同步"，一个是"去点同意"，
 *   而它们在界面上、在这个函数里长得都很像。含糊的一句"未知服务"会让用户以为
 *   插件没装上，跑去重新同步 —— 而同步本来就已经成功了。
 */
function inertWhy(p) {
  return `本机有 ${p.displayName} ${p.version}（${p.name}），但它的客户端代码`
    + '还没有经过你的同意，所以没有加载。在插件那一栏点一下同意就能用它。';
}

/**
 * 去重桶的名字。
 *
 * ★ 带上**版本**，不是只用 id：池里可以并存同一个插件的多个版本，而"这个版本的
 *   插件已经说过这句话了"与"那个版本说过了"是两件事 —— 共用一桶会让刚装上的
 *   新版本一句话都说不出来（它的首次通知被旧版本压掉了）。
 */
function bucketOf(plugin) {
  // 没有插件时给一个**不可能与任何插件撞上**的固定桶。今天到不了这里 ——
  // `ctx` 只在插件非空时才递给插件，所以 `once()` 的调用方一定手里有插件。
  // 但这个位置踩上去会是一个 `TypeError`，而不是一句能读的报错，且**将来**
  // 最容易被踩（框架里任何一处新加的 `plugin &&` 守卫漏写就够了）。
  return plugin ? `${plugin.id}@${plugin.version}` : 'no-plugin';
}

// ★ **导出表就是这个模块对外的承诺**，所以这里只留今天真有人读的名字 ——
//   `UNKNOWN` 不在这里：它是一个保留值，
//   只在 `resolve()` 的返回值里出现，不是给别人比对的常量。留着一个没人读的
//   导出，与 `plugin_payload_index()` 是同一件事：意图写了，而没有任何东西守着它。
module.exports = {
  Registry, bucketOf, satisfies, hostVersion,
  // 版本号那两套（框架 / 插件）—— 用例直接对着 tools/version-fixtures.json 跑
  VERSION_RE, FRAMEWORK_VERSION_RE, parseVer, cmpVer, cmpPluginVer, cmpFramework,
  // 两侧必须逐条一致的两条规则（判据在夹具里，措辞各写各的）
  enginesProblem,      // engines 的字段级判定（守护进程侧是 engines_problem）
  // ★ 「认得的清单键」那五张表也导出去 —— **只给用例**：判据的书面形式在
  //   tools/manifest-keys.json，而这三处必须逐字相同（见上面那一段）。生产代码里
  //   没有别的读者：`inspectDir` 就在本文件里，直接用那几个常量。
  MANIFEST_KEYS, CONTRIBUTES_KEYS, SURFACE_KEYS, LOGIN_KEYS, DATA_KEYS,
  versionCheck,        // 握手：客户端版本 × 服务端版本 → 一个态
  // ── 站点分发那条路要用的（见 site-plugins.js）──
  COPY_SKIP, foldAscii, inspectDir, activatePlugin, readPluginFiles, digestOf, shortDigest,
  // ── 读一棵**源**插件树（不是池）—— 打包器与开发者模式的假站点用 ──
  scanPluginCollection,
};
