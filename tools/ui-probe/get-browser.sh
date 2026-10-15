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
#  get-browser.sh — 取一个无头 Chromium，给 check.mjs 量排布用
# ==============================================================================
#
#  为什么要有这个脚本：`check.mjs` 要在真的排版引擎里量"有没有东西伸出容器"，
#  而 CI 之外的本机不一定有浏览器。这一段把"去哪儿取、取哪一版、怎么验它真的
#  能跑"写死成一处，免得每次手敲一条 curl。
#
#  它与仓库其余部分的关系：
#    · 不进仓（落在 ~/.cache），因为它是 118MB 的二进制，不是源码；
#    · 不参与 npm ci：客户端的依赖只有 ssh2 与 electron，加一个会下载浏览器的
#      包等于每次装依赖都拉一次；
#    · CI 上不需要跑它，GitHub 的 runner 自带 google-chrome，`check.mjs` 找得到。
#
#  版本是钉死的。用 latest 的话，某天上游换一版、判据的结果跟着变，而"排布变了"
#  与"浏览器变了"会分不开。
#
#  断点续传是必需的，不是保险：这条线路上 118MB 的下载会被截断（工具本机实测
#  取到过 38MB、47MB、56MB 三种半截文件，都不是 zip）。`curl -C -` 接着下，
#  下一轮从断点继续，直到字节数与 Content-Length 相同。
#
#  用法：bash tools/ui-probe/get-browser.sh
#  退出码：0 = 浏览器就位且能跑；1 = 没取成
# ==============================================================================

set -uo pipefail

VERSION="148.0.7778.97"
URL="https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/linux64/chrome-headless-shell-linux64.zip"

DIR="${SLURMATE_UI_BROWSER_DIR:-$HOME/.cache/slurmate-ui}"
BIN="${DIR}/chrome-headless-shell-linux64/chrome-headless-shell"
ZIP="${DIR}/chrome-headless-shell-linux64.zip"

mkdir -p "$DIR" || { echo "建不出 ${DIR}" >&2; exit 1; }

if [[ -x "$BIN" ]] && "$BIN" --version >/dev/null 2>&1; then
    echo "已经有了：$("$BIN" --version)"
    echo "$BIN"
    exit 0
fi

WANT="$(curl -sSI "$URL" | tr -d '\r' | awk -F': *' 'tolower($1)=="content-length"{print $2}')"
if [[ -z "$WANT" ]]; then
    echo "问不到包的大小，网络或地址有问题：${URL}" >&2
    exit 1
fi
echo "包 ${WANT} 字节，目标 ${ZIP}"

# 上一轮可能留下半截文件。留着它继续下，删掉的话下一轮从头来一遍。
for i in $(seq 1 60); do
    curl -sS -C - -o "$ZIP" --max-time 240 "$URL" >/dev/null 2>&1
    GOT="$(stat -c%s "$ZIP" 2>/dev/null || echo 0)"
    printf '\r  第 %2d 轮：%s / %s 字节' "$i" "$GOT" "$WANT"
    if [[ "$GOT" == "$WANT" ]]; then
        printf '\n'
        break
    fi
    if [[ "$GOT" -gt "$WANT" ]]; then
        # 比目标还大 = 这一份不是那个包（或者上一轮写坏了）。删了重来。
        printf '\n  这一份比目标大，删掉重来\n'
        rm -f "$ZIP"
    fi
done
printf '\n'

GOT="$(stat -c%s "$ZIP" 2>/dev/null || echo 0)"
if [[ "$GOT" != "$WANT" ]]; then
    echo "下了 ${GOT} 字节，还差 $((WANT - GOT))，没取成。" >&2
    exit 1
fi

# 解包用 python3：工具机不一定有 unzip，而 cpio/tar 都读不了 zip。
python3 - "$ZIP" "$DIR" <<'PY' || exit 1
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
z.extractall(sys.argv[2])
PY

if [[ ! -x "$BIN" ]]; then
    chmod +x "$BIN" 2>/dev/null
fi

# ── 它跑得起来吗 ────────────────────────────────────────────────────────────
#
# 多数机器上这一步就过了。跑不起来时最常见的一种是缺 alsa-lib：这个浏览器
# 链着 `libasound.so.2`（125 个符号，全都带 `ALSA_0.9` 这个版本标签），而
# 无头跑一个页面根本用不到声音那一套。工具机上没有 alsa-lib，也不方便为一个
# 检查去装系统包，所以这里给它做一个替身库：符号表齐全（版本标签照原样），
# 函数体一律返回 0。
#
# 这一手是有代价的，写在明处：那个 .so 不是真的 ALSA。它够用的前提是这台浏览器
# 在无头模式下不去碰声音（探针只量排布）。哪一天它真的调进去了，症状是崩溃而不是
# 静默算错。装上真的 alsa-lib（`dnf install alsa-lib` / `apt install libasound2`）
# 之后，把 ${DIR}/lib 删掉即可 —— 那之后这一段也不会再跑（上面那个 `--version`
# 先过了）。
#
# 替身库放在 ${DIR}/lib，不在任何默认查找路径里：谁用它，谁显式指过去
#   （见 check.mjs 里给子进程拼 LD_LIBRARY_PATH 那一段）。
ALSA_LIB="${DIR}/lib/libasound.so.2"
if ! "$BIN" --version >/dev/null 2>&1; then
    if ! command -v cc >/dev/null || ! command -v nm >/dev/null || ! command -v readelf >/dev/null; then
        echo "包解开来了，但主程序无法运行，而本机没有 cc/nm/readelf 可做替身库。" >&2
        ldd "$BIN" 2>/dev/null | grep "not found" >&2
        echo "装上 alsa-lib 试一次：dnf install alsa-lib / apt install libasound2" >&2
        exit 1
    fi
    echo "主程序无法运行，做一份 alsa 替身库再试。"
    mkdir -p "${DIR}/lib"
    WORK="$(mktemp -d)"
    nm -D --undefined-only "$BIN" | tr -s ' ' | cut -d' ' -f3 \
        | grep '^snd_' | sort -u > "${WORK}/syms.txt"
    if [[ ! -s "${WORK}/syms.txt" ]]; then
        echo "这个二进制没有引用 snd_ 符号，缺的库不是 alsa。原样报出来：" >&2
        ldd "$BIN" 2>/dev/null | grep "not found" >&2
        rm -rf "$WORK"
        exit 1
    fi
    python3 - "$WORK" <<'PY' || { rm -rf "$WORK"; exit 1; }
import sys, pathlib, collections
t = pathlib.Path(sys.argv[1])
groups = collections.OrderedDict()
for line in (t / 'syms.txt').read_text().split():
    name, _, ver = line.partition('@')
    groups.setdefault(ver, []).append(name)
body = ['/* 替身 libasound：这个浏览器只用到符号表，无头模式下不发声。 */']
for names in groups.values():
    for n in names:
        body.append('long %s(void) { return 0; }' % n)
(t / 'stub.c').write_text('\n'.join(body) + '\n')
vs = []
for ver, names in groups.items():
    if not ver:
        continue
    vs.append('%s {\n  global:' % ver)
    vs.extend('    %s;' % n for n in names)
    vs.append('  local: *;\n};')
(t / 'vs.txt').write_text('\n'.join(vs) + '\n')
print("  替身库覆盖 %d 个符号，版本标签 %s"
      % (sum(len(v) for v in groups.values()), [v for v in groups if v]))
PY
    cc -shared -fPIC -O1 -Wl,--version-script="${WORK}/vs.txt" \
        -o "$ALSA_LIB" "${WORK}/stub.c" || { rm -rf "$WORK"; exit 1; }
    rm -rf "$WORK"
    if ! LD_LIBRARY_PATH="${DIR}/lib" "$BIN" --version >/dev/null 2>&1; then
        echo "替身库也救不回来，原样报出来：" >&2
        LD_LIBRARY_PATH="${DIR}/lib" ldd "$BIN" 2>/dev/null | grep "not found" >&2
        exit 1
    fi
    echo "替身库就位：${ALSA_LIB}（装上真 alsa-lib 之后删掉 ${DIR}/lib 即可）"
fi

LD_LIBRARY_PATH="${DIR}/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$BIN" --version
echo "$BIN"
