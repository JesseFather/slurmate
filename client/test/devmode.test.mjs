/**
 * devmode.test.mjs —— 开发者模式：怎么进、怎么退出、以及**未配置时不会自己进去**。
 *
 * ★ 为什么单开一个文件：这一组要验的是**关着**那一半，而 `boot.test.mjs` 整个文件
 *   都在**开着**那一半里跑（它在 require index.js 之前把开关写上）。同一个进程里
 *   index.js 只会被加载一次，两半不可能共存 —— 所以分成两个文件，各起一个进程。
 *   （`node --test` 默认就是每个文件一个子进程。）
 *
 * ★ 这一条是用户提的要求里最要紧的那句：**未配置时不许自动进开发者模式**。
 *   "没配过任何东西"曾经会落进一个假后端 —— 用户看到一整套界面，以为客户端在
 *   正常工作，其实它在跟一个本地假服务打交道。今天那件事必须做不到。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-devmode-'));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-devmode-home-'));

/**
 * 开发者模式那两个落点。
 *
 * ★ **这里不写 `dev-mode.json`。** 这是这一组的全部前提：一台没配过任何东西的
 *   机器。凡是要进开发者模式的断言，都必须先自己把那个文件写上、或者走界面上
 *   那条路（`app:setDeveloperMode`）—— 后者正是要验的那件事。
 */
const DEV_FILE = path.join(userData, 'dev-mode.json');
const SANDBOX = path.join(userData, 'dev-sandbox');

function readDevFile() {
  try { return JSON.parse(fs.readFileSync(DEV_FILE, 'utf8')); } catch { return null; }
}

// ── Electron 桩 ─────────────────────────────────────────────────────────────
//
// ★ 与 `boot.test.mjs` 那一份是**同一种桩的两个副本**。抽成共享模块更好，但那一份
//   被 50 多条用例踩着，动它的风险与这里的重复不成比例 —— 两处的桩各自只有几十行、
//   改起来一眼看得完。真要抽，等第三个文件需要它的时候。
const calls = { titles: [], notices: [], ipc: new Map(), menus: 0,
                windows: [], views: [], relaunch: 0, exit: false,
                /** 被 `clearStorageData()` 清过的分区，按先后顺序。 */
                cleared: [] };
/** partition → cookie jar。用来验证「登录判定靠 cookie jar 而不是状态码」。 */
const partitionJars = {};
/** 桩里折叠分区名要用它（磁盘上的目录名是折叠过的）。 */
const P = require('../src/main/plugins/index.js');

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
    // code-server 视图必须跑在自己的 partition 里（= 它那份运行时数据的身份，
    // 见 plugin-data.js）。
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
    // ★ `sessionData` 必须**显式**支持：分区目录住在哪儿问的就是它，而它的默认值
    //   就是 `userData`。认不得的键从前**静默**返回 `fakeHome` —— 于是那一块永远
    //   列不出东西，还不报错。
    getPath: (k) => ((k === 'userData' || k === 'sessionData') ? userData : fakeHome),
    getVersion: () => '0.1.0-test',
    on: () => {},
    // 立刻 resolve：index.js 的启动链挂在 whenReady().then(...) 上，
    // 返回一个永不 settle 的 promise 会让整条链悬住、测试进程直接退出。
    whenReady: () => Promise.resolve(),
    quit: () => { calls.quit = true; },
    exit: () => { calls.exit = true; },
    relaunch: () => { calls.relaunch += 1; },
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
        // 与 boot.test.mjs 的桩同一形状（两处各自几十行，见文件头）。
        // ★ 分区在磁盘上的目录名是**折叠过**的；顺手把 jar 也清掉 —— 不清的话
        //   「删掉之后那份数据还在」这个真机症状在桩里根本不存在。
        clearStorageData: async () => { calls.cleared.push(partition); jar.clear(); },
        getStoragePath: () => path.join(userData, 'Partitions',
          P.foldAscii(String(partition).replace(/^persist:/, ''))),
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
  // ★ 目录选择器：默认「用户什么都没选」。要造"选了一个目录"的用例自己
  //   换掉这个方法（见「插件来源」那一条）—— 对话框本身没有可测的东西。
  dialog: {
    showMessageBox: async () => ({ response: 2 }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  clipboard: { writeText: (t) => { calls.clipboard = t; } },
};


const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};

const keeper = setInterval(() => {}, 500);

after(async () => {
  clearInterval(keeper);
  Module._load = origLoad;
  try {
    const idx = require('../src/main/index.js');
    const b = idx._test.getBackend();
    if (b) await b.close();
  } catch { /* 尽力而为 */ }
});

const invoke = (ch, ...args) => {
  const h = calls.ipc.get(ch);
  assert.ok(h, `IPC 通道 ${ch} 未注册`);
  return h(null, ...args);
};

test('★ 一台没配过任何东西的机器**不会**自己进开发者模式', async (t) => {
  t.after(() => { Module._load = origLoad; });
  require('../src/main/index.js');
  await new Promise((r) => setTimeout(r, 400));

  const idx = require('../src/main/index.js');
  assert.equal(idx._test.getBackend().kind, 'ssh',
    '没配过东西 ⇒ 真后端。假后端只由开发者模式开关进来，没有第二条路');

  const b = await invoke('app:bootstrap');
  assert.equal(b.dev, false, '这次进程不在开发者模式');
  assert.equal(b.developerMode.on, false);
  assert.equal(b.developerMode.saved, false);

  // ★ 沙盒目录**一个都不该建**。建了的话，一个有洁癖的用户什么都没干就在自己
  //   的 userData 里多出一个目录，而他永远不知道那是干什么的。
  assert.equal(fs.existsSync(SANDBOX), false, '没开开发者模式就不该建沙盒目录');
  assert.equal(fs.existsSync(DEV_FILE), false, '没动过开关就不该有那个文件');

  // 标题里也不该出现开发者模式的标注（三重互锁的第二重：它只对假后端成立）
  assert.equal(calls.titles.some((x) => /开发者模式/.test(x)), false,
    '真后端上不许标注"开发者模式"');
});

test('★ 开关那条路就是产品那条路：写的是同一个文件', async (t) => {
  t.after(() => { Module._load = origLoad; });

  // 「用户在界面上勾了一下」= 这个 IPC。它必须写 `<userData>/dev-mode.json` ——
  // 而 `boot.test.mjs` 在 require 之前写的正是同一个文件。两处写的是同一个东西，
  // 所以那边不是在给测试开旁门。
  const r = await invoke('app:setDeveloperMode', true);
  assert.equal(r.ok, true);
  assert.deepEqual(readDevFile(), { developerMode: true, pluginDir: null },
    '开关要落在 dev-mode.json 里，而不是任何一份 config.json');

  // ★ **启用要重启**：这次进程仍然跑在真后端上，而接口如实报出"你要的是开、现在
  //   还没开"这一对值。
  const b = await invoke('app:bootstrap');
  assert.equal(b.developerMode.saved, true, '用户要的是"开"');
  assert.equal(b.developerMode.on, false, '这次进程还没开 —— 两个值必须分得开');
  assert.equal(b.dev, false, '重启之前，这次进程仍然是真后端');
  assert.equal(require('../src/main/index.js')._test.getBackend().kind, 'ssh',
    '重启之前不许换后端');

  // 关回去（用例之间不留状态：后一条会假设它关着）
  await invoke('app:setDeveloperMode', false);
  assert.deepEqual(readDevFile(), { developerMode: false, pluginDir: null });
});

test('★ 插件来源：选完当场报"读到几个"，读不出插件就**不保存**', async (t) => {
  t.after(() => { Module._load = origLoad; });

  // 一棵好树：一个子目录，里面有清单。
  const good = path.join(userData, 'my-plugins');
  fs.mkdirSync(path.join(good, 'my-plugin'), { recursive: true });
  fs.writeFileSync(path.join(good, 'my-plugin', 'plugin.json'),
    JSON.stringify({ id: '01M2JKM1M1M1M1M1M1M1M1M1M1', version: '1.0.0', name: 'my-plugin' }));

  // 一棵坏树：有目录，但清单读不动。
  const bad = path.join(userData, 'not-plugins');
  fs.mkdirSync(path.join(bad, 'oops'), { recursive: true });
  fs.writeFileSync(path.join(bad, 'oops', 'plugin.json'), '{ 这不是 JSON');

  const pick = async (dir) => {
    electronStub.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    return invoke('app:pickDevPluginDir');
  };

  // ① 好东西：保存，并且**报出读到几个**
  const ok = await pick(good);
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.plugins, ['my-plugin']);
  assert.equal(readDevFile().pluginDir, good);

  // ② 读不出插件：**不保存**，并说清为什么。存下去的话它会一路生效到界面上那句
  //    "本站不分发插件"，而用户早就忘了自己选过什么。
  const no = await pick(bad);
  assert.equal(no.ok, false, '一个插件都读不出来时不许保存');
  assert.match(no.error, /读不到|读不出|一个插件都没有/);
  assert.equal(readDevFile().pluginDir, good, '失败时不许覆盖掉上一次那个能用的来源');

  // ③ 取消：什么都不发生
  electronStub.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  const cancelled = await invoke('app:pickDevPluginDir');
  assert.equal(cancelled.cancelled, true);
  assert.equal(readDevFile().pluginDir, good);

  // ④ 恢复默认
  const reset = await invoke('app:clearDevPluginDir');
  assert.equal(reset.ok, true);
  assert.equal(readDevFile().pluginDir, null);
});

test('★★ 本机的插件数据：真的去认磁盘，认得出的删得掉，认不出的不给删', async (t) => {
  t.after(() => { Module._load = origLoad; });
  require('../src/main/index.js');
  await new Promise((r) => setTimeout(r, 400));

  // 一台**没配过任何东西**的机器：没有插件、也没有布局组 ⇒ 分区目录里的东西一份都
  // 不该"有主"。这正是"插件卸载之后留下的那堆"的形状。
  const parts = path.join(userData, 'Partitions');
  const orphan = '01m2jkhtzgkjbfqqtwyxmqmf2v@editor@l0123456789ab';
  fs.mkdirSync(path.join(parts, orphan), { recursive: true });
  fs.writeFileSync(path.join(parts, orphan, 'Cookies'), 'x');
  fs.mkdirSync(path.join(parts, 'slot-1'), { recursive: true });
  // 一个**认不出**的目录：要列出来，但**不能**有删除按钮。
  //   （万一分区目录的根取错了，这个列表会把这样的名字摆上删除按钮 —— 那是最坏的一种。）
  fs.mkdirSync(path.join(parts, 'dev-sandbox'), { recursive: true });

  const d = await invoke('app:pluginData');
  assert.equal(d.ok, true);
  assert.equal(d.diskChecked, true, '真实模式要看磁盘');
  assert.deepEqual(d.rows.map((r) => r.partition).sort(),
    ['slot-1', orphan, 'dev-sandbox'].sort(),
    '三份都该列出来（一个都不许瞒着）');
  const by = new Map(d.rows.map((r) => [r.partition, r]));
  assert.equal(by.get(orphan).kind, 'orphan');
  assert.equal(by.get(orphan).deletable, true);
  assert.equal(by.get('slot-1').kind, 'legacy');
  assert.equal(by.get('slot-1').deletable, true, '0.7 之前的残留该能删掉');
  assert.equal(by.get('dev-sandbox').deletable, false, '★ 认不出的不给删除按钮');

  // ★ 界面给的字符串**永远进不了路径**：这个形状就是一次任意目录递归删除。
  const bad = await invoke('app:deletePluginData', { partition: 'persist:../../../tmp' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'stale', '匹配不上任何一行 ⇒ 拒绝，而不是照它去拼路径');
  assert.equal(fs.existsSync(path.join(userData, 'Partitions')), true);

  // 删掉一份：**目录要真的没了**，而且回来的清单里也不该再有它。
  const ok = await invoke('app:deletePluginData', { partition: orphan });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(fs.existsSync(path.join(parts, orphan)), false,
    '★ 只清存储不删目录的话，这一行会永远留在清单里 —— 用户会以为点了没反应');
  assert.equal(ok.rows.some((r) => r.partition === orphan), false);
  assert.equal(calls.cleared.includes(`persist:${orphan}`), true,
    'clearStorageData 也要走到（它是让 Chromium 手里那个 context 松手的那一步）');

  // 删不掉的仍然删不掉：认不出的那一份点了也只会拿到"不在清单里"。
  const no = await invoke('app:deletePluginData', { partition: 'dev-sandbox' });
  assert.equal(no.ok, false);
  assert.equal(no.code, 'stale');
  assert.equal(fs.existsSync(path.join(parts, 'dev-sandbox')), true);
});

test('★ 「立即重启」走的是与关窗口同一套收尾', async (t) => {
  t.after(() => { Module._load = origLoad; });

  // ★ 这一条放在**文件最末**：它会把那个假 app 置成"已经退出"。
  //
  //   钉的是两件事：`relaunch` + `exit` 都要走到（只 relaunch 不 exit 的话，
  //   在真 Electron 里**什么都不会发生** —— 那是这个按钮最难查的一种失败）；
  //   而收尾走的是 `shutdown()`，与关窗口同一个函数（各写一份的话，下一次改了
  //   一处，另一处会静默地少一句 `addPendingGoodbye`）。
  const r = await invoke('app:restart');
  assert.equal(r.ok, true);
  assert.equal(calls.relaunch, 1, '必须真的 relaunch');
  assert.equal(calls.exit, true, 'relaunch 之后必须 exit —— 只 relaunch 等于没反应');
});
