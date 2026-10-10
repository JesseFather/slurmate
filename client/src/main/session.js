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
 * session.js —— 会话编排与心跳。
 *
 * 状态机（客户端侧）：
 *
 *   idle ─start()→ submitting ─→ queued ─(拿到 tunnel_target)→ running ─stop()→ releasing → ended
 *                       │            │                              │
 *                       └────────────┴────── 失败/被回收 ────────────┴──→ error
 *
 * ── 本文件里三个「静默失败」的防线 ─────────────────────────────────────────
 *
 * 1. **心跳**。守护进程判活只看 `last_hb_socket`（客户端经 unix socket 发的那个），
 *    **完全不读作业写的 `.jobhb` 文件**。停发心跳 → 300 秒后 `suspect`、
 *    1800 秒后 `orphaned` + scancel。而界面在此期间**一切正常** —— 这正是最危险的地方。
 *    所以心跳由本类用**单一 Map**持有，与窗口是否可见完全无关；发 goodbye 前先停；
 *    并且用 status 回来的 `last_hb_at` 交叉校验「心跳到底有没有落地」。
 *
 * 2. **submit 非幂等**。`op_submit` 每次调用都生成新 sid、插新行、提交新作业；
 *    而 `count_active` 只数 ACL_STATES，`submitted` 不在内，所以配额拦不住第二个。
 *    → 超时 45s（比 CLI 内部的 40s 长）、**超时绝不重试**、用 status 认领。
 *
 * 3. **`ok:true` 不代表作业已停**。`goodbye` 的 `ok:true` 说的是「这条请求被受理
 *    了、会话进了 `releasing`」；`released` 说的才是「作业确认消失了」—— 守护进程
 *    在两者之间有一道闸（`docs/ARCHITECTURE.md` 的 §3.0），而它会一直重试。
 *    所以「正在释放」和「已结束」必须是两个状态，且不能自己宣布成功。
 *    ★ 这一次 `scancel` 没成功时，响应里带 `data.warning`（账本 F12）
 *    —— 那句必须显示：用户会以为作业停了，而它可能还在烧 GPU。
 */

const { EventEmitter } = require('events');
const { Action, classify, shouldRetry } = require('./classify.js');
const { Tunnel } = require('./tunnel.js');
const { jobText } = require('./jobstate.js');
const { gresText } = require('./gres.js');

const State = {
  IDLE: 'idle',
  SUBMITTING: 'submitting',
  QUEUED: 'queued',        // 守护进程 state=submitted，还没登记
  RUNNING: 'running',      // 拿到 tunnel_target 了
  RELEASING: 'releasing',
  ENDED: 'ended',
  ERROR: 'error',
};

/** 心跳间隔。suspect_after=300s，留 6 倍余量。 */
const HEARTBEAT_MS = 45000;

/**
 * 「这条作业被另一台电脑接管了」—— 交给 `suspend()` 的那句话。
 *
 * ★ 它是一条**常量**而不是散在 `_beat()` 与界面里的两句文案：界面那一边（状态条、
 *   明细里那一行）要印的是**同一件事**，而两处各写一句的漂法是"主进程说被接管了、
 *   界面说被顶掉了"—— 用户会去查一个不存在的区别。
 */
const SUSPENDED_TAKEN_OVER =
  '这条作业已被另一台电脑接管，本机不再看护它（作业仍在运行）。';

/**
 * 稳定态刷新间隔（剩余时间、续期次数、tunnel_target 变化、被回收检测）。
 *
 * 60 秒而不是 30：一次 status = 一个 SSH exec channel = sshd fork + PAM session +
 * bash + python3 冷启动，而守护进程是**单线程同步**的，它的每个 tick 会为所有用户的
 * 所有会话各 fork 一次 squeue。稳定态下 `tunnel_target` 拿到就不会变，30 秒一次
 * 纯属给这个循环加压，受害的是所有人。
 */
const STATUS_MS = 60000;
/** 等待登记时的轮询间隔。这一段是唯一需要密集轮询的时期。 */
const QUEUED_POLL_MS = 3000;
/**
 * 推送看门狗：这么久没收到推送，就当那条路不通，退回按 `STATUS_MS` 轮询。
 *
 * ★★ 必须**严格大于**守护进程的 `SNAPSHOT_INTERVAL`（30 秒）—— 那一条保证
 *    "哪怕什么都没变也每 30 秒推一条"。取小了会把**正常的空闲**读成"通道坏了"，
 *    于是每一轮都去问一次，把常驻通道省下来的东西原样还回去。
 *    反过来的方向也不致命，只是坏得久一点才发现。跨文件用例钉着这个大小关系。
 *
 * ★ 而"一条推送都没收到"（旧 CLI 上没有 `stream` 子命令、老守护进程、
 *   ForceCommand 拦了）落到这里就是 `_lastPushAt` 恒为 0 ⇒ 永远不健康 ⇒
 *   **对账逐字回到这一版之前**。这是这一版最重要的一条性质。
 */
const PUSH_STALE_MS = 75000;

/**
 * 推送那份视图**结构上**不会带的键。
 *
 * ★ 守护进程渲染推送用的是 `session_view(s, with_secret=False)` —— 与 `op_list`
 *   逐字同构，而 list 从来不返回口令。所以这不是"服务端这一次没给"，是**它不会给**。
 *   合并时缺哪个就保留旧值，是那条结构性事实的另一半。
 *
 * ★ 反过来的方向（用 undefined 覆盖）后果不是少显示一格：`auth_password` 没了
 *   ⇒ 自动重登失败 ⇒ **页面打不开**，而界面上一切正常。
 */
const PUSH_ABSENT_KEYS = ['auth_password', 'ssh_host_key'];
/** submit 超时。**必须比 `slurmate` 内部的 40s socket 超时长**，否则会在守护进程
 *  还在跑 sbatch 的时候放弃，然后——按大多数重试逻辑——重试，于是两个作业。 */
const SUBMIT_TIMEOUT_MS = 45000;
/** status.last_hb_at 落后我们最近一次成功心跳超过这个值，说明心跳没落地。 */
const HB_STALE_SLACK_MS = 90000;

/**
 * 守护进程那边**还算数**的全部状态，以及**完事了的**全部状态。
 *
 * ★ 这两个集合是 `cluster/slurmate-sessiond` 那个状态机的**镜像**，而它们是**第二份
 *   实现** —— 这一点没法避免：客户端与服务端是两个进程，"这个会话还算不算数"
 *   必须两边各自能判。能做的只有**收成一处**并写明它的来源 —— 同一件事散成几处、
 *   写法还各不相同的话，"某个状态算哪一边"每次都要现推一遍。
 *
 * ★ 对应关系：
 *   LIVE     = 守护进程的 `OCCUPYING_STATES`（reserved + submitted + ACL_STATES）
 *   FINISHED = 守护进程的 `TERMINAL_STATES`
 *   改任何一边都要同时改另一边 —— 不一致的表现是"某个会话卡在界面上不动"。
 */
const SERVER_LIVE_STATES = ['reserved', 'submitted', 'enrolled',
  'suspect', 'orphaned', 'releasing'];
const SERVER_FINISHED_STATES = ['released', 'rejected', 'expired'];

/**
 * 把一份会话视图合进当前那一份。
 *
 * @param {object|null} prev 当前视图（可能还没有）
 * @param {object}      next 新到的那一份
 * @param {object}      opts `fromPush {boolean}` 这一份是不是**推送**来的
 *
 * ★ 两种来源各有一条**不同**的保留规则，而它们不是同一条规矩的两份实现：
 *   - **推送**：缺 `auth_password` / `ssh_host_key` 是结构性的（见 `PUSH_ABSENT_KEYS`）。
 *   - **status**：口令可能因为一次 `load_session_file` 失败而**暂时**读不出来
 *     （NFS 抖动），那不能当成"口令没了"。
 *
 * ★ 而**换了会话就一律不保留**：拿上一个作业的口令去打一个新作业是另一回事，
 *   而它的症状（认证失败）会指向错误的地方。
 */
function mergeView(prev, next, { fromPush }) {
  const same = Boolean(prev && next && prev.session_id === next.session_id);
  const merged = { ...next };
  if (same) {
    for (const k of (fromPush ? PUSH_ABSENT_KEYS : ['auth_password'])) {
      if (merged[k] === undefined && prev[k] !== undefined) merged[k] = prev[k];
    }
  }
  return merged;
}

class SessionController extends EventEmitter {
  /**
   * @param {object} opts
   *   backend, spaceId, onRelayPort
   *   getExcludedPorts {() => Set<number>}  「别的工作区占着的端口」，由 index.js
   *                                        提供 —— 控制器不认识 config，所以注入。
   *   heartbeatMs / statusMs / queuedPollMs  可注入的节奏，仅供测试缩短用。
   *                                          生产值见文件顶部的常量。
   *
   * spaceId 是**这一份数据**的 id（见 config.js 的「数据空间」那一节）：它决定本地
   * 监听端口、从而决定浏览器 origin 与存储分区。
   *
   * ★ 但控制器**不解释它，也不把端口回报给谁**。那个数在工作区创建时就定下来了，
   *   此后**只读**（`config.js` 的 `assignSpacePorts`）。顺移只影响**这一次**会话：
   *   把顺移后的值写回配置，等于把一次**暂时**的冲突变成永久的 origin 变更 ——
   *   冲突消失之后 origin 也回不去了，而那份布局本来是可以回来的。
   *
   * ★ 中转站会话的 spaceId 是 **null**。一份数据存在的全部理由是「浏览器按 origin
   *   隔离 localStorage，所以端口 = 一份编辑器布局」，而中转站没有浏览器 ——
   *   给它分配一份，等于凭空造出一个永远不会被创建的存储分区，还会让
   *   「运行中切工作区」那条路去挪一个 ssh 隧道在用的端口。所以它的端口要**报出去**
   *   （写进用户那份 ssh 配置的 `Port` 行 —— 那边必须反映当前真值），走 onRelayPort。
   */
  constructor({ backend, spaceId, onRelayPort, getExcludedPorts,
                heartbeatMs, statusMs, queuedPollMs, pushStaleMs,
                requestedKind, needsPubkey }) {
    super();
    this.backend = backend;
    this.spaceId = spaceId;
    this.onRelayPort = onRelayPort || (() => {});
    this.getExcludedPorts = getExcludedPorts || (() => new Set());
    this.heartbeatMs = heartbeatMs || HEARTBEAT_MS;
    this.statusMs = statusMs || STATUS_MS;
    this.queuedPollMs = queuedPollMs || QUEUED_POLL_MS;
    /**
     * 推送看门狗的长度。**可注入**，与上面三个节奏同一个理由：用例要把它压到
     * 几百毫秒才验得了"通道坏了会退回轮询"——而真值见 `PUSH_STALE_MS`。
     */
    this.pushStaleMs = pushStaleMs || PUSH_STALE_MS;

    this.state = State.IDLE;
    this.sessionId = null;
    this.session = null;          // 最近一次 status 的会话视图
    this.tunnel = new Tunnel({ backend });
    this.error = null;
    this.warning = null;

    /**
     * 本次会话请求的服务种类。服务端一旦回答了就以**它**为准（见 serviceKind）。
     *
     * ★ 这里**不能**有默认值：默认某个插件名等于在这个文件里写死它；而"什么都不
     *   请求"和"请求那个插件"是两回事，前者根本不该产生一个会话。`start()` 一定会赋值。
     */
    this._requestedKind = requestedKind || null;
    /** 这个插件提交时要不要公钥。由调用方从插件元数据里取，这里不认插件名。 */
    this._needsPubkey = Boolean(needsPubkey);
    /**
     * 用户在「端口被占」那一行上答的是哪一条（`'shift'`），没问过就是 `null`。
     *
     * ★ 控制器**不问任何人**。它只记着"这一趟是不是已经答过了"：答过 ⇒ 顺移是
     *   用户要的，不再多话；没答过 ⇒ 这一处的占用是**提交之后**才冒出来的
     *   （探测到绑定之间那个窗口），只能顺移，并在那句说明里补一句"没有问你"。
     *   ⇒ 所以这里没有"问用户的回调"，也没有默认答案 —— 一个只有一种返回值的
     *   接缝是走不到的码，而"隧道重建 / 换工作区"那两条路本来就没有用户动作
     *   （在用户打字的时候弹一行是敌意行为），它们连这一格都不看。
     */
    this._portChoice = null;
    this._tunnelPort = null;
    this._heartbeatAt = 0;        // 最近一次心跳成功的时间（毫秒）
    this._hbTimer = null;
    this._statusTimer = null;
    this._lastTarget = null;
    this._stopped = false;
    /**
     * 这条作业被另一台电脑接管了（那时这里是原因那句话），没有被接管就是 `null`。
     *
     * ★ 它是一个**终态**：置上之后本机不再心跳、不再对账、不再订阅推送，
     *   而在用户手动点「连接」之前不会清掉。见 `suspend()`。
     */
    this._suspended = null;

    /**
     * 推送那一路的水位。
     *
     * ★ `_lastPushAt` 恒为 0 就是"这个后端从不推送"——而那不是异常状态，
     *   是**这一版必须支持的常态**（旧 CLI、老守护进程、通道断了）。
     *   见 `_pushHealthy()`。
     */
    this._lastPushAt = 0;
    this._pushSeq = 0;
    this._statusBusy = false;
    this._watching = false;
    /** 后端推来的会话快照。绑定一次，订阅/退订用它 —— 每次现 bind 会让退订漏掉。 */
    this._onNotify = (msg) => this._handlePush(msg);

    this.tunnel.on('state', (s) => {
      this._emit();
      if (s.state === 'down') {
        this.warning = '隧道断开，正在重试。作业未受影响，仍在计算节点上运行。';
        this._emit();
      } else if (s.state === 'listening' && this.warning && /隧道断开/.test(this.warning)) {
        this.warning = null;
        this._emit();
      }
    });
    this.tunnel.on('error', (e) => {
      this.warning = '隧道错误：' + (e.code || e.message);
      this._emit();
    });
  }

  /**
   * 这条作业被另一台电脑接管了没有（原因那句话），没有被接管就是 `null`。
   *
   * ★★ 这个 getter **必须有**，而且它单独存在是有理由的：
   *    `index.js` 有**两处**按它做判断 —— `stopAllSessions()` 里跳过它
   *    （否则关一次窗就是一次 scancel）、`tryReattach()` 里先把它 `abandon()` 掉
   *    （否则它仍然占着本机的槽，用户点了「连接」却**一条会话都接不回来**）。
   *    少了这个 getter，那两处读到的都是 `undefined` ⇒ **恒为假**，
   *    而**没有一个字会报错**。
   *
   * ★ 它是真的发生过一次的那种漏法：名字在两个文件里各写了一半
   *   （`_suspended` 在这里、`.suspended` 在那里），中间没有任何东西保证它们一致。
   *   所以 `cluster/test-sessiond-logic.py` 里有一条**跨文件校验**盯着这一对名字。
   */
  get suspended() { return this._suspended; }

  // ── 服务种类 ────────────────────────────────────────────────────────────
  /**
   * 本次会话提供的是哪种服务 —— **原样**，不归一、不认名字。
   *
   * ★ 归一（服务端没说 → 未知、认不出的名字 → 未知）是**注册表**的事，
   *   见 plugins/index.js 的 `resolve()`。这里保持原样有两个理由：
   *
   *   一是这个文件不该认识任何插件名 —— 它对"服务种类"的全部知识就是"有这么
   *   一个字符串"，以及（下面）"这个插件用不用工作区"。加第三个插件时它一行
   *   都不用改。
   *
   *   二是**"服务端没说"要原样传下去**：注册表拿 `null`（守护进程明说它不知道）
   *   与"这个键根本不存在"当同一件事（都是"服务端没说"，都不猜），而这里一旦
   *   替它填上一个值，那个事实就没了。
   *
   * 服务端一旦回答了就以它为准：`_requestedKind` 只是「还没拿到 status 之前」
   * 的临时答案，而唯一权威的来源是会话视图里的 `service_kind`。
   */
  serviceKind() {
    const s = this.session || {};
    return 'service_kind' in s ? s.service_kind : this._requestedKind;
  }

  /**
   * 本次会话用的插件**是哪一版** —— `"<id>@<版本>"`。这是会话的解析键。
   *
   * ★ 三态与 `serviceKind()` 一样：
   *     `undefined` 这个字段还不存在（更旧的守护进程）
   *     `null`      守护进程**明说**它不知道
   *     字符串       解析键
   *
   *   后两种在注册表那边是同一个答案（不猜）—— 但**都要原样传下去**，理由见
   *   `serviceKind()` 那一段。
   *
   * ★ 为什么必须是**会话**带着版本、而不是客户端去问站点"现在是哪一版"：
   *   `op_plugins` 报的是站点**当前**的清单，而一个跑着的作业用的是它**提交时**
   *   那一版 —— 作业侧与客户端侧是配套的两半。站点一升级插件，按"当前清单"解析
   *   已跑的会话就会把新版本的客户端代码接到旧版本的作业实现上。
   */
  servicePlugin() {
    const s = this.session || {};
    return 'service_plugin' in s ? s.service_plugin : undefined;
  }

  // ── 对外快照（界面唯一的数据来源）─────────────────────────────────────────
  snapshot() {
    const s = this.session || {};
    const snap = {
      state: this.state,
      // 中转站会话是 null（见构造函数的说明）。
      spaceId: this.spaceId,
      // 已归一的三种取值之一。界面据此决定「连接」该做什么，**不要**自己猜：
      // null（服务端明说不知道）与 'code-server' 是完全不同的两件事。
      serviceKind: this.serviceKind(),
      // 会话的**解析键**（`<id>@<版本>`）。同样是三态，理由见 servicePlugin()。
      servicePlugin: this.servicePlugin(),
      sshHostKey: typeof s.ssh_host_key === 'string' ? s.ssh_host_key : null,
      sessionId: this.sessionId,
      jobId: s.job_id || null,
      // 本次实际落在哪个分区/节点 —— 因为默认是「从有权限的分区里随机挑」，
      // 用户事先不知道会落到哪种卡上，界面上必须显示出来。
      partition: s.partition || null,
      resources: s.resources || null,
      node: s.node || null,
      tunnelTarget: s.tunnel_target || null,
      localPort: this._tunnelPort,
      origin: this.tunnel.origin,
      // expires_at / job_state / time_limit 在 show_job 失败时**整个 key 不存在**
      // （cluster/slurmate-sessiond:1678-1687）。所以这里必须容忍 undefined，
      // 界面显示「剩余时间未知」而不是 0。
      expiresAt: typeof s.expires_at === 'number' ? s.expires_at : null,
      jobState: s.job_state || null,
      // ★ 判定由**守护进程**给（`job_terminal`），客户端只照着念 ——
      //   见 jobstate.js 顶上那一段（一个判据两处实现会漂）。
      //   老站点不发这个字段时是 `undefined`，jobText() 会退回去印状态原文。
      jobTerminal: typeof s.job_terminal === 'boolean' ? s.job_terminal : undefined,
      jobReason: s.job_reason || null,
      jobExitCode: s.job_exit_code || null,
      jobRestarts: s.job_restarts || null,
      timeLimit: s.time_limit || null,
      renewCount: typeof s.renew_count === 'number' ? s.renew_count : null,
      lastHbAt: s.last_hb_at || null,
      hbAgeMs: this._heartbeatAt ? Date.now() - this._heartbeatAt : null,
      tunnelState: this.tunnel.state,
      backendKind: this.backend.kind,
      error: this.error,
      warning: this.warning,
      // ★ 「这条作业被另一台电脑接管了」。它是**这台客户端**的状态，不是这条会话的
      //   —— 界面要说的话完全不同：session 的 `state` 仍然是 running（作业真的
      //   还在跑），变的只是"本机不再管它了"。把它并进 `state` 的话，界面会
      //   显示「已结束」，而那是**一句不成立的话**。
      // ★★ 而它本身就是**给界面看的那句话**（`suspend()` 记下的原因）—— 界面
      //   直接印，不再自己编一句（见 panel.js 的 renderSnapshot）。
      suspended: this._suspended,
      // ★ 「这一次会话不是在真集群上跑的」。界面据此挂那条横幅与状态条标记。
      //
      //   判据是**后端身份**，不是"用户开着那个开关"—— `fake` 只可能由开发者模式
      //   进来（见 backend.js 的 createBackend），两者今天恒等；但开关是**要重启
      //   才生效**的，而界面手里那份开关状态可能是"刚改过、还没重启"。拿它去判的话，
      //   改了开关还没重启的那段时间里，界面会对着一个真集群说"这是假的"。
      dev: this.backend.kind === 'fake',
    };
    // 作业状态那一行**已经译好**，界面直接印。译法与理由是 jobstate.js 的事 ——
    // 放在主进程是因为界面那一侧没有测试（panel.js 在本机跑不起来），
    // 而这一句里有两处会静默说错话的地方（终态判定、Reason 的措辞）。
    snap.jobText = jobText(snap);
    // 资源那一行里的 GRES 部分同理：`gpu:a100 × 2` 这种写法在客户端只该有一处。
    snap.gresText = gresText(snap.resources && snap.resources.gres);
    return snap;
  }

  _emit() { this.emit('change', this.snapshot()); }

  // ── 推送 ────────────────────────────────────────────────────────────────
  /**
   * 订阅/退订后端的推送。
   *
   * ★★ **必须在拆的时候退订。** 一个后端服务着**所有**会话（见 index.js：整个
   *    进程一个 `backend`），而控制器是**会被换掉的**（`rec.controller = new ...`）。
   *    不退订的话，每换一次就多一个监听器，而它们全都还在写一个已经没人看的
   *    `this.session` —— 症状是内存慢慢涨，指不回任何一行。
   *
   * ★ 幂等：`start()` 之后可能再走一次 `_bringUpTunnel()`，重复订阅会让同一条
   *   推送被处理两次（于是 `_emit()` 也两次）。
   */
  _watchBackend(on) {
    if (typeof this.backend.on !== 'function') return;
    if (on && !this._watching) {
      this.backend.on('notify', this._onNotify);
      this._watching = true;
    } else if (!on && this._watching) {
      // `removeListener` 而不是 `off`：`off` 是 Node 10 才有的别名，
      // 而这里不该赌运行时的版本。
      this.backend.removeListener('notify', this._onNotify);
      this._watching = false;
    }
  }

  /**
   * 收到一条推送。
   *
   * ★★ 它只做两件事：**刷新视图**，以及**在实质变化时去要一份权威视图**。
   *    别的判定（终态、releasing、隧道重建、心跳交叉校验）一律留在
   *    `_statusOnce()` 里 —— 在这里重写一遍就是同一个状态机的第二份实现，
   *    而两份会漂，漂的方向是"某一条路忘了收隧道"这种静默的活锁。
   */
  _handlePush(msg) {
    if (this._stopped || !this.sessionId) return;
    // 排队那一段由 `_waitForEnroll()` 的轮询负责 —— 它自己有一组很细的错误分支
    // （会话不存在 / 已结束 / 配额 / 传输失败各有各的下场）。这里插一脚，两条路
    // 会同时改同一个状态。
    if (this.state !== State.RUNNING) return;

    this._lastPushAt = Date.now();
    if (typeof msg.seq === 'number') this._pushSeq = msg.seq;

    // ★ "我落后了几帧"由**守护进程**报（`stale`），不在这里按 seq 缺口自己推。
    //   那是同一个判据的第二份实现，而它的权威位置在 `enqueue_push`。
    if (msg.stale && msg.stale.dropped) {
      this.warning = `错过了 ${msg.stale.dropped} 条状态更新（控制节点侧发得太快），`
                   + '已直接采用最新的一份。';
    }

    const s = (msg.sessions || []).find((x) => x && x.session_id === this.sessionId);
    // ★★ **找不到不等于会话没了。**
    //   快照和 `list` 一样**截断到最近 50 条**，而那是**同一个 uid** 的全部会话 ——
    //   一个多开的用户完全可能排到 50 名之外。把它读成"会话没了"的后果是客户端
    //   自己拆掉隧道、界面上写"会话已不存在"，**而作业还在跑**。
    //   真没了的话 `_statusOnce()` 会给权威答案（它走 `status`，那一条不截断）。
    if (!s) return;

    const prev = this.session || {};
    // 这两个字段变了就必须去要一份**权威**视图：
    //   `state` —— 越过 ACL 边界意味着口令可能刚出现（排队 → 已登记）；
    //   `tunnel_target` —— 作业换了节点/端口，隧道要重建，而重建要用带口令的那一份。
    const escalate = s.state !== prev.state || s.tunnel_target !== prev.tunnel_target;
    this.session = mergeView(prev, s, { fromPush: true });
    this._checkHeartbeatLanded();
    if (escalate) { this._statusOnce(); return; }
    this._emit();
  }

  /**
   * 推送还在喂吗。
   *
   * ★ 反面就是"退回这一版之前的行为"，而那是**设计的一部分**，不是容错：
   *   一条推送都不来 ⇒ `_lastPushAt` 恒为 0 ⇒ 这里永远为假 ⇒ `STATUS_MS` 轮询
   *   照常跑。旧 CLI、老守护进程、SSH 常驻通道起不来，走的都是这一条。
   */
  _pushHealthy() {
    return this._lastPushAt > 0 && (Date.now() - this._lastPushAt) < this.pushStaleMs;
  }

  /**
   * 交叉校验：守护进程记的 `last_hb_at` 应该跟得上我们自己的心跳。
   * 落后太多说明心跳根本没落地（比如守护进程在写 DB 前崩了）——
   * 这条把一个纯静默的失败变成可见的告警。
   *
   * ★ 从 `_statusOnce()` 里抽出来，是因为**推送那份视图也带这个字段** ——
   *   把它留在一个只有轮询才走得到的地方，等于"推送健康时这条校验静默失效"，
   *   而它守的恰恰是最危险的那件事（作业会因为心跳不落地被自动 scancel）。
   */
  _checkHeartbeatLanded() {
    const s = this.session || {};
    if (!this._heartbeatAt || typeof s.last_hb_at !== 'number') return;
    const daemonAge = Date.now() - s.last_hb_at * 1000;
    if (daemonAge > HB_STALE_SLACK_MS) {
      this.warning = `控制节点记录的心跳已过期 ${Math.round(daemonAge / 1000)} 秒 —— `
                   + '心跳可能没有真正送达，会话可能被判定为断开。';
    }
  }

  _setState(st, extra = {}) {
    this.state = st;
    Object.assign(this, extra);
    this._emit();
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  /**
   * 提交并一路推到 running。
   *
   * @param {object} resources 高级选项里的**临时**覆盖：
   *   {cpus, mem, gres, partition, time}。`gres` 是结构化的描述符
   *   `{name, type, count}`（`type` 可空）—— **不是**一个数字：GRES 的名字
   *   与型号是管理员在集群上定的，可能是 `gpu:a100`，也可能是 `mps`。
   *   全部可选。**缺省由服务端填**（2 CPU / 8G / 从有权限的分区里随机挑一个）——
   *   默认值不由客户端填，否则一个改过的客户端省略字段就能要到整机。
   *   只传用户**真的填了**的键，不要用 undefined 覆盖服务端的默认值。
   * @param {object} opts { preferredPort, serviceKind, sshPubkey, portChoice }
   *   `portChoice` 是用户在「端口被占」那一行上答过的（`'shift'` = 临时换一个）；
   *   没问过就不传。见 `this._portChoice`。
   */
  async start(resources, opts = {}) {
    if (this.state !== State.IDLE && this.state !== State.ENDED && this.state !== State.ERROR) {
      throw new Error('会话已在进行中');
    }
    this._stopped = false;
    this.error = null;
    this.warning = null;
    // 上一个会话的推送水位不能带进这一个：留着的话，一条新会话可能在**还没有
    // 收到过任何推送**的时候就被判成"推送健康"，于是它的第一次对账要等满 60 秒。
    this._lastPushAt = 0;
    this._pushSeq = 0;
    this._requestedKind = opts.serviceKind || null;
    this._needsPubkey = Boolean(opts.needsPubkey);
    this._portChoice = opts.portChoice || null;
    this._setState(State.SUBMITTING);

    // 只带上真正有值的键。带 `cpus: undefined` 会让 JSON.stringify 直接丢掉它，
    // 但带 `cpus: null` 不会 —— 而服务端会把 null 当成「用户要了 0 核」。
    const req = { op: 'submit' };
    for (const k of ['cpus', 'mem', 'gres', 'partition', 'time']) {
      const v = resources && resources[k];
      if (v !== undefined && v !== null && v !== '') req[k] = v;
    }

    // 服务种类与公钥。**先校验再提交** —— 服务端也会校验（回 code 2），
    // 但走到那里已经花掉一次 sbatch 往返，而这里缺公钥只可能是调用方写错了。
    // 「要不要公钥」由调用方从插件元数据里取（`needsPubkey`），这里不认插件名。
    if (this._requestedKind) req.service_kind = this._requestedKind;
    if (this._needsPubkey) {
      if (!opts.sshPubkey) {
        this._setState(State.ERROR, {
          error: '内部错误：这个服务需要公钥，但调用方没有准备，已阻止提交。',
        });
        return null;
      }
      req.ssh_pubkey = opts.sshPubkey;
    }

    // ── 提交 ──
    let resp;
    try {
      resp = await withTimeout(
        this.backend.rpc(req),
        SUBMIT_TIMEOUT_MS);
    } catch (e) {
      // ★ 超时【绝不重试】。改为认领：调一次不带 session_id 的 status，
      //   看守护进程是不是其实已经建好了会话（响应丢了而已）。
      const claimed = await this._claim();
      if (claimed) {
        this.warning = '提交响应超时，但已在控制节点上找到刚创建的会话，继续接管。';
        return this._afterSubmit(opts);
      }
      this._setState(State.ERROR, {
        error: '提交超时且未能认领会话。请稍后用「查看状态」确认是否有多余作业，'
             + '或在控制节点上运行 squeue 检查。',
      });
      return null;
    }

    const c = classify(resp, { op: 'submit' });
    if (c.action !== Action.OK) {
      this._setState(State.ERROR, { error: c.message });
      return null;
    }

    // ★ 服务端替我们做了决定时必须说出来：截断了时间上限、把无法识别的内存
    //   换成了默认值、或者分区权限查不到因而交给了 Slurm 的默认分区。
    //   这些都不妨碍连上，但用户会以为自己要到了 —— 静默地替他决定，
    //   正是这个项目一路在清的那类问题。协议里 `warning` 这个字段存在的唯一
    //   理由就是被显示出来；不接它，它就只是一段写给读代码的人看的注释。
    if (resp.data.warning) this.warning = resp.data.warning;

    this.sessionId = resp.data.session_id;
    this._setState(State.QUEUED);
    return this._afterSubmit(opts);
  }

  /** 提交成功之后：等登记 → 开隧道 → 起心跳。 */
  async _afterSubmit(opts) {
    const ok = await this._waitForEnroll();
    if (!ok) return null;
    return this._bringUpTunnel(opts.preferredPort);
  }

  /**
   * 认领：不带 session_id 的 status 会返回该 uid 最新的活跃会话
   * （cluster/slurmate-sessiond:1699-1710）。用于「submit 响应丢了但会话其实建好了」。
   */
  async _claim() {
    try {
      const resp = await withTimeout(this.backend.rpc({ op: 'status' }), 20000);
      const c = classify(resp, { op: 'status' });
      if (c.action !== Action.OK) return false;
      const s = resp.data && resp.data.session;
      if (!s || !s.session_id) return false;
      this.sessionId = s.session_id;
      this._setState(State.QUEUED);
      return true;
    } catch {
      return false;
    }
  }

  /** 等待守护进程登记完成（tunnel_target 出现）。 */
  _waitForEnroll() {
    return new Promise((resolve) => {
      const poll = async () => {
        if (this._stopped) return resolve(false);
        const resp = await this.backend.rpc({ op: 'status', session_id: this.sessionId });
        const c = classify(resp, { op: 'status' });

        if (c.action === Action.OK) {
          const s = resp.data.session;
          if (!s) {
            this._setState(State.ERROR, { error: '会话在控制节点上已不存在。' });
            return resolve(false);
          }
          // ★ 走**同一个**合并入口，不直接赋值 —— 理由与下面那条注释同源：
          //   "一份会话视图怎么合进 `this.session`"这条规矩只该有一处实现。
          //   这一条轮询每 3 秒一次，而口令要等状态越过 ACL 边界才出现；
          //   直接赋值的话，一次读文件失败（NFS 抖动）就会把它抹掉，
          //   此后没有任何一条路会把它拿回来（登记完成之后轮询就停了）。
          this.session = mergeView(this.session, s, { fromPush: false });
          if (s.tunnel_target) {
            this._setState(State.RUNNING);
            return resolve(true);
          }
          if (!SERVER_LIVE_STATES.includes(s.state)) {
            this._setState(State.ERROR, {
              error: `会话已结束（${s.state}）` + (s.note ? `：${s.note}` : ''),
            });
            return resolve(false);
          }
          this._setState(State.QUEUED);
        } else if (c.action === Action.SESSION_GONE) {
          this._setState(State.ERROR, { error: '会话已不存在。' });
          return resolve(false);
        } else if (c.action === Action.QUOTA_OR_PERMISSION || c.action === Action.FATAL) {
          this._setState(State.ERROR, { error: c.message });
          return resolve(false);
        } else {
          // 传输层/守护进程不可达 —— 继续等，不要判定失败。
          // 这一段守护进程可能正在重启，而作业还在跑。
          this.warning = c.message;
          this._emit();
        }
        setTimeout(poll, this.queuedPollMs).unref?.();
      };
      poll();
    });
  }

  /**
   * 隧道起来了（或被顺移了），把**实际**端口告诉外面。
   *
   * ★ **只有没有工作区的会话要报。** 它的端口要写进**用户那份 ssh 配置**的
   *   `Port` 那一行 —— 那份配置必须在会话活着的每一刻都指向真值，而用户手上
   *   认的那个名字（别名）恒定，端口漂移对他无害。
   *
   * ★ **有工作区的会话什么都不做。** 那个数在工作区创建时就定下来了、此后只读；
   *   它的**实际**值在快照里（`snapshot().localPort` 与 `origin`），谁要用谁去读。
   *   ★ **不要把顺移后的端口写回 config.json**：那对这一次会话没有任何好处
   *   （端口一变 origin 就变、编辑器布局已经重置过了），却把一次**暂时**的冲突
   *   **永久化** —— 冲突消失之后 origin 也回不到最初那个，原来那份布局再也看不到了。
   *
   * ★ 判据是 `this.spaceId` **有没有**，不是"是哪个插件"。这两个条件今天恰好
   *   等价（跑在浏览器里的插件才要工作区），但前者是框架的事实，后者是一个
   *   插件名 —— 用名字判，加第三个插件时这里就得改。
   */
  _announcePort(port) {
    if (!this.spaceId) this.onRelayPort(port);
  }

  /** 建立隧道并开始心跳。 */
  async _bringUpTunnel(preferredPort) {
    const target = this.session.tunnel_target;
    const want = preferredPort || 18080;
    try {
      const { port, shifted } = await this.tunnel.start({
        preferredPort: want,
        target,
        excludePorts: this.getExcludedPorts(),
      });
      this._tunnelPort = port;
      this._lastTarget = target;
      this._announcePort(port);
      if (shifted && this.spaceId) {
        // 换端口意味着 origin 变了，浏览器存在 localStorage 里的编辑器布局会重置。
        // 用户有权知道为什么 —— 别让它变成一个「怎么布局又乱了」的谜。
        // ★ 没有工作区的插件不适用：那边没有浏览器，名字恒定，端口在底下漂移
        //   是无害的 —— 对它报"布局会重置"是一句纯粹的错误信息。
        //
        // ★ 末句是承重的：顺移**不写回**配置，所以首选端口没被改掉。占用它的是
        //   **这一次**的冲突，冲突一消失，下次启动就绑回原处、原来那份布局也跟着
        //   回来。不说这一句，用户会以为自己被永久搬走了。
        //
        // ★★ 中间那一句只在**没人问过**的时候出现，而它解释的是"为什么没问我"：
        //    正常的冲突在提交**之前**就探测到了（`startSession` 里那一次试绑），
        //    那时用户答的是「临时换」。走到这里还带着一句没答过的冲突，只可能是
        //    探测与绑定之间那个窗口 —— 那时作业已经在集群上了，「不启动」不是
        //    字面意思，所以只能顺移。不说这一句，用户会把一个**窗口**当成一条
        //    漏掉的询问。反过来，用户刚答过的那一趟说这句就是多余的。
        this.warning = `首选端口 ${want} 被占用，已改用 ${port}。`
                     + (this._portChoice === 'shift'
                       ? '' : '（这一处在作业提交之后才发现，所以没有问你。）')
                     + '由于浏览器按端口隔离本地存储，编辑器的布局与最近打开的文件会重置一次。'
                     + `首选端口没有被改掉：占用它的进程退出之后，下次启动会回到 ${want}，`
                     + '那份布局也还在。';
      }
    } catch (e) {
      this._setState(State.ERROR, { error: '建立隧道失败：' + e.message });
      return null;
    }
    this._setState(State.RUNNING);
    this._startHeartbeat();
    this._startStatusPoll();
    // ★ 订阅排在最后：`_handlePush` 只在 RUNNING 态做事，而上面那一行才把状态
    //   置成 RUNNING。反过来（先订阅后置态）会让排队期到达的推送白白丢掉一条，
    //   虽然无害，但"什么时候开始收推送"就成了一个要靠时序去推的问题。
    this._watchBackend(true);
    return this.snapshot();
  }

  // ── 换工作区（运行中）────────────────────────────────────────────────────
  /**
   * 只把本地监听挪到另一个端口。**不碰会话、不碰心跳、不发任何 RPC。**
   *
   * 这就是「运行中切换工作区」的全部机制：Slurm 作业、控制节点那边的 session、
   * sessionId、tunnel_target 全程不变 —— 变的只有浏览器这一侧的 origin 与存储分区。
   * 所以它是可断言的：切换前后 sessionId/state 不变，且 RPC 调用数增量为 0。
   *
   * **失败必须回滚**：先 stop 再 start，中间失败时用**空排除集**把原来的端口绑回来
   * （不能带原来的排除集 —— 里面含着自己旧工作区的端口，那会把它跳过）。
   * 回滚也失败就进 ERROR 态：绝不留在「状态是 running、实际没有监听」那种状态，
   * 那会让界面显示一切正常而页面根本打不开。
   */
  async relisten(newSpaceId, preferredPort, excludePorts) {
    const target = this.session && this.session.tunnel_target;
    if (!target) return { ok: false, error: '还没有隧道目标，无法切换工作区。' };
    const prevSpace = this.spaceId;
    const prevPort = this._tunnelPort;

    await this.tunnel.stop();
    try {
      const { port, shifted } = await this.tunnel.start({
        preferredPort, target, excludePorts });
      // ★ 换的是**这一次会话的** origin：`spaceId` 与 `_tunnelPort` 一起改，然后
      //   `_emit()` 把新的 origin 带出去。
      //   **不写回配置** —— 新工作区的端口是它**被创建时**定下来的那个
      //   （`config.js` 的 `assignSpacePorts`），顺移只是这一次的事。
      this.spaceId = newSpaceId;
      this._tunnelPort = port;
      this._emit();
      return { ok: true, port, shifted };
    } catch (e) {
      try {
        // 回滚：原来的端口和原来的工作区都放回去（同理，两样一起还原再 _emit）
        const back = await this.tunnel.start({ preferredPort: prevPort, target });
        this.spaceId = prevSpace;
        this._tunnelPort = back.port;
        this._emit();
      } catch (e2) {
        this._setState(State.ERROR, {
          error: `切换工作区失败，且原端口 ${prevPort} 也绑不回来了：${e2.message}。`
               + '作业未受影响，请重新连接。',
        });
        return { ok: false, error: e.message, fatal: true };
      }
      return { ok: false, error: e.message };
    }
  }

  /** 换一份数据。**只改标记与快照**，端口的挪动由 relisten 负责。 */
  setSpace(spaceId) {
    this.spaceId = spaceId;
    this._emit();
  }

  // ── 心跳 ────────────────────────────────────────────────────────────────
  /**
   * 打一次心跳。**定时器与显式调用走的是同一份实现**（见 `heartbeatNow`）。
   *
   * ★ 抽出来而不是让 `heartbeatNow` 自己再发一次请求：那会是"心跳"这条规矩的
   *   第二份实现，而它漂开的方向很具体 —— 显式那一次不更新 `_heartbeatAt`、
   *   不认 `SESSION_GONE`、也不写 warning，于是界面在接管之后显示的是
   *   一句和真实情况不符的话（"心跳正常"或"心跳一直失败"）。
   */
  async _beat() {
    // ★★ 被接管的会话**一拍都不发**，这道闸与 `_stopped` 并列。
    //
    //   它守的是"接管"这件事的**收尾**：`suspend()` 会把定时器停掉，但
    //   `heartbeatNow()` 是一条**显式**的路（`app:takeover` 会调它），而显式的路
    //   绕过定时器。少了这道闸，一个已经放手的会话会拿着**本机的身份**去问一次
    //   "我还在看吗"—— 服务端只能回 `ignored`，于是那句话在接管成功的同一条路径上
    //   又变回"被接管"，而界面上刚刚才说过"已接管"。
    //
    //   ★ 回来那条路是 `resume()`（`app:takeover` 成功之后调它），**不是**在这里
    //     悄悄放行 —— "我不再是看护者"与"我又成了看护者"是两件事，各有各的入口。
    if (this._stopped || this._suspended || !this.sessionId) return;
    const resp = await this.backend.rpc({ op: 'heartbeat', session_id: this.sessionId });
    const c = classify(resp, { op: 'heartbeat' });
    if (c.action === Action.OK) {
      // ★★ 服务端说「这一拍没有算数」。那是**另一件事**，不是成功 —— 而它挂在
      //    `ok:true` 上（见 `op_heartbeat` 的 docstring：心跳不是一条会让客户端
      //    重试的请求，所以拒绝时回 `ok` 带一个 `ignored`，而不是回错）。
      //
      //    ★ 判据是 `ignored` 那一格**在不在**，不是它等于什么：它在，就说明
      //      这一次心跳**没有续上命**，于是 `_heartbeatAt` 一个字节都不能推进。
      //      推进它等于本机自己宣称"我在看着"，而服务端刚刚说了不是 —— 那句假话
      //      会一路传到界面上（"上次心跳 3 秒前"），而真相是这条会话已经不归
      //      本机管了。
      //
      //    ★ `not_keeper` 是唯一有确定含义的取值：**另一台电脑接管了它**。这是
      //      客户端认出「我被接管了」的**唯一**信号 —— 守护进程刻意没有为此发明
      //      一条推送，因为"谁在看"是会话行上的一格，而这一格变了只有正在心跳的
      //      那个人问得出来。
      //
      //    ★ 认不出来的取值**原样印出来**，不猜（与 sessionstate.js 同一条纪律）。
      //      猜成"接管了"会让本机白白放弃一条其实还归自己的会话；猜成"没事"则会
      //      把一句服务端明说了的话咽掉。
      const ign = resp.data && resp.data.ignored;
      if (ign) {
        if (ign === 'not_keeper') this.suspend(SUSPENDED_TAKEN_OVER);
        else {
          this.warning = `心跳被服务端忽略了（${ign}），本机可能不再看护这条会话。`;
          this._emit();
        }
        return;
      }
      this._heartbeatAt = Date.now();
      if (this.warning && /心跳/.test(this.warning)) this.warning = null;
    } else if (c.action === Action.SESSION_GONE) {
      // 会话没了，心跳没有意义了。**但不能因此判定作业已停** —— 只报告事实。
      this._stopHeartbeat();
      this.warning = '控制节点上已找不到该会话，心跳停止。';
    } else {
      // 传输层失败 / 守护进程不可达：**继续重试，绝不放弃**。
      // 这一段正是 300 秒闪断窗口要覆盖的情况。
      this.warning = '心跳发送失败（' + c.message + '），仍在重试。';
    }
    this._emit();
  }

  /**
   * **立刻**打一次心跳，不等下一个 45 秒。
   *
   * ★ 它存在的理由只有一个：**接管**。守护进程那边刻意没有在 `op_takeover` 里
   *   顺手刷新 `last_hb_socket` —— "接管只动一格"是一条不变量（见那个 op 的
   *   docstring）。代价是"在 1800 秒大限前 40 秒才点接管"有一个窄窗口，而那一半
   *   补在**这里**：接管成功之后立刻表态一次。
   *
   * ★ 定时器没起来时也照打。这一条不是"续期"，是"这台电脑现在做主"的第一次表态；
   *   而"没起来"的场合恰好就是最需要它的那一种（刚从别的电脑手里接管过来）。
   */
  heartbeatNow() { return this._beat(); }

  _startHeartbeat() {
    if (this._hbTimer) return;                    // 幂等：绝不允许同一个会话有两个心跳
    this._hbTimer = setInterval(() => { this._beat(); }, this.heartbeatMs);
    this._hbTimer.unref?.();
    this._beat();                  // 立刻打一次，别等 45 秒
  }

  _stopHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
  }

  // ── 状态对账 ────────────────────────────────────────────────────────────
  /**
   * 那个定时器。
   *
   * ★★ 它是**对账的钟**，不是对账本身 —— 推送健康的时候它什么都不做，
   *    而在推送不来的时候（旧 CLI / 老守护进程 / 通道断了）它每一轮都照问不误，
   *    与这一版之前逐字相同。
   */
  _startStatusPoll() {
    if (this._statusTimer) return;
    const tick = () => {
      if (this._stopped || !this.sessionId) return;
      if (this._pushHealthy()) return;
      this._statusOnce();
    };
    this._statusTimer = setInterval(tick, this.statusMs);
    this._statusTimer.unref?.();
  }

  /**
   * 问一次 `status` 并把结果落到状态机上。
   *
   * ★ 由**两处**触发：那个定时器（推送不来时），以及一条**实质变化**的推送
   *   （见 `_handlePush`）。两条路进的是同一个函数，判定只有这一份。
   */
  async _statusOnce() {
    if (this._stopped || !this.sessionId) return;
    // ★ 同一时刻只许有一次。两条同时在飞的 status 各写一遍 `this.session`，
    //   而它们回来的**顺序没有保证** —— 后回来的那条可能是更旧的一份。
    //   （定时器那条本来就串行；这一条是为推送触发的那条加的。）
    if (this._statusBusy) return;
    this._statusBusy = true;
    try {
      const resp = await this.backend.rpc({ op: 'status', session_id: this.sessionId });
      const c = classify(resp, { op: 'status' });

      if (c.action === Action.OK) {
        const s = resp.data.session;
        if (s) {
          // ★ 合并的方向：**新的一份说了算，除了它没说的那些键**。
          //   口令只在 ACL_STATES 才返回，而一次 `load_session_file` 失败（NFS 抖动）
          //   也会让它缺席 —— 那不能当成"口令没了"。规则只有一份，见 mergeView()。
          this.session = mergeView(this.session, s, { fromPush: false });

          // tunnel_target 变了（作业重启换了节点/端口）→ 重建隧道。
          // 不做这件事的表现是**页面卡住、没有任何报错**。
          if (s.tunnel_target && s.tunnel_target !== this._lastTarget) {
            this.warning = `隧道目标已变更（${this._lastTarget} → ${s.tunnel_target}），正在重建。`;
            this._lastTarget = s.tunnel_target;
            const prevPort = this._tunnelPort;
            try {
              await this.tunnel.stop();
              // ★ 必须**接住返回值**。丢掉它的后果是 this._tunnelPort 停在旧值，
              //   于是 snapshot().localPort 从此指向一个没人监听的端口 ——
              //   界面上「本地地址」那一栏是死的，而没有任何报错。
              const { port, shifted } = await this.tunnel.start({
                preferredPort: prevPort, target: s.tunnel_target,
                excludePorts: this.getExcludedPorts() });
              this._tunnelPort = port;
              // 端口顺移**不写回配置**（理由见 `_announcePort`）。这里只把**实际**
              // 端口告诉需要它的那一位 —— 没有工作区的会话（它的 ssh 配置里那行
              // `Port` 必须反映当前真值）；有工作区的会话什么都不用做，实际值在快照里。
              this._announcePort(port);
              if (shifted && this.spaceId) {
                this.warning = `隧道重建时端口 ${prevPort} 被占用，已改用 ${port}。`
                             + '浏览器按端口隔离本地存储，编辑器布局会重置一次。'
                             + `首选端口没有被改掉：冲突消失之后，下次启动会回到 ${prevPort}。`;
              }
            } catch (e) {
              this.warning = '隧道重建失败：' + e.message;
            }
            this.emit('retarget', this.snapshot());
          }

          if (SERVER_FINISHED_STATES.includes(s.state)) {
            this._stopHeartbeat();
            this._stopStatusPoll();
            // ★ 会话结束了，本地监听必须一起收掉。留着它的后果不是「多占一个端口」：
            //   浏览器仍然连得上本地端口，却会被 dial 接到一个已经不存在的目标上 ——
            //   表现是「页面打不开，但也不报错」。端口只在 stop() 里释放是不够的，
            //   会话被守护进程回收（超时、孤儿、被拒）时根本不会走到 stop()。
            await this.tunnel.stop();
            this._setState(State.ENDED);
            return;
          }
          if (s.state === 'releasing') {
            this._stopHeartbeat();          // 已在释放，心跳没有意义了
            this._setState(State.RELEASING);
            return;
          }

          this._checkHeartbeatLanded();
        }
      } else if (c.action === Action.SESSION_GONE) {
        this._stopHeartbeat();
        this._stopStatusPoll();
        await this.tunnel.stop();     // 同上：会话都没了，监听没有理由留着
        this._setState(State.ERROR, { error: '会话已不存在。' });
        return;
      } else if (![Action.DAEMON_DOWN, Action.TRANSPORT, Action.RATE_LIMITED].includes(c.action)) {
        this.warning = c.message;
      }
      this._emit();
    } finally {
      // ★ 放在 `finally` 里：上面有好几条 `return`（终态、releasing、会话没了），
      //   漏掉任何一条的后果都是**对账从此彻底停摆** —— 而界面上一切正常。
      this._statusBusy = false;
    }
  }

  _stopStatusPoll() {
    if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }
  }

  /**
   * 取这个会话的作业日志尾部。**只读** —— 它不动状态机、不改任何字段。
   *
   * ★ 它**不走 `classify()`**：那个函数是给会话生命周期那四个 op（submit /
   *   status / heartbeat / goodbye）用的，它的清单是"这四种之下的动作"。把一个
   *   只读展示塞进去，那条清单就走了样 —— 而走了样的清单比没有更坏（下一个人会
   *   照着它去 classify 一个不该进来的 op）。
   *
   * ★★ 老守护进程没有这个 op ⇒ **能力缺席，不是失败**：回一句 `unsupported`，
   *   界面据此禁用那一块并说明，**不重试**（与 `backend-ssh.js` 对 `ping` 的
   *   处理同源：`unknown_op` 说的是"对面没有这个功能"，不是"这一次没成"）。
   */
  async jobLog(lines) {
    if (!this.sessionId) return { ok: false, error: '这条会话还没有登记。' };
    const req = { op: 'job_log', session_id: this.sessionId };
    if (lines) req.lines = lines;
    let resp = null;
    try {
      resp = await this.backend.rpc(req);
    } catch (e) {
      return { ok: false, error: (e && e.message) || '没有回应' };
    }
    if (resp && resp.ok && resp.data) return { ok: true, data: resp.data };
    const err = (resp && resp.error) || {};
    if (err.kind === 'unknown_op') {
      return { ok: false, unsupported: true,
               error: '这个站点的守护进程还没有"看作业日志"这个能力（升级之后才有）。' };
    }
    return { ok: false, error: err.detail || err.kind || '控制节点没有说明原因' };
  }

  // ── 停止 ────────────────────────────────────────────────────────────────
  /**
   * **只释放本地资源，一个字都不发给服务端。**
   *
   * ★ 这不是给用户的第二条路 —— 界面没有"只关窗口、作业继续跑"这一项
   *   （见下面 stop() 的说明）。它只有一个用处：**模拟客户端重启**。
   *
   *   真机上重启时这个进程整个没了，它的监听套接字、轮询、心跳跟着一起消失；
   *   而测试是在**同一个进程里**把 controller 换掉，不显式关掉旧的那份资源，
   *   模拟出来的现场就变成了**两个客户端同时在跑**：旧的那个还占着一个端口在
   *   监听、还在轮询状态，收尾时进程退不掉（表现为整个测试文件多花几十秒）。
   */
  async abandon() {
    this._stopped = true;
    this._stopHeartbeat();
    this._stopStatusPoll();
    this._watchBackend(false);
    await this.tunnel.stop();
  }

  /**
   * 这条作业**被另一台电脑接管了**：停下本机的一切，一个字都不发给服务端。
   *
   * ★★ 这个方法存在的全部理由是**那一条不能发出去的 `goodbye`**。
   *
   *    收尾流程（`stop()`）会给守护进程发 `goodbye`，而 `goodbye` 会让
   *    `phase_release` 删掉 ACL **并 scancel 作业**。被接管的那台如果照常
   *    收尾 —— 关窗、点断开、或者只是退出 —— 用户的作业就没了，而用户以为
   *    自己只是**换了个地方看**。
   *
   *    守护进程那一侧堵不住：它按 `session_id` 记账，**分辨不了那个 `goodbye`
   *    是接管者发的还是被接管的那台发的**。所以只能在客户端这一半堵，
   *    而堵法就是"根本不进收尾流程"（另见 `stop()` 顶部的那道闸）。
   *
   * ★ 与 `abandon()` 只差一处，而那一处是承重的：`abandon` 拆隧道，这里
   *   **不拆**。用户此刻可能正开着那个页面看着东西 —— 拆掉隧道等于把"换个地方
   *   看"变成"这边的东西全没了"，而作业还在集群上跑着。
   *
   * ★★ 触发它的是**心跳的应答**（`ignored: not_keeper`，见 `_beat()`），不是一条
   *    推送。
   *    ★ 它是**逐会话**的：同一台电脑上另一条作业被别人接管了，不影响
   *      这一条 —— 而"整台电脑被一条 uid 顶掉"那种形状做不到这件事。
   *
   * ★ **「临时离开」不走这里。** 两者的效果看着像（都停下心跳、都不发 goodbye），
   *   但离开之后本机**连记录都不留**（用户已经回列表了、页面也拆了），而这里
   *   留着记录、留着隧道 —— 因为用户可能还开着那个页面在看。见 index.js 的
   *   `app:leave`。
   */
  suspend(reason) {
    if (this._suspended) return;                 // 幂等：只记第一条原因
    this._suspended = reason || SUSPENDED_TAKEN_OVER;
    this._stopHeartbeat();
    this._stopStatusPoll();
    this._watchBackend(false);
    this.warning = this._suspended;
    this._emit();
  }

  /**
   * 把这条会话**重新拿到手上** —— 【接管】成功之后走的那一步。
   *
   * ★★ 少了它，「接管」会变成一句假话：`suspend()` 是一个**终态**（`_beat()` 顶上
   *    有一道闸），而接管成功意味着服务端那一格**已经换成本机**了。不撤销它的话，
   *    界面会一直说"已被另一台电脑接管"、心跳一直不发 —— 而用户刚刚看到一句
   *    「已接管」。★ 而心跳不发这件事的代价不是"少几个字"：1800 秒之后，那条
   *    作业会被当作没人看护而 `scancel` 掉，界面上仍然写着"已接管"。
   *
   * ★ 四样一起开回来，与 `suspend()` 停掉的四样**一一对应**：心跳、对账、订阅，
   *   以及那句原因。少开任何一样的症状都是静默的（少了对账 ⇒ 剩余时间永远停在
   *   接管那一刻，而那个数看起来完全正常）。
   *
   * ★ 这里**不拆也不建隧道**：`suspend()` 特意没拆（用户可能还开着那个页面在看），
   *   于是接管回来时它还在。这与"接管一个字都不动会话"是同一条纪律的延伸。
   */
  resume() {
    if (!this._suspended) return;
    const why = this._suspended;
    this._suspended = null;
    // 只清**这一句**：别的原因（隧道断了、心跳失败）还站着，一并清掉就是替用户
    // 把一句仍然成立的话咽下去。
    if (this.warning === why) this.warning = null;
    this._watchBackend(true);
    this._startStatusPoll();
    this._startHeartbeat();
    this._emit();
  }

  /**
   * 结束会话并释放资源。**只有一个语义：彻底终止。**
   *
   *   保留一条「不释放」的路径，前提是它能被可靠地触发在正确的时机上。而它不能：
   *   真正需要保住作业的情形是**客户端没能说上话** —— 断电、睡眠、网线被拔、
   *   进程被 kill -9。那些情况下根本没有代码会跑到这里来，这条分支在里面
   *   一次都不会被用到；反过来，能被它命中的只有「用户明确表达了终止意图」。
   *   于是它成了纯粹的误伤面：用户点了关闭或断开，作业却留在集群上继续占着
   *   12 小时的资源，而界面上什么都没有。
   *
   *   意外消失那条路径由守护进程的 suspect(300s)/orphaned(1800s) 容错窗口覆盖
   *   （见文件头第 1 条），客户端再提供一个「主动保活」的开关是多余且有害的。
   */
  async stop() {
    // ★★ 被接管的会话**绝不进收尾流程** —— 这道闸放在这里（而不是只放在调用方
    //    `stopAllSessions` 里），是为了让保证跟着**数据**走而不是跟着**调用点**走：
    //   下一个"顺手加"的收尾入口不该有机会绕过它。
    //   为什么不发：见 `suspend()` —— 那个 `goodbye` 会把用户的作业 scancel 掉，
    //   而用户以为自己只是换了个地方看。
    if (this._suspended) {
      return { ok: false, state: 'suspended',
               detail: this._suspended + '本机没有发送释放请求，作业仍在运行。' };
    }
    this._stopped = true;
    this._stopHeartbeat();          // ★ 必须在 goodbye 之前停。
    this._stopStatusPoll();         //    否则残留心跳收到 code:3 会被误判成出错。
    this._watchBackend(false);      // ★ 同上：释放期的推送会写一个没人再看的状态。

    await this.tunnel.stop();

    if (!this.sessionId) {
      this._setState(State.ENDED);
      return { ok: true, state: 'ended', detail: '没有进行中的会话。' };
    }

    let resp;
    try {
      resp = await withTimeout(
        this.backend.rpc({ op: 'goodbye', session_id: this.sessionId }), 10000);
    } catch (e) {
      this._setState(State.ENDED);
      return {
        ok: false, state: 'unknown',
        detail: '会话未释放：' + e.message
              + '。作业可能仍在运行，将在约 31 分钟后被自动回收，期间持续占用节点。',
      };
    }

    const c = classify(resp, { op: 'goodbye' });
    if (c.action === Action.OK) {
      // ★ `ok:true` 仍然**不等于**作业真的被取消了 —— 它等于"这一次 scancel
      //   发出去了、会话进了 releasing"。守护进程现在会一直重试到确认作业消失
      //   为止（`phase_release` 的闸），所以这里能说的是"已请求释放"。
      // ★ 而服务端**说得出**"这一次没成功"（协议里的 `warning`，账本 F12）
      //   —— 它必须被显示：用户会以为作业停了，而它可能还在烧 GPU。
      const w = resp.data && resp.data.warning;
      if (w) this.warning = w;
      this._setState(State.RELEASING);
      return { ok: true, state: 'releasing',
               detail: w ? ('已请求释放。' + w) : '已请求释放，等待控制节点确认。' };
    }
    if (c.action === Action.SESSION_GONE) {
      this._setState(State.ENDED);
      return { ok: true, state: 'gone', detail: '会话在控制节点上已不存在。' };
    }

    this._setState(State.ENDED);
    return {
      ok: false, state: 'unknown',
      detail: '释放失败：' + c.message
            + '。作业可能仍在运行，将在约 31 分钟后被自动回收。',
    };
  }

}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`超时（${ms}ms）`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// ★ `HEARTBEAT_MS` 删了：它只是构造函数的**缺省值**（`heartbeatMs || HEARTBEAT_MS`），
//   而用例要调心跳节奏时走的是构造参数，不是这个常量。
module.exports = { SessionController, State, STATUS_MS, QUEUED_POLL_MS, SUBMIT_TIMEOUT_MS,
  SERVER_LIVE_STATES, SERVER_FINISHED_STATES, PUSH_STALE_MS, PUSH_ABSENT_KEYS };
