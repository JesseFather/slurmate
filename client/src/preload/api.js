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

  // ── 主机密钥（TOFU）──
  // 第一次连一台主机时主进程会拒绝并回一个指纹，由界面让用户核对后调 trustHostKey。
  // 「变了」的情况**不接受**信任 —— 界面只提供「我知道服务器重装了」这条显式出路。
  trustHostKey: (fingerprint) => ipcRenderer.invoke('app:trustHostKey', fingerprint),
  forgetHostKey: () => ipcRenderer.invoke('app:forgetHostKey'),

  // ── 密钥 ──
  publicKey: () => ipcRenderer.invoke('app:publicKey'),
  copyPublicKey: () => ipcRenderer.invoke('app:copyPublicKey'),
  // 作废现有密钥、重新生成一把。会作废已注册到 IDM 的公钥，必须由用户显式发起。
  // 私钥没有「保存方式」这个选项 —— 永远加密保存。
  regenerateKey: () => ipcRenderer.invoke('app:regenerateKey'),

  // ── 会话 ──
  // resources 是高级选项里的**临时**覆盖：{cpus, mem, gpus, partition}。
  // 留空 = 用服务端默认值（2 核 / 8G / 随机挑一个有权限的分区）。
  partitions: () => ipcRenderer.invoke('app:partitions'),
  start: (resources) => ipcRenderer.invoke('app:start', resources),
  state: () => ipcRenderer.invoke('app:state'),
  // 只有一个语义：结束会话并释放资源。没有「保持作业运行」这个模式 ——
  // 保住作业靠的是客户端意外消失时守护进程的容错窗口，不是用户的一个开关。
  stop: () => ipcRenderer.invoke('app:stop'),
  doctor: () => ipcRenderer.invoke('app:doctor'),
  reload: () => ipcRenderer.invoke('app:reload'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

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
