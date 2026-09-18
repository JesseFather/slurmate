'use strict';
/**
 * backend.js —— 后端接口与选择器。
 *
 * 这是整个客户端最重要的一条缝：`session.js` 及以上**只知道这个接口**，不知道背后
 * 是 SSH 还是一个本地的模拟站点。所以接真实集群时，改动被限制在 `backend-ssh.js` 里。
 *
 * ★ **`kind` 与"模式"是两件事，别合并。** `kind` 说的是"这个后端是谁"
 *   （`ssh` / `fake` —— 后者在 `backend-fake.js` 里），而**开发者模式**说的是
 *   "用户这次选了哪一个"。今天两者一一对应（假后端**只**由开发者模式开关进来，
 *   见 createBackend），但它们是两个问题：模式是用户的设置，kind 是实现的身份。
 *
 * 接口（两个实现必须完全一致）：
 *
 *   kind                   'fake' | 'ssh'
 *   label                  给界面显示的名字
 *   connected              {boolean}  当前是不是连着。**两个后端必须都实现它** ——
 *                          调用方（index.js 的启动接续）此前直接摸 SSH 后端的私有
 *                          字段 `_conn`，而演示后端用的是另一个名字，于是那个判断
 *                          在假后端上恒为假、整条启动接续被静默关掉。
 *                          要「有没有连上」就问后端，别去猜它的内部字段叫什么。
 *   connect(profile)       → { ok, error?, code?, whoami?, daemonVersion? }
 *                            建立连接（假后端在这里起 HTTP 服务）
 *                            ★ `daemonVersion` 是**握手要的那个号**，三态：
 *                              字符串 = 问到了；`null` = 对面没有 `ping` 这个 op；
 *                              `undefined` = 答了却没有 `version`。
 *                              后两者不是同一件事，判定见 plugins/index.js 的
 *                              `versionCheck`（三个缺席各有名字）。两个后端都必须
 *                              报它 —— 版本闸在 index.js，它只看这一个字段。
 *   rpc(req)               → 守护进程风格的响应对象；**不抛异常**（传输失败由 classify 处理）
 *   dial(host, port)       → Promise<Duplex>  建立一条到目标的数据通道
 *   close()                → 拆除
 *   on('state', fn)        → 连接状态变化 { connected, detail }
 */

const { EventEmitter } = require('events');

const KIND = { FAKE: 'fake', SSH: 'ssh' };

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
 *   dev     {boolean}  **开发者模式**（用户在界面上打开的那个开关，见 index.js）。
 *                      它是进假后端的**唯一**一条路。
 *   ssh     {object}   SSH 后端的参数（私钥、主机密钥裁决）
 *   fake    {object}   假后端的可调参数
 *
 * ★ **这个选择没有第三条路。** 从前它是「`--demo`，否则只要 SSH 后端没实现就
 *   落到假后端」—— 而那句兜底与它旁边那句注释（"绝不会在真实后端不可用时静默
 *   退回"）正好相反：真发生的时候，用户会以为连上了集群、其实在跟一个本地假服务
 *   打交道。今天 `isImplemented()` 恒为真，所以那一支是**死的**，但它描述的是一条
 *   这个项目已经不认的行为。所以它改成**响亮地坏**：一个没有 SSH 后端的构建不该
 *   装作能连集群。
 */
function createBackend(opts = {}) {
  if (opts.dev) {
    const { FakeBackend } = require('./backend-fake.js');
    return new FakeBackend(opts.fake || {});
  }
  const ssh = require('./backend-ssh.js');
  if (!ssh.isImplemented()) {
    throw new Error('这个构建里没有可用的 SSH 后端。假后端只由**开发者模式**开关'
      + '进入 —— 它不再作为"真后端不可用"时的兜底，因为那样的降级会让用户以为'
      + '自己连上了集群。');
  }
  // ssh 选项（私钥、主机密钥裁决）由 index.js 提供 —— 它们来自配置与 keys.js，
  // 后端自己不该知道这些东西存在哪里。
  return new ssh.SshBackend(opts.ssh || {});
}

module.exports = { Backend, KIND, createBackend };
