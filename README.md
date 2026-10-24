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

- **一切皆插件** —— 服务、界面与登录方式由插件声明；仓库不收录、两端不带，一个都不装也能运行。
- **作业是唯一的锚点** —— 访问登记随作业建立与回收；SSH 只是通道，断开不影响作业。
- **没有 Web 后端** —— 不新增域名、证书或常驻门户；客户端经 SSH 直连集群。
- **插件经站点分发** —— 独立版本与签名者；每个插件逐个同意后才运行。
- **多站点、多台电脑** —— 一个客户端并存多个站点；同一个作业可在另一台电脑上显式接管。
- **资源在连接时确定** —— 插件给出默认的 CPU、内存与时限；分区与 GRES 在界面上选定。
- **单文件部署** —— 一个 `.run` 完成安装，可自检、可回滚、可卸载。

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

安装包未签名：Windows 首次运行会被 SmartScreen 拦截一次，macOS 首次需要右键打开。

### 插件作者

```bash
node packer/slurmate-packer.js init  my-plugin
node packer/slurmate-packer.js build my-plugin
```

打包器随每个版本发布（`slurmate-packer-<版本>.js`），也可以直接用仓库里的
`packer/slurmate-packer.js`。契约见 [packer/docs/README.md](packer/docs/README.md)。

### 参与开发

```bash
cd client && npm ci && npm test             # 客户端：不需要 Electron 运行时
python3 cluster/test-sessiond-logic.py      # 站点端：不需要 Slurm
```

提交之前需要运行的检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。

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

## 许可证

[Apache-2.0](LICENSE)。署名见 [NOTICE](NOTICE)，源文件头另有一份同款声明。
