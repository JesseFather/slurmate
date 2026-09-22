# Slurmate 系统架构

> 本文的骨架来自 `cluster/slurmate-sessiond` 的文件头注释。那里已经把设计意图
> 写清楚了，这里把它展开成一份独立文档，并补上规则形态、对账、信任模型与边界条件。
>
> ⚠️ **本文按「文件名 + 符号名」指路，不写行号。** 这不是风格偏好：0.5.0 那次剥离
> 让 `cluster/slurmate-sessiond` 与 `cluster/run.sbatch` 都大改过，此前写下的一百
> 多条行号引用**几乎全部失效** —— 而失效的行号比没有行号更危险，它会指着一个**看
> 起来像那么回事**的地方。所以指路一律写成「`cluster/slurmate-sessiond` 的
> `load_session_file()`」这种形式，读者按符号名搜。同理见
> [CONTRIBUTING.md](../CONTRIBUTING.md) 的〈文档〉一节。
>
> **指路牌不是判据** —— 判据永远是代码本身与它的用例。

## 一句话

Slurmate 让用户在 Slurm 集群上用远程开发环境。它的核心动作是：
**把「谁能连我端口」这份网络 ACL 的登记簿，从「SSH 会话」改挂到「Slurm 作业」上。**
于是 SSH 闪断不再等于会话终结 —— 作业还在跑，ACL 还在，重连即恢复。

作业里跑什么由**插件**决定，而插件是**独立项目**（[`plugins/`](../plugins/)）：
基座两端都不带任何插件，一个都不装是合法状态。见〈插件〉那一节。

## 一、五个组件

| 组件 | 代码 | 身份 | 职责 |
|---|---|---|---|
| 会话守护进程 | `cluster/slurmate-sessiond` | root（systemd） | 代表用户提交作业、维护 nft ACL、判活、续期、对账、对外提供 RPC |
| 用户 CLI | `cluster/slurmate` | 普通用户 | 与守护进程对话；对客户端暴露 `slurmate rpc` 这一个稳定入口 |
| 作业模板 | `cluster/run.sbatch`（部署时**逐插件织一份**成品，装到 `jobs/<ULID>.sbatch`） | 提交后以用户身份运行 | 在计算节点上挑端口、调 `plugin_call start` **分派给插件**、写会话文件与作业侧心跳 |
| nft 表 | `inet slurmate`（运行时创建） | 内核 | 承载 ACL 的唯一实体，寿命 = 作业寿命 |
| 桌面客户端 | `client/`（Electron） | 用户机器 | 提交、等待、建隧道、按插件的清单自动登录、发心跳 |

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
                                                     run.sbatch → 插件起的服务
```

### 1. `slurmate-sessiond`（root 守护进程）

职责写在 `cluster/slurmate-sessiond` 的文件头，逐条对应到代码：

1. **代表用户提交作业**（`Slurm.submit()`）：
   `fork + setuid + sbatch`，并记住「这个 `job_id` 是我代表哪个 uid 提交的」——
   这是整个防伪造体系的支点（见本文第五节）。
2. **发现作业落点**：从用户家目录的会话文件读出「作业实际在哪台节点、哪个端口」
   （`load_session_file()`）。
3. **按作业维度维护 ACL**：独立的 `inet slurmate` 表，规则寿命 = 作业寿命
   （`Nft` 类）。
4. **判活 / 续期 / 释放 / 崩溃恢复**：`tick()` 的五个阶段。
5. **提供 RPC**：unix socket，身份取自内核的 `SO_PEERCRED`
   （`handle_client()`）。

它与既有系统的关系是**零耦合**（见那个文件头）：不碰
`inet codeserver` 表、`ip port-daemon` 表、`/tmp/codeserver-ports`、
`/usr/local/bin/codeserver-*`、sshd 配置、sudoers、`user@.service`。
独立表、独立端口区间、独立状态目录、独立 systemd 单元。部署脚本把这条原则
升级成可验证的判据：部署前后各取一次 nft 规则集快照，剥掉 `inet slurmate`
之后必须逐条一致，否则判失败并提示回滚（`cluster/deploy.sh`）。

为什么是 Python：bash 拿不到 `getsockopt(SO_PEERCRED)`（身份认证的唯一可信来源），
而用 `sed` 解析文本正是最脆弱的地方。

### 2. `slurmate`（用户 CLI）

以普通用户身份运行，**不发送任何身份信息** —— 身份完全由守护进程侧的内核凭据决定
（`cluster/slurmate`）。

它对客户端暴露的稳定接口是 `slurmate rpc`：从 stdin 读一行 JSON，向 stdout 写一行
JSON（`cluster/slurmate`）。客户端必须用**固定 argv** 调用：

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
（`client/src/main/backend-ssh.js`）。

### 3. `run.sbatch`（作业模板）

由守护进程以目标用户身份提交，**文件本身 root 拥有、0644、用户不可写**：执行的是
这个固定文件，用户可控的只有 `sbatch` 的命令行 flag（`cluster/run.sbatch`）。

★ **这个文件里没有任何一个插件的名字。** 它是一份**模板**：`deploy.sh` 对每个插件
把它的 `job/start.sh` 拼在模板里那个 `# @@SLURMATE_PLUGIN_BLOCKS@@` 标记处，装到
`<prefix>/share/slurmate/jobs/<ULID>.sbatch` 的是一份**编织后的成品** ——
**一个插件一份**，文件名是这个插件清单里的 `id`（ULID）。见
[plugins/README.md](../plugins/README.md)〈作业侧契约〉。

★ **为什么一插件一份，而不是所有插件织进一份。** 同处一份文件时，插件里任何一行
**不在函数里**的代码（一个多余的 `set -e`、一个变量赋值）都待在主流程中间 —— bash
自上而下解析整个文件，那一行于是在**每一个**作业里执行，**不管用的是哪个插件**。
一个插件的笔误因此可以改变所有其他插件的作业行为，而症状指不回任何一个文件。
拆开之后，一个插件的代码连"被另一个插件的作业解析到"的机会都没有 ——
`cluster/test-sessiond-logic.py` 第 22 节真的跑两个插件来钉这一条。

**每份成品里恰好一个 `start_<短名>`**，而提交时用的是哪一份由守护进程按
`service_kind` 定（`build_sbatch_argv` 的末项就是 `<jobs_dir>/<ULID>.sbatch`）。
成品里仍留着一道 `declare -F start_<kind>` 守卫：**脚本与 `service_kind` 对不上时
以 24 退出**，而不是跑错服务。

宿主（模板部分）做的事**全都与"哪个插件"无关**：

- 在候选端口里逐个试，每个端口调一次 `plugin_call start`（分派到
  `start_<短名>`）；插件返回非 0 就换下一个候选；
- 把会话身份、隧道目标、以及**自己生成的口令**写进 `0600` 的会话文件。插件的
  附加字段走 `PLUGIN_SESSION_FIELDS`，**转义由宿主统一做** —— 让每个插件自己拼
  JSON 片段等于把转义责任推给每一个插件，而转义写错的下场是整份会话文件解析不了；
- 每 60 秒写一次作业侧心跳文件，并在退出前写「墓碑」（`state=exited`）；
- `cleanup` 里调一次 `plugin_call cleanup`，**位置在 NFS 补写之前** —— 否则
  插件自己的日志进不了 NFS（"认证被拒"这类只有那个服务知道的事实在作业结束后就
  永远消失了）。

它只读 `SLURMATE_*` 环境变量，不接受 argv。

★ **「失败点前移」是编织的全部理由。** `sbatch` 拿到的是路径，但计算节点上的
slurmd 从**自己的 spool** 取脚本执行 —— 本系统从来没有让计算节点打开过
`<prefix>/share/slurmate/` 里任何一个文件。改成运行时 `source` 会引入本项目
**有史以来第一个**「共享目录对计算节点可见」的前置条件，而那个事实**在登录节点上
永远验证不出来**（文件在那儿必然存在）。编织让不确定性归零：一个语法错的插件脚本
让 `deploy.sh` 当场中止，而不是变成用户的一次失败会话。

★ **从一份拆成 N 份没有改变上面这条论证。** 仍然是部署期把内容写进文件、
`sbatch` 仍然只拿到一个路径、计算节点仍然不需要看见 `<prefix>/share/slurmate/`。
变的只是"那个路径指向哪一份"，不是"内容什么时候进到文件里"。**它不是运行时
`source`** —— 谁把这段读成"现在改成运行时加载了"，谁就会去加一条并不需要的
共享目录可见性前提。

### 4. `inet slurmate`（nft 表）

ACL 的唯一载体。表、链、基础规则都由守护进程幂等补齐（`Nft.ensure()`，
`cluster/slurmate-sessiond`），规则本身见本文第四节。

### 5. Electron 客户端

`client/README.md` 概括了它解决的五个问题。其中与集群侧强相关的三个是：

- **会话状态机与心跳**（`client/src/main/session.js`）；
- **隧道**：本地 `127.0.0.1:<槽位端口>` → 计算节点的 `tunnel_target`
  （`client/src/main/tunnel.js`）；
- **RPC 结果分类**：把「守护进程没回话」和「守护进程说了不行」严格分开
  （`client/src/main/classify.js`，见 [PROTOCOL.md](./PROTOCOL.md)）。

> `client/src/main/backend-ssh.js` 已经实现（专用密钥认证、固定 argv 的 RPC、
> 主机密钥 TOFU 校验），**但从未在真实登录节点上验证过** —— SSH 握手、exec 通道与
> `direct-tcpip` 转发都还没有一次真实输出。在那之前，界面上的**开发者模式**仍然
> 可用，假后端不是空壳：它跑真的隧道代码、真的状态机、真的登录契约
> （`client/README.md`）。

## 一之二、插件：一个会话提供哪种服务

一个**插件** = 一种服务。★ **它以一个包文件（`.splug`）分发**，包里三半：

| 半边 | 包里那个路径 | 谁读它 | 什么时候读 |
|---|---|---|---|
| 身份与声明 | `plugin.json` | 两侧（**一份清单，一个 schema**） | 客户端启动 / 守护进程启动 / 安装器 |
| 客户端 | `client/index.js` | 客户端的注册表 —— **可以没有**（那就是声明式插件） | 客户端启动时扫池；站点分发的那一份由对账取回来，**过了同意闸才加载** |
| 作业侧 | `job/start.sh` | **没有任何运行时读者** —— **可以没有**（那这个插件就提交不了） | deploy.sh 部署时**逐插件织一份**作业脚本 |
| 站点策略 | `slurmate.conf` 里的 `[plugin:<短名>]` 块（开不开、默认资源、可执行文件） | 守护进程 | 守护进程启动 |

站点上它是 `<prefix>/share/slurmate/plugins/<ULID>.splug`（**一插件一个文件**，
文件名就是它的 id）—— **服务器上从头到尾没有源码树**，包是作者在自己的机器上
用 `packer/` 打的。

★ **基座不带任何插件，两端都是。** 客户端那边 `client/src/main/plugins/` 里只有框架
（注册表、铸造 id 的 `ulid.js`），插件落在**一个根**里 ——
`~/.slurmate/site-plugins/`（站点分发的，v0.6 起是唯一那条路，见〈插件从哪来〉）；
集群那边守护进程里**一个插件名都没有**，表是
**扫出来的**（`<prefix>/share/slurmate/plugins/`），作业侧是**编织**出来的
（`<prefix>/share/slurmate/jobs/<ULID>.sbatch`，一个插件一份）。
一个都不装是**正常状态**；某个插件**没有 `job/start.sh` 也是合法状态** ——
它装得上、看得见、在 `op_plugins` 里报得出来，但提交不了
（`op_submit` 回 `4 service_kind_no_job`，客户端的按钮因此是灰的）。

★ **「没有作业侧」不是故障，所以它不在 `validate()` 里。** `validate()` 没有
警告通道，往里加一条就是「一个这样的插件让整个站点起不来」—— 那会连停掉正在跑的
会话都做不到。它照 `plugin_problems` 的现成先例处理：`--check` 打印 `⚠`、
`start()` 记一条 `log.error`，但**不拦启动**。

★ 于是「加一个插件」只是**放一个 `.splug` + 跑一次 `deploy.sh --plugins-src`**。
**客户端那一侧一步人工动作都不需要**（v0.6 起它自己取回来），
**也不用改基座的任何一行源码。**

仓库顶层 [`plugins/`](../plugins/) 下有两个现成的：`code-server`（浏览器里的 IDE）
与 `sshd`（用户态 ssh，给原生 VS Code Remote-SSH / codex 这类**要求 ssh 连接**的
工具用）。契约见 [plugins/README.md](../plugins/README.md)，站点侧配置见
[CONFIGURATION.md](CONFIGURATION.md) 的插件一节。

### ★ 一个插件有三样身份，别把它们合并

| | 是什么 | 可变吗 | 出现在哪 |
|---|---|---|---|
| `id` | ULID，诞生时铸一次，**全球唯一** | **永不可变** | 会话的解析键 |
| `version` | `x.y.z` | 每次改动都变 | 会话的解析键 |
| `name` | **站点内**的短名 | 可以改 | 配置块名、日志、`service_kind` |

★ 表里那个 `version` 是**插件版本**（三段）。**框架自己要另一个号** —— 客户端 /
守护进程 / 协议三合一的那个，是**两段**（`major.minor`）。两者形状不同是有意的：
写错了会被拒绝，而不是被悄悄当成另一个意思。规则、四处落点、以及"`engines.slurmate`
写的是哪一个"见 [PROTOCOL.md](PROTOCOL.md) 的〈协议版本与变更〉与
[PLUGIN-SPEC.md](PLUGIN-SPEC.md) §2.3.1。

**为什么要铸造一个 id，而不是用名字**：插件由**站点**分发，没有市场能在线升级，
而站点可能更新频繁、也可能长期不更新。名字答不了两个必须答的问题 ——
两个站点各写一个 `jupyter` 时它们是**不同的东西**（该并存），而同一个插件被两个
站点分发时它们**是同一个东西**（该合并、该认出"这是同一版"）。铸造出来的 id 才
答得了。所以客户端那边是一个**池**（`~/.slurmate/site-plugins/`）：任意站点的安装
都丢进去，任意站点的使用都从里面取，卸载就是把它拿掉。

**为什么会话必须记下 `(id, 版本)`，而不是读的时候现算**：`op_plugins` 报的是站点
**当前**的清单，而一个跑着的作业用的是它**提交时**那一份代码。作业侧与客户端侧是
配套的两半 —— 站点一升级插件就按"当前清单"解析已跑的会话，会把新版本的客户端代码
接到旧版本的作业实现上。所以 `service_plugin` 由守护进程在**提交时**写下，
**此后不再变**。

同理，**客户端在会话创建时把插件对象捕获一次**，之后所有状态变化都用它、不再查表
（`index.js` 的 `controller.plugin`）。于是：

- 站点升级插件，对**正在跑**的会话完全没有影响；
- 把一个插件从池里**卸掉**，也完全不影响它 —— 那个会话手里已经攥着那个对象了。

### 框架 / 插件的边界

**框架不认识任何插件名。** 守护进程、`session.js`、`windows.js`、`run.sbatch` 的
生命周期部分，做的事全都与"哪个插件"无关：提交、端口分配、ACL、状态机、判活、
续期、对账、心跳、停止。唯一的例外是几处**注册表**：守护进程的
`scan_plugins(dir)` 与客户端的 `plugins/index.js` —— 它们**扫**出插件表，
表里有什么完全取决于磁盘上放了什么。

插件只回答一个问题：**这个会话该怎么用。** code-server 自动登录；sshd 把本地 ssh
配好。它们拿到的是框架显式递过去的一组能力（客户端那边叫 `ctx`），而不是整个模块
作用域。

★ **插件不能用相对路径 `require` 框架的源码。** 池里的插件在
`~/.slurmate/site-plugins/<id>/<版本>/`，相对路径指不到客户端；就算指得到，那种依赖也
无法检查。所以插件能用的一切都必须出现在 `ctx` 上（`index.js` 的 `pluginContext`）——
缺什么就加什么，而不是让插件绕过那份清单。这也是把 `sshconfig.js` 搬进 sshd 插件、
把 `keys.js` 挂成 `ctx.keys` 的原因。

★ 同理，**开一块界面由框架做**（按清单里的 `contributes.surface`），不由插件代码做。
所以一个没有 `client/index.js` 的插件照样能有界面 —— 开界面本来就不需要代码。

★ **插件的运行时数据落在哪儿，也是插件自己声明的**（清单里的 `contributes.data`）。
框架把它归一成**一份身份**：`<插件 id> / <共享组> / [<实例>]`
（`client/src/main/plugin-data.js`）—— 浏览器的存储分区与（将来的）数据目录都是这
一份身份的两个落点，而不是两处各自拼的字符串。两个缺省都落在安全侧：不声明 `inherit`
⇒ 身份里带版本号（每个版本各一份，新版本读不到旧数据）；不声明 `perInstance` ⇒ 身份里
没有实例段（所有实例一份，于是同一份数据不会被两份实例同时写）。**"同一个插件不许
同时开两份"那条规则是后一个缺省的推论，不是另焊上去的限制。**

★ 这条边界的作用是让「卸载一个插件」成为一件**有定义**的事。没有它，插件一旦离开，
散落在框架各处的 `if (是它)` 就会连同那个功能一起烂掉，而症状是"删掉插件之后
客户端在某条路径上莫名其妙地不动了"。

### ★ 插件增减不许把客户端带崩

这不是"防御性编程"，是**验收标准**。四条不变量：

1. **会话的状态 / 心跳 / 停止永不看插件。** `status` / `heartbeat` / `goodbye` 只认
   `session_id`。**这是「卸载插件之后用户仍然能停掉作业」的全部依据** ——
   没有它，一个被卸掉的插件的会话会一直挂到 30 分钟的孤儿判定才被收掉。
2. **服务端不认识的插件名** → 提交被明确拒绝（`4 service_kind_disabled` /
   `2 bad_service_kind`），不是起一个"看起来起来了但连不上"的作业。
3. **客户端不认识的插件**（站点装了而本版客户端没有）→ **只解释、不动作**：
   隧道**接起来**（那是用户唯一的出路 —— 他能直接连上去看看那是什么，也能结束它），
   而"怎么用它"一件都不做。绝不建 WebView、绝不 POST 口令 —— 那个端口上跑的可能
   是任何东西，任何做法都是系统在声称一件它并不知道的事。
4. **客户端自己的插件目录里有一个坏插件**（清单不是 JSON、`id` 不是 ULID、有认不得
   的键、`engines` 不满足、客户端代码语法错）→ 跳过它、记一条、其余插件照常工作。
   还有一种更隐蔽的：**同 `(id, 版本)` 而内容摘要不同** —— 两个不同的东西在抢同一个
   身份。这种情况**两个都不加载**并报错，绝不挑一个：池里只有一个 `(id, 版本)` 的
   位置，挑错的后果是会话的解析键指过去、客户端**静默地跑了另一个插件的代码**。
   宁可暂时不可用 —— 那种失败是看得见的（会话变成"未知服务"，仍然接得上隧道、
   停得掉）。这条防**意外**，不防**恶意**：防恶意要靠〈插件从哪来〉那一节里
   逐条对账的四道护栏。

第 3 条还有一面：那种会话是**升级提示的唯一来源**。客户端会把站点有、而自己没有的
插件列出来并点名，否则用户面对的就只是"按钮凭空少了一个"。

### 加一个新插件要动哪几处

**框架一行都不用改**（`index.js` / `session.js` / `windows.js` / 守护进程的提交与
生命周期逻辑都不认识任何插件名）。要动的只有这三处，全是"放东西"，没有一处是改代码：

| # | 在哪 | 加什么 |
|---|---|---|
| 1 | 你的插件**源码树**（**可以在另一个仓库**） | `plugin.json`（**铸一个新的 ULID** 当 id）+ `client/index.js`（可无）+ `job/start.sh`（可无），然后 `packer build` 出一个 `.splug` |
| 2 | `sudo bash cluster/deploy.sh --plugins-src <放 .splug 的那个目录>` | 装进站点 + 为它织一份 `<prefix>/share/slurmate/jobs/<ULID>.sbatch` |
| 3 | `/etc/slurmate/slurmate.conf`（可选） | 一个 `[plugin:<短名>]` 块。**这是站点的决定**，不进仓库；不写就用清单里的缺省 |

★ #1 到 #3 就是全部。**客户端那一步没有了** —— v0.6 起，站点 `enabled = yes` 的
插件由客户端自己取回来（见〈插件从哪来〉）。"加一个插件不用改基座"这句话是
**可机检的**：守护进程里没有任何插件的名字，作业模板里也没有
（`test-sessiond-logic.py` 第 21 节逐字断言后者，第 19.0c 节用一个守护进程
**从没听说过**的合成插件走了一遍完整的提交路径）。成品里当然有那个插件的代码 ——
但**只有那一个**，而哪一份对应哪个插件由守护进程按清单里的 `id` 决定
（第 17 节逐插件断言 argv 末项就是它自己那一份）。

★ 客户端侧之所以一步人工动作都不需要：它**从来没有**一张插件表。插件的身份来自
清单里的 `id`，能力来自清单里的 `contributes`，而"装"只是池里出现一个目录 ——
那个目录**只有一个来路**：站点发下来的（见〈插件从哪来〉）。

### 插件从哪来（分层）

| 层 | 是什么 | 客户端执行服务端代码 | 状态 |
|---|---|---|---|
| 1 本地安装 | 用户自己把一份内容交给客户端，它落进池 | 否（除非那个插件带 `client/index.js`） | ★ **v0.7 删掉了**，见下 |
| 2 站点分发 | 站点把插件的文件推给客户端 | 同上 | **v0.6** |
| 3 代码分发 | 同上，但插件带 `client/index.js` | **是** —— 需要签名、钉公钥、逐插件同意、进程隔离 | **v0.6/v0.7：前三条都做了**（钉公钥在 v0.6 后半段接的线），**第四条欠着**（见下） |

★ **v0.6 同时落在第 2 层与第 3 层上，而这是刻意的。** 仓库里两个插件**都带**
`client/index.js`，所以"只做第 2 层"这个选项在事实上不存在 —— 分发一接上，
第 3 层就同时来了。既然护栏凑不齐，能做的就只有一件事：**把缺的那几条说出来，
并且让默认路径上那个最危险的入口根本不存在**。

★ 那句话当时指的是"第 1 层默认关着"——**而 v0.7 把它做得更彻底：第 1 层没有了。**
今天"会执行远端代码的那条路"只有一条，**而它每一份都过同意闸**（见下）。

**分发单位正在从"一棵目录树"变成一个文件（`.splug`）。** 这一步不是"更整洁"：
"是不是同一份内容"的判据以前是**整棵树的摘要**，而为了让它成立，规范得钉死符号
链接、权限位、空目录、遍历顺序**四件事** —— 每一条都是"摘要相同而内容不同"的
机会。**包把四件事变成结构性不可能**：格式里没有链接、没有目录条目、权限位写死。

| 那一半 | 在哪 |
|---|---|
| 容器格式（规范性） | [PLUGIN-CONTAINER.md](PLUGIN-CONTAINER.md)（`PLUGIN-SPEC.md` 的**附录 A**） |
| 打包器（作者的工具，跑在作者的机器上） | `packer/` —— **服务器上从头到尾没有源码树** |
| 读包：客户端 | `client/src/main/plugin-package.js` |
| 读包：集群侧 | 守护进程的 `package_parse()` / `package_extract()`、`--extract-package` |
| **三份实现在同一批字节上的对账** | `tools/conformance/`（输入树 + 期望的包字节 + 23 条坏包 + 签名夹具） |

★ **"读包"最初落的是能力，不是路径**（那时不动线、不动布局）。现在**布局与投递
都已经切过来了**：站点上的插件就是一个 `<ULID>.splug`（由安装器装，`deploy.sh`
只是"把一批包一起装"），守护进程把它**整个**发给客户端（`package` + `plugin_package`）。
顺序是刻意的 —— **读包的能力先于任何一条线落地**，否则中间会开一个窗口，那个窗口里
客户端拿到的是它读不懂的字节，而它唯一能说的话是"校验不过"。

★ **v0.6 同时开了两条投递方式**（`files` 逐份取 + `package` 整包取），那是**加法
过渡**的形状：老客户端只看 `files`，新客户端看 `package`。**v0.7 把前者删掉了** ——
删它的理由不是省事，是 `plugin_file` 发的是**散装字节**、证不了签名者，所以它是
§5.4 钉公钥的一个**绕过口**。今天两侧读的是**同一张表**（包里的记录表），
一次对账是 `1 + 1 + 1` 次 RPC。

★ **客户端那一半**：一次对账走 `package`，池里每个版本是**两样挨着** ——
`<id>/<版本>/`（解出来的树，`require()` 用的是它）与 `<id>/<版本>.splug`（包本身）。
★ 代价写在 PROTOCOL.md 的〈协议版本与变更〉里：v0.6 时"这个包用的是我读不懂的格式"
可以**退回逐份取**，现在只能是一条**明确的失败** —— 用户能做的事只有升级客户端。

**四道护栏，逐条对账。** ★ **那张表只有一份**，在
[SECURITY.md](../SECURITY.md) 的〈站点分发的插件：四条护栏的对账〉里 ——
它记的不只是"做了哪几条"，还有**没做的那一条用什么替代了**、以及欠着的那件事
在界面上是怎么说出口的。这里的摘要只有一句：**前三条（逐插件同意、钉公钥、签名）
都做了，第四条（进程隔离）还欠着**，而且它**需要一次重构**。

★ 在那之前，**同意界面的措辞就是唯一的安全边界** —— 所以它把话说满了：没有进程
隔离、那段代码会在你这台机器上跑、以及第二次之后旧摘要 → 新摘要的对照。

★ **SECURITY.md 里那张对账表改过两次，两次都是往下更正**，所以下面这段史值得
留着：v0.6 发布时"签名"那一行写着"没做，并给出了不做站得住的条件"（三个前提：
单站点 / 站点即作者 / 站点上那份是 root 从源码装的）。**后来那个条件被两件事
先后推翻**：

1. [PLUGIN-SPEC.md](PLUGIN-SPEC.md) 的 **§5.4** 把签名（以"钉公钥"的形式）写成
   客户端**必须履行**的一条保证 —— 因为发现了三个前提射程之外的第四个场景：
   **同一身份下面"作者换了人"**。那件事只有签名判得了（摘要是一致性判据，分身升个
   版本号在台账上就是一条正常条目）。
2. **分发形态本身变了**：插件由**作者**用自己的打包器产出一个 `.splug`、发布到
   网站 / GitHub，**管理员下载下来**装到服务器上，而服务器侧**没有源码树** ——
   前提 2 与前提 3 当场不成立。

所以那一行现在是 ✅。**它留下的教训不是"当初判错了"，而是"判据要写成可检查的"**：
那句"任一条不成立就回头做"是可检查的，所以它真的被执行了；而含糊的"以后再说"
不会。

**★ 第 1 层（本地安装）在 v0.7 整个删掉了，而删它的理由不是"用的人少"。**

它从前落在**另一个根**上，与站点分发并列：

```
~/.slurmate/site-plugins/     站点池。站点拥有的，可以按引用计数回收
~/.slurmate/plugins/          本机池。用户拥有的，**默认不加载**（要开发者模式开关）
```

当初分成两个根是有理由的，而且那个理由今天仍然成立：回收只该删**站点拥有的**那些，
而用户手装的那一份不在任何站点记录里、引用数天然是 0 —— 合并成一个目录就等于
"回收会把用户自己的东西删掉"。这个理由**不是**洁癖，它是"两个根"当初存在的原因。

**但第 1 层还带着一样别的东西：它整类绕过同意闸。** `allows` 从前写着
`entry.source !== 'site' || config.isTrusted(…)` —— 站点那一类要过闸，本机池那一类
不问。而 [PLUGIN-SPEC.md](PLUGIN-SPEC.md) **§5.2** 明文写着「**禁止**给任何一类插件
开免同意的口子」，理由是"**规则一有分支，绕过它的路就会长出来**"；§5.1 还写着
「往池目录里手工放置内容**必须**不产生任何效果」。

★ **所以规范早就把这条路的形状写死了，而当时的代码是它的反面 —— 两边都"绿"，
因为没有任何一条用例去验规范那两句。** v0.7 的做法不是把闸门加回去（那要回答
"用户自己刚放进去的东西，让他同意自己是什么意思"这个不好答的问题），而是**让那一类
插件不存在**：今天插件进池子只有"站点分发"这一个动作。

★ **于是 §5.1 与 §5.2 从"目标态"变成了"现状"**，而它们今天各有一条正向用例守着
（`client/test/boot.test.mjs`）：往池目录里手放一层树 ⇒ **什么都不发生** ——
不进「可用」那一列、不进「没被加载的」那一列、不进「站点没有的」那一列、不加载、
**也不报错**（报错等于在界面上承认这个形状有意义）。

★ **下面这条区分仍然要留着**，因为它是"池"这个词的全部内容：**"池的模式"指的是
布局与身份模型**（一个目录、`<id>/<版本>/`、按 `id` 认身份、撞了摘要不同就两个都不
加载），**不是"只有一个目录"**。将来若真需要第二个根，先回答 §5.2 那个问题 ——
"它上面每一份凭什么免同意"，答不上来就不许加（`boot.test.mjs` 里那条 `roots`
用例钉着这个）。

**那条反向的信任路径现在存在了，而它必须被说出来。** 在此之前客户端发往登录节点的
命令串是编译期常量、服务端收到的永远只是数据。分发接上之后多了一条
**集群管理员 → 用户的工作站**的路，而且它落的不是数据，是**会跑起来的代码**。
第 3 层那一句"否则它就是一个安静的后门"因此不再是一句预告，而是对**这一版**的
要求 —— 上面那张对账表就是对它的回答。**答案不是"四条都做了"**（那是假的），
而是"做了哪一条、用什么替代了哪一条、还欠哪一条、以及欠着的那条在界面上是怎么
说出口的"。

---

## 二、核心转变：ACL 挂作业，不挂 SSH 会话

传统方案把「用户已连接的端口」记在 SSH 会话上。于是 SSH 一断，登记簿的持有者就没了，
ACL 被撤、会话文件被清、用户重连只能从头再来 —— 而作业可能还在计算节点上跑着。

Slurmate 把登记簿的持有者换成 **Slurm 作业**：

- 作业由 Slurm 管，不随 SSH 会话生死；
- 守护进程是**唯一**把 `(uid, job_id) → 端口` 这条映射写进数据库的实体，
  用户自己写的会话文件只是「登记提示」，不是授权来源
  （`validate_session()`，`cluster/slurmate-sessiond`）；
- 客户端消失 ≠ 作业消失。守护进程用**两阈值心跳**区分这两种情况
  （`phase_heartbeat()`，`cluster/slurmate-sessiond`）：

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
  作业和 ACL 全程没被碰过（`cluster/slurmate-sessiond`）。

判活的依据只有客户端经 unix socket 发来的 `last_hb_socket`。作业侧写的 `.jobhb`
文件**不参与判活**（`client/README.md`），它的作用是别的：区分「是客户端掉了
还是作业没了」。

## 三、状态机

定义在 `cluster/slurmate-sessiond`：

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
| `reserved` | 已分配候选端口，尚未提交 | `op_submit` 插行时（`cluster/slurmate-sessiond`） |
| `submitted` | `sbatch` 已返回 `job_id` | `op_submit` 提交成功后 |
| `enrolled` | 作业在跑、会话文件校验通过、**ACL 已装** | `try_enroll()` |
| `suspect` | 心跳丢失 > `suspect_after`：判定网络闪断，什么都不做 | `phase_heartbeat()` |
| `orphaned` | 心跳丢失 > `orphan_after`：判定异常退出，已发 `scancel` | `phase_heartbeat()` |
| `releasing` | 正在拆除 | `begin_release()` |
| `released` | 终态 | `phase_release()` |
| `rejected` | 终态（校验失败） | `reject()` |
| `expired` | 终态（TTL 到期仍未登记） | `phase_pending()` / `try_enroll()` |

两条不变量：

- `TERMINAL_STATES = (released, rejected, expired)`；
- `ACL_STATES = (enrolled, suspect, orphaned, releasing)` ——
  **这个集合与「nft 里应该存在哪些规则」严格一一对应**。`reconcile()` 用它算期望集合，
  `phase_release()` 保证「`released` 之前规则一定在，之后规则一定不在」
  （`cluster/slurmate-sessiond`）。

另有三个记录在数据库 `trust` 字段上的特殊值。`recovered` 表示这条记录是从 nft 规则
反推出来的（见第六节），它**永不参与自动 `scancel`** ——
对「用户是否还连着」没有可靠信息时，误杀在跑的作业比多留一会儿更糟。

## 四、nft 规则为什么写成单条 `meta skuid != UID drop`

规则形态（`cluster/slurmate-sessiond`）：

```
ip daddr <节点IP> tcp dport <端口> ct state new \
    meta skuid != <属主UID> meta skuid != 0 drop comment "slurmate-sess-<uid>-<job>-<port>"
```

对比另一种常见写法：「先无条件 `drop`，再对属主 `accept`」的一对规则。单条写法有三个
具体好处，写在 `Nft` 的类文档里（`cluster/slurmate-sessiond`）：

1. **爆炸半径锁死在「该 UID 自己」。** 配对写法里的无条件 `drop` 一旦被误注册
   （端口算错、规则残留），打死的是这个端口上的**所有**用户；单条写法最坏也只是
   让某个用户连不上自己的端口。
2. **单次 `nft` 调用即原子。** 消灭「插了 DROP 还没插 ACCEPT」的中间态 ——
   在那个窗口里，连属主自己都被挡在外面。
3. **`ct state new` 只拦新连接。** 已建立的转发不会因为规则抖动被掐断。
   这是「隧道重连不中断」的物理保证：规则被删掉又补回来的那几秒，用户已经建立的
   连接不会断。

规则的 `comment` 编码了 `(uid, job_id, port)`，格式由 `comment_for()` 固定
（`cluster/slurmate-sessiond`）。它同时是三条路径的索引：删除
（`del_by_comment()`）、对账（`session_rules()` 解析出 `{comment: handle}`）、
以及数据库丢失后的反向恢复（第六节）。

### 基础规则与「几何约束」

除了会话规则，链上还有两条基础规则，用 `insert`（而不是 `add`）放在链首
（`cluster/slurmate-sessiond`）：

| comment | 规则 | 作用 |
|---|---|---|
| `slurmate-base-lo` | `oif lo accept` | 本机回环流量放行 |
| `slurmate-base-offcluster` | `ip daddr != <cluster_cidr> accept` | **最后一道几何约束**：本网段之外的流量一律放行 |

第二条是防御性设计：即使前面所有校验都被绕过，也影响不到集群网段之外
（`cluster/slurmate-sessiond`）。它同时决定了部署的一个硬性前提 ——
登录节点与计算节点必须能被**一个** CIDR 覆盖（否则计算节点的流量会被这条规则
提前放行，会话规则永远匹配不到，ACL 静默失效）。详见
[DEPLOYMENT.md](./DEPLOYMENT.md) 的「前置条件」第 2 条。

### 跨表顺序：靠「集合不交」，不靠依赖顺序

nftables 对**同 hook、同 priority 的跨表求值顺序没有保证**。两个表都匹配同一个
`dport` 时，谁先求值是未定义的。所以 Slurmate 不试图去控制顺序，而是从构造上
让顺序无关紧要：**端口区间与集群上其他端口管理系统的区间完全不交**
（`cluster/slurmate.conf.example`）。

这个约束在两处被强制执行：

- 配置自检：`Config.validate()` 断言端口池与 `reserved_ranges` 不重叠，不满足则
  **拒绝启动**（`cluster/slurmate-sessiond`）；
- 部署预检：`deploy.sh` 读同一份配置做同样的区间比对，重叠即中止部署
  （`cluster/deploy.sh`）。

要注意的是这里**没有**用「端口必须 > 55000」之类的硬编码约定。那是某个具体站点的
习惯，写死在代码里会让用低位端口的集群直接装不上（`cluster/slurmate-sessiond`）。
要避让哪些区间由站点的 `reserved_ranges` 决定。

## 五、信任模型

### 身份：`SO_PEERCRED`，不是命令行参数

守护进程在**读任何数据之前**先取 `getsockopt(SO_PEERCRED)`
（`cluster/slurmate-sessiond`）。uid 由内核在 `connect()` 时填充，
用户态不可伪造；pid 不可信（会复用），所以不用它。

socket 权限是 `0666`，但**安全性不建立在这个权限位上**
（`cluster/slurmate-sessiond`）。任何本地用户都能连上它，但只能以
**自己的**身份说话。

### 会话文件是「登记提示」，不是授权来源

一个用户可以在自己家目录里写任意内容的 `job-<id>.json`。所以真正的授权是：
**这个 `job_id` 在数据库里，且由本守护进程代表该 uid 提交过**
（`cluster/slurmate-sessiond`）。

在此之上，会话文件的每一项都对应一个具体攻击（`validate_session()`，
`cluster/slurmate-sessiond`）：

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

读取路径本身也是安全关键（`load_session_file()`，`cluster/slurmate-sessiond`）：
逐级 `lstat` 目录链（非符号链接、属主是本人或 root、组/其他不可写）、
`O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC` 打开、`fstat` 而非 `stat`（防 TOCTOU）、
要求常规文件 / 属主正确 / 模式为 `0600` / 大小上限 / `st_nlink == 1`。

用户家目录一律用 `pwd.getpwuid(uid).pw_dir` 取，**绝不拼「家目录前缀 + 用户名」** ——
用户名与目录名不保证一致，前缀本身也是站点配置（`user_home()`，
`cluster/slurmate-sessiond`）。

### root 不写用户家目录

口令由**作业自己生成**并写进 `0600` 的会话文件；守护进程全程只读用户家目录，
并且 systemd 单元把共享存储挂成只读（`ReadOnlyPaths=`，由 `deploy.sh` 按
`readonly_paths` 渲染，`cluster/slurmate-sessiond.service.in`）。

这样 root 身上没有「写用户文件」这条攻击面，也避免了 root 被符号链接诱骗
（`cluster/run.sbatch`）。代价是守护进程不能替用户创建目录 —— 它也不创建：
`op_submit` 只插数据库行、组环境变量、调 `sbatch`（`cluster/slurmate-sessiond`）。

### 为什么 `auth_mode` 默认是 `password`

**一句话**：`nft` ACL 的 hook 点是**登录节点的 output 链**（`Nft.CHAIN`，
`cluster/slurmate-sessiond` 的 `Nft` 类），所以它拦得住「登录节点上的其他用户连你
的端口」，拦不住「另一个作业恰好被调度到同一台计算节点之后直接 curl 你的端口」。
**完整的论证只有一份**，在 [SECURITY.md](../SECURITY.md) 的〈nft ACL 拦不住同一台
计算节点上的共租户〉—— 那里说清了为什么它不是某个集群的配置问题、以及为什么
`0700` 之类的保护恰好被绕过。这里不重抄。

所以 **code-server 插件在清单的 `site.enumKeys` 里把 `auth_mode` 的缺省声明成
`password`**（`plugins/code-server/plugin.json`），而宿主的作业模板明确拒绝在
拿不到口令时静默降级为 `auth=none`（`cluster/run.sbatch` 的 `case "$SLURMATE_AUTH_MODE"`
分支，`exit 23`）。

★ **这个缺省值住在插件里，不在基座里** —— 基座只知道"认证方式是一个由插件声明的
字符串"，认得的三种（`password` / `publickey` / `none`）之外一律 `exit 24`，
由插件自己在 `start_<短名>` 里实现。理由：`password` 是不是安全的缺省，取决于那个
服务能不能接受一个口令 —— 那是插件的知识，不是宿主的。

## 六、对账与自愈

链的 policy 是 `accept`，规则没了不会报错，只会**悄悄失去保护**。所以 `tick()` 的
第一步就是对账（`reconcile()`，`cluster/slurmate-sessiond`），每个 tick
（默认 2 秒）跑一次：

1. `nft.ensure()` 逐项补齐**表、链、两条基础规则**。它不能只判「表是否存在」——
   如果有人只删了链而表还在，早期实现会直接返回成功，之后所有 `add rule` 都失败，
   对账每 tick 提前返回，**后续所有清理阶段被跳过**：新会话拿不到 ACL、孤儿规则
   永远不删，而进程看起来「健康」、不会重启（`cluster/slurmate-sessiond`）。
2. 算出期望集合（`ACL_STATES` 里每条记录对应的 comment）。
3. **多出来的规则 → 删**（fail-secure：宁可少放行）。
4. **缺失的规则 → 补**。

启动时还有一步 `recover_from_rules()`：从规则 comment 反推出 `(uid, job_id, port)`，
配合 `scontrol` 确认作业仍在 `RUNNING` 且属主相符，就把记录重建出来，标
`trust='recovered'`（`cluster/slurmate-sessiond`）。顺序很重要：**先恢复
再对账**，否则对账会把它们当孤儿删掉（`cluster/slurmate-sessiond`）。

不实现这一步的后果：数据库一丢，`reconcile()` 会把所有规则当孤儿删掉，在跑的会话
瞬间失去防护，而且因为数据库里没有 `job_id` 归属，它们**永远无法重新登记**
（会话文件即使还在也没用）。

## 七、生命周期中的几个「保守」决定

这些决定单独看都像过度防御，但每一条都对应一类真实的、静默的故障。

### 「作业查不到」要连续确认若干 tick

`scontrol` 查不到作业有两种截然不同的原因：作业真的结束了，或者**只是问不到**
（`slurmctld` 重启中、`munge` 抖动、控制器繁忙）。两者无法用返回码区分，所以
`Slurm.job_state()` 靠的是**控制器本身是否可达**（`scontrol ping`），返回三态：
`JOB_OK` / `JOB_MISSING` / `JOB_UNKNOWN`（`cluster/slurmate-sessiond`）。

- `JOB_UNKNOWN`：**什么都不做**，只记日志。
- `JOB_MISSING`：还要连续确认 `job_missing_confirm_ticks` 次（默认 3）才认账
  （`cluster/slurmate-sessiond`）。

早期实现把两者合并成 `None`，后果是控制器抖一次，所有活跃会话的 ACL 在一秒内
全部消失、会话文件被删（再也无法重新登记），而作业还在跑
（`cluster/slurmate-sessiond`）。

### 启动静默期

守护进程重启后的 `startup_grace_seconds`（默认 120 秒）内不做任何超时判定 ——
否则重启窗口会把在跑的会话误判成孤儿（`cluster/slurmate-sessiond`）。

### 退出时不删 nft 规则

规则代表的是**作业**的存在，而作业是 Slurm 管的、不随守护进程生死。重启后靠对账
收敛（`cluster/slurmate-sessiond`）。

### 目标变化时重装 ACL

已登记的会话在作业重启/重排后可能换节点或端口，`refresh_enrollment()` 会跟着更新
规则；但**会话文件暂时读不到时绝不拆规则**（NFS 抖动、作业正在重启都可能造成），
因为那会打断正在用的隧道（`cluster/slurmate-sessiond`）。

## 八、部署拓扑与进程加固

`slurmate-sessiond` 以 root 跑在登录节点上，systemd 单元给出了一组最小权限
（`cluster/slurmate-sessiond.service.in`）：

| 指令 | 为什么 |
|---|---|
| `ProtectSystem=full` | 必须是 `full` 而不是 `strict`：`strict` 会把 `/run` 也挂成只读，切断 munge 的 socket，`scontrol`/`scancel` 全部失败 |
| `ReadOnlyPaths=@READONLY_PATHS@` | 共享存储只读挂载 |
| `PartOf=nftables.service` | `nftables.service` 的 `ExecReload` 是 `nft 'flush ruleset; include ...'`，会连本服务的表一起清掉；`PartOf` 让本服务跟着重启，保证表被重建。**不能用 `BindsTo`** —— 那会让 nftables 启动失败时本服务也起不来 |
| `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK` | nft 走 netlink；`scontrol`/`scancel` 走 AF_UNIX（munge）+ AF_INET（slurmctld） |
| `CapabilityBoundingSet` | `CAP_NET_ADMIN`（nft）、`CAP_SETUID/SETGID`（setuid 提交）、`CAP_DAC_READ_SEARCH`/`CAP_DAC_OVERRIDE`（读 0600 会话文件）、`CAP_KILL`（回收子进程） |
| `StartLimitIntervalSec=0` + `Restart=always` | 永不放弃重启 |

单元是**模板**（`.service.in`），`deploy.sh` 安装时把 `@READONLY_PATHS@` 替换成站点
的真实挂载点；`readonly_paths` 为空时整行被删除，同时打印警告
（`cluster/deploy.sh`）。

## 九、已知边界

写文档时把边界写清楚，比让用户在生产里撞上要好。

1. **单一登录节点。** 规则挂在守护进程所在那台机器的 output 链上。多登录节点集群
   中，用户落到另一台登录节点时那条链上没有规则，保护静默消失。
2. **登录节点与计算节点必须能用同一个 CIDR 表达。** 多网段集群目前无法表达
   （`cluster/slurmate.conf.example`）。
3. **计算节点上没有 per-user 网络隔离时，ACL 覆盖不到同节点内的横向访问。**
   这是 code-server 插件的 `auth_mode` 默认取 `password` 的原因
   （`plugins/code-server/README.md`）。
4. **`op_submit` 非幂等，而配额检查漏掉了 `submitted` 那一档** —— 并发的第二个
   提交因此拦不住。客户端的应对是 `submit` 超时时**绝不重试**，改用不带
   `session_id` 的 `status` 去认领（`client/src/main/session.js`）。
   **未修，编号 F14** —— 机理与两条修法在账本里。
5. **`goodbye` 返回 `ok:true` 不代表作业被取消了** —— 所以客户端把「正在释放」和
   「已结束」当成两个状态（`client/src/main/session.js`）。**未修，编号 F12 / F13。**

★ 第 4、5 两条是**当前代码里的缺陷**，不是设计上的取舍 —— 连同其余未修项、
未实测项与结构性欠账，全部记在 [KNOWN-ISSUES.md](KNOWN-ISSUES.md)。

## 延伸阅读

★ **完整的文档索引在 [docs/README.md](./README.md)**（按"你是谁"分三组）。
下面只列几份，因为它们是**从这一篇直接接下去**的：

- RPC 契约与错误码：[PROTOCOL.md](./PROTOCOL.md)；写一个新后端从
  [IMPLEMENTING.md](./IMPLEMENTING.md) 开始。
- 安装与前置条件：[DEPLOYMENT.md](./DEPLOYMENT.md)；配置项参考：
  [CONFIGURATION.md](./CONFIGURATION.md)。
- 常见故障：[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)（会话与客户端）、
  [PLUGIN-TROUBLESHOOTING.md](./PLUGIN-TROUBLESHOOTING.md)（插件与分发）。
- **未修的缺陷、未实测的假设、结构性的欠账：[KNOWN-ISSUES.md](./KNOWN-ISSUES.md)**
  —— 那是唯一的账本。
- 写一个插件：[plugins/README.md](../plugins/README.md)，契约是
  [PLUGIN-SPEC.md](./PLUGIN-SPEC.md)。**动插件相关的任何东西之前先读它。** 它是
  **契约**不是说明：正文里**没有**实现进度那一栏，进度各自记在自己的 README 与
  `KNOWN-ISSUES.md` 里。
