'use strict';
/**
 * sshconfig.js —— 让**用户自己的 ssh** 认出一个恒定的主机别名。
 *
 * ── 为什么要动用户的 ~/.ssh/config ─────────────────────────────────────────
 *
 * 中转站的承诺是「codex 那一侧永远不用改」：用户在本机敲 `ssh slurmate` 就能进
 * 自己的作业。而 `slurmate` 这个名字必须由 ssh 自己认识 —— 它不在 DNS 里，
 * 也不可能在 —— 所以它只能来自 ssh 的配置文件。客户端没有第二条路。
 *
 * ── 三条纪律，每一条都对应一种「把用户别的东西弄坏」的方式 ──────────────────
 *
 * 1. **绝不重写用户的 ~/.ssh/config。** 只往最上面加两行（一句注释 + 一行
 *    `Include`），其余内容**逐字节原样保留**。那个文件坏了，用户所有的 ssh
 *    都不通 —— 这是整个客户端里最容易造成灾难性后果的一次写盘。
 *
 * 2. **Include 必须在最上面。** ssh 对每个参数取「第一个获得的值」，所以用户
 *    自己那份配置里常见的 `Host *` 块如果排在前面，它的 Port/User 会**赢过**
 *    我们这一份，而症状是「配置看着完全正确但连不上」。实测确认过这一点。
 *
 * 3. **写的路径一律是绝对路径。** `~` 在 Include 里是按 `$HOME` 展开的（实测），
 *    而 `$HOME` 在极少数场合不等于用户的家目录；绝对路径没有这个变量。
 *    家目录真的搬走时，那条 Include 会悬空 —— 实测确认**悬空的 Include 不是
 *    致命错误**，ssh 会忽略它继续读后面的内容，所以用户其余的 ssh 完全不受影响，
 *    重新启动一次会话即可自愈（见 ensureInclude 的替换逻辑）。
 *
 * ── 我们自己那两个文件 ─────────────────────────────────────────────────────
 *
 *   ~/.slurmate/ssh/config        整体由我们重写（它就是我们自己的文件）
 *   ~/.slurmate/ssh/known_hosts   同上
 *   ~/.slurmate/ssh/id_ed25519    中转站用的那把钥匙（见 ensureRelayKey）
 *
 * ── 这把钥匙为什么可以躺在磁盘上（而其它私钥必须加密）──────────────────────
 *
 * 别处的私钥是**注册到 IDM**的那把，泄漏 = 别人能登录集群，所以那边只加密存盘、
 * 没有凭据库时宁可留在内存里。
 *
 * 这把不一样：它是**一次性**的，只被提交到你自己那个作业的 authorized_keys 里，
 * 任何一个 IDM 或集群的登录入口都不认识它。偷到它的人还得先有你的 IDM 私钥
 * 才能连上登录节点、开隧道进去 —— 也就是说，他得先拿到那把更值钱的钥匙。
 * 所以它能放在磁盘上，但路径要在 0700 目录里、文件 0600。
 *
 * 而它**必须**躺在磁盘上：要连进来的是用户自己的 ssh 进程，它读不到 Electron
 * 的 safeStorage，也没有办法让我们把内存里的东西递给它。
 */

const fs = require('fs');
const path = require('path');
const keys = require('./keys.js');
const { SSH_ALIAS } = require('./service.js');

/** 我们那一行 Include 的标识。改文案可以，但**这个 token 不要动** —— 靠它做替换。 */
const INCLUDE_MARK =
  '# slurmate:include —— 由 Slurmate 客户端添加，删掉本行与下面一行即可取消';

/** 绝对路径，一律正斜杠。ssh 在 Windows 上也认正斜杠，反斜杠反而会被当转义。 */
function pathsFor(home) {
  const dir = path.join(home, '.slurmate', 'ssh');
  const to = (p) => p.split(path.sep).join('/');
  return {
    dir: to(dir),
    config: to(path.join(dir, 'config')),
    knownHosts: to(path.join(dir, 'known_hosts')),
    identity: to(path.join(dir, 'id_ed25519')),
    userConfig: to(path.join(home, '.ssh', 'config')),
  };
}

/** 一条 `ssh-ed25519 <68 个 base64 字符>`，**不带注释**。 */
const HOST_KEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]{68}$/;

/** 主机公钥的形状校验。写进 known_hosts 前必须过这一关（见文件末尾的注释）。 */
function isHostKeyLine(v) {
  return typeof v === 'string' && HOST_KEY_RE.test(v.trim());
}

function fail(error, detail) { return { ok: false, error, detail: detail || null }; }

/**
 * 原子写：先写同目录的临时文件，再 rename 上去。
 *
 * 同目录是必需的（rename 不跨文件系统），而用 rename 而不是直接 `>` 的理由是
 * **半截文件**：直接覆写时如果磁盘满/进程被杀，留下的是一个被截断的配置 ——
 * 对 ssh 而言那就是「所有 ssh 突然都不通了」。rename 是原子的，读到的一定是
 * 完整的新版本或者完整的旧版本。
 *
 * mode 只在**创建**时生效，所以临时文件必须带着目标权限建出来再改名。
 */
function writeAtomic(file, content, mode) {
  const tmp = path.join(path.dirname(file),
    '.' + path.basename(file) + '.tmp.' + process.pid + '.' + Math.random().toString(16).slice(2));
  try {
    fs.writeFileSync(tmp, content, { mode });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 尽力而为 */ }
    return fail('write_failed', e.message);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 尽力而为 */ }
    return fail('rename_failed', e.message);
  }
  return { ok: true };
}

/**
 * 这个路径真正要写到哪个文件。
 *
 * ★ 存在的唯一理由是**符号链接**。用 dotfiles 管理 ssh 配置的人很常见：
 *   `~/.ssh/config -> ~/dotfiles/config`。而 rename(2) **不跟随目标上的符号链接** ——
 *   它会把那个链接本身换成一个普通文件。于是用户的 dotfiles 工作流静默失效：
 *   他改 ~/dotfiles/config 不再影响 ssh，而 ssh 现在读的是另一个文件，
 *   两边从此各说各话，没有任何地方会报错。
 *
 * 所以：目标是个链接时，改写它指向的那个文件（链接保持不动，指过去就是新内容）。
 * 读的时候不用管这个 —— readFileSync 自己会跟随链接。
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

/** 建我们自己的目录（0700）。已存在时不改它的权限 —— 那是用户的东西。 */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return fail('mkdir_failed', e.message);
  }
  return { ok: true };
}

// ── 用户 ~/.ssh/config 里的那一行 Include ───────────────────────────────────

/** 指向我们那一份配置的 Include 行（路径可比对的部分）。 */
const INCLUDE_LINE_RE = /^\s*Include\s+\S*\.slurmate[\\/]ssh[\\/]config\s*$/i;
const MARK_RE = /^\s*#\s*slurmate:include/i;

/**
 * 把我们的 Include 放到用户 ~/.ssh/config 的**最上面**。幂等。
 *
 * 同一时刻只保留一份：旧版本留下的（或家目录搬走后的）那条会被**替换**掉，
 * 所以它自己会修好自己，不会越积越多。
 *
 * @returns {{ok:boolean, changed:boolean, path:string, error?:string, detail?:string}}
 *   ok:false 时**什么都不要做** —— 调用方要如实告诉用户去手工加这一行，
 *   而不是假装中转站配好了。
 */
function ensureInclude(home) {
  const p = pathsFor(home);
  let original = '';
  try {
    original = fs.readFileSync(p.userConfig, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 读不出来（权限、是目录…）时**绝不能**当作空的往下写 —— 那会把用户的
      // 全部 ssh 配置抹掉。这正是这个文件最危险的一条路径。
      return { ...fail('read_failed', `${p.userConfig}：${e.message}`), changed: false,
               path: p.userConfig };
    }
  }

  const lines = original.split('\n');
  const kept = lines.filter((l) => !MARK_RE.test(l) && !INCLUDE_LINE_RE.test(l));
  const block = [INCLUDE_MARK, `Include ${p.config}`];
  // 原本是空文件时 split 会给出 ['']，拼起来会多一个空行 —— 无所谓，但既然是
  // 我们自己写进去的，就别留它。
  const body = kept.join('\n').replace(/^\n+/, '');
  const next = block.join('\n') + '\n' + (body.trim() ? body : '');

  if (next === original) return { ok: true, changed: false, path: p.userConfig };

  const userSshDir = path.dirname(p.userConfig);
  if (!fs.existsSync(userSshDir)) {
    const r = ensureDir(userSshDir);
    if (!r.ok) return { ...r, changed: false, path: p.userConfig };
  }
  // 我们自己创建的 ~/.ssh/config 必须是 0600；用户已有的那份**不动它的权限**
  // （ssh 只在它可被组/其他人写时才报警告，只读不是问题，而改用户的权限位
  //   属于我们没被要求做的事）。
  const existed = fs.existsSync(p.userConfig);
  const mode = existed ? (fs.statSync(p.userConfig).mode & 0o777) : 0o600;
  const w = writeAtomic(resolveWriteTarget(p.userConfig), next, mode);
  if (!w.ok) return { ...w, changed: false, path: p.userConfig };
  return { ok: true, changed: true, path: p.userConfig };
}

// ── 那把一次性的钥匙 ────────────────────────────────────────────────────────

/**
 * 取中转站用的私钥。**没有才生成**；内容不可解析时报错而不是静默换一把。
 *
 * 换掉的代价很小（它哪儿也没注册过），但「静默」这个词本身就是这个项目一路在
 * 清的东西：会话跑着的时候把钥匙换掉，症状是「刚才还能连，现在认证失败」，
 * 指不回根因。
 *
 * @returns {{ok:true, privateKeyPem:string, publicKeyLine:string, created:boolean}
 *          |{ok:false, error:string, detail:string}}
 */
function ensureRelayKey(home) {
  const p = pathsFor(home);
  let existing = '';
  try {
    existing = fs.readFileSync(p.identity, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return { ok: false, error: 'relay_key_unreadable',
               detail: `${p.identity} 读不出来：${e.message}` };
    }
  }

  if (existing) {
    const line = keys.publicKeyLineFromPrivatePem(existing);
    if (line) {
      return { ok: true, privateKeyPem: existing, publicKeyLine: line, created: false };
    }
    return { ok: false, error: 'relay_key_broken',
             detail: `${p.identity} 存在但不是一个能解析的私钥。`
                   + '它是中转站自己生成的一次性钥匙，没有在别处注册过 —— '
                   + `删掉这个文件重来即可（它只被写进你自己作业的 authorized_keys）。` };
  }

  const gen = keys.generate();
  const d = ensureDir(p.dir);
  if (!d.ok) return { ok: false, error: 'relay_key_write', detail: d.detail };
  const w = writeAtomic(p.identity, gen.privateKeyPem, 0o600);
  if (!w.ok) {
    return { ok: false, error: 'relay_key_write',
             detail: `无法写 ${p.identity}：${w.detail}` };
  }
  return { ok: true, privateKeyPem: gen.privateKeyPem,
           publicKeyLine: gen.publicKeyLine, created: true };
}

// ── 我们自己那一份 ssh 配置 ─────────────────────────────────────────────────

/**
 * 写 ~/.slurmate/ssh/config，并把它需要的 known_hosts 一起准备好。
 *
 * @param {object} o
 *   home    {string}  家目录
 *   port    {number}  隧道**实际**在监听的本地端口（不是首选端口 —— 可能顺移过）
 *   user    {string}  登录节点上的用户名
 *   hostKey {string|null} 作业里那个 sshd 的主机公钥（`ssh-ed25519 AAAA…`）
 *
 * @returns {{ok:boolean, path:string, strict:boolean, error?:string, detail?:string}}
 *   strict=false 表示**没能**钉住主机密钥、退回到了首次信任（见下）。
 */
function writeRelayConfig({ home, port, user, hostKey }) {
  const p = pathsFor(home);
  const d = ensureDir(p.dir);
  if (!d.ok) return { ...d, path: p.config };

  const haveHostKey = isHostKeyLine(hostKey);
  // ★ 拿不到主机公钥时退回 accept-new，并把这件事说出来（strict:false 由调用方
  //   报给用户）。另一种做法是照样写 StrictHostKeyChecking yes —— 那样 ssh 会
  //   直接拒绝连接（"Host key verification failed"），功能变成不可用，而用户
  //   完全不知道该怎么办。能用但降级 > 不能用。
  //   什么时候会走到这里：守护进程还是旧版本（没有 ssh_host_key 这个字段）、
  //   或者作业是滚动升级期间由旧 run.sbatch 起的。
  if (haveHostKey) {
    const kh = writeKnownHost(p, hostKey, port);
    if (!kh.ok) return { ...kh, path: p.config };
  }

  const body = [
    '# 由 Slurmate 客户端整体重写 —— 请勿手工编辑，你改的内容下次启动会话时会被覆盖。',
    '# 要加自己的配置，请写在自己的 ~/.ssh/config 里：客户端只在那个文件的最上面',
    '# 加一行 Include 指向本文件，其余内容一个字都不动。',
    '#',
    '# Host 别名是恒定的：作业落在哪个计算节点、哪个端口，都不会改变它。',
    '# 所以 codex、VS Code Remote-SSH 之类只需要认准这一个名字。',
    '#',
    `# 端口 ${port} 由客户端在会话建立时写入；隧道断开后这里会指向一个没有人监听`,
    '# 的端口（Connection refused），那是「会话已经结束」的正常表现。',
    '',
    `Host ${SSH_ALIAS}`,
    '    HostName 127.0.0.1',
    `    Port ${port}`,
    `    User ${user}`,
    '',
    `    IdentityFile ${p.identity}`,
    // ★ 只拿这一把去试。作业里的 sshd 只认它，而 ssh 默认会先把 agent 里的、
    //   ~/.ssh 下的每一把都试一遍 —— 那些失败会计进 MaxAuthTries（默认 6），
    //   agent 里的钥匙一多，还没轮到我们这把就被断开了，症状是「认证失败」。
    '    IdentitiesOnly yes',
    '',
    `    UserKnownHostsFile ${p.knownHosts}`,
    `    StrictHostKeyChecking ${haveHostKey ? 'yes' : 'accept-new'}`,
    '',
    '# 会话没了就明确报错，别把终端和 codex 吊在那里。',
    '    ConnectTimeout 10',
    '    ServerAliveInterval 30',
    '    ServerAliveCountMax 6',
    '',
  ].join('\n');

  const w = writeAtomic(p.config, body, 0o600);
  if (!w.ok) return { ...w, path: p.config };
  return { ok: true, path: p.config, strict: haveHostKey };
}

/**
 * 把作业内 sshd 的主机公钥写成 known_hosts 里的**唯一**一条。
 *
 * 整体重写而不是追加，理由是这份文件是我们自己的、且**同一时刻只可能有一个**
 * 中转站会话 —— 追加只会让换了端口之后的旧条目越积越多。
 *
 * 为什么敢用它（而不是让 ssh 首次信任）：这个值是从**已经用你 IDM 密钥认证过、
 * 并且核对过登录节点主机密钥**的那条 SSH 连接上取回来的，源头是 NFS 家目录里
 * 你自己的作业写的 0600 文件。也就是说它的可信度与你自己的账号相同 —— 比
 * 「第一次见到就信」高得多，而后者在一个共享计算节点上是**可以被抢的**：
 * 端口来自候选表，同节点另一个用户理论上能先占住它。
 */
function writeKnownHost(p, hostKey, port) {
  // 回环地址 + 非 22 端口 → known_hosts 里必须写成 [地址]:端口，方括号不能省。
  const entry = `[127.0.0.1]:${port} ${hostKey.trim()}\n`;
  const w = writeAtomic(p.knownHosts, entry, 0o600);
  if (!w.ok) return { ...w, path: p.knownHosts };
  return { ok: true, path: p.knownHosts };
}

module.exports = {
  pathsFor, ensureInclude, ensureRelayKey, writeRelayConfig,
  isHostKeyLine, INCLUDE_MARK,
};
