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
 * 3. 「**密钥属于连接，不属于客户端**」—— 一把钥匙作废只该影响它那一条连接。
 *    见下面「凭据」那一节。
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
  assert.equal(cfg.schema, 6);
  assert.deepEqual(cfg.connections, []);
  assert.equal(cfg.activeConnectionId, null);
  assert.deepEqual(cfg.hostKeys, {});
  assert.deepEqual(cfg.layouts, []);
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
  assert.equal(cfg.schema, 6);
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

test('★ 备注留空就是「没起名」，不是回落成 host', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  cfg.connections = [conn({ label: '   ' })];
  config.saveConfig(dir, cfg);
  // 回落成 host 会让「没起名」和「名字就叫这个地址」无法区分，
  // 而界面要按这个区分决定显示备注还是显示地址。
  assert.equal(config.loadConfig(dir).connections[0].label, '');

  // 旧版本写下的 label 恰好等于 host 的那些，读进来也归成「没起名」
  const dir2 = tmpdir();
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({
    schema: 3,
    connections: [{ id: 'c1', user: 'alice', host: '198.51.100.10', port: 10100,
                    label: '198.51.100.10' }],
    activeConnectionId: 'c1',
  }));
  assert.equal(config.loadConfig(dir2).connections[0].label, '');
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

test('★ 按地址判重时，空备注不得把已有备注冲掉', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  cfg.connections = [conn({ label: '内网' })];

  // 新建那条路径上，空备注只表示「这次没起名」
  const up = config.upsertConnection(cfg, {
    user: 'alice', host: '198.51.100.10', port: 10100,
  });
  assert.equal(up.created, false);
  assert.equal(up.connection.label, '内网', '拿空备注把已有的名字冲掉是静默的信息丢失');

  // 填了备注就写进去
  const named = config.upsertConnection(cfg, {
    user: 'alice', host: '198.51.100.10', port: 10100, label: '公网入口',
  });
  assert.equal(named.connection.label, '公网入口');
});

test('★ 编辑时备注可以清空 —— 那一栏就是当前值', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  const a = config.upsertConnection(cfg, {
    user: 'alice', host: '198.51.100.10', port: 10100, label: '内网',
  });
  // 编辑走的是 id 那条路：表单里那一栏被清空了，就得真的清掉。
  // 不分这两条路径的话，「清空备注」这个动作会永远无效，而用户看不出为什么。
  const cleared = config.upsertConnection(cfg, {
    id: a.connection.id, user: 'alice', host: '198.51.100.10', port: 10100, label: '',
  });
  assert.equal(cleared.connection.label, '');
});

test('不合法的输入让 upsert 返回 null，而不是补个默认值存下去', () => {
  const cfg = config.loadConfig(tmpdir());
  assert.equal(config.upsertConnection(cfg, { user: '', host: 'h', port: 22 }), null);
  assert.equal(config.upsertConnection(cfg, { user: 'u', host: 'h', port: 0 }), null);
  assert.equal(cfg.connections.length, 0);
});

test('★ 编辑时把地址改成另一条已有的，必须拒绝而不是留下两条同身份的', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  const a = config.upsertConnection(cfg, { user: 'alice', host: '198.51.100.10', port: 10100 });
  const b = config.upsertConnection(cfg, { user: 'alice', host: '203.0.113.7', port: 10100 });
  assert.equal(b.created, true);

  // 用户打开 a 的编辑框，把地址改成 b 的地址
  const clash = config.upsertConnection(cfg, {
    id: a.connection.id, user: 'alice', host: '203.0.113.7', port: 10100,
  });
  assert.ok(clash.conflict, '必须报冲突，而不是默默改下去');
  assert.equal(clash.conflict.id, b.connection.id, '要指出撞上的是哪一条');

  // 两条都原样不动 —— 尤其是 b 的密钥不能被 a 顶掉
  assert.equal(cfg.connections.length, 2);
  assert.equal(cfg.connections.find((c) => c.id === a.connection.id).host, '198.51.100.10',
    '冲突时不该把 a 改掉');
});

test('★ 编辑时不改地址（只改别处）不该被自己的身份判成冲突', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  const a = config.upsertConnection(cfg, { user: 'alice', host: '198.51.100.10', port: 10100 });
  const up = config.upsertConnection(cfg, {
    id: a.connection.id, user: 'alice', host: '198.51.100.10', port: 10100,
  });
  assert.equal(up.conflict, undefined);
  assert.equal(up.created, false);
  assert.equal(cfg.connections.length, 1);
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

// ── 布局组 ──────────────────────────────────────────────────────────────────
//
// 一个组 = 一个本地端口 = 一个 origin = 一份 code-server 的编辑器布局。

/** 写一份 schema 4 的旧配置（有 slots、没有 layouts）。 */
function legacyDir(slots = { 1: { port: 18093 } }) {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema: 4,
    connections: [
      { id: 'c1', label: '内网', user: 'alice', host: '198.51.100.10', port: 10100 },
      { id: 'c2', label: '公网', user: 'alice', host: '203.0.113.7', port: 10100 },
    ],
    activeConnectionId: 'c1',
    slots,
  }));
  return dir;
}

test('布局组：端口持久化，换过之后必须记住', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  assert.deepEqual(cfg.layouts, [], '一条连接都没有时不该有布局组');

  // 端口变了 origin 就变，编辑器布局会全部重置 —— 所以必须记住，不是每次重算。
  cfg.layouts = [{ id: 'l1', name: '布局 1', port: 18080 }];
  config.setLayoutPort(dir, cfg, 'l1', 18093);
  assert.equal(config.layoutPort(config.loadConfig(dir), 'l1'), 18093);
});

test('布局组：端口越界就整条不合法，不补默认值', () => {
  // 与连接条目同规矩。补一个默认端口会让用户以为这个组还能用，
  // 而它其实指向一份永远不会被打开的存储。
  assert.equal(config.normalizeLayout({ id: 'a', port: 80 }), null, '特权端口');
  assert.equal(config.normalizeLayout({ id: 'b', port: 99999 }), null, '越界端口');
  assert.equal(config.normalizeLayout({ id: 'c', port: 'x' }), null, '非数字');
  assert.equal(config.normalizeLayout(null), null);
  assert.equal(config.normalizeLayout({ id: 'd', port: 18080 }).port, 18080);
});

test('★ 升级：旧的 slots 迁移成**一个**组，所有连接都指着它', () => {
  const cfg = config.loadConfig(legacyDir());

  assert.equal(cfg.layouts.length, 1, 'schema ≤ 4 只可能有一个槽位');
  assert.equal(cfg.connections.length, 2);
  for (const c of cfg.connections) {
    assert.equal(c.layoutId, cfg.layouts[0].id, `${c.id} 必须落在那一个组里`);
  }
  // 旧字段自然消失（只认已知键，不写回）。留着它，将来读这份配置的人
  // 会以为它还有用，去代码里找一个早就不存在的行为。
  assert.equal(cfg.slots, undefined);
  assert.equal(cfg.schema, 6);
});

/** 丢掉模块缓存再 require 一次 —— 模拟「重启客户端」。 */
function reloadConfigModule() {
  const p = require.resolve('../src/main/config.js');
  delete require.cache[p];
  const m = require('../src/main/config.js');
  delete require.cache[p];          // 别把重载后的那一份留给后面的测试用
  return m;
}

test('★ 升级必须**确定性**：重启客户端后组 id 必须还是同一个', () => {
  const dir = legacyDir();
  const first = config.loadConfig(dir).layouts[0].id;

  // ★ 必须**真的重新加载模块**，否则这条测试什么也测不到。
  //   同一进程里读两次当然一样 —— 而真正的失败模式在重启之后：loadConfig 自己
  //   不写盘，所以「读完配置、一次都没保存就退出」再打开时，若 id 是当场随机
  //   合成的，就会换一个 id；而 id 决定 partition，也就是决定布局存在哪。
  //   于是一份刚攒下的布局凭空消失，且没有任何报错。
  //   （这条测试第一版就是同一进程读两次，变异测试证明它抓不到这个 bug。）
  const afterRestart = reloadConfigModule().loadConfig(dir);
  assert.equal(afterRestart.layouts[0].id, first, '组 id 必须与「第几次启动」无关');
});

test('★ 升级不丢布局：迁移出来的组沿用旧端口与旧的 partition 名', () => {
  const cfg = config.loadConfig(legacyDir({ 1: { port: 18093 } }));
  const L = cfg.layouts[0];

  // 这两条缺任何一条，老用户的编辑器布局就会重置一次：
  //   · 端口是 origin 的一半（http://127.0.0.1:<端口>）
  //   · partition 名是存储目录名
  assert.equal(L.port, 18093, '端口必须原样继承，不能回落 18080');
  assert.equal(config.partitionForLayout(L.id), 'persist:slot-1',
    '迁移出来的组必须沿用旧的 partition 名，改名等于把布局扔掉一次');

  // 而**新建**的组必须是另一套名字 —— 否则「新建空白布局」会继承旧组的存储。
  const fresh = config.newLayoutId();
  assert.match(fresh, /^l[0-9a-f]{12}$/);
  assert.notEqual(config.partitionForLayout(fresh), 'persist:slot-1');
  assert.equal(config.partitionForLayout(fresh), 'persist:layout-' + fresh);
});

test('回收：只删引用计数为 0 的组，并报出删了哪些', () => {
  const cfg = config.loadConfig(tmpdir());
  cfg.layouts = [
    { id: 'la', name: 'A', port: 18080 },
    { id: 'lb', name: 'B', port: 18081 },
    { id: 'lc', name: 'C', port: 18082 },
  ];
  cfg.connections = [
    { id: 'c1', user: 'a', host: 'h', port: 1, layoutId: 'la' },
    { id: 'c2', user: 'b', host: 'h', port: 1, layoutId: 'lb' },
    { id: 'c3', user: 'c', host: 'h', port: 1, layoutId: 'la' },
  ];

  const r = config.pruneLayouts(cfg);
  assert.deepEqual(r.removed, ['lc'], '只有 0 引用的那个该被删');
  assert.deepEqual(cfg.layouts.map((l) => l.id), ['la', 'lb'], '顺序必须保持');
});

test('回收：一条连接都没有时**不**回收 —— 演示模式的那个组必须活下来', () => {
  const cfg = config.loadConfig(tmpdir());
  cfg.layouts = [{ id: 'ldemo', name: '演示布局', port: 18080 }];
  cfg.connections = [];

  // 演示模式一个连接都没有，而它照样要开会话 —— 那个组是那次会话的布局身份。
  // 在这里把它回收掉，下次开会话又会造一个新的，id 一变 partition 就变，
  // 布局白重置一次，而用户看到的是「演示模式里布局老是丢」。
  const r = config.pruneLayouts(cfg);
  assert.deepEqual(r.removed, [], '没有映射关系要维护时，回收无事可做');
  assert.deepEqual(cfg.layouts.map((l) => l.id), ['ldemo']);
});

test('layoutPlan：把「这个组只被谁用」推导出来，renderer 不自己算', () => {
  const cfg = config.loadConfig(tmpdir());
  cfg.layouts = [
    { id: 'la', name: '公用', port: 18080 },
    { id: 'lb', name: '独占', port: 18081 },
  ];
  cfg.connections = [
    { id: 'c1', user: 'a', host: 'h', port: 1, layoutId: 'la' },
    { id: 'c2', user: 'b', host: 'h', port: 1, layoutId: 'la' },
    { id: 'c3', user: 'c', host: 'h', port: 1, layoutId: 'lb' },
  ];

  const plan = config.layoutPlan(cfg);
  assert.equal(plan[0].refCount, 2);
  assert.deepEqual(plan[0].members, ['c1', 'c2']);
  assert.equal(plan[0].soleOwnerId, null, '被两条连接用着，谁切走都不该删');
  assert.equal(plan[1].refCount, 1);
  assert.deepEqual(plan[1].members, ['c3']);
  // 界面据此在下拉里标注「只有这一条连接在用 —— 切走就会被丢弃」，
  // 并由主进程在真正切走时要求二次确认。
  assert.equal(plan[1].soleOwnerId, 'c3');
});

test('端口分配：从 18080 起，跳过已被占用的', () => {
  const cfg = config.loadConfig(tmpdir());
  assert.equal(config.nextLayoutPort(cfg), 18080, '空配置从基址开始');

  cfg.layouts = [
    { id: 'la', name: 'A', port: 18080 },
    { id: 'lb', name: 'B', port: 18081 },
    { id: 'lc', name: 'C', port: 18083 },
  ];
  assert.equal(config.nextLayoutPort(cfg), 18082, '必须填中间的空洞');
  // usedLayoutPorts 要能用 exceptId 把自己摘出去 —— 端口的顺移靠它，
  // 不摘的话目标组自己的端口会被当成「别人的」而永远绑不上。
  assert.deepEqual([...config.usedLayoutPorts(cfg, 'lb')].sort(), [18080, 18083]);
});

test('★ 往返：保存再读，布局组与连接指向都不能丢', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  cfg.layouts = [{ id: 'lxyz', name: '生产集群', port: 18091 }];
  cfg.connections = [
    { id: 'c1', label: '', user: 'alice', host: '198.51.100.10', port: 10100, layoutId: 'lxyz' },
  ];
  config.saveConfig(dir, cfg);

  // loadConfig 只认白名单键。漏搬一个键的后果不是「少个字段」——
  // 是每次启动都丢掉全部布局组，所有连接塌回一个默认组，
  // 而用户看到的只是「我配的映射关系没了」。
  const back = config.loadConfig(dir);
  assert.deepEqual(back.layouts, [{ id: 'lxyz', name: '生产集群', port: 18091 }]);
  assert.equal(back.connections[0].layoutId, 'lxyz');
  assert.equal(back.slots, undefined);
});

test('指向不存在的组时收束到第一个组，而不是留个悬空引用', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema: 5,
    layouts: [{ id: 'la', name: 'A', port: 18080 }],
    connections: [{ id: 'c1', user: 'a', host: '198.51.100.10', port: 10100, layoutId: '不存在' }],
    activeConnectionId: 'c1',
  }));
  const cfg = config.loadConfig(dir);
  // 悬空引用在界面上表现为「这条连接不属于任何布局」，而用户看不出为什么。
  assert.equal(cfg.connections[0].layoutId, 'la');
});

// ── 凭据（SSH 私钥）：**每条连接一把** ──────────────────────────────────────
//
// 因为公钥是注册在**某个账户**上的，而一条连接就是「哪个账户、哪台机器、哪个端口」。
// 按连接存，才能做到「重新生成一把钥匙只作废那一条连接」，而不是把整个客户端打断。

const secretsOf = (dir) => path.join(dir, 'secrets.json');
/** 造一份「加密后的数据」该长的样子（fakeCrypto 的密文 = 'ENC:' + 明文）。 */
const encrypted = (s) => fakeCrypto().encrypt(s).toString('base64');

test('★ 机器没有安全存储 → 明确失败，且绝不写明文', () => {
  const dir = tmpdir();
  const res = config.setKey(dir, null, 'c1', 'PRIVATE-KEY-PEM');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_secure_storage');

  // 关键：一个字节都不该落盘。以前这里还有一条「明文保存」的退路，
  // 现在没有 —— 存不了就是存不了，由界面如实告诉用户，而不是换个方式偷偷存下来。
  assert.equal(fs.existsSync(secretsOf(dir)), false,
    '安全存储不可用时绝不能悄悄写明文');
});

test('加密保存：有安全存储时正常往返', () => {
  const dir = tmpdir();
  const c = fakeCrypto();
  assert.deepEqual(config.setKey(dir, c, 'c1', 'PRIVATE-KEY-PEM'),
    { ok: true, mode: 'encrypted' });

  assert.equal(mode(secretsOf(dir)), 0o600, '凭据文件必须是 0600');
  assert.equal(fs.readFileSync(secretsOf(dir), 'utf8').includes('PRIVATE-KEY-PEM'), false,
    '落盘的必须是密文');

  const got = config.getKey(dir, c, 'c1');
  assert.equal(got.ok, true);
  assert.equal(got.value, 'PRIVATE-KEY-PEM');
  assert.equal(got.mode, 'encrypted');
  assert.equal(got.legacy, undefined, '新写下去的不是 legacy');
});

test('★ 密钥按连接隔离：各是各的，删一条不动另一条', () => {
  const dir = tmpdir();
  const c = fakeCrypto();
  config.setKey(dir, c, 'c1', 'PEM-C1');
  config.setKey(dir, c, 'c2', 'PEM-C2');

  assert.equal(config.getKey(dir, c, 'c1').value, 'PEM-C1');
  assert.equal(config.getKey(dir, c, 'c2').value, 'PEM-C2');

  config.deleteKey(dir, 'c1');
  assert.equal(config.getKey(dir, c, 'c1').reason, 'not_saved');
  assert.equal(config.getKey(dir, c, 'c2').value, 'PEM-C2',
    '删掉一条连接不该动到另一条的密钥');

  // 删空之后文件本身也消失，不留一个空壳
  config.deleteKey(dir, 'c2');
  assert.equal(fs.existsSync(secretsOf(dir)), false);
});

test('hasKey 只查存在性，不试图解密', () => {
  const dir = tmpdir();
  config.setKey(dir, fakeCrypto(), 'c1', 'X');
  assert.equal(config.hasKey(dir, 'c1'), true);
  assert.equal(config.hasKey(dir, 'c2'), false);
  assert.equal(config.hasKey(tmpdir(), 'c1'), false, '文件都不存在时不该抛异常');
});

test('换过机器 / keyring 被重置：解密失败要明确报错，不能当成空值', () => {
  const dir = tmpdir();
  config.setKey(dir, fakeCrypto(), 'c1', 'PRIVATE-KEY-PEM');

  const other = { encrypt: () => Buffer.from('x'), decrypt: () => { throw new Error('bad key'); } };
  const got = config.getKey(dir, other, 'c1');
  assert.equal(got.ok, false);
  assert.match(got.reason, /decrypt_failed/);

  // 连安全存储都没有了
  assert.equal(config.getKey(dir, null, 'c1').reason, 'no_secure_storage');
});

test('★ 旧版本留下的明文私钥必须读得出来，并标记成 legacy', () => {
  const dir = tmpdir();
  // schema 2 及更早允许用户选「明文保存」，磁盘上可能就留着这么一份
  fs.writeFileSync(secretsOf(dir), JSON.stringify({
    schema: 2, mode: 'plain', data: 'PRIVATE-KEY-PEM',
  }));
  config.migrateLegacySecret(dir, ['c1']);

  const got = config.getKey(dir, fakeCrypto(), 'c1');
  assert.equal(got.ok, true, '读不出来会让用户以为密钥丢了，跑去重新生成、重新注册');
  assert.equal(got.value, 'PRIVATE-KEY-PEM');
  assert.equal(got.legacy, true, 'legacy:true 是在告诉调用方「有条件就加密重存一遍」');

  // 调用方看到 legacy 后加密重存一遍，明文就没了
  assert.equal(fs.readFileSync(secretsOf(dir), 'utf8').includes('"plain"'), true, '前置条件');
  assert.equal(config.setKey(dir, fakeCrypto(), 'c1', got.value).ok, true);
  assert.equal(fs.readFileSync(secretsOf(dir), 'utf8').includes('"plain"'), false,
    '重存之后不该还是明文');
  assert.equal(fs.readFileSync(secretsOf(dir), 'utf8').includes('PRIVATE-KEY-PEM'), false,
    '落盘的必须是密文');
  assert.equal(config.getKey(dir, fakeCrypto(), 'c1').legacy, undefined);

  // 而没有凭据库的机器上，重存这一步会失败 —— 那就只能维持原样，
  // 由界面把它当作「明文存放」如实告知，而不是假装加密了
  assert.equal(config.setKey(dir, null, 'c1', 'x').reason, 'no_secure_storage');
});

test('★ 旧版本的**全局**密钥被搬到每一条连接上（用户不必重新注册）', () => {
  const dir = tmpdir();
  fs.writeFileSync(secretsOf(dir), JSON.stringify({
    schema: 3, mode: 'encrypted', data: encrypted('ONLY-KEY'),
  }));

  const r = config.migrateLegacySecret(dir, ['c1', 'c2']);
  assert.equal(r.migrated, true);
  assert.equal(r.count, 2);
  // 升级前它服务所有连接，升级后每条都拿到同一把 —— 那正是升级前的事实
  assert.equal(config.getKey(dir, fakeCrypto(), 'c1').value, 'ONLY-KEY');
  assert.equal(config.getKey(dir, fakeCrypto(), 'c2').value, 'ONLY-KEY');

  // 旧格式那两个字段不再留着，否则每读一次都会以为还有一份没搬完
  const raw = JSON.parse(fs.readFileSync(secretsOf(dir), 'utf8'));
  assert.equal(raw.schema, 6);
  assert.equal(raw.data, undefined);
  assert.equal(raw.mode, undefined);
});

test('★ 还没有任何连接时先不搬 —— 那份密钥必须原样留着', () => {
  const dir = tmpdir();
  fs.writeFileSync(secretsOf(dir), JSON.stringify({
    schema: 3, mode: 'encrypted', data: encrypted('ONLY-KEY'),
  }));

  const r = config.migrateLegacySecret(dir, []);
  assert.equal(r.migrated, false);
  assert.equal(r.deferred, true, '必须报告「推迟了」，而不是「没有可搬的」');
  // 删掉它等于让用户已经注册过的公钥凭空消失
  assert.equal(JSON.parse(fs.readFileSync(secretsOf(dir), 'utf8')).data, encrypted('ONLY-KEY'));

  // 等第一条连接出现，它就该落到那条连接上
  assert.equal(config.migrateLegacySecret(dir, ['c1']).migrated, true);
  assert.equal(config.getKey(dir, fakeCrypto(), 'c1').value, 'ONLY-KEY');
});

test('已经是新格式时迁移是空操作', () => {
  const dir = tmpdir();
  config.setKey(dir, fakeCrypto(), 'c1', 'PEM-C1');
  const before = fs.readFileSync(secretsOf(dir), 'utf8');
  assert.equal(config.migrateLegacySecret(dir, ['c1', 'c2']).migrated, false);
  assert.equal(fs.readFileSync(secretsOf(dir), 'utf8'), before, '不该动它');
});

test('认不出的 mode 明确报错，不当成空值', () => {
  const dir = tmpdir();
  fs.writeFileSync(secretsOf(dir), JSON.stringify({
    schema: 4, keys: { c1: { mode: 'whatever', data: 'x' } },
  }));
  assert.match(config.getKey(dir, fakeCrypto(), 'c1').reason, /bad_mode/);
});

test('没存过凭据时 getKey 明确返回 not_saved', () => {
  assert.equal(config.getKey(tmpdir(), fakeCrypto(), 'c1').reason, 'not_saved');
  // 文件在、但没有这一条 —— 同样是 not_saved，而不是「读不出来」
  const dir = tmpdir();
  config.setKey(dir, fakeCrypto(), 'c1', 'X');
  assert.equal(config.getKey(dir, fakeCrypto(), 'c2').reason, 'not_saved');
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

// ── 站点分发的配置：台账 + 开发者模式（schema 6）─────────────────────────────

test('★ 同意台账只收**形状完整**的条目 —— 残缺的丢掉比留着安全', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema: 6,
    trustedPlugins: {
      'good@1.0.0': { digest: 'a'.repeat(64), site: 'u@h:22', at: 1 },
      // 短摘要：**绝不能**被当成"已经同意过" —— 那样真正的那份内容从来没被核对过
      'short@1.0.0': { digest: 'a'.repeat(16), site: 'u@h:22', at: 1 },
      // 缺 digest
      'nodigest@1.0.0': { site: 'u@h:22' },
      // 对面自报的、根本不是十六进制的东西
      'weird@1.0.0': { digest: 'Z'.repeat(64), site: 'u@h:22' },
      // 没有来源站点
      'nosrc@1.0.0': { digest: 'b'.repeat(64) },
      'notobj@1.0.0': 'yes',
    },
  }));
  const cfg = config.loadConfig(dir);
  assert.deepEqual(Object.keys(cfg.trustedPlugins), ['good@1.0.0'],
    '★ 只留形状完整的那一条 —— 丢掉 = 回到"要重新点一次同意"，那是安全的那一侧');
  assert.equal(config.isTrusted(cfg, 'good', '1.0.0', 'a'.repeat(64)), true);
  assert.equal(config.isTrusted(cfg, 'good', '1.0.0', 'b'.repeat(64)), false,
    '摘要对不上就是不认识');
  assert.equal(config.isTrusted(cfg, 'good', '2.0.0', 'a'.repeat(64)), false,
    '★ 键里带**版本**：新版本是另一份构件，要重新同意');
});

test('★ 写台账：摘要必须是全长的，短的要被拒', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  assert.deepEqual(config.trustPlugin(dir, cfg, 'x', '1.0.0', 'short', 's').ok, false,
    '★ 台账不接受自报的短摘要 —— 拿 16 位当键就是一个 64 位的碰撞面');
  assert.deepEqual(config.trustPlugin(dir, cfg, 'x', '1.0.0', 'A'.repeat(64), 's').ok, false,
    '大写十六进制也不收（判据要逐字符一样）');
  assert.equal(config.trustPlugin(dir, cfg, 'x', '1.0.0', 'c'.repeat(64), 's').ok, true);
  // 落盘了才算数 —— 不落盘的话下次启动会再问一遍
  const again = config.loadConfig(dir);
  assert.equal(config.isTrusted(again, 'x', '1.0.0', 'c'.repeat(64)), true);
});

test('★ 开发者模式：缺省**关着**，且只认布尔值', () => {
  const dir = tmpdir();
  assert.equal(config.DEFAULTS.devPlugins, false,
    '★ 缺省必须是 false —— 插件默认只认站点分发的那一份');
  assert.equal(config.loadConfig(dir).devPlugins, false);

  // 配置文件是用户可以手改的，而 `"devPlugins": "no"` 这样的字符串会被 `if (x)` 判真
  fs.writeFileSync(path.join(dir, 'config.json'),
    JSON.stringify({ schema: 6, devPlugins: 'no' }));
  assert.equal(config.loadConfig(dir).devPlugins, false, '认不出的形状丢掉 = 回到安全的那一侧');

  const cfg = config.loadConfig(tmpdir());
  const d2 = tmpdir();
  config.setDevPlugins(d2, cfg, true);
  assert.equal(config.loadConfig(d2).devPlugins, true, '打开要落盘');
  config.setDevPlugins(d2, cfg, false);
  assert.equal(config.loadConfig(d2).devPlugins, false);
});

// ── 钉子：按 id 记的签名公钥（§5.4）─────────────────────────────────────────

test('★ 钉子表是**单独一个文件** —— 旧版本不认识它，也就抹不掉它', () => {
  const dir = tmpdir();
  const FP = 'a'.repeat(64);
  assert.deepEqual(config.loadPinnedKeys(dir), {}, '还没钉过 ⇒ 空表');

  const pins = config.loadPinnedKeys(dir);
  assert.equal(config.pinPluginKey(dir, pins, 'PLUG', FP).ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'pinned-keys.json')), true);
  // ★ 关键的一条：它**不在** config.json 里。放进那里的话，一个只认已知键的旧版本
  //   读一遍再存一遍就会把它抹掉 —— 而丢掉钉子 = 静默回到"首次即信任"。
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false,
    '钉一件事不该顺手写出一份 config.json');

  const again = config.loadPinnedKeys(dir);
  assert.equal(config.pinnedKeyOf(again, 'PLUG'), FP);
  assert.equal(mode(path.join(dir, 'pinned-keys.json')), 0o600, '钉子表是 0600');
});

test('★★ 钉子只能钉一次：换一把 ⇒ 拒绝（§5.4，这里没有"重新钉"这条路）', () => {
  const dir = tmpdir();
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const pins = config.loadPinnedKeys(dir);
  config.pinPluginKey(dir, pins, 'PLUG', A);

  assert.equal(config.pinPluginKey(dir, pins, 'PLUG', A).unchanged, true, '同一个值 ⇒ 无操作');
  const r = config.pinPluginKey(dir, pins, 'PLUG', B);
  assert.equal(r.ok, false);
  assert.match(r.error, new RegExp(A), '错误里必须**说出**原来那一把');
  assert.match(r.error, new RegExp(B), '也要说出想换成的这一把');
  assert.equal(config.pinnedKeyOf(config.loadPinnedKeys(dir), 'PLUG'), A, '钉还是原来那一把');

  const bad = config.pinPluginKey(dir, pins, 'OTHER', 'not-a-fingerprint');
  assert.equal(bad.ok, false, '指纹不合形状 ⇒ 拒绝，不写一条用不了的记录');
  assert.equal(config.pinnedKeyOf(config.loadPinnedKeys(dir), 'OTHER'), undefined);
});

test('★★ 一条读不动的钉子**留在表里**，返回 `\'\'` 而不是 `undefined`', () => {
  // 这一条与同意台账**相反**：台账里一条残缺条目丢掉 = 重新问一次（安全的那侧）；
  // 钉子丢掉 = 下次"首次即信任"（不安全的那侧）。所以两者必须分得开：
  //   undefined = 从来没钉过（首次即信任）
  //   ''        = 钉过，但那一份读不出来（必须拒绝）
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'pinned-keys.json'), JSON.stringify({
    schema: 1,
    pinnedKeys: {
      GOOD: { fingerprint: 'c'.repeat(64), at: 1 },
      SHORT: { fingerprint: 'abc', at: 1 },
      MISSING: { at: 1 },
      JUNK: 'not-an-object',
    },
  }));

  const pins = config.loadPinnedKeys(dir);
  assert.equal(config.pinnedKeyOf(pins, 'GOOD'), 'c'.repeat(64));
  assert.equal(config.pinnedKeyOf(pins, 'SHORT'), 'abc',
    '读不动的那一份**原样留着** —— 它既不是 undefined（那会变成"没钉过"），也不是它自己');
  assert.equal(config.pinnedKeyOf(pins, 'MISSING'), '', '连指纹字段都没有的那一条 ⇒ 空串');
  assert.equal(config.pinnedKeyOf(pins, 'JUNK'), '', '那一条根本不是对象 ⇒ 空串');
  assert.equal(config.pinnedKeyOf(pins, 'NEVER'), undefined, '这个 id 是真没钉过');
  // ★ 判它读不读得动的地方**只有一处**：`keyVerdict` 那个全长十六进制的正则。
  //   所以这里能说的就是"它留在表里、而且不是 undefined"；「一律拒绝」由
  //   plugin-package.test.mjs 断言（那边有真的包可以喂进去）。
  assert.notEqual(config.pinnedKeyOf(pins, 'SHORT'), undefined);
});

test('钉子在同意台账旁边活得很好：两张表互不影响', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  const pins = config.loadPinnedKeys(dir);
  config.trustPlugin(dir, cfg, 'PLUG', '1.0.0', 'd'.repeat(64), 'site');
  config.pinPluginKey(dir, pins, 'PLUG', 'e'.repeat(64));

  // §5.3 说删掉构件 = 撤回同意；而**拔钉子**不许跟着发生（承重·六）。
  // 这条断言把"两张表各写各的文件"钉住：动一张不会碰到另一张。
  const cfg2 = config.loadConfig(dir);
  assert.equal(config.isTrusted(cfg2, 'PLUG', '1.0.0', 'd'.repeat(64)), true);
  assert.equal(config.pinnedKeyOf(config.loadPinnedKeys(dir), 'PLUG'), 'e'.repeat(64));

  const before = fs.readFileSync(path.join(dir, 'pinned-keys.json'), 'utf8');
  config.trustPlugin(dir, cfg2, 'PLUG', '1.0.1', 'f'.repeat(64), 'site');
  assert.equal(fs.readFileSync(path.join(dir, 'pinned-keys.json'), 'utf8'), before,
    '写同意台账不许碰钉子表一个字节');
});
