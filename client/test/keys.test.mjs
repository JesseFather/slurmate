/**
 * keys.test.mjs —— SSH 密钥对的生成与封装。
 *
 * 这个文件的中心断言是**密码学正确性**，不是「看着像」：
 * 用生成的私钥签名，用 Node 原生 crypto 拿对应的公开钥验签 ——
 * 对的消息必须过，篡改的消息必须不过。
 *
 * 为什么必须这么测：手工拼 openssh-key-v1 二进制最容易出的错，是拼出一个
 * **语法合法、语义错误**的东西 —— base64 长得对、ssh2 也肯解析，但签出来的名
 * 是错的。肉眼审不出来，用户要等到 IDM 注册完、连接失败时才发现，而那时的
 * 报错只会说「认证失败」，指不回这里。所以两个方向都要断言：
 * 能解析（语法）**且**签名可验证（语义）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const keys = require('../src/main/keys.js');
const { utils: sshUtils } = require('ssh2');

/** 读一个 SSH string（uint32 长度 + 内容），返回 {value, next}。 */
function readString(buf, offset) {
  const len = buf.readUInt32BE(offset);
  return { value: buf.subarray(offset + 4, offset + 4 + len), next: offset + 4 + len };
}

/**
 * 从一行公钥里还原出 Node 的公开钥对象，供原生验签用。
 *
 * blob 的布局是 string(算法名) || string(pub32) —— **两个**长度前缀都要跳过。
 * （第一版这里漏了第二个，抓到的是「长度前缀 + 28 字节公钥」，导致验签恒失败。
 *   记住这个形状，别再手算偏移。）
 */
function publicKeyObjectFromLine(line) {
  const blob = Buffer.from(line.trim().split(/\s+/)[1], 'base64');
  const algo = readString(blob, 0);
  assert.equal(algo.value.toString('utf8'), 'ssh-ed25519');
  const raw = readString(blob, algo.next);
  assert.equal(raw.value.length, 32);
  // SPKI DER：12 字节定长头（SEQUENCE / OID 1.3.101.112 / BIT STRING）+ 32 字节公钥
  const header = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([header, raw.value]),
    format: 'der',
    type: 'spki',
  });
}

test('★ 生成的私钥签出的名，能被对应的公开钥验过（语义正确，不只是语法合法）', () => {
  const { privateKeyPem, publicKeyLine } = keys.generate();

  const parsed = sshUtils.parseKey(privateKeyPem);
  assert.ok(!(parsed instanceof Error), `ssh2 应能解析：${parsed && parsed.message}`);
  assert.equal(parsed.type, 'ssh-ed25519');
  assert.equal(parsed.isPrivateKey(), true);

  const msg = Buffer.from('slurmate-keys-test');
  const sig = parsed.sign(msg);
  assert.ok(Buffer.isBuffer(sig), 'sign() 应返回裸签名 Buffer');
  assert.equal(sig.length, 64, 'ed25519 签名固定 64 字节');

  const pub = publicKeyObjectFromLine(publicKeyLine);
  assert.equal(crypto.verify(null, msg, pub, sig), true, '正确消息必须验签通过');
  assert.equal(crypto.verify(null, Buffer.from('tampered'), pub, sig), false,
    '篡改的消息必须验签失败 —— 否则签名与公开钥根本不是一对');
});

test('★ 公钥行与私钥同源（推导出来的，不是另外存的一份）', () => {
  const { privateKeyPem, publicKeyLine } = keys.generate();
  assert.equal(keys.publicKeyLineFromPrivatePem(privateKeyPem), publicKeyLine);

  const parsed = sshUtils.parseKey(publicKeyLine);
  assert.ok(!(parsed instanceof Error), '公钥行应能被 ssh2 解析');
  assert.equal(parsed.type, 'ssh-ed25519');
  assert.equal(parsed.isPrivateKey(), false);
});

test('公钥行是 OpenSSH 一行格式：类型 + base64 + 注释', () => {
  const { publicKeyLine } = keys.generate();
  const parts = publicKeyLine.split(/\s+/);
  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'ssh-ed25519');
  assert.match(parts[1], /^[A-Za-z0-9+/]+=*$/);
  assert.match(parts[2], /^slurmate-\d{8}$/, '注释带日期，便于在 IDM 里分辨');
});

test('私钥是 PEM 包裹的 openssh-key-v1，且我们能认它', () => {
  const { privateKeyPem } = keys.generate();
  assert.ok(privateKeyPem.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n'));
  assert.ok(privateKeyPem.trimEnd().endsWith('-----END OPENSSH PRIVATE KEY-----'));
  assert.equal(keys.isUsablePrivatePem(privateKeyPem), true);

  // 换行宽度 70 —— 与 ssh-keygen 一致，diff 时不会整段变动
  const body = privateKeyPem.split('\n').slice(1, -2);
  assert.ok(body.every((l) => l.length <= 70));
});

test('★ 每次生成都是新的密钥（不重复使用随机数）', () => {
  const a = keys.generate();
  const b = keys.generate();
  assert.notEqual(a.privateKeyPem, b.privateKeyPem);
  assert.notEqual(a.publicKeyLine, b.publicKeyLine);
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('指纹是 ssh-keygen -lf 同款：SHA256: 前缀、无 = 填充', () => {
  const { publicKeyLine, fingerprint } = keys.generate();
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.ok(!fingerprint.includes('='), '应剥掉 base64 的 = 填充');
  // 稳定：同一行永远得到同一指纹
  assert.equal(keys.fingerprintOf(publicKeyLine), fingerprint);
});

test('指纹能区分不同的公钥', () => {
  const set = new Set();
  for (let i = 0; i < 8; i += 1) set.add(keys.fingerprintOf(keys.generate().publicKeyLine));
  assert.equal(set.size, 8);
});

test('isValidPublicKeyLine 拒绝坏输入', () => {
  const good = keys.generate().publicKeyLine;
  assert.equal(keys.isValidPublicKeyLine(good), true);
  assert.equal(keys.isValidPublicKeyLine(''), false);
  assert.equal(keys.isValidPublicKeyLine(null), false);
  assert.equal(keys.isValidPublicKeyLine('ssh-rsa AAAAB3NzaC1yc2E= x'), false, '类型不对');
  assert.equal(keys.isValidPublicKeyLine('ssh-ed25519'), false, '缺 blob');
  assert.equal(keys.isValidPublicKeyLine('ssh-ed25519 !!!notbase64!!! x'), false);
  // blob 截断：只留算法名，没有 32 字节公钥
  const algoOnly = Buffer.concat([
    (() => { const l = Buffer.alloc(4); l.writeUInt32BE(11); return l; })(),
    Buffer.from('ssh-ed25519'),
  ]).toString('base64');
  assert.equal(keys.isValidPublicKeyLine(`ssh-ed25519 ${algoOnly} x`), false, '公钥长度不足');
});

test('decodePrivate 对垃圾输入返回 null，不抛异常', () => {
  for (const bad of ['', 'not-a-pem', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n', null, undefined, 42]) {
    assert.equal(keys._internal.decodePrivate(bad), null, `输入 ${JSON.stringify(bad)}`);
  }
});

test('★ 带口令（加密）的私钥被认出来并拒绝使用，而不是当成明文硬解', () => {
  // 造一个 ciphername 不为 none 的 openssh-key-v1：把明文体里的 "none" 换成 "aes256-ctr"。
  // 字段编码是 uint32 长度 + 内容，所以长度也要跟着改。
  const { privateKeyPem } = keys.generate();
  const blob = Buffer.from(
    privateKeyPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');

  const marker = Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from('none')]);
  const idx = blob.indexOf(marker);
  assert.ok(idx > 0, '应能在 blob 里找到 ciphername 字段');

  const enc = Buffer.from('aes256-ctr');
  const encLen = Buffer.alloc(4);
  encLen.writeUInt32BE(enc.length);
  const rebuilt = Buffer.concat([
    blob.subarray(0, idx), encLen, enc, blob.subarray(idx + marker.length),
  ]).toString('base64');

  const info = keys._internal.decodePrivate(rebuilt);
  assert.ok(info, '仍应能解出公开信息（公钥 blob 在明文段里）');
  assert.equal(info.encrypted, true, '必须识别为加密私钥');
  assert.equal(keys.isUsablePrivatePem(rebuilt), false, '加密私钥不得被当作可用');
  assert.equal(keys.publicKeyLineFromPrivatePem(rebuilt), null,
    '推不出公钥时应返回 null，不能猜');
});
