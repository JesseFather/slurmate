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
    // code-server 视图必须跑在自己的 partition 里（persist:slot-N）。
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
    getPath: (k) => (k === 'userData' ? userData : os.tmpdir()),
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
                    // 密钥与主机密钥。密钥只有「重新生成」这一个入口 ——
                    // 「保存方式」那个下拉框已经删掉，私钥永远加密保存。
                    'app:publicKey', 'app:copyPublicKey', 'app:regenerateKey',
                    'app:trustHostKey', 'app:forgetHostKey']) {
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
  assert.equal(b.connection, null);
});

test('★ 密钥在首次启动时就生成好了，公钥可查（用户要拿去注册）', async (t) => {
  t.after(() => { Module._load = origLoad; });
  const r = await invoke('app:publicKey');
  assert.equal(r.ok, true);
  assert.match(r.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+=* slurmate-\d{8}$/,
    '公钥必须是 OpenSSH 一行格式，用户要原样粘到 IDM 里');
  assert.match(r.fingerprint, /^SHA256:/);
  // 这台机器没有凭据库 —— 密钥只能留在内存里，绝不该悄悄写明文落盘
  assert.equal(r.persisted, false, '没有安全存储时不得自动落盘');
  assert.equal(fs.existsSync(path.join(userData, 'demo-config', 'secrets.json')), false,
    '一个字节都不该落盘');
});

test('★ 没有安全存储时，重新生成密钥要明确报告「存不下来」，绝不静默写明文', async (t) => {
  t.after(() => { Module._load = origLoad; });

  const before = await invoke('app:publicKey');
  const r = await invoke('app:regenerateKey');
  // 密钥本身生成出来了 —— 用户此刻正需要拿它去 IDM 注册，不能因为存不了就什么都不给
  assert.match(r.publicKey, /^ssh-ed25519 /);
  assert.notEqual(r.publicKey, before.publicKey, '重新生成必须真的换一把');
  // 但「存下来了」这件事必须明确否认，界面据此如实告知用户
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_secure_storage');
  assert.equal(fs.existsSync(path.join(userData, 'demo-config', 'secrets.json')), false,
    '一个字节都不该落盘 —— 私钥没有「明文保存」这条退路了');

  const after = await invoke('app:publicKey');
  assert.equal(after.persisted, false);
  assert.equal(after.publicKey, r.publicKey, '内存里那把必须换成新的，否则界面显示的公钥是旧的');
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
  assert.equal(view._opts.webPreferences.partition, 'persist:slot-1');
  // 演示模式才注入 preload；真实模式注入会污染 IDE
  assert.match(String(view._opts.webPreferences.preload || ''), /demo\.js$/);
  assert.equal(view._opts.webPreferences.backgroundThrottling, false,
    'IDE 不能被 Chromium 节流 —— 那会让终端看起来「卡住」且没有报错');

  // ★ 登录成功的判据是 **cookie jar 里有没有 cookie**，不是 HTTP 状态码。
  //   注意要**等** —— 视图的 loadURL 在自动登录之前就返回了，立刻断言会撞上竞态。
  const jar = partitionJars['persist:slot-1'];
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
