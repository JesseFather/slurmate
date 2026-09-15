# ==============================================================================
#  code-server —— 作业侧实现
# ==============================================================================
#
#  ★ 这个文件**不是一个可执行脚本**，它是一段被 deploy.sh 编织进 run.sbatch 的
#    **片段**：部署时它会被拼在作业模板里那个 `# @@SLURMATE_PLUGIN_BLOCKS@@`
#    标记处，成品是一个单文件的作业脚本。计算节点因此不需要能看见
#    <prefix>/share/slurmate/ 里的任何东西 —— 那是这台机器上第一份"共享目录
#    对计算节点可见"的前置条件，而它在登录节点上永远验证不出来。
#
#  ★ 因此有两条硬规矩（deploy.sh 在编织时会逐条断言，违反就让部署当场中止）：
#
#    1. **不许有 shebang、不许有 `#SBATCH`**。它们在拼接点之后，而 Slurm 只扫
#       脚本**开头**那一段连续的注释（模板里 `set -uo pipefail` 那一行就终止了
#       扫描）。带了不是报错，是**写了但静默不生效**。资源需求全部由守护进程在
#       提交时经 sbatch 命令行 argv 定下，插件从来不参与。
#
#    2. **函数名一律带 `_code_server` 后缀**。编织之后所有插件共处一个文件，
#       固定名会互相覆盖 —— 而且覆盖是静默的，症状是"装了第二个插件之后第一个
#       就坏了"。宿主自己的函数都是没有后缀的动词（log / cleanup / write_session
#       / pick_port_and_start …），两套命名不会撞。
#
#  ── 宿主给插件的东西（同一个 shell，直接读）────────────────────────────────
#
#    $1                 宿主挑好的端口
#    $NODE_IP           本节点的**字面 IPv4**（ACL 的 ip daddr 依赖它；别自己解析
#                       节点名 —— 解析结果与集群侧写进 nft 的不一致时 ACL 会静默失效）
#    $LOCAL_LOG         节点本地日志文件，必定可写
#    $SLURMATE_CS_BIN   本插件的可执行文件路径，由守护进程按站点 [plugin:code-server]
#                       的 bin 解析后传下来（这个变量名由 plugin.json 的 site.bin.env
#                       声明，宿主不认识它）
#    函数 log / json_escape / write_atomic / write_session 直接可用
#
#  ── 插件必须做的 ───────────────────────────────────────────────────────────
#
#    start_code_server <端口>
#        返回 0 = 起来了，**并且把服务进程的 pid 写进 $SVC_PID** —— 心跳的存活门、
#        cleanup 里的杀进程、以及主流程最后的 `wait` 三处都读它。不写它的话作业会
#        在"会话就绪"那一行之后立刻结束。
#        返回非 0 = 这个端口失败，宿主换下一个候选。
#
# ==============================================================================

# 环境清理：若环境里存在这些变量，code-server 会去【附着到已有实例】而不是启动一个
# 新的，直接报 "not spawned with IPC" 然后退出 —— 作业看起来"启动失败"，但日志里
# 只有一句语焉不详的 IPC 报错。最容易踩到的方式是在某个已存在的 code-server 集成
# 终端里手动跑一次作业。
#
# ★ 它放在这里而不是模板顶部：真正在乎这些变量的是**即将被启动的那个进程**，
#   而在它之前的一切（scontrol、openssl、base64）都与它们无关。放在起服务之前，
#   读代码的人不需要跳到一个与 code-server 隔着四百行的位置去找它。
_code_server_scrub_env() {
    unset CODE_SERVER_SESSION_SOCKET VSCODE_IPC_HOOK_CLI VSCODE_CWD \
          ELECTRON_RUN_AS_NODE VSCODE_NLS_CONFIG VSCODE_PROXY_URI \
          VSCODE_ESM_ENTRYPOINT VSCODE_HANDLES_SIGPIPE VSCODE_HANDLES_UNCAUGHT_ERRORS \
          VSCODE_RECONNECTION_GRACE_TIME BROWSER 2>/dev/null || true
}

start_code_server() {
    local p="$1"
    # 兜底值只是"这个变量不该为空"的防御。真正的值由守护进程按站点的
    # [plugin:code-server] bin 解析后传下来，那份解析在 --check 里逐条打印。
    local bin="${SLURMATE_CS_BIN:-/usr/local/bin/code-server}"

    _code_server_scrub_env

    # ★ code-server 的 stdout/stderr 落到**它自己的**文件，不是 $LOCAL_LOG ——
    #   两个理由，都是硬理由：
    #     1. 宿主按"LOCAL_LOG 的行号"决定哪些行还没进 NFS（见宿主里 log() 上方
    #        那段）。服务进程往 LOCAL_LOG 里插话会让那个水位**穿过去**，于是那些
    #        行永远进不了 NFS —— 而且没有任何地方会报错。
    #     2. 并进 NFS 的那一步必须在 `cleanup_code_server` 里、且要在宿主的
    #        最后一行**之后**（宿主那一段补写的注释解释了为什么）。
    #   sshd 插件用的是同一个形状（它的 `-E` 日志）。
    _cs_log="$LOCAL_LOG_DIR/code-server.log"

    log "尝试在 ${NODE_IP}:${p} 启动 code-server (auth=${AUTH_MODE})"
    nohup "$bin" \
        --bind-addr "${NODE_IP}:${p}" \
        --auth "$AUTH_MODE" \
        --disable-telemetry \
        --disable-update-check \
        --user-data-dir "$HOME/.local/share/code-server" \
        --extensions-dir "$HOME/.local/share/code-server/extensions" \
        >> "$_cs_log" 2>&1 &
    SVC_PID=$!

    # 就绪判定：优先 /healthz 返回 2xx；若将来 code-server 版本改了这个端点，
    # 退而求其次 —— 只要能拿到任何 HTTP 响应就说明 HTTP 服务起来了，
    # 再给 5 秒让 IDE 资源就绪。避免"端点改名导致会话永远起不来"。
    #
    # ★ /healthz 是**这个插件**的端点，不是框架的。所以它住在这里，不在宿主里。
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
    log "code-server 日志尾部: $(tail -n 5 "$_cs_log" 2>/dev/null | tr '\n' '|')"
    kill -TERM "$SVC_PID" 2>/dev/null; sleep 1
    kill -KILL "$SVC_PID" 2>/dev/null
    SVC_PID=""
    return 1
}

# 把 code-server 自己的输出并进作业日志。宿主在 `log "清理完成"` **之后**、
# **NFS 补写之前**调它 —— 那两个条件缺一不可，宿主那一段的注释解释了原因。
cleanup_code_server() {
    if [[ -n "${_cs_log:-}" && -f "${_cs_log:-}" ]]; then
        # 只取尾部：IDE 的日志很吵（几十万行是常态），全量并进去会让补写撑爆
        # KillWait 窗口，而超时的后果是墓碑写不下去。
        tail -n 200 "$_cs_log" >> "$LOCAL_LOG" 2>/dev/null || true
    fi
    return 0
}
