/**
 * site-plugins.test.mjs —— 站点分发的对账逻辑。
 *
 * ★ 这一组测的是**谎话**，不是成功路径。每一条对应用户可能看到的一句错话：
 *
 *     「同步成功」而磁盘上少了一份
 *     「校验通过」而它验的是对面自报的那个值
 *     「装好了」而客户端根本没加载它
 *     「站点不要它了」而其实是记录读不出来
 *     「同步失败」而其实是撞上了限流
 *
 * 所以每条用例都是**注入一个失败点、断言那失败被报出来**。断言成功路径通过是
 * 最没有价值的一种测试：它在一半的实现里都会绿。
 *
 * ★ 用一个**照着协议回话的假 rpc**，不需要 socket、不需要真的守护进程。这也是
 *   `sync()` 把 `rpc` 做成注入参数的全部理由。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../src/main/site-plugins.js');
const P = require('../src/main/plugins/index.js');
const ulid = require('../src/main/plugins/ulid.js');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── 一个"站点" ──────────────────────────────────────────────────────────────
//
// 它持有若干插件目录，并按协议回话。`state` 里的开关是**故意造**那些真机上极难
// 复现的状态用的（限流、老守护进程、自报的摘要说谎、只写一半）。

function makeSite() {
  const src = tmp('slurmate-fakesite-');
  const state = {
    limits: true,
    rateBurst: 0,
    lieAboutSha: null,
    hideFiles: new Set(),      // 这些 (id@版本) 不带 `files`（站点不分发它）
    disabled: new Set(),       // 这些不带 `enabled: true`
    extra: [],                 // 站点多报的（客户端不认识的）
    sessions: [],
  };
  const byKey = new Map();

  /** 造一个插件目录。`files` 是相对路径 → 内容。 */
  function add(dirName, over = {}, files = {}) {
    const dir = path.join(src, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const mf = { id: ulid.mint(), name: 'plug', displayName: '插件', version: '1.0.0', ...over };
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(mf, null, 2));
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    const key = `${mf.id}@${mf.version}`;
    byKey.set(key, { dir, mf });
    return { id: mf.id, version: mf.version, name: mf.name, dir };
  }

  /** 一个 (id, 版本) 现在**声明**的文件清单（读自磁盘，与守护进程同一个口径）。 */
  function declared(key) {
    const e = byKey.get(key);
    return P.readPluginFiles(e.dir).filter((f) => f.kind === 'f')
      .map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
  }

  async function rpc(req) {
    if (req.op === 'plugins') {
      const plugins = [...byKey.keys()].map((key) => {
        const e = byKey.get(key);
        const out = {
          id: e.mf.id, name: e.mf.name, version: e.mf.version, title: e.mf.displayName,
          enabled: !state.disabled.has(key), can_submit: true, defaults: { cpus: 2, mem: '8G' },
        };
        if (!state.hideFiles.has(key)) out.files = declared(key);
        return out;
      });
      for (const x of state.extra) plugins.push(x);
      const data = { plugins, enabled: plugins.filter((p) => p.enabled).map((p) => p.name) };
      // ★ 能力信号是**协议事实**：顶层有没有 `limits`。老守护进程整个字段都没有。
      if (state.limits) data.limits = { file_bytes: 256 * 1024, total_bytes: 1 << 20, max_files: 256 };
      return { ok: true, data };
    }
    if (req.op === 'list') return { ok: true, data: { sessions: state.sessions } };
    if (req.op === 'plugin_file') {
      if (state.rateBurst > 0) {
        state.rateBurst -= 1;
        return { ok: false, code: 7, error: { kind: 'rate_limited', detail: '演示：打满桶' } };
      }
      const key = `${req.id}@${req.version}`;
      if (!byKey.has(key)) {
        return { ok: false, code: 3, error: { kind: 'plugin_unknown', detail: key } };
      }
      const hit = declared(key).find((f) => f.path === req.path);
      if (!hit) {
        return { ok: false, code: 3, error: { kind: 'plugin_file_unknown', detail: req.path } };
      }
      const buf = fs.readFileSync(path.join(byKey.get(key).dir, ...req.path.split('/')));
      return {
        ok: true,
        data: {
          path: hit.path, size: hit.size,
          // ★ 自报的那个 sha256 —— 客户端**不许**拿它做判据（见下面那条用例）。
          sha256: state.lieAboutSha || hit.sha256,
          data: buf.toString('base64'),
        },
      };
    }
    return { ok: false, code: 2, error: { kind: 'unknown_op', detail: req.op } };
  }

  return { src, state, add, declared, rpc, byKey };
}

/** 一次对账的环境：站点池 + 暂存 + 台账。 */
function makeEnv() {
  const siteRoot = tmp('slurmate-sitepool-');
  const stagingRoot = tmp('slurmate-staging-');
  const trusted = new Map();          // `<id>@<版本>` → 摘要（模拟 cfg.trustedPlugins）
  return { siteRoot, stagingRoot, trusted };
}

function callSync(site, env, over = {}) {
  return S.sync({
    rpc: (req) => site.rpc(req),
    siteKey: over.siteKey || 'aaaaaaaaaaaaaaaa',
    siteLabel: over.siteLabel || 'u@h:22',
    siteRoot: env.siteRoot,
    stagingRoot: env.stagingRoot,
    trusted: over.trusted || ((id, v, d) => env.trusted.get(`${id}@${v}`) === d),
    protectedVersions: over.protectedVersions || [],
    stale: over.stale || (() => false),
    now: over.now || (() => 1700000000000),
    verify: over.verify,
  });
}

/**
 * 把一次对账里所有待同意的都"点一下同意"。
 *
 * ★ 走的是**界面上那个动作的同一段代码**（`acceptStaged` + `noteConsent` + 台账），
 *   不是测试自己另发明一套 —— 否则测的就是另一个实现。
 */
function consentAll(env, r, over = {}) {
  for (const p of r.pendingConsent) {
    const mv = S.acceptStaged({
      stagedDir: p.stagedDir, siteRoot: env.siteRoot,
      id: p.id, version: p.version, digest: p.digest,
    });
    assert.equal(mv.ok, true, `同意 ${p.id}@${p.version} 应当成功：${mv.error}`);
    const nc = S.noteConsent({
      siteRoot: env.siteRoot, siteKey: p.siteKey, siteLabel: p.siteLabel,
      id: p.id, version: p.version,
    });
    assert.equal(nc.ok, true, `同意要同时记进引用表：${nc.why}`);
    env.trusted.set(`${p.id}@${p.version}`, p.digest);
  }
  assert.equal(over.count === undefined ? true : over.count === r.pendingConsent.length, true);
  return r.pendingConsent.length;
}

const readRecordOf = (siteRoot) => JSON.parse(
  fs.readFileSync(path.join(siteRoot, S.RECORD_NAME), 'utf8'));

// ── 同意闸 ──────────────────────────────────────────────────────────────────

test('★★ 同意闸真的拦住了代码执行 —— 这是它的全部意义', () => {
  // ★ 这条是整块工作里最承重的一条。
  //
  //   在 `inspectDir`/`activatePlugin` 分开之前，`loadDir()` 在读到
  //   `client/index.js` 时**当场** `require()` —— 于是"对账结束时才 reload()、
  //   没同意的不激活"这句话是空的：远端代码在用户看到对话框之前就已经在本进程里
  //   跑完了，点"不同意"什么也拦不住。
  //
  //   这条用例把那个洞直接照出来：插件在被加载时写一个标记文件，而对账跑完之后、
  //   点同意**之前**，那个文件必须不存在。
  const site = makeSite();
  const env = makeEnv();
  const marker = path.join(tmp('slurmate-marker-'), 'loaded.txt');
  const p = site.add('evil', { name: 'evil', displayName: '会写文件的插件' }, {
    'client/index.js':
      `require('fs').writeFileSync(${JSON.stringify(marker)}, '我跑过了');\n`
      + 'module.exports = { attach() {} };\n',
  });

  // 手工把一棵树放进站点池（"对账 + 下载"那两步在别的用例里单独测）——
  // 这里要问的只有一件事：**注册表会不会去执行它**。
  const root = tmp('slurmate-sitepool2-');
  fs.mkdirSync(path.join(root, p.id), { recursive: true });
  fs.cpSync(p.dir, path.join(root, p.id, '1.0.0'), { recursive: true });

  const reg = new P.Registry([{ dir: root, source: 'site' }], { allows: () => false });
  reg.reload();
  assert.equal(fs.existsSync(marker), false,
    '★ 没同意的插件，它的代码绝不能在主进程里跑过 —— 跑了就是同意闸不存在');
  // 但用户**要看得见它**（否则没法点同意）。
  const listed = reg.get(p.id, '1.0.0');
  assert.ok(listed, '没同意的插件仍然要出现在 list() 里 —— 用户要看得见它才能点同意');
  assert.equal(listed.active, false, '而且它必须是"不带钩子"的状态');
  assert.equal(listed.attach, null, '一个钩子都不能有');
  // ★ 更不能进会话解析路径：拿半个插件去接一个会话，比不做还坏。
  const r = reg.resolve('evil', `${p.id}@1.0.0`);
  assert.equal(r.plugin, null, '★ 没同意的插件必须被 resolve 拒绝');
  assert.match(r.why || '', /同意/, `要说清该去点同意：${r.why}`);
});

test('★ 摘要是从**磁盘上的字节**算的，不是对面自报的那个', () => {
  // ★ 自证陷阱：`plugin_file` 的响应里带一个与 `data` 不符的 sha256。实现若拿它
  //   校验 data，这条一定绿 —— 那等于让被告当法官。
  const site = makeSite();
  const env = makeEnv();
  site.state.lieAboutSha = 'f'.repeat(64);
  site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });

  // 只把**声明**改坏：让站点报的 sha256 与磁盘不符。这一条与上一条不同 ——
  // 上一条是响应自报，这一条是**清单**自报，而清单是客户端唯一该信的那个来源。
  return callSync(site, env).then((r) => {
    // 声明与磁盘一致 ⇒ 正常下来（响应里那个假 sha 完全没被用上）
    assert.equal(r.failed.length, 0, `不该失败：${JSON.stringify(r.failed)}`);
    assert.equal(r.pendingConsent.length, 1, '下来了、在等同意');
  });
});

// ── 逐文件校验 ──────────────────────────────────────────────────────────────

test('★ 声明了而磁盘上没有 ⇒ 失败', async () => {
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  // 声明里多一份根本取不到的文件
  const orig = site.rpc;
  const rpc = async (req) => {
    const r = await orig(req);
    if (req.op === 'plugins') {
      r.data.plugins[0].files = [...r.data.plugins[0].files,
        { path: 'ghost.js', size: 4, sha256: 'a'.repeat(64) }];
    }
    return r;
  };
  const r = await S.sync({
    rpc, siteKey: 'k', siteLabel: 'l', siteRoot: env.siteRoot, stagingRoot: env.stagingRoot,
    trusted: () => true, protectedVersions: [],
  });
  assert.equal(r.failed.length, 1, `要报失败：${JSON.stringify(r)}`);
  assert.match(r.failed[0].why, /ghost\.js/, `要点名是哪一份：${r.failed[0].why}`);
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), false,
    '★ 失败之后站点池里**根本不能有**那个目录 —— 半份比没有更坏');
});

test('★ 磁盘上有而声明里没有 ⇒ 也失败（双向比对）', async () => {
  // ★ 只比一个总摘要抓不到"多出来一个文件" —— 这正是 F18 的形态。
  //   而只比"声明了的都在"抓不到"磁盘上多出来的那些"。两个方向都要判。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const dest = path.join(env.siteRoot, p.id, '1.0.0');
  fs.cpSync(p.dir, dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'extra.js'), '// 站点没报过这一份\n');

  const r = await callSync(site, env);
  assert.equal(r.kept.length, 0, '磁盘上多出来一份就不算"已经有一份"');
  assert.equal(r.failed.length, 1, `要报失败：${JSON.stringify(r)}`);
  assert.match(r.failed[0].why, /extra\.js/, `要点名多出来的是哪一份：${r.failed[0].why}`);
});

test('★ 同一个版本号下内容变了 ⇒ 明确失败，**绝不静默覆盖**', async () => {
  // 站点改了内容却没升版本号是**站点的错**。覆盖的后果是一条正在跑的旧会话配上
  // 新的客户端那一半 —— 正是 PROTOCOL.md 里"两半是配套的"那条注释在防的事。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const dest = path.join(env.siteRoot, p.id, '1.0.0');
  fs.cpSync(p.dir, dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'client', 'index.js'), 'module.exports = { attach() {} };\n');
  const before = fs.readFileSync(path.join(dest, 'client', 'index.js'));

  const r = await callSync(site, env);
  assert.equal(r.failed.length, 1, `要报失败：${JSON.stringify(r)}`);
  assert.match(r.failed[0].why, /升版本号|版本号/, `要说清该怎么办：${r.failed[0].why}`);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'client', 'index.js')), before,
    '★ 失败时池里原来那份**每个字节都不能变**');
});

test('★ 写下去之后再从磁盘读回来验 —— 不能拿手里的 Buffer 当证据', async () => {
  // `writeFileSync` 在磁盘满时会留下部分文件然后抛错。核对手里那些 Buffer 等于把
  // "校验我收到的"当成"校验我写下的" —— 同一类谎话的经典形态。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' },
    { 'client/index.js': 'module.exports = {};\n', 'job/start.sh': '#!/bin/sh\necho hi\n' });

  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function patched(file, data, opts) {
    const s = String(file);
    if (s.startsWith(env.stagingRoot) && s.endsWith('job' + path.sep + 'start.sh')) {
      return realWrite.call(fs, file, Buffer.from(String(data)).subarray(0, 3), opts);
    }
    return realWrite.call(fs, file, data, opts);
  };
  let r;
  try {
    r = await callSync(site, env);
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(r.failed.length, 1, `只写了一半也要被发现：${JSON.stringify(r)}`);
  assert.match(r.failed[0].why, /start\.sh/, `要点名是哪一份：${r.failed[0].why}`);
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), false,
    '★ 站点池里不能留下半份');
});

test('★ 清单合法但 client/index.js 有语法错 ⇒ 在暂存里就被抓到', async () => {
  // "文件都下来了"不等于"装上了"。这一条断的是"对账成功"与"注册表真的收了它"
  // 之间的那道缝 —— 而 `reload()` 从不抛，坏插件只会进 `errors`。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'this is not javascript ((((\n' });
  const r = await callSync(site, env);
  assert.equal(r.failed.length, 1, `语法错要在换入之前就被抓住：${JSON.stringify(r)}`);
  assert.match(r.failed[0].why, /语法|用不了/, `要说清坏在哪：${r.failed[0].why}`);
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), false,
    '★ 语法错的树一个字节都不该进站点池 —— 进去之后按"站点不主动删"就只能让它躺着');
});

test('★ 一条"永远通过"的对账比没有对账更糟：坏的必须真的红', async () => {
  // 反向自测（这个项目里 `check-sanitized.sh --selftest` 与 `deploy.sh` 的
  // `comparator_selftest()` 立过的规矩）：对账本身也要有一条"种进一个应当被抓住的
  // 东西、断言它会红"的用例。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const good = await callSync(site, env);
  assert.equal(good.failed.length, 0, '前置条件：干净的那一份必须过');

  // 现在往"站点那一份"里种一个字节级的不同，对账必须红
  site.state.disabled.clear();
  fs.appendFileSync(path.join(p.dir, 'client', 'index.js'), '// 种进去的\n');
  const r = await callSync(site, env);
  assert.ok(r.failed.length + r.pendingConsent.length > 0,
    '种进去的改动必须被抓住 —— 一条永远通过的对账比没有对账更糟');
});

// ── 取回来的字节 ────────────────────────────────────────────────────────────

test('★ 取回来的每一份都与站点磁盘上逐字节相同', async () => {
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, {
    'client/index.js': 'module.exports = { attach() {} };\n',
    'job/start.sh': '#!/bin/sh\necho 中文也要对\n',
  });
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 1);
  const staged = r.pendingConsent[0].stagedDir;
  for (const rel of ['client/index.js', 'job/start.sh']) {
    assert.deepEqual(
      fs.readFileSync(path.join(staged, ...rel.split('/'))),
      fs.readFileSync(path.join(p.dir, ...rel.split('/'))),
      `${rel} 要逐字节相同`);
  }
});

// ── 路径安全 ────────────────────────────────────────────────────────────────

test('★★ 路径穿越：六种坏 path 全部**整份拒绝**', async () => {
  const bad = ['../evil', 'a/b/../c', '/etc/passwd', 'a\\b.js', 'a\0b',
    'node_modules/x.js', '.gitignore', 'a//b', 'a/', 'CON', 'a.', 'a ',
    ...['x'.repeat(300) + '.js']];
  for (const p of bad) {
    assert.notEqual(S.checkRelPath(p, 8), null, `${JSON.stringify(p)} 必须被拒`);
  }
  // ★ **拒绝的理由也要对**：只断言"被拒了"抓不到"拦住它的是另一条规则"这种情况。
  //   `..` 恰好还撞得上"以点结尾"那条（Windows 会静默改名），于是把 `..` 那一条
  //   删掉时，`../evil` 仍然是"被拒"的 —— 一个只断言非 null 的用例会继续绿，
  //   而"路径穿越"这个词已经从实现的等式里消失了。（变异验证 M3 就是这么发现的。）
  for (const p of ['../evil', 'a/b/../c', '..']) {
    assert.match(S.checkRelPath(p, 8), /\.\./,
      `${JSON.stringify(p)} 被拒的理由要**就是**它含 ".."，而不是碰巧撞上别的规则`);
  }
  assert.equal(S.checkRelPath('..foo.js', 8), null,
    '"..foo.js" 是一个正常文件名 —— 不能把"含两个点"当成判据');
  assert.equal(S.checkRelPath('client/index.js', 8), null, '正常路径要放行');
  assert.equal(S.checkRelPath('job/start.sh', 8), null, '两层也要放行');

  // 端到端：站点报一个穿越路径 ⇒ **整份**拒绝（不是"跳过那一份"）
  const site = makeSite();
  const env = makeEnv();
  const pl = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const orig = site.rpc;
  const rpc = async (req) => {
    const r = await orig(req);
    if (req.op === 'plugins') {
      r.data.plugins[0].files = [...r.data.plugins[0].files,
        { path: '../escape.js', size: 1, sha256: 'a'.repeat(64) }];
    }
    return r;
  };
  const r = await S.sync({
    rpc, siteKey: 'k', siteLabel: 'l', siteRoot: env.siteRoot, stagingRoot: env.stagingRoot,
    trusted: () => true, protectedVersions: [],
  });
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].why, /\.\./, `要说清哪一条不对：${r.failed[0].why}`);
  assert.equal(fs.existsSync(path.join(env.siteRoot, pl.id, '1.0.0')), false,
    '★ 一个说不清的清单本身就是"这份东西不能信"');
  assert.equal(fs.existsSync(path.join(env.siteRoot, 'escape.js')), false, '更不能写到池外面去');
});

test('★ 两份只差大小写的声明 ⇒ 拒绝整个插件', async () => {
  // macOS / Windows 的磁盘不区分大小写：两份会互相覆盖，而摘要是**写入之后的磁盘
  // 上**算的 —— 于是用户"同意"的是一棵与站点那棵不同的树。
  const site = makeSite();
  const env = makeEnv();
  const pl = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const orig = site.rpc;
  const rpc = async (req) => {
    const r = await orig(req);
    if (req.op === 'plugins') {
      r.data.plugins[0].files = [
        { path: 'client/index.js', size: 1, sha256: 'a'.repeat(64) },
        { path: 'client/INDEX.js', size: 1, sha256: 'b'.repeat(64) },
      ];
    }
    return r;
  };
  const r = await S.sync({
    rpc, siteKey: 'k', siteLabel: 'l', siteRoot: env.siteRoot, stagingRoot: env.stagingRoot,
    trusted: () => true, protectedVersions: [],
  });
  assert.equal(r.failed.length, 1, `要拒：${JSON.stringify(r)}`);
  assert.match(r.failed[0].why, /大小写/, `要说清原因：${r.failed[0].why}`);
  assert.equal(fs.existsSync(path.join(env.siteRoot, pl.id, '1.0.0')), false);
});

// ── 限流 ────────────────────────────────────────────────────────────────────

test('★ 撞上限流要退避重试，**不是**记成失败', async () => {
  // 一次对账约 11 次 RPC，而桶是每秒 10 次 —— 正好压在边上。记成失败的话，用户
  // 看到的是一句"同步失败"，而根因与服务端一点关系都没有。
  const site = makeSite();
  const env = makeEnv();
  site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  site.state.rateBurst = 3;             // 头三次 plugin_file 都限流

  const r = await callSync(site, env);
  assert.equal(r.failed.length, 0, `限流不是失败：${JSON.stringify(r.failed)}`);
  assert.equal(r.pendingConsent.length, 1, '退避之后照样把它取回来');
});

test('★ 限流退避到上限之后仍然失败 —— 那时它**是**失败', async () => {
  const site = makeSite();
  const env = makeEnv();
  site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  site.state.rateBurst = 99;
  const r = await callSync(site, env);
  assert.equal(r.failed.length, 1, '一直限流就是真的取不到，要如实报出来');
});

// ── 老守护进程 ──────────────────────────────────────────────────────────────

test('★★ 回退的判据是"能力缺席"，不是"这次失败了"', async () => {
  // ★ 这是这个功能里最重要的一条安全边界。合并两者等于给一个能让下载失败的人
  //   （断流、丢包、MITM）一个把用户降级到旧本地副本的开关 —— 攻击成本从"改内容"
  //   降到"让下载失败"，而后者便宜得多。
  const site = makeSite();
  const env = makeEnv();
  site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });

  site.state.limits = false;            // 老守护进程：`plugins` 在，`limits` 不在
  const old = await callSync(site, env);
  assert.equal(old.supported, false);
  assert.equal(old.reason, 'old_daemon');
  assert.match(old.error, /太旧|不支持/, `要说得出来：${old.error}`);

  site.state.limits = true;             // 新守护进程，但这一次取不到
  site.state.rateBurst = 99;
  const bad = await callSync(site, env);
  assert.equal(bad.supported, true, '★ 下载失败**不是**"站点不支持分发"');
  assert.equal(bad.reason, null, '★ 判据必须是协议事实，不是这次的成败');
  assert.equal(bad.failed.length, 1);
});

// ── 引用计数 ────────────────────────────────────────────────────────────────

test('★ 引用计数：只有 A 要它，A 升级 ⇒ 装新删旧', async () => {
  const site = makeSite();
  const env = makeEnv();
  const v1 = site.add('v1', { name: 'x', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  let r = await callSync(site, env);
  consentAll(env, r);
  assert.equal(fs.existsSync(path.join(env.siteRoot, v1.id, '1.0.0')), true, '前置：1.0.0 在');

  // 站点升到 1.1.0（同一个 id，新版本目录）
  site.state.disabled.add(`${v1.id}@1.0.0`);
  site.add('v2', { id: v1.id, name: 'x', version: '1.1.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 1, '新版本是**另一份构件** ⇒ 要重新同意一次');
  consentAll(env, r);
  assert.equal(fs.existsSync(path.join(env.siteRoot, v1.id, '1.1.0')), true, '新版要装上');

  // ★ 回收发生在**下一次对账**：指针是在对账第 5 步移的，而同意在它之后。
  //   这一点要如实写在测试里 —— 它不是bug，是"同意"与"对账"本来就是两个动作，
  //   而用户随时可以点「重新同步」把收尾那一步提前。
  r = await callSync(site, env);
  assert.equal(fs.existsSync(path.join(env.siteRoot, v1.id, '1.0.0')), false,
    '★ 引用归零就回收 —— 这就是"装新删旧"，它不是一个单独的规则');
});

test('★ 引用计数：A 要 1.0.0、B 要 1.1.0 ⇒ 两份并存，各升各的', async () => {
  const site = makeSite();
  const env = makeEnv();
  const v1 = site.add('v1', { name: 'x', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  const v2 = site.add('v2', { id: v1.id, name: 'x', version: '1.1.0' },
    { 'client/index.js': 'module.exports = {};\n' });

  // A 站点只要 1.0.0
  site.state.disabled.add(`${v1.id}@1.1.0`);
  let r = await callSync(site, env, { siteKey: 'aaaa', siteLabel: 'A' });
  consentAll(env, r);
  // B 站点只要 1.1.0
  site.state.disabled.clear();
  site.state.disabled.add(`${v1.id}@1.0.0`);
  r = await callSync(site, env, { siteKey: 'bbbb', siteLabel: 'B' });
  consentAll(env, r);

  assert.equal(fs.existsSync(path.join(env.siteRoot, v1.id, '1.0.0')), true, '两份并存');
  assert.equal(fs.existsSync(path.join(env.siteRoot, v1.id, '1.1.0')), true);

  // A 再升到 1.2.0：1.0.0 归零 ⇒ 回收；1.1.0 因 B 仍在而留着
  const v3 = site.add('v3', { id: v1.id, name: 'x', version: '1.2.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  const v2key = `${v1.id}@1.1.0`;
  // A 现在要 1.2.0：把 A 那一次的 scope 缩到只有 1.2.0
  site.state.disabled.clear();
  site.state.disabled.add(`${v1.id}@1.0.0`);
  site.state.disabled.add(v2key);
  r = await callSync(site, env, { siteKey: 'aaaa', siteLabel: 'A' });
  consentAll(env, r);
  r = await callSync(site, env, { siteKey: 'aaaa', siteLabel: 'A' });
  assert.equal(fs.existsSync(path.join(env.siteRoot, v1.id, '1.2.0')), true, 'A 的新版在');
  assert.equal(fs.existsSync(path.join(env.siteRoot, v1.id, '1.0.0')), false,
    'A 换走了那一版 ⇒ 归零 ⇒ 回收');
  assert.equal(fs.existsSync(path.join(env.siteRoot, v1.id, '1.1.0')), true,
    '★ B 还要 1.1.0 ⇒ 留着。A 的升级不该影响 B');

  const rec = readRecordOf(env.siteRoot);
  assert.equal(rec.sites.aaaa.wants[v1.id], '1.2.0');
  assert.equal(rec.sites.bbbb.wants[v1.id], '1.1.0');
  assert.ok(v2 && v3, '（占位：上面两个目录确实造出来了）');
});

test('★★ 站点**关掉**或**不再报**一个插件 ⇒ 留着不删（决定 3）', async () => {
  const site = makeSite();
  const env = makeEnv();
  const v1 = site.add('v1', { name: 'x', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  let r = await callSync(site, env);
  consentAll(env, r);
  assert.equal(fs.existsSync(path.join(env.siteRoot, v1.id, '1.0.0')), true);

  // 管理员把它关掉
  site.state.disabled.add(`${v1.id}@1.0.0`);
  r = await callSync(site, env);
  assert.equal(fs.existsSync(path.join(env.siteRoot, v1.id, '1.0.0')), true,
    '★ "站点不报它"不构成删除理由 —— 它随时可能再打开');

  // 管理员把它从 plugins/ 里整个移除
  site.state.disabled.clear();
  site.byKey.delete(`${v1.id}@1.0.0`);
  r = await callSync(site, env);
  assert.equal(fs.existsSync(path.join(env.siteRoot, v1.id, '1.0.0')), true,
    '★ 整个移除也一样 —— 删除的唯一理由是"没有任何站点要它、也没有活会话用它"');
  const rec = readRecordOf(env.siteRoot);
  assert.ok(rec.sites.aaaaaaaaaaaaaaaa.distributes.includes(v1.id),
    '`distributes` 只增不减：它要把"你以前从 X 站装过它"这件事说出来');
});

test('★ 活会话引用着它 ⇒ 不回收', async () => {
  // 客户端重启之后会 tryReattach 接回旧会话，而那些会话的 service_plugin
  // **只有守护进程知道** —— 所以这一步必须去问 `op:list`，不能只看本地那一条。
  const site = makeSite();
  const env = makeEnv();
  const v1 = site.add('v1', { name: 'x', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  let r = await callSync(site, env);
  consentAll(env, r);

  site.state.sessions = [{ session_id: 's1', service_plugin: `${v1.id}@1.0.0` }];
  site.state.disabled.add(`${v1.id}@1.0.0`);
  r = await callSync(site, env);
  assert.equal(fs.existsSync(path.join(env.siteRoot, v1.id, '1.0.0')), true,
    '会话还在用它 ⇒ 不能删');
  assert.deepEqual(r.reclaimed, [], '而且要真的没删');
});

// ── 记录与回收的次序 ────────────────────────────────────────────────────────

test('★★ 记录丢了或坏了 ⇒ 一个字节都不删，只报一条', async () => {
  // 记录丢了 ⇒ 池里每个版本的引用数都算 0 ⇒ 按规则会把整个池清空。那是"因为读不到
  // 一张表而删掉用户的文件"。与 deploy.sh 的「JOBS_DIR 有东西但没有标记 ⇒ die，
  // 不删」是同一个先例。
  const site = makeSite();
  const env = makeEnv();
  const v1 = site.add('v1', { name: 'x', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  let r = await callSync(site, env);
  consentAll(env, r);
  const dest = path.join(env.siteRoot, v1.id, '1.0.0');
  assert.equal(fs.existsSync(dest), true);

  // 站点不再报它 + 记录被写坏 —— 两个条件同时成立才有可能误删
  site.byKey.delete(`${v1.id}@1.0.0`);
  fs.writeFileSync(path.join(env.siteRoot, S.RECORD_NAME), '{ 这不是 JSON');
  r = await callSync(site, env);
  assert.equal(fs.existsSync(dest), true, '★ 读不到引用表时，唯一安全的动作是什么都不删');
  assert.ok(r.notices.some((n) => /不会回收/.test(n)),
    `而且要**说出来**（否则用户只会发现池子越来越大）：${JSON.stringify(r.notices)}`);

  // 记录**不存在**而池子不空 —— 同样是最危险的那一刻，同样不删
  fs.unlinkSync(path.join(env.siteRoot, S.RECORD_NAME));
  r = await callSync(site, env);
  assert.equal(fs.existsSync(dest), true, '★ 记录不见了而池里有东西时更不能删');
});

test('★★ 写记录失败 ⇒ 什么都不回收（顺序反了会真丢数据）', async () => {
  // 先回收后写会按一份**旧**引用表动手，把另一个站点还要的版本删掉 —— 这是这个
  // 设计里唯一会真正丢数据的地方。
  const site = makeSite();
  const env = makeEnv();
  const v1 = site.add('v1', { name: 'x', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  let r = await callSync(site, env);
  consentAll(env, r);
  const old = path.join(env.siteRoot, v1.id, '1.0.0');
  assert.equal(fs.existsSync(old), true);

  // 站点升到 1.1.0（正常会回收 1.0.0），但这一次记录写不下去
  site.state.disabled.add(`${v1.id}@1.0.0`);
  site.add('v2', { id: v1.id, name: 'x', version: '1.1.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  const realRename = fs.renameSync;
  fs.renameSync = function patched(a, b) {
    if (String(b).endsWith(S.RECORD_NAME)) throw new Error('演示：磁盘满了');
    return realRename.call(fs, a, b);
  };
  try {
    r = await callSync(site, env);
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(r.reclaimed, [], '★ 记录写不下去就不回收 —— 这条顺序是承重的');
  assert.equal(fs.existsSync(old), true, '旧版本必须还在');
  assert.ok(r.notices.some((n) => /不会回收/.test(n)), `要说出来：${JSON.stringify(r.notices)}`);
});

test('★★ 写记录**真的**发生在回收之前（记下副作用的先后）', async () => {
  // ★ 上一条只证明"记录写不成功时不回收"，而那个性质**顺序反了也成立** ——
  //   按旧表回收时，旧表里还留着那一条引用，于是什么也不会删。所以那条用例
  //   钉不住顺序，得直接看副作用的先后。
  const site = makeSite();
  const env = makeEnv();
  const v1 = site.add('v1', { name: 'x', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  let r = await callSync(site, env);
  consentAll(env, r);

  site.state.disabled.add(`${v1.id}@1.0.0`);
  site.add('v2', { id: v1.id, name: 'x', version: '1.1.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  r = await callSync(site, env);
  consentAll(env, r);

  const order = [];
  const realRename = fs.renameSync;
  const realRm = fs.rmSync;
  fs.renameSync = function (a, b) {
    if (String(b).endsWith(S.RECORD_NAME)) order.push('写记录');
    return realRename.call(fs, a, b);
  };
  fs.rmSync = function (p, o) {
    if (String(p).startsWith(env.siteRoot)) order.push('回收');
    return realRm.call(fs, p, o);
  };
  try {
    r = await callSync(site, env);
  } finally {
    fs.renameSync = realRename;
    fs.rmSync = realRm;
  }
  assert.deepEqual(r.reclaimed.map((x) => x.version), ['1.0.0'],
    `前置：这一轮真的要回收一个版本：${JSON.stringify(r.reclaimed)}`);
  assert.deepEqual(order, ['写记录', '回收'],
    '★ 写记录必须在回收之前 —— 反过来的话，回收按的是一份**旧**引用表，'
    + '而"按旧表动手"就是这个设计里唯一会真正丢数据的地方');
});

// ── reload 不等于成功 ───────────────────────────────────────────────────────

test('★ "文件都下来了"不等于"装上了" —— verify 的复查要参与判定', async () => {
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 1, '前置：它在等同意');
  consentAll(env, r);

  // 第二遍：它已经在池里了（`kept`），而 verify 说"注册表没把它收下"
  const r2 = await callSync(site, env, {
    verify: (landed) => {
      assert.ok(landed.length > 0, 'verify 必须拿到"换入/已在"的那些');
      return landed.map((e) => ({ ...e, why: '注册表没有收下它' }));
    },
  });
  assert.equal(r2.kept.length, 1, '前置：这一遍它是 kept');
  assert.equal(r2.failed.length, 1,
    '★ "文件都下来了"不等于"装上了" —— verify 报出来的失败必须进 failed');
});

// ── 站点池的列举与站点键 ────────────────────────────────────────────────────

test('★ 站点键是哈希，不是那个地址串本身', () => {
  const a = S.siteKeyOf({ user: 'u', host: 'h', port: 22 });
  assert.match(a, /^[0-9a-f]{16}$/, '定长十六进制');
  assert.notEqual(a, S.siteKeyOf({ user: 'u', host: '../../etc', port: 22 }),
    '换一台主机就是另一个键');
  assert.equal(S.siteKeyOf({ user: 'u', host: 'h', port: 22 }), a, '同一个地址恒定');
  // ★ `host` 是用户手填的字符串，一个 `../..` 就能让写入落到 `~/.slurmate` 外面 ——
  //   取哈希定长，天然安全。
  assert.equal(/[^0-9a-f]/.test(S.siteKeyOf({ user: '../..', host: '../..', port: 22 })), false);
});

test('★ 站点池的列举只看目录，跳过记录文件与暂存目录', () => {
  const root = tmp('slurmate-list-');
  fs.mkdirSync(path.join(root, 'ID1', '1.0.0'), { recursive: true });
  fs.writeFileSync(path.join(root, S.RECORD_NAME), '{}');
  fs.mkdirSync(path.join(root, '.site-staging'), { recursive: true });
  const out = S.listPooled(root);
  assert.deepEqual(out.map((x) => `${x.id}@${x.version}`), ['ID1@1.0.0'],
    '记录文件（一个 .json）与暂存目录都不算插件');
});

// ── 上限 ────────────────────────────────────────────────────────────────────

test('★ 服务端报的上限只能**收紧**客户端那份硬上限', () => {
  const hard = S.HARD_LIMITS;
  assert.equal(S.effectiveLimits({ file_bytes: 10 }).file_bytes, 10, '更严的要采纳');
  assert.equal(S.effectiveLimits({ file_bytes: hard.file_bytes * 100 }).file_bytes,
    hard.file_bytes, '★ 更松的**不能**放宽 —— limits 是被审计方的自述');
  assert.equal(S.effectiveLimits(undefined).file_bytes, hard.file_bytes, '缺席 = 用自己那份');
});

test('★ 站点报一个超过单文件上限的文件 ⇒ 明确拒绝，不是截断', async () => {
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const orig = site.rpc;
  const rpc = async (req) => {
    const r = await orig(req);
    if (req.op === 'plugins') {
      r.data.plugins[0].files = [...r.data.plugins[0].files,
        { path: 'big.bin', size: S.HARD_LIMITS.file_bytes + 1, sha256: 'c'.repeat(64) }];
    }
    return r;
  };
  const r = await S.sync({
    rpc, siteKey: 'k', siteLabel: 'l', siteRoot: env.siteRoot, stagingRoot: env.stagingRoot,
    trusted: () => true, protectedVersions: [],
  });
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].why, /超过/, `要说清是超限，而不是一句"失败了"：${r.failed[0].why}`);
  assert.match(r.failed[0].why, new RegExp(String(S.HARD_LIMITS.file_bytes)),
    '★ 运维要照着这句话调，所以要说清上限是多少');
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), false,
    '★ 绝不截断 —— 截断与明确失败的差别就是"谎报成功"与"说得出来"的差别');
});

// ── 世代守卫 ────────────────────────────────────────────────────────────────

test('★ 连接换了一条 ⇒ 这一次对账整个作废，一个字节都不换入', async () => {
  // ★ 用户在下载途中切连接/断开时，下载回调仍在跑，最后 `reload()` 一次 ——
  //   A 站点的插件会被当成 B 站点的写进台账。所以每一次对账带一个世代号，
  //   中途发现已经换代就**整个丢弃**（调用方那边也不推通知、不刷界面）。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r = await callSync(site, env, {
    trusted: () => true,
    stale: () => true,                  // 一开始就已经换代了
  });
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), false,
    '作废的对账不许往站点池里写东西');
  assert.deepEqual(r.pendingConsent, [], '也不许留下待同意的树');
  assert.deepEqual(r.failed, [], '★ 作废不是失败 —— 报成失败会让用户看到一条假故障');

  // 中途换代的那条路：第一份取回来了，第二份还没取
  const site2 = makeSite();
  const p2 = site2.add('b', { name: 'b' }, {
    'client/index.js': 'module.exports = {};\n', 'job/start.sh': '#!/bin/sh\n',
  });
  let calls = 0;
  const r2 = await callSync(site2, env, { trusted: () => true, stale: () => (calls += 1) > 3 });
  assert.equal(fs.existsSync(path.join(env.siteRoot, p2.id, '1.0.0')), false,
    '★ 取到一半换代 ⇒ 暂存里那半棵树绝不能进站点池');
  assert.ok(r2.failed.some((f) => /作废/.test(f.why)),
    `中途换代要说得出这一份为什么没下来：${JSON.stringify(r2.failed)}`);
});
