#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test-sessiond-logic.py — slurmate-sessiond 的单元/集成测试

在【未安装】的状态下跑，用临时目录做状态目录，用 monkeypatch 覆盖家目录查找，
以便验证安全关键路径（会话文件校验）与 Slurm 交互。

用法： /usr/bin/python3 test-sessiond-logic.py

★ 本文件必须在【任何机器上都得出同样的结论】。
  此前这里写着"不依赖真集群，CI 上跑的与本地一致"，而那句话是不成立的：
  `Config.validate()` 会检查 Slurm 命令【在宿主机上】是否存在，而 CI runner
  上没有 Slurm。于是"配置自检无错误"这一条在 CI 上必红，红的原因与被测逻辑
  毫无关系 —— 它挂了四个 commit 没人管，因为看上去像"测试太严"。
  现在所有会碰宿主机的输入（状态目录、作业脚本、Slurm 命令）都在
  make_config() 里被摘掉，见那里的说明。
"""
import ast
import base64
import hashlib
import importlib.machinery
import io
import importlib.util
import json
import os
import re
import select
import selectors
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DAEMON = os.path.join(HERE, "slurmate-sessiond")
# 自测用【随仓库分发的示例配置】。真实部署的 /etc/slurmate/slurmate.conf 是
# 站点私有的，不该在开发机上，也不该成为测试能否通过的前提。
CONF = os.path.join(HERE, "slurmate.conf.example")

# 测试用的 uid：【必须等于运行本测试的用户】。
#
# 之前这里写的是一个固定的数字，恰好等于当时开发者的 uid —— 于是测试能过，
# 但那不是因为逻辑对，而是因为环境凑巧。换个人跑（或换个数字）就会全线失败，
# 报的还是一句看不出所以然的 "component_bad_owner"。
#
# 会话文件的所有权校验比较的是 st_uid == uid，而测试创建的文件属主必然是
# 运行用户，所以这里只能取 os.getuid()。
UID = os.getuid()

# 仓库里那两个真插件的**短名**。它们**不是**守护进程的常量 —— 守护进程里现在
# 一个插件名都没有，表是扫出来的。这里写死是因为下面的用例要指名道姓地引用
# 「code-server 那个插件」「sshd 那个插件」，而它们来自 make_config 装进去的
# 那两份真清单。
CS = "code-server"
SSHD = "sshd"

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


# 被测模块的句柄。`main()` 里装配一次，之后全文件用它。
#
# ★ 为什么不留成"每个函数自己收一个参数"：夹具辅助函数（build_package /
#   put_package / weave_one …）散在几十处调用点上，而它们都要解析包或从包里取
#   文件。逐个传参会让"这里传的是哪个模块"变成一件要读每一行才知道的事。
MOD = None


def load_module():
    global MOD
    loader = importlib.machinery.SourceFileLoader("slurmate_sessiond", DAEMON)
    spec = importlib.util.spec_from_loader("slurmate_sessiond", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    MOD = mod
    return mod


def load_cli():
    """加载 `cluster/slurmate` 那个 CLI（它没有 .py 后缀，所以只能这样加载）。

    ★ 加载它是安全的：那个文件的顶层只有 import 与常量定义，`main()` 在
      `if __name__ == "__main__"` 里。这里要的只是它那几个常量 —— 19.11d 那条
      跨文件不变量读的是它与守护进程各写一遍的那两个数。
    """
    path = os.path.join(HERE, "slurmate")
    loader = importlib.machinery.SourceFileLoader("slurmate_cli", path)
    spec = importlib.util.spec_from_loader("slurmate_cli", loader)
    cli = importlib.util.module_from_spec(spec)
    loader.exec_module(cli)
    return cli


def write_stub(path, body):
    """在临时目录里造一个可执行的小脚本，用来当外部命令的替身。"""
    with open(path, "w", encoding="utf-8") as f:
        f.write("#!/bin/sh\n" + body)
    os.chmod(path, 0o755)
    return path


# ── 夹具：编一个 .splug ─────────────────────────────────────────────────────
#
# ★ 集群侧的生产路径上**没有**写包的代码（包是作者用 `packer/` 打的），这里是
#   **用例专用的第三个写方**。它不需要"写得对"到能发布 —— 它需要的是产出一个
#   解析器收得下的包，而"包该长什么样"由 19.14 说了算：那一节拿打包器**真的产出**
#   的那份字节去验解析器。于是这里的正确性不靠自己证明，靠那条链子。
PKG_MAGIC = b"splug\x1a\r\n"
PKG_HEADER_BYTES = 20
PKG_SIG_BYTES = 97


def build_package(files, sig_block=b""):
    """`[(路径, 字节), …]` → 包的字节（附录 A 那个容器）。

    路径**在这里排序**（UTF-8 字节序）—— 与 §3.4 算摘要时的排序同一条规则。
    一个手写的包可以把记录按任意次序排，但那样"记录表次序"与"摘要次序"就成了
    两件事，用例里没有理由去制造这种分歧。
    """
    files = sorted(files, key=lambda x: x[0].encode("utf-8"))
    recs = b""
    for p, blob in files:
        pb = p.encode("utf-8")
        recs += (struct.pack(">H", len(pb)) + pb
                 + struct.pack(">Q", len(blob)) + hashlib.sha256(blob).digest())
    return (PKG_MAGIC + struct.pack(">III", 1, len(files), len(sig_block))
            + recs + sig_block + b"".join(b for _p, b in files))


def plugin_files_of(dirpath, skip=()):
    """一个插件**目录** → `[(相对路径, 字节), …]`，跳过集里的名字不进。

    ★ 打包器是从**一个提交**打的（不是工作树），而这里读的是磁盘上的目录 ——
      差别只在"哪一份字节"，不影响这一节要测的东西（插件表从包里读出来的形状）。
    """
    out = []
    for root, dirs, names in os.walk(dirpath):
        dirs[:] = sorted(d for d in dirs if d not in skip)
        for n in sorted(names):
            if n in skip:
                continue
            full = os.path.join(root, n)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            with open(full, "rb") as f:
                out.append((os.path.relpath(full, dirpath).replace(os.sep, "/"),
                            f.read()))
    return out


def put_package(out_dir, files, sig_block=b"", filename=None):
    """把一份包写进 out_dir，文件名默认是 `<包里的 id>.splug`。返回那个路径。"""
    blob = build_package(files, sig_block)
    if filename is None:
        mf = next((b for p, b in files if p == "plugin.json"), b"{}")
        filename = json.loads(mf.decode("utf-8"))["id"] + ".splug"
    path = os.path.join(out_dir, filename)
    with open(path, "wb") as f:
        f.write(blob)
    return path


def openssl_bin():
    """系统 openssl 的路径；没有返回 None。"""
    return shutil.which("openssl")


def openssl_make_key(tmpdir, name="k"):
    """现场生成一把 Ed25519 钥匙。返回 `(pem 路径, 32 字节裸公钥)`；失败返回 None。

    ★ 为什么要真的生成：安装器验的是**真签名**。"换了一把钥匙 ⇒ 拒绝"这条判据
      必须拿两把真的钥匙来测 —— 用两个随手编的十六进制串测，测的是字符串比较。
    """
    exe = openssl_bin()
    if not exe:
        return None
    pem = os.path.join(tmpdir, name + ".pem")
    r = subprocess.run([exe, "genpkey", "-algorithm", "ed25519", "-out", pem],
                       capture_output=True)
    if r.returncode != 0:
        return None
    r = subprocess.run([exe, "pkey", "-in", pem, "-pubout", "-outform", "DER"],
                       capture_output=True)
    if r.returncode != 0:
        return None
    der = r.stdout
    if len(der) != 12 + 32:
        return None
    return pem, der[12:]


def openssl_sign(pem, message):
    """用一把私钥签一段字节。返回 64 字节签名；失败返回 None。"""
    exe = openssl_bin()
    if not exe:
        return None
    d = tempfile.mkdtemp(prefix="slurmate-sign-")
    try:
        mp = os.path.join(d, "m")
        with open(mp, "wb") as f:
            f.write(message)
        r = subprocess.run([exe, "pkeyutl", "-sign", "-rawin", "-inkey", pem,
                            "-in", mp], capture_output=True)
        return r.stdout if r.returncode == 0 and len(r.stdout) == 64 else None
    finally:
        shutil.rmtree(d, ignore_errors=True)


def sign_files(files, pem, pubkey):
    """给一份 `[(路径, 字节)]` 签上名，返回**带签名块的那个包**的字节。

    ★ 两步：先编一个不带签名的包（签名盖的是**内容摘要**，与信封无关），拿它的
      摘要去签，然后把签名块插进信封重编一次 —— 摘要不变，所以签名仍然成立。
      与打包器 `sign` 的做法完全一样（§4.2：签名不改内容摘要）。
    """
    bare = build_package(files)
    r = MOD.package_parse(bare)
    if not r["ok"]:
        return None
    sig = openssl_sign(pem, bytes.fromhex(r["digest"]))
    if sig is None:
        return None
    return build_package(files, bytes([1]) + pubkey + sig)


def weave_one(tpl_path, plugin_pkg, name, ulid, out_path):
    """照 deploy.sh 的做法，把**一个**插件的 job/start.sh 织进模板。

    ★ 一个插件一份：这里与 deploy.sh 是同一段 awk、同一个标记、同样只放一个块。
      这里分叉的后果是"用例全绿、部署到真机上炸" —— 而部署脚本没法在本机跑。
      返回 awk 的 CompletedProcess（调用方要断言 returncode）。

    ★ 作业侧那一份现在是从**包里**取的（`--extract-package`），与 deploy.sh 走
      同一条路 —— 服务器上没有源码树可以读。
    """
    blocks = out_path + ".blocks"
    body = MOD.package_extract(plugin_pkg, "job/start.sh").decode("utf-8")
    with open(blocks, "w", encoding="utf-8") as f:
        f.write("\n# ─── 插件 %s（id %s）──────────────────────────────\n%s\n"
                % (name, ulid, body))
    r = subprocess.run(
        ["awk", "-v", "blocks=" + blocks,
         '/^# @@SLURMATE_PLUGIN_BLOCKS@@$/ {'
         ' while ((getline line < blocks) > 0) print line;'
         ' close(blocks); found = 1; next }'
         ' { print } END { if (!found) exit 9 }', tpl_path],
        capture_output=True, text=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(r.stdout)
    return r


def make_config(mod, tmpdir):
    """基于【随仓库分发的示例配置】生成一份指向临时目录、且自洽的测试配置。

    ★ 三样东西必须从宿主机上摘掉，否则测试的结论取决于跑它的机器：

      1. **状态 / 日志 / socket 目录** —— 它们现在是代码常量（不再是可以从配置
         里改的键），所以直接在模块上覆盖。不覆盖的后果不只是"测试污染真实
         目录"，还包括 `_db_schema_errors()` 会去读真实部署的 claims.db。
      2. **作业脚本目录** —— 由守护进程自身的安装位置推导（`<prefix>/share/
         slurmate/jobs/`），而开发机上还没部署。这里**真织一遍**：把仓库顶层
         那两个真插件的 job/start.sh 各织一份进临时目录，文件名用它们的 ULID ——
         与 deploy.sh 做的是同一件事。指向一个空目录或手写的替身都不行：
         那样 `build_sbatch_argv` 的末项、`plugin_job_missing` 全是空的，
         而这两样正是这次要测的东西。
      3. **Slurm 命令** —— `validate()` 会检查它们【在宿主机上】存在，而 CI
         runner 上没有 Slurm。这里在临时目录里造一个可执行的桩，把五个路径都
         指过去。**这条是 CI 那个挂了四个 commit 的失败的直接原因。**
    """
    # 每个命令一个【同名】桩文件，而不是一个共用的 —— 桩函数要能按命令名分辨
    # 自己被当成谁调用（`"squeue" in cmd` 这类判断），共用文件会让所有命令看起来
    # 一模一样，判断随之失效。
    bindir = os.path.join(tmpdir, "bin")
    os.makedirs(bindir, exist_ok=True)

    with open(CONF, "r", encoding="utf-8") as f:
        text = f.read()
    # 示例配置里 cluster_cidr 故意留空（它没有安全的默认值），测试里填一个
    # 合法网段 —— 同时后面还有专门一节验证"留空会被拒绝"。
    #
    # 顺便补上 default_plugin：示例配置里它是**注释掉的**（推荐值），而这一份测试
    # 配置要的是「一个升级前的老站点」的样子 —— 那时不带 service_kind 的提交落到
    # code-server。第 19 节用**不带这一项**的另一份配置测"没配就该被明确拒绝"。
    # 写在 cluster_cidr 那一行后面而不是文件末尾：通用键落在 [plugin:*] 块之后
    # 是硬错误（见 parse_config 的说明），而"块一旦开始就没有回头路"这条对测试
    # 夹具同样成立。
    text = re.sub(r"(?m)^cluster_cidr\s*=.*$",
                  "cluster_cidr = 192.0.2.0/24\ndefault_plugin = code-server", text)
    for name in ("sbatch", "scancel", "squeue", "scontrol", "sacctmgr"):
        stub = write_stub(os.path.join(bindir, name), "exit 0\n")
        text = re.sub(r"(?m)^%s\s*=.*$" % name, "%s = %s" % (name, stub), text)
    p = os.path.join(tmpdir, "slurmate.conf")
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)

    mod.STATE_DIR = os.path.join(tmpdir, "state")
    mod.LOG_DIR = os.path.join(tmpdir, "log")
    mod.SOCKET_PATH = os.path.join(tmpdir, "ctl.sock")
    # 4. **插件目录** —— 与作业脚本同理，由守护进程自身的安装位置推导，开发机上
    #    还没部署。这里**现场把仓库顶层 plugins/ 下那两个真插件打成包**，装进一个
    #    临时目录 —— 正是 deploy.sh 会做的事（它也只是把 `.splug` 交给安装器）。
    #
    #    ★ 刻意用**真的那两个**而不是合成替身：插件与基座的接口正是这一版反复在
    #      动的东西，用替身测等于没测 —— 替身会跟着实现一起漂，而真插件不会。
    #    ★ 也是**真的打包**（走 build_package 那个容器），不是绕过包直接摆一棵树：
    #      "插件是一个包"正是这一版要测的东西，夹具绕过它就等于没测。
    plugins_src = os.path.normpath(os.path.join(HERE, os.pardir, "plugins"))
    plugins_dir = os.path.join(tmpdir, "plugins")
    os.makedirs(plugins_dir, exist_ok=True)
    for _name in sorted(os.listdir(plugins_src)):
        _d = os.path.join(plugins_src, _name)
        if not os.path.isfile(os.path.join(_d, "plugin.json")):
            continue
        put_package(plugins_dir,
                    plugin_files_of(_d, skip=mod.PLUGIN_COPY_SKIP))
    mod.default_plugins_dir = lambda: plugins_dir

    # 5. **作业脚本目录** —— 按各插件的 ULID 真织一遍（见上面第 2 条的说明）。
    #    只给**有作业侧**的插件织；没有 job/start.sh 的插件本来就该没有那一份，
    #    而"没有"这一态由第 19 节的合成插件专门覆盖。
    jobs_dir = os.path.join(tmpdir, "jobs")
    os.makedirs(jobs_dir, exist_ok=True)
    _specs, _problems = mod.scan_plugins(plugins_dir)
    for _s in _specs:
        if not _s.needs_job:
            continue
        weave_one(os.path.join(HERE, "run.sbatch"), _s.source_package, _s.name,
                  _s.id, os.path.join(jobs_dir, _s.id + ".sbatch"))
    mod.default_jobs_dir = lambda: jobs_dir
    return mod.Config(p)


# ── Slurm 交互：一律打桩，绝不调用真实命令 ──────────────────────────────────
#
# 真实集群的节点名、用户名、账户名是站点私有的，既不该进测试夹具，也不可能在
# 任何别的机器上凑巧存在。而开发机与 CI runner 的环境差别足以让同一条用例一边
# 绿一边红 —— 这个仓库就真发生过（本机装了 Slurm 客户端，CI runner 上没装）。
#
# 那种红的**原因与被测逻辑毫无关系**，排查它纯属浪费。桩替换的是 run_cmd ——
# 模块级函数，所有 Slurm 调用的唯一出口。
def slurm_stub(argv, timeout=10, check=False):
    cmd = " ".join(str(a) for a in argv)
    args = [str(a) for a in argv]

    # ★ `scontrol show node -o`（**不带节点名**，列全部）—— GRES 的唯一来源。
    #   形状照抄真机（本机实测 slurm-wlm 23.11.4）：
    #     · `Gres=gpu:4` 是"名字:数量"；配了型号时是"名字:型号:数量"；
    #     · **没配 GRES 的节点上这个键整个不出现**（不是 `Gres=(null)`）；
    #     · `CfgTRES` / `AllocTRES` 里**没有** gres —— 那要
    #       `AccountingStorageTRES` 里列了 `gres/gpu`，本集群没列。
    #       所以夹具里也不许出现它们，否则用例守的是一个真机上不存在的形状。
    #   ★ `gpu:a100:2` 那一台是**故意的**：本集群只有不带型号的 `gpu`，
    #     带型号这条路在真集群上走不到，夹具不造它就等于没有覆盖（账本 F26）。
    if "show node" in cmd and args[-1] == "-o":
        return 0, (
            "NodeName=nodea1 Arch=x86_64 NodeAddr=192.0.2.11 State=MIXED "
            "Gres=gpu:a100:2 Partitions=A6000\n"
            "NodeName=nodea2 Arch=x86_64 NodeAddr=192.0.2.12 State=IDLE "
            "Gres=gpu:a100:2 Partitions=A6000\n"
            "NodeName=nodeb1 Arch=x86_64 NodeAddr=192.0.2.20 State=IDLE "
            "Gres=gpu:4,mps:100 Partitions=RTX8000\n"
            "NodeName=nodec1 Arch=x86_64 NodeAddr=192.0.2.30 State=IDLE "
            "Gres=gpu:8 Partitions=2080TI\n"
            "NodeName=noded1 Arch=x86_64 NodeAddr=192.0.2.40 State=IDLE "
            "Partitions=2080TI\n"), ""

    if "show node" in cmd:
        return {
            "node01": (0, "NodeName=node01 Arch=x86_64 NodeAddr=192.0.2.11 "
                          "State=IDLE\n", ""),
            "node04": (0, "NodeName=node04 Arch=x86_64 NodeAddr=192.0.2.20 "
                          "State=IDLE\n", ""),
        }.get(args[-1], (1, "", "Invalid node name specified"))

    if "show hostname" in cmd:
        if args[-1] in ("node0[1-2]", "node01"):
            return 0, "node01\n", ""
        return 1, "", "Invalid node name specified"

    if "show partition" in cmd:
        return 0, ("PartitionName=A6000 Default=NO MaxTime=183-00:00:00\n"
                   "PartitionName=RTX8000 Default=NO MaxTime=183-00:00:00\n"
                   "PartitionName=2080TI Default=YES MaxTime=183-00:00:00\n"), ""

    if "show config" in cmd:
        return 0, "ClusterName=example\nAccountingStorageEnforce=" \
                  "associations,limits,qos\n", ""

    if "ping" in args:
        return 0, "Slurmctld(primary) at slurmctld is UP\n", ""

    if "show job" in cmd:
        # 控制器可达、但查不到这个作业 → 调用方应判 JOB_MISSING。
        # 注意"rc 非 0"与"作业不存在"是两回事，区分它们靠的是上面的 ping。
        return 1, "", "Invalid job id specified"

    if "squeue" in cmd:
        return 0, "", ""

    if "sacctmgr" in cmd:
        user = next((a[5:] for a in args if a.startswith("user=")), "")
        fmt = next((a[7:] for a in args if a.startswith("format=")), "")
        if user == "alice":
            # 不限定分区：Partition 列为空
            return 0, ("myaccount|\n" if "Partition" in fmt else "myaccount\n"), ""
        if user == "bob":
            # 限定分区，且大小写与实际分区名（2080TI）不一致 —— 关键用例
            return 0, ("myaccount|2080ti\n" if "Partition" in fmt
                       else "myaccount\n"), ""
        return 0, "", ""          # dave：没有 association

    return 1, "", "unexpected command: %s" % cmd


def with_stub(mod, fake, fn):
    """在桩生效的前提下跑 fn()，跑完必定还原（异常也还原）。"""
    real = mod.run_cmd
    mod.run_cmd = fake
    try:
        return fn()
    finally:
        mod.run_cmd = real


def _read_logs(home):
    """读一个假 HOME 下 NFS 日志目录里的全部内容（作业脚本的产物）。"""
    d = os.path.join(home, ".slurmate", "logs")
    out = ""
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            with open(os.path.join(d, fn), encoding="utf-8") as f:
                out += f.read()
    return out


def main():
    global PASS, FAIL
    tmpdir = tempfile.mkdtemp(prefix="slurmate-test-")
    print("测试临时目录: %s\n" % tmpdir)

    mod = load_module()
    cfg = make_config(mod, tmpdir)
    os.makedirs(os.path.join(tmpdir, "state"), exist_ok=True)
    os.makedirs(os.path.join(tmpdir, "log"), exist_ok=True)

    # ── 1. 配置解析（通用键 + [plugin:*] 块）───────────────────────────────
    print("── 1. 配置解析 ──")
    check("端口池解析", cfg.port_start == 55001 and cfg.port_end == 55999,
          "%d-%d" % (cfg.port_start, cfg.port_end))
    check("示例配置里没有认不出的键", cfg.unknown_keys == [], str(cfg.unknown_keys))
    check("cluster_cidr 解析", cfg.cluster_cidr == "192.0.2.0/24", cfg.cluster_cidr)
    check("闪断/孤儿阈值 300/1800",
          cfg.suspect_after == 300 and cfg.orphan_after == 1800)
    check("配置自检无错误", cfg.validate() == [], str(cfg.validate()))

    def write_conf(text, name):
        p = os.path.join(tmpdir, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p

    def parse(text, name="parse.conf"):
        return mod.parse_config(write_conf(text, name))

    check("行尾 # 注释被切掉",
          parse("range_start = 55001  # 端口池下界\n")[0] == {"range_start": "55001"})
    check("整行注释与空行被跳过",
          parse("# 说明\n\n   \nrange_end = 5\n")[0] == {"range_end": "5"})
    check("值两端空白被去掉",
          parse("readonly_paths =   /shared/home  \n")[0]
          == {"readonly_paths": "/shared/home"})
    check("块被分出来，通用键留在全局段",
          parse("range_end = 5\n[plugin:sshd]\nenabled = yes\ndefault_cpus = 3\n")
          == ({"range_end": "5"}, {"sshd": {"enabled": "yes", "default_cpus": "3"}}))
    for i, (bad, why) in enumerate((("range_start = 1\nrange_start = 2\n", "重复键"),
                                    ("这不是赋值\n", "缺等号"),
                                    ("= 5\n", "缺键名"),
                                    ("[plugin:sshd]\n[plugin:sshd]\n", "重复块"),
                                    ("[plugin:sshd\n", "块头没闭合"),
                                    ("[cluster]\nx = 1\n", "不是 plugin 的块头"))):
        try:
            parse(bad, "bad-%d.conf" % i)
            check("%s → 报错" % why, False, "竟然通过了")
        except ValueError:
            check("%s → 报错" % why, True)

    # ★ 认不出的键必须是【错误】而不是被忽略：拼错的键被静默忽略，后果是
    #   "文件里写着，而实际什么也没发生" —— 这正是本项目一路在清的那类问题。
    #   这一条同时守住 v0.2 删掉的那些键：老配置里的 max_active_per_user
    #   之类不会静静地失效，而是会被明确拒绝。
    unknown_cfg = mod.Config(write_conf(
        "cluster_cidr = 192.0.2.0/24\nmax_active_per_user = 3\n", "unknown.conf"))
    check("认不出的键被自检拦下",
          any("max_active_per_user" in e for e in unknown_cfg.validate()),
          str(unknown_cfg.validate()))

    # ── 2. 端口区间是跨表安全的前提 ─────────────────────────────────────────
    print("\n── 2. 端口区间避让（reserved_ranges）──")
    # 示例配置里没有声明要避让的区间，所以端口池本身只需自洽
    check("端口池起止有序", cfg.port_start <= cfg.port_end,
          "%d-%d" % (cfg.port_start, cfg.port_end))
    check("示例配置未声明 reserved_ranges", cfg.reserved_ranges == [],
          str(cfg.reserved_ranges))

    def _parse_ranges(spec):
        out = []
        for item in spec.split(","):
            item = item.strip()
            if item:
                a, b = item.split("-", 1)
                out.append((int(a), int(b)))
        return out

    def overlap_of(spec):
        """把 reserved_ranges 设成 spec 后跑自检，返回与"重叠"相关的错误。"""
        t = make_config(mod, tmpdir)
        t.__dict__["reserved_ranges"] = _parse_ranges(spec)
        return [e for e in t.validate() if "重叠" in e]

    # 与 55001-55999 的关系：覆盖下界、覆盖上界、整段覆盖 → 都必须被拦
    for spec, want_hit in (("50000-56000", True), ("55001-55001", True),
                           ("55999-60000", True), ("1000-49999", False),
                           ("56000-60000", False), ("5000-49999,50000-55000", False)):
        hit = bool(overlap_of(spec))
        check("reserved_ranges=%-24s → %s" % (spec, "拦下" if want_hit else "放行"),
              hit == want_hit, str(overlap_of(spec)))

    # ── 3. Slurm 时间解析 ───────────────────────────────────────────────────
    print("\n── 3. Slurm 时间解析 ──")
    cases = [("183-00:00:00", 183 * 86400), ("12:00:00", 12 * 3600),
             ("01:30:00", 5400), ("30", 1800), ("05:30", 330),
             ("UNLIMITED", None), ("infinite", None), ("", None)]
    for raw, want in cases:
        try:
            got = mod.parse_slurm_time(raw)
            check("parse(%r) = %r" % (raw, want), got == want, "得到 %r" % got)
        except Exception as e:                               # noqa: BLE001
            check("parse(%r)" % raw, False, "抛异常 %s" % e)
    check("fmt 往返", mod.fmt_slurm_time(12 * 3600) == "12:00:00")
    check("fmt 带天数", mod.fmt_slurm_time(183 * 86400) == "183-00:00:00")
    try:
        mod.parse_slurm_time("这不是时间")
        check("非法时间应抛异常", False)
    except ValueError:
        check("非法时间应抛异常", True)

    # ── 4. 数据库 ───────────────────────────────────────────────────────────
    print("\n── 4. 数据库 ──")
    st = mod.Store(cfg.db_path)
    now = mod.now_ts()
    st.insert(session_id="s1", uid=UID, user="alice",
              partition="2080TI", account="myaccount", cpus=2, mem="4G",
              requested_time="12:00:00", job_id=5712, state=mod.ST_ENROLLED,
              candidates="55001,55002", created_at=now, service_port=55001,
              node_ip="192.0.2.11")
    check("插入后可读回", st.get("s1")["state"] == mod.ST_ENROLLED)
    check("按 uid 查询", len(st.by_uid(UID)) == 1)
    check("占位计数", st.count_occupying(UID) == 1)
    check("活跃端口包含候选集",
          st.active_ports() == {55001, 55002}, str(st.active_ports()))

    # 端口唯一索引：同 (node_ip, service_port) 的第二个活跃会话必须失败
    try:
        st.insert(session_id="s2", uid=2003, user="other",
                  partition="2080TI", account="myaccount", cpus=2, mem="4G",
                  requested_time="12:00:00", job_id=1002, state=mod.ST_ENROLLED,
                  candidates="55001", created_at=now, service_port=55001,
                  node_ip="192.0.2.11")
        check("同节点同端口的第二个活跃会话被唯一索引拒绝", False, "竟然插进去了")
    except Exception:                                        # noqa: BLE001
        check("同节点同端口的第二个活跃会话被唯一索引拒绝", True)

    # 但已释放的不应阻塞复用
    st.update("s1", state=mod.ST_RELEASED, ended_at=now)
    try:
        st.insert(session_id="s3", uid=2003, user="other",
                  partition="2080TI", account="myaccount", cpus=2, mem="4G",
                  requested_time="12:00:00", job_id=1003, state=mod.ST_ENROLLED,
                  candidates="55001", created_at=now, service_port=55001,
                  node_ip="192.0.2.11")
        check("已释放的端口可被复用", True)
    except Exception as e:                                   # noqa: BLE001
        check("已释放的端口可被复用", False, str(e))

    st.record_reject(UID, "test")
    check("拒绝计数", st.reject_count_since(UID, now - 10) == 1)
    st.close()

    # ── 5. 端口分配 ─────────────────────────────────────────────────────────
    print("\n── 5. 端口分配 ──")
    d = mod.Sessiond(cfg)
    st2 = mod.Store(cfg.db_path)
    d.store = st2
    cands = d.allocate_candidates(6)
    check("分配出 6 个候选", len(cands) == 6, str(cands))
    check("候选都在区间内",
          all(cfg.port_start <= c <= cfg.port_end for c in cands), str(cands))
    check("候选互不重复", len(set(cands)) == len(cands))
    check("候选避开了活跃端口", not (set(cands) & {55001}), str(cands))
    cands2 = d.allocate_candidates(6)
    check("第二次分配不与第一次重叠", not (set(cands) & set(cands2)),
          "%s vs %s" % (cands, cands2))
    # 池耗尽：应返回"除已被占用之外的全部"
    pool_size = cfg.port_end - cfg.port_start + 1
    in_use = d.store.active_ports()
    many = d.allocate_candidates(pool_size + 5)
    check("请求超过池容量时返回可用的全部",
          len(many) == pool_size - len(in_use),
          "得到 %d，期望 %d（池 %d，占用 %d）"
          % (len(many), pool_size - len(in_use), pool_size, len(in_use)))
    st2.close()

    # ── 6. nft comment 格式 ─────────────────────────────────────────────────
    print("\n── 6. nft comment ──")
    c = mod.Nft.comment_for(UID, 5712, 55017)
    check("comment 格式", c == "slurmate-sess-%d-5712-55017" % UID, c)
    check("comment 不含空格", " " not in c)
    # 必须与现有系统的前缀不冲突（guard 用 cs-*，port-daemon 用 job-*）
    check("不与 guard 的 cs- 前缀冲突", not c.startswith("cs-"))
    check("不与 port-daemon 的 job- 前缀冲突", not c.startswith("job-"))
    # 正则能从 nft 输出里抠回来
    line = ('\t\tip daddr 192.0.2.11 tcp dport 55017 ct state new '
            'meta skuid != %d meta skuid != 0 drop comment "%s" # handle 7' % (UID, c))
    m = mod.Nft.RE_SESS.search(line)
    check("能从 nft -a 输出解析出 comment 与 handle",
          bool(m) and m.group(1) == c and int(m.group(2)) == 7,
          str(m.groups() if m else None))

    # ── 7. 会话文件校验（安全关键）────────────────────────────────────────
    print("\n── 7. 会话文件校验（安全关键）──")
    home = os.path.join(tmpdir, "home")
    sess_dir = os.path.join(home, ".slurmate", "sessions")
    os.makedirs(sess_dir, mode=0o700)
    os.chmod(os.path.join(home, ".slurmate"), 0o700)
    os.chmod(home, 0o700)

    d.user_home = lambda uid: home          # monkeypatch：不碰真实家目录

    def write_session(name, obj, mode=0o600):
        p = os.path.join(sess_dir, name)
        with open(p, "w") as f:
            f.write(json.dumps(obj))
        os.chmod(p, mode)
        return p

    good = {
        "schema": 1, "session_id": "abc", "job_id": 5712, "uid": UID,
        "user": "alice", "partition": "2080TI", "node": "node01",
        "node_ip": "192.0.2.11", "service_port": 55017,
        "tunnel_target": "192.0.2.11:55017", "state": "running",
        "job_started_at": 1, "written_at": 2, "job_hb_at": 3,
        "code_server_pid": 4, "auth_mode": "password",
        "slurm_restart_number": 0, "exit_code": None,
    }
    write_session("job-5712.json", good)
    info, why = d.load_session_file(UID, 5712)
    check("合法文件可读", info is not None, str(why))
    check("读到 node_ip", info and info["node_ip"] == "192.0.2.11")
    check("带上了 inode/ctime", info and "_inode" in info and "_ctime" in info)

    # 权限过宽必须拒
    write_session("job-5712.json", good, mode=0o644)
    info, why = d.load_session_file(UID, 5712)
    check("mode 0644 被拒", info is None and why == "mode_too_open", str(why))
    write_session("job-5712.json", good, mode=0o600)

    # 符号链接必须拒
    link = os.path.join(sess_dir, "job-5713.json")
    try:
        os.symlink("/etc/passwd", link)
        info, why = d.load_session_file(UID, 5713)
        check("符号链接被拒", info is None and why == "open_failed:40", str(why))
    except OSError:
        pass
    finally:
        try:
            os.unlink(link)
        except OSError:
            pass

    # FIFO 必须不阻塞
    fifo = os.path.join(sess_dir, "job-5714.json")
    os.mkfifo(fifo)
    t0 = time.time()
    info, why = d.load_session_file(UID, 5714)
    dt = time.time() - t0
    check("FIFO 被拒且不阻塞", info is None and dt < 2, "耗时 %.2fs why=%s" % (dt, why))
    os.unlink(fifo)

    # 超大文件必须拒
    write_session("job-5715.json", dict(good, job_id=5715))
    with open(os.path.join(sess_dir, "job-5715.json"), "w") as f:
        f.write('{"pad":"' + "x" * 70000 + '"}')
    os.chmod(os.path.join(sess_dir, "job-5715.json"), 0o600)
    info, why = d.load_session_file(UID, 5715)
    check("超大文件被拒", info is None and why == "too_large", str(why))

    # 目录组可写必须拒
    os.chmod(sess_dir, 0o770)
    info, why = d.load_session_file(UID, 5712)
    check("目录组可写被拒",
          info is None and why == "component_group_or_world_writable", str(why))
    os.chmod(sess_dir, 0o700)

    # ── 8. validate_session：防伪造 ────────────────────────────────────────
    print("\n── 8. validate_session（防伪造）──")
    sess = {"uid": UID, "job_id": 5712, "candidates": "55017,55018"}
    job = {"JobState": "RUNNING", "NodeList": "node01"}

    info, _ = d.load_session_file(UID, 5712)
    ok, why = d.validate_session(sess, info, job)
    check("合法会话通过校验", ok, str(why))

    check("端口不在候选集内 → 拒绝",
          d.validate_session(sess, dict(info, service_port=22), job)
          == (False, "port_not_in_candidates"))
    check("端口越界 → 拒绝",
          d.validate_session(sess, dict(info, service_port=22), job)[0] is False)
    check("node_ip 非 IPv4 → 拒绝",
          d.validate_session(sess, dict(info, node_ip="evil.example.com"), job)
          == (False, "node_ip_not_ipv4"))
    check("job_id 不匹配 → 拒绝",
          d.validate_session(sess, dict(info, job_id=9999), job)
          == (False, "job_id_mismatch"))
    check("uid 字段不匹配 → 拒绝",
          d.validate_session(sess, dict(info, uid=1), job)
          == (False, "uid_field_mismatch"))
    check("schema 不匹配 → 拒绝",
          d.validate_session(sess, dict(info, schema=99), job)
          == (False, "schema_mismatch"))
    check("state 非 running → 拒绝",
          d.validate_session(sess, dict(info, state="starting"), job)
          == (False, "not_running_state"))
    check("与 Slurm 的节点不一致 → 拒绝",
          d.validate_session(sess, dict(info, node="node04"), job)
          == (False, "node_mismatch_with_slurm"))
    # 关键：端口必须来自守护进程分配的那几个 —— 这是防伪造的核心
    sprawl = {"uid": UID, "job_id": 5712, "candidates": "55017,55018"}
    ok, why = d.validate_session(sprawl, dict(info, service_port=55019), job)
    check("用户自造端口（不在候选集）→ 拒绝", not ok and why == "port_not_in_candidates",
          str(why))

    # ── 9. Slurm 交互 ──────────────────────────────────────────────────────
    print("\n── 9. Slurm 交互 ──")
    # 9a. 解析逻辑用【桩】测，不连真集群。
    #
    # ⚠️ `expand_node` 看起来像"纯字符串解析"，其实它要调 scontrol show hostname
    #    （只是解析失败时才回退成原样返回输入）—— 所以它也必须走桩。此前它被
    #    放在桩外面，靠的是"开发机上恰好装了 Slurm"，那条断言测的其实是环境。
    #
    # 为什么不能连真的：这些用例要看的是"从 scontrol/sacctmgr 的输出里
    # 正确解析出 NodeAddr / 账户 / 分区"，那是纯逻辑。而真实集群的节点名、
    # 用户名、账户名是站点私有的，既不该进测试夹具，也不可能在任何别的
    # 机器上凑巧存在 —— 连真集群测的结果是"换台机器就红"，而红的原因
    # 与被测逻辑毫无关系。
    #
    # 桩替换的是 run_cmd（模块级函数，所有 Slurm 调用的唯一出口）。
    # 喂进去的输出都是这些命令真实的输出格式。
    sl = mod.Slurm(cfg)
    real_run_cmd = mod.run_cmd

    mod.run_cmd = slurm_stub
    try:
        check("节点名展开（走桩的 scontrol show hostname）",
              sl.expand_node("node0[1-2]") == "node01",
              str(sl.expand_node("node0[1-2]")))

        # 分区表：v0.2 起它是一等公民 —— 缺省提交要从这里随机挑，
        # 时间上限也要按这里的 MaxTime 截断。
        table = sl.partition_table()
        check("分区表包含示例里的分区",
              set(table) >= {"A6000", "RTX8000", "2080TI"}, str(table))
        check("默认分区被识别出来",
              table["2080TI"]["is_default"] is True
              and table["A6000"]["is_default"] is False, str(table))
        check("MaxTime 解析成秒",
              table["2080TI"]["max_time"] == 183 * 86400,
              str(table["2080TI"]["max_time"]))

        # 查询失败必须与"一个分区都没有"区分开：把前者当后者，缺省随机挑分区
        # 就会失去依据，而把前者当成"不限制"更糟 —— 那是 fail-open。
        def dead_partitions(argv, timeout=10, check=False):
            return 1, "", "slurm_load_partitions: Socket timed out"

        check("分区查询失败 → None（不是空 dict）",
              with_stub(mod, dead_partitions, sl.partition_table) is None)

        check("accounting 强制 associations", sl.is_accounting_enforced() is True)
        ip = sl.node_ip("node01")
        check("node01 的 NodeAddr 是 IPv4", ip == "192.0.2.11", str(ip))
        ip_c = sl.node_ip("node04")
        check("node04 的 NodeAddr 是 IPv4", ip_c == "192.0.2.20", str(ip_c))
        check("不存在的节点返回 None", sl.node_ip("nosuchnode") is None)
        check("不存在的作业返回 None（rc 非 0 或输出为空都算查不到）",
              sl.show_job(999999999) is None)
        check("控制器可达 + 作业查不到 → JOB_MISSING（不是 UNKNOWN）",
              sl.job_state(999999999) == (mod.Slurm.JOB_MISSING, None),
              str(sl.job_state(999999999)))

        acct, why = sl.account_for("alice")
        check("alice 的账户是 myaccount", acct == "myaccount", "%s / %s" % (acct, why))
        acct2, why2 = sl.account_for("dave")
        check("无 association 的用户返回明确错误",
              acct2 is None and why2 and "管理员" in why2, str(why2))

        allowed = sl.allowed_partitions("alice")
        check("alice 的分区不限制（None）", allowed is None, str(allowed))
        allowed_x = sl.allowed_partitions("bob")
        check("bob 的分区被限定为 2080ti（小写）",
              allowed_x == {"2080ti"}, str(allowed_x))
        # 这是关键：实际分区名是 2080TI（大写），association 里写的是小写，
        # 必须大小写无关地匹配，否则会把他误判成"没有该分区权限"
        check("限定分区能与实际分区名大小写无关地匹配",
              "2080TI".lower() in (allowed_x or set()), str(allowed_x))
    finally:
        mod.run_cmd = real_run_cmd

    # 9c. 控制器不可达时必须判 UNKNOWN，而不是"作业没了"。
    #     这条是 H1 回归的核心：混淆两者会让一次 slurmctld 抖动清空所有 ACL。
    def dead_controller(argv, timeout=10, check=False):
        args = [str(a) for a in argv]
        if "show" in args and "job" in args:
            return 1, "", "slurm_load_jobs error: Socket timed out"
        if "ping" in args:
            return 1, "", "slurm_load_ctl_conf: Socket timed out"
        return 1, "", "controller down"

    mod.run_cmd = dead_controller
    try:
        st, info = sl.job_state(5712)
        check("控制器不可达 → JOB_UNKNOWN（绝不当作作业已结束）",
              st == mod.Slurm.JOB_UNKNOWN and info is None, "%s / %s" % (st, info))
    finally:
        mod.run_cmd = real_run_cmd

    # ── 10. job_state：区分"查不到"与"查不了"（H1 回归）────────────────────
    # 这一节防的是最危险的一类误判：把"命令失败"当成"作业已结束"，
    # 进而在一个 tick 内拆掉所有活跃会话的 ACL 并删掉它们的会话文件。
    print("\n── 10. job_state 三态（H1 回归）──")
    sl2 = mod.Slurm(cfg)
    real_scontrol = cfg.scontrol

    cfg.scontrol = "/nonexistent/scontrol"
    st, _info = sl2.job_state(5712)
    check("命令不存在 → UNKNOWN（绝不能是 MISSING）",
          st == mod.Slurm.JOB_UNKNOWN, st)

    cfg.scontrol = "/bin/false"
    st, _info = sl2.job_state(5712)
    check("命令返回非零 → UNKNOWN", st == mod.Slurm.JOB_UNKNOWN, st)

    cfg.scontrol = "/bin/sleep"
    st, _info = sl2.job_state(5712)
    check("命令行为异常 → UNKNOWN", st == mod.Slurm.JOB_UNKNOWN, st)

    # 最后一个：控制器可达、作业确实不在 —— 必须判 MISSING（而不是 UNKNOWN）。
    # 这里用【真的外部命令】（临时目录里的 shell 脚本）而不是 run_cmd 桩：
    # 这条路径要覆盖"命令真的被 fork 出去并按预期返回"这件事，而上面的
    # UNKNOWN 用例已经证明命令失败时不会被误判成 MISSING。
    #
    # ★ 此前这一条用的是宿主机上的真 scontrol，于是它在开发机上绿（本机恰好是
    #   一个真集群的计算节点）、在 CI 上红（runner 上没有 scontrol，rc=127 →
    #   UNKNOWN ≠ MISSING）。这就是"测试验的是环境而不是逻辑"的典型。
    cfg.scontrol = write_stub(os.path.join(tmpdir, "scontrol-ok"), """\
case "$1 $2" in
  "ping "*)   echo "Slurmctld(primary) at slurmctld is UP"; exit 0 ;;
  "show job") exit 1 ;;      # 作业不存在时真实 scontrol 就是非零返回码
esac
exit 0
""")
    st, info = sl2.job_state(999999999)
    check("控制器可达 + 作业确实不在 → MISSING", st == mod.Slurm.JOB_MISSING, st)
    check("show_job 对不存在的作业返回 None",
          sl2.show_job(999999999) is None)

    # squeue 兜底：scontrol 查不到、但队列里还有它 → 判 JOB_OK（还在跑，不是结束）。
    # 少了这条兜底，一次 scontrol 的记录异常就会被当成"作业结束了"。
    real_squeue = cfg.squeue
    cfg.squeue = write_stub(os.path.join(tmpdir, "squeue-ok"), "echo 999999999\n")
    st, _info = sl2.job_state(999999999)
    check("scontrol 查不到但 squeue 还在队列 → JOB_OK（绝不判成已结束）",
          st == mod.Slurm.JOB_OK, st)
    cfg.squeue = real_squeue
    cfg.scontrol = real_scontrol

    check("JOB_OK/MISSING/UNKNOWN 三者互不相同",
          len({mod.Slurm.JOB_OK, mod.Slurm.JOB_MISSING,
               mod.Slurm.JOB_UNKNOWN}) == 3)

    # ── 11. IPv4 规范化（M2 回归）──────────────────────────────────────────
    print("\n── 11. IPv4 规范化 ──")
    for good in ("192.0.2.11", "203.0.113.5", "255.255.255.255"):
        check("接受 %s" % good, mod.normalize_ipv4(good) == good,
              str(mod.normalize_ipv4(good)))
    for bad in ("010.1.1.1", "1.2.3.04", "999.1.1.1", "1.2.3", "1.2.3.4.5",
                "1.2.3.4 ", " 1.2.3.4", "", "abc", None, "1.2.3.-1"):
        check("拒绝 %r" % (bad,), mod.normalize_ipv4(bad) is None,
              repr(mod.normalize_ipv4(bad)))

    # ── 12. node_ip 必须与 Slurm 交叉核对（M2 回归）──────────────────────
    print("\n── 12. node_ip 与 Slurm 交叉核对 ──")
    sess2 = {"uid": UID, "job_id": 5712, "candidates": "55017,55018"}
    job_real = {"JobState": "RUNNING", "NodeList": "node01"}
    good_info = {"schema": 1, "job_id": 5712, "uid": UID,
                 "node": "node01", "node_ip": "192.0.2.11",
                 "service_port": 55017, "state": "running"}
    # 交叉核对的依据是 scontrol 给出的权威 NodeAddr。用桩提供它，
    # 这样在任何机器上都能真正验证这条防线，而不是因为"本机没集群"
    # 让"正确的 node_ip 通过"以【检查被跳过】的方式假绿着通过。
    def node_stub(argv, timeout=10, check=False):
        args = [str(a) for a in argv]
        if "show" in args and "node" in args and args[-1] == "node01":
            return 0, "NodeName=node01 NodeAddr=192.0.2.11 State=IDLE\n", ""
        return 1, "", "Invalid node name specified"

    real_run_cmd2 = mod.run_cmd
    mod.run_cmd = node_stub
    try:
        ok, why = d.validate_session(sess2, good_info, job_real)
        check("正确的 node_ip 通过（与 Slurm 的 NodeAddr 一致）", ok, str(why))
        ok, why = d.validate_session(sess2, dict(good_info, node_ip="192.0.2.99"),
                                     job_real)
        check("伪造的 node_ip 被拒",
              not ok and why == "node_ip_mismatch_with_slurm", str(why))
    finally:
        mod.run_cmd = real_run_cmd2

    # 这一条是纯本地解析（IPv4 规范化），不碰集群
    ok, why = d.validate_session(sess2, dict(good_info, node_ip="010.1.1.1"),
                                 job_real)
    check("带前导零的 IP 被拒（纯本地解析）", not ok, str(why))

    # ── 13. 内存与数值参数（L6 回归）────────────────────────────────────────
    # ★ 这一节此前测的是【把正则抄了一遍】的本地函数 mem_ok()，而不是被测代码
    #   本身 —— 那样的用例在 sanitize_mem() 被改成什么都照样绿。现在直接调它。
    print("\n── 13. 内存与数值参数 ──")
    check("4G 合法", mod.sanitize_mem("4G", "8G") == ("4G", False))
    check("512M 合法", mod.sanitize_mem("512M", "8G") == ("512M", False))
    check("8 归一成 8（无单位）", mod.sanitize_mem("8", "8G") == ("8", False))
    # --mem=0 在 Slurm 里是"该节点的全部内存"，不是零 —— 必须被拒并回退，
    # 而且【必须告诉用户】（第二个返回值是"发生了回退"）。
    check("0 被拒并回退（Slurm 里 0 = 整机内存）",
          mod.sanitize_mem("0", "8G") == ("8G", True))
    check("0G 被拒并回退", mod.sanitize_mem("0G", "8G") == ("8G", True))
    check("负数被拒并回退", mod.sanitize_mem("-1", "8G") == ("8G", True))
    check("乱码被拒并回退", mod.sanitize_mem("abc", "8G") == ("8G", True))
    check("单位小写被拒（Slurm 只认大写）",
          mod.sanitize_mem("8g", "8G") == ("8G", True))
    # 缺失（None/空串）是"没说"，不是"填错了" —— 不该产生一条回退警告
    check("缺失用默认值且不算回退",
          mod.sanitize_mem(None, "8G") == ("8G", False)
          and mod.sanitize_mem("", "8G") == ("8G", False))

    check("cpus 缺失 → 服务端默认 2", mod.clamp_int(None, 2, 1, 64) == 2)
    check("cpus 超上限被钳制", mod.clamp_int(999, 2, 1, 64) == 64)
    check("cpus 负值被钳到下限", mod.clamp_int(-5, 2, 1, 64) == 1)
    check("cpus 非数字 → 默认值", mod.clamp_int("abc", 2, 1, 64) == 2)

    # ── 14. cluster_cidr：三种写错的方式都必须被拦 ─────────────────────────
    # 这一项的失效方向全是 fail-open：不报错，只是 ACL 不再生效。
    print("\n── 14. cluster_cidr 校验 ──")
    def cidr_problem(v):
        t = mod.Config(os.path.join(tmpdir, "slurmate.conf"))
        t.__dict__["cluster_cidr"] = v
        return t.cluster_cidr_problem()

    check("合法网段通过", cidr_problem("192.0.2.0/24") is None)
    check("留空被拒（它没有安全的默认值）", cidr_problem("") is not None)
    check("不带前缀长度被拒", cidr_problem("192.0.2.0") is not None)
    check("前缀长度越界被拒（此前【不校验】，nft 里是语法错误）",
          cidr_problem("192.0.2.0/99") is not None)
    check("前缀长度 0 被拒（基础规则会恒为假）",
          cidr_problem("192.0.2.0/0") is not None)
    check("前缀非数字被拒", cidr_problem("192.0.2.0/abc") is not None)
    check("地址部分非法被拒", cidr_problem("abc/24") is not None)
    check("主机位不为 0 被拒并给出规范写法",
          "192.0.2.0/24" in (cidr_problem("192.0.2.5/24") or ""))
    # ★ 反过来的一条：文档网段【必须放行】。有人会想加一条"拒绝 RFC 5737 示例网段"
    #   来抓"照抄示例忘了改"，但那会拒绝一个完全合法的配置 —— 用 192.0.2.0/24 的
    #   测试集群是存在的，软件没有依据判定它不是真的。那个错误由下面的交叉核对抓，
    #   而且报得更准（点名是哪几个节点落在外面）。
    for ok_cidr in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24"):
        check("文档网段 %s 是合法配置，必须放行" % ok_cidr,
              cidr_problem(ok_cidr) is None, str(cidr_problem(ok_cidr)))

    # ── 15. cluster_cidr × Slurm 的 NodeAddr 交叉核对 ───────────────────────
    # 这是唯一能发现"网段漏掉了某个节点"的地方，而漏掉的后果是静默失效。
    print("\n── 15. cluster_cidr 与节点地址交叉核对 ──")
    def node_list_stub(nodes):
        def _run(argv, timeout=10, check=False):
            if "show node" in " ".join(str(a) for a in argv):
                return 0, "".join(
                    "NodeName=n%d NodeAddr=%s State=IDLE\n" % (i, ip)
                    for i, ip in enumerate(nodes)), ""
            return 1, "", "unexpected"
        return _run

    def crosscheck(cidr, nodes):
        t = mod.Config(os.path.join(tmpdir, "slurmate.conf"))
        t.__dict__["cluster_cidr"] = cidr
        return with_stub(mod, node_list_stub(nodes), lambda: mod.crosscheck_cidr(t))

    check("全部节点都在网段内 → 无错",
          crosscheck("192.0.2.0/24", ["192.0.2.11", "192.0.2.20"]) == [])
    errs = crosscheck("192.0.2.0/24", ["192.0.2.11", "198.51.100.20"])
    check("有节点落在网段外 → 报错并点名", len(errs) == 1 and "198.51.100.20" in errs[0],
          str(errs))
    # 查不到节点列表时【不阻塞启动】：那是控制器抖动，不是配置错了。
    # 因为一次查询失败而拒绝服务，会把一次瞬时抖动放大成一次停机。
    check("Slurm 查不到节点时放行（不能让抖动变成停机）",
          with_stub(mod, lambda a, timeout=10, check=False: (1, "", "down"),
                    lambda: mod.crosscheck_cidr(
                        mod.Config(os.path.join(tmpdir, "slurmate.conf")))) == [])
    # NodeAddr 写主机名（由 Slurm 解析）时无从判断 —— 跳过而不是误报
    check("NodeAddr 是主机名时跳过（无从判断）",
          crosscheck("192.0.2.0/24", ["node01.example.com"]) == [])

    # ── 16. 旧版数据库必须被明确拒绝 ────────────────────────────────────────
    # v0.2 删掉了 sessions.purpose 列，而 SQLite 的 CREATE TABLE IF NOT EXISTS
    # 不会改已存在的表。不拦的话，旧库上的每一次提交都会以内部错误失败。
    print("\n── 16. 数据库表结构 ──")
    import sqlite3 as _sq
    import signal as _sig
    old_db = os.path.join(tmpdir, "old-claims.db")
    c = _sq.connect(old_db)
    c.execute("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, uid INTEGER, "
              "purpose TEXT NOT NULL, partition TEXT NOT NULL)")
    c.commit()
    c.close()
    old_cfg = mod.Config(os.path.join(tmpdir, "slurmate.conf"))
    old_cfg.__dict__["db_path"] = old_db
    errs = old_cfg._db_schema_errors()
    check("旧库（有 purpose 列）被拒绝并给出可照做的修法",
          len(errs) == 1 and "rm -f" in errs[0], str(errs))
    # ★ 两个方向都要**点名**：只说"对不上"等于让运维自己去 diff 一张二十多列的
    #   表，而这是他半夜在机房唯一能拿到的东西。
    check("★ 多出来的那一列被点名（v0.1 的 purpose）",
          bool(errs) and "多 purpose" in errs[0], str(errs))
    check("★ 少掉的列也被点名（多与少是同一个判据的两头）",
          bool(errs) and "少 " in errs[0], str(errs))
    old_cfg.__dict__["db_path"] = os.path.join(tmpdir, "nosuch.db")
    check("库还不存在时不报错（Store 会建）", old_cfg._db_schema_errors() == [])

    # ── 17. sbatch 命令行（纯函数）─────────────────────────────────────────
    # 这些分支的错只会在真集群上、且只在某些分支上暴露，所以必须在本机断言。
    print("\n── 17. sbatch 命令行 ──")
    base_sess = {"session_id": "9f2c4a1bdeadbeef", "account": "myaccount",
                 "cpus": 2, "mem": "8G", "requested_time": "12:00:00",
                 "partition": "2080TI", "gres": None}

    # 作业脚本与短名现在是**显式入参**（见 build_sbatch_argv 的 docstring）——
    # 这条链路是"到底提交了哪一份"的唯一落点，所以它必须能被纯函数钉住。
    def argv_of(**over):
        js = over.pop("job_script", "/tmp/jobs/01M2JKM4P7Q8R2S5T9V0W3X6Y8.sbatch")
        sk = over.pop("service_kind", "code-server")
        return mod.build_sbatch_argv(cfg, dict(base_sess, **over), {"A": "1"},
                                     home, js, sk)

    a = argv_of()
    check("指定了分区 → 带 -p", "-p" in a and "2080TI" in a, str(a))
    check("没 GPU → 完全省略 --gres（不是 gpu:0）",
          not any(x.startswith("--gres") for x in a), str(a))
    check("默认不写 -w（节点由 Slurm 在分区内挑）", "-w" not in a, str(a))
    check("★ 作业名是 sj-<插件短名>（不再是会话 id）",
          "--job-name=sj-code-server" in a, str(a))
    check("★ 作业脚本路径是 argv 的**末项**（操作数在选项之后）",
          a[-1] == "/tmp/jobs/01M2JKM4P7Q8R2S5T9V0W3X6Y8.sbatch", str(a))

    # ★ 每个真插件都提交**它自己**那一份作业脚本。
    #
    # 这一条堵的是「提交了 code-server、跑起来的是 sshd」—— 一个插件一份成品之后，
    # 脚本路径由 op_submit 按 spec.id 算出来，而那个算错**在真机上隔着作业日志**，
    # 本仓库此前对这条链路零覆盖（第 18 节的 submit 是打桩的，看不见 argv）。
    for _sp in cfg.plugin_specs:
        _a = argv_of(service_kind=_sp.name,
                     job_script=os.path.join(cfg.jobs_dir, _sp.id + ".sbatch"))
        check("★ 插件 %s 提交的是它自己的那一份（末项 = <它的 ULID>.sbatch）"
              % _sp.name,
              _a[-1] == os.path.join(cfg.jobs_dir, _sp.id + ".sbatch")
              and "--job-name=sj-%s" % _sp.name in _a, str(_a[-1]))

    a = argv_of(partition="")
    check("分区为空串 → 不带 -p（交给 Slurm 的默认分区）",
          "-p" not in a, str(a))
    # ★ 库里那一格存的是**描述符的 JSON**（见 op_submit 里那段），所以这里喂的
    #   也是它。喂一个现拼的 `"gpu:2"` 就绕开了 load_gres() —— 而
    #   "自己写进去的值自己读不回来"恰恰是要守的那一件事。
    a = argv_of(gres=json.dumps({"name": "gpu", "count": 2}))
    check("没型号的 GRES → --gres=gpu:2", "--gres=gpu:2" in a, str(a))
    a = argv_of(gres=json.dumps({"name": "gpu", "type": "a100", "count": 2}))
    check("★ 带型号 → --gres=gpu:a100:2（拼的时候丢掉 type 就是今天那条缺陷）",
          "--gres=gpu:a100:2" in a, str(a))
    a = argv_of(gres=json.dumps({"name": "mps", "count": 100}))
    check("★ 名字不是 gpu 也表达得出来（GRES 是管理员自定义的，代码里没有白名单）",
          "--gres=mps:100" in a, str(a))
    a = argv_of(gres=json.dumps({"name": "shard", "type": "fast", "count": 1}))
    check("★ 认不出来的名字/型号照样提交（上限由集群判，不由这张白名单判）",
          "--gres=shard:fast:1" in a, str(a))
    # 坏掉的那一格：**宽容**（当没要 + 记一条 error），不是让整次提交炸掉 ——
    # 与 recover_from_rules() 对读不动的行是同一个取舍。代价如实说：这一次提交
    # 会**不带 GRES 跑起来**，而日志里有一条 error、会话视图里 gres 是 null。
    a = argv_of(gres="gpu:2")
    check("★ 库里那一格读不动时当没要（不让整次提交炸掉，但记 error）",
          not any(x.startswith("--gres") for x in a), str(a))
    check("★ 而 `load_gres` 认得的是 JSON 描述符，不是 `gpu:2` 那个串",
          mod.load_gres(json.dumps({"name": "gpu", "count": 2}))
          == {"name": "gpu", "type": None, "count": 2}
          and mod.load_gres("gpu:2") is None, "load_gres 的两种输入")
    a = mod.build_sbatch_argv(cfg, dict(base_sess, partition=""), {}, tmpdir,
                              "/tmp/j.sbatch", "code-server")
    check("家目录下没有日志子目录时回退到家目录根",
          any(x.endswith("slurm-%j.out") and tmpdir in x for x in a), str(a))

    # ── 18. op_submit：缺省值由服务端填，权限查不到时退化而不是拒绝 ─────────
    print("\n── 18. op_submit（服务端填默认值）──")
    d.user_home = lambda uid: home
    captured = {}
    seq = [0]

    class _Captured(dict):
        """`captured` 里那两个容器：**缺键时给 None，不抛**。

        ★ 这不是"把用例放松一点"。这一节每一条断言的前提都是"上面某一条成立"，
          而变异验证时那个前提**就是不成立的**。缺键时抛 `KeyError` 会让脚本
          **崩掉**，于是它后面几十条一条都不跑 —— 而"崩掉"与"一条都不红"在输出
          上长得一模一样，一次变异会把别的洞一起遮住（这个仓库在这上面栽过三次，
          见 CHANGELOG 的〈两处**测试自己**的脆弱〉）。给 None 则让那些断言
          **红掉**，那才是它们该做的事。
        """
        def __missing__(self, key):
            return None

    def run_submit(req, allowed="normal"):
        """跑一次 op_submit。返回 (响应, 记下来的 sess/env)。"""
        seq[0] += 1
        d.store = mod.Store(os.path.join(tmpdir, "submit-%d.db" % seq[0]))
        d.slurm = mod.Slurm(cfg)
        captured.clear()

        def _sub(sess, env, h, u, usr, job_script, service_kind):
            captured["sess"] = _Captured(sess)
            captured["env"] = _Captured(env)
            # ★ 顺带记下这一节唯一看得见作业脚本的地方：submit 被打桩之后，
            #   argv 根本不生成，所以"选了哪一份"只能从这里看。第 17 节的纯函数
            #   用例负责断言路径算得对，这里只保证**传下来了**。
            captured["job_script"] = job_script
            captured["service_kind"] = service_kind
            return 12345, None
        d.slurm.submit = _sub

        def _run(argv, timeout=10, check=False):
            a = [str(x) for x in argv]
            # 按【命令内容】而不是按路径判断：cfg.sacctmgr 在测试里指向临时目录
            # 里的桩文件，路径名里没有 "sacctmgr" 三个字。
            if "show" in a and "assoc" in a:
                # "dead" 只让【分区那一列】查不到，账户查询照常。
                # 这是真实可达的组合：account_for() 有 300 秒缓存，缓存建立之后
                # sacctmgr/slurmdbd 才开始抖动 —— 那时账户还查得到，权限查不到。
                # （sacctmgr 整体挂掉的话，op_submit 会在账户那一步就拒绝，
                #   根本走不到分区逻辑，所以那不是这条路径。）
                if allowed == "dead" and any("Partition" in x for x in a):
                    return 1, "", "slurmdbd is down"
                if any("Partition" in x for x in a):
                    return 0, "myaccount|\n", ""      # Partition 列为空 = 不限制
                return 0, "myaccount\n", ""
            return slurm_stub(argv, timeout, check)

        real = mod.run_cmd
        mod.run_cmd = _run
        try:
            resp = d.op_submit(UID, req)
        finally:
            mod.run_cmd = real
        d.store.close()
        # ★ 默认值也要是 _Captured：提交**失败**时 `_sub` 根本不会被调用，
        #   `captured` 里什么都没有 —— 那时给一个普通 `{}` 就会在下一行
        #   `sess["cpus"]` 上抛 KeyError，把脚本带崩。
        return resp, captured.get("sess", _Captured()), captured.get("env", _Captured())

    r, sess, env = run_submit({"op": "submit"})
    check("缺省提交成功", r.get("ok"), str(r))
    check("缺省 cpus=2、mem=8G（服务端填，客户端没给）",
          sess["cpus"] == 2 and sess["mem"] == "8G", "%s / %s" % (sess["cpus"], sess["mem"]))
    check("缺省分区是从有权限的列表里挑的（不是空）",
          sess["partition"] in ("A6000", "RTX8000", "2080TI"), sess["partition"])
    check("响应里带回实际选中的分区（用户事先不知道）",
          (r.get("data") or {}).get("partition") == sess.get("partition"), str(r.get("data")))
    check("缺省无 warning（服务端没替用户改任何东西）",
          "warning" not in (r.get("data") or {}),
          str((r.get("data") or {}).get("warning")))
    check("环境变量带上了分区与资源",
          env.get("SLURMATE_PARTITION") == sess["partition"]
          and env.get("SLURMATE_CPUS") == "2", str(env))

    r, sess, _ = run_submit({"op": "submit", "cpus": 999, "mem": "4G"})
    check("超上限的 cpus 被钳制", sess["cpus"] == mod.MAX_CPUS_REQUEST, str(sess["cpus"]))
    check("显式 mem 生效", sess["mem"] == "4G", sess["mem"])

    r, sess, _ = run_submit({"op": "submit", "mem": "0"})
    check("mem=0 被回退到默认，且【告知】用户",
          sess["mem"] == "8G" and "内存" in (r.get("data") or {}).get("warning", ""),
          str((r.get("data") or {}).get("warning")))

    r, sess, _ = run_submit({"op": "submit", "partition": "2080TI"})
    check("显式分区被尊重", sess["partition"] == "2080TI", sess["partition"])
    check("分区权限不限时放行", r.get("ok"), str(r))

    r, _s, _e = run_submit({"op": "submit", "partition": "NOSUCH"})
    check("不存在的分区 → bad_partition(code 2)",
          not r.get("ok") and r["code"] == 2 and r["error"]["kind"] == "bad_partition",
          str(r))

    # ★ 存进库里的是**描述符的 JSON**，不是 `"gpu:2"` 那个串 —— 那个串是给 Slurm
    #   的，存一份就等于同一件事有两个表示（写的时候一个、读回来再解析一个），
    #   而今天那条缺陷正是两者对不上。所以这里的判据是**存进去的东西本身**。
    def _stored_json(v):
        """把库里那一格解成对象；解不开就原样返回（**不抛**）。"""
        try:
            return json.loads(v)
        except (TypeError, ValueError):
            return v

    r, sess, _ = run_submit({"op": "submit", "gres": {"name": "gpu", "count": 2}})
    check("提交带 GRES → 库里存的是描述符的 JSON",
          _stored_json(sess["gres"]) == {"name": "gpu", "type": None, "count": 2},
          repr(sess["gres"]))
    check("★ 而它不是那个交给 Slurm 的串（两件事不许混成一个）",
          sess["gres"] != "gpu:2", repr(sess["gres"]))
    check("响应的 resources 里是同一个描述符",
          (r.get("data") or {}).get("resources", {}).get("gres")
          == {"name": "gpu", "type": None, "count": 2},
          str((r.get("data") or {}).get("resources")))
    r, sess, env = run_submit({"op": "submit", "partition": "RTX8000",
                               "gres": {"name": "mps", "count": 100}})
    check("★ 跨语言契约：环境变量是 SLURMATE_GRES（已无 SLURMATE_GPUS）",
          env.get("SLURMATE_GRES") == "mps:100" and "SLURMATE_GPUS" not in env,
          "GRES=%r / 有没有 GPUS=%s" % (env.get("SLURMATE_GRES"),
                                       "SLURMATE_GPUS" in env))
    r, sess, _ = run_submit({"op": "submit"})
    check("不提交 GRES → 库里那一格是空的（不是 'null' 那个字符串）",
          sess["gres"] is None and (r.get("data") or {}).get("resources", {}).get("gres") is None,
          repr(sess["gres"]))

    # ★★ 上限来自**集群的实际配置**，不是代码里那个写死的 8。
    #   夹具的 2080TI 每节点 8 张（真集群上就是 8）—— 从前 `MAX_GPUS_REQUEST = 8`
    #   在这里恰好也过得去，所以换一个**比 8 大**的分区来钉：RTX8000 那一台
    #   每节点 4 张 + mps:100。看 mps 那一条。
    r, _s, _e = run_submit({"op": "submit", "partition": "RTX8000",
                            "gres": {"name": "mps", "count": 100}})
    check("★ 每节点 100 个的那种 GRES 也能要到 100（硬编码 8 会在这里红）",
          r.get("ok"), str(r))
    r, _s, _e = run_submit({"op": "submit", "partition": "RTX8000",
                            "gres": {"name": "mps", "count": 101}})
    check("★ 超过**这个分区**的上限 → bad_gres，且那句话里有数",
          not r.get("ok") and r["error"]["kind"] == "bad_gres"
          and "100" in r["error"]["detail"] and "101" in r["error"]["detail"],
          str(r))
    r, _s, _e = run_submit({"op": "submit", "partition": "A6000",
                            "gres": {"name": "gpu", "type": "a100", "count": 8}})
    check("★ 分区自己的上限：A6000 每节点 2 张 → 要 8 张被拒",
          not r.get("ok") and r["error"]["kind"] == "bad_gres"
          and "2" in r["error"]["detail"], str(r))
    r, _s, _e = run_submit({"op": "submit", "partition": "2080TI",
                            "gres": {"name": "gpu", "type": "a100", "count": 1}})
    check("★ 型号对不上 → 拒绝（这个分区没有 a100）",
          not r.get("ok") and r["error"]["kind"] == "bad_gres"
          and "a100" in r["error"]["detail"], str(r))
    r, _s, _e = run_submit({"op": "submit", "partition": "2080TI",
                            "gres": {"name": "nvidia", "count": 1}})
    check("★ 名字对不上 → 拒绝，且把**这个分区有什么**说出来",
          not r.get("ok") and r["error"]["kind"] == "bad_gres"
          and "gpu" in r["error"]["detail"], str(r))
    r, _s, _e = run_submit({"op": "submit", "partition": "2080TI",
                            "gres": {"name": "gpu", "count": 16}})
    check("★ 2080TI 每节点 8 张、要 16 张 → 拒绝（不是悄悄截成 8）",
          not r.get("ok") and r["error"]["kind"] == "bad_gres", str(r))
    # 没点名分区（会随机挑一个）→ 必须**从装得下它的分区里**挑。mps 只有
    # RTX8000 有 —— 从前那句 `random.choice(usable)` 会随机落到 2080TI 上被拒，
    # 而用户没有任何办法绕开（他本来就没指定分区）。界面上给的选项也是并集，
    # 两边必须是同一句话。
    _picked = set()
    for _ in range(12):
        r, sess, _ = run_submit({"op": "submit", "gres": {"name": "mps", "count": 100}})
        if not r.get("ok"):
            check("★ 没点名分区时只从装得下它的分区里挑",
                  False, "%s / %s" % (r.get("error"), sess["partition"]))
            break
        _picked.add(sess["partition"])
    else:
        check("★ 没点名分区时只从装得下它的分区里挑（mps 只有 RTX8000 有）",
              _picked == {"RTX8000"}, str(sorted(_picked)))
    # ★ 而过滤**不能**把"随机挑"变成"永远挑同一个"：不带型号的 gpu 要 2 个，
    #   三个分区都装得下 ⇒ 落点必须分散（12 次全落同一个的概率约 3^-11）。
    _picked2 = set()
    for _ in range(12):
        _r2, _s2, _ = run_submit({"op": "submit", "gres": {"name": "gpu", "count": 2}})
        if _r2.get("ok"):
            _picked2.add(_s2["partition"])
    check("★ 过滤之后**仍然是随机挑**（不是永远挑第一个装得下的）",
          len(_picked2) >= 2, str(sorted(_picked2)))
    r, _s, _e = run_submit({"op": "submit",
                            "gres": {"name": "gpu", "type": "nosuch", "count": 1}})
    check("★ 有权限的分区一个都装不下 → bad_gres，且那句话里有原因",
          not r.get("ok") and r["error"]["kind"] == "bad_gres"
          and "nosuch" in r["error"]["detail"], str(r))

    # 后面几条要临时让"目录查不到"，这里先留一份真身。
    _real_cat = mod.Slurm.gres_catalog

    # ★★ 形状判据**自己**要能挡住 —— 不能靠下游"目录里没有这个名字"顺手挡住。
    #   两件事是两码事：**目录查不到时下游是放行的**（权威在 Slurm），那时一个带
    #   `:` 的名字会**原样拼进 `--gres`** —— `a:b:2` 在 Slurm 眼里是"名字 a、型号 b"，
    #   与用户写下来的东西根本不是一回事，而且没有任何地方会报错。
    #   （变异验证里"名字里放行 `:` 与 `,`"一开始**没红**，红的原因就是这层缺了。）
    for _bad in ("a:b", "a,b", "gp u", "gpu;rm", "gpu\n"):
        check("★★ clean_gres 自己挡住名字里的 %r（不靠目录）" % _bad,
              mod.clean_gres({"name": _bad, "count": 2})[1] is not None,
              str(mod.clean_gres({"name": _bad, "count": 2})))
    check("★ type 那一格同理",
          mod.clean_gres({"name": "gpu", "type": "a:b", "count": 2})[1] is not None
          and mod.clean_gres({"name": "gpu", "type": "a,b", "count": 2})[1] is not None,
          str(mod.clean_gres({"name": "gpu", "type": "a:b", "count": 2})))
    # 而**目录查不到**时它照样挡：那正是上面那条的理由。
    mod.Slurm.gres_catalog = lambda self, ttl=300: None
    try:
        r, _s, _e = run_submit({"op": "submit", "gres": {"name": "a:b", "count": 1}})
        check("★★ 目录查不到时，带 `:` 的名字仍然被拒（下游这时是放行的）",
              not r.get("ok") and r["error"]["kind"] == "bad_gres", str(r))
    finally:
        mod.Slurm.gres_catalog = _real_cat

    # 形状不合法的几种：都必须在**提交之前**被拒（不能靠 sbatch 报错）。
    for _bad, _why in (
        ("gpu:2", "不是一个对象"),
        ({"name": "gpu", "count": 2, "type": "a:100"}, "type 里有分隔符"),
        ({"name": "gp u", "count": 2}, "name 里有空格"),
        ({"name": "gpu", "count": 0}, "count 是 0"),
        ({"name": "gpu", "count": -1}, "count 是负数"),
        ({"name": "gpu", "count": "2"}, "count 是字符串"),
        ({"name": "gpu", "count": 2.5}, "count 不是整数"),
        ({"name": "gpu", "count": mod.MAX_GRES_COUNT + 1}, "count 超量级护栏"),
        ({"count": 2}, "没有 name"),
        ({"name": "", "count": 2}, "name 是空串"),
    ):
        r, _s, _e = run_submit({"op": "submit", "gres": _bad})
        check("形状不合法被拒（%s）→ bad_gres" % _why,
              not r.get("ok") and r["error"]["kind"] == "bad_gres", str(r))

    # ★ 目录查不到时**放行**（由 Slurm 判），而不是拒绝所有带 GRES 的提交 ——
    #   一次控制器抖动不该让所有人提交不了。
    mod.Slurm.gres_catalog = lambda self, ttl=300: None
    try:
        r, _s, _e = run_submit({"op": "submit", "partition": "2080TI",
                                "gres": {"name": "gpu", "count": 8}})
        check("★ 查不到集群的 GRES 时放行（权威在 Slurm，不在我们）",
              r.get("ok"), str(r))
    finally:
        mod.Slurm.gres_catalog = _real_cat

    r, sess, _ = run_submit({"op": "submit", "time": "183-00:00:00"})
    check("超过分区 MaxTime 与硬上限的时间被截断",
          sess["requested_time"] == "7-00:00:00", sess["requested_time"])
    check("截断时间会告知用户", "上限" in (r.get("data") or {}).get("warning", ""),
          str((r.get("data") or {}).get("warning")))

    r, sess, env = run_submit({"op": "submit", "time": "nonsense"})
    check("无法解析的时间 → bad_time(code 2)",
          not r.get("ok") and r["error"]["kind"] == "bad_time", str(r))

    # ★ 权限查不到时的两条路径必须【不同】：
    #   显式点名了分区 → fail-closed（用户表达了意图，沉默地落到别处更糟）；
    #   没点名 → 退化为不带 -p，交给 Slurm 的 association 兜住。
    #   这里没有任何安全损失：我们没有对权限做任何声明。别把它"修"成拒绝 ——
    #   那会让一次 sacctmgr 抖动变成所有用户都开不了会话。
    r, sess, env = run_submit({"op": "submit"}, allowed="dead")
    check("权限查不到 + 没点名分区 → 仍然成功（退化）", r.get("ok"), str(r))
    check("退化时 partition 为空串", sess["partition"] == "", repr(sess["partition"]))
    check("退化会告知用户实际交给了 Slurm",
          "默认分区" in (r.get("data") or {}).get("warning", ""), str((r.get("data") or {}).get("warning")))
    # ★ 包一层 try：这一条要断言的是"那份 argv 里没有 -p"，而**上一句失败时
    #   `sess` 是空的**（变异验证里"提交根本没成功"正是被测的那件事）——
    #   让它抛出去会把整个脚本带崩，而崩了与"一条都不红"在输出上分不开。
    #   拿不到 argv 就当成一条红的，那才是它该有的结果。
    try:
        _argv_dead = mod.build_sbatch_argv(cfg, dict(sess, session_id="x"),
                                           env, home, "/tmp/j.sbatch",
                                           "code-server")
    except Exception as _e:                                  # noqa: BLE001
        _argv_dead = ["<拼不出 argv：%s>" % _e]
    check("退化时 sbatch 不带 -p", "-p" not in _argv_dead, str(_argv_dead))

    r, _s, _e = run_submit({"op": "submit", "partition": "2080TI"}, allowed="dead")
    check("权限查不到 + 点名了分区 → 拒绝（fail-closed）",
          not r.get("ok") and r["error"]["kind"] == "partitions_unknown", str(r))

    r, _s, _e = run_submit({"op": "submit", "partition": "2080TI"})
    d.store.close()

    # ── 19. 服务种类（code-server / sshd）───────────────────────────────────
    #
    # 一个会话提供哪种服务。两条路互斥，由 run.sbatch 的分派结构性地
    # 保证。这里测的是守护进程这一侧：缺省、开关、公钥、以及"从 nft 规则恢复出来
    # 的会话不许猜自己是什么服务"。
    print("\n── 19. 插件（服务种类）──")

    # 19.0 ★★ 插件表是**扫出来的**，不是代码里写死的
    #
    # 这一节是全节的支点。守护进程里**没有任何一个插件的名字** —— 表来自
    # <prefix>/share/slurmate/plugins/<ULID>.splug，由安装器装进去（deploy.sh
    # 只是把包交给它）。加一个插件因此是「放一个包 + 跑一次 deploy.sh」，
    # 不是「改守护进程的源码」。
    # ★ 这里从前写的是 `*/plugin.json` + "放一个目录" —— 那是 v0.6 的布局。
    print("\n  -- 19.0 扫出来的插件表 --")
    check("★ 扫出了两个插件（表来自磁盘，不是代码常量）",
          sorted(cfg.plugin_by_name) == [CS, SSHD], str(sorted(cfg.plugin_by_name)))
    check("清单合法时没有诊断输出", cfg.plugin_problems == (), str(cfg.plugin_problems))
    check("每个 spec 都记得自己的**包**在哪（分发与报错都用它）",
          all(s.source_package and s.source_package.endswith(mod.PLUGIN_PACKAGE_SUFFIX)
              for s in cfg.plugin_specs),
          str([s.source_package for s in cfg.plugin_specs]))
    check("★ job_entry 是按短名推出来的真契约（与 run.sbatch 的 plugin_call 同一条规则）",
          cfg.plugin_by_name[CS].job_entry == "start_code_server"
          and cfg.plugin_by_name[SSHD].job_entry == "start_sshd",
          "%s / %s" % (cfg.plugin_by_name[CS].job_entry,
                       cfg.plugin_by_name[SSHD].job_entry))
    # ★ 「有没有作业侧」现在是**一个事实**，不是一条合法性判据：两个真插件都有，
    #   而没有的那种是**合法**的（见 19.0e）。所以这里断言的是"这两个有"，
    #   不是"所有插件都必须有"。
    check("★ 两个真插件都有作业侧实现，且守护进程认得这件事",
          all(s.needs_job for s in cfg.plugin_specs),
          str([(s.name, s.needs_job) for s in cfg.plugin_specs]))
    check("★ 每个插件的作业脚本都在（<jobs_dir>/<ULID>.sbatch）",
          cfg.plugin_job_missing == [],
          str([s.name for s in cfg.plugin_job_missing]))
    for _s in cfg.plugin_specs:
        check("★ %s 的作业脚本文件确实存在，且里面只有它自己"
              % _s.name,
              os.path.isfile(os.path.join(cfg.jobs_dir, _s.id + ".sbatch")),
              os.path.join(cfg.jobs_dir, _s.id + ".sbatch"))

    # 坏掉的包：**跳过并报出来，但绝不让守护进程起不来**。一个插件坏了不该
    # 带走整个站点 —— 而静默跳过同样不行（"我明明装了啊"会变成一句谁也答不上来的话）。
    _baddir = os.path.join(tmpdir, "plugins-broken")
    os.makedirs(_baddir, exist_ok=True)
    with open(os.path.join(HERE, os.pardir, "plugins", CS, "plugin.json"),
              "rb") as _f:
        _cs_manifest = _f.read()
    put_package(_baddir, [("plugin.json", _cs_manifest)])          # 好的那一份
    # 坏①：根本不是包（下载了一半的字节）
    with open(os.path.join(_baddir, "half-download.splug"), "wb") as _f:
        _f.write(b"splug\x1a\r\n\x00\x00")
    # 坏②：是一个能解析的包，但负载里没有 plugin.json
    put_package(_baddir, [("README.md", b"x\n")],
                filename="01M2JKHTZGQ7X8V4T5R6N7B8C9.splug")
    # 坏③：**一个目录**（不是包）。它不是"跳过"，是一条明确的错误 ——
    #       因为目录既不会被分发、也不会被读到，留着就是一份看不见的副本。
    os.makedirs(os.path.join(_baddir, "old-layout"), exist_ok=True)
    with open(os.path.join(_baddir, "old-layout", "plugin.json"), "wb") as _f:
        _f.write(_cs_manifest)
    _specs2, _probs2 = mod.scan_plugins(_baddir)
    check("★ 一个坏包不会让守护进程起不来（跳过它，其余照常）",
          [s.name for s in _specs2] == [CS], str([s.name for s in _specs2]))
    check("★ 但它必须被**报出来**，而且点名是哪一个",
          len(_probs2) == 3 and any("half-download" in p for p in _probs2)
          and any("01M2JKHTZGQ7X8V4T5R6N7B8C9" in p for p in _probs2)
          and any("old-layout" in p for p in _probs2),
          str(_probs2))
    # ★ 报出来必须**给出下一步** —— 只诊断不指出路，等于把"这怎么办"留给运维猜。
    #   现在没有任何东西会去清它（自动迁移在 v0.7 删掉了），所以这两条是全部的出口。
    check("★★ 目录那条错误给出下一步（打包或删掉），不是只诊断",
          any("old-layout" in p and "packer build" in p and "删掉" in p
              for p in _probs2),
          str([p[:80] for p in _probs2]))
    # ★ 而**非包非目录**的普通文件同样报出来：`PLUGINS_SRC` 里放错东西时，
    #   预检就该红，而不是等到守护进程扫完一圈什么都不说。
    _stray = os.path.join(tmpdir, "plugins-stray")
    os.makedirs(_stray, exist_ok=True)
    with open(os.path.join(_stray, "notes.txt"), "w", encoding="utf-8") as _f:
        _f.write("随手放在这儿的东西\n")
    _sx, _px = mod.scan_plugins(_stray)
    check("★ 目录里一个普通的文件也被点名（不是悄悄忽略）",
          _sx == () and len(_px) == 1 and "notes.txt" in _px[0], str(_px))

    # 零插件：**合法状态**，不是"安装包坏了"。
    _emptydir = os.path.join(tmpdir, "plugins-empty")
    os.makedirs(_emptydir, exist_ok=True)
    _specs3, _probs3 = mod.scan_plugins(_emptydir)
    check("★ 一个插件都没装是合法状态（空表、且不是错误）",
          _specs3 == () and _probs3 == (), "%s / %s" % (_specs3, _probs3))
    check("目录根本不存在时同样返回空表、不报错（全新安装就是这个样子）",
          mod.scan_plugins(os.path.join(tmpdir, "no-such-dir")) == ((), ()))

    # 19.0b 清单的形状（跨语言的那几条）
    #
    # 守护进程是 Python、客户端是 JS，两边各自实现同一套清单规则。规则漂了的后果
    # 不是崩溃，而是**一边收下、一边拒了**，而报错只会说"清单不合法"。
    def _manifest(text, name="whatever.splug"):
        # 一份清单编成一个包再扫 —— **包的文件名不参与身份判定**，所以这里故意用
        # 一个与短名无关的名字。
        d = os.path.join(tmpdir, "mf-%d" % time.time_ns())
        os.makedirs(d, exist_ok=True)
        put_package(d, [("plugin.json", text.encode("utf-8"))], filename=name)
        return mod.scan_plugins(d)

    _okmf = json.dumps({
        "id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup", "version": "1.0.0",
        "displayName": "J", "site": {"defaultCpus": 1, "defaultMem": "1G"}})
    _s, _p = _manifest(_okmf)
    check("一份最小的合法清单被收下", len(_s) == 1 and _p == (), "%s / %s" % (_s, _p))
    if _s:
        check("没写的地方用框架的缺省：不需要公钥、缺省不开、没有 bin",
              _s[0].needs_pubkey is False and _s[0].default_enabled is False
              and _s[0].bin_env is None)
        check("displayName 缺了就退回短名（它不影响任何判定，不该因此拒收）",
              mod.parse_plugin_manifest("x.splug:plugin.json",
                                        {"id": _s[0].id, "name": "jup",
                                         "version": "1.0.0",
                                         "site": {"defaultCpus": 1,
                                                  "defaultMem": "1G"}})[0].title
              == "jup")

    for _txt, _why, _kw in (
            (json.dumps({"id": "short", "name": "jup", "version": "1.0.0",
                         "site": {"defaultCpus": 1, "defaultMem": "1G"}}),
             "id 不是 26 字符的 ULID", "id"),
            (json.dumps({"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "Jup",
                         "version": "1.0.0",
                         "site": {"defaultCpus": 1, "defaultMem": "1G"}}),
             "短名有大写", "name"),
            (json.dumps({"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup",
                         "version": "1.0",
                         "site": {"defaultCpus": 1, "defaultMem": "1G"}}),
             "版本号不是 x.y.z", "version"),
            (json.dumps({"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup",
                         "version": "1.0.0"}),
             "缺 site.defaultCpus / defaultMem", "defaultCpus"),
            (json.dumps({"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup",
                         "version": "1.0.0",
                         "site": {"defaultCpus": 1, "defaultMem": "0"}}),
             "defaultMem 写成 Slurm 的整机内存", "defaultMem"),
            (json.dumps({"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup",
                         "version": "1.0.0", "engines": {"slurmate": ">=99.0"},
                         "site": {"defaultCpus": 1, "defaultMem": "1G"}}),
             "要求一个这边还没有的框架版本", "slurmate"),
            (json.dumps({"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup",
                         "version": "1.0.0",
                         "site": {"defaultCpus": 1, "defaultMem": "1G",
                                  "bin": {"env": "PATH", "fallback": "/x"}}}),
             "bin.env 想覆盖一个不属于本系统的变量", "SLURMATE_"),
            (json.dumps({"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup",
                         "version": "1.0.0",
                         "site": {"defaultCpus": 1, "defaultMem": "1G",
                                  "bin": {"env": "SLURMATE_X",
                                          "discovery": "which"}}}),
             "discovery=which 却没给 name", "name"),
            (json.dumps({"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup",
                         "version": "1.0.0",
                         "site": {"defaultCpus": 1, "defaultMem": "1G",
                                  "enumKeys": {"mode": {"choices": ["a", "b"],
                                                        "default": "c"}}}}),
             "enumKeys 的 default 不在 choices 里", "default")):
        _s2, _p2 = _manifest(_txt)
        _msg2 = " ".join(_p2)
        # 断言的是"**一个都没收下** + 报错里点到了那一项"，不是"函数返回了 None" ——
        # scan_plugins 的契约是 (specs, problems)，坏清单的 specs 是空元组。
        check("清单：%s → 被拦下" % _why, _s2 == () and _kw in _msg2,
              (_msg2[:130] or str(_s2)))

    # 短名撞车：两个包抢一个短名 —— **两个都不收**。挑一个的后果是"哪个生效"
    # 取决于文件名的字典序，而那是没人会想到去查的地方。
    #
    # ★ 它们的 **id 不同**（真实世界里同 id 的两个包会落到同一个文件名上、由
    #   安装器在装的那一刻拦掉，见 19.15）。这里要测的是短名这一条判据本身：
    #   `scan_plugins` 是守护进程**启动时**的最后一道，它必须在包已经在盘上之后
    #   仍然拦得住。
    _dupdir = os.path.join(tmpdir, "plugins-dup")
    os.makedirs(_dupdir, exist_ok=True)
    for _sub, _ver, _uid in (("a", "1.0.0", "01M2JKHTZGKJBFQQTWYXMQMF2V"),
                             ("b", "2.0.0", "01M2JKHTZGKJBFQQTWYXMQMF3A")):
        put_package(_dupdir, [("plugin.json", json.dumps(
            {"id": _uid, "name": "jup", "version": _ver,
             "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8"))])
    _s3, _p3 = mod.scan_plugins(_dupdir)
    check("★ 两个包抢一个短名 → 两个都不加载（挑一个等于让文件名决定行为）",
          _s3 == () and any("重复" in p for p in _p3), "%s / %s" % (_s3, _p3))

    # 19.0b2 ★★ 版本号：两套方案，一条比较规则 —— 夹具与**客户端读的是同一份**
    #
    # 这个仓库里有**两套**版本号，它们长得像、纪律共用，但**不是一回事**：
    #   · **框架版本** `x.y` —— 客户端 / 守护进程 / 协议三合一的那个号（就是本
    #     文件的 `VERSION`）。`x` 是"可以不兼容"那一档，`y` 是"加东西但不破坏
    #     兼容"那一档。★ 运行期**有一条版本握手**（客户端连上时问一次 `ping`），
    #     但**本文件不执行它** —— 它拿不到客户端的版本（老客户端不带）。所以
    #     夹具的 `check` 段这一段用例**不读**：为"三端都读"而写一个没人调的
    #     `version_check`，正是这个仓库最忌的那种死代码。
    #   · **插件版本** `x.y.z` —— 清单里的 `version`，`(id, 版本)` 槽位的键。
    #
    # ★ 为什么两边读同一份文件（tools/version-fixtures.json）：规则在 JS 与
    #   Python 里各写了一遍，而"逐条一致"靠两份抄本加一条比对 lint 是**抓不到
    #   漂的** —— lint 只看得见已经漂了的那部分。夹具只有一份：谁跟不上谁红。
    print("\n  -- 19.0b2 版本号（两套方案，夹具与客户端共用）--")
    with open(os.path.join(os.path.dirname(HERE), "tools",
                           "version-fixtures.json"), encoding="utf-8") as _fv:
        _fx = json.load(_fv)

    check("★ 守护进程自己的 VERSION 合框架版本的形状（忘改成 x.y 时红在本地）",
          mod.FRAMEWORK_VERSION_RE.match(mod.VERSION) is not None, repr(mod.VERSION))

    for _scheme, _re_ in (("framework", mod.FRAMEWORK_VERSION_RE),
                          ("plugin", mod.PLUGIN_VERSION_RE)):
        _good, _bad = _fx[_scheme]["valid"], _fx[_scheme]["invalid"]
        _wrong = [repr(x) for x in _good if not _re_.match(x)]
        _wrong += [repr(x) for x in _bad if _re_.match(x)]
        check("★ %s 版本：%d 条合法 + %d 条不合法，逐条对上夹具"
              % (_scheme, len(_good), len(_bad)), not _wrong, ", ".join(_wrong[:6]))

    # 大小。★ 走**真的比较器**，不是拿 `_cmp_ver` 现拼一个：`cmp_framework` 是
    # 后补的（在那之前，这一段是靠 `version_satisfies` 的两个闭区间夹出来的 ——
    # 也就是"用范围判定去测大小比较"，排序规则一旦写错，夹具跟着一起错）。
    # `plugin_version_cmp` 则是安装器报"升级 / 降级"用的那一个。
    for _scheme, _cmp in (("framework", mod.cmp_framework),
                          ("plugin", mod.plugin_version_cmp)):
        _cases = _fx["order"][_scheme]
        _wrong = []
        for _a, _b, _want in _cases:
            _got = _cmp(_a, _b)
            if _got != {"lt": -1, "eq": 0, "gt": 1}[_want]:
                _wrong.append("%s ? %s = %s（夹具说 %s）" % (_a, _b, _got, _want))
        check("★ %s 版本的大小：%d 组逐组对上（含 1.9<1.10 与 2^53 那两组）"
              % (_scheme, len(_cases)), not _wrong, "; ".join(_wrong[:4]))

    _wrong = []
    for _c in _fx["ranges"]["cases"]:
        _ok, _why = mod.version_satisfies(_c["host"], _c["range"])
        if _ok != _c["ok"]:
            _wrong.append("host=%r range=%r → %s（夹具说 %s：%s）"
                          % (_c["host"], _c["range"], _ok, _c["ok"], _why))
    check("★ engines.slurmate 的范围：%d 条逐条对上夹具（含 `>=0.5.0` 这类被拒的形状）"
          % len(_fx["ranges"]["cases"]), not _wrong, "; ".join(_wrong[:3]))

    # ★★ engines 这个键的**字段级**规则 —— 与客户端 `enginesProblem` 逐条一致。
    #
    # 从前这里是分家的：守护进程只认「engines 是 dict 且 slurmate 是非空字符串」，
    # 其余形状**静默跳过**（当成没有限制），而客户端全拒。夹具的 `ranges` 段钉不住
    # 它 —— 那一段喂的是 `host + range`，根本不构造一份清单。
    #
    # ★ 断言**两件事**：收不收下（`ok`），以及不收下时**是哪一种不收下**（`kind`）。
    #   只断言 ok 的话，"读不懂的范围串"与"不满足"会被混成一件事 —— 而它们对
    #   作者的含义完全不同：前者是"你这行写错了"（打包器当场就该拦住），后者才是
    #   "这个站点版本低"。夹具里 `^0.5` 那一条正是为此而设。
    _wrong = []
    for _i, _c in enumerate(_fx["engines"]["cases"]):
        _ret = mod.engines_problem(_c, _c.get("host"))
        if (_ret is None) != _c["ok"]:
            _wrong.append("#%d %s → %s（夹具说 ok=%s）"
                          % (_i, json.dumps(_c, ensure_ascii=False), _ret, _c["ok"]))
        elif not _c["ok"] and _ret[0] != _c["kind"]:
            _wrong.append("#%d %s → kind=%s（夹具说 %s）"
                          % (_i, json.dumps(_c, ensure_ascii=False), _ret[0], _c["kind"]))
    check("★★ engines 的字段级规则：%d 条逐条对上夹具（含 kind —— 读不懂的范围串"
          "是**形状**问题，不是「本站版本低」）" % len(_fx["engines"]["cases"]),
          not _wrong, "; ".join(_wrong[:3]))

    # ★ 上面那条钉的是**纯函数**。这一条钉它**真的接在清单那条路上** —— 函数写了
    #   但没人调（或者调用点被换成旧的那段内联逻辑），上一类是绿的。
    for _mf_eng, _want_ok in (({"slurmate": ">=0.5"}, True),
                              ({"slurmate": ">=99.0"}, False),
                              ({"slurmate": "^0.5"}, False),
                              ("slurmate", False),
                              ({"node": ">=18"}, False)):
        _s5, _p5 = _manifest(json.dumps(
            {"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup", "version": "1.0.0",
             "engines": _mf_eng,
             "site": {"defaultCpus": 1, "defaultMem": "1G",
                      "bin": {"env": "SLURMATE_X_BIN", "discovery": "which",
                              "name": "x", "fallback": "/usr/bin/x"}}}))
        _got_ok = _s5 != ()
        check("★ 走清单那一路：engines=%s ⇒ %s"
              % (json.dumps(_mf_eng, ensure_ascii=False),
                 "收下" if _want_ok else "**拒**"),
              _got_ok == _want_ok, str(_p5)[:160])

    # ★★ 一个 engines 不满足的包**装不上**（不是"装上了、只是不出现"）。
    #
    # 这一条要单独钉，因为"装上了但列表里没有"是这个仓库反复出现的那类谎话的
    # 形状：文件在盘上，而没有任何地方说得出它为什么不在列表里。安装器与
    # `scan_plugins` 共用 `parse_plugin_manifest`，所以判据只有一个 —— 但**后果**
    # 分两处（装：拒绝写入；扫：跳过并报一条 problem），两处都要验。
    _engdir = os.path.join(tmpdir, "plugins-engines")
    os.makedirs(_engdir, exist_ok=True)
    _engpkg = put_package(
        tmpdir, [("job/start.sh", b"start_e() { :; }\n"),
                 ("plugin.json", json.dumps({
                     "id": "01M2JKHTZGKJBFQQTWYXMQMF2W", "name": "eng",
                     "displayName": "要新基座", "version": "1.0.0",
                     "engines": {"slurmate": ">=99.0"},
                     "site": {"defaultCpus": 1, "defaultMem": "1G",
                              "bin": {"env": "SLURMATE_E_BIN", "discovery": "which",
                                      "name": "e", "fallback": "/usr/bin/e"}}})
                    .encode("utf-8"))],
        filename="engines-too-new.splug")
    _say = []
    _rc = mod.install_plugins([_engpkg], _engdir,
                              say=lambda *a: _say.append(" ".join(str(x) for x in a)))
    _out = "\n".join(_say)
    _dest = os.path.join(_engdir, "01M2JKHTZGKJBFQQTWYXMQMF2W.splug")
    # ★ 两条断言合成一条，是**故意的**：`rc != 0` 单独看会被"输入那一关"假绿
    #   （不是 root、组可写……任何一条都会让它非零），而"理由里有 >=99.0"只有在
    #   **真的走到 engines 那条判据**时才成立。分开写，前一条就是一句空话。
    check("★★ engines 不满足 ⇒ 安装器**拒绝**，且理由是 engines（不是输入那一关）",
          _rc != 0 and not os.path.exists(_dest) and ">=99.0" in _out,
          "rc=%s dest存在=%s\n%s" % (_rc, os.path.exists(_dest), _out[:400]))
    check("★ 拒绝时**两个版本号都说了出来**（管理员据此做决定：升本站，还是让作者放宽）",
          ">=99.0" in _out and mod.VERSION in _out, _out[:400])

    # 手放进目录（绕过安装器）的那一份：`scan_plugins` **跳过并报一条**，
    # 而不是让守护进程起不来 —— 一个插件坏了不该带走整个站点。
    shutil.copyfile(_engpkg, _dest)
    _specs6, _probs6 = mod.scan_plugins(_engdir)
    check("★ 手放进目录的同一个包：扫的时候**跳过并报一条 problem**（不带走整个站点）",
          _specs6 == () and any(">=99.0" in p for p in _probs6), str(_probs6)[:300])

    # ★ 清单里的版本号用**原串**匹配：`" 1.0.0 "` 不是合法版本号。从前这里先
    #   strip 再匹配，于是它在这边被收下、在客户端被拒 —— 而客户端拿的是原串
    #   （`VERSION_RE.test(mf.version)`）。夹具里那几条带空白的用例说的是同一个
    #   事实，但只有走一遍 need_str 才验得到**清单这条路**。
    for _bad_v in (" 1.0.0", "1.0.0 ", "1.0.0\n"):
        _s4, _p4 = _manifest(json.dumps(
            {"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup",
             "version": _bad_v, "site": {"defaultCpus": 1, "defaultMem": "1G"}}))
        check("清单里 version=%r 被拒（不许悄悄 strip）" % _bad_v,
              _s4 == (), str(_p4)[:140])

    # 19.0c ★★ 加一个插件**不需要改守护进程的任何一行**
    #
    # 这是「插件是独立项目」在集群侧的落点，所以它必须有一条**跑的**用例，而不是
    # 一句注释。这里合成一个全新的插件（仓库里没有它、守护进程更没听说过它），
    # 然后走一遍：扫描 → 配置块 → 提交 → 环境变量 → op_plugins。
    _thirddir = os.path.join(tmpdir, "plugins-third")
    os.makedirs(_thirddir, exist_ok=True)
    put_package(_thirddir, [
        # 作业侧那一半。**必须真的放一份**：没有它这个插件就是"合法但提交不了"，
        # 而这一节要验的恰恰是"能提交"。没有作业侧那一态由 19.0e 专门覆盖。
        ("job/start.sh", b"start_jup() { :; }\n"),
        ("plugin.json", json.dumps({
            "id": "01M2JKHTZGKJBFQQTWYXMQMF2X", "name": "jup",
            "version": "2.1.0", "displayName": "Jupyter",
            "engines": {"slurmate": ">=0.5"},
            "contributes": {"submitPubkey": False},
            "site": {"defaultCpus": 3, "defaultMem": "6G", "defaultEnabled": False,
                     "bin": {"env": "SLURMATE_JUP_BIN", "discovery": "convention",
                             "fallback": "/usr/local/bin/jupyter"},
                     "enumKeys": {"token_mode": {"choices": ["auto", "none"],
                                                 "default": "auto"}}},
        }).encode("utf-8")),
    ])
    _specs4, _probs4 = mod.scan_plugins(_thirddir)
    check("★ 一个守护进程从没听说过的插件被扫进来，一行代码都没改",
          _probs4 == () and [x.name for x in _specs4] == ["jup"], str(_probs4))
    _jup = _specs4[0]
    check("它的元数据全部来自清单（默认资源 / bin / 取值受限的键）",
          _jup.default_cpus == 3 and _jup.default_mem == "6G"
          and _jup.bin_env == "SLURMATE_JUP_BIN"
          and _jup.enum_default("token_mode") == "auto",
          "%s/%s/%s" % (_jup.default_cpus, _jup.default_mem, _jup.bin_env))
    check("★ 它的配置块允许的键 = 通用键 + bin + 清单里声明的那几个枚举键"
          "（没有第二份清单可以跟它矛盾）",
          _jup.block_keys() == ("enabled", "default_cpus", "default_mem",
                                "bin", "token_mode"),
          str(_jup.block_keys()))
    check("它的作业侧入口是按短名推出来的（与 run.sbatch 的 plugin_call 同一条规则）",
          _jup.job_entry == "start_jup", _jup.job_entry)

    _saved_plugins = cfg.plugins
    _saved_by = cfg.plugin_by_name
    _saved_specs = cfg.plugin_specs
    _saved_kinds = cfg.enabled_kinds
    try:
        cfg.plugin_specs = tuple(list(_saved_specs) + [_jup])
        cfg.plugin_by_name = dict(_saved_by, jup=_jup)
        cfg.plugins = dict(_saved_plugins)
        cfg.plugins["jup"] = mod.PluginConfig(_jup, {"enabled": "yes"}, True)
        cfg.enabled_kinds = tuple(sorted(n for n, q in cfg.plugins.items() if q.enabled))

        _r5, _sess5, _env5 = run_submit({"op": "submit", "service_kind": "jup"})
        check("★ 新插件能被提交，资源缺省来自**它自己的清单**（不是全局常量）",
              _r5.get("ok") and _sess5["cpus"] == 3 and _sess5["mem"] == "6G",
              str(_r5)[:160])
        check("它声明的那个变量名与解析出来的路径传给了作业",
              _env5.get("SLURMATE_JUP_BIN") == "/usr/local/bin/jupyter",
              repr(_env5.get("SLURMATE_JUP_BIN")))
        check("会话记住的解析键是 <id>@<版本>",
              _sess5.get("service_plugin") == "%s@%s" % (_jup.id, _jup.version),
              repr(_sess5.get("service_plugin")))
        check("站点没在块里写的那几个枚举键，取清单声明的缺省",
              cfg.plugins["jup"].enum.get("token_mode") == "auto",
              repr(cfg.plugins["jup"].enum))

        _pj = d.dispatch(os.getuid(), os.getgid(), {"op": "plugins"})
        _pnames = {x["name"] for x in (_pj.get("data") or {}).get("plugins", [])}
        check("op_plugins 也照实报出它（客户端据此画按钮）",
              "jup" in _pnames, str(sorted(_pnames)))
        # ★ can_submit：服务端把「开了 **且** 有作业侧」合成一个答案发出去，
        #   客户端据此画灰按钮。两个事实客户端只看得到前一个。
        _jup_row = next((x for x in (_pj.get("data") or {}).get("plugins", [])
                         if x["name"] == "jup"), {})
        check("★ op_plugins 报出 can_submit=true（开了 + 有作业侧）",
              _jup_row.get("can_submit") is True, str(_jup_row))
    finally:
        cfg.plugins = _saved_plugins
        cfg.plugin_by_name = _saved_by
        cfg.plugin_specs = _saved_specs
        cfg.enabled_kinds = _saved_kinds

    # 19.0e ★★ 没有作业侧：**合法状态**，但它提交不了，而且必须说得出来
    #
    # 一个只有客户端那一半的插件是允许存在的（它装得上、看得见）。它在三个地方
    # 必须被说清楚，缺一个就是一个死胡同：
    #   · 配置自检**通过** —— 一个插件的形态不该让整个站点起不来；
    #   · `op_submit` 明确拒绝（code 4 / service_kind_no_job），不是排完队才失败；
    #   · `op_plugins` 的 can_submit=false —— 界面据此画灰按钮，用户不必点了才知道。
    _nojdir = os.path.join(tmpdir, "plugins-nojob")
    os.makedirs(_nojdir, exist_ok=True)
    put_package(_nojdir, [("plugin.json", json.dumps({
        "id": "01M2JKHTZGKJBFQQTWYXMQMF30", "name": "decl",
        "version": "1.0.0", "displayName": "声明式",
        "engines": {"slurmate": ">=0.5"},
        "site": {"defaultCpus": 1, "defaultMem": "2G"}}).encode("utf-8"))])
    _specs5, _probs5 = mod.scan_plugins(_nojdir)
    check("★ 包里没有 job/start.sh 的插件能被扫进来（合法，不是坏包）",
          _probs5 == () and [x.name for x in _specs5] == ["decl"], str(_probs5))
    _decl = _specs5[0]
    check("★ 它被记为「没有作业侧」，而不是「坏掉的插件」",
          _decl.needs_job is False, str(_decl.needs_job))
    check("★ 判据来自**包里的记录表**（服务器上没有磁盘上的 job/start.sh 可查）",
          "job/start.sh" not in [f["path"] for f in
                                 mod.package_read_file(_decl.source_package)["files"]],
          _decl.source_package)

    _sj, _bj, _pj2, _kj, _dj = (cfg.plugin_specs, cfg.plugin_by_name,
                                cfg.plugins, cfg.enabled_kinds, cfg.default_plugin)
    _saved_missing = cfg.plugin_job_missing
    try:
        cfg.plugin_specs = tuple(list(_sj) + [_decl])
        cfg.plugin_by_name = dict(_bj, decl=_decl)
        cfg.plugins = dict(_pj2)
        cfg.plugins["decl"] = mod.PluginConfig(_decl, {"enabled": "yes"}, True)
        cfg.enabled_kinds = tuple(sorted(n for n, q in cfg.plugins.items() if q.enabled))
        # 它没有作业脚本，所以**不该**出现在 plugin_job_missing 里 —— 那个列表
        # 说的是"有作业侧却找不到脚本"（部署不完整），与"本来就没有作业侧"是
        # 两件完全不同的事。合并它们会让这条合法的状态被报成故障。
        cfg.plugin_job_missing = [s for s in cfg.plugin_specs
                                  if s.needs_job and not os.path.isfile(
                                      os.path.join(cfg.jobs_dir, s.id + ".sbatch"))]
        check("★ 没有作业侧的插件不进 plugin_job_missing（那是「部署不完整」，"
              "与它无关）",
              [s.name for s in cfg.plugin_job_missing] == [],
              str([s.name for s in cfg.plugin_job_missing]))
        check("★ 而且它不让配置自检失败（一个插件不该带走整个站点）",
              cfg.validate() == [], str(cfg.validate())[:160])

        d.store = mod.Store(os.path.join(tmpdir, "nojob.db"))
        _r8 = d.dispatch(UID, os.getgid(), {"op": "submit", "service_kind": "decl"})
        check("★ 提交它被明确拒绝：code 4 / service_kind_no_job",
              not _r8.get("ok") and _r8["code"] == 4
              and _r8["error"]["kind"] == "service_kind_no_job",
              str(_r8.get("error"))[:200])
        check("★ 而且错误信息说清是「没有作业侧」，不是「没开」"
              "（两句话对应两个完全不同的行动）",
              "没有作业侧实现" in (_r8["error"].get("detail") or "")
              and "没有开启" not in (_r8["error"].get("detail") or ""),
              str(_r8["error"].get("detail"))[:200])
        check("★ 错误信息里给出了出路：装了作业侧实现的插件是哪些",
              CS in (_r8["error"].get("detail") or ""),
              str(_r8["error"].get("detail"))[:200])
        # ★★ 而它必须说**包**，不能说"插件目录里没有 job/start.sh"。
        #   那句话说错了对象：服务器上**没有源码树**，`job/start.sh` 在这边只以
        #   "包里的一条负载记录"的形式存在（`needs_job` 就是这么来的）。按那句话
        #   去找的人会在插件安装目录里翻一个根本不存在的文件，而正确的动作是回去
        #   让作者补一份、重新打包。
        _d8 = _r8["error"].get("detail") or ""
        check("★★ 而且它说的对象是**包**，不是插件安装目录里的一个文件"
              "（服务器上没有源码树）",
              "包" in _d8 and "插件目录" not in _d8, _d8[:200])

        _pj3 = d.dispatch(UID, os.getgid(), {"op": "plugins"})
        _decl_row = next((x for x in (_pj3.get("data") or {}).get("plugins", [])
                          if x["name"] == "decl"), {})
        check("★ op_plugins 报出 can_submit=false —— 界面据此画灰按钮，"
              "用户不必点下去才知道",
              _decl_row.get("can_submit") is False, str(_decl_row))
        check("★ 但它同时 enabled=true（「本站关了它」与「它没有作业侧」"
              "是两句话，客户端要能分辨）",
              _decl_row.get("enabled") is True, str(_decl_row))
    finally:
        (cfg.plugin_specs, cfg.plugin_by_name, cfg.plugins,
         cfg.enabled_kinds, cfg.default_plugin) = _sj, _bj, _pj2, _kj, _dj
        cfg.plugin_job_missing = _saved_missing

    # 19.0d ★ 零插件：不是"坏掉的安装包"，而是"外壳"本身
    #
    # ★ 这三条是 client/src/main/plugins 那套崩溃安全不变量的集群侧对应物。
    #   客户端那半已经在 boot.test.mjs 里验过"卸掉插件不影响跑着的会话"，这里验
    #   的是**服务端**在零插件时的行为：能启动、能说清、明确拒绝 —— 而不是崩溃、
    #   不是静默。
    _sz, _bz, _pz, _kz, _dz = (cfg.plugin_specs, cfg.plugin_by_name,
                               cfg.plugins, cfg.enabled_kinds, cfg.default_plugin)
    try:
        cfg.plugin_specs, cfg.plugin_by_name, cfg.plugins = (), {}, {}
        cfg.enabled_kinds, cfg.default_plugin = (), ""
        # 上面的 run_submit 用完就把库关掉了（每个用例一个临时库），重开一个。
        d.store = mod.Store(os.path.join(tmpdir, "zero-plugin.db"))
        check("★ 零插件时配置自检**通过**（以前这里是一条让守护进程 100% 起不来的错误）",
              cfg.validate() == [], str(cfg.validate())[:160])
        _r6 = d.dispatch(UID, os.getgid(), {"op": "submit"})
        check("★ 不带 service_kind 的提交被明确拦住，并说清本站没配 default_plugin",
              not _r6.get("ok") and _r6["code"] == 2
              and _r6["error"]["kind"] == "missing_service_kind",
              str(_r6.get("error"))[:160])
        _r7 = d.dispatch(UID, os.getgid(), {"op": "submit",
                                            "service_kind": CS})
        check("★ 点了名的也被拦住（bad_service_kind，不是静默失败）",
              not _r7.get("ok") and _r7["code"] == 2
              and _r7["error"]["kind"] == "bad_service_kind",
              str(_r7.get("error"))[:160])
        _pz2 = d.dispatch(UID, os.getgid(), {"op": "plugins"})
        check("op_plugins 回一个空表（界面据此显示安装指引，而不是一个错误）",
              (_pz2.get("data") or {}).get("plugins") == []
              and (_pz2.get("data") or {}).get("enabled") == [],
              str(_pz2.get("data")))
    finally:
        (cfg.plugin_specs, cfg.plugin_by_name, cfg.plugins,
         cfg.enabled_kinds, cfg.default_plugin) = _sz, _bz, _pz, _kz, _dz

    # 19.1 配置块
    #
    # ★ 这一节的核心是**向后兼容**：一个块都没有的老配置必须仍然只开 code-server
    #   （它标了 site.defaultEnabled）。少了这条，所有现有站点升级后会一个服务都
    #   开不出来，而配置里一个字都不像有问题。

    def pcfg(text, name="plug.conf"):
        return mod.Config(write_conf("cluster_cidr = 192.0.2.0/24\n" + text, name))

    _c = pcfg("")
    check("★ 一个 [plugin:*] 块都没有 → 只有 code-server（与升级前完全一致）",
          _c.enabled_kinds == (CS,), str(_c.enabled_kinds))
    check("没写的块也有一份配置，且能分出「没写」与「写了但关着」",
          _c.plugins[SSHD].present is False
          and _c.plugins[SSHD].enabled is False)

    _c = pcfg("[plugin:sshd]\ndefault_cpus = 4\n")
    check("★ 写了块但没写 enabled → 仍然不开（一句 default_cpus 不该开出一条 ssh 的路）",
          _c.enabled_kinds == (CS,), str(_c.enabled_kinds))
    check("块里写的默认资源生效；没写的用插件自己的内建值",
          _c.plugins[SSHD].default_cpus == 4
          and _c.plugins[SSHD].default_mem == "2G",
          "%s / %s" % (_c.plugins[SSHD].default_cpus,
                       _c.plugins[SSHD].default_mem))

    _c = pcfg("[plugin:sshd]\nenabled = yes\n")
    check("★ 开 sshd 不会顺手关掉 code-server（管理员只想开中转站，不该丢掉 IDE）",
          _c.enabled_kinds == (CS, SSHD),
          str(_c.enabled_kinds))

    _c = pcfg("[plugin:code-server]\nenabled = no\n[plugin:sshd]\nenabled = yes\n")
    check("显式关掉 code-server 是合法的（站点只留中转站）",
          _c.enabled_kinds == (SSHD,), str(_c.enabled_kinds))

    _c = pcfg("[plugin:code-server]\nenabled = no\n")
    check("★ 一个插件都不开是**合法**的（「外壳」的定义：基座不因插件的有无而缺一块）",
          _c.enabled_kinds == () and _c.validate() == [], str(_c.validate())[:140])
    # ★ 但 default_plugin 指向一个**没装的**插件仍然是硬错误：那不是"本站没开
    #   某个服务"，而是"配置指向一个不存在的东西"—— 两者该做什么完全不同。
    _c = pcfg("default_plugin = nosuchplugin\n")
    check("★ default_plugin 指向没装的插件 → 启动就拒绝（不是等到用户提交才报错）",
          any("nosuchplugin" in e for e in _c.validate()),
          str(_c.validate())[:160])

    # 各种错法：一律**报错**，不能静默忽略 —— 静默忽略的后果是
    # 「文件里写着，而实际什么也没发生」，正是本项目一路在清的那类问题。
    for _txt, _why, _kw in (
            ("[plugin:ssh]\nenabled = yes\n", "未知的插件名", "ssh"),
            ("[plugin:sshd]\ndefualt_cpus = 1\n", "块内拼错的键", "defualt_cpus"),
            ("[plugin:sshd]\nenabled = yes\ncluster_cidr = 198.51.100.0/24\n",
             "通用键写到了块之后", "cluster_cidr"),
            ("[plugin:code-server]\nauth_mode = passwd\n", "auth_mode 取值非法",
             "auth_mode"),
            ("[plugin:sshd]\ndefault_mem = 0\n", "default_mem 写成 Slurm 的整机内存",
             "default_mem")):
        try:
            _errs = " ".join(pcfg(_txt).validate())
        except ValueError as _ex:
            _errs = str(_ex)
        check("%s → 被拦下" % _why, _kw in _errs, _errs[:110])

    # ★ 顺序陷阱的报错必须**指得回根因**。只断言"被拒了"是不够的：通用键落进块里
    #   时，块内键白名单那条**也会**拒绝它（它本来就不在允许列表里），于是"拒绝了"
    #   这件事两种实现都满足 —— 而这个分支存在的全部理由是那句话。
    #   变异验证发现：把 `if key in GLOBAL_KEYS` 改成 `if False`，上面那条断言照样
    #   绿。这一条就是补那个洞的。
    _msg = " ".join(pcfg("[plugin:sshd]\nenabled = yes\ncluster_cidr = 198.51.100.0/24\n")
                    .validate())
    check("★ 而且要说清是「通用键写到了块之后」，不是一句泛泛的「认不出这个键」",
          "通用键" in _msg and "块之前" in _msg, _msg[:140])

    # ★★ 同一个形状再来一条：**未知块名**那句话必须说清"装插件"是**放一个包**，
    #   而不是"放一个目录"。这一句是管理员唯一会照着做的那句话，说错了对象就
    #   等于把他指到一个不存在的动作上（见 `section_names_problem` 的 docstring：
    #   零插件与"名字写错了"是两种行动，而它们在配置里长得一模一样）。
    _um = " ".join(pcfg("[plugin:ssh]\nenabled = yes\n").validate())
    check("★★ 未知块名那句说清是「放一个 .splug 包」进安装目录，不是「放一个目录」",
          ".splug" in _um and "目录放" not in _um and "放一个目录" not in _um,
          _um[:220])

    # 19.0e ★ 缺省插件来自配置，不是写死的名字
    #
    # 这条与 19.3（`make_config` 那份配置里 default_plugin = code-server）合起来
    # 才完整：只测"缺省是 code-server"的话，一个把 code-server 写死的实现照样全绿
    # —— 而"写死一个缺省插件名"正是这一版要从基座里拿掉的东西。
    _c = pcfg("default_plugin = sshd\n[plugin:sshd]\nenabled = yes\n")
    check("default_plugin 被解析出来，且指向已装的插件时不是错误",
          _c.default_plugin == "sshd" and _c.validate() == [],
          "%r / %s" % (_c.default_plugin, _c.validate()[:1]))
    # ★ 但只查这个属性是**不够**的：把 `kind = cfg.default_plugin` 改成写死的
    #   `kind = "code-server"` 时它照样全绿 —— 而"写死一个缺省插件名"正是这一版
    #   要从基座里拿掉的东西。所以下面真的走一遍提交，看落到哪个插件上。
    _pub8 = ("ssh-ed25519 "
             "AAAAC3NzaC1lZDI1NTE5AAAAIKOQC0BF5KaDnhkVut1TZH7WyBhCtnK8zrunOAZ7wSGx")
    _sd, _sk = cfg.default_plugin, cfg.enabled_kinds
    _se = cfg.plugins[SSHD].enabled
    try:
        cfg.default_plugin = SSHD
        cfg.plugins[SSHD].enabled = True
        cfg.enabled_kinds = tuple(sorted(n for n, q in cfg.plugins.items() if q.enabled))
        _r8, _s8, _ = run_submit({"op": "submit", "ssh_pubkey": _pub8})
        check("★ 不带 service_kind 时**真的**落到配置里那个插件上（不是写死的名字）",
              _r8.get("ok") and _s8.get("service_kind") == SSHD,
              "%s / %s" % (str(_r8.get("error"))[:90], _s8.get("service_kind")))
    finally:
        cfg.default_plugin, cfg.enabled_kinds = _sd, _sk
        cfg.plugins[SSHD].enabled = _se

    # 19.2 公钥的解析（纯函数）。ed25519 的 blob 恒为 51 字节，形状可以卡死。
    _pub = ("ssh-ed25519 "
            "AAAAC3NzaC1lZDI1NTE5AAAAIKOQC0BF5KaDnhkVut1TZH7WyBhCtnK8zrunOAZ7wSGx")
    check("裸公钥通过", mod.parse_ssh_pubkey(_pub) == _pub)
    check("★ 客户端实际发的形态（带注释）通过，且注释被丢掉",
          mod.parse_ssh_pubkey(_pub + " slurmate-20260915-1145") == _pub,
          repr(mod.parse_ssh_pubkey(_pub + " slurmate-20260915-1145")))
    check("★ 注释里的逗号被丢掉 —— 它会把 --export 的一个变量劈成两个",
          mod.parse_ssh_pubkey(_pub + " a,b@example.com") == _pub,
          repr(mod.parse_ssh_pubkey(_pub + " a,b@example.com")))
    check("追加第二条公钥（多行）被拒",
          mod.parse_ssh_pubkey(_pub + "\n" + _pub) is None)
    check("选项前缀 command= 被拒（会被原样写进 authorized_keys）",
          mod.parse_ssh_pubkey('command="/bin/false" ' + _pub) is None)
    check("选项前缀 cert-authority 被拒",
          mod.parse_ssh_pubkey("cert-authority " + _pub) is None)
    check("非 ed25519 被拒", mod.parse_ssh_pubkey("ssh-rsa AAAAB3NzaC1yc2E") is None)
    check("★ 68 个合法 base64 字符但不是密钥 → 被拒（形状对、内容不对）",
          mod.parse_ssh_pubkey(
              "ssh-ed25519 " + base64.b64encode(b"\x00" * 51).decode()) is None)
    check("空串被拒", mod.parse_ssh_pubkey("") is None)

    # 19.3 缺省仍然是 code-server —— 与本功能引入前完全一致
    r, sess, env = run_submit({"op": "submit"})
    check("不传 service_kind 时缺省是 code-server",
          sess["service_kind"] == CS, str(sess.get("service_kind")))
    check("环境变量把服务种类传给了作业",
          env.get("SLURMATE_SERVICE_KIND") == CS, str(env))

    # 19.4 站点没开 sshd 时必须明确拒绝 —— 而不是起一个"看起来起来了但连不上"的作业
    r, _s, _e = run_submit({"op": "submit", "service_kind": "sshd",
                            "ssh_pubkey": _pub})
    check("★ 站点没开 sshd → code 4 service_kind_disabled",
          not r.get("ok") and r["code"] == 4
          and r["error"]["kind"] == "service_kind_disabled", str(r.get("error")))
    r, _s, _e = run_submit({"op": "submit", "service_kind": "telnet"})
    check("未知的服务种类 → code 2 bad_service_kind",
          not r.get("ok") and r["code"] == 2
          and r["error"]["kind"] == "bad_service_kind", str(r.get("error")))

    # 19.5 站点开启之后
    _saved = cfg.plugins[SSHD].enabled
    cfg.plugins[SSHD].enabled = True
    cfg.enabled_kinds = tuple(sorted(n for n, q in cfg.plugins.items() if q.enabled))
    try:
        r, sess, env = run_submit({"op": "submit", "service_kind": "sshd",
                                   "ssh_pubkey": _pub})
        check("开了之后 sshd 提交成功", r.get("ok"), str(r))
        check("会话记住了服务种类（界面据此决定「连接」做什么）",
              sess["service_kind"] == SSHD, str(sess.get("service_kind")))
        check("sshd 会话的 auth_mode 是 publickey，不是 password",
              sess["auth_mode"] == "publickey", sess["auth_mode"])
        check("缺公钥 → code 2 bad_ssh_pubkey",
              (lambda q: not q[0].get("ok") and q[0]["code"] == 2
               and q[0]["error"]["kind"] == "bad_ssh_pubkey")(
                   run_submit({"op": "submit", "service_kind": "sshd"})),
              "（见下一条的返回值）")
        check("公钥（连注释）传给了作业，且已规范化",
              env.get("SLURMATE_SSH_PUBKEY") == _pub,
              repr(env.get("SLURMATE_SSH_PUBKEY")))
        # ★ 守护进程**不**下发主机密钥目录之类"插件自己的路径"了：那是插件内部
        #   的事（sshd 插件的 job/start.sh 里写着 $HOME/.slurmate/ssh）。守护进程
        #   只下发插件的**清单**里声明过的那个 bin_env。
        check("守护进程按插件清单声明的变量名下发可执行文件路径",
              env.get("SLURMATE_SSHD_BIN") == cfg.plugins[SSHD].bin
              and "SLURMATE_SSH_DIR" not in env,
              "%s / %s" % (env.get("SLURMATE_SSHD_BIN"),
                           env.get("SLURMATE_SSH_DIR")))
        # ★ 公钥的注释被丢掉了，所以它不可能把逗号带进 --export。
        #   注意这里**只查我们自己新加的三个变量** —— `SLURMATE_CANDIDATES`
        #   本来就是逗号分隔的端口表，那是既有设计，不在这条断言的范围内。
        check("★ 新加的三个变量都不含逗号（--export 的分隔符）",
              all("," not in str(env.get(k, "")) for k in
                  ("SLURMATE_SERVICE_KIND", "SLURMATE_SSH_PUBKEY",
                   "SLURMATE_SSHD_BIN")),
              str({k: env.get(k) for k in
                   ("SLURMATE_SERVICE_KIND", "SLURMATE_SSH_PUBKEY",
                    "SLURMATE_SSHD_BIN")}))
    finally:
        cfg.plugins[SSHD].enabled = _saved
        cfg.enabled_kinds = tuple(sorted(n for n, q in cfg.plugins.items() if q.enabled))

    # 19.5b ★ 默认资源是**按插件**的 —— 这是"插件块里放插件的策略"最直接的体现
    #
    # 从前它是两个代码常量（DEFAULT_CPUS / DEFAULT_MEM），所有服务共用一个值；
    # 而在中转站里跑一个 shell 和在 IDE 里跑语言服务器不是一回事。现在它是块里
    # 的一项，缺失时才回落到插件自己的内建值。
    _saved_cfg = cfg.plugins[SSHD]
    try:
        cfg.plugins[SSHD] = mod.PluginConfig(
            cfg.plugin_by_name[SSHD],
            {"enabled": "yes", "default_cpus": "7", "default_mem": "5G"}, True)
        cfg.enabled_kinds = tuple(sorted(n for n, q in cfg.plugins.items() if q.enabled))

        _r, _sess, _env = run_submit({"op": "submit", "service_kind": "sshd",
                                      "ssh_pubkey": _pub})
        check("★ 省略 cpus/mem 时用【这个插件块里】的默认值，不是全局那两个常量",
              _sess["cpus"] == 7 and _sess["mem"] == "5G",
              "%s / %s" % (_sess.get("cpus"), _sess.get("mem")))
        check("同一组默认值也传给了作业",
              _env.get("SLURMATE_CPUS") == "7" and _env.get("SLURMATE_MEM") == "5G",
              "%s / %s" % (_env.get("SLURMATE_CPUS"), _env.get("SLURMATE_MEM")))

        _r, _sess2, _ = run_submit({"op": "submit", "service_kind": "sshd",
                                    "ssh_pubkey": _pub, "cpus": 3})
        check("显式给的资源仍然覆盖块里的默认值",
              _sess2["cpus"] == 3, str(_sess2.get("cpus")))
    finally:
        cfg.plugins[SSHD] = _saved_cfg
        cfg.enabled_kinds = tuple(sorted(n for n, q in cfg.plugins.items() if q.enabled))

    # 19.5c op_plugins：客户端据此决定画哪些按钮、每个按钮写多少资源
    _resp = d.dispatch(os.getuid(), os.getgid(), {"op": "plugins"})
    _data = _resp.get("data") or {}
    _by = {p["name"]: p for p in (_data.get("plugins") or [])}
    check("op_plugins 报出全部插件（含没启用的）",
          set(_by) == {CS, SSHD}, str(sorted(_by)))
    check("每个插件带自己的默认资源",
          _by[CS]["defaults"]["cpus"] == 2
          and _by[SSHD]["defaults"]["cpus"] == 1,
          str({k: v.get("defaults") for k, v in _by.items()}))
    check("enabled 如实反映站点决定（sshd 默认关着）",
          _by[CS]["enabled"] is True
          and _by[SSHD]["enabled"] is False,
          str({k: v.get("enabled") for k, v in _by.items()}))
    check("★ 也报出没启用的插件 —— 「装了但停用」与「本站没有」是两回事",
          SSHD in _by)
    check("★ 不替客户端过滤它可能不认识的名字（那是升级提示的唯一来源）",
          all("name" in p and "title" in p for p in _by.values()))

    # 19.5d ★★ 插件目录的形状（跨语言契约，重定义为"两边读的是同一份东西"）
    #
    # 从前这一节钉的是「守护进程里那张写死的表」与「客户端清单」逐字一致 ——
    # 因为那时守护进程**自己也写了一份** id/版本。现在它一个插件名都不写了：表是
    # 扫出来的，而它扫的正是仓库里那两个真插件。于是这条钉子的含义变成了：
    #
    #     仓库 plugins/<目录>/plugin.json 是**唯一**的真相来源，
    #     守护进程读到的必须与文件里的逐字一致。
    #
    # ★ 这仍然值得一条用例，而且理由与从前一样：客户端那一半也是从同一份清单读
    #   身份（它扫自己的池）。清单漂了不会崩溃，只会**静默接错** —— 会话记的
    #   `<id>@<版本>` 在客户端的池里查不到，界面只解释、不动作，用户看到的是
    #   "作业起来了但界面一片白"，而根因一个字都不在里面。
    _plugdir = os.path.normpath(os.path.join(HERE, os.pardir, "plugins"))
    _manifests = {}
    if os.path.isdir(_plugdir):
        for _name in sorted(os.listdir(_plugdir)):
            _mf = os.path.join(_plugdir, _name, "plugin.json")
            if os.path.isfile(_mf):
                with open(_mf, encoding="utf-8") as _f:
                    _manifests[_name] = json.load(_f)
    check("找得到仓库里的插件清单（找不到的话下面几条是空断言）",
          len(_manifests) >= 2, str(sorted(_manifests)))

    for _spec in cfg.plugin_specs:
        _mf = _manifests.get(_spec.name)
        check("插件 %s：仓库的 plugins/ 下有它" % _spec.name, _mf is not None,
              str(sorted(_manifests)))
        if _mf is None:
            continue
        check("★ %s 的 id 与清单逐字一致" % _spec.name,
              _mf.get("id") == _spec.id,
              "扫出来的 %s / 清单里的 %s" % (_spec.id, _mf.get("id")))
        check("★ %s 的版本与清单一致" % _spec.name,
              _mf.get("version") == _spec.version,
              "扫出来的 %s / 清单里的 %s" % (_spec.version, _mf.get("version")))
        check("%s 的短名与清单一致" % _spec.name,
              _mf.get("name") == _spec.name,
              "扫出来的 %s / 清单里的 %s" % (_spec.name, _mf.get("name")))
        check("★ %s 的 id 是 26 字符的 ULID（不是随手编的名字）" % _spec.name,
              isinstance(_spec.id, str) and len(_spec.id) == 26
              and all(c in "0123456789ABCDEFGHJKMNPQRSTVWXYZ" for c in _spec.id),
              repr(_spec.id))
        # ★ 三个半边都要在。客户端那一半（client/index.js）可以由插件自己决定有
        #   没有（没有就是纯声明式插件），但作业侧那一半**必须有** —— 一个有界面
        #   却没有任何作业侧代码的插件，用户点下去只会拿到一个起不来的会话。
        check("★ %s 有作业侧 job/start.sh" % _spec.name,
              os.path.isfile(os.path.join(_plugdir, _spec.name, "job", "start.sh")),
              os.path.join(_plugdir, _spec.name, "job", "start.sh"))
        check("★ %s 的目录里没有多余的东西（清单、客户端、作业侧 —— 就这三样）"
              % _spec.name,
              not (set(os.listdir(os.path.join(_plugdir, _spec.name)))
                   - {"plugin.json", "client", "job", "README.md"}),
              str(sorted(os.listdir(os.path.join(_plugdir, _spec.name)))))

    check("★ 两个插件的 id 互不相同（两个插件抢一个 id 会让客户端静默取错）",
          len({q.id for q in cfg.plugin_specs}) == len(cfg.plugin_specs))

    check("op_plugins 报出 id 与版本（客户端的解析键）",
          all(isinstance(p.get("id"), str) and len(p.get("id")) == 26
              and isinstance(p.get("version"), str) for p in _by.values()),
          str({k: (v.get("id"), v.get("version")) for k, v in _by.items()}))

    # 19.5e ★ 会话把 `<id>@<版本>` **记下来**，而不是每次现算 ──────────────
    #
    # 这一条是整个解析键设计存在的理由。站点一升级插件，已经跑着的作业用的仍是
    # 旧的那一版代码（作业侧与客户端侧是配套的两半）。如果服务端在读取会话时按
    # "站点当前清单"现算，客户端就会把**新版本**的客户端代码接到**旧版本**的作业
    # 实现上 —— 而站点更新频繁正是这个项目要支持的现实。
    _cs_spec = cfg.plugin_by_name[CS]
    _old_ver = _cs_spec.version
    _before = None
    try:
        r, sess, _e = run_submit({"op": "submit"})
        check("提交后会话视图里带解析键",
              sess.get("service_plugin") == "%s@%s" % (_cs_spec.id, _old_ver),
              repr(sess.get("service_plugin")))
        _before = sess["service_plugin"]
        _sid = sess["session_id"]
        # run_submit 用完就把它的库关掉了（每个用例一个临时库），所以这里重开一个
        # 只读的连接 —— 要验的正是"**从库里读出来的**那一行不随升级而变"。
        _st2 = mod.Store(os.path.join(tmpdir, "submit-%d.db" % seq[0]))
        # 站点"升级"了这个插件
        _cs_spec.version = "9.9.9"
        # ★ 提交失败时 `_sid` 是 None（`_Captured` 给的是 None），而
        #   `session_view(None)` 会在守护进程里抛 —— 那会把脚本带崩，于是
        #   "崩了"与"一条都不红"分不开。取不到那一行就当成一条红的。
        _row = _st2.get(_sid) if _sid else None
        _now = d.session_view(_row, with_secret=False) if _row else {}
        check("★★ 站点升级插件之后，已跑的会话仍然报**它起时那一版**",
              _now.get("service_plugin") == _before,
              "起时 %r，升级后报 %r（现算的话这一条会红）"
              % (_before, _now.get("service_plugin")))
        check("短名不变（它只是站点内的名字，与版本无关）",
              _now.get("service_kind") == CS,
              repr(_now.get("service_kind")))
        _st2.close()
    finally:
        _cs_spec.version = _old_ver

    # op_partitions 不再带全局 defaults —— 留一个在那里就是两份真相
    _presp = d.dispatch(os.getuid(), os.getgid(), {"op": "partitions"})
    check("★ op_partitions 不再返回全局 defaults（默认资源已经按插件走）",
          "defaults" not in ((_presp.get("data") or {})),
          str((_presp.get("data") or {}).keys()))

    # 19.6 session_view 要如实报出服务种类，未知就是 None
    d.store = mod.Store(os.path.join(tmpdir, "svc-view.db"))
    d.store.insert(session_id="s-known", uid=UID, user="alice",
                   partition="A6000", account="acct", cpus=2, mem="8G",
                   requested_time="1:00:00", state=mod.ST_ENROLLED,
                   candidates="55001", created_at=mod.now_ts(),
                   service_kind=SSHD)
    d.store.insert(session_id="s-unknown", uid=UID, user="alice",
                   partition="A6000", account="acct", cpus=2, mem="8G",
                   requested_time="1:00:00", state=mod.ST_ENROLLED,
                   candidates="55002", created_at=mod.now_ts())
    # with_secret=False：这两行的 job_id 是空的，而取口令那条路要按 job_id 读会话
    # 文件。这里要验的只是 service_kind 的渲染，与口令无关。
    check("session_view 报出 service_kind",
          d.session_view(d.store.get("s-known"), with_secret=False)["service_kind"]
          == SSHD)
    check("★ 数据库里没有时报 None，不许猜一个默认值 —— 猜错会让界面拿口令去打 SSH 端口",
          d.session_view(d.store.get("s-unknown"), with_secret=False)["service_kind"]
          is None)

    # 19.7 ★ 从 nft 规则恢复出来的会话不许猜自己的服务种类
    #     nft 规则里没有任何东西能说明那个端口上跑的是 code-server 还是 sshd。
    class _FakeNft(object):
        def session_rules(self):
            return ["slurmate-sess-%d-%d-%d" % (UID, 99999, 55555)]

        def del_by_comment(self, _c):
            pass

    class _FakeSlurm(object):
        JOB_OK = mod.Slurm.JOB_OK

        def job_state(self, _jid):
            return self.JOB_OK, {"JobState": "RUNNING", "UserId": UID,
                                 "NodeList": "node01", "Partition": "A6000",
                                 "Account": "acct", "TimeLimit": "1:00:00"}

        def expand_node(self, _n):
            return "node01"

        def node_ip(self, _n):
            return "192.0.2.11"

    d.store = mod.Store(os.path.join(tmpdir, "svc-recover.db"))
    _real_nft, _real_slurm = d.nft, d.slurm
    d.nft, d.slurm = _FakeNft(), _FakeSlurm()
    try:
        n = d.recover_from_rules()
    finally:
        d.nft, d.slurm = _real_nft, _real_slurm
    rows = d.store.by_state((mod.ST_ENROLLED,))
    check("恢复用例本身要真的恢复出一行（否则下面那条是空断言）",
          n == 1 and len(rows) == 1, "n=%s rows=%s" % (n, len(rows)))
    if rows:
        check("★ 恢复态的服务种类是 NULL，不是 'code-server'",
              rows[0]["service_kind"] is None, repr(rows[0]["service_kind"]))
        # ★ 解析键同理。而且这里**尤其**不能拿短名去反查一个出来 —— 短名是 NULL，
        #   反查只会得到"随便挑一个同名的"，而那个作业可能根本不是它起的。
        check("★ 恢复态的解析键也是 NULL（不知道是哪一版的代码在跑）",
              rows[0]["service_plugin"] is None, repr(rows[0]["service_plugin"]))
        check("恢复态的会话视图把解析键原样报成 None",
              d.session_view(rows[0], with_secret=False)["service_plugin"] is None)
    d.store.close()

    # 19.8 库的表结构与本版对不上 ⇒ **启动时就拒绝**（不再有"自动补列"那条路）
    #
    # v0.7 删掉了 `Store._migrate()` —— 它给旧库自动 ALTER TABLE ADD COLUMN，
    # 而那条路只在旧库上跑，旧库不存在（见 0.y 的判据）。删掉之后，
    # `Config._db_schema_errors` 就是**唯一**接住"表结构对不上"的地方，所以它
    # 必须两头都查：少一列和多一列今天都只会在第一次用到时炸成一个不提数据库的
    # code 9。
    #
    # ★ 断言打的是 `validate()`，不是那个私有函数自己 —— 少一行
    #   `errors.extend(self._db_schema_errors())` 的话，私有函数照样报，
    #   而守护进程照样起得来。这里要钉的正是"起不来"。
    #
    # ★ 夹具从**真的**建表语句里删掉一行 —— 于是它"只少一列"，而不是随手编一张
    #   缺一堆列的表；缺的是哪一列由断言点名，人肉维护的列清单会漂。
    _fresh = os.path.join(tmpdir, "fresh-schema.db")
    _fc = _sq.connect(_fresh)
    _fc.executescript(mod.SCHEMA_SQL)
    _create_sql = _fc.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).fetchone()[0]
    _fc.close()

    _lines_all = _create_sql.splitlines()
    _lines_less = [ln for ln in _lines_all
                   if not ln.strip().startswith("service_kind")]
    check("夹具真的从建表语句里删掉了一行（否则下面测的是别的东西）",
          len(_lines_less) == len(_lines_all) - 1,
          "%d -> %d 行" % (len(_lines_all), len(_lines_less)))

    _old_db3 = os.path.join(tmpdir, "old-missing-one.db")
    _c3 = _sq.connect(_old_db3)
    _c3.execute("\n".join(_lines_less))
    _c3.commit()
    _c3.close()

    _cfg3 = mod.Config(os.path.join(tmpdir, "slurmate.conf"))
    _cfg3.__dict__["db_path"] = _old_db3
    _e3 = _cfg3.validate()
    check("★ 少一列的库让守护进程**起不来**（validate 就报错，不是运行时才炸）",
          len(_e3) == 1 and "rm -f" in _e3[0], str(_e3))
    check("★ 而且报出**缺的是哪一列**（只说「对不上」等于让人去猜）",
          bool(_e3) and "少 service_kind" in _e3[0], str(_e3))

    _cfg3.__dict__["db_path"] = _fresh
    check("★ 本版刚建出来的库**不**被拒绝 —— 判据漂了就会误杀合法库",
          _cfg3.validate() == [], str(_cfg3.validate()))

    # 19.9 ★ 候选端口表的分隔符
    # 实测（在计算节点上）：`--export=ALL,SLURMATE_CANDIDATES=55001,55002,55003,AFTER=ok`
    # 传给作业的 SLURMATE_CANDIDATES 是 **55001** —— Slurm 按逗号切 --export，
    # 后两段被当成"要导出的变量名"、未设置于是丢掉。六个候选端口有五个静默消失，
    # 那个仅剩的端口恰好被占时作业就以"候选端口全部失败"退出。
    _r, _s, _e = run_submit({"op": "submit"})
    _cands_env = _e.get("SLURMATE_CANDIDATES", "")
    check("★ 候选端口表用分号分隔（逗号会被 sbatch 的 --export 切碎，只剩第一个）",
          ";" in _cands_env and "," not in _cands_env, repr(_cands_env))
    # ★ 全部走 `.get`：提交失败时 `_s` 是那个"缺键给 None"的容器，裸下标会抛
    #   AttributeError 把脚本带崩（见第 18 节 `_Captured` 那段说明）。
    _db_cands = (_s.get("candidates") or "")
    check("★ 候选个数没被截断成一个",
          bool(_cands_env) and len(_cands_env.split(";")) == len(_db_cands.split(",")),
          "%d 个 vs 数据库里 %d 个"
          % (len(_cands_env.split(";")), len(_db_cands.split(","))))

    # 19.10 ★ 作业内 sshd 的主机公钥
    # 客户端拿它把这一条【预先】写进 known_hosts，从而能用 StrictHostKeyChecking yes
    # 连进来。没有它，那边只能 accept-new（首次信任），而"首次"在这条通路上是可以
    # 被抢的：端口来自候选表，同节点另一个用户理论上能先占住它，客户端第一次连过去
    # 就信任了他的密钥。
    #
    # ★ 这一条单独存在是有理由的：SESSION_FILE_FIELDS 是**白名单**，它会静默丢弃
    #   未登记的字段。漏了 ssh_host_key，作业照常写、这边照常启动，只是主机公钥
    #   凭空消失 —— 而症状是"客户端连不上，说主机密钥未知"，指不回这一行。
    check("★ 会话文件白名单里有 ssh_host_key（漏了会静默丢弃）",
          "ssh_host_key" in mod.SESSION_FILE_FIELDS)

    class _FakeSlurmNoJob(object):
        def show_job(self, _jid):
            return None

    _hk = "ssh-ed25519 " + "A" * 68
    d.store = mod.Store(os.path.join(tmpdir, "svc-hostkey.db"))
    d.store.insert(session_id="s-hostkey", uid=UID, user="alice", job_id=777,
                   node_ip="192.0.2.20", service_port=55003,
                   partition="A6000", account="acct", cpus=2, mem="8G",
                   requested_time="1:00:00", state=mod.ST_ENROLLED,
                   candidates="55003", created_at=mod.now_ts(),
                   service_kind=SSHD)
    _real_load, _real_slurm = d.load_session_file, d.slurm
    d.slurm = _FakeSlurmNoJob()
    try:
        d.load_session_file = lambda uid, jid: ({"ssh_host_key": _hk}, None)
        _v = d.session_view(d.store.get("s-hostkey"))
        d.load_session_file = lambda uid, jid: ({"ssh_host_key": "   "}, None)
        _v_blank = d.session_view(d.store.get("s-hostkey"))
        d.load_session_file = lambda uid, jid: ({}, None)
        _v_none = d.session_view(d.store.get("s-hostkey"))
    finally:
        d.load_session_file, d.slurm = _real_load, _real_slurm
    check("session_view 带出主机公钥", _v.get("ssh_host_key") == _hk,
          repr(_v.get("ssh_host_key")))
    # 「没有这个字段」和「有这个字段但是空」对客户端是两件事：后者会被读成
    # "主机公钥是空的"，而空公钥没有任何合法处理方式。
    check("★ 空白的主机公钥不出现在响应里",
          "ssh_host_key" not in _v_blank, repr(_v_blank.get("ssh_host_key")))
    check("没有这一项时也不出现（code-server 的作业就是这样）",
          "ssh_host_key" not in _v_none, repr(_v_none.get("ssh_host_key")))
    d.store.close()

    # ── 19.11 站点分发：守护进程把插件作为一个**包**发出去 ────────────────────
    #
    # 客户端**不自己装插件**：它连上站点之后，按 op_plugins 报的清单把**整个包**
    # 取回来 —— 一次 RPC。
    #
    # ★ v0.6 还有一条旁路：`files`（清单）+ `plugin_file`（一份文件一次 RPC）。
    #   **v0.7 把它删掉了**，而这一节现在钉的就是"删干净了没有"，两件：
    #
    #   ① `files` 与 `plugin_file` **真的不在了** —— 不是"还留着但不报"。
    #      留着 `plugin_file` 不只是多一条代码路径，是多一条**验签绕得过去**的路：
    #      它发的是散装字节，客户端拼不出一个能被签名的东西（见 op_plugin_package
    #      的注释）。所以"它还在"必须是一条会红的用例，而不是一句注释里的承诺。
    #   ② 那条路的判据**换了**：「本站支不支持分发」从前看"这一项里有没有 `files`"，
    #      现在看顶层**有没有 `limits`**。
    #
    # ★ 这一节从前还测了逐份取的三条边界（路径白名单 / 单文件上限 / 启动后被换过）。
    #   它们**跟着 op 一起走了**，不是丢了：前两条今天由客户端读方执行
    #   （`checkDeclared` 的 `file_bytes`，见 client/test/site-plugins.test.mjs），
    #   第三条由 `plugin_package_changed` 在 19.11c 里原样守着。
    _d2 = mod.Sessiond(cfg)
    _cs_spec = cfg.plugin_by_name[CS]

    def _pf(req):
        """发一条 RPC。

        ★ 每次先清空限流计数 —— 守护进程的限流是**每个 uid 每秒 10 次**
          （`MAX_RPC_PER_SECOND`）。这里清计数不是"绕过被测的东西"：这一节测的是
          清单的形状与"删除删干净了没有"，与那个桶无关；桶本身有自己的用例（19.11b）。
        """
        _d2.rpc_hits.clear()
        return _d2.dispatch(UID, os.getgid(), req)

    def _kindof(resp):
        """把一条应答归一成 `(code, kind, detail)`，**永不抛**。

        ★ 这不是洁癖：变异验证时"该被拒绝的请求变成了成功"，而 `resp["error"]`
          那时是 None —— 直接下标取 detail 会让用例**崩掉**而不是**红掉**，于是
          它后面的用例一条都不跑，一次变异会把别的洞一起遮住。
        """
        e = (resp or {}).get("error") or {}
        return ((resp or {}).get("code"), e.get("kind"), e.get("detail") or "")

    _pj2 = _pf({"op": "plugins"})
    _pdata = _pj2.get("data") or {}
    _p2 = {x["name"]: x for x in (_pdata.get("plugins") or [])}
    # ★ 全部走 `.get(...)`：变异验证时"这一项不见了 / 那个字段整个不报"正是被测的
    #   那件事，而裸下标会抛 KeyError 把脚本**带崩** —— 崩了与"一条都不红"在输出上
    #   分不开（见 CHANGELOG 里那条反复回来的说明）。
    check("★★ op_plugins 每一项**都不再有** files（v0.7 删掉了那条投递方式）",
          bool(_p2) and all("files" not in x for x in _p2.values()),
          str({k: sorted(v.keys()) for k, v in _p2.items()}))
    check("★ 而每一项仍然有 package（清单的另一半，v0.6 加的）",
          all(isinstance(x.get("package"), dict)
              and x["package"].get("format") == mod.PACKAGE_FORMAT
              for x in _p2.values()),
          str({k: (v or {}).get("package") for k, v in _p2.items()})[:200])
    check("★★ op_plugins 顶层带 limits —— 这**现在**是「本站支不支持分发」唯一的"
          "判据（从前那个判据 files 已经不在了）",
          isinstance(_pdata.get("limits"), dict)
          and _pdata["limits"].get("file_bytes") == mod.PLUGIN_FILE_MAX_BYTES,
          str(_pdata.get("limits")))

    # ★★ 那个 op 真的没了。判据是 `2 unknown_op`（dispatch 的兜底），**不是**
    #    "客户端不去调它" —— 协议里留着一条没人调的路，下一个人会以为它能用。
    _gc1, _gk1, _gd1 = _kindof(_pf({"op": "plugin_file", "id": "0" * 26,
                                    "version": "1.0.0", "path": "plugin.json"}))
    check("★★ plugin_file 这个 op 已经不在了（2 unknown_op，不是 3/9）",
          _gc1 == 2 and _gk1 == "unknown_op",
          "code=%s kind=%s detail=%s" % (_gc1, _gk1, _gd1[:60]))
    _gp1, _gp2, _gp3 = _kindof(_pf({"op": "plugin_package", "id": _cs_spec.id,
                                    "version": _cs_spec.version}))
    check("对照：plugin_package 这个 op 还在（上面那条不是「所有 op 都不认得」）",
          _gp1 == 0 and _gp2 is None,
          "code=%s kind=%s" % (_gp1, _gp2))

    # ── 夹具：一个「什么邪门东西都有」的插件**包** ───────────────────────────
    #
    # ★ 这个夹具**瘦了一圈**，是这一版的收益、不是漏测：从前这里要摆
    #   `.gitignore`、`node_modules/`、两个符号链接，来演"哪些东西不该进清单"。
    #   现在这些**在包里表达不出来** ——
    #     · 跳过集里的名字是**解析器的拒绝规则**（§3.3），见 19.14 的坏包
    #       「路径落在跳过集合里」；
    #     · 负载里没有"链接"这种条目（附录 A.3 是一条 `路径 | 字节`），所以
    #       「客户端重建不出来一份链接」这一态**不存在**了，`plugin_symlinks()`
    #       也随之删掉。
    #   于是这一段从"证明过滤器写对了"变成"证明那些东西**根本进不来**"。
    _fx_files = [
        ("plugin.json", b'{"id":"%s","name":"siteplug","displayName":"x","version":"1.0.0"}'
         % _cs_spec.id.encode()),
        ("client/index.js", b"module.exports = {};\n"),
        ("client/sshconfig.js", "// 插件的自有模块\n".encode("utf-8")),
        ("job/start.sh", b"start_siteplug() { :; }\n"),
        ("small.bin", b"y" * 16),
    ]
    _pfx_is_pkg = {
        _p: mod.package_parse(build_package([(nm, blob) for nm, blob in _fx_files]
                                            + [(_p, b"x\n")]))["ok"]
        for _p in (".gitignore", "node_modules/x.js", "client/.git/config")}
    check("★★ 跳过集里的路径**编不成一个合法的包**（它在解析器那里就被拒）",
          not any(_pfx_is_pkg.values()), str(_pfx_is_pkg))
    check("★ 而且对照：同样这些内容、不加那一条，就是一个能解析的包",
          mod.package_parse(build_package(_fx_files))["ok"])

    # ── 19.11b ★ 限流：桶本身 ────────────────────────────────────────────────
    #
    # `MAX_RPC_PER_SECOND = 10`，按 uid。
    #
    # ★ 这里从前还有一条"一次对账 1 + 1 + N 次，正好压在桶边上"的断言。它**删了**，
    #   理由是它**永远绿**：N 是客户端的行为（客户端那边数得清，见
    #   client/test/site-plugins.test.mjs 里对 `pkgCalls` / `fileCalls` 的那几条），
    #   而它在这里是从一个常量算出来的一个常量 —— 一条不会红的用例比没有更糟，
    #   它会让下一个人以为"贴边"这件事有人守。删掉逐份取之后是 1 + 1 + 1 = 3 次，
    #   离桶很远；**要守的是"别把批量传输再引进来"**，而那条由上面
    #   `plugin_file ⇒ 2 unknown_op` 那条用例守着。
    _d3 = mod.Sessiond(cfg)
    _d3.rpc_hits.clear()
    _hit = None
    for _i in range(mod.MAX_RPC_PER_SECOND + 1):
        _rr = _d3.dispatch(UID, os.getgid(), {"op": "ping"})
        if not _rr.get("ok"):
            _hit = (_i + 1, _rr.get("code"), _rr["error"]["kind"])
            break
    check("★ 连发超过阈值之后确实回 code 7 / rate_limited（客户端会看到它）",
          _hit is not None and _hit[1] == 7 and _hit[2] == "rate_limited",
          repr(_hit))
    check("★ 而在阈值之内照常应答（上面那条不是「一律拒绝」）",
          _hit is None or _hit[0] == mod.MAX_RPC_PER_SECOND + 1,
          repr(_hit))
    _d3.store.close()
    _d2.store.close()

    # ── 19.11c ★ 整包那条路：一次 RPC 把整个包发回去 ────────────────────────
    #
    # 发出去的是**容器本身**，不是"照着清单拼出来的字节"。这一点是承重的：客户端
    # 因此能自己解析、自己重算内容摘要、自己验签 —— 于是本站报的 `digest` 与本站
    # 转发的字节成了**分开的两件事**，客户端有办法发现它们对不上。
    #
    # ★ v0.6 那条"逐份取"的旁路做不到这一点（只有一份一份的字节，拼不出一个能被
    #   签名的东西），这正是 v0.7 删掉它的**理由**，不只是"少一条路"。
    #
    # 这一节钉三件事：
    #   ① `digest` 是**内容摘要**（§3.4），不是容器字节的 sha256；
    #   ② 发出去的字节逐字节等于盘上那一份，包被换过时说出来；
    #   ③ 负载那三个上限（自述）与整包那个上限（链路）是**两笔账**。
    _d4 = mod.Sessiond(cfg)

    def _pp(req):
        """发一条 RPC。清限流计数的理由与 19.11 的 `_pf` 相同。"""
        _d4.rpc_hits.clear()
        return _d4.dispatch(UID, os.getgid(), req)

    def _plug_of(name):
        """`plugins` 里那一个插件，找不到返回 None（变异下不许崩）。"""
        return next((x for x in
                     ((_pp({"op": "plugins"}).get("data") or {}).get("plugins") or [])
                     if x.get("name") == name), None)

    _cs4 = cfg.plugin_by_name[CS]
    _pk4 = {n: _plug_of(n) for n in (CS, SSHD)}
    check("★★ 加法过渡**结束了**：每条只剩 package，`files` 那个键不在 "
          "（v0.6 两条同时在，v0.7 只留这一条）",
          bool(_pk4) and all("files" not in (x or {})
                             and (x or {}).get("package") is not None
                             for x in _pk4.values()),
          str({k: sorted((v or {}).keys()) for k, v in _pk4.items()})[:200])

    for _n in (CS, SSHD):
        _spec = cfg.plugin_by_name[_n]
        _info = (_pk4.get(_n) or {}).get("package") or {}
        _disk = mod.package_read_file(_spec.source_package)
        check("★★ op_plugins 报的 package 三样事实与**盘上那一份包**相符（「%s」）" % _n,
              _info.get("format") == mod.PACKAGE_FORMAT
              and _info.get("bytes") == len(_disk.get("data") or b"")
              and _info.get("digest") == _disk.get("digest")
              and _info.get("digest"),
              "%s vs format=%s bytes=%s digest=%s"
              % (_info, _disk.get("format"), len(_disk.get("data") or b""),
                 _disk.get("digest")))

    _lim4 = ((_pp({"op": "plugins"}).get("data") or {}).get("limits") or {})
    check("★ limits 里多报了 package_bytes（那是**链路**约束，与负载那三个不同口径）",
          _lim4.get("package_bytes") == mod.PLUGIN_PACKAGE_MAX_BYTES,
          str(_lim4))
    check("★ 而它是一个**独立**的数字：整包上限比总字节上限大（两笔账，不是一个）",
          _lim4.get("package_bytes") != _lim4.get("total_bytes"),
          str(_lim4))

    # ★★ `digest` 是**内容摘要**（§3.4），不是容器字节的 sha256。这一条分辨不出来
    #    的话，"给同一个负载补一个签名块"（§4.2 明文允许的动作：摘要不变 ⇒ 还是
    #    同一份构件）会让客户端自己算出来的摘要与本站报的对不上 —— 而两边都没错。
    #    先在最底层分辨一次，再**走一遍 op** 分辨一次（下面那一段）。
    _dg_files = [("plugin.json", b'{"id":"%s","name":"dg","displayName":"x",'
                                 b'"version":"1.0.0"}' % _cs4.id.encode()),
                 ("client/index.js", b"module.exports = {};\n")]
    _sigblock = b"\x01" + b"\x11" * 32 + b"\x22" * 64
    _plain_bytes = build_package(_dg_files)
    _signed_bytes = build_package(_dg_files, _sigblock)
    _plain = mod.package_parse(_plain_bytes)
    _signed = mod.package_parse(_signed_bytes)
    check("这条用例自己的前提：两份都能解析，而**容器字节**确实不同",
          _plain.get("ok") and _signed.get("ok") and _plain_bytes != _signed_bytes,
          "ok=%s/%s 相同=%s" % (_plain.get("ok"), _signed.get("ok"),
                              _plain_bytes == _signed_bytes))
    check("★★ 内容摘要**不看信封**：同一个负载补一个签名块 ⇒ 摘要不变（§4.2）",
          _plain.get("digest") == _signed.get("digest") and _plain.get("digest"),
          "%s vs %s" % (_plain.get("digest"), _signed.get("digest")))
    check("★ 而容器字节的 sha256 是变的（上面那条不是「两边都是常量」）",
          hashlib.sha256(_plain_bytes).hexdigest()
          != hashlib.sha256(_signed_bytes).hexdigest())

    _fx4 = os.path.join(tmpdir, "siteplug-pkgpath")
    os.makedirs(_fx4, exist_ok=True)
    _dg_name = "01M2JKHTZGKJBFQQTWYXMQMFDG.splug"
    _saved_src4 = _cs4.source_package
    try:
        _dg_a = put_package(_fx4, _dg_files, filename=_dg_name)
        _cs4.source_package = _dg_a
        _d4._plugin_cache.clear()          # 清缓存 = 模拟"守护进程重启一次"
        _a_pkg = (_plug_of(CS) or {}).get("package") or {}

        # 同一个负载、换成一个**带签名块**的包（容器字节变长 97 字节）
        put_package(_fx4, _dg_files, sig_block=_sigblock, filename=_dg_name)
        _d4._plugin_cache.clear()
        _b_plug = _plug_of(CS) or {}
        _b_pkg = _b_plug.get("package") or {}
        check("★★ op_plugins 报出去的也是**内容摘要**：补上签名块之后整包字节数变了、"
              "摘要**一个字都没变**",
              _a_pkg.get("bytes") != _b_pkg.get("bytes")
              and _a_pkg.get("digest") == _b_pkg.get("digest") and _a_pkg.get("digest"),
              "%s vs %s" % (_a_pkg, _b_pkg))

        # ── 整包取：字节逐字节等于盘上那一份 ──
        _pr = _pp({"op": "plugin_package", "id": _cs4.id, "version": _cs4.version})
        _pd = _pr.get("data") or {}
        _got = base64.b64decode(_pd.get("data") or "")
        _cur = mod.package_read_file(_cs4.source_package)
        check("★★ op_plugin_package 发回来的字节与盘上那份包**逐字节全等**",
              _got == (_cur.get("data") or b"") and len(_got) > 0,
              "%d vs %d 字节" % (len(_got), len(_cur.get("data") or b"")))
        check("★ 报回的 format/bytes/digest 与 op_plugins 那一轮报的**同一个值**",
              (_pd.get("format"), _pd.get("bytes"), _pd.get("digest"))
              == (_b_pkg.get("format"), _b_pkg.get("bytes"), _b_pkg.get("digest")),
              "%s vs %s" % (_pd, _b_pkg))
        check("★★ 而客户端拿这份**下载到的字节**自己重算一遍，得到的就是本站报的那个 "
              "—— 这是 digest 唯一正确的用法（本站自述，不是判据）",
              mod.package_parse(_got).get("digest") == _pd.get("digest"),
              "%s vs %s" % (mod.package_parse(_got).get("digest"),
                            _pd.get("digest")))

        # ── 认不出的 (id, 版本)：还是那个出口（`3 plugin_unknown`）──
        _uc4, _uk4, _ud4 = _kindof(_pp({"op": "plugin_package", "id": "0" * 26,
                                        "version": "1.0.0"}))
        check("★ 认不出的 (id, 版本) 是 3 plugin_unknown（两条路一个出口）",
              _uc4 == 3 and _uk4 == "plugin_unknown",
              "code=%s kind=%s detail=%s" % (_uc4, _uk4, _ud4[:60]))

        # ★ 启动之后包被换过：**要说出来**，而不是把对不上的字节发出去
        #   让客户端去报"校验不过"（那是同一个事实，但会让运维去查错的地方）。
        put_package(_fx4, _dg_files, filename=_dg_name)     # 换回不带签名的那一份
        _cc4, _ck4, _cd4 = _kindof(_pp({"op": "plugin_package",
                                        "id": _cs4.id, "version": _cs4.version}))
        check("★★ 包在本次启动之后被换过 ⇒ 9 plugin_package_changed",
              _cc4 == 9 and _ck4 == "plugin_package_changed",
              "code=%s kind=%s detail=%s" % (_cc4, _ck4, _cd4[:80]))
        check("★ 而且那句话指向「重跑一次 deploy.sh」，不是指回客户端",
              "deploy.sh" in _cd4, repr(_cd4[:140]))
        _after = (_plug_of(CS) or {}).get("package") or {}
        check("★★ 快照是**启动那一刻**：换完之后 op_plugins 报的还是当初那一个"
              "（快照与这一条回答的是同一份包）",
              _after.get("digest") == _b_pkg.get("digest")
              and _after.get("bytes") == _b_pkg.get("bytes"),
              "%s vs %s" % (_after, _b_pkg))

        # ── 超过整包上限：明确拒绝，**不把 2 MiB 硬塞进一条应答** ──
        #    正常部署下安装器已经拦住了这种包；这一条拦的是绕过安装器放进来的一份。
        _big_files = [("plugin.json", b'{"id":"%s","name":"dg","displayName":"x",'
                                      b'"version":"1.0.0"}' % _cs4.id.encode()),
                      ("big.bin", b"x" * (mod.PLUGIN_PACKAGE_MAX_BYTES + 1))]
        put_package(_fx4, _big_files, filename=_dg_name)
        _d4._plugin_cache.clear()
        _lc4, _lk4, _ld4 = _kindof(_pp({"op": "plugin_package",
                                        "id": _cs4.id, "version": _cs4.version}))
        check("★★ 超过整包上限 ⇒ 4 plugin_package_too_large（不是截断了发出来）",
              _lc4 == 4 and _lk4 == "plugin_package_too_large",
              "code=%s kind=%s detail=%s" % (_lc4, _lk4, _ld4[:80]))
        check("★ 而且一个字节都没发（错误应答里没有 data）",
              "data" not in (_pp({"op": "plugin_package", "id": _cs4.id,
                                  "version": _cs4.version}).get("data") or {}))
        # ★ 这个上限**报得出来**才有意义：客户端要先知道它才谈得上"取不回来"。
        check("★ 上限那个数在错误信息里（运维要照着调）",
              str(mod.PLUGIN_PACKAGE_MAX_BYTES) in _ld4, repr(_ld4[:140]))

        # ── 包**不见了**：`package` 是 null，而**能力仍然在** ──
        #
        # ★ 这两件事必须分得开：「这一份现在给不出来」是瞬时的、是这一份的事；
        #   「本站没有这个能力」是协议事实（顶层没有 limits）。合成一个信号的话，
        #   一次误删文件会让客户端把整站降级。
        _cs4.source_package = os.path.join(_fx4, "被删掉了.splug")
        _d4._plugin_cache.clear()
        _gone = _plug_of(CS) or {}
        check("★★ 包不见了 ⇒ package 是 **null**（不是把这个键省掉）",
              "package" in _gone and _gone.get("package") is None,
              "键在=%s 值=%r" % ("package" in _gone, _gone.get("package")))
        check("对照：顶层 limits 照旧报（缺席的不是**能力**，是这一份的内容）",
              isinstance(((_pp({"op": "plugins"}).get("data") or {})
                          .get("limits")), dict))
        _gc4, _gk4, _gd4 = _kindof(_pp({"op": "plugin_package",
                                        "id": _cs4.id, "version": _cs4.version}))
        check("★ 整包取那条路回 9 plugin_package_changed（不是 3/4 —— 它刚才还在，"
              "而「刚才还在」正是这句话要说的事）",
              _gc4 == 9 and _gk4 == "plugin_package_changed",
              "code=%s kind=%s detail=%s" % (_gc4, _gk4, _gd4[:80]))

        # ── ★ 包在**两次读之间**消失（快照说在、现读说读不动）──
        #
        # `op_plugin_package` 读两次：第一次经**启动快照**（`plugin_package()`，
        # 那是缓存的），第二次**现读**（`package_read_file()`）。上一条走的是
        # "快照里就没有"那个出口；这一条走的是**另一个**出口 —— 快照里还在，
        # 而现读时它没了。两句都是 `9 plugin_package_changed`，但说的是两件事，
        # 而**第二句从前一条用例都没有**（这一条是补的，见 CHANGELOG 的〈三处〉）。
        #
        # ★ 顺序是承重的：**先问一次 `op_plugins`**（那一步会把快照填上），再删文件。
        #   反过来的话快照本身就是"不在"，于是走到的是上面那个出口 —— 那这一条
        #   看起来绿了，而其实什么都没测到。
        put_package(_fx4, _dg_files, filename=_dg_name)
        _cs4.source_package = os.path.join(_fx4, _dg_name)
        _d4._plugin_cache.clear()
        _live = _plug_of(CS) or {}
        check("这条用例自己的前提：快照里那个包**是在的**",
              isinstance(_live.get("package"), dict), repr(_live.get("package")))
        os.remove(os.path.join(_fx4, _dg_name))
        _rc4, _rk4, _rd4 = _kindof(_pp({"op": "plugin_package",
                                        "id": _cs4.id, "version": _cs4.version}))
        check("★★ 包在两次读之间消失 ⇒ 9 plugin_package_changed（说的是「读不动」）",
              _rc4 == 9 and _rk4 == "plugin_package_changed" and "读不动" in _rd4,
              "code=%s kind=%s detail=%s" % (_rc4, _rk4, _rd4[:100]))
        check("★ 而它没有被兜成 9 internal（那句话指不回包，运维会去查别的地方）",
              _rk4 != "internal", repr(_rk4))
    finally:
        _cs4.source_package = _saved_src4
        _d4._plugin_cache.clear()
    _d4.store.close()

    # ── 19.11d ★ 跨文件不变量：CLI 读得下本站能发出去的最大一条应答 ──────────
    #
    # 这是那两个数字**唯一**的守方。它们是从两侧各写一遍的（守护进程的
    # `PLUGIN_PACKAGE_MAX_BYTES` 与 CLI 的 `RPC_MAX_RESPONSE_BYTES`），而漂开的
    # 症状会是**最容易被认错的那一种**：CLI 报"响应太大"，客户端把它归成
    # `daemon_unreachable`（code 5）并退避重试 —— 一次"文件太大"被报成"控制节点上
    # 的守护进程没有响应"，排查方向整整错一层。
    #
    # ★ 从前这里就是错的：CLI 上限 1 MiB，而站点通报的**总量**上限也是 1 MiB ⇒
    #   "整包一次发"那个数是一句假话（1 MiB 的负载 base64 之后 1.33 MiB）。
    #   这条用例存在的意义就是让那种状态**不可能悄悄回来**。
    _cli = load_cli()
    _wire = len(base64.b64encode(b"\x00" * mod.PLUGIN_PACKAGE_MAX_BYTES))
    check("★★ CLI 的读上限装得下本站能发出去的那条最大的应答（base64 之后还要"
          "加一层 JSON 信封）",
          _wire + 1024 < _cli.RPC_MAX_RESPONSE_BYTES,
          "包的 base64 是 %d 字节，CLI 上限 %d" % (_wire, _cli.RPC_MAX_RESPONSE_BYTES))
    check("★ 而反过来也留了余量、没有把上限抬成一句空话（不超过包上限的 4 倍）",
          _cli.RPC_MAX_RESPONSE_BYTES <= mod.PLUGIN_PACKAGE_MAX_BYTES * 4,
          "CLI 上限 %d，包上限 %d" % (_cli.RPC_MAX_RESPONSE_BYTES,
                                    mod.PLUGIN_PACKAGE_MAX_BYTES))

    # ── 19.12 ★ 跨语言契约：跳过表两边必须逐字一致 ──────────────────────────
    #
    # PLUGIN_COPY_SKIP（本文件所在的守护进程）与 COPY_SKIP（客户端）分别在
    # Python 与 JS 里，没有任何共享机制。漂开的后果是"客户端算出来的摘要与站点报的
    # 永远对不上"，而报错里一个字都不会提到是这两个集合分家了 ——
    # 症状只会是"同步一直失败"。照 checks.yml 那条"版本号：四处逐字一致"的先例
    # 钉住它。（版本号那对也有同一形状的用例，见 19.0b2 —— 但那一对现在读的是
    # **同一份夹具**，不需要 lint 了；这里这两个集合在**生产代码**里，跨语言没法
    # 共用一份，只能靠 lint 守。）
    #
    # ★ 抠的是 `plugins/index.js` 那一份 —— 它在**客户端里只有一份**（安装器从它
    #   引，算摘要也用它）。以前它在 install.js 里，而那是"两个地方各持一份"的开端。
    #
    # 抠的是**字面量本身**，不是"跑一遍 JS" —— 本机不一定有 node，而这条契约要的
    # 是"两份声明写的是同一组名字"。checks.yml 的 lint 作业里有同一条。
    _copy_skip_js = os.path.join(HERE, os.pardir, "client", "src", "main",
                                 "plugins", "index.js")
    with open(os.path.abspath(_copy_skip_js), encoding="utf-8") as _f:
        _js = _f.read()
    _m = re.search(r"const COPY_SKIP = new Set\(\[([^\]]*)\]\)", _js)
    check("客户端 plugins/index.js 里那份 COPY_SKIP 找得到（找不到说明它改了形状）",
          _m is not None)
    if _m:
        _js_set = sorted(re.findall(r"'([^']*)'", _m.group(1)))
        check("★★ 两端的跳过表逐字一致（漂开了就是「同步一直失败」且说不清原因）",
              _js_set == sorted(mod.PLUGIN_COPY_SKIP),
              "客户端 %s vs 守护进程 %s" % (_js_set, sorted(mod.PLUGIN_COPY_SKIP)))

    # ── 19.13 ★ 部署的信任门 ⊇ 站点会分发的文件 ─────────────────────────────
    #
    # `deploy.sh` 的 `source_is_trusted()` 会拒绝安装"源里有人能改写"的文件。
    # 那一圈名单（`plugin_src_files()`）**以前只列 plugin.json 与 job/start.sh**，
    # 理由是"插件目录里其余的都不装、也不读"。站点分发接上之后那句话不成立了：
    # `client/` 整棵子树会被 `plugins` / `plugin_package` 发到**每一台客户端**上，
    # 并在用户的 Electron 主进程里 `require()`。于是"某个普通用户能改写它"的后果
    # 从"没什么后果"变成了"他的代码在每个用户的工作站上跑"。
    #
    # 这一节钉的就是这条包含关系：**守护进程会分发的每一份文件，都必须在部署的
    # 信任门里**。它此前是红的（client/index.js、client/sshconfig.js、README.md
    # 三份都不在名单里）。
    #
    # ★ 为什么是把 `plugin_src_files()` **抠出来真跑**，而不是在用例里照抄一遍：
    #   照抄的那一份永远不会跟着 deploy.sh 改，于是"用例绿了、真机上炸了" ——
    #   而 deploy.sh 本机跑不了（要 root + 一台控制节点，见 KNOWN-ISSUES 的 U2）。
    #   抠出来跑是这里唯一能真的验到那个函数的地方。
    print("\n── 19.13. 部署的信任门 ⊇ 会被安装的那一批包 ──")
    _dep = os.path.join(HERE, "deploy.sh")
    with open(_dep, encoding="utf-8") as _f:
        _dep_src = _f.read()
    _m = re.search(r"^plugin_src_files\(\) \{\n.*?^\}$", _dep_src, re.M | re.S)
    check("★ deploy.sh 里那个 plugin_src_files() 找得到（找不到说明它改了形状）",
          _m is not None)
    if _m:

        def _gated(plugins_src):
            """在真 bash 里跑一遍那个函数，返回它列出来的路径集合。"""
            r = subprocess.run(
                ["bash", "-c",
                 'PLUGINS_SRC="$1"\n%s\nplugin_src_files\n' % _m.group(0),
                 "bash", plugins_src],
                capture_output=True, text=True)
            return {l for l in r.stdout.split("\n") if l}

        # ── ① 合成目录：**只有 `.splug` 进名单，而且是普通文件的那种** ──
        #
        # ★ 这里比从前**更容易写错**，所以要逐种排除：「一个包」现在是一个文件，
        #   而文件名可以随便起 —— 包括起成 `x.splug` 却是一个**符号链接**。
        #   链接能指向任何地方、还能随时换目标，所以它必须像别的东西一样被挡在
        #   门外。`-f` 会跟随链接，所以判据里那一句 `! -L` 是承重的。
        _tmp = tempfile.mkdtemp(prefix="slurmate-gate-")
        try:
            def _touch(rel, blob=b"x\n"):
                p = os.path.join(_tmp, rel)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "wb") as _f:
                    _f.write(blob)
                return p

            _real_pkg = _touch("vendor-1.0.0.splug", b"splug\x1a\r\n" + b"\0" * 12)
            _touch("notes.txt")                    # 随手放的文件
            _touch("README")                       # 说明文件
            _touch("old/plugin.json", b"{}")       # 一个目录（站点只认包）
            _touch("nested/deep.splug")            # 子目录里的包（不扫第二层）
            os.symlink(_real_pkg, os.path.join(_tmp, "linked.splug"))
            os.symlink("/etc/passwd", os.path.join(_tmp, "passwd.splug"))
            _got = _gated(_tmp)
            check("★★ 信任门**恰好**列出那一个真正的包文件",
                  _got == {_real_pkg}, repr(sorted(_got))[:200])
            check("★★ 符号链接冒充 `.splug` 进不了名单（它随时可以换目标）",
                  not any("linked.splug" in p or "passwd.splug" in p for p in _got),
                  repr(sorted(_got))[:200])
            check("★ 目录、散落的文件、子目录里的包都不进名单"
                  "（它们**不该在这儿**，由 --check-plugins 逐条点名）",
                  not any("old/" in p or "notes.txt" in p or "README" in p
                          or "nested" in p for p in _got),
                  repr(sorted(_got))[:200])

            # ── ② ⊇：安装器拿到的就是信任门过的那一批 ──
            #
            # ★ 这条是**接线检查**（两个列表分家才会长出"装了但没验"的缺口），
            #   所以它抠的是 deploy.sh 的源码：安装器的参数必须来自
            #   `${PLUGIN_PKGS[@]}`，而那个数组必须由 `plugin_src_files()` 填。
            #   ★ 不强求它是别的形状：这段代码只有 root 能跑（见 KNOWN-ISSUES 的
            #     U2），在用例里没有第二种验法。
            check("★★ 安装器的参数取自 ${PLUGIN_PKGS[@]}（不是另列一份）",
                  re.search(r'--install-plugins"?\s*"?\$\{PLUGIN_PKGS\[@\]\}',
                            _dep_src) is not None,
                  "没找到 `--install-plugins \"${PLUGIN_PKGS[@]}\"`")
            #    ★ 两处各有一份（本脚本开头、以及自拷贝之后重建路径那一处）——
            #      少一处就会出现"从非 root 目录部署时信任门是空的"这种只在
            #      一种部署方式下成立的假绿，所以数它个个数。
            check("★★ PLUGIN_PKGS 的两处填充都来自 plugin_src_files()（同一个来源）",
                  len(re.findall(r'PLUGIN_PKGS\+=\("\$f"\)', _dep_src)) == 2
                  and len(re.findall(r"done < <\(plugin_src_files\)", _dep_src)) == 2,
                  "填充点 %d 个 / 来源 %d 个"
                  % (len(re.findall(r'PLUGIN_PKGS\+=\("\$f"\)', _dep_src)),
                     len(re.findall(r"done < <\(plugin_src_files\)", _dep_src))))
            check("★ 而它们都进 ALL_SRC_FILES（信任门与哈希基线看的是那一份）",
                  len(re.findall(r'ALL_SRC_FILES\+=\("\$f"\)', _dep_src)) == 4,
                  "ALL_SRC_FILES 的填充点 %d 个（4 = PLUGIN_PKGS 的两处 + "
                  "SRC_FILES 的两处，少一处就有一批文件没进信任门）"
                  % len(re.findall(r'ALL_SRC_FILES\+=\("\$f"\)', _dep_src)))
        finally:
            shutil.rmtree(_tmp, ignore_errors=True)

    # ── 19.13b ★ 完成摘要那张插件表：四列，第四列说话 ────────────────────────
    #
    # 这一段是**抠出来真跑**的（与 19.13 同一个理由：deploy.sh 本机跑不了全套，
    # 只有那段命令替换是自足的）。
    #
    # ★ 它钉的是一个**已经发生过**的错误：那一行从前写的是
    #   `if [[ -f "${_d}/job/start.sh" ]]`，而 `_d` 早就是**包的路径**（一个
    #   `.splug` 文件）—— 于是这个判断**永远为假**，完成摘要把**每一个**插件都
    #   说成"没有作业侧"，包括明明有 job/start.sh 的那些。它不报错、不改行为，
    #   只是每次部署都对管理员说一句假话。
    #   修法是去读 `--check-plugins` 的**第 4 列**（`has_job` / `no_job`）——
    #   那一列是守护进程给的、明确的一位，不是靠"取一次试试"推出来的。
    #
    # ★ 为什么不是一条 `grep` 源码的形状检查：那样只能钉住"没写回 `-f`"，
    #   钉不住"四列读对没有"。下面这几条是真的把那段 bash 跑一遍看输出。
    _m = re.search(r'\$\(if \[\[ "\$DRYRUN" -eq 1 \]\]; then echo .*?\n.*?fi\)',
                   _dep_src, re.S)
    check("★ deploy.sh 的完成摘要那段命令替换找得到（找不到说明它改了形状）",
          _m is not None)
    if _m:
        _inner = _m.group(0)[2:-1]          # 剥掉最外那对 $( )
        # ★ 前提取自 `--check-plugins` 的真实格式：`<短名>\t<包路径>\t<ULID>\t<job>`。
        _plist = ("jupyter\t/opt/slurmate/share/slurmate/plugins/01ABC.splug"
                  "\t01ABC\tno_job\n"
                  "sshd\t/opt/slurmate/share/slurmate/plugins/01DEF.splug"
                  "\t01DEF\thas_job")
        _r = subprocess.run(
            ["bash", "-c",
             'PLUGIN_LIST="$1"\nDRYRUN=0\nPLUGINS_SRC=/tmp/src\n'
             'PLUGINS_DIR=/tmp/pd\nJOBS_DIR=/tmp/jd\n'
             'printf "%s\\n" "$(' + _inner + ')"',
             "bash", _plist],
            capture_output=True, text=True)
        _lines = [l for l in _r.stdout.split("\n") if l.strip()]
        # 每个插件两行（一行"短名 → 包"，一行"作业脚本"或者"没有"）。
        _by_name = {}
        _cur = None
        for _l in _lines:
            _t = _l.strip()
            if _t.startswith("jupyter") or _t.startswith("sshd"):
                _cur = _t.split()[0]
                _by_name[_cur] = [_t]
            elif _cur:
                _by_name[_cur].append(_t)

        check("★★ 那段摘要跑得起来（rc=0）", _r.returncode == 0,
              "rc=%d stderr=%r" % (_r.returncode, _r.stderr[:300]))
        check("★★ 两个插件都被列出来了（第 4 列不认识时不能静默少一行）",
              set(_by_name) == {"jupyter", "sshd"}, repr(_by_name))
        _jup = "\n".join(_by_name.get("jupyter", []))
        _ssh = "\n".join(_by_name.get("sshd", []))
        check("★★ 有作业侧的那个**没有**被说成「包里没有 job/start.sh」"
              "（从前那个 `-f ${包路径}/job/start.sh` 恒为假，于是每个插件都被"
              "这么说一遍）",
              "【包里没有 job/start.sh" not in _ssh, repr(_ssh))
        check("★ 而没有作业侧的那个**仍然**被如实点名"
              "（改判断不能把这一句一起改没）",
              "【包里没有 job/start.sh" in _jup, repr(_jup))
        check("★★ 有作业侧的报出它那份作业脚本，没有作业侧的不报",
              "/tmp/jd/01DEF.sbatch" in _ssh and "/tmp/jd/01ABC.sbatch" not in _jup,
              repr(_by_name))
        check("★ 印出来的是**第 2 列那个包的路径**（不是一个目录）",
              "plugins/01DEF.splug" in _ssh and "plugins/01ABC.splug" in _jup,
              repr(_by_name))

    # ── 19.14 ★★ 读一个 .splug：三端共用同一份符合性向量 ────────────────────
    #
    # 这一节读的是 `tools/conformance/expected.json` 与 `bad.json` —— **与客户端
    # `client/test/plugin-package.test.mjs`、打包器 `packer/test-packer.mjs` 读的是
    # 同一批十六进制**。三份实现（打包器 / 守护进程 / 客户端）各自解析同一个包、
    # 同一批坏包，必须得出同一个内容摘要与同一个拒绝理由。
    #
    # ★ 这一版**没有调用方**（见守护进程里「读一个 .splug」那一节的开头）。它现在
    #   是安装器与"集群侧切包"那两段的前置：读包的能力必须先于"服务器开始收包"
    #   落地，否则中间会开一个"客户端把读不懂的字节当校验不过"的窗口。
    #
    # ★ 判**的次序**也在这条契约里（附录 A.4）：一个包同时犯两条时，先判哪条决定
    #   了拿到哪个理由词。所以下面断言的是**逐条相等的词**，不只是"拒了"。
    print("\n── 19.14. 读一个 .splug（三端共用一份符合性向量）──")
    _conf = os.path.abspath(os.path.join(HERE, os.pardir, "tools", "conformance"))
    with open(os.path.join(_conf, "expected.json"), encoding="utf-8") as _f:
        _exp = json.load(_f)
    with open(os.path.join(_conf, "bad.json"), encoding="utf-8") as _f:
        _bad = json.load(_f)
    _unhex = lambda lines: bytes.fromhex("".join(lines))
    _good = _unhex(_exp["package"]["hex"])
    _signed = _unhex(_exp["signed"]["hex"])

    _r = mod.package_parse(_good)
    check("★ 符合性向量：好包能解析（%s）" % (_r.get("why", "") if not _r["ok"] else "ok"),
          _r["ok"])
    if _r["ok"]:
        check("★★ 内容摘要是夹具里那个（它也是客户端会算出来的那个）",
              _r["digest"] == _exp["digest"], _r["digest"])
        check("★ 记录表读出来的逐份 path/size/sha256 与夹具**逐条、按序**相同",
              [{"path": f["path"], "size": f["size"], "sha256": f["sha256"]}
               for f in _r["files"]] == _exp["files"],
              repr([f["path"] for f in _r["files"]])[:200])
        check("★ 没有签名时 sig 是 None（不是 {} —— 缺席与空要分得开）",
              _r["sig"] is None)
        check("★ 清单从负载里读出来了（id 与夹具一致）",
              _r["manifest"].get("id") == "01M2JKHTZGQ7X8V4T5R6N7B8C9",
              repr(_r["manifest"].get("id")))
        check("★ 包字节数就是夹具里那个（没有多出来的字节）",
              len(_r.get("data") or b"") == _exp["package"]["bytes"])

        # 摘要与"喂进去的次序"无关 —— 排序是摘要的一部分（§3.4）
        _rev = mod.package_content_digest(list(reversed(_r["files"])))
        check("★ 倒着喂进去算出同一个摘要（排序按路径字节，不是按进去的先后）",
              _rev == _exp["digest"], _rev)

    _s = mod.package_parse(_signed)
    check("★ 带签名的包也解析得动，而且**摘要与不带签名的那份逐字相同**", _s["ok"] and
          _s["digest"] == _exp["digest"],
          "%s %s" % (_s.get("code"), _s.get("why")))
    if _s["ok"] and _s["sig"]:
        check("★ 公钥指纹与夹具一致（给人核对的那一串，§4.1）",
              _s["sig"]["fingerprint"] == _exp["signed"]["fingerprint"],
              _s["sig"]["fingerprint"])
        check("★ 公钥字节就是夹具里那 32 个字节",
              _s["sig"]["pubkey"].hex() == _exp["signed"]["publicKeyHex"])

    # ★★ 站点**不验签**，这是一条**有断言的**事实，不是一件被忘掉的事。
    #
    #    §6 没有给站点任何一条验签义务 —— 验签是客户端的事（§5.4「客户端会钉住
    #    你的公钥」）。这一节解析签名块、把签名者报出来给管理员看，但不判它成不
    #    成立。所以夹具里那两条"只有会验签的一端才拒得了"的坏包，在这里**预期会
    #    被收下** —— 下面这一条把它断言成事实。
    #
    #    ★ 换成在 Python 里手写一个 Ed25519 验签器的代价是：给一个以 root 跑在
    #      集群上的进程加一份自己实现的密码学，而它挡的那件事本来就发生在客户端
    #      那一侧。（安装器那一侧要不要验、以及"没验就别说验过了"的措辞，是切包
    #      那一段的事 —— 见 KNOWN-ISSUES。）
    _needs_verify = [c for c in _bad["cases"] if c.get("needs") == "verify"]
    check("★ 夹具里至少有两条是「只有会验签的一端才拒得了」的",
          len(_needs_verify) >= 2, repr([c["name"] for c in _needs_verify]))
    for _c in _needs_verify:
        _g = mod.package_parse(_unhex(_c["hex"]))
        check("★★ 守护进程**收下**它（%s）—— 站点不验签，这是设计不是漏洞" % _c["name"],
              _g["ok"], "却被拒了：%s %s" % (_g.get("code"), _g.get("why")))

    _wrong = []
    for _c in _bad["cases"]:
        if _c.get("needs") == "verify":
            continue
        _g = mod.package_parse(_unhex(_c["hex"]))
        _got = "ok" if _g["ok"] else _g["code"]
        if _got != _c["code"]:
            _wrong.append("%s：%s→%s" % (_c["name"], _c["code"], _got))
    check("★★ %d 条坏包逐条对上夹具里的理由词（词表与判的次序是三端共用的契约）"
          % (len(_bad["cases"]) - len(_needs_verify)), not _wrong,
          "；".join(_wrong))

    _covered = {c["code"] for c in _bad["cases"]}
    _vocab = [mod.PACKAGE_LENGTH, mod.PACKAGE_MAGIC_BAD, mod.PACKAGE_FORMAT_BAD,
              mod.PACKAGE_RECORD, mod.PACKAGE_PATH, mod.PACKAGE_DUPLICATE,
              mod.PACKAGE_CONTENT, mod.PACKAGE_MANIFEST, mod.PACKAGE_SIGNATURE]
    check("★ 词表里每一个词都有坏包钉住（有一个没人守就是一条没人守的判据）",
          not [v for v in _vocab if v not in _covered],
          repr([v for v in _vocab if v not in _covered]))

    # ★ 截断到任何一个长度都不许抛 —— 一个只读解析器唯一的合法反应是"说它不长这样"。
    #   抛出在集群侧意味着一个以 root 跑的进程带着 traceback 退出。
    _threw = None
    _codes = set()
    for _n in range(len(_good)):
        try:
            _g = mod.package_parse(_good[:_n])
        except Exception as _e:                                  # noqa: BLE001
            _threw = "%d 字节时抛了 %r" % (_n, _e)
            break
        if _g["ok"]:
            _threw = "%d 字节时居然通过了" % _n
            break
        _codes.add(_g["code"])
    check("★★ 截断到任何一个长度都不抛、不通过（%d 种理由）" % len(_codes),
          _threw is None, _threw or "")
    check("★ 而且截断确实产生了不止一种理由（只有一种说明检查太粗）",
          len(_codes) >= 2, repr(sorted(_codes)))

    # ★ 大小写折叠是 ASCII-only：`İ`（U+0130）与 `K`（U+212A）是全 Unicode 折叠
    #   **会**折到 ASCII、而 ASCII-only **不**折的两个。这是一条**拒绝**规则，
    #   折叠口径不一致就会出现"一边收、一边拒"。
    check("★ 大小写折叠是 ASCII-only（全 Unicode 的 lower() 会在这两个字符上分家）",
          mod.package_fold_ascii("ABC") == "abc"
          and mod.package_fold_ascii("İ") != "i"
          and mod.package_fold_ascii("K") != "k"
          and mod.package_fold_ascii("A中B") == "a中b",
          "%r %r %r" % (mod.package_fold_ascii("İ"),
                        mod.package_fold_ascii("K"),
                        mod.package_fold_ascii("A中B")))
    check("★ 而且 `str.lower()` 真的会分家 —— 这一条说明上一条不是在防一个假想",
          "K".lower() == "k" and len("İ".lower()) == 2)

    # ★ `--extract-package`：集群侧读包的**唯一**入口，也是部署脚本织作业脚本要用
    #   的那个。它的输出必须是**逐字节**那一份文件 —— 标准输出上多一行日志，取回来
    #   的 job/start.sh 里就混进了一行日志，而那是"部署成功了但作业起不来"。
    _pkgfile = os.path.join(tempfile.mkdtemp(prefix="slurmate-pkg-"), "x.splug")
    try:
        with open(_pkgfile, "wb") as _f:
            _f.write(_good)
        _want = None
        for _f in _r["files"]:
            if _f["path"] == "job/start.sh":
                _want = _good[_f["offset"]:_f["offset"] + _f["size"]]
        _run = subprocess.run([sys.executable, DAEMON, "--extract-package",
                               _pkgfile, "job/start.sh"],
                              capture_output=True)
        check("★★ --extract-package 的输出**逐字节**等于包里那一份（多一行日志就废了）",
              _run.returncode == 0 and _run.stdout == _want,
              "rc=%d，stdout %d 字节（期望 %d），stderr=%r"
              % (_run.returncode, len(_run.stdout), len(_want or b""),
                 _run.stderr[:200]))
        _miss = subprocess.run([sys.executable, DAEMON, "--extract-package",
                                _pkgfile, "job/nope.sh"], capture_output=True)
        check("★ 包里没有那一份时明确失败（不是安静地输出空）",
              _miss.returncode != 0 and _miss.stdout == b"", repr(_miss.stdout[:80]))
        _badpkg = os.path.join(os.path.dirname(_pkgfile), "bad.splug")
        with open(_badpkg, "wb") as _f:
            _f.write(_unhex([c for c in _bad["cases"] if c["code"] == "magic"][0]["hex"]))
        _badrun = subprocess.run([sys.executable, DAEMON, "--extract-package",
                                  _badpkg, "job/start.sh"], capture_output=True)
        check("★ 包本身不成立时，错误走 stderr、stdout 一个字节都不出",
              _badrun.returncode != 0 and _badrun.stdout == b""
              and b"magic" in _badrun.stderr, repr(_badrun.stderr[:200]))
    finally:
        shutil.rmtree(os.path.dirname(_pkgfile), ignore_errors=True)

    # ── 19.15 ★★ 安装器：装一个包进站点（`slurmate plugin install`）──────────
    #
    # 这一节是"服务器开始收外面的包"这件事**唯一**的自动化防线（deploy.sh 本机
    # 跑不了：要 root 加一台控制节点，见 KNOWN-ISSUES 的 U2）。它钉三组判据：
    #
    #   ① **输入**：只收 root 控制得住、别人换不掉的普通文件；
    #   ② **包的验证**：能解析 + 签名自洽 + 整包大小在发得出去的范围内；
    #   ③ **与站点自己的记忆比**（§2.5 在站点这一侧的落点）：同一个 id 换了
    #      签名者（或者从"有签名"变成"没签名"）⇒ **停下来问**，不替你选。
    print("\n── 19.15. 安装器（装一个 .splug 进站点）──")

    _ins_home = tempfile.mkdtemp(prefix="slurmate-install-")
    try:
        def _install(pkgs, pdir, **kw):
            """跑一遍安装器，返回 `(退出码, 它打印的全部内容)`。

            ★ 关键字参数**必须转发下去**：这里是安装器唯一的口子，而
              `replace_key` 是一个"我确认过了"的开关 —— 夹具把它丢掉，测出来的
              就是"确认了也没用"，而那是另一条判据。
            """
            buf = io.StringIO()
            rc = mod.install_plugins(list(pkgs), pdir, say=lambda *a: buf.write(
                (" ".join(str(x) for x in a) + "\n")), **kw)
            return rc, buf.getvalue()

        def _pkg_of(uid, name, ver="1.0.0", extra=(), sig=None, out=None):
            """造一个最小的包；`sig=(pem, 公钥)` 时给它签名。返回它的路径。"""
            files = [("plugin.json", json.dumps(
                {"id": uid, "name": name, "version": ver,
                 "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8"))]
            files += list(extra)
            blob = (sign_files(files, sig[0], sig[1]) if sig
                    else build_package(files))
            p = os.path.join(out or _ins_home, "%s-%s.splug" % (name, ver))
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(blob)
            return p

        _UID_A = "01M2JKHTZGKJBFQQTWYXMQMF50"
        _UID_B = "01M2JKHTZGKJBFQQTWYXMQMF51"
        _INSDIR = os.path.join(_ins_home, "plugins")
        os.makedirs(_INSDIR, exist_ok=True)

        # ── ① 输入那一关：三种"别人能在这中间把它换掉"的输入都要被拒 ──
        #
        # ★ 属主那一条在本机（非 root）**造不出来** —— 只有 root 能造一个属于
        #   别人的文件。所以判据被写成一个纯函数（package_input_problem），
        #   这里用一个**伪造的 stat 结果**把那一支走通。造不出来的检查等于没有
        #   检查，而这一条是这三个里最要紧的（属主能随时改写自己拥有的文件）。
        _probe = _pkg_of(_UID_A, "probe")

        # 造一个"看起来像那个文件、但属主是别人"的 stat 结果。
        # os.stat_result 的字段是 (mode, ino, dev, nlink, uid, gid, size, atime,
        # mtime, ctime)。
        def _st_with_uid(u):
            return os.stat_result((0o100644, 1, 1, 1, u, u, 10, 0, 0, 0))

        _alien = mod.package_input_problem(_probe, want_uid=UID, st=_st_with_uid(0))
        check("★★ 属主不是安装器自己 ⇒ 拒绝（属主能随时改写自己拥有的文件）",
              _alien is not None and "属于" in _alien, repr(_alien))
        check("★ 对照：同一个文件、属主是自己 ⇒ 放行（上一条不是恒真）",
              mod.package_input_problem(_probe, want_uid=UID,
                                        st=_st_with_uid(UID)) is None,
              repr(mod.package_input_problem(_probe, want_uid=UID,
                                             st=_st_with_uid(UID))))

        _link = os.path.join(_ins_home, "link.splug")
        os.symlink(_probe, _link)
        _rc, _out = _install([_link], _INSDIR)
        check("★★ 符号链接冒充 `.splug` ⇒ 拒绝（目标随时可以换）",
              _rc == 1 and "符号链接" in _out and os.listdir(_INSDIR) == [],
              "rc=%d %r" % (_rc, _out[:160]))

        _loose = _pkg_of(_UID_A, "loose")
        os.chmod(_loose, 0o666)
        _rc, _out = _install([_loose], _INSDIR)
        check("★★ 组/其他人可写的包 ⇒ 拒绝（022 位）",
              _rc == 1 and "可写" in _out and os.listdir(_INSDIR) == [],
              "rc=%d %r" % (_rc, _out[:160]))
        os.chmod(_loose, 0o644)

        # ── ② 验签 ──
        if not openssl_bin():
            check("★★ 本机没有 openssl —— 安装器的验签这一路**测不了**"
                  "（不是「跳过」，是这一节的核心没被验到）", False,
                  "装一个 openssl 再跑")
        else:
            _k1 = openssl_make_key(_ins_home, "k1")
            check("测试用的第一把 Ed25519 钥匙造出来了", _k1 is not None)
            _signed = _pkg_of(_UID_A, "alpha", sig=_k1)
            _rc, _out = _install([_signed], _INSDIR)
            check("★★ 签名验过了 ⇒ 装上，而且**说出来了**",
                  _rc == 0 and "签名验过了" in _out
                  and os.path.isfile(os.path.join(_INSDIR, _UID_A + ".splug")),
                  "rc=%d %r" % (_rc, _out[:300]))
            check("★ 落地文件名是**包里的 id**（不是下载时那个文件名）",
                  [x for x in os.listdir(_INSDIR) if x.endswith(".splug")]
                  == [_UID_A + ".splug"], str(os.listdir(_INSDIR)))
            check("★ 站点侧记下了「这个 id 是哪把钥匙签的」",
                  mod.read_plugin_keys(_INSDIR, strict=True).get(
                      _UID_A, {}).get("fingerprint")
                  == hashlib.sha256(_k1[1]).hexdigest(),
                  str(mod.read_plugin_keys(_INSDIR)))

            # 装完之后守护进程真的认它 —— 装得上、扫不出，是最坏的那种失败。
            _ispecs, _iprobs = mod.scan_plugins(_INSDIR)
            check("★★ 装进去的那个包，守护进程扫得出来（装得上就得认得出）",
                  _iprobs == () and [s.name for s in _ispecs] == ["alpha"],
                  "%s / %s" % ([s.name for s in _ispecs], _iprobs))

            # 签名被改了一位 ⇒ 拒绝，并且**一个字节都不写**。
            #
            # ★ 改的必须是签名块里那 64 个字节：改**负载**任何一个字节会被
            #   `content` 那条判据先抓住（记录里的 sha256 对不上），那是另一条
            #   判据 —— 拿它当"验签失败"测，测的是一个根本没走到验签的包。
            _bare_files = [("plugin.json", json.dumps(
                {"id": _UID_A, "name": "alpha", "version": "1.0.0",
                 "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8"))]
            _bare_blob = build_package(_bare_files)
            _sig64 = openssl_sign(_k1[0], bytes.fromhex(
                mod.package_parse(_bare_blob)["digest"]))
            _flipped = bytes([_sig64[0] ^ 0x01]) + _sig64[1:]
            _tp = os.path.join(_ins_home, "tampered.splug")
            with open(_tp, "wb") as _f:
                _f.write(build_package(_bare_files,
                                       bytes([1]) + _k1[1] + _flipped))
            _before = sorted(os.listdir(_INSDIR))
            _rc, _out = _install([_tp], _INSDIR)
            check("★★ 签名对不上（内容被改过）⇒ 拒绝，且一个字节都不写",
                  _rc == 1 and "签名验不过" in _out
                  and sorted(os.listdir(_INSDIR)) == _before,
                  "rc=%d %r" % (_rc, _out[:200]))

            # ★ 验不了 ≠ 验过了。把 openssl 从 PATH 上拿掉（这里靠改常量模拟），
            #   有签名的包必须**拒绝** —— 而报出来的话要说清是"验不了"。
            _saved_ossl = mod.PLUGIN_OPENSSL
            mod.PLUGIN_OPENSSL = "slurmate-no-such-openssl"
            try:
                _rc, _out = _install([_signed], _INSDIR)
                check("★★ 本机验不了签名 ⇒ **拒绝**（不装一个没验过的包）",
                      _rc == 1 and "验不了" in _out, "rc=%d %r" % (_rc, _out[:240]))
                check("★ 而且那句话指路（装上 openssl 再试），不是一句「失败了」",
                      "openssl" in _out and "pkeyutl" in _out, repr(_out[:240]))
            finally:
                mod.PLUGIN_OPENSSL = _saved_ossl

            # ── ③ 与站点自己的记忆比（§2.5 在站点这一侧）──
            _k2 = openssl_make_key(_ins_home, "k2")
            _fk1 = hashlib.sha256(_k1[1]).hexdigest()
            _other = _pkg_of(_UID_A, "alpha", ver="2.0.0", sig=_k2)
            _rc, _out = _install([_other], _INSDIR)
            check("★★ 同一个 id 换了签名者 ⇒ **拒绝**（§2.5 的机械判据）",
                  _rc == 1 and "上一次不是这么签的" in _out,
                  "rc=%d %r" % (_rc, _out[:240]))
            check("★★ 而且把**两把指纹**都报出来（运维要拿它去核对）",
                  _fk1[:16] in _out
                  and hashlib.sha256(_k2[1]).hexdigest()[:16] in _out, repr(_out[:400]))
            check("★★ 并且给出两条有后果的出路（换签名者 / 分身），不替你选",
                  "replace-key" in _out and "--fork" in _out, repr(_out[:400]))
            check("★ 拒绝之后站点上还是原来那一份（没被换掉）",
                  mod.read_plugin_keys(_INSDIR)["%s" % _UID_A]["version"] == "1.0.0",
                  str(mod.read_plugin_keys(_INSDIR)))

            # 显式确认：值必须是**记录里那把旧指纹** —— 随手加个开关不算确认
            _rc, _out = _install([_other], _INSDIR, replace_key="0" * 64)
            check("★★ --replace-key 给的值与记录不符 ⇒ 仍然拒绝（确认要有依据）",
                  _rc == 1 and "上一次不是这么签的" in _out, "rc=%d" % _rc)
            _rc, _out = _install([_other], _INSDIR, replace_key=_fk1)
            check("★★ --replace-key 给对了 ⇒ 装上，并且**说出来**这是显式确认",
                  _rc == 0 and "换成了" in _out
                  and mod.read_plugin_keys(_INSDIR)[_UID_A]["fingerprint"]
                  == hashlib.sha256(_k2[1]).hexdigest(),
                  "rc=%d %r" % (_rc, _out[:240]))

            # ★ 反方向同样要拦：记着"上一份是 K2 签的"，这次来一份**没签名的**。
            #   摘掉签名正是"降级到不用验"的那一步，而它的后果与换钥匙一样。
            _bare = _pkg_of(_UID_A, "alpha", ver="3.0.0")
            _rc, _out = _install([_bare], _INSDIR)
            check("★★ 记着有签名、这次来了个没签名的 ⇒ 拒绝（摘签名 = 降级）",
                  _rc == 1 and "（这一份没有签名）" in _out,
                  "rc=%d %r" % (_rc, _out[:240]))

            # 首次安装一个**没签名**的包是允许的（§4.1 签名可选），但必须**大声说**
            _rc, _out = _install([_pkg_of(_UID_B, "beta")], _INSDIR)
            check("★ 首次装一个没签名的包 ⇒ 允许，但必须**说出来**",
                  _rc == 0 and "没有签名" in _out, "rc=%d %r" % (_rc, _out[:240]))
            check("★ 而且落地时最后再提醒一次（这一屏是管理员唯一的依据）",
                  "没有源码可对照" in _out or "没签名的包" in _out, repr(_out[-300:]))

            # ── ④ §6.4：两个包同一个 id ──
            _dup1 = _pkg_of(_UID_B, "beta", ver="9.0.0", out=_ins_home)
            _dup2 = os.path.join(_ins_home, "beta-again.splug")
            with open(_dup2, "wb") as _f:
                _f.write(build_package([("plugin.json", json.dumps(
                    {"id": _UID_B, "name": "beta2", "version": "9.1.0",
                     "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8"))]))
            _rc, _out = _install([_dup1, _dup2], _INSDIR)
            check("★★ 两个包同一个 id ⇒ 两个都不装（§6.4；按 id 命名会互相覆盖）",
                  _rc == 1 and "同一个插件" in _out, "rc=%d %r" % (_rc, _out[:240]))
            check("★ 而且原来那一份没有被改动（两遍式的第一遍只读）",
                  mod.read_plugin_keys(_INSDIR)[_UID_B]["version"] == "1.0.0",
                  str(mod.read_plugin_keys(_INSDIR)[_UID_B]))

            # ── ⑤ 一整批里有一个坏的 ⇒ 一个都不装 ──
            _good_batch = _pkg_of(_UID_B, "beta", ver="4.0.0",
                                  out=os.path.join(_ins_home, "batch"))
            _broken = os.path.join(_ins_home, "broken.splug")
            with open(_broken, "wb") as _f:
                _f.write(b"splug\x1a\r\n" + b"\0" * 40)
            _rc, _out = _install([_good_batch, _broken], _INSDIR)
            check("★★ 一批里有一个坏的 ⇒ **一个字节都不写**（两遍式）",
                  _rc == 1 and "一个字节都没有写" in _out
                  and mod.read_plugin_keys(_INSDIR)[_UID_B]["version"] == "1.0.0",
                  "rc=%d %r" % (_rc, _out[:300]))

            # ── ⑥ 整包大小：装了也发不出去的，不装 ──
            _fat = _pkg_of(_UID_B, "beta", ver="5.0.0", extra=[
                ("big.bin", b"z" * (mod.PLUGIN_PACKAGE_MAX_BYTES + 16))],
                out=os.path.join(_ins_home, "batch"))
            _rc, _out = _install([_fat], _INSDIR)
            check("★★ 超过整包上限 ⇒ 拒绝（它装上去客户端也取不回来）",
                  _rc == 1 and "超过本站的整包上限" in _out, "rc=%d %r" % (_rc, _out[:200]))

            # ── ⑦ 站点侧那把钥匙的记录坏了 ⇒ **不收**（不能当成"没记住"）──
            with open(os.path.join(_INSDIR, ".keys.json"), "w",
                      encoding="utf-8") as _f:
                _f.write("{ 这不是 JSON")
            _rc, _out = _install([_signed], _INSDIR)
            check("★★ 钥匙记录读不出来 ⇒ 拒绝（当成空的会让换钥匙静默放行）",
                  _rc == 1 and "钥匙记录" in _out, "rc=%d %r" % (_rc, _out[:240]))
            os.unlink(os.path.join(_INSDIR, ".keys.json"))

        # ── ⑨ 有人绕过安装器把包放了进去 ⇒ 自检要说出来 ──
        #
        # ★ 这一条是"安装器是唯一写方"那句话的落点：如果 .keys.json 记的是 K1
        #   而包上是 K2，那只可能是有人直接往目录里放了东西 —— 装的时候没人会
        #   放过它（见 ③）。守护进程**不因此起不来**（那会带走整个站点），但
        #   `--check-plugins` 必须说。
        _bypass = os.path.join(_ins_home, "bypass")
        os.makedirs(_bypass, exist_ok=True)
        os.chmod(_bypass, 0o755)
        mod.write_plugin_keys(_bypass, {_UID_A: {"fingerprint": "a" * 64,
                                                 "name": "alpha",
                                                 "version": "1.0.0"}})
        with open(os.path.join(_bypass, _UID_A + ".splug"), "wb") as _f:
            _f.write(build_package([("plugin.json", json.dumps(
                {"id": _UID_A, "name": "alpha", "version": "1.0.0",
                 "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8"))]))
        _crun = subprocess.run([sys.executable, DAEMON, "--check-plugins",
                                "--plugins-dir", _bypass],
                               capture_output=True, text=True)
        check("★★ 包上的签名者与安装记录不符 ⇒ 自检点名（绕过安装器放包的形状）",
              "签名者与安装记录不符" in _crun.stdout, repr(_crun.stdout[-400:]))
        check("★ 但它**不中止**（守护进程仍然照常起来 —— 一条记录不符不该带走整个站点）",
              _crun.returncode == 0, "rc=%d %r" % (_crun.returncode,
                                                   _crun.stderr[-200:]))

        # ── ⑨a ★ 自检要报**内容摘要** ──
        #
        # 服务器上**没有源码树可对照**：能回答"我装上去的这一份是不是作者发布的那
        # 一份"的，只有这个数与作者 `packer inspect` 报的那个。所以它必须打全、
        # 而且必须是**内容摘要**（§3.4）—— 报成容器字节的 sha256 的话，"补了个签名块"
        # 会被读成"换了一份包"，而按 §4.2 那还是同一份构件：管理员会得出**相反**的
        # 结论。
        _pk_path = os.path.join(_bypass, _UID_A + ".splug")
        _want_digest = mod.package_read_file(_pk_path)["digest"]
        with open(_pk_path, "rb") as _pf2:
            _container_sha = hashlib.sha256(_pf2.read()).hexdigest()
        check("★★ 自检报出**完整的内容摘要**（拿它去与作者报的那个逐个字符比）",
              ("内容摘要 %s" % _want_digest) in _crun.stdout,
              repr(_crun.stdout[-400:]))
        check("★ 而它**不是**容器字节的 sha256（补一个签名块不该动这个数）",
              _want_digest != _container_sha
              and ("内容摘要 %s" % _container_sha) not in _crun.stdout,
              "%s vs %s" % (_want_digest[:16], _container_sha[:16]))

        # ── ⑨b `--check-plugins` 的机器可读那一段（**跨脚本契约**）──
        #
        # ★ 这一段是 `deploy.sh` 拿来找包、给作业脚本命名的唯一依据。它的形状变了，
        #   编织那一段会立刻跟着坏 —— 而坏法是"找不到文件"或"函数名对不上"，
        #   指不回这里。所以形状本身要有用例。
        _tsvdir = os.path.join(_ins_home, "tsv")
        os.makedirs(_tsvdir, exist_ok=True)
        _tsv_a = _pkg_of("01M2JKHTZGKJBFQQTWYXMQMF60", "withjob",
                         extra=[("job/start.sh", b"start_withjob() { :; }\n")],
                         out=_tsvdir)
        os.rename(_tsv_a, os.path.join(_tsvdir,
                                       "01M2JKHTZGKJBFQQTWYXMQMF60.splug"))
        _tsv_b = _pkg_of("01M2JKHTZGKJBFQQTWYXMQMF61", "nojob", out=_tsvdir)
        os.rename(_tsv_b, os.path.join(_tsvdir,
                                       "01M2JKHTZGKJBFQQTWYXMQMF61.splug"))
        _trun = subprocess.run([sys.executable, DAEMON, "--check-plugins",
                                "--plugins-dir", _tsvdir],
                               capture_output=True, text=True)
        _tlines = _trun.stdout.split("plugin-packages:")[-1].strip().split("\n")
        _trows = [l.split("\t") for l in _tlines if l.strip()]
        check("★★ 机器可读那一段是**四列**（deploy.sh 的跨脚本契约）",
              len(_trows) == 2 and all(len(r) == 4 for r in _trows), repr(_trows))
        check("★★ 第 4 列如实回答包里有没有 `job/start.sh`（判据是记录表，不是磁盘）",
              sorted(r[3] for r in _trows) == ["has_job", "no_job"]
              and {r[0]: r[3] for r in _trows} == {"withjob": "has_job",
                                                   "nojob": "no_job"},
              repr(_trows))
        check("★ 第 2 列是**包在哪**、第 3 列是 id（作业脚本按它命名）",
              all(r[1].endswith(r[2] + ".splug") and len(r[2]) == 26
                  for r in _trows), repr(_trows))
        # ★ 那一行「分发 N 字节 / M 份文件」读的是 `plugin_payload_index()` ——
        #   而它**只剩这一个调用方**（v0.7 删掉逐份取之后它不再走线）。它必须与
        #   **包里的记录表**一致：报少了运维以为这个插件很小，报多了是在吓人。
        check("★★ 自检报出的份数就是**包里那张记录表**的份数（2 份 / 1 份）",
              "2 份文件" in _trun.stdout and "1 份文件" in _trun.stdout,
              repr(_trun.stdout[-300:]))

        # ── ⑩ 用法错误：一个包都没给 ──
        _rc, _out = _install([], _INSDIR)
        check("★ 一个包都没给 ⇒ 用法错误（code 2），不是静默成功",
              _rc == 2 and "用法" in _out, "rc=%d %r" % (_rc, _out[:120]))
    finally:
        shutil.rmtree(_ins_home, ignore_errors=True)

    # ── 20. run.sbatch 写的会话文件 ↔ 守护进程的白名单 ──────────────────────
    #
    # 这两个文件之间有一条**跨语言的契约**：作业用 printf 拼一段 JSON 出来，守护
    # 进程按 SESSION_FILE_FIELDS 这个白名单去读，**未登记的字段一律静默丢弃**。
    # 于是「作业加了一个字段、这边忘了登记」的症状是：作业照常跑、守护进程照常起、
    # 那个字段凭空消失，而**没有任何地方会报错** —— 正是本项目一路在清的那类问题。
    #
    # 所以这里把契约变成可执行的：真的把 write_session 跑一遍，再要求
    #   ① 它输出的每一个键都在白名单里（漏登记当场红）
    #   ② 那份 JSON 能被守护进程解析（printf 的参数个数错了就解析不了）
    #   ③ 逐字段对上（参数错位会让 ssh_host_key 里躺着别的值）
    # 这一节是 run.sbatch 在本文件里唯一的自动化防线 —— 它没有 .sh 后缀，
    # checks.yml 的语法扫描清单里不含它，改动后只有 `bash -n` 和这里在看着。
    print("\n── 20. run.sbatch 写出来的会话文件 ──")
    _rb = os.path.join(os.path.dirname(os.path.abspath(__file__)), "run.sbatch")
    _skip = None
    try:
        with open(_rb, encoding="utf-8") as f:
            _rblines = f.read().split("\n")
    except OSError as e:
        _rblines, _skip = None, "读不到 run.sbatch：%s" % e

    def _grab(name):
        """按花括号配平抽出一个 shell 函数的原文。"""
        start = next(i for i, l in enumerate(_rblines) if l.startswith(name + "()"))
        depth, out = 0, []
        for l in _rblines[start:]:
            out.append(l)
            depth += l.count("{") - l.count("}")
            if depth == 0 and len(out) > 1:
                break
        return "\n".join(out)

    if _skip is None:
        try:
            _funcs = "\n".join(_grab(n) for n in
                               ("write_atomic", "json_escape", "write_session"))
            # 插件往会话文件里加的字段靠这个**宿主声明的**关联数组传递。它是
            # `declare -A`，在函数外面声明（插件在 start_* 里往它写、write_session
            # 读）。抽出来一起跑 —— 宿主把这一行删掉的话，下面的 write_session
            # 会在 set -u 下报 unbound variable，而这条用例当场红。
            _decl = next(l for l in _rblines
                         if l.startswith("declare -A PLUGIN_SESSION_FIELDS"))
        except StopIteration:
            _skip = ("run.sbatch 里找不到 write_atomic/json_escape/write_session"
                     " 或 declare -A PLUGIN_SESSION_FIELDS")
    if _skip is None:
        # 抽出来的东西自己得先是合法 shell，否则下面那次运行失败的原因与被测逻辑无关
        _syn = subprocess.run(["bash", "-n", "-c", _funcs], capture_output=True, text=True)
        if _syn.returncode != 0:
            _skip = "抽出来的函数不是合法 shell（抽取逻辑要跟着改）：%s" % _syn.stderr.strip()

    check("run.sbatch 的会话文件可以被自动检查（抽取失败就是这一条红）",
          _skip is None, _skip or "")

    if _skip is None:
        _hk = "ssh-ed25519 " + "K" * 68
        _harness = "\n".join([
            "set -u",
            'SLURMATE_SESSION_ID="sess-abc123"', "JOB_ID=12345",
            "MY_UID=$(id -u)", "MY_USER=$(id -un)",
            "SLURMATE_PARTITION=A6000", "NODE=node01", "NODE_IP=192.0.2.20",
            "SVC_PORT=55003", "STARTED_AT=1700000000",
            "SLURMATE_SERVICE_KIND=sshd", "SVC_PID=4242",
            "AUTH_MODE=publickey", 'AUTH_PASSWORD=""',
            _decl,
            # 插件侧的写法就是这样：往那个数组里写一个键。宿主不认识
            # `ssh_host_key` 这个名字 —— 它只负责**转义**并写进 JSON。
            'PLUGIN_SESSION_FIELDS[ssh_host_key]="%s"' % _hk,
            "SLURM_RESTART_NUMBER=0",
            'SESS_FILE="%s"' % os.path.join(tmpdir, "job-12345.json"),
            _funcs,
            'write_session "running" null',
        ])
        _run = subprocess.run(["bash", "-c", _harness], capture_output=True, text=True)
        _path = os.path.join(tmpdir, "job-12345.json")
        _parsed = None
        if _run.returncode == 0 and os.path.exists(_path):
            try:
                with open(_path, encoding="utf-8") as f:
                    _parsed = json.load(f)
            except ValueError as e:
                _parsed = None
                _run.stderr += "\nJSON 解析失败：%s" % e
        check("write_session 能跑通并写出合法 JSON（printf 的参数个数错了就红）",
              _parsed is not None,
              (_run.stderr or _run.stdout or "").strip()[:300])
        if _parsed is not None:
            _unknown = sorted(set(_parsed.keys()) - mod.SESSION_FILE_FIELDS)
            check("★ 它写出来的每个键都在守护进程的白名单里"
                  "（漏登记 = 那个字段被静默丢弃，谁都不会报错）",
                  _unknown == [], "没登记的键：%s" % _unknown)
            check("★ 插件加的字段被写进去了，而且宿主统一做了转义（键名跨语言契约）",
                  _parsed.get("ssh_host_key") == _hk
                  and _parsed.get("service_pid") == 4242
                  and _parsed.get("service_kind") == "sshd"
                  and _parsed.get("auth_mode") == "publickey"
                  and _parsed.get("tunnel_target") == "192.0.2.20:55003"
                  and _parsed.get("exit_code") is None,
                  repr({k: _parsed.get(k) for k in
                        ("ssh_host_key", "service_pid", "service_kind",
                         "tunnel_target", "exit_code")}))
            check("schema 与守护进程认的那一个一致",
                  _parsed.get("schema") == mod.SCHEMA_VERSION,
                  "%s vs %s" % (_parsed.get("schema"), mod.SCHEMA_VERSION))

    # ── 21. 作业侧契约：宿主与插件之间只有一条接口，就是**函数名** ──────────
    #
    #     plugin_call <动词>  →  <动词>_<短名>（短名里的 - 写成 _）
    #
    # 这条契约漂了的症状是：用户排完队、作业跑起来，然后在日志里读到"候选端口
    # 全部失败" —— 一句话指不回根因，而根因是一个函数名拼错了。
    #
    # 所以这里**真的编织一遍**（照 deploy.sh 的做法，同一个标记、同一段 awk），
    # 再真的调一次分派。
    print("\n── 21. 作业侧契约（宿主 ↔ 插件的唯一接口：函数名）──")
    _tpl = open(_rb, encoding="utf-8").read()
    # ★ **一个插件一份**：照 deploy.sh 逐插件织，而不是把所有插件织进一份。
    #   这一节的分叉后果是"用例绿了、部署到真机上炸" —— 而 deploy.sh 本机跑不了。
    _woven_of = {}
    _awk = None
    for _sp in cfg.plugin_specs:
        _out = os.path.join(tmpdir, "woven-%s.sbatch" % _sp.name)
        _awk = weave_one(_rb, _sp.source_package, _sp.name, _sp.id, _out)
        _woven_of[_sp.name] = _out
    _woven = _woven_of[CS]        # 22a 用它，见下
    # ★ 数的是**整行**的标记：模板的文件头注释里也提到了它，子串匹配会把它也算上，
    #   于是"替换成功"这件事看起来永远不成立 —— deploy.sh 里那条同理。
    check("★ 模板里的拼接标记恰好一处，编织后一处不剩（照 deploy.sh 的做法）",
          _awk is not None and _awk.returncode == 0
          and len(re.findall(r"(?m)^# @@SLURMATE_PLUGIN_BLOCKS@@$", _tpl)) == 1
          and not re.search(r"(?m)^# @@SLURMATE_PLUGIN_BLOCKS@@$", _awk.stdout),
          (_awk.stderr[:200] if _awk else "没有插件"))

    for _sp in cfg.plugin_specs:
        _w = _woven_of[_sp.name]
        _wtxt = open(_w, encoding="utf-8").read()
        _suffix = _sp.name.replace("-", "_")
        _wsyn = subprocess.run(["bash", "-n", _w], capture_output=True, text=True)
        check("★ 插件 %s 那一份编织出来是合法 shell（挡的是语法错的插件脚本）"
              % _sp.name, _wsyn.returncode == 0, _wsyn.stderr[:300])
        check("★ 插件 %s 的 job/start.sh 里定义了 %s（宿主就是按这个分派）"
              % (_sp.name, _sp.job_entry),
              re.search(r"(?m)^start_%s\s*\(\)" % _suffix, _wtxt) is not None)
        check("★ 它里面没有 shebang / #SBATCH（拼接点之后它们不会生效）",
              re.search(r"(?m)^#!|^[ \t]*#SBATCH",
                        mod.package_extract(_sp.source_package,
                                            "job/start.sh").decode("utf-8")) is None)
        # ★★ 这一节的核心：**那份脚本里只有它自己**。
        #
        # 同处一份文件时，插件里任何一行不在函数里的代码都待在主流程中间，会在
        # **每一个**作业里执行 —— 不管用的是哪个插件。拆开之后这条断言钉住的是
        # 那个危害的来源已经不在：别的插件连"被解析到"的机会都没有。
        _others = [o.name.replace("-", "_") for o in cfg.plugin_specs
                   if o.name != _sp.name]
        check("★★ 插件 %s 那份脚本里有且只有它自己的服务（别的插件一个都不在）"
              % _sp.name,
              len(re.findall(r"(?m)^start_[A-Za-z0-9_]+\s*\(\)", _wtxt)) == 1
              and not any(re.search(r"(?m)^(start|precheck|cleanup)_%s\s*\(\)"
                                    % _o, _wtxt) for _o in _others),
              "start_ 函数：%s" % re.findall(r"(?m)^start_([A-Za-z0-9_]+)\s*\(\)",
                                            _wtxt))

    # ★ 宿主里不许出现任何插件的名字。这是"外壳"的定义，而且是可机检的 ——
    #   注释里也不行：注释里的插件名会让下一个读的人以为宿主认识它。
    for _sp in cfg.plugin_specs:
        check("★ 宿主（run.sbatch 模板）里没有出现插件名 %r —— 一个字都没有"
              % _sp.name, _sp.name not in _tpl)

    # 真的调一次分派：三种结果必须分得开（有 / 没有 / 失败了）
    _dfuncs = "\n".join(_grab(n) for n in
                         ("plugin_call", "host_start_service", "plugin_names"))
    _dharness = "\n".join([
        "set -u",
        "SLURMATE_SERVICE_KIND=code-server",
        _dfuncs,
        'start_code_server() { printf "START %s\\n" "$1"; }',
        'precheck_code_server() { printf "PRECHECK\\n"; return 7; }',
        'host_start_service 55001; printf "rc_start=%s\\n" "$?"',
        'plugin_call precheck; printf "rc_pre=%s\\n" "$?"',
        'plugin_call cleanup; printf "rc_cleanup=%s\\n" "$?"',
        "SLURMATE_SERVICE_KIND=nosuch",
        'plugin_call start 1; printf "rc_unknown=%s\\n" "$?"',
        'printf "names=%s\\n" "$(plugin_names)"',
    ])
    _dr = subprocess.run(["bash", "-c", _dharness], capture_output=True, text=True)
    _out = _dr.stdout
    check("★ plugin_call start 分派到 start_code_server（短名里的 - 写成 _）",
          "START 55001" in _out and "rc_start=0" in _out, _out[:200])
    check("★ 插件自己的钩子失败时**返回码原样透出**（7，不是被吞成 0/1）",
          "PRECHECK" in _out and "rc_pre=7" in _out, _out[:200])
    check("★ 没定义的钩子返回 3 —— 「没有这个钩子」与「钩子失败了」必须分得开",
          "rc_cleanup=3" in _out, _out[:200])
    check("★ 这份脚本里没有请求的那个服务时也返回 3（宿主据此以 24 结束会话）",
          "rc_unknown=3" in _out, _out[:200])
    check("plugin_names 能列出作业侧有实现的插件（错误信息靠它说清楚）",
          "names=code_server" in _out, _out[:200])

    # ── 22. 真的把编织出来的作业脚本跑起来 ──────────────────────────────────
    #
    # 第 21 节验的是**分派**（抽函数出来调）。这一节验的是**主流程**：那个脚本真的
    # 被执行时，会走到哪一条路、写什么日志、以什么退出码结束。
    #
    # ★ 为什么值得单独一节：`run.sbatch` 没有 .sh 后缀，checks.yml 的语法扫描清单
    #   里不含它；它又只可能在计算节点上跑，而本机不是计算节点。所以除了这里，没有
    #   任何东西在看它的控制流。变异验证发现过这个洞：把作业脚本开头那道
    #   `declare -F start_<kind>` 守卫改成 `if false`，当时**全绿** —— 因为没有任何
    #   用例执行到那一行。
    print("\n── 22. run.sbatch 的主流程（真的跑一遍）──")

    def run_jobsh(script, kind, home, extra_env=None):
        """在一个假的计算节点环境里跑作业脚本。返回 (退出码, 日志文本)。"""
        fakebin = os.path.join(home, "bin")
        os.makedirs(fakebin, exist_ok=True)
        # detect_node_ip 优先问 scontrol；这里给它一个字面 IPv4（ACL 依赖它，
        # 而它是这条路上唯一一个必须真的能拿到的东西）。
        write_stub(os.path.join(fakebin, "scontrol"),
                   'echo "NodeName=node01 NodeAddr=192.0.2.20 State=IDLE"\n')
        env = {
            "PATH": fakebin + ":" + os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": home,
            "SLURM_JOB_ID": "424242",
            "SLURMD_NODENAME": "node01",
            "SLURMATE_SESSION_ID": "sess-jobsh-1",
            "SLURMATE_CANDIDATES": "55001;55002",
            "SLURMATE_SERVICE_KIND": kind,
            "SLURMATE_AUTH_MODE": "publickey",
            "SLURMATE_CLUSTER_CIDR": "192.0.2.0/24",
            "SLURMATE_SESS_DIR": os.path.join(home, ".slurmate", "sessions"),
            "SLURMATE_LOG_DIR": os.path.join(home, ".slurmate", "logs"),
            "SLURMATE_PORT_MIN": "55001",
            "SLURMATE_PORT_MAX": "55999",
        }
        env.update(extra_env or {})
        r = subprocess.run(["bash", script], capture_output=True, text=True,
                           env=env, timeout=120)
        logs = ""
        d_ = os.path.join(home, ".slurmate", "logs")
        if os.path.isdir(d_):
            for fn in sorted(os.listdir(d_)):
                with open(os.path.join(d_, fn), encoding="utf-8") as f:
                    logs += f.read()
        return r.returncode, (logs or (r.stdout + r.stderr))

    # ── 22a 脚本与 service_kind 对不上 ──
    #
    # ★ 这一条在新形状下换了角色。从前它验的是"本站没有作业侧实现了 X"；现在
    #   一个插件一份，"本站"这个概念在作业里没有了。剩下要兜的是**部署期选错了
    #   脚本**（提交了 A、跑起来的是 B）—— 守护进程那边由第 17 节的纯函数用例
    #   保证不选错，这里是万一漏了之后的最后一道网：以 24 明确结束，而不是拿
    #   错误的实现去跑、或者跑完所有候选端口才报一句"候选端口全部失败"。
    _h1 = os.path.join(tmpdir, "jobsh-unknown")
    os.makedirs(_h1, exist_ok=True)
    _rc, _log = run_jobsh(_woven, "nosuchplugin", _h1)
    check("★ 请求的服务不在脚本里 → 以 24 结束（不是跑完候选端口才失败）",
          _rc == 24, "rc=%s 日志=%s" % (_rc, _log[-300:]))
    check("★ 而且它说清**这份脚本里到底有些什么**（错误信息要能照着做）",
          "这份作业脚本里没有服务" in _log and "code_server" in _log,
          _log[-400:])

    # ── 22b 零块（宿主-only）的脚本 ──
    # 一个插件都没装是**合法状态**；而"一份没有任何插件块的脚本"在运行时的表现
    # 必须是一句人话。**注意**：一个插件一份之后，正常部署不会产出这种文件 ——
    # 零插件时 `jobs/` 里一份都没有，提交在守护进程那一层就被 service_kind 那一族
    # 错误挡住了。这条留着是因为**模板本身就是这个样子**，而模板是可以被
    # 手工 sbatch 的（排查时有人会这么干）。
    _woven0 = os.path.join(tmpdir, "woven-zero.sbatch")
    with open(os.path.join(tmpdir, "blocks0.sh"), "w", encoding="utf-8") as _f:
        _f.write("# 本站没有安装任何插件\n")
    _awk0 = subprocess.run(
        ["awk", "-v", "blocks=" + os.path.join(tmpdir, "blocks0.sh"),
         '/^# @@SLURMATE_PLUGIN_BLOCKS@@$/ {'
         ' while ((getline line < blocks) > 0) print line;'
         ' close(blocks); found = 1; next }'
         ' { print } END { if (!found) exit 9 }', _rb],
        capture_output=True, text=True)
    with open(_woven0, "w", encoding="utf-8") as _f:
        _f.write(_awk0.stdout)
    _syn0 = subprocess.run(["bash", "-n", _woven0], capture_output=True, text=True)
    check("没有任何插件块时织出来的脚本也是合法 shell",
          _awk0.returncode == 0 and _syn0.returncode == 0, _syn0.stderr[:200])
    _h2 = os.path.join(tmpdir, "jobsh-zero")
    os.makedirs(_h2, exist_ok=True)
    _rc0, _log0 = run_jobsh(_woven0, "code-server", _h2)
    check("★ 它同样以 24 明确结束（不是跑完候选端口才失败）",
          _rc0 == 24, "rc=%s 日志=%s" % (_rc0, _log0[-300:]))
    check("★ 它的日志里「这份脚本里有的是」那一项是空的（括号里什么都没有）",
          "这份脚本里有的是：（" in _log0, _log0[-500:])

    # ── 22c 插件自己的 precheck 没过 → 24，且**开始挑端口之前**就结束 ──
    _woven_pre = os.path.join(tmpdir, "woven-pre.sbatch")
    with open(os.path.join(tmpdir, "blocks_p.sh"), "w", encoding="utf-8") as _f:
        _f.write("start_thing() { log '不该走到这里'; SVC_PID=$$; return 0; }\n"
                 "precheck_thing() { log 'PRECHECK-拒绝了'; return 1; }\n")
    _awkp = subprocess.run(
        ["awk", "-v", "blocks=" + os.path.join(tmpdir, "blocks_p.sh"),
         '/^# @@SLURMATE_PLUGIN_BLOCKS@@$/ {'
         ' while ((getline line < blocks) > 0) print line;'
         ' close(blocks); found = 1; next }'
         ' { print } END { if (!found) exit 9 }', _rb],
        capture_output=True, text=True)
    with open(_woven_pre, "w", encoding="utf-8") as _f:
        _f.write(_awkp.stdout)
    _h3 = os.path.join(tmpdir, "jobsh-pre")
    os.makedirs(_h3, exist_ok=True)
    _rc3, _log3 = run_jobsh(_woven_pre, "thing", _h3)
    check("★ 插件的 precheck 没过 → 作业以 24 结束，且那道检查真的被调了",
          _rc3 == 24 and "PRECHECK-拒绝了" in _log3,
          "rc=%s 日志=%s" % (_rc3, _log3[-300:]))
    check("★ 预检没过时**不会**开始挑端口（服务一次都没被启动）",
          "不该走到这里" not in _log3, _log3[-300:])

    # ── 22d ★ 作业日志：我们自己的行**恰好一次**，插件的行**带得上去** ─────
    #
    # 这一段是本项目里最容易写成"看起来对"的地方，所以它有三条独立的断言。
    # 契约（plugins/README.md〈服务进程的输出、以及作业日志〉）：
    #
    #   · log() 双写（本地 + NFS），作业结束时的补写只补**水位之后**的部分
    #   · 服务进程的输出走它**自己的**文件，由 `cleanup_<短名>` 并进 LOCAL_LOG
    #   · `cleanup_<短名>` 在宿主最后一行**之后**被调，所以并进来的行天然在水位
    #     之后、会被补写带上去
    #
    # 变异验证发现的：写这一节时随手让假插件直接 printf 到 LOCAL_LOG，于是日志末尾
    # 出现了**两行**"清理完成 rc=24" —— 因为水位那时记的是"log() 调过几次"，
    # 而服务进程的插话让它错位了。
    _woven_raw = os.path.join(tmpdir, "woven-raw.sbatch")
    with open(os.path.join(tmpdir, "blocks_r.sh"), "w", encoding="utf-8") as _f:
        _f.write(
            # 服务进程的输出 → 它自己的文件（契约要求的形状）
            "start_thing() {\n"
            "    _thing_log=\"$LOCAL_LOG_DIR/thing.log\"\n"
            "    ( printf '服务自己的第 1 行\\n'; printf '服务自己的第 2 行\\n';"
            " sleep 60 ) >> \"$_thing_log\" 2>&1 &\n"
            "    SVC_PID=$!\n"
            # ★ 这一行是**故意违规**的：契约说服务进程的输出不该直接写 LOCAL_LOG。
            #   它同时是水位那条断言的试金石 —— 它插在两次 log() **中间**，
            #   于是"水位记行号"与"水位记 log() 次数"两种实现会给出不同的答案。
            "    printf '水位之前偷偷写的一行\\n' >> \"$LOCAL_LOG\"\n"
            "    log '插件用 log() 写的一行'\n"
            "    return 0\n"
            "}\n"
            "cleanup_thing() { tail -n 200 \"$_thing_log\" >> \"$LOCAL_LOG\" 2>/dev/null || true; }\n")
    _awk_r = subprocess.run(
        ["awk", "-v", "blocks=" + os.path.join(tmpdir, "blocks_r.sh"),
         '/^# @@SLURMATE_PLUGIN_BLOCKS@@$/ {'
         ' while ((getline line < blocks) > 0) print line;'
         ' close(blocks); found = 1; next }'
         ' { print } END { if (!found) exit 9 }', _rb],
        capture_output=True, text=True)
    with open(_woven_raw, "w", encoding="utf-8") as _f:
        _f.write(_awk_r.stdout)
    _syn_r = subprocess.run(["bash", "-n", _woven_raw], capture_output=True, text=True)
    check("按契约写的插件编织后仍是合法 shell",
          _awk_r.returncode == 0 and _syn_r.returncode == 0, _syn_r.stderr[:200])

    _hr = os.path.join(tmpdir, "jobsh-raw")
    _fakebin = os.path.join(_hr, "bin")
    os.makedirs(_fakebin, exist_ok=True)
    write_stub(os.path.join(_fakebin, "scontrol"),
               'echo "NodeName=node01 NodeAddr=192.0.2.20 State=IDLE"\n')
    _env_full = dict(os.environ)
    _env_full.update({
        "PATH": _fakebin + ":" + os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": _hr, "SLURM_JOB_ID": "777001", "SLURMD_NODENAME": "node01",
        "SLURMATE_SESSION_ID": "sess-raw-1", "SLURMATE_CANDIDATES": "55001",
        "SLURMATE_SERVICE_KIND": "thing", "SLURMATE_AUTH_MODE": "none",
        "SLURMATE_CLUSTER_CIDR": "192.0.2.0/24",
        "SLURMATE_SESS_DIR": os.path.join(_hr, ".slurmate", "sessions"),
        "SLURMATE_LOG_DIR": os.path.join(_hr, ".slurmate", "logs"),
        "SLURMATE_PORT_MIN": "55001", "SLURMATE_PORT_MAX": "55999",
    })
    _p = subprocess.Popen(["bash", _woven_raw], stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, env=_env_full)
    # 等它真的到 running（"会话就绪"落盘）再发 SIGTERM —— 那正是"作业被 scancel"
    # 的形状，也是 cleanup 与插件钩子唯一会走的那条路。
    _rlog = ""
    for _ in range(60):
        time.sleep(0.5)
        _rlog = _read_logs(_hr)
        if "会话就绪" in _rlog:
            break
    _p.send_signal(_sig.SIGTERM)
    try:
        _p.wait(timeout=60)
    except subprocess.TimeoutExpired:
        _p.kill()
        _p.wait()
    _rlog = _read_logs(_hr)
    _rlines = [x for x in _rlog.split("\n") if x.strip()]
    _dupes = sorted({x for x in _rlines if _rlines.count(x) > 1})
    check("★ 会话确实跑到了 running（下面几条不是在一个早退的作业上验的）",
          any("会话就绪" in x for x in _rlines), _rlog[-400:])
    check("★ 宿主自己的日志行在 NFS 里**恰好出现一次**（水位不许错位）",
          _dupes == [], "重复了：%s" % [x[-70:] for x in _dupes])
    check("★ 插件在 cleanup_<短名> 里并进来的服务日志确实上了 NFS",
          any("服务自己的第 1 行" in x for x in _rlines)
          and any("服务自己的第 2 行" in x for x in _rlines),
          _rlog[-500:])
    check("★ 而在 start_<短名> 里直接写 LOCAL_LOG 的行进不了 NFS"
          "（这正是契约要禁止那种写法的原因 —— 它是静默丢失）",
          not any("水位之前偷偷写的一行" in x for x in _rlines), _rlog[-500:])

    # ── 22e ★★ 一个插件的顶层语句**不会**在别的插件的作业里执行 ──────────────
    #
    # **这条是这次拆文件的全部理由。** 同处一份文件时，插件里任何一行不在函数
    # 里的代码都待在主流程中间 —— bash 自上而下解析整个文件，那一行于是在
    # **每一个**作业里执行，不管用的是哪个插件。一个插件的笔误因此可以改变
    # 所有其他插件的作业行为，而症状指不回任何一个文件。
    #
    # 观测手段是"顶层语句写一个文件"：可判定，而且与真实的危害同形（顶层代码有
    # 副作用，副作用落在别处）。
    _tld = os.path.join(tmpdir, "plugins-toplevel")
    _tl_def = (("loud", "01M2JKHTZGKJBFQQTWYXMQMF40",
                'start_loud() { return 1; }\n'
                ': > "$HOME/toplevel-ran"\n'),
               ("quiet", "01M2JKHTZGKJBFQQTWYXMQMF41",
                'start_quiet() { return 1; }\n'))
    os.makedirs(_tld, exist_ok=True)
    for _n, _i, _body in _tl_def:
        put_package(_tld, [
            ("job/start.sh", _body.encode("utf-8")),
            ("plugin.json", json.dumps(
                {"id": _i, "name": _n, "version": "1.0.0",
                 "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8")),
        ])
    _tl_specs, _tl_probs = mod.scan_plugins(_tld)
    check("顶层语句的假插件被扫进来（这条用例自己的前提）",
          sorted(s.name for s in _tl_specs) == ["loud", "quiet"], str(_tl_probs))
    _tl_by = {s.name: s for s in _tl_specs}
    # ★ 这里逐插件织 —— **与 deploy.sh 同一个形状**。如果哪天退回"共处一份"，
    #   下面第二条会立刻红，而红的方式正是它要防的那件事。
    _tl_home = {}
    for _n in ("loud", "quiet"):
        _o = os.path.join(tmpdir, "tl-%s.sbatch" % _n)
        weave_one(_rb, _tl_by[_n].source_package, _n, _tl_by[_n].id, _o)
        _tl_home[_n] = os.path.join(tmpdir, "jobsh-tl-%s" % _n)
        os.makedirs(_tl_home[_n], exist_ok=True)
        run_jobsh(_o, _n, _tl_home[_n])
    check("★ 「loud」自己的作业里，它那行顶层语句确实执行了"
          "（这条保证下一条不是假绿 —— 标记本身是能被写出来的）",
          os.path.exists(os.path.join(_tl_home["loud"], "toplevel-ran")),
          os.listdir(_tl_home["loud"]))
    check("★★ 而「loud」的顶层语句在「quiet」的作业里**没有**执行"
          " —— 拆成一份一份的全部理由就在这里",
          not os.path.exists(os.path.join(_tl_home["quiet"], "toplevel-ran")),
          os.listdir(_tl_home["quiet"]))

    # ── 23. 配额：一个会话占着一个位置 ─────────────────────────────────────
    print("\n── 23. 配额（每人最多几个会话）──")

    # ★ 这一节与第 18 节的唯一区别，正是它存在的理由：**store 不重建**。
    #   配额是跨请求累积的，而第 18 节的 `run_submit` 每次都新建一个 Store ——
    #   那会让计数永远从 0 开始，于是"配额"这件事在那里**根本测不出来**。
    #   （这正是它此前一条用例都没有的原因。）
    _q_home = os.path.join(tmpdir, "home-quota")
    os.makedirs(_q_home, exist_ok=True)
    d.user_home = lambda uid: _q_home
    d.store.close()
    d.store = mod.Store(os.path.join(tmpdir, "quota.db"))
    _q_seq = [0]
    _q_limit0 = cfg.max_sessions_per_user

    def _q_run(argv, timeout=10, check=False):
        """账户与分区都查得到 —— 这一节要的是**走到配额那一步之后**的行为，
        所以前面那几道（账户、分区权限）必须让路。"""
        a = [str(x) for x in argv]
        if "show" in a and "assoc" in a:
            if any("Partition" in x for x in a):
                return 0, "myaccount|\n", ""      # Partition 列为空 = 不限制
            return 0, "myaccount\n", ""
        return slurm_stub(argv, timeout, check)

    def quota_submit(limit):
        """把配额设成 `limit`，提交一次。store **跨调用保留**。"""
        cfg.max_sessions_per_user = limit
        _q_seq[0] += 1
        d.slurm = mod.Slurm(cfg)
        d.slurm.submit = lambda *a, **k: (7000 + _q_seq[0], None)
        real = mod.run_cmd
        mod.run_cmd = _q_run
        try:
            return d.op_submit(UID, {"op": "submit"})
        finally:
            mod.run_cmd = real

    check("★ 「占着位置」的两个集合不是一回事（一个是另一个的真超集）",
          mod.OCCUPYING_STATES == (mod.ST_RESERVED, mod.ST_SUBMITTED) + mod.ACL_STATES
          and set(mod.ACL_STATES) < set(mod.OCCUPYING_STATES),
          "%r / %r" % (mod.OCCUPYING_STATES, mod.ACL_STATES))

    r1 = quota_submit(1)
    check("上限 1 时第一个提交成功", r1.get("ok"), str(r1))
    check("★ 它此刻处在 submitted —— 这就是 F14 那个窗口",
          any(s["state"] == mod.ST_SUBMITTED for s in d.store.by_state((mod.ST_SUBMITTED,))),
          str([s["state"] for s in d.store.by_uid(UID)]))

    # ★★ **F14 的回归断言。** 改回「只数 ACL_STATES」的话，此刻计数是 **0**，
    #    第二个提交会长驱直入 —— 这一条立刻红，而红的原因正是账本里那句话。
    r2 = quota_submit(1)
    check("★ F14：上限 1 时第二个提交被拒（排队中的也算占着位置）",
          (not r2.get("ok")) and (r2.get("error") or {}).get("kind") == "quota_active",
          str(r2))
    check("★ 而它报的不是 quota_pending —— 那个 kind 已经不存在了",
          (r2.get("error") or {}).get("kind") != "quota_pending", str(r2))
    check("★ 拒绝的话里说得出「几个」与「上限几」",
          "1" in ((r2.get("error") or {}).get("detail") or "")
          and "占着位置" in ((r2.get("error") or {}).get("detail") or ""),
          str((r2.get("error") or {}).get("detail")))

    r3 = quota_submit(2)
    check("上限 2 时第二个提交放行（这一条挡住「合并 = 恒等于 1」那种实现）",
          r3.get("ok"), str(r3))
    r4 = quota_submit(2)
    # ★ 判据必须是**那个 kind**，不能只判 `not ok` —— 上面那些提交里任何一条
    #   因为别的原因失败（账户、分区）都会让"不 ok"成立，于是一条假绿。
    check("上限 2 时第三个提交被拒（且拒绝的原因是配额）",
          (r4.get("error") or {}).get("kind") == "quota_active", str(r4))

    # ★ `op_doctor` **不许**跟着合并：它拿 active_sessions 去和 nft 规则数比，
    #   而规则只属于 ACL_STATES 那些会话。并进去的话，只要有人排着队，
    #   体检就会报「规则数与会话数不一致」—— 指向一个不存在的问题。
    # ★ 取字段**全走 `.get`**。这一节每一条断言的前提都是"上面某一条成立"，而变异
    #   验证时那个前提**就是不成立的** —— 缺键时抛 `KeyError` 会让脚本**崩掉**，
    #   于是它后面一条都不跑，而"崩掉"与"一条都不红"在输出上长得一模一样（这个
    #   仓库在这上面栽过三次，见第 18 节 `_Captured` 的那段说明）。给 None 则让
    #   断言**红掉**，那才是它们该做的事。
    try:
        _q_doc = (d.op_doctor(UID) or {}).get("data") or {}
    except Exception as _qe:                                 # noqa: BLE001
        _q_doc = {"_error": repr(_qe)}
    _q_acl = len(d.store.by_state(mod.ACL_STATES))
    _q_occ = d.store.count_occupying(UID)
    check("★ op_doctor 的 active_sessions 不把排队中的算进去（否则体检会假报警）",
          _q_doc.get("active_sessions") == _q_acl and _q_acl < _q_occ,
          "doctor=%r acl=%d occupying=%d" % (_q_doc.get("active_sessions"),
                                             _q_acl, _q_occ))

    cfg.max_sessions_per_user = _q_limit0
    check("配置里不写这个键时用缺省值 1（缺省在安全侧）",
          _q_limit0 == mod.DEFAULT_MAX_SESSIONS_PER_USER == 1,
          str(_q_limit0))
    check("写 3 是合法的（自检无错误）",
          mod.Config(write_conf("cluster_cidr = 192.0.2.0/24\n"
                                "max_sessions_per_user = 3\n",
                                "quota-ok.conf")).validate() == [])
    check("而旧名字不在白名单里 —— 那条「老配置被拒」的用例仍然守着",
          "max_active_per_user" not in mod.GLOBAL_KEYS
          and "max_sessions_per_user" in mod.GLOBAL_KEYS,
          str(sorted(mod.GLOBAL_KEYS)))
    _q_bad = mod.Config(write_conf("cluster_cidr = 192.0.2.0/24\n"
                                   "max_sessions_per_user = 0\n",
                                   "quota-zero.conf")).validate()
    check("★ 写 0 会被自检拦下（否则表现是「谁都开不了会话」而没人看得出根因）",
          any("max_sessions_per_user" in e for e in _q_bad), str(_q_bad))

    # ★ 「整个删掉」的可执行形式：那三个名字在守护进程源码里必须零命中。
    #   留着任何一处，下一个人就会以为那条路还在。
    with open(mod.__file__, encoding="utf-8") as _f:
        _q_src = _f.read()
    for _dead in ("count_pending", "MAX_PENDING_PER_USER", "quota_pending",
                  "max_pending_per_user"):
        check("★ 守护进程里不再有 %s" % _dead,
              _q_src.count(_dead) == 0, "出现 %d 次" % _q_src.count(_dead))

    # ── 24. 作业状态：只有真终态才释放 ───────────────────────────────────────
    #
    # 这一节测的是**两条轴的相交处**：会话状态（ST_*，我们自己的）与 Slurm 的
    # 作业状态（集群的）。判定规则只有一条 —— 真终态才释放，其余一律保留。
    #
    # ★ 这一整条链路此前**零覆盖**：`phase` 这个词在本文件里一次都没出现过，
    #   `tick()` 一次都没被调用过。四个释放原因（job_gone / job_<状态> /
    #   orphaned / goodbye）、确认阈值、PENDING 保留、"非 RUNNING 就释放" ——
    #   全都没有用例。于是"REQUEUED 被当成作业结束"这件事没有任何东西挡着。
    print("\n── 24. 作业状态（非终态一律保留）──")

    # 两张表**在这里独立列一遍**，不从被测模块里抄。抄过来的话，
    # "把某个真终态从集合里删掉"这种变异会让表与集合一起变，用例永远是绿的。
    #
    # 依据是 Slurm 的 `is_job_terminal_state()`（src/common/job_state.c），
    # 不是 manpage —— manpage 只列状态码，不写"算不算结束"。
    # 非终态这一张的名字取自 `man squeue` 的 JOB STATE CODES 一节（本机 23.11.4），
    # 加上源码/更新版本认得而本机 manpage 还没列的那一个（POWER_UP_NODE）。
    # ★ 多列一个不存在的状态是无害的 —— 它验的是"这个函数对任何非终态都不释放"，
    #   而漏测一个真的会让一条路径没有人守。
    _NONTERMINAL = [
        # 排队
        "PENDING", "CONFIGURING", "REQUEUE_HOLD", "REQUEUE_FED", "POWER_UP_NODE",
        "RESV_DEL_HOLD",
        # 在跑
        "RUNNING", "RESIZING", "SIGNALING", "STAGE_OUT", "COMPLETING",
        # 暂停
        "SUSPENDED", "STOPPED",
        # 会回来
        "REQUEUED", "SPECIAL_EXIT",
    ]
    _TERMINAL = [
        "COMPLETED", "CANCELLED", "FAILED", "NODE_FAIL", "BOOT_FAIL", "DEADLINE",
        "OUT_OF_MEMORY", "LAUNCH_FAILED", "REVOKED",
    ]
    # ★ 这两个是**有条件**的终态，判据是 `Requeue=`。把它们当无条件终态，
    #   症状是"被抢占的作业几秒后自己回来了，而防护已经拆了"。
    _CONDITIONAL = ["PREEMPTED", "TIMEOUT"]

    for _st in _NONTERMINAL:
        check("非终态 %s ⇒ 不释放" % _st,
              mod.job_is_terminal({"JobState": _st, "Requeue": "0"}) is False)
    for _st in _TERMINAL:
        check("真终态 %s ⇒ 释放" % _st,
              mod.job_is_terminal({"JobState": _st, "Requeue": "1"}) is True)
    for _st in _CONDITIONAL:
        check("★ %s 且 Requeue=1 ⇒ **不**释放（作业会自己回来）" % _st,
              mod.job_is_terminal({"JobState": _st, "Requeue": "1"}) is False)
        check("★ %s 且 Requeue=0 ⇒ 释放" % _st,
              mod.job_is_terminal({"JobState": _st, "Requeue": "0"}) is True)
        # 字段缺失时缺省落在保留侧 —— 与整个函数的缺省一致。
        check("★ %s 但拿不到 Requeue ⇒ 不释放（缺省在安全侧）" % _st,
              mod.job_is_terminal({"JobState": _st}) is False)
    # ★ 守护进程不认识的 Slurm 状态。Slurm 加一个新状态时，这里必须是"保留" ——
    #   判成释放就等于"集群升级一次，所有人的防护被拆一遍"。
    check("★ 没见过的 Slurm 状态 ⇒ 保留（默认在安全侧，不是释放）",
          mod.job_is_terminal({"JobState": "SOME_FUTURE_STATE"}) is False)
    check("拿不到状态（空 / None / 没有这个键）⇒ 保留",
          mod.job_is_terminal({}) is False
          and mod.job_is_terminal({"JobState": ""}) is False
          and mod.job_is_terminal(None) is False)
    check("★ 状态名大小写不敏感（Slurm 给的是大写，但判据不该靠它）",
          mod.job_is_terminal({"JobState": "completed"}) is True
          and mod.job_is_terminal({"JobState": " pending "}) is False)

    # ── 24.1 `parse_slurm_uid`：两种真形态 ──────────────────────────────────
    #
    # ★ 这条缺陷是**在真集群上实测出来的**，而测试桩当年喂的是纯数字，
    #   所以用例一直绿。桩改成真形状之后这条才有意义。
    check("UserId 的纯数字形态", mod.parse_slurm_uid("2002") == 2002)
    check("★★ UserId 的 name(uid) 形态 —— 本机 `scontrol show job -o` 给的就是这样",
          mod.parse_slurm_uid("litao(1019)") == 1019)
    check("★ 认不出来时返回 None，**不是** -1（-1 是合法整数，会被读成"
          "「确认过不是这个人」）",
          mod.parse_slurm_uid("(null)") is None
          and mod.parse_slurm_uid("") is None
          and mod.parse_slurm_uid(None) is None
          and mod.parse_slurm_uid("litao") is None)
    check("★ 认不出来的那些**都不等于**任何一个真 uid",
          all(mod.parse_slurm_uid(_v) != -1
              for _v in ("(null)", "", None, "litao")))

    # ── 24.2 跑**一整个 tick**：所有状态一次喂进去 ───────────────────────────
    #
    # 一次 tick、一次遍历，就能同时验两件事：非终态的一个都没少，终态的一个都没留。
    # 分开跑的话，"遍历到一半 return"这类缺陷会漏掉 —— 而它恰恰是最可能的形态。
    class _RecNft(object):
        """真的记账的 nft 替身：规则集合能加能删，删了什么记下来。"""

        def __init__(self):
            self.rules = {}
            self.removed = []

        def ensure(self):
            return True

        def session_rules(self):
            return dict(self.rules)

        # ★ 真 `Nft.comment_for` 是 staticmethod，替身必须一样 —— 写成普通方法
        #   会让它多吃一个 self，而报错是 `takes 3 positional arguments but 4 were
        #   given`，一句与"注释格式"毫无关系的话。
        comment_for = staticmethod(mod.Nft.comment_for)

        def del_by_comment(self, c):
            if c in self.rules:
                del self.rules[c]
                self.removed.append(c)
                return True
            return False

        def add_session_rule(self, node_ip, port, uid, job_id):
            c = mod.Nft.comment_for(uid, job_id, port)
            self.rules[c] = (node_ip, port)
            return True, c

    class _JobSlurm(object):
        """可以喂任意 `JobState` / `Requeue` 的桩，按 job_id 分辨。

        ★ 字段**照抄真形状**（含 `UserId=litao(1019)` 那种带括号的写法）：
          喂理想化的字段正是 UserId 那条缺陷藏了这么久的原因。
        """
        JOB_OK = mod.Slurm.JOB_OK
        JOB_MISSING = mod.Slurm.JOB_MISSING
        JOB_UNKNOWN = mod.Slurm.JOB_UNKNOWN

        def __init__(self):
            self.jobs = {}          # job_id -> dict or None(missing)
            self.calls = []

        def job_state(self, jid):
            self.calls.append(jid)
            j = self.jobs.get(int(jid), "absent")
            if j == "absent":
                return self.JOB_MISSING, None
            if j is None:
                return self.JOB_UNKNOWN, None
            return self.JOB_OK, dict(j)

        def show_job(self, jid):
            j = self.jobs.get(int(jid), "absent")
            return dict(j) if isinstance(j, dict) else None

        def expand_node(self, _n):
            return "node01"

        def node_ip(self, _n):
            return "192.0.2.11"

        def renew(self, *_a, **_k):
            return True, ""

        def cancel(self, *_a, **_k):
            return True, ""

    _js_uid = UID
    _js_nft, _js_slurm = _RecNft(), _JobSlurm()
    _js_clock = [1700000000]
    _js_events = []
    _real_nft, _real_slurm = d.nft, d.slurm
    _real_now, _real_audit = mod.now_ts, d.audit
    _real_enroll = (d.try_enroll, d.refresh_enrollment, d.maybe_renew)
    # 这一节要跑**完整 tick**，而 tick 里每一条对账都会写一行日志（补齐规则、
    # 在跑的作业在干什么……）。这里要断言的事情全部走 `d.audit` 的记录器与数据库，
    # 一行日志都不靠 —— 关掉它们只是为了让输出里剩下的全是断言。
    _real_level = mod.log.level
    mod.log.setLevel(50)                       # CRITICAL
    _js_calls = []
    d.nft, d.slurm = _js_nft, _js_slurm
    mod.now_ts = lambda: _js_clock[0]
    d.audit = lambda ev, **kw: _js_events.append(dict(kw, event=ev))
    d.try_enroll = lambda s, j: _js_calls.append(("enroll", s["session_id"]))
    d.refresh_enrollment = lambda s, j: _js_calls.append(("refresh", s["session_id"]))
    d.maybe_renew = lambda s, j: _js_calls.append(("renew", s["session_id"]))
    try:
        d.store.close()
        d.store = mod.Store(os.path.join(tmpdir, "jobstate.db"))
        _js_want = {}                 # session_id -> 期望最终还在不在
        _jid = 8000
        for _st in _NONTERMINAL:
            _jid += 1
            _sid = "js-%s" % _st.lower()
            d.store.insert(session_id=_sid, uid=_js_uid, user="alice",
                           job_id=_jid, partition="A6000", account="acct",
                           cpus=2, mem="8G", requested_time="1:00:00",
                           state=mod.ST_ENROLLED, node="node01",
                           node_ip="192.0.2.11", service_port=55000 + (_jid % 100),
                           candidates="55000", created_at=_js_clock[0],
                           enrolled_at=_js_clock[0],
                           last_hb_socket=_js_clock[0], trust="recovered")
            # Requeue=1 是集群上最常见的取值（见真机输出），所以非终态一律用它 ——
            # 只有它才能把"条件终态被当成无条件终态"这件事照出来。
            _js_slurm.jobs[_jid] = {"JobState": _st, "Requeue": "1",
                                    "UserId": "alice(%d)" % _js_uid}
            _js_want[_sid] = True
        for _st in _TERMINAL:
            _jid += 1
            _sid = "js-%s" % _st.lower()
            d.store.insert(session_id=_sid, uid=_js_uid, user="alice",
                           job_id=_jid, partition="A6000", account="acct",
                           cpus=2, mem="8G", requested_time="1:00:00",
                           state=mod.ST_ENROLLED, node="node01",
                           node_ip="192.0.2.11", service_port=55000 + (_jid % 100),
                           candidates="55000", created_at=_js_clock[0],
                           enrolled_at=_js_clock[0],
                           last_hb_socket=_js_clock[0], trust="recovered")
            _js_slurm.jobs[_jid] = {"JobState": _st, "Requeue": "0",
                                    "UserId": "alice(%d)" % _js_uid}
            _js_want[_sid] = False
        for _st in _CONDITIONAL:
            _jid += 1
            _sid = "js-%s" % _st.lower()
            d.store.insert(session_id=_sid, uid=_js_uid, user="alice",
                           job_id=_jid, partition="A6000", account="acct",
                           cpus=2, mem="8G", requested_time="1:00:00",
                           state=mod.ST_ENROLLED, node="node01",
                           node_ip="192.0.2.11", service_port=55000 + (_jid % 100),
                           candidates="55000", created_at=_js_clock[0],
                           enrolled_at=_js_clock[0],
                           last_hb_socket=_js_clock[0], trust="recovered")
            _js_slurm.jobs[_jid] = {"JobState": _st, "Requeue": "1",
                                    "UserId": "alice(%d)" % _js_uid}
            _js_want[_sid] = True       # ★ Requeue=1 ⇒ 会回来 ⇒ 保留

        _js_total = len(_js_want)
        check("夹具真的造了一堆会话（否则下面全是空断言）",
              _js_total == len(_NONTERMINAL) + len(_TERMINAL) + len(_CONDITIONAL)
              and _js_total > 20, str(_js_total))

        d.tick()

        _js_alive = {s["session_id"]: s["state"]
                     for s in d.store.by_state(
                         (mod.ST_SUBMITTED, mod.ST_ENROLLED, mod.ST_SUSPECT,
                          mod.ST_ORPHANED))}
        # ★ 判据用**数据库里那一行的状态**，不是"我们记下来的审计事件"：
        #   审计是"它说了什么"，状态是"它做了什么"，两者都要，但不能互相顶替。
        _js_left = {s["session_id"] for s in d.store.by_state((mod.ST_RELEASED,))}
        for _st in _NONTERMINAL:
            _sid = "js-%s" % _st.lower()
            check("★ tick 之后 %s 的会话**还在**，且没被标成释放" % _st,
                  _js_alive.get(_sid) == mod.ST_ENROLLED and _sid not in _js_left,
                  "state=%r released=%s" % (_js_alive.get(_sid), _sid in _js_left))
        for _st in _TERMINAL:
            _sid = "js-%s" % _st.lower()
            check("%s ⇒ 释放，且原因是 job_%s" % (_st, _st.lower()),
                  _sid in _js_left, "state=%r" % _js_alive.get(_sid))
            _n = [e for e in _js_events if e.get("event") == "releasing"
                  and e.get("session") == _sid]
            check("   %s 的释放原因写的是那个状态名" % _st,
                  len(_n) == 1 and _n[0].get("reason") == "job_%s" % _st.lower(),
                  str(_n))

        # ★ 规则也一样：非终态的规则一条都不许少。
        #   只判"会话还在"是不够的 —— 防护是规则，不是数据库那一行。
        _js_rules = set(_js_nft.rules)
        _missing_rules = []
        for _st in _NONTERMINAL + _CONDITIONAL:
            _sid = "js-%s" % _st.lower()
            _row = d.store.get(_sid)
            if _row and _row["node_ip"]:
                _c = mod.Nft.comment_for(_js_uid, _row["job_id"], _row["service_port"])
                if _c not in _js_rules:
                    _missing_rules.append(_st)
        check("★★ 非终态的 nft 规则**一条都没少**（防护是规则，不是数据库那一行）",
              _missing_rules == [], str(_missing_rules))
        _js_removed_terminal = all(
            mod.Nft.comment_for(_js_uid, d.store.get("js-%s" % _st.lower())["job_id"],
                                d.store.get("js-%s" % _st.lower())["service_port"])
            in _js_nft.removed for _st in _TERMINAL)
        check("终态的规则都删掉了", _js_removed_terminal, str(sorted(_js_nft.removed)))

        # ── 24.3 RUNNING 走原来的登记 / 续期，一步都没变 ────────────────────
        _js_calls[:] = []
        _js_slurm.jobs[9101] = {"JobState": "RUNNING", "Requeue": "0",
                                "UserId": "alice(%d)" % _js_uid}
        d.store.insert(session_id="js-run-sub", uid=_js_uid, user="alice",
                       job_id=9101, partition="A6000", account="acct",
                       cpus=2, mem="8G", requested_time="1:00:00",
                       state=mod.ST_SUBMITTED, node="node01",
                       node_ip="192.0.2.11", service_port=55401,
                       candidates="55401", created_at=_js_clock[0],
                       submitted_at=_js_clock[0], trust="owned")
        _js_slurm.jobs[9102] = {"JobState": "RUNNING", "Requeue": "0",
                                "UserId": "alice(%d)" % _js_uid}
        d.store.insert(session_id="js-run-enr", uid=_js_uid, user="alice",
                       job_id=9102, partition="A6000", account="acct",
                       cpus=2, mem="8G", requested_time="1:00:00",
                       state=mod.ST_ENROLLED, node="node01",
                       node_ip="192.0.2.11", service_port=55402,
                       candidates="55402", created_at=_js_clock[0],
                       enrolled_at=_js_clock[0], last_hb_socket=_js_clock[0],
                       trust="owned")
        d.phase_running()
        check("RUNNING 且未登记 ⇒ 走 try_enroll（与从前一样）",
              ("enroll", "js-run-sub") in _js_calls, str(_js_calls))
        check("RUNNING 且已登记 ⇒ 走 refresh_enrollment + maybe_renew（与从前一样）",
              ("refresh", "js-run-enr") in _js_calls
              and ("renew", "js-run-enr") in _js_calls, str(_js_calls))
        # ★ 判据用 `job_stuck`：只有"非终态但不在 RUNNING"那条路会往里记。
        #   RUNNING 掉进去的话，它就会**保留但永远不推进**（不登记、不续期）——
        #   而那是个静默故障：作业在跑，ACL 没装上，续期也没了。
        check("★★ RUNNING 不会掉进「保留但不推进」那条路（进去就不登记也不续期了）",
              "js-run-sub" not in d.job_stuck and "js-run-enr" not in d.job_stuck,
              str(sorted(d.job_stuck)))

        # ── 24.4 查不到 / 查不了：两条路都不许碰在跑的会话 ─────────────────
        _js_slurm.jobs[9201] = None            # JOB_UNKNOWN
        d.store.insert(session_id="js-unknown", uid=_js_uid, user="alice",
                       job_id=9201, partition="A6000", account="acct",
                       cpus=2, mem="8G", requested_time="1:00:00",
                       state=mod.ST_ENROLLED, node="node01",
                       node_ip="192.0.2.11", service_port=55403,
                       candidates="55403", created_at=_js_clock[0],
                       enrolled_at=_js_clock[0], last_hb_socket=_js_clock[0],
                       trust="recovered")
        _js_slurm.jobs.pop(9301, None)         # JOB_MISSING
        d.store.insert(session_id="js-missing", uid=_js_uid, user="alice",
                       job_id=9301, partition="A6000", account="acct",
                       cpus=2, mem="8G", requested_time="1:00:00",
                       state=mod.ST_ENROLLED, node="node01",
                       node_ip="192.0.2.11", service_port=55404,
                       candidates="55404", created_at=_js_clock[0],
                       enrolled_at=_js_clock[0], last_hb_socket=_js_clock[0],
                       trust="recovered")
        for _i in range(1, cfg.job_missing_confirm_ticks):
            d.phase_running()
            check("★ 查不到第 %d 次（阈值 %d）⇒ 一个字都不许动"
                  % (_i, cfg.job_missing_confirm_ticks),
                  d.store.get("js-missing")["state"] == mod.ST_ENROLLED
                  and d.store.get("js-unknown")["state"] == mod.ST_ENROLLED,
                  str(d.store.get("js-missing")["state"]))
        d.phase_running()
        check("★ 查不到达到阈值 ⇒ 释放（这一条挡住「干脆永不释放」那种假保守）",
              d.store.get("js-missing")["state"] == mod.ST_RELEASING,
              str(d.store.get("js-missing")["state"]))
        check("★★ 同一次里「查不了」的那个**仍然没被动** —— 一次命令失败绝不能"
              "拆在跑的作业（这条路径上最贵的那个误判）",
              d.store.get("js-unknown")["state"] == mod.ST_ENROLLED,
              str(d.store.get("js-unknown")["state"]))

        # ── 24.5 非终态停太久：提醒，但**不释放** ─────────────────────────
        _js_events[:] = []
        _js_stuck_ticks = 0
        _js_clock[0] += cfg.stuck_job_seconds + 1
        for _st in _NONTERMINAL:
            d.store.update("js-%s" % _st.lower(), state=mod.ST_ENROLLED)
        d.tick()
        _js_stuck_ev = [e for e in _js_events if e.get("event") == "job_stuck"]
        check("★ 非终态停太久 ⇒ 有 job_stuck 审计（会说话，不是静默等待）",
              len(_js_stuck_ev) >= 1, str(len(_js_stuck_ev)))
        check("★★ 而它**一个会话都没有释放**（释放是不可逆的那一步，要由人来点）",
              all(d.store.get("js-%s" % _st.lower())["state"] == mod.ST_ENROLLED
                  for _st in _NONTERMINAL
                  if d.store.get("js-%s" % _st.lower())),
              str([(_st, d.store.get("js-%s" % _st.lower())["state"])
                   for _st in _NONTERMINAL
                   if d.store.get("js-%s" % _st.lower())][:4]))
        check("★ 提醒不写进 note 列（那一列有主人：释放原因 / renew_exhausted）",
              all(d.store.get("js-%s" % _st.lower())["note"] is None
                  for _st in _NONTERMINAL
                  if d.store.get("js-%s" % _st.lower())),
              str([d.store.get("js-%s" % _st.lower())["note"]
                   for _st in _NONTERMINAL][:4]))

        # ── 24.6 recover_from_rules：真形状的 UserId 必须能恢复 ────────────
        #
        # ★ 这条用例**此前是红的**（而没有人知道）：桩喂纯数字 UserId，
        #   而真集群给的是 `name(uid)`，于是 int() 抛 ValueError、函数静默跳过、
        #   一条都恢复不出来。它自己的 docstring 写着后果：DB 一丢，
        #   reconcile() 会把在跑的作业的规则全当成孤儿删掉。
        _rv_uid = _js_uid
        _rv_job = 97001
        _rv_comment = mod.Nft.comment_for(_rv_uid, _rv_job, 55777)
        _rv_nft = _RecNft()
        _rv_nft.rules[_rv_comment] = ("192.0.2.11", 55777)
        _rv_slurm = _JobSlurm()
        _rv_slurm.jobs[_rv_job] = {"JobState": "RUNNING", "Requeue": "0",
                                   "UserId": "alice(%d)" % _rv_uid,
                                   "NodeList": "node01", "Partition": "A6000",
                                   "Account": "acct", "TimeLimit": "1:00:00"}
        d.nft, d.slurm = _rv_nft, _rv_slurm
        _rv_n = d.recover_from_rules()
        _rv_rows = [s for s in d.store.by_state(mod.ACL_STATES)
                    if s["job_id"] == _rv_job]
        check("★★ UserId 是 `name(uid)` 形式时 recover_from_rules **真的恢复出一行**"
              "（改回 int() 这条立刻红）",
              _rv_n == 1 and len(_rv_rows) == 1,
              "n=%s rows=%s" % (_rv_n, len(_rv_rows)))
        # 反向：属主不是他 ⇒ 不许恢复（否则任何用户都能凭一条规则认领别人的作业）
        _rv_slurm.jobs[97002] = {"JobState": "RUNNING", "Requeue": "0",
                                 "UserId": "bob(%d)" % (_rv_uid + 1),
                                 "NodeList": "node01", "Partition": "A6000",
                                 "Account": "acct", "TimeLimit": "1:00:00"}
        _rv_nft.rules[mod.Nft.comment_for(_rv_uid, 97002, 55778)] = ("192.0.2.11", 55778)
        check("★ 作业属主不是这个 uid ⇒ 不恢复",
              d.recover_from_rules() == 0,
              str([s["job_id"] for s in d.store.by_state(mod.ST_ENROLLED)]))
        # 反向：UserId 认不出来 ⇒ 不恢复（**也**不能认领）
        _rv_slurm.jobs[97003] = {"JobState": "RUNNING", "Requeue": "0",
                                 "UserId": "(null)",
                                 "NodeList": "node01", "Partition": "A6000",
                                 "Account": "acct", "TimeLimit": "1:00:00"}
        _rv_nft.rules[mod.Nft.comment_for(_rv_uid, 97003, 55779)] = ("192.0.2.11", 55779)
        check("★ UserId 认不出来 ⇒ 不恢复（认不出来 ≠ 是我的）",
              d.recover_from_rules() == 0,
              str([s["job_id"] for s in d.store.by_state(mod.ST_ENROLLED)]))

    finally:
        d.nft, d.slurm = _real_nft, _real_slurm
        mod.now_ts = _real_now
        d.audit = _real_audit
        mod.log.setLevel(_real_level)
        (d.try_enroll, d.refresh_enrollment, d.maybe_renew) = _real_enroll

    # ── 24.7 job_state 的字段表：拿**真机输出**钉住 ─────────────────────────
    #
    # 这一节的理由是两条真实的教训：
    #
    #   ① `RestartCnt` 是个**死键** —— Slurm 输出里那一项的真名是 `Restarts=`，
    #      于是那条正则从来没命中过任何东西。没人发现，因为"解析不到"和
    #      "解析到了但没人读"在代码里长得一模一样（都是 `d` 里少一个键）。
    #   ② `StartTime` / `JobName` 解析了但**零消费者**。它们不是错误，是死重量：
    #      让下一个人以为有人在读。
    #
    # ★ 判据是**解析结果恰好是哪些键**，不是"源码里出现过哪个字符串" ——
    #   后者会被注释里的名字骗过去（第一版就是这么写的，两条断言全红在注释上）。
    # 两行都是真机 `scontrol show job <id> -o` 的形状（站点私有值换成通用前缀）。
    # ★ 两行**都要**：`NodeList=` 在排队时是**空的**，而那个正则要求至少一个非空白
    #   字符 —— 于是排队中的作业**根本不会有 NodeList 这个键**。这是真的，
    #   要钉住它，而不是拿一行"字段都填满"的理想输出把这件事盖掉。
    _JS_LINE_PENDING = (
        "JobId=5746 JobName=some_job UserId=alice(1234) GroupId=alice(1234) "
        "MCS_label=N/A Priority=0 Nice=0 Account=myaccount QOS=normal "
        "JobState=PENDING Reason=JobHeldUser Dependency=afterok:5705_*(unfulfilled) "
        "Requeue=1 Restarts=0 BatchFlag=1 Reboot=0 ExitCode=0:0 RunTime=00:00:00 "
        "TimeLimit=01:00:00 TimeMin=N/A SubmitTime=2026-09-17T16:44:37 "
        "EligibleTime=Unknown AccrueTime=Unknown StartTime=Unknown EndTime=Unknown "
        "Deadline=N/A Partition=A6000 NodeList= NumNodes=1-1 NumCPUs=2 NumTasks=1 "
        "Command=/opt/slurmate/jobs/run.sbatch WorkDir=/home/alice "
    )
    _JS_LINE_RUNNING = (
        "JobId=5747 JobName=some_job UserId=alice(1234) GroupId=alice(1234) "
        "MCS_label=N/A Priority=0 Nice=0 Account=myaccount QOS=normal "
        "JobState=RUNNING Reason=None Dependency=(null) "
        "Requeue=0 Restarts=2 BatchFlag=1 Reboot=0 ExitCode=0:0 RunTime=00:12:34 "
        "TimeLimit=01:00:00 TimeMin=N/A SubmitTime=2026-09-17T16:44:37 "
        "EligibleTime=2026-09-17T16:44:38 AccrueTime=2026-09-17T16:44:38 "
        "StartTime=2026-09-17T16:44:39 EndTime=2026-09-17T17:44:39 "
        "Deadline=N/A Partition=A6000 NodeList=node01 NumNodes=1-1 NumCPUs=2 "
        "Command=/opt/slurmate/jobs/run.sbatch WorkDir=/home/alice "
    )
    check("夹具用的是**真形状**的 scontrol 输出（真机那两行，去掉站点私有值）",
          "UserId=alice(1234)" in _JS_LINE_PENDING
          and "Requeue=0 Restarts=2" in _JS_LINE_RUNNING)

    def _js_parse(line):
        """把一行输出喂给真的 job_state()，返回它解析出来的 dict。"""
        def _raw(argv, timeout=10, check=False):
            if "show job" in " ".join(str(a) for a in argv):
                return 0, line, ""
            return slurm_stub(argv, timeout, check)

        # ★ 结果必须在 with_stub **里面**取出来：桩只在那个上下文里生效，在外面
        #   再调一次拿到的是宿主机的真命令（这里是"查不到"，于是判 JOB_UNKNOWN）。
        _st, _d = with_stub(mod, _raw, lambda: mod.Slurm(cfg).job_state(5746))
        return _st, _d

    _js_status, _js_run = _js_parse(_JS_LINE_RUNNING)
    check("真形状那一行解析成功",
          _js_status == mod.Slurm.JOB_OK and bool(_js_run),
          "%r / %r" % (_js_status, _js_run))
    check("★ 解析出来的恰好是这 11 个键 —— 多一个就是又冒出一个没人读的字段，"
          "少一个就是判定拿不到输入",
          set(_js_run) == {"JobState", "NodeList", "UserId", "TimeLimit", "EndTime",
                           "Partition", "Account", "Reason", "ExitCode", "Requeue",
                           "Restarts"},
          str(sorted(_js_run)))
    check("★★ 死键 RestartCnt 与零消费者的 StartTime / JobName 都不在结果里",
          not ({"RestartCnt", "StartTime", "JobName"} & set(_js_run)),
          str(sorted(set(_js_run) & {"RestartCnt", "StartTime", "JobName"})))
    check("★ 真名 Restarts 解析出来了，值是 2（重启过 —— 界面要能说出这件事）",
          _js_run.get("Restarts") == "2", repr(_js_run.get("Restarts")))
    check("★ ExitCode 拿到了", _js_run.get("ExitCode") == "0:0",
          repr(_js_run.get("ExitCode")))
    check("★ Requeue 拿到了 —— 上面那两条条件终态的判定全靠它",
          _js_run.get("Requeue") == "0", repr(_js_run.get("Requeue")))
    check("RUNNING 且 Requeue=0 ⇒ 终态判定为假（RUNNING 永远不是终态）",
          mod.job_is_terminal(_js_run) is False, str(_js_run))

    _js_status2, _js_pend = _js_parse(_JS_LINE_PENDING)
    check("排队那一行也解析成功",
          _js_status2 == mod.Slurm.JOB_OK and bool(_js_pend), str(_js_status2))
    check("★ Reason 拿到了 —— 界面上「为什么还没跑」就是这一句",
          _js_pend.get("Reason") == "JobHeldUser", repr(_js_pend.get("Reason")))
    check("★★ 排队中 `NodeList=` 是空的 ⇒ 结果里**没有** NodeList 这个键"
          "（那条正则要求至少一个非空白字符）",
          "NodeList" not in _js_pend, str(sorted(_js_pend)))
    check("而它只少这一个键，其余照常解析",
          set(_js_run) - set(_js_pend) == {"NodeList"}, str(sorted(_js_pend)))
    check("★★ 这一行被判成「非终态」—— Reason=JobHeldUser 的作业**永远不会开始**，"
          "但它还在队列里 ⇒ 保留（这正是从前被当成「结束」的那一类）",
          mod.job_is_terminal(_js_pend) is False, str(_js_pend))

    # ── 24.8 会话视图：把这三样交给客户端 ───────────────────────────────────
    #
    # ★ 判定在守护进程这边，**说话**在客户端那边。所以这里传的是 Slurm 的原话
    #   （`JobHeldUser` / `0:0` / `2`），译成中文是客户端的事。
    #   唯一的例外是 `Reason=None` —— 那是 Slurm 的"没有原因"，原样发出去客户端
    #   会把它渲染成字面的 "None"，所以它在**用户可见的那一层**必须消失。
    _js_row = d.store.get("js-pending")
    check("夹具：拿得到一行活着的会话（否则下面几条是空断言）",
          bool(_js_row) and _js_row["state"] == mod.ST_ENROLLED, str(_js_row))

    def _view_with(line):
        def _raw(argv, timeout=10, check=False):
            if "show job" in " ".join(str(a) for a in argv):
                return 0, line, ""
            return slurm_stub(argv, timeout, check)

        _real = d.slurm
        d.slurm = mod.Slurm(cfg)
        try:
            return with_stub(mod, _raw,
                             lambda: d.session_view(_js_row, with_secret=False))
        finally:
            d.slurm = _real

    _v_pend = _view_with(_JS_LINE_PENDING)
    _v_run = _view_with(_JS_LINE_RUNNING)
    check("★ 排队原因传给了客户端 —— 那是用户最想知道的那一句话",
          _v_pend.get("job_reason") == "JobHeldUser", repr(_v_pend.get("job_reason")))
    check("★ 而 `Reason=None`（没有原因）**不出现在**视图里",
          "job_reason" not in _v_run, repr(_v_run.get("job_reason")))
    check("★ 退出码与重启次数**原样**传出去（该不该显示是客户端的判断）",
          _v_run.get("job_exit_code") == "0:0" and _v_run.get("job_restarts") == "2",
          "%r / %r" % (_v_run.get("job_exit_code"), _v_run.get("job_restarts")))
    # ★★ 发出去的是**判定**，不是 `Requeue=` 那个原始字段：判"终不终态"的规则
    #    （含 PREEMPTED / TIMEOUT 的附加条件）只有守护进程这一份。
    #    把 `Requeue` 发过去等于让客户端再实现一遍 —— 而"一个判据两处实现会漂"，
    #    漂的方向是界面说"已结束（被抢占）"而作业几分钟后又回来了。
    check("★★ 会话视图带出的是判定 job_terminal，**不是**原始字段 Requeue",
          _v_run.get("job_terminal") is False and "Requeue" not in repr(_v_run)
          and "requeue" not in repr(_v_run),
          "job_terminal=%r / 视图里那些键=%s"
          % (_v_run.get("job_terminal"), sorted(_v_run)))
    check("★ 排队中那一行同样带判定（false = 还没结束）",
          _v_pend.get("job_terminal") is False, repr(_v_pend.get("job_terminal")))

    # ── 25. GRES：一个结构化描述符，和一个拼法 ───────────────────────────────
    #
    # 这一节守的是**一整类**缺陷，不是一条：GRES 是**管理员自定义的**
    # （`GresTypes` + `gres.conf`），名字与型号随集群而定。从前代码里假定它只有
    # `gpu:N` 一种形状 —— 写只写 `"gpu:%d"`、读只认 `re.fullmatch(r"gpu:(\d+)")`。
    # 于是带型号的集群上界面显示"没有 GPU"而作业正占着两张 A100，**没有任何地方
    # 会报错**（那条正则不匹配就是"没有"，与"没要"长得一模一样）。
    #
    # 修法不是把正则写宽一点，而是**取消第二份表示**：描述符 `{name,type,count}`
    # 是唯一的内部表示，交给 Slurm 的那个串由 `gres_spec()` 当场拼。
    print("\n── 25. GRES（结构化描述符 + 唯一的拼法）──")

    # ── 25.1 一个拼法 ───────────────────────────────────────────────────────
    check("没型号 → 两段（`gpu:2`）",
          mod.gres_spec({"name": "gpu", "type": None, "count": 2}) == "gpu:2",
          mod.gres_spec({"name": "gpu", "type": None, "count": 2}))
    check("★ 带型号 → 三段（`gpu:a100:2`）",
          mod.gres_spec({"name": "gpu", "type": "a100", "count": 2}) == "gpu:a100:2",
          mod.gres_spec({"name": "gpu", "type": "a100", "count": 2}))
    check("★ 名字不是 gpu 照样拼得出来（GRES 是管理员自定义的）",
          mod.gres_spec({"name": "mps", "type": None, "count": 100}) == "mps:100",
          mod.gres_spec({"name": "mps", "type": None, "count": 100}))
    check("没要 GRES → None（既不是空串，也不是 gpu:0）",
          mod.gres_spec(None) is None, repr(mod.gres_spec(None)))

    # ── 25.2 拆 `Gres=` 那一格（形状照抄真机）───────────────────────────────
    check("`gpu:4` → 没型号",
          mod.parse_gres_field("gpu:4") == [{"name": "gpu", "type": None, "count": 4}],
          str(mod.parse_gres_field("gpu:4")))
    check("★ `gpu:a100:2` → 带型号",
          mod.parse_gres_field("gpu:a100:2")
          == [{"name": "gpu", "type": "a100", "count": 2}],
          str(mod.parse_gres_field("gpu:a100:2")))
    check("多个之间用逗号（一台节点上两种 GRES）",
          mod.parse_gres_field("gpu:4,mps:100")
          == [{"name": "gpu", "type": None, "count": 4},
              {"name": "mps", "type": None, "count": 100}],
          str(mod.parse_gres_field("gpu:4,mps:100")))
    check("★ 空 / `(null)` → 空列表（**不是**猜成 1 个）",
          mod.parse_gres_field("") == [] and mod.parse_gres_field("(null)") == []
          and mod.parse_gres_field("N/A") == [],
          "%r / %r" % (mod.parse_gres_field(""), mod.parse_gres_field("(null)")))
    check("★ 认不出的**那一项**跳过，不让整条作废（同一行里别的还认得）",
          mod.parse_gres_field("gpu:4,x:") == [{"name": "gpu", "type": None, "count": 4}],
          str(mod.parse_gres_field("gpu:4,x:")))
    check("★ 段数不对的也跳过（`gpu` 这种没数量的）",
          mod.parse_gres_field("gpu") == [], str(mod.parse_gres_field("gpu")))
    check("末尾那种 `(S:0-1)` 索引说明被剥掉",
          mod.parse_gres_field("gpu:2(S:0-1)")
          == [{"name": "gpu", "type": None, "count": 2}],
          str(mod.parse_gres_field("gpu:2(S:0-1)")))

    # ── 25.3 目录：从**照抄真机**的夹具算出来 ───────────────────────────────
    _real_run = mod.run_cmd
    mod.run_cmd = slurm_stub
    try:
        _cat = mod.Slurm(cfg).gres_catalog()
    finally:
        mod.run_cmd = _real_run
    check("★ 目录按分区聚合（A6000 两台各 2 张 → per_node_max 2、总 4）",
          _cat and _cat.get("A6000") == [{"name": "gpu", "type": "a100",
                                          "per_node_max": 2, "total": 4}],
          str(_cat and _cat.get("A6000")))
    check("★ 同一台节点上两种 GRES 都进目录",
          _cat and [e["name"] for e in _cat.get("RTX8000", [])] == ["gpu", "mps"],
          str(_cat and _cat.get("RTX8000")))
    check("★ 没配 GRES 的节点**不产生条目**（那一格在真机上整个不出现）",
          _cat and _cat.get("2080TI") == [{"name": "gpu", "type": None,
                                           "per_node_max": 8, "total": 8}],
          str(_cat and _cat.get("2080TI")))
    check("★ 目录里**没有**『已用』这一格（本版本的 Slurm 给不出来，就不编）",
          _cat and all("used" not in k for e in _cat.values() for k in e),
          str(_cat))
    # 缓存：ttl 之内不重复 fork（这是每个 partitions 请求都要走的路）。
    _calls = [0]

    def _counting_run(argv, timeout=10, check=False):
        _calls[0] += 1
        return slurm_stub(argv, timeout, check)

    mod.run_cmd = _counting_run
    try:
        _s = mod.Slurm(cfg)
        _s.gres_catalog()
        _s.gres_catalog()
        _s.gres_catalog()
    finally:
        mod.run_cmd = _real_run
    check("★ 目录有缓存（三次调用只 fork 一次）", _calls[0] == 1, "fork 了 %d 次" % _calls[0])

    # ── 25.4 op_partitions：每分区一份清单，而且**三态** ─────────────────────
    _part_ran = [0]

    def _part_run(argv, timeout=10, check=False):
        a = [str(x) for x in argv]
        if "show" in a and "assoc" in a:
            return 0, ("myaccount|\n" if any("Partition" in x for x in a)
                       else "myaccount\n"), ""
        _part_ran[0] += 1
        return slurm_stub(argv, timeout, check)

    _pv = with_stub(mod, _part_run, lambda: d.op_partitions(UID))
    _by_name = {p["name"]: p for p in (_pv.get("data") or {}).get("partitions", [])}
    check("分区列表仍然照常返回", _pv.get("ok") and len(_by_name) == 3, str(_pv))
    check("★ 每个分区带上它自己的 GRES 清单",
          _by_name["A6000"].get("gres")
          == [{"name": "gpu", "type": "a100", "per_node_max": 2, "total": 4}],
          str(_by_name["A6000"].get("gres")))
    check("★ 清单里带型号（`gpu:a100`）—— 不是只有一个数字",
          _by_name["A6000"]["gres"][0]["type"] == "a100",
          str(_by_name["A6000"]["gres"]))
    # ★★ 三态：查不到时那个键**整个不存在**（不是 `[]`）。
    #   `[]` 的意思是"这个分区确实没配"，而"没问到"是另一句话 ——
    #   把两者合并，界面就会替集群说一句它不知道的话。
    _real_cat2 = mod.Slurm.gres_catalog
    mod.Slurm.gres_catalog = lambda self, ttl=300: None
    try:
        _pv2 = with_stub(mod, _part_run, lambda: d.op_partitions(UID))
    finally:
        mod.Slurm.gres_catalog = _real_cat2
    _p0 = ((_pv2.get("data") or {}).get("partitions") or [{}])[0]
    check("★★ 目录查不到 ⇒ `gres` 这个键**不存在**（不是空列表）",
          _pv2.get("ok") and "gres" not in _p0, str(sorted(_p0)))

    # ── 25.5 ★★ 读回：带型号的会话在视图里是带型号的（今天红的那一条）──────
    #
    # 从前那一句是 `re.fullmatch(r"gpu:(\d+)", s["gres"])` —— 一个自己写进去的
    # `gpu:a100:2` 在这里**匹配不上**，于是 `gpus` 是 None，界面显示"没有 GPU"。
    # 缺陷的形状是"写进去的读不回来"，所以用例必须**先经过 list 那一侧**看回来。
    _v_sess = {"session_id": "s1", "job_id": None, "state": mod.ST_RESERVED,
               "partition": "A6000", "cpus": 4, "mem": "16G",
               "gres": json.dumps({"name": "gpu", "type": "a100", "count": 2}),
               "service_kind": "code-server", "service_plugin": "x@1.0.0",
               "node": None, "node_ip": None, "service_port": None,
               "created_at": 0, "enrolled_at": None, "last_hb_socket": None,
               "renew_count": 0, "requested_time": "12:00:00", "note": None,
               "auth_mode": "password", "account": "myaccount", "uid": UID}
    # ★ 一律用 `.get()` 取那一格：**别让"字段被改名"变成一次 KeyError**。
    #   变异验证时那正是被测的东西（把 `gres` 改回 `gpus`），而抛出去的异常会把
    #   整个脚本带崩 —— 崩了与"一条都不红"在输出上长得一模一样。
    _vv = d.session_view(dict(_v_sess))
    check("★★ 读回带型号的 GRES：视图里是描述符，不是 None",
          _vv.get("resources", {}).get("gres")
          == {"name": "gpu", "type": "a100", "count": 2},
          str(_vv.get("resources")))
    check("★★ 而它**不再是** `resources.gpus` 那个数字（那个字段没有了）",
          "gpus" not in (_vv.get("resources") or {}),
          str(sorted(_vv.get("resources") or {})))
    _vv2 = d.session_view(dict(_v_sess, gres=json.dumps({"name": "mps", "count": 64})))
    check("★ 名字不是 gpu 的会话照样读得回来",
          _vv2.get("resources", {}).get("gres")
          == {"name": "mps", "type": None, "count": 64},
          str(_vv2.get("resources")))
    _vv3 = d.session_view(dict(_v_sess, gres=None))
    check("没要 GRES → null（界面那一行就不说 GRES）",
          _vv3.get("resources", {}).get("gres") is None, str(_vv3.get("resources")))
    _vv4 = d.session_view(dict(_v_sess, gres="gpu:2"))
    check("库里那一格读不动 → null，**不让整个 list 变成错误**",
          _vv4.get("resources", {}).get("gres") is None
          and _vv4.get("session_id") == "s1",
          str(_vv4.get("resources")))

    # ── 25.6 ★★ 跨文件往返：CLI 拆词与守护进程拼词必须互相认得 ──────────────
    #
    # 拆词在 `cluster/slurmate`（用户敲的 `--gres gpu:a100:2`），拼词在守护进程
    # （交给 sbatch 的那个串）。两个文件不共享模块（CLI 在 <prefix>/bin、守护进程
    # 在 <prefix>/sbin），所以这一对**会漂**，而漂的表现是"CLI 收下了、服务端
    # 说不认识"或反过来。这条往返用例就是那道闸。
    _cli = load_cli()
    for _spec in ("gpu:2", "gpu:a100:2", "mps:100", "shard:fast:1"):
        _g, _e = _cli.parse_gres_spec(_spec)
        check("★ 往返：CLI 拆 %r 再拼回去还是它" % _spec,
              _e is None and mod.gres_spec(_g) == _spec,
              "%r / %s" % (_g, _e))
    check("★ CLI 拆出来的东西守护进程认（形状一致，不是各写一套）",
          all(mod.clean_gres(_cli.parse_gres_spec(s)[0])[1] is None
              for s in ("gpu:2", "gpu:a100:2", "mps:100")),
          "三种写法")
    for _bad in ("gpu", "a:b:c:d", "gpu:x"):
        _g, _e = _cli.parse_gres_spec(_bad)
        check("★ CLI 对 %r 说得出它不对（不是静默当成没要）" % _bad,
              _g is None and bool(_e), "%r / %s" % (_g, _e))
    _g, _e = _cli.parse_gres_spec("")
    check("★ 空串 = 没要（与「写错了」是两回事）",
          _g is None and _e is None, "%r / %s" % (_g, _e))

    # ── 25.7 ★ 跨语言契约：run.sbatch 读的那个变量名 ────────────────────────
    # ★ 那个写死的 GPU 上限**不许回来**。用 `ast` 查而不是 grep：这段代码里
    #   **必须**提到 `MAX_GPUS_REQUEST`（上面那段注释在解释它为什么被删掉），
    #   而 grep 分不清"提到"与"用着"—— 那正是这个仓库栽过的那种假红/假绿。
    _tree = ast.parse(io.open(DAEMON, encoding="utf-8").read())
    _refs = [n.id for n in ast.walk(_tree) if isinstance(n, ast.Name)]
    _assigned = [t.id for n in ast.walk(_tree) if isinstance(n, ast.Assign)
                 for t in n.targets if isinstance(t, ast.Name)]
    check("★★ MAX_GPUS_REQUEST 既没被赋值、也没被引用（写死的上限不许回来）",
          "MAX_GPUS_REQUEST" not in _refs and "MAX_GPUS_REQUEST" not in _assigned,
          "引用 %d 次 / 赋值 %d 次" % (_refs.count("MAX_GPUS_REQUEST"),
                                    _assigned.count("MAX_GPUS_REQUEST")))
    _sb = io.open(os.path.join(HERE, "run.sbatch"), encoding="utf-8").read()
    _daemon_src = io.open(DAEMON, encoding="utf-8").read()
    check("★ run.sbatch 读的是 SLURMATE_GRES（作业侧那一半）",
          "SLURMATE_GRES" in _sb, "run.sbatch 里没有这个名字")
    check("★★ 而旧名字 SLURMATE_GPUS 两边都不剩（改名改一半是最坏的一种）",
          "SLURMATE_GPUS" not in _sb and "SLURMATE_GPUS" not in _daemon_src,
          "run.sbatch=%s / 守护进程=%s"
          % ("SLURMATE_GPUS" in _sb, "SLURMATE_GPUS" in _daemon_src))
    check("★ 守护进程往环境里放的就是那个名字",
          '"SLURMATE_GRES"' in _daemon_src, "op_submit 的 env 里没有它")

    # ══ 26. 常驻通道 ═══════════════════════════════════════════════════════
    #
    # 这一节之前，连接那条路是**零覆盖**的：`tick()` 一次都没被调用过，
    # `handle_client` 也没有。而这一版把它从「一问一答」改成了一条状态机，
    # 于是"没测到"的东西从"一个函数"变成"整个事件循环"。
    #
    # ★ 这一节里几乎每一条都在守一个**静默**的失败：卡死、丢响应、跨用户泄漏、
    #   心跳被挤出桶导致批量 scancel。它们的共同点是**不会红任何东西** ——
    #   所以每条断言都要指出"改坏了会看到什么"。
    print("\n── 26. 常驻通道 ──")

    class _Nft(object):
        def ensure(self):
            return True

        def session_rules(self):
            return []

        def table_exists(self):
            return True

        def del_by_comment(self, _c):
            pass

        def add_session_rule(self, *_a, **_k):
            return True, ""

    class _Slurm(object):
        """最小接口：`job_state` / `show_job`，外加一个调用计数器。

        ★ 计数器是这一节的承重件：用例⑫（渲染不许放大 fork）靠它。"""
        JOB_OK = mod.Slurm.JOB_OK
        JOB_MISSING = mod.Slurm.JOB_MISSING
        JOB_UNKNOWN = mod.Slurm.JOB_UNKNOWN

        def __init__(self):
            self.calls = 0
            self.jobs = {}

        def job_state(self, jid):
            self.calls += 1
            j = self.jobs.get(str(jid))
            return (self.JOB_OK, j) if j is not None else (self.JOB_MISSING, None)

        def show_job(self, jid):
            self.calls += 1
            return self.jobs.get(str(jid))

        def expand_node(self, _n):
            return "node01"

        def node_ip(self, _n):
            return "192.0.2.11"

        def cancel(self, *_a, **_k):
            return True

    class _CfgClone(object):
        """配置的一份浅副本 —— 这一节的几个数要能调小才测得到，
        而共享的 cfg 上有别的节在用。"""
        def __init__(self, base, **kw):
            self.__dict__.update(base.__dict__)
            self.__dict__.update(kw)

    _seq = [0]

    def _mkd(**kw):
        _seq[0] += 1
        c = _CfgClone(cfg, **kw)
        c.state_dir = os.path.join(tmpdir, "stream-state")
        c.log_dir = os.path.join(tmpdir, "stream-log")
        c.audit_log = os.path.join(c.log_dir, "audit.log")
        c.db_path = os.path.join(tmpdir, "stream-%d.db" % _seq[0])
        os.makedirs(c.state_dir, exist_ok=True)
        os.makedirs(c.log_dir, exist_ok=True)
        dd = mod.Sessiond(c)
        dd.nft, dd.slurm, dd.audit_fp = _Nft(), _Slurm(), None
        # ★ 第 7 节把主 d 的 user_home 指到临时家目录；这一节的守护进程各自
        #   新建，必须也指过去 —— 否则"会话文件"那条路会去摸真实家目录。
        dd.user_home = lambda uid: home
        return dd

    class _Client(object):
        """测试端的客户端：一个 socket + 一个行缓冲。"""

        def __init__(self, sock):
            self.sock = sock
            self.buf = b""
            self.eof = False

        def send(self, obj):
            self.sock.sendall((json.dumps(obj) + "\n").encode("utf-8"))

        def raw(self, data):
            self.sock.sendall(data)

        def lines(self, timeout=0.25, max_chunks=64):
            """取走已经到达的**整行**；半行留在缓冲里。

            ★ 半行必须留下：客户端读到一半的流是这一节要测的东西之一
              （用例⑥ 逐字节读），把它当成整行会让那条用例变成假的。

            ★★ 循环**必须有上界**：订阅连接每 tick 都收到推送，每隔几十毫秒就
              来一条 —— "一直读到出现一次超时"这个终止条件**永远不会成立**，
              于是这个助手会永远转下去（实测：主线程卡在 recv 上，整个用例
              看上去像死了）。每次唤醒读多少是有限的，这个助手也一样。"""
            self.sock.settimeout(timeout)
            chunks = 0
            while chunks < max_chunks:
                try:
                    chunk = self.sock.recv(65536)
                except (socket.timeout, BlockingIOError):
                    break
                except OSError:
                    self.eof = True
                    break
                if not chunk:
                    self.eof = True
                    break
                self.buf += chunk
                chunks += 1
            parts = self.buf.split(b"\n")
            self.buf = parts.pop()
            out = []
            for p in parts:
                if p.strip():
                    out.append(json.loads(p))
            return out

        def close(self):
            try:
                self.sock.close()
            except OSError:
                pass

    def _pair(dd, uid=None, sock=None):
        a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        if sock is not None:                      # 用例② 要先把 SO_SNDBUF 调小
            b.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, sock)
        b.setblocking(False)
        conn = mod.Conn(dd.cfg, b, UID if uid is None else uid, os.getgid())
        dd.selector.register(b, conn.want_events(), conn)
        return _Client(a), conn

    def _drive(dd, rounds=4, timeout=0.0):
        """把事件循环推几轮（**不跑 run()** —— 那是个 while True）。"""
        for _ in range(rounds):
            try:
                ev = dd.selector.select(timeout)
            except InterruptedError:
                continue
            dd.handle_events(ev)
            dd.drain_pending()

    def _add(dd, sid, job_id=None, state=None, uid=None):
        dd.store.insert(session_id=sid, uid=UID if uid is None else uid,
                        user="alice", partition="A6000", account="acct",
                        cpus=2, mem="8G", requested_time="1:00:00",
                        state=state or mod.ST_ENROLLED, job_id=job_id,
                        candidates="55001", created_at=mod.now_ts())

    # ── 26.1 老客户端一字不改地继续工作（§八 第 2 步的判据）──────────────
    #
    # ★★ 这是整节的**分水岭**：它过了，`slurmate rpc` 那条路上的字节流就
    #    与从前逐字相同，而"常驻通道"是叠加在它上面的，不是替换它。
    _d = _mkd()
    _c1, _k1 = _pair(_d)
    _c1.send({"op": "ping"})
    _drive(_d)
    _r1 = _c1.lines()
    check("★★ 老客户端（不带 rid）仍然一问一答",
          len(_r1) == 1 and _r1[0].get("ok") is True
          and (_r1[0].get("data") or {}).get("pong") is True, str(_r1)[:200])
    check("★★ 而它的应答里**没有 rid** —— 线上的字节与从前逐字相同",
          bool(_r1) and "rid" not in _r1[0], str(sorted((_r1 or [{}])[0].keys())))
    check("★ 不带 rid 的请求**不会**让它变成订阅者（推送会打乱一问一答）",
          _k1.subscribed is False, "subscribed=%s" % _k1.subscribed)

    # ── 26.2 一条连接上多请求 + rid 回填（§八 第 3 步）───────────────────
    _c2, _k2 = _pair(_d)
    for i in (1, 2, 3):
        _c2.send({"op": "ping", "rid": i})
    _drive(_d)
    _r2 = _c2.lines()
    check("★ 一条连接上 3 条 ping 得到 3 条响应",
          len(_r2) == 3, "收到 %d 条：%s" % (len(_r2), str(_r2)[:200]))
    check("★★ 每一条都回填了**同一个** rid，而且按顺序",
          [r.get("rid") for r in _r2] == [1, 2, 3],
          str([r.get("rid") for r in _r2]))
    check("★ 带了 rid 的请求让这条连接成为订阅者",
          _k2.subscribed is True, "subscribed=%s" % _k2.subscribed)

    # ── 26.3 推送：只推全量、带 seq（§八 第 5 步）───────────────────────
    _d.slurm.jobs["501"] = {"JobState": "RUNNING", "UserId": UID,
                            "NodeList": "node01", "Partition": "A6000",
                            "TimeLimit": "1:00:00"}
    _add(_d, "s-a", job_id="501")
    _d.tick()
    _drive(_d)
    _p1 = _c2.lines()
    check("★ 会话变了 ⇒ 那条订阅连接收到一条推送",
          len(_p1) == 1 and _p1[0].get("push") == "sessions",
          str(_p1)[:250])
    check("★★ 推送带单调 seq，且**没有** rid（rid 是响应的判据）",
          bool(_p1) and isinstance(_p1[0].get("seq"), int)
          and "rid" not in _p1[0], str(sorted((_p1 or [{}])[0].keys())))
    check("★ 推送里的会话列表与 op_list **逐字同构**（推送就是自动化的 list）",
          bool(_p1) and _p1[0].get("sessions")
          == _d.dispatch(UID, os.getgid(), {"op": "list"})["data"]["sessions"],
          "推送里 %d 条" % len((_p1 or [{}])[0].get("sessions") or []))
    check("★★ 推送里**不含任何口令**（它走的是 list 的 with_secret=False）",
          all("auth_password" not in s
              for s in ((_p1 or [{}])[0].get("sessions") or [])),
          str((_p1 or [{}])[0].get("sessions"))[:200])
    check("★★ 没订阅的那条连接**一个字节都没多**（老客户端不受影响）",
          _c1.lines() == [], "它收到了推送")

    # ── 26.4 全量：一个 tick 里多个会话变了 ⇒ 每个连接至多一条（用例⑪）──
    _add(_d, "s-b", job_id="502")
    _add(_d, "s-c", job_id="503")
    _d.slurm.jobs["502"] = {"JobState": "PENDING", "UserId": UID}
    _d.slurm.jobs["503"] = {"JobState": "PENDING", "UserId": UID}
    _d.tick()
    _drive(_d)
    _p2 = _c2.lines()
    check("★★ 一个 tick 里三个会话变了 ⇒ 每个连接仍然**至多一条**"
          "（钉住「只推全量、不推增量」）",
          len(_p2) == 1, "收到 %d 条" % len(_p2))
    check("★ 而这一条里三个会话都在（全量自足，丢掉上一条无害）",
          bool(_p2) and len(_p2[0].get("sessions") or []) == 3,
          str([len(x.get("sessions") or []) for x in _p2]))

    # ── 26.4b 终态但还在库里的会话，推送里也要报得出作业状态 ─────────────
    #
    # ★ `phase_running` 只为**活跃**那几档查作业（`submitted` / `enrolled` /
    #   `suspect` / `orphaned`），而快照要渲染的**包括终态但还在库里的那些**
    #   （它们要留到 `released_keep`）。快照不自己补那一次查询的话，那些行在推送
    #   里**没有 job_state**，而同一行在 `list` 里有 —— 于是界面上一行会话的作业
    #   状态会忽有忽无（刷新一下有、下一帧又没了），而没有任何地方报错。
    _d.slurm.jobs["504"] = {"JobState": "COMPLETED", "UserId": UID,
                            "TimeLimit": "1:00:00"}
    _add(_d, "s-done", job_id="504", state=mod.ST_RELEASED)
    _d.tick()
    _drive(_d)
    _p3 = [m for m in _c2.lines() if m.get("push")]
    _done = None
    for _m in _p3:
        for _s in (_m.get("sessions") or []):
            if _s.get("session_id") == "s-done":
                _done = _s
    check("★★ 终态会话在推送里也报得出 job_state"
          "（phase_running 不为它查询 ⇒ 快照必须自己补一次，否则它时有时无）",
          _done is not None and _done.get("job_state") == "COMPLETED",
          str(_done)[:220])
    check("★ 而与 list 仍然逐字同构（两边说的必须是同一件事）",
          bool(_p3) and _p3[-1].get("sessions")
          == _d.dispatch(UID, os.getgid(), {"op": "list"})["data"]["sessions"],
          str(_p3)[-1:][:200])

    # ── 26.5 没有变化也按期推（用例④：把兜底实现成"有变化才发"）─────────
    _d2 = _mkd(snapshot_interval=0.0)
    _c3, _k3 = _pair(_d2)
    _c3.send({"op": "ping", "rid": 1})
    _drive(_d2)
    _c3.lines()
    for _ in range(3):
        _d2.tick()
        _drive(_d2)
    _r3 = [x for x in _c3.lines() if x.get("push")]
    check("★★ 全程**无变化**的连接也按期收到快照（三条 tick ≥ 2 条）",
          len(_r3) >= 2, "只收到 %d 条" % len(_r3))
    check("★ 而无变化时推的还是全量（不是空消息）",
          all("sessions" in x for x in _r3), str(_r3)[:200])

    # ── 26.6 seq 的缺口与 stale 对得上（用例③）─────────────────────────
    #
    # ★ 直接驱动 enqueue_push 而不是靠真实水位：要验的是**代数**，
    #   而"水位挡下第几条"由内核缓冲决定，那个数在别的机器上会变。
    _d3 = _mkd(conn_out_hard=200)
    _c4, _k4 = _pair(_d3)
    _k4.subscribed = True
    _sess = [{"session_id": "s-x"}]
    for _ in range(6):
        _d3.enqueue_push(_k4, _sess)
    check("★ 水位之上的那几条被丢掉了（stale 记着）",
          _k4.stale > 0 and _k4.seq == 6,
          "stale=%s seq=%s" % (_k4.stale, _k4.seq))
    _k4.pump()                      # 排空，让后面那条发得出去
    _d3.enqueue_push(_k4, _sess)
    _k4.pump()
    _got = _c4.lines()
    _seqs = [m.get("seq") for m in _got]
    _drop = sum((m.get("stale") or {}).get("dropped", 0) for m in _got)
    check("★★ seq 的缺口代数对得上：(末−首+1) == 条数 + Σ stale.dropped",
          bool(_seqs) and (_seqs[-1] - _seqs[0] + 1) == len(_got) + _drop,
          "seqs=%s 条数=%d dropped=%d" % (_seqs, len(_got), _drop))
    check("★★ 每个缺口都**紧邻**一条带 stale 的消息（不然客户端不知道丢过）",
          _drop == 0 or any("stale" in m for m in _got), str(_got)[:250])
    check("★ stale 里说得清缺口从哪开始",
          all(m["stale"]["from"] == m["seq"] - m["stale"]["dropped"]
              for m in _got if "stale" in m), str(_got)[:250])

    # ── 26.7 ★★★ 推送把心跳挤出桶 ⇒ 静默批量 scancel（用例①）──────────
    #
    # 这是整节最要紧的一条。桶在 dispatch 里，而 heartbeat 也在 dispatch 里；
    # 推送一旦计进桶，症状是：心跳被回 rate_limited → last_hb_socket 不更新 →
    # 300 s suspect → 1800 s **自动 scancel** —— 用户正在跑的作业被杀掉，
    # 而界面只显示"心跳发送失败，仍在重试"。
    _d4 = _mkd()
    _c5, _k5 = _pair(_d4)
    _k5.subscribed = True
    _cap = _d4.cfg.max_rpc_per_second
    for _ in range(2 * _cap):
        _d4.enqueue_push(_k5, _sess)
    _k5.pump()
    _hb = _d4.dispatch(UID, os.getgid(), {"op": "heartbeat",
                                          "session_id": "s-nope"})
    check("★★★ 推送连发 2×桶上限之后，同一 uid 的 heartbeat **仍然进得去**",
          _hb.get("error") is None or _hb["error"].get("kind") != "rate_limited",
          str(_hb.get("error"))[:160])
    # 对照组：走 dispatch 的那条路**确实**会被限流 —— 否则上一条是空断言
    _d5 = _mkd()
    _c6, _k6 = _pair(_d5)
    _limited = False
    for _ in range(2 * _cap):
        _r = _d5.dispatch(UID, os.getgid(), {"op": "ping"})
        if (_r.get("error") or {}).get("kind") == "rate_limited":
            _limited = True
    check("★★ 对照组：走 dispatch 连发同样次数**确实**回 rate_limited"
          "（证明上一条不是空断言）", _limited, "一次都没限流")

    # ── 26.8 一个不读的客户端不卡 tick（用例②）─────────────────────────
    #
    # ★ 计划里写的是"断言 tick 次数逐次相等"。那是个**依赖墙钟**的判据，
    #   在负载不同的机器上会自己红。这里换成三条更硬、且都是确定性的：
    #   ① tick() 结构上**一次 send 都不发**；② 队列**有上界**且超出即丢推送；
    #   ③ 整个循环跑得完（阻塞写会让它永远不返回）。
    # ★ 硬线也调小：默认 4 MiB 是照"一条合法响应装得下"定的，60 轮小推送根本
    #   到不了那个量 —— 不调小的话"超出即丢推送"那条是**空断言**。
    _d6 = _mkd(snapshot_interval=0.0, conn_out_hard=2048, conn_out_soft=512)
    # SO_SNDBUF=4096 ⇒ 内核只吸收约 8 KiB（本机实测：写满 8064 字节即 EAGAIN）。
    # 不调小的话 send 永远成功，这一条就**永远是绿的假用例**。
    _c7, _k7 = _pair(_d6, sock=4096)
    _k7.subscribed = True
    check("★★ 出站队列空的时候**不挂 EVENT_WRITE**"
          "（挂着而队列空 ⇒ 水平触发 ⇒ 100% CPU 空转，实测 300 ms 内 214167 次）",
          not (_k7.want_events() & selectors.EVENT_WRITE)
          and bool(_k7.want_events() & selectors.EVENT_READ),
          "want=%s" % _k7.want_events())
    _add(_d6, "s-peek", job_id="601")
    _d6.tick()
    # ★ 判据是"字节**在队列里**、而对端**一个字节都没收到**" —— 等价于
    #   "tick 里一次 send 都没有"，而且不需要给 socket 挂代理。
    check("★★ tick() 只把推送**入队**，绝不在这里写（写会阻塞整个事件循环）",
          _k7.pending() > 0 and _c7.lines(0.0) == [],
          "待发 %d 字节" % _k7.pending())
    _t0 = time.time()
    for _i in range(60):
        _d6.slurm.jobs["601"] = {"JobState": "RUNNING", "UserId": UID,
                                 "NodeIndex": str(_i)}
        _d6.tick()
        _k7.pump()
    _elapsed = time.time() - _t0
    check("★★ 对端一个字都不读时，60 轮 tick 跑得完（阻塞写会让它永远不返回）",
          _elapsed < 20.0, "耗时 %.1f 秒" % _elapsed)
    check("★★ 出站队列**有上界**（超出即丢推送，绝不无界增长）",
          _k7.pending() < 2 * _d6.cfg.conn_out_hard,
          "pending=%d 硬线=%d" % (_k7.pending(), _d6.cfg.conn_out_hard))
    check("★ 而丢的是**推送**（stale 有计数），不是响应",
          _k7.stale > 0, "stale=%s" % _k7.stale)

    # ── 26.9 半关 ≠ 断线：响应不能丢（用例⑦）───────────────────────────
    # ★ 这条连接**带了 rid**（是订阅者），所以它半关之后**不会**立刻被关 ——
    #   它要留到 EOF_LINGER。这里把那个窗口调成 0，好在用例里看得见"最终会关"。
    _d7 = _mkd(eof_linger=0.0)
    _c8, _k8 = _pair(_d7)
    _c8.send({"op": "ping", "rid": 7})
    _c8.sock.shutdown(socket.SHUT_WR)      # 老客户端每次发完就半关
    _drive(_d7, rounds=6)
    _r8 = _c8.lines()
    check("★★ 发完立刻半关，**仍然读得到完整响应**"
          "（丢了它 ⇒ 提交拿不到 job_id ⇒ 重试 ⇒ 被配额拒 ⇒"
          "用户看到「提交失败」而作业在跑）",
          len(_r8) == 1 and _r8[0].get("rid") == 7, str(_r8)[:200])
    _d7.tick()                             # sweep_conns() 在这里收
    _c8.lines(0.2)
    check("★ 排空之后连接**最终**被关掉（不会永远留着，"
          "否则 64 个名额会被走掉的客户端占满）", _c8.eof, "还没关")

    # ── 26.10 半关之后推送还在（用例⑨）─────────────────────────────────
    _d8 = _mkd()
    _c9, _k9 = _pair(_d8)
    _c9.send({"op": "ping", "rid": 1})
    _drive(_d8)
    _c9.lines()
    _c9.sock.shutdown(socket.SHUT_WR)
    _drive(_d8, rounds=2)
    _add(_d8, "s-eof", job_id="701")
    _d8.tick()
    _drive(_d8, rounds=2)
    _r9 = [x for x in _c9.lines() if x.get("push")]
    check("★ 半关之后**仍然收到推送**（EOF 只停读，不取消订阅）",
          len(_r9) >= 1, "收到 %d 条推送" % len(_r9))

    # ── 26.11 连接数上限：accept-then-reject（用例⑩）───────────────────
    _d9 = _mkd(conn_max=2)
    _ca, _ka = _pair(_d9)
    _cb, _kb = _pair(_d9)
    # 真去 accept 一条，好让守护进程走它自己那条超限分支。
    # （`_mkd` 不调 setup_socket，所以 `_d9.listener` 本来就是 None，这里现造一个。）
    _lsn_path = os.path.join(tmpdir, "max.sock")
    if os.path.exists(_lsn_path):
        os.unlink(_lsn_path)
    _lsn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    _lsn.bind(_lsn_path)
    _lsn.listen(8)
    _lsn.setblocking(False)
    _d9.selector.register(_lsn, selectors.EVENT_READ)
    _d9.listener = _lsn
    _extra = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    _extra.connect(_lsn_path)
    _d9.accept_ready()
    _extra.settimeout(1.0)
    _buf = b""
    try:
        while b"\n" not in _buf:
            _chunk = _extra.recv(65536)
            if not _chunk:
                break
            _buf += _chunk
    except (socket.timeout, OSError):
        pass
    _rej = json.loads(_buf.split(b"\n")[0]) if b"\n" in _buf else {}
    check("★★ 超限的那条**读到** too_many_connections（不是静默等待后报"
          "一个方向反了的 daemon_unreachable）",
          (_rej.get("error") or {}).get("kind") == "too_many_connections",
          str(_rej)[:200])
    check("★★ 而它**不在**事件循环里（否则它会占着一个名额、还得有人记得管它）",
          len(_d9.conns()) == 2, "循环里有 %d 条" % len(_d9.conns()))
    _d9.selector.unregister(_lsn)
    _lsn.close()
    _extra.close()
    _ka.sock.close()
    _kb.sock.close()
    _ca.close()
    _cb.close()

    # ── 26.12 跨用户泄漏（用例⑧，安全用例）─────────────────────────────
    _d10 = _mkd()
    _cA, _kA = _pair(_d10, uid=UID)
    _cB, _kB = _pair(_d10, uid=UID + 1)
    _kA.subscribed = True
    _kB.subscribed = True
    _add(_d10, "s-A", job_id="801", uid=UID)
    _add(_d10, "s-B", job_id="802", uid=UID + 1)
    _d10.tick()
    _drive(_d10)
    _ra, _rb = _cA.lines(), _cB.lines()
    _aid = {s["session_id"] for m in _ra for s in (m.get("sessions") or [])}
    _bid = {s["session_id"] for m in _rb for s in (m.get("sessions") or [])}
    check("★★ A 收到的推送里**一个 B 的会话都没有**",
          _aid and not (_aid & _bid) and "s-B" not in _aid and "s-A" not in _bid,
          "A=%s B=%s" % (sorted(_aid), sorted(_bid)))
    check("★ 两边各自都收到了自己那一条（否则上一条是空断言）",
          _aid == {"s-A"} and _bid == {"s-B"},
          "A=%s B=%s" % (sorted(_aid), sorted(_bid)))

    # ── 26.13 fd 复用不会把推送写错人（用例⑤）──────────────────────────
    _d11 = _mkd()
    _cX, _kX = _pair(_d11, uid=UID)
    _cY, _kY = _pair(_d11, uid=UID + 1)
    _kX.subscribed = _kY.subscribed = True
    _fd_x = _kX.sock.fileno()
    _d11.drop_conn(_kX, "测试")
    _cX.close()
    _cZ, _kZ = _pair(_d11, uid=UID)
    _kZ.subscribed = True
    _fd_z = _kZ.sock.fileno()
    _add(_d11, "s-Y", job_id="901", uid=UID + 1)
    _add(_d11, "s-Z", job_id="902", uid=UID)
    _d11.tick()
    _drive(_d11)
    _rz = _cZ.lines()
    _zid = {s["session_id"] for m in _rz for s in (m.get("sessions") or [])}
    check("★ 关掉一条再开一条之后，fd 号确实被复用了（否则这条用例是空的）",
          _fd_z == _fd_x, "关的是 fd=%s，新开的是 fd=%s" % (_fd_x, _fd_z))
    check("★★★ fd 复用之后，Y 的推送**不会**跑到 Z 的连接上（跨用户泄漏）",
          _zid == {"s-Z"}, "Z 收到了 %s" % sorted(_zid))

    # ── 26.14 推送渲染不放大 fork（用例⑫）──────────────────────────────
    #
    # ★ 判据用的是"与连接数**无关**"，而不是计划里那个"≤ 20 × (N + C)"的
    #   魔数：前者是性质，后者是一条会随实现细节漂的线。
    def _calls_per_tick(nconn):
        dd = _mkd()
        for i in range(3):
            _add(dd, "s-f%d" % i, job_id=str(1000 + i))
            dd.slurm.jobs[str(1000 + i)] = {"JobState": "RUNNING", "UserId": UID}
        for _i in range(nconn):
            _c, _k = _pair(dd)
            _k.subscribed = True
        dd.slurm.calls = 0
        dd.tick()
        return dd.slurm.calls

    _one = _calls_per_tick(1)
    _four = _calls_per_tick(4)
    check("★★★ 推送渲染的 fork 次数**与连接数无关**（这才是「不放大」）",
          _one == _four and _one > 0,
          "1 条连接 %d 次 / 4 条连接 %d 次" % (_one, _four))
    # ★★ 上界是 **N 本身**，不是 2N。这两件事是分开的、各有各的守卫：
    #   · 上面那条钉的是"**按 uid** 渲染一次"（`_tick_snap`）—— 连接之间不放大；
    #   · 这一条钉的是"**按 tick** 复用"（`job_live=False` + `tick_job()` 记忆化）
    #     —— 快照复用 `phase_running` 本 tick 已经取过的那一份，**不再查第二遍**。
    #   只钉前者的话，把 `job_live=False` 去掉会让每个作业每 tick 查两次，
    #   而"与连接数无关"照样成立 —— 那是一个**不红任何东西**的浪费。
    check("★★ 而且每个作业每 tick **至多一次** Slurm 查询"
          "（3 个会话 ⇒ 至多 3 次；快照复用它，不查第二遍）",
          _one <= 3, "%d 次（3 个会话）" % _one)

    # ── 26.15 逐字节读也不丢帧（用例⑥）─────────────────────────────────
    _d12 = _mkd(snapshot_interval=0.0)
    _cE, _kE = _pair(_d12)
    _kE.subscribed = True
    for _ in range(4):
        _d12.enqueue_push(_kE, [{"session_id": "s-byte"}])
        _kE.pump()
    _cE.sock.settimeout(1.0)
    _all = b""
    try:
        while _all.count(b"\n") < 4:
            _ch = _cE.sock.recv(1)          # ★ 每次只读 1 个字节
            if not _ch:
                break
            _all += _ch
    except (socket.timeout, OSError):
        pass
    _msgs = [json.loads(x) for x in _all.split(b"\n") if x.strip()]
    check("★★ 客户端**每次只读 1 个字节**也解出恰好 4 条（半写断点不错位）",
          len(_msgs) == 4, "解出 %d 条" % len(_msgs))
    check("★ 而 seq 严格递增且连续",
          [m.get("seq") for m in _msgs] == [1, 2, 3, 4],
          str([m.get("seq") for m in _msgs]))

    # ── 26.16 超长请求行与批次上限（都不会静默吞掉请求）─────────────────
    _d13 = _mkd()
    _cF, _kF = _pair(_d13)
    _cF.raw(b"x" * (mod.CONN_IN_MAX + 100))
    _drive(_d13)
    _rF = _cF.lines()
    check("★ 超长请求行回一句 bad_request（不是静默丢弃）",
          len(_rF) == 1 and (_rF[0].get("error") or {}).get("kind") == "bad_request",
          str(_rF)[:200])

    _d14 = _mkd()
    _cG, _kG = _pair(_d14)
    for _i in range(mod.MAX_DISPATCH_PER_WAKEUP * 3):
        _cG.send({"op": "ping", "rid": _i})
    _drive(_d14, rounds=12)
    _rG = [x.get("rid") for x in _cG.lines() if "rid" in x]
    check("★★ 一次发 %d 条请求，**一条都不丢**（批次上限只限速不限量）"
          % (mod.MAX_DISPATCH_PER_WAKEUP * 3),
          _rG == list(range(mod.MAX_DISPATCH_PER_WAKEUP * 3)),
          "收到 %d 条" % len(_rG))

    # ── 26.17 tick 的节拍：话多的客户端不能加速它（§八 第 1 步）─────────
    _d15 = _mkd()
    _ticks = [0]
    _real_tick = _d15.tick

    def _counted_tick():
        _ticks[0] += 1
        return _real_tick()
    _d15.tick = _counted_tick
    _t0 = time.time()
    _d15.next_tick_at = _t0 + 5.0
    _cH, _kH = _pair(_d15)
    for _i in range(200):                  # 200 次客户端唤醒
        _cH.send({"op": "ping", "rid": _i})
    _drive(_d15, rounds=200)
    check("★★ 200 次客户端唤醒**一次 tick 都没触发**"
          "（tick 的钟是截止时刻，不是「有人说话就转一圈」）",
          _ticks[0] == 0, "触发了 %d 次" % _ticks[0])
    check("★ 还没到点 ⇒ 不 tick", _d15.tick_due(_t0) is False)
    check("★ 到点了才 tick", _d15.tick_due(_t0 + 5.0) is True)
    check("★ 而推进是「此刻 + 周期」，**落在未来**"
          "（写成 `+=` 会在慢 tick 上自持死循环）",
          _d15.next_tick_at == _t0 + 5.0 + _d15.cfg.tick_seconds,
          "next=%.2f 期望 %.2f" % (_d15.next_tick_at,
                                   _t0 + 5.0 + _d15.cfg.tick_seconds))
    _d15.tick_done(_t0 + 8.2)              # 假装这个 tick 跑了 3.2 秒
    check("★★ 一个超时的 tick **不触发补跑**（补跑是往慢集群上雪上加霜）",
          _d15.tick_due(_t0 + 8.3) is False
          and _d15.next_tick_at > _t0 + 8.2,
          "next=%.2f" % _d15.next_tick_at)

    # ── 26.18 跨文件的那一个数：出站硬线（§3.3）────────────────────────
    _cli_src = io.open(os.path.join(HERE, "slurmate"), encoding="utf-8").read()
    _be_src = io.open(os.path.join(HERE, os.pardir, "client", "src", "main",
                                   "backend-ssh.js"), encoding="utf-8").read()
    _m_cli = re.search(r"(?m)^RPC_MAX_RESPONSE_BYTES\s*=\s*(.+)$", _cli_src)
    _m_be = re.search(r"const MAX_RESPONSE_BYTES\s*=\s*(.+?);", _be_src)
    check("★★★ 守护进程的 CONN_OUT_HARD 与 CLI 的 RPC_MAX_RESPONSE_BYTES"
          "**逐字相等**（比它小的话，一条合法的 plugin_package 响应会进不去）",
          bool(_m_cli) and eval(_m_cli.group(1)) == mod.CONN_OUT_HARD,
          "CLI 那份是 %s，守护进程是 %d"
          % ((_m_cli.group(1).strip() if _m_cli else "没找到"), mod.CONN_OUT_HARD))
    check("★★ 客户端的 MAX_RESPONSE_BYTES 也是同一个数（三处一致）",
          bool(_m_be) and eval(_m_be.group(1)) == mod.CONN_OUT_HARD,
          "客户端那份是 %s" % (_m_be.group(1).strip() if _m_be else "没找到"))
    check("★ 软水位小于硬线（反过来的话读侧的门永远关着）",
          0 < mod.CONN_OUT_SOFT < mod.CONN_OUT_HARD,
          "%d / %d" % (mod.CONN_OUT_SOFT, mod.CONN_OUT_HARD))
    check("★★ 快照周期**严格小于**客户端的 STATUS_MS（否则这一版在数据新鲜度上"
          "是净退化）",
          mod.SNAPSHOT_INTERVAL * 1000 < 60000,
          "快照 %s 秒 vs STATUS_MS 60 秒" % mod.SNAPSHOT_INTERVAL)

    # ── 26.18b 跨文件：客户端那条看门狗与推送的命令行 ────────────────────
    #
    # ★★ 这一组挡的是**两条都会静默降级**的漂法。它们的共同点是：坏了之后
    #    客户端**照常能用**（走 exec），所以没有任何东西会红 ——
    #    只有这几条把两侧的字面量摆在一起才有可能发现。
    _ses_src = io.open(os.path.join(HERE, os.pardir, "client", "src", "main",
                                    "session.js"), encoding="utf-8").read()
    _m_wd = re.search(r"(?m)^const PUSH_STALE_MS\s*=\s*(\d+)", _ses_src)
    check("★★★ 客户端的推送看门狗**严格大于**守护进程的快照周期"
          "（取小了会把**正常的空闲**读成通道坏了，于是每一轮都去问一次 —— "
          "把常驻通道省下来的东西原样还回去）",
          bool(_m_wd) and int(_m_wd.group(1)) > mod.SNAPSHOT_INTERVAL * 1000,
          "看门狗 %s ms vs 快照 %s 秒"
          % ((_m_wd.group(1) if _m_wd else "没找到"), mod.SNAPSHOT_INTERVAL))

    # ★★ 客户端要的那条 `slurmate <子命令>` 必须是 CLI **真的有的**。
    #    打错一个词的话，那条命令会以 argparse 的退出码 2 结束，而客户端会
    #    **安静地退回 exec** —— 一切照常，只是常驻通道永远没起来。
    _m_stream_cmd = re.search(r'const STREAM_CMD = "/bin/bash -c \'[^\']*slurmate (\w+)\'"',
                              _be_src)
    _m_rpc_cmd = re.search(r'const RPC_CMD = "/bin/bash -c \'[^\']*slurmate (\w+)\'"',
                           _be_src)
    for _label, _m in (("STREAM_CMD", _m_stream_cmd), ("RPC_CMD", _m_rpc_cmd)):
        _sub = _m.group(1) if _m else None
        check("★★ 客户端 %s 要的子命令 `%s` 是 CLI 真的有的"
              "（打错一个词 = 安静地退回 exec，谁都看不出来）"
              % (_label, _sub or "?"),
              bool(_sub) and bool(re.search(r'add\("%s"' % re.escape(_sub), _cli_src)),
              "在 cluster/slurmate 的子命令表里找不到 `%s`" % (_sub or "?"))

    # ★★ 通知的键名：客户端认的那两个，必须与守护进程发的**逐字相同**。
    #    改一处漏另一处 = 通知永远认不出来 —— 而它同样只是"退回轮询"，不报错。
    _msg_src = io.open(DAEMON, encoding="utf-8").read()
    _m_msg_key = re.search(r'msg = \{"push": "([a-z_]+)", "seq": seq', _msg_src)
    #    那两条判据在客户端的 `parseEnvelopeLine` 里（`obj.push` / `obj.seq`）。
    check("★★ 客户端认的通知键（`obj.push` / `obj.seq`）与守护进程发的"
          "（`\"push\": \"sessions\"` + `\"seq\"`）逐字相同",
          bool(_m_msg_key) and _m_msg_key.group(1) == "sessions"
          and bool(re.search(r"typeof obj\.push === 'string'", _be_src))
          and bool(re.search(r"typeof obj\.seq === 'number'", _be_src)),
          "守护进程那份是 %s" % (_m_msg_key.group(1) if _m_msg_key else "没找到"))

    # ── 26.19b 推送里不含任何口令（靠一条**真会话文件**才验得出来）──────
    #
    # ★ 没有这一条的话，"推送走的是 list 的 with_secret=False"只是一句注释：
    #   夹具里那条会话根本没有口令可发，两个方向都会绿。
    _d18 = _mkd()
    _cI, _kI = _pair(_d18)
    _kI.subscribed = True
    _pwjid = 4242
    write_session("job-%d.json" % _pwjid, {
        "schema": 1, "session_id": "s-pw", "job_id": _pwjid, "uid": UID,
        "user": "alice", "partition": "A6000", "node": "node01",
        "node_ip": "192.0.2.11", "service_port": 55019,
        "tunnel_target": "192.0.2.11:55019", "state": "running",
        "job_started_at": 1, "written_at": 2, "job_hb_at": 3,
        "code_server_pid": 4, "auth_mode": "password",
        "auth_password": "pw-push-secret",
        "slurm_restart_number": 0, "exit_code": None,
    })
    _add(_d18, "s-pw", job_id=str(_pwjid))
    _pw_view = _d18.session_view(_d18.store.get("s-pw"))     # with_secret=True
    check("★ 前提：这条会话**确实**有口令可发（否则下面那条是空断言）",
          _pw_view.get("auth_password") == "pw-push-secret",
          "status 那条路拿到的口令是 %r" % _pw_view.get("auth_password"))
    _d18.tick()
    _drive(_d18)
    _rpw = [m for m in _cI.lines() if m.get("push")]
    check("★★ 推送里**一个 auth_password 都没有**（它走的是 list 的 "
          "with_secret=False —— 于是「推送不含秘密」是结构性质，不靠任何判断）",
          bool(_rpw) and all("auth_password" not in s
                             for m in _rpw for s in (m.get("sessions") or [])),
          str(_rpw)[:250])

    # ── 26.20 ★★★ 端到端：真循环 + 真 listener + 真客户端 ──────────────
    #
    # 前面那些用例都是拿着 Conn 手工驱动事件循环的。这一条把 `run()` 真的跑
    # 起来 —— 它才会走到 select、走到 tick 的截止时刻、走到 accept 那条路。
    # 手工驱动测不到的东西（比如"accept 返回阻塞 fd"）只会在真循环里现形。
    #
    # ★ 守护进程跑在**它自己的线程**里，所有 store 访问都在那个线程内完成：
    #   sqlite3 连接默认 check_same_thread=True，跨线程用会抛。为了测试把它
    #   关掉等于把一条真实的防线拆了 —— 所以改成"由守护进程线程自己建行"。
    _e2e_path = os.path.join(tmpdir, "e2e.sock")
    _box = {}
    _ready = threading.Event()
    # ★ 兜底：这一段涉及真线程 + 真 socket，卡住的话默认症状是"测试永远不返回"，
    #   而那种现场什么都查不出来（本项目已经在别处吃过一次这个亏）。让它在 60 秒
    #   之后**自己把每个线程的栈打出来**并退出 —— 卡住变成一份可读的证据。
    import faulthandler as _fh
    _fh.dump_traceback_later(90, exit=True)

    def _boot():
        _dd = _mkd(tick_seconds=0.05, snapshot_interval=0.05, eof_linger=0.2)
        _dd.cfg.socket_path = _e2e_path
        _dd.setup_socket()
        _add(_dd, "s-e2e", job_id="950")
        # ★ 刻意用 PENDING 而不是 RUNNING：RUNNING 会让每个 tick 都去读一次
        #   **不存在**的会话文件（夹具里没有那份文件），并各写一行 warning ——
        #   0.05 秒一个 tick 就是每秒二十几行，日志会被淹掉，而那不是被测的东西。
        _dd.slurm.jobs["950"] = {"JobState": "PENDING", "UserId": UID,
                                 "Partition": "A6000", "Reason": "Resources"}
        _box["d"] = _dd
        _ready.set()
        _dd.run()
        _dd.store.close()

    _th = threading.Thread(target=_boot, daemon=True)
    _th.start()
    check("★ 守护进程线程起来了", _ready.wait(10.0), "5 秒内没起来")
    _dd = _box.get("d")
    if _dd is None:
        check("★★★ 端到端（守护进程没起来，其余免谈）", False, "见上")
    else:
        _s1 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        _s1.settimeout(10.0)
        try:
            _s1.connect(_e2e_path)
            _w = _Client(_s1)
            _w.send({"op": "ping", "rid": "e2e-1"})
            _t0 = time.time()
            _wresp = []
            # ★ 按 rid 挑，而不是"读到的那一条"：同一次 recv 里很可能**既有响应
            #   也有推送**（守护进程推得很勤）。用 rid 挑正好把判据本身验了 ——
            #   响应带 rid、通知不带，两者在同一条流上不会混。
            while not _wresp and time.time() - _t0 < 8.0:
                _wresp = [m for m in _w.lines(0.3) if m.get("rid") == "e2e-1"]
            check("★★★ 端到端：真循环 + 真 listener，带 rid 的请求拿到带 rid 的响应",
                  len(_wresp) == 1 and _wresp[0].get("ok") is True,
                  str(_wresp)[:200])
            # ★ 放在拿到响应**之后**：accept 是守护进程线程做的，刚 connect
            #   完就去问 conns() 会问到一个空列表（那是竞态，不是缺陷）。
            _accepted = _dd.conns()
            check("★★ 被接受的连接是**非阻塞**的"
                  "（实测 accept() 在非阻塞 listener 上返回的是阻塞 socket ——"
                  "不显式关掉，第一次 send 就会卡死整个事件循环）",
                  bool(_accepted)
                  and all(not c.sock.getblocking() for c in _accepted),
                  "getblocking=%s" % [c.sock.getblocking() for c in _accepted])
            # 订阅之后第一个 tick 必定推一条（sent_digest 还是 None）
            _t0 = time.time()
            _wpush = []
            while not _wpush and time.time() - _t0 < 8.0:
                _wpush = [m for m in _w.lines(0.3) if m.get("push")]
            check("★★★ 端到端：订阅连接收到了推送，而且推的是那条会话",
                  len(_wpush) >= 1 and any(
                      s.get("session_id") == "s-e2e"
                      for s in (_wpush[-1].get("sessions") or [])),
                  str(_wpush)[:250])

            # 同一时刻一条**不带 rid** 的连接：它一个字节的推送都不该收到
            _s2 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            _s2.settimeout(10.0)
            _s2.connect(_e2e_path)
            _v = _Client(_s2)
            _v.send({"op": "ping"})
            _t0 = time.time()
            _vresp = []
            while not _vresp and time.time() - _t0 < 8.0:
                _vresp = _v.lines(0.3)
            check("★★ 端到端：老客户端（不带 rid）一问一答，且**没有 rid**",
                  len(_vresp) == 1 and "rid" not in _vresp[0], str(_vresp)[:200])
            _extra = []
            _t0 = time.time()
            while time.time() - _t0 < 0.6:          # 跨过好几个 tick
                _extra += [m for m in _v.lines(0.1) if m.get("push")]
            check("★★★ 端到端：而它在好几个 tick 里**一条推送都没收到** —— "
                  "老客户端不受常驻通道影响的保证是结构性的",
                  _extra == [], "它收到了 %d 条推送" % len(_extra))
            # ── 26.21 ★★★ 通过**真正的 `slurmate stream` 进程**走一遍 ──────
            #
            # 前面那些都是拿 Conn 直接驱动的。这一条把 CLI 当成用户会用的那个
            # 东西跑起来：它经 stdin/stdout 说话，内部自己维持那条常驻连接。
            _bootsrc = (
                "import importlib.machinery, importlib.util, sys\n"
                "L = importlib.machinery.SourceFileLoader('slurmate_cli', %r)\n"
                "S = importlib.util.spec_from_loader('slurmate_cli', L)\n"
                "M = importlib.util.module_from_spec(S)\n"
                "L.exec_module(M)\n"
                "M.DEFAULT_SOCKET = %r\n"
                "sys.exit(M.cmd_stream(None))\n"
                % (os.path.join(HERE, "slurmate"), _e2e_path))
            _proc = subprocess.Popen([sys.executable, "-c", _bootsrc],
                                     stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE)
            try:
                for _i in range(3):
                    _proc.stdin.write(
                        (json.dumps({"op": "ping", "rid": "st-%d" % _i}) + "\n")
                        .encode("utf-8"))
                _proc.stdin.flush()
                # ★ 用 os.read 而不是 stdout.readline()：后者是**带缓冲**的，
                #   而 select 只看内核缓冲 —— 缓冲区里已经有整行时 select 不报，
                #   于是 readline 会永远等下去。这是同一类坑的第二次出现。
                _buf, _msgs = b"", []
                _t0 = time.time()
                while time.time() - _t0 < 12.0:
                    _r, _, _ = select.select([_proc.stdout], [], [], 0.3)
                    if _r:
                        _chunk = os.read(_proc.stdout.fileno(), 65536)
                        if not _chunk:
                            break
                        _buf += _chunk
                    _parts = _buf.split(b"\n")
                    _buf = _parts.pop()
                    _msgs += [json.loads(x) for x in _parts if x.strip()]
                    if (len([m for m in _msgs if "rid" in m]) >= 3
                            and len([m for m in _msgs if m.get("push")]) >= 2):
                        break
                _strids = [m.get("rid") for m in _msgs if "rid" in m]
                check("★★★ 一条 `slurmate stream` 进程承载 3 条 RPC，各回各的 rid",
                      _strids == ["st-0", "st-1", "st-2"], str(_strids))
                _stpush = [m for m in _msgs if m.get("push")]
                check("★★★ 而同一条 stream 上还收到 ≥ 2 条推送（服务端主动说的）",
                      len(_stpush) >= 2, "收到 %d 条" % len(_stpush))
                _stseq = [m.get("seq") for m in _stpush]
                check("★ 推送的 seq 严格递增（缺口由 stale 报，不靠猜）",
                      _stseq == sorted(set(_stseq)) and len(_stseq) >= 2,
                      str(_stseq))
                # 半关 ⇒ 守护进程把出站排空后关掉它 ⇒ 那是**正常终点**，退出码 0
                _proc.stdin.close()
                _rc = _proc.wait(timeout=20)
                check("★★ stdin 半关之后 `stream` 以 0 退出"
                      "（半关 ≠ 断线，是正常收摊；报 5 会让客户端白白重连）",
                      _rc == 0,
                      "退出码 %s，stderr=%s"
                      % (_rc, _proc.stderr.read()[:200]))
            finally:
                try:
                    _proc.kill()
                except Exception:                            # noqa: BLE001
                    pass

            _v.close()
            _w.close()
        except OSError as _e:
            check("★★★ 端到端：连得上守护进程", False, str(_e))
        finally:
            _dd.running = False
            _th.join(timeout=8.0)
        check("★ 收到停止信号之后循环退出来了（不是卡在 select 里）",
              not _th.is_alive(), "线程还活着")
    _fh.cancel_dump_traceback_later()

    # ── 26.19 资源回收：连接与观察表都不许无界增长 ──────────────────────
    _d16 = _mkd()
    for _i in range(30):
        _c, _k = _pair(_d16)
        _d16.drop_conn(_k, "测试")
        _c.close()
    check("★★ 开关 30 条之后 selector 里仍然只有那一份（没有 fd 泄漏）",
          len(_d16.selector.get_map()) == 0, str(len(_d16.selector.get_map())))
    check("★ 关闭的连接不再出现在花名册里", _d16.conns() == [],
          "%d 条" % len(_d16.conns()))

    for _dd in (_d, _d2, _d3, _d4, _d5, _d6, _d7, _d8, _d10, _d11, _d12,
                _d13, _d14, _d15, _d16):
        try:
            _dd.store.close()
        except Exception:                                    # noqa: BLE001
            pass
    for _dd in (_d9,):
        try:
            _dd.store.close()
        except Exception:                                    # noqa: BLE001
            pass

    # ── 汇总 ────────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("  通过 %d  失败 %d" % (PASS, FAIL))
    if FAIL == 0:
        # 明说"没有跳过任何一项"。否则"全绿"可能被读成"都验过了"，
        # 而实际有一部分根本没跑 —— 这正是本项目一路在清的假绿。
        print("  （全部用例都已实际执行；本文件不依赖真集群，CI 上跑的与本地一致）")
    print("=" * 60)
    shutil.rmtree(tmpdir, ignore_errors=True)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
