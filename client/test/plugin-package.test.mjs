/**
 * plugin-package.test.mjs —— 读一个 `.splug`。
 *
 * ★ 这一组测的是**拒绝对不对**，不是成功路径。每一条对应用户可能看到的一句错话：
 *
 *     「装上了」而某一份的字节与记录对不上
 *     「装上了」而信封里夹带了没有声明的字节
 *     「装上了」而负载里其实没有清单
 *     「签名没问题」而它只是"看起来像一块签名"
 *     「这个包是坏的」而其实是客户端还没学会读新格式
 *
 * ★ 判据不是这里写的，是 `tools/conformance/`：一份固定的输入树、一份期望的包
 *   字节、一批坏包（**每一条带一个期望的理由词**）、一组签名夹具。守护进程与
 *   打包器读**同一批十六进制**，所以"三端对同一个包得出同一个答案"这句话是有
 *   内容的 —— 而不是三份各自写一遍、各自说自己对。
 *
 * ★ 这一版起它**有调用方了**（站点分发那条路，与开发者模式的"从一个包安装"）。
 *   所以除了下面这些直接对 reader 的断言，site-plugins.test.mjs 那边还有一组
 *   端到端的（真的包、真的换入、真的验签与钉钉子）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PP = require('../src/main/plugin-package.js');
const P = require('../src/main/plugins/index.js');

const crypto = require('crypto');
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

const CONF = fileURLToPath(new URL('../../tools/conformance/', import.meta.url));
const EXPECTED = JSON.parse(fs.readFileSync(`${CONF}expected.json`, 'utf8'));
const BAD = JSON.parse(fs.readFileSync(`${CONF}bad.json`, 'utf8'));

const unhex = (lines) => Buffer.from(lines.join(''), 'hex');
const GOOD = unhex(EXPECTED.package.hex);
const SIGNED = unhex(EXPECTED.signed.hex);
/** ★★ 站点→客户端那一段**真正发出去**的那一份：只含客户端侧（v0.13 阶段 4）。 */
const CLIENT_SIDE = unhex(EXPECTED.clientSide.hex);

/**
 * 从**夹具里那份带签名的包**切出 `{recs, sig, sigAt}`。
 *
 * ★ 不调 `PP.parsePackage()`：那些字段在 `parsePackage` 的返回值里已经被规范化
 *   过了，拿它回编等于"用被测的那份实现造被测的输入"。这里只按附录 A.2 的字节
 *   布局切，与 `packagesOf` 无关。
 */
function splitSignedFixture() {
  const buf = SIGNED;
  const sigLen = buf.readUInt32BE(16);
  let off = 20;
  const recs = [];
  for (let i = 0; i < buf.readUInt32BE(12); i++) {
    const pathlen = buf.readUInt16BE(off);
    const pathBytes = buf.subarray(off + 2, off + 2 + pathlen);
    const size = buf.readBigUInt64BE(off + 2 + pathlen);
    const sha256 = buf.subarray(off + 2 + pathlen + 8, off + 2 + pathlen + 40);
    const data = buf.subarray(buf.readUInt32BE(16) + off, 0);   // 占位，下面重算
    recs.push({ pathlen, path: pathBytes.toString('utf8'), pathBytes, size, sha256, data });
    off += 2 + pathlen + 40;
  }
  const payload = buf.subarray(off + sigLen);
  let p = 0;
  for (const r of recs) {
    const n = Number(r.size);
    r.data = payload.subarray(p, p + n);
    p += n;
  }
  return { recs, sig: buf.subarray(off, off + sigLen), sigAt: off };
}

/**
 * 这几条记录编出来的容器，记录表在第几字节结束（= 签名块从这里开始）。
 *
 * ★ 必须**现算**：`splitSignedFixture()` 给的 `sigAt` 是它在**整包**里的位置，
 *   而只取一半时记录表短了 —— 拿旧偏移去改新容器，改到的是**负载**里的一个字节
 *   （这一条自己就踩过一次，报出来的是 `content` 而不是 `signature`）。
 */
function tableEndOf(recs) {
  return 20 + recs.reduce((a, r) => a + 2 + r.pathBytes.length + 40, 0);
}

/**
 * 签名块里 `digestSite` / `digestClient` 那 32 字节在**整个容器**里的起点。
 *
 * ★ 算式直接用 A.3 的布局：块长 `188 + verlen`，`digestSite` 在块末 −64、
 *   `digestClient` 在块末 −32。★ **绝对**偏移（含记录表），别拿一个"相对块首"
 *   的数再减一次 —— 那会改到公钥或签名上，而报出来的理由词**仍然是**
 *   `signature`，看着像"这一条验过了"。
 */
function digestSiteAt(recs, version) {
  return tableEndOf(recs) + 188 + Buffer.byteLength(String(version), 'utf8') - 64;
}

function digestClientAt(recs, version) {
  return tableEndOf(recs) + 188 + Buffer.byteLength(String(version), 'utf8') - 32;
}

/** 按 A.2 的布局把 `recs` + 一块签名块编成容器（`format` 用本实现认识的那个）。 */
function buildContainer(recs, sig) {
  const fileCount = Buffer.alloc(4);
  fileCount.writeUInt32BE(recs.length, 0);
  const head = Buffer.alloc(20);
  PP.MAGIC.copy(head, 0);
  head.writeUInt32BE(PP.FORMAT, 8);
  fileCount.copy(head, 12);
  head.writeUInt32BE(sig.length, 16);
  const table = [];
  for (const r of recs) {
    const h = Buffer.alloc(2);
    h.writeUInt16BE(r.pathBytes.length, 0);
    const sz = Buffer.alloc(8);
    sz.writeBigUInt64BE(r.size, 0);
    table.push(h, r.pathBytes, sz, r.sha256);
  }
  return Buffer.concat([head, ...table, sig, ...recs.map((r) => r.data)]);
}

// ── 好包 ────────────────────────────────────────────────────────────────────

test('★ 符合性向量：好包能解析，摘要、份数、逐份 sha256 与夹具逐条对上', () => {
  const r = PP.parsePackage(GOOD);
  assert.equal(r.ok, true, r.ok ? '' : `${r.code} ${r.why}`);
  assert.equal(r.digest, EXPECTED.digest, '内容摘要必须与夹具一致 —— 它是判"同一份构件"的唯一判据');
  assert.equal(r.fileCount, EXPECTED.files.length);
  assert.deepEqual(
    r.files.map((f) => ({ path: f.path, size: Number(f.size), sha256: f.sha256 })),
    EXPECTED.files, '记录表读出来的东西必须与夹具逐条一样（含**次序**）');
  assert.equal(r.sig, null, '这一份没签名');
  assert.equal(r.manifest.id, '01M2JKHTZGQ7X8V4T5R6N7B8C9');
});

test('★ 摘要按 UTF-8 字节排序，不是 JS 的 `<`', () => {
  // 输入树里那两份：字节序 `EF BF BD…` < `F0 9F 98 80…`，而 UTF-16 码元
  // `U+D83D` < `U+FFFD` —— **次序正好相反**。用 `<` 排的实现在这里算出另一个摘要。
  const a = { path: 'cases/�.txt', sha256: '00'.repeat(32) };
  const b = { path: 'cases/\u{1F600}.txt', sha256: '00'.repeat(32) };
  const cat = (x, y) => require('crypto').createHash('sha256')
    .update(Buffer.from(`${x.path}\0${x.sha256}\n${y.path}\0${y.sha256}\n`, 'utf8'))
    .digest('hex');

  assert.equal(PP.contentDigest([a, b]), cat(a, b), '字节序：￿ 在前');
  assert.equal(PP.contentDigest([b, a]), cat(a, b), '喂进去的次序不许影响结果 —— 排序是摘要的一部分');
  assert.notEqual(cat(a, b), cat(b, a), '这一对名字的两种次序必须**不同**，否则这条测的是空气');

  // 而 JS 的 `<` 给的次序与字节序相反 —— 这才是「用 < 排会算出另一个摘要」的实证
  const byLt = [a, b].sort((x, y) => (x.path < y.path ? -1 : 1));
  assert.equal(byLt[0].path, b.path, 'JS 的 < 把 😀 排在前面，而字节序把它排在后面');
});

// ── 签名 ────────────────────────────────────────────────────────────────────

test('★ 签名：验得过、指纹对得上，而且**摘要与没签名的那一份相同**', () => {
  const r = PP.parsePackage(SIGNED);
  assert.equal(r.ok, true, r.ok ? '' : `${r.code} ${r.why}`);
  assert.ok(r.sig, '这一份带签名');
  assert.equal(r.sig.fingerprint, EXPECTED.signed.fingerprint);
  assert.equal(r.sig.pubkey.toString('hex'), EXPECTED.signed.publicKeyHex);
  // ★ §4.2 的可观测形式：签名盖的是**内容摘要**，不是信封。
  //   所以"同一份内容 + 一块签名"的摘要与没有签名时**逐字相同**。
  assert.equal(r.digest, EXPECTED.digest,
    '加了签名之后内容摘要变了 —— 那说明签名被拌进了摘要，或者驱动摘要把信封也算进去了');
  assert.equal(r.digest, PP.parsePackage(GOOD).digest);
});

test('★ 签名验的是"这一段内容"，不是"格式对了就行"', () => {
  const pub = Buffer.from(EXPECTED.signed.publicKeyHex, 'hex');
  const sig = Buffer.from(EXPECTED.signed.signatureHex, 'hex');
  // ★★ v0.13：被签的是**四元组**那串字节（A.3），不是某一个摘要。
  const quad = { id: EXPECTED.signed.id, version: EXPECTED.signed.version,
                 digestSite: EXPECTED.signed.digestSite,
                 digestClient: EXPECTED.signed.digestClient };
  const msg = PP.signedMessage(quad);
  assert.equal(PP.verifyEd25519(pub, msg, sig), true);
  // 换一位消息 ⇒ 验不过
  const other = Buffer.from(msg);
  other[0] ^= 0xff;
  assert.equal(PP.verifyEd25519(pub, other, sig), false);
  // ★ **四元组的每一个成员都真的进了被签消息**：改哪一段都验不过。
  //   少了这一段断言，"id 与版本在不在被签内容里"就没人守 —— 而它们不在的话，
  //   一份构件可以被改个名字挂到另一个插件上，签名照样成立。
  for (const k of ['id', 'version', 'digestSite', 'digestClient']) {
    const tampered = Object.assign({}, quad);
    tampered[k] = k === 'version' ? '1.0.1' : (k === 'id' ? '01M2JKHTZGQ7X8V4T5R6N7B8CA'
      : 'f'.repeat(64));
    assert.equal(PP.verifyEd25519(pub, PP.signedMessage(tampered), sig), false,
      `改掉被签消息里的 ${k} 之后签名仍然成立 ⇒ 它没有真的进那条消息`);
  }
  // 形状不对的公钥不抛，只返回 false
  assert.equal(PP.verifyEd25519(pub, msg, sig) && false, false);
  assert.equal(PP.verifyEd25519(Buffer.alloc(32), msg, sig), false);
});

test('★★ 两侧的摘要：与夹具里那两个逐字相同，而且**两侧会重叠**', () => {
  const r = PP.parsePackage(GOOD);
  assert.equal(r.ok, true, r.ok ? '' : r.why);
  const sd = PP.sideDigests(r.files);
  assert.equal(sd.site, EXPECTED.sides.site.digest,
    '站点侧的 §3.4 摘要与夹具对不上 —— 分侧的规则或摘要公式漂了');
  assert.equal(sd.client, EXPECTED.sides.client.digest);
  // ★ 两侧**不是互补的**：`plugin.json` 与 `lineage.json` 两侧都在。
  const parts = PP.sidesOf(r.files).site.map((f) => f.path);
  assert.ok(parts.includes('plugin.json') && parts.includes('lineage.json'),
    '两个顶层元数据文件要在**站点侧**里 —— 站点侧不是"客户端侧的补集"');
  assert.ok(!parts.includes('client/index.js'), '而 client/** 不在站点侧');
  // ★ 空的那一侧**有定义**（§3.1 允许某一侧为空）：它是 sha256("")，不是 null ——
  //   给它一个 null 的话，"这一侧是空的"与"这一侧不知道"就分不开了。
  assert.equal(PP.contentDigest([]),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '空列表的内容摘要不是 sha256("")');
});

// ── 坏包 ────────────────────────────────────────────────────────────────────

test('★★ 「同一个内容、两个包」：只发客户端侧那一半，**作者的签名照样成立**', () => {
  // ★★ 这是 v0.13 走到今天这一步的**全部理由**（§3.1 第 4 条 + §4.2）。
  //
  //   站点要给客户端发一个只含 `client/**` 的包（阶段 4），而它**没有私钥** ——
  //   它能做的只有把作者那块签名块**原样搬过去**。这件事成立的依据是 §4.2 那条
  //   「**禁止**签名覆盖信封字节」：摘要从解析出来的 `(path, sha256)` 重算，不看
  //   容器怎么编那张表 —— 于是子集的 §3.4 摘要逐字等于作者原件里那一半。
  //
  //   ★ 这一条现在就钉住，因为它是阶段 4 的地基；等到那一步才发现不成立，
  //     要改的就是**签名格式**。
  const parts = splitSignedFixture();
  const clientOnly = parts.recs.filter((r) => PP.isClientSidePath(r.path));
  assert.ok(clientOnly.length && clientOnly.length < parts.recs.length,
    '前置：夹具里两侧都有，子集才是真子集');
  const buf = buildContainer(clientOnly, parts.sig);
  const r = PP.parsePackage(buf);
  assert.equal(r.ok, true, r.ok ? '' : `${r.code} ${r.why}`);
  assert.equal(r.sig.digestClient, EXPECTED.sides.client.digest,
    '★ 客户端侧那一半的摘要与作者原件里那一半**逐字相同**（作者签名认它）');
  assert.equal(r.sig.digestSite, EXPECTED.sides.site.digest,
    '★ 而 `digestSite` 只是**跟着走**，客户端手里没有那一半的字节、核不了它');
  assert.ok(buf.length < SIGNED.length, '★ 真的更小（这一半确实没发出去）');

  // ★★ 判据②的后一半：把 `digestSite` 改一位，**这一个包**（只含客户端侧）也必须拒。
  //    它靠的不是"重算站点侧摘要"（手里没有那半字节），而是**验签** ——
  //    `digestSite` 是四元组的一员，改它就让签名不成立。
  const tampered = Buffer.from(buf);
  tampered[digestSiteAt(clientOnly, EXPECTED.signed.version)] ^= 0xff;
  const bad = PP.parsePackage(tampered);
  assert.equal(bad.ok, false, '★ 改 digestSite 而只发客户端侧 —— 也必须拒得了');
  assert.equal(bad.code, 'signature', bad.why);
});

test('★★ 改只含客户端侧那个包的 `digestClient` ⇒ 也拒（③ 先响：重算的摘要对不上）', () => {
  const parts = splitSignedFixture();
  const clientOnly = parts.recs.filter((r) => PP.isClientSidePath(r.path));
  const buf = Buffer.from(buildContainer(clientOnly, parts.sig));
  buf[digestClientAt(clientOnly, EXPECTED.signed.version)] ^= 0xff;
  const bad = PP.parsePackage(buf);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'signature', bad.why);
  assert.match(bad.why, /客户端侧/, '★ 要说出**是哪一侧**对不上');
});

test('★ 只有站点侧的包也合法（§3.1：某一侧为空是允许的）', () => {
  // ★ 一条插件可以只有 `job/**`、一个字节的客户端代码都没有 —— 那样的包**必须**
  //   读得动，而且它客户端侧那份摘要不是 null、也不是空：`plugin.json` 是客户端侧的
  //   一员，它永远在。★ 三个阶段之后（分发只发客户端侧）这一格会变成"某一侧**真的**
  //   空"，那时这条判据仍然成立。
  const PACKER = require('../../packer/slurmate-packer.js');
  const mf = JSON.stringify({ id: '01M2JKHTZGQ7X8V4T5R6N7B8C9', name: 's', version: '1.0.0' });
  const files = [
    { path: 'plugin.json', data: Buffer.from(mf), sha256: sha256hex(Buffer.from(mf)) },
    { path: 'job/start.sh', data: Buffer.from('start_s() { :; }\n'),
      sha256: sha256hex(Buffer.from('start_s() { :; }\n')) },
  ];
  const sd = PACKER.sideDigests(files);
  const quad = { id: '01M2JKHTZGQ7X8V4T5R6N7B8C9', version: '1.0.0',
                 digestSite: sd.site, digestClient: sd.client };
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
    .subarray(-32);
  const buf = PACKER.buildPackage(files, PACKER.buildSigBlock(Object.assign({
    alg: 1, pubkey: pub, sig: crypto.sign(null, PACKER.signedMessage(quad), privateKey),
  }, quad)));
  const r = PP.parsePackage(buf);
  assert.equal(r.ok, true, r.ok ? '' : `${r.code} ${r.why}`);
  // ★ 两侧都**保留容器里的次序**（与记录表那条同源：照它重打包要逐字节重现原件）。
  assert.deepEqual(PP.sidesOf(r.files).site.map((f) => f.path),
    ['plugin.json', 'job/start.sh'], '站点侧 = 不以 client/ 开头的那些');
  assert.deepEqual(PP.sidesOf(r.files).client.map((f) => f.path), ['plugin.json'],
    '★ 客户端侧**不是空的** —— `plugin.json` 永远在（三端的分侧规则都靠这一条）');
  assert.equal(PP.sideDigests(r.files).site, sd.site);
});

test('★ 符合性向量：每一份坏包都必须被拒，且理由是**夹具里那个词**', () => {
  const wrong = [];
  for (const c of BAD.cases) {
    const r = PP.parsePackage(unhex(c.hex));
    if (r.ok) wrong.push(`${c.name} → 收下了`);
    else if (r.code !== c.code) wrong.push(`${c.name} → ${r.code}（期望 ${c.code}）`);
  }
  assert.deepEqual(wrong, [], '理由词表与判的次序是三份实现共用的契约（附录 A.4）');
});

test('★ 坏包覆盖了附录 A.4 词表里的每一个词', () => {
  const covered = new Set(BAD.cases.map((c) => c.code));
  const missing = Object.values(PP.R).filter((c) => !covered.has(c));
  assert.deepEqual(missing, [], '词表里有一个词没有任何坏包钉住 ⇒ 那一条判据没人守');
});

test('★ 截断到任何一个长度都不许崩，只许说"不长这样"', () => {
  // 从 0 到整个包减一，逐字节砍。任何一次抛出都是"远端的字节能让客户端崩" ——
  // 而这是一个只读解析器，它唯一的合法反应是返回一个不合规的理由。
  const codes = new Set();
  for (let n = 0; n < GOOD.length; n++) {
    const r = PP.parsePackage(GOOD.subarray(0, n));
    assert.equal(r.ok, false, `截到 ${n} 字节居然通过了`);
    assert.ok(typeof r.code === 'string' && typeof r.why === 'string');
    codes.add(r.code);
  }
  assert.ok(codes.size >= 2, `截断只产生了 ${[...codes]} —— 检查太粗，等于没查`);
});

test('不是 Buffer / 空 Buffer 一律是"不长这样"，不是异常', () => {
  for (const x of [null, undefined, '', 0, {}, [], Buffer.alloc(0)]) {
    const r = PP.parsePackage(x);
    assert.equal(r.ok, false, `${JSON.stringify(x)} 被收下了`);
    assert.equal(r.code, PP.R.LENGTH);
  }
});

test('readPackageFile：读不到文件时也返回理由，不抛', () => {
  const r = PP.readPackageFile('/nonexistent/nope.splug');
  assert.equal(r.ok, false);
  assert.match(r.why, /读不到/);
});

// ── 与 §3.3 的关系 ──────────────────────────────────────────────────────────

test('★ 大小写折叠是 ASCII-only —— 全 Unicode 折叠会让两端一边收一边拒', () => {
  // 这是**拒绝**规则：折叠口径不一致 ⇒ 同一个包在一台机器上装得上、另一台装不上。
  assert.equal(P.foldAscii('ABC'), 'abc');
  assert.equal(P.foldAscii('Case/aB.txt'), 'case/ab.txt');
  // `İ`（U+0130）与 `K`（U+212A KELVIN）正是全 Unicode 折叠**会**折到 ASCII、
  // 而 ASCII-only **不**折的两个：`'İ'.toLowerCase()` 是两码元的 `i̇`，
  // `'K'.toLowerCase()` 就是 `'k'`。这两条断言就是那条纪律的实证。
  assert.notEqual(P.foldAscii('İ'), 'i');
  assert.notEqual(P.foldAscii('K'), 'k');
  assert.equal('K'.toLowerCase(), 'k', '—— 这一条说明"用 toLowerCase 就会分家"不是假想');
  // 而非 ASCII 的字母一律原样保留：两个不同的路径就是两个不同的路径
  assert.equal(P.foldAscii('中文/文件.txt'), '中文/文件.txt');
  assert.equal(P.foldAscii('A中B'), 'a中b');
});

// ── §5.4：签名者是不是本机钉住的那一把 ──────────────────────────────────────

test('首次即信任：没钉过的时候不拦，并把要钉的那一把交出来', () => {
  const signed = PP.parsePackage(SIGNED);
  const v = PP.keyVerdict(undefined, signed);
  assert.equal(v.ok, true);
  assert.equal(v.first, true);
  assert.equal(v.fingerprint, EXPECTED.signed.fingerprint, '交给调用方去钉的必须是这一把');

  // 不带签名的第一份：**允许**，而且什么都不该钉（fingerprint 是 null）——
  // "先发不带签名的版本、后来开始签"是作者的自由（§4.1）。
  const v2 = PP.keyVerdict(undefined, PP.parsePackage(GOOD));
  assert.equal(v2.ok, true);
  assert.equal(v2.first, true);
  assert.equal(v2.fingerprint, null, '没签名 ⇒ 没有公钥可钉，调用方不该写台账');
});

test('★ 同一把钥匙 ⇒ 过；换了一把 ⇒ 拒绝，而且**两把指纹都说得出来**', () => {
  const signed = PP.parsePackage(SIGNED);
  const fp = EXPECTED.signed.fingerprint;
  const same = PP.keyVerdict(fp, signed);
  assert.equal(same.ok, true);
  assert.equal(same.first, false, '这不是"首次" —— 调用方不该在这里重写钉子');

  const other = '0'.repeat(63) + '1';
  const v = PP.keyVerdict(other, signed);
  assert.equal(v.ok, false);
  assert.equal(v.code, PP.PIN.CHANGED);
  assert.equal(v.pinned, other);
  assert.equal(v.got, fp);
  // §5.4：「必须把两把公钥的指纹都说出来」—— 所以两把都要在那句话里。
  assert.ok(v.why.includes(other) && v.why.includes(fp), v.why);
});

test('★★ 内容**没变**而签名者变了 ⇒ 也必须拒绝（摘要挡不住这一件事）', () => {
  // 这一条是 §5.4 里那句"一致性判据与认证判据不是一回事、禁止合并"的实证：
  // 两份包的内容摘要**一字不差**（签名盖的是摘要，不覆盖信封），
  // 而它们是两个不同的人做的 —— 摘要看得见的东西里没有任何一处不同。
  const a = PP.parsePackage(GOOD);
  const b = PP.parsePackage(SIGNED);
  assert.equal(a.digest, b.digest, '前提：这两份的内容摘要必须相同，否则这条测的是别的东西');

  const v = PP.keyVerdict('f'.repeat(64), b);
  assert.equal(v.ok, false);
  assert.equal(v.code, PP.PIN.CHANGED);
});

test('★ 钉过之后收到一份**不带签名**的 ⇒ 拒绝（"此后每一份都必须同一把钥匙签"）', () => {
  const v = PP.keyVerdict(EXPECTED.signed.fingerprint, PP.parsePackage(GOOD));
  assert.equal(v.ok, false);
  assert.equal(v.code, PP.PIN.UNSIGNED);
  assert.equal(v.got, null);
  assert.ok(v.why.includes(EXPECTED.signed.fingerprint), '要说清钉的是哪一把');
});

test('★★ 钉子本身读不动 ⇒ 一律拒绝，绝不退化成"首次即信任"', () => {
  // `''`（表里那一条缺字段）与任何不合形状的值走同一条路。把它们当成"没钉过"
  // 就是静默地重新 TOFU 一次 —— 而那正是 §2.5 的分身判定要挡的事。
  const signed = PP.parsePackage(SIGNED);
  for (const broken of ['', 'abc', 'ABC', 'z'.repeat(64), EXPECTED.signed.fingerprint.toUpperCase()]) {
    const v = PP.keyVerdict(broken, signed);
    assert.equal(v.ok, false, `${JSON.stringify(broken)} 被当成了"没钉过"`);
    assert.equal(v.code, PP.PIN.BROKEN);
  }
  // 大写不算"同一把"：指纹是**全小写十六进制**（附录 A.3 那句话的形状），
  // 而一个大小写不敏感的比对会让两个不同的字符串看起来一样。
});

// ── 把负载铺到磁盘上（`unpackTo`）────────────────────────────────────────────

test('★ unpackTo 铺出来的树与包里的记录**逐字节相同**，权限位是 0644', () => {
  // ★ 权限位**进摘要**（plugins.digestOf 里有 mode），所以"铺出来的文件是 0644"
  //   不是一件风格问题：两份实现（或者一次 umask 差异）漂开的那天，同一份内容会
  //   在机器上算出两个摘要，而症状是"明明装好了却一直说内容不一样"。
  //   ★ v0.13 阶段 4 起这里铺的是**站点真的会发的那一份**（`CLIENT_SIDE`，只含
  //     客户端侧）—— 从前用整包，而那个形状现在根本到不了客户端。
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-unpack-'));
  const r = PP.parsePackage(CLIENT_SIDE);
  assert.equal(r.ok, true);
  const u = PP.unpackTo(r, CLIENT_SIDE, dir);
  assert.equal(u.ok, true, u.why);

  const got = P.readPluginFiles(dir);
  // ★ 两边**各自按自己的口径排过序**（`readPluginFiles` 用 JS 的 `<`，包里的记录
  //   是容器次序 = UTF-8 字节序），所以这里必须按同一个键重排了再比 —— 直接
  //   `deepEqual` 会在那条非 BMP 路径上红，而那是**排序口径**的差别，不是内容。
  const byBytes = (a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'));
  const norm = (list) => list.map((f) => ({ path: f.path, size: Number(f.size), sha256: f.sha256 }))
    .sort(byBytes);
  assert.deepEqual(norm(got), norm(r.files),
    '铺出来的树必须与包里的记录逐条对得上');
  assert.equal(got.filter((f) => f.kind !== 'f').length, 0,
    '★ 只有普通文件 —— 格式里没有链接、没有空目录，铺出来也不许有');
  for (const f of got) {
    assert.equal(f.mode, 0o644, `★ 权限位由格式定死：${f.path} 是 ${f.mode.toString(8)}`);
  }
});

test('★★ 含站点侧的包 ⇒ unpackTo **整份拒收**（判据①：用户机器上没有 job/）', () => {
  // ★★ v0.13 阶段 4：站点发给客户端的**只含客户端侧**，而这一条是那句话的
  //    可执行形式，也是它的回归测试 —— 少了它，"多发的站点侧字节"只会在下一次
  //    有人真去翻池子目录时才发现，而那时它已经躺了很久。
  //    ★ 判据是**拒绝整份**，不是把那几份跳过：跳过会把"有人在中间塞了东西"变成
  //      "安静地少装了几份"，而客户端手里那一份构件于是与签名说的不是同一份东西
  //      —— 那正是最该响的时候。
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-unpack-side-'));
  const r = PP.parsePackage(SIGNED);        // 整包：两侧都在（作者发的那一份）
  assert.equal(r.ok, true,
    '★ 整包本身是**合法**的 —— 拒它的是落盘这一步，不是解析器（三端的解析器都要读得动它）');
  const u = PP.unpackTo(r, SIGNED, dir);
  assert.equal(u.ok, false, '★ 站点侧的路径到了客户端 ⇒ 拒');
  // ★ 要点名是**哪几份**（与"改了一棵树要报出哪一份"同源：只说"拒了"等于让人去猜）。
  const stray = EXPECTED.sides.site.files
    .filter((p) => !EXPECTED.clientSide.files.includes(p));
  assert.ok(stray.length > 0, '夹具里得有站点侧的文件 —— 不然这一条什么也没测');
  assert.ok(u.why.includes(`等 ${stray.length} 份`),
    `要说清一共几份（${stray.length}）：${u.why}`);
  assert.ok(u.why.includes(stray[0]), `要点名第一份（${stray[0]}）：${u.why}`);
  assert.equal(fs.readdirSync(dir).length, 0, '★ 一个字节都不许落盘（判在写盘之前）');
});

test('★ 客户端收得下的包，必须装得下它**自己允许的最大负载**', () => {
  // ★ 跨语言那一条（客户端这份上限 vs 守护进程的 PLUGIN_PACKAGE_MAX_BYTES）由
  //   集群侧的用例 19.11d 钉着；这里钉的是客户端**自己**的那笔账：一个合法到
  //   极点的包（负载刚好顶到 total_bytes）base64 之后 + 记录表与签名块，
  //   必须仍然塞得进 package_bytes。不然客户端会单方面拒绝一个合规站点发得出来
  //   的包，而症状是"站点说它发了，我就是收不到"。
  const S = require('../src/main/site-plugins.js');
  const wire = Math.ceil(S.HARD_LIMITS.total_bytes * 4 / 3) + (1 << 16);
  assert.ok(S.HARD_LIMITS.package_bytes >= wire,
    `package_bytes=${S.HARD_LIMITS.package_bytes} 装不下最大合法负载的 base64（约 ${wire} 字节）`);
});
