/**
 * config.test.mjs —— 配置与凭据。
 *
 * 重点是「**绝不静默降级**」这条原则：安全存储不可用时，必须明确失败并让界面
 * 去问用户，而不是悄悄把口令明文写盘。悄悄写明文正是这个项目一路在清的那类问题。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const config = require('../src/main/config.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-cfg-'));
}

/** 假的 safeStorage。真实现只在 Electron 里存在，测试不该依赖它。 */
function fakeCrypto() {
  return {
    encrypt: (s) => Buffer.from('ENC:' + s, 'utf8'),
    decrypt: (b) => b.toString('utf8').replace(/^ENC:/, ''),
  };
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

test('空目录加载出默认配置', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  assert.equal(cfg.schema, 1);
  assert.equal(cfg.maxSessions, 1);
  assert.equal(cfg.passwordMode, 'ask');
  assert.deepEqual(cfg.slots, {});
});

test('配置读写往返', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  cfg.profile = { user: 'alice', host: '198.51.100.10', port: 10100 };
  config.saveConfig(dir, cfg);

  const back = config.loadConfig(dir);
  assert.equal(back.profile.user, 'alice');
  assert.equal(back.profile.port, 10100);
  assert.equal(mode(path.join(dir, 'config.json')), 0o600, '配置文件必须是 0600');
});

test('损坏的配置文件回落到默认值而不是崩溃', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ 这不是 JSON');
  const cfg = config.loadConfig(dir);
  assert.equal(cfg.schema, 1);
});

test('槽位端口：默认值 + 持久化', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  assert.equal(config.slotPort(cfg, 1), 18080);
  assert.equal(config.slotPort(cfg, 2), 18081);

  // 端口被占而换过之后，**必须记住** —— 否则每次重算，origin 就变，
  // code-server 存在 localStorage 里的编辑器布局会反复重置。
  config.setSlotPort(dir, cfg, 1, 18093);
  const back = config.loadConfig(dir);
  assert.equal(config.slotPort(back, 1), 18093, '换过的端口必须记住');
  assert.equal(config.slotPort(back, 2), 18081, '其他槽位不受影响');
});

test('槽位端口：越界值不采信，回落默认', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  cfg.slots = { 1: { port: 80 }, 2: { port: 99999 }, 3: { port: 'x' } };
  assert.equal(config.slotPort(cfg, 1), 18080, '特权端口不采信');
  assert.equal(config.slotPort(cfg, 2), 18081, '越界端口不采信');
  assert.equal(config.slotPort(cfg, 3), 18082, '非数字不采信');
});

test('★ 加密保存但机器没有安全存储 → 明确失败，且绝不写明文', () => {
  const dir = tmpdir();
  const res = config.setPassword(dir, null, 'encrypted', 'hunter2');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_secure_storage');

  // 关键：一个字节都不该落盘
  assert.equal(fs.existsSync(path.join(dir, 'secrets.json')), false,
    '安全存储不可用时绝不能悄悄写明文');
});

test('加密保存：有安全存储时正常往返', () => {
  const dir = tmpdir();
  const c = fakeCrypto();
  assert.deepEqual(config.setPassword(dir, c, 'encrypted', 'hunter2'), { ok: true, mode: 'encrypted' });

  const f = path.join(dir, 'secrets.json');
  assert.equal(mode(f), 0o600, '凭据文件必须是 0600');
  assert.equal(fs.readFileSync(f, 'utf8').includes('hunter2'), false, '落盘的必须是密文');

  const got = config.getPassword(dir, c);
  assert.equal(got.ok, true);
  assert.equal(got.password, 'hunter2');
  assert.equal(got.mode, 'encrypted');
});

test('换过机器 / keyring 被重置：解密失败要明确报错，不能当成空口令', () => {
  const dir = tmpdir();
  config.setPassword(dir, fakeCrypto(), 'encrypted', 'hunter2');

  const other = { encrypt: () => Buffer.from('x'), decrypt: () => { throw new Error('bad key'); } };
  const got = config.getPassword(dir, other);
  assert.equal(got.ok, false);
  assert.match(got.reason, /decrypt_failed/);

  // 连安全存储都没有了
  assert.equal(config.getPassword(dir, null).reason, 'no_secure_storage');
});

test('明文保存：只在用户明确选择后才落盘，且仍是 0600', () => {
  const dir = tmpdir();
  assert.deepEqual(config.setPassword(dir, null, 'plain', 'hunter2'), { ok: true, mode: 'plain' });
  const f = path.join(dir, 'secrets.json');
  assert.equal(mode(f), 0o600);
  assert.equal(config.getPassword(dir, null).password, 'hunter2');
});

test('不保存：清掉旧文件', () => {
  const dir = tmpdir();
  config.setPassword(dir, fakeCrypto(), 'encrypted', 'hunter2');
  assert.equal(fs.existsSync(path.join(dir, 'secrets.json')), true);
  config.setPassword(dir, fakeCrypto(), 'none', '');
  assert.equal(fs.existsSync(path.join(dir, 'secrets.json')), false);
  assert.equal(config.getPassword(dir, fakeCrypto()).reason, 'not_saved');
});

test('没存过口令时 getPassword 明确返回 not_saved', () => {
  assert.equal(config.getPassword(tmpdir(), fakeCrypto()).reason, 'not_saved');
});

test('未知的保存模式被拒绝，而不是当成默认值', () => {
  const res = config.setPassword(tmpdir(), fakeCrypto(), 'whatever', 'x');
  assert.equal(res.ok, false);
  assert.match(res.reason, /bad_mode/);
});

test('待补发的 goodbye：增删查', () => {
  const dir = tmpdir();
  assert.deepEqual(config.listPendingGoodbye(dir), []);

  config.addPendingGoodbye(dir, 'abc123');
  config.addPendingGoodbye(dir, 'def456');
  config.addPendingGoodbye(dir, 'abc123');       // 重复添加应当去重

  const list = config.listPendingGoodbye(dir);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((x) => x.session_id).sort(), ['abc123', 'def456']);
  assert.ok(list.every((x) => typeof x.at === 'number'));

  config.removePendingGoodbye(dir, 'abc123');
  assert.deepEqual(config.listPendingGoodbye(dir).map((x) => x.session_id), ['def456']);

  config.removePendingGoodbye(dir, 'def456');
  assert.equal(fs.existsSync(path.join(dir, 'pending-goodbye.json')), false,
    '清空后文件应当被删掉，而不是留一个空数组');
});

test('原子写：写入过程中不会留下半截文件', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  config.saveConfig(dir, cfg);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
  assert.deepEqual(leftovers, [], '不应当留下临时文件');
});
