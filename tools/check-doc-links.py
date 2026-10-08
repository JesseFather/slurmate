#!/usr/bin/env python3
"""文档（以及源码注释）里写的仓库内路径，必须真的存在。

判据两条，都是机械的：

    A1  任何被跟踪的文本文件里，形如 `docs/<名>.md` 的路径串，必须指向一个
        存在的文件（相对仓库根）。**源码注释里的指路是这一条管的。**
    A2  `.md` 里每个 `](目标)` 的**相对**链接，目标必须存在（相对该文件所在目录）。

★ 为什么要有这一条：`docs/` 下那几份要按分发单元搬家（`docs/DOC-LAYOUT.md`），
  而**今天断一条链接不会红任何东西** —— 239 条相对链接、三十来处源码注释里的
  指路，全靠人眼。搬完少改一处，读者点进去是空的，而没有一份检查会说话。
  先立网再搬。

★★ 两个集合是**分开**的，别把它们合成一个 —— 第一版就是合成了一个，于是它对着
  一份**存在但还没 `git add`** 的草稿报断链（读者在工作区里明明看得见它）：

    · **扫描集**（读谁的正文）＝ `git ls-files`，被跟踪的文件。那是"这个仓库
      **发布**出去的字节"。
    · **判据集**（什么算"存在"）＝ 盘上真实存在的路径 ＋ `--others` 那些未跟踪
      但没被 ignore 的。**目录也算** —— `[plugins/](../plugins/)` 是一条合法指路。

已知的**故意**宽松，都写在这里，免得日后被当成漏洞：

  · **不查锚点**（`foo.md#某一节` 只查 `foo.md`）。锚点 slug 的算法是各渲染器
    自己的事，按它判会制造一批假红，而假红会让这条检查被绕过。
  · **不查 URL**（`http://` / `https://` / `mailto:`）。那是别人的可达性，
    不是这个仓库的形状。
  · **`tools/check-*.py` 不进扫描集**。那几个文件讲的就是路径本身：它们的自测
    样本里写着一些**故意不存在**的 `docs/*.md`（`docs/A.md` 之类）—— 那是判据的
    **输入**，不是一条指路。不排除的话，这条检查会被自己的样本喂出十几条假红。
    ★ 代价写明：在那几个文件里**真的**写一条指路，这条检查看不见 —— 它们是检查器，
    守的是别人，不是自己，这个代价划算。
    ★★ 而这个坑踩过一次，值得记：第一版没排除，**而它当时是绿的** —— 因为
    `check-doc-links.py` 自己还没 `git add`，根本不在扫描集里。提交之后才红。
    「新加的检查器要 `git add` 之后再验一遍」是这一步的教训。

用法：
    python3 tools/check-doc-links.py                # 扫整个仓库
    python3 tools/check-doc-links.py --self-test    # 种坏样本，断言它真的会红
"""

import argparse
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# A1：裸的仓库相对路径。负向断言挡住 URL 尾巴与 `../docs/` 那种写法
# （`../` 打头的由 A2 在该文件自己的坐标系里管）。
BARE = re.compile(r"(?<![A-Za-z0-9_./-])docs/[A-Za-z0-9_.-]+\.md")

# A2：markdown 相对链接。
LINK = re.compile(r"\]\(([^)\s]+)\)")

FENCE = re.compile(r"^\s*(```|~~~)")

# 不进扫描集：检查器脚本自己 —— 它们的自测样本里写着**故意不存在**的路径（见文件头）。
SKIP_SCAN = re.compile(r"^tools/check-[^/]*\.py$")


def is_text(path):
    """二进制文件不扫 —— 里面偶然出现的一串字节不是一条指路。"""
    try:
        with open(path, "rb") as f:
            return b"\0" not in f.read(8192)
    except OSError:
        return False


def stripped_lines(text):
    """逐行产出，但**围栏代码块里的行不产出**。

    ★ 文档里嵌着 ini / shell / 目录树片段，里面的 `](` 或 `docs/x.md` 是**样例**，
      不是一条指路。不剥掉的话，这一条会被自己的举例喂出一堆假红。
    """
    inside = False
    for line in text.splitlines():
        if FENCE.match(line):
            inside = not inside
            continue
        if not inside:
            yield line


def with_dirs(paths):
    """把"存在的东西"补全：一个文件的存在蕴含它每一级祖先目录的存在。

    ★ 少了这一步，`[plugins/](../plugins/)` 会被判成断链 —— 而它指的东西明明在。
    """
    out = set(paths)
    for p in paths:
        d = os.path.dirname(p)
        while d and d != ".":
            out.add(d)
            d = os.path.dirname(d)
    return out


def problems_from(files, present):
    """`files` 是 `{仓库相对路径: 文本}`；`present` 是"什么算存在"的那一集。

    返回一张问题清单（空 = 全过）。真实运行时由 `read_repo()` / `repo_paths()` 填，
    自测时由手写的小字典填 —— 判据本身不碰磁盘，于是它能被单独验。
    """
    out = []

    for rel, text in sorted(files.items()):
        for line in stripped_lines(text):
            # ── A1：裸路径（源码注释、`.md` 里的反引号指路都算）────────────
            for m in BARE.finditer(line):
                tgt = m.group(0)
                if tgt not in present:
                    out.append("%s：写的路径不存在 —— `%s`" % (rel, tgt))

            # ── A2：`.md` 里的相对链接 ─────────────────────────────────
            if not rel.endswith(".md"):
                continue
            base = os.path.dirname(rel)
            for m in LINK.finditer(line):
                tgt = m.group(1)
                if tgt.startswith(("http://", "https://", "mailto:", "#")):
                    continue
                path = tgt.split("#")[0]        # 锚点不查，见文件头
                if not path:
                    continue
                resolved = os.path.normpath(os.path.join(base, path))
                if resolved.startswith(".."):
                    continue                    # 指到仓库外 —— 不是这个仓库的形状
                if resolved not in present:
                    out.append("%s：断链 —— `%s`（解析成 `%s`）"
                               % (rel, tgt, resolved))
    return out


def _ls_files(root, *extra):
    return subprocess.run(["git", "ls-files"] + list(extra), cwd=root,
                          capture_output=True, text=True, check=True).stdout.splitlines()


def read_repo(root):
    """**扫描集**：被跟踪的文本文件 —— 发布出去的字节。

    ★ 检查器脚本自己（`SKIP_SCAN`）不在其中：它们的正文是判据的**输入**，
      不是给读者的指路。见文件头。
    """
    files = {}
    for rel in _ls_files(root):
        if SKIP_SCAN.match(rel):
            continue
        full = os.path.join(root, rel)
        if not os.path.isfile(full) or not is_text(full):
            continue
        try:
            with open(full, encoding="utf-8") as f:
                files[rel] = f.read()
        except (OSError, UnicodeDecodeError):
            continue
    return files


def repo_paths(root):
    """**判据集**：盘上真实存在的路径（含目录、含未跟踪但没被 ignore 的）。

    ★ 用 `--others` 而不是只看被跟踪的：一份**已经写出来、读者在工作区里看得见、
      只是还没 `git add`** 的草稿（本仓库今天就有两份），拿它当"不存在"是错的。
    """
    return with_dirs(_ls_files(root, "--cached", "--others", "--exclude-standard"))


def run(root):
    files = read_repo(root)
    present = repo_paths(root)
    problems = problems_from(files, present)
    for p in problems:
        print("✗ %s" % p)
    if problems:
        print("\n✗ 有 %d 处指路指不到东西。写的路径必须真的存在 ——"
              " 搬家时漏改一条，读者点进去是空的。" % len(problems))
        return 1
    n_md = sum(1 for r in files if r.endswith(".md"))
    extra = len(present - set(files))
    n_skip = sum(1 for r in _ls_files(root) if SKIP_SCAN.match(r))
    print("✓ %d 份文档、%d 份被跟踪的文件：每条相对链接与每处 `docs/*.md` 指路都指得到"
          % (n_md, len(files)))
    print("  （判据集另有 %d 个目录／未跟踪但盘上存在的东西 —— 指到它们是合法的）"
          % extra)
    print("  （另有 %d 份检查器脚本没扫 —— 它们的样本里写着故意不存在的路径，"
          "那不是指路）" % n_skip)
    return 0


def self_test():
    """种坏样本，断言这条检查**真的会红**。

    ★ 没有这一步，"检查通过"与"检查根本没在看"分不开（先例：
      `tools/self-test-sanitized.sh`）。
    """
    good = {
        "docs/A.md": "见 [B](B.md) 与 `docs/C.md`。\n",
        "docs/B.md": "# B\n",
        "docs/C.md": "# C\n",
    }
    cases = [
        ("断链：链接指到一个不存在的文件",
         {"docs/A.md": "见 [B](B.md) 与 [D](D.md)。\n", "docs/B.md": ""},
         "docs/A.md：断链"),
        ("断链：源码注释里的 `docs/*.md` 不存在",
         {"docs/A.md": "见 `docs/NOPE.md`。\n"},
         "docs/A.md：写的路径不存在"),
        ("子目录里的相对链接算错层",
         {"docs/A.md": "见 [B](sub/B.md)。\n"},
         "docs/A.md：断链"),
        ("围栏代码块里的举例**不**算指路（假红防线）",
         {"docs/A.md": "```\n见 [B](NOPE.md) 与 `docs/ALSO-NOPE.md`\n```\n"},
         None),
        ("锚点不查（假红防线）",
         {"docs/A.md": "见 [B](B.md#某一节)。\n", "docs/B.md": ""},
         None),
        ("URL 不查（假红防线）",
         {"docs/A.md": "见 [x](https://example.com/docs/NOPE.md)。\n"},
         None),
        ("指到一个**目录**是合法的（假红防线）",
         {"docs/A.md": "见 [plugins](../plugins/)。\n", "plugins/x/.keep": ""},
         None),
    ]
    bad = []
    for why, files, expect in cases:
        got = "\n".join(problems_from(files, with_dirs(files)))
        if expect is None:
            if got:
                bad.append("假红：%s —— 报了 %r" % (why, got))
        elif expect not in got:
            bad.append("没抓到：%s（期望出现 %r，实际 %r）" % (why, expect, got))
    if bad:
        for b in bad:
            print("✗ %s" % b)
        return 1
    print("✓ 反向自测通过：三种坏样本都被抓到，四种假红样本都没被误判")
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
