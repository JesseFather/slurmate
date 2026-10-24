<img src="client/src/renderer/icon.svg" width="72" height="72" alt="">

# Slurmate

[![checks](https://github.com/JesseFather/slurmate/actions/workflows/checks.yml/badge.svg)](https://github.com/JesseFather/slurmate/actions/workflows/checks.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Slurm 集群的服务基座：作业里运行的任何服务，都可以成为一个桌面入口。

插件决定作业里运行什么；身份、端口、访问控制、生命周期与分发由基座负责。

[下载](https://github.com/JesseFather/slurmate/releases) · [文档](docs/README.md) · [架构](docs/ARCHITECTURE.md) · [协议](docs/PROTOCOL.md) · [安全](SECURITY.md) · [贡献](CONTRIBUTING.md)

## 为什么

Slurm 把算力交给作业，却不负责把作业里的服务交给用户。作业运行之后，用户与服务
之间仍隔着登录节点、端口、隧道，以及一条不能中断的 SSH 会话。

Slurmate 把这一层从 SSH 会话上解耦，挂到作业上。访问登记、端口分配、服务身份与
生命周期随作业走；作业在，入口就在，与用户从哪台机器、哪条连接进来无关。

基座里没有任何一个服务的名字。作业里运行什么、界面是什么样、要不要登录，全部由
插件声明；集群能提供的能力因此可以持续扩展，而不必每增加一种服务就改动基座。

## 特点

- **一切皆插件** —— 服务实现、界面、登录方式与资源声明都在插件里；基座只提供契约与运行时。
- **作业是唯一的锚点** —— 访问登记随作业建立与回收；SSH 只是通道，不是生命周期的载体。
- **没有 Web 后端** —— 不新增域名、证书或常驻门户；客户端经 SSH 直连集群。
- **服务种类不设限** —— 网页界面、无界面、需要公钥的服务，共用同一条契约。
- **插件是独立生态** —— 自己的版本与签名者；站点分发，逐个同意后才运行。
- **一个客户端，多台站点** —— 连接列表可以并存多个集群；切换活跃连接不停止正在运行的作业。
- **多台电脑接管同一个作业** —— 显式动作，不影响该机器上的其他会话。
- **资源在连接时选择** —— 插件给出默认的 CPU、内存与时限；分区与 GRES 在界面上选定。
- **单文件部署** —— 一个 `.run` 完成安装，可自检、可回滚、可卸载。

## 它不是什么

- **不是 SSH 转发的包装** —— 作业由 root 守护进程提交，不依附于任何 SSH 会话。
- **不是调度器** —— 不排队、不分配节点；调度仍然只由 Slurm 做。
- **不限定服务类型** —— 开发环境、终端、内部工具，或任何其他长驻服务。
- **不需要改动 Slurm** —— 只使用它已有的提交、查询、续期与取消。

## 组成

| 部分 | 是什么 | 谁使用 |
|---|---|---|
| 客户端 | Electron 桌面应用：提交、等待、建立隧道、按插件清单登录 | 使用集群的人 |
| 站点端 | root 守护进程、用户 CLI、作业模板、部署脚本 | 站点管理员 |
| 打包器 | 把插件打成 `.splug` 的单文件工具 | 插件作者 |
| 插件 | 决定作业里运行什么 | 站点，并经由站点分发到客户端 |

## 它是怎么工作的

```
  客户端（用户的笔记本）
    │
    │  SSH：固定 argv 的 RPC（一行 JSON 进、一行 JSON 出）
    │     + direct-tcpip 端口转发
    ▼
  登录节点
    ├── slurmate-sessiond（root，systemd）   ← 按作业维护 nft ACL、判活、续期、释放
    ├── /run/slurmate-session/ctl.sock       ← CLI 与守护进程的通道（SO_PEERCRED 认证）
    └── 共享家目录（NFS 或同类）
          ~/.slurmate/sessions/job-<id>.json  ← 会话身份、隧道目标、口令、插件的附加字段
    ▼
  计算节点（由 Slurm 在分区内自动挑选，不写 -w）
    └── sbatch 作业 → 插件起的服务，绑在 <节点IP>:<端口>
```

一次会话：

1. 客户端提交请求，守护进程以用户身份 `sbatch` 一个作业。
2. 作业在计算节点上挑选端口，插件把服务绑上去，写回会话文件。
3. 守护进程登记一条 nft 规则，客户端经 `direct-tcpip` 建立隧道。
4. 客户端打开插件的界面；断开、换机器都不影响作业与该规则。
5. 作业结束，规则随作业回收。

守护进程每 2 秒对账一次。Slurm 报告作业终止即拆除规则；规则被外部删除也会重建，
例如 `systemctl reload nftables` 会 flush 整个 ruleset。

各组件的职责划分见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 怎么开始

### 站点管理员

```bash
sudo bash slurmate-site-<版本>.run --check   # 只体检，不改动系统
sudo bash slurmate-site-<版本>.run           # 安装
```

安装包从 [Release](https://github.com/JesseFather/slurmate/releases) 获取。前置条件是
刚性的：单一登录节点、共享家目录、root 需要 Slurm operator 权限，详见
[cluster/docs/DEPLOYMENT.md](cluster/docs/DEPLOYMENT.md)。

### 使用集群

从同一页获取本平台的安装包。新建连接，填写登录节点、用户名与端口；客户端生成的
公钥交由管理员注册一次，随后连接。

### 插件作者

```bash
node packer/slurmate-packer.js init  my-plugin
node packer/slurmate-packer.js build my-plugin
```

契约见 [packer/docs/README.md](packer/docs/README.md)。

### 参与开发

```bash
cd client && npm ci && npm test             # 客户端：不需要 Electron 运行时
python3 cluster/test-sessiond-logic.py      # 站点端：不需要 Slurm
```

提交之前需要运行的检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 现在到哪一步

| 部分 | 状态 |
|---|---|
| 站点端 | 单文件包在真实 Slurm 集群上完成过安装；守护进程在 systemd 下运行；自测不依赖 Slurm |
| 客户端 | 提交、等待、隧道、插件界面、接回与释放均在真实站点上走通；站点分发与版本升级也已走通 |
| 尚未覆盖的 | 只有真实集群才能回答的部分 —— `--doctor` 的实际输出、带型号的 GRES、大包余量。全部记录在 [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) 的〈没有完整实测过的〉 |

## 文档

| 想做什么 | 对应的文档 |
|---|---|
| 部署站点、排障 | [cluster/README.md](cluster/README.md)，以及 [cluster/docs/](cluster/docs/) |
| 用客户端、看认证模型 | [client/README.md](client/README.md) |
| 写插件 | [packer/README.md](packer/README.md)、[packer/docs/README.md](packer/docs/README.md) |
| 看懂协议与契约 | [docs/PROTOCOL.md](docs/PROTOCOL.md)、[docs/CONTRACT.md](docs/CONTRACT.md) |
| 威胁模型与边界 | [SECURITY.md](SECURITY.md) |
| 已知问题与欠账 | [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) |

完整索引在 [docs/README.md](docs/README.md)。

## 仓库结构

```
cluster/          站点端：守护进程、CLI、作业模板、部署与打包脚本
  slurmate-sessiond        root 守护进程
  slurmate                 用户 CLI（客户端调用的 RPC 入口）
  run.sbatch               作业模板；安装时按插件各织一份
  install-base.sh          一键部署 / 卸载
  make-run.sh              打单文件包
  nft-compare.py           非干扰比对器
client/           Electron 桌面客户端
packer/           插件作者的打包器；在作者机器上运行，服务器上从不打包
docs/             实现者与维护者的文档，索引在 docs/README.md
tools/            部署前自检、检查器、符合性向量、测试夹具
.github/          CI：构建、发布、检查
```

## 常见问题

### 需要在计算节点上安装什么吗？

取决于插件。基座在计算节点上没有常驻进程；作业脚本只携带它需要的那一份插件。

### 用户需要安装什么？

一个客户端。插件只通过站点分发，连接后自动取回，首次使用需要在界面上同意。

### 不安装任何插件可以运行吗？

可以。基座照常启动，已有会话照常可以查询与停止，只是没有可提交的服务。

### 安全边界在哪里？

四条护栏与各自的缺口记录在 [SECURITY.md](SECURITY.md)；尚未完整实测的部分见
[docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)。

## 已知限制

- ACL 的固有边界：规则挂在登录节点的 output 链上，无法约束同一台计算节点上的共租户。
  见 [SECURITY.md](SECURITY.md) 的〈设计层面的已知边界〉。
- 产物未签名：Windows 首次运行会被 SmartScreen 拦截一次；macOS 首次需要右键打开。
- 站点分发的插件逐个需要同意。插件运行在独立进程中，但这不是沙箱：它仍有完整的
  Node 权限。见 [SECURITY.md](SECURITY.md) 的〈站点分发的插件：四条护栏的对账〉。
- 客户端只使用公钥认证，不实现身份管理（改密码、设邮箱、查账户）。见
  [client/README.md](client/README.md)。
- 已核实的缺陷、尚未完整实测的部分与结构性欠账，全部记录在
  [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)，按编号引用。

## 许可证

[Apache-2.0](LICENSE)。署名见 [NOTICE](NOTICE)，源文件头另有一份同款声明。
