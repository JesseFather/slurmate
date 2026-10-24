<img src="client/src/renderer/icon.svg" width="72" height="72" alt="">

# Slurmate

[![checks](https://github.com/JesseFather/slurmate/actions/workflows/checks.yml/badge.svg)](https://github.com/JesseFather/slurmate/actions/workflows/checks.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Slurm 集群的服务基座：作业里跑什么由插件决定，身份、端口、访问控制、生命周期与
插件分发由基座负责。

[文档](docs/README.md) · [架构](docs/ARCHITECTURE.md) · [协议](docs/PROTOCOL.md) · [安全](SECURITY.md) · [贡献](CONTRIBUTING.md)

## 为什么

在计算节点上开一个开发环境，今天是一条把三层生命周期绑死的命令：SSH 会话、srun 作业、
浏览器页面。会话一断，作业被杀、页面白屏、端口与口令一起作废。

Slurmate 只改了一件事：把「谁能连这个端口」的登记簿，从 SSH 会话挪到 Slurm 作业上。
作业活多久，保护就持续多久，与哪条 SSH 连接、哪台电脑都无关。

## 它能做什么

- **任何长驻服务** —— 插件声明端口、界面、登录方式、资源与并发；基座不认识具体服务。
- **按作业放行** —— 每个作业一条 nftables 规则，随作业生灭；登录节点上的其他用户连不上。
- **断线不等于结束** —— 作业由守护进程提交；闪断 5 分钟什么都不做，30 分钟才判异常退出。
- **多台电脑看同一个作业** —— 显式接管，只改会话归属，不连坐那台电脑上别的作业。
- **插件从站点分发** —— 包可以带签名，站点按 id 钉住签名者，每个插件第一次都要用户同意。
- **站点一个文件装完** —— 守护进程、CLI、作业模板、自检、卸载与回滚都在一个 `.run` 里。
- **插件作者只写插件** —— 打包器单文件零依赖：打包、签名、验签、血统与版本账本。

## 它不是什么

- **不是 SSH 转发的包装** —— 作业由 root 守护进程提交，不挂在任何 SSH 会话上。
- **不是网页门户** —— 客户端是桌面应用，服务的界面在客户端里打开。
- **不绑定某一种服务** —— 开发环境、终端、内部工具，或者别的任何长驻服务。
- **不需要改 Slurm** —— 只用它已有的提交、查询、续期与取消。

## 组成

| 部分 | 是什么 | 谁拿 |
|---|---|---|
| 客户端 | Electron 桌面应用：提交、等待、建隧道、按插件清单登录 | 用集群的人 |
| 站点端 | root 守护进程、用户 CLI、作业模板、部署脚本 | 站点管理员 |
| 打包器 | 把插件打成 `.splug` 的单文件工具 | 插件作者 |
| 插件 | 决定作业里跑什么 | 站点，以及被站点分发到的每台客户端 |

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

每个作业对应一条 nft 规则，守护进程每 2 秒对账一次。Slurm 说作业没了就拆规则；
规则被人删了也重建，例如 `systemctl reload nftables` 会 flush 整个 ruleset。

各组件的职责划分见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 怎么开始

### 站点管理员

```bash
sudo bash slurmate-site-<版本>.run --check   # 只体检，不改动系统
sudo bash slurmate-site-<版本>.run           # 安装
```

包从 [Release](https://github.com/JesseFather/slurmate/releases) 取。前置条件是硬性的：
单一登录节点、共享家目录、root 要有 Slurm operator 权限，详见
[cluster/docs/DEPLOYMENT.md](cluster/docs/DEPLOYMENT.md)。

### 用集群的人

从同一页取本平台的安装包。新建连接，填登录节点、用户名与端口；把客户端生成的公钥
交给管理员注册一次；连接。

### 插件作者

```bash
node packer/slurmate-packer.js init  my-plugin
node packer/slurmate-packer.js build my-plugin
```

契约见 [packer/docs/README.md](packer/docs/README.md)。

### 改这个仓库

```bash
cd client && npm ci && npm test             # 客户端：不需要 Electron 运行时
python3 cluster/test-sessiond-logic.py      # 站点端：不需要 Slurm
```

提交之前要跑的检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 现在到哪一步

| 部分 | 状态 |
|---|---|
| 站点端 | 单文件包在真实 Slurm 集群上装完过；守护进程在 systemd 下运行；自测不需要 Slurm |
| 客户端 | 提交、等待、隧道、插件界面、接回、释放都在真站点上走过；站点分发与版本升级也走过 |
| 还没有的 | 只有真机能回答的那些 —— `--doctor` 的真实输出、带型号的 GRES、大包余量。全在 [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) 的〈没有完整实测过的〉 |

## 文档

| 想做什么 | 读哪份 |
|---|---|
| 装站点、排障 | [cluster/README.md](cluster/README.md)，以及 [cluster/docs/](cluster/docs/) |
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
packer/           插件作者的打包器；在作者机器上跑，服务器上从不打包
docs/             实现者与维护者的文档，索引在 docs/README.md
tools/            部署前自检、检查器、符合性向量、测试夹具
.github/          CI：构建、发布、检查
```

## 常见问题

### 需要在计算节点上装什么吗？

取决于插件。基座在计算节点上没有常驻进程，作业脚本只带它需要的那一份插件。

### 用户要装什么？

一个客户端。插件只有站点分发这一条来路，连上之后自动取回，第一次要在界面上同意。

### 一个插件都不装能用吗？

能。基座照常启动，已有会话照常能查能停，只是没有可提交的服务。

### 安全边界在哪？

四条护栏与它们各自的缺口写在 [SECURITY.md](SECURITY.md)；没有完整实测过的部分见
[docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)。

## 已知限制

- ACL 的固有边界：规则挂在登录节点的 output 链上，拦不住同一台计算节点上的共租户。
  见 [SECURITY.md](SECURITY.md) 的〈设计层面的已知边界〉。
- 产物未签名：Windows 首次运行会被 SmartScreen 拦一次，macOS 首次要右键打开。
- 站点分发的插件要逐个同意。插件跑在独立进程里，但那不是沙箱：它仍有完整的
  Node 权限。见 [SECURITY.md](SECURITY.md) 的〈站点分发的插件：四条护栏的对账〉。
- 客户端只用公钥认证，不实现身份管理（改密码、设邮箱、查账户）。见
  [client/README.md](client/README.md)。
- 已核实的缺陷、没有完整实测过的、结构性欠账，全在
  [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)。按编号引用。

## 许可证

[Apache-2.0](LICENSE)。署名见 [NOTICE](NOTICE)，源文件头另有一份同款声明。
