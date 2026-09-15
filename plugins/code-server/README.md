# code-server

浏览器里的 VS Code。作业里跑一个 `code-server`，客户端把它的页面装进窗口并自动登录。

这是一个**独立项目** —— 它是 Slurmate 的一个插件，但 Slurmate 不依赖它。
契约（目录形状、清单的每个键、作业侧钩子）见 [`../README.md`](../README.md)，
这里只讲**这个插件自己**的事。

```
code-server/
  plugin.json        清单
  client/index.js    自动登录（61 行）
  job/start.sh       作业侧（135 行）
```

---

## 站点侧

```ini
[plugin:code-server]
enabled      = yes          # 一个块都不写时，缺省取清单里的 defaultEnabled = true
default_cpus = 2            # 不写则取清单里的 2
default_mem  = 8G           # 不写则取清单里的 8G
bin          =              # 留空 = 按清单里的 bin 解析
auth_mode    = password     # 清单里声明的取值受限键
```

### ★ `auth_mode` 为什么缺省是 `password`

**它是这个架构里唯一一处实质保护的开关，不是"省事"的开关。**

Slurmate 的 nft ACL 挂在**登录节点**的 output 链上。它拦得住「登录节点上的其他
用户连你的端口」，但拦不住「另一个作业恰好被调度到同一台计算节点之后直接
`curl` 你的端口」—— 那条流量根本不经过登录节点。

而共享家目录上的 `0700` 这类保护**恰好被绕过**：攻击者用的是你的身份。

所以缺省是 `password`。改成 `none` 之前请先确认你的集群在计算节点上有 per-user
的网络隔离；没有的话，`none` 不是"简化部署"，是把会话公开。详见
[SECURITY.md](../../SECURITY.md)。

★ 作业侧**不会静默降级**：拿不到口令时它明确拒绝启动（`exit 23`），而不是退回
`auth=none` —— 静默降级恰好会移除唯一那层实质保护。

### `bin` 怎么解析

`bin.discovery` 是 `which`，所以守护进程会先在**登录节点**的 PATH 里找
`code-server`，找不到才用 `fallback`（`/usr/local/bin/code-server`）。

★ 注意这里的不对称：守护进程跑在**登录节点**上，而作业跑在**计算节点**上。
`which` 的结果只是**推测**。`--check` 会把它解析到了哪里如实打印出来，装完之后
值得看一眼。写错了只在作业启动时暴露（每个候选端口都在启动后立刻退出 →
`pick_port_and_start` 全部失败 → 写 `failed` 并 `exit 22`）。

---

## 客户端侧（`client/index.js`，61 行）

只有一件事：**自动登录**。

★ 建视图的代码**不在这里** —— 那块界面由**框架**按清单里的
`contributes.surface` 打开。这个分工意味着一个**没有客户端代码**的插件也能开界面，
因为开界面本来就不需要代码，只需要一句声明。

登录要往哪 POST、字段叫什么、看哪个 cookie，全部来自清单里的
`contributes.login`，**这个文件里一个都不写死**：

```json
"login": { "path": "/login", "field": "password", "cookie": "code-server-session" }
```

★ **判定成败只看 cookie jar，不看 HTTP 状态码。** code-server 4.135.0 实测：
**口令错误时返回的是 HTTP 200**，只是不带 `Set-Cookie`。所以
`if (status === 200) 成功` 这种写法会在口令错时报成功 —— 用户看到一个没人替他
登录的登录页，而客户端说"已自动登录"。

这条判据**留在框架里**（`client/src/main/weblogin.js`）：它不是 code-server 的
性质，是**网页表单登录这一类协议**的陷阱。所以 Jupyter 那一类插件将来也能自动
登录，而框架一个字都不知道 code-server 是什么。

### 与 code-server 的耦合面只有三个值

`/login` 端点、`password` 字段名、`code-server-session` cookie 名。

**code-server 升级如果改了其中任何一个，症状是「两个口令一致但就是登不上」**，
而客户端只会说"未拿到会话 cookie"。那时改的**不是框架代码**，是上面那三行 JSON。

---

## 作业侧（`job/start.sh`，135 行）

### 必须做的

`start_code_server <端口>`，返回 0 时把 pid 写进 `$SVC_PID`。

★ **不写 `$SVC_PID` 的后果**：心跳的存活门、`cleanup` 里的杀进程、主流程最后的
`wait` 三处都读它。作业会在"会话就绪"那一行**之后立刻结束** —— 用户看到的是一个
刚起来就没了的会话。

### 就绪判定：`/healthz`，带一个 HTTP 兜底

```
优先：GET /healthz 返回 2xx        → 就绪
兜底：GET / 能拿到任何 HTTP 状态码 → 再等 5 秒 → 就绪
超时：45 次循环（约 45 秒）        → 放弃该端口，换下一个候选
```

**为什么要兜底**：`/healthz` 是**这个插件**的端点，不是框架的。将来某个
code-server 版本改掉它，`if 只认 /healthz` 会让**所有**会话永远起不来 ——
而根因是一个端点改名。兜底判据（能拿到任何 HTTP 响应 = HTTP 服务起来了）不依赖
具体端点名，代价只是多等 5 秒。

★ 循环里每一轮都先 `kill -0` 查一次存活：端口被占时 code-server 会**立刻退出**，
不查的话要白等满 45 秒才发现。

### 环境净化（`_code_server_scrub_env`）

启动前 `unset` 掉 `CODE_SERVER_SESSION_SOCKET` / `VSCODE_IPC_HOOK_CLI` /
`VSCODE_CWD` 等一串变量。

**不做的后果**：环境里存在这些变量时，code-server 会去**附着到已有实例**而不是
启动一个新的，直接报 `not spawned with IPC` 然后退出。作业看起来"启动失败"，
但日志里只有一句语焉不详的 IPC 报错。

最容易踩到的方式：在某个已经开着的 code-server 集成终端里手工跑一次作业。

★ 它放在**起服务之前**，不是模板顶部：真正在乎这些变量的是即将被启动的那个
进程，而在它之前的一切（`scontrol`、`openssl`、`base64`）都与它们无关。

### 服务输出写到自己的文件

```
$LOCAL_LOG_DIR/code-server.log        ← nohup 重定向到这里
cleanup_code_server()                  ← 在宿主最后一行之后并进 $LOCAL_LOG
```

★ **不要**改成直接重定向到 `$LOCAL_LOG`。宿主按「`LOCAL_LOG` 的**行号**」决定
哪些行还没进 NFS，服务进程往中间插话会让那个水位**穿过去**，那些行永远进不了
NFS 日志 —— **而且没有任何地方会报错**。作业在计算节点上跑完之后，唯一能看到的
就是 NFS 那一份。

`cleanup_code_server` 在宿主的最后一行**之后**被调，所以它追加的东西天然落在水位
之后。挪到 `start_code_server` 里就**静默地进不了 NFS**。

只并**尾部 200 行**：IDE 的日志几十万行是常态，全量并进去会让补写撑爆 KillWait
窗口，而超时的后果是**墓碑写不下去**（会话要多等一个孤儿周期才被回收）。

---

## 计算节点上需要什么

| 命令 | 用在哪 | 缺了会怎样 |
|---|---|---|
| `code-server` | `start_code_server` | 每个候选端口都在启动后立刻退出 → 全部失败 → `exit 22` |
| `curl` | `/healthz` 与 HTTP 兜底 | 两个探测都拿不到结果 → **每个候选端口白等 45 秒** → 默认 6 个候选共约 4.5 分钟后全部失败 |

另外作业通用地需要 `mktemp`、`python3`、`ss` —— 那些是宿主的事，见
[`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md) 的前提条件第 6 节。
