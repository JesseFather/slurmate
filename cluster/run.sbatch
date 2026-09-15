#!/bin/bash
# ==============================================================================
#  run.sbatch — Slurmate 会话作业模板
# ==============================================================================
#
#  由 slurmate-sessiond（root）以目标用户身份提交。
#  本文件必须 root 拥有、0644、用户不可写 —— 这是防注入的关键：
#  用户可控的只有 sbatch 的命令行 flag，脚本内容本身固定。
#
#  ★ **本文件里没有任何一个插件的名字。** 作业里跑什么由**插件**决定，插件的
#    作业侧代码由 deploy.sh 从 `<prefix>/share/slurmate/plugins/*/job/start.sh`
#    编织进下面那个 `# @@SLURMATE_PLUGIN_BLOCKS@@` 标记处。契约见 plugins/README.md。
#
#    为什么是**部署时**编织、不是运行时 source：sbatch 拿到的是**路径**，但计算
#    节点上的 slurmd 从自己的 spool 取脚本执行 —— 本系统从来没有让计算节点打开过
#    <prefix>/share/slurmate/ 里任何一个文件。改成运行时 source 会引入本项目
#    有史以来第一个「共享目录对计算节点可见」的前置条件，而那个事实**在登录节点
#    上永远验证不出来**（文件在那儿必然存在）。编织让不确定性归零，并且把失败点
#    前移到部署期：一个语法错的插件脚本让 `deploy.sh` 当场中止，而不是变成用户的
#    一个失败会话。
#
#  契约：
#    - 只读 SLURMATE_* 环境变量，不接受 argv
#    - 不写 /var/lib/slurmate-session（那是守护进程的）
#    - 退出前必须在 KillWait 内写完墓碑（Slurm 默认 30 秒，见你集群的
#      KillWait 配置；trap 里的工作必须能在这个窗口内做完）
#
#  退出码（本文件添补的几位）：20 无法确定节点 IPv4 / 22 候选端口全部失败 /
#    23 配置要口令却生成不出来 / 24 服务种类本站没有作业侧实现、或插件的预检
#    没过、或认证方式宿主不认识
#
#  产出（家目录，NFS 共享）：
#    ~/.slurmate/sessions/job-<id>.json    会话身份、隧道目标、口令
#    ~/.slurmate/sessions/job-<id>.jobhb   作业侧心跳（证明作业还活着）
#    ~/.slurmate/logs/job-<id>.log         作业日志
#
#  安全：
#    口令由【作业自己生成】并写进 0600 的会话文件里，守护进程全程不写用户家目录
#    （它在 systemd 下以只读方式挂载 /shared/home）。这样 NFS 上的写入方只有用户本人，
#    root 守护进程没有"写用户文件"这条攻击面，也避免了 root 被符号链接诱骗。
# ==============================================================================
#SBATCH --job-name=slurmate
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --no-requeue
#SBATCH --export=ALL

set -uo pipefail
umask 077

# ─── 0. 参数 ────────────────────────────────────────────────────────────────
: "${SLURMATE_SESSION_ID:?缺少 SLURMATE_SESSION_ID}"
: "${SLURMATE_CANDIDATES:?缺少 SLURMATE_CANDIDATES}"
# 这个作业提供哪种服务。**由守护进程在提交时定**，取值必须是本站装了作业侧实现的
# 插件短名之一。这里没有缺省值 —— 一个缺省值就是"某个插件比较特殊"的另一种写法。
: "${SLURMATE_SERVICE_KIND:?缺少 SLURMATE_SERVICE_KIND}"
# 认证方式。由守护进程按【当前插件】的配置定：password（宿主生成口令）/
# publickey（客户端随提交带上来一把公钥）/ none。同样没有缺省值 —— 少一个变量
# 就静默降级成 none，那是**fail-open**，而这个会话唯一的实质保护就是认证。
: "${SLURMATE_AUTH_MODE:?缺少 SLURMATE_AUTH_MODE}"

# 分区可能为空串：守护进程在"分区权限查不到"时缺省提交会退化成不带 -p，
# 由 Slurm 的默认分区兜底。空就是"提交那一刻不知道"，不是"没有分区" ——
# 作业跑起来之后守护进程会从 scontrol 查到实际的，不需要这里猜。
SLURMATE_PARTITION="${SLURMATE_PARTITION:-}"
SLURMATE_CPUS="${SLURMATE_CPUS:-0}"
SLURMATE_MEM="${SLURMATE_MEM:-}"
SLURMATE_GPUS="${SLURMATE_GPUS:-0}"
SLURMATE_PASSWORD_BYTES="${SLURMATE_PASSWORD_BYTES:-12}"
# 兜底值只是"这个变量不该为空"的防御，不是默认网段 —— 真正的值由守护进程
# 从配置里传下来，而配置里留空时守护进程根本不会启动。
SLURMATE_CLUSTER_CIDR="${SLURMATE_CLUSTER_CIDR:-192.0.2.0/24}"
SLURMATE_SESS_DIR="${SLURMATE_SESS_DIR:-$HOME/.slurmate/sessions}"
SLURMATE_LOG_DIR="${SLURMATE_LOG_DIR:-$HOME/.slurmate/logs}"
SLURMATE_PORT_MIN="${SLURMATE_PORT_MIN:-55001}"
SLURMATE_PORT_MAX="${SLURMATE_PORT_MAX:-55999}"
# 客户端的公钥（一行 OpenSSH 格式）。**宿主不认识它的含义** —— 需要公钥的插件在
# 自己的清单里声明 `contributes.submitPubkey`，作业侧由那个插件自己读这个变量。
# 不需要公钥的插件下它是空串。
#
# ★ 公钥不是秘密，走环境变量没有后果（与"口令绝不走环境变量"是两回事 —— 那条的
#   理由是 `scontrol show job` 会显示 Environment）。这个区别要留在注释里，
#   否则下一个人会把它当成同类问题"修掉"。
SLURMATE_SSH_PUBKEY="${SLURMATE_SSH_PUBKEY:-}"

JOB_ID="${SLURM_JOB_ID:?不在 Slurm 作业环境中}"
NODE="${SLURMD_NODENAME:-$(hostname -s)}"
MY_UID="$(id -u)"
MY_USER="$(id -un)"
SESS_FILE="${SLURMATE_SESS_DIR}/job-${JOB_ID}.json"
JOBHB_FILE="${SLURMATE_SESS_DIR}/job-${JOB_ID}.jobhb"
# 计算节点本地日志。用 mktemp -d 建【私有】目录而不是可预测的 /tmp/slurmate-<jobid>.log：
# 作业号能从 squeue 公开看到，同一节点上的其他租户可以在作业启动前抢先创建
# 那个路径（做成符号链接或 FIFO），让受害进程往攻击者指定的地方追加、或直接挂死。
LOCAL_LOG_DIR="$(mktemp -d /tmp/slurmate-XXXXXX 2>/dev/null || true)"
if [[ -n "$LOCAL_LOG_DIR" ]]; then
    chmod 700 "$LOCAL_LOG_DIR" 2>/dev/null || true
    LOCAL_LOG="${LOCAL_LOG_DIR}/job.log"
else
    LOCAL_LOG="/dev/null"
fi
NFS_LOG=""
STARTED_AT="$(date +%s)"

# 服务的 pid。名字是通用的（`SVC_` 而不是某个插件的前缀），因为心跳的存活门、
# cleanup 的杀进程、以及最后的 `wait` 这三处**都是插件无关的** —— 它们只需要一个
# 「服务进程」，不需要知道那是谁。每个插件的 start_* 有义务在成功时写它。
SVC_PID=""
JOBHB_PID=""
SVC_PORT=""
NODE_IP=""
AUTH_MODE="none"
AUTH_PASSWORD=""

# 插件往会话文件里加的字段（键 → 值）。**值由宿主统一转义** —— 让每个插件自己拼
# JSON 片段就等于把转义责任推给每一个插件，而转义写错的下场是整份会话文件解析
# 不了（会话永远登记不上，而根因在一个字都没提转义的地方）。
#
# ★ 键名是**跨语言契约**：守护进程按 SESSION_FILE_FIELDS 白名单读它，客户端按
#   键名取用。作业侧加一个新键而守护进程忘了登记，症状是那个字段**凭空消失**、
#   谁都不报错 —— test-sessiond-logic.py 第 20 节钉着这条。
declare -A PLUGIN_SESSION_FIELDS=()

TOMBSTONE_WRITTEN=0

# ─── 1. 日志 ────────────────────────────────────────────────────────────────
if mkdir -p "$SLURMATE_SESS_DIR" "$SLURMATE_LOG_DIR" 2>/dev/null \
   && { : > "${SLURMATE_LOG_DIR}/.wtest.$$"; } 2>/dev/null; then
    rm -f "${SLURMATE_LOG_DIR}/.wtest.$$" 2>/dev/null
    NFS_LOG="${SLURMATE_LOG_DIR}/job-${JOB_ID}.log"
fi

# 补写窗口的水位。它记的是 **LOCAL_LOG 的行数**，不是"我们写过几行"。
#
# ★ 这个区别是必须的：服务进程的输出是**直接重定向**到 LOCAL_LOG 的
#   （`nohup <服务> >> "$LOCAL_LOG" 2>&1`，插件的 start_* 里都这么写），
#   它插在我们两行日志中间。若水位记的是"log() 调过几次"，补写窗口就会错位 ——
#   症状是 NFS 日志的**末尾若干行重复一遍**，其中包括已经写过的那行"清理完成"，
#   看上去像清理跑了两次。变异验证就是靠这个发现的。
NFS_SYNCED_LOCAL=0
log() {
    local line
    line="$(date -Is) [slurmate/${JOB_ID}] $*"
    printf '%s\n' "$line" >> "$LOCAL_LOG" 2>/dev/null || true
    if [[ -n "$NFS_LOG" ]] && printf '%s\n' "$line" >> "$NFS_LOG" 2>/dev/null; then
        NFS_SYNCED_LOCAL="$(wc -l < "$LOCAL_LOG" 2>/dev/null || echo 0)"
    fi
    return 0
}

is_ipv4() { [[ "${1:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }

# ─── 2. 原子写（NFSv4 的 RENAME 是服务端原子的）─────────────────────────────
write_atomic() {
    local dst="$1" content="$2" tmp
    tmp="$(dirname "$dst")/.tmp.$$.$RANDOM"
    printf '%s' "$content" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
    mv -f "$tmp" "$dst" 2>/dev/null || { rm -f "$tmp"; return 1; }
    return 0
}

json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g'
}

# 写会话文件。$1=state  $2=exit_code（数字或 null）
# 口令写在这里（文件是 0600、属主本人），同节点其他用户读不到；
# 客户端通过守护进程的 status 或直接读本文件取得它。
write_session() {
    local state="$1" ec="$2"
    local extra="" k
    # 插件加的字段。用 `${#arr[@]}` 而不是直接展开 —— 空数组在 `set -u` 下的展开
    # 在 bash 4.3 及更早是错误，而计算节点的 bash 版本不由我们决定。
    if (( ${#PLUGIN_SESSION_FIELDS[@]} > 0 )); then
        for k in "${!PLUGIN_SESSION_FIELDS[@]}"; do
            extra="${extra},\"$(json_escape "$k")\":\"$(json_escape "${PLUGIN_SESSION_FIELDS[$k]}")\""
        done
    fi
    local body
    body="$(printf '{"schema":1,"session_id":"%s","job_id":%s,"uid":%s,"user":"%s","partition":"%s","node":"%s","node_ip":"%s","service_port":%s,"tunnel_target":"%s:%s","state":"%s","job_started_at":%s,"written_at":%s,"job_hb_at":%s,"service_kind":"%s","service_pid":%s,"auth_mode":"%s","auth_password":"%s","slurm_restart_number":%s,"exit_code":%s%s}\n' \
        "$(json_escape "$SLURMATE_SESSION_ID")" "$JOB_ID" "$MY_UID" "$(json_escape "$MY_USER")" \
        "$(json_escape "$SLURMATE_PARTITION")" "$(json_escape "$NODE")" "$NODE_IP" \
        "${SVC_PORT:-0}" "$NODE_IP" "${SVC_PORT:-0}" "$state" "$STARTED_AT" \
        "$(date +%s)" "$(date +%s)" \
        "$(json_escape "$SLURMATE_SERVICE_KIND")" "${SVC_PID:-0}" \
        "$AUTH_MODE" "$(json_escape "$AUTH_PASSWORD")" \
        "${SLURM_RESTART_NUMBER:-0}" "$ec" "$extra")"
    write_atomic "$SESS_FILE" "$body"
}

write_jobhb() {
    [[ -n "$SVC_PID" ]] || return 0
    kill -0 "$SVC_PID" 2>/dev/null || return 0
    write_atomic "$JOBHB_FILE" \
        "$(printf '{"job_id":%s,"at":%s,"service_pid":%s}\n' "$JOB_ID" "$(date +%s)" "$SVC_PID")"
}

# ─── 3. 节点 IPv4 ───────────────────────────────────────────────────────────
# 必须是【字面 IPv4】，且要与登录节点解析到的一致 —— 否则 nft 的 ip daddr
# 不匹配，ACL 静默失效（策略是 accept，没有任何人会发现问题）。
#
# 以 Slurm 的 NodeAddr 为权威，【不要】用 DNS / getent：Debian/Ubuntu 系
# 默认的 /etc/hosts 有一条 `127.0.1.1 <本机主机名>`，于是计算节点上
# `getent hosts <自己的节点名>` 会返回回环地址而不是真实的集群地址。
detect_node_ip() {
    local ip=""
    if command -v scontrol >/dev/null 2>&1; then
        ip="$(scontrol show node "$NODE" 2>/dev/null \
              | sed -n 's/.*NodeAddr=\([^ ]*\).*/\1/p' | head -n1)"
    fi
    if ! is_ipv4 "$ip"; then
        # 兜底：本机接口里挑属于集群网段的 IPv4
        ip="$(ip -4 -o addr show scope global 2>/dev/null \
              | awk '{print $4}' | cut -d/ -f1 \
              | grep -E "^${SLURMATE_CLUSTER_CIDR%.*}\." | head -n1)"
    fi
    is_ipv4 "$ip" || return 1
    printf '%s' "$ip"
}

# ─── 4. 端口探测 ────────────────────────────────────────────────────────────
port_free() {
    local p="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -Htln "sport = :$p" 2>/dev/null | grep -q . && return 1
    fi
    # 真正 bind 一次确认（能挡掉 ss 看不到的情况）
    if [[ -x /usr/bin/python3 ]]; then
        /usr/bin/python3 -c '
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind(("0.0.0.0", int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
' "$p" 2>/dev/null || return 1
    fi
    return 0
}

# ─── 4b. 插件分派（作业侧）──────────────────────────────────────────────────
#
# ★ 下面这个标记之后是 **deploy.sh 生成的**：它把每个插件的 job/start.sh 拼在
#   那里。计算节点因此只读这一个文件。
#
# 契约（plugins/README.md 是权威版本）：
#   · 插件**必须**定义 start_<短名>（短名里的 `-` 写成 `_`）
#   · 可选 precheck_<短名> / cleanup_<短名>，宿主探测到才调
#   · 其余函数一律用 _<短名>_ 前缀 —— 编织后所有插件共处一个文件，固定名会
#     互相覆盖，而覆盖是**静默**的
#   · 插件往会话文件加的字段写进 PLUGIN_SESSION_FIELDS（宿主负责转义）
#
# 宿主自己的函数都是**没有后缀**的动词（log / cleanup / write_session /
# pick_port_and_start …），与插件那套后缀命名不会撞。
#
# 未定义 → 返回 3。「没有这个钩子」与「钩子失败了」必须分开：合并的话，一个
# 没有预检的插件会被当成预检失败而被拒。
plugin_call() {
    local fn="${1}_${SLURMATE_SERVICE_KIND//-/_}"; shift
    declare -F "$fn" >/dev/null 2>&1 || return 3
    "$fn" "$@"
}

# ★ 宿主自己的这个函数**必须不以 `start_` 开头**：`plugin_names` 是靠
#   `compgen -A function start_` 反推插件名单的，而这个函数叫 `start_service`
#   时会混进去，让错误信息里多出一个叫 "service" 的假插件；更糟的是它会让
#   "本站没有作业侧实现了 X" 那道检查在一个 `service_kind=service` 时**误判通过**。
host_start_service() { plugin_call start "$1"; }

# 作业侧有实现的插件名单。从编织进来的函数名反推 —— 它们只可能由 deploy.sh 生成，
# 所以这就是真相，不需要再传一份下来。只用于把错误说清楚。
plugin_names() {
    local f out=""
    for f in $(compgen -A function start_); do
        out="$out ${f#start_}"
    done
    printf '%s' "${out# }"
}

# @@SLURMATE_PLUGIN_BLOCKS@@

pick_port_and_start() {
    local p n_total=0 n_range=0 n_busy=0 n_fail=0
    # 两种分隔符都收：
    #   `;` —— 守护进程现在用的（因为它可以完好穿过 sbatch 的 --export）
    #   `,` —— 滚动升级期间由**旧守护进程**提交的作业。那些作业的候选表本来就已经
    #          被 Slurm 按逗号截断成一个值了（实测），但至少别让它再炸一次。
    IFS=',;' read -ra _cands <<< "$SLURMATE_CANDIDATES"
    for p in "${_cands[@]}"; do
        n_total=$((n_total + 1))
        [[ "$p" =~ ^[0-9]+$ ]] || { log "候选 '$p' 不是数字，跳过"; n_range=$((n_range + 1)); continue; }
        if (( p < SLURMATE_PORT_MIN || p > SLURMATE_PORT_MAX )); then
            log "候选 $p 不在允许区间 ${SLURMATE_PORT_MIN}-${SLURMATE_PORT_MAX}，跳过"
            n_range=$((n_range + 1)); continue
        fi
        if ! port_free "$p"; then
            log "端口 $p 已被同节点其他作业占用，试下一个"
            n_busy=$((n_busy + 1)); continue
        fi
        if host_start_service "$p"; then
            SVC_PORT="$p"
            return 0
        fi
        n_fail=$((n_fail + 1))
    done
    # 明确区分失败原因，否则只看到一句"全部失败"会很难排查
    log "候选端口全部失败: 共 ${n_total} 个（区间外 ${n_range} / 被占用 ${n_busy} / 启动失败 ${n_fail}）"
    return 1
}

# ─── 5. 清理 ────────────────────────────────────────────────────────────────
# 必须在 KillWait 内完成（Slurm 默认 30 秒）。只做一件要紧事：写墓碑，
# 让守护进程立刻知道会话结束。日志搬运放后台，绝不阻塞退出 ——
# 超时的后果是 SIGKILL，墓碑写不下去，会话要多等一个 orphan 周期才回收。
cleanup() {
    local rc="${1:-$?}"
    trap - EXIT TERM INT HUP USR1

    if [[ -n "$JOBHB_PID" ]]; then
        kill "$JOBHB_PID" 2>/dev/null || true
    fi
    if [[ -n "$SVC_PID" ]] && kill -0 "$SVC_PID" 2>/dev/null; then
        kill -TERM "$SVC_PID" 2>/dev/null || true
        sleep 2
        kill -0 "$SVC_PID" 2>/dev/null && kill -KILL "$SVC_PID" 2>/dev/null || true
    fi

    # 墓碑：守护进程据此立刻释放。只在确实登记过之后才写。
    if [[ -n "$SVC_PORT" && "$TOMBSTONE_WRITTEN" -eq 0 ]]; then
        TOMBSTONE_WRITTEN=1
        write_session "exited" "$rc" || true
    fi

    # 删除口令：清掉子进程环境里的 PASSWORD（会话文件里的那份由客户端会话结束时
    # 随文件一起失效；作业进程本身即将退出）
    unset PASSWORD

    log "清理完成 rc=$rc"

    # 插件自己的收尾（例如把某个服务自己的日志并进作业日志）。
    # ★ 位置很要紧：必须在下面那段"NFS 补写"【之前】，插件日志才会被一起带上去。
    #   不并的话，"认证被拒"这类只有那个服务知道的事实在作业结束后就永远消失了 ——
    #   客户端只看到一句"认证失败"，而原因躺在计算节点上一个已经删掉的临时目录里。
    # ★ `|| true`：插件钩子出错不该拦住墓碑之后的任何事。而墓碑在上面已经写完了。
    plugin_call cleanup || true

    # 把这个作业的日志补齐到 NFS。两件事共用这一段：
    #
    #  ① **NFS 中途不可用**时，log() 那些行没落上去 —— 水位落在后面，这里补齐。
    #  ② **插件在 cleanup_<短名> 里并进来的、它自己那份服务日志** —— 它们是在
    #     上面那次 `plugin_call cleanup` 里追加到 LOCAL_LOG 的，也就是**在我们
    #     最后一行的后面**，所以天然落在水位之后、会被这一段带上去。
    #     （**不写具体是哪个插件的日志**：宿主不认识任何插件，注释里也不行 ——
    #      下一个读的人会以为宿主认得它。规则见 plugins/README.md。）
    #
    # ★ 位置很要紧：`plugin_call cleanup` 必须在 `log "清理完成"` **之后**。
    #   它若在前面，插件追加的行会落在水位**之前**，于是**静默地进不了 NFS** ——
    #   而"认证被拒"这类事实只有服务自己知道。
    #
    # ★ 水位是 **LOCAL_LOG 的行号**而不是"我们写过几行"（见 log() 上方那段）：
    #   后者在服务进程插话时会错位，症状是 NFS 日志末尾重复若干行。
    if [[ -n "$NFS_LOG" && -f "$LOCAL_LOG" ]]; then
        local total
        total="$(wc -l < "$LOCAL_LOG" 2>/dev/null || echo 0)"
        if (( total > NFS_SYNCED_LOCAL )); then
            tail -n +"$((NFS_SYNCED_LOCAL + 1))" "$LOCAL_LOG" >> "$NFS_LOG" 2>/dev/null || true
        fi
    fi

    # 删掉私有的本地日志目录（必须在上面补写 NFS 之后，否则会丢掉最后几行）
    [[ -n "$LOCAL_LOG_DIR" && -d "$LOCAL_LOG_DIR" ]] && rm -rf "$LOCAL_LOG_DIR" 2>/dev/null
    exit "$rc"
}

trap 'cleanup $?' EXIT
trap 'log "收到 SIGTERM（可能是 scancel）"; exit 143' TERM
trap 'log "收到 SIGINT"; exit 130' INT
trap 'log "收到 SIGHUP"; exit 129' HUP
# 守护进程在续期失败/即将到期时用 SIGUSR1 通知作业（作业自身无法延长 TimeLimit，
# 只有 root 可以，所以这只是个提示信号，用来让日志和会话文件反映状态）
trap 'log "收到 SIGUSR1：作业即将到期"; [[ -n "$SVC_PORT" ]] && write_session "near_expiry" 0' USR1

# ─── 6. 主流程 ──────────────────────────────────────────────────────────────
log "启动 session=$SLURMATE_SESSION_ID job=$JOB_ID node=$NODE" \
    "partition=${SLURMATE_PARTITION:-（Slurm 默认）} cpus=$SLURMATE_CPUS mem=${SLURMATE_MEM:-?} gpus=$SLURMATE_GPUS" \
    "service=$SLURMATE_SERVICE_KIND"
log "候选端口: $SLURMATE_CANDIDATES"

NODE_IP="$(detect_node_ip)" || {
    log "无法确定节点 IPv4，退出（ACL 依赖字面 IP，宁可不启动）"
    exit 20
}
log "节点 IPv4 = $NODE_IP"

# 服务种类必须是**本站装了作业侧实现的**之一。守护进程在提交时已经校验过一次
# （不认识就拒绝），这里是第二道 —— 手工提交、或两端版本不一致时，唯一的替代
# 是作业跑完所有候选端口之后报一句"全部失败"，那指不回根因。
if ! declare -F "start_${SLURMATE_SERVICE_KIND//-/_}" >/dev/null 2>&1; then
    log "错误：本站没有作业侧实现了 '$SLURMATE_SERVICE_KIND' 的插件"
    log "      作业侧有实现的是：$(plugin_names)（短名里的 - 在函数名里写作 _）"
    log "      插件由 deploy.sh 编织进本文件；没跑过 deploy.sh 的话，"
    log "      作业模板里就只有宿主、没有任何插件。"
    write_session "failed" 24 || true
    exit 24
fi

# 口令生成。宿主只知道这件事：配置要了口令就生成一个 —— 这是**通用机制**，
# 与是哪个插件无关。
#
# 为什么要有口令：nft ACL 的 hook 点是登录节点的 output 链，拦得住"登录节点上
# 别人连你的端口"，拦不住"另一个作业恰好调度到同一台计算节点后直接 curl
# 你的端口"（那条流量不经过登录节点）。--auth none 意味着同节点任何人一个
# curl 就完整拿到你的服务。站点可把某个插件的 auth_mode 配成 none 退回。
gen_password() {
    local n="$1" pw=""
    (( n >= 4 && n <= 64 )) || n=12
    if [[ -r /dev/urandom ]]; then
        pw="$(head -c "$((n * 4))" /dev/urandom | base64 | tr -d '/+=\n' | head -c "$((n * 2))")"
    fi
    if [[ -z "$pw" ]] && command -v openssl >/dev/null 2>&1; then
        pw="$(openssl rand -hex "$n" 2>/dev/null | head -c "$((n * 2))")"
    fi
    printf '%s' "$pw"
}

# 插件的预检。放在写 "starting" 之前：一旦不满足，会话根本不该开始，而失败原因
# 必须带回给用户（退出码 24），不能让它变成一个"看起来起来了但连不上"的作业。
plugin_call precheck
_pre_rc=$?
if (( _pre_rc == 0 )); then
    :
elif (( _pre_rc == 3 )); then
    log "（「$SLURMATE_SERVICE_KIND」没有预检钩子，跳过）"
else
    log "错误：服务种类 '$SLURMATE_SERVICE_KIND' 的预检未通过（rc=$_pre_rc，原因见上）"
    write_session "failed" 24 || true
    exit 24
fi

AUTH_PASSWORD=""
case "$SLURMATE_AUTH_MODE" in
    password)
        AUTH_PASSWORD="$(gen_password "$SLURMATE_PASSWORD_BYTES")"
        if [[ -n "$AUTH_PASSWORD" ]]; then
            export PASSWORD="$AUTH_PASSWORD"
            log "已生成本次会话的口令（auth=password）"
        else
            # 绝不静默降级为 auth=none：那恰好会移除唯一的实质保护
            # （nft ACL 挂在登录节点的 output 链，挡不住同节点的其他作业）。
            # 配置要的是 password，就得给到 password，否则这个会话不该起来。
            log "错误：无法生成口令（/dev/urandom 不可读且 openssl 缺失）"
            log "      配置要求 auth_mode=password，拒绝以 auth=none 启动"
            exit 23
        fi
        ;;
    publickey)
        # 认证靠客户端随提交带上来的那把公钥（插件在自己的 precheck 里已经校验过）。
        # ★ 绝不能落进上面那个"生成不了口令就 exit 23"的分支 —— 那会让一个与
        #   /dev/urandom 毫无关系的会话，因为一个它根本不需要的东西起不来。
        log "认证方式为公钥，不生成口令"
        ;;
    none)
        log "按配置以 auth=none 启动（保护仅靠 nft ACL，同节点其他作业可直连）"
        ;;
    *)
        log "错误：认证方式 '$SLURMATE_AUTH_MODE' 宿主不认识"
        log "      （宿主只认 password / publickey / none；其余由插件自己定义，"
        log "        而插件定义的认证方式需要插件自己在 start_ 里实现）"
        write_session "failed" 24 || true
        exit 24
        ;;
esac
AUTH_MODE="$SLURMATE_AUTH_MODE"

write_session "starting" null || log "警告：写会话文件失败（NFS 不可写？）"

if ! pick_port_and_start; then
    log "所有候选端口均失败，退出"
    write_session "failed" 22 || true
    exit 22
fi

write_session "running" null || log "警告：写会话文件失败"
write_jobhb
log "会话就绪: tunnel_target=${NODE_IP}:${SVC_PORT}"

# 作业侧心跳（每 60 秒），证明"作业还活着，是客户端掉了还是作业没了"
( while sleep 60; do write_jobhb || true; done ) &
JOBHB_PID=$!

# 等待服务进程；它退出即结束作业。这一处插件无关 —— 不论哪个插件，
# 都是"服务没了，作业就该结束"。
wait "$SVC_PID"
RC=$?
log "${SLURMATE_SERVICE_KIND} 退出 rc=$RC"
exit "$RC"
