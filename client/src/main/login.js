'use strict';
/**
 * login.js —— 与 code-server 登录契约相关的**全部**常量与判定，集中在一处。
 *
 * 这个文件之所以存在，是因为客户端与 code-server 之间真正的版本耦合面**只有两样**：
 * 端点路径 `/login` 和表单字段名 `password`。把它们和判定逻辑收在一起，将来
 * code-server 升级改了这两样，只需要动这个文件（并走三层降级）。
 *
 * 最重要的一条：**判定成败只能看 cookie，不能看状态码。**
 * 实测（code-server 4.135.0）：口令错误时返回的是 **HTTP 200**，只是没有 Set-Cookie。
 * 任何 `if (res.status === 200) 成功` 的写法都会在口令错误时报告登录成功，
 * 然后用户看到一个「已登录但满屏是登录页」的窗口 —— 又一个静默失败。
 */

const LOGIN_PATH = '/login';
const HEALTHZ_PATH = '/healthz';
const PASSWORD_FIELD = 'password';
const SESSION_COOKIE = 'code-server-session';

/**
 * 判定登录是否成功。
 *
 * @param {Array} cookies `session.cookies.get({name: SESSION_COOKIE, url})` 的结果
 * @returns {boolean}
 *
 * 注意参数是 **cookie jar 的查询结果**，不是响应头。Electron `net` 模块的
 * `response.headers['set-cookie']` 在若干版本上取不到值 —— 查 jar 既避开了这个坑，
 * 又比解析响应头更贴近我们真正关心的问题：cookie 到底进没进去。
 */
function loginSucceeded(cookies) {
  return Array.isArray(cookies) && cookies.length > 0;
}

/** 未登录时 code-server 会把页面跳到哪儿。用于识别「页面静默变成登录表单」。 */
function isLoginUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    return new URL(url).pathname === LOGIN_PATH;
  } catch {
    return false;
  }
}

module.exports = {
  LOGIN_PATH, HEALTHZ_PATH, PASSWORD_FIELD, SESSION_COOKIE,
  loginSucceeded, isLoginUrl,
};
