#!/usr/bin/env python3
# -*- coding: utf-8 -*-
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

"""
conf-merge.py — 站点配置对账：升级时把旧配置对齐到这一版的键

用法
----
    conf-merge.py --installed 旧配置 --example 这一版的示例 --out 合并结果
    conf-merge.py --looks-like-config 文件 --example 这一版的示例

用途
----
站点配置是管理员按本站改过的，升级时不能整份覆盖；但它的键集合跟着版本走：
新版本会有新键，旧键会被删掉。守护进程对认不出的键是拒绝启动，而不是忽略
（见 `validate()` 那一处），所以从旧版本升上来的机器若原样留着旧键，装完之后
守护进程无法启动。这一份把两件事分开做：取值不动，键对齐。

它做三件事，顺序是定的：

    1. 认得的键取自示例：示例里写出来的每一个键（活的 `键 = 值` 与注释掉的
       `# 键 = 值` 都算）。示例与守护进程的 `GLOBAL_KEYS` 由用例钉着相等，
       所以这里不抄第二份名单。
    2. 旧配置里这一版不认的活键，删掉那一行，并在报告里原样列出来。
       注释掉的行不动：它是文字，不是配置。
    3. 旧配置里整节都没提到过的块，补到文件末尾。示例按空行分块；一块里的键
       只要有一个已经在旧配置里出现过，这一块就不补（那一节本来就是站点的）。

取值一个都不改：旧配置里认得的键原样留着，顺序与注释也不动。补进来的那一节
与示例逐字相同（新键在示例里本来就是注释掉的缺省，于是补进来也不改变行为）。

对同一份文件连做两次，结果不变。

退出码
------
    0  对账完成（结果写到 --out）
    1  读取或写入失败
    2  参数不对
"""

import argparse
import re
import sys

# 活键：行首可有空白，`键 = 值`。行尾注释不影响识别。
KEY_ACTIVE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=")
# 注释里的键：示例用它写"缺省是什么"。它算认得，但不算配置。
KEY_COMMENTED = re.compile(r"^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=")


def active_key(line):
    m = KEY_ACTIVE.match(line)
    return m.group(1) if m else None


def mentioned_key(line):
    m = KEY_ACTIVE.match(line) or KEY_COMMENTED.match(line)
    return m.group(1) if m else None


def split_blocks(text):
    """按空行分块。块是补进旧配置的最小单位：一节说明连同它的键一起走。"""
    blocks, cur = [], []
    for line in text.splitlines():
        if line.strip() == "":
            if cur:
                blocks.append(cur)
                cur = []
            continue
        cur.append(line)
    if cur:
        blocks.append(cur)
    return blocks


def example_keys(example_text):
    """示例认得的所有键（活的与注释掉的都算）。"""
    out = set()
    for line in example_text.splitlines():
        k = mentioned_key(line)
        if k:
            out.add(k)
    return out


def merge(installed_text, example_text):
    """旧配置 → 对齐后的文本。返回 `(文本, 删掉的行, 补上的键)`。"""
    known = example_keys(example_text)

    kept, removed = [], []
    dropped = False
    for line in installed_text.splitlines():
        k = active_key(line)
        if k is not None and k not in known:
            removed.append(line.strip())
            dropped = True
            continue
        # 被删的那一行原先把一段劈成两半时，后面的空行只留一个 —— 否则删两行
        #   就在文件顶上留下两个空行，读起来像有人手工改坏过。
        if dropped and line.strip() == "" and kept and kept[-1].strip() == "":
            dropped = False
            continue
        dropped = False
        kept.append(line)

    have = set()
    for line in kept:
        k = mentioned_key(line)
        if k:
            have.add(k)

    extra, added = [], []
    for block in split_blocks(example_text):
        keys = []
        for line in block:
            k = mentioned_key(line)
            if k and k not in keys:
                keys.append(k)
        if not keys or (set(keys) & have):
            continue
        extra.append(block)
        added.extend(keys)
        have |= set(keys)

    out = "\n".join(kept).rstrip("\n")
    for block in extra:
        out += "\n\n" + "\n".join(block)
    if out:
        out += "\n"
    return out, removed, added


def looks_like_config(text, example_text):
    """这份文件是不是本系统的站点配置。

    判据不是"内容里有没有 slurmate"：配置文件里只有键与值，从第一版起就一个
    字都不提产品名。取"至少有一个活键是这一版认得的键"——别人的文件落在
    `/etc/slurmate/slurmate.conf` 这个位置、又恰好长成这样，几乎不可能。
    """
    known = example_keys(example_text)
    for line in text.splitlines():
        k = active_key(line)
        if k is not None and k in known:
            return True
    return False


def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def main(argv):
    ap = argparse.ArgumentParser(
        prog="conf-merge.py",
        description="站点配置对账：取值不动，键对齐到这一版")
    ap.add_argument("--example", required=True,
                    help="这一版随包分发的示例配置")
    ap.add_argument("--installed", help="已装的那份站点配置")
    ap.add_argument("--out", help="合并结果写到哪")
    ap.add_argument("--looks-like-config", dest="probe",
                    help="只判这一份文件是不是本系统的配置，不写任何文件")
    args = ap.parse_args(argv)

    try:
        example_text = read_text(args.example)
    except OSError as e:
        print("读取示例配置失败：%s" % e, file=sys.stderr)
        return 1

    if args.probe:
        try:
            text = read_text(args.probe)
        except OSError as e:
            print("读取 %s 失败：%s" % (args.probe, e), file=sys.stderr)
            return 1
        return 0 if looks_like_config(text, example_text) else 1

    if not args.installed or not args.out:
        ap.error("要么给 --installed 与 --out，要么给 --looks-like-config")

    try:
        installed_text = read_text(args.installed)
    except OSError as e:
        print("读取站点配置失败：%s" % e, file=sys.stderr)
        return 1

    out, removed, added = merge(installed_text, example_text)
    try:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out)
    except OSError as e:
        print("写入合并结果失败：%s" % e, file=sys.stderr)
        return 1

    # 没有改动就一个字都不说：升级时那几屏已经够长了。
    if removed:
        print("删掉 %d 行这一版不认的键（原样留在备份里）：" % len(removed))
        for line in removed:
            print("    %s" % line)
    if added:
        print("补上 %d 个文件里没有的键（按示例原样写，缺省不变）："
              % len(added))
        print("    %s" % "、".join(added))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
