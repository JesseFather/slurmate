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
import zlib from 'node:zlib';
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

/**
 * 读 PNG 里一个像素的 RGBA。只认 8 位、非隔行的那几种颜色类型 —— 图标是我们
 *   自己导出的这一种，遇上别的形状直接抛错，而不是猜。
 *
 * 为什么要真解码：`icon.png` 曾经是不透明的白底（颜色类型仍是带 alpha 的 6），
 *   于是 Windows 任务栏上是"白框里套一个深色方框"。只看 IHDR 或文件大小都判不出
 *   这一格，必须把 alpha 读出来。
 */
function pixelOf(buf, x, y) {
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', '不是 PNG');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  assert.equal(depth, 8, `位深是 ${depth}，这条判据只认 8 位`);
  assert.equal(interlace, 0, '隔行 PNG 这条判据不认');
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  assert.ok(ch, `颜色类型 ${colorType} 没有 alpha 通道的形状，这条判据不认`);

  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString('latin1');
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
    if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  let off = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
  };
  for (let row = 0; row <= y; row += 1) {
    const filter = raw[off]; off += 1;
    for (let i = 0; i < stride; i += 1) {
      const x0 = raw[off + i];
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v;
      if (filter === 0) v = x0;
      else if (filter === 1) v = x0 + a;
      else if (filter === 2) v = x0 + b;
      else if (filter === 3) v = x0 + ((a + b) >> 1);
      else if (filter === 4) v = x0 + paeth(a, b, c);
      else assert.fail(`第 ${row} 行的过滤类型是 ${filter}`);
      cur[i] = v & 0xff;
    }
    off += stride;
    cur.copy(prev);
    if (row !== y) cur = Buffer.alloc(stride);
  }
  const base = x * ch;
  return ch === 4
    ? [cur[base], cur[base + 1], cur[base + 2], cur[base + 3]]
    : [cur[base], cur[base + 1], cur[base + 2], 255];
}

// ── 图标 ────────────────────────────────────────────────────────────────────

/**
 * 图标那条路径写错了不会报错：打包照样成功，只是安装包换回 Electron 的默认图标。
 *   所以在这里钉住四件事 —— 每一端指向的文件、文件在、PNG 够大、方底以外是透的
 *   （Windows 任务栏那块白底就是这么漏出去的）；顺带把"两份 SVG 真的被界面用到"
 *   也钉住，免得哪天界面改了而资产留在原地没人读。
 *
 * Windows 单独一份 `icon-win.png`：方底铺满画布。macOS 与 Linux 用留边的
 *   `icon.png`（macOS 的图标本来就该留白，Linux 的桌面环境会自己摆）。
 */
test('三平台图标各指向该用的那份 PNG，两份都够大且透底', () => {
  const ICON = 'src/renderer/icon.png';
  const WIN_ICON = 'src/renderer/icon-win.png';
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [key, file] of [['win', WIN_ICON], ['mac', ICON], ['linux', ICON]]) {
    const block = blockOf(key);
    assert.ok(block, `electron-builder.yml 里未找到 ${key} 段 —— 这条判据失去目标`);
    assert.match(block, new RegExp(`^\\s*icon:\\s*${esc(file)}\\s*$`, 'm'),
      `${key} 段没有指向 ${file} —— 打包出来的安装包会退回 Electron 的默认图标`);
  }

  for (const rel of [ICON, WIN_ICON]) {
    const png = path.join(CLIENT, rel);
    assert.ok(fs.existsSync(png), `${rel} 不在`);
    // PNG 的 IHDR 在文件头：8 字节签名 + 4 长度 + 4 类型，宽高各 4 字节（大端）。
    const buf = fs.readFileSync(png);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.ok(width >= 512 && height >= 512,
      `${rel} 是 ${width}×${height} —— 低于 512 见方时 app-builder 转不出 .icns/.ico`);
    // 左上角在方底之外：透的。方底里面（正中）不透明。
    assert.equal(pixelOf(buf, 0, 0)[3], 0,
      `${rel} 的左上角不透明 —— 方底外面垫了一层底色，任务栏上会多出一个方块`);
    assert.equal(pixelOf(buf, width >> 1, height >> 1)[3], 255,
      `${rel} 的正中是透的 —— 那不是这张图该有的样子`);
  }

  const RENDERER = path.join(SRC, 'renderer');
  for (const f of ['icon.svg', 'icon-win.svg', 'icon-mark.svg', 'icon-anim.svg']) {
    assert.ok(fs.existsSync(path.join(RENDERER, f)), `src/renderer/${f} 不在`);
  }
  // 四份各管一处：两份方底是系统图标（Windows 一份、其余一份），裸的静止与
  //   动画在界面里。
  assert.match(fs.readFileSync(path.join(RENDERER, 'panel.html'), 'utf8'),
    /<img class="brand-mark" src="icon-mark\.svg"/,
    'panel.html 里没有那枚静止记号 —— 它成了没人读的资产');
  assert.match(fs.readFileSync(path.join(RENDERER, 'panel.js'), 'utf8'),
    /icon-anim\.svg/,
    'panel.js 里没有加载动画 —— icon-anim.svg 成了没人读的资产');
});
