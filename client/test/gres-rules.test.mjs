/**
 * gres-rules.test.mjs —— 假后端的 GRES 规则**必须与守护进程同一条**。
 *
 * ★ 假后端（`backend-fake.js`）的全部价值是"它演的是生产那条路"。
 *   而它的规则是**照抄**守护进程的（`clean_gres()` + `fit_gres()`）——
 *   两个文件、两种语言，没有共享代码，所以它们会漂。
 *   漂的方向有两个，**都很坏**：
 *     · 假后端更宽 ⇒ 开发者模式里提交得通、真站点被拒，而报错要到真机上才出现；
 *     · 假后端更严 ⇒ 开发时以为某件事不能做，其实能。
 *
 * ★ 这一组是**行为**用例（真调 `_submit`），不是文本比对 ——
 *   `backend-fake.test.mjs` 管的是"字段名对不对"，管不了"规则一样不一样"。
 *
 * ★ 而它同样是"夹具要比真集群脏"的落点：假集群里有一条**带型号**的 GRES
 *   （`gpu:a6000`）和一条**名字不是 gpu** 的（`mps`）。本机那台真集群只有不带
 *   型号的 `gpu`，所以这两条路在真集群上走不到 —— 不在这里造，就没有覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { FakeBackend } = require('../src/main/backend-fake.js');

const HERE = path.dirname(new URL(import.meta.url).pathname);
// 假站点不认识任何插件 —— "那个站点装了哪些"由调用方告诉它（见 integration.mjs）。
// 这里给它仓库里真那一个，好让 `service_kind` 有得填。
const SITE = () => path.join(HERE, '..', '..', 'plugins');
// ★ 用 **sshd** 而不是 code-server：code-server 声明了 `contributes.surface`，
//   那意味着 `_submit` 要求先 `connect()`（本地那个假 web 服务得起着）。这一组
//   要验的是 GRES 的规则，为它去起一个监听套接字只会让用例更难读、更容易碎。
//   两个插件走的是**同一段** GRES 代码（在服务种类那一段之后），所以换了不影响。
const KIND = 'sshd';
/** 形状正确的一行公钥（sshd 声明了 submitPubkey，提交时必须带）。 */
const PUBKEY = 'ssh-ed25519 ' + 'A'.repeat(68) + ' slurmate-test';

function make() {
  return new FakeBackend({ rpcLatencyMs: 0, enrollDelayMs: 0, sitePluginDir: SITE });
}

/**
 * 直接调 `_submit`，**不走 `rpc()`**：`rpc` 那条路要求先 `connect()`（它要起一个
 * 本地假 web 服务），而这一组用例要验的**全是 GRES 的规则** —— 那些判断在
 * "起没起服务"之前就跑完了（`if (this._server)` 那几处都是可选的）。
 * 为了验一条规则去起一个监听套接字与一条隧道，只会让这条用例更难读、更容易碎。
 */
async function submit(req) {
  const b = make();
  const r = b._submit({ op: 'submit', service_kind: KIND, ssh_pubkey: PUBKEY, ...req });
  b._clearTimers();
  return { b, r };
}

test('★ 假集群确实带一条**带型号**的 GRES（否则那条路一次都走不到）', async () => {
  const b = make();
  const r = await b.rpc({ op: 'partitions' });
  const all = r.data.partitions.flatMap((p) => (p.gres || []));
  assert.ok(all.some((e) => e.type), '一条带型号的都没有 —— 那就是 F26 那种夹具');
  assert.ok(all.some((e) => e.name !== 'gpu'),
    '名字全是 gpu —— GRES 是管理员自定义的，夹具要有一条不叫 gpu 的');
  b._clearTimers();
});

test('每个分区都带自己的清单（三态里的第三态：有，而且是空的）', async () => {
  const b = make();
  const r = await b.rpc({ op: 'partitions' });
  for (const p of r.data.partitions) {
    assert.ok(Array.isArray(p.gres), `${p.name} 上没有 gres 这个键`);
  }
  assert.deepEqual(r.data.partitions.find((p) => p.name === 'DEBUG').gres, [],
    'DEBUG 分区应该是「有清单但是空的」——与「查不到」不是一回事');
  b._clearTimers();
});

test('★ 带型号的提交进得去，而且**描述符原样回来**（不是数字）', async () => {
  const { b, r } = await submit({ partition: 'A6000',
    gres: { name: 'gpu', type: 'a6000', count: 2 } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data.resources.gres, { name: 'gpu', type: 'a6000', count: 2 });
  assert.equal('gpus' in r.data.resources, false,
    'resources.gpus 那个数字字段已经不存在了');
  b._clearTimers();
});

test('★ 名字不是 gpu 的照样提交（`mps:100`）', async () => {
  const { b, r } = await submit({ partition: 'RTX8000',
    gres: { name: 'mps', count: 100 } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data.resources.gres, { name: 'mps', type: null, count: 100 });
  b._clearTimers();
});

test('★★ 上限来自**这个分区**的清单，不是写死的一个数', async () => {
  // A6000 每节点 4 张（带型号 a6000），RTX8000 的 mps 每节点 100 个。
  // ★ 判据直接取**假集群自己那份清单**里的数 —— 写一个 8 进去就又是两份真相。
  const cat = make()._partitions();
  const capOf = (part, name) => cat.find((p) => p.name === part)
    .gres.find((e) => e.name === name).per_node_max;
  const capA6000 = capOf('A6000', 'gpu');
  const capMps = capOf('RTX8000', 'mps');

  const ok = await submit({ partition: 'A6000',
    gres: { name: 'gpu', type: 'a6000', count: capA6000 } });
  assert.equal(ok.r.ok, true, `要满 ${capA6000} 张应当可以`);
  ok.b._clearTimers();

  const no = await submit({ partition: 'A6000',
    gres: { name: 'gpu', type: 'a6000', count: capA6000 + 1 } });
  assert.equal(no.r.ok, false, `${capA6000 + 1} 张超过了 A6000 每节点的 ${capA6000} 张`);
  assert.equal(no.r.error.kind, 'bad_gres', JSON.stringify(no.r));
  assert.match(no.r.error.detail, new RegExp(String(capA6000)),
    '那句话里要说得出上限是几');
  assert.match(no.r.error.detail, /gpu:a6000/, '也要说得出是哪一种 GRES');
  no.b._clearTimers();

  const ok100 = await submit({ partition: 'RTX8000',
    gres: { name: 'mps', count: capMps } });
  assert.equal(ok100.r.ok, true,
    `要满 ${capMps} 个 mps 应当可以 —— 写死的 8 会在这里把合法的提交拒掉`);
  ok100.b._clearTimers();
});

test('★ 分区上没有那种 GRES → 拒绝并说出这个分区有什么', async () => {
  const { b, r } = await submit({ partition: '2080TI',
    gres: { name: 'gpu', type: 'a6000', count: 1 } });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'bad_gres');
  assert.match(r.error.detail, /gpu/, '要说得出这个分区有什么');
  // ★★ 判据是**那句话本身**，不只是"拒了"。变异验证里"把存在性检查整条短路"
  //   这一条**没红**：短路之后 `Math.max()` 是 `-Infinity`，于是它照样拒 ——
  //   只是报出来的是「每个节点最多 -Infinity 个」，一句谁也读不懂的话。
  //   "拒了"与"拒得对"是两件事，用例要钉后面那件。
  assert.match(r.error.detail, /它有/, '要说得出"这个分区有哪几种"，不是一句数值垃圾');
  assert.equal(/-Infinity|NaN/.test(r.error.detail), false,
    `报出来的是一句数值垃圾：${r.error.detail}`);
  b._clearTimers();
});

test('★★ 形状不合法一律在提交之前拒掉（与守护进程同一张脸）', async () => {
  const bad = [
    'gpu:2',
    { name: 'gpu', type: 'a:100', count: 2 },
    { name: 'gp u', count: 2 },
    // ★ Python 的 `$` 会匹配"结尾换行之前"，JS 的不会 —— 这一条守的是**两边
    //   都不许**：假后端放过去了，开发者模式里就能造出一个真站点会拒的形状。
    { name: 'gpu\n', count: 2 },
    { name: 'gpu', count: 0 },
    { name: 'gpu', count: -1 },
    { name: 'gpu', count: '2' },
    { name: 'gpu', count: 2.5 },
    { count: 2 },
    { name: '', count: 2 },
  ];
  for (const g of bad) {
    const { b, r } = await submit({ partition: '2080TI', gres: g });
    assert.equal(r.ok, false, `这个形状居然过了：${JSON.stringify(g)}`);
    assert.equal(r.error.kind, 'bad_gres', JSON.stringify(g));
    b._clearTimers();
  }
});

test('★ 不传 gres ⇒ null（不是 0、不是空对象）', async () => {
  const { b, r } = await submit({ partition: '2080TI' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.resources.gres, null);
  b._clearTimers();
});
