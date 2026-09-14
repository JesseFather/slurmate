'use strict';
/**
 * backend-ssh.js —— 真实后端（ssh2）。
 *
 * ⚠️ 本阶段【尚未实现】。`isImplemented()` 返回 false，客户端会因此使用演示后端，
 *    并在界面三处标注「演示模式 · 未连接集群」。
 *
 * 这里写下的是下一阶段要照着填的骨架，以及实现时必须遵守的约束 —— 每一条都对应
 * 一个已经踩过或差点踩到的坑，不是泛泛的注意事项。
 *
 * ── 实现顺序（每步都要先证明前一步成立）──────────────────────────────────
 *
 * 0. **先做 Phase 0 实测**，用系统 ssh 五分钟就能验完，不成立则整个方案作废：
 *
 *      # 假设 A：sshd 的 ForceCommand（若你的集群装了）放行固定 argv 的 slurmate rpc
 *      ssh -T -p 10100 user@<登录节点> -- /usr/local/bin/slurmate rpc <<< '{"op":"ping"}'
 *      #   期望：恰好一行 JSON，ok:true，退出码 0。
 *      #
 *      #   背景：有些集群会给普通用户的 sshd 装一个 ForceCommand 拦截器来管
 *      #   code-server 的端口。这类拦截器通常是 fail-open 的（命令串里不含
 *      #   code-server 字面量就直通），所以固定 argv 的 `slurmate rpc` 应当能过 ——
 *      #   但这是【依赖】，必须实测证明，不能假设。有额外输出就是没直通。
 *
 *      # 假设 B：ForceCommand 不影响 direct-tcpip 转发
 *      ssh -N -L 18080:<tunnel_target> user@<登录节点> -p 10100 &
 *      curl -i http://127.0.0.1:18080/healthz     # 期望 200
 *
 * 1. 固定 argv 的 RPC：`exec('/usr/local/bin/slurmate rpc')`，请求体走 **stdin**。
 *    argv 是编译期常量，用户输入永远不出现在命令串里 —— 这既是防注入，也是穿过
 *    guard 的必要条件（命令里不能出现 code-server 字面量）。
 *
 * 2. 三态错误分类：必须能区分
 *      - 传输层失败（channel 关闭但没有 exit 事件 / stdout 空 / 不是合法 JSON）
 *      - 守护进程不可达（JSON 里 code=5 且 kind=daemon_unreachable）
 *      - 守护进程说了不行（其余 ok:false）
 *    → 交给 classify.js，不要在这里自己判断。
 *
 * 3. `forwardOut('127.0.0.1', 0, host, port)` 做隧道。
 *    **host 必须是守护进程给的 tunnel_target 里那个字面 IPv4，禁止再解析节点名。**
 *    解析结果与 nft 的 ip daddr 不一致会导致 ACL 静默失效
 *    （cluster/slurmate-sessiond:1674-1680 对此有强措辞的注释）。
 *
 * 4. `hostVerifier`：ssh2 **默认不校验主机密钥**。要么从用户的 ~/.ssh/known_hosts
 *    播种指纹（零新增摩擦），要么在设置里让用户确认一次。不做的后果是裸奔。
 *
 * 5. 保活与重连：`keepaliveInterval: 10000, keepaliveCountMax: 6`；断线指数退避重连
 *    （1s → 2s → 4s → … 上限 30s）。重连期间 `tunnel.js` 会关掉本地监听，让浏览器
 *    拿到 ECONNREFUSED 而不是永远 pending。
 *
 * ── 关于轮询频率（接入时必须定）─────────────────────────────────────────
 *
 * 一次 RPC = 一个 exec channel = sshd fork + PAM session + bash + python3 冷启动，
 * 乐观估计 250–400ms。而守护进程是**单线程同步**的（cluster/slurmate-sessiond:944-960
 * 先 tick() 再 select，:1518 同步处理连接），tick 里的 phase_running 会为所有用户的
 * 所有会话各 fork 一次 squeue。所以高频轮询是在给这个循环加压，受害的是所有人。
 *
 * 稳定态下不需要高频：tunnel_target 拿到后就不会变，心跳 30–60s、status 30–60s 足够。
 * **只有「等待登记」那一段需要密集轮询**，推荐方案是给 `slurmate rpc` 加一个
 * `--stream`（读到 EOF 才退出）—— argv 仍是常量，150 个 channel 压成 1 个。
 * 那需要改 cluster/slurmate 并重新部署，接入时定。
 *
 * ── 提交（submit）的特殊约束 ────────────────────────────────────────────
 *
 * `op_submit` **非幂等**：每次调用都 os.urandom 新 sid、插新行、提交新作业
 * （cluster/slurmate-sessiond:1767-1895）。而 count_active 只数 ACL_STATES，
 * ST_SUBMITTED 不在内 —— max_active_per_user=1 **拦不住第二个**（上限退化为
 * max_pending_per_user=4）。所以：
 *   - 超时必须 ≥ 45s（比 CLI 内部的 40s socket timeout 长），
 *   - **超时绝不重试**，改为调一次不带 session_id 的 status 去认领已创建的会话。
 * 见记忆 cluster-side-defects 的 F14。
 */

const { Backend, KIND } = require('./backend.js');

/** 本阶段未实现。改成 true 之前，上面 0–5 每一条都要先被实测证明。 */
function isImplemented() {
  return false;
}

class SshBackend extends Backend {
  constructor() {
    super();
    this.kind = KIND.SSH;
    this.label = '登录节点';
    this._conn = null;
  }

  async connect() {
    return {
      ok: false,
      error: '真实 SSH 后端尚未实现（下一阶段）。本阶段请使用演示模式。',
    };
  }

  async rpc() {
    return {
      ok: false, code: null, data: null,
      error: { kind: 'not_implemented', detail: '真实 SSH 后端尚未实现' },
    };
  }

  async dial() {
    throw new Error('真实 SSH 后端尚未实现');
  }
}

module.exports = { isImplemented, SshBackend };
