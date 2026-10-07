#!/bin/bash
# ==============================================================================
#  install-base.sh — Slurmate 集群侧**基座**安装 / 卸载
# ==============================================================================
#
#  在【控制节点（登录节点）】上以 root 运行。
#
#  ★★ v0.12 阶段 4 起本脚本**只管基座**：守护进程、CLI、作业模板、systemd 单元、
#     站点配置主文件、目录骨架。它**不再碰插件** —— 插件那四件事（装包 / 编织
#     作业脚本 / 对齐配置 / 卸包）有一个**唯一入口**：
#
#         sudo slurmate plugin install [--from DIR]   装（可从一个目录整批对齐）
#         sudo slurmate plugin uninstall <id>…        卸
#         sudo slurmate plugin sync                   对齐配置与作业脚本
#
#     它们走守护进程里的**安装器 / 卸载器**（`--install-plugins` /
#     `--uninstall-plugins` / `--sync-plugins`）—— 读包、验签、同 id 检查、
#     三道作业侧断言，各只有那一份实现。
#
#     ★ 为什么搬走：本脚本从前压着三件不同的事（插件、部署预检、基座安装），
#       而"插件是独立项目，装它却要重跑一次整个部署"正是压在一起的结果。
#     ★ 为什么**不整个删掉**：基座这一半还没有软件包接手（deb/rpm 是另一条
#       决定，见 KNOWN-ISSUES）。它整个消失的那一天 = 基座软件包做出来的那一天。
#
#  ★ **部署预检**那一半也拆了：凡守护进程自己判得了的（端口区间自洽、与
#    reserved_ranges 相交、Slurm 命令齐备、cluster_cidr 与节点对账…）都进
#    `slurmate-sessiond --check` —— **同一件事只允许有一个判据**。本脚本现在
#    只是**调用**它，并把它的两个退出码分开对待（见〈阶段 0〉那一段）。
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
#    sudo bash install-base.sh                     # 装基座
#    sudo bash install-base.sh --check             # 只体检，不做任何改动
#    sudo bash install-base.sh --dry-run           # 演练，不做任何改动
#    sudo bash install-base.sh --uninstall         # 卸载（保留状态数据）
#    sudo bash install-base.sh --uninstall --purge-state
#    sudo bash install-base.sh --require-baseline  # 前置基线缺失即中止（见下）
#
#  装完基座之后装插件（那是**唯一**的插件入口，本脚本不认识插件）：
#    sudo slurmate plugin install --from /srv/slurmate-pkgs
#    ★ 包是**构建产物**（作者在他机器上 `packer build` 出来的 `<id>.splug`），
#      不进 git；本脚本与安装器**永不打包**，服务器上从头到尾没有源码树。
#    ★ 一个插件都没有是**合法状态**：基座照常起，会话照常能查能停。
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
# ★ `<SHARE_DIR>/jobs` 与 `<SHARE_DIR>/plugins` **不归本脚本管** —— 那两条路径
#   由安装器按同一个前缀算出来（`slurmate-sessiond` 的 default_jobs_dir /
#   default_plugins_dir），本脚本**不认识它们**。这是刻意的：一个路径一旦有两个
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

while [[ $# -gt 0 ]]; do
    arg="$1"; shift
    case "$arg" in
        --check)             MODE="check" ;;
        --uninstall)         MODE="uninstall" ;;
        --dry-run)           DRYRUN=1 ;;
        --require-baseline)  REQUIRE_BASELINE=1 ;;
        # 兼容旧命令行：--force 曾经是"基线不完整时仍继续"。现在默认就是继续，
        # 所以它已成空操作，但保留接受，免得旧脚本/旧笔记里的命令直接报错。
        --force)             : ;;
        --purge-state)       PURGE=1 ;;
        # ★ v0.12 阶段 4：插件不再经过本脚本。**说清楚它搬去哪儿**，而不是
        #   只说一句"未知参数" —— 那会让人以为是自己打错了。
        #
        #   ★★ 两种写法都要取到那个目录：`--plugins-src=X` 的 X 在同一个参数里，
        #     而 `--plugins-src X` 的在**下一个**（上面 `arg="$1"; shift` 已经
        #     shift 过了，所以下一条就是现在的 `$1`）。只认等号那一种的话，
        #     管理员照最顺手的写法敲，得到的指路里那一条命令**自己跑不通**
        #     （印出来是 `--from --plugins-src`）。
        --plugins-src|--plugins-src=*)
            _src="${arg#--plugins-src=}"
            [[ "$_src" == "$arg" ]] && _src="${1:-DIR}"
            echo "★ 插件不再经过本脚本（v0.12 起）：本脚本只装基座。" >&2
            echo "  装插件（那是唯一的入口）：" >&2
            echo "      sudo slurmate plugin install --from ${_src}" >&2
            exit 2 ;;
        -h|--help)
            # ★★ 印的是**文件头那一段**（标题那两行之间的东西），不是整个文件头。
            #
            #   从前这里是 `sed -n '2,/^# =====/p'` —— 而第 2 行**自己**就是一条
            #   `# =====`，于是它只印出横幅那三行，下面整段「用法」一次都没打出来
            #   过（`--help` 看起来"能用"，只是短得没人怀疑）。v0.12 阶段 4 顺手
            #   修掉：这一版往用法里加了"插件搬到哪儿去了"，而它必须**读得到**。
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

    # ── 插件：交给**卸载器**，本脚本不认识那几处痕迹 ────────────────────────
    #
    # ★★ v0.12 阶段 4 起，一个插件在站点上留下哪几处痕迹（包 / 它那份配置 /
    #    它那份作业脚本 / 站点侧那条签名者记录）**只有卸载器知道**（守护进程的
    #    `uninstall_plugins()`）。这里从前有一份孪生实现（按 `.installed` 标记删
    #    包、按 ULID 删配置、按标记删作业脚本），两份判据迟早会漂开 —— 而漂开的
    #    症状是"卸载之后站点上还剩一点什么"，没有任何地方会报错。
    #
    # ★ 用**已装的**那份守护进程（`$DAEMON`），不是源码里那份：卸载要在**任何**
    #   状态下都做得到（源码目录可能已经没了、配置可能坏了），而装在盘上的那一份
    #   正是这个站点上"插件是什么"的判据来源。它必须在下面删二进制**之前**跑。
    #
    # ★ 它失败**不中止卸载**：卸载的第一属性是**永远可用**（出故障时管理员最需要
    #   的就是能干净地把它拿掉）。失败时说清"哪几处还在、怎么人工收尾"。
    if [[ -x "$DAEMON" ]]; then
        if "$PY" "$DAEMON" --uninstall-plugins --all-plugins --config="$CONF" >/dev/null 2>&1; then
            ok "已卸掉本站的全部插件（包 / 它们的配置 / 它们的作业脚本 / 钥匙记录）"
        else
            warn "插件卸载器没能跑完 —— 站点上可能还剩着插件包或它们的配置。"
            warn "  人工看一眼（这一步在做任何删除之前，所以安全）："
            warn "      ${DAEMON} --uninstall-plugins --all-plugins --config=${CONF}"
            warn "  看完再重跑本脚本；直接继续也行，那几份会留在盘上。"
        fi
    else
        info "没找到已装的守护进程 —— 跳过插件卸载（本机可能只装了一半）"
    fi

    # 删文件前逐项确认"这确实是本系统装的文件"。
    # 早期版本在这里无条件 rm -f，而脚本又反复提示用 --uninstall 做回滚 ——
    # 于是在一台从未部署过 Slurmate 的机器上执行它，会删掉同名的他人文件。
    # 注意：这是 root 的 rm，不设防的代价是别人的东西。
    for f in "$DAEMON" "$CLI" "$CONF" "$UNIT" "${SHARE_DIR}/nft-compare.py" \
             "${SHARE_DIR}/run.sbatch.template"; do
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

    # 只在目录为空时才删 —— 里面若有别人放的东西就留着。
    # ★ `<SHARE_DIR>` 下面那两个子目录（plugins/ 与 jobs/）由卸载器收掉；
    #   它只在**空掉**时才 rmdir，所以"里面还有别人的东西"这一格是安全的。
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

# ── 插件包 ──
# 所有源文件的【绝对路径】。两处用它：信任检查、以及"拷贝前后哈希一致"。
#
# ★★ **插件包不在名单里了**（v0.12 阶段 4）：本脚本不装插件，它也无从知道
#    "哪个目录里放着包"（那由 `slurmate plugin install --from DIR` 说）。
#    信任门在**安装器**那一侧仍然逐包判，而且是同一个判据的不变部分
#    —— "root 拥有 + 组/其他不可写"（`package_input_problem`）。
#    ★ 从前那条"源目录里任何一个文件都能被普通用户改写 ⇒ 他改一行 client/**.js，
#      那行代码就在每个用户的工作站上跑"讲的正是**包**，所以它跟着判据一起搬到
#      安装器那里去了 —— 不是被丢掉了。
ALL_SRC_FILES=()
while IFS= read -r f; do
    [[ -n "$f" ]] && ALL_SRC_FILES+=("$f")
done < <(for f in "${SRC_FILES[@]}"; do printf '%s\n' "${SRC_DIR}/${f}"; done)

# ── 源文件可信性 ──
# 本脚本会以 root 身份【安装并执行】这些文件。若它们能被普通用户改写，
# 等于把 root 权限交出去 —— 那几套正在服务真实用户的生产系统也会一并失守。
# 判据：每个源文件必须是 root 拥有，且组/其他不可写；目录同理。
source_is_trusted() {
    local f st owner mode
    for f in "${ALL_SRC_FILES[@]}"; do
        st="$(stat -c '%U %a' "$f" 2>/dev/null)" || return 1
        owner="${st%% *}"; mode="${st##* }"
        [[ "$owner" == "root" ]] || return 1
        # 组/其他可写位（022）必须为空
        (( (8#${mode} & 8#022) == 0 )) || return 1
    done
    return 0
}

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
    BEFORE_HASH="$(src_hash_all)"
    # 布局照搬一层（cluster/）。★ 从前这里还要把**插件源目录**也拷一份（那时本
    # 脚本要读包）；插件搬走之后没有第二个目录要拷了。
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
    # 注意：源文件与 install-base.sh 同在 cluster/ 下（历史上 install-base.sh 曾在 sh/ 下，
    # 那时这里是 ${SECURE_DIR}/cluster）。目录结构变了但这里没跟着改的话，
    # 从非 root 目录部署会走进这条自拷贝分支、然后在这里静默拿到空哈希。
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

# 源码里的那一份守护进程。下面**每一次自检、每一次插件操作走的都是它**——
# 不是刚装到 ${DAEMON} 的那一份。
#
# ★ 为什么用源码里这一份：`${DAEMON}` 在"第一次部署"时还不存在，而在"升级部署"
#   时它是**上一个版本**。用旧版本去校验新版本的配置/模板，失败方式会是一句看不懂
#   的报错（或者更糟：它恰好收下了）。源码这一份永远与本次部署的规则同源。
#   放在这里而不是文件开头：上面那条自拷贝分支会把 SRC_DIR 改掉。
DAEMON_SRC="${SRC_DIR}/slurmate-sessiond"

# 这一次要拿给守护进程自检的那份配置：**已经装过就读已装的那份**（管理员可能
# 按站点改过），否则读随仓库分发的示例。
#
# ★★ 它在**自拷贝之后**才算，这一点是承重的：从前这一行在文件开头，于是从
#   非 root 目录部署、走进自拷贝分支时，它仍然指着**原来那个（别人能改写的）**
#   示例文件 —— 而那个文件后面会被读出来渲染 systemd 单元（readonly_paths）。
#   判据是"我读的这一份必须来自我已经固定下来的目录"。
SRC_CONF="${SRC_DIR}/slurmate.conf.example"
if [[ -r "$CONF" ]]; then
    SRC_CONF="$CONF"
fi

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

# ── 目标位置是否已被非本系统的文件占用 ──
#
# ★ 这一条**留在本脚本里**，它没有第二份实现也不该有：它问的是"我要写的那几个
#   位置现在是谁的"，只有**要写它们的人**知道这件事。`--check` 判不了它
#   （守护进程不知道自己是不是被覆盖着装上的，也不该知道）。
for dst in "$DAEMON" "$CLI" "$CONF" "$UNIT"; do
    if [[ -e "$dst" ]]; then
        if ! grep -qi "slurmate" "$dst" 2>/dev/null; then
            die "目标文件已存在且不属于 Slurmate：
       ${dst}
     为避免覆盖他人文件，部署中止。请人工确认后自行删除或改名再重试。"
        fi
    fi
done
# 作业脚本目录与插件目录**不在这张表里**：它们不归本脚本管（见文件头），
# 而各自的守卫长在**安装器**那一侧（它才是往里面写的人）。
ok "目标路径未被他人文件占用"

# ==============================================================================
#  ★★ 「这台机器对不对、这份配置对不对」—— 一律问守护进程自己
# ==============================================================================
#
#   这一段从前是本脚本里的一大块**孪生实现**：端口区间自洽、与 reserved_ranges
#   相交、Slurm 命令齐备、控制器可达 —— 每一条守护进程都判过一遍（`validate()`
#   与 `--check`），而两处判据的失效方式是**"预检放行了、守护进程起不来"**
#   （或者反过来），这个仓库已经因为同一类分叉吃过一次亏（reserved_ranges 的
#   解析器）。⇒ v0.12 阶段 4 起这里只剩**一次调用**。
#
#   ★★ 而它的两个退出码要**分开对待**，这正是"部署脚本也要能读它"的原因：
#
#        2 = **这台机器**缺东西（缺 Slurm 命令、缺 nft）
#            ⇒ 现在就停。装文件之前就停 —— 那正是本脚本开头那句
#              「任何一项不满足即中止，不做任何改动」。
#        1 = **这份配置**写错了
#            ⇒ 第一次部署时 `cluster_cidr` 还空着，**那本来就是预期状态**，
#              继续装；装完、配置落盘之后〈阶段 3〉还会再跑一次，那一次才是门。
#              而若读的是**已装的**那份配置（重复部署），它就必须是对的 ⇒ 停。
#
#   ★ 退出码 2 这个约定写在守护进程那一侧（见 `machine_selfcheck()`），
#     这里是唯一的读者。
#   ★ `--dry-run` 下**照跑**：它是只读的，而"演练"要回答的正是"真跑起来会怎样"
#     —— 演练时把最该发现的那件事藏起来，那个演练就没有意义。
#
#   ★ 过了就**只打一行**：完整那一屏〈阶段 3〉还会再打一次（那一次读的是刚落盘的
#     站点配置），在这里重复一遍只会把别的信息淹掉。没过才把输出打出来。
_check_out="$("$PY" "$DAEMON_SRC" --check --config="$SRC_CONF" 2>&1)"
_check_rc=$?
_check_dump() { printf '%s\n' "$_check_out" | sed 's/^/        /' >&2; }
case "$_check_rc" in
    0)
        ok "自检通过（用的是 ${SRC_CONF}）" ;;
    2)
        _check_dump
        die "这一台**机器**缺东西（见上，标着 ✗ 的那几条）。
     装文件之前必须先解决它 —— 本脚本的承诺是「不满足即中止，不做任何改动」。
     它问的是「这台机器上有没有 nft、有没有那八个 Slurm 命令」，
     与你要装什么版本的 Slurmate 无关。" ;;
    1)
        if [[ "$SRC_CONF" == "$CONF" ]]; then
            _check_dump
            die "已装的站点配置 ${CONF} 自检没通过（见上）。重复部署时它必须是
     对的 —— 部署中止，一个字节都没有改。改完重跑本脚本。"
        fi
        warn "示例配置 ${SRC_CONF} 的自检没通过 —— **第一次部署时这是正常的**："
        warn "  它里面的 cluster_cidr 还是空的，而没有安全的默认值。（详细那一屏在"
        warn "  〈阶段 3〉：那一次读的是刚落盘的站点配置，它才是门。）" ;;
    *)
        _check_dump
        die "自检没跑起来（退出码 ${_check_rc}，见上）。多半是 ${DAEMON_SRC}
     本身有问题 —— 而此时正是最该停下来的时候。" ;;
esac

# ── 「控制器可达吗」也**不在这里** ──
# ★★ 它上面那次 `--check` 已经问过、也打印了结论（`控制器 : 在线 / 【连不上】…`），
#    连同"提交与回收会失败"这句后果。本脚本再 `scontrol ping` 一次就是**同一件
#    事的第二份实现** —— 而两份探测之间可以变，于是它们还能给出互相矛盾的答案
#    （"上面说连不上、下面说可达"），那正是让人不再相信报告的开始。
#
#    ★ 这一条刻意**不是** `validate()` 的硬错误：控制器抖一下不该让整个站点起
#      不来（那连"停掉正在跑的会话"都做不到）。所以 `--check` 只是打印它，
#      退出码不受影响 —— 部署照常继续。

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

    # ★ **插件不在这里体检**（v0.12 阶段 4）：本脚本不装插件，也就无从知道
    #   "哪一批包要装"（那是 `slurmate plugin install --from DIR` 说的）。
    #   要体检一个包目录：`slurmate-sessiond --check-plugins --plugins-dir DIR`
    #   —— 判据与安装器**逐字相同**（同一个 `scan_plugins`），所以这里不再抄一遍。
    if [[ "$DRYRUN" -eq 1 ]]; then
        info "[演练] 跳过"
    else
        info "插件不在本脚本的范围内 —— 装/卸/对齐走："
        info "    slurmate plugin install --from DIR | uninstall <id> | sync"
    fi

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
# ★ 0755 而不是 0700：`<SHARE_DIR>` 下面有两样东西要被**用户身份**的进程读 ——
#   编织好的作业脚本（`jobs/<ULID>.sbatch`，由提交作业的用户身份的 sbatch 读）
#   与作业模板（安装器用它织）。0700 的表现是 sbatch 报「读不到文件」，而那句
#   话指不回权限，会让人去查脚本是不是生成失败了。
[[ "$DRYRUN" -eq 1 ]] || chmod 755 "$SHARE_DIR" "$CONF_DIR"
[[ "$DRYRUN" -eq 1 ]] || chmod 700 "$STATE_DIR"

install_one "${SRC_DIR}/slurmate-sessiond"  "$DAEMON"  755
install_one "${SRC_DIR}/slurmate"           "$CLI"     755
install_one "${SRC_DIR}/nft-compare.py"     "${SHARE_DIR}/nft-compare.py" 644
# ★★ **作业模板**装到 `<SHARE_DIR>/run.sbatch.template`（v0.12 阶段 4）。
#
#   它是**安装器织作业脚本时要读的那一份** —— 装它是因为装完基座之后集群上
#   可能根本没有仓库（`cluster/` 只在部署机上），而从那一刻起"装一个插件"必须
#   能独立完成。名字里带 `template` 是刻意的：`jobs/` 下那一串才是作业脚本，
#   这一份不是作业、也不会被提交。
install_one "${SRC_DIR}/run.sbatch" "${SHARE_DIR}/run.sbatch.template" 644

# ── slurmate.conf：只在【不存在】时安装 ──
# 它是站点配置 —— 管理员会在上面改端口区间、要避让的其他区间、集群网段。
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
    # ★ **作业脚本不在这一轮里**（v0.12 阶段 4）：装好的每一份都在
    #   `<SHARE_DIR>/jobs/` 下，由**安装器**织、也由它在织的时候逐份 `bash -n`
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
    # 这一条跑的是守护进程【自己的】自检 —— **这是第二次**：〈阶段 0〉那一次
    # 用的是**还没装上/还没配好**的那份配置（首次部署时它是随仓库分发的示例，
    # cluster_cidr 还空着，所以那一次允许它不通过）。这一次读的是**刚落盘的那份
    # 站点配置**，它必须是对的。
    #
    # ★ 退出码 2（机器缺东西）在〈阶段 0〉已经拦过了；走到这里还拿到 2 只可能
    #   是这两步之间机器被改过 —— 那时也该停。
    if "$DAEMON" --check --config="$CONF"; then
        ok "配置自检通过"
    else
        die "配置自检失败（原因见上）。未启动服务，未创建任何 nft 规则。
     多半是 ${CONF} 里的 cluster_cidr 还没改成本集群的网段 —— 它没有安全的默认值，
     留空或仍是文档占位网段都会被拒绝。改完重跑本脚本。"
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
    # ★★ v0.12 阶段 3：服务**在跑**时走 `reload`，不再 stop + start。
    #
    #   从前的下线是"先 stop 再 start（而不是 restart），确保配置改动完全生效"
    #   —— 它的代价是**所有人的会话断一次**，就为了改一行配置或装一个插件。
    #   而现在改配置本身热得起来（守护进程的 `reload_config()`）。
    #
    #   ★ 热不起来的那些键（`readonly_paths`）由守护进程**自己拒绝整个 reload**
    #     并说清是哪一个键 —— 那时它仍然用**旧配置**照常服务，所以这里不能报
    #     "已生效"。这一条分支说的是实话：改了没生效，要重启。
    if systemctl is-active --quiet "$SERVICE"; then
        # ★★ 说准：`systemctl reload` 回 0 只表示**信号送到了** —— systemd 不知道
        #   服务内部接不接受这次改动（守护进程可能**整个拒绝**并说清是哪个键）。
        #   所以这里不能说"配置已生效"。
        if systemctl reload "$SERVICE"; then
            ok "服务已在运行 → 已给它发了重载信号（正在跑的会话一条都没断）"
            info "  它有没有接受这次改动，看它自己的日志：journalctl -u ${SERVICE} -n 20"
        else
            warn "systemctl reload 没成功 —— 守护进程很可能**拒绝了这次改动**"
            warn "  （比如改了必须重启才生效的键，它自己的日志里点了名）。"
            warn "  它仍然在用**旧配置**照常服务。想让改动生效："
            warn "      systemctl restart $SERVICE"
        fi
    elif systemctl start "$SERVICE"; then
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
    ${CONF}
    ${UNIT}
    ${SHARE_DIR}/nft-compare.py
    ${SHARE_DIR}/run.sbatch.template   ← 作业模板（安装器织作业脚本时读它）

  ★ **插件不在这张表里，也不归本脚本管**（v0.12 起）。装完基座之后装插件：

      sudo slurmate plugin install <包.splug>…       # 装一个或多个
      sudo slurmate plugin install --from <目录>     # 与那个目录整批对齐
      sudo slurmate plugin uninstall <id>…           # 卸（--all 卸全部）
      sudo slurmate plugin sync                      # 对齐配置与作业脚本

    一个插件都没有是**合法状态**：守护进程照常启动，已有会话照常能查、能停，
    只是没有可提交的服务。要看清本站现在有什么：
      ${DAEMON} --check | grep -A3 插件

  端口池与集群网段：跑一次 `${DAEMON} --check` 看（那是它自己的配置，
  本脚本不再抄一份 —— 抄一份就会漂开）。

  常用操作：
    systemctl status slurmate-sessiond
    journalctl -u slurmate-sessiond -f
    ${CLI} doctor                 # 普通用户跑，诊断 ACL 是否与服务一致
    ${DAEMON} --check             # 重新做一次配置自检

  卸载：
    sudo bash ${SCRIPT_PATH} --uninstall              # 保留状态与日志
    sudo bash ${SCRIPT_PATH} --uninstall --purge-state
    ★ 它会把插件一起卸掉（在删守护进程之前调卸载器）—— 一个插件在站点上留下
      哪几处痕迹，那条判据只有一份实现。

EOF

if [[ "$FAIL_N" -gt 0 ]]; then
    echo "  ⚠ 有 ${FAIL_N} 项失败，请务必按上面的提示排查。" >&2
    echo "     如需回滚：sudo bash ${SCRIPT_PATH} --uninstall" >&2
    exit 1
fi
exit 0
