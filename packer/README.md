# slurmate-packer

**插件作者的打包器。** 单文件、零依赖（只用 `crypto` / `fs` / `path` /
`child_process`）—— 下载这个文件夹就能用：

```sh
node slurmate-packer.js init    path/to/your-plugin
git commit -am "铸一个 id"
node slurmate-packer.js build   path/to/your-plugin
node slurmate-packer.js inspect your-plugin-1.0.0.splug
```

产出的 `.splug` 发布到你的网站 / GitHub；站点管理员下载下来交给安装器。
**服务器上从头到尾没有源码树** —— 打包发生在你的机器上。

规范：`docs/PLUGIN-SPEC.md`（尤其 §2 身份、§3 包、**附录 A 容器格式**）。

## 四个动词

| 动词 | 做什么 |
|---|---|
| `init <目录>` | 树里没有 id 时铸一个 ULID，并**插入**写回 `plugin.json` |
| `build <目录> [--commit <ref>] [--out <文件>]` | 从一个**提交**打出一个 `.splug` |
| `verify <包> [--against <目录>[@<ref>]] [--expect-digest <hex>] [--expect-signer <指纹>]` | 逐份校字节、算摘要、验签；`--against` 顺带判 §3.6 |
| `inspect <包> [--json]` | 打出包里到底有什么 —— 拿它对着规范逐行核对 |

## ★ 为什么 `init` 与 `build` 是两条命令

铸 id 会弄脏源码树（§2.1 要求写回），而 §3.5 要求打包的输入是一个**干净的提交**。
一条命令做完两件事必然自相矛盾。所以 `init` 只铸 id、把树弄脏，然后**停下来
让你提交**。

## ★ 六条容易写错、这里刻意写对的地方

1. **不用 `git archive`。** 它会读 `.gitattributes` 的 `export-ignore` /
   `export-subst`，于是**包的负载能被仓库里一份属性文件改掉**。这里走
   `git ls-tree -r -z` + `git cat-file`。
2. **排序按 UTF-8 字节**（`Buffer.compare`），不是 JS 的 `<` —— 后者比的是
   UTF-16 码元，与非 BMP 字符的字节序**相反**，于是同一棵树在两台机器上算出两个
   摘要。（`cases/😀.txt` 与 `cases/￿.txt` 就是为这条准备的。）
3. **路径取自 `ls-tree`，不取自 `readdir`** —— macOS 的文件系统会把文件名做 NFD
   归一化，`readdir` 拿到的字节与 git 里存的不一样。
4. **大小写折叠是 ASCII-only** —— 全 Unicode 的 `toLowerCase()` 会把 `İ` 与 `i`
   折到一起，而"只差大小写"是一条**拒绝**规则。
5. **摘要一定自己排序**，不信记录表的次序 —— 一个手写的包可以把记录按任意次序
   排，而签名盖的是摘要。（这一条是**写错过**的：早先版本忘了排，用例当场抓住，
   而它的症状会是"签名验不过"，排查的人会去查钥匙。）
6. **输出不许落在自己的源码树里** —— 否则下一次打包时那个 `.splug` 会进负载，
   摘要每次都变。落在里面就直接拒绝，一个字节都不写。

## 测试

```sh
node packer/test-packer.mjs
```

46 条，不需要网络、不需要这个仓库处于任何特定提交状态（它自己造临时仓库）。
它顺带把**客户端那一份读方**（`client/src/main/plugin-package.js`）拉进来跑同一批
坏包 —— 三份实现里这两份都在 JS 里，让它们在同一批字节上给出同一个理由词，是
"三端一致"这条契约里最容易分家的一半。

## 它还没有的东西

**`sign` 还没有。** 签名的**格式**已经在规范里定死了（附录 A.3）、验签也已经在
两个读方里实现了（`verify` 能用、客户端那一份能用），但**铸钥匙与保管私钥**还没
写 —— 那与"客户端按 id 钉公钥"是同一段工作。在那之前：包可以不带签名（§4.1
允许），而带签名的包**验得动**，只是这个工具还造不出来。
