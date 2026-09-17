# 文档索引

按**你是谁**分三组。同一份文档可能出现在不止一组里 —— 那说明它确实有不止一种读者，
不是重复。

根目录的 [README](../README.md) 讲这个项目**是什么、现在能用到什么程度**；
[CONTRIBUTING.md](../CONTRIBUTING.md) 讲**怎么改它**（提交信息、检查必须能真的失败、
不写行号、脱敏）。

---

## 你要装一个站点（管理员）

按这个顺序读就够了：先看能不能装，再装，装完出问题再看排障。

| 文档 | 什么时候看 |
|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | **装之前先读**。前置条件每条都注明"不满足会怎样失败"，然后是部署流程 |
| [CONFIGURATION.md](CONFIGURATION.md) | `slurmate.conf` 的每一个键。改配置之后要看它 |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | 会话与客户端出问题了（连不上、页面空白、登记卡住） |
| [PLUGIN-TROUBLESHOOTING.md](PLUGIN-TROUBLESHOOTING.md) | **插件**出问题了（装不上、发不出去、用户那个按钮不见了） |
| [`tools/check-cluster.sh`](../tools/check-cluster.sh) | 部署**之前**跑一次的那个只读自检（脚本，不是文档） |

> ★ **排障那两份是刻意分开的**：一份的读者是**会话使用者**，另一份是**装插件的人**
> 与**被分发的用户**。两边都会问到「`slurmate rpc` 没反应」这一类问题，但没有一样
> 东西是共用的 —— 一边查 nft 规则、会话文件与作业日志，另一边查站点上的包、
> 安装记录与用户本机的同意台账；能修它们的人也不是同一个人。

## 你要写一个插件（作者）

| 文档 | 是什么 |
|---|---|
| [PLUGIN-SPEC.md](PLUGIN-SPEC.md) | **契约**。身份、版本号、包、签名、基座保证什么。**它可以被单独带到你自己的仓库里去** |
| [PLUGIN-CONTAINER.md](PLUGIN-CONTAINER.md) | **规范性**的容器格式（字节布局、签名块、读方必须拒绝什么）。它是那份规范的**附录 A**，**要一起带走** |
| [PLUGIN-TROUBLESHOOTING.md](PLUGIN-TROUBLESHOOTING.md) | 装不上、被拒、用户看不到那些症状的症状表 |
| [`plugins/README.md`](../plugins/README.md) | 怎么做（目录形状、清单的每个键、作业侧钩子、打包那几条命令） |
| [`packer/README.md`](../packer/README.md) | 打包器的每个动词 |

> ★ **规范与 README 的分工**：规范讲**什么是不合规的**（一条要求 = 一条"改坏了就会
> 红"的用例），README 讲**怎么做**。两份都说同一件事的时候，以规范为准。

## 你要读代码、改基座、或者另写一个客户端（实现者与维护者）

| 文档 | 是什么 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 为什么是这个形状：五个组件、状态机、nft 规则、信任模型、对账与自愈 |
| [PROTOCOL.md](PROTOCOL.md) | **契约**：传输、信封、错误码、三态区分、每个 op |
| [IMPLEMENTING.md](IMPLEMENTING.md) | 写一个新后端 / 换一门语言的**清单**，每一条对应一个具体的静默失败 |
| [PLUGIN-CONTAINER.md](PLUGIN-CONTAINER.md) | 要读包就得看它（A.4 那张"读方必须拒绝的东西"的次序表是三份实现共用的） |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | **账本**：已核实的缺陷、从未实测过的、结构性欠账 |
| [../SECURITY.md](../SECURITY.md) | 威胁模型、四条护栏的逐条对账、不在威胁模型内的东西 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | 提交信息怎么写、文档为什么不许写行号、脱敏约定 |

---

## 还有几份 README 在它们自己的目录里

它们的读者就是那个目录的读者，所以没有搬进来：

| 在哪 | 讲什么 |
|---|---|
| [`client/README.md`](../client/README.md) | 客户端：认证模型、演示模式与那些调试开关、打包、代码结构，以及**四条不要改坏的约束** |
| [`plugins/README.md`](../plugins/README.md) | 插件怎么做（目录形状、清单每个键、作业侧钩子、打包命令） |
| [`packer/README.md`](../packer/README.md) | 打包器的每个动词（`init` / `keygen` / `build` / `sign` / `verify` / `inspect`） |
| [`tools/conformance/README.md`](../tools/conformance/README.md) | 三份实现在同一批字节上的对账（输入树、期望的包字节、坏包、签名夹具） |

---

## ★ 想知道"有什么是坏的" —— 只有一处

**已核实的缺陷、从未实测过的假设、以及结构性欠账，全在
[KNOWN-ISSUES.md](KNOWN-ISSUES.md) 里。** 那是这个仓库**唯一的账本**，一条离开它的
唯一方式是**修掉它，并附上一条能真的红的用例**。

★ **它不是一份愿望清单**：每一条都写了位置、后果与修法。

★ **按编号（`F12` / `U7` / `S2` …）引用，不要把条目复述到别处。** 编号是稳定的，
复述不是 —— 同一件事写两遍，第二遍先漂，而**漂了不会红任何东西**。这条纪律适用于
本目录下的每一份文档，包括这一份。
