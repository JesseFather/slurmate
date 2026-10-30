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
 * 这是整个客户端最重要的一条缝：`session.js` 及以上只知道这个接口，不知道背后
 * 是 SSH 还是一个本地的模拟站点。所以接真实集群时，改动被限制在 `backend-ssh.js` 里。
 *
 * `kind` 说的是"这个后端是谁"（`ssh` / `fake` —— 后者在 `backend-fake.js` 里）。
 *   假站点只由测试进程进入（见 createBackend），不在生产路径上。
 *
 * 接口（两个实现必须完全一致）：
 *
 *   kind                   'fake' | 'ssh'
 *   connected              {boolean}  当前是不是连着。两个后端必须都实现它 ——
 *                          调用方（index.js 的启动接续）要是去摸 SSH 后端的私有
 *                          字段 `_conn`，而演示后端用的是另一个名字，那个判断
 *                          在假后端上就恒为假、整条启动接续被静默关掉。
 *                          要「有没有连上」就问后端，别去猜它的内部字段叫什么。
 *   connect(profile)       → { ok, error?, code?, whoami?, daemonVersion?, daemonCaps? }
 *                            建立连接（假后端在这里起 HTTP 服务）
 * `daemonVersion` 是握手要的那个号，三态：
 *                              字符串 = 问到了；`null` = 对面没有 `ping` 这个 op；
 *                              `undefined` = 答了却没有 `version`。
 *                              后两者不是同一件事，判定见 plugins/index.js 的
 *                              `versionCheck`（三个缺席各有名字）。两个后端都必须
 *                              报它 —— 版本闸在 index.js，它只看这一个字段。
 * `daemonCaps` 是对面声明支持的那几样（`ping` 应答的 `caps`）。数组 = 问到了；
 *                              `null` / 缺席 = 老守护进程没声明，按基线处理。
 *                              它不是"版本号换成另一个形状"：版本号回答能不能谈，
 *                              能力回答能不能用某一样新行为（例如分区下拉里那个
 *                              不点名的选项指的是 Slurm 还是守护进程自己）。
 *   rpc(req, timeoutMs?)   → 守护进程风格的响应对象；不抛异常（传输失败由 classify 处理）
 *                            第二条参数是这一次的预算，省略时用实现自己的缺省值。
 *                            「没有应答」也是一次传输失败，各实现都不许让它永远挂着。
 *   dial(host, port)       → Promise<Duplex>  建立一条到目标的数据通道
 *   close()                → 拆除
 *   on('state', fn)        → 连接状态变化 { connected, detail }
 *   on('notify', fn)       → 服务端主动推来的一份全量会话快照
 *                            `{ push:'sessions', seq:<单调>, at, sessions:[视图], stale? }`
 * "这条会话被另一台电脑接管了"不是一个后端事件。要是接管走一条推送 +
 *   一根独立的状态轴，服务端就得顶掉整个客户端；而"谁在看一条会话"是
 *   会话行上的一格，"我不再是看护者"由心跳的应答告诉客户端（`ignored`），
 *   于是它是逐会话的、也是这条连接自己问出来的 —— 不需要一条推送，
 *   也不需要后端替会话记一个状态。
 *
 * 它带来的那条保证仍然在，而它现在住在 `session.js`：被接管的会话不许发
 *   `goodbye`（`goodbye` 会让 `phase_release` 删掉 ACL 并 scancel 作业，
 *   而用户以为自己只是换了个地方看）。守护进程分辨不了那个 `goodbye` 是谁发的，
 *   所以这一半只能在客户端堵。
 *
 * `notify` 的契约是"可以不发"，不是"必须发"。这不是容错，是这一版能成立
 *    的前提：SSH 后端的常驻通道会因为"登录节点上的 CLI 还是旧的"而起不来，
 *    那时它一条都不发；而调用方（session.js）有一条推送看门狗
 *    （`PUSH_STALE_MS`），一条推送都没收到时它的对账逐字回到这一版之前。
 *
 * 两个后端都必须实现它（`fake` 那个照着真守护进程的规则发：变了就发、
 *      没变也每 30 秒发一条），否则那条路在测试里一次都走不到 ——
 *      "测试里能跑、真集群跑不了"正是这个接缝最怕的一类。
 *
 * 推送不带秘密（口令、作业内主机公钥）。那不是疏忽：守护进程用
 *   `with_secret=False` 渲染它，与 `list` 逐字同构 —— 于是"推送里没有秘密"
 *   是一条结构性质，不依赖任何一处判断。要口令就走 `status`。
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
   * 抛异常而不是返回 false。少实现在这里会静默变成「永远没连上」，于是调用方
   * （启动接续）什么都不做，而没有任何地方报错 —— 那正是这个接缝要防的一类。
   */
  get connected() { throw new Error('未实现 connected'); }

  /**
   * 这个后端每一次 RPC 的代价是不是"一条常驻通道上的一个来回"。
   *
   *   true  —— 常驻通道在（一次 RPC = 往已有的 duplex 上写一行 JSON）
   *   false —— 退化成了 exec（一次 RPC = 一个 SSH channel = sshd fork + PAM +
   *            bash + python3 冷启动）
   *   null  —— 没连上，或者这个后端根本没有"退化"这回事
   *
   * 它是给"多久问一次"用的，不是给"通不通"用的。这两者的区别很大：
   *   一个每 1.5 秒问一次的轮询，在常驻通道上是一条推送的成本，在 exec 上
   *   是把登录节点打满 —— 而同一份代码在两种通道下跑。没有这一格的话，
   *   间隔只能按最坏情况定（那会让常驻通道上白白慢十倍），或者按最好情况定
   *   （那会在退化时压垮登录节点）。见 `client/src/main/index.js` 的
   *   `SITE_POLL_MS` / `sitePollMs()`。
   *
   * 默认实现返回 `null`（"不知道"）—— 调用方按最保守的那一档处理。
   *   写成"默认 true"的话，下一个后端忘了实现它就会以最快节奏跑。
   */
  get resident() { return null; }

  /**
   * 提交之前调一次：把站点上"这一跳迟早要用"的东西备好。今天是作业日志目录
   * （`sbatch -o` 的父目录是 Slurm 在跑作业脚本之前打开的，而作业脚本那一次
   * `mkdir -p` 排在它后面 —— 见 `backend-ssh.js` 的 `PREPARE_CMD`）。
   *
   * 它是"要用了，等一等"，不是"连上了，顺手做"。两件事分开的理由是【谁等它】：
   *   连接不等（真机 2026-10-16：那一次 `mkdir` 落在共享盘的家目录上，冷挂载
   *   要几十秒，把「已连接」整整卡住 15 秒然后报了一条超时），而提交等它 ——
   *   目录不在，那一次作业连启动都启动不了。等也是有预算的：到点就照常提交，
   *   判据是"没回来"不等于"没有"（见 `backend-ssh.js` 的 `ensurePrepared()`）。
   * 连接那一刻会发起一次（后端的实现细节，见 `backend-ssh.js` 的
   *   `beginPrepare()`），而这一条是"等它、没成就再试一次"。
   *
   * 返回值只在"没成"的时候有意义：`definite` 说的是"站点明确说了它建不出来"
   *   （那条命令真的跑了、退出码不是 0）。只有那一种才该拦住提交，别的
   *   （超时、通道错、还没连上）都照常往下走。
   *
   * 它不是连接的一部分：返回值只用来告诉调用方"有没有成"，
   *   失败与否都不影响"连上了"这个事实。写成"失败就让 connect() 失败"的话，
   *   一个建不出目录的家目录会让用户连都连不上 —— 而他真正失去的是提交，
   *   不是连接。
   *
   * 默认实现是空操作，而且【必须当场返回】：假后端在本地跑，没有远端目录可建，
   *   让它变成一个"每次提交多一次往返"是白花的。它必须存在（而不是让调用方去
   *   `typeof backend.ensurePrepared === 'function'`）—— 那种写法会让"下一个
   *   忘了实现它的后端"静默地跳过这一步，而症状要到用户提交作业时才出现。
   */
  async ensurePrepared() { return { ok: true }; }

  // eslint-disable-next-line no-unused-vars
  async connect(profile) { throw new Error('未实现 connect'); }
  // eslint-disable-next-line no-unused-vars
  async rpc(req) { throw new Error('未实现 rpc'); }
  // eslint-disable-next-line no-unused-vars
  async dial(host, port) { throw new Error('未实现 dial'); }
  async close() { /* 默认无事可做 */ }

  /**
   * 供子类调用，广播连接状态。
   *
   * `extra` 是给「不用再重试」的那一类结论用的（例如站点上没有本系统的
   *   命令）：顶上那两格对所有状态都成立，额外的旗标只在你真的知道那是
   *   什么的时候才带上。
   */
  _emitState(connected, detail, extra) {
    this.emit('state', {
      kind: this.kind,
      connected: Boolean(connected),
      detail: detail || null,
      ...(extra || {}),
    });
  }
}

/**
 * 选择后端。
 *
 * @param {object} opts
 *   test    {boolean}  测试后端。只由测试进程设置，打包版为假（见 index.js）。
 *                      它是进假站点的唯一一条路。
 *   ssh     {object}   SSH 后端的参数（私钥、主机密钥裁决、客户端身份）
 *   fake    {object}   假站点的可调参数
 *
 * `ssh.client` / `fake.client` 是这台电脑的客户端身份 `{id, name}`，
 *   由 index.js 从数据目录里读出来（见 config.js 的 `loadClientId`）。
 *   后端自己不生成它 —— 身份是"这台电脑"的属性，不是"这次连接"的属性，
 *   而一个后端会被重连很多次。
 *
 * 这个选择没有第三条路。兜底到假站点是错的：真发生的时候，用户会以为
 *   连上了集群、其实在跟一个本地假服务打交道。所以没有 SSH 后端的构建
 *   响亮地坏 —— 它不该装作能连集群。
 */
function createBackend(opts = {}) {
  if (opts.test) {
    const { FakeBackend } = require('./backend-fake.js');
    return new FakeBackend(opts.fake || {});
  }
  const ssh = require('./backend-ssh.js');
  if (!ssh.isImplemented()) {
    throw new Error('这个构建里没有可用的 SSH 后端。假站点只能由测试进程进入。'
      + '它不再作为"真后端不可用"时的兜底，因为那样的降级会让用户以为'
      + '自己连上了集群。');
  }
  // ssh 选项（私钥、主机密钥裁决）由 index.js 提供 —— 它们来自配置与 keys.js，
  // 后端自己不该知道这些东西存在哪里。
  return new ssh.SshBackend(opts.ssh || {});
}

module.exports = { Backend, KIND, createBackend };
