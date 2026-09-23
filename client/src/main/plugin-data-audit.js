'use strict';
/**
 * plugin-data-audit.js —— 本机的插件运行时数据：**还剩几份、哪一份没人用**。
 *
 * `plugin-data.js` 回答"一份数据存在哪儿"。这里回答下一个问题：**它现在还在不在、
 * 还有没有主人**。在此之前，这件事在客户端**没有任何判据** —— 引用计数只活在
 * 配置里（`pruneLayouts`），而磁盘上到底躺着几份、哪几份是没人认领的，没有任何
 * 代码看过。
 *
 * ── ★ 判据是"正向算 + 两边折叠做差"，不是"逆向解析磁盘名" ────────────────────
 *
 *     该有的 = { 折叠(身份) : 有分区的插件 × 配置里的布局组 }
 *              ∪ { 折叠(身份) : 有分区的插件、没声明分实例 }
 *     孤儿   = 磁盘上的目录名 − 该有的
 *
 * ★ **反过来做会删掉活数据**，两个坑各自都够：
 *
 *   · `identityOf` 的第二段**可以是版本号**（`inherit` 缺席时它就是版本号），
 *     所以"第二段不匹配 `GROUP_RE`"根本不意味着"这不是我们的东西"；
 *   · 磁盘上的名字是**折叠过**的（`MakePartitionName` = `EscapePath(ToLowerASCII(…))`，
 *     ULID 段落盘是小写）。
 *
 *   两次变形叠加之后，"我解析不出来"与"这是老垃圾"就分家了 —— 而分错的代价是
 *   界面给一份**活着的** cookie 一个删除按钮。
 *   所以 `identityOfDiskName` 在这里**只用来写一句人能读的解释**，不当判据。
 *
 * ── ★ 折叠只用于比较，绝不用来拼路径 ────────────────────────────────────────
 *
 * 路径一律由 `readdir` 拿到的**原始名字**拼（见 `index.js` 里那条删除路径）。
 * 这样"Electron 折不折叠"两种情况下都对，而且界面上给的字符串**永远进不了路径**。
 *
 * ── ★ 一行 = 一个身份（两个落点）────────────────────────────────────────────
 *
 * 这一层不按"插件"或"布局组"分组：**一份数据 = 一个身份**（见 plugin-data.js 的
 * 文件头）。所以"一个没人用的布局组"会在这一层展开成每个插件各一行 —— 那正是
 * 可删除的单位。
 *
 * ★ **一份身份现在有两个落点**：Electron 的存储分区，以及基座给插件的数据目录
 * （`ctx.dataDir()`）。两者是**同一份数据的两个部分**（一个是布局/cookie 这类由
 * 浏览器攒的，一个是插件自己在主进程里写的），所以**一行**，而 `places` 说清这条
 * 身份在哪几个根下真的存在。出两行的话用户得删两次；只列一处的话，删完另一处会把
 * 同一行再带回来。
 *
 * ── ★ 认不出的目录：只列，不给删除按钮 ──────────────────────────────────────
 *
 * 每一行都必须是"认得出是我们的"才提供删除，而且**每一处都认得出**才算。这不是
 * 洁癖：两个根都是**推出来**的（分区那一根见 `partitionRoot`；数据那一根是我们自己
 * 拼的，**没有任何当场核对的手段**），万一推错了，这个列表就会把 `secrets.json`、
 * `dev-sandbox` 之类的东西摆上删除按钮。
 *
 * ★ 两个根允许的形状**不一样**：分区根有两类（三段身份 —— 第一段是折叠过的 ULID；
 *   以及 0.7 之前那三种旧形状 `slot-…` / `layout-…` / `plugin-…`），而数据根**只有
 *   三段身份那一种**（那个目录从诞生起只有这个客户端写过）。判据在 `recognized`。
 *
 * ── ★ 开发者模式不查磁盘 ────────────────────────────────────────────────────
 *
 * 这一层不知道开发者模式（调用方传 `names: null` + 一句 `why`）。理由写在调用点：
 * 沙箱那份配置里的布局组 id 与真实那一份对不上，照它去认，真实的数据会整片看起来
 * 像孤儿 —— 而删掉它们就是毁掉真实那一份。
 */

const fs = require('fs');
const path = require('path');
const pluginData = require('./plugin-data.js');

/** `partitionOf` 的前缀。磁盘上的目录名**没有**它。 */
const PREFIX = 'persist:';

/**
 * 0.7 之前的分区名形状。
 *
 * 三种都来自旧的两半硬编码表达式（见 `index.js` 的 `ensureSurface` 那段注释）：
 * `persist:slot-<槽位>`（0.2.0 及更早）、`persist:layout-<组 id>`、`persist:plugin-<id>`。
 * 它们**认得出是我们的**，所以可以删 —— 留着只有坏处：那里面是没人再读的登录 cookie。
 */
const LEGACY_RE = /^(?:slot|layout|plugin)-/;

/**
 * 分区目录（`Partitions/`）在哪儿，**并且当场核对一遍命名约定**。
 *
 * @param {object} o
 * @param {object} o.session      Electron 的 `session` 模块
 * @param {string} [o.probe]      一个**该有的**分区名（`persist:…`）。省略 = 没得问
 * @param {string} o.fallbackRoot `app.getPath('sessionData')` + `Partitions`
 * @returns {{root: string|null, verified: boolean, why: string|null}}
 *          `root === null` ⇒ **查不了**（`why` 说得出原因）：调用方要如实说"查不了"，
 *          而不是说"没有"。`verified === false`（而 `root` 有值）⇒ 用的是文档里那条
 *          路径，**没能当场核对** —— 那一格由"认得出的才给删"兜着。
 *
 * ★ 为什么根是 `sessionData` 而不是 `userData`：Electron 源码里那一步是
 *   `PathService::Get(DIR_SESSION_DATA)` + `"Partitions"`。**两者今天相同**（没人调过
 *   `app.setPath`），所以这是一处**恰好对** —— 正因为恰好对，它特别容易被下一个人
 *   顺手改成 `userData`，所以理由写在这里。
 *
 * ★ 为什么探针必须是**该有的**身份：`fromPartition` 可能把目录建出来。用一个编造的
 *   名字去问，就等于凭空造一个**不在"该有的"清单里**的目录 ⇒ 用户下一次打开客户端
 *   会多看到一行"没人用的数据"，而那一行是我们自己造的。
 */
function partitionRoot({ session, probe, fallbackRoot }) {
  if (probe && typeof probe === 'string' && probe.startsWith(PREFIX)
      && session && typeof session.fromPartition === 'function') {
    try {
      const ses = session.fromPartition(probe);
      const p = ses && typeof ses.getStoragePath === 'function' ? ses.getStoragePath() : null;
      if (typeof p === 'string' && p) {
        const want = probe.slice(PREFIX.length);
        const base = path.basename(p);
        // 折叠过的那一份与没折叠的那一份都收 —— 我们对"Electron 折不折叠"不设前提，
        // 只要求它落在这两者之一（否则就是约定变了，见下）。
        if (base === want || base === pluginData.foldAscii(want)) {
          return { root: path.dirname(p), verified: true, why: null };
        }
        return {
          root: null, verified: false,
          why: `Electron 把这个分区的目录放在 ${base}，而按名字算它应该是 ${want} —— `
            + '分区目录的命名约定与我们知道的不一样，所以这一次**没有**去认磁盘上的东西。',
        };
      }
    } catch {
      // 问不出来（老 Electron、没有这个方法、app 还没 ready…）不是错误：落到下面
      // 那条文档里写着的路径上去。这一步是**加固**，不是前提。
    }
  }
  return { root: fallbackRoot || null, verified: false, why: null };
}

/**
 * 一个根下真实存在的目录名。
 *
 * ★ 它服务**两个根** —— Electron 的 `Partitions/` 与基座给插件的数据目录
 *   （`ctx.dataDir()` 的根），所以名字里没有"partition"。两个根的形状**相同**：
 *   根下是**一层**目录名、一个名字就是一份数据。于是读取、对账、删除三件事都能共用
 *   （这也是 `plugin-data.js` 里 `dataDirNameOf` 用 `@` 拼成单段名字换来的）。
 *
 * ★ 只认**目录**：根下偶尔会有别的东西（谁手放的文件），而一个文件不是一份存储。
 *   它们也不会进列表 —— 那不是"认不出的目录"，那是"根本不是目录"。
 *
 * @returns {{names: string[]|null, why: string|null}} `names` 为 null ⇒ 查不了
 */
function listDirs(root) {
  if (!root) return { names: null, why: '找不到本机的分区目录，所以这一次没有去认它。' };
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    // 目录不存在 = **本机一份插件数据都没有**（全新安装就是这个样子）。这是一个
    // 肯定的答案，不是"查不了" —— 两者在界面上是完全不同的话。
    if (e && e.code === 'ENOENT') return { names: [], why: null };
    return { names: null, why: `读不到插件数据目录 ${root}：${e.message}` };
  }
  return {
    names: entries.filter((d) => d.isDirectory()).map((d) => d.name).sort(),
    why: null,
  };
}

/**
 * 认得出这是"我们的一份数据"吗 —— ★ **按根各判**。
 *
 * 两个根允许的形状**不一样**：分区根有历史（`slot-…` / `layout-…` / `plugin-…`），
 * 而数据目录那个根**从诞生起只有我们的代码写过**，只可能有三段身份那一种形状。
 * 一个 `slot-1` 出现在数据根里，那不是"更早版本留下的"，那是**数据根取错了** ——
 * 所以它必须在那一处被判成"认不出"，从而把整行的删除按钮拿掉。
 */
function recognized(place, name) {
  // ★ **先折叠**。磁盘上的名字是 Electron 折叠过的（`MakePartitionName`），而
  //   `identityOfDiskName` 与 `LEGACY_RE` 都只认小写那一份。少这一步的症状很难看：
  //   一个名字只要带一个大写字母，整行就变成"认不出的目录" —— 包括**活着的**那些。
  //   `test/plugin-data-audit.test.mjs` 里"大写的那一份也是它"那条钉的就是这里。
  const folded = pluginData.foldAscii(name);
  if (pluginData.identityOfDiskName(folded)) return true;
  return place === 'partition' && LEGACY_RE.test(folded);
}

/**
 * 把"该有的"与"磁盘上有的"对一遍 —— ★ **两个根一起**（分区目录 + 插件数据目录）。
 *
 * @param {object} o
 * @param {Array} o.plugins      注册表里的全部插件（`registry.list()`）
 * @param {Array} o.layouts      `cfg.layouts`
 * @param {Array} o.connections  `cfg.connections`（算引用计数）
 * @param {string[]|null} o.names     分区目录那一根下的目录名；`null` = 没查
 * @param {string} [o.why]            没查分区那一根的原因（原样带给界面）
 * @param {string[]|null} [o.dataNames] 插件数据目录那一根下的目录名；`null`/省略 = 没查
 * @param {string} [o.dataWhy]        没查数据那一根的原因
 * @returns {{rows: Array, diskChecked: boolean, why: string|null}}
 *          `diskChecked` = **两根都查成了**。只要有一根没查，`why` 里会**点名是哪一根**
 *          —— "查不了"与"没有"是两件事，这个界面里最忌讳的就是把它俩说成一件。
 */
function audit({ plugins, layouts, connections, names, why, dataNames, dataWhy }) {
  const diskChecked = Array.isArray(names) && Array.isArray(dataNames);
  const list = Array.isArray(names) ? names : [];
  const dataList = Array.isArray(dataNames) ? dataNames : [];
  const layoutsArr = Array.isArray(layouts) ? layouts : [];

  // ── 该有的：正向算出来，折叠 ──
  //
  // ★ 入口条件是「**注册表里的所有插件**」—— 这一条是本阶段**放宽**的，而它守的是
  //   一个**会删活数据的口子**。从前这里是 `hasSurface`（**有没有界面**），那在分区
  //   那一侧是对的（`ensureSurface` 不看声明就建分区）；但数据目录那个根**不由框架
  //   建** —— 是插件自己调 `ctx.dataDir()` 建出来的，数不出来。照 `hasSurface` 算，
  //   **没有界面的 sshd 那份正在被用的数据一诞生就是孤儿**，界面上一个删除按钮，
  //   而 `~/.ssh/config` 的 IdentityFile / UserKnownHostsFile 正指着它 —— 症状是
  //   "`ssh slurmate` 忽然认证失败"，而用户刚刚点过一个他以为无害的按钮。
  //
  //   放宽是**安全方向**（该有的变大 ⇒ 孤儿变少 ⇒ 删除按钮变少），而在分区那一侧
  //   **不改变任何行为**：多算出来的身份在磁盘上没有目录，不产生行。
  //
  // ★ 一张表服务两个根 —— 靠的是 `plugin-data.js` 里
  //   `dataDirNameOf === diskNameOf`（同一个身份在两个根下叫同一个名字）。
  const all = (plugins || []);
  const expected = new Map();                 // 折叠过的名字 → {plugin, layoutId|null}
  for (const p of all) {
    if (pluginData.hasInstance(p)) {
      for (const l of layoutsArr) {
        if (!l || !l.id) continue;
        expected.set(pluginData.diskNameOf(pluginData.identityOf(p, l.id)),
          { plugin: p, layoutId: l.id });
      }
    } else {
      expected.set(pluginData.diskNameOf(pluginData.identityOf(p)),
        { plugin: p, layoutId: null });
    }
  }

  // ── 引用计数：有几条连接指着这个布局组 ──
  const refs = new Map();
  for (const c of (connections || [])) {
    if (c && c.layoutId) refs.set(c.layoutId, (refs.get(c.layoutId) || 0) + 1);
  }
  const layoutName = new Map(layoutsArr.filter((l) => l && l.id)
    .map((l) => [l.id, l.name || l.id]));

  // 认插件用**折叠过**的 id（磁盘上那个就是折叠过的）。
  const byId = new Map(all.map((p) => [pluginData.foldAscii(p.id), p]));

  // ── 两个根的名字并成一份清单：★ **一行 = 一个身份**，不是"一个落点一行" ──
  //
  // 用户看到的语义单位是"**这个插件的一份数据**"，而浏览器存储与磁盘上的文件是
  // 同一份数据的两个部分。出两行的话他得删两次；而只列其中一处的话，删除之后另一处
  // 会把同一行再带回来（"我明明删过了"）—— 删除本来就该按**身份**分派到所有落点。
  const inPartition = new Set(list);
  const inData = new Set(dataList);
  const everyName = [...new Set([...list, ...dataList])];

  const rows = [];
  for (const name of everyName) {
    const places = [];
    if (inPartition.has(name)) places.push('partition');
    if (inData.has(name)) places.push('data');

    // ★ **每一处都认得出**才给删除按钮。名字在一个根里认得出、在另一个根里认不出
    //   ⇒ 那一处多半意味着**根取错了**，那时把整行藏起来比"只删认得出的那一半"
    //   安全得多。（数据根没有 `partitionRoot` 那种拿探针当场核对的手段，所以这条
    //   是它**唯一**的防线。）
    if (!places.every((pl) => recognized(pl, name))) {
      rows.push({
        name, places, kind: 'unknown',
        label: `认不出的目录「${name}」`,
        why: places.includes('data')
          ? '它在**插件数据目录**里，而这个名字不像一份插件数据（三段身份）。那个'
            + '目录里不可能有更早版本留下的形状（它从诞生起只有这个客户端写过），'
            + '所以这多半意味着**数据目录那一根取错了** —— 而一份我不认识的东西，'
            + '删掉它不是"收拾"而是"猜"。'
          : '它在这个目录里，而它的名字既不像一份插件数据（三段身份），也不像更早'
            + '版本留下的那几种形状。**所以这里不提供删除** —— 一份我不认识的东西，'
            + '删掉它就不是"收拾"而是"猜"。',
        deletable: false,
      });
      continue;
    }

    const hit = expected.get(pluginData.foldAscii(name));

    if (hit) {
      // 在"该有的"里 ⇒ 不是孤儿。只有一种情况值得说出来：
      // **没有任何连接指着它那个布局组**（数据在、没人用）。
      //   没有实例段的那种存储不属于任何组（它本来就一直只有一份），不列。
      if (hit.layoutId === null) continue;
      if ((refs.get(hit.layoutId) || 0) > 0) continue;
      rows.push({
        name,
        places,
        kind: 'unused',
        label: `${hit.plugin.displayName} 的一份数据`,
        why: `它在布局组「${layoutName.get(hit.layoutId) || hit.layoutId}」上，`
          + '而那个布局组现在没有任何连接在用。',
        deletable: true,
      });
      continue;
    }

    // ── 不在"该有的"里 ⇒ 孤儿 ──
    const parts = pluginData.identityOfDiskName(name);
    if (parts) {
      const known = byId.get(parts.id);
      if (known) {
        rows.push(parts.instance
          ? {
            name, places, kind: 'orphan',
            label: `${known.displayName} 的一份数据`,
            why: `第三段是 ${parts.instance}，而配置里已经没有这个布局组了。`,
            deletable: true,
          }
          : {
            name, places, kind: 'orphan',
            label: `${known.displayName} 的一份旧数据`,
            why: `它记的是「${parts.group}」，而这个插件现在的版本号是 `
              + `${known.version}${declaredGroupOf(known)}。`,
            deletable: true,
          });
        continue;
      }
      rows.push({
        name, places, kind: 'orphan',
        label: `插件 ${parts.id} 的数据（本机已经没有这个插件）`,
        why: parts.instance
          ? `第三段是 ${parts.instance}。`
          : `第二段是「${parts.group}」。`,
        deletable: true,
      });
      continue;
    }

    if (LEGACY_RE.test(name)) {
      rows.push({
        name, places, kind: 'legacy',
        label: '0.7 之前的旧分区',
        why: `它的名字是 ${name.split('-')[0]}-… 那种形状 —— 这份数据的身份被改成`
          + '「插件 id / 共享组 / 实例」三段之前留下的。**它不会再被任何东西读到**，'
          + '而里面躺着当年的登录 cookie。',
        deletable: true,
      });
      continue;
    }

    // ★ 走到这里：每一处都认得出、不在"该有的"里、也不是三段身份 —— 那只可能是
    //   分区根里那些 0.7 之前的形状（上面那条 `recognized` 已经把别的路穷尽了）。
    //   这里从前还有一个"认不出的目录"分支，现在**到不了** —— 认不出的话上面就
    //   `continue` 了。留一段到不了的代码，下一个人会以为它守着什么。
  }

  // 顺序稳定（界面与日志才不会每次都不一样）：可删的在前面，认不出的那堆在最后。
  const order = { unused: 0, orphan: 1, legacy: 2, unknown: 3 };
  rows.sort((a, b) => (order[a.kind] - order[b.kind]) || a.label.localeCompare(b.label));

  return { rows, diskChecked, why: mergeWhy({ names, why, dataNames, dataWhy }) };
}

/**
 * 两个根的"查不了"合并成一句 —— ★ **并且点名是哪一根**。
 *
 * 一根没查成、另一根有东西时，界面必须说得出"我只看到了一半"。把两根塌成一个布尔，
 * 就等于说"本机就这些" —— 而"查不了"与"没有"是两件事。
 */
function mergeWhy(o) {
  const parts = [];
  if (!Array.isArray(o.names) && o.why) parts.push(`分区目录那一根：${o.why}`);
  if (!Array.isArray(o.dataNames) && o.dataWhy) {
    parts.push(`插件数据目录那一根：${o.dataWhy}`);
  }
  return parts.length ? parts.join('\n') : null;
}

/** 那个插件自己声明的共享组（没声明就返回空串）—— 只用来把话说完整。 */
function declaredGroupOf(plugin) {
  const d = plugin && plugin.contributes && plugin.contributes.data;
  const g = d && typeof d.inherit === 'string' ? d.inherit : '';
  return g ? `、声明的共享组是「${g}」` : '';
}

/**
 * 删这一份行不行 —— **主进程的判定**，界面只负责把原话拿去问。
 *
 * ★ 判定权必须在这里：界面手里那份清单随时可能已经陈旧（刚连上、刚改过配置、
 *   刚装/卸了插件），而它只负责弹一个确认框。所以调用方要**重新对一遍账**，
 *   把新算出来的 `rows` 交给这个函数 —— 不要拿界面回传的行来判。
 *
 * ★ 返回的 `row` 是**这次算出来的那一行**（不是界面给的那个字符串匹配到的对象）：
 *   接下来拼路径用的是它里面的 `name` —— 也就是 `readdir` 读到的那个目录名。
 *   `places` 决定要删哪几个根下的那一份。
 *
 * @param {object} o
 * @param {Array} o.rows              这次对账算出来的行
 * @param {string} o.name             界面点的那一行的 `name`
 * @param {string[]} [o.surfacePartitions] 此刻**每一块**界面的分区（`persist:…`）。
 *        ★ 是**一组**，不是"窗口里那一个"：多开之后窗口里有几块视图，而"正被用着"
 *        这件事对**每一块**都成立。拿单个前台分区去判，会把后台那块正在跑的页面
 *        脚下的数据判成可以删。
 * @returns {{ok: true, row: object}|{ok: false, code: string, error: string}}
 */
function deletionVerdict({ rows, name, surfacePartitions }) {
  const row = (rows || []).find((r) => r.name === name && r.deletable);
  if (!row) {
    return {
      ok: false, code: 'stale',
      error: '这一份数据现在不在「没人用」的清单里了 —— 多半是配置或插件刚变过。'
        + '重新看一下再决定。',
    };
  }
  // ★ 这一格**够得着**，不是"理论上"：正在显示的那份数据，它所属的插件**被从本机
  //   拿掉了**（站点回收、或者用户在本机删掉了那一版）—— 那一刻它既"在用"、
  //   又"不在该有的清单里"，于是一眼看过去就是一份没人要的孤儿。少了这一格，
  //   用户会把眼前那个页面脚下的存储抽掉，而症状只是「页面莫名其妙坏了」。
  const live = Array.isArray(surfacePartitions) ? surfacePartitions : [];
  if (live.some((p) => p && pluginData.samePartition(p, row.name))) {
    return {
      ok: false, code: 'in_use',
      error: '这一份数据正被当前页面用着，删掉它会让那个页面在下次刷新时报错。'
        + '想重置它，用「＋ 新建空白布局…」换一个布局组（页面会重新加载）。',
    };
  }
  return { ok: true, row };
}

module.exports = { partitionRoot, listDirs, audit, deletionVerdict, LEGACY_RE };
