#!/bin/bash
# ==============================================================================
#  self-test-sanitized.sh — 反向验证 check-sanitized.sh 真的能抓住东西
# ==============================================================================
#
#  ── 为什么需要这个文件 ─────────────────────────────────────────────────────
#
#  一条「永远通过」的检查比没有检查更糟：它给人虚假的安心，而且没人会去查它。
#  这个项目里已经出现过好几次同一类问题 —— 比对器把两份**空快照**判成"完全一致"、
#  哈希计算的失败分支被写成永远不会走到的死代码、`(?!...)` 在 POSIX grep 里
#  静默地永不匹配。它们共同的特征是：**看起来在检查，实际什么都没查**。
#
#  所以这里做的是**种入**：把一份真的、格式合法的私钥按三种真实泄漏形态
#  种进仓库工作树，然后跑一遍检查，断言它会红。如果哪天有人为了让检查
#  通过而把规则改松，这个自检就会失败。
#
#  用法：bash tools/self-test-sanitized.sh
#  退出码：0 = 三条都被抓住，1 = 有漏网的（规则被改松了）
#
#  ⚠️ 种入的文件全部在 .selftest-tmp/ 下，退出时无条件删除（含 SIGINT/异常）。
#     它们**从不**被 git add，正常运行时也不存在。
# ==============================================================================

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

TMP_DIR="$REPO_ROOT/.selftest-tmp"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM

rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

# ── 造一份**真的**私钥 ─────────────────────────────────────────────────────
# 不用手写的假 base64：那既可能解析不了，也不能证明"真实形态会被抓住"。
# 这里用项目自己的 keys.js 生成一把结构完全合法的 OpenSSH 私钥。
PEM="$(node -e "
  const k = require('$REPO_ROOT/client/src/main/keys.js');
  process.stdout.write(k.generate().privateKeyPem);
")"

if [[ -z "$PEM" ]]; then
  echo "错误：没能生成测试用私钥（node 或 keys.js 不可用）。自检无法进行。" >&2
  exit 2
fi

BODY="$(printf '%s\n' "$PEM" | sed -n '2p')"
if [[ ${#BODY} -lt 60 ]]; then
  echo "错误：生成的私钥主体长度异常（${#BODY}），自检夹具不可信。" >&2
  exit 2
fi

# ── 形态 A：一个真的 .pem 文件（整行就是一个 PEM 头）──────────────────────
printf '%s' "$PEM" > "$TMP_DIR/leak-a.pem"

# ── 形态 B：单行字符串里塞一把（\n 转义）─────────────────────────────────
{
  echo "// 伪装成配置读取代码的泄漏"
  printf 'const KEY = "%s\\n%s\\n";\n' \
    "$(printf '%s\n' "$PEM" | sed -n '1p')" "$BODY"
} > "$TMP_DIR/leak-b.js"

# ── 形态 C：多行模板字符串里塞一把 ────────────────────────────────────────
{
  echo "// 伪装成模板字符串的泄漏"
  echo 'const KEY = `'
  printf '%s\n' "$PEM"
  echo '`;'
} > "$TMP_DIR/leak-c.js"

# ── 跑检查，断言它会红 ─────────────────────────────────────────────────────
OUT="$(bash "$REPO_ROOT/tools/check-sanitized.sh" 2>&1)"
RC=$?

fail=0
echo "── 反向验证：三种泄漏形态都应当被抓住 ──"
echo

for name in a b c; do
  # 检查的输出里会列出命中的文件名
  if printf '%s' "$OUT" | grep -q "leak-${name}\."; then
    echo "  ✓ leak-${name} 被抓住"
  else
    echo "  ✗ leak-${name} 漏了 —— 规则被改松了，或者这条形态没被覆盖"
    fail=1
  fi
done

echo
if [[ $RC -eq 0 ]]; then
  echo "  ✗ 检查整体返回成功 —— 种入了真私钥却没报错，这条检查是坏的"
  fail=1
else
  echo "  ✓ 检查整体返回失败（rc=$RC）"
fi

# ── 清掉之后，工作树必须回到干净状态 ──────────────────────────────────────
cleanup
if bash "$REPO_ROOT/tools/check-sanitized.sh" >/dev/null 2>&1; then
  echo "  ✓ 移除夹具后检查恢复通过（夹具没有污染工作树）"
else
  echo "  ✗ 移除夹具后检查仍然失败 —— 有东西被留在工作树里了"
  fail=1
fi

echo
if [[ $fail -ne 0 ]]; then
  echo "自检未通过。"
  exit 1
fi
echo "自检通过：脱敏检查确实能抓住真私钥。"
exit 0
