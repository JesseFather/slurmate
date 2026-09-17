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
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../src/main/site-plugins.js');
const P = require('../src/main/plugins/index.js');
const PP = require('../src/main/plugin-package.js');
const ulid = require('../src/main/plugins/ulid.js');
// 演示/测试用的包**由仓库里那个打包器现打**，不手搓字节：手搓一份就是在这里又
// 实现了一遍容器格式，而它与真格式分家的那天，测试反而会说"一切正常"。
const PACKER = require('../../packer/slurmate-packer.js');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

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
    // ── 整包那条路（默认关：逐份那条路要有东西在测）──
    packages: false,
    pkgFormat: 1,              // `op_plugins` 里报出去的格式
    pkgByteDelta: 0,           // 报出去的字节数偏离真实值多少
    pkgDigestLie: false,       // 报出去的内容摘要是假的
    pkgCorrupt: false,         // `plugin_package` 发出来的字节被改了一位
    pkgKey: null,              // 签名钥匙（每造一个站点一把，所以两个站点不同）
    pkgCalls: 0,               // 整包那条路被打了几次（用来验"一条 RPC"）
    fileCalls: 0,
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

  /** 这个站点的签名钥匙。**每个站点一把**，所以"签名者换了人"造得出来。 */
  function key() {
    if (!state.pkgKey) {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      const pub = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
        .subarray(-32);
      state.pkgKey = { priv: privateKey, pub, fingerprint: sha256hex(pub) };
    }
    return state.pkgKey;
  }

  /** 现打一个包（缓存 —— 真实守护进程也是"启动快照"，见 Sessiond._plugin_cache）。 */
  const pkgCache = new Map();
  function pkgOf(key2) {
    if (pkgCache.has(key2)) return pkgCache.get(key2);
    const e = byKey.get(key2);
    const files = declared(key2).map((f) => ({
      path: f.path,
      data: fs.readFileSync(path.join(e.dir, ...f.path.split('/'))),
      sha256: f.sha256,
    }));
    const digest = PACKER.contentDigest(files);
    const k = key();
    const sig = crypto.sign(null, Buffer.from(digest, 'hex'), k.priv);
    const buf = PACKER.buildPackage(files, Buffer.concat([Buffer.from([1]), k.pub, sig]));
    const out = { buf, digest, fingerprint: k.fingerprint };
    pkgCache.set(key2, out);
    return out;
  }

  async function rpc(req) {
    if (req.op === 'plugins') {
      const plugins = [...byKey.keys()].map((key2) => {
        const e = byKey.get(key2);
        const out = {
          id: e.mf.id, name: e.mf.name, version: e.mf.version, title: e.mf.displayName,
          enabled: !state.disabled.has(key2), can_submit: true, defaults: { cpus: 2, mem: '8G' },
        };
        if (!state.hideFiles.has(key2)) out.files = declared(key2);
        if (state.packages) {
          const p = pkgOf(key2);
          out.package = {
            format: state.pkgFormat,
            bytes: p.buf.length + state.pkgByteDelta,
            digest: state.pkgDigestLie ? 'f'.repeat(64) : p.digest,
          };
        }
        return out;
      });
      for (const x of state.extra) plugins.push(x);
      const data = { plugins, enabled: plugins.filter((p) => p.enabled).map((p) => p.name) };
      // ★ 能力信号是**协议事实**：顶层有没有 `limits`。老守护进程整个字段都没有。
      if (state.limits) {
        data.limits = { file_bytes: 256 * 1024, total_bytes: 1 << 20, max_files: 256 };
        if (state.packages) data.limits.package_bytes = 4 << 20;
      }
      return { ok: true, data };
    }
    if (req.op === 'list') return { ok: true, data: { sessions: state.sessions } };
    if (req.op === 'plugin_package') {
      state.pkgCalls += 1;
      if (state.rateBurst > 0) {
        state.rateBurst -= 1;
        return { ok: false, code: 7, error: { kind: 'rate_limited', detail: '演示：打满桶' } };
      }
      const key2 = `${req.id}@${req.version}`;
      if (!byKey.has(key2)) {
        return { ok: false, code: 3, error: { kind: 'plugin_unknown', detail: key2 } };
      }
      const p = pkgOf(key2);
      let buf = p.buf;
      if (state.pkgCorrupt) {
        // 改**负载里**的一个字节 ⇒ 逐份校验必须抓到（改的是字节，不是那张表）。
        buf = Buffer.from(buf);
        buf[buf.length - 1] ^= 0xff;
      }
      return { ok: true,
               data: { format: 1, bytes: p.buf.length, digest: p.digest,
                       data: buf.toString('base64') } };
    }
    if (req.op === 'plugin_file') {
      state.fileCalls += 1;
      if (state.rateBurst > 0) {
        state.rateBurst -= 1;
        return { ok: false, code: 7, error: { kind: 'rate_limited', detail: '演示：打满桶' } };
      }
      const key2 = `${req.id}@${req.version}`;
      if (!byKey.has(key2)) {
        return { ok: false, code: 3, error: { kind: 'plugin_unknown', detail: key2 } };
      }
      const hit = declared(key2).find((f) => f.path === req.path);
      if (!hit) {
        return { ok: false, code: 3, error: { kind: 'plugin_file_unknown', detail: req.path } };
      }
      const buf = fs.readFileSync(path.join(byKey.get(key2).dir, ...req.path.split('/')));
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

  return { src, state, add, declared, rpc, byKey, pkgOf };
}

/** 一次对账的环境：站点池 + 暂存 + 台账 + 钉子。 */
function makeEnv() {
  const siteRoot = tmp('slurmate-sitepool-');
  const stagingRoot = tmp('slurmate-staging-');
  const trusted = new Map();          // `<id>@<版本>` → 摘要（模拟 cfg.trustedPlugins）
  const pinned = new Map();           // id → 公钥指纹（模拟 pinned-keys.json）
  const forgotten = [];               // 被撤回同意的那些
  return { siteRoot, stagingRoot, trusted, pinned, forgotten };
}

function callSync(site, env, over = {}) {
  return S.sync({
    rpc: (req) => site.rpc(req),
    siteKey: over.siteKey || 'aaaaaaaaaaaaaaaa',
    siteLabel: over.siteLabel || 'u@h:22',
    siteRoot: env.siteRoot,
    stagingRoot: env.stagingRoot,
    trusted: over.trusted || ((id, v, d) => env.trusted.get(`${id}@${v}`) === d),
    // ★ §5.3 的撤回：与 config.forgetPlugin 同一个语义 —— 删掉那一条、如实报告
    //   有没有删到东西。**它发生在信任判定之前**，所以"静默装回来"结构上不存在。
    forgetTrust: over.forgetTrust || ((id, v) => {
      const k = `${id}@${v}`;
      const had = env.trusted.delete(k);
      if (had) env.forgotten.push(k);
      return { had };
    }),
    pinnedKey: over.pinnedKey || ((id) => env.pinned.get(id)),
    protectedVersions: over.protectedVersions || [],
    stale: over.stale || (() => false),
    now: over.now || (() => 1700000000000),
    verify: over.verify,
  });
}

/**
 * 把一次对账里所有待同意的都"点一下同意"。
 *
 * ★ 走的是**界面上那个动作的同一段代码**（`acceptStaged` + `noteConsent` + 台账 +
 *   钉钉子），不是测试自己另发明一套 —— 否则测的就是另一个实现。
 */
function consentAll(env, r, over = {}) {
  for (const p of r.pendingConsent) {
    const mv = S.acceptStaged({
      stagedDir: p.stagedDir, stagedPkg: p.stagedPkg || null, siteRoot: env.siteRoot,
      id: p.id, version: p.version, digest: p.digest,
      // ★ 「已经在池里」那一份是**原地认领**，不是换入 —— 见 acceptStaged。
      existing: Boolean(p.existing),
    });
    assert.equal(mv.ok, true, `同意 ${p.id}@${p.version} 应当成功：${mv.error}`);
    const nc = S.noteConsent({
      siteRoot: env.siteRoot, siteKey: p.siteKey, siteLabel: p.siteLabel,
      id: p.id, version: p.version,
    });
    assert.equal(nc.ok, true, `同意要同时记进引用表：${nc.why}`);
    env.trusted.set(`${p.id}@${p.version}`, p.digest);
    // §5.4：钉住签名者 —— 与 index.js 的 app:consentPlugin 同一个动作、同一个时机
    // （台账写完之后）。没签名的那一份什么都不钉。
    if (p.fingerprint) env.pinned.set(p.id, p.fingerprint);
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
  // ★ 回收一个版本现在是**两下** `rmSync`（解出来的树 + 旁边那个包），所以这里
  //   把连续重复的合成一下。被断言的性质一个字没变：**第一次回收**必须晚于写记录。
  const seq = order.filter((x, i) => i === 0 || x !== order[i - 1]);
  assert.deepEqual(r.reclaimed.map((x) => x.version), ['1.0.0'],
    `前置：这一轮真的要回收一个版本：${JSON.stringify(r.reclaimed)}`);
  assert.deepEqual(seq, ['写记录', '回收'],
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

// ══════════════════════════════════════════════════════════════════════════
//  整包：同一个内容的两条投递方式
// ══════════════════════════════════════════════════════════════════════════
//
// ★ 这一组要钉住的是一件很具体的事：**走哪条路不该改变"装上了什么"**。
//   所以第一条用例就是把同一份内容两条路各装一遍，然后比摘要 —— 差一个字节
//   都说明两条路在描述两棵不同的树。

test('★★ 两条投递方式装出来的东西**逐字节相同**（包那条路一条 RPC 取完）', async () => {
  // 同一个插件、两个站点，一个只发文件、一个也发整包。
  const byFiles = makeSite();
  const pf = byFiles.add('a', { name: 'a' },
    { 'client/index.js': 'module.exports = {};\n', 'job/start.sh': '#!/bin/sh\n' });
  // ★ 第二个站点必须造出**逐字节相同**的插件（同一个 id 与内容）——
  //   拿第一个站点的目录当模板。
  const byPkg = makeSite();
  const pp = byPkg.add('a', { id: pf.id, name: 'a', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n', 'job/start.sh': '#!/bin/sh\n' });
  byPkg.state.packages = true;

  const env1 = makeEnv();
  const env2 = makeEnv();
  const r1 = await callSync(byFiles, env1);
  const r2 = await callSync(byPkg, env2);
  assert.equal(r1.pendingConsent.length, 1, JSON.stringify(r1.failed));
  assert.equal(r2.pendingConsent.length, 1, JSON.stringify(r2.failed));
  assert.equal(r1.pendingConsent[0].digest, r2.pendingConsent[0].digest,
    '★ 同一个内容走两条路必须算出同一个摘要 —— 不然"你同意的"与"装上的"会各说各的');

  // ★ 一条 RPC 取完 vs 一份一份取：这是这两条路唯一的**行为**差别。
  assert.equal(byPkg.state.pkgCalls, 1, '整包只该问一次');
  assert.equal(byPkg.state.fileCalls, 0, '★ 有包就不该再逐份取 —— 两条路都走等于白跑一趟');
  assert.ok(byFiles.state.fileCalls >= 2, `逐份那条路要一份一次：${byFiles.state.fileCalls}`);
  assert.equal(byFiles.state.pkgCalls, 0, '只发文件的站点不该被问整包');

  consentAll(env2, r2);
  // 池里**两样挨着**：解出来的树 + 那个包。
  const tree = path.join(env2.siteRoot, pp.id, '1.0.0');
  const pkgFile = S.pkgPathOf(env2.siteRoot, pp.id, '1.0.0');
  assert.equal(fs.existsSync(tree), true, '树要进池（require 用的是它）');
  assert.equal(fs.existsSync(pkgFile), true, '★ 包也要进池 —— 它是这一份的来路凭证');
  assert.equal(S.listPooled(env2.siteRoot)[0].hasPackage, true);

  // 池里那两样与站点发出来的包**逐字节相同**。
  const onDisk = fs.readFileSync(pkgFile);
  const parsed = PP.parsePackage(onDisk);
  assert.equal(parsed.ok, true, parsed.why);
  assert.equal(parsed.digest, byPkg.pkgOf(`${pp.id}@1.0.0`).digest);
  assert.equal(parsed.sig.fingerprint, byPkg.state.pkgKey.fingerprint,
    '池里那个包自带的签名者就是站点那把钥匙');
});

test('★ 站点自报的内容摘要与它实际发的字节对不上 ⇒ 拒绝，绝不换入', async () => {
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  site.state.pkgDigestLie = true;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 0, '对不上的东西不许走进同意闸');
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /说的不是同一份东西/, r.failed[0].why);
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), false,
    '★ 一个字节都不许进池');
});

test('★ 包里的字节被改过 ⇒ 拒绝，而且**绝不退回逐份那条路**', async () => {
  // ★ 这条是这一组里最承重的一条。逐份那条路**没有签名**（它发的是散装字节），
  //   所以"包验不过就改用文件"等于给出一条绕过验签的路 —— 一个能让包验不过的人
  //   就获得了一次投递未验签内容的机会。那不是"降级"，那是把验签变成一句建议。
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  site.state.pkgCorrupt = true;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 0);
  assert.equal(site.state.fileCalls, 0,
    '★ 包读不了的时候**一次 `plugin_file` 都不许发** —— 那就是回退');
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /读不了|不符/, r.failed[0].why);
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), false);
});

test('★ 包格式比客户端认得的新 ⇒ **退回逐份那条路**（而且说出来）', async () => {
  // ★ 与上一条**方向相反**，所以两条必须都在：那一条是"这个包坏了"（拒绝），
  //   这一条是"这个包是用一种我读不懂的说法写的"（格式演进，必须能加法过渡）。
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  site.state.pkgFormat = 2;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 1, `回退要把东西装上：${JSON.stringify(r.failed)}`);
  assert.equal(site.state.pkgCalls, 0, '★ 读不懂的格式，一次都不该去取');
  assert.ok(site.state.fileCalls >= 1, '退回逐份取');
  assert.equal(r.reason, 'site_too_new', '要有一态说明"站点比客户端新"');
  assert.ok(r.notices.some((n) => /格式/.test(n)), JSON.stringify(r.notices));

  // 而**没有退路**的时候（站点只发包、不发文件）它是一条失败，不是静默跳过。
  const site2 = makeSite();
  const env2 = makeEnv();
  site2.state.packages = true;
  site2.state.pkgFormat = 2;
  const p2 = site2.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  site2.state.hideFiles.add(`${p2.id}@1.0.0`);
  site2.state.pkgFormat = 2;
  const r2 = await callSync(site2, env2);
  assert.equal(r2.failed.length, 1, JSON.stringify(r2.failed));
  assert.match(r2.failed[0].why, /只认识 1/, r2.failed[0].why);
});

test('★ 逐份清单与整包说的不是同一份东西 ⇒ 拒绝（两份说法对不上）', async () => {
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  const p = site.add('a', { name: 'a' },
    { 'client/index.js': 'module.exports = {};\n', 'x.txt': '一' });
  const orig = site.rpc;
  const rpc = async (req) => {
    const r = await orig(req);
    if (req.op === 'plugins') {
      // 清单里多报一份包里没有的文件 —— 老客户端会照着它去取、并且失败。
      r.data.plugins[0].files = [...r.data.plugins[0].files,
        { path: 'ghost.txt', size: 1, sha256: 'a'.repeat(64) }];
    }
    return r;
  };
  const r = await S.sync({
    rpc, siteKey: 'k', siteLabel: 'l', siteRoot: env.siteRoot, stagingRoot: env.stagingRoot,
    trusted: () => true, protectedVersions: [],
  });
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /两份说法对不上/, r.failed[0].why);
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), false);
});

test('★ 站点自报的字节数与实际的包对不上 ⇒ 拒绝', async () => {
  // ★ 客户端**没法**在取之前知道真包多大，所以这一条只能取回来之后判 —— 判据是
  //   自己数出来的字节数，不是响应里那个 `bytes`。数字对不上说明"站点说它发的是
  //   什么"与"它实际发的是什么"不是一回事。
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  site.state.pkgByteDelta = 7;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r = await callSync(site, env);
  assert.equal(site.state.pkgCalls, 1, '取一次才知道对不对');
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /字节/, r.failed[0].why);
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), false);
  assert.equal(fs.existsSync(S.pkgPathOf(env.siteRoot, p.id, '1.0.0')), false,
    '★ 对不上就不许进池 —— 连那个包也不许');
});

test('★ 包里的内容超过站点自报的上限 ⇒ 拒绝（两条路同一套上限）', async () => {
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  const p = site.add('a', { name: 'a' },
    { 'client/index.js': 'module.exports = {};\n', 'big.txt': 'x'.repeat(300 * 1024) });
  // ★ 把 `files` 藏起来是**承重的**：不藏的话，站点报的那份逐份清单会**先**被
  //   `checkDeclared` 拦下（那一条也在测，但测的是另一个入口），于是"包里的负载
  //   有没有过上限"这件事根本没被执行到 —— 那条用例会在实现被改坏时照样绿。
  site.state.hideFiles.add(`${p.id}@1.0.0`);
  const orig = site.rpc;
  const rpc = async (req) => {
    const r = await orig(req);
    if (req.op === 'plugins') r.data.limits.file_bytes = 1024;   // 站点自报更严
    return r;
  };
  const r = await S.sync({
    rpc, siteKey: 'k', siteLabel: 'l', siteRoot: env.siteRoot, stagingRoot: env.stagingRoot,
    trusted: () => true, protectedVersions: [],
  });
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /1024/, r.failed[0].why);
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), false);
});

test('★ 整包超过**链路**上限 ⇒ 拒绝，而且一次都不去取', async () => {
  // ★ `package_bytes` 是**另一笔账**：前面那几个数说的是"解出来那些有多大"，
  //   它说的是"整包 base64 之后装不装得进一条应答"。所以它必须**单独判** ——
  //   拿负载上限去推链路上限，正是这一版之前算错的那笔账。
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const orig = site.rpc;
  const rpc = async (req) => {
    const r = await orig(req);
    if (req.op === 'plugins') r.data.limits.package_bytes = 100;   // 站点自报更严
    return r;
  };
  const r = await S.sync({
    rpc, siteKey: 'k', siteLabel: 'l', siteRoot: env.siteRoot, stagingRoot: env.stagingRoot,
    trusted: () => true, protectedVersions: [],
  });
  assert.equal(site.state.pkgCalls, 0, '★ 自述就说不成立，白跑一次传输没意义');
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /100/, r.failed[0].why);
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), false);
});

test('★ 「站点愿不愿意发这一份」的判据是**两条路里有没有一条能走**', () => {
  // ★ 界面拿它分"本站有而本机没有，等同步/点同意"与"本站根本没打算发这一版"。
  //   判据写成"有没有 `files`"的话，一个**只发包**的站点（v0.8 的形状）会被
  //   说成"站点没有报出它的文件"—— 而它明明发了。
  const fp = 'a'.repeat(64);
  const meta = { format: 1, bytes: 100, digest: fp };
  assert.equal(S.deliveryOf({ files: null, package: meta }, S.HARD_LIMITS).mode, 'package',
    '只发包也算"愿意发"');
  assert.equal(S.deliveryOf({ files: [{ path: 'x', size: 1, sha256: fp }] }, S.HARD_LIMITS).mode,
    'files', '只发文件也算');
  assert.equal(S.deliveryOf({ files: null, package: null }, S.HARD_LIMITS).mode, null,
    '★ 两个都没有 = 这一份不分发（`package: null` 是"此刻生产不出来"，不是"没有这个能力"）');
  assert.equal(S.deliveryOf({}, S.HARD_LIMITS).mode, null, '缺席也是不分发');
});

// ══════════════════════════════════════════════════════════════════════════
//  §5.4 钉子：签名者必须是同一把钥匙
// ══════════════════════════════════════════════════════════════════════════

test('★★ 钉过之后签名者换了人 ⇒ 拒绝，并把**两把**指纹都说出来', async () => {
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });

  // 第一次：没钉过 ⇒ 首次即信任，指纹随待同意项一起交到界面上。
  const r1 = await callSync(site, env);
  assert.equal(r1.pendingConsent.length, 1, JSON.stringify(r1.failed));
  const fp1 = r1.pendingConsent[0].fingerprint;
  assert.equal(fp1, site.state.pkgKey.fingerprint, '指纹要从**包本身**算，不是站点自报');

  // ★ 而**签名者换了人、内容一个字没变**：另一个站点用另一把钥匙发同一份内容。
  const other = makeSite();
  other.state.packages = true;
  other.add('a', { id: p.id, name: 'a', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  const env2 = makeEnv();
  env2.pinned.set(p.id, fp1);
  const r2 = await callSync(other, env2);
  assert.equal(r2.pendingConsent.length, 0, '★ 换人不能只是"再问一次"');
  assert.equal(r2.failed.length, 1, JSON.stringify(r2.failed));
  const why = r2.failed[0].why;
  assert.match(why, new RegExp(fp1), '★ 必须说出**钉住的那一把**：运维要拿它去核对');
  assert.match(why, new RegExp(other.state.pkgKey.fingerprint), '★ 也要说出**这一份的**');
});

test('★ 钉过之后收到一份**没有签名**的（逐份那条路）⇒ 拒绝', async () => {
  // ★ 逐份那条路发的是散装字节，证不了它是同一个人做的 —— 钉过之后就不能收。
  //   不这么判的话，"让整包那条路失败"就成了一个绕开钉子的开关。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  env.pinned.set(p.id, 'a'.repeat(64));
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 0);
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /没有签名/, r.failed[0].why);
  assert.match(r.failed[0].why, new RegExp('a'.repeat(64)), '要说清钉的是哪一把');
});

test('★ 一条读不动的钉子 ⇒ 拒绝（绝不静默重新"首次即信任"一次）', async () => {
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  env.pinned.set(p.id, '');            // config.pinnedKeyOf 对读不动的记录给的就是这个
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 0);
  assert.match(r.failed[0].why, /钉子读不出来/, r.failed[0].why);
});

test('★ 池里已有那一份、台账对不上，而钉子对不上 ⇒ 拒绝（不是"再问一次"）', async () => {
  // ★ 那条路上**也要判钉子**：它是"本机有一份、要重新问一次"的那条路，而
  //   "再问一次"不等于"可以换个人"。不判的话，一次改摘要（或者删配置）就成了
  //   绕开 §5.4 的入口 —— 用户会看到一个正常的同意对话框，而签名者已经换了。
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  consentAll(env, r1);            // 同意过 ⇒ 池里有那一份，而且钉过一把钥匙

  env.trusted.clear();            // 台账对不上（换机器、换公式、手删配置）
  const bogus = 'c'.repeat(64);
  env.pinned.set(p.id, bogus);    // 而钉子上是**另一把**
  const r2 = await callSync(site, env);
  assert.equal(r2.pendingConsent.length, 0, '★ 签名者对不上时连同意按钮都不该出现');
  assert.equal(r2.failed.length, 1, JSON.stringify(r2.failed));
  assert.match(r2.failed[0].why, new RegExp(bogus), '要说清钉住的是哪一把');
  assert.match(r2.failed[0].why, new RegExp(site.state.pkgKey.fingerprint),
    '也要说清这一份是谁签的');
});

// ══════════════════════════════════════════════════════════════════════════
//  那个洞：池里已经有一份，而台账对不上
// ══════════════════════════════════════════════════════════════════════════

test('★★ 池里有一份、台账对不上 ⇒ 进待同意（**不能消失**），同意是"原地认领"', async () => {
  // ★ 这一段以前不存在，而它不在的后果是：插件在注册表里（`active: false`），
  //   于是 `missing` 不认领它（那边要求查不到），而 `plugins` 那一列又滤掉了它
  //   —— 界面上彻底看不见，连"点同意"的入口都没有。摘要换一次公式就会对
  //   **每个用户的每个插件**成立。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });

  // 第一次：正常下来、正常同意。
  const r1 = await callSync(site, env);
  consentAll(env, r1);
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), true);

  // ★ 台账那一条不见了（用户换过机器 / 删过配置 / 换过摘要公式）。
  env.trusted.clear();
  const r2 = await callSync(site, env);
  assert.deepEqual(r2.kept, [], '台账对不上就不算"已经有了"');
  assert.equal(r2.pendingConsent.length, 1,
    `★★ 它必须走进待同意 —— 这就是那个洞：${JSON.stringify(r2)}`);
  const item = r2.pendingConsent[0];
  assert.equal(item.existing, true, '★ 要标明"本机已经有一份"（出路与草稿不同）');
  assert.equal(item.stagedDir, path.join(env.siteRoot, p.id, '1.0.0'),
    '指向的是**池里那一份**，不是暂存里的草稿');

  // ── 点同意 ⇒ 原地认领：不 rename、不重下、直接记台账 ──
  const mv = S.acceptStaged({
    stagedDir: item.stagedDir, siteRoot: env.siteRoot, id: p.id, version: '1.0.0',
    digest: item.digest, existing: true,
  });
  assert.equal(mv.ok, true, mv.error);
  assert.equal(fs.existsSync(item.stagedDir), true, '★ 原地认领不能把那一份弄没了');
  env.trusted.set(`${p.id}@1.0.0`, item.digest);
  const r3 = await callSync(site, env);
  assert.deepEqual(r3.pendingConsent, []);
  assert.equal(r3.kept.length, 1, '认领之后它就回到"已经有了"');
});

test('★★ 对"已在池里"的那一份点不同意 ⇒ **删掉池里那一份**，不是留着', async () => {
  // 留着的话它就是一个"用户在界面上拒绝了、却仍然躺在磁盘上"的插件，而且下次
  // 对账会**以同一个形状回来**（台账里没有它、树还在）—— 用户点一百次也去不掉。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  consentAll(env, r1);
  env.trusted.clear();
  const r2 = await callSync(site, env);
  assert.equal(r2.pendingConsent[0].existing, true);

  const d = S.dropPooledVersion(env.siteRoot, p.id, '1.0.0');
  assert.equal(d.ok, true, d.error);
  assert.equal(fs.existsSync(path.join(env.siteRoot, p.id, '1.0.0')), false);

  // 再对一次账：**重新问**（不是静默装回来，也不是"什么都没有"）。
  const r3 = await callSync(site, env);
  assert.equal(r3.pendingConsent.length, 1, '★ 站点还在发它，所以重新问一次');
  assert.equal(r3.pendingConsent[0].existing, false, '这一份是**新取回来的草稿**');
});

// ══════════════════════════════════════════════════════════════════════════
//  §5.3 删除 = 撤回同意
// ══════════════════════════════════════════════════════════════════════════

test('★★ 删掉本机那一份 ⇒ 台账那条一并消失 ⇒ 下一次**重新问**（绝不静默装回来）', async () => {
  // ★ 不这么做的话，用户删掉池里那一份之后，下一次对账会按"摘要与台账相符"
  //   **静默装回来、一个字都不问** —— 那不是"当作从来没有过"，那是"用户想让它
  //   消失，它自己回来了"。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  consentAll(env, r1);
  assert.equal(env.trusted.size, 1, '前置：同意过一份');

  // 用户把它删了（在文件管理器里、或者点了界面上那个按钮）。
  fs.rmSync(path.join(env.siteRoot, p.id, '1.0.0'), { recursive: true, force: true });

  const r2 = await callSync(site, env);
  assert.equal(env.trusted.size, 0, '★ 同意必须作废 —— 只删内容、留着台账就等于静默装回来');
  assert.equal(r2.withdrawn.length, 1, JSON.stringify(r2.withdrawn));
  assert.equal(r2.pendingConsent.length, 1, '★ 而且它这一次要**重新走一遍同意闸**');
  assert.ok(r2.notices.some((n) => /不在了/.test(n)),
    `要说一句为什么又问一次：${JSON.stringify(r2.notices)}`);
  assert.ok(!r2.notices.some((n) => /你删的|用户删除/.test(n)),
    '★ 绝不断言是谁删的 —— 客户端不知道原因，它只知道"不在了"');
});

test('★ 台账里本来就没有这一条 ⇒ 不算"撤回"，也不推一条通知', async () => {
  // 首次安装走的就是这条路（池里没有、台账里也没有）。把"没有台账条目"读成
  // "用户撤回了"的话，每一次首次安装都会多出一句莫名其妙的话。
  const site = makeSite();
  const env = makeEnv();
  site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r = await callSync(site, env);
  assert.deepEqual(r.withdrawn, []);
  assert.deepEqual(env.forgotten, []);
  assert.ok(!r.notices.some((n) => /不在了/.test(n)), JSON.stringify(r.notices));
});

test('★ 只对**本站这一轮报出来的**那些判撤回（别的站点的条目管不着）', async () => {
  const site = makeSite();
  const env = makeEnv();
  const a = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const b = site.add('b', { name: 'b' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  consentAll(env, r1);
  assert.equal(env.trusted.size, 2);

  // b 被站点关掉了，同时 a 的本机那一份被删了。
  site.state.disabled.add(`${b.id}@1.0.0`);
  fs.rmSync(path.join(env.siteRoot, a.id, '1.0.0'), { recursive: true, force: true });
  const r2 = await callSync(site, env);
  assert.deepEqual(r2.withdrawn.map((x) => x.id), [a.id], '只有 a 是"这一轮报出来的"');
  assert.equal(env.trusted.has(`${b.id}@1.0.0`), true,
    '★ 站点不报 b 了，所以这一轮没资格判它 —— 它随时可能再打开');
});

// ══════════════════════════════════════════════════════════════════════════
//  回收、列举
// ══════════════════════════════════════════════════════════════════════════

test('★ 回收一个版本时，包跟着一起走（不留没树的 .splug）', async () => {
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  consentAll(env, r1);
  assert.equal(fs.existsSync(S.pkgPathOf(env.siteRoot, p.id, '1.0.0')), true, '前置');

  site.state.disabled.add(`${p.id}@1.0.0`);
  site.add('b', { id: p.id, name: 'a', version: '1.1.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  const r2 = await callSync(site, env);
  consentAll(env, r2);
  const r3 = await callSync(site, env);
  assert.deepEqual(r3.reclaimed.map((x) => x.version), ['1.0.0'], JSON.stringify(r3.reclaimed));
  assert.equal(fs.existsSync(S.pkgPathOf(env.siteRoot, p.id, '1.0.0')), false,
    '★ 包要一起回收 —— 留下一个没有树的 .splug 就是池里一份谁也看不见的残留');
  assert.equal(fs.existsSync(S.pkgPathOf(env.siteRoot, p.id, '1.1.0')), true);
});

test('★ 列举只认目录：旁边的 <版本>.splug 不是另一份插件', async () => {
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  consentAll(env, r1);
  const out = S.listPooled(env.siteRoot);
  assert.deepEqual(out.map((x) => `${x.id}@${x.version}`), [`${p.id}@1.0.0`]);
  assert.equal(out[0].hasPackage, true);

  // 把包删掉：**不算撤回**（能加载的是树），但必须如实报出来。
  fs.rmSync(S.pkgPathOf(env.siteRoot, p.id, '1.0.0'));
  const out2 = S.listPooled(env.siteRoot);
  assert.equal(out2.length, 1, '树还在 ⇒ 这一份还在');
  assert.equal(out2[0].hasPackage, false, '★ 包不在了要如实说，不能瞒着');
  const r2 = await callSync(site, env);
  assert.equal(r2.kept.length, 1, '★ 包单独不在了**不构成撤回**');
  assert.deepEqual(r2.withdrawn, []);
});

test('★ 站点只发包、不发文件（v0.8 的形状）⇒ 照样装得上', async () => {
  // ★ 加法过渡的另一头：`files` 那条路迟早要删（阶段 6），而这一天客户端必须
  //   已经能只靠包工作 —— 否则"删掉 files"会变成一次断电式的切换。
  const site = makeSite();
  const env = makeEnv();
  site.state.packages = true;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  site.state.hideFiles.add(`${p.id}@1.0.0`);
  const r1 = await callSync(site, env);
  assert.equal(r1.pendingConsent.length, 1, JSON.stringify(r1.failed));
  assert.equal(r1.pendingConsent[0].files.length >= 2, true, '文件清单从包里来');
  consentAll(env, r1);

  // 第二次对账：树在、包在，判据退到**本机那个包**（站点没有 files 可报）。
  const r2 = await callSync(site, env);
  assert.deepEqual(r2.failed, []);
  assert.equal(r2.kept.length, 1, JSON.stringify(r2));
  assert.equal(site.state.pkgCalls, 1, '第二次不该再取一遍整包');
});
