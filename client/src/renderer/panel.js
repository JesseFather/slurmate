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
 * 登录节点这一屏的第一眼必须是已保存的连接 —— 用户每次打开客户端要做的事
 *   是「连上上次那台」，不是「再填一遍地址」。公钥和地址表单折进「新建连接」里，
 *   那是第一次使用时才走一遍的流程。
 *
 * 密钥是按连接的（见 main/config.js）。所以「新建」与「编辑」共用同一块表单，
 *   各自展现自己那一把钥匙：新建时是刚生成、还没有归属的那把，编辑时是这条连接的
 *   那把。界面上没有「全局密钥」这个概念 —— 重新生成只影响当前这一条。
 *
 * 地址栏永远不预填。预填上一个连接的地址，用户不改直接点保存，得到的只是
 *   「又存了一条一样的」，而他以为自己新建了一条。
 *
 * 「开始会话」那一段一个插件名都不写：站点装了哪些、本机认得哪些，都是
 *   运行期才知道的（见 renderPlugins）。写死的话，「站点卸掉一个插件」在界面上
 *   就变成了"点了报错"，而不是"那一块不见了"。
 *
 * 会话跑起来之后窗口主体会被插件声明的那块界面整个盖住，
 * 所以「重新加载 / 停止该作业」这两个必需的操作也放在状态条里 ——
 * 那是唯一始终可见的、属于我们自己的区域。
 *
 * 这个界面里没有任何「打开配置文件」的入口，这是有意的：
 *   所有条目都在界面上，用户不该为了改一个地址去手编辑 JSON。
 */

const $ = (id) => document.getElementById(id);

// 新建连接时端口那一格的初值。22 是 SSH 自己的默认端口，不是任何一个集群的
//   值 —— 这一格从前写着一个具体集群的端口当占位符，那让"默认"看起来像
//   "我们推荐这个数"。它只有这一处定义：主进程不设默认值（端口是必填的，
//   `config.js` 的 `normalizeConnection` 只判它合不合法）。
const DEFAULT_SSH_PORT = 22;

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

/**
 * 在 / 不在这个站点里。这一格只有这一个入口改 —— 因为两条边栏跟着它走
 *   （`body.connected`）：它们是站点级的两格，不在站点里就没有可问的也没有可看的
 *   （见 renderConnections）。
 *
 * 少画一次的症状是静默的：连上那一刻主进程推来的会话表可能早于这一句
 *   到达，而它此后不会自己再画一次 —— 下一次推送要等到某条会话变动。
 */
function setConnected(on) {
  connected = Boolean(on);
  document.body.classList.toggle('connected', connected);
  renderTabs();
}
let lastProbe = [];          // 最近一次探测结果，供连接列表显示
let lastSnap = null;         // 前台那一条的快照，供状态条、映射图与作业详情读它
let SESS = { sessions: [], front: null, panelFront: false };
// 上面那一格：全部会话、哪一个是前台、以及面板此刻有没有盖在会话页面上
//   （`panelFront` 由主进程给，见 renderSessions 与 renderStatusEnd）。
/** 上一次推送时活着的槽，逗号连起来。作业那一屏据此判断"要不要重取一次"。 */
let lastLiveIds = null;
/**
 * 最近一次的插件清单。界面里有两处需要知道"这个会话的插件声明了界面没有"，
 * 而快照本身是插件无关的（session.js 不认识任何插件）—— 所以在这里留一份，
 * 按 `serviceKind`（站点短名）去查。
 */
let lastPlugins = null;
/**
 * 上一次画插件块时那两份输入的指纹（见 `pluginsSignature`）。
 *
 * 它只在 `renderPlugins` 里读写，别处一个字都不许碰：它是"屏幕上现在画的是什么"
 *   的记录，任何人绕过去改它，下一份真正不同的视图就会被跳过。
 */
let pluginsSig = null;

/** 工作区下拉里「新建一个空白工作区」那一项的值。不是工作区 id，别混。 */
const NEW_WORKSPACE = '__new__';

/**
 * 插件块那个「用哪一份数据」下拉里「另开一份」那一项的值。同样不是数据 id。
 *
 * 它不能用一个空串代替：「空串」在下拉里是"这一格还没有值"（跟随默认），
 *   而这里要的是"另开一份，哪怕现在已经有一份" —— 两件事，两种值。
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
 * 它是一个用户的选择，不是从会话状态推出来的。按会话状态算显隐的话
 *   （空闲就露连接列表、跑起来就露当前会话），"用户在哪儿"就没有地方记着 ——
 *   他去作业列表看一眼，下一次快照回来就被弹回另一屏。这一格就是为此存在的。
 */
let SCREEN = 'conns';

/**
 * 第三屏（作业列表）的那一份数据。
 *
 * `forConn` 是这份数据属于哪条连接 —— 切连接之后它立刻作废。少了这一格，
 *   用户切到另一个站点、还没刷新时会看到上一个站点的作业列表，而每一行
 *   看起来都像真的。这是这一屏唯一会静默说谎的地方。
 */
let JOBS = { forConn: null, list: null, at: 0, error: null, selected: null };

/**
 * 详情底下那份日志此刻画的是哪一条。`null` = 没画。
 *
 * 它不进 `JOBS`：那不是列表数据，是"界面上正摆着谁" —— 与 `JOBS` 一起重置
 * 只会让两处各自多一份要维护的常量。
 */
let jobLogFor = null;

// ── 工具 ────────────────────────────────────────────────────────────────────
function fmtLeft(expiresAt) {
  // expires_at 在 show_job 失败时整个字段不存在（守护进程的行为）。
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

/**
 * 提示的四档。
 *
 * `kind` 直接进 `className`，而它来自主进程推过来的那条通道（`pushNotice`），
 *   那条通道没有类型。一个没见过的值会变成一个没有定义的类：既没有颜色也没有
 *   图标，现场看起来像"样式坏了"，而不是"有一句话没有转成能画的东西"。
 *   所以收进这四档，之外的一律按「信息」画。
 */
const NOTICE_KINDS = ['ok', 'error', 'warn', 'info'];

function notice(kind, text) {
  const k = NOTICE_KINDS.includes(kind) ? kind : 'info';
  const box = $('notices');
  const el = document.createElement('div');
  el.className = 'notice ' + k;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = { ok: 'OK', error: '错误', warn: '注意', info: '信息' }[k];
  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = text;              // textContent：绝不把外部文本当 HTML 插进去
  el.append(tag, body);
  box.prepend(el);
  while (box.children.length > 80) box.lastChild.remove();
}

// ── 两段式确认 ──────────────────────────────────────────────────────────────
/**
 * 当前正处在第一段的那个确认。同时只允许一个 —— 界面上摆着两行"确定吗"，
 * 用户按了其中一行那颗按钮，另一行还挂在那儿，而他分不清刚才确认掉的是哪个。
 */
let armed = null;

/**
 * 两段式：第一次点只是把那一格换成一行确认，第二次点才真的做。
 *
 * 为什么不可逆的动作不能用 `window.confirm`：它给不了两段 —— 框弹出来的
 *   时候用户已经按下去了，而这里要的正是"按下去之后还有一次可退的机会"。
 *   它的样式也不受控（在 Electron 里那是一块系统窗口，尺寸、语言、焦点行为都不
 *   归我们管），于是同一个客户端里几处不可逆动作会长得不一样。
 *
 * 第一段可退：点到别处、按 Esc、点「取消」，都回到原样。不可逆的只有第二段。
 * 原来那颗按钮留在 DOM 里（加一个 `.armed-off`），不删 —— `renderSnapshot`
 *   还在按 `running` 去 toggle 它的 `hidden`，删掉的话那是作用在 null 上。
 *
 * @param {HTMLElement} anchor 那一格的按钮
 * @param {{why?: string, yes: string, run: () => any, onDisarm?: () => void}} opts
 *   `why` 是后果，不是解释：设计律 2 要的是"把警告变成动作的前置状态"。
 *   `onDisarm` 只在退回去的时候跑（点别处 / Esc / 点「取消」/ 被后来那一次
 *   顶掉 / 重画之前收起），第二段执行时不跑 —— 那一格已经被改动了，
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
  /** @param {boolean} [acted] 第二段真的执行了 —— 那时不跑 `onDisarm`。 */
  const disarm = (acted) => {
    if (armed !== here) return;         // 已经被后来那一次顶掉了，别把它的界面收掉
    armed = null;
    document.removeEventListener('click', outside, true);
    document.removeEventListener('keydown', onKey, true);
    cluster.remove();
    anchor.classList.remove('armed-off');
    if (!acted && opts.onDisarm) opts.onDisarm();
  };
  // 捕获阶段，而且判的是"点在不在这一行里面"：用户点到别处时他心里想的是
  //   "算了"，那一下不该顺带触发别的东西（他已经在收手了）。
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

// ── 「端口被占：启动 / 记住并启动 / 取消」──────────────────────────────
/**
 * 上一次提交被端口挡住的那一趟，等着用户答。没问过就是 `null`。
 *
 * 它记着 `{serviceKind, adv, btn}` —— 用户答下那两颗"继续"里的任意一颗时，要把
 * 同一件事重发一次（分别只在带上去的那个作答上）。`adv` 是那一块那几格
 * 高级选项（见 `pluginAdv`）：重发时读的仍是用户刚才填的那一份。
 */
let portAsk = null;

/**
 * 摆出那一行三选一。它不是确认。
 *
 * 与 `armConfirm` 的分别只有一条，但读错了就会写歪：`armConfirm` 是"第一下只是
 *   摆出来，第二下才真的做"；这里三颗按钮都是当场生效的动作。三个答案都是用户
 *   主动要的：
 *     · 启动 —— 带 `portChoice:'shift'` 把刚才那一趟重发一次（走既有的顺移扫描，
 *       不写回配置）；
 *     · 记住并启动 —— 带 `portChoice:'remember'` 重发，而主进程在绑定
 *       成功之后把这份数据的首选端口记成新那个。这是全界面唯一一颗会改配置
 *       的按钮（长相也不一样，见 app.css 的 `button.remember`）；
 *     · 取消 —— 就地回退，而此刻本来就什么都没提交（作业、会话记录、占位都
 *       没有）—— 所以那一句不是安慰，是事实。
 * 别照 `armConfirm` 的路子给它加一段"再点一下才执行"。
 *
 * 它因此不自带 `armed-off`：那个类是为了"原来那颗按钮留在原地但不显示"，
 *   而这里没有任何一颗按钮要被顶掉。
 *
 * 那个理由由主进程给（`app:start` 的 `error`）：界面不自己编一句 —— 两处
 *   各写一句的漂法是"主进程说端口被占、界面说别的"，而用户会去查一个不存在的区别。
 */
function renderPortAsk(r, pending) {
  portAsk = pending;
  const want = (r.port && r.port.want);
  $('sb-port-why').textContent = r.error || '首选端口被占着。';
  // 而那句理由在窄窗口里会被裁短（见 app.css 的 `#sb-port-why`）：裁掉的那半句
  //   挂在 `title` 上，鼠标停一下还读得全 —— 被裁掉的是一句解释，不是一颗按钮。
  $('sb-port-why').title = $('sb-port-why').textContent;
  // 三颗按钮各自说清代价 —— 长解释进 `title`，正文只留动作。
  //   这些字是界面字符串（走 `textContent` 与 `title`），所以里面不许出现
  //     减价记号（`**`）—— 它会被原样印出来。见 renderer.test.mjs 那一条判据。
  $('sb-port-shift').title =
    `只换这一次会话的端口，配置里那个（${want}）不动。`
    + '浏览器按端口隔离本地存储，编辑器布局与最近打开的文件会重置一次。'
    + '占用它的程序退出后，下次启动回到原端口，布局也还在。'
    + '程序一直占着时，每次开局都要问一遍。';
  $('sb-port-remember').title =
    `把这份数据的端口改成新的那个（原本是 ${want}），此后启动不再问。`
    + '不可逆：原端口与挂在它上面的编辑器布局都回不来。';
  $('sb-port-abort').title =
    '什么都不做：集群上不会出现作业，也不会占住那份数据。'
    + '想运行它，先腾出那个端口，再点一次「开始会话」。';
  $('sb-port').classList.remove('hidden');
}

/**
 * 把那一行收掉（答过了、或者用户走开了）。
 *
 * 收掉不等于答了「取消」：没有提交过任何东西，所以"没答"的后果与"答了取消"
 *   逐字相同 —— 但话不能反过来说（见 `showScreen` 里那一条：走到别的屏去了
 *   也不留一句"你没有启动"）。
 */
function clearPortAsk() {
  portAsk = null;
  $('sb-port').classList.add('hidden');
}

// ── 三屏的路由 ──────────────────────────────────────────────────────────────
/**
 * 把三屏之一露出来。同时只露一个。
 *
 * 为什么"我在哪一屏"必须是一个显式的状态：这三屏是一个站点的几个层次
 *   （连接 → 插件 → 作业），而"在哪一层"取决于用户
 *   刚才点了什么，不取决于会话此刻是什么状态。按后者判的话（`idle` 露连接列表、
 *   跑起来露当前会话），用户点进作业列表看一眼，下一次快照回来就被弹回另一屏
 *   ——而他什么都没做。
 *
 * 站点状态不在这里：它从边栏的浮窗里看（`hover.html`）。从前它是一个盖在
 *   三屏上面的节（`#sec-cluster`），于是同一份 `op_cluster` 的答案有两个落点 ——
 *   浮窗接手之后那个节整个删掉，不留第二份渲染。
 */
function showScreen(name) {
  const prev = SCREEN;
  SCREEN = name;
  // 换屏（以及连上/断开那三处收尾）把「端口被占」那一问收掉：它问的是当前这条
  //   连接的那些数据的端口，而用户已经走开了 —— 把一个问题留在状态条上等着答，
  //   而它描述的东西可能已经不是他现在看的这一条了，那是界面在说一件不成立的事。
  //   收掉不等于答了「取消」：没提交过就是没提交过，所以不补一句
  //     "你没有启动" —— 那会是一条凭空造出来的对话记录。
  clearPortAsk();
  for (const [key, id] of [['conns', 'screen-conns'],
                           ['plugins', 'screen-plugins'],
                           ['jobs', 'screen-jobs']]) {
    $(id).classList.toggle('hidden', key !== name);
  }
  // 离开插件那一屏，把各块的高级选项收起来。判据是"收起"，不是"离开"：
  //   收起 = 退回默认，展开着才可能填着值（用户 2026-10-18 定的）。这一屏的 DOM
  //   一直留在文档里，切走只是加一个 `hidden` —— 不在这里收，切回来时面板还开着、
  //   值也还在，而用户已经离开过一次了。
  if (prev === 'plugins' && name !== 'plugins') {
    for (const st of advCells) st.collapse();
  }
  // 离开第一屏就把那个表单收掉 —— 它只在「还没连上」那一屏里说得通（判据是
  // "用户走开了"，不是"会话跑起来了"）。不收的话，用户从第二屏退回来会看见一个半填的表单，
  // 而它上面那个地址可能已经连过了。
  if (name !== 'conns') closeForm();
  // 第二和第三屏的标题都带上是哪一个站点 —— 用户在几台机器之间来回时，
  // 最要紧的一件事就是"我现在看的是哪一台"。
  // 2026-10-11 补上作业那一屏：它从前只写着一个死的「作业」，而它恰恰是最容易
  //   忘了自己在哪一台上的地方（几条会话、几个站点）。
  // 2026-10-17 起地址单独一行（小字、灰，见 `#screen-plugins > .sec-head` 那一段）：
  //   混在标题里时「插件 · user@host」太长，窄窗口下那一行会被顶开。
  // 那一行写「登录条目」加地址与端口（2026-10-17 改）：第一屏那一行只有
  //   客户端的名字，这几屏说的是脚下的哪一条 —— 用户的原话是"登录节点写成
  //   登录条目"。端口要带上：同一个主机上的两个端口是两条不同的连接。
  // 判据是活跃连接（主进程那一格），不是"上次点了哪一行"：删掉一条连接、
  //   或者从别处改了活跃连接之后，界面手上那份"我刚才点的是谁"就已经过期了。
  const conn = ((boot && boot.connections) || [])
    .find((c) => c.id === (boot && boot.activeConnectionId));
  const site = conn ? `登录条目：${conn.user}@${conn.host}:${conn.port}` : '';
  $('plugins-title').textContent = '插件';
  $('jobs-title').textContent = '作业';
  for (const id of ['plugins-site', 'jobs-site']) {
    const row = $(id);
    if (!row) continue;
    row.textContent = site;
    row.classList.toggle('hidden', !site);
  }
  // 屏一换，那些跟着当前这一屏走的小块都要重算一次：作业详情（只在这一屏里
  // 露）、映射图的连线（几何，元素刚露出来的那一帧还没定下来）。都交给
  // `renderSnapshot` 那一份判据 —— 在这里另判一遍就是两份，而它们会漂。
  // 上栏也一样：它只在第二、三屏上画（见 `renderTabs`），换屏之后要立刻跟上，
  //   否则从第一屏连进来之后，标签要等下一次状态推送才出现。
  renderTabs();
  renderSnapshot(lastSnap);
  if (name === 'jobs') refreshJobs();
}

/**
 * 主进程推来的全部会话 + 哪一个是前台。
 *
 * 面板这一层只需要"画哪一条"（`renderSnapshot` 照旧只画前台那一条），而
 *   决定权在主进程（`index.js` 的 `frontSlot()`）—— 界面这里一个字都不推。
 *   推的话就多了一个会漂的"当前会话"，而它的失败形态是"点结束会话，停掉的是另一条"。
 */
function renderSessions(payload) {
  const p = payload || {};
  SESS = {
    sessions: Array.isArray(p.sessions) ? p.sessions : [],
    front: p.front || null,
    panelFront: p.panelFront === true,
  };
  renderTabs();
  // 右栏那个点跟着"有没有作业在跑"走，而那个判据刚刚才更新 —— 所以它必须在
  //   `SESS` 写完之后算（放在 renderTabs 之前会让它慢一拍，而"慢一拍"的表现是
  //   作业起来了右边那个点却要等下一次推送才亮）。
  renderRails();
  // 第二屏那颗「临时离开」也只在真有作业在跑时出现（2026-10-11 改）：
  //   没有作业可"离开"的时候摆一颗按下去什么也不发生的按钮，是在说一件不成立的事。
  //   它挂在这一路上，不是"进第二屏的时候算一次"：作业会在用户待在这一屏
  //   的时候起停 —— 另一台电脑接管、作业自己跑完、或者他从作业那一屏起了一条新的。
  //   判据 `hasRunningSession()` 与右栏那一条同源（同一个函数，不是各算一遍）。
  //   而「断开」不需要这句：第二屏只有连着才进得来，它在那一屏上一直在。
  $('btn-leave').classList.toggle('hidden', !hasRunningSession());

  // 作业那一屏开着的时候，活会话的集合一变就重取一次列表。
  //
  //   那一屏问的是服务端（`app:jobs`），它不跟着状态推送更新。而"刚点完启动"
  //   那几秒提交还没有返回，列表里当然没有这一条 —— 用户立刻切过来看到的是空的，
  //   而它不会自己长出来（2026-10-18 真机：排队中的作业不在作业那一屏上）。
  //   判据是集合变没变，不是每一份推送都问一次：状态推送的读者远多于这一屏。
  const liveIds = SESS.sessions.filter((x) => x.live).map((x) => x.slot).sort().join(',');
  if (SCREEN === 'jobs' && liveIds !== lastLiveIds) refreshJobs();
  lastLiveIds = liveIds;

  // 插件块上「还能不能再开一个」跟着会话表走。就地改那两格，不重画整块 ——
  //   重画会把用户填了一半的高级选项清掉（见 `renderPlugins` 的指纹与
  //   `syncPluginQuota`）。
  syncPluginQuota();

  renderSnapshot(frontSnap());
}

/** 前台那一条的快照（没有会话时 null）。 */
function frontSnap() {
  const hit = SESS.sessions.find((x) => x.slot === SESS.front);
  return (hit && hit.snap) || null;
}

/**
 * 前台那一条是不是临时实例（第二份、数据是一份副本、会话结束就没了）。
 *
 * 判据由主进程给（`index.js` 的 `sessionViews` 里的 `temporary`），界面这一层
 *   一个字都不推 —— 它不掌握"哪一份是持有者"这件事，猜的话就会在回收之后
 *   还告诉用户"这里不会记录你的改动"（或者反过来，让用户以为改动留下了）。
 *
 * 它不是一个瞬时通知，而是一条常驻状态：只要那一份还开着，这句话就成立。
 *   所以问的是"前台那一条现在是什么"，而不是"刚才发生过什么"。
 */
function frontTemporary() {
  const hit = SESS.sessions.find((x) => x.slot === SESS.front);
  return Boolean(hit && hit.temporary);
}

/**
 * 状态条底下那一排标签。一条会话一个，另有一颗「面板」。
 *
 * 条栏什么时候露出来：两条以上、或前台那条会话带着一块页面。
 * 最后那一条是 2026-10-18 补的（真机）：只有一条会话时整条栏从前是收着的，
 *   而那一块原生视图从 y=30 往下盖住整个窗口主体 —— 于是用户起完 web-demo
 *   就再也回不到插件页与作业页，连"现在跑的是哪一条"都看不见。
 *   一条会话 + 一块页面时，这一条栏必须露：它承载的是这个窗口里唯一的出路。
 * 每一条都要能点 —— 那是"我还能切回去"的唯一入口。前端那条加一个 class。
 *
 * 标签重名时要补一个区分符。标签上写的是插件的显示名，而同一个插件
 *    开两份（`contributes.concurrent: true`，第二份拿到自己的临时数据 = 自己的
 *    槽）是完全合法的一件事 —— 那时顶栏上会出现两个一模一样的标签，而它们指着
 *    两份不同的数据、两个不同的本地端口。用户点哪一个都有一半概率点错。
 *
 *    区分符用本地端口：它就是"这一条在哪个地址上"，而且与"哪一份浏览器存储"
 *    一一对应。只在真的重名时才加（不重名一个字不加）—— 给每一条都挂一个
 *    端口号，等于把"这两条需要分"这件事说给所有人听。
 *
 * ️ 曾经这里有一句注释说"两条会话的插件必然不同，所以服务名天然唯一" ——
 *    那是工作区那一轮之前的形状（当时槽是按工作区分的，同一个工作区同时只能
 *    有一条要界面的会话）。现在不成立了，留着会让下一个人以为重名不可能。
 */
function renderTabs() {
  const box = $('session-tabs');
  // 第一屏是"还没进去"的那一屏：那里没有可切的会话。停在第一屏却看见标签，
  //   是"连接卡着、而界面已经有一部分进去了"的样子（用户 2026-10-19 真机）。
  if (SCREEN === 'conns') {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  const list = SESS.sessions;
  // 有没有一块页面正盖着面板。判据与"重新加载 / 停止该作业"那两颗同一份
  //   （`hasSurface`）：声明了界面的插件才会起那块原生视图，也只有那时"回不去"
  //   这回事才存在。中转站那类会话不盖任何东西，不需要这一条栏。
  // 判据读的是快照（`s.snap`，插件的站点短名在它里面）—— 会话视图这一层
  //   没有 `serviceKind`，拿它去查插件永远查不到，于是这一条栏会静默地收着。
  const covered = list.some((s) => s.live && s.snap && hasSurface(s.snap));
  // 只要还有一条会话在跑，这一条栏就露着 —— 它是切回那块页面的唯一入口。
  //   用户 2026-10-18：在运行的那些插件作业要一直挂在上栏，随时能切过去。
  //   与 `covered`（有页面盖着）分开：中转站那类没有页面的会话也占着资源，
  //   它的标签同样要有地方看得见。
  const anyLive = list.some((s) => s.live);
  box.classList.toggle('hidden', !covered && !anyLive && list.length < 2);
  box.textContent = '';
  // 先数一遍名字：同名的那些才需要区分符。
  const seen = new Map();
  for (const s of list) {
    const n = s.service || '（未知服务）';
    seen.set(n, (seen.get(n) || 0) + 1);
  }
  // 「面板」排第一（用户 2026-10-18）：它是一个固定的回程，而会话标签是
  //   一路往后加的 —— 排最后的话，新开的会话一多，它就被推到看不到的地方。
  //
  // 它与会话标签做的是相反的事（那几颗抬页面、这一颗抬面板），所以长相加一个
  //   虚线边（见 app.css 的 `.tab.panel`）：两颗相反的动词长成一模一样，正是
  //   最容易点错的那一格。
  // 只要这一条栏露着，它就一直在（用户 2026-10-27）。从前它的判据是
  //   「有没有页面盖着」，于是只跑着一个没有界面的插件时，栏里只剩一颗点不动
  //   的插件标签，而回面板的那颗按钮整个不见了。它不是"这一刻有没有用"的按钮，
  //   是这个窗口的固定回程 —— 栏在，它就在。
  // 点它不换屏 —— 回到用户离开时的那一屏（`SCREEN` 是用户的选择，见那一格）。
  const panelTab = document.createElement('button');
  panelTab.className = 'tab panel';
  panelTab.textContent = '面板';
  panelTab.title = covered
    ? '把面板抬到会话页面上面。插件页与作业页都在那里，回到你离开时的那一屏。'
    : '回到插件页与作业页（你离开时的那一屏）。';
  panelTab.onclick = async () => {
    const r = await window.slurmate.showPanel();
    if (!r || !r.ok) { notice('error', (r && r.error) || '面板抬不起来。'); }
  };
  box.appendChild(panelTab);
  for (const s of list) {
    const b = document.createElement('button');
    // 被接管的会话仍然列在这里（它还在集群上跑着），但页面已经收掉了 ——
    //   `dead` 说的正是"这一条现在没有可切过去的东西"，与已结束的同一档。
    const suspended = Boolean(s.snap && s.snap.suspended);
    const plug = pluginOfSession(s.snap);
    // 跑着、而插件明说了自己没有界面（中转站那类）：标签要在（它是"这一条
    //   在跑"的唯一记号），可它没有可切过去的页面 —— 点下去什么都不会发生。
    //   灰掉、不许点（用户 2026-10-27）。判据要求 `plug` 在：插件认不出来时
    //   不知道它有没有页面，那时不许把一颗可能真的能切过去的标签按死。
    const noPage = Boolean(s.live) && !suspended && Boolean(plug) && !plug.surface;
    b.className = 'tab' + (s.slot === SESS.front ? ' on' : '')
      + (s.live && !suspended ? '' : ' dead')
      + (noPage ? ' nopage' : '');
    b.disabled = noPage;
    const name = s.service || '（未知服务）';
    const port = s.snap && s.snap.localPort;
    b.textContent = seen.get(name) > 1 && port ? `${name} · ${port}` : name;
    const st = s.snap && s.snap.state;
    const base = suspended ? s.snap.suspended : (STATE_TEXT[st] || st || '');
    // 输入法失效时页面收不到按键，而这不是会话本身出了问题；把恢复动作放在
    //   标签的 title 上，用户不必去翻排障文档。
    const ime = '输入法无效时先点击编辑区；仍无效时重新加载。';
    // 没有界面的那一条把"为什么点不动"写在 title 上 —— 一颗灰按钮不说原因，
    //   读起来像"它坏了"。
    b.title = noPage
      ? `${base ? base + ' ' : ''}这个插件没有界面：会话在跑，但没有可切过去的页面。`
      : (base ? `${base} ${ime}` : ime);
    b.onclick = () => window.slurmate.setFront(s.slot);
    box.appendChild(b);
  }
}

/**
 * 这个窗口里有没有真的在跑的会话。右栏开不开、第二屏那颗「临时离开」露不露，
 * 都是问它。
 *
 * 它就是 `liveCount() > 0` —— 不是把那个判据再写一遍：两处各写一遍的话，
 *   漂开的方向是"右栏亮着、而「临时离开」不见了"这种自相矛盾的样子
 *   （同一条规矩两份实现，见 `liveCount` 那一段）。
 */
function hasRunningSession() {
  return liveCount() > 0;
}

/** 当前活着的会话里有没有本机插件（不提交作业的那种）。 */
function hasLocalSession() {
  return (SESS.sessions || []).some((s) => s.live && s.snap && s.snap.onHost);
}

/** 活着的会话全部是本机插件 —— 离开/断开时不涉及任何作业。 */
function onlyLocalSessions() {
  const live = (SESS.sessions || []).filter((s) => s.live);
  return live.length > 0 && live.every((s) => s.snap && s.snap.onHost);
}

/**
 * 右栏那一条的颜色（左栏那一条不在这里，见下）。
 *
 * 整条边栏就是那个记号（2026-10-11 改）：从前它是一条中性底 + 一个 6px 的
 *   圆点，而 10px 宽的一条边上再放一个 6px 的点，看起来跟没有一样（用户的原话是
 *   "圆点太不明显"）。现在颜色直接上在边栏自己身上（见 app.css 的 `.rail.hot`）。
 * 左栏不在这里画 —— 它的三态由主进程算好了推过来（`ui:site`，见 `bindEvents`
 *   里那个 `onSite`）：链路活没活是主进程才知道的事，界面这一层自己算就是第二个
 *   判据，而它会与主进程那个漂开。
 * 右栏说的是"这里有一份输出可看"，所以它跟着有没有作业在跑走，与左栏那个
 *   （站点现在怎么样）毫无关系。
 */
function renderRails() {
  $('rail-right').className = 'rail rail-r' + (hasRunningSession() ? ' hot' : '');
}

/** 前台那一条的槽（按钮要指名停哪一个）。没有会话时 null。 */
function frontSlot() {
  return (SESS.sessions.find((x) => x.slot === SESS.front) || {}).slot || null;
}

/**
 * 作业结束那一刻，那一句提示该是哪一档。
 *
 * 判据是退出码（`jobExitCode` 是 Slurm 的原话 `"143:0"`），不是状态名字：
 *   状态名字已经被 `jobstate.js` 译成人话了，而"好没好"这件事在那个译文里读不出来
 *   （"完成"与"被抢占"都可能带一个非零退出码）。`0:0` 是"干净地结束"。
 * 退出码缺席时按 info —— 猜一个"失败"比不猜更坏（用户会去查一个不存在的问题）。
 */
function jobEndedKind(sn) {
  const ec = sn && sn.jobExitCode;
  return typeof ec === 'string' && !/^0:0$/.test(ec) ? 'error' : 'info';
}

/** 上一次为哪个槽报过"作业结束了"（只报一次，见 renderSnapshot 里那一条）。 */
let lastEndedSlot = null;

/** 上一帧里会话页面盖没盖着面板（只在盖上来那一下收高级选项，见 renderSnapshot）。 */
let lastCovered = false;

function renderSnapshot(s) {
  lastSnap = s || null;
  const bar = $('statusbar');
  const st = s ? s.state : 'idle';
  bar.className = 's-' + st;

  // 状态条上不放记号（用户 2026-10-23）：左边那颗圆点已经把状态说完了
  //   （`body` 的 `s-*` 一类决定它的颜色），再挂一枚动画只是同一件事说两遍。
  $('sb-state').textContent = STATE_TEXT[st] || st;

  let detail = '';
  if (s) {
    if (s.suspended) {
      // 这一支排在所有分支之前。被接管的时候这些会话仍然停在 `running`，
      //   下面那一支会说「分区 · 节点 · 剩余时间」—— 那些话全是真的，但用户此刻
      //   最需要知道的是本机已经不管它了，以及作业还在跑。
      //   不这么排的话，界面看起来和一个正常运行的会话一模一样。
      //
      //   说的这句话由主进程给（`s.suspended` 本身就是那句原因）—— 界面
      //     不再自己编一句。两处各写一句的漂法是"主进程说被接管了、界面说被顶掉了"，
      //     而用户会去查一个不存在的区别。
      detail = s.suspended;
    } else if (st === 'running' || st === 'releasing') {
      const bits = [];
      if (s.onHost) bits.push('本机运行（不占集群）');
      if (s.partition) bits.push(s.partition);
      if (s.node) bits.push(s.node);
      if (s.expiresAt !== undefined) bits.push('剩余 ' + fmtLeft(s.expiresAt));
      if (s.renewCount) bits.push('已续期 ' + s.renewCount + ' 次');
      if (s.tunnelState === 'down') bits.push('隧道断开，正在重试');
      // 隧道好好的时候，那些警告（心跳被限流、状态问不到）不挂提示页 ——
      //   页面照常能用，整块盖住它等于替用户把编辑器关了一次（2026-10-21 用户
      //   报的"什么也点不了"）。那句话的唯一落点就是这一行。
      //   判据与主进程那一半同源：那边只在 `tunnelState !== 'listening'` 或者
      //   页面加载失败时挂提示页（见 index.js 的 `_renderSession`）。
      if (s.warning && (s.tunnelState === 'listening' || s.tunnelState === 'local')) {
        bits.unshift(s.warning);
      }
      detail = bits.join(' · ');
    } else if (st === 'queued') {
      // 作业那一侧的状态与原因（`jobText`）也要露出来：光说「等待调度与登记」，
      //   用户分不清是在等空闲资源、还是被额度或 hold 卡住了 —— 后者等多久都不会开始。
      const bits = [s.jobId ? `作业 ${s.jobId}` : null, s.jobText || '等待调度与登记'];
      // 作业在跑、而站点那边登记没有在进行：这句话是用户唯一看得见的原因
      //   （守护进程日志里那一行要等它读到日志才会被看见）。
      if (s.enrollProblem) bits.push(`站点还没有完成登记：${s.enrollProblem}`);
      // 作业已经在跑、而站点还没有登记上：这一句不靠守护进程报原因。
      //   原因那一格是 0.29 才有的，老站点不发；而"作业在跑、站点没登记"
      //   这件事两边都答得上来（作业状态由站点给）。少了这一句，状态条只写
      //   「作业 8298 运行中」，读起来像一切正常 —— 而用户正卡在这里。
      else if (s.jobState === 'RUNNING') {
        bits.push('站点还没有完成登记（会话文件缓存最长 60 秒）');
      }
      detail = bits.filter(Boolean).join(' · ');
    } else if (st === 'error') {
      detail = s.error || '';
    } else if (st === 'submitting') {
      detail = '正在向控制节点申请资源';
    }
  }
  $('sb-detail').textContent = detail;

  const running = (st === 'running' || st === 'releasing');
  // 会话一停，那个第一段就不该再等着第二段了 —— 留着它，用户按下去的第二段
  //   没有对象（会话已经结束了）。收起是这一格自己的事，与 `hidden` 无关：
  //   那两件事一个是"这一格该不该在"，一个是"它现在是第几段"。
  if (!(running || st === 'queued')) disarmArmed();
  // 那颗「重新加载」与「停止该作业」的显隐、标签都在
  //   `renderStatusEnd` 里（它同时看屏名与"面板有没有抬上来"）。这里不各判一遍：
  //   两处各写一份的话，切标签时会有一处不跟着变（2026-10-18 真机）。
  renderStatusEnd(s);
  // 会话页面盖上来，就是离开了插件那一屏（用户 2026-10-30）。
  //   那一屏的 DOM 一直留在文档里：`showScreen` 切走只加一个 `hidden`，而被原生
  //   视图盖住时连 `hidden` 都没有。于是"离开"在路由那一层从来没发生过 ——
  //   展开着的高级选项、填进去的值一直留到用户点「面板」回来。
  //   只认盖上来那一下（边沿）：收起就是退回默认，每帧收一次等于把用户正在填的
  //   那一格清掉，而页面盖着的时候他本来也填不了。
  const covered = pageCovering(s);
  if (covered && !lastCovered) for (const cell of advCells) cell.collapse();
  lastCovered = covered;
  // 「这一份是临时副本」—— 两个地方都要露，而状态条那一份是必须的，
  //    不是锦上添花：会话一跑起来，窗口主体就被原生视图整块盖住（只有前台那块
  //    `setVisible(true)`，从状态条下沿铺到底），面板里那一条也跟着被盖住 ——
  //    而那正是最需要看见这句话的时候（用户正要在里面干活）。
  //   诚实：这句话说的是"不会被记录"，而它只在前台那一条上成立 ——
  //     切到持久那一条时它会跟着消失（这正是要的：两份的差别就在这一点上）。
  const temp = frontTemporary();
  $('sb-temp').classList.toggle('hidden', !temp);
  $('temp-banner').classList.toggle('hidden', !temp);
  // 这一屏不参与"露哪一屏"的判定 —— 那是路由的事（见 showScreen）。
  //   按会话状态切换 `sec-connect` / `sec-purpose` / `sec-session` 的话，"用户在
  //   哪儿"与"会话跑没跑起来"就混成一件：会话一起来就把人弹回当前会话那一屏，
  //   他刚才点开的作业列表就没了。
  //
  //   这里只留它确实该管的那一格：状态条上的按钮。详情那一块跟着选中的
  //   那一条走（见 `renderJobDetail`）—— 它不能只跟着前台走，否则作业列表里
  //   高亮着 A、下面摆的却是前台 B 的隧道与心跳（2026-10-17 真机）。
  renderJobDetail(s);

  // 作业刚刚结束的那一下，把那一句也送进提示流：切一屏之后再回来，它还在。
  //   判据是"上一轮还不是终态、这一轮是了"，不是"状态是 ended" —— 后者会在每一次
  //   推送时都重复一遍。
  const endedNow = (st === 'ended' || st === 'error')
    && lastEndedSlot !== (SESS.sessions.find((x) => x.slot === SESS.front) || {}).slot;
  if (endedNow) {
    lastEndedSlot = (SESS.sessions.find((x) => x.slot === SESS.front) || {}).slot;
    if (s) notice(jobEndedKind(s), s.onHost ? '本机会话已结束。' : (s.jobText || '作业已结束。'));
  }

  // 这一帧里露出来的东西刚变过（状态条、映射图的节点），连线的几何位置要到
  //   这一帧结束后才是最终的。
  requestAnimationFrame(drawWorkspaceLines);
}

/**
 * 会话页面此刻有没有盖在面板上。
 *
 * 判据：前台那条跑着、它的插件有页面、而面板没被抬上来（`SESS.panelFront`，
 *   由主进程随会话状态一起推）。
 * 两处读者：状态条右侧那几颗（露不露）与高级选项（盖上来就等于离开了插件那一屏）。
 *   各判一遍的话，漂开的方向是"按钮已经在会话页面上了，而高级选项还开着"。
 */
function pageCovering(s) {
  return Boolean(s) && s.state === 'running' && hasSurface(s) && !SESS.panelFront;
}

/**
 * 状态条右侧那两颗：只在会话页面真的盖着窗口时存在。
 *
 * 用户 2026-10-18 定的形状：
 *   · web-demo 那类作业页面上给一颗「停止该作业」—— 快速结束眼前这一条；
 *   · 插件页与作业页都不给。插件页没有页面可重载、也没有作业可停；作业页自己
 *     那一屏上就有大按钮，不需要这一颗。
 * 所以「结束会话」这个名字没有了 —— 它停的一直是一条作业。
 *
 * 「页面盖着」的判据在 `pageCovering()`：高级选项那边读的是同一个。
 */
function renderStatusEnd(s) {
  const btn = $('sb-end');
  const reload = $('sb-reload');
  const leave = $('sb-leave');
  const pageOnScreen = pageCovering(s);
  reload.classList.toggle('hidden', !pageOnScreen);
  // 回面板的那条路跟着那块页面一起露：页面盖着的时候它是唯一看得见的出口。
  leave.classList.toggle('hidden', !pageOnScreen);
  if (s && s.onHost) {
    btn.textContent = '关闭本机会话';
    btn.title = '关闭这个本机会话；它没有集群作业，本地服务会随之停止。';
  } else {
    btn.textContent = '停止该作业';
    btn.title = pageOnScreen && s.jobId
      ? `停止这一条作业（作业 ${s.jobId}），集群上的作业会被取消。`
      : '停止这一条作业，集群上的作业会被取消。';
  }
  btn.classList.toggle('hidden', !pageOnScreen);
}

/**
 * 打开「新建」表单。
 *
 * 密钥在这一步生成，早于用户填地址 —— 他得先把公钥复制去 IDM 注册，
 *   回来才连得上。所以这一步是异步的：公钥框会先显示「正在生成密钥…」。
 *
 * 每打开一次「新建」都是一把新的。主进程那边从前是幂等的（留着上一把
 *   就复用它，理由是"用户可能已经注册过了"），结果是：点「新建」→ 关掉表单 →
 *   再点「新建」，公钥一模一样，而用户没有任何地方能要到一把干净的钥匙。
 * 代价交给密钥那一行说（关掉表单=放弃这一把），不再另加确认：
 *     它不是"丢掉了什么"的动作，见本文件顶部那条"非必要不问"。
 */
async function openNewForm() {
  form = { open: true, mode: 'new', id: null };
  $('sec-form').classList.remove('hidden');
  syncNewButton();

  $('form-title').textContent = '新建连接';
  $('form-hint').textContent =
    '两步：把下面的公钥注册到 IDM 账户，再填登录节点的地址。';
  $('btn-save').textContent = '保存并连接';
  // 地址栏一律清空 —— 见文件头：预填上一条的地址会让「新建」悄悄变成「又存一遍」
  $('f-label').value = '';
  $('f-user').value = '';
  $('f-host').value = '';
  // 端口是唯一例外：它的通用默认值是 22，而绝大多数站点的 SSH 就在那儿。
  //   留空的话用户得自己想一个数填（或者更坏，以为不用填），而这一格是必填的。
  // 这个 22 是 SSH 协议的默认，不是任何一个集群的值：占位符从前写着某个
  //   开发集群的端口，那让"默认"看起来像"我们推荐这个数"。
  $('f-port').value = String(DEFAULT_SSH_PORT);
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
  // 这一行必须说出"关掉就放弃"：这一版起每次新建都换一把，
  //   而这一步没有确认（它不是"丢掉了什么"的动作，见本文件顶部那条）。
  //   不说的话，用户会在注册完公钥之后随手关掉表单，然后对着"认证失败"发愣。
  $('key-hint').textContent = '这把密钥属于下面这条新连接。'
    + '关掉表单就放弃它，公钥要重新注册一遍。';
  renderKey(r.key);
  await refreshFormWsDefault();
}

/** 打开某条连接的编辑表单。 */
async function openEditForm(c) {
  form = { open: true, mode: 'edit', id: c.id };
  $('sec-form').classList.remove('hidden');
  syncNewButton();

  $('form-title').textContent = '编辑连接';
  $('form-hint').textContent = '改这里的地址只影响这一条连接。';
  $('btn-save').textContent = '保存';
  $('f-label').value = c.label || '';
  $('f-user').value = c.user;
  $('f-host').value = c.host;
  $('f-port').value = c.port;
  $('key-hint').textContent = '正在读取密钥…';
  // 「③ 工作区」：编辑时没有"跟随默认"那一项 —— 这条连接已经有一个了，
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
  syncNewButton();
  renderConnEmpty();
}

/**
 * 「新建连接」那颗按钮露着没有。
 *
 * 两处会改到它：打开表单、收起表单。各写一遍 `classList.add/remove` 就会漂，
 *   所以判据只在这里算一次。
 */
function syncNewButton() {
  $('btn-new').classList.toggle('hidden', form.open);
}

/** 「一条连接都没有」时的引导语。表单开着的时候它得指向表单，而不是那个已被收起的按钮。 */
function renderConnEmpty() {
  $('conn-empty').textContent = form.open
    ? '还没有保存任何登录节点。填好下面的用户名、主机和端口，点「保存并连接」。'
    : '还没有保存任何登录节点。点右上角「新建连接」填一个，只要用户名、主机和端口。';
}

// ── 表单里的「③ 工作区」 ────────────────────────────────────────────────────
//
// 这一格有两个状态，必须分开记：
//
//   `''`             —— 跟随默认（新建时的初值）／不变（编辑时）。
//                       新建时默认值随上面的地址变（同址已经有连接就用它那个工作区），
//                       所以它不是一个定值。
//   `NEW_WORKSPACE`  —— 用户要一个新的空白工作区。
//   一个工作区 id     —— 用户挑定了那一个。
//
// 为什么不把默认值直接选中在那个下拉的某一项上：那样"用户没表态"与"用户挑的
//   正好是默认那个"就分不出来了，而两者保存时的下场不同 —— 前者要由主进程在存的
//   那一刻现算（用户可能在敲完地址之后立刻按保存，而界面手里那个默认值是上一个字
//   算出来的）。所以默认值在这里只用来显示，判定权在 `app:saveConnection`。

/** 用户显式挑的那个值；`''` = 跟随默认（新建）／不变（编辑）。 */
let wsPicked = '';

/** 最近一次问到的默认值（工作区 id 或 null = 会新建一个）。只用来显示。 */
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
 * 重画「③ 工作区」那个下拉，并把当前选择的后果写成一句话。
 *
 * 内容没变就不动 DOM（`dataset.sig`）：重建 <select> 会把用户正在展开的列表收起来，
 *   而地址那几个框每敲一个字都会走到这里。
 */
function renderFormWorkspace() {
  const sel = $('f-workspace');
  const editing = form.mode === 'edit';
  const cur = editing
    ? ((boot.connections || []).find((c) => c.id === form.id) || {}).workspaceId
    : null;
  // 编辑时没有"默认"那一项 —— 这条连接已经有一个工作区了，这一格答的是
  //   「要不要换」，而 `''` 在这里的意思是"不变"。
  const head = editing ? null : {
    value: '',
    text: workspaceById(wsDefault) ? `默认：${workspaceLabel(workspaceById(wsDefault))}`
      : '默认：新建一个空白工作区',
  };
  fillWorkspaceOptions(sel, wsPicked || (editing ? cur : ''), editing ? cur : null, head);
  $('ws-hint').textContent = wsHintText(sel.value, editing ? cur : undefined);
}

/** 当前选择的那一句后果。短 —— 长解释在下拉的 title 里。 */
function wsHintText(v, cur) {
  // 工作区显示成用它的连接（`workspaceLabel`）—— 这一句里也要同一条规则，
  //   否则同一个工作区在下拉里叫一个名字、在下面这句后果里又叫「工作区 N」。
  const name = (id) => workspaceLabel(workspaceById(id)) || '那个工作区';
  if (v === NEW_WORKSPACE) return '保存后会新建一个空白工作区。';
  if (cur !== undefined) {                 // 编辑
    if (v === cur || v === '') return '不变。';
    return `保存后切到「${name(v)}」，原来那个里面的内容不会跟着走。`;
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
 * 无条件写 `s.origin`（也就是 `http://127.0.0.1:PORT`）对中转站
 *   会话是一句假话：那个端口后面是 SSH，不是 HTTP。用户照着这一行去浏览器里
 *   打开，只会得到一张空白页，而他会以为是客户端坏了。
 *
 * 判据是插件声明的 `contributes.surface`，不是"是不是某个插件"：
 * 声明了界面的写 URL，没声明的写裸 TCP 地址。认不出这个会话是哪来的（站点装了
 * 本机没有的插件）时也写裸地址 —— 我们确实不知道那头是什么。
 */
function pluginOfSession(s) {
  if (!s) return null;
  return ((lastPlugins && lastPlugins.plugins) || [])
    .find((x) => x.name === s.serviceKind) || null;
}

/**
 * 这条会话有没有"一块页面"。
 *
 * 判据与 `localAddressText` 同一份：插件清单里的 `surface`。中转站那类插件
 *   没有页面，于是「重新加载」对它没有意义 —— 露着也只是一颗按下去无事发生的
 *   按钮（2026-10-17 真机）。
 */
function hasSurface(s) {
  const p = pluginOfSession(s);
  return Boolean(p && p.surface);
}

function localAddressText(s) {
  if (!s.localPort) return '—';
  return hasSurface(s)
    ? `http://127.0.0.1:${s.localPort}`
    : `127.0.0.1:${s.localPort}（TCP，不是网址）`;
}

function renderKv(s) {
  const r = s.resources || {};
  const resText = [
    r.cpus ? `${r.cpus} 核` : null,
    r.mem || null,
    // GRES 那一段已经在主进程译好（`gres.js`）—— 名字与型号是集群定的，
    // 这里一个假设都不做。`s.gresText` 为 null = 这一行不说 GRES。
    s.gresText || null,
  ].filter(Boolean).join(' / ') || '—';

  // 本机会话没有作业：作业 ID / 分区 / 剩余时间 / 心跳都不是它的事实。
  //   照常画一遍会让它们显示成「—」，那读起来像"作业信息暂时查不到"，
  //   而真相是这一条根本没有作业。
  const rows = s.onHost ? [
    ['会话类型', '本机（不提交作业）'],
    ['本地地址', localAddressText(s)],
    ['状态', '本机运行'],
  ] : [
    ['会话 ID', s.sessionId || '—'],
    ['作业 ID', s.jobId || '—'],
    // 默认是随机挑分区，所以用户事先不知道会落到哪种卡上 —— 必须显示实际结果
    ['分区', s.partition || '—'],
    ['资源', resText],
    ['节点', s.node || '—'],
    ['隧道目标', s.tunnelTarget || '—'],
    ['本地地址', localAddressText(s)],
    // 「未知」是站点这次没报，不是 0，也不代表已到期 —— 说明放在 title 里，
    //   正文保持一格。
    ['剩余时间', fmtLeft(s.expiresAt),
      typeof s.expiresAt === 'number'
        ? null : '站点本次未提供剩余时间；「未知」不代表已到期。'],
    // 这一句由主进程译好（`jobstate.js`）—— 界面只印，不自己译：Slurm 的原文
    // 大写枚举（`OUT_OF_MEMORY`）是说给管理员听的话。
    ['作业状态', s.jobText || '—'],
    // 「被接管」是这台电脑的状态，不是这条会话的状态 —— 所以它自己一行，
    //   而不是改「作业状态」那一行：作业真的还在跑，把它写进那一行就是
    //   一句不成立的话，而用户会照着它去把作业停掉。
    ...(s.suspended ? [['本机', s.suspended]] : []),
    ['上次心跳', fmtAge(s.hbAgeMs)],
    ['隧道', { listening: '已连接', down: '断开，重试中', stopped: '已停止',
      local: '本机直连' }[s.tunnelState] || s.tunnelState || '—'],
  ];
  const dl = $('kv');
  dl.textContent = '';
  for (const [k, v, title] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    if (title) dd.title = title;
    dl.append(dt, dd);
  }
}

/**
 * 「选中的那一条」那一块。
 *
 * 标题这么写，内容就必须是选中的那一条：从前它无条件画前台那一条的快照，
 *   于是作业列表里点一条本机没接着的记录时，高亮换了、下面的会话 ID 与作业号
 *   还是原来那一条（2026-10-17 真机）。本机接着的那一条有完整快照（隧道、本地
 *   地址、心跳都是本机的事实）；没接着的那一条只有站点报的那几格，其余写「—」。
 */
function renderJobDetail(front) {
  const s = detailSnap(front);
  const show = Boolean(s) && SCREEN === 'jobs';
  $('job-detail').classList.toggle('hidden', !show);
  if (show) renderKv(s);
}

/**
 * 详情那一块用的快照：选中那一条的本地视图（隧道、心跳那几格只有本机有），
 * 没有选中时用前台那一条。
 *
 * 选中不改前台（见 `selectJob`），所以这两件事必须分开取。`loadJobLog` 用的是
 * 同一份 —— 否则高亮着 A、日志摆的是 B 的。
 */
function detailSnap(front) {
  const j = selectedJob();
  if (!j) return front || null;
  const rec = (SESS.sessions || []).find((x) => x.slot && x.slot === j.slot);
  return (rec && rec.snap) || jobAsSnap(j);
}

/**
 * 让日志跟着选中的那一条走。
 *
 * 换一条就把它收掉；本来就开着的话，顺带给新的那一条取一次 —— 用户点开
 * 日志之后再切换作业，要的是"看这一条的"，不是"把上一份摆在那里"。
 */
function syncJobLog() {
  // `jobLogFor` 非空 = 这一格此刻真的摆着某一条的日志。没打开过就什么都不做：
  //   日志是按需取的，刷一次列表不该顺手多 fork 一个 python。
  if (!jobLogFor) return;
  const s = detailSnap(frontSnap());
  const id = s ? s.sessionId : null;
  if (jobLogFor === id) return;
  jobLogFor = null;                     // 先把旧的那一份收掉
  const box = $('joblog-body');
  box.textContent = '';
  box.classList.add('hidden');
  $('joblog-meta').textContent = '';
  if (id) loadJobLog();                 // 本来就开着：跟到新的那一条上
}

/** 把作业列表那一行摆成 `renderKv` 认的形状。本机没有的那几格是 `null`。 */
function jobAsSnap(j) {
  return {
    sessionId: j.session_id,
    jobId: j.job_id,
    partition: j.partition,
    resources: j.resources || null,
    gresText: j.gres_text || null,
    node: j.node,
    tunnelTarget: null,
    localPort: null,
    expiresAt: typeof j.expires_at === 'number' ? j.expires_at : undefined,
    jobText: j.job_text || null,
    suspended: null,
    hbAgeMs: null,
    tunnelState: null,
  };
}

/**
 * 按需取一次日志并画在详情底下。走的是右栏同一条 op。
 *
 * 之所以是"按需"而不是"转存一份在这里"：作业结束之后那条会话行在站点的
 *   `released_keep` 窗口内还在，同一条 op 照样答得上来 —— 再取一次与服务端记一份，
 *   结果一样而少一处会漂的状态。
 *
 * 三态怎么判在 `dom.js` 的 `logCellOf()` 里（浮窗那一页用的是同一个函数）：
 *   两处各判一遍的话，漂的那一处不会报错。
 */
async function loadJobLog() {
  const s = detailSnap(frontSnap());
  const box = $('joblog-body');
  const meta = $('joblog-meta');
  if (!s || !s.sessionId) { meta.textContent = '这一条还没有会话 ID。'; return; }
  const id = s.sessionId;
  jobLogFor = id;
  meta.textContent = '读取中…';
  box.classList.remove('hidden');
  box.textContent = '';
  const r = await window.slurmate.jobLog({ session_id: id, lines: 500 });
  // 这一趟读的时候用户可能已经换了一条：那一份属于上一条，画在这里就是
  //   把 A 的输出摆在 B 的标题底下。
  if (jobLogFor !== id) return;
  box.textContent = '';
  if (!r || !r.ok) {
    // 获取失败（或者这个站点太旧没有这个能力）—— 如实说，不画一个空框。
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
    if (it.kind === 'na') blk.append(cel('p', 'na', `获取失败：${it.why}`));
    else blk.append(cel('div', null, it.text || '（这一份还是空的）'));
    if (it.path) blk.append(cel('div', 'hd2', it.path));
    box.append(blk);
  }
  if (!any) box.append(cel('p', 'sub', '这个作业还没有输出任何内容。'));
}

// ── 公钥 ────────────────────────────────────────────────────────────────────

/** 清掉密钥区那几条提示。切换表单时必须先清 —— 否则上一把钥匙的毛病会留在屏幕上。 */
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
  // 只显示指纹，不显示公钥本身：所有 ed25519 公钥的前 40 个字符逐字相同
  //   （`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI` 是固定的），于是「换了一把钥匙」
  //   在一个文本框里看起来毫无变化 —— 而这是最要命的一种变化，用户会以为还是
  //   原来那把，实际拿去认证的已经不是了，症状只有「认证失败」。
  //   指纹短、每一位都随机，拿去和 IDM 里那条一比对就知道对不对。
  $('key-fp').textContent = k.fingerprint || '—';

  if (k.error) {
    // 密钥在，但读不出来。这是唯一一条会走到「重新生成」的路，
    // 而点下去会作废用户已经注册到 IDM 的那把公钥 —— 必须说清楚。
    showKeyError((k.detail || '这把密钥不可用。')
      + ' 若确认要重新生成，点上面的「重新生成密钥…」。新的公钥要重新注册到 IDM。');
    return;
  }
  // 还没有密钥。由 key-hint 说明该怎么办，这里再喊一遍只会重复。
  if (k.missing) return;

  // 密钥存不下来（这台机器没有凭据库）。必须说出来，不能只是没保存成功。
  //
  // 不要摆一个「私钥保存方式」下拉框（让用户在加密／明文／不保存之间选）：
  // 那等于把「你的私钥会以明文躺在磁盘上」包装成一个需要用户自己权衡的选项 ——
  // 选明文的那个用户并不知道自己在放弃什么。只有加密一种方式，
  // 存不了就如实讲清楚后果，没有第二个选项可以让人选错。
  if (k.persisted === false) {
    const np = $('key-nopersist');
    // 「没有凭据库」和「有凭据库但这次写失败了」是两种不同的毛病，修法也不同，
    // 所以文案要分开 —— 一句笼统的「保存失败」指不回根因。
    //
    // 这条必须显眼（.alarm），因为它预告的正是后面那个「认证失败」：
    //   密钥存不下来 → 下次启动换一把 → 已经注册到 IDM 的那把公钥作废。
    //   写成一行灰字时，用户会一路读到「认证失败」才回头，而那时已经指不回这里了。
    const tail = '下次启动会重新生成一把新密钥，注册到 IDM 的那把公钥随之作废，'
      + '到时候只会看到「认证失败」。';
    np.textContent = boot.secureStorageAvailable
      ? '注意：私钥这次未能保存到本机。' + tail
      : '注意：这台机器上没有可用的系统凭据库，私钥只能留在内存里。' + tail;
    np.classList.add('alarm');
    np.classList.remove('hidden');
  }
}

// ── 连接列表 ────────────────────────────────────────────────────────────────

/**
 * 一条连接在界面上叫什么：有备注就用备注，没有才回落成地址。
 *
 * 一处定义、别处指路。列表那一行、"换站点"那道闸、以及「删除」那一段两段式
 *   都指名道姓地要用它 —— 各写一遍的话，漂开的方向是"框里说的那条，用户在这一屏
 *   上找不到"（写地址就正是那个漂法：界面上印的是备注）。
 */
function connLabel(c) {
  return (c && c.label) || `${c.user}@${c.host}:${c.port}`;
}

function renderConnections(list) {
  const box = $('conn-list');
  box.textContent = '';
  // 这一屏会被整块重画，而第一段那个确认就挂在某一行里 —— 不先收掉的话，
  //   那一行连同它一起被丢掉，而 `armed` 还指着它（下一次点"别处"收的是一个
  //   已经不在文档里的节点，看起来像没反应）。
  disarmArmed();
  $('conn-empty').classList.toggle('hidden', list.length > 0);
  // 映射图与列表同生共死：没有连接就没有可映射的东西
  $('sec-workspaces').classList.toggle('hidden', list.length === 0);
  // 两条边栏：它们是站点级的两格（站点状态、这个站点上的作业输出），
  // 没有站点就既没有可问的也没有可看的。见 panel.html 那一段。
  // 而在这条不变量下（站在这第一屏上就一定不在站点里），这个 class 在第一屏
  //   上恒为 false —— 它只在"连上的那一刻"被置真（`handleConnectResult` 会先画一遍
  //   这里，再进第二屏），以及开局那一次。「临时离开 / 断开」两颗不在这儿了：
  //   它们搬到了第二屏的标题那一块（见 panel.html 里 `#screen-plugins` 那一段）。
  // 而这一句不在这儿算了：`connected` 那一格只有 `setConnected` 改，而它
  //   顺手把这两个跟着它走的东西都重画一遍（见那个函数）。两处各写一遍的话，漂开的
  //   方向是"边栏亮着、而状态条上那颗调试没有"。

  // 保持用户的顺序（新建的排在最后），不调 `sort` —— `sort` 会对全部元素重排。
  for (const c of list) {
    const li = document.createElement('li');
    // 这一行没有"已连接"那一种形态（2026-10-11 改）：站在这一屏上就意味着
    //   不在任何站点里（回这一屏的两条路各自把连接收掉了，见 doLeave /
    //   doDisconnect），所以"这条正连着"在这里永远不成立。那一支 —— `.conn.active`
    //   的高亮、「进入」那颗按钮、以及删除那颗按钮的禁用 —— 连同它的 CSS 一起删了：
    //   留着就是一段走不到的码，而下一个人会以为"连着 A 的时候点 B"这条路存在。
    li.className = 'conn';

    const t = document.createElement('span');
    t.className = 't';
    // 有备注就显示备注 —— 用户给它起了名，就是为了不必再读地址。
    // 没起名才回落成地址。两者取其一，不并排显示：并排等于把备注降级成一个
    // 前缀，那这个名字就白起了，用户还是得去读那串地址。
    t.textContent = connLabel(c);
    // 地址仍然在，只是不占地方 —— 鼠标停一下就能看到。
    t.title = `${c.user}@${c.host}:${c.port}`;

    const probe = lastProbe.find((p) => p.id === c.id);
    const m = document.createElement('span');
    m.className = 'm';
    // 从前的「已连接 · N 个作业在跑」那一支删掉了（理由见上面 `li.className`
    //   那一段）：这一屏上不存在"正连着"这一格。而"这个站点上还有几个作业"这件事
    //   现在只有进去看才知道（作业列表那一屏）—— 那是它本来该在的地方。
    if (!probe) {
      m.textContent = '未探测';
    } else if (probe.reachable) {
      m.textContent = `可达 · ${probe.rttMs}ms`;
    } else {
      m.textContent = `不可达：${probe.error || '失败'}`;
      m.classList.add('bad');
    }

    // 这一格是这个站点的入口（也是第二屏的入口），而不是"连接/断开"那个开关。
    //
    //   点它 = 连上它（连上之后自动进第二屏，见 handleConnectResult）—— 而那是
    //   唯一进得去的一条路：站在这一屏上就没有"正连着"这回事，所以从前那个
    //   两种含义（连着时是「进入」、没连时是「连接」）现在只剩一种。
    //
    //   「断开」也不在每一条行上：它是一个站点级的动作（同时最多连着一个
    //     站点），而不是某一条连接自己的属性 —— 挂在行上，等于在说"你可以同时断开
    //     好几条"。它现在在第二屏的标题那一块（`#btn-disconnect`）。
    const main = document.createElement('button');
    main.className = 'tiny';
    main.textContent = '连接';
    // 把自己的元素传下去：连的那几秒里它要变成「连接中…」并灰着（见 `connectTo`）。
    main.onclick = () => doConnectTo(c, main);

    // 编辑：地址 / 这条连接自己的密钥。
    const edit = document.createElement('button');
    edit.className = 'ghost tiny';
    edit.textContent = '编辑';
    edit.onclick = () => openEditForm(c);

    const del = document.createElement('button');
    del.className = 'ghost tiny danger-ghost';
    del.textContent = '删除';
    // 从前这里有一句 `del.disabled = live`（连着的时候先断开再删，别让作业失去
    //   主人），跟着 `.conn.active` 一起删了 —— 这一屏上不存在"正连着"那一条
    //   （见上面 `li.className` 那一段）。而"别让作业失去主人"这件事仍然被守着，
    //   而且守着的那一道更强：主进程的 `app:deleteConnection` 数的是这个工作区里
    //   还有没有会话在跑（`liveSessionOnWorkspace`），有就拒（`code: 'in_use'`）。
    //   界面这一句从前只是它的一个近似（"连着"比"有作业在跑"宽），删掉不少守什么。
    del.onclick = () => {
      // 两段式。删除连带销毁这条连接的私钥，所以后果必须在按下去之前说
      //   出来 —— 用户拿去 IDM 注册过的公钥就此作废，重建一条要重新注册。
      //
      // 还有一样会被删掉：最后一个用某个工作区的连接被删掉时，那个工作区的
      //   数据也一起清（浏览器存储 + 插件写到磁盘上的文件）—— 主进程那边是
      //   `commitConfig` → `pruneWorkspaces` → `clearWorkspaceStorage`。
      //   判据与主进程同源：`workspacePlan` 的 `soleOwnerId` 就是从"只有这一条
      //   连接在用它"推出来的，与 `pruneWorkspaces` 数的是同一件事。
      //
      // 名字走 `connLabel(c)` 而不是地址：这一行界面上印的是备注（有的话），
      //   确认那一行印地址的话，它指的是一条"在这一屏上找不到"的连接。
      const sole = (boot.workspaces || []).find((l) => l.soleOwnerId === c.id);
      armConfirm(del, {
        why: `删除「${connLabel(c)}」？它的私钥一并作废，要重新注册一把新公钥。`
          + (sole
            ? `「${sole.name}」也只有这一条连接在用，会跟着删掉。里面的编辑器`
              + '布局、登录状态，以及插件写在磁盘上的文件都找不回来。'
            : ''),
        yes: '删除',
        run: async () => {
          const r = await window.slurmate.deleteConnection(c.id);
          if (!r.ok) return notice('error', r.error);
          boot.connections = r.connections;
          boot.activeConnectionId = r.activeConnectionId;
          // 删掉一条连接可能连带回收它的工作区，引用表同样要跟着回包换。
          boot.workspaces = r.workspaces || boot.workspaces;
          // 正在编辑的就是这一条 —— 表单不能再留在一个已经不存在的条目上
          if (form.open && form.mode === 'edit' && form.id === c.id) closeForm();
          renderConnections(boot.connections);
          notice('info', '已删除该连接。'
            + (r.keyDeleted ? '它的私钥也一并删掉了。' : '')
            + (sole ? `「${sole.name}」的数据也一起清掉了。` : ''));
        },
      });
    };

    li.append(t, m, main, edit, del);
    box.append(li);
  }

  // 整块重画会换掉那些按钮，于是「连接中…」期间灰着的那几个又活了 ——
  //   连接还在飞，这里补一次。
  if (connectingNow) lockConnectEntries();
  renderWorkspaceMap();
}

/**
 * 「这条连接用哪个工作区」那一格从连接行搬到了连接表单里（「③ 工作区」）。
 *
 * 搬的理由：那一格是这条连接的一个属性，与地址、用户名同一类 —— 摆在行上时
 *   它是一条「随时可改」的快捷方式，而改它的代价（切走一个独占的工作区 = 把它连同
 *   里面的东西一起删掉）远大于改一个地址。放进表单里，"改"这个动作就有了它该有的
 *   分量：按「保存」才算数。
 * 2026-10-18 起连状态条那个入口也删了（用户：作业运行的时候不该在那里 ——
 *   切工作区要换 origin、重新加载页面，未保存的编辑会跟着没）。换工作区只在
 *   没有会话跑着的时候做。
 */

// ── 工作区 ──────────────────────────────────────────────────────────────────
/**
 * 一条连接只用一个工作区，一个工作区可以被多条连接共用；没有任何连接在用的工作区
 * 会被主进程回收。
 *
 * 这一段不做任何推导。`boot.workspaces` 是主进程用 workspacePlan() 算好的
 *   （每个工作区带 members / refCount / soleOwnerId），界面只负责渲染。
 *   理由不是懒：界面手里那份随时可能已经陈旧（另一条连接刚被删），而
 *   「切走会不会把这个工作区删掉」是一个不可逆的判断，必须由主进程说了算。
 */

function workspaceById(id) {
  return (boot.workspaces || []).find((l) => l.id === id) || null;
}

/**
 * 按 id 找一条连接。这个名字这一层只有一处 —— `connName`（工作区的说明文字）
 * 与 `askFork`（分叉弹窗里"还有谁"）都要走它，各写一遍 `find` 迟早会漂开。
 *
 * 带 `boot &&` 的兜底：`activeConn()` 从前就是这么写的，说明这一层够得着
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

/**
 * 工作区在界面上叫什么。
 *
 * 名字不由用户取（2026-10-17 起没有「改名」这件事）：它由用它的连接推出来 ——
 *   有一条连接在用时，就是那条连接的名字（备注，没有就 `user@host`）。
 *   几条共用时取第一条，「还有谁在用」由旁边那句「N 条连接」说。
 *   没有人用时退回配置里那个自动名（「工作区 N」）—— 那只在活会话还攥着它、
 *   而连接已经切走或删掉的那一小段时间里出现。
 *
 * 两处共用这一句（映射图、表单的「③ 工作区」）。各推一遍的话，
 *   同一个工作区会在两个下拉里叫两个名字。
 */
function workspaceLabel(l) {
  if (!l) return '';
  const members = ((boot && boot.connections) || [])
    .filter((c) => c.workspaceId === l.id);
  return members.length ? connName(members[0].id) : l.name;
}

/** 一个工作区后面跟的那句说明。 */
function workspaceNote(l, connId) {
  if (!l) return '';
  if (l.refCount === 0) return '（空）';
  if (l.refCount === 1) {
    // 自己独占：要把「切走就会被丢弃」说出来，这是用户按下去之前唯一的机会
    return l.soleOwnerId === connId
      ? '（只有这一条连接在用，切走就会被丢弃）'
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
 * 前台那条会话跑在哪一个工作区里 —— 按它手里那份数据的 id，去引用表里反查。
 *
 * 会话手里是一份数据（`snap.spaceId`），而用户认的是工作区这个单位。
 *   两者不是一回事：一份数据可以被几个工作区同时引用（那正是引用表存在的理由）。
 *   所以这一步只能查，不能推 —— 主进程给的那张表里每一行都带着它指着哪些数据。
 * 查不到就返回 null：临时那一份不在任何工作区里（它只活在内存里），
 *   那时映射图上没有哪个工作区被标成"当前的"。
 */
function frontWorkspaceId() {
  const sid = lastSnap && lastSnap.spaceId;
  if (!sid) return null;
  const l = (boot.workspaces || []).find((x) => (x.spaces || []).includes(sid));
  return l ? l.id : null;
}

/**
 * 把工作区那几项填进一个 <select>。表单里的新建与编辑共用这一份。
 * 各写一份的话，那句说明（「只有这一条连接在用 —— 切走就会被丢弃」）
 * 迟早会在其中一处走样，而它正是用户按下之前唯一的机会。
 *
 * `keep` 是应当选中的那个值。找不到就不选（宁可空着）—— 让下拉停在一个
 * 并不生效的值上，用户会以为自己已经切过去了。
 *
 * `connId` 只影响那句说明（"谁在用"）：表单给正在编辑的那条连接，
 * 新建时给 null（这时问的是"还有谁在用"，这条连接自己还不算）。
 *
 * `head` 是可选的第一项（表单新建时那一项「默认：X」）。它的 `value` 是空串，
 * 而空串恰好落在下面那条"找不到就不选"的兜底上，所以跟随默认天然会被选中。
 *
 * `sig` 是给"每次重画都重填"那几处用的：重建 <select> 会把用户正在展开的列表
 * 收起来。内容没变就不动 DOM。
 */
function fillWorkspaceOptions(sel, keep, connId, head) {
  const list = boot.workspaces || [];
  const sig = JSON.stringify([head || null, connId == null ? '' : connId,
    list.map((l) => [l.id, workspaceLabel(l), l.refCount, l.soleOwnerId])]);
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
      o.textContent = `${workspaceLabel(l)}${workspaceNote(l, connId)}`;
      sel.append(o);
    }
    const nu = document.createElement('option');
    nu.value = NEW_WORKSPACE;
    nu.textContent = '＋ 新建空白工作区…';
    sel.append(nu);
    sel.dataset.sig = sig;
  }
  // `NEW_WORKSPACE` 与 `''` 都要原样留住 —— 前者是用户显式要一个新的，
  //   后者是"跟随默认"，两者都不是"选不中任何一项"（那才落到空串上）。
  sel.value = (keep === '' || keep === NEW_WORKSPACE || list.some((l) => l.id === keep))
    ? keep : '';
  // 长解释进 title（悬停才看得到），正文只留那一句后果（表单里的 `#ws-hint`）。
  sel.title = '这个工作区里各个插件用哪一份数据，编辑器布局、标签页、'
    + '登录状态都在这儿。一个工作区可以被多条连接共用。'
    + '切走一个只有这条连接在用的工作区，它会被删掉。';
}

/**
 * 切走一个独占工作区的后果 —— 交给两段式的第一段去说。
 *
 * 文案里必须出现「未保存的编辑内容会丢失」—— 这比「工作区变了」严重得多：
 * 换工作区 = 换 origin，浏览器是在重新加载那个页面，终端里没保存的东西就没了。
 * 用户有权在按下去之前知道这一条。
 *
 * 它从前是一句 `window.confirm` 的正文。改成两段式之后它只剩这段文字 ——
 *   谁来问、什么时候问、退了怎么收，全在 `armConfirm` 那一层（见 `applyWorkspace`）。
 *   把"问"留在函数的返回值里，正是这条路当初错的地方。
 */
function discardWhy(name) {
  const live = lastSnap && lastSnap.state
    && lastSnap.state !== 'idle' && lastSnap.state !== 'ended';
  return `「${name}」现在只有这一条连接在用，切走之后会被删除。`
    + '它的编辑器布局、标签页和登录状态会一起没掉，'
    + '插件写在磁盘上的文件同样找不回来。'
    + (live ? '当前页面会重新加载到新工作区，未保存的编辑内容会丢失。' : '');
}

/**
 * 把一条连接切到另一个工作区。今天的入口只有连接表单里的「③ 工作区」
 * （保存时那一趟，见 `btn-save` 那段）。
 *
 * 从前还有另外两个入口 —— 连接行上那个下拉、状态条里那个「工作区」下拉。
 * 它们都删掉了（见 `renderConnections`
 *   后面那一段）：改工作区的代价远大于改一个地址，摆在一行上等于把它降级成一次
 *   "随手一点"。搬进表单之后，这个动作要按「保存」才算数。
 *
 * @param {string} connectionId
 * @param {string|null} workspaceId  null = 新建一个空白工作区并落进去
 * @param {object} [opts]
 *   anchor    {HTMLElement} 第一段挂在哪一格上（表单里的「保存」）
 *   revert    {() => void}  第一段退回去时把界面拨回原样
 *   confirmed {boolean}     内部用：这是答过之后的第二趟，直接带 `confirmDiscard` 发
 * @returns {Promise<{ok:boolean, armed?:boolean}>}
 *   失败（含用户取消）时调用方应把下拉拨回原值；`armed:true` 表示问题还摆在那儿
 *   没答（既不是成功也不是失败），调用方不要当失败处理、也不要去重画那一格 ——
 *   重画会把那行确认连同它的 `armed` 一起丢掉。
 *
 * 「切走会不会把旧工作区删掉」的判定权在主进程，不在这里。先照常提交，
 *   主进程若回 `would_discard`，我们拿它的原话摆出第一段（`armConfirm`），
 *   用户点了才带 `confirmDiscard` 重来一次。这样无论界面手里那份 refCount 有多
 *   陈旧，问出来的问题都是真的。
 * 它从前是一句 `window.confirm` —— 而那是这条路最别扭的地方：主进程先拒、
 *     界面再问、然后整趟重发，三段挤在一个 `if` 里，而那个框按下去的时候
 *     用户已经没有第二次机会了。两段式把"问"摊回界面自己的状态里（`armed`）。
 */
async function applyWorkspace(connectionId, workspaceId, opts = {}) {
  const payload = { connectionId, workspaceId };
  if (opts.confirmed) payload.confirmDiscard = true;
  let r = await window.slurmate.setConnectionWorkspace(payload);

  if (!r.ok && r.code === 'would_discard') {
    // 没有可挂的那一格就不问（防御：不该发生，但 `armConfirm` 拿到 undefined
    //   会当场抛，而那个抛发生在一次用户点击里，看起来像"点了没反应"）。
    if (!opts.anchor) {
      notice('error', r.error || '切换工作区失败。');
      return { ok: false };
    }
    armConfirm(opts.anchor, {
      why: discardWhy(workspaceLabel(workspaceById(r.workspaceId))
        || r.workspaceName || '那个工作区'),
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
    ? '已切换工作区。页面会重新加载一次，计算节点上的作业没有受影响，仍然在跑。'
    : '已切换工作区。');
  // 拉一次权威状态：会话的 workspaceId 刚变，界面手里那份还是旧的，而映射图
  // 正拿它标「当前」那一个 —— 不拉就会继续标着上一个。
  renderSessions(await window.slurmate.states());
  return { ok: true };
}

// ── 映射图 ──────────────────────────────────────────────────────────────────
// 画线时要拿节点的几何位置，所以渲染出来的节点按 id 存着。
//
// 三列：连接 / 工作区 / 数据。两段关系各画一段线（连接→工作区、工作区→数据），
//   于是"一份数据被两个工作区共用"这件事在图上就是两条线汇到同一个节点 ——
//   那正是这张图存在的理由，而在下拉框里看不出来。
const mapNodes = { conn: new Map(), workspace: new Map(), space: new Map() };

/**
 * 某个插件 id 的标题。查不到就返回 null —— 「查不到」与「它叫这个」是两件事
 * （那一份数据还在、而插件已经卸载了的时候就是这样，那时不编一个名字）。
 *
 * 两个来源，缺一不可：`lastPlugins` 是最新那次对账的结果，而第一屏画的时候它
 *   还没有（`init()` 里 `renderConnections` 排在 `renderPlugins` 前面）——
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
    // 这条连接的工作区里已经建了数据的那几个插件 —— 名字从本机装着的插件来。
    // 名字不是"这条连接会跑哪几个插件"：一个插件只有真开过一次会话之后才有那一份
    //   数据，所以这里列的是"这个工作区里有它的一份了"。悬停那一句把这件事说清楚。
    // 查不到名字的（那一份数据还在、而插件已经卸载了）不编一个，整块小字就不画：
    //   右边那一列仍然按端口把那一份列出来，看图的人不会以为它不存在。
    const ws = workspaceById(c.workspaceId);
    const names = Object.keys((ws && ws.refs) || {}).map(pluginTitleOf).filter(Boolean);
    if (names.length) {
      // 「已有」两个字是承重的：这行小字挂在一个连接节点底下，光看名字很
      //   容易被读成"这条连接会跑这几个插件"。它说的是"这个工作区里已经有它们的一份
      //   数据了"—— 而那是一个已经发生的事实（插件要先开过一次会话才有那一份）。
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
    nm.textContent = workspaceLabel(l);

    // 引用计数直接摆出来 —— 「这个工作区还有谁在用」正是这张图存在的理由
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = l.refCount === 0 ? '没人用'
      : l.refCount === 1 ? '1 条连接' : `${l.refCount} 条连接`;

    n.append(nm, meta);
    // 悬停给全名与用途：格子里显示的是"用它的那条连接"，窄下来会出省略号，
    //   而"一格是什么"（工作区，不是又一条连接）全在那一句里。
    const users = ((boot && boot.connections) || [])
      .filter((c) => c.workspaceId === l.id).map((c) => connName(c.id));
    n.title = (users.length ? `由 ${users.join('、')} 在用` : '此刻没有连接在用它')
      + `（${l.name}）。一个工作区里每个插件各用一份数据；几条连接可以共用同一个。`;
    wsCol.append(n);
    mapNodes.workspace.set(l.id, n);
  }

  // ── 右列：数据（一份 = 一个插件的存储 + 它自己的端口）──
  //
  // 每一份都列出来，包括没有连接在用的那些：它们由 `pruneSpaces` 在每次改动后
  //   收掉，所以正常情况下一条都是"有人指着"的 —— 而万一还剩一条（比如某个工作区
  //   刚刚被回收，配置还没落盘），画出来比让它凭空消失诚实。
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
 * 用 SVG 的 <path d="…">：`d` 是几何属性，不在那条 CSP 的管辖范围内
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

  // 两段用同一个画法：抽出来是为了让"线是怎么画的"只有一处 —— 两段各写一遍
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
  // 工作区 → 它引用的每一份数据。同一份被两个工作区指着就是两条线 —— 那张图要说的
  // 就是这件事（各自一个下拉里看不出来）。
  for (const l of boot.workspaces || []) {
    const wnode = mapNodes.workspace.get(l.id);
    for (const sid of Object.values(l.refs || {})) {
      edge(wnode, mapNodes.space.get(sid), false);
    }
  }
}

// ── 插件 ────────────────────────────────────────────────────────────────────
/**
 * 那一屏画出来的东西由哪两份输入决定 —— 算成一个字符串，用来判"内容变了没有"。
 *
 * 站点推来的那份视图只是其中一份。另一份是本机那几张表：「用哪一份数据」那一格
 *   读的是它们的引用表，而引用表不在视图里。只看前一份的话，工作区换过之后
 *   那一格会继续说着上一个，而界面上一切正常。
 */
function pluginsSignature(pv) {
  return JSON.stringify([pv,
    boot && boot.connections, boot && boot.workspaces,
    boot && boot.spaces, boot && boot.activeConnectionId]);
}

/**
 * 画插件块。
 *
 * 这个函数里一个插件名都没有 —— 画什么完全由服务端通报的清单与本机注册表
 *   求交决定（见 index.js 的 pluginsView）。写死一个「开始开发」按钮的话，
 *   「站点卸载一个插件」在界面上就变成了"点了报错"，而不是"按钮不见了"。
 *
 * 起不来的每一条原因都必须分开显示，因为它们要做的事不同：
 *     站点没开 → 找管理员          本机关了 → 自己打开就行
 *     站点没装作业侧 → 找管理员重新部署（开那个开关没用）
 *     本机没有 → 升级客户端        池里撞车 → 删掉多余的那一份
 *   糊成一句"不可用"，用户就只能去猜。那四句话在 WHY_NOT_RUNNABLE 里。
 *
 * ── 同一份内容不许重画 ──────────────────────────────────────────────────────
 *
 * 每次对账之后主进程都会把整个视图推过来（连上站点、按「重新同步」、同意一个
 *   插件之后都会）。视图一个字都没变的时候，从前
 *   也照样把这一屏拆了重画一遍 —— 于是展开着的「高级选项」自己合上、滚动位置跳回
 *   顶上、填了一半的值被清成空白。三件事同一个根因，而用户看到的是"界面自己在乱跑"。
 * 所以进来先算一次指纹（`pluginsSignature`），与上次逐字相同就整块跳过。
 *   指纹的失败方向是安全的：算不出相等（键序变了、多了一格）就退化成今天的样子，
 *   照旧重画。
 * 真要重画的地方显式传 `force` —— 今天有两处，都写清了为什么。
 */
function renderPlugins(pv, force) {
  const box = $('plugin-blocks');
  const issues = $('plugin-issues');
  if (!pv) {
    box.textContent = '';
    issues.textContent = '';
    // 清空的同时要把指纹一起清掉：留着的话，下一条与清空之前逐字相同的视图会被
    //   当成"同一份内容"跳过，于是屏幕上是一块空列表，没有任何东西解释它为什么空着。
    pluginsSig = null;
    return;
  }
  const sig = pluginsSignature(pv);
  if (!force && sig === pluginsSig) return;
  pluginsSig = sig;
  box.textContent = '';
  issues.textContent = '';
  lastPlugins = pv;
  // 标签栏要不要露、露哪一颗「面板」，判据里有 `hasSurface`，而它读的正是
  //   这一份清单 —— 所以清单换了就当场重画一次。少了这一句，一次先到的会话表
  //   会把那一栏按"清单还没到"画成收着的样子，而它此后不会自己再画一次。
  renderTabs();

  // 站点分发那一栏、待同意那一段、没加载的那些 —— 与插件块一起重画。
  renderSitePlugins(pv);
  renderConsent(pv);
  renderInert(pv);

  const list = pv.plugins || [];
  // 这一屏上那些块连同它们各自的高级选项一起重建（下面那几格住在闭包上）：
  //   名单跟着换一批，否则 `renderPartitions` 会去改一批已经不在文档里的格子。
  // 走到这里就是"内容真的变了"（上面那道指纹已经把没变的挡回去了），所以丢掉
  //   旧的格子是对的 —— 留在表里的是已经不在文档里的元素。
  advCells = [];
  quotaCells.clear();
  // 空池是正常状态，不是故障。基座本来就不带插件 —— 所以这一段的任务不是
  //   道歉，是给出路：池在哪、怎么装、装完怎么让它出现。
  if (!list.length) box.append(emptyPool(pv));

  for (const p of list) {
    box.append(pluginBlock(p));
  }

  // ── 池里的问题：被跳过的东西必须说出来 ──
  //
  // 收起来（`issueFold`）：它一字排开能占满整屏，而这一屏的主角是那些插件块。
  //   抬头一直在，少了哪一个点开就看得到。
  const errs = pv.errors || [];
  if (errs.length) issues.append(issueFold('err', '插件没有加载', errs));

  // ── 站点侧的问题：本站有包装不上（账本 F22）──────────────────────
  //
  // 抬头逐字沿用守护进程那两处（`--check` 的与 `start()` 的日志）：
  //   同一条规则一处措辞，三处说的是同一件事。改写成界面口气的话，运维会以为是
  //   第四种毛病，然后去查一条不存在的原因。（这一步不是修辞：`renderer.test.mjs`
  //   里有一条用例拿这三个字面量互相校，改一处就红。）
  //
  //   `--check-plugins` 那句（`插件错误: …`）故意不同，别顺手统一：那一屏
  //     不读站点配置（它要能在一台配置读不出来的机器上跑，install-base.sh 也拿它
  //     预检还没装进去的源目录），所以它说的是"这个包本身装不装得上"，
  //     而这里说的是"本站已经装着的包哪个坏了" —— 两句话，两个时候。
  //
  // `warn` 而不是 `err`：它不阻塞任何东西。守护进程照常跑、其余插件照常
  //   工作，只是少了这一个 —— 与上面 `errors` 那条（本机池里有东西没加载）分级
  //   相同，所以两块都不该读成"客户端坏了"。
  //
  // `body` 是站点原样报下来的字，客户端一个字都不改写：那些句子是守护进程
  //   按它当下的诊断算出来的（哪个包、什么原因、下一步做什么）。在这里重写 = 造
  //   第二份会漂的真相 —— 而它漂的时候没有任何东西会红。
  //
  // 与上面 `errors` 必须分开画：主语不同（本机池 vs 站点），出路也不同
  //   （重新同步 vs 找管理员）。合成一列就把"是我这儿坏了还是本站装坏了"糊掉了。
  const probs = pv.problems || [];
  if (probs.length) {
    issues.append(issueFold('warn', '插件有问题（已跳过，其余插件照常工作）', probs));
  }

  // ── 站点有而本机没有 ──
  //
  // 「一个都没装」与「版本对不上」在 `missing` 里长得一模一样（都是"站点报
  //   了一个本机查不到的 (id, 版本)"），但要做的事完全不同：去装一个 vs 去换一版。
  //   判据是池空不空 —— 不判的话，零插件时会对站点上每一个
  //   插件都喊一遍"升级客户端"，而真相是"你还没装插件"。
  const miss = pv.missing || [];
  if (miss.length) {
    // 三条出路必须分开说，因为它们要做的事不同。合并成一句"本站有而本机
    //   没有 —— 升级客户端"的话，其中两条会被指错方向。
    // 四态里"获取失败"的那三种出路不同，所以不合成一句：
    //   不分发（问管理员）/ 此刻发不出来（再同步一次）/ 读不懂（升级客户端）。
    const bySync = miss.filter((m) => m.delivery === 'package');
    const byHand = miss.filter((m) => m.delivery !== 'package');
    const names = (list) => list.map((m) => (m.version ? `${m.title} ${m.version} 版` : m.title)).join('、');

    if (bySync.length) {
      const site = pv.site || {};
      if (site.supported === false && site.reason === 'old_daemon') {
        issues.append(issueBox('warn', '本站提供的插件，本机没有',
          `${names(bySync)}。\n这个站点的守护进程版本过低，不支持插件分发。`
          + '要让客户端自动取回它们，得请管理员升级站点上的守护进程。'));
      } else if (site.supported === false) {
        issues.append(issueBox('warn', '本站提供的插件，本机没有',
          `${names(bySync)}。\n${site.error || '这次未能从站点获取插件。'}`));
      } else if (pv.installedCount === 0) {
        issues.append(issueBox('warn', '本站提供的插件，本机一个都没有',
          `${names(bySync)}。\n本机还没有装上任何插件，所以上面一个按钮都没有。`
          + '点「重新同步」把它们取回来（带客户端代码的要先确认同意），就会变成可以开始会话的块。'));
      } else {
        issues.append(issueBox('warn', '本站报的这几个版本，与本机不一致',
          `${names(bySync)}。\n可能本机装的是另一个版本，也可能同步还没跑到。`
          + '用页面底部的「重新同步」取一次。'));
      }
    }
    const absent = byHand.filter((m) => m.delivery === 'absent');
    if (absent.length) {
      issues.append(issueBox('warn', '本站有这一版，而它不分发',
        `${names(absent)}。\n本站没有分发它。请管理员确认站点上那一份装完整了。`));
    }
    const notReady = byHand.filter((m) => m.delivery === 'not_ready');
    if (notReady.length) {
      issues.append(issueBox('warn', '本站有这一版，此刻发不出来',
        `${names(notReady)}。\n站点说这一份现在发不出来。稍后再同步一次。`));
    }
    const unusable = byHand.filter((m) => m.delivery === 'unusable');
    if (unusable.length) {
      issues.append(issueBox('warn', '本站有这一版，而它用不了',
        `${names(unusable)}。\n站点报的这一份读不懂，多半是包格式比本客户端新。`
        + '升级客户端。'));
    }
  }
}

/**
 * 本机一个插件都没有。
 *
 * 别把"一个插件都没有"说成故障（「这个客户端一个插件都没有 —— 安装包可能
 *   不完整」）—— 那是一个每个客户端都有的初始状态，说成故障还没给出任何出路。
 *
 * 这个空态的答案是"连上站点、点重新同步"：插件由站点分发，本机没有自装的入口 ——
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
      '基座不带插件，作业里跑什么由插件决定。这个站点的守护进程版本过低，'
      + '不支持插件分发，客户端没地方去取。请管理员升级站点上的守护进程。'));
  } else if (site.supported === false) {
    d.append(el('p', 'plug-desc',
      '基座不带插件，作业里跑什么由插件决定。'
      + (site.error || '还没连上站点，所以还不知道本站有没有插件要给你。')));
  } else {
    d.append(el('p', 'plug-desc',
      '基座不带插件，作业里跑什么由插件决定。本站会分发插件，'
      + '连上之后它们会出现在这里。带客户端代码的每个都要先确认同意。'
      + '也可以按这一屏底部的「重新同步」现取一次。'));
  }

  // 这里从前还有一颗「重新同步」。现在这一屏只有底部那一颗（与「检查集群」
  //   并排）—— 同一个动作不摆第二个入口，按位置找按钮的代码也不会认错。
  return d;
}

/**
 * ── 站点分发那一栏 ────────────────────────────────────────────────────────
 *
 * 这里唯一值得显示的东西是每个版本被哪些站点要 —— 它是"为什么这台机器上
 *   会有两个版本"这个问题的答案。没有它，用户面对两个同名的块只能猜。
 */
/**
 * 「站点太新」那一句：正文一行（事实 + 该做什么），理由挂 `title`。
 *
 * 它不是一个泛泛的"解释收进悬停"：这句话有两个方向（升级客户端 / 升级没用），
 *   指错了用户就会去做一件解决不了问题的事。所以正文那一行必须是那个方向，
 *   而 `title` 里放的是"凭什么这么判"。
 */
function versionWhy(host, line, why) {
  const p = el('p', 'why', line);
  p.title = why;
  host.append(p);
  return p;
}

function renderSitePlugins(pv) {
  const box = $('site-plugins');
  box.textContent = '';
  const site = pv.site;
  // 站点连不上时也要画 —— 池里可能已经有东西了，而"每个版本被谁要"是那一栏
  // 唯一值得显示的东西。池的路径在主进程给（`pv.sitePoolDir`）。
  if (!site && !pv.sitePoolDir) return;

  // ── 这一块只画问题，不画"一切正常" ──────────────────────────────────────
  //
  // 用户 2026-10-16 的原话：这个框在真实客户端里应该整个不存在。它承载的
  //   【问题】不跟着一起消失：站点太旧/太新、这一轮有包装不上、快照表读不到、
  //   本机那一份不见了 —— 那些照旧画（连着标题，否则读者不知道说的是哪一块）。
  // 一句问题都没有时，整块不出现。
  const why = (site && site.reason) || null;
  const hasProblem = Boolean(
    why === 'old_daemon' || why === 'site_too_new'
    || (site && (site.error || site.snapshotOk === false || site.withdrawn
      || (site.failed && site.failed.length))));
  if (!hasProblem) return;

  const d = document.createElement('div');
  d.className = 'plug plug-off';
  const head = document.createElement('div');
  head.className = 'plug-head';
  head.append(el('h3', null, '站点分发'));
  d.append(head);

  {
    if (site.reason === 'old_daemon') {
      d.append(el('p', 'why', '这个站点的守护进程版本过低，不支持插件分发。'));
    } else if (site.reason === 'site_too_new') {
      // 与「守护进程太旧」不是同一件事，方向正好相反：那一个是站点落后于
      //   客户端，这一个是客户端落后于站点 —— 该做的是升级这个客户端。
      //   两者合并成一句"版本对不上"的话，用户会去找管理员，而管理员那边一切正常。
      //
      // 没有退路可退：那些插件是真的装不上，而这句话必须
      //   这么说；含糊成"能装上就好"会让用户以为已经好了，其实一个都没装上。
      //
      // 而版本握手让这句话能说得更准：客户端手里有服务端的
      //   真版本号，所以"站点比客户端新"是一个被检验过
      //   的结论，不是推断：
      //     · 跨大版本，站点是新一代是对的，那时格式更新本就在预期之内；
      //     · 其它情形（握手说客户端不低于服务端），服务端不可能更新，
      //       格式比客户端新只可能是站点自己不一致（版本号没升而格式升了，
      //       违反了"格式号只因基座版本升而升"那条纪律）。说成"升级客户端"会把
      //       用户指去干一件解决不了问题的事。
      // 正文只留一行：说事实 + 说该做什么。上面那一大段推理（为什么这一支
      //    说"升级客户端"、那一支说"升级解决不了"）搬进 `title` —— 它是理由，
      //    而用户此刻的动作只有两个方向，一行就够把他指对。这也正是它必须分叉的
      //    理由：指错了方向，用户会去做一件解决不了问题的事。
      if (site.daemonVersionVerdict === 'cross_major') {
        versionWhy(d, '这个站点发的插件包格式比本客户端新。请升级这个客户端。',
          '这个集群的服务端与本客户端大版本不同，所以那些插件包用的是更新的格式，'
          + '而这一版的客户端没有其他办法把它取下来。请升级这个客户端。');
      } else {
        versionWhy(d, '这个站点发的插件包格式比本客户端新，而它报的基座版本并不更新。升级客户端解决不了。',
          '升级客户端解决不了：这个站点报的基座版本并不比本客户端新。'
          + '所以"包格式比客户端新"只可能是站点自己不一致：版本号没升，包格式却升了，'
          + '违反了"格式号只因基座版本升而升"这条纪律。请让管理员看这个站点的部署。');
      }
    } else if (site.error) {
      d.append(el('p', 'why', site.error));
    }
    // 「这一轮有包装不上」。
    if (site.failed && site.failed.length) {
      d.append(el('p', 'why',
        `这一轮有 ${site.failed.length} 个没装上，见下面的报错。`));
    }
    // 记录读不出来，一个版本都不会被回收。这是用户该知道的一件事：
    // 他可能发现池子越来越大，而原因在这里。
    if (site.snapshotOk === false) {
      d.append(el('p', 'why',
        '站点的插件快照表读取失败（或者写入失败），所以这一轮没有回收任何旧版本。'
        + '不知道谁在引用的时候，唯一安全的动作是什么都不删。'));
    }

    // §5.3：本机那一份不在了，同意作废，本轮会重新问一次。
    // 不说"是你删的" —— 客户端不知道原因（可能是他删的，可能是别的什么）。
    if (site.withdrawn) {
      d.append(el('p', 'why',
        `有 ${site.withdrawn} 个插件本机那一份已经不在了，上一次的同意因此作废。`
        + '本轮会重新问一次。删掉本机一份就等于撤回同意：不这么算，下一次对账会'
        + '按"摘要与上次一致"把它静默装回来。'));
    }

  }

  // 「重新同步」不在这里 —— 它在整屏底部那一行（与「检查集群」并排），
  //   见 `bindEvents` 里那条绑定。
  box.append(d);
}

/**
 * ── 待同意 ────────────────────────────────────────────────────────────────
 *
 * 不是 `runnable` 的第五档。WHY_NOT_RUNNABLE 那四句话说的是"这个插件
 *   起不来的原因"，而"还没同意"是"还没到手" —— 与 `missing` 同一类。
 *
 * 同意界面的措辞就是这一版唯一的安全边界（进程隔离还没做）。所以它必须把
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
  // 两种情形的说法必须不同，因为它们的出路不同：
  //   一份还在暂存里等换入（同意 = 装上去，不同意 = 丢掉草稿），
  //   另一份已经在池子里、只是台账对不上（同意 = 原地认领，不同意 = 删掉那一份）。
  //   共用一句的话，用户在第二种情形下会以为自己面对的是"还没下来的东西"。
  const anyNew = list.some((c) => !c.existing);
  const anyHere = list.some((c) => c.existing);
  d.append(el('p', 'plug-desc',
    (anyNew ? '它们已经取回到本机，包里每一份都核过了，但还没有装上去，要你先确认同意。' : '')
    + (anyNew && anyHere ? '\n' : '')
    + (anyHere ? '另外有几个本机已经有一份，而它没有在同意台账里（换过机器、'
      + '删过配置、或者上一次的同意已经作废）。它们的客户端代码没有在跑。'
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
      + (c.existing ? '这一份本机已经有了。' : '');
    one.append(who);

    // 第二次之后的同意要显示变了什么。只显示一个摘要等于什么也没说。
    //
    // 而"变了什么"有两种，绝不能混成一句：内容变了（同一个版本号下换了一份
    //   东西 —— 那是要警惕的），与换算法了（我们换了一把尺子 —— 那条老记录
    //   上的值与这个新值本来就不该放在一起比）。合并的话，一次客户端升级会对每个
    //   每个插件喊一句"内容变了"，而那正是"狼来了"。
    const digestLine = document.createElement('p');
    digestLine.className = 'plug-desc';
    const algChanged = c.previous && c.previous.alg !== c.digestAlg;
    if (c.previous && !algChanged) {
      digestLine.textContent = c.previous.digest === c.digest
        ? `内容摘要 ${c.digest}（与上次同意的一致）`
        : `内容摘要变了：从 ${c.previous.digest} 变成 ${c.digest}。`
          + '同一个版本号下的内容变了，确认是你要的再决定。';
    } else if (c.previous) {
      digestLine.textContent = `内容摘要 ${c.digest}（本机记的那一条是另一种算法算的，`
        + '两者不可比，所以这一次要重新确认一遍。这不是"内容变了"）';
    } else {
      digestLine.textContent = `内容摘要 ${c.digest}（算法 v${c.digestAlg}）`;
    }
    one.append(digestLine);
    // 上面那一句里的是短形（16 位，人一眼分得开就行），而完整 64 位也
    //   画出来：它与守护进程 `--check-plugins` 那一屏报的、作者那边
    //   `packer inspect` 报的是同一个数，而那两处都刻意不截断（理由写在
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

    // §5.4：这一份是谁签的。没有签名也是一句必须说的话 —— 留白会被读成
    // "还没显示出来"。
    const who2 = document.createElement('p');
    who2.className = 'why';
    who2.textContent = c.fingerprint
      ? `签名者指纹 ${c.fingerprint}。本机第一次接受这个 id 时会记下它，`
        + '此后同一个 id 的每一份都必须由同一把钥匙签，换了人就会拒绝。'
      : '这一份没有签名。签名在插件规范里是可选的（§4.1），所以这不是错误；'
        + '但它意味着"内容与上次一致"是这里唯一的保证。';
    one.append(who2);

    // 这一句留着，而且是这一版唯一的安全边界（进程隔离还没做）：
    //   同意一个带客户端代码的插件 = 把工作站的代码执行权交给集群管理员。
    //   压到一行：「不同意会怎样」由那颗按钮自己的措辞说（「不同意，删掉本机
    //   这一份」/「不同意」）—— 按钮能说清的事，不必再写一句在旁边。
    const warn = document.createElement('p');
    warn.className = 'why';
    warn.textContent = '同意之后，这个插件的客户端代码会在这台机器上运行'
      + '（与客户端同一个进程、同样的权限，目前没有进程隔离）。不确定来源时不要同意。';
    one.append(warn);

    const row = document.createElement('div');
    row.className = 'plug-meta';
    row.append(button(c.existing ? '同意，用它' : '同意并装上', () => consentPlugin(c.id, c.version)));
    row.append(button(c.existing ? '不同意，删掉' : '不同意',
      () => rejectPlugin(c.id, c.version), 'ghost'));
    one.append(row);
    d.append(one);
  }
  box.append(d);
}

/**
 * ── 池里那些没被加载的 ────────────────────────────────────────────────
 *
 * 这一块是补一个真的洞（不是美化）：在它之前，"池里有一份、台账对不上"的
 *   站点插件两条路都不在 —— 插件那一列把 `active === false` 的滤掉了，
 *   而"本站有而本机没有"那一列要求注册表里查不到它（它恰恰查得到，只是没有
 *   钩子）。于是界面上彻底看不见，连一个能点的东西都没有，重新同步也救不回来。
 *   摘要换一次公式就会对每个用户的每个插件成立 —— 集体消失、无从恢复。
 *
 * 为什么不给"同意"按钮：这一块里的那些站点此刻没有在报它们，所以没有一个
 *   说得出口的"要不要装这一份"可问。能做而且该做的是一个出口 —— 删掉本机
 *   这一份（§5.3：删掉 = 撤回同意，于是下次对账重新问）。在此之前连那个都没有。
 *
 * 那一颗现在也画在插件那一列的每一块上（`pluginBlock`）—— 从前它只有这一个
 *   入口，于是"我装的插件删不掉"在界面上没有出路。两个入口走的是同一个动词
 *   （`dropPluginVersion`），措辞也逐字相同。
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
    '它们已经在本机上了（是站点分发下来的），而它们的客户端代码没有在跑。'
    + '原因只有一个：还没有同意过这一份，而本站此刻没有在报它们，'
    + '所以暂时没有"同意"这个入口（管理员把插件关掉时就是这样）。'));
  d.append(el('p', 'plug-desc',
    '它们不会被加载，也不会被回收：站点不报一个插件不构成删除它的理由，'
    + '它随时可能再打开。不要的那一份删掉就行，下一次对账会重新问一次。'));

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
 * 主进程已经把"没人用的"算好了（`app:pluginData`），这里只画。在用的那些不列 ——
 * 它们不是"问题"，而且那件事有更好的走法：换一个工作区（`＋ 新建空白工作区…`）会换
 * 分区、重建视图、由插件重新登录，那正是"重置"。
 *
 * 两种"什么都没有"要分开：
 *   · 查过了、真没有，整节收起来（与 `#plugin-inert` 同一个形状）；
 *   · 这一次没能查（`diskChecked:false`），要画出来。不说"查不了"就等于说
 *     "没有"，而那是两件事 —— 这个界面里到处都是这条纪律。
 */
function renderPluginData(d) {
  const sec = $('sec-data');
  const box = $('plugin-data');
  box.textContent = '';

  const rows = (d && d.rows) || [];
  if (d && d.ok === false) {
    sec.classList.remove('hidden');
    box.append(el('p', 'plug-desc', d.error || '本机的插件数据未能列出来。'));
    return;
  }
  // 收掉过东西的时候，这一屏不许藏。
  //   自动回收把孤儿清干净之后 `rows` 正好是空的 —— 而"清单里没有东西了"与
  //   "这一次启动清掉了三份"是两件完全不同的事：只判 `rows` 的话，那一行
  //   永远画不出来（删除就成了用户看不见的），而它画的正是"删的是自动化，
  //   不是可见性"这句唯一的兑现处。与账本 F35 同一个形状：算出来了、没送到。
  const reclaimed = (d && d.reclaimed) || { count: 0, items: [], failed: [] };
  // 还欠着的那几份（此刻删不掉、已经登记成"下一次启动时清"）。
  //   它也要把这一屏撑开：一份待删的数据在下面那份清单里是看不到的
  //   （`index.js` 的 `withoutPending` 把它剔掉了），所以这一句是它唯一的露面处。
  const deferred = (d && d.deferred) || { count: 0, items: [] };
  const didReclaim = reclaimed.count > 0
    || (Array.isArray(reclaimed.failed) && reclaimed.failed.length > 0)
    || deferred.count > 0;
  if (!rows.length && !didReclaim && d && d.diskChecked) {
    sec.classList.add('hidden');
    return;
  }
  sec.classList.remove('hidden');

  const wrap = document.createElement('div');
  wrap.className = 'plug plug-off';
  // 整屏认不出时标题也要跟着改：下面那些行不是"没人用的插件数据"，
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

  // 这一次运行收掉了什么 —— 自动回收的留痕（`index.js` 的 `reclaimOrphans`）。
  //   它是"删的是自动化，不是可见性"这句话唯一的兑现处，所以话要说满：几份、都是谁。
  //   "本次运行"而不是"本次启动"：那一格是累计的，而回收跟着对账走 ——
  //     对账今天只在打开客户端时跑一次，但这句话不该依赖那件事（见 `lastReclaim`）。
  //   它排在下面那段说明前面：这一段说的是"刚刚发生过的事"，而下面那段说的是
  //     "下面这份清单是干什么的"。
  if (reclaimed.count > 0) {
    const who = (reclaimed.items || []).map((i) => i.label).filter(Boolean);
    wrap.append(el('p', 'plug-desc',
      `本次运行清掉了 ${reclaimed.count} 份没人管的数据`
      + (who.length ? `（${who.join('；')}）` : '')
      + '。它们按现在装着的插件再也无法读取：插件卸载了、工作区删了、'
      + '或者插件换了共享组。留着只会越攒越多，所以对账时自动收掉了。'));
  }
  if (Array.isArray(reclaimed.failed) && reclaimed.failed.length) {
    wrap.append(el('p', 'plug-desc',
      `还有 ${reclaimed.failed.length} 份未能清掉`
      + `（${reclaimed.failed.map((f) => `${f.label || f.name}：${f.error}`).join('；')}）。`
      + '它们还在盘上，下一次对账会再试一次。'));
  }
  // 推到最后一次启动时清的那几份。它排在上面那一段后面，因为它是"还欠着"，
  //   而上面那一段是"已经发生"。
  if (deferred.count > 0) {
    const who = (deferred.items || []).map((x) => x.label).filter(Boolean);
    wrap.append(el('p', 'plug-desc',
      `另有 ${deferred.count} 份要等下一次启动时清掉`
      + (who.length ? `（${who.join('；')}）` : '')
      // 「可能」不是含糊：具体是谁占着它，本程序判不出来（`EPERM` 有一串来源）。
      //   说死一句"被本程序占用"就是替系统说一句它不知道的话。
      + '：它们此刻可能被其他进程占用。关掉再打开时会再清一次。'));
  }

  if (!d || !d.diskChecked) {
    wrap.append(el('p', 'plug-desc', (d && d.why)
      || '这一次未能查看磁盘上还剩哪些，所以这里没有内容可列。'));
  } else {
    if (allUnknown) {
      // 这一句是插件数据目录那一根唯一的防线（它是我们自己拼出来的，
      //   没有任何探针能当场核对它 —— 见 plugin-data-audit.js 里 `allUnknown`）。
      //   所以话要说满：说出"多半是根取错了"，也说出"下面为什么一个按钮都没有"。
      wrap.append(issueBox('warn', '这一屏的目录一个都认不出',
        '本机有两处放插件数据：Electron 那个存储分区目录（那一根是问 Electron'
        + '要来的，还当场核对过名字），以及本程序自己拼出来的插件数据目录。'
        + '整屏都认不出，更像"其中某一根指到了其他地方"，而不是"攒了一堆垃圾"。'
        + '下面一个删除按钮都没有，这是故意的：一份不认识的内容，'
        + '删掉它不是"收拾"而是"猜"。重启一次看看还在不在，还在就值得报出来。'));
    }
    // 这里从前有一段解释"一份数据是什么、它的两个落点在哪"。删掉了：每一行
    //   自己就在说这件事（`placesText(r.places)` 逐行说清它在浏览器里、在磁盘上
    //   还是两处都有），而那张映射图的右列说的是"它被谁指着"。一段统论说不出
    //   单行说不出的事，只会让人多读一遍。
    wrap.append(el('p', 'plug-desc',
      '删掉一份找不回来，那个插件下次打开会是一份全新的空白存储。'
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
    // 说清删掉的是什么：这一份可能在浏览器里、在磁盘上、或者两处都有。
    one.append(el('p', 'plug-meta', placesText(r.places)));
    if (r.deletable) {
      const row = document.createElement('div');
      row.className = 'plug-meta';
      // 两段式（`armConfirm`）：这一份删了就没了 —— 浏览器里的布局/标签页/
      //   登录状态，以及插件自己写在磁盘上的东西（那个插件最可能放"重建不出来"
      //   的文件的地方）。这是六处两段式之一，判据是代价，不是"不可逆"
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
 * 这一份数据在哪儿 —— 删除按钮的确认框要靠它说清删掉的是什么。
 *
 * 两个落点不能混成一句：浏览器里那份是布局/标签页/登录状态，而磁盘上那份是插件
 * 自己写的东西 —— 后者正是作者最可能放"重建不出来"的东西的地方（配置与钥匙
 * 常常就写在那儿）。两者都不可逆，但用户能预期的东西不同。
 */
function placesText(places) {
  const p = (places || []).includes('partition');
  const d = (places || []).includes('data');
  if (p && d) return '它有两部分：浏览器里的存储（布局、标签页、登录状态），'
    + '以及那个插件写在磁盘上的文件。';
  if (d) return '它是那个插件写在磁盘上的文件。';
  return '它在浏览器里（那个插件没有另外往磁盘上写文件）。';
}

/**
 * 删掉一份插件数据。真的删。
 *
 * 那个"问一句"在调用点（`renderPluginData` 里那颗按钮上的 `armConfirm`），
 *   不在这里。它从前是这里的一句 `window.confirm` —— 换掉的理由与别处同源：
 *   `window.confirm` 给不了两段（框弹出来的时候用户已经按下去了），
 *   而样式也不受控（在 Electron 里那是一块系统窗口）。
 * 于是这个函数可以被任何调用点直接用而不会弹框 —— 它只做那件事。
 */
async function dropPluginData(r) {
  const res = await window.slurmate.deletePluginData({ name: r.name });
  if (!res || !res.ok) {
    // `stale` 由主进程给一句能直接读的话（判定权在它那儿）。
    return notice('error', (res && res.error) || '未能删掉。');
  }
  // 两句话，两个结果。`pending` 那一格由主进程给（判定权在它那儿）——
  //   让界面从 `deferred` 里自己翻一遍，等于把"删掉了没有"这个判定搬到这里。
  if (res.pending) {
    notice('info', `「${res.label || r.label}」未能清掉，下一次启动时会自动清掉。`);
  } else {
    notice('info', `已删掉「${res.label || r.label}」。`);
  }
  renderPluginData(res);
}

// 这里没有"开发者"那一节：没有「也加载本机插件目录（开发用）」的复选框，也
//   没有「从一个包安装…」「打开插件目录」「重新扫描」三个按钮。池子只有一条来的
//   路（站点分发），所以这里没有开关可藏。
//
//   而"把那些入口默认藏起来"从来不是禁令 —— 一个需要靠"默认藏起来"才成立的禁令
//   不是禁令，是一个开关。`packer/docs/PLUGIN-SPEC.md` §5.2 要的是没有分支
//   （"禁止给任何一类插件开免同意的口子"）。

async function syncPlugins() {
  const r = await window.slurmate.syncPlugins();
  if (r && r.plugins) renderPlugins(r.plugins);
  else notice('error', (r && r.error) || '重新同步失败');
}

async function consentPlugin(id, version) {
  const r = await window.slurmate.consentPlugin(id, version);
  if (r && r.plugins) renderPlugins(r.plugins);
  if (!r || !r.ok) notice('error', (r && r.error) || '未能同意这个插件');
}

async function rejectPlugin(id, version) {
  const r = await window.slurmate.rejectPlugin(id, version);
  if (r && r.plugins) renderPlugins(r.plugins);
  if (!r || !r.ok) notice('error', (r && r.error) || '未能处理这个插件');
}

/** §5.3：删掉本机那一份 = 撤回同意。下一次对账会重新问一次。 */
async function dropPluginVersion(id, version) {
  const r = await window.slurmate.dropPluginVersion(id, version);
  if (r && r.plugins) renderPlugins(r.plugins);
  if (!r || !r.ok) notice('error', (r && r.error) || '未能删掉本机那一份');
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
 * 「这个插件起不来」的四条原因 —— 一个原因一句话，写在一起。
 *
 * 四句话必须互不相同：分开它们的是"这件事该谁去做"。合并成一句「这个插件用不了」
 *   的话，用户就只能一个个试 —— 而其中两条都要找管理员，但是两件不同的事
 *   （一个是开关没开，管理员开一下就好；一个是本站部署没跟上，管理员去开开关没用）。
 *   `test/renderer.test.mjs` 钉着"四句互不相同、且都不是空话"这一条。
 *
 * `noJob` 里的 `%s` 是插件名（用 `replace` 而不是模板串，是为了让那四句话在这个
 * 字面量里各自完整 —— 检查才做得成）。
 */
const WHY_NOT_RUNNABLE = {
  siteUnknown: '这个守护进程不通报插件清单，所以客户端不知道站点开没开它。',
  siteOff: '本站没有开放这个插件，要开得找管理员。',
  localOff: '本机把它关掉了，勾上左边那个开关就能用。',
  noJob: '「%s」没有作业侧，提交不了；它也没有提供本机入口。',
};

/**
 * 这个插件为什么起不来。四选一，见 WHY_NOT_RUNNABLE。
 *
 * `runnable` 是三个条件的求交（站点开没开 / 本机关没关 / 站点有没有作业侧），
 * 分支顺序与之对应 —— 先说的那个是"最外层"的原因，也正是用户最该先去解决的那件。
 */
function whyNotRunnable(p) {
  if (!p.siteEnabled) {
    return p.siteKnown ? WHY_NOT_RUNNABLE.siteOff : WHY_NOT_RUNNABLE.siteUnknown;
  }
  if (p.locallyEnabled === false) return WHY_NOT_RUNNABLE.localOff;
  return WHY_NOT_RUNNABLE.noJob.replace('%s', p.title);
}

/** 当前活跃那条连接。插件块上那一格问的就是它的工作区 —— 与「开始会话」同一条。 */
function activeConn() {
  const id = boot && boot.activeConnectionId;
  return ((boot && boot.connections) || []).find((c) => c.id === id) || null;
}

/**
 * 「还有谁在用这一份数据」—— 一句跟在端口后面的小字。
 *
 * 它是反查，不是推导：`boot.workspaces` 是主进程算好的那张引用表，这里只是
 *   拿一个数据 id 去问"哪几个工作区的表里指着它"。查错了的代价是一句注释不准
 *   （不是一次删错东西）—— 真正不可逆的判断全部留在主进程。
 * 不含当前这个工作区：用户看的是"除了我这里，还有谁"。
 */
function spaceUsersOf(spaceId, workspaceId) {
  const names = (boot.workspaces || [])
    .filter((l) => l.id !== workspaceId
      && Object.values(l.refs || {}).includes(spaceId))
    .map((l) => `「${workspaceLabel(l)}」`);
  return names.length ? `${names.join('、')}也在用` : '';
}

/**
 * 插件块上那一格：这个插件用哪一份数据。
 *
 * 主体是当前活跃连接的工作区（与旁边那个「开始会话」按钮同一条连接）——
 *   用户在连接列表里选哪条，这一格说的就是哪条。没有活跃连接（一条连接都还没有）
 *   时不画：那一格答的问题在那时不存在，画一个空下拉等于凭空许诺一个不存在的东西。
 *
 * 三种取值与「③ 工作区」同一套约定（键缺席 / `null` / 一个 id），
 *   逐一写在 `applyPluginSpace` 上面。
 *
 * 选项只有这个插件现在读得到的那几份（`pluginId` 与 `group` 都要对得上，
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
    + `「${workspaceLabel(ws)}」里，这个插件用哪一份数据。`
    + '一份数据 = 一个本地端口 + 一份浏览器存储（登录状态、窗口布局），'
    + '可以被几个工作区共用，共用就是它们看到同一份。';

  const sel = document.createElement('select');
  sel.className = 'plug-space';
  sel.setAttribute('aria-label', '这个插件用哪一份数据');

  // 只在这一格还是空的时候才有"跟随默认"那一项：已经有了的那一份就是
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

  // `NEW_SPACE` 与 `''` 都要原样留住：前者是用户显式要另开一份，后者是"这一格
  //   还没有值"。一个"找不到就空着"的兜底会把它们悄悄换成空串 —— 于是"另开一份"
  //   变成"什么都不做"，而用户看到的是下拉弹回了默认那一项，没有任何一句话解释。
  sel.value = (cur === '' || cur === NEW_SPACE || known) ? cur : '';

  sel.onchange = async () => {
    const v = sel.value;
    // 键缺席 = 没表态（只有"默认"那一项给得出这个值）。
    const arg = v === NEW_SPACE ? null : (v === '' ? undefined : v);
    const r = await applyPluginSpace(ws.id, p.id, arg);
    // 没成功就把下拉拨回真实的那一格（重建整块 → 下拉按 `refs` 重新选中）。
    // `lastPlugins` 为空时什么都不做：`renderPlugins(null)` 会把整块插件列表
    //   清空 —— 那比"下拉停在错的值上"严重得多。
    // 这里必须 `force`：重建的理由不是"视图变了"（它在手上，一个字都没变），
    //   而是"下拉被拨到了错的位置，要按同一份视图重画一遍把它拉回来"。
    if (!r.ok && lastPlugins) renderPlugins(lastPlugins, true);
  };

  row.append(lab, sel);
  return row;
}

/**
 * 换「这个插件用哪一份数据」。
 *
 * 今天只有一个入口（插件块上那一格），但仍然单独成一个函数：它与
 *   `applyWorkspace` 是同一条路子（先做、被拒了再问、成了再重画），而那一条路里
 *   每一格都是踩过的坑。等"从别的工作区复用一份过来"那个入口出现时，它走这里 ——
 *   而不是在旁边长出第二份长得差不多的实现。
 *
 * 三种取值（与「③ 工作区」同一套，主进程那边是三件事）：
 *     键缺席（`undefined`）= 用户没表态，什么都不做
 *     `null`                  = 要一份新的（哪怕现在已经有一份）
 *     一个 id                 = 就用那一份
 * 界面不自己算"应当是哪一份"：那样算出来的值是上一个字算的（工作区刚换过、
 *     或者插件刚重新同步过），而用户按下去的是此刻。
 *
 * 先做、被拒了再问（与 `applyWorkspace` 同一套路）：旧那一份会不会被删掉、以及
 *   这张表是不是被几条连接共用，都由主进程判定 —— 界面手里那份引用计数随时
 *   可能已经陈旧，而"我删掉了你那份数据"必须是真的才会说出口。
 *
 * 两道问按主进程给的次序走，而重试要把前面已经答过的带上（`extra`）：
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
    const pick = await askFork(
      workspaceLabel(workspaceById(r.workspaceId)) || r.workspaceName || '那个工作区',
      r.others || []);
    if (!pick) return { ok: false };
    extra = { scope: pick };
    r = await window.slurmate.setWorkspaceRef({ ...arg, ...extra });
  }
  if (!r.ok && r.code === 'would_discard') {
    if (!window.confirm(`${r.error}\n\n确定要换吗？`)) return { ok: false };
    r = await window.slurmate.setWorkspaceRef({ ...arg, ...extra, confirmDiscard: true });
  }
  if (!r.ok) {
    notice('error', r.error || '未能换这一份数据。');
    return { ok: false };
  }

  boot.workspaces = r.workspaces || boot.workspaces;
  boot.spaces = r.spaces || boot.spaces;
  boot.connections = r.connections || boot.connections;
  // 两处都跟着变：插件块上那一格、映射图与连接列表（它按工作区算独占与引用数）。
  renderConnections(boot.connections);
  // 这里显式重画：`r` 带回来的那几张表通常与手上这份不同（指纹自己就判得出来），
  //   但"通常"不是判据 —— 换成功之后这一格显示的东西必须与引用表一致，
  //   而那个一致性不该指望两份 JSON 碰巧不相等。
  if (lastPlugins) renderPlugins(lastPlugins, true);
  // 改动了什么要说出来：分叉（表分了、数据没复制）与删除（那一份真的没了）
  //   都是别的屏幕上才看得见的变化，不说的话界面上一切正常。
  const said = [];
  if (r.forked) {
    said.push(`已经给这条连接分了一张自己的表（「${r.forked}」）。`
      + '从现在起它和其他连接各改各的，里面的数据还是同一份，一个字节都没复制。');
  }
  said.push('换好了。下一次开会话时，这个插件就用新的那一份数据。');
  if (r.droppedOld) {
    said.push('旧的那一份数据没有其他工作区在用，已经删掉，找不回来。');
  }
  notice('info', said.join(' '));
  return { ok: true };
}

/**
 * 改一张被几条连接共用的引用表之前的那一问：一起改，还是先分一张自己的。
 *
 * 判定权在主进程（它才知道那张表现在有几条连接在用），这里只负责问。
 * 名字在这里取（`connLabel`）而不是让主进程拼：备注/地址的回落规则只有一条，
 *   主进程再拼一遍就是同一条规矩的第二份实现。
 *
 * @param {string[]} others 除这条连接以外，还在用那张表的连接 id
 * @returns {Promise<'all'|'fork'|null>} null = 用户取消（含 Esc）
 */
function askFork(wsName, others) {
  const dlg = $('fork-dlg');
  // 兜底：模板里少了这个对话框时不猜，直接当作取消（界面上那一格会弹回去）。
  if (!dlg) return Promise.resolve(null);
  $('fork-body').textContent =
    `「${wsName}」这张表还有 ${others.length} 条连接在用：`
    // 用 `connLabel`（带端口）而不是 `connName`：同一台机器上两条连接的区别
    //   往往就在端口或账号上，这里正是要用户认出"还有谁"的地方。
    + `${others.map((cid) => { const c = connById(cid); return c ? connLabel(c) : '另一条连接'; })
      .join('、')}。\n\n`
    + '「全部一起改」：它们跟着一起变。\n'
    + '「只改这条连接」：先给这条连接分一张自己的表，分出来的表一开始与现在这张'
    + '完全相同，之后各改各的。数据还是同一份，不会复制。';
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

/**
 * 每个插件此刻在这台电脑上占着几个名额。
 *
 * 判据只有一条：会话视图里还活着的那几条，按插件 id 归并。id 取服务端给的
 *   解析键（`snap.servicePlugin`，形如 `<id>@<版本>`）的前缀 —— 服务端的配额
 *   也按 id 数（站点升级之后，旧版本那条会话仍然占着这个名额），而本机认不出
 *   的插件同样数得进去。取不出 id 的会话不数：少报的方向是安全的。
 *
 * 它只数这台电脑手上的记录。别的电脑上的会话不在这一份视图里，于是这里会少报
 *   —— 那种情况下按钮仍然亮着、点下去由服务端拒（服务端那句话带着当下的个数），
 *   与本轮之前的行为相同。多报才会把能提交的时刻说成不能，而那一种在这里不会发生。
 */
function pluginActiveCount() {
  const out = new Map();
  for (const s of SESS.sessions) {
    if (!s || !s.live) continue;
    const ref = s.snap && typeof s.snap.servicePlugin === 'string'
      ? s.snap.servicePlugin : null;
    const at = ref ? ref.lastIndexOf('@') : -1;
    if (at <= 0) continue;
    const id = ref.slice(0, at);
    out.set(id, (out.get(id) || 0) + 1);
  }
  return out;
}

/**
 * 把某一块的「名额」那一行与「开始会话」改成"现在还能不能开"的样子。
 *
 * 到上限时那句话换成「这台电脑上已经有 N 个（上限 M）」并加 `.warn`，按钮一起
 *   灰掉 —— 这是把服务端要说的话说到前面（它回的是 `4 quota_active` 加当下的
 *   个数）。不到上限就回到只读的上限那一句。
 *
 * `counts` 由 `syncPluginQuota` 一次算好传进来：逐块各算一遍的话，同一个问题
 *   在这几块之间会有 N 份答案，而它们迟早不同步。
 */
function applyPluginQuota(id, counts) {
  const cell = quotaCells.get(id);
  if (!cell) return;
  const n = (counts || pluginActiveCount()).get(id) || 0;
  const full = n >= cell.max;
  cell.line.textContent = full
    ? `这台电脑上已经有 ${n} 个（上限 ${cell.max}）`
    : `最多同时 ${cell.max} 个会话`;
  cell.line.classList.toggle('warn', full);
  // 本来就不能起的那颗按钮（`runnable` 为假）不在这里动：它灰着的理由与名额
  //   无关，而 title 上那句才是用户该看的。
  if (!cell.runnable) return;
  cell.btn.disabled = full;
  cell.btn.title = full
    ? `这个插件上已经到本站上限（${cell.max} 个）：结束一个再开下一个。`
    : '';
}

/** 会话表一变就重算一遍名额（就地改两格，不重画整块）。 */
function syncPluginQuota() {
  if (!quotaCells.size) return;
  const counts = pluginActiveCount();
  for (const id of quotaCells.keys()) applyPluginQuota(id, counts);
}

function pluginBlock(p) {
  // 本机插件：站点说有它、但没有作业侧，而客户端给了本机入口。
  //   它与「起不来」是两件事，所以不进 `plug-off`，也不画资源选项与名额。
  const localBlock = Boolean(p.hasLocalEntry) && !p.canSubmit;
  const d = document.createElement('div');
  d.className = 'plug' + (p.runnable ? '' : ' plug-off');

  // ── 第一行：这是哪个插件 ──
  //   id 与版本都要露出来：池里可以并存同一个插件的多个版本（站点更新频繁、
  //   也可能拒绝更新），只显示名字的话用户分不清自己看到的是哪一版。
  // 标题占满左半边、id 与版本钉在右端（见 app.css 的 `.plug-head`）：它们跟着标题
  //   长短左右滑动的话，同一个插件在不同站点上就长得不一样，而这几行是拿来比对
  //   一眼的 —— 位置定了才比得出来。
  const head = document.createElement('div');
  head.className = 'plug-head';
  head.append(el('h3', null, p.title));
  head.append(el('code', 'plug-id', p.name));
  head.append(el('span', 'plug-ver', 'v' + p.version));
  // 不贴来源标签（"站点分发" / "本机安装"）：池只剩一个，每一块都是站点
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

  // 时限与资源同一句话：它们回答的是同一个问题（"这个插件缺省给多少"），
  //   而站点也是在同一格 `defaults` 里报的。单开一句的话，"默认"这件事在界面上
  //   就有了两个出处，而它们迟早会说不一样的话。
  //
  // `def.time` 缺席不算否（老守护进程的 `defaults` 里没有这一格，见
  //   backend-fake 的 `_noDistribute` 那一档）：缺了就不说，而不是显示
  //   "undefined" 或"0"。这与本页其它每一处三态是同一条纪律。
  // 卡那一格由主进程译好（`defaultsGresText`，走 `gres.js`）—— 与下面
  //   `renderKv` 里那一行同一条路子。渲染层不拼 `name:type × n`：那是第二个拼法。
  const def = p.defaults;
  // 本机插件不提交作业，站点给的默认资源与它无关；印出来会让人以为它会占资源。
  if (!localBlock) {
    meta.append(el('span', null, def
      ? `默认 ${def.cpus} 核 / ${def.mem}${def.time ? ` / ${def.time}` : ''}`
        + (p.defaultsGresText ? ` / ${p.defaultsGresText}` : '')
      : '默认资源由服务端定'));
  }

  // 站点给这个插件设的并发上限。与上面那句同一类事实（管理员设的政策，
  //   用户改不了），所以并排只读地摆着。
  //
  // 到上限时这一行换成「这台电脑上已经有 N 个（上限 M）」、按钮一起灰掉 ——
  //   那句话是把服务端要说的话说到前面（它回 `4 quota_active` 加当下的个数）。
  //   数只数这台电脑手里的会话，见 `pluginActiveCount`：少报不会把能提交的时刻
  //   说成不能，多报才会。
  // 缺席（老守护进程报不出这一格）就不说：`null` 与"上限是 1"必须分得开。
  let quotaLine = null;
  if (!localBlock && typeof p.maxSessions === 'number') {
    quotaLine = el('span', null, `最多同时 ${p.maxSessions} 个会话`);
    meta.append(quotaLine);
  }

  // 本机开关。它能点，是因为"本机要不要"是用户自己的决定，与站点无关。
  const lab = document.createElement('label');
  lab.className = 'plug-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = p.locallyEnabled !== false;
  cb.onchange = async () => {
    cb.disabled = true;
    try {
      // 按 id 提交，不按短名：池是全局的，两个站点可以各有一个叫
      //   `jupyter` 的插件而它们是两个不同的东西。
      const r = await window.slurmate.setPluginEnabled(p.id, cb.checked);
      if (r && r.ok) renderPlugins(r.plugins);
      else notice('error', (r && r.error) || '未能保存这个开关。');
    } finally {
      cb.disabled = false;
    }
  };
  lab.append(cb);
  lab.append(document.createTextNode('本机启用'));
  meta.append(lab);

  d.append(meta);

  // ── 起不来的原因（或本机插件的说明）：一句话说清 ──
  if (localBlock) {
    d.append(el('p', 'why',
      '这个插件没有作业侧，只在本机运行：不提交作业、不占集群配额。'));
  } else if (!p.runnable) {
    d.append(el('p', 'why', whyNotRunnable(p)));
  } else if (p.siteEnabled && p.siteVersion && p.siteVersion !== p.version) {
    // 两半代码是配套的，版本对不上要说在前面。不说的话用户看到的是
    //   "作业起来了但界面一片白"，而根因一个字都不在里面。
    d.append(el('p', 'why',
      `站点用的是 ${p.siteVersion} 版，而本机这一份是 ${p.version} 版。`
      + '会话仍然起得来，但界面可能连不上，升级客户端通常就好了。'));
  }

  // ── 这个插件用哪一份数据 ──
  //
  // 只画给真的有一份数据的插件（`p.ports > 0`，清单里那一格）：0 个端口的
  //   插件没有存储、没有端口、没有那一格，画一个空下拉等于凭空许诺一个不存在的东西。
  // 它在按钮之前：那一格决定的是"按下去会用哪一份数据"，先看得见再按。
  if (p.ports > 0) {
    const row = pluginSpaceRow(p);
    if (row) d.append(row);
  }

  // ── 这一块自己的高级选项 ──
  //
  // 它从前是全屏共用的一份（panel.html 里那个 `#adv`），长在第二屏最底下
  //   —— 而它喂的是某一块的「开始会话」。三四个插件并排时，用户看不出"我填的
  //   这 4 核是给谁的"（那正是"语义不清晰"那句话）。现在一块一份，而且画在
  //   这一块的「开始会话」之前：先看得见、再按。
  // 只给起得来的那些画（`p.runnable`）：一颗灰着的「开始会话」不需要资源，
  //   而填了也用不上 —— 摆在那里等于说"这一块能起"。
  let adv = null;
  if (p.runnable && !localBlock) {
    // 站点那份默认要传下去：那三格滑块停在它上面，而它是站点按插件定的
    //   （`plugins` 那一 op 的 `defaults`），不是客户端写死的数。
    const a = pluginAdv(p.defaults);
    adv = a.st;
    d.append(a.box);
  }

  // ── 动作区：这一块要按的东西都在这一行里 ──
  //
  // 从前没有这一行：「开始会话」直接挂在块上，两颗删除复用了事实行的 `.plug-meta`
  //   —— 于是三颗按钮上下紧贴，而"挤在一起"正是用户报的那一句。自成一个 class 之后
  //   间距由容器给，往后再加一颗也不会挤到谁（事实行那一行也不再多一份职责）。
  const actions = document.createElement('div');
  actions.className = 'plug-actions';

  const btn = document.createElement('button');
  btn.textContent = localBlock ? '在本机打开' : '开始会话';
  btn.disabled = !p.runnable;
  // 交出去的是这一块那一份（`adv`），不是"界面上当前那份" —— 见 pluginAdv。
  btn.onclick = () => startWith(p.name, adv, btn);
  actions.append(btn);

  // 名额那一行与这颗按钮一起登记：会话表一变，`syncPluginQuota` 就地改这两格。
  if (quotaLine) {
    quotaCells.set(p.id, {
      line: quotaLine, btn, max: p.maxSessions, runnable: Boolean(p.runnable),
    });
    applyPluginQuota(p.id);
  }

  // ── 两颗删除：本机那一份，以及站点上那一棵 ──
  //
  // 它们是两件事，各有各的入口，而这不是实现细节，是设计：
  //
  //   · 「删掉本机这一份」删的是池里那一份，等于撤回同意（§5.3）。下一次对账
  //     （连上、或者点「重新同步」）站点还在分发它，于是重新下来、重新问一遍。
  //     这一颗两端都有 —— 真站点、假站点一模一样。
  //   · 「从站点撤掉」是管理员在真站点上敲的那条 `slurmate plugin uninstall`，
  //     只在假站点上存在（判据是主进程给的能力位，与「安装插件…」同一格）。
  //     它不动本机那一份：站点上有没有那一棵树，与本机装没装它，是两件事。
  //
  // 两颗都走两段式：删本机那份等于撤回同意（下一次要重新问），而撤站点那份之后
  //   "我其实只是想关掉它"没有退路 —— 关掉是左边那个「本机启用」开关。
  //   这是六处两段式里的两处（同一块上并排，各自第一段）。
  const drop = button('删掉本机这一份', null, 'ghost');
  drop.title = '删掉本机这一份，等于撤回同意：站点还在分发它时，下一次同步会重新'
    + '下来、重新问你一次。站点上那一份不受影响。';
  drop.onclick = () => armConfirm(drop, {
    why: `删掉本机那一份「${p.title}」？站点上那一份不受影响，`
      + '下一次同步会重新下来、重新问你一次。',
    yes: '删掉',
    run: () => dropPluginVersion(p.id, p.version),
  });
  actions.append(drop);
  d.append(actions);
  return d;
}

function issueBox(kind, head, body) {
  const d = document.createElement('div');
  d.className = 'issue ' + kind;
  d.append(el('span', 'h', head + '：'));
  d.append(document.createTextNode(body));
  return d;
}

/**
 * 一组"没加载上"的话，收在一个能展开的框里。
 *
 * 它们不阻塞任何操作（守护进程照常跑，其余插件照常工作），而一字排开摆在插件
 *   列表头上，读起来像"这个客户端坏了"。收起来只留一行抬头，要看是哪几个就点开
 *   —— 这与不显示是两回事：抬头一直在，而少了哪一个点开就查得到。
 * 每一条仍然原样是站点报下来的那句话（含它自己的路径），一个字不改写：那些句子
 *   是守护进程按当下的诊断算出来的，这里重写就是造第二份会漂的真相。
 */
function issueFold(kind, head, list) {
  const d = document.createElement('details');
  d.className = `issue issue-fold ${kind}`;
  d.append(el('summary', null, head));
  const body = document.createElement('div');
  body.className = 'issue-body';
  for (const one of list) body.append(document.createTextNode(one + '\n'));
  d.append(body);
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
 * `serviceKind` 传的是本站的短名（块标题旁边那个）。主进程按它在本机找到
 *   对应那一份插件 —— 池里可能并存同一个插件的多个版本，取版本最高的。
 *
 * 高级选项里只带上真正填了的键。留空 = 让服务端用它的默认值 —— 客户端不
 *   自己编默认值，否则默认值就成了两份真相：界面显示 2 核 / 8G，而实际拿到的是
 *   别的，且没有任何地方会为此报错。默认资源是管理员的策略，不是用户偏好。
 *
 * 那几格读的是传进来的 `adv` —— 按下去那一块自己的那一份（见 `pluginAdv`）。
 *   从前它们按 id 去捞（`#f-cpus` / `#f-gres` 那一套），而那时全屏只有一份；现在每一块一份，
 *   按 id 捞会读到第一块填的值，症状是"我给甲填的 8 核，起来的是乙"。
 *
 * @param {object} adv 那一块那几格（`pluginAdv()` 返回的 `st`）
 * @param {object} btn 那一块的「开始会话」那颗按钮（只用来按下去时禁用一下）
 * @param {object} [opts] `portChoice` = 用户在「端口被占」那一行上答过的：
 *   `'shift'`（「启动」，只换这一次）或 `'remember'`（「记住并启动」，主进程
 *   在绑定成功之后把新端口记进配置）。把同一趟重发一次，见 `renderPortAsk`。
 */
async function startWith(serviceKind, adv, btn, opts = {}) {
  // 上一次那一问先收掉：这一趟给出的答案会取代它（重发的那一趟自己会走完同一条路，
  // 真又被挡就再摆一次）。留着的话，两行"要不要临时换"会同时挂在界面上。
  clearPortAsk();
  btn.disabled = true;
  notice('info', '正在提交会话…');
  try {
    const res = {};
    const cpus = adv.cpus.value.trim();
    const mem = adv.mem.value.trim();
    const part = adv.part.value;
    if (cpus) res.cpus = Number(cpus);
    if (mem) res.mem = mem;
    if (part) res.partition = part;
    // GRES：选了名字才发。数量是必填的 —— 发一个没有数量的 GRES 等于让服务端
    // 去猜要几个，而服务端不猜（它只校验与钳制），回一句"不合法"才是对的。
    // 描述符按序号取回（选项的 value 就是那一块的 `curGres` 的下标）：
    //   不从 option 的文字里再拆一遍 `gpu:a100` —— 那等于在客户端再造一个语法解析器。
    const gi = adv.gres.value;
    if (gi === 'none') {
      // 显式「不占」发的是 `null`，与"没碰这一项"（不发这个键）不是同一件事：
      //   后者让服务端用那个插件的默认卡，前者盖过它。见 renderGresFor 那段。
      res.gres = null;
    } else if (gi !== '') {
      const e = adv.curGres[Number(gi)];
      const n = Number(adv.gresN.value);
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

    const r = await window.slurmate.start(res, serviceKind, opts.portChoice || null);
    if (r && r.sessions) renderSessions({ sessions: r.sessions, front: r.front });
    // 首选端口被占着：什么都没提交，摆出那一行二选一等着答。
    //    它必须排在下面那条"失败就刷新清单"之前 —— 这一支不是失败，插件清单
    //    一个字都没变，而去问一次 `app:partitions` 只是白花一趟往返。
    if (r && r.code === 'port_conflict') {
      return renderPortAsk(r, { serviceKind, adv, btn });
    }
    // 提交失败（比如版本对不上被服务端拒了）时把清单刷新一遍 —— 那句话要落到
    // 界面上，不能只在日志里。
    if (r && !r.ok) {
      const pv = await window.slurmate.partitions();
      if (pv && pv.plugins) renderPlugins(pv.plugins);
    }
    // 提交成功：这一份填写已经用掉了，当场收起、退回默认（用户 2026-10-30）。
    //   它只对下一次「开始会话」有效，而那句话就写在这几格下面 —— 留着不收，
    //   用户从会话页面点「面板」回来看到的仍是开着、填着值的那几格。
    if (r && r.ok) adv.collapse();
  } finally {
    btn.disabled = false;
  }
}

// ── 最近作业（`sacct`，按需拉）─────────────────────────────────────────────
//
// 它不在站点状态那一块里。从前它挂在整个「集群状态」屏的底下，而那是
//   一张作业的表 —— 站点状态回答的是"这台集群现在怎么样"，这张表回答的是
//   "我最近跑过什么"。两者唯一的共同点是都要向控制节点问一次，而那不足以让它们
//   住在一起（见浮窗那一侧的注释）。
//
// 它是按需拉的，绝不跟着别的东西一起刷。它是这一组里最贵的一条查询：
//   守护进程是单线程同步的，`op_history` 会同步 fork `sacct`（最长 20 秒）
//   阻塞整个 daemon —— 所有会话的 tick 都停在那儿。所以它只有一个入口：那个按钮。
async function loadHistory() {
  const box = $('history-body');
  box.textContent = '';
  box.append(cel('p', 'sub', '读取中…'));
  const r = await window.slurmate.history();
  box.textContent = '';
  if (!r || !r.ok) {
    const detail = (r && r.error && r.error.detail) || '控制节点没有说明原因';
    // 这里是错误，不是空列表 —— 空列表的意思是"你这几天没有作业"，
    //   而那是完全不同的两句话。
    box.append(cel('p', 'bad', `获取作业历史失败：${detail}`));
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
    // 作业名：一排作业号里认不出哪个是哪个，而这是 `sacct` 已有的那一格
    //   （提交时那个 `-J`，没给就是脚本名）。
    row.append(cel('span', 'dim', `  ${j.name || '（没有名字）'}`));
    row.append(cel('span', 'dim', historyLine(j)));
    box.append(row);
  }
}

/**
 * 最近作业那一行里，「还没结束」与「已经结束」要分开印。
 *
 * `sacct` 对没结束的作业给的是 `ExitCode=0:0` 与 `End=Unknown` —— 两个都是
 *   "还没有这个数"，不是"这个数是 0"、也不是"结束在一个叫 Unknown 的时刻"。
 *   照原样印出来，一条正在跑的作业会写着「退出码 0:0 … Unknown」（真机
 *   2026-10-16 那一屏就是这样），而那是这个界面在替 Slurm 说一句不成立的话。
 * 判据是 `End` 是不是一个真时间戳，不是猜状态名：状态名各集群不同
 *   （`RUNNING` / `PENDING` / `COMPLETING`…），而"有没有结束时刻"是同一个
 *   问题的直接答案，且 `sacct -P` 给的就是它。
 * `跑了` 那一格两边都印：对没结束的作业它的意思是"到此刻跑了多久"，而那是
 *   用户真正在问的那个数。
 */
function historyLine(j) {
  const ended = Boolean(j.end) && j.end !== 'Unknown' && j.end !== 'N/A';
  const bits = [j.state || '?', ended ? `退出码 ${j.exit_code}` : '还没结束'];
  bits.push(`跑了 ${j.elapsed}`, j.partition || '?');
  if (ended) bits.push(j.end);
  return '  ' + bits.join('　');
}

// ── 第三屏：作业列表 ────────────────────────────────────────────────────────
//
// 这一屏的数据来自服务端（`op:list`，经 index.js 的 `jobsView()`），
//   不是本机那张会话表。两者在正常情况下一样，差在三种真的会发生的场合：
//   上一台电脑提交的、本机认不出插件因而没接上的、刚结束而服务端还留着那一行的。
//   只画本机那一份，这三种里用户看到的都是"我没有作业了" —— 而作业还在。
//
// 而动作只给本机接着的那些（`attached`）：结束走的是 `SessionController.stop()`，
//   它要心跳、要隧道、要那条会话的完整视图。给没接着的另写一条短路，就是同一条
//   规矩的第二份实现。没接着的那些照实说出来，出路是重连一次。

/**
 * 重新问一次服务端（`op:list`），顺带把本机那几条会话的视图也重取一份。
 *
 * 它不是缓存刷新，是一次真查询。作业列表的变化有一大半发生在本进程之外
 *   （另一台电脑提交的、CLI 提交的、排队中的作业被调度器跑起来），所以它必须
 *   能随时重问 —— 「刷新」那个按钮存在的理由就是这个，而不是装饰。
 *
 * 详情那一块还有一半来自本机的会话视图（隧道、本地地址、上次心跳只有本机有），
 *   而那一份只在状态真的变过时才推过来。不跟着重取的话，这一颗只换列表：行上的
 *   作业状态更新了，下面那一块还是上一次推送的样子，要再点一次「面板」才看得见
 *   （用户 2026-10-30）。那一趟是本机的 IPC，不向站点多问一次。
 */
async function refreshJobs() {
  const connId = boot ? boot.activeConnectionId : null;
  $('jobs-when').textContent = '读取中…';
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
  // 先记下这一份的活会话集合再交给 `renderSessions`：它自己会在集合变过时再排
  //   一轮 `refreshJobs`，而那一轮问的正是我们手上这一份 —— 不记就多问站点一次。
  const st = await window.slurmate.states();
  if (st && Array.isArray(st.sessions)) {
    lastLiveIds = st.sessions.filter((x) => x.live)
      .map((x) => x.slot).sort().join(',');
    renderSessions(st);
  }
  renderJobs();
}

/** 选中的那一行（没有就是 null）。 */
function selectedJob() {
  return (JOBS.list || []).find((j) => j.session_id === JOBS.selected) || null;
}

/**
 * 点某一行：只换选中的那一条（高亮与下面的详情跟着走），不换页面。
 *
 * 切页面只在上栏的标签上做（用户 2026-10-18：在作业那一页点一条正在跑的作业
 *   会直接跳进它的页面 —— 那一跳之后上栏的按钮就没机会点了；这一页的选中
 *   本来只是"看它的信息"）。
 * 详情从这一条自己的快照取（`renderJobDetail`），不是"前台的" —— 选中不再
 *   改前台，而"选中 A、详情里却是 B"正是要避免的那一格。
 */
function selectJob(j) {
  JOBS.selected = j.session_id;
  renderJobs();
}

function jobRow(j) {
  const li = document.createElement('li');
  li.className = 'job'
    + (j.live ? '' : ' dead')
    + (j.attached ? '' : ' detached')
    + (j.session_id === JOBS.selected ? ' on' : '');

  // 服务名 —— 本机认不出这个插件时照实说，不编一个名字。
  // （认得出才有名字：判据在主进程的 `registry.resolve`，不在这一层。）
  li.append(cel('span', 't', j.service || '（本机没有这个插件）'));
  li.append(cel('span', 'st', j.state_text || j.state || '—'));

  const bits = [];
  if (j.job_id) bits.push(`作业 ${j.job_id}`);
  if (j.partition) bits.push(j.partition);
  if (j.node) bits.push(j.node);
  if (j.live && j.expires_at) bits.push('剩余 ' + fmtLeft(j.expires_at));
  li.append(cel('span', 'm', bits.join(' · ') || '—'));

  // 「谁在看」——三句话三件事（见 index.js 的 jobsView），不是"是不是本机"。
  // 而它只在还活着的会话上说得通：一条已经结束的会话没有"谁在看"。
  if (j.keeper_text) {
    li.append(cel('span', 'kp' + (j.keeper_is_me ? ' good' : ''), j.keeper_text));
  }
  // 没接着的必须说出来：这一行的动作按钮是灰的，而"为什么点不动"不能靠猜。
  //   出路是重连一次（`doConnect` 会跑 `tryReattach`），不是在这里再造一个入口。
  if (j.live && !j.attached) {
    li.append(cel('span', 'warn', '本机没接着它，重连一次这个站点就会接上'));
  }

  li.onclick = () => selectJob(j);
  return li;
}

function renderJobs() {
  const rows = JOBS.list || [];
  const err = $('jobs-error');

  // 三态：获取失败（`list === null`）与确实没有（`list === []`）必须
  //   长得不一样。把"问不到"画成"没有作业"，用户会以为自己的作业丢了 ——
  //   而真正的原因在连接那一侧。
  err.classList.toggle('hidden', !JOBS.error);
  if (JOBS.error) err.textContent = `获取作业列表失败：${JOBS.error}`;
  $('jobs-when').textContent = JOBS.at
    ? `这个站点上的作业（${fmtAge(Date.now() - JOBS.at)}前取的）。`
    : '';

  // 先定选中的是谁，再画 —— 反过来的话，这一轮刚选中的那一行不带 `.on`，
  //   而用户看到的是"点了没反应"。
  //
  //   默认顺序：用户刚点的那条还在就留着 → 前台那一条 → 第一条活着且本机接着的
  //   → 第一行。第一个条件不能省：省了的话每刷一次列表就把用户的选择冲掉。
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
  // 选中变了，下面那一块就要跟着换（否则高亮的是 A、详情里还是 B）。
  //   日志是同一件事的另一半：它是按需取的，所以只在本来就开着时重取。
  syncJobLog();
  renderJobDetail(frontSnap());
}

/**
 * 三个动作按钮的可用性与提示。
 *
 * 「接管」的判据是「看护者不是本机」，不再要求本机已经接着它 —— 2026-10-20 起
 *   连上站点不会再把别人在看的、或者没人看的会话接回来（只保活），于是
 *   「接管」正是把它们接回来的唯一入口。本机已经在看它时禁用：那一次空动作
 *   成功之后会回一句"已接管"，用户会以为刚才发生了什么。
 *
 * 「结束」与「重新加载」仍要求本机接着它：它们要的是这条会话的完整视图
 *   与本地记录，没接回来就没有可停的东西。没接着的那些，出路是接管。
 */
function renderJobsSelection() {
  const j = selectedJob();
  const attached = Boolean(j && j.live && j.attached);
  const canTakeover = Boolean(j && j.live) && !j.keeper_is_me;
  $('btn-jobs-end').disabled = !attached;
  $('btn-jobs-takeover').disabled = !canTakeover;
  $('btn-jobs-reload').disabled = !attached;
  $('btn-jobs-takeover').title = !j ? '先在上面点一条作业'
    : (!j.live ? '这一条已经结束了'
    : (j.keeper_is_me ? '这台电脑已经在看它了'
    : (!j.attached ? '把看护者换成这台电脑，并把它接回来（作业一个字都不动）'
    : '把这条会话的看护者换成这台电脑（作业一个字都不动）')));
  // 状态条上那一颗不跟着选中的这一条走：它只在会话页面盖着时露，停的是前台
  //   那一条（见 renderStatusEnd）。这一屏停选中的那一条，用的是它自己那颗
  //   `btn-jobs-end`。
}

/**
 * 结束某一个槽上的会话。界面里三个地方都走它（作业列表、状态条、断开）。
 *
 * 收成一份而不是各写一遍：那三处要说的话逐字相同，而其中最要紧的一句
 *   （"`releasing` 不等于作业已经停了"）漏掉任何一处，用户就会以为作业结束了
 *   而它还在烧 GPU。见 docs/ARCHITECTURE.md 的 §3.0。
 */
async function stopSlot(slot) {
  if (!slot) return null;
  const res = await window.slurmate.stop(slot);
  if (res && res.ok) {
    notice('info', res.detail || '已请求释放。');
    if (res.state === 'releasing') {
      notice('warn', '已请求释放。这表示控制节点开始处理了，'
        + '请以状态变成「已结束」为准。');
    }
  } else if (res) {
    notice('error', res.detail || '释放失败。');
  }
  return res;
}

/** 【结束】：结束选中的那一条。 */
async function endSelectedJob() {
  const j = selectedJob();
  if (!j || !j.attached || !j.slot) {
    return notice('error', '先在列表里点一条本机接着的作业。');
  }
  await stopSlot(j.slot);
  refreshJobs();
}

/** 状态条上那颗「停止该作业」—— 停掉前台那一条（跑起来之后那 30px 是唯一够得着的）。 */
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
    // `no_client_id` 这一条必须单独说：它指的是"这次连接没有自报身份"，
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

// ── 分区与高级选项（每一块自己一份）──────────────────────────────────────
//
// 这几格从前是全屏共用的一份（panel.html 里那个 `#adv`），长在第二屏最底下
//   —— 而它喂的是某一块的「开始会话」。现在它画在那一块里（见 `pluginAdv`），
//   一块一份。语义一个字没改：只对下一次「开始会话」有效、不记住、关掉窗口回默认
//   （唯一例外仍是作业没结束时的闪断重连沿用）。
//
// 分区表（`partList`）仍然是全局一份 —— 它是站点级的，与是哪个插件无关。
//   如实的代价：分区那一格会在每一块里各画一份（同一个事实的 N 个选择器）。这是拿
//   "同一件事不许摆两处"换来的（那一格若留在公共区域，就又是"我填的是给谁的"）。
//   记在 CHANGELOG 里。

/** 最近一次拿到的分区表（含每个分区的 GRES 清单）。换分区时要拿它重画 GRES。 */
let partList = [];

/**
 * 这一屏上活着的那些块的那几格（`renderPlugins` 每重画一次就整个换一批）。
 *
 * 为什么要有一份名单：分区表是站点级的，它到得比插件块早、也可能中途变
 *   （连上站点时、提交失败之后都会重取一次）—— 那时得把每一块里那一格都跟着
 *   换掉。名单换来的是"每块各留一个引用"：按 id 去捞那几格（`#f-part` 那种写法）
 *   在这里必然错 —— 同一个 id 出现 N 次时 `getElementById` 只认第一个，
 *   第 2 块往后那几格从此再也读不到、也改不动，而它们看起来完全正常。
 */
let advCells = [];

/**
 * 每一块里「名额」那一行与那颗「开始会话」的引用（id → 两格）。
 *
 * 它与 `advCells` 一起在 `renderPlugins` 里换一批：会话表一变，`syncPluginQuota`
 *   就地改这两格，而不是把整块列表重画一遍 —— 重画会把用户填了一半的高级选项
 *   清掉（`renderPlugins` 那道指纹防的正是这件事）。
 */
const quotaCells = new Map();

/**
 * 「CPU 核数」那一格在站点没报 `cpus_per_node` 时的退路。
 *
 * 真正的上限来自分区（`op_partitions` 的 `cpus_per_node`）：各分区的节点核数
 *   不一样，写死一个数总会在某一边错 —— 写小了把合法请求拦住，写大了让用户
 *   填一个那台节点给不出的数。这个常量只在旧站点或查询失败时兜底。
 * 它必须不超过守护进程的 `MAX_CPUS_REQUEST`（那道绝对护栏），由
 *   `test/limits.test.mjs` 盯着。
 */
const UI_MAX_CPUS = 64;

/** 一个整数写法 → 整数；认不出给 `null`。 */
function intOf(s) {
  const n = Number(String(s).trim());
  return Number.isInteger(n) ? n : null;
}

/**
 * CPU 那一格的档位：从 1 到 `ceil`。
 *
 * 用户点名的形状：1、2、4、8、12、16、20、24，之后每 4 一档，最后是顶本身。
 *   它不是一条连续的尺子 —— 核数是按"能开几个进程"要的，中间那些数没有人要。
 * 顶本身必须进表：78 核的节点只到 76 的话，这个分区能要到的最大值就选不到。
 * 站点那份默认值不在表上时由调用方插进去（见 `applyCpuRange`）：滑块停不到
 *   那个数上的话，问题就不是"档位合不合理"，而是"站点说的默认它指不出来"。
 */
function cpuLadder(ceil) {
  const out = [1, 2, 4, 8, 12, 16, 20, 24].filter((n) => n <= ceil);
  for (let n = 28; n <= ceil; n += 4) out.push(n);
  if (out[out.length - 1] !== ceil) out.push(ceil);
  return out;
}

/**
 * 内存那种写法（`8G` / `512M` / `8192M`）→ MB；认不出给 `null`。
 *
 * 与守护进程的 `sanitize_mem` 同一套写法（裸数字的单位是 MB，那是 Slurm 的规矩：
 *   `--mem=8` 是 8 MB），所以这里必须先认单位再换算。
 */
function memMbOf(s) {
  const m = /^([0-9]+)([KMGTP]?)$/.exec(String(s == null ? '' : s).trim().toUpperCase());
  if (!m) return null;
  const per = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024, P: 1024 * 1024 * 1024 }[m[2] || 'M'];
  const mb = Number(m[1]) * per;
  return Number.isInteger(mb) ? mb : null;
}

/** 内存那种写法 → 整 GB；不是整 GB（`512M`）给 `null`。滑块只走整 GB。 */
function memGbOf(s) {
  const mb = memMbOf(s);
  return (mb !== null && mb % 1024 === 0) ? mb / 1024 : null;
}

/**
 * 这一格的核数上限：指定分区用它自己的，随机时取有权限分区里的最大值。
 *
 * 随机取最大值而不是最小值：用户说的是"随便挑一个分区"，挑中的那个由服务端
 *   从装得下这个请求的分区里选（`fit_resources()`），所以最大值要得到。
 * 只算 `allowed` 的分区：无权限的永远不会被挑中。
 * `null` = 这一格没有可用的上限（旧站点、或者查询失败），调用方退回
 *   `UI_MAX_CPUS`。
 */
function cpuCeilingFor(partName) {
  if (partName) {
    const p = partList.find((x) => x.name === partName);
    const n = p && p.cpus_per_node;
    return (Number.isInteger(n) && n >= 1) ? n : null;
  }
  let best = null;
  for (const p of partList) {
    if (!p.allowed || !Number.isInteger(p.cpus_per_node) || p.cpus_per_node < 1) {
      continue;
    }
    best = best === null ? p.cpus_per_node : Math.max(best, p.cpus_per_node);
  }
  return best;
}

/**
 * 这一格的内存上限（整 GB）；`null` = 这一格没有可用的上限。
 *
 * 向下取整：节点报 191000 MB（186.5 GB）时顶就是 186 —— 一个整数滑块要不到那半
 *   个 GB，而报 187 是一个这台机器上不存在的数。
 * 没挑分区时取有权限分区里的最大值：理由与 `cpuCeilingFor` 同一条 ——
 *   服务端只从装得下这个请求的分区里挑。
 */
function memCeilingGb(partName) {
  if (partName) {
    const p = partList.find((x) => x.name === partName);
    const mb = p && p.mem_per_node_mb;
    if (!Number.isInteger(mb) || mb < 1024) return null;
    return Math.floor(mb / 1024);
  }
  let best = null;
  for (const p of partList) {
    if (!p.allowed) continue;
    const mb = p.mem_per_node_mb;
    if (!Number.isInteger(mb) || mb < 1024) continue;
    const gb = Math.floor(mb / 1024);
    best = best === null ? gb : Math.max(best, gb);
  }
  return best;
}

/**
 * 给一格装一条滑块。
 *
 * 装了滑块的格子就不再摆那个输入框（控件留在 DOM 里、只是看不见）：一格里的
 *   位置是一定的，而它已经由滑块和滑块旁边那个读数说完了。框还在的写法是"你可以
 *   填一个别的数"，而档位与上限已经把能选的数限死了 —— 留一个框在那儿，等于让
 *   用户去撞一个由服务端钳制的边界。装不上滑块时才把框露出来（见下面那段）。
 *
 * 控件本身是唯一的事实来源，这一点没变：拖动就是把值写进它，提交那一侧读的仍然
 *   是它（`startWith`）。所以"留空即默认"一个字没变 —— 滑块停在默认位置不等于
 *   用户填了默认值，那要看控件里有没有字。
 *
 * 装不上就返回 `null`，调用方不画：没有档位、或者站点那份默认不在档位上（装了它
 *   也只能停在别的数上）。画一个停在错位置上的滑块比不画更坏 —— 用户会照着它
 *   按下去，而那个数不是站点说的默认。
 *
 * @param {HTMLElement} cell 这一格（读数与滑块都挂在它上面）
 * @param {HTMLElement} ctrl 这一格本来的控件（滑块把值写进它）
 * @param {number[]} values 档位（下标 → 值）
 * @param {number} dflt 站点给这一格的默认值，控件空着的时候滑块停在这
 * @param {(v:number)=>string} fmt 写回控件时的写法（内存要写成 `8G`）
 * @param {(s:string)=>number|null} parse 反过来读（用户手打之后滑块跟着挪位置）
 * @returns {HTMLInputElement|null}
 */
function attachRange(cell, ctrl, values, dflt, fmt, parse) {
  const at = (v) => (v === null || v === undefined ? -1 : values.indexOf(v));
  const i0 = at(dflt);
  if (i0 < 0) return null;
  const r = document.createElement('input');
  r.type = 'range';
  r.min = '0';
  r.max = String(values.length - 1);
  r.step = '1';
  // 读数写的就是将要发出去的那个写法（内存是 `8G`），不是另一个拼法。`startWith`
  //   读的就是这个控件的 `value`。
  const val = cell.val;
  const show = (i) => { val.textContent = fmt(values[i]); };
  // 初始位置：这一格里已经有字（用户填过、或者上一个分区留下的）就跟着它，
  //   一个字都没有才停在站点那份默认上。
  // 那个字若已经不在新档位上（换了分区、上限变小），先清掉：只挪滑块位置
  //   而不清控件的话，界面显示默认值、提交却带着那个看不见的旧数。
  const parsed = parse(ctrl.value);
  const cur = at(parsed);
  if (cur < 0 && ctrl.value.trim() !== '') ctrl.value = '';
  r.value = String(cur >= 0 ? cur : i0);
  show(Number(r.value));
  r.oninput = () => {
    const i = Number(r.value);
    ctrl.value = fmt(values[i]);
    show(i);
  };
  // 用户直接改那一格时滑块跟着挪。只挪位置，不回写 —— 手打的值优先；而打了一个
  //   不在档位上的数（CPU 写了 7）时滑块不动，它表示的仍是最近的那一档。
  ctrl.addEventListener('input', () => {
    const i = at(parse(ctrl.value));
    if (i >= 0) { r.value = String(i); show(i); }
  });
  // 回到初始位置（收起高级选项时用，见 `resetAdv`）。默认值不另存一份：
  //   `i0` 与 `show` 就是这个函数自己那份事实。
  r.reset = () => {
    ctrl.value = '';
    r.value = String(i0);
    show(i0);
  };
  ctrl.classList.add('hidden');
  cell.append(r);
  return r;
}

/**
 * 把一格还原成"只有一个输入框"的样子：框露回来，读数清空。
 *
 * "这一格装着滑块"与"没装"的分别是控件上那个 `hidden` 类 —— 只此一处，不再另记
 *   一个位：两处记同一件事迟早会对不上。
 */
function restoreCell(cell, ctrl) {
  ctrl.classList.remove('hidden');
  cell.val.textContent = '';
}

/**
 * 把一格里的滑块摘掉（上限变了、或者这一格变得用不上滑块了）。
 *
 * 摘掉就是把这一格还原成"只有一个输入框"的样子：框露出来，读数清空 —— 留着上一
 *   个分区算出来的那个数，它会读成"这一格现在的取值"，而那些档位已经不成立了。
 */
function dropRange(st, key, cell, ctrl) {
  if (st[key]) st[key].remove();
  st[key] = null;
  restoreCell(cell, ctrl);
}

/**
 * 内存那一格的滑块：顶 = 当前分区里内存最大的节点，默认 = 站点那份 `defaults.mem`。
 *
 * 它每次重判一遍，因为上限那一半会随分区变。两条判据都在这里：
 *   · 没挑分区、或者那个分区没报 `mem_per_node_mb` → 没有顶，不画；
 *   · 站点那份默认不是整 GB，或者比顶还大（换分区时会遇到）→ 不画。
 * 两种情况下那个输入框照旧在，`512M` 这种写法照旧写得进去。
 */
/**
 * CPU 那一格的滑块：顶 = 当前分区的每节点核数；随机分区取各分区的最大值。
 *
 * 每次重判：换分区、分区表刷新都要走它。站点那份默认不在档位上时插进去；
 *   默认比顶还大（站点默认是给另一种节点的）时不画，输入框留着。
 */
function applyCpuRange(st) {
  const ceil = cpuCeilingFor(st.part.value);
  const top = ceil === null ? UI_MAX_CPUS : ceil;
  st.cpus.max = String(top);
  const def = st.cpusDef;
  const ok = def !== null && def >= 1 && def <= top;
  if (!ok) {
    dropRange(st, 'cpusRange', st.cpusCell, st.cpus);
    st.cpusRangeTop = null;
    return;
  }
  if (st.cpusRange && st.cpusRangeTop === top) return;
  dropRange(st, 'cpusRange', st.cpusCell, st.cpus);
  const values = cpuLadder(top);
  if (values.indexOf(def) < 0) {
    values.push(def);
    values.sort((a, b) => a - b);
  }
  st.cpusRange = attachRange(st.cpusCell, st.cpus, values, def,
    (v) => String(v), intOf);
  st.cpusRangeTop = top;
}

function applyMemRange(st) {
  const ceil = memCeilingGb(st.part.value);
  const def = st.memDefGb;
  const ok = ceil !== null && def !== null && def >= 1 && def <= ceil;
  if (!ok) { dropRange(st, 'memRange', st.memCell, st.mem); return; }
  if (st.memRange && st.memRangeCeil === ceil) return;
  dropRange(st, 'memRange', st.memCell, st.mem);
  const values = [];
  for (let gb = 1; gb <= ceil; gb++) values.push(gb);
  st.memRange = attachRange(st.memCell, st.mem, values, def, (v) => `${v}G`, memGbOf);
  st.memRangeCeil = ceil;
}

/**
 * 数量那一格的滑块：只要下面那个下拉点名了某一张卡就画。
 *
 * 初值：插件默认卡的"默认几个"只属于它点名的那张卡 —— 选中的正是那张时停在
 *   那个数上；换了另一张卡就没有默认值（替它沿用别处的默认等于替站点定政策），
 *   停在 1。这一格本来就是必填，所以初值要写进控件：不写的话，用户点了卡、
 *   不拖滑块直接按「开始会话」会被 `startWith` 拦下。
 * 上限跟着 `applyGresMaxFor` 算出来的那一格走（`per_node_max`）。
 */
function applyCountRange(st) {
  dropRange(st, 'gresNRange', st.gresNCell, st.gresN);
  const v = st.gres.value;
  const e = (v === '' || v === 'none') ? null : st.curGres[Number(v)];
  if (!e) return;
  // 上限就是那一格数字框的上限（`per_node_max`），不另设一个 —— 两处不一样的
  //   话，滑块能拖到的数与手能填的数就不是同一件东西。
  const max = e.per_node_max;
  if (!Number.isInteger(max) || max < 1) return;
  // 初值：插件默认卡同名同型号、且数量落在上限内就用它，否则 1。
  //   点了卡却找不到"默认几个"时停 1，而不是不画 —— 这一格本来就是必填。
  const d = st.gresNDef;
  let init = 1;
  if (d && d.name === e.name && (d.type || null) === (e.type || null)
      && Number.isInteger(d.count) && d.count >= 1 && d.count <= max) {
    init = d.count;
  }
  const values = [];
  for (let n = 1; n <= max; n++) values.push(n);
  st.gresNRange = attachRange(st.gresNCell, st.gresN, values, init,
    (n) => String(n), (s) => {
      const n = Number(String(s).trim());
      return Number.isInteger(n) ? n : null;
    });
  // 这一格是"必填"：挂上滑块就把初值写进控件。不写的话，用户点了卡、
  //   不拖滑块直接按「开始会话」，会被 `startWith` 那句"选了 GRES 就要填数量"拦下。
  if (!st.gresN.value.trim()) st.gresN.value = String(init);
}

/**
 * 一块插件自己那几格高级选项。
 *
 * 它返回 `{ box, st }`：`box` 挂进那一块里，`st` 是那几格本身 —— `startWith` 读它、
 *   分区表变了的时候改它。状态挂在闭包上，不挂在 id 上。
 * 这几格跟着块一起重画（`renderPlugins` 重建所有块）：填了一半的值会在
 *   站点推一份新清单过来的时候回到空白。它与"不记住"是同一条语义的两个面，而代价
 *   如实说在 CHANGELOG 里 —— 别为了留住它去造一份"临时状态"的缓存。
 *   （`renderPlugins` 那道指纹把"清单其实没变"的那些重画挡掉了，所以今天只剩
 *   "清单真的变了"这一种情况会清掉填了一半的值。）
 *
 * 那五格是一张网格，不是一行会折的弹性盒子（见 app.css 的 `.plug-adv .row`）：
 *   弹性盒子的列宽由内容撑，于是窗口窄一点「分区」就自己掉到第二行，而掉不掉
 *   取决于那一刻每格里写着多长的字 —— 同一份内容在不同时候长得不一样。
 */
function pluginAdv(defaults) {
  const box = el('div', 'plug-adv');
  // 展开与收起由这一颗控制（2026-10-18 改：从前是 `<details>` 的 `summary`）。
  //   换了载体是为了三件事，缺一件都不行：
  //     · 只有这一行字能点。`summary` 是块级元素，整行宽度都是它的点击区；
  //       用户要的是"点这四个字"，所以它按内容定宽（见 app.css 的 `.adv-toggle`）。
  //     · 展开之后不加框、字也不变色。`details[open]` 那套样式把这一行从
  //       灰色正文变成了蓝底加粗，而那只是一句开关，不是这一块的标题。
  //     · 收起来要退回默认。那个动作落在这一颗的 `onclick` 上（见下面
  //       `resetAdv`）—— `<details>` 自己不会告诉谁"我被收起来了"。
  // 三角与这四个字是同一个文本节点：探针那条"按钮的文字被挤了"按行盒数数，
  //   而一颗装着两个孩子的按钮会数出三个矩形（两个孩子各一个，外加行盒）——
  //   那会被读成"折成了三行"。一个节点就只有一个矩形。
  const toggle = el('button', 'adv-toggle', '▸ 高级选项');
  toggle.type = 'button';
  // 读屏只读「高级选项」：那个三角是装饰，而它是这个按钮唯一的可见内容。
  toggle.setAttribute('aria-label', '高级选项');
  toggle.setAttribute('aria-expanded', 'false');
  // 那几格住在这里面：收起 = 这一层 `hidden`（`display: none`）。
  // 初值走 `classList.add` 而不是写进 `className`：展开/收起那条判据读的就是
  //   `classList`（`panel.html` 里那几处也一样），两处记同一件事会漂。
  const body = el('div', 'adv-body');
  body.classList.add('hidden');
  box.append(toggle, body);

  /**
   * 一格 = 一行标签 + 那个控件（CSP 里没有内联 style，布局一律走 class）。
   *
   * 标签那一行的右端留着一个读数（`.adv-val`）：装了滑块才写东西，写的是这一格
   *   此刻的取值（见 `attachRange`）。它空着的时候不占位置，所以没装滑块的格子里
   *   那一行与从前一样。
   * 那个读数挂在格子上（`box.val`）而不是让调用方各存一份：装滑块、摘滑块都要用它，
   *   而两处拿到的都是同一个盒子。
   */
  const field = (labelText, cell, cls) => {
    const d = document.createElement('div');
    d.className = cls ? `adv-cell ${cls}` : 'adv-cell';
    const head = el('div', 'adv-head');
    head.append(el('label', null, labelText));
    d.val = el('span', 'adv-val', '');
    head.append(d.val);
    d.append(head);
    d.append(cell);
    return d;
  };

  const st = { curGres: [] };
  const row = document.createElement('div');
  row.className = 'row';

  // 站点那份默认（`plugins` 那一 op 的 `defaults`）。三格各取自己那一半，
  //   取不到的那一半对应的滑块就不装 —— 见 `attachRange` 那一段。
  const def = defaults || null;

  // 占位符不写具体数字：默认资源按插件不同（跑 IDE 和跑中转站不是一回事），
  //   写一个数字就是在替另一个插件说话。真实默认值在这一块上面那行。
  st.cpus = document.createElement('input');
  st.cpus.type = 'number';
  st.cpus.min = '1';
  // 上限由 `applyCpuRange` 按当前分区设；这里不写死一个数。
  st.cpus.placeholder = '留空即默认';
  const cellCpus = field('CPU 核数', st.cpus);
  row.append(cellCpus);

  st.mem = document.createElement('input');
  st.mem.type = 'text';
  st.mem.placeholder = '留空即默认';
  st.mem.spellcheck = false;
  const cellMem = field('内存', st.mem);
  row.append(cellMem);

  // GRES 是两个格子：要哪一种（选项由服务端给，因为名字与型号是管理员在集群上
  // 定的）+ 要几个。这里没有卡名是写死的，也没有 `max="8"` 这种数字 ——
  // 上限来自服务端那份清单里每个节点的实际配置，"每个站点都最多 8 张卡"是一个我们
  // 无权做的假设。
  st.gres = document.createElement('select');
  row.append(field('GRES', st.gres));

  st.gresN = document.createElement('input');
  st.gresN.type = 'number';
  st.gresN.min = '1';
  st.gresN.placeholder = '—';
  st.gresN.disabled = true;
  const cellCount = field('数量', st.gresN);
  row.append(cellCount);

  // 这一格不再需要 `full` / `grow`：网格里每一格本来就占满自己那一列，
  //   而那两个类正是把「分区」整格甩到第二行的原因（见 app.css 那一段）。
  // 它自己占一整行（`wide`）：这一格的下拉里装的是分区名（没权限的那些还要接一句
  //   「（无权限）」），而它是管理员在集群上起的名字、长度我们无权假设 —— 下拉的
  //   宽度是定的，文字长了只会被切掉（切在自己盒子里，连溢出判据都看不见）。
  st.part = document.createElement('select');
  row.append(field('分区', st.part, 'wide'));

  // ── 三条滑块 ──
  //
  // CPU 那一条的顶随分区变，整条由 `applyCpuRange` 判（换分区、分区表刷新都走它）。
  st.cpusDef = (def && Number.isInteger(def.cpus)) ? def.cpus : null;
  st.cpusCell = cellCpus;
  applyCpuRange(st);

  // 内存那一格：默认那一半在这里定（是不是整 GB），上限那一半随分区变，
  //   所以整条由 `applyMemRange` 判、这里只把格子和默认值记下来。
  st.memDefGb = memGbOf(def && def.mem);
  st.memCell = cellMem;
  applyMemRange(st);

  // 数量那一格：它只在下面那个下拉点名了某一张卡之后才有意义，所以整条由
  //   `applyGresMaxFor` 那一侧判（换了卡、换了分区都要重判）。
  st.gresNDef = (def && def.gpus && Number.isInteger(def.gpus.count)) ? def.gpus : null;
  st.gresNCell = cellCount;
  applyCountRange(st);

  body.append(row);
  // 只留"看不出来"的那一句：默认值本身在读数里、"不填就取默认"也已经在操作里
  //   （没装滑块的格子上那个框的占位话写着），不必再用一句话说一遍。
  // 剩下这条是用户从这里看不出来的：它到下一次连接才生效。
  body.append(el('p', 'sub adv-note',
    '这些设置不会被记住：开始一次会话、收起它、离开这一屏，都恢复默认。'
    + '唯一的例外是作业没结束时的闪断重连，那时会沿用它。'));

  // 换分区，可选的 GRES 跟着换（上限是分区自己的：同一个集群上一种卡每节点
  // 8 张、另一种 4 张）。这里绑一次，之后由 onchange 接着画。
  st.part.onchange = () => renderGresFor(st);
  fillPartSelect(st);
  advCells.push(st);

  // 收起 = 退回默认（2026-10-18 用户点的那一条：填过、收起、再打开要恢复默认）。
  //   状态只有两档：收着 = 全是默认；展开着 = 可能填着值。三条入口都走这一条路：
  //   点这颗开关、离开插件那一屏（`showScreen`）、以及会话页面盖上来或者提交成功
  //   （`renderSnapshot` 与 `startWith`，2026-10-30）—— 不重画、不另清一遍，
  //   各处各清一遍迟早会漂开。
  const setOpen = (open) => {
    if (!open) resetAdv(st);
    body.classList.toggle('hidden', !open);
    toggle.textContent = open ? '▾ 高级选项' : '▸ 高级选项';
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.onclick = () => setOpen(body.classList.contains('hidden'));
  st.collapse = () => { if (!body.classList.contains('hidden')) setOpen(false); };
  return { box, st };
}

/**
 * 把一块的高级选项退回默认：一个字都不填，滑块停回站点那份默认。
 *
 * 只有一条入口：把这一块收起来（`pluginAdv` 里那条 `setOpen(false)`）。
 *   点那颗开关与离开插件那一屏（`showScreen` 调 `st.collapse`）都走它 ——
 *   两处各清一遍迟早会漂开。收起之后控件里的值不再留着：留着的话，它们会在
 *   下一次「开始会话」时被发出去，而界面上只剩一行收着的「高级选项」。
 *
 * 顺序是承重的：先清控件，再重画分区那一格。`fillPartSelect` 会顺着
 *   `renderGresFor` 把 GRES 打回「用插件的默认」、把数量那一格打回灰的、
 *   并把内存那条滑块按当前分区的上限重判一次。
 * 内存那条滑块单独再归位一次：上限没变的时候 `applyMemRange` 会原样留下
 *   上一条（它按"上限变了才重画"判），而它此刻还停在用户拖到的位置上。
 */
function resetAdv(st) {
  st.cpus.value = '';
  st.mem.value = '';
  st.gresN.value = '';
  if (st.cpusRange) st.cpusRange.reset();
  st.part.value = '';
  fillPartSelect(st);
  if (st.memRange) st.memRange.reset();
}

/**
 * 把一块里那个分区下拉按当前的 `partList` 重画一遍，接着重画它的 GRES。
 *
 * 保留这一块自己选着的那个：重画发生在"分区表变了"的时候，不是"用户换了分区"
 *   的时候 —— 若每次重画都把选择抹掉，用户挑好的分区会在一次后台刷新之后自己弹回
 *   "随机挑一个"。
 */
function fillPartSelect(st) {
  const sel = st.part;
  const keep = sel.value;
  sel.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '（随机选择一个有权限的）';
  sel.append(none);

  for (const p of partList) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.allowed ? p.name : `${p.name}（无权限）`;
    o.disabled = !p.allowed;
    // 禁用必须给出理由，而不是让用户猜为什么点不动
    if (!p.allowed && p.reason) o.title = p.reason;
    sel.append(o);
  }
  sel.value = keep;
  renderGresFor(st);
}

/**
 * 分区表变了：每一块里那一格都跟着换。
 *
 * 它是这张表唯一的落点（连上站点、提交失败后各调一次）—— 少了它，新拿到的分区
 *   只能等下一次重画插件块才出现，而那可能是几分钟之后。
 */
function renderPartitions(list) {
  partList = list || [];
  for (const st of advCells) fillPartSelect(st);
}

/**
 * 某个分区（或"还没挑分区"）能用哪些 GRES。
 *
 * 服务端查不到集群的 GRES 时，分区对象上根本没有 `gres` 这个键 —— 那时
 *   返回 `absent: true`，界面要把这件事说出来。否则用户读成"这台集群没有卡"，
 *   而真相是"我们没问到"。`[]` 才是"确实没有卡"。
 *
 * 没挑分区时给的是所有有权限分区的并集：不这么做，"要 2 张卡、分区随便"
 *   这句话在界面上就表达不出来 —— 而服务端是支持的（`fit_gres` 在没点名分区时
 *   在所有分区里找）。并集里同一个名字取各分区里最大的 `per_node_max`，
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

/**
 * 把一块里那个 GRES 下拉按它当前选的分区重画一遍。
 *
 * 从前它读写固定的 `#f-gres` / `#f-part`（全屏只有一份）；现在那几格住在
 *   `st` 里 —— 见 `pluginAdv` 上面那段（同一个 id 出现 N 次时只认第一个）。
 */
function renderGresFor(st) {
  const sel = st.gres;
  const { list, absent } = gresChoicesFor(st.part.value);
  st.curGres = list;
  sel.textContent = '';
  // 这里的两项不是同一件事，别合并：
  //   · `''`  = 不碰（省略这个字段），用这个插件的 `default_gpus`。
  //     站点可以在那个插件的配置里配默认卡（那是稀缺算力政策），而"不碰"就该拿到它。
  //   · `none` = 显式不占，发 `gres: null`，盖过插件的默认。
  //   少了第二项，站点的默认卡就是一道用户无法拒绝的命令 —— 而管理员拍的是
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
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const o = document.createElement('option');
    // 选项的 `value` 是它的下标，不是拼出来的字符串 —— 见 startWith 里那段。
    o.value = String(i);
    // 选项里只有卡名。上限不写在这一行：数量那一格的滑块拖到头就是上限
    //   （`per_node_max`），而"每节点最多 4 张"这句话写在宽度定死的下拉里，
    //   卡名一长就会被切掉（下拉是切在自己盒子里的，连溢出判据都看不见）。
    //   一个数由控件自己划出边界，比再写一句更准 —— 边界就在手上。
    o.textContent = e.label || e.name;
    sel.append(o);
  }
  sel.title = absent
    ? '服务端暂时无法查询这台集群的 GRES 清单（scontrol 没答上来）' : '';
  sel.value = '';
  sel.onchange = () => applyGresMaxFor(st);
  applyGresMaxFor(st);
  // 上限那一半跟着分区走，所以换分区（`fillPartSelect` 那条路）与换 GRES 都要
  //   重判一次 CPU 与内存那两格的滑块。放在这里，别处不再各调一次。
  applyCpuRange(st);
  applyMemRange(st);
}

/** GRES 的数量上限跟着这一块选中的那一项走。客户端不写死任何数字。 */
function applyGresMaxFor(st) {
  const cnt = st.gresN;
  // 只有点名了某一张卡才谈得上"要几个"：`''`（用插件的默认）与 `'none'`
  //   （不占）都不是数量问题，那两格必须是灰的。
  //   而 `Number('')` 是 0，拿它直接当下标会指到第一张卡上 —— 于是
  //     "用插件的默认"选着，数量那一格却是亮的、还挂着第一张卡的上限（一个用户
  //     看得见、却与下拉说的不是一回事的状态）。下标只有在 value 真的是个下标时
  //     才算数。
  const v = st.gres.value;
  const e = (v === '' || v === 'none') ? null : st.curGres[Number(v)];
  if (!e) {
    cnt.value = '';
    cnt.disabled = true;
    cnt.placeholder = '—';
    cnt.removeAttribute('max');
    applyCountRange(st);
    return;
  }
  cnt.disabled = false;
  cnt.placeholder = '必填';
  cnt.max = String(e.per_node_max);
  applyCountRange(st);
}

// ── 主机密钥确认 ────────────────────────────────────────────────────────────
function askHostKey(res) {
  return new Promise((resolve) => {
    const dlg = $('hostkey-dlg');
    const changed = res.code === 'host_key_changed';

    $('hk-title').textContent = changed ? '登录节点的主机密钥已改变' : '确认登录节点身份';
    $('hk-body').textContent = changed
      ? '这与上次连接时记录的不一致。可能是服务器重装过，也可能有人在中间拦截。'
        + '在查明原因之前不要继续：继续就等于把这把私钥的认证交给一个不确定的对端。'
      : '这是第一次连接到这台登录节点。请核对下面的指纹（应与集群管理员公布的一致），'
        + '确认后本机才会记住它。';
    $('hk-fp').textContent = (res.hostKey && res.hostKey.fingerprint) || '（没拿到指纹）';
    $('hk-trust').textContent = changed ? '仍然信任' : '信任此密钥';

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

/**
 * 连一个站点，用的那段时间里把发起它的那颗按钮标出来。
 *
 * 两个入口（列表行上那颗「连接」、表单里那颗「保存并连接」）走的是同一条：
 *   从点下去到出结果之间可能几秒到几十秒（主进程那边 `READY_TIMEOUT_MS` 是 20 秒），
 *   而这期间界面从前一个字都不说。用户读成"没点上"，于是再点一次。
 *   同一个站点被连两趟的后果由主进程兜着，但用户没有理由知道自己按重了。
 * 这是屋里既有的形状：探测那颗按钮写「探测中…」、密钥那把写「正在生成密钥…」。
 * 假后端的 `connect()` 不发任何 RPC，这里一闪而过；真机上这一步是 SSH 握手加一次
 *   远程查询。
 *
 * 按钮和它的原话都由调用方给：那颗按钮在两条路上不是同一个元素，而"连接中…"要
 *   画在屏幕上那一颗上。
 */
let connectingNow = false;

/** 连接在飞的那几秒里，其余入口一律灰着。
 *
 *  用户 2026-10-19 真机：第一条连接停在排队上，这时点第二条居然进去了，
 *    退出之后又连回第一条。主进程那一格是权威（`app:connect` 回 `busy`），
 *    这里让"点得动"这件事本身不再成立。 */
function lockConnectEntries() {
  for (const b of document.querySelectorAll('#conn-list button, #btn-save')) {
    if (!b.disabled) {
      b.disabled = true;
      b.dataset.lockedByConnect = '1';
    }
  }
}

function unlockConnectEntries() {
  for (const b of document.querySelectorAll('button[data-locked-by-connect]')) {
    b.disabled = false;
    delete b.dataset.lockedByConnect;
  }
}

/** 连接在飞的那几秒，按钮前面那枚小记号（样式见 app.css 的 `.mark-spin`）。
 *
 *  用动画版图标。系统开了「减少动态效果」就换静止的同一张：那条偏好要的是
 *    画面别动，而"正在连接"这件事按钮上的文字已经说清了。
 */
function spinMark() {
  const img = document.createElement('img');
  img.className = 'mark-spin';
  img.alt = '';
  // 读不到那条偏好（jsdom 里没有 `matchMedia`）就按"没有偏好"处理：
  //   为了一枚图标把整条连接路径抛停，比多播一秒动画坏得多。
  const still = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  img.src = still ? 'icon-mark.svg' : 'icon-anim.svg';
  return img;
}

/** 把一颗按钮换成「记号 + 这句话」，返回它原来那句（收尾时写回去）。 */
function busyLabel(btn, text) {
  const old = btn.textContent;
  btn.textContent = '';
  btn.append(spinMark(), text);
  return old;
}

async function connectTo(c, btn) {
  if (connectingNow) {
    return notice('info', '正在连接站点，请等这一次结束再连另一条。');
  }
  connectingNow = true;
  btn.disabled = true;
  const label = busyLabel(btn, '连接中…');
  lockConnectEntries();
  notice('info', `正在连接 ${c.user}@${c.host}…`);
  try {
    return await handleConnectResult(
      await window.slurmate.connect({ connectionId: c.id }));
  } finally {
    connectingNow = false;
    unlockConnectEntries();
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** 统一的连接结果处理：主机密钥要用户拍板时弹框，其余按结果报错。 */
async function handleConnectResult(res) {
  if (res.ok) {
    setConnected(true);
    whoami = res.whoami || null;
    const acct = whoami && whoami.account;
    notice('ok', `已连接：${(whoami && whoami.user) || ''}（账户 ${acct || '未分配'}）`);
    if (!acct) {
      notice('error', '这个账号尚未分配集群计算权限，请联系管理员，否则提交作业会失败。');
    }
    if (res.partitions) renderPartitions(res.partitions);
    // 插件清单也是连上之后才有的（`op_plugins` 走这条路）—— 不在这里刷的话，
    //   首次连接前界面上只有"这个守护进程不通报插件清单"，而那是句假话。
    if (res.plugins) renderPlugins(res.plugins);
    renderConnections(boot.connections);
    // 会话表从主进程取一次权威的。接回在后台跑（`doConnect` 不等它），所以
    //   此刻手里通常是空的 —— 接回来的那几条会由状态推送自己添上来。
    //   这里从前写死一份空表 —— 重连时它会把刚接回来的那几条从界面上删掉：
    //   标签栏与那颗「面板」一起没了，而会话页面照样盖在窗口主体上，于是用户
    //   直接掉进 web-demo 的网页里、没有任何路回到面板（2026-10-18 真机）。
    const st = await window.slurmate.states();
    renderSessions(st && Array.isArray(st.sessions) ? st : { sessions: [], front: null });
    // 连上之后进第二屏。这一屏之所以能进，正是"连上"这件事本身：
    //   插件是站点分发的，没有连接就不知道有哪些插件。
    //   接回上次那些会话是后台的事（用户 2026-10-19：连接成没成不该等它），
    //     接回来一条就在上栏多一个标签。
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

  setConnected(false);
  notice('error', res.error || '连接失败。');
  return false;
}

// ── 会话计数 ────────────────────────────────────────────────────────────────

/**
 * 现在有几条会话在跑（提交中/排队/运行/释放中都算）。
 *
 * 回条数，不是布尔 —— 弹确认框的那两处都要把数字说给用户听：
 *   "重启会先结束当前会话"在两条的时候是一句不准确的话，而用户是按那句话
 *   决定要不要点下去的。
 */
function liveCount() {
  // `s &&` 那一截是给 `hasRunningSession()` 用的：它现在是 `liveCount() > 0`，
  //   而这个函数从前按 `s.live` 直接取（表里混进一个 null 就是一次 TypeError）。
  return SESS.sessions.filter((s) => s && s.live).length;
}

// ── 启动 ────────────────────────────────────────────────────────────────────
//
// 这里分成两段，顺序不许调换（见下面 `bindEvents` 的注释）：
//   先 `bindEvents()`（纯同步），再 `bootUI()`（所有 await 与首屏渲染）。

/** 当前表单在操作哪把密钥。新建时是那把还没有归属的，编辑时是这条连接的。 */
const keyPayload = () =>
  (form.mode === 'edit' && form.id ? { connectionId: form.id } : undefined);

/**
 * 挂上所有事件监听。纯同步 —— 一个 `await` 都不许有。
 *
 * 为什么这件事值得单开一个函数、还排在取数据前面：这一整块从前排在
 *    `init()` 里那几个 await 的后面。于是只要 `bootstrap()` 或者
 *    `openNewForm()`（它里面还有 `await newKey()` —— 在 Windows 上那是 DPAPI
 *    那一条路）有一次 reject，`init()` 就在那一行整体中止，
 *    这一整块一个监听都不挂：标题、新建、表单、作业屏、重新加载、
 *    结束会话全在内 —— 而唯一的症状是提示流里多一行字。
 *    用户看到的是"这个界面上有一半按钮点了没反应"，而它指不回任何一处。
 *
 * 它与 P1 那次白屏（`renderConnections` 里一个 `ReferenceError`，560 条用例
 *   一条没红）是同一类：本项目一路上在清的那种「看起来正常但就是不工作」。
 * 首屏数据拿不到是一个故障，界面因此变成哑的是另一个，
 *     这一句把它们解耦：前者只该让首屏空着并说一句。
 */
function bindEvents() {
  // ── 事件 ──
  // 「关于」那一颗这里没有监听：它是一张悬停卡片（`.about-tip:hover` 与
  // `:focus-within`，见 app.css），展开与收起都归 CSS。整块说明在一个
  //   常驻的 DOM 节点里，所以这里也没有"填内容"的那一步 —— 版本号由
  //   `renderAbout()` 在拿到 `bootstrap` 之后写进去。
  // 标题那一行仍然不可点（2026-10-11 改）："点标题"在任何一个界面里都是
  //   "回首页"的意思，而这里的返回方式已经由各处动作约束好了 —— 见 panel.html
  //   上 `#about-head` 那一段。

  $('btn-new').onclick = () => openNewForm();
  $('btn-cancel-form').onclick = () => closeForm();

  // 「③ 工作区」：用户一动手就不再跟随默认（`wsPicked` 记下来）。
  $('f-workspace').onchange = () => {
    wsPicked = $('f-workspace').value;
    renderFormWorkspace();
  };
  // 默认值取决于上面的地址，所以敲地址时要重问一遍 —— 它是纯查询，不落盘。
  //   不这么做的话，那一项会一直写着「默认：新建一个空白工作区」，
  //   而用户按保存却落进了另一个工作区：界面在显示一件不成立的事。
  //   （只在新建时问：编辑时这一格没有"默认"那一项。）
  for (const id of ['f-host', 'f-port']) {
    $(id).oninput = () => { if (form.open && form.mode === 'new') refreshFormWsDefault(); };
  }

  $('btn-copykey').onclick = async () => {
    const r = await window.slurmate.copyPublicKey(keyPayload());
    notice(r.ok ? 'ok' : 'error', r.ok ? '公钥已复制到剪贴板。' : (r && r.error) || '复制失败。');
  };

  // 一下就走，没有确认。判据是代价，不是"不可逆"：再换一把就是了，
  //   而真正的代价（新公钥必须重新注册到 IDM，否则连不上）由两处承载 ——
  //   这颗按钮的 `title`（按下去之前看得见），以及动作之后那句 `notice`
  //   （按下去之后看得见）。从前这里是一句 `window.confirm`，而它问的
  //   与后面那句提示是同一件事：同一句话问一遍、做完再说一遍。
  $('btn-regen').title = '作废这条连接现在的密钥，换一把新的。'
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
      notice('error', '已生成新密钥，但它未能保存到本机（没有可用的系统凭据库）。'
        + '关闭客户端后这把密钥就没了，请先把上面的公钥注册到 IDM。');
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

    // 备注这一栏的传法在两种模式下不同，因为空备注的含义不同：
    //   编辑时那一栏就是当前值，清空即清空，必须原样传上去；
    //   新建时留空只表示「这次没起名」，不该拿它把已有条目的备注冲掉。
    const editing = form.mode === 'edit' && form.id ? form.id : null;
    const input = { user, host, port };
    if (editing) input.id = editing;
    if (editing || label) input.label = label;
    // 「③ 工作区」。三种取值分开传，因为它们在主进程那边是三件事：
    //   · 键缺席   = 用户没表态，按默认规则（同址已有的连接 → 活跃连接的 → 新建）
    //   · `null`       = 要一个新的空白工作区
    //   · 一个工作区 id = 就用那一个
    // 前两种不能合并：把"没表态"也发成一个具体 id 的话，默认规则就永远
    //   跑不到了（界面手里那个默认值是按上一个字算的，用户敲完立刻按保存就错），
    //   而它正是这个下拉存在的一半理由。
    const wsWant = $('f-workspace').value;
    if (!editing) {
      if (wsWant === NEW_WORKSPACE) input.workspaceId = null;
      else if (wsWant) input.workspaceId = wsWant;
    }

    const saved = await window.slurmate.saveConnection(input);
    if (!saved.ok) return notice('error', saved.error);
    // 工作区那张引用表跟着回包一起换。只换 `connections` 的话，映射图与表单
    //   下拉读的仍是启动时那一份，而新连接其实已经落进一个工作区了 ——
    //   用户看到的是一张缺了中间一列的图（用户 2026-10-20 报的那一条）。
    boot.workspaces = saved.workspaces || boot.workspaces;
    boot.connections = saved.connections;

    // `wasLive` 必须在动 `boot.activeConnectionId` 之前问：在赋值之后
    //    算的话那个比较恒为真 —— 编辑任何一条连接都会得到「这条连接正连着 ——
    //    新地址要重新点一次连接才会生效」，而用户可能压根没连着它。
    //
    //    编辑这条路上根本不该碰 `boot.activeConnectionId`：这个按钮这时写的
    //      是「保存」（不是「保存并连接」，见 openEditForm），而主进程那边活跃连接
    //      一个字都没动（`app:saveConnection` 只在从来没有活跃连接时才设它）。
    //
    //    而在这条不变量下（站在第一屏上就一定不在任何站点里）它恒为 false：
    //      表单只在第一屏上开得出来。留着是因为它那句话在万一成立时仍然是真的
    //      —— 同一个位置上从前还并排着一道「换站点」的闸（`allowSwitchTo`），那一道
    //      删掉了，理由正是它那句不是真的（它会叫人去一屏之外按两颗按钮）。
    const wasLive = connected && saved.connection.id === boot.activeConnectionId;

    if (editing) {
      renderConnections(boot.connections);
      closeForm();
      notice('ok', '已保存这条连接。');
      if (wasLive) {
        // 地址改了但 SSH 连接还挂在旧地址上。不说的话，用户会以为改动没生效。
        notice('info', '这条连接正连着，新地址要重新点一次「连接」才会生效。');
      }
      // 换工作区是第二趟，不并进上面那一次保存里：它有自己的两道闸
      //   （切走会不会把一个独占的工作区删掉 → 需要用户确认；有没有会话在跑 →
      //   要挪隧道端口）。那两条各有各的失败方式，焊进来的话一次保存就有四种
      //   下场，而其中三种会让用户不知道地址到底存进去没有。
      //   分两趟之后每一趟各自原子，代价是"地址存了、工作区没换"这种半截结果 ——
      //   它看得见、也说得出（下面那条 notice）。
      if (wsWant && wsWant !== saved.connection.workspaceId) {
        const r = await applyWorkspace(saved.connection.id,
          wsWant === NEW_WORKSPACE ? null : wsWant,
          // 第一段挂在「保存」那颗按钮上（用户刚按的就是它），退回时把「③ 工作区」
          //   那一格拨回不变—— 它停在"待定"的那个新值上，那不是已发生的事。
          { anchor: $('btn-save'), revert: () => { wsPicked = ''; renderFormWorkspace(); } });
        // `armed` 那一支不说这句：问题还摆在那儿没答，说"工作区没有换"
        //   等于替用户答了"不换"。
        if (!r.ok && !r.armed) notice('info', '地址已经保存了，但工作区没有换。');
      }
      return;
    }

    // 这里从前也要过一道「换站点」的闸（与 `doConnectTo` 那一道同一个函数，
    //   2026-10-11 整个删掉了）：这条路上不可能发生"换站点"—— 表单只在第一屏
    //   上开得出来，而站在第一屏上就一定不在任何站点里。
    boot.activeConnectionId = saved.connection.id;
    renderConnections(boot.connections);
    notice('info', saved.created ? '已保存这条连接。' : '这条连接之前就保存过了，直接用它。');
    // 表单里那颗按钮不是重画的（它是 `panel.html` 里写死的），所以直接标它。
    await connectTo(saved.connection, $('btn-save'));
    // 无论连上没连上，表单都收起来 —— 再摆回来的话，用户看到的是「刚保存完又
    //   弹出一个新建连接」，像是什么都没存进去。这条连接已经在右上角下面的列表里了，它有「连接」「编辑」
    //   两个按钮；连不上时日志里那条错误会说清楚下一步该做什么。
    closeForm();
  };

  $('btn-probe').onclick = doProbe;
  // 这两个按钮必须绑两个不同的函数（见 doLeave / doDisconnect）：它们对作业
  //   做的事正好相反，而共用一个实现的话，其中一个的语义迟早会被"顺手统一"掉 ——
  //   漂的方向是"点了临时离开，作业被停了"。
  $('btn-leave').onclick = doLeave;
  // 【断开】是两段式，而【临时离开】不是。这不是双重标准：断开是这一屏上
  //   唯一一个会销毁正在跑的计算的按钮，它和"回列表"那颗紧挨着，而误点的代价
  //   是一个可能已经跑了几小时的作业加一份机时 —— 不可逆，也没有第二次机会。
  //   那句话里必须带上有几个作业会没：只说"确定断开吗"，用户答不了。
  //   条数现算（`liveCount()`）：写在别处缓存着的话，漂开的方向是
  //     "这个框说 2 条、那个框说 1 条"。
  $('btn-disconnect').onclick = () => {
    const n = liveCount();
    armConfirm($('btn-disconnect'), {
      why: n
        ? `断开连接会结束 ${n} 个会话。集群上的作业会被取消，已经跑掉的时间不会回来。`
        : '断开与登录节点的连接。',
      yes: '断开',
      run: doDisconnect,
    });
  };

  // ── 三屏之间的前后关系 ──
  // 它们是一个站点的三个层次，所以靠前后关系走，不是一排平级标签。
  //   而"退回去"在这一版里不是一条导航（2026-10-11）：回到第一屏只有
  //      「临时离开」与「断开」两条路，它们各自把连接收掉 —— 站在这第一屏上就
  //      一定不在任何站点里。第二/三屏之间来回走仍然是纯粹的导航（`#btn-to-jobs`
  //      与 `#btn-to-plugins` 那两个）。
  // 这里从前有一颗「← 登录节点」—— 它只是一句 `showScreen('conns')`，会话还在
  //   跑、心跳还在，而界面已经回到了"不在任何站点里"的样子。它整个删掉了：回第一屏
  //   的两条路是 `#btn-leave`（临时离开）与 `#btn-disconnect`（断开），见 panel.html
  //   里 `#screen-plugins` 那一段。
  $('btn-to-jobs').onclick = () => showScreen('jobs');
  $('btn-to-plugins').onclick = () => showScreen('plugins');
  // 第四屏（调试）回到插件那一屏 —— 与上面两颗同一类：屏与屏之间的导航，
  //   不动连接、也不动会话。它不把面板收回去（那要等用户点某条会话的标签，
  //   或者起一条新会话）—— 站在调试那一屏上本来就是"我要看着面板"。

  // ── 作业列表那一屏 ──
  // 这三个 id（`btn-jobs-new` / `btn-jobs-takeover` / `btn-jobs-end`）与
  //   panel.html 里那三个按钮由 test/renderer.test.mjs 逐字对着：改了一边
  //   而没改另一边，当场变红。它们指的是哪三个动作，见 panel.html 那一段注释。
  $('btn-jobs-new').onclick = () => showScreen('plugins');
  $('btn-jobs-takeover').onclick = takeoverSelectedJob;
  // 两段式（见 `armConfirm`）：它取消的是集群上正在跑的作业。作业列表那一屏
  //   上这一颗旁边就是「重新加载」与「接管」，而它长得没什么特别 —— 点错的代价
  //   是一条跑到一半的作业没了。与状态条那颗 `#sb-end` 同一套语义。
  $('btn-jobs-end').onclick = () => armConfirm($('btn-jobs-end'), {
    why: '结束这一条作业，集群上的作业会被取消，里面正在跑的任务也会停。',
    yes: '结束',
    run: endSelectedJob,
  });
  $('btn-jobs-reload').onclick = () => {
    const j = selectedJob();
    return window.slurmate.reload(j ? j.slot : null);
  };
  $('btn-jobs-refresh').onclick = refreshJobs;

  // 站点对账是后台跑的，跑完主动推一份新视图过来。不接这条的话，用户看到的
  //   永远是连接那一刻的旧视图 —— 而"插件明明是站点说要给的、界面上却什么都没有"
  //   正是这个功能最该避免的那句话。
  window.slurmate.onPlugins((pv) => {
    if (!pv) return;
    renderPlugins(pv);
  });

  // 「重新同步」与「检查集群」并排（见 panel.html 那一段）。它在这一屏底部，
  //   两种模式里都在 —— 站点的插件清单不在任何轮询里，装了新版本之后只有
  //   下一次连上或者按这一颗才会被发现。
  $('btn-sync-plugins').onclick = () => syncPlugins();

  $('btn-doctor').onclick = async () => {
    const r = await window.slurmate.doctor();
    if (!r || !r.ok) return notice('error', '检查失败：' + ((r && r.error && r.error.detail) || '无响应'));
    const d = r.data;
    // 判定在守护进程那一侧，这里只负责说出来。两边各判一遍就是同一条规矩
    //   两份实现，而它们漂开的那天，界面说"通过"而服务端说"有问题"。
    const problems = Array.isArray(d.problems) ? d.problems : null;
    if (!problems) {
      return notice('error', '这个站点的守护进程版本过低，报不出不变量检查，请先升级站点。');
    }
    if (problems.length) {
      const lines = problems.map((p) => (p && p.detail) || (p && p.key) || '未说明');
      return notice('error', '检查发现问题：' + lines.join('；'));
    }
    const bits = [`检查了 ${d.checked} 项`, `${d.rules_count} 条 ACL 规则`,
                  `${d.active_sessions} 个活跃会话`];
    // 卡在「已提交、还没有登记上」的那一段。它不算问题（规则数本来就
    //   该是 0），所以不挡体检通过；但它正是用户眼前那条会话 —— 不报出来，
    //   体检会说"一切正常"。
    if (d.pending_sessions > 0) bits.push(`${d.pending_sessions} 个还没有登记上`);
    if (d.auth_mode_none > 0) bits.push(`${d.auth_mode_none} 条关闭了口令`);
    let extra = '';
    if (d.version) extra = `守护进程 ${d.version}`;
    if (typeof d.tick_age_seconds === 'number') {
      extra += (extra ? '，' : '') + `上一次对账在 ${d.tick_age_seconds} 秒前`;
    }
    notice('ok', `检查通过：${bits.join('，')}。` + (extra ? `（${extra}）` : ''));
  };

  $('btn-export-diag').onclick = async () => {
    const r = await window.slurmate.exportDiagnostics();
    if (r && r.ok) {
      notice('ok', `诊断材料已写出：${r.path}`);
      return;
    }
    if (r && r.canceled) return;
    notice('error', (r && r.error) || '未能导出诊断材料。');
  };

  // 「最近作业」是一个按需拉的动作，不跟着上面那张表一起刷：它是最贵的
  //   一条查询（守护进程会同步 fork `sacct`），而它回答的"过去发生了什么"不会
  //   自己变新。
  $('btn-history').onclick = () => loadHistory();
  // 按需取一次日志。它不自动跑：那是一次真的 RPC（退化成 exec 时是一次
  // sshd fork），而作业屏是要反复刷的 —— 自动取等于每刷一次多 fork 一个 python。
  $('btn-joblog').onclick = () => loadJobLog();

  // 重新加载打的是前台那一条 —— 屏幕只有一块，用户看的正是它。
  // 面板里那一份挪到作业列表那一屏了（`#btn-jobs-reload`，打的是选中的
  //   那一条）；状态条这一份留着，理由与 `sb-end` 同：会话一跑起来，窗口主体
  //   就被原生视图整块盖住，那 30px 是唯一够得着的像素。
  $('sb-reload').onclick = () => window.slurmate.reload(frontSlot());
  // 「临时离开」：页面盖着窗口时回面板的出口（与 `#btn-leave` 是同一个动作）。
  //   两段式 —— 它停的是心跳，"35 分钟内没人回来接着看就会被回收"不是一眼
  //   能看出来的后果。本机会话没有作业，那句话换成"随连接结束"。
  $('sb-leave').onclick = () => {
    const s = frontSnap();
    armConfirm($('sb-leave'), {
      why: s && s.onHost
        ? '临时离开：本机会话没有作业，它会随这次连接结束。'
        : '临时离开：作业继续在集群上跑，但本机不再看护它；'
          + '35 分钟内没有人回来接着看，它会被自动回收。',
      yes: '离开',
      run: doLeave,
    });
  };
  // `#btn-end` 那个按钮没有了 —— 它的位置由作业列表那一屏上的
  //   【结束】（`#btn-jobs-end`，结束选中的那一条）接过。状态条上这一个留着，
  //   而且必须留着：会话跑起来之后窗口主体被原生视图整块盖住，那 30px 是唯一
  //   够得着的像素（与 `sb-reload` / `sb-temp` 同一条理由）。
  // 两段式（见 armConfirm）：它会取消集群上正在跑的作业，而它旁边紧挨着
  //   「重新加载」。第一段可退，第二段才真的结束。
  // 停的是前台那一条 —— 这颗按钮只在它的页面盖着时才露（见 renderStatusEnd），
  //   所以"眼前这一条"与"前台那一条"是同一件事。
  $('sb-end').onclick = () => armConfirm($('sb-end'), {
    why: '停止这一条作业，集群上的作业会被取消。',
    yes: '停止',
    run: endFrontSession,
  });

  // 会话标签太多时横向滚。这一条是 30px 的状态条，纵向滚轮在这里没有别的
  //   读者；触控板的横向滑动本来就走原生横向滚动，所以只接管纵向那一轴。
  // 判据是"真的能滚"：不能滚的时候一个字都不拦 —— 拦一个没有效果的事件，
  //   下一次这里再出问题就分不清是"拦了没滚"还是"本来就滚不动"。
  const tabBar = $('session-tabs');
  tabBar.addEventListener('wheel', (e) => {
    if (tabBar.scrollWidth <= tabBar.clientWidth) return;
    const d = Number(e.deltaY) || 0;
    if (!d) return;
    tabBar.scrollLeft += d;
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }, { passive: false });

  // 「端口被占」那一行的三颗按钮 —— 三选一，三颗都是当场生效的动作。
  //    它们不是两段式（见 `renderPortAsk`）：答「启动」就重发那一趟，答「记住新配置
  //    并启动」也重发（多带一个"记住"的作答，写配置那一步在主进程、而且排在绑定
  //    成功之后），答「取消」就地回退，而此刻本来什么都没提交。
  //
  //    重发用的是用户刚才点的那一颗按钮（`pending.btn`）连它那一块的那几格
  //      （`pending.adv`），不是"当前前台那一条" —— 插件页上每一块都有自己的
  //      「开始会话」和它自己那份高级选项，重发必须是同一个插件、同一份填写，
  //      否则用户答的是甲、起来的是乙。
  $('sb-port-shift').onclick = () => {
    const p = portAsk;
    if (!p) return;                       // 防御：那一行已经收掉了
    return startWith(p.serviceKind, p.adv, p.btn, { portChoice: 'shift' });
  };
  $('sb-port-remember').onclick = () => {
    const p = portAsk;
    if (!p) return;
    return startWith(p.serviceKind, p.adv, p.btn, { portChoice: 'remember' });
  };
  $('sb-port-abort').onclick = () => {
    clearPortAsk();
    // 说这一句是承重的：用户刚点过「开始会话」，界面又静了下来，他分不清
    //   那是"起来了"还是"没起来"。而这一句说的是事实（那时确实什么都没提交），
    //   不是安慰。
    notice('info', '没有提交：集群上不会出现作业，那份数据也没有被占住。');
  };

  // 状态条上这里从前有一个「工作区」下拉。2026-10-18 删掉（用户：作业运行的时候
  //   不该在那里）。换工作区要换 origin、重新加载页面，未保存的编辑会跟着没 ——
  //   那是"没有会话在跑"时从连接那一屏做的动作，不是 30px 里手边的一颗下拉。
  //   `applyWorkspace` 与那个两段式确认照旧服务表单里的「③ 工作区」。

  // 窗口大小变了，连线的坐标就全变了。rAF 里重画，等布局定下来。
  window.addEventListener('resize', () => requestAnimationFrame(drawWorkspaceLines));

  // ── 两条边栏 ──
  //
  // 停靠（鼠标进去）与钉住（点一下）是两段：第一段可退（移开就收），第二段
  //   把它钉住。理由是输出那一块要滚动、要选中复制，鼠标一挪开就没的话那两件
  //   事都做不了。见 windows.js 的 `toggleHoverPin`。
  //
  // 收起不在这里：它是鼠标几何判的（浮窗是原生视图，鼠标一进去这一格就再也
  //   收不到事件了 —— 靠 `mouseleave` 关的话，浮窗会闪一下就没了）。
  // 右栏在没有作业在跑的时候不开。它那一块是作业输出，而这份东西只有
  //   一个来源：一条在跑的会话。没有会话还滑出一块空面板，等于说"这里本该有东西"
  //   —— 而它本来就没有（设计律：非必要不提示，是一点都不提示）。
  for (const side of ['left', 'right']) {
    const el = $(`rail-${side}`);
    const wanted = () => side === 'left' || hasRunningSession();
    el.addEventListener('mouseenter', () => { if (wanted()) window.slurmate.hover({ side }); });
    el.onclick = () => { if (wanted()) window.slurmate.hover({ side, pin: true }); };
  }
  renderRails();
  // 左栏那一条的颜色（整条，不是圆点 —— 理由见 `renderRails` 那一段）。
  // 三态由主进程算好了推过来，界面这里不重算：重算的地方就是第二个
  //   "什么时候算断线"的判据，而它会与主进程那个漂开。
  window.slurmate.onSite((s) => {
    $('rail-left').className = 'rail rail-l ' + ((s && s.state) || 'na');
  });

  window.slurmate.onStates(renderSessions);
  // 主进程主动断开了这个站点（空手超时）：界面必须跟着回到第一屏。
  //   不跟的话，第二屏上的按钮会继续打在一个已经关掉的通道上。
  window.slurmate.onSiteClosed((p) => {
    setConnected(false);
    showScreen('conns');
    if (p && p.reason) notice('info', p.reason);
  });
  window.slurmate.onNotice((n) => {
    if (n.kind === 'key-blocked') {
      // 快捷键诊断：我们吞掉了一个键，而用户正想问"按了为什么没反应" ——
      //   所以这一条要进日志。放行的那些不再报（见 shortcuts.js 的注释）。
      notice('info', '已拦截：' + n.text);
      return;
    }
    // `warn` 要留住：把它折成 `info` 的话，主进程发来的每一条警告（例如"工作区已删除，但它那份
    //   浏览器存储没能清干净"）在日志里都长成「信息」—— 而一条显示成信息的失败，与一条
    //   被吞掉的失败是同一件事。
    notice(['ok', 'error', 'warn'].includes(n.kind) ? n.kind : 'info', n.text);
  });
}

/**
 * 「关于」卡片里那一格版本号。
 *
 * 版本只有一个来源：主进程 `app.getVersion()`（`app:bootstrap` 带回来的
 *   `version`）。在这里另写一个字符串就会漂 —— 而且漂的方向没人会注意到：
 *   界面上写着一个版本，装上去的那一份是另一个。
 * 没有这一格就照实说「版本未知」，不猜。
 */
function renderAbout() {
  const v = boot && boot.version;
  $('about-ver').textContent = v ? `版本 ${v}` : '版本未知';
}

/**
 * 取首屏数据，画出来。所有 `await` 都在这里。
 *
 * 它 reject 只该是"首屏空着" —— 事件监听已经在 `bindEvents()` 里挂好了，
 *   与这里的成败无关。见那个函数的注释。
 */
async function bootUI() {
  boot = await window.slurmate.bootstrap();

  renderAbout();
  syncNewButton();

  // bootstrap 里没有公钥 —— 密钥是按连接的，界面在打开某条连接的表单时
  //   单独去问（app:publicKey / app:newKey）。每个字段都是问出来的、当场渲染的。
  renderConnections(boot.connections);
  renderPartitions(boot.partitions || []);
  renderPlugins(boot.plugins);
  renderConnEmpty();
  // 本机的插件数据是一次单独的对账（它要读磁盘、还问一次 Electron 分区目录在
  // 哪儿）。不 await 在首屏里：让它挡住首屏就是把"面板画出来"与"磁盘快不快"
  // 绑在一起。回来之后再画那一块（它与 `bootstrap` 的关系见 index.js 的注释）。
  window.slurmate.pluginData().then(renderPluginData, (e) => {
    notice('error', '本机的插件数据未能列出来：'
      + ((e && e.message) ? e.message : e));
  });
  // 一条连接都没有 —— 第一眼就是「新建」，不然用户对着空列表找不到入口
  if ((boot.connections || []).length === 0) await openNewForm();

  // 拉一次全部会话。
  //
  // 启动不会接回任何会话（`index.js` 不自动连），所以这里通常是
  //   一份空表。留着这一问是因为它同时回答了"这个客户端手上还有没有会话记录"
  //   —— 那与"连没连上"是两件事（比如上个进程留下的已经结束的记录）。
  const st = await window.slurmate.states();
  // 手上还有活会话，这次面板的加载发生在一个已经连上的客户端里面（面板被
  //   重新加载过，而会话记录是本进程的），所以下面直接进第二屏 —— 站在第一屏上就
  //   意味着"不在任何站点里"，而这里明明还在连接里（见 panel.html 里
  //   `#screen-plugins` 那一段那条不变量）。启动时这一句通常不成立：新起的
  //   进程手上一条会话记录都没有（`index.js` 不自动连、也不接回）。
  const attached = Boolean(st && st.sessions && st.sessions.some((x) => x.live));
  if (attached) setConnected(true);
  // 从前这里要补一次 `renderConnections`（那一句原话是"否则两条边栏不会出现
  //   —— 它们跟着 `body.connected` 走"）。那个理由随 `setConnected` 一起没有了：
  //   那一格现在把跟着它走的东西当场重画，不必等谁补一遍。
  renderSessions(st || { sessions: [], front: null });

  // 开局落在第一屏（连接列表），而且没有任何自动连接。
  //   这一句是「不自动连」在界面这一侧的落点：`index.js` 那边不连，这里不跳。
  //   没有它的话，`screen-conns` 那份 HTML 是露着的（它是唯一没有 `hidden` 的一屏），
  //   但路由的 `SCREEN` 还是上一次的值 —— 两份"我在哪一屏"会漂，而漂的形态是
  //   "点了返回，页面没动"。
  //   唯一的例外就是上面那个 `attached`：人还在连接里的时候不许落在第一屏，
  //     否则那条不变量当场破掉（一个"站在第一屏却说自己在连接中"的状态）。
  if (attached) showScreen('plugins');
  else showScreen('conns');
}

async function init() {
  bindEvents();
  await bootUI();
}

/** 连上列表里的某一条。点它就等于把它设为当前连接。 */
async function doConnectTo(c, btn) {
  // 一次只连一条。这一句必须排在 `setActiveConnection` 前面：那一句会当场
  //   改掉活跃连接，而一次被拒绝的第二下不该留下任何痕迹（用户 2026-10-19
  //   真机：两次连接同时在飞，最后连上的是哪一条全看谁后返回）。
  if (connectingNow) {
    return notice('info', '正在连接站点，请等这一次结束再连另一条。');
  }
  // 这里从前有一道闸（`allowSwitchTo`）：连着 A 的时候点 B 会被拦下，并把
  //   "还连着哪一条、上面有几条会话在跑"说出来。它整个删掉了（2026-10-11）——
  //   它守的那件事现在由界面的形状承担：站在第一屏上就一定不在任何站点里，
  //   所以"连着 A 又去点 B"这条路根本不存在（见 panel.html 里 `#screen-plugins`
  //   那一段）。而主进程那一道一个字都没动：`app:connect` 换站点时仍然先
  //   `leaveSite()` —— IPC 层的防线不该假设界面的形状。
  const r = await window.slurmate.setActiveConnection(c.id);
  if (!r.ok) return notice('error', r.error);
  boot.activeConnectionId = c.id;
  // 这一趟不先重画列表：重画会把手里这颗按钮换掉，而「连接中…」要画在屏幕上
  //   那一颗上。地图上那一格（哪条连接是当前的）等这一趟有结果之后再画 ——
  //   连上时 `handleConnectResult` 自己会画一遍，没连上时它在这儿补上。
  await connectTo(c, btn);
  renderConnections(boot.connections);
}

/**
 * 【临时离开】—— 回这个列表，作业继续在集群上跑。
 *
 * 它与【断开】是两个方向相反的动作：这里只是本机走开、停下心跳，
 *   断开发的是 `goodbye`（`scancel` 作业）。写反了的后果是用户的作业被删掉，
 *   而界面上那句提示会告诉他"作业还在跑"—— 一句话和它描述的事实正好相反，
 *   且不可撤销。
 *
 * 看护者不动（2026-10-21 用户定）：回来连上这个站点会直接接回，不需要点
 *   「接管」。而「离开」仍然不是暂停：倒计时看心跳，走的还是那一条窗口
 *   （300 秒 suspect → 1800 秒 orphaned → `scancel`）。所以这里必须把那句话
 *   说出来，而不是等用户自己发现 —— 见 panel.html 里这个按钮的 title。
 */
async function doLeave() {
  const onlyLocal = onlyLocalSessions();
  const anyLocal = hasLocalSession();
  const r = await window.slurmate.leave();
  if (!r || !r.ok) return notice('error', (r && r.error) || '临时离开失败。');
  setConnected(false);
  whoami = null;
  if (onlyLocal) {
    // 本机会话没有作业：离开就是结束它，没有倒计时，也没有看护者。
    notice('info', '已临时离开。本机会话会随连接结束，本次没有影响任何作业。');
  } else {
    // 看护者仍然是本机（见 `app:leave`）：回来连上就直接接回，不必点接管。
    //   而作业的倒计时照旧从心跳停下的那一刻起算。
    notice('info', '已临时离开。作业仍在集群上运行，看护者仍然是本机，'
      + '回来连上这个站点会直接接回。但 35 分钟内没有人回来接着看，'
      + '它会被自动回收。' + (anyLocal ? '本机会话会随连接结束。' : ''));
  }
  // 回到第一屏，并把作业列表作废 —— 与断开逐字同一个理由：那份数据属于刚才
  //   那个站点，留着它会让下一次进作业列表时先闪一下上一个站点的作业
  //   （见 JOBS.forConn）。
  JOBS = { forConn: null, list: null, at: 0, error: null, selected: null };
  renderConnections(boot.connections);
  renderSessions({ sessions: [], front: null });
  showScreen('conns');
}

/**
 * 【断开】—— 彻底终止。还有会话的话先取消作业、释放资源，再拆连接。
 *   「断开」和「结束会话」在这里是同一件事的两种说法，因为对用户来说
 *   它们的意思本来就一样：我不要了。凡是用户主动表达的终止，都不该留下
 *   一个还在集群上占着资源的作业。
 *
 *   反过来，合盖/断网/断电时这个函数不会被调用 —— 那条路走守护进程的
 *   suspect/orphaned 容错窗口，客户端下次启动自动接回。
 *
 * 它走两段式（`#btn-disconnect` 那颗按钮上的 `armConfirm`），而旁边的
 *   「临时离开」一下就走。这不是双重标准：断开是这一屏上唯一一个会销毁正在跑的
 *   计算的按钮，它和"回列表"那颗紧挨着，而误点的代价是一个可能已经跑了几小时的
 *   作业加一份 12 小时的机时 —— 不可逆，也没有第二次机会。
 * 那段后果（有几个作业会没）由第一段说出来：只说"确定断开吗"，用户答不了。
 *
 * 这个函数自己不再问第二遍。它从前在 `armConfirm` 之外还有一句
 *   `window.confirm`，于是同一个动作问两遍（第一段一行确认 + 一个系统对话框），
 *   而那两句话说的是同一件事。用户 2026-10-09 明说"所有都确认好几遍这不是很烦人么"。
 * 那句话里唯一不是后果的那半句（"只是想回列表就点「临时离开」"）
 *     搬进了这颗按钮的 `title`：它是一个别的选择，不是一个"你确定吗"。
 * 于是这个函数可以被别处直接调用而不会弹框 —— 它只做那件事。
 */
async function doDisconnect() {
  const onlyLocal = onlyLocalSessions();
  const r = await window.slurmate.disconnect();
  if (!r || !r.ok) return notice('error', (r && r.error) || '断开失败。');
  setConnected(false);
  whoami = null;
  const rel = r.released;
  if (rel && !rel.ok) {
    notice('error', rel.detail);          // 释放没成功必须说，不能吞掉
  } else if (onlyLocal) {
    notice('info', '已断开连接。本机会话已结束，本次没有影响任何作业。');
  } else if (rel && rel.state === 'releasing') {
    notice('info', '已断开连接，并请求释放会话。请以状态条变为「已结束」为准。');
  } else {
    notice('info', '已断开与登录节点的连接。');
  }
  // 断开之后回第一屏，并把作业列表作废（理由见 doLeave）。
  JOBS = { forConn: null, list: null, at: 0, error: null, selected: null };
  renderConnections(boot.connections);
  renderSessions({ sessions: [], front: null });
  showScreen('conns');
}

async function doProbe() {
  const btn = $('btn-probe');
  btn.disabled = true;
  const old = busyLabel(btn, '探测中…');
  try {
    lastProbe = (await window.slurmate.probeHosts()) || [];
    renderConnections(boot.connections || []);

    if (lastProbe.length === 0) {
      // 「一条都没配」和「配了但都不通」是两回事，文案必须分开 ——
      // 不能写死成「三个地址都不可达」，候选可能是 0 个。
      // 还有第三种：只有内置那条假站点。主进程不探它（它在本机，见
      //   `app:probeHosts`），于是探测结果是空的，而列表上明明有一条连接 ——
      //   写成"还没有保存任何连接"是在说一件用户一眼就能看见不成立的事。
      notice('info', (boot.connections || []).length
        ? '内置的那条是本机的假站点，没有可探测的地址。没有其他连接可探。'
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
 * 它不再只走 `notice`。理由是一条实测过的失败形状：`bindEvents()` 从前排在
 *    `bootUI()` 那几个 await 的后面，于是一次 reject 就让整块监听一个都不挂 ——
 *    而症状只有提示流里一行字，用户看到的是"一半按钮点了没反应"，指不回任何一处。
 *    监听那半边已经解耦（见 `bindEvents`），这一半是另一半：剩下会坏的，
 *    也得让人第一眼看见。
 * 只写横幅、不另写一条 `notice`：同一条消息两个落点就是两份实现，
 *    而它们会漂。横幅常驻在最上面，比会滚走的提示流更该是那唯一一处。
 */
function onInitFailed(e) {
  const why = (e && e.message) ? e.message : String(e);
  $('fatal-why').textContent = why;
  $('fatal-banner').classList.remove('hidden');
}

init().catch(onInitFailed);
