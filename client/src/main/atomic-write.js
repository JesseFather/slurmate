'use strict';
/**
 * atomic-write.js —— 把一份内容原子地写到磁盘上。**框架里唯一的实现**。
 *
 * ── 为什么要有这个模块 ──────────────────────────────────────────────────────
 *
 * 同一个规矩（写同目录临时文件 → rename 上去）在这个仓库里曾经有**三份实现**，
 * 逐字差别有八处：临时文件名、自不自建目录、失败清不清理、权限兜不兜底、失败是
 * 抛还是返回、返回值是什么。收成一份的理由不是整洁，是**它们会漂开** —— 而漂开
 * 在这里的表现很具体：某一条路径上留下半截文件，而另外两条不会。
 *
 * ★ **只能收成"一份 + 一份对齐的副本"，第三份够不着。**
 *   `plugins/sshd/client/sshconfig.js` 跑在池里（`~/.slurmate/site-plugins/<id>/<版本>/`），
 *   而 `plugins/README.md` 明文写着插件**不能 require 客户端的源码**（相对路径指不到，
 *   打包器也不把它打进去）。所以那一份留在插件里，并按这份**逐条对齐**；
 *   两边同形这件事由 `test/boot.test.mjs` 里那条"同一张场景表喂两份实现"的用例守着
 *   —— **改一边而不改另一边会红**。看到这里的人请不要试图去删插件那一份。
 *
 * ── 它做什么 ────────────────────────────────────────────────────────────────
 *
 * 先写**同目录**的临时文件（带着目标权限），再 rename 上去。
 *
 *   · 同目录是必需的：`rename` 不跨文件系统（跨了是 `EXDEV`）。
 *   · 用 rename 而不是直接 `>` 的理由是**半截文件**：直接覆写时如果磁盘满、或者进程
 *     被杀，留下的是一个被截断的文件。rename 是原子的 —— 读到的一定是完整的新版本
 *     或者完整的旧版本。
 *   · `mode` 只在**创建**时生效，所以临时文件必须带着目标权限建出来再改名。
 *   · rename **之后**再 chmod 一次：有些平台会继承旧文件的 mode。
 *
 * ★ **没有 fsync。** 这一份和它取代的那三份一样，都只保证"不会有半截文件"，**不保证**
 *   断电之后新内容还在（见 `docs/KNOWN-ISSUES.md` 里 NFS 上 `rename`/`fsync` 那笔账）。
 *   ★ 说清楚这一点的理由：别让"统一原子写"这个动作**看起来**像是把那笔账解决了。
 */

const fs = require('fs');
const path = require('path');

function fail(error, detail) { return { ok: false, error, detail: detail || null }; }

/**
 * 建目录（递归）。★ **已存在时绝不改它的权限** —— 那是别人的东西。
 *
 * `mkdirSync` 的 `mode` 天生就是这个语义（只在新建时生效），所以这里没有一句
 * `chmodSync`。★ 这一条是有来历的：被这个模块取代的那一份 `config.js` 的实现里有
 * `try { fs.chmodSync(dir, mode); }`，于是每一次写配置都会把一个**已经存在**的
 * `userData` 目录 chmod 成 0700 —— 而那从来不是它被要求做的事。
 */
function ensureDir(dir, mode) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode });
  } catch (e) {
    return fail('mkdir_failed', e.message);
  }
  return { ok: true };
}

/**
 * 这个路径真正要写到哪个文件。**只在 `link:'follow'` 时用。**
 *
 * ★ 存在的唯一理由是**符号链接**。用 dotfiles 管理 ssh 配置的人很常见：
 *   `~/.ssh/config -> ~/dotfiles/config`。而 `rename(2)` **不跟随目标上的符号链接**
 *   —— 它会把那个链接本身换成一个普通文件。于是用户的 dotfiles 工作流静默失效：
 *   他改 `~/dotfiles/config` 不再影响 ssh，而 ssh 现在读的是另一个文件，两边从此
 *   各说各话，**没有任何地方会报错**。
 *
 * 所以：目标是个链接时，改写它指向的那个文件（链接保持不动，指过去就是新内容）。
 * 读的时候不用管这个 —— `readFileSync` 自己会跟随链接。
 *
 * ★ 为什么不把它做成默认行为：这件事**只对"我们要写一个用户的文件"成立**，而框架
 *   自己那些状态文件（`config.json`、`.sites.json` …）的语义恰恰相反 —— 它们是我们
 *   拥有的文件，跟着一个链接跑到别处建目录不是任何人想要的。默认跟随 = 用一个只对
 *   一处成立的规则去改另外七处。
 *
 * ★ 跟随的时候临时文件必须建在**解析后的目录**里（见 `writeAtomic`）—— 否则跨文件
 *   系统，`rename` 报 EXDEV，而症状是"Include 加不上"，在家目录是 NFS、dotfiles 在
 *   本地盘的机器上**真实会踩**。
 */
function resolveWriteTarget(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return file;                       // 不存在或 stat 不了：按原路径写
  }
  if (!st.isSymbolicLink()) return file;
  try {
    return fs.realpathSync(file);
  } catch {
    // 悬空的链接。按链接的目标位置建出来 —— 那正是用户期望它指向的地方。
    try { return path.resolve(path.dirname(file), fs.readlinkSync(file)); }
    catch { return file; }
  }
}

/**
 * 原子写一份文本。
 *
 * @param {string} file 目标路径
 * @param {string} text 内容
 * @param {object} [o]
 * @param {number} [o.mode=0o600]      文件权限（只在创建时生效）
 * @param {boolean} [o.mkdir=true]     要不要建父目录。`false` = 调用方自己保证它在
 * @param {number} [o.dirMode=0o700]   建父目录时用的权限
 * @param {'refuse'|'follow'} [o.link='refuse'] 目标是符号链接时怎么办 —— 见
 *        `resolveWriteTarget`。★ **默认 `refuse`**，只有"写一个用户的文件"才该
 *        显式改成 `follow`
 * @returns {{ok:true} | {ok:false, error:string, detail:string|null}}
 *          结构化结果，**不抛**。要不要把失败变成异常是**调用方**的策略
 *          （见 `writeAtomicOrThrow`），不是写盘的策略。
 */
function writeAtomic(file, text, o) {
  const opts = o || {};
  const mode = typeof opts.mode === 'number' ? opts.mode : 0o600;
  const dirMode = typeof opts.dirMode === 'number' ? opts.dirMode : 0o700;
  const target = opts.link === 'follow' ? resolveWriteTarget(file) : file;

  if (opts.mkdir !== false) {
    const r = ensureDir(path.dirname(target), dirMode);
    if (!r.ok) return r;
  }

  // ★ 临时名带前导点与**随机**后缀。随机是必需的：`pid + Date.now()` 那种写法在同一
  //   毫秒内的两次写会撞上同一个名字，而撞上的后果是**另一份内容的半截文件被 rename
  //   上去**（两份写各自都以为自己成功了）。
  const tmp = path.join(path.dirname(target),
    '.' + path.basename(target) + '.tmp.' + process.pid + '.'
    + Math.random().toString(16).slice(2));

  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 尽力而为 */ }
    return fail('write_failed', e.message);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 尽力而为 */ }
    return fail('rename_failed', e.message);
  }
  // rename 之后权限已经是对的，但有些平台会继承旧文件的 mode —— 再确保一次。
  try { fs.chmodSync(target, mode); } catch { /* Windows */ }
  return { ok: true };
}

/** `JSON.stringify` 之后原子写。缩进两格 —— 这些文件是给人看的。 */
function writeJsonAtomic(file, obj, o) {
  return writeAtomic(file, JSON.stringify(obj, null, 2), o);
}

/**
 * 给"写不下去就该炸"的调用方。
 *
 * ★ 抛的那一层不是模式开关，是**调用方的策略** —— 所以它住在这里、作为一个独立导出，
 *   而不是在 `writeAtomic` 上加一个 `throwOnError` 选项（那会让"该用哪个"变成每个
 *   调用点上的一道选择题）。`config.js` 靠它把 6 个调用点**一个字都不改**地接过来：
 *   从前那份私有实现是抛的，外部契约保持不变。
 */
function writeAtomicOrThrow(file, text, o) {
  const r = writeAtomic(file, text, o);
  if (!r.ok) {
    throw new Error(`写 ${file} 失败：${r.error}${r.detail ? `（${r.detail}）` : ''}`);
  }
}

module.exports = {
  writeAtomic,
  writeJsonAtomic,
  writeAtomicOrThrow,
};
