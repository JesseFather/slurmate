# ==============================================================================
#  sshd —— 作业侧实现：一个跑在作业里的用户态 ssh
# ==============================================================================
#
#  这是被 deploy.sh 织进**本插件那一份**作业脚本的**片段**，不是可执行脚本
#  （成品是 <prefix>/share/slurmate/jobs/<本插件的 ULID>.sbatch）。两条硬规矩
#  （不许 shebang / 不许 `#SBATCH`、函数名一律带 `_sshd` 后缀）与
#  plugins/code-server/job/start.sh 的文件头是同一份，那里解释得最细。
#
#  为什么要有这个插件：原生 VS Code Remote-SSH、codex 这类工具**要求一个 ssh
#  连接**，而用户不能直接 ssh 到计算节点。
#
#  ── 它与站点的 ssh 准入白名单是什么关系（这一点必须写清楚）────────────────
#
#  站点用 pam_access + /etc/security/access.conf 限制谁能 ssh 进计算节点。这个
#  用户态 sshd **读不到那份策略**，而且是结构性的：非 root 的 sshd 只能用
#  `UsePAM no`，PAM 栈整个不跑，`pam_access` 从不执行。
#
#  所以它不是"绕过了白名单"就完了 —— 白名单要保护的那件事是**「用户不在 Slurm
#  监管下使用计算节点」**，而这个会话**就在监管之下**，实测可证：
#    ① 会话的 cgroup 落在 job_<id>/step_batch 里（与作业同一个）；
#    ② 三重 setsid 想脱离的进程，作业一结束就被收掉，一秒都活不过去。
#  换句话说，它给的是「在 Slurm 分配里的一把 ssh」，不是「一个逃出 Slurm 的 ssh」。
#
#  ★ 因此【不要】试图让它去遵守白名单（比如打开 UsePAM）。那会让功能对**所有**
#    普通用户失效 —— 站点那份 access.conf 通常只放行 root 与管理员。
#
#  ── 爆炸半径 ───────────────────────────────────────────────────────────────
#  注入的是**公钥**（不是秘密），授的是「以你自己身份进入你自己的作业」。
#  非 root 的 sshd 根本无法切换成别的用户，所以最坏情况就是作业属主让别人用**他
#  自己的**账号 —— 那是他本来就有的权力，不产生任何新访问。
#
#  ── 与宿主的两处接口（其余全靠 $1 / $NODE_IP / $LOCAL_LOG / $LOCAL_LOG_DIR）──
#
#    precheck_sshd   起服务之前的校验。返回非 0 → 宿主写墓碑并以 24 结束作业，
#                    **不会**开始挑端口。公钥在这里查。
#    start_sshd      返回 0 时必须把 pid 写进 $SVC_PID（见宿主契约）。
#    cleanup_sshd    宿主在【NFS 补写之前】调它，把 sshd 自己的日志并进作业日志。
#    PLUGIN_SESSION_FIELDS[ssh_host_key]
#                    主机公钥。宿主负责把它转义成 JSON 写进会话文件 ——
#                    让每个插件自己拼 JSON 片段等于把转义责任推给每一个插件，
#                    而转义写错的下场是整份会话文件解析不了。
#
#  ★ `ssh_host_key` 这个**键名是跨语言契约**：守护进程按 SESSION_FILE_FIELDS
#    白名单读它，客户端的 plugins/sshd/client/sshconfig.js 把它写进 known_hosts。
#    改名字要三处一起改，而漏掉守护进程那一处的症状是"字段凭空消失、谁都不报错"。
# ==============================================================================

# 公钥形态检查。这是安全关键，不是"防御性编程"：
# authorized_keys 的语法允许【选项前缀】（command=、environment=、cert-authority…）
# 和任意多行。只接受"一行、以算法名开头、后面只有 base64"，一次性排除掉：
#   · 追加第二条（别人的）公钥
#   · 注入 authorized_keys 选项（例如把一整把 CA 拉进来）
#   · 逗号 —— 它会破坏 sbatch 的 --export 逗号分隔，把一个环境变量变成两个
# ed25519 的 blob 恒为 51 字节 → base64 恒为 68 字符且无填充，所以长度可以卡死。
# 客户端（client/src/main/keys.js）只生成 ed25519，不会误伤。
#
# ★ 守护进程提交时有**同款**的一道，这是第二道。两道都要有：守护进程那道挡的是
#   正常路径，这道挡的是手工 sbatch、以及两端版本不一致时的老作业。
_sshd_check_pubkey() {
    # 正则放进变量：`[[ x =~ a[ ]b ]]` 里那个空格会被 bash 当成**词分隔符**，
    # 于是条件表达式被劈成两半、报 "syntax error in conditional expression"。
    # 放进变量就没有解析器参与，也就不存在这个坑。
    local re='^ssh-ed25519 [A-Za-z0-9+/]{68}$'
    [[ "${1:-}" =~ $re ]]
}

# 主机密钥：存在就复用，不存在才生成。返回 0 表示 `$_sshd_host_key` 可用，
# 并把公钥写进 PLUGIN_SESSION_FIELDS。
#
# ★ 只持久化【私钥】，`.pub` 用 `ssh-keygen -y` 现推。存两份就多一处"两份数据
#   不一致"的可能，而那个症状在客户端看来是"主机密钥不匹配"，根因却埋在计算节点的
#   日志里。
_sshd_ensure_host_key() {
    local tmp pub

    if [[ -s "$_sshd_host_key" ]]; then
        # 已存在：必须是能解析的私钥。截断/被换过的密钥不能拿去启动 sshd ——
        # 那会让客户端看到"主机密钥不匹配"，而根因埋在计算节点的日志里。
        pub="$(ssh-keygen -y -f "$_sshd_host_key" 2>/dev/null)" || true
        if [[ -z "$pub" ]]; then
            log "错误：$_sshd_host_key 存在但不是可解析的私钥，拒绝启动"
            log "      （确认不是被人动过之后，删掉它可重新生成）"
            return 1
        fi
        chmod 600 "$_sshd_host_key" 2>/dev/null || true
        PLUGIN_SESSION_FIELDS[ssh_host_key]="$pub"
        return 0
    fi

    command -v ssh-keygen >/dev/null 2>&1 || {
        log "错误：计算节点上找不到 ssh-keygen（openssh-client 没装？）"
        return 1
    }
    mkdir -p "$_sshd_dir" 2>/dev/null || {
        log "错误：无法创建 $_sshd_dir"
        return 1
    }
    chmod 700 "$_sshd_dir" 2>/dev/null || true

    tmp="$_sshd_dir/.host_ed25519.tmp.$$"
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
    if ln "$tmp" "$_sshd_host_key" 2>/dev/null; then
        log "已生成本用户的主机密钥 $_sshd_host_key（本账号首次用 sshd 分支）"
    elif [[ -s "$_sshd_host_key" ]]; then
        log "主机密钥已由并发的另一个作业落定，复用它"
    else
        log "错误：无法把主机密钥落到 $_sshd_host_key（家目录只读？）"
        rm -f "$tmp" "$tmp.pub" 2>/dev/null || true
        return 1
    fi
    rm -f "$tmp" "$tmp.pub" 2>/dev/null || true
    chmod 600 "$_sshd_host_key" 2>/dev/null || true

    # 落定之后再推一次公钥。注意这里**不要**改成复用上面那份 $pub —— 上面那份是
    # 生成前推的，而 ln 的败者拿到的是【别人】的密钥，两者不是同一把。
    pub="$(ssh-keygen -y -f "$_sshd_host_key" 2>/dev/null)" || true
    if [[ -z "$pub" ]]; then
        log "错误：刚刚落定的主机密钥不可解析，拒绝启动"
        return 1
    fi
    PLUGIN_SESSION_FIELDS[ssh_host_key]="$pub"
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
_sshd_probe_banner() {
    local ip="$1" p="$2" out=""
    if exec 3<>"/dev/tcp/${ip}/${p}"; then
        IFS= read -r -t 2 out <&3 || true
        exec 3<&- 2>/dev/null || true   # 立刻关掉，否则 sshd 要干等到 LoginGraceTime
    fi
    printf '%s' "$out"
}

# 起服务之前的校验。非 0 → 宿主写墓碑并以 24 结束。
precheck_sshd() {
    if ! _sshd_check_pubkey "$SLURMATE_SSH_PUBKEY"; then
        log "错误：sshd 需要一行合法的 ssh-ed25519 公钥（由客户端随提交带上来）"
        log "      当前值：${SLURMATE_SSH_PUBKEY:-（空）}"
        return 1
    fi
    # mktemp 失败时必须**明确失败**，而不是退到某个可预测的路径上 —— 那正是模板里
    # mktemp 那段注释在防的事（同节点其他租户能抢先创建可预测的路径）。
    if [[ -z "$LOCAL_LOG_DIR" || ! -d "$LOCAL_LOG_DIR" ]]; then
        log "错误：没有可用的节点本地私有目录（mktemp 失败），sshd 无法启动"
        return 1
    fi
    return 0
}

start_sshd() {
    local p="$1" cfg authkeys i banner=""

    # 兜底值只是"这个变量不该为空"的防御；真正的值由守护进程按站点的
    # [plugin:sshd] bin 解析后传下来。
    local bin="${SLURMATE_SSHD_BIN:-/usr/sbin/sshd}"

    [[ -x "$bin" ]] || {
        log "错误：$bin 不存在或不可执行"
        return 1
    }
    # ★ 主机密钥的持久位置**必须在共享家目录**：客户端把它钉死在固定的
    #   UserKnownHostsFile 里，换了主机密钥 ssh 会判定为中间人攻击 —— 用户看到的是
    #   「昨天还能用，今天连不上」。
    _sshd_dir="$HOME/.slurmate/ssh"
    _sshd_host_key="$_sshd_dir/host_ed25519"
    _sshd_ensure_host_key || return 1

    cfg="$LOCAL_LOG_DIR/sshd_config"
    authkeys="$LOCAL_LOG_DIR/authorized_keys"
    _sshd_log="$LOCAL_LOG_DIR/sshd.log"

    printf '%s\n' "$SLURMATE_SSH_PUBKEY" > "$authkeys" 2>/dev/null || {
        log "错误：无法写 $authkeys"
        return 1
    }
    chmod 600 "$authkeys" 2>/dev/null || true

    # 用 -f 指定配置后 sshd 【不再读】/etc/ssh/sshd_config（含 sshd_config.d）。
    # 这是刻意的：站点级配置里任何一个非默认项都会让这个用户态实例的行为变得
    # 不可预测，而它必须与作业里这一份严格一致。
    cat > "$cfg" <<EOF
# 由 run.sbatch 里的 start_sshd 生成，每次作业一份。逐项理由见对应注释。
Port $p
# 与 code-server 的 --bind-addr 对齐：只听集群地址。默认是 0.0.0.0 + ::，
# 那会把端口挂到计算节点的所有接口上 —— 而 nft ACL 挂在【登录节点】的 output 链，
# 管不到"从外部直连计算节点"这条路径。
ListenAddress $NODE_IP
AddressFamily inet

HostKey $_sshd_host_key
AuthorizedKeysFile $authkeys
AllowUsers $MY_USER

# 非 root 的 sshd 不能用 PAM（pam_loginuid / pam_systemd 要写 /proc 与 /run），
# 而且我们也不想要它 —— 见本文件头那段关于白名单的说明。
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

    log "尝试在 ${NODE_IP}:${p} 启动用户态 sshd (hostkey=$_sshd_host_key)"
    log "已授权提交时带上来的公钥: $SLURMATE_SSH_PUBKEY"
    # ★ -D 是必需的，不是风格问题：不加它 sshd 会 daemon(1,0) —— fork + setsid，
    #   **父进程立刻退出**，$! 当场变成死 pid，wait 立即返回 → 作业在服务起来的
    #   同一秒就结束；心跳的存活门 kill -0 也会失败、心跳根本不会写。
    # -E 把 sshd 自己的日志落到作业本地目录：认证失败这类事实只有它知道，
    #   不落盘的话作业结束后就永远查不到了（cleanup_sshd 会把它并进 NFS 日志）。
    nohup "$bin" -D -f "$cfg" -E "$_sshd_log" >> "$LOCAL_LOG" 2>&1 &
    SVC_PID=$!

    for i in $(seq 1 20); do
        if ! kill -0 "$SVC_PID" 2>/dev/null; then
            log "sshd 在端口 $p 上提前退出（配置不合法？端口被占？）"
            log "sshd 日志尾部: $(tail -n 5 "$_sshd_log" 2>/dev/null | tr '\n' '|')"
            SVC_PID=""
            return 1
        fi
        banner="$(_sshd_probe_banner "$NODE_IP" "$p" 2>/dev/null)"
        if [[ "$banner" == SSH-2.0-* ]]; then
            log "sshd 就绪: ${NODE_IP}:${p} pid=$SVC_PID（版本行 ${banner%$'\r'}）"
            return 0
        fi
        sleep 1
    done

    log "sshd 在端口 $p 上 20 秒未就绪，放弃该端口"
    log "sshd 日志尾部: $(tail -n 5 "$_sshd_log" 2>/dev/null | tr '\n' '|')"
    kill -TERM "$SVC_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$SVC_PID" 2>/dev/null || true
    SVC_PID=""
    return 1
}

# 把 sshd 自己的日志并进作业日志。宿主在【NFS 补写之前】调它，所以这些行会被
# 一起带上去。不并的话，"认证被拒"这类只有 sshd 知道的事实在作业结束后就永远
# 消失了 —— 客户端只看到一句"认证失败"，而原因（比如 StrictModes 不满意某级目录
# 的权限）躺在计算节点上一个已经删掉的临时目录里。
cleanup_sshd() {
    if [[ -n "${_sshd_log:-}" && -f "${_sshd_log:-}" ]]; then
        tail -n 200 "$_sshd_log" >> "$LOCAL_LOG" 2>/dev/null || true
    fi
    return 0
}
