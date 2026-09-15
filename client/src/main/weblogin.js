'use strict';
/**
 * weblogin.js —— 「往一个网页表单 POST 口令，然后看 cookie 有没有进去」。
 *
 * ── 为什么这是**框架**的事，而不是某个插件的事 ──────────────────────────────
 *
 * 网页服务让客户端自动登录，靠的永远是同一件事：知道往哪个路径 POST、表单字段
 * 叫什么、成功之后应该多出哪个 cookie。这三样是**数据**，所以它们在插件的清单里
 * （`contributes.login`），不在代码里。
 *
 * ★ 于是基座**一个字都不知道 code-server 是什么**，而任何一个 web 插件都能自动
 *   登录 —— 换个路径、换个字段名就是另一个服务。反过来，如果这三个值写死在
 *   基座里（它们曾经就在 `login.js` 里），那基座身体里就永远躺着一个特定服务的
 *   实现，而它看起来还是个通用能力。
 *
 * ── ★ 下面两条是**通用机制的**陷阱，不是某个服务的性质，所以留在这里 ────────
 *
 * 1. **判定成败只能看 cookie，不能看状态码。** 实测（code-server 4.135.0）：
 *    口令错误时返回的是 **HTTP 200**，只是没有 Set-Cookie。任何
 *    `if (status === 200) 成功` 的写法都会在口令错误时报告登录成功，然后用户
 *    看到一个「已登录但满屏是登录页」的窗口 —— 又一个静默失败。
 *
 * 2. **也绝不能解析响应头的 set-cookie**：Electron `net` 模块在这件事上不可靠
 *    （electron#20631）。查 jar 既避开了这个坑，又更贴近我们真正关心的问题 ——
 *    cookie 到底进没进去。
 */

/** 表单提交的 content-type。三种主流写法里这是唯一被 HTML 规范定义的那一种。 */
const FORM_TYPE = 'application/x-www-form-urlencoded';

/**
 * 登录：POST 契约里的路径，然后用 **cookie jar** 判定成败。
 *
 * @param {object} ses       Electron 的 session（提供 fetch 与 cookies）
 * @param {string} origin    形如 `http://127.0.0.1:18080`
 * @param {string} password  口令
 * @param {object} contract  插件的 `contributes.login`：{path, field, cookie}
 * @returns {Promise<{ok:boolean, reason?:string, status?:number|null}>}
 */
async function webLogin(ses, origin, password, contract) {
  if (!contract) return { ok: false, reason: 'no_contract' };
  if (!password) return { ok: false, reason: 'no_password' };

  let status = null;
  try {
    const res = await ses.fetch(origin + contract.path, {
      method: 'POST',
      headers: { 'content-type': FORM_TYPE },
      body: new URLSearchParams({ [contract.field]: password }).toString(),
      redirect: 'manual',
    });
    status = res.status;
  } catch (e) {
    return { ok: false, reason: 'fetch_failed: ' + e.message };
  }

  const cookies = await ses.cookies.get({ name: contract.cookie, url: origin });
  if (Array.isArray(cookies) && cookies.length > 0) return { ok: true, status };

  // 到这儿说明没拿到 cookie。可能是口令错，也可能是服务升级改了端点或字段名。
  // 两者要分开告诉用户 —— 「密码不对」和「客户端版本不匹配」是完全不同的行动。
  return { ok: false, reason: 'no_cookie', status };
}

/**
 * 这个 URL 是不是契约里的那个登录页。
 *
 * ★ **今天没有任何地方调用它。** 它配的是「页面静默变回登录表单时自动重登」
 *   （监听 `did-navigate`）—— 那个监听**从来没有被接上**。留着它是因为它是这份
 *   契约的自然一半，而且写对它有细节（**只比 pathname**：`/login?failed=1` 也算，
 *   而 `/login/../x` 不算）。接上那个监听之前，**别以为它已经在起作用**。
 */
function isLoginPath(url, path) {
  if (typeof url !== 'string' || !url) return false;
  try {
    return new URL(url).pathname === path;
  } catch {
    return false;
  }
}

module.exports = { webLogin, isLoginPath, FORM_TYPE };
