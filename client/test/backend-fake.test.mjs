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

/**
 * backend-fake.test.mjs —— 假后端不许比真守护进程多知道任何东西。
 *
 * 假后端（`client/src/main/backend-fake.js`）的存在理由是：开发模式要在没有集群的
 * 机器上跑出真的状态机。它的会话视图一直声称"逐字段对齐守护进程的 `session_view`"
 * —— 而那句声称在此之前没有任何东西守着。
 *
 * 这个方向才是危险的那一个：假后端凭空多出一个字段，客户端读了它，
 *    真集群上那个字段不存在，只在开发模式里跑得通。而"开发模式能跑、真集群跑不了"
 *    是最难查的一类，因为它看起来完全正常。
 *    （反过来，真守护进程多一个字段是无害的：客户端对它一无所知。）
 *
 * 这条不是假想的：就在写下这个文件的前一刻，给假后端手抄四个新字段时抄错了一个
 *   —— 作业跑起来之后 `job_reason` 没清掉，于是开发模式里会显示
 *   「运行中 · 在等空闲资源」，一句自相矛盾的话，而真集群上它不出现。
 *
 * 这里只做文本比对（本机起不了 Electron）。它验不了字段的值对不对，
 *   只验"这个名字守护进程是不是真的会说"。够用 —— 名字错了才是上面那条路。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
// 这个文件一直是纯文本比对（本机起不了 Electron）。推送那一组要真的造一个
//   假后端来验它的行为，所以这里要 require。
const require = createRequire(import.meta.url);
const ROOT = path.join(here, '..', '..');
const FAKE = fs.readFileSync(
  path.join(ROOT, 'client', 'src', 'main', 'backend-fake.js'), 'utf8');
const DAEMON = fs.readFileSync(
  path.join(ROOT, 'cluster', 'slurmate-sessiond'), 'utf8');

/** 守护进程 `session_view()` 的函数体。判据只在那个函数里，别处不算。 */
function daemonViewBody() {
  // 锚点是完整签名，这是有意的：签名变了就说明"这一份视图由谁渲染、
  //   渲染时要不要现查 Slurm"变了，而假后端演的是同一件事 —— 那正是这一条要
  //   盯住的东西。`job_live` 那一格是这么来的（推送那条路只读本 tick 已经取过的
  //   作业信息，绝不在这里 fork），锚点跟着改；默认值不变，所以假后端
  //   （它演的是 `list` / `status` 那一侧）一个字都不用动。
  const at = DAEMON.indexOf(
    '    def session_view(self, s, with_secret=True, job_live=True):');
  assert.notEqual(at, -1, '守护进程里找不到 session_view() —— 改名了就更新这条检查');
  const end = DAEMON.indexOf('\n    def op_status', at);
  assert.notEqual(end, -1, '找不到 session_view() 的结尾');
  return DAEMON.slice(at, end);
}

/** 假后端 `_view()` 会写进响应里的全部字段名。 */
function fakeViewKeys() {
  const at = FAKE.indexOf('  _view(s) {');
  assert.notEqual(at, -1, '假后端里找不到 _view() —— 改名了就更新这条检查');
  const end = FAKE.indexOf('\n  _clearTimers', at);
  assert.notEqual(end, -1, '找不到 _view() 的结尾');
  const body = FAKE.slice(at, end);

  const keys = new Set();
  // 1. `const d = { … }` 那一段里的键。
  //    不能按行首缩进匹配：那里一行上有两个键
  //      （`session_id: …, job_id: …, state: …`），按行首匹配会漏掉第二个。
  //    前缀要求 `{` 或 `,`（而不是裸的 `\w+:`）—— 不然三元表达式里的
  //      `? null : s.service_kind` 会把 `null` 当成一个字段名。
  const litAt = body.indexOf('const d = {');
  assert.notEqual(litAt, -1, '_view() 里找不到 `const d = {`');
  const litEnd = body.indexOf('\n    };', litAt);
  assert.notEqual(litEnd, -1, '找不到那个对象字面量的结尾');
  for (const m of body.slice(litAt, litEnd).matchAll(/(?:[{,]|^)\s*([a-z_][a-z0-9_]*)\s*:/gm)) {
    keys.add(m[1]);
  }
  // 2. 后面那几处 `d.xxx = …`（含单行 if 后面的那种）。
  for (const m of body.matchAll(/\bd\.([a-z_][a-z0-9_]*)\s*=/g)) keys.add(m[1]);
  return keys;
}

test('假后端 _view() 抽得出的字段足够多（正则没匹配上就等于什么都没验）', () => {
  const keys = fakeViewKeys();
  assert.ok(keys.size >= 18, `只抽到 ${keys.size} 个字段：${[...keys].join('、')}`);
  // 抽几个一定有的当锚点 —— 名字被改掉时这条会红，而不是让下面那条静默变绿。
  for (const k of ['session_id', 'job_id', 'state', 'tunnel_target',
                   'auth_password', 'service_kind']) {
    assert.ok(keys.has(k), `抽不到 ${k} —— 抽取规则失效了`);
  }
});

test('★★ 假后端会发出去的每一个字段，守护进程的 session_view 都说得出', () => {
  const body = daemonViewBody();
  const missing = [...fakeViewKeys()]
    .filter((k) => !new RegExp(`\\b${k}\\b`).test(body))
    .sort();
  assert.deepEqual(missing, [],
    `假后端会发这些字段，而守护进程的 session_view() 里根本没有它们：`
    + `${missing.join('、')} —— 客户端读了它们就只在开发模式里跑得通`);
});

test('★ 作业状态那四个新字段，假后端一个都不许少', () => {
  // 少一个的后果不是报错，是开发模式里看不到那条路：客户端会走
  //   「老守护进程」的退路（印状态原文），而真集群上看到的是译文。
  //   "开发模式验不了的那条路"正是这一版反复在清的东西。
  const keys = fakeViewKeys();
  for (const k of ['job_terminal', 'job_reason', 'job_exit_code', 'job_restarts']) {
    assert.ok(keys.has(k), `假后端的 _view() 没有给出 ${k}`);
  }
});

test('★ 假站点里的作业也带判定与原因（不然那条路一次都走不到）', () => {
  // `_view()` 会给出来不够 —— 会话对象上得有值，否则 `if (s.job_xxx)` 全不成立，
  // 开发模式里那一格永远是空的。
  assert.match(FAKE, /job_terminal:\s*false/, '假会话上要有 job_terminal');
  assert.match(FAKE, /job_reason:\s*'Resources'/, '假会话上要有一个排队原因');
  // 而它必须在作业跑起来的时候被清掉：真集群上跑起来的作业报
  //   `Reason=None`（守护进程把它滤掉），不清的话界面会显示
  //   「运行中 · 在等空闲资源」—— 一句自相矛盾、且在真集群上不出现的话。
  assert.match(FAKE, /sess\.job_state = 'RUNNING';[\s\S]{0,400}?sess\.job_reason = null;/,
    '作业转成 RUNNING 时要把排队原因一起清掉');
});

// ── 推送：假站点必须照守护进程的规则推，不然那条路在开发者模式里走不到 ──
//
// 这一组的理由不是"多测几个函数"：常驻通道在真集群上可能起不来
//    （旧 CLI / 老守护进程），那时客户端整条推送路径都不执行。开发者模式是
//    唯一能反复走那条路的地方 —— 假站点不推的话，"推送那条路"就只有在真集群上
//    才跑过，而那正是这个接缝最怕的一类（开发模式能跑、真集群跑不了，反过来也一样）。

const { FakeBackend, PUSH_INTERVAL_MS, PUSH_SWEEP_MS } =
  require('../src/main/backend-fake.js');

/** 一条会话，字段取到 `_view()` 会用到的全部。 */
function aSession(extra = {}) {
  return {
    session_id: 's-demo', job_id: '7', state: 'enrolled',
    partition: 'A6000', resources: { cpus: 2, mem: '8G', gres: null },
    node: 'node01', node_ip: '192.0.2.11', service_port: 55001,
    created_at: 1, enrolled_at: 2, last_hb_at: 3, renew_count: 0,
    requested_time: 3600, note: null, auth_mode: 'password', account: 'acct',
    tunnel_target: '192.0.2.11:55001', service_kind: null, service_plugin: null,
    ssh_host_key: 'ssh-ed25519 AAAA', auth_password: 'pw',
    job_state: 'RUNNING', job_terminal: false,
    ...extra,
  };
}

function fakeWith(sessions) {
  const b = new FakeBackend({ rpcLatencyMs: 0 });
  b._connected = true;
  b._sessions = sessions;
  return b;
}

test('★★ 推送那份视图 = list 那份**摘掉秘密**（不是另写一份）', () => {
  // 另写一份的那天，推送的字段集与 list 的字段集就会分家，而症状是
  // 界面上某一格在有推送时是空的、没有推送时是满的。
  const b = fakeWith([aSession()]);
  const listView = b._view(b._sessions[0]);
  const pushView = b._viewNoSecret(b._sessions[0]);

  assert.equal(listView.auth_password, 'pw', '前提：list 那份是带口令的');
  assert.equal(listView.ssh_host_key, 'ssh-ed25519 AAAA');
  assert.equal('auth_password' in pushView, false, '推送**结构上**不带口令');
  assert.equal('ssh_host_key' in pushView, false, '作业内主机公钥同理');

  // 除了那两个键，逐字相同 —— 多一个少一个都要红。
  assert.deepEqual(Object.keys(pushView).sort(),
    Object.keys(listView).filter((k) => k !== 'auth_password' && k !== 'ssh_host_key').sort());

  // 而两条路今天走的是同一份：`op_list` 也渲染成这一种（与守护进程两边都用
  //   `with_secret=False` 同形）。从前只有推送走它，`op_list` 是另一种带秘密的
  //   形状 —— 同一个 op 在两条路上字段集不同，而这个假站点自己是不该有"多知道"
  //   的那一份的。
  assert.deepEqual(b._list().data.sessions[0], pushView,
    '`op_list` 与推送渲染出来的必须是同一份东西');
});

test('★ 推送的形状逐字照守护进程的 enqueue_push', () => {
  const b = fakeWith([aSession()]);
  const got = [];
  b.on('notify', (m) => got.push(m));
  b._sweepPush();
  assert.equal(got.length, 1);
  assert.equal(got[0].push, 'sessions');
  assert.equal(got[0].seq, 1);
  assert.equal(typeof got[0].at, 'number');
  assert.equal(Array.isArray(got[0].sessions), true);
  assert.equal('stale' in got[0], false, '假站点没有出站队列，也就不会有缺口');
});

test('★ 没有变化就不推；但过了快照周期**必须**推一条', () => {
  // 那一条"没变也推"是承重的：客户端那条看门狗（session.js 的
  //   PUSH_STALE_MS）靠它把"安静"与"通道坏了"分开。少了它，一个空闲的会话会被
  //   判成通道不通而退回轮询 —— 功能不受影响，但开发者模式里那条路就演不出来了。
  const b = fakeWith([aSession()]);
  const got = [];
  b.on('notify', (m) => got.push(m));
  b._sweepPush();
  b._sweepPush();
  assert.equal(got.length, 1, '没变化、也没到点，就不该再推');

  b._pushAt = Date.now() - PUSH_INTERVAL_MS;      // 假装一个周期过去了
  b._sweepPush();
  assert.equal(got.length, 2, '到点了就算没变化也要推');
  assert.equal(got[1].seq, 2, 'seq 单调递增');
});

test('★ 会话变了就推（判据是渲染结果本身，不是谁记得标脏）', () => {
  const b = fakeWith([aSession()]);
  const got = [];
  b.on('notify', (m) => got.push(m));
  b._sweepPush();
  b._sessions[0].job_state = 'COMPLETED';
  b._sessions[0].job_terminal = true;
  b._sweepPush();
  assert.equal(got.length, 2);
  assert.equal(got[1].sessions[0].job_state, 'COMPLETED');
});

test('★★ 调试开关"守护进程不可达"期间**一条都不推**', () => {
  // 不挡的话，开发者模式里会出现"守护进程挂了、界面却还在自己更新"这种
  // 真集群上不存在的景象 —— 而那正是模拟"通道断了，退回轮询"要造的状态。
  const b = fakeWith([aSession()]);
  const got = [];
  b.on('notify', (m) => got.push(m));
  b.debugDaemonDown(5000);
  b._pushAt = Date.now() - PUSH_INTERVAL_MS;
  b._sweepPush();
  assert.equal(got.length, 0);
});

test('★ 关掉之后不再推（定时器要收干净）', async () => {
  const b = fakeWith([aSession()]);
  const got = [];
  b.on('notify', (m) => got.push(m));
  b._startPushSweep();
  await b.close();
  assert.equal(b._pushTimer, null, '关后端必须把扫描停掉');
  b._pushAt = Date.now() - PUSH_INTERVAL_MS;
  b._sweepPush();
  assert.equal(got.length, 0, '已经关了就不该再推');
});

test('★★ 扫描**真的**在跑（不是"实现了一个只有手动调才走的方法"）', async () => {
  // 这一条挡的是最容易骗过自己的那种：`_sweepPush()` 每条用例都手调，
  //   全绿 —— 而 `connect()` 里那一行忘了挂定时器的话，开发者模式里
  //   一条推送都不会来，客户端永远退回轮询，界面上看不出来。
  const b = new FakeBackend({ rpcLatencyMs: 0 });
  const got = [];
  b.on('notify', (m) => got.push(m));
  await b.connect({ user: 'demo', host: '127.0.0.1', port: 1 });
  try {
    b._sessions.push(aSession());
    await new Promise((r) => setTimeout(r, PUSH_SWEEP_MS + 400));
    assert.ok(got.length >= 1, `扫描没跑起来（等了 ${PUSH_SWEEP_MS + 400}ms 一条都没有）`);
  } finally {
    await b.close();
  }
});

test('★ 假后端收下了身份 —— 不收的话「身份根本没送到后端」在开发者模式里看不出来', () => {
  // 假站点上没有第二个客户端，所以它永远用不到这个字段；但它必须收下。
  //   一个不看这个字段的假后端，会让"客户端身份根本没送到后端"这件事在开发者
  //   模式里完全看不出来 —— 而那条路的真机症状是看护者认不出来是谁。
  const CLIENT = { id: 'm-aaaa', name: '甲机' };
  assert.deepEqual(new FakeBackend({ client: CLIENT })._client, CLIENT);
});

test('★★ 假后端的 `ping` 真的答得出来（那一行曾经是睡着的笔误）', async () => {
  // 这一条守的是一个最坏形状：`case 'ping'` 里若写的是裸的
  //    `hostVersion()`，而本文件里根本没有这个名字 —— 那一支一被调用就抛
  //    `ReferenceError`。它很容易睡着：生产代码里唯一发 `ping` 的是 SSH 后端，
  //    而假后端没有常驻通道，所以谁都不会走到那一行。
  //
  //    所以它值得有一条自己的用例：一个缺陷修好了、而守它的用例随别的功能
  //      一起消失，正是它会第二次睡着的方式。
  const b = new FakeBackend({ rpcLatencyMs: 0 });
  await b.connect({ user: 'demo', host: '127.0.0.1', port: 1 });
  try {
    const r = await b.rpc({ op: 'ping' });
    assert.equal(r.ok, true);
    assert.equal(r.data.pong, true);
    assert.equal(typeof r.data.version, 'string', '版本号要给得出来（版本闸看的就是它）');
    assert.ok(r.data.version.length > 0);
  } finally {
    await b.close();
  }
});

test('★ `whoami` 的字段与守护进程逐字同形（少一格就是客户端少一格依据）', () => {
  // 界面用 `can_submit` 判"这个账号能不能提交"，用 `allowed_partitions` 判分区
  //   权限。少报一格不会报错 —— 客户端只是少知道一件事，而症状是某个按钮
  //   该灰的时候是亮的。
  const b = new FakeBackend({ rpcLatencyMs: 0 });
  const r = b._whoami();
  assert.deepEqual(Object.keys(r.data).sort(),
    ['account', 'account_error', 'allowed_partitions', 'can_submit',
      'gid', 'home', 'uid', 'user']);
  assert.equal(r.data.can_submit, true, '假站点这个账户是写死的常量，查得到');
});

test('★★ 作业日志：「文件不在」是"没有"，"读不出来"是"取不到"（两句不同的话）', () => {
  // 合成一态的后果与这一版一路在清的那类一模一样：右栏对着一份读不出来的
  //   日志说"还没有输出"，而用户会去查一个不存在的输出。真守护进程那边这两种
  //   只差一个 `why`（`None` = 没有；带 `why` 的格子 = 取不到），这里照它。
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'slurmate-log-'));
  const b = new FakeBackend({ rpcLatencyMs: 0, jobsDir: () => root });
  b._connected = true;
  const s = aSession({ job_id: '7' });
  b._sessions = [s];
  const logs = path.join(root, 'home', '.slurmate', 'logs');
  fs.mkdirSync(logs, { recursive: true });

  // ① 两份都不在就是 `null`：那是"它一个字都还没说"。
  let r = b._jobLog({ session_id: s.session_id });
  assert.equal(r.data.out, null, '不在就是 null，不是一句"取不到"');
  assert.equal(r.data.err, null);

  // ② 同名位置放一个目录：文件在、而读不出来就是一个带 `why` 的格子。
  //    用目录而不是 chmod：chmod 挡不住 root，而 CI 上常常就是 root。
  fs.mkdirSync(path.join(logs, 'slurm-7.out'));
  r = b._jobLog({ session_id: s.session_id });
  assert.equal(r.data.out.text, null, '取不到时没有正文');
  assert.match(r.data.out.why || '', /读取 .+ 失败/, '取不到要把原因说出来');
  assert.equal(r.data.err, null, '另一份仍然不在 —— 两句话必须各说各的');
});

test('★★ 内存那一格填了 0 ⇒ 回退到默认值，而且这件事必须说出来', async () => {
  // `--mem=0` 在 Slurm 里是「该节点的全部内存」，不是零：一个笔误能让一个开发
  //   会话吃掉整台机器。所以拒绝并回退 —— 而回退必须报给用户（协议里那个
  //   `warning`）：他填了 0，以为生效了，实际拿到的是默认值。静默地替他决定
  //   正是这个项目一路在清的那类问题。
  //
  //   这一条不起真作业（`_startJob` 换成空的）：它验的是 `submit` 那一侧的决定，
  //   与作业起没起来无关。放在 integration 里会起两条真作业，而断言失败时
  //   那两条还活着，runner 于是挂住不返回 —— 探方向时踩过一次。
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'slurmate-mem-'));
  // 上限放宽到 2：这一条要连着提交两次（一次合法、一次 `0`），而缺省上限是 1，
  //   第二次会撞上 `quota_active` —— 那与这一条要验的事毫无关系。
  const b = new FakeBackend({ rpcLatencyMs: 0, jobsDir: () => root });
  b.maxActive = 2;                      // 见下：这一条要连着提交两次
  b._connected = true;
  b._startJob = async () => {};
  b.debugAddSitePlugin();               // 站点上得先有这么个插件（短名见 DEMO_EXTRA_NAME）

  const plain = await b.rpc({ op: 'submit', service_kind: 'demo-service', mem: '16G' });
  assert.equal(plain.ok, true, JSON.stringify(plain));
  assert.equal(plain.data.resources.mem, '16G', '合法的值原样生效');
  assert.equal(plain.data.warning, undefined, '没替他做决定就不说话');

  const r = await b.rpc({ op: 'submit', service_kind: 'demo-service', mem: '0' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.resources.mem, '8G', '回退到默认值');
  assert.match(r.data.warning || '', /内存/, `替用户做的决定要说出来：${JSON.stringify(r.data)}`);
});
