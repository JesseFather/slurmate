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
 * packaging.test.mjs —— 「跑出 `client/src` 的东西，安装包里还在不在」。
 *
 * 打包版里只有 `files:` 白名单收进去的那些文件（今天是 `src/` 底下的一切与
 *   `package.json`），而运行期还有两样东西的家不在这儿：
 *
 *   · 打包器（`packer/slurmate-packer.js`）：假站点要现打一个客户端侧容器
 *     才能把插件发给客户端。靠 `extraResources` 带进来。
 *   · 替身宿主（`src/main/fake-job-host.sh`）：它要交给一个外部的 bash，
 *     而外部进程读不了 asar。靠 `asarUnpack` 解出来。
 *
 * 这两条在打包版上断掉的样子一模一样：客户端一切正常，只有一件功能不出声地
 *   不工作 —— 站点报得出插件却一个都发不出来；或者一提交就"作业侧起不来"。
 *   而这台机器上跑 `node --test` 是全绿的，因为源码树里两样都在。
 *
 * 所以这一份钉三件事：
 *   ① `app-assets.js` 那两条路径算法对（纯函数，源码树与安装包各算一遍）；
 *   ② `electron-builder.yml` 里的声明与那两条算法对得上（改了 `to:` 而不改
 *      算法，或者反过来，都要红）；
 *   ③ 整个 `client/src` 里再没有第三条跑出 `src/` 的路径 —— 有的话必须在这里
 *      留下交代，否则它在打包版上就是又一个"只有一件功能不出声地不工作"。
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

/** 顶格那一段配置的正文。取不到就返回空串 —— 调用方一律断言它非空。 */
function blockOf(key) {
  const at = yml.indexOf(`\n${key}:`);
  if (at === -1) return '';
  const rest = yml.slice(at + 1);
  const end = rest.slice(key.length + 1).search(/\n\S/);
  return end === -1 ? rest : rest.slice(0, end + key.length + 1);
}

test('★★ 打包器在源码树与安装包里算到同一个地方，而那个地方由 extraResources 定', () => {
  // 源码树：`client/src/main` 往上三层是仓库根。
  assert.equal(appAssets.packerPath(path.join('repo', 'client', 'src', 'main')),
    path.join('repo', 'packer', 'slurmate-packer.js'));
  // 安装包：`<resources>/app.asar/src/main` 往上三层是 `<resources>`。
  const inPkg = appAssets.packerPath(path.join('/r', 'app.asar', 'src', 'main'));
  assert.equal(inPkg, path.join('/r', 'packer', 'slurmate-packer.js'));

  // 上面那个路径不是随便定的：它就写在 `extraResources` 的 `to:` 里。两条一起
  //   改才对，只改一条的后果是打包版上找不到打包器，而源码树里全绿。
  const block = blockOf('extraResources');
  assert.ok(block, 'electron-builder.yml 里找不到 extraResources 段 —— 这条判据失去目标');
  const m = /to:\s*(\S+)/.exec(block);
  assert.ok(m, 'extraResources 里找不到 `to:` —— 判据失去目标');
  assert.equal(inPkg, path.join('/r', ...m[1].split('/')),
    'app-assets.js 算出来的位置与 electron-builder.yml 的 `to:` 对不上：'
    + '改一处就要改另一处');
});

test('★★ 替身宿主被解出 asar，而 fake-job.js 交出去的正是那一份', () => {
  const block = blockOf('asarUnpack');
  assert.ok(block, 'electron-builder.yml 里找不到 asarUnpack 段 —— 这条判据失去目标');
  assert.match(block, /^\s*-\s*src\/main\/fake-job-host\.sh\s*$/m,
    'asarUnpack 必须解出 src/main/fake-job-host.sh：外部 bash 读不了 asar 里的文件');

  // 声明在配置里不等于用上了。交路径的那一处必须真的过一遍 `unpacked()`。
  const src = fs.readFileSync(path.join(SRC, 'main', 'fake-job.js'), 'utf8');
  assert.match(src,
    /appAssets\.unpacked\(\s*path\.join\(__dirname,\s*'fake-job-host\.sh'\)\s*\)/,
    'fake-job.js 交给 bash 的那个路径必须过 `appAssets.unpacked()`：'
    + '少了它，打包版上那次 spawn 拿到的是 asar 里的路径，而症状只是'
    + '「作业侧起不来」');
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
    '打包器：`extraResources` 带进包，落点由上面那条判据钉着'],
  [/[/\\]package\.json$/,
    '客户端自己的 package.json：`files:` 白名单里有它（版本号那一处读它）'],
  [/[/\\]plugins$/,
    '开发样例那一棵。打包版里没有它是对的（基座两端都不带插件），'
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

test('★★ 跑出 client/src 的路径只有那几处，而且各自都交代过', () => {
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
      + '要么把它挪进 src/，要么在上面那张表里写清它怎么活下来');
  }
});
