#!/bin/bash
# ==============================================================================
#  check-cluster.sh — Slurmate 前置环境自检（只读）
# ==============================================================================
#
#  【在部署 Slurmate 之前先跑这个】。它把守护进程与作业模板所依赖的环境事实
#  逐条查出来并打印，让你在动手之前就知道哪些条件满足、哪些不满足。
#
#  它检查的正是那些「不满足也不会报错，只会在几小时后以奇怪的方式失败」的东西：
#    - 计算节点与登录节点是否在同一网段（决定 nft 的 ip daddr 能否成立）
#    - 用户的家目录路径是否能由 uid 反查（决定会话文件能不能被读到）
#    - 用户的 Slurm association 与分区权限（决定 sbatch 能不能提交）
#    - 候选端口区间是否干净、是否与别的端口管理系统冲突
#    - NSS 是否开启枚举（决定守护进程能不能用枚举查用户 —— 答案是不能）
#
#  安全性：
#    本脚本【只读】。唯一的写操作是在 /root 下留一份 nft 规则快照和一份报告
#    文件。不修改任何系统配置、不重启服务、不碰机器上任何既有服务。
#
#  用法：
#    sudo bash check-cluster.sh
#    # 或指定快照目录
#    sudo bash check-cluster.sh /root/slurmate-probe
#    # 或指定配置文件（默认自动找 /etc/slurmate/slurmate.conf，退回仓库里的示例）
#    SLURMATE_CONF=/path/to/slurmate.conf sudo -E bash check-cluster.sh
#
#  输出：
#    报告打到 stdout（可直接全选复制）
#    nft 快照存到 <快照目录>/nft-ruleset.before
#
# ==============================================================================

set -uo pipefail

SNAP_DIR="${1:-/root/slurmate-probe-$(date +%Y%m%d-%H%M%S)}"

if [[ "$(id -u)" -ne 0 ]]; then
    echo "请以 root 运行：sudo bash $0" >&2
    exit 1
fi

mkdir -p "$SNAP_DIR" 2>/dev/null || true
chmod 700 "$SNAP_DIR" 2>/dev/null || true

# ─── 输出helper ────────────────────────────────────────────────────────────
SECTION=0
sec() {
    SECTION=$((SECTION + 1))
    echo
    echo "═══════════════════════════════════════════════════════════════"
    echo " [$SECTION] $*"
    echo "═══════════════════════════════════════════════════════════════"
}
# 结论行：PASS / FAIL / WARN / INFO
r() { printf '  [%-4s] %s\n' "$1" "$2"; }

# 安全执行：超时 + 吞掉非零退出，输出截断
run() {
    local t="${RUN_TIMEOUT:-10}"
    timeout "$t" "$@" 2>&1 || true
}

# ─── 报告头 ────────────────────────────────────────────────────────────────
echo "Slurmate 登录节点环境探测报告"
echo "生成时间: $(date -Is)"
echo "主机名:   $(hostname -f 2>/dev/null || hostname)"
echo "快照目录: $SNAP_DIR"

# ==============================================================================
sec "操作系统"
# ==============================================================================
r INFO "发行版: $(cat /etc/redhat-release 2>/dev/null || cat /etc/os-release 2>/dev/null | grep -E '^PRETTY_NAME' | cut -d= -f2- | tr -d '\"')"
r INFO "内核:   $(uname -r)"
r INFO "架构:   $(uname -m)"
VIRT="$(systemd-detect-virt 2>/dev/null | head -n1)"; VIRT="${VIRT:-unknown}"
r INFO "虚拟化: $VIRT"

# ==============================================================================
sec "SELinux（最关键：决定守护进程能否 setuid 后 sbatch / 调 nft / 读 NFS）"
# ==============================================================================
if command -v getenforce >/dev/null 2>&1; then
    ENFORCE="$(getenforce 2>/dev/null)"
    r INFO "getenforce = $ENFORCE"
    case "$ENFORCE" in
        Enforcing) r WARN "Enforcing —— 必须验证下面的 AVC 与域转换行为" ;;
        Permissive) r INFO "Permissive —— 不阻断，但会记 AVC，仍应查看" ;;
        Disabled)  r PASS "已禁用 —— SELinux 不构成风险" ;;
    esac
else
    r PASS "无 getenforce（SELinux 未安装）"
fi

echo "  --- /etc/selinux/config ---"
run grep -E '^[[:space:]]*SELINUX' /etc/selinux/config | sed 's/^/    /'

echo "  --- 本机自定义策略模块（找 slurmate / codeserver 相关）---"
if command -v semodule >/dev/null 2>&1; then
    MODS="$(run semodule -l | awk '{print $1}' | grep -iE 'slurmate|codeserver|port' || true)"
    [[ -n "$MODS" ]] && echo "$MODS" | sed 's/^/    /' || echo "    （无相关模块）"
else
    echo "    semodule 不可用"
fi

echo "  --- 最近 7 天的 AVC 拒绝（若有，说明已有组件在被拦）---"
if command -v ausearch >/dev/null 2>&1; then
    AVC="$(run ausearch -m AVC,USER_AVC -ts recent 2>/dev/null | tail -n 40 || true)"
    if [[ -n "$AVC" ]]; then echo "$AVC" | sed 's/^/    /'; else echo "    （无近期 AVC）"; fi
else
    echo "    ausearch 不可用（audit 未安装）"
fi

echo "  --- 关键相关布尔值 ---"
if command -v getsebool >/dev/null 2>&1; then
    for b in use_nfs_home_dirs nfs_export_all_rw httpd_use_nfs; do
        v="$(run getsebool "$b")"
        [[ -n "$v" ]] && echo "    $v" || echo "    $b = (不存在)"
    done
else
    echo "    getsebool 不可用（SELinux 未安装）"
fi

echo "  --- systemd 服务的默认域（自定义 unit 通常是 unconfined_service_t）---"
N_UNCONFINED="$(ps -eZ 2>/dev/null | awk '$1 ~ /unconfined_service_t/ {c++} END {print c+0}')"
if [[ "$N_UNCONFINED" -gt 0 ]]; then
    echo "    unconfined_service_t 正在使用中（$N_UNCONFINED 个进程）→ 自定义 unit 大概率不被 SELinux 拦"
else
    echo "    未见 unconfined_service_t —— 需确认自定义 unit 会落到哪个域"
fi

# ==============================================================================
sec "防火墙 / nftables 管理方式（RHEL 9 默认 firewalld，PORT-DAEMON 却依赖 nftables.service）"
# ==============================================================================
for s in firewalld nftables iptables; do
    a="$(systemctl is-active "$s" 2>/dev/null | head -n1)"; a="${a:-n/a}"
    e="$(systemctl is-enabled "$s" 2>/dev/null | head -n1)"; e="${e:-n/a}"
    r INFO "$s: active=$a enabled=$e"
done

echo "  --- nftables.service 单元是否存在 ---"
if systemctl cat nftables.service >/dev/null 2>&1; then
    r PASS "nftables.service 存在"
    echo "    --- ExecStart / ExecStop / ExecReload ---"
    systemctl cat nftables.service 2>/dev/null | grep -E '^(ExecStart|ExecStop|ExecReload|Type)' | sed 's/^/    /'
else
    r FAIL "nftables.service 不存在 —— port-daemon 的 BindsTo 依赖会失败（但它现在在跑，需查明原因）"
fi

echo "  --- /etc/nftables.conf（RHEL9 实际用的是 /etc/sysconfig/nftables.conf）---"
for f in /etc/nftables.conf /etc/sysconfig/nftables.conf; do
    if [[ -f "$f" ]]; then
        echo "    [$f]"
        run head -n 25 "$f" | sed 's/^/      /'
        if grep -qE '^[[:space:]]*flush ruleset' "$f" 2>/dev/null; then
            r WARN "$f 含 flush ruleset —— nftables 重载会清掉动态表，必须做自愈"
        else
            r PASS "$f 无 flush ruleset"
        fi
    else
        echo "    [$f 不存在]"
    fi
done
echo "  --- SELinux 运行时与配置不一致时的重启风险 ---"
run cat /proc/cmdline | tr ' ' '\n' | grep -iE 'selinux|enforcing' | sed 's/^/    cmdline: /'
echo "    （若 /etc/selinux/config 写 enforcing 而运行时是 Disabled，说明靠 cmdline 关的；"
echo "      一旦有人带默认 cmdline 重启，SELinux 会重新生效 —— 届时应能拦住本方案）"

echo "  --- firewalld 状态与后端 ---"
if command -v firewall-cmd >/dev/null 2>&1; then
    run firewall-cmd --state | sed 's/^/    /'
    run firewall-cmd --get-backends | sed 's/^/    /'
else
    echo "    firewall-cmd 不可用（未安装 firewalld）"
fi

# ==============================================================================
sec "nft 版本与能力"
# ==============================================================================
if command -v nft >/dev/null 2>&1; then
    r PASS "nft 路径: $(command -v nft)"
    r INFO "版本: $(nft --version 2>&1 | head -1)"
    # 关键：-j 的用法是把 -j 放在 list 之前。先区分"没权限"与"不支持 -j"
    if ! nft list tables >/dev/null 2>&1; then
        r WARN "无权读取 nft 规则集（需 root）—— 本次无法判定 -j 支持情况"
    elif nft -j list tables >/dev/null 2>&1; then
        r PASS "nft -j list tables 可用（JSON 对账方案可行）"
    else
        r FAIL "nft -j 不可用 —— 对账需改用文本解析"
    fi
    echo "  --- 关键规则语法预检（在独立表中试建后立即删除，不留痕）---"
    if nft add table inet slurmate_probe 2>/dev/null; then
        nft add chain inet slurmate_probe output '{ type filter hook output priority filter; policy accept; }' >/dev/null 2>&1
        RULE_ERR="$(nft add rule inet slurmate_probe output \
            ip daddr 192.0.2.11 tcp dport 55017 ct state new \
            meta skuid != 1001 meta skuid != 0 drop comment "slurmate-probe" 2>&1)"
        if [[ -z "$RULE_ERR" ]]; then
            r PASS "目标规则语法（ct state new + meta skuid != + drop）被接受"
        else
            r FAIL "目标规则语法被拒绝 —— 需要调整规则写法"
            echo "$RULE_ERR" | sed 's/^/      /'
        fi
        nft delete table inet slurmate_probe 2>/dev/null && r INFO "探测表已删除，未留痕"
    else
        r WARN "无法创建探测表（需 root），跳过语法预检"
    fi
else
    r FAIL "nft 不存在"
fi

echo "  --- 现有 nft 表清单 ---"
nft list tables 2>/dev/null | sed 's/^/    /' || echo "    （读取失败）"

echo "  --- 规则快照（供部署后非干扰比对）---"
if nft list ruleset > "$SNAP_DIR/nft-ruleset.before" 2>/dev/null; then
    r PASS "已保存: $SNAP_DIR/nft-ruleset.before ($(wc -l < "$SNAP_DIR/nft-ruleset.before") 行)"
else
    r FAIL "无法保存 nft 规则快照"
fi

# ==============================================================================
sec "现有三件套是否在运行（新系统必须与它们零耦合）"
# ==============================================================================
echo "  --- nft 表 ---"
for t in "inet codeserver" "ip port-daemon"; do
    if nft list table $t >/dev/null 2>&1; then
        n="$(nft list table $t 2>/dev/null | grep -c 'handle\|[0-9]' || echo '?')"
        r PASS "表 $t 存在"
    else
        r FAIL "表 $t 不存在（基线不完整，或本机不是登录节点）"
    fi
done

echo "  --- 文件 ---"
for f in /usr/local/bin/codeserver-nft-helper \
         /usr/local/bin/codeserver-guard \
         /usr/local/bin/my-port \
         /etc/ssh/sshd_config.d/99-codeserver-guard.conf \
         /etc/sudoers.d/codeserver-guard \
         /usr/local/sbin/user-session-cleanup; do
    if [[ -e "$f" ]]; then r PASS "$f"; else r INFO "$f 不存在"; fi
done

echo "  --- 服务 ---"
for s in port-daemon port-query codeserver-port-cleanup; do
    a="$(systemctl is-active "$s" 2>/dev/null | head -n1)"; a="${a:-n/a}"
    [[ "$a" == "active" ]] && r PASS "$s: active" || r WARN "$s: $a"
done

echo "  --- 锁目录 ---"
if [[ -d /tmp/codeserver-ports ]]; then
    r PASS "/tmp/codeserver-ports 存在，权限 $(stat -c '%a %U:%G' /tmp/codeserver-ports 2>/dev/null)"
    r INFO "当前条目数: $(ls -A /tmp/codeserver-ports 2>/dev/null | wc -l)"
else
    r INFO "/tmp/codeserver-ports 不存在"
fi

echo "  --- inet codeserver output 链现状（Slurmate 绝不能碰这个表）---"
nft list chain inet codeserver output 2>/dev/null | sed 's/^/    /' || echo "    （读取失败）"

# ==============================================================================
sec "Python（守护进程语言）"
# ==============================================================================
for p in /usr/bin/python3 /usr/bin/python3.9 /usr/bin/python3.11 /usr/bin/python3.12; do
    if [[ -x "$p" ]]; then
        r INFO "$p → $("$p" -V 2>&1)"
    fi
done
if [[ -x /usr/bin/python3 ]]; then
    PY=/usr/bin/python3
    echo "  --- 关键能力（绝对路径调用，与 systemd 一致）---"
    "$PY" - <<'PYEOF' 2>&1 | sed 's/^/    /'
import sys
print(f"    sys.version_info = {sys.version_info[:3]}")
try:
    import socket
    print(f"    socket.SO_PEERCRED = {socket.SO_PEERCRED}  (必需)")
except Exception as e:
    print(f"    socket.SO_PEERCRED 不可用: {e}  <<< 致命")
for m in ("sqlite3", "json", "subprocess", "selectors", "fcntl", "pwd", "grp", "signal"):
    try:
        __import__(m); print(f"    模块 {m}: OK")
    except Exception as e:
        print(f"    模块 {m}: 缺失 ({e})")
PYEOF
else
    r FAIL "/usr/bin/python3 不存在 —— 守护进程需要另选实现语言"
fi

# ==============================================================================
sec "systemd 版本与加固指令支持（决定单元怎么写）"
# ==============================================================================
r INFO "systemd: $(systemctl --version 2>&1 | head -n1)"
echo "  --- 关键加固指令是否被这个 systemd 接受（用 systemd-analyze verify 真校验）---"
VERIFY_UNIT="$SNAP_DIR/slurmate-verify.service"
cat > "$VERIFY_UNIT" <<'VEOF'
[Unit]
Description=slurmate directive verification
[Service]
Type=oneshot
ExecStart=/bin/true
ProtectSystem=full
ReadOnlyPaths=/shared/home
ReadWritePaths=/var/lib/slurmate-session /var/log/slurmate
PrivateTmp=yes
NoNewPrivileges=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
CapabilityBoundingSet=CAP_NET_ADMIN CAP_SETUID CAP_SETGID CAP_KILL CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE CAP_CHOWN
AmbientCapabilities=CAP_NET_ADMIN
MemoryDenyWriteExecute=yes
SystemCallFilter=@system-service
SystemCallArchitectures=native
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
PrivateDevices=yes
RuntimeDirectory=slurmate-session
StateDirectory=slurmate-session
LogsDirectory=slurmate
VEOF
# 注意：systemd-analyze verify 会连带检查它引用的所有单元，输出里混着全系统的既有告警。
# 只保留提到【本单元】的行，否则会把 slurmd.service / munge.service 的陈旧问题当成我们的。
VERIFY_OUT="$(systemd-analyze verify "$VERIFY_UNIT" 2>&1 | grep -F "$VERIFY_UNIT" || true)"
if [[ -z "$VERIFY_OUT" ]]; then
    r PASS "全部加固指令被接受 —— 计划的 systemd 单元可直接用"
elif echo "$VERIFY_OUT" | grep -qiE 'unknown (key|lvalue)|failed to parse|invalid'; then
    r FAIL "有指令不被识别 —— 需删掉后重试"
    echo "$VERIFY_OUT" | sed 's/^/      /' | head -n 15
else
    r PASS "指令均被接受（有非致命告警，见下）"
    echo "$VERIFY_OUT" | sed 's/^/      /' | head -n 10
fi

# ==============================================================================
sec "沙箱可行性实测（最关键：加固后 scontrol/scancel 还能否连通 slurmctld + munge）"
# ==============================================================================
r INFO "用一个带完整加固指令的瞬时单元跑 scontrol ping（只读，跑完自动销毁）"
SANDBOX_OUT="$SNAP_DIR/sandbox-test.txt"
if command -v systemd-run >/dev/null 2>&1; then
    timeout 30 systemd-run --wait --pipe --collect \
        --property=Type=oneshot \
        --property=ProtectSystem=full \
        --property=ReadOnlyPaths=/shared/home \
        --property=PrivateTmp=yes \
        --property=NoNewPrivileges=yes \
        --property=RestrictAddressFamilies="AF_UNIX AF_INET AF_INET6 AF_NETLINK" \
        --property=CapabilityBoundingSet="CAP_NET_ADMIN CAP_SETUID CAP_SETGID CAP_KILL CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE CAP_CHOWN" \
        --property=AmbientCapabilities=CAP_NET_ADMIN \
        --property=MemoryDenyWriteExecute=yes \
        --property=SystemCallFilter=@system-service \
        /bin/bash -c 'echo "--- scontrol ping ---"; scontrol ping; echo "rc=$?"; echo "--- munge socket ---"; ls -l /run/munge/ 2>&1; echo "--- nft list ---"; nft list tables >/dev/null && echo "nft OK" || echo "nft FAIL"' \
        > "$SANDBOX_OUT" 2>&1
    if grep -q "is UP" "$SANDBOX_OUT" 2>/dev/null; then
        r PASS "沙箱内 scontrol ping 成功 —— 加固指令可以直接用"
    elif grep -qE "Interactive authentication required|Failed to start transient service unit" "$SANDBOX_OUT" 2>/dev/null; then
        r WARN "无法创建瞬时单元（非 root 或 polkit 拒绝）—— 本项必须由 root 运行才有结论"
    elif grep -qE "Access denied|not permitted|Permission denied|No such file" "$SANDBOX_OUT" 2>/dev/null; then
        r FAIL "沙箱内 scontrol/nft 失败 —— 必须放宽加固指令，详见下方与快照"
    else
        r WARN "沙箱测试未得到明确结论，详见下方与快照"
    fi
    sed 's/^/    /' "$SANDBOX_OUT" 2>/dev/null | head -n 25
    echo "    （完整输出: $SANDBOX_OUT）"
else
    r FAIL "systemd-run 不存在，无法实测"
fi

# ==============================================================================
sec "Slurm 客户端与集群状态"
# ==============================================================================
for c in scontrol squeue sbatch scancel sacctmgr sinfo srun; do
    printf '  %-10s %s\n' "$c" "$(command -v $c 2>/dev/null || echo '缺失')"
done
echo "  --- scontrol ping ---"
run scontrol ping | sed 's/^/    /'
echo "  --- 分区与时间上限 ---"
run sinfo -h -o '%P|%l|%a|%D|%N' | sed 's/^/    /'
echo "  --- 关键配置 ---"
run scontrol show config | grep -E "^(ClusterName|AccountingStorageEnforce|KillWait|MaxJobId|MinJobAge|ProctrackType|SlurmctldHost|SlurmUser)" | sed 's/^/    /'
echo "  --- 节点地址 ---"
run scontrol show nodes -o | grep -oE 'NodeName=[^ ]+|NodeAddr=[^ ]+' | paste - - 2>/dev/null | sed 's/^/    /' | head -n 10

# ==============================================================================
sec "关联账号（sbatch 必须带 -A）"
# ==============================================================================
# 真实人类用户 = 共享存储下有家目录、且能由 uid 反查到的账号。
#
# ⚠️ 为什么不直接用 `getent passwd` 全量列表：很多集群的 NSS（SSSD/LDAP）
#    【没有开启枚举】，全量列表里只有本地账号，通过目录服务登录的用户一个
#    都不在里面；但 `getent passwd <uid>` 这种按 uid 直查是好的。
#    直接枚举会得到一份"看起来正常、实则漏掉绝大多数人"的名单 —— 而漏掉
#    这件事本身没有任何报错。
#    所以这里走"枚举家目录 → 取属主 uid → 按 uid 反查"。
#    这条路同时天然暴露了"目录名 ≠ 用户名"的大小写问题。
#    输出完整 passwd 行：uname:pw:uid:gid:gecos:home:shell（按用户名去重）
real_users() {
    local d u entry
    for d in /shared/home/*/; do
        [[ -d "$d" ]] || continue
        u="$(stat -c %u "$d" 2>/dev/null)" || continue
        [[ "$u" =~ ^[0-9]+$ ]] || continue
        (( u >= 1000 )) || continue
        entry="$(getent passwd "$u" 2>/dev/null)" || continue
        [[ -n "$entry" ]] || continue
        printf '%s\n' "$entry"
    done | sort -t: -k3 -n | awk -F: '!seen[$1]++'
}

echo "  --- SSSD 枚举能力自检（决定守护进程能怎么查用户）---"
ENUM_TOTAL="$(getent passwd 2>/dev/null | wc -l)"
ENUM_NAS="$(getent passwd 2>/dev/null | grep -c '/shared/home' || true)"
r INFO "getent passwd 全量枚举返回 $ENUM_TOTAL 条，其中家目录在 /shared/home 的 $ENUM_NAS 条"
if [[ "$ENUM_NAS" -eq 0 ]]; then
    r WARN "全量枚举不含 IPA 用户 —— 守护进程必须用 getpwnam(uid) 直查，禁止任何枚举式做法"
else
    r PASS "全量枚举可用（但仍建议用 getpwnam 直查）"
fi
r INFO "真实用户数（按家目录反查）: $(real_users | wc -l)"

echo "  --- 抽样 5 个真实用户的 association（sbatch 必须带 -A）---"
real_users | head -n 5 | while IFS=: read -r uname _ uid _ _ _ _; do
    echo "    用户 $uname (uid=$uid):"
    sacctmgr -n -P show assoc user="$uname" format=Account,Partition,QOS 2>/dev/null \
        | sed 's/^/      /' || echo "      （查询失败）"
done

echo "  --- 没有任何 association 的活跃用户（会导致提交失败）---"
NOASSOC=0
while IFS=: read -r uname _ uid _ _ _ _; do
    acct="$(sacctmgr -n -P show assoc user="$uname" format=Account 2>/dev/null | tr -d '[:space:]')"
    if [[ -z "$acct" ]]; then
        printf '    %s -> <无 association>\n' "$uname"
        NOASSOC=$((NOASSOC + 1))
        (( NOASSOC >= 5 )) && { echo "    （仅列出前 5 个）"; break; }
    fi
done < <(real_users)
[[ "$NOASSOC" -eq 0 ]] && echo "    （未发现，但新用户仍需注意）"

echo "  --- 分区精确名称（Slurm 分区名【大小写敏感】）---"
scontrol show partition -o 2>/dev/null | grep -oE 'PartitionName=[^ ]+' | sed 's/PartitionName=/    /'

echo "  --- association 里的 Partition 字段与实际分区名交叉核对 ---"
sacctmgr -n -P show assoc format=Account,Partition 2>/dev/null \
    | awk -F'|' '$2!=""{print $2}' | sort -u | while read -r ap; do
    [[ -n "$ap" ]] || continue
    if scontrol show partition "$ap" >/dev/null 2>&1; then
        printf '    [OK]       %s\n' "$ap"
    else
        printf '    [MISMATCH] association 写了 %s，但该分区不存在（多为大小写不一致）\n' "$ap"
        printf '               注意：Slurm 分区名大小写敏感，这会影响 -p 参数与权限校验\n'
    fi
done

echo "  --- 权限覆盖度（有家目录 ≠ 有 Slurm 权限）---"
N_SLURM_USER="$(sacctmgr -n -P show assoc format=User 2>/dev/null | grep -vE '^$|^root$' | sort -u | wc -l)"
N_HOME_USER="$(real_users | wc -l)"
echo "    有 Slurm user 记录的用户: $N_SLURM_USER"
echo "    有家目录的真实用户:       $N_HOME_USER"
if (( N_SLURM_USER < N_HOME_USER )); then
    r WARN "相差 $(( N_HOME_USER - N_SLURM_USER )) 个：有家目录但无法提交作业。Slurmate 必须在首次设置阶段就明确提示，而不是等到点「开始开发」才失败"
fi

# ==============================================================================
sec "家目录路径与 NFS（绝不能用拼用户名的方式构造路径）"
# ==============================================================================
echo "  --- 真实用户的家目录（前 12 个）---"
real_users | head -n 12 | awk -F: '{printf "    %-22s uid=%-6s %s\n", $1, $3, $6}'
echo "  --- 名字与家目录大小写不一致的用户（Slurmate 必须用 getpwnam）---"
MISMATCH=0
while IFS=: read -r uname _ _ _ _ uhome _; do
    base="${uhome##*/}"
    if [[ "$uname" != "$base" ]]; then
        printf '    %s -> %s\n' "$uname" "$uhome"
        MISMATCH=$((MISMATCH + 1))
    fi
done < <(real_users)
if [[ "$MISMATCH" -eq 0 ]]; then
    echo "    （本次抽样未发现，但仍必须用 getpwnam）"
else
    r WARN "发现 $MISMATCH 个不一致 —— 证实绝不能用拼用户名的方式构造路径"
fi
echo "  --- /shared/home 挂载参数（关注 actimeo / acregmin / acdirmax）---"
if findmnt -no SOURCE,TARGET,FSTYPE /shared/home >/dev/null 2>&1; then
    echo "    $(findmnt -no SOURCE,TARGET,FSTYPE /shared/home)"
    findmnt -no OPTIONS /shared/home 2>/dev/null | tr ',' '\n' | sed 's/^/      /'
    if findmnt -no OPTIONS /shared/home 2>/dev/null | grep -qE 'actimeo|acdirmax|acregmax'; then
        echo "      ↑ 已显式设置缓存参数"
    else
        r WARN "未显式设置 actimeo —— 默认 acdirmax=60s，会让会话登记最多延迟 60 秒"
    fi
else
    echo "    /shared/home 未挂载（本机可能不是登录节点）"
fi
echo "  --- 家目录权限（决定跨用户隔离强度）---"
real_users | head -n 3 | while IFS=: read -r _ _ _ _ _ uhome _; do
    stat -c '    %a %U:%G %n' "$uhome" 2>/dev/null
done
echo "  --- getent hosts 是否可靠 ---"
# 这一项要连着 NodeAddr 一起看。Debian/Ubuntu 系的 /etc/hosts 里有一条
# `127.0.1.1 <本机主机名>`，所以节点上 `getent hosts <自己的节点名>` 可能返回
# 回环地址。守护进程与作业模板都以 Slurm 的 NodeAddr 为权威，不用 DNS ——
# 这里只是把两者并排列出来，方便你确认自己的集群有没有这个坑。
for n in $(scontrol show nodes -o 2>/dev/null | grep -oE 'NodeName=[^ ]+' | cut -d= -f2 | head -n 8); do
    printf '    %-10s getent=%-16s\n' "$n" \
        "$(getent hosts "$n" 2>/dev/null | head -1 | awk '{print $1}' || echo '解析失败')"
done

# ==============================================================================
sec "端口占用：候选端口区间是否干净"
# ==============================================================================
# 区间取自 slurmate.conf 的 range_start/range_end；读不到就用默认值并说明。
_cf="${SLURMATE_CONF:-/etc/slurmate/slurmate.conf}"
if [[ ! -r "$_cf" ]]; then
    _cf="$(dirname "$0")/../cluster/slurmate.conf.example"
fi
_pmin="$(sed -nE 's/^[[:space:]]*range_start[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' "$_cf" 2>/dev/null | head -1)"
_pmax="$(sed -nE 's/^[[:space:]]*range_end[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' "$_cf" 2>/dev/null | head -1)"
_pmin="${_pmin:-55001}"; _pmax="${_pmax:-55999}"
r INFO "端口区间取自 ${_cf}：${_pmin}-${_pmax}"
echo "  --- 现有监听端口（落在该区间内的）---"
run bash -c "ss -Htlnp 2>/dev/null | awk '{print \$4}' | grep -oE '[0-9]+\$' | sort -un | awk -v a=${_pmin} -v b=${_pmax} '\$1>=a && \$1<=b'" | sed 's/^/    /'
echo "  --- 现有监听端口（55000 以上）---"
run bash -c "ss -Htlnp 2>/dev/null | awk '{print \$4}' | grep -oE '[0-9]+\$' | sort -un | awk -v a=${_pmin} '\$1>=a'" | sed 's/^/    /'
echo "  --- ip_local_reserved_ports ---"
run sysctl -n net.ipv4.ip_local_reserved_ports 2>/dev/null | sed 's/^/    /'
echo "  --- 候选区间的占用数 ---"
OCC="$(run bash -c "ss -Htln 2>/dev/null | awk '{print \$4}' | grep -oE '[0-9]+\$' | awk -v a=${_pmin} -v b=${_pmax} '\$1>=a && \$1<=b'" | wc -l)"
[[ "$OCC" -eq 0 ]] && r PASS "${_pmin}-${_pmax} 当前无监听" || r WARN "${_pmin}-${_pmax} 有 $OCC 个监听，需换区间"

# ==============================================================================
sec "登录节点地址（内网/公网自动选择要用）"
# ==============================================================================
echo "  --- 本机所有 IPv4 ---"
run bash -c "ip -4 -o addr show scope global | awk '{print \"    \"\$2\" \"\$4}'"
echo "  --- 默认路由 / 网关 ---"
run bash -c "ip route show default | sed 's/^/    /'"
echo "  --- sshd 监听地址与端口 ---"
run bash -c "ss -Htlnp 2>/dev/null | grep -E 'sshd|:10100' | sed 's/^/    /'"
echo "  --- sshd 相关配置（AllowTcpForwarding / ForceCommand / PubkeyAuthentication）---"
run bash -c "sshd -T 2>/dev/null | grep -iE '^(allowtcpforwarding|permitopen|x11forwarding|pubkeyauthentication|passwordauthentication|gatewayports|permitlisten|forcecommand|allowagentforwarding)' | sed 's/^/    /'"

# ==============================================================================
sec "code-server"
# ==============================================================================
if [[ -x /usr/local/bin/code-server ]]; then
    r PASS "/usr/local/bin/code-server 存在"
    run bash -c '/usr/local/bin/code-server --version 2>&1 | head -3' | sed 's/^/    /'
else
    r INFO "/usr/local/bin/code-server 不存在（登录节点不跑它，属正常）"
fi
echo "  --- 计算节点上的 code-server 路径 ---"
# 登录节点通常不装 code-server，所以这里查不到是正常的。
# 真正的权威值是 slurmate.conf 的 [slurm] code_server_bin，作业启动时用它。
# 若不确定，就在计算节点上 `which code-server` 确认一次，再对照配置。
_csbin="$(sed -nE 's/^[[:space:]]*code_server_bin[[:space:]]*=[[:space:]]*(.*)/\1/p' "$_cf" 2>/dev/null | head -1)"
r INFO "配置里的 code_server_bin = ${_csbin:-（未配置）}"
r INFO "请在计算节点上确认该路径存在：ls -l ${_csbin:-/usr/local/bin/code-server}"

# ==============================================================================
echo
echo "═══════════════════════════════════════════════════════════════"
echo " 探测完成"
echo "═══════════════════════════════════════════════════════════════"
echo " 快照目录: $SNAP_DIR"
echo "   - nft-ruleset.before  （部署后非干扰比对基线）"
echo "   - sandbox-test.txt    （沙箱加固可行性实测输出）"
echo
echo " 请把以上全部输出复制回传。"
echo "═══════════════════════════════════════════════════════════════"

