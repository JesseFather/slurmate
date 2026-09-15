'use strict';
/**
 * backend.js —— 后端接口与选择器。
 *
 * 这是整个客户端最重要的一条缝：`session.js` 及以上**只知道这个接口**，不知道背后
 * 是 SSH 还是演示。所以下一阶段接真实集群时，改动被限制在 `backend-ssh.js` 里。
 *
 * 接口（两个实现必须完全一致）：
 *
 *   kind                   'demo' | 'ssh'
 *   label                  给界面显示的名字
 *   connected              {boolean}  当前是不是连着。**两个后端必须都实现它** ——
 *                          调用方（index.js 的启动接续）此前直接摸 SSH 后端的私有
 *                          字段 `_conn`，而演示后端用的是另一个名字，于是那个判断
 *                          在演示模式下恒为假、整条启动接续被静默关掉。
 *                          要「有没有连上」就问后端，别去猜它的内部字段叫什么。
 *   connect(profile)       → { ok, error?, whoami? }   建立连接（演示后端在这里起 HTTP 服务）
 *   rpc(req)               → 守护进程风格的响应对象；**不抛异常**（传输失败由 classify 处理）
 *   dial(host, port)       → Promise<Duplex>  建立一条到目标的数据通道
 *   close()                → 拆除
 *   on('state', fn)        → 连接状态变化 { connected, detail }
 */

const { EventEmitter } = require('events');

const KIND = { DEMO: 'demo', SSH: 'ssh' };

/**
 * 后端基类。两个实现都继承它，以便「接口一致」这件事在代码里是显式的，
 * 而不是靠两份实现各自记得。
 */
class Backend extends EventEmitter {
  constructor() {
    super();
    if (new.target === Backend) throw new Error('Backend 是抽象类');
  }

  /**
   * 抛异常而不是返回 false。少实现在这里会**静默**变成「永远没连上」，于是调用方
   * （启动接续）什么都不做，而没有任何地方报错 —— 那正是这个接缝此前的老毛病。
   */
  get connected() { throw new Error('未实现 connected'); }

  // eslint-disable-next-line no-unused-vars
  async connect(profile) { throw new Error('未实现 connect'); }
  // eslint-disable-next-line no-unused-vars
  async rpc(req) { throw new Error('未实现 rpc'); }
  // eslint-disable-next-line no-unused-vars
  async dial(host, port) { throw new Error('未实现 dial'); }
  async close() { /* 默认无事可做 */ }

  /** 供子类调用，广播连接状态。 */
  _emitState(connected, detail) {
    this.emit('state', { kind: this.kind, connected: Boolean(connected), detail: detail || null });
  }
}

/**
 * 选择后端。
 *
 * @param {object} opts
 *   demo      {boolean}  强制演示模式（命令行 --demo）
 *   demoConfig {object}  演示后端的可调参数
 *
 * **不会**在真实后端不可用时静默退回演示模式。理由：那正是「系统声称了不成立的事」——
 * 用户以为连上了集群，其实在跟一个本地假服务打交道。真实后端没实现就【明确地】报告，
 * 由 index.js 决定是否降级，并把降级结果一路显示到界面上。
 */
function createBackend(opts = {}) {
  const ssh = require('./backend-ssh.js');
  if (!opts.demo && ssh.isImplemented()) {
    // ssh 选项（私钥、主机密钥裁决）由 index.js 提供 —— 它们来自配置与 keys.js，
    // 后端自己不该知道这些东西存在哪里。
    return new ssh.SshBackend(opts.ssh || {});
  }
  const { FakeBackend } = require('./backend-fake.js');
  return new FakeBackend(opts.demoConfig || {});
}

module.exports = { Backend, KIND, createBackend };
