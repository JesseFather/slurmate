<img src="client/src/renderer/icon.svg" width="72" height="72" alt="">

# Slurmate

Slurmate 在 Slurm 集群上提供远程开发环境。
它把网络 ACL 的登记簿挂在作业上，不挂在 SSH 会话上，所以 SSH 闪断不会丢会话。

作业里跑什么由插件决定。插件是独立项目，基座仓库里一棵都不收录，两端都不带，
一个都不装也是正常状态。

---

## 当前状态

分两栏写，免得读者花时间之后才发现哪一段还没有完整实测过。

| 部分 | 状态 |
|---|---|
| 集群侧（守护进程 / CLI / 作业模板 / 部署脚本） | 代码完整。自测 1443 项、比对器自测 23 项全过，这 1443 项在一台完全没有 Slurm 的机器上同样全过（见 `cluster/test-sessiond-logic.py` 的文件头）。单文件包在一台真实的 Slurm 集群上装完过：守护进程在 systemd 下跑着，客户端连着它取到的是那台集群的真实数据 |
| 客户端（Electron） | 代码完整，测试 744 项全过。SSH 握手与 exec 通道都在真集群上走通过：专用密钥认证、固定 argv 的 RPC、主机密钥 TOFU 校验，以及那几项站点查询（分区、队列、节点、最近作业） |

提交之后那一段也在真站点上走过了（2026-10-17/18）：

- 提交会话：`sbatch` 真的起了作业；排队（Slurm `PENDING`）到运行的那一段也见过；
- 服务跑起来：`direct-tcpip` 端口转发打通，`http://127.0.0.1:18080/` 上的
  插件界面打开过，临时离开之后接得回来；
- 释放会话：作业被取消、nft 规则被拆掉；
- 站点分发插件：站点装包 → 客户端取回 → 同意 → 用起来，版本升级那一次也走过。

真机上已经确认的：常驻通道在登录节点上真的有一条常驻进程（接上站点之后
`pgrep -af 'slurmate stream'` 看得到），两台电脑的接管也按通了、目前功能正常。
仍然只有推断的是：没有界面的插件那条路，以及大包的响应上限余量。见
[client/README.md](client/README.md)，以及
[docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) 的〈没有完整实测过的〉一节。

这一切如实写在这里，而不是等读者自己发现。

---

## 它要解决什么

在计算节点上开一个远程开发环境需要一条命令，环境本身由插件提供：

```bash
ssh -L <端口>:<节点>:<端口> -t "srun ... <那个服务自己的启动命令>"
```

这条命令把三层生命周期绑死在一起：SSH 会话、srun 作业、浏览器页面。

| 现象 | 根因 |
|---|---|
| SSH 闪断后页面白屏、工作区要重新加载 | 作业挂在 SSH 会话上，会话一断作业就被杀 |
| 端口靠用户自己拟 | 没有分配器，只在冲突时被拒绝 |
| 多开打架 | 本地端口与远端端口都靠人记 |
| `Ctrl+W` 直接关掉整个页面 | 用浏览器打开，浏览器抢走了编辑器的快捷键 |

Slurmate 把作业变成唯一的生命周期锚点：

- 作业由集群上的 root 守护进程提交，不挂在任何人的 SSH 会话上
- 网络 ACL（nftables）按作业维护：作业活多久，保护就持续多久
- 隧道断了、换电脑、关掉客户端，都不影响作业与登记
- 客户端断线后有两级容忍：5 分钟判「闪断」，什么都不做；30 分钟才判「异常退出」
  并回收

---

## 架构

```
  客户端（用户的笔记本）
    │
    │  SSH：固定 argv 的 RPC（一行 JSON 进、一行 JSON 出）
    │     + direct-tcpip 端口转发
    ▼
  登录节点
    ├── slurmate-sessiond（root，systemd）   ← 按作业维护 nft ACL、判活、续期、释放
    ├── /run/slurmate-session/ctl.sock       ← CLI 与守护进程的通道（SO_PEERCRED 认证）
    └── 共享家目录（NFS 或同类）
          ~/.slurmate/sessions/job-<id>.json  ← 会话身份、隧道目标、口令、插件的附加字段
    ▼
  计算节点（由 Slurm 在分区内自动挑选，不写 -w）
    └── sbatch 作业 → 插件起的服务，绑在 <节点IP>:<端口>
```

核心是 nft 规则与作业一一对应，守护进程每 2 秒对账一次。

Slurm 说作业没了就拆规则。nft 规则被人删了也重建，例如 `systemctl reload nftables`
会 flush 整个 ruleset。

各组件的职责划分见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 目录结构

```
cluster/          集群侧（部署到登录节点）
  slurmate-sessiond        root 守护进程
  slurmate                 用户 CLI（也是客户端调用的 RPC 入口）
  run.sbatch               作业模板。仓库里的这一份不提交；安装器对每个插件用它
                           织一次，装到 <prefix>/share/slurmate/jobs/<ULID>.sbatch，
                           一个插件一份
  slurmate.conf.example    配置示例 —— 复制到 /etc/slurmate/slurmate.conf 再改
  install-base.sh          一键部署 / 卸载
  nft-compare.py           非干扰比对器（带自测）
  test-sessiond-logic.py   守护进程自测
client/           Electron 桌面客户端
packer/           插件作者的打包器（单文件、零依赖）。它跑在作者的机器上，产出
                   .splug；服务器上从头到尾没有源码树，install-base.sh 永不打包
docs/             README.md 是索引（按读者分三组）；其余：架构、部署、配置、协议、
                   插件规范与容器格式、排障、已知问题
tools/            check-cluster.sh（部署前环境自检）、check-sanitized.sh（CI 用）
  conformance/    三份实现共用的符合性向量（输入树 + 期望的包字节 + 坏包 + 签名夹具）
  fixtures/       测试夹具。`plugins/` 下是两套件共用的两棵插件树，只放
                   能力测试需要的那两棵
```

---

## 快速开始

### 跑起客户端

```bash
cd client
npm ci
npm start
```

客户端要连一个真实的站点才有东西可做。站点按
[`cluster/docs/DEPLOYMENT.md`](cluster/docs/DEPLOYMENT.md) 装好之后，在客户端的
连接列表里点「新建连接」填上登录节点、用户名与端口，把公钥交给站点管理员注册，
然后点「连接」。

客户端自己的测试不需要集群：`cd client && npm test` 会用测试后端跑完整套件
（见 [client/README.md](client/README.md) 的〈测试后端〉）。它不给用户用，
安装包里也不带。

> 插件作者还可以用插件页那颗「安装插件…」把一个 `.splug` 装上去，走的是与真站点上
> `slurmate plugin install` 同一条路，见 `client/README.md`。

> 那里的作业侧要一个 bash 4，而插件的依赖得装在这台机器上。起不来时日志里是它的
> 原话，不会拿别的东西顶替。

> 不要在 NFS/SMB 挂载的目录里跑 `npm ci`。`node_modules` 是几万个小文件，走网络
> 文件系统会慢到不可用。先把仓库克隆到本地磁盘。

### 部署到集群

先跑环境自检，它会在动手之前把不满足的条件列出来：

```bash
sudo bash tools/check-cluster.sh
```

然后按 [cluster/docs/DEPLOYMENT.md](cluster/docs/DEPLOYMENT.md) 走。部署前务必读那份
文档的前置条件清单：Slurmate 对集群形态有几个硬性要求（单一登录节点、登录与计算节点
同网段、共享家目录、root 有 Slurm operator 权限等），不满足时的失败方式往往很隐蔽。

```bash
sudo bash cluster/install-base.sh --check      # 只体检，不做任何改动
sudo bash cluster/install-base.sh              # 部署
```

---

## 设计原则

这个项目对「系统报告成功，而事情没成」有近乎偏执的关注。几乎每一处关键逻辑的注释里
都能看到它的影子。

- 部署脚本在部署前后各取一次 nftables 规则集结构化快照，剥掉本系统新增的表之后必须
  逐条一致。比对器有 23 项独立自测，因为它本身出错会给出假绿，而假绿比报错更危险。
  它甚至区分「文件真的没变」和「文件本来就不存在」，后者明确报告为未参与校验。
- 守护进程把「作业查不到」分成三态：查到了 / 确认不存在 / 问不到。把后两者合并，
  后果是 slurmctld 抖一次，所有活跃会话的 ACL 在一秒内全部消失、会话文件被删
  （再也无法重新登记），而作业还在跑。
- 客户端判定 web 登录成败时只看 cookie jar 里有没有那个 cookie，不看 HTTP 状态码。
  这不是某个插件的性质，是网页表单登录这一类协议的陷阱：口令错误时返回 200 且不带
  `Set-Cookie` 是常见形态（某些服务实测如此），`if (status === 200)` 会在口令错时
  报成功。所以这条判据留在基座，而端点 / 字段名 / cookie 名三条具体值由插件的清单自述。
- 每次剥离插件，都会顺手挖出几个既有缺陷，因为它们躲在「那个插件反正在这儿」的阴影里。
  今天未修的、未实测的、以及已经想清楚但还没动手的，全部记在
  [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)。那不是一份愿望清单：里面每一条都写清了
  后果与修法，一条离开它的唯一方式是修掉并附上一条能真的红的用例。
- 文档里每条约束都对应一个具体故障，而不是泛泛的「建议这样做」；指路一律按符号名，
  不写行号（理由见 [CONTRIBUTING.md](CONTRIBUTING.md)）。

给它贡献代码时要保持这条线：新增的检查必须能真的失败。一条永远通过的检查比没有检查
更糟。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 已知限制

除开头那一栏列出的"仍然只有推断"的那些之外：

- ACL 的固有边界：nft 规则的 hook 点是登录节点的 output 链，所以它拦得住「登录节点上
  的其他用户连你的端口」，但拦不住同节点共租户直接 curl。这就是认证方式由插件自己声明、
  而缺省不是免登录的原因，详见 [SECURITY.md](SECURITY.md)。
- ACL 规则的目标必须是一条真实的节点地址：判据取 Slurm 报的 `NodeAddr` 全集
  （`Nft.add_session_rule()`），拿不到那份集合时不判、只记一条。
- 产物未签名：Windows 首次运行会被 SmartScreen 拦，macOS 需要右键 →「打开」。
- 基座不带任何插件，两端都是。作业里能跑什么由插件决定，而插件是独立项目，
  基座里没有任何一个插件的名字。

  插件以一个包文件（`.splug`）分发。作者在自己的机器上用 [`packer/`](packer) 打包
  （服务器上从头到尾没有源码树），管理员把包装上去：`sudo slurmate plugin install <包>`，
  或 `sudo slurmate plugin install --from <放包的目录>` 整批对齐。

  装的时候会验签，并按 `id` 记住签名者（§6.4）。代价写在明处：服务器上没有源码可对照，
  管理员对「包里是什么」的信任来自 `packer inspect` 的输出，所以安装器会把包里有什么
  逐项打出来。
  - 客户端：插件只有站点分发这一条来路（连上之后自动取回来），落在
    `~/.slurmate/site-plugins/`。`~/.slurmate/plugins/` 那个目录不被读，因为让自己往里
    放一份那条路整类绕过同意闸（理由见 [SECURITY.md](SECURITY.md) 的〈逐插件同意〉）。
    里面已有的文件不删，客户端下一次启动会说一句它不生效了。
  - 集群侧：插件装在 `<prefix>/share/slurmate/plugins/`，一棵树加一份记录表
    （`<ULID>/` 与 `<ULID>.json`）。容器 `.splug` 只在「作者→站点」与「站点→客户端」
    这两段路上活着。

    安装器把它的作业侧逐插件编织成 `<prefix>/share/slurmate/jobs/<ULID>.sbatch`，
    一个插件一份。一份一个插件是刻意的：同处一份文件时，插件里任何一行不在函数里的
    代码都会在每一个作业里执行，不管用的是哪个插件。

  一个插件都不装是正常状态：基座照常启动、已有会话照常能查能停，只是没有可提交的服务。
  一个插件的包里没有 `job/start.sh` 也是合法状态：它装得上、看得见，但提交不了
  （守护进程报 `service_kind_no_job`，界面上那个按钮是灰的）。加一个插件 = 打一个包
  + 放进去 + 跑一次 `slurmate plugin install`，不用改基座的源码，客户端那一侧一步人工
  动作都不需要。契约见 [packer/docs/README.md](packer/docs/README.md)。
- 站点分发的插件要用户点一次同意。每个 (id + 版本 + 整目录摘要) 第一次都要在界面上
  同意一次，不同意就不激活。

  四条护栏是签名、钉公钥、逐插件同意、进程隔离；前三条都做了，第四条还欠着，
  `client/index.js` 仍然跑在主进程里，完整 Node 权限、没有沙箱。所以同意的内容不只是
  「用这个插件」，是「让这个站点的代码在这台机器上跑」，界面上就是这么写的。

  站点侧也会验签（规范 §6.4），但它证明的不是「这是谁发的」：钥匙是随包一起来的，
  能改包的人也能把钥匙一起换掉。逐条对账见 [SECURITY.md](SECURITY.md)。
- 客户端只用 SSH 公钥认证，不接受密码。私钥由客户端自己生成并保管（不读 `~/.ssh`），
  公钥需要用户手工注册到自己的账户里一次。这是刻意的：口令路径会引入保存明文口令、
  向第三方身份服务传口令这类问题，而公钥认证只需要一次性的人工步骤。
- 客户端不实现任何身份管理（改密码、设邮箱、查账户）。它从「账户已经配好了」开始。
  别的集群未必用同一套身份体系，把 IDM 交互做进客户端等于把通用工具绑死在一种部署上。
- `slurmate rpc` 一次一请求，每次调用都是一个完整的 SSH exec channel。稳定态下客户端
  每 90 秒开 3 个，这对单线程的守护进程是有压力的。根治要给 CLI 加 `--stream`
  （argv 仍是常量），尚未实现。
- 仓库里还有几个已核实的缺陷没修（F30 那一类）。它们都在
  [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) 里，每条写了位置、后果与修法，而编号是
  稳定的。按编号引用它们，不要在这里重新复述一遍，也请不要在别处重新发现一遍。

---

## 许可证

[Apache-2.0](LICENSE)

Copyright 2026 JesseFather（署名文件见 [NOTICE](NOTICE)，源文件头另有一份同款声明）。
