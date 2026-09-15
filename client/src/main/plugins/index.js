'use strict';
/**
 * plugins/index.js —— 插件注册表。
 *
 * 一个**插件** = 一种服务。一个会话提供哪种服务，就由哪个插件负责把它接起来。
 * 两侧各有一半实现：服务端在 `cluster/run.sbatch` 的一个 `start_*` 函数里
 * （连同 `slurmate-sessiond` 的 `PluginSpec`），客户端就是这个目录下的一个模块。
 *
 * ── 框架 / 插件的边界（这是本文件存在的理由）────────────────────────────────
 *
 * 框架（index.js / session.js / windows.js / tunnel.js）**不认识任何插件名**。
 * 它只管与"哪个插件"无关的事：提交、状态机、心跳、隧道、停止、连接与布局管理、
 * 窗口。这些事**一次也不查 service_kind** —— 唯一的例外就是本文件这个注册表。
 *
 * 插件只管"这个会话该怎么用"：建视图并自动登录（code-server），或者把本地 ssh
 * 配好（sshd）。插件拿到的是 `ctx` —— 框架显式递给它的一组能力。
 *
 * ★ 这条边界的用处是让「卸载一个插件」成为一件**有定义**的事。没有它，插件一旦
 *   离开，散落在框架各处的 `if (是它)` 就会连同那个功能一起烂掉，而症状是"删掉
 *   插件之后客户端在某条路径上莫名其妙地不动了"。
 *
 * ── 坏插件不许把客户端带崩 ──────────────────────────────────────────────────
 *
 * 扫到的每个模块都要过一遍形状校验；不合规的**跳过它并记一条**，其余插件照常
 * 工作。这不是防御性编程，这是需求：「不能因为后来加入或者移除了某个插件而导致
 * 崩溃」。加一个写坏的插件文件，客户端必须还能起来、还能用别的插件。
 */

const fs = require('fs');
const path = require('path');

// 一个插件模块必须导出这些。
const REQUIRED = [
  ['name', (v) => typeof v === 'string' && v.length > 0, '字符串'],
  ['title', (v) => typeof v === 'string' && v.length > 0, '字符串'],
  ['attach', (v) => typeof v === 'function', '函数'],
];

// route() 在认不出来时的答案。**不是**一个能提交的服务，只是客户端内部的一个
// 判定结果 —— 所以它不可能与任何插件的名字撞上（插件名里不允许出现它）。
const UNKNOWN = 'unknown';

/**
 * 扫一个目录，返回 `{ plugins: Map<名字, 模块>, errors: string[] }`。
 *
 * ★ 文件名就是插件的身份：会话里的 `service_kind` 就是它，服务端的 `PluginSpec`
 *   也是它。所以导出里的 `name` 与文件名不一致时宁可跳过 —— 那种不一致会让
 *   "哪个文件对应哪个插件"永远说不清，而症状是改了 A 文件、生效的是 B。
 *
 * ★ 每个文件单独 try/catch：一个插件抛出异常（语法错、require 了不存在的东西）
 *   只影响它自己。
 */
function loadFrom(dir) {
  const plugins = new Map();
  const errors = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    errors.push(`读不到插件目录 ${dir}：${e.message}`);
    return { plugins, errors };
  }
  for (const file of names.sort()) {
    if (!file.endsWith('.js') || file === 'index.js') continue;
    const full = path.join(dir, file);
    if (!fs.statSync(full).isFile()) continue;

    let mod;
    try {
      // 每次都重新加载：注册表可能在同一次运行里被重建（测试会这么用），
      // 而 require 的缓存会让"删掉插件文件"在进程内看起来毫无效果。
      delete require.cache[require.resolve(full)];
      mod = require(full);
    } catch (e) {
      errors.push(`${file}：加载失败（${e.message}）—— 这一个已跳过，其余插件不受影响`);
      continue;
    }

    const missing = REQUIRED.filter(([k, ok]) => !mod || !ok(mod[k]))
      .map(([k, , what]) => `${k}（${what}）`);
    if (missing.length) {
      errors.push(`${file}：缺少 ${missing.join('、')} —— 这一个已跳过，其余插件不受影响`);
      continue;
    }
    const stem = path.basename(file, '.js');
    if (mod.name !== stem) {
      errors.push(`${file}：导出的 name 是 ${JSON.stringify(mod.name)}，与文件名不一致。`
        + '文件名才是它的身份（会话里的 service_kind 就是它），所以这一个已跳过');
      continue;
    }
    if (mod.name === UNKNOWN) {
      errors.push(`${file}：插件名不能是 ${UNKNOWN} —— 那是"认不出来"的保留值`);
      continue;
    }
    plugins.set(mod.name, mod);
  }
  return { plugins, errors };
}

class Registry {
  constructor(dir) {
    this.dir = dir || __dirname;
    this.plugins = new Map();
    this.errors = [];
    /** 每个插件**各自**的上次通知键。见 once()。 */
    this.notices = new Map();
    this.reload();
  }

  /**
   * 重新扫描。**构造时自动调用**，也可以在运行中调（测试用它模拟装/卸插件）。
   *
   * 关键性质：重新扫描**不会**清掉 notices —— 去重状态跟着插件名走，不跟着
   * 这一次的对象走。否则重新扫描会让用户把已经看过的通知再看一遍。
   */
  reload() {
    const { plugins, errors } = loadFrom(this.dir);
    this.plugins = plugins;
    this.errors = errors;
    return this;
  }

  /** 全部插件，按名字排序（顺序稳定，界面与日志才不会每次都不一样）。 */
  list() {
    return [...this.plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) {
    return (typeof name === 'string' && this.plugins.get(name)) || null;
  }

  /**
   * 缺省插件：老守护进程不返回 `service_kind` 时兜到哪一个。
   *
   * ★ 这是**正确的兜底，不是猜测**：老守护进程只可能产生 code-server 会话
   *   （那时的作业模板只会起那一种）。所以按名字挑出被标了 `defaultFor` 的
   *   那个插件，是还原一个已知事实，而不是在信息缺失时赌一把。
   *
   * 没人标 `defaultFor` 时返回 null —— 那时 route() 给 UNKNOWN，客户端只解释、
   * 不动作。这比错误地兜到某一个插件安全得多。
   */
  defaultPlugin() {
    return this.list().find((p) => p.defaultFor === true) || null;
  }

  /**
   * 把一个裸的 `service_kind` 归一成插件名。
   *
   * 四种输入，四种答案，一种都不能合并：
   *
   *   'code-server' / 'sshd' / …   表里认得        → 它自己
   *   undefined                    字段**不存在**  → 缺省插件（老守护进程）
   *   null                         守护进程明说不知道 → UNKNOWN，**绝不猜**
   *   其余（含表里没见过的名字）                      → UNKNOWN，**不退回缺省**
   *
   * ★ `undefined` 与 `null` 的分野是承重的，别合并：前者是"这个字段还不存在"
   *   （版本旧），后者是"服务端明确告诉你它不知道"（会话是从 nft 规则恢复出来的）。
   *   合并的后果是升级客户端之后，所有恢复出来的会话都被当成 code-server，
   *   于是客户端拿口令去 POST 一个可能是 SSH 的端口。
   *
   * ★ 认不出的名字**不退回缺省**：那等于系统声称一件它并不知道的事。
   */
  route(raw) {
    if (raw === undefined) {
      const d = this.defaultPlugin();
      return d ? d.name : UNKNOWN;
    }
    if (raw === null) return UNKNOWN;
    const p = this.get(raw);
    return p ? p.name : UNKNOWN;
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
   */
  once(name, key) {
    if (this.notices.get(name) === key) return false;
    this.notices.set(name, key);
    return true;
  }
}

module.exports = { Registry, UNKNOWN, loadFrom };
