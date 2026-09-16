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


def weave_one(tpl_path, plugin_dir, name, ulid, out_path):
    """照 deploy.sh 的做法，把**一个**插件的 job/start.sh 织进模板。

    ★ 一个插件一份：这里与 deploy.sh 是同一段 awk、同一个标记、同样只放一个块。
      这里分叉的后果是"用例全绿、部署到真机上炸" —— 而部署脚本没法在本机跑。
      返回 awk 的 CompletedProcess（调用方要断言 returncode）。
    """
    blocks = out_path + ".blocks"
    with open(os.path.join(plugin_dir, "job", "start.sh"), encoding="utf-8") as f:
        body = f.read()
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
    #    还没部署。这里指向**仓库顶层**的 plugins/，也就是 deploy.sh 会装进去的那
    #    两个真插件。
    #
    #    ★ 刻意用**真的那两个**而不是合成替身：插件与基座的接口正是这一版反复在
    #      动的东西，用替身测等于没测 —— 替身会跟着实现一起漂，而真插件不会。
    plugins_dir = os.path.normpath(os.path.join(HERE, os.pardir, "plugins"))
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
        weave_one(os.path.join(HERE, "run.sbatch"), _s.source_dir, _s.name, _s.id,
                  os.path.join(jobs_dir, _s.id + ".sbatch"))
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
    a = argv_of(gres="gpu:2")
    check("指定了 GPU → 带 --gres=gpu:2", "--gres=gpu:2" in a, str(a))
    a = mod.build_sbatch_argv(cfg, dict(base_sess, partition=""), {}, tmpdir,
                              "/tmp/j.sbatch", "code-server")
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

        def _sub(sess, env, h, u, usr, job_script, service_kind):
            captured["sess"] = dict(sess)
            captured["env"] = dict(env)
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
                                            env, home, "/tmp/j.sbatch",
                                            "code-server"))

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
    # <prefix>/share/slurmate/plugins/*/plugin.json，由 deploy.sh 装进去。
    # 加一个插件因此是「放一个目录 + 跑一次 deploy.sh」，不是「改守护进程的源码」。
    print("\n  -- 19.0 扫出来的插件表 --")
    check("★ 扫出了两个插件（表来自磁盘，不是代码常量）",
          sorted(cfg.plugin_by_name) == [CS, SSHD], str(sorted(cfg.plugin_by_name)))
    check("清单合法时没有诊断输出", cfg.plugin_problems == (), str(cfg.plugin_problems))
    check("每个 spec 都记得自己是从哪个目录扫出来的（只用于报错）",
          all(s.source_dir for s in cfg.plugin_specs))
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

    # 坏掉的插件目录：**跳过并报出来，但绝不让守护进程起不来**。一个插件坏了不该
    # 带走整个站点 —— 而静默跳过同样不行（"我明明装了啊"会变成一句谁也答不上来的话）。
    _baddir = os.path.join(tmpdir, "plugins-broken")
    os.makedirs(os.path.join(_baddir, "good"), exist_ok=True)
    os.makedirs(os.path.join(_baddir, "bad-json"), exist_ok=True)
    os.makedirs(os.path.join(_baddir, "missing-manifest"), exist_ok=True)
    shutil.copy(os.path.join(HERE, os.pardir, "plugins", CS, "plugin.json"),
                os.path.join(_baddir, "good", "plugin.json"))
    with open(os.path.join(_baddir, "bad-json", "plugin.json"), "w",
              encoding="utf-8") as _f:
        _f.write("{ 这不是 JSON")
    _specs2, _probs2 = mod.scan_plugins(_baddir)
    check("★ 一个坏目录不会让守护进程起不来（跳过它，其余照常）",
          [s.name for s in _specs2] == [CS], str([s.name for s in _specs2]))
    check("★ 但它必须被**报出来**，而且点名是哪个目录",
          len(_probs2) == 2 and any("bad-json" in p for p in _probs2)
          and any("missing-manifest" in p for p in _probs2),
          str(_probs2))

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
    def _manifest(text):
        # 布局是 <扫描目录>/<任意目录名>/plugin.json —— **目录名不参与身份判定**，
        # 所以这里故意用一个与短名无关的名字。
        d = os.path.join(tmpdir, "mf-%d" % time.time_ns(), "whatever")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "plugin.json"), "w", encoding="utf-8") as f:
            f.write(text)
        return mod.scan_plugins(os.path.dirname(d))

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
              mod.parse_plugin_manifest("x/plugin.json",
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
                         "version": "1.0.0", "engines": {"slurmate": ">=99.0.0"},
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

    # 短名撞车：两个目录抢一个短名 —— **两个都不收**。挑一个的后果是"哪个生效"
    # 取决于目录名的字典序，而那是没人会想到去查的地方。
    _dupdir = os.path.join(tmpdir, "plugins-dup")
    for _sub, _ver in (("a", "1.0.0"), ("b", "2.0.0")):
        os.makedirs(os.path.join(_dupdir, _sub), exist_ok=True)
        with open(os.path.join(_dupdir, _sub, "plugin.json"), "w",
                  encoding="utf-8") as _f:
            _f.write(json.dumps({"id": "01M2JKHTZGKJBFQQTWYXMQMF2V", "name": "jup",
                                 "version": _ver,
                                 "site": {"defaultCpus": 1, "defaultMem": "1G"}}))
    _s3, _p3 = mod.scan_plugins(_dupdir)
    check("★ 两个目录抢一个短名 → 两个都不加载（挑一个等于让目录名决定行为）",
          _s3 == () and any("重复" in p for p in _p3), "%s / %s" % (_s3, _p3))

    # 19.0c ★★ 加一个插件**不需要改守护进程的任何一行**
    #
    # 这是「插件是独立项目」在集群侧的落点，所以它必须有一条**跑的**用例，而不是
    # 一句注释。这里合成一个全新的插件（仓库里没有它、守护进程更没听说过它），
    # 然后走一遍：扫描 → 配置块 → 提交 → 环境变量 → op_plugins。
    _thirddir = os.path.join(tmpdir, "plugins-third")
    os.makedirs(os.path.join(_thirddir, "jup", "job"), exist_ok=True)
    # 作业侧那一半。**必须真的写一份**：没有它这个插件就是"合法但提交不了"，
    # 而这一节要验的恰恰是"能提交"。没有作业侧那一态由 19.0e 专门覆盖。
    with open(os.path.join(_thirddir, "jup", "job", "start.sh"), "w",
              encoding="utf-8") as _f:
        _f.write("start_jup() { :; }\n")
    with open(os.path.join(_thirddir, "jup", "plugin.json"), "w",
              encoding="utf-8") as _f:
        _f.write(json.dumps({
            "id": "01M2JKHTZGKJBFQQTWYXMQMF2X", "name": "jup",
            "version": "2.1.0", "displayName": "Jupyter",
            "engines": {"slurmate": ">=0.5.0"},
            "contributes": {"submitPubkey": False},
            "site": {"defaultCpus": 3, "defaultMem": "6G", "defaultEnabled": False,
                     "bin": {"env": "SLURMATE_JUP_BIN", "discovery": "convention",
                             "fallback": "/usr/local/bin/jupyter"},
                     "enumKeys": {"token_mode": {"choices": ["auto", "none"],
                                                 "default": "auto"}}},
        }))
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
        _jup_row = next(x for x in _pj["data"]["plugins"] if x["name"] == "jup")
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
    os.makedirs(os.path.join(_nojdir, "decl"), exist_ok=True)
    with open(os.path.join(_nojdir, "decl", "plugin.json"), "w",
              encoding="utf-8") as _f:
        _f.write(json.dumps({
            "id": "01M2JKHTZGKJBFQQTWYXMQMF30", "name": "decl",
            "version": "1.0.0", "displayName": "声明式",
            "engines": {"slurmate": ">=0.5.0"},
            "site": {"defaultCpus": 1, "defaultMem": "2G"}}))
    _specs5, _probs5 = mod.scan_plugins(_nojdir)
    check("★ 没有 job/start.sh 的插件能被扫进来（合法，不是坏清单）",
          _probs5 == () and [x.name for x in _specs5] == ["decl"], str(_probs5))
    _decl = _specs5[0]
    check("★ 它被记为「没有作业侧」，而不是「坏掉的插件」",
          _decl.needs_job is False, str(_decl.needs_job))

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

        _pj3 = d.dispatch(UID, os.getgid(), {"op": "plugins"})
        _decl_row = next(x for x in _pj3["data"]["plugins"] if x["name"] == "decl")
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
        _now = d.session_view(_st2.get(_sid), with_secret=False)
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
    check("★ 老库（没有 service_plugin 列）也被自动补上",
          "service_plugin" in _cols, str(sorted(_cols))[:120])
    check("补出来的解析键是 NULL —— 老库里的会话确实不知道自己是哪一版",
          _st.get("kept") is not None and _st.get("kept")["service_plugin"] is None,
          repr((_st.get("kept") or {}).get("service_plugin")))
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
        _awk = weave_one(_rb, _sp.source_dir, _sp.name, _sp.id, _out)
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
                        open(os.path.join(_sp.source_dir, "job", "start.sh"),
                             encoding="utf-8").read()) is None)
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
    for _n, _i, _body in _tl_def:
        os.makedirs(os.path.join(_tld, _n, "job"), exist_ok=True)
        with open(os.path.join(_tld, _n, "job", "start.sh"), "w",
                  encoding="utf-8") as _f:
            _f.write(_body)
        with open(os.path.join(_tld, _n, "plugin.json"), "w",
                  encoding="utf-8") as _f:
            _f.write(json.dumps({"id": _i, "name": _n, "version": "1.0.0",
                                 "site": {"defaultCpus": 1, "defaultMem": "1G"}}))
    _tl_specs, _tl_probs = mod.scan_plugins(_tld)
    check("顶层语句的假插件被扫进来（这条用例自己的前提）",
          sorted(s.name for s in _tl_specs) == ["loud", "quiet"], str(_tl_probs))
    _tl_by = {s.name: s for s in _tl_specs}
    # ★ 这里逐插件织 —— **与 deploy.sh 同一个形状**。如果哪天退回"共处一份"，
    #   下面第二条会立刻红，而红的方式正是它要防的那件事。
    _tl_home = {}
    for _n in ("loud", "quiet"):
        _o = os.path.join(tmpdir, "tl-%s.sbatch" % _n)
        weave_one(_rb, _tl_by[_n].source_dir, _n, _tl_by[_n].id, _o)
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
