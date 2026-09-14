/**
 * config.test.mjs —— 配置、连接条目与主机密钥指纹。
 *
 * 重点是两条原则：
 *
 * 1. 「**绝不静默降级**」—— 安全存储不可用时，必须明确失败并让界面去问用户，
 *    而不是悄悄把私钥明文写盘。悄悄写明文正是这个项目一路在清的那类问题。
 * 2. 「**不静默填空**」—— 不合法的连接条目、未知的保存模式，一律拒绝并明确报错，
 *    而不是回落成某个默认值让用户以为设置生效了。
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

const conn = (over = {}) => ({
  id: 'c1', label: '内网', user: 'alice', host: '198.51.100.10', port: 10100, ...over,
});

// ── 基本 ────────────────────────────────────────────────────────────────────

test('空目录加载出默认配置', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  assert.equal(cfg.schema, 2);
  assert.deepEqual(cfg.connections, []);
  assert.equal(cfg.activeConnectionId, null);
  assert.deepEqual(cfg.hostKeys, {});
  assert.deepEqual(cfg.slots, {});
  assert.equal(cfg.secretMode, 'ask');
});

test('配置读写往返', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  cfg.connections = [conn()];
  cfg.activeConnectionId = 'c1';
  config.saveConfig(dir, cfg);

  const back = config.loadConfig(dir);
  assert.equal(back.connections.length, 1);
  assert.equal(back.connections[0].user, 'alice');
  assert.equal(back.connections[0].port, 10100);
  assert.equal(back.activeConnectionId, 'c1');
  assert.equal(mode(path.join(dir, 'config.json')), 0o600, '配置文件必须是 0600');
});

test('损坏的配置文件回落到默认值而不是崩溃', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ 这不是 JSON');
  const cfg = config.loadConfig(dir);
  assert.equal(cfg.schema, 2);
  assert.deepEqual(cfg.connections, []);
});

// ── 连接条目 ────────────────────────────────────────────────────────────────

test('不合法的连接条目被剔除，而不是补默认值', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  cfg.connections = [
    conn(),
    conn({ id: 'c2', user: '' }),          // 缺用户名
    conn({ id: 'c3', host: '' }),          // 缺主机
    conn({ id: 'c4', port: 0 }),           // 端口越界
    conn({ id: 'c5', port: 70000 }),       // 端口越界
    conn({ id: 'c6', port: 'abc' }),       // 端口非数字
    null,
  ];
  config.saveConfig(dir, cfg);

  const back = config.loadConfig(dir);
  assert.equal(back.connections.length, 1, '只应留下合法的那一条');
  assert.equal(back.connections[0].id, 'c1');
});

test('label 缺省回落到 host', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  cfg.connections = [conn({ label: '   ' })];
  config.saveConfig(dir, cfg);
  assert.equal(config.loadConfig(dir).connections[0].label, '198.51.100.10');
});

test('activeConnectionId 指向不存在的条目时，回落到第一条', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  cfg.connections = [conn(), conn({ id: 'c2' })];
  cfg.activeConnectionId = 'nope';
  config.saveConfig(dir, cfg);

  const back = config.loadConfig(dir);
  assert.equal(back.activeConnectionId, 'c1', '悬空的 active 必须被修正，不能留 null 让人去猜');
  assert.equal(config.activeConnection(back).id, 'c1');
});

test('没有任何连接时 activeConnection 返回 null（真实状态，不编造）', () => {
  const cfg = config.loadConfig(tmpdir());
  assert.equal(config.activeConnection(cfg), null);
});

test('duplicate id 被去掉，保留先出现的', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  cfg.connections = [conn({ label: '甲' }), conn({ label: '乙' })];
  config.saveConfig(dir, cfg);
  const back = config.loadConfig(dir);
  assert.equal(back.connections.length, 1);
  assert.equal(back.connections[0].label, '甲');
});

test('★ 旧格式（schema 1 的 profile + extraHosts）迁移成连接列表', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema: 1,
    profile: { user: 'alice', host: '198.51.100.10', port: 10100 },
    extraHosts: [{ host: '203.0.113.7', port: 10100, label: '公网' }],
    passwordMode: 'encrypted',
    maxSessions: 1,
  }));

  const cfg = config.loadConfig(dir);
  assert.equal(cfg.connections.length, 2, 'profile 与 extraHosts 都要迁进来');
  assert.equal(cfg.connections[0].host, '198.51.100.10');
  assert.equal(cfg.connections[1].label, '公网');
  assert.equal(cfg.activeConnectionId, cfg.connections[0].id);
  // 旧字段不再出现在新配置里
  assert.equal(cfg.profile, undefined);
  assert.equal(cfg.maxSessions, undefined);
});

// ── 主机密钥指纹 ─────────────────────────────────────────────────────────────

test('主机密钥：首次为 new，记住后为 known', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  assert.equal(config.checkHostKey(cfg, '198.51.100.10', 10100, 'SHA256:aaa').status, 'new');

  config.rememberHostKey(dir, cfg, '198.51.100.10', 10100, 'SHA256:aaa');
  const back = config.loadConfig(dir);
  assert.equal(config.checkHostKey(back, '198.51.100.10', 10100, 'SHA256:aaa').status, 'known');
  assert.equal(mode(path.join(dir, 'config.json')), 0o600);
});

test('★ 主机密钥变了必须是 changed 并带上原指纹，不是当成新主机', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  config.rememberHostKey(dir, cfg, 'h', 22, 'SHA256:old');
  const back = config.loadConfig(dir);

  const res = config.checkHostKey(back, 'h', 22, 'SHA256:new');
  assert.equal(res.status, 'changed');
  assert.equal(res.expected, 'SHA256:old', '要把原指纹给出来，用户才能判断是重装还是中间人');
});

test('主机密钥按 host:port 分开记账（同主机不同端口互不影响）', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  config.rememberHostKey(dir, cfg, 'h', 22, 'SHA256:a');
  config.rememberHostKey(dir, cfg, 'h', 10100, 'SHA256:b');
  const back = config.loadConfig(dir);
  assert.equal(config.checkHostKey(back, 'h', 22, 'SHA256:a').status, 'known');
  assert.equal(config.checkHostKey(back, 'h', 10100, 'SHA256:b').status, 'known');
  assert.equal(config.checkHostKey(back, 'h', 2222, 'SHA256:a').status, 'new');
});

test('忘记主机密钥后回到 new', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  config.rememberHostKey(dir, cfg, 'h', 22, 'SHA256:a');
  config.forgetHostKey(dir, cfg, 'h', 22);
  assert.equal(config.checkHostKey(config.loadConfig(dir), 'h', 22, 'SHA256:a').status, 'new');
});

// ── 槽位端口 ────────────────────────────────────────────────────────────────

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

// ── 凭据（SSH 私钥）─────────────────────────────────────────────────────────

test('★ 加密保存但机器没有安全存储 → 明确失败，且绝不写明文', () => {
  const dir = tmpdir();
  const res = config.setSecret(dir, null, 'encrypted', 'PRIVATE-KEY-PEM');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_secure_storage');

  // 关键：一个字节都不该落盘
  assert.equal(fs.existsSync(path.join(dir, 'secrets.json')), false,
    '安全存储不可用时绝不能悄悄写明文');
});

test('加密保存：有安全存储时正常往返', () => {
  const dir = tmpdir();
  const c = fakeCrypto();
  assert.deepEqual(config.setSecret(dir, c, 'encrypted', 'PRIVATE-KEY-PEM'),
    { ok: true, mode: 'encrypted' });

  const f = path.join(dir, 'secrets.json');
  assert.equal(mode(f), 0o600, '凭据文件必须是 0600');
  assert.equal(fs.readFileSync(f, 'utf8').includes('PRIVATE-KEY-PEM'), false, '落盘的必须是密文');

  const got = config.getSecret(dir, c);
  assert.equal(got.ok, true);
  assert.equal(got.value, 'PRIVATE-KEY-PEM');
  assert.equal(got.mode, 'encrypted');
});

test('换过机器 / keyring 被重置：解密失败要明确报错，不能当成空值', () => {
  const dir = tmpdir();
  config.setSecret(dir, fakeCrypto(), 'encrypted', 'PRIVATE-KEY-PEM');

  const other = { encrypt: () => Buffer.from('x'), decrypt: () => { throw new Error('bad key'); } };
  const got = config.getSecret(dir, other);
  assert.equal(got.ok, false);
  assert.match(got.reason, /decrypt_failed/);

  // 连安全存储都没有了
  assert.equal(config.getSecret(dir, null).reason, 'no_secure_storage');
});

test('明文保存：只在用户明确选择后才落盘，且仍是 0600', () => {
  const dir = tmpdir();
  assert.deepEqual(config.setSecret(dir, null, 'plain', 'PRIVATE-KEY-PEM'),
    { ok: true, mode: 'plain' });
  const f = path.join(dir, 'secrets.json');
  assert.equal(mode(f), 0o600);
  assert.equal(config.getSecret(dir, null).value, 'PRIVATE-KEY-PEM');
});

test('不保存：清掉旧文件', () => {
  const dir = tmpdir();
  config.setSecret(dir, fakeCrypto(), 'encrypted', 'PRIVATE-KEY-PEM');
  assert.equal(fs.existsSync(path.join(dir, 'secrets.json')), true);
  config.setSecret(dir, fakeCrypto(), 'none', '');
  assert.equal(fs.existsSync(path.join(dir, 'secrets.json')), false);
  assert.equal(config.getSecret(dir, fakeCrypto()).reason, 'not_saved');
});

test('没存过凭据时 getSecret 明确返回 not_saved', () => {
  assert.equal(config.getSecret(tmpdir(), fakeCrypto()).reason, 'not_saved');
});

test('未知的保存模式被拒绝，而不是当成默认值', () => {
  const res = config.setSecret(tmpdir(), fakeCrypto(), 'whatever', 'x');
  assert.equal(res.ok, false);
  assert.match(res.reason, /bad_mode/);
});

// ── 其余 ────────────────────────────────────────────────────────────────────

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
