#!/bin/bash
# ==============================================================================
#  check-sanitized.sh — 脱敏回归检查（CI 用）
# ==============================================================================
#
#  这个仓库是公开的，且发布前做过一次脱敏（把真实站点的 IP、域名、用户名、
#  邮箱全部换成了 RFC 5737 文档地址与通用占位符）。
#
#  本脚本的作用是【防止真实值回流】—— 某次提交不小心贴进来一个真实 IP，
#  公开之后就是既成事实，改回来也收不回。
#
#  ── 为什么这里没有"真实值清单" ─────────────────────────────────────────────
#  最直接的写法是列一份真实值 denylist 然后 grep。**但那份清单本身不能进仓库**
#  —— 它等于把要藏的东西原样写在了公开的地方。
#
#  所以这里换一种表达：不列"什么不能出现"，而是规定"什么东西长什么样才允许
#  出现"。规则用不泄露的方式表述，且对当前仓库零误报。
#
#  另有一份带真实值的本地检查在 local/check-real-values.sh（gitignored），
#  那个是给维护者本机用的，两种检查互补。
#
#  用法：bash tools/check-sanitized.sh
#  退出码：0 = 干净，1 = 有命中，2 = 检查本身没跑成
# ==============================================================================

#
#  --selftest  反向验证：真的种进几份"应当被抓住"的内容，确认检查会红。
#              一条永远通过的检查比没有检查更糟 —— 它给人虚假的安心。
#              见文件末尾的实现说明。
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

FAILED=0

if [[ "${1:-}" == "--selftest" ]]; then
    exec "$REPO_ROOT/tools/self-test-sanitized.sh"
fi

# 扫【已跟踪 + 未跟踪但未被忽略】的文件。
#
# 为什么必须带上未跟踪的：只用 `git ls-files`（仅已跟踪）的话，一个刚写好、
# 还没 `git add` 的新文件完全不在扫描范围内 —— 而那恰恰是最危险的时刻：
# 新写的文件里贴了一个真实地址，检查说"通过"，人就放心地 add 了。
# `-co --exclude-standard` 同时取 cached 与 others，并尊重 .gitignore
# （所以 node_modules/ 与 local/ 自然被排除）。
FILES="$(git ls-files -co --exclude-standard 2>/dev/null \
    | grep -vE 'package-lock\.json$|\.min\.(js|css)$' || true)"

if [[ -z "$FILES" ]]; then
    echo "错误：git ls-files 返回空 —— 检查没有对象可查，不能当作通过。" >&2
    exit 2
fi

n_files="$(printf '%s\n' "$FILES" | wc -l)"
echo "扫描 ${n_files} 个文件（已跟踪 + 未跟踪、未被忽略）"
echo

scan() {
    local title="$1" pattern="$2" hint="$3"
    local hits
    hits="$(printf '%s\n' "$FILES" | tr '\n' '\0' \
        | xargs -0 grep -InE "$pattern" 2>/dev/null || true)"
    if [[ -n "$hits" ]]; then
        echo "✗ ${title}"
        printf '%s\n' "$hits" | sed -E 's/^(.{150}).*/\1…/' | sed 's/^/    /'
        echo "    → ${hint}"
        echo
        FAILED=1
    else
        echo "✓ ${title}"
    fi
}

# ── 1. 私有网段 IPv4 ────────────────────────────────────────────────────────
# 公开项目里的示例地址应当用 RFC 5737 的文档网段（192.0.2.0/24、
# 198.51.100.0/24、203.0.113.0/24）。真实集群地址几乎总是私有网段，
# 所以"一律不许出现私有网段"是一条零误报、且能抓住绝大多数回流的规则。
scan "无私网 IPv4（10/8、172.16/12、192.168/16）" \
     '\b(10\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]{1,3}\.[0-9]{1,3}\b' \
     "示例地址请改用 192.0.2.x / 198.51.100.x / 203.0.113.x（RFC 5737）"

# ── 2. 内网域名后缀 ─────────────────────────────────────────────────────────
# 模式里有两处约束，都是为了压掉误报；写松了会让这条检查变成噪音，
# 而一条总在误报的检查等于没有检查 —— 大家会习惯性忽略它。
#
#   1. `.local` 前面必须有主机名成分（[a-z0-9-]+），且前面那个字符不能是斜杠。
#      这样放过 `~/.local/share` 这类路径。
#   2. `.local` 后面不能紧跟字母数字或点（大小写字母都算）。
#      这样放过 `settings.local.json` 这类文件名，以及 `snap.localPort`、
#      `x.localStorage` 这类 camelCase 属性名 —— 后者在 JS 里极常见，
#      漏掉大写字母会让这条检查满屏误报。
#
# 只查 .local 一个后缀就够 —— .local 是 mDNS 与 FreeIPA 的默认域，
# 真实站点里最常见。.internal / .corp 收益不大，却会误伤
# `obj.internal` 这类普通属性名，所以不收。
scan "无 .local 内网域名" \
     '[a-z0-9][a-z0-9-]*\.local([^A-Za-z0-9.]|$)' \
     "内网域名请改用 example.com / example.net（RFC 2606）"

scan "无 .cn 域名" \
     '[a-z0-9][a-z0-9-]*\.(cn|com\.cn|net\.cn|org\.cn)\b' \
     "若确为项目自身的公开域名可忽略，否则请改用 example.com"

# ── 3. 邮箱 ─────────────────────────────────────────────────────────────────
# 先抓出全部邮箱，再排掉允许的那两类。
# 不用负向先行断言 —— POSIX 的 grep -E 不支持 (?!...)，
# 写了它不会报错，只会永远匹配不上，于是这条检查【永远通过】。
# 那是这个仓库最忌讳的一类东西：看起来在检查，实际什么都没查。
# 允许两类：
#   - 项目维护者的 GitHub noreply 地址
#   - example.com/net/org 及其任意子域（RFC 2606 保留，永远不可能是真实身份）
# 注意要允许子域：文档里的示例地址形如 alice@node01.example.com，
# 只放行 `@example.com` 本身会把它们全部误报。
ALLOWED_EMAIL='@users\.noreply\.github\.com$|@([A-Za-z0-9-]+\.)*example\.(com|net|org)$'
email_hits="$(printf '%s\n' "$FILES" | tr '\n' '\0' \
    | xargs -0 grep -InoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' 2>/dev/null \
    | grep -vE "$ALLOWED_EMAIL" || true)"
if [[ -n "$email_hits" ]]; then
    echo "✗ 无第三方邮箱（只允许项目维护者与 example.com）"
    printf '%s\n' "$email_hits" | sed -E 's/^(.{150}).*/\1…/' | sed 's/^/    /'
    echo "    → 个人邮箱会把真实身份带进公开历史；请改用 GitHub noreply 地址"
    echo
    FAILED=1
else
    echo "✓ 无第三方邮箱（只允许项目维护者与 example.com）"
fi

# ── 4. 凭据特征 ─────────────────────────────────────────────────────────────
#
# 「无私钥」这条规则原先只匹配 `BEGIN [A-Z ]*PRIVATE KEY`，也就是**连 PEM 头
# 文本本身**都算命中。在仓库开始**生成**密钥之后这变成了误报：
# client/src/main/keys.js 必须写出这个常量（它是编码器），测试里也有故意构造的
# 无效夹具。一条总在误报的检查等于没有检查 —— 大家会习惯性忽略它。
#
# 但**放宽的方式不能是"少查一点"**，而是让规则表达它真正想表达的东西：
# 私钥的**材料**，而不只是一个标题。所以拆成三条，覆盖三种真实的泄漏形态：
#
#   A 整行就是一个 PEM 头      → 一个真的 .pem/.txt/.env 文件
#   B 头后面直接跟着长 base64  → 单行字符串里塞了一把（\n 转义形式）
#   C 文件里有 PEM 头，且某行是**纯 base64** → 多行模板字符串里塞了一把
#
# 三种之外还漏不掉什么：任何真实的私钥都必然带着它的 base64 主体，
# 而主体必然落在这三条的某一条里。tools/check-sanitized.sh --selftest
# 会真的种进三种形态各一份，验证它们都被抓住 —— 这条规则被改松时它就会红。
scan "无私钥（A 整行 PEM 头）" \
     '^[[:space:]]*-+BEGIN [A-Z ]*PRIVATE KEY-+[[:space:]]*$' \
     "私钥绝不能进仓库；即使已吊销，也不该出现在公开历史里"

scan "无私钥（B 单行内嵌）" \
     'BEGIN [A-Z ]*PRIVATE KEY-----\\n?[A-Za-z0-9+/]{60,}' \
     "私钥绝不能进仓库；即使已吊销，也不该出现在公开历史里"

# C：两段式 —— 先找出含 PEM 头的文件，再看里面有没有**纯 base64 行**。
# 纯 base64 且长于 60 字符的一整行，在正常源码里几乎不可能出现
# （正则字面量、断言、注释都会带上别的字符）。
pem_files="$(printf '%s\n' "$FILES" | tr '\n' '\0' \
    | xargs -0 grep -IlE 'BEGIN [A-Z ]*PRIVATE KEY' 2>/dev/null || true)"
c_hits=""
if [[ -n "$pem_files" ]]; then
    c_hits="$(printf '%s\n' "$pem_files" | tr '\n' '\0' \
        | xargs -0 grep -InE '^[A-Za-z0-9+/]{60,}={0,2}$' 2>/dev/null || true)"
fi
if [[ -n "$c_hits" ]]; then
    echo "✗ 无私钥（C 多行内嵌）"
    printf '%s\n' "$c_hits" | sed -E 's/^(.{150}).*/\1…/' | sed 's/^/    /'
    echo "    → 含 PEM 头的文件里出现了纯 base64 长行，几乎可以确定是一把真的私钥"
    echo
    FAILED=1
else
    echo "✓ 无私钥（C 多行内嵌）"
fi

scan "无 GitHub token 特征" \
     '(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})' \
     "疑似访问令牌。若确为误报（例如测试夹具），请调整模式而不是删掉这条检查"

# ── 结论 ────────────────────────────────────────────────────────────────────
echo
if [[ "$FAILED" -ne 0 ]]; then
    echo "脱敏检查未通过。"
    echo "注意：这不是「格式问题」—— 这些值一旦推到公开仓库就永久可被索引，"
    echo "      且任何人 fork 之后你都收不回来。"
    exit 1
fi
echo "脱敏检查通过。"
exit 0
