# 站点端

**这个目录是站点管理员那一侧。** 装完之后它长这样：

```
/usr/local/sbin/slurmate-sessiond    root 守护进程
/usr/local/bin/slurmate              用户 CLI
/etc/slurmate/slurmate.conf          站点配置（主文件）
/etc/slurmate/slurmate.conf.d/       每个插件一份
```

**装之前先读 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 的前置条件清单** —— 每一条都
注明"不满足会怎样失败"，因为那些失败在界面上长得像别的东西。装完之后按
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) 改配置；出了事看下面那两份排障。

| 文档 | 什么时候看 |
|---|---|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | **装之前先读**。前置条件每条都注明"不满足会怎样失败"，然后是部署流程 |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | `slurmate.conf` 的每一个键。改配置之后要看它 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 会话与客户端出问题了（连不上、页面空白、登记卡住） |
| [docs/PLUGIN-TROUBLESHOOTING.md](docs/PLUGIN-TROUBLESHOOTING.md) | **插件**出问题了（装不上、发不出去、用户那个按钮不见了） |
| [`tools/check-cluster.sh`](../tools/check-cluster.sh) | 部署**之前**跑一次的那个只读自检（脚本，不是文档） |

> **两份排障分开，理由是"查的东西没有一样共用"。** 一份查 nft 规则、会话文件与
> 作业日志；另一份查站点上的插件树、安装记录与用户本机的同意台账 —— 后者那几条
> 还要 root。两份的读者在这一侧是**同一个人**（装这个站点的人），所以分开的理由
> 是**症状域**，不是读者。

**这一侧不带、也不该带插件的名字。** 基座**一个插件都不装是合法状态**；插件是
**独立项目**，它们各有一份源码树，而基座两端都不依赖它们。给插件作者看的东西在
[`packer/docs/`](../packer/docs/)。

**这个目录里的文档随站点端分发**（将来进 deb，装在 `/usr/share/doc/<包名>/`）。
站点自己的笔记**不要**写在那儿：那个位置升级时会被覆盖，它属于 `/etc/slurmate/`
或站点自己的目录。
