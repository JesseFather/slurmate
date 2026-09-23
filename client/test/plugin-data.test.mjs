/**
 * plugin-data.test.mjs —— 插件**运行时数据**的身份（`plugin-data.js`）。
 *
 * 这一份要钉住的东西只有两样，而它们都是**缺省值**：
 *
 *   · 不声明 `inherit` ⇒ 身份里带**版本号**（每个版本各一份，新版本读不到旧数据）；
 *   · 不声明 `perInstance` ⇒ 身份里**没有实例段**（所有实例一份，于是天然不许
 *     同时开两份 —— 同一个目录两份写是静默损坏，而两边都以为自己成功了）。
 *
 * ★ 两个缺省都在安全侧，而安全侧的东西**特别容易被改坏却全绿**：一个"永远共享"
 *   的实现能让所有"共享"的用例照常通过，只有这两条会红。所以它们是这一份的主体，
 *   不是补充。
 *
 * 后半段是**清单校验**（`contributes.data` 那一段）。它测的是"作者写错了会怎样"：
 * 这一段的每一条都要求**报错里说出真正的原因** —— 那是"插件装上了却不生效"这个
 * 症状唯一的线索来源。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pluginData = require('../src/main/plugin-data.js');
const P = require('../src/main/plugins/index.js');

/** code-server 的 id。用真的那一个，"身份里带的是这个插件的 id"读起来才不像巧合。 */
const ID = '01M2JKHTZGKJBFQQTWYXMQMF2V';

/** 一个注册表里的插件对象该有的样子（只列身份要用的那几项）。 */
const plugin = (over = {}) => ({
  id: ID, name: 'code-server', version: '1.0.0',
  contributes: { layout: true, data: null },
  ...over,
});

/** 声明了分实例的那一个 —— code-server 真实的样子。 */
const perInstance = (over = {}) => plugin({
  contributes: { layout: true, data: { inherit: 'editor', perInstance: true } },
  ...over,
});

const partitionOf = (p, instance) =>
  pluginData.partitionOf(pluginData.identityOf(p, instance));

// ── 缺省：两个都在安全侧 ────────────────────────────────────────────────────

test('★ 缺省之一：不声明 inherit ⇒ 身份里带版本号（每个版本各一份）', () => {
  const a = plugin({ version: '1.0.0' });
  const b = plugin({ version: '1.0.1' });

  assert.deepEqual(pluginData.identityOf(a), [ID, '1.0.0']);
  // ★ 这一条是**安全侧**：新版本拿不到旧版本的数据。反过来（默认继承）会让一个
  //   改过数据格式的新版本读到自己读不懂的东西，而用户看到的是一片错乱的界面，
  //   不是一句"升级之后要重配"。
  assert.deepEqual(pluginData.identityOf(b), [ID, '1.0.1']);
  assert.notEqual(partitionOf(a), partitionOf(b),
    '没声明共享的两个版本必须是两份存储 —— 默认继承是一个**静默**读错数据的实现');

  // data 写了、但里面没有 inherit，与完全没写是同一件事（缺省就是缺省）。
  const empty = plugin({ contributes: { layout: true, data: {} } });
  assert.deepEqual(pluginData.identityOf(empty), [ID, '1.0.0']);
});

test('★ 缺省之二：不声明 perInstance ⇒ 身份里没有实例段（所有实例一份）', () => {
  const p = plugin();
  assert.deepEqual(pluginData.identityOf(p, 'l0123456789ab'), [ID, '1.0.0'],
    '★ 实例段**整段不存在** —— 不是"用一个常量占位"');
  // ★ 这一格就是「同一个插件不许同时开两份」那条规则的来源：实例不同而身份相同
  //   ⇒ 两份会话写的是同一个目录。它是缺省的**推论**，不是另焊上去的一条限制。
  assert.equal(partitionOf(p, 'l0123456789ab'), partitionOf(p, 'lffffffffffff'),
    '没声明分实例的插件，哪个实例来都是同一份存储');
  assert.equal(pluginData.hasInstance(p), false);
});

test('声明了 perInstance ⇒ 每个实例一份，且插件的完整身份进分区名', () => {
  const p = perInstance();
  assert.equal(pluginData.hasInstance(p), true);
  assert.deepEqual(pluginData.identityOf(p, 'l0123456789ab'),
    [ID, 'editor', 'l0123456789ab']);
  assert.equal(partitionOf(p, 'l0123456789ab'),
    `persist:${ID}@editor@l0123456789ab`);
  assert.notEqual(partitionOf(p, 'l0123456789ab'), partitionOf(p, 'lffffffffffff'),
    '两个实例必须是两份存储');
});

test('声明了 inherit ⇒ 同一组的几个版本共用一份（这正是 code-server 保行为的那一条）', () => {
  const a = perInstance({ version: '1.0.0' });
  const b = perInstance({ version: '1.0.1' });
  assert.equal(partitionOf(a, 'l0123456789ab'), partitionOf(b, 'l0123456789ab'),
    '★ 升级不丢布局，靠的就是这一条 —— 而它今天是从清单里读出来的，'
    + '从前是硬编码在 ensureSurface 的三元表达式里的');
  // 换了组就是另一份存储（实例轴仍然独立于版本轴）。
  assert.notEqual(partitionOf(a, 'l0123456789ab'), partitionOf(a, 'lffffffffffff'));
});

test('★ 别的插件共用同一个组名，也不会共用同一份存储', () => {
  // 组名是**作者自己起的**，两个插件正好都叫 editor 是完全正常的。分区名的头一段
  // 是插件 id，所以它们不会撞 —— 少了这一段（从前 `persist:layout-<组 id>` 就只有
  // 末段），两个声明了 layout 的插件共用一个组时会读写同一份存储。
  const other = perInstance({ id: '01M2JKHTZGF12N0T9CB3XVK36H', name: 'sshd' });
  assert.notEqual(partitionOf(perInstance(), 'l0123456789ab'),
    partitionOf(other, 'l0123456789ab'));
});

test('★ 声明了 perInstance 却拿不到实例 ⇒ 抛，不回落成两段', () => {
  const p = perInstance();
  for (const bad of [undefined, null, '']) {
    assert.throws(() => pluginData.identityOf(p, bad), /perInstance/,
      `实例是 ${JSON.stringify(bad)} 时必须停下来 —— 回落成两段会让所有实例`
      + '静默地共用一份数据，而两边都以为自己写进去了');
  }
  // 报错要点出**是哪个插件**：池里可以并存同一个插件的多个版本，只说"缺实例"
  // 指不回那一份清单。
  assert.throws(() => pluginData.identityOf(p, null), /code-server/);
});

// ── 磁盘上的那个名字（对账要读它）────────────────────────────────────────────

test('★ 磁盘上的目录名 = 分区名去掉前缀、**ASCII 折叠**（id 那一段是小写）', () => {
  // Electron 44 的 `MakePartitionName` = `EscapePath(ToLowerASCII(分区名))`。
  assert.equal(pluginData.foldAscii('01M2ABC'), '01m2abc', 'A-Z 各减 32，别的原样');
  assert.equal(pluginData.diskNameOf(['01M2ABC', 'editor', 'l0123456789ab']),
    '01m2abc@editor@l0123456789ab');
  // ★ 折叠是对**整个字符串**做的（`MakePartitionName` 就是这样），而合法的那三段里
  //   只有 id 会变 —— 另外两段的字符集本来就只允许小写。这里钉的是"折叠本身作用于
  //   整串"，免得有人以为它只折第一段，然后按"只折第一段"去改它。
  assert.equal(pluginData.diskNameOf(['01M2ABC', 'EDITOR', 'L0ABCDEF1234']),
    '01m2abc@editor@l0abcdef1234');
});

// ── 插件数据目录的那个名字（对账的第二个根要读它）────────────────────────────

test('★ 数据目录名是**一个名字**（不含分隔符）—— 两份身份因此永远是兄弟', () => {
  const two = pluginData.dataDirNameOf(['01M2ABC', 'editor']);
  const three = pluginData.dataDirNameOf(['01M2ABC', 'editor', 'l0123456789ab']);
  assert.equal(two, '01m2abc@editor');
  assert.equal(three, '01m2abc@editor@l0123456789ab');
  // ★ 这条断言就是全部。名字里没有分隔符 ⇒ `path.join(根, 名字)` 得到的两个目录
  //   落在**同一个父目录**下。而如果改成三层目录（`<id>/<组>/<实例>`），`three`
  //   就会落在 `two` **里面** —— 而这两份身份**真的会同时存在**：同一个插件 1.0.0
  //   声明 `{inherit:'editor'}`（两段）、2.0.0 声明 `{inherit:'editor',perInstance}`
  //   （三段），`inherit` 的语义正是"这几个版本共享一份"。那时"删掉没人用的
  //   editor 那一份"会把 2.0.0 那份**正在用的**连根删掉，而两边都不报错。
  assert.ok(!two.includes('/') && !two.includes('\\'), '名字里不能有路径分隔符');
  assert.ok(!three.includes('/') && !three.includes('\\'), '名字里不能有路径分隔符');
});

test('★ 两个根下的同一个身份必须同名（对账只有一张"该有的"表）', () => {
  for (const id of [['01M2ABC'], ['01M2ABC', 'editor'],
    ['01M2ABC', 'editor', 'l0123456789ab']]) {
    assert.equal(pluginData.dataDirNameOf(id), pluginData.diskNameOf(id),
      '分区根与数据根下的同一个身份必须叫同一个名字 —— 对账把两个根放在一起做差，'
      + '靠的就是它。这条红了说明有人只改了其中一个函数。');
  }
});

test('★ 折叠是单射：两个不同的 ULID 折不出同一个名字', () => {
  // 不区分大小写的文件系统（macOS / Windows）上，两个身份折成同一个名字就会
  // **共用一个目录**。`ulid.ENCODING` 只有大写，而折叠对"大写字母+数字"是单射，
  // 所以两个不同的 ULID 折不出同一个串 —— 后两段的字符集本来就只允许小写，折不动。
  assert.notEqual(
    pluginData.dataDirNameOf(['01M2JKHTZGF12N0T9CB3XVK36H', 'relay']),
    pluginData.dataDirNameOf(['01M2JKHTZGF12N0T9CB3XVK36W', 'relay']));
  // 而且它是**折叠过**的：拿它再折一次必须不变（幂等）。
  const n = pluginData.dataDirNameOf(['01M2ABC', 'EDITOR']);
  assert.equal(pluginData.foldAscii(n), n);
});

test('★ foldAscii 仍然只有一份实现（plugins/index.js 那一份是 re-export）', () => {
  assert.equal(P.foldAscii, pluginData.foldAscii);
  // ★ 只折 `A..Z`。`İ`（U+0130）与 `K`（U+212A KELVIN）必须原样 —— 用
  //   `toLowerCase()` 会把它们折成别的字符，于是"同一个包在另一台机器上装不上"。
  assert.equal(P.foldAscii('AİK'), 'aİK');
});

/** 磁盘上那一份 id：小写、26 个字符（`ULID` 的折叠形态）。手写，不用被测函数算。 */
const DISK_ID = '01m2jkhtzgkjbfqqtwyxmqmf2v';

test('identityOfDiskName：认得出折叠过的 id 与版本形状的第二段，认不出残缺的', () => {
  assert.deepEqual(pluginData.identityOfDiskName(`${DISK_ID}@editor@l0123456789ab`),
    { id: DISK_ID, group: 'editor', instance: 'l0123456789ab' });
  // ★ 第二段**可以是版本号**（`inherit` 缺席时它就是版本号），而 `1.0.0` 不匹配
  //   `GROUP_RE` —— 这正是"拿逆向解析当判据"会删掉活数据的那条路：一个没声明
  //   `inherit` 的插件，它**当前**那一份存储会被判成"认不出来"。
  assert.deepEqual(pluginData.identityOfDiskName(`${DISK_ID}@1.0.0`),
    { id: DISK_ID, group: '1.0.0', instance: null });

  for (const bad of [
    '', '..', 'editor@l0123456789ab',                    // 第一段不是 ULID
    '01m2abc@editor',                                    // 第一段长度不对
    `${DISK_ID}@editor@l1@l2`, `${DISK_ID}@editor@l1@l2@l3`,   // 段数不对
    `${DISK_ID}@`, `${DISK_ID}@@l0123456789ab`,          // 空段
    DISK_ID,                                             // 只有一段
    `${ID}@editor`,                                      // 大写：磁盘上不会是大写（折叠过）
  ]) {
    assert.equal(pluginData.identityOfDiskName(bad), null,
      `${JSON.stringify(bad)} 不该被认成一份身份`);
  }
});

test('★ 往返：身份 → 磁盘名 → 解回来，三段一个都不丢', () => {
  const a = pluginData.identityOf(perInstance(), 'l0123456789ab');
  const back = pluginData.identityOfDiskName(pluginData.diskNameOf(a));
  assert.deepEqual([back.id, back.group, back.instance],
    [DISK_ID, 'editor', 'l0123456789ab']);

  // 两段的那一种（没声明分实例、也没声明 inherit ⇒ 第二段是版本号）
  const b = pluginData.identityOf({ id: ID, version: '2.3.4', contributes: {} });
  const back2 = pluginData.identityOfDiskName(pluginData.diskNameOf(b));
  assert.deepEqual([back2.id, back2.group, back2.instance], [DISK_ID, '2.3.4', null]);
});

test('★ samePartition：分区名与磁盘名只差折叠 —— 直接比会**恒为假**', () => {
  const id = pluginData.identityOf(perInstance(), 'l0123456789ab');
  const partition = pluginData.partitionOf(id);
  assert.equal(pluginData.samePartition(partition, pluginData.diskNameOf(id)), true);
  // 没折叠的那一份也认（磁盘上不会出现，但判据不该因此漏掉一整格）。
  assert.equal(pluginData.samePartition(partition, `${ID}@editor@l0123456789ab`), true);
  // ★ 这一条是这道判据存在的理由：正被界面用着的那一份**最不能误判**
  //   （当成"没人用"就会把它抽掉，而症状只是「页面莫名其妙坏了」）。
  assert.equal(pluginData.samePartition(partition, 'l0123456789ab'), false);
  assert.equal(pluginData.samePartition('editor@x', 'editor@x'), false, '不是 persist: 前缀');
  assert.equal(pluginData.samePartition(null, 'x'), false);
  assert.equal(pluginData.samePartition(partition, null), false);
});

test('★ 两条判据不是一回事：hasSurface（有没有界面）与 hasLayoutStorage（按不按组）', () => {
  const data = { inherit: 'editor', perInstance: true };
  const surface = { kind: 'web', path: '/' };
  const cases = [
    // [contributes, hasSurface, hasLayoutStorage]
    [{ surface, layout: true, data }, true, true],
    // 没有界面 ⇒ 从来没有分区（ensureSurface 第一行就返回了）
    [{ layout: true, data }, false, false],
    // ★ 有界面、但**没**声明分实例：它**照样有一份分区**，只是不按布局组分。
    //   回收一个组时不该清它（那是它唯一的一份），而对账必须把它算进"该有的"
    //   —— 用 hasLayoutStorage 当对账的入口，会让**它活着的那一份**看起来像孤儿，
    //   而界面上会给它一个删除按钮。
    [{ surface, layout: true, data: { inherit: 'editor' } }, true, false],
    [{ surface, layout: true, data: null }, true, false],
  ];
  for (const [contributes, wantSurface, wantLayout] of cases) {
    const p = { id: ID, version: '1.0.0', contributes };
    assert.equal(pluginData.hasSurface(p), wantSurface, JSON.stringify(contributes));
    assert.equal(pluginData.hasLayoutStorage(p), wantLayout, JSON.stringify(contributes));
  }
  assert.equal(pluginData.hasSurface(null), false);
  assert.equal(pluginData.hasLayoutStorage(null), false);
});

// ── 清单校验：contributes.data ──────────────────────────────────────────────

/** 一份最小合法清单，`over` 里的东西直接盖上去。 */
function manifest(over = {}) {
  return {
    id: ID, name: 'code-server', displayName: '开发环境', version: '1.0.0',
    contributes: { layout: true },
    ...over,
  };
}

/** 写进一个临时目录，然后走一遍**真的**校验器（不模拟它）。 */
function inspect(mf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-pd-'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(mf, null, 2));
  return P.inspectDir(dir);
}

/** 一份**有界面、要布局**的清单，只换 `data` 那一段。 */
const accept = (data) => inspect(manifest({ contributes: { layout: true, data } }));
const reject = (data) => {
  const r = accept(data);
  assert.ok(r.error, `这份声明必须被拒：${JSON.stringify(data)}`);
  return r.error;
};

test('contributes.data：合法的收下，并且**规整成固定形状**', () => {
  const r = accept({ inherit: 'editor', perInstance: true });
  assert.ok(!r.error, `这份是合法的：${r.error}`);
  assert.deepEqual(r.entry.plugin.contributes.data,
    { inherit: 'editor', perInstance: true });

  // data 缺席 ⇒ null。"这个插件没声明"与"声明了一个空的"在这一层**不合并** ——
  // 缺省怎么回落是 plugin-data.js 的事，在这里填实等于把那条规则抄成第二份。
  const none = inspect(manifest({ contributes: { layout: true } }));
  assert.equal(none.entry.plugin.contributes.data, null);

  // 只写一半也要规整成两段都在，少一段的读者会拿到 undefined。
  const half = accept({ inherit: 'editor' });
  assert.deepEqual(half.entry.plugin.contributes.data,
    { inherit: 'editor', perInstance: false });
});

test('contributes.data：形状不对的一份都收不下，且报错说得清是哪一条', () => {
  // 不是对象
  assert.match(reject('editor'), /必须是一个对象/);
  assert.match(reject(['editor']), /必须是一个对象/);
  // 认不得的键 —— 打错一个键名不该静默变成一个"配了但不生效"的插件
  assert.match(reject({ inheritTo: 'editor' }), /认不得的键：inheritTo/);
  assert.match(reject({ inherit: 'editor', perInstance: true, copy: 'x' }),
    /认不得的键：copy/);
  // 组名的字符集（它进分区名 = 磁盘目录名）
  for (const bad of ['..', 'a/b', 'Editor', '有中文', '-lead', '', 'a'.repeat(33)]) {
    assert.match(reject({ inherit: bad }), /inherit 必须匹配/,
      `${JSON.stringify(bad)} 不是一个能进路径的组名`);
  }
  // perInstance 的类型
  assert.match(reject({ perInstance: 'true' }), /perInstance 必须是 true 或 false/);
  assert.match(reject({ perInstance: 1 }), /perInstance 必须是 true 或 false/);
});

test('contributes.data：★ perInstance 要求同时有 layout —— 没有组就没有实例可指', () => {
  // ★ 这一条是**组合**判定：两半各自都没错，错在放一起。实例键今天只有一个来源
  //   ——布局组。没有布局组就没有"每个实例一份"可指，而"声明了却指不出来"只会在
  //   开会话时变成一个说不清的下场，所以它判在**装之前**（与 engines 同一条纪律）。
  const noLayout = inspect(manifest({
    contributes: { layout: false, data: { perInstance: true } },
  }));
  assert.match(noLayout.error || '', /perInstance 要求同时有 contributes\.layout/);

  // 而 layout: true 的那一份照常收下 —— 否则上面那一条会因为"什么都拒"而全绿。
  const ok = inspect(manifest({
    contributes: { layout: true, data: { perInstance: true } },
  }));
  assert.ok(!ok.error, `这一份是合法的：${ok.error}`);

  // ★ 反例也要钉：layout 那一段自己写错了（这里是字符串）时，报的必须是
  //   "layout 必须是 true 或 false"，而不是被这一条抢先说成"perInstance 缺 layout"
  //   —— 后者会把用户指去改一个本来没错的地方。
  const badLayout = inspect(manifest({
    contributes: { layout: 'true', data: { perInstance: true } },
  }));
  assert.match(badLayout.error, /contributes\.layout 必须是 true 或 false/);
});

test('contributes.data：一个声明都不写的插件是**正常**的（缺省就在安全侧）', () => {
  // sshd 就是这样：它没有界面、落盘那几个文件是可丢弃的缓存，所以它一个字都不用
  // 声明。这一条钉的是"不声明必须合法" —— 若哪一天 data 变成必填，插件作者会收到
  // 一条他无从回答的要求。
  const r = inspect({
    id: '01M2JKHTZGF12N0T9CB3XVK36H', name: 'sshd', displayName: 'SSH 中转站',
    version: '1.0.0', contributes: { layout: false },
  });
  assert.ok(!r.error, `不声明 data 必须合法：${r.error}`);
  assert.equal(r.entry.plugin.contributes.data, null);
});
