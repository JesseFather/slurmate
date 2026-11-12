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
 * updates.js —— 「有新版本」这一件事的全部逻辑。
 *
 * 只提醒，不下载、不安装。理由见 docs/RELEASING.md：安装包未签名，而自动
 *   更新是一条把代码送进所有用户机器的通道；在没有签名之前不开它。
 *
 * ── 为什么读重定向而不是 GitHub API ─────────────────────────────────────────
 * `https://github.com/<owner>/<repo>/releases/latest` 是 GitHub 自己维护的固定
 *   入口，回 302，`Location` 就是最新那个正式版的 tag 页。它排除 draft 与
 *   prerelease，所以预览版天然不会被推给正式版用户。
 *
 * 它是一次普通的网页请求，不走 api.github.com。API 对匿名请求是每小时每 IP
 *   60 次，校园网那种一堆人共用一个出口的地方很容易打满；而这个 302 没有那个
 *   量级的限制。
 *
 * ── 失败一律静默 ───────────────────────────────────────────────────────────
 * 断网、公司代理、GitHub 挂了，都只回 `unknown`。检查更新失败不是用户要处理的
 *   事，界面上不出现任何一句话。
 */

const https = require('https');

/** 最新正式版的固定入口。GitHub 对它的应答是一个 302。 */
const LATEST_URL = 'https://github.com/JesseFather/slurmate/releases/latest';

/** 超时。检查更新是后台动作，不该拖住任何东西。 */
const TIMEOUT_MS = 10000;

/** 一次检查的三态。`unknown` 表示没问到，不是「没有更新」。 */
const STATUS_UPDATE = 'update';
const STATUS_CURRENT = 'current';
const STATUS_UNKNOWN = 'unknown';

/**
 * npm 那个三段版本 → 发布标识（两段 + 可选后缀）。
 *
 * `client/package.json` 的 `version` 必须是三段（electron-builder 的
 *   `fixVersionField` 拒两段），而界面、诊断与 tag 用的都是两段。这段转换
 *   只此一份：`index.js` 也从这里取。
 *
 * 认不出来就原样返回。宁可显示一个奇怪的字符串，也不要把版本号吞掉。
 */
function wireVersion(v) {
  const s = typeof v === 'string' ? v : '';
  const m = /^(\d+)\.(\d+)\.\d+(-.*)?$/.exec(s);
  return m ? `${m[1]}.${m[2]}${m[3] || ''}` : s;
}

/**
 * 从重定向地址里取出版本号。
 *
 * 只认 `/releases/tag/` 这一段之后的整段（去掉开头的 `v`），并且要求它长得
 *   像一个版本号。GitHub 若改了跳转形状，这里回 `null`，上层按「没问到」处理，
 *   不会把一段乱七八糟的路径当成版本号比大小。
 */
function parseLatestTag(location) {
  if (typeof location !== 'string' || !location) return null;
  let path;
  try {
    path = new URL(location, LATEST_URL).pathname;
  } catch {
    return null;
  }
  const m = /\/releases\/tag\/v?(\d+\.\d+(?:-[0-9A-Za-z.]+)?)\/?$/.exec(path);
  return m ? m[1] : null;
}

/** 把发布标识拆成可比的两段与后缀。认不出来回 `null`。 */
function splitVersion(v) {
  const m = /^(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), pre: m[3] || '' };
}

/**
 * 远端版本比本机新吗。
 *
 * 远端永远是正式版（`releases/latest` 不含 prerelease），所以数字部分相等时
 *   只有一个方向算新：本机带后缀，远端不带。`0.39-rc1` 于是能升到 `0.39`，
 *   而 `0.39` 不会「升」到 `0.39-rc1`。
 */
function isNewer(current, remote) {
  const a = splitVersion(current);
  const b = splitVersion(remote);
  if (!a || !b) return false;
  if (b.major !== a.major) return b.major > a.major;
  if (b.minor !== a.minor) return b.minor > a.minor;
  return Boolean(a.pre) && !b.pre;
}

/**
 * 请求一次 `LATEST_URL`，只要状态码与 `Location`，不读正文。
 *
 * 回调形状是 `(err, { code, location })`，方便测试注入一个假的。
 */
function fetchLocation(url, timeoutMs, done) {
  const req = https.get(url, {
    headers: {
      // GitHub 对没有 User-Agent 的请求回 403。
      'User-Agent': 'slurmate-update-check',
      Accept: 'text/html',
    },
  }, (res) => {
    const out = { code: res.statusCode, location: res.headers.location || null };
    // 正文一个字都不需要，让它流走并释放连接。
    res.resume();
    done(null, out);
  });
  req.setTimeout(timeoutMs, () => {
    req.destroy(new Error('timeout'));
  });
  req.on('error', (e) => done(e));
}

/**
 * 跑一次检查。
 *
 * 返回 `{ status, latest, url }`：
 *   `update`  —— 有更新的正式版，`latest` 是版本号，`url` 是那个 tag 页
 *   `current` —— 问到了，本机就是最新
 *   `unknown` —— 没问到（断网、超时、GitHub 改了形状），一个字段都不保证
 *
 * `fetchLocation` 只为测试留的注入口。
 */
async function check(options = {}) {
  const { currentVersion, fetchLocation: get = (u, t, cb) => fetchLocation(u, t, cb) } = options;
  let raw;
  try {
    raw = await new Promise((resolve, reject) => {
      get(LATEST_URL, TIMEOUT_MS, (err, out) => (err ? reject(err) : resolve(out)));
    });
  } catch {
    return { status: STATUS_UNKNOWN, latest: null, url: null };
  }
  if (!raw || raw.code < 300 || raw.code >= 400 || !raw.location) {
    return { status: STATUS_UNKNOWN, latest: null, url: null };
  }
  const latest = parseLatestTag(raw.location);
  if (!latest) return { status: STATUS_UNKNOWN, latest: null, url: null };
  if (!isNewer(wireVersion(currentVersion), latest)) {
    return { status: STATUS_CURRENT, latest, url: null };
  }
  let page = LATEST_URL;
  try {
    page = new URL(raw.location, LATEST_URL).href;
  } catch {
    // 解析不出来就用固定入口：它照样能到那个版本。
  }
  return { status: STATUS_UPDATE, latest, url: page };
}

/** 本地日期，`YYYY-MM-DD`。按用户那边的日历算，不按 UTC。 */
function localDay(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 这一次结果值得弹一次窗吗。
 *
 * 规矩是「每天第一次打开软件时提醒一次」：
 *   · `promptedOn` 是上一次弹窗那天的本地日期，同一天不再弹 —— 一天里开几次
 *     只打扰第一次；
 *   · 软件一直开着不会再弹，因为检查只在启动时跑一次（见 `index.js` 的
 *     `armUpdateCheck`），没有定时器；
 *   · 第二天再打开，日期变了，同一个版本照样提醒 —— 用户还没升级，那是
 *     一次新的邀请。
 */
function shouldOffer(state, promptedOn, today) {
  if (!state || state.status !== STATUS_UPDATE || !state.latest) return false;
  return promptedOn !== today;
}

module.exports = {
  LATEST_URL,
  TIMEOUT_MS,
  STATUS_UPDATE,
  STATUS_CURRENT,
  STATUS_UNKNOWN,
  wireVersion,
  parseLatestTag,
  isNewer,
  localDay,
  shouldOffer,
  check,
};
