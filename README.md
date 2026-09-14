# Slurmate

在 Slurm 集群上跑 code-server，把网络 ACL 的登记簿**挂在作业上**而不是 SSH 会话上 ——
于是 SSH 闪断不再丢会话。

---

## ⚠️ 当前状态：尚未端到端可用

先说清楚，免得你花时间之后才发现：

| 部分 | 状态 |
|---|---|
| **集群侧**（守护进程 / CLI / 作业模板 / 部署脚本） | 代码完整，自测 103 项、比对器自测 23 项全过。**但从未在真实集群上跑过端到端流程** |
| **客户端**（Electron） | 界面与会话状态机完整，**真实 SSH 后端尚未实现**（`client/src/main/backend-ssh.js` 的 `isImplemented()` 返回 `false`）。现在启动会落到演示后端 |

也就是说：**现在把它装到集群上，客户端连不上**。集群侧本身可以手工用
`slurmate` CLI 驱动，但那条路径也还没有人实际走过一遍。

我们选择把它如实写在这里，而不是等你自己发现 —— 做了假后端却在界面上不标注，
正是这个项目一路在消灭的那类问题。

---

## 它要解决什么

现有的 code-server 用法通常是这样一条命令：

```bash
ssh -L <端口>:<节点>:<端口> -t "srun ... code-server --auth none"
```

三层生命周期被绑死在一起：SSH 会话、srun 作业、浏览器页面。后果是：

| 现象 | 根因 |
|---|---|
| SSH 闪断 → 页面白屏、工作区要重新加载 | 作业挂在 SSH 会话上，会话一断作业就被杀 |
| 端口靠用户自己拟 | 没有分配器，只在冲突时被拒绝 |
| 多开打架 | 本地端口与远端端口都靠人记 |
| `Ctrl+W` 直接关掉整个页面 | 用浏览器打开，浏览器抢走了编辑器的快捷键 |

Slurmate 的做法是把**作业**变成唯一的生命周期锚点：

- 作业由集群上的 root 守护进程提交，不挂在任何人的 SSH 会话上
- 网络 ACL（nftables）按作业维护：**作业活多久，保护就持续多久**
- 隧道断了、换电脑、关掉客户端，都不影响作业与登记
- 客户端断线后有两级容忍：5 分钟判"闪断"（**什么都不做**），30 分钟才判"异常退出"并回收

---

## 架构

```
  客户端（你的笔记本）
    │
    │  SSH：固定 argv 的 RPC（一行 JSON 进、一行 JSON 出）
    │     + direct-tcpip 端口转发
    ▼
  登录节点
    ├── slurmate-sessiond（root，systemd）   ← 按作业维护 nft ACL、判活、续期、释放
    ├── /run/slurmate-session/ctl.sock       ← CLI 与守护进程的通道（SO_PEERCRED 认证）
    └── 共享家目录（NFS 或同类）
          ~/.slurmate/sessions/job-<id>.json  ← 会话身份、隧道目标、code-server 口令
    ▼
  计算节点（由 Slurm 在分区内自动挑选，不写 -w）
    └── sbatch 作业 → code-server --auth password --bind-addr <节点IP>:<端口>
```

核心是 **nft 规则与作业一一对应**。守护进程持有这份对应关系，每 2 秒对账一次：
Slurm 说作业没了，就拆规则；nft 规则被人删了（例如 `systemctl reload nftables`
会 flush 整个 ruleset），就重建。

各组件的职责划分见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 目录结构

```
cluster/          集群侧（部署到登录节点）
  slurmate-sessiond        root 守护进程
  slurmate                 用户 CLI（也是客户端调用的 RPC 入口）
  run.sbatch               作业模板（root 拥有，用户不可改）
  slurmate.conf.example    配置示例 —— 复制到 /etc/slurmate/slurmate.conf 再改
  deploy.sh                一键部署 / 卸载
  nft-compare.py           非干扰比对器（带自测）
  test-sessiond-logic.py   守护进程自测
client/           Electron 桌面客户端
docs/             架构、部署、配置、协议、排障
tools/            check-cluster.sh（部署前环境自检）、check-sanitized.sh（CI 用）
```

---

## 快速开始

### 跑一下客户端看看样子（不需要集群）

```bash
cd client
npm ci
npm run demo        # 演示模式：本地起一个假的 code-server，界面完整可用
```

演示模式会**真的**起一个本地 HTTP 服务复刻 code-server 的登录契约，并**真的**走一遍
隧道逻辑 —— 唯一被假掉的是 SSH 那一跳。界面与窗口标题会明确标注「演示模式」。

> **不要在 NFS/SMB 挂载的目录里跑 `npm ci`。** `node_modules` 是几万个小文件，
> 走网络文件系统会慢到不可用。先把仓库克隆到本地磁盘。

### 部署到集群

**先跑环境自检**，它会在你动手之前把不满足的条件列出来：

```bash
sudo bash tools/check-cluster.sh
```

然后按 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 走。**部署前请务必读那份文档的前置条件清单** ——
Slurmate 对集群形态有几个硬性要求（单一登录节点、登录与计算节点同网段、
共享家目录、root 有 Slurm operator 权限等），不满足时的失败方式往往很隐蔽。

```bash
sudo bash cluster/deploy.sh --check      # 只体检，不做任何改动
sudo bash cluster/deploy.sh              # 部署
```

---

## 设计原则

这个项目对**「系统报告成功，而事情没成」**有近乎偏执的关注。几乎每一处关键逻辑的
注释里都能看到它的影子：

- **部署脚本**在部署前后各取一次 nftables 规则集结构化快照，剥掉本系统新增的表之后
  必须逐条一致。比对器有 23 项独立自测 —— 因为它本身出错会给出**假绿**，
  而假绿比报错更危险。它甚至区分「文件真的没变」和「文件本来就不存在」，
  后者明确报告为**未参与校验**。
- **守护进程**把「作业查不到」分成三态：查到了 / 确认不存在 / **问不到**。
  早期实现把后两者合并，后果是 slurmctld 抖一次，所有活跃会话的 ACL 在一秒内
  全部消失、会话文件被删（再也无法重新登记），而作业还在跑。
- **客户端**用 `code-server-session` cookie 是否真的进了 cookie jar 来判断登录成败，
  **不看 HTTP 状态码** —— code-server 对错误口令返回的是 200。
- **文档**里每条约束都对应一个具体故障，而不是泛泛的"建议这样做"。

如果你要给它贡献代码，请保持这条线：**新增的检查必须能真的失败**。
一条永远通过的检查比没有检查更糟。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 已知限制

除开头说的「尚未端到端可用」之外：

- **ACL 的固有边界**：nft 规则的 hook 点是登录节点的 output 链，所以它拦得住
  "登录节点上的其他用户连你的端口"，但**拦不住同节点共租户直接 curl**。
  这就是默认 `auth_mode = password` 而非 `none` 的原因 —— 详见 [SECURITY.md](SECURITY.md)。
- **只支持单一 CIDR**：`cluster_cidr` 只能写一个网段，登录节点与计算节点必须在其中。
- **产物未签名**：Windows 首次运行会被 SmartScreen 拦，macOS 需要右键 →「打开」。
- **仅支持 code-server**：就绪判定依赖 `/healthz`，客户端登录依赖 `/login` 的字段名。
  换成别的 IDE 服务需要改作业模板与 `client/src/main/login.js`。
- **客户端只支持 SSH 口令认证**，没有密钥认证路径。

---

## 许可证

[Apache-2.0](LICENSE)
