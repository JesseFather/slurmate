#!/bin/bash
# ==============================================================================
#  run.sbatch — Slurmate 会话作业模板
# ==============================================================================
#
#  由 slurmate-sessiond（root）以目标用户身份提交。
#  本文件必须 root 拥有、0644、用户不可写 —— 这是防注入的关键：
#  用户可控的只有 sbatch 的命令行 flag，脚本内容本身固定。
#
#  契约：
#    - 只读 SLURMATE_* 环境变量，不接受 argv
#    - 不写 /var/lib/slurmate-session（那是守护进程的）
#    - 退出前必须在 KillWait 内写完墓碑（Slurm 默认 30 秒，见你集群的
#      KillWait 配置；trap 里的工作必须能在这个窗口内做完）
#
#  产出（家目录，NFS 共享）：
#    ~/.slurmate/sessions/job-<id>.json    会话身份、隧道目标、code-server 口令
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

# ─── 环境清理（很关键）──────────────────────────────────────────────────────
# 若环境里存在这些变量，code-server 会去【附着到已有实例】而不是启动一个新的，
# 直接报 "not spawned with IPC" 然后退出 —— 作业看起来"启动失败"，但日志里
# 只有一句语焉不详的 IPC 报错。最容易踩到的方式是在某个已存在的 code-server
# 集成终端里手动跑一次。
# 正常路径下守护进程传给 sbatch 的是干净环境，这里是防御性兜底。
unset CODE_SERVER_SESSION_SOCKET VSCODE_IPC_HOOK_CLI VSCODE_CWD \
      ELECTRON_RUN_AS_NODE VSCODE_NLS_CONFIG VSCODE_PROXY_URI \
      VSCODE_ESM_ENTRYPOINT VSCODE_HANDLES_SIGPIPE VSCODE_HANDLES_UNCAUGHT_ERRORS \
      VSCODE_RECONNECTION_GRACE_TIME BROWSER 2>/dev/null || true

# ─── 0. 参数 ────────────────────────────────────────────────────────────────
: "${SLURMATE_SESSION_ID:?缺少 SLURMATE_SESSION_ID}"
: "${SLURMATE_CANDIDATES:?缺少 SLURMATE_CANDIDATES}"

# 分区可能为空串：守护进程在"分区权限查不到"时缺省提交会退化成不带 -p，
# 由 Slurm 的默认分区兜底。空就是"提交那一刻不知道"，不是"没有分区" ——
# 作业跑起来之后守护进程会从 scontrol 查到实际的，不需要这里猜。
SLURMATE_PARTITION="${SLURMATE_PARTITION:-}"
SLURMATE_CPUS="${SLURMATE_CPUS:-0}"
SLURMATE_MEM="${SLURMATE_MEM:-}"
SLURMATE_GPUS="${SLURMATE_GPUS:-0}"
SLURMATE_AUTH_MODE="${SLURMATE_AUTH_MODE:-password}"
SLURMATE_PASSWORD_BYTES="${SLURMATE_PASSWORD_BYTES:-12}"
# 兜底值只是"这个变量不该为空"的防御，不是默认网段 —— 真正的值由守护进程
# 从配置里传下来，而配置里留空时守护进程根本不会启动。
SLURMATE_CLUSTER_CIDR="${SLURMATE_CLUSTER_CIDR:-192.0.2.0/24}"
SLURMATE_CS_BIN="${SLURMATE_CS_BIN:-/usr/local/bin/code-server}"
SLURMATE_SESS_DIR="${SLURMATE_SESS_DIR:-$HOME/.slurmate/sessions}"
SLURMATE_LOG_DIR="${SLURMATE_LOG_DIR:-$HOME/.slurmate/logs}"
SLURMATE_PORT_MIN="${SLURMATE_PORT_MIN:-55001}"
SLURMATE_PORT_MAX="${SLURMATE_PORT_MAX:-55999}"

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

CS_PID=""
JOBHB_PID=""
SVC_PORT=""
NODE_IP=""
AUTH_MODE="none"
AUTH_PASSWORD=""
TOMBSTONE_WRITTEN=0

# ─── 1. 日志 ────────────────────────────────────────────────────────────────
if mkdir -p "$SLURMATE_SESS_DIR" "$SLURMATE_LOG_DIR" 2>/dev/null \
   && { : > "${SLURMATE_LOG_DIR}/.wtest.$$"; } 2>/dev/null; then
    rm -f "${SLURMATE_LOG_DIR}/.wtest.$$" 2>/dev/null
    NFS_LOG="${SLURMATE_LOG_DIR}/job-${JOB_ID}.log"
fi

NFS_LINES=0
log() {
    local line
    line="$(date -Is) [slurmate/${JOB_ID}] $*"
    printf '%s\n' "$line" >> "$LOCAL_LOG" 2>/dev/null || true
    if [[ -n "$NFS_LOG" ]] && printf '%s\n' "$line" >> "$NFS_LOG" 2>/dev/null; then
        NFS_LINES=$((NFS_LINES + 1))
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
# 客户端通过守护进程的 status 或直接读本文件取得它，用于自动登录 code-server。
write_session() {
    local state="$1" ec="$2"
    local body
    body="$(printf '{"schema":1,"session_id":"%s","job_id":%s,"uid":%s,"user":"%s","partition":"%s","node":"%s","node_ip":"%s","service_port":%s,"tunnel_target":"%s:%s","state":"%s","job_started_at":%s,"written_at":%s,"job_hb_at":%s,"code_server_pid":%s,"auth_mode":"%s","auth_password":"%s","slurm_restart_number":%s,"exit_code":%s}\n' \
        "$(json_escape "$SLURMATE_SESSION_ID")" "$JOB_ID" "$MY_UID" "$(json_escape "$MY_USER")" \
        "$(json_escape "$SLURMATE_PARTITION")" "$(json_escape "$NODE")" "$NODE_IP" \
        "${SVC_PORT:-0}" "$NODE_IP" "${SVC_PORT:-0}" "$state" "$STARTED_AT" \
        "$(date +%s)" "$(date +%s)" "${CS_PID:-0}" "$AUTH_MODE" \
        "$(json_escape "$AUTH_PASSWORD")" \
        "${SLURM_RESTART_NUMBER:-0}" "$ec")"
    write_atomic "$SESS_FILE" "$body"
}

write_jobhb() {
    [[ -n "$CS_PID" ]] || return 0
    kill -0 "$CS_PID" 2>/dev/null || return 0
    write_atomic "$JOBHB_FILE" \
        "$(printf '{"job_id":%s,"at":%s,"code_server_pid":%s}\n' "$JOB_ID" "$(date +%s)" "$CS_PID")"
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

start_code_server() {
    local p="$1" probe_host="$1" host
    host="$NODE_IP"; [[ -z "$host" ]] && host="127.0.0.1"

    log "尝试在 ${NODE_IP}:${p} 启动 code-server (auth=${AUTH_MODE})"
    nohup "$SLURMATE_CS_BIN" \
        --bind-addr "${NODE_IP}:${p}" \
        --auth "$AUTH_MODE" \
        --disable-telemetry \
        --disable-update-check \
        --user-data-dir "$HOME/.local/share/code-server" \
        --extensions-dir "$HOME/.local/share/code-server/extensions" \
        >> "$LOCAL_LOG" 2>&1 &
    CS_PID=$!

    # 就绪判定：优先 /healthz 返回 2xx；若将来 code-server 版本改了这个端点，
    # 退而求其次 —— 只要能拿到任何 HTTP 响应就说明 HTTP 服务起来了，
    # 再给 5 秒让 IDE 资源就绪。避免"端点改名导致会话永远起不来"。
    local i code http_ok_since=""
    for i in $(seq 1 45); do
        if ! kill -0 "$CS_PID" 2>/dev/null; then
            log "code-server 在端口 $p 上提前退出（可能端口被占）"
            CS_PID=""
            return 1
        fi
        if curl -fsS -o /dev/null --max-time 2 "http://${NODE_IP}:${p}/healthz" 2>/dev/null; then
            log "code-server 就绪: ${NODE_IP}:${p} pid=$CS_PID (/healthz 通过)"
            return 0
        fi
        code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 \
                "http://${NODE_IP}:${p}/" 2>/dev/null || echo 000)"
        if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then
            if [[ -z "$http_ok_since" ]]; then
                http_ok_since="$i"
                log "端口 $p 已有 HTTP 响应（$code）但 /healthz 未通过，等待 IDE 就绪"
            elif (( i - http_ok_since >= 5 )); then
                log "code-server 就绪: ${NODE_IP}:${p} pid=$CS_PID（HTTP 响应兜底判定）"
                return 0
            fi
        fi
        sleep 1
    done

    log "code-server 在端口 $p 上 45 秒未就绪，放弃该端口"
    kill -TERM "$CS_PID" 2>/dev/null; sleep 1
    kill -KILL "$CS_PID" 2>/dev/null
    CS_PID=""
    return 1
}

pick_port_and_start() {
    local p n_total=0 n_range=0 n_busy=0 n_fail=0
    IFS=',' read -ra _cands <<< "$SLURMATE_CANDIDATES"
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
        if start_code_server "$p"; then
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
    if [[ -n "$CS_PID" ]] && kill -0 "$CS_PID" 2>/dev/null; then
        kill -TERM "$CS_PID" 2>/dev/null || true
        sleep 2
        kill -0 "$CS_PID" 2>/dev/null && kill -KILL "$CS_PID" 2>/dev/null || true
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

    # 只补写【尚未成功落 NFS】的那部分。log() 是双写的，所以这里绝不能整体追加
    # （那会让每行重复一遍 —— 曾经踩过）。NFS 中途不可用时，NFS_LINES 会落后于
    # LOCAL_LOG 的实际行数，这段就把它补齐。
    if [[ -n "$NFS_LOG" && -f "$LOCAL_LOG" ]]; then
        local total
        total="$(wc -l < "$LOCAL_LOG" 2>/dev/null || echo 0)"
        if (( total > NFS_LINES )); then
            tail -n +"$((NFS_LINES + 1))" "$LOCAL_LOG" >> "$NFS_LOG" 2>/dev/null || true
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
    "partition=${SLURMATE_PARTITION:-（Slurm 默认）} cpus=$SLURMATE_CPUS mem=${SLURMATE_MEM:-?} gpus=$SLURMATE_GPUS"
log "候选端口: $SLURMATE_CANDIDATES"

NODE_IP="$(detect_node_ip)" || {
    log "无法确定节点 IPv4，退出（ACL 依赖字面 IP，宁可不启动）"
    exit 20
}
log "节点 IPv4 = $NODE_IP"

# 口令：作业自己生成。不经过环境变量传给作业（sbatch --export 可能被
# scontrol show job 显示），而是本进程生成后直接写进 0600 的会话文件、
# 并以 PASSWORD 环境变量交给 code-server 子进程（/proc/<pid>/environ 只有
# 本人和 root 可读）。
#
# 为什么要口令：nft ACL 的 hook 点是登录节点的 output 链，拦得住"登录节点上
# 别人连你的端口"，拦不住"另一个作业恰好调度到同一台计算节点后直接 curl
# 你的端口"（那条流量不经过登录节点）。--auth none 意味着同节点任何人一个
# curl 就完整拿到你的 IDE。可用 SLURMATE_AUTH_MODE=none 退回现有行为。
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

AUTH_PASSWORD=""
if [[ "$SLURMATE_AUTH_MODE" == "password" ]]; then
    AUTH_PASSWORD="$(gen_password "$SLURMATE_PASSWORD_BYTES")"
    if [[ -n "$AUTH_PASSWORD" ]]; then
        export PASSWORD="$AUTH_PASSWORD"
        AUTH_MODE="password"
        log "已生成本次会话的 code-server 口令（auth=password）"
    else
        # 绝不静默降级为 auth=none：那恰好会移除唯一的实质保护
        # （nft ACL 挂在登录节点的 output 链，挡不住同节点的其他作业）。
        # 配置要的是 password，就得给到 password，否则这个会话不该起来。
        log "错误：无法生成口令（/dev/urandom 不可读且 openssl 缺失）"
        log "      配置要求 auth_mode=password，拒绝以 auth=none 启动"
        exit 23
    fi
else
    AUTH_MODE="none"
    log "按配置以 auth=none 启动（保护仅靠 nft ACL，同节点其他作业可直连）"
fi

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

# 等待 code-server；它退出即结束作业
wait "$CS_PID"
RC=$?
log "code-server 退出 rc=$RC"
exit "$RC"

