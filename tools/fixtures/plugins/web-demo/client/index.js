// Copyright 2026 JesseFather
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';
/**
 * web-demo 的客户端侧 —— 测试夹具。
 *
 * 它扮演的是"一个有界面的 web 插件"：界面由框架按 `contributes.surface`
 *   打开，插件自己只做自动登录。这与任何真实 web 插件的分工相同，所以基座
 *   的能力测试挂在它身上，不再依赖仓库里某一棵具体的插件树。
 *
 * 登录的判定依据是分区里有没有 cookie，不是 HTTP 状态码 —— 理由见
 *   `weblogin.js`：网页表单登录在口令错时返回 200 是常见形态。
 */

module.exports = {
  closeWarning: {
    message: '关闭窗口会结束这个会话。',
    detail: '作业会被取消，没有保存的改动会丢失。',
  },

  attach,
};

/** 界面已经由框架打开了，这里只做登录。幂等。 */
async function attach(ctx, snap) {
  const ses = ctx.win.surfaceSession;
  if (!ses) return;

  const s = ctx.session() || {};
  if (s.auth_mode === 'none') return;

  const once = (key) => ctx.once(`${key}|${snap.sessionId || ''}`);

  const res = await ctx.login(ses, snap.origin, s.auth_password);
  if (res.ok) {
    if (once('login-ok')) ctx.notice('ok', '已自动登录。');
    await ctx.win.reloadSurface();
  } else if (res.reason === 'no_cookie') {
    if (once('login-no-cookie')) {
      ctx.notice('error',
        `自动登录失败（HTTP ${res.status}，未拿到会话 cookie）。`
        + '可能是会话口令已变化，或服务升级后改动了登录端点。');
    }
  } else if (res.reason === 'no_password') {
    if (once('login-no-password')) {
      ctx.notice('error', '控制节点还没返回会话口令。可能需要稍等片刻，或查看「状态」。');
    }
  } else if (once('login-error')) {
    ctx.notice('error', '自动登录出错：' + res.reason);
  }
}
