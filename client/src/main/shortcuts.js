'use strict';
/**
 * shortcuts.js —— 菜单与按键拦截。
 *
 * ── 这一节推翻了一个很自然但错误的设想 ────────────────────────────────────
 *
 * 直觉方案是「用 before-input-event 拦下 Ctrl+W，再转发给 code-server」。
 * **这在 API 语义上做不到。** Electron 文档原文：调用 `event.preventDefault()`
 * 会阻止页面的 keydown/keyup **和**菜单加速键 —— 两者一起掐，不存在「只拦浏览器
 * 默认行为、把按键继续交给页面」这回事。
 *
 * 而好消息是：**根本不需要拦。** Ctrl+W / Ctrl+R / F5 在 Electron 里没有默认行为，
 * 它们全部挂在菜单项的 role 上。Electron 不是 Chrome，没有标签页，所以
 * 「浏览器抢走 Ctrl+W 关掉页面」这个痛点**在 Electron 里自动消失**。
 *
 * 所以 `before-input-event` 的职责只剩一件：**吞掉我们永远不想要的键**。
 * 默认方向是放行，黑名单尽量短 —— 每加一条就多一份吃掉输入法/吃掉快捷键的风险。
 *
 * ── 菜单为什么不能一律置 null ──────────────────────────────────────────────
 *
 * `Menu.setApplicationMenu(null)` 在 Windows/Linux 上是对的（去掉全部加速键，
 * 键盘完全交给页面）。但在 **macOS 上会让 Cmd+C/V/Q 直接失效** —— 那些功能硬依赖
 * 菜单 role。所以 macOS 走一条最小菜单。
 *
 * ── 输入法 ─────────────────────────────────────────────────────────────────
 *
 * 拦截器的第一行**必须**是 `if (input.isComposing) return;`。否则拼音输入过程中
 * 的按键会被吞掉，中文输入法直接废掉 —— 这是这类拦截器最经典的事故。
 */

const { Menu } = require('electron');

/**
 * 黑名单：这些键永远不给页面、也不给菜单。
 *
 * 刻意**不含**缩放键（Ctrl+= / Ctrl+- / Ctrl+0）：它们没有菜单 role 就没有默认行为，
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
  { key: 'R', ctrl: true, shift: true, action: 'reload', desc: '重新加载页面' },
];

function normalizeKey(input) {
  // 用 input.key（受修饰键影响，比如 Shift+W 是 'W'）。大小写不敏感比较，
  // 但要用 input.shift 判断用户是否真按了 Shift。
  const k = input.key || '';
  return k.length === 1 ? k.toUpperCase() : k;
}

/**
 * 光秃秃的修饰键本身（Ctrl / Shift / Alt / Meta）。
 *
 * ★ 这个判断存在，是因为按住 Ctrl 会**连续**产生 keyDown（操作系统的自动重复），
 *   每一次的 `input.key` 都是 'Control' —— 于是诊断日志里刷满
 *   「已放行：Ctrl+Control」。用户按住 Ctrl 是为了配一个组合键，不是为了看这个。
 *   修饰键单独按下**不携带任何信息**：它既没有被吞掉的可能，也不是一个动作。
 */
const BARE_MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']);

function isBareModifier(input) {
  return BARE_MODIFIERS.has(input.key);
}

/**
 * 这次按键值不值得进诊断日志。
 *
 * 第二条是 `isAutoRepeat` —— 按住不放的重复事件不该重复上报（同一条信息说 N 遍
 * 和说一遍是同一个信息量，只是淹掉了别的东西）。
 */
function worthReporting(input) {
  return input.type === 'keyDown' && !input.isAutoRepeat && !isBareModifier(input);
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
    // 但**刻意不放 undo/redo** —— Monaco 有自己的撤销栈，菜单 role 会双重触发。
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
 *   onSeen   {(desc:string) => void}    我们看到的所有带修饰键/F 键（诊断面板用）
 * @returns {() => void} 卸载函数
 */
function attachKeyGuard(wc, opts = {}) {
  const handler = (event, input) => {
    // ★ 第一行。输入法组合期间必须放行，否则中文输入法会被吃掉。
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
    // 它们没有菜单加速键，会直达页面由 code-server 处理。
    if (worthReporting(input) && opts.onSeen) {
      // 只报「用户可能关心是否被吞」的那一类，避免刷屏
      if (input.control || input.alt || input.meta || /^F\d+$/.test(input.key)) {
        opts.onSeen(describe(input));
      }
    }
  };

  wc.on('before-input-event', handler);
  return () => wc.removeListener('before-input-event', handler);
}

module.exports = {
  BLACKLIST, OWNED, installMenu, attachKeyGuard, describe,
  isBareModifier, worthReporting,   // 导出给测试：它们是纯函数，规则值得钉住
};
