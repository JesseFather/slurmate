# RPC 协议

客户端与守护进程之间的契约。**契约来源**：`cluster/slurmate`（CLI 侧的信封构造与退出码）
与 `cluster/slurmate-sessiond:1607-1614`（`_ok`/`_err` 构造点）、
`cluster/slurmate-sessiond:1634-1661`（`dispatch`），
客户端的消费逻辑在 `client/src/main/classify.js`。

---

## 一、传输

两条链路，同一份信封：

```
客户端 ──ssh -T──► 登录节点上的 slurmate rpc ──AF_UNIX──► slurmate-sessiond
                    （stdin 读一行，stdout 写一行）  （unix socket，一行 JSON）
```

对客户端而言**只有 `slurmate rpc` 这一个稳定入口**（`cluster/slurmate:10-17`）：

```
ssh -T -o BatchMode=yes -p 10100 alice@node01.example.com -- /usr/local/bin/slurmate rpc
```

- 请求体走 **stdin**，响应走 **stdout**，各一行 JSON。**一次一请求**，请求完即退出。
- argv 是编译期常量，用户输入永远不出现在命令串里。这既是防注入，也是穿过
  登录节点上 `ForceCommand` 守卫的必要条件（命令串里不能出现 `code-server` 字面量）。
- 中文 detail 以字面 UTF-8 输出（`ensure_ascii=False`，`cluster/slurmate:233`）；
  解析失败时报「守护进程返回的响应不是合法 JSON」（`cluster/slurmate:101`）。
- 上限：CLI 侧最多读 1 MiB 或读到第一个换行（`cluster/slurmate:79`）；
  守护进程侧最多读 64 KiB 或读到第一个换行（`cluster/slurmate-sessiond:1581-1587`）。

人类可读的子命令（`submit` / `status` / `wait` / …）**不保证输出 JSON**，
只在加 `--json` 时才打印信封。客户端应始终走 `slurmate rpc`。

### 超时预算

| 环节 | 值 | 位置 |
|---|---|---|
| 守护进程读一个请求 | 5 秒 | `cluster/slurmate-sessiond:1578` |
| CLI 等守护进程应答 | 40 秒（默认） | `cluster/slurmate:60` |
| CLI `heartbeat` / `goodbye` | 20 秒 | `cluster/slurmate:385` |
| 客户端等 `submit` | **45 秒**，必须比 CLI 内部的 40 秒长 | `client/src/main/session.js:50` |
| 客户端等 `goodbye` | 10 秒 | `client/src/main/session.js:414` |
| 客户端认领用的 `status` | 20 秒 | `client/src/main/session.js:199` |

`submit` 的超时必须**大于** CLI 内部的 socket 超时，否则会在守护进程还在跑 `sbatch`
的时候放弃 —— 然后按大多数重试逻辑去重试，于是两个作业（`client/src/main/session.js:48-50`）。

---

## 二、信封

### 请求

```json
{"op": "submit", "purpose": "code", "cpus": 2, "gpus": 0, "time": "12:00:00"}
```

### 响应

```json
{"ok": true,  "code": 0, "data": { ... }, "error": null}

{"ok": false, "code": 4, "data": null,
 "error": {"kind": "quota_active", "detail": "已有 1 个活跃会话（上限 1）"}}
```

构造点：`_ok()` 与 `_err()`（`cluster/slurmate-sessiond:1607-1614`）。

- `ok: true` 时 `code` 恒为 `0`，`error` 恒为 `null`；
- `ok: false` 时 `data` 恒为 `null`；
- **`error.detail` 是守护进程写的中文，可直接展示给用户**（`client/src/main/classify.js:70`）；
- `error.kind` 是机器可读的短标识，**必须靠它做分支，不要靠 `code`**（理由见第四节）。

## 三、错误码

| code | 含义 | 典型 `kind` | CLI 退出码 |
|---|---|---|---|
| `0` | 成功 | — | `0` |
| `2` | 用法错误 / 客户端 bug / 请求不合法 | `bad_request`、`bad_json`、`empty_request`、`unknown_op`、`bad_purpose`、`bad_time` | `2` |
| `3` | 未找到（会话不存在，或 uid 查不到） | `not_found`、`unknown_uid` | `3` |
| `4` | 被拒绝：配额、权限、账户、熔断 | `quota_active`、`quota_pending`、`no_account`、`no_partition`、`throttled` | `4` |
| `5` | **守护进程不可达**（`daemon_unreachable`）**或**端口池空（`no_port`） | `daemon_unreachable`、`no_port` | `5` |
| `6` | Slurm 侧失败 | `partitions_unknown`、`submit_failed` | `6` |
| `7` | 触发限流 | `rate_limited` | `7` |
| `9` | 守护进程内部异常 | `internal` | `1`（不在映射表内，落到默认值） |

退出码映射见 `SLURMATE` 的 `_code_to_exit()`（`cluster/slurmate:137-151`）；
`9` 不在其中，所以返回 `1`。CLI 自己的退出码约定写在 `cluster/slurmate:19-22`。

**`code 5` 有两种含义，这是本协议最容易写错的地方。** 见下一节。

---

## 四、三态区分（本协议的核心）

客户端必须区分三种「没成功」的情形，处理方式**完全相反**：

### 1. 传输层失败 —— 没拿到应答

触发条件（`client/src/main/classify.js:49-60`）：

- 后端抛了传输错误（`transportError`）：SSH 断了、channel 关闭但没有 exit 事件、超时；
- 响应为空或不是对象；
- 响应不是合法 JSON。

**处理：重试。而且绝不能因此判定会话结束 —— 心跳照发。**
客户端**刻意不区分**「SSH 断了」和「守护进程没回话」：两者在客户端看来是同一种东西
（请求没得到应答），处理方式也一样（`client/src/main/classify.js:50-52`）。

### 2. 守护进程不可达 —— `code 5` 且 `kind == "daemon_unreachable"`

这是**守护进程侧明确地通过一份合法 JSON 告诉你它不可达**。具体来源是 CLI：
它连不上 unix socket 时，会自己合成这个信封
（`cluster/slurmate:69-75,86-89,97-101`，`rpc` 命令路径在 `:226-232`）。
也就是说，**守护进程本身从不产生 `daemon_unreachable`** —— 它连不上时根本没法回话。

**处理：退避重试，并保持心跳。** 客户端的提示文案是：

> 控制节点上的 Slurmate 守护进程没有响应。你的作业仍在运行。

（`client/src/main/classify.js:80-81`）

### 3. 守护进程明确拒绝 —— 其余 `ok:false`

**处理：停止重试，把 `error.detail` 原样展示给用户。**

### 为什么必须靠 `kind` 而不是 `code`

`code 5` 同时被用于「连不上守护进程」和「端口池耗尽」，而处理方式相反：
前者要退避重试并**保持心跳**，后者只是等一下（`client/src/main/classify.js:74-77`）。
这是 `classify.js` 这个文件存在的首要理由。

分错的代价是现实的：把 `daemon_unreachable` 当成「会话没了」去处理，就会停止心跳 ——
一个正在跑的作业在 `orphan_after_seconds`（默认 1800 秒）后被自动 `scancel`，
而用户以为自己只是断了个线。

同一条原则适用于 `code 4`：`kind == "throttled"` 是被熔断了，等一会儿会自动恢复，
**不是用户能解决的问题**，所以走退避重试而不是「请用户去处理」
（`client/src/main/classify.js:101-107`）。

---

## 五、重试策略

由 `classify()` 一次映射成「客户端可行动作」（`client/src/main/classify.js:18-29,45-132`）：

| 动作 | 触发 | 默认退避 | 自动重试 |
|---|---|---|---|
| `ok` | `ok:true` | — | — |
| `transport` | 传输层失败 | 由调用方定（客户端用 1s→2s→4s…上限 30s） | ✅ |
| `daemon_down` | `code 5` + `kind=daemon_unreachable` | 同上 | ✅ |
| `rate_limited` | `code 7` | 5000 ms | ✅ |
| `retry_soon` | `code 5` + `kind=no_port` | 5000 ms | ✅ |
| `retry_backoff` | `code 5` 的其他 kind；`code 4` + `throttled`（60000 ms）；`code 6`（非 `submit`）；`code 9` | 3000 ms | ✅ |
| `session_gone` | `code 3` | — | ❌ 终局 |
| `quota_or_permission` | `code 4`（非 `throttled`） | — | ❌ 要用户去解决 |
| `fatal` | `code 2`；`code 6` 且 `op == submit`；未知 code | — | ❌ |

两条附加规则：

- **未知 code 一律当作不可重试。**「宁可停下来让人看见，也不要盲目重试掩盖问题」
  （`client/src/main/classify.js:130-131`）。
- **`code 2` 绝不重试。** 重试只会重复同一个错误，白白消耗 RPC 配额
  （`max_rpc_per_second = 10`，`client/src/main/classify.js:94-98`）。

### 幂等性：只有 `submit` 不是幂等的

`classify()` 返回的 `idempotent` 字段是一个可断言的开关：
`op !== 'submit'`（`client/src/main/classify.js:142-143`）。`shouldRetry()` 会在
`idempotent` 为假时直接返回 `false`，**无论动作是什么**。

`submit` 必须这样处理的具体理由：`op_submit` 每次调用都生成新 `sid`、插新行、
提交新作业（`cluster/slurmate-sessiond:1803-1928`），而 `count_active()` 只数
`ACL_STATES`，`submitted` 不在内 —— `max_active_per_user` **拦不住并发的第二个提交**。

所以客户端的做法是（`client/src/main/session.js:156-173`）：

1. `submit` 超时（45 秒）后**绝不重试**；
2. 改调一次**不带 `session_id`** 的 `status` —— 它会返回该 uid 最新的活跃会话
   （`cluster/slurmate-sessiond:1742-1745`），用于认领「响应丢了但会话其实建好了」；
3. 认领成功就在界面上说明「提交响应超时，但已在控制节点上找到刚创建的会话，继续接管」；
4. 认领失败则明确告诉用户去 `squeue` 检查是否有多余作业。

---

## 六、操作

所有 op 都在 `dispatch()` 里分发（`cluster/slurmate-sessiond:1634-1661`）。
**限流先于一切**：任何 op 都要先过 `rpc_allowed()`（每 uid 每秒
`max_rpc_per_second` 次），超了直接 `_err(7, "rate_limited")`（:1636-1637）。
请求能解析成 JSON 对象但 `op` 不认识 → `_err(2, "unknown_op", op)`（:1658）。

### `ping`

请求：`{"op":"ping"}`

成功：`{"pong": true, "version": "0.1.0", "time": 1757...}`

最小连通性探针，用来在排查时区分「链路不通」和「业务逻辑出错」。

### `whoami`

请求：`{"op":"whoami"}`

成功 data：

```json
{"uid": 1001, "gid": 1001, "user": "alice", "home": "/shared/home/alice",
 "account": "acct", "account_error": null,
 "allowed_partitions": ["A6000"], "can_submit": true}
```

`allowed_partitions` 为 `null` 表示**已确认不限制**；`account_error` 非空时
`can_submit` 为假，且那句话可以直接展示给用户。

错误：`3 unknown_uid`（`cluster/slurmate-sessiond:1664-1676`）。

### `purposes`

请求：`{"op":"purposes"}`

成功 data：`{"purposes": [{"key","label","partition","gres","cpus","mem","allowed"}...]}`

`allowed` 为假时附 `reason`。分区权限查询失败时**所有**条目都带上
「暂时无法确认分区权限（查询失败）」，并且仍标 `allowed: true` —— 这是
fail-open 的展示层，真正的把关在 `op_submit` 的二次校验
（`cluster/slurmate-sessiond:1684-1697,1868-1875`）。

错误：`3 unknown_uid`。

### `submit`

请求：

| 字段 | 类型 | 默认 |
|---|---|---|
| `purpose` | 字符串 | `"code"` |
| `cpus` | 整数 | 用途配置里的 `cpus`（服务端钳制到 1–128） |
| `mem` | 字符串 | 用途配置里的 `mem`（必须匹配 `^[0-9]+[KMGTP]?$` 且非 0；否则回退到用途默认并打 warning） |
| `gpus` | 整数 | `0`（钳制到 0–16；`0` 时**完全省略** `--gres`） |
| `time` | Slurm 时间 | 配置的 `default_time`（超过 `max_time` 静默截断） |

成功 data：

```json
{"session_id": "9f2c…", "job_id": 12345, "state": "submitted",
 "partition": "2080TI", "candidates": [55001, 55002, ...],
 "requested_time": "12:00:00"}
```

错误：

| code | kind | 触发 |
|---|---|---|
| `2` | `bad_purpose` | 用途键不在配置里 |
| `2` | `bad_time` | 时间格式无法解析或 ≤ 0 |
| `3` | `unknown_uid` | `getpwuid` 失败 |
| `4` | `throttled` | 该 uid 在熔断静默期内 |
| `4` | `quota_active` | 活跃会话数已达 `max_active_per_user` |
| `4` | `quota_pending` | 未决提交数已达 `max_pending_per_user` |
| `4` | `no_account` | 该用户没有 Slurm association |
| `4` | `no_partition` | association 不允许这个分区 |
| `5` | `no_port` | 端口池暂时没有可用端口 |
| `6` | `partitions_unknown` | 分区权限**查不到**（安全路径上宁可拒绝） |
| `6` | `submit_failed` | `sbatch` 失败 |

注意「`--mem=0` 在 Slurm 里的含义是该节点的全部内存」这个坑：用户笔误会让一个开发
会话吃掉整台机器，所以校验是显式拒绝并回退（`cluster/slurmate-sessiond:1826-1834`）。

### `status`

请求：`{"op":"status"}` 或 `{"op":"status","session_id":"<sid>"}`

- 带 `session_id`：返回该会话，**不属于调用者的会话一律报 `3 not_found`**
  （不是「无权限」—— 不泄露别人的会话是否存在，`cluster/slurmate-sessiond:1738-1741`）。
- 不带：返回该 uid 最新的活跃会话（`reserved`/`submitted` + `ACL_STATES`），
  没有则 `{"session": null}`。

成功 data：`{"session": { ... }}` 或 `{"session": null}`。

会话视图字段（`session_view()`，`cluster/slurmate-sessiond:1700-1733`）：

| 字段 | 说明 |
|---|---|
| `session_id`、`job_id`、`state`、`purpose`、`partition` | 基本身份 |
| `node`、`node_ip`、`service_port` | 作业落点 |
| `tunnel_target` | **`"<字面 IPv4>:<端口>"`**，或 `null`（还没登记） |
| `created_at`、`enrolled_at`、`last_hb_at`、`renew_count` | 时间线 |
| `requested_time`、`account`、`auth_mode`、`note` | 状态 |
| `job_state`、`time_limit`、`expires_at` | **可能整个键不存在**（`show_job` 失败时），调用方必须容忍 `undefined` |
| `auth_password` | 只在会话处于 `ACL_STATES` 时返回 |

两个必须遵守的客户端规则：

1. **`tunnel_target` 必须原样使用，不要重新解析节点名。** 守护进程写进 nft 的是
   `ip daddr <字面IP>`；客户端解析出的地址与它不一致时 **ACL 会静默失效**
   （`client/src/main/tunnel.js:14-18`，`cluster/slurmate-sessiond:1711-1714`）。
2. **`auth_password` 缺失时不能用 `undefined` 覆盖已有值** —— 否则一次 NFS 抖动之后
   自动重登就会因为没口令而失败（`client/src/main/session.js:324-328`）。

### `list`

请求：`{"op":"list"}`

成功 data：`{"sessions": [...]}`，最近 50 条，**`with_secret=False`**：不返回
`auth_password`（`cluster/slurmate-sessiond:1747-1750`）。

### `heartbeat`

请求：`{"op":"heartbeat","session_id":"<sid>"}`

成功 data：`{"state": "<新状态>", "at": <ts>}`

**这是判活的唯一依据。** 守护进程只看这个 RPC 写入的 `last_hb_socket`，
**完全不读**作业写的 `.jobhb` 文件（`client/README.md:164-165`）。

- 会话在 `suspect` 时收到心跳 → 状态回到 `enrolled`，审计记 `suspect_recovered`。
  作业与 ACL 全程没被动过（`cluster/slurmate-sessiond:1783-1786`）。
- 错误：`3 not_found`。

停发心跳的后果：300 秒后 `suspect`，1800 秒后 `orphaned` + `scancel`。
而界面在此期间**一切正常** —— 这正是最危险的地方（`client/src/main/session.js:14-17`）。
客户端的应对是：心跳由**单一 Map** 持有、与窗口是否可见无关；发 `goodbye` 前先停；
并用 `status` 回来的 `last_hb_at` 交叉校验「心跳到底有没有落地」
（落后 90 秒即告警，`client/src/main/session.js:52,357-366`）。

### `goodbye`

请求：`{"op":"goodbye","session_id":"<sid>"}`

成功 data：`{"state": "releasing"}`，或已是终态时原样返回该终态
（幂等，重复调用不报错，`cluster/slurmate-sessiond:1795-1796`）。

错误：`3 not_found`。

⚠️ **`ok:true` 不代表作业被取消了。** `op_goodbye` 丢弃了 `scancel` 的返回值
（`cluster/slurmate-sessiond:1797-1798` 调 `Slurm.cancel()`，而
`:859-864` 的失败只写日志），`phase_release` 也不确认作业是否真的没了
（`:1329-1348`）。所以客户端把「正在释放」和「已结束」当成两个状态
（`client/src/main/session.js:24-25,424-431`）。详见
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。

### `doctor`

请求：`{"op":"doctor"}`

成功 data：

```json
{"socket": true, "table": true, "rules_readable": true,
 "rules_count": 3, "active_sessions": 3, "consistent": true,
 "port_range": [55001, 55999],
 "existing": {"codeserver_table": true, "portdaemon_table": true}}
```

`consistent` = 规则数 == 活跃会话数。它不等就说明对账在报错
（`cluster/slurmate-sessiond:1752-1773`）。`existing` 是**非侵入式体检**：
只读地看一眼既有系统还在不在，本系统绝不碰它们。

---

## 七、一次完整交互的样子

```
客户端                                  slurmate rpc                     slurmate-sessiond
   │                                        │                                   │
   │── {"op":"whoami"} ───────────────────► │── SO_PEERCRED(uid=1001) ────────► │
   │◄─ {"ok":true,"code":0,"data":{…}} ──── │◄──────────────────────────────────│
   │                                        │                                   │
   │── {"op":"purposes"} ──────────────────► │                                   │
   │◄─ {"ok":true,…,{"purposes":[…]}} ───── │                                   │
   │                                        │                                   │
   │── {"op":"submit","purpose":"code"} ───► │── 插 reserved 行 ────────────────► │
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
   │  建立 ssh -L 隧道，自动登录 code-server │                                   │
   │                                        │                                   │
   │   （每 45 秒）                         │                                   │
   │── {"op":"heartbeat","session_id":"…"} ►│── 更新 last_hb_socket ───────────► │
   │◄─ {"ok":true,…,{"state":"enrolled"}} ─ │                                   │
   │                                        │                                   │
   │   （用户点「结束会话并释放资源」）       │                                   │
   │── {"op":"goodbye","session_id":"…"} ──►│── scancel（返回值被丢弃）────────► │
   │◄─ {"ok":true,…,{"state":"releasing"}}─ │── 状态转 releasing ──────────────► │
   │                                        │                                   │
   │   （每 30 秒）                         │                                   │
   │── {"op":"status","session_id":"…"} ───► │                                   │
   │◄─ {… "state":"released"} ───────────── │   ← phase_release 删规则/文件      │
```

## 八、给实现者的清单

写一个新的后端（或换一门语言实现客户端）时，下面每一条都对应一个具体的静默失败：

1. **固定 argv，请求体走 stdin。** 不要拼接命令串。
2. **先用 `classify()` 分类，再决定动作。** 不要在后端里自己判断
   （`client/src/main/backend-ssh.js:31-35`）。
3. **`code 5` 靠 `kind` 分。** `daemon_unreachable` 要保持心跳。
4. **`submit` 超时不重试**，改用不带 `session_id` 的 `status` 认领。
5. **传输层失败绝不判定会话结束。**
6. **`tunnel_target` 里的地址必须是字面 IPv4**，不过 `net.isIPv4()` 就拒绝建隧道。
7. **`goodbye` 的 `ok:true` 只表示「已请求释放」。**
8. **`last_hb_at` 要与本地心跳时间交叉校验**，把「心跳没落地」这个纯静默的失败
   变成可见的告警。
