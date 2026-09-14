# Slurmate 系统架构

> 本文的骨架来自 `cluster/slurmate-sessiond:3-26` 的文件头注释。那里已经把设计意图
> 写清楚了，这里把它展开成一份独立文档，并补上规则形态、对账、信任模型与边界条件。

## 一句话

Slurmate 让用户在 Slurm 集群上跑 code-server 做远程开发。它的核心动作是：
**把「谁能连我端口」这份网络 ACL 的登记簿，从「SSH 会话」改挂到「Slurm 作业」上。**
于是 SSH 闪断不再等于会话终结 —— 作业还在跑，ACL 还在，重连即恢复。

## 一、五个组件

| 组件 | 代码 | 身份 | 职责 |
|---|---|---|---|
| 会话守护进程 | `cluster/slurmate-sessiond` | root（systemd） | 代表用户提交作业、维护 nft ACL、判活、续期、对账、对外提供 RPC |
| 用户 CLI | `cluster/slurmate` | 普通用户 | 与守护进程对话；对客户端暴露 `slurmate rpc` 这一个稳定入口 |
| 作业模板 | `cluster/run.sbatch` | 提交后以用户身份运行 | 在计算节点上挑端口、起 code-server、写会话文件与作业侧心跳 |
| nft 表 | `inet slurmate`（运行时创建） | 内核 | 承载 ACL 的唯一实体，寿命 = 作业寿命 |
| 桌面客户端 | `client/`（Electron） | 用户机器 | 提交、等待、建隧道、自动登录 code-server、发心跳 |

五者的关系可以这样读：

```
   用户机器                                    登录节点（控制节点）
 ┌──────────────┐    ssh -T ... slurmate rpc   ┌────────────────────────┐
 │ Electron 客户端│ ───────────────────────────► │ slurmate（CLI，user）   │
 │              │                              │   │ AF_UNIX            │
 │              │                              │   ▼                    │
 │              │                              │ slurmate-sessiond(root)│
 │              │                              │   ├─ sbatch(setuid)    │
 │              │                              │   ├─ nft inet slurmate │
 │              │   ssh -L（direct-tcpip）      │   └─ 会话文件(NFS,只读) │
 │              │ ─────────────────────────────┼──────────────┐         │
 └──────────────┘                              └──────────────┼─────────┘
                                                              ▼
                                                     计算节点 node01
                                                     run.sbatch → code-server
```

### 1. `slurmate-sessiond`（root 守护进程）

职责写在 `cluster/slurmate-sessiond:6-14`，逐条对应到代码：

1. **代表用户提交作业**（`Slurm.submit()`，`cluster/slurmate-sessiond:799-857`）：
   `fork + setuid + sbatch`，并记住「这个 `job_id` 是我代表哪个 uid 提交的」——
   这是整个防伪造体系的支点（见本文第五节）。
2. **发现作业落点**：从用户家目录的会话文件读出「作业实际在哪台节点、哪个端口」
   （`load_session_file()`，`cluster/slurmate-sessiond:1373-1431`）。
3. **按作业维度维护 ACL**：独立的 `inet slurmate` 表，规则寿命 = 作业寿命
   （`Nft`，`cluster/slurmate-sessiond:487-613`）。
4. **判活 / 续期 / 释放 / 崩溃恢复**：`tick()` 的五个阶段
   （`cluster/slurmate-sessiond:1018-1025`）。
5. **提供 RPC**：unix socket，身份取自内核的 `SO_PEERCRED`
   （`handle_client()`，`cluster/slurmate-sessiond:1568-1604`）。

它与既有系统的关系是**零耦合**（`cluster/slurmate-sessiond:16-20`）：不碰
`inet codeserver` 表、`ip port-daemon` 表、`/tmp/codeserver-ports`、
`/usr/local/bin/codeserver-*`、sshd 配置、sudoers、`user@.service`。
独立表、独立端口区间、独立状态目录、独立 systemd 单元。部署脚本把这条原则
升级成可验证的判据：部署前后各取一次 nft 规则集快照，剥掉 `inet slurmate`
之后必须逐条一致，否则判失败并提示回滚（`cluster/deploy.sh:14-16,767-807`）。

为什么是 Python：bash 拿不到 `getsockopt(SO_PEERCRED)`（身份认证的唯一可信来源），
而用 `sed` 解析文本正是最脆弱的地方（`cluster/slurmate-sessiond:22-25`）。

### 2. `slurmate`（用户 CLI）

以普通用户身份运行，**不发送任何身份信息** —— 身份完全由守护进程侧的内核凭据决定
（`cluster/slurmate:7-8`）。

它对客户端暴露的稳定接口是 `slurmate rpc`：从 stdin 读一行 JSON，向 stdout 写一行
JSON（`cluster/slurmate:10-17,208-234`）。客户端必须用**固定 argv** 调用：

```
ssh -T -o BatchMode=yes -p 10100 alice@node01.example.com \
    -- "/bin/bash -c '/usr/local/bin/slurmate rpc'"
```

（外层双引号与内层 `/bin/bash -c` 都是客户端实际发出的形状：sshd 用登录 shell 解释
exec 请求，钉死解释器可以免掉 zsh/bash 的方言差异。登录 shell 的 rc 文件仍会执行，
所以应答解析不能假定 JSON 在最后一行 —— 见 [PROTOCOL.md](PROTOCOL.md)。）

请求体走 stdin，命令行是编译期常量。这样用户输入**从构造上**不可能进入 SSH 命令串 ——
是消除注入，而不是「记得别拼字符串」。这一点还有第二个必要性：某些集群在 sshd 上
挂了 `ForceCommand` 守卫，命令串里不能出现 `code-server` 字面量，固定 argv 天然满足
（`client/src/main/backend-ssh.js:14-29`）。

### 3. `run.sbatch`（作业模板）

由守护进程以目标用户身份提交，**文件本身 root 拥有、0644、用户不可写**：执行的是
这个固定文件，用户可控的只有 `sbatch` 的命令行 flag（`cluster/run.sbatch:6-8`）。

它做四件事：

- 清理一组会让 code-server 附着到已有实例而不是启动新进程的环境变量
  （`cluster/run.sbatch:35-44`）；
- 在候选端口里逐个试，起 code-server 并以 `/healthz`（或任意 HTTP 响应）判就绪
  （`cluster/run.sbatch:188-261`）；
- 把会话身份、隧道目标、以及**自己生成的口令**写进 `0600` 的会话文件
  （`cluster/run.sbatch:120-134,335-365`）；
- 每 60 秒写一次作业侧心跳文件，并在退出前写「墓碑」（`state=exited`）
  （`cluster/run.sbatch:136-141,280-284`）。

它只读 `SLURMATE_*` 环境变量，不接受 argv（`cluster/run.sbatch:10-14`）。

### 4. `inet slurmate`（nft 表）

ACL 的唯一载体。表、链、基础规则都由守护进程幂等补齐（`Nft.ensure()`，
`cluster/slurmate-sessiond:518-561`），规则本身见本文第四节。

### 5. Electron 客户端

`client/README.md:1-9` 概括了它解决的五个问题。其中与集群侧强相关的三个是：

- **会话状态机与心跳**（`client/src/main/session.js`）；
- **隧道**：本地 `127.0.0.1:<槽位端口>` → 计算节点的 `tunnel_target`
  （`client/src/main/tunnel.js`）；
- **RPC 结果分类**：把「守护进程没回话」和「守护进程说了不行」严格分开
  （`client/src/main/classify.js`，见 [PROTOCOL.md](./PROTOCOL.md)）。

> `client/src/main/backend-ssh.js` 已经实现（专用密钥认证、固定 argv 的 RPC、
> 主机密钥 TOFU 校验），**但从未在真实登录节点上验证过** —— SSH 握手、exec 通道与
> `direct-tcpip` 转发都还没有一次真实输出。在那之前，`npm run demo` 仍然可用，
> 演示后端不是空壳：它跑真的隧道代码、真的状态机、真的登录契约（`client/README.md`）。

## 二、核心转变：ACL 挂作业，不挂 SSH 会话

传统方案把「用户已连接的端口」记在 SSH 会话上。于是 SSH 一断，登记簿的持有者就没了，
ACL 被撤、会话文件被清、用户重连只能从头再来 —— 而作业可能还在计算节点上跑着。

Slurmate 把登记簿的持有者换成 **Slurm 作业**：

- 作业由 Slurm 管，不随 SSH 会话生死；
- 守护进程是**唯一**把 `(uid, job_id) → 端口` 这条映射写进数据库的实体，
  用户自己写的会话文件只是「登记提示」，不是授权来源
  （`validate_session()`，`cluster/slurmate-sessiond:1433-1478`）；
- 客户端消失 ≠ 作业消失。守护进程用**两阈值心跳**区分这两种情况
  （`phase_heartbeat()`，`cluster/slurmate-sessiond:1296-1323`）：

  | 心跳中断时长 | 判定 | 动作 |
  |---|---|---|
  | `< suspect_after`（默认 300s） | 正常 | 无 |
  | `>= suspect_after` | 网络闪断 | **什么都不做**。作业与 ACL 全部保留，客户端重连即恢复 |
  | `>= orphan_after`（默认 1800s） | 异常退出 | `scancel` 释放资源 → `orphaned` → `releasing` |

  **这张表只覆盖「客户端没能说上话」那一半。** 另一半是客户端主动发 `goodbye`
  （`op_goodbye`），那条路立即释放，不走任何等待。

  两条路的边界由**能否表达意图**划开，不由「谁触发的」划开：断电、睡眠、网线被拔时
  客户端根本执行不到代码，于是落进上表的容错窗口；而用户点「断开」「结束会话」
  或者关掉窗口，都是明确的意思表示，一律走 `goodbye` 彻底终止。
  客户端里**没有**「关掉界面但让作业继续跑」这种开关 —— 唯一能保住作业的情形，
  是它连话都没能说上。

  从 `suspect` 回到 `enrolled` 只需一次心跳：`op_heartbeat` 把状态改回来即可，
  作业和 ACL 全程没被碰过（`cluster/slurmate-sessiond:1776-1788`）。

判活的依据只有客户端经 unix socket 发来的 `last_hb_socket`。作业侧写的 `.jobhb`
文件**不参与判活**（`client/README.md:164-165`），它的作用是别的：区分「是客户端掉了
还是作业没了」。

## 三、状态机

定义在 `cluster/slurmate-sessiond:57-70`：

```
                        ┌──────────── reserved_ttl 到期 ──────────► expired
                        │
  reserved ──sbatch 返回 job_id──► submitted ──会话文件校验通过──► enrolled
       │                              │                              │
       │                    enroll_timeout                 心跳中断 ≥ suspect_after
       ▼                              ▼                              ▼
   expired                       expired                        suspect
                                                                   │
                                                        心跳中断 ≥ orphan_after
                                                                   ▼
                                                               orphaned
                                                                   │
                                        （任何一条拆除路径）           ▼
   released ◄──────────── releasing ◄──────────────────────────────┘
                    ▲
       goodbye / job_gone / rejected 也走这里
```

| 状态 | 含义 | 谁把它推进来 |
|---|---|---|
| `reserved` | 已分配候选端口，尚未提交 | `op_submit` 插行时（`cluster/slurmate-sessiond:1890-1895`） |
| `submitted` | `sbatch` 已返回 `job_id` | `op_submit` 提交成功后（:1920） |
| `enrolled` | 作业在跑、会话文件校验通过、**ACL 已装** | `try_enroll()`（:1190-1229） |
| `suspect` | 心跳丢失 > `suspect_after`：判定网络闪断，什么都不做 | `phase_heartbeat()`（:1308-1312） |
| `orphaned` | 心跳丢失 > `orphan_after`：判定异常退出，已发 `scancel` | `phase_heartbeat()`（:1313-1323） |
| `releasing` | 正在拆除 | `begin_release()`（:1325-1327） |
| `released` | 终态 | `phase_release()`（:1329-1348） |
| `rejected` | 终态（校验失败） | `reject()`（:1480-1508） |
| `expired` | 终态（TTL 到期仍未登记） | `phase_pending()` / `try_enroll()` |

两条不变量：

- `TERMINAL_STATES = (released, rejected, expired)`（:68）；
- `ACL_STATES = (enrolled, suspect, orphaned, releasing)`（:70）——
  **这个集合与「nft 里应该存在哪些规则」严格一一对应**。`reconcile()` 用它算期望集合，
  `phase_release()` 保证「`released` 之前规则一定在，之后规则一定不在」
  （`cluster/slurmate-sessiond:1330-1333`）。

另有三个记录在数据库 `trust` 字段上的特殊值。`recovered` 表示这条记录是从 nft 规则
反推出来的（见第六节），它**永不参与自动 `scancel`**（:1314-1316, 1069-1070）——
对「用户是否还连着」没有可靠信息时，误杀在跑的作业比多留一会儿更糟。

## 四、nft 规则为什么写成单条 `meta skuid != UID drop`

规则形态（`cluster/slurmate-sessiond:490-492,579-594`）：

```
ip daddr <节点IP> tcp dport <端口> ct state new \
    meta skuid != <属主UID> meta skuid != 0 drop comment "slurmate-sess-<uid>-<job>-<port>"
```

对比另一种常见写法：「先无条件 `drop`，再对属主 `accept`」的一对规则。单条写法有三个
具体好处，写在 `Nft` 的类文档里（`cluster/slurmate-sessiond:494-499`）：

1. **爆炸半径锁死在「该 UID 自己」。** 配对写法里的无条件 `drop` 一旦被误注册
   （端口算错、规则残留），打死的是这个端口上的**所有**用户；单条写法最坏也只是
   让某个用户连不上自己的端口。
2. **单次 `nft` 调用即原子。** 消灭「插了 DROP 还没插 ACCEPT」的中间态 ——
   在那个窗口里，连属主自己都被挡在外面。
3. **`ct state new` 只拦新连接。** 已建立的转发不会因为规则抖动被掐断。
   这是「隧道重连不中断」的物理保证：规则被删掉又补回来的那几秒，用户已经建立的
   连接不会断。

规则的 `comment` 编码了 `(uid, job_id, port)`，格式由 `comment_for()` 固定
（`cluster/slurmate-sessiond:575-577`）。它同时是三条路径的索引：删除
（`del_by_comment()`）、对账（`session_rules()` 解析出 `{comment: handle}`）、
以及数据库丢失后的反向恢复（第六节）。

### 基础规则与「几何约束」

除了会话规则，链上还有两条基础规则，用 `insert`（而不是 `add`）放在链首
（`cluster/slurmate-sessiond:542-561`）：

| comment | 规则 | 作用 |
|---|---|---|
| `slurmate-base-lo` | `oif lo accept` | 本机回环流量放行 |
| `slurmate-base-offcluster` | `ip daddr != <cluster_cidr> accept` | **最后一道几何约束**：本网段之外的流量一律放行 |

第二条是防御性设计：即使前面所有校验都被绕过，也影响不到集群网段之外
（`cluster/slurmate-sessiond:555-556`）。它同时决定了部署的一个硬性前提 ——
登录节点与计算节点必须能被**一个** CIDR 覆盖（否则计算节点的流量会被这条规则
提前放行，会话规则永远匹配不到，ACL 静默失效）。详见
[DEPLOYMENT.md](./DEPLOYMENT.md) 的「前置条件」第 2 条。

### 跨表顺序：靠「集合不交」，不靠依赖顺序

nftables 对**同 hook、同 priority 的跨表求值顺序没有保证**。两个表都匹配同一个
`dport` 时，谁先求值是未定义的。所以 Slurmate 不试图去控制顺序，而是从构造上
让顺序无关紧要：**端口区间与集群上其他端口管理系统的区间完全不交**
（`cluster/slurmate.conf.example:52-64`）。

这个约束在两处被强制执行：

- 配置自检：`Config.validate()` 断言端口池与 `reserved_ranges` 不重叠，不满足则
  **拒绝启动**（`cluster/slurmate-sessiond:300-303,292-293`）；
- 部署预检：`deploy.sh` 读同一份配置做同样的区间比对，重叠即中止部署
  （`cluster/deploy.sh:371-410`）。

要注意的是这里**没有**用「端口必须 > 55000」之类的硬编码约定。那是某个具体站点的
习惯，写死在代码里会让用低位端口的集群直接装不上（`cluster/slurmate-sessiond:228-229`）。
要避让哪些区间由站点的 `reserved_ranges` 决定。

## 五、信任模型

### 身份：`SO_PEERCRED`，不是命令行参数

守护进程在**读任何数据之前**先取 `getsockopt(SO_PEERCRED)`
（`cluster/slurmate-sessiond:1568-1576`）。uid 由内核在 `connect()` 时填充，
用户态不可伪造；pid 不可信（会复用），所以不用它。

socket 权限是 `0666`，但**安全性不建立在这个权限位上**
（`cluster/slurmate-sessiond:969-970`）。任何本地用户都能连上它，但只能以
**自己的**身份说话。

### 会话文件是「登记提示」，不是授权来源

一个用户可以在自己家目录里写任意内容的 `job-<id>.json`。所以真正的授权是：
**这个 `job_id` 在数据库里，且由本守护进程代表该 uid 提交过**
（`cluster/slurmate-sessiond:1434-1435`）。

在此之上，会话文件的每一项都对应一个具体攻击（`validate_session()`，
`cluster/slurmate-sessiond:1433-1478`）：

| 检查 | 挡住的攻击 |
|---|---|
| `schema` 版本一致 | 旧格式文件被误读 |
| `job_id` / `uid` 与数据库一致 | 冒用别人的作业号 |
| `node_ip` 必须是**规范 IPv4** | 手写地址绕过 |
| `service_port` 必须在**守护进程分配的候选集**内 | 用户写任意端口，让守护进程替他建 ACL |
| 端口在配置区间内 | 越界端口 |
| `state == "running"` | 未就绪的文件被提前登记 |
| `node` 与 Slurm 的 `NodeList` 一致 | 让守护进程为**任意集群内 IP** 装规则（虽被限制在自己候选端口内，仍足以对其他用户造成定向丢包） |
| `node_ip` 与 Slurm 的 `NodeAddr` 一致 | 同上 |

读取路径本身也是安全关键（`load_session_file()`，`cluster/slurmate-sessiond:1373-1431`）：
逐级 `lstat` 目录链（非符号链接、属主是本人或 root、组/其他不可写）、
`O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC` 打开、`fstat` 而非 `stat`（防 TOCTOU）、
要求常规文件 / 属主正确 / 模式为 `0600` / 大小上限 / `st_nlink == 1`。

用户家目录一律用 `pwd.getpwuid(uid).pw_dir` 取，**绝不拼「家目录前缀 + 用户名」** ——
用户名与目录名不保证一致，前缀本身也是站点配置（`user_home()`，
`cluster/slurmate-sessiond:1358-1371`）。

### root 不写用户家目录

口令由**作业自己生成**并写进 `0600` 的会话文件；守护进程全程只读用户家目录，
并且 systemd 单元把共享存储挂成只读（`ReadOnlyPaths=`，由 `deploy.sh` 按
`readonly_paths` 渲染，`cluster/slurmate-sessiond.service.in:44-49`）。

这样 root 身上没有「写用户文件」这条攻击面，也避免了 root 被符号链接诱骗
（`cluster/run.sbatch:21-24`）。代价是守护进程不能替用户创建目录 —— 它也不创建：
`op_submit` 只插数据库行、组环境变量、调 `sbatch`（`cluster/slurmate-sessiond:1881-1887`）。

### 为什么默认 `auth_mode = password`

`nft` ACL 的 hook 点是**登录节点的 output 链**（`Nft.CHAIN`，
`cluster/slurmate-sessiond:503`；建链语句在 :537-538）。它拦得住「登录节点上的其他
用户连你的端口」，拦不住「另一个作业恰好被调度到同一台计算节点之后直接 curl 你的
端口」—— 那条流量根本不经过登录节点。

这不是某个集群的配置问题，而是这个架构的固有边界（`cluster/slurmate.conf.example:128-143`）。
共享家目录 `0700` 之类的保护恰好被绕过，因为攻击者用的是你的身份。所以默认
`auth_mode = password`，`run.sbatch` 甚至明确拒绝在拿不到口令时静默降级为
`auth=none`（`cluster/run.sbatch:355-361`）。

## 六、对账与自愈

链的 policy 是 `accept`，规则没了不会报错，只会**悄悄失去保护**。所以 `tick()` 的
第一步就是对账（`reconcile()`，`cluster/slurmate-sessiond:1027-1063`），每个 tick
（默认 2 秒）跑一次：

1. `nft.ensure()` 逐项补齐**表、链、两条基础规则**。它不能只判「表是否存在」——
   如果有人只删了链而表还在，早期实现会直接返回成功，之后所有 `add rule` 都失败，
   对账每 tick 提前返回，**后续所有清理阶段被跳过**：新会话拿不到 ACL、孤儿规则
   永远不删，而进程看起来「健康」、不会重启（`cluster/slurmate-sessiond:519-527`）。
2. 算出期望集合（`ACL_STATES` 里每条记录对应的 comment）。
3. **多出来的规则 → 删**（fail-secure：宁可少放行）。
4. **缺失的规则 → 补**。

启动时还有一步 `recover_from_rules()`：从规则 comment 反推出 `(uid, job_id, port)`，
配合 `scontrol` 确认作业仍在 `RUNNING` 且属主相符，就把记录重建出来，标
`trust='recovered'`（`cluster/slurmate-sessiond:1065-1128`）。顺序很重要：**先恢复
再对账**，否则对账会把它们当孤儿删掉（`cluster/slurmate-sessiond:943-944`）。

不实现这一步的后果：数据库一丢，`reconcile()` 会把所有规则当孤儿删掉，在跑的会话
瞬间失去防护，而且因为数据库里没有 `job_id` 归属，它们**永远无法重新登记**
（会话文件即使还在也没用）。

## 七、生命周期中的几个「保守」决定

这些决定单独看都像过度防御，但每一条都对应一类真实的、静默的故障。

### 「作业查不到」要连续确认若干 tick

`scontrol` 查不到作业有两种截然不同的原因：作业真的结束了，或者**只是问不到**
（`slurmctld` 重启中、`munge` 抖动、控制器繁忙）。两者无法用返回码区分，所以
`Slurm.job_state()` 靠的是**控制器本身是否可达**（`scontrol ping`），返回三态：
`JOB_OK` / `JOB_MISSING` / `JOB_UNKNOWN`（`cluster/slurmate-sessiond:639-681`）。

- `JOB_UNKNOWN`：**什么都不做**，只记日志。
- `JOB_MISSING`：还要连续确认 `job_missing_confirm_ticks` 次（默认 3）才认账
  （`cluster/slurmate-sessiond:1161-1172`）。

早期实现把两者合并成 `None`，后果是控制器抖一次，所有活跃会话的 ACL 在一秒内
全部消失、会话文件被删（再也无法重新登记），而作业还在跑
（`cluster/slurmate-sessiond:642-653`）。

### 启动静默期

守护进程重启后的 `startup_grace_seconds`（默认 120 秒）内不做任何超时判定 ——
否则重启窗口会把在跑的会话误判成孤儿（`cluster/slurmate-sessiond:913-914,1303-1304`）。

### 退出时不删 nft 规则

规则代表的是**作业**的存在，而作业是 Slurm 管的、不随守护进程生死。重启后靠对账
收敛（`cluster/slurmate-sessiond:1005-1006`）。

### 目标变化时重装 ACL

已登记的会话在作业重启/重排后可能换节点或端口，`refresh_enrollment()` 会跟着更新
规则；但**会话文件暂时读不到时绝不拆规则**（NFS 抖动、作业正在重启都可能造成），
因为那会打断正在用的隧道（`cluster/slurmate-sessiond:1231-1257`）。

## 八、部署拓扑与进程加固

`slurmate-sessiond` 以 root 跑在登录节点上，systemd 单元给出了一组最小权限
（`cluster/slurmate-sessiond.service.in`）：

| 指令 | 为什么 |
|---|---|
| `ProtectSystem=full` | 必须是 `full` 而不是 `strict`：`strict` 会把 `/run` 也挂成只读，切断 munge 的 socket，`scontrol`/`scancel` 全部失败（:41-43） |
| `ReadOnlyPaths=@READONLY_PATHS@` | 共享存储只读挂载（:44-49） |
| `PartOf=nftables.service` | `nftables.service` 的 `ExecReload` 是 `nft 'flush ruleset; include ...'`，会连本服务的表一起清掉；`PartOf` 让本服务跟着重启，保证表被重建。**不能用 `BindsTo`** —— 那会让 nftables 启动失败时本服务也起不来（:20-23） |
| `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK` | nft 走 netlink；`scontrol`/`scancel` 走 AF_UNIX（munge）+ AF_INET（slurmctld）（:72-73） |
| `CapabilityBoundingSet` | `CAP_NET_ADMIN`（nft）、`CAP_SETUID/SETGID`（setuid 提交）、`CAP_DAC_READ_SEARCH`/`CAP_DAC_OVERRIDE`（读 0600 会话文件）、`CAP_KILL`（回收子进程）（:75-82） |
| `StartLimitIntervalSec=0` + `Restart=always` | 永不放弃重启（:24-25,33-34） |

单元是**模板**（`.service.in`），`deploy.sh` 安装时把 `@READONLY_PATHS@` 替换成站点
的真实挂载点；`readonly_paths` 为空时整行被删除，同时打印警告
（`cluster/deploy.sh:651-665`）。

## 九、已知边界

写文档时把边界写清楚，比让用户在生产里撞上要好。

1. **单一登录节点。** 规则挂在守护进程所在那台机器的 output 链上。多登录节点集群
   中，用户落到另一台登录节点时那条链上没有规则，保护静默消失。
2. **登录节点与计算节点必须能用同一个 CIDR 表达。** 多网段集群目前无法表达
   （`cluster/slurmate.conf.example:29-30`）。
3. **计算节点上没有 per-user 网络隔离时，ACL 覆盖不到同节点内的横向访问。**
   这是 `auth_mode = password` 默认开启的原因（`cluster/slurmate.conf.example:134-140`）。
4. **`op_submit` 非幂等**：每次调用都生成新 `sid`、插新行、提交新作业。而
   `count_active()` 只数 `ACL_STATES`，`submitted` 不在内 —— `max_active_per_user`
   拦不住并发的第二个提交（上限退化为 `max_pending_per_user`）。所以客户端在
   `submit` 超时时**绝不重试**，改为用不带 `session_id` 的 `status` 去认领
   （`client/src/main/session.js:19-23,156-173`）。
5. **`goodbye` 返回 `ok:true` 不代表作业被取消了。** `op_goodbye` 丢弃
   `scancel` 的返回值，`phase_release` 也不确认作业是否真的没了
   （`cluster/slurmate-sessiond:1790-1801,1329-1348`）。所以客户端把「正在释放」和
   「已结束」当成两个状态（`client/src/main/session.js:24-25`）。详见
   [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。

## 延伸阅读

- 安装与前置条件：[DEPLOYMENT.md](./DEPLOYMENT.md)
- 配置项参考：[CONFIGURATION.md](./CONFIGURATION.md)
- RPC 契约与错误码：[PROTOCOL.md](./PROTOCOL.md)
- 常见故障：[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
