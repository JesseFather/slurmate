/**
 * plugin-slot.test.mjs —— 池里一个槽位的**形状**：名字怎么切、记录表长什么样。
 *
 * ★ 这个模块是**叶子**（只 require `fs`/`path`/原子写/`ulid`），所以它能被单独喂 ——
 *   而这一层值得单独喂，因为**两端都要用同一套切法**：站点侧的文件名是
 *   `<id>.json`、客户端是 `<id>_<版本>.json`，而"哪个名字说的是哪一份"一旦分家，
 *   症状是"一个插件在注册表里看得见、在列表与回收里看不见"。
 *
 * ★ 这里断言的是**判据**，不是实现：哪些名字算槽位、哪些不算、记录表什么样的算
 *   读得动。每一条都对应一句"认错了会怎样"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SLOT = require('../src/main/plugin-slot.js');
const ulid = require('../src/main/plugins/ulid.js');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 一张形状说得通的记录表。 */
const okRecord = (over = {}) => ({
  schema: SLOT.RECORD_SCHEMA,
  format: 1,
  envelope: null,
  files: [{ path: 'plugin.json', size: 2, sha256: sha('{}') }],
  ...over,
});

// ── 名字 ────────────────────────────────────────────────────────────────────

test('★ 槽位名：`<id>_<版本>` 切得出两段，而切不对的一律 `null`（**不猜**）', () => {
  const id = ulid.mint();
  assert.equal(SLOT.slotNameOf(id, '1.0.0'), `${id}_1.0.0`);
  assert.deepEqual(SLOT.parseSlotName(`${id}_1.0.0`), { id, version: '1.0.0' });

  // ★ **名字安全是结构性的**：id 必须是 ULID（26 个字母数字），所以 `../..` 这类
  //   东西根本进不来。这一条挡的是"一个冒充站点的人让写入落到池子外面"。
  for (const bad of ['../../escape', 'x', '', `${id}`, `${ulid.mint()}`,
    `../${id}_1.0.0`, `${id}/1.0.0`, `${id}_`, `_1.0.0`, `${id}_..`, `${id}_.hidden`,
    `${id}_a/b`, `${id}_a\\b`, `prefix${id}_1.0.0`, null, undefined, 7]) {
    assert.equal(SLOT.parseSlotName(bad), null, `这个不该算一个槽位名：${JSON.stringify(bad)}`);
  }
  assert.equal(SLOT.slotNameOf('不是一个 ULID', '1.0.0'), null);
  assert.equal(SLOT.slotNameOf(id, '..'), null, '版本那一段也不许是一个跳目录的名字');
  assert.equal(SLOT.slotNameOf(id, 'x'.repeat(65)), null, '太长的不当文件名');

  // ★ 路径助手在名字建不出来时**返回 `null`，绝不拼半个路径** —— 拼半个就是
  //   一个会写到池子外面的路径，而调用方多半是在 `path.join` 之后才发现不对。
  assert.equal(SLOT.treeDirOf('/pool', '../../escape', '1.0.0'), null);
  assert.equal(SLOT.recordPathOf('/pool', '../../escape', '1.0.0'), null);
  assert.equal(SLOT.treeDirOf('/pool', id, '1.0.0'), path.join('/pool', `${id}_1.0.0`));
});

test('★★ 记录表那个后缀是**保留的**：一个树目录不许长成记录表的样子', () => {
  // ★ 不挡它的后果很具体：`<id>_1.0.0.json` 会被读成"id=<id>，版本=`1.0.0.json`"——
  //   一个永远不成立的槽位，而旁边那张记录表会被当成一个**来历不明的文件**报出去。
  //   ★ 池里只有两种名字，所以这个后缀归哪一种必须是**排他的**。
  const id = ulid.mint();
  assert.equal(SLOT.parseSlotName(`${id}_1.0.0.json`), null);
  assert.deepEqual(SLOT.parseRecordName(`${id}_1.0.0.json`), { id, version: '1.0.0' });
  assert.equal(SLOT.parseRecordName(`${id}_1.0.0`), null);
  assert.equal(SLOT.parseRecordName('.sites.json'), null, '快照表不是任何一份的记录表');
  assert.equal(SLOT.parseRecordName('1.0.0.json'), null);
});

// ── 记录表 ──────────────────────────────────────────────────────────────────

test('★★ 记录表读不动的每一种，都要说得出**是哪一种**', () => {
  const root = tmp('slurmate-slot-');
  const p = path.join(root, 'r.json');

  fs.writeFileSync(p, '{ 这不是 JSON');
  assert.match(SLOT.readRecordFile(p).why, /不是合法的 JSON/);

  fs.writeFileSync(p, JSON.stringify([1, 2, 3]));
  assert.match(SLOT.readRecordFile(p).why, /JSON 对象/);

  fs.writeFileSync(p, JSON.stringify(okRecord({ schema: 99 })));
  assert.match(SLOT.readRecordFile(p).why, /schema/,
    '★ 不认识的 schema 要**拒绝** —— "写它的东西比这个客户端新"');

  fs.writeFileSync(p, JSON.stringify(okRecord({ format: 0 })));
  assert.match(SLOT.readRecordFile(p).why, /format/);

  fs.writeFileSync(p, JSON.stringify(okRecord({ files: [] })));
  assert.match(SLOT.readRecordFile(p).why, /非空数组/);

  fs.writeFileSync(p, JSON.stringify(okRecord({
    files: [{ path: 'a', size: 1, sha256: 'A'.repeat(64) }],
  })));
  assert.match(SLOT.readRecordFile(p).why, /sha256/,
    '★ 大写十六进制**不算** —— 两端要的是一模一样的串');

  fs.writeFileSync(p, JSON.stringify(okRecord({ files: [{ path: 'a', size: -1 }] })));
  assert.match(SLOT.readRecordFile(p).why, /size|sha256/);

  fs.writeFileSync(p, JSON.stringify(okRecord({ envelope: { alg: 1 } })));
  assert.match(SLOT.readRecordFile(p).why, /pubkey/,
    '★ 信封少一半也算读不动 —— 它只可能是被改过');

  assert.equal(SLOT.readRecordFile(path.join(root, '不存在.json')).ok, false);

  fs.writeFileSync(p, JSON.stringify(okRecord()));
  assert.equal(SLOT.readRecordFile(p).ok, true);
  fs.unlinkSync(p);
});

test('★ 一张读得动的记录表：写下去、读回来、逐字节相同（它是提交点）', () => {
  const root = tmp('slurmate-slot-');
  const p = path.join(root, 'r.json');
  const rec = okRecord({
    envelope: { alg: 1, pubkey: Buffer.alloc(32, 3).toString('base64'),
                signature: Buffer.alloc(64, 4).toString('base64') },
  });
  assert.equal(SLOT.writeRecordFile(p, rec).ok, true);
  const back = SLOT.readRecordFile(p);
  assert.equal(back.ok, true, back.why);
  assert.deepEqual(back.record, rec);

  // ★ 原子写：同目录不许留临时文件（`.r.json.tmp.<pid>.<rand>` 那种）。
  assert.deepEqual(fs.readdirSync(root), ['r.json']);

  // ★ 删掉一张不存在的记录表算成功 —— "撤回一个不存在的提交"是空操作。
  assert.equal(SLOT.removeRecordFile(path.join(root, '没有.json')).ok, true);
});

test('★ 序列化不了的记录表**返回失败、不抛** —— 那一写就是提交，它必须能被判成败', () => {
  // ★ 抛出去的话调用方按契约不写 try/catch（"不抛"是这个模块的承诺），异常会一路
  //   穿到最外面，而池里那棵树已经 `rename` 进去了。
  const root = tmp('slurmate-slot-');
  const bad = okRecord();
  bad.self = bad;
  const r = SLOT.writeRecordFile(path.join(root, 'r.json'), bad);
  assert.equal(r.ok, false);
  assert.match(r.detail, /序列化/);
  assert.deepEqual(fs.readdirSync(root), [], '失败时一个文件都不留');
});

test('★ 从解析出来的包建记录表：`files` 保序、`envelope` 逐字保留、**不存摘要**', () => {
  const files = [
    { path: 'z.txt', size: 3, sha256: sha('zzz') },
    { path: 'a.txt', size: 1, sha256: sha('a') },
  ];
  const parsed = { format: 1, files,
    sig: { alg: 1, pubkey: Buffer.alloc(32, 5), signature: Buffer.alloc(64, 6) } };
  const rec = SLOT.recordFromPackage(parsed);
  assert.deepEqual(rec.files.map((f) => f.path), ['z.txt', 'a.txt'],
    '★ **保留容器里的次序**，不重排 —— 照它重打包才是逐字节重现原件');
  assert.equal(rec.envelope.pubkey, Buffer.alloc(32, 5).toString('base64'));
  assert.equal(rec.envelope.signature, Buffer.alloc(64, 6).toString('base64'));
  assert.deepEqual(Object.keys(rec).sort(), ['envelope', 'files', 'format', 'schema']);
  assert.equal(rec.digest, undefined, '★ 摘要是派生值，**不存** —— 存了就会各说各话');

  // ★ 没有签名 ⇒ `envelope` 是 `null`（不是 `{}`、也不是少一个键）。
  assert.equal(SLOT.recordFromPackage({ format: 1, files, sig: null }).envelope, null);
});

test('★ 一个记录表最多多少字节：**推出来的**，不是挑出来的', () => {
  // ★ 记录表里每一份只带 path+size+sha256，而这三样在它来源的那个包的信封里逐字
  //   都有、还外加了内容本身 ⇒ 一张记录表永远比它来源的那个包小。
  const HARD = require('../src/main/site-plugins.js').HARD_LIMITS;
  assert.ok(SLOT.MAX_RECORD_BYTES >= HARD.package_bytes,
    '★ 一个合规的包能造出来的记录表，不许被这个闸拦下（那会变成"明明合规却装不上"）');
  assert.ok(SLOT.MAX_RECORD_BYTES <= 64 << 20, '★ 而它仍然要有意义 —— 别拿它当摆设');
});
