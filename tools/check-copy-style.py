#!/usr/bin/env python3
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

"""源码里的中文：不用记号做强调。

体例见 `CONTRIBUTING.md`〈写得短〉与〈界面与命令行文案〉。

判据三条，都是机械的：

    J   注释里不许出现 `★` `⚠` `⇒`，也不许有成对的加粗。强调靠位置和措辞，
        不靠记号。反引号跨度豁免：那是在引用这个字符本身，不是在喊话。

        行尾注释也算：`const x = 1;  // ★ 必须在 goodbye 之前停。` 是一句
        注释。`#` 只在行首或空白之后才算（shell 的 `${f#start_}` 不是）。

        多行跨度整片算：Python 的三引号（docstring）、JS/CSS 的块注释、
        HTML 的 `<!-- -->`。这几处的正文行首既不是 `#` 也不是 `//`，
        按行扫会整片漏掉。

        成对加粗按**连续的一段注释**配，不按行配：一句话折成两行时，
        那对星号照样成对（`**滚动升级期间还在跑的\n旧作业**`）。按行配的话
        这一整类看不见 —— 曾经就是这样，全仓库漏了近三百处。

    J2  字符串里的 `**` `★` `⚠` `⇒` `——` 一个都不许有。这些字符串走
        `textContent` 或终端，会被原样画出来，看见的是字面的星号。
        这一条不豁免任何东西。

        跨行的也算：JS 的模板串、shell 的 here-doc 与跨行双引号串。
        `packer/slurmate-packer.js --help` 那一段就是模板串，里面有六处加粗。

    K   单条中文字符串不超过 60 字；HTML 里动作控件的文字不超过 6 字。
        界面文字要短，读者才会去看。

        `<label>` 是字段名不是动作，不受那 6 字管，只归上面那 60 字。
        一开始定的是 4 字，拿仓库里真实的 24 条控件去撞才发现它太紧：
        「记住新配置并启动」这类压到 4 字只能靠丢掉「记住」，而丢掉它两颗
        按钮就分不出差别了。6 字是中文动作按钮的常见上限，也远在 KDE HIG
        那条「不要超过 `Configure Keyboard Shortcuts`」（25 字符）之内。

加粗与破折号的密度只报告、不判红（`--report`）。密度会随删字而上升，
拿它当棘轮会逼人删得越多越难过 —— 棘轮一律按绝对条数。

迁移期的棘轮在 `tools/copy-style-baseline.json`，现在它是空的：95 份源码
一处记号都不许有。机制留着，是因为它还会被用上。哪天要清另一类文本，
可以先记账再逐份清。

  · 数字上升就是红：有人在已经清过的位置上又加了一个。
  · 某一份清干净了，把那个键删掉。键不见了而文件里还有，也是红。
  · 基线里留着一份已经不存在的文件，同样是红。留着它就是留一层遮罩。
  · 不在基线里的文件 = 零容忍。新写的代码没有旧账可还。

不判的三类，每一类都打印出来。不打印的话，"不判"与"没在看"分不开：

  · 测试文件的字符串（用例名与断言消息本轮不动）。注释照判。
  · `tools/check-*.py` 与 `tools/self-test-*`（样本里写着故意违规的字面量）。
  · `tools/conformance/tree/**`（字节被 `expected.json` 钉住，改一个字节三端一起红）。

按哪种语言判，先看扩展名；`cluster/slurmate` 与 `cluster/slurmate-sessiond`
没有扩展名，按 shebang 认成 Python。这两个是命令行入口，用户看得见它们打印的
每一个字 —— 按扩展名过滤会把它们整份漏掉，"不判"与"没在看"在那里同形。

已知的粗处：不解析语法树，字符串靠正则认。

  · 注释按行判：行首的 `#` 与 `//`，块注释的续行 `* 这一行`，代码后面的
    行尾注释，再加上多行跨度里的行（三引号、块注释、HTML 注释）。
  · 引号靠逐字扫配，不解析语法：`X="$(cmd "$Y")"` 这类嵌套要一层层跟着走
    （见 `sh_spans`）。收敛不了的整段不算 —— 宁可欠判，不误判。
  · `.py` 里赋值形式的三引号（`SCHEMA_SQL = \"\"\"…\"\"\"`）只挖不判：那是喂给
    别的程序的数据，不是画给人看的文字。行首那种（docstring）按文档判。
  · `.html` 的文字整份看，不按行 —— 一个标签可以跨两行。`<script>` 与 `<style>`
    的内容先剥掉，那不算界面文字。

这些地方宁可欠判，不误判。假红会让一条检查被绕过。

用法：
    python3 tools/check-copy-style.py                # 扫整个仓库
    python3 tools/check-copy-style.py --report       # 另打印密度
    python3 tools/check-copy-style.py --baseline     # 重新生成基线（要人看 diff）
    python3 tools/check-copy-style.py --self-test    # 种坏样本，断言它真的会红
"""

import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BASELINE_PATH = os.path.join(HERE, "copy-style-baseline.json")

EXT = (".js", ".mjs", ".cjs", ".py", ".sh", ".sbatch", ".html", ".css")
# 没有扩展名的按 shebang 认。`LICENSE` 与 `NOTICE` 首行不是 shebang，于是不判。
SHEBANG_PY = re.compile(r"^#!.*\bpython[0-9.]*\b")

# 不判的：夹具（字节被钉住）与检查器自己（样本里是故意违规的字面量）。
SKIP_PREFIX = ("tools/conformance/tree/",)
SKIP_NAME = re.compile(r"^(check-.*\.py|self-test-.*\.sh)$")

MARK = re.compile(r"[★⚠⇒]")
BOLD = re.compile(r"\*\*[^*\n]+\*\*")
# 一段注释里的成对加粗。**认内容，不按位置两两配**：注释里本来就有落单的 `**`
#   （`client/**`、`**kwargs`、`2 ** 8`），按位置配的话它们会把后面每一对都错开
#   一位，于是删掉的是「这一对的闭」加「下一对的开」，剩下的半截又自己配上。
#   第一条剥离脚本就是这么栽的。
#   内容不以空白开头、不以空白结尾、中间没有星号 —— 这是加粗的形状，也是
#   那几个落单写法都不满足的形状。
BOLD_SPAN = re.compile(r"\*\*[^\s*](?:[^*]*[^\s*])?\*\*")
DASH = "——"
HAN = re.compile(r"[一-鿿]")

# 注释：整行都算。按行首判，不认代码里的 `//`（那可能是 URL）。
LINE_COMMENT = {
    ".js": ("//",), ".mjs": ("//",), ".cjs": ("//",),
    ".py": ("#",), ".sh": ("#",), ".sbatch": ("#",),
    ".html": ("<!--",), ".css": ("/*",),
}
# 块注释的续行（`* 这一行`）。Python 与 shell 没有这种写法。
STAR_CONT = (".js", ".mjs", ".cjs", ".css", ".html")

# 多行跨度：开记号与闭记号。落在这里面的行，行首没有任何注释标记，
# 按行扫会整片漏掉。`.py` 有两种三引号，`.js`/`.css` 的块注释是一种，
# `.html` 的注释也是一种 —— 少了 `.html` 这一项，整份 `panel.html` 的文件头
# 会从视野里过去（那份文件里的注释全部写在这个形状上）。
BLOCK = {
    ".py": (('"""', '"""'), ("'''", "'''")),
    ".js": (("/*", "*/"),), ".mjs": (("/*", "*/"),),
    ".cjs": (("/*", "*/"),), ".css": (("/*", "*/"),),
    ".html": (("<!--", "-->"),),
}

# 代码行上的字符串。跨行的那几种由 `string_spans` 收，见下。
QUOTED = re.compile(r"'[^'\n]*'|\"[^\"\n]*\"|`[^`\n]*`")
# shell 的 here-doc 开头：`<<EOF`、`<<-EOF`、`<<'EOF'`、`<<"EOF"`。
# 要求它一直占到行尾（后面只许有空白），免得把 `<<<` 这类认进来。
HERE = re.compile(r"<<-?[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*$", re.M)
# 反引号跨度（注释里的字面量）。
BACKTICK = re.compile(r"`[^`]*`")

# HTML 要整份看，不能按行看：一个标签可以跨两行（`hover.html` 那颗「更多」
# 就是这样），按行扫会让它从缝里漏掉。
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
HTML_SCRIPT = re.compile(r"<(script|style)\b.*?</\1>", re.S | re.I)
HTML_TEXT = re.compile(r">([^<>]+)<")
HTML_CONTROL = re.compile(
    r"<(?:button|summary|a)\b[^>]*>(.*?)</(?:button|summary|a)>",
    re.S | re.I)
HTML_ATTR = re.compile(r'\b(?:title|placeholder|aria-label)\s*=\s*"([^"]*)"', re.I)

STRING_MAX_HAN = 60
BUTTON_MAX_HAN = 6


def ext_of(rel, text):
    """这份文件按哪种语言判。认不出来的返回空串，等于不判。"""
    ext = os.path.splitext(rel)[1]
    if ext:
        return ext
    if SHEBANG_PY.match(text):
        return ".py"
    return ""


# 内嵌自测的工具：`case("★ …")` 里的那些是用例名，与测试文件同一条规矩。
# 名单是显式的，而且会打印出来 —— 悄悄跳过一份，绿就与「没在看」同形。
TEST_LIKE = ("cluster/nft-compare.py",)


def is_test_file(rel):
    """用例名与断言消息本轮不动，所以测试文件的字符串不判。"""
    base = os.path.basename(rel)
    return (rel in TEST_LIKE or "/test/" in rel or base.startswith("test-")
            or ".test." in base or base.endswith(".test.mjs"))


def split_line(line, ext):
    """这一行是注释还是代码。返回 `(kind, 去掉注释标记之后的正文)`。

    行尾注释也算：`const x = 1;  // ★ 必须在 goodbye 之前停。` 是一句注释
    （`client/src/main/session.js` 里就是这么写的），只认行首会把整类漏掉。

    找标记之前先把这一行里的单行字符串挖空，于是 `'http://x'` 里的 `//` 不算
    注释。`#` 还要在前一个字符是空白或行首时才算 —— shell 的 `${f#start_}`、
    `${#arr[@]}` 里那个 `#` 前面是名字或 `{`，它不是注释。
    """
    s = line.lstrip()
    if not s:
        return "blank", ""
    for m in LINE_COMMENT.get(ext, ()):
        if s.startswith(m):
            return "comment", s[len(m):]
    if ext in STAR_CONT and s.startswith("*"):
        return "comment", s[1:]
    bare = QUOTED.sub(lambda x: " " * len(x.group(0)), line)
    for m in LINE_COMMENT.get(ext, ()):
        k = bare.find(m)
        while k >= 0 and m == "#" and k and not bare[k - 1].isspace():
            k = bare.find(m, k + 1)
        if k >= 0:
            return "comment", line[k + len(m):]
    return "code", line


def block_lines(text, ext):
    """多行跨度里的行：`{行号: 正文}`，正文是整行，行首缩进已经剥掉。

    只做朴素配对：开记号必须在行首（前导空白之后），闭记号出现在行内任意处。
    不认转义，也不避开字符串里写的记号 —— 误判的代价只是多看几行代码，而代码
    行里本来就不该有记号。「不判」与「没在看」同形才是要躲的那件事。

    行首之外的三引号（赋值那种，形如 `名字 = \"\"\"`）不认：那是数据，不是
    文档。这一段欠判，是明知故犯。
    """
    pairs = BLOCK.get(ext, ())
    if not pairs:
        return {}
    out, closing = {}, None
    for i, line in enumerate(text.splitlines()):
        s = line.lstrip()
        if closing is None:
            for op, cl in pairs:
                if s.startswith(op):
                    closing = cl
                    s = s[len(op):]
                    break
            else:
                continue
        if closing in s:
            s = s.split(closing, 1)[0]
            closing = None
        out[i] = s
    return out


# ── 跨行的字符串 ─────────────────────────────────────────────────────────────
#
# 按行扫看不见它们，而它们照样会被 `textContent` 或终端原样画出来：
# JS 的模板串、shell 的 here-doc 与跨行双引号串、Python 里赋值形式的三引号。
# `packer/slurmate-packer.js` 的 `--help` 就是这么写的，里面有六处加粗。


def js_spans(text):
    """JS 家族里的字符串跨度。注释与字符串同一个扫描 —— 分成两遍的话，
    JSDoc 里那对 ``` 围栏会被当成模板串，字符串里写的反引号也会。"""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == "/" and text[i + 1:i + 2] == "/":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and text[i + 1:i + 2] == "*":
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "'\"`":
            j, closed = i + 1, False
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == c:
                    j, closed = j + 1, True
                    break
                if text[j] == "\n" and c != "`":
                    break
                j += 1
            if closed:
                out.append((i, j))
            i = max(j, i + 1)
            continue
        i += 1
    return out


def sh_spans(text):
    """shell 里会被原样打出来的跨行串：here-doc 的体，与跨行的双引号串。

    引号要一层一层跟着走。`READONLY_PATHS="$(sed -nE '…' "$SRC_CONF" …)"` 里
    那对引号属于 `$( )` 里面那一层，朴素的「找一个 `"` 再找一个 `"`」会把它们
    当成本层的开合，于是从那以后整份文件的引号奇偶都反了 —— 后果不是漏判一处，
    是**把后面真正的串当成代码**，判据从那一段起整片闭嘴。所以这里有栈。

    单引号串按 shell 的规矩整段照字面。收敛不了的一律不算 —— 宁可欠判，不误判。
    """
    out, i, n, stack = [], 0, len(text), []      # 每层 (种类, 起点)

    def eol(k):
        j = text.find("\n", k)
        return n if j < 0 else j

    while i < n:
        c = text[i]
        top = stack[-1][0] if stack else None
        if c == "\\":
            i += 2
            continue
        if top == "dq":
            if c == '"':
                _, a = stack.pop()
                if "\n" in text[a:i + 1]:
                    out.append((a, i + 1))
                i += 1
                continue
            if text[i:i + 2] == "$(":
                stack.append(("cmd", i))
                i += 2
                continue
            if c == "`":
                stack.append(("sub", i))
            i += 1
            continue
        if c == "'":
            j = text.find("'", i + 1)
            i = n if j < 0 else j + 1
            continue
        if c == '"':
            stack.append(("dq", i))
            i += 1
            continue
        if text[i:i + 2] == "$(":
            stack.append(("cmd", i))
            i += 2
            continue
        if text[i:i + 2] == "${":
            stack.append(("brace", i))
            i += 2
            continue
        if c == "`":
            stack.append(("sub", i))
            i += 1
            continue
        if c == ")" and top == "cmd":
            stack.pop()
            i += 1
            continue
        if c == "}" and top == "brace":
            stack.pop()
            i += 1
            continue
        if not stack and c == "(":
            stack.append(("cmd", i))
            i += 1
            continue
        if not stack and c == "#" and (i == 0 or text[i - 1] in " \t\n;&|("):
            i = eol(i)
            continue
        if not stack and text[i:i + 2] == "<<":
            m = HERE.match(text, i)
            # 只收**没被重定向进文件**的 here-doc：`cat <<EOF` 打在终端上，
            #   `cat > "$cfg" <<EOF` 写进的是配置文件。判据管的是会被画出来的
            #   文字，配置文件不是（`plugins/sshd/job/start.sh` 那份就是后者）。
            if m and ">" not in text[text.rfind("\n", 0, i) + 1:eol(m.end())]:
                word, start = m.group(2), eol(m.end()) + 1
                j = start
                while j <= n:
                    e = eol(j)
                    if text[j:e].strip() == word:
                        out.append((start, j))
                        i = e
                        break
                    j = e + 1
                else:
                    i = m.end()
                continue
        i += 1
    return sorted(set(out))


def py_spans(text):
    """`x = \"\"\"…\"\"\"` 这种赋值形式的三引号串（行首之外的）。

    它不是画给人看的文字，所以不进 `take_string`；但它必须被挖掉。
    它的闭记号落在行首，而 `block_lines` 会把行首的三引号读成**开**记号 ——
    于是从那个闭记号到下一个三引号之间的正文整片从判据里消失。
    `cluster/test-sessiond-logic.py` 栽的就是这个：一行 `\"\"\")` 把 300 行之后
    的一段 docstring 遮住了，而那一段里有五处记号。
    """
    out = []
    for m in re.finditer(r"'{3}(?:[^'\\]|\\.|'(?!'{2}))*'{3}"
                         r'|"{3}(?:[^"\\]|\\.|"(?!"{2}))*"{3}', text, re.S):
        line = text.rfind("\n", 0, m.start()) + 1
        if text[line:m.start()].strip():
            out.append((m.start(), m.end()))
    return out


def mask_spans(text, ext):
    """按行扫之前要先挖空的跨度：跨行字符串，加上 `.py` 的赋值形式三引号。

    只挖跨行的。单行的那些 `QUOTED` 本来就收得到，挖掉反而会把它们从
    `take_string` 手里抢走（自测里那三条 `strm`/`long` 的坏样本就是这么发现的）。
    """
    if ext in (".js", ".mjs", ".cjs"):
        spans = js_spans(text)
    elif ext in (".sh", ".sbatch"):
        spans = sh_spans(text)
    elif ext == ".py":
        spans = py_spans(text)
    else:
        return []
    return [s for s in spans if "\n" in text[s[0]:s[1]]]


def string_spans(text, ext):
    """会被画出来的**跨行**字符串跨度，只收含中文的那些。

    与 `mask_spans` 的差别只在 `.py`：那边多收赋值形式的三引号（要挖，但不判）。

    单行的那些由 `QUOTED` 按行收，不必在这里重复。含中文这一条与
    `take_string` 同一条：判据判的是中文措辞，不含中文的串本来就跳过。
    它顺带挡掉了引号误配 —— shell 里 `X="$(cmd "$Y")"` 这种嵌套会被朴素
    扫描配错，而配错出来的那一段多半没有中文，于是自然掉出去。
    """
    if ext == ".py":
        return []
    return [s for s in mask_spans(text, ext)
            if "\n" in text[s[0]:s[1]] and HAN.search(text[s[0]:s[1]])]


def blank_spans(text, spans):
    """把跨度挖成空格（保留换行），于是按行的扫描看不见它们。"""
    out = list(text)
    for a, b in spans:
        for k in range(a, b):
            if out[k] != "\n":
                out[k] = " "
    return "".join(out)


def html_strings(text):
    """HTML 里会被画出来的文字，与其中的控件文字。

    返回 `(全部文字, 控件文字)`。按钮的文字在两边都出现 —— 汉字只数一次，
    控件那一份只管长度那一条。
    """
    body = HTML_SCRIPT.sub("", HTML_COMMENT.sub("", text))
    texts = [m.group(1).strip() for m in HTML_TEXT.finditer(body)]
    texts += [m.group(1) for m in HTML_ATTR.finditer(body)]
    controls = [m.group(1) for m in HTML_CONTROL.finditer(body)]
    return texts, controls


def take_string(c, s, limit=True):
    """一条会被画出来的字符串，记进 `c`。没有中文的不算。

    `limit` 只对单行串开。跨行的那些是整段文字（`--help` 的用法表、安装器的
    整条报错），它们本来就该长 —— 「界面文字要短，读者才会去看」那条理由
    在那里不成立。跨行串仍旧受 J2 管（记号与破折号一个都不许有）。
    """
    n = len(HAN.findall(s))
    if not n:
        return
    c["han"] += n
    c["dash"] += s.count(DASH)
    # 加粗要成对才算，而且按内容认：`client/**` 这种 glob 里的星号不是记号，
    #   一行里写两个 glob 也不该凑成一对。
    if MARK.search(s) or BOLD_SPAN.search(s) or DASH in s:
        c["strm"] += 1
    if limit and n > STRING_MAX_HAN:
        c["long"] += 1


def counts_of(rel, text):
    """一份文件里的四项条数，外加用于报告的汉字数。

    `star`  J：注释里的记号（`★` `⚠` `⇒` 与成对加粗）。
    `strm`  J2：字符串里的记号。
    `long`  K：超过 60 汉字的字符串。
    `btn`   K：超过 6 汉字的控件文字（只有 `.html` 数得出来）。
    """
    ext = ext_of(rel, text)
    test = is_test_file(rel)
    c = {"star": 0, "strm": 0, "long": 0, "btn": 0,
         "han": 0, "bold": 0, "dash": 0}
    if not ext:
        return c

    # 跨行的字符串先挖空：它们里面的行按行看与代码无异，会被整片漏掉。
    spans = string_spans(text, ext)
    masked = blank_spans(text, mask_spans(text, ext))

    # ── 注释：按行，行尾注释也算（见 split_line）。
    # 多行跨度里的行优先 —— docstring 与块注释的正文，split_line 认不出来。 ──
    block = block_lines(masked, ext)
    runs, cur = [], []
    for i, line in enumerate(masked.splitlines()):
        if i in block:
            body = block[i]
            # 块注释的续行以 `*` 开头（`* 这一行`）。那个星号是标记不是正文：
            #   留着的话，一句话折成两行时中间会多出一个星号，成对的加粗就配不上
            #   了（`plugins/sshd/client/sshconfig.js` 那四对就是这么漏的）。
            if ext in STAR_CONT and body.lstrip().startswith("*"):
                k = len(body) - len(body.lstrip())
                body = body[:k] + " " + body[k + 1:]
        else:
            kind, body = split_line(line, ext)
            if kind != "comment":
                if cur:
                    runs.append(cur)
                    cur = []
                continue
        # 反引号跨度是字面量，不算喊话。正文原样留着给加粗那一步 ——
        #   挖成空格的话，内容里带代码跨度的加粗会以空格收尾，就配不上了。
        prose = BACKTICK.sub(lambda x: " " * len(x.group(0)), body)
        c["star"] += len(MARK.findall(prose))
        c["dash"] += prose.count(DASH)
        c["han"] += len(HAN.findall(prose))
        if cur and (i != cur[-1][0] + 1 or not body.strip()):
            runs.append(cur)
            cur = []
        if not body.strip():
            continue
        cur.append((i, body))
    if cur:
        runs.append(cur)

    # 成对加粗按**连续的一段注释**找，不按行找：注释里一句话可以折成两行，
    #   而那对星号照样成对（`fake-job.js` 的 `**站点自己的\n账**`、
    #   `app.css` 的 `**同一个\n数**`）。按行找的话它们一个都看不见。
    #   落单的 `**`（glob、`**kwargs`）不算加粗，也不单独报 —— 那个写法在注释里
    #   是正常的，报出来是假红。
    for run in runs:
        joined = "\n".join(b for _, b in run)
        # 反引号跨度里的星号是字面量（`client/**`）。判的是**位置**，不挖空格：
        #   挖了的话，`**必须 `goodbye` 之前停**` 这种会以空格收尾，配不上。
        code = [(x.start(), x.end()) for x in BACKTICK.finditer(joined)]

        def quoted(k):
            return any(s <= k < e for s, e in code)

        for mm in BOLD_SPAN.finditer(joined):
            a, b = mm.start(), mm.end() - 2
            if quoted(a) or quoted(a + 1) or quoted(b) or quoted(b + 1):
                continue
            c["bold"] += 1
    # 加粗与记号同属 J：棘轮按 `star` 一条计（`bold` 另留给 `--report` 的密度）。
    c["star"] += c["bold"]

    # ── 文字：测试文件的字符串不判（用例名与断言消息本轮不动）。 ──────
    if test:
        return c

    if ext == ".html":
        texts, controls = html_strings(text)
        for s in texts:
            take_string(c, s)
        for s in controls:
            if len(HAN.findall(s)) > BUTTON_MAX_HAN:
                c["btn"] += 1
        return c

    for line in masked.splitlines():
        if split_line(line, ext)[0] != "code":
            continue
        for m in QUOTED.finditer(line):
            take_string(c, m.group(0)[1:-1])
    for a, b in spans:
        take_string(c, text[a:b], limit=False)
    return c


def judged(rel):
    """这一份要不要判。

    判据与「怎么读盘」分开，于是自测能单独验它 —— 自测喂的是手写的小字典，
    不经过 `read_repo()`。第一版把这一条写在 `read_repo()` 里，自测当场发现
    「不判的两类」在自测里根本没生效。
    """
    return (not rel.startswith(SKIP_PREFIX)
            and not SKIP_NAME.match(os.path.basename(rel)))


def read_repo(root):
    """`{仓库相对路径: 文本}` —— 候选文件的全部。判不判由 `judged()` 定。"""
    # `--others --exclude-standard`：**未跟踪的也要扫**。少了它，一份新写的
    #   文件在 `git add` 之前是隐形的 —— 而那正是"新写的代码"最该被看住的时候。
    #   （判据在这个盲区里放过三个文件，藏在两个提交里，见账本。）
    listing = subprocess.run(["git", "ls-files", "--cached", "--others",
                              "--exclude-standard"], cwd=root,
                             capture_output=True, text=True, check=True).stdout
    files = {}
    for rel in listing.splitlines():
        if rel.startswith(SKIP_PREFIX):
            continue
        # 有扩展名的只读要判的那几种；没有扩展名的得先读进来看 shebang，
        # 所以它们绕不开这一遍读盘。全仓只有 4 份，代价可以忽略。
        if os.path.splitext(rel)[1] and not rel.endswith(EXT):
            continue
        try:
            with open(os.path.join(root, rel), encoding="utf-8") as f:
                text = f.read()
        except (OSError, UnicodeDecodeError):
            continue
        if ext_of(rel, text):
            files[rel] = text
    return files


def load_baseline():
    try:
        with open(BASELINE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


KEYS = ("star", "strm", "long", "btn")


def compare(files, base):
    """返回 `(问题清单, 各文件计数)`。判据本身不碰磁盘，于是它能被单独验。"""
    problems, seen = [], {}
    for rel in sorted(files):
        if not judged(rel):
            continue
        c = counts_of(rel, files[rel])
        seen[rel] = c
        allow = base.get(rel)
        if allow is None:
            for k in KEYS:
                if c[k]:
                    problems.append("%s：%s %d 条，而它不在基线里 —— 新写的代码"
                                    "没有旧账可还，见 `CONTRIBUTING.md`〈写得短〉"
                                    % (rel, k, c[k]))
            continue
        for k in KEYS:
            if c[k] > allow.get(k, 0):
                problems.append("%s：%s 从 %d 涨到 %d —— 棘轮只许降。"
                                "清干净了就把基线里那个键删掉"
                                % (rel, k, allow.get(k, 0), c[k]))
    for rel in sorted(base):
        if rel not in seen:
            problems.append("%s：基线里留着它，而盘上没有这份文件 —— "
                            "把它从基线里删掉，否则那是一条没人看的遮罩" % rel)
    return problems, seen


def run(root):
    files = read_repo(root)
    skipped = sorted(r for r in files if not judged(r))
    base = load_baseline()
    problems, seen = compare(files, base)

    if problems:
        for p in problems:
            print("✗ %s" % p)
        print("\n✗ %d 条。记号不是强调，位置才是 —— 见 `CONTRIBUTING.md`〈写得短〉。"
              % len(problems))
        return 1

    total = {k: sum(c[k] for c in seen.values()) for k in KEYS}
    print("✓ %d 份源码：%d 处注释记号、%d 处字符串记号、%d 条超长文字、%d 条超长控件"
          " —— 都在棘轮允许的额度内"
          % (len(files), total["star"], total["strm"], total["long"], total["btn"]))

    left = {r: c for r, c in seen.items() if r in base and any(c[k] for k in KEYS)}
    print("\n· 棘轮还没清空：%d 份挂着额度。清干净一份就把基线里那个键删掉。"
          % len(left))
    for r in sorted(left, key=lambda r: -sum(left[r][k] for k in KEYS))[:8]:
        c = left[r]
        print("    %-46s ★%4d 字符串%3d 长文%3d 控件%3d"
              % (r, c["star"], c["strm"], c["long"], c["btn"]))
    if len(left) > 8:
        print("    …另有 %d 份" % (len(left) - 8))

    # 不判的必须看得见 —— 悄悄跳过一份，绿就与「没在看」同形。
    if skipped:
        print("\n· 不判的：%d 份检查器脚本（样本里写着故意违规的字面量）：%s"
              % (len(skipped), " / ".join(skipped)))
    print("· 不判的：测试文件的字符串（用例名与断言消息本轮不动；注释照判）")
    print("· 不判的：`%s` 那一棵（字节被 `expected.json` 钉住）" % SKIP_PREFIX[0])
    return 0


def report(root):
    """密度与目标 —— 只看不判。棘轮按条数走，这里给的是进度。"""
    files = read_repo(root)
    rows = []
    for rel in sorted(files):
        if not judged(rel):
            continue
        c = counts_of(rel, files[rel])
        if c["han"] < 500:
            continue
        rows.append((c["bold"] * 1000.0 / c["han"], c["dash"] * 1000.0 / c["han"],
                     c["han"], c["bold"], c["dash"], rel))
    rows.sort(reverse=True)
    print("加粗与破折号的密度（每千汉字），只报告不判红：\n")
    print("  %-46s %6s %6s %7s" % ("文件", "加粗", "破折号", "汉字"))
    for b, d, h, nb, nd, rel in rows[:20]:
        print("  %-46s %6.1f %6.1f %7d" % (rel, b, d, h))
    tot_h = sum(r[2] for r in rows)
    tot_b = sum(r[3] for r in rows)
    tot_d = sum(r[4] for r in rows)
    print("\n  合计 %d 汉字：加粗 %.1f/千字、破折号 %.1f/千字" %
          (tot_h, 1000.0 * tot_b / tot_h, 1000.0 * tot_d / tot_h))
    print("  `CONTRIBUTING.md`〈写得短〉的目标：加粗 ≤ 5/千字、破折号 ≤ 2/千字。")
    return 0


def write_baseline(root):
    files = read_repo(root)
    base = {}
    for rel in sorted(files):
        if not judged(rel):
            continue
        c = counts_of(rel, files[rel])
        if any(c[k] for k in KEYS):
            base[rel] = {k: c[k] for k in KEYS}
    with open(BASELINE_PATH, "w", encoding="utf-8") as f:
        json.dump(base, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    print("写了 %s：%d 份文件挂着额度。" % (BASELINE_PATH, len(base)))
    print("这是今天的样子，不是目标 —— 清干净的部分要把它删掉。")
    return 0


def self_test():
    """种坏样本，断言这条检查真的会红。

    没有这一步，"检查通过"与"检查根本没在看"分不开（先例：
    `tools/self-test-sanitized.sh`）。
    """
    cases = [
        # ── J：注释里的记号 ────────────────────────────────────────────
        ("注释里的 ★", {"client/src/a.js": "// ★ 这一条踩过坑\n"}, "star"),
        ("注释里的 ⚠", {"client/src/a.js": "// ⚠ 注意\n"}, "star"),
        ("注释里的 ⇒", {"client/src/a.js": "// A ⇒ B\n"}, "star"),
        ("Python 注释里的 ★", {"cluster/a.py": "# ★ 踩过\n"}, "star"),
        ("Shell 注释里的 ★", {"cluster/a.sh": "# ★ 踩过\n"}, "star"),
        ("块注释续行里的 ★", {"client/src/a.js": "/*\n * ★ 踩过\n */\n"}, "star"),
        ("HTML 注释里的 ★", {"client/src/a.html": "<!-- ★ 踩过 -->\n"}, "star"),
        ("CSS 注释里的 ⚠", {"client/src/a.css": "/* ⚠ 注意 */\n"}, "star"),
        ("注释里的成对加粗也是记号",
         {"client/src/a.js": "// **心跳**只看这一处\n"}, "star"),
        # ── 多行跨度：行首没有任何注释标记，按行扫整片看不见 ────────────
        ("Python docstring 里的 ★（行首不是 `#`）",
         {"cluster/a.py": '"""说明。\n★ 踩过\n"""\n'}, "star"),
        ("Python docstring 首行里的 ★",
         {"cluster/a.py": '"""★ 踩过\n说明\n"""\n'}, "star"),
        ("单引号 docstring 里的 ⚠",
         {"cluster/a.py": "'''\n⚠ 注意\n'''\n"}, "star"),
        ("docstring 里的成对加粗也算",
         {"cluster/a.py": '"""\n**心跳**只看这一处\n"""\n'}, "star"),
        ("JS 块注释首行里的 ★（行首是 `/**`，不是 `//`）",
         {"client/src/a.js": "/** ★ 踩过 */\n"}, "star"),
        ("JS 块注释里不带 `*` 的续行",
         {"client/src/a.js": "/*\n★ 踩过\n*/\n"}, "star"),
        # ── J：行尾注释（`//` 与 `#` 在代码后面） ──────────────────────
        ("代码后面的 `//` 注释",
         {"client/src/a.js": "const x = 1;  // ★ 必须在 goodbye 之前停。\n"}, "star"),
        ("代码后面的 `#` 注释",
         {"cluster/a.py": "x = 1  # ★ 踩过\n"}, "star"),
        ("行尾注释里的成对加粗",
         {"client/src/a.js": "const s = [];  // 已经验过，**还没就位**的\n"}, "star"),
        # ── J：跨行的成对加粗（一句话折成两行） ────────────────────────
        ("跨行的加粗（按行配不上对）",
         {"client/src/a.js": "// 给**滚动升级期间还在跑的\n// 旧作业**用的\n"}, "star"),
        ("docstring 里跨行的加粗",
         {"cluster/a.py": '"""给**滚动升级期间还在跑的\n旧作业**用的，\n"""\n'}, "star"),
        ("JSDoc 续行那个 `*` 不挡跨行的加粗",
         {"client/src/a.js":
          "/**\n * 实测确认**悬空的 Include 不是\n * 致命错误**，ssh 会忽略它。\n */\n"},
         "star"),
        ("加粗的内容里带代码跨度也认（`**必须在 `x` 之前**`）",
         {"client/src/a.js": "// 而且**必须在 `goodbye` 之前停**。\n"}, "star"),
        ("落单的 `**` 不是加粗（注释里写 glob）",
         {"client/src/a.js": "// 只该收到 client/** 那一侧\n"}, None),
        ("`**kwargs` 也不是（注释里写着 Python 写法）",
         {"cluster/a.py": "# 参数原样走 **kwargs 传下去\n"}, None),
        # ── J2：会被画出来的跨行字符串 ─────────────────────────────────
        ("跨行的模板串",
         {"client/src/a.js": "const t = `\n★ 踩过\n`;\n"}, "strm"),
        ("打在终端上的 here-doc",
         {"cluster/a.sh": "cat <<EOF\n★ 踩过\nEOF\n"}, "strm"),
        ("跨行的双引号串",
         {"cluster/a.sh": 'die "第一行**机器**\n第二行"\n'}, "strm"),
        # ── J2 的假红防线（第五、六类漏法各自的边） ────────────────────
        ("写进文件的 here-doc 不是画给人看的",
         {"cluster/a.sh": 'cat > f <<EOF\n★ 踩过\nEOF\n'}, None),
        ("JSDoc 里那对 ``` 围栏不是模板串",
         {"client/src/a.js": "/**\n * ```\n * 中文样例\n * ```\n */\n"}, None),
        ("字符串里写的反引号不开模板串",
         {"client/src/a.js": "const s = '看 `init <目录>';\n"}, None),
        ("shell 的 `${f#start_}` 不是注释（`#` 前面是名字）",
         {"cluster/a.sh": 'v="${f#start_}"\n'}, None),
        ("赋值形式的三引号是数据，不是画出来的文字",
         {"cluster/a.py": 'X = """\n中文很长的数据\n"""\n'}, None),
        ("而它后面那段 docstring 照样判 —— 赋值那行的闭记号会被读成开记号",
         {"cluster/a.py": 'X = """\n数据\n"""\n\n\ndef f():\n    """\n    ★ 踩过\n    """\n'},
         "star"),
        # ── J 的假红防线 ───────────────────────────────────────────────
        ("行首之外的三引号不开一段（那是赋值，不是文档）",
         {"cluster/a.py": 'x = """\n这不是文档\n"""\n'}, None),
        ("字符串里写的 `/*` 不开块注释",
         {"client/src/a.js": 'const s = "/*";\n'}, None),
        ("反引号里的 ★ 是字面量（程序真的会打印它）",
         {"cluster/slurmate": "#!/usr/bin/env python3\n# 打 `★` 和 `★`。\n"}, None),
        ("代码里的 `//` 不是注释（那可能是 URL）",
         {"client/src/a.js": "const u = 'http://x/中文';\n"}, None),
        # ── 按 shebang 认语言（`cluster/slurmate` 与 `-sessiond` 没有扩展名） ──
        ("没有扩展名的 Python 脚本照判 —— 只看扩展名会把整份漏掉",
         {"cluster/a-entry": "#!/usr/bin/env python3\n# ★ 踩过\n"}, "star"),
        ("没有扩展名、首行也不是 shebang 的不判（`LICENSE` 就是）",
         {"LICENSE": "Apache License\n★ 这一段不是代码\n"}, None),
        # ── J2：字符串里的记号 ─────────────────────────────────────────
        ("字符串里的 `**`", {"client/src/a.js": "const s = '删掉一份**找不回来**';\n"},
         "strm"),
        ("字符串里的 ★", {"client/src/a.js": "throw new Error('★ 出错了');\n"}, "strm"),
        ("字符串里的 ⇒", {"client/src/a.js": "const s = '先 A ⇒ 再 B';\n"}, "strm"),
        ("字符串里的 ——", {"client/src/a.js": "const s = '作业在跑 —— 别关';\n"},
         "strm"),
        ("Python 字符串里的 ★", {"cluster/a.py": "print('★ 好了')\n"}, "strm"),
        ("HTML 控件文字里的 ★",
         {"client/src/a.html": "<button>★ 重启</button>\n"}, "strm"),
        ("HTML title 属性里的 **",
         {"client/src/a.html": '<button title="删掉**不可恢复**">x</button>\n'}, "strm"),
        # ── J2 的假红防线 ──────────────────────────────────────────────
        ("幂运算的 `**` 不是记号", {"client/src/a.js": "const n = 2 ** 8; // 位数\n"}, None),
        ("`**kwargs` 不是记号", {"cluster/a.py": "def f(**kwargs):\n    pass\n"}, None),
        ("没有中文的字符串不判", {"client/src/a.js": "const s = '**bold**';\n"}, None),
        ("`client/**` 这种 glob 不是记号（星号没成对）",
         {"client/src/a.js": "const s = '只该收到 `client/**` 这一侧';\n"}, None),
        # ── K：长度 ────────────────────────────────────────────────────
        ("超过 60 汉字的字符串", {"client/src/a.js": "const s = '%s';\n" % ("中" * 61)},
         "long"),
        ("HTML 控件文字超过 6 字",
         {"client/src/a.html": "<button>记住新配置并启动</button>\n"}, "btn"),
        ("HTML 控件文字**跨行**也算 —— 旧写法按行扫，会从缝里漏掉这一颗",
         {"client/src/a.html":
          '<button id="cl-probe" class="ghost tiny"\n'
          '        type="button">记住新配置并启动</button>\n'}, "btn"),
        # ── K 的假红防线 ───────────────────────────────────────────────
        ("60 个汉字正好在上限上",
         {"client/src/a.js": "const s = '%s';\n" % ("中" * 60)}, None),
        ("HTML 控件文字 6 个字正好",
         {"client/src/a.html": "<button>重新生成密钥</button>\n"}, None),
        ("`<label>` 是字段名，不受 6 字管",
         {"client/src/a.html": '<label for="f-host">主机（IP 或域名）</label>\n'},
         None),
        # ── 不判的三类 ─────────────────────────────────────────────────
        ("测试文件的字符串不判（用例名本轮不动）",
         {"client/test/a.test.mjs": "test('★ 写失败：返回 {ok:false}', () => {});\n"}, None),
        ("而测试文件的注释照判",
         {"client/test/a.test.mjs": "// ★ 这条注释要改\n"}, "star"),
        ("`tools/check-*.py` 整份不判", {"tools/check-a.py": "# ★ 样本\n"}, None),
        ("`tools/self-test-*.sh` 整份不判", {"tools/self-test-a.sh": "# ★ 样本\n"}, None),
    ]
    bad = []
    for why, files, expect in cases:
        got, _ = compare(files, {})
        if expect is None:
            if got:
                bad.append("假红：%s —— 报了 %r" % (why, got))
        elif not any(expect in g for g in got):
            bad.append("没抓到：%s（期望 %r，实际 %r）" % (why, expect, got))
    if bad:
        for b in bad:
            print("✗ %s" % b)
        return 1
    n_bad = sum(1 for _, _, e in cases if e is not None)
    print("✓ 反向自测通过：%d 种坏样本都被抓到，%d 种假红样本都没被误判"
          % (n_bad, len(cases) - n_bad))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=ROOT)
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--baseline", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if args.baseline:
        return write_baseline(args.root)
    if args.report:
        return report(args.root)
    return run(args.root)


if __name__ == "__main__":
    sys.exit(main())
