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
#  fake-job-host.sh —— 假站点里的替身宿主
# ==============================================================================
#
# 它是什么：`cluster/run.sbatch` 里"起那个服务进程"那一小截在客户端的
#    复刻。真站点上，插件的作业侧是被安装器织进作业模板的一大段 shell，
#    跑在计算节点上；开发者模式里没有 Slurm、没有计算节点，只有这台开发机 ——
#    于是这里放一个宿主，让那份 `job/start.sh` 片段照样真的跑起来。
#
# 它不是作业模板的第二份实现，而这条界线是承重的。它只复刻契约里
#    承诺给插件的那几条（`docs/CONTRACT.md` §5.1–§5.5）：
#
#      · 分派：函数名 = `<动词>_<短名>`（短名里的 `-` 写作 `_`）
#      · 宿主给的变量（§5.2）与四个函数（§5.3）
#      · 每个候选端口各调一次 `start_<短名>`，直到某一个返回 0
#      · 服务进程必须继承宿主的 stdout/stderr（§5.5 的 `svc_stream_ok`）
#      · `wait "$SVC_PID"` —— 服务没了，作业就结束
#
#    资源、分区、排队、ACL、心跳文件、日志保留期、Slurm 查询 —— 那些是站点自己
#    的账，与插件的代码无关，假站点继续用 JS 演（见 backend-fake.js）。
#    这里多写一行，就多一行将来会与 run.sbatch 漂开的东西。
#
# 调用方式：`bash fake-job-host.sh <插件片段路径>`，其余全部走环境变量，
#   而且用的就是真宿主那一套名字（`SLURMATE_*` / `JOB_ID` / `NODE` /
#   `MY_UID` / `MY_USER`）。
#   片段路径走 `$1` 而不是再造一个 `SLURMATE_FAKE_*`：宿主给插件的名字只有
#     契约里那些，多一个都是假的接口。
#
# 需要 bash，而且这不只是个实现细节：`job/start.sh` 是被 `source` 进来的
#    片段，两个样例都用到了 `[[ ]]`、`local`、关联数组（`PLUGIN_SESSION_FIELDS`）
#    —— 那些是 bash 的，`sh` 跑不了。真宿主的 shebang 也是 `#!/bin/bash`。
#    Windows 上没有 bash，作业侧就起不来，而那必须是一句说得清的话，
#    不是一次静默失败（见 fake-job.js 里那句报错）。

set -uo pipefail

ENTRY="${1:-}"
if [[ -z "$ENTRY" || ! -r "$ENTRY" ]]; then
    printf '替身宿主：读取这个插件的作业侧片段失败（%s）\n' "${ENTRY:-（空）}" >&2
    exit 30
fi

# 契约里的硬断言：缺一个，作业当场死（与 run.sbatch 第 6 节同一批名字）。
_missing=""
for _v in SLURMATE_SESSION_ID SLURMATE_CANDIDATES SLURMATE_SERVICE_KIND \
          SLURMATE_AUTH_MODE SLURMATE_SESS_DIR SLURMATE_LOG_DIR; do
    [[ -n "${!_v:-}" ]] || _missing="$_missing $_v"
done
if [[ -n "$_missing" ]]; then
    printf '替身宿主：作业环境缺了这几个变量：%s\n' "${_missing# }" >&2
    exit 21
fi

JOB_ID="${JOB_ID:-0}"
NODE="${NODE:-localhost}"
MY_UID="${MY_UID:-$(id -u 2>/dev/null || echo 0)}"
MY_USER="${MY_USER:-$(id -un 2>/dev/null || echo unknown)}"
STARTED_AT="$(date +%s)"

# 节点本地的临时落点：唯一官方的临时文件落点，收尾时删掉（与真宿主同一条：
# 那里的东西登录节点看不见，所以删它不会动到作业日志一个字）。
# 它不是日志的落点 —— 日志走下面那两条流。
LOCAL_LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/slurmate-XXXXXX" 2>/dev/null || true)"
if [[ -n "$LOCAL_LOG_DIR" ]]; then
    chmod 700 "$LOCAL_LOG_DIR" 2>/dev/null || true
fi

# 服务的 pid / 端口。名字是通用的（`SVC_` 而不是某个插件的前缀）—— 心跳的存活门、
# 收尾时的杀进程、最后那个 `wait`，这三处都是插件无关的。
# `SVC_PID` 由插件的 `start_*` 写：这是本契约里最脆弱的一条（§5.4）。
SVC_PID=""
SVC_PORT=""
NODE_IP="127.0.0.1"
AUTH_MODE="${SLURMATE_AUTH_MODE:-none}"
AUTH_PASSWORD=""
TOMBSTONE_WRITTEN=0

# 插件往会话文件里加的字段。值由宿主统一转义 —— 让每个插件自己拼 JSON 片段
# 就等于把转义责任推给每一个插件，而转义写错的下场是整份会话文件解析不了。
declare -A PLUGIN_SESSION_FIELDS=()

SESS_FILE="${SLURMATE_SESS_DIR}/job-${JOB_ID}.json"
OUT_LOG="${SLURMATE_LOG_DIR}/slurm-${JOB_ID}.out"
ERR_LOG="${SLURMATE_LOG_DIR}/slurm-${JOB_ID}.err"

# 家目录也要在：真作业里它一定存在，而插件的 `start_*` 会往里写东西
# （两个样例都写）。它由假站点指到沙盒里一处，见 backend-fake.js。
[[ -n "${HOME:-}" ]] && mkdir -p "$HOME" 2>/dev/null || true
mkdir -p "$SLURMATE_SESS_DIR" "$SLURMATE_LOG_DIR" 2>/dev/null || true

# ─── 1. 日志：只有一处，就是这两条流 ────────────────────────────────────
#
# `exec` 这一句是实时性的前提：宿主自己写的每一行、以及服务进程写的每一行，
#    都在产生的那一刻落到这两个文件上。右栏那一栏读的就是它们（`op_job_log`），
#    于是"作业起不来了，为什么"在跑着的时候就看得见，而不是等它结束。
#
# `>>` 开出来的是 O_APPEND，与真宿主那一句逐字同形（那边另一半是 Slurm 的
#   `--open-mode=append`）。
if ! { : >> "$OUT_LOG"; } 2>/dev/null || ! { : >> "$ERR_LOG"; } 2>/dev/null; then
    printf '替身宿主：作业日志打不开：%s，这个目录存在吗、可写吗？\n' \
        "$SLURMATE_LOG_DIR" >&2
    exit 21
fi
exec 1>>"$OUT_LOG" 2>>"$ERR_LOG"

log() {
    printf '%s [slurmate/%s] %s\n' "$(date -Is)" "$JOB_ID" "$*"
}

# 出事的那几行走 stderr（，`.err`）。不是把 `log` 加个前缀：那样两份文件里都会
# 混着同一种行，"打开 `.err` 就能看到全部问题"这条性质就没了。
log_err() {
    printf '%s [slurmate/%s] %s\n' "$(date -Is)" "$JOB_ID" "$*" >&2
}

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
#
# 这一份是假站点那一侧的答案：真守护进程靠它登记会话（节点、端口、口令），
#    而假站点（backend-fake.js）读的是同样的字段。字段名与 `run.sbatch` 的
#    `write_session` 逐字相同 —— 那边是跨语言契约，这里少一个字段的症状是
#    "会话起来了，而界面上一格是空的"。
write_session() {
    local state="$1" ec="$2"
    local extra="" k
    if (( ${#PLUGIN_SESSION_FIELDS[@]} > 0 )); then
        for k in "${!PLUGIN_SESSION_FIELDS[@]}"; do
            extra="${extra},\"$(json_escape "$k")\":\"$(json_escape "${PLUGIN_SESSION_FIELDS[$k]}")\""
        done
    fi
    local body
    body="$(printf '{"schema":1,"session_id":"%s","job_id":%s,"uid":%s,"user":"%s","partition":"%s","node":"%s","node_ip":"%s","service_port":%s,"tunnel_target":"%s:%s","state":"%s","job_started_at":%s,"written_at":%s,"job_hb_at":%s,"service_kind":"%s","service_pid":%s,"auth_mode":"%s","auth_password":"%s","slurm_restart_number":%s,"exit_code":%s%s}\n' \
        "$(json_escape "$SLURMATE_SESSION_ID")" "$JOB_ID" "$MY_UID" "$(json_escape "$MY_USER")" \
        "$(json_escape "${SLURMATE_PARTITION:-}")" "$(json_escape "$NODE")" "$NODE_IP" \
        "${SVC_PORT:-0}" "$NODE_IP" "${SVC_PORT:-0}" "$state" "$STARTED_AT" \
        "$(date +%s)" "$(date +%s)" \
        "$(json_escape "$SLURMATE_SERVICE_KIND")" "${SVC_PID:-0}" \
        "$AUTH_MODE" "$(json_escape "$AUTH_PASSWORD")" \
        "0" "$ec" "$extra")"
    write_atomic "$SESS_FILE" "$body"
}

# ─── 2. 服务进程的输出必须还在作业自己的那条流上 ────────────────────────────
#
# 这一条是"插件想把输出藏起来也藏不成"那个要求的落点，与真宿主那一份
#    （run.sbatch 的 `svc_stream_ok`）同一个判据：`/proc/<pid>/fd/N` 与宿主
#    自己的 `fd/N` 是不是同一个对象。
#
# 判据不是去扫插件的源码：扫 shell 扫不干净（变量、`exec 3>`、命令替换、函数的
#   间接调用，写法无穷无尽），而内核里那张 fd 表骗不过去。
#
# 读不到就不判（进程已经没了、或这台机器没有 /proc）—— 判不了的时候拦住一个
#   合法的插件，比漏掉一个违规的插件更糟。返回 0 = 通过，非 0 = 那个 fd 号。
svc_stream_ok() {
    local pid="$1" n a b
    for n in 1 2; do
        a="$(readlink "/proc/$pid/fd/$n" 2>/dev/null || true)"
        b="$(readlink "/proc/$$/fd/$n" 2>/dev/null || true)"
        [[ -z "$a" || -z "$b" ]] && continue
        [[ "$a" == "$b" ]] && continue
        printf '%s' "$n"
        return 1
    done
    return 0
}

# ─── 3. 分派 ────────────────────────────────────────────────────────────────
#
# 函数名 = `<动词>_<短名>`，短名里的 `-` 写作 `_`。未定义 → 返回 3：
# 「没有这个钩子」与「钩子失败了」必须分开，合并的话一个没有预检的插件会被当成
# 预检失败而被拒。
plugin_call() {
    local fn="${1}_${SLURMATE_SERVICE_KIND//-/_}"; shift
    declare -F "$fn" >/dev/null 2>&1 || return 3
    "$fn" "$@"
}

host_start_service() { plugin_call start "$1"; }

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

# 在候选端口里逐个试，每个端口各调一次 `start_<短名>`。
#
# 这里没有 `port_free`，而那是刻意的。真宿主那句检查（`ss` + 一次真 bind）
#    存在的理由，是它的候选表来自配置、可能早就被同节点别的作业占了。假站点的
#    候选表是 JS 那一侧刚刚挑的（挑的时候真的 bind 过一次）—— 在这里再查一遍，
#    就是同一条规矩的第二份实现，而两份实现漂开的那天，两句话会指着不同的原因。
pick_port_and_start() {
    local p n_total=0 n_busy=0 n_fail=0
    IFS=',;' read -ra _cands <<< "$SLURMATE_CANDIDATES"
    for p in "${_cands[@]}"; do
        n_total=$((n_total + 1))
        [[ "$p" =~ ^[0-9]+$ ]] || { log "候选 '$p' 不是数字，跳过"; continue; }
        if host_start_service "$p"; then
            # 服务起来了，但它的输出还在不在作业的那条流上？不在了就当场判失败，
            #   不试下一个端口 —— 这是插件的缺陷，换端口不会好，而"悄悄跑起来、
            #   日志一个字都没有"才是最难查的。
            local _bad
            if ! _bad="$(svc_stream_ok "$SVC_PID")"; then
                log_err "服务进程的 fd ${_bad} 被重定向到了 $(readlink "/proc/$SVC_PID/fd/$_bad" 2>/dev/null || echo '?')，"
                log_err "  而作业自己的 fd ${_bad} 指向 $(readlink "/proc/$$/fd/$_bad" 2>/dev/null || echo '?')。"
                log_err "  契约要求 start_<短名> 起的服务继承宿主的 stdout/stderr，那两条流"
                log_err "  就是作业日志（.out / .err）。这个插件把服务的输出重定向到别处去了，"
                log_err "  于是作业日志里永远不会出现那个服务的输出。拒绝启动。"
                kill -TERM "$SVC_PID" 2>/dev/null || true
                sleep 1
                kill -0 "$SVC_PID" 2>/dev/null && kill -KILL "$SVC_PID" 2>/dev/null || true
                SVC_PID=""
                write_session "failed" 25 || true
                exit 25
            fi
            SVC_PORT="$p"
            return 0
        fi
        n_fail=$((n_fail + 1))
    done
    log "候选端口全部失败: 共 ${n_total} 个（启动失败 ${n_fail}）"
    return 1
}

# ─── 4. 收尾 ────────────────────────────────────────────────────────────────
cleanup() {
    local rc="${1:-$?}"
    trap - EXIT TERM INT HUP

    if [[ -n "$SVC_PID" ]] && kill -0 "$SVC_PID" 2>/dev/null; then
        kill -TERM "$SVC_PID" 2>/dev/null || true
        sleep 1
        kill -0 "$SVC_PID" 2>/dev/null && kill -KILL "$SVC_PID" 2>/dev/null || true
    fi

    # 墓碑：假站点据此立刻知道会话结束了。只在确实登记过之后才写 ——
    # 与真宿主同一条判据（`SVC_PORT` 非空 = 这条会话真的起来过）。
    if [[ -n "$SVC_PORT" && "$TOMBSTONE_WRITTEN" -eq 0 ]]; then
        TOMBSTONE_WRITTEN=1
        write_session "exited" "$rc" || true
    fi

    unset PASSWORD
    log "清理完成 rc=$rc"

    # 删掉私有的临时目录。它在日志那一行之后 —— 与真宿主同一个次序。
    [[ -n "$LOCAL_LOG_DIR" && -d "$LOCAL_LOG_DIR" ]] && rm -rf "$LOCAL_LOG_DIR" 2>/dev/null

    # 插件自己的收尾。与日志没有关系 —— 服务的输出从一开始就实时落在
    #   `.out` / `.err` 上，没有"结束时并进来"这一步，因此也没有位置约束。
    # `|| true`：插件钩子出错不该拦住墓碑之后的任何事。
    plugin_call cleanup || true

    exit "$rc"
}

trap 'cleanup $?' EXIT
trap 'log_err "收到 SIGTERM（会话结束了）"; exit 143' TERM
trap 'log_err "收到 SIGINT"; exit 130' INT
trap 'log_err "收到 SIGHUP"; exit 129' HUP

# ─── 5. 主流程（与 run.sbatch 第 6 节同一串，减掉 Slurm 那一半）─────────────
# `SLURMATE_GRES` 在替身宿主里总是空的，那句写的是"未提供"而不是真宿主那句
#   「（不占）」。它是契约里"带缺省"的那一档，作业侧只把它记进日志与会话文件、
#   不做任何判断；而客户端没有那份串的拼法（`gres.js` 只有给人看的那一份）。
#   为了一个日志字段再写一份 `gpu:a100:2`，就是同一个跨语言格式的第二份实现。
log "启动 session=$SLURMATE_SESSION_ID job=$JOB_ID node=$NODE" \
    "partition=${SLURMATE_PARTITION:-（没有）} cpus=${SLURMATE_CPUS:-?} mem=${SLURMATE_MEM:-?}" \
    "gres=${SLURMATE_GRES:-（未提供）}" \
    "service=$SLURMATE_SERVICE_KIND"
log "候选端口: $SLURMATE_CANDIDATES"

# ── 插件那一段 ──────────────────────────────────────────────────────────────
#
# 真站点上它不是被 `source` 的：安装器装插件那一刻把这份 `job/start.sh`
#    拼在模板的 `# @@SLURMATE_PLUGIN_BLOCKS@@` 标记处，成品是一个单文件的作业
#    脚本（计算节点因此不需要看得见站点上的任何东西）。假站点没有编织这一步，
#    于是它在这里被读进来 —— 而效果是同一条：插件那几个函数与宿主在同一个
#    shell 里，`plugin_call` 照样靠函数名找到它们。
#
# 于是这个片段里不许有顶层代码（契约里那条"它是一个片段"）。真有的话，
#   它在这里会被执行一次 —— 与真站点上"被拼进脚本、也在顶层"是同一种行为，
#   所以这一条不是替身造成的偏差。
# shellcheck source=/dev/null
source "$ENTRY" || {
    log_err "读不了这个插件的作业侧片段：$ENTRY"
    write_session "failed" 24 || true
    exit 24
}

# 这份片段里必须有请求的那个服务。真站点上这道网兜的是"提交了 A、跑起来的是 B"
# （一个插件一份成品脚本，脚本路径按插件算出来）—— 假站点上没有编织、也没有
# 成品脚本，片段就是站点树上那一份，所以这道网兜的是另一件事：作者的
# `job/start.sh` 里那个函数名写错了。真站点在装的那一刻就断言它
# （编织期检查），假站点没有编织这一步，于是这句话在这里才说出来。
if ! declare -F "start_${SLURMATE_SERVICE_KIND//-/_}" >/dev/null 2>&1; then
    log_err "这个插件的作业侧里没有服务 '$SLURMATE_SERVICE_KIND' 的实现"
    log_err "  要找的函数名是 start_${SLURMATE_SERVICE_KIND//-/_}（短名里的 - 在函数名里写作 _）"
    log_err "  契约见 docs/CONTRACT.md §5.1 与 §5.4"
    write_session "failed" 24 || true
    exit 24
fi

# 插件的预检。放在写 "starting" 之前：一旦不满足，会话根本不该开始。
plugin_call precheck
_pre_rc=$?
if (( _pre_rc == 0 )); then
    :
elif (( _pre_rc == 3 )); then
    log "（「$SLURMATE_SERVICE_KIND」没有预检钩子，跳过）"
else
    log_err "服务种类 '$SLURMATE_SERVICE_KIND' 的预检未通过（rc=$_pre_rc，原因见上）"
    write_session "failed" 24 || true
    exit 24
fi

AUTH_PASSWORD=""
case "$AUTH_MODE" in
    password)
        AUTH_PASSWORD="$(gen_password "${SLURMATE_PASSWORD_BYTES:-12}")"
        if [[ -n "$AUTH_PASSWORD" ]]; then
            export PASSWORD="$AUTH_PASSWORD"
            log "已生成本次会话的口令（auth=password）"
        else
            # 绝不静默降级为 auth=none —— 那恰好会移除唯一的实质保护。
            log_err "无法生成口令（/dev/urandom 不可读且 openssl 缺失）"
            exit 23
        fi
        ;;
    publickey)
        log "认证方式为公钥，不生成口令"
        ;;
    none)
        log "按配置以 auth=none 启动"
        ;;
    *)
        log_err "认证方式 '$AUTH_MODE' 宿主不认识"
        write_session "failed" 24 || true
        exit 24
        ;;
esac

write_session "starting" null || log_err "写会话文件失败"

if ! pick_port_and_start; then
    log_err "所有候选端口都失败了，退出"
    write_session "failed" 22 || true
    exit 22
fi

write_session "running" null || log_err "写会话文件失败"
log "会话就绪: tunnel_target=${NODE_IP}:${SVC_PORT}"

# 等待服务进程；它退出即结束作业。这一处插件无关 —— 不论哪个插件，
# 都是"服务没了，作业就该结束"。
wait "$SVC_PID"
RC=$?
log "${SLURMATE_SERVICE_KIND} 退出 rc=$RC"
exit "$RC"
