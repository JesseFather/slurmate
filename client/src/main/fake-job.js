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
 * fake-job.js —— 假站点上一条会话的作业侧：起进程、等登记、收尾。
 *
 * ── 它在整条流程里的位置 ───────────────────────────────────────────────────
 *
 * 真站点上，一次「开始会话」是：守护进程 sbatch 一份织好了插件作业侧的作业
 * 脚本 → 计算节点上挑端口、调 `start_<短名>` → 服务的输出直接落在作业日志上 →
 * 守护进程读会话文件登记会话 → 客户端拿到 `tunnel_target` 打开界面。
 *
 * 开发者模式里没有 Slurm、没有计算节点。这个文件补的就是那一段：
 *
 *   · 挑候选端口（每一个都真的 bind 过一次 —— `port_free` 那条规矩**只有这一份
 *     实现**，替身宿主里故意没有第二份，见 `fake-job-host.sh`）；
 *   · 起 `fake-job-host.sh`（替身宿主，见它自己的文件头：复刻到契约为止）；
 *   · 读会话文件（宿主写、真守护进程也读的那一份）直到登记或失败；
 *   · 收尾时杀进程组 —— 插件的服务多半是 `&` 起来的，只杀直接子进程会留下它。
 *
 * ── 两条如实的限制（界面会在起不来时把它们说出来）──────────────────────────
 *
 *   1. 需要 bash：`job/start.sh` 是一段被 `source` 进来的 shell 片段，两个
 *      样例都用到了 `[[ ]]`、`local`、关联数组。Windows 的客户端上没有它 ——
 *      那时这里返回一句说得清的错，而不是一次静默失败。
 *   2. 插件的依赖得装在这台机器上：code-server 那棵树要真的有一个 code-server，
 *      sshd 那棵要起得起一个 sshd。起不来不许静默、也不许拿别的东西顶替 ——
 *      它的 stdout/stderr 就是答案（`why` 里那一句给界面，全文在两个日志文件里）。
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const appAssets = require('./app-assets.js');

/**
 * 替身宿主。它与 `cluster/run.sbatch` 的界线写在那个文件自己的头里。
 *
 * 这个路径要交给一个外部的 bash，而外部进程读不了 asar —— 所以安装包里
 *   必须取它解包之后的那一份（`appAssets.unpacked`，而 `asarUnpack` 那一句在
 *   `client/electron-builder.yml` 里）。源码跑时这个函数什么都不做。
 */
const HOST_SH = appAssets.unpacked(path.join(__dirname, 'fake-job-host.sh'));

/**
 * 登记要等多久看一次会话文件。
 *
 * 真守护进程挂在 2 秒的 tick 上；这里读的是本进程刚写的那个文件，快一点只是让
 *   开发者模式里的等待短一点 —— 它不改变任何一条判据（谁写的、写的是什么、
 *   谁读它，全都一样）。
 */
const POLL_MS = 80;

/** 收尾：先 TERM，给这么久，再 KILL。与真宿主 `cleanup` 里那个 sleep 2 同一个意思。 */
const TERM_GRACE_MS = 1200;

/** 作业日志的保留期（天）。与真宿主的 housekeeping 同一个数 —— 那是**站点自己的
 *  账**，假站点照它做一件最小的事：别让沙盒无限长大。 */
const KEEP_DAYS = 7;

/** 候选端口按区间挑。与假站点 `_doctor` 报出去的那个区间同一个数。 */
const PORT_MIN = 55001;
const PORT_MAX = 55999;

/** 一次挑几个候选。真守护进程那几个是配置项；这里是它那个量级。 */
const CANDIDATES = 6;

/** 「这台机器上没有 bash」那一句 —— 只此一处：真的是没找到、和用例造出来的
 *  那个现场，说的是同一句话（`NO_BASH`）。 */
const NO_BASH = { why: '这台机器上没有 bash，插件的作业侧是一段 shell 片段'
  + '（`job/start.sh`），它要一个 bash 才跑得起来。Windows 上今天起不了会话，'
  + '其余一切照常。' };

/** 按 PATH 找，再补上这三个惯例位置（GUI 启动的程序 PATH 常常很短）。 */
function defaultBashSearch() {
  const out = [];
  for (const d of String(process.env.PATH || '').split(':').filter(Boolean)) {
    out.push(path.join(d, 'bash'));
  }
  out.push('/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash');
  return out;
}

/** 这个 bash 是第几版（取不到 = 它跑不起来，不算数）。 */
function bashMajor(p) {
  try {
    const out = execFileSync(p, ['-c', 'printf %s "${BASH_VERSINFO[0]:-0}"'],
      { timeout: 1000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const n = Number(String(out).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * 找一个能用的 bash。返回 `{path}` 或 `{why}`。
 *
 * 不 shell 出去问 `which`：那要起一个进程，而且 `which` 自己也可能不在。
 *   按 PATH 逐段看有没有可执行的 `bash`，是最直白的那一种。
 *
 * 还要问一句它是不是 bash 4 或更新。这不是洁癖：契约里的
 *   `PLUGIN_SESSION_FIELDS` 是关联数组（§5.2），而 bash 3 没有它 ——
 *   而不查这一下的症状是 `declare -A: invalid option` 这行字躺在作业日志里，
 *   作者会去查自己的插件（他没写错）。macOS 自带的 `/bin/bash` 正是 3.2。
 */
function findBash(search = defaultBashSearch()) {
  for (const p of search) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
    } catch { continue; }
    const major = bashMajor(p);
    if (major === null) continue;               // 有这个名字，但跑不起来
    if (major < 4) {
      return { why: `这台机器上的 bash 太老（${p} 是 ${major}.x）：插件的作业侧`
        + '用到了关联数组（`PLUGIN_SESSION_FIELDS`），bash 3 没有它。'
        + 'macOS 自带的那个 `/bin/bash` 就是 3.2；`brew install bash` 之后把'
        + '它放进 PATH 前面即可。' };
    }
    return { path: p };
  }
  return NO_BASH;
}

/**
 * 先按区间随便挑几个（不探测）—— 真守护进程发下去的候选表就是这么来的：
 * 它在登录节点上挑，够不着计算节点那一刻的端口占用。
 */
function nominalCandidates(n = CANDIDATES) {
  const span = PORT_MAX - PORT_MIN + 1;
  const out = [];
  while (out.length < n) {
    const p = PORT_MIN + Math.floor(Math.random() * span);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** 这个端口现在能不能绑上（绑上就立刻放开）。 */
function portBindable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/**
 * 候选表里真的能绑上的那些。
 *
 * 这是契约里「`$1` 已实测可绑定」（§5.2，稳定 / 机器）那一条的落点。
 *   真宿主在计算节点上逐个端口查（`port_free`：`ss` 快查 + 一次真 bind）；
 *   假站点在这台机器上查，判据是同一条 —— 而它只此一份。
 *
 * 一个都绑不上时再随机试几轮（那说明这个区间真的很挤）；还是空就返回空，
 *   调用方如实说"挑不到空闲端口"。
 */
async function pickCandidates(nominal = nominalCandidates()) {
  const out = [];
  for (const p of nominal) {
    // eslint-disable-next-line no-await-in-loop
    if (await portBindable(p)) out.push(p);
  }
  for (let i = 0; out.length === 0 && i < 24; i += 1) {
    const p = nominalCandidates(1)[0];
    // eslint-disable-next-line no-await-in-loop
    if (await portBindable(p)) out.push(p);
  }
  return out;
}

/** PATH 里找可执行文件。找不到返回 null。 */
function whichSync(name) {
  for (const d of String(process.env.PATH || '').split(':').filter(Boolean)) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* 接着找 */ }
  }
  return null;
}

/**
 * 这个插件的可执行文件该走哪个环境变量、值是什么。
 *
 * 真站点上这一步在守护进程里（`PluginConfig` 的 `bin`）：站点配置里写了
 *   就用它，没写就按清单声明的 `site.bin.discovery` 求一个缺省。假站点**没有
 *   站点配置**（没有管理员），于是走的正是后面那一支 —— 那不是简化，那正是
 *   "这个站点没给这个插件配 bin"时真守护进程会做的事。
 *
 * `convention` 那一种不做 PATH 查找（与守护进程逐字同一条理由：这一项在
 *   登录节点上求值，而真正的执行发生在计算节点上 —— 登录节点上恰好有这个文件，
 *   对计算节点不是证据）。
 *
 * @returns {{env: string, value: string}|null}
 */
function resolvePluginBin(manifest) {
  const b = manifest && manifest.site && manifest.site.bin;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const env = typeof b.env === 'string' ? b.env.trim() : '';
  if (!env) return null;
  const fb = typeof b.fallback === 'string' && b.fallback.trim() ? b.fallback.trim() : '';
  let value = fb;
  if (b.discovery === 'which' && typeof b.name === 'string' && b.name.trim()) {
    const found = whichSync(b.name.trim());
    if (found) value = found;
  }
  return value ? { env, value } : null;
}

/**
 * 删掉太旧的作业日志。
 *
 * 按年纪删，不按条数：一次测试跑几十条会话，按条数会把正在跑的那一条的
 *   日志删掉 —— 而那个症状是"日志忽然空了"，指不回这里。
 * 只碰我们自己那两个文件（`slurm-<作业号>.out` / `.err`）：那正是真宿主的
 *   housekeeping 的判据（"只碰这个目录里我们自己那两个名字"）。
 */
function pruneLogs(logDir, now = Date.now()) {
  const cutoff = now - KEEP_DAYS * 24 * 3600 * 1000;
  let names;
  try { names = fs.readdirSync(logDir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!/^slurm-\d+\.(out|err)$/.test(name)) continue;
    const f = path.join(logDir, name);
    try {
      if (fs.statSync(f).mtimeMs >= cutoff) continue;
      fs.rmSync(f, { force: true });
      n += 1;
    } catch { /* 删不掉不是错误 —— 下一轮再试 */ }
  }
  return n;
}

/**
 * 一条会话的作业侧。
 *
 * 用法：`new FakeJob({...})` → `await start()` → 起来了是 `{ok:true, port, pid}`，
 * 没起来是 `{ok:false, why}`（`why` 那一句是给人看的，真正的原因在日志里）。
 * 起得来之后服务自己退出（或被 `stop()` 收掉）会调到 `onExit(job)`。
 */
class FakeJob {
  /**
   * @param {object} opts
   *   entry     {string}   插件作业侧的入口（站点那棵树里的 `job/start.sh`）
   *   env       {object}   宿主给插件的环境（`SLURMATE_*` / `JOB_ID` / 用户名…）
   *   sessFile  {string}   宿主要写的会话文件（真守护进程读的也是这一个名字）
   *   outPath   {string}   标准输出那一份
   *   errPath   {string}   标准错误那一份
   *   cwd       {string}   宿主的工作目录（真宿主是用户的家目录）
   *   noBash    {boolean}  假装这台机器上没有 bash（调试开关，见
   *                        `FakeBackend.debugNoBash`）—— 那条失败路要能走到，
   *                        否则它的那句话就是一个没人跑过的分支
   *   onExit    {function} 服务自己退出时调一次（`stop()` 收的不会调）
   */
  constructor(opts) {
    this.entry = opts.entry;
    this.env = opts.env || {};
    this.sessFile = opts.sessFile;
    this.outPath = opts.outPath;
    this.errPath = opts.errPath;
    this.cwd = opts.cwd;
    this.noBash = Boolean(opts.noBash);
    this.onExit = typeof opts.onExit === 'function' ? opts.onExit : () => {};

    this.child = null;
    this.state = 'idle';       // idle | starting | running | failed | exited
    this.port = 0;
    this.pid = 0;
    this.exitCode = null;
    this.why = null;
    /** 会话文件最后一次读到的内容（登记那几个字段就在里面）。 */
    this.info = null;

    this._settled = false;
    this._stopping = false;
    this._poll = null;
    this._pre = () => '';
  }

  get running() { return this.state === 'running'; }

  /** 起。返回 `{ok:true, port, pid}` 或 `{ok:false, why, exitCode}`。 */
  start() {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this.state = 'starting';
      try {
        fs.mkdirSync(path.dirname(this.sessFile), { recursive: true, mode: 0o700 });
        fs.mkdirSync(path.dirname(this.outPath), { recursive: true, mode: 0o700 });
      } catch (e) {
        this._fail(`作业目录建不出来：${e.message}`);
        return;
      }
      this._spawn();
    });
  }

  _spawn() {
    // 那两条限制里的第一条，而且它必须说得清：这不是"这个插件写错了"。
    const found = this.noBash ? NO_BASH : findBash();
    if (!found.path) {
      this._fail(found.why);
      return;
    }
    let child;
    try {
      child = spawn(found.path, [HOST_SH, this.entry], {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        // 自成进程组（pgid = 这个 pid）：收尾时那一刀要能落在整组上 ——
        //   插件的服务多半是 `&` 起来的，只杀宿主会留下它，而那个症状是
        //   "会话结束了，端口上还有人听着"。
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this._fail(`作业侧起不来：${e.message}`);
      return;
    }
    this.child = child;
    this.pid = child.pid;

    // 宿主在 `exec 1>>…` 之前写的那几行（环境缺变量、片段读不到）走的是管子。
    // 留着它们，失败时才有一句原话可说 —— 那时日志文件可能压根还没建出来。
    let pre = '';
    const keep = (buf) => { pre = (pre + buf.toString()).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    this._pre = () => pre.trim().split('\n').filter(Boolean).slice(-2).join(' / ');

    child.on('error', (e) => this._fail(`作业侧起不来：${e.message}`));
    child.on('exit', (code, signal) => this._onChildExit(code, signal));

    this._poll = setInterval(() => this._look(), POLL_MS);
    this._poll.unref?.();
  }

  /** 看一眼宿主的会话文件。这是登记的唯一依据 —— 与真守护进程同一个来源。 */
  _look() {
    if (this._settled) return;
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(this.sessFile, 'utf8'));
    } catch { return; }                       // 还没写出来 / 正写到一半
    this.info = info;
    const st = String(info.state || '');

    if (st === 'running' && Number(info.service_port) > 0) {
      this.state = 'running';
      this.port = Number(info.service_port);
      this.pid = Number(info.service_pid) || this.pid;
      this._settle({ ok: true, port: this.port, pid: this.pid });
      return;
    }
    if (st === 'failed') {
      const ec = info.exit_code === null || info.exit_code === undefined
        ? null : Number(info.exit_code);
      this._fail('作业侧没有起来（会话文件写的 state=failed'
        + `${ec === null ? '' : `，退出码 ${ec}`}）${this._tailWhy()}`, ec);
    }
  }

  /** 失败那一句里带上日志的最后一行 —— 作者要看的正是它。 */
  _tailWhy() {
    for (const p of [this.errPath, this.outPath]) {
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length) return `；日志最后一行：${lines[lines.length - 1]}`;
    }
    const pre = this._pre();
    return pre ? `；${pre}` : '';
  }

  _fail(why, code = null) {
    if (this._settled) {
      // 已经在跑的作业忽然失败：那是结束，不是"没能起来"。
      this.state = 'failed';
      this.exitCode = code;
      this.why = why;
      return;
    }
    this.state = 'failed';
    this.exitCode = code;
    this.why = why;
    this._settle({ ok: false, why, exitCode: code });
  }

  _settle(result) {
    if (this._settled) return;
    this._settled = true;
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    this._resolve(result);
  }

  _onChildExit(code, signal) {
    this.exitCode = typeof code === 'number' ? code : null;
    if (!this._settled) {
      // 还没登记就退出了：那就是没起来，而原话就在日志里。
      const how = signal ? `被信号 ${signal} 结束` : `退出码 ${code}`;
      this._fail(`作业侧在登记之前就结束了（${how}）${this._tailWhy()}`,
        typeof code === 'number' ? code : null);
      return;
    }
    if (this.state === 'running') {
      this.state = 'exited';
      if (!this._stopping) this.onExit(this);
    }
  }

  /**
   * 收尾：杀整个进程组（先 TERM，再 KILL）。
   *
   * `_stopping` 一置上，服务退出就不再回调 —— 那正是"这一次是我们收的，
   *   不要再去改会话状态"。
   */
  async stop() {
    this._stopping = true;
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    const child = this.child;
    const pid = child ? child.pid : 0;
    if (pid) {
      const kill = (sig) => {
        try { process.kill(-pid, sig); } catch { /* 整组都没了 */ }
      };
      // 等它真的退出，而不是无条件睡满宽限期：宿主收到 TERM 就把服务收掉、
      //   写墓碑、退出，通常几十毫秒。睡满的话，一个套件里几十条会话每条都白等
      //   一秒多 —— 而那些秒数是加在总时长上的，看起来会像"这套东西很慢"。
      //   宽限期只对卡住的服务生效（那时才真的 KILL）。
      const exited = new Promise((r) => {
        if (child.exitCode !== null || child.signalCode !== null) { r(); return; }
        child.once('exit', r);
      });
      kill('SIGTERM');
      const done = await Promise.race([
        exited.then(() => true),
        new Promise((r) => setTimeout(() => r(false), TERM_GRACE_MS)),
      ]);
      if (!done) {
        kill('SIGKILL');
        await exited;
      }
    }
    if (this.state === 'running') this.state = 'exited';
  }
}

module.exports = { FakeJob, nominalCandidates, pickCandidates, resolvePluginBin,
  pruneLogs, findBash, defaultBashSearch, NO_BASH, PORT_MIN, PORT_MAX, CANDIDATES };
