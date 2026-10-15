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
#  slurmate-site-<版本>.run — 站点端单文件包的自解压壳
# ==============================================================================
#
#  站点管理员手上只有这一个文件：拷到控制节点上，用 root 跑它。
#
#  它做两件事，第三件不做：
#    1. 把包体解压到一个临时目录（退出时删掉，系统里不留中转站）；
#    2. 把动词原样转给包内的 cluster/install-base.sh；
#    3. 不自己判断"该不该装哪一样" —— 五个动词的判据都在 install-base.sh 里，
#       在这里照抄一遍就是同一件事的第二份实现，而两份判据可以各自漂开。
#
#  五个动词：
#    （不给动词）   安装：按顺序走三步 —— 检查、安装、诊断。装过基座时自动按
#                   修复走（升级与修复是同一条路）。
#    --check        体检：装之前。两屏 —— 包内的环境自检（前置条件那一份），
#                   然后是部署预检。不做任何改动。
#    --doctor       诊断：装之后。文件、目录、单元、服务、数据。不做任何改动。
#    --repair       修复：只对装过的机器动手。只增不改，站点配置与状态数据不动。
#    --uninstall    卸载。加 --purge-state 连状态数据一起。
#
#  还有一条只读的路，不需要 root：
#    --extract [目录]   把包里的东西解压出来看（默认 ./slurmate-site-<版本>）
#
#  这一份是生成物：改它没用，下一次生成的包会盖掉它。母本在仓库里 ——
#    cluster/run-header.sh 是这一层壳，cluster/make-run.sh 负责拼出包来。
#
#  包体从下面【第一个】标记行之后开始，是一段 tar.gz。不看这个脚本也能解压
#  （四条命令，与 --extract 做的是同一件事；目录要先建出来，`tar -C` 不会建）：
#
#    F=slurmate-site-<版本>.run
#    D=/tmp/slurmate-docs
#    mkdir -p "$D"
#    N=$(LC_ALL=C awk '/^#===SLURMATE-PAYLOAD===$/{print NR+1; exit}' "$F")
#    tail -n +"$N" "$F" | tar xz -C "$D"
#
#  那个标记在标记行【以上】不许再出现第二次（出现在上面，解压就从那里开始，
#  而下面是压缩数据，谁也不会一眼看出解压出来的是半截）。用例盯着这一条。
# ==============================================================================

set -uo pipefail

# make-run.sh 在拼包时把这一行换成真的版本号。
VERSION="@VERSION@"

SELF="${BASH_SOURCE[0]}"
# 相对路径跑的时候要先变成绝对路径：解压之后当前目录可能变了，而 $SELF 还要
#   用在两处 —— 转给 install-base.sh 的那句"回滚/卸载"提示，以及 --extract 的
#   默认目录（那两处都必须指向管理员手上真实存在的这一个文件）。
case "$SELF" in
    /*) ;;
    *) SELF="$(cd "$(dirname "$SELF")" && pwd)/$(basename "$SELF")" ;;
esac

ORIG_ARGS=("$@")
MODE="install"
EXTRACT_TO=""
FORWARD=()

usage() {
    cat <<EOF
slurmate-site-${VERSION}.run — Slurmate 站点端单文件包

用法：sudo bash slurmate-site-${VERSION}.run [动词] [开关]

  --check        体检：装之前查环境与前置条件，不做任何改动（两屏，见下）
  --doctor       诊断：装之后查文件、目录、服务与数据，不做任何改动
  --repair       修复：把该在的摆回去，只增不改
  --uninstall    卸载（保留状态与日志）
  （不给动词）   安装

  --extract [目录]
                 只解压，不改动系统，也不需要 root
                 （默认 ./slurmate-site-${VERSION}）

  --dry-run      演练：说清将要做什么，一个字都不改（与安装、修复、体检合用）
  --purge-state  卸载时连状态数据一起删（与 --uninstall 合用）
  --version      只打印这一份包的版本
  --help         这一屏

它只做两件事：把包体解压到临时目录，把动词转给包内的
cluster/install-base.sh。五个动词的实现只有那一份：预检、快照、
非干扰比对、卸载的逐项归属校验，都在它里面。

不带动词安装时，它按顺序走三步，不需要谁去记顺序：
  第一步 检查：环境与前置条件（tools/check-cluster.sh）
  第二步 安装：预检 → 快照 → 摆文件 → 启用并启动 → 非干扰验证
  第三步 诊断：用与 --doctor 同一份判据对一次账，说清该在的都在不在
这台机器上装过基座时，第二步自动按修复走：升级与修复是同一条路，
站点配置与正在跑的会话都不动。

--check 会把第一步与第二步里那份预检都跑一遍：
  第一屏  tools/check-cluster.sh   环境与前置条件（DEPLOYMENT.md 第一部分）
  第二屏  cluster/install-base.sh --check   部署预检（第二部分 步骤 1）
第一屏是事实清单，它的退出码不进结论；这一次体检的结论是第二屏的退出码。

文档随包分发（cluster/docs/ 四份 + cluster/README.md），
解压即可读：bash slurmate-site-${VERSION}.run --extract /tmp/slurmate-docs
EOF
}

# 包体从哪一行开始。找不到标记就返回 1（别说"就从第 1 行开始"，那会拿壳当
#   包体喂给 tar，报出来的是 tar 自己的话，指不回真正的原因）。
payload_line() {
    local n
    n="$(LC_ALL=C awk '/^#===SLURMATE-PAYLOAD===$/{print NR+1; exit}' "$SELF")"
    [[ -n "$n" ]] || return 1
    printf '%s' "$n"
}

extract_to() {
    local dest="$1" n
    if [[ -e "$dest" && -n "$(ls -A "$dest" 2>/dev/null)" ]]; then
        echo "  [中止] ${dest} 已存在且不是空目录，换一个位置：" >&2
        echo "      bash ${SELF} --extract /tmp/slurmate-docs" >&2
        exit 1
    fi
    n="$(payload_line)" || {
        echo "  [中止] 这一份包里没有包体标记（文件不完整，或被改过）。" >&2
        exit 1
    }
    mkdir -p "$dest" || exit 1
    if ! tail -n +"$n" "$SELF" | tar xz -C "$dest"; then
        echo "  [中止] 解压失败：包体不完整（传输中被截断？）。" >&2
        echo "      重新取一份，并核对它的 sha256。" >&2
        exit 1
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --install)   MODE="install"; shift ;;
        --check)     MODE="check"; shift ;;
        --doctor)    MODE="doctor"; shift ;;
        --repair)    MODE="repair"; shift ;;
        --uninstall) MODE="uninstall"; shift ;;
        --extract)
            MODE="extract"; shift
            if [[ $# -gt 0 && "$1" != -* ]]; then EXTRACT_TO="$1"; shift; fi ;;
        -h|--help)   usage; exit 0 ;;
        --version)   echo "${VERSION}"; exit 0 ;;
        # 其余开关原样转给 install-base.sh —— 它那一层认得哪些、不认得哪些，
        #   只有它说了算（在这里再列一份名单就是第二个写方）。
        -*)          FORWARD+=("$1"); shift ;;
        *)           echo "未知参数: $1（用 --help 看用法）" >&2; exit 2 ;;
    esac
done

if [[ "$MODE" == "extract" ]]; then
    dest="${EXTRACT_TO:-./slurmate-site-${VERSION}}"
    extract_to "$dest"
    echo "  已解压到 $(cd "$dest" && pwd)"
    echo "  文档：$dest/cluster/README.md、$dest/cluster/docs/"
    exit 0
fi

# 装、体检、诊断、修复、卸载都要 root：它们要么会写系统，要么要读只有 root
#   读得到的东西（nft、journal、状态目录）。--extract 与 --help 不要 root。
if [[ "$(id -u)" -ne 0 ]]; then
    echo >&2
    echo "  这一步要 root。请用：" >&2
    echo "      sudo bash ${SELF} ${ORIG_ARGS[*]-}" >&2
    echo "  （只看包里有什么不需要 root：bash ${SELF} --extract 目录）" >&2
    exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/slurmate-site.XXXXXX")" || {
    echo "  [中止] 无法创建临时目录。" >&2
    exit 1
}
chmod 700 "$TMP"
# 临时目录一定要删：留着的话，下一份包、下一次升级会在盘上攒下一堆互相矛盾的
#   install-base.sh 副本，而其中任何一份被当成"源码"跑起来都说得通。
trap 'rm -rf "$TMP"' EXIT

extract_to "$TMP"
if [[ ! -f "$TMP/cluster/install-base.sh" ]]; then
    echo "  [中止] 包体里没有 cluster/install-base.sh（这一份包不完整）。" >&2
    exit 1
fi

echo
echo "  slurmate-site-${VERSION}.run"
echo "  包体已解压到 ${TMP}（退出时删掉，系统里不留中转站）"

# 体检有两屏，因为查的不是同一类事实：环境那一份（前置条件）与部署预检那一份
#   （配置、目标位置、快照）。两份都只读，而结论取第二份的退出码 —— 第一份的
#   输出是给管理员与支持人员看的事实清单。
if [[ "$MODE" == "check" && -f "$TMP/tools/check-cluster.sh" ]]; then
    echo
    echo "════════════════════════════════════════════════════════════"
    echo "  第一屏：环境与前置条件（tools/check-cluster.sh，只读）"
    echo "════════════════════════════════════════════════════════════"
    bash "$TMP/tools/check-cluster.sh" || true
    echo
    echo "════════════════════════════════════════════════════════════"
    echo "  第二屏：部署预检（cluster/install-base.sh --check，只读）"
    echo "  这一次体检的结论是这一屏的退出码。"
    echo "════════════════════════════════════════════════════════════"
elif [[ "$MODE" == "install" && -f "$TMP/tools/check-cluster.sh" ]]; then
    # 安装这条路按顺序走三步：先检查（这一屏 + 安装器自己的预检），再安装，
    #   然后诊断（安装器收尾时用与 --doctor 同一份判据对一次账）。
    #   环境这一屏只报事实、不拦路：真会拦下安装的那些（缺 nft、缺 Slurm 命令、
    #   集群网段对不上）由守护进程自己的预检说出来，那才是唯一那份判据。
    echo
    echo "════════════════════════════════════════════════════════════"
    echo "  第一步：检查 ── 环境与前置条件（tools/check-cluster.sh，只读）"
    echo "  这一屏只报事实，不拦路；拦路的是下面安装器自己的预检。"
    echo "════════════════════════════════════════════════════════════"
    bash "$TMP/tools/check-cluster.sh" || true
    echo
    echo "════════════════════════════════════════════════════════════"
    echo "  第二步：安装 ── 预检 → 快照 → 摆文件 → 启用并启动 → 非干扰验证"
    echo "  装完之后同一个安装器会用同一份判据对一次账（第三步：诊断）。"
    echo "  装过基座的机器上，这一步自动按修复走 = 升级。"
    echo "════════════════════════════════════════════════════════════"
else
    echo "  下面是它的安装器输出的那一屏。判据、预检、快照都在它里面。"
fi
echo

ARGS=()
[[ "$MODE" == "install" ]] || ARGS+=("--${MODE}")
[[ ${#FORWARD[@]} -gt 0 ]] && ARGS+=("${FORWARD[@]}")

# SLURMATE_ORIG_SCRIPT 是给 install-base.sh 的：它打印的"卸载/回滚"提示要指向
#   管理员手上真实存在的这一个文件（.run），不是临时目录里那一份副本。
# SLURMATE_PACKAGE 同理，用于"文档随包分发，解压看"那句话。
SLURMATE_ORIG_SCRIPT="$SELF" SLURMATE_PACKAGE="$SELF" \
    bash "$TMP/cluster/install-base.sh" ${ARGS[@]+"${ARGS[@]}"}
exit $?

#===SLURMATE-PAYLOAD===
