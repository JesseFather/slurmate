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
 * ★ 这一版 reader **没有调用方**（见 plugin-package.js 的文件头）。所以这里
 *   全部是直接对 reader 的断言：等某个线来接它的时候，这些用例就是那条线的
 *   契约。用例在、调用方不在，是过渡期的正常状态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PP = require('../src/main/plugin-package.js');
const P = require('../src/main/plugins/index.js');

const CONF = fileURLToPath(new URL('../../tools/conformance/', import.meta.url));
const EXPECTED = JSON.parse(fs.readFileSync(`${CONF}expected.json`, 'utf8'));
const BAD = JSON.parse(fs.readFileSync(`${CONF}bad.json`, 'utf8'));

const unhex = (lines) => Buffer.from(lines.join(''), 'hex');
const GOOD = unhex(EXPECTED.package.hex);
const SIGNED = unhex(EXPECTED.signed.hex);

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
  const msg = Buffer.from(EXPECTED.digest, 'hex');
  assert.equal(PP.verifyEd25519(pub, msg, sig), true);
  // 换一位消息 ⇒ 验不过
  const other = Buffer.from(msg);
  other[0] ^= 0xff;
  assert.equal(PP.verifyEd25519(pub, other, sig), false);
  // 签名是**摘要的原值**那 32 字节，不是它的十六进制写法
  assert.equal(PP.verifyEd25519(pub, Buffer.from(EXPECTED.digest, 'ascii'), sig), false,
    '拿十六进制字符串当被签内容也验得过 ⇒ 被签的是哪一个没有写死');
  // 形状不对的公钥不抛，只返回 false
  assert.equal(PP.verifyEd25519(Buffer.alloc(32), msg, sig), false);
});

// ── 坏包 ────────────────────────────────────────────────────────────────────

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
