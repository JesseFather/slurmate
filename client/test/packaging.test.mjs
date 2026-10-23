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
 * packaging.test.mjs —— 安装包里带什么、不带什么。
 *
 * 打包版里只有 `files:` 白名单收进去的那些文件。测试后端要用的那几样
 *   （`backend-fake.js`、`fake-job.js`、`fake-job-host.sh`、`demo-server.js`、
 *   `preload/demo.js`、`src/demo/`）只服务测试进程，安装包里一个都不带；
 *   打包器在仓库根，也不带。
 *
 * 这一份钉三件事：
 *   ① 假站点那几个模块都在 `files` 的排除项里；
 *   ② 不再有 `extraResources` / `asarUnpack`（那两条只为开发者模式存在）；
 *   ③ 整个 `client/src` 里跑出 `src/` 的路径只有那几处，各自有交代。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const appAssets = require('../src/main/app-assets.js');

const CLIENT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(CLIENT, 'src');
const YML = path.join(CLIENT, 'electron-builder.yml');
const yml = fs.readFileSync(YML, 'utf8');

/** 顶格那一段配置的正文。获取失败就返回空串 —— 调用方一律断言它非空。 */
function blockOf(key) {
  const at = yml.indexOf(`\n${key}:`);
  if (at === -1) return '';
  const rest = yml.slice(at + 1);
  const end = rest.slice(key.length + 1).search(/\n\S/);
  return end === -1 ? rest : rest.slice(0, end + key.length + 1);
}

test('假站点那几个模块全部排除在安装包之外', () => {
  const block = blockOf('files');
  assert.ok(block, 'electron-builder.yml 里未找到 files 段 —— 这条判据失去目标');
  for (const rel of ['src/main/backend-fake.js', 'src/main/fake-job.js',
                     'src/main/fake-job-host.sh', 'src/main/demo-server.js',
                     'src/preload/demo.js', 'src/demo/**']) {
    assert.match(block, new RegExp(`^\\s*-\\s*'?!${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'?\\s*$`, 'm'),
      `files 里没有排除 ${rel} —— 它只服务测试后端，不该进安装包`);
  }
  // 那两条只为开发者模式存在的声明，整段删掉了。
  assert.equal(blockOf('extraResources'), '', 'extraResources 不该再出现');
  assert.equal(blockOf('asarUnpack'), '', 'asarUnpack 不该再出现');

  // 打包器在仓库根；源码树里那两条算法仍然要能算到它（测试从源码跑）。
  assert.equal(appAssets.packerPath(path.join('repo', 'client', 'src', 'main')),
    path.join('repo', 'packer', 'slurmate-packer.js'));
  assert.equal(appAssets.packerPath(path.join('/r', 'app.asar', 'src', 'main')),
    path.join('/r', 'packer', 'slurmate-packer.js'));
});

// ── ③ 跑出 `src/` 的路径：全都在这里有一句交代 ───────────────────────────────

/**
 * 允许跑出 `client/src` 的位置，各带一句"它在安装包里怎么活下来"。
 *
 * 加一条新的就必须在这里加一行 —— 那不是走过场：这一行要回答的正是
 *   「打包版上这个位置还在不在」。
 */
const ALLOWED_ESCAPES = [
  [/[/\\]packer[/\\]slurmate-packer\.js$/,
    '打包器：只服务测试后端（从源码跑），安装包里不带它'],
  [/[/\\]package\.json$/,
    '客户端自己的 package.json：`files:` 白名单里有它（版本号那一处读它）'],
  [/[/\\]plugins$/,
    '开发样例那一棵。安装包里没有它是对的（基座两端都不带插件），'
    + '调用方按"不在就 null"处理'],
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('跑出 client/src 的路径只有那几处，而且各自都交代过', () => {
  const found = [];
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const here = path.dirname(file);
    const escapes = (target) => !target.startsWith(SRC + path.sep);

    // ① `require('../..')` 形态。
    for (const m of src.matchAll(/require\(\s*(['"])(\.{1,2}\/[^'"]*)\1\s*\)/g)) {
      const target = path.resolve(here, m[2]);
      if (escapes(target)) found.push({ file, target, how: `require('${m[2]}')` });
    }
    // ② `path.join(<基>, '..', …)` 形态。
    //    基不是 `__dirname` 的那些（`packerPath(from)` 那一类）按它的缺省值
    //    算 —— 也就是这个文件自己所在的目录，因为缺省就是 `__dirname`。
    //    只认含 `..` 的：不含 `..` 的段（`'/'`、`'demo'`）拼不出 src 之外。
    for (const m of src.matchAll(/path\.join\(\s*([A-Za-z_$][\w$.]*)\s*,([^)]*)\)/g)) {
      const parts = [...m[2].matchAll(/(['"])([^'"]*)\1/g)].map((x) => x[2]);
      if (!parts.includes('..')) continue;
      const target = path.resolve(here, ...parts);
      if (escapes(target)) {
        found.push({ file, target, how: `path.join(${m[1]}, ${parts.map((p) => `'${p}'`).join(', ')})` });
      }
    }
  }

  // 先验扫描集不是空的：一个什么都没扫到的判据，与一个全过的判据在输出上同形。
  //   而这一条里承重的那一笔是打包器 —— 它不在扫描结果里就说明扫描瞎了，
  //   下面那张允许表也就成了摆设。
  assert.ok(found.some((f) => /[/\\]packer[/\\]slurmate-packer\.js$/.test(f.target)),
    `扫描结果里没有打包器那条路径（只找到 ${found.length} 条：`
    + `${found.map((f) => f.target).join('、')}）—— 这条判据多半已经瞎了`);

  for (const f of found) {
    const hit = ALLOWED_ESCAPES.find(([re]) => re.test(f.target));
    assert.ok(hit,
      `${path.relative(CLIENT, f.file)} 的 ${f.how} 指到 ${f.target}，跑出了 client/src。`
      + '打包版里那个位置不存在 —— 要么在 electron-builder.yml 里声明它，'
      + '要么把它移动进 src/，要么在上面那张表里写清它怎么活下来');
  }
});

// ── 图标 ────────────────────────────────────────────────────────────────────

/**
 * 图标那条路径写错了不会报错：打包照样成功，只是安装包换回 Electron 的默认图标。
 *   所以在这里钉住三件事 —— 三平台指向同一个文件、文件在、PNG 够大；顺带把
 *   "两份 SVG 真的被界面用到"也钉住，免得哪天界面改了而资产留在原地没人读。
 */
test('三平台图标指向同一份 PNG，两份 SVG 都被界面用到', () => {
  const ICON = 'src/renderer/icon.png';
  const esc = ICON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const key of ['win', 'mac', 'linux']) {
    const block = blockOf(key);
    assert.ok(block, `electron-builder.yml 里未找到 ${key} 段 —— 这条判据失去目标`);
    assert.match(block, new RegExp(`^\\s*icon:\\s*${esc}\\s*$`, 'm'),
      `${key} 段没有指向 ${ICON} —— 打包出来的安装包会退回 Electron 的默认图标`);
  }

  const png = path.join(CLIENT, ICON);
  assert.ok(fs.existsSync(png), `${ICON} 不在`);
  // PNG 的 IHDR 在文件头：8 字节签名 + 4 长度 + 4 类型，宽高各 4 字节（大端）。
  const head = fs.readFileSync(png).subarray(0, 24);
  assert.equal(head.subarray(1, 4).toString('latin1'), 'PNG', `${ICON} 不是 PNG`);
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  assert.ok(width >= 512 && height >= 512,
    `${ICON} 是 ${width}×${height} —— 低于 512 见方时 app-builder 转不出 .icns`);

  const RENDERER = path.join(SRC, 'renderer');
  for (const f of ['icon.svg', 'icon-anim.svg']) {
    assert.ok(fs.existsSync(path.join(RENDERER, f)), `src/renderer/${f} 不在`);
  }
  assert.match(fs.readFileSync(path.join(RENDERER, 'panel.html'), 'utf8'),
    /<img class="brand-mark" src="icon\.svg"/,
    'panel.html 里没有那枚静止图标 —— icon.svg 成了没人读的资产');
  assert.match(fs.readFileSync(path.join(RENDERER, 'panel.js'), 'utf8'),
    /icon-anim\.svg/,
    'panel.js 里没有加载动画 —— icon-anim.svg 成了没人读的资产');
});
