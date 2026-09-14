# 变更日志

本文件记录 Slurmate 的显著变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
