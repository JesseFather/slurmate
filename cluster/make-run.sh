#!/bin/bash
# Copyright 2026 JesseFather
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# ==============================================================================
#  make-run.sh — 打出站点端的单文件包（`slurmate-site-<版本>.run`）
# ==============================================================================
#
#  用法：
#    bash cluster/make-run.sh                    # 落在 dist/slurmate-site-<版本>.run
#    bash cluster/make-run.sh --out /tmp/x.run   # 指定产物路径
#
#  它做三件事，顺序是定的：
#    1. 把要发出去的文件拷进一个暂存目录，布局照仓库来（`cluster/`、`tools/`）
#       —— 包内文档里的相对路径就长这样：`install-base.sh` 认自己旁边的文件，
#       DEPLOYMENT.md 让人跑 `tools/check-cluster.sh`；
#    2. 拼出一个文件：壳（`cluster/run-header.sh`，把 `@VERSION@` 换成真版本号）
#       ＋一行标记＋`tar.gz` 包体；
#    3. 当场读回来：照壳里写的那条命令抽一次，逐份比对 sha256。路径与标记这两样
#       错了只有解压才发现，所以在打包这一步就发现，而不是在别人的集群上。
#
#  产物不进 git（`dist/` 已经在 .gitignore 里）：它是构建产物，与 `*.splug` 同
#    一个理由 —— 进仓库的只有能逐行看的源码。
#
#  包里【不含】测试、夹具、插件（基座两端都不带插件）与项目级文档（`docs/`
#    那几份的读者是客户端与实现者；站点端那一份是 `cluster/README.md`）。
# ==============================================================================

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SELF_DIR}/.." && pwd)"

die() { echo "  [中止] $*" >&2; exit 1; }

# 包里带什么：站点端那七个源文件（`install-base.sh` 的 SRC_FILES）＋它的文档
#   ＋环境自检脚本＋许可证。加一份就要在这里加一行，而这一行的用处是
#   "发出去的东西有一份清单"，不是"顺手多带一份"。
PAYLOAD=(
    cluster/install-base.sh
    cluster/slurmate-sessiond
    cluster/slurmate
    cluster/nft-compare.py
    cluster/conf-merge.py
    cluster/run.sbatch
    cluster/slurmate.conf.example
    cluster/slurmate-sessiond.service
    cluster/README.md
    cluster/docs/DEPLOYMENT.md
    cluster/docs/CONFIGURATION.md
    cluster/docs/TROUBLESHOOTING.md
    cluster/docs/PLUGIN-TROUBLESHOOTING.md
    tools/check-cluster.sh
    LICENSE
    NOTICE
)

OUT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --out|-o) OUT="${2:-}"; [[ -n "$OUT" ]] || die "--out 后面要给一个路径"; shift 2 ;;
        -h|--help)
            awk '/^# =====/ { n++; next } n == 2 { sub(/^# ?/, ""); print }' "$0"
            exit 0 ;;
        *) die "未知参数: $1（用 --help 看用法）" ;;
    esac
done

# 版本号只有一处来源：守护进程里那一行。它同时是四个声明里的一个，另三处由 CI
#   盯着（见 .github/workflows/checks.yml 的版本号那一步）—— 这里不抄第二份名单，
#   只读它，并要求读到的正好一行：行格式变了就当场停，而不是打出一个空版本号。
ver_of() {
    local f="$1" n
    n="$(grep -c '^VERSION = "' "$f" || true)"
    [[ "$n" == "1" ]] || die "$f 里匹配 '^VERSION = \"' 的行有 $n 行，该正好 1 行"
    sed -n 's/^VERSION = "\(.*\)"$/\1/p' "$f"
}
VERSION="$(ver_of "${SELF_DIR}/slurmate-sessiond")"
CLI_VERSION="$(ver_of "${SELF_DIR}/slurmate")"
[[ "$VERSION" == "$CLI_VERSION" ]] \
    || die "两个 VERSION 不同：slurmate-sessiond=${VERSION} slurmate=${CLI_VERSION}"
[[ -n "$VERSION" ]] || die "版本号是空的"

[[ -n "$OUT" ]] || OUT="${ROOT}/dist/slurmate-site-${VERSION}.run"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/slurmate-make-run.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "${WORK}/payload" "${WORK}/header"

for f in "${PAYLOAD[@]}"; do
    [[ -f "${ROOT}/${f}" ]] || die "源文件缺失：${f}（在 ${ROOT} 下没找到）"
    mkdir -p "${WORK}/payload/$(dirname "$f")"
    # 模式照源文件那一份带过去，但不用 `cp -p`：源目录若在带 ACL/xattr 的
    #   文件系统上（共享盘常见），`-p` 会去复制那些扩展属性，而目标文件系统
    #   不支持时它返回非零 —— 那会以一个与"发什么出去"无关的理由打断打包。
    _mode="$(stat -c '%a' "${ROOT}/${f}")"
    cp "${ROOT}/${f}" "${WORK}/payload/${f}"
    chmod "$_mode" "${WORK}/payload/${f}"
done

sed "s|@VERSION@|${VERSION}|" "${SELF_DIR}/run-header.sh" > "${WORK}/header/run"
# 换完不许再有占位符：留着的话，说明壳里加了新的 `@…@` 而这里没跟上 —— 那样
#   打成包之后它才会露出来，而那已经是别人的机器上了。
if grep -q '@[A-Z_]\{2,\}@' "${WORK}/header/run"; then
    grep -n '@[A-Z_]\{2,\}@' "${WORK}/header/run" >&2
    die "壳里还有没被替换的占位符（见上）。要么补一条 sed，要么把它写成字面量。"
fi
grep -qx '#===SLURMATE-PAYLOAD===' "${WORK}/header/run" \
    || die "壳的最后一行不是包体标记，拼出来的包会解不出来"

mkdir -p "$(dirname "$OUT")"
cat "${WORK}/header/run" > "$OUT"
# 逐字节可重现：清单顺序固定、时间戳压平、属主写成 0。少了这几项，同一份源码
#   打两次得到两个 sha256（tar 记的是拷进暂存目录那一刻的 mtime，每次都不一样），
#   而"按 sha256 认这个包"就成了一句空话 —— 用户 2026-10-16 就是拿它去认包的。
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
    -czf - -C "${WORK}/payload" "${PAYLOAD[@]}" >> "$OUT"
chmod 755 "$OUT"

# ── 当场读回来 ──────────────────────────────────────────────────────────────
# 用壳里那条命令的同一个写法（不是另写一份"我们知道包体从哪儿开始"）。
N="$(LC_ALL=C awk '/^#===SLURMATE-PAYLOAD===$/{print NR+1; exit}' "$OUT")"
[[ -n "$N" ]] || die "拼出来的包里没有包体标记（${OUT}）"
mkdir -p "${WORK}/back"
tail -n +"$N" "$OUT" | tar xz -C "${WORK}/back" \
    || die "拼出来的包解不出来（${OUT}）"

list_of() { (cd "$1" && find . -type f | sed 's|^\./||' | sort); }
diff <(list_of "${WORK}/payload") <(list_of "${WORK}/back") >&2 \
    || die "解出来的清单与放进去的不同（见上）"
while IFS= read -r f; do
    cmp -s "${WORK}/payload/${f}" "${WORK}/back/${f}" \
        || die "解出来的 ${f} 与源文件不同"
done < <(list_of "${WORK}/payload")

echo
echo "  已生成：${OUT}"
echo "  版本：${VERSION}（取自 cluster/slurmate-sessiond，与 cluster/slurmate 一致）"
echo "  包体：$(list_of "${WORK}/payload" | wc -l) 份"
# 用 `stat` 而不是 `du`：`du` 报的是占用块数，共享盘上那一栏与文件实际多大
#   没有关系（同一个文件在这里报 512 而它其实 367K）。
_size="$(stat -c '%s' "$OUT")"
echo "  大小：${_size} 字节（约 $(( _size / 1024 )) K）"
echo "  sha256：$(sha256sum "$OUT" | awk '{print $1}')"
echo
echo "  交付之后那一头：sudo bash $(basename "$OUT") --check"
echo "  先看包里有什么：bash $(basename "$OUT") --extract /tmp/slurmate-docs"
