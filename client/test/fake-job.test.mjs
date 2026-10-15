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
 * fake-job.test.mjs —— 替身宿主那一段「在哪找 bash、找到了怎么起」。
 *
 * 这一段只在 Windows 上分岔，而这台开发机不是 Windows。所以这里验的全是
 *   `defaultBashSearch(env, platform)` 与 `toWslPath()` 这两条纯函数：喂一个
 *   Windows 形状的环境进去，看它算出来的候选表对不对。
 *
 * 「Git for Windows 那个 bash 排在 WSL 前面」这一条是承重的：前者是原生进程，
 *   插件树、家目录、日志目录都是 Windows 路径，原样交给它就行；后者会把作业侧丢进
 *   另一个文件系统，每一条路径都要翻译。顺序反了不会报错 —— 它只会在 WSL 里
 *   跑到一半才失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { defaultBashSearch, findBash, toWslPath, NO_BASH } = require('../src/main/fake-job.js');

/** 一份 Windows 形状的环境。盘上的真值不重要，切法与顺序才是判据。 */
const WIN_ENV = {
  PATH: 'C:\\Windows\\system32;C:\\Tools;C:\\Program Files\\Git\\cmd',
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
};

test('Windows 上：PATH 按 `;` 切、候选带 `.exe`，而 WSL 排在最后', () => {
  const list = defaultBashSearch(WIN_ENV, 'win32');

  // PATH 的三段各出一个候选 —— 按 `:` 切的话这里会是一堆半个盘符的怪物。
  assert.deepEqual(list.slice(0, 3), [
    'C:\\Windows\\system32\\bash.exe',
    'C:\\Tools\\bash.exe',
    'C:\\Program Files\\Git\\cmd\\bash.exe',
  ], 'PATH 必须按 `;` 切，而且候选名带 `.exe`');

  // Git for Windows 的两个惯例落点都在（PATH 里没有它时靠这几个）。
  assert.ok(list.includes('C:\\Program Files\\Git\\bin\\bash.exe'),
    'Git 装在 Program Files 时要在 PATH 之外也找得到');
  assert.ok(list.includes('C:\\Users\\alice\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'),
    '装在用户目录（免管理员的那种装法）时也要找得到');

  // WSL 在最后，而且被标出来。
  const last = list[list.length - 1];
  assert.deepEqual(last, { path: 'C:\\Windows\\System32\\bash.exe', wsl: true },
    'WSL 那个必须排在最后，并且标着 wsl —— 它要翻译路径');
  assert.equal(list.slice(0, -1).some((x) => x && x.wsl), false,
    '除了它，其他候选都不是 WSL 那个');
});

test('WSL 的路径：本地盘翻得出来，翻不动的返回 null（不猜）', () => {
  assert.equal(toWslPath('C:\\Users\\alice\\AppData\\Roaming\\Slurmate\\x'),
    '/mnt/c/Users/alice/AppData/Roaming/Slurmate/x');
  assert.equal(toWslPath('d:/tmp/x'), '/mnt/d/tmp/x', '小写盘符与正斜杠也要认');

  // 翻不动的一律 null。猜一个的后果是作业往一个不存在的地方写会话文件，
  //   然后失败在一句与真相无关的话上。
  for (const p of ['\\\\server\\share\\x', '/home/alice/x', 'x/y', '']) {
    assert.equal(toWslPath(p), null, `${JSON.stringify(p)} 不该翻出一个值`);
  }
});

test('找到了就带 `wsl` 标记，未找到仍然是那句 `NO_BASH`', () => {
  // 本机有 `/bin/bash`：注入它，验的是"找到了之后返回什么"。
  assert.deepEqual(findBash(['/bin/bash']), { path: '/bin/bash', wsl: false });
  assert.deepEqual(findBash([{ path: '/bin/bash', wsl: true }]),
    { path: '/bin/bash', wsl: true }, '候选表里标了 wsl 的，找到之后要带着这个标记');
  assert.equal(findBash(['/nonexistent/bash']), NO_BASH,
    '一个都没找到时返回的必须还是同一句话（`debugNoBash` 造的就是这句）');
  assert.match(NO_BASH.why, /Git for Windows/,
    'Windows 上没有 bash 时，那句话要说出下一步是什么');
});

test('非 Windows 上仍然按 `:` 切，而且仍补上那三个惯例位置', () => {
  const list = defaultBashSearch({ PATH: '/usr/bin:/bin' }, 'linux');
  assert.deepEqual(list.slice(0, 2), ['/usr/bin/bash', '/bin/bash'],
    'PATH 那两段在前，按 `:` 切');
  for (const p of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
    assert.ok(list.includes(p), `惯例位置 ${p} 仍然要在（GUI 启动的程序 PATH 很短）`);
  }
  assert.equal(list.some((x) => x && typeof x === 'object'), false,
    '非 Windows 上没有任何一条是 WSL 那种带标记的候选');
});
