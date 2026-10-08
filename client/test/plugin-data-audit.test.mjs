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
 * plugin-data-audit.test.mjs —— 「本机还剩几份插件数据、哪一份没人用」的判据。
 *
 * ★ 这一份的主体是一条**会删错数据**的错误的反面：
 *
 *   判据是「**正向算出该有哪些**，两边折叠做差」，**不是**「逆向解析磁盘上的名字」。
 *   后者有两个坑，各自都够把**活着的**一份判成垃圾：`identityOf` 的第二段可以是
 *   版本号（`1.0.0` 不匹配 `GROUP_RE`），而磁盘上的名字是折叠过的（id 那一段小写）。
 *   两次变形叠加之后，"我解析不出来"与"这是老垃圾"就分家了 —— 而界面上给一份活着的
 *   cookie 一个删除按钮，代价是用户重配一遍。
 *
 * 所以下面每一条都要求：**该在的说得出来、不该在的说不出来**，而不是只测一半。
 *
 * 第二件事：**认不出的目录只列不删**。分区目录的根是推出来的（`partitionRoot`），
 * 万一推错，那个列表会把 `secrets.json`、`dev-sandbox` 之类摆上删除按钮。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pluginData = require('../src/main/plugin-data.js');
const audit = require('../src/main/plugin-data-audit.js');

const CS = '01M2JKHTZGKJBFQQTWYXMQMF2V';
const SSHD = '01M2JKHTZGF12N0T9CB3XVK36H';
const LAYOUT = 'l0123456789ab';
const OTHER_LAYOUT = 'lffffffffffff';

/** 有界面、能同时开两份、跨版本共享的那种插件 —— code-server 真实的样子。 */
const cs = (over = {}) => ({
  id: CS, name: 'code-server', displayName: '开发环境', version: '1.0.0',
  contributes: {
    surface: { kind: 'web', path: '/' }, layout: true, concurrent: true,
    data: { inherit: 'editor' },
  },
  ...over,
});

/** 有界面、但**不能多开**：只有一份存储，不属于任何布局组。 */
const oneStore = () => ({
  id: SSHD, name: 'sshd', displayName: 'SSH 中转站', version: '1.0.0',
  contributes: { surface: { kind: 'web', path: '/' }, layout: false, concurrent: false,
    data: null },
});

const layouts = (...ids) => ids.map((id, i) => ({ id, name: `组${i + 1}`, port: 51000 + i }));
const conn = (layoutId, id = 'c1') => ({ id, layoutId });
const disk = (identity) => pluginData.diskNameOf(identity);

/** sshd **实际的样子**：没有 `contributes.surface`（它的东西跑在用户自己的机器上，
 *  框架连一块界面都不建），但声明了数据、而且**不能多开**。 */
const relay = () => ({
  id: SSHD, name: 'sshd', displayName: 'SSH 中转站', version: '1.0.0',
  contributes: { layout: false, submitPubkey: true, concurrent: false,
    data: { inherit: 'relay' } },
});

/**
 * 一次只读对账。
 *
 * ★ 两个根的名字**默认都是 `[]`**（= 查过了、是空的）。要表达"没查那一根"必须显式
 *   传 `null` —— 这两件事在界面上是两句完全不同的话（"没有" vs "查不了"）。
 */
const run = (o) => audit.audit({
  plugins: o.plugins || [cs()],
  layouts: o.layouts === undefined ? layouts(LAYOUT) : o.layouts,
  connections: o.connections === undefined ? [conn(LAYOUT)] : o.connections,
  names: o.names === undefined ? [] : o.names,
  why: o.why,
  dataNames: o.dataNames === undefined ? [] : o.dataNames,
  dataWhy: o.dataWhy,
  // ★ `held` 的缺省是**空的一列**（= "此刻没有任何活会话"）。它不是"没查"——
  //   "谁活着"这件事在调用方那里永远是知道的（进程就是它自己），所以没有三态。
  held: o.held === undefined ? [] : o.held,
});

// ── ★ 活着的分区绝不能被报出来 ──────────────────────────────────────────────

test('★★ 活着的分区不在名单里（手写磁盘名：不能拿被测函数自己算期望）', () => {
  // 这份名字是**手写**的：`01m2jkhtzgkjbfqqtwyxmqmf2v@editor@l0123456789ab` 就是
  // Electron 会把 code-server 那个身份落成的目录名（id 段折叠过）。
  const live = '01m2jkhtzgkjbfqqtwyxmqmf2v@editor@l0123456789ab';
  const r = run({ names: [live] });
  assert.deepEqual(r.rows, [],
    '有一份数据、也有一条连接正指着它那个布局组 —— 它**不是**孤儿');
  assert.equal(r.diskChecked, true);

  // ★ 反例钉住"折叠"这件事：磁盘名写成大写时也必须认得出它（折叠是幂等的）。
  //   少这一条的话，一个"忘了折叠"的实现会让**每一份活着的存储**都变成孤儿 ——
  //   而它照样能让上面那条通过（上面那条的期望是空的）。
  const r2 = run({ names: [live.toUpperCase()] });
  assert.deepEqual(r2.rows, [], '大写的那一份也是它（折叠之后再比）');

  // 反过来：连接指着**另一个**组时，它就没人用了。
  const r3 = run({ names: [live], connections: [conn(OTHER_LAYOUT)],
    layouts: layouts(LAYOUT, OTHER_LAYOUT) });
  assert.equal(r3.rows.length, 1);
  assert.equal(r3.rows[0].kind, 'unused');
  assert.equal(r3.rows[0].name, live, '回给界面的必须是**磁盘上的那个名字**');
});

test('★ 没声明分实例的插件那一份存储**永远不报**（它不属于任何组）', () => {
  // 这种插件只有一份存储，它不挂在任何布局组上 —— 拿引用计数去判它，会在"一条连接
  // 都没有"时把这份唯一的数据报成"没人用"，而那正是最不能删的一份。
  const store = disk(pluginData.identityOf(oneStore()));
  const r = run({ plugins: [oneStore()], names: [store], connections: [] });
  assert.deepEqual(r.rows, [], '它不属于任何组 ⇒ 引用计数这件事对它没有意义');

  // 而一份**算不出来**的目录名照样是孤儿 —— 第二段不是一个认得出的组名时就是
  // 这一档（`perVersion: true` 的插件升版留下的名字也是这个形状）。
  const old = '01m2jkhtzgf12n0t9cb3xvk36h@0.9.0';
  const r2 = run({ plugins: [oneStore()], names: [old, store] });
  assert.deepEqual(r2.rows.map((x) => x.name), [old]);
  assert.equal(r2.rows[0].kind, 'orphan');
});

// ── ★★ 第二个根：插件数据目录 ──────────────────────────────────────────────
//
// 一份身份现在有两个落点（Electron 的存储分区，以及基座给插件的数据目录）。下面
// 这几条守的是**第二根带回来的那类事故**：照搬分区那一侧的入口条件，会把一份**正在
// 被用的**数据摆上删除按钮。

test('★★ 没有界面、却会写数据的插件（sshd 实际的样子）—— 那一份**永远不报**', () => {
  // ★ 这一条守的是本阶段**最贵的一处**。若对账"该有的"入口按"有没有界面"算
  //   （`hasSurface`），sshd 那份数据目录就**一诞生就是孤儿**：sshd 没有
  //   `contributes.surface`（它的东西跑在用户自己的机器上，框架连一块界面都不建），
  //   而它**会写数据**（`ctx.dataDir()`）。于是界面上一个删除按钮，而一个跑着的
  //   会话正靠它（`~/.ssh/config` 的 IdentityFile / UserKnownHostsFile 都指着那里）
  //   —— 症状是"`ssh slurmate` 忽然认证失败"，而用户刚刚点过一个他以为无害的按钮。
  const live = disk(pluginData.identityOf(relay()));
  assert.equal(live, '01m2jkhtzgf12n0t9cb3xvk36h@relay', '手写形状：折叠过的 id + 声明的组名');
  const r = run({ plugins: [relay()], names: [], dataNames: [live], connections: [] });
  assert.deepEqual(r.rows, [], '它没有实例段 ⇒ 不属于任何布局组 ⇒ 永远不列');
  assert.equal(r.diskChecked, true);

  // ★ **反向**：同一条入口下，一份真的没人要的旧数据必须照旧报出来 —— 少了这一条，
  //   一个"什么都报不出来"的实现也能让上面那条绿。
  const old = disk([SSHD, '0.9.0']);           // 算不出来的第二段：版本形状的那一种
  const r2 = run({ plugins: [relay()], names: [], dataNames: [old], connections: [] });
  assert.deepEqual(r2.rows.map((x) => `${x.kind}:${x.name}`), [`orphan:${old}`]);
  assert.equal(r2.rows[0].deletable, true);
});

test('★ 两个根下的同一份身份 ⇒ **一行**，`places` 说清它在哪几处', () => {
  const live = disk(pluginData.identityOf(cs(), LAYOUT));
  const r = run({ names: [live], dataNames: [live] });
  assert.deepEqual(r.rows, [], '有连接指着那个组 ⇒ 不是孤儿');

  // 组没了 ⇒ 一行，两处都标出来 —— 用户不该为了同一份数据删两次，而"只列一处"
  // 会让删完的那一刻另一处把同一行带回来（"我明明删过了"）。
  const r2 = run({ names: [live], dataNames: [live], connections: [] });
  assert.equal(r2.rows.length, 1, '同一份身份只出一行 —— 不是"一个落点一行"');
  assert.deepEqual(r2.rows[0].places, ['partition', 'data']);

  const onlyP = run({ names: [live], dataNames: [], connections: [] });
  assert.deepEqual(onlyP.rows[0].places, ['partition']);
  const onlyD = run({ names: [], dataNames: [live], connections: [] });
  assert.deepEqual(onlyD.rows[0].places, ['data'], '只在数据根下有的那一份也要列出来');
});

test('★ 一处认得出、另一处认不出 ⇒ 整行**不给删除按钮**', () => {
  // 分区根里有历史形状（`slot-…`）是正常的；而**数据根里不可能有** —— 那个目录从
  // 诞生起只有这个客户端写过。所以一条 `slot-1` 在两处都出现，说明**数据根取错了**，
  // 而那正是"把 secrets.json、dev-sandbox 摆上删除按钮"那条路的入口。
  const r = run({ names: ['slot-1'], dataNames: ['slot-1'] });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].kind, 'unknown');
  assert.equal(r.rows[0].deletable, false, '有一处认不出 ⇒ 整行都不许删');
  assert.match(r.rows[0].why, /数据目录/, '要说清是**哪一处**认不出');

  // 反向：同一条 `slot-1` **只在分区根里** ⇒ 照旧是认得出来的旧分区，可以删。
  const r2 = run({ names: ['slot-1'], dataNames: [] });
  assert.equal(r2.rows[0].kind, 'legacy');
  assert.equal(r2.rows[0].deletable, true);
});

test('★ 一根没查成 ⇒ `diskChecked:false`，且 `why` 点名是**哪一根**', () => {
  const live = disk(pluginData.identityOf(cs(), OTHER_LAYOUT));
  const r = run({ names: [live], dataNames: null, dataWhy: '读不动', connections: [] });
  assert.equal(r.diskChecked, false);
  assert.match(r.why, /插件数据目录那一根/, '必须说得出"我只看到了一半"');
  assert.match(r.why, /读不动/);
  assert.equal(r.rows.length, 1, '查到的那一根照样要列出来 —— 半份清单也胜过不列');
});

// ── 四类"不是活着的" ────────────────────────────────────────────────────────

test('组没了：第三段那个布局组已经不在配置里 ⇒ 一行，可删，说得出是哪个插件', () => {
  const gone = disk(pluginData.identityOf(cs(), OTHER_LAYOUT));
  const r = run({ names: [gone] });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].kind, 'orphan');
  assert.equal(r.rows[0].deletable, true);
  assert.match(r.rows[0].label, /开发环境/, '标签要带插件的显示名，不是一串 ULID');
  assert.match(r.rows[0].why, new RegExp(OTHER_LAYOUT), '得说清是哪一段对不上');
});

test('插件没了：id 认得出、注册表里没有它 ⇒ 一行，可删', () => {
  // 末尾是 w（code-server 那个是 v）—— 一个**本机没有**的 id。
  const gone = '01m2jkhtzgkjbfqqtwyxmqmf2w';
  const r = run({ names: [`${gone}@editor@${LAYOUT}`] });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].kind, 'orphan');
  assert.equal(r.rows[0].deletable, true);
  assert.match(r.rows[0].label, new RegExp(gone), '认得出 id 就把它说出来');
});

test('0.7 之前的旧分区：三种旧形状都认得，可删', () => {
  const names = ['slot-1', 'layout-l0123456789ab', 'plugin-01M2JKHTZGKJBFQQTWYXMQMF2V'];
  const r = run({ names });
  assert.deepEqual(r.rows.map((x) => x.kind), ['legacy', 'legacy', 'legacy']);
  assert.ok(r.rows.every((x) => x.deletable), '那里面是没人再读的登录 cookie，删得掉才对');
  assert.match(r.rows[0].why, /不会再被任何东西读到/);
});

test('★ 认不出的目录：列出来，但**不给删除按钮**', () => {
  // 这一条防的是"分区目录的根取错了"：那时这个列表会读出 `secrets.json`、
  // `dev-sandbox` 之类的东西，而它们**绝不能**有删除按钮。
  const r = run({ names: ['secrets.json', 'dev-sandbox', 'Partitions', '..', '01m2abc'] });
  assert.equal(r.rows.length, 5, '一个都不许瞒着');
  assert.ok(r.rows.every((x) => x.kind === 'unknown' && x.deletable === false),
    '认不出来就只能说"我认不出"，不能猜着删');
  assert.match(r.rows.find((x) => x.name === 'secrets.json').label, /认不出/);
});

test('★★ 整屏都认不出 ⇒ `allUnknown`：这一根多半取错了', () => {
  // 上面那一条说的是"认不出就不给删除按钮"（逐行的防线）。这一条说的是**全局**：
  // 一整屏都认不出时，读的人会以为"我攒了一堆垃圾"，而真相多半是**这一根指到了
  // 别的地方** —— 插件数据目录那一根是本程序自己拼的，没有任何探针能当场核对它。
  // ⇒ 它是那一根**唯一**的防线，所以得有话可说。
  const r = run({ names: ['secrets.json', 'dev-sandbox', 'Partitions'] });
  assert.equal(r.allUnknown, true, '一个都认不出来 ⇒ 这一根多半取错了');

  // ★ 反例一：**有一行认得出**就不成立 —— 那时屏幕上是"我认识的东西 + 不认识的
  //   东西"，而那正是"用户自己往那个目录里放了点别的"，不是根取错了。
  //
  //   ★ 这里要造一个**真的会产生行**的认得出的名字：**在用的那一份一行都不产生**
  //     （它不是"问题"，见 `audit` 里那条 `continue`）—— 用一个"没人用的组"来造，
  //     否则这一条会因为"行里只剩认不出的那条"而假绿。
  const mixed = run({
    names: ['secrets.json'],
    dataNames: [disk(pluginData.identityOf(cs(), LAYOUT))],
    layouts: layouts(LAYOUT, OTHER_LAYOUT),
    connections: [conn(OTHER_LAYOUT)],
  });
  assert.ok(mixed.rows.some((x) => x.kind === 'unused'),
    '前提：那一行真的产生了（否则这一条测的是别的东西）');
  assert.equal(mixed.allUnknown, false,
    '有一行认得出 ⇒ 不是"整屏认不出"，不能报"根取错了"');

  // ★ 反例二：**一根没查成**就不成立。那是"查不了"，`why` 已经如实说了，
  //   不该被这一句盖过去（"问不到"与"认不出"是两件事）。
  assert.equal(run({ names: null, dataNames: ['secrets.json'] }).allUnknown, false,
    '分区那一根没查成 ⇒ 这是"查不了"，不是"认不出"');
  assert.equal(run({ names: ['secrets.json'], dataNames: null }).allUnknown, false,
    '数据那一根没查成 ⇒ 同上');

  // ★ 反例三：**空清单**不成立。那是"本机一份插件数据都没有"—— 一个**肯定**的
  //   答案。（`every` 对空数组恒真，所以少了 `rows.length > 0` 这一条，
  //   一个全新安装会被告知"你的数据目录取错了"。）
  assert.equal(run({}).allUnknown, false, '一份都没有 ⇒ 不能报"根取错了"');
});

// ── 没人用的组（内存侧那一类）──────────────────────────────────────────────

test('★ 没人用的组：数据在、而没有任何连接指着它 ⇒ 一行，标签里带**组的名字**', () => {
  // 这一格来自 `pruneLayouts` 那条"一条连接都没有时不回收"的豁免：把连接全删了之后，
  // 组和它的数据都还在，而界面上原本没有任何地方说得出来。
  const live = disk(pluginData.identityOf(cs(), LAYOUT));
  const r = run({ names: [live], connections: [] });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].kind, 'unused');
  assert.equal(r.rows[0].deletable, true);
  assert.match(r.rows[0].label, /开发环境/);
  assert.match(r.rows[0].why, /组1/, '要说清是哪个布局组 —— 名字才是用户认得的那个东西');
});

test('★ 一个布局组 = 每个有分区的插件各一行（一份数据 = 一个分区）', () => {
  const two = [cs(), { ...oneStore(), id: '01M2JKHTZGKJBFQQTWYXMQMF2W',
    contributes: { ...oneStore().contributes, layout: true, concurrent: true,
      data: { inherit: 'ssh' } } }];
  const names = two.map((p) => disk(pluginData.identityOf(p, LAYOUT)));
  const r = run({ plugins: two, names, connections: [] });
  assert.equal(r.rows.length, 2, '两个插件各有一份，就是两行（可删除的单位就是这一份）');
  assert.deepEqual([...new Set(r.rows.map((x) => x.kind))], ['unused']);
});

// ── 查不了：缺席 ≠ 否 ──────────────────────────────────────────────────────

test('★ 没查磁盘 ⇒ 空清单 + `diskChecked:false` + 点名是**哪一根**没查', () => {
  const why = '开发者模式不查磁盘：这里用的是一份沙箱配置……';
  const live = disk(pluginData.identityOf(cs(), LAYOUT));
  const r = run({ names: null, why, connections: [] });
  assert.deepEqual(r.rows, []);
  assert.equal(r.diskChecked, false);
  // ★ 现在有两个根，所以"没查"必须说得出是**哪一根** —— 一句不点名的原因在两根
  //   之间是歧义的，而界面拿它当"这一次为什么没看"的唯一说明。
  assert.match(r.why, /分区目录那一根/, '必须点名');
  assert.match(r.why, /开发者模式不查磁盘/, '原因本身要原样带给界面');

  // ★ 反例：查过了、真的没有 ⇒ 也是空清单，但 `diskChecked` 是 true。
  //   两件事在界面上是**两句不同的话**（一句"没有"，一句"我没能去看"）。
  const r2 = run({ names: [] });
  assert.deepEqual(r2.rows, []);
  assert.equal(r2.diskChecked, true);
  assert.equal(r2.why, null);
  assert.equal(live.length > 0, true);
});

// ── 顺序稳定 ───────────────────────────────────────────────────────────────

test('顺序稳定：可删的在前面，认不出的那堆在最后', () => {
  const names = ['zzz-unknown-thing', 'slot-1',
    disk(pluginData.identityOf(cs(), OTHER_LAYOUT)), 'aaa-unknown'];
  const first = run({ names }).rows.map((x) => `${x.kind}:${x.name}`);
  const second = run({ names: [...names].reverse() }).rows.map((x) => `${x.kind}:${x.name}`);
  assert.deepEqual(first, second, '同一个输入换个顺序进来，出去必须一模一样');
  assert.equal(first[first.length - 1].startsWith('unknown'), true);
  assert.equal(first[first.length - 2].startsWith('unknown'), true);
});

// ── partitionRoot / listDirs ───────────────────────────────────────────

test('partitionRoot：探针的目录对得上就用它，对不上就说"查不了"（不说"没有"）', () => {
  const session = (p) => ({ fromPartition: (name) => ({ getStoragePath: () => p(name) }) });
  const probe = `persist:${CS}@editor@${LAYOUT}`;

  // 对得上：Electron 说它在 <root>/<折叠过的名字>
  const ok = audit.partitionRoot({
    session: session((n) => `/tmp/xx/Partitions/${pluginData.foldAscii(n.slice(8))}`),
    probe, fallbackRoot: '/tmp/xx/Partitions',
  });
  assert.equal(ok.root, '/tmp/xx/Partitions');
  assert.equal(ok.verified, true);

  // ★ 对不上（命名约定变了）⇒ **root 为 null**：调用方要如实说"查不了"，
  //   而不是拿一个错的根去认，然后把别人的目录摆上删除按钮。
  const bad = audit.partitionRoot({
    session: session((n) => `/tmp/xx/Partitions/hashed-${n.length}`),
    probe, fallbackRoot: '/tmp/xx/Partitions',
  });
  assert.equal(bad.root, null);
  assert.equal(bad.verified, false);
  assert.match(bad.why, /命名约定/);

  // 问不出来（没有这个方法 / 抛）= 落到兜底根：这一步是**加固**，不是前提。
  const fallback = audit.partitionRoot({
    session: { fromPartition: () => ({}) }, probe, fallbackRoot: '/tmp/yy/Partitions',
  });
  assert.equal(fallback.root, '/tmp/yy/Partitions');
  assert.equal(fallback.verified, false);
  assert.equal(fallback.why, null);

  // 没有该有的身份可问 ⇒ 一个号都不创建，直接用兜底根。
  const none = audit.partitionRoot({ session: session(() => {
    throw new Error('不该被调用 —— 没有该有的身份就不要去问 Electron');
  }), probe: null, fallbackRoot: '/tmp/zz/Partitions' });
  assert.equal(none.root, '/tmp/zz/Partitions');
});

test('listDirs：目录不存在 = 一份都没有（肯定的答案）；读不动才是"查不了"', () => {
  assert.deepEqual(audit.listDirs('/nonexistent-slurmate-xyz'), { names: [], why: null },
    'ENOENT 是"本机没有"，不是"我查不了"');
  const bad = audit.listDirs('/dev/null/xxx');
  assert.equal(bad.names, null);
  assert.match(bad.why, /读不到/);
  assert.equal(audit.listDirs(null).names, null);
});

test('★★ 正被活会话拿着的那一份**不进名单**（`held`）—— 而没拿着的照旧进', () => {
  // 一份**临时实例**的身份：它的实例键（布局组 id）只在内存里，配置里根本没有
  // 那个组 ⇒ 它**永远**不在"该有的"里。没有 `held` 的话，它在名单上就是一个
  // 可删的孤儿 —— 而那个删除按钮就落在用户正写着的那份数据上。
  const temp = disk(pluginData.identityOf(cs(), 'l0123456789cd'));
  const noHold = run({ names: [temp], dataNames: [temp] });
  assert.equal(noHold.rows.length, 1, '先说清前提：没有 held 时它确实像孤儿');
  assert.equal(noHold.rows[0].kind, 'orphan');
  assert.equal(noHold.rows[0].deletable, true, '而且给得出删除按钮 —— 这正是要挡的那件事');

  const withHold = run({ names: [temp], dataNames: [temp], held: [temp] });
  assert.deepEqual(withHold.rows, [], '★ 拿着它的人说它活着 ⇒ 不许出现在名单里');

  // ★ 折叠是**幂等**的：调用方折过没折过都对。写大写的那一份照样护得住 ——
  //   两个根的名字在折叠这件事上本来就不同源（分区名里 id 段是大写的）。
  assert.deepEqual(run({ names: [temp], held: [temp.toUpperCase()] }).rows, [],
    '★ held 里的名字大写也认（折叠在这里再做一遍）');

  // ★★ **两个根报上来的写法不一样，而这一条是承重的**：窗口那一半
  //    （`livePartitions()`）报的是**分区名**（`persist:…`），会话那一半
  //    （`liveDataDirs()`）报的是**目录名**。少了前缀那一步归一，分区那一半
  //    **永远匹配不上** —— 而症状是"护了个寂寞"：一份活着的临时实例照样在名单里。
  assert.deepEqual(run({ names: [temp], held: [`persist:${temp}`] }).rows, [],
    '★ 带 persist: 前缀的那种写法也要认（窗口那一半报的就是它）');

  // ★ **反例**：没人拿着的同类名字照样是孤儿。少了这一条，一个"`held` 恒为真"
  //   的实现也能让上面那两条通过 —— 而那会让**所有**垃圾都删不掉。
  const other = disk(pluginData.identityOf(cs(), 'l0123456789ef'));
  const stray = run({ names: [other], held: [temp] });
  assert.equal(stray.rows.length, 1, '★ 护的是**拿着的那一份**，不是"所有临时样子的"');
  assert.equal(stray.rows[0].deletable, true);
});

test('★ 删这一份行不行：判定权在主进程（`stale` 与放行）', () => {
  const rows = [
    { name: 'aa@bb@cc', deletable: true, label: 'x' },
    { name: '认不出的东西', deletable: false, label: 'y' },
  ];
  // 不在清单里（界面那份已经陈旧），或者那一行本来就不给删。
  for (const p of ['never-seen', '认不出的东西']) {
    const v = audit.deletionVerdict({ rows, name: p });
    assert.equal(v.ok, false, `${p} 不该删得掉`);
    assert.equal(v.code, 'stale');
    assert.match(v.error, /重新看一下/, '拒绝也要说清下一步');
  }
  // 没在用的放行，而且回的是**这次算出来的那一行**（拼路径要用它）。
  const ok = audit.deletionVerdict({ rows, name: 'aa@bb@cc' });
  assert.equal(ok.ok, true);
  assert.equal(ok.row, rows[0]);
  // ★★ "正被用着"由 `audit` 的 `held` 在算行的时候就挡掉（见上一条）—— 所以这里
  //    **只剩两个下场**。若留一个按 `surfacePartitions` 判的第三态，它是一条恒不可达
  //    的分支：它比的是**分区**，而"有一条活会话"不止体现在分区上（没有界面的
  //    插件、临时实例都没有分区）。这一条钉的就是"它没有回来"。
  assert.equal(audit.deletionVerdict({
    rows, name: 'aa@bb@cc', surfacePartitions: ['persist:aa@bb@cc'],
  }).ok, true, '★ 传了 surfacePartitions 也不再改变判定 —— 那个入参已经不存在了');
});

// ── ★★ 自动回收：哪些**该**自动收，哪些只是"能删" ──────────────────────────

test('★★ 自动回收只碰"再也读不到"的那些 —— `unused` 一个都不许碰', () => {
  // ★★ 这是本版唯一会**删用户数据**的那一步的判据，而它与"界面上能不能删"
  //    **不是**同一条：界面上可删的有三档，自动收的只有两档。
  //
  //    `unused` 的那一份，它的布局组**还在配置里** —— 用户可能刚建了一个空白
  //    布局（还没有连接指过去），也可能那条连接只是暂时被切走了。下一次有连接
  //    指过去就会读它。所以它是"此刻没人用"，**不是**"没人会用"。
  //    ⇒ 少了这一条判据（比如写成"deletable 的全收"），用户的编辑器数据会在
  //      一个他根本不知道的时刻被删掉，而界面上一个字都不会说。
  const rows = [
    { kind: 'unused', deletable: true },
    { kind: 'orphan', deletable: true },
    { kind: 'legacy', deletable: true },
    { kind: 'unknown', deletable: false },
  ];
  const auto = rows.filter(audit.reclaimable).map((r) => r.kind);
  assert.deepEqual(auto, ['orphan', 'legacy'],
    '★ 自动收的只有"按当前装着的插件再也读不到"的那两档');

  // ★ 反过来钉半边：`deletable` 不是这条判据的输入。一个 `unused` 的行**可删**
  //   而**不该自动删** —— 两件事同时成立，正是这条判据存在的理由。
  const unused = rows[0];
  assert.equal(unused.deletable, true, '前提：它在界面上是可删的');
  assert.equal(audit.reclaimable(unused), false, '★ 但它不该被自动收掉');

  // 认不出的那一档本来就没有删除按钮，自动回收也不能碰它。
  assert.equal(audit.reclaimable(rows[3]), false, '一份不认识的东西，删掉不是"收拾"而是"猜"');
  // 空值不炸（`rows` 是从别处传进来的）。
  for (const junk of [null, undefined, {}]) {
    assert.equal(audit.reclaimable(junk), false, `${JSON.stringify(junk)} 不该算作可回收`);
  }
});

test('★★ 一屏孤儿走一遍回收：真孤儿被收，`unused` 那份原样留着', () => {
  // ★ 上一条判的是**判据**，这一条判它接在**真算出来的行**上还成立 ——
  //   手搓的 `{kind:'unused'}` 与 `audit()` 真产出的那一行是两回事（前者不会
  //   因为 `expected` 那张表变了而跟着变）。
  const ghost = '01m2jkhtzgf12n0t9cb3xvk36h@default';   // 本机没有这个插件
  const old = '01m2jkhtzgkjbfqqtwyxmqmf2v@0.9.0';       // 老版本留下的
  const legacy = 'slot-2';                              // 0.7 之前的分区
  const unusedName = disk(pluginData.identityOf(cs(), LAYOUT));  // 组还在配置里 ⇒ unused

  const r = run({
    names: [ghost, old, legacy, unusedName],
    // 连接指着**另一个**组 ⇒ `LAYOUT` 那一份没人用（但那个组还在配置里）
    connections: [conn(OTHER_LAYOUT)],
    layouts: layouts(LAYOUT, OTHER_LAYOUT),
  });

  const kinds = new Map(r.rows.map((x) => [x.name, x.kind]));
  assert.equal(kinds.get(unusedName), 'unused', '前提：那一份真的落在 unused 那一档');
  const auto = r.rows.filter(audit.reclaimable).map((x) => x.name).sort();
  assert.deepEqual(auto, [ghost, old, legacy].sort(),
    '★ 自动收的是孤儿与旧形状；`unused` 那一份只列不删');
});
