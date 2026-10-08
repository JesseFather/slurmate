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
  contributes: { ports: 1, concurrent: false, data: null },
  ...over,
});

/** 声明了能同时开两份的那一个 —— code-server 真实的样子。 */
const concurrent = (over = {}) => plugin({
  contributes: { ports: 1, concurrent: true, data: { inherit: 'editor' } },
  ...over,
});

/** 不要数据空间的那一个 —— sshd 真实的样子（`ports: 0`）。 */
const relay = (over = {}) => plugin({
  id: '01M2JKHTZGF12N0T9CB3XVK36H', name: 'sshd',
  contributes: { ports: 0, concurrent: false, data: { inherit: 'relay' } },
  ...over,
});

/**
 * 一份**数据**（`config.js` 数据空间那一节的形状）。身份的后两段由它决定，所以
 * 用例里凡是问身份的，都要先有它。
 */
const space = (over = {}) => ({
  id: 's000000000001', pluginId: ID, group: pluginData.DEFAULT_GROUP,
  ports: [18080], ...over,
});

/** 第二段（共享组）—— 清单答得了的那一格。 */
const groupOf = (p) => pluginData.groupOf(p);

const partitionOf = (p, s) => pluginData.partitionOf(pluginData.identityOf(p, s));

// ── 共享组那一格（有缺省）：两个键都不写 / inherit / perVersion ──────────────

test('★★ 缺省：两个键都不写 ⇒ 第二段是一个**常量**（不是版本号）', () => {
  const a = plugin({ version: '1.0.0' });
  const b = plugin({ version: '1.0.1' });

  // ★ 第一句钉**取值**：第二段是那个常量。一个"缺省仍然是版本号"的实现到这里就红。
  assert.equal(groupOf(a), pluginData.DEFAULT_GROUP);
  assert.equal(groupOf(b), pluginData.DEFAULT_GROUP);
  // ★ 第二句钉**后果**：升级不换存储 —— 这正是翻缺省要买的东西。★ 而它的代价
  //   （一个改过数据格式的新版本会读到旧格式的东西）写在 plugin-data.js 的文件头，
  //   出口是 `perVersion: true`（见下一条）。
  assert.equal(partitionOf(a, space()), partitionOf(b, space()),
    '缺省是**继承**：同一个插件的两个版本必须落在同一份存储上');

  // `data` 写了、但两个键都不写，与完全没写、与写成 null 都是同一件事 ——
  // ★ "缺省"不是**第三档**，它就是这个取值（所以没有"半个声明"这种状态）。
  for (const data of [{}, null, undefined]) {
    const p = plugin({ contributes: { ports: 1, concurrent: false, data } });
    assert.equal(groupOf(p), pluginData.DEFAULT_GROUP,
      `data = ${JSON.stringify(data)} 必须落在缺省上`);
  }
});

test('★ 缺省那个常量本身必须是个**合法的共享组名**（它进磁盘目录名）', () => {
  assert.match(pluginData.DEFAULT_GROUP, pluginData.GROUP_RE,
    '改名改出格 ⇒ 磁盘上会出现一个 identityOfDiskName 认不出的段');
  // ★ 它与"作者显式写了这个名字"**同义** —— 缺省不是一种特殊状态，只是这个取值。
  const explicit = plugin({ contributes: { ports: 1, concurrent: false,
    data: { inherit: pluginData.DEFAULT_GROUP } } });
  assert.equal(groupOf(explicit), groupOf(plugin()));
});

test('★ perVersion: true ⇒ 每个版本各一份（这是**从前那个缺省**，现在要明写）', () => {
  const decl = (v) => plugin({ version: v,
    contributes: { ports: 1, concurrent: false, data: { perVersion: true } } });

  assert.equal(groupOf(decl('1.0.0')), '1.0.0',
    '★ 第二段是**版本号** —— 所以它未必匹配 GROUP_RE，这正是 identityOfDiskName 不猜的原因');
  // ★ 第二段变了 ⇒ 存储就变了。而**落盘的那一份 group 由 `spaceFor` 记下来**
  //   （它读的正是 `groupOf`），所以这里把两者都摆出来：清单说了什么，盘上就存什么。
  assert.notEqual(groupOf(decl('1.0.0')), groupOf(decl('1.0.1')),
    '声明的就是"升级换一份"：新版本读不到旧数据');
  assert.notEqual(
    partitionOf(decl('1.0.0'), space({ group: groupOf(decl('1.0.0')) })),
    partitionOf(decl('1.0.1'), space({ group: groupOf(decl('1.0.1')) })),
    '第二段不同 ⇒ 两份存储');
  // ★ 与缺省**必须**不同 —— 否则这个键是个摆设，而上面那两句照样绿。
  assert.notEqual(groupOf(decl('1.0.0')), groupOf(plugin()),
    'perVersion 与缺省必须落在两份不同的存储上');

  // 显式写 false 与不写它同义（那一格不是三态，是"要/不要"）。
  const off = plugin({ contributes: { ports: 1, concurrent: false,
    data: { perVersion: false } } });
  assert.equal(groupOf(off), pluginData.DEFAULT_GROUP);
});

// ── 身份那三段：第二段从清单来（或从那一份数据来），第三段是**那一份数据** ──

test('★★ 要工作区的插件：身份是**三段**，而后两段全由那一份数据说了算', () => {
  const s = space({ id: 's0000000000ab', group: 'editor' });
  assert.deepEqual(pluginData.identityOf(concurrent(), s), [ID, 'editor', 's0000000000ab']);
  assert.equal(pluginData.partitionOf(pluginData.identityOf(concurrent(), s)),
    `persist:${ID}@editor@s0000000000ab`);
  // 两份数据 ⇒ 两份存储。
  assert.notEqual(partitionOf(concurrent(), s),
    partitionOf(concurrent(), space({ id: 's0000000000ff', group: 'editor' })));
});

test('★★ `concurrent` **不再**决定有没有第三段 —— 那是这次重做的中心', () => {
  // ★ 从前第三段由 `contributes.concurrent` 说了算，于是一个**要端口、却声明
  //   不能同时开两份**的插件整台机器上只有一份数据（所有工作区共用一份），
  //   而它本来每个工作区里都该有自己的那一份。现在第三段由 `ports` 决定
  //   （要不要数据空间），`concurrent` 只管"能不能同时开第二份"。
  const s = space({ group: 'editor' });
  const notConcurrent = plugin({
    contributes: { ports: 1, concurrent: false, data: { inherit: 'editor' } } });
  assert.deepEqual(pluginData.identityOf(notConcurrent, s), [ID, 'editor', s.id],
    '★ 不能多开的插件**照样有第三段**');
  // 两份数据就是两份存储 —— 它只是不许两份**同时活着**（那是运行期槽闸的事）。
  assert.notEqual(partitionOf(notConcurrent, s),
    partitionOf(notConcurrent, space({ id: 's0000000000ff', group: 'editor' })));
  // 而"能不能开第二份"这一格仍然只由 concurrent 决定。
  assert.equal(pluginData.canOpenSecond(notConcurrent), false);
  assert.equal(pluginData.canOpenSecond(concurrent()), true);
});

test('★★ 不要数据空间的插件：两段，第二段只能从**清单**来', () => {
  const p = relay();
  assert.deepEqual(pluginData.identityOf(p), [p.id, 'relay'],
    '★ 它根本没有数据对象可问 —— 那一份 `<id>@relay` 不属于任何工作区');
  assert.equal(partitionOf(p), `persist:${p.id}@relay`);
  assert.equal(pluginData.needsSpace(p), false);
  // ★ 拿一份数据去问它也是两段（它不按数据分），但那不是一条会走到的路 ——
  //   所以这里不钉它，免得把"不该发生的事"写成一条保证。
});

test('★★ 要数据空间却拿不到那一份 ⇒ 抛，不回落成两段', () => {
  const p = concurrent();
  for (const bad of [undefined, null]) {
    assert.throws(() => pluginData.identityOf(p, bad), /contributes\.ports: 1/,
      `那一份是 ${JSON.stringify(bad)} 时必须停下来 —— 回落成两段会让这个插件的`
      + '每一份都共用同一份数据，而两边都以为自己写进去了');
  }
  // 报错要点出**是哪个插件**：池里可以并存同一个插件的多个版本，只说"缺那一份"
  // 指不回那一份清单。
  assert.throws(() => pluginData.identityOf(p, null), /code-server/);
  // ★ 而**不要数据空间**的那一个拿不到也不抛 —— 它本来就没有第三段。
  assert.doesNotThrow(() => pluginData.identityOf(relay(), null));
});

test('★★ 第二段取自**那一份数据自己**，不是现从清单算', () => {
  // `inherit` 声明的是"**哪些版本可以**共用一份"，而**实际用哪一份由引用表说了算**。
  // ★ 取清单那一侧会有一种静默的失败：作者改了共享组而引用表还没跟上的那段时间里，
  //   同一个插件会去读一个新路径，而数据在旧路径上（症状是"布局又重置了"，没有报错）。
  //   ★ 让两者对上的那条规矩在 `config.js` 的 `spaceFor`（它发现对不上就**新开一份**），
  //     不在这个函数里。
  const p = concurrent();                       // 清单算出来是 'editor'
  const stale = space({ group: 'editor2' });    // 那一份记着的是别的
  assert.deepEqual(pluginData.identityOf(p, stale), [ID, 'editor2', stale.id],
    '★ 以那一份数据记着的为准 —— 数据就在那个路径上');
});

test('★ 别的插件共用同一个共享组名，也不会共用同一份存储', () => {
  // 共享组名是**作者自己起的**，两个插件正好都叫 editor 是完全正常的。分区名的头一段
  // 是插件 id，所以它们不会撞 —— 少了这一段（只有末段），
  // 两个声明了 ports 的插件共用一个工作区时会读写同一份存储。
  const other = concurrent({ id: '01M2JKHTZGF12N0T9CB3XVK36H', name: 'other' });
  const a = space({ group: 'editor' });
  const b = space({ pluginId: other.id, group: 'editor' });
  assert.notEqual(partitionOf(concurrent(), a), partitionOf(other, b));
});

// ── 磁盘上的那个名字（对账要读它）────────────────────────────────────────────

test('★ 磁盘上的目录名 = 分区名去掉前缀、**ASCII 折叠**（id 那一段是小写）', () => {
  // Electron 44 的 `MakePartitionName` = `EscapePath(ToLowerASCII(分区名))`。
  assert.equal(pluginData.foldAscii('01M2ABC'), '01m2abc', 'A-Z 各减 32，别的原样');
  assert.equal(pluginData.diskNameOf(['01M2ABC', 'editor', 's0000000000ab']),
    '01m2abc@editor@s0000000000ab');
  // ★ 折叠是对**整个字符串**做的（`MakePartitionName` 就是这样），而合法的那三段里
  //   只有 id 会变 —— 另外两段的字符集本来就只允许小写。这里钉的是"折叠本身作用于
  //   整串"，免得有人以为它只折第一段，然后按"只折第一段"去改它。
  assert.equal(pluginData.diskNameOf(['01M2ABC', 'EDITOR', 'S0ABCDEF1234']),
    '01m2abc@editor@s0abcdef1234');
});

// ── 插件数据目录的那个名字（对账的第二个根要读它）────────────────────────────

test('★ 数据目录名是**一个名字**（不含分隔符）—— 两份身份因此永远是兄弟', () => {
  const two = pluginData.dataDirNameOf(['01M2ABC', 'editor']);
  const three = pluginData.dataDirNameOf(['01M2ABC', 'editor', 's0000000000ab']);
  assert.equal(two, '01m2abc@editor');
  assert.equal(three, '01m2abc@editor@s0000000000ab');
  // ★ 这条断言就是全部。名字里没有分隔符 ⇒ `path.join(根, 名字)` 得到的两个目录
  //   落在**同一个父目录**下。而如果改成三层目录（`<id>/<共享组>/<数据id>`），`three`
  //   就会落在 `two` **里面** —— 而这两份身份**真的会同时存在**：同一个插件的一个版本
  //   声明 `{inherit:'editor'}` 而**不要工作区**（两段）、另一个版本要工作区（三段），
  //   而 `inherit` 的语义正是"这几个版本共享一份"。那时"删掉没人用的 editor 那一份"
  //   会把三段那份**正在用的**连根删掉，而两边都不报错。
  assert.ok(!two.includes('/') && !two.includes('\\'), '名字里不能有路径分隔符');
  assert.ok(!three.includes('/') && !three.includes('\\'), '名字里不能有路径分隔符');
});

test('★ 两个根下的同一个身份必须同名（对账只有一张"该有的"表）', () => {
  for (const id of [['01M2ABC'], ['01M2ABC', 'editor'],
    ['01M2ABC', 'editor', 's0000000000ab']]) {
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
  assert.deepEqual(pluginData.identityOfDiskName(`${DISK_ID}@editor@s0000000000ab`),
    { id: DISK_ID, group: 'editor', instance: 's0000000000ab' });
  // ★ 第二段**可以是版本号**（声明了 `data.perVersion: true` 的插件就是），而
  //   `1.0.0` 不匹配 `GROUP_RE` —— 这正是"拿逆向解析当判据"会删掉活数据的那条路：
  //   一个 `perVersion` 的插件，它**当前**那一份存储会被判成"认不出来"。
  assert.deepEqual(pluginData.identityOfDiskName(`${DISK_ID}@1.0.0`),
    { id: DISK_ID, group: '1.0.0', instance: null });

  for (const bad of [
    '', '..', 'editor@s0000000000ab',                    // 第一段不是 ULID
    '01m2abc@editor',                                    // 第一段长度不对
    `${DISK_ID}@editor@s1@s2`, `${DISK_ID}@editor@s1@s2@s3`,   // 段数不对
    `${DISK_ID}@`, `${DISK_ID}@@s0000000000ab`,          // 空段
    DISK_ID,                                             // 只有一段
    `${ID}@editor`,                                      // 大写：磁盘上不会是大写（折叠过）
  ]) {
    assert.equal(pluginData.identityOfDiskName(bad), null,
      `${JSON.stringify(bad)} 不该被认成一份身份`);
  }
});

test('★ 往返：身份 → 磁盘名 → 解回来，三段一个都不丢', () => {
  const a = pluginData.identityOf(concurrent(), space({ group: 'editor' }));
  const back = pluginData.identityOfDiskName(pluginData.diskNameOf(a));
  assert.deepEqual([back.id, back.group, back.instance],
    [DISK_ID, 'editor', 's000000000001']);

  // ★ 第三段的取值要**两份都走一遍**：持久那一份是 `s…`，临时那一份也是 `s…`
  //   （同一套铸法、同一张形状正则）—— 差别只在落不落盘，不在名字的形状上。
  //   所以这里没有"第二种形状"要钉，钉的是"它确实进了第三段"。

  // 两段的那一种（不要工作区的插件），第二段**两种取值都要走一遍**：
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
  const id = pluginData.identityOf(concurrent(), space({ group: 'editor' }));
  const partition = pluginData.partitionOf(id);
  assert.equal(pluginData.samePartition(partition, pluginData.diskNameOf(id)), true);
  // 没折叠的那一份也认（磁盘上不会出现，但判据不该因此漏掉一整格）。
  assert.equal(pluginData.samePartition(partition, `${ID}@editor@s000000000001`), true);
  // ★ 这一条是这道判据存在的理由：正被界面用着的那一份**最不能误判**
  //   （当成"没人用"就会把它抽掉，而症状只是「页面莫名其妙坏了」）。
  assert.equal(pluginData.samePartition(partition, 's000000000001'), false);
  assert.equal(pluginData.samePartition('editor@x', 'editor@x'), false, '不是 persist: 前缀');
  assert.equal(pluginData.samePartition(null, 'x'), false);
  assert.equal(pluginData.samePartition(partition, null), false);
});

test('★ 四条判据各管一件事：hasSurface / needsSpace / canOpenSecond / portCountOf', () => {
  const surface = { kind: 'web', path: '/' };
  const cases = [
    // [contributes, 有界面, 要数据空间（⇒ 有第三段）, 能同时开两份, 端口个数]
    [{ surface, ports: 1, concurrent: true }, true, true, true, 1],
    // 没有界面 ⇒ 从来没有分区（ensureSurface 第一行就返回了）
    [{ ports: 1, concurrent: true }, false, true, true, 1],
    // ★ 有界面、但**不能多开**：它照样有第三段（每个工作区里各一份），
    //   只是那两份不能同时活着。清理与对账**都按 needsSpace**，不按 canOpenSecond ——
    //   用后者会把好几份**活着的数据**判成"不属于这份数据"而漏删（或者根本算不出来）。
    [{ surface, ports: 1, concurrent: false }, true, true, false, 1],
    // 不要数据空间的那一个（sshd）：整台机器上一份，没有第三段。
    [{ surface, ports: 0, concurrent: false }, true, false, false, 0],
    // 缺省（不写这一格）= 0 —— 与写成 0 同义，与相邻那两格同一条纪律。
    [{ surface, concurrent: false }, true, false, false, 0],
    // ★ 形状不对的读成 0（这一层是**取值**不是判定，判定在清单校验那一侧）
    [{ surface, ports: -1, concurrent: false }, true, false, false, 0],
    [{ surface, ports: 'yes', concurrent: false }, true, false, false, 0],
  ];
  for (const [contributes, wantSurface, wantSpace, wantSecond, wantPorts] of cases) {
    const p = { id: ID, version: '1.0.0', contributes };
    const tag = JSON.stringify(contributes);
    assert.equal(pluginData.hasSurface(p), wantSurface, tag);
    assert.equal(pluginData.needsSpace(p), wantSpace, tag);
    assert.equal(pluginData.canOpenSecond(p), wantSecond, tag);
    assert.equal(pluginData.portCountOf(p), wantPorts, tag);
  }
  assert.equal(pluginData.hasSurface(null), false);
  assert.equal(pluginData.needsSpace(null), false);
  assert.equal(pluginData.canOpenSecond(null), false);
  assert.equal(pluginData.portCountOf(null), 0);
});

// ── 清单校验：contributes.concurrent 与 contributes.data ────────────────────

/** 一份最小合法清单，`over` 里的东西直接盖上去。 */
function manifest(over = {}) {
  return {
    id: ID, name: 'code-server', displayName: '开发环境', version: '1.0.0',
    contributes: { ports: 1, concurrent: false },
    ...over,
  };
}

/** 写进一个临时目录，然后走一遍**真的**校验器（不模拟它）。 */
function inspect(mf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-pd-'));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(mf, null, 2));
  return P.inspectDir(dir);
}

/** 一份**有界面、要数据空间、不能多开**的清单，只换 `data` 那一段。 */
const accept = (data) => inspect(manifest({
  contributes: { ports: 1, concurrent: false, data } }));
const reject = (data) => {
  const r = accept(data);
  assert.ok(r.error, `这份声明必须被拒：${JSON.stringify(data)}`);
  return r.error;
};

test('contributes.concurrent：★★ 必填 —— 不写这一格 ⇒ 装不上（不是"当成不能"）', () => {
  // ★ 这一条钉的是"**没有缺省**"，而它与同一个清单里另外两格（ports / submitPubkey）
  //   刻意相反：那两个缺省都在安全侧，基座答得了。
  //   而"你的代码能不能同时处理两份"基座答不了 —— 缺省无论取哪边都是替作者表态。
  const 没写 = inspect(manifest({ contributes: { ports: 1 } }));
  assert.match(没写.error || '', /contributes\.concurrent 是\*\*必填\*\*/,
    '缺了这一格必须**拒绝安装**，而不是静默当成 false');
  assert.equal(没写.entry, undefined);

  // ★ 反例：写了的照常收下，而且两种取值都收 —— 否则上面那一条会因为"什么都拒"而全绿。
  for (const v of [true, false]) {
    const r = inspect(manifest({ contributes: { ports: 1, concurrent: v } }));
    assert.ok(!r.error, `concurrent: ${v} 是合法的：${r.error}`);
    assert.equal(r.entry.plugin.contributes.concurrent, v);
  }

  // 类型不对由那条布尔循环管（与 submitPubkey 同一句措辞）。
  const bad = inspect(manifest({ contributes: { ports: 1, concurrent: 'yes' } }));
  assert.match(bad.error, /contributes\.concurrent 必须是 true 或 false/);
});

test('contributes.concurrent：★ 能多开要求一个端口 —— 没有第一份就没有第二份可指', () => {
  // ★ 这一条是**组合**判定：两半各自都没错，错在放一起。第二份 = 第二份**数据**
  //   （一份临时的副本），而一份数据存在的理由就是它那个端口 —— 所以
  //   `ports: 0` 的插件没有"第二份"可指。判在**装之前**（与 engines 同一条纪律）。
  const noPorts = inspect(manifest({
    contributes: { ports: 0, concurrent: true },
  }));
  assert.match(noPorts.error || '', /concurrent: true 要求同时有 contributes\.ports/);

  // 而 ports: 1 的那一份照常收下 —— 否则上面那一条会因为"什么都拒"而全绿。
  const ok = inspect(manifest({ contributes: { ports: 1, concurrent: true } }));
  assert.ok(!ok.error, `这一份是合法的：${ok.error}`);

  // ★ 反例也要钉：ports 那一段自己写错了（这里是字符串）时，报的必须是
  //   "ports 必须是 … 整数"，而不是被这一条抢先说成"concurrent 缺端口"
  //   —— 后者会把用户指去改一个本来没错的地方。
  const badPorts = inspect(manifest({
    contributes: { ports: 'yes', concurrent: true },
  }));
  assert.match(badPorts.error, /contributes\.ports 必须是 0 到 1 之间的整数/);
});

test('★★ contributes.ports：是个数、有缺省、有一个说得出理由的上界', () => {
  // ── 缺省 0 ──
  const 没写 = inspect(manifest({ contributes: { concurrent: false } }));
  assert.ok(!没写.error, `不写这一格是合法的：${没写.error}`);
  assert.equal(没写.entry.plugin.contributes.ports, 0,
    '缺省落成**具体的数** 0 —— 下游拿起来就能用，不必自己再判一次');
  assert.equal(pluginData.needsSpace(没写.entry.plugin), false,
    '缺省 0 ⇒ 不要数据空间（与从前的 `layout: false` 同义）');

  // ── 1 是今天唯一"要一份"的取值 ──
  const one = inspect(manifest({ contributes: { ports: 1, concurrent: false } }));
  assert.ok(!one.error, `${one.error}`);
  assert.equal(one.entry.plugin.contributes.ports, 1);

  // ── 上界：2 是一句**框架做不到的话** ⇒ 拒，不是收下只兑现第一个 ──
  //   ★ 一条会话只有一条隧道、作业侧只报得到一个候选端口，所以第二个端口兑不了。
  //     收下的话症状是"插件以为自己在用第二个 origin"，而没有任何东西会红 ——
  //     正是这个仓库一路在删的「配了但不生效」。
  const two = inspect(manifest({ contributes: { ports: 2, concurrent: false } }));
  assert.match(two.error || '', /contributes\.ports 必须是 0 到 1 之间的整数/);
  assert.match(two.error, /最多占 1 个本地端口/, '拒的时候要说清为什么 —— 否则作者只能猜');

  // ── 形状：负数 / 小数 / 字符串 / 布尔 / null 都不收 ──
  for (const bad of [-1, 1.5, '1', true]) {
    const r = inspect(manifest({ contributes: { ports: bad, concurrent: false } }));
    assert.match(r.error || '', /contributes\.ports 必须是 0 到 1 之间的整数/,
      `${JSON.stringify(bad)} 不是一个端口个数`);
  }
  // ★ 而 `null` **收**：与不写同义（这个清单里几处可选的格都是这个规矩）。
  const nul = inspect(manifest({ contributes: { ports: null, concurrent: false } }));
  assert.ok(!nul.error, `null 与不写同义：${nul.error}`);
  assert.equal(nul.entry.plugin.contributes.ports, 0);
});

test('★ contributes.layout 已经没了 —— 老写法要**指得到新名字**', () => {
  // ★ 与 `data.perInstance` 那条改名提示同一个理由：只说"认不得的键：layout"
  //   的话，作者知道错了却不知道该改成什么，而这一格还**换了形**（开关 → 个数）。
  const r = inspect(manifest({ contributes: { layout: true, concurrent: false } }));
  assert.match(r.error || '', /contributes\.layout 已经改名成 contributes\.ports/);
  assert.match(r.error, /ports: 1/, '两个取值都要点出来 —— 否则作者还得自己推');
  assert.match(r.error, /ports: 0/);
  // ★ 而它**不是**一条兼容路：写成 layout 的清单**装不上**。
  assert.equal(r.entry, undefined);
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
  // ★ 这是"两半各自都没错、错在放一起"的那一类（与 concurrent 要求 ports 同形）。
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
    version: '1.0.0', contributes: { ports: 0, concurrent: false },
  });
  assert.ok(!r.error, `不声明 data 必须合法：${r.error}`);
  assert.equal(r.entry.plugin.contributes.data, null);
});

test('★★ slotOf：一个活跃会话占的那个槽（多开的判据就是它）', () => {
  // ★ 这一条是**整个并发层存在与否**的判据：改回"每次都不同"或者"两个不要工作区的插件
  //   各一个槽"都会让它红，而红的方式正是它要防的那件事。
  assert.equal(pluginData.slotOf('s0000000000ab'), 'space:s0000000000ab');

  // ★★ **不要工作区的那一整类共用一个槽** —— 这一档是**故意**粗的，而它的理由
  //    只剩**一条**（见 plugin-data.js 的 slotOf 与账本〈保留⑥〉）：
  //    写进用户 ssh 配置的那个别名是插件自己的常量，基座**无从核对**两个不要工作区的
  //    插件的别名会不会撞。细一档（按插件 id 分槽）会让两个互不认识的不要工作区的插件
  //    并存着去抢同一个别名，而症状是"`ssh slurmate` 连到哪一个是不确定的"，
  //    两边都报"已就绪"。
  assert.equal(pluginData.slotOf(null), 'relay');
  assert.equal(pluginData.slotOf(undefined), pluginData.slotOf(null),
    '两个不同的"不要工作区"的插件必须落进同一个槽');

  // ★★ 要工作区的：**槽按那一份数据分**。同一个工作区里两个不同的插件天然是两份
  //    数据 ⇒ 两个槽 ⇒ **可以同时跑**；同一个插件的同一份数据 ⇒ 同槽 ⇒ 拒。
  //    （从前槽名里带的是工作区 id，"同一工作区的第二条会话"一律被拒 —— 哪怕它是
  //    另一个插件，而那条拒绝自己写的理由两半都不成立。）
  assert.equal(pluginData.slotOf('s0000000000ab'), pluginData.slotOf('s0000000000ab'));
  assert.notEqual(pluginData.slotOf('s0000000000ab'), pluginData.slotOf('s0000000000ff'));
  // 要工作区的与不要工作区的，永远是两个槽 —— 那条能力（一个 IDE + 一个终端中转）靠它。
  assert.notEqual(pluginData.slotOf('s0000000000ab'), pluginData.slotOf(null));
  // 两个槽名不会互撞（前缀把它们挡开了，而数据 id 是 `s<hex>`，撞不上 `relay`）。
  assert.notEqual(pluginData.slotOf(null), pluginData.slotOf('relay'));
});
