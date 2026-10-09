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
test-sessiond-logic.py — slurmate-sessiond 的单元/集成测试

在【未安装】的状态下跑，用临时目录做状态目录，用 monkeypatch 覆盖家目录查找，
以便验证安全关键路径（会话文件校验）与 Slurm 交互。

用法： /usr/bin/python3 test-sessiond-logic.py

★ 本文件必须在【任何机器上都得出同样的结论】。
  若以为它"不依赖真集群，CI 上跑的与本地一致"，那是不成立的：
  `Config.validate()` 会检查 Slurm 命令【在宿主机上】是否存在，而 CI runner
  上没有 Slurm。于是"配置自检无错误"这一条会在 CI 上红，红的原因与被测逻辑
  毫无关系 —— 看上去像"测试太严"，没有人会去查。
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
import logging

HERE = os.path.dirname(os.path.abspath(__file__))
DAEMON = os.path.join(HERE, "slurmate-sessiond")
# 自测用【随仓库分发的示例配置】。真实部署的 /etc/slurmate/slurmate.conf 是
# 站点私有的，不该在开发机上，也不该成为测试能否通过的前提。
CONF = os.path.join(HERE, "slurmate.conf.example")

# 测试用的 uid：【必须等于运行本测试的用户】。
#
# 写成一个固定的数字的话，它只是碰巧等于某个用户的 uid —— 于是测试能过，
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
      `if __name__ == "__main__"` 里。调用方要的是它那几个常量（19.11d 那条
      跨文件不变量读的是它与守护进程各写一遍的那两个数），以及第 30.9 节那处
      ——把 `call` 换掉、真跑一遍 `_simple`，验"服务端发的那句话命令行看得见"。

    ★ 每次调用都是一个**新的模块对象**，所以调用方在它上面做的任何替换都不会
      漏给下一个调用方。
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
    return (PKG_MAGIC + struct.pack(">III", MOD.PACKAGE_FORMAT, len(files), len(sig_block))
            + recs + sig_block + b"".join(b for _p, b in files))


def quadruple_of(files):
    """`[(路径, 字节), …]` → A.3 的四元组（`id` / 版本 / 两个侧摘要）。

    ★ 两个摘要走的是**实现自己的** `package_side_digests`（与守护进程读包时同一个
      函数）—— 夹具在这里再抄一遍分侧规则，就会跟着实现一起漂而没人发现。
      `id`/版本取自负载里那份 `plugin.json`，与打包器 `sign` 取的是同一处。
    """
    by = dict(files)
    mf = json.loads(by["plugin.json"].decode("utf-8"))
    pairs = [{"path": p, "sha256": hashlib.sha256(b).hexdigest()} for p, b in files]
    sd = MOD.package_side_digests(pairs)
    return {"id": mf["id"], "version": mf["version"],
            "digestSite": sd["site"], "digestClient": sd["client"]}


def sig_block_of(quad, pubkey, sig64):
    """四元组 + 公钥 + 64 字节签名 → 一块 v0.13 的签名块（A.3）。"""
    verb = quad["version"].encode("utf-8")
    return (bytes([1]) + pubkey + sig64 + quad["id"].encode("ascii")
            + bytes([len(verb)]) + verb
            + bytes.fromhex(quad["digestSite"]) + bytes.fromhex(quad["digestClient"]))


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
    """把一份包写进 out_dir，文件名默认是 `<包里的 id>.splug`。返回那个路径。

    ★ 这是**包来源目录**那一侧的写方（`slurmate plugin install <文件>` 的输入）。
      站点盘上的形状是另一回事 —— 见 `install_package`。
    """
    blob = build_package(files, sig_block)
    if filename is None:
        mf = next((b for p, b in files if p == "plugin.json"), b"{}")
        filename = json.loads(mf.decode("utf-8"))["id"] + ".splug"
    path = os.path.join(out_dir, filename)
    with open(path, "wb") as f:
        f.write(blob)
    return path


def install_package(plugins_dir, files, sig_block=b"", plugin_id=None):
    """把一份包**照安装器的形状**装进一个站点插件目录（一棵树 + 一份记录表）。

    `files` 是 `[(路径, 字节), …]`，与 `put_package` 同一形状。返回那份**包**的字节。

    ★ 为什么这一步不能省成"往目录里摆一棵树"：被测的东西**正是那个形状**
      （记录表是提交点、扫描器逐份对账）—— 夹具绕过它就等于没测。
    ★ 记录表走的是**实现自己的写方**（`plugin_record_of` / `write_plugin_record`）
      —— 夹具在这里再抄一遍摘要与字段名，就会跟着实现一起漂而没人发现。
    ★ 刻意**不经安装器**：安装器还要验签、查钥匙记录、判同 id，而那些各有各的
      用例。这一层只负责"造出一个**已经装好**的目录"。
    ★ `plugin_id` 覆盖**目录名**（缺省 = 清单里的 id）。造"目录名与清单里的 id
      不一致"那种坏形状时用它 —— 那是 F21 在新形状下的落点。
    """
    blob = build_package(files, sig_block)
    r = MOD.package_parse(blob)
    if not r["ok"]:
        raise AssertionError("夹具自己造的包不成立：%s —— %s" % (r["code"], r["why"]))
    pid = plugin_id or json.loads(dict(files)["plugin.json"].decode("utf-8"))["id"]
    tree = MOD.plugin_tree_dir(plugins_dir, pid)
    os.makedirs(plugins_dir, exist_ok=True)
    # ★ 先清掉同一个 id 上一次那一份 —— 安装器换树是**整棵换掉**（见
    #   `_install_plugin_tree`），而"往里加几份文件"会在树上留下上一版的残骸，
    #   于是对账报"盘上有、记录表里没有" —— 那是一条**假**的篡改指控。
    shutil.rmtree(tree, ignore_errors=True)
    try:
        os.unlink(MOD.plugin_record_path(plugins_dir, pid))
    except OSError:
        pass
    for f in r["files"]:
        full = os.path.join(tree, f["path"].replace("/", os.sep))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as fh:
            fh.write(r["data"][f["offset"]:f["offset"] + f["size"]])
    MOD.write_plugin_record(plugins_dir, pid, MOD.plugin_record_of(r))
    return blob


def tree_digest(root):
    """一棵目录树的确定性摘要：逐份「相对路径 ‖ 0x00 ‖ sha256(内容) ‖ 0x0A」再 sha256。

    ★ 用例用它断言"盘上那一份一个字节都没被动"。**按路径排序**，与 §3.4 同一条
      排序规则 —— 一个只看文件名的断言会被"内容换了而文件名没换"骗过去。
    """
    h = hashlib.sha256()
    out = []
    for dirpath, dirnames, names in os.walk(root):
        dirnames.sort()
        for n in sorted(names):
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as f:
                out.append((rel, hashlib.sha256(f.read()).hexdigest()))
    for rel, d in sorted(out):
        h.update(rel.encode("utf-8"))
        h.update(b"\x00")
        h.update(d.encode("ascii"))
        h.update(b"\x0a")
    return h.hexdigest()


def file_digest(path):
    """一个文件的 sha256；不在就是空串（对"一个字节都没动"那类断言友好）。"""
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return ""


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

    ★ v0.13：签的是**四元组**（A.3）—— `{id, 版本, 站点侧摘要, 客户端侧摘要}`。
      两个摘要从 `files` 现算，与读方走的是同一个函数（`package_side_digests`）。
      与打包器 `sign` 的做法完全一样（§4.2：签名不改内容摘要）。
    """
    quad = quadruple_of(files)
    sig = openssl_sign(pem, MOD.package_signed_message(quad))
    if sig is None:
        return None
    return build_package(files, sig_block_of(quad, pubkey, sig))


def weave_one(tpl_path, install_dir, name, ulid, out_path):
    """照安装器的做法，把**一个**插件的 job/start.sh 织进模板。

    ★ 一个插件一份：这里与安装器是同一段 awk、同一个标记、同样只放一个块。
      这里分叉的后果是"用例全绿、真机上炸" —— 所以织法必须与实现同形，
      而实现的织法自己有用例钉着（19.19 ③）。
      返回 awk 的 CompletedProcess（调用方要断言 returncode）。

    ★ 作业侧那一份从**那棵树**里取（`<install_dir>/job/start.sh`），与安装器走
      同一条路。
    """
    blocks = out_path + ".blocks"
    with open(os.path.join(install_dir, "job", "start.sh"), "rb") as _f:
        body = _f.read().decode("utf-8")
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
         与安装器做的是同一件事。指向一个空目录或手写的替身都不行：
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
    # 顺便补上 default_plugin：这一份测试配置要的是「一个升级前的老站点」的样子
    # —— 那时不带 service_kind 的提交落到 code-server。第 19 节用**不带这一项**的
    # 另一份配置测"没配就该被明确拒绝"。
    #
    # ★ 这两行是**替换**，不是"插在 cluster_cidr 后面"。
    #   理由：示例配置现在把 17 个键**一个不少**地列出来（注释整批搬进了文档），
    #   所以 `default_plugin` 是一个**空值的真行** —— 再插一行就会撞上那条
    #   "同一个键写两遍是错误"的硬规则。替换对两种形状都成立，而且顺带把"这两行
    #   必须在示例里"变成一条**当场说得出话**的前置条件。
    for _k, _v in (("cluster_cidr", "192.0.2.0/24"),
                   ("default_plugin", "code-server")):
        text, _n = re.subn(r"(?m)^%s\s*=.*$" % _k, "%s = %s" % (_k, _v), text)
        if _n != 1:
            raise ValueError("示例配置 %s 里应当恰好有一行 `%s =`（实际 %d 行）"
                             % (CONF, _k, _n))
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
    #    临时目录 —— 正是安装器会做的事（集群侧装包只有那一处实现）。
    #
    #    ★ 刻意用**真的那两个**而不是合成替身：插件与基座的接口正是这一版反复在
    #      动的东西，用替身测等于没测 —— 替身会跟着实现一起漂，而真插件不会。
    #    ★ 也是**真的打包**（走 build_package 那个容器）、再**照安装器的形状解开**
    #      （`install_package` → 一棵树 + 一份记录表），不是绕过这两步直接摆一棵树：
    #      "装出来是一棵能对账的树"正是这一版要测的东西，夹具绕过它就等于没测。
    plugins_src = os.path.normpath(os.path.join(HERE, os.pardir, "plugins"))
    plugins_dir = os.path.join(tmpdir, "plugins")
    os.makedirs(plugins_dir, exist_ok=True)
    for _name in sorted(os.listdir(plugins_src)):
        _d = os.path.join(plugins_src, _name)
        if not os.path.isfile(os.path.join(_d, "plugin.json")):
            continue
        install_package(plugins_dir,
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
        weave_one(os.path.join(HERE, "run.sbatch"), _s.install_dir, _s.name,
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
def _read_installed(directory):
    """读一个目录里的部署标记（`.installed`）。文件不在 = 空表（
    "空集"就是"没有记录"，见守护进程里的 `_write_installed_marker`）。"""
    try:
        with open(os.path.join(directory, ".installed"), encoding="utf-8") as f:
            return [l.strip() for l in f if l.strip()]
    except OSError:
        return []


def _write_manual_conf(conf_path, name):
    """管理员**手写**的那一份插件配置（短名命名，不是 ULID 命名）。"""
    d = conf_path + ".d"
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, name + ".conf"), "w", encoding="utf-8") as f:
        f.write("enabled = yes\n")
    return True


def _raises(fn):
    try:
        fn()
    except ValueError:
        return True
    return False


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
        # `-j <作业号>` 是 job_state 的兜底查询：空输出 = "不在队列里"。
        if "-j" in args:
            return 0, "", ""
        # ★★ `-h -o "%i|%P|%t|%u"` 是集群队列快照。这一份夹具
        #    照着真机的形状给，并且**故意比真集群脏**：本机那台此刻全是 `PD`，
        #    `R` 与"其余那一档"（`CG` 收尾中）都走不到，而"其余那一档**不并进**
        #    running"正是这里唯一的那条判断（见 Slurm.queue_table）。
        return 0, (
            "7001|A6000|PD|alice\n"
            "7002|A6000|PD|bob\n"
            "7003|A6000|PD|alice\n"
            "7004|RTX8000|R|alice\n"
            "7005|RTX8000|CG|bob\n"
            # ★ 作业数组：`%i` 给的是这个写法，而 Slurm 把它当**一条**排。
            #   数成 9 条会让"队列深度"在用了数组的集群上直接虚高一个量级。
            "7006_[3-9,13-19%2]|2080TI|PD|alice\n"), ""

    # ★★ 四条查询。形状照抄真机（本机实测 slurm-wlm 23.11.4）。
    if "sinfo" in cmd and "-V" in args:
        return 0, "slurm-wlm 23.11.4\n", ""
    if "sinfo" in cmd:
        # `%t` 给的是**紧凑**形式（真机实测：`%t`=mix、`%T`=mixed）。
        # ★ 带后缀的那两个是**故意的**：真集群四个节点全是 idle/mix，一个带
        #   后缀的都没有 —— 于是"剥后缀、只按 base state 计数"在真机上走不到。
        #   夹具比现实干净，缺陷就会在用例里隐形（账本 F26）。
        # ★ `2080TI*` 是**默认分区**的记号，`%P` 会给出来，要剥掉。
        # ★★ **表头照真机给。** `sinfo` 与 `scontrol show … -o` 不一样，它会打
        #    一行 `PARTITION|NODELIST|STATE`；少了 `-h` 的话那一行会被当成一个
        #    名叫 `PARTITION`、状态叫 `STATE` 的分区，然后原样画进界面。
        #    这一行是**真集群实测抓到那个缺陷之后补上的** —— 手写一个不带表头的
        #    输出，等于把那条路径从用例里抹掉。
        _body = (
            "A6000|nodea1|mix\n"
            "A6000|nodea2|idle\n"
            "RTX8000|nodeb1|alloc\n"
            "2080TI*|nodec1|idle*\n"
            "2080TI*|nodec2|down~\n")
        # `-h` 在 ⇒ 没有表头；不在 ⇒ 有（与真机逐字一致）。
        return 0, ("" if "-h" in args else "PARTITION|NODELIST|STATE\n") + _body, ""

    if "sshare" in cmd:
        # User 那一列**逐字**是判据：非 root 调用时 sshare 只给账户级的汇总行
        #（User 列为空），而那几行**不是**用户的公平份额。这条夹具照那个形状给：
        # 只有认得的用户名才有一行。
        who = args[args.index("-u") + 1] if "-u" in args else ""
        rows = ["root|||28284168|0.000000",
                " chbstudents|||28279528|0.999836"]
        if who in ("alice", "bob"):
            rows.append("  chbstudents|%s|0.125000|3072302|0.108641" % who)
        return 0, "\n".join(rows) + "\n", ""

    # ★★ 判据要带 `sacctmgr not in` —— 这个桩全篇按**子串**认命令，而
    #    "sacctmgr" 里就含 "sacct"。少了它，所有 sacctmgr 调用都会被这一支接住
    #    （实测：五条既有的账户/分区权限用例一起变红，而报出来的是"alice 的账户
    #    是 8101|code-server|COMPLETED…"）。
    if "sacct" in cmd and "sacctmgr" not in cmd:
        # ★★ **时间写法照真机校验。** `sacct` 只认 `now-7days` / `now-7day`，
        #    写 `now-7d` 会回 `Invalid time specification`（真集群实测）。
        #    桩不校验的话，那一格写错的形态是"历史**永远**取不到" —— 而它长得
        #    像集群没有账本，与真正的原因隔了好几层。这一条是补的。
        _since = args[args.index("-S") + 1] if "-S" in args else ""
        if _since and not _since.endswith(("day", "days")):
            return 1, "", "Invalid time specification (pos=4): %s" % _since
        # ★ 混进两个**作业步**（`.extern` / `.0`）：它们与作业同时出现，
        #   混进来会让"最近 30 条"变成"最近 10 个作业的每一步"。
        return 0, (
            "8100|code-server|FAILED|0:9|00:03:11|2026-09-21T09:02:00|2080TI\n"
            "8100.extern|extern|COMPLETED|0:0|00:03:11|2026-09-21T09:02:00|\n"
            "8101|code-server|COMPLETED|0:0|06:38:58|2026-09-22T17:17:13|A6000\n"
            "8101.0|code-server|COMPLETED|0:0|06:39:01|2026-09-22T17:17:16|\n"), ""

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


def fresh_cluster(mod, d, cfg):
    """给 d 换一个**空的**集群信息缓存，返回它。

    ★★ 守护进程**不再每个请求现查**集群信息 —— 一次查询服务所有连接。代价是：
      "把底下的 Slurm 答案换掉、再看界面"这类用例必须先让缓存作废，否则它断言
      的是上一段缓存里的那个答案，而它会**绿**。

      生产代码里不存在这个问题：缓存的寿命就是守护进程的寿命，而它读的那些
      数据（分区表、节点配置、association）本来就几分钟才变一次。
    """
    d.cluster = mod.Cluster(cfg, d.slurm)
    return d.cluster


def _read_logs(home):
    """读一个假 HOME 下 NFS 日志目录里的全部内容（作业脚本的产物）。"""
    d = os.path.join(home, ".slurmate", "logs")
    out = ""
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            with open(os.path.join(d, fn), encoding="utf-8") as f:
                out += f.read()
    return out


def _read_logs_part(home, suffix):
    """只读日志目录里某一类文件（`.out` 或 `.err`）。作业日志按**流**分两份，
    所以"这一句落在哪一份里"本身就是要断言的东西 —— 合起来读就断言不了。"""
    d = os.path.join(home, ".slurmate", "logs")
    out = ""
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            if fn.endswith(suffix):
                with open(os.path.join(d, fn), encoding="utf-8") as f:
                    out += f.read()
    return out


def _stub_slurm_bins(tmpdir, names):
    """把八个 Slurm 命令的**空桩**放进一个目录，并把它前置到 `PATH`。

    ★★ 为什么整个测试进程都需要它：`Config.__init__` 用 `resolve_bin()` 解析这八个
      命令在不在，**解析不到就让整份配置带上问题** —— 于是十来处「配置自检无错误」
      的断言在**没有装 Slurm 的机器上**集体失败（CI 是裸的 ubuntu-latest）。
      ★ 那不是那些用例写错了：它们要考的从来不是"这台机器是不是登录节点"，
        而"这个仓库跑在一台真集群的计算节点上"只是开发机的偶然。

    ★ 桩**从不被执行**：本文件的用例要么直接构造配置对象，要么把 `run_cmd` 换掉，
      要么给子进程一整份假环境。它们只需要**存在且可执行**。

    ★ 为什么是改 `PATH` 而不是替换 `resolve_bin`：这个文件里有几节**拉起真的
      子进程**（`--check` 的退出码、`--gen-config`），替换函数管不到子进程，
      改 `PATH` 管得到。★ 也正因如此，这里不能反过来拿 `PATH` 去造"**缺** Slurm"
      —— `resolve_bin` 还有 `SLURM_BIN_DIRS` 那层兜底，本地照样会查到真的；
      `--check` 那一节的注释记的是**同一条**教训。

    ★ 名字从 `mod.SLURM_COMMANDS` 来，**不在这里抄第二份**。

    ★★ 桩目录挂在 `PATH` 的**末尾**，不是开头 —— 这一条是有代价换来的：
      挂在开头时，本文件里那些**真的拉起命令**的用例（`sinfo -N`、`scontrol show`
      ……）拿到的是这个空桩，解析它的输出就炸；而炸在某个被 `with` 吞掉的地方时，
      症状是**后面几节整段不跑**，汇总却照旧打印「全部用例都已实际执行」
      （那段话只看 `FAIL == 0`，不看实际跑了多少）—— 一次**假绿**。
      挂在末尾：本机仍然先找到 `/usr/bin/sbatch`（行为与从前逐字相同），
      只有在**真的没有装 Slurm** 的机器上才落到桩。
    """
    d = os.path.join(tmpdir, "stub-bin")
    os.makedirs(d, exist_ok=True)
    for name in names:
        p = os.path.join(d, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write("#!/bin/sh\nexit 0\n")
        os.chmod(p, 0o755)
    os.environ["PATH"] = os.environ.get("PATH", "/usr/bin:/bin") + os.pathsep + d
    return d


def main():
    global PASS, FAIL
    tmpdir = tempfile.mkdtemp(prefix="slurmate-test-")
    print("测试临时目录: %s\n" % tmpdir)

    mod = load_module()
    # ★★ 必须在**任何** `Config` 之前 —— 见 `_stub_slurm_bins` 的说明。
    #    它排在第 1 节那句「配置自检无错误」的前面，也排在所有子进程用例的前面。
    _stub_slurm_bins(tmpdir, mod.SLURM_COMMANDS)
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

    def write_plugin_conf(conf_path, name, text):
        """在 `<conf_path>.d/` 下写一份插件配置（文件名就是身份，里面没有块头）。"""
        d = mod.plugin_conf_dir(conf_path)
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, name + ".conf")
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p

    def parse(text, name="parse.conf"):
        """只要前两个返回值（键表）。第三个是"这一份住在哪个文件里"，见 19.18。"""
        g, s, _m = mod.parse_config(write_conf(text, name))
        return g, s

    check("行尾 # 注释被切掉",
          parse("range_start = 55001  # 端口池下界\n")[0] == {"range_start": "55001"})
    check("整行注释与空行被跳过",
          parse("# 说明\n\n   \nrange_end = 5\n")[0] == {"range_end": "5"})
    check("值两端空白被去掉",
          parse("readonly_paths =   /shared/home  \n")[0]
          == {"readonly_paths": "/shared/home"})

    # ★★ 插件配置**不住在主文件里**：一个插件一个文件。所以主文件里
    #   `[plugin:...]` 这件事**不存在**了，写了就是错误。
    for i, (bad, why) in enumerate((("range_start = 1\nrange_start = 2\n", "重复键"),
                                    ("这不是赋值\n", "缺等号"),
                                    ("= 5\n", "缺键名"),
                                    ("[plugin:sshd]\nenabled = yes\n", "主文件里写块头"),
                                    ("[plugin:sshd\n", "没闭合的块头"),
                                    ("[cluster]\nx = 1\n", "别的块头也一样"))):
        try:
            parse(bad, "bad-%d.conf" % i)
            check("%s → 报错" % why, False, "竟然通过了")
        except ValueError:
            check("%s → 报错" % why, True)

    # 而插件配置住在 drop-in 文件里：文件名就是身份，文件里只有 `键 = 值`。
    _pc = os.path.join(tmpdir, "treeparse.conf")
    with open(_pc, "w", encoding="utf-8") as f:
        f.write("range_end = 5\n")
    write_plugin_conf(_pc, "sshd", "# 说明\nenabled = yes\ndefault_cpus = 3\n")
    _g, _s, _m = mod.parse_config(_pc)
    check("★★ 插件配置住在 `<配置路径>.d/<名字>.conf`，主文件只有通用键",
          _g == {"range_end": "5"}
          and _s == {"sshd": {"enabled": "yes", "default_cpus": "3"}},
          "%s / %s" % (_g, _s))
    check("★ 第三个返回值给出**是哪一个文件**（报错要说得出这句，不然管理员"
          "得去猜）",
          _m["sshd"]["file"].endswith(
              os.path.join("treeparse.conf.d", "sshd.conf")), str(_m))

    # ★ 主文件里写块头那条报错要说清**该写到哪儿去** —— 只说"不合法"的话，
    #   管理员唯一想得到的动作是把那几行删掉，而那是把他的配置丢掉。
    try:
        parse("[plugin:sshd]\nenabled = yes\n", "hint.conf")
        _hint = ""
    except ValueError as e:
        _hint = str(e)
    check("★★ 主文件里写块头的报错要**指路**（`.d/` 目录 + 一个插件一个文件）",
          ".d/" in _hint and "一个插件一个文件" in _hint, _hint)

    # ★ drop-in 文件里同样不写块头 —— 文件名已经说了这一份是谁的。
    _weird = write_plugin_conf(_pc, "weird", "[plugin:sshd]\nenabled = yes\n")
    try:
        mod.parse_config(_pc)
        _hint2 = ""
    except ValueError as e:
        _hint2 = str(e)
    os.unlink(_weird)
    check("★ drop-in 文件里也不写块头（文件名就是身份）", "文件名" in _hint2, _hint2)

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
    #    （只是解析失败时才回退成原样返回输入）—— 所以它也必须走桩。若把它放在
    #    桩外面，靠的就是"开发机上恰好装了 Slurm"，那条断言测的其实是环境。
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

        # 分区表是一等公民 —— 缺省提交要从这里随机挑，
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
    # ★ 若用宿主机上的真 scontrol，它会在开发机上绿（本机恰好是一个真集群的
    #   计算节点）、在 CI 上红（runner 上没有 scontrol，rc=127 →
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
    # ★ 测的必须是**被测代码本身**：若测的是【把正则抄了一遍】的本地函数
    #   mem_ok()，那样的用例在 sanitize_mem() 被改成什么都照样绿。这里直接调它。
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
    # 旧库里还留着 sessions.purpose 这种本版没有的列，而 SQLite 的
    # CREATE TABLE IF NOT EXISTS 不会改已存在的表。不拦的话，旧库上的每一次
    # 提交都会以内部错误失败。
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
    # 日志目录是入参（`job_log_dir_for()` 在调用方算好），不再是"家目录 + 一个子目录"。
    _logdir = os.path.join(home, ".slurmate", "logs")

    def argv_of(**over):
        js = over.pop("job_script", "/tmp/jobs/01M2JKM4P7Q8R2S5T9V0W3X6Y8.sbatch")
        sk = over.pop("service_kind", "code-server")
        return mod.build_sbatch_argv(cfg, dict(base_sess, **over), {"A": "1"},
                                     _logdir, js, sk)

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
    # 不容易看见（第 18 节的 submit 是打桩的，看不见 argv）。
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
    # ── 17a. 作业日志：两个文件、按流分开、append 模式 ────────────────────────
    #
    # ★★ 这一组是**这一轮唯一的落点**：作业脚本那一侧的 `exec >>` 由 22d 的运行时
    #    用例钉着，**而 sbatch 这一侧的 `-o/-e` 只有这里能验**（那些用例是直接
    #    `bash <脚本>` 跑的，根本不经过 sbatch）。变异"M6 把 -e 改回 outpat"
    #    第一轮就是这么逃过去的 —— 它一条都不红。
    #
    # ★ 从前这里有一条"目录不存在时回退到家目录根"。那条回退**整个删掉了**：
    #   输出分成两份、还有保留期与总量上限在那两个目录里做，落点必须是**一个**
    #   确定的目录。作业脚本会 `mkdir -p` 它，此后每个作业都安全。
    a = mod.build_sbatch_argv(cfg, dict(base_sess, partition=""), {}, _logdir,
                              "/tmp/j.sbatch", "code-server")
    def _pat(flag):
        return a[a.index(flag) + 1] if flag in a else None
    _o, _e = _pat("-o"), _pat("-e")
    check("★★ `-o` 与 `-e` 是**两个不同的**文件，而且就是 `slurm-%j.out` / "
          "`slurm-%j.err`（合成一个的话，「这个服务往 stderr 上抱怨了什么」就没法"
          "单独看 —— 而出故障时那恰恰是唯一有用的那半）",
          _o is not None and _e is not None and _o != _e
          and _o.endswith("slurm-%j.out") and _e.endswith("slurm-%j.err"),
          "out=%r err=%r" % (_o, _e))
    check("★★ 而两份都落在**传进来的那个**日志目录里（不是家目录根、也不是别处）—— "
          "作业脚本据此 `exec >>` 过去、并在同一个目录里做保留期与总量上限",
          bool(_o) and bool(_e)
          and os.path.dirname(_o) == _logdir and os.path.dirname(_e) == _logdir,
          "out=%r err=%r logdir=%r" % (_o, _e, _logdir))
    check("★★ `--open-mode=append`：Slurm 那一侧的 fd 必须与作业脚本的 `>>` 同为 "
          "O_APPEND。默认的 truncate 下它带着自己的偏移量，收尾时那一次写会"
          "**盖掉文件开头**",
          "--open-mode=append" in a, str(a))

    # ── 17b. ★ 环境变量**只**靠命令行传（F19）────────────────────────────────
    #
    # 模板里不该写 `#SBATCH --export=ALL`：sbatch 的**命令行选项覆盖脚本里的
    # `#SBATCH`** ⇒ 那一行从头到尾不会被读过。两条值恰好都是 `ALL`，所以行为上
    # 分毫不差 —— 它不是缺陷，是一句**假信号**：下一个读那份模板的人会以为"环境
    # 变量是靠这一行传进去的"，于是调 build_sbatch_argv 时**漏掉那些 SLURMATE_\***。
    #
    # ★ 判据是**两条一起**：命令行上真的有它（且 SLURMATE_* 一个都不许漏），
    #   而模板里**没有**任何一条 `#SBATCH` 指令提到 export。只判一头的话，
    #   "两边都删掉"会全绿 —— 而那是把环境变量整个弄丢。
    _sub_env = {"SLURMATE_SESSION_ID": "s-1", "SLURMATE_CANDIDATES": "55001;55002",
                "SLURMATE_AUTH_MODE": "password", "SLURMATE_SERVICE_KIND": "code-server"}
    _aexp = mod.build_sbatch_argv(cfg, dict(base_sess, partition="2080TI"), _sub_env,
                                  home, "/tmp/j.sbatch", "code-server")
    _exp = [x for x in _aexp if x.startswith("--export=")]
    check("★ 命令行上恰好一个 --export=ALL,…（环境变量唯一的来路）",
          len(_exp) == 1, str(_aexp))
    check("★ 而它带着**每一个** SLURMATE_* 变量（漏一个 = 作业里当场退出）",
          bool(_exp) and all("%s=%s" % (k, v) in _exp[0] for k, v in _sub_env.items())
          and _exp[0].startswith("--export=ALL,"), str(_exp))
    _tpl_txt = io.open(os.path.join(HERE, "run.sbatch"), encoding="utf-8").read()
    _tpl_exp = [ln.strip() for ln in _tpl_txt.splitlines()
                if re.match(r"^\s*#SBATCH\b", ln) and "export" in ln]
    check("★ 模板里没有任何一条 #SBATCH 指令提到 export（那一行从来没生效过）",
          _tpl_exp == [], "模板里还有：%s" % _tpl_exp)

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

    def run_submit(req, allowed="normal", client_id=None):
        """跑一次 op_submit。返回 (响应, 记下来的 sess/env)。

        `client_id` 走的是 `dispatch` 那条路给的那个参数（连接自报的身份）。
        """
        seq[0] += 1
        d.store = mod.Store(os.path.join(tmpdir, "submit-%d.db" % seq[0]))
        d.slurm = mod.Slurm(cfg)
        # ★ 缓存跟着一起换新。集群信息**不再每个请求现查**（一次查询服务所有
        #   连接），所以一个"把底下的 Slurm 答案换掉、再看结果"的用例必须先让缓存
        #   作废 —— 否则它断言的是上一轮缓存里的那个答案。
        d.cluster = mod.Cluster(cfg, d.slurm)
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
            resp = d.op_submit(UID, req, client_id)
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
    #   夹具的 2080TI 每节点 8 张（真集群上就是 8）—— 一个写死的
    #   `MAX_GPUS_REQUEST = 8` 在这里恰好也过得去，所以换一个**比 8 大**的分区
    #   来钉：RTX8000 那一台每节点 4 张 + mps:100。看 mps 那一条。
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
    # RTX8000 有 —— 若从**全部**有权限的分区里随机挑，就会落到装不下它的 2080TI
    # 上被拒，而用户没有任何办法绕开（他本来就没指定分区）。界面上给的选项也是
    # 并集，两边必须是同一句话。
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
    mod.Slurm.gres_catalog = lambda self: None
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
    mod.Slurm.gres_catalog = lambda self: None
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

    # ── 缺省 GRES：省略 = 用**这个插件的**默认；显式 `null` = 不占 ─────────────
    #
    # ★★ 这一格与 cpus / mem / time 同一条纪律（"省略字段永远是在说『用你的
    #    默认』"），但它多一层，而那一层不是可选的：站点的默认卡**必须能被拒绝**。
    #    少了它，`default_gpus` 就是一道用户无法拒绝的命令 —— 而"开发会话默认占住
    #    A6000 的卡"是**稀缺算力政策**，管理员拍的是"默认"，不是"任何人都不许说不"。
    #
    #    ★ 判据是「这个键**在不在**」，不是「这个键是不是空的」：`clean_gres(None)`
    #      返回 `(None, None)`，所以"没发"与"显式 null"在**下游**长得一模一样 ——
    #      分得开它们的只有 `"gres" in req` 这一句。这也是为什么三条都要走
    #      **提交那条线**（只判 `PluginConfig` 的字段，这一句一个字都测不到）。
    #
    #    ★ 用的是**不带型号**的 `gpu:1`：桩里的三个分区都有 `gpu`，而带型号的
    #      （`gpu:a100`）只在 A6000 上有 —— 而分区是随机挑的，用它这条用例会时灵
    #      时不灵。夹具要能**稳定地**回答它要问的那个问题。
    def _gres_of(resp):
        """响应里**实际生效**的那个 GRES（`data.resources.gres`）。

        ★ 键与值分开返回：`"gres" in …` 是"服务端说了这件事"，`…["gres"] is None`
          是"它说不占"。两者都取不到时（响应整个失败）返回 `("缺", None)`，让上面
          那条断言红掉，而不是在 `check(...)` 的参数里抛 KeyError 把脚本带崩。
        """
        res = ((resp.get("data") or {}).get("resources") or {})
        return ("gres" in res), res.get("gres")

    _cs_id = cfg.resolve_plugin(CS)[0].id
    _saved_dg = cfg.plugins[_cs_id].default_gpus
    cfg.plugins[_cs_id].default_gpus = {"name": "gpu", "type": None, "count": 1}
    try:
        r, _sess, _env = run_submit({"op": "submit"})
        _has, _g = _gres_of(r)
        check("★★ 提交时省略 gres ⇒ 用**这个插件那份配置里**的 default_gpus",
              _has and _g == {"name": "gpu", "type": None, "count": 1},
              str(r)[:200])
        r, _sess, _env = run_submit({"op": "submit", "gres": None})
        _has, _g = _gres_of(r)
        check("★★ 但**显式 `null` ⇒ 不占**，盖过插件的默认 —— 用户拒绝得了它",
              _has and _g is None, str(r)[:200])
        r, _sess, _env = run_submit({"op": "submit",
                                     "gres": {"name": "gpu", "count": 2}})
        _has, _g = _gres_of(r)
        check("★ 显式给了 ⇒ 就用它（默认只在**省略**时生效）",
              _has and _g == {"name": "gpu", "type": None, "count": 2},
              str(r)[:200])
    finally:
        cfg.plugins[_cs_id].default_gpus = _saved_dg

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
    # <prefix>/share/slurmate/plugins/<ULID>.splug，由安装器装进去。加一个插件因此
    # 是「放一个包 + 跑一次 `slurmate plugin install`」，不是「改守护进程的源码」。
    def add_plugin_to_cfg(_cfg, _spec, _raw=None):
        """给 `_cfg` **就地**加一个插件（spec + 生效配置），返回一个还原函数。

        ★ 这几处不必各写各的四行（`plugin_by_name = dict(...)` 加一条、
          `plugins["jup"] = PluginConfig(...)` 加一条、再重算 enabled_kinds）：
          那几张表按 **id** 收、"名字 → 哪一个"的判据收在 `resolve_plugin()` 里，
          于是"该动哪几张表"值得只有一处 —— 漏一张的症状是这条用例因为**别的原因**
          红或绿。
        """
        _saved = (_cfg.plugin_specs, _cfg.plugins, _cfg.plugins_by_name,
                  _cfg.plugins_by_id, _cfg.enabled_kinds)
        _cfg.plugin_specs = tuple(_saved[0]) + (_spec,)
        _cfg.plugins = dict(_saved[1])
        _cfg.plugins[_spec.id] = mod.PluginConfig(_spec, _raw or {}, _raw is not None)
        _cfg.plugins_by_id = dict(_saved[3], **{_spec.id: _spec})
        _cfg.plugins_by_name = {k: list(v) for k, v in _saved[2].items()}
        _cfg.plugins_by_name.setdefault(_spec.name, []).append(_spec)
        _cfg.enabled_kinds = tuple(sorted(
            {p.name for p in _cfg.plugins.values() if p.enabled}))

        def _restore():
            (_cfg.plugin_specs, _cfg.plugins, _cfg.plugins_by_name,
             _cfg.plugins_by_id, _cfg.enabled_kinds) = _saved
        return _restore

    print("\n  -- 19.0 扫出来的插件表 --")
    check("★ 扫出了两个插件（表来自磁盘，不是代码常量）",
          sorted(cfg.plugins_by_name) == [CS, SSHD], str(sorted(cfg.plugins_by_name)))
    check("清单合法时没有诊断输出", cfg.plugin_problems == (), str(cfg.plugin_problems))
    # ★ 一个插件在站点上是**一棵树 + 一份记录表**：树按 id 命名，记录表就在它
    #   旁边。两条都要在 —— 只有树没有记录表 = 那次安装没提交。
    check("每个 spec 都记得自己的**树**在哪，而它旁边有记录表（分发与报错都用它）",
          all(s.install_dir
              and os.path.isdir(s.install_dir)
              and os.path.basename(s.install_dir) == s.id
              and os.path.isfile(mod.plugin_record_path(cfg.plugins_dir, s.id))
              for s in cfg.plugin_specs),
          str([s.install_dir for s in cfg.plugin_specs]))
    check("★ 而站点盘上**没有** `.splug`（容器只是运输形状，不是存储形状）",
          not [n for n in os.listdir(cfg.plugins_dir) if n.endswith(".splug")],
          str(sorted(os.listdir(cfg.plugins_dir))))
    check("★ job_entry 是按短名推出来的真契约（与 run.sbatch 的 plugin_call 同一条规则）",
          cfg.resolve_plugin(CS)[0].job_entry == "start_code_server"
          and cfg.resolve_plugin(SSHD)[0].job_entry == "start_sshd",
          "%s / %s" % (cfg.resolve_plugin(CS)[0].job_entry,
                       cfg.resolve_plugin(SSHD)[0].job_entry))
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

    # 坏掉的东西：**跳过并报出来，但绝不让守护进程起不来**。一个插件坏了不该
    # 带走整个站点 —— 而静默跳过同样不行（"我明明装了啊"会变成一句谁也答不上来的话）。
    #
    # ★★ "坏掉"有**五种形状**，而且它们的处置**不完全一样**：
    #      · 树与记录表对不上（有人在装完之后动了它）  ⇒ 报**点名哪一份**，不删
    #      · 一棵树**没有记录表**（那次安装没提交）     ⇒ 报，**不删**
    #      · 目录名不是一个 id                         ⇒ 报，不删
    #      · 一个 `.splug` 文件（旧形状 / 手放的包）    ⇒ 报，不删
    #      · 别的一个普通文件                          ⇒ 报，不删
    #   ★ **一条都不删**，而且这是**故意的**：那一格可能有管理员手放的东西，而
    #     "少收一个插件"与"删掉别人的东西"不是同一个量级。客户端池那一侧正好相反
    #     （那里只有对账在写）—— 两处的方向**刻意不同**。
    _baddir = os.path.join(tmpdir, "plugins-broken")
    os.makedirs(_baddir, exist_ok=True)
    with open(os.path.join(HERE, os.pardir, "plugins", CS, "plugin.json"),
              "rb") as _f:
        _cs_manifest = _f.read()
    install_package(_baddir, [("plugin.json", _cs_manifest)])      # 好的那一份
    # 坏①：一棵树被改过一个字节（记录表还在，而里面的 sha256 对不上了）
    _BAD1 = "01M2JKHTZGKJBFQQTWYXMQMF70"
    install_package(_baddir, [
        ("plugin.json", json.dumps(
            {"id": _BAD1, "name": "tampered", "version": "1.0.0",
             "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8")),
        ("job/start.sh", b"start_tampered() { :; }\n")])
    # ★ **原地改一个字节、长度不动**：这样拦住它的是"sha256 不符"那一支，
    #   而不是"字节数不符"那一支。两句话都在，但只有前者说得清"内容变了" ——
    #   而后者的存在会让一个把内容比对照抄错的实现照样绿（这正是 M2 变异
    #   第一次没红的原因）。
    _tp1 = os.path.join(mod.plugin_tree_dir(_baddir, _BAD1), "job", "start.sh")
    with open(_tp1, "r+b") as _f:
        _one = _f.read(1)
        _f.seek(0)
        _f.write(bytes([_one[0] ^ 0x01]))
    # 坏②：一棵树**没有记录表**（安装被打断，或者有人手放了一棵源码树）
    _BAD2 = "01M2JKHTZGKJBFQQTWYXMQMF71"
    _t2 = mod.plugin_tree_dir(_baddir, _BAD2)
    os.makedirs(_t2, exist_ok=True)
    with open(os.path.join(_t2, "plugin.json"), "wb") as _f:
        _f.write(_cs_manifest)
    # 坏③：一个 `.splug`（旧形状：容器是运输形状，站点盘上不该有它）
    put_package(_baddir, [("plugin.json", _cs_manifest)],
                filename="01M2JKHTZGQ7X8V4T5R6N7B8C9.splug")
    # 坏④：**一个目录**，名字不是一个 id
    os.makedirs(os.path.join(_baddir, "old-layout"), exist_ok=True)
    with open(os.path.join(_baddir, "old-layout", "plugin.json"), "wb") as _f:
        _f.write(_cs_manifest)
    # 坏⑤：**有记录表、没有那棵树** —— 与"没有记录表"正好相反（那一个是"没提交"，
    #      这一个是"已提交而内容不见了"）。★ 孤儿记录表若不报出来，就等于
    #      **静默忽略**一份写着全部真相（逐份 sha256 + 签名）的文件。
    _BAD3 = "01M2JKHTZGKJBFQQTWYXMQMF73"
    mod.write_plugin_record(_baddir, _BAD3, mod.plugin_record_of(
        mod.package_parse(build_package([("plugin.json", _cs_manifest)]))))
    _specs2, _probs2 = mod.scan_plugins(_baddir)
    check("★ 坏掉的东西不会让守护进程起不来（跳过它们，其余照常）",
          [s.name for s in _specs2] == [CS], str([s.name for s in _specs2]))
    check("★ 但它们必须被**逐条报出来**，而且点名是哪一个",
          len(_probs2) == 5 and any("job/start.sh" in p for p in _probs2)
          and any(_BAD2 in p for p in _probs2)
          and any("01M2JKHTZGQ7X8V4T5R6N7B8C9" in p for p in _probs2)
          and any("old-layout" in p for p in _probs2)
          and any(_BAD3 in p for p in _probs2),
          str(_probs2)[:900])
    check("★★ 孤儿记录表那条说的是「有记录表、没有那棵树」（不是一句笼统的「坏了」）",
          any(_BAD3 in p and "记录表" in p and "提交点" in p for p in _probs2),
          str([p for p in _probs2 if _BAD3 in p])[:400])
    # ★★ 这一条是本版的主题：**逐份比对**，不是"整棵树一个摘要"。只有前者说得
    #    出"是哪一份被动过"，而那一句话决定了运维是去查一个文件还是去查一整棵树。
    check("★★ 被改过的那一棵树：报出来的话**点名是哪一份文件**",
          any(_BAD1 in p and "job/start.sh" in p for p in _probs2),
          str([p for p in _probs2 if _BAD1 in p])[:400])
    check("★★ 而那句话说的是「与记录表不符」，不是一句含糊的「坏了」",
          any(_BAD1 in p and "记录表" in p and "sa256" not in p for p in _probs2),
          str([p for p in _probs2 if _BAD1 in p])[:400])
    # ★ 报出来必须**给出下一步** —— 只诊断不指出路，等于把"这怎么办"留给运维猜。
    check("★★ 目录那条错误给出下一步（打包或删掉），不是只诊断",
          any("old-layout" in p and "packer build" in p and "删掉" in p
              for p in _probs2),
          str([p[:80] for p in _probs2]))
    check("★ 旧形状的 `.splug` 那条也给出下一步（用安装器装一次就变成新形状）",
          any("01M2JKHTZGQ7X8V4T5R6N7B8C9" in p and "plugin install" in p
              for p in _probs2),
          str([p[:120] for p in _probs2 if "01M2JKHTZGQ7X8V4T5R6N7B8C9" in p]))
    # ★★ **一条都没被删**。这是本文件里最要紧的一条纪律的两个方向之一（另一个
    #    在客户端池：那边"没记录表的目录"是要清掉的）。
    check("★★ 那些坏东西**一个都没被删**（那一格可能有管理员手放的东西）",
          os.path.isdir(mod.plugin_tree_dir(_baddir, _BAD1))
          and os.path.isdir(_t2)
          and os.path.isfile(os.path.join(
              _baddir, "01M2JKHTZGQ7X8V4T5R6N7B8C9.splug"))
          and os.path.isdir(os.path.join(_baddir, "old-layout"))
          and os.path.isfile(mod.plugin_record_path(_baddir, _BAD3)),
          str(sorted(os.listdir(_baddir))))
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
        try:
            install_package(d, [("plugin.json", text.encode("utf-8"))])
        except (AssertionError, KeyError, ValueError):
            # 清单本身就不合法的那些（连 id 都没有）—— 装不进一棵树，但
            # `scan_plugins` 要能把它们报出来。这里照"一棵树 + 一份记录表"的
            # 形状摆一份**不带记录表**的：判据落在清单那一关上。
            _t = os.path.join(d, name[:-len(".splug")])
            os.makedirs(_t, exist_ok=True)
            with open(os.path.join(_t, "plugin.json"), "wb") as _f:
                _f.write(text.encode("utf-8"))
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
        # ★ `site.defaultTime` 与上面两格**不同：它是可选的**。资源那两格缺了
        #   有一个说不通的后果（"这个插件用几个核"没有安全的猜测），而时限缺了
        #   有一个明确的、今天就在用的答案。为一个"已经有答案"的键要求所有清单
        #   作者补一行，只会让新键变成一个升级障碍。
        check("★ 清单没写 `site.defaultTime` ⇒ 取内建缺省（这一个键是可选的）",
              _s[0].default_time == mod.DEFAULT_TIME, str(_s[0].default_time))

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
             "enumKeys 的 default 不在 choices 里", "default"),
            (json.dumps({"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup",
                         "version": "1.0.0",
                         "site": {"defaultCpus": 1, "defaultMem": "1G",
                                  "defaultTime": "0:30"}}),
             "defaultTime 比 1 分钟还短", "1 分钟"),
            (json.dumps({"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup",
                         "version": "1.0.0",
                         "site": {"defaultCpus": 1, "defaultMem": "1G",
                                  "defaultTime": "unlimited"}}),
             "defaultTime 写成「无限」", "无限"),
            (json.dumps({"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup",
                         "version": "1.0.0",
                         "site": {"defaultCpus": 1, "defaultMem": "1G",
                                  "defaultTime": "半天"}}),
             "defaultTime 认不出", "defaultTime")):
        _s2, _p2 = _manifest(_txt)
        _msg2 = " ".join(_p2)
        # 断言的是"**一个都没收下** + 报错里点到了那一项"，不是"函数返回了 None" ——
        # scan_plugins 的契约是 (specs, problems)，坏清单的 specs 是空元组。
        check("清单：%s → 被拦下" % _why, _s2 == () and _kw in _msg2,
              (_msg2[:130] or str(_s2)))

    # ── 短名撞车：**允许**（这条判据的落点）──────────
    #
    # 短名只是**本站给人看**的名字，不是身份 —— 两个 id 不同、短名一样的插件
    # 允许并存：配置里用 `[plugin:<id>]` 各配各的就能分开（见 resolve_plugin）。
    # ★ 理由是**短名本来就不该承重**：若拿它当身份，撞一次就丢两个插件，而客户端
    #   一个字都看不到（F22）—— 于是"本站有两个 jup"在界面上长成"本站没有 jup"。
    _nupdir = os.path.join(tmpdir, "plugins-namedup")
    os.makedirs(_nupdir, exist_ok=True)
    for _ver, _uid in (("1.0.0", "01M2JKHTZGKJBFQQTWYXMQMF2V"),
                       ("2.0.0", "01M2JKHTZGKJBFQQTWYXMQMF3A")):
        install_package(_nupdir, [("plugin.json", json.dumps(
            {"id": _uid, "name": "jup", "version": _ver,
             "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8"))])
    _s3, _p3 = mod.scan_plugins(_nupdir)
    check("★★ 两个包共用同一个**短名** → 两个都加载（短名不是身份，id 才是）",
          len(_s3) == 2 and _p3 == () and [s.name for s in _s3] == ["jup", "jup"],
          "%s / %s" % ([(s.name, s.id) for s in _s3], _p3))
    check("★ 而且次序是确定的（按 (短名, id) 排）—— 两次扫出来必须一模一样",
          [s.id for s in _s3] == sorted(s.id for s in _s3),
          str([s.id for s in _s3]))

    # ── 同一个 id 的两份内容：**两个都不收**（F21）────────────────────────
    #
    # 同一个 **id** 的两份内容 = 同一个插件的两份作业侧代码。织出来的作业脚本按
    # **id** 命名（`jobs/<id>.sbatch`），后织的会**静默覆盖**先织的，其中一个
    # 插件的作业侧代码**整个丢掉** —— 而"哪一个赢了"取决于目录的字典序。
    #
    # ★★ 这条判据还在，只是换了形式：一个插件的存储键**就是它的 id**
    #    （`<plugins_dir>/<id>/`），所以"两棵树各自声称同一个 id"这件事落成了
    #    "**目录名必须等于清单里的 id**"（`plugin_reconcile` 里那条）。少了它，
    #    两棵名字不同的树可以都声称同一个 id，而扫描器会照样把两条都收下 ——
    #    于是 F21 原样回来。
    #
    # ★ 这个形状**正常装不出来**：安装器按 id 命名目录、装的时候就拒同 id。所以
    #   这条测的是**绕过安装器**那条路 —— 那正是 `scan_plugins` 作为"启动时最后
    #   一道"存在的理由。
    _iddir = os.path.join(tmpdir, "plugins-iddup")
    os.makedirs(_iddir, exist_ok=True)
    _ID_C = "01M2JKHTZGKJBFQQTWYXMQMF2V"
    install_package(_iddir, [("plugin.json", json.dumps(
        {"id": _ID_C, "name": "jup", "version": "1.0.0",
         "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8"))])
    # 第二棵：**目录名是另一个合法 id**，而清单里写的是上面那个 id。
    _ID_D = "01M2JKHTZGKJBFQQTWYXMQMF72"
    install_package(_iddir, [("plugin.json", json.dumps(
        {"id": _ID_C, "name": "jupyter", "version": "1.0.0",
         "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8"))],
        plugin_id=_ID_D)
    _s4, _p4 = mod.scan_plugins(_iddir)
    check("★★ 一棵树顶着**别人的 id** → 它不加载（否则同一个 id 会有两份作业侧代码）",
          [x.id for x in _s4] == [_ID_C] and len(_p4) == 1,
          "%s / %s" % ([(x.name, x.id) for x in _s4], _p4))
    check("★ 而且点名是哪个目录、清单里写的是哪个 id、以及为什么这会是问题",
          _ID_D in " ".join(_p4) and _ID_C in " ".join(_p4)
          and "id" in " ".join(_p4), " ".join(_p4)[:300])

    # ── ★★ 那些**没能加载**的包必须到得了客户端（F22）────────────────────
    #
    # 这一条判的是**线**，不是函数。`plugin_problems` 若只走
    # `--check-plugins` / `--check` / 启动日志、而**协议里一个字都没有**，
    # 客户端看到的就是「本站没有这个插件」，真相却是「本站有两个、因为撞了
    # 没被加载」：**运维在客户端上排查，方向从第一步就是错的**。
    #
    # ★ 走真的一条路：真 `Config`（插件目录指向那两个同 id 的包）→ 真的
    #   `op_plugins` 派发。断言 `plugins` 是**空的**、而 `problems` 点名了它们 ——
    #   这正是 FE 里"插件消失"那个症状的解药。
    _saved_dir_fn = mod.default_plugins_dir
    _saved_cfg_for_problems = d.cfg
    try:
        mod.default_plugins_dir = lambda: _iddir
        d.cfg = mod.Config(write_conf("cluster_cidr = 192.0.2.0/24\n",
                                      "iddup.conf"))
        _pm = d.dispatch(UID, os.getgid(), {"op": "plugins"})
        _pmd = _pm.get("data") or {}
        check("★★ 站点级的问题**进了 op_plugins 的回包**（顶层 problems，F22）",
              isinstance(_pmd.get("problems"), list) and len(_pmd["problems"]) == 1,
              str(_pmd.get("problems"))[:240])
        check("★ 而且客户端看得到是哪个目录 —— 不再是「本站没有这个插件」",
              _ID_D in " ".join(_pmd.get("problems") or []),
              str(_pmd.get("problems"))[:240])
        check("★ 它**不影响能用的那些**：能用的那一个照样报出来（一个坏的不带走另一个）",
              [x["id"] for x in _pmd.get("plugins") or []] == [_ID_C],
              str(_pmd.get("plugins"))[:200])
    finally:
        mod.default_plugins_dir = _saved_dir_fn
        d.cfg = _saved_cfg_for_problems

    # ── ★★ 命令行那一屏（`slurmate plugins`）：F22 的另一半 + 账本 **F37** ──
    #
    # ★★ 这一屏与 F35 逐字同形的那条缺陷：判据若读 `p.get("files")`（那个字段
    #    已经不在了），「分发」那一列就**永远**显示 `—`，而下面那句解释说的是
    #    "这一版守护进程不支持分发"。⇒ CLI 会对**每一个**站点说这句话，**包括
    #    最新那一个**：一句系统并不知道的话。
    #
    # ★ 判据落在**用户真看得见的那一屏**上（把 `call` 换成一份给定的响应、真跑
    #   `cmd_plugins`），不是"源码里出现过某个词"—— 后者在这个函数里本来就成立。
    class _Args19(object):
        json = False
        files = []

    def _cli_plugins_screen(data):
        _c = load_cli()
        _c.call = lambda req, asjson, timeout=20.0: {"ok": True, "code": 0, "data": data}
        _so, _se = io.StringIO(), io.StringIO()
        _old = (sys.stdout, sys.stderr)
        try:
            sys.stdout, sys.stderr = _so, _se
            _rc = _c.cmd_plugins(_Args19())
        finally:
            sys.stdout, sys.stderr = _old
        return _rc, _so.getvalue() + _se.getvalue()

    _one_pkg = {"format": "splug1", "bytes": 1234, "digest": "ab"}
    _good_data = {
        "plugins": [{"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "version": "1.0.0",
                     "name": "jup", "title": "Jupyter", "enabled": True,
                     "can_submit": True, "defaults": {"cpus": 2, "mem": "8G"},
                     "package": _one_pkg}],
        "enabled": ["jup"],
        "limits": {"file_bytes": 1000, "total_bytes": 2000, "max_files": 3,
                   "package_bytes": 4000},
    }
    _rc19, _out19 = _cli_plugins_screen(_good_data)
    check("★★ 一个支持分发的站点 ⇒ 「分发」那一列**说得出话**（不是永远 `—`）",
          _rc19 == 0 and "1 个包" in _out19, _out19[:260])
    check("★ 而且印的是**今天**那条路（整包一次取走），不是 v0.6 那两条",
          "整包上限" in _out19 and "份数" in _out19, _out19[:260])

    _old_daemon_data = {"plugins": _good_data["plugins"], "enabled": ["jup"]}
    _rc19, _out19 = _cli_plugins_screen(_old_daemon_data)
    check("★ 老守护进程（响应里**没有 `limits`**）⇒ `—`，并说清是它不支持分发",
          _rc19 == 0 and "—" in _out19 and "不支持插件分发" in _out19, _out19[:260])

    _prob_data = dict(_good_data)
    _prob_data["problems"] = ["/x/one.splug：id 01M2… 与 /x/two.splug 是同一个插件"]
    _rc19, _out19 = _cli_plugins_screen(_prob_data)
    check("★★ 站点报的那些问题**出现在这一屏上**（F22 的另一半：到得了用户眼前）",
          _rc19 == 0 and "one.splug" in _out19 and "没能加载" in _out19,
          _out19[:260])

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

    # 大小。★ 走**真的比较器**，不是拿 `_cmp_ver` 现拼一个：用 `version_satisfies`
    # 的两个闭区间夹出"谁大"，就是"用范围判定去测大小比较" —— 排序规则一旦写错，
    # 夹具跟着一起错。
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
    # 两边若分家：守护进程只认「engines 是 dict 且 slurmate 是非空字符串」，
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
    _eng_files = [("job/start.sh", b"start_e() { :; }\n"),
                  ("plugin.json", json.dumps({
                      "id": "01M2JKHTZGKJBFQQTWYXMQMF2W", "name": "eng",
                      "displayName": "要新基座", "version": "1.0.0",
                      "engines": {"slurmate": ">=99.0"},
                      "site": {"defaultCpus": 1, "defaultMem": "1G",
                               "bin": {"env": "SLURMATE_E_BIN", "discovery": "which",
                                       "name": "e", "fallback": "/usr/bin/e"}}})
                     .encode("utf-8"))]
    _engpkg = put_package(tmpdir, _eng_files, filename="engines-too-new.splug")
    _say = []
    _rc = mod.install_plugins([_engpkg], _engdir,
                              say=lambda *a: _say.append(" ".join(str(x) for x in a)))
    _out = "\n".join(_say)
    _dest_id = "01M2JKHTZGKJBFQQTWYXMQMF2W"
    _dest = os.path.join(_engdir, _dest_id + ".json")
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
    # ★ "手放"= 自己把那棵树与记录表摆进去（`install_package`），而
    #   `scan_plugins` 的对账**不看 engines** —— 那一关在 `parse_plugin_manifest`，
    #   正是这里要验的那一步。
    install_package(_engdir, _eng_files, plugin_id=_dest_id)
    _specs6, _probs6 = mod.scan_plugins(_engdir)
    check("★ 手放进目录的同一个包：扫的时候**跳过并报一条 problem**（不带走整个站点）",
          _specs6 == () and any(">=99.0" in p for p in _probs6), str(_probs6)[:300])

    # ★ 清单里的版本号用**原串**匹配：`" 1.0.0 "` 不是合法版本号。若先 strip 再
    #   匹配，它就会在这边被收下、在客户端被拒 —— 而客户端拿的是原串
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
    # 然后走一遍：扫描 → 插件配置 → 提交 → 环境变量 → op_plugins。
    _thirddir = os.path.join(tmpdir, "plugins-third")
    os.makedirs(_thirddir, exist_ok=True)
    install_package(_thirddir, [
        # 作业侧那一半。**必须真的放一份**：没有它这个插件就是"合法但提交不了"，
        # 而这一节要验的恰恰是"能提交"。没有作业侧那一态由 19.0e 专门覆盖。
        ("job/start.sh", b"start_jup() { :; }\n"),
        ("plugin.json", json.dumps({
            "id": "01M2JKHTZGKJBFQQTWYXMQMF2X", "name": "jup",
            "version": "2.1.0", "displayName": "Jupyter",
            "engines": {"slurmate": ">=0.5"},
            "contributes": {"submitPubkey": False},
            "site": {"defaultCpus": 3, "defaultMem": "6G", "defaultEnabled": False,
                     "defaultTime": "3:30:00",
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
    check("★ 它那份配置允许的键 = 通用键 + bin + 清单里声明的那几个枚举键"
          "（没有第二份清单可以跟它矛盾）",
          _jup.conf_keys() == ("enabled", "default_cpus", "default_mem",
                                "default_time", "default_gpus",
                                "bin", "token_mode"),
          str(_jup.conf_keys()))
    # ★★ 清单声明的时限是**规范化之后**存下来的（`3:30:00` → `03:30:00`）。
    #   规范化只在解析这一处做，下游（协议、界面、自检）就不必各自处理"同一段
    #   时间的两种写法" —— 而那种"两处各写各的"正是这个项目一路在清的东西。
    check("★ 清单声明 `site.defaultTime` ⇒ 规范化后存下来（3:30:00 → 03:30:00）",
          _jup.default_time == "03:30:00", str(_jup.default_time))
    check("它的作业侧入口是按短名推出来的（与 run.sbatch 的 plugin_call 同一条规则）",
          _jup.job_entry == "start_jup", _jup.job_entry)

    _restore_jup = add_plugin_to_cfg(cfg, _jup, {"enabled": "yes"})
    try:
        _r5, _sess5, _env5 = run_submit({"op": "submit", "service_kind": "jup"})
        check("★ 新插件能被提交，资源缺省来自**它自己的清单**（不是全局常量）",
              _r5.get("ok") and _sess5["cpus"] == 3 and _sess5["mem"] == "6G",
              str(_r5)[:160])
        # ★★ 时限那一格走的是**同一条**：清单 → spec → 提交。这一句不是在重复
        #   上面那句 —— 时限若仍读一个全局常量（`Config.default_time`），提交期
        #   读的就是它，于是"算出来了"与"送出去了"是两件事，所以这一句要打在
        #   **提交那一步**上（F35 的教训：算出来了没送出去，任何变异都打不红）。
        check("★★ 提交时省略 time ⇒ 用**这个插件声明的**时限（清单 → spec → 提交）",
              _sess5["requested_time"] == "03:30:00",
              repr(_sess5.get("requested_time")))
        # ★ 三层里的**首**层（那份配置 ＞ 清单）：纯解析那条路各占一条，与上面那条
        #   "清单走到了提交"合起来才是完整的三层。少了它，把 `PluginConfig` 里
        #   "那份配置没写才回落到 spec" 写成"永远用 spec"不会被任何一条打红 ——
        #   而症状是**管理员在那份配置里改时限完全不生效**，配置文件里却看不出问题。
        check("★ 那份配置里写了 default_time ⇒ **盖过**清单声明的那个（配置 ＞ 清单）",
              mod.PluginConfig(_jup, {"enabled": "yes",
                                      "default_time": "1:00:00"}, True)
              .default_time == "01:00:00")
        check("它声明的那个变量名与解析出来的路径传给了作业",
              _env5.get("SLURMATE_JUP_BIN") == "/usr/local/bin/jupyter",
              repr(_env5.get("SLURMATE_JUP_BIN")))
        check("会话记住的解析键是 <id>@<版本>",
              _sess5.get("service_plugin") == "%s@%s" % (_jup.id, _jup.version),
              repr(_sess5.get("service_plugin")))
        check("站点没在那份配置里写的那几个枚举键，取清单声明的缺省",
              cfg.plugin_config("jup").enum.get("token_mode") == "auto",
              repr(cfg.plugin_config("jup").enum))

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
        _restore_jup()

    # 19.0e ★★ 没有作业侧：**合法状态**，但它提交不了，而且必须说得出来
    #
    # 一个只有客户端那一半的插件是允许存在的（它装得上、看得见）。它在三个地方
    # 必须被说清楚，缺一个就是一个死胡同：
    #   · 配置自检**通过** —— 一个插件的形态不该让整个站点起不来；
    #   · `op_submit` 明确拒绝（code 4 / service_kind_no_job），不是排完队才失败；
    #   · `op_plugins` 的 can_submit=false —— 界面据此画灰按钮，用户不必点了才知道。
    _nojdir = os.path.join(tmpdir, "plugins-nojob")
    os.makedirs(_nojdir, exist_ok=True)
    install_package(_nojdir, [("plugin.json", json.dumps({
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
    check("★ 判据来自**记录表**（服务器上没有源码树可以查，树就是真相）",
          "job/start.sh" not in [f["path"] for f in
                                 mod.read_plugin_record(_nojdir, _decl.id)["record"]["files"]],
          _decl.install_dir)

    _saved_missing = cfg.plugin_job_missing
    _saved_default = cfg.default_plugin
    _restore_decl = add_plugin_to_cfg(cfg, _decl, {"enabled": "yes"})
    try:
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
        _restore_decl()
        cfg.default_plugin = _saved_default
        cfg.plugin_job_missing = _saved_missing

    # 19.0d ★ 零插件：不是"坏掉的安装包"，而是"外壳"本身
    #
    # ★ 这三条是 client/src/main/plugins 那套崩溃安全不变量的集群侧对应物。
    #   客户端那半已经在 boot.test.mjs 里验过"卸掉插件不影响跑着的会话"，这里验
    #   的是**服务端**在零插件时的行为：能启动、能说清、明确拒绝 —— 而不是崩溃、
    #   不是静默。
    _sz, _pz, _bz, _iz, _kz, _dz = (cfg.plugin_specs, cfg.plugins,
                                    cfg.plugins_by_name, cfg.plugins_by_id,
                                    cfg.enabled_kinds, cfg.default_plugin)
    try:
        cfg.plugin_specs = ()
        cfg.plugins, cfg.plugins_by_name, cfg.plugins_by_id = {}, {}, {}
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
        (cfg.plugin_specs, cfg.plugins, cfg.plugins_by_name, cfg.plugins_by_id,
         cfg.enabled_kinds, cfg.default_plugin) = _sz, _pz, _bz, _iz, _kz, _dz

    # 19.1 插件配置（slurmate.conf.d/）
    #
    # ★ 这一节的核心是**向后兼容**：一份插件配置都没有的老站点必须仍然只开
    #   code-server
    #   （它标了 site.defaultEnabled）。少了这条，所有现有站点升级后会一个服务都
    #   开不出来，而配置里一个字都不像有问题。

    def write_conf_tree(text, name):
        """把"通用键 + `[plugin:X]` 段"的**老形状**写成 v0.12 的**两半**，返回主文件路径。

        ★ 通用键 → 主文件；每个插件的段 → 一份 `<主文件>.d/<名字>.conf`。抽成
          一个函数是因为 `pcfg` 与 `pcfg_namedup` 都要这份翻译 —— 各写一遍的话，
          "格式变了"会有两个地方要改，而漏掉一处是静默的。

        ★ 所以这一节里的用例**仍然按"给 X 配这几项"说话**，它们测的是语义
          （开关、默认资源、歧义判据），不是"配置住在哪个文件里"。
          "住在哪儿、谁起的名字"由 19.18 的专门用例钉着。

        ★★ 每次调用先**清空** drop-in 目录：真实的对账只删"它自己那一份"，而
          夹具要的是"这一次写的就是全部"。不清的话，上一次留下的 `sshd.conf`
          会继续生效 —— 症状是"一个插件都不开"那条用例拿到一个开着的 sshd
          （这个夹具第一版就是这么写的，当场被那条用例逮到）。
        """
        p = os.path.join(tmpdir, name)
        shutil.rmtree(mod.plugin_conf_dir(p), ignore_errors=True)
        main, cur, buf = [], None, []

        def _flush(cur, buf):
            if cur is not None:
                write_plugin_conf(p, cur, "".join(buf))

        for line in text.splitlines(True):
            s = line.strip()
            if s.startswith("[plugin:") and s.endswith("]"):
                _flush(cur, buf)
                cur, buf = s[len("[plugin:"):-1], []
            elif cur is None:
                main.append(line)
            else:
                buf.append(line)
        _flush(cur, buf)
        with open(p, "w", encoding="utf-8") as f:
            f.write("".join(main))
        return p

    def pcfg(text, name="plug.conf"):
        """一份站点配置。见 `write_conf_tree` —— 它把老形状拆成 v0.12 的两半。"""
        return mod.Config(write_conf_tree("cluster_cidr = 192.0.2.0/24\n" + text,
                                          name))

    _c = pcfg("")
    check("★ 一个 [plugin:*] 块都没有 → 只有 code-server（与升级前完全一致）",
          _c.enabled_kinds == (CS,), str(_c.enabled_kinds))
    check("没写的块也有一份配置，且能分出「没写」与「写了但关着」",
          _c.plugin_config(SSHD).present is False
          and _c.plugin_config(SSHD).enabled is False)

    # ── ★★ 取值写错时，报错要点名**那一份配置在哪个文件** ────────────────────
    #
    # ★ 报错不能报成 `[plugin:sshd] 的 default_cpus`：**写进主文件本身就是一条
    #   硬错误**（守护进程拒绝启动），照着它去改会撞上这条错误，比不指还坏。
    #   这里报的是那一份 drop-in 的路径。
    # ★ 判据是"那条报错里出现了那一份配置的**文件名**"，而且**没有** `[plugin:` ——
    #   只判前者的话，写成 `[plugin:sshd]（sshd.conf）` 这种既旧又新的混搭也会绿。
    _bad_where = None
    try:
        pcfg("[plugin:sshd]\ndefault_cpus = 很多\n")
    except ValueError as _e:
        _bad_where = str(_e)
    check("★★ 配置项写错时的报错点名那一份配置的**文件**，不再写 `[plugin:…]`",
          _bad_where is not None and "sshd.conf" in _bad_where
          and "[plugin:" not in _bad_where,
          repr(_bad_where))

    _c = pcfg("[plugin:sshd]\ndefault_cpus = 4\n")
    check("★ 写了块但没写 enabled → 仍然不开（一句 default_cpus 不该开出一条 ssh 的路）",
          _c.enabled_kinds == (CS,), str(_c.enabled_kinds))
    check("那份配置里写的默认资源生效；没写的用插件自己的内建值",
          _c.plugin_config(SSHD).default_cpus == 4
          and _c.plugin_config(SSHD).default_mem == "2G",
          "%s / %s" % (_c.plugin_config(SSHD).default_cpus,
                       _c.plugin_config(SSHD).default_mem))
    # ★ 时限是"那份配置 ＞ 清单 ＞ 内建"三层。这里验"配置里写的生效 + 规范化"，另外两层
    #   各自有它自己的那一条（`_jup` 那一节：清单声明的 3:30:00 **走到了提交**，
    #   并有一条纯解析的断言验它**盖过**清单）。
    _c = pcfg("[plugin:sshd]\ndefault_time = 2:00:00\n")
    check("★ 那份配置里写的 default_time 生效，且与清单那条一样规范化",
          _c.plugin_config(SSHD).default_time == "02:00:00",
          str(_c.plugin_config(SSHD).default_time))

    # ── `default_gpus`：**只在那儿** ────────────────────────────────────────
    #
    # ★ 它与上面几格**不同**：清单里**没有**对应的键，而那是刻意的 —— 作者写不出
    #   本站管那张卡叫什么（`gpu` 还是 `mps`、型号叫 `a100` 还是 `A100-PCIE-40GB`），
    #   那是本站在 `gres.conf` 里定的事实。所以"作者声明缺省卡数"这一格**不该有**，
    #   不是"还没做"（见账本 F15 的去向）。
    _c = pcfg("[plugin:sshd]\ndefault_gpus = gpu:a100:2\n")
    check("★ 那份配置里写的 default_gpus 生效 —— 形状就是 `--gres=` 后面那一段",
          _c.plugin_config(SSHD).default_gpus == {"name": "gpu", "type": "a100",
                                                  "count": 2},
          repr(_c.plugin_config(SSHD).default_gpus))
    check("★ 不带型号的那一段形状也认（与 sbatch 同一条语法）",
          pcfg("[plugin:sshd]\ndefault_gpus = gpu:4\n")
          .plugin_config(SSHD).default_gpus == {"name": "gpu", "type": None,
                                                "count": 4})
    check("★★ 没写 ⇒ **不占**（None，而不是一个「安全的数量」）—— 默认占住稀缺"
          "算力是**站点政策**，框架不替所有站点挑一个数",
          _c.plugin_config(CS).default_gpus is None,
          repr(_c.plugin_config(CS).default_gpus))

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

    # ★★ 装了、但**关着** —— 与上面那条同一类，都是硬错误（账本 F17）。
    #    少了这一条，这个组合能通过 `--check`、守护进程能正常起来，而此后
    #    **每一次省略 service_kind 的提交**都拿到 `4 service_kind_disabled`，
    #    错误消息说的是「本站没开「SSH 中转站」」—— 它**不会提**这是配置里
    #    default_plugin 配错了。用户看到的是"站点好像不支持 sshd"，而管理员
    #    接下来的排查方向从第一步就是错的。
    _c = pcfg("default_plugin = sshd\n[plugin:sshd]\nenabled = no\n")
    _errs = " ".join(_c.validate())
    check("★★ default_plugin 指向**装了、但关着**的插件 → 启动就拒绝",
          _errs != "", str(_c.validate())[:160])
    # ★ "被拒了"不够：那句话必须**点名 default_plugin**。不点名的话，管理员唯一
    #   能想到的方向是"查这个插件"，而根因在配置的另一处。
    check("★ 而且要点名 default_plugin（排查方向不能被指到插件本身上）",
          "default_plugin" in _errs and "enabled = no" in _errs, _errs[:220])
    # ★★ 对照组：同一个 default_plugin，把它打开就一切正常。少了这一条，一个
    #    "default_plugin 非空就报错"的实现也能让上面两条绿 —— 而它会拒绝一份
    #    完全合法的配置。
    _ok = pcfg("default_plugin = sshd\n[plugin:sshd]\nenabled = yes\n")
    check("★ 对照：同一个 default_plugin，插件开着 ⇒ 一个错误都没有",
          _ok.validate() == [], str(_ok.validate())[:160])

    # ── 19.1b ★★ 短名**不再唯一**：块按 **id** 寻址（v0.11 阶段 2+3）─────
    #
    # 两个 id 不同、短名都叫 `jup` 的插件是**允许并存**的：它们不是同一个东西，
    # 只是本站给人看的名字撞了。于是那份配置的**文件名**必须能指清是哪一个 —— 这时短名不够
    # 用，**id 才是身份**。
    #
    # ★ 判据是**用户 2026-10-06 拍的那条**：短名为主，**撞名时必须带 id**。
    #   它不是建议，是校验 —— 歧义时"挑一个"的后果取决于遍历次序。
    def pcfg_namedup(text, name):
        _saved = mod.default_plugins_dir
        try:
            mod.default_plugins_dir = lambda: _nupdir
            return pcfg(text, name)
        finally:
            mod.default_plugins_dir = _saved

    _IDS = [s.id for s in mod.scan_plugins(_nupdir)[0]]

    _c = pcfg_namedup("[plugin:jup]\nenabled = yes\n", "namedup1.conf")
    _errs = " ".join(_c.stale_conf_problems)
    check("★★ 短名有歧义、而文件名写的是短名 ⇒ **一条 ⚠**，而且**一个都不挑**"
          "（挑一个的后果取决于遍历次序）",
          _errs != "" and not any(q.enabled for q in _c.plugins.values()),
          "%s / %s" % (_errs[:200],
                       sorted((q.name, q.enabled) for q in _c.plugins.values())))
    # ★ 它是 **⚠**（不拦启动），与"指向没装的插件"同一档 —— 与"指向没装的插件"同一档，理由也
    #   是同一句：后果只是**这一份不生效**（那两个插件按清单缺省跑），而一个站点
    #   不该因此拒绝为所有人服务（那样连"停掉正在跑的会话"都做不到）。
    #   ★ 这两条**合起来**才是那条例律：说了、且不拦启动、且没挑一个。
    check("★★ 而它**不拦启动**（降成 ⚠ 是 v0.12 阶段 2 做的）",
          _c.validate() == [], str(_c.validate())[:200])
    check("★★ 而且报错**列出那几个 id** —— 那是唯一指得清的写法",
          _IDS[0] in _errs and _IDS[1] in _errs, _errs[:260])
    check("★ 那句话要说清「改用插件的 id」，不是一句泛泛的「认不出」",
          "id" in _errs and "短名" in _errs, _errs[:260])

    _c = pcfg_namedup("[plugin:%s]\nenabled = yes\n[plugin:%s]\nenabled = yes\n"
                      % (_IDS[0], _IDS[1]), "namedup2.conf")
    check("★★ 两个块都用 **id** 写 ⇒ 两个都配上了（同名不构成障碍）",
          _c.validate() == [] and len(_c.plugins) == 2
          and all(q.enabled for q in _c.plugins.values()),
          "%s / %s" % (str(_c.validate())[:160], sorted(_c.plugins)))
    check("★ 而且是**各自那一份**（不是同一份配置被读了两遍）",
          {q.spec.id for q in _c.plugins.values()} == set(_IDS),
          str(sorted(_c.plugins)))

    _c = pcfg_namedup("default_plugin = %s\n[plugin:%s]\nenabled = yes\n"
                      % (_IDS[0], _IDS[0]), "namedup3.conf")
    check("★ default_plugin 也能写 id（短名有歧义时那是唯一的写法）",
          _c.validate() == [], str(_c.validate())[:200])

    # ★ 提交那一侧同一条规则：`service_kind` 也是短名，所以歧义在那里也一样
    #   要**当场拒绝并给出 id** —— 否则用户只会拿到一句"本站没有这个插件"。
    _saved_dir_for_kind = mod.default_plugins_dir
    _saved_cfg_for_kind = d.cfg
    try:
        mod.default_plugins_dir = lambda: _nupdir
        d.cfg = mod.Config(write_conf("cluster_cidr = 192.0.2.0/24\n",
                                      "namedup-kind.conf"))
        _r9 = d.dispatch(UID, os.getgid(), {"op": "submit", "service_kind": "jup"})
        _d9 = (_r9.get("error") or {}).get("detail") or ""
        check("★★ 提交时短名有歧义 ⇒ 明确拒绝（不是静默失败，也不是挑一个）",
              not _r9.get("ok") and _r9["error"]["kind"] == "bad_service_kind",
              str(_r9.get("error"))[:200])
        check("★★ 而且把那几个 id 给出来 —— 用户照它改就能提交",
              _IDS[0] in _d9 and _IDS[1] in _d9, _d9[:260])
    finally:
        mod.default_plugins_dir = _saved_dir_for_kind
        d.cfg = _saved_cfg_for_kind

    # 各种错法：一律**报出来**，不能静默忽略 —— 静默忽略的后果是
    # 「文件里写着，而实际什么也没发生」，正是本项目一路在清的那类问题。
    #
    # ★★ 第四列是**档位**，而它必须逐条写出来：
    #    · `"err"`  —— 硬错误，进 `validate()` ⇒ 守护进程拒绝启动；
    #    · `"warn"` —— ⚠，进 `stale_conf_problems` ⇒ `--check` 打一条、日志记一条，
    #      站点照常服务。
    #    ★ 分档的判据是"这件事的后果有多远"：`warn` 那一条的后果只是**它自己不
    #      生效**（那个插件按清单里声明的缺省跑，其余一切照常），而 `err` 那些
    #      要么是**配置自己跟自己矛盾**（同一件事说了两遍而说法不同），要么是
    #      **每一次走这条路的请求都注定失败**。把档位写进表里，是为了让"降错档"
    #      这件事**当场红**，而不是靠读代码的人记得。
    for _txt, _why, _kw, _where in (
            ("[plugin:ssh]\nenabled = yes\n", "未知的插件名", "ssh", "warn"),
            ("[plugin:sshd]\ndefualt_cpus = 1\n", "插件配置里拼错的键",
             "defualt_cpus", "err"),
            ("[plugin:sshd]\nenabled = yes\ncluster_cidr = 198.51.100.0/24\n",
             "通用键写进了插件那一份里（它住在主配置）", "cluster_cidr", "err"),
            ("[plugin:code-server]\nauth_mode = passwd\n", "auth_mode 取值非法",
             "auth_mode", "err"),
            ("[plugin:sshd]\ndefault_mem = 0\n", "default_mem 写成 Slurm 的整机内存",
             "default_mem", "err"),
            ("[plugin:sshd]\ndefault_time = 0:30\n", "default_time 比 1 分钟还短",
             "default_time", "err"),
            ("[plugin:sshd]\ndefault_time = unlimited\n", "default_time 写成「无限」",
             "default_time", "err"),
            ("[plugin:sshd]\ndefault_time = 两小时\n", "default_time 认不出",
             "default_time", "err"),
            ("[plugin:sshd]\ndefault_gpus = gpu:a100\n",
             "default_gpus 缺数量（写成了名字:型号）", "数量必须是整数", "err"),
            ("[plugin:sshd]\ndefault_gpus = gpu:1,mps:2\n",
             "default_gpus 写了两项", "只能写一项", "err"),
            ("[plugin:sshd]\ndefault_gpus = gpu:0\n",
             "default_gpus 的数量是 0", "count", "err"),
            ("[plugin:sshd]\ndefault_gpus = gpu:1:2:3\n",
             "default_gpus 段数不对", "无法识别", "err")):
        try:
            _c = pcfg(_txt)
            _in_err = bool(_c.validate())
            _errs = " ".join(_c.validate() + _c.stale_conf_problems)
        except ValueError as _ex:
            _errs, _in_err = str(_ex), True
        check("%s → 被说出来（%s）" % (_why, "硬错误" if _where == "err" else "⚠"),
              _kw in _errs and _in_err == (_where == "err"),
              "%s / 在 validate() 里=%s" % (_errs[:110], _in_err))

    # ★★ 上面三条都会被"提到了 default_time"满足 —— 而把**粒度那条校验整个删掉**，
    #   它们照样绿（另外两条还在以同一个键名报错）。所以粒度这一条必须**自己**
    #   红一次：报错里要有「1 分钟」，而且那三个不同的错法要说三句不同的话。
    #   这是"三条反例共用一个关键词"时唯一能分清"守住了"与"没生效"的办法。
    _dt_msgs = {}
    for _v in ("0:30", "unlimited", "两小时"):
        try:
            _dt_msgs[_v] = " ".join(pcfg("[plugin:sshd]\ndefault_time = %s\n" % _v)
                                    .validate())
        except ValueError as _ex:
            _dt_msgs[_v] = str(_ex)
    check("★★ 「比 1 分钟还短」与「认不出」是**两句不同的话**（删掉粒度校验，这一条会红）",
          "1 分钟" in _dt_msgs["0:30"] and "无法识别" in _dt_msgs["两小时"],
          str(_dt_msgs)[:220])
    check("★ 三种错法各有各的说法（同一个键名不是同一个理由）",
          len({_dt_msgs[_v] for _v in _dt_msgs}) == 3,
          str(_dt_msgs)[:260])

    # ★ 「通用键写进插件那一份」的报错必须**指得回根因**。只断言"被拒了"是不够
    #   的：那份配置的键白名单**也会**拒绝它（它本来就不在允许列表里），于是
    #   "拒绝了"这件事两种实现都满足 —— 而这个分支存在的全部理由是那句话。
    #   变异验证发现：把 `if key in GLOBAL_KEYS` 改成 `if False`，上面那条断言照样
    #   绿。这一条就是补那个洞的。
    #   ★ v0.12：根因从"顺序"变成了"它住在**另一份文件**里"—— 通用键在主配置
    #     （`slurmate.conf`），插件那一份里写不下它。
    _msg = " ".join(pcfg("[plugin:sshd]\nenabled = yes\ncluster_cidr = 198.51.100.0/24\n")
                    .validate())
    check("★ 而且要说清是「它住在主配置里」，不是一句泛泛的「认不出这个键」",
          "通用键" in _msg and "主配置" in _msg, _msg[:160])

    # ★★ 同一个形状再来一条：**未知文件名**那句话必须说清"装插件"是**放一个包**，
    #   而不是"放一个目录"。这一句是管理员唯一会照着做的那句话，说错了对象就
    #   等于把他指到一个不存在的动作上（见 `stale_plugin_conf_problems` 的
    #   docstring：零插件与"名字写错了"是两种行动，而它们在配置里长得一模一样）。
    #   ★ 这句话住在 **⚠ 那一档**里（悬空不拦启动），所以要从
    #     `stale_conf_problems` 取，不是 `validate()`。
    _um = " ".join(pcfg("[plugin:ssh]\nenabled = yes\n").stale_conf_problems)
    check("★★ 未知文件名那句说清是「放一个 .splug 包」进安装目录，不是「放一个目录」",
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
    _se = cfg.plugin_config(SSHD).enabled
    try:
        cfg.default_plugin = SSHD
        cfg.plugin_config(SSHD).enabled = True
        cfg.enabled_kinds = tuple(sorted({q.name for q in cfg.plugins.values() if q.enabled}))
        _r8, _s8, _ = run_submit({"op": "submit", "ssh_pubkey": _pub8})
        check("★ 不带 service_kind 时**真的**落到配置里那个插件上（不是写死的名字）",
              _r8.get("ok") and _s8.get("service_kind") == SSHD,
              "%s / %s" % (str(_r8.get("error"))[:90], _s8.get("service_kind")))
    finally:
        cfg.default_plugin, cfg.enabled_kinds = _sd, _sk
        cfg.plugin_config(SSHD).enabled = _se

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
    _saved = cfg.plugin_config(SSHD).enabled
    cfg.plugin_config(SSHD).enabled = True
    cfg.enabled_kinds = tuple(sorted({q.name for q in cfg.plugins.values() if q.enabled}))
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
              env.get("SLURMATE_SSHD_BIN") == cfg.plugin_config(SSHD).bin
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
        cfg.plugin_config(SSHD).enabled = _saved
        cfg.enabled_kinds = tuple(sorted({q.name for q in cfg.plugins.values() if q.enabled}))

    # 19.5b ★ 默认资源是**按插件**的 —— 这是"插件的策略放在它自己那份配置里"最直接的体现
    #
    # 它不该是所有服务共用一个值的两个代码常量（DEFAULT_CPUS / DEFAULT_MEM）：
    # 在中转站里跑一个 shell 和在 IDE 里跑语言服务器不是一回事。它是那一份配置里的
    # 一项，缺失时才回落到插件自己的内建值。
    _sshd_id = cfg.resolve_plugin(SSHD)[0].id
    _saved_cfg = cfg.plugins[_sshd_id]
    try:
        # ★ 表按 **id** 收（短名可以重复），所以这里写回去也要按 id。
        cfg.plugins[_sshd_id] = mod.PluginConfig(
            cfg.resolve_plugin(SSHD)[0],
            {"enabled": "yes", "default_cpus": "7", "default_mem": "5G"}, True)
        cfg.enabled_kinds = tuple(sorted({q.name for q in cfg.plugins.values() if q.enabled}))

        _r, _sess, _env = run_submit({"op": "submit", "service_kind": "sshd",
                                      "ssh_pubkey": _pub})
        check("★ 省略 cpus/mem 时用【这个插件那份配置里】的默认值，不是全局那两个常量",
              _sess["cpus"] == 7 and _sess["mem"] == "5G",
              "%s / %s" % (_sess.get("cpus"), _sess.get("mem")))
        check("同一组默认值也传给了作业",
              _env.get("SLURMATE_CPUS") == "7" and _env.get("SLURMATE_MEM") == "5G",
              "%s / %s" % (_env.get("SLURMATE_CPUS"), _env.get("SLURMATE_MEM")))

        _r, _sess2, _ = run_submit({"op": "submit", "service_kind": "sshd",
                                    "ssh_pubkey": _pub, "cpus": 3})
        check("显式给的资源仍然覆盖那份配置里的默认值",
              _sess2["cpus"] == 3, str(_sess2.get("cpus")))
    finally:
        cfg.plugins[_sshd_id] = _saved_cfg
        cfg.enabled_kinds = tuple(sorted({q.name for q in cfg.plugins.values() if q.enabled}))

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
    # ★★ 时限在**同一格** `defaults` 里，因为它要回答的是同一个问题（"这个插件
    #   缺省给多少"），而客户端显示它的地方也只有那一处。★ 这一格不进协议的话，
    #   界面就永远说不出"这个会话能跑多久" —— 用户只能在作业被 `TimeLimit` 砍掉
    #   的那一刻第一次知道（F35 的形状：值算出来了、没送到能看见它的地方）。
    #
    # ★ 取值一律走 `.get`：直接下标的话，把这一格拿掉会让 `check(...)` 的**参数**
    #   先抛 KeyError，整份脚本崩在那一行 —— 那时"变异被发现了"与"用例自己坏了"
    #   在输出上分不开（崩了没有统计行、也没有那一条 FAIL）。`.get` 让它变成
    #   一条清清楚楚的红。
    check("★ defaults 里也有 time（少了它，界面说不出「能跑多久」）",
          _by[CS]["defaults"].get("time") == mod.DEFAULT_TIME
          and _by[SSHD]["defaults"].get("time") == mod.DEFAULT_TIME,
          str({k: v.get("defaults") for k, v in _by.items()}))
    # ★ GRES 那一格是**描述符或 null**（与 `submit` 的 `gres` 同一形状），不是数字：
    #   `null` = 本站没给这个插件配默认卡，那是**确定的事实**，而"这个键整个不在"
    #   = 老守护进程。三态，与 `can_submit` / `problems` 同一条。
    #   ★ 用 `.get` 取值：把这一格拿掉时，直接下标会让 `check(...)` 的**参数**先抛
    #     KeyError，整份脚本崩在那一行 —— 那时"变异被发现了"与"用例自己坏了"
    #     在输出上分不开。
    check("★ defaults 里也有 gpus，且没配时是 `null`（不是缺键、不是 0）",
          _by[CS]["defaults"].get("gpus", "缺") is None
          and _by[SSHD]["defaults"].get("gpus", "缺") is None,
          str({k: v.get("defaults") for k, v in _by.items()}))
    check("enabled 如实反映站点决定（sshd 默认关着）",
          _by[CS]["enabled"] is True
          and _by[SSHD]["enabled"] is False,
          str({k: v.get("enabled") for k, v in _by.items()}))
    check("★ 也报出没启用的插件 —— 「装了但停用」与「本站没有」是两回事",
          SSHD in _by)
    check("★ 不替客户端过滤它可能不认识的名字（那是升级提示的唯一来源）",
          all("name" in p and "title" in p for p in _by.values()))

    # ── 19.5g ★★ `default_gpus` 与「本站实际有的」对账（账本 F15 的去向）──────
    #
    # 判据是「**那份插件配置里**声明的资源」vs「本站的实际目录」，不是"插件清单里声明的"：
    # 作者写不出本站管那张卡叫什么（`gpu` 还是 `mps`、型号叫 `a100` 还是
    # `A100-PCIE-40GB`），那是本站在 `gres.conf` 里定的事实 —— 所以那一格**只在
    # 那儿**，而它必须有人对账：一个本站没有的卡名，症状是"这个插件的会话永远
    # 提交不了"，而提交期那句话（`bad_gres`）要等用户点下去才说。
    #
    # ★ 四态都在这里（对得上 / 对不上 / 没配 / 目录查不到），而**"它接没接到
    #   `--check` 上"由下一节那条端到端钉住** —— 只判这个函数的话，把 --check 里
    #   那一行删掉，全绿（F35 的形状：算出来了没送出去）。
    class _P(object):
        def __init__(self, name, g):
            self.name = name
            self.default_gpus = g
            self.spec = type("_S", (), {"id": "01M2JKHTZGKJBFQQTWYXMQMF2V"})()

    _cat = {"A6000": [{"name": "gpu", "type": "a100",
                       "per_node_max": 2, "total": 4}],
            "RTX8000": [{"name": "gpu", "type": None,
                         "per_node_max": 4, "total": 4},
                        {"name": "mps", "type": None,
                         "per_node_max": 100, "total": 100}]}

    _bad = mod.plugin_gres_problems(
        [_P("ide", {"name": "gpu", "type": "h100", "count": 1})], _cat)
    check("★ 本站没有这种资源 ⇒ 一条 ⚠，而且**点名本站有什么**"
          "（管理员据此改那一行，而不是去猜）",
          len(_bad) == 1 and "gpu:h100" in _bad[0]
          and "gpu:a100" in _bad[0] and "mps" in _bad[0], str(_bad))
    _big = mod.plugin_gres_problems(
        [_P("ide", {"name": "gpu", "type": "a100", "count": 3})], _cat)
    check("★ 名字对得上、数量超过每节点上限 ⇒ 也是一条（现在就说，不等提交时）",
          len(_big) == 1 and "3" in _big[0] and "2" in _big[0], str(_big))
    check("★ 对得上 ⇒ **一条都没有**（这一格不该有噪音）",
          mod.plugin_gres_problems(
              [_P("ide", {"name": "gpu", "type": "a100", "count": 2})], _cat) == [])
    check("★ 没配 ⇒ 一条都没有（不写 = 不占，没什么可对）",
          mod.plugin_gres_problems([_P("ide", None)], _cat) == [])
    # ★★ 目录查不到（`scontrol` 挂了）⇒ **一个字都不说**：与 `fit_gres()` 同一条
    #    fail-open。一次控制器抖动不该让自检说一句它并不确定的话 —— 而"报了但其实
    #    没事"正是这个项目一路在清的那种噪音。
    check("★★ 目录查不到 ⇒ 不报（fail-open，与 fit_gres 同一条；"
          "反过来的话一次控制器抖动会让自检满屏假警报）",
          mod.plugin_gres_problems(
              [_P("ide", {"name": "gpu", "type": "h100", "count": 1})], None) == [])

    # ── 19.5h ★★ 那条 ⚠ **真的接到了 `--check` 上**（不是只算出来）──────────
    #
    # ★★ F35 的教训：算出来了、没送出去，**任何变异都打不红**。上面一节判的是
    #    `plugin_gres_problems()` 的**返回值**；这一条判的是"它有没有被打印出来"。
    #    少了这一条，把 `--check` 里那一行删掉，全绿。
    #
    # ★ 这里**真的起一个子进程**跑 `--check`（不是调函数）：这条路的全部价值就在
    #   "管理员敲那条命令时看得见"，而中间隔着 Config、validate、几处 slurm 查询
    #   与一堆 print —— 只判函数的话，那一段一个字都没被执行到。
    #
    # ★ 假安装前缀：`default_plugins_dir()` 是从**守护进程自身的路径**推出来的
    #   （`<prefix>/sbin/…` → `<prefix>/share/slurmate/plugins`），而它**不是**
    #   配置项 —— 所以造一个假 prefix 是唯一能在用例里喂它一份插件表的办法。
    #   命令桩放在**另一个**目录，只进 PATH：`sbin/` 里多一个文件不会影响推导
    #   （它只看 `__file__`），但那两件事不该混在一个目录里，读的人会以为有关。
    _eprefix = os.path.join(tmpdir, "check-prefix")
    _ebin = os.path.join(_eprefix, "sbin")
    _eplug = os.path.join(_eprefix, "share", "slurmate", "plugins")
    _epath = os.path.join(_eprefix, "bin")
    for _d in (_ebin, _eplug, _epath):
        os.makedirs(_d, exist_ok=True)
    shutil.copyfile(DAEMON, os.path.join(_ebin, "slurmate-sessiond"))
    for _cmd in ("sbatch", "scancel", "squeue", "sacctmgr",
                 "sinfo", "sshare", "sacct"):
        write_stub(os.path.join(_epath, _cmd), "exit 0\n")
    # `show node -o` 是 GRES 的**唯一**来源；`show config` 那条决定 sbatch 要不要 -A。
    write_stub(os.path.join(_epath, "scontrol"),
               'case "$*" in\n'
               '  *"show node"*)\n'
               '    echo "NodeName=n1 NodeAddr=192.0.2.11 State=IDLE'
               ' Gres=gpu:a100:2 Partitions=A6000" ;;\n'
               'esac\n')
    install_package(_eplug, [("plugin.json", json.dumps({
        "id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "sshd",
        "version": "1.0.0",
        "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8"))])
    _econf = write_conf("cluster_cidr = 192.0.2.0/24\n"
                        "range_start = 55001\nrange_end = 55099\n",
                        "check-gres.conf")
    # ★ 插件配置是**它自己的一份文件**（`<主配置>.d/<名字>.conf`）。
    #   本站只有 `gpu:a100`，所以这里故意写一个没有的型号。
    write_plugin_conf(_econf, "sshd", "enabled = yes\ndefault_gpus = gpu:h100:1\n")
    _er = subprocess.run(
        [sys.executable, os.path.join(_ebin, "slurmate-sessiond"),
         "--check", "--config", _econf],
        capture_output=True, text=True,
        env=dict(os.environ,
                 PATH=_epath + ":" + os.environ.get("PATH", "/usr/bin:/bin")))
    check("★★ `--check` 真的把那条 ⚠ 打出来了（算出来了**也**送出去了）",
          "gpu:h100" in _er.stdout and "sshd" in _er.stdout,
          "rc=%s\n%s\n--- stderr ---\n%s"
          % (_er.returncode, _er.stdout[-700:], _er.stderr[-300:]))
    check("★★ 而且**点名本站有什么** —— 管理员照这一行改，不用去猜",
          "gpu:a100" in _er.stdout,
          _er.stdout[-700:])
    check("★ 它是 ⚠ 而**不是**启动错误：`--check` 照常以 0 退出"
          "（一个插件的这一行不该让整个站点起不来）",
          _er.returncode == 0,
          "rc=%s\n%s" % (_er.returncode, _er.stderr[-400:]))

    # ── 19.5i ★★ 悬空的 drop-in 文件：一条 ⚠，且**真的打得出来** ──────────────
    #
    # ★ 与 19.5h 逐字同一个理由（F35：算出来了、没送出去）。上面那条钉的是 gres
    #   那个 ⚠ 有没有接到 `--check` 上；这一条钉的是降下来的这一
    #   档 —— 它有两个出口（`--check` 打一条、`start()` 记一条日志），而只有
    #   `--check` 这一边**端到端跑得起来**（`start()` 要建 socket、连数据库、装
    #   nft 规则）。两个出口共用同一份数据，钉住一个、另一个靠评审 —— 与 gres
    #   那条的现状逐字同形。
    #
    # ★★ 这一条同时钉住"降档"**真的发生了**：`validate()` 里不再有它，所以
    #    `--check` 才走得下去 —— 反过来（留在 validate 里）的话，这条命令在打印
    #    任何东西之前就以 1 退出了，两三行断言一起红。
    #
    # ★ 复用上面那一节的假安装前缀与桩：`_eplug` 里只有 MF2V（sshd）。
    _stale_conf = write_conf("cluster_cidr = 192.0.2.0/24\n"
                             "range_start = 55001\nrange_end = 55099\n",
                             "check-stale.conf")
    _ghost = "01M2JKHTZGKJBFQQTWYXMQMF63"    # 本站**没装**它
    _p_ghost = write_plugin_conf(_stale_conf, _ghost, "enabled = yes\n")
    _p_hand = write_plugin_conf(_stale_conf, "typo", "enabled = yes\n")
    _sr = subprocess.run(
        [sys.executable, os.path.join(_ebin, "slurmate-sessiond"),
         "--check", "--config", _stale_conf],
        capture_output=True, text=True,
        env=dict(os.environ,
                 PATH=_epath + ":" + os.environ.get("PATH", "/usr/bin:/bin")))
    check("★★ 悬空的 drop-in（安装器起的那份）⇒ `--check` 把它打出来，点名**文件路径**",
          _p_ghost in _sr.stdout and (_ghost + ".conf") in _sr.stdout,
          "rc=%s\n%s\n--- stderr ---\n%s"
          % (_sr.returncode, _sr.stdout[-700:], _sr.stderr[-300:]))
    check("★★ 而且指出「跑一次 plugin sync」—— 那是唯一修得了它的动作",
          "plugin sync" in _sr.stdout, _sr.stdout[-700:])
    _sln = [ln for ln in _sr.stdout.splitlines() if _p_hand in ln]
    # ★ 判"它这一段不说那句话"的取法：它按**文件名**排在最后（`typo.conf` 排在
    #   那个 ULID 后面），所以从它那一行到输出末尾就是它这一段。
    #   ★★ 不能用"含路径的那**一行**" —— 指路那句在**下一行**（hint 是多行的）。
    #   变异验证查出来的：把 hint 改成无条件加，只判一行的写法照样绿。而这条
    #   用例的全部价值就在"两种成因的报法不同"上。
    _idx = _sr.stdout.find(_p_hand)
    check("★★ 手写的（短名）那份也在，但**不说**那句话"
          "（sync 不会替他删手写的文件，说了就是骗人）",
          len(_sln) == 1 and _idx >= 0 and "plugin sync" not in _sr.stdout[_idx:],
          ("（那一份一个字都没出现）" if _idx < 0 else _sr.stdout[_idx:][:300]))
    check("★★ 而 `--check` **照常以 0 退出**：悬空是 ⚠，不是启动错误"
          "（一个指不到人的文件不该让整个站点起不来）",
          _sr.returncode == 0,
          "rc=%s\n%s" % (_sr.returncode, _sr.stderr[-400:]))

    # 19.5d ★★ 插件目录的形状（跨语言契约，重定义为"两边读的是同一份东西"）
    #
    # 这一节钉的是「守护进程读到的表」与「客户端清单」逐字一致。守护进程一个
    # 插件名都不写：表是扫出来的，而它扫的正是仓库里那两个真插件。于是这条钉子的
    # 含义是：
    #
    #     仓库 plugins/<目录>/plugin.json 是**唯一**的真相来源，
    #     守护进程读到的必须与文件里的逐字一致。
    #
    # ★ 这仍然值得一条用例：客户端那一半也是从同一份清单读
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
    _cs_spec = cfg.resolve_plugin(CS)[0]
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
    # `Store._migrate()`（给旧库自动 ALTER TABLE ADD COLUMN 的那条路）不在了 ——
    # 它只在旧库上跑，而旧库不存在（见 0.y 的判据）。于是
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
    # ★ `files`（清单）+ `plugin_file`（一份文件一次 RPC）这条旁路已经不在了，
    #   而这一节钉的就是"删干净了没有"，两件：
    #
    #   ① `files` 与 `plugin_file` **真的不在了** —— 不是"还留着但不报"。
    #      留着 `plugin_file` 不只是多一条代码路径，是多一条**验签绕得过去**的路：
    #      它发的是散装字节，客户端拼不出一个能被签名的东西（见 op_plugin_package
    #      的注释）。所以"它还在"必须是一条会红的用例，而不是一句注释里的承诺。
    #   ② 「本站支不支持分发」的判据是顶层**有没有 `limits`**，不是"这一项里有没有
    #      `files`"。
    #
    # ★ 这一节不测逐份取的三条边界（路径白名单 / 单文件上限 / 启动后被换过）：
    #   它们**跟着 op 一起走了**，不是丢了：前两条今天由客户端读方执行
    #   （`checkDeclared` 的 `file_bytes`，见 client/test/site-plugins.test.mjs），
    #   第三条由 `plugin_package_changed` 在 19.11c 里原样守着。
    _d2 = mod.Sessiond(cfg)
    _cs_spec = cfg.resolve_plugin(CS)[0]

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
    # ★ 这个夹具不必摆 `.gitignore`、`node_modules/`、两个符号链接来演"哪些东西
    #   不该进清单"：这些**在包里表达不出来** ——
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
    # ★ 这里不摆一条"一次对账 1 + 1 + N 次，正好压在桶边上"的断言，因为它
    #   **永远绿**：N 是客户端的行为（客户端那边数得清，见
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

    _cs4 = cfg.resolve_plugin(CS)[0]
    _pk4 = {n: _plug_of(n) for n in (CS, SSHD)}
    check("★★ 加法过渡**结束了**：每条只剩 package，`files` 那个键不在 "
          "（v0.6 两条同时在，v0.7 只留这一条）",
          bool(_pk4) and all("files" not in (x or {})
                             and (x or {}).get("package") is not None
                             for x in _pk4.values()),
          str({k: sorted((v or {}).keys()) for k, v in _pk4.items()})[:200])

    for _n in (CS, SSHD):
        _spec = cfg.resolve_plugin(_n)[0]
        _info = (_pk4.get(_n) or {}).get("package") or {}
        # ★ "盘上那一份"是**一棵树 + 一份记录表**：把这两样现对一遍账，
        #   再照记录表重打一个包 —— 报出去的三样事实必须与它相符。
        # ★ 打出来的**只含客户端侧**（`plugin_rebuild` 的默认侧），所以
        #   比的摘要是 `dist["digest"]`（= 四元组里的 `digestClient`），不是
        #   `digest`（整棵树那个 —— 它是插件的身份，走另一条路报）。
        _blob, _disk = mod.plugin_rebuild(cfg.plugins_dir, _spec.id)
        check("★★ op_plugins 报的 package 三样事实与**现打出来的那一份**相符（「%s」）" % _n,
              _disk["ok"] and _blob is not None
              and _info.get("format") == mod.PACKAGE_FORMAT
              and _info.get("bytes") == len(_blob)
              and _info.get("digest") == _disk["dist"]["digest"]
              and _info.get("digest"),
              "%s vs ok=%s bytes=%s digest=%s"
              % (_info, _disk.get("ok"), _blob and len(_blob),
                 _disk.get("dist", {}).get("digest")))

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
                 ("client/index.js", b"module.exports = {};\n"),
                 # ★ 站点侧那一份**必须在**：下面判据①那一条要问"发出去的那一份里
                 #   有没有站点侧路径"，而树上本来就没有的话那条断言是**空的**。
                 ("job/start.sh", b"start_dg() { :; }\n")]
    # ★★ 那一个"补了签名块"的包**必须用真签名**：站点在**每次对账时**
    #   验签（记录表里的 sha256 列本身没有认证，签名是它的解药），所以一个随手编
    #   的签名块根本装不进去、也扫不出来。用假签名测，测到的是"验签把这一份拒了"，
    #   与这一节要验的"摘要不看信封"是两回事。
    if not openssl_bin():
        check("★★ 本机没有 openssl —— 这一节要的「补一个真签名块」测不了"
              "（不是「跳过」，是这条判据的核心没被验到）", False, "装一个 openssl 再跑")
    _k4 = openssl_make_key(tmpdir, "k4")
    _sigblock = None
    if _k4:
        _dg_quad = quadruple_of(_dg_files)
        _dg_sig = openssl_sign(_k4[0], mod.package_signed_message(_dg_quad))
        if _dg_sig:
            _sigblock = sig_block_of(_dg_quad, _k4[1], _dg_sig)
    check("测试用的那把 Ed25519 钥匙造出来了，而且签得动", _sigblock is not None)
    _plain_bytes = build_package(_dg_files)
    _signed_bytes = build_package(_dg_files, _sigblock or b"")
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
    _saved_src4 = _cs4.install_dir
    try:
        # ★ "盘上那一份"是**一棵树 + 一份记录表**，所以换内容 = 换那棵树
        #   （`install_package` 照安装器的形状摆一份）。`spec.install_dir` 是这里
        #   唯一的指针 —— 记录表就住在它旁边，见 `plugin_record_path()`。
        install_package(_fx4, _dg_files)
        _cs4.install_dir = mod.plugin_tree_dir(_fx4, _cs4.id)
        _d4._plugin_cache.clear()          # 清缓存 = 模拟"守护进程重启一次"
        _a_pkg = (_plug_of(CS) or {}).get("package") or {}

        # 同一个负载、换成一个**带签名块**的包（容器字节变长 188+版本号 字节）
        install_package(_fx4, _dg_files, sig_block=_sigblock)
        _d4._plugin_cache.clear()
        _b_plug = _plug_of(CS) or {}
        _b_pkg = _b_plug.get("package") or {}
        check("★★ op_plugins 报出去的也是**内容摘要**：补上签名块之后整包字节数变了、"
              "摘要**一个字都没变**",
              _a_pkg.get("bytes") != _b_pkg.get("bytes")
              and _a_pkg.get("digest") == _b_pkg.get("digest") and _a_pkg.get("digest"),
              "%s vs %s" % (_a_pkg, _b_pkg))

        # ── 整包取：字节逐字节等于**现打出来的那一份** ──
        _pr = _pp({"op": "plugin_package", "id": _cs4.id, "version": _cs4.version})
        _pd = _pr.get("data") or {}
        _got = base64.b64decode(_pd.get("data") or "")
        _want4, _wr = mod.plugin_rebuild(_fx4, _cs4.id)
        check("★★ op_plugin_package 发回来的字节与你照记录表现打的那一份**逐字节全等**",
              _wr["ok"] and _got == _want4 and len(_got) > 0,
              "%d vs %d 字节" % (len(_got), len(_want4 or b"")))

        # ★★★ 判据①（**本版的主题**）：站点真的发出去的那一串字节里**没有站点侧路径**。
        #
        #   ★ 这一条**不能**再拿 `plugin_rebuild` 自己算的东西当参照物 —— 上面那条
        #     "逐字节全等"两边用的是**同一个函数**，于是"它默认发哪一侧"写错时两边
        #     **同向漂移、谁也看不见**。这不是理论：变异验证 M3（把 `plugin_rebuild`
        #     的默认侧从 `"client"` 改回 `None`）跑出来正是**绿的**，而那一刻站点
        #     真的在往用户机器上发 `job/start.sh`。
        #   ⇒ 参照物必须是**与实现无关**的东西：这里解析的是 RPC 响应里那一串 base64。
        _gp = mod.package_parse(_got)
        check("★★ 发出去的那一份里**没有一条站点侧路径**"
              "（判据①：用户机器上没有 job/）",
              _gp["ok"] and all(mod.package_is_client_side(f["path"])
                                for f in _gp["files"]),
              repr([f["path"] for f in (_gp["files"] if _gp["ok"] else [])]))
        check("★ 对照：站点**自己的树**上确实有站点侧那一份（不是「本来就没有」）",
              any(not mod.package_is_client_side(f["path"])
                  for f in mod.plugin_reconcile(_fx4, _cs4.id)["files"]),
              repr([f["path"] for f in mod.plugin_reconcile(_fx4, _cs4.id)["files"]]))
        check("★ 而它**比整包小** —— 差的就是站点侧那几份的负载与记录"
              "（发整包的话这两个数会相等）",
              len(_got) < mod.record_container_bytes(
                  mod.plugin_reconcile(_fx4, _cs4.id)["record"]),
              "%d vs 整包 %d" % (len(_got), mod.record_container_bytes(
                  mod.plugin_reconcile(_fx4, _cs4.id)["record"])))
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

        # ★ 启动之后**那棵树被换过**：**要说出来**，而不是把对不上的字节发出去
        #   让客户端去报"校验不过"（那是同一个事实，但会让运维去查错的地方）。
        #
        # ★ 这件事**自己就会被发现**：出口每次都重新对账（读记录表 + 逐份
        #   比 + 验签），所以"就地改一个字节"在下一次取的时候就对不上账了 ——
        #   而**只是把记录表换掉**（树不动）也会，因为摘要从记录表重算、签名盖的是它。
        _tree4 = mod.plugin_tree_dir(_fx4, _cs4.id)
        with open(os.path.join(_tree4, "client", "index.js"), "wb") as _f:
            _f.write(b"module.exports = { tampered: true };\n")
        _cc4, _ck4, _cd4 = _kindof(_pp({"op": "plugin_package",
                                        "id": _cs4.id, "version": _cs4.version}))
        check("★★ 那一棵树在本次启动之后被改过一个字节 ⇒ 9 plugin_package_changed",
              _cc4 == 9 and _ck4 == "plugin_package_changed",
              "code=%s kind=%s detail=%s" % (_cc4, _ck4, _cd4[:120]))
        check("★★ 而且那句话**点名是哪一份文件**（只说「对不上」等于让运维去猜）",
              "client/index.js" in _cd4, repr(_cd4[:200]))
        check("★★ 而不是把这一份发出去让客户端报「校验不过」—— 那句话里指向"
              "**重装一次那个插件**",
              "重装" in _cd4 and "客户端" not in _cd4, repr(_cd4[:200]))
        _after = (_plug_of(CS) or {}).get("package") or {}
        check("★★ 快照是**启动那一刻**：换完之后 op_plugins 报的还是当初那一个"
              "（快照与这一条回答的是同一份内容）",
              _after.get("digest") == _b_pkg.get("digest")
              and _after.get("bytes") == _b_pkg.get("bytes"),
              "%s vs %s" % (_after, _b_pkg))

        # ── 超过整包上限：明确拒绝，**不把 2 MiB 硬塞进一条应答** ──
        #    正常部署下安装器已经拦住了这种包；这一条拦的是绕过安装器放进来的一份。
        # ★★ 超限的那一份必须**在客户端侧**（`client/big.bin`）：判据比的是**要发出
        #    去的那一份**（只含客户端侧），放在站点侧的话它根本不会被打进
        #    那个包，于是这一条会**静默失效** —— 绿着，而它什么也没测。
        _big_files = [("plugin.json", b'{"id":"%s","name":"dg","displayName":"x",'
                                      b'"version":"1.0.0"}' % _cs4.id.encode()),
                      ("client/big.bin", b"x" * (mod.PLUGIN_PACKAGE_MAX_BYTES + 1))]
        install_package(_fx4, _big_files)
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

        # ── 那一份**不见了**：`package` 是 null，而**能力仍然在** ──
        #
        # ★ 这两件事必须分得开：「这一份现在给不出来」是瞬时的、是这一份的事；
        #   「本站没有这个能力」是协议事实（顶层没有 limits）。合成一个信号的话，
        #   一次误删文件会让客户端把整站降级。
        # ★ "不见了"= **树与记录表都没了**（不是把 install_dir 指到别处 —— 记录表
        #   就住在树旁边，指错地方仍然找得到同一个 id 那一份）。
        shutil.rmtree(mod.plugin_tree_dir(_fx4, _cs4.id), ignore_errors=True)
        os.unlink(mod.plugin_record_path(_fx4, _cs4.id))
        _d4._plugin_cache.clear()
        _gone = _plug_of(CS) or {}
        check("★★ 那一份不见了 ⇒ package 是 **null**（不是把这个键省掉）",
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
              "code=%s kind=%s detail=%s" % (_gc4, _gk4, _gd4[:120]))

        # ── ★ 那一份在**两次读之间**消失（快照说在、现读说读不动）──
        #
        # `op_plugin_package` 读两次：第一次经**启动快照**（`plugin_package()`，
        # 那是缓存的），第二次**现对账 + 现打**。上一条走的是"快照里就没有"那个
        # 出口；这一条走的是**另一个**出口 —— 快照里还在，而现读时它没了。
        # 两句都是 `9 plugin_package_changed`，但说的是两件事。
        #
        # ★ 顺序是承重的：**先问一次 `op_plugins`**（那一步会把快照填上），再删。
        #   反过来的话快照本身就是"不在"，于是走到的是上面那个出口 —— 那这一条
        #   看起来绿了，而其实什么都没测到。
        install_package(_fx4, _dg_files)
        _cs4.install_dir = mod.plugin_tree_dir(_fx4, _cs4.id)
        _d4._plugin_cache.clear()
        _live = _plug_of(CS) or {}
        check("这条用例自己的前提：快照里那一份**是在的**",
              isinstance(_live.get("package"), dict), repr(_live.get("package")))
        # ★ 删的是**记录表**：树还在，而没有记录表 = 这次安装没提交。
        os.remove(mod.plugin_record_path(_fx4, _cs4.id))
        _rc4, _rk4, _rd4 = _kindof(_pp({"op": "plugin_package",
                                        "id": _cs4.id, "version": _cs4.version}))
        check("★★ 记录表在两次读之间消失 ⇒ 9 plugin_package_changed（说的是「没提交」）",
              _rc4 == 9 and _rk4 == "plugin_package_changed"
              and "没有记录表" in _rd4,
              "code=%s kind=%s detail=%s" % (_rc4, _rk4, _rd4[:120]))
        check("★ 而它没有被兜成 9 internal（那句话指不回插件，运维会去查别的地方）",
              _rk4 != "internal", repr(_rk4))
    finally:
        _cs4.install_dir = _saved_src4
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
    # ★ CLI 上限与站点通报的**总量**上限必须拉开：两者同为 1 MiB 的话，
    #   "整包一次发"那个数就是一句假话（1 MiB 的负载 base64 之后 1.33 MiB）。
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
    #   引，算摘要也用它）。它若住在 install.js 里，那就是"两个地方各持一份"的开端。
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

    # ── 19.13 ★ 包来源目录：哪些文件算"要装的包" ─────────────────────────────
    #
    # ★★ 这条判据住在安装器里（`plugin_src_files()` / `plugin_src_problems()`），
    #    可以**直接调** —— 若把它留在 install-base.sh 的 bash 里，就只好把那段
    #    **抠出来真跑**（install-base.sh 本机跑不了整套：要 root + 一台控制节点，
    #    见 KNOWN-ISSUES 的 U2），"用例验的是不是那一份实现"这个隐患也就消不掉。
    #
    # ★ 它挡的是一件很具体的事：管理员把插件的**源码树**复制进了包目录，以为
    #   装上了 —— 而安装器只列 `*.splug`，那几棵树会被**静默忽略**。所以
    #   "哪些算包"与"别的东西在这儿"是**两条**判据，都要有。
    #
    # ★ 符号链接那一条是承重的：一个叫 `x.splug` 的链接能指向任何地方、还能随时
    #   换目标，于是"我读到的那一份"与"校验过的那一份"不是同一份 —— 那正是整节
    #   要防的事。
    print("\n── 19.13. 包来源目录：哪些文件算包（判据只有一份）──")
    _gate = tempfile.mkdtemp(prefix="slurmate-gate-")
    try:
        def _touch(rel, blob=b"x\n"):
            p = os.path.join(_gate, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as _f:
                _f.write(blob)
            return p

        _real_pkg = _touch("vendor-1.0.0.splug", b"splug\x1a\r\n" + b"\0" * 12)
        _touch("notes.txt")                    # 随手放的文件
        _touch("README")                       # 说明文件
        _touch("old/plugin.json", b"{}")       # 一个目录（站点只认包）
        _touch("nested/deep.splug")            # 子目录里的包（不扫第二层）
        os.symlink(_real_pkg, os.path.join(_gate, "linked.splug"))
        os.symlink("/etc/passwd", os.path.join(_gate, "passwd.splug"))
        _got = set(mod.plugin_src_files(_gate))
        check("★★ 恰好列出那一个真正的包文件",
              _got == {_real_pkg}, repr(sorted(_got))[:200])
        check("★★ 符号链接冒充 `.splug` 进不了名单（它随时可以换目标）",
              not any("linked.splug" in p or "passwd.splug" in p for p in _got),
              repr(sorted(_got))[:200])
        check("★ 目录、散落的文件、子目录里的包都不进名单"
              "（它们**不该在这儿**，由下面那条逐条点名）",
              not any("old/" in p or "notes.txt" in p or "README" in p
                      or "nested" in p for p in _got),
              repr(sorted(_got))[:200])

        # ★★ 而"它们在这儿"必须**说出来** —— 不说就是静默忽略：管理员以为装上了。
        #    四种成因各点名一条（三种"看着像包但不是"、一种"根本不是包"）。
        _probs = mod.plugin_src_problems(_gate)
        _ptxt = "\n".join(_probs)
        check("★★ 目录里除 .splug 之外的东西**逐条点名**（不说就是静默忽略）",
              len(_probs) == 6, "\n".join(x.split("\n")[0] for x in _probs))
        check("★★ 源码树那一种要说清成因（最常见的那个）",
              "README" in _ptxt and "源码树" in _ptxt, _ptxt[:300])
        # ★ 两种成因的**修法完全不同**（"把链接换成一个真的包" vs "把文件搬走"），
        #   所以措辞必须分得开 —— 一句"这里有不合法的东西"两种都盖不住。
        check("★ 名字像包、却是符号链接的 ⇒ 说「符号链接」",
              "linked.splug" in _ptxt and "符号链接" in _ptxt, _ptxt[:400])
        check("★ 压根不是包的（目录、散落的文件）⇒ 说「不是一个插件包」",
              "notes.txt" in _ptxt and "不是一个插件包" in _ptxt
              and "符号链接" not in _ptxt.split("notes.txt")[1].split("\n")[0],
              _ptxt[:400])
        # ★★ v0.13 加的一条**指路**，它是"包名统一成 `<id>.splug`"的连带后果：
        #    同一个 id 的两个版本**没法共用一个文件名** ⇒ 按版本分目录存放成了很
        #    自然的做法（`dist/1.0.0/<id>.splug`）⇒ 而 `--from` **不递归**，
        #    那几份包一个都装不上。
        #    ★ 只说"不会被安装"是不够的：管理员接着要问的正是"那我该怎么装"，
        #      而答案（`--from` 各自来一次）**只有这里能说**。
        check("★★ 子目录里有包 ⇒ 那条话要**指路**（一次只认一个目录、不递归）",
              "nested" in _ptxt and "不递归" in _ptxt and "--from" in _ptxt,
              _ptxt[:600])
        check("★ 而「里面没有包的目录」走的是原来那条（两种成因的修法不一样："
              "一种是把里面的包搬出来，一种是它压根不该在这儿）",
              os.path.join(_gate, "old") in _ptxt
              and "不是一个插件包" in _ptxt.split(os.path.join(_gate, "old"))[1][:200],
              _ptxt[:600])
        # ★★ 上一条的**正对照**：一个只有包的目录必须一条问题都不报 —— 少了它，
        #    "什么都报"也能让上一条通过。
        _clean = tempfile.mkdtemp(prefix="slurmate-gate-clean-")
        try:
            _touch2 = os.path.join(_clean, "a.splug")
            with open(_touch2, "wb") as _f:
                _f.write(b"splug\x1a\r\n" + b"\0" * 12)
            check("★★ 对照：一个只有包的目录 ⇒ 一条问题都没有"
                  "（否则上一条会被「什么都报」一并满足）",
                  mod.plugin_src_problems(_clean) == [],
                  repr(mod.plugin_src_problems(_clean)))
        finally:
            shutil.rmtree(_clean, ignore_errors=True)
    finally:
        shutil.rmtree(_gate, ignore_errors=True)

    # ── 19.13b ★★ install-base.sh 剩下的那一半**不认识插件** ──────────────────────
    #
    # ★ 这一条是那次拆分的**验收判据**（计划里的判据②）：插件那一半
    #   搬走之后，基座安装脚本里不该再出现"插件目录""作业脚本目录""drop-in 目录"
    #   这些概念 —— 一个路径一旦有两个写方，就多一次"脚本以为装到了 A、守护进程
    #   扫的是 B"的机会。
    #
    # ★ 判据是**标识符**而不是"提没提 plugin 这个词"：文件头里必须**说清楚**
    #   插件搬到哪儿去了（那是给管理员看的），那是文字；而变量名与路径是判据。
    print("\n── 19.13b. 拆开之后：基座安装脚本不认识插件 ──")
    _ib = os.path.join(HERE, "install-base.sh")
    with open(_ib, encoding="utf-8") as _f:
        _ib_src = _f.read()

    def _code_only(src):
        """**只留代码行**：注释里必须说清"插件搬到哪儿去了"（那是给管理员看的），
        所以判据是代码，不是文件里提没提那个词。"""
        return "\n".join(ln for ln in src.split("\n")
                         if not ln.lstrip().startswith("#"))

    _ib_code = _code_only(_ib_src)
    for _bad in ("PLUGINS_DIR", "JOBS_DIR", "PLUGINS_MARKER", "JOBS_MARKER",
                 "CONF_D", "PLUGINS_SRC", "plugin_src_files", "PLUGIN_PKGS",
                 "--install-plugins", "--sync-plugins", "--check-plugins"):
        # ★ 判据要**认出标识符**，不能是子串：`CONF_D` 是 `CONF_DIR` 的前缀，
        #   子串匹配会让"drop-in 目录还在脚本里"这条**永远红**（假红）。
        _pat = r"(?<![\w-])%s(?![\w-])" % re.escape(_bad)
        check("★★ 基座安装脚本的**代码**里没有 %s（插件那一半真的搬走了）" % _bad,
              re.search(_pat, _ib_code) is None,
              repr([l.strip() for l in _ib_code.split("\n")
                    if re.search(_pat, l)][:2]))
    check("★ 而它**调用**卸载器来收掉插件（判据仍然只有一份，不在脚本里抄一遍）",
          "--uninstall-plugins" in _ib_src and "--all-plugins" in _ib_src)
    check("★ 作业模板装到了 <SHARE_DIR>/run.sbatch.template"
          "（装完基座之后集群上可能根本没有仓库）",
          "run.sbatch.template" in _ib_src)
    # ★★ 而"插件搬到哪儿去了"必须**读得到**：`--help` 的范围表达式若写成
    #    `sed -n '2,/^# =====/p'`，它会在**第 2 行自己**就闭合 —— 于是只印横幅
    #    那一行，整个用法块一次都打不出来。那不是"一个没人用的开关"：管理员找
    #    不到插件入口时，第一件事就是跑 `--help`。
    #    ★ 它不需要 root（`-h` 在参数解析那一轮就 `exit 0` 了），所以这条能真跑。
    _h = subprocess.run(["bash", _ib, "--help"], capture_output=True, text=True)
    check("★★ `--help` 真的把用法印出来（不是只印标题那一行）",
          _h.returncode == 0 and "--uninstall" in _h.stdout
          and "slurmate plugin install" in _h.stdout
          and len(_h.stdout.splitlines()) > 20,
          "rc=%d %d 行 %r" % (_h.returncode, len(_h.stdout.splitlines()),
                              _h.stdout[:120]))
    # ★★ 而"插件搬到哪儿去了"这条指路，**两种写法都要给出能跑的命令**：
    #    `--plugins-src=X` 的 X 在同一个参数里，`--plugins-src X` 的在**下一个**。
    #    只认等号那一种的话，管理员照最顺手的写法敲，拿到的指路里那一条命令
    #    **自己是跑不通的**（印出来是 `--from --plugins-src`）—— 而"照它做"正是
    #    读到这句话的人唯一会做的事。★ 判据是"`--from` 后面跟着那个目录"，
    #    不是"提没提插件"（那样两种写法都会绿）。
    for _argv, _want in ((["--plugins-src", "/tmp/pkgs"], "/tmp/pkgs"),
                         (["--plugins-src=/tmp/pkgs"], "/tmp/pkgs")):
        _p = subprocess.run(["bash", _ib] + _argv, capture_output=True, text=True)
        check("★★ `%s` 的指路给出的是**能跑的命令**（`--from` 后面跟着那个目录）"
              % " ".join(_argv),
              _p.returncode == 2
              and ("slurmate plugin install --from %s" % _want) in _p.stderr,
              "rc=%d %r" % (_p.returncode, _p.stderr[-160:]))
    check("★ 基座安装脚本**调用**守护进程的 --check，而不是自己再判一遍"
          "（端口区间 / Slurm 命令那些判据从前在这里各有一份孪生实现）",
          '"$DAEMON_SRC" --check --config=' in _ib_src)
    # ★★ 而"不再自己判一遍"这句话要**真的红得起来**：那几条孪生实现各自有一
    #    个特征串（端口区间重叠的判定、Slurm 命令清单、cidr 交叉核对）。它们
    #    一个都不该留在基座脚本里 —— 留在那里就是"同一件事两份判据"。
    for _dup in ("ip_local_reserved_ports", "reserved_ranges", "scontrol"):
        check("★★ 基座安装脚本里不再有 %r 那份孪生判据" % _dup,
              _dup not in _ib_code,
              repr([l.strip() for l in _ib_code.split("\n") if _dup in l][:2]))

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

        # ★★ v0.13：**两侧**的摘要（A.3 的四元组要这两个数）。这一条同时是
        #    "打包器与守护进程对同一棵树算出的两个摘要逐字相同"那个判据 ——
        #    夹具里那两个数是**打包器那一侧**算的（`generate.mjs` 自己那份实现），
        #    而这里用守护进程的实现重算一遍。
        _sd = mod.package_side_digests(_r["files"])
        check("★★ 两侧的内容摘要与夹具逐字相同（打包器 / 守护进程两份实现）",
              _sd["site"] == _exp["sides"]["site"]["digest"]
              and _sd["client"] == _exp["sides"]["client"]["digest"],
              "%r vs %r" % (_sd, _exp["sides"]))
        # ★ 两侧**不是互补的**：两个顶层元数据文件两侧都在。写错成"客户端侧的补集"
        #   的话，站点侧的摘要会少算两份文件，而那个数**只**在签名里出现一次 ——
        #   症状是"签名验不过"，排查的人会去查钥匙。（`generate.mjs` 自己就错过一次。）
        _site_paths = [f["path"] for f in mod.package_sides(_r["files"])["site"]]
        check("★ 两个顶层元数据文件在**站点侧**里（站点侧不是客户端侧的补集）",
              "plugin.json" in _site_paths and "lineage.json" in _site_paths
              and "client/index.js" not in _site_paths,
              repr(_site_paths))
        check("★ 而两侧的那份 `client/**` 与 `job/**` 各自归位",
              "client/extra.js" in _exp["sides"]["client"]["files"]
              and "job/start.sh" in _exp["sides"]["site"]["files"],
              repr(_exp["sides"]))

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

    # ★★ **包解析器不验签**，这是一条**有断言的**事实，不是一件被忘掉的事。
    #
    #    它只判"这个包自己跟自己一致吗"（记录表、逐份 sha256、长度方程）；签名块
    #    只解析、并把签名者报出来给管理员看，不判它成不成立。所以夹具里那两条
    #    "只有会验签的一端才拒得了"的坏包，在这里**预期会被收下**。
    #
    #    ★★ **站点也验签了，只是在另一个地方**（`plugin_reconcile`：每次
    #      启动对账、以及每次分发前现算），那里问的是另一个问题 —— "盘上这一份
    #      是不是当初装进来的那一份"。上面那条断言说的**只是解析器**，别读成
    #      "站点从不验签"；两者的分工写在 `package_parse` 的注记里。
    #
    #    ★ 这一节仍然不验签的理由没变：给一个以 root 跑在集群上的进程加一份自己
    #      实现的密码学，是这条路上最不该省的那一步的**反面** —— 要验就调系统
    #      openssl（见 `openssl_verify_ed25519`）。
    _needs_verify = [c for c in _bad["cases"] if c.get("needs") == "verify"]
    check("★ 夹具里至少有两条是「只有会验签的一端才拒得了」的",
          len(_needs_verify) >= 2, repr([c["name"] for c in _needs_verify]))
    for _c in _needs_verify:
        _g = mod.package_parse(_unhex(_c["hex"]))
        check("★★ 包解析器**收下**它（%s）—— 解析器不验签，这是分工不是漏洞"
              % _c["name"],
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

    # ★★ **第四份实现**：`package_build()`（Python）与 `packer/slurmate-packer.js`
    #    的 `buildPackage`、客户端的 `buildPackage` 必须**逐字节相同**（§3.5）。
    #
    #    这是**最值钱的一条检查**：站点侧要**从一棵树现打一个包**发给客户端
    #    （容器不在盘上），于是"同一个内容打出来的字节"有了两个来源。它们漂开的
    #    症状是"站点发出去的包客户端解析得了、而摘要对不
    #    上" —— 排查方向会先落到钥匙上。
    #
    #    ★ 判据是**逐字节全等**，不是"摘要一样"：摘要不吃信封（§3.4），所以记录表
    #      次序变了、长度字段写错了，摘要都会照样相同，而客户端会解析出一个与你
    #      报的不一样的东西。
    _again = mod.package_build(
        [{"path": f["path"], "sha256": f["sha256"],
          "data": _good[f["offset"]:f["offset"] + f["size"]]}
         for f in _r["files"]], b"")
    check("★★ 第四份实现：照着记录表重打一个包 ⇒ 与打包器产出的字节**逐字节全等**",
          _again == _good,
          "%d vs %d 字节；首个不同在 %s"
          % (len(_again), len(_good),
             next((i for i in range(min(len(_again), len(_good)))
                   if _again[i] != _good[i]), "（长度不同）")))
    if _s["ok"] and _s.get("sig"):
        _sigblk = mod._envelope_bytes(mod._record_envelope(_s["sig"]))
        _again_s = mod.package_build(
            [{"path": f["path"], "sha256": f["sha256"],
              "data": _signed[f["offset"]:f["offset"] + f["size"]]}
             for f in _s["files"]], _sigblk)
        check("★★ 带签名的那一份同样逐字节全等（签名块也被原样重建）",
              _again_s == _signed,
              "%d vs %d 字节" % (len(_again_s), len(_signed)))
    # ★ 而"记录表次序"确实是这个等式的一部分：把次序倒过来重打，内容摘要不变、
    #   字节却不同 —— 所以上面那两条不是"两边都算了个常量"。
    _revb = mod.package_build(
        [{"path": f["path"], "sha256": f["sha256"],
          "data": _good[f["offset"]:f["offset"] + f["size"]]}
         for f in reversed(_r["files"])], b"")
    check("★ 对照：倒着打出来的字节**不一样**，而摘要一样"
          "（次序是字节等式的一部分，不是摘要的一部分）",
          _revb != _good
          and mod.package_parse(_revb)["digest"] == _exp["digest"],
          "%r" % (_revb == _good))

    # ── ★★ 阶段 4：**站点发出去的那一份**（只含客户端侧）与第四份实现的对账 ──
    #
    # 上面那两条对的是**整包**（作者发的那一份）。这一条对的是**站点→客户端那一段
    # 真正发出去的字节** —— 只含客户端侧。它是本版唯一一处"**装哪几份**"的跨实现
    # 判据：另三份实现（打包器 / 客户端 / 夹具）从来都只处理"一整棵树"，按侧筛是
    # 这一版新加的一步，而它只写在第四份实现里。
    #
    # ★ 参照物是**真的打包器**打的（`generate.mjs` 里 `PACKER.buildPackage`），
    #   不是本文件手拼的 —— 手拼的话，这一条就退化成"我跟我自己比"。
    _cli = _unhex(_exp["clientSide"]["hex"])
    _c = mod.package_parse(_cli)
    check("★★ 只含客户端侧的那一份是一个**合法包**"
          "（A.4 第 10 步③只核**包里在的那几侧**）",
          _c["ok"], "%s %s" % (_c.get("code"), _c.get("why")))
    if _c["ok"] and _s["ok"] and _s.get("sig"):
        check("★ 它里面**没有一条站点侧路径** —— 判据①（用户机器上没有 job/）"
              "在这一层的可执行形式",
              all(mod.package_is_client_side(f["path"]) for f in _c["files"]),
              repr([f["path"] for f in _c["files"]]))
        check("★ 它的份数与夹具里那几条**逐条、按序**相同（筛子只有一个方向）",
              [f["path"] for f in _c["files"]] == _exp["clientSide"]["files"],
              repr([f["path"] for f in _c["files"]]))
        check("★ 从它算出来的摘要 == 四元组里的 digestClient"
              "（客户端拿到手会自己算这一个）",
              mod.package_content_digest(_c["files"]) == _exp["clientSide"]["digest"]
              and _exp["clientSide"]["digest"] == _exp["signed"]["digestClient"],
              mod.package_content_digest(_c["files"]))
        # ★ 签名块**从包里原样切出来**，不用 `_envelope_bytes` 拼回去 —— 拼回去的
        #   话，这一条就变成"用被测对象自己当参照物"。位置：头 20 字节 + 记录表。
        _siglen = struct.unpack_from(">I", _cli, 16)[0]
        _tab_end = 20 + sum(2 + len(f["path"].encode("utf-8")) + 8 + 32
                            for f in _c["files"])
        _sigblk_c = _cli[_tab_end:_tab_end + _siglen]
        _c_files = [{"path": f["path"], "sha256": f["sha256"],
                     "data": _cli[f["offset"]:f["offset"] + f["size"]]}
                    for f in _c["files"]]
        _c_again = mod.package_build(_c_files, _sigblk_c, side="client")
        check("★★ 第四份实现重打**只含客户端侧**的那一份 ⇒ 与打包器的字节"
              "**逐字节全等**（本版最值钱的那条跨实现判据）",
              _c_again == _cli,
              "%d vs %d 字节" % (len(_c_again), len(_cli)))
        # ★★ 而把**整棵树**的记录喂进去、让实现**自己**筛，结果必须是同一串字节 ——
        #    这一条钉的是"**筛子只有一处**"：调用方筛一遍、实现里再筛一遍，两处
        #    迟早会漂开，而漂开的那天症状是"少发了一份客户端侧代码"。
        _s_files = [{"path": f["path"], "sha256": f["sha256"],
                     "data": _signed[f["offset"]:f["offset"] + f["size"]]}
                    for f in _s["files"]]
        _c_from_all = mod.package_build(_s_files, _sigblk_c, side="client")
        check("★ 把**整棵树**喂进去让实现自己筛 ⇒ 打出来的是同一串字节"
              "（筛子只有 `package_build` 那一处）",
              _c_from_all == _cli,
              "%d vs %d 字节" % (len(_c_from_all), len(_cli)))
        # ★ 对照：**同一批整棵树的记录**，不带 `side` 打出来的是**整包**（与它不一样）
        #   —— 否则上面那两条测的就是"两边都算了同一个常量"，而不是"按侧筛对了"。
        _c_none = mod.package_build(_s_files, _sigblk_c)
        check("★ 对照：同一批记录不带 `side` ⇒ 打出来是**整包**，与只发的那一份"
              "**不一样**（不然 `side` 根本没起作用）",
              _c_none == _signed and _c_none != _cli,
              "不打 side 的那一串与整包%s" % ("相同" if _c_none == _signed else "不同"))
        check("★ 而它比整包**小**，小的正好是站点侧那几份的负载与记录",
              len(_cli) < len(_signed),
              "%d vs %d" % (len(_cli), len(_signed)))

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
    # 这一节是"服务器开始收外面的包"这件事**唯一**的自动化防线（install-base.sh 本机
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
                  and os.path.isfile(mod.plugin_record_path(_INSDIR, _UID_A)),
                  "rc=%d %r" % (_rc, _out[:300]))
            check("★ 落地用的名字是**包里的 id**（不是下载时那个文件名）",
                  os.path.isdir(mod.plugin_tree_dir(_INSDIR, _UID_A))
                  and os.path.isfile(mod.plugin_record_path(_INSDIR, _UID_A))
                  and not [x for x in os.listdir(_INSDIR) if x.endswith(".splug")],
                  str(sorted(os.listdir(_INSDIR))))
            check("★★ 而盘上**没有**那个容器 —— 装完之后它就不再存在了"
                  "（容器是运输形状，不是存储形状）",
                  not [x for x in os.listdir(_INSDIR) if x.endswith(".splug")]
                  and os.path.isdir(mod.plugin_tree_dir(_INSDIR, _UID_A)),
                  str(sorted(os.listdir(_INSDIR))))
            check("★★ 装出来的那棵树过得了启动时的对账（装得上就得认得出）",
                  mod.plugin_reconcile(_INSDIR, _UID_A)["ok"] is True,
                  str(mod.plugin_reconcile(_INSDIR, _UID_A))[:200])
            # ★★ **装完之后现打出来的包与作者发的原件逐字节相同。**
            #    这一条是"拆成树"这件事**不丢东西**的判据：少一份、多一份、次序
            #    变了、权限位被写进负载 —— 任何一种都会让下面这个等式不成立。
            with open(_signed, "rb") as _sf:
                _orig_bytes = _sf.read()
            _back, _br = mod.plugin_rebuild(_INSDIR, _UID_A)
            check("★★ 从盘上那棵树现打一个包 ⇒ 与作者发的原件**逐字节全等**",
                  _br["ok"] and _back == _orig_bytes,
                  "%d vs %d 字节（%s）"
                  % (len(_back or b""), len(_orig_bytes),
                     next((i for i in range(min(len(_back or b""),
                                                len(_orig_bytes)))
                           if _back[i] != _orig_bytes[i]), "（长度不同）")))

            # ★★★ 本版**最要紧的那条判据**：有人改了树、**又同步改了记录表**。
            #
            #   逐份 sha256 是记录表里写着的一列，所以它**自己证明不了自己** ——
            #   改树的人把表里那一行一起改掉，逐份对账会**通过**。抓住它的是
            #   签名：内容摘要从表重算 ⇒ 与签名里那 32 个字节对不上。
            #
            #   ★ 这一条必须**分成两步**验，否则分不清是哪一道闸拦住的：
            #     ① `verify=False` ⇒ **通过**（说明表与树确实自洽、确实只有签名能拦）；
            #     ② 默认（验签）  ⇒ 拒，而且理由是 `signature`。
            _tamdir = os.path.join(_ins_home, "tamper-both")
            _tfiles = [("plugin.json", json.dumps(
                {"id": _UID_B, "name": "tam", "version": "1.0.0",
                 "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8")),
                ("job/start.sh", b"start_tam() { :; }\n")]
            _tsig = None
            _tquad = quadruple_of(_tfiles)
            _ts = openssl_sign(_k1[0], mod.package_signed_message(_tquad))
            if _ts:
                _tsig = sig_block_of(_tquad, _k1[1], _ts)
            install_package(_tamdir, _tfiles, sig_block=_tsig or b"")
            check("（夹具）被改的那一份是**签过名**的（否则这条测的是别的闸）",
                  _tsig is not None and mod.plugin_reconcile(
                      _tamdir, _UID_B)["ok"] is True,
                  str(mod.plugin_reconcile(_tamdir, _UID_B))[:200])
            # 改树：多写一个字节
            _tp = os.path.join(mod.plugin_tree_dir(_tamdir, _UID_B),
                               "job", "start.sh")
            with open(_tp, "ab") as _f:
                _f.write(b"# someone added a line\n")
            with open(_tp, "rb") as _f:
                _tblob = _f.read()
            # 同步改表：把那一行的 size 与 sha256 改成**与树一致**
            _trec = mod.read_plugin_record(_tamdir, _UID_B)["record"]
            for _e in _trec["files"]:
                if _e["path"] == "job/start.sh":
                    _e["size"] = len(_tblob)
                    _e["sha256"] = hashlib.sha256(_tblob).hexdigest()
            mod.write_plugin_record(_tamdir, _UID_B, _trec)
            check("★★★ 改树 + 同步改表 ⇒ **逐份对账会通过**（只有签名拦得住它）",
                  mod.plugin_reconcile(_tamdir, _UID_B, verify=False)["ok"] is True,
                  str(mod.plugin_reconcile(_tamdir, _UID_B, verify=False))[:200])
            _tr = mod.plugin_reconcile(_tamdir, _UID_B)
            check("★★★ 而它**真的被拒了**，理由是 signature（重建的摘要与签名对不上）",
                  _tr["ok"] is False and _tr["code"] == mod.PACKAGE_SIGNATURE,
                  "ok=%s code=%s why=%s" % (_tr["ok"], _tr.get("code"),
                                            str(_tr.get("why"))[:160]))
            # ★ 反方向：树一个字没动，只把**记录表里那个签名块**改一位。
            #   （改 pubkey 而不是 sig：sig 那一串会被 openssl 判成"验不过"，而
            #   这里要验的是"信封被改过"这件事本身也走同一条判据。）
            _trec2 = mod.read_plugin_record(_tamdir, _UID_B)["record"]
            _pk = bytearray(base64.b64decode(_trec2["envelope"]["pubkey"]))
            _pk[0] ^= 0x01
            _trec2["envelope"]["pubkey"] = base64.b64encode(bytes(_pk)).decode()
            mod.write_plugin_record(_tamdir, _UID_B, _trec2)
            _tr2 = mod.plugin_reconcile(_tamdir, _UID_B)
            # ★ 改了 pubkey 也可能**恰好**解不出曲线点 ⇒ 仍然必须是 signature
            #   （`_envelope_sig` 返回 None 时走的是同一条理由词）。
            check("★★★ 只改记录表里那个公钥一位 ⇒ 同样拒，理由仍是 signature",
                  _tr2["ok"] is False and _tr2["code"] == mod.PACKAGE_SIGNATURE,
                  "ok=%s code=%s" % (_tr2["ok"], _tr2.get("code")))
            # ★★ 而站点的**自检**也报它（不是只有函数级那一层看得见）
            _tcrun = subprocess.run([sys.executable, DAEMON, "--check-plugins",
                                     "--plugins-dir", _tamdir],
                                    capture_output=True, text=True)
            check("★★ 自检那一屏也报出来，而且**不退 0 成功**",
                  _tcrun.returncode == 1 and "不可用" in _tcrun.stdout,
                  "rc=%d %r" % (_tcrun.returncode, _tcrun.stdout[-300:]))

            # ── 判据②的后半：**它没被织进任何作业脚本** ────────────────────
            #
            # ★ 这是"拆包**不降**安全"最要紧的一格：作业脚本的内容**来自那棵树**，
            #   所以"织不织"决定了被改过的字节能不能以 root 身份进到集群上。
            #   扫描器把对不过账的那一份从 `specs` 里丢了 ⇒ 它到不了织那一步。
            _twjobs = os.path.join(_ins_home, "jobs-tamper")

            def _jobs_diag(rc, d, out):
                """一条**不会把用例打崩**的诊断：目录不在时说"不在"，不去 listdir。

                ★★ 这一条是补的：变异 M6（把"跳过不可用的"改回"整体中止"）第一次
                  跑出来的是**用例被打崩**（FileNotFoundError），而不是干净地红 ——
                  两者在报告里必须分得开，而分不开的代价是"这条判据到底有没有在守
                  东西"变成一个查不出来的问题。
                """
                return "rc=%s out=%r jobs=%r" % (
                    rc, out[:200],
                    sorted(os.listdir(d)) if os.path.isdir(d) else "（目录不在）")

            _twbuf = io.StringIO()
            _twrc = mod.weave_plugin_jobs(
                _tamdir, _twjobs, os.path.join(HERE, "run.sbatch"),
                say=lambda *x: _twbuf.write(" ".join(str(y) for y in x) + "\n"))
            check("★★ 对不过账的那个插件 ⇒ 织那一步**不会把它织进去**",
                  not os.path.isfile(os.path.join(_twjobs, _UID_B + ".sbatch")),
                  _jobs_diag(_twrc, _twjobs, _twbuf.getvalue()))
            check("★ 而它说了**为什么没织**（不织与织不了在输出上要分得开）",
                  "不织它们" in _twbuf.getvalue(), repr(_twbuf.getvalue()[:300]))
            # ★ 对照：同一批里**能用**的那些照常织得出来（一个坏了不带走一整批）
            install_package(_tamdir, [
                ("plugin.json", json.dumps(
                    {"id": _UID_A, "name": "ok", "version": "1.0.0",
                     "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode()),
                ("job/start.sh", b"start_ok() { :; }\n")])
            _twbuf2 = io.StringIO()
            _twrc2 = mod.weave_plugin_jobs(
                _tamdir, _twjobs, os.path.join(HERE, "run.sbatch"),
                say=lambda *x: _twbuf2.write(" ".join(str(y) for y in x) + "\n"))
            check("★★ 对照：同一批里能用的那个**照常织出来**（一个坏了不带走一整批）",
                  _twrc2 == 0
                  and os.path.isfile(os.path.join(_twjobs, _UID_A + ".sbatch"))
                  and not os.path.isfile(os.path.join(_twjobs, _UID_B + ".sbatch")),
                  _jobs_diag(_twrc2, _twjobs, _twbuf2.getvalue()))
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
            _bare_quad = quadruple_of(_bare_files)
            _sig64 = openssl_sign(_k1[0], mod.package_signed_message(_bare_quad))
            _flipped = bytes([_sig64[0] ^ 0x01]) + _sig64[1:]
            _tp = os.path.join(_ins_home, "tampered.splug")
            with open(_tp, "wb") as _f:
                _f.write(build_package(_bare_files,
                                       sig_block_of(_bare_quad, _k1[1], _flipped)))
            _before = sorted(os.listdir(_INSDIR))
            _rc, _out = _install([_tp], _INSDIR)
            check("★★ 签名对不上（内容被改过）⇒ 拒绝，且一个字节都不写",
                  _rc == 1 and "签名验不过" in _out
                  and sorted(os.listdir(_INSDIR)) == _before,
                  "rc=%d %r" % (_rc, _out[:200]))

            # ★★ v0.13：**信封说的 (id, 版本) 必须与清单对得上**。它排在验签
            #    **之前**（与 A.4 第 10 步②同一个原则：形状 → 身份 → 内容 → 密码学）。
            #    ★ 位置错了会怎样：一个被改了版本号的信封若先以"签名验不过"响，
            #      那句话指向**钥匙**；而这里这句话指向**两处不一致的那两处** ——
            #      那才是能照着修的东西。
            _iddir = os.path.join(_ins_home, "id-mismatch")
            _idfiles = [("plugin.json", json.dumps(
                {"id": _UID_B, "name": "idm", "version": "1.0.0",
                 "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8")),
                ("client/index.js", b"module.exports = {};\n")]
            _idquad = quadruple_of(_idfiles)
            _idsig = openssl_sign(_k1[0], mod.package_signed_message(_idquad))
            install_package(_iddir, _idfiles,
                            sig_block=sig_block_of(_idquad, _k1[1], _idsig)
                            if _idsig else b"")
            check("（夹具）这一份装得上、也对得过账（下面那条才有意义）",
                  mod.plugin_reconcile(_iddir, _UID_B)["ok"] is True,
                  str(mod.plugin_reconcile(_iddir, _UID_B))[:200])
            _irec = mod.read_plugin_record(_iddir, _UID_B)["record"]
            _irec["envelope"]["version"] = "1.0.1"     # 与清单不符（等长，所以形状仍合法）
            mod.write_plugin_record(_iddir, _UID_B, _irec)
            _ir = mod.plugin_reconcile(_iddir, _UID_B)
            check("★★ 信封说的版本与清单不符 ⇒ 拒，理由是 manifest（身份先于密码学）",
                  _ir["ok"] is False and _ir["code"] == mod.PACKAGE_MANIFEST
                  and "1.0.1" in _ir["why"] and "1.0.0" in _ir["why"],
                  "%s %s" % (_ir.get("code"), _ir.get("why")))

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
        # ★ "绕过安装器"在新形状下的样子：自己把那一棵树与记录表摆进去（没有签名，
        #   而记录里写着一把钥匙的指纹）—— 这正是"安装器是唯一写方"那句话要抓的。
        install_package(_bypass, [("plugin.json", json.dumps(
            {"id": _UID_A, "name": "alpha", "version": "1.0.0",
             "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8"))])
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
        _want_digest = mod.plugin_reconcile(_bypass, _UID_A)["digest"]
        # ★ 这里**显式要整包**（`side=None`）：与 `_want_digest`（整棵树那一个）对照
        #   的容器是**作者发的那一份**，而作者发的从来是整包。默认值（客户端侧）是
        #   这一版**分发**出去的那一份，两者不是一回事。
        _blob_b, _rb_b = mod.plugin_rebuild(_bypass, _UID_A, side=None)
        _container_sha = hashlib.sha256(_blob_b or b"").hexdigest()
        check("★★ 自检报出**完整的内容摘要**（拿它去与作者报的那个逐个字符比）",
              ("内容摘要  %s（整棵树）" % _want_digest) in _crun.stdout,
              repr(_crun.stdout[-400:]))
        check("★ 而它**不是**容器字节的 sha256（补一个签名块不该动这个数）",
              _want_digest != _container_sha
              and ("内容摘要  %s" % _container_sha) not in _crun.stdout,
              "%s vs %s" % (_want_digest[:16], _container_sha[:16]))

        # ── ⑨b `--check-plugins` 报的分发量 ──
        #
        # ★ 两个包，一个带 `job/start.sh`、一个不带 —— 分发出去的份数因此是 2 与 1。
        #   （那一段**机器可读的** `plugin-packages:` 已经不需要了：它唯一的读者是
        #   安装器，而安装器直接调 `scan_plugins()`。人读的那一屏已经把同一件事说
        #   得更全。）
        _tsvdir = os.path.join(_ins_home, "tsv")
        os.makedirs(_tsvdir, exist_ok=True)
        install_package(_tsvdir, [
            ("plugin.json", json.dumps(
                {"id": "01M2JKHTZGKJBFQQTWYXMQMF60", "name": "withjob",
                 "version": "1.0.0", "site": {"defaultCpus": 1,
                                              "defaultMem": "1G"}}).encode()),
            ("job/start.sh", b"start_withjob() { :; }\n")])
        install_package(_tsvdir, [("plugin.json", json.dumps(
            {"id": "01M2JKHTZGKJBFQQTWYXMQMF61", "name": "nojob",
             "version": "1.0.0",
             "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode())])
        _trun = subprocess.run([sys.executable, DAEMON, "--check-plugins",
                                "--plugins-dir", _tsvdir],
                               capture_output=True, text=True)
        # ★★ 「分发出去」那一行**只数客户端侧**：带 `job/` 的那一个
        #   与不带的那一个，分发出去的份数**一样**（都只有 `plugin.json`）。这是
        #   "用户机器上没有站点侧代码"这句话在自检这一屏上的可见形式 —— 也就是
        #   阶段 4 的**主题判据**（客户端池里没有 `job/`）。
        #   ★ 而「树」那一行报的仍然是**整棵树**的份数（2 / 1），它来自记录表 ——
        #     自检要能同时回答"装了什么"与"发什么"，两个数都得在。
        check("★★ 「分发出去」只数客户端侧：带 job 的与不带的，份数一样（各 1 份）",
              _trun.stdout.count("只含客户端侧 1 份") == 2
              and "（2 份 / 负载" in _trun.stdout
              and "（1 份 / 负载" in _trun.stdout,
              repr(_trun.stdout[-400:]))

        # ── ⑩ 用法错误：一个包都没给 ──
        _rc, _out = _install([], _INSDIR)
        check("★ 一个包都没给 ⇒ 用法错误（code 2），不是静默成功",
              _rc == 2 and "用法" in _out, "rc=%d %r" % (_rc, _out[:120]))
    finally:
        shutil.rmtree(_ins_home, ignore_errors=True)

    # ── 19.16 ★★ 清单里认得的键：判据只有一份书面形式，两侧逐字相同 ──────────
    #
    # 这一条与 19.12（跳过表）是**同一个形状**，差别在于这里多了一份**书面的**
    # 判据：`tools/manifest-keys.json`。那份 JSON 的 `_` 段写清了为什么生产代码
    # **不**在运行期读它 —— 守护进程是一个文件装到 /usr/local/sbin/slurmate-sessiond，
    # 集群上没有 `tools/`；客户端是一个分发单元，运行期只读 `client/` 里的东西。
    # 两侧各写一条相对路径的话，**从源码跑得通、装出去就断**：键表成了空集，
    # 于是"什么都不拒" —— 而那条路只在装出去的机器上露出来。
    #
    # 所以是三处，且必须逐字相同（**有序**：报错里"认识的只有 …"那一串用的就是
    # 它）：书面判据 / 客户端那五张字面量 / 守护进程那五张元组。
    #
    # 抠的是**字面量本身**，不是"跑一遍 JS" —— 与 19.12 同一个理由：本机不一定有
    # node，而这条契约要的是"两份声明写的是同一组名字"。
    #
    # ★ 若只有客户端那一侧有这几张表：守护进程逐键取值、多出来的键一律不管，
    #   于是「一份把 `contributes` 拼错的清单：客户端拒、守护进程收」—— 站点能把
    #   一个任何客户端都装不上的插件正常分发出去，而**没有任何东西会红**（S12）。
    print("\n── 19.16. 清单里认得的键（两侧逐字一致）──")

    _mk_tables = (("manifest", "MANIFEST_KEYS"),
                  ("contributes", "CONTRIBUTES_KEYS"),
                  ("surface", "SURFACE_KEYS"),
                  ("login", "LOGIN_KEYS"),
                  ("data", "DATA_KEYS"))
    with io.open(os.path.join(HERE, os.pardir, "tools", "manifest-keys.json"),
                 encoding="utf-8") as _f:
        _mk_written = json.load(_f)
    with io.open(os.path.join(HERE, os.pardir, "client", "src", "main",
                              "plugins", "index.js"), encoding="utf-8") as _f:
        _mk_js = _f.read()

    _mk_client, _mk_daemon = {}, {}
    for _name, _const in _mk_tables:
        _m = re.search(r"const %s = \[([^\]]*)\]" % _const, _mk_js, re.S)
        _mk_client[_name] = re.findall(r"'([^']*)'", _m.group(1)) if _m else None
        _mk_daemon[_name] = list(getattr(mod, _const, ()))
    check("★ 十处都真的抠到了键（抠出 None 或空表的话，下面五条是**假通过**）",
          all(_mk_client[n] for n, _ in _mk_tables)
          and all(_mk_daemon[n] for n, _ in _mk_tables),
          "客户端 %r / 守护进程 %r" % (_mk_client, _mk_daemon))
    for _name, _const in _mk_tables:
        check("★★ %s：书面判据 = 客户端字面量 = 守护进程元组（逐字、有序）"
              % _name,
              _mk_written.get(_name) == _mk_client[_name] == _mk_daemon[_name],
              "书面 %r / 客户端 %r / 守护进程 %r"
              % (_mk_written.get(_name), _mk_client[_name], _mk_daemon[_name]))

    # ── 判定那一半：拼错了**真的**会被拒（"两侧都拒"的另一半在这里）────────
    #
    # ★ 上面那几条比的是常量。这一条把常量接回**清单那条路**上 —— 一张写对了
    #   却没人调的键表，与没有它是一样的（这个仓库里"一行包装 + 一份没人验的
    #   注释"出现过不止一次）。
    _mk_valid = {
        "id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "cs", "version": "1.0.0",
        "displayName": "开发环境", "engines": {"slurmate": ">=0.5"},
        "contributes": {
            "surface": {"kind": "web", "path": "/"},
            "login": {"path": "/login", "field": "password", "cookie": "cs"},
            "ports": 1, "submitPubkey": False, "concurrent": True,
            # ★ 两个键都列上（值不冲突）—— 站点这一侧要**收得下** `perVersion`。
            #   少了它，"守护进程拒了一个任何客户端都认的键"这件事只有 19.14 那条
            #   常量比对守着；这一条把**清单那条路**也接上（19.14 证明表是对应的，
            #   这一条证明表真的用在路上）。
            "data": {"inherit": "editor", "perVersion": False},
        },
        "site": {"defaultCpus": 2, "defaultMem": "8G"},
    }

    def _mk_parse(mf):
        return mod.parse_plugin_manifest(
            "探针.splug:plugin.json", json.loads(json.dumps(mf)))

    _mk_spec, _mk_probs = _mk_parse(_mk_valid)
    check("正对照：一份完整合法的清单被收下"
          "（否则下面五条会被「什么都拒」一并满足）",
          _mk_spec is not None and not _mk_probs,
          "%s / %s" % (_mk_spec, _mk_probs))

    for _where, _edit, _key in (
            ("顶层", lambda m: m.update({"contribution": {}}), "contribution"),
            ("contributes 子键",
             lambda m: m["contributes"].update({"contrib": 1}), "contrib"),
            ("contributes.surface 子键",
             lambda m: m["contributes"]["surface"].update({"knd": "web"}), "knd"),
            ("contributes.login 子键",
             lambda m: m["contributes"]["login"].update({"pathh": "/"}), "pathh"),
            ("contributes.data 子键",
             lambda m: m["contributes"]["data"].update({"inheritt": "x"}),
             "inheritt")):
        _mf = json.loads(json.dumps(_mk_valid))
        _edit(_mf)
        _s2, _p2 = _mk_parse(_mf)
        check("★★ %s 里拼错成 %s ⇒ **拒**，且报错点名那个键"
              % (_where, _key),
              _s2 is None and any("认不得的键" in x and _key in x for x in _p2),
              "%s / %s" % (_s2, _p2))

    # ── 19.17 ★★ 负载的大小上限：书面判据 ↔ 三侧常量（v0.10 阶段 5，S10）──────
    #
    # 与 19.16（认得的键）同一个形状，但比它多**两个**读者：这一组数不只在守护
    # 进程与客户端里各写一遍，打包器（`packer/slurmate-packer.js`）里还有第三份。
    #
    # ★ 三份都是**分发单元**，谁也读不到 `tools/plugin-limits.json`：守护进程是
    #   一个文件装到 /usr/local/sbin/slurmate-sessiond（集群上没有 tools/）；客户端
    #   是一个分发单元；打包器要"下载这个文件夹就能用"。各写一条相对路径的话，
    #   **从源码跑得通、装出去就断** —— 上限全变成 0，也就是"什么都不拦"，而那只
    #   在装出去的机器上出现。
    #
    # ★ 漂开的样子很具体：客户端收下一个站点根本发不出来的负载；或者打包器放出
    #   一个**任何站点都拒收**的包。两种都不红任何东西，直到有人真的发布一个插件。
    #
    # ★ 这一组数里只有 `total_bytes` 是**推出来的**（包上限 − 信封最坏情况），
    #   所以下面除了"三处逐字相同"，还要验那条**推导**本身 —— 否则一份自己就不
    #   自洽的书面判据会让三条比对一起绿。
    print("\n── 19.17. 负载的大小上限（三侧逐字一致）──")

    def _pl_lit(src, names):
        """把一串 `const NAME = <纯算术>;` 求值出来（按声明次序，后面的可引用前面的）。

        ★ 求的是**源码文本**，不是"跑一遍 JS" —— 与 19.12 / 19.16 同一个理由：
          本机不一定有 node。而这几个表达式在 Python 与 JS 里**逐字同解**
          （`1 << 20`、`256 * 1024`、加减乘与括号都在两边同一个意思），所以
          这一步是等价的。
        ★ 抠不到就返回 `None`，**不抛**：抛出去会把后面每一条用例都带走，而
          "脚本崩了"与"这条防线不存在"在报告里长得一模一样。
        """
        env = {}
        for n in names:
            m = re.search(r"^const %s = (.+);$" % n, src, re.M)
            if not m:
                return None
            try:
                env[n] = eval(m.group(1), {"__builtins__": {}}, env)
            except Exception:
                return None
        return env

    _pl_json_path = os.path.join(HERE, os.pardir, "tools", "plugin-limits.json")
    with io.open(_pl_json_path, encoding="utf-8") as _f:
        _pl = json.load(_f)
    with io.open(os.path.join(HERE, os.pardir, "client", "src", "main",
                              "site-plugins.js"), encoding="utf-8") as _f:
        _pl_csrc = _f.read()
    with io.open(os.path.join(HERE, os.pardir, "packer", "slurmate-packer.js"),
                 encoding="utf-8") as _f:
        _pl_psrc = _f.read()
    with io.open(os.path.join(HERE, os.pardir, "client", "src", "main",
                              "plugin-package.js"), encoding="utf-8") as _f:
        _pl_pksrc = _f.read()

    # ★ 次序 = 源码里的**声明次序**（有几行引用了前面那几行）。信封那一项
    #   是 `…SIG_MAX` 推出来的，所以签名块那几个常量也得一起抠出来 —— 抠漏了的话
    #   `eval` 会当场炸，而"脚本崩了"与"这条防线不存在"在报告里长得一模一样。
    _pl_cv = _pl_lit(_pl_csrc, ("MAX_SEGMENT_BYTES", "MAX_DEPTH", "MAX_FILES",
                                "MAX_PATH_BYTES",
                                "ENVELOPE_SIG_MIN", "ENVELOPE_SIG_MAX",
                                "ENVELOPE_MAX_BYTES"))
    _pl_pv = _pl_lit(_pl_psrc, ("HEADER_BYTES", "DIGEST_BYTES",
                                "SIG_PREFIX_BYTES", "SIG_ID_BYTES", "SIG_TAIL_BYTES",
                                "SIG_MIN_BYTES", "MAX_VERSION_BYTES", "SIG_MAX_BYTES",
                                "MAX_DEPTH", "MAX_SEGMENT_BYTES", "MAX_FILES",
                                "MAX_FILE_BYTES", "MAX_PACKAGE_BYTES",
                                "MAX_PATH_BYTES", "MAX_ENVELOPE_BYTES",
                                "MAX_TOTAL_BYTES"))
    # 客户端那张表是一个对象字面量（值里还引用了上面那几个常量），单独抠。
    _pl_hv = None
    _pl_hm = re.search(r"const HARD_LIMITS = \{(.*?)\n\};", _pl_csrc, re.S)
    if _pl_hm is not None and _pl_cv is not None:
        _pl_hv = {}
        for _line in _pl_hm.group(1).split("\n"):
            _kv = re.match(r"\s*(\w+): (.+?),?\s*$", _line)
            if not _kv:
                continue
            try:
                _pl_hv[_kv.group(1)] = eval(_kv.group(2), {"__builtins__": {}}, _pl_cv)
            except Exception:
                _pl_hv = None
                break

    check("★ 三侧的字面量都真的抠出来了（抠出 None 的话，下面几条是**假通过**）",
          _pl_cv is not None and _pl_pv is not None and _pl_hv is not None
          and set(_pl_hv) == {"file_bytes", "total_bytes", "max_files", "max_depth",
                              "package_bytes"},
          "客户端 %r / 打包器 %r / HARD_LIMITS %r" % (_pl_cv, _pl_pv, _pl_hv))

    _pl_written = _pl["load"]
    check("★★ 客户端 HARD_LIMITS 的四个负载上限 = 书面判据（逐字）",
          _pl_hv is not None and all(
              _pl_hv[k] == _pl_written[k]
              for k in ("file_bytes", "total_bytes", "max_files", "max_depth")),
          "客户端 %r / 书面 %r" % (_pl_hv, _pl_written))
    # ★ 深度上限在**客户端里有两份**：`site-plugins.js` 的（上面那一条已经钉了）与
    #   `plugin-package.js` 的。后者传给**共享的** `sitePlugins.checkRelPath`，也就是
    #   "读一个包时允许多深"的那个数；而 tools/conformance/ 的坏包向量里**没有**
    #   一条"路径超过深度"的用例，所以它漂开不会红任何东西。
    _pl_pk = re.search(r"^const MAX_DEPTH = (\d+);$", _pl_pksrc, re.M)
    check("★★ 客户端第二份深度上限（plugin-package.js）也对得上书面判据",
          _pl_pk is not None and int(_pl_pk.group(1)) == _pl_written["max_depth"],
          "抠到 %r / 判据 %s" % (_pl_pk and _pl_pk.group(1), _pl_written["max_depth"]))

    check("★★ 守护进程那三个 = 书面判据（逐字）",
          mod.PLUGIN_FILE_MAX_BYTES == _pl_written["file_bytes"]
          and mod.PLUGIN_TOTAL_MAX_BYTES == _pl_written["total_bytes"]
          and mod.PLUGIN_MAX_FILES == _pl_written["max_files"],
          "%s / %s / %s vs %r"
          % (mod.PLUGIN_FILE_MAX_BYTES, mod.PLUGIN_TOTAL_MAX_BYTES,
             mod.PLUGIN_MAX_FILES, _pl_written))
    check("★★ 打包器那四个 = 书面判据（逐字）",
          _pl_pv is not None
          and _pl_pv["MAX_FILE_BYTES"] == _pl_written["file_bytes"]
          and _pl_pv["MAX_TOTAL_BYTES"] == _pl_written["total_bytes"]
          and _pl_pv["MAX_FILES"] == _pl_written["max_files"]
          and _pl_pv["MAX_DEPTH"] == _pl_written["max_depth"],
          "%r vs %r" % (_pl_pv, _pl_written))

    # ── 推导那一半：`total_bytes` 是算出来的，不是挑出来的 ────────────────────
    #
    # 附录 A.1：包 = 头 ‖ 记录表 Σ(2 + pathlen + 8 + 32) ‖ 签名 ‖ 负载。
    # §3.3：路径最长 max_depth 段、每段 max_segment_bytes 字节。
    _pl_fmt = _pl["format"]
    _pl_path = (_pl_written["max_depth"] * _pl_fmt["max_segment_bytes"]
                + (_pl_written["max_depth"] - 1))
    # ★ v0.13：签名那一项按**最长**的一块算（`188 + 255`），因为签名块的长度现在
    #   随版本号变（A.3）。书面判据那一格因此叫 `signature_max_bytes`。
    _pl_env = (_pl_fmt["header_bytes"] + _pl_fmt["signature_max_bytes"]
               + _pl_written["max_files"] * (_pl_fmt["record_overhead_bytes"] + _pl_path))
    check("★★ 书面判据里的信封最坏情况 = 按附录 A.1 与 §3.3 现算一遍（%d 字节）"
          % _pl_env,
          _pl_env == _pl["package"]["envelope_max_bytes"],
          "现算 %d / 判据 %d（改 §3.3 的深度、段长，或改份数上限，这个数会跟着动）"
          % (_pl_env, _pl["package"]["envelope_max_bytes"]))
    check("★★ 负载上限 = 包上限 − 信封最坏情况（这条关系**刚好顶满**）",
          _pl_written["total_bytes"]
          == _pl["package"]["max_bytes"] - _pl["package"]["envelope_max_bytes"],
          "%d vs %d − %d" % (_pl_written["total_bytes"], _pl["package"]["max_bytes"],
                             _pl["package"]["envelope_max_bytes"]))
    check("★★ 于是「按上限做出来的包一定装得进包上限」是一条**算出来的**结论"
          "（从前那个 1 MiB 与 2 MiB 之间没有任何东西钉住）",
          _pl_written["total_bytes"] + _pl_env <= _pl["package"]["max_bytes"],
          "%d + %d > %d" % (_pl_written["total_bytes"], _pl_env,
                            _pl["package"]["max_bytes"]))
    # ★ 三侧**各自**算出来的"签名块最长"必须与书面判据那一格逐字相同。
    #   少这一条的话，某一侧把 443 写成别的数时，"信封最坏情况"那条对它就成了
    #   一次**自洽的错算** —— 自己跟自己永远对得上。
    check("★★ 客户端与打包器各自算出来的签名块最长 = 书面判据那一格（443）",
          _pl_cv is not None and _pl_pv is not None
          and _pl_cv["ENVELOPE_SIG_MAX"] == _pl_fmt["signature_max_bytes"]
          and _pl_pv["SIG_MAX_BYTES"] == _pl_fmt["signature_max_bytes"]
          and mod.PACKAGE_SIG_MAX_BYTES == _pl_fmt["signature_max_bytes"],
          "客户端 %r / 打包器 %r / 守护进程 %r / 判据 %r"
          % (_pl_cv and _pl_cv["ENVELOPE_SIG_MAX"], _pl_pv and _pl_pv["SIG_MAX_BYTES"],
             mod.PACKAGE_SIG_MAX_BYTES, _pl_fmt["signature_max_bytes"]))
    check("★★ 而签名块最短 = 最短那一块的长度（188 = alg+公钥+签名+id+verlen+两摘要）",
          _pl_pv is not None and mod.PACKAGE_SIG_MIN_BYTES == 188
          and _pl_pv["SIG_MIN_BYTES"] == 188
          and _pl_pv["SIG_MAX_BYTES"] == _pl_pv["SIG_MIN_BYTES"] + _pl_pv["MAX_VERSION_BYTES"]
          and _pl_cv["ENVELOPE_SIG_MIN"] == _pl_pv["SIG_MIN_BYTES"],
          "%r / %r / %d" % (_pl_pv and _pl_pv["SIG_MIN_BYTES"],
                            _pl_cv and _pl_cv["ENVELOPE_SIG_MIN"],
                            mod.PACKAGE_SIG_MIN_BYTES))

    check("★ 守护进程那份兜底也得装得下站点报得出来的最大负载",
          _pl_hv is not None
          and _pl_hv["package_bytes"] >= _pl["package"]["max_bytes"],
          "客户端 package_bytes %r / 站点最大 %d"
          % (_pl_hv and _pl_hv["package_bytes"], _pl["package"]["max_bytes"]))
    check("★ 守护进程自己那三个数之间的关系也算得出来（不是各写各的）",
          mod.PACKAGE_ENVELOPE_MAX_BYTES == _pl_env
          and mod.PLUGIN_TOTAL_MAX_BYTES + mod.PACKAGE_ENVELOPE_MAX_BYTES
          <= mod.PLUGIN_PACKAGE_MAX_BYTES,
          "%d / %d / %d" % (mod.PACKAGE_ENVELOPE_MAX_BYTES,
                            mod.PLUGIN_TOTAL_MAX_BYTES, mod.PLUGIN_PACKAGE_MAX_BYTES))

    # ── 19.18 ★★ 安装器 / 插件配置 / 对账（v0.11 阶段 2+3 的**第二层**）─────────
    #
    # 这一节钉三件在这一版之前**没有**的事：
    #   ① 安装器不再因**短名撞**拒装（短名不是身份）；同 **id** 仍然拒。
    #   ② **同一个 id@版本、内容不同** ⇒ 拒（账本 **F36**）。这是"替换"那条路上
    #      唯一还开着的静默口子，理由写在 `install_plugins` 的 ③b 里。
    #   ③ `sync_plugin_config()`：配置里**安装器生成的**块与插件目录对账 ——
    #      少的补、多的删、别人的一个字节不动，而且**幂等**。
    #
    # ★ 这一节是第二次那句「装得上、守护进程不认」的落点：`install-base.sh` 在本机跑
    #   不了（要 root 加一台控制节点，见 KNOWN-ISSUES 的 U2），所以"装完之后配置
    #   里该多出一块、拿走包之后该少一块"这件事**只有这里**看得见。
    print("\n── 19.18. 安装器、插件配置与对账（插件身份那一层）──")

    _sy_home = tempfile.mkdtemp(prefix="slurmate-sync-")
    try:
        def _sy_mk(uid, name, ver="1.0.0", body=b"a", default_enabled=None,
                   out=None):
            """造一个包（`body` 是作业侧正文里的一行注释，不同 ⇒ 摘要不同）。

            ★ 文件名带上 id 的后三位：安装器**不看文件名**（落地名由包里的 id
              决定），而夹具里若两个包同名就会**互相覆盖**，于是"装的是哪一份"
              变成一件取决于调用次序的事 —— 那是这个仓库吃过亏的形状。

            ★★ 作业侧那一份**必须是合法的**（定义 `start_<短名>`）：对账会
              **顺手织作业脚本**，而织不过去会让整段对账返回 1 —— 夹具
              里塞一句 `a` 的话，下面每一条断言都会因为一个与它无关的原因变红。
            """
            site = {"defaultCpus": 1, "defaultMem": "1G"}
            if default_enabled is not None:
                site["defaultEnabled"] = default_enabled
            jobsh = ("start_%s() { :; }\n# %s\n"
                     % (name.replace("-", "_"), body.decode("utf-8", "replace")))
            files = [("plugin.json", json.dumps(
                {"id": uid, "name": name, "version": ver, "site": site}
            ).encode("utf-8")),
                ("job/start.sh", jobsh.encode("utf-8"))]
            p = os.path.join(out or _sy_home,
                             "%s-%s-%s.splug" % (name, ver, uid[-3:]))
            with open(p, "wb") as f:
                f.write(build_package(files))
            return p

        def _sy_install(pkgs, pdir):
            buf = io.StringIO()
            rc = mod.install_plugins(list(pkgs), pdir,
                                     say=lambda *a: buf.write(
                                         " ".join(str(x) for x in a) + "\n"))
            return rc, buf.getvalue()

        def _sy_pkgs(pdir):
            """目录里"装着哪几个插件" —— 判据是**记录表**（一棵树 + 一份
            记录表，而记录表是那次安装的提交点）。"""
            return sorted(x for x in os.listdir(pdir)
                          if x.endswith(".json") and not x.startswith("."))

        def _sy_cfg(pdir, text, name):
            """一份指向 `pdir` 的 Config（插件目录是代码常量，只能在模块上盖）。

            ★ 走 `write_conf_tree`：传进来的老形状（通用键 + `[plugin:X]` 段）
              被拆成主文件与 `slurmate.conf.d/<名字>.conf` 两半。
            """
            _saved = mod.default_plugins_dir
            try:
                mod.default_plugins_dir = lambda: pdir
                return mod.Config(write_conf_tree(text, name))
            finally:
                mod.default_plugins_dir = _saved

        def _sy_effective(c):
            """`{id: (开了没, cpus, mem)}` —— 用来验"生成物没改行为"。"""
            return {i: (q.enabled, q.default_cpus, q.default_mem)
                    for i, q in c.plugins.items()}

        # ★ `jobs_dir` / `template_path` 指到一个临时目录与仓库里那份模板上：
        #   对账现在**也织作业脚本**（从 install-base.sh 并进来），而
        #   生产路径上这两个是从守护进程自身的安装位置推导的。用例里不能走那条
        #   —— 它会往真的 `<prefix>/share/slurmate/jobs` 里写。
        _SY_JOBS = os.path.join(_sy_home, "jobs")

        def _sy_sync(pdir, conf, **kw):
            buf = io.StringIO()
            kw.setdefault("jobs_dir", _SY_JOBS)
            kw.setdefault("template_path", os.path.join(HERE, "run.sbatch"))
            rc = mod.sync_plugins(conf, pdir,
                                  say=lambda *a: buf.write(
                                      " ".join(str(x) for x in a) + "\n"),
                                  **kw)
            return rc, buf.getvalue()

        def _sy_read(p):
            with open(p, encoding="utf-8") as f:
                return f.read()

        _U1 = "01M2JKHTZGKJBFQQTWYXMQMF60"
        _U2 = "01M2JKHTZGKJBFQQTWYXMQMF61"
        _U3 = "01M2JKHTZGKJBFQQTWYXMQMF62"
        _SY = os.path.join(_sy_home, "plugins")
        os.makedirs(_SY, exist_ok=True)

        # ── ① 短名撞：**两个都装** ──────────────────────────────────
        _rc, _out = _sy_install([_sy_mk(_U1, "jup"), _sy_mk(_U2, "jup")], _SY)
        check("★★ 一批里两个包共用同一个**短名** ⇒ **两个都装**"
              "（短名不是身份，id 才是；作业脚本一插件一份，函数名不会撞）",
              _rc == 0 and _sy_pkgs(_SY) == [_U1 + ".json", _U2 + ".json"],
              "rc=%d %r" % (_rc, _out[:300]))

        # ── ② 同 id@版本、内容不同 ⇒ 拒（F36）───────────────────────────
        #   盘上现在是 U1@1.0.0（内容 `a`），下面四条按这个基准走。
        _p1 = mod.plugin_record_path(_SY, _U1)
        _before = tree_digest(mod.plugin_tree_dir(_SY, _U1)) + file_digest(_p1)

        _rc, _out = _sy_install([_sy_mk(_U1, "jup", body=b"DIFFERENT")], _SY)
        check("★★ 同一个 id、**同一个版本**、内容不同 ⇒ 拒绝（F36）",
              _rc == 1 and "同一个版本" in _out and "内容摘要" in _out,
              "rc=%d %r" % (_rc, _out[:300]))
        check("★★ 而且报错说清**为什么**（已经取过旧内容的客户端永远发现不了）",
              "永远不会发现" in _out and "升版本号" in _out, _out[:400])
        check("★ 盘上那一份**一个字节都没被动**（树与记录表都算）",
              tree_digest(mod.plugin_tree_dir(_SY, _U1)) + file_digest(_p1)
              == _before)

        _rc, _out = _sy_install([_sy_mk(_U1, "jup")], _SY)
        check("★ 对照：同一个 id@版本、内容**逐字节相同** ⇒ 放行（重装是幂等的）",
              _rc == 0, "rc=%d %r" % (_rc, _out[:240]))

        _rc, _out = _sy_install([_sy_mk(_U1, "jup", ver="1.1.0", body=b"b")], _SY)
        check("★ 对照：同一个 id **换了版本** ⇒ 放行（那正是升级，不是这一条要拦的）",
              _rc == 0 and "升级" in _out, "rc=%d %r" % (_rc, _out[:240]))

        _rc, _out = _sy_install([_sy_mk(_U1, "jup", ver="1.1.0", body=b"c")], _SY)
        check("★ 同一个版本、升级之后又换内容 ⇒ 照样拒（判据是内容，不是文件时间）",
              _rc == 1 and "同一个版本" in _out, "rc=%d %r" % (_rc, _out[:240]))

        # ── ③ 两个文件指着同一个插件 ⇒ 硬错误（账本 F38）────────────────────
        #
        # ★★ 短名与 id 都能当**文件名**（`solo.conf` 与 `<那个 id>.conf`），所以
        #    "同一个插件配了两遍"这件事**到得了**：两个文件名各自都解析得通，而它们
        #    是同一个东西 —— 真合并起来后一份**静默盖掉**前一份，管理员改的那一份
        #    可能一个字都没生效，而配置里没有任何迹象。
        #
        # ★ 报错点的是**两个文件路径**（能直接 `rm`），不再是两个块头 —— 插件配置
        #   不在主文件里了，只说个名字等于让他去翻一个找不到的地方。
        _SY3 = os.path.join(_sy_home, "plugins3")
        os.makedirs(_SY3, exist_ok=True)
        _rc, _out = _sy_install([_sy_mk(_U3, "solo")], _SY3)
        check("（夹具）一个短名不撞的插件装好了", _rc == 0, _out[:200])

        _c = _sy_cfg(_SY3, "cluster_cidr = 192.0.2.0/24\n"
                           "[plugin:solo]\nenabled = yes\n"
                           "[plugin:%s]\nenabled = no\n" % _U3, "dupblock.conf")
        _errs = " ".join(_c.validate())
        check("★★ 两个文件指的是**同一个插件**（一个用短名命名、一个用 id）⇒ 硬错误",
              _errs != "", str(_c.validate())[:200])
        check("★ 而且**两个文件路径都点出来** —— 只说「重复了」的话，用 id 命名的"
              "那个认不出自己是哪一个",
              "solo.conf" in _errs and (_U3 + ".conf") in _errs, _errs[:300])

        def _sy_cfg_now(pdir, conf_path):
            """直接读**盘上那一份**配置（不重新造）—— 对账改了盘，要按改动后的看。"""
            _saved = mod.default_plugins_dir
            try:
                mod.default_plugins_dir = lambda: pdir
                return mod.Config(conf_path)
            finally:
                mod.default_plugins_dir = _saved

        # ── ④ 对账：写一份 / 幂等 / 删自己那份 / 手写的不动 ──────────────────
        #
        # ★★ 它动的是**文件**：装了而没有配置的插件 ⇒ 写 `<ULID>.conf`；
        #    那一份在而插件没了 ⇒ 删那个文件；其余的一个字节不动。**主文件全程
        #    不参与** —— 这是"一个插件一份配置、一个来源"的直接推论。
        _CONF_S = os.path.join(_sy_home, "site.conf")
        with open(_CONF_S, "w", encoding="utf-8") as _f:
            _f.write("# 站点配置\ncluster_cidr = 192.0.2.0/24\n"
                     "readonly_paths = /shared/home\n")
        _orig_conf = _sy_read(_CONF_S)

        # ★★ 生成物不许改动行为：装前装后**每个插件的生效值逐项相同**。
        _eff_before = _sy_effective(_sy_cfg(_SY3, _orig_conf, "eff-before.conf"))

        _rc, _out = _sy_sync(_SY3, _CONF_S)
        _p_solo = mod.plugin_conf_path(_CONF_S, _U3)
        check("★★ 装了而没有配置的插件 ⇒ 写一份 `<id>.conf`",
              _rc == 0 and os.path.isfile(_p_solo), "rc=%d %r" % (_rc, _out[:300]))
        check("★★ 而**主文件一个字节都没变**（插件配置不住在那儿了）",
              _sy_read(_CONF_S) == _orig_conf, repr(_sy_read(_CONF_S)[-300:]))
        check("★ 文件名用**插件的 id**，不是短名 —— 这样「该删哪一个」是算得出来的",
              os.path.basename(_p_solo) == _U3 + ".conf", _p_solo)
        check("★ 那一份里第一行写上**短名**（文件名是 ULID，人不认识）",
              "solo" in _sy_read(_p_solo), _sy_read(_p_solo)[:200])
        _solo1 = _sy_read(_p_solo)
        _g, _s, _m = mod.parse_config(_CONF_S)
        # ★ 名字是 **id**（安装器按 id 命名），不是短名 —— 这一格正是"该删哪一个
        #   是算得出来的"那句话的另一面。
        check("★★ 解析回来：通用键来自主文件、插件配置来自 `.d/`，来源记在 meta 里",
              _g == {"cluster_cidr": "192.0.2.0/24",
                     "readonly_paths": "/shared/home"}
              and set(_s) == {_U3} and _m[_U3]["file"] == _p_solo,
              "%s / %s / %s" % (_g, _s, _m))
        check("★★ 生成的那一份让配置**自洽**了（`--check` 不再报错）",
              _sy_cfg_now(_SY3, _CONF_S).validate() == [],
              str(_sy_cfg_now(_SY3, _CONF_S).validate())[:240])
        check("★★★ 而且**没有改动任何行为** —— 每个插件的 (开关, cpus, mem) 逐项相同",
              _sy_effective(_sy_cfg_now(_SY3, _CONF_S)) == _eff_before,
              "%s → %s" % (_eff_before,
                           _sy_effective(_sy_cfg_now(_SY3, _CONF_S))))

        _rc, _out = _sy_sync(_SY3, _CONF_S)
        check("★★ 幂等：再跑一遍，那一份**逐字节相同**（不是「又写了一份」）",
              _rc == 0 and _sy_read(_p_solo) == _solo1, "rc=%d %r" % (_rc, _out[:300]))
        check("★ 而且它说的是「已经一致」，不是一句含糊的「没做什么」",
              "已经一致" in _out, _out[:200])

        # 管理员改过那一份 ⇒ 安装器此后**一个字都不动**（「升级不能乱变」）
        _edited = _solo1.replace("enabled = no", "enabled = yes\ndefault_cpus = 4")
        with open(_p_solo, "w", encoding="utf-8") as _f:
            _f.write(_edited)
        _rc, _out = _sy_sync(_SY3, _CONF_S)
        check("★★ 已有的那一份**逐字节不动**（管理员调过的开关与默认资源必须原样留着）",
              _rc == 0 and _sy_read(_p_solo) == _edited, "rc=%d %r" % (_rc, _out[:300]))
        check("★ 而且改过的那一份**真的生效**了（不是被静默忽略）",
              _sy_cfg_now(_SY3, _CONF_S).plugin_config("solo").enabled is True,
              "还关着")

        # 手写的（**不是 ULID 命名**的）那份指向一个没装的插件 ⇒ **不删**，只报
        #   ★ 它摆在**安装器那一份旁边**：这样才测得出"只删该删的那一个"，
        #     而不是"整个目录重写了一遍"。
        _p_typo = write_plugin_conf(_CONF_S, "typo", "enabled = yes\n")
        _rc, _out = _sy_sync(_SY3, _CONF_S)
        check("★★ 手写的（不是 ULID 命名）那份指向一个没装的插件 ⇒ **不删**，只报",
              _rc == 0 and os.path.isfile(_p_typo) and _p_typo in _out,
              "rc=%d %r" % (_rc, _out[:400]))
        check("★ 而且那句话说出**凭什么不删**（那是他写的，不是安装器那份）",
              "手写" in _out, _out[:400])

        # 把插件从目录里拿走（最自然的卸载动作）⇒ **它那一份**被删掉，手写那份留着
        # ★ "拿走一个插件"= 树与记录表**一起**删（删一半会留下一棵
        #   没有记录表的树，而那是一条**明确的错误**，不是"没装"）。
        mod.remove_plugin_tree(_SY3, _U3)
        _rc, _out = _sy_sync(_SY3, _CONF_S)
        check("★★ 插件从目录里拿走了 ⇒ **它那一份配置消失**（留着它守护进程会拒绝启动）",
              _rc == 0 and not os.path.exists(_p_solo), "rc=%d %r" % (_rc, _out[:300]))
        check("★★ 而**手写的那一份还在**（判据是位置与名字，不是「整个目录重写一遍」）",
              _rc == 0 and os.path.isfile(_p_typo), repr(_out[:300]))
        check("★★ 主文件的通用键一个字没动",
              mod.parse_config(_CONF_S)[0] == {"cluster_cidr": "192.0.2.0/24",
                                               "readonly_paths": "/shared/home"},
              repr(_sy_read(_CONF_S)[-300:]))
        os.unlink(_p_typo)

        # ── ④b ★★ 为什么这里没有「删块吃到 EOF」那条用例 ─────────────────
        #
        # ★ 删的是整个文件：没有任何行的范围要算，也就没有算错的可能。
        # ★ 而"别的**东西**不许被顺手删掉"那条例律本身还在，由上面那条
        #   「手写的那一份还在」承担 —— 判据是"动的是不是只有它自己那一个文件"。

        # ── ④c ★ 新写的那一份照**主文件**的模式与属主 ───────────────────────
        #
        # ★ 站点配置是 root 拥有的 0644，而"写一份新的"走的是"同目录临时文件 +
        #   rename" —— `tempfile.mkstemp` 建出来是 0600。不显式 chmod 的话，插件
        #   配置会比主配置**更严**（root 读得到、别人读不到），而症状与插件毫无
        #   关系，排查时指错方向。
        #
        # ★★ 取 0640 当夹具是**刻意的**：0600 与 0644 都可能碰巧相同（那会让
        #    "把 chmod 那一步删掉"变成等价变异，一个用例都打不红）。0640 与两者
        #    都不同，删掉那一步当场露馅。
        _CONF_M = os.path.join(_sy_home, "site5.conf")
        with open(_CONF_M, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.2.0/24\n")
        os.chmod(_CONF_M, 0o640)
        _rc, _out = _sy_install([_sy_mk(_U3, "solo")], _SY3)
        _rc, _out = _sy_sync(_SY3, _CONF_M)
        _p_m = mod.plugin_conf_path(_CONF_M, _U3)
        check("★★ 新写的那一份模式照**主文件**（0640，不是 mkstemp 的 0600）",
              _rc == 0 and (os.stat(_p_m).st_mode & 0o777) == 0o640,
              "%o" % (os.stat(_p_m).st_mode & 0o777))
        check("★ 而且它**真的写了**（不是因为什么都没做才「没变」）",
              os.path.isfile(_p_m) and "enabled =" in _sy_read(_p_m),
              _sy_read(_p_m)[-200:] if os.path.isfile(_p_m) else "（没有那个文件）")

        # ── ④d ★★ 报错要说清**成因**（两种成因的修法完全不同）────────────
        #
        # 一个指向没装插件的配置有两种：**安装器起的名字**（插件被拿走了，配置没
        # 跟上）与**手写的**（笔误/过时）。前者的修法是跑一次 `plugin sync`，
        # 后者不是。
        # ★ 判据是**文件名**（是不是 ULID），不再是块头上面那行注释 —— 注释是
        #   内容判据，改一个字、挪走一个空行就失效；名字是结构。
        # ★ 这一条同时钉住 `parse_config` 的第三个返回值**真的被用上了** ——
        #   只算出来不送出去，就是又一个 F35。
        _CONF_D = os.path.join(_sy_home, "site4.conf")
        with open(_CONF_D, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.2.0/24\n")
        _rc, _out = _sy_install([_sy_mk(_U3, "solo")], _SY3)
        _rc, _out = _sy_sync(_SY3, _CONF_D)            # ⇒ 多出 <id>.conf 那一份
        mod.remove_plugin_tree(_SY3, _U3)              # 再把这个插件拿走
        _c_d = _sy_cfg_now(_SY3, _CONF_D)
        _errs = " ".join(_c_d.stale_conf_problems)
        check("★★ 指向没装插件的**安装器那份** ⇒ 报 ⚠ 并指出「跑一次 plugin sync」"
              "（那正是能修它的那个动作）",
              "plugin sync" in _errs and (_U3 + ".conf") in _errs, _errs[:300])
        # ★★ 悬空**不拦启动**。这两条合起来才是这个形状 —— 只断言
        #    "报了 ⚠"的话，一个把悬空**同时**塞进 `validate()` 的实现照样绿，而
        #    那样守护进程会拒绝起来，症状与"插件坏了"毫无关系（改了配置之后连
        #    "停掉正在跑的会话"都做不到）。
        check("★★ 而它**不拦启动** —— `validate()` 里一条都没有（悬空是 ⚠，不是错误）",
              _c_d.validate() == [], str(_c_d.validate())[:300])
        # ★ 先让 sync 把安装器那份收掉，再放一份手写的进去 —— 否则两条同时在，
        #   `_errs2` 里那句指路（来自安装器那份）会把"手写那种不说这句话"测成假的。
        _rc, _out = _sy_sync(_SY3, _CONF_D)
        _p_hand = write_plugin_conf(_CONF_D, "typo2", "enabled = yes\n")
        _c_d2 = _sy_cfg_now(_SY3, _CONF_D)
        _errs2 = " ".join(_c_d2.stale_conf_problems)
        check("★ 对照：**手写的**那种不说这句话（sync 不会替他删，说了就是骗人）",
              _errs2 != "" and "plugin sync" not in _errs2, _errs2[:300])
        check("★ 而报错里带**文件路径** —— 插件配置不在主文件里了，只说名字等于"
              "让管理员去翻一个他找不到的地方",
              _p_hand in _errs2, _errs2[:300])
        check("★ 手写的悬空同样**不拦启动**（两种成因的后果逐字相同，档位就该相同）",
              _c_d2.validate() == [], str(_c_d2.validate())[:300])

        # ── ④e ★★ 有人**手写**了它的配置 ⇒ 安装器不另写一份 ─────────────────
        #
        # ★★ 判据是「**有没有**配置指向这个插件」，不是"它叫什么名字"。少了这一条，
        #    一个已经手写 `solo.conf` 的站点会在下一次 sync 之后**多出**一份
        #    `<ULID>.conf` —— 两份指同一个插件，而那是 `--check` 的硬错误：
        #    守护进程当场拒绝启动，症状与"插件坏了"毫无关系。
        _CONF_H = os.path.join(_sy_home, "site6.conf")
        with open(_CONF_H, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.2.0/24\n")
        _rc, _out = _sy_install([_sy_mk(_U3, "solo")], _SY3)
        _p_by_hand = write_plugin_conf(_CONF_H, "solo", "enabled = yes\n")
        _rc, _out = _sy_sync(_SY3, _CONF_H)
        check("★★ 已经有手写的一份 ⇒ 安装器**不另写** `<id>.conf`"
              "（两份指同一个插件是硬错误）",
              _rc == 0 and not os.path.exists(mod.plugin_conf_path(_CONF_H, _U3)),
              "rc=%d %r" % (_rc, _out[:300]))
        check("★★ 而且配置照旧**自洽**：那份手写的按短名解析得到，开关也真的生效",
              _sy_cfg_now(_SY3, _CONF_H).validate() == []
              and _sy_cfg_now(_SY3, _CONF_H).plugin_config("solo").enabled is True,
              str(_sy_cfg_now(_SY3, _CONF_H).validate())[:200])
        check("★ 手写的那一份**逐字节没被动**",
              _sy_read(_p_by_hand) == "enabled = yes\n", repr(_sy_read(_p_by_hand)))

        # ── ⑤ 清单声明 defaultEnabled=true 的插件 ⇒ 生成的那一份照实写 yes ────
        #
        # ★★ 这一条防的是一处**静默的行为改变**：写死 `enabled = no` 的话，
        #    一个"一份插件配置都没写"的站点（code-server 就靠清单缺省开着）会在装完
        #    第一次装插件之后**悄悄关掉** —— 而配置文件里多了一行，看起来
        #    像是"一直就这样"。
        _SY4 = os.path.join(_sy_home, "plugins4")
        os.makedirs(_SY4, exist_ok=True)
        _rc, _out = _sy_install([_sy_mk(_U3, "solo", default_enabled=True)], _SY4)
        _CONF_T = os.path.join(_sy_home, "site2.conf")
        _T_BASE = "cluster_cidr = 192.0.2.0/24\n"
        with open(_CONF_T, "w", encoding="utf-8") as _f:
            _f.write(_T_BASE)
        _eff_b = _sy_effective(_sy_cfg(_SY4, _T_BASE, "eff-t-before.conf"))

        _t_p = mod.plugin_conf_path(_CONF_T, _U3)
        _rc, _out = _sy_sync(_SY4, _CONF_T, dry_run=True)
        check("★ 演练模式：报出**要做什么**（还没做），而且**一个字节都不写**",
              _rc == 0 and _sy_read(_CONF_T) == _T_BASE and "演练" in _out
              and _t_p in _out and not os.path.exists(_t_p),
              "rc=%d %r" % (_rc, _out[:300]))

        _rc, _out = _sy_sync(_SY4, _CONF_T)
        check("★★ 清单标了 defaultEnabled=true ⇒ 生成的那一份写 **enabled = yes**"
              "（照实说出生效值，不许把它关掉）",
              _rc == 0 and os.path.isfile(_t_p)
              and "\nenabled = yes" in _sy_read(_t_p),
              _sy_read(_t_p)[-320:] if os.path.isfile(_t_p) else "（没有那个文件）")
        check("★★★ 而且生效值装前装后**逐项相同** —— 生成物不改行为",
              _sy_effective(_sy_cfg_now(_SY4, _CONF_T)) == _eff_b,
              "%s → %s" % (_eff_b, _sy_effective(_sy_cfg_now(_SY4, _CONF_T))))

        # ── ⑥ CLI 接线：`slurmate plugin sync` 真的转发到那个入口 ──────────
        _cli = load_cli()
        _seen = []

        class _FakeRun(object):

            def __call__(self, argv, *a, **kw):
                _seen.append(list(argv))

                class _R(object):
                    returncode = 0

                r = _R()
                # ★★ `stdout` / `stderr` **必须有**：真的 `subprocess.run` 一定带
                #   这两个属性；一个只有 `returncode` 的桩，被调方一读就是
                #   AttributeError。桩比真的瘦，与"桩比真的干净"是同一类毛病。
                #   ★ `is-active` 同理：它要回**真的 systemd 会回的东西**，回空串
                #   会让它走"服务没在跑"那条路，于是下面那条判据永远测不到。
                r.stdout = "active\n" if "is-active" in argv else ""
                r.stderr = ""
                return r

        class _SyncArgs(object):
            plugins_dir = ""
            config = ""

        # ★ `cmd_plugin_sync` 会先 `os.path.isfile(exe)` —— 那是**真的**去问盘上
        #   有没有这个文件，所以夹具得造一个出来（`subprocess.run` 那一层才是
        #   被替掉的）。用一个真的空脚本当替身，与基座安装脚本那条路同形。
        _fake_exe = write_stub(os.path.join(_sy_home, "slurmate-sessiond"),
                               "exit 0\n")
        _saved_run = _cli.subprocess.run
        _saved_exe = _cli.sessiond_path
        _saved_euid = _cli.os.geteuid
        _saved_stdout = sys.stdout
        try:
            _cli.subprocess.run = _FakeRun()
            _cli.sessiond_path = lambda: _fake_exe
            _cli.os.geteuid = lambda: 0
            sys.stdout = io.StringIO()
            _rc = _cli.cmd_plugin_sync(_SyncArgs())
            _sync_out = sys.stdout.getvalue()
        finally:
            _cli.subprocess.run = _saved_run
            _cli.sessiond_path = _saved_exe
            _cli.os.geteuid = _saved_euid
            sys.stdout = _saved_stdout
        check("★ `slurmate plugin sync` 转发到 `--sync-plugins`（判据只有一处）",
              _rc == 0 and _seen and _seen[0][1].endswith("slurmate-sessiond")
              and "--sync-plugins" in _seen[0],
              repr(_seen))
        # ★★ 而对齐成功之后**真的**去让守护进程重读了配置。
        #   没有这一步的话，配置改完就要管理员自己记得重跑一次基座安装脚本，而那是
        #   stop + start —— 所有人的会话断一次，就为了改一行插件配置。
        check("★★ 对齐成功 ⇒ 真的调了 `systemctl reload`（配置改动不再需要重启）",
              any(a[:2] == ["systemctl", "reload"] for a in _seen), repr(_seen))
        check("★★ 而它**说准了**这一步做成了什么：只是「发了重载信号」，"
              "**不是**「配置已生效」—— `systemctl reload` 回 0 只表示信号送到了，"
              "守护进程可能整个拒绝 —— 并指路去看日志",
              "reload" in _sync_out and "没断" in _sync_out
              and "journalctl" in _sync_out, repr(_sync_out[:400]))

        # ★★ 对照组：**服务没在跑**时不许说"已生效" —— 那是两件不同的事，混成
        #    一句就是这一版一路在清的那种静默。
        class _FakeRunDown(_FakeRun):

            def __call__(self, argv, *a, **kw):
                r = _FakeRun.__call__(self, argv, *a, **kw)
                if "is-active" in argv:
                    r.stdout = ""            # 服务没在跑
                return r

        try:
            _n0 = len(_seen)                 # ★ 只判这一轮新加的（`_seen` 是共用的）
            _cli.subprocess.run = _FakeRunDown()
            _cli.sessiond_path = lambda: _fake_exe
            _cli.os.geteuid = lambda: 0
            sys.stdout = io.StringIO()
            _rc = _cli.cmd_plugin_sync(_SyncArgs())
            _down_out = sys.stdout.getvalue()
        finally:
            _cli.subprocess.run = _saved_run
            _cli.sessiond_path = _saved_exe
            _cli.os.geteuid = _saved_euid
            sys.stdout = _saved_stdout
        check("★★ 服务没在跑 ⇒ 说的是「下次启动就会用上」，**不是**「已生效」"
              "（也不去调 reload）",
              _rc == 0 and "下次启动" in _down_out and "没断" not in _down_out
              and not any(a[:2] == ["systemctl", "reload"] for a in _seen[_n0:]),
              "rc=%s / %r / %s" % (_rc, _down_out[:200], _seen[_n0:]))

        # ── ⑦ ★★ `--check-plugins` 那一屏说的是**清单缺省**，不是本站开关（F39）──
        #
        # ★ 与 F37 同一族：**这一屏没有用例**。而这一条比 F37 更隐蔽 —— 它读的
        #   字段**存在**，只是**回答的不是那个问题**。它**不读站点配置**（要能在
        #   配置读不出来的机器上跑），
        #   所以它**不知道**本站开了哪些；若它写的是「启用/停用」，就与
        #   `--check`（读配置、说「已启用/已停用」）**同一个词、两件事** ——
        #   而基座安装脚本里两屏前后紧挨着打印。
        _SY5 = os.path.join(_sy_home, "plugins5")
        os.makedirs(_SY5, exist_ok=True)
        _rc, _out = _sy_install([_sy_mk(_U1, "onplug", default_enabled=True),
                                 _sy_mk(_U2, "offplug")], _SY5)
        _crun = subprocess.run([sys.executable, DAEMON, "--check-plugins",
                                "--plugins-dir", _SY5],
                               capture_output=True, text=True)
        check("★★ 那一列说的是「缺省开/缺省关」（它只知道清单里声明的缺省）",
              _crun.returncode == 0 and "缺省开" in _crun.stdout
              and "缺省关" in _crun.stdout
              and "启用" not in _crun.stdout and "停用" not in _crun.stdout,
              repr(_crun.stdout[-400:]))
        check("★★ 而且它说清这一屏**不读站点配置** —— 不然「缺省开」会被读成"
              "「本站已经开了」",
              "不读站点配置" in _crun.stdout, repr(_crun.stdout[-400:]))
        # ★ 对照组：本站把那个插件关掉了，这一屏**仍然**说「缺省开」。
        #   这不是 bug，是这一条要钉住的**口径** —— 它报的是清单缺省。
        #   站点状态那一屏（`--check`）才是另一个答案。
        _c_off = _sy_cfg(_SY5, "cluster_cidr = 192.0.2.0/24\n"
                               "[plugin:onplug]\nenabled = no\n", "f39-off.conf")
        check("★ 而本站的开关是**另一屏**的事（这一格说的是清单缺省，不是本站状态）",
              _c_off.validate() == [] and not _c_off.plugin_config("onplug").enabled,
              str(_c_off.validate())[:200])
    finally:
        shutil.rmtree(_sy_home, ignore_errors=True)

    # ── 19.19 ★★ 拆开 install-base.sh 之后的四件事（v0.12 阶段 4）─────────────────
    #
    # 这四件事都住在守护进程里，可以直接调，于是这一节是**真跑** —— 若留在
    # `install-base.sh` 的 bash 里，就只能**抠它那段出来真跑**才能验到一点
    # （它本机跑不了整套：要 root + 一台控制节点，见 KNOWN-ISSUES 的 U2）。
    #
    #   ① 目录模式：`--from DIR` 装整批，并把上一次由本模式装过、这次没有的卸掉
    #   ② 卸插件：一个插件在站点上留下**恰好四处**痕迹，全删，不多删
    #   ③ 对账顺手织作业脚本，并清掉不再属于任何插件的那几份
    #   ④ `--check` 的两个退出码：机器级(2) vs 配置级(1)
    print("\n── 19.19. 拆开 install-base.sh 之后的四件事 ──")
    _d4 = tempfile.mkdtemp(prefix="slurmate-split-")
    _ck = tempfile.mkdtemp(prefix="slurmate-ck-")
    try:
        def _mk4(uid, name, ver="1.0.0", out=None):
            """一个合法的包：清单 + 一份**过得了三道断言**的作业侧。"""
            return put_package(out or _d4, [
                ("plugin.json", json.dumps(
                    {"id": uid, "name": name, "version": ver,
                     "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8")),
                ("job/start.sh",
                 ("start_%s() { :; }\n" % name.replace("-", "_")).encode("utf-8")),
            ])

        def _quiet(fn, *a, **kw):
            buf = io.StringIO()
            rc = fn(*a, say=lambda *x: buf.write(
                " ".join(str(y) for y in x) + "\n"), **kw)
            return rc, buf.getvalue()

        def _ls(d, suffix):
            """目录里那几种文件。★ 目录**被收掉了**就是空 —— 那正是 `--all`
            之后该有的样子，不是错误。"""
            try:
                return sorted(x for x in os.listdir(d) if x.endswith(suffix))
            except OSError:
                return []

        def _pkgs(pd):
            """站点上装着哪几个插件 —— 判据是**记录表**（一个插件在这
            个目录里占**两个**条目：一棵树 + 一份记录表，而记录表是提交点）。"""
            return sorted(x for x in _ls(pd, ".json") if not x.startswith("."))

        def _jobs_of(jd):
            return _ls(jd, ".sbatch")

        def _read_of(path):
            """读一份文件；不在就是空串。
            ★ 少了它，一条"本该红"的断言会先抛 FileNotFoundError —— 于是用例是
              **被打崩**的，而不是干净地红。这两种读法在报告里必须分得开。"""
            try:
                with open(path, encoding="utf-8") as f:
                    return f.read()
            except OSError:
                return ""

        _U1 = "01M2JKHTZGKJBFQQTWYXMQMF70"      # alpha
        _U2 = "01M2JKHTZGKJBFQQTWYXMQMF71"      # beta
        _U3 = "01M2JKHTZGKJBFQQTWYXMQMF72"      # gamma（只手动装）
        _SRC = os.path.join(_d4, "src")
        _PD = os.path.join(_d4, "plugins")
        _JD = os.path.join(_d4, "jobs")
        _SITE = os.path.join(_d4, "site.conf")
        os.makedirs(_SRC, exist_ok=True)
        with open(_SITE, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.2.0/24\n")

        def _sync():
            return _quiet(mod.sync_plugins, _SITE, _PD, jobs_dir=_JD,
                          template_path=os.path.join(HERE, "run.sbatch"))

        def _from_src():
            return _quiet(mod.install_plugins, [], _PD, src_dir=_SRC)

        # ── ① 目录模式：整批装上 ──────────────────────────────────────────
        _mk4(_U1, "alpha", out=_SRC)
        _mk4(_U2, "beta", out=_SRC)
        _rc, _out = _from_src()
        check("★★ --from DIR：目录里的包全装上，并按 id 落地成一棵树 + 一份记录表",
              _rc == 0 and _pkgs(_PD) == [_U1 + ".json", _U2 + ".json"]
              and all(os.path.isdir(mod.plugin_tree_dir(_PD, u))
                      for u in (_U1, _U2)),
              "%d %r %r" % (_rc, sorted(os.listdir(_PD)), _out[:200]))
        check("★ 而它记下了「这一次是目录模式装的哪几个」（下一轮对账要靠它）"
              "—— 每行是**裸 id**（一个插件两个条目，共同的名字就是 id）",
              _read_installed(_PD) == [_U1, _U2],
              repr(_read_installed(_PD)))

        # ── ①a 从源目录拿走一个 ⇒ 站点上那个也真的没了 ────────────────────
        #    ★ 这是"把一个包从源里移走再同步"——最自然的卸载动作。判据是**记录**，
        #      不是"目录里现在有什么"。
        os.unlink(os.path.join(_SRC, _U2 + ".splug"))
        _rc, _out = _from_src()
        check("★★ 源里拿走一个包再同步 ⇒ 站点上那个插件也没了"
              "（树与记录表一起走）",
              _rc == 0 and _pkgs(_PD) == [_U1 + ".json"]
              and not os.path.isdir(mod.plugin_tree_dir(_PD, _U2)),
              "%d %r" % (_rc, _pkgs(_PD)))

        # ── ①b ★★ 而**手动装的**那个不受目录模式管 ────────────────────────
        #    这正是"记录"与"目录里现在有什么"的分野：手动装是**显式动作**，
        #    一次集合同步不该把它悄悄撤销。
        _mk4(_U3, "gamma", out=_d4)
        _quiet(mod.install_plugins, [os.path.join(_d4, _U3 + ".splug")], _PD)
        _rc, _out = _from_src()
        check("★★ 手动装的插件不会被一次目录同步撤销（它不在记录里）",
              _rc == 0 and _pkgs(_PD) == [_U1 + ".json", _U3 + ".json"],
              "%d %r" % (_rc, _pkgs(_PD)))

        # ── ①c 空目录是合法的：它表示「这次要装的是空集」──────────────────
        _empty = os.path.join(_d4, "empty")
        os.makedirs(_empty, exist_ok=True)
        _rc, _out = _quiet(mod.install_plugins, [], _PD, src_dir=_empty)
        check("★ 空目录合法，且它表示「这一次要装的是空集」",
              _rc == 0 and "空集" in _out, "%d %r" % (_rc, _out[:300]))
        check("★★ 于是上次由目录模式装的那个没了，**手动装的那个还在**",
              _pkgs(_PD) == [_U3 + ".json"], repr(_pkgs(_PD)))

        # ── ①d 源目录里混进一棵源码树 ⇒ **一个字节都不写** ────────────────
        _bad_src = os.path.join(_d4, "badsrc")
        os.makedirs(os.path.join(_bad_src, "sometree"), exist_ok=True)
        with open(os.path.join(_bad_src, "sometree", "plugin.json"), "w",
                  encoding="utf-8") as _f:
            _f.write("{}\n")
        _mk4(_U1, "alpha", out=_bad_src)
        _before = _pkgs(_PD)
        _rc, _out = _quiet(mod.install_plugins, [], _PD, src_dir=_bad_src)
        check("★★ 源目录里混着源码树 ⇒ 拒绝，且**一个字节都没写**",
              _rc == 1 and "源码树" in _out and _pkgs(_PD) == _before,
              "%d %r" % (_rc, _out[:300]))

        # ── ③ 对账顺手织作业脚本 ──────────────────────────────────────────
        _rc, _out = _from_src()
        check("（夹具）现在站点上装着 alpha 与 gamma",
              _pkgs(_PD) == sorted([_U1 + ".json", _U3 + ".json"]), repr(_pkgs(_PD)))
        _rc, _out = _sync()
        check("★★ 对账顺手织出了作业脚本（一个插件一份，按 id 命名）",
              _rc == 0 and _jobs_of(_JD) == sorted([_U1 + ".sbatch", _U3 + ".sbatch"]),
              "%d %r %r" % (_rc, _jobs_of(_JD), _out[-300:]))
        _woven = _read_of(os.path.join(_JD, _U1 + ".sbatch"))
        check("★ 织出来的那一份真的含这个插件的作业侧（拼接标记一处不剩）",
              "start_alpha()" in _woven
              and not re.search(r"(?m)^# @@SLURMATE_PLUGIN_BLOCKS@@$", _woven))
        check("★ 而它**语法上**是合法 shell（两遍式的第一遍就是 bash -n）",
              subprocess.run(["bash", "-n", os.path.join(_JD, _U1 + ".sbatch")],
                             capture_output=True).returncode == 0)
        check("★★ 幂等：再对账一次，一份都不多、一份都不少",
              _sync()[0] == 0 and _jobs_of(_JD) == sorted(
                  [_U1 + ".sbatch", _U3 + ".sbatch"]), repr(_jobs_of(_JD)))

        # ── ③c ★★ 插件脚本**语法错** ⇒ 对账拒绝，且一份都不装 ────────────────
        #
        # 两遍式的全部意义在这一条上：先把 N 份全部生成并逐份 `bash -n`，
        # **全过了才开始装**。少了那道语法闸，一份语法错的插件脚本会被装进
        # jobs/ —— 而它的失败要到**用户的作业在计算节点上跑起来**时才出现，
        # 那时报的是"作业脚本第 N 行错了"，指不回是哪个插件的哪一次对账。
        _U4 = "01M2JKHTZGKJBFQQTWYXMQMF73"
        _broken = put_package(_d4, [
            ("plugin.json", json.dumps(
                {"id": _U4, "name": "broken", "version": "1.0.0",
                 "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8")),
            # ★ 函数名**对**（三道断言那一关要能过），错的是 shell 语法本身
            #   —— 这样这一条红的成因才唯一。
            ("job/start.sh", b"start_broken() {\n"),
        ])
        check("（夹具）那份插件包装得上（语法错不归安装器管）",
              _quiet(mod.install_plugins, [_broken], _PD)[0] == 0, repr(_pkgs(_PD)))
        _jobs_before = _jobs_of(_JD)
        _rc, _out = _sync()
        check("★★ 插件脚本语法错 ⇒ 对账返回 1（不是静默装下去）",
              _rc == 1 and "语法检查失败" in _out, "%d %r" % (_rc, _out[-300:]))
        check("★★ 而且作业脚本目录**一份都没动**（两遍式：全过了才开始装）",
              _jobs_of(_JD) == _jobs_before,
              "%r → %r" % (_jobs_before, _jobs_of(_JD)))
        check("★ 而它说清了「配置那一半已经对齐、只有作业脚本没织成」"
              "（两件事分开说，免得让人去重装那个已经装好的包）",
              "作业脚本没织成" in _out, repr(_out[-200:]))
        _quiet(mod.uninstall_plugins, [_U4], _PD, _SITE, _JD)
        _sync()
        check("★ （收拾干净）语法错的那个卸掉之后，对账又回到 0",
              _jobs_of(_JD) == _jobs_before, repr(_jobs_of(_JD)))

        # ── ③d ★★ 「不可用」不等于「替你把它删了」─────────────────────────
        #
        # ★★ 一个人改了树里一个字节 ⇒ 那个插件**不可用**（不分发、不织、报出来）。
        #    但它**还是装着的** —— 于是它那份配置与作业脚本**必须原地不动**。
        #
        #    判据要是写错成"不在 `specs` 里就删"，一次篡改就会**静默删掉**管理员
        #    改过的 `enabled` / 默认资源，而症状要到他修好篡改、重跑一次 sync 之后
        #    才出现（配置回到了安装缺省值，看起来像"我明明改过啊"）。
        #    ⇒ 判据是**"盘上还有没有那棵树"**（`plugin_ids_present`），不是"能不能用"。
        _rc, _out = _from_src()                # alpha 与 gamma 都在
        _sync()
        _conf_u1 = mod.plugin_conf_path(_SITE, _U1)
        _job_u1 = os.path.join(_JD, _U1 + ".sbatch")
        check("（夹具）那两份派生物都在",
              os.path.isfile(_conf_u1) and os.path.isfile(_job_u1),
              "%r %r" % (os.path.isfile(_conf_u1), _jobs_of(_JD)))
        _j_one = _read_of(_job_u1)
        _tp_u1 = os.path.join(mod.plugin_tree_dir(_PD, _U1), "job", "start.sh")
        with open(_tp_u1, "r+b") as _f:
            _b0 = _f.read(1)
            _f.seek(0)
            _f.write(bytes([_b0[0] ^ 0x01]))       # 原地改一个字节，长度不动
        _rc, _out = _sync()
        check("★★ 对不过账的那个插件：对账**照常返回 0**，其余照常工作"
              "（一个插件坏了不带走整个站点）",
              _rc == 0 and "不织它们" in _out, "%d %r" % (_rc, _out[-400:]))
        check("★★ 而它那份**配置**原地不动（不是「不在 specs 里就删」）",
              os.path.isfile(_conf_u1), repr(sorted(os.listdir(
                  mod.plugin_conf_dir(_SITE)))))
        check("★★ 它那份**作业脚本**也原地不动，而且**一个字节都没重织**"
              "（被改过的字节进不了作业脚本）",
              os.path.isfile(_job_u1) and _read_of(_job_u1) == _j_one,
              "%r" % (_jobs_of(_JD),))
        check("★ 而它**真的不可用**了：扫描器不再收它（提交不到它）",
              _U1 not in [s.id for s in mod.scan_plugins(_PD)[0]],
              str([s.id for s in mod.scan_plugins(_PD)[0]]))
        # ★ 修好（卸掉再装一次）⇒ 一切照旧，而且配置**没有**被中途删过
        _quiet(mod.uninstall_plugins, [_U1], _PD, _SITE, _JD)
        _from_src()
        _sync()
        check("★ 修好之后那两份派生物又回来了（上面那次没有把谁删掉）",
              os.path.isfile(_conf_u1) and os.path.isfile(_job_u1)
              and _read_of(_job_u1) == _j_one, repr(_jobs_of(_JD)))

        # ── ③b 包没了 ⇒ 它那份作业脚本也跟着走 ───────────────────────────
        _mk4(_U2, "beta", out=_SRC)
        _from_src()
        _sync()
        check("（夹具）三个插件的作业脚本都在",
              _jobs_of(_JD) == sorted([_U1 + ".sbatch", _U2 + ".sbatch",
                                       _U3 + ".sbatch"]), repr(_jobs_of(_JD)))
        os.unlink(os.path.join(_SRC, _U2 + ".splug"))
        _from_src()
        _sync()
        check("★★ 包被拿走后，它那份作业脚本也清了（不留无主的、仍可提交的脚本）",
              _jobs_of(_JD) == sorted([_U1 + ".sbatch", _U3 + ".sbatch"]),
              repr(_jobs_of(_JD)))
        check("★★ 而它那份配置也清了（两份派生物同一个判据）",
              not os.path.isfile(mod.plugin_conf_path(_SITE, _U2))
              and os.path.isfile(mod.plugin_conf_path(_SITE, _U1)),
              repr(sorted(os.listdir(mod.plugin_conf_dir(_SITE)))))

        # ── ② 卸插件：恰好四处，一处不多 ──────────────────────────────────
        _conf_of = mod.plugin_conf_path(_SITE, _U1)
        check("（夹具）那五处都在：树 / 记录表 / 它那份配置 / 作业脚本 / 钥匙记录",
              os.path.isdir(mod.plugin_tree_dir(_PD, _U1))
              and os.path.isfile(mod.plugin_record_path(_PD, _U1))
              and os.path.isfile(_conf_of)
              and os.path.isfile(os.path.join(_JD, _U1 + ".sbatch"))
              and _U1 in mod.read_plugin_keys(_PD),
              "%r %r %r" % (os.path.isfile(_conf_of), _jobs_of(_JD),
                            sorted(mod.read_plugin_keys(_PD))))
        _rc, _out = _quiet(mod.uninstall_plugins, [_U1], _PD, _SITE, _JD)
        check("★★ 卸掉之后那五处**一处都不剩**",
              _rc == 0
              and not os.path.isdir(mod.plugin_tree_dir(_PD, _U1))
              and not os.path.isfile(mod.plugin_record_path(_PD, _U1))
              and not os.path.isfile(_conf_of)
              and not os.path.isfile(os.path.join(_JD, _U1 + ".sbatch"))
              and _U1 not in mod.read_plugin_keys(_PD),
              "%d %r" % (_rc, _out[:300]))
        check("★★ 而**别的插件**一处都没被碰（gamma 还在，记录里也还有它）",
              _pkgs(_PD) == [_U3 + ".json"]
              and os.path.isdir(mod.plugin_tree_dir(_PD, _U3))
              and _U3 in mod.read_plugin_keys(_PD),
              "%r %r" % (_pkgs(_PD), sorted(mod.read_plugin_keys(_PD))))
        check("★★ 手写的那一份配置一个字不动（判据是文件名，不是内容）",
              _write_manual_conf(_SITE, "handwritten"),
              repr(sorted(os.listdir(mod.plugin_conf_dir(_SITE)))))
        # ★★ 插件目录里**旁人手写的东西**：卸载一个插件时一个字节都不许动它。
        #    它是 `_remove_stale_plugins` 那条「没有记录表就不删」的另一半 ——
        #    那一半管"自动对账别删别人的东西"，这一半管"显式卸载也只删自己那五处"。
        _bystander = os.path.join(_PD, "管理员自己的笔记.txt")
        with open(_bystander, "w", encoding="utf-8") as _f:
            _f.write("这是我自己放在这儿的\n")
        _quiet(mod.uninstall_plugins, [_U3], _PD, _SITE, _JD)
        check("★★ 卸载只删自己那五处 —— 旁人放在插件目录里的文件一个字不动",
              os.path.isfile(_bystander)
              and not os.path.isdir(mod.plugin_tree_dir(_PD, _U3)),
              repr(sorted(os.listdir(_PD)) if os.path.isdir(_PD) else None))
        os.unlink(_bystander)
        _quiet(mod.install_plugins, [_mk4(_U3, "gamma", out=_d4)], _PD)

        # ── ②b --all：三处痕迹取并集；手写的不在并集里 ────────────────────
        _rc, _out = _quiet(mod.uninstall_plugins, [], _PD, _SITE, _JD,
                           uninstall_all=True)
        check("★★ --all 把本站的插件都卸了（一棵树都不剩）",
              _rc == 0 and _pkgs(_PD) == []
              and not os.path.isdir(mod.plugin_tree_dir(_PD, _U3)),
              "%d %r %r" % (_rc, _pkgs(_PD),
                            sorted(os.listdir(_PD))
                            if os.path.isdir(_PD) else None))
        check("★★ 手写的那一份**不在并集里**（它不是 ULID 命名的）⇒ 一个字没动",
              os.path.isfile(os.path.join(mod.plugin_conf_dir(_SITE),
                                          "handwritten.conf")),
              repr(sorted(os.listdir(mod.plugin_conf_dir(_SITE)))))
        check("★ 而空掉的那几个目录被收掉了（`rmdir` 只在**空掉**时成功）",
              not os.path.isdir(_JD) and not os.path.isdir(_PD),
              "jd=%r pd=%r 里面还有 %r" % (
                  os.path.isdir(_JD), os.path.isdir(_PD),
                  sorted(os.listdir(_PD)) if os.path.isdir(_PD) else None))
        check("★ 而它**没有**伸手去删上一层（那是基座的地方）",
              os.path.isdir(_d4), repr(os.path.isdir(_d4)))

        # ── ②c 认不出的 id ⇒ 用法错误，不是静默什么都不做 ─────────────────
        _rc, _out = _quiet(mod.uninstall_plugins, ["not-a-ulid"], _PD, _SITE, _JD)
        check("★★ 给一个不是 ULID 的 id ⇒ 用法错误（2），并说清 id 与短名的区别",
              _rc == 2 and "ULID" in _out and "短名" in _out,
              "%d %r" % (_rc, _out[:300]))

        # ── ④ `--check` 的两个退出码 ──────────────────────────────────────
        #
        # ★★ 这是"部署脚本要能把「这台机器缺东西」与「这份配置写错了」分开"
        #    那条约定的落点（见 machine_selfcheck 的说明）。判据是**真的跑**，
        #    不是读源码里有没有那个数 —— 一个没人读的退出码与没有它是一样的。
        #
        # ★ 这一节**不能靠改 PATH 来造"机器缺 Slurm"**：本机（一台计算节点）
        #   的 /usr/bin 下真的装着那些命令，而 `resolve_bin` 除了 PATH 还会查
        #   `SLURM_BIN_DIRS`。所以"机器级"那一半用**单元级**（直接调
        #   machine_selfcheck）+ **接线级**（替换掉它，看 main 返回几）。
        _ckconf = os.path.join(_ck, "c.conf")
        with open(_ckconf, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.2.0/24\n"
                     "range_start = 55001\nrange_end = 55999\n"
                     "readonly_paths = /shared/home\n")

        class _FakeCfg(object):
            def __init__(self, missing=(), nft_ok=True):
                for _n in mod.SLURM_COMMANDS:
                    setattr(self, _n, None if _n in missing else "/bin/true")
                self._nft_ok = nft_ok

        _m_none = mod.machine_selfcheck(_FakeCfg())
        check("（夹具）八个命令都解析得到、nft 也在 ⇒ 机器级一条问题都没有",
              _m_none == [], repr(_m_none))
        _m_one = mod.machine_selfcheck(_FakeCfg(missing=("squeue",)))
        check("★★ 少一个 Slurm 命令 ⇒ 机器级一条问题，并**点名**是哪一个、"
              "以及「这台机器不像是登录节点」",
              len(_m_one) == 1 and "squeue" in _m_one[0]
              and "登录节点" in _m_one[0], repr(_m_one))
        _m_nft = mod.machine_selfcheck(_FakeCfg(), nft="/nonexistent/nft")
        check("★ 找不到 nft ⇒ 也是机器级（它同样与配置好坏无关）",
              len(_m_nft) == 1 and "nft" in _m_nft[0], repr(_m_nft))

        # 接线：main() 把三档翻成三个退出码。
        # ★★ 这一段**必须把两个会去问真集群的东西替换掉**（`machine_selfcheck`
        #    与 `crosscheck_cidr`）—— 否则这条用例的结论取决于"跑它的那台机器
        #    长什么样"，而它要考的恰恰是**判据本身**。
        #    ★ 真进程那一半（配置级 ⇒ 1）不用替换：`validate()` 在碰任何集群事实
        #      之前就返回了，所以它在哪台机器上都是同一个答案。
        def _run_check(machine, cidr_errors=()):
            _s_msc, _s_cc = mod.machine_selfcheck, mod.crosscheck_cidr
            _s_argv, _s_out = sys.argv, sys.stdout
            try:
                mod.machine_selfcheck = lambda cfg, nft=None: list(machine)
                mod.crosscheck_cidr = lambda cfg: list(cidr_errors)
                sys.argv = ["slurmate-sessiond", "--check", "--config", _ckconf]
                sys.stdout = io.StringIO()
                rc = mod.main()
                return rc, sys.stdout.getvalue()
            finally:
                mod.machine_selfcheck, mod.crosscheck_cidr = _s_msc, _s_cc
                sys.argv, sys.stdout = _s_argv, _s_out

        _rc2, _out2 = _run_check(["假的：这台机器缺 sbatch"])
        check("★★ 机器级有问题 ⇒ main() 返回 **2**（部署脚本据此在装任何文件之前"
              "停下），而且**整屏照样打完**",
              _rc2 == 2 and "假的：这台机器缺 sbatch" in _out2
              and "端口池" in _out2 and "作业脚本目录" in _out2,
              "%d %r" % (_rc2, _out2[:300]))
        _rc1, _out1 = _run_check([], ["假的：网段对不上"])
        check("★★ 只有配置级的问题 ⇒ **1**（不是 2）—— 部署脚本据此决定"
              "「继续装、装完再判」",
              _rc1 == 1 and "对不上" in _out1, "%d %r" % (_rc1, _out1[-300:]))
        _rc0, _out0 = _run_check([])
        check("★★ 两样都没问题 ⇒ **0**（少了这一条，上面两条会被「永远非零」"
              "一并满足）", _rc0 == 0, "%d %r" % (_rc0, _out0[:200]))
        _rcm, _outm = _run_check(["机器缺东西"], ["网段也对不上"])
        check("★★ 两样都有 ⇒ **2 优先**（一台不是登录节点的机器上，"
              "「配置写错了」这句话没什么用）",
              _rcm == 2, "%d %r" % (_rcm, _outm[:200]))

        # 配置级那一条跑**真进程**：cluster_cidr 空着 ⇒ 1。
        _badconf = os.path.join(_ck, "bad.conf")
        with open(_badconf, "w", encoding="utf-8") as _f:
            _f.write("range_start = 55001\nrange_end = 55999\n")
        _r_c = subprocess.run([sys.executable, DAEMON, "--check", "--config", _badconf],
                              capture_output=True, text=True)
        check("★★ 真进程也一样：配置级失败（cluster_cidr 空着）⇒ **1**，"
              "而不是 2",
              _r_c.returncode == 1 and "配置错误" in _r_c.stdout
              and "集群网段" in _r_c.stdout,
              "%d %r" % (_r_c.returncode, _r_c.stdout[-300:]))

        # ── ④b 端口池与本机保留端口的重叠：一条 ⚠，动不了退出码 ────────────
        _cfg4 = make_config(mod, _ck)
        _w = mod.reserved_ports_warning(
            _cfg4, "%d-%d" % (_cfg4.port_start + 1, _cfg4.port_start + 2))
        check("★★ 重叠 ⇒ 说一条 ⚠，点名那两个区间与那个文件",
              _w is not None and str(_cfg4.port_start) in _w
              and "ip_local_reserved_ports" in _w, repr(_w))
        check("★ 不重叠 ⇒ 一个字都不说（「没报」与「没事」必须分得开）",
              mod.reserved_ports_warning(_cfg4, "1-100") is None)
        check("★★ 内核那个格式**单项与区间都收**（与 reserved_ranges 的解析器"
              "刻意是两份：两份输入的语法本来就不同）",
              mod.parse_port_set("5000,6000-7000") == [(5000, 5000), (6000, 7000)],
              repr(mod.parse_port_set("5000,6000-7000")))
        check("★ 而 reserved_ranges 那边**只收区间**（一个裸数字多半是写错了，"
              "拒掉比猜好）—— 两份解析器刻意不合并",
              _raises(lambda: mod.parse_reserved_ranges("5000")),
              "parse_reserved_ranges('5000') 应当抛 ValueError")
    finally:
        shutil.rmtree(_d4, ignore_errors=True)
        shutil.rmtree(_ck, ignore_errors=True)


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
    # 所以这里**真的编织一遍**（照安装器的做法，同一个标记、同一段 awk），
    # 再真的调一次分派。
    print("\n── 21. 作业侧契约（宿主 ↔ 插件的唯一接口：函数名）──")
    _tpl = open(_rb, encoding="utf-8").read()
    # ★ **一个插件一份**：逐插件织，而不是把所有插件织进一份。
    #   这一节的分叉后果是"用例绿了、真机上炸" —— 所以织法必须与实现同形。
    _woven_of = {}
    _awk = None
    for _sp in cfg.plugin_specs:
        _out = os.path.join(tmpdir, "woven-%s.sbatch" % _sp.name)
        _awk = weave_one(_rb, _sp.install_dir, _sp.name, _sp.id, _out)
        _woven_of[_sp.name] = _out
    _woven = _woven_of[CS]        # 22a 用它，见下
    # ★ 数的是**整行**的标记：模板的文件头注释里也提到了它，子串匹配会把它也算上，
    #   于是"替换成功"这件事看起来永远不成立 —— install-base.sh 里那条同理。
    check("★ 模板里的拼接标记恰好一处，编织后一处不剩（照安装器的做法）",
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
        with open(os.path.join(_sp.install_dir, "job", "start.sh"),
                  encoding="utf-8") as _jf:
            _jsrc = _jf.read()
        check("★ 它里面没有 shebang / #SBATCH（拼接点之后它们不会生效）",
              re.search(r"(?m)^#!|^[ \t]*#SBATCH", _jsrc) is None)
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
    # ★ 一个插件一份之后，"本站没有作业侧实现了 X"那种形状在作业里不存在；
    #   这一条要兜的是**部署期选错了脚本**（提交了 A、跑起来的是 B）——
    #   守护进程那边由第 17 节的纯函数用例保证不选错，这里是万一漏了之后的
    #   最后一道网：以 24 明确结束，而不是拿错误的实现去跑、或者跑完所有候选
    #   端口才报一句"候选端口全部失败"。
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

    # ── 22d ★ 作业日志：一份实时、按流分开、而且插件藏不走 ────────────────
    #
    # 契约（run.sbatch 第 1 节 + packer/docs/README.md〈作业日志〉）：作业的输出
    # **只有一处** —— Slurm 抓的那两个文件 `slurm-<作业号>.out` / `.err`。宿主自己
    # 写的每一行、以及服务进程写的每一行，都在产生的那一刻落在那上面。
    #
    # ★★ 这一节从前判的是**另一套机制**：宿主"本地日志 + 往 NFS 补写"双写、服务
    #    进程把输出重定向到自己的文件、结束时由 `cleanup_<短名>` 取尾部并回来；
    #    三条断言分别盯着"水位不许错位""并进来的行要上得去""偷偷写 LOCAL_LOG 的
    #    行进不去"。那套东西整段删掉了（连同水位、`$LOCAL_LOG` / `$NFS_LOG` 两个
    #    契约变量），所以这里的判据换成它替换成的那几条 —— **判据跟着被守的东西
    #    走**，不是删掉了事。
    #
    # ★ 而"服务进程的输出**实时**可见"这条性质在真机上的失败形态是静默的：日志
    #   文件建出来了、宿主的行进得去、一切看起来正常，只有服务那部分**一个字都没有**。
    #   这里用"起一个真的往两条流上各写一行的服务"把它钉住。
    _woven_raw = os.path.join(tmpdir, "woven-raw.sbatch")
    with open(os.path.join(tmpdir, "blocks_r.sh"), "w", encoding="utf-8") as _f:
        _f.write(
            # 服务进程：stdout 一行、stderr 一行，然后挂住（让存活门看得见它）。
            # ★ **一个重定向都不加** —— 这正是契约要求的形状，宿主会在 start_ 返回
            #   之后核对（`svc_stream_ok`）。
            "start_thing() {\n"
            "    ( printf '服务写到 stdout 的一行\\n'\n"
            "      printf '服务写到 stderr 的一行\\n' >&2\n"
            "      sleep 60 ) &\n"
            "    SVC_PID=$!\n"
            "    log '插件用 log() 写的一行'\n"
            "    return 0\n"
            "}\n")
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
    # ★ 两份分开读：这一节有好几条判据问的是"**哪一份**里有它"。合起来读的话
    #   "out 和 err 分开了"这件事本身就没法断言。
    _ldir = os.path.join(_hr, ".slurmate", "logs")
    _lout = _read_logs_part(_hr, ".out")
    _lerr = _read_logs_part(_hr, ".err")
    _rlines = [x for x in _rlog.split("\n") if x.strip()]
    _dupes = sorted({x for x in _rlines if _rlines.count(x) > 1})
    check("★ 会话确实跑到了 running（下面几条不是在一个早退的作业上验的）",
          any("会话就绪" in x for x in _rlines), _rlog[-400:])
    check("★★ 两份日志都在，而且名字就是 `slurm-<作业号>.{out,err}`"
          "（合成一份的话，「这个服务往 stderr 上抱怨了什么」就没法单独看 —— "
          "而出故障时那恰恰是唯一有用的那半）",
          os.path.isfile(os.path.join(_ldir, "slurm-777001.out"))
          and os.path.isfile(os.path.join(_ldir, "slurm-777001.err")),
          str(sorted(os.listdir(_ldir))))
    check("★★ 服务进程写到 **stdout** 的行实时落在 `.out` 上"
          "（从前它落在计算节点一个登录节点看不见的临时文件里，作业结束才并回来 —— "
          "于是「作业跑着的时候为什么起不来」在站点上无话可说）",
          "服务写到 stdout 的一行" in _lout, _lout[-300:])
    check("★★ 服务进程写到 **stderr** 的行落在 `.err` 上，**不在** `.out` 里"
          "（分开是按流分，不是按内容猜 —— 两边都留一份的话，"
          "「打开 .err 就能看到全部问题」这条性质就没了）",
          "服务写到 stderr 的一行" in _lerr
          and "服务写到 stderr 的一行" not in _lout,
          "out=%r err=%r" % (_lout[-200:], _lerr[-200:]))
    check("★ 宿主自己的日志行**恰好出现一次**（从前这里守的是「水位不许错位」；"
          "现在是另一个理由：只有一处写，任何一处重复写都会让它在两份文件里各出现一次）",
          _dupes == [], "重复了：%s" % [x[-70:] for x in _dupes])
    check("★ 插件用 log() 写的行也在（宿主与插件共用同一条流）",
          "插件用 log() 写的一行" in _rlog, _rlog[-300:])
    check("★ 而作业结束时**没有**任何「补写」动作 —— 收尾那几行本来就是实时的",
          "清理完成" in _rlog, _rlog[-300:])

    # ── 22d-1b ★★ 插件把服务的输出藏起来 ⇒ 拒绝启动 ────────────────────────
    #
    # ★★ 这一条是"插件想走歪门邪道也走不通"那个要求的落点。契约要求 start_<短名>
    #    起的服务**继承**宿主的 stdout/stderr；重定向走 = 服务的输出在站点上永远
    #    看不到，而且**不报错**（界面上是"作业起来了，日志只有宿主那几行"）。
    #
    # ★ 判据是 `/proc/<pid>/fd/N` 与宿主自己的 fd 是不是同一个对象，**不是**扫插件
    #   源码：扫 shell 扫不干净（变量、exec 3>、命令替换、函数的间接调用）。这里
    #   用的正是那种"扫不出来"的写法之一 —— 路径存在变量里、重定向写在子 shell 上。
    _woven_bad = os.path.join(tmpdir, "woven-steal.sbatch")
    with open(os.path.join(tmpdir, "blocks_steal.sh"), "w", encoding="utf-8") as _f:
        _f.write(
            "start_thing() {\n"
            "    local mine=\"$LOCAL_LOG_DIR/service.log\"\n"
            "    ( sleep 60 ) >> \"$mine\" 2>&1 &\n"
            "    SVC_PID=$!\n"
            "    log '我把服务的输出藏起来了'\n"
            "    return 0\n"
            "}\n")
    _awk_b = subprocess.run(
        ["awk", "-v", "blocks=" + os.path.join(tmpdir, "blocks_steal.sh"),
         '/^# @@SLURMATE_PLUGIN_BLOCKS@@$/ {'
         ' while ((getline line < blocks) > 0) print line;'
         ' close(blocks); found = 1; next }'
         ' { print } END { if (!found) exit 9 }', _rb],
        capture_output=True, text=True)
    with open(_woven_bad, "w", encoding="utf-8") as _f:
        _f.write(_awk_b.stdout)
    _hb = os.path.join(tmpdir, "jobsh-steal")
    os.makedirs(os.path.join(_hb, "bin"), exist_ok=True)
    write_stub(os.path.join(_hb, "bin", "scontrol"),
               'echo "NodeName=node01 NodeAddr=192.0.2.20 State=IDLE"\n')
    _env_b = dict(_env_full)
    _env_b.update({"HOME": _hb, "SLURM_JOB_ID": "777002",
                   "PATH": os.path.join(_hb, "bin") + ":" + os.environ.get("PATH", "/usr/bin:/bin"),
                   "SLURMATE_SESS_DIR": os.path.join(_hb, ".slurmate", "sessions"),
                   "SLURMATE_LOG_DIR": os.path.join(_hb, ".slurmate", "logs")})
    _rb2 = subprocess.run(["bash", _woven_bad], capture_output=True, text=True,
                          env=_env_b, timeout=120)
    _rblog = _read_logs(_hb)
    check("★★ 插件把服务进程的输出重定向走了 ⇒ 作业以 **25** 结束，"
          "而且**当场**（不是跑完所有候选端口才失败）",
          _rb2.returncode == 25, "rc=%s 日志=%s" % (_rb2.returncode, _rblog[-300:]))
    check("★★ 而它说清了是哪一条流、指到了哪里 —— 报错要能照着改",
          "重定向" in _rblog and "fd 1" in _rblog, _rblog[-500:])
    check("★ 而且那句抱怨落在 **.err** 上（它是抱怨，不是进展）",
          "拒绝启动" in _read_logs_part(_hb, ".err"),
          _read_logs_part(_hb, ".err")[-400:])

    # ── 22d-1c ★ 日志的保留期与总量上限 ────────────────────────────────────
    #
    # 两条性质，都是**用户会直接感受到**的：老日志会自己消失、日志目录不会无限涨。
    # 而它们的失败形态是**反过来的** —— 不删，用户的家目录被日志吃满（赔上的是整个
    # 家目录配额），所以这里真的去跑一遍。
    #
    # ★ 体积上限是 10 GiB，造不出来 ⇒ 用 `SLURMATE_LOG_DIR_MAX_BYTES` 顶掉它
    #   （那是这两个常数唯一的用途，见 run.sbatch 第 1b 节）。
    #
    # ★★ 最要紧的一条是**当前这个作业自己的两份不许动**：它们是正在写的，删掉就等于
    #    "作业还在跑，日志凭空没了"。越界时先淘汰别人的。
    def _run_keep_case(tag, cap, pre):
        home = os.path.join(tmpdir, "jobsh-keep-" + tag)
        ldir = os.path.join(home, ".slurmate", "logs")
        os.makedirs(os.path.join(home, "bin"), exist_ok=True)
        os.makedirs(ldir, exist_ok=True)
        write_stub(os.path.join(home, "bin", "scontrol"),
                   'echo "NodeName=node01 NodeAddr=192.0.2.20 State=IDLE"\n')
        for name, days, size in pre:
            f = os.path.join(ldir, name)
            with open(f, "w", encoding="utf-8") as fh:
                fh.write("x" * size)
            stamp = time.time() - days * 86400
            os.utime(f, (stamp, stamp))
        env = dict(_env_full)
        env.update({
            "HOME": home, "SLURM_JOB_ID": "777003",
            "PATH": os.path.join(home, "bin") + ":" + os.environ.get("PATH", "/usr/bin:/bin"),
            "SLURMATE_SESS_DIR": os.path.join(home, ".slurmate", "sessions"),
            "SLURMATE_LOG_DIR": ldir,
            "SLURMATE_LOG_DIR_MAX_BYTES": str(cap),
        })
        proc = subprocess.Popen(["bash", _woven_raw], stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, env=env)
        for _ in range(60):
            time.sleep(0.5)
            if "会话就绪" in _read_logs(home):
                break
        proc.send_signal(_sig.SIGTERM)
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        return home, ldir

    # ① 7 天：30 天前的那一份没了，昨天的那一份还在。
    _hk1, _hk1d = _run_keep_case("days", 10 ** 12, [
        ("slurm-200000.out", 30, 100),
        ("slurm-200001.out", 1, 100),
    ])
    _names1 = sorted(os.listdir(_hk1d))
    check("★★ 7 天前的日志整份删掉、昨天的留着（不删的话，用户的家目录会被日志吃满 —— "
          "而那赔上的是**整个家目录配额**）",
          "slurm-200000.out" not in _names1 and "slurm-200001.out" in _names1,
          str(_names1))

    # ② 总量超限：从**最老的**开始淘汰，而且**当前这个作业自己的两份一个字都不动**。
    #
    # ★★ 上限的取法是**故意**的：三份各 1 MiB、上限 2.5 MiB ⇒ **恰好删掉一份就能
    #    回到线下**。写成"上限很小、删到只剩自己"的话，三份都会被删光 ——
    #    而那时"先删老的"与"先删新的"留下的都是同一个空集，这条判据就
    #    **一条都不红**（变异验证第一轮正是这么逃过去的）。
    _hk2, _hk2d = _run_keep_case("size", 2560 * 1024, [
        ("slurm-200010.out", 3, 1024 * 1024),      # 最老
        ("slurm-200011.out", 2, 1024 * 1024),
        ("slurm-200012.out", 1, 1024 * 1024),
    ])
    _names2 = sorted(os.listdir(_hk2d))
    _all3 = ["slurm-200010.out", "slurm-200011.out", "slurm-200012.out"]
    _kept = [n for n in _all3 if n in _names2]
    check("★★ 目录总量超上限 ⇒ 从**最老的**开始淘汰，删到不超为止 —— "
          "留在这里的必须是最新的那两份（「删了新的、留着老的」就该红）",
          _kept == ["slurm-200011.out", "slurm-200012.out"],
          "留下 %s（全部 %s）" % (_kept, _names2))
    # ③ 上限小到**只留得下当前这个作业自己**：那才是"不许删自己"这条能验出来的
    #    唯一形状。与 ② 分开跑正是为此 —— ② 里自己是最新的，轮到它之前就已经回到
    #    线下了，删不删自己**行为完全一样**（变异验证第一轮就是这么逃过去的）。
    _hk3, _hk3d = _run_keep_case("self", 400, [
        ("slurm-200020.out", 3, 500),
    ])
    _names3 = sorted(os.listdir(_hk3d))
    check("★★ 目录总量超上限时，**当前这个作业自己的两份无论如何都不动** "
          "（它们是正在写的 —— 删掉就等于「作业还在跑，日志凭空没了」）；"
          "别人的照删",
          "slurm-200020.out" not in _names3
          and "slurm-777003.out" in _names3 and "slurm-777003.err" in _names3,
          str(_names3))
    check("★ 淘汰是**说出来**的，不是悄悄删（日志里能读到删了哪一份）",
          "删掉了最老的一份" in _read_logs(_hk3),
          _read_logs(_hk3)[-300:])

    # ── 22d-2 ★ 「每一个候选端口都失败」这条路（F16）────────────────────────
    #
    # **账本上这条不是缺陷，是防线上一个洞。** 它是"计算节点上没装那个服务"的表现：
    # 守护进程解析 `bin` 是在**登录节点**上做的，猜不到计算节点上有没有。这条路
    # 走到最后要做两件事 —— 写一个 `failed` 墓碑（让守护进程立刻知道，而不是等
    # orphan 周期）+ 以 22 结束 —— 而在此之前，仓库里**没有任何一条用例**看过它们。
    #
    # ★ 观测手段是"每个候选端口都返回失败"的假插件：`pick_port_and_start` 会逐个
    #   试完 `SLURMATE_CANDIDATES` 里的两个端口，然后落进那一格。
    _woven_fail = os.path.join(tmpdir, "woven-allfail.sbatch")
    with open(os.path.join(tmpdir, "blocks_f.sh"), "w", encoding="utf-8") as _f:
        _f.write("start_thing() { log '端口 $1 起不来'; return 1; }\n")
    _awkf = subprocess.run(
        ["awk", "-v", "blocks=" + os.path.join(tmpdir, "blocks_f.sh"),
         '/^# @@SLURMATE_PLUGIN_BLOCKS@@$/ {'
         ' while ((getline line < blocks) > 0) print line;'
         ' close(blocks); found = 1; next }'
         ' { print } END { if (!found) exit 9 }', _rb],
        capture_output=True, text=True)
    with open(_woven_fail, "w", encoding="utf-8") as _f:
        _f.write(_awkf.stdout)
    _hf = os.path.join(tmpdir, "jobsh-allfail")
    os.makedirs(_hf, exist_ok=True)
    _rcf, _logf = run_jobsh(_woven_fail, "thing", _hf)
    check("★ 每一个候选端口都失败 ⇒ 以 22 结束（不是 0、不是 24）",
          _rcf == 22, "rc=%s 日志=%s" % (_rcf, _logf[-400:]))
    check("★ 而且两个候选端口**都真的试过**（一个都不许跳过）",
          _logf.count("端口") >= 2 and "55001" in _logf and "55002" in _logf,
          _logf[-400:])
    check("★ 失败原因分类要说出来（「全部失败」一句话指不回根因）",
          "候选端口全部失败" in _logf and "启动失败 2" in _logf, _logf[-400:])
    # ★ 墓碑：守护进程据此**立刻**释放，而不是等一个 orphan 周期。它必须存在的
    #   理由与"这条路有没有人测"是同一件事 —— 没写墓碑时没有人会看见任何异常。
    _sessf = os.path.join(_hf, ".slurmate", "sessions", "job-424242.json")
    _okf, _bodyf = False, "（没有会话文件）"
    if os.path.exists(_sessf):
        with open(_sessf, encoding="utf-8") as _f:
            _bodyf = json.load(_f)
        _okf = (_bodyf.get("state") == "failed" and _bodyf.get("exit_code") == 22)
    check("★ 而且写下了 failed 墓碑、退出码 22（守护进程据此立刻释放）",
          _okf, repr(_bodyf))

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
        install_package(_tld, [
            ("job/start.sh", _body.encode("utf-8")),
            ("plugin.json", json.dumps(
                {"id": _i, "name": _n, "version": "1.0.0",
                 "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8")),
        ])
    _tl_specs, _tl_probs = mod.scan_plugins(_tld)
    check("顶层语句的假插件被扫进来（这条用例自己的前提）",
          sorted(s.name for s in _tl_specs) == ["loud", "quiet"], str(_tl_probs))
    _tl_by = {s.name: s for s in _tl_specs}
    # ★ 这里逐插件织 —— **与安装器同一个形状**。如果哪天退回"共处一份"，
    #   下面第二条会立刻红，而红的方式正是它要防的那件事。
    _tl_home = {}
    for _n in ("loud", "quiet"):
        _o = os.path.join(tmpdir, "tl-%s.sbatch" % _n)
        weave_one(_rb, _tl_by[_n].install_dir, _n, _tl_by[_n].id, _o)
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
    #   （这也正是它必须单独成节的理由。）
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
    # ★ 这一整条链路在本节有覆盖：`phase` 与 `tick()` 都被真调过，四个释放原因
    #   （job_gone / job_<状态> / orphaned / goodbye）、确认阈值、PENDING 保留、
    #   "非 RUNNING 就释放" —— 逐条有用例。少了它们，"REQUEUED 被当成作业结束"
    #   这件事就没有任何东西挡着。
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
    # ★ 这条缺陷是**在真集群上实测出来的**：桩若只喂纯数字，用例就会一直绿 ——
    #   所以这里照真形状喂 `name(uid)`。
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
        # ★ 真集群给的 UserId 是 `name(uid)`：桩若喂纯数字，`int()` 会抛
        #   ValueError、函数静默跳过、一条都恢复不出来。它自己的 docstring 写着
        #   后果：DB 一丢，reconcile() 会把在跑的作业的规则全当成孤儿删掉。
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

    # ── 24b. 会话文件读不到：那句话有节流，而且恢复时说一句（F28）─────────────
    #
    # 这一条的问题只有在别处端到端跑起来才看得见：0.05 秒的 tick 跑几十秒会刷出
    # 两千多行 —— 因为 `refresh_enrollment()` 对**每一个** RUNNING 会话、**每一个**
    # tick 无条件写一行 warning。
    #
    # ★ 判据是"**一个会话在 N 秒里最多几行**"，不是"有没有这一行"。后者判不出
    #   节流：把节流整个删掉，它照样绿。所以下面**两条一起**：
    #   ① 首报必须立刻有（晚 30 分钟才说第一句等于没说）；
    #   ② 在 `ENROLL_FILE_WARN_SECONDS * 3` 秒的窗口里行数**恰好 3**
    #      （t=0 首报、t=T、t=2T），而不是几万行。
    #
    # ★ 时间靠**喂进去**（`now=`），不靠真等：真跑半小时的 tick 是不现实的，
    #   而"等不起"正是时间必须喂进去的原因之一。
    print("\n── 24b. 会话文件读不到的说话频率（F28）──")

    class _LogCatcher(logging.Handler):
        """把守护进程那一个 logger 的记录收下来 —— 判"行数"要看的是**真的发了什么**。"""

        def __init__(self):
            logging.Handler.__init__(self)
            self.lines = []

        def emit(self, rec):
            self.lines.append((rec.levelname, rec.getMessage()))

    _logcat = _LogCatcher()
    _lg = logging.getLogger("slurmate")
    _lg.addHandler(_logcat)
    _lg.setLevel(logging.DEBUG)
    try:
        d.store.close()
        d.store = mod.Store(os.path.join(tmpdir, "f28.db"))
        d.store.insert(session_id="sess-f28", uid=UID, user="alice",
                       partition="A6000", account="acct", cpus=2, mem="8G",
                       requested_time="12:00:00", state=mod.ST_ENROLLED,
                       candidates="55001", created_at=mod.now_ts(), job_id=88001)
        _s = d.store.get("sess-f28")

        # `load_session_file` 报"读不到"，别的一概不动 —— 这一条只问"说了几句"。
        # ★ 钟要**拨**：5400 个 tick 在真实时间里只过去几十毫秒，而这一条的判据
        #   正是"过了多久才再说一次"。不拨钟的话它只会有一行，而那一行**看起来
        #   就像节流生效了** —— 一条判不出节流的用例。
        _real_load = d.load_session_file
        _real_now = mod.now_ts
        _f28_clock = [1_700_000_000.0]
        d.load_session_file = lambda uid, job: (None, "文件不见了")
        mod.now_ts = lambda: _f28_clock[0]
        try:
            _warn_secs = mod.ENROLL_FILE_WARN_SECONDS
            _ticks = _warn_secs * 3
            for _i in range(_ticks):
                _f28_clock[0] += 1.0          # 一个 tick = 一秒
                d.refresh_enrollment(_s, {})
        finally:
            d.load_session_file = _real_load
            mod.now_ts = _real_now
        _miss = [m for lv, m in _logcat.lines if "读不到" in m]
        check("★ 首报**不节流**：一件事第一次发生必须立刻说出来",
              len(_miss) >= 1 and _miss[0].startswith("会话 sess-f28 的会话文件暂时读不到"),
              "报了 %d 行：%s" % (len(_miss), _miss[:3]))
        check("★★ %d 秒里**恰好 %d 行**（首报 + 每 %d 秒一次），而不是 %d 行"
              % (_ticks, _ticks // _warn_secs, _warn_secs, _ticks),
              len(_miss) == _ticks // _warn_secs,
              "报了 %d 行（%d 个 tick）：%s" % (len(_miss), _ticks, _miss[:5]))
        check("★ 而且后续那几行说得清**已经持续多久**（不是把第一句重复一遍）",
              any("已持续" in m for m in _miss[1:]), str(_miss[:3]))

        # 恢复：文件又读得到了 ⇒ **报一次**，而且只说一次（下一次不再说）。
        # `validate_session` 换成一个不干活的桩 —— 这一条只问"恢复那句话说了几次"，
        # 后面的刷新校验是别处的账。
        _real_validate = d.validate_session
        d.load_session_file = lambda uid, job: ({"node_ip": "192.0.2.20",
                                                 "service_port": 55001}, "ok")
        d.validate_session = lambda *a, **k: (False, "这一条不验别的")
        try:
            _before = len(_logcat.lines)
            d.refresh_enrollment(_s, {})
            d.refresh_enrollment(_s, {})
        finally:
            d.load_session_file = _real_load
            d.validate_session = _real_validate
        _back = [m for lv, m in _logcat.lines[_before:] if "又能读到" in m]
        check("★ 文件恢复可读时**报一次恢复**（「没有新行」在日志里长得像「一切正常」）",
              len(_back) == 1, "报了 %d 行：%s" % (len(_back), _back))
    finally:
        _lg.removeHandler(_logcat)

    # ── 25. GRES：一个结构化描述符，和一个拼法 ───────────────────────────────
    #
    # 这一节守的是**一整类**缺陷，不是一条：GRES 是**管理员自定义的**
    # （`GresTypes` + `gres.conf`），名字与型号随集群而定。若假定它只有 `gpu:N`
    # 一种形状 —— 写只写 `"gpu:%d"`、读只认 `re.fullmatch(r"gpu:(\d+)")` —— 那么
    # 带型号的集群上界面会显示"没有 GPU"而作业正占着两张 A100，**没有任何地方
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
    # 缓存：**一个钟周期之内不重复 fork**（这是每个 partitions / cluster 请求
    # 都要走的那条路）。
    #
    # ★ 缓存住在 `Cluster` 里，不在 `Slurm` 上 —— 那是"钟只能有一处"
    #   的直接后果，`Slurm` 变成纯粹无状态的查询层。所以这条断言也搬了家：
    #   直接量 `Slurm.gres_catalog()` 会 fork 三次，而那是**对的**。
    _calls = [0]

    def _counting_run(argv, timeout=10, check=False):
        _calls[0] += 1
        return slurm_stub(argv, timeout, check)

    mod.run_cmd = _counting_run
    try:
        _cl = mod.Cluster(cfg, mod.Slurm(cfg))
        for _ in range(3):
            _cl.gres()
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

    fresh_cluster(mod, d, cfg)
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
    mod.Slurm.gres_catalog = lambda self: None
    fresh_cluster(mod, d, cfg)                 # 让上一段缓存的那一份作废
    try:
        _pv2 = with_stub(mod, _part_run, lambda: d.op_partitions(UID))
    finally:
        mod.Slurm.gres_catalog = _real_cat2
    _p0 = ((_pv2.get("data") or {}).get("partitions") or [{}])[0]
    check("★★ 目录查不到 ⇒ `gres` 这个键**不存在**（不是空列表）",
          _pv2.get("ok") and "gres" not in _p0, str(sorted(_p0)))

    # ── 25.5 ★★ 读回：带型号的会话在视图里是带型号的（今天红的那一条）──────
    #
    # 若用 `re.fullmatch(r"gpu:(\d+)", s["gres"])` 去读 —— 一个自己写进去的
    # `gpu:a100:2` **匹配不上**，于是 `gpus` 是 None，界面显示"没有 GPU"。
    # 缺陷的形状是"写进去的读不回来"，所以用例必须**先经过 list 那一侧**看回来。
    _v_sess = {"session_id": "s1", "job_id": None, "state": mod.ST_RESERVED,
               "partition": "A6000", "cpus": 4, "mem": "16G",
               "gres": json.dumps({"name": "gpu", "type": "a100", "count": 2}),
               "service_kind": "code-server", "service_plugin": "x@1.0.0",
               "node": None, "node_ip": None, "service_port": None,
               "created_at": 0, "enrolled_at": None, "last_hb_socket": None,
               # ★ 手搓的会话行必须把 session_view 读的**每一列**都写出来：
               #   少一列就是一次 KeyError（这一节第一次加 keeper 时正是这样
               #   被拦住的）。它在这里是 None = 确实没人在看。
               "keeper": None,
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

    def _add(dd, sid, job_id=None, state=None, uid=None, keeper=None, hb=None):
        dd.store.insert(session_id=sid, uid=UID if uid is None else uid,
                        user="alice", partition="A6000", account="acct",
                        cpus=2, mem="8G", requested_time="1:00:00",
                        state=state or mod.ST_ENROLLED, job_id=job_id,
                        # ★ v0.9：缺省的 NULL 是有含义的一格（确实没人在看），
                        #   所以这里显式写出来 —— 见 SCHEMA_SQL 里 keeper 那一段。
                        keeper=keeper,
                        # ★ 一个 `enrolled` 的会话**至少心跳过一次** —— 所以第 29
                        #   节那几条"推进了没有"的断言要有一个真实的起点，而不是
                        #   NULL（从 None 上说"推进"是没法定判据的）。
                        last_hb_socket=hb,
                        candidates="55001", created_at=mod.now_ts())

    class _NftRec(object):
        """记账用的 nft：规则真的存下来、删掉真的记下来。

        ★ 用例要断言的是"**没有**发生释放" —— 而"没发生"是看不见的。
          所以把删除动作记下来，让"没有发生"变成一条可断言的**空列表**。
        """

        def __init__(self):
            self.rules = {}
            self.deleted = []

        def ensure(self):
            return True

        def session_rules(self):
            return dict(self.rules)

        def table_exists(self):
            return True

        def del_by_comment(self, c):
            self.deleted.append(c)
            self.rules.pop(c, None)

        def comment_for(self, uid, job_id, port):
            return "slurmate-sess-%d-%s-%s" % (uid, job_id, port)

        def add_session_rule(self, node_ip, port, uid, job_id):
            self.rules[self.comment_for(uid, job_id, port)] = (node_ip, port)
            return True, ""

    # ── 26.1 老客户端一字不改地继续工作（§八 第 2 步的判据）──────────────
    #
    # ★★ 这是整节的**分水岭**：它过了，`slurmate rpc` 那条路上的字节流就与
    #    没有常驻通道时逐字相同 —— "常驻通道"是叠加在它上面的，不是替换它。
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
    _idx_src = io.open(os.path.join(HERE, os.pardir, "client", "src", "main",
                                    "index.js"), encoding="utf-8").read()
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

    # ★★ `takeover` / `leave` 这两个 op 的名字：守护进程的 dispatch 表与协议文档。
    #    漂了不是"报个错"，是**那一下点了没反应** —— 用户以为接管了，而服务端
    #    收到的是 unknown_op（客户端那一半在阶段 6 落地）。
    _doc_src = io.open(os.path.join(HERE, os.pardir, "docs", "PROTOCOL.md"),
                       encoding="utf-8").read()
    check("★★ `takeover` / `leave` 在 dispatch 表里，而文档里写的也是同两个名字",
          all(('"%s"' % _op) in _msg_src and ("`%s`" % _op) in _doc_src
              for _op in ("takeover", "leave")),
          "takeover=%s leave=%s"
          % ('"takeover"' in _msg_src, '"leave"' in _msg_src))
    # ★★ 「同一个名字写在两个文件里」这一类，而且这一条**真的漏过一次**：
    #    `index.js` 有两处读 `c.suspended`（收尾时跳过它、接手前 abandon 它），
    #    而 `SessionController` 当时只有 `_suspended` 与快照里的 `suspended` ——
    #    那两处读到的都是 `undefined` ⇒ **恒为假**，而没有一个字会报错。
    #    症状是"用户点了「连接」，会话一条都接不回来"。
    check("★★ index.js 读的 `c.suspended` 真的是 SessionController 的属性"
          "（不是那个私有的 `_suspended`、也不是快照里那一个）",
          bool(re.search(r"(?m)^\s*get suspended\(\)", _ses_src))
          and bool(re.search(r"\bc\.suspended\b", _idx_src)),
          "session.js 有 getter=%s / index.js 读了=%s"
          % (bool(re.search(r"(?m)^\s*get suspended\(\)", _ses_src)),
             bool(re.search(r"\bc\.suspended\b", _idx_src))))

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
            # ── 27.8 ★★★ 端到端：真循环里，**两条都活着** ─────────────────
            #
            # 前面 27.2 是拿 Conn 手工驱动事件循环的。这一条走真 listener、
            # 真 accept、真事件循环 —— "**没有**顶替"要在这条路上也成立，
            # 才算数（这一条路走的正是它的反面）。
            _s3 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            _s3.settimeout(10.0)
            _s3.connect(_e2e_path)
            _x = _Client(_s3)
            _x.send({"op": "ping", "rid": "e2e-A",
                     "client": {"id": "e2e-A", "name": "甲机"}})
            _t0 = time.time()
            _xa = []
            while not _xa and time.time() - _t0 < 8.0:
                _xa = [m for m in _x.lines(0.3) if m.get("rid") == "e2e-A"]
            check("★ 前提：甲机在真循环里认下了身份并拿到应答",
                  len(_xa) == 1 and _xa[0].get("ok") is True, str(_xa)[:200])

            def _ask_state(what):
                _sk = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                _sk.settimeout(10.0)
                _sk.connect(_e2e_path)
                _cl = _Client(_sk)
                _cl.send(what)
                _t = time.time()
                _got = []
                while not _got and time.time() - _t < 8.0:
                    _got = [m for m in _cl.lines(0.3) if "ok" in m]
                _cl.close()
                _rows = ((_got[0].get("data") or {}).get("sessions") or []) if _got else []
                _row = next((r for r in _rows
                             if r.get("session_id") == "s-e2e"), None)
                return (_row or {}).get("state")

            _before_state = _ask_state({"op": "list"})
            check("★ 前提：那条会话问得到、而且是活的",
                  _before_state in ("reserved", "submitted", "enrolled",
                                    "suspect", "orphaned"),
                  str(_before_state))

            _s4 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            _s4.settimeout(10.0)
            _s4.connect(_e2e_path)
            _y = _Client(_s4)
            _y.send({"op": "ping", "rid": "e2e-B",
                     "client": {"id": "e2e-B", "name": "乙机"}})
            _t0 = time.time()
            _ya = []
            while not _ya and time.time() - _t0 < 8.0:
                _ya = [m for m in _y.lines(0.3) if m.get("rid") == "e2e-B"]
            check("★ 前提：乙机也拿到应答（后到的那个本身要能干活）",
                  len(_ya) == 1 and _ya[0].get("ok") is True, str(_ya)[:200])

            # ★★ 判据取"**两条都还在事件循环里，而且谁都没在关**"：顶替那条路
            #    已经不在了，而"没发生"是看不见的 —— 所以从花名册里按身份把它
            #    找出来，逐个确认它还活着、也没被标记关闭。
            _kA_e2e = next((c for c in _dd.conns() if c.client_id == "e2e-A"), None)
            _kB_e2e = next((c for c in _dd.conns() if c.client_id == "e2e-B"), None)
            check("★★★ 端到端（真循环 + 真 listener）：两个不同的 client_id ⇒"
                  " **两条都还在**，谁都没被踢"
                  "（v0.8 那条「后到者赢」在这个仓库里已经不存在了）",
                  _kA_e2e is not None and _kB_e2e is not None
                  and not _kA_e2e.closing and not _kB_e2e.closing
                  and not _x.eof,
                  "甲=%s 乙=%s 甲那条读到EOF=%s"
                  % (_kA_e2e is not None, _kB_e2e is not None, _x.eof))

            _t0 = time.time()
            _xpush, _ypush = [], []
            while time.time() - _t0 < 2.0:
                _xpush += [m for m in _x.lines(0.2) if m.get("push")]
                _ypush += [m for m in _y.lines(0.2) if m.get("push")]
            check("★★★ 而两条**都收得到推送**（不是「留着但它已经是个哑巴」）——"
                  "推送是连接还活着唯一可观察的证据",
                  len(_xpush) >= 1 and len(_ypush) >= 1,
                  "甲 %d 条 / 乙 %d 条" % (len(_xpush), len(_ypush)))

            _after_state = _ask_state({"op": "list"})
            # ★★ 会话还在不在，要**从外面问** —— 那个 store 是在守护进程线程里
            #    建的，跨线程摸它会抛（`check_same_thread`）。那条限制本身是对的，
            #    不该为了测试拆掉它。于是：前后各问一次，比对。
            #    这比读库更硬 —— 它问的就是用户能问的那条路。
            check("★★★ 端到端：这些连接的动作**一个字都没动那条会话** ——"
                  "从**另一条连接**问，它还在、状态一模一样",
                  _before_state is not None and _after_state == _before_state,
                  "前=%s 后=%s" % (_before_state, _after_state))
            _x.close(); _y.close()

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

    # ══════════════════════════════════════════════════════════════════════
    #  27. 客户端身份，与每用户连接上限（v0.9 阶段 3）
    # ══════════════════════════════════════════════════════════════════════
    #
    # ★★ 这一节不实现「同一时刻只让一台电脑管这些会话」——那要靠**按 uid 顶掉
    #    整个客户端**（`displace` / 席位表），而那种做法有三条毛病：
    #
    #      · "接管作业 1"会**连坐**"作业 2" —— 那台电脑上另一条会话被一起踢掉；
    #      · 席位按 **uid** 排，而席位一开始就该按**会话**排（`last_hb_socket`
    #        本来就是会话行上的一列）；
    #      · 顶替那条路上没有终点：被顶掉的自动重连 ⇒ 反过来顶掉对方 ⇒ 拉锯
    #        （账本 S28）。v0.8 靠"被顶掉的禁止自动重连"那道**客户端**闸兜着，
    #        而那道闸一没了，这个形状就没有终点。
    #
    # ★ 替代品不是"另一种顶替"，是**按会话的 `keeper` 一列** + 两条显式的 op
    #   （`takeover` / `leave`，见第 29 节）。所以这一节现在守两件事：
    #   ① 身份在服务端只有一个来源、只有一个用途；② 连接上限是**拒绝**，不是顶掉。

    # ── 27.0 认领的收敛（纯函数）───────────────────────────────────────
    check("★ client 认领：非 dict / 没有 id / 空的 id ⇒ 认不出来"
          "（而**不是**拒绝这条请求 —— 报不好身份不该让人连不上集群）",
          mod.parse_client_claim(None) == (None, None)
          and mod.parse_client_claim({}) == (None, None)
          and mod.parse_client_claim({"id": ""}) == (None, None)
          and mod.parse_client_claim("m1") == (None, None)
          and mod.parse_client_claim({"id": 42}) == (None, None),
          str(mod.parse_client_claim(None)))
    _dirty = mod.parse_client_claim({"id": "a\x1bb\nc&d"})[0]
    check("★ client 认领：不可打印的字符被抹掉"
          "（它要落进一行审计日志 —— 一个 \\n 会把那行劈成两半）",
          _dirty == "abc&d", repr(_dirty))
    check("★ client 认领：id 截到 %d 位 —— 否则一个 10 MB 的 id 就是一次内存放大"
          % mod.CLIENT_ID_MAX,
          len(mod.parse_client_claim({"id": "x" * 9000})[0]) == mod.CLIENT_ID_MAX,
          str(len(mod.parse_client_claim({"id": "x" * 9000})[0])))
    check("★ client 认领：name 不填就回落成 id（判等**从不看 name** ——"
          "一台机器改个名不该被当成换了一台电脑）",
          mod.parse_client_claim({"id": "m1"}) == ("m1", "m1"),
          str(mod.parse_client_claim({"id": "m1"})))
    _cleanname = mod.parse_client_claim({"id": "m1", "name": "\x07" * 400 + "箱"})[1]
    check("★ client 认领：name 同样被收敛（不可打印的抹掉），并有它自己的上限",
          _cleanname == "箱"
          and len(mod.parse_client_claim({"id": "m1", "name": "名" * 999})[1])
          == mod.CLIENT_NAME_MAX,
          repr(_cleanname))
    check("★★ 这一格**在配置白名单里**（不在的话，写进 conf 会让守护进程拒绝启动）",
          "max_connections_per_user" in mod.GLOBAL_KEYS,
          str(sorted(mod.GLOBAL_KEYS)))
    check("★★ 而旧名字**不在**白名单里 —— 一个拼错/过时的键必须被明确拒绝，"
          "而不是被静默忽略（「文件里写着，而实际什么也没发生」）",
          "max_clients_per_user" not in mod.GLOBAL_KEYS,
          str(sorted(mod.GLOBAL_KEYS)))
    check("★★ 缺省值远高于「一个客户端一条连接」，而它的作用是"
          "「一个人占不满全部连接名额」（全局上限是 CONN_MAX）",
          mod.CONN_MAX % mod.DEFAULT_MAX_CONNECTIONS_PER_USER == 0
          and mod.DEFAULT_MAX_CONNECTIONS_PER_USER >= 4,
          "每用户 %d，全局 %d"
          % (mod.DEFAULT_MAX_CONNECTIONS_PER_USER, mod.CONN_MAX))
    check("★ 它与 max_sessions_per_user 仍然是**两个旋钮**"
          "（一个管连接，一个管作业）",
          "max_sessions_per_user" in mod.GLOBAL_KEYS
          and mod.DEFAULT_MAX_CONNECTIONS_PER_USER
          != mod.DEFAULT_MAX_SESSIONS_PER_USER,
          "")
    # ★★ 0 必须被自检拦下：0 条连接 = **谁都连不上**（每一条都被拒），
    #    而报错会是一句"本站同时只服务 0 条连接" —— 那句话把根因指向"人太多"。
    _c_ok = mod.Config(write_conf("cluster_cidr = 192.0.2.0/24\n"
                                  "max_connections_per_user = 2\n",
                                  "clients-ok.conf")).validate()
    check("★ 写 2 是合法的（自检无错误）", _c_ok == [], str(_c_ok))
    _c_zero = mod.Config(write_conf("cluster_cidr = 192.0.2.0/24\n"
                                    "max_connections_per_user = 0\n",
                                    "clients-zero.conf")).validate()
    check("★★ 写 0 会被自检拦下（0 条连接 = 任何人都连不上）",
          any("max_connections_per_user" in e for e in _c_zero), str(_c_zero))
    _c_old = mod.Config(write_conf("cluster_cidr = 192.0.2.0/24\n"
                                   "max_clients_per_user = 2\n",
                                   "clients-old.conf")).validate()
    check("★★ 而旧名字会被**明确拒绝**（不是静默忽略）",
          any("max_clients_per_user" in e for e in _c_old), str(_c_old))

    # ── 27.1 身份只在常驻通道上认（rid 那道门槛）────────────────────────
    _d17 = _mkd()
    _cR, _kR = _pair(_d17)
    _cR.send({"op": "ping", "rid": 1, "client": {"id": "mA", "name": "甲机"}})
    _drive(_d17)
    check("★ 前提：常驻通道（带 rid）认下了身份",
          _kR.client_id == "mA" and _kR.client_name == "甲机",
          "%s/%s" % (_kR.client_id, _kR.client_name))
    check("★ 而认身份不影响这条请求本身：它照样拿到应答",
          len(_cR.lines()) == 1, "")
    # ★★★ 这一条是本节最要紧的**结构性质**：exec 退路带的 client 必须被无视。
    _cE, _kE = _pair(_d17)
    _cE.send({"op": "ping", "client": {"id": "mA", "name": "甲机"}})
    _drive(_d17)
    check("★★★ exec 退路（**不带 rid**）即使带着同一个 client，也**不认领身份**"
          " —— 少了这道门槛，客户端每降级一次 exec 就多一条「临时身份」，"
          "而看护者那一格会跟着一条**下一秒就没了**的连接走（它刚认领的会话"
          "立刻变成「没人看」，倒计时开始跑）",
          _kE.client_id is None and not _kR.closing,
          "kE.client_id=%s kR.closing=%s" % (_kE.client_id, _kR.closing))
    check("★ 一条连接只认一次身份（连接的身份是连接的属性，不许中途改）",
          (_d17.handle_line(_kR, json.dumps(
              {"op": "ping", "rid": 2, "client": {"id": "mZ"}}).encode()),
           _kR.client_id)[1] == "mA",
          _kR.client_id)
    _cE.close(); _cR.close()

    # ── 27.2 ★★★ 「两台电脑互相顶」这个形状**在代码里不存在** ──────────
    #
    # ★★ 这一条守的是一句**否命题**：同一个 uid、两个不同的 client_id 同时订阅
    #    ⇒ **两条都在**。它不是"某条分支写对了"，而是"那条分支已经没有了"。
    #
    # ★ 判据取"两条都在**且各自都收得到推送**"：推送是连接还活着唯一可观察的
    #   证据。"谁都没被踢"本身是看不见的。
    #
    # ★ 它同时是 S28（拉锯）那一整条账**在协议这一侧的落点**：没有顶替，
    #   就没有"被顶掉的要不要自动重连"这个问题，也就没有互相顶下去的终点问题。
    _d24 = _mkd()
    _cA, _kA = _pair(_d24)
    _cA.send({"op": "ping", "rid": 1, "client": {"id": "mA", "name": "甲机"}})
    _drive(_d24)
    _cB, _kB = _pair(_d24)
    _cB.send({"op": "ping", "rid": 1, "client": {"id": "mB", "name": "乙机"}})
    _drive(_d24)
    check("★ 前提：两条连接各自都认了身份（否则下面那条是空断言）",
          _kA.client_id == "mA" and _kB.client_id == "mB",
          "%s / %s" % (_kA.client_id, _kB.client_id))
    check("★★★ 两个不同的 client_id 同时订阅 ⇒ **两条都在**"
          "（后到者赢那条路已经不存在了 —— 没有顶替，就没有拉锯）",
          not _kA.closing and not _kB.closing
          and _kA in _d24.conns() and _kB in _d24.conns(),
          "甲 closing=%s 在=%s；乙 closing=%s 在=%s"
          % (_kA.closing, _kA in _d24.conns(),
             _kB.closing, _kB in _d24.conns()))
    _add(_d24, "s-two", job_id="901", uid=UID)
    _d24.tick()
    _drive(_d24)
    _pushA = [m for m in _cA.lines() if m.get("push")]
    _pushB = [m for m in _cB.lines() if m.get("push")]
    check("★★ 而两条**各自都收得到推送**（不是「留着但它已经是个哑巴」）",
          len(_pushA) >= 1 and len(_pushB) >= 1,
          "甲 %d 条 / 乙 %d 条" % (len(_pushA), len(_pushB)))
    check("★ 两条收到的快照里都有那条会话（推的是同一份视图，不是各推各的）",
          all(any(s.get("session_id") == "s-two" for s in (m.get("sessions") or []))
              for m in (_pushA[:1] + _pushB[:1]))
          and len(_pushA) >= 1 and len(_pushB) >= 1,
          "%s / %s" % (str(_pushA[:1])[:140], str(_pushB[:1])[:140]))
    _cA.close(); _cB.close()

    # ── 27.3 ★★ 每用户连接上限：**拒绝新来的**，不动已经在的那些 ──────────
    #
    # ★★ 判据有两半，而**第二半才是承重的**：
    #    ① 超限那条要**读到**为什么（accept-then-reject，理由同 §26.11）；
    #    ② **已经在的那些一条都不许被断**。
    #    只做前半的话，"拒绝"会悄悄退化成"顶掉"—— 而那条路上没有终点（S28）。
    #
    # ★ 两条现成的连接用 `_pair` 直接挂进 selector（它们是"已经在的那些"），
    #   超限那条走**真的 accept 路径** —— 每用户上限判在 accept 那一刻，
    #   因为 uid 在那里就是已知的（SO_PEERCRED）。
    _d25 = _mkd(max_connections_per_user=2)
    _e1, _ke1 = _pair(_d25)
    _e2, _ke2 = _pair(_d25)
    check("★ 前提：这个 uid 已经有 2 条连接，正好到顶",
          _d25.uid_conn_count(UID) == 2, str(_d25.uid_conn_count(UID)))
    _lsn2_path = os.path.join(tmpdir, "peruser.sock")
    if os.path.exists(_lsn2_path):
        os.unlink(_lsn2_path)
    _lsn2 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    _lsn2.bind(_lsn2_path)
    _lsn2.listen(8)
    _lsn2.setblocking(False)
    _d25.selector.register(_lsn2, selectors.EVENT_READ)
    _d25.listener = _lsn2
    _extra2 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    _extra2.connect(_lsn2_path)
    _d25.accept_ready()
    _extra2.settimeout(1.0)
    _buf2 = b""
    try:
        while b"\n" not in _buf2:
            _chunk2 = _extra2.recv(65536)
            if not _chunk2:
                break
            _buf2 += _chunk2
    except (socket.timeout, OSError):
        pass
    _rej2 = json.loads(_buf2.split(b"\n")[0]) if b"\n" in _buf2 else {}
    check("★★ 超限的那条**读到** too_many_connections（而不是被静默丢弃、"
          "等一个方向反了的 daemon_unreachable）",
          (_rej2.get("error") or {}).get("kind") == "too_many_connections",
          str(_rej2)[:220])
    check("★★ 而它**说得出是谁满了** —— 每用户那道上限与全局那道"
          "（「本站满了」）不是同一句话，否则根因在别人身上时用户看不出来",
          "账号" in str((_rej2.get("error") or {}).get("detail") or ""),
          str((_rej2.get("error") or {}).get("detail"))[:160])
    check("★★★ 而**已经在的那两条一条都没被断**（「拒绝」不是「顶掉」）",
          not _ke1.closing and not _ke2.closing
          and _ke1 in _d25.conns() and _ke2 in _d25.conns(),
          "甲 closing=%s 在=%s；乙 closing=%s 在=%s"
          % (_ke1.closing, _ke1 in _d25.conns(),
             _ke2.closing, _ke2 in _d25.conns()))
    check("★ 超限那条**不在**事件循环里（它没有占着一个名额）",
          len(_d25.conns()) == 2, "循环里有 %d 条" % len(_d25.conns()))
    # ★ 上限是**按 uid** 算的：判据就是那一句 `c.uid == uid`，所以另一个用户
    #   数不到这些连接。断言写在这里是因为"数错了人"的症状同样安静 ——
    #   它会让别人的连接被当成我的，于是**我**被拒。
    _e3, _ke3 = _pair(_d25, uid=UID + 1)
    check("★★ 而另一个 uid 的连接**根本不进这个计数**（上限是按 uid 分的）",
          _d25.uid_conn_count(UID + 1) == 1
          and _d25.uid_conn_count(UID) == 2,
          "我 %d / 他 %d" % (_d25.uid_conn_count(UID),
                             _d25.uid_conn_count(UID + 1)))
    _d25.selector.unregister(_lsn2)
    _lsn2.close()
    _extra2.close()
    _e1.close(); _e2.close(); _e3.close()

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

    # ══════════════════════════════════════════════════════════════════════
    #  28. 集群信息：一次查询服务所有连接（v0.8 阶段 5）
    # ══════════════════════════════════════════════════════════════════════
    #
    # ★★ 这一节守的是一句**结构性质**，不是"某条命令发了没有"：
    #
    #       刷新的代价与**连接数、用户数无关** —— 每层每周期一次。
    #
    #    若每个 `partitions` / `submit` / `whoami` 请求各自 fork 一次 `scontrol`
    #    （分区表那条连缓存都没有），代价就随连接数放大。所以这里的判据一律是
    #    **计数**：
    #    "20 组读，零 fork"是一条可以逐次数出来的事实，而不是一句设计意图。

    class _CountSlurm(object):
        """只数 fork 的假 Slurm：每个查询记一笔，返回一个可辨认的答案。

        ★ 用它而不是量 `run_cmd`：要钉的是"`Cluster` 不重复问"，而那与查询
          具体怎么实现无关。
        ★ `__getattr__` **只认 `Cluster` 点过名的那些方法**，别的一律
          `AttributeError` —— 一个万能的 catch-all 会把"名字写错了"也一起吞掉，
          而名字写错的形态正是"那一格永远取不到"（见 28.0 那条）。
        """

        NAMES = (tuple(m for _k, _p, m in mod.Cluster.SHARED)
                 + tuple(m for _k, m in mod.Cluster.PER_USER))

        def __init__(self):
            self.n = {}
            self.answer = {
                "controller_health": {"up": True, "at": 0},
                "slurm_version": "slurm-wlm 9.9.9",
                "partition_table": {"P1": {"max_time": 3600, "is_default": True,
                                           "state": "UP", "nodes": 1, "cpus": 4}},
                "gres_catalog": {"P1": [{"name": "gpu", "type": None,
                                         "per_node_max": 1, "total": 1}]},
                "node_table": {"P1": {"counts": {"idle": 1}, "flags": {}}},
                "queue_table": {"depth": {"P1": {"pending": 0, "running": 0}},
                                "pending": {}, "by_user": {}, "at": 0},
                "account_for": ("acct", None),
                "allowed_partitions": None,
                "fairshare": {"account": "acct", "fair_share": "1.0",
                              "raw_usage": "0", "effectv_usage": "0"},
            }

        def __getattr__(self, name):
            if name not in _CountSlurm.NAMES:
                raise AttributeError(name)

            def _q(*_a, **_k):
                self.n[name] = self.n.get(name, 0) + 1
                return self.answer.get(name)
            return _q

    # ── 28.0 名字与常量 ─────────────────────────────────────────────────
    _cs_names = [m for _k, _p, m in mod.Cluster.SHARED]
    _cu_names = [m for _k, m in mod.Cluster.PER_USER]
    check("★★ `Cluster` 里点名的每一个查询都**真的在 `Slurm` 上**"
          "（名字写错的形态是那一格**永远取不到** —— 一个字都不报）",
          all(hasattr(mod.Slurm, m) for m in _cs_names + _cu_names),
          str([m for m in _cs_names + _cu_names if not hasattr(mod.Slurm, m)]))
    check("★ 共享的那几类与「按用户」的那几类没有重名"
          "（重了的话 tick 的预热会覆盖掉请求侧读的那一格）",
          not (set(_cs_names) & set(_cu_names)), str(sorted(set(_cs_names) & set(_cu_names))))
    check("★ 三层钟的顺序：快 < 中 < 慢（反过来的话，最贵的那些会被最急的拖着跑）",
          mod.INFO_FAST_SECONDS < mod.INFO_MEDIUM_SECONDS < mod.INFO_SLOW_SECONDS,
          "%s / %s / %s" % (mod.INFO_FAST_SECONDS, mod.INFO_MEDIUM_SECONDS,
                            mod.INFO_SLOW_SECONDS))
    check("★ 最快的那一层就是 tick 的周期（控制器健康跟着每一轮对账走，不额外加钟）",
          mod.INFO_FAST_SECONDS == mod.TICK_SECONDS,
          "%s vs %s" % (mod.INFO_FAST_SECONDS, mod.TICK_SECONDS))
    check("★★ 失败之后按 INFO_RETRY_SECONDS 重试，**不是**等满自己那一层"
          "（慢钟上的东西失败一次就 5 分钟不再看，而「分区表读不到」是要立刻"
          "自愈的瞬时故障：slurmctld 重启、munge 抖动）",
          mod.INFO_RETRY_SECONDS < mod.INFO_MEDIUM_SECONDS,
          "%s vs %s" % (mod.INFO_RETRY_SECONDS, mod.INFO_MEDIUM_SECONDS))
    # ★★ 「从右往左剥后缀」能成立的前提：后缀字符集与紧凑状态名**不相交**。
    #    相交的话 `idle` 会被剥成 `idl`，而没有任何地方会报错。
    _COMPACT_STATES = ("alloc", "comp", "completing", "down", "drain", "drng",
                       "fail", "future", "idle", "inval", "maint", "mix",
                       "perfctrs", "plnd", "pow_dn", "pow_up", "reboot_issued",
                       "reboot_req", "resv", "unk")
    check("★★ 节点后缀字符集与紧凑状态名**不相交**（剥法成立的前提）",
          not any(st[-1] in mod.NODE_FLAG_CHARS for st in _COMPACT_STATES),
          str([st for st in _COMPACT_STATES if st[-1] in mod.NODE_FLAG_CHARS]))

    # ── 28.1 ★★★ 零 fork：刷新之后，读不再问 ──────────────────────────
    _cs = _CountSlurm()
    _cl = mod.Cluster(cfg, _cs)
    # ★★ `_T0` 必须是**真实时钟**：`refresh()` 收得下任意 `now`（用例要能快进），
    #    但请求侧那几条读走的是 `time.time()` —— 两者对不上时"零 fork"那条会红，
    #    而红的原因与缓存毫无关系（读认为已经过期了）。生产里两边是同一个钟。
    _T0 = time.time()
    _cl.refresh(_T0, users=())
    _after = dict(_cs.n)
    check("★ 前提：刷新本身确实查了（否则下面那条是空断言）",
          set(_after) == set(_cs_names), str(sorted(_after)))
    for _ in range(20):
        _cl.health(); _cl.slurm_version(); _cl.partitions()
        _cl.gres(); _cl.nodes(); _cl.queue()
    check("★★★ 刷新之后，**20 组读一次 fork 都不发**"
          "（这就是「一次查询服务所有连接」）",
          _cs.n == _after, "多出来的：%s" % {k: v - _after.get(k, 0)
                                            for k, v in _cs.n.items()
                                            if v != _after.get(k, 0)})

    _cl.refresh(_T0, users=["alice"])
    _n_user = {k: v for k, v in _cs.n.items() if k in _cu_names}
    for _ in range(20):
        _cl.account_for("alice"); _cl.allowed_partitions("alice")
        _cl.fairshare("alice")
    check("★★ 同一个用户的 20 组读同样零 fork（M 条连接读的是同一份）",
          {k: v for k, v in _cs.n.items() if k in _cu_names} == _n_user,
          str({k: v for k, v in _cs.n.items() if k in _cu_names}))

    # ── 28.2 分开的钟 ───────────────────────────────────────────────────
    _cs2 = _CountSlurm()
    _cl2 = mod.Cluster(cfg, _cs2)
    _cl2.refresh(_T0, users=())
    check("★ 前提：health 与分区表各刷了一次",
          _cs2.n.get("controller_health") == 1
          and _cs2.n.get("partition_table") == 1, str(_cs2.n))
    _cl2.refresh(_T0 + mod.INFO_FAST_SECONDS - 0.1, users=())
    check("★ 不到一个快钟周期，health **不重查**",
          _cs2.n.get("controller_health") == 1, str(_cs2.n))
    _cl2.refresh(_T0 + mod.INFO_FAST_SECONDS, users=())
    check("★ 到了一个快钟周期，health 重查一次",
          _cs2.n.get("controller_health") == 2, str(_cs2.n))
    check("★★ 而分区表**一次都没跟着重查** —— 分开的钟，不是一个 tick 干所有事"
          "（一个 tick 干所有事等于每种数据都被最急的那种拖着跑）",
          _cs2.n.get("partition_table") == 1, str(_cs2.n))
    _cl2.refresh(_T0 + mod.INFO_MEDIUM_SECONDS, users=())
    check("★ 到了中钟，节点忙闲与队列刷第二次，而分区表仍然只刷过一次",
          _cs2.n.get("node_table") == 2 and _cs2.n.get("queue_table") == 2
          and _cs2.n.get("partition_table") == 1, str(_cs2.n))

    # ★★ 钟的推进必须写在查询**之前**，而且写成"此刻 + 周期"。
    #    写成 `self._due[k] += 周期` 的话，一次"跑得比周期还久"的查询会让新的
    #    截止时刻仍然落在**过去** ⇒ 每一轮都重跑 ⇒ 一个慢集群把守护进程变成
    #    不停 fork 的循环。这一条把那个写法钉死。
    _cs3 = _CountSlurm()
    _cl3 = mod.Cluster(cfg, _cs3)
    _cl3.refresh(_T0, users=())
    _cl3.refresh(_T0 + mod.INFO_FAST_SECONDS, users=())          # 到期
    _n_at = _cs3.n.get("controller_health")
    _cl3.refresh(_T0 + mod.INFO_FAST_SECONDS + 0.5, users=())    # 刚查完
    check("★★ 钟的推进写在查询**之前**：刚查完的那 0.5 秒内不会又查一次"
          "（写成 `+=` 的话截止时刻会落在过去，于是每一轮都重跑）",
          _cs3.n.get("controller_health") == _n_at,
          "%s → %s" % (_n_at, _cs3.n.get("controller_health")))

    # ── 28.3 失败：按最急的那层重试，而且那几秒里仍然读得到"取不到" ────
    _cs4 = _CountSlurm()
    _cs4.answer["partition_table"] = None
    _cl4 = mod.Cluster(cfg, _cs4)
    _cl4.refresh(_T0, users=())
    _cl4.refresh(_T0 + mod.INFO_RETRY_SECONDS, users=())
    check("★★ 失败之后按 INFO_RETRY_SECONDS 重试（不是等满慢钟的 5 分钟）",
          _cs4.n.get("partition_table") == 2, str(_cs4.n))
    check("★ 而这两次之间读到的仍然是 None ——「取不到」是一个**答案**，"
          "它必须留在缓存里让调用方看得见（`{}` 才是「确实没有」）",
          _cl4.partitions() is None, str(_cl4.partitions()))
    check("★ 失败只影响它自己那一类，别的不受影响",
          _cs4.n.get("node_table") == 1, str(_cs4.n))

    # ── 28.4 节点忙闲：只按 base state 计数，后缀只做展示 ──────────────
    _nt = with_stub(mod, slurm_stub, lambda: mod.Slurm(cfg).node_table())
    check("★★ `-h` 不能省：`sinfo` 与 `scontrol show … -o` 不一样，它会打一行表头"
          "（`PARTITION|NODELIST|STATE`），而少了 `-h` 的话那一行会变成一个名叫 "
          "`PARTITION`、状态叫 `STATE` 的**假分区**，原样画进界面。"
          "★ 真集群实测抓到的 —— 手写的桩本来没有表头，所以它一直是绿的",
          _nt is not None and set(_nt) == {"A6000", "RTX8000", "2080TI"},
          str(sorted(_nt or ())))
    check("★ 带后缀的状态被剥成 base state（`idle*` → `idle`，`down~` → `down`）",
          _nt and _nt["2080TI"]["counts"] == {"idle": 1, "down": 1},
          str(_nt and _nt.get("2080TI")))
    check("★★ 而后缀**原样留着**、单独一列（只做展示，一个都不参与判定 ——"
          "它们跨 Slurm 版本含义不一致，拿它们判定等于把「我记得的那个版本」当协议）",
          _nt and _nt["2080TI"]["flags"] == {"*": 1, "~": 1},
          str(_nt and _nt.get("2080TI")))
    check("★ 默认分区的记号（`2080TI*`）被剥掉",
          _nt and "2080TI*" not in _nt and "2080TI" in _nt,
          str(sorted(_nt or ())))
    check("★ 没有后缀的分区，flags 是空的（不是缺失）",
          _nt and _nt["A6000"]["flags"] == {} and _nt["A6000"]["counts"] == {"mix": 1, "idle": 1},
          str(_nt and _nt.get("A6000")))

    # ── 28.5 队列：深度、顺序、以及"我在第几位" ────────────────────────
    _q = with_stub(mod, slurm_stub, lambda: mod.Slurm(cfg).queue_table())
    check("★ 数组作业算**一条**（`7006_[3-9,13-19%2]` 是 1，不是 9）——"
          "数成 9 会让「队列深度」在用了数组的集群上直接虚高一个量级",
          _q and _q["depth"]["2080TI"]["pending"] == 1,
          str(_q and _q["depth"].get("2080TI")))
    check("★★★ 「其余那一档」（`CG` 收尾中）**不并进 running** ——"
          "并了之后「这个分区忙不忙」就开始说谎，而那是这一格唯一的用途",
          _q and _q["depth"]["RTX8000"] == {"pending": 0, "running": 1, "other": 1},
          str(_q and _q["depth"].get("RTX8000")))
    check("★ 排队顺序留着（`pending` 就是 squeue 给的顺序）",
          _q and _q["pending"]["A6000"] == ["7001", "7002", "7003"],
          str(_q and _q["pending"].get("A6000")))
    check("★ 按用户也分了一份（「我排第几」靠它算，**不额外 fork**）",
          _q and _q["by_user"]["alice"] == ["7001", "7003", "7004",
                                            "7006_[3-9,13-19%2]"],
          str(_q and _q["by_user"].get("alice")))

    _cs5 = _CountSlurm()
    _cs5.answer["queue_table"] = with_stub(
        mod, slurm_stub, lambda: mod.Slurm(cfg).queue_table())
    _cl5 = mod.Cluster(cfg, _cs5)
    _cl5.refresh(_T0, users=["alice"])
    _n_q = _cs5.n.get("queue_table")
    _pos = _cl5.for_user("alice")
    check("★★ 「我排第几位」是从**共享的队列快照现推**的，不额外 fork",
          _cs5.n.get("queue_table") == _n_q, str(_cs5.n))
    check("★ alice 在自己排队的**每个分区**里都是第 1 位"
          "（A6000 里最靠前的是 7001；2080TI 里只有那条数组作业）",
          _pos.get("first_in") == {"A6000": 1, "2080TI": 1}
          and _pos.get("pending_count") == 3,
          str({k: _pos.get(k) for k in ("first_in", "pending_count")}))
    _pos2 = _cl5.for_user("carol")
    check("★ 没有排队作业的人**不报**排队名次（而不是报 0）",
          "first_in" not in _pos2 and "pending_count" not in _pos2, str(_pos2))

    # ── 28.6 fairshare：`-u` 而不是 `-U`（一个看起来正常的错答案）──────
    _seen = []

    def _cap(argv, timeout=10, check=False):
        _seen.append([str(a) for a in argv])
        return slurm_stub(argv, timeout, check)

    _fs = with_stub(mod, _cap, lambda: mod.Slurm(cfg).fairshare("alice"))
    _fsa = _seen[-1] if _seen else []
    check("★★★ fairshare 必须传 `-u <用户>`，**绝不能**是 `-U`"
          "（守护进程以 root 跑，而 `-U` 是「当前用户」= root —— 那会把 **root 自己的**"
          "公平份额显示成用户的，一个看起来完全正常的错误答案）",
          "-u" in _fsa and "alice" in _fsa and "-U" not in _fsa, str(_fsa))
    check("★ 认得出用户那一行（账户行是**缩进**的，而 User 列必须逐字等于目标用户）",
          _fs == {"account": "chbstudents", "fair_share": "0.125000",
                  "raw_usage": "3072302", "effectv_usage": "0.108641"},
          str(_fs))
    _fs2 = with_stub(mod, slurm_stub, lambda: mod.Slurm(cfg).fairshare("carol"))
    check("★★ 看不到用户那一行时返回 **None**，而不是拿账户级的汇总行当「你的份额」"
          "（那正是上面那个错的另一个形状）",
          _fs2 is None, str(_fs2))
    _fs3 = with_stub(mod, lambda *a, **k: (1, "", "slurmdbd is down"),
                     lambda: mod.Slurm(cfg).fairshare("alice"))
    check("★ 查询失败也是 None（「取不到」与「没有」在这一格上是两件事，"
          "但都不是一个数字）", _fs3 is None, str(_fs3))

    # ── 28.7 history：按需拉、只要作业级、倒序 ─────────────────────────
    _seen2 = []

    def _cap2(argv, timeout=10, check=False):
        _seen2.append([str(a) for a in argv])
        return slurm_stub(argv, timeout, check)

    _hist = with_stub(mod, _cap2, lambda: mod.Slurm(cfg).history("alice"))
    _ha = _seen2[-1] if _seen2 else []
    check("★★ 作业步（`8101.extern` / `8101.0`）被滤掉 —— 混进来会让"
          "「最近 30 条」变成「最近 10 个作业的每一步」",
          [r["job_id"] for r in (_hist or [])] == ["8101", "8100"],
          str([r["job_id"] for r in (_hist or [])]))
    check("★ 倒序：最新的在最前（sacct 默认按作业号升序，而人要看的是最后那件事）",
          _hist and _hist[0]["job_id"] == "8101", str(_hist and _hist[0]))
    check("★★ 时间窗**下推给 Slurm**（`-S now-Ndays`），不是把全部拉回来自己截。"
          "★ 而且写法必须是 `days` —— `now-7d` 是非法的，`sacct` 直接回"
          "「Invalid time specification」（真集群实测）。"
          "写错的形态是「历史**永远**取不到」，而它长得像集群没有账本",
          any(str(a).startswith("now-") and str(a).endswith(("day", "days"))
              for a in _ha), str(_ha))
    check("★ 条数上限在代码里，且有上界（它是这一组里最贵的一条查询）",
          0 < mod.HISTORY_MAX_ROWS <= 100 and mod.HISTORY_DAYS >= 1,
          "%s / %s" % (mod.HISTORY_DAYS, mod.HISTORY_MAX_ROWS))

    # ── 28.8 三态：取不到 vs 确实没有 ──────────────────────────────────
    def _dead(argv, timeout=10, check=False):
        return 1, "", "slurmdbd is down"

    check("★★ 「取不到」是 None，而「确实没有」是 `{}` / `[]` —— 两者不能混"
          "（把问不到画成「没有」，用户会去查一个不存在的问题）",
          with_stub(mod, _dead, lambda: mod.Slurm(cfg).node_table()) is None
          and with_stub(mod, _dead, lambda: mod.Slurm(cfg).queue_table()) is None
          and with_stub(mod, _dead, lambda: mod.Slurm(cfg).slurm_version()) is None
          and with_stub(mod, _dead, lambda: mod.Slurm(cfg).history("alice")) is None
          and with_stub(mod, lambda *a, **k: (0, "", ""),
                        lambda: mod.Slurm(cfg).partition_table()) == {},
          "控制器可达但一个分区都没有 ⇒ `{}`，不是 None")
    check("★ 输出超过上限 ⇒ 按**取不到**处理（不是解析半个，也不是抛）",
          with_stub(mod, lambda *a, **k: (0, "x" * (mod.CLUSTER_QUERY_MAX_BYTES + 1),
                                          ""),
                    lambda: mod.Slurm(cfg).queue_table()) is None
          and with_stub(mod, lambda *a, **k: (0, "x" * (mod.CLUSTER_QUERY_MAX_BYTES + 1),
                                              ""),
                        lambda: mod.Slurm(cfg).node_table()) is None,
          "上限 %d" % mod.CLUSTER_QUERY_MAX_BYTES)
    check("★ 而这个上限**管的是解析与保留**，不是读取 —— 注释里说清楚了"
          "（写成「上限」而不说清管哪一段，下一个人会以为读也被截住了）",
          "解析与保留" in io.open(
              os.path.join(HERE, "slurmate-sessiond"), encoding="utf-8").read(),
          "")

    # ── 28.9 op_cluster / op_history 的接线 ────────────────────────────
    _d28 = _mkd()
    _d28.slurm = mod.Slurm(cfg)
    _calls28 = [0]

    def _run28(argv, timeout=10, check=False):
        _calls28[0] += 1
        return slurm_stub(argv, timeout, check)

    _cv1 = with_stub(mod, _run28, lambda: _d28.op_cluster(UID))
    _first28 = _calls28[0]
    _cv2 = with_stub(mod, _run28, lambda: _d28.op_cluster(UID))
    check("★★★ 第二次 op_cluster **零 fork** —— 这就是「一次查询服务所有连接」"
          "（第一次是冷启动，每个 uid 每个慢钟周期至多一次）",
          _cv1.get("ok") and _cv2.get("ok") and _calls28[0] == _first28,
          "第一次 %d 次，第二次又 %d 次" % (_first28, _calls28[0] - _first28))
    _cd = _cv1.get("data") or {}
    check("★ 共享的那几格都在（缺哪个都是客户端画不出来的一格）",
          set(_cd) >= {"at", "health", "version", "partitions", "gres",
                       "nodes", "queue", "taken", "me"},
          str(sorted(_cd)))
    check("★ 而「自己那一份」在 `me` 里 —— 共享的与按 uid 的**分开**"
          "（分开的不只是缓存：客户端据此知道「这一格变了不是我的事」）",
          set(_cd.get("me") or {}) >= {"account", "allowed_partitions",
                                       "fairshare"},
          str(sorted(_cd.get("me") or {})))
    check("★ `partitions` 取不到时 op_cluster **不报错**（对比 op_partitions）——"
          "只看现状的那一屏不该因为一格取不到而整屏打不开",
          with_stub(mod, lambda *a, **k: (1, "", "down"),
                    lambda: mod.Cluster(cfg, mod.Slurm(cfg)).shared())
          .get("partitions") is None,
          "")

    _seen3 = []

    def _cap3(argv, timeout=10, check=False):
        _seen3.append([str(a) for a in argv])
        return slurm_stub(argv, timeout, check)

    _hv = with_stub(mod, _cap3, lambda: _d28.op_history(UID))
    _me_name = mod.pwd.getpwuid(UID).pw_name
    _hargv = _seen3[-1] if _seen3 else []
    check("★★ 历史的用户**从 uid 推出来**，不接受请求里给的用户名"
          "（否则这个 op 就是读别人账本的入口）",
          _me_name in _hargv and "bob" not in _hargv, str(_hargv))
    check("★ 它**不进任何一层钟**：两次调用就是两次查询（按需拉）",
          (lambda: (_seen3.clear(),
                    with_stub(mod, _cap3, lambda: _d28.op_history(UID)),
                    with_stub(mod, _cap3, lambda: _d28.op_history(UID)),
                    len(_seen3))[-1])() == 2,
          "查了 %d 次" % len(_seen3))
    check("★ 取不到时报**错误**而不是空列表（空列表的意思是「你这几天没有作业」）",
          not with_stub(mod, _dead, lambda: _d28.op_history(UID)).get("ok"),
          str(with_stub(mod, _dead, lambda: _d28.op_history(UID))))

    # ── 28.9b `op_job_log`：作业日志的尾部，两条流各一份 ─────────────────
    #
    # ★★ 这个 op 是**唯一一条通往用户家目录里某个文件内容**的路径，所以它的
    #    判据分两半：**路径不许由客户端决定**，以及**给不给要看归属**。
    #    两半漏掉任何一半，"看自己的日志"就变成了"读别人家目录里的东西"。
    _dj = _mkd()
    _djhome = _dj.user_home(UID)
    _djlog = os.path.join(_djhome, ".slurmate", "logs")
    os.makedirs(_djlog, exist_ok=True)
    _dj.store = mod.Store(os.path.join(tmpdir, "joblog.db"))
    _dj.store.insert(session_id="s-jl", uid=UID, user="alice", job_id=4242,
                     state=mod.ST_ENROLLED, created_at=mod.now_ts(),
                     service_kind=SSHD, candidates="55003", account="acct",
                     cpus=1, mem="1G", requested_time="1:00:00")
    _dj.store.insert(session_id="s-other", uid=UID + 1, user="bob", job_id=4243,
                     state=mod.ST_ENROLLED, created_at=mod.now_ts(),
                     service_kind=SSHD, candidates="55003", account="acct",
                     cpus=1, mem="1G", requested_time="1:00:00")

    def _jlog(**over):
        req = {"op": "job_log", "session_id": "s-jl"}
        req.update(over)
        return _dj.op_job_log(UID, req)

    # ① 归属：不是你的 / 不存在 / 没给 —— **同一个答案**
    _n1 = _jlog(session_id="s-other")
    _n2 = _jlog(session_id="s-nope")
    _n3 = _dj.op_job_log(UID, {"op": "job_log"})
    # ★ 取键一律用 `.get()`：变异把 `code` 改名时，`d["code"]` 会抛 KeyError，
    #   整个脚本当场崩掉、后面几十条一条都不跑 —— 而"崩掉"与"守住"在
    #   "有没有红"这个判据上完全一样。
    check("★★ 别人的会话与不存在的会话回**同一个** `3 not_found`"
          "（分开的话，这个 op 就成了一个「探别人作业是否存在」的神谕）",
          not _n1.get("ok") and _n1.get("code") == 3
          and (_n1.get("error") or {}).get("kind") == (_n2.get("error") or {}).get("kind")
          and _n2.get("code") == 3,
          "%r / %r" % (_n1, _n2))
    check("★ 不给 session_id 也是同一个答案（没有「默认最新那条」这种缺省 ——"
          "日志是逐会话的东西，猜一个等于给另一个会话的日志）",
          not _n3.get("ok") and _n3.get("code") == 3, str(_n3))
    # ★ 路径根本不来自请求：把 `..` 塞进 session_id 也只会得到 not_found
    #   （它先去 store 里找那条会话），而不是去读一个文件。
    check("★★ 路径**一个字节都不来自客户端**（塞 `../` 进去只会得到 not_found）",
          not _jlog(session_id="../../etc/passwd").get("ok"),
          str(_jlog(session_id="../../etc/passwd")))

    # ② 「确实没有」：文件不在 ⇒ `null`，**不是错误**
    _e = _jlog()
    check("★★ 作业还没写出日志 ⇒ 每一格是 `null`，而**不是错误**"
          "（把「还没有」画成一屏报错，用户会以为出了事）",
          _e.get("ok") and (_e.get("data") or {}).get("out") is None
          and (_e.get("data") or {}).get("err") is None,
          str(_e)[:300])

    # ③ 读到了：两份分开、内容就是文件内容
    with io.open(os.path.join(_djlog, "slurm-4242.out"), "w", encoding="utf-8") as f:
        f.write("宿主的一行\n服务写到 stdout 的一行\n")
    with io.open(os.path.join(_djlog, "slurm-4242.err"), "w", encoding="utf-8") as f:
        f.write("认证被拒\n")
    _r = _jlog()
    _ro = (_r.get("data") or {}).get("out") or {}
    _re = (_r.get("data") or {}).get("err") or {}
    check("★★ 两份日志分别来自 `.out` 与 `.err`（合成一份读的话，"
          "「这个服务往 stderr 上抱怨了什么」就没法单独看）",
          "服务写到 stdout 的一行" in (_ro.get("text") or "")
          and "认证被拒" in (_re.get("text") or "")
          and "认证被拒" not in (_ro.get("text") or ""),
          "%r / %r" % (_ro.get("text"), _re.get("text")))
    check("★ 每一格带着**路径**（界面要能把它显示出来让人复制）与**字节数**",
          str(_ro.get("path", "")).endswith("slurm-4242.out") and _ro.get("bytes") == len(
              "宿主的一行\n服务写到 stdout 的一行\n".encode("utf-8")),
          "%r bytes=%r" % (_ro.get("path"), _ro.get("bytes")))
    check("★ 而那个路径在**服务端自己算出来的**日志目录里（不是客户端给的）",
          _ro.get("path") == os.path.join(_djlog, "slurm-4242.out"), _ro.get("path"))

    # ④ 空文件不是「没有文件」—— 三态里的第三格
    with io.open(os.path.join(_djlog, "slurm-4242.err"), "w", encoding="utf-8") as f:
        f.write("")
    _re2 = (_jlog().get("data") or {}).get("err")
    check("★★ 空文件**不是** `null`：`null` 是「确实没有这一份」，空文件是"
          "「它确实还没有说任何话」—— 两句话",
          _re2 is not None and _re2.get("text") == "" and _re2.get("bytes") == 0
          and _re2.get("lines") == 0,
          str(_re2))

    # ⑤ 只读尾部：大文件不许整个读进来
    _big = os.path.join(_djlog, "slurm-4242.out")
    with io.open(_big, "w", encoding="utf-8") as f:
        f.write("".join("第 %d 行\n" % i for i in range(20000)))
    _rb = ((_jlog(lines=5).get("data") or {}).get("out")) or {}
    check("★★ 给的是**尾部**，而且 `truncated` 说了「这不是整份」"
          "（日志不轮转，一个跑了一整天的会话可以几十 MB —— 从不读整份是硬要求）",
          str(_rb.get("text", "")).endswith("第 19999 行")
          and "第 0 行" not in str(_rb.get("text", ""))
          and _rb.get("truncated") is True and _rb.get("lines") == 5,
          "lines=%r truncated=%r 尾=%r" % (_rb.get("lines"), _rb.get("truncated"),
                                           str(_rb.get("text", ""))[-40:]))
    with io.open(_big, "w", encoding="utf-8") as f:
        f.write("a\nb\n")            # 两行，远不到上限
    check("★★ 而**没被截过的小文件**要说 `truncated` 为假"
          "（恒为真的话，那一格什么都不说明）",
          ((_jlog().get("data") or {}).get("out") or {}).get("truncated") is False,
          str(_jlog()))

    # ⑥ `lines` 被钳住
    check("★★ `lines` 钳到 `[1, 2000]`（上界不设的话，一次请求就能把响应撑到几 MB）；"
          "**非整数取缺省**而不是报错 —— 这是只读展示，手抖一个参数不该让人看不到日志",
          mod.clamp_tail_lines(999999) == mod.LOG_TAIL_MAX_LINES
          and mod.clamp_tail_lines(0) == 1
          and mod.clamp_tail_lines(-5) == 1
          and mod.clamp_tail_lines("abc") == mod.LOG_TAIL_DEFAULT_LINES
          and mod.clamp_tail_lines(None) == mod.LOG_TAIL_DEFAULT_LINES
          and mod.clamp_tail_lines("7") == 7,
          "%r %r %r" % (mod.clamp_tail_lines(None), mod.clamp_tail_lines(0),
                        mod.clamp_tail_lines(999999)))

    # ⑦ 逐行检查本身（纯函数，直接喂）
    # ★ 上面那一条把 `_big` 改小了（去验 `truncated` 为假那一头），这里重新写回
    #   一份大的 —— 夹具在两条判据之间被改掉，下一条就会在验别的东西，而它照样绿。
    # ★★ 夹具要**行长大于窗口能装下的行数**：短行的话，窗口里有一万多行，
    #    而行数上限（`lines`）会把开头那些**连半行一起**裁掉 —— 于是"丢不丢半行"
    #    这条判据在**有没有修**两种情况下给出同一份结果，一条都不红。
    #    （第一版就是这么写的，变异 Q7 逃了过去。）
    _long = os.path.join(_djlog, "slurm-4242.out")
    with io.open(_long, "w", encoding="utf-8") as f:
        f.write("".join("第 %d 行 " % i + "x" * 180 + "\n" for i in range(3000)))
    _cell = mod.read_log_tail((_djhome, os.path.join(_djhome, ".slurmate"), _djlog),
                              UID, _long, 2000)
    _cell_lines = ((_cell or {}).get("text") or "").split("\n")
    check("★ 从文件中间切进来时，**第一行半截的要丢掉**"
          "（印出去的话，人会以为那一行本来就长那样）",
          bool(_cell_lines) and re.match(r"^第 \d+ 行 x+$", _cell_lines[0]) is not None
          and _cell_lines[-1].startswith("第 2999 行 "),
          repr(_cell_lines[0][:30] if _cell_lines else None))
    check("★ 而那条判据不是空断言：窗口确实从中间切进来了（`truncated` 为真）",
          (_cell or {}).get("truncated") is True, str(_cell)[:120])
    _why = mod.read_log_tail((os.path.join(tmpdir, "nosuch-a"),
                              os.path.join(tmpdir, "nosuch-a", ".slurmate")),
                             UID, "/x", 3)
    check("★★ 目录链**根本不存在** ⇒ `null`（「这个作业还没有日志」），"
          "而目录链**存在但不可信** ⇒ 一格带 `why` 的「取不到」—— 两者不能并成一句",
          _why is None, str(_why))
    _bad_dir = os.path.join(tmpdir, "wl-logdir")
    os.makedirs(_bad_dir, exist_ok=True)
    os.chmod(_bad_dir, 0o777)
    _badcell = mod.read_log_tail((_bad_dir,), UID, os.path.join(_bad_dir, "x"), 3)
    check("★★ 而目录链上有**组/其他可写**的一级 ⇒ 不读，并如实说清是哪一条判据"
          "（并进 `null` 的话，一个模式不对的目录会让你看到「这台站点上没有日志」，"
          "而它明明在那里）",
          _badcell is not None and _badcell.get("text") is None
          and _badcell.get("why") == "component_group_or_world_writable",
          str(_badcell))
    check("★★ 而**文件**那一侧**不查 mode** —— 会话文件那条 `mode & 0o077` 的规矩"
          "照抄过来的话，`slurm-*.err` 会**永远**判「取不到」，而症状看起来像"
          "「站点上没有日志」",
          (lambda: (os.chmod(_bad_dir, 0o700),
                    os.chmod(_big, 0o644),
                    mod.read_log_tail(
                        (_djhome, os.path.join(_djhome, ".slurmate"), _djlog),
                        UID, _big, 3).get("text") is not None))(),
          "0644 的日志必须读得到")

    # ── 28.10 tick 里刷，而且只给**连着**的用户预热 ────────────────────
    _d29 = _mkd()
    _d29.slurm = _CountSlurm()
    _d29.tick()
    check("★★ tick 里会把集群信息刷一遍（刷新跑在 tick 里，请求才可能零 fork）",
          _d29.slurm.n.get("partition_table") == 1
          and _d29.slurm.n.get("controller_health") == 1,
          str(_d29.slurm.n))
    check("★ 没有连接时，**没有**任何按用户的查询被发出去"
          "（tick 不该替不在场的人问东西）",
          not any(k in _d29.slurm.n for k in _cu_names), str(_d29.slurm.n))
    _d29.slurm.n.clear()
    _c29, _k29 = _pair(_d29)
    _d29.tick()
    check("★★ tick 只给**连着**的用户预热自己那一份（判据是连着，不是有会话 ——"
          "一个刚连上、还没提交任何东西的用户打开集群面板时也要立刻有东西看）",
          all(_d29.slurm.n.get(k) == 1 for k in _cu_names), str(_d29.slurm.n))
    check("★ 前提：那条连接认得出来是谁（否则上面那条是空断言）",
          _d29.user_name(_k29.uid) == mod.pwd.getpwuid(UID).pw_name,
          str(_d29.user_name(_k29.uid)))
    _c29.close()
    _d29.slurm.n.clear()
    _d29.tick()
    check("★★ 断开之后**不再替它问** —— 而这正是 prune() 存在的理由："
          "一个只增的字典与一个泄漏的字典，从「会不会撑爆」的角度看没有区别",
          not any(k in _d29.slurm.n for k in _cu_names), str(_d29.slurm.n))
    check("★★ 而**刚被 tick 预热过**的条目不会被 prune 掉 —— `_seen` 记的是"
          "「最后一次有人碰过」，包括 tick 那一次。只在请求侧记的话，一个连着"
          "但没发过请求的用户会被每个快钟周期 prune 掉、再重查一遍",
          (lambda: (_d29.slurm.n.clear(), _d29.tick(),
                    _d29.cluster.prune(time.time()),
                    not [k for k in _d29.cluster._v if ":" in k]
                    and not [k for k in _d29.cluster._due if ":" in k]))(),
          str(sorted(_d29.cluster._v)))
    _c29b, _k29b = _pair(_d29)
    _d29.tick()
    _d29.cluster.prune(time.time() + 3 * mod.INFO_SLOW_SECONDS)
    check("★ 而真的很久没人问过之后，prune 把按用户的那几项丢掉"
          "（_v / _due / _taken 一起 —— 一个只增的字典与一个泄漏的字典，"
          "从「会不会撑爆」的角度看没有区别）",
          not [k for k in _d29.cluster._v if ":" in k]
          and not [k for k in _d29.cluster._due if ":" in k]
          and not [k for k in _d29.cluster._taken if ":" in k],
          str(sorted(_d29.cluster._v)))
    check("★ 而**共享**的那几类不受影响（它们与用户无关）",
          "partitions" in _d29.cluster._v, str(sorted(_d29.cluster._v)))
    _c29b.close()

    _cfgdoc_src = io.open(os.path.join(HERE, os.pardir, "cluster", "docs",
                                       "CONFIGURATION.md"), encoding="utf-8").read()
    # ── 28.11 启动自检：八个命令 ────────────────────────────────────────
    # ★★ 文档里那个数必须与 `GLOBAL_KEYS` 一致。它**本来就漂过一次**：写着
    #    「一共 13 个」而实际是 14 —— 一个没人验的数，迟早会变成一句错话，
    #    而"写进 conf 会被拒绝启动"的那些键正是靠这一节才找得到的。
    #
    # ★★ **比的是「集合」，不是「个数」。** 只比个数的话，**键名**不同也过得去，
    #    而那正是这张表唯一能漂的方式 —— 凭空多一行、或把一行换成另一个键名，只要
    #    行数不变就不会红；比集合则多一个、少一个、写错一个名字都红。
    _cn_at = _cfgdoc_src.find("站点通用键。一共 ")
    _cn_num = int(_cfgdoc_src[_cn_at + len("站点通用键。一共 "):].split(" ")[0]) \
        if _cn_at >= 0 and _cfgdoc_src[_cn_at + len("站点通用键。一共 "):].split(" ")[0].isdigit() \
        else -1
    check("★★ cluster/docs/CONFIGURATION.md 说「一共 N 个」的 N **等于** GLOBAL_KEYS 的个数",
          _cn_num == len(mod.GLOBAL_KEYS),
          "文档说 %s 个，实际 %d 个" % (_cn_num, len(mod.GLOBAL_KEYS)))
    # ★ 而那个数对不对只是**一半**：个数对了而键名不对的表，读起来一样顺，
    #   而"写进 conf 会被拒绝启动"的判据就错了。抽的是〈站点通用键〉那一节里
    #   每张表的**第一格**（一行里可以列好几个键，`sinfo` / `sshare` / `sacct`
    #   就是一行），取里面所有的反引号串 —— 表头与别的表第一格是中文，抓不到。
    _doc_keys, _in_sec = set(), False
    for _ln in _cfgdoc_src.splitlines():
        if _ln.startswith("## 一、站点通用键"):
            _in_sec = True
            continue
        if _in_sec and _ln.startswith("## "):
            break
        if _in_sec and _ln.startswith("| `"):
            _doc_keys |= set(re.findall(r"`([A-Za-z_][A-Za-z0-9_]*)`",
                                        _ln.split("|")[1]))
    check("★★ 而那张表里列的键**正好就是** GLOBAL_KEYS（不是「个数相同」就够 ——"
          "凭空多一行、或把一行换成别的键名，从前一条都不红）",
          _doc_keys == set(mod.GLOBAL_KEYS),
          "文档多出 %s；文档少了 %s" % (
              sorted(_doc_keys - set(mod.GLOBAL_KEYS)),
              sorted(set(mod.GLOBAL_KEYS) - _doc_keys)))
    check("★★ 三个新命令在配置白名单里（不在的话，写进 conf 会让守护进程拒绝启动）",
          all(k in mod.GLOBAL_KEYS for k in ("sinfo", "sshare", "sacct")),
          str(sorted(mod.GLOBAL_KEYS)))
    _bin_bad = []
    for _nm in ("sbatch", "scancel", "squeue", "scontrol", "sacctmgr",
                "sinfo", "sshare", "sacct"):
        _errs = mod.Config(write_conf("cluster_cidr = 192.0.2.0/24\n%s = /nonexistent/%s\n"
                                      % (_nm, _nm), "bin-%s.conf" % _nm)).validate()
        if not any(_nm in e for e in _errs):
            _bin_bad.append(_nm)
    check("★★ 八个 Slurm 命令**逐个**都在启动自检里（少一个 ⇒ 那一格的失败形态是"
          "「这个集群就是这样」，而根因在配置里）",
          _bin_bad == [], "没被检查的：%s" % _bin_bad)

    # ── 28.12 跨文件：协议的两半要逐字对上 ──────────────────────────────
    _sess_src = io.open(os.path.join(HERE, "slurmate-sessiond"),
                        encoding="utf-8").read()
    _be_src = io.open(os.path.join(HERE, os.pardir, "client", "src", "main",
                                   "backend-fake.js"), encoding="utf-8").read()
    _idx_src = io.open(os.path.join(HERE, os.pardir, "client", "src", "main",
                                    "index.js"), encoding="utf-8").read()
    # ★ 这一条判的是**真的发出去的那个 op 名**与守护进程那一侧逐字相同。
    #   从前客户端那一半查的是 IPC 通道名（`app:cluster`）—— 界面上那一屏自己去拉。
    #   现在那一屏没有了：站点状态由**主进程**定时问（`refreshSite`），再推给边栏
    #   浮窗。所以判据跟着挪到请求本身 —— 那才是漂了会变成 `unknown_op` 的东西。
    check("★★ 两个新 op 的名字两边逐字相同（漂了不是「少一格」，是"
          "**unknown_op** —— 而界面会把它画成一次失败）",
          'op == "cluster"' in _sess_src and "op: 'cluster'" in _idx_src
          and "case 'cluster':" in _be_src and "case 'history':" in _be_src,
          "")
    check("★★ 假后端也认这两个 op —— 它的全部价值就是「演的是同一件事」"
          "（一份只在它身上成立的协议比没有它更坏）",
          "case 'cluster':" in _be_src and "case 'history':" in _be_src,
          "")
    # ★★ **假后端的 op 集合必须 ⊆ 真守护进程的 op 集合。**
    #
    # 这一条是"假后端不许比真守护进程多知道任何东西"那条纪律在 **op 一级**的落点。
    # 一条只在假后端上存在的 op 比没有更坏：开发者模式里它会**成功地**返回一份
    # 编出来的数据，于是"这条路是通的"变成一个在真站点上不成立的结论 ——
    # 而那正是假站点存在的全部意义所在。
    #
    # ★ 判据是**集合**而不是某几个名字：逐个点名的话，下一个加 op 的人只要漏掉
    # 这里一格，那一条就永远不会被检查（而它看起来与"检查过了"一样）。
    #
    # ★ 反过来**不要求相等**：真守护进程有假后端还没演出来的 op（比如 `doctor`），
    #   那是"开发者模式里看不到这一格"，不是缺陷。要求相等会逼着假后端去编一个
    #   它并不知道的东西。
    # ★★ 两条都要**锚在行首**（`^\s*`，配 `re.M`）：不锚的话，把那一行**注释掉**
    #    （`// case 'job_log': …`）时它照样能被抽出来 —— 而那一行确实没接上。
    #    变异 Q8 第一轮就是这么逃过去的。
    _be_ops = set(re.findall(r"^\s*case '([a-z_]+)':", _be_src, re.M))
    _sd_ops = set(re.findall(r'^\s*if op == "([a-z_]+)":', _sess_src, re.M))
    check("★★★ 假后端的每一个 op 在真守护进程里都存在（一条只在假后端上成立的 op，"
          "比没有更坏 —— 它会让「这条路是通的」变成一个在真站点上不成立的结论）",
          bool(_be_ops) and bool(_sd_ops) and _be_ops <= _sd_ops,
          "假后端多出：%s（假后端 %d 个 / 守护进程 %d 个）"
          % (sorted(_be_ops - _sd_ops), len(_be_ops), len(_sd_ops)))
    check("★ 而这一条不是空断言：两个集合都抽到了东西",
          len(_be_ops) >= 8 and len(_sd_ops) >= 8,
          "假后端 %d 个 / 守护进程 %d 个" % (len(_be_ops), len(_sd_ops)))
    # ★★ 而上面那一条**盖不住这一种**：`op_job_log()` 这个函数写好了、dispatch 里
    #    却没有那一行。它照样不会让"假后端 ⊆ 守护进程"红（守护进程那边少一格，
    #    子集关系反而更容易成立），症状是真站点回 `unknown_op`、**而开发者模式里
    #    一切正常** —— 正是这一整块最会犯的那类错（有函数、没人调）。
    # ★★ 判据必须是**抽出来的集合**，不能是"源码里有这一串"：把那一行注释掉
    #    （`// case 'job_log': ...`）时，子串判据照样为真 —— 而那一行确实没接上。
    #    变异 Q8 第一轮就是这么逃过去的。
    check("★★ `job_log` 在**两边都真的接上了**：守护进程的 dispatch 里有一行、"
          "假后端的 dispatch 里有一个 case",
          "job_log" in _be_ops and "job_log" in _sd_ops,
          "假后端 %s / 守护进程 %s" % (sorted(_be_ops), sorted(_sd_ops)))
    # ★★ 这里从前还有一条：「面板上那四个 id 与 panel.js 读的逐字相同」。
    #    那四个 id 里三个（`btn-cluster` / `sec-cluster` / `cluster-body`）**跟着
    #    「集群状态」那一节一起删掉了**，第四个（`btn-history`）搬去了作业那一屏，
    #    而站点状态现在住在**另一个 renderer**（`hover.html` + `hover.js`）。
    #    ⇒ 判据跟着渲染实现走，不删：`client/test/hover.test.mjs` 里有一条
    #      「hover.js 用到的每个 id 都在 hover.html 里」，面板那一侧照旧在
    #      `renderer.test.mjs`。**不在这里再写第三遍** —— 同一件事写三处，漂的是两处。
    #
    # ★★ 判据要落在 `na()` 的**函数体**上，不是只数调用点：调用点还在、
    #    而函数体被改成返回一个空元素的话，界面上"取不到"就是一格**空白** ——
    #    而那正是这一条要防的那件事（"忘了写数据"与"确实没有"长得一样）。
    #    实测：只数调用点的版本，对上面那种改动**一条都不红**。
    #
    # ★ `na()` 从 `panel.js` 搬到了 `dom.js`（面板与浮窗两个渲染页面共用的那三个
    #   小东西）—— 判据跟着它走。**读的是它现在住的那个文件**，否则这条会变成
    #   查一个不存在的函数（`_na_at = -1` ⇒ 空串 ⇒ 判据变红，而那看起来像
    #   "有人把「取不到」删了"）。
    _dom_src = io.open(os.path.join(HERE, os.pardir, "client", "src", "renderer",
                                    "dom.js"), encoding="utf-8").read()
    _na_at = _dom_src.find("function na(")
    _na_body = _dom_src[_na_at:_dom_src.find("\n}", _na_at)] if _na_at >= 0 else ""
    # 调用点也数一遍：**函数体对、而没有人调用**是一句空话。`na(...)` 的调用点
    # 现在全在浮窗那一页（`hover.js`）—— 站点状态是它一个 renderer 在画。
    _hv_src = io.open(os.path.join(HERE, os.pardir, "client", "src", "renderer",
                                   "hover.js"), encoding="utf-8").read()
    # ★★ 同一个分区的 GRES 有两个显示出口（表单里那一行、集群状态那一格），
    #    而"名字怎么拼"在客户端只该有一处（`gres.js` 的 `gresLabel`）。
    #    过了拼法与没过拼法，两边**都没错**，只是会显示成 `gpu:a6000` 与 `gpu` ——
    #    一句谁也说不清哪个对的话。
    _idx_src28 = io.open(os.path.join(HERE, os.pardir, "client", "src", "main",
                                      "index.js"), encoding="utf-8").read()
    check("★★ 集群状态里的 GRES 也过客户端那处**唯一的拼法**"
          "（不过的话，同一个分区在表单里是 `gpu:a6000`、在这一屏是 `gpu`）",
          "withGresCatalogLabels(resp.data.gres)" in _idx_src28
          and "withGresLabels((resp.data && resp.data.partitions)" in io.open(
              os.path.join(HERE, os.pardir, "client", "src", "main", "index.js"),
              encoding="utf-8").read(),
          "")
    check("★★★ 「取不到」那一行必须**画得出那句人话**：`na()` 的函数体里要有"
          "「取不到」这三个字，而且它要落在**看得见的**元素上（返回一个空元素"
          "等于把「取不到」画成一片空白，而那与「确实没有」长得一样）",
          _na_at >= 0 and "取不到" in _na_body and "'na'" in _na_body
          and _hv_src.count("na('") >= 4,
          "na() 函数体：%r（调用点 %d 处）" % (_na_body[:90], _hv_src.count("na('")))

    # ── 28.13 ★★ 两道闸：能力（本机）与配额（全局）───────────────────────
    # ★★ 这一段钉的是 cluster/docs/CONFIGURATION.md 里〈这一格与插件声明的 `concurrent`
    #    是两道闸〉那一节的两个**具体事实**。那一节的结论（"缺省 1 会让能多开的
    #    插件开不出第二份"）全部压在它们身上，而两者都会随着**别处**的改动悄悄
    #    变成假话 —— 而一句假话不会红任何东西。
    #
    # ★ 判据取**表里那一格**（结构），不取正文里那句话（措辞）：措辞会改，
    #   而"缺省是几"不该跟着措辞一起漂。同 28.11 里那个「一共 N 个」。
    #
    # ★★ 选择器要能**唯一**命中键表那一行：同一格里我新写的那张两列表也以同样的
    #    三个字开头 —— 第一版就是被它顶成两个候选、报了 None，而那是一个
    #    "守着自己写错"的红，与"文档漂了"长得一样。键表那一行有**四个单元格**。
    _cap_rows = [ln for ln in _cfgdoc_src.splitlines()
                 if ln.startswith("| `max_sessions_per_user` |")
                 and len(ln.split("|")) == 6]
    _cap_doc = (_cap_rows[0].split("|")[3].strip().strip("`")
                if len(_cap_rows) == 1 else None)
    check("★★ cluster/docs/CONFIGURATION.md 里 `max_sessions_per_user` 的缺省值"
          "**等于**守护进程的常量（不等的话，这一节「缺省 1 压住了能力」"
          "整段就是一句错话）",
          _cap_doc is not None
          and _cap_doc == str(mod.DEFAULT_MAX_SESSIONS_PER_USER),
          "命中 %d 行；文档说 %r，代码是 %r"
          % (len(_cap_rows), _cap_doc, mod.DEFAULT_MAX_SESSIONS_PER_USER))

    # ★ 这里读的是**插件自己的 README**（基座文档不点名任何插件）。举错例子的
    #   症状没变 —— "文档里的反例在真站点上并不成立"，而它读起来一点问题都没有
    #   —— 所以这一条要把**文档说的**与**清单里真的**都看一遍：两边各说各的时，
    #   错的那一份不会红任何东西。
    _cs_readme = io.open(
        os.path.join(HERE, os.pardir, "plugins", "code-server", "README.md"),
        encoding="utf-8").read()
    _cs_manifest = json.load(io.open(
        os.path.join(HERE, os.pardir, "plugins", "code-server", "plugin.json"),
        encoding="utf-8"))
    _cs_conc = (_cs_manifest.get("contributes") or {}).get("concurrent")
    check("★ plugins/code-server/README.md 说这个插件声明了 `concurrent: true`，"
          "而插件清单里**真的**是",
          '"concurrent": true' in _cs_readme and _cs_conc is True,
          "README 里有那句话=%s；清单里是 %r"
          % ('"concurrent": true' in _cs_readme, _cs_conc))

    # ══════════════════════════════════════════════════════════════════════
    #  29. 看护者：谁在看这条会话（v0.9 阶段 1）
    # ══════════════════════════════════════════════════════════════════════
    #
    # ★★ 这一节守的是一句话：**一条会话同一时刻只有一个看护者**，而"看护者"
    #    决定了谁刷得动 `last_hb_socket` —— 也就是**谁的作业不会被 300/1800 秒
    #    那条超时干掉**。判据写错的后果是整批 scancel，所以这里每一条都是
    #    "哪一类连接刷得动"的直接断言，而不是"这一列写着什么"。
    #
    # ★ 最要紧的一条在 29.5：**没报身份的连接一律刷得动**（哪怕看护者是别人）。
    #   收严它 = 客户端在常驻通道抖动、退化成 exec 之后心跳全被忽略 ⇒ 用户看着
    #   的作业在 1800 秒后被杀，而界面上一切正常（心跳"发出去了"，回的是 ok）。

    # ── 29.1 提交那一刻的第一任看护者 ────────────────────────────────────
    _r29a, _s29a, _ = run_submit({"op": "submit"}, client_id="mX")
    check("★★ 报了身份的提交 ⇒ keeper 就是那个 client_id（谁提交谁在看）",
          _r29a.get("ok") and _s29a["keeper"] == "mX", repr(_s29a.get("keeper")))
    _r29b, _s29b, _ = run_submit({"op": "submit"})
    check("★★ 不报身份的提交（CLI / exec 退路）⇒ keeper 是 **NULL** —— 而 NULL 是"
          "「确实没人在看」（合法的空），不是「不知道」",
          _r29b.get("ok") and _s29b["keeper"] is None, repr(_s29b.get("keeper")))

    # ── 29.2 看护者非空 ⇒ 只有它刷得动 ───────────────────────────────────
    _d30 = _mkd()
    _add(_d30, "s-own", job_id="601", keeper="mA", hb=mod.now_ts() - 10)
    _t30 = _d30.store.get("s-own")["last_hb_socket"]
    _rb30 = _d30.dispatch(UID, os.getgid(),
                          {"op": "heartbeat", "session_id": "s-own"}, "mB")
    check("★★★ 不是看护者的心跳：回 **ok**（不是错）+ `ignored`，"
          "而 `last_hb_socket` 一个字都没动",
          _rb30.get("ok")
          and (_rb30.get("data") or {}).get("ignored") == "not_keeper"
          and _d30.store.get("s-own")["last_hb_socket"] == _t30,
          "%s / %s" % (str(_rb30)[:120],
                       _d30.store.get("s-own")["last_hb_socket"]))
    _add(_d30, "s-susp", job_id="602", keeper="mA", state=mod.ST_SUSPECT,
         hb=mod.now_ts() - 10)
    _d30.dispatch(UID, os.getgid(),
                  {"op": "heartbeat", "session_id": "s-susp"}, "mB")
    check("★★ 而别人的心跳也**救不回**一个 suspect 的会话"
          "（那台电脑并没有在看它；能救回它的是「另一个人的心跳」）",
          _d30.store.get("s-susp")["state"] == mod.ST_SUSPECT,
          _d30.store.get("s-susp")["state"])
    _ra30 = _d30.dispatch(UID, os.getgid(),
                          {"op": "heartbeat", "session_id": "s-own"}, "mA")
    check("★ 看护者自己的心跳照常推进，而且**不认领**（keeper 本来就是它）",
          _ra30.get("ok") and "ignored" not in (_ra30.get("data") or {})
          and _d30.store.get("s-own")["last_hb_socket"] > _t30
          and _d30.store.get("s-own")["keeper"] == "mA",
          str(_ra30.get("data")))

    # ── 29.3 看护者为空 ⇒ 谁都刷得动（老客户端那条路逐字不变）────────────
    _d31 = _mkd()
    _add(_d31, "s-free", job_id="603", hb=mod.now_ts() - 10)
    _t31 = _d31.store.get("s-free")["last_hb_socket"]
    _ra31 = _d31.dispatch(UID, os.getgid(), {"op": "heartbeat",
                                             "session_id": "s-free"})
    check("★★★ keeper 为空 ⇒ **不带身份**的心跳照常推进 —— 这正是 `slurmate rpc` /"
          " `slurmate wait` / 更老的客户端走的那条路",
          _ra31.get("ok") and "ignored" not in (_ra31.get("data") or {})
          and _d31.store.get("s-free")["last_hb_socket"] > _t31,
          str(_ra31.get("data")))
    check("★★ 而它**不认领**：匿名没有名字可写，keeper 仍然是 NULL"
          "（「有个人在刷」与「这台电脑在看」是两件事）",
          _d31.store.get("s-free")["keeper"] is None,
          repr(_d31.store.get("s-free")["keeper"]))

    # ── 29.4 报了身份的空 keeper ⇒ 认领，而认领之后别人就进不来了 ─────────
    _rc31 = _d31.dispatch(UID, os.getgid(),
                          {"op": "heartbeat", "session_id": "s-free"}, "mC")
    check("★★ 报了身份、而 keeper 为空 ⇒ **认领**（keeper 变成它）—— "
          "没有这一条，CLI 提交的会话永远无主：界面画不出「这台电脑在看它」，"
          "换一台电脑之后两台都以为自己在看、谁也踢不掉谁",
          _d31.store.get("s-free")["keeper"] == "mC",
          repr(_d31.store.get("s-free")["keeper"]))
    _rd31 = _d31.dispatch(UID, os.getgid(),
                          {"op": "heartbeat", "session_id": "s-free"}, "mD")
    check("★ 认领之后，第三台电脑的心跳就被挡在外面了（回 ignored）",
          (_rd31.get("data") or {}).get("ignored") == "not_keeper",
          str(_rd31.get("data")))

    # ── 29.5 ★★★ 没报身份 ⇒ 一律刷得动，哪怕看护者是别人 ─────────────────
    #
    # ★ 这一条看着"宽"，而它是这一版最重的一条：客户端在常驻通道断掉之后会
    #   退化成一次性的 exec，而那条路上 `client` 是**被删掉**的
    #   （见 backend-ssh.js 的 rpc()）。收严这一条的后果不是"少一次心跳"，
    #   是**用户正看着的作业在 1800 秒后被 scancel**。
    _d32 = _mkd()
    _add(_d32, "s-anon", job_id="604", keeper="mA", hb=mod.now_ts() - 10)
    _t32 = _d32.store.get("s-anon")["last_hb_socket"]
    _re32 = _d32.dispatch(UID, os.getgid(), {"op": "heartbeat",
                                             "session_id": "s-anon"})
    check("★★★ 看护者是别人、而这条连接**没报身份** ⇒ 心跳照常推进"
          "（exec 退路与 CLI 走的正是这条路）",
          _re32.get("ok") and "ignored" not in (_re32.get("data") or {})
          and _d32.store.get("s-anon")["last_hb_socket"] > _t32,
          str(_re32.get("data")))
    check("★★ 但它**抢不走** keeper —— 没有身份就没有名字可写"
          "（「没被排除」与「能当看护者」是两件事）",
          _d32.store.get("s-anon")["keeper"] == "mA",
          repr(_d32.store.get("s-anon")["keeper"]))

    # ── 29.6 端到端：身份取自**连接**（handle_line 那一行）────────────────
    # ★ 上面几条都是直接调 dispatch 喂 client_id，验的是**规则**；这一条验的是
    #   那口"井"接对了没有 —— 规则对而接线错，表现与规则错一模一样。
    # ★ 不需要把连接上限调高：每用户上限判在 **accept** 那一刻，而 `_pair` 是
    #   直接把连接挂进 selector 的（它模拟的是"已经连上"）。见 27.3。
    _d33 = _mkd()
    _w1c, _w1k = _pair(_d33)
    _w1c.send({"op": "ping", "rid": 1, "client": {"id": "mA", "name": "甲机"}})
    _drive(_d33)
    _add(_d33, "s-e2e", job_id="605", keeper="mA")
    _w1c.send({"op": "heartbeat", "session_id": "s-e2e", "rid": 2})
    _drive(_d33)
    _w1r = [m for m in _w1c.lines() if m.get("rid") == 2]
    check("★★ 心跳的身份取自**连接**（`conn.client_id`），不是请求体 ——"
          "守护进程这一侧没有第二个身份来源",
          bool(_w1r) and "ignored" not in (_w1r[0].get("data") or {}),
          str(_w1r)[:160])
    _w2c, _w2k = _pair(_d33)
    _w2c.send({"op": "ping", "rid": 1, "client": {"id": "mB", "name": "乙机"}})
    _drive(_d33)
    _w2c.send({"op": "heartbeat", "session_id": "s-e2e", "rid": 2})
    _drive(_d33)
    _w2r = [m for m in _w2c.lines() if m.get("rid") == 2]
    check("★★ 而另一条连接带着**自己的**身份发同一个心跳 ⇒ 被挡在外面"
          "（这一条与上一条合起来才是「身份取自连接」）",
          bool(_w2r)
          and (_w2r[0].get("data") or {}).get("ignored") == "not_keeper",
          str(_w2r)[:160])
    check("★ 前提：两条连接各自都认了身份（否则上一条是空断言）",
          _w1k.client_id == "mA" and _w2k.client_id == "mB",
          "%s / %s" % (_w1k.client_id, _w2k.client_id))
    _w1c.close()
    _w2c.close()

    # ── 29.7 ★★★ 接管：**只有一格会变** ─────────────────────────────────
    #
    # ★ 这条用例的全部意义是那个**差集**。接管存在的理由是「用户只是换了一台
    #   电脑看同一个作业」，所以除了 `keeper`，会话行、nft 规则都不许动一个字 ——
    #   动了任何一个，接管的语义就变成"结束并重开"，而那是另一个按钮。
    _d34 = _mkd()
    _d34.nft = _NftRec()
    _add(_d34, "s-tk", job_id="606", keeper="mA", hb=mod.now_ts() - 5)
    _d34.store.update("s-tk", node_ip="192.0.2.11", service_port=55001)
    _d34.tick()                        # 对账把 ACL 规则建起来
    _row0 = dict(_d34.store.get("s-tk"))
    _rules0 = dict(_d34.nft.rules)
    check("★ 前提：这条会话确实占着一条 ACL 规则且作业在跑（否则下面全是空断言）",
          len(_rules0) == 1 and _row0["state"] == mod.ST_ENROLLED,
          "%s / %s" % (sorted(_rules0), _row0["state"]))
    _rtk = _d34.dispatch(UID, os.getgid(),
                         {"op": "takeover", "session_id": "s-tk"}, "mB")
    _row1 = dict(_d34.store.get("s-tk"))
    _diff = sorted(k for k in set(_row0) | set(_row1)
                   if _row0.get(k) != _row1.get(k))
    check("★★★ 接管 ⇒ 会话行逐字段比对，**差集恰好是 {keeper}**",
          _rtk.get("ok") and _diff == ["keeper"], str(_diff))
    check("★★ 而 nft 规则**一条都没动**（既没删也没加）",
          dict(_d34.nft.rules) == _rules0 and _d34.nft.deleted == [],
          "%s / 删过 %s" % (sorted(_d34.nft.rules), _d34.nft.deleted))
    check("★ 响应里说得清是从谁手里接过来的（界面要能写「已从甲机接管」）",
          (_rtk.get("data") or {}).get("was") == "mA"
          and (_rtk.get("data") or {}).get("keeper") == "mB",
          str(_rtk.get("data")))
    _rtk2 = _d34.dispatch(UID, os.getgid(),
                          {"op": "takeover", "session_id": "s-tk"}, "mB")
    check("★ 自己接管自己的（界面点两下）不是错，也不改任何东西",
          _rtk2.get("ok") and (_rtk2.get("data") or {}).get("was") == "mB"
          and dict(_d34.store.get("s-tk")) == _row1,
          str(_rtk2.get("data")))

    # ── 29.8 接管的两条边界 ──────────────────────────────────────────────
    _rtk3 = _d34.dispatch(UID, os.getgid(), {"op": "takeover",
                                             "session_id": "s-tk"})
    check("★★ 没报身份的连接**不能**接管 —— 要把看护者写成谁？"
          "（与心跳那条正好相反，而这不是矛盾：心跳是「我在续命」，少一个身份"
          "仍然该宽进；接管是「我来当家」，它要往那一格里写一个名字）",
          (_rtk3.get("error") or {}).get("kind") == "no_client_id",
          str(_rtk3.get("error")))
    _add(_d34, "s-over", job_id="607", keeper="mA", state=mod.ST_RELEASED)
    _rtk4 = _d34.dispatch(UID, os.getgid(),
                          {"op": "takeover", "session_id": "s-over"}, "mB")
    check("★★ 已经结束的会话**接管不了** —— 幂等地「成功」会让用户以为接管了，"
          "而他该看到的是「这条作业已经结束」",
          (_rtk4.get("error") or {}).get("kind") == "session_gone",
          str(_rtk4.get("error")))

    # ── 29.9 离开：清空，而**只报真的清掉的那几条** ─────────────────────
    _d35 = _mkd()
    _add(_d35, "s-l1", job_id="608", keeper="mA", hb=mod.now_ts() - 5)
    _add(_d35, "s-l2", job_id="609", keeper="mB", hb=mod.now_ts() - 5)
    _add(_d35, "s-l3", job_id="610", hb=mod.now_ts() - 5)      # 本来就没人在看
    _rlv = _d35.dispatch(UID, os.getgid(),
                         {"op": "leave",
                          "session_ids": ["s-l1", "s-l2", "s-l3", "s-nope"]})
    check("★★ leave 把清单里那些会话的看护者清空 —— **包括是别人的**："
          "它是一次「放手」，与 goodbye 同族，不是一次「取得」",
          _d35.store.get("s-l1")["keeper"] is None
          and _d35.store.get("s-l2")["keeper"] is None,
          "%r / %r" % (_d35.store.get("s-l1")["keeper"],
                       _d35.store.get("s-l2")["keeper"]))
    check("★★ 而响应里只报**真的清掉了**的那几条：本来就没人在看的（s-l3）与"
          "不存在的（s-nope）都不算 —— 报进去就是一句假话（那几条什么都没发生）",
          (_rlv.get("data") or {}).get("cleared") == ["s-l1", "s-l2"],
          str(_rlv.get("data")))
    check("★★ 清空之后库里是 **NULL**，不是空串"
          "（空串会让「确实没人在看」与「有人在看、只是名字是空的」分不开）",
          _d35.store.get("s-l1")["keeper"] is None,
          repr(_d35.store.get("s-l1")["keeper"]))
    _rlv2 = _d35.dispatch(UID, os.getgid(), {"op": "leave"})
    check("★ 不带清单 / 空清单被明确拒绝（不是「沉默地什么都不做」）",
          (_rlv2.get("error") or {}).get("kind") == "bad_request",
          str(_rlv2.get("error")))
    _rlv3 = _d35.dispatch(UID, os.getgid(),
                          {"op": "leave",
                           "session_ids": ["x%d" % i
                                           for i in range(mod.LEAVE_MAX_SESSIONS + 1)]})
    check("★★ 超过 %d 条被**拒绝**而不是悄悄截断"
          "（截断会让客户端以为「都放开了」，而后面那几条还挂着看护者）"
          % mod.LEAVE_MAX_SESSIONS,
          (_rlv3.get("error") or {}).get("kind") == "bad_request",
          str(_rlv3.get("error")))

    # ── 29.10 离开之后走的是**同一条**窗口（不新开第二个）────────────────
    _d36 = _mkd(suspect_after=10, orphan_after=20, startup_grace_seconds=0)
    _cancels = []
    _d36.slurm.cancel = lambda *a, **k: _cancels.append(a) or True
    _add(_d36, "s-win", job_id="611", keeper="mA", hb=mod.now_ts() - 30)
    _d36.dispatch(UID, os.getgid(),
                  {"op": "leave", "session_ids": ["s-win"]})
    _d36.tick()
    check("★★ 离开之后走的是**同一条**窗口：心跳断了 30 秒 ⇒ suspect"
          "（既不「立刻结束」，也不「什么都不做」—— 一条窗口两个入口）",
          _d36.store.get("s-win")["state"] == mod.ST_SUSPECT,
          _d36.store.get("s-win")["state"])
    _d36.tick()
    _sw = _d36.store.get("s-win")
    check("★★ 再一轮 ⇒ orphaned，而且**真的发了 scancel**"
          "（「临时离开由超时来控制」这句话落在这里）",
          _sw["note"] == "orphaned" and len(_cancels) == 1,
          "%s / scancel %d 次" % (_sw["note"], len(_cancels)))

    # ── 29.11 ★★ 闪断 ≠ 离开 ───────────────────────────────────────────
    #
    # ★★★ 这是"离开"这条 op 存在的全部理由的反面：一次网络抖动**不是**一次
    #    离开。把两者混起来，用户回来时作业已经在回收路上了。
    _d37 = _mkd()
    _f1c, _f1k = _pair(_d37)
    _f1c.send({"op": "ping", "rid": 1, "client": {"id": "mA", "name": "甲机"}})
    _drive(_d37)
    _add(_d37, "s-flash", job_id="612", keeper="mA", hb=mod.now_ts() - 5)
    _f1c.send({"op": "heartbeat", "session_id": "s-flash", "rid": 2})
    _drive(_d37)
    _f1c.lines()
    # 闪断：**只**是连接断了，没有任何显式事件发生
    _f1c.close()
    _d37.drop_conn(_f1k, "模拟闪断")
    check("★★★ 闪断（连接断了、没有任何显式事件）⇒ 看护者**保留** —— "
          "它是「这台电脑还在看，只是一时联系不上」",
          _d37.store.get("s-flash")["keeper"] == "mA"
          and _d37.store.get("s-flash")["state"] == mod.ST_ENROLLED,
          "%r / %s" % (_d37.store.get("s-flash")["keeper"],
                       _d37.store.get("s-flash")["state"]))
    _f2c, _f2k = _pair(_d37)                    # 同一台电脑重连（同一个 client_id）
    _f2c.send({"op": "ping", "rid": 1, "client": {"id": "mA", "name": "甲机"}})
    _drive(_d37)
    _f2c.send({"op": "heartbeat", "session_id": "s-flash", "rid": 2})
    _drive(_d37)
    _f2r = [m for m in _f2c.lines() if m.get("rid") == 2]
    check("★★ 重连之后心跳**继续算**（自动恢复）—— 这正是「闪断必须能自动恢复」"
          "那条根本要求的落点",
          bool(_f2r) and "ignored" not in (_f2r[0].get("data") or {})
          # ★ 判据是"这一次心跳**落地了**"（库里那一格 == 应答里的那个时刻），
          #   而不是"它比上一次大" —— `now_ts()` 是**秒级**的，同一个用例里连着
          #   两次心跳会落在同一秒上，`>` 会假红（第一版正是这么红的）。
          and _d37.store.get("s-flash")["last_hb_socket"]
          == (_f2r[0].get("data") or {}).get("at"),
          str(_f2r)[:150])
    _f2c.close()

    # ── 29.12 ★★★ 接管要在旧看护者那边**看得见** ────────────────────────
    #
    # ★ 旧看护者怎么知道？两条路：它的下一次心跳会被回 `ignored`，以及
    #   **全量快照里 `keeper` 变了**（指纹变了 ⇒ 下一个 tick 就有一条推送）。
    #   刻意**没有**一条专门的 `taken_over` 推送 —— 全量推送的可丢弃性是这一版
    #   的承重性质，而"谁在看"本来就是快照里的一格。
    _d38 = _mkd(snapshot_interval=30.0)
    _k1c, _k1k = _pair(_d38)
    _k1c.send({"op": "ping", "rid": 1, "client": {"id": "mA", "name": "甲机"}})
    _drive(_d38)
    _add(_d38, "s-alert", job_id="613", keeper="mA", hb=mod.now_ts() - 5)
    _d38.tick()
    _drive(_d38)
    _k1c.lines()                   # 丢掉第一帧（那是「从无到有」，不是「变了」）
    _d38.dispatch(UID, os.getgid(),
                  {"op": "takeover", "session_id": "s-alert"}, "mB")
    _d38.tick()
    _drive(_d38)
    _keeper_seen = None
    for _m in [x for x in _k1c.lines() if x.get("push") == "sessions"]:
        for _s in (_m.get("sessions") or []):
            if _s.get("session_id") == "s-alert":
                _keeper_seen = _s.get("keeper")
    check("★★★ 看护者变了 ⇒ 旧看护者在下一条**全量**推送里就看得见"
          "「现在不是我」—— 这就是「上一个电脑的界面要被踢掉」的那条通路"
          "（周期是 30 秒，所以这一条**只**可能是「变了才推」）",
          _keeper_seen == "mB", repr(_keeper_seen))
    _k1c.close()

    # ── 29.13 契约：`session_view` 的那一格与文档 ─────────────────────────
    _proto = io.open(os.path.join(HERE, os.pardir, "docs", "PROTOCOL.md"),
                     encoding="utf-8").read()
    _add(_d35, "s-view", job_id="614", keeper="mZ")
    _vw = _d35.session_view(_d35.store.get("s-view"), with_secret=False)
    check("★★ 跨文件：`session_view` 真的吐 `keeper` 那一格，而 docs/PROTOCOL.md "
          "的字段表里也写着它（两半缺一，界面那一侧就没有可读的东西）",
          _vw.get("keeper") == "mZ" and "`keeper`" in _proto,
          "%r / 文档里%s" % (_vw.get("keeper"),
                             "有" if "`keeper`" in _proto else "★ 没有"))
    check("★★ 而取值**只有两种**：一个 client_id 或者 `null`"
          "（不是空串、不是 \"unknown\" —— 界面据此知道该不该画「接管」）",
          isinstance(_vw.get("keeper"), str)
          and _d35.session_view(_d35.store.get("s-l1"),
                                with_secret=False).get("keeper") is None,
          repr(_vw.get("keeper")))

    # ══ 30. 释放那条路要能说实话（v0.9 阶段 4：账本 F12 / F13）══════════════
    #
    # ★★ `phase_release` **必须确认作业是否还在**：若不确认就删 ACL、删口令文件、
    #    删会话文件、置 `released`，那"已释放"这句话就可以是假的 —— 作业占着节点
    #    跑到 TimeLimit（GPU 分区上那是 12 小时实打实的算力），而会话文件已经删了、
    #    `released` 又不在 `phase_running` 的扫描集合里 ⇒ **再也找不回来**。而
    #    `op_goodbye` 若丢掉 `cancel()` 的返回值，连"这一次没成功"都不说。
    #
    # ★ 这一节有**两半**，第二半是承重的：**闸**（只有确认作业停了才拆）与
    #   **那句话**（没成功要说出来、必须走到用户眼前）。只判"状态没变"的话，
    #   把拆除提到闸前面的写法照样绿 —— 所以每条判据里都带着"规则一条都没少、
    #   会话文件还在"，那才是"什么都没拆"。
    print("\n── 30. 释放的闸：确认作业真的停了才拆（F12 / F13）──")

    check("★ 重试间隔是一个**常量**而不是配置键（与 job_missing_confirm_ticks "
          "同族：这些时间刻度从来没有站点改过）",
          mod.RELEASE_RETRY_SECONDS >= 1
          and "release_retry_seconds" not in mod.GLOBAL_KEYS
          and cfg.release_retry_seconds == mod.RELEASE_RETRY_SECONDS,
          "%s / 在 GLOBAL_KEYS 里：%s"
          % (getattr(mod, "RELEASE_RETRY_SECONDS", "★ 没有这个常量"),
             "release_retry_seconds" in mod.GLOBAL_KEYS))

    class _RelSlurm(object):
        """能喂三态的 Slurm：`jobs[jid]` 是 dict（JOB_OK）/ `None`（**UNKNOWN**）
        / 缺席（MISSING）。外加一个 cancel 计数器与一个可设的成功/失败。

        ★ 三态必须都能喂到：这一节要验的第一件事就是"问不到"**不许**被当成
          "不存在" —— 而一个只会吐 MISSING 的夹具让那条判断无从验起。
        """
        JOB_OK = mod.Slurm.JOB_OK
        JOB_MISSING = mod.Slurm.JOB_MISSING
        JOB_UNKNOWN = mod.Slurm.JOB_UNKNOWN

        def __init__(self):
            self.jobs = {}
            self.cancels = []
            self.cancel_ok = True

        def job_state(self, jid):
            j = self.jobs.get(str(jid), "absent")
            if j == "absent":
                return self.JOB_MISSING, None
            if j is None:
                return self.JOB_UNKNOWN, None
            return self.JOB_OK, dict(j)

        def show_job(self, jid):
            j = self.jobs.get(str(jid))
            return dict(j) if isinstance(j, dict) else None

        def expand_node(self, _n):
            return "node01"

        def node_ip(self, _n):
            return "192.0.2.11"

        def renew(self, *_a, **_k):
            return True, ""

        def cancel(self, jid, reason=""):
            self.cancels.append((str(jid), reason))
            return self.cancel_ok

    _rel_real_now = mod.now_ts
    _rel_clock = [1700500000]
    mod.now_ts = lambda: _rel_clock[0]
    _rel_daemons = []
    # 这一节会故意造出十几个"释放不了"的会话，每一个都写一行 warning。
    # 要断言的事情全走 `dd.audit` 的记录器与数据库，一行日志都不靠 ——
    # 关掉它们只是为了让输出里剩下的全是断言（照第 24 节的做法）。
    _rel_real_level = mod.log.level
    mod.log.setLevel(50)                       # CRITICAL

    def _rel_case(job, *, job_id="7001", cancel_ok=True, note="goodbye"):
        """造一个 `releasing` 的会话 + 一条 ACL 规则 + 一个会话文件，跑**一个** tick。

        `job`：`"missing"` / `"unknown"` / 一个 `JobState` 名字 / `"{}"`（在队列里
        但拿不到详情 —— 真 `job_state()` 会这么回）。

        返回 `(daemon, 事件表, 会话文件路径)`。
        """
        dd = _mkd(startup_grace_seconds=0)
        dd.nft = _NftRec()
        dd.slurm = _RelSlurm()
        dd.slurm.cancel_ok = cancel_ok
        if job == "missing":
            pass
        elif job == "unknown":
            dd.slurm.jobs[job_id] = None
        elif job == "{}":
            dd.slurm.jobs[job_id] = {}
        else:
            dd.slurm.jobs[job_id] = {"JobState": job, "Requeue": "0"}
        ev = []
        dd.audit = lambda e, **kw: ev.append(dict(kw, event=e))
        _add(dd, "s-rel", job_id=job_id, state=mod.ST_RELEASING)
        if note:
            dd.store.update("s-rel", note=note)
        if job_id is not None:
            # ★ 必须把 node_ip / service_port 也写上：`reconcile()` 的期望集合是
            #   "ACL_STATES 里、且这两个字段都在的那些会话"，少了它们，下面那条
            #   规则在同一个 tick 里会被当成**孤儿规则删掉** —— 于是"规则一条都
            #   没少"那条断言测的是一条根本不存在的规则。
            dd.store.update("s-rel", node_ip="192.0.2.11", service_port=55001)
            dd.nft.add_session_rule("192.0.2.11", 55001, UID, job_id)
            sf = os.path.join(sess_dir, "job-%s.json" % job_id)
            with io.open(sf, "w", encoding="utf-8") as f:
                f.write("{}")
            os.chmod(sf, 0o600)
        else:
            sf = None
        dd.tick()
        _rel_daemons.append(dd)
        return dd, ev, sf

    def _rel_state(dd):
        return dd.store.get("s-rel")["state"]

    # ── 30.1 ★★★ 问不到 ≠ 不存在 ────────────────────────────────────────────
    #
    # ★★★ 这是整道闸上最重的一条。把 JOB_UNKNOWN 归进"可以拆"，形态是
    #     **一次控制器抖动 = 所有正在释放的会话在同一 tick 内被拆干净**，
    #     而它们对应的作业可能一个都没停。`Slurm.job_state()` 的三态就是为这个
    #     存在的，它自己的 docstring 写着合并两者的后果。
    _dd, _ev, _sf = _rel_case("unknown")
    check("★★★ 问不到控制器 ⇒ **不拆**（问不到 ≠ 不存在）",
          _rel_state(_dd) == mod.ST_RELEASING and os.path.exists(_sf),
          "state=%r 会话文件在=%s" % (_rel_state(_dd), os.path.exists(_sf)))
    check("★★ 而 ACL 规则也一条都没少 —— 「没拆」的第二半是承重的那个",
          len(_dd.nft.rules) == 1, str(_dd.nft.rules))
    _rw = [e for e in _ev if e["event"] == "release_waiting"]
    check("★★ 它**说得出来**（否则用户看见的就是一条永远停着的会话）",
          len(_rw) == 1 and _rw[0].get("why") == "unknown"
          and _rw[0].get("job_state") is None, str(_rw))
    check("★ 而联系不上控制器时**不重试 scancel** —— scancel 会以同样的方式失败，"
          "而那条日志会把真正的原因（联系不上）埋在一句「取消失败」下面",
          _dd.slurm.cancels == [], str(_dd.slurm.cancels))

    # ── 30.2 ★★★ 作业还在 ⇒ 不拆，而且再 scancel 一次 ──────────────────────
    #
    # `CANCELLING` 是**最常撞上的那一个**：scancel 之后作业不会立刻消失，它会先
    # 经过 CANCELLING（Slurm 23.02 起的一个非终态）再到 CANCELLED。把它当成"停了"，
    # 就等于**每一次正常的取消都在作业还活着的时候宣布"已释放"**。
    for _st in ("RUNNING", "PENDING", "CANCELLING", "COMPLETING", "SUSPENDED",
                "REQUEUED", "STAGE_OUT"):
        _dd, _ev, _sf = _rel_case(_st)
        check("★★★ 作业是 %s ⇒ 不拆、不置 released、规则与会话文件都在" % _st,
              _rel_state(_dd) == mod.ST_RELEASING and len(_dd.nft.rules) == 1
              and os.path.exists(_sf)
              and not [e for e in _ev if e["event"] == "released"],
              "state=%r 规则=%d 文件在=%s"
              % (_rel_state(_dd), len(_dd.nft.rules), os.path.exists(_sf)))
        check("   ★ 而它**再试了一次** scancel（第一次不节流）",
              _dd.slurm.cancels == [("7001", "release_waiting")],
              str(_dd.slurm.cancels))

    # ── 30.3 ★★ `JOB_OK` 但拿不到详情 ⇒ 也不拆 ─────────────────────────────
    #
    # 真 `job_state()` 有这么一条路：`scontrol` 查不到详情、而 `squeue` 说它还在
    # 队列里 ⇒ 回 `(JOB_OK, {})`。**它是"还在"，不是"没了"** —— 把空 dict 当成
    # "没有作业状态 ⇒ 结束了"，形态与"非终态被当成终态"一模一样。
    _dd, _ev, _sf = _rel_case("{}")
    check("★★ `JOB_OK` 但拿不到详情（在队列里）⇒ 不拆",
          _rel_state(_dd) == mod.ST_RELEASING and len(_dd.nft.rules) == 1,
          "state=%r" % _rel_state(_dd))

    # ── 30.4 ★★★ 真停了才拆 ────────────────────────────────────────────────
    _dd, _ev, _sf = _rel_case("missing")
    check("★★★ `JOB_MISSING`（确认不存在）⇒ 才拆",
          _rel_state(_dd) == mod.ST_RELEASED and not os.path.exists(_sf)
          and len(_dd.nft.rules) == 0,
          "state=%r 规则=%d 文件在=%s"
          % (_rel_state(_dd), len(_dd.nft.rules), os.path.exists(_sf)))
    check("   ★ 而确认不存在时**不必**再 scancel（省掉一次无意义的 fork）",
          _dd.slurm.cancels == [], str(_dd.slurm.cancels))
    check("   拆完仍然记 `released` 与那条规则被删的审计",
          [e["event"] for e in _ev].count("released") == 1
          and any(e["event"] == "acl_removed" for e in _ev),
          str([e["event"] for e in _ev]))

    for _st in ("COMPLETED", "CANCELLED", "FAILED", "OUT_OF_MEMORY"):
        _dd, _ev, _sf = _rel_case(_st)
        check("★★ 真终态 %s ⇒ 拆" % _st,
              _rel_state(_dd) == mod.ST_RELEASED and not os.path.exists(_sf),
              "state=%r" % _rel_state(_dd))

    # ── 30.4b 拆完之后，每一个**按 session_id 记账的表**都要清干净 ────────────
    #
    # ★ 为什么这一条值得单独钉：那张名册是**唯一**一处（见 phase_release 里那段
    #   注释），而漏加一个表的症状是"跑几个月之后内存慢慢涨"—— 它指不回任何一行，
    #   也没有别的东西会因此变红。F28 往里加了第五个表，所以这里钉一次。
    _dd, _ev, _sf = _rel_case("RUNNING")
    _FIVE = ("job_missing", "job_unknown", "job_stuck",
             "enroll_file_missing", "release_retry")
    for _n in _FIVE:
        getattr(_dd, _n)["s-rel"] = 1
    del _dd.slurm.jobs["7001"]              # 作业现在真的没了
    _dd.tick()
    check("★★ 拆完之后 %d 个按 session_id 记账的表**全都**清空了"
          "（漏一个 = 内存无上限地涨，而它指不回任何一行）" % len(_FIVE),
          _rel_state(_dd) == mod.ST_RELEASED
          and not [n for n in _FIVE if "s-rel" in getattr(_dd, n)],
          "state=%r / 还留着的：%s"
          % (_rel_state(_dd), [n for n in _FIVE if "s-rel" in getattr(_dd, n)]))

    # ── 30.5 ★★ 重试与说话都节流，而**看一眼不节流** ────────────────────────
    #
    # ★ 两边都不能少：
    #   · 不节流 ⇒ 一个杀不掉的作业让每个 tick 都 fork 一次 scancel + 写四行日志，
    #     而 releases 会停留几小时 ⇒ 一条**没有上限**的账单；
    #   · 把"看一眼"也节流 ⇒ 作业真的停了也要多等一个间隔才放行，于是**每一次
    #     正常的释放**都慢一拍。
    _dd, _ev, _sf = _rel_case("RUNNING")
    check("★★ 第一个 tick 就试过了一次（这一条钉住「第一次不节流」）",
          len(_dd.slurm.cancels) == 1, str(_dd.slurm.cancels))
    for _i in range(3):
        _rel_clock[0] += 1                      # 还没到 RELEASE_RETRY_SECONDS
        _dd.tick()
    check("★★ 间隔之内：**不再** scancel，也不再重复说话",
          len(_dd.slurm.cancels) == 1
          and len([e for e in _ev if e["event"] == "release_waiting"]) == 1,
          "scancel %d 次 / release_waiting %d 条"
          % (len(_dd.slurm.cancels),
             len([e for e in _ev if e["event"] == "release_waiting"])))
    _rel_clock[0] += mod.RELEASE_RETRY_SECONDS
    _dd.tick()
    check("★ 过了间隔 ⇒ 再试一次、再说一次",
          len(_dd.slurm.cancels) == 2
          and len([e for e in _ev if e["event"] == "release_waiting"]) == 2,
          "scancel %d 次" % len(_dd.slurm.cancels))
    # ★★ 而"看一眼"从来不被节流：上面那几个 tick 里，作业从 RUNNING 变成真终态
    #    的那一刻**同一 tick 就放行**，不许多等。
    _rel_clock[0] += 1
    _dd.slurm.jobs["7001"] = {"JobState": "CANCELLED", "Requeue": "0"}
    _dd.tick()
    check("★★★ 作业一真的停了就**立刻**放行 —— 「看一眼」不在节流窗口里"
          "（节流它等于让每一次正常释放都慢一个间隔）",
          _rel_state(_dd) == mod.ST_RELEASED, _rel_state(_dd))

    # ── 30.6 ★★ 没有 job_id 的 releasing 会话不能被闸卡住 ──────────────────
    #
    # ★★ 这一条顺带守着一条**崩溃路径**（写这一节时抓出来的）：`job_id` 为 NULL 的
    #    会话能走到 `releasing`（`op_goodbye` 只挡终态、不挡它），而
    #    `remove_session_file()` 若无条件拼 `"job-%d.json" % None` ⇒ `TypeError`
    #    从 `phase_release()` 里抛出去。`_run_tick()` 会捕获（守护进程不死），但同一个
    #    tick 里排在后面的 `phase_gc()` 与 `phase_push()` 全部不跑 ⇒ **所有用户的
    #    推送都停摆**，每 2 秒一次，而症状指不回那一行。
    # ★ 所以这里**显式接住异常并断言它没发生**：不接的话，那条变异让用例抛
    #   traceback 而不是报一条 `[FAIL]`，而"用例被打崩了"与"用例守住了"在输出上
    #   长得不一样（变异验证里最容易被读错的一种）。
    _dd = _mkd(startup_grace_seconds=0)
    _dd.nft, _dd.slurm = _NftRec(), _RelSlurm()
    _dd.audit = lambda *_a, **_k: None
    _add(_dd, "s-nojob", job_id=None, state=mod.ST_RELEASING)
    _boom = None
    try:
        _dd.tick()
    except Exception as _e:                                  # noqa: BLE001
        _boom = _e
    _rel_daemons.append(_dd)
    check("★★ 没有作业可查的 releasing 会话 ⇒ 直接拆（闸判的是作业，不是状态）",
          _boom is None and _dd.store.get("s-nojob")["state"] == mod.ST_RELEASED,
          "异常=%r state=%s" % (_boom, _dd.store.get("s-nojob")["state"]))
    check("★★ 而且这个 tick **没有抛异常** —— 它一抛，同一个 tick 里排在"
          " `phase_release` 后面的 gc 与推送就全都不跑了（所有用户的推送停摆）",
          _boom is None, repr(_boom))

    # ── 30.7 ★★ `note` 是**为什么走到这里**，不是**为什么可以拆** ──────────
    #
    # `begin_release` 的 reason 有四个（goodbye / orphaned / job_gone /
    # job_<状态>）。如果闸信了那个 reason（"job_gone ⇒ 作业已经没了，不必查"），
    # 那么 `phase_running` 判错一次 —— 或者作业在那一瞬间又被重新排队 ——
    # 就会拆掉一个**还在跑**的作业，而这一版新加的那道闸形同虚设。
    _dd, _ev, _sf = _rel_case("RUNNING", note="job_gone")
    check("★★ 就算 `note` 写着 `job_gone`，也要**自己查一遍**才能拆",
          _rel_state(_dd) == mod.ST_RELEASING and len(_dd.nft.rules) == 1,
          "state=%r" % _rel_state(_dd))

    # ── 30.8 ★★★ `goodbye`：取消失败时那句话必须说出来（F12）──────────────
    #
    # ★ 形状是**承重的**：仍然 `ok:true`、仍然是 `releasing` —— 这条请求**被受理
    #   了**（会话进了释放流程，守护进程会一直重试）。回 `ok:false` 会说成"你的
    #   动作没生效"，而它生效了、只是没做完。所以这一节同时钉两件事：
    #   ① 失败**不许静默**；② 失败**不许被说成失败**。
    _dd = _mkd(startup_grace_seconds=0)
    _dd.nft, _dd.slurm = _NftRec(), _RelSlurm()
    _ev8 = []
    _dd.audit = lambda e, **kw: _ev8.append(dict(kw, event=e))
    _add(_dd, "s-gb", job_id="7002")
    _dd.slurm.cancel_ok = False
    _r8 = _dd.dispatch(UID, os.getgid(), {"op": "goodbye", "session_id": "s-gb"})
    _rel_daemons.append(_dd)
    _w8 = (_r8.get("data") or {}).get("warning")
    check("★★★ scancel 失败 ⇒ `ok:true` **且**带一句 `warning`"
          "（从前它照样回一个干净的 ok —— 用户与客户端都会把它读成"
          "「作业停了」）",
          _r8.get("ok") is True and isinstance(_w8, str) and _w8,
          "ok=%r warning=%r" % (_r8.get("ok"), _w8))
    check("★★ 形状是「已受理」：状态仍然是 releasing，不是错误、也不是终态",
          (_r8.get("data") or {}).get("state") == mod.ST_RELEASING
          and _dd.store.get("s-gb")["state"] == mod.ST_RELEASING,
          str(_r8.get("data")))
    check("★★ 那句话说的是**接下来会怎样**，而不是一个没核对过的诊断 —— "
          "「作业可能还在跑」是**猜**的（作业也可能刚刚正常结束，scancel 报的"
          "只是「没有这个作业」）",
          "重试" in _w8 and "还在跑" not in _w8 and "仍在运行" not in _w8,
          _w8)
    check("★ 失败单独记一条审计（`goodbye` 那条只说明「用户要结束」，"
          "这一条说明「这一次没做成」—— 两件事）",
          [e["event"] for e in _ev8].count("cancel_failed") == 1
          and [e["event"] for e in _ev8].count("goodbye") == 1,
          str([e["event"] for e in _ev8]))

    # 成功那一条：**不许**出现 warning（一个永远带着警告的字段等于没有字段）。
    _dd = _mkd(startup_grace_seconds=0)
    _dd.nft, _dd.slurm = _NftRec(), _RelSlurm()
    _dd.audit = lambda *_a, **_k: None
    _add(_dd, "s-gb2", job_id="7003")
    _r8b = _dd.dispatch(UID, os.getgid(), {"op": "goodbye", "session_id": "s-gb2"})
    _rel_daemons.append(_dd)
    check("★ scancel 成功 ⇒ 响应里**没有** `warning` 那一格",
          _r8b.get("ok") is True
          and "warning" not in (_r8b.get("data") or {})
          and _dd.slurm.cancels == [("7003", "goodbye")],
          "%r / %s" % (_r8b.get("data"), _dd.slurm.cancels))
    # 幂等：已经是终态的会话照原样回，不碰作业。
    _dd.store.update("s-gb2", state=mod.ST_RELEASED)
    _dd.slurm.cancels = []
    _r8c = _dd.dispatch(UID, os.getgid(), {"op": "goodbye", "session_id": "s-gb2"})
    check("★ 已经是终态 ⇒ 原样返回那个终态，**不碰作业**（幂等）",
          (_r8c.get("data") or {}).get("state") == mod.ST_RELEASED
          and _dd.slurm.cancels == [] and "warning" not in (_r8c.get("data") or {}),
          str(_r8c.get("data")))

    # ── 30.9 ★★ 跨文件：那句话**四端**都要在 ─────────────────────────────
    #
    # `warning` 这个字段**存在的唯一理由就是被显示出来**（PROTOCOL.md 自己写的）。
    # 服务端发了而某一端不读，它就只有读代码的人知道。四端都判 ——
    # 只判一边的话，另一边删掉不会有任何东西变红（而这一格**已经有三个**消费者：
    # 图形界面、命令行、以及"换一门语言重写客户端"的那个人读的文档）。
    _sess_src = io.open(os.path.join(HERE, os.pardir, "client", "src", "main",
                                     "session.js"), encoding="utf-8").read()
    _proto_src = io.open(os.path.join(HERE, os.pardir, "docs", "PROTOCOL.md"),
                         encoding="utf-8").read()
    _daemon_src = io.open(os.path.join(HERE, "slurmate-sessiond"),
                          encoding="utf-8").read()
    _ends = [("守护进程发", 'data["warning"]' in _daemon_src),
             # ★★ 判据必须是**这一条路**读它的那个写法，不能只查 "resp.data.warning"
             #    —— 那个字符串在 `session.js` 里**本来就出现过**（`submit` 那条路
             #    早就在读同一个字段），所以查它是一条永远绿的空断言。
             #    （实测：把 `stop()` 里那一行改成 `const w = null;`，那种判据不红。）
             ("客户端读", "resp.data && resp.data.warning" in _sess_src),
             ("文档写明", "`data.warning`" in _proto_src)]
    check("★★ 三端都在：守护进程发 `warning`、客户端读 `data.warning`、"
          "文档列了它",
          all(_ok for _n, _ok in _ends),
          "、".join("%s=%s" % (_n, _ok) for _n, _ok in _ends))

    # ★★ 命令行那一端**真跑一遍**，不查源码 —— 第四端是"用户真的看得见"，
    #    而"源码里出现过 `warning` 这个词"在 `slurmate` 里**本来就成立**
    #    （`cmd_doctor` 早就在打另一个 warning），所以那种判据是一条永远绿的空断言。
    _cli30 = load_cli()

    class _Args(object):
        json = False

    _cli30.call = lambda req, asjson, timeout=20.0: {
        "ok": True, "code": 0,
        "data": {"state": "releasing", "warning": "这一句必须被显示出来"}}
    _so, _se = io.StringIO(), io.StringIO()
    _old_std = (sys.stdout, sys.stderr)
    try:
        sys.stdout, sys.stderr = _so, _se
        _rc30 = _cli30._simple({"op": "goodbye"}, _Args(), "已请求释放会话")
    finally:
        sys.stdout, sys.stderr = _old_std
    check("★★ `slurmate`（命令行也是客户端）真的把那句话打出来了 —— "
          "协议里这个字段存在的唯一理由就是被显示出来",
          _rc30 == 0 and "这一句必须被显示出来" in _se.getvalue(),
          "退出码=%r stderr=%r" % (_rc30, _se.getvalue()))

    # ══ 31. 所有的终态都过同一道闸（v0.11 阶段 7：账本 F32），以及
    #         「排队」那一档要的是一个**不同的** TTL（F27）══════════════════
    #
    # ★★ F32 与 F12/F13 **完全同形**，只是绕开闸的姿势不同：`reject()` 与
    #    `try_enroll()` 的超时那一条**自己跳到终态**，各自 `scancel` 一次而
    #    **返回值丢掉** ⇒ `scancel` 失败时作业继续占着节点跑到 `TimeLimit`
    #    （GPU 分区上那是 12 小时实打实的算力），而那条会话不在
    #    `phase_running()` 的扫描集合里、也不在 `ACL_STATES` 里
    #    ⇒ **再也没有任何人回收它**。
    #
    # ★ 这一节钉**两半**，两半都承重：
    #   ① **过闸**：作业还在 ⇒ 会话停在 `releasing`、什么都不拆、一直重试；
    #   ② **落回各自的终态**：确认停了之后，`rejected` 与 `expired` **不许**被压成
    #      `released`（"校验没过" / "提交超时" / "正常结束"是三件不同的事）。
    #   只判①的话，"自己跳终态 + 顺手 scancel"也能写出①看起来通过的样子；
    #   只判②的话，一条把拆除提到闸前面的实现照样绿。
    #
    # ★★ F27 的形状是**一个矩阵**，不是一条：两条 TTL 的判据是
    #    「会话还在 `submitted`」**并且**「作业在做什么」，四个格子缺一不可 ——
    #    尤其 **`submitted` + 排队 + 等了 2400 秒 ⇒ 一个字都不许动** 那一格：
    #    少了它，"拿 1800 秒一刀切"那个**错的**修法会全绿。
    print("\n── 31. 终态都过同一道闸（F32）/ 排队那一档的 TTL（F27）──")

    check("★ 两个 TTL 都是**常量**而不是配置键（与 RELEASE_RETRY_SECONDS 同族），"
          "而且排队那个**明显更长** —— 这一条挡的是「合成一个数」那种修法",
          mod.ENROLL_TTL == 1800 and mod.QUEUED_TTL > mod.ENROLL_TTL * 10
          and "enroll_ttl_seconds" not in mod.GLOBAL_KEYS
          and "queued_ttl_seconds" not in mod.GLOBAL_KEYS
          and cfg.enroll_ttl == mod.ENROLL_TTL
          and cfg.queued_ttl == mod.QUEUED_TTL,
          "enroll=%s queued=%s" % (getattr(mod, "ENROLL_TTL", "★没有"),
                                   getattr(mod, "QUEUED_TTL", "★没有")))

    def _final_case(sid, job_id, *, state=None, waited=0, job_state="PENDING",
                    cancel_ok=True, with_file=False, with_rule=False):
        """造一条会话，时钟拨到 `waited` 秒之前提交。返回 `(daemon, 事件表)`。

        `with_file`：写一份**真的**会话文件（`job_id` 故意对不上 ⇒ 校验会拒）。
        `with_rule`：装一条 nft 规则并写上 node_ip / service_port。

        ★ 这两个开关**分开**：`reject` 那条路要的是文件（它就是写了文件才被拒的），
          而"规则"那一格对应的是**进程在装完规则、写状态之间死过**那个窗口 ——
          而它正是 F32 记的第二条后果（`reconcile()` 把那条规则当孤儿删掉，
          于是用户连"它还在烧"都看不见）。
        ★ `last_hb_socket` 必须写：`phase_heartbeat()` 扫 ENROLLED 的会话，
          不写的话一条"很久以前登记、作业在排队"的会话会先因为心跳超时被判成
          孤儿 —— 那是**另一条**路（300/1800 秒），会把这条用例要测的东西盖掉。
        """
        dd = _mkd(startup_grace_seconds=0)
        dd.nft, dd.slurm = _NftRec(), _RelSlurm()
        dd.slurm.cancel_ok = cancel_ok
        dd.slurm.jobs[str(job_id)] = {"JobState": job_state, "Requeue": "0"}
        ev = []
        dd.audit = lambda e, **kw: ev.append(dict(kw, event=e))
        dd.store.insert(
            session_id=sid, uid=UID, user="alice", partition="A6000",
            account="acct", cpus=2, mem="8G", requested_time="1:00:00",
            state=state or mod.ST_SUBMITTED, job_id=job_id, candidates="55001",
            created_at=_rel_clock[0] - waited,
            submitted_at=_rel_clock[0] - waited,
            last_hb_socket=_rel_clock[0])
        if with_rule:
            dd.store.update(sid, node_ip="192.0.2.11", service_port=55001)
            dd.nft.add_session_rule("192.0.2.11", 55001, UID, job_id)
        if with_file:
            # ★ 用**真的**文件，不打桩 `validate_session`：这条路的重点之一是
            #   "拒绝之后会对那份文件做什么"（今天它**永远**留在用户家目录里 ——
            #   没有任何人删它），打桩会把要验的东西一起打掉。
            _p = os.path.join(sess_dir, "job-%s.json" % job_id)
            with io.open(_p, "w", encoding="utf-8") as _f:
                _f.write(json.dumps({"schema": mod.SCHEMA_VERSION,
                                     "job_id": int(job_id) + 1}))
            os.chmod(_p, 0o600)
        _rel_daemons.append(dd)
        return dd, ev

    def _st_of(dd, sid):
        return dd.store.get(sid)["state"]

    # ── 31.1 ★★★ F32 · reject：作业还在 ⇒ 过不了闸，什么都不拆 ────────────
    #
    # 这里刻意**直接调 `phase_running()`**，不走 `tick()`：那个窗口（装完规则、
    # 写状态之前进程死掉）留下的就是"一条 `submitted` 的会话 + 一条真的规则"，
    # 而 `reconcile()` 在同一个 tick 里跑在 `phase_running()` **前面** —— 那时
    # 会话还是 `submitted`，规则会被当孤儿删掉，于是"规则一条都没少"这条断言
    # 测的是一条**本来就不存在**的规则。先让它进 `releasing`，再看下一个完整
    # tick 里 `reconcile()` 认不认它。
    _rj, _rev = _final_case("s-rj", 8101, job_state="RUNNING",
                            cancel_ok=False, with_file=True, with_rule=True)
    _rj.phase_running()
    check("★★★ 校验失败 ⇒ 会话进 `releasing`，**不是**直接跳 `rejected`"
          "（跳过去就再也没人回收它 —— 那正是 F32）",
          _st_of(_rj, "s-rj") == mod.ST_RELEASING,
          "state=%r" % _st_of(_rj, "s-rj"))
    check("★★ 而这一刻**一个字都还没拆**：规则在、会话文件在",
          len(_rj.nft.rules) == 1
          and os.path.exists(os.path.join(sess_dir, "job-8101.json")),
          "规则=%s 文件在=%s" % (sorted(_rj.nft.rules),
                                os.path.exists(os.path.join(sess_dir, "job-8101.json"))))
    check("★ 拒绝那一刻的两条审计分开记：「判定拒绝了」与「交给释放流程了」"
          "是两件事",
          [e["event"] for e in _rev].count("rejected") == 1
          and [e["event"] for e in _rev].count("releasing") == 1,
          str([e["event"] for e in _rev]))

    # 完整 tick：reconcile + phase_release 都跑。作业**还在跑**、`scancel` 又失败
    # ⇒ 闸不许放行。
    _rj.slurm.cancel_ok = False
    _rj.tick()
    check("★★★ `scancel` 失败 + 作业仍在跑 ⇒ **留在 `releasing`**，"
          "不许进终态（从前这里已经是 `rejected` 了，而作业还在烧）",
          _st_of(_rj, "s-rj") == mod.ST_RELEASING, _st_of(_rj, "s-rj"))
    check("★★ 而规则一条都没少 —— 会话现在是 `releasing`（在 `ACL_STATES` 里），"
          "`reconcile()` **不再**把它当孤儿（从前 `rejected` 不在那一族里，"
          "于是用户连「它还在烧」都看不见）",
          len(_rj.nft.rules) == 1, str(sorted(_rj.nft.rules)))
    check("★★ 会话文件也还在（作业还活着，用户仍然连得进去、看得见它）",
          os.path.exists(os.path.join(sess_dir, "job-8101.json")),
          str(sorted(os.listdir(sess_dir))[:6]))
    check("★★ 而它**说得出来**：这条释放卡在「作业还在」上",
          any(e["event"] == "release_waiting" and e.get("why") == "alive"
              for e in _rev),
          str([e["event"] for e in _rev]))
    check("★ `scancel` 是**那道闸**发的（reason=`release_waiting`），"
          "不再是 `reject()` 自己顺手发一次 —— 一个判据一处实现",
          _rj.slurm.cancels and all(r == "release_waiting"
                                    for _j, r in _rj.slurm.cancels),
          str(_rj.slurm.cancels))

    # 作业确认没了 ⇒ 才拆，而且**落回 `rejected`**
    _rj.slurm.jobs.pop("8101")
    _rj.tick()
    check("★★★ 作业确认消失 ⇒ 拆完**落回 `rejected`**，不是 `released`"
          "（「校验没过」与「正常结束」是两件不同的事）",
          _st_of(_rj, "s-rj") == mod.ST_REJECTED, _st_of(_rj, "s-rj"))
    check("★★ 而拆是真拆：规则没了、会话文件也没了"
          "（从前那份文件**永远**留在用户家目录里 —— 没有任何人删它）",
          len(_rj.nft.rules) == 0
          and not os.path.exists(os.path.join(sess_dir, "job-8101.json")),
          "规则=%s 文件在=%s" % (sorted(_rj.nft.rules),
                                os.path.exists(os.path.join(sess_dir, "job-8101.json"))))
    _rel_ev = [e for e in _rev if e["event"] == "released"]
    check("★★ 审计那条 `released` 带着 `state`：事件名说的是「拆除做完了」，"
          "而它落进哪一个终态要看得见（否则 `rejected` 与 `released` 在审计里"
          "分不开）",
          len(_rel_ev) == 1 and _rel_ev[0].get("state") == mod.ST_REJECTED
          and _rel_ev[0].get("reason") == "job_id_mismatch",
          str(_rel_ev))

    # ── 31.2 ★★ F32 · 登记超时：同一条路、同一个闸，落回 `expired` ────────
    #
    # ★ 判据里带着"等待时间只有 1801 秒"：它逼着这条走 `ENROLL_TTL` 而不是
    #   `QUEUED_TTL`（后者是 86400）。两个数合成一个的话这一条仍然会过，而
    #   下面 31.3 的第一格会红 —— 两格一起才钉得住"分两档"。
    # ★ 与 31.1 逐条对称，包括"先直接调 `phase_running()`"那一步 —— 两条路都要
    #   各自证一遍**过闸**与**落回自己的名字**这两半，缺一条就有半边没人看。
    _en, _eev = _final_case("s-en", 8201, waited=mod.ENROLL_TTL + 1,
                            job_state="RUNNING", cancel_ok=False, with_rule=True)
    _en.phase_running()
    check("★★★ 作业**在跑**、而会话文件迟迟不来、已等 %d 秒 ⇒ 进 `releasing`"
          "（用的是 `enroll_ttl`，不是排队那个）" % (mod.ENROLL_TTL + 1),
          _st_of(_en, "s-en") == mod.ST_RELEASING, _st_of(_en, "s-en"))
    check("   而它的理由说的是**登记超时**，不是排队超时",
          any(e["event"] == "expired" and e.get("reason") == "enroll_timeout"
              for e in _eev)
          and not any(e.get("reason") == "queued_timeout" for e in _eev),
          str([(e["event"], e.get("reason")) for e in _eev]))
    check("★★ 而这一刻**一个字都还没拆**：规则还在",
          len(_en.nft.rules) == 1, str(sorted(_en.nft.rules)))
    _en.tick()
    check("★★★ `scancel` 失败 + 作业仍在跑 ⇒ 留在 `releasing`、规则一条都没少"
          "（与 31.1 那一条对称 —— 两条路各证一遍）",
          _st_of(_en, "s-en") == mod.ST_RELEASING and len(_en.nft.rules) == 1,
          "state=%r 规则=%s" % (_st_of(_en, "s-en"), sorted(_en.nft.rules)))
    _en.slurm.jobs.pop("8201")
    _en.tick()
    check("★★ 作业确认消失 ⇒ 落回 `expired`（与 `rejected` 一样过闸，"
          "但**名字各留各的**）",
          _st_of(_en, "s-en") == mod.ST_EXPIRED, _st_of(_en, "s-en"))

    # ── 31.3 ★★★ F27 · 两个 TTL 的矩阵 ──────────────────────────────────
    #
    # ★★ 第一格是**这一整节里最重要的那一条**：会话停在 `submitted`、作业在排队、
    #    已经等了 2400 秒（**超过 `enroll_ttl` 的 1800，远不到 `queued_ttl`**）
    #    ⇒ **一个字都不许动**。少了它，"拿 1800 秒一刀切"那个修法全绿 ——
    #    而那个修法在繁忙集群上的形态是"守护进程自动取消用户正在排队的作业"。
    _q1, _q1ev = _final_case("s-q1", 8301, waited=mod.ENROLL_TTL + 600,
                             job_state="PENDING")
    _q1.tick()
    check("★★★ 排队中、等了 %d 秒（超过 `enroll_ttl`、远不到 `queued_ttl`）"
          "⇒ **一个字都不许动** —— 排队是集群的正常状态，拿 1800 秒去收它"
          "等于自动取消用户在排队的作业"
          % (mod.ENROLL_TTL + 600),
          _st_of(_q1, "s-q1") == mod.ST_SUBMITTED
          and not [e for e in _q1ev
                   if e["event"] in ("expired", "releasing", "released")],
          "state=%r 事件=%s" % (_st_of(_q1, "s-q1"),
                               str([e["event"] for e in _q1ev])))
    check("   而它**确实占着**一个名额 —— 这正是它必须有 TTL 的理由"
          "（`OCCUPYING_STATES` 含 `submitted`）",
          _q1.store.count_occupying(UID) == 1,
          str(_q1.store.count_occupying(UID)))

    _q2, _q2ev = _final_case("s-q2", 8302, waited=mod.QUEUED_TTL + 1,
                             job_state="PENDING")
    _q2.tick()
    check("★★★ 排队中、等了 %d 秒（超过 `queued_ttl`）⇒ 才回收"
          % (mod.QUEUED_TTL + 1),
          _st_of(_q2, "s-q2") == mod.ST_RELEASING, _st_of(_q2, "s-q2"))
    check("   理由说的是**排队超时**，而且带着等了多久与作业当时的状态"
          "（否则运维只知道它没了，不知道为什么）",
          any(e["event"] == "expired" and e.get("reason") == "queued_timeout"
              and e.get("job_state") == "PENDING"
              and e.get("seconds") == mod.QUEUED_TTL + 1 for e in _q2ev),
          str([(e["event"], e.get("reason"), e.get("seconds")) for e in _q2ev]))
    check("   而 `scancel` 走的是**那道闸**（这条会话的作业还在排队，"
          "闸不许放行 ⇒ 先取消再等它真的消失）",
          _q2.slurm.cancels == [("8302", "release_waiting")]
          and _st_of(_q2, "s-q2") == mod.ST_RELEASING,
          "%s / %s" % (_q2.slurm.cancels, _st_of(_q2, "s-q2")))
    _q2.slurm.jobs.pop("8302")
    _q2.tick()
    check("   作业确认消失 ⇒ 落回 `expired`",
          _st_of(_q2, "s-q2") == mod.ST_EXPIRED, _st_of(_q2, "s-q2"))

    # ★ 矩阵的第四格：**已经登记过**的会话，作业被挂起/重排 ⇒ 永远不回收。
    #   它是"判据必须两件事一起"里少了 `submitted` 那一半的对照 ——
    #   那半条丢了的话，一条**用户正在用**、只是作业被挂起的会话会被收掉。
    _q3, _q3ev = _final_case("s-q3", 8303, state=mod.ST_ENROLLED,
                             waited=mod.QUEUED_TTL * 3, job_state="SUSPENDED")
    _q3.tick()
    check("★★★ 已登记的会话、作业被挂起、等了三天 ⇒ **不回收**"
          "（它登记过 —— 用户在用它，只是作业被挂起了）",
          _st_of(_q3, "s-q3") == mod.ST_ENROLLED
          and not [e for e in _q3ev
                   if e["event"] in ("expired", "releasing", "released")],
          "state=%r 事件=%s" % (_st_of(_q3, "s-q3"),
                               str([e["event"] for e in _q3ev])))

    # ── 31.4 ★★ 没有 `final_state` 的行仍然是 `released`（回落那一格）──────
    #
    # 第 30 节那十几条 `releasing` 的用例**都是**这种行（它们直接插成
    # `releasing`、没有走过 `begin_release`），所以"回落"其实已经被 30.4 钉住了。
    # 这一条只说清**为什么**它可以回落：`final_state` 只在 `releasing` 期间被读，
    # 而三选一里 `released` 是唯一一个**不含判断**的答案。
    _fb, _fbev = _final_case("s-fb", 8401, job_state="RUNNING")
    _fb.begin_release(_fb.store.get("s-fb"), "goodbye")      # 缺省 final_state
    _fb.slurm.jobs.pop("8401")
    _fb.tick()
    check("★ `begin_release` 的缺省仍然是 `released`（goodbye / orphaned / "
          "job_gone / job_<状态> 四条路一个字都不用改）",
          _st_of(_fb, "s-fb") == mod.ST_RELEASED, _st_of(_fb, "s-fb"))

    mod.now_ts = _rel_real_now
    # ── 32. 热重载（v0.12 阶段 3）────────────────────────────────────────────
    #
    # ★★ 这一节的判据**不是**「新值读进来了」—— 那个太弱：一个「重读 + 重启」的
    #   实现照样满足它，而它把所有人的会话断一次。真正要钉的是三件事：
    #     · 新值生效了，而**进程还是同一个**（同一个 store 句柄、同一条连接 ——
    #       重启的话这些全都会换掉）；
    #     · 校验或可热性不过 ⇒ **一个字都不改**（旧值仍是旧值）；
    #     · 插件目录变了 ⇒ 重载之后**不用重启就能用**。
    print("\n── 32. 热重载（v0.12 阶段 3）──")

    # 32.1 ★★ 那张表必须**覆盖每一个配置键**
    #
    # ★ 它是这一版的承重件：漏登记一个键，那个键就落进 `_changed_keys_by_class`
    #   的缺省档（COLD，见那里的说明）—— 行为是保守的，但「哪一个键属于哪一档」
    #   不该由「有没有人记得」决定。多一个不存在的键同样是错：那说明表在描述一个
    #   已经删掉的键，而读表的人会以为它还在。
    check("★★ 可热重载表覆盖**每一个**配置键（多一个、少一个都红）",
          set(mod.RELOAD_CLASS) == set(mod.GLOBAL_KEYS),
          "表里多了 %s / 少了 %s"
          % (sorted(set(mod.RELOAD_CLASS) - set(mod.GLOBAL_KEYS)),
             sorted(set(mod.GLOBAL_KEYS) - set(mod.RELOAD_CLASS))))
    check("★ 而三档**都真的用到了**（空着一档说明分档没做）",
          set(mod.RELOAD_CLASS.values()) == {mod.RELOAD_HOT, mod.RELOAD_NOTICE,
                                             mod.RELOAD_COLD},
          str(sorted(set(mod.RELOAD_CLASS.values()))))

    # ── 这一节的两件基础设施 ────────────────────────────────────────────────
    #
    # ① 一个**真的记得规则集**的 nft 替身。它只接管「命令执行」，不接管 `Nft`
    #    对象本身 —— 因为 32.8 要验的正是 `ensure()` **按值比对**那一段：先读出
    #    那条基础规则的**网段**，与配置比，不同才删旧插新。只记「删了哪些
    #    comment」的替身会把「读出来的是什么」抹掉，而那一步恰是被测的东西。
    class _NftSim(object):

        def __init__(self):
            self.rules = []            # [{"h": 句柄, "text": 规则原文}]
            self._h = 0

        def _render(self, with_handle):
            out = []
            for r in self.rules:
                ln = "        " + r["text"]
                if with_handle:
                    ln += " # handle %d" % r["h"]
                out.append(ln)
            return ("\n".join(out) + "\n") if out else ""

        def _nft(self, args, check=False, timeout=10):
            a = list(args)
            with_h = a[:1] == ["-a"]
            if with_h:
                a = a[1:]
            if a[:2] == ["list", "table"]:
                return 0, "", ""
            if a[:2] in (["add", "table"], ["add", "chain"]):
                return 0, "", ""
            if a[:2] == ["list", "chain"]:
                return 0, self._render(with_h), ""
            if a[:2] == ["insert", "rule"]:
                self._h += 1
                self.rules.insert(0, {
                    "h": self._h,
                    "text": " ".join(a[4:-2]) + ' comment "%s"' % a[-1]})
                return 0, "", ""
            if a[:2] == ["delete", "rule"]:
                h = int(a[-1])
                self.rules = [r for r in self.rules if r["h"] != h]
                return 0, "", ""
            return 0, "", ""

        def cidr(self):
            """现在那条基础规则里的网段（没有那条规则 ⇒ None）。"""
            return mod.Nft.base_offcluster_cidr(self._render(True))

    _nftsim = _NftSim()

    # ② 这一节自己的**插件目录**：`default_plugins_dir()` 是模块级的，而
    #    `reload_config()` 内部会重新 `Config(path)` ⇒ 它必须在**整个 reload
    #    期间**都指向这里，否则重扫的是真插件目录而不是本节的。整节包在
    #    try/finally 里，就是为了这个。
    _RL = os.path.join(tmpdir, "reload-plugins")
    os.makedirs(_RL, exist_ok=True)
    _RU1 = "01M2JKHTZGKJBFQQTWYXMQMF70"
    _RU2 = "01M2JKHTZGKJBFQQTWYXMQMF71"

    def _rl_pkg(uid, name):
        install_package(_RL, [("plugin.json", json.dumps(
            {"id": uid, "name": name, "version": "1.0.0",
             "site": {"defaultCpus": 1, "defaultMem": "1G"}}).encode("utf-8"))])

    _rl_pkg(_RU1, "alpha")
    _seq_rl = [0]
    _rl_ds = []

    # 这一节问 Slurm 用的**桩**（整节替换 `mod.run_cmd`，见下面那一段）。
    # ★ 喂**一个**节点，于是这一节里所有配置的 `cluster_cidr` 都必须是
    #   `192.0.2.0/24` —— 那正是它们本来就写的值（32.8 改成了 `192.0.0.0/16`，
    #   仍然覆盖它；32.14 故意改成不覆盖它的那个，用来测「改错了会被拦住」）。
    def _rl_nodes_stub(argv, timeout=10, check=False):
        if "show node" in " ".join(str(a) for a in argv):
            return 0, "NodeName=nA NodeAddr=192.0.2.11 State=IDLE\n", ""
        return 1, "", "unexpected"

    def _mk_reload_d(cpath):
        """一个**能从盘上那份配置重读**的守护进程（这一节专用）。

        ★ 与 `_mkd`（26 节）的差别在**配置的来源**：那个克隆的是内存里那个对象
          （没有 `path` / `raw`），而热重载的全部工作就是「从 `path` 再读一遍」。
        ★ 部件用**真的**（Nft / Slurm / Cluster）：32.3 有一条判据是「每一个按
          引用拿着配置的部件都换成了同一份新的」，而它靠的正是它们**真的有
          `cfg` 属性**。只有 nft 的**命令执行**被换掉。
        """
        _seq_rl[0] += 1
        c = mod.Config(cpath)
        c.state_dir = os.path.join(tmpdir, "rl-state")
        c.log_dir = os.path.join(tmpdir, "rl-log")
        c.audit_log = os.path.join(c.log_dir, "audit.log")
        c.db_path = os.path.join(tmpdir, "rl-%d.db" % _seq_rl[0])
        os.makedirs(c.state_dir, exist_ok=True)
        os.makedirs(c.log_dir, exist_ok=True)
        dd = mod.Sessiond(c)
        dd.nft._nft = _nftsim._nft
        dd.audit_fp = None
        dd.user_home = lambda uid: home
        _rl_ds.append(dd)
        return dd

    _saved_rl_dir = mod.default_plugins_dir
    _saved_rl_run = mod.run_cmd
    mod.default_plugins_dir = lambda: _RL
    # ★★ 这一节里问 Slurm 的命令**一律走桩**（这一节真的会问）：
    #    热重载现在会跑 `crosscheck_cidr()`，而 `_do_reload()` 还会跑
    #    `announce_config_state()` —— 后者里那条 GRES 对账要 `scontrol show node -o`。
    #    ★ 不换的话，用例的结论取决于"跑它的那台机器上有没有真的 `scontrol`、
    #      以及那个集群的节点地址长什么样"：开发会话恰好跑在一个真集群的**计算
    #      节点**上，于是同一条用例在开发机上红、在 CI 上绿（或者反过来）——
    #      17 节里那条注释记的正是**同一条**教训。而这一节要考的从来不是集群事实。
    #    ★ 一个注入点就够：`run_cmd` 正是 `Slurm` / `crosscheck_cidr()` /
    #      `gres_catalog()` 共用的那一处。各留一个注入点的话，哪天新加一个读者
    #      就会悄悄漏掉一个 —— 而"漏一个"正是 F45 的形状。
    mod.run_cmd = _rl_nodes_stub
    # ★ 这一节里 `Config` 也要 `resolve_bin()` 解析得到那八个 Slurm 命令 ——
    #   那是 `main()` 开头那个 **PATH 桩**给的（`_stub_slurm_bins`），
    #   不是"这台机器上真装了什么"。少了它，这一节在裸的 CI 上会因为
    #   「配置自检有 8 处问题」而让热重载**整份被拒**，四十多条断言连锁红。
    try:
        # 32.2 ★ `changed_*_keys`：判据是**配置里写了什么**
        #
        # ★ 比的是 `Config.raw`，不是解析出来的属性 —— 留空表示「去 PATH 上找」
        #   的那几格命令路径，属性值可能一模一样而配置**真的变了**。
        _cf_a = write_conf("cluster_cidr = 192.0.2.0/24\n"
                           "range_start = 55001\nrange_end = 55099\n"
                           "max_sessions_per_user = 2\n", "rl-a.conf")
        _cf_b = write_conf("cluster_cidr = 198.51.100.0/24\n"
                           "range_start = 55001\nrange_end = 55099\n"
                           "max_sessions_per_user = 2\n", "rl-b.conf")
        _cfg_a, _cfg_b = mod.Config(_cf_a), mod.Config(_cf_b)
        check("★★ 只改了 cluster_cidr ⇒ 它落在 NOTICE 档，而 COLD 档是空的",
              mod.changed_notice_keys(_cfg_a, _cfg_b) == ["cluster_cidr"]
              and mod.changed_cold_keys(_cfg_a, _cfg_b) == [],
              "%s / %s" % (mod.changed_notice_keys(_cfg_a, _cfg_b),
                           mod.changed_cold_keys(_cfg_a, _cfg_b)))
        check("★ 而「随时可热」那一档不报它（它确实会动到已经建立的东西）",
              "cluster_cidr" not in mod._changed_keys_by_class(
                  _cfg_a, _cfg_b, mod.RELOAD_HOT))
        check("★ 什么都没改 ⇒ 两档都是空的（不然每次 reload 都要说一堆废话）",
              mod.changed_notice_keys(_cfg_a, mod.Config(_cf_a)) == []
              and mod.changed_cold_keys(_cfg_a, mod.Config(_cf_a)) == [])
        _cf_c = write_conf("cluster_cidr = 192.0.2.0/24\n"
                           "range_start = 55001\nrange_end = 55099\n"
                           "max_sessions_per_user = 5\n", "rl-c.conf")
        check("★ 改了 max_sessions_per_user ⇒ **一个字都不说**（HOT 档只影响新发生的事）",
              mod.changed_notice_keys(_cfg_a, mod.Config(_cf_c)) == [])
        _cf_d = write_conf("cluster_cidr = 192.0.2.0/24\nreadonly_paths = /shared/home\n"
                           "range_start = 55001\nrange_end = 55099\n", "rl-d.conf")
        _cf_e = write_conf("cluster_cidr = 192.0.2.0/24\nreadonly_paths = /shared/other\n"
                           "range_start = 55001\nrange_end = 55099\n", "rl-e.conf")
        check("★★ 改了 readonly_paths ⇒ 落进 **COLD** 档（它只有重启才生效）",
              mod.changed_cold_keys(mod.Config(_cf_d), mod.Config(_cf_e))
              == ["readonly_paths"],
              str(mod.changed_cold_keys(mod.Config(_cf_d), mod.Config(_cf_e))))

        # 32.3 ★★ 改一个「随时可热」的键 ⇒ 生效，而**进程还是同一个**
        #
        # ★ 三条一起才是「没有重启」的证明：同一个 `Sessiond`、同一个 store 句柄、
        #   同一条连接 —— 而那条连接拿到的**也是新配置**（见下面那一条）。
        _LIVE = write_conf("cluster_cidr = 192.0.2.0/24\n"
                           "range_start = 55001\nrange_end = 55099\n"
                           "max_sessions_per_user = 2\n", "rl-live.conf")
        _d_hot = _mk_reload_d(_LIVE)
        _store0 = _d_hot.store
        _cli_live, _conn_live = _pair(_d_hot)
        check("（夹具）热重载用的守护进程起来了，并且连着一条连接",
              _d_hot.cfg.max_sessions_per_user == 2
              and _conn_live in _d_hot.conns(),
              str(_d_hot.conns()))

        with open(_LIVE, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.2.0/24\n"
                     "range_start = 55001\nrange_end = 55099\n"
                     "max_sessions_per_user = 5\n")
        _rl_ok, _rl_notes = _d_hot.reload_config()
        check("★★ 改一个 HOT 键 + 热重载 ⇒ 新值生效了",
              _rl_ok is True and _d_hot.cfg.max_sessions_per_user == 5,
              "ok=%s / 现值=%s" % (_rl_ok, _d_hot.cfg.max_sessions_per_user))
        check("★★ 而**进程还是同一个** —— 同一个 store 句柄、同一条连接还在",
              _d_hot.store is _store0 and _conn_live in _d_hot.conns(),
              "store 换了" if _d_hot.store is not _store0 else "连接没了")
        check("★ HOT 档**什么都不说**（notes 是空的）", _rl_notes == [], str(_rl_notes))
        check("★★ 而那条连接拿到的**也是新配置**（它按引用存着 cfg —— 只换"
              "`Sessiond` 自己那一份的话，症状是一半新一半旧，且没有东西会报错）",
              _conn_live.cfg is _d_hot.cfg,
              "%s / %s" % (id(_conn_live.cfg), id(_d_hot.cfg)))
        check("★★ 而且**每一个**按引用拿着配置的部件都换成了同一份"
              "（判据是「有没有 cfg 属性」，不是一张手抄的类名清单）",
              all(o.cfg is _d_hot.cfg for o in _d_hot._config_holders()),
              str([(type(o).__name__, o.cfg is _d_hot.cfg)
                   for o in _d_hot._config_holders()]))

        # 32.4 ★★ 改一个**必须重启**的键 ⇒ 整个 reload 拒绝，一个字都不改
        _COLD = write_conf("cluster_cidr = 192.0.2.0/24\n"
                           "range_start = 55001\nrange_end = 55099\n"
                           "readonly_paths = /shared/home\n"
                           "max_sessions_per_user = 2\n", "rl-cold.conf")
        _dc = _mk_reload_d(_COLD)
        with open(_COLD, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.2.0/24\n"
                     "range_start = 55001\nrange_end = 55099\n"
                     "readonly_paths = /shared/other\n"
                     "max_sessions_per_user = 7\n")
        _rl_ok, _rl_notes = _dc.reload_config()
        check("★★ 改了 readonly_paths ⇒ 热重载**整个拒绝**"
              "（用户拍的那条：校验不全过就一个字都不改）",
              _rl_ok is False and _rl_notes == [],
              "ok=%s notes=%s" % (_rl_ok, _rl_notes))
        check("★★ 而**连那个本来可以热的键也没被改** —— 这就是「整个拒绝」的意思"
              "（只拒绝那一个键的话，max_sessions_per_user 会悄悄变成 7）",
              _dc.cfg.max_sessions_per_user == 2
              and _dc.cfg.raw.get("readonly_paths") == "/shared/home",
              "%s / %s" % (_dc.cfg.max_sessions_per_user,
                           _dc.cfg.raw.get("readonly_paths")))

        # 32.5 ★★ 新配置**读不动** ⇒ 旧配置继续服务
        #
        # ★ 坏配置里那个配额特意写成 **4**（旧值是 3）：两个数**不同**，这条断言
        #   才真的在判"有没有被换掉"。写成同一个数的话，一个"部分采用"的实现
        #   照样绿，而这条用例会以"守住了"收场。
        _BAD = write_conf("cluster_cidr = 192.0.2.0/24\n"
                          "range_start = 55001\nrange_end = 55099\n"
                          "max_sessions_per_user = 3\n", "rl-bad.conf")
        _dbad = _mk_reload_d(_BAD)
        with open(_BAD, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.2.0/24\n"
                     "range_start = 55001\nrange_end = 55099\n"
                     "max_sessions_per_user = 4\n"
                     "[plugin:alpha]\nenabled = yes\n")     # 主文件里不许有块头
        _rl_ok, _rl_notes = _dbad.reload_config()
        check("★★ 新配置**语法就不对** ⇒ 拒绝，旧配置继续服务",
              _rl_ok is False and _dbad.cfg.max_sessions_per_user == 3,
              "ok=%s / %s" % (_rl_ok, _dbad.cfg.max_sessions_per_user))

        # 32.6 ★★ 新配置**过不了自检** ⇒ 同样拒绝（走的是**另一条**路：解析成功、
        #   而 validate() 有话说）
        _INV = write_conf("cluster_cidr = 192.0.2.0/24\n"
                          "range_start = 55001\nrange_end = 55099\n"
                          "max_sessions_per_user = 3\n", "rl-inv.conf")
        _di = _mk_reload_d(_INV)
        with open(_INV, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.2.0/24\n"
                     "range_start = 55001\nrange_end = 55099\n"
                     "max_sessions_per_user = 0\n")
        _rl_ok, _rl_notes = _di.reload_config()
        check("★★ 新配置过不了自检（max_sessions_per_user = 0）⇒ 拒绝，旧值仍是旧值",
              _rl_ok is False and _di.cfg.max_sessions_per_user == 3,
              "ok=%s / %s" % (_rl_ok, _di.cfg.max_sessions_per_user))

        # 32.7 ★★ 插件目录变了 ⇒ **不用重启**就能用
        #
        # ★ 这是用户那条诉求的正面：装一个插件之后不该断任何人的会话。
        _PLUG = write_conf("cluster_cidr = 192.0.2.0/24\n"
                           "range_start = 55001\nrange_end = 55099\n", "rl-plug.conf")
        _dp = _mk_reload_d(_PLUG)
        check("（夹具）重载之前本站只有 alpha 一个插件",
              sorted(s.name for s in _dp.cfg.plugin_specs) == ["alpha"],
              str(sorted(s.name for s in _dp.cfg.plugin_specs)))
        _rl_pkg(_RU2, "beta")                       # 往目录里丢一个新包
        _rl_ok, _rl_notes = _dp.reload_config()
        check("★★ 往插件目录里丢一个包 + 热重载 ⇒ **不用重启**新插件就可用了",
              _rl_ok is True
              and sorted(s.name for s in _dp.cfg.plugin_specs) == ["alpha", "beta"],
              "ok=%s / %s" % (_rl_ok, sorted(s.name for s in _dp.cfg.plugin_specs)))
        check("★ 而 `plugins_by_id` / `plugins_by_name` 两张表也跟着重建了"
              "（只换 Config 而漏掉它们，症状是「装上了但认不出」）",
              _RU2 in _dp.cfg.plugins_by_id
              and [s.id for s in _dp.cfg.plugins_by_name.get("beta", [])] == [_RU2],
              "%s / %s" % (sorted(_dp.cfg.plugins_by_id), _dp.cfg.plugins_by_name))
        check("★ 而插件包的**快照缓存**被清空了（它本来标注的是「刻意不失效」——"
              "那说的是从前那个进程一辈子只有启动那一刻的认知）",
              _dp._plugin_cache == {}, str(_dp._plugin_cache))

        # 32.8 ★★ `cluster_cidr` 改了 ⇒ **内核里那条基础规则的网段真的变了**
        #
        # ★★ 这一条守的是：改了 `cluster_cidr` 之后，内核里那条基础规则的**网段
        #    真的变了**。若只判"comment 在不在"，comment 还在那儿，就永远走"已存在"
        #    那条路，**连 restart 都不生效**，而那条基础规则一直指着旧网段。文档说
        #    它是"即使前面所有校验都被绕过"的**最后一道几何约束**。
        _CIDR = write_conf("cluster_cidr = 192.0.2.0/24\n"
                           "range_start = 55001\nrange_end = 55099\n", "rl-cidr.conf")
        _d_cidr = _mk_reload_d(_CIDR)
        _nftsim.rules = []                    # 从干净的规则集开始
        _d_cidr.nft.ensure()
        check("（夹具）基础规则建好了，网段是配置里那个",
              _nftsim.cidr() == "192.0.2.0/24", str(_nftsim.cidr()))
        # ★ 新网段**仍然覆盖桩里那个节点**（192.0.2.11）—— 换成一个不含它的网段
        #   会让这一条被**交叉核对**正确地拦下（那正是 32.12
        #   要测的那件事），而这里要测的是"换网段这件事本身生效了"。
        with open(_CIDR, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.0.0/16\n"
                     "range_start = 55001\nrange_end = 55099\n")
        _rl_ok, _rl_notes = _d_cidr.reload_config()
        check("★★ 改了 cluster_cidr + 热重载 ⇒ **内核里那条基础规则的网段真的变了**"
              "（今天连 restart 都不变：实现只看 comment 在不在）",
              _rl_ok is True and _nftsim.cidr() == "192.0.0.0/16",
              "ok=%s / nft 里现在是 %s" % (_rl_ok, _nftsim.cidr()))
        check("★★ 而那条规则**只剩一条**（是删旧插新，不是两条并存）",
              sum(1 for r in _nftsim.rules
                  if mod.Nft.BASE_OFFCLUSTER in r["text"]) == 1,
              str([r["text"] for r in _nftsim.rules]))
        check("★ 而且它说了 NOTICE 那一档的那句话（「哪些流量被放行」这一刻真的变了）",
              _rl_notes == ["cluster_cidr"], str(_rl_notes))

        # 32.9 ★ `base_offcluster_cidr` 的三态，以及**删基础规则真的删得掉**
        #
        # ★★ 后面那一条承重：`del_by_comment()` 若用 `RE_SESS`（只认
        #    `slurmate-sess-…`）去找句柄，拿它去删基础规则会**一条都匹配不到**，
        #    而函数照样返回 True（它报的是"规则集读得到"）。症状是"删过了，但规则
        #    还在"，而没有任何地方会报错。
        check("★ 那条规则在 ⇒ 读出它的网段",
              mod.Nft.base_offcluster_cidr(
                  '        ip daddr != 203.0.113.0/24 accept'
                  ' comment "slurmate-base-offcluster" # handle 7')
              == "203.0.113.0/24")
        check("★★ 那条规则**不在** ⇒ None（与「在、但读不出网段」必须分得开）",
              mod.Nft.base_offcluster_cidr("") is None
              and mod.Nft.base_offcluster_cidr(
                  '        oif "lo" accept comment "slurmate-base-lo" # handle 1')
              is None)
        _sim2 = _NftSim()
        _sim2._nft(["insert", "rule", "inet", "slurmate", "output",
                    "ip", "daddr", "!=", "192.0.2.0/24", "accept",
                    "comment", mod.Nft.BASE_OFFCLUSTER])
        _sim2._nft(["insert", "rule", "inet", "slurmate", "output",
                    "oif", "lo", "accept", "comment", mod.Nft.BASE_LO])
        _d_del = _mk_reload_d(_PLUG)
        _d_del.nft._nft = _sim2._nft
        _ok_del = _d_del.nft.del_by_comment(mod.Nft.BASE_OFFCLUSTER)
        check("★★ `del_by_comment` 删得掉**基础规则**（它从前用的正则只认会话规则 "
              "⇒ 一条都匹配不到，而函数照样返回 True）",
              _ok_del is True and len(_sim2.rules) == 1
              and mod.Nft.BASE_LO in _sim2.rules[0]["text"],
              str([r["text"] for r in _sim2.rules]))

        # 32.10 ★ 端口区间换了 ⇒ 游标重置（不重置的话它会落在新区间**之外**）
        _RANGE = write_conf("cluster_cidr = 192.0.2.0/24\n"
                            "range_start = 55001\nrange_end = 55099\n", "rl-range.conf")
        _d_rg = _mk_reload_d(_RANGE)
        _d_rg.port_cursor = 55090                   # 已经跑到区间尾部
        with open(_RANGE, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.2.0/24\n"
                     "range_start = 56001\nrange_end = 56099\n")
        _rl_ok, _rl_notes = _d_rg.reload_config()
        check("★★ 端口区间换了 ⇒ 游标回到**新的**起点（不重置的话它会落在 "
              "56001–56099 之外，而按游标算出来的端口会跟着跑出去）",
              _rl_ok is True and _d_rg.port_cursor == 56001,
              "游标=%s" % _d_rg.port_cursor)
        check("★ 而区间变了要说一句（已经在跑的会话，端口可能落在新区间外）",
              _rl_notes == sorted(["range_start", "range_end"]), str(_rl_notes))

        # 32.11 ★★ SIGHUP **不是退出**，而是"置一个待重载标志"
        #
        # ★ 三个信号不能走同一条路（都退出）：单元的 `ExecReload` 写的正是
        #   `kill -HUP`，若 SIGHUP 也退出，`systemctl reload` 的实际语义就与它
        #   声明的**相反**。
        _SIGD = _mk_reload_d(_PLUG)
        _SIGD._on_signal(mod.signal.SIGHUP, None)
        check("★★ SIGHUP ⇒ 只**置标志**，进程不退出",
              _SIGD._reload_pending is True and _SIGD.running is True,
              "pending=%s running=%s" % (_SIGD._reload_pending, _SIGD.running))
        _SIGD._on_signal(mod.signal.SIGTERM, None)
        check("★ SIGTERM 仍然是退出（而且**不**触发重载）",
              _SIGD.running is False and _SIGD._reload_pending is True,
              "pending=%s running=%s" % (_SIGD._reload_pending, _SIGD.running))

        # 32.12 ★★ 主循环**真的消费**那个标志
        #
        # ★ 少了这一条，`_on_signal` 置的那个标志就是一个**永远不发生的重载** ——
        #   而 32.11 那两条照样绿（它们只判标志被置上了）。
        _LOOP = write_conf("cluster_cidr = 192.0.2.0/24\n"
                           "range_start = 55001\nrange_end = 55099\n"
                           "max_sessions_per_user = 4\n", "rl-loop.conf")
        _dloop = _mk_reload_d(_LOOP)
        _dloop._on_signal(mod.signal.SIGHUP, None)
        with open(_LOOP, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.2.0/24\n"
                     "range_start = 55001\nrange_end = 55099\n"
                     "max_sessions_per_user = 9\n")
        _loop_seen = {"ticked": 0}

        def _fake_tick():
            _loop_seen["ticked"] += 1
            _dloop.running = False          # 跑一轮就让它退出来

        _dloop._run_tick = _fake_tick
        _dloop.run()
        check("★★ 主循环**真的消费**了那个标志：进去之后新配置已经生效"
              "（信号只置标志、重活在循环顶部做）",
              _dloop.cfg.max_sessions_per_user == 9 and _loop_seen["ticked"] == 1,
              "值=%s tick=%s" % (_dloop.cfg.max_sessions_per_user,
                                 _loop_seen["ticked"]))

        # 32.13 ★★ 成功与失败**各留一条审计**
        #
        # ★ 「改过配置」这件事要能事后查，而只看日志等级分不出这两件事（两条都
        #   是 error / 都是 info 的一部分）。判据落在**事件名**上。
        class _AuditCap(logging.Handler):

            def __init__(self):
                logging.Handler.__init__(self)
                self.lines = []

            def emit(self, rec):
                self.lines.append(rec.getMessage())

        _acap = _AuditCap()
        # ★ 等级要**显式调低**：`audit()` 走的是 `log.info`，而上面几节动过这个
        #   logger 的等级。不调的话 record 根本不会被创建，handler 一个字都收不到
        #   —— 那样这条用例会以"审计没记"收场，而真相是"这条用例没在读"。
        _saved_lvl = mod.log.level
        mod.log.addHandler(_acap)
        mod.log.setLevel(logging.DEBUG)
        try:
            _d_aud = _mk_reload_d(_PLUG)
            _d_aud._do_reload()
            with open(_PLUG, "w", encoding="utf-8") as _f:
                _f.write("cluster_cidr = 192.0.2.0/24\nrange_start = 55001\n"
                         "range_end = 55099\nmax_sessions_per_user = 0\n")
            _d_aud._do_reload()
        finally:
            mod.log.removeHandler(_acap)
            mod.log.setLevel(_saved_lvl)
        _ja = [m for m in _acap.lines if "AUDIT" in m]
        check("★★ 成功的重载留 `config_reload`、被拒的留 `config_reload_rejected`"
              "（不是一个笼统的「配置变了」）",
              any("config_reload" in m and "config_reload_rejected" not in m
                  for m in _ja)
              and any("config_reload_rejected" in m for m in _ja),
              str(_ja)[:400])

        class _LogCap(logging.Handler):
            """把守护进程那一个 logger 的记录收下来（等级 + 正文）。

            ★ 判"说了什么"要看**真的发出去的**，不是"代码里写了" ——
              `_do_reload()` 与 `announce_config_state()` 之间隔着一次 `Config`
              重建，两边都对才叫"说出来了"。
            """

            def __init__(self):
                logging.Handler.__init__(self)
                self.lines = []

            def emit(self, rec):
                self.lines.append((rec.levelname, rec.getMessage()))

        # 32.14 ★★ 改错一个数字的 `cluster_cidr` ⇒ **整个重载被拒、一个字都不改**
        #        （F45）
        #
        # ★★ 重载的拒绝判据若比启动的**少一半** —— 它只跑 `validate()`、
        #    没有 `crosscheck_cidr()` —— 而 `cluster_cidr` 在 `RELOAD_CLASS` 里是
        #    NOTICE 档（可热）⇒ 改错一个数字之后 `systemctl reload` **成功**，
        #    而 `_adopt_config()` 里 `Nft.ensure()` 按值比对，把内核里那条基础规则
        #    换成**错的网段**。
        #    后果：被漏掉的节点，流量走到链尾那条 `policy accept` —— 没有报错、
        #    没有日志、没有任何迹象。而文档说它是"即使前面所有校验都被绕过"的
        #    **最后一道几何约束**。
        _F45 = write_conf("cluster_cidr = 192.0.2.0/24\n"
                          "range_start = 55001\nrange_end = 55099\n"
                          "max_sessions_per_user = 2\n", "rl-f45.conf")
        _d_f45 = _mk_reload_d(_F45)
        _nftsim.rules = []                    # 从干净的规则集开始
        _d_f45.nft.ensure()
        check("（夹具）改之前：基础规则的网段覆盖桩里那个节点",
              _nftsim.cidr() == "192.0.2.0/24", str(_nftsim.cidr()))
        # ★ 漏掉半个网段：桩里那个节点是 192.0.2.11，而 /25 的**后半段**是
        #   .128–.255 —— 它落在外面。（账本 F45 举的就是这个例子。）
        # ★ 顺带还改了一个**本来可热**的键（`max_sessions_per_user`）：一次证明
        #   "拒绝"是**整份**拒绝，不是"跳过那一个、别的照旧"。
        with open(_F45, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.2.128/25\n"
                     "range_start = 55001\nrange_end = 55099\n"
                     "max_sessions_per_user = 5\n")
        _lc45 = _LogCap()
        _saved_lvl45 = mod.log.level
        mod.log.addHandler(_lc45)
        mod.log.setLevel(logging.DEBUG)
        try:
            _rl_ok45, _rl_notes45 = _d_f45.reload_config()
        finally:
            mod.log.removeHandler(_lc45)
            mod.log.setLevel(_saved_lvl45)
        check("★★ 改错一个数字（`/24` → `/25` 的后半段）⇒ 重载**被拒**"
              "（桩里那个节点落在新网段外面 ⇒ 交叉核对逮住它）",
              _rl_ok45 is False and _rl_notes45 == [],
              "ok=%s / notes=%s" % (_rl_ok45, _rl_notes45))
        check("★★ 而且**一个字都没改**：`cluster_cidr` 还是旧的，连那个本来可热的"
              "`max_sessions_per_user` 也没跟过去（全有或全无）",
              _d_f45.cfg.cluster_cidr == "192.0.2.0/24"
              and _d_f45.cfg.max_sessions_per_user == 2,
              "%s / %s" % (_d_f45.cfg.cluster_cidr,
                           _d_f45.cfg.max_sessions_per_user))
        check("★★ 内核里那条基础规则**还是旧网段** —— 它没被换掉"
              "（`_adopt_config()` 里那一步根本没跑到：这是最直接的那一条判据）",
              _nftsim.cidr() == "192.0.2.0/24", str(_nftsim.cidr()))
        check("★★ 而日志**点名**了是哪个键（只说「配置有问题」的话，管理员不知道"
              "该去改哪一个）",
              any(lv == "ERROR" and "cluster_cidr" in m for lv, m in _lc45.lines),
              str(_lc45.lines)[:400])

        # ★★ 反过来的一半 —— 少了它，"把热重载整个禁掉"也能让上面几条绿。
        with open(_F45, "w", encoding="utf-8") as _f:
            _f.write("cluster_cidr = 192.0.0.0/16\n"
                     "range_start = 55001\nrange_end = 55099\n"
                     "max_sessions_per_user = 5\n")
        _rl_ok45b, _rl_notes45b = _d_f45.reload_config()
        check("★★ 对照：改成一个**仍然覆盖全部节点**的网段 ⇒ 照常生效"
              "（这一条是上面那几条的**反面**：新判据拦的是「改错了」，"
              "不是「改了 cluster_cidr」）",
              _rl_ok45b is True
              and _d_f45.cfg.cluster_cidr == "192.0.0.0/16"
              and _d_f45.cfg.max_sessions_per_user == 5,
              "ok=%s / %s / %s" % (_rl_ok45b, _d_f45.cfg.cluster_cidr,
                                   _d_f45.cfg.max_sessions_per_user))

        # 32.15 ★★ 热重载之后，站点级那几条 ⚠ **重打一遍**（F46）
        #
        # ★★ 与 F45 **同源**：reload 抄了启动判据的一个子集。`reload_config()`
        #    换掉 `Config` 对象之后，`stale_conf_problems` 这些字段是**新的一组
        #    值**；若出口只有 `start()` 与 `--check` 两个，卸掉一个插件再 reload，
        #    那条 ⚠ 就**只在下次重启时才说**。症状正是 `stale_plugin_conf_problems`
        #    自己的注释要防的那句话：「我明明配了啊」，而日志里一个字都没有。
        _F46 = write_conf("cluster_cidr = 192.0.2.0/24\n"
                          "range_start = 55001\nrange_end = 55099\n", "rl-f46.conf")
        # ★ 一份**安装器起名**的配置（ULID 文件名 ⇒ 判据落在位置上，不是文件里
        #   写了什么）。此刻它指得到 alpha。
        write_plugin_conf(_F46, _RU1, "enabled = yes\n")
        _d_f46 = _mk_reload_d(_F46)
        _conf_f46 = os.path.join(mod.plugin_conf_dir(_F46), _RU1 + ".conf")
        check("（夹具）此刻那份配置指得到 alpha ⇒ 一条 ⚠ 都没有",
              _d_f46.cfg.stale_conf_problems == []
              and any(s.id == _RU1 for s in _d_f46.cfg.plugin_specs),
              "%s / %s" % (_d_f46.cfg.stale_conf_problems,
                           [s.id for s in _d_f46.cfg.plugin_specs]))

        _lc46 = _LogCap()
        _saved_lvl46 = mod.log.level
        mod.log.addHandler(_lc46)
        mod.log.setLevel(logging.DEBUG)
        try:
            _d_f46._do_reload()          # ① 什么都没变
            _n46_before = [m for _, m in _lc46.lines if _RU1 in m]
            # ② 把 alpha 从本站拿走 —— 树与记录表**两处一起**（这就是卸载器做的
            #    那两件事；这里不调卸载器，因为要考的是"下一个 reload 会看见什么"，
            #    而不是"卸载删得干不干净"，那是 30 节的事）。
            shutil.rmtree(os.path.join(_RL, _RU1))
            os.unlink(mod.plugin_record_path(_RL, _RU1))
            _d_f46._do_reload()          # ③ 新扫出来的插件表里没有 alpha 了
        finally:
            mod.log.removeHandler(_lc46)
            mod.log.setLevel(_saved_lvl46)
        _n46_after = [m for _, m in _lc46.lines if _RU1 in m]
        check("★★ ① 没变化的那一轮重载**不说**这条 ⚠（不然每次 reload 都是一堆"
              "噪音，而噪音里的真话没人看得见）",
              _n46_before == [], str(_n46_before)[:300])
        check("★★ ② 插件被拿走之后、**同一份配置**再重载 ⇒ 那条 ⚠ 就出现在日志里"
              "（判据是**那份配置的路径**，不是笼统的「有没有 warning」）",
              len(_n46_after) >= 1, str(_n46_after)[:300])
        check("★★ ③ 而且它是**在重载这一轮**说的，不是等下次重启 —— 这正是 F46 "
              "要的那件事",
              any(_conf_f46 in w or _RU1 in w
                  for w in _d_f46.cfg.stale_conf_problems),
              str(_d_f46.cfg.stale_conf_problems)[:300])

    finally:
        mod.default_plugins_dir = _saved_rl_dir
        mod.run_cmd = _saved_rl_run

    for _dd in _rl_ds:
        try:
            _dd.store.close()
        except Exception:                                    # noqa: BLE001
            pass

    mod.log.setLevel(_rel_real_level)
    for _dd in _rel_daemons:
        try:
            _dd.store.close()
        except Exception:                                    # noqa: BLE001
            pass

    for _dd in (_d, _d2, _d3, _d4, _d5, _d6, _d7, _d8, _d10, _d11, _d12,
                _d13, _d14, _d15, _d16,
                # 第 27 节（客户端身份与每用户连接上限）自己那一批
                _d17, _d24, _d25,
                # 第 28 节（集群信息）自己那一批
                _d28, _d29,
                # 第 29 节（看护者）自己那一批
                _d30, _d31, _d32, _d33, _d34, _d35, _d36, _d37, _d38):
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
