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
 * plugin-data.test.mjs —— 插件**运行时数据**的身份（`plugin-data.js`）。
 *
 * 这一份要钉住的东西只有两样，而它们分属**两种不同的形状**：
 *
 *   · **共享组**那一格有**缺省**（两个键都不写 ⇒ 一个常量共享组名，所有版本共用一份）
 *     —— 两个方向基座都填得出来，所以缺省可以填，取哪一边是一个**产品判断**。
 *   · `concurrent` **没有缺省**（作者必须写：能同时开两份，还是只能开一份）——
 *     "你的代码能不能同时处理两份"只有作者知道。`false` ⇒ 身份里**没有实例段**
 *     （同一个目录两份写是静默损坏，而两边都以为自己成功了）。
 *
 * ★★ 共享组那一格**翻过一次边**（v0.12：每个版本一份 → 继承），所以这一份里钉得最
 *   死的是**三态各自算出来的第二段**：两个都不写、写 `inherit`、写 `perVersion`。
 *   少钉任何一边，"缺省"都会悄悄退回到另一个值上，而"声明了 inherit"的那些用例
 *   照样全绿 —— 这正是这条轴最容易出的错。
 *
 * 后半段是**清单校验**（`contributes.data` 与 `contributes.concurrent`）。它测的是
 * "作者写错了会怎样"：这一段的每一条都要求**报错里说出真正的原因** —— 那是
 * "插件装上了却不生效"这个症状唯一的线索来源。
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
  contributes: { layout: true, concurrent: false, data: null },
  ...over,
});

/** 声明了能同时开两份的那一个 —— code-server 真实的样子。 */
const concurrent = (over = {}) => plugin({
  contributes: { layout: true, concurrent: true, data: { inherit: 'editor' } },
  ...over,
});

const partitionOf = (p, instance) =>
  pluginData.partitionOf(pluginData.identityOf(p, instance));

// ── 共享组那一格（有缺省）：两个键都不写 / inherit / perVersion ──────────────

test('★★ 缺省：两个键都不写 ⇒ 共用一份，第二段是一个**常量**（不是版本号）', () => {
  const a = plugin({ version: '1.0.0' });
  const b = plugin({ version: '1.0.1' });

  // ★ 第一句钉**取值**：第二段是那个常量。一个"缺省仍然是版本号"的实现到这里就红。
  assert.deepEqual(pluginData.identityOf(a), [ID, pluginData.DEFAULT_GROUP]);
  assert.deepEqual(pluginData.identityOf(b), [ID, pluginData.DEFAULT_GROUP]);
  // ★ 第二句钉**后果**：升级不换存储 —— 这正是翻缺省要买的东西。★ 而它的代价
  //   （一个改过数据格式的新版本会读到旧格式的东西）写在 plugin-data.js 的文件头，
  //   出口是 `perVersion: true`（见下一条）。
  assert.equal(partitionOf(a), partitionOf(b),
    '缺省是**继承**：同一个插件的两个版本必须落在同一份存储上');

  // `data` 写了、但两个键都不写，与完全没写、与写成 null 都是同一件事 ——
  // ★ "缺省"不是**第三档**，它就是这个取值（所以没有"半个声明"这种状态）。
  for (const data of [{}, null, undefined]) {
    const p = plugin({ contributes: { layout: true, concurrent: false, data } });
    assert.deepEqual(pluginData.identityOf(p), [ID, pluginData.DEFAULT_GROUP],
      `data = ${JSON.stringify(data)} 必须落在缺省上`);
  }
});

test('★ 缺省那个常量本身必须是个**合法的共享组名**（它进磁盘目录名）', () => {
  assert.match(pluginData.DEFAULT_GROUP, pluginData.GROUP_RE,
    '改名改出格 ⇒ 磁盘上会出现一个 identityOfDiskName 认不出的段');
  // ★ 它与"作者显式写了这个名字"**同义** —— 缺省不是一种特殊状态，只是这个取值。
  const explicit = plugin({ contributes: { layout: true, concurrent: false,
    data: { inherit: pluginData.DEFAULT_GROUP } } });
  assert.deepEqual(pluginData.identityOf(explicit), pluginData.identityOf(plugin()));
});

test('★ perVersion: true ⇒ 每个版本各一份（这是**从前那个缺省**，现在要明写）', () => {
  const decl = (v) => plugin({ version: v,
    contributes: { layout: true, concurrent: false, data: { perVersion: true } } });

  assert.deepEqual(pluginData.identityOf(decl('1.0.0')), [ID, '1.0.0'],
    '★ 第二段是**版本号** —— 所以它未必匹配 GROUP_RE，这正是 identityOfDiskName 不猜的原因');
  assert.notEqual(partitionOf(decl('1.0.0')), partitionOf(decl('1.0.1')),
    '声明的就是"升级换一份"：新版本读不到旧数据');
  // ★ 与缺省**必须**不同 —— 否则这个键是个摆设，而上面那两句照样绿。
  assert.notEqual(pluginData.identityOf(decl('1.0.0'))[1],
    pluginData.identityOf(plugin())[1],
    'perVersion 与缺省必须落在两份不同的存储上');

  // 显式写 false 与不写它同义（那一格不是三态，是"要/不要"）。
  const off = plugin({ contributes: { layout: true, concurrent: false,
    data: { perVersion: false } } });
  assert.deepEqual(pluginData.identityOf(off), [ID, pluginData.DEFAULT_GROUP]);
});

test('★ concurrent: false ⇒ 身份里没有实例段（那个插件同时只有一份）', () => {
  const p = plugin();
  assert.deepEqual(pluginData.identityOf(p, 'w0123456789ab'),
    [ID, pluginData.DEFAULT_GROUP],
    '★ 实例段**整段不存在** —— 不是"用一个常量占位"');
  // ★ 这一格就是「不能多开的插件不许同时开两份」那条规则的来源：实例不同而身份相同
  //   ⇒ 两份会话写的是同一个目录。它是声明 `false` 的**推论**，不是另焊上去的限制。
  assert.equal(partitionOf(p, 'w0123456789ab'), partitionOf(p, 'wffffffffffff'),
    '不能多开的插件，哪个实例来都是同一份存储');
  assert.equal(pluginData.hasInstance(p), false);
});

test('声明了 concurrent: true ⇒ 每个实例一份，且插件的完整身份进分区名', () => {
  const p = concurrent();
  assert.equal(pluginData.hasInstance(p), true);
  assert.deepEqual(pluginData.identityOf(p, 'w0123456789ab'),
    [ID, 'editor', 'w0123456789ab']);
  assert.equal(partitionOf(p, 'w0123456789ab'),
    `persist:${ID}@editor@w0123456789ab`);
  assert.notEqual(partitionOf(p, 'w0123456789ab'), partitionOf(p, 'wffffffffffff'),
    '两个实例必须是两份存储');
});

test('声明了 inherit ⇒ 同一组的几个版本共用一份（这正是 code-server 保行为的那一条）', () => {
  const a = concurrent({ version: '1.0.0' });
  const b = concurrent({ version: '1.0.1' });
  assert.equal(partitionOf(a, 'w0123456789ab'), partitionOf(b, 'w0123456789ab'),
    '★ 升级不丢布局，靠的就是这一条 —— 而它今天是从清单里读出来的，'
    + '从前是硬编码在 ensureSurface 的三元表达式里的');
  // 换了工作区就是另一份存储（实例轴仍然独立于版本轴）。
  assert.notEqual(partitionOf(a, 'w0123456789ab'), partitionOf(a, 'wffffffffffff'));
});

test('★ 别的插件共用同一个共享组名，也不会共用同一份存储', () => {
  // 共享组名是**作者自己起的**，两个插件正好都叫 editor 是完全正常的。分区名的头一段
  // 是插件 id，所以它们不会撞 —— 少了这一段（只有末段），
  // 两个声明了 layout 的插件共用一个工作区时会读写同一份存储。
  const other = concurrent({ id: '01M2JKHTZGF12N0T9CB3XVK36H', name: 'sshd' });
  assert.notEqual(partitionOf(concurrent(), 'w0123456789ab'),
    partitionOf(other, 'w0123456789ab'));
});

test('★ 声明了 concurrent: true 却拿不到实例 ⇒ 抛，不回落成两段', () => {
  const p = concurrent();
  for (const bad of [undefined, null, '']) {
    assert.throws(() => pluginData.identityOf(p, bad), /concurrent/,
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
  assert.equal(pluginData.diskNameOf(['01M2ABC', 'editor', 'w0123456789ab']),
    '01m2abc@editor@w0123456789ab');
  // ★ 折叠是对**整个字符串**做的（`MakePartitionName` 就是这样），而合法的那三段里
  //   只有 id 会变 —— 另外两段的字符集本来就只允许小写。这里钉的是"折叠本身作用于
  //   整串"，免得有人以为它只折第一段，然后按"只折第一段"去改它。
  assert.equal(pluginData.diskNameOf(['01M2ABC', 'EDITOR', 'L0ABCDEF1234']),
    '01m2abc@editor@l0abcdef1234');
});

// ── 插件数据目录的那个名字（对账的第二个根要读它）────────────────────────────

test('★ 数据目录名是**一个名字**（不含分隔符）—— 两份身份因此永远是兄弟', () => {
  const two = pluginData.dataDirNameOf(['01M2ABC', 'editor']);
  const three = pluginData.dataDirNameOf(['01M2ABC', 'editor', 'w0123456789ab']);
  assert.equal(two, '01m2abc@editor');
  assert.equal(three, '01m2abc@editor@w0123456789ab');
  // ★ 这条断言就是全部。名字里没有分隔符 ⇒ `path.join(根, 名字)` 得到的两个目录
  //   落在**同一个父目录**下。而如果改成三层目录（`<id>/<共享组>/<实例>`），`three`
  //   就会落在 `two` **里面** —— 而这两份身份**真的会同时存在**：同一个插件 1.0.0
  //   声明 `{inherit:'editor'}`（两段）、2.0.0 声明 `{inherit:'editor',concurrent}`
  //   （三段），`inherit` 的语义正是"这几个版本共享一份"。那时"删掉没人用的
  //   editor 那一份"会把 2.0.0 那份**正在用的**连根删掉，而两边都不报错。
  assert.ok(!two.includes('/') && !two.includes('\\'), '名字里不能有路径分隔符');
  assert.ok(!three.includes('/') && !three.includes('\\'), '名字里不能有路径分隔符');
});

test('★ 两个根下的同一个身份必须同名（对账只有一张"该有的"表）', () => {
  for (const id of [['01M2ABC'], ['01M2ABC', 'editor'],
    ['01M2ABC', 'editor', 'w0123456789ab']]) {
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
  assert.deepEqual(pluginData.identityOfDiskName(`${DISK_ID}@editor@w0123456789ab`),
    { id: DISK_ID, group: 'editor', instance: 'w0123456789ab' });
  // ★ 第二段**可以是版本号**（声明了 `data.perVersion: true` 的插件就是），而
  //   `1.0.0` 不匹配 `GROUP_RE` —— 这正是"拿逆向解析当判据"会删掉活数据的那条路：
  //   一个 `perVersion` 的插件，它**当前**那一份存储会被判成"认不出来"。
  assert.deepEqual(pluginData.identityOfDiskName(`${DISK_ID}@1.0.0`),
    { id: DISK_ID, group: '1.0.0', instance: null });

  for (const bad of [
    '', '..', 'editor@w0123456789ab',                    // 第一段不是 ULID
    '01m2abc@editor',                                    // 第一段长度不对
    `${DISK_ID}@editor@l1@l2`, `${DISK_ID}@editor@l1@l2@l3`,   // 段数不对
    `${DISK_ID}@`, `${DISK_ID}@@w0123456789ab`,          // 空段
    DISK_ID,                                             // 只有一段
    `${ID}@editor`,                                      // 大写：磁盘上不会是大写（折叠过）
  ]) {
    assert.equal(pluginData.identityOfDiskName(bad), null,
      `${JSON.stringify(bad)} 不该被认成一份身份`);
  }
});

test('★ 往返：身份 → 磁盘名 → 解回来，三段一个都不丢', () => {
  const a = pluginData.identityOf(concurrent(), 'w0123456789ab');
  const back = pluginData.identityOfDiskName(pluginData.diskNameOf(a));
  assert.deepEqual([back.id, back.group, back.instance],
    [DISK_ID, 'editor', 'w0123456789ab']);

  // 两段的那一种，而第二段**两种取值都要走一遍**：
  //   · 缺省 ⇒ 常量共享组名；
  //   · `perVersion` ⇒ 版本号，★ 它不匹配 `GROUP_RE`，所以往返里它是承重的那一份
  //     （"认得出"与"长得像共享组名"是两件事，`identityOfDiskName` 只要求前者）。
  const def = pluginData.identityOf({ id: ID, version: '2.3.4', contributes: {} });
  const back2 = pluginData.identityOfDiskName(pluginData.diskNameOf(def));
  assert.deepEqual([back2.id, back2.group, back2.instance],
    [DISK_ID, pluginData.DEFAULT_GROUP, null]);

  const pv = pluginData.identityOf({ id: ID, version: '2.3.4',
    contributes: { data: { perVersion: true } } });
  const back3 = pluginData.identityOfDiskName(pluginData.diskNameOf(pv));
  assert.deepEqual([back3.id, back3.group, back3.instance], [DISK_ID, '2.3.4', null]);
});

test('★ samePartition：分区名与磁盘名只差折叠 —— 直接比会**恒为假**', () => {
  const id = pluginData.identityOf(concurrent(), 'w0123456789ab');
  const partition = pluginData.partitionOf(id);
  assert.equal(pluginData.samePartition(partition, pluginData.diskNameOf(id)), true);
  // 没折叠的那一份也认（磁盘上不会出现，但判据不该因此漏掉一整格）。
  assert.equal(pluginData.samePartition(partition, `${ID}@editor@w0123456789ab`), true);
  // ★ 这一条是这道判据存在的理由：正被界面用着的那一份**最不能误判**
  //   （当成"没人用"就会把它抽掉，而症状只是「页面莫名其妙坏了」）。
  assert.equal(pluginData.samePartition(partition, 'w0123456789ab'), false);
  assert.equal(pluginData.samePartition('editor@x', 'editor@x'), false, '不是 persist: 前缀');
  assert.equal(pluginData.samePartition(null, 'x'), false);
  assert.equal(pluginData.samePartition(partition, null), false);
});

test('★ 两条判据不是一回事：hasSurface（有没有界面）与 hasWorkspaceStorage（按不按工作区分）', () => {
  const many = { inherit: 'editor' };
  const surface = { kind: 'web', path: '/' };
  const cases = [
    // [contributes, hasSurface, hasWorkspaceStorage]
    [{ surface, layout: true, concurrent: true, data: many }, true, true],
    // 没有界面 ⇒ 从来没有分区（ensureSurface 第一行就返回了）
    [{ layout: true, concurrent: true, data: many }, false, false],
    // ★ 有界面、但**不能多开**：它**照样有一份分区**，只是不按工作区分。
    //   回收一个工作区时不该清它（那是它唯一的一份），而对账必须把它算进"该有的"
    //   —— 用 hasWorkspaceStorage 当对账的入口，会让**它活着的那一份**看起来像孤儿，
    //   而界面上会给它一个删除按钮。
    [{ surface, layout: true, concurrent: false, data: many }, true, false],
    [{ surface, layout: true, concurrent: false, data: null }, true, false],
  ];
  for (const [contributes, wantSurface, wantWorkspace] of cases) {
    const p = { id: ID, version: '1.0.0', contributes };
    assert.equal(pluginData.hasSurface(p), wantSurface, JSON.stringify(contributes));
    assert.equal(pluginData.hasWorkspaceStorage(p), wantWorkspace, JSON.stringify(contributes));
  }
  assert.equal(pluginData.hasSurface(null), false);
  assert.equal(pluginData.hasWorkspaceStorage(null), false);
});

// ── 清单校验：contributes.concurrent 与 contributes.data ────────────────────

/** 一份最小合法清单，`over` 里的东西直接盖上去。 */
function manifest(over = {}) {
  return {
    id: ID, name: 'code-server', displayName: '开发环境', version: '1.0.0',
    contributes: { layout: true, concurrent: false },
    ...over,
  };
}

/** 写进一个临时目录，然后走一遍**真的**校验器（不模拟它）。 */
function inspect(mf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-pd-'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(mf, null, 2));
  return P.inspectDir(dir);
}

/** 一份**有界面、要布局、不能多开**的清单，只换 `data` 那一段。 */
const accept = (data) => inspect(manifest({
  contributes: { layout: true, concurrent: false, data } }));
const reject = (data) => {
  const r = accept(data);
  assert.ok(r.error, `这份声明必须被拒：${JSON.stringify(data)}`);
  return r.error;
};

test('contributes.concurrent：★★ 必填 —— 不写这一格 ⇒ 装不上（不是"当成不能"）', () => {
  // ★ 这一条钉的是"**没有缺省**"，而它与同一个清单里另外两格（layout / submitPubkey）
  //   刻意相反：那两个缺省都在安全侧，基座答得了。
  //   而"你的代码能不能同时处理两份"基座答不了 —— 缺省无论取哪边都是替作者表态。
  const 没写 = inspect(manifest({ contributes: { layout: true } }));
  assert.match(没写.error || '', /contributes\.concurrent 是\*\*必填\*\*/,
    '缺了这一格必须**拒绝安装**，而不是静默当成 false');
  assert.equal(没写.entry, undefined);

  // ★ 反例：写了的照常收下，而且两种取值都收 —— 否则上面那一条会因为"什么都拒"而全绿。
  for (const v of [true, false]) {
    const r = inspect(manifest({ contributes: { layout: true, concurrent: v } }));
    assert.ok(!r.error, `concurrent: ${v} 是合法的：${r.error}`);
    assert.equal(r.entry.plugin.contributes.concurrent, v);
  }

  // 类型不对由那条布尔循环管（与 layout / submitPubkey 同一句措辞）。
  const bad = inspect(manifest({ contributes: { layout: true, concurrent: 'yes' } }));
  assert.match(bad.error, /contributes\.concurrent 必须是 true 或 false/);
});

test('contributes.concurrent：★ 能多开要求 layout —— 没有工作区就没有第二份实例可指', () => {
  // ★ 这一条是**组合**判定：两半各自都没错，错在放一起。实例键今天只有一个来源
  //   ——工作区。没有工作区就没有"第二份实例"可指，所以它判在**装之前**
  //   （与 engines 同一条纪律）。
  const noLayout = inspect(manifest({
    contributes: { layout: false, concurrent: true },
  }));
  assert.match(noLayout.error || '', /concurrent: true 要求同时有 contributes\.layout/);

  // 而 layout: true 的那一份照常收下 —— 否则上面那一条会因为"什么都拒"而全绿。
  const ok = inspect(manifest({ contributes: { layout: true, concurrent: true } }));
  assert.ok(!ok.error, `这一份是合法的：${ok.error}`);

  // ★ 反例也要钉：layout 那一段自己写错了（这里是字符串）时，报的必须是
  //   "layout 必须是 true 或 false"，而不是被这一条抢先说成"concurrent 缺 layout"
  //   —— 后者会把用户指去改一个本来没错的地方。
  const badLayout = inspect(manifest({
    contributes: { layout: 'true', concurrent: true },
  }));
  assert.match(badLayout.error, /contributes\.layout 必须是 true 或 false/);
});

test('contributes.data：合法的收下，并且**规整成固定形状**', () => {
  const r = accept({ inherit: 'editor' });
  assert.ok(!r.error, `这份是合法的：${r.error}`);
  assert.deepEqual(r.entry.plugin.contributes.data,
    { inherit: 'editor', perVersion: false });
  // 两个键、顺序固定 —— 实例那一轴搬到了 `contributes.concurrent`，而这两个键
  // 答的是共享组那一格（`plugin-data.js` 的 `groupOf` 读的就是它们）。
  assert.deepEqual(Object.keys(r.entry.plugin.contributes.data),
    ['inherit', 'perVersion']);

  // data 缺席 ⇒ null。"这个插件没声明"与"声明了一个空的"在这一层**不合并** ——
  // 缺省怎么回落是 plugin-data.js 的事，在这里填实等于把那条规则抄成第二份。
  const none = inspect(manifest());
  assert.equal(none.entry.plugin.contributes.data, null);
});

test('contributes.data：形状不对的一份都收不下，且报错说得清是哪一条', () => {
  // 不是对象
  assert.match(reject('editor'), /必须是一个对象/);
  assert.match(reject(['editor']), /必须是一个对象/);
  // 认不得的键 —— 打错一个键名不该静默变成一个"配了但不生效"的插件
  assert.match(reject({ inheritTo: 'editor' }), /认不得的键：inheritTo/);
  assert.match(reject({ inherit: 'editor', copy: 'x' }), /认不得的键：copy/);
  // 共享组名的字符集（它进分区名 = 磁盘目录名）
  for (const bad of ['..', 'a/b', 'Editor', '有中文', '-lead', '', 'a'.repeat(33)]) {
    assert.match(reject({ inherit: bad }), /inherit 必须匹配/,
      `${JSON.stringify(bad)} 不是一个能进路径的共享组名`);
  }
});

test('★★ contributes.data：perVersion 与 inherit 同时写 ⇒ 拒，且点名两个键', () => {
  // ★ 这是"两半各自都没错、错在放一起"的那一类（与 concurrent 要求 layout 同形）。
  //   不判的话症状是**两个都"成功"**：清单里明明写着共用一份，实际落在哪一份却
  //   取决于 `groupOf` 里两行的先后次序 —— 一个改代码顺序就会变的结论，而没有任何
  //   东西会红。
  const both = reject({ inherit: 'editor', perVersion: true });
  assert.match(both, /perVersion/);
  assert.match(both, /inherit/);
  assert.match(both, /矛盾/);
  assert.match(both, /editor/, '报错要把它读到的那两个值说出来');

  // ★ 反例：只写一个的照常收下 —— 否则上面那一条会因为"什么都拒"而全绿。
  assert.ok(!accept({ perVersion: true }).error, '只写 perVersion 必须合法');
  assert.ok(!accept({ inherit: 'editor', perVersion: false }).error,
    'perVersion: false 与 inherit 不冲突 —— 它说的正是"不要每个版本一份"');
});

test('contributes.data：perVersion 的类型不对 ⇒ 拒，且报错说得出该写什么', () => {
  for (const bad of ['true', 1, null, {}]) {
    assert.match(reject({ perVersion: bad }), /perVersion 必须是 true \/ false/,
      `${JSON.stringify(bad)} 不是一个布尔值`);
  }
});

test('contributes.data：★ 老的 perInstance 得到一句**指路**的报错，不是"认不得的键"', () => {
  // ★ 加一个键名、把另一个键改名，最容易留下的症状是"照着报错改，改完还是错"：
  //   `认不得的键：perInstance` 只说"我不认识它"，不说它现在叫什么、搬到哪儿了。
  const old = reject({ inherit: 'editor', perInstance: true });
  assert.match(old, /perInstance 已经改名成[\s\S]*contributes\.concurrent/);

  // 光有它、别的都没有时也照样指路（这条提示排在 keysProblem **之前**）。
  const only = reject({ perInstance: false });
  assert.match(only, /已经改名成[\s\S]*contributes\.concurrent/);
});

test('contributes.data：一个声明都不写的插件是**正常**的（那一格有缺省）', () => {
  // sshd 就是这样：它落盘那几个文件是可丢弃的缓存，共享组那一格它不用表态。
  // ★ 注意它与 `concurrent` 的差别：那一格**没有**缺省、必须写（见上面第一条），
  //   而这一格不写只是一个保守的选择。
  const r = inspect({
    id: '01M2JKHTZGF12N0T9CB3XVK36H', name: 'sshd', displayName: 'SSH 中转站',
    version: '1.0.0', contributes: { layout: false, concurrent: false },
  });
  assert.ok(!r.error, `不声明 data 必须合法：${r.error}`);
  assert.equal(r.entry.plugin.contributes.data, null);
});

test('★★ slotOf：一个活跃会话占的那个槽（多开的判据就是它）', () => {
  // ★ 这一条是**整个并发层存在与否**的判据：改回"每次都不同"或者"两个不要工作区的插件
  //   各一个槽"都会让它红，而红的方式正是它要防的那件事。
  assert.equal(pluginData.slotOf('w0a1b2c3d4e5'), 'workspace:w0a1b2c3d4e5');

  // ★★ **不要工作区的那一整类共用一个槽** —— 这一档是**故意**粗的，而它现在有
  //    **两层**理由（见 plugin-data.js 的 slotOf 与账本〈保留⑥〉）：
  //    · 架构层：**没有第二份实例键的来源** —— 实例键就是工作区，而这一类不要工作区；
  //    · 作者层：写进用户 ssh 配置的那个别名是插件自己的常量，基座**无从核对**
  //      两个不要工作区的插件的别名会不会撞。
  //    细一档（按插件 id 分槽）会让两个互不认识的不要工作区的插件并存着去抢同一个别名，
  //    而症状是"`ssh slurmate` 连到哪一个是不确定的"，两边都报"已就绪"。
  assert.equal(pluginData.slotOf(null), 'relay');
  assert.equal(pluginData.slotOf(undefined), pluginData.slotOf(null),
    '两个不同的"不要工作区"的插件必须落进同一个槽');

  // 要工作区的：**同一工作区 ⇒ 同槽**（无论是不是同一个插件）；不同工作区 ⇒ 不同槽。
  assert.equal(pluginData.slotOf('l1'), pluginData.slotOf('l1'));
  assert.notEqual(pluginData.slotOf('l1'), pluginData.slotOf('l2'));
  // 要工作区的与不要工作区的，永远是两个槽 —— 那条能力（一个 IDE + 一个终端中转）靠它。
  assert.notEqual(pluginData.slotOf('l1'), pluginData.slotOf(null));
  // 两个槽名不会互撞（前缀把它们挡开了，而工作区 id 是 `l<hex>`，撞不上 `relay`）。
  assert.notEqual(pluginData.slotOf(null), pluginData.slotOf('relay'));
});
