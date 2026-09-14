# Slurmate 桌面客户端

把集群上的 code-server 包装成一个桌面应用。解决五件事：

1. **浏览器抢快捷键** —— Ctrl+W 不会再关掉页面
2. **端口靠用户自己拟** —— 服务端口由集群侧自动分配
3. **多开打架** —— 单实例锁 + 会话槽位
4. **SSH 闪断杀死会话** —— 作业挂在 Slurm 上而不是 SSH 会话上，断线不掉
5. **首次连接摩擦** —— 地址自动探测，不用回答八个问题

---

## ⚠️ 当前状态：骨架 + 演示后端

**真实 SSH 后端尚未实现。** `src/main/backend-ssh.js` 里 `isImplemented()` 返回 `false`，
所以应用会用**演示后端**启动，并在界面三处标注「演示模式 · 未连接集群」。

演示后端**不是空壳**：它包含一个真的本地 HTTP 服务，复刻了 code-server 的登录契约，
并且真的走一遍隧道代码。所以下面这些路径是真的在跑：

- 会话状态机（提交 → 排队 → 登记 → 运行 → 释放）
- 本地端口槽位绑定与占用回退
- 隧道中继（真的 TCP 转发，真的只监听 127.0.0.1）
- 登录契约（`POST /login` + cookie jar 判定）
- 快捷键接管与诊断

**唯一被假掉的是 SSH 那一跳。**

---

## 跑起来

```bash
npm install
npm start          # 若 SSH 后端未实现，会自动进演示模式并标注
npm run demo       # 强制演示模式
npm test           # 全部测试，不需要 Electron 运行时
```

`npm install` 会下载 Electron 二进制（约 100–150 MB）。国内网络慢的话可以先设镜像：

```bash
npm config set ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/
```

> **不要把 `node_modules/` 放在网络共享盘上**（比如 NAS 的 SMB 挂载）。
> 文件多且路径长，Windows 上会非常慢甚至失败。请把仓库克隆到本地磁盘再 `npm install`。

> ⚠️ **`npm test` 里的 `node --test` 不能加路径参数。**
> Node 18 容忍 `node --test test/`（把目录当扫描起点），**Node 22 不再容忍** ——
> 它会把这个参数当成 glob 模式，解析不到就报 `Cannot find module .../test`。
> 而 CI 用的是 Node 22，本地是 18，所以这行在本地永远测不出问题。
> 不带参数时靠的是官方默认模式 `**/test/**/*.{cjs,mjs,js}`，18 和 22 都支持，
> 且会自动排除 `node_modules/`。

### 怎么验证快捷键接管

演示模式下启动一个会话，会打到一个**按键回显页**：

| 按什么 | 期望 |
|---|---|
| `Ctrl+W` | **出现在左栏**（到达页面，由 code-server 处理「关闭编辑器」） |
| `Ctrl+N` / `F5` | **出现在左栏** |
| `Ctrl+Shift+I` / `F12` / `F11` | **出现在右栏**（被外壳吞掉，不打开开发者工具/全屏） |
| 中文输入法打拼音 | **两栏都不出现**（组合期间必须放行给输入法，否则输入法会被吃掉） |

左右两栏对照就是判定依据。

### 演示调试

演示模式下面板底部有四个开关，用来造出真集群上极难复现的状态：

- **模拟守护进程挂掉** —— 验证客户端**不会**因此判定会话结束
- **模拟隧道断开** —— 验证遮罩出现、重连提示、恢复后焦点回到编辑器
- **模拟会话被回收** —— 验证「作业被 scancel 了」这条路径
- **复位**

---

## 打包

```bash
npx electron-builder --publish never
```

产物在 `dist/`。三平台配置见 `electron-builder.yml`。

CI 在**仓库根目录**的 `.github/workflows/build.yml` —— 不是本目录。
（GitHub Actions 只读仓库根的 `.github/workflows/`，放在 `client/` 下永远不会被触发。）
workflow 里所有步骤都带 `working-directory: client`，推 `v*` tag 会把三平台产物挂到
draft Release 上。

**产物未签名：**

- **Windows**：SmartScreen 首次会拦，选「更多信息 → 仍要运行」
- **macOS**：Gatekeeper 会拦。右键 →「打开」，或
  `xattr -dr com.apple.quarantine /Applications/Slurmate.app`
- **Linux**：AppImage 需要 `chmod +x`

要消除这些提示需要代码签名证书（Windows 的 EV 证书 / Apple 开发者账号）。

---

## 代码结构

```
src/main/
  index.js         入口：单实例锁、生命周期、IPC、登录编排
  config.js        配置 + safeStorage 口令 + 槽位端口持久化
  hosts.js         登录节点地址表 + 并发探测（读 SSH banner 校验）
  classify.js      RPC 结果 → 客户端可行动作（纯函数，最容易写错的地方）
  login.js         code-server 登录契约的常量与判定（纯函数）
  backend.js       后端接口 + 选择器
  backend-ssh.js   真实后端（**未实现**，含实现时必须遵守的约束）
  backend-fake.js  演示后端
  demo-server.js   演示用的假 code-server（纯 Node，可脱离 Electron 测）
  session.js       会话状态机 + 心跳
  tunnel.js        槽位中继 + 直连通道
  shortcuts.js     最小菜单 + 按键黑名单
  windows.js       BrowserWindow + WebContentsView
src/preload/       contextIsolation 下的三个桥（面板 / 遮罩 / 演示页）
src/renderer/      面板、状态条、遮罩
src/demo/          演示后端服务的两个页面
test/              classify / contract / config / integration
```

### 三条不要改坏的约束

改动 `src/main/` 时，下面每一条都对应一个具体的、在真实环境里表现为「一切正常但就是没保护」的故障：

1. **隧道目标只从 `tunnel_target` 解析，且必须是字面 IPv4。**
   禁止重新解析节点名 —— 解析结果与集群侧写进 nft 规则的 `ip daddr` 不一致时，
   ACL 会静默失效。见 `tunnel.js` 的 `parseTarget`。

2. **登录成败只看 cookie jar，不看 HTTP 状态码。**
   code-server 在口令错误时返回的是 **200**，只是没有 `Set-Cookie`。
   `if (status === 200)` 会在口令错时报成功。见 `login.js`。

3. **`goodbye` 返回 `ok:true` 不代表作业被取消了。**
   集群侧的 `op_goodbye` 丢弃了 `scancel` 的返回值，`phase_release` 也不确认作业是否
   真的没了。所以界面把「正在释放」和「已结束」当成两个状态。见 `session.js` 的 `stop()`。

---

## 集群侧契约（客户端依赖的部分）

`slurmate rpc`：从 stdin 读一行 JSON，向 stdout 写一行 JSON，然后退出。**一次一请求。**

```
ssh -T -p 10100 user@<登录节点> -- /usr/local/bin/slurmate rpc
```

请求体走 stdin，所以命令行是编译期常量 —— 这既是防注入，也是穿过登录节点上
`codeserver-guard`（`ForceCommand`）的必要条件：命令串里不能出现 `code-server` 字面量。

响应形如 `{"ok":…, "code":…, "data":{…}, "error":{"kind":…,"detail":…}}`，错误码：
`2` 客户端 bug / `3` 会话不存在 / `4` 配额权限 / `5` 守护进程不可达或端口池空 /
`6` Slurm 失败 / `7` 限流 / `9` 内部异常。

> **`code:5` 有两种含义，必须靠 `error.kind` 区分**：`daemon_unreachable` 是
> 「守护进程挂了」（要重试，且绝不能判定会话结束），`no_port` 是「端口池满了」（等一下）。
> 见 `classify.js`。

心跳：客户端经 unix socket 定期发 `heartbeat`。守护进程判活**只看这个**，
不读作业写的 `.jobhb` 文件。停发 300 秒判定 `suspect`，1800 秒判定 `orphaned` 并 scancel。
