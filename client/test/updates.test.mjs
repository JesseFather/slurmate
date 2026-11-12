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

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  wireVersion, parseLatestTag, isNewer, localDay, shouldOffer, check, LATEST_URL,
} = require('../src/main/updates.js');

/** 造一个只回状态码与 Location 的取数函数。 */
function fakeGet(out) {
  return (_url, _timeoutMs, done) => done(null, out);
}

/** 造一个直接失败的取数函数。 */
function failingGet(message) {
  return (_url, _timeoutMs, done) => done(new Error(message));
}

test('wireVersion：三段转两段，后缀跟着走', () => {
  assert.equal(wireVersion('0.39.0-rc1'), '0.39-rc1');
  assert.equal(wireVersion('0.38.0'), '0.38');
  assert.equal(wireVersion('1.0.0-preview.811200'), '1.0-preview.811200');
});

test('wireVersion：认不出来的原样返回，不吞版本号', () => {
  assert.equal(wireVersion('0.39'), '0.39');
  assert.equal(wireVersion(''), '');
  assert.equal(wireVersion(undefined), '');
});

test('parseLatestTag：从 tag 页地址里取出版本号', () => {
  assert.equal(
    parseLatestTag('https://github.com/JesseFather/slurmate/releases/tag/v0.38'),
    '0.38');
  assert.equal(
    parseLatestTag('/JesseFather/slurmate/releases/tag/v0.39'),
    '0.39');
  assert.equal(
    parseLatestTag('https://github.com/JesseFather/slurmate/releases/tag/0.40'),
    '0.40');
});

test('parseLatestTag：query 与末尾斜杠不影响结果', () => {
  assert.equal(
    parseLatestTag('https://github.com/JesseFather/slurmate/releases/tag/v0.38?foo=1'),
    '0.38');
  assert.equal(
    parseLatestTag('https://github.com/JesseFather/slurmate/releases/tag/v0.38/'),
    '0.38');
});

test('parseLatestTag：不是 tag 页就回 null', () => {
  assert.equal(parseLatestTag('https://github.com/JesseFather/slurmate/releases'), null);
  assert.equal(parseLatestTag('https://github.com/JesseFather/slurmate/issues/1'), null);
  assert.equal(parseLatestTag('not a url at all'), null);
  assert.equal(parseLatestTag(''), null);
  assert.equal(parseLatestTag(null), null);
});

test('isNewer：数字更大的算新', () => {
  assert.equal(isNewer('0.38', '0.39'), true);
  assert.equal(isNewer('0.38', '0.40'), true);
  assert.equal(isNewer('0.9', '0.10'), true);
  assert.equal(isNewer('0.39', '0.38'), false);
});

test('isNewer：预览版能升到同版本的正式版，反过来不行', () => {
  assert.equal(isNewer('0.39-rc1', '0.39'), true);
  assert.equal(isNewer('0.39', '0.39-rc1'), false);
});

test('isNewer：同一个正式版不算新', () => {
  assert.equal(isNewer('0.39', '0.39'), false);
});

test('isNewer：预览版比更高版本的正式版旧', () => {
  assert.equal(isNewer('0.39-rc1', '0.40'), true);
});

test('isNewer：认不出来的版本一律不报新', () => {
  assert.equal(isNewer('', '0.39'), false);
  assert.equal(isNewer('0.39', ''), false);
  assert.equal(isNewer('abc', '0.39'), false);
  assert.equal(isNewer(undefined, '0.39'), false);
});

test('check：302 指到更高的 tag 就是有更新', async () => {
  const r = await check({
    currentVersion: '0.38.0',
    fetchLocation: fakeGet({
      code: 302,
      location: 'https://github.com/JesseFather/slurmate/releases/tag/v0.39',
    }),
  });
  assert.equal(r.status, 'update');
  assert.equal(r.latest, '0.39');
  assert.equal(r.url, 'https://github.com/JesseFather/slurmate/releases/tag/v0.39');
});

test('check：本机已经是最新正式版', async () => {
  const r = await check({
    currentVersion: '0.39.0',
    fetchLocation: fakeGet({
      code: 302,
      location: 'https://github.com/JesseFather/slurmate/releases/tag/v0.39',
    }),
  });
  assert.equal(r.status, 'current');
  assert.equal(r.latest, '0.39');
  assert.equal(r.url, null);
});

test('check：预览版看到同版本正式版时提醒，因为它不是最新的那一类', async () => {
  const r = await check({
    currentVersion: '0.39.0-rc1',
    fetchLocation: fakeGet({
      code: 302,
      location: 'https://github.com/JesseFather/slurmate/releases/tag/v0.39',
    }),
  });
  assert.equal(r.status, 'update');
  assert.equal(r.latest, '0.39');
});

test('check：没有 302 就是没问到，不是「已是最新」', async () => {
  const r = await check({
    currentVersion: '0.38.0',
    fetchLocation: fakeGet({ code: 200, location: null }),
  });
  assert.equal(r.status, 'unknown');
});

test('check：404 与跳去别处都按没问到处理', async () => {
  const notFound = await check({
    currentVersion: '0.38.0',
    fetchLocation: fakeGet({ code: 404, location: null }),
  });
  assert.equal(notFound.status, 'unknown');

  const elsewhere = await check({
    currentVersion: '0.38.0',
    fetchLocation: fakeGet({
      code: 302,
      location: 'https://github.com/JesseFather/slurmate/releases',
    }),
  });
  assert.equal(elsewhere.status, 'unknown');
});

test('check：网络错误静默成没问到', async () => {
  const r = await check({
    currentVersion: '0.38.0',
    fetchLocation: failingGet('ECONNRESET'),
  });
  assert.equal(r.status, 'unknown');
  assert.equal(r.latest, null);
  assert.equal(r.url, null);
});

test('check：取数函数同步抛也不往上冒', async () => {
  const r = await check({
    currentVersion: '0.38.0',
    fetchLocation: () => { throw new Error('boom'); },
  });
  assert.equal(r.status, 'unknown');
});

test('shouldOffer：只有查到更新的正式版才值得弹窗', () => {
  assert.equal(shouldOffer({ status: 'update', latest: '0.40' }, '', '2026-11-12'), true);
  assert.equal(shouldOffer({ status: 'current', latest: '0.40' }, '', '2026-11-12'), false);
  assert.equal(shouldOffer({ status: 'unknown', latest: null }, '', '2026-11-12'), false);
  assert.equal(shouldOffer(null, '', '2026-11-12'), false);
  // 没有版本号的那种 update 也不算数。
  assert.equal(shouldOffer({ status: 'update', latest: '' }, '', '2026-11-12'), false);
});

test('shouldOffer：一天只弹一次，第二天打开再弹', () => {
  const state = { status: 'update', latest: '0.40' };
  assert.equal(shouldOffer(state, '2026-11-12', '2026-11-12'), false,
    '今天已经弹过，一天里再打开软件不弹');
  assert.equal(shouldOffer(state, '2026-11-11', '2026-11-12'), true,
    '第二天打开要接着提醒，因为用户还没升级');
  assert.equal(shouldOffer(state, '', '2026-11-12'), true,
    '从没弹过');
});

test('shouldOffer：判的是日期不是版本号', () => {
  // 新版本出现也不该在同一天再弹一次。
  assert.equal(
    shouldOffer({ status: 'update', latest: '0.41' }, '2026-11-12', '2026-11-12'),
    false);
});

test('localDay：本地日期，月与日补零', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(localDay(new Date(2026, 10, 12, 0, 0)), '2026-11-12');
  assert.equal(localDay(new Date(2026, 11, 31, 12, 0)), '2026-12-31');
});

test('LATEST_URL：用的是 releases/latest 这个固定入口', () => {
  assert.equal(LATEST_URL, 'https://github.com/JesseFather/slurmate/releases/latest');
});
