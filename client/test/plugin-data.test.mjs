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
  return P.inspectDir(dir, 'test');
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
