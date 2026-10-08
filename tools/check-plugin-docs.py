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

"""插件文档里的〈配置条目〉表，必须与插件**认得**的键逐字一致。

判据（一条，机械的）：

    一个插件认得的全部键 ＝ 守护进程的 `PLUGIN_COMMON_KEYS` ＋ `"bin"`
                            ＋ 它 `plugin.json` 的 `site.enumKeys` 里的键
                            （正是 `PluginSpec.conf_keys()` 那一句）

    而 `plugins/<目录>/README.md` 的〈配置条目〉一节里列出来的键，
    必须**恰好**是这一集 —— 少一个、多一个都算漂。

★ 为什么要有这一条：那张表是**手写给人读的**（不是 schema 的另一个副本），而手抄
  的表会漂 —— 一个键改了名、一个插件多加一个 `enumKeys`，表里不会跟着动，而
  **漂了不会红任何东西**。这条 lint 把「表的权威是清单」变成机器判据，于是
  README 可以放心当那份表**唯一给人读的家**（`docs/README.md` 的 P1）。

★ 判据只有一处：键集合从守护进程那个常量与清单算出来，**这里不再抄一份**。

用法：
    python3 tools/check-plugin-docs.py                # 扫仓库里的 plugins/
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

# 一节的开头。**逐字**匹配：它同时是"这张表在哪"的判据，而含糊的开头会让
# 抽取悄悄抓到别处的表格。
SECTION = "### 配置条目"

# 表格行：第一格是一个反引号包起来的键名。
ROW = re.compile(r"^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|")


def conf_keys_of_daemon():
    """守护进程那份 `PLUGIN_COMMON_KEYS` —— **import**，不重写一遍。"""
    ldr = importlib.machinery.SourceFileLoader("d", DAEMON)
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("d", ldr))
    ldr.exec_module(mod)
    return set(mod.PLUGIN_COMMON_KEYS) | {"bin"}


def expected_keys(plugin_dir, base):
    """这个插件**应该**在表里出现的全部键。"""
    with open(os.path.join(plugin_dir, "plugin.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    enum = (manifest.get("site") or {}).get("enumKeys") or {}
    return base | set(enum.keys())


def documented_keys(readme_path):
    """README 的〈配置条目〉一节里，表格第一列那些键名。

    返回 `None` 表示**连那一节都没有**（与"表是空的"是两件事）。
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
            if line.startswith("#"):        # 下一个标题 ⇒ 这一节到底了
                break
            m = ROW.match(line)
            if m:
                keys.add(m.group(1))
    return keys if inside else None


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


def run(plugins_dir):
    base = conf_keys_of_daemon()
    problems = check(plugins_dir, base)
    for p in problems:
        print("✗ %s" % p)
    if problems:
        print("\n✗ 插件文档与清单对不上（%d 处）。这份表的权威是 plugin.json 与"
              " PLUGIN_COMMON_KEYS —— 改清单就要改表。" % len(problems))
        return 1
    n = sum(1 for d in sorted(os.listdir(plugins_dir))
            if os.path.isfile(os.path.join(plugins_dir, d, "plugin.json")))
    print("✓ %d 个插件的〈配置条目〉表与各自清单逐字一致" % n)
    return 0


def self_test():
    """种坏样本，断言这条检查**真的会红**。

    ★ 没有这一步，"检查通过"与"检查根本没在看"分不开 —— 那条纪律在本仓库有一条
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
        if bad:
            for b in bad:
                print("✗ %s" % b)
            return 1
        print("✓ 反向自测通过：四种坏样本都被抓到，一份对的没有被误判")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--plugins-dir", default=os.path.join(ROOT, "plugins"))
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    return run(args.plugins_dir)


if __name__ == "__main__":
    sys.exit(main())
