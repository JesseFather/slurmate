# 站点端

这个目录是站点管理员那一侧。装完之后它长这样：

```
/usr/local/sbin/slurmate-sessiond    root 守护进程
/usr/local/bin/slurmate              用户 CLI
/etc/slurmate/slurmate.conf          站点配置（主文件）
/etc/slurmate/slurmate.conf.d/       每个插件一份
```

交付给管理员的是一个文件：`slurmate-site-<版本>.run`（由 `cluster/make-run.sh`
从这一棵树打出来）。拷到控制节点上以 root 跑，它自带守护进程、命令行、作业模板、
systemd 单元、只读自检脚本与这几份文档。仓库里那一份 `cluster/install-base.sh`
是它的实现，两边的动词与开关逐字相同。

| 动词 | 做什么 |
|---|---|
| （不给） | 安装：按顺序走检查、安装、诊断三步。装过基座时自动按修复走（升级） |
| `--check` | 体检：装之前。环境与前置条件，然后是部署预检。不做任何改动 |
| `--doctor` | 诊断：装之后。文件、目录、单元、服务、数据逐项对账。不做任何改动 |
| `--repair` | 修复：只对装过的机器动手。只增不改，站点配置的取值与状态数据不动 |
| `--uninstall` | 卸载（`--purge-state` 连状态数据一起删） |
| `--rollback 目录` | 收尾一次没有走完的部署：恢复到运行前（崩溃/断电后用） |
| `--extract 目录` | 只解压出来看。不改动系统，也不需要 root |

`--extract` 是刻意留的出口：一个要以 root 跑的文件，读的人应当能先看清里面是什么。
脚本顶部那几条命令也能直接解压，与 `--extract` 做的是同一件事。

装完之后，服务的启停用 `slurmate service`，不必自己记 `systemctl`：

| 命令 | 做什么 |
|---|---|
| `slurmate service status` | 看它有没有在跑、版本、配置有没有未生效的改动。不需要 root |
| `slurmate service check` | 跑守护进程的配置自检，退出码原样透传 |
| `slurmate service start` | 自检 → 对齐派生物 → 启动 → 等它真的能应答 |
| `slurmate service stop` | 关机式：取消本站全部会话 → 停服务 → 删 nft 表 |
| `slurmate service restart` | 自检 → 排空 → 对齐派生物 → 重启 → 等它就绪并核对配置 |
| `slurmate service reload` | 自检 → 对齐派生物 → 热重载 → 等守护进程报出接受还是拒绝 |

`stop` 与 `restart` 不是一回事。`restart` 只换守护进程，作业、会话与 nft
规则都不动。`stop` 会先取消本站提交的 Slurm 作业（用户自己的作业不动），
再停服务、删表。

恢复开机与卸载用 `--uninstall`；状态数据与日志是数据，`stop` 不动它们。

安装、升级、修复、卸载都是一次事务：中途任何一个失败都恢复到运行前
（文件、配置、单元、开机自启、服务状态、nft 表），成功则连日志带旧副本
一起删掉，`/root` 下不留现场。被 kill -9 或断电打断的现场，下一次会先自动
收尾；也可以手工 `--rollback`。安装、升级、修复结束时默认重启一次（换掉的
是基座）；`--no-restart` 可跳过。

`reload` 覆盖主配置、`.d/*.conf`、插件树、作业模板与已织的作业脚本。二进制、
systemd 单元与 socket/状态路径仍然需要 `restart`。

插件的装、卸、对齐走热重载，连接一条都不断。重启与热重载之前都会先排空：
窗口内的新提交被拒（约 60 秒自动恢复），所以不会切断一次走到一半的提交。

装之前先读 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 的前置条件清单。每一条都注明
「不满足会怎样失败」，因为那些失败在界面上长得像别的东西。装完之后按
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) 改配置，出了事看下面那两份排障。

| 文档 | 什么时候看 |
|---|---|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 装之前先读。前置条件每条都注明「不满足会怎样失败」，然后是部署流程 |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | `slurmate.conf` 的每一个键。改配置之后要看它 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 会话与客户端出问题了（连不上、页面空白、登记卡住） |
| [docs/PLUGIN-TROUBLESHOOTING.md](docs/PLUGIN-TROUBLESHOOTING.md) | 插件出问题了（装不上、发不出去、用户那个按钮不见了） |
| [`tools/check-cluster.sh`](../tools/check-cluster.sh) | 部署之前跑一次的那个只读自检（脚本，不是文档）。`--check` 的第一屏就是它 |

> 两份排障分开，理由是「查的东西没有一样共用」。一份查 nft 规则、会话文件与作业日志。
> 另一份查站点上的插件树、安装记录与用户本机的同意台账，后者那几条还要 root。

> 两份的读者在这一侧是同一个人（装这个站点的人），所以分开的理由是症状域，不是读者。

这一侧不带、也不该带插件的名字。基座一个插件都不装是合法状态；插件是独立项目，
它们各有一份源码树，而基座两端都不依赖它们。

给插件作者看的东西在 [`packer/docs/`](../packer/docs/)。

这个目录里的文档随站点端分发。今天那一条路就是上面那个单文件包：它把
`cluster/README.md` 与 `cluster/docs/` 那四份一起带走，`--extract` 就能读。

将来进 deb 时装在 `/usr/share/doc/<包名>/`。站点自己的笔记不要写在那儿：那个位置
升级时会被覆盖，它属于 `/etc/slurmate/` 或站点自己的目录。
