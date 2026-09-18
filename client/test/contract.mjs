/**
 * contract.mjs —— 验证那个假 web 服务**忠实复刻**了网页表单登录的契约，
 *                 以及基座的登录判定确实按那份契约写。
 *
 * 这个测试的意义不在于「测试通过」，而在于它把契约钉死成了可执行的断言。
 * 形态一旦漂移（比如有人「顺手」把错误口令改成返回 401 —— 那反而更符合直觉，
 * 但会让客户端的判定逻辑失效），这里会失败。
 *
 * ★ 契约值**从插件清单里读**，不在这里另抄一份。抄的那份迟早会与清单分叉，
 *   而分叉的表现是"登录莫名其妙失败"，指不回根因。同时这也钉住了一件事：
 *   假服务扮演的是**那个插件声明的**服务，不是某个写死的服务。
 *
 * 不需要 Electron，直接打真实 HTTP。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const { createDemoWebService } = require('../src/main/demo-server.js');
const { webLogin, isLoginPath } = require('../src/main/weblogin.js');

/** code-server 插件声明的登录契约 —— 那份 HTTP 200 的实测事实就是在它身上量的。 */
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(here, '..', '..', 'plugins', 'code-server', 'plugin.json'), 'utf8'));
const CONTRACT = MANIFEST.contributes.login;
const SURFACE = MANIFEST.contributes.surface;

const PASSWORD = 'a1b2c3d4e5f6a7b8c9d0e1f2';

/** 起一个假服务、设定契约，跑完自动关掉。 */
async function withServer(fn, contract = CONTRACT) {
  const srv = createDemoWebService({ password: PASSWORD });
  srv.setContract({ surface: SURFACE, login: contract });
  await srv.listen();
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

/** 不让 fetch 自动跟随重定向 —— 我们要看的就是那个 302 本身。 */
const NO_REDIRECT = { redirect: 'manual' };
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const post = (srv, body) => fetch(`${srv.url}${CONTRACT.path}`, {
  ...NO_REDIRECT, method: 'POST', headers: FORM, body: new URLSearchParams(body).toString(),
});

test('/healthz 免认证返回 200（这个假服务自己的存活探针）', async () => {
  await withServer(async (srv) => {
    const res = await fetch(`${srv.url}/healthz`, NO_REDIRECT);
    assert.equal(res.status, 200);
  });
});

test('未登录访问界面路径返回 302 跳登录页', async () => {
  await withServer(async (srv) => {
    const res = await fetch(`${srv.url}${SURFACE.path}`, NO_REDIRECT);
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get('location'), srv.url).pathname, CONTRACT.path);
  });
});

test('登录页用的是契约里的字段名', async () => {
  await withServer(async (srv) => {
    const res = await fetch(`${srv.url}${CONTRACT.path}`, NO_REDIRECT);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, new RegExp(`name=["']${CONTRACT.field}["']`),
      '登录表单的字段名必须与契约一致，否则自动登录会静默失败');
  });
});

test('【核心】口令错误：HTTP 200 且没有 Set-Cookie', async () => {
  await withServer(async (srv) => {
    const res = await post(srv, { [CONTRACT.field]: 'wrong-password' });

    // 这两条断言是这段契约的全部要点。
    assert.equal(res.status, 200, '错误口令必须返回 200（真实行为就是这样）');
    assert.equal(res.headers.get('set-cookie'), null, '错误口令绝不能发 cookie');

    // 推论：任何靠状态码判断成败的写法在这里都会误判成功。基座的判定必须给出 false。
    const r = await webLogin(
      { fetch: async () => ({ status: 200 }), cookies: { get: async () => [] } },
      srv.url, 'wrong-password', CONTRACT);
    assert.equal(r.ok, false, '没有 cookie 就是没登录成功，不管状态码是多少');
    assert.equal(r.reason, 'no_cookie');
  });
});

test('口令正确：302 + Set-Cookie', async () => {
  await withServer(async (srv) => {
    const res = await post(srv, { [CONTRACT.field]: PASSWORD });

    assert.equal(res.status, 302);
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, '正确口令必须发 cookie');
    assert.match(setCookie, new RegExp(`^${CONTRACT.cookie}=`));
    assert.match(setCookie, /Path=\//);

    // cookie jar 里能查到 → 判定成功。走**真的** jar 形状，不手搓一个布尔。
    const token = setCookie.split(';')[0].split('=').slice(1).join('=');
    const r = await webLogin(
      {
        fetch: async (url, opts) => {
          const res2 = await fetch(url, opts);
          return { status: res2.status };
        },
        cookies: { get: async ({ name }) => (name === CONTRACT.cookie ? [{ name, value: token }] : []) },
      },
      srv.url, PASSWORD, CONTRACT);
    assert.equal(r.ok, true);
  });
});

test('带上有效 cookie 后界面路径返回 200', async () => {
  await withServer(async (srv) => {
    const login = await post(srv, { [CONTRACT.field]: PASSWORD });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const res = await fetch(`${srv.url}${SURFACE.path}`, { ...NO_REDIRECT, headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /页面收到的按键/);
  });
});

test('伪造 / 过期 cookie 会被拒（模拟作业重启换口令）', async () => {
  await withServer(async (srv) => {
    const res = await fetch(`${srv.url}${SURFACE.path}`, {
      ...NO_REDIRECT,
      headers: { cookie: `${CONTRACT.cookie}=deadbeef` },
    });
    assert.equal(res.status, 302, '无效 cookie 必须被拒，不能放行');
  });
});

test('作废会话后旧 cookie 失效 —— 客户端必须重登而不是以为还登录着', async () => {
  await withServer(async (srv) => {
    const login = await post(srv, { [CONTRACT.field]: PASSWORD });
    const cookie = login.headers.get('set-cookie').split(';')[0];

    assert.equal(
      (await fetch(`${srv.url}${SURFACE.path}`, { ...NO_REDIRECT, headers: { cookie } })).status, 200);

    srv.invalidateSessions();

    const after = await fetch(`${srv.url}${SURFACE.path}`, { ...NO_REDIRECT, headers: { cookie } });
    assert.equal(after.status, 302);
    // 这正是「cookie 还在但作业换了口令」时的表现：页面静默变成登录表单。
    // ★ 客户端**目前还没有**监听 did-navigate 去重登（isLoginPath 没有任何调用者，
    //   见 weblogin.js）—— 所以这里只断言"能认出它是登录页"，不断言会自动重登。
    assert.equal(isLoginPath(new URL(after.headers.get('location'), srv.url).href, CONTRACT.path), true);
  });
});

test('★ 换一份契约，假服务就扮另一个服务 —— 基座里没有"哪个服务"这个概念', async () => {
  // 一个假想的 Jupyter 式契约：路径、字段名、cookie 名全都不一样。
  const other = { path: '/auth/token', field: 'token', cookie: 'jupyter-session' };
  await withServer(async (srv) => {
    // 旧的路径在这个契约下**不再是登录页**，而是需要登录的普通路径
    const old = await fetch(`${srv.url}${CONTRACT.path}`, NO_REDIRECT);
    assert.equal(old.status, 302);
    assert.equal(new URL(old.headers.get('location'), srv.url).pathname, other.path,
      '跳转目标必须跟着契约走');

    const res = await fetch(`${srv.url}${other.path}`, {
      ...NO_REDIRECT, method: 'POST', headers: FORM,
      body: new URLSearchParams({ [other.field]: PASSWORD }).toString(),
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('set-cookie') || '', /^jupyter-session=/,
      'cookie 名必须跟着契约走');
  }, other);
});

test('★ 基座的登录判定只认契约里的 cookie', async () => {
  const jar = (names) => ({
    fetch: async () => ({ status: 200 }),
    cookies: { get: async ({ name }) => (names.includes(name) ? [{ name, value: 'x' }] : []) },
  });
  // 名字对不上就是没登录 —— 哪怕 jar 里**有**一个 cookie
  assert.equal((await webLogin(jar(['别的']), 'http://x', 'pw', CONTRACT)).ok, false);
  assert.equal((await webLogin(jar([CONTRACT.cookie]), 'http://x', 'pw', CONTRACT)).ok, true);

  // 没有契约 / 没有口令时明确失败，而不是猜一个默认端点
  assert.equal((await webLogin(jar(['x']), 'http://x', 'pw', null)).reason, 'no_contract');
  assert.equal((await webLogin(jar(['x']), 'http://x', '', CONTRACT)).reason, 'no_password');
});

test('isLoginPath 的边界', () => {
  const p = CONTRACT.path;
  assert.equal(isLoginPath(`http://127.0.0.1:18080${p}`, p), true);
  assert.equal(isLoginPath(`http://127.0.0.1:18080${p}?failed=1`, p), true);
  assert.equal(isLoginPath('http://127.0.0.1:18080/', p), false);
  assert.equal(isLoginPath(`http://127.0.0.1:18080${p}/../x`, p), false);
  assert.equal(isLoginPath('', p), false);
  assert.equal(isLoginPath(null, p), false);
  assert.equal(isLoginPath('not a url', p), false);
});
