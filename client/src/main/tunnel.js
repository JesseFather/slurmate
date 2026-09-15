'use strict';
/**
 * tunnel.js —— 槽位本地端口转发。
 *
 * 在 `127.0.0.1:<槽位端口>` 上监听，把每条进来的连接通过后端的数据通道
 * （真实模式是 ssh2 的 forwardOut / direct-tcpip）转发到目标。
 *
 * ── 三条硬约束，每条都对应一个具体的失败 ──────────────────────────────────
 *
 * 1. **只听 127.0.0.1，绝不能只听端口。** Node 的 `server.listen(port)` 默认绑 `::`
 *    （双栈全部网卡）。那会把隧道暴露到局域网上 —— 任何能连到你机器的人都能直接
 *    进你的 IDE。必须显式传 host。
 *
 * 2. **目标地址只从 tunnel_target 解析，且必须是字面 IPv4。**
 *    守护进程写进 nft 规则的是 `ip daddr <字面IP>`；如果客户端把节点名重新解析一遍，
 *    解析结果与 nft 里的不一致时 ACL 会**静默失效** —— 一切看起来正常，只是没有保护。
 *    见 cluster/slurmate-sessiond:1674-1680 那段强措辞的注释。所以这里过
 *    `net.isIPv4()`，不过就拒绝建隧道，绝不交给 DNS。
 *
 * 3. **只允许 backend.dial 这一条拨号路径。** 不得出现直接 `net.connect(远端IP)` ——
 *    那会绕过 SSH 隧道，让它变成一个裸的、无 ACL 保护的直连。
 *
 * ── 半开连接 ───────────────────────────────────────────────────────────────
 * `a.pipe(b).pipe(a)` 是能透明支持 HTTP + WebSocket + Upgrade 的最简写法，但任一侧
 * 出错时另一侧**不会**自动销毁，会留下半开连接把浏览器吊死。所以两侧都要挂 error，
 * 并在任一侧 error/close 时销毁另一侧。
 */

const net = require('net');
const { EventEmitter } = require('events');

/** 端口被占时向后试多少个。 */
const PORT_SCAN_LIMIT = 20;

class Tunnel extends EventEmitter {
  constructor({ backend }) {
    super();
    this.backend = backend;
    this.server = null;
    this.port = null;
    this.target = null;        // { host, port, raw }
    this._sockets = new Set(); // 活跃的本地连接，stop() 时要一并销毁
    this._upstreams = new Set();
    this.state = 'stopped';    // stopped | listening | down
  }

  /**
   * 解析 `"IPv4:端口"`。**这是本文件唯一的地址来源。**
   * @returns {{host:string, port:number, raw:string}}
   * @throws  {Error} 不是合法 IPv4 或端口越界
   */
  static parseTarget(raw) {
    if (typeof raw !== 'string' || !raw) throw new Error('隧道目标为空');
    const i = raw.lastIndexOf(':');
    if (i <= 0) throw new Error(`隧道目标格式不对：${JSON.stringify(raw)}`);
    const host = raw.slice(0, i);
    const portStr = raw.slice(i + 1);
    if (!net.isIPv4(host)) {
      // 这一步是安全关键：解析节点名会让客户端用的地址与 nft 里的 ip daddr 分叉。
      throw new Error(`隧道目标里的地址不是字面 IPv4：${JSON.stringify(host)}（拒绝交给 DNS 解析）`);
    }
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`隧道目标里的端口不合法：${JSON.stringify(portStr)}`);
    }
    return { host, port, raw };
  }

  /**
   * 开始监听。
   *
   * @param {object} opts
   *   preferredPort {number}   优先端口（布局组绑定的端口）
   *   target        {string}   "IPv4:端口"
   *   excludePorts  {Set|Array} **别的布局组占着的端口**，顺移时必须跳过。
   *                            不跳的后果不是「换了个端口」：两个组会在配置里同时
   *                            声称同一个端口，每次启动谁先绑谁赢，布局在两个 origin
   *                            之间反复横跳，而界面上一切正常。
   *                            调用方**必须**把目标组自己排除在外（用
   *                            usedLayoutPorts(cfg, 目标组id)），否则它自己的端口
   *                            会被当成「别人的」而永远绑不上。
   * @returns {Promise<{port:number, shifted:boolean}>} shifted=true 表示首选端口被占，换过了
   */
  async start({ preferredPort, target, excludePorts }) {
    const parsed = Tunnel.parseTarget(target);   // 先校验，再动手
    this.target = parsed;

    if (this.server) {
      // 已经在监听了：只更新目标。端口不变 → origin 不变 → localStorage 不丢。
      this.state = 'listening';
      this.emit('state', { state: this.state, port: this.port, shifted: false });
      return { port: this.port, shifted: false };
    }

    const { port, shifted } = await this._listen(preferredPort, excludePorts);
    this.port = port;
    this.state = 'listening';
    this.emit('state', { state: this.state, port, shifted });
    return { port, shifted };
  }

  async _listen(preferredPort, excludePorts) {
    const reserved = excludePorts instanceof Set
      ? excludePorts : new Set(excludePorts || []);
    let lastErr = null;
    for (let i = 0; i < PORT_SCAN_LIMIT; i++) {
      const p = preferredPort + i;
      if (p > 65535) break;
      // ★ 绝不落到**别的布局组**的端口上。落上去的后果不是「换了个端口」：
      //   两个组会在配置里同时声称同一个端口，下次启动谁先绑谁赢、另一个再顺移，
      //   于是每次启动布局都在两个 origin 之间反复横跳 —— 而界面一切正常。
      if (reserved.has(p)) {
        lastErr = new Error(`端口 ${p} 属于另一个布局组`);
        continue;
      }
      try {
        await this._listenOn(p);
        return { port: p, shifted: i > 0 };
      } catch (e) {
        lastErr = e;
        if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
        // EACCES 在 Windows 上很常见：Hyper-V/WSL 会保留大段端口。
        // 继续往后试，但把原因带到界面上 —— 换端口意味着 origin 变了，UI 布局会重置，
        // 用户有权知道为什么。
      }
    }
    throw new Error(
      `本地端口 ${preferredPort}–${preferredPort + PORT_SCAN_LIMIT - 1} 都不可用` +
      (reserved.size ? `（已跳过 ${[...reserved].join('、')}：属于其他布局组）` : '') +
      (lastErr ? `（最后一个错误：${lastErr.code || lastErr.message}）` : ''));
  }

  _listenOn(port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((local) => this._onConnection(local));
      server.once('error', reject);
      // ★ 显式绑 127.0.0.1。不传 host 会绑到所有网卡，等于把 IDE 挂在局域网上。
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        server.on('error', (e) => {
          this.emit('error', e);
        });
        this.server = server;
        resolve();
      });
    });
  }

  async _onConnection(local) {
    this._sockets.add(local);
    local.on('close', () => this._sockets.delete(local));
    local.on('error', () => local.destroy());

    let upstream;
    try {
      upstream = await this.backend.dial(this.target.host, this.target.port);
    } catch (e) {
      // 隧道断了。**立刻销毁本地连接**，让浏览器拿到一个明确的失败（RST），
      // 而不是让它永远 pending —— 后者看起来像界面卡死，是最难排查的表现。
      local.destroy();
      this.state = 'down';
      this.emit('state', { state: 'down', port: this.port, error: e.message });
      return;
    }

    this._upstreams.add(upstream);
    const cleanup = () => {
      this._upstreams.delete(upstream);
    };
    upstream.on('close', cleanup);
    upstream.on('error', () => { cleanup(); upstream.destroy(); local.destroy(); });

    // 双向管道。两侧都挂 error，任一侧断开就销毁另一侧（防半开连接）。
    local.pipe(upstream);
    upstream.pipe(local);
    local.on('close', () => upstream.destroy());
    upstream.on('close', () => local.destroy());

    if (this.state !== 'listening') {
      this.state = 'listening';
      this.emit('state', { state: 'listening', port: this.port });
    }
  }

  /** 关掉监听并销毁所有活跃连接。重连期间调用 —— 让浏览器立刻拿到 ECONNREFUSED。 */
  async stop() {
    for (const s of this._sockets) s.destroy();
    for (const u of this._upstreams) u.destroy();
    this._sockets.clear();
    this._upstreams.clear();

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
    this.state = 'stopped';
    this.emit('state', { state: 'stopped', port: this.port });
  }

  /** 当前本地 URL 的 origin。**固定用字面量 127.0.0.1**，不用 localhost ——
   *  两者在 Chromium 里是不同 origin，且 localhost 可能解析成 ::1。 */
  get origin() {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }
}

module.exports = { Tunnel, PORT_SCAN_LIMIT };
