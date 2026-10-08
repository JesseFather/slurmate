#!/usr/bin/env python3
"""公开文档的正文：不叙历史，也不用「你 / 我」。

体例见 `CONTRIBUTING.md`〈公开文档用规范体〉。

判据两条，都是机械的：

    F  公开文档里不许出现**历史叙述** —— 时间锚点（`v0.13 起`）、括号版本注记
       （`（v0.12 热重载）`）、对比叙述（`从前 X，现在 Y`）。「现在是什么」直接
       陈述；「从前是什么」不属于规范。

    G  公开文档的正文里不许出现**人称代词**（`你` / `我` / `我们` / `他`）。文档是
       陈述，不是对话。读者由**角色名词**指名（管理员 / 插件作者 / 实现者 / 用户），
       叙述者不现身。

★ `他` 进判据，而排除它的是**一个负向环视**：`(?<!其)他`。阶段 1 立法时我把它整个
  排除了，理由是"过半是「其他」" —— **那个理由站不住**：`其他` 的 `他` 前面永远是
  「其」，一个环视就够了。真实的人称用法只有 32 处，而用户点名的正是"你我他"。
  ⇒ 修正见 v0.15 阶段 3 的提交信息。

★ `她` / `它` **仍然不进判据**：`它` 在公开文档里有 **1497 处**，几乎全部指物
  （作业、插件、容器、连接），做成判据会把真信号淹掉；`她` 在仓库里 0 处。

★★ **F 与 G 对反引号的立场正好相反，这是故意的。**

  · G 禁的是**词**。反引号与引号里装的是**引用**，不是叙述：界面真的会显示的字
    （`「本站要给你 N 个插件，都还没经过你的同意」`）、照着敲的命令占位符
    （`sshare -u <你>`）、数据形状（`"keeper": "<我的 client_id>"`）。
    ⇒ G **豁免**这两种跨度。改动它们等于让文档说谎。

  · F 禁的是**事实**。`v0.13 起` 这种话，包在反引号里也仍然是历史叙述。
    ⇒ F **不豁免**任何跨度，包括围栏代码块（那里装的是目录树与伪代码，是给人读的
    正文，与 `check-doc-style.py` 的 B1 同一条理由）。

  ⇒ 这也是**为什么本文件独立存在、不并进 `tools/check-doc-style.py`**：那一份里
    B1 豁免反引号、B2 不豁免，两套相反立场已经并存；再加两套，读的人会默认一种政策，
    而这里恰恰是判据最容易出错的地方。

★★ **一类不判的东西，写在这里免得日后被当成漏洞。**

  反引号里的「已死标识符」（`` `DEFAULT_CPUS` ``、`` `max_clients_per_user` ``、
  `` `plugin_file` `` 这类）**不判**。它们确实是陈旧的，但那属于「文档说的和事实
  不一致」，与「叙历史」是两件事 —— 一个键名写在那里而不说它是旧的，F 抓不到它，
  也不该由 F 抓。做成一张人工维护的正列表（照 `check-doc-style.py` 的 `ULID_OK`
  形状）是可行的，但那是一张会漂的表，而「同一条规矩两份实现会漂开」是这个仓库
  记过的教训。⇒ 记进 `docs/KNOWN-ISSUES.md`，作为下一版可以单独立的一条判据。

  ★ 路径类的那一半**已经有主**：`` `docs/DOC-LAYOUT.md` `` 这种，
    `tools/check-doc-links.py` 的 A1 已经在公开文档里报「写的路径不存在」。

★ **「当前版本」不是历史。** `docs/PROTOCOL.md` 的「当前版本：v0.14」是**活的事实**。
  所以 F 只在版本号**带时间后缀**时才触发（`v0.13 起` / `v0.13 之前` /
  `（v0.12 热重载）`）；裸版本号（`v0.14 不是 v0.1`、`0.255 之后是 1.0`）**根本不是
  触发词** —— 这是**范围**，不是豁免。

★★ **对照词只有站在锚旁边才算数。** `不再` 在公开文档里有 70 处，绝大多数是当前
  行为（「SSH 闪断不再丢会话」「超时后不再重试」）；`改成` / `改为` 也有大量是**操作
  指示**（「把 `password` 改成 `none` 之前请先确认」）。按词判会制造一整批假红，而
  假红会让这条检查被绕过 —— 本仓库的纪律。⇒ 它们只在**同一行出现锚**时才计入。
  代价写明：`cluster/docs/TROUBLESHOOTING.md` 里「改成由插件自己在清单里声明…之后」
  这类**无锚的欠报**是接受的，由人工迁移兜底。

★ **已知的过度报警一处**：`从…变成` 那条分不清「一次已经发生了的改写」与「一个
  触发条件」。`packer/docs/README.md` 的「同一个 id 的签名者变了（…）」原先写作
  「或从"有签名"变成"没签名"」—— 那描述的是**将来会触发一次提问的状态变化**，
  不是历史。机械上分不开，所以那一处改写了措辞；再遇到同一形状，同样处理（或者
  把整张表重新想一遍，别只在正则上打补丁）。

用法：
    python3 tools/check-doc-prose.py                # 扫整个仓库
    python3 tools/check-doc-prose.py --self-test    # 种坏样本，断言它真的会红
"""

import argparse
import collections
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 记录类：这两份**就是**设计指定的历史容器，按时间累积、按编号引用。
# 公开文档若想提历史，唯一的出路是把话搬进这里。
EXEMPT = ("CHANGELOG.md", "docs/KNOWN-ISSUES.md")

# ★★ 夹具：**不判**，而理由与「记录类」不是一回事 —— 那一类叫「允许叙历史」，
#    这一类叫「它不是散文」。`tools/conformance/tree/` 是一棵**被字节钉住的输入树**：
#    `tools/conformance/expected.json` 逐份记着它的 sha256 与 size，外加一个整包
#    `digest`，而三端用例（`packer/test-packer.mjs`、`cluster/test-sessiond-logic.py`、
#    `client/test/plugin-package.test.mjs`）都拿那份期望值当答案。改一个字节 ⇒ 期望值
#    过期 ⇒ 三端一起红。那一份 README 自己最后一行就写着这句话（「改这棵树 ⇒
#    `expected.json` 会过期。**那是设计**」），它是夹具的**说明书**，不是公开文档。
#    ⇒ 它落在棘轮里是阶段 1 建表时的一个**分类错误**，正确的处置是把它移出判据范围，
#      而不是去改那棵树（改它等于把夹具挪到实现那边去）。
FIXTURE = ("tools/conformance/tree/",)


def judged(rel):
    """这一份要不要判。"""
    return rel not in EXEMPT and not rel.startswith(FIXTURE)

# ★★ **迁移期棘轮 —— 已经清空。** 值 = 某文件**当前允许的违规条数**；不在表里 = 零容忍。
#    v0.15 阶段 1 建表时是 **596 条 / 19 份**，阶段 5 清到最后一份，现在是空的。
#
#    ★ 为什么当初不是「文件级豁免名单」（只列出文件、不列数字）：那个形状在**缩编
#      期间**有一个真实的漏网窗口 —— 名单内的文件正是改动最频繁的，它新长出来的
#      违规不会被任何人发现。数字让它上升即红。
#
#    ★★ **空是这条纪律的一部分，不是巧合。** 一张永久挂着的遮罩比没有检查更糟：
#      它让「绿」伪装成「清完了」。所以本表非空时，`run()` 一定会打印「还剩 N 份」。
#
#    ★ 这张表**只该在两种场合重新非空**：① 又一次大规模迁移（那是它的用途）；
#      ② 某一份文档需要临时宽限 —— 而第二种要写清为什么、以及打算什么时候清掉。
#      日常提交往这里加键 = 把检查关掉，不是"配置"。
#
#    ★ 数字是 F 与 G **合起来**的条数，不是分开两套：棘轮要守的是「不许上升」，
#      不是「必须下降」，一条总数就够，少一处会漂的事实源。
LEGACY = {}

# ── 判据 G：人称代词 ──────────────────────────────────────────────────────
#
# ★ `我们` 必须排在 `我` 前面：交替式正则从左往右取**第一个**能匹配的分支，
#   顺序反了会把 `我们` 拆成 `我` + 一个孤立的 `们`。
#
# ★ `(?<!其)他`：环视排掉「其他」。中文里以 `他` 打头的词只有 `他 / 他们 / 他人 /
#   他方 / 他日` 这几个，全都是人称，没有第二个要排的词。
PRONOUN = re.compile(r"我们|你|我|(?<!其)他")

G_FIX = {
    "你": "换成角色名词（管理员 / 插件作者 / 实现者 / 用户）",
    "我们": "换成无人称主语（本项目 / 这一层 / 守护进程）",
    "我": "换成无人称说法；确为界面原文时放进引号或反引号",
    "他": "换成角色名词（用户 / 管理员 / 作者），或直接删掉这个主语",
}

# ── 判据 F：历史叙述 ──────────────────────────────────────────────────────
#
# 触发词分两档：**强信号**自己就构成一个「历史框」；**对照词**只有在同一行出现
# 强信号时才算（理由见文件头）。

# ★ 加粗的星号是 `\*{0,2}`（**可有可无**），不是 `\*\*?` —— 后者是「一个 `*`，
#   第二个可选」，也就是**至少要有一个**，而 `**v0.13 起**` 里版本号后面跟的是
#   空格、不是星号，于是它一个都匹配不上。这个错第一版真的犯了，自测当场抓住。
# ★ 版本号的 `v` 前缀是**可有可无**的：`v0.13 起` 与 `0.13 起` 是同一句话。
#   第一版只认带 `v` 的那种，于是全仓有 **10 处**裸版本锚点从判据底下溜过去
#   （`0.6 起`、`0.7 之前`、`0.12 时`…）—— 而它们叙的是同一件史。
#   ★ `(?<![\d.])` 是必需的：没有它，`§5.3 删掉` 那种节号也会被当版本锚点。
V_ANCHOR = re.compile(
    r"\*{0,2}(?<![\d.])v?0\.\d+\*{0,2}"
    r"(?:\s*阶段\s*\d+)?"
    r"\s*(?:起|之前|以前|之后|后|时|放开|删掉|删除|改成|改为)"
)
FROM_V = re.compile(r"(?:从|自|于)\s*\*{0,2}v?0\.\d+")
PAREN_V = re.compile(r"（\s*\*{0,2}v?0\.\d+[^）\n]*）")
UPGRADE = re.compile(r"(?:升级到|升到|旧版本)\s*（?\s*[0-9]+\.[0-9.]+")
OR_EARLY = re.compile(r"[0-9]+\.[0-9.]+(?:\.[0-9]+)?\s*及更早")
PAST = re.compile(r"从前|原先|曾经|后来|以往|当年|此前|彼时")
FROM_TO = re.compile(r"从[^，。；、\n]{1,30}(?:改成|改为|变成)")

HIST = (
    ("版本时间锚点", V_ANCHOR),
    ("「从 vX」", FROM_V),
    ("括号版本注记", PAREN_V),
    ("升级叙述", UPGRADE),
    ("「及更早」", OR_EARLY),
    ("过去时间词", PAST),
    ("「从…改成」", FROM_TO),
)

# 对照词：只在同一行有强信号时才算。
WEAK = re.compile(r"不再|改成|改为|换了")

# 含这两个提法的行整行豁免：那是**活的事实**，不是历史。见文件头。
CURRENT = re.compile(r"当前维护的版本|当前版本")

# 反引号跨度。支持 `\`` 转义；**未闭合的不遮**（遮到文末会把整篇正文吞掉 ——
# 宁可欠豁免，也不能让一个孤立的反引号把后面的违规全藏起来）。
BACKTICK = re.compile(r"(?<!\\)`(?:\\.|[^`\\])*?`", re.S)

# 围栏代码块的**围栏行**（``` 或 ~~~ 单独成行）。
#
# ★★ 为什么必须单独处理：```` ``` ```` 那三个反引号会被上面的 `BACKTICK` 两两配对 ——
#    一对吃掉开头两个、下一对从第三个起一直吃到文末的下一个反引号 —— 于是**整段代码块
#    被吞进豁免区**，而 G 本来是要判围栏里的正文的（那里面装的是目录树与命令样例，
#    是给人读的正文）。这个错第一版真的犯了，自测当场抓住。
#    ⇒ 配对之前先把围栏行**用等长的空格替掉**：长度不变，所以偏移仍然对得上。
FENCE_LINE = re.compile(r"(?m)^[ \t]*(?:```|~~~).*$")


def blank_fences(text):
    """把围栏行换成等长的空格 —— 它们不是行内反引号跨度的一部分。"""
    out = list(text)
    for m in FENCE_LINE.finditer(text):
        for k in range(m.start(), m.end()):
            out[k] = " "
    return "".join(out)

# 引号跨度。**允许跨行** —— 第一版把它们限在行内（`[^\n]`），于是
# `docs/CONTRACT.md` 里那句跨了两行的「窗口里当前那块视图 / 就是我」没被遮住，
# 一个引号里的字被当成正文里的人称报了出来。未闭合的引号仍然不遮（正则配不上），
# 所以一个孤立的引号不会吞掉半篇 —— 风险与反引号那边同一条。
QUOTES = (
    re.compile(r"「[^」]*」"),
    re.compile(r"『[^』]*』"),
    re.compile(r"“[^”]*”"),
    re.compile(r"‘[^’]*’"),
    re.compile(r'"[^"]*"'),
)


def masks(text):
    """返回 `(引号遮罩, 反引号遮罩)` —— 两个等长的布尔表，True = 该字符在跨度里。

    ★★ **两条判据用的不是同一张表，这是故意的**（见文件头）：

      · **F 只用引号遮罩。** 引号标的是**提及** —— 「搬完不回填"从前在哪"」里那个
        「从前」是**被讲到的概念**（这条规矩讲的就是别写从前的位置），不是文档在
        叙历史。而**反引号不遮**：`` `v0.13 起` `` 是历史事实的字面写法，加个代码
        格式不改变它在叙历史这件事。
      · **G 两张都用。** 反引号与引号里装的是**引用**（界面原文、命令占位符、
        JSON 形状），把它们改掉等于让文档说谎。

    ★ 为什么必须是**文档级**而不是逐行：公开文档里有 11 处**跨行**反引号跨度
      （`README.md`、`packer/docs/README.md` 等），逐行配对会把它们判错；还有 1 处
      **转义反引号**（`packer/docs/PLUGIN-SPEC.md` 的字符集那一行），逐行配对会把
      跨度截断在转义处，于是本该豁免的正文漏出来。
    """
    n = len(text)
    quote, code = [False] * n, [False] * n
    # ★ 反引号在**抹掉围栏行之后**的文本上配对（见 `blank_fences`）；偏移不变。
    for m in BACKTICK.finditer(blank_fences(text)):
        for k in range(m.start(), m.end()):
            code[k] = True
    for rx in QUOTES:
        for m in rx.finditer(text):
            for k in range(m.start(), m.end()):
                quote[k] = True
    return quote, code


def f_hits(line):
    """这一行里 F 抓到的东西 —— `[(起点, 终点, 名目, 原文), ...]`。"""
    raw = []
    for name, rx in HIST:
        for m in rx.finditer(line):
            raw.append((m.start(), m.end(), name, m.group(0)))

    # ★★ 去重：`它自 v0.1 起就在` 会被「版本时间锚点」（`v0.1 起`）与「从 vX」
    #    （`自 v0.1`）**同时**命中，两个区间重叠 —— 不去重就是一行报两条，
    #    棘轮的数字跟着虚高，而后面的文件要清几处也就说不清了。
    #    保留先命中的那条（`HIST` 的顺序即优先级）；**不重叠**的两处仍然各报一条，
    #    因为那确实是同一句话里讲的两件历史。
    hits, taken = [], []
    for s, e, name, txt in raw:
        if any(s < e2 and e > s2 for s2, e2 in taken):
            continue
        taken.append((s, e))
        hits.append((s, e, name, txt))

    if hits:                       # 有强信号 ⇒ 对照词一并算上（见文件头）
        for m in WEAK.finditer(line):
            hits.append((m.start(), m.end(), "对照词「%s」" % m.group(0), m.group(0)))
    return hits


def problems_from(files):
    """`files` 是 `{仓库相对路径: 文本}`。

    返回 `[(仓库相对路径, 问题描述), ...]`（空 = 全过）。判据本身不碰磁盘，
    于是它能被单独验 —— 真实运行时由 `read_repo()` 填，自测时由手写的小字典填。
    """
    out = []
    for rel, text in sorted(files.items()):
        if not judged(rel):
            continue                 # 记录类（允许叙历史）与夹具（不是散文）：都不判

        quote, code = masks(text)
        pos = 0
        for i, line in enumerate(text.splitlines(keepends=True), 1):
            # ── F：历史叙述（只看**引号遮罩** —— 引号里是「提及」，反引号照查）──
            if not CURRENT.search(line):
                for s, _e, name, hit in f_hits(line):
                    if quote[pos + s]:
                        continue        # 整个落在引号里 ⇒ 被提及的概念，不是叙述
                    out.append((rel, "%d 行是历史叙述（%s）—— 「%s」"
                                % (i, name, hit.strip()[:48])))

            # ── G：人称代词（引号与反引号，**两张遮罩都看**）────────────
            for m in PRONOUN.finditer(line):
                if not (quote[pos + m.start()] or code[pos + m.start()]):
                    w = m.group(0)
                    out.append((rel, "%d 行正文里的人称代词「%s」—— %s"
                                % (i, w, G_FIX[w])))
            pos += len(line)
    return out


def read_repo(root):
    files = {}
    listing = subprocess.run(["git", "ls-files", "*.md"], cwd=root,
                             capture_output=True, text=True, check=True).stdout
    for rel in listing.splitlines():
        full = os.path.join(root, rel)
        try:
            with open(full, encoding="utf-8") as f:
                files[rel] = f.read()
        except (OSError, UnicodeDecodeError):
            continue
    return files


def run(root):
    files = read_repo(root)
    problems = problems_from(files)

    # 棘轮：按文件计数，逐个比 LEGACY（不在表里 = 必须为 0）。
    counts = collections.Counter(rel for rel, _ in problems)
    over = []
    for rel, n in sorted(counts.items()):
        allow = LEGACY.get(rel, 0)
        if n > allow:
            over.append((rel, n, allow))

    if over:
        for rel, n, allow in over:
            print("✗ %s：%d 条（棘轮只允许 %d）" % (rel, n, allow))
            for r, msg in problems:
                if r == rel:
                    print("      %s" % msg)
        print("\n✗ 有 %d 份公开文档的违规数**上升了**。历史叙述与「你 / 我」不许再长 ——"
              " 见 `CONTRIBUTING.md`〈公开文档用规范体〉。" % len(over))
        return 1

    if problems:
        print("· 迁移期：还剩 %d 条（分布在 %d 份文档），都在棘轮允许的额度内。"
              % (len(problems), len(counts)))
        for rel, n in sorted(counts.items()):
            print("    %-38s %3d / %3d" % (rel, n, LEGACY.get(rel, 0)))
    else:
        print("✓ %d 份公开文档：没有历史叙述，正文里也没有「你 / 我」"
              % sum(1 for r in files if judged(r)))

    # ★ 豁免集是**遮罩**，遮罩必须看得见 —— 悄悄跳过一份，绿就与「没在看」同形。
    skipped = sorted(r for r in files if not judged(r))
    if skipped:
        print("\n· 不判的：%d 份是**记录类**（%s），%d 份是**夹具**（`%s` —— 字节被"
              " `expected.json` 钉住，改它三端一起红）。"
              % (sum(1 for r in skipped if r in EXEMPT),
                 " / ".join(EXEMPT),
                 sum(1 for r in skipped if r not in EXEMPT), FIXTURE[0]))

    if LEGACY:
        print("\n· ★ 棘轮还没清空：还剩 %d 份文档挂着额度。清完一份就把数字**下调**，"
              "清干净就把键**删掉** —— 这一层遮罩必须消失。" % len(LEGACY))
    return 0


def self_test():
    """种坏样本，断言这条检查**真的会红**。

    ★ 没有这一步，"检查通过"与"检查根本没在看"分不开（先例：
      `tools/self-test-sanitized.sh`）。
    """
    cases = [
        # ── F 的坏样本 ─────────────────────────────────────────────────
        ("时间锚点：v0.13 起",
         {"docs/A.md": "插件 **v0.13 起** 是一棵树。\n"}, "版本时间锚点"),
        ("时间锚点**不带 `v`** 也是同一个锚（`0.6 起`）",
         {"docs/A.md": "0.6 起框架版本是两段。\n"}, "版本时间锚点"),
        ("括号版本注记",
         {"docs/A.md": "**`SIGHUP` 时整个重读**（v0.12 热重载）。\n"}, "括号版本注记"),
        ("「自 v0.1 起」—— 两条正则重叠，只报一条（去重）",
         {"docs/A.md": "它自 v0.1 起就在。\n"}, "版本时间锚点"),
        ("对比叙述：从前…现在…",
         {"docs/A.md": "从前防的是改写，现在防的是替换。\n"}, "过去时间词"),
        ("「从…改成…」自带旧的一半",
         {"docs/A.md": "`bytes` 从「整棵树重打」改成「要发出去的那一份」。\n"}, "「从…改成」"),
        ("锚写在**反引号里**照样抓 —— F 只豁免引号，不豁免反引号",
         {"docs/A.md": "`v0.13 起` 就不再发整个包。\n"}, "版本时间锚点"),
        ("对照词站在锚旁边 ⇒ 一并算上",
         {"docs/A.md": "**v0.13 起不再发整个包**。\n"}, "对照词"),
        # ── F 的假红防线 ───────────────────────────────────────────────
        ("「当前版本」是活的事实，不是历史",
         {"docs/PROTOCOL.md": "**当前版本：v0.14。** 四处声明。\n"}, None),
        ("裸版本号拿来举例，不是历史",
         {"docs/PROTOCOL.md": "`v0.14` **不是** `v0.1` —— `14` 比 `1` 大。\n"}, None),
        ("版本进位算术",
         {"docs/PROTOCOL.md": "超上界时**必须进位**（`0.255` 之后是 `1.0`）。\n"}, None),
        ("`§5.3 删掉` 是节号，不是版本锚点",
         {"docs/A.md": "见 §5.3 删掉那一段。\n"}, None),
        ("「不再」是当前规则（同行没有锚）",
         {"docs/A.md": "`submit` 超时后**不再重试**。\n"}, None),
        ("「改成」是操作指示（同行没有锚）",
         {"docs/A.md": "把 `password` 改成 `none` 之前，请先确认有别的手段。\n"}, None),
        ("引号里被**提及**的「从前」不算叙历史（那条规矩讲的就是这个词）",
         {"docs/A.md": "**搬完不回填\"从前在哪\"。** 留一句「本文件原在 `docs/`」。\n"},
         None),
        ("两份记录类不受 F 管",
         {"CHANGELOG.md": "v0.13 起把它们都删了。\n",
          "docs/KNOWN-ISSUES.md": "从前这里有 F20。\n"}, None),
        # ── G 的坏样本 ─────────────────────────────────────────────────
        ("第二人称「你」",
         {"docs/A.md": "你在配置文件里改这一项。\n"}, "「你」"),
        ("第一人称复数「我们」",
         {"docs/A.md": "我们的实现这样选。\n"}, "「我们」"),
        ("第一人称单数「我」",
         {"docs/A.md": "我点了【临时离开】。\n"}, "「我」"),
        ("第三人称「他」",
         {"docs/A.md": "他会看到作业仍在跑。\n"}, "「他」"),
        ("标题里的人称也要报",
         {"docs/A.md": "## 安装器拒绝了我下载的包\n"}, "「我」"),
        ("围栏代码块里的**正文**也要报",
         {"docs/A.md": "```\n客户端（你的笔记本）\n```\n"}, "「你」"),
        ("跨行反引号**之后**那一行仍然要报",
         {"docs/A.md": "`这一段\n跨了两行`\n你去改。\n"}, "「你」"),
        # ── G 的假红防线 ───────────────────────────────────────────────
        ("反引号里的命令占位符",
         {"docs/A.md": "命令是 `sshare -u <你>`。\n"}, None),
        ("引号里的界面原文",
         {"docs/A.md": "界面显示「本站要给你 N 个插件」。\n"}, None),
        ("反引号里的 JSON 占位符",
         {"docs/A.md": "`\"keeper\": \"<我的 client_id>\"`\n"}, None),
        ("引号里被引为用户原话的句子",
         {"docs/A.md": "用户说的是「我不看了」。\n"}, None),
        ("反引号里是一条 grep 命令",
         {"docs/A.md": "跑 `grep 我们 docs/` 看看。\n"}, None),
        ("转义反引号不会把跨度截断（那一段整段豁免）",
         {"docs/A.md": "字符集 `` `#%:<>?[\\]^\\`{|}` `` 里没有它。\n"}, None),
        ("**跨行**引号里的人称也不报（引号跨度允许跨行）",
         {"docs/A.md": "**禁止**假设「窗口里当前那块视图\n就是我」。\n"}, None),
        ("`其他` 的 `他` 不算人称（环视排掉）",
         {"docs/A.md": "其他情况见那一节。\n"}, None),
        ("`它` 仍然不判（指物，1497 处）",
         {"docs/A.md": "作业跑完时它会自动回收。\n"}, None),
        ("反引号里的 `他` 是占位符，不报",
         {"docs/A.md": "形状是 `{ \"uid\": \"<他>\" }`。\n"}, None),
        ("两份记录类不受 G 管",
         {"CHANGELOG.md": "我们当时改了你说的那处。\n"}, None),
        # ── 夹具：整棵 `tools/conformance/tree/**` 都不判 ───────────────
        ("夹具里的「我」不报（那一棵树的字节被 expected.json 钉住）",
         {"tools/conformance/tree/README.md": "我第一版就叫了 `nul.bin`。\n"}, None),
        ("夹具下**更深一层**的 md 同样不报（前缀匹配，不是逐份列名）",
         {"tools/conformance/tree/sub/A.md": "从前这里有一份。\n"}, None),
        ("★ 但 `tools/` 下**不在夹具里**的 md 照判",
         {"tools/conformance/README.md": "你改这一份。\n"}, "「你」"),
    ]
    bad = []
    for why, files, expect in cases:
        got = "\n".join(msg for _, msg in problems_from(files))
        if expect is None:
            if got:
                bad.append("假红：%s —— 报了 %r" % (why, got))
        elif expect not in got:
            bad.append("没抓到：%s（期望出现 %r，实际 %r）" % (why, expect, got))
    if bad:
        for b in bad:
            print("✗ %s" % b)
        return 1
    n_bad = sum(1 for _, _, e in cases if e is not None)
    n_ok = len(cases) - n_bad
    print("✓ 反向自测通过：%d 种坏样本都被抓到，%d 种假红样本都没被误判"
          % (n_bad, n_ok))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=ROOT)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    return run(args.root)


if __name__ == "__main__":
    sys.exit(main())
