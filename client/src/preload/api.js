'use strict';
/**
 * preload/api.js —— 面板页与主进程之间的桥。
 *
 * contextIsolation 打开，渲染进程拿不到 Node，只能看见这里显式暴露的东西。
 * 暴露面刻意保持窄：只有这些具名方法，没有通用的 invoke/require 通道。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('slurmate', {
  // 一次性拉取启动信息（后端种类、地址表、用途列表、安全存储是否可用…）
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  // 登录节点地址探测（三个地址并发，SSH banner 校验）
  probeHosts: () => ipcRenderer.invoke('app:probeHosts'),
  connect: (profile) => ipcRenderer.invoke('app:connect', profile),

  purposes: () => ipcRenderer.invoke('app:purposes'),
  start: (purpose) => ipcRenderer.invoke('app:start', purpose),
  state: () => ipcRenderer.invoke('app:state'),
  stop: (mode) => ipcRenderer.invoke('app:stop', mode),
  doctor: () => ipcRenderer.invoke('app:doctor'),
  reload: () => ipcRenderer.invoke('app:reload'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  // 口令存储。mode: 'none' | 'encrypted' | 'plain'。
  // 返回 {ok:false, reason:'no_secure_storage'} 时**由界面去问用户**，
  // 主进程绝不自行降级成明文。
  savePassword: (mode, password) => ipcRenderer.invoke('app:savePassword', { mode, password }),

  // 演示模式的调试开关（真机上极难复现的状态）
  debug: (what) => ipcRenderer.invoke('app:debug', what),

  // 主进程 → 渲染进程
  onState: (fn) => {
    const h = (_e, snap) => fn(snap);
    ipcRenderer.on('session:state', h);
    return () => ipcRenderer.removeListener('session:state', h);
  },
  onNotice: (fn) => {
    const h = (_e, notice) => fn(notice);
    ipcRenderer.on('ui:notice', h);
    return () => ipcRenderer.removeListener('ui:notice', h);
  },
});
