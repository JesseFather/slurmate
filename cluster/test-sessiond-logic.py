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
import base64
import importlib.machinery
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
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


def load_module():
    loader = importlib.machinery.SourceFileLoader("slurmate_sessiond", DAEMON)
    spec = importlib.util.spec_from_loader("slurmate_sessiond", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def write_stub(path, body):
    """在临时目录里造一个可执行的小脚本，用来当外部命令的替身。"""
    with open(path, "w", encoding="utf-8") as f:
        f.write("#!/bin/sh\n" + body)
    os.chmod(path, 0o755)
    return path


def make_config(mod, tmpdir):
    """基于【随仓库分发的示例配置】生成一份指向临时目录、且自洽的测试配置。

    ★ 三样东西必须从宿主机上摘掉，否则测试的结论取决于跑它的机器：

      1. **状态 / 日志 / socket 目录** —— 它们现在是代码常量（不再是可以从配置
         里改的键），所以直接在模块上覆盖。不覆盖的后果不只是"测试污染真实
         目录"，还包括 `_db_schema_errors()` 会去读真实部署的 claims.db。
      2. **作业脚本路径** —— 由守护进程自身的安装位置推导（`<prefix>/share/
         slurmate/run.sbatch`），而开发机上还没部署，于是指向仓库里的副本。
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
    text = re.sub(r"(?m)^cluster_cidr\s*=.*$", "cluster_cidr = 192.0.2.0/24", text)
    for name in ("sbatch", "scancel", "squeue", "scontrol", "sacctmgr"):
        stub = write_stub(os.path.join(bindir, name), "exit 0\n")
        text = re.sub(r"(?m)^%s\s*=.*$" % name, "%s = %s" % (name, stub), text)
    p = os.path.join(tmpdir, "slurmate.conf")
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)

    mod.STATE_DIR = os.path.join(tmpdir, "state")
    mod.LOG_DIR = os.path.join(tmpdir, "log")
    mod.SOCKET_PATH = os.path.join(tmpdir, "ctl.sock")
    mod.default_job_script = lambda: os.path.join(HERE, "run.sbatch")
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


def main():
    global PASS, FAIL
    tmpdir = tempfile.mkdtemp(prefix="slurmate-test-")
    print("测试临时目录: %s\n" % tmpdir)

    mod = load_module()
    cfg = make_config(mod, tmpdir)
    os.makedirs(os.path.join(tmpdir, "state"), exist_ok=True)
    os.makedirs(os.path.join(tmpdir, "log"), exist_ok=True)

    # ── 1. 配置解析（扁平 Key=Value）────────────────────────────────────────
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
        return mod.parse_flat_config(write_conf(text, name))

    check("行尾 # 注释被切掉",
          parse("range_start = 55001  # 端口池下界\n") == {"range_start": "55001"})
    check("整行注释与空行被跳过",
          parse("# 说明\n\n   \nrange_end = 5\n") == {"range_end": "5"})
    check("值两端空白被去掉",
          parse("readonly_paths =   /shared/home  \n")
          == {"readonly_paths": "/shared/home"})
    for i, (bad, why) in enumerate((("range_start = 1\nrange_start = 2\n", "重复键"),
                                    ("这不是赋值\n", "缺等号"),
                                    ("= 5\n", "缺键名"))):
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
    check("活跃计数", st.count_active(UID) == 1)
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
    check("gpus 缺失 → 0（不占卡）", mod.clamp_int(None, 0, 0, 8) == 0)

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
    old_cfg.__dict__["db_path"] = os.path.join(tmpdir, "nosuch.db")
    check("库还不存在时不报错（Store 会建）", old_cfg._db_schema_errors() == [])

    # ── 17. sbatch 命令行（纯函数）─────────────────────────────────────────
    # 这些分支的错只会在真集群上、且只在某些分支上暴露，所以必须在本机断言。
    print("\n── 17. sbatch 命令行 ──")
    base_sess = {"session_id": "9f2c4a1bdeadbeef", "account": "myaccount",
                 "cpus": 2, "mem": "8G", "requested_time": "12:00:00",
                 "partition": "2080TI", "gres": None}

    def argv_of(**over):
        return mod.build_sbatch_argv(cfg, dict(base_sess, **over), {"A": "1"}, home)

    a = argv_of()
    check("指定了分区 → 带 -p", "-p" in a and "2080TI" in a, str(a))
    check("没 GPU → 完全省略 --gres（不是 gpu:0）",
          not any(x.startswith("--gres") for x in a), str(a))
    check("默认不写 -w（节点由 Slurm 在分区内挑）", "-w" not in a, str(a))
    check("作业名带会话 id 前 8 位", "--job-name=slurmate-9f2c4a1b" in a, str(a))

    a = argv_of(partition="")
    check("分区为空串 → 不带 -p（交给 Slurm 的默认分区）",
          "-p" not in a, str(a))
    a = argv_of(gres="gpu:2")
    check("指定了 GPU → 带 --gres=gpu:2", "--gres=gpu:2" in a, str(a))
    a = mod.build_sbatch_argv(cfg, dict(base_sess, partition=""), {}, tmpdir)
    check("家目录下没有日志子目录时回退到家目录根",
          any(x.endswith("slurm-%j.out") and tmpdir in x for x in a), str(a))

    # ── 18. op_submit：缺省值由服务端填，权限查不到时退化而不是拒绝 ─────────
    print("\n── 18. op_submit（服务端填默认值）──")
    d.user_home = lambda uid: home
    captured = {}
    seq = [0]

    def run_submit(req, allowed="normal"):
        """跑一次 op_submit。返回 (响应, 记下来的 sess/env)。"""
        seq[0] += 1
        d.store = mod.Store(os.path.join(tmpdir, "submit-%d.db" % seq[0]))
        d.slurm = mod.Slurm(cfg)
        captured.clear()

        def _sub(sess, env, h, u, usr):
            captured["sess"] = dict(sess)
            captured["env"] = dict(env)
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
        return resp, captured.get("sess", {}), captured.get("env", {})

    r, sess, env = run_submit({"op": "submit"})
    check("缺省提交成功", r.get("ok"), str(r))
    check("缺省 cpus=2、mem=8G（服务端填，客户端没给）",
          sess["cpus"] == 2 and sess["mem"] == "8G", "%s / %s" % (sess["cpus"], sess["mem"]))
    check("缺省分区是从有权限的列表里挑的（不是空）",
          sess["partition"] in ("A6000", "RTX8000", "2080TI"), sess["partition"])
    check("响应里带回实际选中的分区（用户事先不知道）",
          r["data"]["partition"] == sess["partition"], str(r["data"]))
    check("缺省无 warning（服务端没替用户改任何东西）",
          "warning" not in r["data"], str(r["data"].get("warning")))
    check("环境变量带上了分区与资源",
          env.get("SLURMATE_PARTITION") == sess["partition"]
          and env.get("SLURMATE_CPUS") == "2", str(env))

    r, sess, _ = run_submit({"op": "submit", "cpus": 999, "mem": "4G"})
    check("超上限的 cpus 被钳制", sess["cpus"] == mod.MAX_CPUS_REQUEST, str(sess["cpus"]))
    check("显式 mem 生效", sess["mem"] == "4G", sess["mem"])

    r, sess, _ = run_submit({"op": "submit", "mem": "0"})
    check("mem=0 被回退到默认，且【告知】用户",
          sess["mem"] == "8G" and "内存" in r["data"].get("warning", ""),
          str(r["data"].get("warning")))

    r, sess, _ = run_submit({"op": "submit", "partition": "2080TI"})
    check("显式分区被尊重", sess["partition"] == "2080TI", sess["partition"])
    check("分区权限不限时放行", r.get("ok"), str(r))

    r, _s, _e = run_submit({"op": "submit", "partition": "NOSUCH"})
    check("不存在的分区 → bad_partition(code 2)",
          not r.get("ok") and r["code"] == 2 and r["error"]["kind"] == "bad_partition",
          str(r))

    r, sess, _ = run_submit({"op": "submit", "gpus": 2})
    check("指定 GPU → gres=gpu:2", sess["gres"] == "gpu:2", str(sess["gres"]))
    r, sess, _ = run_submit({"op": "submit", "gpus": 0})
    check("gpus=0 → 不带 gres", sess["gres"] is None, str(sess["gres"]))

    r, sess, _ = run_submit({"op": "submit", "time": "183-00:00:00"})
    check("超过分区 MaxTime 与硬上限的时间被截断",
          sess["requested_time"] == "7-00:00:00", sess["requested_time"])
    check("截断时间会告知用户", "上限" in r["data"].get("warning", ""),
          str(r["data"].get("warning")))

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
          "默认分区" in r["data"].get("warning", ""), str(r["data"].get("warning")))
    check("退化时 sbatch 不带 -p",
          "-p" not in mod.build_sbatch_argv(cfg, dict(sess, session_id="x"),
                                            env, home))

    r, _s, _e = run_submit({"op": "submit", "partition": "2080TI"}, allowed="dead")
    check("权限查不到 + 点名了分区 → 拒绝（fail-closed）",
          not r.get("ok") and r["error"]["kind"] == "partitions_unknown", str(r))

    r, _s, _e = run_submit({"op": "submit", "partition": "2080TI"})
    d.store.close()

    # ── 19. 服务种类（code-server / sshd）───────────────────────────────────
    #
    # 一个会话提供哪种服务。两条路互斥，由 run.sbatch 的 start_service 结构性地
    # 保证。这里测的是守护进程这一侧：缺省、开关、公钥、以及"从 nft 规则恢复出来
    # 的会话不许猜自己是什么服务"。
    print("\n── 19. 服务种类（code-server / sshd）──")

    # 19.1 站点白名单的解析（纯函数）
    _k, _e = mod.parse_service_kinds("")
    check("service_kinds 留空 = 只有 code-server（留空必须是安全的那个方向）",
          _k == (mod.SVC_CODE_SERVER,) and _e is None, "%s / %s" % (_k, _e))
    _k, _e = mod.parse_service_kinds("code-server,sshd")
    check("正常解析两种服务",
          _k == (mod.SVC_CODE_SERVER, mod.SVC_SSHD) and _e is None, str(_k))
    _k, _e = mod.parse_service_kinds(" sshd , sshd ,code-server ")
    check("空白忽略、重复项去掉", _k == (mod.SVC_SSHD, mod.SVC_CODE_SERVER), str(_k))
    _k, _e = mod.parse_service_kinds("code-server，sshd")
    check("全角逗号也认（配置以中文注释为主，手滑很常见）",
          _k == (mod.SVC_CODE_SERVER, mod.SVC_SSHD), str(_k))
    _k, _e = mod.parse_service_kinds("ssh")
    check("★ 少一个字母的名字必须报错，不能静默忽略 —— 否则「配了但不生效」",
          _e is not None and "ssh" in _e, str(_e))
    _k, _e = mod.parse_service_kinds(",")
    check("只有分隔符也算空 → 报错（不是静默变成「允许全部」）",
          _e is not None and "空" in _e, str(_e))

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
          sess["service_kind"] == mod.SVC_CODE_SERVER, str(sess.get("service_kind")))
    check("环境变量把服务种类传给了作业",
          env.get("SLURMATE_SERVICE_KIND") == mod.SVC_CODE_SERVER, str(env))

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
    _saved_kinds = cfg.service_kinds
    cfg.service_kinds = (mod.SVC_CODE_SERVER, mod.SVC_SSHD)
    try:
        r, sess, env = run_submit({"op": "submit", "service_kind": "sshd",
                                   "ssh_pubkey": _pub})
        check("开了之后 sshd 提交成功", r.get("ok"), str(r))
        check("会话记住了服务种类（界面据此决定「连接」做什么）",
              sess["service_kind"] == mod.SVC_SSHD, str(sess.get("service_kind")))
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
        check("sshd 路径与主机密钥目录也传下去了",
              env.get("SLURMATE_SSHD_BIN") == cfg.sshd_bin
              and env.get("SLURMATE_SSH_DIR", "").endswith("/.slurmate/ssh"),
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
        cfg.service_kinds = _saved_kinds

    # 19.6 session_view 要如实报出服务种类，未知就是 None
    d.store = mod.Store(os.path.join(tmpdir, "svc-view.db"))
    d.store.insert(session_id="s-known", uid=UID, user="alice",
                   partition="A6000", account="acct", cpus=2, mem="8G",
                   requested_time="1:00:00", state=mod.ST_ENROLLED,
                   candidates="55001", created_at=mod.now_ts(),
                   service_kind=mod.SVC_SSHD)
    d.store.insert(session_id="s-unknown", uid=UID, user="alice",
                   partition="A6000", account="acct", cpus=2, mem="8G",
                   requested_time="1:00:00", state=mod.ST_ENROLLED,
                   candidates="55002", created_at=mod.now_ts())
    # with_secret=False：这两行的 job_id 是空的，而取口令那条路要按 job_id 读会话
    # 文件。这里要验的只是 service_kind 的渲染，与口令无关。
    check("session_view 报出 service_kind",
          d.session_view(d.store.get("s-known"), with_secret=False)["service_kind"]
          == mod.SVC_SSHD)
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
    d.store.close()

    # 19.8 老库补列：加一个**可空**列是纯加法，直接迁移；不像删 NOT NULL 列那次
    #     只能拒绝启动。不补的后果是旧库上守护进程照常启动，直到第一次用到新列
    #     才抛 no such column，被兜成 code 9「内部错误」。
    old_db2 = os.path.join(tmpdir, "old-nosvc.db")
    _c = _sq.connect(old_db2)
    # 夹具要带上 SCHEMA_SQL 里那几条索引引用的列 —— `CREATE TABLE IF NOT EXISTS`
    # 不会改建好的表，但 `CREATE INDEX IF NOT EXISTS ... ON sessions(state)` 会
    # 因为缺列直接报错。
    _c.execute("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, uid INTEGER, "
                "state TEXT, job_id INTEGER, node_ip TEXT, service_port INTEGER)")
    _c.execute("INSERT INTO sessions (session_id, uid) VALUES ('kept', 2002)")
    _c.commit()
    _c.close()
    _st = mod.Store(old_db2)
    _cols = {r[1] for r in _st.conn.execute("PRAGMA table_info(sessions)")}
    check("★ 老库（没有 service_kind 列）被自动补上",
          "service_kind" in _cols, str(sorted(_cols))[:120])
    check("补列不动已有的数据",
          _st.get("kept") is not None and _st.get("kept")["uid"] == 2002)
    _st.close()
    check("补列是幂等的（再开一次不报错）", mod.Store(old_db2).close() is None)

    # 19.9 ★ 候选端口表的分隔符
    # 实测（在计算节点上）：`--export=ALL,SLURMATE_CANDIDATES=55001,55002,55003,AFTER=ok`
    # 传给作业的 SLURMATE_CANDIDATES 是 **55001** —— Slurm 按逗号切 --export，
    # 后两段被当成"要导出的变量名"、未设置于是丢掉。六个候选端口有五个静默消失，
    # 那个仅剩的端口恰好被占时作业就以"候选端口全部失败"退出。
    _r, _s, _e = run_submit({"op": "submit"})
    _cands_env = _e.get("SLURMATE_CANDIDATES", "")
    check("★ 候选端口表用分号分隔（逗号会被 sbatch 的 --export 切碎，只剩第一个）",
          ";" in _cands_env and "," not in _cands_env, repr(_cands_env))
    check("★ 候选个数没被截断成一个",
          len(_cands_env.split(";")) == len(_s["candidates"].split(",")),
          "%d 个 vs 数据库里 %d 个"
          % (len(_cands_env.split(";")), len(_s["candidates"].split(","))))

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
                   service_kind=mod.SVC_SSHD)
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
        except StopIteration:
            _skip = "run.sbatch 里找不到 write_atomic/json_escape/write_session"
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
            'SSH_HOST_PUB="%s"' % _hk,
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
            check("★ 字段没有错位（printf 参数与格式串一一对应）",
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
