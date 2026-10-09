// Copyright 2026 JesseFather
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

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
 *                          调用方（index.js 的启动接续）要是去摸 SSH 后端的私有
 *                          字段 `_conn`，而演示后端用的是另一个名字，那个判断
 *                          在假后端上就恒为假、整条启动接续被静默关掉。
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
 *   on('notify', fn)       → 服务端**主动推**来的一份全量会话快照
 *                            `{ push:'sessions', seq:<单调>, at, sessions:[视图], stale? }`
 * ★ **"这条会话被另一台电脑接管了"不是一个后端事件。** 要是接管走一条推送 +
 *   一根独立的状态轴，服务端就得**顶掉整个客户端**；而"谁在看一条会话"是
 *   **会话行上的一格**，"我不再是看护者"由**心跳的应答**告诉客户端（`ignored`），
 *   于是它是**逐会话**的、也是**这条连接自己问出来的** —— 不需要一条推送，
 *   也不需要后端替会话记一个状态。
 *
 * ★ 它带来的那条保证仍然在，而它现在住在 `session.js`：**被接管的会话不许发
 *   `goodbye`**（`goodbye` 会让 `phase_release` 删掉 ACL 并 scancel 作业，
 *   而用户以为自己只是换了个地方看）。守护进程分辨不了那个 `goodbye` 是谁发的，
 *   所以这一半只能在客户端堵。
 *
 * ★★ **`notify` 的契约是"可以不发"，不是"必须发"。** 这不是容错，是这一版能成立
 *    的前提：SSH 后端的常驻通道会因为"登录节点上的 CLI 还是旧的"而起不来，
 *    那时它一条都不发；而调用方（session.js）有一条推送看门狗
 *    （`PUSH_STALE_MS`），一条推送都没收到时它的对账**逐字回到这一版之前**。
 *
 *    ⇒ **两个后端都必须实现它**（`fake` 那个照着真守护进程的规则发：变了就发、
 *      没变也每 30 秒发一条），否则开发者模式里那条路一次都走不到 ——
 *      "开发模式能跑、真集群跑不了"正是这个接缝最怕的一类。
 *
 * ★ 推送**不带秘密**（口令、作业内主机公钥）。那不是疏忽：守护进程用
 *   `with_secret=False` 渲染它，与 `list` 逐字同构 —— 于是"推送里没有秘密"
 *   是一条**结构性质**，不依赖任何一处判断。要口令就走 `status`。
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
   * （启动接续）什么都不做，而没有任何地方报错 —— 那正是这个接缝要防的一类。
   */
  get connected() { throw new Error('未实现 connected'); }

  /**
   * 这个后端**每一次 RPC 的代价是不是"一条常驻通道上的一个来回"**。
   *
   *   true  —— 常驻通道在（一次 RPC = 往已有的 duplex 上写一行 JSON）
   *   false —— 退化成了 exec（一次 RPC = **一个 SSH channel** = sshd fork + PAM +
   *            bash + python3 冷启动）
   *   null  —— 没连上，或者这个后端根本没有"退化"这回事
   *
   * ★★ **它是给"多久问一次"用的，不是给"通不通"用的。** 这两者的区别很大：
   *   一个每 1.5 秒问一次的轮询，在常驻通道上是一条推送的成本，在 exec 上
   *   是把登录节点打满 —— 而**同一份代码**在两种通道下跑。没有这一格的话，
   *   间隔只能按最坏情况定（那会让常驻通道上白白慢十倍），或者按最好情况定
   *   （那会在退化时压垮登录节点）。见 `client/src/main/index.js` 的
   *   `SITE_POLL_MS` / `sitePollMs()`。
   *
   * ★ 默认实现返回 `null`（"不知道"）—— 调用方按**最保守**的那一档处理。
   *   写成"默认 true"的话，下一个后端忘了实现它就会以最快节奏跑。
   */
  get resident() { return null; }

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
 *   ssh     {object}   SSH 后端的参数（私钥、主机密钥裁决、**客户端身份**）
 *   fake    {object}   假后端的可调参数
 *
 * ★ `ssh.client` / `fake.client` 是**这台电脑的客户端身份** `{id, name}`，
 *   由 index.js 从数据目录里读出来（见 config.js 的 `loadClientId`）。
 *   后端自己**不生成**它 —— 身份是"这台电脑"的属性，不是"这次连接"的属性，
 *   而一个后端会被重连很多次。
 *
 * ★ **这个选择没有第三条路。** 兜底到假后端是错的：真发生的时候，用户会以为
 *   连上了集群、其实在跟一个本地假服务打交道。所以没有 SSH 后端的构建
 *   **响亮地坏** —— 它不该装作能连集群。
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
