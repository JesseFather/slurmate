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
#    sudo bash deploy.sh --plugins-src DIR   # 从 DIR 装插件（缺省 <repo>/plugins）
#                                            # 指向空目录 = 本站不装任何插件
#
#  关于 --require-baseline
#  ─────────────────────
#  本脚本最初是为「一台已经跑着别的端口管理方案的登录节点」写的，因此会检查
#  若干前置设施是否存在。**在别人的集群上这些设施通常不存在**，所以默认只
#  警告、继续部署。若你需要"前置条件不满足就绝不继续"的严格语义，加这个开关。
#
#  关于插件
#  ───────
#  作业里能跑什么由**插件**决定。★ 而插件是一个**成品包**，不是一棵源码树：
#
#      --plugins-src DIR/              ← 放下载来的 .splug 的地方
#        01M2JKHTZGKJBFQQTWYXMQMF2V.splug   作者用 packer/ 打出来的
#
#  ★ **本脚本永不打包**（仓库里没有 Node 的依赖，也不该有）。作者在他的机器上
#    `packer build`，把 `.splug` 发布到网站 / GitHub；管理员下载下来，放进
#    `--plugins-src` 指的目录，然后跑本脚本。**服务器上从头到尾没有源码树。**
#
#  本脚本这一步只做三件事，每件都有它自己的负责人：
#      · **信任门**：这些包在"root 下载完到安装器读"之间不能被普通用户换掉；
#      · **交给安装器**（`slurmate-sessiond --install-plugins`）：解析、验签、
#        同 id 检查、旧布局迁移 —— 规则只有那一份实现；
#      · **逐插件编织**作业脚本：把包里的 `job/start.sh` 织进作业模板。
#
#  ★ 缺省 `--plugins-src` 是仓库顶层的 `plugins/`。而那里放的是**源码树**
#    （它们是仓库的一部分，要能逐行评审），所以直接跑本脚本会在信任门那一步
#    停下来，并告诉你先 `packer build`。那个失败是刻意的：**包是构建产物，
#    不进 git**（二进制进 git 等于代码评审死掉），所以"装这个仓库自己的插件"
#    也要先打一次包。
#
#  一个包都没有是**合法状态**：传一个空目录给 --plugins-src 即可。
#  一个插件**包里的负载没有 job/start.sh** 也是合法的：它装得上、看得见，
#  但提交不了（守护进程在提交时报 service_kind_no_job），本脚本跳过它、
#  不给它生成作业脚本。
#
#  ★ **一个插件一份作业脚本**，装到：
#
#      <prefix>/share/slurmate/jobs/<ULID>.sbatch
#
#    文件名是插件清单里的 `id`（ULID）—— 它是插件的**身份**，全球唯一、铸造
#    出来就不变；短名只是本站的标签，可以改。目录列表里那一串 ULID 各自对应哪个
#    插件，看完成摘要那张表，或让 `slurmate-sessiond --check` 再打印一遍。
#
#    为什么一插件一份、不是所有插件织进同一份：同处一个文件时，插件里任何一行
#    **不在函数里**的代码都会待在主流程中间，在**每一个**作业里执行，不管用的是
#    哪个插件。拆开之后，一个插件的代码连"被另一个插件的作业解析到"的机会都没有。
#
#  ★ 编织（而不是运行时 source）是刻意的：装出来的每一份都是**单文件、零运行时
#    依赖**，计算节点不需要能看见那个目录。理由与失败形态见 cluster/run.sbatch 的
#    文件头。**拆成 N 份没有改变这一点** —— 仍然是部署期把内容写进文件。
#
# ==============================================================================

set -uo pipefail

# ─── 路径 ────────────────────────────────────────────────────────────────────
# deploy.sh 与它要安装的源文件同在 cluster/ 下。
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${SELF_DIR}"

# 插件**包**的来源目录：里面放的是一个或多个 `<ULID>.splug`（作者发布、
# 管理员下载）。**可参数化**：缺省是仓库顶层的 plugins/，而"从网站下载来的一批
# 包"可以用 --plugins-src 指过去。指向一个空目录 = 本站不装任何插件（合法状态）。
#
# ★ 语义变过一次：从前它是"插件的**源码**目录"。现在目录里只该有 `.splug`
#   —— 别的东西（子目录、随手放的文件）会在预检那一步被点名，见 scan_plugins()
#   与下面 plugin_src_files() 的说明。
PLUGINS_SRC=""
PLUGINS_SRC_GIVEN=0

# 面向用户的"脚本路径"。源码不可信时本脚本会自拷贝到 /root 下再重执行，那时
# $0 指向 /root/slurmate-src.XXXXXX/…—— 一个随机的临时目录。若把卸载指令写成
# $0，管理员记下的是一个下次部署就变、还可能被清理掉的路径。原路径才是他手里
# 真实存在的那个，所以由父进程显式传下来。
SELF_SCRIPT="${SELF_DIR}/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_PATH="${SLURMATE_ORIG_SCRIPT:-$SELF_SCRIPT}"

DAEMON="/usr/local/sbin/slurmate-sessiond"
CLI="/usr/local/bin/slurmate"
SHARE_DIR="/usr/local/share/slurmate"
# 作业脚本目录。守护进程按**自己的安装位置**推导出同一个路径
# （slurmate-sessiond 的 default_jobs_dir），两边由同一个前缀推导。
#
# ★ 里面是**一插件一份**的编织成品，文件名是插件的 ULID：`<ULID>.sbatch`。
#   本目录 100% 由本脚本生成，没有任何人写的东西 —— 所以陈旧文件的清理可以
#   直接按"不在这次的集合里"删掉，与 PLUGINS_DIR 不同（那里要更小心，因为
#   插件包是别人下载来的构件）。
#
# ★ 权限必须是 0755（见下面 chmod 那一处）：里面的脚本由**提交作业的用户**
#   身份的 sbatch 读取。0700 的表现是 sbatch 报"读不到文件"，指不回权限。
JOBS_DIR="${SHARE_DIR}/jobs"
# 插件安装目录。守护进程按**自己的安装位置**推导出同一个路径
# （slurmate-sessiond 的 default_plugins_dir），两边由同一个前缀推导，
# 就不存在「守护进程扫 A、作业脚本编织的是 B」这种只在提交时才炸的不一致。
#
# ★ 里面是**一插件一个包**：`<ULID>.splug`。文件名就是包的 `id` —— 所以两个
#   同 id 的包会落在同一个文件名上，而**互相覆盖是静默的**。§6.4 的那条检查因此
#   落在安装器里（它手里同时拿着这一次要装的全部包），不在本脚本里另写一份。
PLUGINS_DIR="${SHARE_DIR}/plugins"
# deploy.sh 记下自己装过哪几个包（每行一个 `<ULID>.splug`）。重复部署时，源里已经
# 拿走的插件要跟着删掉 —— 否则「把包移走再部署」这个最自然的卸载动作会**静默
# 无效**，而用户看到的是"它还在"。
#
# ★ 名字从 `.deployed` 换成了 `.installed`，因为**记的东西换了**：从前是"目录名"，
#   现在是"包文件名"。旧的那个文件由**安装器**读一次、用来迁移（见
#   slurmate-sessiond 的 PLUGIN_LEGACY_MARKER），本脚本不再写它。
PLUGINS_MARKER="${PLUGINS_DIR}/.installed"
# 同上，但记的是本脚本生成过哪几份作业脚本（每行一个 ULID）。插件的源目录没了、
# 插件被拿走了，对应那份 <ULID>.sbatch 要跟着删掉 —— 否则它会留下一份**无主的、
# 仍然可以被提交的**脚本，而没有任何东西能把它们对上号。
JOBS_MARKER="${JOBS_DIR}/.deployed"
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

want_plugins_src() {
    PLUGINS_SRC="$1"
    PLUGINS_SRC_GIVEN=1
}

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
        --plugins-src)
            [[ $# -gt 0 ]] || { echo "--plugins-src 后面要跟一个目录" >&2; exit 2; }
            want_plugins_src "$1"; shift ;;
        --plugins-src=*)     want_plugins_src "${arg#--plugins-src=}" ;;
        -h|--help)
            sed -n '2,/^# =====/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "未知参数: $arg（用 --help 查看用法）" >&2; exit 2 ;;
    esac
done

# 缺省是仓库顶层的 plugins/（与 cluster/ 并列）。它**不是** cluster/ 的子目录 ——
# 那正是"插件是独立项目"的形状。
if [[ "$PLUGINS_SRC_GIVEN" -eq 0 ]]; then
    PLUGINS_SRC="$(cd "${SRC_DIR}/.." 2>/dev/null && pwd || echo "${SRC_DIR}/..")/plugins"
fi
# 去掉结尾的斜杠，否则后面拼路径会出 //，而它进哈希基线之后两份对不上。
PLUGINS_SRC="${PLUGINS_SRC%/}"
if [[ -n "$PLUGINS_SRC" && ! -d "$PLUGINS_SRC" ]]; then
    echo "插件源目录不存在：${PLUGINS_SRC}" >&2
    echo "  用 --plugins-src DIR 指定（指向一个空目录 = 本站不装任何插件，合法）。" >&2
    exit 2
fi

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

    # 插件目录：**只删部署标记里记着的那几个包**，每个删之前先确认它确实是一个
    # 插件包（开头那 8 个字节是魔数）。按名字拼出来的路径，删之前先读一遍 ——
    # 这条规矩从前在客户端有个孪生兄弟（`plugins/install.js` 的 `uninstall`），
    # 那个文件随本机安装那条路在 v0.7 删掉了；规矩留下。
    #
    # ★ 两个标记都要看，因为**两次布局可能同时存在**（更早那版的旧目录还没被那次
    #   迁移清掉时就卸载了）：`.installed` 记的是包（本版），`.deployed` 记的是
    #   目录（更早的那种布局）。只看前者的话，旧目录会**留在盘上而没有东西记得
    #   它曾经是插件** —— 正是这一版要消灭的那种残留。
    if [[ -d "$PLUGINS_DIR" ]]; then
        if [[ -f "$PLUGINS_MARKER" ]]; then
            while IFS= read -r p; do
                [[ -n "$p" ]] || continue
                case "$p" in
                    */*|.|..) warn "跳过标记里那条形状不对的记录：${p}"; continue ;;
                esac
                if [[ -f "${PLUGINS_DIR}/${p}" ]] \
                   && head -c 8 "${PLUGINS_DIR}/${p}" 2>/dev/null | grep -q '^splug'; then
                    rm -f "${PLUGINS_DIR:?}/${p}" && ok "已删除插件包 ${p}"
                else
                    warn "跳过 ${PLUGINS_DIR}/${p} —— 它不像一个插件包，不敢删"
                fi
            done < "$PLUGINS_MARKER"
            rm -f "$PLUGINS_MARKER" && ok "已删除插件部署标记"
        fi
        if [[ -f "${PLUGINS_DIR}/.deployed" ]]; then
            info "还发现一个更早布局的标记（.deployed）—— 一并清掉"
            while IFS= read -r p; do
                [[ -n "$p" ]] || continue
                case "$p" in
                    */*|.|..) continue ;;
                esac
                if [[ -f "${PLUGINS_DIR}/${p}/plugin.json" ]]; then
                    rm -rf "${PLUGINS_DIR:?}/${p:?}" && ok "已删除旧布局的插件目录 ${p}"
                else
                    warn "跳过 ${PLUGINS_DIR}/${p} —— 它不像一个插件目录，不敢删"
                fi
            done < "${PLUGINS_DIR}/.deployed"
            rm -f "${PLUGINS_DIR}/.deployed" && ok "已删除旧布局标记"
        fi
        # 钥匙记录：它是**站点侧的记忆**（"这个 id 上一次是哪把钥匙签的"）。
        # 卸载 = 这个站点不再有插件，记忆跟着走；留下它反而会让下次装同一个包时
        # 撞上一句"签名者变了"——而那时没有任何东西能告诉管理员上一次是谁签的。
        rm -f "${PLUGINS_DIR}/.keys.json" && ok "已删除站点侧的钥匙记录"
        if [[ ! -f "$PLUGINS_MARKER" ]] \
           && [[ -n "$(ls -A "$PLUGINS_DIR" 2>/dev/null)" ]]; then
            warn "${PLUGINS_DIR} 里还有东西，但它们不在本脚本的部署标记里 —— 不是我们装的，一律不删"
            warn "      如确认要删请人工执行：rm -rf '${PLUGINS_DIR}'"
        fi
        rmdir "$PLUGINS_DIR" 2>/dev/null || true
    fi

    # 作业脚本目录：里面的每一份都是本脚本生成的，删除的判据因此比插件目录**更强**
    # —— 不再需要逐份读内容确认，只要它带着本脚本的部署标记，整个目录都是我们的。
    #
    # ★ 沿用 `grep -qi slurmate` 那道内容闸门作为**第二道**：ULID 文件名里没有
    #   "slurmate" 这个词，所以文件名本身提供不了任何归属证据；内容里有
    #   （模板头就是）。两道都过才删。
    if [[ -d "$JOBS_DIR" ]]; then
        if [[ -f "$JOBS_MARKER" ]]; then
            while IFS= read -r j; do
                [[ -n "$j" ]] || continue
                jf="${JOBS_DIR}/${j}"
                [[ -f "$jf" ]] || continue
                if grep -qi "slurmate" "$jf" 2>/dev/null; then
                    rm -f "$jf" && ok "已删除作业脚本 ${j}"
                else
                    warn "跳过 $jf —— 内容不含 \"slurmate\"，不像本系统装的，不敢删"
                fi
            done < "$JOBS_MARKER"
            rm -f "$JOBS_MARKER" && ok "已删除作业脚本部署标记"
        elif [[ -n "$(ls -A "$JOBS_DIR" 2>/dev/null)" ]]; then
            warn "${JOBS_DIR} 里有东西，但没有本脚本的部署标记 —— 不是我们装的，一律不删"
            warn "      如确认要删请人工执行：rm -rf '${JOBS_DIR}'"
        fi
        rmdir "$JOBS_DIR" 2>/dev/null || true
    fi

    # 删文件前逐项确认"这确实是本系统装的文件"。
    # 早期版本在这里无条件 rm -f，而脚本又反复提示用 --uninstall 做回滚 ——
    # 于是在一台从未部署过 Slurmate 的机器上执行它，会删掉同名的他人文件。
    # 注意：这是 root 的 rm，不设防的代价是别人的东西。
    # ★ 这里此前有一项 "$JOBSH"（那份单文件成品）。现在一个插件一份、按 ULID
    #   命名，名字在部署时才知道，所以它不在这张"写死的文件"清单里 ——
    #   上面的 JOBS_DIR 那一段负责它。**顺序也重要**：先清空 JOBS_DIR，
    #   下面这句 rmdir "$SHARE_DIR" 才可能真的成功（目录非空时它是静默失败的）。
    for f in "$DAEMON" "$CLI" "$CONF" "$UNIT" "${SHARE_DIR}/nft-compare.py"; do
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

# ── 插件包 ──
# ★ **每一个会被装进去的 `.splug`** 都进信任检查与哈希基线。
#
# ★ 判据换了形，而**理由也换了**，这一点必须写清楚（免得下一个人以为它还是
#   原来那条）：
#
#     从前  源目录里任何一个文件都能被普通用户改写 ⇒ 他改一行 `client/**.js`，
#           那行代码就在**每个用户的工作站上**以用户身份跑。
#     现在  包是一个**成品**：管理员下载下来、root 放好，安装器才去读它。
#           所以防的是**下载完到安装器读之间**那个窗口 —— 别人（或别的进程）
#           在那一段里把文件换掉，而 root 会照着换过的那一份去解析、验签、装。
#
#   两个形状挡的是**同一类事**：以 root 的身份安装一个别人能改的字节串。
#   判据（root 拥有 + 组/其他不可写）一个字没变。
#
# ★ 为什么这里只列 `*.splug`、不列目录里别的东西：**别的东西不该在这儿**，
#   而"报出来"这件事已经有一条实现（`scan_plugins` 会把目录与散落的文件逐条
#   点名），预检那一步跑的就是它。这里是**信任门**，不是清单校验器 —— 两件事
#   分开，才不会出现"两套解释器说不同的话"。
plugin_src_files() {
    local f
    [[ -n "$PLUGINS_SRC" && -d "$PLUGINS_SRC" ]] || return 0
    for f in "$PLUGINS_SRC"/*.splug; do
        # 通配符没匹配上时它原样留着，所以这一行不能省。
        # `-f` 而不是 `-e`：**符号链接不算**（`-f` 会跟随链接，所以还要显式排掉
        # 链接本身）—— 一个叫 `x.splug` 的链接能指向任何地方，而它随时可以换目标。
        [[ -f "$f" && ! -L "$f" ]] || continue
        printf '%s\n' "$f"
    done | LC_ALL=C sort
}

# 所有源文件的【绝对路径】。两处用它：信任检查、以及"拷贝前后哈希一致"。
ALL_SRC_FILES=()
# 插件包单独留一份：安装器要的正是这一批，见下面 2b.1。
PLUGIN_PKGS=()
while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    PLUGIN_PKGS+=("$f")
    ALL_SRC_FILES+=("$f")
done < <(plugin_src_files)
while IFS= read -r f; do
    [[ -n "$f" ]] && ALL_SRC_FILES+=("$f")
done < <(for f in "${SRC_FILES[@]}"; do printf '%s\n' "${SRC_DIR}/${f}"; done)

# ── 源文件可信性 ──
# 本脚本会以 root 身份【安装并执行】这些文件。若它们能被普通用户改写，
# 等于把 root 权限交出去 —— 那三套正在服务真实用户的生产系统也会一并失守。
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
    # 布局照搬一遍：cluster/ 与 plugins/ 各占一层，于是**缺省推导出来的插件源
    # 路径在拷贝里同样成立**（${SRC_DIR}/../plugins），不需要额外传参数。
    # ★ 插件源在 SELF_DIR 之内时不重复拷（那是同一次拷贝已经带上的东西）。
    mkdir -p "${SECURE_DIR}/cluster"
    cp -a "${SELF_DIR}/." "${SECURE_DIR}/cluster/" || die "拷贝源码失败"
    case "${PLUGINS_SRC}/" in
        "${SELF_DIR}/"*) : ;;
        *) cp -a "${PLUGINS_SRC}/." "${SECURE_DIR}/plugins/" 2>/dev/null \
               || mkdir -p "${SECURE_DIR}/plugins" ;;
    esac
    # 拷贝后重建路径列表（路径变了，而要比的是内容）
    SRC_DIR="${SECURE_DIR}/cluster"
    PLUGINS_SRC="${SECURE_DIR}/plugins"
    ALL_SRC_FILES=()
    PLUGIN_PKGS=()
    while IFS= read -r f; do
        [[ -n "$f" ]] || continue
        PLUGIN_PKGS+=("$f")
        ALL_SRC_FILES+=("$f")
    done < <(plugin_src_files)
    while IFS= read -r f; do
        [[ -n "$f" ]] && ALL_SRC_FILES+=("$f")
    done < <(for f in "${SRC_FILES[@]}"; do printf '%s\n' "${SRC_DIR}/${f}"; done)

    chown -R root:root "$SECURE_DIR" || die "无法把拷贝的源码改为 root 所有，拒绝继续"
    chmod -R go-w "$SECURE_DIR" || die "无法收紧拷贝源码的权限，拒绝继续"
    # 注意：源文件与 deploy.sh 同在 cluster/ 下（历史上 deploy.sh 曾在 sh/ 下，
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
    # ★ `--plugins-src` 放在 `$@` **之后**：同名参数取最后一个，所以拷贝里的那一份
    #   一定赢。调用方原本可能用 --plugins-src 指到别处，而那个位置未必可信 ——
    #   自拷贝的全部意义就是"执行的文件已经固定下来了"，参数不能把这一点推翻。
    SLURMATE_SRC_REEXEC=1 SLURMATE_ORIG_SCRIPT="${SELF_SCRIPT}" \
        exec bash "${SECURE_DIR}/cluster/$(basename "${BASH_SOURCE[0]}")" \
             "$@" --plugins-src "${SECURE_DIR}/plugins"
fi
info "源文件哈希（可记录备查）：$(for f in "${ALL_SRC_FILES[@]}"; do sha256sum "$f" 2>/dev/null | awk '{printf "%s ", substr($1,1,12)}'; done)"

# 源码里的那一份守护进程。**装插件、校验插件、从包里取文件走的都是它** ——
# 不是刚装到 ${DAEMON} 的那一份。
#
# ★ 为什么用源码里这一份：`${DAEMON}` 在"第一次部署"时还不存在，而在"升级部署"
#   时它是**上一个版本**。用旧版本去校验新格式的插件包，失败方式会是一句看不懂
#   的报错（或者更糟：它恰好收下了）。源码这一份永远与本次部署的规则同源。
#   放在这里而不是文件开头：上面那条自拷贝分支会把 SRC_DIR 改掉。
DAEMON_SRC="${SRC_DIR}/slurmate-sessiond"

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
# 作业脚本不在这张表里：它按 ULID 命名，名字要到扫完插件才知道；而 JOBS_DIR
# 那一层有自己的守卫（有东西、却没有 .deployed 标记 → 中止），见下面安装那一段。
for dst in "$DAEMON" "$CLI" "$CONF" "$UNIT"; do
    if [[ -e "$dst" ]]; then
        if ! grep -qi "slurmate" "$dst" 2>/dev/null; then
            die "目标文件已存在且不属于 Slurmate：
       ${dst}
     为避免覆盖他人文件，部署中止。请人工确认后自行删除或改名再重试。"
        fi
    fi
done
# 插件目录：里面**有东西**、却没有我们的部署标记，说明那不是我们建的。
# 后面的安装会往这个目录里写、也会删掉标记里记着的子目录，所以在动手之前拦住。
# （目录不存在、或存在但空着，都算正常 —— 首次部署就是那样。）
if [[ -d "$PLUGINS_DIR" && ! -f "$PLUGINS_MARKER" ]] \
   && [[ -n "$(ls -A "$PLUGINS_DIR" 2>/dev/null)" ]]; then
    die "插件目录 ${PLUGINS_DIR} 里已经有东西，但它不是本脚本装的
     （没有 ${PLUGINS_MARKER} 这个部署标记）。
     为避免删掉别人的文件，部署中止。请人工确认后自行清理再重试。"
fi
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

    # 插件：校验的是**还没装进去的包目录**（--check 不安装任何东西，
    # 所以不能去看安装目录 —— 那里面是上一次部署留下的东西）。
    # ★ 跑的还是守护进程自己的扫描器，只是在源目录上跑。它同时管两件事：每个包
    #   能不能解析，以及**目录里除 .splug 之外有没有别的东西**（那些东西不会被
    #   安装，所以不在这里说的话就是静默忽略）。
    if [[ "$DRYRUN" -eq 1 ]]; then
        info "[演练] 跳过插件体检"
    elif ! "$PY" "$DAEMON_SRC" --check-plugins \
             --plugins-dir "$PLUGINS_SRC" > "${BACKUP_DIR}/plugins-check.txt" 2>&1; then
        bad "插件包目录 ${PLUGINS_SRC} 里有不合法的东西："
        sed 's/^/        /' "${BACKUP_DIR}/plugins-check.txt" >&2
        bad "  真正部署会被中止。修好再跑。"
    else
        n_pl="$(sed -n '/^plugin-packages:$/,$p' "${BACKUP_DIR}/plugins-check.txt" \
                | tail -n +2 | grep -c . || true)"
        if (( n_pl == 0 )); then
            info "插件包目录 ${PLUGINS_SRC} 里没有 .splug —— 部署后会是一个"
            info "  **零插件**的基座（合法状态：会话能查、能停，只是没有可提交的服务）"
        else
            ok "插件包目录 ${PLUGINS_SRC} 里有 ${n_pl} 个合法的包"
            sed -n '/^插件目录 /,$p' "${BACKUP_DIR}/plugins-check.txt" | sed 's/^/        /'
        fi
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
         "$(dirname "$UNIT")" "$STATE_DIR" "$PLUGINS_DIR" "$JOBS_DIR"; do
    if [[ ! -d "$d" ]]; then
        run mkdir -p "$d"
        if [[ "$DRYRUN" -eq 1 ]]; then
            info "将创建目录 $d（演练，尚未创建）"
        else
            info "已创建目录 $d"
        fi
    fi
done
# ★ JOBS_DIR 必须 0755，与 SHARE_DIR / PLUGINS_DIR 同一个理由：里面的脚本由
#   **提交作业的用户**身份的 sbatch 读取（守护进程 fork + setuid 之后 exec 它）。
#   0770 或 0700 的表现是 sbatch 报「读不到文件」—— 而那句话指不回权限，
#   会让人去查脚本是不是生成失败了。
[[ "$DRYRUN" -eq 1 ]] || chmod 755 "$SHARE_DIR" "$CONF_DIR" "$PLUGINS_DIR" "$JOBS_DIR"
[[ "$DRYRUN" -eq 1 ]] || chmod 700 "$STATE_DIR"

install_one "${SRC_DIR}/slurmate-sessiond"  "$DAEMON"  755
install_one "${SRC_DIR}/slurmate"           "$CLI"     755
install_one "${SRC_DIR}/nft-compare.py"     "${SHARE_DIR}/nft-compare.py" 644
# ★ run.sbatch **不在这里装** —— 它是编织出来的成品（见下面那一段），
#   装的是「模板 + 各插件的 job/start.sh」拼起来的东西。

# ==============================================================================
step "阶段 2b／6  安装插件并编织作业脚本"
# ==============================================================================

# ── 2b.1 把插件包装进 <prefix>/share/slurmate/plugins/ ─────────────────────
#
# ★ 装的动作**全部交给安装器**（`slurmate-sessiond --install-plugins`）：解析包、
#   验签、§6.4 的同 id 检查、旧布局迁移、写站点侧的钥匙记录 —— 都在它里面，而
#   那些判据在守护进程那一侧本来就要有（它要读同一批包）。本脚本再抄一遍的失效
#   方式是"部署放行了、守护进程不认"，而症状要到用户点提交时才出现。
#
# ★ 本脚本自己只做**集合**这一件事：源里已经拿走的插件要真的从站点上删掉。
#   那是"这次部署想装哪几个"的知识，只有部署脚本有。
plugin_pkgs_now() {
    local f
    for f in "$PLUGINS_SRC"/*.splug; do
        [[ -f "$f" && ! -L "$f" ]] || continue
        printf '%s\n' "$(basename "$f")"
    done | sort
}

if [[ "$DRYRUN" -eq 1 ]]; then
    info "[演练] 将安装插件包：$(plugin_pkgs_now | tr '\n' ' ')"
else
    # ── 2b.1a 预检**源目录** ──
    # ★ 它管两件事，都不是"装完之后"能补上的：
    #     ① 每个包都能解析（下载坏了、传丢了、放错文件）；
    #     ② **目录里除 `.splug` 之外没有别的东西** —— 那些东西不会被安装
    #        （`plugin_src_files()` 只列包），所以不在这里说的话，它们会被
    #        **静默忽略**。源码树放错地方就是这一种：管理员以为装上去了。
    SRC_PLUGIN_LIST=""
    if [[ -n "$PLUGINS_SRC" && -d "$PLUGINS_SRC" ]]; then
        if ! "$PY" "$DAEMON_SRC" --check-plugins \
                 --plugins-dir "$PLUGINS_SRC" > "${BACKUP_DIR}/plugins-src.txt" 2>&1; then
            sed 's/^/        /' "${BACKUP_DIR}/plugins-src.txt" >&2
            die "插件包目录 ${PLUGINS_SRC} 里有不合法的东西（原因见上）。一个字节都没装。
     ★ 「源码树」放错地方是最常见的一种：站点只收 .splug，包要先在**作者机器上**
       用 packer/ 打出来（本脚本永不打包，见文件头）。"
        fi
        sed 's/^/        /' "${BACKUP_DIR}/plugins-src.txt"
        # 机器可读的那一段后面还要用（标记文件按它写：装进去的文件名就是 ULID）。
        SRC_PLUGIN_LIST="$(sed -n '/^plugin-packages:$/,$p' \
                           "${BACKUP_DIR}/plugins-src.txt" | tail -n +2)"
    fi

    # ── 2b.1b 先删掉**上次部署装过、这次源里没有了**的包 ──
    # 「把一个包从源里移走再部署」是最自然的卸载动作，它必须真的生效。
    # 只删标记文件里记着的文件名，且**删之前先确认它确实是一个插件包** —— 与
    # 客户端的 uninstall 同一条规矩：按名字拼出来的路径，删之前先读一遍，对不上
    # 就不动它。
    if [[ -f "$PLUGINS_MARKER" ]]; then
        while IFS= read -r old; do
            [[ -n "$old" ]] || continue
            # `-F`：标记里的那一行是一个**字面量**，不是模式 —— 少了它会拿
            # `01M2….splug` 里的那个 `.` 当通配符，于是一条"碰巧对得上"的记录
            # 会让这个包**不被删掉**（而那是静默的）。
            plugin_pkgs_now | grep -qxF "$old" && continue
            # 标记里的每一行都是我们自己写进去的 `<ULID>.splug`，但删之前仍然
            # 断言一次形状 —— 这个文件在两次部署之间躺在一个人人可读的目录里，
            # 而"按名字拼出来的路径删东西"是这个脚本里唯一一处 rm -f。
            case "$old" in
                */*|.|..|"") warn "跳过标记里那条形状不对的记录：${old}"; continue ;;
            esac
            if [[ -f "${PLUGINS_DIR}/${old}" ]] && \
               head -c 8 "${PLUGINS_DIR}/${old}" 2>/dev/null | grep -q '^splug'; then
                rm -f "${PLUGINS_DIR:?}/${old}" && info "已移除不再装着的插件包：${old}"
            else
                warn "跳过 ${PLUGINS_DIR}/${old} —— 它不像一个插件包，不敢删"
            fi
        done < "$PLUGINS_MARKER"
    fi

    mkdir -p "$PLUGINS_DIR"
    if (( ${#PLUGIN_PKGS[@]} > 0 )); then
        # ★ 参数取自 `PLUGIN_PKGS` —— 而它**就是**信任门过的那一批
        #   （`plugin_src_files()` 的输出，见上面）。两处用同一个来源，是因为
        #   "装了但没验"这种缺口只会从两个列表分家那里长出来。
        "$PY" "$DAEMON_SRC" --install-plugins "${PLUGIN_PKGS[@]}" \
            --plugins-dir "$PLUGINS_DIR" \
            || die "安装插件包失败（原因见上）。已有的包没有被改动。
     修好之后重跑本脚本即可。"
    else
        info "本次没有要装的插件包（${PLUGINS_SRC} 下没有 .splug）"
    fi

    # ★ 标记记的是**本脚本这一次装了什么**：每个源包的 ULID（第 3 列）+ 后缀。
    #   装进去的文件名就是它（安装器按 id 命名，§6.4 保证不会有两个包抢一个名字）。
    #
    #   ★ 为什么**不**记"插件目录里现在有哪些包"：那样一来，管理员用
    #     `slurmate plugin install` 单独装的那个包会出现在标记里，而下一次部署
    #     会把它当成"源里已经拿走的"**删掉**。手动装是显式动作，不该被一次
    #     集合同步悄悄撤销。
    #
    # ★ 标记文件只在这次真的写成了才覆盖。写失败时**保留旧的那一份** ——
    #   清空它等于"忘了自己装过什么"，那下一次部署就不会移除已经从源里拿走的
    #   插件，而这个失败是静默的（用户看到的是"它还在"）。
    : > "${PLUGINS_DIR}/.tmp-marker.$$"
    while IFS=$'\t' read -r _pn _pp _pid _pj; do
        [[ -n "${_pid:-}" ]] || continue
        # 与编织那一段同一条断言：ULID 是**路径分量**，形状不对就不往下拼。
        if [[ ! "$_pid" =~ ^[0-9A-HJKMNP-TV-Z]{26}$ ]]; then
            die "插件 ${_pn} 的 id 不是合法的 ULID：${_pid}
     标记文件按 <ULID>.splug 记，一个形状不对的 id 会拼出一个失控的路径。
     这多半意味着 --check-plugins 的输出被改过 —— 那里的格式是跨脚本契约。"
        fi
        printf '%s\n' "${_pid}.splug" >> "${PLUGINS_DIR}/.tmp-marker.$$"
    done <<< "$SRC_PLUGIN_LIST"
    if sort -u -o "${PLUGINS_DIR}/.tmp-marker.$$" "${PLUGINS_DIR}/.tmp-marker.$$" 2>/dev/null; then
        chmod 644 "${PLUGINS_DIR}/.tmp-marker.$$" 2>/dev/null || true
        if ! mv -f "${PLUGINS_DIR}/.tmp-marker.$$" "$PLUGINS_MARKER" 2>/dev/null; then
            warn "无法更新插件部署标记 ${PLUGINS_MARKER} —— 下次部署不会移除已拿走的插件"
            rm -f "${PLUGINS_DIR}/.tmp-marker.$$"
        fi
    else
        warn "无法整理插件部署标记 —— 保留上一次的那一份"
        rm -f "${PLUGINS_DIR}/.tmp-marker.$$"
    fi
    if [[ ! -s "$PLUGINS_MARKER" ]]; then
        # ★ 说的是**本脚本这次装了什么**，不是"站点上一个插件都没有" ——
        #   后者可能不成立（管理员可以用 `slurmate plugin install` 单独装过）。
        #   一句话把两件事混起来，排查的人会去查一个根本不存在的"没装"。
        info "本次部署没有装任何插件包（${PLUGINS_SRC} 下没有 .splug）—— 这是合法状态"
    fi
fi

# ── 2b.2 校验：跑守护进程**自己的**扫描器 ───────────────────────────────────
#
# ★ 不在部署脚本里另写一份清单规则。两套解释器的后果是"预检放行了、守护进程起不
#   来"（或者反过来），而这个仓库已经因为同一类分叉吃过一次亏（reserved_ranges）。
# ★ 它必须在**装完之后**跑：`--check-plugins` 按守护进程自己的安装位置推导插件
#   目录，所以它读的正是刚才装进去的那份。
PLUGIN_LIST=""
if [[ "$DRYRUN" -eq 1 ]]; then
    info "[演练] 跳过插件校验与编织（作业脚本不会被写出）"
else
    if ! "$DAEMON" --check-plugins > "${BACKUP_DIR}/plugins.txt" 2>&1; then
        sed 's/^/        /' "${BACKUP_DIR}/plugins.txt" >&2
        die "插件校验未通过（原因见上）。未安装作业脚本、未启动服务。
     修好再重跑本脚本即可。"
    fi
    sed 's/^/        /' "${BACKUP_DIR}/plugins.txt"
    ok "插件校验通过（用守护进程自己的扫描器，规则只有一份）"
    # 后面要逐个断言作业侧，所以留下 `<短名>\t<包路径>\t<ULID>\t<has_job|no_job>`。
    # ★ 四列各管一件事，混用就会得到一个假错误：短名算函数名、包路径取文件、
    #   ULID 命名作业脚本、第 4 列回答"要不要取作业侧那一份"。
    PLUGIN_LIST="$(sed -n '/^plugin-packages:$/,$p' "${BACKUP_DIR}/plugins.txt" \
                   | tail -n +2)"
fi

# 一条插件 job 脚本要过的三道断言。它们不是"防御性编程" —— 每一条对应的都是一个
# **静默**失效，而静默正是这个项目一路在清的那类东西。
check_plugin_jobsh() {
    local pname="$1" pf="$2" suffix fn offenders=""

    # ① 不许有 shebang、不许有 #SBATCH。
    #    它们在拼接点**之后**，而 Slurm 只扫脚本开头那一段连续的注释（模板里的
    #    `set -uo pipefail` 就终止了扫描）—— 带了不是报错，是"写了但静默不生效"。
    #    资源需求全部由守护进程在提交时经 sbatch 的 argv 定下（见 op_submit），
    #    插件从来不参与，所以这条不需要任何新机制。
    if grep -nE '^#!|^[[:space:]]*#SBATCH' "$pf" >/dev/null 2>&1; then
        grep -nE '^#!|^[[:space:]]*#SBATCH' "$pf" | sed 's/^/        /' >&2
        die "${pf} 里有 shebang 或 #SBATCH。
     它们会被拼在作业脚本的**中间**，而 Slurm 只解析脚本开头的注释块 ——
     所以带了不是报错，是「写了但静默不生效」。删掉它们。"
    fi

    suffix="${pname//-/_}"

    # ② 有作业侧就必须定义 start_<短名>。没有它，作业会在用户**排完队之后**才以 24
    #    失败，而那时他看到的是"这份作业脚本提供的是 Y，而请求的是 X"——一句话指不回
    #    这个文件。（**没有 job/start.sh 本身不在这里中止** —— 那是合法状态。）
    if ! grep -qE "^[[:space:]]*start_${suffix}[[:space:]]*\(\)" "$pf"; then
        die "${pf} 里没有定义 start_${suffix}（插件 ${pname} 的作业侧入口）。
      宿主的 plugin_call 就是按 <动词>_<短名> 分派的，名字对不上等于没有实现。"
    fi

    # ③ 其余函数必须带 _<短名>_ 前缀。
    #
    #  ★ 这条断言的**理由**在"一个插件一份脚本"之后变了，规则本身留着 ——
    #    下文同步重写过，别把它当成旧理由的残留。
    #    旧理由：「编织后所有插件共处一个文件，固定名会互相覆盖」—— 那是真的，
    #    但那个形状已经不在了。
    #    新理由：**不许遮蔽宿主自己的函数**（log / cleanup / write_session /
    #    pick_port_and_start …）。一份脚本里只有一个插件，所以插件**之间**不会
    #    再撞；但插件盖掉宿主的函数仍然是**静默**的 —— 症状是"清理没跑"
    #    「日志少了几行」这类指不回任何一个文件的现象。
    while IFS= read -r fn; do
        [[ -n "$fn" ]] || continue
        case "$fn" in
            start_${suffix}|precheck_${suffix}|cleanup_${suffix}) continue ;;
            _${suffix}_*) continue ;;
        esac
        offenders="${offenders} ${fn}"
    done < <(grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*\(\)' "$pf" \
             | sed -E 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*).*/\1/')
    if [[ -n "$offenders" ]]; then
        die "${pf} 里定义了没有命名空间的函数：${offenders}
     它会被拼进作业脚本，而宿主自己的函数（log / cleanup / write_session /
     pick_port_and_start …）都是**没有后缀**的动词 —— 一个同名的插件函数会
     把它们**静默**盖掉，症状是"清理没跑""日志少了几行"，指不回这个文件。
     规则：契约钩子用 <动词>_${suffix}，其余一律用 _${suffix}_ 前缀。"
    fi
    return 0
}

# ── 2b.3 编织：模板 + **一个**插件的 job/start.sh → 那个插件的一份成品 ──────
#
# ★ 一插件一份，文件名是插件的 ULID。两份收益，都不在"好看"这一层：
#     ① 插件里任何一行**不在函数里**的代码都只会出现在它自己那份脚本里 ——
#        不可能被另一个插件的作业解析到（同处一份文件时，那种行会在**每一个**
#        作业里执行，不管用的是哪个插件）；
#     ② 一个插件的语法错只影响它自己那一份的 bash -n，报错直接指向一份文件。
#
# ★ **两遍式**：先把 N 份全部生成并逐份验语法，**全过了才开始装**。
#   这保住了原来那句承诺「要么换成新的、要么一份都不动」。要诚实说明的是：
#   N 次 install 之间不是原子的（窗口是毫秒级，且每份各自完整）—— 而它换来的是
#   "半新半旧的那一批"里不会出现**语法错的**脚本，因为语法检查在安装之前。
if [[ "$DRYRUN" -eq 1 ]]; then
    info "[演练] 跳过编织（${JOBS_DIR} 下不会写出任何作业脚本）"
else
    # ★ 数的是**整行**的标记，不是子串：模板的文件头注释里也提到了这个标记（读
    #   代码的人需要知道它叫什么），而子串匹配会把那句注释也算成一处。
    N_MARK="$(grep -c '^# @@SLURMATE_PLUGIN_BLOCKS@@$' "${SRC_DIR}/run.sbatch" || true)"
    if [[ "$N_MARK" != "1" ]]; then
        die "作业模板 ${SRC_DIR}/run.sbatch 里的拼接标记有 ${N_MARK} 处，应当**恰好一处**。
     零处 = 插件无处分派；多于一处 = 只有第一处会被替换，其余静默留在文件里。
     标记是整行： # @@SLURMATE_PLUGIN_BLOCKS@@"
    fi

    mkdir -p "$JOBS_DIR"
    # JOBS_DIR 里全是本脚本生成的东西，但仍要走一遍与 PLUGINS_DIR 同样的守卫：
    # 目录里有东西、却没有本脚本的标记 → 那不可能是我们装的，中止而不是删。
    if [[ -z "$(ls -A "$JOBS_DIR" 2>/dev/null)" || -f "$JOBS_MARKER" ]]; then
        :
    else
        die "作业脚本目录 ${JOBS_DIR} 里已经有东西，但它不是本脚本装的
     （没有 ${JOBS_MARKER} 这个部署标记）。为避免删掉别人的文件，部署中止。
     确认里面确实没有你要保留的东西之后，人工执行：
       rm -rf '${JOBS_DIR}'"
    fi

    WEAVE_DIR="${BACKUP_DIR}/jobs"
    mkdir -p "$WEAVE_DIR"
    : > "${JOBS_DIR}/.tmp-marker.$$"
    JOBS_DONE=""

    # ── 第一遍：全部生成 + 逐份验语法，一份都不装 ──
    while IFS=$'\t' read -r pname pkg pid hasjob; do
        [[ -n "${pname:-}" && -n "${pkg:-}" && -n "${pid:-}" ]] || continue
        # ★ ULID 是**路径分量**，所以要先断言它的形状。PLUGIN_ID_RE 已经保证了
        #   （`^[0-9A-HJKMNP-TV-Z]{26}$`，没有点、没有斜杠），这里是第二道：
        #   deploy.sh 拿它拼 `<JOBS_DIR>/<ULID>.sbatch`，一个形状不对的值意味着
        #   上游出了别的问题，宁可不部署。
        if [[ ! "$pid" =~ ^[0-9A-HJKMNP-TV-Z]{26}$ ]]; then
            die "插件 ${pname} 的 id 不是合法的 ULID：${pid}
     作业脚本按 <ULID>.sbatch 命名，一个形状不对的 id 会拼出一个失控的路径。
     这多半意味着 --check-plugins 的输出被改过 —— 那里的格式是跨脚本契约。"
        fi
        # ★ 「有没有作业侧」现在是**明确的一列**，不是靠"取一次试试"推出来的：
        #   没有作业侧是**合法状态**（只有客户端那一半的插件允许存在），而
        #   "取不出来"还可能是包坏了 —— 用一个退出码同时表达这两件事，就会把
        #   后果不同的两种情况并成一条路。见守护进程里 TSV 那一段的说明。
        if [[ "${hasjob:-}" != "has_job" ]]; then
            warn "插件 ${pname} 的包里没有 job/start.sh —— 跳过，不生成作业脚本。
          这个插件装得上、看得见，但提交不了（合法状态）。要让它能提交：
          在**源码树**里补一份 job/start.sh、升版本号，重新 packer build 再装一次。"
            continue
        fi
        # 作业侧那一份从**包里**取出来（服务器上没有源码树可以读），取到一个临时
        # 文件里再走下面同样那三道断言。★ `--extract-package` 是集群侧读包的
        # 唯一入口，所以"包怎么读"仍然只有 Python 那一份实现。
        pf="${WEAVE_DIR}/${pid}.jobstart.sh"
        if ! "$PY" "$DAEMON_SRC" --extract-package "$pkg" job/start.sh \
                 > "$pf" 2>"${pf}.err"; then
            sed 's/^/        /' "${pf}.err" >&2
            die "从 ${pkg} 里取 job/start.sh 失败（原因见上）。
     该包的记录表里**有**这一份（--check-plugins 是这么报的），所以这多半意味着
     包在安装之后被换过 —— 重跑一次本脚本。"
        fi
        check_plugin_jobsh "$pname" "$pf"
        BLOCKS="${WEAVE_DIR}/${pid}.blocks.sh"
        {
            echo
            echo "# ─── 插件 ${pname}（id ${pid}）──────────────────────────────"
            cat "$pf"
            echo
        } > "$BLOCKS"
        WEAVE="${WEAVE_DIR}/${pid}.sbatch"
        awk -v blocks="$BLOCKS" '
            /^# @@SLURMATE_PLUGIN_BLOCKS@@$/ {
                while ((getline line < blocks) > 0) print line
                close(blocks); found = 1; next
            }
            { print }
            END { if (!found) exit 9 }
        ' "${SRC_DIR}/run.sbatch" > "$WEAVE" || die "编织失败（拼接标记没有被替换？）"
        if grep -q '^# @@SLURMATE_PLUGIN_BLOCKS@@$' "$WEAVE"; then
            die "编织 ${pname} 的作业脚本后仍有拼接标记行 —— 说明模板里有不止一处。"
        fi
        bash -n "$WEAVE" || die "插件 ${pname} 的作业脚本语法检查失败（多半是
     ${pf} 里有语法错误，见上面的行号）。已中止，${JOBS_DIR} 一份都没有改动。"
        JOBS_DONE="${JOBS_DONE} ${pid}"
        ok "插件 ${pname}：三道断言通过（无 shebang/#SBATCH、定义了 start_${pname//-/_}、函数名都有命名空间），编织成 $(wc -l < "$WEAVE") 行的作业脚本"
    done <<< "$PLUGIN_LIST"

    # ── 第二遍：全部验过了，才开始装 ──
    for pid in $JOBS_DONE; do
        install_one "${WEAVE_DIR}/${pid}.sbatch" "${JOBS_DIR}/${pid}.sbatch" 644
        printf '%s\n' "${pid}.sbatch" >> "${JOBS_DIR}/.tmp-marker.$$"
    done

    # ── 清掉不再属于任何插件的那些 ──
    # 「把一个插件包从源里拿走再部署」必须真的生效，否则会留下一份**无主的、
    # 仍然可以被提交的**脚本。判据是文件在不在这次的集合里，不是内容 ——
    # 这个目录 100% 是本脚本生成的。
    if [[ -f "$JOBS_MARKER" ]]; then
        while IFS= read -r old; do
            [[ -n "$old" ]] || continue
            # 这次生成了的 ULID 集合是空格分隔的（两头的空格让整词匹配成立）。
            case " ${JOBS_DONE} " in
                *" ${old%.sbatch} "*) continue ;;
            esac
            rm -f "${JOBS_DIR:?}/${old}" && info "已移除不再需要的作业脚本：${old}"
        done < "$JOBS_MARKER"
    fi

    # ★ 标记只在这次真的写成了才覆盖（与 PLUGINS_DIR 那一段同一条规矩）：
    #   写失败时保留旧的那一份，否则下次部署就不会移除已经拿走的插件脚本。
    if sort -o "${JOBS_DIR}/.tmp-marker.$$" "${JOBS_DIR}/.tmp-marker.$$" 2>/dev/null; then
        chmod 644 "${JOBS_DIR}/.tmp-marker.$$" 2>/dev/null || true
        if ! mv -f "${JOBS_DIR}/.tmp-marker.$$" "$JOBS_MARKER" 2>/dev/null; then
            warn "无法更新作业脚本部署标记 ${JOBS_MARKER} —— 下次部署不会移除已拿走的插件脚本"
            rm -f "${JOBS_DIR}/.tmp-marker.$$"
        fi
    else
        warn "无法整理作业脚本部署标记 —— 保留上一次的那一份"
        rm -f "${JOBS_DIR}/.tmp-marker.$$"
    fi

    if [[ -z "$JOBS_DONE" ]]; then
        info "本站没有任何插件的作业脚本 —— 合法状态：守护进程照常启动、会话照常能停，"
        info "  只是没有可提交的服务。装插件：见 plugins/README.md。"
    fi
fi

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
    # 对**已经装好的**每一份作业脚本再验一次语法（编织那一段验的是临时副本）。
    # 一个都没装时不循环 —— 零插件是合法状态，不是"少了点什么"。
    for _jf in "$JOBS_DIR"/*.sbatch; do
        [[ -f "$_jf" ]] || continue
        bash -n "$_jf" || die "已安装的作业脚本语法检查失败：${_jf}，已中止"
    done
    comparator_selftest "${SHARE_DIR}/nft-compare.py" \
        || die "已安装的比对器自测未通过（项数下限 ${COMPARATOR_MIN_TESTS}），已中止"
    ok "语法自检通过（守护进程 / CLI / 作业脚本 / 比对器）"
    _jf_n="$(ls -1 "$JOBS_DIR"/*.sbatch 2>/dev/null | grep -c . || true)"
    info "作业脚本文法自检覆盖 ${_jf_n} 份（${JOBS_DIR}）"
fi

# ==============================================================================
step "阶段 3／6  配置自检（不启动服务）"
# ==============================================================================

if [[ "$DRYRUN" -eq 1 ]]; then
    info "[演练] 跳过"
else
    # 这一条跑的是守护进程【自己的】自检，不是在脚本里另写一份规则 ——
    # 两套解释器的后果是"预检放行了一份配置，守护进程却起不来"（或者反过来），
    # 而这个仓库已经因为同一类分叉吃过一次亏（reserved_ranges 的解析）。
    # 上面那条 log.error 会逐条列出原因，最常见的是 cluster_cidr 还没填。
    if "$DAEMON" --check --config="$CONF"; then
        ok "配置自检通过"
    else
        die "配置自检失败（原因见上面的『配置错误: …』）。未启动服务，未创建任何 nft 规则。
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
    ${CONF}
    ${UNIT}
    ${SHARE_DIR}/nft-compare.py
    ${JOBS_DIR}/    ← **有作业侧**的插件每份一个作业脚本，文件名是它的 ULID（见下表）

  插件（源 ${PLUGINS_SRC}）：
$(if [[ "$DRYRUN" -eq 1 ]]; then echo "    （演练：上面那个源目录里的插件将被装到 ${PLUGINS_DIR}）"; \
  elif [[ -n "$PLUGIN_LIST" ]]; then \
      while IFS=$'\t' read -r _n _p _i _j; do \
          [[ -n "$_n" ]] || continue; \
          if [[ "${_j}" == "has_job" ]]; then echo "    ${_n}  → ${_p}"; \
          else echo "    ${_n}  → ${_p}   【包里没有 job/start.sh：装得上、看得见，但提交不了】"; fi; \
          if [[ "${_j}" == "has_job" ]]; then echo "        ${JOBS_DIR}/${_i}.sbatch"; \
          else echo "        （没有作业脚本 —— 就是上面说的那个「提交不了」）"; fi; \
      done <<< "$PLUGIN_LIST"; \
  else echo "    （本站没有安装任何插件 —— 合法状态。装：把 .splug 包放进插件源目录再跑一次本脚本）"; fi)

  ★ 上面每一行「短名 → 包 → <ULID>.sbatch」就是 jobs/ 那一串 ULID 的**对照表**。
    没有作业侧的插件**没有**那第三段 —— 它的包里没有 job/start.sh，所以本脚本
    不给它生成作业脚本（那一行于是只说它"提交不了"，不说它有一份脚本）。
    它是**算出来的**、不是另存一份账 —— 任何时候要再打印一遍：
      ${DAEMON} --check | grep -A2 作业脚本

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
