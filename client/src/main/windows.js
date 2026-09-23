'use strict';
/**
 * windows.js —— 会话窗口。
 *
 * ── 结构：BrowserWindow + 一个 WebContentsView ─────────────────────────────
 *
 *   ┌──────────────────────────────────────────┐
 *   │  BrowserWindow 自己的 webContents         │  ← 面板：状态条 + 设置/排队/重连/已结束
 *   │  ├── 顶部状态条（30px）                    │
 *   │  └── 下方留空，由**界面**覆盖               │
 *   ├──────────────────────────────────────────┤
 *   │  WebContentsView（懒创建）                 │  ← 插件声明的那块界面
 *   └──────────────────────────────────────────┘
 *
 * 为什么不把状态条也做成独立的 WebContentsView（即 BaseWindow + 2 views）：
 * BrowserWindow 自己的 webContents **会自动清理**，BaseWindow 不会。少一个需要手动
 * close 的 webContents，就少一处泄漏面。何况状态条与面板本来就是同一个页面的两块 DOM，
 * 不需要在两个 renderer 之间走 IPC。
 *
 * ── ★ 这个文件里没有 IDE，也没有任何插件名 ─────────────────────────────────
 *
 * 它只知道一件事：**有一块原生视图盖在面板上，它加载某个 URL，它属于某个存储分区**。
 * URL 后面是 VS Code、是 Jupyter、还是别的什么，这里一概不知道 —— 那是插件在
 * `plugin.json` 的 `contributes.surface` 里声明的，由 index.js 读出来之后调
 * `showSurface({url, partition})`。
 *
 * 这条边界不是洁癖：它让"换一个插件"不需要动这个文件一个字，也让一个**没有客户端
 * 代码**的声明式插件照样能开界面（开界面本来就不需要代码，只需要一句声明）。
 *
 * ── 隧道未就绪时不需要「不污染界面」的技巧 ─────────────────────────────────
 * 因为那块视图**根本还没被创建**。未就绪期间窗口里只有面板自己。视图在拿到
 * tunnel_target 之后才懒创建 —— 提前建会白养一个 renderer 进程，还可能闪一下
 * about:blank。
 *
 * ── 清理必须写死 ───────────────────────────────────────────────────────────
 * `removeChildView()` **不销毁 webContents**，也不终止 renderer 进程；而
 * `WebContentsView` 至今**没有 destroy() 方法**（Electron issue #42884）。
 * 所以顺序必须是：removeChildView → webContents.close() → 引用置 null，
 * 且每一步都要 isDestroyed() 兜底。
 *
 * ── 绝不往视图里注入 DOM ───────────────────────────────────────────────────
 * `executeJavaScript` 塞 DOM 会在那款软件下一次升级后碎掉，还会污染它自己的
 * webview 状态。遮罩是独立的 webContents，物理隔离 —— 这是唯一正确的做法。
 */

const path = require('path');
const { BrowserWindow, WebContentsView, dialog, shell } = require('electron');

const STATUS_BAR_HEIGHT = 30;

/**
 * 从一个 URL 里取出 origin（`http://127.0.0.1:18080`）。取不出来返回 null。
 *
 * 只用于那条"点外链不能把界面顶掉"的导航锁 —— 判据是"这个新 URL 还在不在同一个
 * 隧道端口上"。隧道换端口时这个值会跟着变，所以它每次都由 `showSurface` 重算，
 * 而不是插件给的常量。
 */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * 没有插件信息时关窗确认的文案。
 *
 * 这不是"兜底文案"，而是**未知服务**那个情形的正确文案：我们不知道那个会话是
 * 什么，就不该替它说"你的终端会断"或者"你的编辑器会丢改动"—— 两句都可能是假的。
 * 说得出确定的那一部分（作业会被取消）就够了。
 */
const NEUTRAL_CLOSE_WARNING = {
  message: '关闭窗口会结束这个会话。',
  detail: '计算节点上的作业会被立即取消。\n',
};

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

    /**
     * 窗口里现在有几块界面：**槽 → { view, origin, partition }**。
     *
     * ★ 这里从前是**一个** `surfaceView`。单值能成立，靠的是"同一时刻只有一个会话"
     *   这条假设，而它的失败形态很具体：起中转站时那条「这个插件不要界面」的分支
     *   会把 code-server 那块正跑着的页面一起销毁，用户看到的是"我的编辑器忽然
     *   没了"，日志里一个字都没有。
     */
    this.surfaces = new Map();
    /**
     * 哪一块**盖在面板上面**。
     *
     * ★ 原生视图只有一块地方，所以窗口这一层**必须**有这个"前台"的概念。它**不是**
     *   "当前会话"（那个概念被这次改动删掉了）—— 它只回答"屏幕上看得见哪一块"。
     *   由 `pushSessions` 从 `index.js` 的 `frontSlot()` 带过来：**决定权只有一处**。
     */
    this._front = null;
    this.overlayView = null;
    // 正被我们自己拆掉的那些视图（见 _destroySurface / render-process-gone）。
    // 用 Set 而不是一个布尔：多块视图时，甲块在被拆不该让乙块的崩溃报告被吞掉。
    this._destroying = new Set();
    this._closing = false;
    this._closeConfirmed = false;
    // 窗口这一层只需要两件事：活着的会话**有几个**、各自的 `closeWarning`。
    // 由 setSessions 设。**窗口不认识任何插件**（见 _confirmClose）。
    this._sessions = [];
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

  // ── 界面（插件声明的那块原生视图）───────────────────────────────────────
  /**
   * 把插件声明的那块界面显示出来。
   *
   * @param {string} slot      这是**哪一条会话**的界面（见 plugin-data.js 的 slotOf）
   * @param {string} url       完整 URL，形如 http://127.0.0.1:18080/lab
   *                           （主机部分**字面 127.0.0.1**，隧道在这一头）
   * @param {string} partition 形如 'persist:<插件 id>@<共享组>[@<实例>]'
   *                           （结构见 plugin-data.js 的文件头）
   * @param {boolean} demo     true 时注入 demo.js preload 用于快捷键对照。
   *                           **真实模式绝不注入任何 preload** —— 那会污染那款软件。
   *
   * ★ 这里**只看 slot、url 和 partition**，不看是谁。`origin` 这个字眼在本文件里
   *   已经没有意义：URL 的路径部分由插件声明（`contributes.surface.path`），所以
   *   "同一个隧道端口、不同路径"也是合法的。
   */
  async showSurface({ slot, url, partition, demo = false }) {
    // ★ WebContentsView 的 partition **只在构造时读一次**（就是下面那个 new）。
    //   所以「换布局组」= 换 partition，必须**销毁重建** —— 只 loadURL 是没用的，
    //   页面会继续跑在旧的存储分区里（旧的布局、旧的登录 cookie），
    //   而界面上完全看不出区别。
    //   ★ 判据是**这一个槽**自己的分区，不是"窗口里那块"的 —— 见 index.js 的
    //     `ensureSurface`。
    let s = this.surfaces.get(slot);
    if (s && s.partition !== partition) { this._destroySurface(slot); s = null; }

    if (!s) {
      const view = new WebContentsView({
        webPreferences: {
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // 这类页面是最不该被 Chromium 节流的：后台标签页限速会让终端和
          // 语言服务器看起来「卡住」，而且没有任何报错。
          // ★ 多开之后它更要紧：**后台那个标签页里的终端还在跑**，限速它等于
          //   让用户切回去时发现命令停了半天。
          backgroundThrottling: false,
          ...(demo ? { preload: path.join(__dirname, '..', 'preload', 'demo.js') } : {}),
        },
      });
      s = { view, origin: originOf(url), partition };
      this.surfaces.set(slot, s);
      this.win.contentView.addChildView(view);
      // 「只装一次」是针对**同一个 webContents 对象**说的：origin 由 `s.origin`
      // 提供，所以隧道换端口（origin 变）不需要重装。但上面换 partition 时是**新对象**，
      // 必须重新装一遍 —— 否则新视图的 will-navigate 不设防、崩溃也不报错。
      this._wireSurface(view.webContents, slot);
      await view.webContents.loadURL(url);
    } else {
      // 隧道换端口：origin 变了，但**不重装监听器**（它们读的是 s.origin）。
      s.origin = originOf(url);
      if (s.view.webContents.getURL() !== url) await s.view.webContents.loadURL(url);
    }
    this._layout();
  }

  _wireSurface(wc, slot) {
    // 锁死导航：点外链不能把整个界面顶掉（而窗口里没有后退按钮）。
    // 用 `s.origin` 现取而不是捕获参数 —— 隧道换端口后 origin 会变。
    const originOfSlot = () => {
      const s = this.surfaces.get(slot);
      return s ? s.origin : null;
    };
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      const o = originOfSlot();
      if (o && !url.startsWith(o)) {
        e.preventDefault();
        if (/^https?:/.test(url)) shell.openExternal(url);
      }
    });
    // 这类页面最容易 OOM。挂了要能提示并重载，而不是留一块白。
    wc.on('render-process-gone', (_e, details) => {
      // ★ 我们自己拆视图（换布局组）也会走到这里。不区分的话，用户每切一次布局
      //   就会看到一条「页面崩溃了」的**假警报** —— 系统报告了一件没发生的事，
      //   正是这个项目一路在清的那类。
      if (this._destroying.has(slot)) return;
      this.onAction('renderer-gone', { slot, reason: details && details.reason });
    });
  }

  /**
   * 销毁**某一个槽**的视图。**换布局组时必须走这条** —— partition 是构造期属性，
   * 不重建就换不了存储分区。
   *
   * 顺序照文件头那条写死：removeChildView → webContents.close() → 引用置 null，
   * 每一步 isDestroyed() 兜底。`removeChildView()` 自己不销毁 webContents。
   *
   * ★★ **名字里必须带"销毁"两个字。** 从前它叫 `hideSurface()`，而多开之后那个
   *    名字会同时表示两件事（"这个会话结束了，拆掉"与"用户切了标签，藏起来"），
   *    而这两件事的差别是**页面会不会被重置**：藏起来的那一块必须原样留着，
   *    否则用户切一次标签，另一个会话的编辑器就重新加载一次、自动登录再跑一遍。
   *    隐藏是 `setFront` + `_layout` 的事，**不在这条路上**。
   */
  _destroySurface(slot) {
    const s = this.surfaces.get(slot);
    if (!s) return;
    const v = s.view;
    // 立旗子：这是我们自己要拆的，不是页面崩了（见 _wireSurface）
    this._destroying.add(slot);
    try { this.win.contentView.removeChildView(v); } catch { /* 窗口可能已销毁 */ }
    try {
      if (v.webContents && !v.webContents.isDestroyed()) v.webContents.close();
    } catch { /* 同上 */ }
    this.surfaces.delete(slot);
    this._destroying.delete(slot);
    if (this._front === slot) this._front = null;
  }

  /** 收起**某一个槽**的界面（销毁那一块）。会话结束时走这条。 */
  destroySurface(slot) {
    if (!this.surfaces.has(slot)) return;
    this._destroySurface(slot);
    this.hideOverlay();
    this._layout();
  }

  /**
   * 把**某一个槽**那块抬到面板上面。其余各块 `setVisible(false)` —— **不销毁**：
   * 它们背后是还活着的服务器，藏起来只是不占屏幕。
   *
   * ★ 这是切标签走的那条路，与 `destroySurface` **不是一回事**（见那里的注释）。
   */
  setFront(slot) {
    this._front = slot || null;
    this._layout();
  }

  get front() { return this._front; }

  /** 取**某一个槽**那块界面用的 session（要在同一个分区里发请求才带得上它的 cookie）。 */
  surfaceSession(slot) {
    const s = this.surfaces.get(slot);
    return s ? s.view.webContents.session : null;
  }

  /**
   * **某一个槽**那块界面跑在哪个存储分区里。没有那一块时返回 null。
   *
   * 回收一个布局组时要清它的浏览器存储 —— 而那**绝不能**发生在正被**任何一块**
   * 视图用着的那个分区上，否则那块界面会连 cookie 带 localStorage 一起被抽掉，
   * 症状只是「页面莫名其妙坏了」。
   */
  surfacePartition(slot) {
    const s = this.surfaces.get(slot);
    return s ? s.partition : null;
  }

  /** **某一个槽**那块界面加载的 origin（隧道换端口后它会变）。 */
  surfaceOrigin(slot) {
    const s = this.surfaces.get(slot);
    return s ? s.origin : null;
  }

  hasSurface(slot) { return this.surfaces.has(slot); }

  /**
   * 收起界面，把窗口主体还给面板。
   *
   * ★ 两处必须调用，缺一个都会留下同一类症状：**用户看着一个打不开的页面，
   *   而唯一能救他的按钮被那块页面盖住了**（surfaceView 是原生层，覆在面板上方，
   *   面板那 30px 状态条以下的部分全在它底下）。
   *
   *   1. 会话结束时（ended / error）。那个页面背后的服务器已经没了 —— 隧道停了、
   *      作业也快没了 —— 留着它只有坏处。此前**没有任何地方**调用这个收尾，
   *      于是「结束会话」之后用户看到的是一张加载不出来的网页，出路只剩重启客户端。
   *   2. 起一个**不声明 surface** 的会话时（比如中转站）。**它自己那一块**（本来
   *      就没有）让开即可 —— ★ 而从前这里是"把窗口里那一块收掉"，多开之后那是
   *      一次**越权**：它会把 code-server 那块正跑着的页面一起销毁。
   *
   * 是**销毁**而不是 setVisible(false)：唤醒一个已经死掉的页面没有意义，而且
   * ensureSurface 是按 (url, partition) 判定要不要重建的，一个被藏起来的
   * 旧页面会正好命中「没变」而永远不再加载。销毁之后下次一定是干净的新页面。
   *
   * ★ **切标签不走这条**，走 `setFront` —— 那里藏起来的那一块背后还活着。
   */
  async reloadSurface(slot) {
    const s = this.surfaces.get(slot);
    if (s && !s.view.webContents.isDestroyed()) s.view.webContents.reload();
  }

  /**
   * 重新加载到新的 URL（隧道换了端口时用）。
   */
  async retarget(slot, url) {
    const s = this.surfaces.get(slot);
    if (!s || s.view.webContents.isDestroyed()) return;
    // 只更新 s.origin —— 监听器已经装过了，不重复装（见 _wireSurface 的注释）
    s.origin = originOf(url);
    await s.view.webContents.loadURL(url);
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
    // ★ 移除遮罩后必须把焦点还给界面那块视图，否则用户打字没反应 ——
    //   又一个「看起来正常但就是不工作」的静默失败。
    //   还给的必须是**前台**那一块：遮罩底下看得见的就是它。
    const s = this._front ? this.surfaces.get(this._front) : null;
    if (s && !s.view.webContents.isDestroyed()) s.view.webContents.focus();
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
    //
    // ★ 可见性：**只有前台那一块**。其余各块 setVisible(false) 但**留着** ——
    //   它们背后是还活着的服务器，切回去时必须是同一个页面（`setBounds(0,0,0,0)`
    //   那种"藏法"会把页面尺寸打乱，切回来要重排）。
    for (const [slot, s] of this.surfaces) {
      if (!s.view.webContents || s.view.webContents.isDestroyed()) continue;
      const on = slot === this._front;
      s.view.setVisible(on);
      if (on) s.view.setBounds({ x: 0, y: top, width: w, height: body });
    }
    if (this.overlayView && !this.overlayView.webContents.isDestroyed()) {
      this.overlayView.setBounds({ x: 0, y: top, width: w, height: body });
    }
  }

  // ── 面板通信 ────────────────────────────────────────────────────────────
  /**
   * 告诉窗口「现在有几条会话、各自由哪个插件在接」。
   *
   * 窗口只用它两件事：**有几条活着**（关窗确认要数）、以及各自的 `closeWarning`
   * （要掐断的东西不一样，话也得不一样）。传整个插件对象而不是一句文案，是为了
   * 让窗口在将来需要别的插件信息时不必再开一个方法 —— 但它**不**应该去读
   * `attach` 之类的东西：那是框架与插件之间的事。
   *
   * ★ 从前这里收的是**一个** plugin（`setSessionService`），失败形态不是崩溃而是
   *   **说一句假话**：两条会话（开发环境 + 中转站）时，窗口会把"关闭会结束这个
   *   开发会话，编辑器里**没有保存的改动会丢失**"念给一个只用着终端的人听。
   */
  setSessions(list) { this._sessions = Array.isArray(list) ? list : []; }

  /**
   * 把**全部**会话推给面板，并顺手把前台记下来。
   *
   * ★ 界面唯一的数据来源是这一份**列表**，不是"最后动过的那一个快照"。从前那个
   *   形状在多开下的失败形态是"某一条会话在界面上根本不存在" —— 既没有标签、
   *   也没有「结束会话」的入口，而它在集群上占着资源。
   */
  pushSessions(list, front) {
    this._front = front || null;
    const wc = this.win.webContents;
    if (!wc.isDestroyed()) wc.send('session:states', { sessions: list, front: this._front });
    this._layout();
    // ★ 这里曾经有一条「origin 变了就 loadURL」的自动 retarget。删掉了：
    //   它是第二条改 URL 的通路，而且只会 loadURL —— **不换 partition、
    //   也不重跑登录**。换布局组要的恰恰是前者，于是两条路必然分叉。
    //   现在统一由 index.js 的 ensureSurface 判定（它同时看 url 和 partition）。
  }

  /** 把被外壳吞掉的按键推给**前台**那个假页面（仅开发者模式用，用于对照）。 */
  pushSwallowed(desc) {
    const s = this._front ? this.surfaces.get(this._front) : null;
    if (!s || s.view.webContents.isDestroyed()) return;
    s.view.webContents.send('demo:swallowed', desc);
  }

  pushNotice(kind, text) {
    const wc = this.win.webContents;
    if (!wc.isDestroyed()) wc.send('ui:notice', { kind, text });
  }

  /**
   * 主动推一份新的插件视图。
   *
   * ★ 站点对账是**后台**跑的（连上之后才开始取文件，一次一份，真集群上一份就是
   *   一次 `ssh` exec）。不推的话，用户看到的是连接那一刻的旧视图 —— 而"插件
   *   明明是站点说要给的，界面上却什么都没有"正是这个功能最该避免的那句话。
   */
  pushPlugins(view) {
    const wc = this.win.webContents;
    if (!wc.isDestroyed()) wc.send('ui:plugins', view);
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
      // ★ **数活着的条数**，不是"有没有会话"。从前这一个布尔在多开下的失败形态
      //   是一句**不成立的话**：关窗只说了"会结束这个会话"，而实际掐断两条 ——
      //   用户以为自己只损失一个。（与账本 F13 同一类：说了一句话，而它不成立。）
      const live = this._sessions.filter((s) => s && s.live);
      if (!live.length) {                 // 没有会话语义上的损失，不必打扰
        this._closeConfirmed = true;
        this.onClose();
        return;
      }
      // 不同插件被掐断的东西不一样，所以话也得不一样：中转站那边窗口里什么都
      // 没有，用户真正在用的东西在他的终端里、在 codex 里。照搬浏览器里那句
      // 「编辑器里没保存的改动会丢失」指的是另一回事 —— 而这一下点错，断掉的是
      // 他正在跑的编译或对话。
      //
      // ★ 文案由**插件**提供（见 plugins/*.js 的 closeWarning），窗口不认识任何
      //   插件名。没有插件信息时用中性的那句 —— 见 NEUTRAL_CLOSE_WARNING。
      //
      // ★ 一条一条**各念各的**：两条会话各掐断什么，只有各自的插件说得清。合成
      //   一句"会结束 2 个会话"等于把"你的编辑器里有没保存的改动"这件**只对其中
      //   一条成立**的事说成对两条都成立。
      const warn = (s) => (s.plugin && s.plugin.closeWarning) || NEUTRAL_CLOSE_WARNING;
      const message = live.length === 1
        ? warn(live[0]).message
        : `关闭窗口会结束这 ${live.length} 个会话。`;
      const detail = (live.length === 1
        ? warn(live[0]).detail
        : live.map((s) => `· ${s.service || '（未知服务）'}：${warn(s).detail}`).join('\n'))
        + '（若只是想暂时离开，直接放着窗口不管就行 —— 合盖或断网不会结束作业，'
        + '下次打开会自动接上。）';
      const { response } = await dialog.showMessageBox(this.win, {
        type: 'question',
        buttons: [live.length === 1 ? '结束会话并退出' : `结束这 ${live.length} 个会话并退出`,
          '取消'],
        defaultId: 1,                     // 默认停在「取消」：回车不该毁掉作业
        cancelId: 1,
        title: '关闭 Slurmate',
        message,
        detail,
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
    // 每一块界面走它自己那条（还要清 partition、立 _destroying 旗子）。
    // ★ 遍历的是**一份拷贝**：`_destroySurface` 会改 `this.surfaces`。
    for (const slot of [...this.surfaces.keys()]) this._destroySurface(slot);
    this._front = null;
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

module.exports = { ShellWindow };
