# 发布流程

本文写给发布者。范围是基座：客户端与站点端。插件包由插件项目自己发布，不在本文。

## 一次发布产出什么

| 产物 | 由谁产出 | 平台 |
|---|---|---|
| 客户端安装包（`.exe` / `.dmg` / `.AppImage` / `.deb` / `.zip`） | `release.yml` 的 `build` | Windows / macOS / Linux |
| `slurmate-site-<版本>.run` | `release.yml` 的 `site` | 任意 Linux |
| `slurmate-packer-<版本>.js` | `release.yml` 的 `site` | — |

客户端、站点端与打包器同一个版本、同一次发布。站点包与打包器的 sha256 打印在
`site` job 的 run summary 里；客户端安装包不另发校验值。

## 版本与 tag

协议版本是两段（`major.minor`），规则见 [CHANGELOG.md](../CHANGELOG.md) 顶部。
tag 里的版本是协议版本，不是 `client/package.json` 那个三段的值。

| 类型 | tag | 例 |
|---|---|---|
| 正式版 | `v<版本>` | `v0.35` |
| 预览版 | `v<版本>-<后缀>` | `v0.35-rc1` |

同一个版本可以有多个预览版。两类 tag 都先落成一个 draft Release，审过再公开。

tag 必须打在 `main` 的历史里，`release.yml` 的 `guard` job 判这一条。

## 步骤

### 1. 确认 `main` 是绿的

`checks.yml` 在每次推 `main` 时跑检查器。`release.yml` 只跑客户端与站点包自己的
测试，不重复那一套，所以发布的前提是 tag 指向一个已经绿过的 `main` 提交。

### 2. 定版本

版本号由发布者点名。不发新版本时跳过本节。

升版本要改四处：`client/package.json`、`client/package-lock.json`、
`cluster/slurmate`、`cluster/slurmate-sessiond`。`docs/PROTOCOL.md` 的〈当前版本〉
跟着改；`checks.yml` 断言这几处一致。

### 3. 改发布记录

| 文件 | 改什么 |
|---|---|
| `CHANGELOG.md` | 当前版本那一节的「未发布」改成日期；升版本时按 Keep a Changelog 新开一节 |
| `SECURITY.md` | 「当前维护的版本」那一句 |

### 4. 提交并推送 `main`

```bash
git add -A
git commit -m "0.35：发布"
git push origin main
```

等 `checks` 这一轮变绿。

### 5. 打 tag

```bash
git tag v0.35          # 正式版
git tag v0.35-rc1      # 预览版
git push origin v0.35
```

tag 推上去之后 `release.yml` 开始跑。

### 6. 看三个 job

| job | 做什么 |
|---|---|
| `guard` | tag 必须在 `main` 的历史里 |
| `build` | 三个平台各跑一遍 `npm test`，然后 `electron-builder` |
| `site` | 跑单文件包自测，打出 `.run` 与打包器，核对包名里的版本与 tag |

`publish` 依赖这三个 job；任何一个红了都不会有 draft Release。

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
| `site` 红，报版本段 | tag 与 `cluster/slurmate-sessiond` 的 `VERSION` 不一致 |
| 没有 draft | `publish` 依赖的 job 里有红 |
| 少一个平台 | `build` 矩阵里那一格红了，看它的日志 |

## 产物未签名

Windows 首次运行会被 SmartScreen 拦一次，macOS 首次需要右键打开。消除这一步需要
代码签名证书，本项目没有。
