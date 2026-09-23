# RPC 协议

客户端与守护进程之间的契约。**契约来源**：`cluster/slurmate`（CLI 侧的信封构造与退出码）
与 `cluster/slurmate-sessiond`（`_ok`/`_err` 构造点、`dispatch`），
客户端的消费逻辑在 `client/src/main/classify.js`。

> ★ **完整的文档索引在 [docs/README.md](README.md)**。这一篇是**契约**；
> 「要写一个新后端」那张清单在 [IMPLEMENTING.md](IMPLEMENTING.md)（它从前是本文的
> 第八节，搬走了 —— 一份清单不是契约）。

---

## 〇、协议版本与变更

**当前版本：v0.7。** 协议版本、客户端版本、服务端版本是**同一个号** —— 它们不是
三件东西，是一件的三个落点。四处声明由 `.github/workflows/checks.yml` 断言必须
逐字相同：`client/package.json`、`client/package-lock.json`、`cluster/slurmate`、
`cluster/slurmate-sessiond`。

★ **这个号是 `major.minor`：两段。** `major` 无上限，`minor` ∈ `0..255`，
**禁止前导零**（写成 `1.007` 就是错的，它会让"同一个版本"有两个字符串）。
超上界时**必须进位**（`0.255` 之后是 `1.0`）。所以它是 `v0.7`，不是 `v0.7.0`。

> ★ **两段是有意的，而且这两段各有分工。**
>
> | 那一段 | 含义 | 容量 |
> |---|---|---|
> | `major`（`x`） | **可以不兼容**的那一档 | 无上限 |
> | `minor`（`y`） | **加东西但不破坏兼容**的那一档 | `0..255`，够用很久 |
>
> ★ 这是这个项目里两套版本号中的一套。另一套是**插件**的版本号（`x.y.z`，见
> [PLUGIN-SPEC.md](./PLUGIN-SPEC.md) §2.3），它比这个号多一段。两套的形状不同、
> 用途不同（两段 vs 三段本身就是一眼能分开的标记），**只有一条共同的纪律**：
> 逐段按十进制字符串比较、禁止转机器整数。写得下"补丁级"的只有插件那一套。
>
> 判据与结论写在 `tools/version-fixtures.json` 里，JS 与 Python 两边的用例读的是
> **同一份** —— 两侧规则必须逐条一致，而"只有一份"比"两份抄本 + 一条比对 lint"
> 结实。
>
> （这条与 [CHANGELOG](../CHANGELOG.md) 顶部"版本号遵循语义化版本"那句是**冲突**
> 的，那句已经改掉了：语义化版本要求三段，而这里只有两段。）

### 三方：谁不低于谁

发版时**客户端、服务端（守护进程 + `slurmate` 这个接口程序）、打包器同步更新，
用的是同一个号**。它们的**更新渠道不同**，而下面这套规则管的就是渠道之间会错开
这件事：

- **客户端由用户自己更新**（他装上什么版本就是什么版本）；
- **服务端由管理员手动更新**（`deploy.sh`）。★ 服务端版本低**不是故障**，它的后果
  只有一条：**不认识某些新插件** —— 那是插件自己的 `engines.slurmate` 说了算的，
  见下。

| | 规则 |
|---|---|
| **同 `x`** | **保证兼容**，前提是**客户端不低于服务端**。这是承诺本身：管理员可以在同一个大版本内自由升服务端，而不会打掉任何一个客户端 |
| **同 `x`，客户端更低** | 服务端要求客户端不低于它自己 ⇒ **要求用户升级客户端**（例如 2.5 的服务端不接受 2.4 的客户端，但接受 2.5、2.6） |
| **跨 `x`** | **不判为不兼容** ——「不一定，不是绝对不」。两个方向都**放行**，但都要**明确说明**。理由是用户可能连多个集群（一个 1.28、一个 2.5），2.x 的客户端不一定兼容 1.28 |
| **服务端 vs 插件** | 服务端不低于插件 `engines.slurmate` 要求的版本，否则**拒绝安装**那个插件并说明双方版本号；升不升服务端由管理员决定 |

★ **`x == 0` 是内测期，整条规则不受版本约束**（架构还在动，每次更新都可能有重大
变动），那时"客户端落后"只说明、不拦。**1.0 是"不承诺"与"承诺"的分界线**；到那
一天要**刻意**摘掉那条例外，而摘掉它会让一条用例红 —— 摘除是一次动作，不是手滑。

★★ **由此得到一条发布纪律：同一个大版本内不许出现破坏兼容的改动；出现了就必须
升大版本。** 上面那条承诺唯一的保证就是它，所以它写在
[CONTRIBUTING.md](../CONTRIBUTING.md) 里，也写在 [CHANGELOG](../CHANGELOG.md) 的顶部。

### 这条检查由**客户端**执行，而且它对老客户端无效

客户端连上之后问一次 `ping`，拿**双方的版本号**自己判，不通过就拒绝建立会话
（在**任何会话之前**，所以不会经由 `orphan_after` 把用户正在跑的作业 scancel 掉）。
★ **守护进程不做这条检查**，因为它做不到：请求信封里没有客户端版本，而老客户端
也不会带 —— 一条只有新客户端才生效的检查，本来就属于客户端。

⇒ **效力边界要写在明处**：这条规则**第一次执行只能从带它的那一版客户端开始**。
「老客户端 × 新服务端」那一格（也正是 v0.6 → v0.7 那次真正出事的一格）**只有部署
纪律能保**，代码拦不住，不要以为它拦得住。

★ 用 `ping` 而不是给别的 op 加字段，是因为 `ping` 与它返回的 `version`
**自初始提交起就在** —— 于是这条规则对**每一个曾经部署过的守护进程**立刻有效，
正好对上"客户端要能兼容老版本服务端"那条要求。

> ✅ **两端都已按 v0.7 实现**，四处版本号都是 0.7。此前这里挂着一条警告说集群侧
> 还停在 v0.1、两端连不上 —— 那条后来不成立了，所以删掉：留着一条已经不成立的警告，
> 与留一条已经失效的注释是同一类问题。
>
> ⚠️ **v0.2 → v0.5 之间不兼容，升级时两边要一起升。**
>
> ★ **v0.5 → v0.6 是例外，两个方向都能通 —— 那一次是设计出来的，不是碰巧。**
> v0.6 只**加**东西（`plugins` 里多两个字段与一个 `package`、顶层 `limits` 多一个
> `package_bytes`、多两个 op：`plugin_file` 与 `plugin_package`），老客户端不认识
> 它们、也不会去调那两个 op。
>
> ⚠️ **v0.6 → v0.7 是这条加法过渡的收尾，而收尾是不兼容的。**
> v0.7 **删掉**了 `plugins[].files` 与 `plugin_file` 那个 op —— 同一份内容的两条
> 投递方式只剩一条（`package` + `plugin_package`）。所以：
>
> - **新守护进程 ↔ 老客户端：断的。** 老客户端（v0.6 那一版）判"站点支不支持分发"
>   用的是 `files` 在不在，而那个字段没有了 ⇒ 它会把一个**更新、完全正常**的站点
>   当成"太旧、不支持分发"，界面上一句话都不说地什么都不做。**这不是一个可以忽略
>   的症状**：它把一个能用的功能说成没有的能力，而排查的人会去查站点。
> - **老守护进程 ↔ 新客户端：通。** v0.6 的守护进程**同时**报 `files` 与 `package`，
>   新客户端看后者就走得通；更老的（v0.5）根本没有 `limits`，客户端照旧按"守护进程
>   太旧、不支持分发"处理 —— 那一条判据没动过。
>
> ⇒ **所以"不兼容"在这一版里只有一个方向。** 写清楚是因为"不兼容"三个字很容易被
> 读成"两个方向都断"，而两者的应对完全不同：反方向什么都不用做，正方向必须**升客户端**。
> 两端仍然**应当**一起升（v0.2→v0.5 那几段留下的纪律），但这一版的硬要求只有一条：
> **客户端要跟上**。
> ★ 而这一次的**代价要写在明处**：v0.6 里"这个包用的是我读不懂的格式"（`package.format`
> 比客户端的 `FORMAT` 新）本来是**可以回退**的（退回逐份取），v0.7 之后它只能是一条
> **明确的失败** —— 用户能做的事只有升级客户端。格式演进因此从"加法过渡"变成
> "跟着协议版本一起走"。这不是疏忽，是删掉第二条路的**直接后果**。
>
> ⚠️ **更早的一档仍然要分得开**：v0.6 的客户端拿不到站点分发的插件
> （v0.5 的客户端连那个池都不认识，只扫自己的 `~/.slurmate/plugins/`）。
> 所以"能连上"从来不等于"行为一样"。

| 版本 | 变更 |
|---|---|
| v0.1 | 初版。分区通过「用途」（`[purpose:*]` 配置段）间接指定，`submit` 收 `purpose` 键。 |
| **v0.2** | **删掉「用途」这一层**。配置里不再有 `[purpose:*]`；`purposes` op 改成 `partitions`；`submit` 直接收 `cpus`/`mem`/`gpus`/`partition`/`time`，**全部可选，缺省由服务端填**（2 核 / 8G / 从有权限的分区里随机挑一个）。 |
| **v0.3** | **「服务种类」变成「插件」**。配置里每个插件一个 `[plugin:名字]` 块；新增 `plugins` op（客户端据此决定画哪些按钮、各自默认多少资源）；`partitions` 的响应**删掉了 `defaults`**（默认资源改成**按插件**的，只能有一个来源）；`submit` 收 `service_kind` 与 `ssh_pubkey`。 |
| **v0.4** | **插件的身份变成铸造出来的 `id` + 版本。** `plugins` 的每一项多了 `id`（ULID，全球唯一，永不改变）与 `version`；会话视图多了 `service_plugin`（`"<id>@<版本>"`，提交那一刻的值）。`service_kind` 不变 —— 它仍然是**站点内的短名**（配置块名、日志用它）。 |
| **v0.5** | **基座里再没有任何一个插件的名字。** 集群侧的插件表改成**扫** `<prefix>/share/slurmate/plugins/`（不再有 `BUILTIN_PLUGINS`），作业侧改成 deploy.sh **逐插件织一份**作业脚本（`jobs/<ULID>.sbatch`，不再有内建的 `start_*` 分支）；`submit` 的 `service_kind` **不再有内建缺省**（改由配置里的 `default_plugin`，没配就是必填 → `2 missing_service_kind`）；`plugins` 的每一项**删掉了 `builtin`**、**多了 `can_submit`**；`submit` 新增错误种类 `4 service_kind_no_job`（装了但没作业侧实现）。 |
| **v0.6** | **插件文件可以从站点取回来**，而且同一份内容有**两条投递方式**。`plugins` 的每一项多了 `files`（`[{path, size, sha256}]`）与 `package`（`{format, bytes, digest}`）、顶层多了 `limits`（本站的上限，**自述**，含 `package_bytes`）；新 op `plugin_file`（`id` / `version` / `path` → 一份文件，base64）与 `plugin_package`（`id` / `version` → **整个包**，base64）；四个新 kind：`3 plugin_unknown`、`3 plugin_file_unknown`、`4 plugin_file_too_large`、`4 plugin_package_too_large`（外加 `9 plugin_file_changed` 与 `9 plugin_package_changed`）。**全部是加法**。 |
| **v0.7** | **只剩一条投递方式**：**删掉** `plugins[].files` 与 op `plugin_file`，连同三个只属于那条路的 kind（`3 plugin_file_unknown`、`4 plugin_file_too_large`、`9 plugin_file_changed`）。`plugins[].package`、`op_plugin_package`、顶层 `limits`（含 `package_bytes`）**一个字都没动**。★ 「本站支不支持分发」的判据因此**换了**：从"这一项里有没有 `files`"改成顶层**有没有 `limits`**。**不兼容**，见上面那段。<br>★ 同时落下**版本握手**（客户端连上后读 `ping` 的 `version`，按〈三方：谁不低于谁〉判）。**协议线上一个字都没动** —— `ping` 与它的 `version` 自 v0.1 起就在，只是此前没有读者；`engines.slurmate` 的**字段级**规则也统一了（两侧从前一侧静默跳过、一侧拒绝）。 |

★ **`files` 这份清单的来源换过一次，而那一次不是协议变更。** 站点上的插件从
"一棵目录树"变成了"一个包文件"（`<prefix>/share/slurmate/plugins/<ULID>.splug`），
于是那份清单由**包里的记录表**算出来 —— 字段、语义、顺序**一个字都没变**，老守护
进程 ↔ 新客户端、新守护进程 ↔ 老客户端两个方向都照常。装一个插件改用
`slurmate plugin install <包>`（安装器会验签并按 `id` 记住签名者，
见 [PLUGIN-SPEC.md](PLUGIN-SPEC.md) §6.4）。

★ **`files` 与 `package` 在 v0.6 里同时在，报的是同一份包；v0.7 删掉了前者。**
那一段加法过渡的账结在 [CHANGELOG](../CHANGELOG.md) 里：整包那条路一次换 N 份文件
（一次对账从 `1 + 1 + N` 次 RPC 降到 `1 + 1 + 1`），而它多给客户端的一样东西是
**能被签名覆盖的构件** —— 逐份取那条路只有"一份一份的字节"，拼不出一个能被签名的
东西，于是它同时是 §5.4 钉公钥的一个**绕过口**。删掉它不只是少一条代码路径。

★ **v0.3 与 v0.4 从未发布、从未部署过** —— 它们是同一条路上的中间站，内容全部并进了
v0.5。所以协议表的读法是「v0.2 → v0.5 之间隔了三个不兼容的版本」，而不是三段可以
分别升级的台阶。

**为什么要删掉「用途」**：它是**策略**（「这个分区是给哪种卡做开发用的」），
而 Slurm 已经知道**事实**（有哪些分区、用户能用哪些）。把策略额外抄一份到配置文件里，
就多了一处会与实际分叉、且分叉了没人会发现的副本 —— 比如分区名大小写写错，
`validate()` 查不出来，只在 `sbatch` 时才炸。

**跨版本的两端连不上。** 两边必须一起升 —— 协议变了而只改一边，症状是 `submit`
收到 `2 bad_partition`、`2 bad_service_kind` 之类看起来像参数写错的错误。

---

## 一、传输

两条链路，同一份信封：

```
客户端 ──ssh -T──► 登录节点上的 slurmate rpc ──AF_UNIX──► slurmate-sessiond
                    （stdin 读一行，stdout 写一行）  （unix socket，一行 JSON）
```

对客户端而言**只有 `slurmate rpc` 这一个稳定入口**（`cluster/slurmate`）：

```
ssh -T -o BatchMode=yes -p 10100 alice@node01.example.com \
    -- "/bin/bash -c '/usr/local/bin/slurmate rpc'"
```

- 请求体走 **stdin**，响应走 **stdout**，各一行 JSON。**一次一请求**，请求完即退出。
- 客户端把命令显式包在 `/bin/bash -c` 里执行（见 [client/README.md](../client/README.md)）——
  sshd 用登录 shell 解释 exec 请求，钉死解释器可以免掉 zsh/bash 的方言差异。
  但**登录 shell 的 rc 文件仍会执行**（zsh 的 `~/.zshenv` 连 `-c` 都读），
  所以客户端解析应答时从后往前找第一个合法信封，而不是假定它在最后一行。
- argv 是编译期常量，用户输入永远不出现在命令串里。这既是防注入，也是穿过
  登录节点上 `ForceCommand` 守卫的必要条件（命令串里不能出现 `code-server` 字面量）。
- 中文 detail 以字面 UTF-8 输出（`ensure_ascii=False`，`cluster/slurmate`）；
  解析失败时报「守护进程返回的响应不是合法 JSON」（`cluster/slurmate`）。
- 上限：CLI 侧最多读 4 MiB 或读到第一个换行（`cluster/slurmate` 的
  `RPC_MAX_RESPONSE_BYTES`）；守护进程侧最多读 64 KiB 或读到第一个换行
  （`cluster/slurmate-sessiond`）。★ 4 MiB 不是随手定的：整包那条路一次最多发
  `limits.package_bytes`（2 MiB），base64 膨胀 4/3 ⇒ 约 2.7 MiB 再加信封。
  **这两个数有对应用例钉着**（`cluster/test-sessiond-logic.py` 的 19.11d）——
  它们是从两侧各写一遍的，漂开之后 CLI 会报"响应太大"，而客户端把它归成
  `daemon_unreachable`（code 5）**并退避重试**。

人类可读的子命令（`submit` / `status` / `wait` / …）**不保证输出 JSON**，
只在加 `--json` 时才打印信封。客户端应始终走 `slurmate rpc`。

### 超时预算

| 环节 | 值 | 位置 |
|---|---|---|
| 守护进程读一个请求 | 5 秒 | `cluster/slurmate-sessiond` |
| CLI 等守护进程应答 | 40 秒（默认） | `cluster/slurmate` |
| CLI `heartbeat` / `goodbye` | 20 秒 | `cluster/slurmate` |
| 客户端等 `submit` | **45 秒**，必须比 CLI 内部的 40 秒长 | `client/src/main/session.js` |
| 客户端等 `goodbye` | 10 秒 | `client/src/main/session.js` |
| 客户端认领用的 `status` | 20 秒 | `client/src/main/session.js` |

`submit` 的超时必须**大于** CLI 内部的 socket 超时，否则会在守护进程还在跑 `sbatch`
的时候放弃 —— 然后按大多数重试逻辑去重试，于是两个作业（`client/src/main/session.js`）。

---

## 二、信封

### 请求

```json
{"op": "submit", "cpus": 2, "mem": "8G", "gpus": 0, "time": "12:00:00"}
```

> **v0.2 变更**：`submit` 不再接受 `purpose`，「用途 → 分区」那一层配置被整个删掉了。
> 见下面的〈协议版本与变更〉。

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
- **`error.detail` 是守护进程写的中文，可直接展示给用户**（`client/src/main/classify.js`）；
- `error.kind` 是机器可读的短标识，**必须靠它做分支，不要靠 `code`**（理由见第四节）。

## 三、错误码

| code | 含义 | 典型 `kind` | CLI 退出码 |
|---|---|---|---|
| `0` | 成功 | — | `0` |
| `2` | 用法错误 / 客户端 bug / 请求不合法 | `bad_request`、`bad_json`、`empty_request`、`unknown_op`、`bad_partition`、`bad_time`、`bad_service_kind`、`missing_service_kind`、`bad_ssh_pubkey` | `2` |
| `3` | 未找到（会话不存在，uid 查不到，或本站没有这个东西） | `not_found`、`unknown_uid`、`plugin_unknown` | `3` |
| `4` | 被拒绝：配额、权限、账户、熔断、这个服务用不了 | `quota_active`、`no_account`、`no_partition`、`throttled`、`service_kind_disabled`、`service_kind_no_job`、`plugin_package_too_large` | `4` |
| `5` | **守护进程不可达**（`daemon_unreachable`）**或**端口池空（`no_port`） | `daemon_unreachable`、`no_port` | `5` |
| `6` | Slurm 侧失败 | `partitions_unknown`、`submit_failed` | `6` |
| `7` | 触发限流 | `rate_limited` | `7` |
| `9` | 守护进程内部异常 | `internal`、`plugin_package_changed` | `1`（不在映射表内，落到默认值） |

退出码映射见 `SLURMATE` 的 `_code_to_exit()`（`cluster/slurmate`）；
`9` 不在其中，所以返回 `1`。CLI 自己的退出码约定写在 `cluster/slurmate`。

> 📝 **v0.6 把 v0.5 漏掉的三个 kind 补进了这张表**：`missing_service_kind`、
> `service_kind_disabled`、`service_kind_no_job`。它们从 v0.3 / v0.5 起就在代码里、
> 就在用户会看到的报错里，只是从来没被登记 —— 而这张表是**实现者的唯一依据**：
> 一个只读这张表的人会以为"站点没开这个插件"没有机器可读的 kind，于是回去靠
> `detail` 的文案分支。表不全的症状是**下一个人照着错的表写代码**，不是某个用例变红。
>
> ★ `9 plugin_package_changed` 是**故意**用 9 的：
> 它们不是"客户端请求错了"，而是"本站自己脚下的字节在服务期间被换掉了"（管理员
> 就地换了插件包）。归到 `2` 会让客户端把它当成自己的 bug 去重试，归到 `3` 会让
> 用户以为要换个插件 —— 它实际要的是**站点重新部署**，只有 `9`（内部异常）不会把
> 人指向错误的方向。

**`code 5` 有两种含义，这是本协议最容易写错的地方。** 见下一节。

---

## 四、三态区分（本协议的核心）

客户端必须区分三种「没成功」的情形，处理方式**完全相反**：

### 1. 传输层失败 —— 没拿到应答

触发条件（`client/src/main/classify.js`）：

- 后端抛了传输错误（`transportError`）：SSH 断了、channel 关闭但没有 exit 事件、超时；
- 响应为空或不是对象；
- 响应不是合法 JSON。

**处理：重试。而且绝不能因此判定会话结束 —— 心跳照发。**
客户端**刻意不区分**「SSH 断了」和「守护进程没回话」：两者在客户端看来是同一种东西
（请求没得到应答），处理方式也一样（`client/src/main/classify.js`）。

### 2. 守护进程不可达 —— `code 5` 且 `kind == "daemon_unreachable"`

这是**守护进程侧明确地通过一份合法 JSON 告诉你它不可达**。具体来源是 CLI：
它连不上 unix socket 时，会自己合成这个信封
（`cluster/slurmate` 的 `cmd_rpc`）。
也就是说，**守护进程本身从不产生 `daemon_unreachable`** —— 它连不上时根本没法回话。

**处理：退避重试，并保持心跳。** 客户端的提示文案是：

> 控制节点上的 Slurmate 守护进程没有响应。你的作业仍在运行。

（`client/src/main/classify.js`）

### 3. 守护进程明确拒绝 —— 其余 `ok:false`

**处理：停止重试，把 `error.detail` 原样展示给用户。**

### 为什么必须靠 `kind` 而不是 `code`

`code 5` 同时被用于「连不上守护进程」和「端口池耗尽」，而处理方式相反：
前者要退避重试并**保持心跳**，后者只是等一下（`client/src/main/classify.js`）。
这是 `classify.js` 这个文件存在的首要理由。

分错的代价是现实的：把 `daemon_unreachable` 当成「会话没了」去处理，就会停止心跳 ——
一个正在跑的作业在 `orphan_after_seconds`（默认 1800 秒）后被自动 `scancel`，
而用户以为自己只是断了个线。

同一条原则适用于 `code 4`：`kind == "throttled"` 是被熔断了，等一会儿会自动恢复，
**不是用户能解决的问题**，所以走退避重试而不是「请用户去处理」
（`client/src/main/classify.js`）。

---

## 五、重试策略

由 `classify()` 一次映射成「客户端可行动作」（`client/src/main/classify.js`）：

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
  （`client/src/main/classify.js`）。
- **`code 2` 绝不重试。** 重试只会重复同一个错误，白白消耗 RPC 配额
  （`max_rpc_per_second = 10`，`client/src/main/classify.js`）。

### 幂等性：只有 `submit` 不是幂等的

`classify()` 返回的 `idempotent` 字段是一个可断言的开关：
`op !== 'submit'`（`client/src/main/classify.js`）。`shouldRetry()` 会在
`idempotent` 为假时直接返回 `false`，**无论动作是什么**。

`submit` 必须这样处理的具体理由：`op_submit` 每次调用都生成新 `sid`、插新行、
提交新作业（`cluster/slurmate-sessiond`）—— 它是**非幂等**的。

★ **F14 已经在 v0.7 修掉**：配额数的那个集合（`OCCUPYING_STATES`）含
`reserved` / `submitted`，所以「已提交、尚未登记」那个窗口里它不再是 0，
并发的第二个提交当场被拒。修法是**完备**的，唯一的依据是守护进程**单线程串行**
（`run()` → `select` → `accept_one` → `handle_client` 同步跑到底），所以两次
`submit` 不可能交错；而那道检查在 `store.insert` **之前**。
★ 客户端这套处理**照旧不变** —— 服务端那一侧修好了，不等于客户端可以开始重试：
超时仍然可能是"响应丢了而会话建好了"，认领仍然是唯一正确的下一步。

所以客户端的做法是（`client/src/main/session.js`）：

1. `submit` 超时（45 秒）后**绝不重试**；
2. 改调一次**不带 `session_id`** 的 `status` —— 它会返回该 uid 最新的活跃会话
   （`cluster/slurmate-sessiond`），用于认领「响应丢了但会话其实建好了」；
3. 认领成功就在界面上说明「提交响应超时，但已在控制节点上找到刚创建的会话，继续接管」；
4. 认领失败则明确告诉用户去 `squeue` 检查是否有多余作业。

---

## 六、操作

所有 op 都在 `dispatch()` 里分发（`cluster/slurmate-sessiond`）。
**限流先于一切**：任何 op 都要先过 `rpc_allowed()`（每 uid 每秒
`max_rpc_per_second` 次），超了直接 `_err(7, "rate_limited")`。
请求能解析成 JSON 对象但 `op` 不认识 → `_err(2, "unknown_op", op)`。

### `ping`

请求：`{"op":"ping"}`

成功：`{"pong": true, "version": "0.7", "time": 1757...}`

最小连通性探针，用来在排查时区分「链路不通」和「业务逻辑出错」。

★ `version` 是**服务端的基座版本**，而客户端**会读它**：连接建立后、任何会话之前，
客户端拿它与自己的版本比一次（规则见上面〈三方：谁不低于谁〉），不通过就断开并
要求用户升级。所以这个字段的**形状必须是 `x.y`**（`client/package.json` 里那个
号），报一个别的东西（比如 `"0.7-demo"`）会被客户端判成"这条链路上答话的不像我
们的守护进程"—— 那个结论**不谈版本**，它说的是链路。

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

错误：`3 unknown_uid`（`cluster/slurmate-sessiond`）。

### `partitions`

请求：`{"op":"partitions"}`

成功 data：

```json
{"partitions": [{"name": "2080TI", "allowed": true, "is_default": true,
                 "max_time": "183-00:00:00"}]}
```

分区列表**从 Slurm 现查**（`scontrol show partition -o`），并与该用户的
association 求交。客户端不再自己维护一份「用途 → 分区」的声明式配置 ——
那是策略，而策略不该同时存在于两个地方。

`allowed` 为假时附 `reason`（界面据此禁用并说明原因，而不是让用户猜）。

> ★ **v0.3 删掉了这里的 `defaults`。** 默认资源现在是**按插件**的（在一个 shell
> 里跑 codex 和在 IDE 里跑语言服务器不是一回事），所以它跟 `plugins` op 走。
> 留一个全局的 `defaults` 在这里就是**两份真相**：界面显示 2 核 / 8G，而实际提交
> 中转站会话拿到的是 1 核 / 2G，且没有任何地方会为此报错。

错误：`3 unknown_uid`。

### `plugins`

请求：`{"op":"plugins"}`

> ⚠️ **这个 op 本身是 v0.3 才有的。** v0.2 的守护进程回 `2 unknown_op` —— 客户端
> 那时**必须**按"站点没说"处理（按钮照画），而不是把它当成"本站一个插件都没有"。
> 同一份纪律也适用于这个响应里**个别字段**的缺席，见下面 `can_submit`。

成功 data：

```json
{"plugins": [{"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "version": "1.0.0",
              "name": "code-server", "title": "开发环境", "enabled": true,
              "can_submit": true,
              "defaults": {"cpus": 2, "mem": "8G"},
              "package": {"format": 1, "bytes": 19416, "digest": "…"}},
             {"id": "01M2JKHTZGF12N0T9CB3XVK36H", "version": "1.0.0",
              "name": "sshd", "title": "SSH 中转站", "enabled": false,
              "can_submit": false,
              "defaults": {"cpus": 1, "mem": "2G"},
              "package": {"format": 1, "bytes": 40000, "digest": "…"}}],
 "enabled": ["code-server"],
 "limits": {"file_bytes": 262144, "total_bytes": 1048576, "max_files": 256,
            "package_bytes": 2097152}}
```

> ★ **每一项里只有名字、版本、开关、默认资源与一个 `package`。** v0.6 时这里还有
> 一份 `files`（逐份取的清单），**v0.7 删掉了** —— 见下面〈`package` / `limits`〉
> 与〈〇、协议版本与变更〉。
>
> ★ 注意 **`plugin.json` 自己也在包里** —— 站点分发发的是**整个包**，不是只挑
> 客户端会执行的那一份。README 也一样会被发下去。
>
> ★ `package` 里那三个数是**示意值**：本仓库那两个插件还没有包（要作者先
> `packer init` / `keygen` / `build`，见 [plugins/README.md](../plugins/README.md)）。
> `format` 是**容器**格式版本（[PLUGIN-CONTAINER.md](PLUGIN-CONTAINER.md) 的 A.1
> 里那个 `format`，不是插件的版本号），
> `bytes` 是**整个包文件**的字节数（客户端要下载的就是这么多），
> `digest` 是**内容摘要**（§3.4 —— 签名盖的就是它、插件的身份就是它），
> **不是**容器字节的 sha256。

> ★ **`can_submit` = 「现在提交得出去吗」= `enabled` **且** 本站有它的作业侧实现。**
>
> ★ 两个事实合成**一个**字段，是因为**服务端才是同时知道这两件事的那一方**。让客户端
> 自己拿 `enabled` 去推，就多出一份会漂的推理 —— 而多出来的那一位（这个插件有没有
> `job/start.sh`）客户端**根本看不见**：那一半客户端从来不读。
>
> 它与 `enabled` **不是重复的**，因为两句话对应两个该做的事：`enabled=false` 该说
> 「本站没开放它，去找管理员」；`enabled=true` 而 `can_submit=false` 该说「本站装了
> 它，但它没有作业侧实现」—— 后者**打开那个开关没有用**，得重新部署。
>
> ⚠️ **老守护进程不报这个字段，那不等于「否」。** 客户端必须按"站点没说"处理
> （缺省当作可以提交），否则升级一次客户端会让所有老服务端的插件按钮同时变灰。
> 这与 `plugins` 整个 op 缺席是同一条纪律（见本节开头那段）。
>
> ★ **`can_submit` 不违反"不发 `needs_pubkey` 那类字段"的原则。** 那条原则管的是
> "这个插件**在客户端上**会做什么"（客户端自己的事）；`can_submit` 说的是**站点
> 这一侧**的事实，客户端无从推导。

> ★ **v0.5 删掉了每一项里的 `builtin`。** 它从前恒为 `true`（插件的代码随本项目一起
> 发布），而没有任何客户端代码读它 —— 一个永远为真、谁也不看的字段，只会让下一个
> 读的人问"什么时候是 false"。现在**没有内建这回事**：两端都只认"装了的插件"，
> 而"装"是站点的一个动作（集群侧 `deploy.sh --plugins-src` 或
> `slurmate plugin install`，客户端是经站点分发取回来）。

客户端据此决定画哪些按钮、以及每个按钮上"默认 2 核 / 8G"该写多少。

> ★ **`id` + `version` 是解析键，`name` 只是人读的短名。** 客户端拿 `(id, 版本)`
> 去自己的插件池里找配套的那一半。为什么不能靠 `name`：插件由**站点**分发，没有
> 市场能在线升级，两个站点可以各有一个叫 `jupyter` 的插件而它们是**不同的东西**；
> 反过来同一个插件被两个站点分发又该被认出来。名字答不了这两个问题，铸造出来的
> `id` 才答得了。
>
> `name` 只需要**站点内唯一**（配置校验保证），它出现在配置块名、日志与
> `service_kind` 里。

三条契约，每条都对应一种"用户看不见"的失败：

- **报出全部插件，包括 `enabled: false` 的。** 「装了但停用」与「本站没有这个东西」
  是两回事，界面该能分开显示，运维该能一眼看出自己关了什么。
- **不替客户端过滤它可能不认识的名字。** 把它认识的挑出来再发，运维就永远看不到
  「站点开了个我这版客户端不认识的插件」—— 而那正是升级提示的唯一来源。
- **`title` 是给不认识它的客户端用的兜底标签。** 客户端认得这个插件时用**它自己的**
  名字（那个才对应它实际会做的事）。

这里**不发** `needs_pubkey` 之类"这个插件在客户端上会做什么"的字段：那些是客户端
自己的事（它的插件模块里写着），由服务端下发只会让客户端有机会相信一个关于**自己**
的错误描述。

错误：`3 unknown_uid`。

#### `package` / `limits`（v0.6，v0.7 起是唯一一条投递方式）—— 站点分发

这两样是**可选**的加法。老守护进程不报它们，客户端必须按"站点没有这个能力"处理
（见〈三态区分〉）。

- **顶层 `limits` 在不在，就是"本站支不支持分发"的唯一判据。** v0.6 时这个判据是
  `files` 在不在，而那个字段没有了 —— 换成了这一个。★ 换的是**字段**，不是**纪律**：
  它仍然必须是一个**协议事实**，**下载失败、超时、校验不过都不构成判据** ——
  那是瞬时事实，拿它当判据等于给一个能让下载失败的人（断流、丢包、中间人）一个
  把用户降级到别处的开关。
- **`package`（`{format, bytes, digest}`）是这一份分发出去的样子**，配合
  `plugin_package` 一次把整个包取回来。
  - **`digest` 是内容摘要（§3.4），不是容器字节的 sha256。** 给同一个负载补一个
    签名块，容器字节变了而它**一个字都不变** —— 这正是"摘要不变 ⇒ 还是同一份
    构件"（§2.4/§4.2）在协议里的样子。客户端拿它的唯一正确用法是"与**我自己
    从下载到的字节重算出来的**那个比"。
  - **`package: null` 是一个真实的状态，不是"本站没有这个能力"。** 它说的是
    "这一份现在给不出来"（包在守护进程启动之后不见了）。能力在不在，判据是
    **顶层有没有 `limits`**。两件事必须分得开：合成一个信号的话，一次误删文件会
    让客户端把整站降级。
  - **这一项里没有 `package` 这个键（`undefined`）= 这一份不分发。** 三个状态
    必须分得开，这也是〈三态区分〉在字段一级的样子：
    `undefined`（本站不打算发这一份）／`null`（此刻生产不出来）／一个对象（发）。
- **`limits` 也是自述**，客户端取"本站报的"与"客户端自己的硬上限"中**更严**的
  那个。一个站点（或一次中间人）报 10 万个 1 字节的文件，客户端会跑很久、耗尽
  inode、把家目录塞满 —— 上限不能由被审计方单方面决定。
- ★ **`limits` 里有两笔不同的账，别混。** `file_bytes` / `total_bytes` /
  `max_files` 是**负载内**的规则（解出来的那些文件）；`package_bytes` 是**链路**上的
  （整包 base64 之后要能装进一条应答）。一个插件可以三个负载数字都合格、而整个包
  仍然太大 —— 那时客户端连一次都取不回来，所以这一条必须单独报。
  ★ 而**负载内那三个数不走线**：v0.6 时守护进程在 `plugin_file` 那一条上也执行
  一次（超了回 `4 plugin_file_too_large`），v0.7 之后它们**只由客户端读方执行**
  （它拿包里的记录表与本站报的上限比），本站**只通报、不拦截**（唯一拦得住的是
  `package_bytes`，安装器与 `op_plugin_package` 两侧都拦）。
- **负载里的每一条路径都要再判一遍。** 解析器已经拒过（§3.3 是一条**拒绝**规则，
  不是"遍历时跳过"），而客户端**还要自己再判一次** —— 服务端也可能被换过，与
  `validate_session()` 对会话文件的态度同源。任何一条不过就**拒绝整份**：一个
  说不清的包本身就是"这份东西不能信"。★ v0.6 时这里还有一句"`path` 只是一个键、
  从不参与拼路径"，那是 `plugin_file` 那条路的形状；**那条路删掉之后，没有任何
  一条对外应答是按路径逐份取的** —— 路径穿越这个形状现在只剩"进不进得了包"这一道。
- **符号链接与空目录进不了负载。** ★ 插件变成包之后这不是一条纪律，是**结构性的**：
  包里的负载是一条条 `路径 | 字节`（[PLUGIN-CONTAINER.md](PLUGIN-CONTAINER.md) 的
  A.1），链接与目录
  条目**表达不出来**。所以这一条从"两端规则要一致"退化成"根本不会有"。
- **分不发由站点的 `enabled` 决定。** 本站关着的插件照样*报*（上面那条契约：
  报出全部插件），但客户端只分发 `enabled: true` 的那些。

### ~~`plugin_file`~~ —— **v0.7 删掉了**

> ★ **这一节从前是一整条投递方式**（`id` / `version` / `path` → 一份文件，base64）。
> 它连同 `plugins[].files` 一起在 v0.7 被删掉，理由写在 [CHANGELOG](../CHANGELOG.md)
> 的〈为什么删掉它，而不是留着〉那一段里，最短的版本是：**它发的是散装字节，证不了
> 签名者** —— 它不只是多一条代码路径，是多一条**验签绕得过去**的路。
>
> 它还带走了三个只在它那条路上存在的 kind：`3 plugin_file_unknown`、
> `4 plugin_file_too_large`、`9 plugin_file_changed`。新守护进程对这三个 op 名字
> 回的是 `2 unknown_op`（`plugin_file` 这个 op 已经不存在了）。
>
> ★ 留这一节而不是删干净，是因为**协议文档要能回答"那个 op 去哪了"** —— 一个在
> 老客户端里还在调、在新守护进程上回 `2 unknown_op` 的名字，是排查时最需要的一行。

### `plugin_package`

请求：`{"op":"plugin_package", "id": "<ULID>", "version": "1.0.0"}`

> ⚠️ **这个 op 是 v0.6 才有的。** v0.5 的守护进程回 `2 unknown_op`。

成功 data：

```json
{"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "version": "1.0.0",
 "format": 1, "bytes": 19416, "digest": "…", "data": "<base64>"}
```

**一次把整个包取回来**，`data` 是那个 `.splug` 文件本身（[PLUGIN-CONTAINER.md](PLUGIN-CONTAINER.md)
那一套容器）的 base64。
`format` / `bytes` / `digest` 与 `plugins` 里那一份**必须逐字相同**（客户端据此判断
"这一轮清单说的"与"我拿到的"是不是同一个东西）。

> ★ **这条路发出去的是容器本身。** 客户端拿到整包之后能**自己**解析、自己重算
> 内容摘要、自己验签（§4.2 / §6.1）—— 于是本站报的 `digest` 与本站转发的字节
> 是**分开的两件事**，客户端有办法发现它们对不上。
>
> ★ v0.6 里这一句后面还跟着"这是它与 `plugin_file` 最要紧的差别"，而 **v0.7 之后
> 没有那条路可以比了**：它已经不在协议里。留下来的那句话现在说的是"为什么客户端
> 手里必须有容器本身"。
>
> ★ **不因为是"整包"就多一层信任**：发出去的是站点自己的字节，客户端仍然要自己验。

错误：

| code | kind | 什么时候 |
|---|---|---|
| `3` | `plugin_unknown` | 这个 `(id, 版本)` 本站没有 |
| `4` | `plugin_package_too_large` | 整个包超过 `limits.package_bytes`。**必须拒绝**：截断发出去等于客户端拿到一个解不开的容器，而它会在那边报成"包坏了" |
| `9` | `plugin_package_changed` | 这个包在守护进程起来**之后**被换过（字节数、内容摘要或容器格式对不上启动那一刻的快照），或者它已经不见了 |

> ★ 正常部署下 `plugin_package_too_large` **拦不到东西** —— 安装器在装的时候就拒绝
> 了超过这个上限的包（装了也发不出去）。它拦住的是绕过安装器放进来的一份。

### `submit`

请求（**全部字段可选**）：

| 字段 | 类型 | 缺省 |
|---|---|---|
| `service_kind` | **本站的短名**（配置块名） | 配置里的 `default_plugin`；**没配就是必填**，否则 `2 missing_service_kind` |
| `ssh_pubkey` | 一行公钥 | 清单里 `contributes.submitPubkey` 为真的插件**必填**，否则 `2 bad_ssh_pubkey` |
| `cpus` | 整数 | **该插件**的 `site.defaultCpus`（站点可在 `[plugin:<名字>]` 块里覆盖；服务端钳制到 1–上限） |
| `mem` | 字符串 | **该插件**的 `site.defaultMem`（必须匹配 `^[0-9]+[KMGTP]?$` 且非 0；否则回退默认并打 warning） |
| `gpus` | 整数 | 未给 = **完全省略** `--gres`（默认不占 GPU）。给了 `0` 也一样省略 |
| `partition` | 字符串 | **未给 = 从该用户有权限的分区里随机挑一个**（见下） |
| `time` | Slurm 时间 | `12:00:00`（超过**分区自己的 `MaxTime`** 与硬上限 7 天中的较小者时截断） |

> ★ **默认值一律由服务端填，不由客户端填。** 客户端省略字段是在说「用你的默认」，
> 不是「我要 0 核」。服务端必须自己填默认值并做上限钳制 ——
> 否则一个改过的客户端省略字段就能要到整台机器。客户端的「高级选项」
> 只是**临时覆盖**，不写进任何配置，关掉窗口即失效。

> ★ **随机挑分区的边界**：`allowed_partitions()` 查不到时返回 `PARTITIONS_UNKNOWN`
> 哨兵。**显式指定**分区的路径继续 fail-closed（用户点了名就必须验，返回 `6`）；
> **缺省随机**的路径退化为**不带 `-p`**（交给 Slurm 的默认分区）并在响应里带
> 一个 `warning` —— 此时我们没有对权限做任何声明，而 Slurm 自己会用 association 兜住。
> 这不是漏判，实现时要写进注释，免得后人误「修」。

成功 data：

```json
{"session_id": "9f2c…", "job_id": 12345, "state": "submitted",
 "partition": "2080TI", "resources": {"cpus": 2, "mem": "8G", "gpus": null},
 "candidates": [55001, 55002, ...], "requested_time": "12:00:00"}
```

`partition` 是**实际选中的那个**，必须返回 —— 因为是随机挑的，用户事先
不知道会落到哪种卡上，界面要显示出来。它也可能为 `null`：分区权限查不到时缺省提交会
退化为不带 `-p`（见上面的随机挑分区边界），那时「落在哪个分区」在提交那一刻确实无人
知晓，报 `null` 比编一个出来诚实。作业跑起来之后 `status` 会用 Slurm 的答案补上。

### `warning`（可选字段）

**服务端替用户做了决定时必须带上这个字段。** 它出现的情况有三种：

- 请求的时间被截断到分区 `MaxTime` 或硬上限；
- `mem` 无法识别（比如 `--mem=0` —— 在 Slurm 里那是「该节点的全部内存」），已回退默认值；
- 分区权限查不到，因而交给了 Slurm 的默认分区。

它**不影响成功**（`ok` 仍为真、会话照常创建），但客户端**必须显示它**：用户会以为
自己要到了 30 天，而实际拿到的是 7 天。静默地替他决定，正是这个项目一路在清的那类
问题。协议里有这个字段的唯一理由就是被显示出来 ——
`client/src/main/session.js` 会把它接进 `snapshot().warning`。

错误：

| code | kind | 触发 |
|---|---|---|
| `2` | `bad_partition` | 指定的分区名不存在 |
| `2` | `bad_time` | 时间格式无法解析或 ≤ 0 |
| `3` | `unknown_uid` | `getpwuid` 失败 |
| `4` | `throttled` | 该 uid 在熔断静默期内 |
| `2` | `missing_service_kind` | 没给 `service_kind`，而本站也没配 `default_plugin` |
| `2` | `bad_service_kind` | 本站**没有装**这个短名的插件（客户端太新，或名字打错） |
| `4` | `service_kind_disabled` | 认得这个插件，但**本站没开**（管理员的一个决定） |
| `4` | `service_kind_no_job` | 本站装了它、也开着，但**它没有作业侧实现**（部署不完整，`plugins/` 里有而 `jobs/` 里没有对应那一份） |
| `2` | `bad_ssh_pubkey` | 需要公钥的插件没带公钥，或那行公钥不合法 |
| `4` | `quota_active` | **占着位置**的会话数已达 `max_sessions_per_user`（站点可配，见 [CONFIGURATION.md](CONFIGURATION.md)）。**排队中的也算** |
| `4` | `no_account` | 该用户没有 Slurm association |
| `4` | `no_partition` | association 不允许这个分区 |
| `5` | `no_port` | 端口池暂时没有可用端口 |
| `6` | `partitions_unknown` | 分区权限**查不到**（安全路径上宁可拒绝） |
| `6` | `submit_failed` | `sbatch` 失败 |

> ★ **`service_kind` 这一族必须是四种错误**，不能合并成一句话 —— 分开它们的**不是
> 严重程度，是"这件事该谁去做"**：
>
> | kind | 谁的错 | 该怎么办 |
> |---|---|---|
> | `missing_service_kind` | 调用方 | 补上 `service_kind` |
> | `bad_service_kind` | 客户端版本 / 参数 | 升级客户端，或改掉打错的名字 |
> | `service_kind_disabled` | **站点**（管理员的开关） | 找管理员打开那个配置块 |
> | `service_kind_no_job` | **站点**（部署不完整） | 找管理员**重新部署** |
>
> 后两条**都是"找管理员"，但管理员要做的事完全不同** —— 后者去翻配置开关是白费
> 功夫，缺的是 `jobs/<ULID>.sbatch`。合并了，用户就只能一个个试。

> ★ 客户端**不填**默认资源。省略一个字段是在说「用你的默认」，不是「我要 0 核」——
> 服务端必须自己填默认值并做上限钳制，否则一个改过的客户端省略字段就能要到整机。
> 而那个"默认"现在是**按插件**取的（见 `plugins` op），所以同一个客户端在两种
> 插件上会得到两组不同的默认值，这是对的。

注意「`--mem=0` 在 Slurm 里的含义是该节点的全部内存」这个坑：用户笔误会让一个开发
会话吃掉整台机器，所以校验是显式拒绝并回退（`cluster/slurmate-sessiond`）。

### `status`

请求：`{"op":"status"}` 或 `{"op":"status","session_id":"<sid>"}`

- 带 `session_id`：返回该会话，**不属于调用者的会话一律报 `3 not_found`**
  （不是「无权限」—— 不泄露别人的会话是否存在，`cluster/slurmate-sessiond`）。
- 不带：返回该 uid 最新的活跃会话（`reserved`/`submitted` + `ACL_STATES`），
  没有则 `{"session": null}`。

成功 data：`{"session": { ... }}` 或 `{"session": null}`。

会话视图字段（`session_view()`，`cluster/slurmate-sessiond`）：

| 字段 | 说明 |
|---|---|
| `session_id`、`job_id`、`state`、`partition`、`resources` | 基本身份 |
| `node`、`node_ip`、`service_port` | 作业落点 |
| `tunnel_target` | **`"<字面 IPv4>:<端口>"`**，或 `null`（还没登记） |
| `created_at`、`enrolled_at`、`last_hb_at`、`renew_count` | 时间线 |
| `requested_time`、`account`、`auth_mode`、`note` | 状态 |
| `service_kind` | 这个会话提供哪种服务 —— **本站的短名**（配置块名）。三态：字符串 / `null`（服务端**明说**不知道，会话是从 nft 规则恢复出来的）/ 键不存在（更旧的守护进程）。**后两种客户端按同一件事处理：不猜**（见下）。 |
| `service_plugin` | **解析键**：`"<id>@<版本>"`。同样是三态，两个 NULL 含义不同（见下）。 |
| `job_state`、`time_limit`、`expires_at` | **可能整个键不存在**（`show_job` 失败时），调用方必须容忍 `undefined` |
| `auth_password` | 只在会话处于 `ACL_STATES` 时返回 |

> ★ **`service_plugin` 必须是提交那一刻的值，读的时候不许现算。**
>
> `plugins` op 报的是站点**当前**的清单，而一个跑着的作业用的是它**提交时**那一份
> 代码 —— 作业侧与客户端侧是配套的两半。站点一升级插件，按"当前清单"解析一个**已经
> 跑着**的会话，就会把**新版本**的客户端代码接到**旧版本**的作业实现上。
> 而站点更新频繁正是这个协议要支持的现实。
>
> `null` 有确定的含义：这个会话是从 nft 规则恢复出来的，服务端**也不知道**它用的
> 是哪一版。客户端据此**拒绝猜测**（只解释、不动作，但隧道照样接起来、会话照样停
> 得掉）。
>
> ★ **"这个键不存在"落到的也是同一个答案：拒绝猜测。** v0.7 之前它兜到清单里标了
> `legacyDefault` 的插件上，理由是"那种守护进程（插件这一层做出来之前的）只可能起
> 一种服务"。那条兜底删掉了 —— 0.y 不支持那个组合，而且它本身就违反这个协议的三态
> 纪律：**缺席不等于可以猜**。今天 `null` 与"键不存在"在客户端是同一件事。

两个必须遵守的客户端规则：

1. **`tunnel_target` 必须原样使用，不要重新解析节点名。** 守护进程写进 nft 的是
   `ip daddr <字面IP>`；客户端解析出的地址与它不一致时 **ACL 会静默失效**
   （`client/src/main/tunnel.js`，`cluster/slurmate-sessiond`）。
2. **`auth_password` 缺失时不能用 `undefined` 覆盖已有值** —— 否则一次 NFS 抖动之后
   自动重登就会因为没口令而失败（`client/src/main/session.js`）。

### `list`

请求：`{"op":"list"}`

成功 data：`{"sessions": [...]}`，最近 50 条，**`with_secret=False`**：不返回
`auth_password`（`cluster/slurmate-sessiond`）。

### `heartbeat`

请求：`{"op":"heartbeat","session_id":"<sid>"}`

成功 data：`{"state": "<新状态>", "at": <ts>}`

**这是判活的唯一依据。** 守护进程只看这个 RPC 写入的 `last_hb_socket`，
**完全不读**作业写的 `.jobhb` 文件（`client/README.md`）。

- 会话在 `suspect` 时收到心跳 → 状态回到 `enrolled`，审计记 `suspect_recovered`。
  作业与 ACL 全程没被动过（`cluster/slurmate-sessiond`）。
- 错误：`3 not_found`。

停发心跳的后果：300 秒后 `suspect`，1800 秒后 `orphaned` + `scancel`。
而界面在此期间**一切正常** —— 这正是最危险的地方（`client/src/main/session.js`）。
客户端的应对是：心跳由**单一 Map** 持有、与窗口是否可见无关；发 `goodbye` 前先停；
并用 `status` 回来的 `last_hb_at` 交叉校验「心跳到底有没有落地」
（落后 90 秒即告警，`client/src/main/session.js`）。

### `goodbye`

请求：`{"op":"goodbye","session_id":"<sid>"}`

成功 data：`{"state": "releasing"}`，或已是终态时原样返回该终态
（幂等，重复调用不报错，`cluster/slurmate-sessiond`）。

错误：`3 not_found`。

⚠️ **`ok:true` 不代表作业被取消了。** `op_goodbye` 丢弃了 `scancel` 的返回值
（`cluster/slurmate-sessiond` 调 `Slurm.cancel()`，而
`Slurm.cancel()` 的失败只写日志），`phase_release` 也不确认作业是否真的没了。
所以客户端把「正在释放」和「已结束」当成两个状态
（`client/src/main/session.js`）。详见
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
（`cluster/slurmate-sessiond`）。`existing` 是**非侵入式体检**：
只读地看一眼既有系统还在不在，本系统绝不碰它们。

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

## 八、给实现者的清单 —— **搬到 [IMPLEMENTING.md](IMPLEMENTING.md) 了**

那一节是**清单**，不是**契约**：它写给"要写一个新的后端、或换一门语言重写客户端"
的人，而读契约的人不需要它。放在这里的后果是两边都不合适 —— 读契约的人会以为那
16 条是协议的一部分，写实现的人要到最后一节才发现它。

★ **内容一个字没改**，只是换了文件。**要写客户端就从那一篇开始**；
本文件从〇到七仍然是契约本身。
