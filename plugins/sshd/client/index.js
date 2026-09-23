'use strict';
/**
 * SSH 中转站的客户端侧。
 *
 * 让原生 VS Code Remote-SSH、codex 这类**要求 ssh 连接**的工具能用上一个跑在
 * 作业里的会话。作业侧起的是一个用户态 sshd（见 `job/start.sh` 的 `start_sshd`）。
 *
 * ★ `plugin.json` 里没有 `contributes.surface`，所以框架**连一块界面都不会建**
 *   —— 用户要用的东西跑在他自己的机器上，客户端唯一要做的事就是让
 *   `ssh slurmate` 这个名字能连进来（见 sshconfig.js）。
 *
 * ★ 它也不需要布局组（`contributes.layout = false`）。布局组存在的理由是
 *   **浏览器的** localStorage 按 origin 隔离，而中转站没有浏览器。
 */

const sshconfig = require('./sshconfig.js');

module.exports = {
  // ★ 这里**没有** preferredPort。本地端口不是插件的事：这个插件没声明
  //   `contributes.layout`，于是会话用中转基准端口（基座的常量）。真被占了隧道
  //   会顺移，而**实际**端口由 `attach()` 写进用户那份 ssh 配置的 `Port` 行 ——
  //   那边必须反映当前真值，而用户认的那个名字（别名）恒定，端口漂移对他无害。

  closeWarning: {
    message: '关闭窗口会结束这个 SSH 中转会话。',
    detail: '你用 ssh slurmate 连上去的终端、VS Code 远程窗口和 codex 会话都会'
      + '当场断开，作业也会被取消。',
  },

  prepare,
  attach,
};

/**
 * 提交之前的准备：确保有那把一次性密钥。**先备好再提交** —— 没有它守护进程会
 * 拒绝这次提交（code 2），而那要花掉一整趟往返。
 *
 * 返回 `{ ok: true, sshPubkey }` 或 `{ ok: false, message }`。
 */
function prepare(ctx) {
  // ★ 钥匙住在**框架给的插件数据目录**里，不再往家目录里发明位置（见 sshconfig.js）。
  //   算不出根来会抛 —— 那在这里是一件"提交不下去、但说得出原因"的事。
  let dataDir;
  try {
    dataDir = ctx.dataDir();
  } catch (e) {
    return { ok: false, message: `没法确定中转站的数据放在哪儿：${e.message}` };
  }
  const k = sshconfig.ensureRelayKey(dataDir, ctx.keys);
  if (!k.ok) {
    return { ok: false, message: `无法准备中转站用的密钥：${k.detail}` };
  }
  if (k.created) {
    ctx.notice('info',
      `已为中转站生成一把一次性密钥，存在 ${sshconfig.pathsFor(dataDir).identity}。`
      + '它只被写进你自己作业的 authorized_keys —— 任何登录入口都不认它，'
      + '所以要连进来仍然需要你自己那把 IDM 密钥。');
  }
  return { ok: true, sshPubkey: k.publicKeyLine };
}

/**
 * 中转站就绪：把本地 ssh 配好。
 *
 * **幂等**，每次状态变化都会调（心跳告警、隧道重建都会触发）。所以值没变就直接
 * 返回 —— 否则用户每 45 秒收到一条一模一样的通知，等于没有通知，而每次心跳都
 * 重写一遍 ssh 配置也是白白惊动用户的杀毒/同步软件。
 */
async function attach(ctx, snap) {
  const port = snap.localPort;
  if (!port) return;                       // 还没监听，还轮不到写配置

  // 登录节点上的用户名 —— 取**这一条会话所属那条连接**里那个（用户亲手填的）。
  //
  // ★ **不回落 `ctx.whoami()`。** 它是一个模块级单值（"最近一次连上的是谁"），
  //   而切换活跃连接**不会**停掉已经在跑的会话 —— 于是它可能给出**另一个站点**的
  //   用户名。写错这个字段的症状是"ssh 连上了，但不是你要的那台机器"，而用户
  //   完全看不出为什么。拿不到就不写，说清原因。
  const conn = ctx.connection();
  const user = conn && conn.user;
  if (!user) {
    ctx.notice('error',
      '中转站已就绪，但这条会话所属的连接已经不在了，所以不知道要用哪个用户名'
      + `写 ssh 配置。配置没有写 —— 你仍然可以直接连 127.0.0.1:${port} 使用它。`);
    return;
  }

  if (!ctx.once(`${port}|${user}|${snap.sshHostKey || ''}`)) return;

  // 两个根都要，而且它们**不是一回事**：`dataDir()` 是这个插件自己的落点，
  // `home()` 是**用户自己的**家目录（`~/.ssh/config` 在那儿 —— 那是他的东西，
  // 我们只借两行）。见 sshconfig 里那两个函数的分工。
  let dataDir;
  try {
    dataDir = ctx.dataDir();
  } catch (e) {
    ctx.notice('error', `中转站已就绪，但没能确定它该把配置写在哪儿：${e.message}`);
    return;
  }
  const home = ctx.home();
  const inc = sshconfig.ensureInclude({ dataDir, home });
  const w = sshconfig.writeRelayConfig({ dataDir, port, user, hostKey: snap.sshHostKey });

  if (!w.ok) {
    ctx.notice('error',
      `中转站已就绪，但没能写出 ssh 配置（${w.detail || w.error}）。`
      + `你仍然可以直接连 127.0.0.1:${port} 使用它。`);
    return;
  }

  // ── 搬家：新位置**写成功之后**，才把旧位置那三个文件清掉 ──
  //   ★ 顺序是承重的：反过来的话，写新位置失败时用户会落到"两边都没有"。
  //   ★ 这一句话在 `ctx.once` 那道闸之后，所以正常情况下只发生一次。
  const clean = sshconfig.dropLegacyFiles(home);
  if (clean.deleted.length) {
    ctx.notice('info',
      `中转站的本地配置搬到了新位置（${sshconfig.pathsFor(dataDir).dir}），`
      + `旧那三个文件已经从 ${sshconfig.legacyPaths(home).dir} 清掉了。`);
  }
  if (clean.failed.length) {
    const dir = sshconfig.legacyPaths(home).dir;
    // ★ 只提示一次：读不到的家目录是**永久失败**，每次心跳都报一遍等于没有提示。
    if (ctx.once(`legacy-cleanup|${dir}`)) {
      ctx.notice('warn',
        `${dir} 里那三个旧文件没能删掉（${clean.failed[0].reason}）。`
        + '它们已经不再被用到了 —— 删不掉不影响使用，你也可以自己删掉它们。');
    }
  }

  // Include 没加上时**照样**把我们自己那份配置写好了：用户可以手工加那一行，
  // 也可以自己 ssh -F <路径>。但必须说出来 —— 不说的话他敲 `ssh slurmate` 会得到
  // 「Could not resolve hostname」，而根因是我们没能改他的文件。
  if (!inc.ok) {
    ctx.notice('warn',
      `没能把 Include 加进 ${inc.path}（${inc.detail}）。`
      + '请手工在那个文件的**最上面**加一行：\n'
      + `Include ${sshconfig.pathsFor(dataDir).config}`);
  } else if (inc.changed) {
    ctx.notice('info',
      `已在 ${inc.path} 最上面加了一行 Include，指向 Slurmate 自己的 ssh 配置。`
      + '（只加了这一行，你原有的内容一个字都没动。）');
  }

  if (!w.strict) {
    ctx.notice('warn',
      '这次没能拿到作业内 sshd 的主机公钥（控制节点没返回它 —— 守护进程可能还是'
      + '旧版本），本次连接按「首次信任」处理。它只影响第一次连接，之后会一直核对。');
  }

  ctx.notice('ok',
    `SSH 中转站已就绪。在终端里执行 ssh ${sshconfig.SSH_ALIAS}，或用 VS Code 的`
    + `远程连接填 ${sshconfig.SSH_ALIAS}（主机名就是这一个词，端口和用户名都已经`
    + '配好了）。\n'
    + '会话结束前它一直有效；作业里的东西跑在作业的 cgroup 里，作业一停全部回收。');
}
