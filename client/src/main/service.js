'use strict';
/**
 * service.js —— 一个会话提供的是**哪一种服务**。
 *
 * 两种，平级，一次会话只可能是一种（服务端与作业侧都按「一次分派」实现，
 * 见 cluster/run.sbatch 的 start_service）：
 *
 *   code-server  VS Code 的网页版，客户端内嵌一个 WebContentsView 显示它，
 *                并自动 POST /login 登录。
 *   sshd         计算节点上、**在作业的 cgroup 里**的一个用户态 sshd。
 *                客户端什么都不显示，只把隧道指过去，然后把本地 ssh 配好，
 *                让用户自己的 VS Code Remote-SSH / codex 去连。
 *
 * ⚠️ 这两个值必须与 `cluster/slurmate-sessiond` 的 SVC_CODE_SERVER / SVC_SSHD
 *    逐字一致。它们躺在 `SLURMATE_SERVICE_KIND` 这个环境变量里过一次 Slurm，
 *    拼错不会报错，只会让作业走 `*)` 那个兜底分支。
 */

const SERVICE_CODE_SERVER = 'code-server';
const SERVICE_SSHD = 'sshd';

/**
 * 「服务种类未知」。**不是**一个能提交的服务，只是客户端内部的一个判定结果：
 * 守护进程明确说了「不知道」（会话是从 nft 规则里恢复出来的，见下面 serviceRoute）。
 */
const SERVICE_UNKNOWN = 'unknown';

/**
 * 中转站的 ssh 主机别名。
 *
 * ★ 它**恒定不变**，这正是整个中转站功能的立足点：作业每次落在哪个计算节点、
 *   哪个端口，都是浮动的、用户看不见也不该关心的；而 codex 那边配的
 *   `Host slurmate` 永远不用改。所以：
 *     - 别名不随连接变（换了登录节点也还叫 slurmate —— 同一时刻只可能有一个会话，
 *       所以「slurmate 指向当前这个中转站」始终是明确的）
 *     - 别名不随端口变（端口写在配置文件的 Port 那一行，由客户端改写）
 *
 * 这与 code-server 的处境**恰好相反**：那边端口就是 origin，端口一变浏览器
 * localStorage 里的编辑器布局就重置，所以那边必须把端口钉死。
 */
const SSH_ALIAS = 'slurmate';

/**
 * 这次会话该走哪条路。
 *
 * 三种输入要分开处理，因为它们**各自是真的**：
 *
 *   'sshd' / 'code-server'  守护进程明确告诉了我们是哪种。
 *   undefined               守护进程**没有这个字段** —— 部署的还对不上（滚动升级期间
 *                           客户端先更新、守护进程还是旧的）。那时候集群上只可能
 *                           有 code-server 的会话（sshd 是这个版本才有的、且要站点
 *                           显式开启），所以按 code-server 走与升级前的行为一致。
 *                           不这样兜的话，升级客户端会让**所有**已有会话都变成
 *                           「服务类型未知」，用户眼前的功能凭空消失。
 *   null                    守护进程明确说了「不知道」：从 nft 规则恢复出来的会话，
 *                           规则里没有任何东西能说明那个端口上跑的是什么。
 *
 * ★ 最后一种**绝不能猜**。猜 code-server 会拿口令去 POST 一个 SSH 端口（弹出
 *   「自动登录失败」，语义完全错误）；猜 sshd 会拿主机公钥去配一个 HTTP 端口
 *   （用户敲 `ssh slurmate` 得到一句莫名其妙的错误）。两种猜法都是系统声称了
 *   一件它并不知道的事，所以这里返回 'unknown'，由界面如实说出来。
 *
 * @param {string|undefined|null} raw 会话视图里的 service_kind
 * @returns {'code-server'|'sshd'|'unknown'}
 */
function serviceRoute(raw) {
  if (raw === SERVICE_SSHD) return SERVICE_SSHD;
  if (raw === SERVICE_CODE_SERVER) return SERVICE_CODE_SERVER;
  if (raw === undefined) return SERVICE_CODE_SERVER;   // 老守护进程没这个字段
  return SERVICE_UNKNOWN;
}

module.exports = {
  SERVICE_CODE_SERVER, SERVICE_SSHD, SERVICE_UNKNOWN,
  SSH_ALIAS, serviceRoute,
};
