'use strict';
/**
 * hosts.js —— 登录节点地址的并发探测。
 *
 * 地址从哪来：**连接列表**（`config.connections`），由用户在界面上填。
 * 这里曾经有一个 `BUILTIN_HOSTS` 内置表，**有意为空** —— 写死某个集群的地址
 * 等于把站点拓扑随源码分发出去，别人 fork 走也只能连到那个集群，既泄露又无用。
 * 现在连这个空数组也去掉了：地址只有一个来源，就是用户填的那几条，
 * 少一层「内置 + 用户」的合并，就少一处「我配了却没生效」的可能。
 *
 * 探测方式：TCP 连上以后**读 SSH banner**（`SSH-2.0-...`），而不是只做 TCP connect。
 * 只连不读的话，任何在这个端口上监听的东西都会被判成「登录节点可达」—— 一个端口转发
 * 中间盒、一个防火墙的 REJECT-then-accept，都会给出假绿。
 */

const net = require('net');

const DEFAULT_TIMEOUT_MS = 2500;

/**
 * 探测单个地址：TCP 连接 + 读 SSH banner。
 * @returns {Promise<{id,host,port,label,priority,reachable:boolean,rttMs:number|null,
 *                    banner:string|null,error:string|null}>}
 */
function probeHost(entry, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let banner = '';
    const sock = new net.Socket();

    const finish = (reachable, error) => {
      if (settled) return;
      settled = true;
      const rttMs = Date.now() - started;
      sock.destroy();
      resolve({
        id: entry.id || null,
        host: entry.host,
        port: entry.port,
        label: entry.label || entry.host,
        priority: Number.isFinite(entry.priority) ? entry.priority : 99,
        reachable,
        rttMs: reachable ? rttMs : null,
        banner: banner.trim() || null,
        error: error || null,
      });
    };

    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => finish(false, `超时（${timeoutMs}ms）`));
    sock.once('error', (e) => finish(false, e.code || e.message));
    sock.once('connect', () => {
      // SSH 服务端在连接建立后立刻主动发 banner，所以这里不需要写任何数据
    });
    sock.on('data', (chunk) => {
      banner += chunk.toString('utf8', 0, Math.min(chunk.length, 256));
      if (banner.includes('\n') || banner.length >= 256) {
        if (/^SSH-2\.0-/.test(banner.trim())) {
          finish(true, null);
        } else {
          // 端口开着，但对面不是 SSH —— 这必须算失败，否则会用错误的地址去连
          finish(false, `端口开放但不是 SSH 服务（收到 ${JSON.stringify(banner.slice(0, 32))}）`);
        }
      }
    });
    sock.connect(entry.port, entry.host);
  });
}

/**
 * 并发探测全部地址，按 priority 排序返回**全部**结果（含失败的）。
 *
 * ★ 返回全部而不是只返回可达的：界面需要能在**全部失败**时逐个报出失败原因，
 *   而不是给一句笼统的「连接失败」。而且在一条连接都没配的情况下，调用方要能
 *   分清「候选为空」与「候选都不可达」—— 前者该提示「还没有配置任何连接」。
 */
async function probeAll(entries, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((h) => h && h.host && Number.isInteger(h.port))
    .map((h, i) => ({ ...h, priority: Number.isFinite(h.priority) ? h.priority : i + 1 }));
  const results = await Promise.all(list.map((h) => probeHost(h, timeoutMs)));
  return results.sort((a, b) => a.priority - b.priority);
}

/** 选第一个可达的地址。全不可达时返回 null。 */
async function pickHost(entries, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const results = await probeAll(entries, timeoutMs);
  return results.find((r) => r.reachable) || null;
}

// ★ 只留 `probeAll` —— 用例踩的是它。`DEFAULT_TIMEOUT_MS` / `probeHost` /
//   `pickHost` 只在本文件内被用（`probeAll` 与 `pickHost` 各自调 `probeHost`）。
module.exports = { probeAll };
