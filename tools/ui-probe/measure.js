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

/**
 * measure.js — 页面里量排布的那一半。
 *
 * 它判一件事：有没有东西伸出它所在区域的右边界。用户报的症状是"文字和按钮
 *   都超出了范围"，而那是同一个形状：一个不许压缩的盒子装了一句很长的话。
 *
 * 判据落在滚动容器的 `scrollWidth` 上，不是落在"右边缘坐标比一比"上。
 *   两者在真溢出的地方都会响，但前者不会把按设计通栏的东西算成溢出
 *   （第二/三屏顶上那条身份带是靠负外边距顶到滚动条槽的，它本来就该到边上）。
 *   右边缘那一遍只用来指出是谁伸出去的。
 *
 * 一个用例先过一个哨兵：夹具没渲染出来就直接报失败。少了这一步，一格空白
 *   会以"一处溢出都没有"的样子通过，而那正是这个仓库最忌讳的假绿。
 *
 * 结果写进 `#probe-report` 那一个 pre 里，外层按两端记号抠出来。
 */
(function () {
  'use strict';

  var CASE = new URLSearchParams(location.search).get('case') || 'conns';
  var F = window.__PROBE_FIXTURE || {};

  /**
   * 让已经排上的活儿跑完：boot 是几层 Promise 套出来的。
   *
   * 这里只等 setTimeout，不碰 requestAnimationFrame。这个无头壳没有合成器在推帧，
   *   rAF 的回调可以一直不落地（实测：量尺卡在那一句上，一路等到超时，而控制台
   *   一个字都不报）。量排布也不需要它：读一次 `getBoundingClientRect()` 就会
   *   强制把布局刷出来。
   */
  function settle() {
    var p = Promise.resolve();
    for (var i = 0; i < 12; i++) {
      p = p.then(function () {
        return new Promise(function (r) { setTimeout(r, 0); });
      });
    }
    return p;
  }

  function $(id) { return document.getElementById(id); }

  function visible(el) {
    if (el.closest('.hidden')) return false;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** 按设计通栏的那几条：它们的右边缘本来就顶到滚动条槽上。 */
  var EXEMPT = ['#screen-plugins > .sec-head', '#screen-jobs > .sec-head',
    '#screen-debug > .sec-head'];

  function describe(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      s += '.' + el.className.trim().split(/\s+/).join('.');
    }
    return s;
  }

  function snippet(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  }

  function regions() {
    var out = [];
    ['panel', 'statusbar'].forEach(function (id) {
      var el = $(id);
      if (el) out.push(el);
    });
    return out;
  }

  var SCROLLERS = ['#panel', '.conns', '.jobs', '.notices', '.joblog', '#statusbar'];

  /**
   * 展开着的高级选项里那五格，数一遍。
   *
   * 判据是"那一行真的落在它那个 `<details>` 画出来的盒子里"，既不是"DOM 里有几个"，
   *   也不是上面那个 `visible()`。这个无头壳里，收着的 `<details>` 里那几个孩子
   *   照样有一个非零的矩形 —— `content-visibility: hidden` 把上一次的布局留着，
   *   而那个矩形从 details 自己的盒子（只有摘要那一行高）底下伸出去。
   *   实测（`plugins` 那一格，收着）：details 的盒子是 19px 高，而那一行的矩形
   *   挂在它下面 126px 处。
   *   所以"收着"与"展开着"在 `visible()` 眼里长得一模一样 —— 少了这一条，
   *   一个把 `<details>` 删掉、只留 DOM 的改动会让这一格照样全绿。
   */
  function drawnAdvFields() {
    var n = 0;
    Array.prototype.forEach.call(
      document.querySelectorAll('#plugin-blocks details.plug-adv'),
      function (d) {
        var row = d.querySelector('.row');
        // `visible()` 挡的是"这一屏根本不在前台"那一档（那时两个盒子的坐标都是 0，
        //   下面那条包含判断会把 0 当成"在里面"）；它挡不住收着的 details，
        //   那一档由包含判断挡。
        if (!row || !visible(row)) return;
        var db = d.getBoundingClientRect();
        var rb = row.getBoundingClientRect();
        if (rb.top < db.top || rb.bottom > db.bottom + 1) return;
        n += row.querySelectorAll(':scope > div').length;
      });
    return n;
  }

  function measure() {
    var out = { case: CASE, viewport: { w: innerWidth, h: innerHeight },
      scroll: [], offenders: [], exempted: 0, scanned: 0, fonts: null };

    out.fonts = (document.fonts && document.fonts.status) || 'unknown';

    SCROLLERS.forEach(function (sel) {
      Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
        if (!visible(el)) return;
        if (el.scrollWidth > el.clientWidth + 1) {
          out.scroll.push({ sel: describe(el), scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth });
        }
      });
    });

    regions().forEach(function (region) {
      var cs = getComputedStyle(region);
      var padR = parseFloat(cs.paddingRight) || 0;
      var rr = region.getBoundingClientRect();
      var edge = rr.left + region.clientWidth - padR;
      Array.prototype.forEach.call(region.querySelectorAll('*'), function (el) {
        if (!visible(el)) return;
        out.scanned++;
        if (EXEMPT.some(function (sel) { return el.closest(sel); })) { out.exempted++; return; }
        var r = el.getBoundingClientRect();
        if (r.right > edge + 1) {
          out.offenders.push({ sel: describe(el), over: Math.round(r.right - edge),
            text: snippet(el) });
        }
      });
      // 区域自己也是一个盒子：它自己滚出来了就是有东西伸出去
      if (region.scrollWidth > region.clientWidth + 1
          && !out.scroll.some(function (x) { return x.sel === describe(region); })) {
        out.scroll.push({ sel: describe(region), scrollWidth: region.scrollWidth,
          clientWidth: region.clientWidth });
      }
    });

    // 数出来几个，写进报告。少了这一格，"这一格什么都没画"与"这一格画了但没有
    //   溢出"在报告里长得一样，而前者是本文件最该抓住的一种假绿
    //   （哨兵抓的是"整格是空的"，这一格抓的是"某一类元素一个都没有"）。
    out.counts = {
      armed: document.querySelectorAll('.armed').length,
      pluginRows: document.querySelectorAll('#plugin-data .plug-consent-item').length,
      pluginBlocks: document.querySelectorAll('#plugin-blocks .plug').length,
      // 展开着的高级选项里那五格。它数的是"真的画出来了几格"（见上面那个
      //   `drawnAdvFields`）—— 收起态必然是 0，那一格的 0 是应该的。
      advFields: drawnAdvFields(),
      jobRows: document.querySelectorAll('#job-list .job').length,
      portAsk: $('sb-port').classList.contains('hidden') ? 0 : 1,
    };

    var de = document.documentElement;
    out.docScroll = de.scrollWidth > de.clientWidth + 1;
    out.fatal = !$('fatal-banner').classList.contains('hidden')
      ? ($('fatal-why').textContent || '界面给出了失败横幅')
      : null;
    return out;
  }

  /** 那几屏怎么摆出来，以及"真的摆出来了"的凭据。 */
  var CASES = {
    // 首屏：连接列表 + 本机的插件数据。桩给的 bootstrap 里一条连接都没有，
    //   于是它还会把「新建连接」那张表单一起画出来。
    conns: {
      setup: function () { return Promise.resolve(); },
      sentinel: function () { return document.querySelectorAll('#plugin-data .plug-desc').length > 0; },
      what: '首屏（含本机的插件数据那一块）',
    },

    // 同一屏，点开那一行的删除确认。用户报的那张截图就是这一格。
    'conns-armed': {
      setup: function () {
        var btn = document.querySelector('#plugin-data button');
        if (!btn) return Promise.resolve();
        btn.click();
        return Promise.resolve();
      },
      sentinel: function () { return !!document.querySelector('#plugin-data .armed'); },
      what: '首屏，插件数据那一行的删除确认展开',
    },

    // 第二屏：三个插件块，其中一个标题很长、一个站点关着、一个起不来。
    plugins: {
      setup: function () {
        setConnected(true);
        renderPlugins(F.pluginsView || {});
        showScreen('plugins');
        return Promise.resolve();
      },
      sentinel: function () { return document.querySelectorAll('#plugin-blocks .plug').length >= 3; },
      what: '第二屏（插件块）',
    },

    // 同一屏，把每一块的高级选项展开、并把站点那份分区表喂进去。
    //
    // 这一格是"五格那一行会不会换行、换行之后会不会顶出去"唯一量得到的地方：
    //   上一格里那个 `<details>` 是收着的，那五格根本没被画出来过，
    //   所以那一行从来没被量过 —— 这正是"它红了才怪"的原因。
    //   喂分区表也是必须的：不喂的话那两个下拉各自只有一个选项，而这一格要量的
    //   恰恰是"选项文字很长的时候那一格会不会把卡片顶出去"。
    'plugins-adv': {
      setup: function () {
        setConnected(true);
        renderPlugins(F.pluginsView || {});
        // 分区表是站点级的（全局一份），到得比插件块早或晚都可能 —— 这里刻意
        //   在块画好之后再喂，走的就是"它变了，每一块里那一格都跟着换"那条路。
        renderPartitions(F.partitions || []);
        showScreen('plugins');
        Array.prototype.forEach.call(
          document.querySelectorAll('#plugin-blocks details.plug-adv'),
          function (d) { d.open = true; });
        return Promise.resolve();
      },
      // 展开之后那五格必须真的画出来了（判据见上面那个 `drawnAdvFields`：
      //   "DOM 里有"是不够的，这个无头壳里收着的 details 也留着那几个孩子的矩形）。
      //   少了这一步，一格空白会以"一处溢出都没有"的样子通过 —— 而"没画"与
      //   "画了但不溢出"在这一格眼里必须分得开。
      sentinel: function () { return drawnAdvFields() >= 5; },
      what: '第二屏（每一块的高级选项都展开、分区表已喂）',
    },

    // 作业屏：三行。它画的不是 `renderSessions` 那一份，而是 `JOBS` 那一格
    //   （由主进程的 `app:jobs` 填），所以这里直接喂 `JOBS` 再调 `renderJobs()`。
    //   `JOBS` 是脚本级的 `let`，不是 `window` 上的属性，但同源的另一个脚本
    //   读得到它（这一条要是改成 `window.JOBS` 就会静默地什么都不画）。
    jobs: {
      setup: function () {
        setConnected(true);
        // 走真的那一条：`showScreen('jobs')` 自己会问一次站点（`refreshJobs`），
        //   作业由桩答出来。自己塞 `JOBS` 再调 `renderJobs()` 看起来更直接，实测
        //   不行：那一句同步画完之后，`refreshJobs` 的应答才落地，列表被它重置成
        //   "一条都没有"（桩对 `jobs()` 回 null 时就是这个样子）。
        showScreen('jobs');
        return Promise.resolve();
      },
      sentinel: function () { return document.querySelectorAll('#job-list .job').length >= 3; },
      what: '作业屏（作业列表）',
    },

    // 状态条上那条三选一。30px 高，理由太长就会把按钮挤掉。
    'statusbar-port': {
      setup: function () { renderPortAsk(F.portAsk || {}, null); return Promise.resolve(); },
      sentinel: function () { return !$('sb-port').classList.contains('hidden'); },
      what: '状态条：端口被占那一问',
    },
  };

  function report(o) {
    var pre = document.createElement('pre');
    pre.id = 'probe-report';
    pre.textContent = '\nPROBE-REPORT-BEGIN\n' + JSON.stringify(o) + '\nPROBE-REPORT-END\n';
    document.body.append(pre);
  }

  function main() {
    var c = CASES[CASE];
    if (!c) { report({ case: CASE, fatal: '没有这个用例' }); return; }
    var ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    ready.then(settle).then(function () {
      return c.setup();
    }).then(settle).then(function () {
      if (!c.sentinel()) {
        report({ case: CASE, what: c.what, fatal: '这一格没有渲染出来，量到的会是空的' });
        return;
      }
      var o = measure();
      o.what = c.what;
      report(o);
    }).catch(function (e) {
      report({ case: CASE, what: c.what, fatal: '量的时候抛了：' + ((e && e.message) || e) });
    });
  }

  main();
}());
