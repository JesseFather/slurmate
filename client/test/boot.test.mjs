/**
 * boot.test.mjs —— 启动路径（index.js + windows.js）。
 *
 * 这两个模块是唯一没被别的测试碰到的，而它们恰恰是「一跑就炸」的地方：
 * require 路径写错、Electron API 名字写错（比如 safeStorage 没有 isAvailable）、
 * 启动顺序不对。这些在真机上表现为白屏或直接退出，排查成本很高。
 *
 * 本机没有 Xvfb 跑不了真 Electron，所以用一个够完整的桩把整个 boot 走一遍。
 * 这不替代真机验证，但能把「根本起不来」这一类和「界面画得对不对」分开。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-boot-'));
/**
 * 假的「家目录」。
 *
 * ★ 不能用 os.tmpdir()：真正模式下的中转站会往 `app.getPath('home')` 写
 *   `~/.ssh/config`，而 `os.tmpdir()` 是一个**大家共用、且会被之前的运行留下东西**
 *   的目录 —— 拿它当断言目标，「演示模式没碰真家目录」这条会变成一个看运气的用例
 *   （跑过一次真写之后，后面每次都会红）。给一个每次全新的空目录，这条断言就
 *   真的在断言「我们没往那儿写」，而不是在断言「这个目录恰好不存在」。
 */
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-home-'));

// ── 插件池 ──────────────────────────────────────────────────────────────────
//
// 演示模式的池 = `<userData>/demo-config/plugins`（见 index.js 的 poolDir）。
//
// ★ 装进去的是仓库里**真的**那两个插件（`<repo>/plugins/`），不是测试里合成的
//   替身。这两个插件与基座的接口正是这次改动反复在动的东西 —— 用替身测等于
//   测了个寂寞，而"基座里一个插件名都没有"这件事也就没有被真正验过。
//
// ★ **必须在 app 起来之前写进去**：注册表是在启动时扫的（那一屏的空态、
//   按钮由它决定），而 index.js 只 require 一次。
const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const demoPool = path.join(userData, 'demo-config', 'plugins');

/**
 * 把池设成指定的几个插件（名字对应 `<repo>/plugins/<名字>`），并重扫。
 *
 * 传空数组 = **一个插件都没有** —— 那是基座的正常状态，也得能被测到。
 */
function setPool(names) {
  fs.rmSync(demoPool, { recursive: true, force: true });
  fs.mkdirSync(demoPool, { recursive: true });
  for (const n of names) {
    fs.cpSync(path.join(REPO, 'plugins', n), path.join(demoPool, n), { recursive: true });
  }
  require('../src/main/index.js')._test.getRegistry().reload();
}

/** 跑一段需要一个特定插件集合的代码，跑完恢复成两个都装。 */
async function withPool(names, fn) {
  setPool(names);
  try {
    return await fn();
  } finally {
    setPool(['code-server', 'sshd']);
  }
}

// 全套件的缺省：两个插件都装着。单个用例要别的组合就用 withPool。
fs.mkdirSync(demoPool, { recursive: true });
for (const n of ['code-server', 'sshd']) {
  fs.cpSync(path.join(REPO, 'plugins', n), path.join(demoPool, n), { recursive: true });
}

// ── Electron 桩 ─────────────────────────────────────────────────────────────
const calls = { titles: [], notices: [], ipc: new Map(), menus: 0, windows: [], views: [] };
/** partition → cookie jar。用来验证「登录判定靠 cookie jar 而不是状态码」。 */
const partitionJars = {};

class FakeWebContents {
  constructor() { this.handlers = {}; this._destroyed = false; this._url = ''; }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
  once(ev, fn) { return this.on(ev, fn); }
  removeListener(ev, fn) {
    this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn);
  }
  send(ch, payload) { (this.handlers[`send:${ch}`] = this.handlers[`send:${ch}`] || []).push(payload); }
  isDestroyed() { return this._destroyed; }
  close() { this._destroyed = true; }
  isLoading() { return false; }
  getURL() { return this._url; }
  loadURL(u) { this._url = u; return Promise.resolve(); }
  loadFile(p) { this._url = 'file://' + p; return Promise.resolve(); }
  reload() {}
  focus() {}
  setWindowOpenHandler() {}
  executeJavaScript() { return Promise.resolve(); }
}

class FakeWebContentsView {
  constructor(opts = {}) {
    this.webContents = new FakeWebContents();
    // code-server 视图必须跑在自己的 partition 里（persist:layout-<布局组 id>）。
    // 登录要在这个 partition 的 cookie jar 里查 —— 所以桩也得把 session 接上。
    this.webContents.session =
      electronStub.session.fromPartition(opts.webPreferences && opts.webPreferences.partition);
    this._visible = true;
    this._opts = opts;
    this._bounds = null;
    calls.views.push(this);
  }
  setBounds(b) { this._bounds = b; }
  setVisible(v) { this._visible = v; }
}

class FakeBrowserWindow {
  constructor(opts = {}) {
    this.opts = opts;
    this.webContents = new FakeWebContents();
    this.contentView = {
      addChildView: () => {}, removeChildView: () => {},
    };
    this._destroyed = false;
    this._handlers = {};
    this._size = [1280, 860];
    calls.windows.push(this);
  }
  loadFile() { return Promise.resolve(); }
  once(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn);
                 if (ev === 'ready-to-show') fn(); return this; }
  on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); return this; }
  isDestroyed() { return this._destroyed; }
  getContentSize() { return this._size; }
  setMenuBarVisibility() {}
  setTitle(t) { calls.titles.push(t); }
  setProgressBar() {}
  show() {}
  focus() {}
  isMinimized() { return false; }
  restore() {}
  close() {}
  destroy() { this._destroyed = true; }
}

const electronStub = {
  app: {
    getPath: (k) => (k === 'userData' ? userData : fakeHome),
    getVersion: () => '0.1.0-test',
    on: () => {},
    // 立刻 resolve：index.js 的启动链挂在 whenReady().then(...) 上，
    // 返回一个永不 settle 的 promise 会让整条链悬住、测试进程直接退出。
    whenReady: () => Promise.resolve(),
    quit: () => { calls.quit = true; },
    exit: () => { calls.exit = true; },
    requestSingleInstanceLock: () => true,
  },
  BrowserWindow: FakeBrowserWindow,
  WebContentsView: FakeWebContentsView,
  Menu: {
    setApplicationMenu: () => { calls.menus++; },
    buildFromTemplate: (tpl) => ({ tpl }),
  },
  ipcMain: {
    handle: (ch, fn) => { calls.ipc.set(ch, fn); },
  },
  // 真的走 HTTP、真的记 cookie 的 session 桩。
  // 如果把 fetch 换成 `async () => ({status:200})`，登录那段逻辑就完全没被测到 ——
  // 而它恰恰是三条「不要改坏」的约束之一。
  session: {
    fromPartition: (partition) => {
      const jar = (partitionJars[partition] = partitionJars[partition] || new Map());
      return {
        cookies: {
          get: async ({ name }) => (jar.has(name) ? [{ name, value: jar.get(name) }] : []),
        },
        fetch: async (url, opts) => {
          const res = await fetch(url, opts);
          const sc = res.headers.get('set-cookie');
          if (sc) {
            const [k, ...v] = sc.split(';')[0].split('=');
            jar.set(k, v.join('='));
          }
          return res;
        },
      };
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,     // 模拟「没有凭据库」，顺便验证降级路径
    encryptString: () => { throw new Error('不该被调用'); },
    decryptString: () => { throw new Error('不该被调用'); },
  },
  shell: { openExternal: async () => {} },
  dialog: { showMessageBox: async () => ({ response: 2 }) },
  clipboard: { writeText: (t) => { calls.clipboard = t; } },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};

const require = createRequire(import.meta.url);

// 演示模式：让 createBackend 走演示后端，避免走「未实现」的 SSH 后端
process.argv.push('--demo');
// 把「等待登记」压到 200ms，好在测试里走到 running 态。真实后端不读这个。
process.env.SLURMATE_DEMO_ENROLL_MS = '200';

/**
 * session.js 里的定时器全都 unref 了 —— 在 Electron 里这是对的（窗口/应用撑着事件
 * 循环，定时器不该反过来续命），但在测试进程里没有别的东西撑着，事件循环会在
 * 「等待登记」期间直接排空，测试以 "event loop has already resolved" 收场。
 * 所以测试自己撑一根。
 */
const keeper = setInterval(() => {}, 500);
const T0 = Date.now();
setInterval(() => console.error('PROBE', Date.now() - T0), 2000).unref?.();

/**
 * 收尾。
 *
 * 必须把演示后端关掉 —— 它有一个**真的在监听的 HTTP 服务**，不关的话
 * `node --test` 会一直等这个子进程退出，整个套件就挂住了
 * （表现为：本文件的 8 个用例全过，然后没有 summary、没有退出）。
 */
after(async () => {
  console.error('PROBE-after-start', Date.now() - T0);
  clearInterval(keeper);
  Module._load = origLoad;
  try {
    const idx = require('../src/main/index.js');
    const ctl = idx._test.getController();
    if (ctl) await ctl.stop();
    const b = idx._test.getBackend();
    if (b) await b.close();
  } catch { /* 尽力而为，不要让收尾本身变成失败 */ }
});

/**
 * 调用一个 IPC 处理器。
 * 注意第一个参数是 event —— 直接调 `handler(payload)` 会把 payload 当成 event，
 * 真正的参数变成 undefined。这个错很难看出来，因为处理器返回的是兜底的错误对象。
 */
const invoke = (ch, ...args) => {
  const h = calls.ipc.get(ch);
  assert.ok(h, `IPC 通道 ${ch} 未注册`);
  return h(null, ...args);
};

test('index.js 能加载并完成整个启动流程', async (t) => {
  t.after(() => { Module._load = origLoad; });

  // 这一步就会跑 index.js 的顶层代码（单实例锁 + bootstrap）
  require('../src/main/index.js');
  // 让 whenReady().then(...) 里的 await 链跑完。没有这一步，
  // 下面的断言会在启动流程还没执行时就去查结果。
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(calls.windows.length >= 1, true, '应当创建了窗口');

  const joined = calls.titles.join(' | ');
  assert.match(joined, /演示模式/, '演示模式必须在窗口标题里标注出来');

  // 演示后端启动时会推一条 demo 通知，面板据此显示横幅
  const win = calls.windows[0];
  assert.ok((win.webContents.handlers['send:session:state'] || []).length >= 1,
    '应当向面板推过状态');

  // IPC 通道注册齐全
  for (const ch of ['app:bootstrap', 'app:probeHosts', 'app:connect', 'app:partitions',
                    'app:start', 'app:state', 'app:doctor', 'app:stop', 'app:reload',
                    'app:debug',
                    // 连接管理：地址必须在界面上可填可删 —— 这条曾经是个硬缺口，
                    // extraHosts 只能手改 config.json，面板上根本没有入口。
                    'app:saveConnection', 'app:deleteConnection', 'app:setActiveConnection',
                    // 主动断开：与「结束会话」同义 —— 用户主动表达的终止，
                    // 一律彻底终止（取消作业 + 释放资源），不留下还在烧的作业
                    'app:disconnect',
                    // 密钥与主机密钥。生成只有两个入口：「新建」时的 app:newKey，
                    // 以及用户显式发起的 app:regenerateKey —— 「保存方式」那个
                    // 下拉框已经删掉，私钥永远加密保存。
                    'app:publicKey', 'app:copyPublicKey', 'app:regenerateKey', 'app:newKey',
                    'app:trustHostKey', 'app:forgetHostKey',
                    // 布局组：一条连接指到一个组（多对一），组被引用计数回收。
                    // 切走一个「独占」的组会让它被删掉，所以主进程会先回
                    // code:'would_discard' 让界面确认 —— 判定权在主进程，不在界面。
                    'app:setConnectionLayout', 'app:renameLayout']) {
    assert.ok(calls.ipc.has(ch), `缺少 IPC 通道 ${ch}`);
  }

  // 演示模式必须用独立的配置命名空间 —— 否则演示里配的用户名/端口会污染真连接
  assert.equal(fs.existsSync(path.join(userData, 'config.json')), false,
    '演示模式绝不能往真配置目录里写东西');
});

test('app:bootstrap 报告「没有安全存储」，而不是谎报可用', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const b = await invoke('app:bootstrap');
  assert.equal(b.demo, true);
  assert.equal(b.secureStorageAvailable, false);
  assert.equal(b.backendLabel, '演示后端');
  // 一条连接都没配 —— 这是**真实状态**，界面上要如实显示「还没有配置登录节点」，
  // 而不是编一个默认地址出来。断言它：防的是有人"顺手"把某个集群的真实地址
  // 写回源码，那样每个 clone 的人都会带着那个集群的 IP。
  assert.ok(Array.isArray(b.connections), 'connections 必须是数组');
  assert.equal(b.connections.length, 0, '不得有任何内置的登录节点地址');
  assert.equal(b.connection, undefined, "活动连接不再随 bootstrap 一起下发（它唯一的用途是预填表单，那个行为已删）");
});

test('★ 点开「新建」密钥就已经生成好了，公钥可查（用户要拿去注册）', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const r = await invoke('app:newKey');
  assert.equal(r.ok, true);
  assert.match(r.key.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+=* slurmate-\d{8}-\d{4}$/,
    '公钥必须是 OpenSSH 一行格式，用户要原样粘到 IDM 里');
  assert.match(r.key.fingerprint, /^SHA256:/);
  assert.equal(r.generated, true, '第一次问当然要真的生成一把');
  // 这台机器没有凭据库 —— 密钥只能留在内存里，绝不该悄悄写明文落盘
  assert.equal(r.key.persisted, false, '没有安全存储时不得自动落盘');
  assert.equal(fs.existsSync(path.join(userData, 'demo-config', 'secrets.json')), false,
    '一个字节都不该落盘');

  // ★ 幂等。每次点开「新建」就换一把的话，用户刚复制去 IDM 注册的那把公钥
  //   会当场作废，而他看到的只是「认证失败」。
  const again = await invoke('app:newKey');
  assert.equal(again.generated, false, '第二次必须是复用，不是重新生成');
  assert.equal(again.key.publicKey, r.key.publicKey);
});

test('★ 没有安全存储时，重新生成密钥要明确报告「存不下来」，绝不静默写明文', async (t) => {
  t.after(() => { Module._load = origLoad; });

  const before = await invoke('app:newKey');
  const r = await invoke('app:regenerateKey');       // 不带 connectionId = 「新建」位
  // 密钥本身生成出来了 —— 用户此刻正需要拿它去 IDM 注册，不能因为存不了就什么都不给
  assert.match(r.key.publicKey, /^ssh-ed25519 /);
  assert.notEqual(r.key.publicKey, before.key.publicKey, '重新生成必须真的换一把');
  // 但「存下来了」这件事必须明确否认，界面据此如实告知用户
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_secure_storage');
  assert.equal(fs.existsSync(path.join(userData, 'demo-config', 'secrets.json')), false,
    '一个字节都不该落盘 —— 私钥没有「明文保存」这条退路了');

  const after = await invoke('app:publicKey');
  assert.equal(after.key.persisted, false);
  assert.equal(after.key.publicKey, r.key.publicKey,
    '内存里那把必须换成新的，否则界面显示的公钥是旧的');
});

test('★ 密钥按连接隔离：新建那条拿走「新建位」的钥匙，别的连接不受影响', async (t) => {
  t.after(() => { Module._load = origLoad; });

  // 「新建」时用户已经把公钥复制去 IDM 注册了 —— 保存时必须**原样**把那把交出去
  const pending = (await invoke('app:newKey')).key;
  const a = await invoke('app:saveConnection', { user: 'alice', host: '198.51.100.10', port: 10100 });
  assert.equal(a.ok, true);
  assert.equal(a.key.publicKey, pending.publicKey,
    '新建时生成的那把公钥必须原样交给这条连接，另生成一把会作废用户刚注册的');

  // 交付之后「新建位」就空了，下一次新建是一把新的钥匙
  const next = (await invoke('app:newKey')).key;
  assert.notEqual(next.publicKey, a.key.publicKey);

  const b = await invoke('app:saveConnection', { user: 'bob', host: '203.0.113.7', port: 10100 });
  assert.equal(b.key.publicKey, next.publicKey);
  assert.notEqual(b.key.publicKey, a.key.publicKey, '两条连接各拿各的钥匙');

  // 作废其中一条，另一条必须原样还在
  const regen = await invoke('app:regenerateKey', { connectionId: a.connection.id });
  assert.notEqual(regen.key.publicKey, a.key.publicKey);
  const aAfter = await invoke('app:publicKey', { connectionId: a.connection.id });
  const bAfter = await invoke('app:publicKey', { connectionId: b.connection.id });
  assert.equal(aAfter.key.publicKey, regen.key.publicKey);
  assert.equal(bAfter.key.publicKey, b.key.publicKey, '重新生成一条不该动到另一条');

  assert.equal((await invoke('app:deleteConnection', a.connection.id)).keyDeleted, true,
    '删掉连接时它的私钥要跟着删');
  assert.equal((await invoke('app:deleteConnection', b.connection.id)).keyDeleted, true);
});

test('连接条目：新增 / 设为活动 / 删除，且落盘', async (t) => {
  t.after(() => { Module._load = origLoad; });

  const saved = await invoke('app:saveConnection',
    { user: 'alice', host: '198.51.100.10', port: 10100, label: '内网' });
  assert.equal(saved.ok, true);
  assert.match(saved.connection.id, /^c[0-9a-f]+$/);

  // 不合法的条目必须被拒绝，而不是补个默认值让用户以为存上了
  const bad = await invoke('app:saveConnection', { user: '', host: 'x', port: 10100 });
  assert.equal(bad.ok, false);

  const b = await invoke('app:bootstrap');
  assert.equal(b.connections.length, 1);
  assert.equal(b.connections[0].host, '198.51.100.10');
  assert.equal(b.activeConnectionId, saved.connection.id, '第一条应当自动成为活动连接');

  // 落盘了：重新读配置文件也该看到
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(userData, 'demo-config', 'config.json'), 'utf8'));
  assert.equal(onDisk.connections.length, 1);

  // ★ 相同条目检测：界面上的「保存并连接」不改任何字段再点一次，
  //   绝不能又冒出一条 —— 用户看到的是列表越点越长，而分不清该点哪条。
  const again = await invoke('app:saveConnection',
    { user: 'alice', host: '198.51.100.10', port: 10100 });
  assert.equal(again.ok, true);
  assert.equal(again.created, false, '第二次必须报告「复用了已有的那条」');
  assert.equal(again.connections.length, 1, '列表里不能出现第二条一样的');
  assert.equal(again.connection.id, saved.connection.id, '必须复用同一个 id');
  assert.equal(again.connection.label, '内网', '复用不得把已有的备注冲掉');

  // ★ 编辑时把地址改成另一条已有的 —— 拒绝，而不是留下两条同身份、各带一把密钥的
  const other = await invoke('app:saveConnection',
    { user: 'alice', host: '203.0.113.7', port: 10100 });
  const clash = await invoke('app:saveConnection',
    { id: saved.connection.id, user: 'alice', host: '203.0.113.7', port: 10100 });
  assert.equal(clash.ok, false);
  assert.equal(clash.code, 'duplicate');
  assert.match(clash.error, /203\.0\.113\.7/, '要说清楚撞上的是哪个地址');
  assert.equal((await invoke('app:bootstrap')).connections.length, 2, '两条都该原样留着');
  await invoke('app:deleteConnection', other.connection.id);

  const del = await invoke('app:deleteConnection', saved.connection.id);
  assert.equal(del.ok, true);
  assert.deepEqual(del.connections, []);
  assert.equal(del.activeConnectionId, null, '删掉活动连接后不能留一个悬空的 id');
});

test('★ 主动断开：没开会话时可用，且活动连接不会被忘掉', async (t) => {
  t.after(() => { Module._load = origLoad; });

  const saved = await invoke('app:saveConnection',
    { user: 'alice', host: '198.51.100.10', port: 10100 });
  const r = await invoke('app:disconnect');
  assert.equal(r.ok, true);

  // 断开的是「这一跳」，不是「这条连接」—— 配置里必须还在，
  // 否则用户再点「连接」会发现地址没了，得重填一遍
  const b = await invoke('app:bootstrap');
  assert.equal(b.connections.length, 1);
  assert.equal(b.activeConnectionId, saved.connection.id);
  assert.equal(b.whoami, null, '断开后不能再声称知道对面是谁');

  // 这个文件里所有用例共用同一个 Electron 实例，演示后端也被真的关掉了 ——
  // 接回去，否则后面的会话用例会撞上「演示后端尚未 connect()」
  const back = await invoke('app:connect', { connectionId: saved.connection.id });
  assert.equal(back.ok, true, '断开之后必须能重新接上，否则「断开」就是个单向门');
  await invoke('app:deleteConnection', saved.connection.id);
});

test('★ 地址探测：一条连接都没有时返回空，不回退到任何内置地址', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const hostsMod = await import('../src/main/hosts.js');
  const hosts = hostsMod.default || hostsMod;

  // probeAll([]) 必须返回空列表 —— 回退会让「用户改了配置但没生效」
  // 表现为「一切正常」，是最难查的一类问题
  assert.deepEqual(await hosts.probeAll([]), []);
  assert.deepEqual(await hosts.probeAll(undefined), []);
  // 字段不全的条目直接跳过，不猜端口
  assert.deepEqual(await hosts.probeAll([{ host: 'x' }]), []);
});

test('app:debug 在演示模式下可用（真机上造不出来的状态）', async (t) => {
  t.after(() => { Module._load = origLoad; });
  for (const what of ['daemon-down', 'tunnel-down', 'reap', 'reset']) {
    const r = await invoke('app:debug', what);
    assert.equal(r.ok, true, `${what} 应当可用，实际：${JSON.stringify(r)}`);
  }
  assert.equal((await invoke('app:debug', 'nonsense')).ok, false);
});

test('app:state 在没开会话时返回 null，而不是崩', async (t) => {
  t.after(() => { Module._load = origLoad; });
  assert.equal(await invoke('app:state'), null);
});

test('★ 分区来自 Slurm（不是配置里的「用途」），且没权限的要标出来', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const r = await invoke('app:partitions');
  assert.equal(r.ok, true);
  // 分区是**查出来的**，客户端不再自己维护一份「用途 → 分区」的声明式配置
  assert.deepEqual(r.partitions.map((p) => p.name).sort(),
    ['2080TI', 'A6000', 'DEBUG', 'RTX8000']);
  // 没权限的分区必须带 allowed:false 与原因，界面据此禁用并说明
  const denied = r.partitions.find((p) => p.name === 'DEBUG');
  assert.equal(denied.allowed, false);
  assert.ok(denied.reason, '禁用必须给出理由，而不是让用户猜');
});

test('★ 开会话：创建 code-server 视图，并真的自动登录成功', async (t) => {
  t.after(() => { Module._load = origLoad; });

  const before = calls.views.length;
  // 高级选项的临时覆盖：只传真实填了的键。这里模拟用户填了 4 核，
  // 内存不填 → 由服务端用自己的默认值（而不是客户端编一个）。
  await invoke('app:start', { cpus: 4 });

  // 等登记完成（演示后端 200ms）+ 建隧道 + 登录
  const view = await (async () => {
    const deadline = Date.now() + 15000;
    for (;;) {
      const v = calls.views[before];
      if (v && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(v.webContents._url)) return v;
      if (Date.now() > deadline) {
        const snap = await invoke('app:state');
        assert.fail(`等待 code-server 视图超时。当前状态：${JSON.stringify(snap)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  // 视图必须加载**字面 127.0.0.1** 的地址 —— 用 localhost 会是另一个 origin，
  // localStorage 不共享，而且可能解析成 ::1。
  assert.match(view.webContents._url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  // ★ partition 按**布局组 id**命名，不按端口 —— 按端口命名会让「A 组被回收后端口
  //   被新组复用」时，新组的「空白布局」继承 A 的 localStorage 与登录 cookie。
  const partition = view._opts.webPreferences.partition;
  assert.match(partition, /^persist:layout-l[0-9a-f]{12}$/, `实际：${partition}`);
  // 演示模式才注入 preload；真实模式注入会污染 IDE
  assert.match(String(view._opts.webPreferences.preload || ''), /demo\.js$/);
  assert.equal(view._opts.webPreferences.backgroundThrottling, false,
    'IDE 不能被 Chromium 节流 —— 那会让终端看起来「卡住」且没有报错');

  // ★ 登录成功的判据是 **cookie jar 里有没有 cookie**，不是 HTTP 状态码。
  //   注意要**等** —— 视图的 loadURL 在自动登录之前就返回了，立刻断言会撞上竞态。
  const jar = partitionJars[partition];
  const ok = await (async () => {
    const deadline = Date.now() + 8000;
    for (;;) {
      if (jar && jar.has('code-server-session')) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  if (!ok) {
    const notices = calls.windows[0].webContents.handlers['send:ui:notice'] || [];
    assert.fail('自动登录应当把会话 cookie 放进该 partition 的 jar 里。外壳通知：\n  '
      + notices.map((n) => `${n.kind}: ${n.text}`).join('\n  ')
      + '\n  jars: ' + JSON.stringify(Object.keys(partitionJars)));
  }

  // ★ 主动断开 = 彻底终止。会话跑着的时候点「断开」，必须先取消作业、释放资源，
  //   而不是把作业留在集群上继续占着节点，界面上却显示「未连接」。
  const dis = await invoke('app:disconnect');
  assert.equal(dis.ok, true);
  assert.ok(dis.released, '断开必须带上是如何释放的，不能只回一句 ok');
  assert.equal(dis.released.ok, true, '释放请求应当被接受');
  assert.equal(dis.released.state, 'releasing', '必须真的走释放，作业不能留在集群上');

  // 断开之后不再声称知道对面是谁，但连接条目本身要留着（下次还得连）
  assert.equal((await invoke('app:bootstrap')).whoami, null);

  // 这个文件里所有用例共用同一个 Electron 实例，演示后端刚被真的关掉了 ——
  // 接回来，否则后面的用例会撞上「演示后端尚未 connect()」
  const demoConn = await invoke('app:saveConnection',
    { user: 'demo', host: '127.0.0.1', port: 1 });
  assert.equal((await invoke('app:connect', { connectionId: demoConn.connection.id })).ok, true,
    '断开之后必须能重新接上，否则「断开」就成了单向门');
  await invoke('app:deleteConnection', demoConn.connection.id);
});

/** 等一个新的 code-server 视图出现。loadURL 在自动登录之前就返回了，所以只能轮询。 */
async function waitForView(fromIndex, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = calls.views[fromIndex];
    if (v && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(v.webContents._url)) return v;
    if (Date.now() > deadline) {
      assert.fail(`等待 code-server 视图超时。当前状态：${JSON.stringify(await invoke('app:state'))}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('★ 运行中切换布局组：只换本地端口与存储分区，作业一动不动', async (t) => {
  t.after(() => { Module._load = origLoad; });

  // 这个文件里所有用例共用同一个 Electron 实例，状态是累加的 ——
  // 所以自己保证「有一条连接、而且是活跃的」。
  let boot = await invoke('app:bootstrap');
  if (!boot.connections.length) {
    await invoke('app:saveConnection',
      { user: 'demo', host: '198.51.100.10', port: 10100, label: '布局' });
    boot = await invoke('app:bootstrap');
  }
  const conn = boot.connections.find((c) => c.id === boot.activeConnectionId)
            || boot.connections[0];
  assert.equal((await invoke('app:connect', { connectionId: conn.id })).ok, true,
    '演示后端应当连得上');

  const idx = require('../src/main/index.js');
  // 上一个用例「断开」时演示后端被 close()，而它那个 1.6 秒的释放定时器在 close() 里
  // 被清掉了 —— 于是演示会话卡在 releasing，_submit 会以 quota_active 拒绝。
  // 真集群上守护进程的 phase_release 会自己收掉它（最多一个 tick），这里手动收。
  idx._test.getBackend().debugReap();

  const before = calls.views.length;
  const started = await invoke('app:start', {});
  assert.equal(started.ok, true, `开会话应当成功：${JSON.stringify(started)}`);
  const view1 = await waitForView(before);

  const ctl = idx._test.getController();
  const sessionId = ctl.sessionId;
  const jobId = ctl.snapshot().jobId;
  const oldGroupId = ctl.snapshot().layoutId;
  const oldPartition = view1._opts.webPreferences.partition;
  const oldWc = view1.webContents;

  // ① 切走一个「独占」的组（它只被这一条连接用）→ 主进程必须先回 would_discard，
  //    并且**配置一个字都不动**。判定权在主进程：界面手里那份 refCount 随时可能
  //    已经陈旧（另一条连接刚被删），它只负责弹确认。
  const ask = await invoke('app:setConnectionLayout', { connectionId: conn.id, layoutId: null });
  assert.equal(ask.ok, false);
  assert.equal(ask.code, 'would_discard', '切走独占的组必须先要一次确认');
  assert.equal(ctl.snapshot().layoutId, oldGroupId, '没确认之前什么都不该发生');
  assert.equal(calls.views.length, before + 1, '没确认之前不该重建视图');

  // ② 确认之后再切。这一段里数一数发了多少次 RPC —— 这是「作业没动」的可证明形式。
  const backend = idx._test.getBackend();
  const realRpc = backend.rpc.bind(backend);
  let rpcCount = 0;
  backend.rpc = (req) => { rpcCount += 1; return realRpc(req); };
  const r = await invoke('app:setConnectionLayout',
    { connectionId: conn.id, layoutId: null, confirmDiscard: true });
  backend.rpc = realRpc;

  assert.equal(r.ok, true, JSON.stringify(r));
  // ★ 全程不碰 submit / heartbeat / status / goodbye —— Slurm 作业、控制节点那边的
  //   session、sessionId、tunnel_target 都不变，变的只有浏览器这一侧。
  assert.equal(rpcCount, 0, '切换布局组不该向守护进程说任何话');

  // ③ partition 是**构造期属性**，所以换组必须销毁重建 ——
  //   只 loadURL 是没用的，页面会继续跑在旧的存储分区里而看不出来。
  assert.equal(calls.views.length, before + 2, '换 partition 必须重建视图');
  const view2 = calls.views[calls.views.length - 1];
  assert.match(view2._opts.webPreferences.partition, /^persist:layout-l[0-9a-f]{12}$/);
  assert.notEqual(view2._opts.webPreferences.partition, oldPartition);
  assert.equal(oldWc.isDestroyed(), true, '旧视图必须真的被销毁，不能只是换下去');

  // ④ 会话本身一动不动
  assert.equal(ctl.sessionId, sessionId, 'sessionId 不能变');
  assert.equal(ctl.snapshot().jobId, jobId, '作业号不能变');
  assert.equal(ctl.state, 'running');
  assert.notEqual(ctl.snapshot().layoutId, oldGroupId, '控制器要跟着换组');

  await invoke('app:disconnect');
});

test('口令错误时不能报成功 —— 这正是「HTTP 200 但没有 cookie」的陷阱', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const idx = require('../src/main/index.js');
  const { webLogin } = idx;

  // ★ 契约现在由**插件**给，不由基座写死。这份契约直接从装着的那个插件清单里取
  //   —— 测试因此钉住的是"真插件声明的值"，而不是测试里另抄一份（抄的那份迟早
  //   会与清单分叉，而分叉的表现是"登录莫名其妙失败"）。
  const cs = idx._test.getRegistry().list().find((p) => p.name === 'code-server');
  assert.ok(cs, '这个用例要先装上 code-server 插件（见文件头的池设置）');
  const contract = cs.contributes.login;
  assert.ok(contract, 'code-server 的清单里必须有 contributes.login');

  // 造一个「状态码 200 但 jar 里没有 cookie」的 session，模拟真实服务对口令错误的
  // 响应。任何靠状态码判断的写法都会在这里报成功。
  const ses = {
    fetch: async () => ({ status: 200 }),
    cookies: { get: async () => [] },
  };
  const res = await webLogin(ses, 'http://127.0.0.1:1', 'wrong-password', contract);
  assert.equal(res.ok, false, '没有 cookie 就是没登录成功，不管状态码是多少');
  assert.equal(res.reason, 'no_cookie');
  assert.equal(res.status, 200);

  // 反过来：有 cookie 就是成功，哪怕状态码不是 302
  const ses2 = {
    fetch: async () => ({ status: 200 }),
    cookies: { get: async () => [{ name: 'code-server-session', value: 'x' }] },
  };
  assert.equal((await webLogin(ses2, 'http://127.0.0.1:1', 'pw', contract)).ok, true);

  // ★ 契约换一个服务就整套换掉 —— 字段名与 cookie 名都来自它，基座一个字不知道。
  const other = { path: '/auth', field: 'token', cookie: 'jupyter-session' };
  const ses3 = {
    fetch: async (url, opts) => {
      assert.match(url, /\/auth$/, 'POST 的路径必须来自契约');
      assert.match(String(opts.body), /^token=/, '表单字段名必须来自契约');
      return { status: 302 };
    },
    cookies: { get: async ({ name }) => (name === 'jupyter-session' ? [{ name, value: 'x' }] : []) },
  };
  assert.equal((await webLogin(ses3, 'http://127.0.0.1:1', 'pw', other)).ok, true,
    '换一份契约就该按那份契约登录 —— 基座里没有"哪个服务"这个概念');

  // 没有契约时明确失败，而不是猜一个默认端点
  assert.equal((await webLogin(ses3, 'http://127.0.0.1:1', 'pw', null)).reason, 'no_contract');
});

// ── 默认资源：服务端通报，客户端只读地用 ────────────────────────────────────

test('★ 服务端通报的默认资源要真的送到界面上，不能又在客户端硬编码一份', async (t) => {
  t.after(() => { Module._load = origLoad; });

  // ★ 默认资源现在是**按插件**的，所以它跟 `op:plugins` 走，不再挂在 `partitions`
  //   的响应上（那个 `defaults` 字段已经从协议里删掉了 —— 留一个全局的在那里就是
  //   两份真相：界面显示 2 核 / 8G，而实际提交中转站会话拿到的是 1 核 / 2G，
  //   且没有任何地方会为此报错）。
  //
  //   客户端**不自己定一份**：界面只读地显示它，提交时靠【省略】cpus/mem 让服务端
  //   填当下那份默认值。回发旧值的客户端会把管理员的改动永远钉死。
  const r = await invoke('app:partitions');
  assert.equal(r.ok, true);
  const codeServer = r.plugins.plugins.find((p) => p.name === 'code-server');
  assert.ok(codeServer, '代码宿主插件必须出现在可用的插件里');
  assert.deepEqual(codeServer.defaults, { cpus: 2, mem: '8G' },
    '服务端通报的默认资源必须原样带回来');

  const boot = await invoke('app:bootstrap');
  const cs2 = boot.plugins.plugins.find((p) => p.name === 'code-server');
  assert.deepEqual(cs2.defaults, { cpus: 2, mem: '8G' },
    'bootstrap 也要带 —— 界面首次渲染时还没有别的机会拿到它');
});

test('★ 取不到分区时必须说出来，不能谎报「这台集群没有分区」', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const idx = require('../src/main/index.js');

  // 让演示后端假装守护进程不可达
  await invoke('app:debug', 'daemon-down');
  try {
    const r = await invoke('app:partitions');
    assert.equal(r.ok, false, '查询失败就不能报 ok');
    assert.ok(r.error, '必须给出原因 —— 否则界面只能显示一个空列表');
    assert.match(r.error, /分区列表/, `错误里要说清是取分区列表失败：${r.error}`);
    assert.deepEqual(r.partitions, [], '失败时列表为空，但区别在 error 上');
    // 插件清单拿不到时**不能**当成"一个插件都没开"—— 那会让升级客户端的用户
    // 突然一个按钮都看不到。这里只要求它不谎报。
    assert.ok(r.plugins, '插件视图始终要有，界面靠它决定画哪些按钮');

    // 而且不能悄悄留着上一次的值当成本次的结果
    const notices = calls.windows[0].webContents.handlers['send:ui:notice'] || [];
    assert.ok(notices.some((n) => n.kind === 'error' && /分区列表/.test(n.text)),
      '失败要推一条 error 通知，而不是让用户去猜为什么没有分区');
  } finally {
    await invoke('app:debug', 'reset');
    void idx;
  }
});

test('★ 还在排队的会话必须被接上，而不是当成「没有会话」', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const idx = require('../src/main/index.js');

  // 造一个会话，但**不经过 controller** —— 这样测试结束时不会留下别的定时器。
  const b = idx._test.getBackend();
  await invoke('app:debug', 'reset');
  const conn = await invoke('app:saveConnection', { user: 'demo', host: '127.0.0.1', port: 1 });
  assert.equal((await invoke('app:connect', { connectionId: conn.connection.id })).ok, true,
    '前置条件：要先连上 —— 没连上时 tryReattach 会（正确地）直接返回');
  await b.rpc({ op: 'submit', cpus: 2, mem: '8G' });
  await new Promise((r) => setTimeout(r, 400));      // 演示后端 200ms 登记
  const sid = b._session && b._session.session_id;
  assert.ok(sid, '前置条件：要有一个会话');

  // 把它改回「作业还在队列里」的样子：没有 tunnel_target。
  // 这正是「换了电脑、或客户端重启时作业还没跑起来」的形态。
  b._session.tunnel_target = null;
  b._session.state = 'submitted';

  // 重跑启动时那条路。注意不能 await —— 它会一直等登记，而这里永远不会登记。
  const p = idx._test.reattach().catch(() => {});
  await new Promise((r) => setTimeout(r, 600));

  const ctl = idx._test.getController();
  assert.ok(ctl,
    '排队中的会话也必须被接管 —— 否则界面照常显示「启动」，用户一点就提交了'
    + '第二个作业，而第一个还在队列里');
  assert.equal(ctl.sessionId, sid, '接上的必须是同一个会话，不能另开一个');
  assert.notEqual(ctl.state, 'running',
    '还没有 tunnel_target，不能假装已经跑起来了');

  // 收尾：结束这个会话，让 _waitForEnroll 的轮询自己走到终态停下
  await invoke('app:stop');
  await Promise.race([p, new Promise((r) => setTimeout(r, 5000))]);
  await invoke('app:deleteConnection', conn.connection.id);
  await invoke('app:debug', 'reset');
});

// ── SSH 中转站 ──────────────────────────────────────────────────────────────
//
// 这个功能的界面在**用户的终端里**，客户端这边唯一要做的事就是让 `ssh slurmate`
// 能连进来。所以这一节的断言几乎全部落在文件上：写出来的 ssh 配置对不对、
// 有没有动用户别的东西、以及**有没有建一个不该建的视图**。

test('ULID：铸造出来的标识符，不是名字', (t) => {
  t.after(() => { Module._load = origLoad; });
  const u = require('../src/main/plugins/ulid.js');

  const a = u.mint();
  assert.equal(a.length, 26, '26 个字符');
  assert.ok(u.isId(a), '铸出来的要通过自己的校验');
  assert.equal(u.isId(a.toLowerCase()), false,
    '小写不合法 —— 字母表是大写的 Crockford base32，允许小写会让"同一个 id"有两种写法');

  // ★ 字母表刻意去掉了 I / L / O / U：手抄或口头念给管理员听时不会和 1 / 0 混。
  for (const bad of ['I', 'L', 'O', 'U']) {
    assert.equal(u.isId(bad.repeat(26)), false, `${bad} 不在字母表里`);
  }
  assert.equal(u.isId(a.slice(0, 25)), false, '短一位不合法');
  assert.equal(u.isId(a + 'X'), false, '长一位不合法');

  // ★ 时间在前、随机在后 → **字典序 = 铸造序**。池里的目录列表靠它天然有序。
  assert.ok(u.mint(1700000000000) < u.mint(1700000000001), '毫秒递增 → 字典序递增');
  assert.ok(u.mintedAt(a) > Date.UTC(2020, 0, 1), '反解出来的铸造时间要合理');

  // ★「生成即唯一」靠的是随机位，不是协调。同一毫秒里铸的也必须互不相同 ——
  //   否则批量铸造（比如一次装一批插件）会撞。
  const batch = Array.from({ length: 200 }, () => u.mint(1700000000000));
  assert.equal(new Set(batch).size, 200, '同一毫秒内铸 200 个不能重样');
});

test('插件注册表：四种输入四种答案，尤其「不知道」不能猜', (t) => {
  t.after(() => { Module._load = origLoad; });
  const { Registry } = require('../src/main/plugins/index.js');
  const u = require('../src/main/plugins/ulid.js');
  // ★ 用**真的池**（装着仓库里那两个插件），不是 `new Registry()` —— 后者现在
  //   是"一个插件都没有"，而这一条测的是解析语义，得有东西可解析。
  const reg = new Registry([{ dir: demoPool, source: 'pool' }]);
  const cs = reg.list().find((p) => p.name === 'code-server');
  assert.ok(cs, '前置条件：池里有 code-server');
  const ref = `${cs.id}@${cs.version}`;

  assert.equal(reg.resolve(cs.id, ref).plugin.name, 'code-server', '解析键查得到就是它');

  // ★ `service_plugin` 字段**不存在**（部署的守护进程还是旧版本，那时还没有
  //   "插件"这一层，作业模板只会起一种服务）：按**短名**找。
  //
  //   早先这里还限定"必须是内建的"，理由是"老守护进程只可能产生内建插件的会话"。
  //   基座不再自带插件之后那句前提没有了，而按短名在池里找是**有歧义**的 ——
  //   判据因此换成**"是不是唯一"**。见下面那条。
  assert.equal(reg.resolve('code-server', undefined).plugin.name, 'code-server',
    '老守护进程没有解析键时，按短名找 —— 唯一命中才算');
  assert.equal(reg.resolve(undefined, undefined).plugin.name, 'code-server',
    '连服务种类都没有时兜到标了 legacyDefault 的那个');
  // ★ **命中多个就不猜。** 池是全局的，两个站点可以各有一个叫同一个名字的插件，
  //   而它们是两个不同的东西。挑一个的后果是拿另一个插件的代码去对接这个作业。
  const tmpSame = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-same-'));
  writePlugin(tmpSame, 'x1', { name: 'twins', displayName: '孪生甲' }, 'module.exports = {};\n');
  writePlugin(tmpSame, 'x2', { name: 'twins', displayName: '孪生乙' }, 'module.exports = {};\n');
  const regTwin = new Registry([{ dir: tmpSame, source: 'pool' }]);
  const twin = regTwin.resolve('twins', undefined);
  assert.equal(twin.plugin, null,
    '★ 两个同名的插件在池里时，短名**不足以定位** —— 绝不挑一个');
  assert.match(twin.why || '', /2/, `要说清有几个同名的：${twin.why}`);
  // ★ `service_kind` 是 null（守护进程明说不知道：会话是从 nft 规则恢复出来的）。
  //   这时**绝不能猜** —— 猜 code-server 会拿口令去 POST 一个 SSH 端口，
  //   猜 sshd 会拿主机公钥去配一个 HTTP 端口，两种都是系统在声称它并不知道的事。
  assert.equal(reg.resolve(null, undefined).plugin, null,
    '守护进程明说不知道时绝不能猜 —— 猜 code-server 会拿口令去 POST 一个 SSH 端口');
  assert.equal(reg.resolve('ssh', undefined).plugin, null, '认不出的短名也不许退回默认');
  assert.equal(reg.resolve('code-server', 'garbage').plugin, null, '坏掉的解析键不许退回默认');

  // ★ 认得出 id、但**本机没有那一版** —— 这是"站点升级了插件而客户端还没跟上"的
  //   形态，也是用户最需要一句话的时候。必须说得出缺的是哪一版，而不是笼统的"未知"。
  const miss = reg.resolve(cs.id, `${cs.id}@99.0.0`);
  // ★ 这条断言**必须自己带 message**：不带的话失败块里只有一段对象 diff，
  //   看不出是"解析键查不到"这一条红的 —— 而"红了，但看不出为什么红"与
  //   "因为错误的理由红"在排查时一样难用。（同一个坑这个项目里踩过一次。）
  assert.equal(miss.plugin, null,
    '★ 解析键查不到时**不许退回缺省插件** —— 那等于系统声称了一件它并不知道的事，'
    + '而症状是客户端拿另一个插件的代码去对接这个作业');
  assert.match(miss.why || '', /99\.0\.0/, `要说清缺的是哪一版：${miss.why}`);
  assert.match(miss.why || '', /1\.0\.0/, `也要说清本机有哪一版：${miss.why}`);

  // 完全没见过的 id 也要有话说
  assert.match(reg.resolve(u.mint(), `${u.mint()}@1.0.0`).why || '', /没有/,
    '本机根本没有这个 id 时，要说"没有这个插件"，而不是"版本不对"');

  // ★ 缺省插件靠的是清单里那个 legacyDefault 标记，**不是"列表里第一个"**。
  //   内建这两个恰好同名序与标记重合（code-server 字母序在前、也正是它标了
  //   legacyDefault），所以只测内建的注册表分辨不出这两种实现。加一个名字排序
  //   在前的插件，答案就会分叉。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-def-'));
  writePlugin(tmp, 'aaa', { name: 'aaa', displayName: '排在前面的' },
    'module.exports = {};\n');
  writePlugin(tmp, 'zzz', { name: 'zzz', displayName: '真正的缺省',
    contributes: { legacyDefault: true } }, 'module.exports = {};\n');
  const reg2 = new Registry([{ dir: tmp, source: 'pool' }]);
  assert.deepEqual(reg2.list().map((p) => p.name), ['aaa', 'zzz'], '前置条件：顺序');
  assert.equal(reg2.defaultPlugin().name, 'zzz',
    '★ 缺省插件是**标了 legacyDefault 的那一个**，不是列表里第一个 —— '
    + '按"第一个"取的话，加一个名字排序在前的插件就会把老守护进程的会话认错');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('去重是**按插件**分桶的：两个插件各记各的"上次值"', (t) => {
  t.after(() => { Module._load = origLoad; });
  const { Registry, bucketOf } = require('../src/main/plugins/index.js');
  const reg = new Registry([{ dir: demoPool, source: 'pool' }]);
  const cs = reg.list().find((p) => p.name === 'code-server');
  const ss = reg.list().find((p) => p.name === 'sshd');
  assert.ok(cs && ss, '前置条件：池里两个插件都在');
  const b1 = bucketOf(cs);
  const b2 = bucketOf(ss);

  // ★ `bucketOf(null)` 不能抛 —— 今天到不了（ctx 只在插件非空时递给插件），
  //   但那是框架里**最容易漏写一个守卫**的位置，而踩上去的报错会是一个
  //   `TypeError`，读不出任何线索。
  assert.doesNotThrow(() => bucketOf(null), 'bucketOf 必须能接住 null');

  // 状态变化很频繁（心跳、隧道重建、每次 status 回来都会走到渲染），而插件的
  // attach() 多半在写文件或弹通知 —— 不去重用户每 45 秒收到一条一模一样的通知。
  assert.equal(reg.once(b1, 'k1'), true, '第一次要放行');
  assert.equal(reg.once(b1, 'k1'), false, '同一个桶同一个键再来一次要拦住');
  // ★ 关键的一条，而且**必须紧接着上面**：此刻 b1 的槽里正是 'k1'，
  //   所以另一个插件拿**同一个键**来问必须放行。共用一个槽的话它会拿到 false ——
  //   症状是其中一个插件的通知永远不出现。
  //   （顺序不能挪：先让槽里换成别的键再问这一条，共享槽也会通过，这条断言就退化成
  //     走过场了。变异验证 C6 第一次就是这么活下来的。）
  assert.equal(reg.once(b2, 'k1'), true, '别的插件有自己的槽，同一个键也要放行');
  assert.equal(reg.once(b2, 'k1'), false, '同一个桶同一个键才拦');

  assert.equal(reg.once(b1, 'k2'), true, '换了键要放行');
  // 重新扫描（模拟装/卸插件）不能把去重状态清掉，否则用户会重看一遍通知。
  reg.reload();
  assert.equal(reg.once(b1, 'k2'), false, '重新扫描后去重状态还在');
});

// ── ★ 装一个插件、卸一个插件，客户端都不许崩 ─────────────────────────────────
//
// 这是这次改动的验收标准，也是整块重构存在的理由。用一个临时目录模拟
// 「站点分发的插件」，逐条验四件事：坏文件不拖垮别人、装上就认得、
// 卸掉之后会话仍然能管（这是"通用层"的核心断言）、名字与文件不一致时宁可跳过。

/** 在一个临时根目录下造一个插件目录。返回它的路径。 */
function writePlugin(root, dirName, over = {}, clientSrc = undefined) {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const mf = {
    id: mintId(), name: 'temp', displayName: '临时', version: '1.0.0', ...over,
  };
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(mf, null, 2));
  if (clientSrc !== undefined) {
    fs.mkdirSync(path.join(dir, 'client'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'client', 'index.js'), clientSrc);
  }
  return dir;
}
let _ulidMod = null;
function mintId() {
  if (!_ulidMod) _ulidMod = require('../src/main/plugins/ulid.js');
  return _ulidMod.mint();
}

/** 内建 sshd 插件的 id。开关按 id 记，所以测试得拿得到它。 */
function sshdId() {
  const idx = require('../src/main/index.js');
  const p = idx._test.getRegistry().list().find((x) => x.name === 'sshd');
  assert.ok(p, '这个用例要先装上 sshd 插件（见文件头的池设置）');
  return p.id;
}

test('★ 插件目录：坏插件只影响它自己，其余照常工作', (t) => {
  t.after(() => { Module._load = origLoad; });
  const { Registry } = require('../src/main/plugins/index.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-plug-'));

  writePlugin(tmp, 'good', { name: 'good', displayName: '好的' }, 'module.exports = {};\n');
  // 客户端代码语法错
  writePlugin(tmp, 'broken', { name: 'broken' }, 'this is not javascript at all((((\n');
  // 清单不是合法 JSON
  fs.mkdirSync(path.join(tmp, 'badjson'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'badjson', 'plugin.json'), '{ not json');
  // id 不是 ULID —— 身份是铸造出来的，编一个名字冒充不了
  writePlugin(tmp, 'badid', { id: 'code-server', name: 'badid' });
  // 未知键：打错一个键名不该静默变成"配了但不生效"
  writePlugin(tmp, 'badkey', { contribution: {} });
  // 客户端代码导出里打错了一个钩子名
  writePlugin(tmp, 'badhook', { name: 'badhook' }, 'module.exports = { attch() {} };\n');
  // 不是插件目录（没有清单）—— 应当被**静静跳过**，不是报错
  fs.mkdirSync(path.join(tmp, 'not-a-plugin'), { recursive: true });

  const reg = new Registry([{ dir: tmp, source: 'pool' }]);

  assert.deepEqual(reg.list().map((p) => p.name), ['good'],
    '只有形状完整的那个被收下');
  assert.equal(reg.errors.length, 5, `五个坏插件各记一条：${JSON.stringify(reg.errors, null, 2)}`);
  assert.ok(reg.errors.every((e) => typeof e === 'string' && e.length > 0),
    '每条都要说得出是哪个目录、坏在哪');
  // ★ 报错必须**指名道姓**。含糊的一句"有插件加载失败"等于没有报错 ——
  //   症状是"加了插件它就是不生效"，而这是用户唯一的线索来源。
  const all = reg.errors.join('\n');
  for (const [what, re] of [['语法错', /broken/], ['清单坏', /badjson/],
    ['id 不合法', /badid/], ['未知键', /badkey/], ['钩子名打错', /badhook/]]) {
    assert.match(all, re, `${what} 那条报错要说得出是哪个目录：${all}`);
  }
  // ★ 关键：注册表本身可用 —— 一个坏插件不能把客户端带崩。
  assert.equal(reg.latestByName('good').name, 'good');
  assert.equal(reg.resolve('broken', undefined).plugin, null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('★ 身份是铸造出来的：同一个构件合并、抢同一个身份的一个都不加载', (t) => {
  t.after(() => { Module._load = origLoad; });
  const { Registry } = require('../src/main/plugins/index.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-plug-'));
  const src = 'module.exports = {};\n';

  // ── 同一个构件被两个来源分发 → 合并成一条，只是多记一个来源 ──
  //   关键在于两边的**目录名完全不同**：目录名不参与任何判定，身份来自清单。
  const siteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-s-'));
  const poolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-p-'));
  const id = mintId();
  writePlugin(siteRoot, 'readable-name', { id, name: 'jup', displayName: 'J' }, src);
  writePlugin(poolRoot, `${id}@1.0.0`, { id, name: 'jup', displayName: 'J' }, src);

  let reg = new Registry([{ dir: siteRoot, source: 'site' },
    { dir: poolRoot, source: 'pool' }]);
  let jup = reg.list().filter((p) => p.id === id);
  assert.equal(jup.length, 1, '同一个 (id, 版本) + 同一份内容 = 一条，不是两条');
  assert.deepEqual(jup[0].sources, ['pool', 'site'], '但要记下两个来源');
  assert.equal(reg.errors.length, 0, `合并不该报错：${JSON.stringify(reg.errors)}`);

  // ── 同 (id, 版本) 而内容不同 → 两个都不加载 ──
  //   这是池模型唯一的危险处：挑一个错的后果是会话的解析键指过去、客户端静默地
  //   跑了另一个插件的代码，而用户完全看不出来。宁可暂时不可用 —— 那种失败是
  //   **看得见**的。
  writePlugin(poolRoot, 'impostor', { id, name: 'jup', displayName: 'J' },
    'module.exports = { attach() {} };\n');          // 内容不同 → 摘要不同
  reg = new Registry([{ dir: siteRoot, source: 'site' },
    { dir: poolRoot, source: 'pool' }]);
  assert.equal(reg.get(id, '1.0.0'), null,
    '★ 内容不同的两份在抢同一个身份 → 两个都不加载，绝不挑一个');
  assert.equal(reg.errors.length, 1, '而且要说出来');
  assert.match(reg.errors[0], /抢同一个 id/, `报错要说清是什么问题：${reg.errors[0]}`);
  assert.match(reg.errors[0], /摘要/, '还要给出判据（摘要），用户才分得清哪份是哪份');

  // ── 同 id 不同版本 → **并存**。站点升级频繁也好、拒绝升级也好，都不挤掉对方 ──
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-v-'));
  writePlugin(root2, 'v1', { id, name: 'jup', displayName: 'J', version: '1.0.0' }, src);
  writePlugin(root2, 'v2', { id, name: 'jup', displayName: 'J', version: '2.0.0' }, src);
  reg = new Registry([{ dir: root2, source: 'pool' }]);
  assert.deepEqual(reg.list().map((p) => p.version), ['1.0.0', '2.0.0'],
    '同一个插件的多个版本并存');
  assert.equal(reg.latestByName('jup').version, '2.0.0', '按短名取时给最高的那一版');
  assert.equal(reg.get(id, '1.0.0').version, '1.0.0', '按解析键取时给的就是那一版');

  // ★ 去重桶要**带上版本**：池里并存同一个插件的多个版本是常态（站点更新频繁、
  //   也可能拒绝更新）。只按 id 分桶的话，刚装上的新版本那句话会被旧版本压掉 ——
  //   而"这个版本已经说过这句话了"与"那个版本说过了"是两件事。
  const { bucketOf } = require('../src/main/plugins/index.js');
  assert.notEqual(bucketOf(reg.get(id, '1.0.0')), bucketOf(reg.get(id, '2.0.0')),
    '★ 去重桶必须区分同一插件的不同版本');

  for (const d of [tmp, siteRoot, poolRoot, root2]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('★ 引擎范围对不上就不装 —— 而不是装上之后在某个角落炸', (t) => {
  t.after(() => { Module._load = origLoad; });
  const { Registry, satisfies, hostVersion } = require('../src/main/plugins/index.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-eng-'));
  const host = hostVersion();

  writePlugin(tmp, 'future', { name: 'future', engines: { slurmate: '>=99.0' } });
  writePlugin(tmp, 'ok', { name: 'ok', engines: { slurmate: '>=0.0 <99.0' } });
  writePlugin(tmp, 'badrange', { name: 'badrange', engines: { slurmate: '^1.2' } });

  const reg = new Registry([{ dir: tmp, source: 'pool' }]);
  assert.deepEqual(reg.list().map((p) => p.name), ['ok'],
    `只有引擎范围满足的那个被收下（本客户端 ${host}）`);
  assert.equal(reg.errors.length, 2);
  const all = reg.errors.join('\n');
  assert.match(all, /future/, '要说是哪个插件');
  assert.match(all, new RegExp(host.replace(/\./g, '\\.')), '要说清本客户端是哪一版');
  assert.match(all, /badrange/, '看不懂的范围片段也要报错，不能当成"没限制"');

  // 判定函数本身：比较符 + 空格分隔的合取
  assert.equal(satisfies('1.5', '>=1.0 <2.0').ok, true);
  assert.equal(satisfies('2.0', '>=1.0 <2.0').ok, false, '上界是开区间');
  assert.equal(satisfies('1.0', '>=1.0 <2.0').ok, true, '下界是闭区间');
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * ★★ 版本号：两套方案，一条比较规则 —— 夹具与 Python 读的是**同一份**。
 *
 * 这个仓库里有**两套**版本号，它们长得像、纪律共用，但**不是一回事**：
 *   · **框架版本** `x.y` —— 客户端 / 守护进程 / 协议三合一的那个号
 *     （`client/package.json` 的 version）。`x` 是"可以不兼容"那一档，`y` 是
 *     "加东西但不破坏兼容"那一档 —— 所以**同 x 且客户端不低于服务端 ⇒ 保证
 *     兼容**。运行期有**一条版本握手**（客户端连上时问一次 `ping`），判定在
 *     `plugins.versionCheck` 里，闸在 index.js 的 `applyVersionGate`。
 *   · **插件版本** `x.y.z` —— 清单里的 `version`，`(id, 版本)` 那个槽位的键。
 *
 * ★ 夹具在 `tools/version-fixtures.json`，`cluster/test-sessiond-logic.py` 的
 *   19.0b2 节读的是同一个文件。两套实现各写一遍规则，"逐条一致"靠两份抄本
 *   加一条比对 lint 是**抓不到漂的**（lint 只看得见已经漂了的那部分）。
 */
test('★ 版本号：两套方案 —— 形状 / 大小 / 范围，逐条对上共用夹具', () => {
  const M = require('../src/main/plugins/index.js');
  const fxPath = fileURLToPath(new URL('../../tools/version-fixtures.json', import.meta.url));
  const fx = JSON.parse(fs.readFileSync(fxPath, 'utf8'));

  // 1) 形状。两套方案的形状不同（`0.6` 合法、`0.6.0` 不合法；反过来在插件那边），
  //    所以夹具分两张表，用的正则也是两条。
  for (const [scheme, re] of [['framework', M.FRAMEWORK_VERSION_RE],
    ['plugin', M.VERSION_RE]]) {
    for (const v of fx[scheme].valid) {
      assert.ok(re.test(v), `${scheme} 版本 ${JSON.stringify(v)} 应当合法`);
    }
    for (const v of fx[scheme].invalid) {
      assert.ok(!re.test(v), `${scheme} 版本 ${JSON.stringify(v)} 应当被拒`);
    }
  }

  // 2) 大小。两条都走**生产路径**的对外比较器（`Registry.list()` 用 cmpPluginVer，
  //    握手用 cmpFramework）。★ 框架那一条从前是**用 `satisfies` 的两个闭区间夹
  //    出来的** —— 也就是"拿范围判定去测大小比较"：排序规则一旦写错，夹具跟着
  //    一起错，而它看不出来。现在两侧都有真的比较器了。
  for (const [a, b, want] of fx.order.plugin) {
    const got = M.cmpPluginVer(a, b);
    assert.equal(got, { lt: -1, eq: 0, gt: 1 }[want],
      `插件版本 ${a} 与 ${b}：夹具说 ${want}，得到 ${got}`);
  }
  for (const [a, b, want] of fx.order.framework) {
    const got = M.cmpFramework(a, b);
    assert.equal(got, { lt: -1, eq: 0, gt: 1 }[want],
      `框架版本 ${a} 与 ${b}：夹具说 ${want}，得到 ${got}`);
  }

  // 3) 范围。★ 后半段是「被拒绝的形状」（`>=0.5.0`、`^0.5`、`||`……），它们与
  //    「不满足」都返回 ok:false，但都**不能**被当成"没限制"放过去。
  for (const c of fx.ranges.cases) {
    assert.equal(M.satisfies(c.host, c.range).ok, c.ok,
      `host=${JSON.stringify(c.host)} range=${JSON.stringify(c.range)}`);
  }

  // 3b) ★★ engines 这个键的**字段级**规则 —— 与守护进程 `engines_problem`
  //     逐条一致。从前这里是分家的：守护进程只认「dict 且 slurmate 是非空
  //     字符串」，其余形状**静默跳过**（当成没有限制），而客户端全拒 ——
  //     一侧收下、另一侧拒了，正是这个仓库点名过的最坏形状。
  //     ★ `ranges` 那一段钉不住它：那一段喂的是 `host + range`，不构造清单。
  fx.engines.cases.forEach((c, i) => {
    const where = `engines 夹具第 ${i} 条：${JSON.stringify(c)}`;
    // 键不出现 = JS 的 undefined（它是**通过**），null 是**出现过的值**（拒）。
    const mf = 'engines' in c ? { engines: c.engines } : {};
    const ret = M.enginesProblem(mf, c.host);
    assert.equal(ret === null, c.ok, `${where} 夹具说 ok=${c.ok}，得到 ${JSON.stringify(ret)}`);
    // ★ kind 一并断言。只断言 ok 的话，"读不懂的范围串"（`^0.5`）与"不满足"
    //   会被混成一件事 —— 而它们对作者的含义完全不同：前者是"你这行写错了"
    //   （打包器当场就该拦住），后者才是"这个站点版本低"。
    if (!c.ok) assert.equal(ret.kind, c.kind, `${where} 夹具说 kind=${c.kind}，得到 ${ret.kind}`);
  });

  // 3c) ★ 握手：客户端版本 × 服务端版本 → 一个态。**只有客户端读这一段**
  //     （守护进程不执行这条检查，它拿不到客户端的版本 —— 见 PROTOCOL）。
  for (const c of fx.check.cases) {
    const client = 'client' in c ? c.client : null;
    // ★ 键不写 = JS 的 undefined："答了，但里面没有一个能用的版本号"。
    //   它与 null（"没问到"）是**两件事**，而夹具里两条都有。
    const server = 'server' in c ? c.server : undefined;
    const g = M.versionCheck(client, server);
    const where = `握手夹具 ${JSON.stringify(c)}`;
    assert.equal(g.verdict, c.verdict, `${where} 夹具说 ${c.verdict}，得到 ${g.verdict}`);
    assert.equal(g.blocked, c.blocked, `${where} 夹具说 blocked=${c.blocked}，得到 ${g.blocked}`);
  }
  // ★ 内测期那条例外必须**明确地**红一次：`0.y` 里 client_behind 不拦人。
  //   1.0 发布时那条例外要删掉，而"删掉一行 if"与"手滑删掉一行 if"在代码里
  //   长得一模一样 —— 这条断言就是那个区别。
  assert.equal(M.versionCheck('0.6', '0.7').blocked, false,
    '0.y 是内测期，不受版本约束：那时客户端落后只说明、不拦');
  assert.equal(M.versionCheck('2.4', '2.5').blocked, true,
    '★ 同 x 内客户端落后要拦 —— 这条与上面那条是同一个判定的两半，'
    + '删掉内测例外时这一条必须仍然红');

  // 4) ★ 两条"不许静静通过"的路径。
  //    段数不同 ⇒ 抛，而不是把 `0.6` 与 `0.6.0` 比出一个"相等"来；
  //    插件版本不合形状 ⇒ 抛（走到那里说明清单校验漏了）。
  assert.throws(() => M.cmpVer(['0', '6'], ['0', '6', '0']), /段数不同/);
  assert.throws(() => M.cmpPluginVer('1.0', '1.0.0'), /不合形状/);

  // 5) ★ 本客户端自己的版本号必须合框架版本的形状 —— 忘了改 package.json 时
  //    这条会红在本地，而不是等到 CI。（集群侧 19.0b2 有一条同样的。）
  assert.ok(M.FRAMEWORK_VERSION_RE.test(M.hostVersion()),
    `client/package.json 的版本 ${JSON.stringify(M.hostVersion())} 必须是 x.y`);

  // 6) ★ 上面那张表测的是**正则**，而"清单里的版本号按**原串**匹配"是**另一条
  //    规则** —— 它住在 parseVer / inspectDir 里，而夹具表抓不到它：只要有人先
  //    trim 一下，`" 1.0.0 "` 当然就过正则了（变异验证里这一条**真的**没红）。
  //    所以这里走一遍**真的清单加载**。Python 侧同一件事在 19.0b2 的 need_str
  //    那一条上 —— 那一侧从前正是**先 strip 再匹配**的。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-ver-'));
  try {
    const badVersions = [' 1.0.0', '1.0.0 ', '1.0.0\n', '1.0'];
    badVersions.forEach((v, i) => writePlugin(tmp, `bad${i}`, { name: `bad${i}`, version: v }));
    const reg = new M.Registry([{ dir: tmp, source: 'pool' }]);
    assert.deepEqual(reg.list().map((p) => p.version), [],
      '带空白 / 少一段的版本号一个都不许收下');
    assert.equal(reg.errors.length, badVersions.length, '每一个都要有一条自己的报错');
    assert.ok(reg.errors.every((e) => /version/.test(e)), reg.errors.join(' / '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 7) ★ 上面 3b 钉的是**纯函数**。这一条钉它**真的接在清单那条路上** ——
  //    函数写了却没人调（或者调用点被换回从前那段内联逻辑），3b 那一类是**绿的**。
  //    这个仓库里"一行包装 + 一份没人验的注释"已经出现过不止一次。
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-eng-'));
  try {
    const cases = [
      [{ engines: { slurmate: '>=0.0' } }, true, '满足 ⇒ 收下'],
      [{ engines: {}, }, true, '空对象 ⇒ 没有范围要判 ⇒ 收下'],
      [{}, true, '根本没有这个键 ⇒ 收下'],
      [{ engines: { slurmate: '>=99.0' } }, false, '不满足 ⇒ 拒'],
      [{ engines: { slurmate: '^0.5' } }, false, '读不懂的范围串 ⇒ 拒'],
      [{ engines: 'slurmate' }, false, 'engines 是字符串 ⇒ 拒'],
      [{ engines: { node: '>=18' } }, false, '认不得的键 ⇒ 拒'],
      [{ engines: null }, false, 'null 是**出现过的值** ⇒ 拒（不是"没写"）'],
    ];
    cases.forEach(([over, , ], i) => writePlugin(tmp2, `e${i}`, { name: `e${i}`, ...over }));
    const names = new Set(new M.Registry([{ dir: tmp2, source: 'pool' }]).list().map((p) => p.name));
    cases.forEach(([over, want, why], i) => {
      assert.equal(names.has(`e${i}`), want,
        `走清单那一路：engines=${JSON.stringify(over.engines)} ⇒ ${why}`);
    });
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

test('★ 读不到自己的版本号 ⇒ 插件**装不得**，且说的是"哪一项检查没做"', (t) => {
  // ★ 这一格从前是 fail-open，而且比"跳过一项检查"更糟：`inspectDir` 里的短路
  //   （`&& host`）在 host 读不到时**同时跳过了两项**（形状检查与范围检查），
  //   于是 `engines: "slurmate"`（一个字符串）也会被收下。
  //
  // ★ 它还有一句话必须说对：这是**客户端自己**的安装问题（读不到 package.json），
  //   不是插件的问题。说成"这个插件用不了"会把用户指去找作者或管理员，而他们
  //   什么也做不了。
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (String(req).includes('package.json')) throw new Error('故意造：读不到 package.json');
    return origLoad.call(this, req, parent, isMain);
  };
  t.after(() => { Module._load = origLoad; });

  // 重新加载，让 hostVersion 走到那条 catch 上（模块级没有缓存这个值）。
  delete require.cache[require.resolve('../src/main/plugins/index.js')];
  const M = require('../src/main/plugins/index.js');
  assert.equal(M.hostVersion(), null, '这条用例自己的前提：这时候真的读不到版本号');

  const r = M.enginesProblem({ engines: { slurmate: '>=0.0' } }, M.hostVersion());
  assert.notEqual(r, null,
    '★ 判不了就必须拒 —— `>=0.0` 对任何真实 host 都成立，所以它失败的原因是'
    + '"判不了"，而"判不了"绝不许长得像"通过"');
  assert.equal(r.kind, 'unknown_host', JSON.stringify(r));
  assert.match(r.why, /读不到自己的版本号/);
  assert.ok(!/这个插件用不了/.test(r.why),
    '★ 这是客户端这一侧的安装问题，说成"插件用不了"会把用户指去找作者');

  // 反侧：**没有** engines 的插件照样收下 —— 读不到自己的版本不该把能做的事也拦掉。
  assert.equal(M.enginesProblem({}, null), null, '没有这个键 ⇒ 没有范围要判 ⇒ 收下');
  assert.equal(M.enginesProblem({ engines: {} }, null), null, '空对象 ⇒ 同上');

  delete require.cache[require.resolve('../src/main/plugins/index.js')];
});

/**
 * ★★ 版本闸：同 x 内客户端落后 ⇒ 拦住，一次会话都不建。
 *
 * ★ 为什么要把 `package.json` 桩掉：今天客户端是 `0.y`，而 **`0.y` 是内测期、
 *   不受版本约束**（`versionCheck` 里那条带到期条件的例外）。所以"拦住"那一格
 *   用真版本号**走不到** —— 而它恰恰是这条规则唯一会拦人的一格。
 *   规则本身（含那条例外）在上一条用例里按夹具逐条钉着；这一条钉的是**接线**：
 *   index.js 真的调了它、真的在 `blocked` 时停了下来。
 */
test('★★ 版本闸：同 x 内客户端落后 ⇒ 拦住；其余各态放行但出声', async (t) => {
  const realLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (String(req).endsWith('package.json')) return { version: '2.4' };
    return realLoad.call(this, req, parent, isMain);
  };
  t.after(() => { Module._load = realLoad; });

  const idx = require('../src/main/index.js');
  const conn = await invoke('app:saveConnection',
    { user: 'demo', host: '203.0.113.9', port: 10100, label: '版本闸' });

  // ★ 这个文件里的用例共用一个 Electron 实例，所以"一次会话都不许建"要拿
  //   **前后对比**来说：直接断言 `app:state` 是 null 会被上一个用例留下的那个
  //   `releasing` 会话判红 —— 而那与这道闸无关。
  const sidBefore = (await invoke('app:state'))?.sessionId ?? null;

  // ① 服务端更新、**同一个大版本** —— 那条要求咬人的那一格。
  await invoke('app:debug', 'daemon-version', '2.5');
  const r = await invoke('app:connect', { connectionId: conn.connection.id });
  assert.equal(r.ok, false, `客户端落后必须被拦住：${JSON.stringify(r)}`);
  assert.equal(r.code, 'client_behind', JSON.stringify(r));
  // ★ 两个版本号都要在：用户唯一能做的动作是升级客户端，他得知道升到哪一版。
  assert.match(r.error, /2\.5/, r.error);
  assert.match(r.error, /2\.4/, r.error);
  assert.equal(idx._test.getBackend().connected, false,
    '★ 拦住时连接必须已经关掉 —— 不许留一条"连上了、但不许用"的连接占着守护进程');
  assert.equal((await invoke('app:state'))?.sessionId ?? null, sidBefore,
    '★ 一次会话都不许建 —— 判定只在连接期做，会话一个字都不该被动到');
  // 注：`whoami` 不能用来说这件事 —— 它是模块级的，上一个用例早就把它填上了。
  // "这道闸真的跑过"由上面的 `code === 'client_behind'` 保证：那个 code 只有
  // `applyVersionGate` 产得出来。

  // ② 反方向：同 x 而客户端**更新** —— 这是被承诺过的那一格，必须放行。
  await invoke('app:debug', 'daemon-version', '2.3');
  const r2 = await invoke('app:connect', { connectionId: conn.connection.id });
  assert.equal(r2.ok, true,
    `同 x 且客户端更新 ⇒ 必须放行（"同 x 保证兼容"承诺的就是这一格）：${JSON.stringify(r2)}`);

  // ③ 跨大版本：**不拦**，但要说出来。
  await invoke('app:debug', 'daemon-version', '1.28');
  const r3 = await invoke('app:connect', { connectionId: conn.connection.id });
  assert.equal(r3.ok, true,
    '跨大版本**不判为不兼容**（"不一定，不是绝对不"）—— 拦住它等于把"我们不知道"说成"不行"');

  // ④ 而"答了却没有能用的版本号"是另一件事：不拦，但绝不许被当成"旧"。
  await invoke('app:debug', 'daemon-version', '');
  const r4 = await invoke('app:connect', { connectionId: conn.connection.id });
  assert.equal(r4.ok, true, JSON.stringify(r4));

  // 还原现场：这个文件里所有用例共用同一个 Electron 实例。
  await invoke('app:debug', 'daemon-version', null);
  const back = await invoke('app:connect', { connectionId: conn.connection.id });
  assert.equal(back.ok, true, `还原现场失败（后面的用例都假定连着）：${JSON.stringify(back)}`);
  await invoke('app:deleteConnection', conn.connection.id);
  assert.equal(idx._test.getBackend().connected, true,
    '收尾之后演示后端必须还是连着的 —— 这个文件里后面的用例没做重连');
});

test('★ 卸载一个插件：立刻认不出来，但已有会话仍然能被管', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const { Registry } = require('../src/main/plugins/index.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-plug-'));
  const id = mintId();
  writePlugin(tmp, 'temp', { id, name: 'temp', displayName: '临时' },
    'module.exports = {};\n');

  const reg = new Registry([{ dir: tmp, source: 'pool' }]);
  assert.equal(reg.get(id, '1.0.0').name, 'temp', '装上之后认得');

  fs.rmSync(path.join(tmp, 'temp'), { recursive: true, force: true });
  reg.reload();
  assert.equal(reg.get(id, '1.0.0'), null,
    '卸掉之后认不出来 —— 而"认不出来"的归宿是"只解释、不动作"，不是崩溃');
  // ★ 会话本身不受影响：状态/心跳/停止只认 session_id，一次都不查插件。
  //   这条断言是"卸载插件之后用户仍然能停掉作业"的全部依据。
  const { SessionController } = require('../src/main/session.js');
  const sess = new SessionController({
    backend: { rpc: async () => ({ ok: true, data: {} }), dial: async () => {}, close() {} },
    requestedKind: 'temp',
  });
  sess.sessionId = 'sid-1';
  assert.equal(sess.snapshot().state, 'idle');
  await sess.stop();          // 卸载之后照样停得掉（它只发 session_id）
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── ★ 池是安装点：装得进、卸得掉、两者都不许绕过撞车规则 ────────────────────

test('★ 安装器：装进池、幂等、以及**绝不覆盖**内容不同的同一版', (t) => {
  t.after(() => { Module._load = origLoad; });
  const { installFrom, uninstall } = require('../src/main/plugins/install.js');
  const { Registry } = require('../src/main/plugins/index.js');
  const pool = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-inst-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-src-'));

  const id = mintId();
  writePlugin(src, 'thing', { id, name: 'thing', displayName: '东西' }, 'module.exports = {};\n');
  const srcDir = path.join(src, 'thing');      // 装的是**插件目录**，不是装着它的那个

  const a = installFrom(pool, srcDir);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.already, false);
  // 落在 `<池>/<id>/<版本>/` —— 两层的布局让同一个插件的多个版本并存。
  assert.equal(a.dest, path.join(pool, id, '1.0.0'));

  // 再装一次：内容一样就是同一个构件，幂等，不报错也不改动
  const b = installFrom(pool, srcDir);
  assert.equal(b.ok, true);
  assert.equal(b.already, true, '同样内容的第二次安装应当是幂等的');

  // ★ 同一 `(id, 版本)` 而**内容不同** —— 这不是"更新"，是两个东西在抢同一个
  //   身份。安装器绝不能变成绕过那条规则的覆写后门：那会让某个会话静默地拿到
  //   另一个插件的代码。要更新就升版本号。
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-evil-'));
  writePlugin(evil, 'thing', { id, name: 'thing', displayName: '冒牌' }, 'module.exports = {};\n');
  const c = installFrom(pool, path.join(evil, 'thing'));
  assert.equal(c.ok, false, '★ 同一 (id, 版本) 而内容不同必须**拒绝安装**，不是覆盖');
  assert.match(c.error || '', /版本/, `要说清该怎么办（升版本号）：${c.error}`);
  // 原样的那一份必须**一个字都没被动过**
  const reg = new Registry([{ dir: pool, source: 'pool' }]);
  assert.equal(reg.get(id, '1.0.0').displayName, '东西', '被拒绝的安装不许留下任何痕迹');

  // 装一个坏目录：明确失败，不留下半份插件
  const junk = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-junk-'));
  fs.writeFileSync(path.join(junk, 'plugin.json'), '{ not json');
  const d = installFrom(pool, junk);
  assert.equal(d.ok, false);
  assert.match(d.error || '', /plugin\.json|JSON/, `要说清坏在哪：${d.error}`);

  // ★ **删之前先读一遍**：这个函数会 `rm -rf` 一个由 id/版本 拼出来的路径。
  //   先造一个"目录名与里面那份清单对不上"的现场（`<id>/2.0.0/` 里的清单自报
  //   1.0.0）—— 这时绝不能动手，因为路径是按调用方说的拼的，而内容不是它要的。
  //   （这一步必须在真卸载**之前**做 —— 卸载会把 a.dest 删掉，拷不出来了。）
  const mislabeled = path.join(pool, id, '2.0.0');
  fs.cpSync(a.dest, mislabeled, { recursive: true });
  const u3 = uninstall(pool, id, '2.0.0');
  assert.equal(u3.ok, false, '★ 目录里的插件自报的身份与要卸的不符时，不许删它');
  assert.match(u3.error || '', /2\.0\.0/, `要说清看到的是什么：${u3.error}`);
  assert.equal(fs.existsSync(mislabeled), true, '它必须还在');

  // 卸载：删之前先确认那个目录真的是它
  const u = uninstall(pool, id, '1.0.0');
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(fs.existsSync(a.dest), false, '卸掉之后目录要真的没了');
  const u2 = uninstall(pool, id, '1.0.0');
  assert.equal(u2.ok, false, '再卸一次要明确失败，而不是静静地成功');
  // 还剩一个版本时，`<id>/` 那一层目录**不能**被收掉
  assert.equal(fs.existsSync(path.join(pool, id)), true,
    '同一个 id 还有别的版本在时，不能把那一层目录删掉');

  for (const d2 of [pool, src, evil, junk]) fs.rmSync(d2, { recursive: true, force: true });
});

test('★★ 从一个包安装（开发者模式那个入口）：解开、建树、走**同一个**安装器', (t) => {
  t.after(() => { Module._load = origLoad; });
  const crypto = require('node:crypto');
  const { installFromPackage } = require('../src/main/plugins/install.js');
  const PACKER = require('../../packer/slurmate-packer.js');
  const pool = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-pkgpool-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-pkgsrc-'));

  const id = mintId();
  const dir = writePlugin(src, 'thing', { id, name: 'thing', displayName: '东西' },
    'module.exports = {};\n');
  fs.mkdirSync(path.join(dir, 'job'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'job', 'start.sh'), '#!/bin/sh\n');

  // 拿仓库里那个打包器**现打一个真包**（不是手搓字节 —— 手搓就等于在这里又
  // 实现了一遍容器格式，而它与真格式分家的那天，这条用例反而会说"一切正常"）。
  const files = fs.readdirSync(dir).flatMap(function walk(rel) {
    const full = path.join(dir, rel);
    if (fs.statSync(full).isDirectory()) {
      return fs.readdirSync(full).map((n) => path.join(rel, n)).flatMap(walk);
    }
    const data = fs.readFileSync(full);
    return [{ path: rel.split(path.sep).join('/'), data,
              sha256: crypto.createHash('sha256').update(data).digest('hex') }];
  }, '');
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const digest = PACKER.contentDigest(files);
  const sig = crypto.sign(null, Buffer.from(digest, 'hex'), privateKey);
  const buf = PACKER.buildPackage(files, Buffer.concat([Buffer.from([1]), pub, sig]));
  const pkgFile = path.join(src, 'thing.splug');
  fs.writeFileSync(pkgFile, buf);
  const fp = crypto.createHash('sha256').update(pub).digest('hex');

  const a = installFromPackage(pool, pkgFile);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.dest, path.join(pool, id, '1.0.0'));
  assert.equal(a.fingerprint, fp, '★ 签名者要如实报出来给用户看');
  assert.equal(fs.existsSync(path.join(a.dest, 'job', 'start.sh')), true,
    '包里的每一份都要铺出来（包括客户端不看的那一半）');

  // 幂等：同一个包再装一次，内容一样 ⇒ 同一个构件。
  assert.deepEqual(installFromPackage(pool, pkgFile), { ...a, already: true });

  // 装完之后**走的是同一个安装器**，"绝不覆盖内容不同的同一版"照旧成立。
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-pkg2-'));
  const dir2 = writePlugin(other, 'thing', { id, name: 'thing', displayName: '冒牌' },
    'module.exports = {};\n');
  const files2 = [{ path: 'plugin.json', data: fs.readFileSync(path.join(dir2, 'plugin.json')),
                    sha256: crypto.createHash('sha256')
                      .update(fs.readFileSync(path.join(dir2, 'plugin.json'))).digest('hex') }];
  const buf2 = PACKER.buildPackage(files2, Buffer.alloc(0));
  const pkg2 = path.join(other, 'thing.splug');
  fs.writeFileSync(pkg2, buf2);
  const c = installFromPackage(pool, pkg2);
  assert.equal(c.ok, false, '★ 同一个 (id, 版本) 而内容不同 ⇒ 拒绝，不是覆盖');
  assert.equal(fs.existsSync(path.join(pool, id, '1.0.0', 'job', 'start.sh')), true,
    '被拒绝的那一次不许留下任何痕迹');

  // 一个读不了的包：明确失败，而且**临时目录里不许留下半棵树**。
  const junk = path.join(src, 'junk.splug');
  fs.writeFileSync(junk, Buffer.concat([buf.subarray(0, 40), Buffer.from([1, 2, 3])]));
  const d = installFromPackage(pool, junk);
  assert.equal(d.ok, false);
  assert.match(d.error || '', /读不了|字节/, `要说清为什么：${d.error}`);

  for (const x of [pool, src, other]) fs.rmSync(x, { recursive: true, force: true });
});

test('★ 池扫两层：用户拷一个目录进去能用，同一个插件的多版本也能并存', (t) => {
  t.after(() => { Module._load = origLoad; });
  const { Registry } = require('../src/main/plugins/index.js');
  const pool = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-two-'));

  // 一层：用户手工 `cp -r 插件目录 池/` 得到的形状
  const flat = mintId();
  writePlugin(pool, 'readable-name', { id: flat, name: 'flat', displayName: '一层' });

  // 两层：安装器写出来的形状，同一 id 两个版本并存
  //
  // ★ `version` 必须**显式写**（writePlugin 的缺省是 1.0.0）。少了它，两个目录
  //   里的清单就是"同一个 (id, 版本) 而内容不同"—— 撞车规则会正确地**两个都不
  //   加载**，而这条用例就会红在一个与它要测的东西无关的地方。（第一次就是这么
  //   红的，而失败信息长得像"两层没扫到"。）
  const deep = mintId();
  writePlugin(path.join(pool, deep), '1.0.0',
    { id: deep, name: 'deep', version: '1.0.0', displayName: '两层旧' });
  writePlugin(path.join(pool, deep), '2.0.0',
    { id: deep, name: 'deep', version: '2.0.0', displayName: '两层新' });

  const reg = new Registry([{ dir: pool, source: 'pool' }]);
  assert.deepEqual(reg.list().map((p) => `${p.name}@${p.version}`).sort(),
    ['deep@1.0.0', 'deep@2.0.0', 'flat@1.0.0'],
    '两种布局都要扫到 —— 目录名不参与判定，深浅也不参与');
  assert.equal(reg.get(deep, '1.0.0').displayName, '两层旧', '两个版本各是各的');

  fs.rmSync(pool, { recursive: true, force: true });
});

test('★ 零插件：界面拿到的是一份说得通的空态，不是"安装包坏了"', async (t) => {
  t.after(async () => {
    Module._load = origLoad;
    setPool(['code-server', 'sshd']);
  });
  await withPool([], async () => {
    const r = await invoke('app:partitions');
    const pv = r.plugins;

    assert.deepEqual(pv.plugins, [], '一个按钮都不该画出来');
    // ★ 这两条是承重的：界面靠它们把「你还没装插件」与「站点升级了而本机是旧的」
    //   分开 —— 而这两种情况在 `missing` 里长得一模一样。没有它们，零插件时
    //   界面对站点上每一个插件都会喊"升级客户端"。
    assert.equal(pv.installedCount, 0, '要能分辨"池是空的"');
    assert.ok(pv.poolDir && pv.poolDir.length > 0, '要给出池在哪 —— 那是"我该往哪放"的答案');
    assert.ok(pv.errors.length === 0, '池空不是错误');

    // ★ 站点分发接上来之后，这一条**变强了**：演示站点报的不再是"本机池里有什么"
    //   （那样「站点有而本机没有」在演示里永远走不到），而是仓库里那两个**真插件**
    //   （见 backend-fake 的 _siteIndex）。于是池空 + 本机没有它们 ⇒ `missing`
    //   里就是它们，而且每一份都**带着文件清单**（`distributed: true`）——
    //   那正是界面该说"去同步"而不是"去升级客户端"的判据。
    assert.deepEqual(pv.missing.map((m) => m.name).sort(), ['code-server', 'sshd'],
      '站点照实报了它要分发的两个插件，而本机一个都没有');
    assert.ok(pv.missing.every((m) => m.distributed === true),
      `每一份都要标出"站点会发它"：${JSON.stringify(pv.missing)}`);

    // ★ 一个插件都没有时，提交必须被**明确拦住**并给出路，而不是起一个
    //   看起来起来了但连不上的作业，也不是一句"本版支持：（一个都没有）"。
    const started = await invoke('app:start', {}, 'code-server');
    assert.equal(started.ok, false, '没有插件就起不了会话 —— 必须在提交前拦住');
    const notices = (calls.windows[0].webContents.handlers['send:ui:notice'] || [])
      .map((n) => n.text).join('\n');
    assert.match(notices, /还没有装上任何插件/, `要说清是"还没装"：${notices}`);
    // ★ 出路**取决于站点说了什么**：站点会分发 ⇒ 说"去同步"；不会 ⇒ 说"把目录放进
    //   池里、并把开发者模式打开"。说错方向的后果是用户去干一件没有用的事。
    assert.match(notices, /本站会分发插件/, `站点会分发时要说去同步：${notices}`);
  });
});

// ── ★ 站点分发：端到端走一遍（下载 → 同意 → 换入 → 加载）────────────────────

test('★★ 站点分发端到端：下来了但**没同意就不加载**，同意之后才装上', async (t) => {
  const idx = require('../src/main/index.js');
  t.after(async () => {
    Module._load = origLoad;
    // ★ 收尾必须把**站点池**也清掉：这台机器上的其余用例共用同一个 userData，
    //   留下一个装好的站点插件会让它们的 `missing` / `installedCount` 断言
    //   因为错误的理由通过或失败。同一条规矩见文件头的池设置那一段。
    fs.rmSync(idx._test.getSitePoolDir(), { recursive: true, force: true });
    idx._test.getRegistry().reload();
    idx._test.getBackend().debugReset();
  });
  await invoke('app:debug', 'reset');
  await withPool([], async () => {
    // 池子空、开发者模式在演示下恒开 ⇒ 本机一个插件都没有，而站点报了两个
    // **真文件**（仓库里的 plugins/，见 backend-fake 的 _siteIndex）。
    const r = await invoke('app:syncPlugins');
    assert.equal(r.ok, true, JSON.stringify(r));

    const siteSync = idx._test.getSiteSync();
    assert.equal(siteSync.supported, true, '演示站点会分发插件');
    const pending = idx._test.getPendingConsent();
    assert.equal(pending.length, 2, `站点那两个插件都要先过同意闸：${JSON.stringify(r.plugins.consent)}`);

    // ★ 换入**还没发生** —— 站点池里一个版本都不该有。
    const sitePool = idx._test.getSitePoolDir();
    for (const p of pending) {
      assert.equal(fs.existsSync(path.join(sitePool, p.id, p.version)), false,
        '★ 没同意的插件不许进站点池 —— 同意闸的落点在"换入之前"');
    }
    // ★ 而且它**没有被加载**（同意闸的全部意义）：池子空着，而它还没换入，
    //   所以注册表里根本查不到它。
    for (const p of pending) {
      assert.equal(idx._test.getRegistry().get(p.id, p.version), null,
        '★ 没同意的插件不许出现在注册表里 —— 出现了就意味着代码已经被加载过');
    }

    // ── 点一下同意 ──
    const first = pending[0];
    const c = await invoke('app:consentPlugin', first.id, first.version);
    assert.equal(c.ok, true, `同意应当成功：${JSON.stringify(c)}`);
    const landed = idx._test.getRegistry().get(first.id, first.version);
    assert.ok(landed, '同意之后要真的装上');
    assert.notEqual(landed.active, false, '而且要是**带钩子**的那一份');
    assert.equal(fs.existsSync(path.join(sitePool, first.id, first.version)), true,
      '同意之后它才进站点池');
    // ★ 台账里要有它，而且存的是**全长摘要**（64 位）—— 拿 16 位当键就是个碰撞面。
    const led = idx._test.getCfg().trustedPlugins[`${first.id}@${first.version}`];
    assert.ok(led, '同意要写进台账');
    assert.equal(led.digest.length, 64, '★ 台账里的摘要必须是全长的，截断只留给显示');

    // ── 不同意的那一个：暂存里那一份要被删掉，站点那边不受影响 ──
    const second = pending[1];
    const rej = await invoke('app:rejectPlugin', second.id, second.version);
    assert.equal(rej.ok, true);
    assert.equal(fs.existsSync(first.stagedDir), false, '同意过的暂存目录要收掉');
    assert.equal(idx._test.getPendingConsent().length, 0, '两个都处理完了');
    assert.equal(idx._test.getRegistry().get(second.id, second.version), null,
      '不同意的那个不许装上');
  });
});

test('★★ 撤回同意：删掉本机那一份 ⇒ 台账消失 ⇒ 重新问一次（绝不静默装回来）', async (t) => {
  // §5.3。★ 不这么做的话，用户删掉池里那一份之后，下一次对账会按"摘要与台账相符"
  //   **静默装回来、一个字都不问** —— 那不是"当作从来没有过"，那是"用户想让它
  //   消失，它自己回来了"。
  const idx = require('../src/main/index.js');
  const sitePlugin = require('../src/main/site-plugins.js');
  // ★ 钉子表是**模块级**的、而且是**跨用例**活着的（它在另一个文件里，不在
  //   cfg 里）。这一条会往里塞一把假钥匙，所以跑完必须把整张表还原 —— 不然
  //   下一条用例会拿到一把不属于它的钉子，而症状是"莫名其妙说签名者换了人"。
  const pinsBefore = { ...idx._test.getPinnedKeys() };
  t.after(async () => {
    Module._load = origLoad;
    const pins = idx._test.getPinnedKeys();
    for (const k of Object.keys(pins)) delete pins[k];
    Object.assign(pins, pinsBefore);
    fs.rmSync(idx._test.getSitePoolDir(), { recursive: true, force: true });
    idx._test.getRegistry().reload();
    idx._test.getBackend().debugReset();
  });
  await invoke('app:debug', 'reset');
  // 整包那条路：验签与钉钉子（§5.4）**只在它上面存在**。
  await invoke('app:debug', 'packages');

  await withPool([], async () => {
    const r = await invoke('app:syncPlugins');
    assert.equal(r.ok, true, JSON.stringify(r));
    const first = idx._test.getPendingConsent()[0];
    assert.ok(first, '站点要发两个插件下来');
    assert.ok(first.fingerprint, '★ 演示站点发的包是签过名的，指纹要交到界面上');

    const c = await invoke('app:consentPlugin', first.id, first.version);
    assert.equal(c.ok, true, JSON.stringify(c));

    // §5.4：同意那一刻要**钉住**签名者。它在**另一个文件**里（不是 config.json）。
    const pins = idx._test.getPinnedKeys();
    assert.equal(pins[first.id] && pins[first.id].fingerprint, first.fingerprint,
      '★ 同意一个签过名的构件 = 记下它的公钥，此后只能相符');

    // 池里**两样挨着**：解出来的树 + 那个包本身。
    const sitePool = idx._test.getSitePoolDir();
    assert.equal(fs.existsSync(path.join(sitePool, first.id, first.version)), true);
    assert.equal(fs.existsSync(sitePlugin.pkgPathOf(sitePool, first.id, first.version)), true,
      '★ 包要跟着一起进池 —— 它是这一份的来路凭证（也是验签的原料）');

    // ── 用户把它删了 ──
    fs.rmSync(path.join(sitePool, first.id, first.version), { recursive: true, force: true });
    const r2 = await invoke('app:syncPlugins');
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(idx._test.getCfg().trustedPlugins[`${first.id}@${first.version}`], undefined,
      '★ 台账那条必须消失 —— 留着就等于"静默装回来"');
    const again = idx._test.getPendingConsent().find((p) => p.id === first.id);
    assert.ok(again, '★ 而且它要**重新走一遍同意闸**，不是自己回来');
    assert.equal(again.existing, false, '这一份是新取回来的草稿（池里那份已经被删了）');

    // ── 同意 → 撤回 → 再同意：这条路必须是通的 ──
    const c2 = await invoke('app:consentPlugin', again.id, again.version);
    assert.equal(c2.ok, true, `撤回之后必须还能再同意一次：${JSON.stringify(c2)}`);

    // ── §5.4：钉住的那把钥匙与这一份的签名者不符 ⇒ 拒绝，而且两份指纹都说出来 ──
    // ★ 这一条钉的是**主进程那一边的接线**（`pinnedKey` 有没有真的接进对账）。
    //   site-plugins 那一层自己注入这个回调，所以它测不到"index.js 忘了传"。
    const bogus = 'b'.repeat(64);
    idx._test.getPinnedKeys()[first.id] = { fingerprint: bogus, at: 1 };
    delete idx._test.getCfg().trustedPlugins[`${first.id}@${first.version}`];
    idx._test.getRegistry().reload();
    const r3 = await invoke('app:syncPlugins');
    const bad = (r3.plugins.site && r3.plugins.site.failed || [])
      .find((f) => f.id === first.id);
    assert.ok(bad, `★ 签名者对不上就必须失败，不能只是"再问一次"：${JSON.stringify(r3.plugins.consent)}`);
    assert.match(bad.why, new RegExp(bogus), `要说清钉住的是哪一把：${bad.why}`);
    assert.match(bad.why, new RegExp(first.fingerprint), `也要说清这一份是谁签的：${bad.why}`);
    assert.equal(idx._test.getPendingConsent().some((p) => p.id === first.id), false,
      '签名者对不上时**连同意按钮都不该出现** —— 用户同意什么都改不了这一条');

    // ── 而"不同意"那一份：删的是**池里那一份**（如果它已经在池里）──
    const rest = idx._test.getPendingConsent();
    for (const p of rest) {
      const rej = await invoke('app:rejectPlugin', p.id, p.version);
      assert.equal(rej.ok, true, JSON.stringify(rej));
    }
    assert.equal(idx._test.getPendingConsent().length, 0);
  });
});

test('★★ 池里有一份而台账对不上 ⇒ 界面上**看得见**、能点同意（那个洞）', async (t) => {
  // ★ 在这条路补上之前：插件在注册表里（`active: false`），于是"本站有而本机没有"
  //   那一列不认领它（那边要求注册表里**查不到**），而插件那一列又滤掉了它 ——
  //   界面上彻底看不见，连"点同意"的入口都没有，重新同步也救不回来。
  //   摘要换一次公式，这件事会对**每个用户的每个插件**同时成立。
  const idx = require('../src/main/index.js');
  t.after(async () => {
    Module._load = origLoad;
    fs.rmSync(idx._test.getSitePoolDir(), { recursive: true, force: true });
    idx._test.getRegistry().reload();
    idx._test.getBackend().debugReset();
  });
  await invoke('app:debug', 'reset');
  await withPool([], async () => {
    await invoke('app:syncPlugins');
    const first = idx._test.getPendingConsent()[0];
    await invoke('app:consentPlugin', first.id, first.version);

    // 台账那一条不见了（用户换过机器 / 删过配置 / 换过摘要公式）。
    const cfg = idx._test.getCfg();
    delete cfg.trustedPlugins[`${first.id}@${first.version}`];
    idx._test.getRegistry().reload();

    // ★ 洞的样子：它在注册表里，但没有钩子；而"本机没有"那一列也不认领它。
    const p = idx._test.getRegistry().get(first.id, first.version);
    assert.ok(p, '它还在注册表里（这正是"本机没有"那一列不认领它的原因）');
    assert.equal(p.active, false, '而没有钩子 —— 它的代码不许跑');

    const r = await invoke('app:syncPlugins');
    const view = r.plugins;
    const consent = (view.consent || []).find((x) => x.id === first.id);
    assert.ok(consent, `★★ 它必须出现在待同意那一列里 —— 这就是那个洞：${JSON.stringify(view.consent)}`);
    assert.equal(consent.existing, true, '★ 而且要标明"本机已经有一份"（出路与草稿不同）');

    // 点同意 ⇒ 原地认领，不重下。
    const c = await invoke('app:consentPlugin', first.id, first.version);
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(fs.existsSync(path.join(idx._test.getSitePoolDir(), first.id, first.version)), true,
      '★ 原地认领不能把那一份弄没了');
    assert.notEqual(idx._test.getRegistry().get(first.id, first.version).active, false,
      '认领之后它要真的被加载');

    // ── 再来一次，这回点"不同意"：删的必须是**池里那一份** ──
    // ★ 不删的话它就是一个"用户在界面上拒绝了、却仍然躺在磁盘上"的插件，而且
    //   下次对账会以同一个形状回来 —— 用户点一百次不同意也去不掉它。
    // 埋一条**摘要对不上**的旧记录：于是"不同意"那一步除了删构件，还该把它清掉
    // （留着的话，下次对账会按"摘要与台账相符"把这一份静默装回来）。
    cfg.trustedPlugins[`${first.id}@${first.version}`] =
      { digest: 'e'.repeat(64), alg: 1, site: 'old', at: 1 };
    idx._test.getRegistry().reload();
    const r2 = await invoke('app:syncPlugins');
    const again = (r2.plugins.consent || []).find((x) => x.id === first.id);
    assert.equal(again && again.existing, true, JSON.stringify(r2.plugins.consent));
    const rej = await invoke('app:rejectPlugin', first.id, first.version);
    assert.equal(rej.ok, true, JSON.stringify(rej));
    assert.equal(fs.existsSync(path.join(idx._test.getSitePoolDir(), first.id, first.version)), false,
      '★ 对"已经在池里"的那一份点不同意，删的就是池里那一份');
    assert.equal(cfg.trustedPlugins[`${first.id}@${first.version}`], undefined,
      '★ 而且台账里那条（哪怕摘要对不上）也要一并消失 —— 留着就是"静默装回来"');
  });
});

test('★ §5.1③：往站点池里手放一份合法的树 ⇒ 不出现、也不加载；但**看得见**', async (t) => {
  // ★ 「本机有一份，但**没有任何站点报过它**」是三条"你没有这个插件"里的一条，
  //   而它与另外两条要做的事不同。手工放进去的东西**禁止**被加载（§5.1），
  //   但它也**禁止**被藏起来 —— 用户会问"我放的那个东西去哪了"。
  const idx = require('../src/main/index.js');
  t.after(async () => {
    Module._load = origLoad;
    fs.rmSync(idx._test.getSitePoolDir(), { recursive: true, force: true });
    idx._test.getRegistry().reload();
    idx._test.getBackend().debugReset();
  });
  await invoke('app:debug', 'reset');
  await withPool([], async () => {
    // 站点只报仓库里那两个（见 backend-fake 的 _siteIndex），所以这一份站点不会报。
    const id = mintId();
    // ★ 先在台账里埋一条**摘要对不上**的旧记录：这正是"池里有一份、台账对不上"
    //   的形状。删掉本机那一份时它必须一起没 —— 留着的话，下次对账会按"摘要与
    //   台账相符"把这一份**静默装回来**（§5.3）。
    idx._test.getCfg().trustedPlugins[`${id}@1.0.0`] = {
      digest: 'e'.repeat(64), alg: 1, site: 'old', at: 1,
    };
    const dir = path.join(idx._test.getSitePoolDir(), id, '1.0.0');
    fs.mkdirSync(path.join(dir, 'client'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(
      { id, name: 'handmade', displayName: '手放的', version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(dir, 'client', 'index.js'), 'module.exports = {};\n');
    idx._test.getRegistry().reload();

    const p = idx._test.getRegistry().get(id, '1.0.0');
    assert.ok(p, '它在注册表里（要看得见）');
    assert.equal(p.active, false, '★ 但**不许加载** —— 装插件只有"安装一个包"这一条路');
    assert.equal(p.attach, null, '一个钩子都不能有');

    const view = idx._test.getPluginsView();
    assert.equal((view.plugins || []).some((x) => x.id === id), false, '不进"可用"那一列');
    assert.equal((view.missing || []).some((x) => x.id === id), false, '也不在"站点有而本机没有"里');
    assert.ok((view.inert || []).some((x) => x.id === id),
      `★★ 必须有一个地方看得见它 —— 否则用户面对的是"我放的东西凭空消失"：${JSON.stringify(view.inert)}`);

    // 出口：删掉本机这一份。
    const d = await invoke('app:dropPluginVersion', id, '1.0.0');
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(fs.existsSync(dir), false);
    assert.equal(idx._test.getCfg().trustedPlugins[`${id}@1.0.0`], undefined,
      '★ 删掉本机那一份 = 撤回同意：台账里那条（哪怕摘要对不上）也必须消失');
  });
});

test('★ 「站点愿不愿意发这一份」：有 `package` 就算，而且**一次都不用真去取**', async (t) => {
  // ★ 这条判据是界面上分开两种出路的那道闸（一个去同步、一个去问管理员），而它
  //   换过两次判据：`Array.isArray(p.files)` → "两条路有没有一条能走" → 今天
  //   "`package` 在不在"。三次都是同一个理由：判据必须是**协议事实**。
  //
  //   ★ 它同时钉着一件事：这一步**一个字节都不下载** —— `missing` 是拿清单算的，
  //     不是拿对账的结果算的。所以"本机一个都没同意"时，界面照样能说清每一份
  //     到底该走哪条路。
  const idx = require('../src/main/index.js');
  t.after(async () => {
    Module._load = origLoad;
    fs.rmSync(idx._test.getSitePoolDir(), { recursive: true, force: true });
    idx._test.getRegistry().reload();
    idx._test.getBackend().debugReset();
  });
  await invoke('app:debug', 'reset');
  // ★ `pluginsView()` 里那份"站点有哪些插件"来自**连接时**的 `op:plugins`
  //   （`refreshPartitions`），不是对账那一轮 —— 所以开关改完要重新问一次，
  //   否则断言的是一个开关改之前就取到的清单（那样这条用例永远绿）。
  await invoke('app:partitions');
  await withPool([], async () => {
    const r = await invoke('app:syncPlugins');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(idx._test.getPendingConsent().length, 2,
      `只发包也要能取回来：${JSON.stringify(r.plugins.site && r.plugins.site.failed)}`);
    for (const m of (r.plugins.missing || [])) {
      assert.equal(m.distributed, true, `★ 站点愿意发它（只是本机还没同意）：${JSON.stringify(m)}`);
    }
    assert.ok((r.plugins.missing || []).length > 0, '前置：本机一个都还没同意，所以它们都在 missing 里');
  });
});

test('★ F18 回归：改了 client/ 下的文件而不动 plugin.json，摘要必须变', (t) => {
  t.after(() => { Module._load = origLoad; });
  // ★ 改之前这条会红：摘要只算了「清单 + client/index.js」两个文件，于是
  //   `client/sshconfig.js` 被换掉、摘要纹丝不动 —— 而它是**真的代码**。
  const P = require('../src/main/plugins/index.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-f18-'));
  writePlugin(root, 'a', { name: 'a', displayName: 'A' }, 'module.exports = {};\n');
  fs.writeFileSync(path.join(root, 'a', 'client', 'sshconfig.js'), '// 第一版\n');
  const d1 = P.digestOf(P.readPluginFiles(path.join(root, 'a')));
  fs.writeFileSync(path.join(root, 'a', 'client', 'sshconfig.js'), '// 第二版\n');
  const d2 = P.digestOf(P.readPluginFiles(path.join(root, 'a')));
  assert.notEqual(d1, d2, '★ 只改 client/ 下的一个文件，摘要也必须变（F18）');

  // ★ 而"摘要相同 ⇒ 树相同"的另一半：一条符号链接与一个内容恰好等于链接目标串
  //   的普通文件，**摘要必须不同**（前者加载 y.js，后者导出一个字符串）。
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-sym-'));
  const a = path.join(root2, 'a'); const b = path.join(root2, 'b');
  for (const d of [a, b]) {
    fs.mkdirSync(path.join(d, 'client'), { recursive: true });
    fs.writeFileSync(path.join(d, 'plugin.json'), '{"id":"x"}');
  }
  fs.writeFileSync(path.join(a, 'client', 'y.js'), 'module.exports = 1;\n');
  fs.symlinkSync('../y.js', path.join(a, 'client', 'x.js'));
  fs.writeFileSync(path.join(b, 'client', 'y.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(b, 'client', 'x.js'), '../y.js');
  assert.notEqual(P.digestOf(P.readPluginFiles(a)), P.digestOf(P.readPluginFiles(b)),
    '★ 链接与"内容等于目标串的普通文件"必须是不同的树');

  // 空目录也要进摘要，否则"只差一个空目录"的两棵树摘要相同
  fs.mkdirSync(path.join(b, 'empty'));
  assert.notEqual(P.digestOf(P.readPluginFiles(a)), P.digestOf(P.readPluginFiles(b)));

  for (const d of [root, root2]) fs.rmSync(d, { recursive: true, force: true });
});

test('★ `missing` 不说谎：站点**关掉**的插件不算"本机没有"', async (t) => {
  t.after(async () => {
    Module._load = origLoad;
    const idx = require('../src/main/index.js');
    idx._test.getBackend().debugReset();
  });
  const idx = require('../src/main/index.js');
  await invoke('app:debug', 'reset');
  await withPool([], async () => {
    // ★ **先把站点池清空**。不清的话，前面那条端到端用例已经同意并装上了
    //   code-server，`registry.get()` 查得到它 —— 于是这条用例会**因为错误的理由**
    //   通过（"本机已经有它"而不是"站点关掉的不算数"），变异验证 M12 就是这样
    //   漏过去的。
    fs.rmSync(idx._test.getSitePoolDir(), { recursive: true, force: true });
    idx._test.getRegistry().reload();

    const r0 = await invoke('app:partitions');
    assert.ok(r0.plugins.missing.map((m) => m.name).includes('code-server'),
      '前置：清空之后站点开着、本机没有 ⇒ 它必须在 missing 里');

    // 站点把 code-server 关掉。`op_plugins` 按协议**必须报它**（带 enabled:false），
    // 而 `missing` 以前不过滤 —— 于是管理员关掉一个插件，界面上会**永远**挂着
    // 一句"站点有而本机没有 ⇒ 升级客户端"。
    idx._test.getBackend().debugDisableSitePlugin('code-server');
    const r = await invoke('app:partitions');
    const names = r.plugins.missing.map((m) => m.name);
    assert.equal(names.includes('code-server'), false,
      `★ 站点关掉的插件不该出现在 missing 里：${JSON.stringify(names)}`);
    assert.ok(names.includes('sshd'), '而站点开着、本机没有的那个仍然要在');
  });
});

test('★ 来源标签：只有一个来源时不贴，有两个时才贴', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const idx = require('../src/main/index.js');
  const P = require('../src/main/plugins/index.js');
  const id = mintId();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-src-'));
  writePlugin(root, 'x', { id, name: 'onlysite' }, 'module.exports = {};\n');
  const one = new P.Registry([{ dir: root, source: 'site' }]);
  assert.equal(one.list()[0].sources.length, 1, '前置');
  const pool = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-src2-'));
  writePlugin(pool, id, { id, name: 'onlysite' }, 'module.exports = {};\n');
  const two = new P.Registry([{ dir: root, source: 'site' }, { dir: pool, source: 'pool' }]);
  assert.deepEqual(two.list()[0].sources, ['pool', 'site'], '前置：两个来源合并成一条');

  const r = await invoke('app:partitions');
  // 单来源的那些：一条标签都不该有
  const single = r.plugins.plugins.filter((p) => (p.sources || []).length === 1);
  assert.ok(single.length > 0, '前置：演示里至少有一个单来源的插件');
  for (const p of single) {
    assert.equal(p.sourceLabel, null,
      '★ 只有一个来源时标签什么也没说，还让人以为看到的是两条不同的来路');
  }
  assert.ok(require('../src/main/index.js'), '（idx 已加载）');
  for (const d of [root, pool]) fs.rmSync(d, { recursive: true, force: true });
});

// ── ★ 插件增减不许把客户端带崩（这次改动的验收标准）────────────────────────

test('★ 站点装了客户端不认识的插件：不崩，而且说得出该怎么办', async (t) => {
  t.after(() => { Module._load = origLoad; });
  await invoke('app:debug', 'reset');
  await invoke('app:debug', 'extra-plugin');
  try {
    const r = await invoke('app:partitions');
    assert.equal(r.ok, true, '站点有客户端不认识的插件，不影响任何别的查询');

    // 客户端认识的那两个照常
    assert.deepEqual(r.plugins.plugins.map((p) => p.name).sort(),
      ['code-server', 'sshd']);
    // ★ 认不出的那个**要被报出来**，而不是被过滤掉 —— 它是升级提示的唯一来源。
    //   过滤掉的话，用户面对的就是"按钮凭空少了一个"，而没有任何地方解释为什么。
    const miss = r.plugins.missing.map((p) => p.name);
    assert.deepEqual(miss, ['jupyter'],
      '站点有而本机池里没有那一版的插件必须列出来');

    // 而且它绝不能出现在"能起会话"的那一类里 —— 客户端不知道怎么接它。
    assert.ok(!r.plugins.plugins.some((p) => p.name === 'jupyter'));
  } finally {
    await invoke('app:debug', 'reset');
    await invoke('app:partitions');
  }
});

test('★ 站点关掉一个插件：客户端看得见它、但起不了 —— 三种状态分得开', async (t) => {
  t.after(() => { Module._load = origLoad; });
  await invoke('app:debug', 'reset');
  await invoke('app:partitions');
  let r = await invoke('app:partitions');
  let sshd = r.plugins.plugins.find((p) => p.name === 'sshd');
  assert.equal(sshd.runnable, true, '站点开着、本机也没关 → 能起');

  await invoke('app:debug', 'site-plugin-off', 'sshd');
  try {
    r = await invoke('app:partitions');
    sshd = r.plugins.plugins.find((p) => p.name === 'sshd');
    assert.equal(sshd.siteEnabled, false, '站点关掉了');
    assert.equal(sshd.runnable, false, '站点关了就不能起');
    // ★ 但**仍然列出来**：把它藏掉，用户看到的是"按钮少了一个"，
    //   而不知道该找管理员。留着它，界面才能说清是站点没开。
    assert.ok(sshd, '站点关掉的插件仍然要在表里，只是不能起');
  } finally {
    await invoke('app:debug', 'reset');
    await invoke('app:partitions');
  }
});

test('★ 本机关掉一个插件：站点照旧，只是本机不再给按钮', async (t) => {
  t.after(async () => {
    Module._load = origLoad;
    const idx = require('../src/main/index.js');
    await invoke('app:setPluginEnabled', sshdId(), true);
    void idx;
  });
  await invoke('app:debug', 'reset');
  await invoke('app:partitions');

  const off = await invoke('app:setPluginEnabled', sshdId(), false);
  assert.equal(off.ok, true, JSON.stringify(off));

  const r = await invoke('app:partitions');
  const sshd = r.plugins.plugins.find((p) => p.name === 'sshd');
  assert.equal(sshd.locallyEnabled, false, '本机关了');
  assert.equal(sshd.siteEnabled, true, '★ 站点那边一点没动 —— 两件事');
  assert.equal(sshd.runnable, false);

  // ★ 开关按 **id** 记，不按短名：池是全局的，两个站点可以各有一个叫 `jupyter`
  //   的插件而它们是两个不同的东西（两个 id）。按短名记会让一个站点的开关管到
  //   另一个站点的那个。
  const byName = await invoke('app:setPluginEnabled', 'sshd', false);
  assert.equal(byName.ok, false, '传短名要被拒绝 —— 短名不是身份');
  const bad = await invoke('app:setPluginEnabled', 'no-such-plugin', false);
  assert.equal(bad.ok, false, '认不出的 id 要被拒绝，而不是静静写进配置');
});

test('★ 站点装了它但没有作业侧实现：看得见、开着的、就是提交不了', async (t) => {
  // 这一格与上一条**不是同一件事**：那条是管理员的开关没开（开一下就好），
  // 这条是本站的部署没跟上（管理员去开开关**没有用**，得重新跑 deploy.sh）。
  // 合成一格的话，其中一句话就永远走不到，而用户会照着错的那句去行动。
  t.after(async () => {
    Module._load = origLoad;
    await invoke('app:debug', 'reset');
    await invoke('app:partitions');
  });
  await invoke('app:debug', 'reset');
  await invoke('app:partitions');

  let r = await invoke('app:partitions');
  let sshd = r.plugins.plugins.find((p) => p.name === 'sshd');
  assert.equal(sshd.canSubmit, true, '正常站点上装了的插件就是提交得出去的');

  await invoke('app:debug', 'site-plugin-no-job', 'sshd');
  r = await invoke('app:partitions');
  sshd = r.plugins.plugins.find((p) => p.name === 'sshd');

  assert.equal(sshd.siteKnown, true, '站点是答话了的');
  assert.equal(sshd.siteEnabled, true, '★ 站点**开着**它 —— 这一点必须没变');
  assert.equal(sshd.locallyEnabled, true, '★ 本机也开着它 —— 这一点也必须没变');
  assert.equal(sshd.canSubmit, false, '站点说：装了，但没有作业侧实现');
  assert.equal(sshd.runnable, false, '所以按钮是灰的');
  // 仍然要列出来：把它藏掉，用户看到的是"按钮凭空少了一个"。
  assert.ok(sshd, '提交不了的插件仍然要在表里，只是不能起');
});

test('★ 三态纪律：老守护进程不报 can_submit ⇒ 缺席，不是"否"', async (t) => {
  // 两种"缺席"都要能过：
  //   (a) 老守护进程**根本没报这个字段**（op 在，字段不在）；
  //   (b) 老守护进程**连这个 op 都没有**（客户端连站点清单都拿不到）。
  //
  // ★ 反过来算（缺席即否）的话，升级一次客户端就会让所有老服务端的插件按钮
  //   在某一刻同时变灰 —— 而用户完全不知道为什么，服务端那边一个字都没变。
  t.after(async () => {
    Module._load = origLoad;
    await invoke('app:debug', 'reset');
    await invoke('app:partitions');
  });
  await invoke('app:debug', 'reset');
  await invoke('app:partitions');

  const idx = require('../src/main/index.js');
  const backend = idx._test.getBackend();

  // (a) op 在、字段不在：把 can_submit 从**每一份**响应里抹掉
  const origSite = backend._sitePlugins.bind(backend);
  backend._sitePlugins = () => origSite().map((p) => {
    const { can_submit: _drop, ...rest } = p;
    return rest;
  });
  try {
    const r = await invoke('app:partitions');
    const sshd = r.plugins.plugins.find((p) => p.name === 'sshd');
    assert.equal(sshd.siteKnown, true, '站点清单本身是拿得到的');
    assert.equal(sshd.canSubmit, true, '★ 字段缺席 ⇒ 按"站点没说"算可以提交');
    assert.equal(sshd.runnable, true);
  } finally {
    backend._sitePlugins = origSite;
  }

  // (b) 整个 op 都没有
  await invoke('app:debug', 'old-daemon');
  try {
    const r = await invoke('app:partitions');
    const sshd = r.plugins.plugins.find((p) => p.name === 'sshd');
    assert.equal(sshd.siteKnown, false, '老守护进程连清单都报不出来');
    assert.equal(sshd.canSubmit, true, '★ 拿不到站点清单 ⇒ 不能因此判它提交不了');
    assert.equal(sshd.runnable, true, '老服务端的用户一个按钮都不能少');
  } finally {
    await invoke('app:debug', 'reset');
    await invoke('app:partitions');
  }
});

test('sshconfig：Include 幂等，且一个字都不动用户原有的配置', (t) => {
  t.after(() => { Module._load = origLoad; });
  const sshc = require('../../plugins/sshd/client/sshconfig.js');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-sshcfg-'));
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true, mode: 0o700 });
  const userCfg = path.join(home, '.ssh', 'config');
  const original = 'Host myserver\n    HostName example.com\n\nHost *\n    ServerAliveInterval 60\n';
  fs.writeFileSync(userCfg, original, { mode: 0o600 });

  const r1 = sshc.ensureInclude(home);
  assert.equal(r1.ok, true, r1.detail || '');
  assert.equal(r1.changed, true);
  const after1 = fs.readFileSync(userCfg, 'utf8');
  assert.ok(after1.startsWith('# slurmate:include'),
    '必须加在**最上面**：ssh 对每个参数取第一个获得的值，用户那份里常见的'
    + ' `Host *` 块若排在前面，它的 Port/User 会赢过我们这一份');
  assert.ok(after1.includes(`Include ${sshc.pathsFor(home).config}`));
  assert.ok(after1.includes(original), '用户原有的内容必须逐字保留');
  assert.equal(after1.endsWith(original), true, '而且必须排在我们那两行之后');

  // 幂等：第二次连文件都不该动（mtime 也不动 —— 反复惊动用户的同步/杀毒软件
  // 本身就是一种副作用）
  const r2 = sshc.ensureInclude(home);
  assert.equal(r2.ok, true);
  assert.equal(r2.changed, false, '第二次不该再动这个文件');
  assert.equal(fs.readFileSync(userCfg, 'utf8'), after1);

  // 家目录搬走之后自愈：旧路径那一行要被**替换**掉，而不是并排留着两份
  // （并排留着的话，第一条仍然生效，而且指向一个不存在的地方）
  fs.writeFileSync(userCfg,
    after1.replace(sshc.pathsFor(home).config, '/old/home/.slurmate/ssh/config'));
  const r3 = sshc.ensureInclude(home);
  assert.equal(r3.changed, true, '路径变了要改回来');
  assert.equal(fs.readFileSync(userCfg, 'utf8'), after1,
    '旧的那一行要被换掉，不能两份并存');

  // ★ 读不出来时**绝不能**当作空文件往下写 —— 那会把用户**全部**的 ssh 配置抹掉，
  //   而这是整个客户端里后果最严重的一次写盘。
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-sshcfg-bad-'));
  fs.mkdirSync(path.join(bad, '.ssh', 'config'), { recursive: true });   // 是个目录
  const r4 = sshc.ensureInclude(bad);
  assert.equal(r4.ok, false, '读不出来就必须报错');
  assert.ok(r4.detail, '要给出原因，好让界面告诉用户手工加哪一行');
});

test('sshconfig：写出来的配置要能让 ssh 真的连上（端口、钥匙、known_hosts）', (t) => {
  t.after(() => { Module._load = origLoad; });
  const sshc = require('../../plugins/sshd/client/sshconfig.js');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-sshcfg2-'));
  const p = sshc.pathsFor(home);

  // 一次性钥匙：只生成一次，之后必须复用（换了钥匙 = 「刚才还能连，现在认证失败」）
  const k1 = sshc.ensureRelayKey(home, require('../src/main/keys.js'));
  assert.equal(k1.ok, true, k1.detail || '');
  assert.equal(k1.created, true);
  assert.match(k1.publicKeyLine, /^ssh-ed25519 [A-Za-z0-9+/]{68} slurmate-\d{8}-\d{4}$/,
    `公钥形状要能被控制节点的规则接受：${k1.publicKeyLine}`);
  const k2 = sshc.ensureRelayKey(home, require('../src/main/keys.js'));
  assert.equal(k2.created, false);
  assert.equal(k2.publicKeyLine, k1.publicKeyLine, '第二次必须复用同一把');

  const hostKey = 'ssh-ed25519 ' + 'A'.repeat(68);
  const w = sshc.writeRelayConfig({ home, port: 18090, user: 'alice', hostKey });
  assert.equal(w.ok, true, w.detail || '');
  assert.equal(w.strict, true);

  const cfg = fs.readFileSync(p.config, 'utf8');
  assert.match(cfg, /^Host slurmate$/m, '别名必须恒定 —— codex 那一侧认的就是这一个词');
  assert.match(cfg, /^\s+Port 18090$/m);
  assert.match(cfg, /^\s+User alice$/m);
  assert.match(cfg, /^\s+HostName 127\.0\.0\.1$/m);
  assert.match(cfg, /^\s+IdentityFile .*id_ed25519$/m);
  // ★ 不写这一条的话，ssh 会先把 agent 里的、~/.ssh 下的每一把都试一遍，
  //   失败会计进 MaxAuthTries（默认 6）—— 钥匙一多，还没轮到我们这把就被断开了，
  //   症状是一句「认证失败」，指不回根因。
  assert.match(cfg, /^\s+IdentitiesOnly yes$/m);
  assert.match(cfg, /^\s+StrictHostKeyChecking yes$/m,
    '拿到了主机公钥就该严格核对，而不是首次信任');
  assert.equal(fs.statSync(p.config).mode & 0o777, 0o600);
  assert.equal(fs.statSync(p.identity).mode & 0o777, 0o600);

  // known_hosts：非 22 端口必须写成 [地址]:端口，方括号不能省
  assert.equal(fs.readFileSync(p.knownHosts, 'utf8'),
    `[127.0.0.1]:18090 ${hostKey}\n`);

  // 拿不到主机公钥（守护进程还是旧版本）时退回首次信任 —— **能用但降级**
  // 好过写出一个 ssh 直接拒绝连接的配置。
  const w2 = sshc.writeRelayConfig({ home, port: 18091, user: 'alice', hostKey: null });
  assert.equal(w2.ok, true);
  assert.equal(w2.strict, false);
  const cfg2 = fs.readFileSync(p.config, 'utf8');
  assert.match(cfg2, /^\s+Port 18091$/m, '端口要跟着隧道走');
  assert.match(cfg2, /^\s+StrictHostKeyChecking accept-new$/m);
  // 形状不对的"主机公钥"绝不能被写进 known_hosts：一行一个条目，
  // 值里的换行能让它变成**两行**，也就是凭空多出一个主机条目。
  assert.equal(fs.readFileSync(p.knownHosts, 'utf8'),
    `[127.0.0.1]:18090 ${hostKey}\n`, '没有可信公钥时不许动 known_hosts');
  const evil = sshc.writeRelayConfig({ home, port: 18092, user: 'alice',
    hostKey: 'ssh-ed25519 ' + 'A'.repeat(68) + '\nevil.example ssh-ed25519 ' + 'B'.repeat(68) });
  assert.equal(evil.strict, false, '带换行的值必须被当成非法');
});

test('★ 用 dotfiles 管理 ~/.ssh/config（符号链接）的人不能被弄坏', (t) => {
  t.after(() => { Module._load = origLoad; });
  const sshc = require('../../plugins/sshd/client/sshconfig.js');

  // `~/.ssh/config -> ~/dotfiles/config` 是常见做法。而 rename(2) **不跟随目标上的
  // 符号链接** —— 直接 rename 上去会把那条链接换成一个普通文件，于是用户改
  // ~/dotfiles/config 不再影响 ssh，两边从此各说各话，且没有任何地方会报错。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-sshlink-'));
  const dotfiles = path.join(home, 'dotfiles');
  fs.mkdirSync(dotfiles, { recursive: true });
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true, mode: 0o700 });
  const real = path.join(dotfiles, 'config');
  fs.writeFileSync(real, 'Host from-dotfiles\n    HostName example.com\n', { mode: 0o600 });
  fs.symlinkSync(real, path.join(home, '.ssh', 'config'));

  const r = sshc.ensureInclude(home);
  assert.equal(r.ok, true, r.detail || '');

  const linkPath = path.join(home, '.ssh', 'config');
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true,
    '★ 那条符号链接必须还在 —— 被换成普通文件就等于用户的 dotfiles 工作流静默失效');
  assert.ok(fs.readFileSync(real, 'utf8').includes('Include ' + sshc.pathsFor(home).config),
    '内容要写进链接**指向**的那个文件');
  assert.ok(fs.readFileSync(real, 'utf8').includes('Host from-dotfiles'),
    '用户原有的内容照旧保留');
});

test('★ 读不出用户的 ssh 配置时，连碰都不能碰它', (t) => {
  t.after(() => { Module._load = origLoad; });
  const sshc = require('../../plugins/sshd/client/sshconfig.js');

  // root 能读任何文件，这条造不出来 —— 明说跳过，而不是让它静默地「全绿」。
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('  （以 root 运行：跳过「读不出来」这条用例，它在本环境无法构造）');
    return;
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-sshperm-'));
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true, mode: 0o700 });
  const cfg = path.join(home, '.ssh', 'config');
  const precious = 'Host keepme\n    HostName important.example.com\n';
  fs.writeFileSync(cfg, precious, { mode: 0o000 });

  const r = sshc.ensureInclude(home);
  assert.equal(r.ok, false, '读不出来就必须报错');
  assert.ok(r.detail, '要给出原因，好让界面告诉用户手工加哪一行');
  fs.chmodSync(cfg, 0o600);
  assert.equal(fs.readFileSync(cfg, 'utf8'), precious,
    '★ 读不出来时**绝不能**当作空文件往下写 —— 那会把用户全部的 ssh 配置抹掉，'
    + '是整个客户端里后果最严重的一次写盘');
});

test('★ 会话一结束就要收起 code-server 视图，把面板还给用户', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const idx = require('../src/main/index.js');
  const b = idx._test.getBackend();

  // 等上一个用例的会话真的被释放（演示后端要 1.6 秒，而配额是 1）
  await waitUntil(async () => !b._session
    || ['released', 'rejected', 'expired'].includes(b._session.state), '上一个会话释放');

  // ★ 盯**窗口当前那一个视图**，不去数 calls.views 的下标。
  //   数下标的话，如果中途有一次「视图被复用了、没有新建」，这个用例会以
  //   「等待超时」收场 —— 红的理由和它想验的事情毫无关系，而真正想验的那条
  //   断言（结束后视图还在不在）根本没被执行到。测试红了不等于测试对了。
  const w = idx._test.getWindow();
  await invoke('app:start', null, 'code-server');
  await waitUntil(() => (w.surfaceView && !w.surfaceView.webContents.isDestroyed()
    && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(w.surfaceView.webContents._url)
    ? w.surfaceView : null), '插件声明的那块界面');

  // 结束会话。★ 用户点下按钮之后，隧道在 stop() 的最开头就停了，页面从那一刻起
  //   就是死的 —— 而状态要等下一次 status 轮询（60 秒）才可能从 releasing 变成
  //   ended。所以收起视图必须发生在 releasing，不能等 ended：否则用户还要盯着
  //   一块打不开的页面最多一分钟，而面板上那几个「重新开始」的按钮全被它盖着。
  await invoke('app:stop');
  assert.equal(w.hasSurface(), false,
    '★ 会话结束后必须销毁 code-server 视图 —— 它是原生层、覆在面板上方，'
    + '留着就是一块盖住面板的死页面，而面板上正是「重新开始」那几个按钮');
});

/** 轮询等一个条件成立。失败时把最后看到的东西说出来，而不是干等超时。 */
async function waitUntil(fn, what, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) assert.fail(`等待「${what}」超时`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

test('★ 声明式插件：没有一行客户端代码，照样开界面', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const idx = require('../src/main/index.js');
  const b = idx._test.getBackend();
  await waitUntil(async () => !b._session
    || ['released', 'rejected', 'expired'].includes(b._session.state), '上一个会话释放');

  // ★ 这一条测的是**框架与插件的分工**，也是下一阶段（站点分发声明式插件）的形状：
  //   界面由**框架**按 `contributes.surface` 打开，不由插件代码打开。所以一个
  //   **没有 `client/index.js`** 的插件也能开界面 —— 开界面本来就不需要代码。
  //
  //   没有这一条的话，「按 contributes.surface 分派」与「按插件有没有 attach 分派」
  //   在内建的两个插件上**行为完全一样**（两个都有 attach，而 sshd 的 surface 是
  //   空、两种写法都不建视图），于是那条分派线根本没有被验到。
  const pool = path.join(userData, 'demo-config', 'plugins');
  const dir = path.join(pool, 'jupyter');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id: '01M2JKM1M1M1M1M1M1M1M1M1M1',
    name: 'jupyter',
    displayName: 'Jupyter',
    version: '1.0.0',
    description: '没有客户端代码的声明式插件。',
    // layout: false → 用**按插件**的存储分区（persist:plugin-<id>），而不是布局组。
    // 那一条分支在内建的两个插件上走不到（一个要布局组，一个不要界面）。
    contributes: { surface: { kind: 'web', path: '/lab' }, layout: false },
  }, null, 2));
  idx._test.getRegistry().reload();

  const p = idx._test.getRegistry().get('01M2JKM1M1M1M1M1M1M1M1M1M1', '1.0.0');
  assert.ok(p, '池里的插件要被扫到');
  assert.equal(p.hasClientCode, false, '前置条件：它没有客户端代码');
  assert.equal(p.attach, null, '所以也没有 attach 钩子');
  assert.deepEqual(p.contributes.surface, { kind: 'web', path: '/lab' },
    '但它**声明了**一块界面');

  await invoke('app:debug', 'reset');
  await invoke('app:debug', 'extra-plugin');          // 演示站点"也开了它"
  const conn = await invoke('app:saveConnection', { user: 'demo', host: '127.0.0.1', port: 1 });
  assert.equal((await invoke('app:connect', { connectionId: conn.connection.id })).ok, true);

  const w = idx._test.getWindow();
  const started = await invoke('app:start', null, 'jupyter');
  assert.equal(started.ok, true, `提交失败：${JSON.stringify(started.snapshot || started)}`);
  const ctl = idx._test.getController();
  await waitUntil(() => ctl.state === 'running' && ctl.snapshot().origin, '会话进入 running', 20000);

  // ★ 界面开了，而且开的是**声明里那个路径** —— 框架读的是 contributes，不是插件名。
  await waitUntil(() => (w.surfaceView && !w.surfaceView.webContents.isDestroyed()
    && /\/lab$/.test(w.surfaceView.webContents._url) ? w.surfaceView : null),
  '声明式插件的界面');
  assert.match(w.surfaceView.webContents._url, /^http:\/\/127\.0\.0\.1:\d+\/lab$/,
    'URL = 隧道 origin + 声明里的 path');
  // ★ 分区按**插件**走（它没要布局组）—— 一个网页应用自己的状态该跟它自己走。
  assert.match(w.surfacePartition || '', /^persist:plugin-01M2JKM/,
    `没有布局组的插件要用按插件的分区，实际是 ${w.surfacePartition}`);

  // ★ 而没有客户端代码就**没有登录那一步**。证据看它那个存储分区里的 cookie jar：
  //   登录成功会往里塞一个会话 cookie，没登录就一个都没有。框架**不会去猜**一个
  //   口令该怎么用 —— 它手里根本没有"这个插件要 POST 什么"的知识。
  const jar = partitionJars[w.surfacePartition];
  assert.equal(jar ? jar.size : 0, 0,
    '没有客户端代码的插件不该有任何登录 —— 没人告诉过框架该拿什么去登录');

  await invoke('app:stop');
  await waitUntil(async () => !b._session
    || ['released', 'rejected', 'expired'].includes(b._session.state), '会话释放', 20000);
  fs.rmSync(path.join(pool, 'jupyter'), { recursive: true, force: true });
  idx._test.getRegistry().reload();
});

test('★ 中转站：起 sshd 会话不建视图，而是把本地 ssh 配置好', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const idx = require('../src/main/index.js');
  const sshc = require('../../plugins/sshd/client/sshconfig.js');

  // 等上一个用例的会话真的被释放。演示后端的 goodbye 要 1.6 秒才落地，而配额是 1 ——
  // 不等的话这里会拿到一句「已有 1 个活跃会话」，而那是**上一个用例**的会话，
  // 排查起来会以为是中转站本身的问题。
  const b = idx._test.getBackend();
  await waitUntil(async () => !b._session
    || ['released', 'rejected', 'expired'].includes(b._session.state), '上一个会话释放');

  const conn = await invoke('app:saveConnection', { user: 'demo', host: '127.0.0.1', port: 1 });
  assert.equal((await invoke('app:connect', { connectionId: conn.connection.id })).ok, true);

  const viewsBefore = calls.views.length;
  const started = await invoke('app:start', null, 'sshd');
  assert.equal(started.ok, true, `提交中转站会话失败：${JSON.stringify(started.snapshot)}`);

  // 等它跑到 running（演示后端 200ms 登记）
  let snap = null;
  const deadline = Date.now() + 15000;
  for (;;) {
    snap = await invoke('app:state');
    if (snap && snap.state === 'running') break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(snap && snap.state === 'running', `没跑到 running：${JSON.stringify(snap)}`);
  assert.equal(snap.serviceKind, 'sshd');
  // 客户端发上去的是 OpenSSH 的**一整行**（带注释，那正是用户能分辨「哪把是哪把」
  // 的唯一依据），由服务端规范化掉注释 —— 注释里的逗号会劈开 `--export=ALL,k=v,…`，
  // 而那是服务端那边要挡的事（见 test-sessiond-logic.py 19.9）。
  assert.match(idx._test.getBackend()._relayPubkey, /^ssh-ed25519 [A-Za-z0-9+/]{68}$/,
    '公钥到了服务端要已经规范化：只有类型和 base64，注释被丢掉');
  assert.equal(snap.layoutId, null,
    '中转站不分配布局组：它是给浏览器用的（端口 = origin = 一份编辑器布局），'
    + '而中转站没有浏览器');
  assert.ok(snap.localPort > 0, '隧道必须真的在监听');

  // ★ 这一条是整节的重点：中转站**不该**建 code-server 视图。
  //   建了的话窗口主体会被一块加载不出来的页面盖住，而用户要的东西（ssh 怎么连）
  //   恰好写在被盖住的那块面板上。
  assert.equal(calls.views.length, viewsBefore,
    '中转站不需要 WebContentsView —— 用户要看的东西在他自己的终端里');

  // ★ 先查「有没有碰不该碰的地方」，再查「有没有写出该写的东西」。
  //   顺序有讲究：反过来写的话，一个「把配置写进真家目录」的改动会先被
  //   「演示目录里没有文件」那条拦下，而报出来的原因和真正的问题不是一回事。
  assert.equal(fs.existsSync(path.join(fakeHome, '.slurmate')), false,
    '★ 演示模式绝不能往真正的家目录里写东西');
  assert.equal(fs.existsSync(path.join(fakeHome, '.ssh')), false,
    '★ 尤其不能碰 ~/.ssh/config —— 那是用户**全部** ssh 都要经过的地方，'
    + '比 config.json 严重得多');

  // 演示模式必须落在**它自己的**配置目录里
  const home = path.join(userData, 'demo-config');
  assert.equal(fs.existsSync(sshc.pathsFor(home).config), true,
    '演示模式下 ssh 配置要写在演示配置目录里');

  const cfg = fs.readFileSync(sshc.pathsFor(home).config, 'utf8');
  assert.match(cfg, new RegExp(`^\\s+Port ${snap.localPort}$`, 'm'),
    '端口必须是隧道**实际**在监听的那一个（可能从 18090 顺移过）');
  assert.match(cfg, /^\s+User demo$/m, '用户名取自这条连接');
  assert.match(fs.readFileSync(sshc.pathsFor(home).userConfig, 'utf8'),
    new RegExp(`Include ${sshc.pathsFor(home).config.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    '用户的 ssh 配置里要有一行 Include');
  assert.equal(fs.readFileSync(sshc.pathsFor(home).knownHosts, 'utf8'),
    `[127.0.0.1]:${snap.localPort} ssh-ed25519 ${'A'.repeat(68)}\n`,
    '作业带回来的主机公钥要被钉进 known_hosts');

  // 收尾
  await invoke('app:stop');
});


// ── ★ 未知服务的会话：接上隧道，但只解释、不动作 ──────────────────────────────
//
// 这条是"站点装了本客户端不认识的插件"在**会话层**的表现。它要同时成立两件看起来
// 相反的事：隧道**要**接起来（那是用户唯一的出路 —— 他能直接连上去看看那是什么，
// 也能结束它），而"怎么用它"**一件都不能做**（那个端口上跑的可能是任何东西，
// 拿口令去 POST 或者给它配主机公钥都是在声称一件我们并不知道的事）。

test('配置里认不出的 enabled 值按「跟着站点走」处理，不读成「关掉」', (t) => {
  t.after(() => { Module._load = origLoad; });
  const config = require('../src/main/config.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-cfg-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    schema: config.SCHEMA,
    plugins: { sshd: { enabled: 'no' }, 'code-server': { enabled: true } },
  }));
  const cfg = config.loadConfig(tmp);

  // ★ 认不出的形状（这里是字符串 'no'）**丢掉**，回到"跟着站点走" ——
  //   而"跟着站点走"是 true。读成 false 的话，配置文件里一个笔误就让一个功能
  //   凭空消失，而界面上只会少一个按钮、没有任何地方解释为什么。
  assert.equal(config.pluginEnabledLocally(cfg, 'sshd'), true,
    '认不出的值按「跟着站点走」处理，不读成「关掉」');
  // 认得出的照旧生效
  assert.equal(config.pluginEnabledLocally(cfg, 'code-server'), true);
  assert.equal(config.pluginEnabledLocally(cfg, '从没听过的插件'), true,
    '没表过态 = 跟着站点走');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('★ 未知服务的会话：接上隧道、不建视图，并说清该升级客户端', async (t) => {
  t.after(async () => {
    Module._load = origLoad;
    // ★ 这一条不只是打扫卫生：如果 tryReattach 提前返回（正是 C10 那个变异），
    //   controller 会是 null 而隧道还活着 —— 事件循环被它撑住，
    //   整轮 `node --test` 不会结束。收尾要能覆盖"没有 controller"那种情况。
    const c = idx._test.getController();
    if (c) { try { await c.stop(); } catch (e) { /* 收尾失败不该改变结论 */ } }
    await invoke('app:debug', 'reset');   // 它会把演示站点那两个插件恢复成开着的
  });
  const idx = require('../src/main/index.js');
  const w = idx._test.getWindow();
  const b = idx._test.getBackend();

  // 先把上一个用例可能留下的会话收干净 —— 「单一启动」是服务端强制的，
  // 带着一个在跑的会话去开新的只会拿到「已有 1 个活跃会话」。
  // 演示后端的 _goodbye 只把 state 置成 released、不把对象清掉（真守护进程也是
  // 这样：终态记录会留着），所以判据是**状态**而不是对象在不在。
  const dead = () => !b._session
    || ['released', 'rejected', 'expired'].includes(b._session.state);
  if (!dead()) {
    await invoke('app:stop');
    await waitUntil(dead, '上一个会话释放', 20000);
  }

  // 起一个正常会话 —— 认不出的那种也要接隧道，所以这里必须有一个**真的在监听**
  // 的端口。起完再把这个会话的 service_kind 换成客户端不认识的名字，正是
  // "别人用 CLI 提交了一个本站新插件"在客户端眼里的样子。
  const started = await invoke('app:start', { cpus: 2 });
  assert.equal(started.ok, true,
    `开会话失败：${JSON.stringify(started.snapshot || started)}`);
  // ★ controller 要在 start 之后取：上面那个会话若停在终态，start 会换一个新的。
  const ctl = idx._test.getController();
  await waitUntil(() => ctl.state === 'running' && ctl.snapshot().origin,
    '会话进入 running', 20000);

  await invoke('app:debug', 'extra-plugin');
  await invoke('app:partitions');
  // 演示站点"装了 jupyter，而本客户端没有它" —— 拿它的 id 当作那个会话的解析键。
  const siteJup = idx._test.getBackend()._extraSitePlugins.find((p) => p.name === 'jupyter');
  assert.ok(siteJup, '前置条件：演示站点要有一个客户端不认识的插件');
  const ref = `${siteJup.id}@${siteJup.version}`;

  // ── ★ 不变量一：跑了之后**改站点状态也不影响这个会话** ──
  //
  // 插件对象是在**会话创建时捕获**的，之后所有状态变化都用它、不再查注册表。
  // 所以就算这个会话的 service_kind 凭空变成别的，客户端也照旧按它起时那个插件
  // 渲染 —— 这正是"站点升级插件不该弄坏正在跑的会话"的落点。
  w.hideSurface();
  const viewsBefore = calls.views.length;
  b._session.service_kind = 'jupyter';
  b._session.service_plugin = ref;
  ctl.session.service_kind = 'jupyter';
  ctl.session.service_plugin = ref;
  ctl.emit('change', ctl.snapshot());
  await new Promise((r) => setTimeout(r, 300));
  // ★ 判据必须是**行为**（界面还按不按那个插件渲染），不能只看 `controller.plugin`
  //   那个字段：在"捕获了但不用"的实现里那个字段照样是对的，于是断言会因为错误的
  //   理由变绿。所以强的那一条放在前面。
  assert.equal(calls.views.length, viewsBefore + 1,
    '★ 会话跑起来之后改这些字段不该换掉它的插件 —— 框架用的仍是它起时捕获的那一个'
    + '（那个插件声明了 surface，所以界面会被重新建起来）');
  assert.equal(ctl.plugin && ctl.plugin.name, 'code-server', '而且攥着的确实还是它');
  w.hideSurface();

  // ── ★ 不变量二：走**客户端重启**那条路时，认不出的插件要接隧道、不建视图 ──
  //
  // 这才是"站点装了新插件而客户端没跟上"在现实里的样子：会话是别人提交的，
  // 客户端是刚启动的。上一段用的 controller 隧道是现成的，那条"隧道在"的断言
  // 会因为错误的理由变绿；这一段把 controller 清掉重建，隧道必须**由这条路**
  // 接起来。
  const viewsNow = calls.views.length;
  // 通知走的是 webContents 的 'ui:notice' 通道（外壳把它渲染成提示条），
  // 不是 calls.notices —— 后者是别处用的记录。
  const notices = calls.windows[0].webContents.handlers['send:ui:notice'] || [];
  const before = notices.length;

  await idx._test.reattach();
  const ctl2 = idx._test.getController();
  assert.notEqual(ctl2, null, '接上已有会话这条路不能因为插件认不出就放弃');
  assert.equal(ctl2.plugin, null, '认不出的插件应当**明说**认不出（null），不是硬塞一个');
  await waitUntil(() => ctl2.snapshot().origin, '认不出的会话也把隧道接起来', 20000);
  assert.equal(calls.views.length, viewsNow,
    '认不出的插件绝不能**新建**一个 WebView 去加载它 —— 那个端口上可能是任何东西');
  assert.equal(w.hasSurface(), false, '窗口里不该留下任何视图');

  const said = notices.slice(before).map((n) => `${n.kind}: ${n.text}`).join('\n');
  // ★ 要害二：**点名**是哪个插件、并说清该怎么办。用户该升级客户端，不是找管理员 ——
  //   不说这一句，他只能去猜。
  assert.match(said, /jupyter/i, `提示里要点名是哪个插件：${said}`);
  assert.match(said, /升级客户端/, `而且要说出该怎么办：${said}`);
  // ★ 要害三：隧道**在**（用户有出路）。
  assert.ok(ctl2.snapshot().origin, '隧道要接起来，否则用户连那个端口都够不着');

  await invoke('app:stop');
  await waitUntil(dead, '会话释放', 20000);
});
