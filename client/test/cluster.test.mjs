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
 * cluster.test.mjs —— 集群信息那一块，假后端演的是同一件事。
 *
 * 服务端那一半（三层钟、零 fork、节点后缀只做展示、`-u` 而不是 `-U`）由
 * `cluster/test-sessiond-logic.py` 第 28 节守着。这一组守的是客户端这一侧的
 * 三个接缝，它们在本机都没有别的东西挡得住：
 *
 *   1. 假后端有没有那两个 op。少了 `case 'cluster':`，测试后端里点
 *      「集群状态」拿到的是 `unknown_op`，而界面会把它画成一次失败 ——
 *      开发模式于是对真集群上好好的功能报错。反过来"假后端多知道一点"
 *      在 `backend-fake.test.mjs` 里另有一条守着。
 *
 *   2. 三态。「获取失败」与「确实没有」在这一块里是两句不同的话，而它们
 *      在界面上长得一样（都是一片空）。真集群上"获取失败"要等一次故障才看得到，
 *      所以它必须能立刻造出来（`debugClusterMissing`）。
 *
 *   3. `history` 获取失败时是错误，不是空列表。空列表的意思是"你这几天
 *      没有作业" —— 一句我们并不知道的话。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FakeBackend } = require('../src/main/backend-fake.js');

function fresh() {
  const b = new FakeBackend({ rpcLatencyMs: 0 });
  b._connected = true;
  return b;
}

test('假后端认得 cluster 与 history 两个 op（若不认得，测试后端会对真集群上好好的功能报错）', async () => {
  const b = fresh();
  try {
    const c = await b.rpc({ op: 'cluster' });
    assert.equal(c.ok, true, JSON.stringify(c).slice(0, 200));
    const h = await b.rpc({ op: 'history' });
    assert.equal(h.ok, true, JSON.stringify(h).slice(0, 200));
  } finally {
    await b.close();
  }
});

test('共享的那几格与「自己那一份」分在两处（分开的不只是缓存：客户端据此知道这一格变了不是我的事）', async () => {
  const b = fresh();
  try {
    const d = (await b.rpc({ op: 'cluster' })).data;
    for (const k of ['at', 'health', 'version', 'partitions', 'gres', 'mem',
      'nodes', 'queue', 'taken', 'me']) {
      assert.ok(k in d, `缺了 ${k}：${JSON.stringify(Object.keys(d))}`);
    }
    for (const k of ['account', 'allowed_partitions', 'fairshare', 'pending_count', 'first_in']) {
      assert.ok(k in d.me, `me 里缺了 ${k}：${JSON.stringify(Object.keys(d.me))}`);
    }
  } finally {
    await b.close();
  }
});

test('「获取失败」能立刻造出来，而且它是缺席、不是「没有」', async () => {
  // 真集群上"获取失败"要么得等一次故障、要么得把 sinfo 改名 —— 而"把获取失败画成
  // 没有"正是这一整块最容易犯的错：用户会去查一个不存在的问题。
  const b = fresh();
  try {
    b.debugClusterMissing();
    const d = (await b.rpc({ op: 'cluster' })).data;
    for (const k of ['health', 'version', 'partitions', 'gres', 'mem',
      'nodes', 'queue']) {
      assert.equal(k in d, false, `${k} 应当缺席：${JSON.stringify(d[k])}`);
    }
    // 而 `me` 那一块照常在：一格获取失败不该让整屏都空掉。
    assert.ok(d.me && typeof d.me === 'object', JSON.stringify(d.me));
    assert.equal(d.me.fairshare, null, '公平份额那一格是 null，不是缺席');
  } finally {
    await b.close();
  }
});

test('一格一格地造：只缺席点名的那一格', async () => {
  const b = fresh();
  try {
    b.debugClusterMissing('nodes');
    const d = (await b.rpc({ op: 'cluster' })).data;
    assert.equal('nodes' in d, false, 'nodes 应当缺席');
    assert.ok(d.queue && d.partitions, '其他不该受影响');
  } finally {
    await b.close();
  }
});

test('节点表故意比真集群脏：带后缀的那两个只在测试后端里走得到', async () => {
  // 本机那台真集群四个节点全是 idle/mix，一个带后缀的都没有 —— 于是
  // "剥后缀、只按 base state 计数"在真机上根本走不到。夹具比现实干净，
  // 缺陷就会在用例里隐形（账本 F26）。
  const b = fresh();
  try {
    const d = (await b.rpc({ op: 'cluster' })).data;
    const flags = Object.values(d.nodes).flatMap((n) => Object.keys(n.flags || {}));
    assert.ok(flags.includes('*') && flags.includes('~'),
      `节点表里要有带后缀的：${JSON.stringify(d.nodes)}`);
    // counts 的键必须是剥干净的 base state —— 后缀漏进去就说明剥法坏了。
    for (const n of Object.values(d.nodes)) {
      for (const st of Object.keys(n.counts)) {
        assert.ok(!/[*~#!%@^+-]$/.test(st), `counts 里出现了没剥干净的状态：${st}`);
      }
    }
  } finally {
    await b.close();
  }
});

test('集群那一份带每节点核数、内存余量与 GRES 余量；分区清单不带 used/free', async () => {
  // 0.30 起浮窗要报余量。假后端必须与真守护进程同形，否则"界面上画得出来"
  //   与"真站点上有这一格"是两件事。
  const b = fresh();
  try {
    const d = (await b.rpc({ op: 'cluster' })).data;
    assert.equal(d.nodes.A6000.cpus.total, 78,
      `节点表里要有 %C 累加：${JSON.stringify(d.nodes.A6000)}`);
    assert.deepEqual(d.nodes.A6000.mem_free, { sum: 120000, max: 70000 },
      '内存余量：合计与单节点最多');
    assert.equal(d.gres.A6000[0].used, 2, 'GRES 已用');
    assert.equal(d.gres.A6000[0].free, 6, 'GRES 可用 = 总数 - 已用');
    // 客户端算"这一格有多旧"用服务端时间当基准，不看本机时钟。
    assert.equal(typeof d.now, 'number', '服务端时间要带上');

    // `op_partitions` 那一份是 `NodeCatalog.gres` 的原样投影：不能长出
    //   `used` / `free`（真守护进程那里是复制之后才附上去的）。
    const pv = await b.rpc({ op: 'partitions' });
    assert.equal(pv.ok, true, JSON.stringify(pv).slice(0, 200));
    const a6 = pv.data.partitions.find((x) => x.name === 'A6000');
    assert.equal(a6.cpus_per_node, 78, '分区清单要带每节点核数');
    assert.equal('used' in a6.gres[0], false, '分区清单的 GRES 不带 used');
    assert.equal('free' in a6.gres[0], false, '分区清单的 GRES 不带 free');
    // `DEBUG` 没有内存与核数：那两格缺席 = 没问到，不是 0。
    const dbg = pv.data.partitions.find((x) => x.name === 'DEBUG');
    assert.equal('cpus_per_node' in dbg, false, 'DEBUG 不该有 cpus_per_node');
    assert.equal('mem_per_node_mb' in dbg, false, 'DEBUG 不该有 mem_per_node_mb');
  } finally {
    await b.close();
  }
});

test('队列里有"其余那一档"，而它不并进 running', async () => {
  // 真集群此刻全是 PD，R 与"其余那一档"都走不到 —— 而"不并进 running"是
  // 这一格唯一的判断（并了之后"这个分区忙不忙"就开始说谎）。
  const b = fresh();
  try {
    const d = (await b.rpc({ op: 'cluster' })).data;
    const withOther = Object.values(d.queue.depth).filter((x) => x.other > 0);
    assert.ok(withOther.length > 0,
      `队列里要有"其余那一档"：${JSON.stringify(d.queue.depth)}`);
    for (const x of Object.values(d.queue.depth)) {
      assert.equal(typeof x.running, 'number');
      assert.equal(typeof x.pending, 'number');
    }
  } finally {
    await b.close();
  }
});

test('history 获取失败时是错误，不是空列表', async () => {
  const b = fresh();
  try {
    b.debugHistoryDown(true);
    const r = await b.rpc({ op: 'history' });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error.kind, 'history_unknown', JSON.stringify(r.error));
    // 关键：不是 `ok:true` + `[]` —— 那是"你这几天没有作业"。
    assert.equal(r.data, null, JSON.stringify(r.data));
  } finally {
    await b.close();
  }
});

test('history 里只有作业级记录（作业步不算），且倒序', async () => {
  const b = fresh();
  try {
    const rows = (await b.rpc({ op: 'history' })).data.history;
    // 至少两条 —— 一条的时候下面那条"倒序"是永真的，而永真的断言
    //    与没有断言在输出上分不开。实测：把夹具砍到一条，这条用例照样绿。
    assert.ok(rows.length >= 2, `夹具至少要两条（现在 ${rows.length} 条）`);
    for (const r of rows) {
      assert.ok(!r.job_id.includes('.'), `作业步混进来了：${r.job_id}`);
    }
    // 倒序：最新的在最前。守护进程那边负责倒，这一条钉的是"客户端拿到的
    //   就是那个顺序"—— 假后端要是给正序，测试后端里看到的就是最后那件事
    //   排在最后，而真集群上不是。
    const ids = rows.map((r) => Number(r.job_id));
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), JSON.stringify(ids));
  } finally {
    await b.close();
  }
});

test('复位把这两格的调试开关也一起清掉（否则"复位"之后仍然是不干活的，而界面上没有任何内容说明为什么）', async () => {
  const b = fresh();
  try {
    b.debugClusterMissing();
    b.debugHistoryDown(true);
    b.debugReset();
    const d = (await b.rpc({ op: 'cluster' })).data;
    assert.ok(d.partitions && d.nodes, '复位之后集群信息要回来');
    assert.equal((await b.rpc({ op: 'history' })).ok, true, '复位之后历史要回来');
  } finally {
    await b.close();
  }
});
