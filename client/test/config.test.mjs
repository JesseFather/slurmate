/**
 * config.test.mjs —— 配置、连接条目与主机密钥指纹。
 *
 * 重点是两条原则：
 *
 * 1. 「**绝不静默降级**」—— 安全存储不可用时，必须明确失败，而不是悄悄把私钥
 *    明文写盘。悄悄写明文正是这个项目一路在清的那类问题。私钥**只有加密一种存法**：
 *    界面上曾经那个「保存方式」下拉框已经删掉，因为让用户在安全和方便之间做选择，
 *    本身就意味着有人会选错。
 * 2. 「**不静默填空**」—— 不合法的连接条目一律拒绝并明确报错，
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
  assert.equal(cfg.schema, 3);
  assert.deepEqual(cfg.connections, []);
  assert.equal(cfg.activeConnectionId, null);
  assert.deepEqual(cfg.hostKeys, {});
  assert.deepEqual(cfg.slots, {});
  // 私钥没有「保存方式」这个设置项了 —— 它曾经存在过，删掉之后
  // 不该有任何一条旧配置能把它带回来
  assert.equal(cfg.secretMode, undefined);
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
  assert.equal(cfg.schema, 3);
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

// ── 相同条目检测 ────────────────────────────────────────────────────────────
//
// 症状：界面上不修改任何字段、连点「保存并连接」，列表里就多出一条一模一样的。
// 根因是身份被当成了 id（每存一次新生成一个），而真正的身份是 user@host:port。

test('★ 同一个地址反复保存，只应有一条', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  const input = { user: 'alice', host: '198.51.100.10', port: 10100 };

  const a = config.upsertConnection(cfg, input);
  assert.equal(a.created, true);
  const b = config.upsertConnection(cfg, input);   // 界面上的「保存并连接」再点一次
  const c = config.upsertConnection(cfg, input);   // 再点一次

  assert.equal(b.created, false, '第二次不该新增');
  assert.equal(c.created, false);
  assert.equal(cfg.connections.length, 1, '列表里必须只有一条');
  assert.equal(b.connection.id, a.connection.id, '必须复用同一个 id，不能每次换一个');
  assert.equal(c.connection.id, a.connection.id);
});

test('★ 端口不同就是两条连接（同一台主机的不同入口）', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  config.upsertConnection(cfg, { user: 'alice', host: '198.51.100.10', port: 10100 });
  const other = config.upsertConnection(cfg, { user: 'alice', host: '198.51.100.10', port: 22 });
  assert.equal(other.created, true);
  assert.equal(cfg.connections.length, 2);

  // 用户名不同同理 —— 同一台登录节点上换个人，是另一条连接
  config.upsertConnection(cfg, { user: 'bob', host: '198.51.100.10', port: 10100 });
  assert.equal(cfg.connections.length, 3);
});

test('★ 复用已有条目不得把用户写的备注冲掉', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  cfg.connections = [conn({ label: '内网' })];

  // 界面的表单里没有「备注」这一栏，传上来的 label 就是 host
  const up = config.upsertConnection(cfg, {
    user: 'alice', host: '198.51.100.10', port: 10100, label: '198.51.100.10',
  });
  assert.equal(up.created, false);
  assert.equal(up.connection.label, '内网', '拿 host 把备注冲掉是静默的信息丢失');
});

test('不合法的输入让 upsert 返回 null，而不是补个默认值存下去', () => {
  const cfg = config.loadConfig(tmpdir());
  assert.equal(config.upsertConnection(cfg, { user: '', host: 'h', port: 22 }), null);
  assert.equal(config.upsertConnection(cfg, { user: 'u', host: 'h', port: 0 }), null);
  assert.equal(cfg.connections.length, 0);
});

test('★ 升级时顺手清掉旧版本攒下的一串相同条目', () => {
  const dir = tmpdir();
  // 旧版本每次点「保存并连接」都会新建一条，配置里已经攒了三条一样的
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema: 2,
    connections: [
      { id: 'c1', user: 'alice', host: '198.51.100.10', port: 10100 },
      { id: 'c2', user: 'alice', host: '198.51.100.10', port: 10100 },
      { id: 'c3', user: 'alice', host: '198.51.100.10', port: 10100 },
    ],
    activeConnectionId: 'c2',
  }));

  const cfg = config.loadConfig(dir);
  assert.equal(cfg.connections.length, 1, '读的时候就要合并，否则用户升级完看到的还是那一堆');
  assert.equal(cfg.connections[0].id, 'c1', '保留先出现的那条');
  assert.equal(cfg.activeConnectionId, 'c1',
    '活动连接指向被合并掉的那条时，必须跟着挪到留下的那条，不能悬空');
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

test('★ 机器没有安全存储 → 明确失败，且绝不写明文', () => {
  const dir = tmpdir();
  const res = config.setSecret(dir, null, 'PRIVATE-KEY-PEM');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_secure_storage');

  // 关键：一个字节都不该落盘。以前这里还有一条「明文保存」的退路，
  // 现在没有 —— 存不了就是存不了，由界面如实告诉用户，而不是换个方式偷偷存下来。
  assert.equal(fs.existsSync(path.join(dir, 'secrets.json')), false,
    '安全存储不可用时绝不能悄悄写明文');
});

test('加密保存：有安全存储时正常往返', () => {
  const dir = tmpdir();
  const c = fakeCrypto();
  assert.deepEqual(config.setSecret(dir, c, 'PRIVATE-KEY-PEM'),
    { ok: true, mode: 'encrypted' });

  const f = path.join(dir, 'secrets.json');
  assert.equal(mode(f), 0o600, '凭据文件必须是 0600');
  assert.equal(fs.readFileSync(f, 'utf8').includes('PRIVATE-KEY-PEM'), false, '落盘的必须是密文');

  const got = config.getSecret(dir, c);
  assert.equal(got.ok, true);
  assert.equal(got.value, 'PRIVATE-KEY-PEM');
  assert.equal(got.mode, 'encrypted');
  assert.equal(got.legacy, undefined, '新写下去的不是 legacy');
});

test('换过机器 / keyring 被重置：解密失败要明确报错，不能当成空值', () => {
  const dir = tmpdir();
  config.setSecret(dir, fakeCrypto(), 'PRIVATE-KEY-PEM');

  const other = { encrypt: () => Buffer.from('x'), decrypt: () => { throw new Error('bad key'); } };
  const got = config.getSecret(dir, other);
  assert.equal(got.ok, false);
  assert.match(got.reason, /decrypt_failed/);

  // 连安全存储都没有了
  assert.equal(config.getSecret(dir, null).reason, 'no_secure_storage');
});

test('★ 旧版本留下的明文私钥必须读得出来，并标记成 legacy', () => {
  const dir = tmpdir();
  // schema 2 及更早允许用户选「明文保存」，磁盘上可能就留着这么一份
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({
    schema: 2, mode: 'plain', data: 'PRIVATE-KEY-PEM',
  }));

  const got = config.getSecret(dir, fakeCrypto());
  assert.equal(got.ok, true, '读不出来会让用户以为密钥丢了，跑去重新生成、重新注册');
  assert.equal(got.value, 'PRIVATE-KEY-PEM');
  assert.equal(got.legacy, true, 'legacy:true 是在告诉调用方「有条件就加密重存一遍」');

  // 调用方看到 legacy 后加密重存一遍，明文就没了
  const f = path.join(dir, 'secrets.json');
  assert.equal(fs.readFileSync(f, 'utf8').includes('"mode":"plain"'), true, '前置条件');
  assert.equal(config.setSecret(dir, fakeCrypto(), got.value).ok, true);
  assert.equal(fs.readFileSync(f, 'utf8').includes('"mode":"plain"'), false,
    '重存之后不该还是明文');
  assert.equal(fs.readFileSync(f, 'utf8').includes('PRIVATE-KEY-PEM'), false, '落盘的必须是密文');
  assert.equal(config.getSecret(dir, fakeCrypto()).legacy, undefined);

  // 而没有凭据库的机器上，重存这一步会失败 —— 那就只能维持原样，
  // 由界面把它当作「明文存放」如实告知，而不是假装加密了
  assert.equal(config.setSecret(dir, null, 'x').reason, 'no_secure_storage');
});

test('认不出的 mode 明确报错，不当成空值', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({
    schema: 9, mode: 'whatever', data: 'x',
  }));
  assert.match(config.getSecret(dir, fakeCrypto()).reason, /bad_mode/);
});

test('没存过凭据时 getSecret 明确返回 not_saved', () => {
  assert.equal(config.getSecret(tmpdir(), fakeCrypto()).reason, 'not_saved');
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
