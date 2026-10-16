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
 * check.mjs — 量一遍界面：有没有东西伸出它所在的区域。
 *
 * 为什么要有它：`client/test/renderer.test.mjs` 那一类是拿正则读源码的，它判得了
 *   "这句话写着什么"，判不了"这句话画出来多宽"。排布要一个真的排版引擎，而这个
 *   仓库此前一处都没有，于是"文字和按钮超出范围"这类问题全靠人眼在真机上撞见。
 *
 * 它跑的是真的 `panel.html` + 真的 `app.css` + 真的 `panel.js`，只把
 *   `window.slurmate` 换成一个桩（见 `stub.js`），内容由 `fixture.mjs` 给。
 *   那几个用例的哨兵在 `measure.js` 里：夹具没渲染出来就是失败，不是"没有溢出"。
 *
 * 用法：
 *   node tools/ui-probe/check.mjs              量一遍，有溢出就红
 *   node tools/ui-probe/check.mjs --shot D     顺便把每一格截一张图到 D
 *   SLURMATE_SKIP_UI_PROBE=1 node ...          明确跳过（会在输出里说一声）
 *
 * 退出码：0 = 都量过且没有溢出；1 = 量到了溢出；2 = 检查本身没跑成（没有浏览器、
 *   浏览器起不来、报告读不出来）。与 `tools/check-sanitized.sh` 同一个约定：
 *   不把"没跑成"混进"通过"。
 *
 * 找浏览器按四条路，先找到先算：`$CHROME_BIN`、`tools/ui-probe/get-browser.sh`
 *   取的那一处、PATH 上的几个常见名字。PATH 上那个要过 `--version` 的真跑检查：
 *   工具机上有一个 snap 壳叫 `chromium-browser`，它跑得起来但什么都不做。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { buildPageFixture } from './fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// 页面由本进程自己端出去，所以浏览器那一步必须走异步的那一个：
//   `execFileSync` 会把事件循环堵住，于是那个服务一个请求都答不上来，
//   浏览器等样式与脚本等到超时（实测：每格卡满 120 秒）。
const execFileAsync = promisify(execFile);
const RENDERER = path.join(here, '../../client/src/renderer');

// 每一格量两遍：一窄一宽。窄的那一遍是这条判据真正要的那一遍 —— 窗口越窄，
//   一句长话越容易把旁边的东西顶出去；宽的那一遍用来确认不是"只在窄窗口里才
//   不溢出"这种反过来的毛病（比如某个盒子反过来撑不满）。
const WIDTHS = [[860, 900], [1000, 900]];

// ── 找浏览器 ────────────────────────────────────────────────────────────────

/**
 * 跑这个浏览器要带的额外环境。
 *
 * `get-browser.sh` 在缺 alsa-lib 的机器上会在 `<取的目录>/lib` 里放一个替身库
 *   （它不在任何默认查找路径里），所以要显式指过去。这一格只对"取到我们那个
 *   目录里的浏览器"生效：用户拿 `CHROME_BIN` 指别处时不掺和。
 */
function browserEnv(bin) {
  const env = { ...process.env };
  const libDir = path.join(path.dirname(path.dirname(bin)), 'lib');
  if (fs.existsSync(path.join(libDir, 'libasound.so.2'))) {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
      ? `${libDir}:${env.LD_LIBRARY_PATH}` : libDir;
  }
  return env;
}

function usable(bin) {
  if (!bin || !fs.existsSync(bin)) return null;
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000,
      env: browserEnv(bin), stdio: ['ignore', 'pipe', 'ignore'] });
    // 四段版本号。只判退出码不够：snap 壳退出码是 0，而它一个版本号都不印。
    return /\d+\.\d+\.\d+\.\d+/.test(out) ? out.trim() : null;
  } catch { return null; }
}

function findBrowser() {
  const dir = process.env.SLURMATE_UI_BROWSER_DIR
    || path.join(os.homedir(), '.cache', 'slurmate-ui');
  const tries = [
    process.env.CHROME_BIN,
    path.join(dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
    'chrome-headless-shell', 'google-chrome', 'google-chrome-stable',
    'chromium', 'chromium-browser', 'chrome',
  ];
  for (const t of tries) {
    if (!t) continue;
    const bin = t.includes(path.sep) ? t : which(t);
    const v = usable(bin);
    if (v) return { bin, version: v };
  }
  return null;
}

function which(name) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* 下一个 */ }
  }
  return null;
}

// ── 搭那一份夹具页面 ────────────────────────────────────────────────────────

/** 从 HTML 里抠出本地资源的引用（`src=` / `href=`，不带协议的那种）。 */
function localRefs(html) {
  const out = new Set();
  const re = /(?:src|href)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const v = m[1];
    if (/^[a-z]+:/i.test(v) || v.startsWith('//') || v.startsWith('#')) continue;
    out.add(v);
  }
  return [...out];
}

function buildDir(tmp, fixture) {
  const html = fs.readFileSync(path.join(RENDERER, 'panel.html'), 'utf8');

  // 页面引用到的每一个本地文件都照搬过去。逐个写名字的话，界面哪天多引一个
  //   文件，探针会以"脚本没加载"的样子红，而那个症状指不回这里。
  for (const ref of localRefs(html)) {
    const src = path.join(RENDERER, ref);
    if (!fs.existsSync(src)) throw new Error(`panel.html 引用了 ${ref}，而它不在 ${RENDERER}`);
    fs.copyFileSync(src, path.join(tmp, path.basename(ref)));
  }

  // CSP 那条 meta 原样留着，一个字都不改。
  //
  //   夹具曾经是从 `file://` 打开的，那条路走不通：这个无头壳不加载 file:// 文档的
  //   外部脚本（内联的会跑，`<script src>` 一个都不跑，加
  //   `--allow-file-access-from-files` 与 `--disable-web-security` 都不行）。
  //   于是现在用一个只在本机回环上开的服务（见 `serve()`），页面因此跑在真的源上，
  //   而真的源意味着页面那条 CSP 照旧生效。它管着"脚本只能来自本站"，而我们的
  //   三段注入脚本就在同一个目录下，所以这一条不碍事。反过来，谁把那条 CSP 删了，
  //   这里会当场说一声（下面这一句）。
  if (!/<meta http-equiv="Content-Security-Policy"/.test(html)) {
    throw new Error('panel.html 里那条 CSP 的写法变了，夹具没有同步');
  }
  const stripped = html;

  const inject = '<script src="probe-fixture.js"></script>\n'
    + '<script src="probe-stub.js"></script>\n';
  if (!stripped.includes('<script src="dom.js"></script>')) {
    throw new Error('panel.html 里脚本的加载顺序变了，夹具没有同步');
  }
  const withStub = stripped.replace('<script src="dom.js"></script>',
    inject + '<script src="dom.js"></script>');

  const out = withStub.replace('</body>', '<script src="probe-measure.js"></script>\n</body>');
  if (out === withStub) throw new Error('panel.html 里没有 </body>，夹具没有同步');

  fs.writeFileSync(path.join(tmp, 'probe.html'), out);
  fs.writeFileSync(path.join(tmp, 'probe-fixture.js'),
    'window.__PROBE_FIXTURE = ' + JSON.stringify(fixture) + ';\n');
  fs.copyFileSync(path.join(here, 'stub.js'), path.join(tmp, 'probe-stub.js'));
  fs.copyFileSync(path.join(here, 'measure.js'), path.join(tmp, 'probe-measure.js'));
}

/**
 * 只在本机回环上开的静态服务，把那一个临时目录端出去。
 *
 * 为什么不用 `file://`：这个无头壳不加载 file:// 文档里的外部脚本，而面板的
 *   脚本全是外部脚本（`dom.js` / `panel.js`）。内联的写法能跑，但那样夹具就不是
 *   "真的 panel.html" 了。端口用 0 让内核挑，只听 127.0.0.1，跑完就关。
 */
function serve(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const file = path.join(dir, rel);
    // 只端这一个目录里的东西。少了这一句，`/../../etc/passwd` 这类路径会走出去 ——
    //   端口只在本机开着，但仍然不该给。
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('没有这个文件');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/probe.html`,
        close: () => server.close(),
      });
    });
  });
}

// ── 跑一格 ──────────────────────────────────────────────────────────────────

const MARK_A = 'PROBE-REPORT-BEGIN';
const MARK_B = 'PROBE-REPORT-END';

function unescapeHtml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

async function runCase(browser, base, name, w, h) {
  const args = ['--headless', '--disable-gpu', '--force-device-scale-factor=1',
    '--virtual-time-budget=8000', `--window-size=${w},${h}`, '--dump-dom',
    `${base}?case=${name}`];
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');
  const { stdout: dom } = await execFileAsync(browser, args, { encoding: 'utf8',
    timeout: 120000, env: browserEnv(browser), maxBuffer: 64 * 1024 * 1024 });
  const a = dom.indexOf(MARK_A);
  const b = dom.indexOf(MARK_B);
  if (a < 0 || b < 0) throw new Error('页面没有交出报告');
  const json = unescapeHtml(dom.slice(a + MARK_A.length, b)).trim();
  return JSON.parse(json);
}

async function shot(browser, base, name, w, h, out) {
  fs.mkdirSync(out, { recursive: true });
  const args = ['--headless', '--disable-gpu', '--force-device-scale-factor=1',
    '--virtual-time-budget=8000', `--window-size=${w},${h}`,
    `--screenshot=${path.join(out, `${name}-${w}.png`)}`,
    `${base}?case=${name}`];
  await execFileAsync(browser, args, { encoding: 'utf8', timeout: 120000,
    env: browserEnv(browser), maxBuffer: 8 * 1024 * 1024 });
}

// ── 判 ──────────────────────────────────────────────────────────────────────

function judge(r) {
  const bad = [];
  if (r.fatal) bad.push(`这一格本身未通过：${r.fatal}`);
  if (r.scanned === 0) bad.push('一个元素都没有扫到（夹具是空的）');
  for (const s of r.scroll || []) {
    bad.push(`${s.sel} 横向滚出来了：内容 ${s.scrollWidth} > 可见 ${s.clientWidth}`);
  }
  for (const o of (r.offenders || []).slice(0, 6)) {
    bad.push(`${o.sel} 越过右边界 ${o.over}px：${o.text}`);
  }
  if ((r.offenders || []).length > 6) bad.push(`另外还有 ${r.offenders.length - 6} 处越界`);
  // 滑块旁边不该再留一个输入框，而它停在哪儿要看得见（用户 2026-10-16 点名）。
  //   只在真的画了滑块的格子上判：没装滑块的格子本来就该留着那个框
  //   （站点没给默认、默认不在档位上时，它是唯一能填的地方）。
  const cnt = r.counts || {};
  if (cnt.advRanges) {
    if (cnt.advBoxes) bad.push(`有 ${cnt.advBoxes} 条滑块旁边还留着输入框`);
    if (cnt.advNoval) bad.push(`有 ${cnt.advNoval} 条滑块没有读数`);
  }
  return bad;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const CASES = ['conns', 'conns-armed', 'plugins', 'plugins-adv', 'jobs', 'statusbar-port'];

async function main() {
  const argv = process.argv.slice(2);
  const shotDir = argv.includes('--shot') ? argv[argv.indexOf('--shot') + 1] : null;

  if (process.env.SLURMATE_SKIP_UI_PROBE === '1') {
    console.log('界面排布检查：按 SLURMATE_SKIP_UI_PROBE 跳过了，这一遍没有量。');
    return 0;
  }

  const found = findBrowser();
  if (!found) {
    console.error('界面排布检查没有跑成：本机未找到可用的无头浏览器。');
    console.error('它试过：$CHROME_BIN、~/.cache/slurmate-ui、PATH 上的 chrome/chromium。');
    console.error('取一个：bash tools/ui-probe/get-browser.sh');
    console.error('明确跳过：SLURMATE_SKIP_UI_PROBE=1');
    return 2;
  }
  console.log(`浏览器：${found.bin}（${found.version}）`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-ui-probe-'));
  buildDir(tmp, buildPageFixture());
  const srv = await serve(tmp);
  console.log(`夹具：${tmp}（经 ${srv.base} 端出来，页面那条 CSP 原样生效）`);

  let failed = 0;
  for (const name of CASES) {
    for (const [w, h] of WIDTHS) {
      let r;
      try {
        r = await runCase(found.bin, srv.base, name, w, h);
      } catch (e) {
        console.log(`✗ ${w}×${h} ${name}：这一格无法运行：${(e && e.message) || e}`);
        failed++;
        continue;
      }
      const bad = judge(r);
      const tag = `${w}×${h} ${(r.what || name)}`;
      if (bad.length) {
        failed++;
        console.log(`✗ ${tag}`);
        for (const line of bad) console.log(`    ${line}`);
      } else {
        const c = r.counts || {};
        const seen = Object.keys(c).map((k) => `${k} ${c[k]}`).join('，');
        console.log(`✓ ${tag}（扫了 ${r.scanned} 个元素；${seen}）`);
      }
      if (shotDir) {
        try { await shot(found.bin, srv.base, name, w, h, shotDir); } catch { /* 截图是顺手的事 */ }
      }
    }
  }

  srv.close();
  if (failed) {
    console.log(`\n${failed} 格量到了溢出。`);
    return 1;
  }
  console.log('\n每一格都没有内容伸出容器。');
  return 0;
}

main().then((code) => { process.exitCode = code; },
  (e) => { console.error('检查自己没有跑成：' + ((e && e.message) || e)); process.exitCode = 2; });
