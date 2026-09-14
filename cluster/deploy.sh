#!/bin/bash
# ==============================================================================
#  deploy.sh — Slurmate 集群侧一键部署
# ==============================================================================
#
#  在【控制节点（登录节点）】上以 root 运行。
#
#  设计原则：只增不改，绝不影响集群上已有的任何功能
#  ──────────────────────────────────────────────
#  1. 只增不改：不碰任何不属于本系统的 nft 表、服务、锁目录、sshd 配置与
#     sudoers 条目。Slurmate 只创建自己的 `inet slurmate` 表与自己的 systemd 单元。
#  2. 绝不执行 `nft flush ruleset`，绝不 reload/restart nftables.service
#     —— 那会清掉整台机器上所有表的规则集，包括别人的。
#  3. 部署前后各取一次 nftables 规则集【结构化】快照，剥掉本系统新增的
#     inet slurmate 表之后必须逐条完全一致；否则判定失败并提示回滚。
#     比对器（nft-compare.py）有独立自测，防的是"比对了但其实什么都没比"。
#  4. 安装任何文件前先检查目标是否已存在且不属于本系统 —— 是则中止，
#     绝不覆盖别人的文件。卸载路径同样逐项校验归属。
#  5. 幂等：可反复运行。卸载只删自己的东西。
#
#  用法：
#    sudo bash deploy.sh                     # 部署
#    sudo bash deploy.sh --check             # 只体检，不做任何改动
#    sudo bash deploy.sh --dry-run           # 演练，不做任何改动
#    sudo bash deploy.sh --uninstall         # 卸载（保留状态数据）
#    sudo bash deploy.sh --uninstall --purge-state
#    sudo bash deploy.sh --require-baseline  # 前置基线缺失即中止（见下）
#
#  关于 --require-baseline
#  ─────────────────────
#  本脚本最初是为「一台已经跑着别的端口管理方案的登录节点」写的，因此会检查
#  若干前置设施是否存在。**在别人的集群上这些设施通常不存在**，所以默认只
#  警告、继续部署。若你需要"前置条件不满足就绝不继续"的严格语义，加这个开关。
#
# ==============================================================================

set -uo pipefail

# ─── 路径 ────────────────────────────────────────────────────────────────────
# deploy.sh 与它要安装的源文件同在 cluster/ 下。
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
JOBSH="${SHARE_DIR}/run.sbatch"
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

# 端口区间与「要避让的其他区间」都从配置里读，不在这里另写一份 ——
# 否则管理员改了 slurmate.conf，部署脚本的预检与完成报告仍是旧值，两者互相矛盾。
#
# 读哪一份：已经装过就优先读【已安装】的那份（管理员可能按站点改过），
# 否则读随仓库分发的示例。这样重复部署时，预检用的值和守护进程实际
# 读到的值是同一份。
SRC_CONF="${SRC_DIR}/slurmate.conf.example"
if [[ -r "$CONF" ]]; then
    SRC_CONF="$CONF"
fi
PORT_MIN="$(sed -nE 's/^[[:space:]]*range_start[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' "$SRC_CONF" 2>/dev/null | head -1)"
PORT_MAX="$(sed -nE 's/^[[:space:]]*range_end[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' "$SRC_CONF" 2>/dev/null | head -1)"
RESERVED_RANGES="$(sed -nE 's/^[[:space:]]*reserved_ranges[[:space:]]*=[[:space:]]*(.*)/\1/p' "$SRC_CONF" 2>/dev/null | head -1)"
PORT_MIN="${PORT_MIN:-55001}"
PORT_MAX="${PORT_MAX:-55999}"

# ─── 参数 ────────────────────────────────────────────────────────────────────
MODE="install"
REQUIRE_BASELINE=0
DRYRUN=0
PURGE=0

for arg in "$@"; do
    case "$arg" in
        --check)             MODE="check" ;;
        --uninstall)         MODE="uninstall" ;;
        --dry-run)           DRYRUN=1 ;;
        --require-baseline)  REQUIRE_BASELINE=1 ;;
        # 兼容旧命令行：--force 曾经是"基线不完整时仍继续"。现在默认就是继续，
        # 所以它已成空操作，但保留接受，免得旧脚本/旧笔记里的命令直接报错。
        --force)             : ;;
        --purge-state)       PURGE=1 ;;
        -h|--help)
            sed -n '2,/^# =====/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
die()   { echo; echo "  [中止] $*" >&2; echo >&2; exit 1; }
run()   { if [[ "$DRYRUN" -eq 1 ]]; then echo "  [演练] $*"; else "$@"; fi; }

TS="$(date +%Y%m%d-%H%M%S)"
# --check 是"零改动"模式，快照放临时目录即可，不要在 /root 下攒一堆目录
if [[ "$MODE" == "check" ]]; then
    BACKUP_DIR="/tmp/slurmate-check-${TS}"
else
    BACKUP_DIR="/root/slurmate-backup-${TS}"
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
    warn "找不到 flock，无法防止并发部署；请自行确认没有另一个实例在运行"
fi

# ==============================================================================
#  卸载：放在最前面，且只要求 root
# ==============================================================================
#  卸载必须【永远可用】—— 不能因为基线不完整、源文件缺失、配置损坏而拦不住。
#  出故障时管理员最需要的就是能干净地把它拿掉，所以这里不做任何多余的预检。
if [[ "$MODE" == "uninstall" ]]; then
    step "卸载"

    info "停止并禁用服务"
    systemctl disable --now "$SERVICE" 2>/dev/null || true

    # 必须确认服务真的停了再删表和文件。否则：
    #   - 删表后守护进程下一个 tick 就把表重建回来（会打印"已删除"但实际上还在）
    #   - 删掉二进制后已加载的进程仍在运行、仍在改 nft，而 Restart=always 再起不来
    # 留下一个"已经卸载但 root 守护进程还在动防火墙"的机器。
    if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
        warn "服务 ${SERVICE} 仍在运行，卸载中止（先手动停掉再试）："
        warn "      systemctl stop ${SERVICE}"
        warn "      # 若停不掉，检查：systemctl status ${SERVICE}"
        exit 1
    fi
    ok "服务已停止"

    # 删 nft 表（只删自己那张；表名是本系统独有的，不存在歧义）
    if command -v nft >/dev/null 2>&1 && nft list table inet slurmate >/dev/null 2>&1; then
        nft delete table inet slurmate && ok "已删除 nft 表 inet slurmate"
    else
        info "nft 表 inet slurmate 不存在，跳过"
    fi

    # 删文件前逐项确认"这确实是本系统装的文件"。
    # 早期版本在这里无条件 rm -f，而脚本又反复提示用 --uninstall 做回滚 ——
    # 于是在一台从未部署过 Slurmate 的机器上执行它，会删掉同名的他人文件。
    # 注意：这是 root 的 rm，不设防的代价是别人的东西。
    for f in "$DAEMON" "$CLI" "$JOBSH" "$CONF" "$UNIT" "${SHARE_DIR}/nft-compare.py"; do
        if [[ ! -e "$f" ]]; then
            continue
        fi
        if ! grep -qi "slurmate" "$f" 2>/dev/null; then
            warn "跳过 $f —— 它存在但内容不含 \"slurmate\"，不像本系统装的文件，不敢删"
            warn "      如确认要删请人工执行：rm -f '$f'"
            continue
        fi
        rm -f "$f" && ok "已删除 $f"
    done
    # 只在目录为空时才删 —— 里面若有别人放的东西就留着
    rmdir "$SHARE_DIR" "$CONF_DIR" 2>/dev/null || true
    rm -f "$SOCKET" 2>/dev/null || true

    if [[ "$PURGE" -eq 1 ]]; then
        warn "按 --purge-state 删除状态与日志：${STATE_DIR} ${LOG_DIR}"
        rm -rf "$STATE_DIR" "$LOG_DIR"
    else
        info "状态与日志已保留：${STATE_DIR} ${LOG_DIR}（如需删除加 --purge-state）"
    fi

    systemctl daemon-reload 2>/dev/null || true
    echo
    echo "  卸载完成。本系统之外的一切均未受影响 —— 其他 nft 表、其他服务、"
    echo "  sshd 配置与 sudoers 都没有被本脚本改动过。"
    exit 0
fi


SRC_FILES=(slurmate-sessiond slurmate run.sbatch slurmate.conf.example slurmate-sessiond.service.in nft-compare.py)
for f in "${SRC_FILES[@]}"; do
    [[ -f "${SRC_DIR}/${f}" ]] || die "源文件缺失：${SRC_DIR}/${f}（cluster/ 目录是否完整？）"
done
ok "源文件齐备（${SRC_DIR}）"

# ── 源文件可信性 ──
# 本脚本会以 root 身份【安装并执行】这些文件。若它们能被普通用户改写，
# 等于把 root 权限交出去 —— 那三套正在服务真实用户的生产系统也会一并失守。
# 判据：每个源文件必须是 root 拥有，且组/其他不可写；目录同理。
source_is_trusted() {
    local f st owner mode
    for f in "${SRC_FILES[@]}"; do
        st="$(stat -c '%U %a' "${SRC_DIR}/${f}" 2>/dev/null)" || return 1
        owner="${st%% *}"; mode="${st##* }"
        [[ "$owner" == "root" ]] || return 1
        # 组/其他可写位（022）必须为空
        (( (8#${mode} & 8#022) == 0 )) || return 1
    done
    return 0
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
        echo "  自测项数 ${n} 低于下限 ${COMPARATOR_MIN_TESTS} —— 测试可能被删减，拒绝部署" >&2
        return 1
    fi
    SELFTEST_COUNT="$n"
    return 0
}

if source_is_trusted; then
    # 绿灯只在真正可信时打印。这里曾经是一个 `if ! source_is_trusted; then … fi`
    # 后面跟着一行【无条件】的 ok —— 于是"源码不属于 root"的警告和"源文件可信"
    # 的绿灯会同时出现，而绿灯是假的。安全闸门本身给出假绿，正是本脚本最该
    # 避免的失效模式。
    ok "源文件可信（root 拥有且组/其他不可写）"
elif [[ "$MODE" == "check" ]]; then
    # --check 承诺"零改动"，它既不安装也不执行任何文件，所以不需要自拷贝。
    # 实际部署时脚本会先自拷贝到 root 专属目录。
    warn "源码不属于 root —— 实际部署时会先自拷贝到 root 专属目录再执行"
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
    BEFORE_HASH="$(cd "$SRC_DIR" && sha256sum "${SRC_FILES[@]}" 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
    cp -a "${SELF_DIR}/." "$SECURE_DIR/" || die "拷贝源码失败"
    chown -R root:root "$SECURE_DIR" || die "无法把拷贝的源码改为 root 所有，拒绝继续"
    chmod -R go-w "$SECURE_DIR" || die "无法收紧拷贝源码的权限，拒绝继续"
    # 注意：源文件与 deploy.sh 同在 cluster/ 下（历史上 deploy.sh 曾在 sh/ 下，
    # 那时这里是 ${SECURE_DIR}/cluster）。目录结构变了但这里没跟着改的话，
    # 从非 root 目录部署会走进这条自拷贝分支、然后在这里静默拿到空哈希。
    AFTER_HASH="$(cd "${SECURE_DIR}" && sha256sum "${SRC_FILES[@]}" 2>/dev/null | awk '{print $1}' | tr '\n' ' ')"
    if [[ "$BEFORE_HASH" != "$AFTER_HASH" ]]; then
        rm -rf "$SECURE_DIR"
        die "拷贝过程中源文件发生了变化（哈希不一致）。可能存在并发篡改，已中止。"
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
        exec bash "${SECURE_DIR}/$(basename "${BASH_SOURCE[0]}")" "$@"
fi
info "源文件哈希（可记录备查）：$(cd "$SRC_DIR" && sha256sum "${SRC_FILES[@]}" | awk '{printf "%s ", substr($1,1,12)}')"

# 非干扰比对器自身先自测 —— 依赖一个判定器之前，先证明它是对的
if comparator_selftest "${SRC_DIR}/nft-compare.py"; then
    ok "非干扰比对器自测通过（${SELFTEST_COUNT} 项，下限 ${COMPARATOR_MIN_TESTS}）"
else
    die "非干扰比对器 ${SRC_DIR}/nft-compare.py 自测未通过，无法保证部署安全性，已中止"
fi

# ── Python ──
[[ -x "$PY" ]] || die "找不到 ${PY}"
PYV="$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "?")"
"$PY" - <<'PYEOF' >/dev/null 2>&1 || die "Python 缺少必需能力（socket.SO_PEERCRED / sqlite3）"
import socket, sqlite3, json, configparser
assert socket.SO_PEERCRED
PYEOF
ok "Python ${PYV} 且具备 SO_PEERCRED / sqlite3"

# ── nft ──
[[ -x "$NFT" ]] || die "找不到 nft"
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
command -v sha256sum >/dev/null 2>&1 || die "找不到 sha256sum，无法校验现有文件是否被改动"
ok "sha256sum 可用"

# ── 端口区间自检：必须与配置里声明的「其他端口管理区间」完全不交 ──
# nftables 对【同 hook 同 priority 的跨表求值顺序没有保证】，所以只有"集合不交"
# 才能保证两个表的行为互不影响。要与哪些区间避让由 slurmate.conf 的
# reserved_ranges 决定 —— 早期实现把本集群的约定（"必须 > 55000"）写死在代码里，
# 结果任何没有那两套系统的集群用 55000 以下端口都装不上。
if (( PORT_MIN > PORT_MAX )); then
    die "端口区间起止颠倒：${PORT_MIN}-${PORT_MAX}"
fi
if (( PORT_MAX > 65535 )); then
    die "端口区间上界 ${PORT_MAX} 越界"
fi
if [[ -n "${RESERVED_RANGES// /}" ]]; then
    "$PY" - "$RESERVED_RANGES" "$PORT_MIN" "$PORT_MAX" <<'PYEOF' || \
        die "端口池与 reserved_ranges 重叠（见下）。跨表顺序在 nftables 里没有保证，
     重叠会导致行为不可预测。请调整 slurmate.conf 的 range_start/range_end
     或 reserved_ranges。"
import sys
def parse(spec):
    # ⚠️ 这里【只接受 start-end】，不接受裸数字 —— 必须与守护进程
    # Config 里那份解析器完全一致。两处规则不一致的后果是：
    # 部署预检放行了一份配置，守护进程启动时却抛 ValueError 起不来；
    # 或者反过来，配置在部署阶段就被拒，而它其实能跑。
    # 一个配置项有两套解释，是最难排查的一类问题。
    out = []
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        if "-" not in part:
            print("        reserved_ranges 的每一项应为 start-end 形式，得到: %r" % part)
            sys.exit(2)
        a, b = part.split("-", 1)
        if not (a.isdigit() and b.isdigit()):
            print("        reserved_ranges 的起止必须是数字，得到: %r" % part)
            sys.exit(2)
        out.append((int(a), int(b)))
    return out
spec, lo, hi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
for a, b in parse(spec):
    if a <= hi and lo <= b:
        print("        保留区间 %d-%d 与端口池 %d-%d 重叠" % (a, b, lo, hi))
        sys.exit(1)
sys.exit(0)
PYEOF
    ok "端口区间 ${PORT_MIN}-${PORT_MAX} 与 reserved_ranges 不交"
else
    ok "端口区间 ${PORT_MIN}-${PORT_MAX}（配置未声明需避让的区间）"
fi

RESERVED="$(sysctl -n net.ipv4.ip_local_reserved_ports 2>/dev/null || echo '')"
info "ip_local_reserved_ports = ${RESERVED:-（未设置）}"
# 真正判断区间是否重叠 —— 早期版本写成子串匹配（找 "55001" 这个字符串），
# 那只能抓到"恰好逐字写了边界值"的情况，等于永远不报警。
if [[ -n "$RESERVED" ]]; then
    "$PY" - "$RESERVED" "$PORT_MIN" "$PORT_MAX" <<'PYEOF' || \
        warn "端口池与 ip_local_reserved_ports 存在重叠（见上），可能出现偶发端口冲突"
import sys
def parse(spec):
    out = []
    for part in spec.replace(" ", "").split(","):
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            if a.isdigit() and b.isdigit():
                out.append((int(a), int(b)))
        elif part.isdigit():
            out.append((int(part), int(part)))
    return out
spec, lo, hi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
for a, b in parse(spec):
    if a <= hi and lo <= b:
        print("        保留区间 %d-%d 与端口池 %d-%d 重叠" % (a, b, lo, hi))
        sys.exit(1)
sys.exit(0)
PYEOF
fi
# 说明：计算节点的临时端口范围（默认 32768-60999）包含本端口池，
# 作业脚本的端口自检会跳过真正被占的端口并试下一个候选，属于预期行为。
info "提示：端口池 ${PORT_MIN}-${PORT_MAX} 未加入 ip_local_reserved_ports。"
info "      这只会让作业偶尔多试几个候选端口；nft 规则匹配 dport，不受影响。"

# ── 目标位置是否已被非本系统的文件占用 ──
for dst in "$DAEMON" "$CLI" "$JOBSH" "$CONF" "$UNIT"; do
    if [[ -e "$dst" ]]; then
        if ! grep -qi "slurmate" "$dst" 2>/dev/null; then
            die "目标文件已存在且不属于 Slurmate：
       ${dst}
     为避免覆盖他人文件，部署中止。请人工确认后自行删除或改名再重试。"
        fi
    fi
done
ok "目标路径未被他人文件占用"

# ── 通用预检：这台机器看起来是不是一个 Slurm 登录节点 ──
# 这几项对任何集群都成立，缺了就不该继续 —— 这是"别在错误的机器上部署"
# 这条诉求的通用形式。
for c in sbatch scancel squeue scontrol; do
    command -v "$c" >/dev/null 2>&1 || die "找不到 ${c} —— 这台机器不像是 Slurm 登录节点。"
done
ok "Slurm 命令齐备（sbatch / scancel / squeue / scontrol）"
if command -v scontrol >/dev/null 2>&1; then
    if scontrol ping >/dev/null 2>&1; then
        ok "Slurm 控制器可达（scontrol ping 成功）"
    else
        warn "scontrol ping 失败 —— 控制器不可达。部署能完成，但作业提交与回收都会失败。"
        warn "  守护进程的 job_state() 会把这种情况判为 JOB_UNKNOWN 并保持现状，"
        warn "  也就是不会误释放会话 —— 但仍建议先修好 Slurm 再部署。"
    fi
fi

# ── 可选基线检查：本系统最初部署环境的其余端口管理设施 ──
# **Slurmate 不依赖它们**（独立的 nft 表、独立的端口区间、独立的服务），
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

info "备份目录：${BACKUP_DIR}"

# ==============================================================================
step "阶段 1／6  快照（用于部署后的非干扰比对）"
# ==============================================================================

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# nftables 规则集：结构化快照
snapshot_ruleset() {
    local out="$1"
    if "$NFT" -j list ruleset > "$out" 2>/dev/null && [[ -s "$out" ]]; then
        return 0
    fi
    "$NFT" list ruleset > "$out" 2>/dev/null || true
}
snapshot_ruleset "${BACKUP_DIR}/nft-before.json"
if [[ -s "${BACKUP_DIR}/nft-before.json" ]]; then
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
done > "${BACKUP_DIR}/hashes-before.txt"
ok "已保存外部文件哈希（$(wc -l < "${BACKUP_DIR}/hashes-before.txt") 项）"

# 锁目录内容
ls -A /tmp/codeserver-ports 2>/dev/null | sort > "${BACKUP_DIR}/locks-before.txt" || : > "${BACKUP_DIR}/locks-before.txt"
ok "已保存锁目录清单（$(wc -l < "${BACKUP_DIR}/locks-before.txt") 项）"

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
} > "${BACKUP_DIR}/services-before.txt"
ok "已保存服务状态"

if [[ "$MODE" == "check" ]]; then
    step "只体检模式（--check）：不安装任何东西"
    info "源文件与目标位置检查通过。"
    info "已保存快照到 ${BACKUP_DIR}"
    info "如需部署，去掉 --check 重跑。"
    echo
    echo "  预检通过 ${PASS_N} 项，警告 ${WARN_N} 项，失败 ${FAIL_N} 项"
    exit 0
fi


# ==============================================================================
step "阶段 2／6  安装文件"
# ==============================================================================

install_one() {
    local src="$1" dst="$2" mode="$3"
    if [[ "$DRYRUN" -eq 1 ]]; then
        echo "  [演练] install -m ${mode} ${src} → ${dst}"
        return 0
    fi
    # 覆盖旧版本前先备份 —— 否则升到一个坏版本后，唯一的退路是 --uninstall
    # （连同旧版本一起没了），没有可回退的副本。
    if [[ -e "$dst" ]]; then
        if cp -a "$dst" "${BACKUP_DIR}/replaced-$(basename "$dst").$(date +%s)" 2>/dev/null; then
            info "已备份被覆盖的旧文件：$dst"
        else
            warn "无法备份 $dst（继续安装，但升级后没有旧版本可回退）"
        fi
    fi
    install -m "$mode" -o root -g root "$src" "$dst" || die "安装失败：$dst"
    ok "$dst  (${mode})"
}

# 确保所有目标文件的父目录存在（真实系统上这些目录本来就在，但不能依赖这个前提）
for d in "$(dirname "$DAEMON")" "$(dirname "$CLI")" "$SHARE_DIR" "$CONF_DIR" \
         "$(dirname "$UNIT")" "$STATE_DIR"; do
    if [[ ! -d "$d" ]]; then
        run mkdir -p "$d"
        if [[ "$DRYRUN" -eq 1 ]]; then
            info "将创建目录 $d（演练，尚未创建）"
        else
            info "已创建目录 $d"
        fi
    fi
done
[[ "$DRYRUN" -eq 1 ]] || chmod 755 "$SHARE_DIR" "$CONF_DIR"
[[ "$DRYRUN" -eq 1 ]] || chmod 700 "$STATE_DIR"

install_one "${SRC_DIR}/slurmate-sessiond"  "$DAEMON"  755
install_one "${SRC_DIR}/slurmate"           "$CLI"     755
install_one "${SRC_DIR}/run.sbatch"         "$JOBSH"   644
install_one "${SRC_DIR}/nft-compare.py"     "${SHARE_DIR}/nft-compare.py" 644

# ── slurmate.conf：只在【不存在】时安装 ──
# 它是站点配置 —— 管理员会在上面改端口区间、用途→分区映射、超时、配额。
# 重复部署时覆盖它等于把站点的调优悄悄抹掉（而且下次重启守护进程才生效，
# 故障会出现在很久之后）。要重置就手动删掉它再跑。
if [[ -e "$CONF" ]]; then
    info "保留已有站点配置：${CONF}"
    info "  随仓库分发的版本在 ${SRC_DIR}/slurmate.conf.example，可对比新增了哪些项"
else
    install_one "${SRC_DIR}/slurmate.conf.example" "$CONF" 644
fi

# ── systemd 单元：从模板渲染 ──
# ReadOnlyPaths 必须是本站点真实的共享家目录挂载点，不能写死 ——
# 写死的后果是守护进程在一个不存在的路径上做只读挂载，systemd 直接拒绝启动。
READONLY_PATHS="$(sed -nE 's/^[[:space:]]*readonly_paths[[:space:]]*=[[:space:]]*(.*)/\1/p' "$SRC_CONF" 2>/dev/null \
    | head -1 | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
UNIT_RENDERED="${BACKUP_DIR}/slurmate-sessiond.service.rendered"
if [[ -n "$READONLY_PATHS" ]]; then
    sed "s|@READONLY_PATHS@|${READONLY_PATHS}|" "${SRC_DIR}/slurmate-sessiond.service.in" > "$UNIT_RENDERED"
    info "systemd 单元：ReadOnlyPaths=${READONLY_PATHS}"
else
    sed "/@READONLY_PATHS@/d" "${SRC_DIR}/slurmate-sessiond.service.in" > "$UNIT_RENDERED"
    warn "配置里 readonly_paths 为空 —— 生成的服务单元【不含】共享存储只读挂载。"
    warn "  这会去掉「root 不写用户家目录」那层保护，请确认这是你要的。"
fi
install_one "$UNIT_RENDERED" "$UNIT" 644

# 目录权限必须是 0755，不能是 0700：
#   - /usr/local/share/slurmate 里的 run.sbatch 由【用户身份】的 sbatch 读取
#   - /etc/slurmate/slurmate.conf 由【用户身份】的 slurmate CLI 读取（找 socket 路径）
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
    bash -n "$JOBSH"       || die "作业脚本语法检查失败，已中止"
    comparator_selftest "${SHARE_DIR}/nft-compare.py" \
        || die "已安装的比对器自测未通过（项数下限 ${COMPARATOR_MIN_TESTS}），已中止"
    ok "语法自检通过（守护进程 / CLI / 作业脚本 / 比对器）"
fi

# ==============================================================================
step "阶段 3／6  配置自检（不启动服务）"
# ==============================================================================

if [[ "$DRYRUN" -eq 1 ]]; then
    info "[演练] 跳过"
else
    if "$DAEMON" --check --config="$CONF"; then
        ok "配置自检通过"
    else
        die "配置自检失败。未启动服务，未创建任何 nft 规则。"
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
        bad "systemctl daemon-reload 失败 —— 单元可能未生效，请检查 /etc/systemd/system 下的单元文件"
    fi

    if systemctl enable "$SERVICE" >/dev/null 2>&1; then
        ok "已设为开机自启"
    else
        bad "systemctl enable 失败（不影响本次运行，但重启后不会自启）"
    fi
fi

if [[ "$DRYRUN" -eq 0 ]]; then
    # 先 stop 再 start（而不是 restart），确保配置改动完全生效
    systemctl stop "$SERVICE" 2>/dev/null || true
    if systemctl start "$SERVICE"; then
        ok "服务已启动"
    else
        bad "服务启动失败 —— 打印最近日志："
        journalctl -u "$SERVICE" -n 30 --no-pager 2>/dev/null | sed 's/^/        /' >&2
        die "启动失败。nft 表可能未创建；本系统之外的一切未受影响。排查后重跑本脚本即可。"
    fi
    # 等待守护进程真正就绪（socket + nft 表都到位），最多 20 秒。
    # 不用固定 sleep —— 慢机器上会误报，快机器上会白等。
    READY=0
    WAITED=0
    for i in $(seq 1 20); do
        WAITED=$i
        if [[ -S "$SOCKET" ]] && "$NFT" list table inet slurmate >/dev/null 2>&1; then
            READY=1
            break
        fi
        # 服务已经挂了就没必要继续等
        systemctl is-active --quiet "$SERVICE" || break
        sleep 1
    done
    if [[ "$READY" -eq 1 ]]; then
        ok "守护进程就绪（socket + nft 表，用时约 ${WAITED}s）"
    else
        warn "等待 ${WAITED}s 后守护进程未完全就绪，继续验证（下面的检查会指出缺什么）"
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
snapshot_ruleset "${BACKUP_DIR}/nft-after.json"
RULESET_OUT="$("$PY" "${SRC_DIR}/nft-compare.py" \
                   "${BACKUP_DIR}/nft-before.json" \
                   "${BACKUP_DIR}/nft-after.json" 2>&1 || true)"
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
        bad "  这可能是本系统改到了别人的表。请立即检查，必要时回滚："
        bad "      sudo bash ${SCRIPT_PATH} --uninstall"
        ;;
    REORDER)
        bad "nftables 规则的【顺序】变了（多重集相同但顺序不同）："
        bad "  链内顺序在 nftables 里是有语义的（drop 在 accept 前后是真实的行为变更），"
        bad "  而且没有任何合法原因会造成纯重排 —— 规则的增删必然改变多重集，只有重排不改变。"
        bad "  请立即检查！回滚：sudo bash ${SCRIPT_PATH} --uninstall"
        ;;
    NOSNAPSHOT)
        bad "规则集快照缺失或为空 —— 【无法】证明部署没有干扰现有规则。"
        bad "  这本身就是失败，不是警告。请检查上面的快照保存步骤。"
        ;;
    TEXTMODE)
        bad "规则集不是合法 JSON —— 【无法】做结构化比对，无法证明非干扰。"
        ;;
    *)
        bad "规则集比对异常：${RULESET_OUT:-（无输出）}"
        ;;
esac

# ── 5.2 外部文件哈希未变 ──
for f in "${FOREIGN_FILES[@]}"; do
    printf '%s  %s\n' "$(hash_of "$f")" "$f"
done > "${BACKUP_DIR}/hashes-after.txt"

if grep -q 'HASHFAIL' "${BACKUP_DIR}/hashes-after.txt" 2>/dev/null; then
    bad "有文件哈希计算失败（见上面的 HASHFAIL）—— 【无法】证明现有文件未被改动"
    grep 'HASHFAIL' "${BACKUP_DIR}/hashes-after.txt" | sed 's/^/        /' >&2
elif diff -q "${BACKUP_DIR}/hashes-before.txt" "${BACKUP_DIR}/hashes-after.txt" >/dev/null; then
    # "两份相等"有两种截然不同的含义：真的都没变，或者【本来就不存在】。
    # 后者什么都没证明。分开报告，别让"没有可比的东西"冒充成"一切正常"。
    n_total="$(wc -l < "${BACKUP_DIR}/hashes-after.txt")"
    n_absent="$(grep -c '^MISSING' "${BACKUP_DIR}/hashes-after.txt" || true)"
    n_compared=$(( n_total - n_absent ))
    if (( n_compared == 0 )); then
        info "外部文件全部不存在（${n_total} 项）—— 本项【未参与校验】，不代表它们未被改动"
    else
        ok "外部文件哈希未变（实际比对 ${n_compared} 项，另有 ${n_absent} 项本就不存在）"
    fi
else
    bad "现有文件发生变化："
    diff "${BACKUP_DIR}/hashes-before.txt" "${BACKUP_DIR}/hashes-after.txt" | sed 's/^/        /' >&2
fi

# ── 5.3 锁目录内容未变（并发用户活动会影响它，故只警告） ──
ls -A /tmp/codeserver-ports 2>/dev/null | sort > "${BACKUP_DIR}/locks-after.txt" || : > "${BACKUP_DIR}/locks-after.txt"
if diff -q "${BACKUP_DIR}/locks-before.txt" "${BACKUP_DIR}/locks-after.txt" >/dev/null; then
    ok "codeserver 锁目录内容未变"
else
    warn "锁目录有变化（通常是并发用户启停了 code-server，非本系统所致）："
    diff "${BACKUP_DIR}/locks-before.txt" "${BACKUP_DIR}/locks-after.txt" | sed 's/^/        /' >&2
fi

# ── 5.4 sshd 配置语法 ──
if ! command -v sshd >/dev/null 2>&1; then
    warn "找不到 sshd 命令，跳过语法检查（本系统确实未修改 sshd 配置）"
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
    grep -qx "${s}=active" "${BACKUP_DIR}/services-before.txt" 2>/dev/null || continue
    n_svc_checked=$(( n_svc_checked + 1 ))
    if systemctl is-active --quiet "$s" 2>/dev/null; then
        ok "部署前在运行的服务 $s 仍在运行"
    else
        bad "服务 $s 在部署前是 active，现在不是了！请检查：journalctl -u $s -n 50"
    fi
done
if (( n_svc_checked == 0 )); then
    info "部署前没有本名单中的服务在运行 —— 本项无对象可查（不是失败）"
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

# ==============================================================================
step "阶段 6／6  完成"
# ==============================================================================

if [[ "$DRYRUN" -eq 1 ]]; then
    DONE_TITLE="  将安装（演练：下列路径尚未写入任何文件）："
    DRYRUN_BANNER="
  ⚠ 本次是【演练 --dry-run】：没有安装文件、没有启动服务、没有改动 nftables。
     下面列出的是\"将要安装\"的位置，不是已经装好的结果。"
else
    DONE_TITLE="  已安装："
    DRYRUN_BANNER=""
fi

cat <<EOF
${DRYRUN_BANNER}

  通过 ${PASS_N} 项，警告 ${WARN_N} 项，失败 ${FAIL_N} 项
  备份与快照：${BACKUP_DIR}

${DONE_TITLE}
    ${DAEMON}
    ${CLI}
    ${JOBSH}
    ${CONF}
    ${UNIT}
    ${SHARE_DIR}/nft-compare.py

  端口池：${PORT_MIN}-${PORT_MAX}${RESERVED_RANGES:+（与 reserved_ranges
          ${RESERVED_RANGES} 严格不交，跨表行为因此与顺序无关）}

  常用操作：
    systemctl status slurmate-sessiond
    journalctl -u slurmate-sessiond -f
    ${CLI} doctor                 # 普通用户跑，诊断 ACL 是否与服务一致
    ${DAEMON} --check             # 重新做一次配置自检

  卸载：
    sudo bash ${SCRIPT_PATH} --uninstall              # 保留状态与日志
    sudo bash ${SCRIPT_PATH} --uninstall --purge-state

EOF

if [[ "$FAIL_N" -gt 0 ]]; then
    echo "  ⚠ 有 ${FAIL_N} 项失败，请务必按上面的提示排查。" >&2
    echo "     如需回滚：sudo bash ${SCRIPT_PATH} --uninstall" >&2
    exit 1
fi
exit 0
