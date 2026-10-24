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
test-run-package.py — 站点端单文件包（`slurmate-site-<版本>.run`）的自测

用法： /usr/bin/python3 cluster/test-run-package.py

它测六件事：

  1. 打包器打得出来，打出来的包里【恰好】是清单上那些文件，而且逐份与源相同
     —— 少发一份（装到一半缺文件）与多发一份（把测试、夹具、插件顺手带出去）
     都要当场红。
  2. 两条解压出口都真的能用：`--extract`，以及壳里写着的那两条命令（那条
     awk 与 tail 是给"先读一遍再跑"的人用的，写错了等于没有这条路）。
  3. 五个动词的转发：非 root 时要拦住并给出正确的那条 sudo 命令；转发给安装器
     时动词与开关原样送到。后者用一份【桩安装器】与一个【桩 id】验 —— 于是这
     一条不需要 root，也绝不会碰到系统里的任何位置。
  4. 打包器自己的失败路径：源文件缺失、壳里还剩占位符、壳的最后一行不是包体
     标记、包体被截断。四种都要非零退出并说清是哪一种。
  5. 壳里不夹带构建机的路径，也不出现插件名。
  6. 包内文档里没有指向包外的链接 —— 管理员手上只有这一份包，一条指到仓库里
     的死链与写错一个字是同一件事。

本文件不依赖 root、不依赖集群、不碰系统里任何位置：所有写入都在临时目录里，
桩安装器什么都不做（只把收到的参数打印出来）。
"""
import hashlib
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MAKER = os.path.join(HERE, "make-run.sh")
HEADER = os.path.join(HERE, "run-header.sh")
INSTALLER = os.path.join(HERE, "install-base.sh")
DAEMON = os.path.join(HERE, "slurmate-sessiond")

PASS = 0
FAIL = 0


def check(desc, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [PASS] %s" % desc)
    else:
        FAIL += 1
        print("  [FAIL] %s  %s" % (desc, detail))


def run(args, **kw):
    """跑一条命令，收回 stdout/stderr 与退出码。默认在临时目录里跑。"""
    return subprocess.run(args, capture_output=True, text=True, **kw)


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def tree_of(d):
    """目录里所有文件的相对路径（排序）。"""
    out = []
    for base, _dirs, files in os.walk(d):
        for name in files:
            out.append(os.path.relpath(os.path.join(base, name), d))
    return sorted(out)


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(262144), b""):
            h.update(chunk)
    return h.hexdigest()


def payload_list():
    """打包器那份清单（`PAYLOAD=(…)`）。

    从源码里读而不是在这里抄第二份：抄一份的话，"发漏了一个文件"这件事在测试
    与打包器里会同时成立，而这条判据的价值正在于两边不是同一份。
    """
    m = re.search(r"^PAYLOAD=\(\n(.*?)^\)", read(MAKER), re.S | re.M)
    return [ln.strip() for ln in m.group(1).splitlines() if ln.strip()] if m else []


def installer_src_files():
    """安装器真正要用的那几份（`SRC_FILES=(…)`）。

    它与包内清单的关系是【包含】：装上要用的每一份都必须在包里，反过来包里
    可以多（文档、自检脚本、许可证）。
    """
    m = re.search(r"^SRC_FILES=\((.*?)\)", read(INSTALLER), re.M)
    return m.group(1).split() if m else []


def payload_line_num(path):
    """包体标记是第几行（找不到返回 None）。"""
    with open(path, "rb") as f:
        for i, line in enumerate(f, 1):
            if line.rstrip(b"\r\n") == b"#===SLURMATE-PAYLOAD===":
                return i
    return None


def recipe_lines():
    """壳里写着的那几条命令（不经过 `--extract` 的解压办法）。

    它印在脚本顶部的注释里，所以从 `run-header.sh` 读出来、剥掉注释符再跑 ——
    这样"文档里那几条命令"与"真的能跑的那几条命令"是同一份文本，改坏一个另一个
    当场红。（第一版少了建目录那一条，这条判据当场红了。）
    """
    out = []
    for line in read(HEADER).splitlines():
        if not line.startswith("#"):
            continue
        body = line.lstrip("#").strip()
        if body.startswith(("F=", "D=", "mkdir -p", "N=$(", "tail -n")):
            out.append(body)
    return out


def main():
    tmp = tempfile.mkdtemp(prefix="slurmate-run-pkg-")
    try:
        # ── 1. 打包 ────────────────────────────────────────────────────────
        print("\n── 1. 打包器与产物 ──")
        out = os.path.join(tmp, "one", "slurmate-site-test.run")
        r = run(["bash", MAKER, "--out", out])
        check("打包器跑得通", r.returncode == 0,
              (r.stdout + r.stderr)[-500:])
        check("产物落在我指定的位置", os.path.isfile(out), out)
        check("产物可执行（于是 `sudo ./x.run` 也跑得起来）",
              os.access(out, os.X_OK))
        # 壳那一半单独过一遍语法。`bash -n` 整个 `.run` 是不行的：包体是 gzip
        #   数据，bash 会把它当脚本继续解析，报出来的错里还带着二进制。
        n_head = payload_line_num(out)
        check("壳的最后一行是包体标记（包体从它下一行开始）", n_head is not None)
        if n_head:
            head_path = os.path.join(tmp, "shell-only.sh")
            with open(out, "rb") as f:
                head_bytes = b"".join(f.readline() for _ in range(n_head))
            with open(head_path, "wb") as f:
                f.write(head_bytes)
            r = run(["bash", "-n", head_path])
            check("壳那一半是语法正确的 shell 脚本", r.returncode == 0,
                  (r.stdout + r.stderr)[-200:])

        v_pkg = run(["bash", out, "--version"]).stdout.strip()
        v_daemon = run([sys.executable, DAEMON, "--version"]).stdout.strip()
        check("`--version` 报的就是守护进程里那一行的版本",
              v_pkg != "" and v_pkg == v_daemon,
              "包里 %r / 守护进程 %r" % (v_pkg, v_daemon))
        # 上面那条如果两边都读到空，会以"相等"通过 —— 所以另外钉一条：
        check("上一条不是空断言（两边都真的读到了版本号）",
              len(v_pkg) >= 3, repr(v_pkg))

        want = payload_list()
        src = installer_src_files()
        check("从打包器源码里读到了清单（否则下面几条是空断言）",
              len(want) >= 10 and len(src) >= 6,
              "清单 %d 项 / 安装器 %d 项" % (len(want), len(src)))
        check("安装器要用的那几份一份不少地在清单里",
              set("cluster/" + f for f in src) <= set(want),
              str(sorted(set("cluster/" + f for f in src) - set(want))))
        check("清单里带着许可证与 NOTICE（再分发要有它们）",
              {"LICENSE", "NOTICE"} <= set(want))
        check("清单里没有测试、夹具与插件",
              not [f for f in want
                   if f.endswith((".splug",)) or "/test" in f or "test-" in f],
              str(want))

        d1 = os.path.join(tmp, "x1")
        r = run(["bash", out, "--extract", d1])
        check("`--extract` 跑得通", r.returncode == 0 and os.path.isdir(d1),
              (r.stdout + r.stderr)[-300:])
        got = tree_of(d1)
        check("`--extract` 解出来的【恰好】是清单上那些（两个方向都比）",
              got == sorted(want),
              "多 %s / 少 %s" % (sorted(set(got) - set(want)),
                                 sorted(set(want) - set(got))))
        bad = [f for f in got if digest(os.path.join(d1, f))
               != digest(os.path.join(ROOT, f))]
        check("解出来的每一份与仓库里的那一份逐字节相同", not bad, str(bad[:3]))

        # ── 2. 壳里那两条命令 ──────────────────────────────────────────────
        print("\n── 2. 不看这个脚本也能解压（壳里那几条命令）──")
        rl = recipe_lines()
        check("壳里读得到那五条（`F=`、`D=`、`mkdir -p`、`N=$(…)`、`tail -n …`）",
              len(rl) == 5, str(rl))
        if len(rl) == 5:
            d2 = os.path.join(tmp, "x2")
            # 前两条是文件名与目录（里面写的是占位写法与文档用的那个例子），
            #   换成这一次的真实路径；后三条原样跑 —— 它们才是要验的东西。
            script = ("set -e\nF=%s\nD=%s\n%s\n%s\n%s\n"
                      % (shell_quote(out), shell_quote(d2),
                         rl[2], rl[3], rl[4]))
            r = run(["bash", "-c", script])
            check("那两条命令原样跑得通", r.returncode == 0,
                  (r.stdout + r.stderr)[-400:])
            check("它解出来的内容与 `--extract` 的相同",
                  tree_of(d2) == got if os.path.isdir(d2) else False,
                  str(tree_of(d2)[:3]) if os.path.isdir(d2) else "（没有解出目录）")

        # ── 3. 五个动词 ────────────────────────────────────────────────────
        print("\n── 3. 五个动词：拦住与转发 ──")
        verbs = ["--check", "--doctor", "--repair", "--uninstall"]
        for v in verbs:
            r = run(["bash", INSTALLER, v])
            txt = r.stdout + r.stderr
            check("安装器认得 %s（不是「未知参数」）" % v,
                  "未知参数" not in txt and "请以 root 运行" in txt,
                  txt.strip()[-160:])

        for v in verbs + [""]:
            r = run(["bash", out] + ([v] if v else []))
            txt = r.stdout + r.stderr
            check(".run %s：非 root 时拦住（退出码非零）" % (v or "（安装）"),
                  r.returncode != 0, str(r.returncode))
            check(".run %s：给出的 sudo 命令指向这一份包" % (v or "（安装）"),
                  ("sudo bash %s" % out) in txt, txt.strip()[-160:])
            check(".run %s：不是「未知参数」" % (v or "（安装）"),
                  "未知参数" not in txt)

        h = run(["bash", out, "--help"]).stdout
        for v in verbs + ["--extract", "--dry-run", "--purge-state",
                          "--rollback"]:
            check("`--help` 里写着 %s" % v, v in h)

        # 崩溃收尾不是部署动词：非 root 时同样拦住，并且 sudo 命令带着目录。
        r = run(["bash", out, "--rollback",
                 "/root/slurmate-deploy-20260101-000000"])
        txt = r.stdout + r.stderr
        check("`.run --rollback <目录>`：非 root 时拦住，sudo 命令指向这一份包",
              r.returncode != 0 and ("sudo bash %s" % out) in txt
              and "未知参数" not in txt, txt.strip()[-200:])

        # 转发：桩安装器 + 桩 `id`（于是不需要 root，也不会碰系统）
        print("\n── 3b. 转发（桩安装器 + 桩 id）──")
        stub_root = os.path.join(tmp, "stub")
        shutil.copytree(HERE, os.path.join(stub_root, "cluster"))
        os.makedirs(os.path.join(stub_root, "tools"))
        shutil.copy2(os.path.join(ROOT, "tools", "check-cluster.sh"),
                     os.path.join(stub_root, "tools", "check-cluster.sh"))
        for f in ("LICENSE", "NOTICE"):
            shutil.copy2(os.path.join(ROOT, f), os.path.join(stub_root, f))
        stub_installer = ("#!/bin/bash\n"
                          "echo \"STUB-ARGS: $*\"\n"
                          "echo \"STUB-ORIG: ${SLURMATE_ORIG_SCRIPT:-}\"\n"
                          "echo \"STUB-PACKAGE: ${SLURMATE_PACKAGE:-}\"\n"
                          "exit 0\n")
        with open(os.path.join(stub_root, "cluster", "install-base.sh"),
                  "w", encoding="utf-8") as f:
            f.write(stub_installer)
        with open(os.path.join(stub_root, "tools", "check-cluster.sh"),
                  "w", encoding="utf-8") as f:
            f.write("#!/bin/bash\necho \"STUB-CHECK\"\nexit 0\n")
        stub_out = os.path.join(tmp, "stub.run")
        r = run(["bash", os.path.join(stub_root, "cluster", "make-run.sh"),
                 "--out", stub_out])
        check("桩那一棵树也能打出包来（下一条的前提）",
              r.returncode == 0, (r.stdout + r.stderr)[-300:])

        fakebin = os.path.join(tmp, "bin")
        os.makedirs(fakebin)
        # 桩 `id`：只把 `id -u` 答成 0，其余原样交给真的 id。它只会让 .run 走进
        #   "我是 root"那一支，而那一支里唯一会跑的东西就是上面那份桩安装器。
        with open(os.path.join(fakebin, "id"), "w", encoding="utf-8") as f:
            f.write("#!/bin/bash\n"
                    "if [[ \"${1:-}\" == \"-u\" ]]; then echo 0; exit 0; fi\n"
                    "exec /usr/bin/id \"$@\"\n")
        os.chmod(os.path.join(fakebin, "id"), 0o755)
        env = dict(os.environ)
        env["PATH"] = fakebin + os.pathsep + env.get("PATH", "")

        cases = [([], "STUB-ARGS: "),
                 (["--doctor"], "STUB-ARGS: --doctor"),
                 (["--repair"], "STUB-ARGS: --repair"),
                 (["--uninstall", "--purge-state"],
                  "STUB-ARGS: --uninstall --purge-state"),
                 (["--uninstall", "--force"],
                  "STUB-ARGS: --uninstall --force"),
                 (["--repair", "--dry-run"], "STUB-ARGS: --repair --dry-run"),
                 (["--check"], "STUB-ARGS: --check"),
                 (["--rollback", "/root/slurmate-deploy-20260101-000000"],
                  "STUB-ARGS: --rollback /root/slurmate-deploy-20260101-000000")]
        for args, want_line in cases:
            r = run(["bash", stub_out] + args, env=env)
            txt = r.stdout + r.stderr
            label = " ".join(args) or "（安装）"
            check("转发 %s：安装器收到的那一行是 %r" % (label, want_line),
                  want_line + "\n" in txt,
                  [ln for ln in txt.splitlines() if "STUB-ARGS" in ln])
            check("转发 %s：退出码是安装器那一个（0）" % label,
                  r.returncode == 0, str(r.returncode))
            check("转发 %s：卸载与回滚提示指向这一份包，不是临时目录" % label,
                  ("STUB-ORIG: %s" % stub_out) in txt
                  and ("STUB-PACKAGE: %s" % stub_out) in txt,
                  [ln for ln in txt.splitlines() if "STUB-" in ln])
        r = run(["bash", stub_out, "--check"], env=env)
        check("体检先跑环境那一屏，再跑部署预检那一屏",
              "STUB-CHECK" in r.stdout
              and r.stdout.index("STUB-CHECK") < r.stdout.index("STUB-ARGS"),
              r.stdout[:400])
        r = run(["bash", stub_out], env=env)
        check("安装先跑环境那一屏（顺序：检查 → 安装 → 诊断）",
              "STUB-CHECK" in r.stdout
              and r.stdout.index("STUB-CHECK") < r.stdout.index("STUB-ARGS"),
              r.stdout[:400])
        check("安装的三步在屏上说得出来（第一步 / 第二步 / 第三步）",
              all(w in r.stdout for w in ("第一步", "第二步", "第三步")),
              r.stdout[:600])

        # ── 4. 打包器自己的失败路径 ────────────────────────────────────────
        print("\n── 4. 失败路径都要说清是哪一种 ──")
        r = run(["bash", os.path.join(stub_root, "cluster", "make-run.sh"),
                 "--out", os.path.join(tmp, "nope.run")])
        check("桩那一棵树此刻是好的（下面几条的前提）", r.returncode == 0)

        gone = os.path.join(stub_root, "cluster", "nft-compare.py")
        shutil.move(gone, gone + ".bak")
        r = run(["bash", os.path.join(stub_root, "cluster", "make-run.sh"),
                 "--out", os.path.join(tmp, "missing.run")])
        check("源文件缺一份：非零退出并点名那一份",
              r.returncode != 0 and "nft-compare.py" in (r.stdout + r.stderr),
              (r.stdout + r.stderr)[-200:])
        shutil.move(gone + ".bak", gone)

        stub_header = os.path.join(stub_root, "cluster", "run-header.sh")
        keep = read(stub_header)
        with open(stub_header, "w", encoding="utf-8") as f:
            f.write(keep.replace("#===SLURMATE-PAYLOAD===",
                                 "# @NOT_SUBSTITUTED@\n#===SLURMATE-PAYLOAD===",
                                 1))
        r = run(["bash", os.path.join(stub_root, "cluster", "make-run.sh"),
                 "--out", os.path.join(tmp, "ph.run")])
        check("壳里还剩没替换的占位符：非零退出并说清",
              r.returncode != 0 and "占位符" in (r.stdout + r.stderr),
              (r.stdout + r.stderr)[-200:])

        # 把【最后一行】换掉 —— 换第一次出现的那一处会换到上面注释里那条 awk
        #   命令里（它也含这串字），那样壳的末行仍旧是标记，这一条就成了空断言。
        last = keep.rstrip("\n").rsplit("\n", 1)[0]
        with open(stub_header, "w", encoding="utf-8") as f:
            f.write(last + "\n# 忘写标记了\n")
        r = run(["bash", os.path.join(stub_root, "cluster", "make-run.sh"),
                 "--out", os.path.join(tmp, "nm.run")])
        check("壳的最后一行不是包体标记：非零退出并说清",
              r.returncode != 0 and "标记" in (r.stdout + r.stderr),
              (r.stdout + r.stderr)[-200:])
        with open(stub_header, "w", encoding="utf-8") as f:
            f.write(keep)

        size = os.path.getsize(out)
        cut = os.path.join(tmp, "cut.run")
        with open(out, "rb") as srcf, open(cut, "wb") as dstf:
            dstf.write(srcf.read(int(size * 0.6)))
        d3 = os.path.join(tmp, "x3")
        r = run(["bash", cut, "--extract", d3])
        check("包体被截断：非零退出，且说的是「不完整」而不是其他说法",
              r.returncode != 0 and "不完整" in (r.stdout + r.stderr),
              (r.stdout + r.stderr)[-200:])

        # 截在壳这一半：tar 那条路根本走不到，靠的是壳最前面那道自检。
        shell_cut = os.path.join(tmp, "shellcut.run")
        with open(out, "rb") as srcf, open(shell_cut, "wb") as dstf:
            dstf.write(srcf.read(int(size * 0.01)))
        d4 = os.path.join(tmp, "x4")
        r = run(["bash", shell_cut, "--extract", d4])
        check("壳被截断：非零退出，且说的是「不完整」",
              r.returncode != 0 and "不完整" in (r.stdout + r.stderr),
              (r.stdout + r.stderr)[-200:])

        # ── 5. 壳本身该干净 ───────────────────────────────────────────────
        print("\n── 5. 壳里不许夹带 ──")
        head = read(HEADER)
        check("壳里没有构建机的绝对路径（那些路径只属于打包那一台机器）",
              not re.search(r"(/mnt/|/home/|/Users/|/nas/)", head),
              str(re.findall(r"(?:/mnt/|/home/|/Users/|/nas/)\S*", head)[:3]))
        prod = head + read(MAKER)
        check("壳与打包器里没有插件名（夹具的名字也算，基座这一侧一个都不该有）",
              "web-demo" not in prod and "relay-demo" not in prod)

        # ── 6. 包内文档不指向包外 ─────────────────────────────────────────
        print("\n── 6. 包内文档不指向包外 ──")
        outside = []
        n_links = 0
        for f in got:
            if not f.endswith(".md"):
                continue
            # 链接目标按文档所在目录解析，再折成相对包根的路径。绝对 URL 与
            #   纯锚点不算 —— 前者是外站，后者在本文内。
            for target in re.findall(r"\]\(([^)]+)\)", read(os.path.join(d1, f))):
                target = target.split("#", 1)[0].strip()
                if not target or "://" in target:
                    continue
                n_links += 1
                rel = posixpath.normpath(
                    posixpath.join(posixpath.dirname(f), target))
                if rel not in want:
                    outside.append("%s → %s" % (f, target))
        check("包内文档里的相对链接都落在包里（作者那一侧的文档不在包里）",
              not outside, "；".join(outside[:5]))
        check("上一条不是空断言（真的扫到了链接）", n_links >= 5, str(n_links))

        print("\n" + "=" * 60)
        print("  通过 %d  失败 %d" % (PASS, FAIL))
        if FAIL == 0:
            print("  （全部用例都已实际执行：不依赖 root，也不依赖集群）")
        print("=" * 60)
        return 1 if FAIL else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def shell_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


if __name__ == "__main__":
    sys.exit(main())
