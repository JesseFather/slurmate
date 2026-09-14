'use strict';
/**
 * hosts.js —— 登录节点地址表与并发探测。
 *
 * 为什么要支持【多个】地址，而不是一个：
 *   同一个登录节点常有多个入口 —— 内网地址、内网备用地址、公网域名、跳板机。
 *   写死一个的后果是换个网络环境就连不上，而用户看到的只是一句「连接失败」。
 *   所以这里探测一【组】地址，按 priority 取第一个可达的。全部不可达时
 *   把每个地址的失败原因都报出来，而不是给一句笼统的错误。
 *
 * 地址从哪来：
 *   **不在代码里**。每个部署的登录节点都不一样，写死在源码里等于把某个
 *   站点的拓扑发布出去。由使用者在客户端设置里填写，存进本地配置的
 *   `extraHosts`（见 config.js）。仓库里附了一份 `hosts.example.json` 说明格式。
 *
 * 探测方式：TCP 连上以后**读 SSH banner**（`SSH-2.0-...`），而不是只做 TCP connect。
 * 只连不读的话，任何在这个端口上监听的东西都会被判成「登录节点可达」—— 一个端口转发
 * 中间盒、一个防火墙的 REJECT-then-accept，都会给出假绿。
 */

const net = require('net');

/**
 * 内置地址表 —— **有意为空**。
 *
 * 这里曾经写死过某个集群的三个登录地址。那是站点的私有拓扑，不该随源码分发；
 * 而且写死之后，别人 fork 走也只能连到那个集群，等于既泄露又无用。
 * 需要默认地址的部署，请让使用者在设置里填，或直接改这个数组。
 */
const BUILTIN_HOSTS = [];

const DEFAULT_TIMEOUT_MS = 2500;

/**
 * 探测单个地址：TCP 连接 + 读 SSH banner。
 * @returns {Promise<{host,port,label,priority,reachable:boolean,rttMs:number|null,
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
 * 调用方自己决定失败怎么展示 —— 界面需要能在全部失败时告诉用户「三个地址都不通」，
 * 而不是只显示一个笼统的错误。
 */
async function probeAll(hosts, timeoutMs = DEFAULT_TIMEOUT_MS) {
  // 注意这里的判据是 `hosts === undefined` 而不是 `hosts.length`：
  // 调用方显式传一个【空数组】是在说"就是没有地址"，那是一个真实状态
  // （用户还没配），必须如实返回空列表让界面去提示。
  // 若按 length 回退到内置表，空配置会被静默替换成别的地址 —— 用户改了配置
  // 却看不到任何变化，是典型的"配置没生效但没人报错"。
  const src = hosts === undefined ? BUILTIN_HOSTS : hosts;
  const list = (Array.isArray(src) ? src : [])
    .map((h, i) => ({ ...h, priority: Number.isFinite(h.priority) ? h.priority : i + 1 }));
  const results = await Promise.all(list.map((h) => probeHost(h, timeoutMs)));
  return results.sort((a, b) => a.priority - b.priority);
}

/** 选第一个可达的地址。全不可达时返回 null。 */
async function pickHost(hosts, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const results = await probeAll(hosts, timeoutMs);
  return results.find((r) => r.reachable) || null;
}

/**
 * 组装实际要探测的地址表：内置表 + 用户配置里的 extraHosts。
 *
 * 这个函数存在的意义是把"哪些地址该探"收敛到一处。早先在 index.js 里
 * 就地拼过 `extraHosts.length ? BUILTIN.concat(extra) : BUILTIN`，
 * 结果"用户配了空列表"和"用户没配"走了两条不同的路，而两者本该等价。
 */
function effectiveHosts(extraHosts) {
  const extra = Array.isArray(extraHosts) ? extraHosts : [];
  return BUILTIN_HOSTS.concat(extra);
}

module.exports = {
  BUILTIN_HOSTS, DEFAULT_TIMEOUT_MS,
  probeHost, probeAll, pickHost, effectiveHosts,
};

