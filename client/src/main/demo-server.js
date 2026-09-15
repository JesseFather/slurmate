'use strict';
/**
 * demo-server.js —— 演示模式下站在「计算节点上那个服务」的位置上的**假 web 服务**。
 *
 * ★ 它是**通用**的：契约（界面路径、登录路径/字段/cookie）由当前会话那个插件的
 *   清单给，见 `setContract`。这个文件里没有任何一个具体网页服务的名字或常量 ——
 *   以前它叫「假 code-server」，而那意味着基座里躺着一份 code-server 的实现假设。
 *
 * ── 为什么演示后端要包含一个**真的 HTTP 服务**，而不是一个空壳 mock ─────────
 *
 * 登录这一段是整个客户端里最容易猜错、也最难在真机上复现的地方：
 *   · `GET <界面路径>` 未登录时 302 到登录页
 *   · `POST <登录路径>` 用契约里的字段名收口令
 *   · ★ **口令错误时返回 200 但没有 Set-Cookie**（不是 401！）
 *
 * 假 HTTP 服务让这段逻辑**真的被执行**：`test/contract.mjs` 直接打它，界面也真的
 * 走一遍 POST → 检查 cookie jar → 导航。唯一被假掉的是 SSH 那一跳。
 *
 * 这个文件是纯 Node，不依赖 Electron —— 所以测试可以直接 require 它。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 没设定契约时的**空契约**。
 *
 * ★ 刻意不是"一套像 code-server 的默认值"：那等于把某个具体服务偷偷写回基座，
 *   而且会让"页面为什么是空白的"变成一个查不出根因的现象。空契约下除健康检查
 *   外一律 404 —— 而真实流程里，服务被访问之前一定已经有过一次提交，
 *   `setContract` 一定已经跑过了。
 */
const NO_CONTRACT = { surface: null, login: null };

function readAsset(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'demo', name), 'utf8');
}

/**
 * @param {object} opts
 *   password  {string}  作业生成的随机口令（演示里由调用方给一个固定值）
 *   host      {string}  绑定地址，默认 127.0.0.1
 *   port      {number}  端口，0 = 让系统分配（测试用）
 */
function createDemoWebService({ password, host = '127.0.0.1', port = 0 } = {}) {
  if (!password) throw new Error('createDemoWebService: 必须提供 password');

  const sessions = new Set();          // 有效的 cookie 值
  let contract = NO_CONTRACT;
  let appHtml = null;
  let loginHtml = null;

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end('bad url');
      return;
    }

    // ── /healthz：这个假服务自己的存活探针 ────────────────────────────────
    // ★ 它**不是**任何插件契约的一部分 —— 客户端的代码从不请求它（作业模板才
    //   会，而那是插件作业侧自己的事）。留着它是为了让"服务起来了没有"这件事
    //   有一个与契约无关的、可以打的端点。
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    const login = contract.login;
    const surface = contract.surface;
    if (!login || !surface) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('no contract');       // 还没有会话，或者那个插件没有界面
      return;
    }

    const loggedIn = hasValidCookie(req);

    // ── GET 登录页：登录表单 ────────────────────────────────────────────────
    if (url.pathname === login.path && req.method === 'GET') {
      if (loggedIn) return redirect(res, surface.path);
      loginHtml = loginHtml || readAsset('login.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(loginHtml);
      return;
    }

    // ── POST 登录页：字段名来自契约 ────────────────────────────────────────
    // 这是整个契约的核心。真实服务的行为（实测 code-server 4.135.0）：
    //   正确口令 → 302 + Set-Cookie
    //   错误口令 → **200**（不是 401！）且**没有** Set-Cookie
    // 所以客户端【不能】靠状态码判断成败。
    if (url.pathname === login.path && req.method === 'POST') {
      readBody(req, (body) => {
        const form = new URLSearchParams(body);
        const given = form.get(login.field) || '';
        if (timingSafeEqual(given, password)) {
          const token = crypto.randomBytes(24).toString('hex');
          sessions.add(token);
          res.writeHead(302, {
            'location': surface.path,
            'set-cookie': `${login.cookie}=${token}; Path=/; SameSite=Lax; HttpOnly`,
          });
          res.end();
        } else {
          // 故意返回 200 —— 复刻真实行为，让客户端的判定逻辑必须靠 cookie 而不是状态码
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(loginHtml || (loginHtml = readAsset('login.html')));
        }
      });
      return;
    }

    // ── 其余路径都需要登录 ──────────────────────────────────────────────────
    if (!loggedIn) {
      res.writeHead(302, { location: login.path });
      res.end();
      return;
    }

    if (url.pathname === surface.path) {
      appHtml = appHtml || readAsset('app.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(appHtml);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  function hasValidCookie(req) {
    if (!contract.login) return false;
    const raw = req.headers.cookie;
    if (!raw) return false;
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === contract.login.cookie && sessions.has(v.join('='))) return true;
    }
    return false;
  }

  function redirect(res, to) {
    res.writeHead(302, { location: to });
    res.end();
  }

  return {
    /**
     * 这个假服务现在扮演哪一个插件。**提交时**由演示后端按解析出来的插件设置 ——
     * 服务是在 `connect()` 里起的，那时还不知道会有哪个会话。
     */
    setContract(c) {
      contract = c && c.surface && c.login ? { surface: c.surface, login: c.login } : NO_CONTRACT;
      sessions.clear();      // 换了服务就是换了口令的适用范围
    },
    get contract() { return contract; },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => {
        sessions.clear();
        server.close(() => resolve());
        // keep-alive 连接会拖住 close()，直接掐掉
        server.closeAllConnections?.();
      });
    },
    get port() {
      const a = server.address();
      return a && typeof a === 'object' ? a.port : null;
    },
    get url() {
      return `http://${host}:${this.port}`;
    },
    /** 测试用：手动作废全部会话，模拟作业重启后换口令 */
    invalidateSessions() { sessions.clear(); },
  };
}

function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 1 << 16) req.destroy();
  });
  req.on('end', () => cb(body));
}

/** 定长比较，避免用 === 比口令。演示代码也照做，免得被抄进正式路径。 */
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 长度不同也要走一次比较，避免泄漏长度
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { createDemoWebService, NO_CONTRACT };
