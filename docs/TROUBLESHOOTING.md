# 故障排查（会话与客户端）

这个项目的所有设计注释都在反复讲同一件事：**最危险的故障是「看起来一切正常，
只是没有保护」**。所以本文的写法是「症状 → 原因 → 怎么做」，并且优先给出**能区分
两种可能原因的那一条命令** —— 大多数时候排障的难点不是修，而是确定到底坏在哪一层。

> ★ **插件那一块另有一篇：[PLUGIN-TROUBLESHOOTING.md](PLUGIN-TROUBLESHOOTING.md)。**
> 这一篇的读者是**会话使用者**（我的 IDE 连不上、页面空白、输入法失效），
> 那一篇的读者是**装插件的人**与**被分发的用户**。两边都会用到「`slurmate rpc`
> 没反应」，但只有在一边能查站点上的包。
>
> 这一篇从前把插件那一整块（约 300 行、全篇三分之一）写在自己身上，于是"输入法
> 打不出候选"和"安装器拒绝了我下载的包"挤在同一份文件里。拆开的理由只有一个：
> **它们的读者、需要的权限、能跑的命令，没有一样是重合的。**

---

## 第 0 步：先看这四个地方

```bash
# 1. 守护进程日志与审计
sudo journalctl -u slurmate-sessiond -n 200 --no-pager
sudo tail -50 /var/log/slurmate/audit.log      # 一行一条 JSON 的审计

# 2. 守护进程与 nft 规则是否一致（普通用户就能跑）
slurmate doctor

# 3. 自己最近的会话记录（含状态与 note）
slurmate list
slurmate status --json

# 4. 作业日志（计算节点上，也可在登录节点通过共享家目录看）
ls -l ~/.slurmate/logs/job-*.log
tail -100 ~/.slurmate/logs/job-<job_id>.log
```

审计日志里的事件名是最快的线索（`audit()`，`cluster/slurmate-sessiond`）：
`submitted` / `enrolled` / `suspect` / `suspect_recovered` / `orphaned` / `releasing` /
`released` / `rejected` / `expired` / `renewed` / `renew_failed` / `renew_exhausted` /
`job_query_failed` / `job_stuck` / `acl_orphan_removed` / `acl_reinstalled` /
`throttled` / `recovered`。

---

## 一、会话一直停在「等待登记」

**症状**：客户端停在「排队中 · 作业 12345 · 等待调度与登记」，一直不出隧道目标。

**先分清三件事**。守护进程只在会话文件校验通过、ACL 装好之后才给 `tunnel_target`
（`try_enroll()`，`cluster/slurmate-sessiond`），所以卡住的原因只有三类：

### 1a. 作业根本没在跑（还在排队，或已经死了）

```bash
squeue -j <job_id>            # 看 ST 列：PD / R / 空
scontrol show job <job_id>
```

**★ 从作业回到会话：`squeue` 的 NAME 列给不出会话 ID。** 作业名是
`sj-<插件短名>`（例如 `sj-code-server`），`squeue` 默认只显示 8 个字符宽，所以同一
个人同时开两个同插件的会话时，那两行**长得一模一样**。要认人只能反过来查：

```bash
slurmate list                 # 会话 ID ↔ 作业 ID 的对应关系在这里
slurmate status --json | python3 -c 'import json,sys
for s in json.load(sys.stdin)["sessions"]: print(s["sid"], s.get("job_id"), s.get("service_kind"))'
```

这是**已知的取舍**：作业名要一眼看出是哪个插件（`slurmate-code-server` 被截成
`slurmate`，等于什么都没说），就装不下会话的可辨认性。要同时看名字和作业 ID 用
`squeue -o "%.10i %.16j %.8T"`。

**★ 凡是"作业还没结束"的状态，守护进程都刻意什么都不做** —— 保留会话与 ACL，
不释放。判据是"是不是真终态"，不是"是不是 `RUNNING`"，所以 `PENDING`、
`SUSPENDED`、`REQUEUED`、`COMPLETING` 这些都落在保留那一侧
（`job_is_terminal()`，`cluster/slurmate-sessiond`；逐状态的表见
[ARCHITECTURE.md](./ARCHITECTURE.md) 的 §3.1）。

若 `squeue` 已经查不到，那是在走「作业查不到要连续确认」的路径：
`scontrol` 报"没有这个作业"要连续 `job_missing_confirm_ticks` 次（缺省 3）才认定结束。
分区满、资源不足都会让作业长时间挂在 `PD`，这属于 Slurm 侧的问题。

### 1a.1 ★ 排队原因：有四类"等下去没有用"

界面在「作业状态」那一行会带上 Slurm 给的排队原因（`Reason=`）。**要分清哪一类**：

| 原因 | 意思 | 该做什么 |
|---|---|---|
| `Resources` / `Priority` | 在等空闲资源 / 优先级不够 | 等，或者要更少资源 |
| `Dependency` / `Reservation` / `Licenses` | 在等前置作业 / 预约时段 / 许可证 | 等 |
| `ReqNodeNotAvail` / `NodeDown` / `PartitionDown` | 节点或分区不可用 | 等，或换分区 |
| **`JobHeldUser`** | **被（你自己）挂起了** | ★ **等没有用**。`scontrol release <job_id>` 放它走，或者取消 |
| **`JobHeldAdmin`** | **被管理员挂起了** | ★ **等没有用**。找管理员 |
| **`AssocGrp*Limit` / `QOS*Limit` / `AssocMax*Limit`** | **账户或你本人到了额度上限** | ★ **等没有用**。要等下一个计费周期，或者找管理员调额度 |

判定权在守护进程（它读 `Requeue=` 之类的字段），**客户端不做任何状态判定** ——
界面只把 `job_terminal` 与 `job_reason` 译成中文（`client/src/main/jobstate.js`）。
原因名认不出来时界面会**原样印出来**：Slurm 的原因有几十种、各站点版本不同，
给原文也比什么都不说强。

### 1b. 会话文件还没被守护进程看见（NFS 属性缓存，最长 60 秒）


这是**最常见也最容易被误判**的一类。作业在计算节点上写好了文件，守护进程在登录
节点上通过 NFS 读，而目录属性的缓存默认是 `acdirmax=60s` —— **会话登记最多延迟
60 秒**（`tools/check-cluster.sh` 会专门就这一项给 WARN）。

**怎么区分**：在**登录节点**上看文件到底在不在：

```bash
ls -l /shared/home/alice/.slurmate/sessions/
```

- 文件**已经在**，只是守护进程还没登记 → 就是属性缓存，等一下即可，不是故障。
- 文件**不在**，但计算节点上能看到 → 同样的原因，或者共享存储没挂全。
- 两边都没有 → 作业没写成功，去看作业日志里有没有
  「警告：写会话文件失败（NFS 不可写？）」（`cluster/run.sbatch`）。

想缩短首连的等待，就往挂载参数里加 `actimeo=5` 之类的显式值。

### 1c. 会话文件写了，但校验不通过

守护进程对每一项校验都有细粒度原因（`load_session_file()` 与
`validate_session()`，`cluster/slurmate-sessiond`）。校验失败会走
`reject()`：日志里立刻有一行 `拒绝会话 … : <原因>`，审计记 `rejected`，并且
**留一份取证副本**在 `rejected_dir`（默认 `/var/lib/slurmate-session/rejected/<uid>/`），
权限 `0600`、root 只读。

常见原因与含义：

| 原因 | 含义 |
|---|---|
| `not_yet` | 文件还不存在（正常的启动窗口） |
| `bad_json` | 写了一半或文件损坏 |
| `mode_too_open` | 会话文件权限不是 `0600` |
| `hardlinked` | 硬链接数不为 1 |
| `uid_mismatch` | 文件属主不是本人 |
| `port_not_in_candidates` | 端口不在守护进程分配的候选集里 —— 伪造的核心判据 |
| `node_mismatch_with_slurm` / `node_ip_mismatch_with_slurm` | 会话文件声称的落点与 Slurm 的实际情况不符 |
| `schema_mismatch` | 客户端/作业脚本版本与守护进程不匹配 |

**注意一个诊断上的空档**：在等待期间（`submitted`，还没超时）守护进程**不打日志**，
只在超过 `submitted_ttl_seconds`（默认 1800 秒）之后才把原因写进 `note`：

```bash
slurmate status --json      # 看 note 字段，形如 enroll_timeout:not_yet
```

超时的处置是记 `expired` **并 `scancel` 掉作业** —— 因为 `expired` 不在
`phase_running` 的扫描集合里，不取消的话没人会再回收它
（`cluster/slurmate-sessiond`）。

**若这就是你要的**（比如只想看看到底为什么），可以盯审计日志与守护进程的
warning 行，它们在 `rejected` 与 `expired` 时都会说话。

---

## 二、`goodbye` 返回 ok，但作业还在跑

**症状**：客户端点了「结束会话并释放资源」，界面走完「正在释放… → 已结束」，
但 `squeue -u alice` 发现作业还在。

**这是当前实现的已知行为，不是你的操作问题。**

原因链条：

1. `op_goodbye` 调 `scancel`，但**丢弃了它的返回值**
   （`cluster/slurmate-sessiond`；`Slurm.cancel()` 在失败时只写一行
   warning）；
2. `phase_release` 只做「删规则 → 删会话文件 → 置 `released`」，
   **从不确认作业是否真的没了**（`cluster/slurmate-sessiond`）；
3. 记录在 `released_keep_seconds`（默认 600 秒）后被 GC 删掉
   （`phase_gc()`），此后没有任何人会再想起这个作业；
4. 续期只对 `enrolled` 且心跳新鲜的会话生效（`maybe_renew()`），
   所以它也不会被续命。

**最终结果**：作业会一直占着节点，直到它的 `TimeLimit` 到期被 Slurm 自然杀死。
`--no-requeue` 已经写在作业模板里（`cluster/run.sbatch`），所以不会重排队。

**怎么做**：

```bash
squeue -u alice                                  # 确认作业是否真的还在
scontrol show job <job_id> | head -20
sudo journalctl -u slurmate-sessiond | grep -i 'scancel\|goodbye'
scancel <job_id>                                 # 手工收尾
```

如果日志里有 `scancel <id> 失败: …`，那一行的 `stderr` 就是根本原因
（最常见的是 Slurm 控制器当时不可达，或者权限问题）。

**客户端为什么不能自己宣布成功**：`released` 只代表「守护进程那边拆干净了」，
不代表「作业停了」。所以界面把「正在释放」和「已结束」当成两个状态，
并且在超时/失败时明确说「作业可能仍在运行」（`client/src/main/session.js`）。

**根治**需要在 `op_goodbye` 或 `phase_release` 里确认作业已停 —— 这是集群侧的
已核实缺陷，**编号 F12 / F13**，机理、后果与两条修法都在
[KNOWN-ISSUES.md](KNOWN-ISSUES.md)。**本文不重复那两条，只讲怎么分辨与收尾** ——
按编号去查，不要在这里找第二份描述。

---

## 三、nft 规则消失

**症状**：`slurmate doctor` 报「规则与会话一致 ✗」，或者 `rules_count` 小于
`active_sessions`。**用户本人通常毫无感觉** —— 因为规则的策略是 `accept`，
规则没了只会**悄悄失去保护**，不会报错（`reconcile()` 的注释，`cluster/slurmate-sessiond`）。

**三个常见成因**：

1. **`nftables.service` 被 reload。** 它的 `ExecReload` 是
   `nft 'flush ruleset; include ...'` —— 会清掉**整台机器上所有表**的规则集，
   包括本服务的（`cluster/slurmate-sessiond.service.in`）。这也可能是
   `systemctl restart nftables`、或有人手工 `nft flush ruleset` 造成的。
2. **有人只删了链**（`nft delete chain inet slurmate output`）而表还在。早期实现
   在这种情况下会直接返回「表在，不用管」，之后所有 `add rule` 都失败、对账每 tick
   提前返回、**后续所有清理阶段被跳过** —— 新会话拿不到 ACL、孤儿规则永远不删，
   而进程看起来「健康」、不会重启。现在 `ensure()` 逐项补齐表/链/基础规则
   （`cluster/slurmate-sessiond`）。
3. **有人手工 `nft delete table inet slurmate`。** 卸载流程不会这么干（它先确认
   服务已停），但手工排障时有可能。

**怎么做**：

```bash
slurmate doctor
nft list chain inet slurmate output                 # 看规则与两条 slurmate-base-* 还在不在
sudo systemctl restart slurmate-sessiond            # 自愈：先反推恢复，再对账收敛
```

自愈机制本身是自动的，正常情况下你不需要动手：

- 单元里有 `PartOf=nftables.service`，nftables 重启时本服务会跟着重启，表被重建
  。**刻意不用 `BindsTo`** —— 那会让 nftables 启动失败时本服务也起不来。
- 每个 tick 都跑一次对账：多出来的规则删掉（fail-secure，宁可少放行），缺失的规则补上
  （`cluster/slurmate-sessiond`）。
- 启动时先 `recover_from_rules()` 从规则 comment 反推重建记录，**再**对账 ——
  顺序反了的话对账会把它们当孤儿删掉。反推出来的记录标
  `trust='recovered'`，**永不参与自动 `scancel`**。

**预防**：部署脚本**绝不**执行 `nft flush ruleset`，也绝不 reload/restart
`nftables.service`（`cluster/deploy.sh`）。`tools/check-cluster.sh`
会检查 `/etc/nftables.conf`（RHEL 9 上是 `/etc/sysconfig/nftables.conf`）里有没有
`flush ruleset`，有就给出 WARN。

---

## 四、登录后立刻 302 跳回登录页

**症状**：隧道通了、页面出来了，但立刻跳回登录表单；或者提示
「自动登录失败（HTTP 200，未拿到会话 cookie）」。

**原因**：这个服务在**口令错误时返回的是 HTTP 200**，只是没有 `Set-Cookie`。
任何 `if (status === 200) 成功` 的写法都会在口令错时报成功
（`client/src/main/weblogin.js`）。

所以判定成败**只能看 cookie jar**，不能看状态码，也不能解析响应头的
`set-cookie`（Electron `net` 模块在这件事上不可靠，查 jar 既避开这个坑，
又更贴近真正关心的问题 —— cookie 到底进没进去，`client/src/main/weblogin.js`）。

★ **这条判据留在框架里，而不是插件里**：它不是 code-server 的性质，是**网页表单
登录这一类协议**的陷阱 —— 换个服务（Jupyter 那一类）一模一样。所以基座实现的是
「POST 一个表单、然后查 cookie」这个通用机制，而**往哪 POST / 字段叫什么 / 看哪个
cookie 这三条具体值**由插件清单里的 `contributes.login` 自述。基座一个字都不知道
code-server 是什么。

**怎么做**：

```bash
# 1. 拿到守护进程认为的当前口令
slurmate status --json                     # data.session.auth_password
slurmate wait --session <session_id>       # 人类可读，会直接打印口令

# 2. 与计算节点上的会话文件对照（文件是 0600，属主本人）
cat ~/.slurmate/sessions/job-<job_id>.json

# 3. 直接验一次登录契约
curl -i -X POST -d 'password=<口令>' http://127.0.0.1:<本地端口>/login
#    正确 → 302 + Set-Cookie；错误 → 200 且【没有】Set-Cookie
```

按结果分三种情况：

| 现象 | 原因 | 怎么做 |
|---|---|---|
| 两个口令一致，但仍然登不上 | 那个服务升级后改动了登录端点、表单字段名或 cookie 名 | 客户端与它的版本耦合面**只有**这三样。改的是**插件的清单**（`contributes.login` 的 `path` / `field` / `cookie`），**不是客户端源码** —— 见 [`plugins/code-server/README.md`](../plugins/code-server/README.md) |
| 守护进程返回的口令与作业文件里的不一致 | 作业重启过（`slurm_restart_number`），或会话文件被重新写过 | 用文件里的那份；必要时重启会话 |
| 守护进程**不返回** `auth_password` | 会话不在 `ACL_STATES`（`cluster/slurmate-sessiond`），或 NFS 抖动导致读不到 | 等一个 tick；若持续，按第一节排查会话文件 |

**还有一个容易搞混的情况**：`auth_mode = none` 时客户端**不发** `POST /login`
（`plugins/code-server/client/index.js` 的 `attach`）。若服务端实际是 `password`
而客户端以为是 `none`，用户就会看到一个没人替他登录的登录页。核对两边的
`[plugin:<短名>]` 块里的 `auth_mode` 与 `status` 返回里的 `auth_mode` 字段。

---

## 五、隧道连上但页面空白

**症状**：本地端口在监听，`curl` 能连上，但页面一直转圈或全白，**没有任何报错**。

**最可能的原因：`tunnel_target` 变了，客户端还在往旧目标转发。**

作业重启/重排后可能换节点或换端口。守护进程会跟着把 ACL 换到新目标
（`refresh_enrollment()`，`cluster/slurmate-sessiond`），客户端也会在状态
轮询里重建隧道。**不做这件事的表现正是「页面卡住、没有任何报错」**
（`client/src/main/session.js`）。

**怎么做**：

```bash
# 1. 看守护进程认为的当前目标
slurmate status --json        # data.session.tunnel_target

# 2. 与界面状态条里的「隧道目标」对照
#    不一致 → 等一个 status 周期（30 秒）让它自己重建，或点「重新加载页面」

# 3. 分清是隧道的问题还是 code-server 的问题
curl -i http://127.0.0.1:<本地端口>/healthz
```

| `curl` 的结果 | 结论 |
|---|---|
| `200` 且页面仍空白 | 隧道是好的，问题在 code-server 页面本身（见下） |
| 连接被拒 / 挂起 | 隧道没建起来。看状态条里「隧道」是不是「断开，重试中」—— 那是遮罩会出现的路径 |
| 连上了但返回 5xx | code-server 侧的问题，看作业日志 |

其他会导致空白的路径：

- **code-server 页面进程崩了。** 面板会提示
  「code-server 页面崩溃了（<reason>）」，点「重新加载页面」恢复
  （`client/src/main/windows.js`，`client/src/main/index.js`）。
- **换过本地端口。** 端口变了 `origin` 就变，浏览器按端口隔离本地存储，
  编辑器的布局与最近打开的文件会重置一次。客户端会明确告诉你这一点，而不是让你
  自己纳闷「怎么布局又乱了」（`client/src/main/session.js`）。
  端口只会因为两个原因变：**它被别的程序占走了**（客户端向后顺移，顺移时会跳过
  其他布局组占着的端口），或者**你在界面上把这条连接切到了另一个布局**
  （见下节「布局组」）。
- **兜底：重新加载页面**（`Ctrl+Shift+R`，这是外壳自己占用的键，
  `client/src/main/shortcuts.js`）。

---

## 六、中文输入法在会话窗里失效

**先分清是「打不出候选」还是「完全没反应」** —— 两者原因完全不同。

### 6a. 完全没反应（按键没到编辑器）

**原因：焦点。** 遮罩（隧道断线提示）移除后必须把焦点还给 code-server 视图，
否则用户打字没反应 —— 又一个「看起来正常但就是不工作」的静默失败
（`client/src/main/windows.js`）。

**怎么做**：用鼠标点一下编辑区；或点状态条上的「重新加载页面」。
如果点了编辑区就恢复正常，那就是这一条。

### 6b. 拼音组合被吃掉（候选框不出现，或出现即消失）

**原因：按键拦截器没有放行组合状态。** 拦截器的第一行**必须**是
`if (input.isComposing) return;`（`client/src/main/shortcuts.js`）——
否则拼音输入过程中的按键会被吞掉，中文输入法直接废掉。这是这类拦截器最经典的
事故（`client/src/main/shortcuts.js`）。

**怎么自查**：

| 按什么 | 期望行为 |
|---|---|
| `F12` / `Ctrl+Shift+I` | 被外壳吞掉（诊断面板里会出现一行「已拦截」） |
| `Ctrl+Shift+R` | 被外壳接管 → 重新加载页面 |
| 中文输入法打拼音 | **什么都不能被吞** —— 组合期间一律放行 |
| `Ctrl+W` / `Ctrl+P` / `F5` | 直达页面，由 code-server 处理 |

开发者模式下有一个按键回显页，可以直接左右对照（`client/README.md`）：
中文输入法打拼音时**两栏都不该出现**。

**改这条代码时的纪律**：黑名单**默认方向是放行**，每加一条就多一份吃掉输入法或
抢走编辑器快捷键的风险。刻意不加缩放键（`Ctrl+=` / `Ctrl+-` / `Ctrl+0`，
VS Code 自己绑了它们），也不加 `Ctrl+P` / `Ctrl+W` / `Ctrl+R` / `F5`
（`client/src/main/shortcuts.js`）。

---

## 七、`code 9 / kind: "internal"` —— 兜底异常怎么查

**症状**：某个 op 总是失败，返回 `code 9`、`kind: "internal"`，
`detail` 形如 `'Config' object has no attribute 'job_log_subdir'`。

**这是什么**：`code 9` 是守护进程的兜底错误码 —— 它表示**代码抛了一个没有被
预期处理的异常**，不是"你的操作有问题"。所以排查方向是看回溯，不是看配置。

```bash
journalctl -u slurmate-sessiond | grep -A 30 'RPC .* 处理异常'
```

审计日志里对应的事件（如 `submit_failed`）也会带上下文。

**历史案例，值得作为模式记住**：某版本里 `slurmate.conf` 写了
`job_log_subdir`、`Slurm.submit()` 也读它，唯独 `Config.__init__` 从来没把它
从配置里取出来。于是**每一次提交都失败**，而错误信息里没有任何与"日志路径"
有关的线索 —— 因为抛出点在使用处，不在读取处。

> **这类缺陷的模式是：一个配置项要在三处对齐 —— 示例配置、读取处、使用处。**
> 少任何一处，都会变成一个只在运行时才炸、且错误信息指不到根因的洞。
> 加新配置项时请顺带确认这三处，并在 `cluster/test-sessiond-logic.py` 里加一条断言。
>
> 这个模式还有个近亲：**作业模板读的环境变量**。守护进程传了一个变量、作业模板
> 用了它，但两边对"缺失时怎么办"的默认值不一致 —— 同样不会报错，只会行为微妙地不对。

---

## 八、其他常见故障

### 提交报「端口池暂时没有可用端口」（code 5 / `no_port`）

端口池被活跃会话的**整个候选集**占满了。记住 `active_ports()` 把每个会话的
`candidates_per_session` 个候选**全部**算作占用（`cluster/slurmate-sessiond`），
所以粗略下限是 `池大小 >= 并发会话数 × candidates_per_session`。

```bash
slurmate doctor                      # 看 port_range
# 看有多少端口真被占着
nft list chain inet slurmate output
```

处置：调大 `[ports] range_start/range_end`，或调小 `candidates_per_session`，
或先收掉一些陈旧会话。注意**改了端口区间必须重新跑 `deploy.sh`**（预检与单元渲染都
读配置）。

### 作业起来了但立刻失败，会话变 `expired` / `rejected`

去看作业日志，它把失败原因分成了可区分的几类（`pick_port_and_start()`，
`cluster/run.sbatch`）：

```
候选端口全部失败: 共 6 个（区间外 0 / 被占用 6 / 启动失败 0）
```

- **区间外** 不为 0 → 候选端口不在 `SLURMATE_PORT_MIN/MAX` 之内（配置不一致）。
- **被占用** 占多数 → 同节点上有别的作业占着这些端口。正常情况应该自动试下一个；
  全部被占说明候选太少或池太小。
- **启动失败** 占多数 → 看上面的行里那个服务自己的报错。**这一段是插件的**，
  宿主只负责把端口逐个试过去，所以具体报错格式取决于哪个插件：
  - 可执行文件路径不对（站点的 `[plugin:<短名>] bin` 要写**计算节点上**的路径）；
  - 日志里只有一句语焉不详的 IPC 报错 —— 那是 code-server 的环境变量让它去附着到
    已有实例而不是启动新进程（`plugins/code-server/job/start.sh` 会清掉那些变量，
    正常路径下不该出现）。
- **每个候选都白等 45 秒**再失败 → `curl` 不在计算节点上
  （`plugins/code-server/job/start.sh` 的就绪探测要用它）。sshd 插件的等待窗口
  是 20 秒，不需要 `curl`。

### 开第二个会话被拒 —— 而拒绝的那句话分**两种**，该做的事完全不同

客户端现在能同时挂着几个会话（见 `docs/ARCHITECTURE.md` 的〈一个窗口里可以同时活着
几个会话〉）。第二个起不来时，先说清是哪一种：

**① 客户端这一侧：那个「位置」已经被占了。** 话里会**点名**是哪一个会话挡着，
比如「「开发环境」正占着「工作区」这个布局组」。根因是**一个布局组 = 一个本地端口
= 一份浏览器存储** —— 同组的第二条会把第一条的端口与存储当场抢掉，所以基座在
**提交之前**就拒了。出路：先结束那一个，或者到「布局」那一栏换一个组。

★ 还有一类不带布局组的插件（比如中转站）：它们共用**一个**位置（同一个 ssh 别名、
同一个基准端口），所以同一时刻也只能有一个 —— 那句话里说的是「正占着中转站的位置」。

**② 控制节点那一侧：`max_sessions_per_user`。** 话是「已经有 N 个会话占着位置
（本站上限 M）」。这是**站点的资源政策**（见 `docs/CONFIGURATION.md`），缺省是 **1**
—— 也就是说**大多数站点上，第二个会话本来就开不了**，要管理员把那个键写大。
★ 「占着位置」**包括排队中的**：一个还在队列里的会话照样算一个名额。

★ 这两种话**长得很像**（都是"已有会话"），而该做的事完全不同（一个是"你自己结束
一个"，一个是"去找管理员"）。判据是**谁说的**：客户端说的那句会点名是哪个插件、
哪个布局组；控制节点说的那句会带上「本站上限」。

### 提交报 `bad_gres`，或者高级选项里没有我要的那张卡

GRES 的名字与型号**不是我们定的** —— 管理员在 `GresTypes` 与 `gres.conf` 里定。
所以这一类问题的第一步永远是**看这台集群上到底有什么**：

```bash
slurmate partitions                        # 每一列 GRES：有什么、每节点最多几个
sudo slurmate-sessiond --check             # 同一份清单，加上"读不到"时的原因
scontrol show node -o | grep -o 'Gres=[^ ]*' | sort -u   # 原始输出
```

三种表现，分别对应三件事：

| 表现 | 含义 | 处置 |
|---|---|---|
| 高级选项里 GRES 那一格只有「（不占）」 | 服务端**查不到**集群的 GRES（`scontrol show node` 失败/超时） | 看守护进程日志；这不是"集群没有卡"，是"我们没问到" |
| 选项里没有你要的那种，而 `slurmate partitions` 里也没有 | 这台集群**确实没有**那种 GRES | 找管理员（`gres.conf` 里加/改） |
| 能选，但提交回 `2 bad_gres` | 数量超过了那一项**每节点**的上限 | 数量改小，或换一个每节点卡更多的分区 |

> ★ **上限是分区的、而且是"每节点"的。** `--gres=gpu:N` 在 Slurm 里是**每节点** N 个；
> 一个分区"一共 8 张、每台 4 张"时，一个作业最多只能要 **4** 张。界面数量那一格的
> `max` 就是按这个数填的，而它来自服务端那份清单 —— 不是客户端写死的。
>
> ★ **超上限是拒绝，不是悄悄截断。** 你要 16 张而它给你 4 张的话，看到的是一个
> "跑得起来但不是你要的"作业；分区选错了可以换，资源悄悄变少没法察觉。

> ★ **选了 GRES 就必须填数量**（服务端不替用户猜要几个）。不占 GRES 就把那一格
> 留在「（不占）」上。

### 提交超时之后出现了两个作业

**原因**：`op_submit` **非幂等**，每次调用都生成新 `sid`、插新行、提交新作业；
而 `count_active()` 只数 `ACL_STATES`，`submitted` 不在内 —— `max_active_per_user`
拦不住并发的第二个提交。

**正确做法**（客户端已经这么做了，`client/src/main/session.js`）：
`submit` 超时**绝不重试**，改为调一次**不带 `session_id`** 的 `status` 认领
已创建的会话。

**已经发生两个作业时**：

```bash
squeue -u alice
slurmate list                    # 看是不是两条记录
scancel <多出来的 job_id>
```

### 会话被 `scancel` 了（状态 `orphaned`）

**原因**：客户端心跳中断超过 `orphan_after_seconds`（默认 1800 秒）。
判活只看客户端经 unix socket 发的心跳，**完全不读**作业写的 `.jobhb` 文件。

```bash
sudo journalctl -u slurmate-sessiond | grep -i '心跳中断\|orphaned'
```

要区分两种情况：

- 客户端真的不在了（进程被杀、机器断电）→ 这是设计要的行为，资源该回收。
- 客户端还在，但心跳送不出去 → 多半是登录节点不可达或守护进程在重启窗口里。
  200 秒到 1800 秒之间有整整 25 分钟的「`suspect` 但不动作」的窗口，
  就是给这种情况留的。

### ★ 作业被重新排队了（状态 `REQUEUED` / `PREEMPTED` / `SPECIAL_EXIT`）

**症状**：界面上的「作业状态」先是变成「被抢占，正在重新排队」，过一会儿又变回
「运行中」，而后面的「已重启 N 次」多了一次。

**这是正常的，会话不会断。** 被重新排队的作业**还会回来**，所以守护进程
**保留**这个会话与它的 ACL —— 不删规则、不删会话文件（判据是 `Requeue=`，
见 [ARCHITECTURE.md](./ARCHITECTURE.md) 的 §3.1）。作业重新跑起来之后会写一份
**新的**会话文件（可能换了节点或端口），`refresh_enrollment()` 跟着把 ACL 挪过去。

**★ 但有一件事用户必须知道**：重新跑起来的是**新的进程**，原来那个已经没了 ——
在 code-server 里没保存的东西不会回来。界面上那句「已重启 N 次」就是为这件事说的。

**要注意的边界**：作业模板里写着 `--no-requeue`（`cluster/run.sbatch`），
所以**正常路径下不会有重排队**。真的出现 `REQUEUED` 说明作业是被别的东西重新
提交的（管理员 `scontrol requeue`、或者站点改了 `PreemptMode=REQUEUE`）——
那时上面这套保留逻辑就是唯一让会话活下来的东西。

### ★ 「作业状态」一直不动

**症状**：界面上的作业状态长时间停在同一个值（尤其是「排队中」或「正在收尾」）。

先按 §1a.1 看**排队原因** —— 里面有三类是"等下去没用"的，那才是最可能的情况。

真正的"卡住"只有一种：作业停在一个只该持续几秒的状态上（`COMPLETING` /
`STAGE_OUT` / `SIGNALING` / `RESIZING`），那说明 epilog 挂住了。守护进程会在
`stuck_job_seconds`（缺省 1800 秒）之后写一条 `job_stuck` 审计并打一行 warning：

```bash
sudo tail -50 /var/log/slurmate/audit.log | grep job_stuck
sudo journalctl -u slurmate-sessiond | grep '停留'
```

**★ 守护进程不会因此释放会话**，这是刻意的：作业是集群的，而拆掉的防护是不可逆的。
要收尾得由人来点：

```bash
slurmate list                      # 找到会话
scancel <job_id>                   # 或者让作业真的结束
```

### 续期一直失败，作业在到期时静默消失

```bash
sudo journalctl -u slurmate-sessiond | grep -i renew
sudo tail -200 /var/log/slurmate/audit.log | grep renew_failed
```

`renew_failed` 说明 `scontrol update JobId=… TimeLimit=+…` 没成功。
最常见的原因是**守护进程的 root 没有 Slurm operator 权限** ——
增加 `TimeLimit` 只有 root/Slurm 管理员能做，这正是续期必须由守护进程承担的
原因（`cluster/slurmate-sessiond`）。

注意续期有 **300 秒冷却**，失败时不会每 tick 重试刷屏，
所以日志里不会很密集。另外 `TimeLimit=UNLIMITED` 的作业不会被续期，
超过 `renew_max_total_seconds` 之后会记一条 `renew_exhausted` 并停止。

### 「控制节点记录的心跳已过期 N 秒」

这是客户端做的一条交叉校验（`client/src/main/session.js`）：
`status` 返回的 `last_hb_at` 落后本地最近一次成功心跳超过 90 秒，
说明**心跳根本没落地**（比如守护进程在写数据库之前崩了）。

看到它就说明：客户端在发、守护进程没记。检查守护进程是否在
`Restart=always` 的循环里反复重启：

```bash
systemctl status slurmate-sessiond
journalctl -u slurmate-sessiond | grep -i '已退出\|daemon_start'
```

### 「控制节点上已找不到该会话，心跳停止」

客户端收到 `code 3`（`session_gone`）后的提示。这时**不能因此判定作业已停** ——
它只说明守护进程的数据库里没有这条记录了（可能被 GC 掉了，也可能数据库丢过）。

```bash
squeue -u alice                  # 作业可能还在跑
```

数据库丢过的情况下，守护进程启动时会先从 nft 规则反推恢复
（`recover_from_rules()`，见第三节）。反推出来的记录没有 `job_id` 之外的上下文，
所以不能被客户端「接管」。

### 用户被熔断静默（code 4 / `throttled`）

在 `reject_window_seconds`（默认 600 秒）内被拒超过 `reject_threshold`（默认 20 次），
该 uid 进入 `throttle_seconds`（默认 1800 秒）的静默期。

```bash
sudo grep throttled /var/log/slurmate/audit.log
sudo grep rejected  /var/log/slurmate/audit.log | tail -30
```

先解决**被拒的原因**（见第一节的 1c 表格）—— 静默期只是防止刷屏的熔断，
不是根因。客户端的处理是退避重试（60000 ms），不弹错给用户
（`client/src/main/classify.js`）。

### 面板上「剩余时间」显示「未知」

这是**如实反映**而不是 bug。守护进程在 `show_job` 失败时会让
`expires_at` / `job_state` / `time_limit` 这几个键**整个不存在**
（`cluster/slurmate-sessiond`），界面必须容忍 `undefined` 并显示「未知」，
而不是显示 `0` 或 `NaN` —— 后者会让人以为会话要到期了
（`client/src/renderer/panel.js`）。

### 本地监听端口不是首选端口

`tunnel.js` 在首选端口被占时会向后试最多 20 个
（`client/src/main/tunnel.js`）。换端口意味着 `origin` 变了，
编辑器布局会重置一次，客户端会明确告诉你原因。
在 Windows 上 `EACCES` 很常见（Hyper-V/WSL 会保留大段端口），
所以它对 `EADDRINUSE` 和 `EACCES` 一视同仁地继续试。

**顺移会跳过其他布局组占着的端口。** 每个布局组在配置里绑一个本地端口；两个组
声称同一个端口的话，每次启动谁先绑上谁赢、另一个再顺移，布局就会在两个 `origin`
之间反复横跳 —— 而界面上一切正常。所以 `_listen` 拿到的排除集是
`usedLayoutPorts(cfg, 目标组id)`：**目标组自己不在里面**，否则它自己的端口会被
当成「别人的」，永远绑不上。

**顺移的结果不写回配置。** 布局组那个端口是它在**被创建时**定下来的、此后只读
（`client/src/main/config.js` 的 `nextLayoutPort`）—— 模块里根本没有改它的函数。

★ 所以顺移是**暂时**的：占着首选端口的那个进程退出之后，**下一次启动就绑回原来
那个端口，原来那份编辑器布局也跟着回来**。客户端在顺移时会明确告诉你这一点
（不然你会以为自己的环境被永久搬走了）。

★ 反过来说，「这次布局又重置了」只发生在**这一次**会话里。把顺移后的端口记下来
会更糟：那等于把一次暂时的冲突变成永久的 `origin` 变更 —— 冲突消失之后 `origin`
也回不去了，而那份布局本来是可以回来的。

---

## 版本

### 连不上，报「集群上的服务端是 X，而这个客户端是 Y」

**这不是故障，是一条要求。** 基座版本同一个大版本内，**服务端要求客户端不低于
它自己**（两端是一起升的，而这个客户端不保证读得懂更新的一版）。规则全文见
[docs/PROTOCOL.md](PROTOCOL.md)〈三方：谁不低于谁〉。

**该做什么**：升级这个客户端，然后重连。别的动作都没有用 —— 那条连接在判定不通过
时**就已经关掉了**（所以不会有一条"连上了但不许用"的连接占着守护进程）。

★ 两件事顺手说清：

- **同一个大版本内，客户端比服务端新是正常的、也是被承诺过的**：管理员可以在
  同一个大版本内自由升服务端，而不会打掉任何一个客户端。这条提示只会在
  **客户端落后**时出现。
- **两个大版本不同时不会拦你**，只会明确说明一句（"不一定兼容"，不是"不兼容"）——
  一个人连多个集群（一个 1.28、一个 2.5）是正常的，拦住它等于把"我们不知道"
  说成"不行"。

### 报「没有问到站点的基座版本」/「站点答的版本号不合 x.y 的形状」

两句话说的是**两件不同的事**，都不拦人，但都不许被忽略：

| 报错 | 意思 |
|---|---|
| `没有问到…（对面的守护进程没有 ping 这个 op）` | 对面的守护进程**比这个客户端旧**。★ 这不会让判定变松：一个连 `ping` 都没有的守护进程不可能比客户端新 |
| `站点答的版本号 … 不合 x.y 的形状` | **这条链路上答话的恐怕不是 Slurmate 的守护进程**。这一句**不谈版本** —— 别去查版本，去查那条链路（`slurmate rpc` 跑的是不是本站装的那个程序） |

★ 两者都会**明说"这一次没有做版本判定"**：那不是"通过了"，是"没判"。这个项目的
纪律是"没有参与校验"必须显式说出来，而不是长得像通过。

## 插件

**插件这一块的问题另有一篇：→ [PLUGIN-TROUBLESHOOTING.md](PLUGIN-TROUBLESHOOTING.md)。**

拆开是因为读者不同：这一篇是**会话使用者**（IDE 连不上、页面空白、输入法失效），
那一篇是**装插件的人**与**被分发的用户**（"本站要给你装一个东西，你同意吗"）。
两边都会用到「`slurmate rpc` 没反应」，但只有在一边能查站点上的包。

★ **这一篇从前把那一整块写在这里**（约 300 行，占全篇的三分之一），于是"输入法
打不出候选"和"安装器拒绝了我下载的包"挤在同一份文件里 —— 而它们的读者、需要的
权限、能跑的命令没有一样是重合的。

## 布局组（一个布局可以被多条连接共用）

**布局** = code-server 的编辑器窗口布局、打开的标签页、登录状态。它存在浏览器里，
而浏览器按 **origin**（`http://127.0.0.1:<本地监听端口>`）隔离本地存储 ——
所以「换端口 = 丢布局」是物理事实，不是客户端的实现选择。

客户端把这件事变成可控的：**一个布局组 = 一个本地端口 = 一份布局**，若干条连接
可以共用一个组（多对一），没有任何连接在用的组会被自动回收 —— **连同它名下的插件
数据一起**（浏览器存储 + 插件写在磁盘上那个目录，见下）。

**症状 → 结论：**

| 症状 | 原因 |
|---|---|
| 换了一条连接，布局和上次那条一样 | 两条连接落在**同一个布局组**里（默认行为：新连接落到当前活跃连接所在的组）。★ 这也意味着**另一台集群**的数据会落到同一个 `origin` 上，除非你把它指到另一个组 |
| 切换连接后布局变了 | 两条在不同的组。组的名字和成员在「连接与布局」那张图上写着 |
| 某个布局不见了 | 它最后一个使用者被切走或删掉了，引用计数归零 → 回收，连同它的浏览器存储**和插件写在磁盘上的那份数据** |
| 删掉一条 ssh 条目之后，某个插件的设置/缓存也没了 | 那是**最后一条**用那个布局组的连接 —— 那个组连同它的数据一起被回收了（删除确认框里写着这一条）。还有别的连接用着那个组时，数据留着 |
| 界面上说「本机有 N 份插件数据没人在用」 | 那是**残留**：属于一个已经不在本机的插件版本、或者属于一个已经删掉的插件。它们**不会再被任何东西读到**，所以可以删掉；删掉**找不回来**（那个插件下次打开是一份全新的空白存储）。想重置**正在用**的那一份，用布局下拉里的「＋ 新建空白布局…」 |
| **升级到 0.7 之后**布局和登录都回到初始 | 分区名的格式变了（多了插件 id 与共享组那两段），旧的那一份不再被读到。**预定的结局，不是故障**，见下 |
| IDM 的登录状态没了 | 同上，新组是**空**的。分区按这段数据的**完整身份**命名（`persist:<插件 id>@<共享组>@<组 id>`，见 `client/src/main/plugin-data.js`），而组 id 永不复用 —— 所以新建的空白布局真的是空白的 |
| 在 `Partitions/` 下**找不到**我那份数据 | 目录名是**折叠过**的（插件 id 那一段是小写）—— Electron 那一步是 `MakePartitionName` = `EscapePath(ToLowerASCII(...))`。按小写去找 |

**被回收时会发生什么、不会发生什么：**

- **会**：删掉这个组（`pruneLayouts`），并清掉它的浏览器存储 —— 那里面有
  code-server 的登录 cookie，留着是无主的凭据。
- **不会**：动正在被**任何一块**界面用着的那个分区。`clearLayoutStorage` 拿
  `livePartitions()`（一组，不是"前台那一个"）对一下，命中就直接豁免。少了这一步，
  用户当前的 IDE 会连 cookie 带 localStorage 一起被抽掉，而症状只是「页面莫名其妙
  坏了」。★ 多开之后判据**必须**是"一组"：前台不是它的时候，单个前台分区那一版形同
  虚设。
  ★ 而**用户主动删掉一份数据**是另一条路（界面上那个「删掉这一份」）：**正在被活
  会话拿着的那一份根本不会出现在那份清单里**（对账的 `held` 在算行的时候就挡掉了，
  两个根都挡），所以那条路上根本没有"点了没反应"这一格 —— 反过来说，**清单上有的
  就是真的没人用的**。★★ 而"正被用着"这件事**不能只看浏览器存储**：一个没有界面的
  插件、以及**临时副本**，在窗口里都没有位置 —— 只按分区去判，它们的那些数据会在
  活着的时候被摆上删除按钮。
- **不会**：动集群上的作业。切换布局只换本地端口和存储分区，
  **不发任何 RPC** —— `client/test/boot.test.mjs` 里那条「切换过程中 `backend.rpc`
  调用计数增量为 0」就是这件事的可自动化证明。

### 同一个插件开两份会发生什么

一个插件能不能同时开两份，由**插件作者**在清单里声明（`contributes.concurrent`）。
能的那一类（内置的 code-server 就是），你可以把同一个插件开两次 —— 而**第二份与第一
份不是一回事**，界面上会明说：

| | 第一份（"持有者"） | 第二份及以后（**临时副本**） |
|---|---|---|
| 什么时候成为第一份 | 你点「开始会话」时那个布局组上**没有**这个插件的活会话 | 那个组上**已经有**了 |
| 数据 | 那个组名下的那份，**持久** | 开局时第一份的**快照**，会话结束就丢 |
| 浏览器存储 | 那个 origin 的（你的登录、布局都在） | **空的** —— 新的本地端口就是新的 origin |
| 界面上 | 照旧 | 状态条上一条常驻提示「**临时副本 · 改动不会被记录**」（面板里也有一条） |

**你会看到 / 会遇到：**

| 症状 | 结论 |
|---|---|
| 第二份里要**重新登录一次** | 正常。客户端会自动做（每次会话真的跑起来都会跑一遍自动登录），不需要你输入什么 |
| 第二份里编辑器布局是新的 / 什么都没了 | 正常。它的起点是第一份**开局那一刻**的快照；之后两份各写各的，互不影响 |
| 第二份里改的东西，关掉再开就没了 | 正常，而且**这正是那条常驻提示在说的事**。想留住改动，改**第一份**（没有"临时副本"标记的那一条） |
| 第一份关掉之后，还开着的那一份**没有**变成第一份 | **故意的**。"谁持有那一份数据"只在开局那一刻定 —— 一个正在跑的会话手里的分区、数据目录、外面那个 origin 都是从它那个组算出来的，中途把身份挪到它头上等于在运行时搬家。关掉第一份之后再**新开**一条，那一条才是新的第一份 |
| 重启客户端之后，有一份数据的旧目录**没人用了** | 临时副本的那个实例键只活在那一次运行里。重启之后接回来的会话会拿一个**新**的实例键，于是重启前那份临时存储成了残留（面板上看得见、删得掉）。这是"临时"的应有之义 |
| 同一个插件只能开一份，第二份被拒 | 那个插件声明的是 `concurrent: false`（内置的 sshd 就是）。提示里会点名**是哪一个**占着那个布局组 —— 先结束它，或者换一个布局组 |

★ **别指望用多开来"开两个工作区各干各的"**：只有第一份会攒数据。真正想要"两份各自
攒各自的东西"的插件，这一格今天给不了（作者应当声明 `false`）。

★ **上限不在客户端。** 客户端只认"能不能"（作者声明的那一格），数量上限由**站点**
那一侧管（`max_sessions_per_user`）—— 撞上它的时候，提示是服务端那句
「已有 N 个活跃会话（上限 N）」，而不是客户端拒绝。

---

★ **旧版本（0.2.0 及更早）的布局不再被继承。** 那一版把布局存在 `persist:slot-1` 里、
监听在 `slots["1"].port` 上，v0.7 之前有一段迁移把它沿用下来（组 id 是字面量
`legacy-1`，`partitionForLayout` 里还有一条"迁移出来的组不改名"的例外）。**迁移和那条
例外都删掉了**（0.y 不考虑兼容性，见 `CHANGELOG.md` 的 0.7 那一节）。所以从那样的配置
上来会得到**一个全新的空白组**：端口回到基址、存储是另一个目录、编辑器布局是空的。

这是预定的结局，**不是故障** —— 界面不会报错，也没有东西"丢了"。

★ **升级到 0.7 时会同样地重置**一次编辑器布局（连登录 cookie）。原因与上面那条同源：
这份数据的身份从"布局组 id 一段"变成了"插件 id / 共享组 / 实例段"三段，于是分区名换了，
code-server 打开的是另一份**全新的空白**存储。旧的那一份还在磁盘上（在 Electron 的
`Partitions/` 下），只是不再被读到 —— 所以**它没有"丢"，是"不再被用"**。

这一步是**刻意的**：那段身份从前硬编码在 `ensureSurface` 的一个三元表达式里，作者一句
话都说不上；改成由插件自己在清单里声明（`contributes.data`）之后，分区名必然要换。
声明出来的结果是**长期行为不变**：code-server 仍然是"跨版本共享 + 按实例分"，所以
**这一次之后**再升级插件不会再重置。

---

## 排障命令速查

```bash
# 守护进程
systemctl status slurmate-sessiond
sudo journalctl -u slurmate-sessiond -f
sudo /usr/local/sbin/slurmate-sessiond --check --config=/etc/slurmate/slurmate.conf

# 会话
slurmate whoami
slurmate partitions
slurmate list
slurmate status --json
slurmate doctor

# nft
nft list chain inet slurmate output
nft list table inet slurmate
slurmate doctor            # 内含「规则与会话一致」

# Slurm
squeue -u alice
scontrol show job <job_id>
scontrol show node <node>
scontrol ping

# 插件与站点分发：那几条要 root（`--check-plugins`、包目录、.keys.json），
#   命令清单在 PLUGIN-TROUBLESHOOTING.md 里 —— 读者不同，权限也不同

# 作业侧（计算节点上写，登录节点上也能通过共享家目录看）
ls -l ~/.slurmate/sessions/
tail -100 ~/.slurmate/logs/job-<job_id>.log
cat ~/.slurmate/sessions/job-<job_id>.json     # 0600，含 tunnel_target 与口令

# 审计
sudo tail -100 /var/log/slurmate/audit.log
```

## 提交问题之前

请把这些一起带上，它们能覆盖绝大多数分层问题：

1. `slurmate doctor` 的完整输出；
2. `slurmate status --json`（**先自行确认里面没有你不想公开的口令字段**）；
3. `journalctl -u slurmate-sessiond -n 200` 的对应时间段；
4. `~/.slurmate/logs/job-<job_id>.log` 的尾部；
5. `nft list chain inet slurmate output`；
6. 客户端面板上的告警文案（它已经把「隧道断开」「心跳没落地」「会话已不存在」
   区分开了，比一句「连不上」有用得多）。

> 汇报时请遵守仓库的脱敏约定：不要贴真实 IP、域名、用户名、账户名与节点名。

---

## 排查不出来时

有些现象的根因是**已知的、但还没修** —— 它们按**编号**记在
[KNOWN-ISSUES.md](KNOWN-ISSUES.md)，每条写了位置、后果与修法。先扫一眼那里，
免得把一个已经写下来的缺陷重新发现一遍。

★ **按编号找，不要在这里找复述。** 编号是稳定的，复述不是：这一篇从前把
**F12 / F13** 的机理又写了一遍，而第二节已经把那个症状讲透了 —— 同一件事写两遍，
第二遍先漂，而漂了不会红任何东西。
