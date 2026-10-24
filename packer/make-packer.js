#!/usr/bin/env node
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

'use strict';
/**
 * make-packer.js — 把 `docs/` 里的三份嵌进打包器，产出发出去的那一个文件。
 *
 * 为什么要把文档嵌进去：插件作者的工作目录是他自己的插件仓库，基座仓库对他
 *   来说是别人的仓库。只发一个 `.js`、把规范留在仓库里，等于让他去翻别人的
 *   目录 —— 与"管理员不该被指向源码文档"是同一条理由。嵌完之后，工具与它的
 *   文档是同一份文件，`docs` 动词把它们写到磁盘上。
 *
 * 用法： node packer/make-packer.js [--out <文件>]
 *
 * 默认写到 `dist/slurmate-packer-<版本>.js`。版本从 `cluster/slurmate-sessiond`
 *   的 `VERSION` 读 —— 与站点包同一个来源，不在这里抄第二份名单。
 *
 * 这件事没有放进 `slurmate-packer.js` 自己：那个文件要能被直接跑（源码树里
 *   开发时就是这样），而"把文档装进来"是一次构建动作，不是它的一个动词。
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.dirname(HERE);
const SOURCE = path.join(HERE, 'slurmate-packer.js');
const DOC_DIR = path.join(HERE, 'docs');
const DOC_NAMES = ['README.md', 'PLUGIN-SPEC.md', 'PLUGIN-CONTAINER.md'];
const MARKER = 'const DOCS = null;   // @EMBED-DOCS@';

function die(msg) {
  console.error(`  [中止] ${msg}`);
  process.exit(1);
}

function version() {
  const f = path.join(ROOT, 'cluster', 'slurmate-sessiond');
  const lines = fs.readFileSync(f, 'utf8')
    .split('\n').filter((l) => /^VERSION = ".*"$/.test(l));
  if (lines.length !== 1) {
    die(`${f} 里匹配 ^VERSION = "..." 的行有 ${lines.length} 行，该正好 1 行`);
  }
  const v = lines[0].slice('VERSION = "'.length, -1);
  if (!v) die('版本号是空的');
  return v;
}

function main(argv) {
  let out = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' || argv[i] === '-o') out = argv[++i] || '';
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('用法： node packer/make-packer.js [--out <文件>]');
      return 0;
    } else die(`未知参数: ${argv[i]}`);
  }

  const src = fs.readFileSync(SOURCE, 'utf8');
  const hits = src.split(MARKER).length - 1;
  if (hits !== 1) {
    die(`源码里那一行占位标记出现了 ${hits} 次，该正好 1 次：\n  ${MARKER}`);
  }

  const docs = {};
  for (const n of DOC_NAMES) {
    const f = path.join(DOC_DIR, n);
    if (!fs.existsSync(f)) die(`文档缺失：${f}`);
    docs[n] = fs.readFileSync(f, 'utf8');
  }

  // JSON 是 JavaScript 的子集，所以 `JSON.stringify` 的输出直接就是一份合法的
  //   对象字面量 —— 反引号、`${`、反斜杠都由它转义，不必自己写一遍。
  const embedded = `const DOCS = ${JSON.stringify(docs, null, 2)};`;
  // 用函数形态的替换：文档里有 `$&`、`$'`、`$1` 这些写法（shell 变量），
  //   而字符串形态的替换会把它们当成替换模式解释 —— 上一版就是这么把标记
  //   拼回了产物里、还截断了文档。
  const built = src.replace(MARKER, () => embedded);

  if (!out) out = path.join(ROOT, 'dist', `slurmate-packer-${version()}.js`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, built, 'utf8');

  console.log(`  ${out}`);
  console.log(`  ${DOC_NAMES.join(' / ')} 已经嵌进去（${Buffer.byteLength(built)} 字节）`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
