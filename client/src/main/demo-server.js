'use strict';
/**
 * demo-server.js —— 演示后端里的那个「计算节点上的 code-server」。
 *
 * 为什么演示后端要包含一个**真的 HTTP 服务**，而不是一个空壳 mock：
 *
 * 登录契约（`/healthz` 免认证、`GET /` 未登录 302、`POST /login` 字段名 `password`、
 * **口令错误时返回 200 但没有 Set-Cookie**）是整个客户端里最容易猜错、也最难在真机上
 * 复现的地方。假 HTTP 服务让这段逻辑**真的被执行**：`test/contract.mjs` 直接打它，
 * 界面也真的走一遍 POST → 检查 cookie jar → 导航。唯一被假掉的是 SSH 那一跳。
 *
 * 这个文件是纯 Node，不依赖 Electron —— 所以测试可以直接 require 它。
 * 契约来源：code-server 4.135.0 上的端到端实测（见计划文档「口令与登录契约」一节）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE_NAME = 'code-server-session';

function readAsset(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'demo', name), 'utf8');
}

/**
 * @param {object} opts
 *   password  {string}  作业生成的随机口令（演示里由调用方给一个固定值）
 *   host      {string}  绑定地址，默认 127.0.0.1
 *   port      {number}  端口，0 = 让系统分配（测试用）
 */
function createDemoCodeServer({ password, host = '127.0.0.1', port = 0 } = {}) {
  if (!password) throw new Error('createDemoCodeServer: 必须提供 password');

  const sessions = new Set();          // 有效的 cookie 值
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

    // ── /healthz：200，免认证。作业模板用它判断就绪（run.sbatch:208）──────
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    const loggedIn = hasValidCookie(req);

    // ── GET /login：登录表单 ────────────────────────────────────────────────
    if (url.pathname === '/login' && req.method === 'GET') {
      if (loggedIn) return redirect(res, '/');
      loginHtml = loginHtml || readAsset('login.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(loginHtml);
      return;
    }

    // ── POST /login：字段名 password ────────────────────────────────────────
    // 这是整个契约的核心。真实 code-server 的行为：
    //   正确口令 → 302 + Set-Cookie
    //   错误口令 → **200**（不是 401！）且**没有** Set-Cookie
    // 所以客户端【不能】靠状态码判断成败。
    if (url.pathname === '/login' && req.method === 'POST') {
      readBody(req, (body) => {
        const form = new URLSearchParams(body);
        const given = form.get('password') || '';
        if (timingSafeEqual(given, password)) {
          const token = crypto.randomBytes(24).toString('hex');
          sessions.add(token);
          res.writeHead(302, {
            'location': '/',
            'set-cookie': `${COOKIE_NAME}=${token}; Path=/; SameSite=Lax; HttpOnly`,
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
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }

    if (url.pathname === '/') {
      appHtml = appHtml || readAsset('app.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(appHtml);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  function hasValidCookie(req) {
    const raw = req.headers.cookie;
    if (!raw) return false;
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE_NAME && sessions.has(v.join('='))) return true;
    }
    return false;
  }

  function redirect(res, to) {
    res.writeHead(302, { location: to });
    res.end();
  }

  return {
    COOKIE_NAME,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const s of sessions) sessions.delete(s);
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

module.exports = { createDemoCodeServer, COOKIE_NAME };
