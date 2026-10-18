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
#  install-base.sh — Slurmate 集群侧基座安装 / 卸载
# ==============================================================================
#
#  在【控制节点（登录节点）】上以 root 运行。
#
#  本脚本只管基座：守护进程、CLI、作业模板、systemd 单元、
#     站点配置主文件、目录骨架。它不再碰插件 —— 插件那四件事（装包 / 编织
#     作业脚本 / 对齐配置 / 卸包）有一个唯一入口：
#
#         sudo slurmate plugin install [--from DIR]   装（可从一个目录整批对齐）
#         sudo slurmate plugin uninstall <id>…        卸
#         sudo slurmate plugin sync                   对齐配置与作业脚本
#
#     它们走守护进程里的安装器 / 卸载器（`--install-plugins` /
#     `--uninstall-plugins` / `--sync-plugins`）—— 读包、验签、同 id 检查、
#     三道作业侧断言，各只有那一份实现。
#
#     为什么搬走：插件、部署预检、基座安装是三件不同的事，而"插件是独立项目，
#       装它却要重跑一次整个部署"正是它们压在一起的结果。
#     为什么不整个删掉：基座这一半还没有软件包接手（deb/rpm 是另一条
#       决定，见 KNOWN-ISSUES）。它整个消失的那一天 = 基座软件包做出来的那一天。
#
#  部署预检不在本脚本里：凡守护进程自己判得了的（端口区间自洽、与
#    reserved_ranges 相交、Slurm 命令齐备、四个目录写不写得进去…）都进
#    `slurmate-sessiond --check` —— 同一件事只允许有一个判据。本脚本现在
#    只是调用它，并把它的两个退出码分开对待（见〈阶段 0〉那一段）。
#
#  设计原则：只增不改，绝不影响集群上已有的任何功能
#  ──────────────────────────────────────────────
#  1. 只增不改：不碰任何不属于本系统的 nft 表、服务、锁目录、sshd 配置与
#     sudoers 条目。Slurmate 只创建自己的 `inet slurmate` 表与自己的 systemd 单元。
#  2. 绝不执行 `nft flush ruleset`，绝不 reload/restart nftables.service
#     —— 那会清掉整台机器上所有表的规则集，包括别人的。
#  3. 部署前后各取一次 nftables 规则集【结构化】快照，剥掉本系统新增的
#     inet slurmate 表之后必须逐条完全一致；否则判定失败并自动回滚。
#     比对器（nft-compare.py）有独立自测，防的是"比对了但其实什么都没比"。
#  4. 安装任何文件前先检查目标是否已存在且不属于本系统 —— 是则中止，
#     绝不覆盖别人的文件。卸载路径同样逐项校验归属。
#  5. 幂等：可反复运行。卸载只删自己的东西。
#  6. 站点配置只对键、不动取值：升级时装上去的配置是"管理员的取值 + 这一版的
#     键集合"。不认的键删掉（否则守护进程拒绝启动），新加的节补到末尾；改之前
#     的那一份失败时自动放回，成功后不保留副本。见 `conf-merge.py` 与
#     〈阶段 0〉那一段。
#
#  用法（五个部署动词。单文件自解压包 `slurmate-site-<版本>.run` 把这五个
#  原样转发到本脚本 —— 实现只有这一份）：
#    sudo bash install-base.sh                     # 安装；装过基座时自动走修复（升级）
#    sudo bash install-base.sh --check             # 体检：装之前，不做任何改动
#    sudo bash install-base.sh --doctor            # 诊断：装之后，不做任何改动
#    sudo bash install-base.sh --repair            # 修复：把该在的摆回去
#    sudo bash install-base.sh --uninstall         # 卸载（保留状态数据）
#    sudo bash install-base.sh --dry-run           # 演练，不做任何改动
#    sudo bash install-base.sh --no-restart        # 装完不重启服务（演练/脚本用）
#    sudo bash install-base.sh --uninstall --purge-state
#    sudo bash install-base.sh --require-baseline  # 前置基线缺失即中止（见下）
#    sudo bash install-base.sh --rollback <目录>   # 收尾一次没有走完的部署
#
#  装、升、修、卸都是一次事务：中途任何一个失败都按撤销日志恢复到运行前
#  （文件、配置、单元、开机自启、服务状态、nft 表），成功则连日志带旧副本
#  一起删掉，/root 下不留现场。被 kill -9 或断电打断的现场，下一次会先自动
#  收尾；也可以手工跑上面那条 --rollback。
#
#  一次安装按顺序做三件事，不需要谁去记顺序：
#    1. 检查：〈阶段 0〉的预检与〈阶段 1〉的快照（要装之前先证明这台机器可以装）；
#    2. 安装：〈阶段 2〉到〈阶段 5〉（摆文件、启用并启动、非干扰验证）；
#    3. 诊断：〈装完对账〉用与 `--doctor` 逐字同一份判据再问一遍"该在的都在不在"。
#
#  体检与诊断的分工：体检在一台【什么都没装】的机器上回答"能不能装"，它查的是
#    环境与前置条件；诊断在一台【装过】的机器上回答"现在哪里不对"，它查的是
#    文件、目录、单元、服务与守护进程自己的判断。两者都会跑守护进程的 `--check`
#    —— 那是同一个程序问自己，不是第二份判据。
#
#  装与升级是同一条路，走哪一条由"这台机器上装过没有"决定：
#    没装过 → 装；装过 → 按修复走（先对账、装完再对账，说清哪几样换掉了）。
#    于是 `--repair` 剩下的职责只有一条：只对装过的机器动手。没装过的机器
#    上它拒绝执行 —— 免得敲错一个动词变成一次静默的首次部署。
#
#  装完基座之后装插件（那是唯一的插件入口，本脚本不认识插件）：
#    sudo slurmate plugin install --from /srv/slurmate-pkgs
#    包是构建产物（作者在他机器上 `packer build` 出来的 `<id>.splug`），
#      不进 git；本脚本与安装器永不打包，服务器上从头到尾没有源码树。
#    一个插件都没有是合法状态：基座照常起，会话照常能查能停。
#
#  关于 --require-baseline
#  ─────────────────────
#  本脚本最初是为「一台已经跑着别的端口管理方案的登录节点」写的，因此会检查
#  若干前置设施是否存在。在别人的集群上这些设施通常不存在，所以默认只
#  警告、继续部署。若你需要"前置条件不满足就绝不继续"的严格语义，加这个开关。
#
# ==============================================================================

set -uo pipefail

# ─── 路径 ────────────────────────────────────────────────────────────────────
# install-base.sh 与它要安装的源文件同在 cluster/ 下。
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${SELF_DIR}"

# 面向用户的"脚本路径"。源码不可信时本脚本会自拷贝到 /root 下再重执行，那时
# $0 指向 /root/slurmate-src.XXXXXX/…—— 一个随机的临时目录。若把卸载指令写成
# $0，管理员记下的是一个下次部署就变、还可能被清理掉的路径。原路径才是他手里
# 真实存在的那个，所以由父进程显式传下来。
SELF_SCRIPT="${SELF_DIR}/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_PATH="${SLURMATE_ORIG_SCRIPT:-$SELF_SCRIPT}"

DAEMON="/usr/local/sbin/slurmate-sessiond"
CLI="/usr/local/bin/slurmate"
SHARE_DIR="/usr/local/share/slurmate"
# `<SHARE_DIR>/jobs` 与 `<SHARE_DIR>/plugins` 不归本脚本管 —— 那两条路径
#   由安装器按同一个前缀算出来（`slurmate-sessiond` 的 default_jobs_dir /
#   default_plugins_dir），本脚本不认识它们。这是刻意的：一个路径一旦有两个
#   写方，就多一次"脚本以为装到了 A、守护进程扫的是 B"的机会。
CONF_DIR="/etc/slurmate"
CONF="${CONF_DIR}/slurmate.conf"
UNIT="/etc/systemd/system/slurmate-sessiond.service"
SERVICE="slurmate-sessiond.service"

STATE_DIR="/var/lib/slurmate-session"
LOG_DIR="/var/log/slurmate"
RUN_DIR="/run/slurmate-session"
SOCKET="${RUN_DIR}/ctl.sock"

PY="/usr/bin/python3"
NFT="$(command -v nft || echo /sbin/nft)"

# ─── 参数 ────────────────────────────────────────────────────────────────────
MODE="install"
REQUIRE_BASELINE=0
DRYRUN=0
PURGE=0
NORESTART=0
ROLLBACK_FROM=""

while [[ $# -gt 0 ]]; do
    arg="$1"; shift
    case "$arg" in
        --check)             MODE="check" ;;
        --doctor)            MODE="doctor" ;;
        --repair)            MODE="repair" ;;
        --uninstall)         MODE="uninstall" ;;
        --dry-run)           DRYRUN=1 ;;
        --no-restart)        NORESTART=1 ;;
        --require-baseline)  REQUIRE_BASELINE=1 ;;
        # 兼容旧命令行：--force 是空操作（基线不完整时默认就继续），保留接受，
        # 免得旧脚本/旧笔记里的命令直接报错。
        --force)             : ;;
        --purge-state)       PURGE=1 ;;
        --rollback)
            MODE="rollback"
            ROLLBACK_FROM="${1:-}"
            if [[ -z "$ROLLBACK_FROM" ]]; then
                echo "--rollback 后面要给一个事务目录（/root/slurmate-deploy-…）。" >&2
                exit 2
            fi
            shift ;;
        # 内部自测：在临时目录里真跑一遍撤销日志引擎。不需要 root。
        --txn-selftest)      MODE="txn-selftest" ;;
        # 插件不再经过本脚本。说清楚它搬去哪儿，而不是
        #   只说一句"未知参数" —— 那会让人以为是自己打错了。
        #
        #   两种写法都要取到那个目录：`--plugins-src=X` 的 X 在同一个参数里，
        #     而 `--plugins-src X` 的在下一个（上面 `arg="$1"; shift` 已经
        #     shift 过了，所以下一条就是现在的 `$1`）。只认等号那一种的话，
        #     管理员照最顺手的写法敲，得到的指路里那一条命令自己跑不通
        #     （印出来是 `--from --plugins-src`）。
        --plugins-src|--plugins-src=*)
            _src="${arg#--plugins-src=}"
            [[ "$_src" == "$arg" ]] && _src="${1:-DIR}"
            echo "插件不再经过本脚本（v0.12 起）：本脚本只装基座。" >&2
            echo "  装插件（那是唯一的入口）：" >&2
            echo "      sudo slurmate plugin install --from ${_src}" >&2
            exit 2 ;;
        -h|--help)
            # 印的是文件头那一段（标题那两行之间的东西），不是整个文件头 ——
            #   用法里写着"插件搬到哪儿去了"，那一段必须读得到。
            awk '/^# =====/ { n++; next }
                 n == 2 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
            exit 0 ;;
        *) echo "未知参数: $arg（用 --help 查看用法）" >&2; exit 2 ;;
    esac
done

# ─── 输出 ────────────────────────────────────────────────────────────────────
PASS_N=0; FAIL_N=0; WARN_N=0
step()  { echo; echo "════════════════════════════════════════════════════════════"; echo "  $*"; echo "════════════════════════════════════════════════════════════"; }
# 报告类输出（含警告与失败）一律走 stdout：本脚本的产物就是一份可存档、可粘贴
# 的体检报告。早期把 warn/bad 写到 stderr，实际后果是——"源文件不可信"的警告在
# stdout 里彻底消失，而紧接着又打出一句"源文件可信"的绿灯，报告自相矛盾，
# 只看报告（或只重定向 stdout 存档）的人无从察觉。die 仍走 stderr，它是硬中止。
info()  { echo "  [INFO] $*"; }
ok()    { PASS_N=$((PASS_N+1)); echo "  [ OK ] $*"; }
warn()  { WARN_N=$((WARN_N+1)); echo "  [WARN] $*"; }
bad()   { FAIL_N=$((FAIL_N+1)); echo "  [FAIL] $*"; }
die()   {
    echo; echo "  [中止] $*" >&2
    if [[ "${TXN_ACTIVE:-0}" -eq 1 && "${TXN_FINISHED:-0}" -eq 0 \
          && "${TXN_ROLLING:-0}" -eq 0 ]]; then
        txn_rollback "${TXN_DIR}" "失败中止"
    fi
    echo >&2
    exit 1
}
run()   { if [[ "$DRYRUN" -eq 1 ]]; then echo "  [演练] $*"; else "$@"; fi; }

# ─── 事务：撤销日志 ──────────────────────────────────────────────────────────
# 装、升、修、卸都是一次事务。动目标之前先把"怎么撤回"写进日志；失败就按
#   日志倒着恢复。成功写 committed，然后连日志带旧副本一起删掉。
# 日志放在 /root，不放状态目录：卸载 --purge-state 会连状态目录一起移走。
TXN_DIR=""
TXN_LOG=""
TXN_ACTIVE=0
TXN_FINISHED=0
TXN_ROLLING=0
TXN_SELFTEST=0
TXN_N=0
TXN_RESID=()

txn_note() {
    local line="$1" a
    shift
    for a in "$@"; do line+=$'\t'"$a"; done
    printf '%s\n' "$line" >> "$TXN_LOG" || return 1
    sync 2>/dev/null || true
}

txn_begin() {
    local kind="$1" dir="${2:-}" d active enabled nft_here=0
    [[ -n "$dir" ]] || dir="$WORK_DIR"
    TXN_DIR="$dir"
    mkdir -p "$TXN_DIR" || return 1
    chmod 700 "$TXN_DIR" || return 1
    TXN_LOG="${TXN_DIR}/undo.log"
    : >| "$TXN_LOG" || return 1
    TXN_ACTIVE=1
    TXN_FINISHED=0
    TXN_RESID=()
    txn_note "slurmate-txn" "1" || return 1
    txn_note "meta" "kind" "$kind"
    txn_note "meta" "service" "$SERVICE"
    txn_note "meta" "nft_table" "inet slurmate"
    active="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
    enabled="$(systemctl is-enabled "$SERVICE" 2>/dev/null || true)"
    txn_note "meta" "service_was_active" "$active"
    txn_note "meta" "service_was_enabled" "$enabled"
    if "$NFT" list table inet slurmate >/dev/null 2>&1; then
        nft_here=1
        if "$NFT" list table inet slurmate > "${TXN_DIR}/nft-table.before" 2>/dev/null; then
            txn_note "meta" "nft_snapshot" "${TXN_DIR}/nft-table.before"
        fi
    fi
    txn_note "meta" "nft_existed" "$nft_here"
    for d in "$LOG_DIR" "$RUN_DIR"; do
        [[ -e "$d" ]] && txn_note "meta" "dir_existed" "$d"
    done
    return 0
}

txn_backup() {
    local p="$1" saved
    if [[ -e "$p" || -L "$p" ]]; then
        TXN_N=$((TXN_N + 1))
        saved="${TXN_DIR}/old/${TXN_N}-$(basename "$p")"
        mkdir -p "${TXN_DIR}/old" || return 1
        cp -a "$p" "$saved" || return 1
        txn_note "restore" "$p" "$saved"
    else
        txn_note "remove" "$p"
    fi
}

txn_save() {
    local p="$1" saved
    TXN_N=$((TXN_N + 1))
    saved="${TXN_DIR}/saved/${TXN_N}-$(basename "$p")"
    mkdir -p "${TXN_DIR}/saved" || return 1
    cp -a "$p" "$saved" || return 1
    txn_note "saved" "$p" "$saved"
}

txn_save_dir() {
    local p="$1" saved
    [[ -d "$p" ]] || return 0
    TXN_N=$((TXN_N + 1))
    saved="${TXN_DIR}/trees/${TXN_N}-$(basename "$p")"
    mkdir -p "${TXN_DIR}/trees" || return 1
    cp -a "$p" "$saved" || return 1
    txn_note "saved_dir" "$p" "$saved"
}

txn_move() {
    local src="$1" dst="$2"
    txn_note "moved" "$src" "$dst" || return 1
    mv "$src" "$dst"
}

txn_mkdir_p() {
    local p="$1" own="${2:-0}" d="$1" i
    local -a missing=()
    while [[ ! -d "$d" ]]; do
        missing+=("$d")
        [[ "$d" == "/" || "$d" == "." ]] && break
        d="$(dirname "$d")"
    done
    for ((i = ${#missing[@]} - 1; i >= 0; i--)); do
        d="${missing[$i]}"
        local own_here=0
        [[ "$d" == "$p" ]] && own_here="$own"
        txn_note "dir" "$d" "$own_here" || return 1
        mkdir "$d" || return 1
    done
}

txn_mode() {
    local p="$1" mode
    [[ -e "$p" ]] || return 0
    mode="$(stat -c '%a' "$p" 2>/dev/null || true)"
    [[ -n "$mode" ]] || return 0
    txn_note "mode" "$p" "$mode"
}

txn_rmdir() {
    local p="$1" mode
    [[ -d "$p" ]] || return 0
    mode="$(stat -c '%a' "$p" 2>/dev/null || echo 755)"
    txn_note "rmdir" "$p" "$mode" || return 1
    rmdir "$p" 2>/dev/null
}

txn_purge_dir() {
    local d="$1" dst
    [[ -d "$d" ]] || return 0
    dst="$(dirname "$d")/.$(basename "$d").uninstall-${TS}"
    txn_move "$d" "$dst"
}

txn_resid() {
    TXN_RESID+=("$1")
    echo "  [FAIL] $1"
}

txn_commit() {
    local line kind a b d
    [[ "$TXN_ACTIVE" -eq 1 ]] || return 0
    txn_note "committed"
    sync 2>/dev/null || true
    while IFS=$'\t' read -r kind a b; do
        if [[ "$kind" == "moved" && -n "$b" ]]; then
            rm -rf "$b"
        fi
    done < "$TXN_LOG"
    TXN_ACTIVE=0
    TXN_FINISHED=1
    if ! rm -rf "$TXN_DIR"; then
        warn "事务目录没有删掉：${TXN_DIR}（部署成功，请手动删除）"
        return 0
    fi
    for d in /root/slurmate-backup-*; do
        [[ -d "$d" ]] || continue
        rm -rf "$d" && info "已删除旧版留下的备份目录：$d"
    done
    return 0
}

txn_rollback() {
    local dir="${1:-$TXN_DIR}" reason="${2:-}" line kind a b c
    [[ -n "$dir" && -f "${dir}/undo.log" ]] || return 0
    TXN_ROLLING=1
    trap '' INT TERM
    echo
    echo "════════════════════════════════════════════════════════════"
    echo "  回滚：把这次部署撤回"
    echo "════════════════════════════════════════════════════════════"
    [[ -n "$reason" ]] && info "原因：${reason}"

    local -a lines=()
    mapfile -t lines < "${dir}/undo.log" 2>/dev/null || true
    local n=${#lines[@]}
    if (( n == 0 )); then
        rm -rf "$dir"
        TXN_ACTIVE=0; TXN_FINISHED=1; TXN_ROLLING=0
        trap '_on_signal INT 130' INT
        trap '_on_signal TERM 143' TERM
        return 0
    fi
    IFS=$'\t' read -r kind a _ <<< "${lines[0]}"
    if [[ "$kind" != "slurmate-txn" || "$a" != "1" ]]; then
        echo "  [FAIL] 撤销日志的格式不认识（第一条不是 slurmate-txn 1）。"
        echo "  现场保留在 ${dir}，请人工处理。"
        TXN_ACTIVE=0; TXN_FINISHED=1; TXN_ROLLING=0
        return 1
    fi

    local kind_of="" svc="$SERVICE" nft_tbl="inet slurmate"
    local nft_existed="" nft_snap="" was_active="" was_enabled=""
    local service_touched=0 enabled_touched=0 bad_middle=0
    local -a ops=() opa=() opb=() pre_dirs=()
    local i
    for ((i = 1; i < n; i++)); do
        line="${lines[$i]}"
        IFS=$'\t' read -r kind a b c <<< "$line"
        case "$kind" in
            meta)
                case "$a" in
                    kind) kind_of="$b" ;;
                    service) svc="$b" ;;
                    nft_table) nft_tbl="$b" ;;
                    nft_existed) nft_existed="$b" ;;
                    nft_snapshot) nft_snap="$b" ;;
                    service_was_active) was_active="$b" ;;
                    service_was_enabled) was_enabled="$b" ;;
                    service_touched) service_touched="$b" ;;
                    enabled_touched) enabled_touched="$b" ;;
                    dir_existed) pre_dirs+=("$b") ;;
                esac ;;
            committed) : ;;
            restore|remove|dir|mode|saved|saved_dir|rmdir|moved)
                ops+=("$kind"); opa+=("$a"); opb+=("$b") ;;
            "")
                : ;;
            *)
                if (( i == n - 1 )); then
                    info "日志末行不完整（多半是断电截断），跳过。"
                else
                    bad_middle=1
                    echo "  [FAIL] 日志第 $((i + 1)) 行读不动：${line}"
                fi ;;
        esac
    done
    [[ -n "$kind_of" ]] || kind_of="install"

    if [[ "$TXN_SELFTEST" -eq 0 ]]; then
        # 1. 停服务：旧进程必须先走，否则下一个 tick 会把刚删的规则/目录补回来。
        if [[ "$service_touched" == "1" ]]; then
            echo "  [回滚] 停止服务"
            systemctl stop "$svc" >/dev/null 2>&1 || true
            local deadline=$((SECONDS + 20))
            while systemctl is-active --quiet "$svc" 2>/dev/null; do
                if (( SECONDS >= deadline )); then
                    txn_resid "服务停不下来（$svc）"
                    echo "  现场保留在 ${dir}；先手动停掉服务再重跑 --rollback。"
                    TXN_ACTIVE=0; TXN_FINISHED=1; TXN_ROLLING=0
                    trap '_on_signal INT 130' INT
                    trap '_on_signal TERM 143' TERM
                    return 1
                fi
                sleep 0.5
            done
            systemctl reset-failed "$svc" >/dev/null 2>&1 || true
        fi
        # 2. 取消本次加上的开机自启。
        if [[ "$enabled_touched" == "1" ]]; then
            case "$was_enabled" in
                enabled|enabled-runtime|static|indirect) ;;
                *) systemctl disable "$svc" >/dev/null 2>&1 || true ;;
            esac
        fi
        # 3. nft：原先有表就回放快照，原先没有就删掉本次新建的。
        if [[ "$nft_existed" == "1" && -n "$nft_snap" && -f "$nft_snap" ]]; then
            "$NFT" delete table $nft_tbl >/dev/null 2>&1 || true
            if "$NFT" -f "$nft_snap" >/dev/null 2>&1; then
                echo "  [回滚] 恢复 nft 表 ${nft_tbl}"
            else
                txn_resid "nft 表 ${nft_tbl} 没有恢复"
            fi
        elif [[ "$nft_existed" == "0" ]]; then
            if "$NFT" list table $nft_tbl >/dev/null 2>&1; then
                if "$NFT" delete table $nft_tbl >/dev/null 2>&1; then
                    echo "  [回滚] 删除本次新建的 nft 表 ${nft_tbl}"
                else
                    txn_resid "nft 表 ${nft_tbl} 没有删掉"
                fi
            fi
        fi
        # 4. 首次安装时，状态/日志/运行目录是守护进程刚建的：原先不存在的
        #    一并收掉（升级时它们本来就在，不动）。
        if [[ "$kind_of" == "install" ]]; then
            local _d _p _was
            for _d in "$LOG_DIR" "$RUN_DIR"; do
                [[ -e "$_d" ]] || continue
                _was=0
                for _p in "${pre_dirs[@]}"; do
                    [[ "$_p" == "$_d" ]] && _was=1
                done
                [[ "$_was" -eq 1 ]] && continue
                if rm -rf "$_d" 2>/dev/null; then
                    echo "  [回滚] 删除目录 ${_d}"
                else
                    txn_resid "目录没有删掉 ${_d}"
                fi
            done
        fi
    fi

    if [[ "$kind_of" == "uninstall" ]]; then
        # 卸载侧：先重建被 rmdir 的目录，再放回文件与整棵子树，最后移回状态。
        for ((i = 0; i < ${#ops[@]}; i++)); do
            [[ "${ops[$i]}" == "rmdir" ]] || continue
            local p="${opa[$i]}"
            if [[ ! -d "$p" ]]; then
                if mkdir -p "$p" && chmod "${opb[$i]:-755}" "$p"; then
                    echo "  [回滚] 重建目录 ${p}"
                else
                    txn_resid "目录没有重建 ${p}"
                fi
            fi
        done
        for ((i = ${#ops[@]} - 1; i >= 0; i--)); do
            case "${ops[$i]}" in
                saved)
                    if [[ ! -e "${opb[$i]}" ]]; then
                        txn_resid "备份不见了：${opb[$i]}"
                        continue
                    fi
                    mkdir -p "$(dirname "${opa[$i]}")" 2>/dev/null || true
                    if cp -a "${opb[$i]}" "${opa[$i]}" 2>/dev/null \
                       && cmp -s "${opb[$i]}" "${opa[$i]}"; then
                        echo "  [回滚] 放回 ${opa[$i]}"
                    else
                        txn_resid "没有放回 ${opa[$i]}"
                    fi ;;
                saved_dir)
                    if [[ ! -d "${opb[$i]}" ]]; then
                        txn_resid "备份不见了：${opb[$i]}"
                        continue
                    fi
                    rm -rf "${opa[$i]}" 2>/dev/null || true
                    mkdir -p "$(dirname "${opa[$i]}")" 2>/dev/null || true
                    if cp -a "${opb[$i]}" "${opa[$i]}" 2>/dev/null; then
                        echo "  [回滚] 放回目录 ${opa[$i]}"
                    else
                        txn_resid "没有放回目录 ${opa[$i]}"
                    fi ;;
            esac
        done
        for ((i = ${#ops[@]} - 1; i >= 0; i--)); do
            [[ "${ops[$i]}" == "moved" ]] || continue
            local src="${opa[$i]}" dst="${opb[$i]}"
            if [[ -e "$src" && ! -e "$dst" ]]; then
                # 改名还没发生（或失败在 mv 之前）：原位就是原状。
                continue
            fi
            if [[ ! -e "$dst" ]]; then
                txn_resid "移走的目录不在了：${dst}"
            elif [[ -e "$src" ]]; then
                txn_resid "原位置已被占用，未移回 ${src}"
            elif mv "$dst" "$src" 2>/dev/null; then
                echo "  [回滚] 移回 ${src}"
            else
                txn_resid "没有移回 ${src}"
            fi
        done
        systemctl daemon-reload >/dev/null 2>&1 || true
        case "$was_enabled" in
            enabled|enabled-runtime)
                systemctl enable "$svc" >/dev/null 2>&1 \
                    && echo "  [回滚] 恢复开机自启" \
                    || txn_resid "开机自启没有恢复" ;;
        esac
    else
        # 安装侧：文件按日志逆序恢复/删除；目录与权限随后处理。
        local -a mode_p=() mode_v=()
        for ((i = ${#ops[@]} - 1; i >= 0; i--)); do
            case "${ops[$i]}" in
                restore)
                    if [[ ! -e "${opb[$i]}" ]]; then
                        txn_resid "备份不见了：${opb[$i]}"
                        continue
                    fi
                    mkdir -p "$(dirname "${opa[$i]}")" 2>/dev/null || true
                    if cp -a "${opb[$i]}" "${opa[$i]}" 2>/dev/null \
                       && cmp -s "${opb[$i]}" "${opa[$i]}"; then
                        echo "  [回滚] 放回 ${opa[$i]}"
                    else
                        txn_resid "没有放回 ${opa[$i]}"
                    fi ;;
                remove)
                    if rm -f "${opa[$i]}" 2>/dev/null; then
                        echo "  [回滚] 删除 ${opa[$i]}"
                    else
                        txn_resid "没有删除 ${opa[$i]}"
                    fi ;;
                mode)
                    mode_p+=("${opa[$i]}"); mode_v+=("${opb[$i]}") ;;
            esac
        done
        systemctl daemon-reload >/dev/null 2>&1 || true
        for ((i = 0; i < ${#mode_p[@]}; i++)); do
            [[ -e "${mode_p[$i]}" ]] || continue
            chmod "${mode_v[$i]}" "${mode_p[$i]}" 2>/dev/null \
                && echo "  [回滚] 权限改回 ${mode_p[$i]} ${mode_v[$i]}" \
                || txn_resid "权限没有改回 ${mode_p[$i]}"
        done
        for ((i = ${#ops[@]} - 1; i >= 0; i--)); do
            [[ "${ops[$i]}" == "dir" ]] || continue
            local p="${opa[$i]}" own="${opb[$i]:-0}"
            [[ -e "$p" ]] || continue
            if [[ "$own" == "1" ]]; then
                rm -rf "$p" 2>/dev/null && echo "  [回滚] 删除目录 ${p}" \
                    || txn_resid "目录没有删掉 ${p}"
            elif rmdir "$p" 2>/dev/null; then
                echo "  [回滚] 删除目录 ${p}"
            else
                txn_resid "目录非空，留着 ${p}"
            fi
        done
        # 作业脚本可能已经被失败那次重启按新模板重织过。让插件入口按恢复后的
        #   旧模板再对齐一次 —— 基座这一侧只调 `plugin sync`，不认识插件内部。
        if [[ "$TXN_SELFTEST" -eq 0 && -x "$CLI" && -r "$CONF" ]]; then
            if "$CLI" plugin sync --config="$CONF" >/dev/null 2>&1; then
                echo "  [回滚] 作业脚本已按旧模板重织"
            else
                txn_resid "作业脚本没有重织"
            fi
        fi
    fi

    if [[ "$TXN_SELFTEST" -eq 0 && "$service_touched" == "1" \
          && "$was_active" == "active" ]]; then
        echo "  [回滚] 启动原来的服务"
        if systemctl start "$svc" >/dev/null 2>&1; then
            local dl=$((SECONDS + 20))
            while (( SECONDS < dl )); do
                [[ -S "$SOCKET" ]] && break
                sleep 0.5
            done
            if [[ -S "$SOCKET" ]]; then
                echo "  [回滚] 服务已回到运行状态"
            else
                txn_resid "服务没有回到运行状态"
                print_journal
            fi
        else
            txn_resid "服务没有启动"
            print_journal
        fi
    fi

    echo
    if (( ${#TXN_RESID[@]} == 0 && bad_middle == 0 )); then
        echo "  [ OK ] 已恢复原状：这次部署的改动全部撤回"
        txn_note "rolled-back" 2>/dev/null || true
        TXN_ACTIVE=0; TXN_FINISHED=1; TXN_ROLLING=0
        rm -rf "$dir"
        trap '_on_signal INT 130' INT
        trap '_on_signal TERM 143' TERM
        return 0
    fi
    if (( bad_middle != 0 )); then
        echo "  [FAIL] 日志中间有读不动的行，不能确认全部撤回了。"
    fi
    echo "  现场保留在 ${dir}；副本与日志都在里面，处理完再删除它。" >&2
    TXN_ACTIVE=0; TXN_FINISHED=1; TXN_ROLLING=0
    trap '_on_signal INT 130' INT
    trap '_on_signal TERM 143' TERM
    return 1
}

_on_signal() {
    local n="$1" code="$2"
    echo
    echo "  [中止] 收到信号 ${n}，这次部署没有走完。" >&2
    if [[ "$TXN_ACTIVE" -eq 1 && "$TXN_FINISHED" -eq 0 \
          && "$TXN_ROLLING" -eq 0 ]]; then
        txn_rollback "$TXN_DIR" "收到信号 ${n}"
    fi
    exit "$code"
}
trap '_on_signal INT 130' INT
trap '_on_signal TERM 143' TERM

_on_exit() {
    _cleanup_conf_merged
    if [[ "${TXN_ACTIVE:-0}" -eq 1 && "${TXN_FINISHED:-0}" -eq 0 \
          && "${TXN_ROLLING:-0}" -eq 0 ]]; then
        txn_rollback "${TXN_DIR}" "脚本提前退出"
    fi
}

# 内部自测：在临时目录里真跑一遍引擎。故意不依赖 root / systemd / nft。
_TXN_TEST_DIR=""
_txn_selftest() {
    TXN_SELFTEST=1
    local td pass=0 total=0 rc=0
    td="$(mktemp -d "${TMPDIR:-/tmp}/slurmate-txn-test.XXXXXX")" || return 1
    _TXN_TEST_DIR="$td"
    trap 'rm -rf "${_TXN_TEST_DIR:-}"' EXIT
    _t_ok() { total=$((total + 1)); pass=$((pass + 1)); }
    _t_no() { total=$((total + 1)); echo "  [FAIL] $1"; }

    mkdir -p "${td}/m/etc"
    printf 'old\n' > "${td}/m/etc/conf"
    chmod 640 "${td}/m/etc/conf"
    # 原模式当场量，不写死 755：`mkdir` 的结果跟着 umask 走，而运行自测的
    #   人可能把 umask 设成 077（这台开发机就是）。写死会把"恢复原模式"
    #   这条不变量测成"恰好是某个环境的缺省值"。
    local _etc_mode
    _etc_mode="$(stat -c %a "${td}/m/etc")"
    txn_begin install "${td}/w1" || _t_no "事务开始"
    txn_backup "${td}/m/etc/conf"
    printf 'new\n' > "${td}/m/etc/conf"
    chmod 600 "${td}/m/etc/conf"
    txn_backup "${td}/m/etc/new"
    printf 'x\n' > "${td}/m/etc/new"
    txn_mkdir_p "${td}/m/fresh/sub" 1
    printf 'y\n' > "${td}/m/fresh/sub/f"
    txn_mode "${td}/m/etc"
    chmod 700 "${td}/m/etc"
    txn_rollback "${td}/w1" "自测" >/dev/null 2>&1
    [[ "$(cat "${td}/m/etc/conf")" == "old" ]] && _t_ok || _t_no "覆盖后没有恢复内容"
    [[ "$(stat -c %a "${td}/m/etc/conf")" == "640" ]] && _t_ok || _t_no "覆盖后没有恢复模式"
    [[ ! -e "${td}/m/etc/new" ]] && _t_ok || _t_no "新增文件没有删掉"
    [[ ! -e "${td}/m/fresh" ]] && _t_ok || _t_no "新建目录没有删掉"
    [[ "$(stat -c %a "${td}/m/etc")" == "$_etc_mode" ]] && _t_ok || _t_no "目录模式没有恢复"

    mkdir -p "${td}/u/d1" "${td}/u/d2" "${td}/u/tree/a"
    printf 'data\n' > "${td}/u/d1/f"
    printf 't\n' > "${td}/u/tree/a/x"
    printf 's\n' > "${td}/u/state"
    txn_begin uninstall "${td}/w2"
    txn_save "${td}/u/d1/f"
    rm -f "${td}/u/d1/f"
    txn_rmdir "${td}/u/d2"
    txn_save_dir "${td}/u/tree"
    rm -rf "${td}/u/tree"
    txn_move "${td}/u/state" "${td}/u/.state.bak"
    txn_rollback "${td}/w2" "自测" >/dev/null 2>&1
    [[ -f "${td}/u/d1/f" ]] && _t_ok || _t_no "删掉的文件没有放回"
    [[ -d "${td}/u/d2" ]] && _t_ok || _t_no "删掉的目录没有重建"
    [[ -f "${td}/u/tree/a/x" ]] && _t_ok || _t_no "删掉的子树没有放回"
    [[ -f "${td}/u/state" && ! -e "${td}/u/.state.bak" ]] \
        && _t_ok || _t_no "移走的目录没有移回"

    mkdir -p "${td}/c"
    txn_begin install "${td}/w3"
    txn_backup "${td}/c/f"
    txn_commit
    [[ ! -d "${td}/w3" ]] && _t_ok || _t_no "提交后事务目录还在"

    mkdir -p "${td}/bad"
    printf 'old\n' > "${td}/bad/f"
    txn_begin install "${td}/w4"
    txn_backup "${td}/bad/f"
    printf 'new\n' > "${td}/bad/f"
    printf 'garbage\n' >> "${td}/w4/undo.log"
    printf 'remove\t%s\n' "${td}/bad/never" >> "${td}/w4/undo.log"
    txn_rollback "${td}/w4" "自测" >/dev/null 2>&1
    rc=$?
    [[ $rc -ne 0 && -d "${td}/w4" ]] && _t_ok || _t_no "中间坏行没有报残余"
    [[ "$(cat "${td}/bad/f")" == "old" ]] && _t_ok || _t_no "坏行之前的恢复没有做"

    txn_begin install "${td}/w5"
    txn_backup "${td}/bad/f"
    printf 'new\n' > "${td}/bad/f"
    printf 'partial' >> "${td}/w5/undo.log"
    txn_rollback "${td}/w5" "自测" >/dev/null 2>&1
    [[ $? -eq 0 && ! -d "${td}/w5" ]] && _t_ok || _t_no "末行截断没有按跳过处理"

    printf '事务自测：%d/%d 通过\n' "$pass" "$total"
    [[ "$pass" -eq "$total" ]]
}

if [[ "$MODE" == "txn-selftest" ]]; then
    _txn_selftest
    exit $?
fi

TS="$(date +%Y%m%d-%H%M%S)"
# --check 与 --doctor 都是"零改动"模式，快照放临时目录即可，不要在 /root 下攒一堆
#   目录。会改系统的模式放 /root：撤销日志与旧副本都在那里，成功即删。
if [[ "$MODE" == "check" || "$MODE" == "doctor" ]]; then
    WORK_DIR="/tmp/slurmate-${MODE}-${TS}"
else
    # 事务目录：快照、旧副本、撤销日志都在这里。成功即删，失败回滚后也删。
    WORK_DIR="/root/slurmate-deploy-${TS}"
fi

# ==============================================================================
step "阶段 0／6  预检（任何一项不满足即中止，不做任何改动）"
# ==============================================================================

[[ "$(id -u)" -eq 0 ]] || die "请以 root 运行：sudo bash ${SCRIPT_PATH}"
ok "以 root 运行"
if [[ "$DRYRUN" -eq 1 ]]; then
    info "演练模式（--dry-run）：不会安装文件、不会启动服务、不会改动 nftables"
fi

# ── 互斥：防止两个实例并发部署 ──
# 并发运行的后果：前后快照互相覆盖（"非干扰验证"的结论失去意义）、互相
# stop/start 对方的守护进程、同时 install 同一个文件（GNU install 是原地截断，
# 不是原子替换）—— 最坏情况留下一个被截断的脚本/二进制，被 Restart=always
# 反复重启。脚本本身可重入（重跑即恢复），但并发的验证结论没有意义。
if command -v flock >/dev/null 2>&1; then
    if [[ -d /run && -w /run ]]; then
        LOCK_FILE="/run/slurmate-deploy.lock"
    else
        LOCK_FILE="/tmp/.slurmate-deploy.lock"
    fi
    if exec 9>"$LOCK_FILE" 2>/dev/null; then
        if ! flock -n 9 2>/dev/null; then
            die "已有另一个部署脚本实例正在运行（锁：${LOCK_FILE}）。
     并发的部署无法给出可信的"非干扰"结论，也会互相干扰。请等它结束后再试。"
        fi
        info "已取得部署锁：${LOCK_FILE}"
    else
        warn "无法创建部署锁 ${LOCK_FILE}，跳过并发保护"
    fi
else
    warn "未找到 flock，无法防止并发部署；请自行确认没有另一个实例在运行"
fi

# ── 源文件清单与可信性 ──────────────────────────────────────────────────────
# 安装路径用它决定要不要自拷贝；卸载路径用它决定能不能执行同目录的
#   `conf-merge.py`（那个文件会以 root 跑）。
SRC_FILES=(slurmate-sessiond slurmate run.sbatch slurmate.conf.example slurmate-sessiond.service nft-compare.py conf-merge.py)
ALL_SRC_FILES=()
while IFS= read -r f; do
    [[ -n "$f" ]] && ALL_SRC_FILES+=("$f")
done < <(for f in "${SRC_FILES[@]}"; do printf '%s\n' "${SRC_DIR}/${f}"; done)

# 判据：每个源文件必须是 root 拥有，且组/其他不可写。
source_is_trusted() {
    local f st owner mode
    for f in "${ALL_SRC_FILES[@]}"; do
        st="$(stat -c '%U %a' "$f" 2>/dev/null)" || return 1
        owner="${st%% *}"; mode="${st##* }"
        [[ "$owner" == "root" ]] || return 1
        (( (8#${mode} & 8#022) == 0 )) || return 1
    done
    return 0
}

# ── 上一次没有走完的部署：自动收尾 ──────────────────────────────────────────
# kill -9 或断电不会留下 committed 标记。下一次任何会改系统的动词先把它回滚掉，
#   再继续；--check/--doctor 是只读的，只报告不动盘。
_txn_leftovers() {
    local d
    for d in /root/slurmate-deploy-*; do
        [[ -d "$d" ]] || continue
        [[ -s "$d/undo.log" ]] || continue
        grep -qx 'committed' "$d/undo.log" 2>/dev/null && continue
        printf '%s\n' "$d"
    done
}

if [[ "$MODE" == "rollback" ]]; then
    step "回滚：收尾一次没有走完的部署"
    [[ -d "$ROLLBACK_FROM" ]] || die "没找到事务目录：${ROLLBACK_FROM}"
    if [[ ! -f "${ROLLBACK_FROM}/undo.log" ]]; then
        info "这个目录里没有撤销日志，直接删掉现场。"
        rm -rf "$ROLLBACK_FROM"
        exit 0
    fi
    if grep -qx 'committed' "${ROLLBACK_FROM}/undo.log" 2>/dev/null; then
        info "这次部署已经提交过，只清理现场。"
        rm -rf "$ROLLBACK_FROM"
        exit 0
    fi
    txn_rollback "$ROLLBACK_FROM" "管理员收尾"
    exit $?
fi

if [[ "$MODE" == "check" || "$MODE" == "doctor" || "$DRYRUN" -eq 1 ]]; then
    while IFS= read -r _d; do
        [[ -n "$_d" ]] || continue
        warn "上一次部署没有走完：${_d}"
        warn "      收尾：sudo bash ${SCRIPT_PATH} --rollback ${_d}"
    done < <(_txn_leftovers)
else
    for _d in /root/slurmate-deploy-*; do
        [[ -d "$_d" ]] || continue
        if [[ ! -s "$_d/undo.log" ]] \
           || grep -qx 'committed' "$_d/undo.log" 2>/dev/null; then
            rm -rf "$_d"
        fi
    done
    while IFS= read -r _d; do
        [[ -n "$_d" ]] || continue
        info "发现上一次没有走完的部署：${_d}，先回滚它。"
        if ! txn_rollback "$_d" "上一次部署没有走完"; then
            die "上一次部署的现场没有恢复干净（见上）。处理完再重试。"
        fi
        info "已恢复上一次部署之前的原状。"
    done < <(_txn_leftovers)
fi

# ==============================================================================
#  卸载：放在最前面，且只要求 root
# ==============================================================================
#  卸载必须【永远可用】—— 不能因为基线不完整、源文件缺失、配置损坏而拦不住。
#  出故障时管理员最需要的就是能干净地把它拿掉。
#  它也是一次事务：删每一样之前先写撤销记录；中途失败按日志恢复。
if [[ "$MODE" == "uninstall" ]]; then
    step "卸载"

    if [[ "$DRYRUN" -eq 1 ]]; then
        info "[演练] 卸载会停服务、删表、删文件；本次没有改动任何文件。"
        exit 0
    fi

    _conf_ours() {
        # 站点配置从第一版起就不含产品名，`grep slurmate` 永远不匹配。
        #   判据用安装前那一个：它问的是"这看起来像不像本站的配置"。
        local f="$1"
        [[ -f "${SELF_DIR}/conf-merge.py" \
           && -f "${SELF_DIR}/slurmate.conf.example" ]] || return 1
        # 要执行同目录里的脚本，判据与安装前的自拷贝一致。
        source_is_trusted || return 1
        "$PY" "${SELF_DIR}/conf-merge.py" --looks-like-config "$f" \
            --example "${SELF_DIR}/slurmate.conf.example" >/dev/null 2>&1
    }

    txn_begin uninstall "$WORK_DIR" \
        || die "无法建立事务目录 ${WORK_DIR}，没有删除任何文件。"

    info "停止并禁用服务"
    txn_note "meta" "service_touched" "1"
    txn_note "meta" "enabled_touched" "1"
    systemctl disable --now "$SERVICE" 2>/dev/null || true

    # 必须确认服务真的停了再删表和文件。否则：
    #   - 删表后守护进程下一个 tick 就把表重建回来
    #   - 删掉二进制后已加载的进程仍在运行、仍在改 nft
    if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
        die "服务 ${SERVICE} 仍在运行，卸载中止（先手动停掉再试）：
     systemctl stop ${SERVICE}"
    fi
    ok "服务已停止"

    # 删 nft 表（只删自己那张；表名是本系统独有的，不存在歧义）
    if command -v nft >/dev/null 2>&1; then
        if nft list table inet slurmate >/dev/null 2>&1; then
            nft delete table inet slurmate \
                || die "删除 nft 表失败（正在回滚）"
            ok "已删除 nft 表 inet slurmate"
        else
            info "nft 表 inet slurmate 不存在，跳过"
        fi
    fi

    # ── 插件：先整棵备份，再交给卸载器 ────────────────────────────────
    # 卸载器知道一个插件在站点上留下的每一处痕迹；本脚本只负责在它动手前
    #   把三棵目录整棵留一份，失败时能整棵放回。
    txn_save_dir "${SHARE_DIR}/plugins" || die "无法备份插件目录（正在回滚）"
    txn_save_dir "${SHARE_DIR}/jobs" || die "无法备份作业脚本目录（正在回滚）"
    txn_save_dir "${CONF_DIR}/slurmate.conf.d" \
        || die "无法备份插件配置目录（正在回滚）"
    if [[ -x "$DAEMON" ]]; then
        if "$PY" "$DAEMON" --uninstall-plugins --all-plugins \
                 --config="$CONF" >/dev/null 2>&1; then
            ok "已卸掉本站的全部插件（包 / 它们的配置 / 作业脚本 / 钥匙记录）"
        else
            die "插件卸载器没有跑完（正在回滚到卸载前）"
        fi
    else
        info "没找到已装的守护进程，跳过插件卸载（本机可能只装了一半）"
    fi

    # 删文件前逐项确认"这确实是本系统装的文件"。
    # 站点配置单独判：它按设计就不含产品名。
    for f in "$DAEMON" "$CLI" "$CONF" "$UNIT" "${SHARE_DIR}/nft-compare.py" \
             "${SHARE_DIR}/run.sbatch.template"; do
        if [[ ! -e "$f" ]]; then
            continue
        fi
        if [[ "$f" == "$CONF" ]]; then
            if ! _conf_ours "$f"; then
                warn "跳过 ${f}：它不像本站的站点配置，不敢删"
                warn "      如确认要删请人工执行：rm -f '$f'"
                continue
            fi
        elif ! grep -qi "slurmate" "$f" 2>/dev/null; then
            warn "跳过 ${f}，它存在但内容不含 \"slurmate\"，不像本系统装的文件，不敢删"
            warn "      如确认要删请人工执行：rm -f '$f'"
            continue
        fi
        txn_save "$f" || die "无法备份 ${f}（正在回滚）"
        rm -f "$f" || die "删除 ${f} 失败（正在回滚）"
        ok "已删除 ${f}"
    done

    # 只在目录为空时才删 —— 里面若有别人放的文件就留着。
    for d in "$SHARE_DIR" "$CONF_DIR"; do
        if [[ -d "$d" ]] && ! txn_rmdir "$d"; then
            warn "${d} 非空，留着（里面不全是本系统的文件）"
        fi
    done
    rm -f "$SOCKET" 2>/dev/null || true

    if [[ "$PURGE" -eq 1 ]]; then
        txn_purge_dir "$STATE_DIR" || die "状态目录未能移进回收区（正在回滚）"
        txn_purge_dir "$LOG_DIR" || die "日志目录未能移进回收区（正在回滚）"
        info "按 --purge-state 删除状态与日志：${STATE_DIR} ${LOG_DIR}"
    else
        info "状态与日志已保留：${STATE_DIR} ${LOG_DIR}（如需删除加 --purge-state）"
    fi

    if ! systemctl daemon-reload 2>/dev/null; then
        die "systemctl daemon-reload 失败（正在回滚）"
    fi
    txn_commit
    echo
    echo "  卸载完成。本系统之外的一切均未受影响，其他 nft 表、其他服务、"
    echo "  sshd 配置与 sudoers 都没有被本脚本改动过。"
    exit 0
fi


for f in "${SRC_FILES[@]}"; do
    [[ -f "${SRC_DIR}/${f}" ]] || die "源文件缺失：${SRC_DIR}/${f}（cluster/ 目录是否完整？）"
done
ok "源文件齐备（${SRC_DIR}）"

# 源文件的哈希串（只有内容，不含路径 —— 拷贝到 root 专属目录之后路径会变，
# 而要比的是内容有没有变）。顺序由同一个列表保证，所以两边可比。
src_hash_all() {
    local f out=""
    for f in "${ALL_SRC_FILES[@]}"; do
        out="${out}$(sha256sum "$f" 2>/dev/null | awk '{print $1}') "
    done
    printf '%s' "$out"
}

# ── 非干扰比对器自测 ──
# 只检查退出码是不够的：把测试【删掉】之后，剩下的测试仍然"全通过"，而部署
# 脚本会据此宣称"比对器可信" —— 判定能力已经被削弱，报告却更绿了。
# 所以这里既解析真实项数（打印出来，不再写死一个会过期的数字），又断言项数
# 不低于下限：少一项就拒绝部署。下限与比对器一起维护，改动比对器时同步更新。
COMPARATOR_MIN_TESTS=23
SELFTEST_COUNT=""
comparator_selftest() {
    local script="$1" out n
    out="$("$PY" "$script" --selftest 2>&1)" || {
        printf '%s\n' "$out" | grep -E "FAIL|失败" | sed 's/^/        /' >&2
        return 1
    }
    n="$(printf '%s\n' "$out" | sed -n 's|.*自测：\([0-9][0-9]*\)/.*|\1|p' | tail -1)"
    if ! [[ "$n" =~ ^[0-9]+$ ]]; then
        echo "  无法从自测输出解析项数（输出格式变了？）：" >&2
        printf '%s\n' "$out" | sed 's/^/        /' >&2
        return 1
    fi
    if (( n < COMPARATOR_MIN_TESTS )); then
        echo "  自测项数 ${n} 低于下限 ${COMPARATOR_MIN_TESTS}，测试可能被删减，拒绝部署" >&2
        return 1
    fi
    SELFTEST_COUNT="$n"
    return 0
}

if source_is_trusted; then
    # 绿灯只在真正可信时打印：若警告分支之后再跟一行【无条件】的 ok，"源码不属于
    # root"的警告就会和"源文件可信"的绿灯同时出现，而绿灯是假的。安全闸门本身
    # 给出假绿，正是本脚本最该避免的失效模式。
    ok "源文件可信（root 拥有且组/其他不可写）"
elif [[ "$MODE" == "check" ]]; then
    # --check 承诺"零改动"，它既不安装也不执行任何文件，所以不需要自拷贝。
    # 实际部署时脚本会先自拷贝到 root 专属目录。
    warn "源码不属于 root，实际部署时会先自拷贝到 root 专属目录再执行"
    warn "      （--check 不安装、不执行任何文件，因此继续体检）"
elif [[ "${SLURMATE_SRC_REEXEC:-0}" == "1" ]]; then
    die "即便自拷贝到 root 专属目录后，源文件仍不可信。请人工检查 ${SRC_DIR}。"
else
    warn "源码目录不属于 root 或可被他方改写："
    warn "      ${SRC_DIR}  (属主 $(stat -c '%U:%G %a' "${SRC_DIR}" 2>/dev/null))"
    warn "  本脚本会以 root 安装并执行这些文件，必须先固定下来。"
    info "正在自拷贝到 root 专属目录并重新执行……"

    # 自拷贝目标若落在源码目录内部，会变成"把目录拷进自己里面"的无限递归
    # （例如管理员把整个仓库放在 /root 下直接运行）。这种情况改用 /var/tmp。
    SECURE_TPL="/root/slurmate-src.XXXXXX"
    if [[ "${SELF_DIR}" == "/" || "${SELF_DIR}" == "/root" ]]; then
        SECURE_TPL="/var/tmp/slurmate-src.XXXXXX"
        info "源码位于 ${SELF_DIR}，自拷贝目标改到 /var/tmp 以避免拷进自身"
    fi
    SECURE_DIR="$(mktemp -d "$SECURE_TPL")" || die "无法创建 root 专属临时目录"
    chmod 700 "$SECURE_DIR"

    # 先记录源文件哈希，拷贝后比对，缩窄"检查与使用之间被掉包"的窗口
    BEFORE_HASH="$(src_hash_all)"
    # 布局照搬一层（cluster/）：只有一个目录要拷。
    mkdir -p "${SECURE_DIR}/cluster"
    cp -a "${SELF_DIR}/." "${SECURE_DIR}/cluster/" || die "拷贝源码失败"
    # 拷贝后重建路径列表（路径变了，而要比的是内容）
    SRC_DIR="${SECURE_DIR}/cluster"
    ALL_SRC_FILES=()
    while IFS= read -r f; do
        [[ -n "$f" ]] && ALL_SRC_FILES+=("$f")
    done < <(for f in "${SRC_FILES[@]}"; do printf '%s\n' "${SRC_DIR}/${f}"; done)

    chown -R root:root "$SECURE_DIR" || die "无法把拷贝的源码改为 root 所有，拒绝继续"
    chmod -R go-w "$SECURE_DIR" || die "无法收紧拷贝源码的权限，拒绝继续"
    # 注意：源文件与 install-base.sh 同在 cluster/ 下（所以这里是 ${SECURE_DIR}/cluster）。
    # 这里若写死成别的目录名，从非 root 目录部署会走进这条自拷贝分支、然后在这里
    # 静默拿到空哈希。
    AFTER_HASH="$(src_hash_all)"
    if [[ -z "${BEFORE_HASH// /}" || "$BEFORE_HASH" != "$AFTER_HASH" ]]; then
        rm -rf "$SECURE_DIR"
        die "拷贝过程中源文件发生了变化（或哈希一个都没拿到）。可能存在并发篡改，已中止。"
    fi
    ok "已自拷贝到 ${SECURE_DIR}（root 专属，用户不可改写）"
    info "源文件哈希：${AFTER_HASH}"

    # 必须先释放部署锁再重新执行：fd 会被 exec 继承，而 flock 对【同一文件的
    # 另一个 fd】会拒绝加锁 —— 不释放的话，新实例会锁不上自己的锁，报
    # "已有另一个实例在运行" 然后退出。源文件不属于 root 时（也就是从共享
    # 目录直接部署的常见情况）走的就是这条路径。
    if [[ -n "${LOCK_FILE:-}" ]]; then
        flock -u 9 2>/dev/null || true
        exec 9>&- 2>/dev/null || true
    fi

    # 用 basename 而不是写死文件名 —— 将来再改脚本名时这里不会成为暗礁。
    SLURMATE_SRC_REEXEC=1 SLURMATE_ORIG_SCRIPT="${SELF_SCRIPT}" \
        exec bash "${SECURE_DIR}/cluster/$(basename "${BASH_SOURCE[0]}")" "$@"
fi
info "源文件哈希（可记录备查）：$(for f in "${ALL_SRC_FILES[@]}"; do sha256sum "$f" 2>/dev/null | awk '{printf "%s ", substr($1,1,12)}'; done)"

# 源码里的那一份守护进程。下面每一次自检、每一次插件操作走的都是它——
# 不是刚装到 ${DAEMON} 的那一份。
#
# 为什么用源码里这一份：`${DAEMON}` 在"第一次部署"时还不存在，而在"升级部署"
#   时它是上一个版本。用旧版本去校验新版本的配置/模板，失败方式会是一句看不懂
#   的报错（或者更糟：它恰好收下了）。源码这一份永远与本次部署的规则同源。
#   放在这里而不是文件开头：上面那条自拷贝分支会把 SRC_DIR 改掉。
DAEMON_SRC="${SRC_DIR}/slurmate-sessiond"

# 这一次要拿给守护进程自检的那份配置：已经装过就读已装的那份（管理员可能
# 按站点改过），否则读随仓库分发的示例。
#
# 它在自拷贝之后才算，这一点是承重的：若这一行放在文件开头，从
#   非 root 目录部署、走进自拷贝分支时，它就会仍然指着原来那个（别人能改写的）
#   示例文件 —— 而那份配置后面会被读出来给守护进程自检。
#   判据是"我读的这一份必须来自我已经固定下来的目录"。
SRC_CONF="${SRC_DIR}/slurmate.conf.example"

# 这一份装上去之后，站点配置会长成什么样。体检、安装、修复都读合并后的那一份
#   —— 它们要回答的是"装上去能不能起来"。诊断（--doctor）不合并：它报的是这
#   台机器现在的样子，把配置悄悄换成"将会是什么"就不是诊断了。
#
# 为什么要合并：站点配置的取值归管理员，键集合归版本。旧配置里这一版不认的键
#   会让守护进程拒绝启动（`validate()` 对认不出的键是拒绝，不是忽略），而
#   0.22 的配置里 `cluster_cidr` 与 `readonly_paths` 正是这种键。整份保留
#   等于升级必失败；整份覆盖等于把管理员改过的取值抹掉。所以两件事分开：
#   取值不动，键对齐（`conf-merge.py`）。
CONF_MERGED=""
CONF_MERGE_NOTE=""
# 装上去要动的只有键：取值一个不改。这一格只回答"配置文件会不会被写一次"。
CONF_DIFF=0
_cleanup_conf_merged() { [[ -n "$CONF_MERGED" ]] && rm -f "$CONF_MERGED"; }
trap '_on_exit' EXIT
if [[ -r "$CONF" ]]; then
    SRC_CONF="$CONF"
    if [[ "$MODE" != "doctor" ]]; then
        CONF_MERGED="$(mktemp "${TMPDIR:-/tmp}/slurmate-conf.XXXXXX")" \
            || die "无法创建临时文件（站点配置对账）"
        if ! CONF_MERGE_NOTE="$("$PY" "${SRC_DIR}/conf-merge.py" \
                 --installed "$CONF" \
                 --example "${SRC_DIR}/slurmate.conf.example" \
                 --out "$CONF_MERGED" 2>&1)"; then
            die "站点配置对账失败：${CONF_MERGE_NOTE}"
        fi
        SRC_CONF="$CONF_MERGED"
        if ! cmp -s "$CONF" "$CONF_MERGED"; then
            CONF_DIFF=1
        fi
        if [[ -n "$CONF_MERGE_NOTE" ]]; then
            # 体检一个字都不改，所以这里说的是"装上时会做什么"，不是"做了什么"。
            if [[ "$MODE" == "check" ]]; then
                info "站点配置对账（${CONF}）。（体检不改文件，以下是装上时会做的）"
            else
                info "站点配置对账（${CONF}）："
            fi
            printf '%s\n' "$CONF_MERGE_NOTE" | sed 's/^/        /'
        fi
    fi
fi

# 非干扰比对器自身先自测 —— 依赖一个判定器之前，先证明它是对的
if comparator_selftest "${SRC_DIR}/nft-compare.py"; then
    ok "非干扰比对器自测通过（${SELFTEST_COUNT} 项，下限 ${COMPARATOR_MIN_TESTS}）"
else
    die "非干扰比对器 ${SRC_DIR}/nft-compare.py 自测未通过，无法保证部署安全性，已中止"
fi

# ── Python ──
[[ -x "$PY" ]] || die "未找到 ${PY}"
PYV="$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "?")"
"$PY" - <<'PYEOF' >/dev/null 2>&1 || die "Python 缺少必需能力（socket.SO_PEERCRED / sqlite3）"
import socket, sqlite3, json, configparser
assert socket.SO_PEERCRED
PYEOF
ok "Python ${PYV} 且具备 SO_PEERCRED / sqlite3"

# ── nft ──
[[ -x "$NFT" ]] || die "未找到 nft"
"$NFT" list tables >/dev/null 2>&1 || die "nft 不可用（无法列出规则表）"
ok "nft 可用：$("$NFT" --version 2>&1 | head -1)"

# 必须能在部署【之前】就确认 nft -j 可用 —— 否则部署结束时的非干扰比对
# 会退化成"两份空快照判为一致"的假绿（这个坑踩过）。
# 宁可现在拒绝部署，也不要事后给一个证明不了任何东西的绿灯。
if ! "$NFT" -j list ruleset >/dev/null 2>&1; then
    die "nft -j（JSON 输出）不可用，无法做非干扰比对。
     没有这道校验就无法证明部署没有破坏现有规则，因此拒绝部署。
     请升级 nftables，或人工确认后再考虑其他方案。"
fi
NJSON="$("$NFT" -j list ruleset 2>/dev/null | head -c 64)"
if [[ "$NJSON" != *'"nftables"'* ]]; then
    die "nft -j list ruleset 的输出不是预期的 JSON 结构，无法做非干扰比对：${NJSON}"
fi
ok "nft -j 可用且输出结构正常（非干扰比对有效）"

# ── sha256sum（文件哈希校验要用）──
command -v sha256sum >/dev/null 2>&1 || die "未找到 sha256sum，无法校验现有文件是否被改动"
ok "sha256sum 可用"

# ── 目标位置是否已被非本系统的文件占用 ──
#
# 这一条留在本脚本里，它没有第二份实现也不该有：它问的是"我要写的那几个
#   位置现在是谁的"，只有要写它们的人知道这件事。`--check` 判不了它
#   （守护进程不知道自己是不是被覆盖着装上的，也不该知道）。
for dst in "$DAEMON" "$CLI" "$UNIT"; do
    if [[ -e "$dst" ]]; then
        if ! grep -qi "slurmate" "$dst" 2>/dev/null; then
            die "目标文件已存在且不属于 Slurmate：
       ${dst}
     为避免覆盖他人文件，部署中止。请人工确认后自行删除或改名再重试。"
        fi
    fi
done
# 站点配置单独判：它里面只有键与值，从第一版起就一个字节都不提产品名。
#   拿"内容含 slurmate"套它，第一台装过基座的机器上就会中止，而那个中止
#   被说成"别人的文件"—— 这正是 0.22 升 0.23 时发生的事。
if [[ -e "$CONF" ]] \
   && ! "$PY" "${SRC_DIR}/conf-merge.py" --looks-like-config "$CONF" \
            --example "${SRC_DIR}/slurmate.conf.example" >/dev/null 2>&1; then
    die "目标文件已存在且不属于 Slurmate：
       ${CONF}
     为避免覆盖他人文件，部署中止。请人工确认后自行删除或改名再重试。"
fi
# 作业脚本目录与插件目录不在这张表里：它们不归本脚本管（见文件头），
# 而各自的守卫长在安装器那一侧（它才是往里面写的人）。
ok "目标路径未被他人文件占用"

# ==============================================================================
#  「这台机器对不对、这份配置对不对」—— 一律问守护进程自己
# ==============================================================================
#
#   这里若再自己判一遍，就成了孪生实现：端口区间自洽、与 reserved_ranges
#   相交、Slurm 命令齐备、控制器可达 —— 每一条守护进程都判过一遍（`validate()`
#   与 `--check`）。同一个不变量两份实现会漂开，而漂开的症状是"预检放行了、
#   守护进程起不来"（或者反过来）。这里只剩一次调用。
#
#   而它的两个退出码要分开对待，这正是"部署脚本也要能读它"的原因：
#
#        2 = 这台机器缺东西（缺 Slurm 命令、缺 nft）
#            现在就停。装文件之前就停 —— 那正是本脚本开头那句
#              「任何一项不满足即中止，不做任何改动」。
#        1 = 这份配置写错了
#            停。第一次部署读的是随包发出来的示例配置，它必须过得了自检 ——
#              过不了就是打包的问题，不是这一台机器的问题。（0.23 之前这里有
#              一条例外：示例里 `cluster_cidr` 空着，而那一格非填不可，所以第一次
#              部署那一次允许它不通过。那个键删掉之后，这条例外没有了。）
#
#   退出码 2 这个约定写在守护进程那一侧（见 `machine_selfcheck()`），
#     这里是唯一的读者。
#   `--dry-run` 下照跑：它是只读的，而"演练"要回答的正是"真跑起来会怎样"
#     —— 演练时把最该发现的那件事藏起来，那个演练就没有意义。
#
#   过了就只打一行：完整那一屏〈阶段 3〉还会再打一次（那一次读的是刚落盘的
#     站点配置），在这里重复一遍只会把别的信息淹掉。没过才把输出打出来。
_check_out="$("$PY" "$DAEMON_SRC" --check --config="$SRC_CONF" 2>&1)"
_check_rc=$?
_check_dump() { printf '%s\n' "$_check_out" | sed 's/^/        /' >&2; }
# 下面那几处"必须先解决它"的东西，在诊断模式里是【诊断的对象】，不是中止的
#   理由 —— 一台配置坏掉的机器正是最该把整份对账打完的地方。体检、安装、修复
#   照旧中止：前一条路什么都不改（它的结论就是"能不能装"），后两条马上要改。
_check_stop() {
    _check_dump
    if [[ "$MODE" == "doctor" ]]; then
        warn "$1"
        warn "  （诊断继续：下面会把这些逐条查完）"
        return 0
    fi
    die "$1"
}
case "$_check_rc" in
    0)
        ok "自检通过（用的是 ${SRC_CONF}）" ;;
    2)
        _check_stop "这一台机器缺少必需组件（见上，标着 ✗ 的那几条）。
     装文件之前必须先解决它。本脚本的承诺是「不满足即中止，不做任何改动」。
     它问的是「这台机器上有没有 nft、有没有那八个 Slurm 命令」，
     与你要装什么版本的 Slurmate 无关。" ;;
    1)
        if [[ -n "$CONF_MERGED" ]]; then
            _check_stop "站点配置对账之后仍然过不了自检（见上）。上面那一份是
     管理员的取值加上这一版的键；把 ${CONF} 就地改对再重跑本脚本，部署中止，
     一个字节都没有改。"
        elif [[ "$SRC_CONF" == "$CONF" ]]; then
            _check_stop "已装的站点配置 ${CONF} 自检没通过（见上）。重复部署时它必须是
     对的，部署中止，一个字节都没有改。改完重跑本脚本。"
        else
            _check_stop "包里的示例配置 ${SRC_CONF} 自检没通过（见上）。这不该发生：
     它是跟着守护进程一起发出来的那一份，示例配置过不了自检就是打包的问题，
     与这一台机器无关。部署中止，一个字节都没有改。"
        fi ;;
    *)
        _check_stop "自检无法运行（退出码 ${_check_rc}，见上）。多半是 ${DAEMON_SRC}
     本身有问题，而此时正是最该停下来的时候。" ;;
esac

# ── 「控制器可达吗」也不在这里 ──
# 它上面那次 `--check` 已经问过、也打印了结论（`控制器 : 在线 / 【连不上】…`），
#    连同"提交与回收会失败"这句后果。本脚本再 `scontrol ping` 一次就是同一件
#    事的第二份实现 —— 而两份探测之间可以变，于是它们还能给出互相矛盾的答案
#    （"上面说连不上、下面说可达"），那正是让人不再相信报告的开始。
#
#    这一条刻意不是 `validate()` 的硬错误：控制器抖一下不该让整个站点起
#      不来（那连"停掉正在跑的会话"都做不到）。所以 `--check` 只是打印它，
#      退出码不受影响 —— 部署照常继续。

# ── 可选基线检查：本系统最初部署环境的其余端口管理设施 ──
# Slurmate 不依赖它们（独立的 nft 表、独立的端口区间、独立的服务），
# 别人的集群上没有这些是正常的，所以默认只提示、不中止。
# 若你的场景是"我确认这台机器上就应该有它们，缺了说明我搞错了机器"，
# 加 --require-baseline 把警告升级为中止。
BASE_MISSING=()
"$NFT" list table inet codeserver >/dev/null 2>&1 || BASE_MISSING+=("nft 表 inet codeserver")
"$NFT" list table ip port-daemon  >/dev/null 2>&1 || BASE_MISSING+=("nft 表 ip port-daemon")
[[ -x /usr/local/bin/codeserver-nft-helper ]]     || BASE_MISSING+=("codeserver-nft-helper")
[[ -d /tmp/codeserver-ports ]]                   || BASE_MISSING+=("锁目录 /tmp/codeserver-ports")
for s in port-daemon port-query codeserver-port-cleanup; do
    systemctl is-active --quiet "$s" 2>/dev/null || BASE_MISSING+=("服务 $s 未运行")
done
if [[ ${#BASE_MISSING[@]} -gt 0 ]]; then
    for m in "${BASE_MISSING[@]}"; do
        warn "可选设施不在位：$m"
    done
    if [[ "$REQUIRE_BASELINE" -eq 1 ]]; then
        die "基线不完整，且指定了 --require-baseline。去掉该开关可继续部署。"
    fi
    info "以上均与 Slurmate 零耦合，继续部署。"
else
    ok "可选基线完整"
fi

info "本次工作目录：${WORK_DIR}"

# ==============================================================================
#  对账：诊断与修复共用的一份判据
# ==============================================================================
#
#  "该在的都在不在、内容与包内那一份是否相同"只写这一份：诊断拿它只读地报告，
#    修复拿它选活干、装完再拿它验一遍。写成两份的话，迟早出现"诊断说这一件
#    不同、修复去修另一件"这种两半互相矛盾的状态。
#
#  它只认识本脚本自己会装的那几个路径（上面〈路径〉那一节）—— 另起一份路径
#    清单就是第二个写方，而两个写方可以各自漂开。
#
#  每一格失败后面跟一句"下一步"。只说不对、不说去哪儿看和敲哪条命令的诊断，
#    等于把活儿原样丢回去。
A_PASS=0; A_WARN=0; A_FAIL=0
A_BAD=()
_A_PRE_BAD=()
a_ok()   { A_PASS=$((A_PASS+1)); echo "  [ OK ] $*"; }
a_warn() { A_WARN=$((A_WARN+1)); A_BAD+=("$1"); echo "  [WARN] $1：$2"; }
a_bad()  { A_FAIL=$((A_FAIL+1)); A_BAD+=("$1"); echo "  [FAIL] $1：$2"; }
a_hint() { echo "         → $*"; }
audit_reset() { A_PASS=0; A_WARN=0; A_FAIL=0; A_BAD=(); }

# 文档与这一份包一起分发（`--extract` 解压看）。两种跑法（自解压包、仓库里
#   直接跑）指的路径不同，所以基准目录只算这一次。
DOC_DIR="${SRC_DIR}/docs"

# 一件该在的文件：路径、模式、内容（`src` 传空 = 不比内容）。
#
#   内容比不了的那一件有理由：站点配置是管理员按本站改过的（比字节只会每次都
#   报不同）。它只比存在与权限。
audit_file() {
    local name="$1" path="$2" mode="$3" src="$4" st perm h_here h_src
    if [[ ! -e "$path" ]]; then
        a_bad "$name" "未找到 ${path}"
        a_hint "装回去：sudo bash ${SCRIPT_PATH} --repair"
        return
    fi
    st="$(stat -c '%U:%G %a' "$path" 2>/dev/null || echo '?')"
    perm="${st##* }"
    if [[ "${st%% *}" != "root:root" || "$perm" != "$mode" ]]; then
        a_bad "$name" "${path} 现在是 ${st}，该是 root:root ${mode}"
        a_hint "改回去：sudo bash ${SCRIPT_PATH} --repair"
        return
    fi
    if [[ -n "$src" ]]; then
        h_here="$(sha256sum "$path" 2>/dev/null | awk '{print $1}')"
        h_src="$(sha256sum "$src" 2>/dev/null | awk '{print $1}')"
        if [[ -z "$h_here" || "$h_here" != "$h_src" ]]; then
            a_bad "$name" "${path} 的内容与包内那一份不同"
            a_hint "改回包内那一份：sudo bash ${SCRIPT_PATH} --repair"
            a_hint "（站点配置的取值与状态数据不在被改的范围内）"
            return
        fi
    fi
    a_ok "$name  ${path}  root:root ${mode}"
}

# 一个该在的目录：路径与模式。
audit_dir() {
    local name="$1" path="$2" mode="$3" st perm
    if [[ ! -d "$path" ]]; then
        a_bad "$name" "未找到目录 ${path}"
        a_hint "建回去：sudo bash ${SCRIPT_PATH} --repair"
        return
    fi
    st="$(stat -c '%U:%G %a' "$path" 2>/dev/null || echo '?')"
    perm="${st##* }"
    if [[ "${st%% *}" != "root:root" || "$perm" != "$mode" ]]; then
        a_bad "$name" "${path} 现在是 ${st}，该是 root:root ${mode}"
        a_hint "改回去：sudo bash ${SCRIPT_PATH} --repair"
        return
    fi
    a_ok "$name  ${path}  root:root ${mode}"
}

# 该看哪一份文档。都对得上时一个字都不说（说人话：没事就别占读者的眼睛）。
audit_pointers() {
    if [[ "$A_FAIL" -eq 0 && "$A_WARN" -eq 0 ]]; then
        info "对账干净：没有发现需要处理的地方。"
        return
    fi
    echo
    echo "  该看哪一份（都在这份包里：sudo bash ${SCRIPT_PATH} --extract /tmp/slurmate-docs）"
    echo "    文件、目录、权限        ${DOC_DIR}/DEPLOYMENT.md"
    echo "    服务、会话、nft 规则    ${DOC_DIR}/TROUBLESHOOTING.md"
    echo "    插件安装失败、无法分发  ${DOC_DIR}/PLUGIN-TROUBLESHOOTING.md"
    echo "    配置键与取值            ${DOC_DIR}/CONFIGURATION.md"
}

# 装出问题的那几样，在两轮对账之间对一次名字 —— 修复的那句"修好了"只能这么
#   说：不是"我装了所以应该好了"，是"同一份判据现在说它对上了"。
audit_diff() {
    local n fixed=() still=()
    for n in "${_A_PRE_BAD[@]}"; do
        if printf '%s\n' "${A_BAD[@]}" | grep -qxF -- "$n"; then
            still+=("$n")
        else
            fixed+=("$n")
        fi
    done
    local i
    if [[ ${#fixed[@]} -gt 0 ]]; then
        i="$(printf '%s、' "${fixed[@]}")"
        ok "已修好：${i%?}"
    fi
    if [[ ${#still[@]} -gt 0 ]]; then
        i="$(printf '%s、' "${still[@]}")"
        bad "仍未修好：${i%?}"
    fi
    if [[ "$DRYRUN" -eq 1 && ${#fixed[@]} -gt 0 ]]; then
        info "（本次是演练：上面报的不对，是因为什么都没有真的改。）"
    fi
}

# 一遍完整的对账。`full` 连运行期那一半一起查，`static` 只查盘上的东西 ——
#   修复后那一遍用 static：服务与 socket 刚在〈阶段 5〉查过，再查一遍只是把
#   同一件事说两次。
audit_installed() {
    local how="${1:-full}" v_pkg="" v_inst="" out="" i=""

    audit_reset
    echo
    echo "  一、装的是哪一份"
    v_pkg="$("$PY" "$DAEMON_SRC" --version 2>/dev/null | head -1)"
    if [[ -x "$DAEMON" ]]; then
        v_inst="$("$DAEMON" --version 2>/dev/null | head -1)"
    fi
    if [[ -z "$v_inst" ]]; then
        a_bad "版本" "已装的守护进程没有报出版本（${DAEMON} --version）"
        a_hint "装这一份进去：sudo bash ${SCRIPT_PATH}"
    elif [[ -n "$v_pkg" && "$v_inst" != "$v_pkg" ]]; then
        a_warn "版本" "装着的是 ${v_inst}，这一份包里是 ${v_pkg}"
        a_hint "对齐到这一份：sudo bash ${SCRIPT_PATH} --repair"
    else
        a_ok "版本 ${v_inst}（包内那一份也是它）"
    fi

    echo
    echo "  二、该在的文件"
    audit_file "守护进程"   "$DAEMON" 755 "${SRC_DIR}/slurmate-sessiond"
    audit_file "命令行"     "$CLI"    755 "${SRC_DIR}/slurmate"
    audit_file "比对器"     "${SHARE_DIR}/nft-compare.py" 644 "${SRC_DIR}/nft-compare.py"
    audit_file "作业模板"   "${SHARE_DIR}/run.sbatch.template" 644 "${SRC_DIR}/run.sbatch"
    audit_file "systemd 单元" "$UNIT" 644 ""
    audit_file "站点配置"   "$CONF"   644 ""

    echo
    echo "  三、该在的目录"
    audit_dir "共享目录"     "$SHARE_DIR" 755
    audit_dir "配置目录"     "$CONF_DIR"  755
    audit_dir "状态目录"     "$STATE_DIR" 700

    echo
    echo "  四、读得到的文件"
    if [[ -r "$CONF" ]]; then
        a_ok "站点配置可读（${CONF}）"
    else
        a_bad "站点配置" "读取失败（${CONF}）"
        a_hint "看 ${DOC_DIR}/CONFIGURATION.md"
    fi
    if [[ -r "${SHARE_DIR}/run.sbatch.template" ]]; then
        a_ok "作业模板可读（织作业脚本时要读它）"
    else
        a_bad "作业模板" "读取失败（${SHARE_DIR}/run.sbatch.template）"
        a_hint "提交会话会失败在这里：sudo bash ${SCRIPT_PATH} --repair"
    fi

    if [[ "$how" != "full" ]]; then
        echo
        info "服务、socket 与 nft 那几项刚在〈阶段 5〉查过，这一遍不重复。"
        echo
        echo "  对账：通过 ${A_PASS}，警告 ${A_WARN}，失败 ${A_FAIL}"
        return
    fi

    echo
    echo "  五、运行期"
    if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
        a_ok "开机自启：已启用"
    else
        a_warn "开机自启" "未启用（重启之后不会自己起来）"
        a_hint "启用：systemctl enable ${SERVICE}（--repair 也会做这一件事）"
    fi
    if systemctl is-active --quiet "$SERVICE"; then
        a_ok "服务运行中：${SERVICE}"
    else
        a_bad "服务" "未在运行"
        a_hint "状态与最近日志：systemctl status ${SERVICE}；journalctl -u ${SERVICE} -n 30"
        a_hint "看 ${DOC_DIR}/TROUBLESHOOTING.md 的〈第 0 步：先看这四个地方〉"
    fi
    if [[ -S "$SOCKET" ]]; then
        a_ok "RPC socket 已就绪：${SOCKET}"
    else
        a_bad "RPC socket" "未创建（${SOCKET}）"
        a_hint "守护进程没起来时不会有它：先按上面「服务」那一条查"
    fi

    # 守护进程自己那句话。判据都在它自己里面，这里只把答案转述出来 ——
    #   在部署脚本里另写一份"规则数该等于会话数"，就是同一件事的第二个判据。
    #
    #   插件那一半也在这一屏里：守护进程的 `--check` 现读一遍插件目录、把问题
    #     打出来（`cfg.plugin_problems`）。基座这一侧不去调插件专有的那个开关
    #     —— 插件是独立项目，装、卸、对齐、体检各有自己的入口，那一条拆分
    #     有用例钉着（见 cluster/test-sessiond-logic.py 的 19.13b）。
    if [[ -x "$DAEMON" ]]; then
        if out="$("$DAEMON" --check --config="$CONF" 2>&1)"; then
            a_ok "配置自检：通过（${DAEMON} --check，插件那一半也在这一屏里）"
        else
            a_bad "配置自检" "未通过（${DAEMON} --check，退出码 $?）"
            printf '%s\n' "$out" | sed 's/^/        /'
            a_hint "看 ${DOC_DIR}/CONFIGURATION.md；与插件有关的那几条看"
            a_hint "    ${DOC_DIR}/PLUGIN-TROUBLESHOOTING.md"
        fi
    fi
    if [[ -S "$SOCKET" && -x "$CLI" ]]; then
        # 规则数与会话数是否一致只有守护进程答得了（`doctor` 那个 op）。
        #   这里读它的 JSON 结论，不读它画给人看的那一屏 —— 读文字是猜。
        local _dj _consistent
        _dj="$("$CLI" doctor --json 2>/dev/null)"
        _consistent="$(printf '%s' "$_dj" | "$PY" -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("?")
else:
    print(d.get("data", {}).get("consistent"))
' 2>/dev/null)"
        case "$_consistent" in
            True)
                a_ok "nft 规则与库一致（${CLI} doctor）" ;;
            False)
                a_bad "nft 规则与库" "不一致（${CLI} doctor 报 consistent = false）"
                "$CLI" doctor 2>&1 | sed 's/^/        /'
                a_hint "看 ${DOC_DIR}/TROUBLESHOOTING.md 的〈三、nft 规则消失〉" ;;
            *)
                a_warn "运行期诊断" "没有拿到结论（${CLI} doctor --json）"
                a_hint "多半是守护进程没在跑；先按上面「服务」那一条查" ;;
        esac
    fi

    echo
    echo "  对账：通过 ${A_PASS}，警告 ${A_WARN}，失败 ${A_FAIL}"
}

# ── 这台机器上装过没有 ──────────────────────────────────────────────────────
# 判据是"本系统的东西在不在这台机器上"，取四处任一：守护进程、命令行、站点配置、
#   systemd 单元、状态目录。用它做两件事 —— 安装时决定走哪条路，修复时决定
#   要不要拒绝。
_ever=0
for _p in "$DAEMON" "$CLI" "$CONF" "$UNIT" "$STATE_DIR"; do
    [[ -e "$_p" ]] && _ever=1
done

# ── 装过就按修复走（升级也是修复）────────────────────────────────────────────
#
# 为什么把升级并进修复而不是另开一个动词：装与升级对这台机器做的动作是同一套
#   —— 摆文件、渲染单元、重启服务、逐项验一遍。分两个动词就得回答"这次算哪一
#   种"，而答案取决于装过没有，那正是这里已经知道的事。
#
# 并进来之后还多一件事：修复那条路会先对账、装完再对一次，于是"升级到底把哪
#   几样换掉了"有一份看得见的账，而不是一句"已安装"。
if [[ "$MODE" == "install" && "$_ever" -eq 1 ]]; then
    _v_have="$("$DAEMON" --version 2>/dev/null | head -1)"
    _v_this="$("$PY" "$DAEMON_SRC" --version 2>/dev/null | head -1)"
    MODE="repair"
    step "这一台机器上装过基座：按修复走（升级与修复是同一条路）"
    info "装着的是 ${_v_have:-未知版本}，这一份是 ${_v_this:-这一版}。"
    info "只增不改：${CONF} 与 ${STATE_DIR} 里的数据不动，正在跑的会话不断。"
fi

# ── 诊断（--doctor）：只读，一个字都不改 ────────────────────────────────────
if [[ "$MODE" == "doctor" ]]; then
    step "诊断（--doctor）：这台机器现在是什么状态"
    info "只读模式：不装文件、不改配置、不动服务、不碰 nftables。"
    audit_installed full
    audit_pointers
    echo
    if [[ "$A_FAIL" -gt 0 ]]; then
        echo "  有 ${A_FAIL} 项不对。修回去：sudo bash ${SCRIPT_PATH} --repair"
        exit 1
    fi
    echo "  没有需要处理的问题。"
    exit 0
fi

# ── 修复（--repair）：先对账，对不上才动手，动完再对一次 ────────────────────
if [[ "$MODE" == "repair" ]]; then
    # 没装过的机器上"修复"没有对象。拒绝而不是顺手装上去：那会把一次敲错的
    #   动词变成一次静默的首次部署。
    if [[ "$_ever" -eq 0 ]]; then
        die "这台机器上没装过基座（${DAEMON} / ${CLI} / ${CONF} / ${UNIT} / ${STATE_DIR}
     一个都不在），修复没有对象。要装就用不带参数的安装：
         sudo bash ${SCRIPT_PATH}"
    fi
    step "修复前对账（--repair）：先看清哪几样不对"
    audit_installed full
    if [[ "$CONF_DIFF" -eq 1 ]]; then
        echo
        info "站点配置的键与这一版不一致：下面按上面那次对账对齐（取值不动）。"
    fi
    if [[ "$A_FAIL" -eq 0 && "$A_WARN" -eq 0 && "$CONF_DIFF" -eq 0 ]]; then
        echo
        ok "对账干净：文件、目录、单元、服务都对得上，一个字节都不改。"
        info "（这一份包里的版本与装着的是同一个版本。要重装一遍：去掉 --repair。）"
        # 对账干净也重启一次：这是这一版的规矩（修复 = 留一个干净的环境，
        #   顺手清掉运行期残留），而不是"既然没改文件就什么都不做"。
        if [[ "$DRYRUN" -eq 1 ]]; then
            info "[演练] 会重启一次服务；本次没有动它。"
        elif [[ "$NORESTART" -eq 1 ]]; then
            info "按 --no-restart 跳过重启。"
        else
            # 这次重启也是事务：失败就把服务状态放回去（起来的那一个）。
            txn_begin install "$WORK_DIR" \
                || die "无法建立事务目录 ${WORK_DIR}，没有动服务。"
            txn_note "meta" "service_touched" "1"
            if SLURMATE_LOCK_HELD=1 "$CLI" service restart \
                    --config="$CONF" --quiet; then
                ok "服务已重启（--repair 结束时的规矩；--no-restart 可跳过）"
                txn_commit
            else
                die "服务重启失败（原因见上）。这次修复将回滚，旧守护进程会被重新拉起。"
            fi
        fi
        exit 0
    fi
    _A_PRE_BAD=( "${A_BAD[@]}" )
    echo
    info "下面走一次安装（幂等、只增不改）：站点配置的取值与 ${STATE_DIR} 里的数据都不动。"
    info "要重装的是上面报的那几样，其余照旧。"
fi

# ==============================================================================
step "阶段 1／6  快照（用于部署后的非干扰比对）"
# ==============================================================================

mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"

# nftables 规则集：结构化快照
snapshot_ruleset() {
    local out="$1"
    if "$NFT" -j list ruleset > "$out" 2>/dev/null && [[ -s "$out" ]]; then
        return 0
    fi
    "$NFT" list ruleset > "$out" 2>/dev/null || true
}
snapshot_ruleset "${WORK_DIR}/nft-before.json"
if [[ -s "${WORK_DIR}/nft-before.json" ]]; then
    ok "已保存 nftables 规则集快照"
else
    warn "无法保存 nftables 规则集快照，非干扰比对将降级"
fi

# 需要证明"未被改动"的【外部】文件（本系统之外、但部署可能会碰到的）。
# 只在这里定义一次 —— 早期版本在"部署前记录"和"部署后比对"两处各抄了一份，
# 改一处漏一处就会让比对的两侧根本不是同一组文件。
FOREIGN_FILES=(
    /usr/local/bin/codeserver-nft-helper
    /usr/local/bin/codeserver-guard
    /usr/local/bin/my-port
    /usr/local/sbin/user-session-cleanup
    /etc/ssh/sshd_config
    /etc/ssh/sshd_config.d/99-codeserver-guard.conf
    /etc/sudoers.d/codeserver-guard
    /etc/systemd/system/user@.service.d/cleanup.conf
    /etc/port-daemon.conf
)

# 外部文件的哈希
# 注意：早期版本写成 `[[ -e ]] && sha256sum | awk || echo MISSING`。
# 由于 && / || 同优先级左结合，sha256sum 失败时也会输出 MISSING，
# 而部署前后两份都是 MISSING → diff 相等 → 打印"哈希全部未变"（假绿）。
# 现在把失败显式区分出来，由调用方 grep 产物文件里的 HASHFAIL 判定。
#
# MISSING 还藏着第二重假绿：在别人的集群上这几个文件【全都不存在】，
# 前后都是 MISSING，diff 同样相等 —— 于是打印"哈希全部未变"，
# 而实际一个字节都没比。所以比对时必须把"不存在"单独计数、显式声明
# 它未参与校验（见 5.2）。
hash_of() {
    if [[ ! -e "$1" ]]; then
        printf 'MISSING'
        return
    fi
    local h
    h="$(sha256sum "$1" 2>/dev/null | awk '{print $1}')"
    if [[ -z "$h" ]]; then
        # 注意：这个函数是在 $( ) 里被调用的，子 shell 里设置的变量传不回来。
        # 所以失败只体现在【输出内容】上，由调用方 grep 产物文件来判定。
        printf 'HASHFAIL'
        return
    fi
    printf '%s' "$h"
}
for f in "${FOREIGN_FILES[@]}"; do
    printf '%s  %s\n' "$(hash_of "$f")" "$f"
done > "${WORK_DIR}/hashes-before.txt"
ok "已保存外部文件哈希（$(wc -l < "${WORK_DIR}/hashes-before.txt") 项）"

# 锁目录内容
ls -A /tmp/codeserver-ports 2>/dev/null | sort > "${WORK_DIR}/locks-before.txt" || : > "${WORK_DIR}/locks-before.txt"
ok "已保存锁目录清单（$(wc -l < "${WORK_DIR}/locks-before.txt") 项）"

# 需要确认"部署后仍在运行"的邻居服务名单。
# 这些是本系统最初部署环境里的其余端口管理服务 —— 在别的集群上它们通常
# 不存在。所以 5.5 是按【部署前的实际状态】比对的：之前就不在运行的，
# 不做任何要求。否则在干净集群上会对着三个不存在的服务狂报 FAIL。
NEIGHBOR_SERVICES=(port-daemon port-query codeserver-port-cleanup)

# 现有服务状态
{
    for s in "${NEIGHBOR_SERVICES[@]}" nftables; do
        printf '%s=%s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || echo unknown)"
    done
} > "${WORK_DIR}/services-before.txt"
ok "已保存服务状态"

if [[ "$MODE" == "check" ]]; then
    step "只体检模式（--check）：不做任何安装"
    info "源文件与目标位置检查通过。"

    # 插件不在这里体检：本脚本不装插件，也就无从知道
    #   "哪一批包要装"（那是 `slurmate plugin install --from DIR` 说的）。
    #   要体检本站装着的插件：`slurmate-sessiond --check-plugins`
    #   —— 判据与守护进程启动时逐字相同（同一个 `scan_plugins`），不抄第二遍。
    #   要体检还没装进去的一批包：`--install-plugins --plugins-dir <临时目录>`
    #     —— 跑的是同一个安装器的第一遍，任何一条不过就一个字节都不写。
    if [[ "$DRYRUN" -eq 1 ]]; then
        info "[演练] 跳过"
    else
        info "插件不在本脚本的范围内，装/卸/对齐走："
        info "    slurmate plugin install --from DIR | uninstall <id> | sync"
    fi

    info "已保存快照到 ${WORK_DIR}"
    info "如需部署，去掉 --check 重跑。"
    echo
    echo "  预检通过 ${PASS_N} 项，警告 ${WARN_N} 项，失败 ${FAIL_N} 项"
    exit 0
fi


# ==============================================================================
step "阶段 2／6  安装文件"
# ==============================================================================

# 事务从这里开始：下面的建目录、覆盖文件都要先记"怎么撤回"。
if [[ "$DRYRUN" -eq 0 ]]; then
    txn_begin install "$WORK_DIR" \
        || die "无法建立事务目录 ${WORK_DIR}，没有改动任何文件。"
fi

install_one() {
    local src="$1" dst="$2" mode="$3"
    if [[ "$DRYRUN" -eq 1 ]]; then
        echo "  [演练] install -m ${mode} ${src} → ${dst}"
        return 0
    fi
    # 目标必须是普通文件（或还不存在）。符号链接、目录、FIFO 一律拒绝：
    #   `cp -a` 与 `install` 对它们的语义不同，回滚会恢复成错的对象。
    if [[ -L "$dst" || ( -e "$dst" && ! -f "$dst" ) ]]; then
        die "目标不是普通文件：$dst（不覆盖，已中止）"
    fi
    # 先备份、先记日志、再同步，最后才覆盖。备份失败就不许动目标 ——
    #   没有副本就没有"失败时恢复原状"。
    txn_backup "$dst" \
        || die "无法保存 $dst 的原件，无法保证失败时恢复原状，已中止。"
    if [[ -e "$dst" ]]; then
        info "已保留改动前的文件：$dst"
    fi
    install -m "$mode" -o root -g root "$src" "$dst" || die "安装失败：$dst"
    ok "$dst  (${mode})"
}

# 确保所有目标文件的父目录存在（真实系统上这些目录本来就在，但不能依赖这个前提）
for d in "$(dirname "$DAEMON")" "$(dirname "$CLI")" "$SHARE_DIR" "$CONF_DIR" \
         "$(dirname "$UNIT")" "$STATE_DIR"; do
    if [[ ! -d "$d" ]]; then
        if [[ "$DRYRUN" -eq 1 ]]; then
            echo "  [演练] mkdir -p $d"
            info "将创建目录 $d（演练，尚未创建）"
        else
            _own=0
            [[ "$d" == "$STATE_DIR" ]] && _own=1
            txn_mkdir_p "$d" "$_own" \
                || die "无法创建目录 $d（已中止，正在回滚）"
            info "已创建目录 $d"
        fi
    fi
done
# 0755 而不是 0700：`<SHARE_DIR>` 下面有两样东西要被用户身份的进程读 ——
#   编织好的作业脚本（`jobs/<ULID>.sbatch`，由提交作业的用户身份的 sbatch 读）
#   与作业模板（安装器用它织）。0700 的表现是 sbatch 报「读不到文件」，而那句
#   话指不回权限，会让人去查脚本是不是生成失败了。
if [[ "$DRYRUN" -eq 0 ]]; then
    txn_mode "$SHARE_DIR"
    txn_mode "$CONF_DIR"
    txn_mode "$STATE_DIR"
    chmod 755 "$SHARE_DIR" "$CONF_DIR" \
        || die "无法设置共享目录与配置目录的权限（已中止，正在回滚）"
    chmod 700 "$STATE_DIR" \
        || die "无法设置状态目录的权限（已中止，正在回滚）"
fi

install_one "${SRC_DIR}/slurmate-sessiond"  "$DAEMON"  755
install_one "${SRC_DIR}/slurmate"           "$CLI"     755
install_one "${SRC_DIR}/nft-compare.py"     "${SHARE_DIR}/nft-compare.py" 644
# 作业模板装到 `<SHARE_DIR>/run.sbatch.template`。
#
#   它是安装器织作业脚本时要读的那一份 —— 装它是因为装完基座之后集群上
#   可能根本没有仓库（`cluster/` 只在部署机上），而从那一刻起"装一个插件"必须
#   能独立完成。名字里带 `template` 是刻意的：`jobs/` 下那一串才是作业脚本，
#   这一份不是作业、也不会被提交。
install_one "${SRC_DIR}/run.sbatch" "${SHARE_DIR}/run.sbatch.template" 644

# ── slurmate.conf：不存在时安装，存在时只对键 ──
# 它是站点配置 —— 管理员会在上面改端口区间、要避让的其他区间、缺省插件。
# 键跟着版本走（见〈阶段 0〉那次对账），取值只归管理员：有改动时写回去的是
#   "管理员的取值 + 这一版的键"，整份旧文件由 `install_one` 记进撤销日志。
# 要重置就手动删掉它再跑。
if [[ -e "$CONF" ]]; then
    # 有改动才落盘：键与这一版相同的站点，配置文件的修改时间都不该动。
    #   `install_one` 覆盖前会把旧的那一份记进撤销日志，所以"删掉了哪几行"
    #   在部署失败时找得回来。
    if [[ "$CONF_DIFF" -eq 1 ]]; then
        install_one "$CONF_MERGED" "$CONF" 644
        info "站点配置已按这一版对齐：取值一个没改，删掉与补上的键见上面那次对账"
    else
        info "保留已有站点配置：${CONF}（键与这一版相同，一个字节没动）"
        info "  随仓库分发的版本在 ${SRC_DIR}/slurmate.conf.example，可对比新增了哪些项"
    fi
else
    install_one "${SRC_DIR}/slurmate.conf.example" "$CONF" 644
fi

# ── systemd 单元：逐字安装 ──
# 它里面没有任何按站点替换的东西：沙箱那一条走 ProtectSystem=strict，家目录
#   挂在哪由内核那一侧盖住，不需要站点报路径。（从前这里是从模板渲染的，
#   要填一个共享家目录挂载点 —— 那个键退休之后就没有可变的部分了。）
install_one "${SRC_DIR}/slurmate-sessiond.service" "$UNIT" 644

# 目录权限必须是 0755，不能是 0700：
#   - /usr/local/share/slurmate 里的 run.sbatch 由【用户身份】的 sbatch 读取
#   - /etc/slurmate/slurmate.conf 必须可读 —— 部署脚本自己、以及管理员排查时
#     都会读它。（用户身份的 slurmate CLI 不再读它：socket 路径已是编译期常量，
#     见 cluster/slurmate 的 socket_path()。）
# 只有状态目录 /var/lib/slurmate-session 才是 root 专属。

# 语法自检 —— 装完立刻验证，出错立即中止，不留给 systemd 去发现。
# 注意：这里【不】用 py_compile，它会生成 __pycache__，而清理它时很容易
# 误删同目录下别人的 Python 缓存（/usr/local/sbin 里可能有其他脚本）。
# 改成在内存里 compile()，只做语法检查、不落任何文件。
if [[ "$DRYRUN" -eq 0 ]]; then
    syntax_check() {
        "$PY" -c 'import sys
src = open(sys.argv[1], encoding="utf-8").read()
compile(src, sys.argv[1], "exec")' "$1" 2>&1
    }
    syntax_check "$DAEMON" || die "守护进程语法检查失败，已中止（未启动服务）"
    syntax_check "$CLI"    || die "CLI 语法检查失败，已中止"
    # 作业脚本不在这一轮里：装好的每一份都在
    #   `<SHARE_DIR>/jobs/` 下，由安装器织、也由它在织的时候逐份 `bash -n`
    #   （两遍式的第一遍）。本脚本不认识那个目录，也就不该在这里再验一遍。
    comparator_selftest "${SHARE_DIR}/nft-compare.py" \
        || die "已安装的比对器自测未通过（项数下限 ${COMPARATOR_MIN_TESTS}），已中止"
    ok "语法自检通过（守护进程 / CLI / 比对器）"
fi

# ==============================================================================
step "阶段 3／6  配置自检（不启动服务）"
# ==============================================================================

if [[ "$DRYRUN" -eq 1 ]]; then
    info "[演练] 跳过"
else
    # 这一条跑的是守护进程【自己的】自检 —— 这是第二次：〈阶段 0〉那一次
    # 用的是还没装上/还没配好的那份配置（首次部署时它是随包分发的示例）。这一次
    # 读的是刚落盘的那份站点配置，它必须是对的。
    #
    # 退出码 2（机器缺东西）在〈阶段 0〉已经拦过了；走到这里还拿到 2 只可能
    #   是这两步之间机器被改过 —— 那时也该停。
    if "$DAEMON" --check --config="$CONF"; then
        ok "配置自检通过"
    else
        die "配置自检失败（原因见上）。未启动服务，未创建任何 nft 规则。
     上一条「配置错误: …」点名了是哪一格，照着改 ${CONF}，改完重跑本脚本。"
    fi
fi

# ==============================================================================
step "阶段 4／6  启用并启动服务"
# ==============================================================================

if [[ "$DRYRUN" -eq 1 ]]; then
    # 演练下 run() 只打印不执行、且恒返回 0，所以绝不能沿用下面的 ok 分支 ——
    # 那会在什么都没做的情况下报告"已设为开机自启"，正是本脚本最该避免的假绿。
    info "[演练] 跳过 systemctl daemon-reload / enable（服务未启用、未自启）"
else
    if systemctl daemon-reload; then
        ok "systemctl daemon-reload"
    else
        bad "systemctl daemon-reload 失败，单元可能未生效，请检查 /etc/systemd/system 下的单元文件"
    fi

    txn_note "meta" "enabled_touched" "1"
    if systemctl enable "$SERVICE" >/dev/null 2>&1; then
        ok "已设为开机自启"
    else
        bad "systemctl enable 失败（重启后不会自启）"
    fi
fi

if [[ "$DRYRUN" -eq 0 ]]; then
    # 装/升级/修复换掉的是基座（守护进程与单元）。基座变了就重启，而不是
    #   reload：这一版的规矩是"结束时留一个完整、干净的环境"。
    #
    #   重启对正在跑的会话是安全的：状态在 claims.db 与 nft 规则里，作业归
    #   Slurm 管；客户端把"守护进程不可达"当作"作业仍在运行"，会自动重连。
    #   重启之前 CLI 先发 `drain`，让新的提交在窗口内被拒 —— 于是重启不会
    #   切断一次走到一半的提交。
    #
    #   自检、排空、重启、等就绪、核对结果这五步都在 `slurmate service restart`
    #   一处，本脚本不再自己等 socket/nft —— 同一份判据只留一份。
    if [[ "$NORESTART" -eq 1 ]]; then
        info "按 --no-restart 跳过重启。守护进程仍在用启动时那一份配置。"
    else
        # 记在动作之前：即使 restart 把旧进程停掉了却没能拉起新的，
        #   回滚也必须在这一点上把旧守护进程重新启动。
        txn_note "meta" "service_touched" "1"
        if ! SLURMATE_LOCK_HELD=1 "$CLI" service restart --config="$CONF" --quiet; then
            bad "服务重启失败（原因见上）"
            die "服务没有起来。这次部署将回滚到运行前：文件、配置、单元与服务状态
     都会放回去，旧守护进程会被重新拉起。排查上面的日志后重跑本脚本。"
        fi
        ok "服务已重启并就绪（基座变了，这一版默认重启）"
    fi
else
    info "[演练] 跳过启动"
fi

# ==============================================================================
step "阶段 5／6  非干扰验证（最重要的一步）"
# ==============================================================================

if [[ "$DRYRUN" -eq 1 ]]; then
    info "[演练] 跳过"
else

# ── 5.1 nftables 规则集：剥掉 inet slurmate 后必须逐条一致 ──
snapshot_ruleset "${WORK_DIR}/nft-after.json"
RULESET_OUT="$("$PY" "${SRC_DIR}/nft-compare.py" \
                   "${WORK_DIR}/nft-before.json" \
                   "${WORK_DIR}/nft-after.json" 2>&1 || true)"
RULESET_VERDICT="$(printf '%s\n' "$RULESET_OUT" | head -n1)"

case "$RULESET_VERDICT" in
    SAME)
        ok "nftables 规则集除新增的 inet slurmate 表外完全一致"
        ;;
    DYNAMIC)
        warn "nftables 规则集有差异，但仅涉及【已知会随用户作业流动】的规则："
        printf '%s\n' "$RULESET_OUT" | tail -n +2 | sed 's/^/        /' >&2
        warn "  即部署这几秒内恰有用户启停 code-server（cs-*）或提交带端口"
        warn "  转发的作业（job-*）。本系统不会产生这两类 comment，可以放行。"
        warn "  若想拿到完全干净的 SAME，可在业务空闲时重跑 --check 复核。"
        ;;
    ALIEN)
        bad "nftables 规则集出现了【本系统不应造成】的差异："
        printf '%s\n' "$RULESET_OUT" | tail -n +2 | sed 's/^/        /' >&2
        bad "  这可能是本系统改到了别人的表。请立即检查；这次部署会回滚。"
        ;;
    REORDER)
        bad "nftables 规则的【顺序】变了（多重集相同但顺序不同）："
        bad "  链内顺序在 nftables 里是有语义的（drop 在 accept 前后是真实的行为变更），"
        bad "  而且没有任何合法原因会造成纯重排，规则的增删必然改变多重集，只有重排不改变。"
        bad "  请立即检查；这次部署会回滚。"
        ;;
    NOSNAPSHOT)
        bad "规则集快照缺失或为空，【无法】证明部署没有干扰现有规则。"
        bad "  这本身就是失败，不是警告。请检查上面的快照保存步骤。"
        ;;
    TEXTMODE)
        bad "规则集不是合法 JSON，【无法】做结构化比对，无法证明非干扰。"
        ;;
    *)
        bad "规则集比对异常：${RULESET_OUT:-（无输出）}"
        ;;
esac

# ── 5.2 外部文件哈希未变 ──
for f in "${FOREIGN_FILES[@]}"; do
    printf '%s  %s\n' "$(hash_of "$f")" "$f"
done > "${WORK_DIR}/hashes-after.txt"

if grep -q 'HASHFAIL' "${WORK_DIR}/hashes-after.txt" 2>/dev/null; then
    bad "有文件哈希计算失败（见上面的 HASHFAIL），【无法】证明现有文件未被改动"
    grep 'HASHFAIL' "${WORK_DIR}/hashes-after.txt" | sed 's/^/        /' >&2
elif diff -q "${WORK_DIR}/hashes-before.txt" "${WORK_DIR}/hashes-after.txt" >/dev/null; then
    # "两份相等"有两种截然不同的含义：真的都没变，或者【本来就不存在】。
    # 后者什么都没证明。分开报告，别让"没有可比的东西"冒充成"一切正常"。
    n_total="$(wc -l < "${WORK_DIR}/hashes-after.txt")"
    n_absent="$(grep -c '^MISSING' "${WORK_DIR}/hashes-after.txt" || true)"
    n_compared=$(( n_total - n_absent ))
    if (( n_compared == 0 )); then
        info "外部文件全部不存在（${n_total} 项），本项【未参与校验】，不代表它们未被改动"
    else
        ok "外部文件哈希未变（实际比对 ${n_compared} 项，另有 ${n_absent} 项本就不存在）"
    fi
else
    bad "现有文件发生变化："
    diff "${WORK_DIR}/hashes-before.txt" "${WORK_DIR}/hashes-after.txt" | sed 's/^/        /' >&2
fi

# ── 5.3 锁目录内容未变（并发用户活动会影响它，故只警告） ──
ls -A /tmp/codeserver-ports 2>/dev/null | sort > "${WORK_DIR}/locks-after.txt" || : > "${WORK_DIR}/locks-after.txt"
if diff -q "${WORK_DIR}/locks-before.txt" "${WORK_DIR}/locks-after.txt" >/dev/null; then
    ok "codeserver 锁目录内容未变"
else
    warn "锁目录有变化（通常是并发用户启停了 code-server，非本系统所致）："
    diff "${WORK_DIR}/locks-before.txt" "${WORK_DIR}/locks-after.txt" | sed 's/^/        /' >&2
fi

# ── 5.4 sshd 配置语法 ──
if ! command -v sshd >/dev/null 2>&1; then
    warn "未找到 sshd 命令，跳过语法检查（本系统确实未修改 sshd 配置）"
elif sshd -t 2>/dev/null; then
    ok "sshd 配置语法正常"
else
    bad "sshd 配置语法异常（本系统未修改 sshd，请立即排查）"
fi

# ── 5.5 部署前在运行的邻居服务仍在运行 ──
# 只在"部署前就是 active"时才要求它现在仍 active。之前就没在跑的
# （包括根本不存在这个服务的情况）不产生任何结论 —— 也就不会误报。
n_svc_checked=0
for s in "${NEIGHBOR_SERVICES[@]}"; do
    grep -qx "${s}=active" "${WORK_DIR}/services-before.txt" 2>/dev/null || continue
    n_svc_checked=$(( n_svc_checked + 1 ))
    if systemctl is-active --quiet "$s" 2>/dev/null; then
        ok "部署前在运行的服务 $s 仍在运行"
    else
        bad "服务 $s 在部署前是 active，现在不是了！请检查：journalctl -u $s -n 50"
    fi
done
if (( n_svc_checked == 0 )); then
    info "部署前没有本名单中的服务在运行，本项无对象可查（不是失败）"
fi

# ── 5.6 Slurmate 自身功能自检 ──
if systemctl is-active --quiet "$SERVICE"; then
    ok "slurmate-sessiond 运行中"
else
    bad "slurmate-sessiond 未在运行"
fi
if [[ -S "$SOCKET" ]]; then
    ok "RPC socket 已就绪：$SOCKET"
else
    bad "RPC socket 未创建：$SOCKET"
fi
if "$NFT" list table inet slurmate >/dev/null 2>&1; then
    ok "nft 表 inet slurmate 已创建"
    "$NFT" list chain inet slurmate output 2>/dev/null | sed 's/^/        /'
else
    bad "nft 表 inet slurmate 未创建"
fi

fi  # DRYRUN

# ── 装完／修完，用同一份判据再问一遍 ────────────────────────────────────────
# 这一遍只查盘上的东西（static）：服务、socket、nft 那几项刚在〈阶段 5〉查过，
#   而"装好了"这句结论靠的是"同一份对账现在对得上了"，不是"我装过了"。
if [[ "$DRYRUN" -eq 1 ]]; then
    info "演练不跑装后对账：没有任何文件被改动。"
elif [[ "$MODE" == "repair" ]]; then
    echo
    step "修复后对账（--repair）：现在哪几样对上了"
    audit_installed static
    audit_diff
    audit_pointers
elif [[ "$MODE" == "install" ]]; then
    echo
    step "装完对账（--install）：该在的都在不在"
    audit_installed static
    audit_pointers
    # 对账的失败要进总的退出码：装完仍不对时，这一条命令不能报成功。
    #   （`a_bad` 记的是对账自己的计数，与安装那一路的 FAIL_N 分开 ——
    #   这一行是把两份账接起来的那一处，只有这一处。）
    if [[ "$A_FAIL" -gt 0 ]]; then
        bad "装完之后对账仍有 ${A_FAIL} 项不对（见上）"
    fi
fi

# 失败先回滚，再谈"装好了"。这一步在打印"已安装"之前，不能让一屏绿色的
#   标题压过一行回滚报告。
if [[ "$FAIL_N" -gt 0 ]]; then
    if [[ "$TXN_ACTIVE" -eq 1 ]]; then
        if ! txn_rollback "$TXN_DIR" "收尾有失败"; then
            echo "  有 ${FAIL_N} 项失败，回滚没有恢复干净（见上）。" >&2
            exit 1
        fi
    fi
    echo "  有 ${FAIL_N} 项失败，这次部署已回滚。" >&2
    exit 1
fi

if [[ "$DRYRUN" -eq 1 ]]; then
    rm -rf "$WORK_DIR"
fi
if [[ "$TXN_ACTIVE" -eq 1 ]]; then
    txn_commit
fi

# ==============================================================================
step "阶段 6／6  完成"
# ==============================================================================

if [[ "$DRYRUN" -eq 1 ]]; then
    DONE_TITLE="  将安装（演练：下列路径尚未写入任何文件）："
    DRYRUN_BANNER="
  本次是【演练 --dry-run】：没有安装文件、没有启动服务、没有改动 nftables。
     下面列出的是\"将要安装\"的位置，不是已经装好的结果。"
    KEEP_LINE="  临时快照已删除：演练不改系统，也不留现场。"
else
    DONE_TITLE="  已安装："
    DRYRUN_BANNER=""
    KEEP_LINE="  本次没有保留旧文件：成功即提交，回滚副本已随事务目录删除。"
fi

cat <<EOF
${DRYRUN_BANNER}

  通过 ${PASS_N} 项，警告 ${WARN_N} 项，失败 ${FAIL_N} 项
${KEEP_LINE}

${DONE_TITLE}
    ${DAEMON}
    ${CLI}
    ${CONF}
    ${UNIT}
    ${SHARE_DIR}/nft-compare.py
    ${SHARE_DIR}/run.sbatch.template   ← 作业模板（安装器织作业脚本时读它）

  插件不在这张表里，也不归本脚本管（v0.12 起）。装完基座之后装插件：

      sudo slurmate plugin install <包.splug>…       # 装一个或多个
      sudo slurmate plugin install --from <目录>     # 与那个目录整批对齐
      sudo slurmate plugin uninstall <id>…           # 卸（--all 卸全部）
      sudo slurmate plugin sync                      # 对齐配置与作业脚本

    一个插件都没有是合法状态：守护进程照常启动，已有会话照常能查、能停，
    只是没有可提交的服务。要看清本站现在有什么：
      ${DAEMON} --check | grep -A3 插件

  端口池与集群网段：跑一次 \`${DAEMON} --check\` 看（那是它自己的配置，
  本脚本不再抄一份，抄一份就会漂开）。

  常用操作：
    systemctl status slurmate-sessiond
    journalctl -u slurmate-sessiond -f
    ${CLI} doctor                 # 普通用户跑，诊断 ACL 是否与服务一致
    ${DAEMON} --check             # 重新做一次配置自检

  卸载：
    sudo bash ${SCRIPT_PATH} --uninstall              # 保留状态与日志
    sudo bash ${SCRIPT_PATH} --uninstall --purge-state
    它会把插件一起卸掉（在删守护进程之前调卸载器），一个插件在站点上留下
      哪几处痕迹，那条判据只有一份实现。

EOF

exit 0
