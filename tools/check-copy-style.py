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

判据五条，都是机械的：

    J   注释里不许出现 `★` `⚠` `⇒`，也不许有成对的加粗。强调靠位置和措辞，
        不靠记号。反引号跨度豁免：那是在引用这个字符本身，不是在喊话。

        行尾注释也算：`const x = 1;  // ★ 必须在 goodbye 之前停。` 是一句
        注释。`#` 只在行首或空白之后才算（shell 的 `${f#start_}` 不是）。

        多行跨度整片算：Python 的三引号（docstring）、JS/CSS 的块注释、
        HTML 的 `<!-- -->`。这几处的正文行首既不是 `#` 也不是 `//`，
        按行扫会整片漏掉。

        成对加粗按连续的一段注释配，不按行配：一句话折成两行时，
        那对星号照样成对（`滚动升级期间还在跑的\n旧作业`）。按行配的话
        这一整类看不见 —— 曾经就是这样，全仓库漏了近三百处。

    J2  字符串里的 `` `★` `⚠` `⇒` `——` 一个都不许有。这些字符串走
        `textContent` 或终端，会被原样画出来，看见的是字面的星号。
        这一条不豁免任何东西。

        跨行的也算：JS 的模板串、shell 的 here-doc 与跨行双引号串。
        `packer/slurmate-packer.js --help` 那一段就是模板串，里面有六处加粗。

        测试文件的字符串只收前三样，`——` 一条不收（见 L 那一段）。破折号不是
        记号，它禁的是「一句话套一句话」那种长句，理由与 K 那条一样，是界面
        文字的短。用例名与断言消息是描述，不是画给用户看的一句话 —— 同一份
        文件的注释里本来就到处在用破折号。

    K   单条中文字符串不超过 60 字；HTML 里动作控件的文字不超过 6 字。
        界面文字要短，读者才会去看。

        `<label>` 是字段名不是动作，不受那 6 字管，只归上面那 60 字。
        一开始定的是 4 字，拿仓库里真实的 24 条控件去撞才发现它太紧：
        「记住新配置并启动」这类压到 4 字只能靠丢掉「记住」，而丢掉它两颗
        按钮就分不出差别了。6 字是中文动作按钮的常见上限，也远在 KDE HIG
        那条「不要超过 `Configure Keyboard Shortcuts`」（25 字符）之内。

    L   用户看得见、以及钉着它的字符串里，不许出现 `tools/ui-terms.json`
        左列的那些词。

        「记录写不下去」「读不到 X」「没能保存」「与签名对不上」—— 这些说的是
        手感，读者要的是结果：写入失败、读取 X 失败、未能保存、与签名不一致。
        主语是那件事，不是拟人：一张表不会"写得下去"。

        表是封闭的，判据逐字比对，「别用」那一列以外的词一个字都不判。
        要加词就往表里加 —— 同一条规矩两份实现会漂开。

        反引号跨度豁免，与 J 同一条：`不许写成 `读不到`` 是在引用这个词，不是
        在用它做提示文字。

        测试文件的字符串也归这一条，而且整套体例都归：用例名与断言消息跟生产
        文案是同一套话。`★` 排位与成对加粗曾经在那里合法，于是那 33 份成了全仓
        唯一还能继续生产新记号的地方 —— 清一批、它长一批。

        只有 K 与 J2 里的 `——` 不管它们：那两条要的都是「一句话短」，
        用例名的长短由内容定、它的句子也由内容定，压短会把话说残。

    M   一处文档里引用的提示文字，必须逐字出现在源码里。

        `cluster/docs/PLUGIN-TROUBLESHOOTING.md` 里那几张「报错里出现」的表，
        教管理员照着屏幕上的字样去对原因。字样与代码对不上，那张表就是一句
        没人守的承诺 —— 而改一批提示文字正是会让它悄悄失准的动作。

        口径：表行第一列里每个 `「…」`，必须逐字出现在某个源码文件里。
        带变量的地方，要么把变量写在「」外面，要么在「」里用 `…` 标出来；
        带 `…` 的那一段不判 —— 那个省略号是明写的"这里有变量"。
        第二列与第三列里的 `「」` 是行文，不是字样，不判。

加粗与破折号的密度只报告、不判红（`--report`）。密度会随删字而上升，
拿它当棘轮会逼人删得越多越难过 —— 棘轮一律按绝对条数。

迁移期的棘轮在 `tools/copy-style-baseline.json`，现在它是空的：95 份源码
一处记号都不许有。机制留着，是因为它还会被用上。哪天要清另一类文本，
可以先记账再逐份清。

  · 数字上升就是红：有人在已经清过的位置上又加了一个。
  · 某一份清干净了，把那个键删掉。键不见了而文件里还有，也是红。
  · 基线里留着一份已经不存在的文件，同样是红。留着它就是留一层遮罩。
  · 不在基线里的文件 = 零容忍。新写的代码没有旧账可还。

`.yml` / `.yaml` / `.json` 整份按注释判，只判记号与成对加粗（见 `star_only`）。
这两类里的中文是 YAML 的注释与数据字段的值，没有「会被画出来的一句话」，所以
K 与 L 在那里不判。判记号是因为那几个字符在这两类文件里从来没有正当用法 ——
这一条原先没人守，`.github/workflows/checks.yml` 一份就攒了 97 处。

不判的四类，每一类都打印出来。不打印的话，"不判"与"没在看"分不开：

  · 测试文件字符串的 K（单条不超过 60 字）与破折号。用例名长短由内容定，
    压到 60 字会把话说残；句子也一样。其余三样（记号、成对加粗、用词）照判。
  · `.yml` / `.yaml` / `.json` 的 K 与 L（见上）。
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
  · 串那一遍原先只看「行首有没有注释标记」，于是块注释与 docstring 的正文
    也被当成了字符串（全仓 3899 个汉字，`cluster/slurmate-sessiond` 一份占
    3236）。那是多看，是假红的来源，不是漏看 —— 而 L 一立，docstring 里
    一个「读不到」就会红一条本来没错的代码。现在先把块注释挖空再扫串那一遍
    （见 `comment_masked`），闭记号之后那一行剩下的部分留着。
  · `.py` 里赋值形式的三引号（`SCHEMA_SQL = \"\"\"…\"\"\"`）只挖不判：那是喂给
    别的程序的数据，不是画给人看的文字。行首那种（docstring）按文档判。
  · `.html` 的文字整份看，不按行 —— 一个标签可以跨两行。`<script>` 与 `<style>`
    的内容先剥掉，那不算界面文字。

这些地方宁可欠判，不误判。假红会让一条检查被绕过。

用法：
    python3 tools/check-copy-style.py                # 扫整个仓库
    python3 tools/check-copy-style.py --report       # 另打印密度
    python3 tools/check-copy-style.py --ui           # 逐条列出 L 命中的位置
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
UI_TERMS_PATH = os.path.join(HERE, "ui-terms.json")

EXT = (".js", ".mjs", ".cjs", ".py", ".sh", ".sbatch", ".html", ".css", ".service",
       ".yml", ".yaml", ".json")
# 整份按注释判的三类（见 `star_only`）：YAML 的注释、以及这一类文件里成篇的
#   说明字段。K 与 L 在那里不判。
DOC_LIKE = (".yml", ".yaml", ".json")
# 没有扩展名的按 shebang 认。`LICENSE` 与 `NOTICE` 首行不是 shebang，于是不判。
SHEBANG_PY = re.compile(r"^#!.*\bpython[0-9.]*\b")

# 不判的：夹具（字节被钉住）与检查器自己（样本里是故意违规的字面量）。
SKIP_PREFIX = ("tools/conformance/tree/",)
# 检查器自己与自测脚本里写着故意违规的样本。豁免只给那些样本 —— 字符串不判。
#   注释照判，而且必须判：要求「全仓注释里不许有记号」的就是这五份，它们自己的
#   注释一条都不判的话，那句要求就是一句没人守的话。
SAMPLE_NAME = re.compile(r"^(check-.*\.py|self-test-.*\.sh)$")

MARK = re.compile(r"[★⚠⇒]")
BOLD = re.compile(r"\*\*[^*\n]+\*\*")
# 一段注释里的成对加粗。认内容，不按位置两两配：注释里本来就有落单的 ``
#   （`client/`、`**kwargs`、`2 ** 8`），按位置配的话它们会把后面每一对都错开
#   一位，于是删掉的是「这一对的闭」加「下一对的开」，剩下的半截又自己配上。
#   第一条剥离脚本就是这么栽的。
#   内容不以空白开头、不以空白结尾、中间没有星号 —— 这是加粗的形状，也是
#   那几个落单写法都不满足的形状。
BOLD_SPAN = re.compile(r"\*\*[^\s*](?:[^*]*[^\s*])?\*\*")
DASH = "——"


def bold_spans(s):
    """`s` 里成对加粗的位置。glob 里那两个星号不算。

    `client/**` 与几行之下的 `plugins/**` 会凑成一对 —— 中间隔着几十个字，
    内容也不以空白收尾，`BOLD_SPAN` 认不出它不是加粗。`.github/workflows/
    build.yml` 的 `paths` 列表里就是这样：两条 glob 之间只隔着几行注释。
    判成加粗是假红，而假红会让一条检查被绕过（改的人学会忽略它）。
    """
    for m in BOLD_SPAN.finditer(s):
        a, b = m.start(), m.end() - 1
        if a and s[a - 1] == "/":              # `client/**`
            continue
        if b + 1 < len(s) and s[b + 1] == "/":   # `src/**/*.js`
            continue
        yield m

HAN = re.compile(r"[一-鿿]")

# 注释：整行都算。按行首判，不认代码里的 `//`（那可能是 URL）。
LINE_COMMENT = {
    ".js": ("//",), ".mjs": ("//",), ".cjs": ("//",),
    ".py": ("#",), ".sh": ("#",), ".sbatch": ("#",),
    ".html": ("<!--",), ".css": ("/*",),
    # `.service` 是 systemd 单元（`cluster/slurmate-sessiond.service`）。管理员
    #   会打开它读注释 —— 那份文件里成篇的中文说明就是写给他看的。少了这一项，
    #   整份文件从视野里过去 —— 而那正是 `.html` 栽过的形状。
    ".service": ("#",),
    ".yml": ("#",), ".yaml": ("#",),
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


def _load_ui_terms():
    """`tools/ui-terms.json` 摊平成 `[(别用, 改用, 前面不许是这些字), …]`。

    长的在前是为了报得准：`没成功` 与 `没成` 都在表里，而 `没成功` 先命中，
    报出来读者才知道该往哪儿改。加载失败就抛，不留一份空表 ——
    空表会让 L 静默变成"没有在看"。

    `not_after` 是不得不加的：中文没有词边界，`别的` 会撞上「识别的」、
    `的话` 会撞上「说的话」。假红会让一条检查被绕过，所以宁可在表里多写
    一个字，也不让判据去猜。
    """
    with open(UI_TERMS_PATH, encoding="utf-8") as f:
        data = json.load(f)
    out = [(b, t["good"], t.get("not_after", ""))
           for g in data["groups"] for t in g["terms"] for b in t["bad"]]
    return sorted(out, key=lambda r: -len(r[0]))


UI_TERMS = _load_ui_terms()

# M：引用提示文字原文的那一处文档。全仓只有它一张表在教人"照着报错里的字样对"。
QUOTE_DOC = "cluster/docs/PLUGIN-TROUBLESHOOTING.md"
QUOTE_SPAN = re.compile(r"「([^」]*)」")


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
    """用例名与断言消息住在哪几份里。它们的字符串跟生产文案同上一条判据。"""
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
    是把后面真正的串当成代码，判据从那一段起整片闭嘴。所以这里有栈。

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
            # 只收没被重定向进文件的 here-doc：`cat <<EOF` 打在终端上，
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
    它的闭记号落在行首，而 `block_lines` 会把行首的三引号读成开记号 ——
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
    """会被画出来的跨行字符串跨度，只收含中文的那些。

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


def blank(text):
    """一段文本挖成空格，换行留着。"""
    return "".join("\n" if ch == "\n" else " " for ch in text)


def comment_masked(text, ext):
    """把多行注释体挖空，但留着闭记号之后那一行剩下的部分。

    串那一遍只看「行首有没有注释标记」，而块注释与 docstring 的正文行首
    两样都没有 —— 它们于是被当成了字符串。这是多看，是假红的来源：
    L 一立，docstring 里一个「读不到」就会红一条本来没错的代码。

    整行跳过不行：`*/ const s = '读不到';` 那种收尾行上有一个真的字符串，
    跳过它就把一处该报的漏掉了。所以按字符挖，只挖注释占的那一段。

    开记号与 `block_lines` 同一条规矩：必须出现在行首（前导空白之后）。
    于是字符串里写的 `"/*"` 不开一段注释。
    """
    pairs = BLOCK.get(ext, ())
    if not pairs:
        return text
    lines = text.splitlines(True)
    closing = None
    for i, line in enumerate(lines):
        s = line.lstrip()
        lead = len(line) - len(s)
        if closing is None:
            for op, cl in pairs:
                if not s.startswith(op):
                    continue
                k = s.find(cl, len(op))
                if k < 0:                      # 闭记号在后面的行上
                    closing = cl
                    lines[i] = line[:lead] + blank(line[lead:])
                else:                          # 同一行就闭合了
                    end = lead + k + len(cl)
                    lines[i] = line[:lead] + blank(line[lead:end]) + line[end:]
                break
            continue
        k = line.find(closing)
        if k < 0:
            lines[i] = blank(line)
        else:
            end = k + len(closing)
            lines[i] = blank(line[:end]) + line[end:]
            closing = None
    return "".join(lines)


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


def string_runs(cmasked, ext):
    """连续的、每一行都带字符串字面量的代码行，认成一条逻辑串。

    一条串拆到两行上是常规写法：Python 的隐式拼接（`"a" "b"`）、JS 的
    `'a' + 'b'`。J2 的成对加粗按一条串配，拆开之后两边各自不成一对，
    于是那一对记号从缝里漏过去 —— 它是会被原样画给用户看的
    （`cluster/slurmate-sessiond` 里真有三处，`属主能随时改写自己拥有` 与
    `的文件` 分在两个字面量里）。

    拼接的是字面量的内容，不是源码：这样两行之间夹着的代码不会把不相干的
    两段配成一对。而 `` 的孤立写法（`client/`、`**kwargs`、`2 ** 8`）本来
    就不满足 `BOLD_SPAN` 的形状，跨行拼起来也仍然不满足 —— 宁可欠判，不误判。
    """
    runs, cur = [], []
    for line in cmasked.splitlines():
        if split_line(line, ext)[0] != "code":
            if cur:
                runs.append(cur)
                cur = []
            continue
        lits = [m.group(0)[1:-1] for m in QUOTED.finditer(line)]
        if not lits:
            if cur:
                runs.append(cur)
                cur = []
            continue
        cur.extend(lits)
    if cur:
        runs.append(cur)
    return runs


def word_hits(s):
    """`s` 里第一处口语用词，返回 `(别用, 改用)`；没有就是 `None`。

    抽出来是给两条路共用的：生产代码那一条（`take_string`）与测试文件那一条
    （`counts_of` 里 `test` 那个分支）。两份实现会漂开 —— 而这两条判的本来
    就是同一张表。

    反引号跨度里的是引用这个词本身（「不许写成 `读不到`」），不是在用它做提示
    文字 —— 与 J 同一条豁免。前面紧挨着的那个字在 `not_after` 里就不算这一条：
    中文没有词边界，`的话` 会撞上「说的话」，`别的` 会撞上「识别的」。
    """
    prose = BACKTICK.sub(lambda x: " " * len(x.group(0)), s)
    for bad, good, not_after in UI_TERMS:
        k = prose.find(bad)
        while k >= 0:
            if not (k and prose[k - 1] in not_after):
                return (bad, good)
            k = prose.find(bad, k + 1)
    return None


def test_strings(rel, text, ext, cmasked):
    """测试文件里会被写出来的那些字：用例名、断言消息、期望值。

    只收单行字面量。用例名与断言消息本来就写单行 —— 跨行的那种用 `+` 或
    Python 的隐式拼接，每一段仍旧是单行，照样收得到。跨行串不收，是因为测试
    文件里它们多半是夹具（`renderer-dom` 那些喂给渲染器的源码片段），改了等于
    把被测对象也改了；而且 JS 测试里正则字面量遍地是引号（`/'[^']+'$/`），
    跨行配对会被引错，把注释当成字符串 —— 那是假红，假红会让检查被绕过。

    注释不在这里 —— 它们走另一条路（`block_lines`/`split_line`），照判。
    """
    out = []
    for i, line in enumerate(cmasked.splitlines()):
        if split_line(line, ext)[0] != "code":
            continue
        for m in QUOTED.finditer(line):
            out.append((m.group(0)[1:-1], "%s:%d" % (rel, i + 1)))
    return out


def take_string(c, s, limit=True, where=None, dash=True):
    """一条会被画出来的字符串，记进 `c`。没有中文的不算。

    `limit` 只对单行串开。跨行的那些是整段文字（`--help` 的用法表、安装器的
    整条报错），它们本来就该长 —— 「界面文字要短，读者才会去看」那条理由
    在那里不成立。跨行串仍旧受 J2 管（记号与破折号一个都不许有）。

    `dash` 关掉的是 J2 里的破折号那一项，只给测试文件的字符串关（见 L 那一段）。
    「短」那两条（K 与这一项）要的都是同一样东西：一句话别套一句话。界面文字
    受它管，用例名与断言消息不受。

    `where` 是给 `--ui` 用的位置（`文件:行`）。不传就是 `?`。
    """
    n = len(HAN.findall(s))
    if not n:
        return
    c["han"] += n
    c["dash"] += s.count(DASH)
    # 加粗要成对才算，而且按内容认：`client/**` 这种 glob 里的星号不是记号，
    #   一行里写两个 glob 也不该凑成一对。
    if MARK.search(s) or any(bold_spans(s)) or (dash and DASH in s):
        c["strm"] += 1
    if limit and n > STRING_MAX_HAN:
        c["long"] += 1
    # L：提示文字的用词（见 `word_hits`）。
    hit = word_hits(s)
    if hit:
        c["word"] += 1
        c["word_at"].append((where, hit[0], hit[1], s.replace("\n", "⏎")))


def star_only(c, text):
    """`.yml` / `.yaml` / `.json`：整份按注释判，只数记号与成对加粗。

    这三类里的中文只有两个来源：YAML 的 `#` 注释，与数据字段的值。两类都不是
    「会被画出来的一句话」，所以 K 与 L 在这里不判 —— 判了的话，写着那张词表的
    `tools/ui-terms.json` 自己就红七十几条（它的左列逐字列着那批词）。

    判的是记号与成对加粗：那几个字符在任何文件里都不是排版手段。这一条原先
    没人守 —— `.github/workflows/checks.yml` 一份就有 50 处，`★` 在那里是
    「这一步要紧」的记号，而 CI 的注释也是有读者的文字。

    行集是「所有非空行」，与注释那一遍同一个形状：JSON 里一段说明折成几行是
    常事，按行配加粗会整类漏掉（注释那一遍栽过同一个坑，见 J）。
    """
    runs, cur = [], []
    for i, line in enumerate(text.splitlines()):
        prose = BACKTICK.sub(lambda x: " " * len(x.group(0)), line)
        c["han"] += len(HAN.findall(prose))
        c["dash"] += prose.count(DASH)
        c["star"] += len(MARK.findall(prose))
        if cur and (i != cur[-1][0] + 1 or not line.strip()):
            runs.append(cur)
            cur = []
        if line.strip():
            cur.append((i, line))
    if cur:
        runs.append(cur)
    for run in runs:
        joined = "\n".join(b for _, b in run)
        code = [(x.start(), x.end()) for x in BACKTICK.finditer(joined)]

        def quoted(k):
            return any(s <= k < e for s, e in code)

        for mm in bold_spans(joined):
            a, b = mm.start(), mm.end() - 2
            if quoted(a) or quoted(a + 1) or quoted(b) or quoted(b + 1):
                continue
            c["bold"] += 1
    c["star"] += c["bold"]


def counts_of(rel, text):
    """一份文件里的四项条数，外加用于报告的汉字数。

    `star`  J：注释里的记号（`★` `⚠` `⇒` 与成对加粗）。
    `strm`  J2：字符串里的记号。
    `long`  K：超过 60 汉字的字符串。
    `btn`   K：超过 6 汉字的控件文字（只有 `.html` 数得出来）。
    `word`  L：字符串里出现了 `tools/ui-terms.json` 左列的词。

    `word_at` 与 `bold`/`dash`/`han` 一样不在 `KEYS` 里：前三个是给 `--report`
    的密度，`word_at` 是给 `--ui` 的逐条位置。
    """
    ext = ext_of(rel, text)
    test = is_test_file(rel)
    c = {"star": 0, "strm": 0, "long": 0, "btn": 0, "word": 0,
         "han": 0, "bold": 0, "dash": 0, "word_at": []}
    if not ext:
        return c

    # `.yml` / `.yaml` / `.json` 整份按注释判，判完就回去（见 `star_only`）。
    if ext in DOC_LIKE:
        star_only(c, text)
        return c

    # 跨行的字符串先挖空：它们里面的行按行看与代码无异，会被整片漏掉。
    spans = string_spans(text, ext)
    masked = blank_spans(text, mask_spans(text, ext))
    # 串那一遍还要再挖一层：多行注释的正文不是画给用户看的字（见
    #   `comment_masked`）。注释那一遍仍旧用上面那一份 —— 它要的正是那些正文。
    cmasked = comment_masked(masked, ext)

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

    # 成对加粗按连续的一段注释找，不按行找：注释里一句话可以折成两行，
    #   而那对星号照样成对（`fake-job.js` 的 `站点自己的\n账`、
    #   `app.css` 的 `同一个\n数`）。按行找的话它们一个都看不见。
    #   落单的 ``（glob、`kwargs`）不算加粗，也不单独报 —— 那个写法在注释里
    #   是正常的，报出来是假红。
    for run in runs:
        joined = "\n".join(b for _, b in run)
        # 反引号跨度里的星号是字面量（`client/`）。判的是位置，不挖空格：
        #   挖了的话，`必须 `goodbye` 之前停` 这种会以空格收尾，配不上。
        code = [(x.start(), x.end()) for x in BACKTICK.finditer(joined)]

        def quoted(k):
            return any(s <= k < e for s, e in code)

        for mm in bold_spans(joined):
            a, b = mm.start(), mm.end() - 2
            if quoted(a) or quoted(a + 1) or quoted(b) or quoted(b + 1):
                continue
            c["bold"] += 1
    # 加粗与记号同属 J：棘轮按 `star` 一条计（`bold` 另留给 `--report` 的密度）。
    c["star"] += c["bold"]

    # ── 文字：检查器自己的样本不判（见 SAMPLE_NAME）。注释上面已经判过了。 ──
    if SAMPLE_NAME.match(os.path.basename(rel)):
        return c

    # ── 文字：测试文件不判 K（用例名可以长），其余同生产代码。 ──────────
    #   用例名与断言消息跟生产文案是同一套话，也是同一套体例：`★` 排位与成对
    #   加粗曾经在这里合法，于是那 33 份是全仓唯一能继续生产新记号的地方 ——
    #   改一批、它长一批，清的速度赶不上写的速度。
    if test:
        for s, where in test_strings(rel, text, ext, cmasked):
            take_string(c, s, limit=False, where=where, dash=False)
        return c

    if ext == ".html":
        texts, controls = html_strings(text)
        for s in texts:
            take_string(c, s, where="%s:?" % rel)
        for s in controls:
            if len(HAN.findall(s)) > BUTTON_MAX_HAN:
                c["btn"] += 1
        return c

    for i, line in enumerate(cmasked.splitlines()):
        if split_line(line, ext)[0] != "code":
            continue
        for m in QUOTED.finditer(line):
            take_string(c, m.group(0)[1:-1], where="%s:%d" % (rel, i + 1))
    # 拆到两行上的成对加粗：单看每一个字面量都不是一对，拼起来才是（见
    #   `string_runs`）。只补跨字面量那一部分，单个字面量里配上的
    #   `take_string` 已经数过了。
    for lits in string_runs(cmasked, ext):
        joined = "".join(lits)      # 拼接不带分隔符：两行之间本来就没有字符
        cross = (len(list(bold_spans(joined)))
                 - sum(len(list(bold_spans(x))) for x in lits))
        c["strm"] += max(0, cross)
    for a, b in spans:
        body = text[a:b]
        # 跨度的两端是定界符（引号或反引号），不是内容 —— 单行串那边早就剥掉了
        #   （`m.group(0)[1:-1]`）。不剥的话 L 的反引号豁免会把整个模板串吃掉：
        #   `` `\n读不到 ${p}\n` `` 一个字都在反引号里，于是永远不报。
        #   here-doc 的体不带定界符（`sh_spans` 就是这么切的），所以那一头不受影响。
        if len(body) >= 2 and body[0] == body[-1] and body[0] in "'\"`":
            body = body[1:-1]
        take_string(c, body, limit=False,
                    where="%s:%d" % (rel, text.count("\n", 0, a) + 1))
    return c


def judged(rel):
    """这一份要不要判。

    判据与「怎么读盘」分开，于是自测能单独验它 —— 自测喂的是手写的小字典，
    不经过 `read_repo()`。第一版把这一条写在 `read_repo()` 里，自测当场发现
    「不判的两类」在自测里根本没生效。
    """
    return not rel.startswith(SKIP_PREFIX)


def read_repo(root):
    """`{仓库相对路径: 文本}` —— 候选文件的全部。判不判由 `judged()` 定。"""
    # `--others --exclude-standard`：未跟踪的也要扫。少了它，一份新写的
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


def _read_doc(root):
    """那份文档的正文；读不到返回 `None`。

    读不到不能当成"没有要判的东西" —— 那份文档被改名或搬走之后，M 会
    静默变成"没有在看"，而绿与"没在看"同形正是这个仓库一路在躲的形状。
    """
    try:
        with open(os.path.join(root, QUOTE_DOC), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def load_baseline():
    try:
        with open(BASELINE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


KEYS = ("star", "strm", "long", "btn", "word")

# 每一条判据红了之后该往哪儿看。第一次写的时候五条共用一句「见〈写得短〉」，
#   而 L 的权威在 `tools/ui-terms.json` 里那张表 —— 指错地方等于没指。
HINT = {
    "star": "记号不是强调，位置才是 —— 见 `CONTRIBUTING.md`〈写得短〉",
    "strm": "记号会被原样画出来 —— 见 `CONTRIBUTING.md`〈界面与命令行文案〉",
    "long": "界面文字要短，读者才会去看 —— 见 `CONTRIBUTING.md`〈界面与命令行文案〉",
    "btn": "动作控件的文字上限 6 字 —— 见 `CONTRIBUTING.md`〈界面与命令行文案〉",
    "word": "用词按 `tools/ui-terms.json` 那张封闭表 —— 见 `CONTRIBUTING.md`〈界面与命令行文案〉",
}


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
                                    "没有旧账可还，%s" % (rel, k, c[k], HINT[k]))
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
    base = load_baseline()
    problems, seen = compare(files, base)
    doc = _read_doc(root)
    if doc is None:
        problems.append("%s：读不到这份文档 —— M 判据失去目标，先把它找回来"
                        % QUOTE_DOC)
    else:
        # 语料是被判的那些源码。检查器自己与用例不算 —— 检查器的样本里
        #   写着故意违规的字面量（第一版把样本也当语料，于是 M 自己把自己
        #   要抓的两条遮住了）。
        corpus = "\n".join(t for rel, t in files.items()
                           if judged(rel) and not is_test_file(rel)
                           and not SAMPLE_NAME.match(os.path.basename(rel)))
        problems += prompt_quote_problems(doc, corpus)

    if problems:
        for p in problems:
            print("✗ %s" % p)
        words = sum(c["word"] for c in seen.values())
        print("\n✗ %d 条。体例见 `CONTRIBUTING.md`〈写得短〉与〈界面与命令行文案〉。"
              % len(problems))
        if words:
            print("  口语用词占 %d 处，逐条清单跑 `--ui`；用词表在 "
                  "`tools/ui-terms.json`。" % words)
        return 1

    total = {k: sum(c[k] for c in seen.values()) for k in KEYS}
    print("✓ %d 份源码：%d 处注释记号、%d 处字符串记号、%d 条超长文字、%d 条超长控件、"
          "%d 处口语用词 —— 都在棘轮允许的额度内"
          % (len(files), total["star"], total["strm"], total["long"],
             total["btn"], total["word"]))

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
    samples = sorted(r for r in files
                     if SAMPLE_NAME.match(os.path.basename(r)))
    if samples:
        print("\n· 不判的：%d 份检查器脚本的字符串（样本里写着故意违规的字面量；"
              "注释照判）：%s" % (len(samples), " / ".join(samples)))
    print("· 不判的：测试文件字符串的 K 与破折号（句子的长短由内容定；"
          "记号、成对加粗、用词照判）")
    print("· 不判的：%s 里的 K 与 L（那几类里没有画给用户看的一句话；"
          "记号与成对加粗照判）" % " / ".join(DOC_LIKE))
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


def prompt_quote_problems(doc, corpus):
    """M：`doc` 的表行第一列里，每个 `「…」` 都要在 `corpus`（全部源码）里找得到。

    判据与读盘分开，于是自测能喂手写的小样本进来 —— M 的样本不是"一份文件里
    有什么"，是"两段文本之间的关系"，往 `counts_of` 那套形状里塞不进去。
    """
    out = []
    for n, line in enumerate(doc.splitlines(), 1):
        if not line.startswith("| 「"):
            continue
        # 只判表行第一列（〈报错里出现〉）。标题不判：这一篇的标题是标题，
        #   好几处本来就写着 `xxx` / `X` / `N` 这类占位（"报「default_plugin
        #   = xxx 在本站没有装」"），逼它们逐字就得把 `%r` 写进标题里。那是一处
        #   明写的欠判，不是漏看。
        cell = line.split("|")[1]
        for m in QUOTE_SPAN.finditer(cell):
            q = m.group(1)
            if "…" in q:
                continue
            if q not in corpus:
                out.append("%s:%d：引用的「%s」在源码里找不到原话" % (QUOTE_DOC, n, q))
    return out


def ui(root):
    """L 命中的每一处：位置、别用、改用、原文。只报告，不判红。

    报一句「一共 313 处」没法动手，这张清单才是干活用的。制表符分隔，
    外面随便 `cut` / `sort`。
    """
    files = read_repo(root)
    rows, per_word = [], {}
    for rel in sorted(files):
        if not judged(rel):
            continue
        for where, bad, good, s in counts_of(rel, files[rel])["word_at"]:
            rows.append((where or "?", bad, good, s))
            per_word[bad] = per_word.get(bad, 0) + 1
    for where, bad, good, s in rows:
        print("%s\t%s\t%s\t%s" % (where, bad, good, s[:90]))
    print("\n共 %d 处，%d 份文件。" % (len(rows),
                                     len({w.split(":")[0] for w, _, _, _ in rows})))
    for bad, n in sorted(per_word.items(), key=lambda kv: (-kv[1], kv[0])):
        print("  %5d  %s" % (n, bad))
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
        # ── L：提示文字的用词 ──────────────────────────────────────────
        ("字符串里的「读不到」",
         {"client/src/main/a.js": "const s = '读不到 X：原因';\n"}, "word"),
        ("字符串里的「没能」",
         {"client/src/main/a.js": "const s = '没能保存到本机。';\n"}, "word"),
        ("字符串里的「东西」",
         {"client/src/main/a.js": "throw new Error('包里没有这个东西');\n"}, "word"),
        ("PHP 之外各语言同判：Python 字符串里的「对不上」",
         {"cluster/a.py": "print('与签名对不上')\n"}, "word"),
        ("shell 里打在终端上的「挑不到」",
         {"cluster/a.sh": 'die "挑不到空闲端口"\n'}, "word"),
        ("HTML 控件文字里的「一下」",
         {"client/src/a.html": "<button>弄一下</button>\n"}, "word"),
        ("跨行模板串里的口语词也算",
         {"client/src/main/a.js": "const t = `\n读不到 ${p}\n`;\n"}, "word"),
        # ── L 的假红防线 ───────────────────────────────────────────────
        ("反引号里的是**引用**这个词，不是用它做提示文字",
         {"client/src/main/a.js": "const s = '不许写成 `读不到`';\n"}, None),
        # ── J2：拆到两个字符串字面量里的成对加粗 ──────────────────────
        ("Python 隐式拼接拆开的成对加粗（单看每个字面量都不成对）",
         {"cluster/a.py": 'raise ValueError("属主**能随时改写自己拥有"\n'
                          '                 "的文件**，所以……")\n'}, "strm"),
        ("JS 用 `+` 拼起来的两行也一样",
         {"client/src/a.js": "throw new Error('本站没有这种**'\n"
                             "  + '资源**。');\n"}, "strm"),
        ("拆开的假红防线：两个 glob 分在两行上不配对",
         {"client/src/a.js": "const a = '见 client/**'\n"
                             "  + ' 与 docs/** 两份。';\n"}, None),
        ("没有中文的串本来就不判",
         {"client/src/main/a.js": "const s = 'ENOENT reading file';\n"}, None),
        ("注释里的口语词不归 L 管（那是写给维护者的）",
         {"client/src/main/a.js": "// 从前这里是「读不到」\nconst a = 1;\n"}, None),
        ("`的话` 不当条件句用的地方不算（「服务说的话」）",
         {"client/src/main/a.js": "const s = '那个服务说的话';\n"}, None),
        ("而条件句的 `的话` 照报",
         {"client/src/main/a.js": "const s = '不升的话，两边各说各话';\n"}, "word"),
        ("`别的` 撞上「识别的」不算",
         {"client/src/main/a.js": "const s = '配置里有无法识别的键';\n"}, None),
        ("而「别的进程」照报",
         {"client/src/main/a.js": "const s = '被别的进程占着';\n"}, "word"),
        ("测试文件里的用例名照判（它是这套文案的第二份说明）",
         {"client/test/a.test.mjs": "test('读不到时返回 null', () => {});\n"}, "word"),
        ("测试文件里的断言消息照判",
         {"client/test/a.test.mjs":
          "assert.equal(x, 1, '拿不到那一格时要如实说');\n"}, "word"),
        # ── 块注释与 docstring 的正文不是字符串（L 立之前它是假红的来源） ──
        ("JS 块注释正文里的引号不是字符串",
         {"client/src/main/a.js": '/* 说明 "读不到" 这一句 */\nconst a = 1;\n'}, None),
        ("Python docstring 正文里的引号不是字符串",
         {"cluster/a.py": 'def f():\n    """读不到就是空集。"""\n    return 1\n'}, None),
        ("HTML 注释正文里的引号不是字符串（`html_strings` 先剥注释）",
         {"client/src/a.html": '<!-- 说明 "读不到" -->\n<button>好</button>\n'}, None),
        ("而闭记号之后那一行剩下的部分照判 —— 整行跳过会漏掉真的字符串",
         {"client/src/main/a.js": "/* 说明 */ const s = '读不到 X';\n"}, "word"),
        # ── 不判的三类 ─────────────────────────────────────────────────
        ("测试文件的用例名里带 `★` 也照判（排位不用记号）",
         {"client/test/a.test.mjs": "test('★ 写失败：返回 {ok:false}', () => {});\n"},
         "strm"),
        ("测试文件的断言消息里的成对加粗也照判",
         {"client/test/a.test.mjs":
          "assert.equal(x, 1, '这条**必须**留住');\n"}, "strm"),
        ("而用例名长过 60 汉字不判（K 只管生产文案）",
         {"client/test/a.test.mjs":
          "test('%s', () => {});\n" % ("很长的用例名" * 12)}, None),
        ("用例名里的破折号也不判（它禁的是长句，不是记号）",
         {"client/test/a.test.mjs":
          "test('让位要靠 margin —— 用 padding 时滚动条会钻到底下', () => {});\n"},
         None),
        ("而生产字符串里的破折号照判",
         {"client/src/a.js": "throw new Error('写失败 —— 目录不存在');\n"}, "strm"),
        ("而测试文件的注释照判",
         {"client/test/a.test.mjs": "// ★ 这条注释要改\n"}, "star"),
        ("检查器自己的注释照判 —— 豁免只给样本字符串",
         {"tools/check-a.py": "# ★ 样本\n"}, "star"),
        ("自测脚本的注释照判",
         {"tools/self-test-a.sh": "# ★ 样本\n"}, "star"),
        ("而检查器脚本里的样本字符串不判（它写着故意违规的字面量）",
         {"tools/check-a.py": "case('★ 假样本', 'x', None)\n"}, None),
        # ── `.yml` / `.yaml` / `.json`：整份按注释判 ─────────────────────
        ("YAML 注释里的 `★` 照判",
         {".github/workflows/a.yml": "jobs:\n  # ★ 这一步要紧\n  build: 1\n"}, "star"),
        ("YAML 值里的成对加粗也照判",
         {"client/a.yml": "name: Slurmate\n# **故意**分开\n"}, "star"),
        ("JSON 的说明字段里的 `★` 照判",
         {"tools/a.json": '{\n  "_": ["★ 这一段是给维护者看的"]\n}\n'}, "star"),
        ("而两条 glob 隔着几行凑成的「加粗」是假红（`client/**` 与 `plugins/**`）",
         {".github/workflows/a.yml":
          "on:\n  push:\n    paths:\n      - 'client/**'\n"
          "      # 两行注释夹在中间\n      - 'plugins/**'\n"}, None),
        ("`**kwargs` 与 `2 ** 8` 不算加粗（它们本来就不是成对的）",
         {"client/a.yml": "a: 1\n# 见 **kwargs 与 2 ** 8\n"}, None),
        ("`.json` 里超长的中文不判 K（那几类里没有画给用户看的一句话）",
         {"tools/a.json": '{"_": ["%s"]}\n' % ("很长的说明" * 12)}, None),
        ("`.json` 里的口语用词也不判 L（词表自己就列着那批词）",
         {"tools/a.json": '{"_": ["读不到就说读不到"]}\n'}, None),
    ]
    bad = []
    for why, files, expect in cases:
        got, _ = compare(files, {})
        if expect is None:
            if got:
                bad.append("假红：%s —— 报了 %r" % (why, got))
        elif not any(expect in g for g in got):
            bad.append("没抓到：%s（期望 %r，实际 %r）" % (why, expect, got))
    # ── M：文档里引用的提示文字要能在源码里找到 ─────────────────────────
    #
    # M 判的不是"一份文件里有什么"，是两段文本之间的关系（文档里写的字样
    #   在不在源码里），所以它进不了上面那套 `(样本文件, 期望)` 的形状。
    corpus = "const s = '读取站点的插件快照表失败';\n"
    m_cases = [
        ("表里那个字样在源码里找得到",
         "| 「读取站点的插件快照表失败」 | 原因 | 做法 |", None),
        ("给变量留了 `…` 的那一段不判",
         "| 「读取…失败」 | 原因 | 做法 |", None),
        ("正文里的「」不判 —— 那是行文，不是字样",
         "这一节讲的是「随便写的一句」，它不在表里。", None),
        ("标题不判（标题里有 `xxx` / `X` 这类占位）",
         "## 启动时报「default_plugin = xxx 在本站没有装」", None),
        ("第二列里的「」不判 —— 那不是〈报错里出现〉那一列",
         "| 「读取站点的插件快照表失败」 | 见「随便写的一句」 | 做法 |", None),
        ("字样与源码对不上就报",
         "| 「读不到站点的插件记录」 | 原因 | 做法 |", "找不到原话"),
    ]
    for why, doc, expect in m_cases:
        got = prompt_quote_problems(doc, corpus)
        if expect is None:
            if got:
                bad.append("假红：%s —— 报了 %r" % (why, got))
        elif not any(expect in g for g in got):
            bad.append("没抓到：%s（实际 %r）" % (why, got))
        cases.append((why, None, expect))

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
    ap.add_argument("--ui", action="store_true")
    ap.add_argument("--baseline", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if args.baseline:
        return write_baseline(args.root)
    if args.report:
        return report(args.root)
    if args.ui:
        return ui(args.root)
    return run(args.root)


if __name__ == "__main__":
    sys.exit(main())
