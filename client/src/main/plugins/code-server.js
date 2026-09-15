'use strict';
/**
 * plugins/code-server.js —— 浏览器里的 IDE。
 *
 * 这个插件在客户端这边要做的全部事情：把 code-server 页面放进窗口主体，
 * 然后自动登录（口令是作业自己生成、经会话文件交上来的）。
 *
 * ★ 它是唯一会创建 `WebContentsView` 的插件，这就是 `hasView: true` 的含义 ——
 *   框架据此知道"会话结束时要把那块原生层收掉，否则面板上的按钮被它盖住、
 *   用户出不来"。
 */

module.exports = {
  name: 'code-server',
  title: '开发环境',

  // 老守护进程不返回 service_kind 时兜到它（理由见 registry.defaultPlugin()）。
  defaultFor: true,

  // 占住窗口主体。
  hasView: true,

  // 要一个布局组。布局组存在的理由是**浏览器的** localStorage 按 origin 隔离 ——
  // 只有跑在浏览器里的插件才需要它。
  needsLayout: true,

  needsPubkey: false,

  // 提交之前不需要任何准备（布局组由框架分配，口令由作业自己生成）。
  prepare: null,

  // 隧道端口：用布局组自己的端口，于是同一个布局组的若干条连接共用一个监听端口。
  preferredPort(ctx, layoutId) {
    return ctx.config.layoutPort(ctx.cfg, layoutId);
  },

  // 关窗会杀掉什么。见 windows.js 的确认对话框。
  closeWarning: {
    message: '关闭窗口会结束这个开发会话。',
    detail: '作业会被取消，编辑器里**没有保存的改动会丢失**。',
  },

  attach,
};

/**
 * 让窗口里的 code-server 视图与快照一致。**幂等**，每次状态变化都会调。
 *
 * 判定三件事：视图在不在、origin 变没变、partition 变没变。
 * 前两者只需重新 loadURL；**第三者必须销毁重建** —— partition 是构造期属性
 * （见 windows.js 的 showCodeServer）。
 */
async function attach(ctx, snap) {
  const partition = ctx.config.partitionForLayout(snap.layoutId);
  const w = ctx.win;
  if (w.hasCodeView() && w.codeOrigin === snap.origin && w.codePartition === partition) {
    return;
  }
  const rebuild = w.hasCodeView() && w.codePartition !== partition;
  await openView(ctx, snap);
  if (rebuild) {
    ctx.notice('info', '已切换到新的布局组，编辑器页面已重新加载。');
  }
}

async function openView(ctx, snap) {
  // 演示模式下给 code-server 页面注入一个只读的小桥，用来接收「被外壳吞掉的
  // 按键」，好让你在同一屏里对照验证快捷键。**真实模式绝不注入** —— 那会污染 IDE。
  // ★ partition 名按**布局组 id** 命名，不按端口。按端口命名会让「组 A 被回收后
  //   端口被新组 B 复用」时，B 的所谓「空白布局」继承 A 的 localStorage 与登录 cookie。
  const partition = ctx.config.partitionForLayout(snap.layoutId);
  await ctx.win.showCodeServer(snap.origin, partition, snap.demo);

  const ses = ctx.win.codeSession;
  if (!ses) return;

  const s = ctx.session() || {};
  if (s.auth_mode === 'none') {
    // auth_mode 可能是 none（配置改一行就能退回）。此时不要 POST /login。
    return;
  }

  const res = await ctx.login(ses, snap.origin, s.auth_password);
  if (res.ok) {
    ctx.notice('ok', '已自动登录 code-server。');
    await ctx.win.reloadCodeServer();
  } else if (res.reason === 'no_cookie') {
    ctx.notice('error',
      `自动登录失败（HTTP ${res.status}，未拿到会话 cookie）。`
      + '可能是会话口令已变化，或 code-server 升级后改动了登录端点。');
  } else if (res.reason === 'no_password') {
    ctx.notice('error', '控制节点还没返回会话口令。可能需要稍等片刻，或查看「状态」。');
  } else {
    ctx.notice('error', '自动登录出错：' + res.reason);
  }
}
