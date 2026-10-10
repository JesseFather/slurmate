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
 * panel.js —— 面板页逻辑。
 *
 * 面板有四种形态，由 session:state 驱动切换：
 *   登录节点 → 开始会话 → 会话进行中 → 结束/错误
 *
 * ★ 登录节点这一屏的第一眼必须是**已保存的连接** —— 用户每次打开客户端要做的事
 *   是「连上上次那台」，不是「再填一遍地址」。公钥和地址表单折进「新建连接」里，
 *   那是第一次使用时才走一遍的流程。
 *
 * ★ 密钥是**按连接**的（见 main/config.js）。所以「新建」与「编辑」共用同一块表单，
 *   各自展现自己那一把钥匙：新建时是刚生成、还没有归属的那把，编辑时是这条连接的
 *   那把。界面上没有「全局密钥」这个概念 —— 重新生成只影响当前这一条。
 *
 * ★ 地址栏永远不预填。预填上一个连接的地址，用户不改直接点保存，得到的只是
 *   「又存了一条一样的」，而他以为自己新建了一条。
 *
 * ★ 「开始会话」那一段**一个插件名都不写**：站点装了哪些、本机认得哪些，都是
 *   运行期才知道的（见 renderPlugins）。写死的话，「站点卸掉一个插件」在界面上
 *   就变成了"点了报错"，而不是"那一块不见了"。
 *
 * 会话跑起来之后窗口主体会被插件声明的那块界面整个盖住，
 * 所以「重新加载 / 结束会话」这两个必需的操作也放在状态条里 ——
 * 那是唯一始终可见的、属于我们自己的区域。
 *
 * ★ 这个界面里**没有**任何「打开配置文件」的入口，这是有意的：
 *   所有条目都在界面上，用户不该为了改一个地址去手编辑 JSON。
 */

const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
  idle: '未开始',
  submitting: '正在提交…',
  queued: '排队中',
  running: '运行中',
  releasing: '正在释放…',
  ended: '已结束',
  error: '出错',
};

let boot = null;
let connected = false;
let whoami = null;
let lastProbe = [];          // 最近一次探测结果，供连接列表显示
let lastSnap = null;         // **前台**那一条的快照，供状态条与工作区选择器读它
let SESS = { sessions: [], front: null };   // 全部会话 + 哪一个是前台（见 renderSessions）
/**
 * 最近一次的插件清单。界面里有**两处**需要知道"这个会话的插件声明了界面没有"，
 * 而快照本身是插件无关的（session.js 不认识任何插件）—— 所以在这里留一份，
 * 按 `serviceKind`（站点短名）去查。
 */
let lastPlugins = null;

/** 工作区下拉里「新建一个空白工作区」那一项的值。不是工作区 id，别混。 */
const NEW_WORKSPACE = '__new__';

/**
 * 插件块那个「用哪一份数据」下拉里「另开一份」那一项的值。同样不是数据 id。
 *
 * ★ 它**不能**用一个空串代替：「空串」在下拉里是"这一格还没有值"（跟随默认），
 *   而这里要的是"**另开一份**，哪怕现在已经有一份" —— 两件事，两种值。
 *   混起来的症状是用户点了「＋ 新建一份」却什么都没发生（见下面那个兜底那段）。
 */
const NEW_SPACE = '__new_space__';

/**
 * 「新建／编辑」表单的状态。
 *   mode='new'  → 展示那把还没有归属的密钥（新建时生成的）
 *   mode='edit' → 展示 id 指向的那条连接的密钥
 * id 始终是「当前正在编辑哪条连接」，新建时为 null —— 它是保存时告诉主进程
 * 「改哪一条」的唯一依据，搞错就会把 A 的地址写到 B 头上。
 */
let form = { open: false, mode: 'new', id: null };

/**
 * 现在在哪一屏：`'conns'` | `'plugins'` | `'jobs'`。
 *
 * ★★ 它是一个**用户的选择**，不是从会话状态推出来的。按会话状态算显隐的话
 *   （空闲就露连接列表、跑起来就露当前会话），"用户在哪儿"就没有地方记着 ——
 *   他去作业列表看一眼，下一次快照回来就被弹回另一屏。这一格就是为此存在的。
 */
let SCREEN = 'conns';

/**
 * 第三屏（作业列表）的那一份数据。
 *
 * ★ `forConn` 是**这份数据属于哪条连接** —— 切连接之后它立刻作废。少了这一格，
 *   用户切到另一个站点、还没刷新时会看到**上一个站点**的作业列表，而每一行
 *   看起来都像真的。这是这一屏唯一会静默说谎的地方。
 */
let JOBS = { forConn: null, list: null, at: 0, error: null, selected: null };

// ── 工具 ────────────────────────────────────────────────────────────────────
function fmtLeft(expiresAt) {
  // expires_at 在 show_job 失败时**整个字段不存在**（守护进程的行为）。
  // 必须显示「未知」，而不是 0 或 NaN —— 后者会让人以为会话要到期了。
  if (typeof expiresAt !== 'number') return '未知';
  const left = expiresAt - Math.floor(Date.now() / 1000);
  if (left <= 0) return '已到期';
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
  return `${h} 小时 ${m} 分`;
}

function fmtAge(ms) {
  if (typeof ms !== 'number') return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  return `${Math.round(s / 60)} 分钟前`;
}

function notice(kind, text) {
  const box = $('notices');
  const el = document.createElement('div');
  el.className = 'notice ' + kind;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = { ok: 'OK', error: '错误', warn: '注意', info: '信息', dev: '开发' }[kind] || kind;
  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = text;              // textContent：绝不把外部文本当 HTML 插进去
  el.append(tag, body);
  box.prepend(el);
  while (box.children.length > 80) box.lastChild.remove();
}

// ── 两段式确认 ──────────────────────────────────────────────────────────────
/**
 * 当前正处在第一段的那个确认。**同时只允许一个** —— 界面上摆着两行"确定吗"，
 * 用户按了其中一行那颗按钮，另一行还挂在那儿，而他分不清刚才确认掉的是哪个。
 */
let armed = null;

/**
 * 两段式：第一次点只是**把那一格换成一行确认**，第二次点才真的做。
 *
 * ★★ 为什么不可逆的动作不能用 `window.confirm`：它给不了两段 —— 框弹出来的
 *   时候用户**已经按下去**了，而这里要的正是"按下去之后还有一次可退的机会"。
 *   它的样式也不受控（在 Electron 里那是一块系统窗口，尺寸、语言、焦点行为都不
 *   归我们管），于是同一个客户端里几处不可逆动作会长得不一样。
 *
 * ★ 第一段**可退**：点到别处、按 Esc、点「取消」，都回到原样。不可逆的只有第二段。
 * ★ 原来那颗按钮**留在 DOM 里**（加一个 `.armed-off`），不删 —— `renderSnapshot`
 *   还在按 `running` 去 toggle 它的 `hidden`，删掉的话那是作用在 null 上。
 *
 * @param {HTMLElement} anchor 那一格的按钮
 * @param {{why?: string, yes: string, run: () => any, onDisarm?: () => void}} opts
 *   `why` 是**后果**，不是解释：设计律 2 要的是"把警告变成动作的前置状态"。
 *   `onDisarm` 只在**退回去**的时候跑（点别处 / Esc / 点「取消」/ 被后来那一次
 *   顶掉 / 重画之前收起），**第二段执行时不跑** —— 那一格已经被改动了，
 *   "拨回旧值"会让界面说一件没发生的事。见切走工作区那一条（下拉停在待定的新值上，
 *   退回去才拨回来）。
 */
function armConfirm(anchor, opts) {
  disarmArmed();
  const cluster = document.createElement('span');
  cluster.className = 'armed';
  if (opts.why) cluster.append(el('span', 'armed-why', opts.why));
  const go = el('button', 'danger tiny', opts.yes);
  const no = el('button', 'ghost tiny', '取消');
  cluster.append(go, no);

  const here = {};
  /** @param {boolean} [acted] 第二段真的执行了 —— 那时**不**跑 `onDisarm`。 */
  const disarm = (acted) => {
    if (armed !== here) return;         // 已经被后来那一次顶掉了，别把它的界面收掉
    armed = null;
    document.removeEventListener('click', outside, true);
    document.removeEventListener('keydown', onKey, true);
    cluster.remove();
    anchor.classList.remove('armed-off');
    if (!acted && opts.onDisarm) opts.onDisarm();
  };
  // ★ 捕获阶段，而且判的是"点在不在这一行里面"：用户点到别处时他心里想的是
  //   "算了"，那一下不该**顺带**触发别的东西（他已经在收手了）。
  const outside = (ev) => { if (!cluster.contains(ev.target)) disarm(); };
  const onKey = (ev) => { if (ev.key === 'Escape') disarm(); };

  // 第二段：先把这一行收掉再执行 —— 执行里可能又把界面整个重画一遍。
  go.onclick = () => { disarm(true); return opts.run(); };
  no.onclick = () => disarm();

  here.disarm = disarm;
  armed = here;
  anchor.classList.add('armed-off');
  const parent = anchor.parentNode;
  if (parent) parent.insertBefore(cluster, anchor.nextSibling || null);
  document.addEventListener('click', outside, true);
  document.addEventListener('keydown', onKey, true);
  if (go.focus) go.focus();
}

/** 把可能正开着的那个第一段收掉。重画一个会被它改动的区域之前调。 */
function disarmArmed() {
  if (armed) armed.disarm();
}

// ── 三屏的路由 ──────────────────────────────────────────────────────────────
/**
 * 把三屏之一露出来。**同时只露一个。**
 *
 * ★★ 为什么"我在哪一屏"必须是一个显式的状态：这三屏是**一个站点的三个层次**
 *   （连接 → 插件 → 作业），而"在哪一层"取决于用户刚才点了什么，不取决于
 *   会话此刻是什么状态。按后者判的话（`idle` 露连接列表、跑起来露当前会话），
 *   用户点进作业列表看一眼，下一次快照回来就被弹回另一屏——而他什么都没做。
 *
 * ★ **站点状态不在这里**：它从边栏的浮窗里看（`hover.html`）。从前它是一个盖在
 *   三屏上面的节（`#sec-cluster`），于是同一份 `op_cluster` 的答案有两个落点 ——
 *   浮窗接手之后那个节整个删掉，不留第二份渲染。
 */
function showScreen(name) {
  SCREEN = name;
  for (const [key, id] of [['conns', 'screen-conns'],
                           ['plugins', 'screen-plugins'],
                           ['jobs', 'screen-jobs']]) {
    $(id).classList.toggle('hidden', key !== name);
  }
  // 离开第一屏就把那个表单收掉 —— 它只在「还没连上」那一屏里说得通（判据是
  // "用户走开了"，不是"会话跑起来了"）。不收的话，用户从第二屏退回来会看见一个半填的表单，
  // 而它上面那个地址可能已经连过了。
  if (name !== 'conns') closeForm();
  // 第二屏的标题带上**是哪一个站点** —— 用户在几台机器之间来回时，最要紧的
  // 一件事就是"我现在看的是哪一台"。
  // ★ 判据是**活跃连接**（主进程那一格），不是"上次点了哪一行"：删掉一条连接、
  //   或者从别处改了活跃连接之后，界面手上那份"我刚才点的是谁"就已经过期了。
  const conn = ((boot && boot.connections) || [])
    .find((c) => c.id === (boot && boot.activeConnectionId));
  $('plugins-title').textContent = conn ? `插件 · ${conn.user}@${conn.host}` : '插件';
  // 屏一换，那些**跟着当前这一屏走**的小块都要重算一次：作业详情（只在这一屏里
  // 露）、映射图的连线（几何，元素刚露出来的那一帧还没定下来）。都交给
  // `renderSnapshot` 那一份判据 —— 在这里另判一遍就是两份，而它们会漂。
  renderSnapshot(lastSnap);
  if (name === 'jobs') refreshJobs();
}

/**
 * 主进程推来的**全部**会话 + 哪一个是前台。
 *
 * ★ 面板这一层只需要"画哪一条"（`renderSnapshot` 照旧只画前台那一条），而
 *   **决定权在主进程**（`index.js` 的 `frontSlot()`）—— 界面这里一个字都不推。
 *   推的话就多了一个会漂的"当前会话"，而它的失败形态是"点结束会话，停掉的是另一条"。
 */
function renderSessions(payload) {
  const p = payload || {};
  SESS = {
    sessions: Array.isArray(p.sessions) ? p.sessions : [],
    front: p.front || null,
  };
  renderTabs();
  // ★ 右栏那个点跟着"有没有作业在跑"走，而那个判据刚刚才更新 —— 所以它必须在
  //   `SESS` 写完之后算（放在 renderTabs 之前会让它慢一拍，而"慢一拍"的表现是
  //   作业起来了右边那个点却要等下一次推送才亮）。
  renderRails();
  renderSnapshot(frontSnap());
}

/** 前台那一条的快照（没有会话时 null）。 */
function frontSnap() {
  const hit = SESS.sessions.find((x) => x.slot === SESS.front);
  return (hit && hit.snap) || null;
}

/**
 * 前台那一条**是不是临时实例**（第二份、数据是一份副本、会话结束就没了）。
 *
 * ★ 判据由主进程给（`index.js` 的 `sessionViews` 里的 `temporary`），界面这一层
 *   **一个字都不推** —— 它不掌握"哪一份是持有者"这件事，猜的话就会在回收之后
 *   还告诉用户"这里不会记录你的改动"（或者反过来，让用户以为改动留下了）。
 *
 * ★ 它不是一个瞬时通知，而是一条**常驻**状态：只要那一份还开着，这句话就成立。
 *   所以问的是"前台那一条现在是什么"，而不是"刚才发生过什么"。
 */
function frontTemporary() {
  const hit = SESS.sessions.find((x) => x.slot === SESS.front);
  return Boolean(hit && hit.temporary);
}

/**
 * 状态条底下那一排标签。**一条会话一个**。
 *
 * ★ 只在**两条以上**时露出来：一条的时候它不提供任何选择，只占掉一行地方。
 * ★ 每一条都要能点 —— 那是"我还能切回去"的唯一入口。前端那条加一个 class。
 *
 * ★★ **标签重名时要补一个区分符。** 标签上写的是插件的显示名，而**同一个插件
 *    开两份**（`contributes.concurrent: true`，第二份拿到自己的临时数据 = 自己的
 *    槽）是完全合法的一件事 —— 那时顶栏上会出现两个一模一样的标签，而它们指着
 *    两份不同的数据、两个不同的本地端口。用户点哪一个都有一半概率点错。
 *
 *    区分符用**本地端口**：它就是"这一条在哪个地址上"，而且与"哪一份浏览器存储"
 *    一一对应。★ 只在**真的重名**时才加（不重名一个字不加）—— 给每一条都挂一个
 *    端口号，等于把"这两条需要分"这件事说给所有人听。
 *
 *    ⚠️ 曾经这里有一句注释说"两条会话的插件必然不同，所以服务名天然唯一" ——
 *    那是工作区那一轮**之前**的形状（当时槽是按工作区分的，同一个工作区同时只能
 *    有一条要界面的会话）。现在不成立了，留着会让下一个人以为重名不可能。
 */
function renderTabs() {
  const box = $('session-tabs');
  const list = SESS.sessions;
  box.classList.toggle('hidden', list.length < 2);
  box.textContent = '';
  // 先数一遍名字：**同名**的那些才需要区分符。
  const seen = new Map();
  for (const s of list) {
    const n = s.service || '（未知服务）';
    seen.set(n, (seen.get(n) || 0) + 1);
  }
  for (const s of list) {
    const b = document.createElement('button');
    b.className = 'tab' + (s.slot === SESS.front ? ' on' : '')
      + (s.live ? '' : ' dead');
    const name = s.service || '（未知服务）';
    const port = s.snap && s.snap.localPort;
    b.textContent = seen.get(name) > 1 && port ? `${name} · ${port}` : name;
    const st = s.snap && s.snap.state;
    b.title = STATE_TEXT[st] || st || '';
    b.onclick = () => window.slurmate.setFront(s.slot);
    box.appendChild(b);
  }
}

/** 这个窗口里有没有**真的在跑**的会话。右栏开不开就是问它。 */
function hasRunningSession() {
  return SESS.sessions.some((s) => s && s.live);
}

/**
 * 两条边栏上那两个小点。
 *
 * ★ 左栏那个点**不在这里画** —— 它的三态由主进程算好了推过来（`ui:site`，
 *   见 init 里那个 `onSite`）：链路活没活是主进程才知道的事，界面这一层自己
 *   算就是第二个判据，而它会与主进程那个漂开。
 * ★ 右栏那个点说的是"这里有一份输出可看"，所以它跟着**有没有作业在跑**走，
 *   与左栏那个（站点现在怎么样）毫无关系。
 */
function renderRails() {
  $('rail-right-dot').className = 'rail-dot' + (hasRunningSession() ? ' hot' : '');
}

/** 前台那一条的槽（按钮要指名停哪一个）。没有会话时 null。 */
function frontSlot() {
  return (SESS.sessions.find((x) => x.slot === SESS.front) || {}).slot || null;
}

/**
 * 作业结束那一刻，那一句提示该是哪一档。
 *
 * ★ 判据是**退出码**（`jobExitCode` 是 Slurm 的原话 `"143:0"`），不是状态名字：
 *   状态名字已经被 `jobstate.js` 译成人话了，而"好没好"这件事在那个译文里读不出来
 *   （"完成"与"被抢占"都可能带一个非零退出码）。`0:0` 是"干净地结束"。
 * ★ 退出码缺席时按 info —— **猜一个"失败"比不猜更坏**（用户会去查一个不存在的问题）。
 */
function jobEndedKind(sn) {
  const ec = sn && sn.jobExitCode;
  return typeof ec === 'string' && !/^0:0$/.test(ec) ? 'error' : 'info';
}

/** 上一次为**哪个槽**报过"作业结束了"（只报一次，见 renderSnapshot 里那一条）。 */
let lastEndedSlot = null;

function renderSnapshot(s) {
  lastSnap = s || null;
  const bar = $('statusbar');
  const st = s ? s.state : 'idle';
  bar.className = 's-' + st;

  $('sb-state').textContent = STATE_TEXT[st] || st;

  let detail = '';
  if (s) {
    if (s.suspended) {
      // ★ 这一支**排在所有分支之前**。被接管的时候这些会话仍然停在 `running`，
      //   下面那一支会说「分区 · 节点 · 剩余时间」—— 那些话全是真的，但用户此刻
      //   最需要知道的是**本机已经不管它了**，以及**作业还在跑**。
      //   不这么排的话，界面看起来和一个正常运行的会话**一模一样**。
      //
      //   ★ 说的这句话由**主进程**给（`s.suspended` 本身就是那句原因）—— 界面
      //     不再自己编一句。两处各写一句的漂法是"主进程说被接管了、界面说被顶掉了"，
      //     而用户会去查一个不存在的区别。
      detail = s.suspended;
    } else if (st === 'running' || st === 'releasing') {
      const bits = [];
      if (s.partition) bits.push(s.partition);
      if (s.node) bits.push(s.node);
      if (s.expiresAt !== undefined) bits.push('剩余 ' + fmtLeft(s.expiresAt));
      if (s.renewCount) bits.push('已续期 ' + s.renewCount + ' 次');
      if (s.tunnelState === 'down') bits.push('隧道断开，正在重试');
      detail = bits.join(' · ');
    } else if (st === 'queued') {
      detail = s.jobId ? `作业 ${s.jobId} · 等待调度与登记` : '等待调度';
    } else if (st === 'error') {
      detail = s.error || '';
    } else if (st === 'submitting') {
      detail = '正在向控制节点申请资源';
    }
  }
  $('sb-detail').textContent = detail;

  const running = (st === 'running' || st === 'releasing');
  // ★ 会话一停，「结束会话」那个第一段就不该再等着第二段了 —— 留着它，用户按下去
  //   的第二段没有对象（会话已经结束了）。收起是**这一格自己的**事，与 `hidden`
  //   无关：那两件事一个是"这一格该不该在"，一个是"它现在是第几段"。
  if (!running) disarmArmed();
  $('sb-reload').classList.toggle('hidden', !running);
  $('sb-end').classList.toggle('hidden', !running);
  $('sb-dev').classList.toggle('hidden', !(s && s.dev));
  // ★★ 「这一份是临时副本」—— **两个地方都要露**，而状态条那一份是**必须的**，
  //    不是锦上添花：会话一跑起来，窗口主体就被原生视图整块盖住（只有前台那块
  //    `setVisible(true)`，从状态条下沿铺到底），面板里那一条也跟着被盖住 ——
  //    而那正是**最需要看见这句话的时候**（用户正要在里面干活）。`#sb-dev` 就是
  //    为同一件事待在那 30px 里的先例（见 panel.html 的注释）。
  //   ★ 诚实：这句话说的是"不会被记录"，而它只在**前台**那一条上成立 ——
  //     切到持久那一条时它会跟着消失（这正是要的：两份的差别就在这一点上）。
  const temp = frontTemporary();
  $('sb-temp').classList.toggle('hidden', !temp);
  $('temp-banner').classList.toggle('hidden', !temp);
  // 工作区选择器只在运行期间露出来：其余时候面板本身可见，用连接行里那个下拉就行。
  // 没有活跃连接时也藏起来 —— 它改的是「当前连接的」工作区，没有连接就没有对象。
  // ★ 多一个条件：**前台那条会话真的有一份数据**（`s.spaceId`）—— 只有要工作区的
  //   插件才有，不要工作区的（中转站）没有。
  //   漏了它的症状是：前台是个中转站会话时选择器还露着，用户改了**没反应** ——
  //   那条路（`outsideWorkspace`）两条分支都不走，而界面上一切正常。
  $('sb-workspace-wrap').classList.toggle(
    'hidden', !(running && boot && boot.activeConnectionId && s && s.spaceId));

  // ★★ 这一屏**不参与"露哪一屏"的判定** —— 那是路由的事（见 showScreen）。
  //   按会话状态切换 `sec-connect` / `sec-purpose` / `sec-session` 的话，"用户在
  //   哪儿"与"会话跑没跑起来"就混成一件：会话一起来就把人弹回当前会话那一屏，
  //   他刚才点开的作业列表就没了。
  //
  //   这里只留**它确实该管的那两格**：状态条上的按钮、以及前台那一条的详情。
  // ★★ `ended` **也要留**。从前这一格判的是 `st !== 'ended'`，而作业一结束会话就
  //    进 `ended` ⇒ **失败原因（「作业状态」那一句，含退出码）恰好在结束那一刻从
  //    界面上消失** —— 而那正是唯一想看它的时候。
  //    `idle`（还没有过任何会话）仍然不露：那时没有任何东西可说。
  const hasDetail = Boolean(s) && st !== 'idle';
  $('job-detail').classList.toggle('hidden', !(hasDetail && SCREEN === 'jobs'));
  if (hasDetail) renderKv(s);

  // ★ 作业**刚刚**结束的那一下，把那一句也送进提示流：切一屏之后再回来，它还在。
  //   判据是"上一轮还不是终态、这一轮是了"，不是"状态是 ended" —— 后者会在每一次
  //   推送时都重复一遍。
  const endedNow = (st === 'ended' || st === 'error')
    && lastEndedSlot !== (SESS.sessions.find((x) => x.slot === SESS.front) || {}).slot;
  if (endedNow) {
    lastEndedSlot = (SESS.sessions.find((x) => x.slot === SESS.front) || {}).slot;
    if (s) notice(jobEndedKind(s), s.jobText || '作业已结束。');
  }

  renderWorkspaceSelectors();
  // 工作区下拉的可见性刚变过，映射图的几何位置到这一帧结束后才是最终的。
  requestAnimationFrame(drawWorkspaceLines);
}

/**
 * 打开「新建」表单。
 *
 * ★ 密钥**在这一步生成**，早于用户填地址 —— 他得先把公钥复制去 IDM 注册，
 *   回来才连得上。所以这一步是异步的：公钥框会先显示「正在生成密钥…」。
 *
 * ★★ **每打开一次「新建」都是一把新的。** 主进程那边从前是幂等的（留着上一把
 *   就复用它，理由是"用户可能已经注册过了"），结果是：点「新建」→ 关掉表单 →
 *   再点「新建」，公钥一模一样，而用户**没有任何地方**能要到一把干净的钥匙。
 *   ⇒ 代价交给密钥那一行说（关掉表单=放弃这一把），**不再另加确认**：
 *     它不是"丢掉了什么"的动作，见本文件顶部那条"非必要不问"。
 */
async function openNewForm() {
  form = { open: true, mode: 'new', id: null };
  $('sec-form').classList.remove('hidden');
  $('btn-new').classList.add('hidden');

  $('form-title').textContent = '新建连接';
  $('form-hint').textContent =
    '两步：把下面的公钥注册到你的 IDM 账户，再填登录节点的地址。';
  $('btn-save').textContent = '保存并连接';
  // 地址栏一律清空 —— 见文件头：预填上一条的地址会让「新建」悄悄变成「又存一遍」
  $('f-label').value = '';
  $('f-user').value = '';
  $('f-host').value = '';
  $('f-port').value = '';
  $('key-hint').textContent = '正在生成密钥…';
  // 「③ 工作区」：初值跟随默认，而默认值要问主进程 —— 地址还空着，问出来的就是
  // 「活跃连接那个」或「新建一个」。用户敲了地址之后 `refreshFormWsDefault` 再问一次。
  wsPicked = '';
  wsDefault = null;
  renderFormWorkspace();
  hideKeyMessages();
  renderConnEmpty();

  const r = await window.slurmate.newKey();
  if (!form.open || form.mode !== 'new') return;    // 用户已经关掉或切走了
  if (!r || !r.ok) return showKeyError((r && r.error) || '生成密钥失败。');
  // ★ 这一行**必须**说出"关掉就放弃"：这一版起每次新建都换一把，
  //   而这一步没有确认（它不是"丢掉了什么"的动作，见本文件顶部那条）。
  //   不说的话，用户会在注册完公钥之后随手关掉表单，然后对着"认证失败"发愣。
  $('key-hint').textContent = '这把密钥属于下面这条新连接 —— '
    + '关掉表单就等于放弃它（公钥要重新注册一遍）。';
  renderKey(r.key);
  await refreshFormWsDefault();
}

/** 打开某条连接的编辑表单。 */
async function openEditForm(c) {
  form = { open: true, mode: 'edit', id: c.id };
  $('sec-form').classList.remove('hidden');
  $('btn-new').classList.add('hidden');

  $('form-title').textContent = '编辑连接';
  $('form-hint').textContent = '改这里的地址只影响这一条连接。';
  $('btn-save').textContent = '保存';
  $('f-label').value = c.label || '';
  $('f-user').value = c.user;
  $('f-host').value = c.host;
  $('f-port').value = c.port;
  $('key-hint').textContent = '正在读取密钥…';
  // 「③ 工作区」：编辑时**没有**"跟随默认"那一项 —— 这条连接已经有一个了，
  // 这一格答的是"要不要换"，而 `''` 在这里的意思是"不变"。
  wsPicked = '';
  wsDefault = null;
  renderFormWorkspace();
  hideKeyMessages();
  renderConnEmpty();

  const r = await window.slurmate.publicKey({ connectionId: c.id });
  if (!form.open || form.mode !== 'edit' || form.id !== c.id) return;
  if (!r || !r.ok) return showKeyError((r && r.error) || '读取密钥失败。');
  $('key-hint').textContent = r.key.missing
    ? '这条连接还没有密钥。点「重新生成密钥…」生成一把，再把公钥注册到 IDM。'
    : '这是这条连接自己的密钥。重新生成只作废它，其他连接不受影响。';
  renderKey(r.key);
}

/** 收起表单，回到「已保存的连接」那一屏。 */
function closeForm() {
  form = { open: false, mode: 'new', id: null };
  wsPicked = '';
  $('sec-form').classList.add('hidden');
  $('btn-new').classList.remove('hidden');
  renderConnEmpty();
}

/** 「一条连接都没有」时的引导语。表单开着的时候它得指向表单，而不是那个已被收起的按钮。 */
function renderConnEmpty() {
  $('conn-empty').textContent = form.open
    ? '还没有保存任何登录节点。填好下面的用户名、主机和端口，点「保存并连接」。'
    : '还没有保存任何登录节点。点右上角的「新建连接」填一个 —— 只需要用户名、主机和端口。';
}

// ── 表单里的「③ 工作区」 ────────────────────────────────────────────────────
//
// 这一格有两个状态，必须分开记：
//
//   `''`             —— **跟随默认**（新建时的初值）／**不变**（编辑时）。
//                       新建时默认值随上面的地址变（同址已经有连接就用它那个工作区），
//                       所以它**不是一个定值**。
//   `NEW_WORKSPACE`  —— 用户要一个新的空白工作区。
//   一个工作区 id     —— 用户挑定了那一个。
//
// ★ 为什么不把默认值直接**选中**在那个下拉的某一项上：那样"用户没表态"与"用户挑的
//   正好是默认那个"就分不出来了，而两者保存时的下场不同 —— 前者要由主进程在**存的
//   那一刻**现算（用户可能在敲完地址之后立刻按保存，而界面手里那个默认值是上一个字
//   算出来的）。所以默认值在这里只用来**显示**，判定权在 `app:saveConnection`。

/** 用户显式挑的那个值；`''` = 跟随默认（新建）／不变（编辑）。 */
let wsPicked = '';

/** 最近一次问到的默认值（工作区 id 或 null = 会新建一个）。**只用来显示。** */
let wsDefault = null;

/** 问一遍默认值并重画。用户敲地址时会被反复调用 —— 它是一句纯查询。 */
async function refreshFormWsDefault() {
  const port = Number($('f-port').value);
  const r = await window.slurmate.defaultWorkspace({
    host: $('f-host').value.trim(),
    port: Number.isInteger(port) ? port : 0,
  });
  if (!form.open || form.mode !== 'new') return;   // 用户已经关掉或切走了
  wsDefault = (r && r.ok) ? r.workspaceId : null;
  renderFormWorkspace();
}

/**
 * 重画「③ 工作区」那个下拉，并把当前选择的**后果**写成一句话。
 *
 * ★ 内容没变就不动 DOM（`dataset.sig`）：重建 <select> 会把用户正在展开的列表收起来，
 *   而地址那几个框每敲一个字都会走到这里。
 */
function renderFormWorkspace() {
  const sel = $('f-workspace');
  const editing = form.mode === 'edit';
  const cur = editing
    ? ((boot.connections || []).find((c) => c.id === form.id) || {}).workspaceId
    : null;
  // ★ 编辑时**没有**"默认"那一项 —— 这条连接已经有一个工作区了，这一格答的是
  //   「要不要换」，而 `''` 在这里的意思是"不变"。
  const head = editing ? null : {
    value: '',
    text: workspaceById(wsDefault) ? `默认：${workspaceById(wsDefault).name}`
      : '默认：新建一个空白工作区',
  };
  fillWorkspaceOptions(sel, wsPicked || (editing ? cur : ''), editing ? cur : null, head);
  $('ws-hint').textContent = wsHintText(sel.value, editing ? cur : undefined);
}

/** 当前选择的那一句**后果**。短 —— 长解释在下拉的 title 里。 */
function wsHintText(v, cur) {
  const name = (id) => (workspaceById(id) || {}).name || '那个工作区';
  if (v === NEW_WORKSPACE) return '保存后会新建一个空白工作区。';
  if (cur !== undefined) {                 // 编辑
    if (v === cur || v === '') return '不变。';
    return `保存后切到「${name(v)}」—— 原来那个里面的东西不会跟着走。`;
  }
  if (v === '') {                          // 新建，跟随默认
    return wsDefault
      ? `跟随默认：现在会落在「${name(wsDefault)}」。`
      : '跟随默认：现在会新建一个空白工作区。';
  }
  return `会用「${name(v)}」。`;
}

/**
 * 「本地地址」那一行该写什么。
 *
 * ★ 无条件写 `s.origin`（也就是 `http://127.0.0.1:PORT`）对**中转站**
 *   会话是一句**假话**：那个端口后面是 SSH，不是 HTTP。用户照着这一行去浏览器里
 *   打开，只会得到一张空白页，而他会以为是客户端坏了。
 *
 * 判据是插件声明的 `contributes.surface`，不是"是不是某个插件"：
 * 声明了界面的写 URL，没声明的写裸 TCP 地址。认不出这个会话是哪来的（站点装了
 * 本机没有的插件）时也写裸地址 —— 我们确实不知道那头是什么。
 */
function localAddressText(s) {
  if (!s.localPort) return '—';
  const p = ((lastPlugins && lastPlugins.plugins) || [])
    .find((x) => x.name === s.serviceKind);
  return (p && p.surface)
    ? `http://127.0.0.1:${s.localPort}`
    : `127.0.0.1:${s.localPort}（TCP，不是网址）`;
}

function renderKv(s) {
  const r = s.resources || {};
  const resText = [
    r.cpus ? `${r.cpus} 核` : null,
    r.mem || null,
    // GRES 那一段**已经在主进程译好**（`gres.js`）—— 名字与型号是集群定的，
    // 这里一个假设都不做。`s.gresText` 为 null = 这一行不说 GRES。
    s.gresText || null,
  ].filter(Boolean).join(' / ') || '—';

  const rows = [
    ['会话 ID', s.sessionId || '—'],
    ['作业 ID', s.jobId || '—'],
    // 默认是随机挑分区，所以用户事先不知道会落到哪种卡上 —— 必须显示实际结果
    ['分区', s.partition || '—'],
    ['资源', resText],
    ['节点', s.node || '—'],
    ['隧道目标', s.tunnelTarget || '—'],
    ['本地地址', localAddressText(s)],
    ['剩余时间', fmtLeft(s.expiresAt)],
    // 这一句由主进程译好（`jobstate.js`）—— 界面只印，不自己译：Slurm 的原文
    // 大写枚举（`OUT_OF_MEMORY`）是说给管理员听的话。
    ['作业状态', s.jobText || '—'],
    // ★ 「被接管」是**这台电脑**的状态，不是这条会话的状态 —— 所以它自己一行，
    //   而不是改「作业状态」那一行：作业**真的还在跑**，把它写进那一行就是
    //   一句不成立的话，而用户会照着它去把作业停掉。
    ...(s.suspended ? [['本机', s.suspended]] : []),
    ['上次心跳', fmtAge(s.hbAgeMs)],
    ['隧道', { listening: '已连接', down: '断开，重试中', stopped: '已停止' }[s.tunnelState] || s.tunnelState],
  ];
  const dl = $('kv');
  dl.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

/**
 * 按需取一次日志并画在详情底下。走的是**右栏同一条 op**。
 *
 * ★ 之所以是"按需"而不是"转存一份在这里"：作业结束之后那条会话行在站点的
 *   `released_keep` 窗口内还在，同一条 op 照样答得上来 —— 再取一次与服务端记一份，
 *   结果一样而少一处会漂的状态。
 *
 * ★ 三态怎么判在 `dom.js` 的 `logCellOf()` 里（浮窗那一页用的是同一个函数）：
 *   两处各判一遍的话，漂的那一处不会报错。
 */
async function loadJobLog() {
  const s = frontSnap();
  const box = $('joblog-body');
  const meta = $('joblog-meta');
  if (!s || !s.sessionId) { meta.textContent = '这一条还没有会话 ID。'; return; }
  meta.textContent = '正在取…';
  box.classList.remove('hidden');
  box.textContent = '';
  const r = await window.slurmate.jobLog({ session_id: s.sessionId, lines: 500 });
  box.textContent = '';
  if (!r || !r.ok) {
    // **取不到**（或者这个站点太旧没有这个能力）—— 如实说，不画一个空框。
    meta.textContent = '';
    box.append(cel('p', 'na', (r && r.error) || '控制节点没有说明原因'));
    return;
  }
  const d = r.data || {};
  meta.textContent = '';
  let any = false;
  for (const [key, title] of [['out', '标准输出'], ['err', '标准错误']]) {
    const it = logCellOf(d[key] === undefined ? null : d[key]);
    if (it.kind === 'absent') continue;
    any = true;
    const blk = cel('div', 'block');
    blk.append(cel('div', 'hd2', `${title}　${it.kind === 'text' ? it.meta : ''}`));
    if (it.kind === 'na') blk.append(cel('p', 'na', `取不到：${it.why}`));
    else blk.append(cel('div', null, it.text || '（这一份还是空的）'));
    if (it.path) blk.append(cel('div', 'hd2', it.path));
    box.append(blk);
  }
  if (!any) box.append(cel('p', 'sub', '这个作业还没有写出任何东西。'));
}

// ── 公钥 ────────────────────────────────────────────────────────────────────

/** 清掉密钥区那几条提示。**切换表单时必须先清** —— 否则上一把钥匙的毛病会留在屏幕上。 */
function hideKeyMessages() {
  for (const id of ['key-error', 'key-nopersist']) {
    const el = $(id);
    el.classList.add('hidden');
    el.classList.remove('alarm');
    el.textContent = '';
  }
  $('key-fp').textContent = '—';
}

function showKeyError(text) {
  const err = $('key-error');
  err.textContent = text;
  err.classList.remove('hidden');
}

/**
 * 渲染一把密钥。
 * @param {{publicKey, fingerprint, persisted, error, detail, missing}} k
 */
function renderKey(k) {
  hideKeyMessages();
  // ★ 只显示指纹，**不显示公钥本身**：所有 ed25519 公钥的前 40 个字符逐字相同
  //   （`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI` 是固定的），于是「换了一把钥匙」
  //   在一个文本框里看起来毫无变化 —— 而这是最要命的一种变化，用户会以为还是
  //   原来那把，实际拿去认证的已经不是了，症状只有「认证失败」。
  //   指纹短、每一位都随机，拿去和 IDM 里那条一比对就知道对不对。
  $('key-fp').textContent = k.fingerprint || '—';

  if (k.error) {
    // 密钥在，但读不出来。这是**唯一**一条会走到「重新生成」的路，
    // 而点下去会作废用户已经注册到 IDM 的那把公钥 —— 必须说清楚。
    showKeyError((k.detail || '这把密钥不可用。')
      + ' 若确认要重新生成（你会需要把新的公钥重新注册到 IDM），点上面的「重新生成密钥…」。');
    return;
  }
  // 还没有密钥。由 key-hint 说明该怎么办，这里再喊一遍只会重复。
  if (k.missing) return;

  // 密钥存不下来（这台机器没有凭据库）。必须**说出来**，不能只是没保存成功。
  //
  // **不要摆一个「私钥保存方式」下拉框**（让用户在加密／明文／不保存之间选）：
  // 那等于把「你的私钥会以明文躺在磁盘上」包装成一个需要用户自己权衡的选项 ——
  // 选明文的那个用户并不知道自己在放弃什么。只有加密一种方式，
  // 存不了就如实讲清楚后果，没有第二个选项可以让人选错。
  if (k.persisted === false) {
    const np = $('key-nopersist');
    // 「没有凭据库」和「有凭据库但这次写失败了」是两种不同的毛病，修法也不同，
    // 所以文案要分开 —— 一句笼统的「保存失败」指不回根因。
    //
    // ★ 这条必须**显眼**（.alarm），因为它预告的正是后面那个「认证失败」：
    //   密钥存不下来 → 下次启动换一把 → 已经注册到 IDM 的那把公钥作废。
    //   写成一行灰字时，用户会一路读到「认证失败」才回头，而那时已经指不回这里了。
    const tail = '下次启动会重新生成一把新密钥，你注册到 IDM 的那把公钥随之作废 ——'
      + '到时候你看到的只会是「认证失败」。';
    np.textContent = boot.secureStorageAvailable
      ? '注意：私钥这次没能保存到本机。' + tail
      : '注意：这台机器上没有可用的系统凭据库，私钥存不下来（只能留在内存里）。' + tail;
    np.classList.add('alarm');
    np.classList.remove('hidden');
  }
}

// ── 连接列表 ────────────────────────────────────────────────────────────────

/**
 * 一条连接在界面上叫什么：**有备注就用备注，没有才回落成地址**。
 *
 * ★ 一处定义、别处指路。列表那一行、"换站点"那道闸、以及「删除」那一段两段式
 *   都指名道姓地要用它 —— 各写一遍的话，漂开的方向是"框里说的那条，用户在这一屏
 *   上找不到"（写地址就正是那个漂法：界面上印的是备注）。
 */
function connLabel(c) {
  return (c && c.label) || `${c.user}@${c.host}:${c.port}`;
}

function renderConnections(list) {
  const box = $('conn-list');
  box.textContent = '';
  // ★ 这一屏会被整块重画，而第一段那个确认就挂在某一行里 —— 不先收掉的话，
  //   那一行连同它一起被丢掉，而 `armed` 还指着它（下一次点"别处"收的是一个
  //   已经不在文档里的节点，看起来像没反应）。
  disarmArmed();
  $('conn-empty').classList.toggle('hidden', list.length > 0);
  // 映射图与列表同生共死：没有连接就没有可映射的东西
  $('sec-workspaces').classList.toggle('hidden', list.length === 0);
  // 「临时离开」与「断开」只在连着的时候存在 —— 它们是**站点级**的动作（见
  // renderConnections 里那个「连接/进入」按钮的注释）。★ 两个一起切：只切一个的话，
  // 另一个会在没连上的时候露着，而它按下去只能得到一句"控制节点没有回应"。
  $('btn-leave').classList.toggle('hidden', !connected);
  $('btn-disconnect').classList.toggle('hidden', !connected);
  // 两条边栏同理：它们是**站点级**的两格（站点状态、这个站点上的作业输出），
  // 没有站点就既没有可问的也没有可看的。见 panel.html 那一段。
  document.body.classList.toggle('connected', connected);

  // ★★ 内置那条**排最前**（其余保持用户的顺序）。它在这个列表里是"起点"，
  //   而不是又一条记录：勾上开发者模式、重启，第一个看见的就是它。
  //   ★ 用两趟 `filter` 拼，不调 `sort` —— `sort` 对**全部**元素重排，而其余那些
  //     用户的连接顺序是用户自己攒出来的（新建的排在最后），不该被这一次重排打乱。
  for (const c of list.filter((x) => x.builtin).concat(list.filter((x) => !x.builtin))) {
    const li = document.createElement('li');
    // 「当前」和「已连接」是两回事：断开之后活动连接还是它，但没有连着。
    const live = c.id === boot.activeConnectionId && connected;
    li.className = 'conn' + (live ? ' active' : '');

    const t = document.createElement('span');
    t.className = 't';
    // 有备注就显示备注 —— 用户给它起了名，就是为了不必再读地址。
    // 没起名才回落成地址。**两者取其一，不并排显示**：并排等于把备注降级成一个
    // 前缀，那这个名字就白起了，用户还是得去读那串地址。
    t.textContent = connLabel(c);
    // 地址仍然在，只是不占地方 —— 鼠标停一下就能看到。
    t.title = `${c.user}@${c.host}:${c.port}`;
    // ★ 内置那条加一颗看得见的标记。它没有「编辑」「删除」两颗按钮，而"这一行为什么
    //   与上面那些不一样"必须是**这一行自己**回答得了的 —— 否则那是一处看起来像
    //   漏画了的地方。
    if (c.builtin) t.append(el('span', 'b', '内置'));

    const probe = lastProbe.find((p) => p.id === c.id);
    const m = document.createElement('span');
    m.className = 'm';
    if (live) {
      // ★ 「这个站点上我还有几个作业」——**只有在它身上取过作业列表时才说得出来**。
      //   没取过就只说"已连接"，绝不补一个 0：`0` 会被读成"一个作业都没有"，
      //   而那是我们并不知道的一件事（同一条三态纪律）。
      //
      //   ★ 而**别的站点上的作业数，这一屏本来就答不了** —— 要答就得连上去，
      //     而"打开客户端连着几个站点挨个查一遍"是一条被刻意避开的形状。
      //     这一条边界从前面板底下有一段话专门解释它，删掉了：不知道就写
      //     「已连接」是**对**的，而一句解释不改变任何人的动作 —— 想数就点进去。
      const known = JOBS.list && JOBS.forConn === c.id;
      const n = known ? JOBS.list.filter((j) => j.live).length : null;
      m.textContent = known ? `已连接 · ${n} 个作业在跑` : '已连接';
      m.classList.add('good');
    } else if (c.builtin) {
      // ★ 内置那条**这一格留空**，而不是写「未探测」。探测那三个状态在这里全是假话：
      //   主进程不探它（`app:probeHosts` 把它滤掉了），所以「未探测」是在说"还没轮到
      //   它"—— 而它永远不会轮到；「可达 / 不可达」更是在报告一件没有发生的事。
      //   这一行说什么，上面那颗「内置」与名字已经说完了。
      m.textContent = '';
    } else if (!probe) {
      m.textContent = '未探测';
    } else if (probe.reachable) {
      m.textContent = `可达 · ${probe.rttMs}ms`;
    } else {
      m.textContent = `不可达：${probe.error || '失败'}`;
      m.classList.add('bad');
    }

    // ★★ 这一格是**三屏的入口**，而不是"连接/断开"那个开关。
    //
    //   连着的时候点它 = **进去看这个站点的插件与作业**（第二屏）；没连的时候
    //   点它 = 连上它（连上之后自动进第二屏，见 handleConnectResult）。
    //
    //   ★ 「断开」因此挪到了这一屏的标题栏上（`#btn-disconnect`）：它是一个
    //     **站点级**的动作（同时最多连着一个站点），而不是某一条连接自己的属性 ——
    //     挂在每一条行上，等于在说"你可以同时断开好几条"。
    const main = document.createElement('button');
    main.className = 'tiny';
    main.textContent = live ? '进入' : '连接';
    main.onclick = () => (live ? showScreen('plugins') : doConnectTo(c));

    // 编辑：地址 / 这条连接自己的密钥。
    const edit = document.createElement('button');
    edit.className = 'ghost tiny';
    edit.textContent = '编辑';
    edit.onclick = () => openEditForm(c);

    const del = document.createElement('button');
    del.className = 'ghost tiny danger-ghost';
    del.textContent = '删除';
    del.disabled = live;              // 连着的时候先断开再删，别让作业失去主人
    del.onclick = () => {
      // ★ 两段式。删除连带销毁这条连接的私钥，所以后果必须在按下去**之前**说
      //   出来 —— 用户拿去 IDM 注册过的公钥就此作废，重建一条要重新注册。
      //
      // ★ 还有一样会被删掉：**最后一个用某个工作区的连接被删掉时，那个工作区的
      //   数据也一起清**（浏览器存储 + 插件写到磁盘上的文件）—— 主进程那边是
      //   `commitConfig` → `pruneWorkspaces` → `clearWorkspaceStorage`。
      //   判据与主进程**同源**：`workspacePlan` 的 `soleOwnerId` 就是从"只有这一条
      //   连接在用它"推出来的，与 `pruneWorkspaces` 数的是同一件事。
      //
      // ★ 名字走 `connLabel(c)` 而不是地址：这一行界面上印的**是备注**（有的话），
      //   确认那一行印地址的话，它指的是一条"在这一屏上找不到"的连接。
      const sole = (boot.workspaces || []).find((l) => l.soleOwnerId === c.id);
      armConfirm(del, {
        why: `删除「${connLabel(c)}」？它的私钥一并作废，你得重新注册一把新公钥。`
          + (sole
            ? `「${sole.name}」也只有这一条连接在用，会跟着删掉 —— 里面的编辑器`
              + '布局、登录状态，以及插件写在磁盘上的那些文件都找不回来。'
            : ''),
        yes: '删除',
        run: async () => {
          const r = await window.slurmate.deleteConnection(c.id);
          if (!r.ok) return notice('error', r.error);
          boot.connections = r.connections;
          boot.activeConnectionId = r.activeConnectionId;
          // 正在编辑的就是这一条 —— 表单不能再留在一个已经不存在的条目上
          if (form.open && form.mode === 'edit' && form.id === c.id) closeForm();
          renderConnections(boot.connections);
          notice('info', '已删除该连接。'
            + (r.keyDeleted ? '它的私钥也一并删掉了。' : '')
            + (sole ? `「${sole.name}」的数据也一起清掉了。` : ''));
        },
      });
    };

    // ★★ 内置那条**不画**「编辑」「删除」两颗按钮 —— 不是画成禁用的。一颗永远点不亮
    //   的按钮正是"系统声称了不成立的事"：它在说"这里有一个可以编辑的东西"。
    //   它与一条普通连接的差别**只有这一处**（加上主进程那两道权威闸）；
    //   「连接」「进入」以及进去之后的一切完全相同。
    if (c.builtin) {
      li.title = '开发者模式内置的假连接：在本机的假站点上调试插件用的。'
        + '不可编辑、不可删除 —— 关掉开发者模式它就不在了。';
      li.append(t, m, main);
    } else {
      li.append(t, m, main, edit, del);
    }
    box.append(li);
  }

  renderWorkspaceMap();
}

/**
 * 「这条连接用哪个工作区」那一格从**连接行**搬到了**连接表单**里（「③ 工作区」）。
 *
 * ★ 搬的理由：那一格是**这条连接的一个属性**，与地址、用户名同一类 —— 摆在行上时
 *   它是一条「随时可改」的快捷方式，而改它的代价（切走一个独占的工作区 = 把它连同
 *   里面的东西一起删掉）远大于改一个地址。放进表单里，"改"这个动作就有了它该有的
 *   分量：按「保存」才算数。
 * ★ 运行期间那个入口还在（状态条的 `#sb-workspace`）—— 会话跑起来之后窗口主体被
 *   原生视图盖住，那是唯一够得着的像素。
 */

// ── 工作区 ──────────────────────────────────────────────────────────────────
/**
 * 一条连接只用一个工作区，一个工作区可以被多条连接共用；没有任何连接在用的工作区
 * 会被主进程回收。
 *
 * ★ 这一段**不做任何推导**。`boot.workspaces` 是主进程用 workspacePlan() 算好的
 *   （每个工作区带 members / refCount / soleOwnerId），界面只负责渲染。
 *   理由不是懒：界面手里那份随时可能已经陈旧（另一条连接刚被删），而
 *   「切走会不会把这个工作区删掉」是一个**不可逆**的判断，必须由主进程说了算。
 */

function workspaceById(id) {
  return (boot.workspaces || []).find((l) => l.id === id) || null;
}

/**
 * 按 id 找一条连接。**这个名字这一层只有一处** —— `connName`（工作区的说明文字）
 * 与 `askFork`（分叉弹窗里"还有谁"）都要走它，各写一遍 `find` 迟早会漂开。
 *
 * ★ 带 `boot &&` 的兜底：`activeConn()` 从前就是这么写的，说明这一层**够得着**
 *   在 `init()` 设好 `boot` 之前被调用。
 */
function connById(id) {
  return ((boot && boot.connections) || []).find((x) => x.id === id) || null;
}

/** 连接的名字。工作区的说明文字里要引用成员，用同一条规则取名才不会两处对不上。 */
function connName(id) {
  const c = connById(id);
  return c ? (c.label || `${c.user}@${c.host}`) : '另一条连接';
}

/** 一个工作区后面跟的那句说明。 */
function workspaceNote(l, connId) {
  if (!l) return '';
  if (l.refCount === 0) return '（空）';
  if (l.refCount === 1) {
    // 自己独占：要把「切走就会被丢弃」说出来，这是用户按下去之前唯一的机会
    return l.soleOwnerId === connId
      ? '（只有这一条连接在用 —— 切走就会被丢弃）'
      : `（${connName(l.soleOwnerId)} 独占）`;
  }
  return `（${l.refCount} 条连接共用）`;
}

/** 当前活跃连接的工作区 id。 */
function activeConnWorkspaceId() {
  const id = boot && boot.activeConnectionId;
  const c = (boot && boot.connections || []).find((x) => x.id === id);
  return c ? c.workspaceId : null;
}

/**
 * 前台那条会话跑在**哪一个工作区**里 —— 按它手里那份数据的 id，去引用表里反查。
 *
 * ★ 会话手里是**一份数据**（`snap.spaceId`），而用户认的是**工作区**这个单位。
 *   两者不是一回事：一份数据可以被几个工作区同时引用（那正是引用表存在的理由）。
 *   所以这一步只能查，不能推 —— 主进程给的那张表里每一行都带着它指着哪些数据。
 * ★ 查不到就返回 null：**临时那一份**不在任何工作区里（它只活在内存里），
 *   那时选择器退回活跃连接那个工作区。
 */
function frontWorkspaceId() {
  const sid = lastSnap && lastSnap.spaceId;
  if (!sid) return null;
  const l = (boot.workspaces || []).find((x) => (x.spaces || []).includes(sid));
  return l ? l.id : null;
}

/**
 * 把工作区那几项填进一个 <select>。**三个下拉共用这一份**：状态条那个、表单里的
 * 新建与编辑。各写一份的话，那句说明（「只有这一条连接在用 —— 切走就会被丢弃」）
 * 迟早会在其中一处走样，而它正是用户按下之前唯一的机会。
 *
 * `keep` 是应当选中的那个值。**找不到就不选**（宁可空着）—— 让下拉停在一个
 * 并不生效的值上，用户会以为自己已经切过去了。
 *
 * `connId` 只影响那句说明（"谁在用"）：状态条给活跃连接，表单给正在编辑的那条，
 * **新建时给 null**（这时问的是"还有谁在用"，这条连接自己还不算）。
 *
 * `head` 是可选的**第一项**（表单新建时那一项「默认：X」）。它的 `value` 是空串，
 * 而空串恰好落在下面那条"找不到就不选"的兜底上，所以跟随默认天然会被选中。
 *
 * `sig` 是给状态条用的：它在每次快照推送时都会被重填，而重建 <select> 会把用户
 * 正在展开的列表收起来。内容没变就不动 DOM。
 */
function fillWorkspaceOptions(sel, keep, connId, head) {
  const list = boot.workspaces || [];
  const sig = JSON.stringify([head || null, connId == null ? '' : connId,
    list.map((l) => [l.id, l.name, l.refCount, l.soleOwnerId])]);
  if (sel.dataset.sig !== sig) {
    sel.textContent = '';
    if (head) {
      const o = document.createElement('option');
      o.value = head.value;
      o.textContent = head.text;
      sel.append(o);
    }
    for (const l of list) {
      const o = document.createElement('option');
      o.value = l.id;
      o.textContent = `${l.name}${workspaceNote(l, connId)}`;
      sel.append(o);
    }
    const nu = document.createElement('option');
    nu.value = NEW_WORKSPACE;
    nu.textContent = '＋ 新建空白工作区…';
    sel.append(nu);
    sel.dataset.sig = sig;
  }
  // ★ `NEW_WORKSPACE` 与 `''` 都要原样留住 —— 前者是用户**显式**要一个新的，
  //   后者是"跟随默认"，两者都不是"选不中任何一项"（那才落到空串上）。
  sel.value = (keep === '' || keep === NEW_WORKSPACE || list.some((l) => l.id === keep))
    ? keep : '';
  // 长解释进 title（悬停才看得到），正文只留那一句**后果**（表单里的 `#ws-hint`）。
  sel.title = '这个工作区里，各个插件用哪一份数据 —— 编辑器窗口布局、打开的标签页、'
    + '登录状态都在这儿。一个工作区可以被多条连接共用；'
    + '切走一个只有这条连接在用的工作区，它会被删掉。';
}

/**
 * 状态条里那个选择器。它改的是**当前活跃连接**的工作区。
 *
 * ★★ 它重画的正是两段式第一段挂身的那一格（`$('sb-workspace')`）⇒ **先收第一段**。
 *   不收的话，"待定"的那一行确认会与刚被拨回真值的下拉同时摆在界面上 ——
 *   界面在说一件没发生的事（同 `renderConnections` 那条规矩）。
 * ★ 递归是安全的：`disarm()` 先把 `armed` 置空再跑 `onDisarm`，而 `onDisarm`
 *   走的正是这个函数 —— 里面那次 `disarmArmed()` 看到的已经是 `null`，
 *   代价只是多重建一次下拉。
 */
function renderWorkspaceSelectors() {
  disarmArmed();
  const sel = $('sb-workspace');
  if (!sel) return;
  // 运行期间以快照为准（那才是会话真正跑着的那一份数据所在的工作区）；
  // 没有会话时用连接自己的标记 —— 它改的是「当前连接的」工作区。
  const cur = frontWorkspaceId() || activeConnWorkspaceId();
  fillWorkspaceOptions(sel, cur, boot && boot.activeConnectionId);
}

/**
 * 切走一个独占工作区的**后果** —— 交给两段式的第一段去说。
 *
 * 文案里必须出现「未保存的编辑内容会丢失」—— 这比「工作区变了」严重得多：
 * 换工作区 = 换 origin，浏览器是在**重新加载**那个页面，终端里没保存的东西就没了。
 * 用户有权在按下去之前知道这一条。
 *
 * ★ 它从前是一句 `window.confirm` 的正文。改成两段式之后它**只剩这段文字** ——
 *   谁来问、什么时候问、退了怎么收，全在 `armConfirm` 那一层（见 `applyWorkspace`）。
 *   把"问"留在函数的返回值里，正是这条路当初错的地方。
 */
function discardWhy(name) {
  const live = lastSnap && lastSnap.state
    && lastSnap.state !== 'idle' && lastSnap.state !== 'ended';
  return `「${name}」现在只有这一条连接在用，切走之后它会被删除。`
    + '它的编辑器窗口布局、打开的标签页和登录状态都会一起没掉，'
    + '插件写在磁盘上的那些文件也一样 —— 而且找不回来。'
    + (live ? '当前页面会重新加载到新工作区，未保存的编辑内容会丢失。' : '');
}

/**
 * 把一条连接切到另一个工作区。**两个入口共用这一条**：状态条那个下拉，
 * 以及连接表单里的「③ 工作区」（保存时那一趟，见 `btn-save` 那段）。
 *
 * ★ 从前还有第三个入口 —— **连接行上**那个下拉。它删掉了（见 `renderConnections`
 *   后面那一段）：改工作区的代价远大于改一个地址，摆在一行上等于把它降级成一次
 *   "随手一点"。搬进表单之后，这个动作要按「保存」才算数。
 *
 * @param {string} connectionId
 * @param {string|null} workspaceId  null = 新建一个空白工作区并落进去
 * @param {object} [opts]
 *   anchor    {HTMLElement} 第一段挂在哪一格上（状态条那个下拉，或表单里「保存」）
 *   revert    {() => void}  第一段**退回去**时把界面拨回原样
 *   confirmed {boolean}     内部用：这是答过之后的第二趟，直接带 `confirmDiscard` 发
 * @returns {Promise<{ok:boolean, armed?:boolean}>}
 *   失败（含用户取消）时调用方应把下拉拨回原值；`armed:true` 表示**问题还摆在那儿
 *   没答**（既不是成功也不是失败），调用方不要当失败处理、也不要去重画那一格 ——
 *   重画会把那行确认连同它的 `armed` 一起丢掉。
 *
 * ★★ 「切走会不会把旧工作区删掉」的判定权在**主进程**，不在这里。先照常提交，
 *   主进程若回 `would_discard`，我们拿它的原话**摆出第一段**（`armConfirm`），
 *   用户点了才带 `confirmDiscard` 重来一次。这样无论界面手里那份 refCount 有多
 *   陈旧，问出来的问题都是真的。
 *   ★ 它从前是一句 `window.confirm` —— 而那是这条路最别扭的地方：**主进程先拒、
 *     界面再问、然后整趟重发**，三段挤在一个 `if` 里，而那个框按下去的时候
 *     用户已经没有第二次机会了。两段式把"问"摊回界面自己的状态里（`armed`）。
 */
async function applyWorkspace(connectionId, workspaceId, opts = {}) {
  const payload = { connectionId, workspaceId };
  if (opts.confirmed) payload.confirmDiscard = true;
  let r = await window.slurmate.setConnectionWorkspace(payload);

  if (!r.ok && r.code === 'would_discard') {
    // ★ 没有可挂的那一格就不问（防御：不该发生，但 `armConfirm` 拿到 undefined
    //   会当场抛，而那个抛发生在一次用户点击里，看起来像"点了没反应"）。
    if (!opts.anchor) {
      notice('error', r.error || '切换工作区失败。');
      return { ok: false };
    }
    armConfirm(opts.anchor, {
      why: discardWhy(r.workspaceName),
      yes: '切走',
      // 第二趟带上 `confirmed`，其余照原样 —— 包括 `anchor` / `revert`，
      // 万一主进程再拒一次（那时它已经答过一次了，`armConfirm` 会再摆一段）。
      run: () => applyWorkspace(connectionId, workspaceId, { ...opts, confirmed: true }),
      onDisarm: opts.revert,
    });
    return { ok: false, armed: true };
  }
  if (!r.ok) {
    notice('error', r.error || '切换工作区失败。');
    return { ok: false };
  }

  // 会话活着时，这一句要说清「作业没动」—— 用户看到页面重新加载，
  // 最容易的联想是「我的作业是不是被重启了」。它没有。
  const wasRunning = lastSnap && lastSnap.state === 'running';
  boot.workspaces = r.workspaces || boot.workspaces;
  boot.connections = r.connections || boot.connections;
  renderConnections(boot.connections);
  notice('info', wasRunning
    ? '已切换工作区。页面会重新加载一次；计算节点上的作业没有受影响，仍然在跑。'
    : '已切换工作区。');
  // 拉一次权威状态：会话的 workspaceId 刚变，界面手里那份还是旧的，而状态条正是
  // 拿它显示当前工作区的 —— 不拉就会继续显示上一个。
  renderSessions(await window.slurmate.states());
  return { ok: true };
}

// ── 映射图 ──────────────────────────────────────────────────────────────────
// 画线时要拿节点的几何位置，所以渲染出来的节点按 id 存着。
//
// ★ **三列**：连接 / 工作区 / 数据。两段关系各画一段线（连接→工作区、工作区→数据），
//   于是"一份数据被两个工作区共用"这件事在图上就是**两条线汇到同一个节点** ——
//   那正是这张图存在的理由，而在下拉框里看不出来。
const mapNodes = { conn: new Map(), workspace: new Map(), space: new Map() };

/**
 * 某个插件 id 的标题。查不到就返回 null —— 「查不到」与「它叫这个」是两件事
 * （那一份数据还在、而插件已经卸载了的时候就是这样，那时**不编一个名字**）。
 *
 * ★ 两个来源，缺一不可：`lastPlugins` 是最新那次对账的结果，而**第一屏画的时候它
 *   还没有**（`init()` 里 `renderConnections` 排在 `renderPlugins` 前面）——
 *   只读它的话，映射图左列那行插件名要等到下一次重画才出现，而那时用户早就
 *   看过一眼"只有连接名"的图了。`boot.plugins` 是同一份视图的启动快照。
 */
function pluginTitleOf(pluginId) {
  const src = lastPlugins || (boot && boot.plugins);
  const p = ((src && src.plugins) || []).find((x) => x.id === pluginId);
  return p ? p.title : null;
}

function renderWorkspaceMap() {
  const connsCol = $('wmap-conns');
  const wsCol = $('wmap-workspaces');
  const spCol = $('wmap-spaces');
  if (!connsCol || !wsCol || !spCol) return;
  connsCol.textContent = '';
  wsCol.textContent = '';
  spCol.textContent = '';
  $('wmap-lines').textContent = '';
  mapNodes.conn.clear();
  mapNodes.workspace.clear();
  mapNodes.space.clear();

  for (const c of boot.connections || []) {
    const n = document.createElement('div');
    n.className = 'wnode' + (c.id === boot.activeConnectionId ? ' cur' : '');
    n.title = `${c.user}@${c.host}:${c.port}`;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = c.label || `${c.user}@${c.host}`;
    n.append(nm);
    // 这条连接的工作区里**已经建了数据**的那几个插件 —— 名字从本机装着的插件来。
    // ★ 名字不是"这条连接会跑哪几个插件"：一个插件只有真开过一次会话之后才有那一份
    //   数据，所以这里列的是"这个工作区里有它的一份了"。悬停那一句把这件事说清楚。
    // ★ 查不到名字的（那一份数据还在、而插件已经卸载了）**不编一个**，整块小字就不画：
    //   右边那一列仍然按端口把那一份列出来，看图的人不会以为它不存在。
    const ws = workspaceById(c.workspaceId);
    const names = Object.keys((ws && ws.refs) || {}).map(pluginTitleOf).filter(Boolean);
    if (names.length) {
      // ★ 「已有」两个字是**承重**的：这行小字挂在一个**连接**节点底下，光看名字很
      //   容易被读成"这条连接会跑这几个插件"。它说的是"这个工作区里已经有它们的一份
      //   数据了"—— 而那是一个**已经发生**的事实（插件要先开过一次会话才有那一份）。
      const chips = el('span', 'plug-chips', `已有 ${names.join(' · ')}`);
      chips.title = `这个工作区里已经有这几份数据：${names.join('、')}。`
        + '一个插件要先开过一次会话才会有它那一份。';
      n.append(chips);
    }
    connsCol.append(n);
    mapNodes.conn.set(c.id, n);
  }

  const runtime = frontWorkspaceId();
  for (const l of boot.workspaces || []) {
    const n = document.createElement('div');
    n.className = 'wnode ws' + (l.id === runtime ? ' cur' : '');

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = l.name;

    // 引用计数直接摆出来 —— 「这个工作区还有谁在用」正是这张图存在的理由
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = l.refCount === 0 ? '没人用'
      : l.refCount === 1 ? '1 条连接' : `${l.refCount} 条连接`;

    const rn = document.createElement('button');
    rn.className = 'ghost tiny';
    rn.textContent = '改名';
    rn.onclick = () => startRename(l, nm);

    n.append(nm, meta, rn);
    wsCol.append(n);
    mapNodes.workspace.set(l.id, n);
  }

  // ── 右列：数据（一份 = 一个插件的存储 + 它自己的端口）──
  //
  // ★ 每一份都列出来，**包括没有连接在用的那些**：它们由 `pruneSpaces` 在每次改动后
  //   收掉，所以正常情况下一条都是"有人指着"的 —— 而万一还剩一条（比如某个工作区
  //   刚刚被回收，配置还没落盘），**画出来**比让它凭空消失诚实。
  for (const s of boot.spaces || []) {
    const n = document.createElement('div');
    n.className = 'wnode sp';

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = `端口 ${(s.ports || [])[0]}`;

    const title = pluginTitleOf(s.pluginId);
    const meta = document.createElement('span');
    meta.className = 'meta';
    const users = (boot.workspaces || [])
      .filter((l) => Object.values(l.refs || {}).includes(s.id)).length;
    meta.textContent = (title ? `${title} · ` : '')
      + (users === 0 ? '没有工作区在用' : users === 1 ? '1 个工作区' : `${users} 个工作区`);

    n.append(nm, meta);
    // 长解释进 title（悬停才看得到）：这块图上的字够多了，正文只留"这是什么"。
    n.title = (title ? `${title} 的一份数据` : '一份数据')
      + `。端口 ${(s.ports || [])[0]} 就是它的对外地址（换端口 = 换一份浏览器存储）。`
      + '一个工作区里每个插件各用一份；几个工作区可以指着同一份。';
    spCol.append(n);
    mapNodes.space.set(s.id, n);
  }

  requestAnimationFrame(drawWorkspaceLines);
}

/**
 * 画连线。
 *
 * ★ 用 SVG 的 <path d="…">：`d` 是**几何**属性，不在那条 CSP 的管辖范围内
 *   （它禁的是 style="…" 内联样式）。线的粗细颜色走 app.css 的 .edge 类。
 *   坐标全部由 getBoundingClientRect 现算 —— 所以任何一次布局变化之后都要重画。
 */
function drawWorkspaceLines() {
  const box = $('workspace-map');
  const svg = $('wmap-lines');
  if (!box || !svg) return;
  if (box.classList.contains('hidden') || $('sec-workspaces').classList.contains('hidden')) return;
  svg.textContent = '';
  const base = box.getBoundingClientRect();
  if (!base.width || !base.height) return;      // 这一屏还没被布局出来
  svg.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
  svg.setAttribute('width', String(base.width));
  svg.setAttribute('height', String(base.height));

  // ★ 两段用**同一个**画法：抽出来是为了让"线是怎么画的"只有一处 —— 两段各写一遍
  //   的话，改了曲率或留白只会改到其中一段，而图上看起来仍然像一张完整的图。
  const edge = (a, b, cur) => {
    if (!a || !b) return;                       // 只有一头在，宁可不画也不画半条
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const x1 = ra.right - base.left;
    const y1 = ra.top + ra.height / 2 - base.top;
    const x2 = rb.left - base.left;
    const y2 = rb.top + rb.height / 2 - base.top;
    const dx = Math.max(16, (x2 - x1) / 2);     // 三次贝塞尔，看着像一根松垂的线
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d',
      `M ${x1.toFixed(1)} ${y1.toFixed(1)} `
      + `C ${(x1 + dx).toFixed(1)} ${y1.toFixed(1)}, `
      + `${(x2 - dx).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`);
    // className 在 SVG 元素上是只读的，只能走 setAttribute
    p.setAttribute('class', cur ? 'edge cur' : 'edge');
    svg.append(p);
  };

  // 连接 → 工作区
  for (const c of boot.connections || []) {
    edge(mapNodes.conn.get(c.id), mapNodes.workspace.get(c.workspaceId),
      c.id === boot.activeConnectionId);
  }
  // 工作区 → 它引用的每一份数据。**同一份被两个工作区指着就是两条线** —— 那张图要说的
  // 就是这件事（各自一个下拉里看不出来）。
  for (const l of boot.workspaces || []) {
    const wnode = mapNodes.workspace.get(l.id);
    for (const sid of Object.values(l.refs || {})) {
      edge(wnode, mapNodes.space.get(sid), false);
    }
  }
}

/**
 * 就地改名。
 *
 * ★ 不用 window.prompt —— 它在 Electron 里**直接抛异常**
 *   （`prompt() is and will not be supported`），而不是返回 null。
 *   所以要自己在页面里摆一个 <input>。
 */
function startRename(l, nm) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename';
  input.value = l.name;
  input.maxLength = 40;

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;                 // 先置位：replaceWith 会触发 blur，不挡住会递归
    input.replaceWith(nm);
    if (!save) return;
    const name = input.value.trim();
    if (!name || name === l.name) return;
    const r = await window.slurmate.renameWorkspace({ workspaceId: l.id, name });
    if (!r.ok) return notice('error', r.error || '改名失败。');
    boot.workspaces = r.workspaces || boot.workspaces;
    renderConnections(boot.connections);   // 三处入口用的是同一份数据，一起重画
  };

  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  nm.replaceWith(input);
  input.focus();
  input.select();
}

// ── 插件 ────────────────────────────────────────────────────────────────────
/**
 * 画插件块。
 *
 * ★ 这个函数里**一个插件名都没有** —— 画什么完全由服务端通报的清单与本机注册表
 *   求交决定（见 index.js 的 pluginsView）。写死一个「开始开发」按钮的话，
 *   「站点卸载一个插件」在界面上就变成了"点了报错"，而不是"按钮不见了"。
 *
 * ★ 起不来的每一条原因都必须**分开显示**，因为它们要做的事不同：
 *     站点没开 → 找管理员          本机关了 → 自己打开就行
 *     站点没装作业侧 → 找管理员**重新部署**（开那个开关没用）
 *     本机没有 → 升级客户端        池里撞车 → 删掉多余的那一份
 *   糊成一句"不可用"，用户就只能去猜。那四句话在 WHY_NOT_RUNNABLE 里。
 */
function renderPlugins(pv) {
  const box = $('plugin-blocks');
  const issues = $('plugin-issues');
  box.textContent = '';
  issues.textContent = '';
  if (!pv) return;
  lastPlugins = pv;

  // 站点分发那一栏、待同意那一段、没加载的那些 —— 与插件块一起重画。
  renderSitePlugins(pv);
  renderConsent(pv);
  renderInert(pv);

  const list = pv.plugins || [];
  // ★ 空池是**正常状态**，不是故障。基座本来就不带插件 —— 所以这一段的任务不是
  //   道歉，是给出路：池在哪、怎么装、装完怎么让它出现。
  if (!list.length) box.append(emptyPool(pv));

  for (const p of list) {
    box.append(pluginBlock(p));
  }

  // ── 池里的问题：被跳过的东西必须说出来 ──
  for (const e of pv.errors || []) {
    issues.append(issueBox('err', '插件没有加载', e));
  }

  // ── ★★ 站点侧的问题：本站有包装不上（账本 **F22**）──────────────────────
  //
  // ★ 抬头**逐字沿用守护进程那两处**（`--check` 的 ⚠ 与 `start()` 的日志）：
  //   同一条规则一处措辞，三处说的是同一件事。改写成界面口气的话，运维会以为是
  //   第四种毛病，然后去查一条不存在的原因。（这一步不是修辞：`renderer.test.mjs`
  //   里有一条用例拿这三个字面量互相校，改一处就红。）
  //
  //   ★ `--check-plugins` 那句（`插件错误: …`）**故意不同**，别顺手统一：那一屏
  //     **不读站点配置**（它要能在一台配置读不出来的机器上跑，install-base.sh 也拿它
  //     预检**还没装进去**的源目录），所以它说的是"这个包本身装不装得上"，
  //     而这里说的是"本站**已经装着的**包哪个坏了" —— 两句话，两个时候。
  //
  // ★ `warn` 而不是 `err`：**它不阻塞任何东西**。守护进程照常跑、其余插件照常
  //   工作，只是少了这一个 —— 与上面 `errors` 那条（本机池里有东西没加载）分级
  //   相同，所以两块都不该读成"客户端坏了"。
  //
  // ★ `body` 是**站点原样报下来的字**，客户端一个字都不改写：那些句子是守护进程
  //   按它当下的诊断算出来的（哪个包、什么原因、下一步做什么）。在这里重写 = 造
  //   第二份会漂的真相 —— 而它漂的时候没有任何东西会红。
  //
  // ★ 与上面 `errors` **必须分开画**：主语不同（本机池 vs 站点），出路也不同
  //   （重新同步 vs 找管理员）。合成一列就把"是我这儿坏了还是本站装坏了"糊掉了。
  for (const p of pv.problems || []) {
    issues.append(issueBox('warn', '插件有问题（已跳过，其余插件照常工作）', p));
  }

  // ── 站点有而本机没有 ──
  //
  // ★ 「一个都没装」与「版本对不上」在 `missing` 里长得**一模一样**（都是"站点报
  //   了一个本机查不到的 (id, 版本)"），但要做的事完全不同：去装一个 vs 去换一版。
  //   判据是**池空不空** —— 不判的话，零插件时会对站点上每一个
  //   插件都喊一遍"升级客户端"，而真相是"你还没装插件"。
  const miss = pv.missing || [];
  if (miss.length) {
    // ★ 三条出路**必须分开说**，因为它们要做的事不同。合并成一句"本站有而本机
    //   没有 —— 升级客户端"的话，其中两条会被指错方向。
    const bySync = miss.filter((m) => m.distributed);
    const byHand = miss.filter((m) => !m.distributed);
    const names = (list) => list.map((m) => (m.version ? `${m.title} ${m.version} 版` : m.title)).join('、');

    if (bySync.length) {
      const site = pv.site || {};
      if (site.supported === false && site.reason === 'old_daemon') {
        issues.append(issueBox('warn', '本站提供的插件，本机没有',
          `${names(bySync)}。\n这个站点的守护进程太旧，不支持插件分发 —— `
          + '要让客户端自动取回它们，得请管理员升级站点上的守护进程。'));
      } else if (site.supported === false) {
        issues.append(issueBox('warn', '本站提供的插件，本机没有',
          `${names(bySync)}。\n${site.error || '这次没能从站点问到插件。'}`));
      } else if (pv.installedCount === 0) {
        issues.append(issueBox('warn', '本站提供的插件，本机一个都没有',
          `${names(bySync)}。\n本机还没有装上任何插件，所以上面一个按钮都没有 —— `
          + '点「重新同步」把它们取回来（带客户端代码的要你点一下同意）就会变成可以开始会话的块。'));
      } else {
        issues.append(issueBox('warn', '本站报的这几个版本，本机对不上',
          `${names(bySync)}。\n可能你装的是另一个版本，也可能同步还没跑到。`
          + '用上面的「重新同步」取一次。'));
      }
    }
    if (byHand.length) {
      issues.append(issueBox('warn', '本站报了这一版，但没有说它发得出来',
        `${names(byHand)}。\n这一份装不上：站点的清单里没有它的包，所以客户端无从取回。`
        + '请管理员确认这个插件是不是部署完整了。'));
    }
  }
}

/**
 * 本机一个插件都没有。
 *
 * ★ **别把"一个插件都没有"说成故障**（「这个客户端一个插件都没有 —— **安装包可能
 *   不完整**」）—— 那是一个**每个客户端都有的初始状态**，说成故障还没给出任何出路。
 *
 * ★ 这个空态的答案是"连上站点、点重新同步"：插件由站点分发，本机没有自装的入口 ——
 *   默认路径上"禁止自装"必须是真的。
 */
function emptyPool(pv) {
  const d = document.createElement('div');
  d.className = 'plug plug-off';

  const head = document.createElement('div');
  head.className = 'plug-head';
  head.append(el('h3', null, '本机还没有装上任何插件'));
  d.append(head);

  const site = pv.site || {};
  if (site.supported === false && site.reason === 'old_daemon') {
    d.append(el('p', 'plug-desc',
      '基座自己不带插件 —— 作业里跑什么由插件决定。而这个站点的守护进程太旧，'
      + '不支持插件分发，所以客户端没地方去取。请管理员升级站点上的守护进程。'));
  } else if (site.supported === false) {
    d.append(el('p', 'plug-desc',
      '基座自己不带插件 —— 作业里跑什么由插件决定。'
      + (site.error || '还没连上站点，所以还不知道本站有没有插件要给你。')));
  } else {
    d.append(el('p', 'plug-desc',
      '基座自己不带插件 —— 作业里跑什么由插件决定。本站会分发插件，'
      + '连上之后它们会出现在这里；带客户端代码的每一个都要你先点一下同意。'));
  }

  const row = document.createElement('div');
  row.className = 'plug-meta';
  row.append(button('重新同步', () => syncPlugins()));
  d.append(row);

  return d;
}

/**
 * ── 站点分发那一栏 ────────────────────────────────────────────────────────
 *
 * ★ 这里唯一值得显示的东西是**每个版本被哪些站点要** —— 它是"为什么这台机器上
 *   会有两个版本"这个问题的答案。没有它，用户面对两个同名的块只能猜。
 */
/**
 * 「站点太新」那一句：**正文一行**（事实 + 该做什么），理由挂 `title`。
 *
 * ★ 它不是一个泛泛的"解释收进悬停"：这句话有**两个方向**（升级客户端 / 升级没用），
 *   指错了用户就会去做一件解决不了问题的事。所以正文那一行必须是**那个方向**，
 *   而 `title` 里放的是"凭什么这么判"。
 */
function versionWhy(host, line, why) {
  const p = el('p', 'why', line);
  p.title = why;
  host.append(p);
  return p;
}

/**
 * 「安装插件…」—— **只在假站点上画**（判据是主进程给的能力位 `site.canInstall`）。
 *
 * ★ 它装的是**真站点上装的同一个东西**：一个 `.splug`，放进站点的插件目录里，
 *   站点当场重扫。所以那之后的每一步（站点报它 → 客户端取回来 → 过同意闸 →
 *   加载）**没有一处特判** —— 这颗按钮存在的全部意义，就是让那条路在开发者模式
 *   里也真的走一遍。
 *
 * ★ 装不上就说清为什么（同 id 已有一棵树、包装不上、清单不合法……），而那些话
 *   **由主进程给**：只有它知道站上现在有什么。界面不在这里重写一遍判据。
 */
function siteInstallButton() {
  const btn = button('安装插件…', async () => {
    const r = await window.slurmate.installSitePlugin();
    // 选空了 = 用户按了取消。那不是一次失败，一声不吭。
    if (r && r.cancelled) return;
    if (r && r.plugins) renderPlugins(r.plugins);
    // ★ 装上去了那一条由**主进程**推进提示流（它顺带说了装到哪儿、接下来会怎样）——
    //   这里再说一遍就是同一件事说两次。失败要说：那时主进程只回了一个返回值。
    if (!r || !r.ok) notice('error', (r && r.error) || '没能把这个包装到假站点上。');
  }, 'ghost tiny');
  btn.title = '挑一个 .splug（打包器产出的那个文件）装到这台假站点上 —— 与真站点上'
    + ' `slurmate plugin install` 装的是同一份东西。装上去之后站点当场就报它，'
    + '接下来与真站点逐字一样：取回来、过同意闸，然后才可用。';
  return btn;
}

function renderSitePlugins(pv) {
  const box = $('site-plugins');
  box.textContent = '';
  const site = pv.site;
  // 站点连不上时也要画 —— 池里可能已经有东西了，而"每个版本被谁要"是那一栏
  // 唯一值得显示的东西。池的路径在主进程给（`pv.sitePoolDir`）。
  if (!site && !pv.sitePoolDir) return;

  const d = document.createElement('div');
  d.className = 'plug plug-off';
  const head = document.createElement('div');
  head.className = 'plug-head';
  head.append(el('h3', null, '站点分发'));
  // ★ 「安装插件…」**只在假站点上画**，判据是主进程给的能力位（`site.canInstall`），
  //   不是在这里问后端叫什么 —— "哪条路属于哪一侧"那条分界只有主进程判得了，
  //   而权威闸门也在那边（见 `app:installSitePlugin`）。这里画的是一颗**按钮**，
  //   不是一道防线：真站点上它不出现，真出现了主进程也会拒。
  if (site && site.canInstall) head.append(siteInstallButton());
  d.append(head);

  if (!site) {
    d.append(el('p', 'plug-desc', '还没连上站点。插件是从站点取回来的 —— 连上之后这里会显示详情。'));
  } else {
    const bits = [];
    bits.push(site.label ? `站点 ${site.label}` : '本站');
    if (site.syncedAt) bits.push(`上次同步 ${new Date(site.syncedAt).toLocaleTimeString()}`);
    d.append(el('p', 'plug-desc', bits.join(' · ')));

    if (site.reason === 'old_daemon') {
      d.append(el('p', 'why', '这个站点的守护进程太旧，不支持插件分发。'));
    } else if (site.reason === 'site_too_new') {
      // ★ 与「守护进程太旧」**不是同一件事**，方向正好相反：那一个是站点落后于
      //   客户端，这一个是**客户端落后于站点** —— 该做的是升级这个客户端。
      //   两者合并成一句"版本对不上"的话，用户会去找管理员，而管理员那边一切正常。
      //
      // ★ **没有退路可退**：那些插件是**真的装不上**，而这句话必须
      //   这么说；含糊成"能装上就好"会让用户以为已经好了，其实一个都没装上。
      //
      // ★★ 而**版本握手让这句话能说得更准**：客户端手里有服务端的
      //   真版本号，所以"站点比客户端新"是一个**被检验过
      //   的结论**，不是**推断**：
      //     · 跨大版本 ⇒ 站点是新一代是**对的**，那时格式更新本就在预期之内；
      //     · 其它情形（握手说客户端不低于服务端）⇒ 服务端**不可能更新** ⇒
      //       格式比客户端新只可能是**站点自己不一致**（版本号没升而格式升了，
      //       违反了"格式号只因基座版本升而升"那条纪律）。说成"升级客户端"会把
      //       用户指去干一件**解决不了问题**的事。
      // ★★ 正文只留**一行**：说事实 + 说该做什么。上面那一大段推理（为什么这一支
      //    说"升级客户端"、那一支说"升级解决不了"）搬进 `title` —— 它是**理由**，
      //    而用户此刻的动作只有两个方向，一行就够把他指对。这也正是它必须分叉的
      //    理由：指错了方向，用户会去做一件解决不了问题的事。
      if (site.daemonVersionVerdict === 'cross_major') {
        versionWhy(d, '这个站点发的插件包格式比本客户端新，这一版取不回来 —— 请升级这个客户端。',
          '这个集群的服务端与本客户端大版本不同，所以那些插件包用的是更新的格式，'
          + '而这一版的客户端没有别的办法把它取回来。请升级这个客户端。');
      } else {
        versionWhy(d, '这个站点发的插件包格式比本客户端新，而它报的基座版本并不更新 —— 升级客户端解决不了它。',
          '升级客户端解决不了它：这个站点报的基座版本并不比本客户端新，'
          + '所以"包格式比客户端新"只可能是站点自己不一致（版本号没升，包格式却升了'
          + '—— 那违反了"格式号只因基座版本升而升"这条纪律）。升级客户端是把用户指去'
          + '干一件解决不了问题的事，所以这一支必须明说。请让管理员看这个站点的部署。');
      }
    } else if (site.error) {
      d.append(el('p', 'why', site.error));
    } else {
      const st = site.supported
        ? '本站支持分发插件。'
        : '本站没有说它支不支持分发插件。';
      d.append(el('p', 'plug-desc',
        st + (site.failed && site.failed.length
          ? `这一轮有 ${site.failed.length} 个没装上，见下面的报错。` : '')));
    }
    // 记录读不出来 ⇒ **一个版本都不会被回收**。这是用户该知道的一件事：
    // 他可能发现池子越来越大，而原因在这里。
    if (site.snapshotOk === false) {
      d.append(el('p', 'why',
        '站点的插件快照表读不出来（或者写不下去），所以这一轮没有回收任何旧版本 —— '
        + '不知道谁在引用的时候，唯一安全的动作是什么都不删。'));
    }

    // §5.3：本机那一份不在了 ⇒ 同意作废，本轮会重新问一次。
    // ★ **不说"是你删的"** —— 客户端不知道原因（可能是他删的，可能是别的什么）。
    if (site.withdrawn) {
      d.append(el('p', 'why',
        `有 ${site.withdrawn} 个插件本机那一份已经不在了，所以它们上一次的同意已经作废 —— `
        + '本轮会重新问一次。删掉本机一份就等于撤回同意：不这么算的话，下一次对账会'
        + '按"摘要与上次一致"把它静默装回来。'));
    }

    const vs = site.versions || [];
    if (vs.length) {
      const ul = document.createElement('ul');
      ul.className = 'plug-vers';
      for (const v of vs) {
        const li = document.createElement('li');
        li.append(el('code', 'plug-id', v.version));
        li.append(document.createTextNode(v.wantedBy.length
          ? `被 ${v.wantedBy.join('、')} 要`
          : '没有任何站点要它（下次同步时会被回收）'));
        ul.append(li);
      }
      d.append(el('p', 'plug-desc', '本机站点池里的版本：'));
      d.append(ul);
    }

    // ★ 池里"不是槽位"的那几项 —— **只报不删**（§5.1：手工放置必须不产生任何
    //   效果，而删掉它是一种效果）。报出来只是为了让"池里到底有什么"有一个诚实的
    //   答案：旧版本留下的目录会静静地躺在那儿，而它们不生效这件事本身没有任何
    //   地方会说出来。措辞只说事实，不说"可以删掉"——那是用户自己的目录。
    const strays = site.strays || [];
    if (strays.length) {
      d.append(el('p', 'plug-desc',
        `池里还有 ${strays.length} 项不是插件（${strays.slice(0, 5).join('、')}`
        + `${strays.length > 5 ? ' 等' : ''}）—— 它们不生效、也没有被动过。`));
    }
  }

  const row = document.createElement('div');
  row.className = 'plug-meta';
  row.append(button('重新同步', () => syncPlugins()));
  d.append(row);
  box.append(d);
}

/**
 * ── 待同意 ────────────────────────────────────────────────────────────────
 *
 * ★ **不是 `runnable` 的第五档。** WHY_NOT_RUNNABLE 那四句话说的是"这个插件
 *   **起不来**的原因"，而"还没同意"是"**还没到手**" —— 与 `missing` 同一类。
 *
 * ★ **同意界面的措辞就是这一版唯一的安全边界**（进程隔离还没做）。所以它必须把
 *   话说满：同意一个带客户端代码的插件 = 把你这台工作站的代码执行权交给集群管理员。
 *   含糊的"是否信任此插件"会让用户以为自己在同意 A 而实际同意了 B —— 那正是这个
 *   项目最恨的那类问题换了个地方出现。
 */
function renderConsent(pv) {
  const box = $('plugin-consent');
  box.textContent = '';
  const list = pv.consent || [];
  if (!list.length) return;

  const d = document.createElement('div');
  d.className = 'plug plug-consent';
  const head = document.createElement('div');
  head.className = 'plug-head';
  head.append(el('h3', null, `本站要给你 ${list.length} 个插件`));
  d.append(head);
  // ★ 两种情形的说法**必须不同**，因为它们的出路不同：
  //   一份还在暂存里等换入（同意 = 装上去，不同意 = 丢掉草稿），
  //   另一份**已经在池子里**、只是台账对不上（同意 = 原地认领，不同意 = 删掉那一份）。
  //   共用一句的话，用户在第二种情形下会以为自己面对的是"还没下来的东西"。
  const anyNew = list.some((c) => !c.existing);
  const anyHere = list.some((c) => c.existing);
  d.append(el('p', 'plug-desc',
    (anyNew ? '它们已经取回到本机、包里每一份都核过了，但还没有装上去 —— 要你先点一下同意。' : '')
    + (anyNew && anyHere ? '\n' : '')
    + (anyHere ? '另外有几个本机已经有一份，而它没有在同意台账里（你换过机器、'
      + '删过配置、或者上一次的同意已经作废）。它们的客户端代码没有在跑 —— '
      + '同意就是认领本机那一份，不同意就是把它从本机删掉。' : '')));

  for (const c of list) {
    const one = document.createElement('div');
    one.className = 'plug-consent-item';
    const h = document.createElement('div');
    h.className = 'plug-head';
    h.append(el('h3', null, c.title || c.name));
    h.append(el('code', 'plug-id', c.name));
    h.append(el('span', 'plug-ver', 'v' + c.version));
    one.append(h);

    const who = document.createElement('p');
    who.className = 'why';
    who.textContent = `来自 ${c.siteLabel || '本站'}，共 ${c.fileCount} 份文件。`
      + (c.existing ? '这一份已经在你的本机上了。' : '');
    one.append(who);

    // ★ 第二次之后的同意要显示**变了什么**。只显示一个摘要等于什么也没说。
    //
    // ★ 而"变了什么"有**两种**，绝不能混成一句：内容变了（同一个版本号下换了一份
    //   东西 —— 那是要警惕的），与**换算法了**（我们换了一把尺子 —— 那条老记录
    //   上的值与这个新值本来就不该放在一起比）。合并的话，一次客户端升级会对每个
    //   每个插件喊一句"内容变了"，而那正是"狼来了"。
    const digestLine = document.createElement('p');
    digestLine.className = 'plug-desc';
    const algChanged = c.previous && c.previous.alg !== c.digestAlg;
    if (c.previous && !algChanged) {
      digestLine.textContent = c.previous.digest === c.digest
        ? `内容摘要 ${c.digest}（与上次同意的一致）`
        : `⚠ 内容摘要从 ${c.previous.digest} 变成了 ${c.digest} —— `
          + '同一个版本号下的内容变了。请确认这是你要的，再决定。';
    } else if (c.previous) {
      digestLine.textContent = `内容摘要 ${c.digest}（本机记的那一条是另一种算法算的，`
        + '两者不可比 —— 所以这一次要你重新确认一遍。这不是"内容变了"）';
    } else {
      digestLine.textContent = `内容摘要 ${c.digest}（算法 v${c.digestAlg}）`;
    }
    one.append(digestLine);
    // ★ 上面那一句里的是**短形**（16 位，人一眼分得开就行），而**完整 64 位也
    //   画出来**：它与守护进程 `--check-plugins` 那一屏报的、作者那边
    //   `packer inspect` 报的是同一个数，而那两处都**刻意不截断**（理由写在
    //   `--check-plugins` 那一段：服务器上没有源码树，只有这两个数能回答"装上去
    //   的这一份是不是作者发布的那一份"）。同意闸问的正是"你信不信这一份"，而
    //   唯一能拿去逐个字符核对的凭据就是这个数 —— 只给前 16 位等于在最需要它的
    //   地方把它藏起来。
    if (typeof c.fullDigest === 'string' && c.fullDigest) {
      const fullLine = document.createElement('p');
      fullLine.className = 'plug-desc';
      fullLine.append(el('code', 'plug-id', c.fullDigest));
      one.append(fullLine);
    }

    // §5.4：这一份是谁签的。**没有签名也是一句必须说的话** —— 留白会被读成
    // "还没显示出来"。
    const who2 = document.createElement('p');
    who2.className = 'why';
    who2.textContent = c.fingerprint
      ? `签名者指纹 ${c.fingerprint}。本机第一次接受这个 id 时会记下它，`
        + '此后同一个 id 的每一份都必须由同一把钥匙签 —— 换了人就会拒绝。'
      : '这一份没有签名。签名在插件规范里是可选的（§4.1），所以这不是错误；'
        + '但它意味着"内容与上次一致"是这里唯一能给你的保证。';
    one.append(who2);

    // ★ 这一句**留着**，而且是这一版唯一的安全边界（进程隔离还没做）：
    //   同意一个带客户端代码的插件 = 把工作站的代码执行权交给集群管理员。
    //   压到一行：「不同意会怎样」由那颗按钮自己的措辞说（「不同意，删掉本机
    //   这一份」/「不同意」）—— 按钮能说清的事，不必再写一句在旁边。
    const warn = document.createElement('p');
    warn.className = 'why';
    warn.textContent = '同意之后，这个插件的客户端代码会在你这台机器上运行'
      + '（与客户端同一个进程、同样的权限，目前没有进程隔离）。不确定来源时不要同意。';
    one.append(warn);

    const row = document.createElement('div');
    row.className = 'plug-meta';
    row.append(button(c.existing ? '同意，用它' : '同意并装上', () => consentPlugin(c.id, c.version)));
    row.append(button(c.existing ? '不同意，删掉本机这一份' : '不同意',
      () => rejectPlugin(c.id, c.version), 'ghost'));
    one.append(row);
    d.append(one);
  }
  box.append(d);
}

/**
 * ── 池里那些**没被加载**的 ────────────────────────────────────────────────
 *
 * ★ 这一块是补一个**真的洞**（不是美化）：在它之前，"池里有一份、台账对不上"的
 *   站点插件**两条路都不在** —— 插件那一列把 `active === false` 的滤掉了，
 *   而"本站有而本机没有"那一列要求注册表里**查不到**它（它恰恰查得到，只是没有
 *   钩子）。于是界面上彻底看不见，连一个能点的东西都没有，重新同步也救不回来。
 *   摘要换一次公式就会对**每个用户的每个插件**成立 —— 集体消失、无从恢复。
 *
 * ★ 为什么不给"同意"按钮：这一块里的那些**站点此刻没有在报它们**，所以没有一个
 *   说得出口的"要不要装这一份"可问。能做而且该做的是一个**出口** —— 删掉本机
 *   这一份（§5.3：删掉 = 撤回同意，于是下次对账重新问）。在此之前连那个都没有。
 */
function renderInert(pv) {
  const box = $('plugin-inert');
  box.textContent = '';
  const list = pv.inert || [];
  if (!list.length) return;

  const d = document.createElement('div');
  d.className = 'plug plug-off';
  const head = document.createElement('div');
  head.className = 'plug-head';
  head.append(el('h3', null, `本机有 ${list.length} 个插件没有被加载`));
  d.append(head);
  d.append(el('p', 'plug-desc',
    '它们已经在你的本机上了（是站点分发下来的），而它们的客户端代码没有在跑。'
    + '原因只有一个：你还没有同意过这一份，而本站此刻没有在报它们 ——'
    + '所以暂时没有"同意"这个入口（管理员把插件关掉了的时候就是这样）。'));
  d.append(el('p', 'plug-desc',
    '它们不会被加载，也不会被回收：站点不报一个插件不构成删除它的理由 ——'
    + '它随时可能再打开。把你不要的那一份删掉就行，下一次对账会重新问你一次。'));

  for (const p of list) {
    const one = document.createElement('div');
    one.className = 'plug-consent-item';
    const h = document.createElement('div');
    h.className = 'plug-head';
    h.append(el('h3', null, p.title || p.name));
    h.append(el('code', 'plug-id', p.name));
    h.append(el('span', 'plug-ver', 'v' + p.version));
    one.append(h);
    const row = document.createElement('div');
    row.className = 'plug-meta';
    row.append(button('删掉本机这一份', () => dropPluginVersion(p.id, p.version), 'ghost'));
    one.append(row);
    d.append(one);
  }
  box.append(d);
}

/**
 * 「本机的插件数据」那一块。
 *
 * 主进程已经把"没人用的"算好了（`app:pluginData`），这里只画。**在用的那些不列** ——
 * 它们不是"问题"，而且那件事有更好的走法：换一个工作区（`＋ 新建空白工作区…`）会换
 * 分区、重建视图、由插件重新登录，那正是"重置"。
 *
 * ★ 两种"什么都没有"要分开：
 *   · **查过了、真没有** ⇒ 整节收起来（与 `#plugin-inert` 同一个形状）；
 *   · **这一次没能查**（`diskChecked:false`）⇒ **要画出来**。不说"查不了"就等于说
 *     "没有"，而那是两件事 —— 这个界面里到处都是这条纪律。
 */
function renderPluginData(d) {
  const sec = $('sec-data');
  const box = $('plugin-data');
  box.textContent = '';

  const rows = (d && d.rows) || [];
  if (d && d.ok === false) {
    sec.classList.remove('hidden');
    box.append(el('p', 'plug-desc', d.error || '本机的插件数据没能列出来。'));
    return;
  }
  // ★★ **收掉过东西的时候，这一屏不许藏。**
  //   自动回收把孤儿清干净之后 `rows` 正好是空的 —— 而"清单里没有东西了"与
  //   "这一次启动清掉了三份"是两件完全不同的事：只判 `rows` 的话，那一行
  //   **永远画不出来**（删除就成了用户看不见的），而它画的正是"删的是自动化，
  //   不是可见性"这句唯一的兑现处。★ 与账本 F35 同一个形状：算出来了、没送到。
  const reclaimed = (d && d.reclaimed) || { count: 0, items: [], failed: [] };
  const didReclaim = reclaimed.count > 0
    || (Array.isArray(reclaimed.failed) && reclaimed.failed.length > 0);
  if (!rows.length && !didReclaim && d && d.diskChecked) {
    sec.classList.add('hidden');
    return;
  }
  sec.classList.remove('hidden');

  const wrap = document.createElement('div');
  wrap.className = 'plug plug-off';
  // ★★ 整屏认不出时**标题也要跟着改**：下面那些行不是"没人用的插件数据"，
  //   而是"我一个都不认识的目录" —— 标题说成前者就是在替它们编一个身份。
  const allUnknown = Boolean(d && d.allUnknown);
  const head = document.createElement('div');
  head.className = 'plug-head';
  head.append(el('h3', null, allUnknown
    ? `插件数据目录里有 ${rows.length} 个目录，一个都认不出`
    : (rows.length
      ? `本机有 ${rows.length} 份插件数据没人在用`
      : '本机的插件数据')));
  wrap.append(head);

  // ★★ **这一次运行收掉了什么** —— 自动回收的留痕（`index.js` 的 `reclaimOrphans`）。
  //   它是"删的是自动化，不是可见性"这句话唯一的兑现处，所以话要说满：几份、都是谁。
  //   ★ "本次运行"而不是"本次启动"：那一格是**累计**的，而回收跟着对账走 ——
  //     对账今天只在打开客户端时跑一次，但这句话不该依赖那件事（见 `lastReclaim`）。
  //   ★ 它排在下面那段说明**前面**：这一段说的是"刚刚发生过的事"，而下面那段说的是
  //     "下面这份清单是干什么的"。
  if (reclaimed.count > 0) {
    const who = (reclaimed.items || []).map((i) => i.label).filter(Boolean);
    wrap.append(el('p', 'plug-desc',
      `本次运行清掉了 ${reclaimed.count} 份没人管的数据`
      + (who.length ? `（${who.join('；')}）` : '')
      + '。它们按现在装着的插件再也读不到了 —— 那个插件卸载了、那个工作区删了、'
      + '或者插件换了共享组 —— 留着只会越攒越多，所以对账时自动收掉了。'));
  }
  if (Array.isArray(reclaimed.failed) && reclaimed.failed.length) {
    wrap.append(el('p', 'plug-desc',
      `还有 ${reclaimed.failed.length} 份没能清掉`
      + `（${reclaimed.failed.map((f) => `${f.name}：${f.error}`).join('；')}）。`
      + '它们还在盘上，下一次对账会再试一次。'));
  }

  if (!d || !d.diskChecked) {
    wrap.append(el('p', 'plug-desc', (d && d.why)
      || '这一次没能去看磁盘上还剩哪些，所以这里没有东西可列。'));
  } else {
    if (allUnknown) {
      // ★ 这一句是**插件数据目录那一根唯一的防线**（它是我们自己拼出来的，
      //   没有任何探针能当场核对它 —— 见 plugin-data-audit.js 里 `allUnknown`）。
      //   所以话要说满：说出"多半是根取错了"，也说出"下面为什么一个按钮都没有"。
      wrap.append(issueBox('warn', '这一屏的目录一个都认不出',
        '本机有两处放插件数据：Electron 那棵存储分区目录（那一根是问 Electron'
        + '要来的，还当场核对过名字），以及本程序自己拼出来的插件数据目录。'
        + '一整屏都认不出，更像"其中某一根指到了别的地方"，而不是"你攒了一堆垃圾"。'
        + '⇒ 下面一个删除按钮都没有，这是故意的：一份我不认识的东西，'
        + '删掉它不是"收拾"而是"猜"。重启一次看看还在不在；还在的话值得报出来。'));
    }
    // ★ 这里从前有一段解释"一份数据是什么、它的两个落点在哪"。删掉了：**每一行
    //   自己就在说这件事**（`placesText(r.places)` 逐行说清它在浏览器里、在磁盘上
    //   还是两处都有），而那张映射图的右列说的是"它被谁指着"。一段统论说不出
    //   单行说不出的事，只会让人多读一遍。
    wrap.append(el('p', 'plug-desc',
      '删掉一份找不回来 —— 那个插件下次打开会是一份全新的空白存储。'
      + '想重置正在用的那一份，用工作区下拉里的「＋ 新建空白工作区…」。'));
  }

  for (const r of rows) {
    const one = document.createElement('div');
    one.className = 'plug-consent-item';
    const h = document.createElement('div');
    h.className = 'plug-head';
    h.append(el('h3', null, r.label));
    one.append(h);
    one.append(el('p', 'plug-desc', r.why));
    // ★ 说清**删掉的是什么**：这一份可能在浏览器里、在磁盘上、或者两处都有。
    one.append(el('p', 'plug-meta', placesText(r.places)));
    if (r.deletable) {
      const row = document.createElement('div');
      row.className = 'plug-meta';
      // ★ **两段式**（`armConfirm`）：这一份删了就没了 —— 浏览器里的布局/标签页/
      //   登录状态，以及插件自己写在磁盘上的东西（那个插件最可能放"重建不出来"
      //   的文件的地方）。这是五处两段式之一，判据是**代价**，不是"不可逆"
      //   （同一条规矩下，「重新生成密钥」是一下就走 —— 它要作废的是一把还没
      //   派上用场的公钥，而它旁边就写着"新公钥必须重新注册"）。
      const del = button('删掉这一份', null, 'ghost');
      del.onclick = () => armConfirm(del, {
        why: `删掉「${r.label}」？${placesText(r.places)}删掉之后找不回来。`,
        yes: '删掉',
        run: () => dropPluginData(r),
      });
      row.append(del);
      one.append(row);
    }
    wrap.append(one);
  }
  box.append(wrap);
}

/**
 * 这一份数据在哪儿 —— ★ 删除按钮的确认框要靠它说清**删掉的是什么**。
 *
 * 两个落点不能混成一句：浏览器里那份是布局/标签页/登录状态，而磁盘上那份是插件
 * 自己写的东西 —— 后者正是作者最可能放"重建不出来"的东西的地方（sshd 就把它的
 * ssh 配置与一把钥匙放在那儿）。两者都不可逆，但**用户能预期的东西不同**。
 */
function placesText(places) {
  const p = (places || []).includes('partition');
  const d = (places || []).includes('data');
  if (p && d) return '它有两部分：浏览器里的存储（布局、标签页、登录状态），'
    + '以及那个插件写在磁盘上的文件。';
  if (d) return '它是那个插件写在磁盘上的文件。';
  return '它在浏览器里（那个插件没有另外往磁盘上写东西）。';
}

/**
 * 删掉一份插件数据。**真的删**。
 *
 * ★★ 那个"问一句"在**调用点**（`renderPluginData` 里那颗按钮上的 `armConfirm`），
 *   不在这里。它从前是这里的一句 `window.confirm` —— 换掉的理由与别处同源：
 *   `window.confirm` 给不了两段（框弹出来的时候用户**已经按下去**了），
 *   而样式也不受控（在 Electron 里那是一块系统窗口）。
 *   ★ 于是这个函数可以被任何调用点直接用而不会弹框 —— 它只做那件事。
 */
async function dropPluginData(r) {
  const res = await window.slurmate.deletePluginData({ name: r.name });
  if (!res || !res.ok) {
    // `stale` 由主进程给一句能直接读的话（判定权在它那儿）。
    return notice('error', (res && res.error) || '没能删掉。');
  }
  notice('info', `已删掉「${res.label || r.label}」。`);
  renderPluginData(res);
}

// ★ **这里没有"开发者"那一节**：没有「也加载本机插件目录（开发用）」的复选框，也
//   没有「从一个包安装…」「打开插件目录」「重新扫描」三个按钮。池子只有一条来的
//   路（站点分发），所以这里没有开关可藏。
//
//   ★ 而"把那些入口默认藏起来"从来不是禁令 —— 一个需要靠"默认藏起来"才成立的禁令
//   不是禁令，是一个开关。`packer/docs/PLUGIN-SPEC.md` §5.2 要的是**没有分支**
//   （"禁止给任何一类插件开免同意的口子"）。

async function syncPlugins() {
  const r = await window.slurmate.syncPlugins();
  if (r && r.plugins) renderPlugins(r.plugins);
  else notice('error', (r && r.error) || '重新同步失败');
}

async function consentPlugin(id, version) {
  const r = await window.slurmate.consentPlugin(id, version);
  if (r && r.plugins) renderPlugins(r.plugins);
  if (!r || !r.ok) notice('error', (r && r.error) || '没能同意这个插件');
}

async function rejectPlugin(id, version) {
  const r = await window.slurmate.rejectPlugin(id, version);
  if (r && r.plugins) renderPlugins(r.plugins);
  if (!r || !r.ok) notice('error', (r && r.error) || '没能处理这个插件');
}

/** §5.3：删掉本机那一份 = 撤回同意。下一次对账会重新问一次。 */
async function dropPluginVersion(id, version) {
  const r = await window.slurmate.dropPluginVersion(id, version);
  if (r && r.plugins) renderPlugins(r.plugins);
  if (!r || !r.ok) notice('error', (r && r.error) || '没能删掉本机那一份');
}

/** 建一个按钮。CSP 里没有 unsafe-inline，所以一律走 class，一个 style 都不能有。 */
function button(text, onclick, cls) {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.className = cls;
  b.onclick = onclick;
  return b;
}

/**
 * 「这个插件起不来」的四条原因 —— 一个原因一句话，写在**一起**。
 *
 * ★ 四句话必须互不相同：分开它们的是"这件事该谁去做"。合并成一句「这个插件用不了」
 *   的话，用户就只能一个个试 —— 而其中两条**都要找管理员**，但**是两件不同的事**
 *   （一个是开关没开，管理员开一下就好；一个是本站部署没跟上，管理员去开开关没用）。
 *   `test/renderer.test.mjs` 钉着"四句互不相同、且都不是空话"这一条。
 *
 * `noJob` 里的 `%s` 是插件名（用 `replace` 而不是模板串，是为了让那四句话在这个
 * 字面量里各自完整 —— 检查才做得成）。
 */
const WHY_NOT_RUNNABLE = {
  siteUnknown: '这个守护进程不通报插件清单，所以客户端不知道站点开没开它。',
  siteOff: '本站没有开放这个插件 —— 要开的话得找管理员。',
  localOff: '你在本机把它关掉了 —— 勾上左边那个开关就能用。',
  noJob: '本站装了「%s」，但它没有作业侧实现 —— 提交不了，得找管理员重新部署。',
};

/**
 * 这个插件为什么起不来。四选一，见 WHY_NOT_RUNNABLE。
 *
 * `runnable` 是三个条件的求交（站点开没开 / 本机关没关 / 站点有没有作业侧），
 * 分支顺序与之对应 —— **先说的那个是"最外层"的原因**，也正是用户最该先去解决的那件。
 */
function whyNotRunnable(p) {
  if (!p.siteEnabled) {
    return p.siteKnown ? WHY_NOT_RUNNABLE.siteOff : WHY_NOT_RUNNABLE.siteUnknown;
  }
  if (p.locallyEnabled === false) return WHY_NOT_RUNNABLE.localOff;
  return WHY_NOT_RUNNABLE.noJob.replace('%s', p.title);
}

/** 当前活跃那条连接。插件块上那一格问的就是**它**的工作区 —— 与「开始会话」同一条。 */
function activeConn() {
  const id = boot && boot.activeConnectionId;
  return ((boot && boot.connections) || []).find((c) => c.id === id) || null;
}

/**
 * 「还有谁在用这一份数据」—— 一句跟在端口后面的小字。
 *
 * ★ 它是**反查**，不是推导：`boot.workspaces` 是主进程算好的那张引用表，这里只是
 *   拿一个数据 id 去问"哪几个工作区的表里指着它"。查错了的代价是一句注释不准
 *   （不是一次删错东西）—— 真正不可逆的判断全部留在主进程。
 * ★ 不含**当前这个**工作区：用户看的是"除了我这里，还有谁"。
 */
function spaceUsersOf(spaceId, workspaceId) {
  const names = (boot.workspaces || [])
    .filter((l) => l.id !== workspaceId
      && Object.values(l.refs || {}).includes(spaceId))
    .map((l) => `「${l.name}」`);
  return names.length ? `${names.join('、')}也在用` : '';
}

/**
 * 插件块上那一格：**这个插件用哪一份数据**。
 *
 * ★ 主体是**当前活跃连接的工作区**（与旁边那个「开始会话」按钮同一条连接）——
 *   用户在连接列表里选哪条，这一格说的就是哪条。没有活跃连接（开发者模式、或者
 *   一条连接都还没有）时**不画**：那一格答的问题在那时不存在，画一个空下拉
 *   等于凭空许诺一个不存在的东西。
 *
 * ★ 三种取值与「③ 工作区」**同一套约定**（键缺席 / `null` / 一个 id），
 *   逐一写在 `applyPluginSpace` 上面。
 *
 * ★ 选项只有**这个插件现在读得到的那几份**（`pluginId` 与 `group` 都要对得上，
 *   由主进程现算的 `p.group` 给判据）。列一份指过去读不通的数据，用户点下去
 *   只会得到一句报错 —— 那比不列更坏。
 */
function pluginSpaceRow(p) {
  const conn = activeConn();
  const ws = conn ? workspaceById(conn.workspaceId) : null;
  if (!ws) return null;

  const usable = (boot.spaces || [])
    .filter((s) => s.pluginId === p.id && s.group === p.group);
  const cur = (ws.refs || {})[p.id] || '';
  const known = usable.some((s) => s.id === cur);

  const row = document.createElement('div');
  row.className = 'plug-data';

  const lab = document.createElement('label');
  lab.className = 'plug-data-lbl';
  lab.textContent = '数据';
  lab.title = `这条连接（${conn.label || `${conn.user}@${conn.host}`}）的`
    + `「${ws.name}」里，这个插件用哪一份数据。一份数据 = 一个本地端口 + 一份浏览器`
    + '存储（登录状态、窗口布局），它可以被几个工作区共用 —— 共用就是它们看到同一份。';

  const sel = document.createElement('select');
  sel.className = 'plug-space';
  sel.setAttribute('aria-label', '这个插件用哪一份数据');

  // ★ 只在**这一格还是空的**时候才有"跟随默认"那一项：已经有了的那一份**就是**
  //   现在的值，再摆一个"默认"只会让下拉停在一个不生效的值上。
  if (!known) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '默认：第一次开会话时新建一份';
    sel.append(o);
  }
  usable.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = s.id;
    const users = spaceUsersOf(s.id, ws.id);
    o.textContent = `数据 ${i + 1} · 端口 ${(s.ports || [])[0]}`
      + (users ? `（${users}）` : '');
    sel.append(o);
  });
  const nu = document.createElement('option');
  nu.value = NEW_SPACE;
  nu.textContent = '＋ 另开一份（从空白开始）';
  sel.append(nu);

  // ★ `NEW_SPACE` 与 `''` 都要**原样留住**：前者是用户显式要另开一份，后者是"这一格
  //   还没有值"。一个"找不到就空着"的兜底会把它们悄悄换成空串 —— 于是"另开一份"
  //   变成"什么都不做"，而用户看到的是下拉弹回了默认那一项，没有任何一句话解释。
  sel.value = (cur === '' || cur === NEW_SPACE || known) ? cur : '';

  sel.onchange = async () => {
    const v = sel.value;
    // 键**缺席** = 没表态（只有"默认"那一项给得出这个值）。
    const arg = v === NEW_SPACE ? null : (v === '' ? undefined : v);
    const r = await applyPluginSpace(ws.id, p.id, arg);
    // 没成功就把下拉拨回真实的那一格（重建整块 → 下拉按 `refs` 重新选中）。
    // ★ `lastPlugins` 为空时**什么都不做**：`renderPlugins(null)` 会把整块插件列表
    //   清空 —— 那比"下拉停在错的值上"严重得多。
    if (!r.ok && lastPlugins) renderPlugins(lastPlugins);
  };

  row.append(lab, sel);
  return row;
}

/**
 * 换「这个插件用哪一份数据」。
 *
 * ★ 今天只有**一个**入口（插件块上那一格），但仍然单独成一个函数：它与
 *   `applyWorkspace` 是同一条路子（先做、被拒了再问、成了再重画），而那一条路里
 *   每一格都是踩过的坑。等"从别的工作区复用一份过来"那个入口出现时，它走这里 ——
 *   而不是在旁边长出第二份长得差不多的实现。
 *
 * ★ 三种取值（与「③ 工作区」同一套，主进程那边是**三件事**）：
 *     键**缺席**（`undefined`）= 用户没表态 ⇒ 什么都不做
 *     `null`                  = 要一份**新的**（哪怕现在已经有一份）
 *     一个 id                 = 就用那一份
 *   ★ 界面**不自己算**"应当是哪一份"：那样算出来的值是上一个字算的（工作区刚换过、
 *     或者插件刚重新同步过），而用户按下去的是此刻。
 *
 * ★ 先做、被拒了再问（与 `applyWorkspace` 同一套路）：旧那一份会不会被删掉、以及
 *   这张表是不是被几条连接共用，都由**主进程**判定 —— 界面手里那份引用计数随时
 *   可能已经陈旧，而"我删掉了你那份数据"必须是真的才会说出口。
 *
 * ★ **两道问按主进程给的次序走，而重试要把前面已经答过的带上**（`extra`）：
 *   分叉之后旧那一份通常还是不会被删（原表还在指着它），但如果用户选了「全部一起改」，
 *   第二问照样会来 —— 那时若把 `scope` 丢了，请求会被 `shared` 再拦一次，
 *   而用户看到的是同一个框弹两遍。
 */
async function applyPluginSpace(workspaceId, pluginId, spaceId) {
  const conn = activeConn();
  const arg = { workspaceId, pluginId };
  if (spaceId !== undefined) arg.spaceId = spaceId;
  // 分叉要指名"给哪一条连接分" —— 主进程不拿"谁活跃"去猜。
  if (conn) arg.connectionId = conn.id;

  let extra = {};
  let r = await window.slurmate.setWorkspaceRef({ ...arg, ...extra });
  if (!r.ok && r.code === 'shared') {
    const pick = await askFork(r.workspaceName, r.others || []);
    if (!pick) return { ok: false };
    extra = { scope: pick };
    r = await window.slurmate.setWorkspaceRef({ ...arg, ...extra });
  }
  if (!r.ok && r.code === 'would_discard') {
    if (!window.confirm(`${r.error}\n\n确定要换吗？`)) return { ok: false };
    r = await window.slurmate.setWorkspaceRef({ ...arg, ...extra, confirmDiscard: true });
  }
  if (!r.ok) {
    notice('error', r.error || '没能换这一份数据。');
    return { ok: false };
  }

  boot.workspaces = r.workspaces || boot.workspaces;
  boot.spaces = r.spaces || boot.spaces;
  boot.connections = r.connections || boot.connections;
  // 三处都跟着变：插件块上那一格、映射图、连接列表（它按工作区算独占与引用数）。
  renderConnections(boot.connections);
  // ★ 分叉会把**活跃连接**挪到另一张表上，而状态条那个下拉显示的正是"活跃连接的
  //   工作区" —— 不重填的话它会继续说着上一个，直到下一次快照推送。
  renderWorkspaceSelectors();
  if (lastPlugins) renderPlugins(lastPlugins);
  // ★ 改动了什么要说出来：分叉（表分了、数据没复制）与删除（那一份真的没了）
  //   都是**别的屏幕上才看得见**的变化，不说的话界面上一切正常。
  const said = [];
  if (r.forked) {
    said.push(`已经给这条连接分了一张自己的表（「${r.forked}」）—— `
      + '从现在起它和别的连接各改各的。里面的数据还是同一份，一个字节都没复制。');
  }
  said.push('换好了。下一次开会话时，这个插件就用新的那一份数据。');
  if (r.droppedOld) {
    said.push('旧的那一份数据没有别的工作区在用，已经删掉，找不回来。');
  }
  notice('info', said.join(' '));
  return { ok: true };
}

/**
 * 改一张**被几条连接共用**的引用表之前的那一问：一起改，还是先分一张自己的。
 *
 * ★ 判定权在主进程（它才知道那张表现在有几条连接在用），这里只负责**问**。
 * ★ 名字在这里取（`connLabel`）而不是让主进程拼：备注/地址的回落规则只有一条，
 *   主进程再拼一遍就是同一条规矩的第二份实现。
 *
 * @param {string[]} others 除这条连接以外，还在用那张表的连接 id
 * @returns {Promise<'all'|'fork'|null>} null = 用户取消（含 Esc）
 */
function askFork(wsName, others) {
  const dlg = $('fork-dlg');
  // 兜底：模板里少了这个对话框时**不猜**，直接当作取消（界面上那一格会弹回去）。
  if (!dlg) return Promise.resolve(null);
  $('fork-body').textContent =
    `「${wsName}」这张表还有 ${others.length} 条连接在用：`
    // ★ 用 `connLabel`（带端口）而不是 `connName`：同一台机器上两条连接的区别
    //   往往就在端口或账号上，这里正是要用户认出"还有谁"的地方。
    + `${others.map((cid) => { const c = connById(cid); return c ? connLabel(c) : '另一条连接'; })
      .join('、')}。\n\n`
    + '「全部一起改」= 它们跟着一起变。「只改这条连接」= 先给你分一张自己的表，'
    + '分出来的表一开始与现在这张一模一样，之后各改各的 —— 数据还是同一份，不会复制。';
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); resolve(v); };
    $('fork-cancel').onclick = () => done(null);
    $('fork-all').onclick = () => done('all');
    $('fork-one').onclick = () => done('fork');
    // Esc 走的是 cancel 事件（对话框会自己关掉），所以这里只 resolve。
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
  });
}

function pluginBlock(p) {
  const d = document.createElement('div');
  d.className = 'plug' + (p.runnable ? '' : ' plug-off');

  // ── 第一行：这是哪个插件 ──
  //   id 与版本都要露出来：池里可以**并存同一个插件的多个版本**（站点更新频繁、
  //   也可能拒绝更新），只显示名字的话用户分不清自己看到的是哪一版。
  const head = document.createElement('div');
  head.className = 'plug-head';
  head.append(el('h3', null, p.title));
  head.append(el('code', 'plug-id', p.name));
  head.append(el('span', 'plug-ver', 'v' + p.version));
  // ★ **不贴来源标签**（"站点分发" / "本机安装"）：池只剩一个，每一块都是站点
  //   分发，贴上去是一句说了等于没说的话。
  if (!p.hasClientCode) head.append(el('span', 'plug-ver', '声明式'));
  d.append(head);

  if (p.description) d.append(el('p', 'plug-desc', p.description));

  // ── 第二行：四个分开的事实 ──
  const meta = document.createElement('div');
  meta.className = 'plug-meta';

  const site = document.createElement('span');
  site.append(el('span', 'k', '站点：'));
  site.append(document.createTextNode(
    !p.siteKnown ? '（这个守护进程不通报插件清单）'
      : p.siteEnabled ? '已启用' : '未启用'));
  if (p.siteEnabled && p.siteVersion && p.siteVersion !== p.version) {
    site.append(el('span', 'k', `（站点那边是 ${p.siteVersion} 版）`));
  }
  meta.append(site);

  // ★ 时限与资源**同一句话**：它们回答的是同一个问题（"这个插件缺省给多少"），
  //   而站点也是在同一格 `defaults` 里报的。单开一句的话，"默认"这件事在界面上
  //   就有了两个出处，而它们迟早会说不一样的话。
  //
  // ★ `def.time` **缺席不算否**（老守护进程的 `defaults` 里没有这一格，见
  //   backend-fake 的 `_noDistribute` 那一档）：缺了就不说，而不是显示
  //   "undefined" 或"0"。这与本页其它每一处三态是同一条纪律。
  // ★ 卡那一格由**主进程**译好（`defaultsGresText`，走 `gres.js`）—— 与下面
  //   `renderKv` 里那一行同一条路子。渲染层不拼 `name:type × n`：那是第二个拼法。
  const def = p.defaults;
  meta.append(el('span', null, def
    ? `默认 ${def.cpus} 核 / ${def.mem}${def.time ? ` / ${def.time}` : ''}`
      + (p.defaultsGresText ? ` / ${p.defaultsGresText}` : '')
    : '默认资源由服务端定'));

  // 本机开关。它能点，是因为"本机要不要"是用户自己的决定，与站点无关。
  const lab = document.createElement('label');
  lab.className = 'plug-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = p.locallyEnabled !== false;
  cb.onchange = async () => {
    cb.disabled = true;
    try {
      // ★ 按 **id** 提交，不按短名：池是全局的，两个站点可以各有一个叫
      //   `jupyter` 的插件而它们是两个不同的东西。
      const r = await window.slurmate.setPluginEnabled(p.id, cb.checked);
      if (r && r.ok) renderPlugins(r.plugins);
      else notice('error', (r && r.error) || '没能保存这个开关');
    } finally {
      cb.disabled = false;
    }
  };
  lab.append(cb);
  lab.append(document.createTextNode('本机启用'));
  meta.append(lab);

  d.append(meta);

  // ── 起不来的原因：一句话说清该做什么 ──
  if (!p.runnable) {
    d.append(el('p', 'why', whyNotRunnable(p)));
  } else if (p.siteEnabled && p.siteVersion && p.siteVersion !== p.version) {
    // ★ 两半代码是配套的，版本对不上要说在前面。不说的话用户看到的是
    //   "作业起来了但界面一片白"，而根因一个字都不在里面。
    d.append(el('p', 'why',
      `站点用的是 ${p.siteVersion} 版，而本机这一份是 ${p.version} 版。`
      + '会话仍然起得来，但界面可能连不上 —— 升级客户端通常就好了。'));
  }

  // ── 这个插件用哪一份数据 ──
  //
  // ★ 只画给**真的有一份数据**的插件（`p.ports > 0`，清单里那一格）：0 个端口的
  //   插件没有存储、没有端口、没有那一格，画一个空下拉等于凭空许诺一个不存在的东西。
  // ★ 它在**按钮之前**：那一格决定的是"按下去会用哪一份数据"，先看得见再按。
  if (p.ports > 0) {
    const row = pluginSpaceRow(p);
    if (row) d.append(row);
  }

  const btn = document.createElement('button');
  btn.textContent = '开始会话';
  btn.disabled = !p.runnable;
  btn.onclick = () => startWith(p.name, btn);
  d.append(btn);
  return d;
}

function issueBox(kind, head, body) {
  const d = document.createElement('div');
  d.className = 'issue ' + kind;
  d.append(el('span', 'h', head + '：'));
  d.append(document.createTextNode(body));
  return d;
}

/** 建一个元素的小工具（内联 style 会被 CSP 丢掉，所以一律走 class）。 */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * 起一个会话。
 *
 * ★ `serviceKind` 传的是**本站的短名**（块标题旁边那个）。主进程按它在本机找到
 *   对应那一份插件 —— 池里可能并存同一个插件的多个版本，取版本最高的。
 *
 * ★ 高级选项里**只带上真正填了的键**。留空 = 让服务端用它的默认值 —— 客户端不
 *   自己编默认值，否则默认值就成了两份真相：界面显示 2 核 / 8G，而实际拿到的是
 *   别的，且没有任何地方会为此报错。默认资源是**管理员的策略**，不是用户偏好。
 */
async function startWith(serviceKind, btn) {
  btn.disabled = true;
  notice('info', '正在提交会话…');
  try {
    const res = {};
    const cpus = $('f-cpus').value.trim();
    const mem = $('f-mem').value.trim();
    const part = $('f-part').value;
    if (cpus) res.cpus = Number(cpus);
    if (mem) res.mem = mem;
    if (part) res.partition = part;
    // GRES：选了名字才发。**数量是必填的** —— 发一个没有数量的 GRES 等于让服务端
    // 去猜要几个，而服务端不猜（它只校验与钳制），回一句"不合法"才是对的。
    // ★ 描述符按**序号**取回（选项的 value 就是 curGres 的下标）：不从 option 的
    //   文字里再拆一遍 `gpu:a100` —— 那等于在客户端再造一个语法解析器。
    const gi = $('f-gres').value;
    if (gi === 'none') {
      // ★ 显式「不占」发的是 `null`，与"没碰这一项"（不发这个键）**不是**同一件事：
      //   后者让服务端用那个插件的默认卡，前者盖过它。见 renderGresOptions 那段。
      res.gres = null;
    } else if (gi !== '') {
      const e = curGres[Number(gi)];
      const n = Number($('f-gres-n').value);
      if (!e) {
        notice('error', 'GRES 那一项已经失效了（分区是不是换过？），请重新选一次。');
        return;
      }
      if (!Number.isInteger(n) || n < 1) {
        notice('error', '选了 GRES 就要填数量，至少 1。');
        return;
      }
      res.gres = { name: e.name, type: e.type || null, count: n };
    }

    const r = await window.slurmate.start(res, serviceKind);
    if (r && r.sessions) renderSessions({ sessions: r.sessions, front: r.front });
    // 提交失败（比如版本对不上被服务端拒了）时把清单刷新一遍 —— 那句话要落到
    // 界面上，不能只在日志里。
    if (r && !r.ok) {
      const pv = await window.slurmate.partitions();
      if (pv && pv.plugins) renderPlugins(pv.plugins);
    }
  } finally {
    btn.disabled = false;
  }
}

// ── 最近作业（`sacct`，按需拉）─────────────────────────────────────────────
//
// ★ 它**不在**站点状态那一块里。从前它挂在整个「集群状态」屏的底下，而那是
//   一张**作业**的表 —— 站点状态回答的是"这台集群现在怎么样"，这张表回答的是
//   "我最近跑过什么"。两者唯一的共同点是都要向控制节点问一次，而那不足以让它们
//   住在一起（见浮窗那一侧的注释）。
//
// ★★ **它是按需拉的，绝不跟着别的东西一起刷。** 它是这一组里最贵的一条查询：
//   守护进程是单线程同步的，`op_history` 会**同步 fork `sacct`（最长 20 秒）**
//   阻塞整个 daemon —— 所有会话的 tick 都停在那儿。所以它只有一个入口：那个按钮。
async function loadHistory() {
  const box = $('history-body');
  box.textContent = '';
  box.append(cel('p', 'sub', '正在取…'));
  const r = await window.slurmate.history();
  box.textContent = '';
  if (!r || !r.ok) {
    const detail = (r && r.error && r.error.detail) || '控制节点没有说明原因';
    // ★ 这里是**错误**，不是空列表 —— 空列表的意思是"你这几天没有作业"，
    //   而那是完全不同的两句话。
    box.append(cel('p', 'bad', `取不到作业历史：${detail}`));
    return;
  }
  const rows = (r.data && r.data.history) || [];
  if (!rows.length) {
    box.append(cel('p', 'sub', `最近 ${(r.data && r.data.days) || 7} 天没有作业。`));
    return;
  }
  for (const j of rows) {
    const row = cel('div', 'crow');
    row.append(cel('span', 'nm', j.job_id));
    row.append(cel('span', 'dim',
      `  ${j.state}　退出码 ${j.exit_code}　跑了 ${j.elapsed}`
      + `　${j.partition || '?'}　${j.end}`));
    box.append(row);
  }
}

// ── 第三屏：作业列表 ────────────────────────────────────────────────────────
//
// ★★ 这一屏的数据来自**服务端**（`op:list`，经 index.js 的 `jobsView()`），
//   不是本机那张会话表。两者在正常情况下一样，差在三种**真的会发生**的场合：
//   上一台电脑提交的、本机认不出插件因而没接上的、刚结束而服务端还留着那一行的。
//   只画本机那一份，这三种里用户看到的都是"我没有作业了" —— 而作业还在。
//
// ★ 而**动作只给本机接着的那些**（`attached`）：结束走的是 `SessionController.stop()`，
//   它要心跳、要隧道、要那条会话的完整视图。给没接着的另写一条短路，就是同一条
//   规矩的第二份实现。没接着的那些照实说出来，出路是重连一次。

/**
 * 重新问一次服务端（`op:list`）。
 *
 * ★ 它**不是缓存刷新**，是一次真查询。作业列表的变化有一大半发生在本进程之外
 *   （另一台电脑提交的、CLI 提交的、排队中的作业被调度器跑起来），所以它必须
 *   能随时重问 —— 「刷新」那个按钮存在的理由就是这个，而不是装饰。
 */
async function refreshJobs() {
  const connId = boot ? boot.activeConnectionId : null;
  $('jobs-when').textContent = '正在取…';
  const r = await window.slurmate.jobs();
  if (!r || !r.ok) {
    const detail = (r && r.error && r.error.detail) || '控制节点没有说明原因';
    JOBS = { forConn: connId, list: null, at: 0, error: detail, selected: null };
    renderJobs();
    return;
  }
  JOBS = {
    forConn: connId, list: r.jobs || [], at: r.at || Date.now(),
    error: null, selected: JOBS.selected,
  };
  renderJobs();
}

/** 选中的那一行（没有就是 null）。 */
function selectedJob() {
  return (JOBS.list || []).find((j) => j.session_id === JOBS.selected) || null;
}

/**
 * 点某一行。
 *
 * ★ 本机接着的那些顺手 `setFront` —— "点一条作业"与"我要看这一条"是同一件事，
 *   而前台的详情（`#kv`）跟的就是它。分成两个动作的话，用户点了 A 却在详情里
 *   看到 B，而两边看起来都对。
 */
async function selectJob(j) {
  JOBS.selected = j.session_id;
  if (j.attached && j.slot) {
    await window.slurmate.setFront(j.slot);
  }
  renderJobs();
}

function jobRow(j) {
  const li = document.createElement('li');
  li.className = 'job'
    + (j.live ? '' : ' dead')
    + (j.attached ? '' : ' detached')
    + (j.session_id === JOBS.selected ? ' on' : '');

  // 服务名 —— 本机认不出这个插件时**照实说**，不编一个名字。
  // （认得出才有名字：判据在主进程的 `registry.resolve`，不在这一层。）
  li.append(cel('span', 't', j.service || '（本机没有这个插件）'));
  li.append(cel('span', 'st', j.state_text || j.state || '—'));

  const bits = [];
  if (j.job_id) bits.push(`作业 ${j.job_id}`);
  if (j.partition) bits.push(j.partition);
  if (j.node) bits.push(j.node);
  if (j.live && j.expires_at) bits.push('剩余 ' + fmtLeft(j.expires_at));
  li.append(cel('span', 'm', bits.join(' · ') || '—'));

  // 「谁在看」——**三句话三件事**（见 index.js 的 jobsView），不是"是不是本机"。
  // ★ 而它只在**还活着**的会话上说得通：一条已经结束的会话没有"谁在看"。
  if (j.keeper_text) {
    li.append(cel('span', 'kp' + (j.keeper_is_me ? ' good' : ''), j.keeper_text));
  }
  // ★ 没接着的**必须说出来**：这一行的动作按钮是灰的，而"为什么点不动"不能靠猜。
  //   出路是重连一次（`doConnect` 会跑 `tryReattach`），不是在这里再造一个入口。
  if (j.live && !j.attached) {
    li.append(cel('span', 'warn', '本机没接着它 —— 重连一次这个站点就会接上'));
  }

  li.onclick = () => selectJob(j);
  return li;
}

function renderJobs() {
  const rows = JOBS.list || [];
  const err = $('jobs-error');

  // ★ 三态：**取不到**（`list === null`）与**确实没有**（`list === []`）必须
  //   长得不一样。把"问不到"画成"没有作业"，用户会以为自己的作业丢了 ——
  //   而真正的原因在连接那一侧。
  err.classList.toggle('hidden', !JOBS.error);
  if (JOBS.error) err.textContent = `取不到作业列表：${JOBS.error}`;
  $('jobs-when').textContent = JOBS.at
    ? `这个站点上的作业（${fmtAge(Date.now() - JOBS.at)}前取的）。`
    : '';

  // ★ **先定选中的是谁，再画** —— 反过来的话，这一轮刚选中的那一行不带 `.on`，
  //   而用户看到的是"点了没反应"。
  //
  //   默认顺序：用户刚点的那条还在就留着 → 前台那一条 → 第一条活着且本机接着的
  //   → 第一行。★ 第一个条件不能省：省了的话每刷一次列表就把用户的选择冲掉。
  const ids = new Set(rows.map((j) => j.session_id));
  if (!(JOBS.selected && ids.has(JOBS.selected))) {
    const front = (SESS.sessions.find((x) => x.slot === SESS.front) || {}).snap;
    const hit = (front && rows.find((j) => j.session_id === front.sessionId))
      || rows.find((j) => j.live && j.attached)
      || rows[0];
    JOBS.selected = hit ? hit.session_id : null;
  }

  const box = $('job-list');
  box.textContent = '';
  for (const j of rows) box.append(jobRow(j));
  $('jobs-empty').classList.toggle('hidden', Boolean(JOBS.error) || rows.length > 0);

  renderJobsSelection();
}

/**
 * 三个动作按钮的可用性与提示。
 *
 * ★ 「接管」在**本机已经是看护者**时禁用：那是一次空动作，而它成功之后会回一句
 *   "已接管" —— 用户会以为刚才发生了什么。按钮该说的是"这台电脑已经在看它了"。
 */
function renderJobsSelection() {
  const j = selectedJob();
  const canAct = Boolean(j && j.live && j.attached);
  $('btn-jobs-end').disabled = !canAct;
  $('btn-jobs-takeover').disabled = !canAct || j.keeper_is_me;
  $('btn-jobs-reload').disabled = !canAct;
  $('btn-jobs-takeover').title = !j ? '先在上面点一条作业'
    : (j.keeper_is_me ? '这台电脑已经在看它了' : '把这条会话的看护者换成这台电脑（作业一个字都不动）');
}

/**
 * 结束**某一个槽**上的会话。界面里三个地方都走它（作业列表、状态条、断开）。
 *
 * ★ 收成一份而不是各写一遍：那三处要说的话**逐字相同**，而其中最要紧的一句
 *   （"`releasing` 不等于作业已经停了"）漏掉任何一处，用户就会以为作业结束了
 *   而它还在烧 GPU。见 docs/ARCHITECTURE.md 的 §3.0。
 */
async function stopSlot(slot) {
  if (!slot) return null;
  const res = await window.slurmate.stop(slot);
  if (res && res.ok) {
    notice('info', res.detail || '已请求释放。');
    if (res.state === 'releasing') {
      notice('warn', '已请求释放。这表示控制节点开始处理了 —— '
        + '请以状态变成「已结束」为准。');
    }
  } else if (res) {
    notice('error', res.detail || '释放失败。');
  }
  return res;
}

/** 【结束】：结束**选中的**那一条。 */
async function endSelectedJob() {
  const j = selectedJob();
  if (!j || !j.attached || !j.slot) {
    return notice('error', '先在列表里点一条本机接着的作业。');
  }
  await stopSlot(j.slot);
  refreshJobs();
}

/** 状态条上那个「结束会话」—— 结束**前台**那一条（跑起来之后那 30px 是唯一够得着的）。 */
async function endFrontSession() {
  await stopSlot(frontSlot());
}

/** 【接管】：把选中那条会话的看护者换成这台电脑。 */
async function takeoverSelectedJob() {
  const j = selectedJob();
  if (!j) return notice('error', '先在列表里点一条作业。');
  const r = await window.slurmate.takeover(j.session_id);
  if (!r || !r.ok) {
    const k = (r && r.error && r.error.kind) || '';
    const detail = (r && r.error && r.error.detail) || '控制节点没有说明原因';
    // ★ `no_client_id` 这一条**必须单独说**：它指的是"这次连接没有自报身份"，
    //   而身份只在常驻通道上报（走 exec 退路时会被删掉）。那不是"控制节点坏了"，
    //   是"这条路走不了" —— 用户能做的事完全不同（等通道恢复 / 重连）。
    notice('error', k === 'no_client_id'
      ? `这一次连接没有自报身份，接管做不了：${detail}`
      : `接管失败：${detail}`);
    return;
  }
  notice('info', '已接管。从现在起由这台电脑看护这条会话（作业一个字都没动）。');
  refreshJobs();
}

// ── 分区 ────────────────────────────────────────────────────────────────────
/** 最近一次拿到的分区表（含每个分区的 GRES 清单）。换分区时要拿它重画 GRES。 */
let partList = [];
/**
 * 当前 GRES 下拉里每一项对应的描述符。
 * ★ 选项的 `value` 是它的**下标**，不是拼出来的字符串 —— 见 startWith 里那段。
 */
let curGres = [];

function renderPartitions(list) {
  const sel = $('f-part');
  const keep = sel.value;
  partList = list || [];
  sel.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '（随机挑一个有权限的）';
  sel.append(none);

  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.allowed ? p.name : `${p.name}（无权限）`;
    o.disabled = !p.allowed;
    // 禁用必须给出理由，而不是让用户猜为什么点不动
    if (!p.allowed && p.reason) o.title = p.reason;
    sel.append(o);
  }
  sel.value = keep;
  // 换分区 ⇒ 可选的 GRES 跟着换（上限是**分区自己**的：同一个集群上
  // 一种卡每节点 8 张、另一种 4 张）。这里画一次，之后由 onchange 接着画。
  sel.onchange = renderGresOptions;
  renderGresOptions();
}

/**
 * 某个分区（或"还没挑分区"）能用哪些 GRES。
 *
 * ★ 服务端查不到集群的 GRES 时，分区对象上**根本没有 `gres` 这个键** —— 那时
 *   返回 `absent: true`，界面要把这件事说出来。否则用户读成"这台集群没有卡"，
 *   而真相是"我们没问到"。`[]` 才是"确实没有卡"。
 *
 * ★ 没挑分区时给的是**所有有权限分区的并集**：不这么做，"要 2 张卡、分区随便"
 *   这句话在界面上就表达不出来 —— 而服务端是支持的（`fit_gres` 在没点名分区时
 *   在所有分区里找）。并集里同一个名字取各分区里**最大的** `per_node_max`，
 *   因为最终落到哪个分区由服务端随机挑。
 */
function gresChoicesFor(partName) {
  if (partName) {
    const p = partList.find((x) => x.name === partName);
    if (!p) return { list: [], absent: false };
    if (!Array.isArray(p.gres)) return { list: [], absent: true };
    return { list: p.gres, absent: false };
  }
  let absent = false;
  const byKey = new Map();
  for (const p of partList) {
    if (!p.allowed) continue;
    if (!Array.isArray(p.gres)) { absent = true; continue; }
    for (const e of p.gres) {
      const k = `${e.name}:${e.type || ''}`;
      const cur = byKey.get(k);
      if (!cur) {
        byKey.set(k, { ...e });
      } else {
        cur.per_node_max = Math.max(cur.per_node_max, e.per_node_max);
        cur.total += e.total;
      }
    }
  }
  return { list: [...byKey.values()], absent };
}

function renderGresOptions() {
  const sel = $('f-gres');
  const { list, absent } = gresChoicesFor($('f-part').value);
  curGres = list;
  sel.textContent = '';
  // ★★ 这里的两项**不是**同一件事，别合并：
  //   · `''`  = **不碰**（省略这个字段）⇒ 用**这个插件的** `default_gpus`。
  //     站点可以在那个插件的配置里配默认卡（那是稀缺算力政策），而"不碰"就该拿到它。
  //   · `none` = **显式不占** ⇒ 发 `gres: null`，盖过插件的默认。
  //   少了第二项，站点的默认卡就是一道用户**无法拒绝**的命令 —— 而管理员拍的是
  //   "默认"，不是"任何人都不许说不"。（协议侧同一条：见 op_submit 里
  //   `"gres" in req` 那一段。）
  const deflt = document.createElement('option');
  deflt.value = '';
  deflt.textContent = '（用插件的默认）';
  sel.append(deflt);
  const none = document.createElement('option');
  none.value = 'none';
  none.textContent = '（不占 GRES）';
  sel.append(none);
  for (let i = 0; i < curGres.length; i++) {
    const e = curGres[i];
    const o = document.createElement('option');
    o.value = String(i);
    // ★ 问的是 `per_node_max`（`--gres=gpu:N` 是**每节点** N 个），不是 total：
    //   "本分区一共 8 张"与"一个作业最多能要 4 张"是两个不同的问题。
    o.textContent = `${e.label || e.name}（每节点最多 ${e.per_node_max}）`;
    sel.append(o);
  }
  sel.title = absent
    ? '服务端暂时查不到这台集群的 GRES 清单（scontrol 没答上来）' : '';
  sel.value = '';
  sel.onchange = applyGresMax;
  applyGresMax();
}

/** GRES 的数量上限跟着选中的那一项走。**客户端不写死任何数字。** */
function applyGresMax() {
  const cnt = $('f-gres-n');
  const e = curGres[Number($('f-gres').value)];
  if (!e) {
    cnt.value = '';
    cnt.disabled = true;
    cnt.placeholder = '—';
    cnt.removeAttribute('max');
    return;
  }
  cnt.disabled = false;
  cnt.placeholder = '必填';
  cnt.max = String(e.per_node_max);
}

// ── 主机密钥确认 ────────────────────────────────────────────────────────────
function askHostKey(res) {
  return new Promise((resolve) => {
    const dlg = $('hostkey-dlg');
    const changed = res.code === 'host_key_changed';

    $('hk-title').textContent = changed ? '⚠ 登录节点的主机密钥已改变' : '确认登录节点身份';
    $('hk-body').textContent = changed
      ? '这与上次连接时记录的不一致。可能是服务器重装过，也可能有人在中间拦截。'
        + '在弄清原因之前请不要继续 —— 继续就等于把这把私钥的认证交给一个不确定的对端。'
      : '这是第一次连接到这台登录节点。请核对下面的指纹（应与集群管理员公布的一致），'
        + '确认后本机才会记住它。';
    $('hk-fp').textContent = (res.hostKey && res.hostKey.fingerprint) || '（没拿到指纹）';
    $('hk-trust').textContent = changed ? '我知道服务器重装了，仍然信任' : '我核对过了，信任它';

    const finish = async (trust) => {
      $('hk-trust').onclick = null;
      $('hk-cancel').onclick = null;
      dlg.close();
      resolve(trust);
    };
    $('hk-trust').onclick = () => finish(true);
    $('hk-cancel').onclick = () => finish(false);
    dlg.showModal();
  });
}

/** 统一的连接结果处理：主机密钥要用户拍板时弹框，其余按结果报错。 */
async function handleConnectResult(res) {
  if (res.ok) {
    connected = true;
    whoami = res.whoami || null;
    const acct = whoami && whoami.account;
    notice('ok', `已连接：${(whoami && whoami.user) || ''}（账户 ${acct || '未分配'}）`);
    if (!acct) {
      notice('error', '你的账号尚未分配集群计算权限，请联系管理员 —— 否则提交作业会失败。');
    }
    if (res.partitions) renderPartitions(res.partitions);
    // ★ 插件清单也是连上之后才有的（`op_plugins` 走这条路）—— 不在这里刷的话，
    //   首次连接前界面上只有"这个守护进程不通报插件清单"，而那是句假话。
    if (res.plugins) renderPlugins(res.plugins);
    renderConnections(boot.connections);
    renderSessions({ sessions: [], front: null });
    // ★★ 连上之后**进第二屏**。这一屏之所以能进，正是"连上"这件事本身：
    //   插件是站点分发的，没有连接就不知道有哪些插件。
    //   ★ 而"接回上次那些会话"是主进程在 connect 里**做完才返回**的（`doConnect`
    //     的最后一步）—— 所以走到这一行时，本机手上已经有那几条会话了，
    //     第三屏进去就看得见它们。
    JOBS = { forConn: null, list: null, at: 0, error: null, selected: null };
    showScreen('plugins');
    return true;
  }

  if (res.code === 'host_key_unknown' || res.code === 'host_key_changed') {
    const trusted = await askHostKey(res);
    if (!trusted) {
      notice('info', '已取消，没有建立连接。');
      return false;
    }
    const again = await window.slurmate.trustHostKey(res.hostKey && res.hostKey.fingerprint);
    return handleConnectResult(again);
  }

  connected = false;
  notice('error', res.error || '连接失败');
  return false;
}

// ── 开发者模式 ──────────────────────────────────────────────────────────────

/**
 * 现在有几条会话在跑（提交中/排队/运行/释放中都算）。
 *
 * ★ 回**条数**，不是布尔 —— 弹确认框的那两处都要把数字说给用户听：
 *   "重启会先结束当前会话"在两条的时候是一句**不准确**的话，而用户是按那句话
 *   决定要不要点下去的。
 */
function liveCount() {
  return SESS.sessions.filter((s) => s.live).length;
}

/** 上一次从主进程拿到的开发者模式设置。**只由 renderDevMode 更新**。 */
let devState = null;

/**
 * 画开发者模式那一节。传参 = 用主进程刚回的那一份（三个动词都会回）。
 *
 * ★ **`on` 与 `saved` 是两件事，这一节全靠它撑起来**：
 *
 *   | 画什么 | 跟谁走 | 为什么 |
 *   |---|---|---|
 *   | 复选框 | `saved` | 用户刚点的就是它。跟着 `on` 走的话，点完它会自己弹回去 |
 *   | 「重启后生效」那一行 | 两者是否相等 | 不相等就是有改动悬着 |
 *   | 插件来源那一段 | `saved` | 同上：刚选完就要看见 |
 *   | 调试开关那一块 | `on` | 假后端没在跑的话，那些按钮点了只会报"仅开发者模式可用" |
 *
 *   全都跟着 `on` 走的话，点了开关**界面上什么都不会发生** —— 而那正是"点了没反应"
 *   这一类问题里最难查的一种：其实它生效了，只是要重启。
 */
function renderDevMode(dm) {
  if (dm) devState = dm;
  const d = devState;
  if (!d) return;

  $('dev-on').checked = Boolean(d.saved);

  // 有改动等着重启：说得出来，并且给一个按得下去的按钮（不然用户只能自己去
  // 关掉再打开 —— 那正是命令行开关那种"你得知道怎么做"的体验）。
  const pending = (d.saved !== d.on) || (d.pluginDirSaved !== d.pluginDir);
  $('dev-pending').classList.toggle('hidden', !pending);
  if (pending) {
    $('dev-pending').textContent = '有改动等着重启 —— 这个客户端现在跑的还是'
      + (d.on ? '开发者模式' : '真集群那一份配置') + '。';
  }
  $('dev-restart').classList.toggle('hidden', !pending);

  // 插件来源：路径跟 `saved`（用户要的那个），**数目只在两者相同时才敢报** ——
  // 主进程给的数目是**生效**那棵树扫出来的，拿它去配一个新选还没生效的路径，
  // 就是一句对不上号的话。
  $('dev-src').classList.toggle('hidden', !d.saved);
  const wantDir = d.pluginDirSaved || d.defaultPluginDir;
  $('dev-src-path').textContent = wantDir || '（默认那个位置不存在：仓库里的 plugins/）';
  const cnt = $('dev-src-count');
  if (d.pluginDirSaved !== d.pluginDir) {
    cnt.textContent = '重启之后才会按这个来源读。';
  } else if (d.source.plugins.length) {
    cnt.textContent = `读到 ${d.source.plugins.length} 个插件：`
      + d.source.plugins.join('、')
      + (d.source.skipped.length
        ? `（另有 ${d.source.skipped.length} 个目录读不出清单，假站点不会报它们）` : '');
  } else if (d.source.skipped.length) {
    cnt.textContent = `一个插件都没有 —— ${d.source.skipped.length} 个目录都读不出清单：`
      + `${d.source.skipped[0].name}：${d.source.skipped[0].why}`;
  } else {
    cnt.textContent = '一个插件都没有 —— 每个子目录应该是一个插件（里面有 plugin.json）。';
  }

  // 调试开关跟 **`on`**：假后端没在跑，那些按钮按下去只会回一句"仅开发者模式可用"。
  $('dev-debug').classList.toggle('hidden', !d.on);
}

// ── 启动 ────────────────────────────────────────────────────────────────────
//
// ★★ **这里分成两段，顺序不许调换**（见下面 `bindEvents` 的注释）：
//   先 `bindEvents()`（纯同步），再 `bootUI()`（所有 await 与首屏渲染）。

/** 当前表单在操作哪把密钥。新建时是那把还没有归属的，编辑时是这条连接的。 */
const keyPayload = () =>
  (form.mode === 'edit' && form.id ? { connectionId: form.id } : undefined);

/**
 * 挂上所有事件监听。**纯同步 —— 一个 `await` 都不许有。**
 *
 * ★★ 为什么这件事值得单开一个函数、还排在取数据前面：这一整块从前排在
 *    `init()` 里那几个 await 的**后面**。于是只要 `bootstrap()` 或者
 *    `openNewForm()`（它里面还有 `await newKey()` —— 在 Windows 上那是 DPAPI
 *    那一条路）有一次 reject，`init()` 就在那一行**整体中止**，
 *    **这一整块一个监听都不挂**：标题、新建、表单、作业屏、开发者开关、
 *    重新加载、结束会话全在内 —— 而唯一的症状是提示流里多一行字。
 *    用户看到的是"这个界面上有一半按钮点了没反应"，而它指不回任何一处。
 *
 * ★ 它与 P1 那次白屏（`renderConnections` 里一个 `ReferenceError`，560 条用例
 *   一条没红）是**同一类**：本项目一路上在清的那种「看起来正常但就是不工作」。
 *   ⇒ 首屏数据拿不到是**一个**故障，界面因此变成哑的是**另一个**，
 *     这一句把它们解耦：前者只该让首屏空着并说一句。
 */
function bindEvents() {
  // ── 事件 ──
  // 「关于」的入口是**最上面那一行标题**（`#about-head`）。它装的是这一版的说明与
  // 开发者模式，而那两样都不是每次打开都要看的 —— 所以它是一个可以点开、也可以
  // 不点的地方，而不是常驻的一块。
  // ★ 用 `role="button"` + tabindex 而不是 `<button>`：button 里不许放 h1/p，
  //   浏览器会把它们拆开重排。手写的那两条键盘路径（回车 / 空格）就是代价。
  const aboutHead = $('about-head');
  const toggleAbout = () => $('sec-about').classList.toggle('hidden');
  aboutHead.onclick = toggleAbout;
  aboutHead.onkeydown = (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleAbout(); }
  };

  $('btn-new').onclick = () => openNewForm();
  $('btn-cancel-form').onclick = () => closeForm();

  // 「③ 工作区」：用户一动手就不再跟随默认（`wsPicked` 记下来）。
  $('f-workspace').onchange = () => {
    wsPicked = $('f-workspace').value;
    renderFormWorkspace();
  };
  // ★ 默认值取决于**上面的地址**，所以敲地址时要重问一遍 —— 它是纯查询，不落盘。
  //   不这么做的话，那一项会一直写着「默认：新建一个空白工作区」，
  //   而用户按保存却落进了另一个工作区：界面在显示一件不成立的事。
  //   （只在**新建**时问：编辑时这一格没有"默认"那一项。）
  for (const id of ['f-host', 'f-port']) {
    $(id).oninput = () => { if (form.open && form.mode === 'new') refreshFormWsDefault(); };
  }

  $('btn-copykey').onclick = async () => {
    const r = await window.slurmate.copyPublicKey(keyPayload());
    notice(r.ok ? 'ok' : 'error', r.ok ? '公钥已复制到剪贴板。' : (r && r.error) || '复制失败。');
  };

  // ★★ **一下就走，没有确认。** 判据是**代价**，不是"不可逆"：再换一把就是了，
  //   而真正的代价（新公钥必须重新注册到 IDM，否则连不上）由两处承载 ——
  //   这颗按钮的 `title`（按下去**之前**看得见），以及动作之后那句 `notice`
  //   （按下去**之后**看得见）。★ 从前这里是一句 `window.confirm`，而它问的
  //   与后面那句提示是同一件事：同一句话问一遍、做完再说一遍。
  $('btn-regen').title = '作废这条连接现在的密钥、换一把新的 —— '
    + '新的公钥必须重新注册到 IDM，否则这条连接连不上。';

  $('btn-regen').onclick = async () => {
    const r = await window.slurmate.regenerateKey(keyPayload());
    if (!r || !r.key || !r.key.publicKey) {
      return notice('error', (r && r.error) || '重新生成失败。');
    }
    renderKey(r.key);
    if (r.ok) {
      notice('warn', '已生成新密钥。请把上面的新公钥重新注册到 IDM，然后重新连接。');
    } else {
      // 存不下去也要说清楚 —— 用户此刻正拿着这把新公钥去注册，
      // 而它下次启动就会消失，这个后果必须当场讲。
      notice('error', '已生成新密钥，但它没能保存到本机（没有可用的系统凭据库）——'
        + '关闭客户端后这把密钥就没了。请先把上面的公钥注册到 IDM。');
    }
  };

  $('btn-save').onclick = async () => {
    const label = $('f-label').value.trim();
    const user = $('f-user').value.trim();
    const host = $('f-host').value.trim();
    const port = Number($('f-port').value);
    if (!user || !host) return notice('error', '请先填写用户名和主机。');
    // 端口不给默认值：编一个默认端口出来，用户会以为「填不填都行」，
    // 而错端口的表现是连接超时 —— 一个指不回这里的原因。
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return notice('error', '端口请填 1-65535 之间的整数（集群登录节点监听的端口）。');
    }

    // ★ 备注这一栏的传法在两种模式下不同，因为**空备注的含义不同**：
    //   编辑时那一栏就是当前值，清空即清空，必须原样传上去；
    //   新建时留空只表示「这次没起名」，不该拿它把已有条目的备注冲掉。
    const editing = form.mode === 'edit' && form.id ? form.id : null;
    const input = { user, host, port };
    if (editing) input.id = editing;
    if (editing || label) input.label = label;
    // 「③ 工作区」。三种取值分开传，因为它们在主进程那边是**三件事**：
    //   · 键**缺席**   = 用户没表态，按默认规则（同址已有的连接 → 活跃连接的 → 新建）
    //   · `null`       = 要一个新的空白工作区
    //   · 一个工作区 id = 就用那一个
    // ★ 前两种**不能合并**：把"没表态"也发成一个具体 id 的话，默认规则就永远
    //   跑不到了（界面手里那个默认值是按上一个字算的，用户敲完立刻按保存就错），
    //   而它正是这个下拉存在的一半理由。
    const wsWant = $('f-workspace').value;
    if (!editing) {
      if (wsWant === NEW_WORKSPACE) input.workspaceId = null;
      else if (wsWant) input.workspaceId = wsWant;
    }

    const saved = await window.slurmate.saveConnection(input);
    if (!saved.ok) return notice('error', saved.error);
    boot.connections = saved.connections;

    // ★★ 两道判据都必须在**动 `boot.activeConnectionId` 之前**问，而且它们问的
    //    都是同一件事："这一刻哪一条才是活着的"。它一旦被改掉，两句话就都算错了。
    //
    //    · `wasLive` —— 编辑**这一条**时它正连着吗？在赋值**之后**算的话，那个
    //      比较恒为真：编辑任何一条连接都会得到「这条连接正连着 ——
    //      新地址要重新点一次连接才会生效」，而用户可能压根没连着它。
    //    · `allowSwitchTo` —— 这一步要不要**换站点**（见它的注释）。
    //
    //    ★ 还有一层：编辑这条路上**根本不该**碰 `boot.activeConnectionId`。
    //      这个按钮这时写的是「保存」（不是「保存并连接」，见 openEditForm），
    //      而主进程那边活跃连接一个字都没动（`app:saveConnection` 只在从来没有
    //      活跃连接时才设它）。把它指过去的话，界面会当场把一条**没连着**的连接
    //      画成「已连接」—— 而"哪一条连着"是这一屏上最要紧的一格。
    const wasLive = connected && saved.connection.id === boot.activeConnectionId;

    if (editing) {
      renderConnections(boot.connections);
      closeForm();
      notice('ok', '已保存这条连接。');
      if (wasLive) {
        // 地址改了但 SSH 连接还挂在旧地址上。不说的话，用户会以为改动没生效。
        notice('info', '这条连接正连着 —— 新地址要重新点一次「连接」才会生效。');
      }
      // ★ 换工作区是**第二趟**，不并进上面那一次保存里：它有自己的两道闸
      //   （切走会不会把一个独占的工作区删掉 → 需要用户确认；有没有会话在跑 →
      //   要挪隧道端口）。那两条各有各的失败方式，焊进来的话一次保存就有四种
      //   下场，而其中三种会让用户不知道地址到底存进去没有。
      //   分两趟之后每一趟各自原子，代价是"地址存了、工作区没换"这种半截结果 ——
      //   它看得见、也说得出（下面那条 notice）。
      if (wsWant && wsWant !== saved.connection.workspaceId) {
        const r = await applyWorkspace(saved.connection.id,
          wsWant === NEW_WORKSPACE ? null : wsWant,
          // ★ 第一段挂在「保存」那颗按钮上（用户刚按的就是它），退回时把「③ 工作区」
          //   那一格拨回**不变**—— 它停在"待定"的那个新值上，那不是已发生的事。
          { anchor: $('btn-save'), revert: () => { wsPicked = ''; renderFormWorkspace(); } });
        // ★ `armed` 那一支不说这句：问题还摆在那儿没答，说"工作区没有换"
        //   等于替用户答了"不换"。
        if (!r.ok && !r.armed) notice('info', '地址已经保存了，但工作区没有换。');
      }
      return;
    }

    // ★ 换站点那道闸（见 `allowSwitchTo`）问在**改 `boot` 之前**：这一刻
    //   `boot.activeConnectionId` 还是"正连着的那条"，所以"这次要连的是不是
    //   另一条"问得准。
    // ★ 被拦下时这条连接**留着**（已经存进去了、也在列表里），只是这一次不连它 ——
    //   那句话由 `allowSwitchTo` 说。
    if (!allowSwitchTo(saved.connection.id)) {
      renderConnections(boot.connections);
      notice('info', saved.created ? '已保存这条连接。' : '这条连接之前就保存过了，直接用它。');
      return closeForm();
    }

    boot.activeConnectionId = saved.connection.id;
    renderConnections(boot.connections);
    notice('info', saved.created ? '已保存这条连接。' : '这条连接之前就保存过了，直接用它。');
    await handleConnectResult(
      await window.slurmate.connect({ connectionId: saved.connection.id }));
    // ★ 无论连上没连上，表单都收起来 —— 再摆回来的话，用户看到的是「刚保存完又
    //   弹出一个新建连接」，像是什么都没存进去。这条连接已经在右上角下面的列表里了，它有「连接」「编辑」
    //   两个按钮；连不上时日志里那条错误会说清楚下一步该做什么。
    closeForm();
  };

  $('btn-probe').onclick = doProbe;
  // ★★ 这两个按钮**必须绑两个不同的函数**（见 doLeave / doDisconnect）：它们对作业
  //   做的事正好相反，而共用一个实现的话，其中一个的语义迟早会被"顺手统一"掉 ——
  //   漂的方向是"点了临时离开，作业被停了"。
  $('btn-leave').onclick = doLeave;
  // ★★ 【断开】是**两段式**，而【临时离开】不是。这不是双重标准：断开是这一屏上
  //   唯一一个会**销毁正在跑的计算**的按钮，它和"回列表"那颗紧挨着，而误点的代价
  //   是一个可能已经跑了几小时的作业加一份机时 —— 不可逆，也没有第二次机会。
  //   ★ 那句话里必须带上**有几个作业会没**：只说"确定断开吗"，用户答不了。
  //   ★ 条数现算（`liveCount()`，与 `allowSwitchTo` / `#dev-restart` 同一份定义）：
  //     写在别处缓存着的话，漂开的方向是"这个框说 2 条、那个框说 1 条"。
  $('btn-disconnect').onclick = () => {
    const n = liveCount();
    armConfirm($('btn-disconnect'), {
      why: n
        ? `断开连接会结束 ${n} 个会话 —— 集群上的作业会被取消，已经跑掉的时间不会回来。`
        : '断开与登录节点的连接。',
      yes: '断开',
      run: doDisconnect,
    });
  };

  // ── 三屏之间的前后关系 ──
  // ★ 它们是**一个站点的三个层次**，所以靠前后关系走，不是一排平级标签：
  //   进去要连着，退回不用。
  $('btn-plugins-back').onclick = () => showScreen('conns');
  $('btn-to-jobs').onclick = () => showScreen('jobs');
  $('btn-to-plugins').onclick = () => showScreen('plugins');

  // ── 作业列表那一屏 ──
  // ★ 这三个 id（`btn-jobs-new` / `btn-jobs-takeover` / `btn-jobs-end`）与
  //   panel.html 里那三个按钮由 test/renderer.test.mjs **逐字对着**：改了一边
  //   而没改另一边，当场变红。它们指的是哪三个动作，见 panel.html 那一段注释。
  $('btn-jobs-new').onclick = () => showScreen('plugins');
  $('btn-jobs-takeover').onclick = takeoverSelectedJob;
  $('btn-jobs-end').onclick = endSelectedJob;
  $('btn-jobs-reload').onclick = () => {
    const j = selectedJob();
    return window.slurmate.reload(j ? j.slot : null);
  };
  $('btn-jobs-refresh').onclick = refreshJobs;

  // ★ 站点对账是后台跑的，跑完**主动推**一份新视图过来。不接这条的话，用户看到的
  //   永远是连接那一刻的旧视图 —— 而"插件明明是站点说要给的、界面上却什么都没有"
  //   正是这个功能最该避免的那句话。
  window.slurmate.onPlugins((pv) => {
    if (!pv) return;
    renderPlugins(pv);
  });

  $('btn-doctor').onclick = async () => {
    const r = await window.slurmate.doctor();
    if (!r || !r.ok) return notice('error', '体检失败：' + ((r && r.error && r.error.detail) || '无响应'));
    const d = r.data;
    const bad = [];
    if (!d.socket) bad.push('socket 不存在');
    if (!d.table) bad.push('nft 表不存在');
    if (!d.rules_readable) bad.push('规则不可读');
    if (!d.consistent) bad.push(`规则数(${d.rules_count})与会话数(${d.active_sessions})不一致`);
    if (!(d.existing && d.existing.codeserver_table)) bad.push('现有的 inet codeserver 表不见了');
    if (!(d.existing && d.existing.portdaemon_table)) bad.push('现有的 port-daemon 表不见了');
    if (bad.length) notice('error', '体检发现问题：' + bad.join('；'));
    else notice('ok', `体检通过：${d.rules_count} 条 ACL 规则，${d.active_sessions} 个活跃会话。`);
  };

  // ★ 「最近作业」是一个**按需拉**的动作，不跟着上面那张表一起刷：它是最贵的
  //   一条查询（守护进程会同步 fork `sacct`），而它回答的"过去发生了什么"不会
  //   自己变新。
  $('btn-history').onclick = () => loadHistory();
  // 按需取一次日志。★ 它**不自动跑**：那是一次真的 RPC（退化成 exec 时是一次
  // sshd fork），而作业屏是要反复刷的 —— 自动取等于每刷一次多 fork 一个 python。
  $('btn-joblog').onclick = () => loadJobLog();

  // 重新加载打的是**前台**那一条 —— 屏幕只有一块，用户看的正是它。
  // ★ 面板里那一份挪到作业列表那一屏了（`#btn-jobs-reload`，打的是**选中**的
  //   那一条）；状态条这一份留着，理由与 `sb-end` 同：会话一跑起来，窗口主体
  //   就被原生视图整块盖住，那 30px 是唯一够得着的像素。
  $('sb-reload').onclick = () => window.slurmate.reload(frontSlot());
  // ★ `#btn-end` 那个按钮**没有了** —— 它的位置由作业列表那一屏上的
  //   【结束】（`#btn-jobs-end`，结束选中的那一条）接过。状态条上这一个留着，
  //   而且必须留着：会话跑起来之后窗口主体被原生视图整块盖住，那 30px 是唯一
  //   够得着的像素（与 `sb-reload` / `sb-temp` 同一条理由）。
  // ★★ 两段式（见 armConfirm）：它会取消集群上正在跑的作业，而它旁边紧挨着
  //   「重新加载」。第一段可退，第二段才真的结束。
  $('sb-end').onclick = () => armConfirm($('sb-end'), {
    why: '结束这一条会话，集群上的作业会被取消。',
    yes: '结束',
    run: endFrontSession,
  });

  // 状态条里的工作区选择器 —— 会话跑起来之后唯一够得着的入口。
  // 它改的是当前活跃连接的工作区（会话正跑在它上面，所以会立刻换端口重连隧道，
  // 而集群上的作业一动不动）。
  $('sb-workspace').onchange = async () => {
    const sel = $('sb-workspace');
    const v = sel.value;
    const r = await applyWorkspace(boot.activeConnectionId,
      v === NEW_WORKSPACE ? null : v,
      // ★★ 第一段挂在这颗下拉自己身上，而**下拉停在"待定"的新值上**（用户刚选的那
      //   一项）—— 它不是已发生的事，是"你要是确定就是这个"。所以退回去时必须
      //   `revert` 把它拨回真正的当前值，否则界面在说一件没发生的事。
      //   ★ `armed` 那一支**不重画**：重画会把那行确认连它的 `armed` 一起丢掉
      //   （见 `applyWorkspace` 的返回值注释）。
      { anchor: sel, revert: renderWorkspaceSelectors });
    if (!r.ok && !r.armed) renderWorkspaceSelectors();   // 拨回真正的当前值
  };

  // 窗口大小变了，连线的坐标就全变了。rAF 里重画，等布局定下来。
  window.addEventListener('resize', () => requestAnimationFrame(drawWorkspaceLines));

  for (const b of document.querySelectorAll('[data-debug]')) {
    b.onclick = async () => {
      const r = await window.slurmate.debug(b.dataset.debug);
      notice(r.ok ? 'dev' : 'error', r.ok ? '已触发：' + b.textContent : r.error);
    };
  }

  // ── 开发者模式那三个动词 ──
  // 三个都会**改一个要重启才生效的东西**，所以三个都不在这里"假装已经生效"：
  // 主进程回一份新的设置，照它重画（那一行「重启后生效」就是重画的产物）。
  $('dev-on').onchange = async () => {
    const r = await window.slurmate.setDeveloperMode($('dev-on').checked);
    if (!r.ok) { notice('error', r.error || '改不了开发者模式。'); renderDevMode(); return; }
    renderDevMode(r.developerMode);
  };

  $('dev-pick').onclick = async () => {
    const r = await window.slurmate.pickDevPluginDir();
    if (r.cancelled) return;
    // 失败（目录里读不出插件）时主进程**没有**保存，也没有推通知 —— 那句话由这里说，
    // 它带着"为什么"，而用户正盯着这个按钮。
    if (!r.ok) { notice('error', r.error); return; }
    renderDevMode(r.developerMode);
  };

  $('dev-reset-src').onclick = async () => {
    const r = await window.slurmate.clearDevPluginDir();
    if (!r.ok) { notice('error', r.error || '改不回来。'); return; }
    renderDevMode(r.developerMode);
  };

  $('dev-restart').onclick = async () => {
    // ★ 重启会先结束会话 —— 与关窗口同一套收尾。那是一次**明确的终止**（集群上的
    //   作业会被取消），所以必须先问一句：用户点的是"让设置生效"，不是"取消作业"。
    const n = liveCount();
    if (n && !window.confirm(
      n === 1
        ? '重启会先结束当前会话，集群上的作业会被取消。确定吗？'
        : `重启会先结束这 ${n} 个会话，集群上的作业会被取消。确定吗？`)) return;
    const r = await window.slurmate.restart();
    if (r && !r.ok) notice('error', r.error || '重启失败。');
  };

  // ── 两条边栏 ──
  //
  // ★ 停靠（鼠标进去）与钉住（点一下）是**两段**：第一段可退（移开就收），第二段
  //   把它钉住。理由是输出那一块**要滚动、要选中复制**，鼠标一挪开就没的话那两件
  //   事都做不了。见 windows.js 的 `toggleHoverPin`。
  //
  // ★ **收起不在这里**：它是鼠标几何判的（浮窗是原生视图，鼠标一进去这一格就再也
  //   收不到事件了 —— 靠 `mouseleave` 关的话，浮窗会闪一下就没了）。
  // ★★ **右栏在没有作业在跑的时候不开。** 它那一块是**作业输出**，而这份东西只有
  //   一个来源：一条在跑的会话。没有会话还滑出一块空面板，等于说"这里本该有东西"
  //   —— 而它本来就没有（设计律：非必要不提示，是一点都不提示）。
  for (const side of ['left', 'right']) {
    const el = $(`rail-${side}`);
    const wanted = () => side === 'left' || hasRunningSession();
    el.addEventListener('mouseenter', () => { if (wanted()) window.slurmate.hover({ side }); });
    el.onclick = () => { if (wanted()) window.slurmate.hover({ side, pin: true }); };
  }
  renderRails();
  // 左栏那个圆点。★ 主进程算好了三态才推过来 —— 界面这里**不重算**：
  //   重算的地方就是第二个"什么时候算断线"的判据，而它会与主进程那个漂开。
  window.slurmate.onSite((s) => {
    const d = $('rail-left-dot');
    d.className = 'rail-dot ' + ((s && s.state) || 'na');
  });

  window.slurmate.onStates(renderSessions);
  window.slurmate.onNotice((n) => {
    if (n.kind === 'dev') { $('dev-banner').classList.remove('hidden'); return; }
    if (n.kind === 'key-seen' || n.kind === 'key-blocked') {
      // 快捷键诊断：刻意记进日志，便于在真机上核对「哪些键到了页面、哪些被吞了」
      notice('info', (n.kind === 'key-blocked' ? '已拦截：' : '已放行：') + n.text);
      return;
    }
    // ★ `warn` **要留住**：把它折成 `info` 的话，主进程发来的每一条警告（例如"工作区已删除，但它那份
    //   浏览器存储没能清干净"）在日志里都长成「信息」—— 而一条显示成信息的失败，与一条
    //   被吞掉的失败是同一件事。
    notice(['ok', 'error', 'warn'].includes(n.kind) ? n.kind : 'info', n.text);
  });
}

/**
 * 取首屏数据，画出来。**所有 `await` 都在这里。**
 *
 * ★ 它 reject 只该是"首屏空着" —— 事件监听已经在 `bindEvents()` 里挂好了，
 *   与这里的成败无关。见那个函数的注释。
 */
async function bootUI() {
  boot = await window.slurmate.bootstrap();

  if (boot.dev) {
    $('dev-banner').classList.remove('hidden');
    $('app-sub').textContent = '开发者模式 · 未连接集群';
  } else if (boot.backendLabel) {
    $('app-sub').textContent = boot.backendLabel;
  }
  renderDevMode(boot.developerMode);

  // ★ bootstrap 里**没有**公钥 —— 密钥是按连接的，界面在打开某条连接的表单时
  //   单独去问（app:publicKey / app:newKey）。每个字段都是问出来的、当场渲染的。
  renderConnections(boot.connections);
  renderPartitions(boot.partitions || []);
  renderPlugins(boot.plugins);
  renderConnEmpty();
  // 本机的插件数据是一次**单独的对账**（它要读磁盘、还问一次 Electron 分区目录在
  // 哪儿）。★ **不 await 在首屏里**：让它挡住首屏就是把"面板画出来"与"磁盘快不快"
  // 绑在一起。回来之后再画那一块（它与 `bootstrap` 的关系见 index.js 的注释）。
  window.slurmate.pluginData().then(renderPluginData, (e) => {
    notice('error', '本机的插件数据没能列出来：'
      + ((e && e.message) ? e.message : e));
  });
  // 一条连接都没有 —— 第一眼就是「新建」，不然用户对着空列表找不到入口
  if ((boot.connections || []).length === 0) await openNewForm();

  // 拉一次全部会话。
  //
  // ★ 启动**不会**接回任何会话（`index.js` 不自动连），所以这里通常是
  //   一份空表。留着这一问是因为它同时回答了"这个客户端手上还有没有会话记录"
  //   —— 那与"连没连上"是两件事（比如上个进程留下的已经结束的记录）。
  const st = await window.slurmate.states();
  if (st && st.sessions && st.sessions.some((x) => x.live)) connected = true;
  // connected 是刚刚才定下来的，而连接列表在上面就已经渲染过了 ——
  // 补一次，否则那一条不会显示「已连接」
  renderConnections(boot.connections);
  renderSessions(st || { sessions: [], front: null });

  // ★★ **开局落在第一屏**（连接列表），而且没有任何自动连接。
  //   这一句是「不自动连」在界面这一侧的落点：`index.js` 那边不连，
  //   这里不跳。没有它的话，`screen-conns` 那份 HTML 是露着的（它是唯一没有
  //   `hidden` 的一屏），但路由的 `SCREEN` 还是上一次的值 —— 两份"我在哪一屏"
  //   会漂，而漂的形态是"点了返回，页面没动"。
  showScreen('conns');
}

async function init() {
  bindEvents();
  await bootUI();
}

/**
 * 换站点之前的那道闸：**连着一条、而它上面还有会话在跑时，不切。**
 *
 * ★★ 这不是一句"确定吗"。客户端只保持**一条活跃连接**（见 KNOWN-ISSUES 的
 *   S26(a)）—— 连着 A 的时候点 B，A 上那些正在跑的会话从此**不再被这台电脑
 *   看护**（心跳没了 ⇒ 300 秒 `suspect`、1800 秒 `orphaned`、然后 `scancel`），
 *   而用户点那个按钮时未必是这么想的。⇒ 有会话在跑时**不切**，把话说清楚，
 *   让他自己去按那一个**说得出后果**的按钮 —— 两个就在这一屏的标题栏上：
 *   【临时离开】（作业继续跑）与【断开】（作业停掉）。
 *   ★ 所以这里**没有第二个选项**可给，用的是 alert 而不是 confirm：confirm 的
 *     "确定"会把上面那句后果变成一个用户随手按掉的开关。
 *
 * ★ 拦的是"换到**别的**连接"，不是"重连当前这一条"：目标是当前活跃连接时直接
 *   放行（否则地址没变的重连会被自己挡住）。
 * ★ 判据用 `liveCount()`，与【断开】、【重启】那两处**同一份定义** —— 各写一遍的话，
 *   漂开的方向是"这个框说 2 条、那个框说 1 条"，而用户会以为自己看错了。
 *
 * @returns {boolean} true = 可以继续；false = 已经拦下、并且把话说完了
 */
function allowSwitchTo(connId) {
  const n = liveCount();
  if (!connected || !n) return true;
  if (connId && connId === boot.activeConnectionId) return true;   // 重连当前这条
  const cur = (boot.connections || []).find((x) => x.id === boot.activeConnectionId);
  window.alert(
    `当前还连着「${cur ? connLabel(cur) : '这一条'}」，它上面有 ${n} 条会话在跑。\n\n`
    + '一个客户端同时只连一个站点。要换过去，请先在这一屏把当前这条收掉：\n'
    + '· 【临时离开】—— 作业继续在集群上跑（但没人看着它 35 分钟就会被回收）\n'
    + '· 【断开】—— 把作业停掉\n\n'
    + '这两个按钮就在这一屏的标题栏上。');
  return false;
}

/** 连上列表里的某一条。点它就等于把它设为当前连接。 */
async function doConnectTo(c) {
  // ★★ 闸在**改任何状态之前**：拦下时 `setActiveConnection` 一次都不许被调到 ——
  //   它一调，配置里"活跃连接"就已经是新那条了，而实际连着的是旧那条，
  //   两份事实从此对不上（下一次启动重连会连到用户没打算去的那台）。
  if (!allowSwitchTo(c.id)) return;
  const r = await window.slurmate.setActiveConnection(c.id);
  if (!r.ok) return notice('error', r.error);
  boot.activeConnectionId = c.id;
  renderConnections(boot.connections);
  await handleConnectResult(await window.slurmate.connect({ connectionId: c.id }));
}

/**
 * 【临时离开】—— 回这个列表，**作业继续在集群上跑**。
 *
 * ★★ 它与【断开】是**两个方向相反**的动作，而它们的区别**只在一条请求上**：
 *   这里发的是 `leave`（看护者置空），断开发的是 `goodbye`（`scancel` 作业）。
 *   写反了的后果是**用户的作业被删掉**，而界面上那句提示会告诉他"作业还在跑"——
 *   一句话和它描述的事实正好相反，且不可撤销。
 *
 * ★★ 「离开」**不是暂停**：倒计时从这一刻起算，走的还是那一条窗口
 *   （300 秒 suspect → 1800 秒 orphaned → `scancel`）。所以这里必须把那句话
 *   **说出来**，而不是等用户自己发现 —— 见 panel.html 里这个按钮的 title。
 *   ★ 三态纪律照旧：`left.ok === false`（这一条没送出去）与 `cleared` 是空
 *     是两件事，前者说"那句话没能告诉控制节点"，后者说"本来就没人在看"。
 */
async function doLeave() {
  const r = await window.slurmate.leave();
  if (!r || !r.ok) return notice('error', (r && r.error) || '临时离开失败。');
  connected = false;
  whoami = null;
  const left = r.left;
  if (left && !left.ok) {
    // ★ 没能告诉控制节点，而用户**确实已经离开了** —— 两句都要说。
    //   只报错的话，用户会以为"离开没成功、还连着呢"，而去重按一次。
    notice('warn', '已经回到列表，但没能告诉控制节点你离开了：' + left.error
      + '　作业仍在运行 —— 只是那 35 分钟要从「没人看着它」被判定出来才开始算。'
      + '想立刻确认它没事，重新连上这个站点即可。');
  } else {
    notice('info', '已临时离开。作业仍在集群上运行 —— '
      + '但本机不再看着它：35 分钟内没有人回来接着看，它会被自动回收。');
  }
  // ★ 回到第一屏，并把作业列表作废 —— 与断开逐字同一个理由：那份数据属于刚才
  //   那个站点，留着它会让下一次进作业列表时先闪一下**上一个站点**的作业
  //   （见 JOBS.forConn）。
  JOBS = { forConn: null, list: null, at: 0, error: null, selected: null };
  renderConnections(boot.connections);
  renderSessions({ sessions: [], front: null });
  showScreen('conns');
}

/**
 * 【断开】—— **彻底终止**。还有会话的话先取消作业、释放资源，再拆连接。
 *   「断开」和「结束会话」在这里是同一件事的两种说法，因为对用户来说
 *   它们的意思本来就一样：我不要了。凡是用户主动表达的终止，都不该留下
 *   一个还在集群上占着资源的作业。
 *
 *   反过来，合盖/断网/断电时这个函数不会被调用 —— 那条路走守护进程的
 *   suspect/orphaned 容错窗口，客户端下次启动自动接回。
 *
 * ★★ 它走**两段式**（`#btn-disconnect` 那颗按钮上的 `armConfirm`），而旁边的
 *   「临时离开」一下就走。这不是双重标准：断开是这一屏上唯一一个会**销毁正在跑的
 *   计算**的按钮，它和"回列表"那颗紧挨着，而误点的代价是一个可能已经跑了几小时的
 *   作业加一份 12 小时的机时 —— 不可逆，也没有第二次机会。
 *   ★ 那段后果（**有几个作业会没**）由第一段说出来：只说"确定断开吗"，用户答不了。
 *
 * ★★ **这个函数自己不再问第二遍。** 它从前在 `armConfirm` 之外还有一句
 *   `window.confirm`，于是同一个动作问两遍（第一段一行确认 + 一个系统对话框），
 *   而那两句话说的是同一件事。用户 2026-10-09 明说"所有都确认好几遍这不是很烦人么"。
 *   ⇒ 那句话里唯一**不是**后果的那半句（"只是想回列表就点「临时离开」"）
 *     搬进了这颗按钮的 `title`：它是一个**别的选择**，不是一个"你确定吗"。
 *   ★ 于是这个函数可以被别处直接调用而不会弹框 —— 它只做那件事。
 */
async function doDisconnect() {
  const r = await window.slurmate.disconnect();
  if (!r || !r.ok) return notice('error', (r && r.error) || '断开失败。');
  connected = false;
  whoami = null;
  const rel = r.released;
  if (rel && !rel.ok) {
    notice('error', rel.detail);          // 释放没成功必须说，不能吞掉
  } else if (rel && rel.state === 'releasing') {
    notice('info', '已断开连接，并请求释放会话。请以状态条变为「已结束」为准。');
  } else {
    notice('info', '已断开与登录节点的连接。');
  }
  // ★ 断开之后**回第一屏**，并把作业列表作废（理由见 doLeave）。
  JOBS = { forConn: null, list: null, at: 0, error: null, selected: null };
  renderConnections(boot.connections);
  renderSessions({ sessions: [], front: null });
  showScreen('conns');
}

async function doProbe() {
  const btn = $('btn-probe');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '探测中…';
  try {
    lastProbe = (await window.slurmate.probeHosts()) || [];
    renderConnections(boot.connections || []);

    if (lastProbe.length === 0) {
      // 「一条都没配」和「配了但都不通」是两回事，文案必须分开 ——
      // 不能写死成「三个地址都不可达」，候选可能是 0 个。
      // ★ 还有第三种：**只有内置那条假站点**。主进程不探它（它在本机，见
      //   `app:probeHosts`），于是探测结果是空的，而列表上明明有一条连接 ——
      //   写成"还没有保存任何连接"是在说一件用户一眼就能看见不成立的事。
      notice('info', (boot.connections || []).length
        ? '内置的那条是本机的假站点，没有可探测的地址 —— 没有别的连接可探。'
        : '还没有保存任何连接。填好上面的用户名、主机、端口，点「保存并连接」。');
      return;
    }
    const ok = lastProbe.filter((h) => h.reachable);
    if (ok.length === 0) {
      notice('error', `${lastProbe.length} 个已保存的连接都不可达。`
        + '请确认网络，或检查地址与端口是否正确。');
    } else {
      notice('ok', `${ok.length}/${lastProbe.length} 个连接可达，最快的是「${ok[0].label}」（${ok[0].rttMs}ms）。`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/**
 * 初始化中途失败。
 *
 * ★★ 它**不再只走 `notice`**。理由是一条实测过的失败形状：`bindEvents()` 从前排在
 *    `bootUI()` 那几个 await 的后面，于是一次 reject 就让**整块监听一个都不挂** ——
 *    而症状只有提示流里一行字，用户看到的是"一半按钮点了没反应"，指不回任何一处。
 *    监听那半边已经解耦（见 `bindEvents`），这一半是另一半：**剩下会坏的，
 *    也得让人第一眼看见**。
 * ★ 只写横幅、不另写一条 `notice`：同一条消息两个落点就是两份实现，
 *    而它们会漂。横幅常驻在最上面，比会滚走的提示流更该是那唯一一处。
 */
function onInitFailed(e) {
  const why = (e && e.message) ? e.message : String(e);
  $('fatal-why').textContent = why;
  $('fatal-banner').classList.remove('hidden');
}

init().catch(onInitFailed);
