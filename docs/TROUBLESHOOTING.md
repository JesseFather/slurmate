# 故障排查

这个项目的所有设计注释都在反复讲同一件事：**最危险的故障是「看起来一切正常，
只是没有保护」**。所以本文的写法是「症状 → 原因 → 怎么做」，并且优先给出**能区分
两种可能原因的那一条命令** —— 大多数时候排障的难点不是修，而是确定到底坏在哪一层。

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
`job_query_failed` / `acl_orphan_removed` / `acl_reinstalled` / `throttled` / `recovered`。

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

`PENDING` / `CONFIGURING` 时守护进程**刻意什么都不做** —— 重排队不释放
（`cluster/slurmate-sessiond`）。若 `squeue` 已经查不到，那是在走
「作业查不到要连续确认」的路径（见第六节）。分区满、`QOSMaxJobsPerUserLimit`、
资源不足都会让作业长时间挂在 `PD`，这属于 Slurm 侧的问题，不是 Slurmate 的问题。

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
已核实缺陷，**编号 F12 / F13**，后果与修法写在
[KNOWN-ISSUES.md](KNOWN-ISSUES.md)。本文不重复那两条，只讲怎么分辨与收尾。

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

演示模式下有一个按键回显页，可以直接左右对照（`client/README.md`）：
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

顺移的结果会写回配置，日志里那句「已改用 <端口>」对应的就是它。

---

## 插件

### 站点开了某个插件，但客户端上根本没有那个按钮

**先分清是哪一种"没有"。** 这是 v0.6 之后最容易混起来的一处，因为"插件从哪来"
从一个变成了三个。界面会**分开说**（这是验收标准之一）：

| 现象 | 原因 | 该做什么 |
|---|---|---|
| 按钮在，但灰着 / 点了被拒 | **站点装了但没开**（`enabled = no`） | 找管理员 |
| 按钮根本不在，而站点确实开着 | **本客户端不认识**这个插件 | 升级客户端 |
| 按钮不在，别的机器上有 | **本机把它关掉了**（`~/.slurmate/config.json` 的 `plugins` 段） | 自己打开 |
| 界面上说「本站要给你 X，等你同意」 | **站点分了，你还没点同意** | 点同意（见下一条） |
| 界面上说「本站的守护进程太旧」 | 集群侧那份**比客户端旧**，没有分发的 op | 让管理员重新部署 |
| 界面上说「本机的开发者模式关着，而池里有」 | 你自己往 `~/.slurmate/plugins/` 放过一份 | 打开开发者模式那个开关 |

★ **后三种是"还没有"，前一种是"起不来"** —— 两件事，不要混。界面也分成两块画。

第三种最容易被当成前两种。客户端把站点有、而自己没有的插件列在 `plugins.missing`
里、画成一个醒目的块，而且打开会话时还会点名 —— 那是升级提示的唯一来源。

> ★ 那一栏判的是 **`(id, 版本)`**，不是名字。名字对得上而**版本对不上**，同样是
> "你用不了它"，而且更常见 —— 站点升级了插件而你的客户端还是旧的。这时界面上会
> 明说"站点用的是 1.2.0 版，本机这一份是 1.0.0 版"。
>
> ⚠️ **只有 `enabled = yes` 的插件才进这一栏。** 站点关掉的插件照样会被报出来
> （协议要求报全部），但它不是"你该去升级客户端"的理由 —— v0.6 修掉了这个：
> 以前"站点关掉一个插件"会被界面永远说成"站点有而本机没有 ⇒ 升级客户端"。

### 「本站要给你装 X，但我没同意」—— 同意闸做了什么

站点分发的插件，**在你点同意之前不会激活**。不同意的话：

- 文件**已经在你机器上了**（在暂存目录里，验完了），但**一个字节都没进插件池**，
  那段客户端代码**没有跑**；
- 界面上那个插件显示为"待同意"，不会出现在「开始会话」那一块里；
- 点**不同意** ⇒ 暂存目录被删掉，站点池里什么都没被碰过。

为什么要你点：**这个插件的客户端那一半会跑在你机器上，完整 Node 权限、没有沙箱**
（[SECURITY.md](../SECURITY.md) 的〈四条护栏的对账〉）。所以你同意的不只是"用这个
插件"，是"让这个站点的代码在你这台机器上跑"。界面就是这么写的，一个字都没含糊。

★ **同一个插件换了内容要重新同意一次。** 台账记的是
`(id + 版本 + 整目录摘要)`：站点只改文件不升版本号时，客户端会明确失败并说
「请管理员升版本号之后重新部署」，**它不覆盖、也不悄悄放行**。

★ 同意了之后想反悔：关掉那个插件（界面上那个开关）只是不再用它，**不会**把它从
盘上删掉 —— 站点池里的东西按引用计数回收，不由你一个人说了算。

### 同步插件失败（「没能把本站的插件取回来」）

对账的每一步都会把原因说出来，**不会只说一句"同步失败"**。按报错里的字样对：

| 报错里出现 | 原因 | 该做什么 |
|---|---|---|
| 「守护进程太旧，不支持插件分发」 | 集群侧那份没有 `files` / `package` 字段 | 让管理员重新部署。**这一条不是客户端的问题** |
| 「取 xx 失败：…」 | 那份文件没下来（断流、超时、守护进程限流重试到头） | 点「重新同步」。**它不会退回本机池那一份** —— 见下 |
| 「内容与声明的 sha256 不符」 | 传输被改，或者站点在服务期间换了包 | 点「重新同步」；反复出现就让管理员重跑 deploy.sh |
| 「本机已有 X，但它的内容与站点现在报的不一样」 | **站点改了内容却没升版本号** | 让管理员升版本号。**客户端拒绝覆盖是对的** |
| 「已经有一次对账在跑」 | 上一次还没收尾 | 等一会儿再点 |
| 「读不到站点的插件记录」 | `.sites.json` 丢了或坏了 | **这一次不会回收任何东西**（这是刻意的），其余照常 |

★ **下载失败绝不退回本机池。** 判据是"站点有没有这个能力"（协议里 `files` 字段在
不在），不是"这次成没成"。把两者合并，等于给一个能让下载失败的人（断流、丢包、
中间人）一个把用户降级到旧本地副本的开关 —— 攻击成本从"改内容"降到"让下载失败"。

★ **限流（`7 rate_limited`）不是失败。** 一次对账要发十来个请求（1 个清单 +
1 个会话列表 + 每个文件一个），正好压在守护进程的限流桶边上。客户端会自己退避
重试，不把它记成失败。

### 守护进程起不来，报「[plugin:xxx] 是个未知的插件」

两种原因，报错里会**分开说**，因为它们对应两种完全不同的行动：

| 报错里说 | 原因 | 该做什么 |
|---|---|---|
| 「本站**装了**的是：…」 | 块名打错了（`[plugin:ssh]` 少一个 d 也算），或那个插件**没装** | 改块名 / 把插件装上去 |
| 「本站**一个插件都没装**」 | 插件目录是空的 | 把 `.splug` 放进 `--plugins-src` 指的目录，再跑一次 `deploy.sh`（包要在作者机器上用 `packer build` 打出来，见 `packer/README.md`） |

守护进程**故意**不静默忽略 —— 静默忽略的后果是「配置里写着，而实际什么也没开」。

```bash
# 看装了什么（守护进程自己扫出来的那一份）
sudo /usr/local/sbin/slurmate-sessiond --check-plugins
```

### 守护进程起不来，报「default_plugin = xxx 在本站**没有装**」

配置文件里的 `default_plugin` 指向一个没装的插件。**这是启动错误，不是等到用户提交
才报错** —— 那不是"本站没开某个服务"，而是"配置指向一个不存在的东西"，两者的
后果完全不同。改掉它，或者留空（留空 = 提交时必须显式给 `service_kind`）。

### 用户提交时报「本站没有设置 default_plugin，提交时必须显式指定 service_kind」

配置里没写 `default_plugin`（这是**推荐值**）。要么写上一个：

```ini
default_plugin = code-server
```

要么让调用方显式给：`slurmate submit --service-kind code-server`。

★ 守护进程**故意**没有内建缺省，也**故意**不选"表里唯一那个"当缺省：隐式缺省会让
**装一个插件 / 卸一个插件**这种配置之外的动作悄悄改变行为 —— 今天提交成功的那条
命令，明天可能落到另一个服务上。

### 提交被拒：「本站装了「X」，但它没有作业侧实现」

守护进程回 `code 4 / service_kind_no_job`（[PROTOCOL.md](PROTOCOL.md)），客户端上
那个插件的按钮是灰的，并且就写着这一句。**这是合法状态，不是坏掉的插件**：那个插件
装上了、看得见、就是提交不了。

成因是**部署不完整** —— 它的包里没有 `job/start.sh`（所以在 `plugins/` 里有这个包、
在 `jobs/` 里没有对应那一份），或者有而 deploy.sh 那次没跑到它。

```bash
# 1. 看它到底有没有作业侧（判据是**包里的记录表**，不是磁盘上的一个文件）
sudo /usr/local/sbin/slurmate-sessiond --check-plugins      # 看那一行的「作业侧」
# 2. 有就重新部署一次，让 deploy.sh 为它织一份 <ULID>.sbatch
sudo bash cluster/deploy.sh
```

★ **这与"站点没开这个插件"是两件事，两句话也不同。** 那种情况报的是
`service_kind_disabled`，解除办法是管理员把配置块里的 `enabled` 打开；而这一条
**打开 `enabled` 没有用**，缺的是作业脚本。

### 作业起来了，日志里说「这份作业脚本提供的是 Y，而请求的是 X」

拿到**别的插件**的作业脚本了。这是 `deploy.sh` 部署出了问题（`jobs/` 与 `plugins/`
对不上），**不是插件本身的问题** —— 作业会以 **24** 退出而不是跑错服务。

```bash
# 逐个核对：每个插件的 ULID 在 jobs/ 里是不是恰好有一份
python3 /usr/local/sbin/slurmate-sessiond --check-plugins \
  --plugins-dir /usr/local/share/slurmate/plugins
ls /usr/local/share/slurmate/jobs/
sudo bash cluster/deploy.sh          # 重跑一次会清掉陈旧的、补上缺的
```

正常情况下这件事**在部署期就会被拦住**：deploy.sh 对每个 `job/start.sh` 断言三条
（无 shebang/`#SBATCH`、定义了 `start_<短名>`、函数名都带命名空间），任何一条不过
当场中止部署。所以看到这条通常意味着：**手工提交了作业**，或者 `jobs/` 是别人装剩
下的。注意 deploy.sh **不会**因为插件没有 `job/start.sh` 而中止 —— 那是合法的
（见上一条）。

### 守护进程起不来，报「块里有 'cluster_cidr'，它是站点通用键」

**块一旦开始就没有回头路。** 通用键必须写在所有 `[plugin:*]` 块**之前**；
写在后面会落进那个块，然后被拒。把那一行挪到文件顶部即可。

（`deploy.sh` 用 `sed` 抓的 `range_start` / `range_end` / `reserved_ranges` /
`readonly_paths` 也是按行首匹配的，所以它们同样必须待在文件上半部分。）

### 安装器拒绝了我下载的包

`slurmate plugin install`（`deploy.sh` 走同一条路）**一条都不装**时会说清是哪一条。
按报错里的字样对：

| 报错里出现 | 是什么 | 该做什么 |
|---|---|---|
| 「不是一个合法的插件包」 | 下载坏了、传丢了，或者那不是包 | 重新下载。★ 别拿**源码树**去装 —— 站点只收 `.splug`，包要在作者机器上 `packer build` |
| 「**签名验不过**」 | 包在下载或存放的过程中被改过（或作者发出来的就是坏的） | 重新下载一次；还是这样就让作者查 |
| 「本站**验不了**」 | 这台机器上没有 `openssl`，而这个包带签名 | 装上 openssl 再试。**不装是对的** —— "验不了"与"验过了"是两回事 |
| 「这个 id **上一次不是这么签的**」 | 换了签名者（§2.5）。**这是最要紧的一条** | 看下面 |
| 「超过本站的整包上限」 | 包装上去了也发不出去 | 让作者把插件做小一点 |
| 「**没有签名**」 | 不是错误，是提醒 | 装得上；但客户端上钉过公钥的用户会拒绝它 |

★ **「上一次不是这么签的」不要急着加 `--replace-key`。** 它意味着两件后果相反的事
之一：作者**换了钥匙**（而 §4.1 说丢了私钥只能 fork 自己，所以这不该发生），或者
**有人把包换掉了**。安装器判不了是哪一个，所以它停下来，把两把指纹都报出来让你去
核对。确认是前者之后：

```bash
sudo slurmate plugin install --replace-key <报出来的旧指纹> <包>
```

★ 而这一条**客户端那一侧还会再拦一次**：钉过公钥的用户钉的是**旧**那一把，他们会
拒绝新包，除非各自重新钉。所以"换了钥匙"从来不是一个能悄悄做完的动作。

★ **包被换过之后没重新部署**：守护进程在**启动那一刻**记下每一份的内容，
发出去的字节与那份记录对不上时会回 `9 plugin_file_changed` —— 那一句指回
`deploy.sh`，不是指回客户端。

### 升级之后一个插件都不见了

**先确认插件目录还在。** 插件是**独立项目**，装在
`/usr/local/share/slurmate/plugins/` 里，由安装器装进去 —— 目录里空了
（比如有人手工删了，或者部署时 `--plugins-src` 指到了别处），自然一个都没有。

```bash
ls -l /usr/local/share/slurmate/plugins/          # 应该是一串 <ULID>.splug
```

★ 每个文件都是一个**包**（作者用 `packer build` 打的），文件名是这个插件的
**id**。要装新的：把包放进一个目录，然后

```bash
sudo bash cluster/deploy.sh --plugins-src <放 .splug 的那个目录>
```

★ **装第一个包时，旧布局 `<名字>/plugin.json` 会被自动清掉**（安装器按
`.deployed` 标记迁移）。如果迁移之后这里**还有目录**，`--check-plugins` 会逐条
点名 —— 那种目录含有一整套客户端代码，而守护进程只读包，留着它等于一份
**看不见的副本**。确认无用之后人工删掉。

**再确认配置里没有把它关掉。** 一个 `[plugin:*]` 块都没有时，缺省取插件清单里的
`site.defaultEnabled`（code-server 是 true，与升级前一致）；但只要你写了
`[plugin:code-server] enabled = no`（或者只写了 `[plugin:sshd] enabled = yes`
并**同时**关了 code-server），那就只剩中转站。

★ **装了但一个都没开**、以及**一个都没装**，两种都是**合法状态**（守护进程照常
启动，已有会话照常能查能停），但 `--check` 会把它们明确说出来：

```
sudo /usr/local/sbin/slurmate-sessiond --check --config=/etc/slurmate/slurmate.conf
```

那一节会逐个打印每个插件的开关状态、默认资源、以及它的可执行文件解析到了哪里。

### 一个会话的服务类型显示为「未知」，只能结束它

那个会话是**本客户端不认识的插件**提交的 —— 常见于：站点装了新插件而你的客户端
还没升级，或者那个会话是别人/别的工具提交的（比如你换了一台机器）。

客户端**故意什么都不做**：那个端口上跑的可能是任何东西，拿口令去 POST 一个 SSH 端口，
或者给一个 HTTP 端口配主机公钥，两种都是系统在声称一件它并不知道的事。

**但隧道是接起来的**，所以你有两条出路：

```bash
# 看看那到底是什么
curl -i http://127.0.0.1:<本地端口>/
```

或者在界面上直接结束它。**它必须能被结束** —— 会话的状态/心跳/停止只认
`session_id`，一次都不查插件，这正是"卸载插件之后作业仍然收得掉"的依据。

### 界面上报「插件没有加载」

插件目录下的某个插件不合规，被跳过了。客户端有**两个**插件目录，报错里会写明是
哪一个：

| 目录 | 是谁的 |
|---|---|
| `~/.slurmate/site-plugins/` | **站点分发的**（可以按引用计数回收，你手改它没有意义 —— 下次对账会按站点的版本复原或报错） |
| `~/.slurmate/plugins/` | **你自己的**（只在开发者模式打开时加载；客户端永不自动动它） |

可能的几种不合规，报错里都会指名道姓：

| 报错里出现 | 是什么 |
|---|---|
| `不是合法的 JSON` | `plugin.json` 语法错 |
| `id 必须是 26 个字符的 ULID` | 身份是**铸造**出来的（`plugins/ulid.js`），随手编一个名字不行 |
| `有认不得的键` | 清单里打错了一个键名（`contribution` 之类）—— 刻意不静默忽略 |
| `本客户端是 x.y.z，不满足 …` | `engines.slurmate` 对不上，**装之前**就被挡下了 |
| `加载失败` | `client/index.js` 语法错或 require 了不存在的东西 |

**这是设计好的行为**：跳过它、记一条**并且报出来**、其余插件照常工作 —— 一个坏
插件不该把客户端带崩。报出来这一步同样要紧：不说的话，症状只是"加了插件它就是
不生效"，而用户一个字的线索都没有。

### 界面上报「有 N 份内容不同的副本在抢同一个 id 和版本」

两个**不同的**插件用了同一个 `(id, 版本)`。这时**两个都不加载** —— 客户端绝不挑
一个。

为什么这么严：插件池里 `(id, 版本)` 只有一个位置。挑错的后果是会话的解析键指过去、
客户端**静默地跑了另一个插件的代码**，而用户完全看不出来。宁可让它暂时不可用 ——
那种失败是**看得见**的（会话变成"未知服务"，但仍然接得上隧道、停得掉）。

常见成因：有人抄了别人的 `id`，或者改了插件内容却**没升版本号**。做法是删掉多余的
那一份，或者给改过的那份换一个新 `id`。

> 注意这条防的是**意外**，不防**恶意**。它保证"撞了会被发现并说出来"，不保证
> "撞不上" —— 任何人都能随手编一个长得一样的 id。防冒用要靠签名那一层，而
> **签名这一版没做**，理由与它成立的前提写在 [SECURITY.md](../SECURITY.md)
> 的〈站点分发的插件：四条护栏的对账〉。

> ★ **两个站点报同一个 `(id, 版本)` 而内容不同**，落到的也是这一条（池里那个槽位
> 只能装一份内容）。区别是它**在下载之前就被查出来**了，报错会直接说是哪个插件的
> 哪一版对不上、该让管理员做什么 —— 见下面的〈同步插件失败〉。这条仍然记在账上
> （[KNOWN-ISSUES.md](KNOWN-ISSUES.md) 的 F20）。

## 布局组（一个布局可以被多条连接共用）

**布局** = code-server 的编辑器窗口布局、打开的标签页、登录状态。它存在浏览器里，
而浏览器按 **origin**（`http://127.0.0.1:<本地监听端口>`）隔离本地存储 ——
所以「换端口 = 丢布局」是物理事实，不是客户端的实现选择。

客户端把这件事变成可控的：**一个布局组 = 一个本地端口 = 一份布局**，若干条连接
可以共用一个组（多对一），没有任何连接在用的组会被自动回收。

**症状 → 结论：**

| 症状 | 原因 |
|---|---|
| 换了一条连接，布局和上次那条一样 | 两条连接落在**同一个布局组**里（默认行为：新连接落到当前活跃连接所在的组） |
| 切换连接后布局变了 | 两条在不同的组。组的名字和成员在「连接与布局」那张图上写着 |
| 某个布局不见了 | 它最后一个使用者被切走或删掉了，引用计数归零 → 回收，连同它的浏览器存储 |
| IDM 的登录状态没了 | 同上，新组是**空**的。分区按组的 id 命名（`persist:layout-<id>`），id 永不复用，所以新建的空白布局真的是空白的 |

**被回收时会发生什么、不会发生什么：**

- **会**：删掉这个组（`pruneLayouts`），并清掉它的浏览器存储 —— 那里面有
  code-server 的登录 cookie，留着是无主的凭据。
- **不会**：动正在被 `codeView` 用着的那个分区。`clearLayoutStorage` 拿
  `win.codePartition` 对一下，是它就直接豁免。少了这一步，用户当前的 IDE 会连
  cookie 带 localStorage 一起被抽掉，而症状只是「页面莫名其妙坏了」。
- **不会**：动集群上的作业。切换布局只换本地端口和存储分区，
  **不发任何 RPC** —— `client/test/boot.test.mjs` 里那条「切换过程中 `backend.rpc`
  调用计数增量为 0」就是这件事的可自动化证明。

**升级不会丢布局。** 0.2.0 及更早的版本把布局存在 `persist:slot-1` 里、监听在
`slots["1"].port` 上。迁移出来的那个组**沿用旧的分区名与旧端口**（组 id 是字面量
`legacy-1`），所以 `origin` 和存储目录都没变，布局、最近打开的文件、登录状态原样
保留。**这是一条为期永久的兼容别名** —— `config.js` 里 `partitionForLayout` 那段
注释写了为什么不能「顺手清理」它：清理掉就是让老用户静默丢一次布局，且没有任何报错。
`client/test/config.test.mjs` 里「升级不丢布局」那条用例是它唯一的防线。

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

# 插件与站点分发
sudo /usr/local/sbin/slurmate-sessiond --check-plugins   # 装了哪些、各自包里有什么
ls -l /usr/local/share/slurmate/plugins/*.splug          # 站点上那几个包（root 所有）
cat /usr/local/share/slurmate/plugins/.keys.json         # 各 id 上一次是哪把钥匙签的
ls -l ~/.slurmate/site-plugins/*/*/                      # 客户端取回来的那一份
cat ~/.slurmate/site-plugins/.sites.json                 # 哪个站点要哪个版本（回收只看它）
# 取一份文件回来逐字节比（data 是 base64）：
slurmate rpc <<< '{"op":"plugin_file","id":"<ULID>","version":"1.0.0","path":"plugin.json"}'

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

有些现象的根因是**已知的、但还没修**——它们记在
[KNOWN-ISSUES.md](KNOWN-ISSUES.md)，每条写了位置、后果与修法。先扫一眼那里，
免得把一个已经写下来的缺陷重新发现一遍。

另外：**`goodbye` 回 `ok:true` 不代表作业被取消了**，`phase_release` 也不确认作业
是否真的停了（F12 / F13）。所以「用户点了结束会话，但节点上还有作业」这个现象
**是已知的**，不是你排错了方向。
