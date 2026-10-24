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

"""手写的键表必须与权威键集逐字一致 —— 两处，同一个形状。

判据一：插件文档里的〈配置条目〉表

    一个插件认得的全部键 ＝ 守护进程的 `PLUGIN_COMMON_KEYS` ＋ `"bin"`
                            ＋ 它 `plugin.json` 的 `site.enumKeys` 里的键
                            （正是 `PluginSpec.conf_keys()` 那一句）

    而 `plugins/<目录>/README.md` 的〈配置条目〉一节里列出来的键，
    必须恰好是这一集 —— 少一个、多一个都算漂。

 为什么要有这一条：那张表是手写给人读的（不是 schema 的另一个副本），而手抄
  的表会漂 —— 一个键改了名、一个插件多加一个 `enumKeys`，表里不会跟着动，而
  漂了不会红任何东西。这条 lint 把「表的权威是清单」变成机器判据，于是
  README 可以放心当那份表唯一给人读的家（`docs/README.md` 的 P1）。

 判据只有一处：键集合从守护进程那个常量与清单算出来，这里不再抄一份。

判据二：`packer/docs/PLUGIN-SPEC.md` §2 的清单键表

    那一张表的键集，必须恰好是 `tools/manifest-keys.json` 里那五张表展开成路径
    的结果（展开规则见下面 `SPEC_PARENTS` 那一段的注释）。

 为什么要有这一条：那张表是插件作者查「这一格写什么」的地方，而它与权威键集
  之间本来没有任何东西挡着 —— 与判据一同一个理由。

用法：
    python3 tools/check-plugin-docs.py                # 本仓库不收录插件：只判判据二
    python3 tools/check-plugin-docs.py --plugins-dir <插件项目所在目录>
    python3 tools/check-plugin-docs.py --self-test    # 种坏样本，断言它真的会红
"""

import argparse
import importlib.machinery
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DAEMON = os.path.join(ROOT, "cluster", "slurmate-sessiond")

# 一节的开头。逐字匹配：它同时是"这张表在哪"的判据，而含糊的开头会让
# 抽取悄悄抓到别处的表格。
SECTION = "### 配置条目"

# 表格行：第一格是一个反引号包起来的键名。
ROW = re.compile(r"^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|")

# ── 判据二：`packer/docs/PLUGIN-SPEC.md` 的清单键表 ─────────────────────────
#
# 那一张表的键集必须恰好是 `tools/manifest-keys.json` 里那五张表展开成路径的
# 结果。展开的规则是死的：清单顶层键原样；`contributes` 下的加 `contributes.`
# 前缀；`surface` / `login` / `data` 三张再各加一层。另外补一个 `engines.slurmate`
# —— 它是 `keysProblem(engines, ['slurmate'], …)` 认的唯一子键，而 `engines`
# 本身在 JSON 里没有子表。
#
# 为什么这条判据值得存在：那张表是插件作者查「这一格写什么」的地方，而它
#   与权威键集之间本来没有任何东西挡着 —— 键改名、加一个键，表不会跟着动，而
#   漂了不会红任何东西。与判据一同一个理由，也就是本文件的文件头。
SPEC = os.path.join(ROOT, "packer", "docs", "PLUGIN-SPEC.md")
MANIFEST_KEYS = os.path.join(ROOT, "tools", "manifest-keys.json")

# 表头要逐字对上 —— 含糊的开头会让抽取悄悄抓到别处的表格。
SPEC_TABLE_HEAD = "| 键 | 类型 | 必填 | 取值域 | 违反的后果 | 详见 |"
SPEC_ROW = re.compile(r"^\|\s*`([A-Za-z][A-Za-z0-9_.]*)`\s*\|")

# 展开成路径时要多走一层的那三张子表。
SPEC_PARENTS = ("surface", "login", "data")


def conf_keys_of_daemon():
    """守护进程那份 `PLUGIN_COMMON_KEYS` —— import，不重写一遍。"""
    ldr = importlib.machinery.SourceFileLoader("d", DAEMON)
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("d", ldr))
    ldr.exec_module(mod)
    return set(mod.PLUGIN_COMMON_KEYS) | {"bin"}


def expected_keys(plugin_dir, base):
    """这个插件应该在表里出现的全部键。"""
    with open(os.path.join(plugin_dir, "plugin.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    enum = (manifest.get("site") or {}).get("enumKeys") or {}
    return base | set(enum.keys())


def documented_keys(readme_path):
    """README 的〈配置条目〉一节里，表格第一列那些键名。

    返回 `None` 表示连那一节都没有（与"表是空的"是两件事）。
    """
    if not os.path.exists(readme_path):
        return None
    keys, inside = set(), False
    with open(readme_path, encoding="utf-8") as f:
        for line in f:
            if line.startswith(SECTION):
                inside = True
                continue
            if not inside:
                continue
            if line.startswith("#"):        # 下一个标题，这一节到底了
                break
            m = ROW.match(line)
            if m:
                keys.add(m.group(1))
    return keys if inside else None


def spec_table_keys(spec_path):
    """`PLUGIN-SPEC.md` 清单键表的第一列 —— `contributes.data.inherit` 这种路径。

    `None` 表示连那张表都没有（与"表是空的"是两件事）。
    """
    if not os.path.exists(spec_path):
        return None
    keys, inside = set(), False
    with open(spec_path, encoding="utf-8") as f:
        for line in f:
            if line.rstrip("\n") == SPEC_TABLE_HEAD:
                inside = True
                continue
            if not inside:
                continue
            if not line.startswith("|"):     # 表格到底了
                break
            m = SPEC_ROW.match(line)
            if m:
                keys.add(m.group(1))
    return keys if inside else None


def manifest_key_paths(keys_path):
    """`manifest-keys.json` 那五张表展开成一张路径集 —— 规则见文件头。"""
    with open(keys_path, encoding="utf-8") as f:
        written = json.load(f)
    out = set(written["manifest"])
    out |= {"contributes." + k for k in written["contributes"]}
    for parent in SPEC_PARENTS:
        out |= {"contributes.%s.%s" % (parent, k) for k in written[parent]}
    out.add("engines.slurmate")
    return out


def check_manifest_table(spec_path, keys_path):
    """PLUGIN-SPEC 的键表 vs 权威键集。返回问题清单（空 = 全过）。"""
    want = manifest_key_paths(keys_path)
    got = spec_table_keys(spec_path)
    if got is None:
        return ["%s：找不到清单键表（表头要逐字是 %s）" % (spec_path, SPEC_TABLE_HEAD)]
    problems = []
    missing = sorted(want - got)
    extra = sorted(got - want)
    if missing:
        problems.append("%s：键表缺 %s" % (spec_path, "、".join(missing)))
    if extra:
        problems.append("%s：键表多了 %s（manifest-keys.json 里没有）"
                        % (spec_path, "、".join(extra)))
    return problems


def check(plugins_dir, base):
    """返回一张问题清单（空 = 全过）。"""
    if not os.path.isdir(plugins_dir):
        return ["插件目录不存在：%s" % plugins_dir]
    problems = []
    for name in sorted(os.listdir(plugins_dir)):
        plugin_dir = os.path.join(plugins_dir, name)
        if not os.path.isfile(os.path.join(plugin_dir, "plugin.json")):
            continue
        want = expected_keys(plugin_dir, base)
        got = documented_keys(os.path.join(plugin_dir, "README.md"))
        if got is None:
            problems.append("%s：README.md 里没有〈%s〉一节"
                            % (plugin_dir, SECTION.lstrip("# ")))
            continue
        missing = sorted(want - got)
        extra = sorted(got - want)
        if missing:
            problems.append("%s：表里**缺** %s" % (plugin_dir, "、".join(missing)))
        if extra:
            problems.append("%s：表里**多**了 %s（清单里没有这几个键）"
                            % (plugin_dir, "、".join(extra)))
    return problems


def run(plugins_dir, have_plugins=True):
    """`have_plugins` 为假 = 这个仓库没有插件目录，判据一不判（判据二照判）。"""
    base = conf_keys_of_daemon()
    problems = check(plugins_dir, base) if have_plugins else []
    problems += check_manifest_table(SPEC, MANIFEST_KEYS)
    for p in problems:
        print("✗ %s" % p)
    if problems:
        print("\n✗ 手写的键表与权威键集对不上（%d 处）。前者的权威是 plugin.json 与"
              " PLUGIN_COMMON_KEYS，后者的权威是 tools/manifest-keys.json ——"
              "改键就要改表。" % len(problems))
        return 1
    if not have_plugins:
        print("（本仓库不收录任何插件，判据一没有对象；插件项目的〈配置条目〉表"
              "用 --plugins-dir 指过去判。）")
    else:
        n = sum(1 for d in sorted(os.listdir(plugins_dir))
                if os.path.isfile(os.path.join(plugins_dir, d, "plugin.json")))
        print("✓ %d 个插件的〈配置条目〉表与各自清单逐字一致" % n)
    print("✓ PLUGIN-SPEC.md 的清单键表与 tools/manifest-keys.json 逐字一致")
    return 0


def self_test():
    """种坏样本，断言这条检查真的会红。

     没有这一步，"检查通过"与"检查根本没在看"分不开 —— 那条纪律在本仓库有一条
      现成的先例（`tools/self-test-sanitized.sh`）。
    """
    base = conf_keys_of_daemon()
    good = sorted(base)
    tmp = tempfile.mkdtemp(prefix="slurmate-plugin-docs-selftest-")
    try:
        def plant(name, site, keys):
            d = os.path.join(tmp, name)
            os.makedirs(d)
            with open(os.path.join(d, "plugin.json"), "w", encoding="utf-8") as f:
                json.dump({"site": site}, f)
            with open(os.path.join(d, "README.md"), "w", encoding="utf-8") as f:
                f.write("## 站点侧\n\n%s\n\n| 键 |\n|---|\n" % SECTION)
                for k in keys:
                    f.write("| `%s` |\n" % k)

        plant("ok", {}, good)                              # 一份对的
        plant("short", {}, good[:-1])                      # 少一个键
        plant("long", {}, good + ["zzz_not_a_real_key"])   # 多一个键
        plant("enum", {"enumKeys": {"extra_key": {}}}, good)  # 清单多声明了一个
        plant("no_section", {}, good)                      # 连那一节都没有
        with open(os.path.join(tmp, "no_section", "README.md"), "w",
                  encoding="utf-8") as f:
            f.write("## 站点侧\n\n没有配置条目那一节。\n")


        # ── 判据二的样本：临时写几份 PLUGIN-SPEC，权威那一份仍读真的 ──────
        def plant_spec(name, rows):
            p = os.path.join(tmp, name + ".md")
            with open(p, "w", encoding="utf-8") as f:
                f.write("## 2. 插件必须做什么\n\n%s\n|---|---|---|---|---|\n"
                        % SPEC_TABLE_HEAD)
                for r in rows:
                    f.write("| `%s` | 字符串 | 否 | 任意 | 拒 | §1 |\n" % r)
            return p

        paths = sorted(manifest_key_paths(MANIFEST_KEYS))
        spec_ok = plant_spec("spec_ok", paths)
        spec_short = plant_spec("spec_short", paths[:-1])
        spec_long = plant_spec("spec_long", paths + ["contributes.zzz"])
        spec_none = os.path.join(tmp, "spec_none.md")
        with open(spec_none, "w", encoding="utf-8") as f:
            f.write("## 2. 这里没有那张表。\n")

        got = "\n".join(check(tmp, base))
        bad = []
        for frag, why in (
            ("short：表里**缺**", "少一个键"),
            ("long：表里**多**了", "多一个键"),
            ("enum：表里**缺**", "清单多声明了一个 enumKey"),
            ("no_section：README.md 里没有", "缺整节"),
        ):
            if frag not in got:
                bad.append("种入的坏样本没被抓到：%s（%s）" % (frag, why))
        if os.path.join(tmp, "ok") in got:
            bad.append("把一份**对的** README 判成了错的（误报）")

        for frag, why, path in (
            ("spec_short.md：键表缺", "键表少一个键", spec_short),
            ("spec_long.md：键表多了", "键表多一个键", spec_long),
            ("spec_none.md：找不到清单键表", "连那张表都没有", spec_none),
        ):
            g = "\n".join(check_manifest_table(path, MANIFEST_KEYS))
            if frag not in g:
                bad.append("种入的坏样本没被抓到：%s（%s）" % (frag, why))
        if check_manifest_table(spec_ok, MANIFEST_KEYS):
            bad.append("把一份**对的**键表判成了错的（误报）")

        if bad:
            for b in bad:
                print("✗ %s" % b)
            return 1
        print("✓ 反向自测通过：七种坏样本都被抓到，两份对的没有被误判")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plugins-dir", default=None,
                    help="插件项目所在的目录；缺省时看仓库里有没有 plugins/")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if args.plugins_dir is not None:
        return run(args.plugins_dir)
    d = os.path.join(ROOT, "plugins")
    return run(d, os.path.isdir(d))


if __name__ == "__main__":
    sys.exit(main())
