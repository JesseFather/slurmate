# 配置参考（`slurmate.conf`）

配置文件默认在 `/etc/slurmate/slurmate.conf`。**三个读者**：

| 读者 | 怎么读 | 读到之后 |
|---|---|---|
| `slurmate-sessiond` | `configparser`，路径由 `--config` 指定（默认 `/etc/slurmate/slurmate.conf`） | 全部键 |
| `slurmate`（CLI） | 每次调用时手工逐行扫描，只找 `socket_path`（`cluster/slurmate:44-57`） | 只有 `socket_path` |
| `cluster/deploy.sh` | `sed` 抽取 `range_start` / `range_end` / `reserved_ranges` / `readonly_paths` | 用于预检与渲染 systemd 单元 |

改了配置后：**守护进程需要 `systemctl restart slurmate-sessiond`**（文件头
`cluster/slurmate.conf.example:6`）；CLI 不需要重启；`readonly_paths` 与端口区间的
改动需要**重新跑一次 `deploy.sh`** 才会反映到 systemd 单元与部署预检里。

## 格式上的三个坑

1. **值里不能出现 `#`。** 解析器开了 `inline_comment_prefixes=("#",)`
   （`cluster/slurmate-sessiond:200-202`），所以 `key = value  # 说明` 这种写法是合法的，
   代价是值本身不能含 `#`。路径、网段、时间都不含，实际无碍。
2. **六个 section 都是必需的。** 守护进程用 `cp["general"]`、`cp["ports"]`、
   `cp["lifecycle"]`、`cp["renew"]`、`cp["security"]`、`cp["quota"]`、`cp["slurm"]`
   直接取键（`cluster/slurmate-sessiond:208-277`）。少一个 section 会抛 `KeyError`，
   守护进程打印「读取配置失败」后以非零码退出 —— 而单元里的
   `ExecStartPre=... --check` 会让 systemd 直接拒绝启动服务。
3. **`[purpose:*]` 至少要有一个。** 一个都没有时启动自检会报
   「没有配置任何 [purpose:*]」（`cluster/slurmate-sessiond:319-320`）。

---

## `[general]`

| 键 | 类型 | 默认值 | 说明与后果 |
|---|---|---|---|
| `socket_path` | 路径 | `/run/slurmate-session/ctl.sock` | 守护进程的 unix socket。权限 `0666`：安全性**不**建立在这个权限位上，而是靠 `accept()` 后立刻 `getsockopt(SO_PEERCRED)` 取内核提供的 uid/gid（`cluster/slurmate-sessiond:969-970`）。**这是 CLI 唯一会读的键** |
| `state_dir` | 路径 | `/var/lib/slurmate-session` | 状态目录。守护进程启动时创建并 `chmod 0700`（:933-935）。systemd 单元里对应 `StateDirectory=` |
| `db_path` | 路径 | `<state_dir>/claims.db` | SQLite（WAL + `synchronous=FULL`）。作业归属关系的唯一权威来源，丢了要靠 nft 规则反推（见 ARCHITECTURE 第六节） |
| `rejected_dir` | 路径 | `<state_dir>/rejected` | 校验失败时的取证副本存放处（`cluster/slurmate-sessiond:1487-1500`）。放在状态目录下，天然受 `0700` 保护 |
| `log_dir` | 路径 | `/var/log/slurmate` | 日志目录。对应单元里的 `LogsDirectory=` |
| `audit_log` | 路径 | `<log_dir>/audit.log` | 审计日志（JSON 一行一条），权限 `0640`（:937-938）。排查「为什么这个会话被释放了」的第一现场 |
| `cluster_cidr` | 单个 CIDR | `192.0.2.0/24` | 见下方专节 |
| `readonly_paths` | 空格分隔的路径列表 | 示例里是 `/shared/home` | 见下方专节 |
| `tick_seconds` | 整数 | `2` | 主循环周期，同时是 `select()` 的超时（:987）。**调小会加重 Slurm 控制器负担**：`phase_running` 每个 tick 都会为每个活跃会话 fork 一次 `scontrol`（含 `squeue` 兜底）。调大会推迟判活、释放与对账的响应 |
| `startup_grace_seconds` | 整数 | `120` | 启动静默期，这段时间内不做任何超时判定（:913-914,1303-1304）。重启窗口把在跑的会话误判成孤儿的代价很高，所以留了余量 |

### `cluster_cidr`

**只能写一个 CIDR**，且登录节点与计算节点必须都在里面。

它被写进基础规则 `ip daddr != <cluster_cidr> accept`（`cluster/slurmate-sessiond:554-559`），
这是最后一道几何约束：即使前面所有校验都被绕过，也影响不到本网段之外的流量。

**填错的后果是静默失效**：若某个计算节点落在 CIDR 之外，去往它的流量会先被这条规则
放行，**所有会话规则永远匹配不到**。链的 policy 是 `accept`，所以没有任何报错。
多网段集群目前无法表达 —— 这是本架构的已知边界，见
[DEPLOYMENT.md](./DEPLOYMENT.md) 前置条件第 2 条。

自检只校验它的地址部分是合法 IPv4（`cluster/slurmate-sessiond:314-315`），
不会替你验证「所有节点都在里面」。

### `readonly_paths`

**守护进程本身不读这一项**（`Config.__init__` 里根本没有它）。它只被 `deploy.sh`
用 `sed` 抽出来渲染 systemd 单元（`cluster/deploy.sh:654-664`）：

- 非空 → 生成 `ReadOnlyPaths=<值>`；
- 留空 → 整行被删掉，并打印警告「这会去掉『root 不写用户家目录』那层保护」。

写错的后果很直接：**守护进程会在一个不存在的路径上做只读挂载，systemd 直接拒绝
启动**（`cluster/deploy.sh:652-653`）。

为什么可以只读：守护进程**从不写**用户家目录 —— 口令由作业自己生成并写进 `0600` 的
会话文件，会话文件也由作业自己创建（`cluster/slurmate.conf.example:33-39`）。
root 身上因此没有「写用户文件」这条攻击面。

**改了这一项之后必须重新跑 `deploy.sh`**，否则守护进程读的是新配置、systemd 用的
还是旧单元。

---

## `[ports]`

| 键 | 类型 | 默认值 | 说明与后果 |
|---|---|---|---|
| `range_start` / `range_end` | 整数 | `55001` / `55999` | 服务端口池。唯一的要求是：与集群上**其他端口管理系统**的区间完全不交 |
| `reserved_ranges` | `起-止,起-止` | 空（无） | 要避让的其他区间。见下方专节 |
| `candidates_per_session` | 整数 | `6` | 每次提交分配给该会话的候选端口数。作业逐个试，某端口被同节点其他作业占用就试下一个（`cluster/run.sbatch:238-261`） |

### 为什么端口池必须与其他区间不交

nftables 对**同 hook、同 priority 的跨表求值顺序没有保证**（`cluster/slurmate-sessiond:224-229`）。
两个表都匹配同一个 `dport` 时，谁先求值是未定义的。**集合不交**能让判决与顺序无关，
这才是唯一确定的解法。

### `reserved_ranges`

格式 `起-止,起-止`（逗号分隔），留空表示没有。**两项都会在启动时断言不交**：
守护进程的 `Config.validate()`（`cluster/slurmate-sessiond:300-303`）和部署脚本的
预检（`cluster/deploy.sh:382-407`）。重叠即**拒绝启动 / 拒绝部署**。

例子（仅示意，请按你的集群实际情况填写）：若另有一套端口分配方案占用
`5000-49999`（用户端口）与 `50000-55000`（DNAT 外部端口）：

```ini
reserved_ranges = 5000-49999,50000-55000
```

⚠️ **必须写成 `起-止` 形式，不能写单个数字。** 写成 `reserved_ranges = 55000`
会被拒绝 —— 守护进程启动时抛 `ValueError`，部署脚本的预检也同样判失败。

两处解析器（`cluster/slurmate-sessiond` 的 `Config` 与 `cluster/deploy.sh` 的预检）
的规则**必须完全一致**：一个配置项有两套解释，会产生"部署预检放行、服务起不来"
或反过来的错配，而这类问题的排查成本极高。改任何一处都要同步改另一处。

### 端口池要留多大

`active_ports()` 把每个活跃会话的**整个候选集**都算作已占用
（`cluster/slurmate-sessiond:431-440`）。所以粗略的下限是：

```
(池大小) >= (预期并发会话数) × candidates_per_session
```

不够分配时 `allocate_candidates()` 返回空列表，`op_submit` 返回 code 5 `no_port`
（`cluster/slurmate-sessiond:1877-1879`），客户端会退避后重试。

---

## `[lifecycle]`

| 键 | 类型 | 默认值 | 说明与后果 |
|---|---|---|---|
| `default_time` | Slurm 时间 | `12:00:00` | 未指定 `--time` 时的作业时间上限。起始值取小一些的好处是：崩溃/遗忘的会话能更快自然释放 |
| `max_time` | Slurm 时间 | `7-00:00:00` | 用户可请求的上限。**超出不是报错，是静默截断到上限**（`cluster/slurmate-sessiond:1849-1852`）。时间格式解析见 `parse_slurm_time()`（:96-116），`UNLIMITED`/`infinite` 视为无限 |
| `suspect_after_seconds` | 整数 | `300` | 心跳中断超过此值判定网络闪断：**什么都不做**，作业与 ACL 全保留 |
| `orphan_after_seconds` | 整数 | `1800` | 心跳中断超过此值判定异常退出：自动 `scancel` 释放资源 |
| `job_missing_confirm_ticks` | 整数 | `3` | 见下方专节 |
| `reserved_ttl_seconds` | 整数 | `600` | `reserved` 状态存活上限（已分配候选端口但尚未提交成功），超时记 `expired` |
| `submitted_ttl_seconds` | 整数 | `1800` | `submitted` 存活上限（已提交但作业迟迟没登记），超时记 `expired` **并 `scancel` 掉作业** |
| `released_keep_seconds` | 整数 | `600` | 终态记录在数据库里保留多久后删除（审计用） |

**硬约束**：`suspect_after_seconds` 必须严格小于 `orphan_after_seconds`，否则
**拒绝启动**（`cluster/slurmate-sessiond:309-311`）。两个阈值相等意味着「判定闪断」
和「判定异常退出」同时发生，闪断窗口就没了。

### `job_missing_confirm_ticks`

「作业查不到」要连续确认多少个 tick 才认定为真的结束。

为什么需要它：`scontrol` 查不到作业有两种截然不同的原因 —— 作业真的结束了，或者
**只是问不到**（`slurmctld` 重启中、`munge` 抖动、控制器繁忙）。早期实现把两者合并成
「查不到即释放」，后果是：控制器抖一次，所有活跃会话的 ACL 在一秒内全部消失、
会话文件被删（再也无法重新登记），而作业还在跑
（`cluster/slurmate.conf.example:89-96`，机制细节在
`cluster/slurmate-sessiond:1161-1172`）。

连续确认是对「瞬时不可靠」的廉价保险。**调成 1 就是关掉这层保险**；自检要求
`>= 1`（:307-308）。按默认 `tick_seconds = 2` 算，3 个 tick 约 6 秒 —— 远小于
`orphan_after_seconds`，代价可以忽略。

---

## `[renew]`

| 键 | 类型 | 默认值 | 说明与后果 |
|---|---|---|---|
| `enabled` | 布尔 | `yes` | 关掉后所有作业都会在 `TimeLimit` 到期时自然结束 |
| `threshold_seconds` | 整数 | `7200` | 剩余时间少于这个值就续期 |
| `increment` | Slurm 时间 | `12:00:00` | 每次续期的增量 |
| `max_total_seconds` | 整数 | `604800` | 从会话创建起累计最多续到多久，超过则停止续期并通知客户端（写 `note=renew_exhausted`） |

只对 `enrolled`（心跳新鲜）且 `trust='owned'` 的会话生效
（`cluster/slurmate-sessiond:1261-1264`）—— 客户端已经消失的会话不该再续命。

三个额外行为，都不由配置控制：

- **续期后最少冷却 300 秒**，失败时不会每个 tick 重试刷屏（:1267-1268）；
- `TimeLimit` 是 `UNLIMITED` 时不续期（增量对无限没有意义，:1270-1271）；
- 只有 root/Slurm 管理员能增加 `TimeLimit` —— 这正是续期必须由守护进程承担的原因
  （`cluster/slurmate-sessiond:866-877`）。若 root 没有 operator 权限，续期会**一直
  失败**，作业在到期时被静默杀死。见 [DEPLOYMENT.md](./DEPLOYMENT.md) 前置条件第 4 条。

---

## `[security]`

| 键 | 类型 | 默认值 | 说明与后果 |
|---|---|---|---|
| `auth_mode` | `password` \| `none` | `password` | code-server 的认证方式。取值只能是这两个，否则拒绝启动（`cluster/slurmate-sessiond:321-323`） |
| `password_bytes` | 整数 | `12` | 随机字节数（hex 编码前的），12 → 24 个 hex 字符。必须在 4–64 之间，否则拒绝启动（:324-326） |

### 为什么默认是 `password`，以及这个默认值为什么不该改

`nft` ACL 的 hook 点是**登录节点的 output 链**（`Nft.CHAIN`，
`cluster/slurmate-sessiond:503`）。它拦得住「登录节点上的其他用户连你的端口」，
拦不住「另一个作业恰好被调度到同一台计算节点之后直接 curl 你的端口」——
那条流量根本不经过登录节点。

这不是某个集群的配置问题，而是这个架构的固有边界：绝大多数集群的计算节点上没有任何
per-user 网络隔离（cgroup 没有 `net_cls`/`net_prio`，主机防火墙也不按 UID 区分），
而本机进程访问本机 IP 走的是 `lo`，通常被放行
（`cluster/slurmate.conf.example:128-143`）。

在采用本方案前，请自行确认你的计算节点上是否真的存在这样的隔离 —— 若没有，
`--auth none` 意味着同节点上任何人一个 `curl` 就完整拿到你的 IDE：你的终端、
你的文件读写权，全部以你的身份运行。共享家目录 `0700` 之类的保护恰好被绕过，
因为攻击者用的是你的身份。

作业模板的态度是配合而不是妥协：`auth_mode=password` 时**拿不到口令就拒绝启动
（`exit 23`）**，绝不静默降级为 `auth=none`（`cluster/run.sbatch:355-361`）。

---

## `[quota]`

| 键 | 类型 | 默认值 | 说明与后果 |
|---|---|---|---|
| `max_active_per_user` | 整数 | `1` | 每用户同时存在的活跃会话上限 |
| `max_pending_per_user` | 整数 | `4` | 每用户未决（`reserved`/`submitted`）的提交上限，防刷端口 |
| `max_rpc_per_second` | 整数 | `10` | 每次调用即一次 `exec` channel（真实部署下是 sshd fork + PAM + python3 冷启动），所以这个值同时是**对控制器负载的保护** |
| `reject_threshold` | 整数 | `20` | 拒绝计数熔断阈值 |
| `reject_window_seconds` | 整数 | `600` | 熔断统计窗口 |
| `throttle_seconds` | 整数 | `1800` | 静默期长度。期间该 uid 的提交被拒（code 4 `throttled`），只记录日志、不建规则 |

`max_active_per_user` 的计数**只数 `ACL_STATES`**（`cluster/slurmate-sessiond:442-447`），
`submitted` 不在内。所以它拦不住并发的第二个提交 —— 上限实际退化为
`max_pending_per_user`。客户端的应对是：`submit` 超时**绝不重试**，改用不带
`session_id` 的 `status` 去认领（`client/src/main/session.js:156-173`）。详见
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。

---

## `[slurm]`

| 键 | 类型 | 默认值 | 说明与后果 |
|---|---|---|---|
| `sbatch` / `scancel` / `squeue` / `scontrol` / `sacctmgr` | 路径 | `/usr/bin/<名字>` | 留空则用默认值（注意是 `s.get(k) or "默认"`，所以**空值等于默认值**）。启动自检**只检查 `sbatch`、`scancel`、`scontrol` 三个是否存在**（`cluster/slurmate-sessiond:316-318`）；`squeue` 与 `sacctmgr` 缺失不会被拦，会在运行时才暴露（分别是作业状态查询的兜底路径与账户/分区权限查询） |
| `job_script` | 路径 | `/usr/local/share/slurmate/run.sbatch` | 启动自检要求它存在，否则拒绝启动（:312-313）。**root 拥有（0644）、用户不可修改** —— 这是防注入的关键 |
| `code_server_bin` | 路径 | `/usr/local/bin/code-server` | 作为 `SLURMATE_CS_BIN` 传给作业，由作业在**计算节点**上执行（`cluster/slurmate-sessiond:1906`）。所以这里要填计算节点上的路径 |
| `job_log_subdir` | 路径 | `.slurmate/logs` | 作业 stdout/stderr 在用户家目录下的相对路径，由 `Slurm.submit()` 拼进 `sbatch -o/-e`（`cluster/slurmate-sessiond:811-815`）。家目录即共享存储，所以日志对登录节点上的守护进程与客户端都可见 |

> 📌 **这一项曾经是个坑，值得记一笔。**
> 某个版本里 `slurmate.conf` 写着它、`Slurm.submit()` 读着它，唯独 `Config.__init__`
> 从来没把它从配置里取出来。后果不是"日志路径不对"，而是 `AttributeError`，
> 被 `dispatch` 兜成 code 9 `internal` —— **每一次提交都失败**，且错误信息里
> 看不出任何与"日志路径"有关的线索。
>
> 教训：**一个配置项要在三处对齐 —— 示例配置、读取处、使用处。** 少一处就是一个
> 只在运行时才炸的洞。加新配置项时请顺带确认这三处，并考虑在
> `cluster/test-sessiond-logic.py` 里加一条断言。

---

## `[purpose:*]`

用途 → 分区/资源的映射。客户端界面上**不问「节点」，只问「用来干什么」**，
由 Slurm 在分区内挑空闲节点（守护进程刻意不写 `-w`，`cluster/slurmate-sessiond:827-829`）。
这样既自动，又天然负载均衡，还避免所有用户都写死同一个节点名造成
「一台排队到天荒地老、同分区另一台空着」。

示例里的四个用途键是 `code`、`a6000`、`rtx8000`、`2080ti`，但**键名由你定**，
客户端通过 `purposes` RPC 动态获取（`cluster/slurmate-sessiond:1678-1698`）。

| 键 | 类型 | 默认值 | 说明与后果 |
|---|---|---|---|
| `label` | 字符串 | 就是用途键名（`fallback=key`） | 界面上的显示名 |
| `partition` | 字符串 | **无默认值** | 分区名。缺失会抛 `NoOptionError` → 配置读取失败 → 服务起不来 |
| `cpus` | 整数 | `1` | 传给 `sbatch -c` |
| `mem` | 字符串 | `2G` | 传给 `--mem=` |
| `gres` | 字符串 | 空 | ⚠️ **目前只用于展示，不参与提交**，见下 |

### 分区名大小写敏感

Slurm 分区名**大小写敏感**（示例里是 `A6000` / `RTX8000` / `2080TI`，全大写）。
而 association 里的 `Partition` 字段由管理员手工填写，实践中经常出现大小写与实际
分区名不一致的情况。所以守护进程在权限校验时**统一按小写比较**
（`cluster/slurmate-sessiond:764-771`），避免把有权限的用户误判成没权限。

这不是冗余防御，不要删：删掉之后，那些 association 大小写写错的用户会表现为
「所有用途都不可用」，而守护进程侧不会报任何错（只会拒绝提交），极难排查。
`tools/check-cluster.sh:443-453` 会把 association 里写了、但实际不存在的分区逐个
标成 `[MISMATCH]`。

### 每个用途还会被 association 权限过滤

若用户的 association 限定了 `Partition`，不在允许列表里的用途会在客户端上被禁用，
`op_purposes` 给出 `allowed: false` 与原因；**守护进程在 `op_submit` 里还会二次校验**
（`cluster/slurmate-sessiond:1867-1875`）。查询失败时**拒绝**而不是放行 ——
这是安全相关路径，宁可让用户重试。

### 关于 `gres`

示例里四种用途都写 `gres = gpu:0`，与既有脚本一致 —— 写代码本身不需要 GPU，
把一张卡占满 12 小时是浪费。

但要注意**当前实现里 `[purpose:*] gres` 不参与提交**：`op_submit` 完全从请求里的
`gpus` 推导 `--gres`，`gpus = 0` 时**完全省略** `--gres` 参数（避免在不带 GRES 的
分区上出错），`gpus > 0` 时写死 `gpu:<N>`（`cluster/slurmate-sessiond:1835-1840`）。
所以这一项目前只出现在 `purposes` RPC 的返回里供界面显示。需要 GPU 时由用户在
客户端指定数量。

---

## 启动自检清单

`Config.validate()`（`cluster/slurmate-sessiond:292-327`）在启动时逐条检查，
**任何一条不满足都拒绝启动** —— 宁可不起，也不要带病运行。可以用
`/usr/local/sbin/slurmate-sessiond --check --config=/etc/slurmate/slurmate.conf`
单独跑一遍（不需要 root，nft 相关项会诚实报 false 并提示）。

| 检查 | 不满足时 |
|---|---|
| `port_start <= port_end` | 端口区间起止颠倒 |
| 端口池与 `reserved_ranges` 不重叠 | 跨表行为不可预测 |
| `port_end <= 65535` | 端口区间上界越界 |
| `job_missing_confirm_ticks >= 1` | 连续确认机制被关掉 |
| `suspect_after < orphan_after` | 闪断窗口与孤儿判定重合 |
| `job_script` 存在 | 作业无法提交 |
| `cluster_cidr` 的地址部分是合法 IPv4 | nft 规则语法错误 |
| `sbatch` / `scancel` / `scontrol` 存在 | 无法提交或回收 |
| 至少一个 `[purpose:*]` | 客户端没有可选项 |
| `auth_mode ∈ {password, none}` | 无法决定 code-server 启动参数 |
| `4 <= password_bytes <= 64` | 口令强度或可用性异常 |

`--check` 还会顺带打印：端口池、socket、数据库、作业脚本、集群网段、
闪断/孤儿阈值、续期设置、认证方式、全部用途、`AccountingStorageEnforce` 是否含
`associations`（决定 `sbatch` 是否必须带 `-A`）、可见分区、nft 表是否存在
（`cluster/slurmate-sessiond:1960-1990`）。

## 配置改了之后

```bash
# 1. 改 /etc/slurmate/slurmate.conf
# 2. 自检（非 root 也能跑）
sudo /usr/local/sbin/slurmate-sessiond --check --config=/etc/slurmate/slurmate.conf
# 3. 重启
sudo systemctl restart slurmate-sessiond
# 4. 若改的是 readonly_paths 或端口区间，还要重新渲染 systemd 单元与跑预检：
sudo bash cluster/deploy.sh --check
```

`deploy.sh` **不会覆盖已存在的 `/etc/slurmate/slurmate.conf`**
（`cluster/deploy.sh:640-649`）—— 重复部署时覆盖等于把站点的调优悄悄抹掉，
而且故障要等下次重启守护进程才出现。要重置就手动删掉它再跑。
随仓库分发的版本在 `cluster/slurmate.conf.example`，可以拿它对比新增了哪些项。
