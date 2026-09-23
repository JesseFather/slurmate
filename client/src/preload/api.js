'use strict';
/**
 * preload/api.js —— 面板页与主进程之间的桥。
 *
 * contextIsolation 打开，渲染进程拿不到 Node，只能看见这里显式暴露的东西。
 * 暴露面刻意保持窄：只有这些具名方法，没有通用的 invoke/require 通道。
 *
 * ★ 这里**没有**任何读写配置文件的入口，界面也不提供。
 *   所有条目都在界面上，用户不该为了改一个地址去手编辑 JSON。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('slurmate', {
  // 一次性拉取启动信息（后端种类、连接列表、分区表、公钥、安全存储是否可用…）
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  // ── 连接条目 ──
  probeHosts: () => ipcRenderer.invoke('app:probeHosts'),
  saveConnection: (conn) => ipcRenderer.invoke('app:saveConnection', conn),
  deleteConnection: (id) => ipcRenderer.invoke('app:deleteConnection', id),
  setActiveConnection: (id) => ipcRenderer.invoke('app:setActiveConnection', id),
  connect: (payload) => ipcRenderer.invoke('app:connect', payload),
  // 断开这一跳（作业继续在集群上跑，可以再连回来）。会话进行中会被主进程拒绝。
  disconnect: () => ipcRenderer.invoke('app:disconnect'),

  // ── 插件 ──
  //
  // ★ 插件**只有一条来的路**：站点分发。连上站点之后由 `syncPlugins` 取回来，
  //   落在 `~/.slurmate/site-plugins/`。
  //
  // ★ 带客户端代码的插件要用户点一次同意才加载（`consentPlugin`）。同意闸的落点
  //   在"下载后、暂存验完、换入之前"，理由见 src/main/site-plugins.js。
  //
  // ★ **这里从前还有五个入口**：`installPlugin` / `uninstallPlugin` /
  //   `rescanPlugins` / `openPluginDir` / `setDevPlugins`。它们服务的是"本机池"
  //   —— 用户自己挑一个包、或者干脆拷一个插件目录进去，那条路**不过同意闸**。
  //   它连同 `src/main/plugins/install.js` 整个文件一起删掉了（§5.1/§5.2）。
  //
  // 站点分发：手动对一次账 / 同意 / 不同意。
  syncPlugins: () => ipcRenderer.invoke('app:syncPlugins'),
  consentPlugin: (id, version) => ipcRenderer.invoke('app:consentPlugin', id, version),
  rejectPlugin: (id, version) => ipcRenderer.invoke('app:rejectPlugin', id, version),
  // §5.3：删掉本机那一份 = 撤回同意（下一次对账重新问）。给的是"没被加载的那些"
  // 唯一的出口 —— 见 panel.js 的 renderInert。
  dropPluginVersion: (id, version) => ipcRenderer.invoke('app:dropPluginVersion', id, version),

  // ── 布局组 ──
  //
  // 布局 = 那个网页应用自己的窗口布局/标签页/登录状态，按**本地监听端口**隔离
  // （浏览器按 origin 存 localStorage）。一个布局组被若干条连接共用，
  // 没有任何连接用它的组会被自动回收。只有声明了 contributes.layout 的插件要它。
  //
  // layoutId 传空 = **新建一个空白布局并落进去，一次原子完成**。刻意不提供独立的
  // 「建组」通道：单独建出来的组引用计数天然是 0，紧接着的回收会把它当场删掉 ——
  // 用户点了会没反应。
  //
  // 返回 { ok, layouts, connections }；被拒绝时 code 是 'would_discard'
  // （切走会把旧布局删掉，需要带 confirmDiscard 重来）或 'relisten_failed'
  // （换端口失败，配置一个字没动）。
  setConnectionLayout: (payload) => ipcRenderer.invoke('app:setConnectionLayout', payload),
  // 改名。名字只是给人看的 —— 身份永远是 id（它决定存储分区，永不复用）。
  renameLayout: (payload) => ipcRenderer.invoke('app:renameLayout', payload),

  // ── 本机的插件数据 ──
  //
  // 插件在运行中攒下的东西（编辑器布局、打开的标签页、登录状态）按**份**存在浏览器的
  // 存储分区里，一份 = 一个插件 + 共享组 + 布局组。这一对方法回答"还剩几份、哪一份
  // 没人用"，以及**删掉其中一份**。
  //
  // ★ 删除**不可逆**（那个插件下次打开会是一份全新的空白存储），所以界面必须先问过
  //   用户。被拒绝时只有一个 code：`stale` —— 那**一份已经不在"没人用"的清单里了**
  //   （多半是配置或插件刚变过，或者它正被一条活着的会话用着：那种情况下对账根本
  //   不会把它列出来）。删除成功时把重算过的清单一起回来。
  pluginData: () => ipcRenderer.invoke('app:pluginData'),
  deletePluginData: (payload) => ipcRenderer.invoke('app:deletePluginData', payload),

  // ── 主机密钥（TOFU）──
  // 第一次连一台主机时主进程会拒绝并回一个指纹，由界面让用户核对后调 trustHostKey。
  // 「变了」的情况**不接受**信任 —— 界面只提供「我知道服务器重装了」这条显式出路。
  trustHostKey: (fingerprint) => ipcRenderer.invoke('app:trustHostKey', fingerprint),
  forgetHostKey: () => ipcRenderer.invoke('app:forgetHostKey'),

  // ── 密钥（**每条连接一把**）──
  //
  // 参数统一是 { connectionId }；省略或传 null 表示「新建」表单上那把还没有
  // 归属的密钥。界面里没有「全局密钥」这个概念 —— 每把钥匙属于一条连接，
  // 重新生成一把只影响那一条。
  publicKey: (payload) => ipcRenderer.invoke('app:publicKey', payload),
  copyPublicKey: (payload) => ipcRenderer.invoke('app:copyPublicKey', payload),
  // 作废这条连接的密钥、换一把新的。会作废已注册到 IDM 的公钥，必须由用户显式发起。
  // 私钥没有「保存方式」这个选项 —— 永远加密保存。
  regenerateKey: (payload) => ipcRenderer.invoke('app:regenerateKey', payload),
  // 「新建连接」时先于连接生成的那把密钥（用户要拿它的公钥去 IDM 注册）。
  newKey: () => ipcRenderer.invoke('app:newKey'),

  // ── 会话 ──
  // resources 是高级选项里的**临时**覆盖：{cpus, mem, gpus, partition}。
  // 留空 = 用服务端默认值（2 核 / 8G / 随机挑一个有权限的分区）。
  partitions: () => ipcRenderer.invoke('app:partitions'),
  // serviceKind 是**本站的短名**（配置块名、块标题旁边那个 code）。省略 = 缺省
  // 插件（清单里标了 defaultService 的那一个）—— 与这个参数存在之前的行为一致。
  // 客户端再按短名找到本机对应的那一份，把它的 `<id>@<版本>` 作为解析键交给服务端。
  // 本机一个插件都没装时，主进程会拒绝并说清该往哪放。
  start: (resources, serviceKind) =>
    ipcRenderer.invoke('app:start', resources, serviceKind),
  // 本机要不要某个插件。**按 id**（不是短名）：池是全局的，两个站点可以各有一个
  // 叫 jupyter 的插件而它们是两个不同的东西。不影响服务端。
  setPluginEnabled: (id, enabled) =>
    ipcRenderer.invoke('app:setPluginEnabled', id, enabled),
  // **全部**会话 + 哪一个是前台。`app:state`（单数）已经删掉了 —— 它只会回
  // 最后动过的那一个，而在多开下"某条会话在界面上根本不存在"是一种静默的丢失。
  states: () => ipcRenderer.invoke('app:states'),
  // 把某一条抬到面板上面。**纯界面动作**，不改任何框架状态。
  setFront: (slot) => ipcRenderer.invoke('app:setFront', { slot }),
  // 只有一个语义：结束会话并释放资源。没有「保持作业运行」这个模式 ——
  // 保住作业靠的是客户端意外消失时守护进程的容错窗口，不是用户的一个开关。
  // ★ **必须指名 slot**：省略会被主进程拒绝，而不是"停那唯一的一个"。
  stop: (slot) => ipcRenderer.invoke('app:stop', { slot }),
  doctor: () => ipcRenderer.invoke('app:doctor'),
  reload: (slot) => ipcRenderer.invoke('app:reload', { slot }),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // ── 开发者模式 ──
  //
  // 客户端不连集群、改用一个本地的模拟站点。它是给**插件作者与改客户端的人**用的，
  // 所以入口是界面上一个开关，不是命令行参数 —— 那等于说"Windows 用户请去开终端"。
  //
  // ★ 三个设置动词都**不立即生效**：换后端要重建整个客户端，换插件来源换的是一棵
  //   树的启动快照。界面必须说清「重启后生效」，`restart` 是那条路上的那一步。
  setDeveloperMode: (on) => ipcRenderer.invoke('app:setDeveloperMode', on),
  // 选一个目录当假站点的插件来源。**选完当场报"读到几个插件"** —— 选错了的症状
  // 是"重启之后一个插件都不报"，而那句话指不回原因。读不出插件则**不保存**。
  pickDevPluginDir: () => ipcRenderer.invoke('app:pickDevPluginDir'),
  clearDevPluginDir: () => ipcRenderer.invoke('app:clearDevPluginDir'),
  // 立即重启（让上面那几个设置生效）。会话还在跑的话会先结束它，与关窗口同一套收尾。
  restart: () => ipcRenderer.invoke('app:restart'),

  // 开发者模式的调试开关（真机上极难复现的状态）。不在开发者模式时主进程会拒绝。
  debug: (what, arg) => ipcRenderer.invoke('app:debug', what, arg),

  // 主进程 → 渲染进程
  onStates: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('session:states', h);
    return () => ipcRenderer.removeListener('session:states', h);
  },
  onNotice: (fn) => {
    const h = (_e, notice) => fn(notice);
    ipcRenderer.on('ui:notice', h);
    return () => ipcRenderer.removeListener('ui:notice', h);
  },
  // ★ 站点对账是**后台**跑的（连上之后才开始，一次一份，真集群上一份就是一次
  //   `ssh` exec）。不推的话，用户看到的是连接那一刻的旧视图 —— 而"插件明明是
  //   站点说要给的、界面上却什么都没有"正是这个功能最该避免的那句话。
  onPlugins: (fn) => {
    const h = (_e, view) => fn(view);
    ipcRenderer.on('ui:plugins', h);
    return () => ipcRenderer.removeListener('ui:plugins', h);
  },
});
