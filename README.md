<img src="client/src/renderer/icon.svg" width="72" height="72" alt="">

# Slurmate

Slurmate 是 Slurm 集群的服务基座。插件决定作业里跑什么；身份、端口、网络放行、
生命周期与插件分发由基座负责，用户在自己的电脑上像用桌面软件一样使用作业里的服务。

作业是唯一的生命周期锚点：网络放行按作业登记，不按 SSH 会话。SSH 闪断、关掉客户端、
换一台电脑，作业与访问都还在。

插件是独立项目：自己的版本、自己的签名者、自己的发布节奏。基座仓库里一棵都不收录，
两端都不带，一个都不装也是正常状态。

## 能做到什么

| 能做到 | 怎么做到 |
|---|---|
| 作业里跑任何长驻服务 | 插件声明端口、界面、登录方式、资源与并发；基座不认识具体服务 |
| 登录节点上的其他人连不上这个端口 | 每个作业一条 nftables 规则，随作业生灭 |
| 断线不等于结束 | 作业由守护进程提交，不挂在任何人的 SSH 会话上；闪断 5 分钟、异常退出 30 分钟 |
| 多台电脑看同一个作业 | 显式接管，只改会话归属，不连坐那台电脑上别的作业 |
| 插件从站点分发 | 包可以带签名，站点按 id 钉住签名者；每个插件第一次都要用户同意 |
| 站点一个文件装完 | 守护进程、CLI、作业模板、自检、卸载与回滚都在一个 `.run` 里 |
| 插件作者只写插件 | 打包器单文件零依赖：打包、签名、验签、血统与版本账本 |

## 组成

| 单元 | 是什么 | 谁拿 | 从哪来 |
|---|---|---|---|
| 客户端 | Electron 桌面应用：提交、等待、建隧道、按插件清单登录 | 用集群的人 | [Release](https://github.com/JesseFather/slurmate/releases) 上的三平台安装包 |
| 站点端 | root 守护进程、用户 CLI、作业模板、部署脚本 | 站点管理员 | 同一页上的 `slurmate-site-<版本>.run` |
| 打包器 | 把插件打成 `.splug` 的单文件工具 | 插件作者 | 仓库里的 [`packer/`](packer) |
| 插件 | 决定作业里跑什么 | 站点 | 独立项目；站点装包之后分发到客户端 |

## 架构

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

## 能用到什么程度

| 部分 | 现在到哪一步 |
|---|---|
| 集群侧 | 单文件包在真实 Slurm 集群上装完过；守护进程在 systemd 下运行；自测不需要 Slurm |
| 客户端 | 提交、等待、隧道、插件界面、接回、释放都在真站点上走过；站点分发与版本升级也走过 |
| 还没有的 | 只有真机能回答的那些 —— `--doctor` 的真实输出、带型号的 GRES、大包余量。全在 [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) 的〈没有完整实测过的〉 |

## 怎么开始

### 用集群

从 [Release](https://github.com/JesseFather/slurmate/releases) 取本平台的安装包。
新建连接，填登录节点、用户名与端口；把客户端生成的公钥交给管理员注册一次；连接。

### 装站点

同一页取 `slurmate-site-<版本>.run`。先 `sudo bash slurmate-site-<版本>.run --check` 看环境，再按
[cluster/docs/DEPLOYMENT.md](cluster/docs/DEPLOYMENT.md) 走。前置条件是硬性的：
单一登录节点、共享家目录、root 要有 Slurm operator 权限。

### 改仓库、写插件

改仓库见 [CONTRIBUTING.md](CONTRIBUTING.md)。写插件见
[packer/README.md](packer/README.md) 与 [packer/docs/README.md](packer/docs/README.md)。

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
