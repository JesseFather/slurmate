// Copyright 2026 JesseFather
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * config.test.mjs —— 配置、连接条目与主机密钥指纹。
 *
 * 重点是两条原则：
 *
 * 1. 「**绝不静默降级**」—— 安全存储不可用时，必须明确失败，而不是悄悄把私钥
 *    明文写盘。悄悄写明文正是这个项目一路在清的那类问题。私钥**只有加密一种存法**：
 *    界面上没有「保存方式」这个下拉框，因为让用户在安全和方便之间做选择，
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
const pluginData = require('../src/main/plugin-data.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-cfg-'));
}

/**
 * 一个**合法形状**的工作区 id（见 config.js 的 WORKSPACE_ID_RE）。
 *
 * ★ 用例里 `gid(1)` 比一串随机十六进制好读，而**它不能省**：形状不对的那些会被
 *   `normalizeWorkspace` 整条丢掉 —— `'wa'` / `'wxyz'` 这类值过不了它。
 */
const gid = (n) => 'w' + String(n).padStart(12, '0');

/**
 * 一个**合法形状**的数据空间 id（见 config.js 的 SPACE_ID_RE）。
 *
 * ★ 与 `gid` 同一理由，而且**更要紧**：数据 id 进**磁盘路径**（分区名 =
 *   `插件id@共享组@数据id`），所以手改过的配置里一个 `"../x"` 会一路走到路径里。
 */
const sid = (n) => 's' + String(n).padStart(12, '0');

/** 一个要数据空间（一个端口）的插件（形状取真清单里那一个，但 id 本文件自己编）。 */
const LAYOUT_PLUGIN = {
  id: '01M2JKHTZGKJBFQQTWYXMQMF2V', name: 'cs', version: '1.0.0',
  contributes: { ports: 1, concurrent: true, data: { inherit: 'editor' } },
};

/** 一份合法形状的数据（`{id, pluginId, group, ports}`）。 */
const space = (n, over = {}) => ({
  id: sid(n), pluginId: LAYOUT_PLUGIN.id, group: 'editor', ports: [18080 + n], ...over,
});

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
  assert.equal(cfg.schema, 7);
  assert.deepEqual(cfg.connections, []);
  assert.equal(cfg.activeConnectionId, null);
  assert.deepEqual(cfg.hostKeys, {});
  assert.deepEqual(cfg.workspaces, []);
  assert.deepEqual(cfg.spaces, []);
  // 私钥没有「保存方式」这个设置项 —— 任何一条配置都不该把它带回来
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
  assert.equal(cfg.schema, 7);
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

  // label 恰好等于 host 的那种，读进来也归成「没起名」
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
  // 同一个地址点了三次「保存并连接」，配置里攒了三条一样的
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

test('★ 旧格式不再被读：schema 1 的 profile + extraHosts 读作"没有配过"', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema: 1,
    profile: { user: 'alice', host: '198.51.100.10', port: 10100 },
    extraHosts: [{ host: '203.0.113.7', port: 10100, label: '公网' }],
    passwordMode: 'encrypted',
    maxSessions: 1,
  }));

  // 这条钉的是**实际发生的事**：一条连接都没有，用户在界面上重新填一次。
  // 写"应该会怎样"没有意义，写清楚"就是这样"才有。
  const cfg = config.loadConfig(dir);
  assert.deepEqual(cfg.connections, []);
  // 旧字段不会跟着活下去（只认已知键，不写回）。留着它们，将来读这份配置的人
  // 会以为它们还有用，去代码里找一个并不存在的行为。
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

// ── 工作区（一张引用表）与数据空间（一份存储 + 它自己的端口）─────────────────
//
// 两个对象，别混：
//   工作区 = **哪几条连接算同一个**（用户说了算），它只拥有一张 `refs` 表；
//   数据空间 = **一个插件的一份存储 + 它自己的端口**，它不属于任何工作区
//              （一份数据可以被几个工作区同时引用）。

test('★★ 数据**创建时定一次**、此后只读 —— 没有任何函数改得动它的端口', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  assert.deepEqual(cfg.workspaces, [], '一条连接都没有时不该有工作区');
  assert.deepEqual(cfg.spaces, [], '也不该有数据');

  // 一份数据 = 一个本地端口 = 一个 origin = 一份编辑器布局。端口只在它**被创建时**
  // 定一次（`assignSpacePorts`），此后再没有任何东西改它。
  cfg.spaces = [space(1)];
  assert.deepEqual(config.findSpace(cfg, sid(1)).ports, [18081], '端口是这份数据的一个属性');
  config.saveConfig(dir, cfg);
  assert.deepEqual(config.findSpace(config.loadConfig(dir), sid(1)).ports, [18081],
    '存下来的端口读得回来');

  // ★★ 这一条钉的是"存下来的端口读得回来"真的被验过：取端口只有一条路
  //    （见 `index.js` 的 `spacePortOf`），它**没有回落** —— 拿一个刚从磁盘读回来的
  //    配置去问，问的就是它自己存下的那些 `spaces`。

  // ★ 顺移**不**写回。把顺移后的值记下来，等于把一次**暂时**的冲突变成永久的
  //   origin 变更 —— 冲突消失之后 origin 也回不去，而那份布局本来是可以回来的
  //   （用户下一会话回到原端口，那份布局也跟着回来）。
  //   所以模块里**根本没有**改端口的函数 —— 这条断言就是那道闸。
  assert.equal(typeof config.setSpacePort, 'undefined',
    '★ 没有任何函数改得动一份已存在数据的端口 —— 它是只读属性');
});

test('数据：端口越界就整条不合法，不补默认值', () => {
  // 与连接条目同规矩。补一个默认端口会让用户以为这份数据还能用，
  // 而它其实指向一份永远不会被打开的存储。
  assert.equal(config.normalizeSpace({ id: sid(1), pluginId: LAYOUT_PLUGIN.id,
    group: 'editor', ports: [80] }), null, '特权端口');
  assert.equal(config.normalizeSpace({ id: sid(2), pluginId: LAYOUT_PLUGIN.id,
    group: 'editor', ports: [99999] }), null, '越界端口');
  assert.equal(config.normalizeSpace({ id: sid(3), pluginId: LAYOUT_PLUGIN.id,
    group: 'editor', ports: ['x'] }), null, '非数字');
  assert.equal(config.normalizeSpace({ id: sid(4), pluginId: LAYOUT_PLUGIN.id,
    group: 'editor', ports: [] }), null, '★ 空列表也不行 —— 端口是它非有不可的东西');
  assert.equal(config.normalizeSpace(null), null);
  assert.deepEqual(config.normalizeSpace(space(5)).ports, [18085]);
});

test('★ 数据 id 的形状也要查 —— 它进磁盘路径', () => {
  // ★ 这一格必须查：`normalizeSpace` 若只问"是不是非空字符串"，而这个 id 会被拼成
  //   分区名 = Electron 的存储目录名 —— 于是 `config.json` 里手写一个
  //   `"id": "../x"` 就会一路走到路径里。（`persist:plugin-<ULID>` 那条
  //   之所以没事，是因为 ULID 有自己的白名单，不是这一层在管。）
  for (const bad of ['../x', 'sa', 's' + 'g'.repeat(12), 's' + '0'.repeat(11),
    '../../etc', 's0123456789ab/../x']) {
    assert.equal(config.normalizeSpace({ id: bad, pluginId: LAYOUT_PLUGIN.id,
      group: 'editor', ports: [18080] }), null,
    `${JSON.stringify(bad)} 不是合法的数据 id，必须整条丢掉`);
  }
  // ★ **写了一个形状不对的 id ⇒ 整条丢掉**；而**根本没写 id** 走的是另一条路
  //   （补一个新的）。两者不是一回事，也不该合并：前者是一个**会进路径的字符串**
  //   （必须拦），后者只是"这份数据还没有身份"—— 拦下来只会让一份手写的配置整条丢掉。
  assert.match(config.normalizeSpace({ pluginId: LAYOUT_PLUGIN.id,
    group: 'editor', ports: [18080] }).id, /^s[0-9a-f]{12}$/, '没写 id 的数据补一个新的');
  // 合法的那两个（`newSpaceId` 铸出来的形状、与那条正则）必须是同一条规则。
  assert.equal(config.normalizeSpace(space(7)).id, sid(7));
  assert.match(config.newSpaceId(), /^s[0-9a-f]{12}$/,
    '★ 铸出来的 id 与查的形状必须是同一条规则（两边分家的话，用户每次新建一份数据都会'
    + '在下次启动时丢掉它）');
});

test('★ 数据那两格也进路径：插件 id 与共享组的形状都要查', () => {
  // ★ 插件 id 是 ULID（大写）；共享组名是清单里那一格，而第二段**还可能是版本号**
  //   （`data.perVersion: true`），所以这里查的是**进路径的安全性**，不是清单那条规则。
  const ok = (over) => config.normalizeSpace({ ...space(1), ...over });
  assert.equal(ok({ pluginId: '../x' }), null, '插件 id 里一个斜杠就够走到路径外面');
  assert.equal(ok({ pluginId: LAYOUT_PLUGIN.id.toLowerCase() }), null,
    '★ 大小写也要一致：磁盘上那一段是折叠过的，而配置里那一份是原样的 ULID');
  assert.equal(ok({ pluginId: LAYOUT_PLUGIN.id.slice(0, 25) }), null, '25 个字符不是 ULID');
  assert.equal(ok({ group: '../x' }), null);
  assert.equal(ok({ group: '' }), null);
  assert.equal(ok({ group: 'e'.repeat(33) }), null, '比 GROUP_RE 的上限还长');
  assert.equal(ok({ group: '1.0.0' }).group, '1.0.0',
    '★ 第二段**可以是一个版本号**（perVersion），那是一条合法的取值');
});

test('★ 新建出来的名字是「工作区 N」，而 N 是**当前没被占用**的最小正整数', () => {
  // ★ 那两个字符串是**用户看得见**的东西（下拉框、映射图、改名框里的初值），
  //   而它们**没有任何别的地方看着** —— 改了措辞不会有别的用例变红。
  assert.equal(config.nextWorkspaceName({ workspaces: [] }), '工作区 1');
  // 连着占了 1、2 ⇒ 往后让到 3；而 2 空着时就用 2（不是"总在最大的后面加一"）。
  assert.equal(config.nextWorkspaceName({ workspaces: [
    { id: gid(1), name: '工作区 1' },
    { id: gid(2), name: '工作区 2' }] }), '工作区 3');
  assert.equal(config.nextWorkspaceName({ workspaces: [
    { id: gid(1), name: '工作区 1' },
    { id: gid(2), name: '工作区 3' }] }), '工作区 2');
  // 用户自己起的名字**不占号** —— 否则「我自己起的名字」会让下一个自动名跳过 1。
  assert.equal(config.nextWorkspaceName({ workspaces: [
    { id: gid(1), name: '我自己起的名字' }] }), '工作区 1');
});

test('★ 旧格式不再被读：schema ≤ 4 的 slots 读作"没有工作区"，就地补一个空白工作区', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema: 4,
    connections: [
      { id: 'c1', label: '内网', user: 'alice', host: '198.51.100.10', port: 10100 },
      { id: 'c2', label: '公网', user: 'alice', host: '203.0.113.7', port: 10100 },
    ],
    activeConnectionId: 'c1',
    slots: { 1: { port: 18093 } },
  }));

  // 这条钉的是**实际发生的事**：一个全新的空白工作区（引用表空着），一条数据都没有。
  const cfg = config.loadConfig(dir);
  assert.equal(cfg.workspaces.length, 1);
  assert.deepEqual(cfg.workspaces[0].refs, {}, '★ 工作区只带一张**空的**引用表 —— 数据是开会话时才建的');
  assert.deepEqual(cfg.spaces, [], '不再继承 slots["1"].port（那条路整个删了）');
  // 旧字段自然消失（只认已知键，不写回）。留着它，将来读这份配置的人
  // 会以为它还有用，去代码里找一个早就不存在的行为。
  assert.equal(cfg.slots, undefined);
  assert.equal(cfg.schema, 7);
  // 两条连接收束到那一个工作区里 —— 这条与迁移无关，是 loadWorkspaces 自己的收束规则：
  // 指向不存在的工作区 = 界面上一片空白，而用户看不出为什么。
  for (const c of cfg.connections) {
    assert.equal(c.workspaceId, cfg.workspaces[0].id, `${c.id} 必须落在那一个工作区里`);
  }
});

test('★★ 兜底那个工作区的 id 是**确定的** —— 不然读一次配置就丢掉一份布局', () => {
  // 场景就是用户真的会走的那条：手改过配置（或者第一次配连接就写下了连接），
  // `workspaces[]` 是空的 ⇒ `loadWorkspaces` 就地补一个「默认工作区」。
  //
  // ★★ 而 `loadConfig` **自己不写盘**（见 config.js 文件头那三条原则），所以
  //    这条兜底若用 `newWorkspaceId()`（随机），后果是**静默丢数据**：
  //
  //        读完配置 → 一次都没保存就退出 → 下次启动换一个 id → 换一批数据
  //        ⇒ 上一轮刚攒的编辑器布局凭空消失（数据 id 就是磁盘上的目录名）。
  //
  //    ★ 所以这里钉的是**确定性**这个性质：兜底那个 id 必须每次一样。
  const dir = tmpdir();
  const write = () => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema: 7,
    connections: [{ id: 'c1', label: '内网', user: 'alice',
      host: '198.51.100.10', port: 10100 }],
    activeConnectionId: 'c1',
    workspaces: [],
  }));

  write();
  const a = config.loadConfig(dir);
  assert.equal(a.workspaces.length, 1, '有连接、一个工作区都没有 ⇒ 就地补一个');
  const id = a.workspaces[0].id;

  // ★ 判据一（承重的那条）：再读一次必须还是同一个 id。随机 id 在这里必然红。
  write();
  const b = config.loadConfig(dir);
  assert.equal(b.workspaces[0].id, id,
    '★★ 同一份配置读两次必须得到同一个工作区 id —— 换一个 id 就是换一批数据，'
    + '而用户刚攒下的那份布局正在那些数据里');

  // ★ 判据二：它的形状必须过 `WORKSPACE_ID_RE`。兜底那一支是**直接 push** 的，
  //   不走 `normalizeWorkspace` —— 所以一个形状不对的常量能活过一次读、却会在
  //   **下一次读**时被丢掉（那正是上一条要防的病的另一种发作方式）。
  assert.match(id, /^w[0-9a-f]{12}$/,
    '兜底 id 的形状必须与 WORKSPACE_ID_RE 是同一条规则');
});

test('★ 每一个数据 id 一份独立的存储，且 id 不复用', () => {
  // 数据 id 是 partition 的**末段**，而整个 partition 名就是 Electron 的存储目录名 ——
  // 「新建一份数据真的空白」靠的是 id **永不复用**：若按端口命名，A 回收后端口
  // 被新数据 B 复用，B 就会继承 A 的 localStorage 和登录 cookie。
  const of = (s) => pluginData.partitionOf(pluginData.identityOf(LAYOUT_PLUGIN, s));

  const a = config.newSpaceId();
  const b = config.newSpaceId();
  assert.match(a, /^s[0-9a-f]{12}$/);
  assert.notEqual(a, b, 'id 永不复用');
  assert.notEqual(of({ id: a, pluginId: LAYOUT_PLUGIN.id, group: 'editor' }),
    of({ id: b, pluginId: LAYOUT_PLUGIN.id, group: 'editor' }), '两份数据必须是两份存储');
  // ★ 整个身份都在里面：插件 id @ 共享组 @ 数据 id。少了前两段的话，"同一个工作区里
  //   两个插件"会读写同一份存储 —— 而那正是这次重做要放开的场景。
  assert.equal(of({ id: a, pluginId: LAYOUT_PLUGIN.id, group: 'editor' }),
    `persist:${LAYOUT_PLUGIN.id}@editor@${a}`);
});

// ── spaceFor：一个工作区里，一个插件用哪一份数据 ─────────────────────────────

test('★★ spaceFor：没有就建一份并落进引用表；有就复用**同一份**', () => {
  const cfg = config.loadConfig(tmpdir());
  cfg.workspaces = [{ id: gid(1), name: 'A', refs: {} }];

  const a = config.spaceFor(cfg, gid(1), LAYOUT_PLUGIN.id, 'editor', 1);
  assert.equal(a.created, true);
  assert.equal(a.space.pluginId, LAYOUT_PLUGIN.id);
  assert.equal(a.space.group, 'editor');
  assert.equal(a.space.ports.length, 1, '个数由调用方给（`pluginData.portCountOf`）');
  assert.equal(cfg.workspaces[0].refs[LAYOUT_PLUGIN.id], a.space.id, '引用表要跟着写');

  // ★ 第二次问**必须是同一份**：铸一个新的等于每次开会话都换一个 origin，
  //   而用户看到的是"我的布局又没了"，且没有任何报错。
  const b = config.spaceFor(cfg, gid(1), LAYOUT_PLUGIN.id, 'editor', 1);
  assert.equal(b.created, false);
  assert.equal(b.space.id, a.space.id);
  assert.equal(cfg.spaces.length, 1, '不该多出一份');

  // 同一个工作区里**另一个插件**是另一份数据（两个端口、两份存储）——
  // 这正是"一个工作区里两个要数据空间的插件可以同时跑"的全部依据。
  const other = config.spaceFor(cfg, gid(1), LAYOUT_PLUGIN.id.replace('2V', '3W'), 'other', 1);
  assert.notEqual(other.space.id, a.space.id);
  assert.equal(cfg.spaces.length, 2);

  // ★ **个数是调用方给的**，这一层照数兑现：给 2 就占两个端口。
  //   上界不在这里 —— 那是清单校验那一侧的事（`MAX_PLUGIN_PORTS`），因为
  //   "框架兑现得了几个"是基座的能力，不是这份配置的形状。
  //   这一条同时钉住"逐个取端口"那个写法的错误：那样两份会拿到同一个端口。
  const two = config.spaceFor(cfg, gid(1), LAYOUT_PLUGIN.id.replace('3W', '4X'), 'two', 2);
  assert.equal(two.space.ports.length, 2);
  assert.equal(new Set(two.space.ports).size, 2, '同一份数据里不许有两个相同的端口');
  assert.notEqual(two.space.ports[0], a.space.ports[0], '两份数据不能抢同一个 origin');
});

test('★★ 作者换了共享组 ⇒ **新开一份**，不是就地改名', () => {
  // `inherit` 的语义是"这几个版本共用一份"。作者把 `editor` 改成 `editor2`，
  // 就是在说"我这份数据的格式变了，别继承" —— 于是第三段必须跟着变。
  // ★ 就地改 `space.group` 是错的：那份存储还在旧名字的目录里，改名之后它就成了
  //   一份**谁也读不到**的残留（而对账会把新名字当成一份不存在的活数据）。
  const cfg = config.loadConfig(tmpdir());
  cfg.workspaces = [{ id: gid(1), name: 'A', refs: {} }];

  const a = config.spaceFor(cfg, gid(1), LAYOUT_PLUGIN.id, 'editor', 1);
  const b = config.spaceFor(cfg, gid(1), LAYOUT_PLUGIN.id, 'editor2', 1);
  assert.equal(b.created, true, '共享组变了 ⇒ 必须新开一份');
  assert.notEqual(b.space.id, a.space.id);
  assert.equal(b.space.group, 'editor2');
  assert.equal(cfg.workspaces[0].refs[LAYOUT_PLUGIN.id], b.space.id, '引用表要指向新的那一份');
  assert.equal(config.findSpace(cfg, a.space.id).group, 'editor',
    '★ 旧那一份**一个字都不改** —— 它下面那份存储的名字就是按它算的');

  // 而旧那一份现在没有任何工作区指着它了 ⇒ 下一层回收会收掉它（`pruneSpaces`）。
  assert.deepEqual(config.pruneSpaces(cfg).removed.map((s) => s.id), [a.space.id]);
});

test('★ spaceFor 对不存在的工作区返回 null，不凭空造一个', () => {
  const cfg = config.loadConfig(tmpdir());
  assert.equal(config.spaceFor(cfg, gid(9), LAYOUT_PLUGIN.id, 'editor', 1), null);
  assert.deepEqual(cfg.spaces, []);
});

// ── 两层回收 ────────────────────────────────────────────────────────────────

test('回收：只删引用计数为 0 的工作区，并报出删了哪些', () => {
  const cfg = config.loadConfig(tmpdir());
  cfg.workspaces = [
    { id: gid(1), name: 'A', refs: {} },
    { id: gid(2), name: 'B', refs: {} },
    { id: gid(3), name: 'C', refs: {} },
  ];
  cfg.connections = [
    { id: 'c1', user: 'a', host: 'h', port: 1, workspaceId: gid(1) },
    { id: 'c2', user: 'b', host: 'h', port: 1, workspaceId: gid(2) },
    { id: 'c3', user: 'c', host: 'h', port: 1, workspaceId: gid(1) },
  ];

  const r = config.pruneWorkspaces(cfg);
  assert.deepEqual(r.removed, [gid(3)], '只有 0 引用的那个该被删');
  assert.deepEqual(cfg.workspaces.map((l) => l.id), [gid(1), gid(2)], '顺序必须保持');
});

test('回收：一条连接都没有时**不**回收 —— 演示模式的那个工作区必须活下来', () => {
  const cfg = config.loadConfig(tmpdir());
  cfg.workspaces = [{ id: gid(9), name: '演示工作区', refs: {} }];
  cfg.connections = [];

  // 演示模式一个连接都没有，而它照样要开会话 —— 那个工作区是那次会话的工作区身份。
  // 在这里把它回收掉，下次开会话又会造一个新的，id 一变引用表就变，
  // 布局白重置一次，而用户看到的是「演示模式里布局老是丢」。
  const r = config.pruneWorkspaces(cfg);
  assert.deepEqual(r.removed, [], '没有映射关系要维护时，回收无事可做');
  assert.deepEqual(cfg.workspaces.map((l) => l.id), [gid(9)]);
});

test('★★ 数据那一层：没人引用的收掉 —— 但**被两个工作区引用时，删一个不动它**', () => {
  // ★★ 这条是这次重做的中心性质，也是"数据不属于任何工作区"那句话的全部意思。
  const cfg = config.loadConfig(tmpdir());
  cfg.workspaces = [
    { id: gid(1), name: 'A', refs: { [LAYOUT_PLUGIN.id]: sid(1) } },
    { id: gid(2), name: 'B', refs: { [LAYOUT_PLUGIN.id]: sid(1) } },   // 同一份
    { id: gid(3), name: 'C', refs: { [LAYOUT_PLUGIN.id]: sid(3) } },   // 独占一份
  ];
  cfg.spaces = [space(1), space(3)];

  // 删掉 A ⇒ 那一份还被 B 引用着 ⇒ **一份都不该收**。
  cfg.workspaces = cfg.workspaces.filter((l) => l.id !== gid(1));
  assert.deepEqual(config.pruneSpaces(cfg).removed, [], '★ 还有 B 指着它，收它就是删活数据');

  // 删掉 B ⇒ 现在没人指着了；但**没有工作区引用**才是判据，与"有没有连接"无关。
  cfg.workspaces = cfg.workspaces.filter((l) => l.id !== gid(2));
  assert.deepEqual(config.pruneSpaces(cfg).removed.map((s) => s.id), [sid(1)]);
  assert.deepEqual(cfg.spaces.map((s) => s.id), [sid(3)], 'C 那一份一个字都不该动');
});

test('★★ 数据那一层：**活会话拿着的**不许收 —— 那是"切工作区"那条路的护栏', () => {
  // 场景：会话跑在 A 的某一份数据上 → 用户把这条连接切到工作区 B
  // ⇒ A 的引用计数归零、被回收 ⇒ 它那张引用表跟着消失 ⇒ 那一份数据变得
  // **没有任何工作区指着它** —— 而那一条会话**还跑在它上面**。
  //   少了 `keepIds` 这一层，`clearSpaceStorage` 会把它脚下的存储抽掉：
  //   症状只是「页面莫名其妙坏了」或「ssh 忽然认证失败」。
  const cfg = config.loadConfig(tmpdir());
  cfg.workspaces = [{ id: gid(1), name: 'A', refs: { [LAYOUT_PLUGIN.id]: sid(1) } }];
  cfg.spaces = [space(1)];

  cfg.workspaces = [];
  const kept = config.pruneSpaces(cfg, new Set([sid(1)]));
  assert.deepEqual(kept.removed, [], '★ 有一条活会话拿着它 ⇒ 不回收');
  assert.deepEqual(cfg.spaces.map((s) => s.id), [sid(1)]);

  // 那条会话结束之后（下一轮 commitConfig 不再传它）才真的收掉。
  assert.deepEqual(config.pruneSpaces(cfg).removed.map((s) => s.id), [sid(1)]);
});

test('spaceConsumers：谁在引用这一份数据', () => {
  const cfg = config.loadConfig(tmpdir());
  cfg.workspaces = [
    { id: gid(1), name: 'A', refs: { aa: sid(1) } },
    { id: gid(2), name: 'B', refs: { bb: sid(1) } },
    { id: gid(3), name: 'C', refs: { cc: sid(3) } },
  ];
  assert.deepEqual(config.spaceConsumers(cfg, sid(1)), [gid(1), gid(2)]);
  assert.deepEqual(config.spaceConsumers(cfg, sid(9)), []);
});

test('workspacePlan：把「这个工作区只被谁用」推导出来，renderer 不自己算', () => {
  const cfg = config.loadConfig(tmpdir());
  cfg.workspaces = [
    { id: gid(1), name: '公用', refs: { [LAYOUT_PLUGIN.id]: sid(1) } },
    { id: gid(2), name: '独占', refs: {} },
  ];
  cfg.connections = [
    { id: 'c1', user: 'a', host: 'h', port: 1, workspaceId: gid(1) },
    { id: 'c2', user: 'b', host: 'h', port: 1, workspaceId: gid(1) },
    { id: 'c3', user: 'c', host: 'h', port: 1, workspaceId: gid(2) },
  ];

  const plan = config.workspacePlan(cfg);
  assert.equal(plan[0].refCount, 2);
  assert.deepEqual(plan[0].members, ['c1', 'c2']);
  assert.equal(plan[0].soleOwnerId, null, '被两条连接用着，谁切走都不该删');
  assert.equal(plan[1].refCount, 1);
  assert.deepEqual(plan[1].members, ['c3']);
  // 界面据此在下拉里标注「只有这一条连接在用 —— 切走就会被丢弃」，
  // 并由主进程在真正切走时要求二次确认。
  assert.equal(plan[1].soleOwnerId, 'c3');
  // ★ 每一行还要报出它指着哪些数据：界面拿它把一条会话的 `spaceId` 对回工作区
  //   （会话手里是一份**数据**，而用户认的是**工作区**这个单位）。
  assert.deepEqual(plan[0].spaces, [sid(1)]);
  assert.deepEqual(plan[1].spaces, []);
  // ★ 而它**不再报端口** —— 端口是数据的属性，一个工作区可能同时指着好几份。
  assert.equal(plan[0].port, undefined);
});

test('★ 端口分配：从 18080 起，跳过已被占用的，**一次取够要的个数**', () => {
  const cfg = config.loadConfig(tmpdir());
  assert.deepEqual(config.assignSpacePorts(cfg, 1), [18080], '空配置从基址开始');

  cfg.spaces = [space(1), space(2), space(4)];   // 18081 / 18082 / 18084
  assert.deepEqual(config.assignSpacePorts(cfg, 1), [18080], '基址空着就用基址');
  cfg.spaces = [space(0), space(1), space(3)];   // 18080 / 18081 / 18083
  assert.deepEqual(config.assignSpacePorts(cfg, 1), [18082], '必须填中间的空洞');

  // ★ 个数是多于一个时**一次算一整套**，而且彼此不重复、升序 —— 逐个调用
  //   `assignSpacePorts(cfg, 1)` 拼起来会拿到同一个端口两次（它每次都从基址看，
  //   而中间那些还没有任何东西记下来）。这一条钉的就是"个数"这件事真的落到了实现里。
  cfg.spaces = [space(0), space(1), space(3)];   // 18080 / 18081 / 18083
  assert.deepEqual(config.assignSpacePorts(cfg, 3), [18082, 18084, 18085],
    '跳过被占的三个，按序取三个');

  // ★ 而 extraPorts 里的那些也要跳过 —— 那是**配置之外**占着的（临时那一份数据）。
  //   少了它，两份临时数据会拿到同一个首选端口，而症状是每次开局一条假警报。
  assert.deepEqual(config.assignSpacePorts(cfg, 2, new Set([18082, 18084])),
    [18085, 18086]);

  // usedSpacePorts 要能用 exceptId 把自己摘出去 —— 端口的顺移靠它，
  // 不摘的话目标那一份自己的端口会被当成「别人的」而永远绑不上。
  assert.deepEqual([...config.usedSpacePorts(cfg, sid(1))].sort(), [18080, 18083]);
});

test('★ 往返：保存再读，引用表与连接指向都不能丢', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  cfg.workspaces = [{ id: gid(11), name: '生产集群',
    refs: { [LAYOUT_PLUGIN.id]: sid(11) } }];
  cfg.spaces = [space(11)];
  cfg.connections = [
    { id: 'c1', label: '', user: 'alice', host: '198.51.100.10', port: 10100, workspaceId: gid(11) },
  ];
  config.saveConfig(dir, cfg);

  // loadConfig 只认白名单键。漏搬一个键的后果不是「少个字段」——
  // 是每次启动都丢掉全部工作区与数据，所有连接塌回一个默认工作区，
  // 而用户看到的只是「我配的映射关系没了」。
  const back = config.loadConfig(dir);
  assert.deepEqual(back.workspaces,
    [{ id: gid(11), name: '生产集群', refs: { [LAYOUT_PLUGIN.id]: sid(11) } }]);
  assert.deepEqual(back.spaces, [{ id: sid(11), pluginId: LAYOUT_PLUGIN.id,
    group: 'editor', ports: [18091] }]);
  assert.equal(back.connections[0].workspaceId, gid(11));
});

test('★ 引用表里指向**不存在**的那一格收掉，而不是留一条指向空气的引用', () => {
  // 悬空引用的症状是"这个插件忽然读回一份旧数据"，或者一份数据被算成"该有的"
  // 而它根本不在配置里。收掉它是**安全的那一侧**：`spaceFor` 下次开会话会新开一份。
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema: 7,
    workspaces: [{ id: gid(1), name: 'A', refs: {
      [LAYOUT_PLUGIN.id]: sid(1),                            // 指着存在的那一份 ⇒ 留
      [LAYOUT_PLUGIN.id.replace('2V', '3W')]: sid(9),         // 指着不存在的那一份 ⇒ 丢
      deadbeef: sid(1),                                      // 键不像插件 id ⇒ 丢
    } }],
    spaces: [space(1)],
    connections: [{ id: 'c1', user: 'a', host: '198.51.100.10', port: 10100, workspaceId: gid(1) }],
    activeConnectionId: 'c1',
  }));
  const cfg = config.loadConfig(dir);
  assert.deepEqual(cfg.workspaces[0].refs, { [LAYOUT_PLUGIN.id]: sid(1) },
    '★ 只留下**形状对、而且指着存在的那一份**的那一格');
  // ★ 而不存在的那一份是**另一回事**：它是这一格指着的东西，不是这一格本身。
  //   留着它并不会让谁来读它 —— `spaceFor` 会按引用表新开一份。
  assert.deepEqual(cfg.spaces.map((s) => s.id), [sid(1)]);
});

test('★ 引用表里形状不对的键值丢掉那一格，不丢掉整个工作区', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema: 7,
    workspaces: [{ id: gid(1), name: 'A', refs: {
      '../x': sid(1),                                     // 键不像插件 id
      [LAYOUT_PLUGIN.id]: '../etc',                        // 值不像数据 id
      [LAYOUT_PLUGIN.id.replace('2V', '3W')]: sid(1),       // 好的那一格
    } }],
    spaces: [space(1)],
    connections: [{ id: 'c1', user: 'a', host: '198.51.100.10', port: 10100, workspaceId: gid(1) }],
    activeConnectionId: 'c1',
  }));
  const cfg = config.loadConfig(dir);
  // ★ 一格坏掉只该让那一个插件少一份数据（下次开会话新开一份），不该让整个工作区
  //   连同别的插件的映射一起消失。
  assert.deepEqual(Object.keys(cfg.workspaces[0].refs), [LAYOUT_PLUGIN.id.replace('2V', '3W')]);
  assert.equal(cfg.workspaces.length, 1, '工作区本身要留着');
});

test('指向不存在的工作区时收束到第一个工作区，而不是留个悬空引用', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema: 7,
    workspaces: [{ id: gid(1), name: 'A', refs: {} }],
    connections: [{ id: 'c1', user: 'a', host: '198.51.100.10', port: 10100, workspaceId: '不存在' }],
    activeConnectionId: 'c1',
  }));
  const cfg = config.loadConfig(dir);
  // 悬空引用在界面上表现为「这条连接不属于任何工作区」，而用户看不出为什么。
  assert.equal(cfg.connections[0].workspaceId, gid(1));
});

// ── 凭据（SSH 私钥）：**每条连接一把** ──────────────────────────────────────
//
// 因为公钥是注册在**某个账户**上的，而一条连接就是「哪个账户、哪台机器、哪个端口」。
// 按连接存，才能做到「重新生成一把钥匙只作废那一条连接」，而不是把整个客户端打断。

const secretsOf = (dir) => path.join(dir, 'secrets.json');

test('★ 机器没有安全存储 → 明确失败，且绝不写明文', () => {
  const dir = tmpdir();
  const res = config.setKey(dir, null, 'c1', 'PRIVATE-KEY-PEM');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no_secure_storage');

  // 关键：一个字节都不该落盘。私钥没有「明文保存」这条退路 —— 存不了就是存不了，
  // 由界面如实告诉用户，而不是换个方式偷偷存下来。
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

test('★ 旧版本留下的明文私钥**不再被读出来** —— 报 bad_mode，而不是继续用它', () => {
  const dir = tmpdir();
  // 一份能被继续沿用的明文私钥，最该做的是被**发现**，而"顺手加密重存"等于让它
  // 再活一轮（见 config.js 里 SECRET_ENCRYPTED 那段）。所以它与其他认不出的 mode
  // 走同一条路。
  fs.writeFileSync(secretsOf(dir), JSON.stringify({
    schema: 6, keys: { c1: { mode: 'plain', data: 'PRIVATE-KEY-PEM' } },
  }));

  const got = config.getKey(dir, fakeCrypto(), 'c1');
  assert.equal(got.ok, false, '读出来就等于让那份明文再活一轮');
  assert.match(got.reason, /bad_mode: plain/, '错误里要带上是哪种 mode');

  // 而**另一种**形态（一份全局密钥、根本没有 keys 表）读作「没保存过」：
  // 界面据此生成一把新的，用户重新注册一次 —— 这里把**实际发生的事**钉住，
  // 免得下一个人以为它还读得出来。
  const dir2 = tmpdir();
  fs.writeFileSync(secretsOf(dir2), JSON.stringify({
    schema: 2, mode: 'plain', data: 'PRIVATE-KEY-PEM',
  }));
  assert.equal(config.getKey(dir2, fakeCrypto(), 'c1').reason, 'not_saved');
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

test('★ 老配置里的 `devPlugins` 不再有任何效果（那条路已经删了）', () => {
  const dir = tmpdir();
  // ★ 要钉住的是"读到 `devPlugins` 等于没读到" —— 既不生效，也不报错，也不让
  //   `loadConfig` 多出一个字段来。手改的配置里可能留着这一条，它对客户端没有
  //   任何含义（§5.2 禁止给任何一类插件开免同意的口子）。
  assert.equal(Object.prototype.hasOwnProperty.call(config.DEFAULTS, 'devPlugins'), false,
    '★ 缺省表里不该再有这个键 —— 它没有读者了');
  assert.equal(config.loadConfig(dir).devPlugins, undefined, '缺省下它不该出现');

  // 用户手改的配置里留着一条 `"devPlugins": true`（升级上来的人就是这样）。
  fs.writeFileSync(path.join(dir, 'config.json'),
    JSON.stringify({ schema: 6, devPlugins: true }));
  const cfg = config.loadConfig(dir);
  assert.equal(cfg.devPlugins, undefined,
    '★ 读进来就该是 undefined —— 留着它会让下一个人以为这个开关还有用，然后把它接回某条路上');
  // 而它**不是错误**：老配置不该让客户端起不来，也不该报一条用户看不懂的错。
  assert.equal(cfg.schema, 7, 'schema 照常读出来，配置本身是好的');
});

// ── 钉子：按 id 记的签名公钥（§5.4）─────────────────────────────────────────

test('★ 钉子表是**单独一个文件** —— 旧版本不认识它，也就抹不掉它', () => {
  const dir = tmpdir();
  const FP = 'a'.repeat(64);
  assert.deepEqual(config.loadPinnedKeys(dir), {}, '还没钉过 ⇒ 空表');

  const pins = config.loadPinnedKeys(dir);
  assert.equal(config.pinPluginKey(dir, pins, 'PLUG', FP).ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'pinned-keys.json')), true);
  // ★ 关键的一条：它**不在** config.json 里。放进那里的话，一个只认已知键的客户端
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

// ── 台账的算法版本（`alg`）──────────────────────────────────────────────────

test('★ 台账记下**是哪一个公式**算的那个摘要，而不同公式的值不许互相作证', () => {
  // ★ 摘要是**一个函数的结果**。函数换了公式之后，把新值与旧值放在一起比就是
  //   一句假话 —— 界面上那句"内容摘要从 X 变成了 Y"会说"内容变了"，而真相是
  //   "我们换了一把尺子"。
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  config.trustPlugin(dir, cfg, 'P', '1.0.0', 'a'.repeat(64), 'site');
  assert.equal(cfg.trustedPlugins['P@1.0.0'].alg, config.TRUST_ALG,
    '★ 写下去的时候必须带上当前公式的版本');

  // 落盘之后再读回来，`alg` 要活着（否则它只在内存里有效，那等于没有）。
  const back = config.loadConfig(dir);
  assert.equal(back.trustedPlugins['P@1.0.0'].alg, config.TRUST_ALG);
  assert.equal(config.isTrusted(back, 'P', '1.0.0', 'a'.repeat(64)), true);

  // ★ 而一条**不同公式**的记录：摘要就算**逐字节相同**也不许通过。
  //   这一条是这套字段的全部要点 —— 值相同而尺子不同，仍然不可比。
  const cfg2 = config.loadConfig(dir);
  cfg2.trustedPlugins['P@1.0.0'].alg = config.TRUST_ALG + 1;
  assert.equal(config.isTrusted(cfg2, 'P', '1.0.0', 'a'.repeat(64)), false,
    '★ 换过公式的记录不能给新公式算出来的值作证 —— 那会变成"静默地沿用一次旧同意"');
});

test('★ 老的台账条目（没有 alg）按**当时那个公式**解释，不是"当前公式"', () => {
  // ★ 这个字段是在公式**没变**的那一版里加进来的，所以"没有 alg"只能解释成
  //   "当时那个公式"。默认成"当前公式"的话，换公式那天所有老条目都会被读成新
  //   公式 —— 而那正是这套字段要防的事（一次静默的沿用）。
  const dir = tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    schema: 6,
    trustedPlugins: {
      'OLD@1.0.0': { digest: 'b'.repeat(64), site: 'site', at: 1 },
      'WEIRD@1.0.0': { digest: 'c'.repeat(64), site: 'site', at: 1, alg: '二' },
    },
  }));
  const cfg = config.loadConfig(dir);
  assert.equal(cfg.trustedPlugins['OLD@1.0.0'].alg, config.TRUST_ALG_LEGACY);
  assert.equal(cfg.trustedPlugins['WEIRD@1.0.0'].alg, config.TRUST_ALG_LEGACY,
    'alg 认不出的**保留条目**（丢掉会让界面只会说"没同意过"），但按老公式解释');
  // 而只要当前公式还是 1，它们就照旧有效 —— 加这个字段**不**让任何一条旧同意失效。
  assert.equal(config.isTrusted(cfg, 'OLD', '1.0.0', 'b'.repeat(64)), true,
    '★ 加一个字段不该让用户重新同意一遍');
});

test('★★ §5.3 撤回同意：删掉台账那一条，且**如实报告**删没删到', () => {
  const dir = tmpdir();
  const cfg = config.loadConfig(dir);
  config.trustPlugin(dir, cfg, 'P', '1.0.0', 'a'.repeat(64), 'site');
  config.trustPlugin(dir, cfg, 'P', '1.0.1', 'b'.repeat(64), 'site');

  const r = config.forgetPlugin(dir, cfg, 'P', '1.0.0');
  assert.deepEqual(r, { ok: true, had: true });
  assert.equal(config.isTrusted(cfg, 'P', '1.0.0', 'a'.repeat(64)), false,
    '★ 撤回之后它必须重新走一遍同意闸');
  assert.equal(config.isTrusted(cfg, 'P', '1.0.1', 'b'.repeat(64)), true,
    '只动那一条，别的版本不受影响');

  // 落盘了才算数（不落盘的话，重启之后"它自己回来了"）。
  assert.equal(config.isTrusted(config.loadConfig(dir), 'P', '1.0.0', 'a'.repeat(64)), false);

  // ★ 本来就有的那条**不在了** ⇒ `had: false`。调用方拿它区分"用户撤回了"与
  //   "本来就没人同意过" —— 后者不该产生一句"你的同意作废了"。
  assert.deepEqual(config.forgetPlugin(dir, cfg, 'P', '9.9.9'), { ok: true, had: false });
  assert.deepEqual(config.forgetPlugin(dir, cfg, 'NOPE', '1.0.0'), { ok: true, had: false });

  // ★ 而撤回**不许**碰钉子表（承重·六：合并两者 = 分身判据有了一个重置按钮）。
  const pins = config.loadPinnedKeys(dir);
  config.pinPluginKey(dir, pins, 'P', 'e'.repeat(64));
  const before = fs.readFileSync(path.join(dir, 'pinned-keys.json'), 'utf8');
  config.forgetPlugin(dir, cfg, 'P', '1.0.1');
  assert.equal(fs.readFileSync(path.join(dir, 'pinned-keys.json'), 'utf8'), before,
    '★ 撤回同意一个字节都不许动钉子');
});
