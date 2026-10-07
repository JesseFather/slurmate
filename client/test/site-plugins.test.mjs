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
const SLOT = require('../src/main/plugin-slot.js');
const ulid = require('../src/main/plugins/ulid.js');
// 测试用的包**由仓库里那个打包器现打**，不手搓字节：手搓一份就是在这里又
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
    noPackage: new Set(),      // 这些 (id@版本) 不带 `package`（站点不分发它）
    disabled: new Set(),       // 这些不带 `enabled: true`
    extra: [],                 // 站点多报的（客户端不认识的）
    sessions: [],
    // ── 唯一那条投递方式 ──
    pkgFormat: 2,              // `op_plugins` 里报出去的格式
    pkgByteDelta: 0,           // 报出去的字节数偏离真实值多少
    pkgDigestLie: false,       // `op_plugins` 报出去的内容摘要是假的
    pkgRespDigestLie: false,   // ★ `plugin_package` **响应里**报的那个是假的（只改这一处）
    pkgCorrupt: false,         // `plugin_package` 发出来的字节被改了一位
    pkgTruncate: 0,            // 发出去之前把包截短几个字节（链表与负载对不上）
    pkgExtra: null,            // 往包里**追加**这几条负载 —— 造坏包用（见 pkgOf）
    pkgSign: true,             // 这一份包签不签名
    pkgKey: null,              // 签名钥匙（每造一个站点一把，所以两个站点不同）
    pkgCalls: 0,               // 被打了几次（用来验"一条 RPC 取完"）
    fileCalls: 0,              // ★ 恒为 0：`plugin_file` 已经删了，见下面那个出口
  };
  const byKey = new Map();

  /** 造一个插件目录。`files` 是相对路径 → 内容。 */
  function add(dirName, over = {}, files = {}) {
    const dir = path.join(src, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const mf = { id: ulid.mint(), name: 'plug', displayName: '插件', version: '1.0.0',
      // `concurrent` 是**必填**的（见 plugins/index.js），所以夹具要给它一格 ——
      // 不然每一条端到端用例都会红在"清单不合法"上。
      contributes: { concurrent: false }, ...over };
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
    // ★ `pkgExtra` 是**造坏包**用的：负载本来是磁盘上那一棵，这里往后再接几条
    //   —— 那些形状在磁盘上摆不出来（穿越路径、只差大小写的两条、一条超限的……
    //   `readPluginFiles` 会先跳过它们），而在**包里**它们表达得出来，正是解析器
    //   或读方该拒的东西。
    //   ★ v0.13 阶段 4 起它们必须**落在客户端侧**（`client/…`）：追加一条站点侧
    //     路径的话，它根本不会被装进发出去的那个包，于是那条用例会**静默失效**
    //     —— 绿着，而它什么也没测。
    const all = declared(key2).map((f) => ({
      path: f.path,
      data: fs.readFileSync(path.join(e.dir, ...f.path.split('/'))),
      sha256: f.sha256,
    })).concat(state.pkgExtra || []);
    const k = key();
    // ★★ v0.13：签的是**四元组**（A.3）—— `{id, 版本, 站点侧摘要, 客户端侧摘要}`，
    //    两个摘要由**打包器那份实现**现算（与真守护进程走的是同一个函数）。
    //    ★ 四元组算的是**整棵树**（那是插件的身份），而**发出去的只含客户端侧**
    //      —— 与真守护进程逐字同构（`slurmate-sessiond` 的 `plugin_rebuild`：
    //      对账对整棵树，打包只打客户端侧）。假站点要是继续发整包，这一整套用例
    //      测的就是一个**已经不存在的**分发形状。
    const sd = PACKER.sideDigests(all);
    const quad = { id: e.mf.id, version: e.mf.version,
                   digestSite: sd.site, digestClient: sd.client };
    // ★ 不签名的那一档：§5.4 要判"钉过之后收到一份没有签名的构件"。
    const sigBlock = state.pkgSign
      ? PACKER.buildSigBlock(Object.assign({
        alg: 1, pubkey: k.pub,
        sig: crypto.sign(null, PACKER.signedMessage(quad), k.priv),
      }, quad))
      : Buffer.alloc(0);
    const send = all.filter((f) => PACKER.isClientSidePath(f.path));
    const buf = PACKER.buildPackage(send, sigBlock);
    // ★ `digest` 是 `op_plugins` 报的那个 —— 发出去那一份的摘要（客户端侧），
    //   不是整棵树的。客户端会自己从字节重算这一个再与它比。
    const out = { buf, digest: sd.client, fingerprint: state.pkgSign ? k.fingerprint : null };
    pkgCache.set(key2, out);
    return out;
  }

  /**
   * 链路上真正发出去的那串字节。
   *
   * ★ 与 `pkgOf` 分开是有意的：`op_plugins` 报的 `bytes` 与 `plugin_package` 发的
   *   字节**必须描述同一份东西**（真守护进程那边由"启动快照"保证）。`pkgTruncate`
   *   同时改这两处，所以客户端会一路走到**解析器**才失败 —— 那正是这条用例要测的
   *   那一层；只改一处的话，它会在"字节数与自述对不上"那一条上就停住。
   */
  function wireBuf(key2) {
    const p = pkgOf(key2);
    return state.pkgTruncate ? p.buf.subarray(0, p.buf.length - state.pkgTruncate) : p.buf;
  }

  /**
   * 把这一份**摆进池子** —— 造"上次已经装过"用。
   *
   * ★ 摆的是**已提交的槽位**：一棵树 + 一张记录表（v0.13 的形状）。记录表由
   *   **生产代码**从那个包算出来（`SLOT.recordFromPackage`），不在这里另写一份 ——
   *   手写一张就是在这里又实现了一遍记录表格式，而它与真格式分家的那天，用例反而
   *   会说"一切正常"。
   */
  function poolPut(env, p) {
    const buf = pkgOf(`${p.id}@${p.version}`).buf;
    const parsed = PP.parsePackage(buf);
    assert.equal(parsed.ok, true, `夹具自己打的包要能解析：${parsed.why}`);
    return putSlot(env, p.id, p.version, p.dir, parsed, buf);
  }

  async function rpc(req) {
    if (req.op === 'plugins') {
      const plugins = [...byKey.keys()].map((key2) => {
        const e = byKey.get(key2);
        const out = {
          id: e.mf.id, name: e.mf.name, version: e.mf.version, title: e.mf.displayName,
          enabled: !state.disabled.has(key2), can_submit: true, defaults: { cpus: 2, mem: '8G' },
        };
        if (!state.noPackage.has(key2)) {
          const p = pkgOf(key2);
          out.package = {
            format: state.pkgFormat,
            bytes: wireBuf(key2).length + state.pkgByteDelta,
            digest: state.pkgDigestLie ? 'f'.repeat(64) : p.digest,
          };
        }
        return out;
      });
      for (const x of state.extra) plugins.push(x);
      const data = { plugins, enabled: plugins.filter((p) => p.enabled).map((p) => p.name) };
      // ★ 能力信号是**协议事实**：顶层有没有 `limits`。老守护进程整个字段都没有。
      if (state.limits) {
        data.limits = { file_bytes: 256 * 1024, total_bytes: 1 << 20, max_files: 256,
                        package_bytes: 4 << 20 };
      }
      return { ok: true, data };
    }
    if (req.op === 'list') return { ok: true, data: { sessions: state.sessions } };
    if (req.op === 'plugin_package') {
      state.pkgCalls += 1;
      if (state.rateBurst > 0) {
        state.rateBurst -= 1;
        return { ok: false, code: 7, error: { kind: 'rate_limited', detail: '打满桶' } };
      }
      const key2 = `${req.id}@${req.version}`;
      if (!byKey.has(key2)) {
        return { ok: false, code: 3, error: { kind: 'plugin_unknown', detail: key2 } };
      }
      const p = pkgOf(key2);
      let buf = wireBuf(key2);
      if (state.pkgCorrupt) {
        // 改**负载里**的一个字节 ⇒ 逐份校验必须抓到（改的是字节，不是那张表）。
        buf = Buffer.from(buf);
        buf[buf.length - 1] ^= 0xff;
      }
      return { ok: true,
               data: { format: 2, bytes: buf.length,
                       digest: state.pkgRespDigestLie ? 'e'.repeat(64) : p.digest,
                       data: buf.toString('base64') } };
    }
    // ★ `plugin_file` **不在这里** —— v0.7 把它从协议里删掉了，真守护进程回的是
    //   `2 unknown_op`（走下面那一行）。假站点也必须这样：一个"只在这个假站点里
    //   存在"的 op 会让用例测着一条真机上没有的路。
    //   `state.fileCalls` 留着是**故意的**：它现在是"客户端有没有偷偷退回逐份取"
    //   的证据，而它只可能是 0。
    return { ok: false, code: 2, error: { kind: 'unknown_op', detail: req.op } };
  }

  return { src, state, add, declared, rpc, byKey, pkgOf, poolPut, wireBuf };
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
    keepSites: over.keepSites,
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
      stagedDir: p.stagedDir, siteRoot: env.siteRoot,
      // ★ 记录表草稿：只在内存里活到这一刻，而 acceptStaged 里那一次写就是**提交**。
      //   `existing` 那一份本来就已经提交过了，所以它没有草稿。
      record: p.record || null,
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

const readSnapshotOf = (siteRoot) => JSON.parse(
  fs.readFileSync(path.join(siteRoot, S.SNAPSHOT_NAME), 'utf8'));

// ── 池里一个槽位的三个地址，以及"把一份摆进去" ───────────────────────────────
//
// ★ 全部走**生产代码**（`plugin-slot.js`）算路径：用例自己拼一遍的话，它们会在
//   命名规则变的那天继续绿着，而绿的是另一个形状。
const poolTree = (env, p, version) => SLOT.treeDirOf(env.siteRoot, p.id, version || p.version);
const poolRecord = (env, p, version) => SLOT.recordPathOf(env.siteRoot, p.id, version || p.version);
const stagedTree = (env, s, p, version) => path.join(s.stagingDir, `${p.id}_${version || p.version}`);
const slotOf = (env, p, version) => S.readSlot(env.siteRoot, p.id, version || p.version);
const recOf = (env, p, version) => slotOf(env, p, version).record;

/**
 * 把一棵树 + 一张记录表摆成**一个已提交的槽位**。
 *
 * `parsed`/`buf` 给的是"记录表从哪个包算出来"；`srcDir` 是树的内容从哪拷。
 * ★ 记录表是**先于树**写的吗？不是 —— 提交点是"最后写记录表"，而这里两步都成功，
 *   所以顺序无关紧要。要造"没提交"的状态，用 `putTreeOnly`。
 */
function putSlot(env, id, version, srcDir, parsed, buf) {
  const dest = SLOT.treeDirOf(env.siteRoot, id, version);
  assert.ok(dest, `夹具的 id 必须是 ULID：${id}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(SLOT.recordPathOf(env.siteRoot, id, version), { force: true });
  fs.cpSync(srcDir, dest, { recursive: true });
  const rec = parsed ? SLOT.recordFromPackage(parsed)
    : SLOT.recordFromPackage(PP.parsePackage(buf));
  const w = SLOT.writeRecordFile(SLOT.recordPathOf(env.siteRoot, id, version), rec);
  assert.equal(w.ok, true, `记录表要写得下去：${w.error}`);
  return dest;
}

/** 只摆一棵树、**不写记录表** —— 造"没提交的安装"（v0.13 才有的那个状态）。 */
function putTreeOnly(env, id, version, srcDir) {
  const dest = SLOT.treeDirOf(env.siteRoot, id, version);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(srcDir, dest, { recursive: true });
  return dest;
}

/** 递归列出目录下所有条目名（判"暂存里有没有容器文件"用）。 */
function allNames(dir) {
  const out = [];
  for (const n of fs.readdirSync(dir)) {
    out.push(n);
    const full = path.join(dir, n);
    if (fs.statSync(full).isDirectory()) out.push(...allNames(full));
  }
  return out;
}

/** 一个已提交槽位的记录表在不在（判断"提交/没提交"用）。 */
const committed = (env, p, version) => fs.existsSync(poolRecord(env, p, version));

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

  // 手工摆一个**已提交的槽位**进站点池（"对账 + 下载"那两步在别的用例里单独测）——
  // 这里要问的只有一件事：**注册表会不会去执行它**。
  //
  // ★ 摆的是 v0.13 的形状（树 + 记录表）：注册表现在要求**两样都在**才认一个槽位
  //   （提交点语义），所以只摆一棵树的话这条用例会红在一个与同意闸无关的地方。
  site.poolPut(env, p);

  const reg = new P.Registry([{ dir: env.siteRoot, source: 'site' }], { allows: () => false });
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

test('★★ 包声明了而负载里没有 ⇒ 根本编不出来（结构性的，不靠一条对照规则）', async () => {
  // ★ v0.6 这条用例走的是"站点报的清单里多一份、而它取不到"，那时客户端得靠
  //   **一条双向比对**把这件事抓住。v0.7 之后它**编不出来**了：容器的长度必须
  //   精确等于 `头 + Σ size`，短一个字节就是 `length` —— 于是"声明了而没送到"
  //   从"一条要记得写的规则"变成了"一个说不出来的形状"。
  //
  //   用例留着，断的是那条**结构性**：把一个合法的包截短一个字节，客户端必须在
  //   **解析**那一步就拒掉，而不是装上一棵缺一份的树。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  site.state.pkgTruncate = 1;                    // 负载末尾少一个字节
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 0, '读不动的包不许走进同意闸');
  assert.equal(r.failed.length, 1, `要报失败：${JSON.stringify(r)}`);
  assert.match(r.failed[0].why, /读不了|长度|length/, `要说清是包读不了：${r.failed[0].why}`);
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false,
    '★ 失败之后站点池里**根本不能有**那个目录 —— 半份比没有更坏');
  assert.equal(fs.existsSync(poolRecord(env, p, '1.0.0')), false,
    '★ 连那个包也不许留下 —— 它是半个容器，解不开');
});

test('★ 本机那一份多出文件来 ⇒ 检出、点名、**重取**（双向比对）', async () => {
  // ★ 只比一个总摘要抓不到"多出来一个文件" —— 这正是 F18 的形态。
  //   而只比"记录表里那几份都在"抓不到"磁盘上多出来的那些"。两个方向都要判。
  //
  // ★ 被比的另一方是**这一份自己的记录表**（它随这一份一起下来、逐字节校过），
  //   不是站点这一轮的自述 —— 拿对面说的去核本机有的，那是让被告当法官。
  //
  // ★★ 检出之后做的是**重取**（拍板 8），不是"报个错就完"：池里那一份已知不可用，
  //    留着它只会让每一次对账都红一遍。清掉、重新取一份核过的 —— 修好了就不报失败。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  // ★ 先走一遍正常的路并同意 —— 于是台账里有这一份，而重取回来的内容与它相符 ⇒
  //   **不会重新问一遍**（用户同意的是内容，不是"盘上那个目录"）。
  const r1 = await callSync(site, env);
  consentAll(env, r1);
  const dest = poolTree(env, p, '1.0.0');
  fs.writeFileSync(path.join(dest, 'extra.js'), '// 记录表里没有这一份\n');

  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 0, '★ 内容没变 ⇒ 不重新问（同意的是内容）');
  assert.equal(r.kept.length, 0, '磁盘上多出来一份就不算"已经有一份"');
  assert.equal(r.failed.length, 0, `自愈成功就不该报失败：${JSON.stringify(r.failed)}`);
  assert.equal(r.added.length, 1, '★ 它要**重新取一份**回来');
  assert.ok(r.notices.some((n) => /extra\.js/.test(n)),
    `要点名多出来的是哪一份、并说清做了什么事：${JSON.stringify(r.notices)}`);
  assert.equal(fs.existsSync(path.join(dest, 'extra.js')), false,
    '★ 取回来的那一份是核过的 —— 多出来的那个文件不许还在');
});

test('★ 本机那一份被改过一个字节 ⇒ 检出、点名，并且**重取一份干净的**', async () => {
  // ★ 这一条判的是**本机**：树与它自己的记录表对不上。
  //   而"站点报的是另一份内容"是**另一件事**，见下面那一条 —— 两句话从前长成
  //   一句，而它们的处置完全不同（一个在本机重取，一个去找管理员）。
  //
  // ★★ 而"检出"这一步之后**不是覆盖**：先把它清掉（撤回提交、再删内容），**再**
  //    走一遍正常的取件那条路。所以池里不会出现"旧树被新树盖住"这种半路状态，
  //    而取不回来的话也不会退回那份动过的树（见下一条用例）。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r0 = await callSync(site, env);
  consentAll(env, r0);
  const dest = poolTree(env, p, '1.0.0');
  const good = fs.readFileSync(path.join(dest, 'client', 'index.js'));
  fs.writeFileSync(path.join(dest, 'client', 'index.js'), 'module.exports = { attach() {} };\n');

  const r = await callSync(site, env);
  assert.equal(r.failed.length, 0, `站点还在发这一份 ⇒ 重取应当成功：${JSON.stringify(r.failed)}`);
  assert.equal(r.added.length, 1, '★ 重取回来的是一个新提交的槽位');
  assert.ok(r.notices.some((n) => /client\/index\.js/.test(n)),
    `要点名是哪一份文件对不上：${JSON.stringify(r.notices)}`);
  assert.ok(!r.notices.some((n) => /站点现在报的不一样/.test(n)),
    `★ 不是"站点报了别的" —— 那件事走另一条判据：${JSON.stringify(r.notices)}`);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'client', 'index.js')), good,
    '★ 池里那一份必须回到**站点上的那一份**，而不是留着改过的那一份');
});

test('★★ 重取**失败**时绝不退回本机那份动过的树 —— 终点是"报不可用"', async () => {
  // ★ 与文件头第三个"不"（下载失败绝不退回到本机池）同源：能改池子的人若能靠
  //   "让重取失败"把客户端留在**他改过的那一份**上，攻击成本就从"改内容"降到
  //   "让下载失败"。
  //
  // ★ 造的是"站点还在发它、而那串字节取回来是坏的"（`pkgCorrupt`）—— 真机上对应
  //   "站点那份被改过"或"链路上有人动过"。★ 而**站点不分发它**是另一回事：那种
  //   情况下我们连池子都不看（见下面那条"只增不减"的用例），树会原样留着。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r0 = await callSync(site, env);
  consentAll(env, r0);
  const dest = poolTree(env, p, '1.0.0');
  fs.writeFileSync(path.join(dest, 'client', 'index.js'), 'module.exports = { attach() {} };\n');
  site.state.pkgCorrupt = true;                        // 站点发的字节取回来是坏的

  const r = await callSync(site, env);
  assert.equal(r.added.length, 0);
  assert.equal(r.kept.length, 0, '★ 一份动过的树绝不许被当成"已经有一份"');
  assert.equal(fs.existsSync(dest), false, '★ 那份动过的树必须不在了');
  assert.equal(fs.existsSync(poolRecord(env, p, '1.0.0')), false, '记录表一起走');
  assert.equal(r.failed.length, 1, JSON.stringify(r));
  assert.ok(r.notices.some((n) => /不可用/.test(n)),
    `要说清它是先被判成不可用、才去重取的：${JSON.stringify(r.notices)}`);
});

test('★★ 站点**不分发**一个它还在报的插件 ⇒ 本机那一份原样留着（"只增不减"）', async () => {
  // ★ 这一格是"一个 id 只增不减"那条规则在**新引入的路径**上的落点：站点因为自己
  //   那边对不过账而不分发它（v0.13 阶段 1 新有的状态）时，客户端**什么都不做** ——
  //   不删、也不去猜"是不是该清掉本机那一份"。
  //   ★ 理由是流量：重新分发比在盘上多留一份贵，而站点随时可能恢复。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r0 = await callSync(site, env);
  consentAll(env, r0);
  const before = fs.readFileSync(path.join(poolTree(env, p, '1.0.0'), 'client', 'index.js'));

  site.state.noPackage.add(`${p.id}@1.0.0`);           // 站点这一轮不分发它了
  const r = await callSync(site, env);
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), true, '★ 树一个字节都不动');
  assert.deepEqual(fs.readFileSync(path.join(poolTree(env, p, '1.0.0'), 'client', 'index.js')),
    before);
  assert.equal(fs.existsSync(poolRecord(env, p, '1.0.0')), true, '记录表也留着');
  assert.equal(r.reclaimed.length, 0, '★ 更没有被"回收" —— 它还在快照表的 wants 里');
  assert.equal(r.failed.length, 0, '站点没说要发它 ⇒ 不是失败');
  assert.deepEqual(r.withdrawn, [], '★ 也不是"本机那一份不在了 ⇒ 同意作废"');

  // ── 而站点**恢复**分发同一个版本 ⇒ 一个字节都不用重新下载 ──
  site.state.noPackage.delete(`${p.id}@1.0.0`);
  const r2 = await callSync(site, env);
  assert.equal(site.state.pkgCalls, 1, '★ 从头到尾只取过一次包 —— 恢复分发是零流量');
  assert.equal(r2.kept.length, 1, '本机那一份直接复用');
  assert.equal(r2.pendingConsent.length, 0, '也没重新问一遍');
});

test('★★ 有**活会话**正用着那一份时，一个字节都不动它', async () => {
  // ★ 与 v0.12 阶段 6 那条「活会话用过的落点一个不碰」同源：换了会把正在跑的
  //   会话脚下的代码换掉 —— 那是"修好了一个坏东西、顺手弄坏了另一个"。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const dest = site.poolPut(env, p);
  fs.writeFileSync(path.join(dest, 'client', 'index.js'), 'module.exports = { attach() {} };\n');
  const tampered = fs.readFileSync(path.join(dest, 'client', 'index.js'));

  const r = await callSync(site, env, { protectedVersions: [`${p.id}@1.0.0`] });
  assert.equal(fs.existsSync(dest), true, '★ 树一个字都不动');
  assert.deepEqual(fs.readFileSync(path.join(dest, 'client', 'index.js')), tampered);
  assert.equal(r.failed.length, 1, JSON.stringify(r));
  assert.match(r.failed[0].why, /活着的会话/, r.failed[0].why);
});

test('★★ 两个站点报同一个 (id, 版本) 而内容不同 ⇒ 明确失败，且点名这个槽位是**谁**放进来的', async () => {
  // ★★ 这一格从 v0.7 起就**空着**：v0.6 的判据是"站点这一轮报的清单"（`p.files`），
  //    那条路删掉之后它换成了**本机那个包**，于是"对面这次说的是不是另一份内容"
  //    再没有任何东西在看 —— 两个站点报同一个 `(id, 版本)` 而内容不同时，后一个会被
  //    **静默收下**（它的 `wants` 还照样记在那个槽位上），一个字节都不报。
  //
  //    判据回到"对面这一轮说的"：`package.digest` 与池里那个 `.splug` 解析出来的
  //    是**同一个函数**算的（§3.4 的内容摘要），可以直接比。
  const A = makeSite();
  const B = makeSite();
  const v1 = A.add('a1', { name: 'x', version: '1.0.0' },
    { 'client/index.js': 'module.exports = { who: "A" };\n' });
  B.add('b1', { id: v1.id, name: 'x', version: '1.0.0' },
    { 'client/index.js': 'module.exports = { who: "B" };\n' });
  const env = makeEnv();

  // A 先把它装进来，并让记录里留下"是 A 要的"（`wants` 在**下一次**对账里写）
  let r = await callSync(A, env, { siteKey: 'aaaa', siteLabel: 'A 站' });
  consentAll(env, r);
  r = await callSync(A, env, { siteKey: 'aaaa', siteLabel: 'A 站' });
  assert.equal(r.kept.length, 1, `A 那一份应当已在池里：${JSON.stringify(r.failed)}`);
  assert.equal(readSnapshotOf(env.siteRoot).sites.aaaa.wants[v1.id], '1.0.0',
    '（前提）记录里说 A 要这一版 —— 下面那句点名靠的就是它');

  const dest = path.join(poolTree(env, v1, '1.0.0'), 'client', 'index.js');
  const before = fs.readFileSync(dest);
  r = await callSync(B, env, { siteKey: 'bbbb', siteLabel: 'B 站' });
  assert.deepEqual(r.kept, [], '★ 绝不能当成"已经在池里、跳过"收下');
  assert.equal(r.failed.length, 1, `B 这一份必须失败：${JSON.stringify(r)}`);
  assert.match(r.failed[0].why, /站点现在报的不一样/, r.failed[0].why);
  assert.match(r.failed[0].why, /A 站/,
    `★★ 要点名**先来的那个站点** —— 那是管理员接着要问的第一个问题：${r.failed[0].why}`);
  assert.deepEqual(fs.readFileSync(dest), before, '池里那一份**一个字节都不能变**');
  // 而 B 的 `wants` **不许**记上这一版：它没拿到任何东西。
  assert.notEqual(((readSnapshotOf(env.siteRoot).sites.bbbb || {}).wants || {})[v1.id], '1.0.0',
    '★ B 没拿到这一份 ⇒ 引用表里也不该有它（否则回收会以为有人在要）');
});

test('★ 写下去之后再从磁盘读回来验 —— 不能拿手里的 Buffer 当证据', async () => {
  // `writeFileSync` 在磁盘满时会留下部分文件然后抛错。核对手里那些 Buffer 等于把
  // "校验我收到的"当成"校验我写下的" —— 同一类谎话的经典形态。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' },
    { 'client/index.js': 'module.exports = {};\n', 'job/start.sh': '#!/bin/sh\necho hi\n' });

  // ★ v0.6 这里拦的是 `fetchFiles` 的 `writeFileSync`；v0.7 铺树的是
  //   `plugin-package.js` 的 `unpackTo`，而它写的**还是** `fs.writeFileSync` ——
  //   所以这条用例一个字没改，只是它现在拦的是另一条路的那一次写。
  //   （写一半这件事与"哪条路把字节铺下来"无关，它测的是"核的是我写下的"。）
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function patched(file, data, opts) {
    const s = String(file);
    // ★ v0.13 阶段 4 起站点侧**根本不下发**（判据①：用户机器上没有 `job/`），所以
    //   "半份文件"这件事只能在**客户端侧**的那几份上造 —— 从前这里拦的是
    //   `job/start.sh`，而那一份现在连暂存都到不了，patch 会**静默不生效**，
    //   于是这条用例变成一条永远绿的用例。
    if (s.startsWith(env.stagingRoot) && s.endsWith('client' + path.sep + 'index.js')) {
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
  assert.match(r.failed[0].why, /index\.js/, `要点名是哪一份：${r.failed[0].why}`);
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false,
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
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false,
    '★ 语法错的树一个字节都不该进站点池 —— 进去之后按"站点不主动删"就只能让它躺着');
});

test('★ 一条"永远通过"的对账比没有对账更糟：坏的必须真的红', async () => {
  // 反向自测（这个项目里 `check-sanitized.sh --selftest` 与 `install-base.sh` 的
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
  // ★ v0.13 阶段 4：暂存里**只有客户端侧** —— 站点的树上有 `job/start.sh`，而
  //   客户端一个字节都不收（判据①）。所以这里比的是客户端侧那几份，而"站点侧
  //   那一份**不在**暂存里"本身就是下面那条断言。
  for (const rel of ['client/index.js', 'plugin.json']) {
    assert.deepEqual(
      fs.readFileSync(path.join(staged, ...rel.split('/'))),
      fs.readFileSync(path.join(p.dir, ...rel.split('/'))),
      `${rel} 要逐字节相同`);
  }
  assert.equal(fs.existsSync(path.join(staged, 'job')), false,
    '★★ 站点侧那一份不该出现在暂存里（它就是判据①要挡的东西）');
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

  // 端到端：站点发的**包里带一条穿越路径** ⇒ **整份**拒绝（不是"跳过那一份"）
  //
  // ★ v0.6 它走的是"站点在那份清单里多报一条穿越路径"（客户端判 `checkDeclared`）。
  //   v0.7 之后清单没有了，而这条形状**在包里仍然表达得出来** —— 于是判它的
  //   变成了**解析器**（§3.3 是一条拒绝规则，不是"遍历时跳过"）。用例的落脚点
  //   从"客户端的过滤器写对了"变成"这个形状根本进不来"。
  const site = makeSite();
  const env = makeEnv();
  const pl = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  // ★ v0.13 阶段 4 起它必须**落在客户端侧**（`client/…`）：站点发给客户端的包里
  //   只有客户端侧，追加一条顶层路径的话这条坏包根本装不进包，用例会静默失效。
  //   ★ 而 `client/../escape.js` 仍然是一条穿越路径（判据是**路径里的 `..` 段**，
  //     不是规范化之后的结果），所以它测的还是原来那件事。
  site.state.pkgExtra = [
    { path: 'client/../escape.js', data: Buffer.from('x'), sha256: sha256hex(Buffer.from('x')) },
  ];
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 0, '说不清的包不许走进同意闸');
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].why, /\.\./, `要说清哪一条不对：${r.failed[0].why}`);
  assert.equal(fs.existsSync(poolTree(env, pl, '1.0.0')), false,
    '★ 一个说不清的包本身就是"这份东西不能信"');
  assert.equal(fs.existsSync(path.join(env.siteRoot, 'escape.js')), false, '更不能写到池外面去');
  assert.equal(fs.existsSync(path.join(env.stagingRoot, '..', 'escape.js')), false);
});

test('★ 两份只差大小写的声明 ⇒ 拒绝整个插件', async () => {
  // macOS / Windows 的磁盘不区分大小写：两份会互相覆盖，而摘要是**写入之后的磁盘
  // 上**算的 —— 于是用户"同意"的是一棵与站点那棵不同的树。
  const site = makeSite();
  const env = makeEnv();
  const pl = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  // 包里那两条记录只差大小写 —— 磁盘上摆不出来（同一个目录里放不下两个这样的
  // 文件名，在 Linux 上也摆不出来"会互相覆盖"这件事），而在**包里**它表达得出来，
  // 所以判它的地方是客户端读包那一步（`checkDeclared` 的折叠检查）。
  site.state.pkgExtra = [
    { path: 'client/INDEX.js', data: Buffer.from('b'), sha256: sha256hex(Buffer.from('b')) },
  ];
  const r = await callSync(site, env);
  assert.equal(r.failed.length, 1, `要拒：${JSON.stringify(r)}`);
  assert.match(r.failed[0].why, /大小写/, `要说清原因：${r.failed[0].why}`);
  assert.equal(fs.existsSync(poolTree(env, pl, '1.0.0')), false);
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
  assert.equal(fs.existsSync(poolTree(env, v1, '1.0.0')), true, '前置：1.0.0 在');

  // 站点升到 1.1.0（同一个 id，新版本目录）
  site.state.disabled.add(`${v1.id}@1.0.0`);
  site.add('v2', { id: v1.id, name: 'x', version: '1.1.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 1, '新版本是**另一份构件** ⇒ 要重新同意一次');
  consentAll(env, r);
  assert.equal(fs.existsSync(poolTree(env, v1, '1.1.0')), true, '新版要装上');

  // ★ 回收发生在**下一次对账**：指针是在对账第 5 步移的，而同意在它之后。
  //   这一点要如实写在测试里 —— 它不是bug，是"同意"与"对账"本来就是两个动作，
  //   而用户随时可以点「重新同步」把收尾那一步提前。
  r = await callSync(site, env);
  assert.equal(fs.existsSync(poolTree(env, v1, '1.0.0')), false,
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

  assert.equal(fs.existsSync(poolTree(env, v1, '1.0.0')), true, '两份并存');
  assert.equal(fs.existsSync(poolTree(env, v1, '1.1.0')), true);

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
  assert.equal(fs.existsSync(poolTree(env, v1, '1.2.0')), true, 'A 的新版在');
  assert.equal(fs.existsSync(poolTree(env, v1, '1.0.0')), false,
    'A 换走了那一版 ⇒ 归零 ⇒ 回收');
  assert.equal(fs.existsSync(poolTree(env, v1, '1.1.0')), true,
    '★ B 还要 1.1.0 ⇒ 留着。A 的升级不该影响 B');

  const rec = readSnapshotOf(env.siteRoot);
  assert.equal(rec.sites.aaaa.wants[v1.id], '1.2.0');
  assert.equal(rec.sites.bbbb.wants[v1.id], '1.1.0');
  assert.ok(v2 && v3, '（占位：上面两个目录确实造出来了）');
});

test('★★ 连接没了的站点条目要跟着删 —— 否则它的 `wants` 会把那一版永久钉住', async () => {
  // 站点键是 `sha256(user@host:port)`：**改一次主机名/端口/用户名就是另一个键**。
  // 旧条目留着的后果很具体：它的 `wants` 继续为那些版本计引用 ⇒ 那一版**永远不会
  // 被回收**，而界面上永远显示「被 <旧标签> 要」。
  const site = makeSite();
  const env = makeEnv();
  const a = site.add('v1', { name: 'a', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  const b = site.add('v2', { name: 'b', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });

  // A 站点要 a；B 站点要 b。
  site.state.disabled.add(`${b.id}@1.0.0`);
  let r = await callSync(site, env, { siteKey: 'aaaa', siteLabel: 'A' });
  consentAll(env, r);
  site.state.disabled.clear();
  site.state.disabled.add(`${a.id}@1.0.0`);
  r = await callSync(site, env, { siteKey: 'bbbb', siteLabel: 'B' });
  consentAll(env, r);
  assert.equal(fs.existsSync(poolTree(env, a, '1.0.0')), true);
  assert.equal(fs.existsSync(poolTree(env, b, '1.0.0')), true);
  assert.deepEqual(Object.keys(readSnapshotOf(env.siteRoot).sites).sort(), ['aaaa', 'bbbb']);

  // ★ 省略 `keepSites` = **不知道** ⇒ 一条都不删（与"读不到记录就不回收"同一条纪律）。
  r = await callSync(site, env, { siteKey: 'bbbb', siteLabel: 'B' });
  assert.deepEqual(r.forgotSites, [], '不知道就不删');
  assert.deepEqual(Object.keys(readSnapshotOf(env.siteRoot).sites).sort(), ['aaaa', 'bbbb']);

  // A 那条连接被删掉（或者主机名改了）⇒ 现在只有 bbbb。
  //   `aaaa` 那一份 `wants` 一没，a 就只有"没有任何站点要它"了 ⇒ 同一个对账里回收。
  r = await callSync(site, env, { siteKey: 'bbbb', siteLabel: 'B', keepSites: ['bbbb'] });
  assert.deepEqual(r.forgotSites, ['aaaa']);
  assert.deepEqual(Object.keys(readSnapshotOf(env.siteRoot).sites), ['bbbb']);
  assert.equal(fs.existsSync(poolTree(env, a, '1.0.0')), false,
    '★ 回收发生在**同一次**对账里 —— 站点表在第 5 步删、回收在第 6 步');
  assert.equal(fs.existsSync(poolTree(env, b, '1.0.0')), true,
    'B 还活着，它要的那一份一个字都不该动');
});

test('★★ 站点**关掉**或**不再报**一个插件 ⇒ 留着不删（决定 3）', async () => {
  const site = makeSite();
  const env = makeEnv();
  const v1 = site.add('v1', { name: 'x', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  let r = await callSync(site, env);
  consentAll(env, r);
  assert.equal(fs.existsSync(poolTree(env, v1, '1.0.0')), true);

  // 管理员把它关掉
  site.state.disabled.add(`${v1.id}@1.0.0`);
  r = await callSync(site, env);
  assert.equal(fs.existsSync(poolTree(env, v1, '1.0.0')), true,
    '★ "站点不报它"不构成删除理由 —— 它随时可能再打开');

  // 管理员把它从 plugins/ 里整个移除
  site.state.disabled.clear();
  site.byKey.delete(`${v1.id}@1.0.0`);
  r = await callSync(site, env);
  assert.equal(fs.existsSync(poolTree(env, v1, '1.0.0')), true,
    '★ 整个移除也一样 —— 删除的唯一理由是"没有任何站点要它、也没有活会话用它"');
  const rec = readSnapshotOf(env.siteRoot);
  assert.ok(rec.sites.aaaaaaaaaaaaaaaa.distributes.includes(v1.id),
    '`distributes` 只增不减：它要把"你以前从 X 站装过它"这件事说出来');
});

/**
 * 造一个**真的会回收**的现场：站点升到 1.1.0 ⇒ 1.0.0 的引用归零。
 *
 * ★★ 从前这两条用的是"站点不再报它"（`disabled`）—— 而那条路走的是
 *    「**决定 3：不再报 ⇒ 留着不删**」：`wants` 根本没变，所以**什么都不保护
 *    也会绿**。一条永远绿的用例比没有更糟，它会让下一个人以为这一格被守住了。
 *    所以要造的是"引用真的归零"那一种，判据才有承重。
 *
 * @param {string} sessionState 那一条会话的 `state`（`undefined` = 老守护进程没报这一格）
 */
async function upgradeWithSessions(sessionState) {
  const site = makeSite();
  const env = makeEnv();
  const v1 = site.add('v1', { name: 'x', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  let r = await callSync(site, env);
  consentAll(env, r);

  // ★ `service_plugin` 要用**这个 fake 自己铸的那个 id**（`v1.id`），
  //   不是 code-server 那一个 —— 写死的话这一条测的就成了别的插件。
  const row = { session_id: 's1', service_plugin: `${v1.id}@1.0.0` };
  if (sessionState !== undefined) row.state = sessionState;
  site.state.sessions = [row];
  site.state.disabled.add(`${v1.id}@1.0.0`);
  site.add('v2', { id: v1.id, name: 'x', version: '1.1.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  r = await callSync(site, env);
  consentAll(env, r);
  r = await callSync(site, env);

  // ★ 前提要**真的成立**才轮到那条判据：新版装上了 ⇒ 这一轮确实走到了回收那一步。
  assert.equal(fs.existsSync(poolTree(env, v1, '1.1.0')), true,
    `前提：新版真的装上了（否则这一条可能只是"没走到回收"）：${JSON.stringify(r)}`);
  return { site, env, v1, r };
}

test('★ 活会话引用着它 ⇒ 不回收', async () => {
  // 客户端重启之后会 tryReattach 接回旧会话，而那些会话的 service_plugin
  // **只有守护进程知道** —— 所以这一步必须去问 `op:list`，不能只看本地那一条。
  const { env, v1, r } = await upgradeWithSessions('enrolled');
  assert.equal(fs.existsSync(poolTree(env, v1, '1.0.0')), true,
    '会话还在用它 ⇒ 不能删');
  assert.deepEqual(r.reclaimed, [], '而且要真的没删');
});

test('★★ **已经结束**的会话不该把那一个版本钉住', async () => {
  // `op:'list'` 回的是**最近 50 行、不分状态**（守护进程那边就是 `rows[-50:]`），
  // 所以一个早就 `released` 的会话，它那一行里的 `service_plugin` 从前照样被当成
  // "还有人要它" ⇒ 回收那一档**永远跳过那一版**。池里于是慢慢攒下"没有任何站点要、
  // 也没有任何会话在跑"的版本 —— 而界面上那句「没有任何站点要它（下次同步时会被
  // 回收）」对它们**是假的**。（账本 S21。）
  //
  // ★ 这一条与上一条**成对**才承重：上一条钉"活的要护住"，这一条钉"死的不要护"。
  //   少任何一条，另一条都能被一个走极端的实现骗过去。
  const { env, v1, r } = await upgradeWithSessions('released');
  assert.equal(fs.existsSync(poolTree(env, v1, '1.0.0')), false,
    '★★ 结束了的会话不算"还在用" ⇒ 该回收的那一版要真的回收');
  assert.equal(r.reclaimed.length, 1, `要真的回收了一个：${JSON.stringify(r.reclaimed)}`);
});

test('★★ **不认识**的会话状态要护着（判错的方向是回收掉用户在用的东西）', async () => {
  // ★ 判据用"排除已知终态"而不是"只收活状态"，差别就在这一条：守护进程哪天多出
  //   一个客户端还不认识的 `state`，排除法把它**护住**，白名单法把它当成"不算数"。
  //   而后者错的方向是**回收掉用户正在用的那一版** —— 与 F23 那条纪律（不知道谁在
  //   引用的时候，唯一安全的动作是不删）反着来。
  const { env, v1, r } = await upgradeWithSessions('some_future_state');
  assert.equal(fs.existsSync(poolTree(env, v1, '1.0.0')), true,
    '★ 不认识的状态 ⇒ 护着，不回收');
  assert.deepEqual(r.reclaimed, []);
});

// ── 记录与回收的次序 ────────────────────────────────────────────────────────

test('★★ 记录丢了或坏了 ⇒ 一个字节都不删，只报一条', async () => {
  // 记录丢了 ⇒ 池里每个版本的引用数都算 0 ⇒ 按规则会把整个池清空。那是"因为读不到
  // 一张表而删掉用户的文件"。与安装器织作业脚本时那条「目录里有东西、却没有部署
  // 标记 ⇒ 中止，不是删」是同一个先例。
  const site = makeSite();
  const env = makeEnv();
  const v1 = site.add('v1', { name: 'x', version: '1.0.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  let r = await callSync(site, env);
  consentAll(env, r);
  const dest = poolTree(env, v1, '1.0.0');
  assert.equal(fs.existsSync(dest), true);

  // 站点不再报它 + 记录被写坏 —— 两个条件同时成立才有可能误删
  site.byKey.delete(`${v1.id}@1.0.0`);
  fs.writeFileSync(path.join(env.siteRoot, S.SNAPSHOT_NAME), '{ 这不是 JSON');
  r = await callSync(site, env);
  assert.equal(fs.existsSync(dest), true, '★ 读不到引用表时，唯一安全的动作是什么都不删');
  assert.ok(r.notices.some((n) => /不会回收/.test(n)),
    `而且要**说出来**（否则用户只会发现池子越来越大）：${JSON.stringify(r.notices)}`);

  // 记录**不存在**而池子不空 —— 同样是最危险的那一刻，同样不删
  fs.unlinkSync(path.join(env.siteRoot, S.SNAPSHOT_NAME));
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
  const old = poolTree(env, v1, '1.0.0');
  assert.equal(fs.existsSync(old), true);

  // 站点升到 1.1.0（正常会回收 1.0.0），但这一次记录写不下去
  site.state.disabled.add(`${v1.id}@1.0.0`);
  site.add('v2', { id: v1.id, name: 'x', version: '1.1.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  const realRename = fs.renameSync;
  fs.renameSync = function patched(a, b) {
    if (String(b).endsWith(S.SNAPSHOT_NAME)) throw new Error('磁盘满了');
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
    if (String(b).endsWith(S.SNAPSHOT_NAME)) order.push('写记录');
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

test('★ 列举的判据是"已提交的槽位"：跳过快照表、记录表、没提交的树、以及不是槽位的东西', () => {
  // ★ 池里只该有**一种**形状（`<id>_<版本>/` + `<id>_<版本>.json`），而列举是它的
  //   读者。三种东西各自要被跳过，理由不同：
  //     · `.sites.json` 是**快照表**（整个池的账），点开头 ⇒ 进不来；
  //     · 记录表是一个**文件**，不是槽位；
  //     · 一棵**没有记录表**的树是"没提交的安装"，它**不存在**（提交点语义）。
  const root = tmp('slurmate-list-');
  const id = ulid.mint();
  const other = ulid.mint();
  const rec = { schema: SLOT.RECORD_SCHEMA, format: 2, envelope: null,
                files: [{ path: 'plugin.json', size: 2, sha256: 'a'.repeat(64) }] };
  fs.mkdirSync(path.join(root, `${id}_1.0.0`), { recursive: true });     // 没提交
  fs.mkdirSync(path.join(root, `${other}_1.0.0`), { recursive: true });   // 已提交
  fs.mkdirSync(path.join(root, 'ID1'), { recursive: true });              // 不是槽位
  fs.writeFileSync(path.join(root, S.SNAPSHOT_NAME), '{}');
  SLOT.writeRecordFile(path.join(root, `${other}_1.0.0.json`), rec);
  assert.deepEqual(S.listPooled(root).map((x) => `${x.id}@${x.version}`), [`${other}@1.0.0`],
    '只有"树 + 记录表读得动"的才算一个槽位');

  // ★ 而"记录表在、读不动"是**第三**种东西：它也是"没提交"（写坏了 / 被人改过），
  //   所以列举看不见它、清扫要收掉它。★ 判据**必须是同一个**（`readRecordFile`）——
  //   两处分家的那天会出现一个"注册表加载得了、而列举与回收都看不见"的槽位。
  SLOT.writeRecordFile(path.join(root, `${id}_1.0.0.json`), rec);
  fs.writeFileSync(path.join(root, `${id}_1.0.0.json`), '{ 这不是 JSON');
  assert.deepEqual(S.listPooled(root).map((x) => `${x.id}@${x.version}`), [`${other}@1.0.0`],
    '读不动的记录表 ⇒ 不算一个槽位');

  // ★ 而"不是槽位"与"没提交"要分开：前者**不报也不删**，后两者**要收掉**。
  const swept = S.sweepPool(root);
  assert.deepEqual(swept.removed.sort(), [`${id}_1.0.0`, `${id}_1.0.0.json`].sort(),
    '没提交的树、以及读不动的记录表，都要收掉');
  assert.deepEqual(swept.strays, ['ID1'], '不是槽位的东西一个字节都不动');
  assert.equal(fs.existsSync(path.join(root, `${other}_1.0.0`)), true, '已提交的照旧');
  assert.equal(fs.existsSync(path.join(root, `${other}_1.0.0.json`)), true);
});

// ── 上限 ────────────────────────────────────────────────────────────────────

test('★ 服务端报的上限只能**收紧**客户端那份硬上限', () => {
  const hard = S.HARD_LIMITS;
  assert.equal(S.effectiveLimits({ file_bytes: 10 }).file_bytes, 10, '更严的要采纳');
  assert.equal(S.effectiveLimits({ file_bytes: hard.file_bytes * 100 }).file_bytes,
    hard.file_bytes, '★ 更松的**不能**放宽 —— limits 是被审计方的自述');
  assert.equal(S.effectiveLimits(undefined).file_bytes, hard.file_bytes, '缺席 = 用自己那份');
});

test('★ 包里的某一份超过单文件上限 ⇒ 明确拒绝，不是截断', async () => {
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  // ★ v0.6 时这条塞的是**清单**里的一行（守护进程在 `plugin_file` 那一条上也拦）。
  //   逐份取删掉之后，这几个负载上限**唯一的执行点**就是客户端读包那一步
  //   （`checkDeclared`）—— 所以造它就得造在**包里**，否则测的是一个没人走的入口。
  const big = Buffer.alloc(S.HARD_LIMITS.file_bytes + 1, 0x78);
  // ★ 路径必须在**客户端侧**（`client/…`）：阶段 4 起站点发出去的包里只有客户端侧，
  //   塞一条顶层路径的话这一份根本不在包里，用例会绿着什么也没测。
  site.state.pkgExtra = [{ path: 'client/big.bin', data: big, sha256: sha256hex(big) }];
  const r = await callSync(site, env);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].why, /超过/, `要说清是超限，而不是一句"失败了"：${r.failed[0].why}`);
  assert.match(r.failed[0].why, new RegExp(String(S.HARD_LIMITS.file_bytes)),
    '★ 运维要照着这句话调，所以要说清上限是多少');
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false,
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
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false,
    '作废的对账不许往站点池里写东西');
  assert.deepEqual(r.pendingConsent, [], '也不许留下待同意的树');
  assert.deepEqual(r.failed, [], '★ 作废不是失败 —— 报成失败会让用户看到一条假故障');

  // 中途换代的那条路：第一份取回来了，第二份还没取
  //
  // ★ **两个插件** —— 一个插件的话"中途"根本表达不出来（对账每一轮只有一次
  //   下载），这条用例会退化成"一开始就换代"，而那一条上面已经有了。
  const site2 = makeSite();
  const pa = site2.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const pb = site2.add('b', { name: 'b' }, { 'client/index.js': 'module.exports = {};\n' });
  let calls = 0;
  // 每轮：循环开头问一次、取包之前再问一次。第 4 次是第二个插件取包之前。
  const r2 = await callSync(site2, env, { trusted: () => true, stale: () => (calls += 1) > 3 });
  assert.equal(fs.existsSync(poolTree(env, pa, '1.0.0')), true,
    '互换代之前那一份是拿到了的 —— 不然下面那条"第二个没下来"什么都没证明');
  assert.equal(fs.existsSync(poolTree(env, pb, '1.0.0')), false,
    '★ 取到一半换代 ⇒ 第二个绝不能进站点池');
  assert.ok(r2.failed.some((f) => /作废/.test(f.why)),
    `中途换代要说得出这一份为什么没下来：${JSON.stringify(r2.failed)}`);
});

// ══════════════════════════════════════════════════════════════════════════
//  整包：唯一那条投递方式
// ══════════════════════════════════════════════════════════════════════════
//
// ★ v0.6 这一组的第一条是"同一份内容走两条路装出来的东西逐字节相同"。**那条
//   用例连同它防的东西一起走了**：只剩一条路，"走哪条路"就不再是一个变量，
//   没有两条路可以比。留下来的是它真正在防的那件事的下半句 ——
//   **装出来的树必须与站点那一棵逐字节相同**，而那是另一条用例（"取回来的
//   每一份都与站点磁盘上逐字节相同"）。

test('★★ 一条 RPC 把整个包取回来 —— 而且一次都不许再走逐份那条路', async () => {
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' },
    { 'client/index.js': 'module.exports = {};\n', 'job/start.sh': '#!/bin/sh\n' });

  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 1, JSON.stringify(r.failed));
  assert.equal(site.state.pkgCalls, 1, '★ 一个插件一次：整包只该问一次');
  assert.equal(site.state.fileCalls, 0,
    '★ `plugin_file` 这个 op 已经删了 —— 它只可能是 0，而这条断言钉的就是'
    + '"客户端没有偷偷退回逐份取"');

  // ── ★ 判据⑤：容器**自始至终**没有落过盘 —— 连暂存里也没有 ──
  //
  //   它在 `unpackTo` 铺完树之后就退休了。★ 这一条要在**提交之前**查：提交换入
  //   之后暂存就空了，那时"没有 .splug"是一句空话（空目录里当然没有）。
  const stagedNow = r.pendingConsent[0].stagedDir;
  assert.deepEqual(allNames(stagedNow).filter((n) => n.endsWith('.splug')), [],
    '★ 暂存里只有解出来的树，没有容器');
  assert.deepEqual(allNames(env.stagingRoot).filter((n) => n.endsWith('.splug')), [],
    '★ 整个暂存根也一样');

  consentAll(env, r);
  // 池里**两样**：解出来的树 + 它的记录表。★ **没有容器**。
  const tree = poolTree(env, p, '1.0.0');
  const recFile = poolRecord(env, p, '1.0.0');
  assert.equal(fs.existsSync(tree), true, '树要进池（require 用的是它）');
  assert.equal(fs.existsSync(recFile), true, '★ 记录表也要进池 —— 它是这一份的提交点');
  assert.deepEqual(fs.readdirSync(env.siteRoot).filter((n) => n.endsWith('.splug')), [],
    '★★ 池里**一个 `.splug` 都不该有** —— 容器只在链路与内存里活');
  assert.deepEqual(fs.readdirSync(env.stagingRoot).flatMap(
    (n) => (fs.statSync(path.join(env.stagingRoot, n)).isDirectory()
      ? fs.readdirSync(path.join(env.stagingRoot, n)) : [n])).filter((n) => n.endsWith('.splug')), [],
  '★★ 暂存里也一样 —— 只有解出来的树');

  // 记录表里的两样：那个签名块**逐字**保留，以及逐份真相（带容器里的次序）。
  const rec = recOf(env, p, '1.0.0');
  const pkg = PP.parsePackage(site.pkgOf(`${p.id}@1.0.0`).buf);
  assert.equal(rec.envelope.pubkey, pkg.sig.pubkey.toString('base64'));
  assert.equal(rec.envelope.signature, pkg.sig.signature.toString('base64'),
    '★ 签名块要逐字保留 —— 少一位就是"签名对不上"，而那时报的是"有人改了包"');
  // ★ v0.13：那块签的是**四元组**（A.3），所以后四个字段也要逐字留下来。
  //   少了它们，`treeSignature` 拼不回那块字节，而"签名者不变"就只剩指纹比较。
  for (const k of ['id', 'version', 'digestSite', 'digestClient']) {
    assert.equal(rec.envelope[k], pkg.sig[k], `envelope.${k} 要逐字保留`);
  }
  assert.equal(rec.envelope.digestClient, PACKER.sideDigests(pkg.files).client,
    '★ 那个摘要就是**客户端侧那一半**的 §3.4 摘要（阶段 4 之后客户端只有它）');
  assert.deepEqual(rec.files.map((f) => f.path), pkg.files.map((f) => f.path),
    '★ `files` 保留**容器里的次序**（照它重打包 = 逐字节重现原件）');
  assert.equal(PP.contentDigest(rec.files), pkg.digest, '照记录表重算的摘要与原件相同');
  // ★ 记录表里**不存**摘要：它是派生值，存下来就会与 `files` 里的 sha256 各说各话。
  assert.equal(rec.digest, undefined);
});

test('★ 站点自报的内容摘要与它实际发的字节对不上 ⇒ 拒绝，绝不换入', async () => {
  const site = makeSite();
  const env = makeEnv();
  site.state.pkgDigestLie = true;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 0, '对不上的东西不许走进同意闸');
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /说的不是同一份东西/, r.failed[0].why);
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false,
    '★ 一个字节都不许进池');
});

test('★★ `plugin_package` 响应里那一处自述与包对不上 ⇒ 也拒（三处说法要一致）', async () => {
  // ★ 关于同一份东西，站点有**三处**说法：`op_plugins` 那一轮、取包响应里这一次、
  //   以及**我们自己从收到的字节算出来的**。前两处对不上 = 这个站点讲不圆自己的
  //   故事 —— 而那种时候该做的事是拒绝，不是挑一个信。
  //   ★ 这一条与上面那条（`pkgDigestLie`）**不同源**：那一条把**两处一起**改假，
  //     于是 `op_plugins` 那一层就把它拦住了，**响应里那一层没人守**。
  //     （变异验证里"客户端不再比响应里那个 digest"跑出来是**绿的**，就是这么发现的。）
  const site = makeSite();
  const env = makeEnv();
  site.state.pkgRespDigestLie = true;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 0, '对不上的东西不许走进同意闸');
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /响应里报的内容摘要/, r.failed[0].why);
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false, '★ 一个字节都不许进池');
});

test('★ 包里的字节被改过 ⇒ 拒绝，而且**绝不退回逐份那条路**', async () => {
  // ★ 这条是这一组里最承重的一条。逐份那条路**没有签名**（它发的是散装字节），
  //   所以"包验不过就改用文件"等于给出一条绕过验签的路 —— 一个能让包验不过的人
  //   就获得了一次投递未验签内容的机会。那不是"降级"，那是把验签变成一句建议。
  const site = makeSite();
  const env = makeEnv();
  site.state.pkgCorrupt = true;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 0);
  assert.equal(site.state.fileCalls, 0,
    '★ 包读不了的时候**一次 `plugin_file` 都不许发** —— 那就是回退');
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /读不了|不符/, r.failed[0].why);
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false);
});

test('★★ 包格式比客户端认得的新 ⇒ 明确失败，**而且没有退路可退**', async () => {
  // ★ 这条用例在 v0.6 断的是**反面**：那时它要求"退回逐份取那条路，而且说出来"。
  //   逐份取没了，所以它断的东西整个翻了过来 —— 而这条**翻转**是该写下来的，
  //   因为它正是"删掉第二条路"的代价：格式演进从"能加法过渡"变成"只能拒绝"。
  //
  //   与上一条（"包坏了"）仍然是**两件事**，所以两条都在：
  //     · 上一条：这个包与它自己的说法对不上 ⇒ 拒绝（谁在说谎是清楚的）；
  //     · 这一条：这个包说得清清楚楚，只是用的是**我读不懂的说法** ⇒ 拒绝，
  //       而该做的事是**升级客户端**，不是去找管理员。
  const site = makeSite();
  const env = makeEnv();
  site.state.pkgFormat = 3;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r = await callSync(site, env);
  assert.equal(r.pendingConsent.length, 0, '读不懂的包不许走进同意闸');
  assert.equal(site.state.pkgCalls, 0, '★ 读不懂的格式，一次都不该去取');
  assert.equal(site.state.fileCalls, 0, '★ 而且**没有逐份取那条路**可以退回去');
  assert.equal(r.reason, 'site_too_new', '要有一态说明"站点比客户端新"');
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /只认识 1|格式/, r.failed[0].why);
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false);
  // ★ 而它说的是"升级**这个客户端**"——方向对了用户才知道该做什么。
  assert.match(r.failed[0].why, /守护进程比这个客户端新|客户端/, r.failed[0].why);
});

// ★ 这里从前还有一条：『逐份清单与整包说的不是同一份东西 ⇒ 拒绝』。
//   **它跟着那份清单一起走了。** 两条投递方式并存时，站点在同一个响应里给了两份
//   说法（清单与包），而它们分家的那一天谁也不该装作没看见 —— 那条用例断的就是
//   这件事。今天只有一份说法，所以"两份说法互相矛盾"这个形状**表达不出来**。
//
//   ★ 而它防的东西**没有全走**：本站报的每一个数，客户端仍然拿去与**自己算出来的
//   那个**比（`fetchPackage` 里那三条：字节数、内容摘要、响应自报的那两个数）。
//   消失的是"两个来源互相比"，留下的是"自述 vs 事实"。

test('★ 站点自报的字节数与实际的包对不上 ⇒ 拒绝', async () => {
  // ★ 客户端**没法**在取之前知道真包多大，所以这一条只能取回来之后判 —— 判据是
  //   自己数出来的字节数，不是响应里那个 `bytes`。数字对不上说明"站点说它发的是
  //   什么"与"它实际发的是什么"不是一回事。
  const site = makeSite();
  const env = makeEnv();
  site.state.pkgByteDelta = 7;
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r = await callSync(site, env);
  assert.equal(site.state.pkgCalls, 1, '取一次才知道对不对');
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /字节/, r.failed[0].why);
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false);
  assert.equal(fs.existsSync(poolRecord(env, p, '1.0.0')), false,
    '★ 对不上就不许进池 —— 连那个包也不许');
});

test('★ 包里的内容超过**站点自报**的上限 ⇒ 拒绝（自述只能收紧）', async () => {
  // ★ 站点自报一个比客户端硬上限更严的 `file_bytes` —— 客户端必须采纳**更严的
  //   那个**，所以一个 300 KB 的文件在"这个站点说 1024 字节"之下必须被拒。
  //
  //   ★ v0.6 时这条要先把 `files` 藏起来才测得到包那一条路（那份清单会**先**被
  //   `checkDeclared` 拦下，于是包里那一次根本没执行到 —— 一条会绿着放走 bug 的
  //   用例）。清单没了，藏不藏都不存在了，而这条用例断的东西一个字没变。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const big = Buffer.alloc(300 * 1024, 0x78);
  // ★ 同样，必须在**客户端侧**（阶段 4 起站点只发客户端侧）。
  site.state.pkgExtra = [{ path: 'client/big.txt', data: big, sha256: sha256hex(big) }];
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
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false);
});

test('★ 整包超过**链路**上限 ⇒ 拒绝，而且一次都不去取', async () => {
  // ★ `package_bytes` 是**另一笔账**：前面那几个数说的是"解出来那些有多大"，
  //   它说的是"整包 base64 之后装不装得进一条应答"。所以它必须**单独判** ——
  //   拿负载上限去推链路上限，正是这一版之前算错的那笔账。
  const site = makeSite();
  const env = makeEnv();
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
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false);
});

test('★ 「站点愿不愿意发这一份」的判据，与"这一份此刻生产不生产得出来"是两件事', () => {
  // ★ 界面拿它分"本站有而本机没有，等同步/点同意"与"本站根本没打算发这一版"。
  //
  //   这个判据**换过两次**，而三次都是同一个理由：它必须是**协议事实**，不能是
  //   "这次下没下下来"。最早是`Array.isArray(p.files)`；v0.6 两条路并存时是
  //   "有没有一条能走"；v0.7 只剩一条，于是就是"`package` 在不在"。
  const fp = 'a'.repeat(64);
  const meta = { format: 2, bytes: 100, digest: fp };
  assert.equal(S.deliveryOf({ package: meta }, S.HARD_LIMITS).mode, 'package', '有包 = 愿意发');
  assert.equal(S.deliveryOf({ package: null }, S.HARD_LIMITS).mode, null,
    '★ `package: null` 是"此刻生产不出来"（包在守护进程启动之后不见了）——'
    + '它不是"没有这个能力"，能力由顶层有没有 `limits` 回答');
  assert.equal(S.deliveryOf({}, S.HARD_LIMITS).mode, null, '★ 缺席（`undefined`）≠ 否（`null`）');
  // 而"读不懂的格式"是一条**失败**，不是"不分发" —— 两者在界面上说的话完全不同。
  const tooNew = S.deliveryOf({ package: { ...meta, format: 99 } }, S.HARD_LIMITS);
  assert.equal(tooNew.mode, null);
  assert.equal(tooNew.tooNew, true, '★ 它要带着"站点比客户端新"这一态出去');
  assert.match(tooNew.why, /只认识/, tooNew.why);
});

// ══════════════════════════════════════════════════════════════════════════
//  §5.4 钉子：签名者必须是同一把钥匙
// ══════════════════════════════════════════════════════════════════════════

test('★★ 钉过之后签名者换了人 ⇒ 拒绝，并把**两把**指纹都说出来', async () => {
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });

  // 第一次：没钉过 ⇒ 首次即信任，指纹随待同意项一起交到界面上。
  const r1 = await callSync(site, env);
  assert.equal(r1.pendingConsent.length, 1, JSON.stringify(r1.failed));
  const fp1 = r1.pendingConsent[0].fingerprint;
  assert.equal(fp1, site.state.pkgKey.fingerprint, '指纹要从**包本身**算，不是站点自报');

  // ★ 而**签名者换了人、内容一个字没变**：另一个站点用另一把钥匙发同一份内容。
  const other = makeSite();
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

test('★ 钉过之后收到一份**没有签名**的包 ⇒ 拒绝', async () => {
  // ★ §5.4：钉过之后这个 id 的**每一份**都必须由同一把钥匙签。一份不带签名的
  //   构件证明不了它是同一个人做的，所以只能拒绝。
  //
  //   ★ v0.6 时这条走的是**逐份那条路**（那边根本没有包，`pinVerdict` 拿到
  //   `null`）。那条路删掉之后这个形状**在结构上不存在了** —— 但这一态本身还在
  //   （一个作者可以先发不带签名的一版），所以用例换成"站点发一个没签名的**包**"。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  site.state.pkgSign = false;
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
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), true);

  // ★ 台账那一条不见了（用户换过机器 / 删过配置 / 换过摘要公式）。
  env.trusted.clear();
  const r2 = await callSync(site, env);
  assert.deepEqual(r2.kept, [], '台账对不上就不算"已经有了"');
  assert.equal(r2.pendingConsent.length, 1,
    `★★ 它必须走进待同意 —— 这就是那个洞：${JSON.stringify(r2)}`);
  const item = r2.pendingConsent[0];
  assert.equal(item.existing, true, '★ 要标明"本机已经有一份"（出路与草稿不同）');
  assert.equal(item.stagedDir, poolTree(env, p, '1.0.0'),
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
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false);

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
  fs.rmSync(poolTree(env, p, '1.0.0'), { recursive: true, force: true });

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
  fs.rmSync(poolTree(env, a, '1.0.0'), { recursive: true, force: true });
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
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  consentAll(env, r1);
  assert.equal(fs.existsSync(poolRecord(env, p, '1.0.0')), true, '前置');

  site.state.disabled.add(`${p.id}@1.0.0`);
  site.add('b', { id: p.id, name: 'a', version: '1.1.0' },
    { 'client/index.js': 'module.exports = {};\n' });
  const r2 = await callSync(site, env);
  consentAll(env, r2);
  const r3 = await callSync(site, env);
  assert.deepEqual(r3.reclaimed.map((x) => x.version), ['1.0.0'], JSON.stringify(r3.reclaimed));
  assert.equal(fs.existsSync(poolRecord(env, p, '1.0.0')), false,
    '★ 包要一起回收 —— 留下一个没有树的 .splug 就是池里一份谁也看不见的残留');
  assert.equal(fs.existsSync(poolRecord(env, p, '1.1.0')), true);
});

test('★★ 记录表被删掉 ⇒ 这一份**不存在**了（提交点语义），而不是"少了一样本事"', async () => {
  // ★ 从前池里是**两样挨着**的（树 + 那个 `.splug`），而删掉包**不算撤回** ——
  //   于是有一整类状态要伺候："有树没有包"，比对只能做一半（`compared: false`），
  //   界面上还得留一句话解释它。
  //
  // ★★ v0.13 把那一类状态**删掉了**：记录表是**提交点**，树与它同生共死。
  //    "记录表没了"于是有一个明确的意思 —— **这一份不在了**，与"树没了"同义。
  //    这条用例钉的就是这个等号，而它是"容器不落盘"换来的一处**简化**：
  //    两样都对得上才叫装上了，否则重取。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  consentAll(env, r1);
  assert.deepEqual(S.listPooled(env.siteRoot).map((x) => `${x.id}@${x.version}`),
    [`${p.id}@1.0.0`]);

  // ── 手删记录表 ⇒ 清扫器把它当成"没写完的安装"，树也一起收掉 ──
  //
  // ★ 于是走到插件那一格时，**树也不在了** —— 这正好落进 §5.3 那条既有的路：
  //   "本机这一份不在了 ⇒ 同意作废 ⇒ 重新问一次"。
  //   ★ 这是刻意的**安全一侧**：池里那一份（用户同意过的那一份）确实没有了，
  //     而"自己再装回来、一个字都不问"正是 §5.3 要防的那件事。
  //   ★ 与"树在对不上"那一格的差别也正在这里：那一格重取的是**同一份内容**
  //     （台账里那个摘要相符 ⇒ 不必再问），而这一格是本机这一份**没了**。
  fs.rmSync(poolRecord(env, p, '1.0.0'));
  assert.deepEqual(S.listPooled(env.siteRoot), [],
    '★ 没提交的槽位列举看不见 —— 它不存在');

  const r2 = await callSync(site, env);
  assert.equal(r2.kept.length, 0, '★ 它不算"已经有一份"');
  assert.equal(r2.withdrawn.length, 1, '★ 本机那一份不在了 ⇒ 同意作废（§5.3）');
  assert.ok(r2.notices.some((n) => /没写完的安装/.test(n)),
    `清扫要说清它收掉了什么：${JSON.stringify(r2.notices)}`);
  assert.equal(r2.pendingConsent.length, 1, '★ 重新取回来之后要**重新问一次**');

  // ── 记录表在、而**树**被删掉：同一条路（提交点是两样一起）──
  const env2 = makeEnv();
  const r3 = await callSync(site, env2);
  consentAll(env2, r3);
  fs.rmSync(poolTree(env2, p, '1.0.0'), { recursive: true, force: true });
  const r4 = await callSync(site, env2);
  assert.equal(r4.kept.length, 0);
  assert.equal(r4.withdrawn.length, 1, '★ 同上：本机那一份不在了');
  assert.deepEqual(S.listPooled(env2.siteRoot), [], '孤儿记录表也被清扫收掉了');
  assert.equal(r4.pendingConsent.length, 1, '重新取 + 重新问');

  // ── 而"已在本机、台账对不上"那一格还在（原地认领），见下面那条用例 ──
  const env3 = makeEnv();
  const r5 = await callSync(site, env3);
  consentAll(env3, r5);
  env3.trusted.clear();
  env3.pinned.clear();
  const r6 = await callSync(site, env3);
  assert.equal(r6.pendingConsent.length, 1, JSON.stringify(r6.failed));
  assert.equal(r6.pendingConsent[0].existing, true, '这一份已经在池里 ⇒ 原地认领');
  assert.deepEqual(r6.pendingConsent[0].files, ['client/index.js', 'plugin.json'],
    '★ "你要同意的是哪几份文件"从**记录表**里来（次序也是容器里的次序）');
});

test('★★★ 树与记录表**一起**被改 ⇒ 逐份比对过得去，而**签名**挡住（这是这一步的全部意义）', async () => {
  // ★★★ 这一条是"容器只在内存里活"之后**必须显式补上**的那一步（见 site-plugins.js
  //     的 `treeSignature`）。
  //
  //   从前签名盖的是**容器里那张记录表**，而容器在盘上 ⇒ 每次对账都顺手重验一次。
  //   改成"树 + 记录表"之后，改池子的人可以把**两边一起**改成自洽的：
  //   改 `client/index.js`，再把记录表里那一份的 sha256/size 一起改掉。
  //   于是「树 vs 记录表」逐份比对**全过** —— 那一关问的是"这两个东西一致吗"，
  //   而它们确实一致，只是两个都是假的。
  //
  //   拦住它的是**第三个数**：从树重算的内容摘要，与记录表里那个签名块。
  //   签名是**作者**盖的，改池子的人改不动 ⇒ 摘要对不上，签名不成立。
  //
  //   ★ 少了这一步会怎样：§5.4 那条"签名者不变"就只剩**指纹字符串的比较**，
  //     而指纹就写在记录表里 —— 一个能改池的人可以把它一并改掉。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' },
    { 'client/index.js': 'module.exports = { evil: false };\n' });
  const r1 = await callSync(site, env);
  consentAll(env, r1);

  const dest = poolTree(env, p, '1.0.0');
  const evil = Buffer.from('module.exports = { evil: true };\n');
  fs.writeFileSync(path.join(dest, 'client', 'index.js'), evil);
  // 记录表也一起改 —— 改到"两边一致"为止：逐份比对再也说不出话来。
  const rec = recOf(env, p, '1.0.0');
  const row = rec.files.find((f) => f.path === 'client/index.js');
  row.size = evil.length;
  row.sha256 = sha256hex(evil);
  SLOT.writeRecordFile(poolRecord(env, p, '1.0.0'), rec);

  // 前置：**逐份比对确实过得去**（不然这条用例测的是另一件事）。
  assert.equal(S.treeFault(dest, rec.files), null, '前置：树与记录表两边自洽');

  const r2 = await callSync(site, env);
  assert.equal(r2.kept.length, 0, '★★ 自洽的伪造**绝不许**被当成"已经有一份"');
  assert.equal(r2.added.length, 1, '★ 检出之后重取一份真的');
  assert.deepEqual(fs.readFileSync(path.join(dest, 'client', 'index.js')),
    Buffer.from('module.exports = { evil: false };\n'), '★ 池里那一份回到站点的内容');
});

test('★ 没有签名的那一份照常装得上 —— 而"两侧的配套关系"就**没有任何东西保证**', async () => {
  // ★ §4.1 允许作者不签名，所以"没签名"是一条**正常**的路，不是错误。这条用例把
  //   它的**代价**写在明处（那句话要进 SECURITY.md，见计划阶段 6）：
  //
  //     四元组里那两半的**配套关系**（"客户端这一半与站点那一半出自同一次构建"）
  //     靠签名回答。没有签名 ⇒ 没有 `digestSite`、没有 `digestClient` ⇒ 这个保证
  //     **不存在**。★ 这不是新增的洞，是"不签名"本来就有的代价。
  //
  //   ★ 而"树被动过"仍然检得出来 —— 逐份比对与签名无关，它用的是记录表里那一列。
  const site = makeSite();
  const env = makeEnv();
  site.state.pkgSign = false;
  const p = site.add('a', { name: 'a' }, {
    'client/index.js': 'module.exports = {};\n',
    'job/start.sh': 'start_a() { :; }\n',
  });
  const r1 = await callSync(site, env);
  assert.equal(r1.pendingConsent.length, 1, '没签名的照样走到同意闸（§4.1 允许不签）');
  assert.equal(r1.failed.length, 0, JSON.stringify(r1.failed));
  consentAll(env, r1);

  const rec = recOf(env, p, '1.0.0');
  assert.equal(rec.envelope, null, '★ 没有签名 ⇒ 信封是 `null`（不是 `{}`、也不是少一个键）');
  assert.equal(S.treeSignature(poolTree(env, p, '1.0.0'), rec).signed, false,
    '★ `signed: false` —— 调用方要能把它与"验过了"分开');

  const dest = poolTree(env, p, '1.0.0');
  // ★ v0.13 阶段 4 起池子里**只有客户端侧**，所以"就地改一个字节"要在 `client/**`
  //   上造 —— `job/` 那一半现在到不了本机（判据①），拿它当靶子会 ENOENT。
  fs.appendFileSync(path.join(dest, 'client', 'index.js'), '// 谁加的一行\n');
  assert.notEqual(S.treeFault(dest, rec.files), null, '★ 逐份比对仍然守着（它与签名无关）');
  const r2 = await callSync(site, env);
  assert.equal(r2.added.length, 1, '★ 检出之后重取一份干净的');
});

test('★★ 站点侧那一半**根本到不了客户端**（判据①），而记录表里也没有它', async () => {
  // ★★ 这一格在阶段 3 是"客户端核 `digestSite`"：池子里还留着站点侧那一半，
  //    改了它照样被逮住。**阶段 4 之后那一半不在手里了** —— 站点发给客户端的
  //    包里只有客户端侧（`unpackTo` 拒站点侧，见 plugin-package 那一组用例）。
  //
  //    ⇒ 守卫换了人，而**覆盖面一个都没少**：
  //      · 站点侧**到不了**客户端 —— 下面断言池子与记录表里都没有它；
  //      · "站点侧被改"由**站点自己**逮住（`plugin_reconcile` 核**两侧**，对不上
  //        就不发）—— 那条在集群侧有用例（19.14 那一节与 `plugin_reconcile` 那一组）。
  //
  //    ★ 这是本版的主题判据（用户机器上没有 `job/`）。从前它只能靠"读代码看起来
  //      是对的"，现在有断言了。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, {
    'client/index.js': 'module.exports = { evil: false };\n',
    'job/start.sh': 'start_a() { :; }\n',
  });
  const r1 = await callSync(site, env);
  consentAll(env, r1);

  const dest = poolTree(env, p, '1.0.0');
  // ★★ 判据①：**池子里没有 `job/`**。站点的树上有它（`site.add` 写进磁盘了），
  //    而客户端一个字节都不收。
  assert.equal(fs.existsSync(path.join(dest, 'job')), false,
    '★★ 池子里不该有 job/ —— 那是站点侧，用户机器上没有它的位置');
  assert.equal(fs.existsSync(path.join(dest, 'client', 'index.js')), true,
    '而客户端侧照常在');

  // ★ 记录表描述的是**本机这一棵树**，所以它也只该有客户端侧 —— 记录表里留着一条
  //   本机没有的路径的话，下一次对账会报"记录表里有 X、盘上没有它"，而那是一条
  //   **假**的篡改指控。
  const rec = recOf(env, p, '1.0.0');
  const strays = rec.files.filter((f) => !PP.isClientSidePath(f.path));
  assert.deepEqual(strays.map((f) => f.path), [], '★ 记录表里也只该有客户端侧');
  assert.ok(rec.files.some((f) => f.path === 'client/index.js'),
    `客户端侧的文件要在记录表里：${JSON.stringify(rec.files.map((f) => f.path))}`);
  assert.equal(S.treeFault(dest, rec.files), null,
    '前置：树与记录表两边自洽（这一份是**好**的）');
});

test('★ 记录表里那个信封的 id 被改 ⇒ 拒（签名盖的是四元组，改了它就验不过）', async () => {
  // ★ 这一条与上一条**不同源**：上一条改的是树，这一条改的是**信封本身**。
  //   四元组那四个字段全都进了被签消息，所以改任何一个都让签名不成立。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  consentAll(env, r1);
  const rec = recOf(env, p, '1.0.0');
  rec.envelope.id = '01M2JKHTZGQ7X8V4T5R6N7B8CA';
  SLOT.writeRecordFile(poolRecord(env, p, '1.0.0'), rec);
  env.pinned.clear();

  const r2 = await callSync(site, env);
  assert.equal(r2.kept.length, 0);
  assert.equal(r2.added.length, 1, '重取一份真的');
  assert.equal(r2.pendingConsent.length, 0, '★ 不是"没签名所以重新问一次"');
});

test('★★ 改记录表里那个签名一个字节 ⇒ 拒（而不是"这一份没签名"）', async () => {
  // ★★ "有一块、但读不动"与"没有签名"**必须分开**。折成同一件事的后果是
  //    **下转型攻击**：把签名块改坏 ⇒ 变成"没签名" ⇒ 对**钉过的** id 是拒绝
  //    （那一档还算对），而对**没钉过的** id 会被静默收下，此后这一份的来源
  //    没有任何东西能证明。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  consentAll(env, r1);
  const rec = recOf(env, p, '1.0.0');
  assert.ok(rec.envelope, '前置：假站点发的包是签过名的');
  const sig = Buffer.from(rec.envelope.signature, 'base64');
  sig[0] ^= 0xff;
  rec.envelope.signature = sig.toString('base64');
  SLOT.writeRecordFile(poolRecord(env, p, '1.0.0'), rec);
  env.pinned.clear();                    // ★ 连钉子都不留：判据不能靠钉子兜底

  const r2 = await callSync(site, env);
  assert.equal(r2.kept.length, 0, '★ 签名对不上的那一份不算"已经有一份"');
  assert.equal(r2.added.length, 1, '重取一份真的');
  assert.equal(r2.pendingConsent.length, 0, '★ 更不是"没签名所以重新问一次"');
});

test('★ 记录表里那个信封**读不动**（长度不对）也拒 —— 同上，那是"被改过"不是"没签名"', async () => {
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  consentAll(env, r1);
  const rec = recOf(env, p, '1.0.0');
  rec.envelope.pubkey = Buffer.alloc(31, 7).toString('base64');   // 少一个字节
  SLOT.writeRecordFile(poolRecord(env, p, '1.0.0'), rec);
  env.pinned.clear();

  const r2 = await callSync(site, env);
  assert.equal(r2.kept.length, 0);
  assert.ok(r2.notices.some((n) => /信封|签名/.test(n)) || r2.added.length === 1,
    `要说清是那个信封读不动：${JSON.stringify(r2.notices.concat(r2.failed))}`);
  assert.ok(r2.notices.some((n) => /不可用/.test(n)), JSON.stringify(r2.notices));
});

test('★★ 站点报一个带 `../` 的 id ⇒ 一个字节都不写，池外绝不出东西', async () => {
  // ★★ 这一条是**防御**：`p.id` 是站点报来的字符串，从前它被直接拼进
  //    `path.join(siteRoot, p.id, p.version)`，而铺树那一步的 `mkdirSync(recursive)`
  //    会把中间目录**建出来** ⇒ 一个冒充站点的人可以往池外写文件。
  //    ★ 判据是 **id 的形状**（ULID 的 26 个字符里既没有 `/` 也没有 `.`），
  //      不是一份"挡掉想得到的写法"的黑名单。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  site.state.disabled.add(`${p.id}@1.0.0`);            // 真的那一份这一轮不报
  // 站点多报一条：id 是穿越路径，而 `package` 那一格**形状说得通**（免得先被
  // `deliveryOf` 拦住 —— 那样测的就是另一条判据了）。
  site.state.extra.push({ id: '../../escape', version: '1.0.0', name: 'x', title: 'x',
    enabled: true, package: { format: 2, bytes: 100, digest: 'a'.repeat(64) } });

  const r = await callSync(site, env);
  assert.equal(site.state.pkgCalls, 0, '★ 连一次取件的 RPC 都不发');
  for (const outside of [path.join(env.siteRoot, '..', 'escape'),
    path.join(path.dirname(env.siteRoot), 'escape'), path.join(os.homedir(), 'escape')]) {
    assert.equal(fs.existsSync(outside), false, `★ 池外不许出现东西：${outside}`);
  }
  assert.deepEqual(fs.readdirSync(env.siteRoot).filter((n) => n !== S.SNAPSHOT_NAME), [],
    '★ 池子里也不许因为它多出任何东西');
  assert.equal(r.pendingConsent.length, 0);
  assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
  assert.match(r.failed[0].why, /ULID/, r.failed[0].why);
});

test('★★ 提交点是"最后那一写"：换入之后 `listPooled` 才看得见它', async () => {
  // ★ 树 `rename` 进池子与写记录表之间有一个窗口，而窗口里那一份是**不可见**的
  //   （列举看不见、注册表也不加载）。它是"没提交"，不是"装了一半"。
  //   ★ 这里直接对着两步之间的状态断言：把记录表拿掉 = 那个窗口。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  assert.equal(r1.pendingConsent.length, 1);
  const staged = r1.pendingConsent[0].stagedDir;
  const rec = r1.pendingConsent[0].record;
  assert.ok(rec, '★ 记录表草稿要在待同意那一份上 —— 它只在内存里活到提交那一刻');

  // 只 `rename` 树、**不写记录表**（模拟崩在中间）
  const dest = SLOT.treeDirOf(env.siteRoot, p.id, '1.0.0');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(staged, dest);
  assert.deepEqual(S.listPooled(env.siteRoot), [], '★ 没提交 ⇒ 列举看不见');
  assert.deepEqual(new P.Registry([{ dir: env.siteRoot, source: 'site' }],
    { allows: () => true }).list(), [], '★ 注册表也不加载它（提交点不成立）');

  // 提交：写记录表
  assert.equal(SLOT.writeRecordFile(SLOT.recordPathOf(env.siteRoot, p.id, '1.0.0'), rec).ok, true);
  assert.deepEqual(S.listPooled(env.siteRoot).map((x) => `${x.id}@${x.version}`),
    [`${p.id}@1.0.0`], '★ 提交之后才看得见');
});

test('★★ 同意那一刻的次序是"先树后表"：记录表写不下去 ⇒ 不许留一个半成品', async () => {
  // ★ 反过来（先写记录表、后 rename）崩在中间会留下一张指向**不存在的树**的记录表，
  //   而按"记录表 = 已提交"那条判据，池里会有一份**声称装好了、而内容是空的**东西。
  //
  // ★ 这一条钉两件事：①记录表写不下去时**当场**把树撤掉（用户看到的是一句准确的
  //   失败，而不是"上一次没写完的安装"）；②**万一撤不掉**，那一份也不可见、而且
  //   下一轮清扫会收掉它 —— 半成品不许冒充成品，也不许永远赖着。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  const item = r1.pendingConsent[0];
  const tree = SLOT.treeDirOf(env.siteRoot, p.id, '1.0.0');

  // 让记录表那一步写不下去：给它一份**序列化不了**的记录表（自己指自己）。
  // ★ 为什么造在这里而不是"把路径占成一个目录"：那样会**同时**让"撤掉"这一步
  //   也失败（删目录用 `unlink` 不成立），于是测不到第①条。撤不掉那一格见下面。
  const bad = { ...item.record };
  bad.self = bad;
  const mv = S.acceptStaged({
    stagedDir: item.stagedDir, record: bad, siteRoot: env.siteRoot,
    id: p.id, version: p.version, digest: item.digest,
  });
  assert.equal(mv.ok, false, '写不下去就是失败');
  assert.match(mv.error, /记录表写不下去/, mv.error);
  assert.match(mv.error, /已经把它撤掉了/, mv.error);
  assert.equal(fs.existsSync(tree), false, '★ 那棵树要被当场撤掉，不留一个半成品');

  // ── 万一**连撤都撤不掉**（记录表的路径被占成一个目录）：它仍然不可见，
  //    而且下一轮清扫收得掉。★ "半成品不冒充成品"这一条不许有例外 ──
  const r2 = await callSync(site, env);
  const item2 = r2.pendingConsent[0];
  const recPath = SLOT.recordPathOf(env.siteRoot, p.id, '1.0.0');
  fs.mkdirSync(recPath, { recursive: true });
  const mv2 = S.acceptStaged({
    stagedDir: item2.stagedDir, record: item2.record, siteRoot: env.siteRoot,
    id: p.id, version: p.version, digest: item2.digest,
  });
  assert.equal(mv2.ok, false);
  assert.match(mv2.error, /没能撤掉/, mv2.error);
  assert.deepEqual(S.listPooled(env.siteRoot), [], '★ 撤不掉也不可见');
  assert.deepEqual(new P.Registry([{ dir: env.siteRoot, source: 'site' }],
    { allows: () => true }).list(), [], '★ 注册表也不加载它');
  fs.rmSync(recPath, { recursive: true, force: true });
  assert.deepEqual(S.sweepPool(env.siteRoot).removed, [`${p.id}_1.0.0`],
    '★ 下一轮清扫把它收掉');
});

test('★ 没有记录表草稿的调用 ⇒ 失败，而不是留一棵谁也看不见的树', async () => {
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  const r1 = await callSync(site, env);
  const item = r1.pendingConsent[0];
  const mv = S.acceptStaged({
    stagedDir: item.stagedDir, siteRoot: env.siteRoot,
    id: p.id, version: p.version, digest: item.digest,
  });
  assert.equal(mv.ok, false, '没有记录表 = 没提交 ⇒ 不算装上');
  assert.equal(fs.existsSync(SLOT.treeDirOf(env.siteRoot, p.id, '1.0.0')), false);
});

test('★ 站点**不报** `package` 的那一条 ⇒ 不分发，不是失败', async () => {
  // ★ 判据是**键在不在**，不是"这次下没下下来"。池里装过、仓库里没有的那些插件
  //   就长这样 —— 站点说"本站装了它"而"不分发它"，客户端该做的是把它算进
  //   「本站有而本机没有」，而不是记一条"没能装上 X"。
  const site = makeSite();
  const env = makeEnv();
  const p = site.add('a', { name: 'a' }, { 'client/index.js': 'module.exports = {};\n' });
  site.state.noPackage.add(`${p.id}@1.0.0`);
  const r = await callSync(site, env);
  assert.deepEqual(r.failed, [], '不分发不是失败 —— 记成失败会让用户看到一条假故障');
  assert.deepEqual(r.pendingConsent, [], '也不该有东西等着同意');
  assert.equal(site.state.pkgCalls, 0, '★ 自述就说没有，白跑一次传输没意义');
  assert.equal(r.supported, true, '★ 而**能力**还在（顶层有 limits）—— 两件事必须分得开');
  assert.equal(fs.existsSync(poolTree(env, p, '1.0.0')), false);
});
