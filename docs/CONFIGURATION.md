# 配置参考（`slurmate.conf`）

配置文件默认在 `/etc/slurmate/slurmate.conf`，由 `slurmate-sessiond` 的
`--config` 指定。**只有两个读者**：

| 读者 | 怎么读 | 读到之后 |
|---|---|---|
| `slurmate-sessiond` | `parse_config()`，`键 = 值` + `[plugin:名字]` 块 | 全部键（外加它自己扫 `<prefix>/share/slurmate/plugins/` 得到的插件表） |
| `cluster/deploy.sh` | `sed` 抽取 `range_start` / `range_end` / `reserved_ranges` / `readonly_paths` | 用于预检与渲染 systemd 单元 |

`slurmate`（用户 CLI）**不读这个文件**（见下方「不再是配置项的东西」）。

改了配置后：**守护进程需要 `systemctl restart slurmate-sessiond`**；`readonly_paths`
与端口区间的改动需要**重新跑一次 `deploy.sh`** 才会反映到 systemd 单元与部署预检里。

---

## 〇、两种行形态

```ini
cluster_cidr = 192.0.2.0/24     # 站点通用键。【必须写在所有块之前】
range_start  = 55001
...

default_plugin = code-server    # 提交时不带 service_kind 用哪个（可留空）

[plugin:code-server]            # 插件块。**可选的** —— 不写就用插件清单里的缺省
enabled      = yes              #            enabled = yes 才是真的开着
default_cpus = 2
default_mem  = 8G
```

**块一旦开始就没有回头路**：块之后写的通用键会落进那个块，然后被拒。报错会点明
「这是站点通用键，要写在块之前」—— 因为「把 cluster_cidr 追加到文件末尾」是个很
容易犯、而症状完全指错方向的错。

（`deploy.sh` 用 `sed` 抓的那四个键都按行首匹配，所以它们必须待在文件上半部分 ——
与上面这条规则一致。）

---

## 一、站点通用键。一共 12 个。

这是 v0.2 的收缩，v0.3 又把它推进了一步：**能从 Slurm 查到的，一律不再写一份；
只属于某个插件的，搬进那个插件的块。**

分区名、分区的时间上限、GPU 型号、默认资源 —— Slurm 自己知道。写在这里就是第二份
副本，而副本会与实际分叉（分区改名、加卡、管理员调 MaxTime），**分叉了没有任何东西会
告诉你**。所以它们全部现查：

| 事实 | 从哪查 |
|---|---|
| 有哪些分区 | `scontrol show partition -o` |
| 分区的时间上限 | 同上，`MaxTime=` |
| 默认分区 | 同上，`Default=YES` |
| 该用户能用哪些分区 | `sacctmgr show assoc user=<u> format=Account,Partition` |
| 该用户的账户 | 同上，`format=Account` |
| 是否强制 association | `scontrol show config` 的 `AccountingStorageEnforce` |

| 键 | 类型 | 默认值 | 说明与后果 |
|---|---|---|---|
| `cluster_cidr` | 单个 CIDR | **空**（无默认值） | 见下方专节。**留空即拒绝启动** |
| `readonly_paths` | 空格分隔的路径 | 空 | 共享家目录挂载点。守护进程不读它，只有 `deploy.sh` 用 |
| `range_start` / `range_end` | 整数 | `55001` / `55999` | 服务端口池 |
| `reserved_ranges` | `起-止,起-止` | 空（无） | 要避让的其他区间。见下方专节 |
| `candidates_per_session` | 整数 | `6` | 每次提交分配的候选端口数。作业逐个试，被同节点其他作业占用就试下一个 |
| `sbatch` / `scancel` / `squeue` / `scontrol` / `sacctmgr` | 路径 | 空 = 自动查找 | 见下方专节 |
| `default_plugin` | 短名 | **空**（无默认值） | 提交时不带 `service_kind` 用哪个插件。**留空 = 必填**，见〈一之二〉 |

### 为什么 `auth_mode` 和 `code_server_bin` 不在这里了

它们搬进了 `[plugin:code-server]` 块。判据是同一句话：**它是不是"站点的事实"。**

`auth_mode` 是 **code-server 的**认证方式（`--auth password|none`），`code_server_bin`
是 **code-server 的**路径。中转站用的是公钥，那两个键对它一个字都不适用 ——
从前它们摆在顶层，是因为那时只有一个插件。

现在每个插件块里有同样的四项：`enabled` / `default_cpus` / `default_mem` / `bin`，
外加它**自己在清单里声明的**那几个取值受限的键（code-server 是 `auth_mode`；
清单里没声明就一个都没有）。

★ 「外加的那几个」不在代码里，在插件的 `plugin.json` 的 `site.enumKeys` 里 ——
于是加一个插件不需要改守护进程的任何一行，也就不存在"守护进程认得两个键、插件
声明了三个"这种分叉。**没有单独的"额外键"清单**：取值受限的键**就是**额外键，
两份清单可以互相矛盾，一份不能。

---

## 一之二、插件块

★ **插件是一个独立的项目**，装在集群上的 `<prefix>/share/slurmate/plugins/` 里，
由**安装器**装进去：`deploy.sh --plugins-src DIR`，或者 `slurmate plugin install <包>`。
★ 那个目录里放的是**成品包**（`.splug`），不是源码树 —— 缺省的
`<repo>/plugins` 里是源码，直接部署会在预检那一步停下来并告诉你要先打包。

**加一个插件 = 放一个 `.splug` + 跑一次 deploy.sh。** 不需要改守护进程的源码，连
本配置文件都不需要动 —— 下面那些块全是**可选的**，不写就用插件清单里的缺省。
契约见 [plugins/README.md](../plugins/README.md)。

块内的键（每个插件都认这四个）：

| 键 | 含义 |
|---|---|
| `enabled` | 开不开。**不写就用插件自己声明的缺省** —— 见下 |
| `default_cpus` / `default_mem` | **这个插件**的默认资源。客户端省略 cpus/mem 时用这一组 |
| `bin` | 作业在**计算节点**上执行的那个可执行文件。留空 = 按插件清单里声明的 `discovery` 找 |

外加**该插件自己在清单里声明的**那几个取值受限的键（清单里的 `site.enumKeys`）。
仓库里那两个现成的：

| 插件 | 从清单来的额外键 |
|---|---|
| `code-server` | `auth_mode`（`password` / `none`） |
| `sshd` | （没有） |

块名就是插件的**短名**（`service_kind`），它只需要**本站内唯一**。插件的身份另有
一个**铸造出来的全球唯一 `id`**（ULID，写在插件清单里、永不改变）—— 那一层是给
客户端认"这是不是同一个插件"用的，见 [ARCHITECTURE.md](ARCHITECTURE.md)。
**块名不是身份**，它只是本站给人看的名字。

### 「装了」和「开着」是两件事

```
插件在不在       →  这个插件装没装（决定它的配置从哪来）
enabled          →  它开没开（决定用户能不能提交它）
```

规则只有一条：

```
插件的 enabled = 块里写了就用块里的
              否则 = 插件清单里的 site.defaultEnabled（缺省 false）
```

`site.defaultEnabled` 为 `true` 的只有一种插件：**它就是升级前那个唯一可用的服务**
（历史上是 code-server）。那条标记存在的**全部理由**是「升级不改变现有站点的
行为」，而不是"这个插件比较重要"。于是：

- **一个块都没有**（老配置）→ 只开 code-server，**与升级前完全一致**；
- 写一个 `[plugin:sshd]` 块**不会**顺手把 code-server 关掉 —— 那正是最危险的那类
  静默改变（管理员只想开中转站，结果所有人的 IDE 没了）；
- 写一个 `[plugin:sshd]` 块也**不会**因为"块在那儿"就自动开启 sshd —— 那会让一句
  `default_cpus = 1` 在没有任何显式同意的情况下开出一条交互式 ssh 的路。
  **想开就写 `enabled = yes`。**

★ **新插件的清单里不要写 `site.defaultEnabled: true`。** 那等于给所有站点在升级时
静默多开一个能力。让站点自己写 `enabled = yes`。

### 一个插件都没装 / 一个都没开

**两种都是合法状态。** 守护进程照常启动，已有会话照常能查、能停 —— 只是没有可提交
的服务。`slurmate plugins` 与 `slurmate-sessiond --check` 都会照实说出来，并给出
插件安装目录的路径。

（v0.4 及以前，一个插件都没启用是一条**启动错误** —— 那等于把"框架"和"插件"绑死，
而按设计基座不该知道有没有插件。）

### 提交时的缺省插件

```ini
default_plugin = code-server
```

提交时的请求不带 `service_kind` 就用它。**留空 = 提交时必须显式指定**，否则
`2 missing_service_kind`。

★ 为什么**不**选"表里唯一那个"当缺省：隐式缺省会让**装一个插件 / 卸一个插件**这种
配置之外的动作悄悄改变行为 —— 今天提交成功的那条命令，明天可能落到另一个服务上。
这一层要的是可预测，所以缺省必须是你写下来的。

★ `default_plugin` 指向一个**没装的**插件是**启动错误**（不是等到用户提交才报错）：
那不是"本站没开某个服务"，而是"配置指向一个不存在的东西"。

### 块里认不出的键同样报错

写成 `defualt_cpus` 不能被静默忽略 ——「文件里写着，而实际什么也没发生」正是本项目
一路在清的那类问题。块名也一样：`[plugin:ssh]`（少个 d）在启动时就会报错并列出
本版认得的名字。

一个都开不了（全关掉）是**合法**的，但自检会说一句 —— 否则表现是"客户端一个按钮
都没有"，而配置文件里一个字都不像有问题。

**能写进块里的，是本站**装了的**那些插件。** 块名必须与某个已安装插件的短名
（清单里的 `name`）一致 —— 写一个没装的名字会在启动时报错并列出本站装了什么。

装了什么由 `<prefix>/share/slurmate/plugins/` 里的那些 `<ULID>.splug` 决定，
由安装器装进去：

```bash
sudo bash cluster/deploy.sh --plugins-src DIR     # 装 DIR 下的 .splug（成品包）
sudo /usr/local/sbin/slurmate-sessiond --check-plugins   # 看现在装了哪些
```

★ **加一个插件 = 放一个 `.splug` + 跑一次 `deploy.sh`**，不用改守护进程的源码。
契约见 [plugins/README.md](../plugins/README.md)。

**站点分发的插件**：`enabled = yes` 的插件，客户端连上之后会自己取回来
（v0.6）。所以这个开关现在有**第二个后果** —— 它不只决定"用户能不能提交它"，
还决定"要不要把它发到用户的工作站上"：

| `enabled` | 客户端会怎样 |
|---|---|
| `yes` | 取回文件 → 用户点一次同意 → 装上并激活（首次）；已在池里且对得上就跳过 |
| `no` | 站点**照常报**它（上面那条契约：报出全部插件），但**不取**。界面上它出现在"本站装了、但没开"那一栏 |

★ **这一点是刻意的，而且不影响已有的站点**：部署完不写任何 `[plugin:*]` 块时，
行为完全和以前一样（缺省取清单里的 `site.defaultEnabled`）。**是"开一个插件"这件事
本身意味着分发**，不是"装上就发"。

★ 客户端那两样本地设置（`~/.slurmate/config.json` 里的 `devPlugins` 开发者模式开关、
`trustedPlugins` 同意台账）**不在这个文件里** —— 它属于客户端的本地配置，
且**不对用户暴露**（界面上没有任何"打开配置文件"的入口，同意也是点出来的）。

★ **改了插件的内容就必须升版本号。** 同一个 `(id, 版本)` 只能对应一份内容：
客户端的池里那个槽位只有**一个**位置，内容是站点报的、摘要是客户端自己算的。
改了内容不升版本号，客户端的对账会说
「本机已有 X，但它的内容与站点现在报的不一样……请管理员升版本号之后重新部署」，
而**它不会覆盖**。

**怎么确认真的分发得出去**：装完看一眼守护进程自己解析到的文件清单。

```bash
sudo /usr/local/sbin/slurmate-sessiond --check-plugins
```

每一份文件都会列出来，单文件超上限、含符号链接的会打 ⚠（那不是故障，是
"这个插件分发不了"）—— 而**部署不会因此中止**：一个插件发不出去不该拦住整站。

### 格式上的三个约束

1. **值里不能出现 `#`** —— 行尾的 `# …` 会被当作注释切掉。路径、网段、时间都不含。
2. **同一个键写两遍是错误**，不是「后者覆盖前者」。写两遍说明作者对哪个生效有不同
   看法，而任何「取最后一个」的选择都会让其中一处永远不被执行。
3. **拼错的键是错误。** `validate()` 会明确报「配置里有无法识别的键」。静默忽略一个
   拼错的键，后果是「文件里写着，而实际什么也没发生」—— 这正是本项目一路在清的那类
   问题。这一条同时守住了 v0.2 删掉的那些键：老配置里的 `max_active_per_user` 之类
   不会静静地失效，而是会被拒绝。

---

## `cluster_cidr`

**只能写一个 CIDR**，登录节点与计算节点必须都在里面。

它被写进基础规则 `ip daddr != <cluster_cidr> accept`（`Nft.ensure()`），这是最后一道
几何约束：即使前面所有校验都被绕过，也影响不到本网段之外的流量。

### 为什么它没有默认值，以及为什么留空会拒绝启动

**这一项的失效方向是 fail-open，而且是本项目里最安静的一种失效。**

会话的 drop 规则追加在链尾，而链首那条基础规则会把**去往网段之外**的流量直接放行。
所以 CIDR 写窄（漏掉某个计算节点）时，去往那个节点的流量先被链首放行，会话规则永远
匹配不到 —— 而链的 policy 就是 `accept`。**没有报错、没有日志、没有任何迹象。**
用户看到的是「IDE 能连上」，而实际那条 drop 规则从没生效过。

所以自检**不替你猜一个**：它没有默认值，留空即拒绝启动。此前它的默认值是文档占位网段
`192.0.2.0/24`，也就是「照抄示例忘了改」与「配对了」的表现完全一样。

自检校验它的**形式**（此前只做第一件）：

| 检查 | 不满足时 |
|---|---|
| 地址部分是合法 IPv4 | 拒绝启动 |
| **前缀长度是 0–32 的整数** | 拒绝启动。`192.0.2.0/99` 在 nft 里是语法错误 |
| **前缀长度不为 0** | 拒绝启动。`ip daddr != 0.0.0.0/0` 恒为假，基础规则等于不存在 |
| **主机位为 0** | 拒绝启动并给出规范写法。`192.0.2.5/24` 在 nft 里语义含糊 |

> 📌 **这里刻意没有「拒绝 RFC 5737 文档网段」那一条**，虽然它看起来能一眼抓住
> 「照抄示例忘了改」。理由：那会**拒绝一个完全合法的配置** —— 用 `192.0.2.0/24`
> 的测试集群是存在的，而软件没有任何依据判定它不是真的。一个不许人填真实值的校验，
> 是软件的错，不是配置的错。它想防的那件事由下面的交叉核对覆盖，且报错更精确。

### 与 Slurm 的 `NodeAddr` 交叉核对 —— 内容对不对，只有这里能验

启动时（以及 `--check` 时）会拿 `scontrol show node -o` 的 `NodeAddr` 全集与 CIDR
求交，**发现节点落在网段外就拒绝启动**，并逐个点名。

这是唯一能发现「网段漏掉了一个节点」的地方，也是唯一能发现「填的是文档示例网段」的
地方 —— 两种情况的表现是同一种：去往那些节点的流量被链首放行，而链的 policy 是
`accept`。`NodeAddr` 写主机名（由 Slurm 解析）时无从判断，跳过而不是误报。

**取不到节点列表时不阻塞启动** —— 那多半是控制器抖动（`slurmctld` 重启、`munge`
抖动），而不是配置错了；因为一次查询失败就拒绝服务，会把一次瞬时抖动放大成一次停机。
但这是整个校验里唯一的缺口，所以那种情况下日志会说得重一点：它明确写出「本次**没有**
核对 cluster_cidr 是否覆盖全部计算节点，若这个网段是照抄文档示例填的，现在正是它会
被漏过去的时候」。

多网段集群目前无法表达 —— 这是本架构的已知边界，见
[DEPLOYMENT.md](./DEPLOYMENT.md) 前置条件。

## `readonly_paths`

**守护进程本身不读这一项。** 它只被 `deploy.sh` 用 `sed` 抽出来渲染 systemd 单元：

- 非空 → 生成 `ReadOnlyPaths=<值>`；
- 留空 → 整行被删掉，并打印警告「这会去掉『root 不写用户家目录』那层保护」。

写错的后果很直接：**守护进程会在一个不存在的路径上做只读挂载，systemd 直接拒绝
启动**。

为什么可以只读：守护进程**从不写**用户家目录 —— 口令由作业自己生成并写进 `0600` 的
会话文件，会话文件也由作业自己创建。root 身上因此没有「写用户文件」这条攻击面。

**改了这一项之后必须重新跑 `deploy.sh`**，否则守护进程读的是新配置、systemd 用的
还是旧单元。

## 端口池

| 键 | 说明 |
|---|---|
| `range_start` / `range_end` | 服务端口池。唯一的要求是：与集群上**其他端口管理系统**的区间完全不交 |
| `reserved_ranges` | 要避让的其他区间，格式 `起-止,起-止`，留空表示没有 |
| `candidates_per_session` | 每次提交分配的候选端口数 |

### 为什么端口池必须与其他区间不交

nftables 对**同 hook、同 priority 的跨表求值顺序没有保证**。两个表都匹配同一个
`dport` 时，谁先求值是未定义的。**集合不交**能让判决与顺序无关，这才是唯一确定的解法。

守护进程的 `Config.validate()` 与部署脚本的预检**都会断言不交**，重叠即拒绝启动 /
拒绝部署。

⚠️ **`reserved_ranges` 必须写成 `起-止`，不能写单个数字。** 写成
`reserved_ranges = 55000` 会被拒绝。

两处解析器（`Config` 与 `deploy.sh` 的预检）的规则**必须完全一致**：一个配置项有两套
解释，会产生「部署预检放行、服务起不来」或反过来的错配，而这类问题的排查成本极高。
改任何一处都要同步改另一处。

### 端口池要留多大

`active_ports()` 把每个活跃会话的**整个候选集**都算作已占用。所以粗略的下限是：

```
(池大小) >= (预期并发会话数) × candidates_per_session
```

不够分配时 `allocate_candidates()` 返回空列表，`op_submit` 返回 code 5 `no_port`，
客户端会退避后重试。

## `[plugin:code-server] auth_mode`

| 值 | 含义 |
|---|---|
| `password` | 作业自己生成一个随机口令（写进 `0600` 的会话文件），code-server 以 `--auth password` 启动；客户端自动完成登录，用户无感 |
| `none` | 以 `--auth none` 启动，保护完全依赖 nft ACL |

取值只能是这两个，否则拒绝启动。

### 为什么默认是 `password`，以及这个默认值为什么不该改

`nft` ACL 的 hook 点是**登录节点的 output 链**。它拦得住「登录节点上的其他用户连你的
端口」，拦不住「另一个作业恰好被调度到同一台计算节点之后直接 curl 你的端口」——
那条流量根本不经过登录节点。

这不是某个集群的配置问题，而是这个架构的固有边界：绝大多数集群的计算节点上没有任何
per-user 网络隔离（cgroup 没有 `net_cls`/`net_prio`，主机防火墙也不按 UID 区分），
而本机进程访问本机 IP 走的是 `lo`，通常被放行。

在采用本方案前，请自行确认你的计算节点上是否真的存在这样的隔离 —— 若没有，
`--auth none` 意味着同节点上任何人一个 `curl` 就完整拿到你的 IDE：你的终端、
你的文件读写权，全部以你的身份运行。共享家目录 `0700` 之类的保护恰好被绕过，
因为攻击者用的是你的身份。

作业模板的态度是配合而不是妥协：`auth_mode=password` 时**拿不到口令就拒绝启动
（`exit 23`）**，绝不静默降级为 `auth=none`。

## Slurm 命令、以及插件各自的 `bin`

### 五个 Slurm 命令：留空是推荐值

留空 = 运行时自动查找：**先查 `PATH`，再依次查**
`/usr/bin`、`/usr/local/bin`、`/opt/slurm/bin`、`/usr/sbin`、`/bin`、`/sbin`。

为什么要能自动查找：Slurm 的安装位置因集群而异 —— 发行版包在 `/usr/bin`，源码编译的
常在 `/opt/slurm/bin`。

> 📌 **这里此前是一句谎话，值得记一笔。** 配置注释写着「留空则用 `shutil.which` 查找」，
> 而代码里只有 `or "/usr/bin/sbatch"` 硬兜底，全文 `grep shutil` 零命中。后果是：
> Slurm 装在 `/opt/slurm/bin` 的集群照抄示例配置**直接起不来**，报的还是
> 「Slurm 命令不存在: /usr/bin/sbatch」—— 那句话把人引向「是不是没装 Slurm」，
> 而真正的原因是「装在别处、而配置里那句话说它会自己找」。
>
> 顺带一提，守护进程在 systemd 下运行，而 systemd 的 `PATH` 是固定的，与登录 shell
> 的 `PATH` 无关 —— 所以只靠 `which` 也不够，候选目录表是必需的。

### 五个命令的**存在性都要检查**

此前只查 `sbatch` / `scancel` / `scontrol`，而 `squeue`（`job_state` 的兜底查询）与
`sacctmgr`（账户与分区权限）可以是错路径而**启动通过**，运行时才失败 —— 那时报出来的
是「查不到作业」或「没有账户」，与真正的原因（路径写错）隔了好几层。现在五个全查，
且区分配置留空自动查找失败与显式指定的路径不存在两种情况。

### 插件块里的 `bin`

**code-server**：留空 = 先在本机 `PATH` 里找，找不到就退回惯例路径
`/usr/local/bin/code-server`。

**sshd**：留空 = **直接**用惯例路径 `/usr/sbin/sshd`，**不做 PATH 查找**。
两者不同是有理由的 —— 见下。

⚠️ 守护进程在**登录节点**上运行，而这两个程序都装在**计算节点**上。所以这里的
「找到」只是**推测**，找不到也不代表真的没有 —— 它没有也不能在计算节点上执行命令，
这是设计上必然的。

**两个插件的差别正在这里**：code-server 做 PATH 查找，而 sshd **不做**。理由不是
风格不一致，而是"登录节点上恰好有这个文件"对计算节点**不是证据** ——
`/usr/sbin/sshd` 在任何一台 Linux 上都存在，而它很可能不是计算节点上那个。
写错了由作业侧明确失败（`run.sbatch` 会 log 出「不存在或不可执行」），
而不是在这里猜一个看起来合理的路径。

`--check` 会把**每个插件**的解析结果与它的来源（配置指定 / 本机 PATH 中找到 /
惯例路径）一起打印出来，就是为了让这句推测与事实分得开。

---

## 二、不再是配置项的东西，以及为什么

v0.2 把下面这些从配置里收了回去，改成代码常量。它们的共同点是：
**只有一种正确取值，而配置项的存在本身就制造了取错的可能。**

| 收起的键 | 现在是 | 为什么 |
|---|---|---|
| `socket_path` | `SOCKET_PATH` | 与单元的 `RuntimeDirectory=` 是同一个事实 |
| `state_dir` / `db_path` / `rejected_dir` | `STATE_DIR` | 与 `StateDirectory=` 对应。在配置里改掉它，单元不会跟着改 —— 症状是状态目录凭空换了个地方、旧数据不见了，报错里没有一个字提到配置 |
| `log_dir` / `audit_log` | `LOG_DIR` | 与 `LogsDirectory=` 对应，同上 |
| `tick_seconds` / `startup_grace_seconds` | `TICK_SECONDS` / `STARTUP_GRACE_SECONDS` | 从没有人改过 |
| `default_time` / `max_time` / `suspect_after_seconds` / `orphan_after_seconds` / `reserved_ttl_seconds` / `submitted_ttl_seconds` / `released_keep_seconds` / `job_missing_confirm_ticks` | 各自的常量 | 同上。`max_time` 尤其：它现在由**分区的 `MaxTime`** 动态决定（见下） |
| `[renew] enabled` / `threshold_seconds` / `max_total_seconds` | 常量 | 同上 |
| `security.password_bytes` | `PASSWORD_BYTES` | 同上 |
| `[quota]` 全部 | 各自的常量 | 同上 |
| `service_kinds` | **已删除** | v0.3 起「站点开了哪些插件」由**有没有那个 `[plugin:*]` 块**表达，见上 |
| `code_server_bin` / `sshd_bin` | 各自的插件块里的 `bin` | 它们是**插件的**路径，不是站点事实 |
| `auth_mode` | `[plugin:code-server]` 块的 `auth_mode` | 同上：它是 code-server 的认证方式 |
| 默认资源（曾经是 `DEFAULT_CPUS`/`DEFAULT_MEM` 两个常量） | 每个插件块的 `default_cpus`/`default_mem` | 在 IDE 里跑语言服务器和在 shell 里跑 codex 不是一回事 —— 它是**插件的策略** |
| `job_script` / `jobs_dir` | `default_jobs_dir()` | 从守护进程**自身的安装位置**推导（`<prefix>/share/slurmate/jobs`）。里面是**每个插件一份** `<ULID>.sbatch` |
| `job_log_subdir` | `JOB_LOG_SUBDIR` | 与 `run.sbatch` 的约定，不是站点参数 |
| `[purpose:*]` 整节 | 已删除 | 见下 |

### `max_time` 为什么必须变成「按分区算」

作业的时间上限取**代码里的硬上限（7 天）与分区自己的 `MaxTime` 的较小者**，超出即截断
并在响应里带一个 `warning`。

理由是原来那个配置项会在管理员调整分区后**悄悄过期** —— 那时用户拿到的是「提交时才被
Slurm 拒绝」的错误，与真正的原因（配置里的副本过期了）隔着一层。分区上限是 Slurm 知道
的**事实**，不该有第二份。

### `[purpose:*]`（用途 → 分区）为什么整个删掉

「用途 → 分区」是**策略**，而 Slurm 已经知道**事实**。多抄一份就多一处会与实际分叉、
且分叉了没人会发现的地方。

现在客户端通过 `partitions` RPC 直接拿到分区列表（从 `scontrol show partition` 现查，
与该用户的 association 求交），选哪个分区：

- **用户指定了** → 校验权限，没权限就**拒绝**（fail-closed：他点了名，沉默地落到别处
  比拒绝更糟）；
- **没指定** → 从有权限的分区里**随机挑一个**，落点由 `session_view` 返回给界面显示。

> **随机挑的一个边界**：`allowed_partitions()` 查不到时返回 `PARTITIONS_UNKNOWN` 哨兵。
> 显式指定的路径继续 fail-closed；**缺省随机的路径退化为不带 `-p`**（交给 Slurm 的默认
> 分区）并在响应里带一个 warning —— 此时我们没有对权限做任何声明，而 Slurm 自己会用
> association 兜住。**这不是漏判，别把它「修」成拒绝**：拒绝会让一次 `sacctmgr` 抖动
> 变成所有用户都开不了会话，而这里没有任何安全损失。

### `gres` 从死配置变成真传递

`[purpose:*] gres` 此前**只用于展示、从不参与提交**（`op_submit` 完全从请求里的 `gpus`
推导）。现在 `gpus` 没给 → **完全省略** `--gres`（默认不占 GPU，而在不带 GRES 的分区上
写 `--gres=gpu:0` 会被 Slurm 拒绝）；给了 `N > 0` → `--gres=gpu:N`。

### 分区名大小写仍然无关地比较

Slurm 分区名**大小写敏感**，而 association 里的 `Partition` 字段由管理员手工填写，
实践中经常出现大小写与实际分区名不一致的情况。所以守护进程在权限校验时**统一按小写
比较**，避免把有权限的用户误判成没权限。

这不是冗余防御，不要删：删掉之后，那些 association 大小写写错的用户会表现为
「所有分区都不可用」，而守护进程侧不会报任何错（只会拒绝提交），极难排查。
`tools/check-cluster.sh` 会把 association 里写了、但实际不存在的分区逐个标成
`[MISMATCH]`。

---

## 启动自检清单

`Config.validate()` 在启动时逐条检查，**任何一条不满足都拒绝启动** —— 宁可不起，
也不要带病运行。可以用
`/usr/local/sbin/slurmate-sessiond --check --config=/etc/slurmate/slurmate.conf`
单独跑一遍（不需要 root，nft 相关项会诚实报 false 并提示）。

| 检查 | 不满足时 |
|---|---|
| 配置里没有无法识别的键 | 拼错的键会被静默忽略 |
| `port_start >= 1` 且 `<= port_end` | 端口区间起止非法 |
| 端口池与 `reserved_ranges` 不重叠 | 跨表行为不可预测 |
| `port_end <= 65535` | 端口区间上界越界 |
| `job_missing_confirm_ticks >= 1` | 连续确认机制被关掉 |
| `suspect_after < orphan_after` | 闪断窗口与孤儿判定重合 |
| `cluster_cidr` 四项校验全过 | 见上，全部 fail-open |
| **五个** Slurm 命令都能解析到 | 无法提交、查状态或查权限 |
| 每个插件块里的键都认得（块名、块内键） | 拼错的键/块名会被静默忽略 |
| 块里的 `enabled` 是 yes/no、`default_cpus` 在 1-64、`default_mem` 可解析 | 认不出时拒绝启动，**不回退默认值** |
| 至少有一个插件是开着的 | 客户端上一个按钮都不会有 |
| `[plugin:code-server] auth_mode ∈ {password, none}` | 无法决定 code-server 启动参数 |
| 数据库表结构是本版的 | 旧库的 `NOT NULL purpose` 列会让每次提交都以内部错误失败 |

> 📌 **这张表里没有「作业脚本存在」那一条**，虽然它在 v0.5 之前有过。
> 作业脚本现在是**一个插件一份**（`<prefix>/share/slurmate/jobs/<ULID>.sbatch`），
> 而一个插件**没有作业侧实现是合法状态**（装得上、看得见、提交不了）。
> `validate()` 没有警告通道，往里加一条就是「一个这样的插件让整个站点起不来」——
> 那连停掉正在跑的会话都做不到。它改走和 `plugin_problems` 同一条路：
> `--check` 打印 `⚠`、启动时记一条 `log.error`，**但不拦启动**。

此外 `main()` 还会做一次 **`cluster_cidr` × `NodeAddr` 交叉核对**，
`--check` 与守护进程启动**都会**因此拒绝（前者正是 systemd 的 `ExecStartPre`）。

### 数据库表结构那一项

v0.2 删掉了 `sessions.purpose` 列。SQLite 的 `CREATE TABLE IF NOT EXISTS`
**不会**改已存在的表，而那一列是 `NOT NULL` —— 旧库上的每一次提交都会以
`IntegrityError` 失败，被 `dispatch` 兜成 code 9「内部错误」，信息里没有一个字与数据库
有关。

所以启动时会明确拒绝，并给出修法：

```bash
rm -f /var/lib/slurmate-session/claims.db
```

**这个删除是安全的**：`claims.db` 记的是「这个 job_id 是我代表哪个 uid 提交的」，
丢了之后 `recover_from_rules()` 会从 nft 规则把它重建出来（标 `trust='recovered'`，
永不自动 `scancel`）。

### `--check` 还会打印

端口池、socket、数据库、作业脚本目录（以及**逐个插件**解析到 `<ULID>.sbatch` 的哪一份）、
集群网段、闪断/孤儿阈值、续期设置、认证方式、
**五个外部命令各自解析到的路径**、code-server 的路径与它的来源、分区表（含默认分区与
`MaxTime`）、`AccountingStorageEnforce` 是否含 `associations`（决定 `sbatch` 是否必须
带 `-A`）、nft 表是否存在，以及 `cluster_cidr` 交叉核对的结果。

打印的是**解析结果**而不是配置里写了什么：配置留空是推荐值，而留空之后究竟找没找到、
找到的是哪一个，只有这里说得清。

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

`deploy.sh` **不会覆盖已存在的 `/etc/slurmate/slurmate.conf`** —— 重复部署时覆盖等于把
站点的调优悄悄抹掉，而且故障要等下次重启守护进程才出现。要重置就手动删掉它再跑。
随仓库分发的版本在 `cluster/slurmate.conf.example`，可以拿它对比新增了哪些项。

`deploy.sh` 在装完之后会跑一次守护进程**自己的** `--check` 并据此决定是否启动服务 ——
所以「部署预检放行、守护进程起不来」这类两套解释器的错配不会发生。最常见的中止原因
就是 `cluster_cidr` 还没改成本集群的网段。

---

## 还想知道「有什么是坏的」

配置全部正确、自检全绿，不代表系统没有已知问题。**已核实的缺陷、从未实测过的
假设、以及结构性欠账**都记在 [KNOWN-ISSUES.md](KNOWN-ISSUES.md) ——
那是这个仓库唯一的账本，请不要在别处重新发现一遍。
