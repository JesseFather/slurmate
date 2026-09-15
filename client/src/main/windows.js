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
const { SERVICE_SSHD } = require('./service.js');

const STATUS_BAR_HEIGHT = 30;

class ShellWindow {
  /**
   * @param {object} opts
   *   onClose   {() => void}  用户确认关闭窗口（已含确认弹窗）
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
    this._partition = null;        // 见 codePartition getter
    this._destroyingCodeView = false;   // 见 _destroyCodeView / render-process-gone
    this._closing = false;
    this._closeConfirmed = false;
    this._sessionLive = false;     // 由 pushState 更新
    this._sessionService = null;   // 同上（'code-server' / 'sshd' / 'unknown' / null）
    this._overlayText = null;

    this.win.on('resize', () => this._layout());
    this.win.on('closed', () => this._destroyViews());

    // 关窗 = 结束会话并释放资源（见 _confirmClose）。确认弹窗只为拦误点 ×，
    // 不是给用户第二条路 —— 保住作业靠的是「客户端没能说上话」时守护进程的
    // 300s/1800s 容错窗口，而不是一个主动的开关。
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
   * @param {string} partition 形如 'persist:layout-<布局组 id>'
   * @param {boolean} demo    true 时注入 demo.js preload 用于快捷键对照。
   *                          **真实模式绝不注入任何 preload** —— 那会污染 IDE。
   */
  async showCodeServer(origin, partition, demo = false) {
    // ★ WebContentsView 的 partition **只在构造时读一次**（就是下面那个 new）。
    //   所以「换布局组」= 换 partition，必须**销毁重建** —— 只 loadURL 是没用的，
    //   页面会继续跑在旧的存储分区里（旧的布局、旧的登录 cookie），
    //   而界面上完全看不出区别。
    if (this.codeView && this._partition !== partition) this._destroyCodeView();

    this._origin = origin;
    this._partition = partition;
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
      // 「只装一次」是针对**同一个 webContents 对象**说的：origin 由 this._origin
      // 提供，所以隧道换端口（origin 变）不需要重装。但上面换 partition 时是**新对象**，
      // 必须重新装一遍 —— 否则新视图的 will-navigate 不设防、崩溃也不报错。
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
      // ★ 我们自己拆视图（换布局组）也会走到这里。不区分的话，用户每切一次布局
      //   就会看到一条「code-server 页面崩溃了」的**假警报** —— 系统报告了一件
      //   没发生的事，正是这个项目一路在清的那类。
      if (this._destroyingCodeView) return;
      this.onAction('renderer-gone', { reason: details && details.reason });
    });
  }

  /**
   * 销毁 code-server 视图。**换布局组时必须走这条** —— partition 是构造期属性，
   * 不重建就换不了存储分区。
   *
   * 顺序照文件头那条写死：removeChildView → webContents.close() → 引用置 null，
   * 每一步 isDestroyed() 兜底。`removeChildView()` 自己不销毁 webContents。
   */
  _destroyCodeView() {
    const v = this.codeView;
    if (!v) return;
    // 立旗子：这是我们自己要拆的，不是页面崩了（见 _wireCodeView）
    this._destroyingCodeView = true;
    try { this.win.contentView.removeChildView(v); } catch { /* 窗口可能已销毁 */ }
    try {
      if (v.webContents && !v.webContents.isDestroyed()) v.webContents.close();
    } catch { /* 同上 */ }
    this.codeView = null;
    this._partition = null;
    this._destroyingCodeView = false;
  }

  /** 取当前 code-server 页面用的 session（登录要在同一个分区里发请求）。 */
  get codeSession() {
    return this.codeView ? this.codeView.webContents.session : null;
  }

  /**
   * 当前 code-server 页面跑在哪个存储分区里。
   *
   * 回收一个布局组时要清它的浏览器存储 —— 而那**绝不能**发生在正被这个视图用着的
   * 那个分区上，否则用户当前的 IDE 会连 cookie 带 localStorage 一起被抽掉，
   * 症状只是「页面莫名其妙坏了」。
   */
  get codePartition() {
    return this._partition;
  }

  /** 当前 code-server 页面加载的 origin（隧道换端口后它会变）。 */
  get codeOrigin() {
    return this._origin;
  }

  hasCodeView() { return Boolean(this.codeView); }

  /**
   * 收起 code-server 视图，把窗口主体还给面板。
   *
   * ★ 两处必须调用，缺一个都会留下同一类症状：**用户看着一个打不开的页面，
   *   而唯一能救他的按钮被那块页面盖住了**（codeView 是原生层，覆在面板上方，
   *   面板那 30px 状态条以下的部分全在它底下）。
   *
   *   1. 会话结束时（ended / error）。那个页面背后的服务器已经没了 —— 隧道停了、
   *      作业也快没了 —— 留着它只有坏处。此前**没有任何地方**调用这个收尾，
   *      于是「结束会话」之后用户看到的是一张加载不出来的网页，出路只剩重启客户端。
   *   2. 起中转站会话时。中转站压根不用这个视图（它什么都不显示，只在面板上
   *      告诉你 ssh 怎么连），上一个会话留下的视图必须让开。
   *
   * 是**销毁**而不是 setVisible(false)：唤醒一个已经死掉的页面没有意义，而且
   * ensureCodeServer 是按 (origin, partition) 判定要不要重建的，一个被藏起来的
   * 旧页面会正好命中「没变」而永远不再加载。销毁之后下次一定是干净的新页面。
   */
  hideCodeView() {
    if (!this.codeView) return;
    this._destroyCodeView();
    this.hideOverlay();
    this._layout();
  }

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
    // 关窗确认要用：有会话在跑才值得拦一下误点。快照本来就每次状态变化都推过来，
    // 顺手记下即可，不必再开一条查询通道。
    const st = snap && snap.state;
    this._sessionLive = Boolean(st) && st !== 'idle' && st !== 'ended';
    // 关窗文案要用：中转站模式下被掐断的不是一个网页，是用户**正在用的终端**。
    this._sessionService = (snap && snap.serviceKind) || null;
    const wc = this.win.webContents;
    if (wc.isDestroyed()) return;
    wc.send('session:state', snap);
    // ★ 这里曾经有一条「origin 变了就 loadURL」的自动 retarget。删掉了：
    //   它是第二条改 origin 的通路，而且只会 loadURL —— **不换 partition、
    //   也不重跑登录**。换布局组要的恰恰是前者，于是两条路必然分叉。
    //   现在统一由 index.js 的 ensureCodeServer 判定（它同时看 origin 和 partition）。
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
  /**
   * 关窗前的确认。
   *
   * ★ 只在**真的有会话在跑**时才问。没有会话时关闭是无害的，弹一个「要结束吗？」
   *   只会训练用户闭着眼睛回车，等到某次真的有作业在跑时，那一下回车就是 12 小时。
   *
   * 也没有「保持作业运行」这个选项 —— 关闭就是结束（见 session.js 的 stop()）。
   * 保留确认这一步不是为了让用户选择要不要结束，而是为了让**误点 × **
   * 不至于直接毁掉一个正在跑的作业。
   */
  async _confirmClose() {
    if (this._closing) return;
    this._closing = true;
    try {
      if (!this._sessionLive) {           // 没有会话语义上的损失，不必打扰
        this._closeConfirmed = true;
        this.onClose();
        return;
      }
      // 中转站模式下要掐断的东西不一样，所以话也得不一样：那边窗口里什么都没有，
      // 用户真正在用的东西在他的终端里、在 codex 里。照搬 code-server 那句
      // 「终端里的进程会被终止」，指的不是他手上那个终端 —— 而这一下点错，
      // 断掉的是他正在跑的编译或对话。
      const relay = this._sessionService === SERVICE_SSHD;
      const { response } = await dialog.showMessageBox(this.win, {
        type: 'question',
        buttons: ['结束会话并退出', '取消'],
        defaultId: 1,                     // 默认停在「取消」：回车不该毁掉作业
        cancelId: 1,
        title: '关闭 Slurmate',
        message: relay ? '关闭窗口会结束这个 SSH 中转会话。'
                       : '关闭窗口会结束这个开发会话。',
        detail: (relay
          ? '计算节点上的作业会被立即取消 —— 你用 ssh slurmate 连上去的终端、'
          + 'VS Code 远程窗口和 codex 会话都会当场断开。\n'
          : '计算节点上的作业会被立即取消，终端里的进程会被终止。\n')
        + '（若只是想暂时离开，直接放着窗口不管就行 —— 合盖或断网不会结束作业，'
        + '下次打开会自动接上。）',
        noLink: true,
      });
      if (response === 1) return;                       // 取消
      this._closeConfirmed = true;
      this.onClose();
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
    // codeView 走它自己那条（还要清 _partition、立 _destroyingCodeView 旗子）
    this._destroyCodeView();
    // overlayView 与 partition 无关，照旧走通用清理
    const v = this.overlayView;
    if (!v) return;
    try { this.win.contentView.removeChildView(v); } catch { /* 窗口可能已销毁 */ }
    try {
      if (v.webContents && !v.webContents.isDestroyed()) v.webContents.close();
    } catch { /* 同上 */ }
    this.overlayView = null;
  }
}

module.exports = { ShellWindow, STATUS_BAR_HEIGHT };
