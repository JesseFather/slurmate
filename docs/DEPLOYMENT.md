# Slurmate 部署指南

本文分两部分：**前置条件**（每一条都注明「不满足会怎样失败」）和**部署流程**。
前置条件全部从代码核实，不是经验之谈。

部署脚本是 `cluster/deploy.sh`，在**登录节点（控制节点）**上以 root 运行。
源码树里还有一份只读的自检脚本 `tools/check-cluster.sh`，建议在部署前先跑它。

---

## 第一部分：前置条件

### 0. 建议先跑一次自检

```bash
sudo bash tools/check-cluster.sh
```

它把下面这些环境事实逐条查出来并打印，唯一的写操作是在 `/root` 下留一份 nft 规则
快照和一份报告。它检查的正是那些「不满足也不会报错，只会在几小时后以奇怪的方式
失败」的东西（`tools/check-cluster.sh:8-14`）。

### 1. 单一登录节点，且 nft 规则挂在它的 output 链上

**依据**：`Nft.CHAIN = "output"`（`cluster/slurmate-sessiond:503`），链由守护进程在
自身所在主机上创建：`type filter hook output priority filter; policy accept;`
（`cluster/slurmate-sessiond:535-539`）。

**不满足会怎样失败**：多登录节点集群里，用户在 `node02` 登录时，`node02` 的
`inet slurmate output` 链上没有任何规则。**用户本人不会有任何异常**（他自己的流量
本来就被 accept），但同节点其他用户可以直接连他的端口 —— 保护静默消失，
`slurmate doctor` 在 `node01` 上跑还会报「一致」。

**怎么确认**：在**用户实际登录的那台机器**上确认表与链存在：

```bash
nft list chain inet slurmate output
```

### 2. 登录节点与全部计算节点在同一 IPv4 网段内，且能用一个 CIDR 表达

**依据**：`cluster_cidr` **只接受一个** CIDR，且**没有默认值** —— 留空、写成文档占位
网段、前缀长度非法、主机位不为 0，都会被自检拒绝启动。这个值被写进基础规则
`ip daddr != <cluster_cidr> accept`（`Nft.ensure()`）。

**不满足会怎样失败**：如果计算节点落在 `cluster_cidr` 之外，去往它们的流量会先被
这条基础规则放行，**所有会话规则永远匹配不到**。链的 policy 是 `accept`，
所以不会有任何报错 —— 表现为「一切正常，只是没有保护」。

**怎么确认**：不用手工确认 —— 守护进程启动时与 `--check` 时都会拿
`scontrol show node -o` 的 `NodeAddr` 全集与 CIDR 求交，**发现节点在网段外就拒绝启动**
并逐个点名。`tools/check-cluster.sh` 也会打印
`NodeName=/NodeAddr=` 对照表。

### 3. 共享家目录（NFS 或同类），并且支持服务端原子 rename

作业把会话文件写在 `~/.slurmate/sessions/job-<id>.json`，守护进程在登录节点上把它读出来
（`cluster/run.sbatch:16-19`，`cluster/slurmate-sessiond:1373-1431`）。这条链路有四层
要求，每一层的失败模式都不同。

**3a. 家目录必须在登录节点与计算节点上都能看到**

- 不满足：守护进程读不到会话文件 → 会话停在 `submitted` → 到
  `submitted_ttl_seconds`（默认 1800 秒）超时 → 记 `expired`，并且**作业被
  `scancel`**（`cluster/slurmate-sessiond:1194-1204`，注释解释了为什么必须
  `scancel`：否则作业会白占节点到 `TimeLimit`，而 `expired` 不在
  `phase_running` 的扫描集合里，再没人回收它）。
- 用户看到的现象：界面一直停在「排队中 · 等待调度与登记」。

**3b. rename 必须是原子的（NFSv4 的 RENAME 是服务端原子的）**

作业侧用「写临时文件 + `mv -f`」落盘（`cluster/run.sbatch:107-114`），守护进程侧
要求常规文件、大小上限、`st_nlink == 1`。若底层实现让 rename 退化成非原子，
守护进程会读到半截文件并判 `bad_json`，于是每个 tick 重试一次直到 3a 的超时。
表现为登记被无限推迟，而不是立刻报错。

**3c. NFS 属性缓存会影响登记延迟**

默认 `acdirmax=60s`，目录属性最长缓存 60 秒 —— **会话登记最多延迟 60 秒**。
`tools/check-cluster.sh:483-491` 专门检查 `/shared/home`（或你的实际挂载点）有没有
显式设置 `actimeo` / `acdirmax` / `acregmax`，没有就给出 WARN。

这不是故障，但会让人误判：客户端在「等待登记」期间每 3 秒轮询一次
（`client/src/main/session.js:47`），用户很容易以为卡住了。想缩短首连体验就往挂载
参数里加 `actimeo=5` 之类的值。

**3d. 家目录必须能由 uid 反查**

守护进程取家目录的唯一途径是 `pwd.getpwuid(uid).pw_dir`
（`cluster/slurmate-sessiond:1358-1371`）。**绝不拼「前缀 + 用户名」**，两个独立理由：
用户名与目录名不保证一致；前缀本身也是站点配置。

- 不满足：`user_home()` 返回 `None` → 该用户所有涉及家目录的操作直接失败
  （`uid_unknown`）。

注意：很多集群的 NSS（SSSD/LDAP）**没有开启枚举**，`getent passwd` 全量列表里
只有本地账号。这不影响按 uid 直查（`getent passwd <uid>`），守护进程走的正是直查，
不做任何枚举（`tools/check-cluster.sh:387-395,410-418`）。

**3e. 家目录在 systemd 下被挂成只读**

`deploy.sh` 按 `readonly_paths` 渲染 `ReadOnlyPaths=`（`cluster/deploy.sh:651-665`）。
填错的后果是守护进程在一个不存在的路径上做只读挂载，**systemd 直接拒绝启动**
（`cluster/deploy.sh:652-653`）。留空则整行被删除，保护随之消失（会打印警告）。

### 4. root 需要 Slurm operator 权限

**依据**：续期用 `scontrol update JobId=<id> TimeLimit=+<增量>`
（`Slurm.renew()`，`cluster/slurmate-sessiond:866-877`）。注释写得很直白：
**只有 root/Slurm 管理员能增加 `TimeLimit`，普通用户不行 —— 这就是为什么续期必须
是守护进程的职责**。

**不满足会怎样失败**：`renew` 每次都返回失败，审计日志记 `renew_failed`，守护进程
只打一条 warning（`cluster/slurmate-sessiond:1291-1294`）。会话会在 `TimeLimit`
到期时被 Slurm 正常杀死 —— 用户正在编辑的内容随作业一起消失，而在此之前界面上
没有任何异常，只是「剩余时间」在稳步减少。

守护进程还必须能以 root 身份执行 `sbatch`（它用 `user=`/`group=`/`extra_groups=`
切到目标用户，`cluster/slurmate-sessiond:836-847`）、`scancel`、`scontrol`、
`sacctmgr`。

**怎么确认**：`slurmate doctor` 之外，直接看一眼续期是否真的在发生：

```bash
sudo journalctl -u slurmate-sessiond | grep -i renew
```

### 5. sshd 允许 direct-tcpip 转发，并允许用户的认证方式

**依据**：客户端的隧道走 SSH 的数据通道 —— 真实模式是 ssh2 的
`forwardOut(...)`（即 direct-tcpip），见 `client/src/main/backend-ssh.js:37`、
`client/src/main/tunnel.js:2-6`。同时客户端探测登录地址时会**读 SSH banner**
并校验 `SSH-2.0-` 前缀（`client/src/main/hosts.js:16-19`）。

- 不允许 `AllowTcpForwarding`：本地 `127.0.0.1:<槽位端口>` 仍然会监听成功
  （`tunnel.js` 先监听、再在每条连接上拨号），但每条连接拨号都失败 →
  隧道状态变 `down` → 界面弹出遮罩「隧道断开，正在重试」
  （`client/src/main/session.js:84-93,138-147`）。症状是「地址能打开，页面连不上」。
  若集群还配了 `PermitOpen`，同样会出现这个现象。
- 认证方式：客户端要用 `-o BatchMode=yes` 这类非交互方式建立连接
  （`client/src/main/backend-ssh.js:27`），所以用户必须已经能用密钥或已保存的
  口令完成认证。密钥认证缺失时，用户在客户端里会卡在连接阶段。

**怎么确认**：

```bash
sshd -T | grep -iE '^(allowtcpforwarding|permitopen|pubkeyauthentication|passwordauthentication)'
```

**若集群在 sshd 上挂了 `ForceCommand` 守卫**：`slurmate rpc` 的固定 argv 必须能穿过它
（命令串里不能出现 `code-server` 字面量 —— 用固定 argv 恰好满足这个条件）。
这条依赖必须**被证明**而不是假设，Phase 0 的两步实测见
`client/src/main/backend-ssh.js:15-25`。

### 6. 计算节点上要有 code-server、curl、python3、ss

| 命令 | 用在哪 | 缺失后的表现 |
|---|---|---|
| `code-server` | `cluster/run.sbatch:54,188-200`（路径取自 `[slurm] code_server_bin`） | 每个候选端口都在启动后立刻退出 → `pick_port_and_start` 全部失败 → 写 `failed` 并 `exit 22` |
| `curl` | `cluster/run.sbatch:213-218` 的就绪判定 | `/healthz` 与 HTTP 兜底探测都拿不到结果 → **每个候选端口白等 45 秒** → 默认 6 个候选共约 4.5 分钟后全部失败 |
| `python3` | `cluster/run.sbatch:173-184` 真正 bind 一次确认端口空闲 | 少一道校验，`ss` 看不到的占用会被漏掉；最终由 code-server 的提前退出检测兜住（`:208-212`） |
| `ss` | `cluster/run.sbatch:169-170` 端口占用快查 | 退化为只靠 bind 探测（若 `python3` 也缺失，`port_free` 恒返回空闲） |

另外作业还需要 `mktemp`、`date`、以及 `/dev/urandom` 或 `openssl` 之一来生成口令
（`cluster/run.sbatch:335-345`）。**若两者都拿不到，作业明确拒绝启动（`exit 23`），
不会静默降级成 `auth=none`**（`cluster/run.sbatch:355-361`）—— 静默降级恰好会移除
唯一的实质保护。

### 7. systemd + nftables + `nft -j`

- **systemd**：服务单元与 `StateDirectory` / `LogsDirectory` / `RuntimeDirectory`
  都依赖它。
- **nftables**：`deploy.sh` 要求 `nft list tables` 成功（`cluster/deploy.sh:349-351`）。
- **`nft -j list ruleset` 必须可用**：这是硬性要求，取不到就**拒绝部署**
  （`cluster/deploy.sh:353-365`）。理由是没有这道校验就无法证明部署没有破坏现有
  规则集 —— 宁可现在拒绝，也不要事后给一个证明不了任何东西的绿灯。

**注意 firewalld 与 nftables 并存的情况**：`tools/check-cluster.sh:131-137` 会打印
两者的 active/enabled 状态；`:148-161` 会检查 `/etc/nftables.conf`（RHEL 9 上是
`/etc/sysconfig/nftables.conf`）里有没有 `flush ruleset`。有的话见
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md) 的「nft 规则消失」。

### 8. python3 ≥ 3.9

**依据**：`Slurm.submit()` 用 `subprocess.run(..., user=uid, group=..., extra_groups=...)`
（`cluster/slurmate-sessiond:799-847`），注释明确写着「Python 3.9+」。

**不满足会怎样失败**：3.8 及以下不认识这些关键字 → 抛 `TypeError` → 被
`except Exception` 捕获并返回 `(None, "提交失败: ...")` → `op_submit` 返回
code 6 `submit_failed`。**每一次提交都失败**，用户看到的是中文的提交失败提示。

部署脚本还会断言 `socket.SO_PEERCRED` 与 `sqlite3` 可用，缺一即中止
（`cluster/deploy.sh:340-346`）。

### 9. 其他部署脚本会检查的项

| 检查 | 位置 | 不满足的后果 |
|---|---|---|
| `sbatch` / `scancel` / `squeue` / `scontrol` 存在 | `cluster/deploy.sh:460-463` | 直接中止：「这台机器不像是 Slurm 登录节点」 |
| `scontrol ping` 成功 | `cluster/deploy.sh:464-472` | 只警告。部署能完成，但提交与回收都会失败；守护进程的 `job_state()` 会把这种情况判为 `JOB_UNKNOWN` 并保持现状，**不会误释放会话** |
| `sha256sum` 存在 | `cluster/deploy.sh:368` | 直接中止（无法校验现有文件是否被改动） |
| `flock` 存在 | `cluster/deploy.sh:144-161` | 只警告，失去并发部署保护 |
| 目标路径未被他人文件占用 | `cluster/deploy.sh:446-455` | 直接中止，绝不覆盖别人的文件 |
| 端口池与 `reserved_ranges` 不交 | `cluster/deploy.sh:371-410` | 直接中止。跨表顺序在 nftables 里没有保证，重叠会让行为不可预测 |
| 端口池与 `ip_local_reserved_ports` 不交 | `cluster/deploy.sh:412-443` | 只警告。作业脚本会跳过真被占的端口试下一个（`cluster/run.sbatch:248-251`），nft 规则匹配 `dport` 不受影响 |

### 10. `KillWait` 要够写墓碑

作业退出前必须在 `KillWait` 窗口内写完墓碑（`cluster/run.sbatch:13-15`），
Slurm 默认 30 秒。清理函数只做一件要紧事：写墓碑让守护进程立刻知道会话结束；
日志搬运放后台、绝不阻塞退出（`cluster/run.sbatch:264-266`）。

**不满足会怎样失败**：超时的后果是 SIGKILL，墓碑写不下去，会话要多等一个 orphan
周期（默认 1800 秒）才回收 —— 期间计算节点被白占。

### 11. SELinux（若启用）

`tools/check-cluster.sh:79-128` 会打印 `getenforce`、相关策略模块、最近 7 天的 AVC
拒绝，以及 `use_nfs_home_dirs` 等布尔值。Enforcing 状态下必须验证三件事：

1. 守护进程 setuid 到用户后还能执行 `sbatch`（域转换）；
2. 守护进程能通过 netlink 调 `nft`；
3. 守护进程能读 NFS 上的用户家目录。

`:335-367` 另有一项**最关键**的实测：用 `systemd-run` 起一个带完整加固指令的瞬时
单元跑 `scontrol ping`，验证沙箱里 munge socket 与 nft 都还能用。加固指令一放宽
就是安全增量的损失，所以这一步值得做。

### 12. systemd 加固指令必须被这个 systemd 接受

`tools/check-cluster.sh:289-333` 用 `systemd-analyze verify` 真校验一遍计划使用的
全部加固指令，而不是等 systemd 在启动时报错。看到
`unknown key` / `failed to parse` / `invalid` 就要删掉对应指令再试。

---

## 第二部分：部署流程

### 步骤 0：把源码放到 root 拥有的目录

部署脚本会以 root 身份**安装并执行** `cluster/` 下的文件。若它们能被普通用户改写，
等于把 root 权限交出去（`cluster/deploy.sh:233-236`）。判据是：每个源文件必须 root
拥有，且组/其他不可写；目录同理。

源码不可信时脚本会自拷贝到 `/root/slurmate-src.XXXXXX`（源码位于 `/` 或 `/root`
时改用 `/var/tmp`，避免把目录拷进自己里面）再重新执行
（`cluster/deploy.sh:287-329`）。

这条路是通的，但**部署完记得清理 `/root/slurmate-src.*`** —— 每次从非 root
拥有的目录部署都会留下一份拷贝。

> 如果你把 `cluster/` 挪到别的位置（例如把仓库结构改成 `src/cluster/`），
> 自拷贝分支里的相对路径也要跟着改（`cluster/deploy.sh:310` 的 `cd` 目标与
> `:328` 的执行路径）。这两处用的是相对于 `SECURE_DIR` 的位置，脚本名走
> `basename "$0"` 所以改名字不受影响，但子目录层级变了要同步。

### 步骤 1：先 `--check`

```bash
sudo bash cluster/deploy.sh --check
```

`--check` 承诺零改动：不安装文件、不启动服务、不改动 nftables，快照也只写到
`/tmp`（`cluster/deploy.sh:122-127,586-594`）。它把所有预检跑一遍并打印一份可存档的
报告 —— 警告与失败都走 stdout，就是为了让报告能整份重定向保存
（`cluster/deploy.sh:110-113`）。

### 步骤 2：准备站点配置

`deploy.sh` **只在配置不存在时安装** `slurmate.conf.example`
（`cluster/deploy.sh:640-649`）—— 重复部署时覆盖等于把站点的调优悄悄抹掉，
而且故障要等下次重启守护进程才出现。

所以推荐两种顺序之一：

- 先部署，再编辑 `/etc/slurmate/slurmate.conf`，最后
  `systemctl restart slurmate-sessiond`；
- 或先手动 `cp cluster/slurmate.conf.example /etc/slurmate/slurmate.conf` 改好再部署。

至少要把这两项改成你站点的真实值：

- `cluster_cidr` —— 见前置条件 2。**它没有默认值，不填服务起不来**；
- `readonly_paths` —— 见前置条件 3e。

配置一共只有 12 个键，全部见 [CONFIGURATION.md](./CONFIGURATION.md)。

### 步骤 3：演练（可选但推荐）

```bash
sudo bash cluster/deploy.sh --dry-run
```

演练模式不会写任何文件、不会启动服务、不会改动 nftables，报告里会明确标注
「将要安装」而不是「已安装」（`cluster/deploy.sh:892-900`）。

### 步骤 4：部署

```bash
sudo bash cluster/deploy.sh
```

六个阶段：预检 → 快照 → 安装文件 → 配置自检 → 启用并启动 → 非干扰验证
（`cluster/deploy.sh:130,502,598,691,705,760`）。

看起来最啰嗦的第五阶段其实是最重要的一步（`cluster/deploy.sh:760-807`）：
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
防的是「测试被删减但报告更绿」（`cluster/deploy.sh:249-274`）。

任何一项 FAIL 都会让脚本以非零码退出，并提示回滚命令（`cluster/deploy.sh:931-935`）。

### 步骤 5：验证

```bash
systemctl status slurmate-sessiond
journalctl -u slurmate-sessiond -f

# 普通用户身份：
slurmate whoami      # 用户、计算账户、可用分区
slurmate partitions  # 分区列表与各自的时间上限，无权限的会标注 [无权限]
slurmate doctor      # 守护进程与 nft 规则是否一致
```

`slurmate doctor` 的输出里最该看的两行是「ACL 规则数」和「规则与会话一致」——
它们不等就说明对账在报错（`cluster/slurmate:394-417`）。

再做一次真实提交，把整条链路走通：

```bash
slurmate submit                      # 全部参数可省略：缺省由服务端填
slurmate wait --session <session_id>
```

`wait` 拿到隧道目标后会一并打印 code-server 口令，可以直接手工验证：

```bash
ssh -N -L 18080:<tunnel_target> alice@node01.example.com
curl -i http://127.0.0.1:18080/healthz
```

### 步骤 6：卸载

```bash
sudo bash cluster/deploy.sh --uninstall              # 保留状态与日志
sudo bash cluster/deploy.sh --uninstall --purge-state
```

卸载路径**永远可用** —— 它不做任何多余的预检，出故障时管理员最需要的就是能干净地
把它拿掉（`cluster/deploy.sh:163-168`）。

两处刻意的保守行为：

- **必须确认服务真的停了再删表和文件**，否则删表后守护进程下一个 tick 就把表重建
  回来（会打印「已删除」但实际还在），而 `Restart=always` 还会再起
  （`cluster/deploy.sh:174-183`）。
- **删文件前逐项确认「这确实是本系统装的文件」**（内容里必须含 `slurmate`）。
  早期版本在这里无条件 `rm -f`，在一台从未部署过 Slurmate 的机器上执行会删掉同名
  的他人文件（`cluster/deploy.sh:193-207`）。

---

## 部署后仍会长期存在的运维事项

- **`nftables.service` 重载会 flush 整个 ruleset。** 这是单元里
  `PartOf=nftables.service` 存在的原因；重载后表会被重建，规则由对账补齐。
  详见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。
- **端口池的占用会随时间增长。** 每个会话占 `candidates_per_session` 个候选端口，
  释放时归还。
- **用户家目录里的陈旧会话文件**由用户自己清理：
  `slurmate gc --older-than 604800`（`cluster/slurmate:420-452`）。
