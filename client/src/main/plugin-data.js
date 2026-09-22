'use strict';
/**
 * plugin-data.js —— 插件**运行时数据**的身份：一份数据存在哪儿、和谁共用。
 *
 * ── 它要解决什么 ────────────────────────────────────────────────────────────
 *
 * 插件在运行中会产生**用户数据**，最实在的一个例子是 code-server 的编辑器布局与
 * 登录 cookie（丢了要重新摆一遍）。这类数据必须落在一个**跟着插件走、而不是跟着
 * 会话走**的地方 —— 会话（一个 Slurm 作业）会结束，而数据要活过它。
 *
 * 于是每个插件都要回答两个问题：**跨版本共不共享**、**跨实例分不分开**。两个都
 * 由**作者在清单里声明**（`contributes.data`）—— 只有作者知道自己的新版本读不读
 * 得懂旧数据。
 *
 * ── 两条轴、两个缺省 ────────────────────────────────────────────────────────
 *
 *   身份 = <插件 id> / <共享组> / [<实例>]
 *
 *   · **共享组**：`data.inherit` 写了什么就是什么（几个版本写同一个组名 ⇒ 它们
 *     共用一份）；**不写 ⇒ 回落成这个插件的版本号**，于是每个版本各一份。
 *   · **实例**：`data.perInstance: true` 才存在这一段（每个实例一份）；**不写 ⇒
 *     整段不存在**，所有实例共用一份。
 *
 * ★ **两个缺省都落在安全侧。** 这不是"还没想好"，是一条刻意选的方向：
 *
 *   · 不声明继承 ⇒ 新版本拿不到旧数据。反过来（默认继承）会让一个改过数据格式的
 *     新版本读到自己读不懂的东西 —— 用户看到的是界面一片错乱，而不是一句"升级
 *     之后布局要重配"。
 *   · 不声明分实例 ⇒ 只有一份。实例段是常量时两份实例必然落在同一个目录里，各写
 *     各的 ⇒ **静默损坏，而两边都以为自己成功了**。这也正是"同一个插件不许同时
 *     开两份"那条规则的**来源** —— 它不是另外焊上去的一条限制，是这一格的推论。
 *
 * ★ **"共享"不是三选一的模式**，而是同一个声明写了什么：都写同一个组名 = 多对一；
 *   分组写 = 多组对多组；不写 = 每个对每个。写成枚举就得额外回答"缺省是哪一个"，
 *   而那正是这个仓库一路在删的形状（要靠记才不搞错的东西）。
 *
 * ── 身份怎么变成一个落点 ────────────────────────────────────────────────────
 *
 * `identityOf` 给出的是**段的数组**，落点由读者各拼各的：
 *
 *   · 浏览器的存储分区 = `partitionOf(identity)` —— 段之间用 `@`
 *   · 磁盘上的目录名 = `diskNameOf(identity)` —— 同一份身份，**折叠过**
 *   · （将来）插件的数据目录 = 段之间用路径分隔符
 *
 * ★ 三个落点从**同一个身份**长出来，这是这个模块存在的全部理由：分别拼的话，
 *   "同一份数据"在分区名与目录名里会变成几个可以各自漂开的字符串。
 *
 * ── ★ 磁盘上的目录名与分区名的差别：折叠 ────────────────────────────────────
 *
 * Electron 44 的 `electron_browser_context.cc`：
 *
 *     MakePartitionName(input) = EscapePath(ToLowerASCII(input))
 *     path = PathService(DIR_SESSION_DATA) / "Partitions" / MakePartitionName(分区名去掉 'persist:')
 *
 * 也就是说**落盘时被 ASCII 折叠过**，而 `EscapePath` 的逃逸集里**没有 `@`**
 * （也没有 `.` `-`，逃的是 `#%:<>?[\]^`{|}` 与控制字符、非 ASCII）。两件事各有一个
 * 结论：
 *
 *   · 折叠只影响**插件 id** 那一段（ULID 是大写）—— 共享组与实例段的字符集本来就
 *     只允许小写，折不动。所以**磁盘上的名字与身份字符串只差 id 段的大小写**。
 *   · ★ 分隔符 `@` 能活着到磁盘上，不是猜的：它是上面那条 `EscapePath` 的直接推论。
 *
 * ★ 于是 `identityOfDiskName` 必须看**小写**的 ULID。而"比较"与"拼路径"要分清：
 *   折叠只用于**比较**（两边都折），路径一律由 `readdir` 拿到的**原始名字**拼 ——
 *   这样"Electron 折不折叠"两种情况下都对。
 *
 * ★ 另注：根是 `sessionData`（`app.getPath('sessionData')`），**不是 `userData`**。
 *   两者今天相同（没人调过 `app.setPath`），所以这是一处恰好对 —— 见
 *   plugin-data-audit.js 里那段注释，别顺手改成 `userData`。
 *
 * ── ★ 分隔符为什么是 `@` ────────────────────────────────────────────────────
 *
 * 分区名就是磁盘上的目录名（Electron 把 `persist:` 后面那一截当成存储目录，再折叠）。
 * 所以分隔符**不能**是 `/`，也不能是任何在某个平台上会被当成分隔符、或者会被
 * `EscapePath` 改写的东西。`@` 两个都不是，而且它在这个仓库里还有先例：信任台账的
 * `id@版本`、`once()` 的分桶键、会话的 `service_plugin` 解析键 —— 都是"两段身份拼成
 * 一个字符串"。
 *
 * ── ★ 段的字符集各由谁保证 ──────────────────────────────────────────────────
 *
 * 三段都进路径，而三段**各在自己的入口处**被查过，这里不重复查：
 *
 *   · 插件 id  —— `plugins/index.js` 的 `inspectDir`（必须是 26 字符的 ULID）；
 *   · 共享组   —— 同一处（`GROUP_RE`，就在下面）；
 *   · 实例     —— `config.js` 的 `normalizeLayout`（`LAYOUT_ID_RE`；`config.json`
 *                 是用户能手改的，所以那一格必须查）。
 *
 * ★ 在这里再查一遍是**不可观测的**冗余，而不可观测的防线会被当成防线 —— 见
 *   `plugins/index.js` 里 `parseVer` 那段同样的道理。三个入口各自的那条正则才是
 *   真正拦人的地方。
 *
 * ★ **共享组那一格的取值空间是两条正则的并**：`GROUP_RE` ∪ 版本号（`VERSION_RE`）。
 *   因为 `inherit` 缺席时那一格**就是**版本号 —— 所以"第二段是组名还是版本号"
 *   这件事在字符串上**判不出来**（`1.0.0` 与一个组名同样合法），只能靠注册表里
 *   那个插件**当前**的版本号与它**声明的**组名去对照才知道。`identityOfDiskName`
 *   因此不猜这件事，只认"这一段是个像样的段"。
 *
 * ── 今天谁在用 ──────────────────────────────────────────────────────────────
 *
 * `partitionOf`：`index.js` 的 `ensureSurface`（建分区）与 `clearLayoutStorage`（回收）。
 * `diskNameOf` / `identityOfDiskName` / `samePartition` / `hasSurface` / `hasLayoutStorage`：
 * `plugin-data-audit.js` 的对账（本机还剩几份、哪一份没人用）。
 * ★ **`ctx.dataDir()` 今天一个真消费者都没有**（sshd 落在 `~/.slurmate/ssh/` 的那几个
 *   文件是**可丢弃的缓存**：`ensureRelayKey` 会复用已有那把钥匙，但丢了没有任何后果），
 *   所以它不在这里 —— 一个没有读者的接口与"意图写了、没人用"是同一件事。它连同
 *   sshd 搬家、以及那个"原子写"要不要收成一份实现，都属于下一阶段。
 *
 * ── 词要钉住 ────────────────────────────────────────────────────────────────
 *
 * 这里一律写"**实例**"。今天一个实例就是**一条连接**（挂在一个布局组上）—— 说得更
 * 准：实例键是**布局组**，因为"一个布局组若干条连接"正是用户自己选的"这几条连接
 * 共用一份"。★ **不要写"会话"**：那个词在代码里已经有主儿 = Slurm 作业
 * （`session_id`、`SessionController`、「开始会话」），写它会读岔 —— 而"每个会话
 * 有自己的配置"这句话按两种读法一对一错。
 */

const ulid = require('./plugins/ulid.js');

/**
 * 共享组的名字。
 *
 * 这是**作者写的字符串**，而它会进分区名 = 磁盘目录名 ⇒ 字符集必须受限。形状与
 * 清单里的 `name`（`plugins/index.js` 的 `NAME_RE`）**逐字相同**，因为两者要的是
 * 同一样东西：一个能安全地出现在路径、报错文案、日志里的短标识。
 *
 * ★ 两处**不合并成一条正则**：它们服务的是两件事（一个进配置块名与会话文件，
 *   一个进分区名与目录名），而合并之后改动一边会静默地同时改另一边。
 */
const GROUP_RE = /^[a-z][a-z0-9-]{0,31}$/;

// ── 大小写折叠：**ASCII-only** ──────────────────────────────────────────────
//
// ★ 它**住在这里**（原先在 `plugins/index.js`），因为它现在有两类消费者：
//
//   · §3.3 那条"同一个包里两条路径禁止只差大小写"（`COPY_SKIP` 在 plugins/index.js，
//     分发与读包都引它）；
//   · **身份字符串与磁盘上的名字之间的那道变换** —— 磁盘名是 `ToLowerASCII` 过的
//     （见文件头），所以"这件事在磁盘上叫什么"这个问题必须先折叠才答得了。
//
//   而 `plugins/index.js` 本来就 require 这个文件，所以折叠放在这一层、由那一层
//   re-export（`plugins.foldAscii` 的调用点一个都不用改）。反过来放就是循环 require。
//
// ★ 折叠**必须**只折叠 `A..Z`，**禁止**用 `String.prototype.toLowerCase()`：
//   后者是全 Unicode 的，会把 `İ`（U+0130）折成 `i̇`、把 `K`（U+212A KELVIN）
//   折成 `k` —— 于是两个实现可以在同一条路径上给出相反的答案，而这是一条
//   **拒绝**规则：一边收、一边拒，症状是"同一个包在一台机器上装得上、在另一台
//   上装不上"，而报错里一个字都不会提到大小写折叠。
//
// ★ ASCII-only 的折叠在 JS / Python / Node 打包器里逐字节相同：没有区域设置，
//   没有 Unicode 版本差异（`toLowerCase` 的结果会随 ICU 版本变）。它也与
//   Electron 那条 `base::ToLowerASCII` 逐字节同义 —— 这正是这里要它对齐的东西。
function foldAscii(s) {
  const t = typeof s === 'string' ? s : '';
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 32) : t[i];
  }
  return out;
}

/**
 * 磁盘上那一段插件 id 的形状 —— **小写**的 ULID。
 *
 * ★ 字母表**从 `ulid.ENCODING` 派生**（折叠一次），不另抄一份：抄一份就会在字母表
 *   变动时静默漂开，而漂开的症状是"某一份数据认不出来"（它会被归进"认不出的目录"，
 *   于是一份本来该能删的数据永远删不掉）。
 */
const DISK_ID_RE = new RegExp(`^[${foldAscii(ulid.ENCODING)}]{26}$`);

/** 插件清单里声明的那一段。**没写**与**写了但不是对象**在这里都是"没有声明" ——
 *  后者进不到这里（`inspectDir` 已经把它拒了），所以这不是一条防线，只是取值。 */
function dataOf(plugin) {
  const d = plugin && plugin.contributes && plugin.contributes.data;
  return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
}

/**
 * 这个插件的身份里**有没有实例段**。
 *
 * ★ 它是给**清理**那条路用的：一个布局组被回收时，只有把布局组当实例段的那些插件
 *   才有"属于这一个组"的存储要清。没声明分实例的插件只有一份存储，它不属于任何
 *   一个组，**绝不能跟着某个组一起被清掉**。
 */
function hasInstance(plugin) {
  const d = dataOf(plugin);
  return !!(d && d.perInstance === true);
}

/**
 * 一份数据的**身份**。
 *
 * @param {object} plugin  注册表里的插件对象（要 `id` / `version` / `contributes.data`）
 * @param {string} [instanceId] 实例段。声明了 `perInstance` 的插件**必须**给出来
 * @returns {string[]} `[id, 组]`，声明了分实例时是 `[id, 组, 实例]`
 *
 * ★ 声明了 `perInstance` 却拿不到实例时**抛**，不回落成两段：那会让所有实例静默地
 *   共用一份数据，而两边都以为自己写了 —— 正是这套缺省要防的那件事，而它一旦发生
 *   是看不出来的（没有报错、没有异常，只有一份坏掉的数据）。
 *
 * ★ 这个抛**够不着**：实例键就是布局组 id，而 `inspectDir` 已经拒了
 *   「`perInstance` 却没有 `layout`」的清单，`loadLayouts` 又保证每条连接都落在
 *   一个存在的组里。留着它是为了让"拿不到实例"有一个**说得出原因**的下场，而不是
 *   变成一句 `Cannot read property of null`。
 */
function identityOf(plugin, instanceId) {
  const d = dataOf(plugin);
  const group = (d && typeof d.inherit === 'string' && d.inherit) || plugin.version;
  const parts = [plugin.id, group];
  if (!hasInstance(plugin)) return parts;

  if (typeof instanceId !== 'string' || !instanceId) {
    throw new Error(
      `${plugin.name || plugin.id} 声明了 contributes.data.perInstance，但这次调用没有`
      + '给出实例。实例段缺失时所有实例会共用一份数据，而两边都以为自己写进去了 —— '
      + '那是一种看不出来的损坏，所以这里宁可停下来。'
      + '（实例键来自布局组：这就是 perInstance 要求 contributes.layout 的原因。）');
  }
  parts.push(instanceId);
  return parts;
}

/**
 * 身份的**浏览器落点** —— Electron 的存储分区名。
 *
 * 结构是"每个插件一份，同一份身份共用"：`perInstance` 声明过的插件，实例不同的
 * 两次会话拿到两个分区（于是能同时开）；没声明的只有一份（于是两份会话写的是同一个
 * 目录 —— 那一格本来就不该同时开）。
 *
 * ★ 这是**给 Electron 用的名字**，不是磁盘上的目录名 —— 后者见 `diskNameOf`。
 */
function partitionOf(identity) {
  return 'persist:' + identity.join('@');
}

/**
 * 身份的**磁盘落点** —— Electron 写在 `<sessionData>/Partitions/` 下的那个目录名。
 *
 * ★ 与 `partitionOf` 只差两件事：**没有 `persist:` 前缀**、**ASCII 折叠过**
 *   （见文件头：`MakePartitionName`）。它只用来**比较**（两边都折），
 *   **绝不用来拼路径** —— 路径一律由 `readdir` 拿到的原始名字拼。
 */
function diskNameOf(identity) {
  return foldAscii(identity.join('@'));
}

/**
 * 磁盘上的目录名 → 身份的段。**认得出来才返回**，认不出来返回 `null`。
 *
 * ★ **它不是判据。** "这一份是不是孤儿"由 `plugin-data-audit.js` 拿"该有的集合"
 *   做差来判 —— 这个函数只用来**写一句人能读的解释**（"这是哪个插件的旧数据"），
 *   以及决定"这一行要不要给删除按钮"。★ 反过来做（拿它当判据）会把**活着的**分区
 *   判成垃圾：`identityOf` 的第二段可以是版本号，而磁盘名是折叠过的，两次变形叠加
 *   之后，"认不出来"与"是老垃圾"根本不是一回事。
 *
 * 判据只有两条：**第一段是（折叠过的）ULID**，段数 2 或 3。第二段**只要求非空** ——
 * 它可以是组名也可以是版本号，字符串上分不出来（见文件头那段）。
 *
 * @param {string} name 磁盘上的目录名（`readdir` 给的那个）
 * @returns {{id: string, group: string, instance: string|null}|null}
 *          `id` 是**折叠过**的那一份（磁盘上就是它）
 */
function identityOfDiskName(name) {
  if (typeof name !== 'string' || !name) return null;
  const parts = name.split('@');
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (parts.some((p) => !p)) return null;
  if (!DISK_ID_RE.test(parts[0])) return null;
  return { id: parts[0], group: parts[1], instance: parts[2] || null };
}

/**
 * 这个插件会**在浏览器里建分区**吗 —— 判据只有一条：有没有界面。
 *
 * ★ 与下面那条**不是一回事**，别合并：没有界面就从来没有分区（`ensureSurface` 第一行
 *   就返回了），所以它是"可能有一份数据"的入口条件；而"那份数据按不按布局组分"是另
 *   一条轴（见 `hasLayoutStorage`）。
 */
function hasSurface(plugin) {
  return !!(plugin && plugin.contributes && plugin.contributes.surface);
}

/**
 * 这个插件的数据**按布局组分开**吗（有界面 **且** 声明了分实例）。
 *
 * ★ 它是**回收一个布局组**时"该清哪些插件"的那条判据：一个组被拆掉时，只有把布局组
 *   当实例段的那些插件才有"属于这一个组"的存储要清。没声明分实例的插件只有一份存储，
 *   它不属于任何一个组 —— 跟着某个组一起清掉，就是把那个插件**唯一**的那份数据删了。
 *
 * ★ 对账那一侧用的**不是**这一条，而是 `hasSurface`（"该有哪些"）：漏掉"有界面、没
 *   声明分实例"的那些，会让**它们活着的那份存储**看起来像孤儿 —— 而界面上会给它一个
 *   删除按钮。两条判据各自服务一件事，名字也说清了是哪一件。
 */
function hasLayoutStorage(plugin) {
  return hasSurface(plugin) && hasInstance(plugin);
}

/**
 * 这个**分区**（`persist:…`，给 Electron 的名字）与磁盘上那个**目录名**是不是同一份。
 *
 * ★ 必须折叠后比：分区名里插件 id 那一段是大写的，而磁盘上那一段是小写的。拿两者
 *   直接 `===` 会**恒为假**，症状是"正被界面用着的那一份也被当成没人用" —— 而那正是
 *   最不能误判的一格（抽掉它的后果见 `index.js` 的 `clearLayoutStorage`）。
 */
function samePartition(partition, diskName) {
  if (typeof partition !== 'string' || !partition.startsWith('persist:')) return false;
  if (typeof diskName !== 'string' || !diskName) return false;
  return foldAscii(partition.slice('persist:'.length)) === foldAscii(diskName);
}

module.exports = {
  GROUP_RE,
  identityOf,
  partitionOf,
  diskNameOf,
  identityOfDiskName,
  samePartition,
  hasInstance,
  hasSurface,
  hasLayoutStorage,
  foldAscii,
};
