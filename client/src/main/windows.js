'use strict';
/**
 * windows.js —— 会话窗口。
 *
 * ── 结构：BrowserWindow + 一个 WebContentsView ─────────────────────────────
 *
 *   ┌──────────────────────────────────────────┐
 *   │  BrowserWindow 自己的 webContents         │  ← 面板：状态条 + 设置/排队/重连/已结束
 *   │  ├── 顶部状态条（30px）                    │
 *   │  └── 下方留空，由 code-server 视图覆盖      │
 *   ├──────────────────────────────────────────┤
 *   │  WebContentsView（懒创建）                 │  ← code-server 页面
 *   └──────────────────────────────────────────┘
 *
 * 为什么不把状态条也做成独立的 WebContentsView（即 BaseWindow + 2 views）：
 * BrowserWindow 自己的 webContents **会自动清理**，BaseWindow 不会。少一个需要手动
 * close 的 webContents，就少一处泄漏面。何况状态条与面板本来就是同一个页面的两块 DOM，
 * 不需要在两个 renderer 之间走 IPC。
 *
 * ── 隧道未就绪时不需要「不污染 code-server 页面」的技巧 ─────────────────────
 * 因为那个页面**根本还没被创建**。未就绪期间窗口里只有面板自己。code-server 视图
 * 在拿到 tunnel_target 之后才懒创建 —— 提前建会白养一个 renderer 进程，还可能闪一下
 * about:blank。
 *
 * ── 清理必须写死 ───────────────────────────────────────────────────────────
 * `removeChildView()` **不销毁 webContents**，也不终止 renderer 进程；而
 * `WebContentsView` 至今**没有 destroy() 方法**（Electron issue #42884）。
 * 所以顺序必须是：removeChildView → webContents.close() → 引用置 null，
 * 且每一步都要 isDestroyed() 兜底。
 *
 * ── 绝不往 code-server 页面里注入 DOM ──────────────────────────────────────
 * `executeJavaScript` 塞 DOM 会在下一次 code-server 升级后碎掉，还会污染 VS Code
 * 的 webview 状态。遮罩是独立的 webContents，物理隔离 —— 这是唯一正确的做法。
 */

const path = require('path');
const { BrowserWindow, WebContentsView, dialog, shell } = require('electron');

const STATUS_BAR_HEIGHT = 30;

class ShellWindow {
  /**
   * @param {object} opts
   *   onClose   {(mode:'farewell'|'keep') => void}  用户在关闭弹窗里的选择
   *   onAction  {(action:string, payload) => void}  面板上的操作
   */
  constructor(opts = {}) {
    this.onClose = opts.onClose || (() => {});
    this.onAction = opts.onAction || (() => {});

    this.win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 640,
      minHeight: 420,
      show: false,
      backgroundColor: '#1e1e1e',
      // 不用 autoHideMenuBar：那会让 Alt 弹出菜单栏，而 Alt 是 VS Code 的菜单助记键
      autoHideMenuBar: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'api.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    if (process.platform !== 'darwin') {
      this.win.setMenuBarVisibility(false);
    }

    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));
    this.win.once('ready-to-show', () => this.win.show());

    this.codeView = null;
    this.overlayView = null;
    this._origin = null;
    this._closing = false;
    this._closeConfirmed = false;
    this._overlayText = null;

    this.win.on('resize', () => this._layout());
    this.win.on('closed', () => this._destroyViews());

    // 关窗 = 结束会话（默认），但给一个「保持作业运行」的出口。
    // 不做确认弹窗的话，误点 × 就会 scancel 掉一个跑了 12 小时的作业 ——
    // 那套 300s/1800s 的容错机制存在的唯一目的正是容忍这种意外。
    this.win.on('close', (e) => {
      if (this._closeConfirmed) return;
      e.preventDefault();
      this._confirmClose();
    });
  }

  // ── code-server 视图 ────────────────────────────────────────────────────
  /**
   * 显式加载 code-server 页面。
   * @param {string} origin  形如 http://127.0.0.1:18080（**字面 127.0.0.1**）
   * @param {string} partition 形如 'persist:slot-1'
   * @param {boolean} demo    true 时注入 demo.js preload 用于快捷键对照。
   *                          **真实模式绝不注入任何 preload** —— 那会污染 IDE。
   */
  async showCodeServer(origin, partition, demo = false) {
    this._origin = origin;
    if (!this.codeView) {
      this.codeView = new WebContentsView({
        webPreferences: {
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // IDE 是最不该被 Chromium 节流的页面：后台标签页限速会让终端和
          // 语言服务器看起来「卡住」，而且没有任何报错。
          backgroundThrottling: false,
          ...(demo ? { preload: path.join(__dirname, '..', 'preload', 'demo.js') } : {}),
        },
      });
      this.win.contentView.addChildView(this.codeView);
      // 监听器**只装一次**。origin 由 this._origin 提供，这样换端口时不需要
      // 重新装一遍 —— will-navigate / render-process-gone 是累加的，
      // 每次重建都装一遍会让同一件事被处理 N 次。
      this._wireCodeView(this.codeView.webContents);
      await this.codeView.webContents.loadURL(origin + '/');
    } else if (this.codeView.webContents.getURL().split('/').slice(0, 3).join('/') !== origin) {
      await this.codeView.webContents.loadURL(origin + '/');
    }
    this._layout();
  }

  _wireCodeView(wc) {
    // 锁死导航：点外链不能把整个 IDE 界面顶掉（而窗口里没有后退按钮）。
    // 用 this._origin 而不是捕获参数 —— 隧道换端口后 origin 会变。
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (this._origin && !url.startsWith(this._origin)) {
        e.preventDefault();
        if (/^https?:/.test(url)) shell.openExternal(url);
      }
    });
    // IDE 是最容易 OOM 的页面。挂了要能提示并重载，而不是留一块白。
    wc.on('render-process-gone', (_e, details) => {
      this.onAction('renderer-gone', { reason: details && details.reason });
    });
  }

  /** 取当前 code-server 页面用的 session（登录要在同一个分区里发请求）。 */
  get codeSession() {
    return this.codeView ? this.codeView.webContents.session : null;
  }

  hasCodeView() { return Boolean(this.codeView); }

  async reloadCodeServer() {
    if (this.codeView && !this.codeView.webContents.isDestroyed()) {
      this.codeView.webContents.reload();
    }
  }

  /**
   * 重新加载到新的 origin（隧道换了端口时用）。
   */
  async retarget(origin) {
    if (!this.codeView || this.codeView.webContents.isDestroyed()) return;
    // 只更新 this._origin —— 监听器已经装过了，不重复装（见 _wireCodeView 的注释）
    this._origin = origin;
    await this.codeView.webContents.loadURL(origin + '/');
  }

  // ── 遮罩（断线提示）────────────────────────────────────────────────────
  /**
   * 显示遮罩。**懒创建、跨事件复用** —— 每次断开都新建的话，反复断线会瞬间堆出
   * 几十个 renderer 进程。
   */
  async showOverlay(text) {
    this._overlayText = text;
    if (!this.overlayView) {
      this.overlayView = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
        },
      });
      this.win.contentView.addChildView(this.overlayView);
      await this.overlayView.webContents.loadFile(
        path.join(__dirname, '..', 'renderer', 'overlay.html'));
    }
    this.overlayView.setVisible(true);
    this._layout();
    this._sendOverlay(text);
  }

  hideOverlay() {
    this._overlayText = null;
    if (this.overlayView) this.overlayView.setVisible(false);
    // ★ 移除遮罩后必须把焦点还给 code-server 视图，否则用户打字没反应 ——
    //   又一个「看起来正常但就是不工作」的静默失败。
    if (this.codeView && !this.codeView.webContents.isDestroyed()) {
      this.codeView.webContents.focus();
    }
    this._layout();
  }

  _sendOverlay(text) {
    const wc = this.overlayView && this.overlayView.webContents;
    if (!wc || wc.isDestroyed()) return;
    const send = () => wc.send('overlay:text', text || '');
    if (wc.isLoading()) wc.once('did-finish-load', send);
    else send();
  }

  // ── 布局 ────────────────────────────────────────────────────────────────
  _layout() {
    if (this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize();
    const top = STATUS_BAR_HEIGHT;
    const body = Math.max(0, h - top);
    // 用 setBounds 而不是靠 CSS —— WebContentsView 是原生层，不参与页面布局
    if (this.codeView && !this.codeView.webContents.isDestroyed()) {
      this.codeView.setBounds({ x: 0, y: top, width: w, height: body });
    }
    if (this.overlayView && !this.overlayView.webContents.isDestroyed()) {
      this.overlayView.setBounds({ x: 0, y: top, width: w, height: body });
    }
  }

  // ── 面板通信 ────────────────────────────────────────────────────────────
  /** 把会话快照推给面板。快照是界面唯一的数据来源。 */
  pushState(snap) {
    const wc = this.win.webContents;
    if (wc.isDestroyed()) return;
    wc.send('session:state', snap);
    if (snap && snap.origin && this.codeView
        && this._origin && snap.origin !== this._origin) {
      this.retarget(snap.origin);
    }
  }

  /** 把被外壳吞掉的按键推给演示页（仅演示模式用，用于对照）。 */
  pushSwallowed(desc) {
    if (!this.codeView || this.codeView.webContents.isDestroyed()) return;
    this.codeView.webContents.send('demo:swallowed', desc);
  }

  pushNotice(kind, text) {
    const wc = this.win.webContents;
    if (!wc.isDestroyed()) wc.send('ui:notice', { kind, text });
  }

  setTitle(t) {
    if (!this.win.isDestroyed()) this.win.setTitle(t);
  }

  /** 任务栏进度条 —— 重连时转圈，不占内容区。 */
  setBusy(busy) {
    if (this.win.isDestroyed()) return;
    if (busy) this.win.setProgressBar(2);
    else this.win.setProgressBar(-1);
  }

  // ── 关闭 ────────────────────────────────────────────────────────────────
  async _confirmClose() {
    if (this._closing) return;
    this._closing = true;
    try {
      const { response } = await dialog.showMessageBox(this.win, {
        type: 'question',
        buttons: ['结束会话并释放资源', '仅关闭窗口，保持作业运行', '取消'],
        defaultId: 0,
        cancelId: 2,
        title: '关闭 Slurmate',
        message: '关闭窗口时要结束这个开发会话吗？',
        detail:
          '结束会话会立即取消计算节点上的作业（终端里的进程会被终止）。\n'
        + '保持运行则不动作业 —— 下次启动 Slurmate 会自动重新接上。',
        noLink: true,
      });
      if (response === 2) return;                       // 取消
      this._closeConfirmed = true;
      this.onClose(response === 0 ? 'farewell' : 'keep');
    } finally {
      this._closing = false;
    }
  }

  /** 供外部（退出流程）强制关闭，不再弹窗。 */
  forceClose() {
    this._closeConfirmed = true;
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  close() {
    if (!this.win.isDestroyed()) this.win.close();
  }

  _destroyViews() {
    for (const key of ['codeView', 'overlayView']) {
      const v = this[key];
      if (!v) continue;
      try { this.win.contentView.removeChildView(v); } catch { /* 窗口可能已销毁 */ }
      try {
        if (v.webContents && !v.webContents.isDestroyed()) v.webContents.close();
      } catch { /* 同上 */ }
      this[key] = null;
    }
  }
}

module.exports = { ShellWindow, STATUS_BAR_HEIGHT };
