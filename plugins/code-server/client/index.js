'use strict';
/**
 * code-server 的客户端侧。
 *
 * ★ 这里**没有**建视图的代码 —— 那块界面由**框架**按 `plugin.json` 里的
 *   `contributes.surface` 打开（见 index.js 的 ensureSurface）。插件只负责
 *   框架做不到的那件事：**自动登录**（口令是作业自己生成、经会话文件交上来的）。
 *
 *   这个分工不是洁癖。把"开一块界面"交给框架之后，一个**没有客户端代码**的
 *   声明式插件（Phase 2 的 Jupyter / RStudio 那一类）也能开界面了 —— 因为
 *   开界面这件事本来就不需要代码，只需要一句声明。
 */

module.exports = {
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
 * 界面已经由框架打开了，这里只做登录。**幂等**，每次状态变化都会调。
 *
 * 判定依据是**分区里有没有 cookie**，不是 HTTP 状态码 —— 理由见 weblogin.js：
 * 这套网页表单登录的协议在口令错时返回的是 200（code-server 4.135.0 实测）。
 *
 * ★ 往哪 POST、字段叫什么、看哪个 cookie，全部来自本插件 `plugin.json` 的
 *   `contributes.login` —— 这个文件里一个都不写死。
 */
async function attach(ctx, snap) {
  const ses = ctx.win.surfaceSession;
  if (!ses) return;                       // 界面还没起来，轮不到登录

  const s = ctx.session() || {};
  if (s.auth_mode === 'none') {
    // auth_mode 可能是 none（配置改一行就能退回）。此时不要 POST /login。
    return;
  }

  const res = await ctx.login(ses, snap.origin, s.auth_password);
  if (res.ok) {
    ctx.notice('ok', '已自动登录 code-server。');
    await ctx.win.reloadSurface();
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
