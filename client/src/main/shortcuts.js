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
 * shortcuts.js —— 菜单与按键拦截。
 *
 * ── 这一节推翻了一个很自然但错误的设想 ────────────────────────────────────
 *
 * 直觉方案是「用 before-input-event 拦下 Ctrl+W，再转发给 web-demo」。
 * 这在 API 语义上做不到。Electron 文档原文：调用 `event.preventDefault()`
 * 会阻止页面的 keydown/keyup 和菜单加速键 —— 两者一起掐，不存在「只拦浏览器
 * 默认行为、把按键继续交给页面」这回事。
 *
 * 而好消息是：根本不需要拦。Ctrl+W / Ctrl+R / F5 在 Electron 里没有默认行为，
 * 它们全部挂在菜单项的 role 上。Electron 不是 Chrome，没有标签页，所以
 * 「浏览器抢走 Ctrl+W 关掉页面」这个痛点在 Electron 里自动消失。
 *
 * 所以 `before-input-event` 的职责只剩一件：吞掉我们永远不想要的键。
 * 默认方向是放行，黑名单尽量短 —— 每加一条就多一份吃掉输入法/吃掉快捷键的风险。
 *
 * ── 菜单为什么不能一律置 null ──────────────────────────────────────────────
 *
 * `Menu.setApplicationMenu(null)` 在 Windows/Linux 上是对的（去掉全部加速键，
 * 键盘完全交给页面）。但在 macOS 上会让 Cmd+C/V/Q 直接失效 —— 那些功能硬依赖
 * 菜单 role。所以 macOS 走一条最小菜单。
 *
 * ── 输入法 ─────────────────────────────────────────────────────────────────
 *
 * 拦截器的第一行必须是 `if (input.isComposing) return;`。否则拼音输入过程中
 * 的按键会被吞掉，中文输入法直接废掉 —— 这是这类拦截器最经典的事故。
 */

const { Menu } = require('electron');

/**
 * 黑名单：这些键永远不给页面、也不给菜单。
 *
 * 刻意不含缩放键（Ctrl+= / Ctrl+- / Ctrl+0）：它们没有菜单 role 就没有默认行为，
 * 而 VS Code 自己绑了它们（编辑器缩放）。多拦一条就会把编辑器的缩放抢走。
 *
 * 同理不含 Ctrl+P（VS Code 的快速打开）、Ctrl+W（关闭编辑器）、Ctrl+R / F5。
 */
const BLACKLIST = [
  { key: 'F12',                 desc: '开发者工具' },
  { key: 'I', ctrl: true, shift: true, desc: '开发者工具' },
  { key: 'J', ctrl: true, shift: true, desc: '开发者工具' },
  { key: 'C', ctrl: true, shift: true, desc: '开发者工具（审查元素）' },
  { key: 'F11',                 desc: '全屏' },
];

/** 我们自己处理、并且要从页面手里拿走的键。 */
const OWNED = [
  { key: 'R', ctrl: true, shift: true, action: 'reload', desc: '重新加载' },
];

function normalizeKey(input) {
  // 用 input.key（受修饰键影响，比如 Shift+W 是 'W'）。大小写不敏感比较，
  // 但要用 input.shift 判断用户是否真按了 Shift。
  const k = input.key || '';
  return k.length === 1 ? k.toUpperCase() : k;
}

/**
 * 这次按键值不值得进诊断日志。
 *
 * 一是 `isAutoRepeat`：按住不放的重复事件不该重复上报（同一条信息说 N 遍和说一遍
 *   是同一个信息量，只是淹掉了别的东西）。今天进日志的只剩"被我们吞掉的键"，
 *   而按住不放的吞掉与吞掉一次也是同一件事。
 * 二是 `type`：两个调用点都在 `keyDown` 那一支里，这里是第二道 —— 它不是多余的，
 *   它是这条规则本身的说法（"按键"说的是按下那一刻，不是抬起那一刻）。
 */
function worthReporting(input) {
  return input.type === 'keyDown' && !input.isAutoRepeat;
}

function match(table, input) {
  const key = normalizeKey(input);
  for (const e of table) {
    if (e.key !== key) continue;
    if (Boolean(e.ctrl) !== Boolean(input.control)) continue;
    if (Boolean(e.shift) !== Boolean(input.shift)) continue;
    if (Boolean(e.alt) !== Boolean(input.alt)) continue;
    if (Boolean(e.meta) !== Boolean(input.meta)) continue;
    return e;
  }
  return null;
}

/** 把一次按键渲染成人看的描述，用于诊断面板。 */
function describe(input) {
  const parts = [];
  if (input.control) parts.push('Ctrl');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  if (input.meta) parts.push('Meta');
  parts.push(input.key);
  return parts.join('+');
}

/**
 * 装菜单。必须在 app ready 之后、创建窗口之前调用。
 */
function installMenu() {
  if (process.platform === 'darwin') {
    // macOS：最小菜单。Cmd+Q / Cmd+C/V 硬依赖菜单 role，无法隐藏。
    // 但刻意不放 undo/redo —— Monaco 有自己的撤销栈，菜单 role 会双重触发。
    // 复制粘贴就算偶尔重复触发也无害，撤销重复触发是会毁掉用户工作的。
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'Edit',
        submenu: [
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
    ]));
  } else {
    // Windows / Linux：菜单整个去掉 —— 那是 Ctrl+W / Ctrl+R / F5 默认行为的唯一来源。
    // 不用 autoHideMenuBar:true（那会让 Alt 弹出菜单栏，而 Alt 是 VS Code 的菜单助记键）。
    Menu.setApplicationMenu(null);
  }
}

/**
 * 给一个 webContents 装上按键拦截 + 诊断。
 *
 * @param {Electron.WebContents} wc
 * @param {object} opts
 *   onOwned  {(action:string) => void}  用户按了我们自己的键（比如 Ctrl+Shift+R）
 *   onBlocked{(desc:string) => void}    我们吞掉了一个键（诊断面板用）
 * @returns {() => void} 卸载函数
 */
function attachKeyGuard(wc, opts = {}) {
  const handler = (event, input) => {
    // 第一行。输入法组合期间必须放行，否则中文输入法会被吃掉。
    if (input.isComposing) return;

    // 我们自己要处理的键：拦下并执行动作
    const owned = match(OWNED, input);
    if (owned && input.type === 'keyDown') {
      event.preventDefault();
      if (worthReporting(input)) opts.onBlocked?.(describe(input) + `（${owned.desc}）`);
      opts.onOwned?.(owned.action);
      return;
    }

    // 永远不想要的键：吞掉
    const blocked = match(BLACKLIST, input);
    if (blocked) {
      event.preventDefault();
      if (worthReporting(input)) opts.onBlocked?.(describe(input) + `（${blocked.desc}）`);
      return;
    }

    // 其余一律放行 —— 包括 Ctrl+W / Ctrl+N / Ctrl+T / F5 / Ctrl+P。
    // 它们没有菜单加速键，会直达页面由 web-demo 处理。
    //
    // 放行的键不上报。从前测试后端下每按一次带修饰键的键都往日志里写一行
    //   （「已放行：Ctrl+w」），用来核对"按键到底有没有到页面"—— 那件事已经核完了，
    //   而它今天的代价是把真正要紧的消息顶掉（用户 2026-10-16 报的那一条）。
    //   被我们吞掉的键照旧报：那是在解释"按了为什么没反应"，是用户自己问的问题。
  };

  wc.on('before-input-event', handler);
  return () => wc.removeListener('before-input-event', handler);
}

module.exports = {
  BLACKLIST, OWNED, installMenu, attachKeyGuard, describe,
  worthReporting,   // 导出给测试：它是纯函数，规则值得钉住
};
