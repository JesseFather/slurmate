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
#  两种服务（**互斥**，由 SLURMATE_SERVICE_KIND 选；见 start_service）：
#    code-server —— 浏览器里的 IDE。默认值，行为与本功能引入前完全一致。
#    sshd        —— 用户态 ssh，供原生 VS Code Remote-SSH / codex 这类【要求 ssh】
#                   的工具用，因为用户不能直接 ssh 到计算节点。
#                   ★ 它读不到站点的 ssh 准入白名单 —— 这是结构性的，理由见
#                     start_sshd 上方那段长注释。但会话整个跑在作业的 cgroup 里，
#                     所以它给的是「Slurm 分配里的一把 ssh」，不是「逃出 Slurm 的 ssh」。
#
#  退出码（本文件添补的几位）：20 无法确定节点 IPv4 / 22 候选端口全部失败 /
#    23 配置要口令却生成不出来 / 24 服务类型未知、或 sshd 分支缺一行合法公钥
#
#  产出（家目录，NFS 共享）：
#    ~/.slurmate/sessions/job-<id>.json    会话身份、隧道目标、code-server 口令
#    ~/.slurmate/sessions/job-<id>.jobhb   作业侧心跳（证明作业还活着）
#    ~/.slurmate/logs/job-<id>.log         作业日志
#    ~/.slurmate/ssh/host_ed25519          sshd 分支的主机密钥（**必须持久**，见下）
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
# 这个作业提供哪种服务。**两条分支互斥**，由守护进程在提交时定。
#   code-server —— 浏览器里的 IDE（默认，行为与本功能引入前完全一致）
#   sshd        —— 用户态 ssh，供原生 VS Code Remote-SSH / codex 这类【要求 ssh】的工具用
SLURMATE_SERVICE_KIND="${SLURMATE_SERVICE_KIND:-code-server}"
# 客户端的公钥（一行 OpenSSH 格式），sshd 分支用它写 authorized_keys。
# ★ 为什么必须由客户端带上来、而不是用用户已有的 ~/.ssh/authorized_keys：
#   本集群的 sshd 走 `AuthorizedKeysCommand /usr/bin/sss_ssh_authorizedkeys`（IPA），
#   ~/.ssh/authorized_keys 并不是公钥的真实来源；而这里的 sshd 是**非 root** 跑的，
#   它查不了 SSSD。所以必须有一份本地的 AuthorizedKeysFile。
# ★ 公钥不是秘密，走环境变量没有后果（与"口令绝不走环境变量"是两回事 —— 那条的
#   理由是 `scontrol show job` 会显示 Environment）。这个区别要留在注释里，
#   否则下一个人会把它当成同类问题"修掉"。
SLURMATE_SSH_PUBKEY="${SLURMATE_SSH_PUBKEY:-}"
# 主机密钥的持久位置。**必须在共享家目录**：客户端把它钉死在固定的
# UserKnownHostsFile 里，换了主机密钥 ssh 会判定为中间人攻击 —— 用户看到的是
# 「昨天还能用，今天连不上」。
SLURMATE_SSH_DIR="${SLURMATE_SSH_DIR:-$HOME/.slurmate/ssh}"
# 硬编码而不是去 which：登录节点上的路径对计算节点不是证据（与 code_server_bin
# 那条注释同理）。/usr/sbin/sshd 在两个发行版家族里都是这个位置。
SLURMATE_SSHD_BIN="${SLURMATE_SSHD_BIN:-/usr/sbin/sshd}"

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

# 服务的 pid。名字是通用的（`SVC_` 而不是 `CS_`），因为心跳的存活门、cleanup 的
# 杀进程、以及最后的 `wait` 这三处**都是分支无关的** —— 它们只需要一个「服务进程」，
# 不需要知道那是 code-server 还是 sshd。留着 CS_ 这个名字会让下一个人以为里面
# 躺的必然是 code-server。
SVC_PID=""
JOBHB_PID=""
SVC_PORT=""
NODE_IP=""
AUTH_MODE="none"
AUTH_PASSWORD=""
SSHD_LOG=""                 # sshd 分支自己的日志（-E），cleanup 时并进作业日志
SSH_HOST_KEY="${SLURMATE_SSH_DIR}/host_ed25519"
# 主机密钥的**公钥**部分（`ssh-ed25519 AAAA…`，没有注释）。写进会话文件带给客户端。
# ★ 它存在的唯一理由是让客户端的 ssh 能用 StrictHostKeyChecking yes。
#   没有它，客户端只能 accept-new（首次信任）—— 而这条通路上"首次"是可以被抢的：
#   端口来自候选表，同节点另一个用户理论上能在我们的 sshd 起来之前先占住那个端口，
#   客户端第一次连过去就 TOFU 了他的密钥。带上去之后，客户端先把这一条写进
#   known_hosts 再连，那个窗口不存在。
# 空 = 不是 sshd 分支、或还没生成。
SSH_HOST_PUB=""
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
    body="$(printf '{"schema":1,"session_id":"%s","job_id":%s,"uid":%s,"user":"%s","partition":"%s","node":"%s","node_ip":"%s","service_port":%s,"tunnel_target":"%s:%s","state":"%s","job_started_at":%s,"written_at":%s,"job_hb_at":%s,"service_kind":"%s","service_pid":%s,"ssh_host_key":"%s","auth_mode":"%s","auth_password":"%s","slurm_restart_number":%s,"exit_code":%s}\n' \
        "$(json_escape "$SLURMATE_SESSION_ID")" "$JOB_ID" "$MY_UID" "$(json_escape "$MY_USER")" \
        "$(json_escape "$SLURMATE_PARTITION")" "$(json_escape "$NODE")" "$NODE_IP" \
        "${SVC_PORT:-0}" "$NODE_IP" "${SVC_PORT:-0}" "$state" "$STARTED_AT" \
        "$(date +%s)" "$(date +%s)" \
        "$(json_escape "$SLURMATE_SERVICE_KIND")" "${SVC_PID:-0}" \
        "$(json_escape "$SSH_HOST_PUB")" "$AUTH_MODE" \
        "$(json_escape "$AUTH_PASSWORD")" \
        "${SLURM_RESTART_NUMBER:-0}" "$ec")"
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
    SVC_PID=$!

    # 就绪判定：优先 /healthz 返回 2xx；若将来 code-server 版本改了这个端点，
    # 退而求其次 —— 只要能拿到任何 HTTP 响应就说明 HTTP 服务起来了，
    # 再给 5 秒让 IDE 资源就绪。避免"端点改名导致会话永远起不来"。
    local i code http_ok_since=""
    for i in $(seq 1 45); do
        if ! kill -0 "$SVC_PID" 2>/dev/null; then
            log "code-server 在端口 $p 上提前退出（可能端口被占）"
            SVC_PID=""
            return 1
        fi
        if curl -fsS -o /dev/null --max-time 2 "http://${NODE_IP}:${p}/healthz" 2>/dev/null; then
            log "code-server 就绪: ${NODE_IP}:${p} pid=$SVC_PID (/healthz 通过)"
            return 0
        fi
        code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 \
                "http://${NODE_IP}:${p}/" 2>/dev/null || echo 000)"
        if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then
            if [[ -z "$http_ok_since" ]]; then
                http_ok_since="$i"
                log "端口 $p 已有 HTTP 响应（$code）但 /healthz 未通过，等待 IDE 就绪"
            elif (( i - http_ok_since >= 5 )); then
                log "code-server 就绪: ${NODE_IP}:${p} pid=$SVC_PID（HTTP 响应兜底判定）"
                return 0
            fi
        fi
        sleep 1
    done

    log "code-server 在端口 $p 上 45 秒未就绪，放弃该端口"
    kill -TERM "$SVC_PID" 2>/dev/null; sleep 1
    kill -KILL "$SVC_PID" 2>/dev/null
    SVC_PID=""
    return 1
}

# ─── 4b. sshd 分支：一个跑在作业里的用户态 ssh ──────────────────────────────
#
# 为什么要有它：原生 VS Code Remote-SSH、codex 这类工具**要求一个 ssh 连接**，
# 而用户不能直接 ssh 到计算节点。
#
# ── 它与站点的 ssh 准入白名单是什么关系（这一点必须写清楚）────────────────────
#
# 站点用 pam_access + /etc/security/access.conf 限制谁能 ssh 进计算节点。这个
# 用户态 sshd **读不到那份策略**，而且是结构性的：非 root 的 sshd 只能用
# `UsePAM no`，PAM 栈整个不跑，`pam_access` 从不执行。
#
# 所以它不是"绕过了白名单"就完了 —— 白名单要保护的那件事是**「用户不在 Slurm
# 监管下使用计算节点」**，而这个会话**就在监管之下**，实测可证：
#   ① 会话的 cgroup 落在 job_<id>/step_batch 里（与作业同一个）；
#   ② 三重 setsid 想脱离的进程，作业一结束就被收掉，一秒都活不过去。
# 换句话说，它给的是「在 Slurm 分配里的一把 ssh」，不是「一个逃出 Slurm 的 ssh」。
#
# ★ 因此【不要】试图让它去遵守白名单（比如打开 UsePAM）。那会让功能对**所有**
#   普通用户失效 —— 站点那份 access.conf 通常只放行 root 与管理员。
#
# ── 爆炸半径 ───────────────────────────────────────────────────────────────
# 注入的是**公钥**（不是秘密），授的是「以你自己身份进入你自己的作业」。
# 非 root 的 sshd 根本无法切换成别的用户，所以最坏情况就是作业属主让别人用**他自己
# 的**账号 —— 那是他本来就有的权力，不产生任何新访问。

# 公钥形态检查。这是安全关键，不是"防御性编程"：
# authorized_keys 的语法允许【选项前缀】（command=、environment=、cert-authority…）
# 和任意多行。只接受"一行、以算法名开头、后面只有 base64"，一次性排除掉：
#   · 追加第二条（别人的）公钥
#   · 注入 authorized_keys 选项（例如把一整把 CA 拉进来）
#   · 逗号 —— 它会破坏 sbatch 的 --export 逗号分隔，把一个环境变量变成两个
# ed25519 的 blob 恒为 51 字节 → base64 恒为 68 字符且无填充，所以长度可以卡死。
# 客户端（client/src/main/keys.js）只生成 ed25519，不会误伤。
check_ssh_pubkey() {
    # 正则放进变量：`[[ x =~ a[ ]b ]]` 里那个空格会被 bash 当成**词分隔符**，
    # 于是条件表达式被劈成两半、报 "syntax error in conditional expression"。
    # 放进变量就没有解析器参与，也就不存在这个坑。
    local re='^ssh-ed25519 [A-Za-z0-9+/]{68}$'
    [[ "${1:-}" =~ $re ]]
}

# 主机密钥：存在就复用，不存在才生成。返回 0 表示 $SSH_HOST_KEY 可用。
#
# ★ 只持久化【私钥】，`.pub` 用 `ssh-keygen -y` 现推。存两份就多一处"两份数据
#   不一致"的可能，而那个症状在客户端看来是"主机密钥不匹配"，根因却埋在计算节点的
#   日志里。
ensure_host_key() {
    local tmp pub

    if [[ -s "$SSH_HOST_KEY" ]]; then
        # 已存在：必须是能解析的私钥。截断/被换过的密钥不能拿去启动 sshd ——
        # 那会让客户端看到"主机密钥不匹配"，而根因埋在计算节点的日志里。
        pub="$(ssh-keygen -y -f "$SSH_HOST_KEY" 2>/dev/null)" || true
        if [[ -z "$pub" ]]; then
            log "错误：$SSH_HOST_KEY 存在但不是可解析的私钥，拒绝启动"
            log "      （确认不是被人动过之后，删掉它可重新生成）"
            return 1
        fi
        chmod 600 "$SSH_HOST_KEY" 2>/dev/null || true
        SSH_HOST_PUB="$pub"
        return 0
    fi

    command -v ssh-keygen >/dev/null 2>&1 || {
        log "错误：计算节点上找不到 ssh-keygen（openssh-client 没装？）"
        return 1
    }
    mkdir -p "$SLURMATE_SSH_DIR" 2>/dev/null || {
        log "错误：无法创建 $SLURMATE_SSH_DIR"
        return 1
    }
    chmod 700 "$SLURMATE_SSH_DIR" 2>/dev/null || true

    tmp="$SLURMATE_SSH_DIR/.host_ed25519.tmp.$$"
    rm -f "$tmp" "$tmp.pub" 2>/dev/null || true
    # -N ''：带口令的主机密钥无法无人值守启动。
    # </dev/null：目标已存在时 ssh-keygen 会【交互式】问是否覆盖 —— 少了这个重定向
    # 它会一直等下去（表现为作业永远卡在"启动中"，日志里一句错都没有）。
    if ! ssh-keygen -q -t ed25519 -N '' -C 'slurmate-jobhost' \
             -f "$tmp" </dev/null >>"$LOCAL_LOG" 2>&1; then
        log "错误：ssh-keygen 生成主机密钥失败"
        rm -f "$tmp" "$tmp.pub" 2>/dev/null || true
        return 1
    fi
    chmod 600 "$tmp" 2>/dev/null || true

    # ★ 用 ln 而不是 mv：两个作业同时首次启动时，他们竞争同一个路径。
    #   mv（rename）的败者是**静默覆盖** —— 已经连上的客户端下次连接会看到新主机密钥，
    #   也就是"中间人攻击"告警，而密钥在客户端眼里变来变去。
    #   ln 的败者拿到 EEXIST，先到者胜出，密钥一旦落定**不可变**、且内容从诞生那一刻
    #   起就是完整的（`>` 配 noclobber 做不到这一点：它只能创建空文件）。
    #   临时文件必须与目标**同目录** —— link 不跨文件系统。
    #   ★ 绝不能用 mkdir 当锁：作业随时可能被 scancel，锁会永久残留，
    #     之后**所有**作业都再也起不来 sshd。
    if ln "$tmp" "$SSH_HOST_KEY" 2>/dev/null; then
        log "已生成本用户的主机密钥 $SSH_HOST_KEY（本账号首次用 sshd 分支）"
    elif [[ -s "$SSH_HOST_KEY" ]]; then
        log "主机密钥已由并发的另一个作业落定，复用它"
    else
        log "错误：无法把主机密钥落到 $SSH_HOST_KEY（家目录只读？）"
        rm -f "$tmp" "$tmp.pub" 2>/dev/null || true
        return 1
    fi
    rm -f "$tmp" "$tmp.pub" 2>/dev/null || true
    chmod 600 "$SSH_HOST_KEY" 2>/dev/null || true

    # 落定之后再推一次公钥。注意这里**不要**改成复用上面那份 $pub —— 上面那份是
    # 生成前推的，而 ln 的败者拿到的是【别人】的密钥，两者不是同一把。
    pub="$(ssh-keygen -y -f "$SSH_HOST_KEY" 2>/dev/null)" || true
    if [[ -z "$pub" ]]; then
        log "错误：刚刚落定的主机密钥不可解析，拒绝启动"
        return 1
    fi
    SSH_HOST_PUB="$pub"
    return 0
}

# 嗅探 SSH 版本行。这是**端到端**的就绪判据。
#
# 为什么不用"端口在监听"：那不能证明回话的是 SSH（可能是同节点别的进程抢到了端口）。
# 为什么不用日志里的 "Server listening on ..."：ListenAddress 写错它照样这么说，
# 而客户端连不上。
# 为什么要 `read -t`：`head -c N <&3` 收不到 EOF 时会**挂满 LoginGraceTime（120 秒）**，
# 作业看起来就是卡住了。
# ★ stderr 必须在【调用处】重定向：`2>/dev/null` 写在函数里挡不住连接被拒时的
#   `line N: /dev/tcp/...: Connection refused`。
probe_ssh_banner() {
    local ip="$1" p="$2" out=""
    if exec 3<>"/dev/tcp/${ip}/${p}"; then
        IFS= read -r -t 2 out <&3 || true
        exec 3<&- 2>/dev/null || true   # 立刻关掉，否则 sshd 要干等到 LoginGraceTime
    fi
    printf '%s' "$out"
}

start_sshd() {
    local p="$1" cfg authkeys i banner=""

    # code-server 分支不需要可写的本地目录，sshd 需要（配置与 authorized_keys 都
    # 必须落在私有的、一次性的地方）。mktemp 失败时必须**明确失败**，而不是退到
    # 某个可预测的路径上 —— 那正是上面 mktemp 那段注释在防的事。
    if [[ -z "$LOCAL_LOG_DIR" || ! -d "$LOCAL_LOG_DIR" ]]; then
        log "错误：没有可用的节点本地私有目录（mktemp 失败），sshd 分支无法启动"
        return 1
    fi
    [[ -x "$SLURMATE_SSHD_BIN" ]] || {
        log "错误：$SLURMATE_SSHD_BIN 不存在或不可执行"
        return 1
    }
    ensure_host_key || return 1

    cfg="$LOCAL_LOG_DIR/sshd_config"
    authkeys="$LOCAL_LOG_DIR/authorized_keys"
    SSHD_LOG="$LOCAL_LOG_DIR/sshd.log"

    printf '%s\n' "$SLURMATE_SSH_PUBKEY" > "$authkeys" 2>/dev/null || {
        log "错误：无法写 $authkeys"
        return 1
    }
    chmod 600 "$authkeys" 2>/dev/null || true

    # 用 -f 指定配置后 sshd 【不再读】/etc/ssh/sshd_config（含 sshd_config.d）。
    # 这是刻意的：站点级配置里任何一个非默认项都会让这个用户态实例的行为变得
    # 不可预测，而它必须与作业里这一份严格一致。
    cat > "$cfg" <<EOF
# 由 run.sbatch 生成，每次作业一份。逐项理由见 run.sbatch 里对应的注释。
Port $p
# 与 code-server 的 --bind-addr 对齐：只听集群地址。默认是 0.0.0.0 + ::，
# 那会把端口挂到计算节点的所有接口上 —— 而 nft ACL 挂在【登录节点】的 output 链，
# 管不到"从外部直连计算节点"这条路径。
ListenAddress $NODE_IP
AddressFamily inet

HostKey $SSH_HOST_KEY
AuthorizedKeysFile $authkeys
AllowUsers $MY_USER

# 非 root 的 sshd 不能用 PAM（pam_loginuid / pam_systemd 要写 /proc 与 /run），
# 而且我们也不想要它 —— 见文件头那段关于白名单的说明。
UsePAM no
# 关掉 PAM 之后口令只剩"读 /etc/shadow"一条路，而那是 root 的权限。
# 显式关掉，而不是依赖"它恰好读不到"。
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
# 白名单式收口：即使上面某项将来被改回默认，认证方式也不会变宽。
AuthenticationMethods publickey

# ── 必须显式关掉的危险默认值 ──
PermitRootLogin no
PermitTunnel no
X11Forwarding no             # 默认 yes：会去起 xauth、开一个监听端口
AllowAgentForwarding no      # 默认 yes：agent 在客户端，不该被转发到共享的计算节点
PermitUserEnvironment no     # 否则 ~/.ssh/environment 能把 LD_PRELOAD 注入会话

# ── 必须开着的 ──
# VS Code Remote-SSH 的端口转发走 direct-tcpip，关了它直接连不上。
AllowTcpForwarding yes
# 必须显式关掉：一旦是 yes，-R 转发会绑到非回环地址，而那条【入向】路径不经过
# 登录节点的 nft ACL —— 等于在计算节点上开了一个谁都能连的端口。
GatewayPorts no

LoginGraceTime 20            # 收敛未认证连接占用槽位的时间（默认 120s）
# ★ 唯一一个"关掉更安全"的项。StrictModes 会检查 authorized_keys 【整条路径】上
#   每一级的权限，而我们在 /tmp 下（1777）—— 它会因此拒绝登录，报在服务端日志里，
#   客户端只看到一句"认证失败"。而它在这里没有保护对象：文件是我们自己用 umask 077
#   建在 0700 私有目录里的，同节点其他用户既不能预创建这个路径、也不能往里写。
StrictModes no
# 非 root 写不了 /run/sshd.pid，而 -D 前台运行也不需要 pid 文件。
PidFile none
# Remote-SSH 会用到 sftp；internal-sftp 不依赖发行版各异的 sftp-server 路径。
Subsystem sftp internal-sftp
LogLevel VERBOSE
EOF
    chmod 600 "$cfg" 2>/dev/null || true

    log "尝试在 ${NODE_IP}:${p} 启动用户态 sshd (hostkey=$SSH_HOST_KEY)"
    log "已授权提交时带上来的公钥: $SLURMATE_SSH_PUBKEY"
    # ★ -D 是必需的，不是风格问题：不加它 sshd 会 daemon(1,0) —— fork + setsid，
    #   **父进程立刻退出**，$! 当场变成死 pid，wait 立即返回 → 作业在服务起来的
    #   同一秒就结束；心跳的存活门 kill -0 也会失败、心跳根本不会写。
    # -E 把 sshd 自己的日志落到作业本地目录：认证失败这类事实只有它知道，
    #   不落盘的话作业结束后就永远查不到了（cleanup 会把它并进 NFS 日志）。
    nohup "$SLURMATE_SSHD_BIN" -D -f "$cfg" -E "$SSHD_LOG" >> "$LOCAL_LOG" 2>&1 &
    SVC_PID=$!

    for i in $(seq 1 20); do
        if ! kill -0 "$SVC_PID" 2>/dev/null; then
            log "sshd 在端口 $p 上提前退出（配置不合法？端口被占？）"
            log "sshd 日志尾部: $(tail -n 5 "$SSHD_LOG" 2>/dev/null | tr '\n' '|')"
            SVC_PID=""
            return 1
        fi
        banner="$(probe_ssh_banner "$NODE_IP" "$p" 2>/dev/null)"
        if [[ "$banner" == SSH-2.0-* ]]; then
            log "sshd 就绪: ${NODE_IP}:${p} pid=$SVC_PID（版本行 ${banner%$'\r'}）"
            return 0
        fi
        sleep 1
    done

    log "sshd 在端口 $p 上 20 秒未就绪，放弃该端口"
    log "sshd 日志尾部: $(tail -n 5 "$SSHD_LOG" 2>/dev/null | tr '\n' '|')"
    kill -TERM "$SVC_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$SVC_PID" 2>/dev/null || true
    SVC_PID=""
    return 1
}

# 服务分发。用 case 而不是两个 if：互斥是【结构上】的 —— 只有一个变量、一次分派，
# "两个服务都起来了"这个状态根本写不出来。
start_service() {
    case "$SLURMATE_SERVICE_KIND" in
        code-server) start_code_server "$1" ;;
        sshd)        start_sshd "$1" ;;
        *)
            log "错误：未知的服务类型 '$SLURMATE_SERVICE_KIND'"
            return 1
            ;;
    esac
}

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
        if start_service "$p"; then
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

    # 把 sshd 自己的日志并进作业日志。位置很要紧：必须在下面那段"NFS 补写"【之前】，
    # 它才会被一起带上去。不并的话，"认证被拒"这类只有 sshd 知道的事实在作业结束后
    # 就永远消失了 —— 客户端只看到一句"认证失败"，而原因（比如 StrictModes 不满意
    # 某级目录的权限）躺在计算节点上一个已经删掉的临时目录里。
    if [[ -n "$SSHD_LOG" && -f "$SSHD_LOG" ]]; then
        tail -n 200 "$SSHD_LOG" >> "$LOCAL_LOG" 2>/dev/null || true
    fi

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

# 服务类型的预检。放在写 "starting" 之前：这几条一旦不满足，会话根本不该开始，
# 而失败原因必须带回给用户（退出码 24），不能让它变成一个"看起来起来了但连不上"的作业。
case "$SLURMATE_SERVICE_KIND" in
    code-server)
        ;;
    sshd)
        if ! check_ssh_pubkey "$SLURMATE_SSH_PUBKEY"; then
            log "错误：sshd 分支需要一行合法的 ssh-ed25519 公钥（由客户端随提交带上来）"
            log "      当前值：${SLURMATE_SSH_PUBKEY:-（空）}"
            write_session "failed" 24 || true
            exit 24
        fi
        ;;
    *)
        log "错误：未知的服务类型 '$SLURMATE_SERVICE_KIND'（只有 code-server 与 sshd）"
        write_session "failed" 24 || true
        exit 24
        ;;
esac

AUTH_PASSWORD=""
if [[ "$SLURMATE_SERVICE_KIND" == "sshd" ]]; then
    # sshd 分支不用口令：认证靠客户端那把公钥（见文件头那段爆炸半径的说明）。
    # ★ 绝不能落进下面那个"生成不了口令就 exit 23"的分支 —— 那会让一个与
    #   /dev/urandom 毫无关系的会话，因为一个它根本不需要的东西起不来。
    AUTH_MODE="publickey"
    log "sshd 分支：认证方式为公钥，不生成口令"
elif [[ "$SLURMATE_AUTH_MODE" == "password" ]]; then
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

# 等待服务进程；它退出即结束作业。这一处分支无关 —— 不论 code-server 还是 sshd，
# 都是"服务没了，作业就该结束"。
wait "$SVC_PID"
RC=$?
log "${SLURMATE_SERVICE_KIND} 退出 rc=$RC"
exit "$RC"

