#!/usr/bin/env python3
"""公开文档里不用图形符号做强调（`CONTRIBUTING.md`〈公开文档用规范体〉）。

判据一条，是机械的：

    B1  公开文档的正文里，不许出现 Unicode 那几个"图形符号"区里的字符 ——
        Miscellaneous Symbols（U+2600–U+26FF）、Dingbats（U+2700–U+27BF）、
        Miscellaneous Symbols and Arrows（U+2B00–U+2BFF）、Emoji（U+1F000–U+1FAFF）、
        以及变体选择符（U+FE0F）。

★ **"公开文档"按文件判，不按"公开"这个形容词判**：`git ls-files '*.md'` 减去
  `CHANGELOG.md` 与 `docs/KNOWN-ISSUES.md`。那两份是**记录** —— 按时间累积、按编号
  引用，读者要的是"当时发生了什么"，符号在那里是有用的。

★★ **一类豁免：反引号跨度（`` `…` ``）里的字符。** 那是**字面量**，不是排版：
  程序真的会打印 `★` 与 `⚠`（`cluster/slurmate`、`cluster/slurmate-sessiond` 的
  `--check`），符合性夹具里也真的有 `cases/😀.txt` 这个文件。不豁免的话，文档就没法
  如实描述程序行为，而"如实"是这个项目里比"好看"更硬的一条。

★ **`→` `←` `↔` `⇒` 是允许的**（Unicode Arrows 区，U+2190–U+21FF）。它们不表强调，
  它们**表意**："变成"、"来自"、"互指"、"推出"，与 `+`、`=` 同类。判定线划在这里，
  是因为"图形符号"与"排版符号"是两件事 —— 前者靠颜色与形状抢注意力，是**喊话**；
  后者是句子成分，换掉它就换了句子的意思。

★ 围栏代码块**不豁免**：文档里那些围栏装的是目录树与伪代码，是**给人读的正文**，
  不是可执行的真代码。真到了"文档要展示程序输出的字符"那一天，那是一条**具名**的
  例外，不是一整类。

用法：
    python3 tools/check-doc-style.py                # 扫整个仓库
    python3 tools/check-doc-style.py --self-test    # 种坏样本，断言它真的会红
"""

import argparse
import os
import subprocess
import sys
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

EXEMPT = ("CHANGELOG.md", "docs/KNOWN-ISSUES.md")

# 反引号跨度。奇数索引那几段是**代码**，它们豁免。
CODE = re.compile(r"(`[^`]*`)")

# 禁的区间（含端点）。Arrows（U+2190–U+21FF）**不在**这里 —— 见文件头。
BANNED = (
    (0x2600, 0x27BF, "Miscellaneous Symbols / Dingbats"),
    (0x2B00, 0x2BFF, "Miscellaneous Symbols and Arrows"),
    (0x1F000, 0x1FAFF, "Emoji"),
    (0xFE0F, 0xFE0F, "变体选择符"),
)


def is_banned(ch):
    cp = ord(ch)
    for lo, hi, name in BANNED:
        if lo <= cp <= hi:
            return name
    return None


def code_spans(line):
    """这一行里**是代码**的那几段（反引号跨度，含反引号本身）。"""
    return CODE.split(line)[1::2]


def prose(text):
    """这一行里**不是代码**的部分。"""
    return CODE.split(text)[::2]


def problems_from(files):
    """`files` 是 `{仓库相对路径: 文本}`。

    返回一张问题清单（空 = 全过）。判据本身不碰磁盘，于是它能被单独验 ——
    真实运行时由 `read_repo()` 填，自测时由手写的小字典填。
    """
    out = []
    for rel, text in sorted(files.items()):
        if rel in EXEMPT:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            bad = []
            for part in prose(line):
                for ch in part:
                    name = is_banned(ch)
                    if name:
                        bad.append((ch, name))
            if bad:
                names = "、".join(sorted({"%s（U+%04X）" % (n, ord(c)) for c, n in bad}))
                out.append("%s:%d：正文里有 %s —— %s"
                           % (rel, i, names, line.strip()[:64]))
    return out


def exempt_count(files):
    """反引号跨度里的图形符号有几处 —— 那是**合法**的字面量，让这个区分看得见。"""
    n = 0
    for rel, text in files.items():
        if rel in EXEMPT:
            continue
        for line in text.splitlines():
            for span in code_spans(line):
                n += sum(1 for ch in span if is_banned(ch))
    return n


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
    for p in problems:
        print("✗ %s" % p)
    if problems:
        print("\n✗ 有 %d 行正文里带着图形符号。要使用的是**位置**（节首）与"
              " **`**加粗**`**，不是图标 —— 见 `CONTRIBUTING.md`〈公开文档用规范体〉。"
              % len(problems))
        return 1
    n = sum(1 for r in files if r not in EXEMPT)
    print("✓ %d 份公开文档：正文里一个图形符号都没有" % n)
    print("  （另有 %d 处在反引号跨度里 —— 那是字面量（程序真的会打印它们），"
          "不是排版）" % exempt_count(files))
    print("  （箭头 `→` `←` `↔` `⇒` 是允许的：它们表意，不表强调）")
    return 0


def self_test():
    """种坏样本，断言这条检查**真的会红**。

    ★ 没有这一步，"检查通过"与"检查根本没在看"分不开（先例：
      `tools/self-test-sanitized.sh`）。
    """
    cases = [
        # ── 四种坏样本：每一种都必须被抓到 ──────────────────────────────
        ("★ 做强调", {"docs/A.md": "★ **判据。**\n"}, "U+2605"),
        ("⚠ 做强调", {"docs/A.md": "⚠ 注意这一条。\n"}, "U+26A0"),
        ("✅ / ❌ 当状态标记", {"docs/A.md": "| a | ✅ |\n| b | ❌ |\n"}, "U+2705"),
        ("📌 这类 emoji", {"docs/A.md": "> 📌 记一笔。\n"}, "U+1F4CC"),
        ("围栏代码块里的也**要**抓（目录树是正文）",
         {"docs/A.md": "```\nplugins/   ★ 独立项目\n```\n"}, "U+2605"),
        # ── 四种假红防线：一个都不许误判 ────────────────────────────────
        ("反引号里的字面量不算（程序真的会打印它）",
         {"docs/A.md": "`--check` 打印 `⚠`、`slurmate` 打 `★`。\n"}, None),
        ("夹具文件名里的 emoji 不算（它在反引号里）",
         {"docs/A.md": "`cases/😀.txt` 就是为这条准备的。\n"}, None),
        ("箭头是允许的",
         {"docs/A.md": "作者 → 站点，而 A ⇒ B。\n"}, None),
        ("两份记录类不受这条管",
         {"CHANGELOG.md": "★ 这一版记一笔\n", "docs/KNOWN-ISSUES.md": "⚠ 未实测\n"}, None),
    ]
    bad = []
    for why, files, expect in cases:
        got = "\n".join(problems_from(files))
        if expect is None:
            if got:
                bad.append("假红：%s —— 报了 %r" % (why, got))
        elif expect not in got:
            bad.append("没抓到：%s（期望出现 %r，实际 %r）" % (why, expect, got))
    if bad:
        for b in bad:
            print("✗ %s" % b)
        return 1
    print("✓ 反向自测通过：五种坏样本都被抓到，四种假红样本都没被误判")
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
