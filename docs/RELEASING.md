# 发布流程

本文写给发布者。范围是基座这一侧的三样产物：客户端、站点端与打包器。
插件包由插件项目自己发布，不在本文。

## 一次发布产出什么

| 产物 | 由谁产出 | 平台 |
|---|---|---|
| 客户端安装包（`.exe` / `.dmg` / `.AppImage` / `.deb` / `.zip`） | `release.yml` 的 `build` | Windows / macOS / Linux |
| `slurmate-site-<版本>.run` | `release.yml` 的 `site` | 任意 Linux |
| `slurmate-packer-<版本>.js`（文档嵌在里面） | `release.yml` 的 `site` | — |

客户端、站点端与打包器同一个版本、同一次发布。站点包与打包器的 sha256 打印在
`site` job 的 run summary 里；客户端安装包不另发校验值。

## 版本与 tag

协议版本是两段（`major.minor`），规则见 [CHANGELOG.md](../CHANGELOG.md) 顶部。

tag 里的是发布标识：正式版就是协议版本，预览版在它后面加 `-<后缀>`。它与
`cluster/slurmate-sessiond` 的 `RELEASE` 必须逐字相同（去掉开头的 `v`），
`release.yml` 判这一条。两个包名也用它，所以预览版与正式版不会同名。

| 类型 | tag | 例 |
|---|---|---|
| 正式版 | `v<版本>` | `v0.37` |
| 预览版 | `v<版本>-<后缀>` | `v0.37-rc1` |

同一个版本可以有多个预览版。两类 tag 都先落成一个 draft Release，审过再公开。

tag 必须打在 `main` 的历史里，`release.yml` 的 `guard` job 判这一条。

## 步骤

### 1. 确认要打 tag 的那个提交经过了绿的 PR

`checks.yml` 只在 PR 上跑五个 job（`sanitized` / `client` / `cluster` /
`conformance` / `lint`），合并之后不重跑。分支保护的 ruleset 要求走 PR 且这五个
required check 通过，所以 `main` 上的每个提交都来自一次绿过的 PR。

`guard` job 只验 tag 指向的提交是 `main` 的祖先，不查它绿没绿。它挡的是
"从别的分支打 tag"，挡不了"绕过 PR 直接推 `main` 再打 tag" —— 后者靠 ruleset。

构建只在打 tag 时自动跑一次。想在打 tag 之前先确认三个平台都装得上，手动运行
`build.yml`（Actions 页面 → Run workflow）：它只产出附件，不碰 Release。

### 2. 定版本

版本号由发布者点名。不发新版本时跳过本节。

两个号要分开改，它们回答的问题不同：协议版本回答"这两端能不能谈"，发布标识回答
"这是哪一次发出来的"。

协议版本（`x.y`）改两处：`cluster/slurmate` 与 `cluster/slurmate-sessiond`。
`docs/PROTOCOL.md` 的〈协议版本〉与 `SECURITY.md` 的「当前维护的版本」跟着改。

发布标识（预览版的后缀）改同样那两处的 `RELEASE`。正式版没有后缀，那时它与协议
版本逐字相同。

`client/package.json` 与 `client/package-lock.json` 的那个三段版本是派生的：
`VERSION` + `.0` + 后缀。它照样要改，但不是第三个号 —— 它是算出来的，`checks.yml`
断言它逐字等于那个派生值。

第三段固定是 `.0`，只为满足 npm 的语义化版本要求。界面、诊断与安装包文件名都用
两段。

`release.yml` 断言两个站点包名、客户端安装包文件名与 tag 逐字相同。

预览版之间只动发布标识，协议版本不动 —— 它们的协议一样。

还有一处没有检查器守着，要手改：本文与 `release.yml` 注释里的示例版本号。

### 3. 改发布记录

| 文件 | 改什么 |
|---|---|
| `CHANGELOG.md` | 当前版本那一节的「未发布」改成日期；升版本时按 Keep a Changelog 新开一节 |
| `SECURITY.md` | 「当前维护的版本」那一句 |

### 4. 提交并推送 `main`

```bash
git add -A
git commit -m "0.37：发布"
git push origin <分支>
```

开一个 PR，等五个 required check 变绿，合并。`main` 开了分支保护，直接推会被拒。

### 5. 打 tag

```bash
git tag v0.37          # 正式版
git tag v0.37-rc1      # 预览版
git push origin v0.37
```

tag 推上去之后 `release.yml` 开始跑。

### 6. 看五个 job

| job | 做什么 |
|---|---|
| `guard` | tag 必须在 `main` 的历史里 |
| `test` | 在 Linux 上跑一遍 `npm test` |
| `build` | 三个平台各打一次包（`electron-builder`），不重复跑测试 |
| `site` | 跑单文件包自测，打出 `.run` 与打包器（`make-packer.js` 把文档嵌进去），核对两个包名与 tag 逐字相同 |
| `publish` | 收集三样产物，开一个 draft Release |

`publish` 依赖前三个产物 job 与 `guard`；任何一个红了都不会有 draft Release。
三个平台只打各自的包，测试只在 Linux 上跑：客户端用例里有 POSIX 权限位与符号
链接，Windows 上本来就不成立。

### 7. 审 draft 并发布

打开 Releases 页面上的 draft，逐项确认：

- 客户端五个扩展名、站点包、打包器都在；
- release notes 由发布者手写；
- 预览版的 `prerelease` 已勾上；
- 点 Publish。

### 8. 发布之后

`SECURITY.md` 的「最近一个公开版本」改成这一版。预览版不算公开版本。

## 失败时

| 现象 | 原因 |
|---|---|
| `guard` 红 | tag 不在 `main` 的历史里 |
| 推 `main` 被拒 | 分支保护要求走 PR 并通过五个 required check |
| `site` 红，报发布标识 | tag 与 `cluster/slurmate-sessiond` 的 `RELEASE` 不逐字相同 |
| 没有 draft | `publish` 依赖的 job 里有红 |
| 少一个平台 | `build` 矩阵里那一格红了，看它的日志 |

## 产物未签名

Windows 首次运行会被 SmartScreen 拦一次，macOS 首次需要右键打开。消除这一步需要
代码签名证书，本项目没有。
