# RPC 协议

客户端与守护进程之间的契约。契约来源：`cluster/slurmate`（CLI 侧的信封构造与退出码）
与 `cluster/slurmate-sessiond`（`_ok`/`_err` 构造点、`dispatch`），
客户端的消费逻辑在 `client/src/main/classify.js`。

> 完整的文档索引在 [docs/README.md](README.md)。这一篇是契约；
> 「要写一个新后端」那张清单在 [IMPLEMENTING.md](IMPLEMENTING.md) —— 一份清单是
> 实现指引，不是契约。

---

## 〇、协议版本

当前版本：v0.36。协议版本、客户端版本、服务端版本是同一个号 —— 它们不是
三件东西，是一件的三个落点。四处声明由 `.github/workflows/checks.yml` 断言：
`cluster/slurmate` 与 `cluster/slurmate-sessiond` 逐字写着 `0.36`，而
`client/package.json` 与 `client/package-lock.json` 的 `version` 是三段
（`0.36.0`）—— 那个字段同时是 npm 包的版本号，而 npm 与 electron-builder 都要求
语义化版本，两段会被构建工具直接拒掉。协议版本 = 包版本的前两段，断言比的
就是这四处的前两段。

这个号是 `major.minor`：两段。`major` 无上限，`minor` ∈ `0..255`，**禁止**
前导零：写成 `1.007` 就是错的，它会让"同一个版本"有两个字符串。

超上界时**必须**进位，`0.255` 之后是 `1.0`。所以它是 `v0.36`，不是 `v0.36.0`。

顺带一句：`v0.36` 不是 `v0.2`。`minor` 是十进制字符串，`36` 比 `2` 大。

把它读成"小数点后面的 10 分之一"是这条规则最容易踩的一脚，而踩了之后症状是版本闸
把更新的那一端判成更旧的。

> 两段是有意的，而且这两段各有分工。

> | 那一段 | 含义 | 容量 |
> |---|---|---|
> | `major`（`x`） | 可以不兼容的那一档 | 无上限 |
> | `minor`（`y`） | 加东西但不破坏兼容的那一档 | `0..255`，够用很久 |

> 这是这个项目里两套版本号中的一套。另一套是插件的版本号（`x.y.z`，见
> [PLUGIN-SPEC.md](../packer/docs/PLUGIN-SPEC.md) §2.3），它比这个号多一段。

> 两套的形状不同、用途不同（两段 vs 三段本身就是一眼能分开的标记），只有一条共同的
> 纪律：逐段按十进制字符串比较、禁止转机器整数。写得下"补丁级"的只有插件那一套。

> 判据与结论写在 `tools/version-fixtures.json` 里，JS 与 Python 两边的用例读的是
> 同一份。两侧规则必须逐条一致，而"只有一份"比"两份抄本 + 一条比对 lint"结实。

> 语义化版本要求三段，而协议版本只有两段，所以协议版本不遵循语义化版本。

> 客户端发行包的 `version` 是三段（npm 与 electron-builder 的要求），它的前两段就是
> 协议版本。客户端对站点自报的是那前两段。

### 三方：谁不低于谁

发版时客户端、服务端（守护进程 + `slurmate` 这个接口程序）、打包器同步更新，
用的是同一个号。它们的更新渠道不同，而下面这套规则管的就是渠道之间会错开
这件事：

- 客户端由用户自己更新 —— 装的是什么版本就是什么版本；
- 服务端由管理员手动更新（`install-base.sh`）。服务端版本低不是故障，它的后果
  只有一条：不认识某些新插件 —— 那是插件自己的 `engines.slurmate` 说了算的，
  见下。

| | 规则 |
|---|---|
| **同 `x`** | **保证兼容**，前提是**客户端不低于服务端**。这是承诺本身：管理员可以在同一个大版本内自由升服务端，而不会打掉任何一个客户端 |
| **同 `x`，客户端更低** | 服务端要求客户端不低于它自己，于是**要求用户升级客户端**（例如 2.5 的服务端不接受 2.4 的客户端，但接受 2.5、2.6） |
| **跨 `x`** | **不判为不兼容** ——「不一定，不是绝对不」。两个方向都**放行**，但都要**明确说明**。理由是用户可能连多个集群（一个 1.28、一个 2.5），2.x 的客户端不一定兼容 1.28 |
| **服务端 vs 插件** | 服务端不低于插件 `engines.slurmate` 要求的版本，否则**拒绝安装**那个插件并说明双方版本号；升不升服务端由管理员决定 |

`x == 0` 是内测期，整条规则不受版本约束（架构还在动，每次更新都可能有重大
变动），那时"客户端落后"只说明、不拦。1.0 是"不承诺"与"承诺"的分界线；到那
一天要刻意摘掉那条例外，而摘掉它会让一条用例红 —— 摘除是一次动作，不是手滑。

由此得到一条发布纪律：同一个大版本内不许出现破坏兼容的改动；出现了就必须
升大版本。上面那条承诺唯一的保证就是它，所以它写在
[CONTRIBUTING.md](../CONTRIBUTING.md) 里，也写在 [CHANGELOG](../CHANGELOG.md) 的顶部。

### 这条检查由客户端执行，而且它对老客户端无效

客户端连上之后问一次 `ping`，拿双方的版本号自己判，不通过就拒绝建立会话
（在任何会话之前，所以不会经由 `orphan_after` 把用户正在跑的作业 scancel 掉）。
守护进程不做这条检查，因为它做不到：请求信封里没有客户端版本，而老客户端
也不会带 —— 一条只有新客户端才生效的检查，本来就属于客户端。

效力边界要写在明处：这条规则第一次执行只能从带它的那一版客户端开始。
「老客户端 × 新服务端」那一格只有部署纪律能保，代码拦不住，不要以为它拦得住。

用 `ping` 而不是给别的 op 加字段，是因为它的应答里本来就有一格 `version` ——
这条规则因此不需要协议线上多任何一个字节，而它对每一个守护进程立刻有效，
正好对上"客户端要能兼容老版本服务端"那条要求。

跨版本的两端连不上。两边必须一起升 —— 协议变了而只改一边，症状是 `submit`
收到 `2 bad_partition`、`2 bad_service_kind` 之类看起来像参数写错的错误。

> 变更记录在 [CHANGELOG.md](../CHANGELOG.md)：早期版本合并为一份按能力线的
> 概要，最近的版本逐条目记录。那一份是记录，这一篇是契约 —— 契约只说现在是
> 什么。

---

## 一、传输

一段 SSH，两种连接方式，同一份信封：

```
客户端 ──ssh -T──► 登录节点上的 slurmate rpc    ──AF_UNIX──► slurmate-sessiond
                    （stdin 读一行，stdout 写一行）    （unix socket，一行 JSON）

客户端 ──ssh -T──► 登录节点上的 slurmate stream ──AF_UNIX──► slurmate-sessiond
                    （stdin 一行一条，stdout 一行一条） （同一条连接，双向）
```

两种方式在守护进程侧是同一个状态机，差别只在客户端什么时候关连接 ——
`rpc` 发一条、读一条、就走；`stream` 留着，可以接着问，也会收到服务端主动说的
（见〈二·五、常驻通道〉）。所以老客户端一个字节都不用改 —— 它收到的字节流里没有任何一格是新的
（推送的订阅判据见那一节）。

### `slurmate stream`

```
ssh -T -o BatchMode=yes -p 22 alice@node01.example.com \
    -- "/bin/bash -c '/usr/local/bin/slurmate stream'"
```

- stdin 一行一条请求，可以带 `rid`；stdout 一行一条：响应带 `rid`，
  通知带 `seq`（判据见〈二·五〉）。
- 内部只维持一条到守护进程的连接，不再每条请求一个 SSH exec + 一个
  Python 解释器（实测：一次 `slurmate` 进程启动中位 57.5 ms，而其中
  19.3 ms 是解释器本身的地板）。
- `stream` 是一个字节泵：不解析、不校验、不重排、不做任何用户态缓冲，读多少
  写多少。这是整条背压链上唯一可能引入无界缓冲的地方，所以它必须没有。

  链条是：客户端不读就阻塞在 write(1)，不再 read(socket)，守护进程于是拿到 `EAGAIN`，
  按水位丢推送（响应绝不丢）。中间任何一级加了队列，这条链就断了，而症状是
  "内存慢慢涨"，指不回任何一行。
- 它不加限速、不加空闲超时。

  不加限速是因为它以用户自己的身份跑，限自己防不了任何东西。而"一个判据两处实现
  会漂"，漂的方向是心跳发不出去，被判定孤儿，然后 `scancel`。

  不加空闲超时是因为它不理解心跳的语义：谁在心跳、多久算超时，是客户端 `session.js`
  的事。按"多久没说话"在这里关连接，会在用户只是停下来看界面的时候把通道掐掉。
- 两个方向的限长不一样，而且都不由 `stream` 自己实现：请求 64 KiB
  （守护进程的 `CONN_IN_MAX`），响应 4 MiB（`RPC_MAX_RESPONSE_BYTES`）。
- 连上之后不再有任何超时（`STREAM_CONNECT_TIMEOUT = 40` 秒只管连接那一步）。
- 半关（stdin EOF）不等于断开：已经发出去的请求还要把响应收回来。

  之后守护进程把连接关了就是正常终点，退出码 `0`；没半关过就被关则是 `5`，
  守护进程不在了，客户端该重连。

对客户端而言只有 `slurmate rpc` 这一个稳定入口（`cluster/slurmate`）：

```
ssh -T -o BatchMode=yes -p 22 alice@node01.example.com \
    -- "/bin/bash -c '/usr/local/bin/slurmate rpc'"
```

- 请求体走 stdin，响应走 stdout，各一行 JSON。一次一请求，请求完即退出。
- 客户端把命令显式包在 `/bin/bash -c` 里执行（见 [client/README.md](../client/README.md)）——
  sshd 用登录 shell 解释 exec 请求，钉死解释器可以免掉 zsh/bash 的方言差异。
  但登录 shell 的 rc 文件仍会执行（zsh 的 `~/.zshenv` 连 `-c` 都读），
  所以客户端解析应答时从后往前找第一个合法信封，而不是假定它在最后一行。
- argv 是编译期常量，用户输入永远不出现在命令串里。这既是防注入，也是穿过
  登录节点上 `ForceCommand` 守卫的必要条件（某些集群的守卫只放行白名单里的命令名
  —— 固定 argv 天然满足）。
- 中文 detail 以字面 UTF-8 输出（`ensure_ascii=False`，`cluster/slurmate`）；
  解析失败时报「守护进程返回的响应不是合法 JSON」（`cluster/slurmate`）。
- 上限：CLI 侧最多读 4 MiB 或读到第一个换行（`cluster/slurmate` 的
  `RPC_MAX_RESPONSE_BYTES`）；守护进程侧最多读 64 KiB 或读到第一个换行
  （`cluster/slurmate-sessiond`）。

  4 MiB 不是随手定的：整包那条路一次最多发 `limits.package_bytes`（2 MiB），
  base64 膨胀 4/3，约 2.7 MiB 再加信封。

  这两个数有对应用例钉着（`cluster/test-sessiond-logic.py` 的 19.11d）。它们是从
  两侧各写一遍的，漂开之后 CLI 会报"响应太大"，而客户端把它归成
  `daemon_unreachable`（code 5）并退避重试。

人类可读的子命令（`submit` / `status` / `wait` / …）不保证输出 JSON，
只在加 `--json` 时才打印信封。客户端应始终走 `slurmate rpc`。

### 超时预算

| 环节 | 值 | 位置 |
|---|---|---|
| 守护进程读一个请求 | 5 秒 | `cluster/slurmate-sessiond` |
| CLI 等守护进程应答 | 40 秒（默认） | `cluster/slurmate` |
| CLI `heartbeat` / `stopjob` | 20 秒 | `cluster/slurmate` |
| 客户端等 `submit` | **45 秒**，必须比 CLI 内部的 40 秒长 | `client/src/main/session.js` |
| 客户端等 `goodbye` | 10 秒 | `client/src/main/session.js` |
| 客户端认领用的 `status` | 20 秒 | `client/src/main/session.js` |

`submit` 的超时必须大于 CLI 内部的 socket 超时，否则会在守护进程还在跑 `sbatch`
的时候放弃 —— 然后按大多数重试逻辑去重试，于是两个作业（`client/src/main/session.js`）。

---

## 二、信封

### 请求

```json
{"op": "submit", "cpus": 2, "mem": "8G", "gres": {"name": "gpu", "type": "a100", "count": 2}, "time": "12:00:00"}
```

### 响应

```json
{"ok": true,  "code": 0, "data": { ... }, "error": null}

{"ok": false, "code": 4, "data": null,
 "error": {"kind": "quota_active",
 "detail": "已经有 1 个会话占着位置（本站上限 1）—— 排队中的也算。结束一个再开下一个。"}}
```

构造点：`_ok()` 与 `_err()`（`cluster/slurmate-sessiond`）。

- `ok: true` 时 `code` 恒为 `0`，`error` 恒为 `null`；
- `ok: false` 时 `data` 恒为 `null`；
- `error.detail` 是守护进程写的中文，可直接展示给用户（`client/src/main/classify.js`）；
- `error.kind` 是机器可读的短标识，必须靠它做分支，不要靠 `code`（理由见第四节）。

#### `data.warning` —— 成功之外还有一句话（可选字段）

`ok:true` 之外还有一句用户必须知道的话时，服务端必须带上这个字段。
它不属于某一条 op，是响应 `data` 里的一个通用可选格。它出现的情况有五种，
归成两族：

| 族 | 那句话说的是 | 今天出现的位置 |
|---|---|---|
| **服务端替用户做了决定** | 请求照办了，但拿到的与要的不完全一样 | `submit`：时间被截断到分区 `MaxTime` 或硬上限；`mem` 无法识别（比如 `--mem=0` —— 在 Slurm 里那是「该节点的全部内存」）而已回退默认值；分区权限查不到，因而交给了 Slurm 的默认分区 |
| **这一次没做成，但会继续做** | 请求**被受理了**，只是还没做完 | `goodbye`：这一次 `scancel` 没有成功，守护进程会继续重试，直到作业被确认消失（见〈`goodbye`〉） |

它不影响成功（`ok` 仍为真、请求照常进行），但客户端**必须**显示它。用户会以为自己
要到了 30 天，而实际拿到的是 7 天；或者以为作业停了，而它可能还在烧 GPU。

静默地替用户决定、或静默地没说成，正是这个项目一路在清的那类问题。协议里有这个字段
的唯一理由就是被显示出来：`client/src/main/session.js` 会把它接进
`snapshot().warning`，`cluster/slurmate` 的命令行会把它打到 stderr。

第二族里，"说成失败"与"不说"一样错。请求确实被受理了（会话已经进入释放
流程），回成 `ok:false` 会让客户端劝用户去重试一件已经在做的事。
而那句话只描述接下来会怎样，不诊断原因 —— 见〈`goodbye`〉。

### 二·五、常驻通道

只在 `slurmate stream` 上存在。`rpc` 那条路上一个字节都没有变。

#### `rid` —— 请求与响应的配对（加法）

请求可以带一个 `rid`（字符串或整数）。带了的，响应把同一个值原样回填：

```json
{"op": "status", "rid": 7}          →  {"ok": true, "code": 0, "data": {...}, "error": null, "rid": 7}
```

不带就不回填。所以老客户端的请求与响应在线上没有任何一格变化。

#### `rid` 同时是订阅的判据

| 这条连接 | 会不会收到通知 |
|---|---|
| 发过至少一条**带 `rid`** 的请求 | **会** |
| 一条都没发过（老客户端） | **不会**，永远 |

判据是 `rid` 而不是"连接活了多久"或一个 `subscribe` op，理由是：老客户端
（`slurmate rpc`）每次都是新连接、只发一条、永远不带 `rid`。把订阅挂在这上面，
"老客户端收不到推送"就成了一个结构事实，而不是一句承诺 —— 否则一次恰好落在
对账时刻的通知会被它当成响应读走，症状是随机的、说不清的失败。

#### `client` —— 这台电脑是谁（加法）

请求可以带一个 `client`：

```json
{"op": "list", "rid": 3, "client": {"id": "m9f3c1…", "name": "笔记本"}}
```

- `id` 是稳定的（落在客户端数据目录里的一个随机串）。判等只用它。
- `name` 只用于显示，缺省是主机名。一台机器改个名不该被当成换了一台电脑 ——
  那会让它认不出自己看过的那些会话（`session_view.keeper` 存的是 `id`），
  而症状是它自己的作业开始倒计时。

#### `client` 与 `rid` 在同一个位置、同一条理由上被认领

| 这条连接 | 算不算报了身份 |
|---|---|
| 发过至少一条**带 `rid`** 的请求 | **算**（前提是带了 `client`） |
| 一条都没发过 | **不算** —— 即使带了 `client` |

理由与上面那条订阅的判据逐字相同：`slurmate rpc` 是客户端在常驻通道起不来时的退路，
而它永远不带 `rid`。

它若也能认领身份，那么客户端每退路一次就以同一个 `id` 报一次名，而服务端会把 `keeper`
那一格写给一条下一条请求之后就消失的连接。它刚认领的会话立刻变成「没人看」，
倒计时开始跑。

症状是「作业莫名其妙开始倒计时」，而两边各自的日志都自洽。

#### `client` 只决定一件事：这条连接能不能写 `keeper`

`keeper` 是会话行上的一格（见〈`status`〉那一节的会话视图字段表），不是连接的属性、也不是
「席位」。它管的是「谁当家」—— 而"谁刷得动 `last_hb_socket`"是另一件事：
心跳只续命，不写这一格。

| 谁 | 能不能写 `keeper` | 能不能刷新看护者不是自己的那条会话 |
|---|---|---|
| 报了身份的连接 | 能，但只有 `submit` 与 `takeover` 两个写入口 | 不能（回 `ok` + `ignored: "not_keeper"`） |
| **没报身份**的连接 | **不能**（没有名字可写） | **能** —— 为空时接受任何心跳 |

最后一行是承重的，别把它「收严」成「没有身份就不算」。没报身份的连接有两类，
而两类都必须能续命。

一类是 CLI（`slurmate heartbeat` / `slurmate wait`）与更老的客户端。另一类是客户端
自己的 exec 退路，那条路上 `client` 是被删掉的。

收严的后果是具体的一条：用户正开着客户端看着作业，登录节点上一次通道抖动让它退化成
exec，心跳全部被回 `ignored`，300 秒 `suspect`、1800 秒 `scancel`，而界面上一切正常
（客户端只看到 `ok`）。

没有身份 = 不被排除。

`slurmate rpc`、`slurmate wait`、VS Code 的 Remote-SSH、用户自己的终端 —— 同一个用户
在同一个站点上本来就会有很多条 SSH 连接。它们一条都不会被挡在心跳之外，也永远抢不走
`keeper`。「两条 SSH 连接」和「两个客户端」是两回事。

#### 连接数上限

- 全局 `CONN_MAX`（64 条），以及每个 uid 的 `max_connections_per_user`
  （见 [CONFIGURATION.md](../cluster/docs/CONFIGURATION.md)）。
- 两处都是 accept-then-reject：超限那条连接读到 `5 too_many_connections`
  再被关掉，而不是静默等在 backlog 里（那样客户端会在 40 秒后报一个方向反了的
  `daemon_unreachable`）。
- 已经在的那些一条都不动。这里没有"顶掉"：顶掉那条路上没有终点，被顶掉的
  自动重连，反过来顶掉对方，拉锯。换一台电脑看同一个作业走的是 `takeover`（见下）。

#### 通知的形状

```json
{"push": "sessions", "seq": 12, "at": 1758800000,
 "sessions": [ ... 与 `list` 的 `data.sessions` 逐字同构 ... ],
 "stale": {"dropped": 2, "from": 10}}
```

- 判据：有 `push` 键且没有 `rid` 就是通知，有 `ok` 键就是响应。两者不会混淆：
  响应永远带 `ok`，通知永远不带。
- `at` 是这份视图取自哪一时刻（秒）。客户端据此看得出画面有多旧。
- `stale` 只在丢过通知时出现，见下。

#### 只推全量，绝不推增量

每条通知都是一份自足、完整的会话列表。于是丢掉任何一条都无害 ——
下一条会纠正它。这一条是整套背压能这么简单的原因：丢弃不需要分级、客户端不需要
重放，"重连恢复"与"落后恢复"是同一条代码路径。

推送一旦带上增量，"丢弃"就不再无害，而症状是界面上静默地少一个会话 ——
不报错、不重连，只是少一行。

#### `seq` 与 `stale`

`seq` 是每条连接各自的单调计数，每一条通知 +1。

水位（见下）挡下一条通知时，它照样占一个 `seq` —— 于是缺口本身就是凭据：

```
收到 seq  1 2 3 5      末−首+1 = 5 = 收到 4 条 + stale.dropped 1
```

`stale: {"dropped": N, "from": M}` 搭在下一条能发得出去的通知上，自己不单独成为
一条消息 —— 水位高的时候它同样发不出去，那是个悖论。`from` 是缺口的第一个 `seq`。

#### 通知不计入限流桶

桶（`max_rpc_per_second`，按 uid、1 秒滑窗）在 `dispatch` 里，而通知根本不从
那里走 —— 它是一条独立的入队路径。不写成 `if op != "push"`：那是在调用点做例外，
下一个人会加第二个。让通知不走 `dispatch`，例外就变成一个结构事实。

这不是洁癖。桶对所有 op 一视同仁，而 `heartbeat` 就在里面。通知一旦计进桶：

```
通知占满桶 → 心跳被回 rate_limited → 服务端记的 last_hb_at 不更新
          → 300 秒 suspect → 1800 秒自动 scancel
          → 用户正在跑的作业被杀掉，而界面只显示"心跳发送失败，仍在重试"
```

#### 背压：软水位与硬水位

| 水位 | 值 | 到了会怎样 |
|---|---|---|
| 软 | 64 KiB | **摘掉读侧** —— 不再接受新请求。在途响应因此天然有界 |
| 硬 | 4 MiB | **丢通知**（≠ 丢响应）。丢的同时 `seq` 照常前进、`stale` 记数 |

硬线必须等于 `RPC_MAX_RESPONSE_BYTES`（4 MiB）：合法响应最大的是
`plugin_package`（base64 之后约 2.7 MiB），硬线比它小的话，一条合法响应会因为
"队列里还压着一条快照"而进不去 —— 症状是插件装不上，而报错会指向守护进程没响应。
这个等式由 `cluster/test-sessiond-logic.py` 逐字比对（三处：守护进程、CLI、客户端）。

#### 一句必须写下来的语义

> 通知说的是「上一次对账时的视图」，不是实时查询。

它最多旧一个 tick（2 秒）—— 渲染时只读本 tick 已经取过的作业信息，一次
`scontrol` 都不发。理由不只是省：按连接渲染的代价是 O(会话 × 连接)，那会把
"常驻通道"变成"常驻风暴"。

#### 三条边界

- 通知里不含任何口令。它与 `list` 同构，用的是 `with_secret=False`，连作业内那个
  ssh 服务的主机公钥一起不给。需要它们的地方（真正要连的那一个会话）走 `status`。

  所以"通知里没有秘密"是一条结构性质，不依赖任何一处判断。客户端那半边是它的对偶：
  这两个键缺席时要保留旧值，而"换了会话"时不保留。
- 通知的 `sessions` 截断到最近 50 条，与 `list` 同一条规则。所以它是「这一批」里
  有什么，不是「你一共有哪些会话」。在这里找不到某个 `session_id`，不构成"那个会话
  没了"的证据，谁都不许这么读。

  而 `list` 帮不上忙：它同样截断到 50 条。能回答"这个会话还在不在"的只有一条路，
  就是带 `session_id` 的 `status`，它按 id 取，不经过那个截断。
- 没有变化也会推。周期 30 秒，且必须严格小于客户端的 `STATUS_MS`（60 秒）
  —— 否则这次改动在"数据新鲜度"上是净退化。客户端的看门狗再取它的两倍多
  （`PUSH_STALE_MS = 75 秒`）：两个数的大小关系由 `cluster/test-sessiond-logic.py`
  逐字比对。

#### 一次往返可以很慢，而协议不设超时

`submit` 会 fork 一次 `sbatch`，合法地跑上几十秒。所以：

- 协议层没有请求超时。一条响应可以在很久之后才回来，`rid` 保证它不会串到
  别的请求上（响应允许乱序）。
- 超时是调用方的事，每个调用点各自有各自的语义超时（`submit` 45 秒、
  `goodbye` 10 秒）。客户端那条常驻通道另有一个兜底超时，它刻意取得比任何
  调用点都长 —— 取短了它会抢先切断一条合法请求，而症状是"提交超时"，
  一句把根因指向集群的话。

#### 连接层

- 同时最多 64 条连接（与 `listen()` 的 backlog 一致）。超限的那条会被
  accept-then-reject：它读得到 `5 too_many_connections`。
  只"不 accept"是不行的：客户端 `connect()` 仍然成功，然后静默等到 40 秒超时，
  报一个方向完全反了的 `daemon_unreachable`。
- 半关（读到 EOF）不是断线。只停读，连接留着，等出站排空。

  老客户端每次发完就半关，在那里关连接会把 `submit` 的响应一起带走，于是客户端拿不到
  `job_id`，重试被 `quota_active` 拒，用户看到「提交失败了」而作业在跑。

  没订阅过的连接排空即关；订阅过的留 `EOF_LINGER`（10 秒）。

## 三、错误码

| code | 含义 | 典型 `kind` | CLI 退出码 |
|---|---|---|---|
| `0` | 成功 | — | `0` |
| `2` | 用法错误 / 客户端 bug / 请求不合法 | `bad_request`、`bad_json`、`empty_request`、`unknown_op`、`bad_partition`、`bad_time`、`bad_gres`、`bad_resources`、`bad_service_kind`、`missing_service_kind`、`bad_ssh_pubkey` | `2` |
| `3` | 未找到（会话不存在，uid 查不到，或本站没有这个东西） | `not_found`、`unknown_uid`、`plugin_unknown` | `3` |
| `4` | 被拒绝：配额、权限、账户、熔断、这个服务用不了 | `quota_active`、`no_account`、`no_partition`、`throttled`、`forbidden`、`service_kind_disabled`、`service_kind_no_job`、`plugin_package_too_large` | `4` |
| `5` | **守护进程暂时给不了**：不可达、端口池空、常驻连接已满、正在重启 | `daemon_unreachable`、`no_port`、`too_many_connections`、`draining` | `5` |
| `6` | Slurm 侧失败 | `partitions_unknown`、`submit_failed` | `6` |
| `7` | 触发限流 | `rate_limited` | `7` |
| `9` | 守护进程内部异常 | `internal`、`plugin_package_changed` | `1`（不在映射表内，落到默认值） |

退出码映射见 `SLURMATE` 的 `_code_to_exit()`（`cluster/slurmate`）；
`9` 不在其中，所以返回 `1`。CLI 自己的退出码约定写在 `cluster/slurmate`。

> 这张表是实现者的唯一依据。一份不全的表，症状是下一个人照着错的表写代码，
> 而不是某个用例变红。所以每一条 kind 都要登记进来，包括那些看起来只会在用户报错里
> 出现的（`missing_service_kind` / `service_kind_disabled` / `service_kind_no_job`
> 这一类）。

> `9 plugin_package_changed` 是故意用 9 的：它不是"客户端请求错了"，而是"本站自己
> 脚下的字节在服务期间被换掉了"，管理员就地换了插件包。

> 归到 `2` 会让客户端把它当成自己的 bug 去重试，归到 `3` 会让用户以为要换个插件。
> 它实际要的是站点重新部署，只有 `9`（内部异常）不会把人指向错误的方向。

`code 5` 有两种含义，这是本协议最容易写错的地方。见下一节。

---

## 四、三态区分（本协议的核心）

客户端必须区分三种「没成功」的情形，处理方式完全相反：

### 1. 传输层失败 —— 没拿到应答

触发条件（`client/src/main/classify.js`）：

- 后端抛了传输错误（`transportError`）：SSH 断了、channel 关闭但没有 exit 事件、超时；
- 响应为空或不是对象；
- 响应不是合法 JSON。

处理：重试。而且绝不能因此判定会话结束 —— 心跳照发。
客户端刻意不区分「SSH 断了」和「守护进程没回话」：两者在客户端看来是同一种东西
（请求没得到应答），处理方式也一样（`client/src/main/classify.js`）。

### 2. 守护进程不可达 —— `code 5` 且 `kind == "daemon_unreachable"`

这是守护进程侧明确地通过一份合法 JSON 声明它不可达。具体来源是 CLI：
它连不上 unix socket 时，会自己合成这个信封
（`cluster/slurmate` 的 `cmd_rpc`）。
也就是说，守护进程本身从不产生 `daemon_unreachable` —— 它连不上时根本没法回话。

处理：退避重试，并保持心跳。客户端的提示文案是：

> 「控制节点上的 Slurmate 守护进程没有响应。你的作业仍在运行。」

（`client/src/main/classify.js`）

### 3. 守护进程明确拒绝 —— 其余 `ok:false`

处理：停止重试，把 `error.detail` 原样展示给用户。

### 4. 心跳被回 `ignored` —— 一条成功响应，而它是一句状态

「这条作业被另一台电脑接管了」不是一个错误，也不走 `ok:false`：

```json
{"ok": true, "code": 0, "data": {"state": "enrolled", "at": 1758800000,
                                 "ignored": "not_keeper"}, "error": null}
```

`ignored` 是逐会话的（它回的是这一条 `session_id`），而它是客户端认出
「本机不再管这条会话」的唯一信号。

处理：这条会话进入「已被接管」状态 —— 停下它的心跳与对账，而且
`stop()` 一个字都不许发给服务端。那条 `goodbye` 会让 `phase_release` 删掉 ACL
并 scancel 作业，而用户以为自己只是换了个地方看。服务端分辨不了那个 `goodbye`
是谁发的（它按 `session_id` 记账，不按连接），所以这一半只能在客户端堵
（`client/src/main/session.js` 的 `suspend`）。

为什么不回 `ok:false`：心跳不是一条会让客户端重试的请求，回错会让它退避，
进而把「不是看护者」演成「网络不好」。而 `ignored` 这一格正是为了让它看出区别。

### 为什么必须靠 `kind` 而不是 `code`

`code 5` 同时被用于「连不上守护进程」和「端口池耗尽」，而处理方式相反：
前者要退避重试并保持心跳，后者只是等一下（`client/src/main/classify.js`）。
这是 `classify.js` 这个文件存在的首要理由。

分错的代价是现实的：把 `daemon_unreachable` 当成「会话没了」去处理，就会停止心跳 ——
一个正在跑的作业在 `orphan_after`（默认 1800 秒）后被自动 `scancel`，
而用户以为自己只是断了个线。

同一条原则适用于 `code 4`：`kind == "throttled"` 是被熔断了，等一会儿会自动恢复，
不是用户能解决的问题，所以走退避重试而不是「请用户去处理」
（`client/src/main/classify.js`）。

---

## 五、重试策略

由 `classify()` 一次映射成「客户端可行动作」（`client/src/main/classify.js`）：

| 动作 | 触发 | 默认退避 | 自动重试 |
|---|---|---|---|
| `ok` | `ok:true` | — | — |
| `transport` | 传输层失败 | 由调用方定（客户端用 1s→2s→4s…上限 30s） | 是 |
| `daemon_down` | `code 5` + `kind=daemon_unreachable` | 同上 | 是 |
| `rate_limited` | `code 7` | 5000 ms | 是 |
| `retry_soon` | `code 5` + `kind=no_port` | 5000 ms | 是 |
| `retry_backoff` | `code 5` 的其他 kind；`code 4` + `throttled`（60000 ms）；`code 6`（非 `submit`）；`code 9` | 3000 ms | 是 |
| `session_gone` | `code 3` | — | 否（终局） |
| `quota_or_permission` | `code 4`（非 `throttled`） | — | 否（要用户去解决） |
| `fatal` | `code 2`；`code 6` 且 `op == submit`；未知 code | — | 否 |

两条附加规则：

- 未知 code 一律当作不可重试。「宁可停下来让人看见，也不要盲目重试掩盖问题」
  （`client/src/main/classify.js`）。
- `code 2` 绝不重试。重试只会重复同一个错误，白白消耗 RPC 配额
  （配置键 `max_rpc_per_second`，缺省 100；`client/src/main/classify.js`）。

### 幂等性：只有 `submit` 不是幂等的

`classify()` 返回的 `idempotent` 字段是一个可断言的开关：
`op !== 'submit'`（`client/src/main/classify.js`）。`shouldRetry()` 会在
`idempotent` 为假时直接返回 `false`，无论动作是什么。

`submit` 必须这样处理的具体理由：`op_submit` 每次调用都生成新 `sid`、插新行、
提交新作业（`cluster/slurmate-sessiond`）—— 它是非幂等的。

F14 已经修掉：配额数的那个集合（`OCCUPYING_STATES`）含 `reserved` / `submitted`，
所以「已提交、尚未登记」那个窗口里它不再是 0，并发的第二个提交当场被拒。

修法是完备的。唯一的依据是守护进程不可重入：`dispatch()` 在事件循环线程里同步跑到底，
内部没有任何让出点，所以两次 `submit` 不可能交错。而那道检查在 `store.insert` 之前
（见 [ARCHITECTURE.md](ARCHITECTURE.md)〈六之二〉最后那一节）。

客户端这套处理照旧不变：服务端那一侧修好了，不等于客户端可以开始重试。超时仍然可能
是"响应丢了而会话建好了"，认领仍然是唯一正确的下一步。

所以客户端的做法是（`client/src/main/session.js`）：

1. `submit` 超时（45 秒）后绝不重试；
2. 改调一次不带 `session_id` 的 `status` —— 它会返回该 uid 最新的活跃会话
   （`cluster/slurmate-sessiond`），用于认领「响应丢了但会话其实建好了」；
3. 认领成功就在界面上说明「提交响应超时，但已在控制节点上找到刚创建的会话，继续接管」；
4. 认领失败则明确告诉用户去 `squeue` 检查是否有多余作业。

---

## 六、操作

所有 op 都在 `dispatch()` 里分发（`cluster/slurmate-sessiond`）。
限流先于一切：任何 op 都要先过 `rpc_allowed()`（配置键
`max_rpc_per_second`，缺省每 uid 每秒 100 次），超了直接
`_err(7, "rate_limited")`。
请求能解析成 JSON 对象但 `op` 不认识 → `_err(2, "unknown_op", op)`。

### `ping`

请求：`{"op":"ping"}`

成功：`{"pong": true, "version": "0.7", "time": 1757...}`

最小连通性探针，用来在排查时区分「链路不通」和「业务逻辑出错」。

`version` 是服务端的基座版本，而客户端会读它。连接建立后、任何会话之前，客户端拿它
与自己的版本比一次（规则见上面〈三方：谁不低于谁〉），不通过就断开并要求用户升级。

所以这个字段的形状**必须**是 `x.y`（`client/package.json` 里那个号）。报一个别的东西
（比如 `"0.7-demo"`）会被客户端判成"这条链路上答话的不像我们的守护进程"：
那个结论不谈版本，它说的是链路。

### `daemon`

请求：`{"op":"daemon"}`

成功 data：

```json
{"version": "0.36", "pid": 123, "started_at": 1757...,
 "config": {"path": "/etc/slurmate/slurmate.conf",
            "digest": "…", "on_disk_digest": "…", "loaded_at": 1757...,
            "last_reload": {"seq": 3, "at": 1757..., "ok": true,
                            "error": null, "cold_keys": [], "notice_keys": []}},
 "sessions": {"active": 2},
 "plugins": {"total": 2, "enabled": 1},
 "port_range": [55001, 55999], "nft_table": true,
 "draining": {"until": 0}}
```

只读。任何用户都能问：它报的是守护进程自己的事实，不是某个人的数据。

`config.digest` 是已载入的那一份配置（主文件 + 它的 `.d/` 目录）的摘要，
`on_disk_digest` 是盘上现在的那一份。两者不同，表示有改动尚未生效；判断由
调用方做（`slurmate service status` 据此说一句话），守护进程不替它下结论。

`last_reload.seq` 每完成一次重载加一，`ok` 说那次接受还是拒绝，`error`
是拒绝的原因，`cold_keys` 是"必须重启才生效"的那几个键。CLI 的
`service reload` 先记下这个序号，发 `SIGHUP`，然后等它前进 —— 于是
"接受"与"拒绝"有确定答案，而不是只看 `systemctl reload` 的退出码。

`sessions.active` 数的是占着位置的会话（含排队中），与配额用的同一组状态。
`nft_table` 为假表示读不到自己的表；`draining.until` 是排空窗口的截止时刻，
0 表示没有排空。

### `drain`

请求：`{"op":"drain"}`

成功：`{"draining": {"until": 1757...}, "seconds": 60}`

只有 root 能发（uid ≠ 0 → `4 forbidden`）。置一个 60 秒的窗口：窗口内
`submit` 回 `5 draining`，其它 op 照常。`dispatch` 同步执行，应答 drain 时
没有在途 op，所以紧接着的重启不会切断一次走到一半的提交。

窗口不续期，到期自动恢复；重启失败也不会把站点永久锁在排空态。

### `stop_all`

请求：`{"op":"stop_all"}`

成功 data：

```json
{"stopped": [{"session_id": "…", "job_id": 123}],
 "expired": ["…"], "cancel_failed": [],
 "remaining": 0, "draining": {"until": 1757...}}
```

只有 root 能发（uid ≠ 0 → `4 forbidden`）。这是 `slurmate service stop`
的第一步：打开排空窗口，把本站处于占用状态的全部会话交给释放流程
（`scancel` + `releasing`；没有作业的 `reserved` 直接落 `expired`）。
恢复态行（`trust='recovered'`）也取消：“永不自动 scancel”防的是自动流程，
不是管理员显式关机。

`stopped` 是已发出取消的，`cancel_failed` 是这一次没发成的；补发的重试由
`phase_release` 负责。`remaining` 是应答那一刻仍占着位置的条数（含正在释放
的）。

CLI 在它归零之后才停服务：claims 行若还停在 ACL 状态，下一次启动的
`reconcile()` 会把规则补回来。

用户自己的 Slurm 作业不在其中：这里只取消 claims.db 里本站的 `job_id`。

### `whoami`

请求：`{"op":"whoami"}`

成功 data：

```json
{"uid": 1001, "gid": 1001, "user": "alice", "home": "/shared/home/alice",
 "account": "acct", "account_error": null,
 "allowed_partitions": ["A6000"], "can_submit": true}
```

`allowed_partitions` 为 `null` 表示已确认不限制；`account_error` 非空时
`can_submit` 为假，且那句话可以直接展示给用户。

错误：`3 unknown_uid`（`cluster/slurmate-sessiond`）。

### `partitions`

请求：`{"op":"partitions"}`

成功 data：

```json
{"partitions": [{"name": "2080TI", "allowed": true, "is_default": true,
                 "max_time": "183-00:00:00", "mem_per_node_mb": 128000,
                 "cpus_per_node": 40,
                 "gres": [{"name": "gpu", "type": null,
                           "per_node_max": 8, "total": 8}]}]}
```

分区列表从 Slurm 现查（`scontrol show partition -o`），并与该用户的
association 求交。客户端不再自己维护一份「用途 → 分区」的声明式配置 ——
那是策略，而策略不该同时存在于两个地方。

`allowed` 为假时附 `reason`（界面据此禁用并说明原因，而不是让用户猜）。

`mem_per_node_mb` 是这个分区里内存最大的那种节点的内存，单位 MB（与 Slurm 的
`RealMemory=` 同单位）。它是三态，与下面 `gres` 同一条规矩：

| 取值 | 意思 |
|---|---|
| 键**不存在** | **查不到**（`scontrol` 失败，或这个分区里的节点没有报 `RealMemory=`）。界面**不许**据此说"这个分区没有内存上限" |
| 整数 | 这个数就是上限 |

> 取的是"最大的那种节点"：一个作业要得比它还大就永远排不上，所以它是界面那个
> 滑块的顶。取平均值或最小值都会报一个更小、看起来更保险的数，而那个数与
> "这个分区能跑多大的作业"不是同一件事。

> 它是一个事实，不是一道闸。服务端对内存只校验写法（`([0-9]+)([KMGTP]?)`），
> 要得比节点还大只是排不上，不会被拒。这一条是如实记的，不是"以后会加"。

> `-o` 的那一趟输出里，没配 GRES 的节点（`Gres=` 整个不出现）占绝大多数，
> 而它们照样有内存 —— 两个累加器在守护进程里是分开的。

`cpus_per_node` 是这个分区里一台节点最多能要到的有效核数，来源是
`scontrol show node -o` 的 `CPUEfctv=`（缺席时退回 `CPUTot=`）。它同样是三态：

| 取值 | 意思 |
|---|---|
| 键不存在 | 查不到（`scontrol` 失败，或这台节点两个字段都没报）。界面退回一个保守的退路 |
| 整数 | 这个分区单节点的上限 |

> 不是 `scontrol show partition` 的 `TotalCPUs`：那个是分区总和（两台各 80 核
> 报 160），拿它当 `--cpus-per-task` 的上限会让用户填一个任何一台节点都给不出
> 的数。

`gres` 是这个分区上能申请的 GRES，来源是 `scontrol show node -o` 的 `Gres=`
与 `Partitions=`（`Slurm.node_catalog()`）。它是三态，与协议里其它地方同一条规矩：

| 取值 | 意思 |
|---|---|
| 键**不存在** | **查不到**（`scontrol` 失败）。界面**不许**据此说"这个分区没有卡" |
| `[]` | 查到了，这个分区确实一个 GRES 都没配 |
| 非空 | 每一项 `{name, type, per_node_max, total}`；`type` 为 `null` = 这个 GRES 没配型号 |

> 一个作业能要到的上限是 `per_node_max`，不是 `total`。`--gres=gpu:N` 是每节点
> N 个：8 张卡分在 4 台机器上（`total: 8`、`per_node_max: 2`）时，一个作业最多只能
> 要 2 张。界面拿它当数量那一格的 `max`，服务端拿它当判据。

> 这一份不带"已用"。已用与可用在 `cluster` op 的 `gres` 项里
> （`used` / `free`），来源是 `sinfo -O` 的 `GresUsed`。

> 本机实测（slurm-wlm 23.11.4）：`scontrol show node -o` 的文本里没有
> `GresUsed=`，但 `sinfo -N -O "…,GresUsed:…"` 有。三态与边界写在
> `cluster` 那一节。

> 这里没有 `defaults`。默认资源是按插件的（在一个 shell 里跑 codex 和在
> IDE 里跑语言服务器不是一回事），所以它跟 `plugins` op 走。在这里放一个全局的
> `defaults` 就是两份真相：界面显示 2 核 / 8G，而实际提交中转站会话拿到的是
> 1 核 / 2G，且没有任何地方会为此报错。

错误：`3 unknown_uid`。

### `plugins`

请求：`{"op":"plugins"}`

> 这个 op 本身是 v0.3 才有的。v0.2 的守护进程回 `2 unknown_op` —— 客户端
> 那时**必须**按"站点没说"处理（按钮照画），而不是把它当成"本站一个插件都没有"。
> 同一份纪律也适用于这个响应里个别字段的缺席，见下面 `can_submit`。

成功 data：

```json
{"plugins": [{"id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "version": "1.0.0",
              "name": "ide", "title": "开发环境", "enabled": true,
              "can_submit": true,
              "defaults": {"cpus": 2, "mem": "8G", "time": "12:00:00",
                           "gpus": null},
              "max_sessions": 2,
              "package": {"format": 2, "bytes": 19416, "digest": "…"}},
             {"id": "01BX5ZZKBKACTAV9WEVGEMMVRZ", "version": "1.0.0",
              "name": "relay", "title": "中转站", "enabled": false,
              "can_submit": false,
              "defaults": {"cpus": 1, "mem": "2G", "time": "12:00:00",
                           "gpus": {"name": "gpu", "type": null, "count": 1}},
              "max_sessions": 1,
              "package": {"format": 2, "bytes": 40000, "digest": "…"}}],
 "enabled": ["ide"],
 "limits": {"file_bytes": 262144, "total_bytes": 1561905, "max_files": 256,
            "package_bytes": 2097152},
 "problems": ["插件 「x」（01E439TP9XJZ9RPFH3T1PYBCR8）没能加载：…"]}
```

> 每一项里只有名字、版本、开关、默认资源与一个 `package`。详见下面
> 〈`package` / `limits`〉。

> 注意 `plugin.json` 也在包里：客户端界面要读它（名字、默认资源…）。

> 只发客户端侧，不发整个包：`job/**` 与其它只属于站点侧的路径一个字节都不发给
> 客户端。客户端解包时还会拒绝任何含站点侧路径的包，而且是拒整份。

> 那半边里躺着 `job/start.sh`，一份以提交者本人的身份在集群上执行的脚本。它跑在谁的
> 账号下，就决定了它有多不该躺在别人家的笔记本里。

> `plugin.json` 与 `lineage.json` 两侧都在（逐字节相同），站点盘上那棵树也带着它们，
> 所以它们各进两份摘要各一次。

> `defaults` 是「这个插件缺省给多少」的四个答案，而它们是同一件事的四个面，
> 客户端显示它们的地方也只有一个，所以不会各自漂。

> `cpus` / `mem` / `time` 是标量，`gpus` 是描述符或 `null`（与 `submit` 的 `gres`
> 同一形状）。

> `gpus: null` 是本站确实没给这个插件配默认卡，一个确定的事实。而"这一格整个不在"
> 是老守护进程，那里没有 `time` / `gpus` 这两格。

> 三态，缺席 ≠ 否，与 `can_submit` 同一条规矩。客户端不许给缺席的那一格补一个值。

> 顶层 `problems`：那些没能加载的插件。它把"只有登录节点上才看得见"的失败
> （`--check-plugins` / 启动日志）抬到协议上。

> 少了它，客户端看到的是「本站没有这个插件」，而真相是「本站有两个、因为撞 `id`
> 没被加载」。运维在客户端上排查，方向从第一步就是错的。

> 形状照 `limits`（顶层、站点级、有就有没有就没有）。它不阻塞任何东西：一个插件坏了
> 不该让整个站点起不来，起不来连"停掉正在跑的会话"都做不到。所以它是通报，不是错误码。

> 老守护进程没有这一格。缺席 = 不知道，不是"没有问题"（三态那条规矩），不许补一个
> 空数组当作读过。

> `package` 里那三个数是示意值：本仓库那两个插件还没有包（要作者先 `packer init` /
> `keygen` / `build`，见 [packer/docs/README.md](../packer/docs/README.md)）。

> `format` 是容器格式版本（[PLUGIN-CONTAINER.md](../packer/docs/PLUGIN-CONTAINER.md) 的
> A.1 里那个 `format`，不是插件的版本号；本版是 `2`）。`bytes` 是要发出去的那一份的
> 字节数：客户端要下载的就是这么多。

> `digest` 是客户端侧的内容摘要（§3.4 按侧算的那一份），不是容器字节的 sha256。

> 这三项说的都是"要发出去的那一份"，不是站点盘上那棵树。站点盘上是一棵整树
> （两侧都在，`job/**` 也在），而发给客户端的只有客户端侧（`client/**` +
> `plugin.json` + `lineage.json`），所以这三个数都比"把整棵树重打一遍"小。

> 而 `digest` 就是签名四元组里的 `digestClient`
> （[PLUGIN-CONTAINER.md](../packer/docs/PLUGIN-CONTAINER.md) 的 A.3）。客户端收到
> 字节之后会自己重算一遍再与它比，所以本站改客户端侧任何一个字节都拦得住。
> 而"本站报的数"与"本站转发的字节"是分开的两件事。

> `max_sessions` 是本站给这个插件设的并发上限：每个用户最多同时几个会话（排队中的
> 也算）。它是一个已经解析好的数：插件那一份配置里写了就用它，没写就是主配置的
> `max_sessions_per_user`。客户端不自己算那一格，主配置那个值不在任何应答里，它
> 拿不到用来推的东西（同 `can_submit`）。

> 它与 `defaults` 同一类：管理员设的政策，客户端只读地显示。它不预告"你还能不能再
> 开一个"，因为那要看用户此刻有几个会话，而那是会变的东西。真超了的时候，拒绝里
> （`4 quota_active`）带着当下的个数。

> 老守护进程不报这一格。缺席 = 站点没说，不是 `1`（三态，与 `can_submit` 同一条
> 规矩）。客户端不许给缺席的那一格补一个值：那会是一句编出来的政策，而用户会拿它当
> 本站的规定。

> `can_submit` = 「现在提交得出去吗」= `enabled` 且本站有它的作业侧实现。

> 两个事实合成一个字段，是因为服务端才是同时知道这两件事的那一方。让客户端自己拿
> `enabled` 去推，就多出一份会漂的推理。

> 而多出来的那一位（这个插件有没有 `job/start.sh`）客户端根本看不见：那一半客户端
> 从来不读。

> 它与 `enabled` 不是重复的，因为两句话对应两个该做的事。

> `enabled=false` 该说「本站没开放它，去找管理员」。`enabled=true` 而
> `can_submit=false` 该说「本站装了它，但它没有作业侧实现」。后者打开那个开关没有用，
> 得重新部署。

> 老守护进程不报这个字段，那不等于「否」。客户端必须按"站点没说"处理，缺省当作
> 可以提交，否则升级一次客户端会让所有老服务端的插件按钮同时变灰。这与 `plugins`
> 整个 op 缺席是同一条纪律（见本节开头那段）。

> `can_submit` 不违反"不发 `needs_pubkey` 那类字段"的原则。那条原则管的是
> "这个插件在客户端上会做什么"，那是客户端自己的事。`can_submit` 说的是站点这一侧的
> 事实，客户端无从推导。

> 每一项里没有 `builtin`，也没有"内建插件"这回事。两端都只认"装了的插件"，
> 而"装"是站点的一个动作（集群侧 `slurmate plugin install`，客户端是经站点分发
> 取回来）。至于"插件的代码随本项目一起发布" —— 那只是仓库里那两个插件的来路，
> 协议不认识它。

客户端据此决定画哪些按钮、以及每个按钮上"默认 2 核 / 8G"该写多少。

> `id` + `version` 是解析键，`name` 只是人读的短名。客户端拿 `(id, 版本)` 去
> 自己的插件池里找配套的那一半。

> 为什么不能靠 `name`：插件由站点分发，没有市场能在线升级，两个站点可以各有一个叫
> `jupyter` 的插件而它们是不同的东西。反过来同一个插件被两个站点分发又该被认出来。
> 名字答不了这两个问题，铸造出来的 `id` 才答得了。

> `name` 出现在它那份配置的文件名、日志与 `service_kind` 里。它既不需要全球唯一，
> 也不需要站点内唯一：两个 `id` 不同、短名一样的插件允许在同一个站点上并存。

> 所以不要拿 `name` 当键：`op_plugins` 的响应里认亲用的是 `id`，客户端的表也按 `id`
> 收。短名撞了的时候，只有站点自己的配置校验要求写 id 来消歧（文件名用 `<id>.conf`），
> 协议这一层不替任何人挑一个。

三条契约，每条都对应一种"用户看不见"的失败：

- 报出全部插件，包括 `enabled: false` 的。「装了但停用」与「本站没有这个东西」
  是两回事，界面该能分开显示，运维该能一眼看出自己关了什么。
- 不替客户端过滤它可能不认识的名字。把它认识的挑出来再发，运维就永远看不到
  「站点开了个我这版客户端不认识的插件」—— 而那正是升级提示的唯一来源。
- `title` 是给不认识它的客户端用的兜底标签。客户端认得这个插件时用它自己的
  名字（那个才对应它实际会做的事）。

这里不发 `needs_pubkey` 之类"这个插件在客户端上会做什么"的字段：那些是客户端
自己的事（它的插件模块里写着），由服务端下发只会让客户端有机会相信一个关于自己
的错误描述。

错误：`3 unknown_uid`。

#### `package` / `limits` —— 站点分发

这两样是可选的加法。老守护进程不报它们，客户端必须按"站点没有这个能力"处理
（见〈三态区分〉）。

- 顶层 `limits` 在不在，就是"本站支不支持分发"的唯一判据。它必须是一个
  协议事实，下载失败、超时、校验不过都不构成判据 ——
  那是瞬时事实，拿它当判据等于给一个能让下载失败的人（断流、丢包、中间人）一个
  把用户降级到别处的开关。
- `package`（`{format, bytes, digest}`）是这一份分发出去的样子，配合
  `plugin_package` 一次把那一份取回来。
  - `digest` 是客户端侧的内容摘要（§3.4 按侧算的那一份），不是容器字节的
    sha256。给同一个负载补一个签名块，容器字节变了而它一个字都不变。
    这正是"摘要不变就是还是同一份构件"（§2.4/§4.2）在协议里的样子。

    客户端拿它的唯一正确用法是"与我自己从下载到的字节重算出来的那个比"。
    这一点在两个方向上都被用上了。

    站点重打包（整包 → 只含客户端侧）时容器字节全变了，而 `digest` 一个字不变，
    这是 §4.2「签名不覆盖信封」的兑现。反过来，站点改客户端侧任何一个字节，
    重算的摘要就变了，客户端拒。
  - `package: null` 是一个真实的状态，不是"本站没有这个能力"。它说的是
    "这一份现在给不出来"，包在守护进程启动之后不见了。

    能力在不在，判据是顶层有没有 `limits`。两件事必须分得开：合成一个信号的话，
    一次误删文件会让客户端把整站降级。
  - 这一项里没有 `package` 这个键（`undefined`）= 这一份不分发。三个状态
    必须分得开，这也是〈三态区分〉在字段一级的样子：
    `undefined`（本站不打算发这一份）／`null`（此刻生产不出来）／一个对象（发）。
- `limits` 也是自述，客户端取"本站报的"与"客户端自己的硬上限"中更严的
  那个。一个站点（或一次中间人）报 10 万个 1 字节的文件，客户端会跑很久、耗尽
  inode、把家目录塞满 —— 上限不能由被审计方单方面决定。
- `limits` 里有两笔不同的账，别混。`file_bytes` / `total_bytes` / `max_files`
  是负载内的规则，管解出来的那些文件。`package_bytes` 是链路上的，管发出去的那一份
  base64 之后要能装进一条应答。

  一个插件可以三个负载数字都合格，而发出去的那一份仍然太大。那时客户端连一次都取不
  回来，所以这一条必须单独报。

  而负载内那三个数不走线：它们只由客户端读方执行，它拿包里的记录表与本站报的上限比。
  本站只通报、不拦截，唯一拦得住的是 `package_bytes`，安装器与 `op_plugin_package`
  两侧都拦。
- 负载里的每一条路径都要再判一遍。解析器已经拒过（§3.3 是一条拒绝规则，
  不是"遍历时跳过"），而客户端还要自己再判一次：服务端也可能被换过，与
  `validate_session()` 对会话文件的态度同源。

  任何一条不过就拒绝整份。一个说不清的包本身就是"这份东西不能信"。
  没有任何一条对外应答是按路径逐份取的，路径穿越这个形状只剩"进不进得了包"这一道。
- 符号链接与空目录进不了负载。插件变成包之后这不是一条纪律，是结构性的：
  包里的负载是一条条 `路径 | 字节`（[PLUGIN-CONTAINER.md](../packer/docs/PLUGIN-CONTAINER.md) 的
  A.1），链接与目录
  条目表达不出来。所以这一条从"两端规则要一致"退化成"根本不会有"。
- 分不发由站点的 `enabled` 决定。本站关着的插件照样*报*（上面那条契约：
  报出全部插件），但客户端只分发 `enabled: true` 的那些。

### `plugin_package`

请求：`{"op":"plugin_package", "id": "<ULID>", "version": "1.0.0"}`

> 这个 op 是 v0.6 才有的。v0.5 的守护进程回 `2 unknown_op`。

成功 data：

```json
{"id": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "version": "1.0.0",
 "format": 2, "bytes": 19416, "digest": "…", "data": "<base64>"}
```

一整份一次取走，`data` 是那一份 `.splug` 文件本身（[PLUGIN-CONTAINER.md](../packer/docs/PLUGIN-CONTAINER.md)
那一套容器）的 base64。
`format` / `bytes` / `digest` 与 `plugins` 里那一份必须逐字相同（客户端据此判断
"这一轮清单说的"与"我拿到的"是不是同一个东西）。

"一整份"指的是只含客户端侧的那一份 —— 站点从盘上那棵整树现打一个
包发给客户端。协议字段一个字没改，换的是它们的含义（见上面 `package` 那一段）。
而站点盘上从此不再留 `.splug`：插件是一棵树 + 一份记录表（`<id>/` 与
`<id>.json`），容器只在"作者→站点"与"站点→客户端"这两段路上活着。

> 这条路发出去的是容器本身。客户端拿到那一份之后能自己解析、自己重算内容摘要
> （它手里有那一半的每一份文件）、自己验签（§4.2 / §6.1）。

> 于是本站报的 `digest` 与本站转发的字节是分开的两件事，客户端有办法发现它们对不上。

> 而站点侧那一半到不了客户端：它手里的包里根本没有那几份路径，客户端解包时还会拒绝
> 任何含站点侧路径的包。

> 客户端因此核不了 `digestSite`，它算不出来。那一格由站点自己守：每次对账与每次分发
> 前重算，对不上就不发。这是刻意设的守卫，不是漏掉的一格。

> 不因为是"整包"就多一层信任：发出去的是站点自己的字节，客户端仍然要自己验。

错误：

| code | kind | 什么时候 |
|---|---|---|
| `3` | `plugin_unknown` | 这个 `(id, 版本)` 本站没有 |
| `4` | `plugin_package_too_large` | 发出去的那一份超过 `limits.package_bytes`。**必须拒绝**：截断发出去等于客户端拿到一个解不开的容器，而它会在那边报成"包坏了" |
| `9` | `plugin_package_changed` | 这个包在守护进程起来**之后**被换过（字节数、内容摘要或容器格式对不上启动那一刻的快照），或者它已经不见了 |

> 正常部署下 `plugin_package_too_large` 拦不到东西 —— 安装器在装的时候就拒绝
> 了超过这个上限的包（装了也发不出去）。它拦住的是绕过安装器放进来的一份。

### `submit`

请求（全部字段可选）：

| 字段 | 类型 | 缺省 |
|---|---|---|
| `service_kind` | **本站的短名**（插件配置的文件名） | 配置里的 `default_plugin`；**没配就是必填**，否则 `2 missing_service_kind` |
| `ssh_pubkey` | 一行公钥 | 清单里 `contributes.submitPubkey` 为真的插件**必填**，否则 `2 bad_ssh_pubkey` |
| `cpus` | 整数 | **该插件**的 `site.defaultCpus`（站点可在它那份配置里覆盖；服务端钳制到 `1`–`MAX_CPUS_REQUEST`=1024，那只是挡住荒谬请求的绝对护栏，真正的上限是分区的 `cpus_per_node`） |
| `mem` | 字符串 | **该插件**的 `site.defaultMem`（必须匹配 `^[0-9]+[KMGTP]?$` 且非 0；否则回退默认并打 warning） |
| `gres` | **对象** `{name, type, count}`，或 **`null`** | **省略** = 用**该插件**的 `default_gpus`（站点在它那份配置里配的策略；它没配就是不占）。**显式 `null`** = 不占，**盖过**插件的默认。见下面的〈`gres`：一个结构化描述符〉 |
| `partition` | 字符串 | **未给 = 从该用户有权限的分区里随机挑一个**（见下） |
| `time` | Slurm 时间 | **该插件**的 `site.defaultTime`（站点可在它那份配置里覆盖；三处都不写才是内建的 `01:00:00`）。超过**分区自己的 `MaxTime`** 与硬上限 7 天中的较小者时截断 |

> 默认值一律由服务端填，不由客户端填。客户端省略字段是在说「用你的默认」，
> 不是「我要 0 核」。

> 服务端**必须**自己填默认值并做上限钳制，否则一个改过的客户端省略字段就能要到整台
> 机器。客户端的「高级选项」只是临时覆盖，不写进任何配置，关掉窗口即失效。

> 随机挑分区的边界：`allowed_partitions()` 查不到时返回 `PARTITIONS_UNKNOWN`
> 哨兵。随机挑的时候还要从装得下这个请求的分区里挑 —— 按分区的
> `gres` / `cpus_per_node` / `mem_per_node_mb` 逐个判；目录整份取不到时不判
> （权威在 Slurm 那一侧），一个都装不下报 `2 bad_resources`。

> 显式指定分区的路径继续 fail-closed：用户点了名就必须验，返回 `6`。缺省随机的路径
> 退化为不带 `-p`，交给 Slurm 的默认分区，并在响应里带一个 `warning`。

> 此时守护进程没有对权限做任何声明，而 Slurm 自己会用 association 兜住。这不是漏判，
> 实现时要写进注释，免得后人误「修」。

成功 data：

```json
{"session_id": "9f2c…", "job_id": 12345, "state": "submitted",
 "partition": "2080TI", "resources": {"cpus": 2, "mem": "8G", "gres": null},
 "candidates": [55001, 55002, ...], "requested_time": "12:00:00"}
```

`partition` 是实际选中的那个，必须返回 —— 因为是随机挑的，用户事先
不知道会落到哪种卡上，界面要显示出来。它也可能为 `null`：分区权限查不到时缺省提交会
退化为不带 `-p`（见上面的随机挑分区边界），那时「落在哪个分区」在提交那一刻确实无人
知晓，报 `null` 比编一个出来诚实。作业跑起来之后 `status` 会用 Slurm 的答案补上。

提交的那条连接就是这条会话的第一任看护者（`keeper`；没报身份的连接提交，
`keeper` 是 `NULL` = 确实没人在看）。这一格的判据与它的唯一用途都在
〈`heartbeat`〉那一节，这里只记"它是谁写的"。

### `gres`：一个结构化描述符

```json
{"name": "gpu", "type": "a100", "count": 2}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | 字符串（必填） | GRES 的名字，如 `gpu` / `mps` / `shard` |
| `type` | 字符串或 `null` | 型号，如 `a100`。没配型号的 GRES 就是 `null`（**不是空串**，服务端会把空串收成 `null`） |
| `count` | 整数 ≥ 1 | 要几个。**不占 GRES 就整个别写这一格**，不要写 `count: 0` |

`name` 与 `type` 只允许 `[A-Za-z0-9_]`、最长 32 —— 它们要原样进 `--gres=` 的
那一格，而 `:` 与 `,` 是 Slurm 自己的分隔符。其余的一律不校验：
GRES 是管理员自定义的（`GresTypes` + `gres.conf`），名字与型号随集群而定，
代码里没有白名单。

> GRES 是"名字 + 型号 + 数量"三件事，不是一个数字。

> 这是一个缺陷的形状，不是风格。在 `"gpus": 2` 那种表示下，守护进程写 `"gpu:%d"`、
> 读回来用 `re.fullmatch(r"gpu:(\d+)")`。

> 于是在一台配了型号的集群上，服务端自己写进去的 `gpu:a100:2` 自己读不回来：
> 正则不匹配，于是当成"没有 GPU"，界面上那一段整个不出现。作业占着两张 A100，
> 而用户以为自己没要卡，没有任何地方会报错。

> 所以修法不是把正则写宽一点，而是取消第二份表示。`{name, type, count}` 是唯一的
> 表示（线上、数据库、审计里都是它），交给 Slurm 的那个串（`name[:type]:count`）
> 由 `gres_spec()` 当场拼，全仓只有那一处。

> 上限由集群自己配了几个决定，不由代码决定。服务端拿 `partitions` 里那份清单
> 对账。

> 这个分区上没有那种 GRES，或者数量超过 `per_node_max`，都报 `2 bad_gres`。拒绝，
> 而不是悄悄截断：截断之后用户拿到的是"跑得起来但不是他要的"作业。

> 查不到清单时放行：权威本来就在 Slurm 那一侧，它会用同一份配置在 `sbatch` 那一刻
> 拒绝。

> 不要点名分区时会从"装得下它"的分区里挑。用户没指定分区、只要 `mps`，
> 而只有 RTX8000 有 mps —— 那么随机挑选的范围就是 RTX8000。否则用户被拒在一件
> 分区本来就没被指定），而界面上给的选项是所有有权限分区的并集，
> 两边必须是同一句话。

> `resources` 里的 `gres` 是同一个描述符或 `null`。`null` 有两条来路：
> 没要，以及从 nft 规则恢复出来的会话（守护进程没写过它的命令行）—— 与 `cpus`/`mem`
> 一样合并成同一个答案：这一行不说 GRES。

> 「省略」与「`null`」在请求里是两件事，而在这个响应里合成了同一个答案。
> 省略是用该插件的 `default_gpus`（站点配的策略），`null` 是用户明确不要卡。

> 分得开它们的只有 `"gres" in req` 那一句：`clean_gres(None)` 两条路都返回 `None`。

> 少了 `null` 这条出路，站点的默认卡就是一道用户无法拒绝的命令。而"开发会话默认占住
> A6000 的卡"是稀缺算力政策：管理员拍的是"默认"，不是"谁都不许说不"。

> 界面上的两项「用插件的默认」与「不占 GRES」，就是这件事的两个落点。

### `submit` 的错误

| code | kind | 触发 |
|---|---|---|
| `2` | `bad_partition` | 指定的分区名不存在 |
| `2` | `bad_gres` | `gres` 的形状不合法 / 这个分区没有那种 GRES / 数量超过 `per_node_max` |
| `2` | `bad_resources` | 没点名分区，而有权限的分区里没有一个装得下 `cpus` / `mem` |
| `2` | `bad_time` | 时间格式无法解析或 ≤ 0 |
| `3` | `unknown_uid` | `getpwuid` 失败 |
| `4` | `throttled` | 该 uid 在熔断静默期内 |
| `2` | `missing_service_kind` | 没给 `service_kind`，而本站也没配 `default_plugin` |
| `2` | `bad_service_kind` | 本站**没有装**这个短名的插件（客户端太新，或名字打错） |
| `4` | `service_kind_disabled` | 认得这个插件，但**本站没开**（管理员的一个决定） |
| `4` | `service_kind_no_job` | 本站装了它、也开着，但**它没有作业侧实现**。合法状态：这个插件可能只在本机运行（客户端有 `startLocal` 时给「在本机打开」）；也可能部署时漏了作业脚本 |
| `2` | `bad_ssh_pubkey` | 需要公钥的插件没带公钥，或那行公钥不合法 |
| `4` | `quota_active` | **占着位置**的会话数已达上限。上限有两格，都在站点那一侧：全局的 `max_sessions_per_user`，以及**这个插件自己的** `max_sessions`（见 [CONFIGURATION.md](../cluster/docs/CONFIGURATION.md)）。**排队中的也算**。是哪一格拦的写在 `detail` 里 |
| `4` | `no_account` | 该用户没有 Slurm association |
| `4` | `no_partition` | association 不允许这个分区 |
| `5` | `no_port` | 端口池暂时没有可用端口 |
| `6` | `partitions_unknown` | 分区权限**查不到**（安全路径上宁可拒绝） |
| `6` | `submit_failed` | `sbatch` 失败 |

> `service_kind` 这一族必须是四种错误，不能合并成一句话。分开它们的不是严重
> 程度，是"这件事该谁去做"：

> | kind | 谁的错 | 该怎么办 |
> |---|---|---|
> | `missing_service_kind` | 调用方 | 补上 `service_kind` |
> | `bad_service_kind` | 客户端版本 / 参数 | 升级客户端，或改掉打错的名字 |
> | `service_kind_disabled` | 站点（管理员的开关） | 找管理员打开那个插件的配置 |
> | `service_kind_no_job` | 站点（部署不完整） | 找管理员重新部署 |

> 后两条都是"找管理员"，但管理员要做的事完全不同：后者去翻配置开关是白费功夫，
> 缺的是 `jobs/<ULID>.sbatch`。合并了，用户就只能一个个试。

> 客户端不填默认资源。省略一个字段是在说「用你的默认」，不是「我要 0 核」——
> 服务端必须自己填默认值并做上限钳制，否则一个改过的客户端省略字段就能要到整机。
> 而那个"默认"现在是按插件取的（见 `plugins` op），所以同一个客户端在两种
> 插件上会得到两组不同的默认值，这是对的。

注意「`--mem=0` 在 Slurm 里的含义是该节点的全部内存」这个坑：用户笔误会让一个开发
会话吃掉整台机器，所以校验是显式拒绝并回退（`cluster/slurmate-sessiond`）。

### `status`

请求：`{"op":"status"}` 或 `{"op":"status","session_id":"<sid>"}`

- 带 `session_id`：返回该会话，不属于调用者的会话一律报 `3 not_found`
  （不是「无权限」—— 不泄露别人的会话是否存在，`cluster/slurmate-sessiond`）。
- 不带：返回该 uid 最新的活跃会话（`reserved`/`submitted` + `ACL_STATES`），
  没有则 `{"session": null}`。

成功 data：`{"session": { ... }}` 或 `{"session": null}`。

会话视图字段（`session_view()`，`cluster/slurmate-sessiond`）：

| 字段 | 说明 |
|---|---|
| `session_id`、`job_id`、`state`、`partition`、`resources` | 基本身份。`resources` 是 `{cpus, mem, gres}` —— 见〈`gres`：一个结构化描述符〉 |
| `node`、`node_ip`、`service_port` | 作业落点 |
| `tunnel_target` | **`"<字面 IPv4>:<端口>"`**，或 `null`（还没登记） |
| `created_at`、`enrolled_at`、`last_hb_at`、`renew_count` | 时间线 |
| `keeper` | **谁在看这条会话**：一个 `client_id`，或者 `null`。取值**只有这两种** —— `null` 是「确实没人在看」（不是「不知道」，也不是空串），它与 `last_hb_at` 合起来才说得清状况。它同时是「接管」那个按钮的判据。见〈`heartbeat`〉与〈`takeover`〉 |
| `requested_time`、`account`、`auth_mode`、`note` | 状态 |
| `service_kind` | 这个会话提供哪种服务 —— **本站的短名**（插件配置的文件名）。三态：字符串 / `null`（服务端**明说**不知道，会话是从 nft 规则恢复出来的）/ 键不存在（更旧的守护进程）。**后两种客户端按同一件事处理：不猜**（见下）。 |
| `service_plugin` | **解析键**：`"<id>@<版本>"`。同样是三态，两个 NULL 含义不同（见下）。 |
| `job_state`、`time_limit`、`expires_at` | **可能整个键不存在**（`show_job` 失败时），调用方必须容忍 `undefined` |
| `job_terminal` | **布尔**：这个作业算不算**真终态**。见下 |
| `job_reason` | 排队原因（Slurm 的 `Reason` 原话，如 `Resources` / `JobHeldUser`）。**`Reason=None` 被服务端滤掉**，所以它只在真有原因时出现 |
| `job_exit_code` | Slurm 的 `ExitCode` 原话（`"143:0"` / `"0:0"`）。**只在 `job_terminal` 为真时出现** —— 批量查询拿不到这个字段，而推送与 `list` 必须逐字同构；未结束时它本来也只是占位值 |
| `job_restarts` | Slurm 的 `Restarts` 原话（字符串形式的整数）。**只在 `job_terminal` 为真时出现**。重启过就要说出来：作业被重新排队之后跑着的东西是新的 |
| `enroll_problem` | 作业已经在运行、而登记没有在进行的那个原因（`load_session_file()` 给的那个串，如 `component_group_or_world_writable`）。**只在确实停在那里超过一分钟时出现**；缺席 = 没有这个问题。界面据此说「站点还没有完成登记」并带上原因 |
| `auth_password` | 只在会话处于 `ACL_STATES` 时返回 |

> `job_terminal` 是判定，不是状态名：客户端不许自己判。

> "这个作业算不算结束了"取决于 Slurm 的状态以及 `Requeue`：`PREEMPTED` 与 `TIMEOUT`
> 只在这两种附加条件下才终态。客户端手上没有 `Requeue`，所以把判定发过去，
> 而不是把原始字段发过去。

> 自己再实现一遍的代价是两处判据会漂，而漂的方向是界面说"已结束（被抢占）"、
> 作业几分钟后又回来了。用户已经被告知结束了。

> `job_state` 仍然照发，界面对不上时要说得出原文，但它不是判定依据。判据只有一份，
> 在守护进程的 `job_is_terminal()` 里，两处调用（`phase_running()` 与
> `session_view()`）用的是同一个函数。

> 这个键缺席 = 老守护进程。对这种应答，客户端印状态原文，不猜，猜一个的代价是
> 说错话。见 `client/src/main/jobstate.js`。

> `service_plugin` 必须是提交那一刻的值，读的时候不许现算。

> `plugins` op 报的是站点当前的清单，而一个跑着的作业用的是它提交时那一份代码。
> 作业侧与客户端侧是配套的两半。

> 站点一升级插件，按"当前清单"解析一个已经跑着的会话，就会把新版本的客户端代码接到
> 旧版本的作业实现上。而站点更新频繁正是这个协议要支持的现实。

> `null` 有确定的含义：服务端明说不知道这个会话用的是哪一版 —— 库丢失之后从
> 老规则重建出来的那些（规则里没有插件那一段），或者命令行里的那一份读不出来。
> 客户端据此拒绝猜测：只解释、不动作，但隧道照样接起来、会话照样停得掉。
> 新写入的规则带着 `-<id>@<版本>`，那样恢复出来的行是有值的。

> "这个键不存在"落到的也是同一个答案：拒绝猜测。往回兜到清单里某个插件上，本身
> 就违反这个协议的三态纪律：缺席不等于可以猜。`null` 与"键不存在"在客户端是
> 同一件事。

两个必须遵守的客户端规则：

1. `tunnel_target` 必须原样使用，不要重新解析节点名。守护进程写进 nft 的是
   `ip daddr <字面IP>`；客户端解析出的地址与它不一致时 ACL 会静默失效
   （`client/src/main/tunnel.js`，`cluster/slurmate-sessiond`）。
2. `auth_password` 缺失时不能用 `undefined` 覆盖已有值 —— 否则一次 NFS 抖动之后
   自动重登就会因为没口令而失败（`client/src/main/session.js`）。

### `job_log`

请求：`{"op":"job_log","session_id":"<sid>","lines":200}`

返回一个会话的作业日志尾部，两份：

```json
{"out": {"path": "/shared/home/alice/.slurmate/logs/slurm-5814.out",
         "bytes": 48312, "lines": 200, "truncated": true,
         "mtime": 1790301794, "text": "...", "why": null},
 "err": null}
```

| 字段 | 说明 |
|---|---|
| `path` | 服务端算出来的**绝对路径**。界面把它显示出来供复制 |
| `bytes` | 文件的总字节数（`null` = 这一份读不了） |
| `lines` | `text` 里的行数 |
| `truncated` | `true` = 给出的这一段**不是整份文件**（要么从中间切进来的，要么行数截过） |
| `mtime` | 最后修改时刻（Unix 秒） |
| `text` | 尾部若干行的正文。文件是空的时候是空串 |
| `why` | 读不了时的原因；读到了就是 `null` |

每一格只有三种形态，与 §四 同源：

| 形态 | 意思 |
|---|---|
| `null` | **确实没有这一份**（文件不在） |
| `{...  "why": "…"}` | **获取失败** —— 文件在，但过不了安全检查，或者打不开 |
| `{...  "why": null}` | 读到了。（文件是空的时候 `text` 是**空串**，不是 `null` —— 那是"它确实还没有说任何话"，与"没有这一份"是两句话） |

`why` 的取值是机械的，逐个对应一条检查：`component_not_dir` /
`component_bad_owner` / `component_group_or_world_writable` / `not_regular` /
`uid_mismatch` / `hardlinked` / `open_failed:<errno>`。

目录链从 `.slurmate` 开始，不含家目录：家目录归用户处置，站点缺省可能是
`0775`；本系统保证的只有 `.slurmate` 及其子目录（属主本人或 root、
`mode & 0o022 == 0`）。会话文件那一条链同理。

归属：照 [`status`](#status) —— 不属于调用者的会话与不存在的会话回同一个
`3 not_found`。不给 `session_id` 也是这一个答案：日志是逐会话的东西，没有"默认最新
那条"这种缺省。

路径不能由请求决定。三源都在服务端：家目录（NSS）、`.slurmate/logs`（常量）、
会话行里的 `job_id`（按 `%d` 格式化的整数）。请求里只有一个 `session_id`。

只读尾部，从不读整份。一份日志可以很大（作业侧按保留期与目录上限清理，见
`log_keep_days` / `log_dir_max_bytes`，而正在跑的那一条不会被清）。服务端
`lseek` 到 `size - 128 KiB` 再读那么多，代价与文件大小无关。

从文件中间切进来时，第一行是半截的，会被丢掉：印半行会让人以为那一行本来就长那样。

- `lines` 钳到 `[1, 2000]`，缺省 `200`。非整数取缺省而不是报错：这是只读展示，
  一个手抖的参数不该让人看不到日志。
- 每一份最多 `128 KiB`，两份合计远低于 §二 的响应上限。
- 这两份文件由作业写（`sbatch -o/-e`），守护进程只读。写入方是用户的作业，
  所以这里的检查是"这条路径上没有别人插得进手"，而不是"这个文件是可信输入"。

> 这里没有"跟着日志走"的游标。客户端每次请求都是"现在这一刻的尾部 N 行" ——
> 它不需要知道上次读到哪儿，也不需要服务端记任何状态。追加式文本视图靠重叠比对
> 把两次的尾巴接起来（`client/src/renderer/hover.js`），接不上就整块重画。

### `list`

请求：`{"op":"list"}`

成功 data：`{"sessions": [...]}`，最近 50 条，`with_secret=False`：不返回
`auth_password`（`cluster/slurmate-sessiond`）。

### `heartbeat`

请求：`{"op":"heartbeat","session_id":"<sid>"}`

成功 data：`{"state": "<新状态>", "at": <ts>}`；不是看护者的连接会多一格
`"ignored": "not_keeper"`。

这是判活的唯一依据。守护进程只看这个 RPC 写入的 `last_hb_socket`，
完全不读作业写的 `.jobhb` 文件（`client/README.md`）。

但「谁的心跳算数」要看这条会话的看护者（`keeper`）。判据只有一份，在
`op_heartbeat` 里；它按发心跳的那条连接分档：

| 这条连接报了身份吗 | 会话的 `keeper` | 结果 |
|---|---|---|
| 报了 | 是它自己，或者空 | 接受，**`keeper` 不写** |
| 报了 | 是别人 | 回 `ok` + `ignored`，**一个字段都不动**（`state` 也不改） |
| **没报** | 任意 | **一律接受** |

心跳从不认领。 `keeper` 只有两个写入口：`submit`（提交的那条连接是第一任
看护者）与 `takeover`（用户点「接管」）。这一条是 2026-10-20 定的：接管必须是
用户的动作，不能是"连上站点、顺手发了一拍心跳"的副作用。

代价说清：看护者为空时，界面会一直说「没人接管」，哪怕有客户端正在替它续命。
要当家就得点一次「接管」。

身份取自连接，不取自请求体：一条连接只在常驻通道上认一次身份
（`register_client`），而 `slurmate rpc` 那条一次性的 exec 路永远不带它
（`client/src/main/backend-ssh.js`）。

"没报身份就一律接受"是承重的，别把它收严。客户端在常驻通道断掉之后会退化成一堆
一次性的 exec，而那条路上身份是被删掉的。

收严它的后果是具体的：用户正看着的作业在 1800 秒后被 `scancel`，而界面上一切正常，
心跳确实发出去了、回的也是 `ok`。

这与 `list` 那条「不认识身份的连接永不被顶」是同一条规则：没有身份 = 不被排除。

`ignored` 不是错误：心跳不是一条会让客户端重试的请求，回错会让它退避、
把「不是看护者」演成「网络不好」。它是客户端认出「这条作业被另一台电脑接管了」的
唯一信号。

- 会话在 `suspect` 时收到被接受的心跳 → 状态回到 `enrolled`，审计记
  `suspect_recovered`。作业与 ACL 全程没被动过（`cluster/slurmate-sessiond`）。
  被 `ignored` 的心跳没有这个效果：那台电脑并没有在看它。
- 错误：`3 not_found`。

停发心跳的后果：300 秒后 `suspect`，1800 秒后 `orphaned` + `scancel`。而界面在此期间
一切正常，这正是最危险的地方（`client/src/main/session.js`）。

客户端的应对是三条。

- 心跳由单一 Map 持有，与窗口是否可见无关。
- 发 `goodbye` 前先停。
- 用 `status` 回来的 `last_hb_at` 交叉校验「心跳到底有没有落地」，落后 90 秒即告警
  （`client/src/main/session.js`）。

### `takeover`

请求：`{"op":"takeover","session_id":"<sid>"}`

成功 data：`{"session_id": "<sid>", "keeper": "<我的 client_id>", "was": "<原来那个>" | null}`

这条 op 只改一格：`keeper`。作业、ACL、nft 规则、会话文件、端口、
`last_hb_socket`、`state`，一个都不动。

理由就是这条功能的意义：用户只是换了一台电脑看同一个作业（「布局之类的不同无所谓，
但后台作业是同一个是根本原则」）。动了别的任何一个字，它的语义就变成"结束并重开"，
而那是另一个按钮。

因此它也不刷新心跳：新看护者要等它自己的下一次心跳才生效。客户端在接管成功
之后应当立刻打一次，而不是等那个 45 秒的定时器（`client/src/main/session.js`）。

- 没报身份的连接报 `2 no_client_id`：要把看护者写成谁？没有名字就没人可写。

  这与〈`heartbeat`〉那条「没报身份就一律接受」不矛盾。心跳是「我在续命」，少一个
  身份仍然该宽进，排除错了会杀作业。接管是「我来当家」，它要往那一格里写一个名字。
- 已经结束的会话（`released` / `rejected` / `expired`）报 `4 session_gone` ——
  幂等地「成功」会让用户以为接管了，而该看到的提示是「这条作业已经结束」。
- 自己接管自己（界面上点两下）不是错，什么都不改。
- 错误：`3 not_found`（不存在，或者不属于这个用户）。

旧看护者怎么知道？三条路，一条比一条慢。

- 接管成功的那一刻，守护进程立刻给它推一份全量快照。站点记着每条连接的
  `client_id`（`Conn`），所以"旧看护者在不在线"答得出来；不在线就跳过，它回来时
  `keeper` 已是别人，不会被接回。
- 它下一次心跳会被回 `ignored`。
- 全量快照里的 `keeper` 变了，于是下一个 tick 就有一条推送。

三条用的是同一份数据：全量快照里的一格。刻意没有一条专门的 `taken_over` 推送
——「丢掉任何一条推送都无害」这一版是承重的，而"谁在看"本来就是快照里的一格
（`cluster/slurmate-sessiond` 的 `snapshot_for` 与 `_push_taken_over`）。

客户端收到推送、发现 `keeper` 变了，只做一件事：立刻补打一次心跳，不等 45 秒。
它不拿推送里的 `keeper` 直接下结论 —— 接管成功后仍可能收到一份旧推送，
直接信它会把刚接管的会话又判成被接管。结论只有心跳回包能给。

### `goodbye`

请求：`{"op":"goodbye","session_id":"<sid>"}`

成功 data：`{"state": "releasing"}`，或已是终态时原样返回该终态
（幂等，重复调用不报错，`cluster/slurmate-sessiond`）。

`ok:true` 的意思是"这条请求被受理了" —— `scancel` 已经发出去、会话进了
`releasing`。它不等于"作业已经停了"，也不等于"这次 `scancel` 成功了"。

`scancel` 没有成功时，响应里带 `data.warning`（见〈`data.warning`〉第二族）。
它说的是守护进程接下来会怎么做，而不是一个诊断：作业也可能刚刚正常结束，
`scancel` 报的只是「没有这个作业」—— 所以那句话不猜原因。

错误：`3 not_found`。

#### `releasing` 是一个可能持续很久的状态

`released` 的含义是作业确认消失了，不是"我们不管它了"。守护进程在
`releasing` 上有一道闸：只有两种答案能让它继续拆 ——

| `scontrol` 的答案 | 判 | 后果 |
|---|---|---|
| 查不到（控制器可达） | 确认不存在 | 拆：删 ACL / 删会话文件 → 终态 |
| 查到了，且状态是**真终态** | 确认停了 | 同上 |
| 查到了，状态非终态（含 `CANCELLING`） | **还在** | **不拆**，重发 `scancel`（有节流），留在 `releasing` |
| 联系不上控制器 | **问不到** | **不拆**，也不重发（重发只会以同样的方式失败） |

落哪个终态不都是 `released`：`rejected`（会话文件校验失败）与
`expired`（登记超时 / 排队超时）也走这一道闸，过闸之后落回各自的终态名字。
所以客户端看到 `rejected` / `expired` 时，作业已经确认消失了。这两条路
**必须**走同一道闸 —— 自己 `scancel` 一次就跳终态、把返回值丢掉，正是账本 F32
记的那个形状。

一个杀不掉的作业会让会话一直停在 `releasing`，而它的 ACL、口令文件、会话文件一样都
不删，用户仍然连得进去，看得见它还在烧。

`note` 里记的是为什么走到这里（`goodbye` / `orphaned` / `job_gone` / `job_<状态>` /
`job_id_mismatch` / `enroll_timeout:…` / `queued_timeout:…`），不是"为什么可以拆"。

客户端不许把 `releasing` 当成一个几乎立刻过去的中间态。

### `doctor`

请求：`{"op":"doctor"}`

成功 data：

```json
{"socket": true, "table": true, "rules_readable": true,
 "rules_count": 3, "active_sessions": 3, "pending_sessions": 1,
 "consistent": true,
 "port_range": [55001, 55999],
 "version": "0.36", "last_tick_at": 1790301794,
 "tick_age_seconds": 2, "last_tick_error": null,
 "auth_mode_none": 0,
 "checked": 14, "problems": [],
 "existing": {"codeserver_table": true, "portdaemon_table": true}}
```

`problems` 是体检的结论。空数组 = 检查过、没有发现；每一项是
`{"key": "...", "detail": "..."}`。`key` 是稳定的机器判据，`detail` 是给人看的一句。

`checked` 是这一轮实际检查了几项。没有它，"没有告警"与"检查根本没跑"
在界面上分不开。

`problems` 里可能出现的 `key`：

| key | 它说的事 |
|---|---|
| `socket_missing` | 控制通道的 socket 不存在 |
| `table_missing` | `inet slurmate` 表不存在 |
| `rules_unreadable` | 规则集读不出来 |
| `claim_incomplete` | 一条活跃会话缺作业号、节点地址或端口，拼不出规则 |
| `rule_missing` | 有会话该有的规则不在 |
| `rule_orphan` | 有规则对不上任何活跃会话 |
| `rule_unparsable` | 一条 `slurmate-sess-` 开头的规则拆不出字段 |
| `auth_mode_unknown` | 活跃会话的 `auth_mode` 既不是 `password` 也不是 `none` |
| `tick_never` | 对账一次都没有跑过 |
| `tick_error` | 最近一次对账出错 |
| `base_table_missing` | 现有系统的 `inet codeserver` 或 `ip port-daemon` 表不见了 |

`consistent` = 规则集合 == 活跃 claim 集合，两个方向都比。数量相等而集合不等
同样是问题（见 `rule_missing` / `rule_orphan`）。`existing` 是非侵入式体检：
只读地看一眼既有系统还在不在，本系统绝不碰它们。

`auth_mode_none` 是活跃会话里关闭了口令的条数。`none` 是站点显式配的宽松模式，
不算问题，但体检要说出来。

`active_sessions` 只数装上了 ACL 的那几种状态。`pending_sessions` 是
「已提交、还没有登记上」那一段（`reserved` / `submitted`）：一条卡在那里的会话
会让 `active_sessions` 是 0 而体检看起来一切正常，两格分开报。

`version` 是守护进程自己的版本。

`last_tick_at` 是最近一次对账完成的时间，`tick_age_seconds` 是它到现在的秒数。
从没对过账时两者都是 `null`。

`last_tick_error` 是最近一次对账抛出的异常（`<类型>: <信息>`），没抛过为 `null`。
它不是 `null` 时，对账与它之后的阶段都不再推进。

老版本的守护进程不报 `problems` / `checked` / `auth_mode_none`，也不报
`last_tick_*` 那四格。客户端在 `problems` 缺席时说的是"守护进程太旧"，
不是"检查通过" —— 后者会把"没有这一项检查"读成"检查过了、没问题"。
### `cluster`

请求：`{"op":"cluster"}`

返回集群这一侧的现状，分两块：共享的那几格（对所有 uid 逐字相同）与
`me`（按 uid 的那一份）。

```json
{"at": 1790301794, "now": 1790301794,
 "health": {"up": true, "at": 1790301794},
 "version": "slurm-wlm 23.11.4",
 "partitions": {"A6000": {"max_time": "183-00:00:00", "is_default": false,
                          "state": "UP", "nodes": 2, "cpus": 160}},
 "nodes":    {"A6000": {"counts": {"mixed": 2}, "flags": {},
                        "cpus": {"allocated": 60, "idle": 68,
                                 "other": 0, "total": 128},
                        "mem_free": {"sum": 80000, "max": 50000}}},
 "mem":      {"A6000": 128000},
 "queue":    {"depth": {"A6000": {"pending": 48, "running": 4}},
              "pending": {"A6000": ["7001", "…"]},
              "by_user": {"alice": ["7001", "…"]}, "at": 1790301780},
 "gres":     {"A6000": [{"name": "gpu", "type": "a100",
                         "per_node_max": 2, "total": 4,
                         "used": 1, "free": 3}]},
 "taken":    {"health": 1790301794, "partitions": 1790301500},
 "me": {"account": "chbstudents", "account_error": null,
        "allowed_partitions": null,
        "fairshare": {"account": "chbstudents", "fair_share": "0.125000",
                      "raw_usage": "3072302", "effectv_usage": "0.108641"},
        "pending_count": 3, "first_in": {"A6000": 1}}}
```

三态是这一节的规矩，逐格适用（与 §四 同源）：

| 形态 | 意思 |
|---|---|
| **键不存在** | **获取失败** —— 没问到，或者这一层还没刷出来 |
| `null` / `[]` / `{}` | **确实没有** |

客户端画这一态时，必须与「确实没有」分得开，而且必须说成获取失败。把它画成
"这台集群没有分区"，用户会去查一个不存在的问题，而真正的原因在守护进程那一侧。

`partitions` / `gres` / `nodes` / `queue` 获取失败时本 op 不报错（对比
`partitions` 那个 op —— 它的失败要挡住整张表单）。这一屏是只读的现状展示，
一格获取失败不该让另外五格也看不见。

`nodes.<分区>.cpus` 是 `sinfo -N -O` 的 `CPUsState` 按分区累加：`idle` 是这个
分区此刻还剩多少核。`total` 含 DOWN 的节点（它们占着名单但没有空闲核）。这一格
缺席表示没问到，不能写成四个 0 —— 0 的意思是"确实一核都不剩"。

`nodes.<分区>.mem_free` 是 `Memory - AllocMem` 按分区累加：`sum` 是各节点可
分配内存的合计，`max` 是其中最多的一台（一条作业只落在一台节点上，所以后者才是
"这条作业此刻最多能要到多少"）。

这是调度器眼里的可分配量，与 `FreeMem`（节点上物理空闲，含缓存与未计入分配的
部分）不是同一个数；两种口径在本机实测可以差两个数量级。键缺席 = 没问到
（旧版 Slurm 不认 `-O`，或查询失败），不写成 0。

`mem.<分区>` 是这个分区里内存最大那种节点的 MB 数。它是容量，与上面那格
余量分开：`mem` 回答"这台节点有多大"，`mem_free` 回答"此刻还剩多少"。

`gres.<分区>[].used` / `.free` 是 GRES 的已用与可用，来源是 `sinfo -N -O` 的
`GresUsed`：Slurm 按节点算好的已用量，按分区汇总，`free` 是 `total - used`
并钳到不小于 0。中钟（30 秒）刷新，所以它是"上一次对账时"的数，不是毫秒级的
实时值。

三态与边界：同一分区里同名的卡有不止一种型号、而已用量没写型号时，这一项
不给 `used` / `free`（判不了归属，不猜）。节点跨分区时照常给：`sinfo -N` 对
每个分区各出一行，每行都带着这台节点的真实已用量，不会把别人占的卡算成空闲。
键缺席 = 取不到；`used: 0` = 确实没人占。

`taken` 是每一格"取到它的时刻"（Unix 秒）。慢钟上的一格可以是 5 分钟前的，
而"这一份有多旧"是用户要看的 —— 所以它必须送出去，不能由客户端拿收到的时刻顶替。

`now` 是服务端此刻的时间；客户端算年龄时用它当基准（`now - taken`），不用本机
时钟 —— 两端有时钟差时，后者会把刚取到的数算成负数，钳完就成了一句"0 秒前"。

`me.allowed_partitions` 的三态与 `whoami` 一致：`null` = 不限制（这是答案），
列表 = 允许的那些。

`me.first_in` 是"我最靠前的那条排队作业，在它那个分区里排第几"（从 1 数起）。
它不是"还要等多久" —— 前面多少作业会同时开跑取决于分区此刻有多少空闲节点。
它由共享的 `queue.pending` 与 `queue.by_user` 现推，不额外查询。

一次请求一次 fork 都不发（除了进程第一次问、或某一层刚到期）：所有东西都来自
tick 刷新的那份缓存。`users` 是"现在连着的用户"，tick 按用户逐个预热。
判据见 `docs/ARCHITECTURE.md`〈三层钟〉。

### `history`

请求：`{"op":"history"}`

成功 data：

```json
{"history": [{"job_id": "5854", "name": "sj-ide", "state": "RUNNING",
              "exit_code": "0:0", "elapsed": "10:13:12",
              "end": "Unknown", "partition": "A6000"}],
 "days": 7, "limit": 30}
```

按需拉：它不进任何一层钟。`sacct` 是这一组里最贵的一条查询（账本库要按时间窗
扫描），而它回答的"过去发生了什么"不会自己变新 —— 没有调用者就没有这个 fork。

只要作业级记录：`.extern` / `.0` / `.batch` 那些是作业步，混进来会让
"最近 30 条"变成"最近 10 个作业的每一步"。判据是 JobID 里没有 `.`。

倒序：最新的在最前。`sacct` 默认按作业号升序，而人要看的是最后发生的那件事。

用户从 uid 推出来，绝不接受请求里给的用户名 —— 否则这个 op 就是读别人账本的
入口（与 `list` 同源）。

获取失败时是 `code 6` / `history_unknown`，不是空列表。空列表的意思是
"你这几天没有作业"，一句守护进程并不知道的话。

---

## 七、一次完整交互的样子

```
客户端                                  slurmate rpc                     slurmate-sessiond
   │                                        │                                   │
   │── {"op":"whoami"} ───────────────────► │── SO_PEERCRED(uid=1001) ────────► │
   │◄─ {"ok":true,"code":0,"data":{…}} ──── │◄──────────────────────────────────│
   │                                        │                                   │
   │── {"op":"partitions"} ────────────────► │                                   │
   │◄─ {"ok":true,…,{"partitions":[…]}} ─── │                                   │
   │                                        │                                   │
   │── {"op":"plugins"} ───────────────────► │   ← 站点开了哪些插件、各自默认    │
   │◄─ {"ok":true,…,"plugins":[…]} ──────── │     多少资源（界面据此画按钮）    │
   │                                        │                                   │
   │── {"op":"submit","service_kind":"…"} ► │── 随机挑一个有权限的分区 ────────► │
   │                                        │── sbatch(setuid) ────────────────► │
   │◄─ {"ok":true,…,{"job_id":12345,…}} ─── │◄──────────────────────────────────│
   │                                        │                                   │
   │   （每 3 秒）                          │                                   │
   │── {"op":"status","session_id":"…"} ───► │                                   │
   │◄─ {… "state":"submitted",             │   ← 守护进程每 tick 读会话文件     │
   │      "tunnel_target":null} ─────────── │                                   │
   │        …                               │                                   │
   │◄─ {… "state":"enrolled",              │   ← 会话文件校验通过，ACL 已装     │
   │      "tunnel_target":"192.0.2.11:55017",
   │      "auth_password":"…"} ──────────── │                                   │
   │                                        │                                   │
   │  建立 ssh -L 隧道，自动登录服务页面     │                                   │
   │                                        │                                   │
   │   （每 45 秒）                         │                                   │
   │── {"op":"heartbeat","session_id":"…"} ►│── 更新 last_hb_socket ───────────► │
   │◄─ {"ok":true,…,{"state":"enrolled"}} ─ │                                   │
   │                                        │                                   │
   │   （用户点「结束会话并释放资源」）       │                                   │
   │── {"op":"goodbye","session_id":"…"} ──►│── scancel ───────────────────────► │
   │◄─ {"ok":true,…,{"state":"releasing"}}─ │── 状态转 releasing ──────────────► │
   │                                        │                                   │
   │   （每 30 秒）                         │                                   │
   │── {"op":"status","session_id":"…"} ───► │                                   │
   │◄─ {… "state":"releasing"} ──────────── │   ← 作业还没确认停掉，不拆、       │
   │                                        │     继续 scancel，直到它真的消失   │
   │◄─ {… "state":"released"} ───────────── │   ← 确认停了才删规则/文件          │
```

那条 `releasing → released` 之间可能夹着任意多条 `releasing`：`released`
的意思是作业确认消失了，不是"我们不管了"。所以界面（和脚本）不许把
`releasing` 当成一个几乎立刻过去的中间态。
