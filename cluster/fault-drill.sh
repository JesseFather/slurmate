#!/usr/bin/env bash
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
#
# ==========================================================================
#  fault-drill.sh —— 发布之前的故障注入演练（一次性验收）
#
#  这些路径正常使用中永远跑不到。它们的共同点是：失效时沉默 —— 所有校验
#  都返回 OK，与「校验根本没运行」无法区分。所以只能在真站点上主动扮演
#  攻击者，逐项看它撑不撑得住。
#
#  用法：
#    sudo cluster/fault-drill.sh --list
#    sudo cluster/fault-drill.sh --run nft_restart
#    sudo cluster/fault-drill.sh --all --yes
#
#  前提：一台装好的站点（root）、真的 Slurm 控制节点、一条正在跑的会话。
#  脚本不会替你建会话；没有会话时与「会话绝不能被拆」有关的几项会跳过。
# ==========================================================================
set -uo pipefail

CLI=${SLURMATE_CLI:-/usr/local/bin/slurmate}
NFT_BIN=$(command -v nft || true)
FAILED=0
RAN=0

say()  { printf '%s\n' "$*"; }
ok()   { printf '  [PASS] %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*"; FAILED=$((FAILED + 1)); }
skip() { printf '  [SKIP] %s\n' "$*"; }

need_root() {
  if [[ $(id -u) -ne 0 ]]; then
    say "这一步要 root：sudo $0 $*"
    exit 1
  fi
}

need_tools() {
  [[ -x $CLI ]] || { say "未找到 $CLI（用 SLURMATE_CLI=... 指定）"; exit 1; }
  [[ -n $NFT_BIN ]] || { say "未找到 nft"; exit 1; }
  command -v systemctl >/dev/null || { say "未找到 systemctl"; exit 1; }
}

has_session() {
  "$CLI" list 2>/dev/null | grep -q '"state": *"running"'
}

session_ids() {
  "$CLI" list 2>/dev/null | grep -o '"session_id": *[0-9]*' | grep -o '[0-9]*$'
}

nft_ok() {
  $NFT_BIN list chain inet slurmate output >/dev/null 2>&1
}

base_rule_ok() {
  $NFT_BIN list chain inet slurmate output 2>/dev/null | grep -q 'slurmate-base-lo'
}

doctor_ok() {
  "$CLI" doctor >/dev/null 2>&1
}

confirm() {
  [[ ${YES:-0} -eq 1 ]] && return 0
  read -r -p "执行「$1」？它会在真实站点上制造故障。 [y/N] " a
  [[ $a == y || $a == Y ]]
}

# ── 1. nftables 重启：表、链、基础规则要自愈 ────────────────────────────────
drill_nft_restart() {
  say "nftables 重启：表、链与基础规则必须在两个 tick 内回来"
  confirm "重启 nftables" || { skip "用户取消"; return; }
  systemctl restart nftables
  for _ in $(seq 1 30); do nft_ok && break; sleep 1; done
  nft_ok && ok "表与链回来了" || bad "表或链没有回来"
  base_rule_ok && ok "基础规则 slurmate-base-lo 在" || bad "基础规则缺失"
  doctor_ok && ok "doctor 通过" || bad "doctor 不过"
}

# ── 2. 守护进程重启：规则收敛，会话不被拆 ──────────────────────────────────
drill_sessiond_restart() {
  say "重启 slurmate-sessiond：规则收敛，已有会话不能被拆"
  local before after
  before=$(session_ids | sort | tr '\n' ' ')
  confirm "重启 slurmate-sessiond" || { skip "用户取消"; return; }
  systemctl restart slurmate-sessiond
  sleep 5
  nft_ok && ok "nft 表在" || bad "nft 表不见了"
  doctor_ok && ok "doctor 通过" || bad "doctor 不过"
  after=$(session_ids | sort | tr '\n' ' ')
  if [[ -z $before ]]; then
    skip "重启前没有会话，无法验「会话不被拆」"
  elif [[ $before == "$after" ]]; then
    ok "会话一条不少：$before"
  else
    bad "会话变了：重启前 [$before] 重启后 [$after]"
  fi
}

# ── 3. munge 停掉：会话不能被拆 ─────────────────────────────────────────────
drill_munge_stop() {
  say "停 munge 10 秒：Slurm 查询会失败，会话绝不能被拆"
  confirm "停 munge 10 秒" || { skip "用户取消"; return; }
  systemctl stop munge
  sleep 10
  nft_ok && ok "nft 表还在" || bad "nft 表被拆了"
  has_session && ok "会话还在跑" || skip "没有会话可看（或已被拆）"
  systemctl start munge
  sleep 2
  systemctl is-active --quiet munge && ok "munge 回来了" || bad "munge 没有起来"
}

# ── 4. slurmctld 重启：同上 ────────────────────────────────────────────────
drill_slurmctld_restart() {
  say "重启 slurmctld：会话绝不能被拆"
  confirm "重启 slurmctld" || { skip "用户取消"; return; }
  systemctl restart slurmctld
  sleep 5
  has_session && ok "会话还在跑" || skip "没有会话可看（或已被拆）"
  doctor_ok && ok "doctor 通过" || bad "doctor 不过"
}

# ── 5. kill -9 作业：会话要在下一次对账里释放 ──────────────────────────────
drill_kill_job() {
  say "kill -9 作业：会话必须在几个 tick 内走到终态，规则跟着删"
  local sid
  sid=$(session_ids | head -1)
  [[ -n $sid ]] || { skip "没有正在跑的会话"; return; }
  confirm "kill -9 会话 $sid 的作业" || { skip "用户取消"; return; }
  scancel --signal=KILL "$sid"
  for _ in $(seq 1 60); do
    "$CLI" list 2>/dev/null | grep -q "\"session_id\": *$sid" || break
    sleep 1
  done
  "$CLI" list 2>/dev/null | grep -q "\"session_id\": *$sid" \
    && bad "会话 $sid 仍然在列表里" || ok "会话已经走到终态"
  doctor_ok && ok "doctor 通过" || bad "doctor 不过"
}

# ── 6. 客户端断网 60 秒：进 suspect，规则不拆 ──────────────────────────────
drill_client_offline() {
  say "客户端断网 60 秒：会话应进 suspect，nft 规则一条都不拆"
  say "  这一项要第二个人在客户端上动手：关掉网络 60 秒，再恢复。"
  say "  恢复之后看：客户端状态条说「疑似断开」，会话仍列在站点上，"
  say "  而 nft 规则在断网期间一条都没少。"
  confirm "已经在客户端上断网 60 秒并恢复" || { skip "用户取消"; return; }
  doctor_ok && ok "doctor 通过" || bad "doctor 不过"
  has_session && ok "会话仍然登记着" || bad "会话不见了"
}

# ── 7. 手工删库：应从 nft comment 反向恢复 ────────────────────────────────
drill_rm_database() {
  say "手工 rm 掉 claims.db：重启后应从 nft comment 反向恢复会话归属"
  local db=/var/lib/slurmate/claims.db
  [[ -f $db ]] || db=$(find /var/lib/slurmate -name 'claims.db' 2>/dev/null | head -1)
  [[ -n $db && -f $db ]] || { skip "未找到 claims.db"; return; }
  confirm "停服务、把 $db 移到别处、再启动" || { skip "用户取消"; return; }
  systemctl stop slurmate-sessiond
  mv "$db" "$db.drill-bak"
  systemctl start slurmate-sessiond
  sleep 5
  has_session && ok "会话从 nft comment 恢复了" || bad "恢复不出任何会话"
  doctor_ok && ok "doctor 通过" || bad "doctor 不过"
  say "  备份留在 $db.drill-bak；确认无误后手工删掉。"
}

# ── 8. 并发两次部署：flock 必须挡住一个 ────────────────────────────────────
drill_concurrent_deploy() {
  say "并发跑两次部署：flock 必须让其中一个排队或直接拒绝"
  local installer=/usr/local/share/slurmate/deploy/install-base.sh
  [[ -x $installer ]] || { skip "未找到 $installer"; return; }
  confirm "并发跑两次 --dry-run" || { skip "用户取消"; return; }
  "$installer" --dry-run >/tmp/drill-a.log 2>&1 &
  local a=$!
  "$installer" --dry-run >/tmp/drill-b.log 2>&1 &
  local b=$!
  wait $a; local ra=$?
  wait $b; local rb=$?
  say "  退出码：$ra / $rb（日志 /tmp/drill-a.log /tmp/drill-b.log）"
  if [[ $ra -eq 0 && $rb -eq 0 ]]; then
    ok "两次都完成了（锁是排队语义）"
  elif [[ $ra -ne 0 && $rb -ne 0 ]]; then
    bad "两次都失败了"
  else
    ok "一次成功、一次被锁挡住"
  fi
}

# ── 9. scancel 作业：会话与规则一起收 ─────────────────────────────────────
drill_scancel() {
  say "scancel 作业：会话走到终态，规则跟着删"
  local sid
  sid=$(session_ids | head -1)
  [[ -n $sid ]] || { skip "没有正在跑的会话"; return; }
  confirm "scancel 会话 $sid" || { skip "用户取消"; return; }
  scancel "$sid"
  for _ in $(seq 1 60); do
    "$CLI" list 2>/dev/null | grep -q "\"session_id\": *$sid" || break
    sleep 1
  done
  "$CLI" list 2>/dev/null | grep -q "\"session_id\": *$sid" \
    && bad "会话 $sid 仍然在列表里" || ok "会话已经走到终态"
}

DRILLS=(nft_restart sessiond_restart munge_stop slurmctld_restart kill_job
        client_offline rm_database concurrent_deploy scancel)

usage() {
  cat <<EOF
用法：
  sudo $0 --list
  sudo $0 --run <名字> [--yes]
  sudo $0 --all [--yes]

演练项：
  nft_restart         重启 nftables，表/链/基础规则自愈
  sessiond_restart    重启守护进程，规则收敛、会话不被拆
  munge_stop          停 munge 10 秒，会话不被拆
  slurmctld_restart   重启 slurmctld，会话不被拆
  kill_job            kill -9 一条作业，会话走到终态
  client_offline      客户端断网 60 秒，进 suspect、规则不拆（要人配合）
  rm_database         手工删库，从 nft comment 反向恢复
  concurrent_deploy   并发两次部署，flock 挡住一个
  scancel             scancel 一条作业，会话与规则一起收
EOF
}

main() {
  [[ $# -eq 0 ]] && { usage; exit 2; }
  local mode= run= all=0
  while [[ $# -gt 0 ]]; do
    case $1 in
      --list) mode=list ;;
      --all) all=1 ;;
      --run) shift; run=${1:-} ;;
      --yes) YES=1 ;;
      -h|--help) usage; exit 0 ;;
      *) say "不认识的参数：$1"; usage; exit 2 ;;
    esac
    shift
  done
  if [[ $mode == list ]]; then printf '%s\n' "${DRILLS[@]}"; exit 0; fi
  need_root "$@"
  need_tools
  local list=()
  if [[ $all -eq 1 ]]; then list=("${DRILLS[@]}")
  elif [[ -n $run ]]; then list=("$run")
  else usage; exit 2; fi
  for name in "${list[@]}"; do
    RAN=$((RAN + 1))
    say ""
    say "── $name ───────────────────────────────────────────────"
    if declare -F "drill_$name" >/dev/null; then
      "drill_$name"
    else
      bad "没有这一项：$name"
    fi
  done
  say ""
  say "跑了 $RAN 项，失败 $FAILED 项。"
  [[ $FAILED -eq 0 ]] || exit 1
}

main "$@"
