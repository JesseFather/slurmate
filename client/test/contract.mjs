/**
 * contract.mjs —— 验证演示后端**忠实复刻**了 code-server 4.135.0 的登录契约，
 *                 以及客户端的判定逻辑确实按这份契约写。
 *
 * 这个测试的意义不在于「测试通过」，而在于它把契约钉死成了可执行的断言。
 * 形态一旦漂移（比如有人「顺手」把错误口令改成返回 401 —— 那反而更符合直觉，
 * 但会让客户端的判定逻辑失效），这里会失败。
 *
 * 不需要 Electron，直接打真实 HTTP。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDemoCodeServer } = require('../src/main/demo-server.js');
const { COOKIE_NAME } = require('../src/main/demo-server.js');
const { LOGIN_PATH, PASSWORD_FIELD, loginSucceeded, isLoginUrl } =
  require('../src/main/login.js');

const PASSWORD = 'a1b2c3d4e5f6a7b8c9d0e1f2';

/** 起一个演示服务，跑完自动关掉。 */
async function withServer(fn) {
  const srv = createDemoCodeServer({ password: PASSWORD });
  await srv.listen();
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

/** 不让 fetch 自动跟随重定向 —— 我们要看的就是那个 302 本身。 */
const NO_REDIRECT = { redirect: 'manual' };

test('/healthz 免认证返回 200（作业模板用它判就绪）', async () => {
  await withServer(async (srv) => {
    const res = await fetch(`${srv.url}/healthz`, NO_REDIRECT);
    assert.equal(res.status, 200);
  });
});

test('未登录访问 / 返回 302 跳 /login', async () => {
  await withServer(async (srv) => {
    const res = await fetch(`${srv.url}/`, NO_REDIRECT);
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get('location'), srv.url).pathname, LOGIN_PATH);
  });
});

test('登录页用的是 password 字段名', async () => {
  await withServer(async (srv) => {
    const res = await fetch(`${srv.url}${LOGIN_PATH}`, NO_REDIRECT);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, new RegExp(`name=["']${PASSWORD_FIELD}["']`),
      '登录表单的字段名必须与契约一致，否则自动登录会静默失败');
  });
});

test('【核心】口令错误：HTTP 200 且没有 Set-Cookie', async () => {
  await withServer(async (srv) => {
    const res = await fetch(`${srv.url}${LOGIN_PATH}`, {
      ...NO_REDIRECT,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ [PASSWORD_FIELD]: 'wrong-password' }).toString(),
    });

    // 这两条断言是这段契约的全部要点。
    assert.equal(res.status, 200, '错误口令必须返回 200（真实行为就是这样）');
    assert.equal(res.headers.get('set-cookie'), null, '错误口令绝不能发 cookie');

    // 推论：任何靠状态码判断成败的写法在这里都会误判成功。
    // 客户端的判定函数必须给出 false。
    assert.equal(loginSucceeded([]), false);
  });
});

test('口令正确：302 + Set-Cookie', async () => {
  await withServer(async (srv) => {
    const res = await fetch(`${srv.url}${LOGIN_PATH}`, {
      ...NO_REDIRECT,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ [PASSWORD_FIELD]: PASSWORD }).toString(),
    });

    assert.equal(res.status, 302);
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, '正确口令必须发 cookie');
    assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=`));
    assert.match(setCookie, /Path=\//);

    // cookie jar 里能查到 → 判定成功
    const token = setCookie.split(';')[0].split('=').slice(1).join('=');
    assert.equal(loginSucceeded([{ name: COOKIE_NAME, value: token }]), true);
  });
});

test('带上有效 cookie 后 / 返回 200', async () => {
  await withServer(async (srv) => {
    const login = await fetch(`${srv.url}${LOGIN_PATH}`, {
      ...NO_REDIRECT,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ [PASSWORD_FIELD]: PASSWORD }).toString(),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const res = await fetch(`${srv.url}/`, { ...NO_REDIRECT, headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /页面收到的按键/);
  });
});

test('伪造 / 过期 cookie 会被拒（模拟作业重启换口令）', async () => {
  await withServer(async (srv) => {
    const res = await fetch(`${srv.url}/`, {
      ...NO_REDIRECT,
      headers: { cookie: `${COOKIE_NAME}=deadbeef` },
    });
    assert.equal(res.status, 302, '无效 cookie 必须被拒，不能放行');
  });
});

test('作废会话后旧 cookie 失效 —— 客户端必须重登而不是以为还登录着', async () => {
  await withServer(async (srv) => {
    const login = await fetch(`${srv.url}${LOGIN_PATH}`, {
      ...NO_REDIRECT,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ [PASSWORD_FIELD]: PASSWORD }).toString(),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    assert.equal((await fetch(`${srv.url}/`, { ...NO_REDIRECT, headers: { cookie } })).status, 200);

    srv.invalidateSessions();

    const after = await fetch(`${srv.url}/`, { ...NO_REDIRECT, headers: { cookie } });
    assert.equal(after.status, 302);
    // 这正是「cookie 还在但作业换了口令」时的表现：页面静默变成登录表单。
    // 客户端必须监听 did-navigate 里出现 /login 就触发重登（见 login.isLoginUrl）。
    assert.equal(isLoginUrl(new URL(after.headers.get('location'), srv.url).href), true);
  });
});

test('判定函数本身：只认 cookie，不认状态码', () => {
  assert.equal(loginSucceeded([{ name: COOKIE_NAME, value: 'x' }]), true);
  assert.equal(loginSucceeded([]), false);
  assert.equal(loginSucceeded(null), false);
  assert.equal(loginSucceeded(undefined), false);
  assert.equal(loginSucceeded('code-server-session=x'), false, '字符串不是合法入参');
});

test('isLoginUrl 的边界', () => {
  assert.equal(isLoginUrl('http://127.0.0.1:18080/login'), true);
  assert.equal(isLoginUrl('http://127.0.0.1:18080/login?failed=1'), true);
  assert.equal(isLoginUrl('http://127.0.0.1:18080/'), false);
  assert.equal(isLoginUrl('http://127.0.0.1:18080/login/../x'), false);
  assert.equal(isLoginUrl(''), false);
  assert.equal(isLoginUrl(null), false);
  assert.equal(isLoginUrl('not a url'), false);
});
