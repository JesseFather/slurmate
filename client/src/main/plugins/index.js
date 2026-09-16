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
 *                        （见 plugins/README.md）。**没有它也是合法的** ——
 *                        那样的插件装得上、看得见，但提交不了
 *
 * ★ **目录名不参与任何判定。** 身份来自清单里的 `id`，版本来自 `version`。
 *   目录名纯粹是给人看的，所以仓库里一眼能看出哪个是哪个，而加载器只有一条逻辑。
 *
 * ── 基座不带插件 ────────────────────────────────────────────────────────────
 *
 * ★ **本目录（`src/main/plugins/`）是框架，不是插件目录** —— 里面只有注册表、
 *   铸造 id 的 ulid.js、以及安装器。一个插件都没有，这是**正常状态**，不是
 *   安装包坏了。
 *
 *   插件来自**池**：`~/.slurmate/plugins/`。装进去的路径只有一条（install.js），
 *   而将来站点分发走的也是它 —— 分发只是把文件先落到本地临时目录再调它。
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
 *   站点签名 —— 那在 `plugin.json.sig` 那一层，不在这里。
 *
 * ── 坏插件不许把客户端带崩 ──────────────────────────────────────────────────
 *
 * 每个目录单独 try/catch，不合规的**跳过它并记一条**，其余插件照常工作。这不是
 * 防御性编程，这是需求：「不能因为后来加入或者移除了某个插件而导致崩溃」。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ulid = require('./ulid.js');

const MANIFEST = 'plugin.json';
const CLIENT_ENTRY = path.join('client', 'index.js');

/** route() 认不出来时的答案。**不是**一个能提交的服务，只是客户端内部的一个
 *  判定结果 —— 所以它不可能与任何插件的名字撞上（短名里不允许出现它）。 */
const UNKNOWN = 'unknown';

// ── 清单里允许出现的东西 ────────────────────────────────────────────────────
//
// **未知键报错而不是忽略**，沿用 v0.2 定下的规矩：打错一个键名（比如
// `contribution`）不该静默变成一个"配了但不生效"的插件。

const MANIFEST_KEYS = ['id', 'name', 'displayName', 'version', 'description',
  'author', 'engines', 'contributes', 'site'];
const CONTRIBUTES_KEYS = ['surface', 'login', 'layout', 'submitPubkey', 'legacyDefault'];
const SURFACE_KEYS = ['kind', 'path'];
const SURFACE_KINDS = ['web'];
const LOGIN_KEYS = ['path', 'field', 'cookie'];
const CLIENT_HOOKS = ['prepare', 'attach', 'preferredPort', 'closeWarning'];

/**
 * 站点短名的字符集。它进配置块名、进会话文件、进日志与报错文案 —— 宽松的字符集
 * 会在这些地方变成一个说不清的问题（空格、斜杠、大小写）。
 *
 * ★ 短名只需要**站点内唯一**（守护进程保证），不需要全球唯一 —— 全球唯一是 `id`
 *   的事。两个站点各有一个 `jupyter` 指的是两个不同的 `id`，客户端按来源连接区分。
 */
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

// ── 版本比较 ────────────────────────────────────────────────────────────────

function parseVer(s) {
  const m = VERSION_RE.exec(String(s === undefined ? '' : s).trim());
  return m ? s.trim().split('.').map(Number) : null;
}

function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * `engines.slurmate` 的范围判定。
 *
 * 支持 `>= > <= < =` 这几种比较符，空格分隔，**全部满足**才算通过。
 * （`>=0.3.0 <0.5.0` 这种就够用了；故意不支持 `^` / `~` / `||` —— 那些的语义
 * 各自都有坑，而这里要的是"装之前就能判定"，不是"尽量满足"。）
 */
function satisfies(version, range) {
  const v = parseVer(version);
  if (!v) return { ok: false, why: `版本号 ${JSON.stringify(version)} 不是 x.y.z 形式` };
  const parts = String(range).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { ok: false, why: '范围是空的' };
  for (const p of parts) {
    const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(p);
    if (!m) return { ok: false, why: `看不懂的范围片段 ${JSON.stringify(p)}` };
    const c = cmpVer(v, parseVer(m[2]));
    const op = m[1] || '=';
    const ok = op === '>=' ? c >= 0 : op === '<=' ? c <= 0
      : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
    if (!ok) return { ok: false, why: `本客户端是 ${version}，不满足 ${range}` };
  }
  return { ok: true };
}

/** 本客户端的版本（`engines.slurmate` 拿它比）。读不到就跳过这项检查。 */
function hostVersion() {
  try {
    return require('../../../package.json').version;   // client/package.json
  } catch {
    return null;
  }
}

// ── 加载 ────────────────────────────────────────────────────────────────────

/**
 * 内容摘要：清单 + 客户端代码。
 *
 * 这是「同一个构件」的判据。**不包含目录名**（目录名不参与判定）、不包含
 * 站点签名（签名的内容正是这个摘要）。池里两条摘要相同的记录是同一个东西，
 * 摘要不同就是两个东西在抢同一个 `(id, 版本)`。
 */
function digestOf(manifestRaw, clientRaw) {
  const h = crypto.createHash('sha256');
  h.update('manifest\0'); h.update(manifestRaw); h.update('\0');
  h.update('client\0'); h.update(clientRaw === null ? '' : clientRaw);
  return h.digest('hex');
}

function keysProblem(obj, allowed, what) {
  const bad = Object.keys(obj).filter((k) => !allowed.includes(k));
  return bad.length ? `${what}里有认不得的键：${bad.join('、')}（认识的只有 ${allowed.join('、')}）` : null;
}

/**
 * 读一个插件目录。返回 `{ plugin }` 或 `{ error }`。
 *
 * ★ 每一步失败都**说清是哪个文件的哪个键**。这个函数的报错是"加了插件它就是不
 *   生效"这个症状的**唯一**线索来源，含糊的报错等于没有报错。
 */
function loadDir(dir, source) {
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

  // name —— 站点内用的短名。配置块名、会话里的 service_kind 都是它。
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
  const host = hostVersion();
  if (mf.engines !== undefined) {
    if (!mf.engines || typeof mf.engines !== 'object' || Array.isArray(mf.engines)) {
      return { error: `${mfPath}：engines 必须是一个对象，如 {"slurmate": ">=0.3.0"}` };
    }
    why = keysProblem(mf.engines, ['slurmate'], 'engines');
    if (why) return { error: `${mfPath}：${why}` };
    if (mf.engines.slurmate !== undefined && host) {
      const r = satisfies(host, mf.engines.slurmate);
      if (!r.ok) {
        return { error: `${mfPath}：这个插件用不了 —— ${r.why}。`
          + '引擎范围是插件自己声明的，升级客户端之后才能装它' };
      }
    }
  }

  // site —— **给集群侧读的那一段**：默认资源、可执行文件怎么找、配置块里允许
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
    if (k === 'surface' || k === 'login') continue;
    if (mfc[k] !== undefined && typeof mfc[k] !== 'boolean') {
      return { error: `${mfPath}：contributes.${k} 必须是 true 或 false` };
    }
  }

  // 客户端代码 —— 可有可无。没有它就是**纯声明式插件**：框架按 contributes
  // 打开界面，不需要执行任何来自插件的代码。
  const clientPath = path.join(dir, CLIENT_ENTRY);
  let clientRaw = null;
  let hooks = {};
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
    let mod;
    try {
      // 每次都重新加载：注册表可能在同一次运行里被重建（测试会这么用），
      // 而 require 的缓存会让"删掉插件文件"在进程内看起来毫无效果。
      delete require.cache[require.resolve(clientPath)];
      mod = require(clientPath);
    } catch (e) {
      return { error: `${clientPath}：加载失败（${e.message}）` };
    }
    if (!mod || typeof mod !== 'object' || Array.isArray(mod)) {
      return { error: `${clientPath}：必须导出一个对象（可以一个钩子都不写）` };
    }
    why = keysProblem(mod, CLIENT_HOOKS, '导出的对象');
    if (why) return { error: `${clientPath}：${why}` };
    for (const k of ['prepare', 'attach', 'preferredPort']) {
      if (mod[k] !== undefined && typeof mod[k] !== 'function') {
        return { error: `${clientPath}：${k} 必须是一个函数` };
      }
    }
    if (mod.closeWarning !== undefined) {
      const cw = mod.closeWarning;
      if (!cw || typeof cw.message !== 'string' || typeof cw.detail !== 'string') {
        return { error: `${clientPath}：closeWarning 必须是 {message, detail} 两个字符串` };
      }
    }
    hooks = mod;
  }

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
      layout: mfc.layout === true,
      submitPubkey: mfc.submitPubkey === true,
      legacyDefault: mfc.legacyDefault === true,
    },
    // ── 加载记录 ──
    dir,
    source,                                  // 本版只有 'pool'；见下面 loadRoot 的说明
    hasClientCode,
    digest: digestOf(raw, clientRaw).slice(0, 16),
    // ── 客户端代码的钩子（全都可以没有）──
    prepare: hooks.prepare || null,
    attach: hooks.attach || null,
    preferredPort: hooks.preferredPort || null,
    closeWarning: hooks.closeWarning || null,
  };
  return { plugin };
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 找出一个根目录下所有含清单的目录，**最多往下两层**。
 *
 * 为什么要两层：池同时是两种东西 ——
 *
 *   · 用户把插件目录整个拷进去就生效的地方   `<池>/code-server/plugin.json`
 *   · 同一个插件的**多个版本并存**的地方     `<池>/<id>/<版本>/plugin.json`
 *
 * 而同一 `(id, 版本)` 只该有一份（两份内容不同的会撞车，见 reload），所以多版本
 * 只能靠目录分层来并存。
 *
 * ★ 两层的目录名都**不参与任何判定**（身份来自清单里的 `id`），所以这两种布局
 *   可以混着用，用户不需要知道这个规则、也不需要知道 id 长什么样。
 */
function findPluginDirs(base) {
  const out = [];
  const level1 = fs.readdirSync(base).sort();
  for (const n1 of level1) {
    const d1 = path.join(base, n1);
    if (!isDir(d1)) continue;                       // index.js、ulid.js 这些自己人
    if (fs.existsSync(path.join(d1, MANIFEST))) {
      out.push({ dir: d1, label: n1 });
      continue;
    }
    let level2;
    try {
      level2 = fs.readdirSync(d1).sort();
    } catch {
      continue;
    }
    for (const n2 of level2) {
      const d2 = path.join(d1, n2);
      if (isDir(d2) && fs.existsSync(path.join(d2, MANIFEST))) {
        out.push({ dir: d2, label: `${n1}/${n2}` });
      }
    }
  }
  return out;
}

/**
 * 扫一个根目录。根目录不存在**不是错误**。
 *
 * 池目录（`~/.slurmate/plugins/`）在用户装第一个插件之前本来就不存在 —— 为一个
 * 还没用上的功能天天报一条错是噪音。**客户端一个插件都没装是正常状态**，不是
 * 安装包坏了。
 */
function loadRoot(root) {
  const out = [];
  // 根的路径**可以是函数**：客户端的池目录依赖「配置目录」，而那个要等 app ready
  // 之后才知道 —— 在模块加载期就算出来的话，第一次运行会算出一个 null 路径。
  const base = typeof root.dir === 'function' ? root.dir() : root.dir;
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
  for (const { dir, label } of dirs) {
    const r = loadDir(dir, root.source);
    out.push(r.error ? { error: `${label}：${r.error.replace(`${dir}：`, '')}` } : r.plugin);
  }
  return out;
}

class Registry {
  /**
   * @param {Array<{dir:string|Function, source:string}>} [roots]
   *   **省略 = 一个插件都没有**，这是诚实默认值：基座自己不带任何插件。
   *   `dir` 可以是函数 —— 池目录要等 app ready 之后才算得出来（见 loadRoot）。
   */
  constructor(roots) {
    this.roots = (roots || [])
      .filter((r) => r && (typeof r.dir === 'string' || typeof r.dir === 'function'));
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
      for (const item of loadRoot(root)) {
        if (item.error) errors.push(item.error);
        else found.push(item);
      }
    }

    // ── 池：按 `(id, 版本)` 归并 ──
    //
    // 同键同摘要 = 同一个构件的多个来源 → 合并（只多记一个来源）。
    // 同键不同摘要 = 两个不同的东西在抢同一个身份 → **两个都不加载**并报错。
    //   绝不挑一个：挑错的后果是会话的解析键指过去、客户端静默地跑了另一个
    //   插件的代码，而用户完全看不出来。宁可让这个插件暂时不可用 ——
    //   那种失败是**看得见**的（会话变成"未知服务"，仍然接得上隧道、停得掉）。
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
        const where = group.map((p) => `${p.dir}（摘要 ${p.digest}）`).join('、');
        errors.push(`${key}：有 ${group.length} 份内容不同的副本在抢同一个 id 和版本`
          + ` —— 都没有加载。${where}。`
          + '这多半是有人抄了别人的 id，或者改了插件却没升版本号。'
          + '删掉多余的那一份，或者给改过的那份换一个新 id 再试。');
        continue;
      }
      // 摘要一致 → 同一构件。保留第一个（roots 顺序：内建在前），记下全部来源。
      const first = group[0];
      plugins.set(key, {
        ...first,
        sources: [...new Set(group.map((p) => p.source))].sort(),
      });
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
      a.name.localeCompare(b.name) || cmpVer(parseVer(a.version), parseVer(b.version)));
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
   * ★ 这**不是**一条会话解析路径 —— 解析永远走 `(id, 版本)`。它只有两个用处：
   *   给界面画"当前版本"，以及老守护进程的兜底（见 resolve）。
   */
  latestByName(name) {
    const hit = this.list().filter((p) => p.name === name);
    return hit.length ? hit[hit.length - 1] : null;
  }

  /**
   * 老守护进程不返回 `service_plugin`、连 `service_kind` 都没有时兜到哪一个。
   *
   * ★ 这是**正确的兜底，不是猜测**：在「插件」这一层做出来之前，作业模板只会起
   *   一种服务，所以那种守护进程只可能产生被标了 `legacyDefault` 的那个插件的
   *   会话。挑出它，是还原一个已知事实。
   *
   * ★ 但**兜不到的时候要说得出为什么**。以前这个位置返回 `why: null`，理由是
   *   "内建插件一定在"；基座不再自带任何插件之后，这句话就没有依据了 ——
   *   于是它会静默地退化成一个不解释任何东西的 UNKNOWN。见 resolve()。
   *
   * 没人标 `legacyDefault`、或有两个以上都标了，返回 null —— 那时 resolve() 只
   * 解释、不动作。这比错误地兜到某一个插件安全得多。
   */
  defaultPlugin() {
    const all = this.list().filter((p) => p.contributes.legacyDefault);
    return all.length === 1 ? all[0] : null;
  }

  /**
   * 把一个会话归一成插件。**四种输入，四种答案，一种都不能合并**：
   *
   *   service_plugin 是 `<id>@<版本>`   池里查得到   → 它
   *                                     池里查不到   → UNKNOWN（并说清缺什么）
   *   undefined（老守护进程，字段不存在）
   *       + service_kind 也 undefined   → legacyDefault 那个插件
   *       + service_kind 是短名          → 按短名找，**唯一命中才算**（见下）
   *       + service_kind === null        → UNKNOWN，**绝不猜**
   *   其余（含认不出的名字、坏掉的 `<id>@<版本>`）→ UNKNOWN，**不退回缺省**
   *
   * ★ 认不出的**不退回缺省**：那等于系统声称一件它并不知道的事。
   *
   * ★ `null` 与 `undefined` 的分野是承重的，别合并：前者是"服务端明确告诉你它
   *   不知道"（会话是从 nft 规则恢复出来的），后者是"这个字段还不存在"（版本旧）。
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
        return p ? { plugin: p, why: null } : { plugin: null, why: this.missing(id, version) };
      }
      return { plugin: null, why: `控制节点给的插件标识 ${JSON.stringify(servicePlugin)} 认不出来` };
    }

    if (serviceKind === null) return { plugin: null, why: null };

    if (serviceKind === undefined) {
      const d = this.defaultPlugin();
      return {
        plugin: d,
        why: d ? null
          : '这个会话来自一个更老的守护进程（它连服务种类都不报）—— 那种守护进程'
            + '只可能产生标了 legacyDefault 的那个插件的会话，而本机没有装它。',
      };
    }

    // 老守护进程：只有一个**短名**，没有 `<id>@<版本>`。
    //
    // ★ 早先这里限定「必须是内建的」，理由是"老守护进程只可能产生内建插件的
    //   会话"。基座不再自带插件之后那句话就不成立了，而按短名在池里找是**有
    //   歧义的**：池是全局的，两个站点可以各有一个叫 jupyter 的插件，而它们是
    //   两个不同的东西（各自有各自的 id）。所以判据从"是不是内建"换成
    //   **"是不是唯一"** —— 命中多个就不猜，说出来让用户自己判断。
    const hits = this.list().filter((x) => x.name === serviceKind);
    if (hits.length === 1) return { plugin: hits[0], why: null };
    return {
      plugin: null,
      why: hits.length
        ? `本机装了 ${hits.length} 个都叫「${serviceKind}」的插件，`
          + '而它们来自不同的来源，无法判断这个会话用的是哪一个。'
        : `本机没有装短名为「${serviceKind}」的插件 —— 会话是在别的机器上`
          + '提交的，或者插件被卸掉了。',
    };
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

module.exports = {
  Registry, UNKNOWN, bucketOf, loadDir, satisfies, cmpVer, parseVer, hostVersion,
};
