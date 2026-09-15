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

/**
 * 收尾。
 *
 * 必须把演示后端关掉 —— 它有一个**真的在监听的 HTTP 服务**，不关的话
 * `node --test` 会一直等这个子进程退出，整个套件就挂住了
 * （表现为：本文件的 8 个用例全过，然后没有 summary、没有退出）。
 */
after(async () => {
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
  const { performLogin } = require('../src/main/index.js');

  // 造一个「状态码 200 但 jar 里没有 cookie」的 session，模拟真实 code-server
  // 对口令错误的响应。任何靠状态码判断的写法都会在这里报成功。
  const ses = {
    fetch: async () => ({ status: 200 }),
    cookies: { get: async () => [] },
  };
  const res = await performLogin(ses, 'http://127.0.0.1:1', 'wrong-password');
  assert.equal(res.ok, false, '没有 cookie 就是没登录成功，不管状态码是多少');
  assert.equal(res.reason, 'no_cookie');
  assert.equal(res.status, 200);

  // 反过来：有 cookie 就是成功，哪怕状态码不是 302
  const ses2 = {
    fetch: async () => ({ status: 200 }),
    cookies: { get: async () => [{ name: 'code-server-session', value: 'x' }] },
  };
  assert.equal((await performLogin(ses2, 'http://127.0.0.1:1', 'pw')).ok, true);
});

// ── 默认资源：服务端通报，客户端只读地用 ────────────────────────────────────

test('★ 服务端通报的默认资源要真的送到界面上，不能又在客户端硬编码一份', async (t) => {
  t.after(() => { Module._load = origLoad; });

  // op:partitions 的响应里一直带着 defaults（cluster/slurmate-sessiond:2080），
  // 而主进程此前只取 .partitions，把它整个丢掉了 —— 界面于是只能把「2 核 / 8G」
  // 写死在文案里，管理员改了默认值界面照样显示旧数字，且没有任何地方会报错。
  const r = await invoke('app:partitions');
  assert.equal(r.ok, true);
  assert.deepEqual(r.resourceDefaults, { cpus: 2, mem: '8G' },
    '服务端通报的默认资源必须原样带回来');

  const boot = await invoke('app:bootstrap');
  assert.deepEqual(boot.resourceDefaults, { cpus: 2, mem: '8G' },
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
    assert.equal(r.resourceDefaults, null);

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

test('serviceRoute：三种输入各有各的答案，尤其「不知道」不能猜', (t) => {
  t.after(() => { Module._load = origLoad; });
  const { serviceRoute } = require('../src/main/service.js');

  assert.equal(serviceRoute('sshd'), 'sshd');
  assert.equal(serviceRoute('code-server'), 'code-server');
  // ★ 字段**不存在**（部署的守护进程还是旧版本）：那时候集群上只可能有
  //   code-server 的会话，按它走与升级前一致。不这样兜的话，升级客户端会让
  //   所有已有会话都变成「服务类型未知」—— 用户眼前的功能凭空消失。
  assert.equal(serviceRoute(undefined), 'code-server',
    '老守护进程没有这个字段时，不能把它读成「未知」');
  // ★ 字段存在且是 null（守护进程明说不知道：会话是从 nft 规则恢复出来的）。
  //   这时**绝不能猜** —— 猜 code-server 会拿口令去 POST 一个 SSH 端口，
  //   猜 sshd 会拿主机公钥去配一个 HTTP 端口，两种都是系统在声称它并不知道的事。
  assert.equal(serviceRoute(null), 'unknown');
  assert.equal(serviceRoute('ssh'), 'unknown', '认不出的值也不许退回默认');
});

test('sshconfig：Include 幂等，且一个字都不动用户原有的配置', (t) => {
  t.after(() => { Module._load = origLoad; });
  const sshc = require('../src/main/sshconfig.js');

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
  const sshc = require('../src/main/sshconfig.js');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-sshcfg2-'));
  const p = sshc.pathsFor(home);

  // 一次性钥匙：只生成一次，之后必须复用（换了钥匙 = 「刚才还能连，现在认证失败」）
  const k1 = sshc.ensureRelayKey(home);
  assert.equal(k1.ok, true, k1.detail || '');
  assert.equal(k1.created, true);
  assert.match(k1.publicKeyLine, /^ssh-ed25519 [A-Za-z0-9+/]{68} slurmate-\d{8}-\d{4}$/,
    `公钥形状要能被控制节点的规则接受：${k1.publicKeyLine}`);
  const k2 = sshc.ensureRelayKey(home);
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
  const sshc = require('../src/main/sshconfig.js');

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
  const sshc = require('../src/main/sshconfig.js');

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
  await waitUntil(() => (w.codeView && !w.codeView.webContents.isDestroyed()
    && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(w.codeView.webContents._url)
    ? w.codeView : null), 'code-server 视图');

  // 结束会话。★ 用户点下按钮之后，隧道在 stop() 的最开头就停了，页面从那一刻起
  //   就是死的 —— 而状态要等下一次 status 轮询（60 秒）才可能从 releasing 变成
  //   ended。所以收起视图必须发生在 releasing，不能等 ended：否则用户还要盯着
  //   一块打不开的页面最多一分钟，而面板上那几个「重新开始」的按钮全被它盖着。
  await invoke('app:stop');
  assert.equal(w.hasCodeView(), false,
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

test('★ 中转站：起 sshd 会话不建视图，而是把本地 ssh 配置好', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const idx = require('../src/main/index.js');
  const sshc = require('../src/main/sshconfig.js');

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
