#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nft-compare.py — 规则集「非干扰」比对

用途
----
比较部署前后两份 `nft -j list ruleset` 快照，剥掉本系统新增的
`inet slurmate` 表之后，其余部分必须逐条完全一致。

判定档位
--------
    SAME        剥掉本系统表后完全一致
    DYNAMIC     差异仅涉及【已知会随用户作业流动】的规则（见下）
    ALIEN       出现本系统不应造成的差异 —— 必须人工检查
    NOSNAPSHOT  快照文件缺失或为空 —— 【无法】证明非干扰，必须当作失败
    TEXTMODE    快照不是合法 JSON —— 【无法】证明非干扰，必须当作失败

关于 DYNAMIC
------------
只有极少数规则会随用户作业流动，且它们的 comment 有严格可识别的格式：

    cs-<uid>-<hex>       codeserver-guard 的每会话 token（用户启停 code-server）
    job-<jobid>-<idx>    port-daemon 的每作业 DNAT 标记（用户提交带转发的作业）
    dnat-automasq        port-daemon 的 masquerade 基础规则（守护进程重启时可能补建）

**必须按 comment 精确匹配**。早期版本曾按"表名是 codeserver/port-daemon"来判定，
那等于放行对这两张表的**任何**规则级改动 —— 往生产表里塞一条规则、改一条规则、
删一条规则全都会被判成 DYNAMIC 并静默通过。这是最危险的假绿，已修正。
"""

import json
import re
import sys
from collections import Counter

KINDS = ("table", "chain", "rule", "set", "map", "element", "flowtable")
OUR_FAMILY = "inet"
OUR_TABLE = "slurmate"

# 只有这些 comment 形态才允许"随作业流动"，且必须出现在【对应的表】里。
# 限定表是必要的：否则往任意表塞一条 comment 为 cs-xxxx 的规则也会被当成"正常流动"。
DYNAMIC_RULES = (
    # (comment 正则, 允许出现的 (family, table))
    (re.compile(r"^cs-\d+-[0-9a-fA-F]+$"), ("inet", "codeserver")),
    (re.compile(r"^job-\d+-\d+$"), ("ip", "port-daemon")),
    (re.compile(r"^dnat-automasq$"), ("ip", "port-daemon")),
)


def load(path):
    """返回列表，或 None 表示【读不到/无法解析】。

    注意：空文件返回 None 而不是 []。空文件意味着快照根本没取到，
    把它当成"空规则集"会让两份失败的空快照被判为 SAME（假绿）。
    """
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read().strip()
    except OSError:
        return None
    if not raw:
        return None
    try:
        d = json.loads(raw)
    except ValueError:
        return None
    if isinstance(d, dict):
        items = d.get("nftables")
        return items if isinstance(items, list) else None
    return d if isinstance(d, list) else None


def norm(items):
    """规范化成 [(kind, 规范化JSON)]，剔除属于本系统表的项，忽略 handle。"""
    out = []
    for it in items:
        if not isinstance(it, dict):
            out.append(("other", json.dumps(it, sort_keys=True, ensure_ascii=False)))
            continue
        if "metainfo" in it:
            continue                        # 版本号之类，与规则无关
        handled = False
        for kind in KINDS:
            if kind not in it:
                continue
            body = it[kind]
            if not isinstance(body, dict):
                break
            fam = body.get("family")
            tbl = body.get("name") if kind == "table" else body.get("table")
            if fam == OUR_FAMILY and tbl == OUR_TABLE:
                handled = True              # 本系统新增的整张表，跳过
                break
            b = dict(body)
            b.pop("handle", None)           # handle 会因增删而变，比较时忽略
            out.append((kind, json.dumps(b, sort_keys=True, ensure_ascii=False)))
            handled = True
            break
        if not handled:
            out.append(("other", json.dumps(it, sort_keys=True, ensure_ascii=False)))
    return out


def is_dynamic(item):
    """该条差异是否属于【已知会随用户作业流动】的规则。

    两个条件都必须满足：comment 形态匹配，且规则出现在它该在的表里。
    只按 comment 判断是不够的 —— 往任意表塞一条 `cs-xxxx` 也会被放行。
    绝不按表名判断 —— 那会放行对该表的任意改动。
    """
    kind, txt = item
    if kind != "rule":
        return False                        # 表/链/集合的结构变化一律算异常
    try:
        body = json.loads(txt)
    except ValueError:
        return False
    comment = body.get("comment")
    if not isinstance(comment, str):
        return False
    where = (body.get("family"), body.get("table"))
    for rx, expect in DYNAMIC_RULES:
        if rx.match(comment):
            return where == expect
    return False


def compare(before_path, after_path):
    a, b = load(before_path), load(after_path)
    # 任一份读不到/不是合法 JSON → 无法证明非干扰。绝不能返回 SAME。
    if a is None or b is None:
        return "NOSNAPSHOT", []
    na, nb = norm(a), norm(b)
    if na == nb:
        return "SAME", []

    # 用 Counter 做**多重集**比较（含重复次数），而不是 set。
    # 集合比较有个致命盲区：规则【重排】和【重复次数变化】都看不见 ——
    # 而 nftables 链内的顺序是有语义的（drop 放在 accept 前后是真实的行为变更）。
    ca, cb = Counter(na), Counter(nb)
    diff = sorted((ca - cb).elements()) + sorted((cb - ca).elements())
    if not diff:
        # 多重集相同但顺序不同 → 纯重排。没有任何合法原因会造成这个
        # （guard/port-daemon 的规则增删一定会改变多重集），所以判为异常。
        return "REORDER", []

    alien = [x for x in diff if not is_dynamic(x)]
    if alien:
        return "ALIEN", alien
    return "DYNAMIC", diff


def selftest():
    """用合成样例验证各档判定都正确。"""
    FAILS = []
    CASES = []

    def ruleset(extra=(), include_ours=True, mutate=None):
        items = [
            {"metainfo": {"version": "1.0.9", "json_schema_version": 1}},
            {"table": {"family": "inet", "name": "codeserver", "handle": 1}},
            {"chain": {"family": "inet", "table": "codeserver", "name": "output",
                       "handle": 1, "type": "filter", "hook": "output",
                       "prio": 0, "policy": "accept"}},
        ]
        for i, r in enumerate(extra):
            items.append({"rule": {"family": "inet", "table": "codeserver",
                                   "chain": "output", "handle": 100 + i,
                                   "expr": r, "comment": r[0]}})
        if include_ours:
            items += [
                {"table": {"family": "inet", "name": "slurmate", "handle": 9}},
                {"chain": {"family": "inet", "table": "slurmate", "name": "output",
                           "handle": 9, "type": "filter", "hook": "output",
                           "prio": 0, "policy": "accept"}},
                {"rule": {"family": "inet", "table": "slurmate", "chain": "output",
                          "handle": 90, "expr": [1],
                          "comment": "slurmate-sess-1001-5712-55017"}},
            ]
        if mutate:
            mutate(items)
        return {"nftables": items}

    import os
    import shutil
    import tempfile
    d = tempfile.mkdtemp(prefix="nftcmp-")
    p, q = os.path.join(d, "a.json"), os.path.join(d, "b.json")

    def case(desc, before, after, want):
        if isinstance(before, str):
            open(p, "w").write(before)
        else:
            json.dump(before, open(p, "w"))
        if isinstance(after, str):
            open(q, "w").write(after)
        else:
            json.dump(after, open(q, "w"))
        got = compare(p, q)[0]
        mark = "PASS" if got == want else "FAIL"
        if got != want:
            FAILS.append(desc)
        CASES.append(desc)
        print("  [%s] %-34s 期望 %-10s 实得 %s" % (mark, desc, want, got))

    # ── 正常情形 ──
    case("只新增本系统的表", ruleset(include_ours=False),
         ruleset(include_ours=True), "SAME")
    case("handle 变化不算差异",
         ruleset(include_ours=False),
         ruleset(include_ours=True, mutate=lambda it: it[1]["table"].update(handle=777)),
         "SAME")
    case("并发 cs-* 规则增删",
         ruleset(extra=[["cs-1001-aaaa1111"]]),
         ruleset(extra=[["cs-1001-aaaa1111"], ["cs-1001-bbbb2222"]],
                 include_ours=True), "DYNAMIC")

    def pd_ruleset(job_comments=(), include_ours=True):
        """port-daemon 表里的 job-* 规则（它们必须出现在这张表里才算动态）。"""
        items = [
            {"metainfo": {"version": "1.0.9", "json_schema_version": 1}},
            {"table": {"family": "ip", "name": "port-daemon", "handle": 5}},
            {"chain": {"family": "ip", "table": "port-daemon", "name": "prerouting",
                       "handle": 5, "type": "nat", "hook": "prerouting", "prio": -100}},
        ]
        for i, c in enumerate(job_comments):
            items.append({"rule": {"family": "ip", "table": "port-daemon",
                                   "chain": "prerouting", "handle": 200 + i,
                                   "expr": [i], "comment": c}})
        if include_ours:
            items.append({"table": {"family": "inet", "name": "slurmate",
                                    "handle": 9}})
        return {"nftables": items}

    case("并发 job-* 规则增删（在 port-daemon 表内）",
         pd_ruleset(["job-5712-0"]),
         pd_ruleset(["job-5712-0", "job-5713-0"]), "DYNAMIC")
    # job-* 跑到别的表里就不是"正常流动"了
    case("★ job-* 出现在错误的表里",
         ruleset(),
         ruleset(include_ours=True,
                 mutate=lambda it: it.append({"rule": {
                     "family": "ip", "table": "somewhere-else", "chain": "x",
                     "handle": 90, "expr": [6], "comment": "job-5712-0"}})),
         "ALIEN")

    # ── 必须抓住的：对生产表的规则级改动（这三种以前会被误判为 DYNAMIC）──
    case("★ 往 codeserver 表塞规则",
         ruleset(),
         ruleset(include_ours=True,
                 mutate=lambda it: it.append({"rule": {
                     "family": "inet", "table": "codeserver", "chain": "output",
                     "handle": 50, "expr": [2], "comment": "cs-base-ssh"}})),
         "ALIEN")
    case("★ 改 codeserver 表已有规则",
         ruleset(extra=[["cs-base-lo"]]),
         ruleset(extra=[["cs-base-lo"]], include_ours=True,
                 mutate=lambda it: it[3]["rule"].update(expr=[777])),
         "ALIEN")
    case("★ 删 codeserver 表已有规则",
         ruleset(extra=[["cs-base-lo"], ["cs-base-established"]]),
         ruleset(extra=[["cs-base-lo"]], include_ours=True), "ALIEN")
    case("★ 往 port-daemon 表塞规则",
         ruleset(),
         ruleset(include_ours=True,
                 mutate=lambda it: it.append({"rule": {
                     "family": "ip", "table": "port-daemon", "chain": "prerouting",
                     "handle": 60, "expr": [3], "comment": "something-new"}})),
         "ALIEN")
    case("篡改他人链策略",
         ruleset(),
         ruleset(include_ours=True,
                 mutate=lambda it: it[2]["chain"].update(policy="drop")),
         "ALIEN")
    case("多出陌生表",
         ruleset(),
         ruleset(include_ours=True,
                 mutate=lambda it: it.append(
                     {"table": {"family": "ip", "name": "evil", "handle": 42}})),
         "ALIEN")
    case("★ 本系统的规则跑到别人表里",
         ruleset(),
         ruleset(include_ours=True,
                 mutate=lambda it: it.append({"rule": {
                     "family": "inet", "table": "filter", "chain": "output",
                     "handle": 70, "expr": [4],
                     "comment": "slurmate-sess-1001-5712-55017"}})),
         "ALIEN")

    # ── 无法证明的情形：绝不能判 SAME ──
    case("★ 两份空快照（快照失败）", "", "", "NOSNAPSHOT")
    case("★ 一份为空", ruleset(), "", "NOSNAPSHOT")
    case("非 JSON 输入", "table inet codeserver { }", ruleset(), "NOSNAPSHOT")
    case("缺 nftables 键", '{"foo":1}', ruleset(), "NOSNAPSHOT")

    # ── 边界 ──
    case("本系统表消失（ACL 失效，但没干扰别人）",
         ruleset(include_ours=True), ruleset(include_ours=False), "SAME")
    case("两份完全相同的空规则集",
         {"nftables": [{"metainfo": {"version": "1.0.9"}}]},
         {"nftables": [{"metainfo": {"version": "1.0.9"}}]}, "SAME")

    # ── ★ 顺序与重复次数（旧版用 set 比较，这两类完全看不见）──
    def reorder(items):
        # 把前两条规则对调（内容不变，只改顺序）
        items[2], items[3] = items[3], items[2]

    case("★ 纯重排规则（多重集相同、顺序不同）",
         ruleset(extra=[["cs-1001-aaaa1111"], ["cs-1001-bbbb2222"]]),
         ruleset(extra=[["cs-1001-aaaa1111"], ["cs-1001-bbbb2222"]],
                 include_ours=True, mutate=reorder),
         "REORDER")
    case("★ 重排基础规则",
         ruleset(extra=[["cs-base-lo"], ["cs-base-established"]]),
         ruleset(extra=[["cs-base-established"], ["cs-base-lo"]],
                 include_ours=True),
         "REORDER")
    case("★ 删除一条重复规则（多重集变化）",
         ruleset(extra=[["cs-1001-aaaa1111"], ["cs-1001-aaaa1111"]]),
         ruleset(extra=[["cs-1001-aaaa1111"]], include_ours=True),
         "DYNAMIC")
    case("★ 新增一条重复规则",
         ruleset(extra=[["cs-1001-aaaa1111"]]),
         ruleset(extra=[["cs-1001-aaaa1111"], ["cs-1001-aaaa1111"]],
                 include_ours=True),
         "DYNAMIC")
    case("★ 把非本系统的规则伪装成动态 comment",
         ruleset(),
         ruleset(include_ours=True,
                 mutate=lambda it: it.append({"rule": {
                     "family": "inet", "table": "inet_filter", "chain": "input",
                     "handle": 80, "expr": [5], "comment": "cs-1001-deadbeef"}})),
         "ALIEN")

    shutil.rmtree(d, ignore_errors=True)
    print("\n  自测：%d/%d 通过" % (len(CASES) - len(FAILS), len(CASES)))
    for f in FAILS:
        print("    失败: %s" % f)
    return 1 if FAILS else 0


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--selftest":
        return selftest()
    if len(sys.argv) != 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    verdict, diff = compare(sys.argv[1], sys.argv[2])
    print(verdict)
    for item in diff[:20]:
        print("    %s %s" % (item[0], item[1][:200]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
