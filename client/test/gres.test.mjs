/**
 * gres.test.mjs —— 界面那一行的 GRES 部分怎么念。
 *
 * ★★ 这个模块存在的理由是**这一行曾经假定 GRES 只有一种形状**。
 *   panel.js 从前写的是 `typeof r.gpus === 'number' && r.gpus > 0`，
 *   而守护进程发的是 `resources.gpus` 那个数字。GRES 是管理员在
 *   `GresTypes` + `gres.conf` 里自定义的：名字可以是 `gpu`，也可以是 `mps`；
 *   同一个名字还可以带型号（`gpu:a100`）。
 *   ⇒ 带型号的集群上作业占着两张 A100，而界面上那一段**整个不出现** ——
 *   不报错、不提示，用户以为它没要卡。
 *
 * ★ 所以这里守两件事：**带型号的要念出型号**，以及**名字不是 gpu 的照样念**。
 *   而它不做任何判定：合法不合法、能不能要到，一件在服务端、一件在 Slurm。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { gresLabel, gresText } = require('../src/main/gres.js');

const here = path.dirname(fileURLToPath(import.meta.url));

test('没要 GRES / 拿不到 → null（界面显示「—」，不编一个）', () => {
  for (const bad of [null, undefined, {}, '', 0, 'gpu:2', { type: 'a100' },
                     { name: '', count: 2 }, { name: 2, count: 2 }]) {
    assert.equal(gresText(bad), null, JSON.stringify(bad));
    assert.equal(gresLabel(bad), null, JSON.stringify(bad));
  }
});

test('★ 没型号的：`gpu × 2`', () => {
  assert.equal(gresText({ name: 'gpu', type: null, count: 2 }), 'gpu × 2');
  assert.equal(gresLabel({ name: 'gpu', type: null, count: 2 }), 'gpu');
});

test('★★ 带型号的：型号必须念出来', () => {
  // 这一条就是今天红的那一格：型号丢掉之后，`gpu:a100 × 2` 与 `gpu × 2`
  // 在界面上长得一样，而它们是两种完全不同的卡。
  assert.equal(gresText({ name: 'gpu', type: 'a100', count: 2 }), 'gpu:a100 × 2');
  assert.equal(gresLabel({ name: 'gpu', type: 'a100', count: 2 }), 'gpu:a100');
});

test('★ 名字不是 gpu 的照样念（GRES 是管理员自定义的，代码里没有白名单）', () => {
  for (const [g, want] of [
    [{ name: 'mps', type: null, count: 100 }, 'mps × 100'],
    [{ name: 'shard', type: 'fast', count: 1 }, 'shard:fast × 1'],
  ]) {
    assert.equal(gresText(g), want, JSON.stringify(g));
  }
});

test('空串的 type 与 null 是一回事（服务端两种都可能送）', () => {
  // 服务端 clean_gres() 会把 "" 收成 null，而老站点/手工造的载荷可能留着 ""。
  // 两种都念成"没型号"，别输出 `gpu: × 2` 那种东西。
  assert.equal(gresText({ name: 'gpu', type: '', count: 2 }), 'gpu × 2');
});

test('count 缺失或不是整数时只念名字（不印 `× null`）', () => {
  for (const bad of [undefined, null, '2', 2.5, NaN]) {
    assert.equal(gresText({ name: 'gpu', type: 'a100', count: bad }),
      'gpu:a100', `count=${JSON.stringify(bad)}`);
  }
});

test('★ 界面那一行印的是 gresText，不是 typeof r.gpus === number', async () => {
  // 本机起不了 Electron（panel.js 跑不起来），所以这一条只能做文本检查。
  // 它拦的是**退回按数字判**这个退化 —— 那正是这一版要修的东西。
  const js = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'panel.js'),
    'utf8');
  assert.match(js, /s\.gresText\s*\|\|/, '资源那一行要用主进程译好的 gresText');
  assert.equal(/typeof r\.gpus\s*===\s*'number'/.test(js), false,
    'panel.js 又在按数字判 GRES 了 —— 那等于假定 GRES 只有 gpu 一种、而且不带型号');
  assert.equal(/\br\.gpus\b/.test(js), false,
    'panel.js 还在读 resources.gpus —— 那个字段已经不存在了（现在是 gres 描述符）');
});

test('★ 主进程确实把 gresText 放进了快照', async () => {
  const js = fs.readFileSync(path.join(here, '..', 'src', 'main', 'session.js'),
    'utf8');
  assert.match(js, /const \{ gresText \} = require\('\.\/gres\.js'\)/,
    'session.js 要 require gres.js');
  assert.match(js, /snap\.gresText = gresText\(/, '快照里要有 gresText');
});
