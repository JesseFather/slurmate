'use strict';
/**
 * plugins/install.js —— 把**一个插件目录**装进池，以及从池里拿掉。
 *
 * ── 为什么安装是一个动作，而不是"你自己 cp 过去" ────────────────────────────
 *
 * 加载器（index.js）只读。在它之前，池目录甚至不会被创建 —— 于是「池是安装点」
 * 这句话在代码里落不了地：用户不知道该往哪放，也没有任何东西告诉他放对没有。
 *
 * ★ **站点分发不走这条路。** 这一条以前写着"将来分发会复用同一个 installFrom"，
 *   现在分发已经有了，而它落在**另一个根**上（`~/.slurmate/site-plugins/`，见
 *   site-plugins.js），因为两者的语义在三个地方正好相反：
 *
 *     · 谁来定：这里由**用户**挑目录；分发由**站点**说了算，还要按引用计数回收。
 *     · 换入前：这里直接拷；分发要先过**同意闸**（带代码的插件第一次要用户点一下）。
 *     · 撞车时：这里**拒绝**；分发也拒绝，但理由是"站点改了内容却没升版本号"。
 *
 *   照旧注释去复用 `installFrom` 的人，会把"拒绝覆盖内容不同的同版本"当成一个
 *   bug 去修 —— 而那正是这个文件下面那一段在防的事。
 *
 * ── ★ 绝不用安装来"覆盖" ────────────────────────────────────────────────────
 *
 * 池模型唯一的危险处是「同一个 `(id, 版本)` 有两份内容不同的副本」—— 那意味着
 * 有两个不同的东西在抢同一个身份，而取错的那一方会**静默地跑另一个插件的代码**。
 * 加载器遇到这种事的处理是"两个都不加载并报错"。
 *
 * 安装器**绝不能**变成绕过它的后门：装一个已经存在、内容却不同的 `(id, 版本)`，
 * 不是"更新"，是**拒绝**。要更新就升版本号 —— 版本号存在的全部意义就是这个。
 */

const fs = require('fs');
const path = require('path');
// COPY_SKIP 从 index.js 引 —— **全仓只有那一份**。它同时决定"安装器拷哪些"与
// "摘要算哪些"，两处不一致的症状是安装器永远说"内容不一样"，而原因指不出来。
// 依赖方向不变（install → index），而且这条路上不会回指。
const { inspectDir, shortDigest, COPY_SKIP } = require('./index.js');

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (COPY_SKIP.has(name)) continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.lstatSync(from);
    if (st.isDirectory()) copyTree(from, to);
    // ★ 符号链接**原样搬**（不跟随）：跟随会把链接目标的内容复制进来，而插件目录
    //   是别人给的 —— 一个指向池外某个文件的链接会变成池里一份幽灵副本。
    else if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * 装一个插件。**调用方负责之后让注册表重新扫描。**
 *
 * @param {string} pool  池目录（绝对路径）
 * @param {string} srcDir 插件目录（含 plugin.json 的那个）
 * @returns {{ok:true, plugin:object, dest:string, already:boolean}
 *          |{ok:false, error:string}}
 */
function installFrom(pool, srcDir) {
  if (!pool) return { ok: false, error: '插件池目录还没准备好（客户端可能还没起来）。' };
  if (typeof srcDir !== 'string' || !srcDir) {
    return { ok: false, error: '没有指定要装哪个目录。' };
  }

  // 先把它当插件**读一遍** —— 校验、算摘要，全部走加载器那一套。装的时候和
  // 加载的时候用同一个判定，否则装进去的东西可能在下次启动时才被拒。
  //
  // ★ 用 `inspectDir` 不用 `loadDir`：这里只需要清单与摘要，**不需要执行**用户
  //   挑的那个目录里的代码。装的时候不跑它，加载的时候才跑 —— 那是两件事。
  const r = inspectDir(srcDir, 'pool');
  if (r.error) return { ok: false, error: `这个目录不是一个能用的插件：${r.error}` };
  const p = r.entry.plugin;

  // 落到 `<池>/<id>/<版本>/`：两层的布局让**同一个插件的多个版本并存**，而两层的
  // 目录名都不参与判定（身份来自清单，见 index.js 的 findPluginDirs）。
  const idDir = path.join(pool, p.id);
  const dest = path.join(idDir, p.version);

  if (fs.existsSync(dest)) {
    const have = inspectDir(dest, 'pool');
    if (have.error) {
      return { ok: false, error: `${dest} 已经存在，但它不是一个能用的插件（${have.error}）。`
        + '安装不会去覆盖一个来路不明的目录 —— 请先自己确认并清掉它。' };
    }
    if (have.entry.digest === p.digest) {
      return { ok: true, plugin: p, dest, already: true };   // 同一个构件：幂等
    }
    return { ok: false,
      error: `${p.name} ${p.version}（id ${p.id}）已经装过一份，而这一份的内容不一样。`
        + `\n装的是：${dest}（摘要 ${shortDigest(have.entry.digest)}）`
        + `\n这一份：${srcDir}（摘要 ${shortDigest(p.digest)}）`
        + '\n同一个 id 和版本只能对应一份内容 —— 装错了就是静默地跑另一个插件的代码。'
        + '\n改过的那一份请升版本号（或换一个新 id）再装。' };
  }

  try {
    copyTree(srcDir, dest);
  } catch (e) {
    // 半份插件比没有更坏：它会被扫到一个残破的目录。尽力清掉，清不掉也要说出来。
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* 下面会说 */ }
    return { ok: false, error: `复制到 ${dest} 失败：${e.message}` };
  }

  return { ok: true, plugin: p, dest, already: false };
}

/**
 * 从池里拿掉一个版本。**删之前先确认那个目录真的是它。**
 *
 * ★ 校验不是多余的：这个函数会 `rm -rf` 一个路径，而那个路径是由 `id` 和
 *   `version` 拼出来的。先读一遍再删，是对「不要按描述去删你没看过的东西」这条
 *   最低要求 —— 它保证我们**永远不会删掉一个内容与调用方所说不同的目录**。
 *
 * @param {string} pool
 * @param {string} id
 * @param {string} version
 * @returns {{ok:true, dest:string}|{ok:false, error:string}}
 */
function uninstall(pool, id, version) {
  if (!pool) return { ok: false, error: '插件池目录还没准备好。' };
  if (typeof id !== 'string' || typeof version !== 'string') {
    return { ok: false, error: 'id 与版本都必须是字符串。' };
  }
  const idDir = path.join(pool, id);
  const dest = path.join(idDir, version);

  const have = inspectDir(dest, 'pool');
  if (have.error) return { ok: false, error: `${dest} 不是一个能用的插件，没有动它：${have.error}` };
  if (have.entry.plugin.id !== id || have.entry.plugin.version !== version) {
    return { ok: false, error: `${dest} 里的插件自报的是 `
      + `${have.entry.plugin.id}@${have.entry.plugin.version}，与要卸载的 ${id}@${version} 不一致，`
      + '没有动它。' };
  }

  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: `删不掉 ${dest}：${e.message}` };
  }
  // 这个 id 一个版本都不剩时，把它那层空目录也收掉（收不掉不算错：里面可能还有
  // 别的版本，或者有用户自己放的东西）。
  try { fs.rmdirSync(idDir); } catch { /* 非空或不存在 —— 都不是问题 */ }

  return { ok: true, dest };
}

module.exports = { installFrom, uninstall, copyTree, COPY_SKIP };
