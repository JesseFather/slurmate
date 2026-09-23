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
let lastSnap = null;         // **前台**那一条的快照，供状态条与布局选择器读它
let SESS = { sessions: [], front: null };   // 全部会话 + 哪一个是前台（见 renderSessions）
/**
 * 最近一次的插件清单。界面里有**两处**需要知道"这个会话的插件声明了界面没有"，
 * 而快照本身是插件无关的（session.js 不认识任何插件）—— 所以在这里留一份，
 * 按 `serviceKind`（站点短名）去查。
 */
let lastPlugins = null;

/** 布局下拉里「新建一个空白布局」那一项的值。不是布局 id，别混。 */
const NEW_LAYOUT = '__new__';

/**
 * 「新建／编辑」表单的状态。
 *   mode='new'  → 展示那把还没有归属的密钥（新建时生成的）
 *   mode='edit' → 展示 id 指向的那条连接的密钥
 * id 始终是「当前正在编辑哪条连接」，新建时为 null —— 它是保存时告诉主进程
 * 「改哪一条」的唯一依据，搞错就会把 A 的地址写到 B 头上。
 */
let form = { open: false, mode: 'new', id: null };

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

// ── 状态渲染 ────────────────────────────────────────────────────────────────
/**
 * 「开始会话」那一屏露不露出来。
 *
 * ★ 两个条件都可能让它出现，而且它们是**独立的**：
 *   · idle && connected —— 老规矩：连不上就没有分区可挑，摆一堆按不动的按钮
 *     只会让人以为客户端坏了；
 *   · **本机一个插件都没装** —— 装插件与连不连得上集群毫无关系（插件是本机的
 *     东西），而把安装入口藏在一块"要连上才看得见"的区域里，等于用户第一次
 *     打开客户端时无路可走。
 *
 * 两处都会改变这个判定（会话状态变化、插件列表被重扫），所以它单独成函数 ——
 * 复制一份判断在两个地方，迟早会分叉。
 */
function syncPurposeVisibility() {
  const st = lastSnap ? lastSnap.state : 'idle';
  const idle = !lastSnap || st === 'idle';
  const noPlugins = Boolean(lastPlugins && lastPlugins.installedCount === 0);
  $('sec-purpose').classList.toggle('hidden', !(noPlugins || (idle && connected)));
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
 * ★ 每一条都要能点 —— 那是"我还能切回去"的唯一入口。前端那条加一个 class，
 *   而**标签上写的是服务名**：两条会话的插件必然不同（同一个槽只能有一条），
 *   所以服务名在这里天然是唯一的，不需要再造一个编号。
 */
function renderTabs() {
  const box = $('session-tabs');
  const list = SESS.sessions;
  box.classList.toggle('hidden', list.length < 2);
  box.textContent = '';
  for (const s of list) {
    const b = document.createElement('button');
    b.className = 'tab' + (s.slot === SESS.front ? ' on' : '')
      + (s.live ? '' : ' dead');
    b.textContent = s.service || '（未知服务）';
    const st = s.snap && s.snap.state;
    b.title = STATE_TEXT[st] || st || '';
    b.onclick = () => window.slurmate.setFront(s.slot);
    box.appendChild(b);
  }
}

/** 前台那一条的槽（按钮要指名停哪一个）。没有会话时 null。 */
function frontSlot() {
  return (SESS.sessions.find((x) => x.slot === SESS.front) || {}).slot || null;
}

function renderSnapshot(s) {
  lastSnap = s || null;
  const bar = $('statusbar');
  const st = s ? s.state : 'idle';
  bar.className = 's-' + st;

  $('sb-state').textContent = STATE_TEXT[st] || st;

  let detail = '';
  if (s) {
    if (st === 'running' || st === 'releasing') {
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
  // 布局选择器只在运行期间露出来：其余时候面板本身可见，用连接行里那个下拉就行。
  // 没有活跃连接时也藏起来 —— 它改的是「当前连接的」布局，没有连接就没有对象。
  // ★ 多一个条件：**前台那条会话真的有布局组**（`s.layoutId`）。
  //   漏了它的症状是：前台是个中转站会话时选择器还露着，用户改了**没反应** ——
  //   那条路（`outsideLayout`）两条分支都不走，而界面上一切正常。
  $('sb-layout-wrap').classList.toggle(
    'hidden', !(running && boot && boot.activeConnectionId && s && s.layoutId));

  // 形态切换
  const idle = !s || st === 'idle';
  $('sec-connect').classList.toggle('hidden', !idle);
  // 会话一起来就把表单收掉 —— 它只在「还没连上」这一屏里说得通
  if (!idle) closeForm();
  // 「开始会话」只在真的连上之后才出现 —— 连不上就没有分区可挑，
  // 摆一堆按不动的按钮只会让人以为客户端坏了。
  //
  // ★ 一个例外：**本机一个插件都没装**时，这一屏必须露出来。装插件与连不连得上
  //   集群毫无关系（插件是本机的东西），而把安装入口藏在一块要连上才看得见的
  //   区域里，等于用户第一次打开客户端时**无路可走**。见 renderPlugins 的空态。
  syncPurposeVisibility();
  $('sec-session').classList.toggle('hidden', !(s && st !== 'idle' && st !== 'ended'));

  if (s && st !== 'idle' && st !== 'ended') renderKv(s);

  renderLayoutSelectors();
  // 上面刚把 sec-connect 显示/隐藏过，映射图的几何位置到这一帧结束后才是最终的。
  // rAF 里重画一次，比在这里硬算可靠（字体、滚动条、换行都还没定下来）。
  requestAnimationFrame(drawLayoutLines);
}

/**
 * 打开「新建」表单。
 *
 * ★ 密钥**在这一步生成**，早于用户填地址 —— 他得先把公钥复制去 IDM 注册，
 *   回来才连得上。所以这一步是异步的：公钥框会先显示「正在生成密钥…」。
 *   主进程那边是幂等的：已经有一把还没归属的密钥就复用它，不会又换一把
 *   （那会作废用户可能已经注册好的公钥）。
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
  hideKeyMessages();
  renderConnEmpty();

  const r = await window.slurmate.newKey();
  if (!form.open || form.mode !== 'new') return;    // 用户已经关掉或切走了
  if (!r || !r.ok) return showKeyError((r && r.error) || '生成密钥失败。');
  $('key-hint').textContent = r.generated
    ? '这把密钥属于下面这条新连接，还没有别的连接用它。'
    : '这把密钥是上次「新建」时生成的（如果你已经把它注册过了，直接往下填就行）。';
  renderKey(r.key);
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

/**
 * 「本地地址」那一行该写什么。
 *
 * ★ 从前这里无条件写 `s.origin`，也就是 `http://127.0.0.1:PORT` —— 对**中转站**
 *   会话那是一句**假话**：那个端口后面是 SSH，不是 HTTP。用户照着这一行去浏览器里
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
    (typeof r.gpus === 'number' && r.gpus > 0) ? `${r.gpus} GPU` : null,
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
    ['作业状态', s.jobState || '—'],
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
  // 这里曾经摆着一个「私钥保存方式」下拉框，让用户在加密／明文／不保存之间选。
  // 那等于把「你的私钥会以明文躺在磁盘上」包装成一个需要用户自己权衡的选项 ——
  // 选明文的那个用户并不知道自己在放弃什么。现在只有加密一种方式，
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
function renderConnections(list) {
  const box = $('conn-list');
  box.textContent = '';
  $('conn-empty').classList.toggle('hidden', list.length > 0);
  // 映射图与列表同生共死：没有连接就没有可映射的东西
  $('sec-layouts').classList.toggle('hidden', list.length === 0);

  for (const c of list) {
    const li = document.createElement('li');
    // 「当前」和「已连接」是两回事：断开之后活动连接还是它，但没有连着。
    const live = c.id === boot.activeConnectionId && connected;
    li.className = 'conn' + (live ? ' active' : '');

    const t = document.createElement('span');
    t.className = 't';
    // 有备注就显示备注 —— 用户给它起了名，就是为了不必再读地址。
    // 没起名才回落成地址。**两者取其一，不并排显示**：并排等于把备注降级成一个
    // 前缀，那这个名字就白起了，用户还是得去读那串地址。
    t.textContent = c.label || `${c.user}@${c.host}:${c.port}`;
    // 地址仍然在，只是不占地方 —— 鼠标停一下就能看到。
    t.title = `${c.user}@${c.host}:${c.port}`;

    const probe = lastProbe.find((p) => p.id === c.id);
    const m = document.createElement('span');
    m.className = 'm';
    if (live) {
      m.textContent = '已连接';
      m.classList.add('good');
    } else if (!probe) {
      m.textContent = '未探测';
    } else if (probe.reachable) {
      m.textContent = `可达 · ${probe.rttMs}ms`;
    } else {
      m.textContent = `不可达：${probe.error || '失败'}`;
      m.classList.add('bad');
    }

    // 布局组下拉。文案必须说清「切走会发生什么」—— 切走一个只被自己用着的布局
    // 就等于把它删掉（连同里面的标签页和登录状态），这是不可逆的，
    // 只写一个布局名了事会让用户在毫无预告的情况下丢东西。
    const lay = document.createElement('select');
    lay.className = 'lay-pick';
    lay.title = '这条连接用哪个布局（编辑器窗口布局、打开的标签页、登录状态）';
    fillLayoutOptions(lay, c.layoutId, c.id);
    lay.onchange = async () => {
      const v = lay.value;
      const r = await applyLayout(c.id, v === NEW_LAYOUT ? null : v);
      // 失败必须把下拉拨回去 —— 停在一个并未生效的选择上，
      // 界面就在显示一件不成立的事。
      if (!r.ok) lay.value = c.layoutId;
    };

    // 主动断开。断的只是客户端这一跳 —— 作业还在集群上跑着，
    // 再点「连接」会重新接上它。会话进行中不给断（主进程也会拒）。
    const main = document.createElement('button');
    main.className = 'tiny' + (live ? ' ghost danger-ghost' : '');
    main.textContent = live ? '断开' : '连接';
    main.onclick = () => (live ? doDisconnect() : doConnectTo(c));

    // 编辑：地址 / 这条连接自己的密钥。
    const edit = document.createElement('button');
    edit.className = 'ghost tiny';
    edit.textContent = '编辑';
    edit.onclick = () => openEditForm(c);

    const del = document.createElement('button');
    del.className = 'ghost tiny danger-ghost';
    del.textContent = '删除';
    del.disabled = live;              // 连着的时候先断开再删，别让作业失去主人
    del.onclick = async () => {
      // 删除现在连带销毁这条连接的私钥，所以要先问一句 —— 它是一条不可逆的操作，
      // 而且用户已经拿去 IDM 注册过的公钥会就此作废（重新建一条要重新注册）。
      //
      // ★ 还有一样会被删掉：**最后一个用某个布局组的连接被删掉时，那个布局组的
      //   数据也一起清**（浏览器存储 + 插件写到磁盘上的文件）—— 主进程那边是
      //   `commitConfig` → `pruneLayouts` → `clearLayoutStorage`。
      //   判据与主进程**同源**：`layoutPlan` 的 `soleOwnerId` 就是从"只有这一条
      //   连接在用它"推出来的，与 `pruneLayouts` 数的是同一件事。
      const sole = (boot.layouts || []).find((l) => l.soleOwnerId === c.id);
      const sure = window.confirm(
        `删除「${c.user}@${c.host}:${c.port}」？\n\n`
        + '这条连接的私钥会一起删掉。你注册到 IDM 的那把公钥随之作废，'
        + '重建一条需要重新注册。\n'
        + (sole
          ? `\n★ 「${sole.name}」只有这一条连接在用，所以它也会被删掉 —— 里面的`
            + '编辑器布局、登录状态，以及插件写在磁盘上的那些文件都会一起没掉，'
            + '而且找不回来。\n'
          : ''));
      if (!sure) return;
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
    };

    li.append(t, m, lay, main, edit, del);
    box.append(li);
  }

  renderLayoutMap();
}

// ── 布局组 ──────────────────────────────────────────────────────────────────
/**
 * 一条连接只用一个布局，一个布局可以被多条连接共用；没有任何连接在用的布局
 * 会被主进程回收。
 *
 * ★ 这一段**不做任何推导**。`boot.layouts` 是主进程用 layoutPlan() 算好的
 *   （每组带 members / refCount / soleOwnerId），界面只负责渲染。
 *   理由不是懒：界面手里那份随时可能已经陈旧（另一条连接刚被删），而
 *   「切走会不会把这个布局删掉」是一个**不可逆**的判断，必须由主进程说了算。
 */

function layoutById(id) {
  return (boot.layouts || []).find((l) => l.id === id) || null;
}

/** 连接的名字。布局的说明文字里要引用成员，用同一条规则取名才不会两处对不上。 */
function connName(id) {
  const c = (boot.connections || []).find((x) => x.id === id);
  return c ? (c.label || `${c.user}@${c.host}`) : '另一条连接';
}

/** 一个布局组后面跟的那句说明。 */
function layoutNote(l, connId) {
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

/** 当前活跃连接的布局组 id。 */
function activeConnLayoutId() {
  const id = boot && boot.activeConnectionId;
  const c = (boot && boot.connections || []).find((x) => x.id === id);
  return c ? c.layoutId : null;
}

/**
 * 把一个布局下拉填满。每条连接行一个、状态条一个，**共用同一份 boot.layouts**。
 *
 * `keep` 是应当选中的那个组。**找不到就不选**（宁可空着）—— 让下拉停在一个
 * 并不生效的值上，用户会以为自己已经切过去了。
 *
 * `sig` 是给状态条用的：它在每次快照推送时都会被重填，而重建 <select> 会把用户
 * 正在展开的列表收起来。内容没变就不动 DOM。
 */
function fillLayoutOptions(sel, keep, connId) {
  const list = boot.layouts || [];
  const sig = connId + '|' + JSON.stringify(
    list.map((l) => [l.id, l.name, l.refCount, l.soleOwnerId]));
  if (sel.dataset.sig !== sig) {
    sel.textContent = '';
    for (const l of list) {
      const o = document.createElement('option');
      o.value = l.id;
      o.textContent = `${l.name}${layoutNote(l, connId)}`;
      sel.append(o);
    }
    const nu = document.createElement('option');
    nu.value = NEW_LAYOUT;
    nu.textContent = '＋ 新建空白布局…';
    sel.append(nu);
    sel.dataset.sig = sig;
  }
  sel.value = list.some((l) => l.id === keep) ? keep : '';
}

/** 状态条里那个选择器。它改的是**当前活跃连接**的布局组。 */
function renderLayoutSelectors() {
  const sel = $('sb-layout');
  if (!sel) return;
  // 运行期间以快照为准（那才是会话真正跑着的布局）；没有会话时用连接自己的标记。
  const cur = (lastSnap && lastSnap.layoutId) || activeConnLayoutId();
  fillLayoutOptions(sel, cur, boot && boot.activeConnectionId);
}

/**
 * 切走一个独占布局之前的二次确认。
 *
 * 文案里必须出现「未保存的编辑内容会丢失」—— 这比「布局变了」严重得多：
 * 换布局 = 换 origin，浏览器是在**重新加载**那个页面，终端里没保存的东西就没了。
 * 用户有权在按下去之前知道这一条。
 */
function confirmDiscard(name) {
  const live = lastSnap && lastSnap.state
    && lastSnap.state !== 'idle' && lastSnap.state !== 'ended';
  return window.confirm(
    `「${name}」现在只有这一条连接在用，切走之后它会被删除。\n\n`
    + '它的编辑器窗口布局、打开的标签页和登录状态都会一起没掉，'
    + '插件写在磁盘上的那些文件也一样 —— 而且找不回来。\n'
    + (live ? '\n★ 当前页面会重新加载到新布局，未保存的编辑内容会丢失。\n' : '')
    + '\n确定要切换吗？');
}

/**
 * 把一条连接切到另一个布局组。**三条入口共用这一条**（连接行下拉、状态条、
 * 映射图上的改名按钮改的是名字，不走这里）。
 *
 * @param {string} connectionId
 * @param {string|null} layoutId  null = 新建一个空白布局并落进去
 * @returns {Promise<{ok:boolean}>} 失败时调用方应把下拉拨回原值
 *
 * ★ 「切走会不会把旧布局删掉」的判定权在**主进程**，不在这里。先照常提交，
 *   主进程若回 would_discard，我们拿它的原话去问用户，确认了再带 confirmDiscard
 *   重来一次。这样无论界面手里那份 refCount 有多陈旧，问出来的问题都是真的。
 */
async function applyLayout(connectionId, layoutId) {
  let r = await window.slurmate.setConnectionLayout({ connectionId, layoutId });

  if (!r.ok && r.code === 'would_discard') {
    if (!confirmDiscard(r.layoutName)) return { ok: false };
    r = await window.slurmate.setConnectionLayout(
      { connectionId, layoutId, confirmDiscard: true });
  }
  if (!r.ok) {
    notice('error', r.error || '切换布局失败。');
    return { ok: false };
  }

  // 会话活着时，这一句要说清「作业没动」—— 用户看到页面重新加载，
  // 最容易的联想是「我的作业是不是被重启了」。它没有。
  const wasRunning = lastSnap && lastSnap.state === 'running';
  boot.layouts = r.layouts || boot.layouts;
  boot.connections = r.connections || boot.connections;
  renderConnections(boot.connections);
  notice('info', wasRunning
    ? '已切换布局。页面会重新加载一次；计算节点上的作业没有受影响，仍然在跑。'
    : '已切换布局。');
  // 拉一次权威状态：会话的 layoutId 刚变，界面手里那份还是旧的，而状态条正是
  // 拿它显示当前布局的 —— 不拉就会继续显示上一个。
  renderSessions(await window.slurmate.states());
  return { ok: true };
}

// ── 映射图 ──────────────────────────────────────────────────────────────────
// 画线时要拿节点的几何位置，所以渲染出来的节点按 id 存着。
const mapNodes = { conn: new Map(), layout: new Map() };

function renderLayoutMap() {
  const connsCol = $('lmap-conns');
  const laysCol = $('lmap-layouts');
  if (!connsCol || !laysCol) return;
  connsCol.textContent = '';
  laysCol.textContent = '';
  $('lmap-lines').textContent = '';
  mapNodes.conn.clear();
  mapNodes.layout.clear();

  for (const c of boot.connections || []) {
    const n = document.createElement('div');
    n.className = 'lnode' + (c.id === boot.activeConnectionId ? ' cur' : '');
    n.title = `${c.user}@${c.host}:${c.port}`;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = c.label || `${c.user}@${c.host}`;
    n.append(nm);
    connsCol.append(n);
    mapNodes.conn.set(c.id, n);
  }

  const runtime = lastSnap && lastSnap.layoutId;
  for (const l of boot.layouts || []) {
    const n = document.createElement('div');
    n.className = 'lnode lay' + (l.id === runtime ? ' cur' : '');

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = l.name;

    // 引用计数直接摆出来 —— 「这个布局还有谁在用」正是这张图存在的理由
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = l.refCount === 0 ? '没人用'
      : l.refCount === 1 ? '1 条连接' : `${l.refCount} 条连接`;

    const rn = document.createElement('button');
    rn.className = 'ghost tiny';
    rn.textContent = '改名';
    rn.onclick = () => startRename(l, nm);

    n.append(nm, meta, rn);
    laysCol.append(n);
    mapNodes.layout.set(l.id, n);
  }

  requestAnimationFrame(drawLayoutLines);
}

/**
 * 画连线。
 *
 * ★ 用 SVG 的 <path d="…">：`d` 是**几何**属性，不在那条 CSP 的管辖范围内
 *   （它禁的是 style="…" 内联样式）。线的粗细颜色走 app.css 的 .edge 类。
 *   坐标全部由 getBoundingClientRect 现算 —— 所以任何一次布局变化之后都要重画。
 */
function drawLayoutLines() {
  const box = $('layout-map');
  const svg = $('lmap-lines');
  if (!box || !svg) return;
  if (box.classList.contains('hidden') || $('sec-layouts').classList.contains('hidden')) return;
  svg.textContent = '';
  const base = box.getBoundingClientRect();
  if (!base.width || !base.height) return;      // 这一屏还没被布局出来
  svg.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
  svg.setAttribute('width', String(base.width));
  svg.setAttribute('height', String(base.height));

  for (const c of boot.connections || []) {
    const a = mapNodes.conn.get(c.id);
    const b = mapNodes.layout.get(c.layoutId);
    if (!a || !b) continue;                     // 只有一头在，宁可不画也不画半条
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
    p.setAttribute('class', c.id === boot.activeConnectionId ? 'edge cur' : 'edge');
    svg.append(p);
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
    const r = await window.slurmate.renameLayout({ layoutId: l.id, name });
    if (!r.ok) return notice('error', r.error || '改名失败。');
    boot.layouts = r.layouts || boot.layouts;
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
  // ── 站点有而本机没有 ──
  //
  // ★ 「一个都没装」与「版本对不上」在 `missing` 里长得**一模一样**（都是"站点报
  //   了一个本机查不到的 (id, 版本)"），但要做的事完全不同：去装一个 vs 去换一版。
  //   判据是**池空不空**。以前这里只有一种说法，于是零插件时它会对着站点上每一个
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

    // ★ **这里从前还有第三条出路**：「本机插件目录里有东西，但没被加载 —— 去把
    //   开发者模式打开」。它随本机池一起删掉了。今天池里有什么就加载什么，
    //   "有东西但没加载"这一态不存在。
  }
}

/**
 * 本机一个插件都没有。
 *
 * ★ 以前这里写的是「这个客户端一个插件都没有 —— **安装包可能不完整**」。那句话
 *   把一个**每个客户端都有的初始状态**说成了故障，而且没有给出任何出路。
 *
 * ★ 现在出路**变了，而且是变简单了**：插件默认由站点分发，所以这个空态的答案是
 *   "连上站点、点重新同步"，而不是"自己去找一个插件目录装进去"。以前那个
 *   「从一个包安装…」的入口现在落在开发者模式那一节里 —— 默认路径上"禁止自装"
 *   必须是真的。
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
      // ★ v0.6 时这句话后面还跟着"这一次它退回了逐份取那条路"—— 今天**没有退路
      //   了**（那条路在 v0.7 删掉了）。所以那些插件是**真的装不上**，而这句话必须
      //   这么说；含糊成"能装上就好"会让用户以为已经好了，其实一个都没装上。
      //
      // ★★ 而**加了版本握手之后，这句话还能说得更准**：客户端手里已经有服务端的
      //   真版本号了，所以"站点比客户端新"不再是一个**推断**，而是一个**被检验过
      //   的结论**：
      //     · 跨大版本 ⇒ 站点是新一代是**对的**，那时格式更新本就在预期之内；
      //     · 其它情形（握手说客户端不低于服务端）⇒ 服务端**不可能更新** ⇒
      //       格式比客户端新只可能是**站点自己不一致**（版本号没升而格式升了，
      //       违反了"格式号只因基座版本升而升"那条纪律）。说成"升级客户端"会把
      //       用户指去干一件**解决不了问题**的事 —— 而这句话从前正是那么说的。
      if (site.daemonVersionVerdict === 'cross_major') {
        d.append(el('p', 'why', '这个站点发的插件包用的是更新的格式，而这个客户端还不认识 ——'
          + '这一版的客户端没有别的办法把它取回来。这个集群的服务端与本客户端**大版本'
          + '不同**，请升级这个客户端。'));
      } else {
        d.append(el('p', 'why', '这个站点发的插件包用的是更新的格式，而这个客户端还不认识 ——'
          + '这一版的客户端没有别的办法把它取回来。★ 而这个站点报的基座版本并不比本'
          + '客户端新，所以**升级客户端解决不了它**：是站点自己不一致（版本号没升，'
          + '包格式却升了）。请让管理员看这个站点的部署。'));
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
    if (site.recordOk === false) {
      d.append(el('p', 'why',
        '站点的插件记录读不出来（或者写不下去），所以这一轮**没有回收任何旧版本** —— '
        + '不知道谁在引用的时候，唯一安全的动作是什么都不删。'));
    }

    // §5.3：本机那一份不在了 ⇒ 同意作废，本轮会重新问一次。
    // ★ **不说"是你删的"** —— 客户端不知道原因（可能是他删的，可能是别的什么）。
    if (site.withdrawn) {
      d.append(el('p', 'why',
        `有 ${site.withdrawn} 个插件本机那一份已经不在了，所以它们上一次的同意已经作废 —— `
        + '本轮会重新问一次。删掉本机一份就等于撤回同意：不这么算的话，下一次对账会'
        + '按"摘要与上次一致"把它**静默装回来**。'));
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
        // ★ 包单独不在了要**如实说**：它是这一份的来路凭证，而用户打开那个目录
        //   就会发现少了一个文件。它**不构成撤回**（能加载的是树），也不会被
        //   静默取回来 —— 所以这里只说事实，不给一个"修一下"的按钮。
        if (!v.hasPackage) {
          li.append(document.createTextNode('（只有解出来的树，没有包）'));
        }
        ul.append(li);
      }
      d.append(el('p', 'plug-desc', '本机站点池里的版本：'));
      d.append(ul);
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
    (anyNew ? '它们已经取回到本机、包里每一份都核过了，但**还没有装上去** —— 要你先点一下同意。' : '')
    + (anyNew && anyHere ? '\n' : '')
    + (anyHere ? '另外有几个**本机已经有一份**，而它没有在同意台账里（你换过机器、'
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
      + (c.existing ? '这一份已经在你的本机上了。' : '')
      // ★ 少核了一半要说出来。本机只有解出来的树、那个包不在了的时候，这一次
      //   只核了内容摘要，没法逐份比对 —— 而用户正在为"这一份"点同意，他有权
      //   知道我们核到了什么程度。不说的话，两种核对看起来一模一样。
      + (c.compared === false
        ? '（本机只剩解出来的树、没有它的包 —— 这一次只核了内容摘要。）' : '');
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
      : '这一份**没有签名**。签名在插件规范里是可选的（§4.1），所以这不是错误；'
        + '但它意味着"内容与上次一致"是这里唯一能给你的保证。';
    one.append(who2);

    const warn = document.createElement('p');
    warn.className = 'why';
    warn.textContent = '同意之后，这个插件的客户端代码会在你这台机器上运行'
      + '（与客户端同一个进程、同样的权限，目前**没有进程隔离**）。'
      + '不确定来源时不要同意 —— 不同意的话，它在暂存里那一份会被删掉，站点上那份不受影响。';
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
    + '原因只有一个：**你还没有同意过这一份**，而本站此刻没有在报它们 ——'
    + '所以暂时没有"同意"这个入口（管理员把插件关掉了的时候就是这样）。'));
  d.append(el('p', 'plug-desc',
    '它们不会被加载，也不会被回收：**站点不报一个插件不构成删除它的理由** ——'
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
 * 它们不是"问题"，而且那件事有更好的走法：换一个布局组（`＋ 新建空白布局…`）会换
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
  if (!rows.length && d && d.diskChecked) {
    sec.classList.add('hidden');
    return;
  }
  sec.classList.remove('hidden');

  const wrap = document.createElement('div');
  wrap.className = 'plug plug-off';
  const head = document.createElement('div');
  head.className = 'plug-head';
  head.append(el('h3', null, rows.length
    ? `本机有 ${rows.length} 份插件数据没人在用`
    : '本机的插件数据'));
  wrap.append(head);

  if (!d || !d.diskChecked) {
    wrap.append(el('p', 'plug-desc', (d && d.why)
      || '这一次没能去看磁盘上还剩哪些，所以这里没有东西可列。'));
  } else {
    wrap.append(el('p', 'plug-desc',
      '插件在运行中攒下的东西按**份**存在本机，一份 = 一个插件 + 共享组 + 布局组。'
      + '一份数据有两个落点：**浏览器里的存储**（编辑器布局、打开的标签页、登录状态），'
      + '以及**插件自己写在磁盘上的文件**。下面这些**没有任何连接在用**：它们要么'
      + '属于一个已经删掉的布局组，要么属于一个已经不在本机的插件版本。'));
    wrap.append(el('p', 'plug-desc',
      '★ 删掉一份**找不回来** —— 那个插件下次打开会是一份全新的空白存储。'
      + '想重置**正在用**的那一份，用布局下拉里的「＋ 新建空白布局…」。'));
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
      row.append(button('删掉这一份', () => dropPluginData(r), 'ghost'));
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
    + '以及那个插件**写在磁盘上的文件**。';
  if (d) return '它是那个插件**写在磁盘上的文件**。';
  return '它在浏览器里（那个插件没有另外往磁盘上写东西）。';
}

/** 删掉一份插件数据。**不可逆**，所以先问一句（照「删除连接」那条的语气）。 */
async function dropPluginData(r) {
  const parts = (r.places || []).includes('data')
    ? '其中包括那个插件**写在磁盘上的文件**，它下次会从零开始'
    : '那是它在本机攒下的编辑器布局、打开的标签页和登录状态';
  const sure = window.confirm(
    `删掉「${r.label}」？\n\n`
    + `${parts}，删掉之后**找不回来**。\n\n确定要删吗？`);
  if (!sure) return;
  const res = await window.slurmate.deletePluginData({ name: r.name });
  if (!res || !res.ok) {
    // `stale` 由主进程给一句能直接读的话（判定权在它那儿）。
    return notice('error', (res && res.error) || '没能删掉。');
  }
  notice('info', `已删掉「${res.label || r.label}」。`);
  renderPluginData(res);
}

// ★ **这里从前有一节「开发者」，装着「也加载本机插件目录（开发用）」那个复选框
//   和「从一个包安装…」「打开插件目录」「重新扫描」三个按钮。** 它随本机池一起
//   删掉了，连同 `#plugin-dev` 那个容器。
//
//   值得记一笔的是它当初的形状：**那些入口默认是藏起来的**，理由写在注释里 ——
//   "于是'禁止自装'在默认路径上是**真的**"。那句自我描述其实已经把问题说出来了：
//   一个需要靠"默认藏起来"才成立的禁令，不是禁令，是一个开关。而
//   `docs/PLUGIN-SPEC.md` §5.2 要的是**没有分支**（"禁止给任何一类插件开免同意
//   的口子"）。今天池子只有一条来的路，所以这里没有开关可藏。

async function syncPlugins() {
  const r = await window.slurmate.syncPlugins();
  if (r && r.plugins) renderPlugins(r.plugins);
  else notice('error', (r && r.error) || '重新同步失败');
  syncPurposeVisibility();
}

async function consentPlugin(id, version) {
  const r = await window.slurmate.consentPlugin(id, version);
  if (r && r.plugins) renderPlugins(r.plugins);
  if (!r || !r.ok) notice('error', (r && r.error) || '没能同意这个插件');
  syncPurposeVisibility();
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
  syncPurposeVisibility();
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
  // ★ **这里从前会贴一个来源标签**（"站点分发" / "本机安装"）。池只剩一个之后
  //   它恒为空 —— 每一块都是站点分发，贴上去是一句说了等于没说的话。所以连同
  //   主进程那半（`pluginsView` 的 `sourceLabel`）一起删了。
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

  const def = p.defaults;
  meta.append(el('span', null, def
    ? `默认 ${def.cpus} 核 / ${def.mem}`
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
    const gpus = $('f-gpus').value.trim();
    const part = $('f-part').value;
    if (cpus) res.cpus = Number(cpus);
    if (mem) res.mem = mem;
    if (gpus !== '') res.gpus = Number(gpus);
    if (part) res.partition = part;

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

// ── 分区 ────────────────────────────────────────────────────────────────────
function renderPartitions(list) {
  const sel = $('f-part');
  const keep = sel.value;
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
async function init() {
  boot = await window.slurmate.bootstrap();

  if (boot.dev) {
    $('dev-banner').classList.remove('hidden');
    $('app-sub').textContent = '开发者模式 · 未连接集群';
  } else if (boot.backendLabel) {
    $('app-sub').textContent = boot.backendLabel;
  }
  renderDevMode(boot.developerMode);

  // ★ bootstrap 里**没有**公钥 —— 密钥是按连接的，界面在打开某条连接的表单时
  //   单独去问（app:publicKey / app:newKey）。曾经这里从 bootstrap 读全局的
  //   keyFingerprint，而字段名对不上，于是指纹从来没在首屏出现过；
  //   现在那条路径整个不存在了，每个字段都是问出来的、当场渲染的。
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

  // 当前表单在操作哪把密钥。新建时是那把还没有归属的，编辑时是这条连接的。
  const keyPayload = () =>
    (form.mode === 'edit' && form.id ? { connectionId: form.id } : undefined);

  // ── 事件 ──
  $('btn-new').onclick = () => openNewForm();
  $('btn-cancel-form').onclick = () => closeForm();

  $('btn-copykey').onclick = async () => {
    const r = await window.slurmate.copyPublicKey(keyPayload());
    notice(r.ok ? 'ok' : 'error', r.ok ? '公钥已复制到剪贴板。' : (r && r.error) || '复制失败。');
  };

  $('btn-regen').onclick = async () => {
    const which = form.mode === 'edit' ? '这条连接的' : '这把';
    const yes = window.confirm(
      `重新生成会作废${which}密钥。\n\n`
      + '你必须把新的公钥重新注册到 IDM，否则连不上。\n\n确定要重新生成吗？');
    if (!yes) return;
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

    const saved = await window.slurmate.saveConnection(input);
    if (!saved.ok) return notice('error', saved.error);
    boot.connections = saved.connections;
    boot.activeConnectionId = saved.connection.id;
    renderConnections(boot.connections);

    if (editing) {
      const wasLive = connected && saved.connection.id === boot.activeConnectionId;
      closeForm();
      notice('ok', '已保存这条连接。');
      if (wasLive) {
        // 地址改了但 SSH 连接还挂在旧地址上。不说的话，用户会以为改动没生效。
        notice('info', '这条连接正连着 —— 新地址要重新点一次「连接」才会生效。');
      }
      return;
    }

    notice('info', saved.created ? '已保存这条连接。' : '这条连接之前就保存过了，直接用它。');
    await handleConnectResult(
      await window.slurmate.connect({ connectionId: saved.connection.id }));
    // ★ 无论连上没连上，表单都收起来。
    //   此前没连上时会把表单再摆回来，用户看到的是「刚保存完又弹出一个新建连接」——
    //   像是什么都没存进去。这条连接已经在右上角下面的列表里了，它有「连接」「编辑」
    //   两个按钮；连不上时日志里那条错误会说清楚下一步该做什么。
    closeForm();
  };

  $('btn-probe').onclick = doProbe;


  // ★ 这里从前有一句：「『从一个包安装…』『打开插件目录』『重新扫描』**不在这里
  //   绑** —— 它们只在开发者模式那一节里出现，默认路径上"禁止自装"因此是真的」。
  //   那三个按钮已经不存在了。

  // ★ 站点对账是后台跑的，跑完**主动推**一份新视图过来。不接这条的话，用户看到的
  //   永远是连接那一刻的旧视图 —— 而"插件明明是站点说要给的、界面上却什么都没有"
  //   正是这个功能最该避免的那句话。
  window.slurmate.onPlugins((pv) => {
    if (!pv) return;
    renderPlugins(pv);
    syncPurposeVisibility();
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

  // 重新加载打的是**前台**那一条 —— 屏幕只有一块，用户看的正是它。
  $('btn-reload').onclick = () => window.slurmate.reload(frontSlot());
  $('sb-reload').onclick = () => window.slurmate.reload(frontSlot());
  $('btn-end').onclick = () => endSession();
  $('sb-end').onclick = () => endSession();

  // 状态条里的布局选择器 —— 会话跑起来之后唯一够得着的入口。
  // 它改的是当前活跃连接的布局组（会话正跑在它上面，所以会立刻换端口重连隧道，
  // 而集群上的作业一动不动）。
  $('sb-layout').onchange = async () => {
    const v = $('sb-layout').value;
    const r = await applyLayout(boot.activeConnectionId, v === NEW_LAYOUT ? null : v);
    if (!r.ok) renderLayoutSelectors();     // 拨回真正的当前值
  };

  // 窗口大小变了，连线的坐标就全变了。rAF 里重画，等布局定下来。
  window.addEventListener('resize', () => requestAnimationFrame(drawLayoutLines));

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

  window.slurmate.onStates(renderSessions);
  window.slurmate.onNotice((n) => {
    if (n.kind === 'dev') { $('dev-banner').classList.remove('hidden'); return; }
    if (n.kind === 'key-seen' || n.kind === 'key-blocked') {
      // 快捷键诊断：刻意记进日志，便于在真机上核对「哪些键到了页面、哪些被吞了」
      notice('info', (n.kind === 'key-blocked' ? '已拦截：' : '已放行：') + n.text);
      return;
    }
    // ★ `warn` **要留住**：`notice()` 的标签表里 `warn: '注意'` 一直都在，而这里从前
    //   把它折成了 `info` —— 于是主进程发来的每一条警告（例如"布局组已删除，但它那份
    //   浏览器存储没能清干净"）在日志里都长成「信息」。一条显示成信息的失败，与一条
    //   被吞掉的失败是同一件事。
    notice(['ok', 'error', 'warn'].includes(n.kind) ? n.kind : 'info', n.text);
  });

  // 拉一次全部会话（启动时可能自动接上了**几条**）
  const st = await window.slurmate.states();
  if (st && st.sessions && st.sessions.some((x) => x.live)) connected = true;
  // connected 是刚刚才定下来的，而连接列表在上面就已经渲染过了 ——
  // 补一次，否则自动接上会话时那一条不会显示「已连接」
  renderConnections(boot.connections);
  renderSessions(st || { sessions: [], front: null });
}

/** 连上列表里的某一条。点它就等于把它设为当前连接。 */
async function doConnectTo(c) {
  const r = await window.slurmate.setActiveConnection(c.id);
  if (!r.ok) return notice('error', r.error);
  boot.activeConnectionId = c.id;
  renderConnections(boot.connections);
  await handleConnectResult(await window.slurmate.connect({ connectionId: c.id }));
}

/**
 * 主动断开。
 *
 * ★ 断开 = **彻底终止**。还有会话的话先取消作业、释放资源，再拆连接。
 *   「断开」和「结束会话」在这里是同一件事的两种说法，因为对用户来说
 *   它们的意思本来就一样：我不要了。凡是用户主动表达的终止，都不该留下
 *   一个还在集群上占着资源的作业。
 *
 *   反过来，合盖/断网/断电时这个函数不会被调用 —— 那条路走守护进程的
 *   suspect/orphaned 容错窗口，客户端下次启动自动接回。
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
  renderConnections(boot.connections);
  renderSessions({ sessions: [], front: null });
}

async function endSession() {
  // ★ **指名**结束哪一条（前台那一条）—— 主进程不收没名字的 stop，
  //   那个隐式缺省在多开下会变成"停错了另一条"。
  const slot = frontSlot();
  if (!slot) return;
  const res = await window.slurmate.stop(slot);
  if (res && res.ok) {
    notice('info', res.detail || '已请求释放。');
    if (res.state === 'releasing') {
      notice('warn',
        '已请求释放，但这只表示控制节点开始处理 —— 它并不保证作业真的被取消了。'
        + '请以状态条变为「已结束」为准。');
    }
  } else if (res) {
    notice('error', res.detail || '释放失败。');
  }
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
      // 曾经这里写死成「三个地址都不可达」，而候选其实是 0 个。
      notice('info', '还没有保存任何连接。填好上面的用户名、主机、端口，点「保存并连接」。');
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

init().catch((e) => notice('error', '界面初始化失败：' + e.message));
