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
 * shortcuts.test.mjs —— 按键拦截表。
 *
 * 这段逻辑是安全/体验相关的：它决定哪些键到达页面、哪些被吞掉。
 * 表写反了的表现是「Ctrl+W 把窗口关了」或者「编辑器快捷键全废」，
 * 而这两种都不会有任何报错。
 *
 * 本机没有 Xvfb，跑不了真 Electron，所以用一个桩接住 `require('electron')`。
 * 这里测的是纯逻辑（匹配表、isComposing 放行），不是 Electron 的按键分发 ——
 * 后者的最终判定要靠真机上的回显页（见 README）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

// ── 桩：只提供 shortcuts.js 需要的那几个符号 ──────────────────────────────
const electronStub = {
  Menu: {
    setApplicationMenu: (m) => { electronStub._lastMenu = m; },
    buildFromTemplate: (tpl) => ({ tpl }),
  },
  _lastMenu: undefined,
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};

const require = createRequire(import.meta.url);
const { installMenu, attachKeyGuard, describe, BLACKLIST, OWNED,
        worthReporting } = require('../src/main/shortcuts.js');

/** 造一个假的 webContents，只实现 on / removeListener。 */
function fakeWc() {
  const handlers = {};
  return {
    handlers,
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    removeListener(ev, fn) {
      handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn);
    },
    /** 模拟一次按键，返回「是否被吞掉」和「触发了什么动作」。 */
    press(input) {
      let prevented = false;
      let action = null;
      const event = { preventDefault: () => { prevented = true; } };
      for (const fn of handlers['before-input-event'] || []) {
        fn(event, { type: 'keyDown', isComposing: false, isAutoRepeat: false,
                    control: false, shift: false, alt: false, meta: false, key: '', ...input });
      }
      return { prevented, action };
    },
  };
}

function guard(input) {
  const wc = fakeWc();
  const got = { blocked: [], owned: [] };
  attachKeyGuard(wc, {
    onBlocked: (d) => got.blocked.push(d),
    onOwned: (a) => got.owned.push(a),
  });
  return { wc, got, ...wc.press(input) };
}

// ── 菜单 ────────────────────────────────────────────────────────────────────
test('菜单里绝不能出现 reload / close / devtools / zoom 这些 role', () => {
  electronStub._lastMenu = undefined;
  installMenu();
  const menu = electronStub._lastMenu;
  // 注意：Linux 上正确的值就是 null（菜单被整个去掉），所以不能用 assert.ok(menu)。
  // 要断言的是「setApplicationMenu 被调用过」。
  assert.notEqual(menu, undefined, '应当调用过 setApplicationMenu');

  if (process.platform === 'darwin') {
    const roles = menu.tpl.flatMap((m) => (m.submenu || []).map((x) => x.role)).filter(Boolean);
    assert.ok(roles.includes('appMenu') || menu.tpl.some((m) => m.role === 'appMenu'),
      'macOS 必须有 appMenu，否则 Cmd+Q/C 全废');
    for (const bad of ['reload', 'forceReload', 'toggleDevTools', 'close', 'quit',
                       'zoomIn', 'zoomOut', 'resetZoom', 'togglefullscreen']) {
      assert.equal(roles.includes(bad), false, `macOS 菜单不该含 ${bad}`);
    }
    // Cmd+Z 不该在菜单里 —— Monaco 有自己的撤销栈，菜单 role 会双重触发，
    // 而重复撤销是会毁掉用户工作的（复制粘贴重复一次无所谓）。
    assert.equal(roles.includes('undo'), false, 'macOS 菜单不该含 undo');
    assert.equal(roles.includes('redo'), false, 'macOS 菜单不该含 redo');
    assert.ok(roles.includes('copy') && roles.includes('paste'),
      'macOS 的复制粘贴必须靠菜单 role');
  } else {
    assert.equal(menu, null, 'Windows/Linux 应当把菜单整个去掉');
  }
});

// ── 拦截 ────────────────────────────────────────────────────────────────────
test('Ctrl+W / Ctrl+N / F5 / Ctrl+R 必须到达页面 —— 这正是要解决的问题', () => {
  for (const input of [
    { key: 'w', control: true },
    { key: 'W', control: true, shift: true },
    { key: 'n', control: true },
    { key: 't', control: true },
    { key: 'F5' },
    { key: 'r', control: true },
    { key: 'p', control: true },        // VS Code 的快速打开
    { key: '=', control: true },        // VS Code 的编辑器缩放
    { key: '-', control: true },
    { key: '0', control: true },
    { key: 'F6' },
  ]) {
    const r = guard(input);
    assert.equal(r.prevented, false,
      `${input.key}（ctrl=${!!input.control}）不该被吞 —— 它必须到达 code-server`);
  }
});

test('开发者工具与全屏永远被吞', () => {
  for (const input of [
    { key: 'F12' },
    { key: 'I', control: true, shift: true },
    { key: 'i', control: true, shift: true },
    { key: 'J', control: true, shift: true },
    { key: 'C', control: true, shift: true },
    { key: 'F11' },
  ]) {
    const r = guard(input);
    assert.equal(r.prevented, true, `${describe(input)} 应当被吞`);
    assert.equal(r.got.blocked.length, 1);
  }
});

test('Ctrl+Shift+R 被我们接管，不落到页面', () => {
  const r = guard({ key: 'R', control: true, shift: true });
  assert.equal(r.prevented, true);
  assert.deepEqual(r.got.owned, ['reload']);
});

test('修饰键必须精确匹配 —— Ctrl+W 吞掉，但没按 Ctrl 的 W 不该动', () => {
  assert.equal(guard({ key: 'w', control: true }).prevented, false);
  assert.equal(guard({ key: 'w' }).prevented, false, '单独按 w 当然要放行');

  // Ctrl+Shift+F11 不等于 F11 —— 不该被我们的表匹配到（留给页面）
  assert.equal(guard({ key: 'F11', control: true }).prevented, false);
  // Ctrl+I 不是 Ctrl+Shift+I
  assert.equal(guard({ key: 'i', control: true }).prevented, false);
  // Alt+F11 不该被吞
  assert.equal(guard({ key: 'F11', alt: true }).prevented, false);
});

test('输入法组合期间一律放行 —— 否则中文输入法会被吃掉', () => {
  const wc = fakeWc();
  const got = { blocked: 0 };
  attachKeyGuard(wc, { onBlocked: () => { got.blocked++; } });

  let prevented = false;
  const event = { preventDefault: () => { prevented = true; } };
  // isComposing=true 时，即使是黑名单里的键也必须放行
  for (const fn of wc.handlers['before-input-event']) {
    fn(event, { type: 'keyDown', isComposing: true, key: 'F12',
                control: false, shift: false, alt: false, meta: false });
  }
  assert.equal(prevented, false, 'isComposing 期间不能吞任何键');
  assert.equal(got.blocked, 0);
});

test('诊断：只报被吞掉的键，放行的一个字都不报', () => {
  // 2026-10-16 用户报的那一条：插件界面的日志里刷满「已放行：Ctrl+C」。
  //   那道诊断（"按键到底有没有直达页面"）核完之后就是噪音 —— 每按一次带修饰键
  //   的键、每按一次 F 键都写一行，把真正要紧的消息顶掉。
  //   留下的是"被我们吞掉的键"：那是在解释"按了为什么没反应"。
  const r1 = guard({ key: 'w', control: true });
  assert.deepEqual(r1.got.blocked, [], '放行的键一条都不该报');

  const r2 = guard({ key: 'F5' });
  assert.deepEqual(r2.got.blocked, [], 'F5 是放行的（页面自己处理），也不报');

  const r3 = guard({ key: 'F12' });
  assert.equal(r3.got.blocked.length, 1, '吞掉的键要报，否则用户不知道按了为什么没反应');
  assert.match(r3.got.blocked[0], /F12/);
});

test('keyUp 不重复触发诊断与动作（只处理 keyDown）', () => {
  const wc = fakeWc();
  const got = { blocked: [], owned: [] };
  attachKeyGuard(wc, {
    onBlocked: (d) => got.blocked.push(d),
    onOwned: (a) => got.owned.push(a),
  });
  const event = { preventDefault: () => {} };
  const input = { isComposing: false, key: 'R', control: true, shift: true,
                  alt: false, meta: false };
  for (const fn of wc.handlers['before-input-event']) {
    fn(event, { ...input, type: 'keyUp' });
    fn(event, { ...input, type: 'keyDown' });
  }
  assert.deepEqual(got.owned, ['reload'], '按住不动不该触发两次');
  assert.equal(got.blocked.length, 1);
});

test('卸载函数真的把监听器摘掉', () => {
  const wc = fakeWc();
  const off = attachKeyGuard(wc, {});
  assert.equal(wc.handlers['before-input-event'].length, 1);
  off();
  assert.equal(wc.handlers['before-input-event'].length, 0);
});

test('黑名单本身要短 —— 每加一条就多一份吃掉快捷键的风险', () => {
  assert.ok(BLACKLIST.length <= 6, `黑名单已有 ${BLACKLIST.length} 条，是不是加多了？`);
  assert.equal(OWNED.length, 1);
});

test('describe 渲染成人能读的形态', () => {
  assert.equal(describe({ key: 'w', control: true, shift: true, alt: false, meta: false }),
    'Ctrl+Shift+w');
  assert.equal(describe({ key: 'F5' }), 'F5');
});

// ── 诊断日志的噪声 ───────────────────────────────────────────────────────────
//
// 症状：按住 Ctrl，日志里就刷满「已放行：Ctrl+Control」（用户 2026-10-16 报的）。
// 做法：放行的键一个字都不报（见 `attachKeyGuard` 末段那段注释）。剩下那一半
//   ——"被我们吞掉的键"—— 要报，但不能因为它按住不放就报三十遍。

test('按住一个键不刷屏：自动重复与抬起都不进日志', () => {
  const down = { type: 'keyDown', key: 'F12', isAutoRepeat: false };
  assert.equal(worthReporting(down), true, '按一次还是要报的');
  assert.equal(worthReporting({ ...down, isAutoRepeat: true }), false,
    '按住不放不该写 30 行日志');
  assert.equal(worthReporting({ ...down, type: 'keyUp' }), false, '抬起不报');
});

test('端到端：放行的键一条都不报，吞掉的按住不放也只报一条', () => {
  const wc = fakeWc();
  const blocked = [];
  attachKeyGuard(wc, { onBlocked: (d) => blocked.push(d) });

  const press = (input) => {
    const event = { preventDefault: () => {} };
    for (const fn of wc.handlers['before-input-event']) {
      fn(event, { type: 'keyDown', isComposing: false, isAutoRepeat: false,
                  control: false, shift: false, alt: false, meta: false, key: '', ...input });
    }
  };

  press({ key: 'Control', control: true });                       // 按下
  for (let i = 0; i < 30; i += 1) {                              // 按住不放
    press({ key: 'Control', control: true, isAutoRepeat: true });
  }
  press({ key: 'w', control: true });                             // 真的组合键
  assert.deepEqual(blocked, [], '放行的键一条日志都不该有');

  press({ key: 'F12' });
  for (let i = 0; i < 30; i += 1) press({ key: 'F12', isAutoRepeat: true });
  assert.equal(blocked.length, 1, '吞掉一次报一条；按住不放还是那一条');
  assert.match(blocked[0], /F12/);
});
