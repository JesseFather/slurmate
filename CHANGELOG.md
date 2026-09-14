# 变更日志

本文件记录 Slurmate 的显著变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

> **这一版只有客户端。** 集群侧尚未实现下面的 v0.2 协议，也尚未修「已识别缺陷，
> 尚未修复」那一节里的三个问题 —— 因为它们全在 `cluster/` 下。**所以两边现在
> 通不了**：只升客户端的表现是 `submit` 返回 `bad_partition` 这类看起来像参数
> 写错的错误，而不是「协议不匹配」。版本号暂时不动（三处仍是 0.1.0），等集群侧
> 跟上再一起升到 0.2.0。

### Changed — **破坏性：RPC 协议 v0.2**（两端的版本必须一起升）

- **删掉「用途」这一层。** 配置里不再有 `[purpose:*]`；`purposes` op 改成
  `partitions`；`submit` 直接收 `cpus`/`mem`/`gpus`/`partition`/`time`，全部可选。
  理由：「用途 → 分区」是**策略**，而 Slurm 已经知道**事实**。多抄一份就多一处
  会与实际分叉、且分叉了没人会发现的副本。详见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。
- **缺省由服务端填**（2 核 / 8G / 从有权限的分区里随机挑一个）。客户端不自己编
  默认值 —— 否则一个改过的客户端省略字段就能要到整机。
- **客户端改用纯公钥认证，不再接受密码**，也不再读 `~/.ssh`。密钥由客户端生成并
  自托管，公钥在界面上可查可复制，用户注册一次。
- 客户端不再实现任何身份管理（改密码、设邮箱、查账户）。它从「账户已经配好了」
  开始 —— 别的集群未必用同一套身份体系。

### Fixed

- **`panel.html` 的内联 `style` 属性被自己的 CSP 静默丢弃**（`style-src 'self'`
  没有 `'unsafe-inline'`）。布局一律改用 class。
- **`backend-ssh.js` 的私钥解析失败会抛异常穿出「不抛异常」的契约**，在真机上
  表现为主进程一个没人处理的 rejection。现在返回 `bad_private_key`。
- `check-sanitized.sh` 的「无私钥」规则把 **PEM 头文本本身**也算命中，
  而 `keys.js` 是编码器、必须写出那个常量。不是放宽规则，而是让它表达真正想
  表达的东西（私钥**材料**），覆盖三种真实泄漏形态；并新增
  `tools/self-test-sanitized.sh` **反向验证**（真的种进三种形态，断言检查会红）。

### 已识别缺陷，尚未修复（全在集群侧）

排查过程中确认了三个真实缺陷，但**代码一行没改** —— 它们都在 `cluster/` 下，
而这一版只动客户端。写在这里是为了让它们别在排查记录里丢掉，**不是**说已经修了：

- **`cluster_cidr` 写窄会让全部 ACL 静默失效。** 基础规则 `ip daddr != CIDR accept`
  在链首、会话 drop 规则追加在链尾，所以 CIDR 漏掉某个节点时，那条流量会被链首
  放行，而策略是 accept —— 没有任何迹象。默认值还恰好是文档占位网段
  `192.0.2.0/24`，也就是「漏配」等于「静默无保护」。
  **现状**：`slurmate-sessiond:215` 默认值仍是 `192.0.2.0/24`，没有前缀长度校验，
  也没有与 `scontrol show node` 的 `NodeAddr` 交叉核对。要做的三件事一件没做。
- **配置文件里「留空则用 `shutil.which` 查找」是假的。** 代码里只有
  `or "/usr/bin/sbatch"` 硬兜底，且 `validate()` 会因它不存在而拒绝启动 ——
  Slurm 装在 `/opt/slurm/bin` 的集群照抄示例配置直接起不来。
  **现状**：全文无 `shutil`，`slurmate-sessiond:271` 原样未动。
  （附带一条实测：本集群的 Slurm 恰好装在 `/usr/bin`，所以这个缺陷在这里复现不出来，
  只在 `/opt/slurm/bin` 那类集群上才炸。）
- **`validate()` 漏查 `squeue` 与 `sacctmgr`**：这两个可以是错路径而启动通过，
  运行时才失败。**现状**：`slurmate-sessiond:325` 仍只查
  `sbatch`/`scancel`/`scontrol` 三个。

### Added

- **客户端真实 SSH 后端从骨架变成实现**（`client/src/main/backend-ssh.js`）。
  0.1.0 的头号已知限制就是「`isImplemented()` 返回 `false`，客户端一律落到演示后端」，
  这一条现在解除：密钥认证（`privateKey`）、固定 argv 的 exec channel、
  `forwardOut` 端口转发、多路复用一条连接。
  **但它从未在真实登录节点上跑过** —— 见下方「已知限制」。
- `tools/self-test-sanitized.sh` —— 脱敏检查的反向验证，已接入 CI
- CI 新增客户端测试作业（此前 99 个用例只在开发机上手动跑过，等于没有防线）
- `client/src/main/keys.js` —— 生成并封装 OpenSSH 格式密钥。
  ssh2 **不认** Node `crypto` 导出的 PKCS#8 PEM，必须手工拼 `openssh-key-v1`；
  正确性靠密码学断言（签名 → 原生验签）而不是「能解析」
- 主机密钥 TOFU 校验（已知放行 / 首次确认 / **变更即拒绝**）
- 客户端连接条目可增删，全部在界面上 —— 此前地址只能手改 `config.json`，
  而面板上根本没有入口

## [0.1.0] - 2026-09-14

**首个公开版本。**

### Added

**集群侧（`cluster/`）**

- `slurmate-sessiond` —— root 守护进程。通过 unix socket 提供 RPC，身份取自
  `SO_PEERCRED`；管理端口池、会话状态机与孤儿回收
- `slurmate` —— 用户 CLI。`rpc` 子命令从 stdin 读一行 JSON、向 stdout 写一行 JSON，
  一次一请求；命令行是编译期常量，不接受任何用户输入拼进去
- `run.sbatch` —— 作业模板。分配端口、以 `--auth password` 启动 code-server，
  把端口与口令登记进 0600 的会话文件
- `deploy.sh` —— 一键部署。幂等、只增不改，提供 `--check` / `--dry-run` 体检模式，
  并在部署前后对 nftables 规则集做结构化比对（比对器 `nft-compare.py` 带独立自测）
- `nft-compare.py` —— nftables 规则集结构化比对器
- `slurmate.conf.example` —— 配置示例：端口区间与保留区间、配额与限流、会话续期、
  `auth_mode`、心跳阈值
- `test-sessiond-logic.py` —— 守护进程单元/集成测试，在未安装状态下用临时目录运行

**核心设计**

- **网络 ACL 的登记簿挂在 Slurm 作业上，而不是 SSH 会话上** —— 这是本项目的核心
  改动，也是它存在的理由：SSH 闪断不再丢会话
- nft 规则按作业登记的端口放行，hook 点在登录节点的 output 链
- 会话续期：剩余时间低于阈值时按增量 `scontrol update` 续期，并有累计上限
- 心跳判活与孤儿回收：停止心跳 300 秒判 `suspect`（**什么都不做**，作业与 ACL 都
  保留，等网络恢复），1800 秒判 `orphaned` 并 `scancel`
- 配额与限流：每用户活跃/未决会话上限、RPC 速率限制、拒绝计数熔断

**客户端（`client/`）**

- Electron 桌面应用。单实例锁 + 会话槽位，多开不再互相打架
- 隧道中继：本地端口按槽位持久化（端口变了 origin 就变，编辑器布局会重置），
  只监听 `127.0.0.1`
- 快捷键接管：`Ctrl+W` / `Ctrl+N` / `F5` 交给页面，`F12` / `Ctrl+Shift+I` / `F11`
  由外壳吞掉；输入法组合期间放行
- 登录节点地址表与并发探测：TCP 连上后读 SSH banner 校验，按 `priority` 取第一个
  可达的；全部不可达时逐个报出失败原因
- 登录成败按 cookie jar 判定，不看 HTTP 状态码
- 演示后端：不是一个空壳，它包含真实的本地 HTTP 服务（复刻 code-server 的登录契约）
  与真实的 TCP 隧道转发，用来复现真集群上极难复现的状态 —— 守护进程挂掉、隧道断开、
  会话被回收

**安全**

- `auth_mode` 默认 `password`（作业自生成随机口令，写进 0600 会话文件），而不是
  `none`。原因与它为什么不该被改回，见 [SECURITY.md](SECURITY.md)
- 会话文件读取做完整硬校验：拒绝符号链接、必须是 regular file、属主必须匹配、
  mode 必须为 0600、大小上限 64 KiB、`nlink == 1`
- 守护进程从不用 root 写用户文件：口令与会话文件都由作业自己生成，家目录在
  systemd 单元里以只读方式挂载

### 已知限制

- **客户端真实 SSH 后端尚未实现。** `client/src/main/backend-ssh.js` 的
  `isImplemented()` 返回 `false`，客户端因此会改用**演示后端**启动，并在界面上标注
  「演示模式 · 未连接集群」。集群侧是完整的；缺的是客户端那一跳 SSH。
- **nft ACL 拦不住同一台计算节点上的共租户。** 这是架构边界，不是缺陷，已用
  `auth_mode = password` 默认值缓解。详见 [SECURITY.md](SECURITY.md)。
- **产物未签名。** Windows SmartScreen 与 macOS Gatekeeper 会拦，Linux 的 AppImage
  需要 `chmod +x`。消除这些提示需要代码签名证书。
- **`cluster_cidr` 只能写一个 CIDR。** 登录节点与计算节点必须落在同一个网段内，
  多网段集群目前无法表达。

[0.1.0]: https://github.com/JesseFather/slurmate/releases/tag/v0.1.0
