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
    return new ssh.SshBackend();
  }
  const { FakeBackend } = require('./backend-fake.js');
  return new FakeBackend(opts.demoConfig || {});
}

module.exports = { Backend, KIND, createBackend };
