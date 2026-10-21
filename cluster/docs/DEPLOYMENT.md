# Slurmate 部署指南

本文分两部分：前置条件（每一条都注明「不满足会怎样失败」）和部署流程。
前置条件全部从代码核实，不是经验之谈。

站点端交付的是一个文件 —— `slurmate-site-<版本>.run`。拷到登录节点（控制节点）
上，用 root 跑它即可：它自带守护进程、命令行、作业模板、systemd 单元、只读自检
脚本与这几份文档。

---

## 第一部分：前置条件

### 0. 建议先跑一次自检

```bash
sudo bash slurmate-site-<版本>.run --check
```

体检有两屏：第一屏跑包内的 `tools/check-cluster.sh`（下面这些环境事实），第二屏
跑部署预检。两屏都只读，唯一的写操作是在 `/root` 下留一份 nft 规则快照和一份报告。
第一屏查的正是那些「不满足也不会报错，只会在几小时后以奇怪的方式失败」的东西
（`tools/check-cluster.sh`）。

### 1. 单一登录节点，且 nft 规则挂在它的 output 链上

依据：`Nft.CHAIN = "output"`（`cluster/slurmate-sessiond`），链由守护进程在
自身所在主机上创建：`type filter hook output priority filter; policy accept;`
（`cluster/slurmate-sessiond`）。

不满足会怎样失败：多登录节点集群里，用户在 `node02` 登录时，`node02` 的
`inet slurmate output` 链上没有任何规则。用户本人不会有任何异常（那个
用户自己的流量本来就被 accept），但同节点其他用户可以直接连那个端口 —— 保护静默消失，
`slurmate doctor` 在 `node01` 上跑还会报「一致」。

怎么确认：在用户实际登录的那台机器上确认表与链存在：

```bash
nft list chain inet slurmate output
```

### 2. Slurm 报的节点地址是 IPv4

依据：会话的 ACL 规则（`ip daddr <节点IP> tcp dport <端口> … drop`）要一个字面
IPv4，权威来源是 `scontrol show node` 的 `NodeAddr=`。

`NodeAddr` 报主机名的集群今天用不了：`Slurm.node_ip()` 会退回
`scontrol show hostname` 去解析，解析不出 IPv4 就是 `None`，那台节点上的会话一条都
登记不上。

怎么确认：`tools/check-cluster.sh` 的〈登录节点地址〉那一节会打印
`NodeName=/NodeAddr=` 对照表，一眼看得出。

### 3. 共享家目录（NFS 或同类），并且支持服务端原子 rename

作业把会话文件写在 `~/.slurmate/sessions/job-<id>.json`，守护进程在登录节点上把它读出来
（`cluster/run.sbatch`，`cluster/slurmate-sessiond`）。这条链路有六层
要求，每一层的失败模式都不同。

3a. 家目录必须在登录节点与计算节点上都能看到

- 不满足：守护进程读不到会话文件。会话停在 `submitted`，到 `ENROLL_TTL`（默认
  1800 秒）超时后进 `releasing`、记 `expired`，作业被取消。作业一直在排队时
  上限换成 `QUEUED_TTL`（24 小时）。
- 必须取消的理由（`cluster/slurmate-sessiond` 的注释）：否则作业会白占节点到
  `TimeLimit`；而 `expired` 不在 `phase_running` 的扫描集合里，再没人回收它。
- 取消与拆除都在释放流程那一处做：它先确认作业真的停了，杀不掉就一直重试。
  所以「超时了但作业还在烧」表现为会话停在 `releasing`，不是静默消失。
- 用户看到的现象：界面一直停在「排队中 · 等待调度与登记」。

3b. rename 必须是原子的（NFSv4 的 RENAME 是服务端原子的）

作业侧用「写临时文件 + `mv -f`」落盘（`cluster/run.sbatch`），守护进程侧
要求常规文件、大小上限、`st_nlink == 1`。若底层实现让 rename 退化成非原子，
守护进程会读到半截文件并判 `bad_json`，于是每个 tick 重试一次直到 3a 的超时。
表现为登记被无限推迟，而不是立刻报错。

3c. NFS 属性缓存会影响登记延迟

默认 `acdirmax=60s`，目录属性最长缓存 60 秒 —— 会话登记最多延迟 60 秒。
`tools/check-cluster.sh` 从真实用户的家目录反推出共享存储的挂载根（它不写死任何
路径），检查那几个根有没有显式设置 `actimeo` / `acdirmax` / `acregmax`，没有就
给出 WARN。

这不是故障，但会让人误判：客户端在「等待登记」期间每 3 秒轮询一次
（`client/src/main/session.js`），用户很容易以为卡住了。想缩短首连体验就往挂载
参数里加 `actimeo=5` 之类的值。

3d. 家目录必须能由 uid 反查

守护进程取家目录的唯一途径是 `pwd.getpwuid(uid).pw_dir`
（`cluster/slurmate-sessiond`）。绝不拼「前缀 + 用户名」，两个独立理由：
用户名与目录名不保证一致；前缀本身也是站点配置。

- 不满足：`user_home()` 返回 `None` → 该用户所有涉及家目录的操作直接失败
  （`uid_unknown`）。

注意：很多集群的 NSS（SSSD/LDAP）没有开启枚举，`getent passwd` 全量列表里
只有本地账号。这不影响按 uid 直查（`getent passwd <uid>`），守护进程走的正是直查，
不做任何枚举（`tools/check-cluster.sh`）。

3e. 家目录在 systemd 下被挂成只读

这一条不需要站点报任何路径：单元里的 `ProtectSystem=strict` 把整个文件系统树挂成
只读，用户家目录自然盖在里面，只有 `/run/munge` 与守护进程自己那几个目录除外
（`cluster/slurmate-sessiond.service`）。

它在目标机器上行不行，由 `tools/check-cluster.sh` 第 8 节实测：那一节带着与单元
同一套指令起一个瞬时单元，跑 `scontrol ping`、把 munge 走一遍、`nft list`，并验
一次「该只读的写不进去、托管目录写得进去」。

3f. `.slurmate` 及其子目录必须私有

守护进程读会话文件与作业日志时，检查从 `.slurmate` 开始：`.slurmate`、
`.slurmate/sessions`、`.slurmate/logs` 的属主必须是本人或 root，且
`mode & 0o022 == 0`。家目录不查：它归用户处置，站点缺省可能是 `0775`。

- 客户端连上站点时会建出这三格并 `chmod 700`；作业脚本的兜底同样做一次。
  `mkdir -p` 只对新建生效，所以 `chmod` 是必须的那一半。
- 不满足：`load_session_file()` / `read_log_tail()` 返回
  `component_group_or_world_writable`，会话停在 `submitted`（界面显示
  「排队中 · 等待调度与登记」），到 `ENROLL_TTL` 超时后释放并取消作业。
- 手工修复：`chmod 700 ~/.slurmate ~/.slurmate/sessions ~/.slurmate/logs`。

### 4. root 需要 Slurm operator 权限

依据：续期用 `scontrol update JobId=<id> TimeLimit=+<增量>`
（`Slurm.renew()`，`cluster/slurmate-sessiond`）。注释写得很直白：
只有 root/Slurm 管理员能增加 `TimeLimit`，普通用户不行 —— 这就是为什么续期必须
是守护进程的职责。

不满足会怎样失败：`renew` 每次都返回失败，审计日志记 `renew_failed`，守护进程
只打一条 warning（`cluster/slurmate-sessiond`）。会话会在 `TimeLimit`
到期时被 Slurm 正常杀死 —— 用户正在编辑的内容随作业一起消失，而在此之前界面上
没有任何异常，只是「剩余时间」在稳步减少。

守护进程还必须能以 root 身份执行 `sbatch`（它用 `user=`/`group=`/`extra_groups=`
切到目标用户，`cluster/slurmate-sessiond`）、`scancel`、`scontrol`、
`sacctmgr`，以及只读的 `squeue` / `sinfo` / `sshare` / `sacct`。

后四个服务于客户端那一块「站点状态」与「最近作业」。它们都要能读：守护进程启动时
逐个校验它们的路径（`Config.validate()`），缺一个就拒绝启动。理由与另外几个相同 ——
错路径的失败形态在界面上长得像「这个集群没有节点 / 没有公平份额 / 没有历史」，
与真正的原因隔了好几层。

它们全都只读，这一块不改集群上的任何东西。

怎么确认：`slurmate doctor` 之外，直接看一眼续期是否真的在发生：

```bash
sudo journalctl -u slurmate-sessiond | grep -i renew
```

### 5. sshd 允许 direct-tcpip 转发，并允许用户的认证方式

依据：客户端的隧道走 SSH 的数据通道 —— 真实模式是 ssh2 的
`forwardOut(...)`（即 direct-tcpip），见 `client/src/main/backend-ssh.js`、
`client/src/main/tunnel.js`。同时客户端探测登录地址时会读 SSH banner
并校验 `SSH-2.0-` 前缀（`client/src/main/hosts.js`）。

- 不允许 `AllowTcpForwarding`：本地 `127.0.0.1:<槽位端口>` 仍然会监听成功
  （`tunnel.js` 先监听、再在每条连接上拨号），但每条连接拨号都失败 →
  隧道状态变 `down` → 界面弹出遮罩「隧道断开，正在重试」
  （`client/src/main/session.js`）。症状是「地址能打开，页面连不上」。
  若集群还配了 `PermitOpen`，同样会出现这个现象。
- 认证方式：客户端要用 `-o BatchMode=yes` 这类非交互方式建立连接
  （`client/src/main/backend-ssh.js`），所以用户必须已经能用密钥或已保存的
  口令完成认证。密钥认证缺失时，用户在客户端里会卡在连接阶段。

怎么确认：

```bash
sshd -T | grep -iE '^(allowtcpforwarding|permitopen|pubkeyauthentication|passwordauthentication)'
```

若集群在 sshd 上挂了 `ForceCommand` 守卫：`slurmate rpc` 的固定 argv 必须能穿过它
（某些集群的守卫只放行白名单里的命令名 —— 用固定 argv 恰好满足这个条件）。
这条依赖必须被证明而不是假设，Phase 0 的两步实测见
`client/src/main/backend-ssh.js`。

### 6. 计算节点上要有 `python3` / `ss` / `curl`，以及每个插件自己的可执行文件

分成两半：宿主的依赖（与哪个插件无关）和插件的依赖（跟着插件走）。

6a. 宿主的依赖 —— 作业模板自己要用

| 命令 | 用在哪 | 缺失后的表现 |
|---|---|---|
| `python3` | `cluster/run.sbatch` 的 `port_free()` 真正 bind 一次确认端口空闲 | 少一道校验，`ss` 看不到的占用会被漏掉 |
| `ss` | 同上，端口占用快查 | 退化为只靠 bind 探测（若 `python3` 也缺失，`port_free` 恒返回"空闲"） |
| `mktemp` | 建**私有**的节点本地日志目录（`0700`） | 没有可用的私有目录，插件预检失败 → 作业以 24 结束 |
| `date` | `log()` 的时间戳 | — |
| `/dev/urandom` 或 `openssl` | 生成会话口令 | **两者都拿不到时作业明确拒绝启动（`exit 23`）**，不会静默降级成 `auth=none` —— 静默降级恰好会移除唯一的实质保护 |

`port_free()` 里那两个探测都是 `command -v` 允许缺失的 —— 缺了只是少一道
校验，不是起不来。这是刻意的：把一个"更好的校验"变成硬依赖，会让一个本来能跑的
集群装不上。

6b. 插件的依赖 —— 由装了的那些插件决定

这一段没有固定清单，因为计算节点上需要什么完全取决于装了哪些插件。
每个插件在它自己的 README 里写清楚：要哪些可执行文件、缺了会怎样 ——
装之前看一眼那一节，比事后对着日志里那句"所有候选端口均失败"猜要省事。

那些表里有一个共同的形状值得先知道：插件自己检查的那个可执行文件缺了会
当场点名（"$bin 不存在或不可执行"），而只被探测步骤用到的工具（`curl` 那一类）
缺了不会明确报错 —— 每个候选端口都白等到超时（默认 6 个候选共约 4.5 分钟）。

插件脚本自己负责把"缺了"说清楚。宿主只会在日志里记一句"所有候选端口均
失败"—— 那句指不回是哪个可执行文件不见了。所以每个插件的 `start_<短名>` 里都有
一条显式的存在性检查（`[[ -x "$bin" ]] || { log "错误：$bin 不存在或不可执行"; return 1; }`）。

`bin` 的解析发生在登录节点上。守护进程按插件清单里的 `site.bin` 解析出路径再传给
作业（`discovery` 是 `which` 或 `convention`），而作业跑在计算节点上。所以那个解析
只是推测。

`--check` 会把它解析到了哪里如实打印出来，装完之后值得照着看一遍。写错了只在
作业启动时暴露。

### 7. systemd + nftables + `nft -j`

- systemd：服务单元与 `StateDirectory` / `LogsDirectory` / `RuntimeDirectory`
  都依赖它。
- nftables：`install-base.sh` 要求 `nft list tables` 成功（`cluster/install-base.sh`）。
- `nft -j list ruleset` 必须可用：这是硬性要求，获取失败就拒绝部署
  （`cluster/install-base.sh`）。理由是没有这道校验就无法证明部署没有破坏现有
  规则集 —— 宁可现在拒绝，也不要事后给一个证明不了任何东西的绿灯。

注意 firewalld 与 nftables 并存的情况：`tools/check-cluster.sh` 会打印
两者的 active/enabled 状态；它也会检查 `/etc/nftables.conf`（RHEL 9 上是
`/etc/sysconfig/nftables.conf`）里有没有 `flush ruleset`。有的话见
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) 的「nft 规则消失」。

### 8. python3 ≥ 3.9

依据：`Slurm.submit()` 用 `subprocess.run(..., user=uid, group=..., extra_groups=...)`
（`cluster/slurmate-sessiond`），注释明确写着「Python 3.9+」。

不满足会怎样失败：3.8 及以下不认识这些关键字 → 抛 `TypeError` → 被
`except Exception` 捕获并返回 `(None, "提交失败: ...")` → `op_submit` 返回
code 6 `submit_failed`。每一次提交都失败，用户看到的是中文的提交失败提示。

部署脚本还会断言 `socket.SO_PEERCRED` 与 `sqlite3` 可用，缺一即中止
（`cluster/install-base.sh`）。

### 9. 其余预检项

「位置」那一列只有两个值，因为同一件事只允许有一个判据：凡是
守护进程自己判得了的（Slurm 命令齐备、`nft`、端口区间、`scontrol ping`、
`ip_local_reserved_ports`），都由 `install-base.sh`
调用 `slurmate-sessiond --check` 来判 —— 脚本里没有第二份实现。
只有基座安装自己的事（部署锁、哈希工具、目标路径占用）留在脚本里。

| 检查 | 位置 | 不满足的后果 |
|---|---|---|
| `sbatch` / `scancel` / `squeue` / `scontrol` 存在 | `slurmate-sessiond --check`（退出码 **2**） | 直接中止：「这台机器不像是 Slurm 登录节点」 |
| `scontrol ping` 成功 | `slurmate-sessiond --check`（只报，不打码） | 只警告。部署能完成，但提交与回收都会失败；守护进程的 `job_state()` 会把这种情况判为 `JOB_UNKNOWN` 并保持现状，**不会误释放会话** |
| `sha256sum` 存在 | `cluster/install-base.sh` | 直接中止（无法校验现有文件是否被改动） |
| `flock` 存在 | `cluster/install-base.sh` | 只警告，失去并发部署保护 |
| 目标路径未被别的文件占用 | `cluster/install-base.sh` | 直接中止，绝不覆盖不属于本系统的文件 |
| 端口池与 `reserved_ranges` 不交 | `slurmate-sessiond --check`（退出码 **1**） | 直接中止。跨表顺序在 nftables 里没有保证，重叠会让行为不可预测 |
| 端口池与 `ip_local_reserved_ports` 不交 | `slurmate-sessiond --check`（只报，不打码） | 只警告。作业脚本会跳过真被占的端口试下一个（`cluster/run.sbatch`），nft 规则匹配 `dport` 不受影响 |

退出码两档分工如下，部署脚本靠它决定"现在就停"还是"装完再判"。

- `2`：这台机器缺东西。一个字节都不装。
- `1`：这份配置写错了，停。读的是已装的那份、还是包里那份示例，都是这一档：示例
  配置过不了自检就是打包的问题。

机器级（`2`）先判：一台"机器缺东西"的机器上，一句"配置写错了"不该把它盖成别的意思。

### 10. `KillWait` 要够写墓碑

作业退出前必须在 `KillWait` 窗口内写完墓碑（`cluster/run.sbatch`），
Slurm 默认 30 秒。清理函数只做一件要紧事：写墓碑让守护进程立刻知道会话结束；
日志搬运放后台、绝不阻塞退出（`cluster/run.sbatch`）。

不满足会怎样失败：超时的后果是 SIGKILL，墓碑写不下去，会话要多等一个 orphan
周期（默认 1800 秒）才回收 —— 期间计算节点被白占。

### 11. SELinux（若启用）

`tools/check-cluster.sh` 会打印 `getenforce`、相关策略模块、最近 7 天的 AVC
拒绝，以及 `use_nfs_home_dirs` 等布尔值。Enforcing 状态下必须验证三件事：

1. 守护进程 setuid 到用户后还能执行 `sbatch`（域转换）；
2. 守护进程能通过 netlink 调 `nft`；
3. 守护进程能读 NFS 上的用户家目录。

另有一项最关键的实测：用 `systemd-run` 起一个带完整加固指令的瞬时
单元跑 `scontrol ping`，验证沙箱里 munge socket 与 nft 都还能用。加固指令一放宽
就是安全增量的损失，所以这一步值得做。

### 12. systemd 加固指令必须被这个 systemd 接受

`tools/check-cluster.sh` 用 `systemd-analyze verify` 真校验一遍计划使用的
全部加固指令，而不是等 systemd 在启动时报错。看到
`unknown key` / `failed to parse` / `invalid` 就要删掉对应指令再试。

---

## 第二部分：部署流程

下面每条命令都写成自解压包的样子。它与仓库里的 `cluster/install-base.sh` 是同一份
实现 —— 从源码树跑就把 `bash slurmate-site-<版本>.run` 换成
`bash cluster/install-base.sh`，动词与开关逐字相同。

### 步骤 0：把这一份包拷到控制节点上

这一份包会以 root 身份安装并执行里面的文件。它自己先把包体解压到一个 root 专属的
临时目录，再从那一个目录里跑安装器，所以源文件的拥有者与可写位天然是对的
（`cluster/run-header.sh`、`cluster/install-base.sh`）。

从源码树部署时另有一条自拷贝路径：源目录不属于 root、或者组/其他可写时，脚本先拷到
`/root/slurmate-src.XXXXXX`（源码位于 `/` 或 `/root` 时改用 `/var/tmp`，避免把目录
拷进自己里面）再重新执行（`cluster/install-base.sh`）。

那一条路是通的，但部署完记得清理 `/root/slurmate-src.*` —— 每次从非 root
拥有的目录部署都会留下一份拷贝。

> 若把 `cluster/` 挪到别的位置（例如把仓库结构改成 `src/cluster/`），
> 自拷贝分支里的路径也要跟着改 —— `SRC_DIR` / `PLUGINS_SRC` 那两个变量，
> 以及最后 `exec` 那一行。它们用的是相对于 `SECURE_DIR` 的位置，脚本名走
> `basename "$0"` 所以改名字不受影响，但子目录层级变了要同步。

### 步骤 0.5：把插件打成包（要装插件的话）

站点上铺开的是构建产物，不是一棵源码树。
服务器上从头到尾没有源码 —— 打包发生在作者的机器上：

```bash
# 在插件的源码树里（可以是另一个仓库）
node packer/slurmate-packer.js init  path/to/your-plugin     # 铸一个 id（只做一次）
node packer/slurmate-packer.js keygen path/to/your-plugin    # 想签名才需要（只做一次）
git commit -am "铸一个 id"
node packer/slurmate-packer.js build path/to/your-plugin     # → <id>.splug（落在源码树的上一层）
node packer/slurmate-packer.js sign  <id>.splug              # 可选，但见 PLUGIN-SPEC.md §6.4
```

把那几个 `.splug` 收集到一个目录，拷到登录节点上，然后装：

```bash
sudo slurmate plugin install --from ~/下载的插件
```

安装器永不打包，它只收成品。所以拿仓库顶层那几棵插件源码树当那个目录用是不行的：
那里没有 `.splug`，而它会逐条点名说"它不是一个插件包、不会被安装"并指路
`packer build`。

那个失败是刻意的：包是构建产物，不进 git。二进制进 git 等于代码评审死掉。

那棵树是开发样例，基座不带任何插件。它不是"仓库自带的插件"，所以这里没有一份
欠着的成品要补。

装插件不是部署的一部分 —— 基座装完之后随时可以装，装一个也不用重跑部署：

```bash
sudo slurmate plugin install ~/下载的插件/<id>.splug
```

它做四件事，每一件都会说给人听：验签（[PLUGIN-SPEC.md](../../packer/docs/PLUGIN-SPEC.md) §6.4）、
把包里有什么打一屏出来、
按 `(id)` 记住签名者（同一个 id 换了钥匙会停下来问）、装成
`<prefix>/share/slurmate/plugins/<ULID>/` 一棵树加 `<ULID>.json` 一份记录表。
装完它还会顺手做三件：写它那份
`slurmate.conf.d/<id>.conf`、织好作业脚本、让守护进程重读一遍配置 ——
全程不重启，正在跑的会话一条都不受影响。

服务器上没有源码可以对照，所以那一屏是管理员手上唯一的依据 —— 它也是这条
路上已知的取舍之一，见 `README.md` 的〈已知限制〉。

### 步骤 1：先 `--check`

```bash
sudo bash slurmate-site-<版本>.run --check
```

`--check` 承诺零改动：不安装文件、不启动服务、不改动 nftables，快照也只写到
`/tmp`（`cluster/install-base.sh`）。它把所有预检跑一遍并打印一份可存档的
报告 —— 警告与失败都走 stdout，就是为了让报告能整份重定向保存
（`cluster/install-base.sh`）。它跑的就是守护进程自己的 `--check`
（同一份判据），所以"预检放行、守护进程起不来"那种两套解释器的错配不会发生。

要体检一批包，用守护进程自己的 `--check-plugins`（还没装基座时，仓库里
那份也能跑）：

```bash
python3 cluster/slurmate-sessiond --check-plugins --plugins-dir ~/下载的插件
```

它会逐条点名目录里除 `.splug` 之外的任何东西 —— 那些东西不会被安装，
所以不在这里说的话就是静默忽略。

### 步骤 2：准备站点配置

`install-base.sh` 在配置不存在时安装 `slurmate.conf.example`
（`cluster/install-base.sh`）。配置已经存在时，它只对键、不动取值：这一版
不认的键删掉（安装输出会原样列出删掉了哪几行；这次部署一旦失败，整份配置
自动回到改动前），这一版新加、而文件里整节都没有的补到末尾（写成注释，
缺省不变）。

整份覆盖会把站点的调优悄悄抹掉，而故障要等下次重启守护进程才出现。

所以推荐两种顺序之一：

- 先部署，再编辑 `/etc/slurmate/slurmate.conf`，最后
  `sudo slurmate service reload`（改配置不需要重启；它会等守护进程报出接受还是拒绝）；
- 或先手动 `cp cluster/slurmate.conf.example /etc/slurmate/slurmate.conf` 改好再部署。

站点通用键一共 20 个，全部见 [CONFIGURATION.md](CONFIGURATION.md)；
没有哪一格是非填不可的（端口池与几个配额都有安全的默认值）。

插件要不要开、开哪几个，也在这一步决定。`enabled = yes` 的插件会被
分发到每一台连上来的客户端 —— 不只是"用户可以提交它"。所以
写一份插件配置现在是一个对外的动作：

```ini
# /etc/slurmate/slurmate.conf.d/<短名>.conf
enabled = yes          # ← 这一行同时也意味着"把它发到用户的工作站上"
```

一份插件配置都不写时按缺省行事（取插件清单里的 `site.defaultEnabled`），
所以升级本身不会静默多发一个插件出去。
逐条见 [CONFIGURATION.md](CONFIGURATION.md) 的〈一之二、插件配置〉。

### 步骤 3：演练（可选但推荐）

```bash
sudo bash slurmate-site-<版本>.run --dry-run
```

演练模式不会写任何文件、不会启动服务、不会改动 nftables，报告里会明确标注
「将要安装」而不是「已安装」（`cluster/install-base.sh`）。

### 步骤 4：部署

```bash
sudo bash slurmate-site-<版本>.run
```

不带动词就是安装，它按顺序走三步：检查（环境那一屏，然后是安装器自己的预检）、
安装、诊断（装完用与 `--doctor` 同一份判据对一次账）。

安装本身是六个阶段：预检 → 快照 → 安装文件 → 配置自检 → 启用并启动 → 非干扰验证
（`cluster/install-base.sh`）。

装过基座的机器上，这一步自动按修复走 —— 升级与修复是同一条路。站点配置的取值与
状态数据不动，正在跑的会话一条都不受影响（`cluster/install-base.sh`）。

第四阶段结束时，安装器会调用 `slurmate service restart`：换掉的是基座，这一版
默认留一个完整、干净的环境。客户端会短暂断线并自动重连，作业与正在跑的会话不受
影响。

重启之前先排空，所以不会切断一次走到一半的提交。`--no-restart` 可跳过（演练与
脚本用）。

看起来最啰嗦的第五阶段其实是最重要的一步（`cluster/install-base.sh`）：
部署前后各取一次 `nft -j list ruleset` 结构化快照，剥掉本系统新增的
`inet slurmate` 表之后必须逐条一致。判据有五个档位：

| 判定 | 含义 |
|---|---|
| `SAME` | 完全一致 |
| `DYNAMIC` | 差异只涉及已知会随用户作业流动的规则（`cs-*`、`job-*`、`dnat-automasq`），放行 |
| `ALIEN` | 出现本系统**不应造成**的差异 —— 必须人工检查 |
| `REORDER` | 多重集相同但顺序不同 —— 没有任何合法原因会造成纯重排，必须检查 |
| `NOSNAPSHOT` / `TEXTMODE` | 快照缺失或不是合法 JSON —— **无法**证明非干扰，本身就是失败 |

比对器 `cluster/nft-compare.py` 自带自测，部署脚本会在用它之前先跑一遍自测，
并要求项数不低于一个下限（`COMPARATOR_MIN_TESTS = 23`）—— 少了就拒绝部署，
防的是「测试被删减但报告更绿」（`cluster/install-base.sh`）。

任何一项 FAIL 都会让这次部署回滚，然后以非零码退出（`cluster/install-base.sh`）。

### 失败与回滚

装、升级、修复、卸载都是一次事务。任何一步失败（自检、重启、非干扰验证、
收尾对账），脚本按撤销日志把机器恢复到这次部署之前：

- 放回被覆盖的文件与站点配置，删掉这次新建的文件与目录；
- 取消这次加上的开机自启；
- 首次安装失败时删掉 nft 表与这次新建的状态/日志目录；
- 升级失败时状态数据与日志不回退，只恢复基座并让原来的守护进程重新运行。

成功时不保留旧文件副本：工作目录与被覆盖的旧文件一起删除。要留退路，请在
升级之前自己留一份包与配置。

脚本被 kill -9 或机器断电时，下一次安装会先自动收尾那份没有走完的现场；
也可以手工执行：

```bash
sudo bash slurmate-site-<版本>.run --rollback /root/slurmate-deploy-<时间>
```

`--check`/`--doctor` 只报告这种现场，不动盘。

### 步骤 5：验证

```bash
sudo slurmate service status      # 版本、pid、配置摘要、会话与插件数
journalctl -u slurmate-sessiond -f

# 普通用户身份：
slurmate whoami      # 用户、计算账户、可用分区
slurmate partitions  # 分区列表与各自的时间上限，无权限的会标注 [无权限]
slurmate doctor      # 守护进程与 nft 规则是否一致
```

`slurmate doctor` 的输出里最该看的是「不变量检查」那一行：它说检查了几项、
有没有发现。那一行下面是逐条问题（键是机器判据，后面一句人话）。这一行不是
「全部通过」时，退出码非零 —— 脚本里那句 `&&` 认得出它。

「规则与会话一致」判的是两个集合相等，不只是数目相等：一条该有的规则不在、
一条对不上任何会话的规则还在，都会让它变成 `✗`（`cluster/slurmate`）。

再做一次真实提交，把整条链路走通：

```bash
slurmate submit                      # 全部参数可省略：缺省由服务端填
slurmate wait --session <session_id>
```

`wait` 拿到隧道目标后会一并打印那个会话的口令，可以直接手工验证：

```bash
ssh -N -L 18080:<tunnel_target> alice@node01.example.com
curl -i http://127.0.0.1:18080/healthz
```

分发这一条也要单独验一次（而且它有一个只在这里才看得见的失败形态）：

```bash
# 1. 守护进程从包里读出来的那份清单 —— 这就是客户端会去取的那一份
sudo /usr/local/sbin/slurmate-sessiond --check-plugins
# 2. **要发出去的那一份**一次取回来（客户端走的就是这条路 —— 它是唯一一条）
slurmate rpc <<< '{"op":"plugin_package","id":"<ULID>","version":"1.0.0"}'
```

第 2 步的输出里 `data` 是只含客户端侧那一份容器的 base64，`digest` 要与作者那边
`packer inspect` 报的「客户端侧」那一行一致 —— 不是「内容摘要」那一行（那一行
是整棵树的）。若它回
`9 plugin_package_changed`，说明守护进程起来之后有人动过那个包（就地换了包而
没重新部署）—— 那要重跑一次 install-base.sh，而不是重试这个请求。

手工调 `plugin_file` 会回 `2 unknown_op` —— 那是预期的，不是部署坏了：
那个 op 不存在，一份内容只有"整包"这一条投递方式。

第 1 步的输出里还有一行「包 N 字节 / M 份文件」和一行完整的内容摘要。那个
摘要是这个站点上唯一能回答"我装上去的是不是作者发布的那一份"的东西（服务器上
没有源码树可对照）—— 它要与作者那边 `packer inspect` 报的逐个字符比。

客户端那一侧只有在一台真的客户端上才验得到：连上去之后应该出现
「本站要给你 N 个插件，都还没经过你的同意」，点同意之后它们才开始工作。
点完同意之后看一眼池子 —— 每个版本是一棵树加一份记录表：

```bash
ls -l ~/.slurmate/site-plugins/           # <ULID>_<版本>/ 与 <ULID>_<版本>.json
```

那份 `.json` 是这一份的提交点：树在、记录表不在，就是这一次安装没提交，下一轮清掉
重取。手造一个这样的目录出来玩也行：下一轮它自己会消失，那是自愈。

池子里没有 `.splug`：容器解完就扔，它只在「作者→站点」与「站点→客户端」这两段路
上活着。而这里是只含客户端侧的那一份，`job/` 那半边根本不在这台机器上。

把一个 `job/start.sh` 放到用户机器上就是一个真实的缺陷形状，因为它是以提交者本人的
身份在集群上执行的脚本。所以客户端解包时拒绝任何含站点侧路径的包，拒整份。

这条路 2026-10-18 在一台真站点上跑通了（站点装包 → 客户端取回 → 同意 → 用起来，
版本升级也走过）。还没有量的是签名、那 4 MiB 的响应余量，以及单线程守护进程扛不扛
得住一次 2 MiB 级的响应。见 [docs/KNOWN-ISSUES.md](../../docs/KNOWN-ISSUES.md) 的 U7。

### 步骤 6：卸载

```bash
sudo bash slurmate-site-<版本>.run --uninstall              # 保留状态与日志
sudo bash slurmate-site-<版本>.run --uninstall --purge-state
```

卸载路径永远可用 —— 它不做任何多余的预检，出故障时管理员最需要的就是能干净地
把它拿掉（`cluster/install-base.sh`）。

两处刻意的保守行为：

- 必须确认服务真的停了再删表和文件，否则删表后守护进程下一个 tick 就把表重建
  回来（会打印「已删除」但实际还在），而 `Restart=always` 还会再起
  （`cluster/install-base.sh`）。
- 删文件前逐项确认「这确实是本系统装的文件」（内容里必须含 `slurmate`）。
  这里不能无条件 `rm -f`：在一台从未部署过 Slurmate 的机器上执行，它会删掉
  同名的、不属于本系统的文件（`cluster/install-base.sh`）。

  `<prefix>/share/slurmate/jobs/` 里那些文件文件名里没有 `slurmate`（是插件的
  ULID），所以那道闸门对它们看的是脚本内容 —— 里面必然有 `SLURMATE_*`。
  卸载后这个目录里留下的东西就是"内容里连一个 `slurmate` 都没有"的，那不是本系统放的。

---

## 部署后仍会长期存在的运维事项

出问题时的第一个动作是诊断，它只读、不改任何东西：

```bash
sudo bash slurmate-site-<版本>.run --doctor
```

它逐项对账：文件与权限、目录、systemd 单元、服务与 socket、守护进程自己的配置自检
与运行期自检。每一格不对的下面都写着下一步与该看哪份文档。

修回去用 `--repair`：只增不改，站点配置的取值与状态数据不动；结束时默认重启一次
服务。

日常的启停不必手写 `systemctl`（详见 `cluster/README.md` 那张表）：

```bash
sudo slurmate service stop        # 关机式：取消本站全部会话 → 停服务 → 删表
sudo slurmate service restart     # 自检 → 排空 → 对齐派生物 → 重启 → 等就绪
sudo slurmate service reload      # 热重载（含模板与作业脚本），等它报出结果
sudo slurmate service status      # 看它现在是什么状态；不需要 root
```

`stop` 与 `restart` 的区别要记住：`restart` 只换守护进程，作业与会话不动；
`stop` 会先取消本站提交的 Slurm 作业（用户自己的作业不动），再删 nft 表。
`start` 之后表会重建，但被停掉的会话不会回来。

其余长期事项：

- `nftables.service` 重载会 flush 整个 ruleset。这是单元里
  `PartOf=nftables.service` 存在的原因；重载后表会被重建，规则由对账补齐。
  详见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
- 端口池的占用会随时间增长。每个会话占 `candidates_per_session` 个候选端口，
  释放时归还。
- 用户家目录里的陈旧会话文件由用户自己清理：
  `slurmate gc --older-than 604800`（`cluster/slurmate`）。

---

## 部署完仍然要注意的

`install-base.sh` 跑通 不等于系统已被验证 —— 它证明的是"这台机器的环境满足前提"。
已核实的缺陷、还没有完整实测过的路径、以及结构性欠账都在
[KNOWN-ISSUES.md](../../docs/KNOWN-ISSUES.md)，每条写了位置、后果与修法。

与部署直接相关的两条按编号引用（编号是稳定的，复述会漂）：

- U2 —— 首次安装在真机上跑过；诊断（`--doctor`）、修复（`--repair`）、升级的收尾
  与卸载有没有清干净，都还没有专门跑过。
- U6 —— CLI 的 `slurmate submit` 这条链路还没在真集群上成功跑过（客户端那条提交
  路已经跑过，见 U1/U3）。第一次用它时先用普通用户身份把整条路走一遍（U6 里给了
  那串命令）。
