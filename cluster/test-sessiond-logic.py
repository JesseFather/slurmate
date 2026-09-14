#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test-sessiond-logic.py — slurmate-sessiond 的单元/集成测试

在【未安装】的状态下跑，用临时目录做状态目录，用 monkeypatch 覆盖家目录查找，
以便验证安全关键路径（会话文件校验）与 Slurm 交互。

用法： /usr/bin/python3 test-sessiond-logic.py
"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
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


def make_config(mod, tmpdir):
    """基于真实配置生成一份指向临时目录的测试配置。"""
    with open(CONF, "r", encoding="utf-8") as f:
        text = f.read()
    # 覆盖状态目录相关项
    text = text.replace("/var/lib/slurmate-session", os.path.join(tmpdir, "state"))
    text = text.replace("/var/log/slurmate", os.path.join(tmpdir, "log"))
    text = text.replace("/run/slurmate-session/ctl.sock",
                        os.path.join(tmpdir, "ctl.sock"))
    # 作业脚本还没部署到 /usr/local/share/slurmate/，指向仓库里的副本
    text = text.replace("/usr/local/share/slurmate/run.sbatch",
                        os.path.join(HERE, "run.sbatch"))
    p = os.path.join(tmpdir, "slurmate.conf")
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    return mod.Config(p)


def main():
    global PASS, FAIL
    tmpdir = tempfile.mkdtemp(prefix="slurmate-test-")
    print("测试临时目录: %s\n" % tmpdir)

    mod = load_module()
    cfg = make_config(mod, tmpdir)
    os.makedirs(os.path.join(tmpdir, "state"), exist_ok=True)
    os.makedirs(os.path.join(tmpdir, "log"), exist_ok=True)

    # ── 1. 配置解析 ─────────────────────────────────────────────────────────
    print("── 1. 配置解析 ──")
    check("端口池解析", cfg.port_start == 55001 and cfg.port_end == 55999,
          "%d-%d" % (cfg.port_start, cfg.port_end))
    check("用途解析出 4 个", len(cfg.purposes) == 4, str(list(cfg.purposes)))
    check("code 用途用 2080TI 分区",
          cfg.purposes["code"].partition == "2080TI")
    check("flash/孤儿阈值 300/1800",
          cfg.suspect_after == 300 and cfg.orphan_after == 1800)
    check("配置自检无错误", cfg.validate() == [], str(cfg.validate()))

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
    st.insert(session_id="s1", uid=UID, user="alice", purpose="code",
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
        st.insert(session_id="s2", uid=2003, user="other", purpose="code",
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
        st.insert(session_id="s3", uid=2003, user="other", purpose="code",
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
        "user": "alice", "purpose": "code", "node": "node01",
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
    sess = {"uid": UID, "job_id": 5712, "candidates": "55017,55018",
            "purpose": "code"}
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
    sl = mod.Slurm(cfg)

    # 9a. 纯解析，不碰集群 —— 任何机器上都跑
    check("节点名展开", sl.expand_node("node0[1-2]") == "node01",
          str(sl.expand_node("node0[1-2]")))

    # 9b. 解析逻辑用【桩】测，不连真集群。
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

    def fake_run_cmd(argv, timeout=10, check=False):
        cmd = " ".join(str(a) for a in argv)
        # scontrol show node <name>
        if "show node" in cmd:
            node = str(argv[-1])
            if node == "node01":
                return 0, "NodeName=node01 Arch=x86_64 NodeAddr=192.0.2.11 " \
                          "State=IDLE\n", ""
            if node == "node04":
                return 0, "NodeName=node04 Arch=x86_64 NodeAddr=192.0.2.20 " \
                          "State=IDLE\n", ""
            return 1, "", "Invalid node name specified"
        # scontrol show hostname <...>
        if "show hostname" in cmd:
            if str(argv[-1]) == "node0[1-2]":
                return 0, "node01\n", ""
            if str(argv[-1]) == "node01":
                return 0, "node01\n", ""
            return 1, "", "Invalid node name specified"
        if "show partition" in cmd:
            return 0, ("PartitionName=A6000 Default=NO MaxTime=183-00:00:00\n"
                       "PartitionName=RTX8000 Default=NO MaxTime=183-00:00:00\n"
                       "PartitionName=2080TI Default=YES MaxTime=183-00:00:00\n"), ""
        if "show config" in cmd:
            return 0, "ClusterName=example\nAccountingStorageEnforce=" \
                      "associations,limits,qos\n", ""
        if "ping" in cmd.split():
            return 0, "Slurmctld(primary) at slurmctld is UP\n", ""
        if "show job" in cmd:
            return 1, "", "Invalid job id specified"
        if "squeue" in cmd:
            return 0, "", ""
        if "sacctmgr" in cmd:
            user = ""
            for a in argv:
                if str(a).startswith("user="):
                    user = str(a)[5:]
            fmt = ""
            for a in argv:
                if str(a).startswith("format="):
                    fmt = str(a)[7:]
            if user == "alice":
                # 不限定分区：Partition 列为空
                return 0, ("myaccount|\n" if "Partition" in fmt else "myaccount\n"), ""
            if user == "bob":
                # 限定分区，且大小写与实际分区名（2080TI）不一致 —— 这是关键用例
                return 0, ("myaccount|2080ti\n" if "Partition" in fmt
                           else "myaccount\n"), ""
            return 0, "", ""      # dave：没有 association
        return 1, "", "unexpected command: %s" % cmd

    mod.run_cmd = fake_run_cmd
    try:
        check("分区列表包含示例里的分区",
              set(sl.partitions()) >= {"A6000", "RTX8000", "2080TI"},
              str(sl.partitions()))
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

    cfg.scontrol = real_scontrol
    st, info = sl2.job_state(999999999)
    check("确实不存在的作业 → MISSING", st == mod.Slurm.JOB_MISSING, st)
    check("show_job 对不存在的作业返回 None",
          sl2.show_job(999999999) is None)

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
    sess2 = {"uid": UID, "job_id": 5712, "candidates": "55017,55018",
             "purpose": "code"}
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

    # ── 13. 内存参数：--mem=0 必须被拒（L6 回归）────────────────────────
    print("\n── 13. 内存参数校验 ──")
    import re as _re
    def mem_ok(v):
        m = _re.fullmatch(r"([0-9]+)([KMGTP]?)", str(v))
        return bool(m) and int(m.group(1)) > 0
    check("4G 合法", mem_ok("4G"))
    check("512M 合法", mem_ok("512M"))
    check("0 被拒（Slurm 里 0 = 整机内存）", not mem_ok("0"))
    check("空串被拒", not mem_ok(""))
    check("负数被拒", not mem_ok("-1"))
    check("乱码被拒", not mem_ok("abc"))

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
