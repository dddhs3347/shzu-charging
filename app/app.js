/* app.js — 应用主逻辑：路由 / 渲染 / 刷新 / 下拉 / 设置
 * 依赖全局：SHZU(config.js) → SHZU.util(util.js) → SHZU.charts(charts.js) → SHZU.api(api.js)
 */
(function (global) {
  'use strict';

  var SHZU = global.SHZU;
  var U = SHZU.util;
  var C = SHZU.charts;
  var api = SHZU.api;

  /* charts.js 是独立的 shell 资源：它加载失败（网络抖动、SW 缓存损坏、
   * ERR_CACHE_READ_FAILURE）时 C.stackBar 之类的函数就是 undefined。
   * 早先版本没做保护，campusCard() 里直接调 C.stackBar 抛 TypeError，
   * 异常一路冒泡到 boot() → 整个首页**白屏**。
   * 这里统一包一层：拿不到就返回 null，调用方按「没有图表」渲染，
   * 数字和列表照常显示——图表是锦上添花，不该决定整页死活。
   *
   * 名字叫 safeChart 而不是 chart：renderHistoryChart() 里有个局部变量
   * 就叫 chart（历史曲线的返回值），同名会被 var 提升遮蔽掉。 */
  function safeChart(fnName, args) {
    if (!C || typeof C[fnName] !== 'function') { return null; }
    try {
      return C[fnName].apply(null, args || []);
    } catch (e) {
      return null;
    }
  }

  /* =========================================================
   * 状态
   * ========================================================= */
  var BUFFER_KEY = 'shzu.buffer.v1';
  var BUFFER_MAX = 96;
  var BUFFER_MIN_GAP_MS = 25 * 1000;

  var state = {
    snapshot: null,
    // live（relay 直连） | public-feed（ntfy 公共频道） | cache | sw-cache | none
    source: 'none',
    lastError: null,
    swCacheAge: 0,
    loading: false,
    view: 'home',
    campusId: null,
    // 数据源详情的当前源 id（#source/<sourceId>）。与 campusId 分开存，
    // 免得「返回」时把校区详情的上下文串到源详情上。
    sourceId: null,
    history: {
      campus: 'all', hours: 24, bucket: '10m',
      data: null, loading: false, error: null, fromCache: false
    },
    settings: SHZU.loadSettings(),
    timer: null,
    buffer: [],
    expanded: {},
    lastRenderedDataAt: null,
    // relay GET /api/sources 的结果（各数据源最后采集时间/限流状态）。
    // null = 这条链路不可用（公共频道模式 / 旧 relay 404 / 没配 relay），
    // 主页的「数据源」区块据此整块隐藏。
    sourceList: null,
    // 端口表筛选（纯前端过滤，不重新请求）
    ports: {
      status: 'all',     // all | free | busy | offline
      campus: 'all',     // all | 六校区 id
      source: 'all',     // all | 数据源 id（station.source_id；没有该字段的数据算 all）
      rendered: 0,       // 实际渲染的端口数（测试断言用）
      total: 0           // snapshot 里的端口总数（测试断言用）
    },
    // 原始快照（normalizeSnapshot 之后、叠反馈层之前）。
    // 反馈层每次都要从原始快照重新算，不能在上面反复叠 —— 否则
    // 云端计数从 20 降到 19 时，raw_status 已经被写坏，恢复不回去了。
    rawSnapshot: null,
    // 端口反馈（其他用户提交的「不可用」次数）。
    // counts 的 key 是 device.id，来自云中转 GET /feedback。
    feedback: {
      counts: {},        // {device_id: 次数}
      threshold: 20,     // 达到多少次算不可用
      loaded: false,
      loading: false,
      fromCache: false
    },
    // 首次使用手册
    guide: {
      page: 1,
      okEnabled: false,  // 第二页那个灰色等待按钮是否已可点
      timer: null
    },
    /* 风控惩罚状态（用户要求：触发一分钟 20 次的限流后，弹窗告知
     * 「您已触发风控限制，请两分钟后再试」，关掉弹窗后锁刷新、停发数据两分钟）。
     *
     * until 是毫秒时间戳，0 = 没被罚。存盘（SHZU.setRateLimitUntil），
     * 所以被罚期间关掉 App 再打开也仍然在罚期里 —— 否则重开一次就又发一轮
     * 请求，正好把惩罚期续上，永远好不了。
     * timer 是那个每秒刷新倒计时文案的定时器。 */
    rateLimit: {
      until: 0,
      timer: null,
      shownFor: 0   // 已经为哪个 until 弹过窗，防止每秒重复弹
    }
  };

  var dom = {};

  /* =========================================================
   * 小工具
   * ========================================================= */
  function q(id) { return document.getElementById(id); }

  function toast(msg, ms) {
    var t = dom.toast;
    if (!t) { return; }
    t.textContent = msg;
    t.hidden = false;
    // 强制回流，确保过渡生效
    void t.offsetWidth;
    t.classList.add('is-show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      t.classList.remove('is-show');
      clearTimeout(toast._h);
      toast._h = setTimeout(function () { if (!t.classList.contains('is-show')) { t.hidden = true; } }, 240);
    }, ms || 1900);
  }

  function setBanner(elm, show, text) {
    if (!elm) { return; }
    if (text !== undefined) {
      var span = elm.querySelector('.banner-text');
      if (span) { span.textContent = text; }
    }
    elm.hidden = !show;
  }

  /* =========================================================
   * 首次使用手册（一次性弹窗）
   * ---------------------------------------------------------
   * 需求原文：
   *   第一页「由于铭创电子及成本原因，两个数据的刷新时间不同，敬请谅解。」
   *          （2026-10-21 用户改稿，替换原来的「由于铭创电子官方风控原因，
   *           该小程序数据刷新约五分钟一次。石河子大学充电桩约十五秒一次。」）
   *   第二页「如果充电桩数据不准确可以点击端口信息提交反馈。」
   *   「使用手册弹窗出现的时候不可点击其他位置，只能点击下一步」
   *   第二页「下一步」变「我已知晓」，并在它左边加一个灰色按钮
   *   「需要等待十秒后方可点击」，十秒后才可点。
   *
   * 几个必须做对的细节：
   *   - 遮罩不绑任何点击/关闭事件 → 点空白处什么都不发生（需求硬要求）
   *   - 不用 dialog/confirm，纯 DOM，z-index 200 压住 tabbar(40) 与 toast(80)
   *   - 计时只用 setTimeout/setInterval，兼容 Chrome 80
   *   - 用户点掉「我已知晓」（或点了那个 10 秒按钮）才写 guideSeen，
   *     中途刷新页面会重新弹 —— 手册没看完不该算看过
   * ========================================================= */
  var GUIDE_WAIT_SECONDS = 10;
  /* 第二页左边那个灰色按钮的文案。
   *
   * 需求演进（2026-10-21 用户追加）：
   *   原要求是「需要等待十秒后方可点击」这句死文案；
   *   新要求是「需要实时显示还需要等多少秒，然后到 0 之后直接消失，只剩我已知晓」。
   * 所以现在用模板逐秒改写文案，倒计时结束**整个按钮隐藏**（不是变可点）。
   * 模板里的 %n 会被替换成剩余秒数。 */
  var GUIDE_WAIT_TEMPLATE = '还需等待 %n 秒';
  var GUIDE_WAIT_TEXT = '需要等待十秒后方可点击';

  /* URL 控制（给自动化测试和排障用）：
   *   ?guide=1   强制显示，忽略已读标记
   *   ?guide=off 强制不显示
   * 两种都要能压过 localStorage，所以单独抽一个函数，别和 guideSeen() 混。 */
  var guideQuery = null;
  function readQueryGuide() {
    if (guideQuery !== null) { return guideQuery; }
    try {
      var m = /[?&]guide=([^&#]*)/.exec(global.location.search || '');
      if (!m) { guideQuery = ''; return guideQuery; }
      var raw = String(m[1] || '').toLowerCase();
      if (raw === '1' || raw === 'on' || raw === 'true') { guideQuery = 'on'; }
      else if (raw === 'off' || raw === '0' || raw === 'none') { guideQuery = 'off'; }
      else { guideQuery = ''; }
    } catch (e) { guideQuery = ''; }
    return guideQuery;
  }

  /* 是否需要弹手册：query 优先级最高，其次才看 localStorage。
   * 注意 ?guide=1 不写 localStorage（强制显示只是本次），
   * 而 ?guide=off 也只是本次不弹，都不会污染「已读」状态。 */
  function shouldShowGuide() {
    var q = readQueryGuide();
    if (q === 'on') { return true; }
    if (q === 'off') { return false; }
    return !guideSeenSafe();
  }

  function guideSeen() {
    try { return SHZU.lsGet(SHZU.storeKey.guideSeen) === '1'; } catch (e) { return false; }
  }

  function markGuideSeen() {
    try { SHZU.lsSet(SHZU.storeKey.guideSeen, '1'); } catch (e) {}
  }

  function guideSetPage(page) {
    state.guide.page = page;
    if (dom.guideStep) { dom.guideStep.textContent = '第 ' + page + ' / 2 页'; }
    var pages = U.$$('.guide-page');
    for (var i = 0; i < pages.length; i++) {
      var n = parseInt(pages[i].getAttribute('data-page'), 10);
      pages[i].classList.toggle('is-active', n === page);
    }
    var next = dom.btnGuideNext;
    var wait = dom.btnGuideWait;
    if (page === 2) {
      /* 第 2 页两件事同时发生：
       *   1. 下一步按钮变成「我已知晓」，而且**先禁用** —— 只有等下面那个
       *      灰色按钮倒计时结束，用户才能点它。这样「必须等十秒」就是硬约束，
       *      不是靠用户自觉。
       *   2. 左边出现灰色按钮，文案「需要等待十秒后方可点击」，disabled。 */
      if (next) {
        next.textContent = '我已知晓';
        next.disabled = true;
      }
      if (wait) {
        wait.hidden = false;
        wait.disabled = true;
        wait.classList.remove('is-ready');
        wait.removeAttribute('data-ready');
        wait.textContent = GUIDE_WAIT_TEXT;
      }
      startGuideWait();
    } else {
      if (next) {
        next.textContent = '下一步';
        next.disabled = false;
        next.removeAttribute('data-ready');
      }
      if (wait) {
        wait.hidden = true;
        wait.disabled = true;
      }
      state.guide.okEnabled = false;
      if (state.guide.timer) { clearInterval(state.guide.timer); state.guide.timer = null; }
    }
  }

  /* 第二页那个「等待十秒」的按钮（2026-10-21 按用户新要求重写）：
   *   1. 每秒把按钮文案改成「还需等待 N 秒」，**界面上实时看得到**；
   *   2. 倒到 0 时整颗按钮**直接消失**（hidden=true），屏幕上只剩「我已知晓」；
   *   3. 「我已知晓」在倒计时期间是 disabled，到 0 才解锁 —— 十秒是代码强制的。
   * 以前的做法是把秒数塞进 title/aria-label、按钮一直留着，用户看不到也去不掉，
   * 所以这次改成直接改文案 + 到点隐藏。 */
  function startGuideWait() {
    if (state.guide.timer) { clearInterval(state.guide.timer); state.guide.timer = null; }
    var left = GUIDE_WAIT_SECONDS;
    state.guide.okEnabled = false;
    var wait = dom.btnGuideWait;
    if (wait) {
      wait.disabled = true;
      wait.hidden = false;
      wait.classList.remove('is-ready');
      wait.removeAttribute('data-ready');
      wait.textContent = GUIDE_WAIT_TEMPLATE.replace('%n', String(left));
    }
    state.guide.timer = setInterval(function () {
      left--;
      var btn = dom.btnGuideWait;
      if (left <= 0) {
        clearInterval(state.guide.timer);
        state.guide.timer = null;
        state.guide.okEnabled = true;
        /* 到点：按钮**整个隐藏**，不是变灰也不是变可点。
         * 用户要求「到 0 之后直接消失，只剩我已知晓」。 */
        if (btn) {
          btn.hidden = true;
          btn.disabled = true;
          btn.classList.remove('is-ready');
          btn.removeAttribute('title');
          btn.removeAttribute('aria-label');
          btn.removeAttribute('data-ready');
        }
        /* 主按钮「我已知晓」此刻才解锁（第 2 页一开始是 disabled 的）。 */
        var nextBtn = dom.btnGuideNext;
        if (nextBtn) {
          nextBtn.disabled = false;
          nextBtn.setAttribute('data-ready', '1');
        }
        return;
      }
      if (btn) {
        btn.textContent = GUIDE_WAIT_TEMPLATE.replace('%n', String(left));
        btn.setAttribute('aria-label', '还需等待 ' + left + ' 秒');
      }
    }, 1000);
  }

  function showGuide() {
    if (!dom.guideMask) { return; }
    dom.guideMask.hidden = false;
    document.body.style.overflow = 'hidden';
    guideSetPage(1);
  }

  function hideGuide() {
    if (!dom.guideMask) { return; }
    if (state.guide.timer) { clearInterval(state.guide.timer); state.guide.timer = null; }
    dom.guideMask.hidden = true;
    document.body.style.overflow = '';
    markGuideSeen();
  }

  /* 下一步 / 我已知晓 */
  function guideNext() {
    if (state.guide.page === 1) {
      guideSetPage(2);
      return;
    }
    hideGuide();
  }

  // 兜底：万一 HTML 里 id 打错，也不要让手册这条链把整个 boot 带崩
  function guideSeenSafe() {
    try { return guideSeen(); } catch (e) { return true; }
  }

  function isStaleSnapshot(snap) {
    if (!snap) { return true; }
    if (snap.stale) { return true; }
    return api.isStaleByTime(snap);
  }

  /* 本地快照环形缓冲：给校区卡画迷你趋势（只用自己真实观测到的数据） */
  function loadBuffer() {
    try {
      var raw = SHZU.lsGet(BUFFER_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
    } catch (e) { return []; }
  }

  function recordBuffer(snap) {
    if (!snap || !snap.campuses) { return; }
    var dataAt = U.parseTime(snap.data_at) || Date.now();
    var last = state.buffer.length ? state.buffer[state.buffer.length - 1] : null;
    if (last) {
      var lastT = last.t || 0;
      if (dataAt === lastT) { return; }                 // 同一条数据不重复记
      if (Math.abs(dataAt - lastT) < BUFFER_MIN_GAP_MS) { return; }
    }
    var entry = { t: dataAt, a: { total: snap.totals.total, free: snap.totals.free }, c: {} };
    for (var i = 0; i < snap.campuses.length; i++) {
      var cm = snap.campuses[i];
      entry.c[cm.id] = { total: cm.totals.total, free: cm.totals.free };
    }
    state.buffer.push(entry);
    if (state.buffer.length > BUFFER_MAX) { state.buffer = state.buffer.slice(state.buffer.length - BUFFER_MAX); }
    try { SHZU.lsSet(BUFFER_KEY, JSON.stringify(state.buffer)); } catch (e) {}
  }

  function bufferSeries(campusId) {
    var out = [];
    for (var i = 0; i < state.buffer.length; i++) {
      var e = state.buffer[i];
      var d = campusId ? (e.c && e.c[campusId]) : e.a;
      if (!d || !d.total) { continue; }
      out.push({ t: e.t, free_ratio: d.total > 0 ? d.free / d.total : 0 });
    }
    return out;
  }

  /* =========================================================
   * 路由
   * ========================================================= */
  var VIEW_IDS = {
    home: 'view-home',
    ports: 'view-ports',
    source: 'view-source',
    history: 'view-history',
    campus: 'view-campus',
    settings: 'view-settings'
  };

  /* hash 规则：
   *   #home / #ports / #history / #settings
   *   #campus/<campusId>
   *   #source/<sourceId>                       ← 数据源详情
   * 端口表的数据源/校区筛选不进 hash：它是视图内的筛选态，进 hash 会让
   * 手机端「返回」变成一步步撤销筛选，很难受。但从源详情跳进来时要带着预设，
   * 所以用 navigate() 的 opts.preset 传，而不是塞进 URL。 */
  function hashFor(view, campusId) {
    if (view === 'campus') { return '#campus/' + (campusId || ''); }
    if (view === 'source') { return '#source/' + (campusId || ''); }
    return '#' + view;
  }

  function parseHash() {
    var h = String(global.location.hash || '').replace(/^#\/?/, '');
    if (!h) { return { view: 'home', campusId: null }; }
    var parts = h.split('/');
    var v = parts[0];
    if (v === 'campus') { return { view: 'campus', campusId: parts[1] || null }; }
    if (v === 'source') { return { view: 'source', campusId: parts[1] || null }; }
    if (VIEW_IDS[v]) { return { view: v, campusId: null }; }
    return { view: 'home', campusId: null };
  }

  function navigate(view, campusId, opts) {
    var o = opts || {};
    if (!VIEW_IDS[view]) { view = 'home'; }
    state.view = view;
    // campusId 只服务校区详情；源详情用自己的 state.sourceId，避免两个视图
    // 互相污染对方的上下文（从源详情返回再进校区会串到上一个校区）。
    state.campusId = (view === 'campus') ? (campusId || state.campusId) : null;
    if (view === 'source') { state.sourceId = campusId || state.sourceId; }
    var ctxId = (view === 'source') ? state.sourceId : state.campusId;

    for (var k in VIEW_IDS) {
      if (!VIEW_IDS.hasOwnProperty(k)) { continue; }
      var elm = q(VIEW_IDS[k]);
      if (elm) { elm.hidden = (k !== view); }
    }
    // 空/错误状态只在 home 生效
    updateStateBlocks();

    var tabs = U.$$('.tab');
    for (var i = 0; i < tabs.length; i++) {
      var tv = tabs[i].getAttribute('data-tab');
      var active = (tv === view) || (view === 'campus' && tv === 'home') ||
        (view === 'source' && tv === 'home');
      tabs[i].classList.toggle('is-active', active);
      tabs[i].setAttribute('aria-selected', active ? 'true' : 'false');
    }

    if (!o.noHistory) {
      var h = hashFor(view, ctxId);
      if (global.location.hash !== h) {
        try { global.history.pushState({ view: view, ctxId: ctxId }, '', h); }
        catch (e) { global.location.hash = h; }
      }
    }

    window.scrollTo(0, 0);

    if (view === 'home') { renderHome(); }
    else if (view === 'ports') {
      if (o.preset) {
        state.ports.status = o.preset.status || 'all';
        state.ports.campus = o.preset.campus || 'all';
        state.ports.source = o.preset.source || 'all';
      }
      renderPorts(true);
    }
    else if (view === 'campus') { renderCampus(); }
    else if (view === 'source') { renderSourceDetail(state.sourceId); }
    else if (view === 'history') {
      renderHistoryView(true);
      // 进历史页时若还没数据就拉一次（避免只改 hash 进来时空白）
      if (state.snapshot && !state.history.data && !state.history.loading) { loadHistory({}); }
    } else if (view === 'settings') { renderSettings(); }
    if (o.after) { o.after(); }
  }

  /* =========================================================
   * 数据加载
   * ========================================================= */
  function scheduleAutoRefresh() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    var secs = state.settings.refreshSeconds;
    if (!secs || secs < 10) { return; }
    // 风控惩罚期内不排自动刷新：服务端已经罚了 120 秒，前端还每 15 秒
    // 撞一次只会把罚期续上去。等 exitRateLimit() 里再调回来。
    if (isRateLimited()) { return; }
    state.timer = setInterval(function () {
      if (document.hidden) { return; }
      if (state.loading) { return; }
      if (state.view === 'settings') { return; }
      // 双保险：定时器在惩罚期内即便漏了 clear，这里也拦住不发请求
      if (isRateLimited()) { return; }
      loadSnapshot({ silent: true });
      if (state.view === 'history') { loadHistory({ silent: true }); }
    }, secs * 1000);
  }

  /* 停掉自动刷新定时器（进入风控惩罚时用）。
   * 和 scheduleAutoRefresh() 里那句 clearInterval 是同一件事，
   * 单独抽出来是因为调用点语义不同：那边是「重排」，这边是「停」。 */
  function stopAutoRefresh() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  /* ---------------------------------------------------------
   * 两个数据来源与优先级
   *   1. 公共频道（ntfy.sh）—— 别人装上 App 什么都不用配就能看，
   *      平板每分钟左右把快照发布一次，这里读回来
   *   2. relay（局域网 / 同源）—— 自己人直连平板，数据最新，历史曲线也靠它
   *
   * 谁优先：显式配过 relay 地址的人（= 采集端主人 / 校园网内）优先 relay，
   * 因为它更快更全；没配过的人（= 收到 App 的同学）优先公共频道，
   * 否则每次都要先等 relay 超时才能出数据。
   * 主来源失败一律降级到另一个，最后才是本地缓存。
   * --------------------------------------------------------- */
  var feedPref = { relay: false, feed: false };  // 记录本次加载每个来源的成败（设置页展示用）

  function fetchViaPublicFeed() {
    var feed = SHZU.publicFeed;
    if (!feed || !SHZU.publicTopic) {
      var e = new Error('公共频道未配置');
      e._source = 'feed';
      return Promise.reject(e);
    }
    return feed.fetchSnapshot(SHZU.publicTopic, { timeout: 12000, attachmentTimeout: 20000 })
      .catch(function (err) {
        // 公共频道的错误不一定是 Error 实例，补上来源标记让横幅文案准确
        if (err && typeof err === 'object') { err._source = 'feed'; }
        throw err;
      });
  }

  function relayTask() {
    feedPref.relay = false;
    return api.snapshot().then(function (snap) {
      feedPref.relay = true;
      return { snap: snap, source: snap.from_sw_cache ? 'sw-cache' : 'live' };
    }, function (err) {
      if (err && typeof err === 'object') { err._source = 'relay'; }
      throw err;
    });
  }

  function feedTask() {
    feedPref.feed = false;
    return fetchViaPublicFeed().then(function (snap) {
      feedPref.feed = true;
      return { snap: snap, source: 'public-feed' };
    });
  }

  /* 页面自己被 relay 托管时（http/https 源、相对路径 /api/ 打到同一个服务），
   * 身边这份 relay 永远比公共频道新、也比公共频道全（带站点/端口明细），
   * 所以必须优先它。反过来 APK 里的页面是 file:// 源，同源请求根本不可能成功，
   * 那种情况才优先公共频道（否则每次启动都要先等一次必然失败的请求）。
   * 注：publicTopicSource='query' 时也只改「读哪个频道」，不改变这个优先级。 */
  function isSameOriginBackedByRelay() {
    var proto = String((global.location && global.location.protocol) || '');
    return proto === 'http:' || proto === 'https:';
  }

  function fetchSnapshotWithFallback() {
    var preferRelay = !!SHZU.trimSlash(SHZU.relay) || isSameOriginBackedByRelay();
    var first = preferRelay ? relayTask : feedTask;
    var second = preferRelay ? feedTask : relayTask;
    return first().catch(function (e1) {
      return second().catch(function (e2) {
        // 两个来源都失败：把两个原因都带上，排查时才知道卡在哪一层
        var primary = preferRelay ? e1 : e2;
        var secondary = preferRelay ? e2 : e1;
        var err = new Error(
          (primary && primary.message ? primary.message : '未知错误') +
          '；' + (preferRelay ? '公共频道' : 'relay') + '也失败：' +
          (secondary && secondary.message ? secondary.message : '未知错误')
        );
        err._source = preferRelay ? 'relay' : 'feed';
        err.kind = (primary && primary.kind) || 'network';
        err.firstError = e1;
        err.secondError = e2;
        throw err;
      });
    });
  }

  /* 拉 /api/sources 并渲染。api.sources() 内部已经「失败即 null、绝不 reject」，
   * 所以这里不需要错误分支——拿不到就是隐藏整块，不该在界面上留个空壳。
   *
   * 但「拿不到」有两种情况，必须区分：
   *   1) 真的没有数据源信息（老 relay / 演示模式）→ 隐藏
   *   2) 走的是云中转或公共频道，压根没有 /api/sources 这条接口，可数据源清单
   *      就带在快照里 → 用快照自带的那份，绝不能隐藏。
   * 第 2 种漏掉的表现就是用户报的「这次给的 APK 里没有充充充和石河子大学充电桩
   * 的分类了」：手机上走的是自己的域名（云中转），/api/sources 404 → 整块消失。 */
  function loadSources() {
    return api.sources().then(function (list) {
      if (!list || !list.length) {
        var fromSnap = api.sourceListFromSnapshot ? api.sourceListFromSnapshot(state.snapshot) : null;
        if (fromSnap && fromSnap.length) { list = fromSnap; }
      }
      state.sourceList = list;
      if (dom.sourcesBox) { renderSources(); }
      return list;
    });
  }

  /* ---------------------------------------------------------
   * 端口反馈（其他用户提交的「不可用」次数）
   * ---------------------------------------------------------
   * 这份数据来自云中转（全站共享），和快照两个来源是独立的：
   *   - 拿不到就沿用上次的计数（state.feedback.counts 不清空），
   *     绝不能因为反馈服务挂了就把已经标红的端口恢复成绿色 ——
   *     那会让用户以为「刚才看错了」。
   *   - 计数变了要重新套 overlay 并重算 totals，所以拿到之后
   *     需要重新渲染一次当前视图。
   * 本地也留一份 localStorage，冷启动时先按旧计数标红，
   * 网络回来再校正（避免第一屏把不可用的端口显示成空闲）。
   */
  var FEEDBACK_CACHE_KEY = 'shzu.feedback.v1';
  var FEEDBACK_CACHE_MAX_AGE_MS = 6 * 3600 * 1000;

  function loadFeedbackCache() {
    var raw = SHZU.lsGet(FEEDBACK_CACHE_KEY);
    if (!raw) { return; }
    try {
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !obj.counts) { return; }
      var age = Date.now() - (obj.savedAt || 0);
      if (age > FEEDBACK_CACHE_MAX_AGE_MS) { return; }
      state.feedback.counts = obj.counts;
      if (obj.threshold) { state.feedback.threshold = obj.threshold; }
      state.feedback.loaded = true;
      state.feedback.fromCache = true;
    } catch (e) {}
  }

  function saveFeedbackCache(counts, threshold) {
    try {
      SHZU.lsSet(FEEDBACK_CACHE_KEY, JSON.stringify({
        savedAt: Date.now(), counts: counts, threshold: threshold
      }));
    } catch (e) {}
  }

  /* 把反馈层套到快照上。所有「用快照的地方」都必须走这个函数，
   * 而不是直接用 state.rawSnapshot —— 否则会出现主页标红、端口表不标红
   * 这种自相矛盾。 */
  function snapWithFeedback() {
    var raw = state.rawSnapshot || state.snapshot;
    if (!raw) { return null; }
    var counts = state.feedback.counts || {};
    var hasAny = false;
    for (var k in counts) { if (counts.hasOwnProperty(k)) { hasAny = true; break; } }
    if (!hasAny) { return raw; }
    try {
      return api.applyFeedbackOverlay(raw, counts, state.feedback.threshold);
    } catch (e) {
      // overlay 出任何岔子都退回原始快照：宁可少标一个红，不能白屏
      return raw;
    }
  }

  /* 用原始快照重建 state.snapshot（反馈层是最外层的派生数据）。 */
  function rebuildSnapshotWithFeedback() {
    if (!state.rawSnapshot) { return false; }
    var next = snapWithFeedback();
    if (!next) { return false; }
    state.snapshot = next;
    return true;
  }

  function loadFeedback() {
    if (state.feedback.loading) { return Promise.resolve(null); }
    state.feedback.loading = true;
    return api.feedback().then(function (res) {
      state.feedback.loading = false;
      if (!res) {
        // 云中转不可用：保持现有计数（可能来自 localStorage），什么都不动
        return null;
      }
      var changed = false;
      var old = state.feedback.counts || {};
      var next = res.counts || {};
      var k;
      for (k in next) {
        if (next.hasOwnProperty(k) && old[k] !== next[k]) { changed = true; break; }
      }
      if (!changed) {
        for (k in old) {
          if (old.hasOwnProperty(k) && next[k] === undefined) { changed = true; break; }
        }
      }
      state.feedback.counts = next;
      state.feedback.threshold = res.threshold || state.feedback.threshold;
      state.feedback.loaded = true;
      state.feedback.fromCache = false;
      saveFeedbackCache(next, state.feedback.threshold);
      if (changed && rebuildSnapshotWithFeedback()) {
        // 计数变化会改 status → totals，必须整体重渲染，
        // 否则「全校空闲 1034」会和端口表里的空闲行数对不上。
        renderCurrent();
      }
      return res;
    }).catch(function () {
      // api.feedback() 理论上不会 reject，这里纯粹兜底
      state.feedback.loading = false;
      return null;
    });
  }

  function loadSnapshot(opts) {
    var o = opts || {};
    if (state.loading) { return Promise.resolve(); }
    /* 风控惩罚期内**一个请求都不发**。这是用户要求的「对用户停止下发数据两分钟」
     * 在客户端这一侧的落实：服务端已经按 IP 罚了 120 秒，前端继续发只会把
     * 罚期一直续上，永远好不了。手动刷新按钮此时是 disabled，但下拉刷新、
     * 自动刷新、恢复前台等路径都可能走到这里，所以拦截要放在函数入口。 */
    if (isRateLimited() && !o.force) {
      updateRefreshButtonLock();
      renderRateLimitBanner();
      if (!o.silent) {
        toast('风控限制中，还需等待 ' + Math.ceil(rateLimitRemainingMs() / 1000) + ' 秒', 1800);
      }
      return Promise.resolve();
    }
    /* 客户端侧配额：**一分钟最多 20 次数据请求**，超了就地罚 120 秒。
     *
     * 为什么必须在这里管（2026-10-21 实测，不是防御性冗余）：
     *   1) APK 在局域网里加载的是平板自己的 relay，那条路径上没有任何限流，
     *      服务端规则完全够不着 —— 实测连点 12 次刷新一次都没触发；
     *   2) 走公网 Cloudflare 时，Worker 的计数存在 caches.default，而 CF 会把
     *      同一客户端的请求分散到多个机房、各数一份，实测顺序请求也拦不住。
     * 所以「一分钟限次」只有在客户端强制才算数。服务端那套继续保留，它挡的是
     * 直接打接口的脚本 —— 两层是纵深，不是重复。
     *
     * 只拦 loadSnapshot（数据快照）这一条路径：静态资源、历史曲线不在此列，
     * 否则开一次首页就能把配额吃光，用户点什么都弹风控。
     * o.force 是内部恢复路径（如惩罚结束立刻补一次数据），不占配额也不拦。 */
    if (!o.force) {
      var quota = SHZU.clientQuotaCheck();
      if (!quota.allowed) {
        enterRateLimit(SHZU.clientQuota.penaltySec);
        return Promise.resolve();
      }
    }
    state.loading = true;
    dom.btnRefresh && dom.btnRefresh.classList.add('is-spinning');
    document.body.classList.add('is-loading');
    if (!o.silent && !state.snapshot) { renderSkeletons(); }

    return fetchSnapshotWithFallback().then(function (res) {
      var snap = res.snap;
      // 先存原始快照，再叠反馈层：反馈层每次都从原始数据重算，
      // 不可以在叠过的对象上再叠（raw_status 会被覆盖坏掉）。
      state.rawSnapshot = snap;
      rebuildSnapshotWithFeedback();
      if (!state.snapshot) { state.snapshot = snap; }
      // SW 用 API 缓存兜底时它仍然是 200，但数据其实是旧的 → 如实标成缓存来源
      state.source = res.source;
      state.lastError = null;
      if (snap.from_sw_cache) {
        state.swCacheAge = snap.sw_age_seconds || 0;
        state.lastError = makeOfflineError('离线：显示 Service Worker 缓存');
      } else {
        state.swCacheAge = 0;
      }
      // 公共频道拿到的数据也落盘，断网时和其它来源同等待遇
      if (res.source === 'public-feed') {
        try { api.cachePut(SHZU.storeKey.snapshot, snap); } catch (e) {}
      }
      recordBuffer(snap);
      state.loading = false;
      finishRefresh();
      renderCurrent();
      // 数据源状态跟着快照一起取。不 await：它是锦上添花的信息，
      // 慢一点或拿不到都不该拖慢（更不该拖挂）主流程。
      loadSources();
      // 反馈计数也顺带刷新（不 await，失败静默）
      loadFeedback();
    }).catch(function (err) {
      state.lastError = err;
      state.loading = false;
      finishRefresh();
      /* 风控 429：这不是「网络不好」，必须走专门的惩罚流程（弹窗 + 锁刷新 +
       * 停发两分钟）。放在这里而不是各处调用点，因为快照有两条来源
       * （云中转 / ntfy），两条都可能收到 429，收敛到这一个 catch 才不会漏。 */
      var pen = rateLimitFromError(err);
      if (pen) {
        state.rateLimit.until = 0;  // 让 enterRateLimit 不被"已有更晚罚期"拦住
        enterRateLimit(pen);
      }
      if (!state.snapshot) {
        var cached = api.cachedSnapshot();
        if (cached) {
          state.rawSnapshot = cached;
          state.snapshot = snapWithFeedback() || cached;
          state.source = 'cache';
        }
      } else {
        state.source = 'cache';
      }
      renderCurrent();
      // 风控期已经有横幅和弹窗了，再弹个 toast 是噪音
      if (!o.silent && !pen) {
        toast(err && err.message ? ('刷新失败：' + err.message) : '刷新失败', 2200);
      }
    });
  }

  /* 从错误对象里挖出「风控惩罚秒数」。
   *
   * 三条错误来源都要认，否则会漏：
   *   1) publicfeed 的 FeedError(kind='ratelimit')，penaltySeconds 已解析好
   *   2) api.js 云请求的 ApiError(kind='ratelimit')，带 extra.penalty_seconds
   *   3) 两层 fallback 合并后的聚合错误：哪个来源被限流就带哪个的 kind，
   *      但真正的惩罚信息在 firstError / secondError 里
   * 返回秒数（数字）或 0。 */
  function rateLimitFromError(err) {
    if (!err || typeof err !== 'object') { return 0; }
    if (err.kind === 'ratelimit' || err.rateLimited) {
      var s = Number(err.penaltySeconds || (err.extra && err.extra.penalty_seconds) || 120);
      return (isFinite(s) && s > 0) ? Math.floor(s) : 120;
    }
    var inner = err.firstError || err.secondError;
    if (inner) {
      var found = rateLimitFromError(inner);
      if (found) { return found; }
    }
    var ex = err.extra;
    if (ex) {
      var nested = rateLimitFromError(ex.cloud) || rateLimitFromError(ex.ntfy);
      if (nested) { return nested; }
    }
    return 0;
  }

  function finishRefresh() {
    dom.btnRefresh && dom.btnRefresh.classList.remove('is-spinning');
    document.body.classList.remove('is-loading');
  }

  /* 造一个「离线但没崩」的错误对象，用于 SW 缓存兜底时的横幅文案 */
  function makeOfflineError(msg) {
    var e = new Error(msg || '离线');
    e.kind = 'offline';
    e.offline = true;
    return e;
  }

  function loadHistory(opts) {
    var o = opts || {};
    var h = state.history;
    if (h.loading) { return Promise.resolve(); }
    h.loading = true;
    h.error = null;
    if (!o.silent) { renderHistoryChart(true); }
    return api.history(h.campus, h.hours, h.bucket).then(function (data) {
      h.data = data;
      h.loading = false;
      h.fromCache = false;
      h.bucket = data.bucket_seconds ? bucketLabel(data.bucket_seconds) : h.bucket;
      renderHistoryView(false);
    }).catch(function (err) {
      h.loading = false;
      h.error = err;
      var cached = api.cachedHistory(h.campus, h.hours, h.bucket);
      if (cached) {
        h.data = cached;
        h.fromCache = true;
      } else {
        h.data = null;
      }
      renderHistoryView(false);
    });
  }

  function bucketLabel(sec) {
    if (sec >= 3600) { return '1h'; }
    if (sec >= 1800) { return '30m'; }
    if (sec >= 600) { return '10m'; }
    if (sec >= 300) { return '5m'; }
    return '1m';
  }
  function bucketText(sec) {
    if (sec >= 3600) { return Math.round(sec / 3600) + ' 小时'; }
    if (sec >= 60) { return Math.round(sec / 60) + ' 分钟'; }
    return sec + ' 秒';
  }

  /* =========================================================
   * 数据源状态区（relay GET /api/sources）
   *
   * 为什么单独一块：采集端是**双源异速**的——源 A 每 15 秒一轮、源 B 每
   * 2~3 分钟一轮。只看顶部「采集于 X 分钟前」分不清到底是哪个源慢、
   * 哪部分数据是冻结的。这里把每个源各显示一行：名字、多久前更新、
   * 空闲/总端口，被风控的标上限流。
   *
   * 不可用（公共频道模式 / 旧 relay 返回 404 / 没配 relay）时 state.sourceList
   * 为 null，整块隐藏，不留空白或占位。
   * ========================================================= */
  var SOURCE_FALLBACK_NAMES = {
    shzu: '石河子大学充电桩',
    lvcc: '充充充充电桩-铭创电子',
    default: '中继数据'
  };

  function sourceAgeSeconds(src) {
    // 优先用 relay 算好的 age_s；没有就用 updated_at 自己算（两端时钟可能有偏差）。
    if (typeof src.age_s === 'number' && isFinite(src.age_s)) {
      return Math.max(0, Math.round(src.age_s));
    }
    var t = U.parseTime(src.updated_at);
    if (t === null) { return null; }
    return Math.max(0, Math.round((Date.now() - t) / 1000));
  }

  function sourceAgeText(src) {
    var age = sourceAgeSeconds(src);
    if (age === null) { return '更新时间未知'; }
    return bucketText(age) + '前更新';
  }

  /* 这个源能不能点进详情页？
   * 条件是它带了分校区明细（sources[i].campuses）。公共频道 / 旧 relay 没有这个
   * 字段 —— 那就把行降级成不可点，绝不给出一个点进去空白一片的入口。 */
  function sourceHasDetail(src) {
    return !!(src && src.campuses && src.campuses.length);
  }

  function sourceDisplayName(src) {
    return src.name || SOURCE_FALLBACK_NAMES[src.source_id] || src.source_id || '数据源';
  }

  /* 源的健康状态短语，用于详情页副标题 */
  function sourceHealthText(src) {
    if (!src) { return ''; }
    if (src.throttled) {
      var when = src.blocked_since || src.updated_at;
      return '风控限流中' + (when ? '（' + U.fmtDateTime(when) + ' 起）' : '');
    }
    return '正常 · ' + sourceAgeText(src);
  }

  function renderSources() {
    var box = dom.sourcesBox;
    if (!box) { return; }
    var list = state.sourceList;
    /* 懒加载兜底：loadSources() 可能比快照先跑完（我们自己的域名上没有
     * /api/sources 这条接口，只能靠快照里带的 sources）。那一刻 state.snapshot
     * 还是 null，算出来是空，于是「数据源」整块就一直隐藏 —— 用户报的
     * 「这次给的 APK 里没有充充充和石河子大学充电桩的分类」正是这个时序问题。
     * 快照到了之后在这里再算一次，算出来就补上并记住。 */
    if ((!list || !list.length) && state.snapshot && api.sourceListFromSnapshot) {
      list = api.sourceListFromSnapshot(state.snapshot);
      if (list && list.length) { state.sourceList = list; }
    }
    if (!list || !list.length) {
      box.hidden = true;
      if (dom.sourcesList) { dom.sourcesList.innerHTML = ''; }
      if (dom.sourcesHint) { dom.sourcesHint.textContent = ''; }
      return;
    }
    box.hidden = false;
    dom.sourcesHint.textContent = list.length + ' 个数据源';

    dom.sourcesList.innerHTML = '';
    for (var i = 0; i < list.length; i++) {
      var src = list[i];
      var name = sourceDisplayName(src);
      var clickable = sourceHasDetail(src);
      // 可点的用 button（语义正确、键盘可达、点按区域够大），不可点的保持 div
      var row = U.el(clickable ? 'button' : 'div', {
        type: clickable ? 'button' : null,
        class: 'source-row' + (src.throttled ? ' is-throttled' : '') +
          (clickable ? ' is-clickable' : ' is-static')
      });

      // 左：色点 + 名字 + 主机
      var left = U.el('span', { class: 'source-left' }, [
        U.el('span', { class: 'source-dot', 'aria-hidden': 'true' }),
        U.el('span', { class: 'source-name' }, [
          document.createTextNode(name),
          src.host ? U.el('span', { class: 'source-host', text: src.host }) : null
        ])
      ]);
      left.setAttribute('title', name + (src.host ? '（' + src.host + '）' : ''));

      // 中：空闲/总端口
      var counts = U.el('span', { class: 'source-counts' }, [
        U.el('b', { text: String(U.num(src.free)) }),
        document.createTextNode(' / ' + U.num(src.devices) + ' 空闲端口')
      ]);

      // 右：多久前更新 + 限流标记
      var right = U.el('span', { class: 'source-age' }, [
        U.el('span', { text: sourceAgeText(src) })
      ]);
      if (src.throttled) {
        var tag = U.el('span', { class: 'source-tag', text: '限流' });
        tag.setAttribute('title',
          (src.message ? src.message + '；' : '') +
          '数据停在 ' + U.fmtDateTime(src.blocked_since || src.updated_at));
        right.appendChild(tag);
      }
      // 可点时给个 › 暗示「这里能点进去」
      if (clickable) { right.appendChild(U.el('span', { class: 'source-chev', 'aria-hidden': 'true', text: '›' })); }

      row.appendChild(left);
      row.appendChild(counts);
      row.appendChild(right);

      if (clickable) {
        (function (s) {
          row.addEventListener('click', function () {
            navigate('source', s.source_id);
          });
        })(src);
        row.setAttribute('aria-label',
          name + '，' + (src.campuses.length) + ' 个校区有数据，点按查看分校区明细');
      }
      dom.sourcesList.appendChild(row);
    }
  }

  /* =========================================================
   * 数据源详情：某个源在各校区的分布
   *
   * 用户原话：「数据源那里需要加一个功能，可以点开就是像下面那个全部端口表
   * 一样，点开之后，就是查看这个数据源的不同校区的数据」。
   *
   * 每行一个校区：校区名、空闲/总数、站点数、堆叠状态条。**不显示百分比文字**
   * （用户明确说过主页和卡片里都不要百分比）。点校区行 → 跳端口表并预设
   * 「该源 + 该校区」筛选，直接看这一格的每个端口。
   * ========================================================= */
  function currentSource() {
    var list = state.sourceList;
    if (!list) { return null; }
    for (var i = 0; i < list.length; i++) {
      if (list[i].source_id === state.sourceId) { return list[i]; }
    }
    return null;
  }

  function renderSourceDetail(sourceId) {
    var head = dom.sourceDetailHead;
    var listWrap = dom.sourceCampusList;
    if (!head || !listWrap) { return; }
    head.innerHTML = '';
    listWrap.innerHTML = '';

    var src = currentSource();
    if (!src) {
      // 拿不到这个源（刷新后源没了 / 直接输 URL 进来）→ 明确提示 + 返回按钮，
      // 不留空白页
      head.appendChild(U.el('div', { class: 'card source-empty-card' }, [
        U.el('div', { class: 'state-title', text: '找不到这个数据源' }),
        U.el('div', { class: 'state-desc', text: '刷新一次后重试，或返回总览从数据源面板重新进入。' })
      ]));
      return;
    }

    var name = sourceDisplayName(src);
    var t = U.el('div', { class: 'card source-hero' + (src.throttled ? ' is-throttled' : '') }, [
      U.el('div', { class: 'source-hero-top' }, [
        U.el('span', { class: 'source-hero-dot' + (src.throttled ? ' is-throttled' : ''), 'aria-hidden': 'true' }),
        U.el('span', { class: 'source-hero-name', text: name })
      ]),
      U.el('div', { class: 'source-hero-meta', text: sourceHealthText(src) })
    ]);
    if (src.host) {
      var hostLine = U.el('div', { class: 'source-hero-host', text: src.host });
      hostLine.setAttribute('title', src.host);
      t.appendChild(hostLine);
    }
    if (src.message) {
      t.appendChild(U.el('div', { class: 'source-hero-warn', text: src.message }));
    }
    head.appendChild(t);

    var cards = src.campuses || [];
    if (!cards.length) {
      // 契约里 campuses 缺失/为空 = 这个源没有分校区明细（公共频道数据）
      head.appendChild(U.el('div', { class: 'card source-empty-card' }, [
        U.el('div', { class: 'state-title', text: '没有分校区明细' }),
        U.el('div', { class: 'state-desc', text: '公共频道数据没有分校区明细，连上中继（局域网 relay）后才能按校区查看。' })
      ]));
      return;
    }

    // 汇总：该源合计
    var sum = U.zeroTotals();
    for (var s = 0; s < cards.length; s++) {
      var ct = cards[s].totals || U.zeroTotals();
      sum.total += ct.total; sum.free += ct.free; sum.busy += ct.busy;
      sum.offline += ct.offline; sum.unknown += ct.unknown;
    }
    var sumNode = U.el('div', { class: 'source-summary' }, [
      U.el('span', { class: 'source-summary-free', text: String(sum.free) }),
      document.createTextNode(' / ' + sum.total + ' 个端口空闲 · ' + cards.length + ' 个校区')
    ]);
    head.appendChild(sumNode);

    var frag = document.createDocumentFragment();
    for (var i = 0; i < cards.length; i++) {
      frag.appendChild(sourceCampusCard(src, cards[i]));
    }
    listWrap.appendChild(frag);
  }

  function sourceCampusCard(src, card) {
    var meta = U.campusMeta(card.id) || { color: '#7d8798', name: card.name || card.id };
    var t = card.totals || U.zeroTotals();
    var isEmpty = t.total <= 0;

    var row = U.el('button', {
      type: 'button',
      class: 'source-campus-card' + (isEmpty ? ' is-empty' : ''),
      style: '--campus-color:' + meta.color,
      'aria-label': meta.name + ' 空闲 ' + t.free + ' / ' + t.total + ' 个端口，查看该校区端口'
    }, [
      U.el('div', { class: 'source-campus-top' }, [
        U.el('span', { class: 'source-campus-name', text: meta.name }),
        U.el('span', { class: 'source-campus-chev', 'aria-hidden': 'true', text: '›' })
      ]),
      U.el('div', { class: 'source-campus-num' }, [
        U.el('span', { class: 'source-campus-free' + (isEmpty ? ' is-zero' : ''), text: isEmpty ? '—' : String(t.free) }),
        U.el('span', { class: 'source-campus-total', text: isEmpty ? '无数据' : '/ ' + t.total + ' 个端口' })
      ])
    ]);

    var bar = safeChart('stackBar', [{ totals: t, height: 7 }]);
    if (bar) { row.appendChild(bar); }

    row.appendChild(U.el('div', { class: 'source-campus-foot' }, [
      U.el('span', {
        class: 'source-campus-counts',
        text: isEmpty
          ? '暂无该校区数据'
          : (card.stations || 0) + ' 个站点 · 占用 ' + t.busy + ' · 离线 ' + t.offline
      })
    ]));

    row.addEventListener('click', function () {
      // 预设「该源 + 该校区」筛选，直接落到这一格的每个端口上
      navigate('ports', null, { preset: { source: src.source_id, campus: card.id, status: 'all' } });
    });
    return row;
  }

  /* =========================================================
   * 顶部横幅
   * ========================================================= */
  function renderBanners() {
    var snap = state.snapshot;
    var err = state.lastError;

    // 网络错误条
    if (err) {
      var msg = (err.offline || err.kind === 'sw-cache')
        ? '当前处于离线状态，显示的是本地缓存数据'
        : ('无法获取数据（' + (err.message || '网络错误') + '）');
      if (snap) {
        msg += '，采集于 ' + U.fmtAgo(snap.data_at);
      }
      setBanner(dom.netBanner, true, msg);
    } else {
      setBanner(dom.netBanner, false);
    }

    // 过期条
    var stale = false, staleText = '';
    if (snap) {
      var ageMin = 0;
      var t = U.parseTime(snap.data_at);
      if (t !== null) { ageMin = Math.round((Date.now() - t) / 60000); }
      var fromCache = state.source === 'cache' || state.source === 'sw-cache';
      if (snap.stale || (t !== null && ageMin > SHZU.defaults.staleMinutes) || fromCache) {
        stale = true;
        if (t === null) {
          staleText = '数据可能过期：没有采集时间';
        } else if (fromCache && err) {
          staleText = '数据可能过期：显示离线缓存（' + U.fmtAgo(snap.data_at) + '）';
        } else {
          // 用绝对时间 + 相对时长，避免「40 分钟前（40 分钟前）」这种重复
          staleText = '数据可能过期：最后采集于 ' + U.fmtDateTime(snap.data_at) +
            '（' + U.fmtAgo(snap.data_at) + '）';
        }
      }
    } else if (err) {
      stale = true;
      staleText = '数据可能过期：本地没有可用缓存';
    }
    setBanner(dom.staleBanner, stale, staleText);

    // 数据源限流条：跟 stale 不同 —— stale 是「快照整体太旧」，这里是
    // 「快照很新，但某个数据源被风控挡住了，它那部分端口的状态是冻结的」。
    // 不单独说清楚的话，用户会以为看到的就是实时的。
    var warn = snap && snap.source_warning;
    var frozen = [];
    var sources = (snap && snap.sources) || [];
    for (var si = 0; si < sources.length; si++) {
      var sc = sources[si];
      if (sc && sc.throttled) { frozen.push(sc); }
    }
    if (warn || frozen.length) {
      var wt = (warn && warn.text) || '';
      if (!wt) {
        wt = frozen.length === 1
          ? (frozen[0].name || frozen[0].id || '一个数据源') + ' 被风控限流拦截，数据暂时停止刷新'
          : frozen.length + ' 个数据源被风控限流拦截，数据暂时停止刷新';
      }
      var when = (warn && warn.blocked_since) || '';
      for (var wi = 0; wi < frozen.length && !when; wi++) {
        if (frozen[wi].blocked_since) { when = frozen[wi].blocked_since; }
      }
      if (!when) {
        for (var rj = 0; rj < frozen.length; rj++) {
          if (frozen[rj].retry_after) { when = frozen[rj].retry_after; break; }
        }
      }
      setBanner(dom.sourceBanner, true, wt);
      var sub = '';
      if (when) { sub = '数据停在 ' + U.fmtDateTime(when); }
      else if (snap && snap.data_at) { sub = '数据停在 ' + U.fmtDateTime(snap.data_at); }
      dom.sourceSub.textContent = sub;
      dom.sourceSub.hidden = !sub;
    } else {
      setBanner(dom.sourceBanner, false);
      dom.sourceSub.textContent = '';
      dom.sourceSub.hidden = true;
    }

    // 演示模式
    setBanner(dom.demoBanner, !!(snap && snap.demo));
  }

  function renderCurrent() {
    renderBanners();
    if (state.view === 'home') { renderHome(); }
    else if (state.view === 'ports') { renderPorts(false); }
    else if (state.view === 'campus') { renderCampus(); }
    else if (state.view === 'source') { renderSourceDetail(state.sourceId); }
    else if (state.view === 'history') { renderHistoryView(false); }
    else if (state.view === 'settings') { renderSettingsStatus(); }
    updateStateBlocks();
  }

  /* =========================================================
   * 空 / 错误状态
   * ========================================================= */
  function updateStateBlocks() {
    var snap = state.snapshot;
    var empty = false, emptyDesc = '';
    if (state.view === 'home') {
      if (snap) {
        var hasAny = snap.totals.total > 0;
        if (!hasAny) {
          var stationCount = 0;
          for (var i = 0; i < snap.campuses.length; i++) { stationCount += snap.campuses[i].stations.length; }
          if (stationCount === 0) {
            empty = true;
            emptyDesc = 'relay 还没有采集到任何充电桩数据。等采集器上传后会自动刷新，也可以点下面的按钮再试一次。';
          }
        }
      }
    }
    var error = false, errorDesc = '';
    if (state.view === 'home' && !snap && state.lastError) {
      error = true;
      var e = state.lastError;
      errorDesc = '无法从 relay 获取数据：' + (e.message || '未知错误') +
        '。请检查设置里的数据源地址、确认平板上的 relay 正在运行，或稍后重试。';
    }

    var grid = dom.campusGrid;
    if (grid) { grid.hidden = (empty || error); }
    if (dom.homeFootnote) { dom.homeFootnote.hidden = (empty || error); }
    if (dom.hero) { dom.hero.hidden = (empty || error); }
    var sh = q('homeSectionHead');
    if (sh) { sh.hidden = (empty || error); }

    // 首页新增的两块（空闲端口 + 端口表入口）也要跟着一起隐藏
    if (dom.btnOpenPorts) { dom.btnOpenPorts.hidden = (empty || error); }
    if (dom.freeSectionHead) { dom.freeSectionHead.hidden = (empty || error); }
    if (dom.freePorts) { dom.freePorts.hidden = (empty || error); }
    if (dom.freePortsMore) { dom.freePortsMore.hidden = (empty || error) || !dom.freePortsMore.textContent; }

    dom.emptyState.hidden = !empty;
    if (empty) { dom.emptyDesc.textContent = emptyDesc; }
    dom.errorState.hidden = !error;
    if (error) { dom.errorDesc.textContent = errorDesc; }
  }

  /* =========================================================
   * 骨架屏
   * ========================================================= */
  function renderSkeletons() {
    if (!dom.campusGrid) { return; }
    dom.campusGrid.hidden = false;
    dom.campusGrid.innerHTML = '';
    for (var i = 0; i < 6; i++) {
      dom.campusGrid.appendChild(U.el('div', { class: 'skel-card skel', 'aria-hidden': 'true' }));
    }
    if (dom.heroFree) { dom.heroFree.textContent = '—'; }
    if (dom.heroTotal) { dom.heroTotal.textContent = '/ —'; }
    if (dom.heroTime) { dom.heroTime.textContent = '正在获取数据…'; }
    if (dom.heroLegend) { dom.heroLegend.innerHTML = ''; }
    if (dom.freeSectionHead) { dom.freeSectionHead.hidden = false; }
    if (dom.freePorts) {
      dom.freePorts.hidden = false;
      dom.freePorts.innerHTML = '';
      for (var j = 0; j < 4; j++) {
        dom.freePorts.appendChild(U.el('div', { class: 'skel fp-skel', 'aria-hidden': 'true' }));
      }
    }
    if (dom.freePortsHint) { dom.freePortsHint.textContent = ''; }
    if (dom.freePortsMore) { dom.freePortsMore.hidden = true; }
    if (dom.ctaPortsSub) { dom.ctaPortsSub.textContent = '正在获取端口数据…'; }
  }

  /* =========================================================
   * 总览
   * ========================================================= */
  function renderHome() {
    var snap = state.snapshot;
    if (!snap) {
      if (state.lastError) { updateStateBlocks(); return; }
      renderSkeletons();
      return;
    }
    renderHero(snap);
    renderSources();
    renderFreePorts(snap);
    renderCampusGrid(snap);
    renderFootnote(snap);
    updateCampusHint();
    updateStateBlocks();
  }

  // 空闲率口径：free / (total − unknown)。unknown 是「取不到状态」（例如数据源被风控
  // 限流），把它算进分母会让空闲率在限流期间凭空暴跌，看起来像桩坏了；
  // 排除掉之后这条曲线在正常期和限流期是可比的。
  // 契约里 free_ratio 就是这个定义，renderCampus 里的 ratio-pill 也用同一口径。
  function ratioOf(totals) {
    if (!totals) { return null; }
    var denom = (totals.total || 0) - (totals.unknown || 0);
    return denom > 0 ? (totals.free || 0) / denom : null;
  }

  function ratioClass(ratioVal) {
    if (ratioVal === null) { return ' is-none'; }
    return ratioVal < 0.15 ? ' is-low' : '';
  }

  function ratioLabel(ratioVal) {
    return ratioVal === null ? '暂无数据' : '空闲率 ' + U.pct(ratioVal, 1);
  }

  function renderHero(snap) {
    var t = snap.totals || U.zeroTotals();
    dom.heroFree.textContent = t.total > 0 ? String(t.free) : '—';
    dom.heroTotal.textContent = t.total > 0 ? ('/ ' + t.total + ' 个端口') : '/ —';

    var timeTxt = snap.data_at ? ('采集 ' + U.fmtClock(snap.data_at) + ' · ' + U.fmtAgo(snap.data_at)) : '无采集时间';
    if (snap.generated_at && snap.data_at && snap.generated_at !== snap.data_at) {
      timeTxt += ' · 聚合 ' + U.fmtClock(snap.generated_at);
    }
    dom.heroTime.textContent = timeTxt;

    // 空闲率徽标放在采集时间旁边（.hero-meta 这一行），不占大数字的位置 ——
    // 大数字仍然是「空闲端口个数」，百分比是补充信息，两者不抢。
    if (dom.heroRatio) {
      var hr = ratioOf(t);
      dom.heroRatio.textContent = ratioLabel(hr);
      dom.heroRatio.className = 'ratio-pill' + ratioClass(hr);
      dom.heroRatio.hidden = false;
    }

    // 图例：四种状态的端口数量
    dom.heroLegend.innerHTML = '';
    var keys = ['free', 'busy', 'offline', 'unknown'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var sm = U.statusMeta(k);
      var item = U.el('span', { class: 'legend-item' }, [
        U.el('span', { class: 'legend-swatch', style: 'background:' + sm.color }),
        document.createTextNode(sm.label + ' '),
        U.el('b', { text: String(U.num(t[k])) })
      ]);
      dom.heroLegend.appendChild(item);
    }
    // 图例本身就是状态计数，再补一条「点击任意端口查看详情」的引导
    var freeCount = t.total > 0 ? t.free : 0;
    if (dom.ctaPortsSub) {
      dom.ctaPortsSub.textContent = t.total > 0
        ? (freeCount > 0 ? ('当前 ' + freeCount + ' 个端口空闲，共 ' + t.total + ' 个') : ('共 ' + t.total + ' 个端口，暂无空闲'))
        : '每个端口一行，实时状态';
    }

    // 环形图：中心数字与 hero 徽标必须同口径（free_ratio = free/(total−unknown)）。
    // 这里踩过坑 —— 中心按 free/total 显示 47%、旁边徽标按契约口径显示 50.0%，
    // 同一屏两个数打架。现在两边都走 ratioOf()。
    if (dom.heroDonut) {
      dom.heroDonut.innerHTML = '';
      var hr2 = ratioOf(t);
      var ring = safeChart('donut', [{
        totals: t, size: 118, thickness: 13,
        centerLabel: hr2 === null ? '—' : U.pct(hr2, 0),
        centerSub: '空闲率'
      }]);
      if (ring) { dom.heroDonut.appendChild(ring); }
    }
  }

  /* ---------------------------------------------------------
   * 首页：空闲的端口（紧凑列表，点击直达该桩详情）
   * ------------------------------------------------------- */
  var HOME_FREE_SHOW = 15;   // 首页最多展示的空闲端口数

  // 把 snapshot 摊平成端口列表：每个 station.devices[i] 就是一个端口。
  // 返回 [{campus, station, dev, idx}]
  function flattenPorts(snap) {
    var out = [];
    if (!snap || !snap.campuses) { return out; }
    var campuses = U.normalizeCampuses(snap.campuses);
    for (var i = 0; i < campuses.length; i++) {
      var c = campuses[i];
      var stations = c.stations || [];
      for (var j = 0; j < stations.length; j++) {
        var st = stations[j];
        var devices = st.devices || [];
        for (var k = 0; k < devices.length; k++) {
          out.push({ campus: c, station: st, dev: devices[k], idx: k });
        }
      }
    }
    return out;
  }

  function renderFreePorts(snap) {
    var wrap = dom.freePorts;
    if (!wrap) { return; }
    wrap.innerHTML = '';

    var all = flattenPorts(snap);
    var free = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].dev.status === 'free') { free.push(all[i]); }
    }

    if (dom.freePortsHint) {
      dom.freePortsHint.textContent = all.length > 0 ? (free.length + ' / ' + all.length + ' 个端口') : '';
    }

    if (!free.length) {
      wrap.appendChild(U.el('div', { class: 'fp-empty', text: all.length > 0 ? '当前没有空闲端口，稍后再看看。' : '暂无端口数据。' }));
      if (dom.freePortsMore) { dom.freePortsMore.hidden = true; }
      return;
    }

    // 六校区顺序优先，同校区内按站点名，同站点按端口序号 —— 保证每次刷新顺序稳定
    var shown = free.slice(0, HOME_FREE_SHOW);
    var frag = document.createDocumentFragment();
    for (var j = 0; j < shown.length; j++) {
      frag.appendChild(freePortRow(shown[j]));
    }
    wrap.appendChild(frag);

    var more = dom.freePortsMore;
    if (more) {
      if (free.length > shown.length) {
        more.hidden = false;
        more.textContent = '还有 ' + (free.length - shown.length) + ' 个空闲端口 · 查看全部端口表 ›';
      } else {
        more.hidden = false;
        more.textContent = '查看全部 ' + all.length + ' 个端口 ›';
      }
    }
  }

  function freePortRow(item) {
    var sm = U.statusMeta(item.dev.status);
    var cm = U.campusMeta(item.campus.id) || { color: '#7d8798', name: item.campus.name };
    var label = U.deviceCode(item.dev, item.idx);
    var btn = U.el('button', {
      type: 'button',
      class: 'fp-row',
      style: '--campus-color:' + cm.color,
      'aria-label': cm.name + ' ' + item.station.name + ' 端口 ' + label + ' · ' + sm.label
    }, [
      U.el('span', { class: 'fp-dot', style: 'background:' + sm.color }),
      U.el('span', { class: 'fp-main' }, [
        U.el('span', { class: 'fp-code', text: label }),
        U.el('span', { class: 'fp-station', text: item.station.name, title: item.station.name })
      ]),
      U.el('span', { class: 'fp-campus', text: cm.name }),
      U.el('span', { class: 'fp-arrow', text: '›' })
    ]);
    btn.addEventListener('click', function () {
      openSheet(item.station, item.dev, item.idx);
    });
    return btn;
  }

  function renderCampusGrid(snap) {
    var grid = dom.campusGrid;
    grid.innerHTML = '';
    var list = U.normalizeCampuses(snap.campuses);
    for (var i = 0; i < list.length; i++) {
      grid.appendChild(campusCard(list[i]));
    }
  }

  function campusCard(c) {
    var meta = U.campusMeta(c.id) || { color: '#7d8798', name: c.name };
    var t = c.totals;
    var isEmpty = t.total <= 0;
    var stationCount = c.stations.length;

    var card = U.el('button', {
      type: 'button',
      class: 'campus-card' + (isEmpty ? ' is-empty' : ''),
      style: '--campus-color:' + meta.color,
      'aria-label': meta.name + '：空闲 ' + (isEmpty ? '无数据' : t.free + ' / ' + t.total)
    });

    card.appendChild(U.el('div', { class: 'campus-card-top' }, [
      U.el('span', { class: 'campus-name', text: meta.name }),
      U.el('span', { class: 'campus-badge', text: isEmpty ? '无数据' : stationCount + ' 站' })
    ]));

    // 空闲 / 总数大字（主指标）+ 空闲率徽标
    var numRow = U.el('div', { class: 'campus-num-row' }, [
      U.el('span', { class: 'campus-free' + (isEmpty ? ' is-zero' : ''), text: isEmpty ? '—' : String(t.free) }),
      U.el('span', { class: 'campus-total', text: isEmpty ? '/ —' : '/ ' + t.total }),
      U.el('span', { class: 'campus-free-unit', text: isEmpty ? '无数据' : '空闲端口' })
    ]);
    card.appendChild(numRow);

    // 空闲率徽标：和大字分开一行，避免把 /1978 挤窄。
    // 无数据时不画（留着只会显示「暂无数据」的灰胶囊，纯噪音）。
    var cardRatio = ratioOf(t);
    if (!isEmpty && cardRatio !== null) {
      card.appendChild(U.el('div', { class: 'campus-ratio-row' }, [
        U.el('span', {
          class: 'ratio-pill ratio-pill-sm' + ratioClass(cardRatio),
          text: ratioLabel(cardRatio)
        })
      ]));
    }

    // 堆叠横向条形图
    var bar = safeChart('stackBar', [{ totals: t, height: 8 }]);
    if (bar) { card.appendChild(bar); }

    // 迷你趋势：只有观测点攒够、且确实存在波动时才画。
    // 点数太少或数值几乎不变时画出来只是一根多余的横线，容易和上面那根堆叠条混在一起。
    var series = bufferSeries(c.id);
    if (safeChart('hasTrend', [series])) {
      var spark = U.el('div', { class: 'campus-spark' });
      var sparkSvg = safeChart('sparkline', [series, { color: meta.color, width: 100, height: 22 }]);
      if (sparkSvg) { spark.appendChild(sparkSvg); }
      card.appendChild(spark);
    } else {
      card.appendChild(U.el('div', { class: 'campus-spark' }));
    }

    var footParts = [];
    if (!isEmpty) {
      footParts.push('占用 ' + t.busy);
      if (t.offline > 0) { footParts.push('离线 ' + t.offline); }
      if (t.unknown > 0) { footParts.push('未知 ' + t.unknown); }
    } else {
      footParts.push('暂无该校区数据');
    }
    card.appendChild(U.el('div', { class: 'campus-foot' }, [
      U.el('span', { class: 'campus-stations', text: footParts.join(' · ') }),
      U.el('span', { text: '›' })
    ]));

    card.addEventListener('click', function () {
      navigate('campus', c.id);
    });
    return card;
  }

  function renderFootnote(snap) {
    var bits = [];
    if (snap.source && snap.source.kind) { bits.push('来源 ' + snap.source.kind); }
    if (snap.source && snap.source.collector) { bits.push(snap.source.collector); }
    if (snap.source && typeof snap.source.confidence === 'number') {
      bits.push('置信度 ' + Math.round(snap.source.confidence * 100) + '%');
    }
    if (!bits.length) { bits.push('数据由 relay 聚合'); }
    dom.homeFootnote.textContent = bits.join(' · ') + ' · 下拉刷新 / 点右上角 ↻';
  }

  /* =========================================================
   * 端口表（每个端口一行；默认全量渲染，不折叠不省略）
   * ========================================================= */
  var PORT_STATUS_FILTERS = [
    { id: 'all', label: '全部' },
    { id: 'free', label: '仅空闲' },
    { id: 'busy', label: '仅占用' },
    { id: 'offline', label: '仅离线' }
  ];

  // 端口行共用的短标签规则（与色块一致，长编码保留在 aria-label 与抽屉里）
  function portLabel(dev, idx) { return cellLabel(dev, idx); }

  function renderPorts(rebuildControls) {
    if (rebuildControls) { buildPortControls(); }
    updatePortFilterState();
    renderPortSummary();
    renderPortList();
  }

  function buildPortControls() {
    var group = dom.portStatusGroup;
    if (group) {
      group.innerHTML = '';
      for (var i = 0; i < PORT_STATUS_FILTERS.length; i++) {
        (function (f) {
          var btn = U.el('button', {
            type: 'button',
            class: 'seg-btn' + (state.ports.status === f.id ? ' is-active' : ''),
            role: 'tab',
            'data-status': f.id,
            text: f.label
          });
          btn.addEventListener('click', function () {
            if (state.ports.status === f.id) { return; }
            state.ports.status = f.id;
            renderPorts(false);
          });
          group.appendChild(btn);
        })(PORT_STATUS_FILTERS[i]);
      }
    }

    var chips = dom.portCampusChips;
    if (chips) {
      chips.innerHTML = '';
      var items = [{ id: 'all', name: '全校', color: '#eef3fa' }].concat(SHZU.campuses);
      for (var j = 0; j < items.length; j++) {
        (function (it) {
          var btn = U.el('button', {
            type: 'button',
            class: 'chip' + (state.ports.campus === it.id ? ' is-active' : ''),
            role: 'tab',
            'data-campus': it.id,
            style: '--chip-color:' + it.color
          }, [
            U.el('span', { class: 'chip-dot' }),
            document.createTextNode(it.name)
          ]);
          btn.addEventListener('click', function () {
            if (state.ports.campus === it.id) { return; }
            state.ports.campus = it.id;
            renderPorts(false);
          });
          chips.appendChild(btn);
        })(items[j]);
      }
    }

    // ---- 数据源维度（只有多源 relay 的站点带 source_id 时才存在）----
    // 哪些源要出现在筛选里：优先用 portSourceIds() 扫出来的（= 快照里实际
    // 出现过的 source_id），而不是 /api/sources 列表 —— 后者可能比快照新，
    // 列出一个此刻一个端口都没有的源只会让人以为筛选坏了。
    var srcChips = dom.portSourceChips;
    if (srcChips) {
      var ids = portSourceIds();
      if (ids.length <= 1) {
        // 只有单源（或者压根没有 source_id）= 这个维度没有意义，整行隐藏
        srcChips.hidden = true;
        srcChips.innerHTML = '';
        if (state.ports.source !== 'all' && ids.indexOf(state.ports.source) < 0) {
          state.ports.source = 'all';
        }
      } else {
        srcChips.hidden = false;
        srcChips.innerHTML = '';
        var opts = [{ id: 'all', name: '全部来源', color: '#eef3fa' }];
        for (var s = 0; s < ids.length; s++) {
          opts.push({
            id: ids[s],
            name: sourceShortName(ids[s]),
            color: sourcePickerColor(ids[s])
          });
        }
        for (var t = 0; t < opts.length; t++) {
          (function (it) {
            var btn = U.el('button', {
              type: 'button',
              class: 'chip' + (state.ports.source === it.id ? ' is-active' : ''),
              role: 'tab',
              'data-source': it.id,
              style: '--chip-color:' + it.color
            }, [
              U.el('span', { class: 'chip-dot' }),
              // 源名可能很长（「充充充充电桩-铭创电子」），套一层 .chip-text 让它在
              // chip 内部省略而不是把整行撑宽、或让后面的 chip 被容器直接切掉一半。
              U.el('span', { class: 'chip-text', text: it.name })
            ]);
            btn.setAttribute('title', it.name);
            btn.addEventListener('click', function () {
              if (state.ports.source === it.id) { return; }
              state.ports.source = it.id;
              renderPorts(false);
            });
            srcChips.appendChild(btn);
          })(opts[t]);
        }
      }
    }
  }

  /* 快照里实际出现过的 source_id 列表（保持稳定顺序：按 /api/sources 的顺序
   * 优先，未列在 sources 里的按出现顺序补在后面）。 */
  function portSourceIds() {
    var seen = {};
    var order = [];
    var list = state.sourceList || [];
    for (var i = 0; i < list.length; i++) {
      var sid = list[i].source_id;
      if (sid && !seen[sid]) { seen[sid] = true; order.push(sid); }
    }
    var ports = flattenPorts(state.snapshot);
    for (var j = 0; j < ports.length; j++) {
      var psid = ports[j].station.source_id;
      if (psid && !seen[psid]) { seen[psid] = true; order.push(psid); }
    }
    // 只保留「当前快照里真的有端口」的源，避免筛选出一个空结果
    var present = {};
    for (var k = 0; k < ports.length; k++) {
      var pid = ports[k].station.source_id;
      if (pid) { present[pid] = true; }
    }
    var out = [];
    for (var m = 0; m < order.length; m++) {
      if (present[order[m]]) { out.push(order[m]); }
    }
    return out;
  }

  /* 源的短名：chip 里放不下「充充充充电桩-铭创电子」这种长名字，
   * 取 sources 给的 name 去掉「充电桩」后缀之类的冗余，仍过长就让 CSS 省略。 */
  function sourceShortName(id) {
    var list = state.sourceList || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].source_id !== id) { continue; }
      var n = list[i].name || SOURCE_FALLBACK_NAMES[id] || id;
      return n;
    }
    return SOURCE_FALLBACK_NAMES[id] || id;
  }

  function sourcePickerColor(id) {
    // 固定色板，按 id 稳定取色（同一源每次刷新颜色不变）
    var palette = ['#4f9cff', '#54d6a0', '#ffb84d', '#c084fc', '#ff7a8a', '#38d9d9'];
    var h = 0;
    for (var i = 0; i < id.length; i++) { h = (h * 31 + id.charCodeAt(i)) % 997; }
    return palette[h % palette.length];
  }

  function updatePortFilterState() {
    var stBtns = dom.portStatusGroup ? U.$$('#portStatusGroup .seg-btn') : [];
    for (var i = 0; i < stBtns.length; i++) {
      stBtns[i].classList.toggle('is-active', stBtns[i].getAttribute('data-status') === state.ports.status);
    }
    var cpBtns = dom.portCampusChips ? U.$$('#portCampusChips .chip') : [];
    for (var j = 0; j < cpBtns.length; j++) {
      cpBtns[j].classList.toggle('is-active', cpBtns[j].getAttribute('data-campus') === state.ports.campus);
    }
    var srcBtns = dom.portSourceChips ? U.$$('#portSourceChips .chip') : [];
    for (var k = 0; k < srcBtns.length; k++) {
      srcBtns[k].classList.toggle('is-active', srcBtns[k].getAttribute('data-source') === state.ports.source);
    }
  }

  function filteredPorts() {
    var all = flattenPorts(state.snapshot);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var it = all[i];
      if (state.ports.campus !== 'all' && it.campus.id !== state.ports.campus) { continue; }
      if (state.ports.status !== 'all' && it.dev.status !== state.ports.status) { continue; }
      // 数据源维度：站点没带 source_id（公共频道 / 老 relay）时，
      // 它不属于任何单源，选「全部来源」才显示，选具体源则不显示 ——
      // 这是唯一不会「凭空归到某个源」的诚实做法。
      if (state.ports.source !== 'all') {
        if (!it.station.source_id || it.station.source_id !== state.ports.source) { continue; }
      }
      out.push(it);
    }
    return out;
  }

  function renderPortSummary() {
    var all = flattenPorts(state.snapshot);
    var shown = filteredPorts();
    state.ports.total = all.length;
    if (dom.portsSummary) {
      dom.portsSummary.textContent = shown.length + ' / ' + all.length + ' 个端口';
    }
    if (dom.portsLegend) {
      dom.portsLegend.innerHTML = '';
      if (all.length === 0) {
        dom.portsLegend.appendChild(U.el('span', { class: 'legend-item', text: '暂无端口数据' }));
      } else {
        // 图例统计的是「当前筛选结果」而不是全校总数：
        // 否则筛出 39 个端口时图例还写着全校 61/49/12/7，
        // 两者对不上会让人以为列表漏了端口。
        var keys = ['free', 'busy', 'offline', 'unknown'];
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var sm = U.statusMeta(k);
          var cnt = 0;
          for (var j = 0; j < shown.length; j++) { if (shown[j].dev.status === k) { cnt++; } }
          dom.portsLegend.appendChild(U.el('span', { class: 'legend-item' }, [
            U.el('span', { class: 'legend-swatch', style: 'background:' + sm.color }),
            document.createTextNode(sm.label + ' '),
            U.el('b', { text: String(cnt) })
          ]));
        }
      }
    }
  }

  function renderPortList() {
    var wrap = dom.portList;
    if (!wrap) { return; }
    wrap.innerHTML = '';
    state.ports.rendered = 0;

    var shown = filteredPorts();
    var emptyBox = dom.portsEmpty;
    if (shown.length === 0) {
      if (emptyBox) {
        emptyBox.hidden = false;
        if (dom.portsEmptyDesc) {
          dom.portsEmptyDesc.textContent = state.snapshot
            ? '当前筛选条件下没有端口，换一个状态或校区试试。'
            : '还没有拿到数据，请稍后刷新。';
        }
      }
      return;
    }
    if (emptyBox) { emptyBox.hidden = true; }

    // 按六校区固定顺序分组（normalizeCampuses 已保证顺序）
    var order = [];
    var groups = {};
    for (var i = 0; i < shown.length; i++) {
      var it = shown[i];
      var cid = it.campus.id;
      if (!groups[cid]) { groups[cid] = []; order.push(cid); }
      groups[cid].push(it);
    }

    // 一次性构建：所有行先进 fragment，最后一次 append，避免 N 次重排
    var frag = document.createDocumentFragment();
    for (var gi = 0; gi < order.length; gi++) {
      var cid2 = order[gi];
      var items = groups[cid2];
      var cm = U.campusMeta(cid2) || { color: '#7d8798', name: items[0].campus.name };

      var head = U.el('div', { class: 'port-group-head', style: '--campus-color:' + cm.color }, [
        U.el('span', { class: 'port-group-dot', style: 'background:' + cm.color }),
        U.el('span', { class: 'port-group-name', text: cm.name }),
        U.el('span', { class: 'port-group-count', text: items.length + ' 个端口' })
      ]);
      frag.appendChild(head);

      for (var k = 0; k < items.length; k++) {
        frag.appendChild(portRow(items[k]));
      }
    }
    wrap.appendChild(frag);
    state.ports.rendered = shown.length;
  }

  /* 反馈达到阈值的端口，状态在数据层已被改成 offline，但 UI 上要说「不可用」
   * 而不是「离线」—— 采集端并没有上报离线，是用户投票投出来的；说「离线」
   * 会让人以为是桩坏了，说「不可用」才是真实含义（插不上/没电/坏了）。
   * 所有渲染位置都走这个函数，保证同一端口处处文字一致。 */
  function statusLabelOf(dev, fallbackStatus) {
    if (dev && dev.feedback_flagged) { return '不可用'; }
    return U.statusMeta((dev && dev.status) || fallbackStatus).label;
  }

  function portRow(item) {
    var dev = item.dev;
    var sm = U.statusMeta(dev.status);
    var label = portLabel(dev, item.idx);
    var stText = statusLabelOf(dev);

    // 右列补充信息：占用显示已占用时长，离线/未知尽量不编造内容
    var extra = '';
    if (dev.status === 'busy') {
      var since = U.parseTime(dev.busy_since);
      if (since !== null) { extra = '已占用 ' + (U.fmtDuration(Date.now() - since) || '—'); }
      else if (dev.order_id) { extra = '订单 ' + dev.order_id; }
    } else if (dev.status === 'free' && dev.power_w) {
      extra = fmtPower(dev.power_w);
    }
    if (!extra && dev.power_w) { extra = fmtPower(dev.power_w); }

    var row = U.el('button', {
      type: 'button',
      class: 'port-row is-' + dev.status,
      'data-device-id': dev.id,
      'aria-label': item.campus.name + ' ' + item.station.name + ' 端口 ' + label + ' · ' + stText
    }, [
      U.el('span', { class: 'port-status-dot', style: 'background:' + sm.color }),
      U.el('span', { class: 'port-code', text: label }),
      U.el('span', { class: 'port-station', text: item.station.name, title: item.station.name }),
      U.el('span', { class: 'port-status-text', style: 'color:' + sm.color, text: stText }),
      U.el('span', { class: 'port-extra', text: extra })
    ]);
    row.addEventListener('click', function () {
      openSheet(item.station, dev, item.idx);
    });
    return row;
  }

  function fmtPower(w) {
    if (!w) { return ''; }
    if (w >= 1000) {
      var kw = w / 1000;
      return kw.toFixed(kw % 1 === 0 ? 0 : 1) + ' kW';
    }
    return w + ' W';
  }

  /* =========================================================
   * 校区详情
   * ========================================================= */
  function currentCampus() {
    if (!state.snapshot) { return null; }
    var list = U.normalizeCampuses(state.snapshot.campuses);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === state.campusId) { return list[i]; }
    }
    return null;
  }

  function renderCampus() {
    var c = currentCampus();
    var wrap = dom.campusDetailHead;
    if (!wrap) { return; }
    wrap.innerHTML = '';

    if (!c) {
      if (!state.snapshot && state.lastError) {
        wrap.appendChild(U.el('div', { class: 'state-block' }, [
          U.el('div', { class: 'state-icon', text: '⚠️' }),
          U.el('div', { class: 'state-title', text: '加载失败' }),
          U.el('div', { class: 'state-desc', text: '无法获取数据：' + (state.lastError.message || '') })
        ]));
      } else if (!state.snapshot) {
        wrap.appendChild(U.el('div', { class: 'card' }, [
          U.el('div', { class: 'skel skel-line', style: 'width:60%' }),
          U.el('div', { class: 'skel skel-line' }),
          U.el('div', { class: 'skel skel-line', style: 'width:80%' })
        ]));
      } else {
        dom.stationList.innerHTML = '';
        dom.stationList.appendChild(U.el('div', { class: 'state-block' }, [
          U.el('div', { class: 'state-icon', text: '🔌' }),
          U.el('div', { class: 'state-title', text: '校区不存在' }),
          U.el('div', { class: 'state-desc', text: '没有找到该校区，返回总览重新选择。' })
        ]));
      }
      return;
    }

    var meta = U.campusMeta(c.id) || { color: '#7d8798', name: c.name };
    var t = c.totals;
    var ratioVal = ratioOf(t);

    var hero = U.el('div', { class: 'card campus-hero' });
    var top = U.el('div', { class: 'campus-hero-top' }, [
      U.el('span', { class: 'campus-hero-dot', style: 'background:' + meta.color }),
      U.el('span', { class: 'campus-hero-name', text: meta.name })
    ]);
    var badge = U.el('span', { class: 'ratio-pill' + ratioClass(ratioVal), text: ratioLabel(ratioVal) });
    top.appendChild(badge);
    hero.appendChild(top);
    var heroBar = safeChart('stackBar', [{ totals: t, height: 10 }]);
    if (heroBar) { hero.appendChild(heroBar); }

    var stats = U.el('div', { class: 'campus-hero-stats' }, [
      hstat(t.total > 0 ? String(t.free) : '—', '空闲', '#35d07f'),
      hstat(t.total > 0 ? String(t.busy) : '—', '占用', '#ff8a4c'),
      hstat(t.total > 0 ? String(t.offline) : '—', '离线', '#8b93a3'),
      hstat(t.total > 0 ? String(t.unknown) : '—', '未知', '#525a68')
    ]);
    hero.appendChild(stats);
    hero.appendChild(U.el('div', { class: 'campus-hero-time',
      text: '共 ' + c.stations.length + ' 个站点 · 最后采集 ' + U.fmtAgo(state.snapshot && state.snapshot.data_at) }));
    wrap.appendChild(hero);

    // 站点列表
    dom.stationList.innerHTML = '';
    if (c.stations.length === 0) {
      dom.stationList.appendChild(U.el('div', { class: 'state-block' }, [
        U.el('div', { class: 'state-icon', text: '🔌' }),
        U.el('div', { class: 'state-title', text: '该校区暂无站点数据' }),
        U.el('div', { class: 'state-desc', text: '采集器还没有归到这个校区的站点，或该校区确实没有充电桩。' })
      ]));
      return;
    }
    // 空闲多的排前面，其次按名称
    var stations = c.stations.slice().sort(function (a, b) {
      var ar = a.totals.total > 0 ? a.totals.free / a.totals.total : -1;
      var br = b.totals.total > 0 ? b.totals.free / b.totals.total : -1;
      if (br !== ar) { return br - ar; }
      return String(a.name).localeCompare(String(b.name), 'zh-CN');
    });
    for (var i = 0; i < stations.length; i++) {
      dom.stationList.appendChild(stationCard(stations[i], meta));
    }
  }

  function hstat(v, label, color) {
    var node = U.el('div', { class: 'hstat' }, [
      U.el('span', { class: 'hstat-v', text: v, style: 'color:' + color }),
      U.el('span', { class: 'hstat-l', text: label })
    ]);
    return node;
  }

  var FOLD_THRESHOLD = 24;      // 超过这个数量默认折叠
  var FOLD_SHOW = 18;           // 折叠时显示前 N 个

  function stationCard(st, meta) {
    var t = st.totals;
    var card = U.el('div', { class: 'station-card' });
    var denom = t.total - t.unknown;
    var ratioVal = denom > 0 ? t.free / denom : null;

    var head = U.el('div', { class: 'station-head' });
    // 站名可能很长（源 B 后缀「（充充充充电桩-铭创电子）」），CSS 已设 ellipsis，
    // 再补 title 让长按/悬停能看到完整站名，不至于永远猜不全。
    head.appendChild(U.el('div', { class: 'station-name', text: st.name, title: st.name }));

    var freeCls = t.total <= 0 ? ' is-none' : (ratioVal !== null && ratioVal < 0.15 ? ' is-low' : '');
    var freeTag = U.el('span', { class: 'station-free' + freeCls });
    if (t.total > 0) {
      freeTag.appendChild(U.el('b', { text: String(t.free) }));
      freeTag.appendChild(document.createTextNode(' 空闲'));
    } else {
      freeTag.appendChild(document.createTextNode('无数据'));
    }
    head.appendChild(freeTag);
    card.appendChild(head);

    if (st.address) {
      card.appendChild(U.el('div', { class: 'station-addr', text: '📍 ' + st.address }));
    }

    // 数量行 + 展开按钮
    var metaRow = U.el('div', { class: 'station-meta-row' });
    var counts = U.el('div', { class: 'station-counts' });
    var countDefs = [['free', t.free], ['busy', t.busy], ['offline', t.offline], ['unknown', t.unknown]];
    for (var ci = 0; ci < countDefs.length; ci++) {
      var key = countDefs[ci][0], val = countDefs[ci][1];
      if (key === 'unknown' && val === 0) { continue; }
      if (key === 'offline' && val === 0) { continue; }
      var sm = U.statusMeta(key);
      counts.appendChild(U.el('span', {}, [
        U.el('i', { class: 'cnt-dot', style: 'background:' + sm.color }),
        document.createTextNode(sm.label + ' ' + val)
      ]));
    }
    metaRow.appendChild(counts);

    var devCount = st.devices.length;
    var many = devCount > 10;
    var fold = devCount > FOLD_THRESHOLD;
    var expanded = !!state.expanded[st.id] || !fold;

    var toggleBtn = null;
    if (devCount > 0) {
      metaRow.appendChild(U.el('span', { class: 'station-counts', text: devCount + ' 个桩' }));
    }
    card.appendChild(metaRow);

    // 桩色块网格
    if (devCount === 0) {
      card.appendChild(U.el('div', { class: 'dev-empty', text: '该站点暂无桩数据' }));
      return card;
    }

    var devicesWrap = U.el('div', {
      class: 'devices' + (many ? ' is-compact' : '') + (devCount > 40 ? ' devices-many' : '')
    });
    var showCount = fold && !expanded ? Math.min(FOLD_SHOW, devCount) : devCount;
    for (var i = 0; i < showCount; i++) {
      devicesWrap.appendChild(deviceCell(st, st.devices[i], i, many));
    }
    card.appendChild(devicesWrap);

    // 折叠/展开只有一个入口，避免上下两个按钮重复
    if (fold) {
      toggleBtn = U.el('button', { type: 'button', class: 'station-toggle' + (expanded ? ' is-open' : '') }, [
        U.el('span', { text: expanded ? '收起' : ('展开剩余 ' + (devCount - showCount) + ' 个桩（共 ' + devCount + ' 个）') }),
        U.el('span', { class: 'chev', text: expanded ? '⌃' : '⌄', style: 'font-size:13px' })
      ]);
      toggleBtn.addEventListener('click', function () {
        state.expanded[st.id] = !state.expanded[st.id];
        renderCampus();
      });
      card.appendChild(toggleBtn);
    }
    return card;
  }

  // 色块里只放得下 3~4 个字符。厂商原始编号经常是 ZH03001 / SHZ-01-03-001 这种长串，
  // 直接塞进 38px 的块会溢出压到相邻块上，所以这里取短编号；
  // 完整编号在桩详情抽屉（deviceCode）和 aria-label 里保留，不影响可访问性。
  function cellLabel(dev, idx) {
    var raw = U.deviceCode(dev, idx);
    if (!raw || raw.length <= 4) { return raw || String(idx + 1); }
    var m = /-(\d+)$/.exec(dev && dev.id ? String(dev.id) : '');
    if (m && m[1].length <= 4) { return m[1]; }
    return String(idx + 1);
  }

  function deviceCell(station, dev, idx, compact) {
    var sm = U.statusMeta(dev.status);
    var label = compact ? '' : cellLabel(dev, idx);
    var cellNode = U.el('button', {
      type: 'button',
      class: 'dev is-' + dev.status,
      'aria-label': '桩 ' + U.deviceCode(dev, idx) + ' ' + statusLabelOf(dev)
    }, [label ? document.createTextNode(label) : '']);
    if (!compact) { cellNode.textContent = label; }
    cellNode.addEventListener('click', function () {
      openSheet(station, dev, idx);
    });
    return cellNode;
  }

  /* =========================================================
   * 桩详情抽屉
   * ========================================================= */
  function openSheet(station, dev, idx) {
    var sm = U.statusMeta(dev.status);
    var stText = statusLabelOf(dev);
    dom.sheetTitle.textContent = '桩 ' + U.deviceCode(dev, idx) + ' · ' + stText;
    var body = dom.sheetBody;
    body.innerHTML = '';

    var pill = U.el('div', { class: 'sheet-status',
      style: 'background:' + sm.dim + ';color:' + sm.color }, [stText]);
    body.appendChild(U.el('div', { style: 'padding:2px 0 8px' }, [pill]));

    var rows = [];
    rows.push(['所属站点', station.name]);
    rows.push(['桩编号', dev.code || U.deviceCode(dev, idx)]);
    if (dev.name) { rows.push(['名称', dev.name]); }
    if (dev.power_w !== null && dev.power_w !== undefined) {
      var kw = dev.power_w / 1000;
      rows.push(['功率', (dev.power_w >= 1000 ? kw.toFixed(kw % 1 === 0 ? 0 : 1) + ' kW' : dev.power_w + ' W') +
        '（' + dev.power_w + ' W）']);
    }
    if (dev.status === 'busy') {
      var since = U.parseTime(dev.busy_since);
      if (since !== null) {
        rows.push(['已占用', U.fmtDuration(Date.now() - since) || '—']);
        rows.push(['开始时间', U.fmtDateTime(dev.busy_since)]);
      } else {
        rows.push(['已占用', '未知开始时间']);
      }
    }
    if (dev.order_id) { rows.push(['订单号', dev.order_id]); }
    if (station.updated_at) { rows.push(['站点更新', U.fmtDateTime(station.updated_at) + '（' + U.fmtAgo(station.updated_at) + '）']); }
    rows.push(['设备 ID', dev.id]);

    for (var i = 0; i < rows.length; i++) {
      var row = U.el('div', { class: 'sheet-row' }, [
        U.el('span', { class: 'k', text: rows[i][0] }),
        U.el('span', { class: 'v', text: String(rows[i][1]) })
      ]);
      body.appendChild(row);
    }

    // 只读提示放在反馈区**上面**：需求要求反馈按钮在「详细信息最底部」，
    // 所以反馈块必须是 body 的最后一个子节点。
    body.appendChild(U.el('div', { class: 'hint-line',
      text: '提示：本页只读展示，不能远程启动充电。数据来自小程序接口的聚合快照。' }));

    // ---- 端口反馈区（需求：详细信息最底部加反馈按钮，只有一个「不可用」选项）----
    body.appendChild(buildFeedbackBlock(station, dev, idx));

    dom.sheetMask.hidden = false;
    document.body.style.overflow = 'hidden';
    // 每次打开抽屉都拉一次最新计数：用户可能刚在别处看到有人反馈过
    loadFeedback();
  }

  /* ---------------------------------------------------------
   * 桩详情底部的反馈块
   * ---------------------------------------------------------
   * 需求原文：
   *   「每个端口的详细信息最底部加一个反馈按钮，反馈按钮点开后只有
   *     一个选项，就是不可用，点击不可用后需要确定是否提交，用户提交
   *     后在桩的详细信息里添加一个『其他用户提交不可用次数』，次数达到
   *     20 次后将该端口标记为不可用或离线。」
   *
   * 实现分三层：
   *   1. 折叠态：一行「其他用户提交不可用次数：N」+「提交反馈」按钮
   *   2. 展开态：唯一选项「不可用」（可选中），点「提交」弹确认
   *   3. 确认后 POST /feedback，成功后本地计数立即 +1 并重渲染
   *
   * 被反馈标记过的端口（count >= 20）在这里显示一条红条说明
   * 「原状态是什么、为什么现在显示离线」，不要凭空改状态还不解释。
   */
  function buildFeedbackBlock(station, dev, idx) {
    var box = U.el('div', { class: 'fb-block', 'data-device-id': String(dev.id) });
    var th = state.feedback.threshold || SHZU.feedbackThreshold || 20;
    var count = U.num(dev.feedback_count);
    var flagged = count >= th;

    if (flagged) {
      box.appendChild(U.el('div', { class: 'fb-flag-line',
        text: '该端口已被 ' + count + ' 位用户反馈不可用，暂按「离线」处理' +
          (dev.raw_status ? '（采集端上报：' + U.statusMeta(dev.raw_status).label + '）' : '') + '。' }));
    }

    var countRow = U.el('div', { class: 'fb-count' + (flagged ? ' is-flagged' : ''), id: 'sheetFeedbackCount' }, [
      U.el('span', { class: 'fb-count-label', text: '其他用户提交不可用次数' }),
      /* 数字与「（已标记不可用）」包在同一个右侧组里，
       * 否则 .fb-count 的 space-between 会把数字挤到中间去。 */
      U.el('span', { class: 'fb-count-right' }, [
        U.el('b', { text: String(count) }),
        flagged ? U.el('span', { class: 'fb-count-flag', text: '（已标记不可用）' }) : null
      ])
    ]);
    box.appendChild(countRow);

    // 折叠态：按钮（id 固定为 btnFeedback，方便外部/测试直接定位）
    /* 「每人只能点一次」：本机已经反馈过这个端口就不再给按钮，改成一条说明。
     * 服务端是权威（按 client_id 去重，重复投返回 duplicate:true 且不写 KV），
     * 这里只是省一次无意义的往返、也别让用户反复戳一个注定不生效的按钮。
     * 本地记录会随 localStorage 清空而失效，那时的唯一后果是「能再投一次」，
     * 服务端仍会挡住，可接受。 */
    var alreadyDone = SHZU.hasFeedbackDone(dev.id);
    var actionBtn = U.el('button', {
      type: 'button', class: 'btn btn-primary fb-btn', id: 'btnFeedback',
      text: alreadyDone ? '您已反馈过这个端口' : '反馈：这个端口不可用'
    });
    if (alreadyDone) {
      actionBtn.disabled = true;
      actionBtn.classList.add('is-done');
      actionBtn.setAttribute('title', '同一个端口每人只能反馈一次');
    }
    box.appendChild(actionBtn);

    // 展开态容器
    var panel = U.el('div', { class: 'fb-panel', style: 'display:none' });
    var option = U.el('button', {
      type: 'button', class: 'fb-option', id: 'fbUnavailable', 'aria-pressed': 'false'
    }, [
      U.el('span', { class: 'fb-dot' }),
      U.el('span', { text: '不可用（插不上、没电、坏了）' })
    ]);
    var submitBtn = U.el('button', {
      type: 'button', class: 'btn btn-primary fb-btn', text: '提交'
    });
    var cancelBtn = U.el('button', {
      type: 'button', class: 'btn btn-ghost fb-btn', text: '收起'
    });
    var noteEl = U.el('p', { class: 'fb-note',
      text: '只有「不可用」这一项。同一端口被 ' + th + ' 位用户反馈后会自动标记为离线。' });
    var btnRow = U.el('div', { class: 'btn-row', style: 'display:flex;gap:8px;margin-top:2px' }, [cancelBtn, submitBtn]);
    panel.appendChild(option);
    panel.appendChild(btnRow);
    panel.appendChild(noteEl);
    box.appendChild(panel);

    var selected = false;
    actionBtn.addEventListener('click', function () {
      if (actionBtn.disabled) { return; }
      panel.style.display = '';
      actionBtn.style.display = 'none';
    });
    cancelBtn.addEventListener('click', function () {
      panel.style.display = 'none';
      actionBtn.style.display = '';
      selected = false;
      option.classList.remove('is-selected');
      option.setAttribute('aria-pressed', 'false');
    });
    option.addEventListener('click', function () {
      selected = !selected;
      option.classList.toggle('is-selected', selected);
      option.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    submitBtn.addEventListener('click', function () {
      if (!selected) { toast('请先选「不可用」'); return; }
      askConfirm(
        '确认提交反馈',
        '确认该端口（' + U.deviceCode(dev, idx) + '）现在不可用？提交后其他用户也能看到。',
        function () { doSubmitFeedback(station, dev, idx, box, countRow, count, th); }
      );
    });

    return box;
  }

  /* 提交一条「不可用」反馈。
   * 成功：本地计数 +1、重算 overlay（可能刚好跨过 20 次这个坎）、重渲染抽屉。
   * 失败：明确告诉用户失败原因（没配云中转 / 网络 / HTTP / 风控），不改本地计数 ——
   *       宁可显示旧的 N，也不要骗用户「已提交」。
   *
   * 服务端三种「不算失败但也不算新增」的返回，要分别给出准确的提示：
   *   - {duplicate:true}      这个 client_id 已经投过这个端口了 → 记到本地，别让再点
   *   - {capped:true}         该端口总票数到 999 封顶 → 谢谢他，但计数不会再涨
   *   - {budget_exhausted:true} 今天全站反馈额度用完了 → 说明白，别让用户以为是自己被针对 */
  function doSubmitFeedback(station, dev, idx, box, countRow, oldCount, threshold) {
    var clientId = SHZU.ensureClientId();
    api.submitFeedback(dev.id, 'unavailable', clientId).then(function (res) {
      /* 服务端明确说「你已经投过了」：不改计数（本来就 +0），
       * 但要把本地标记补上，否则刷新一下又出现可点按钮。 */
      if (res && res.duplicate) {
        SHZU.markFeedbackDone(dev.id);
        renderCurrent();
        var dupCount = U.num(res.count);
        if (dupCount > 0) {
          var bd = waitForCountRow(countRow, dupCount);
          bd.textContent = String(dupCount);
        }
        toast('这个端口您已经反馈过了，每人只能反馈一次', 2600);
        return;
      }
      /* 今日全站反馈额度用尽：不改计数，明确告诉用户是额度而不是他的问题。 */
      if (res && res.budget_exhausted) {
        toast('今天全站反馈次数已达上限，请明天再试', 2800);
        return;
      }

      var newCount = oldCount + 1;
      if (res && res.count !== undefined && res.count !== null) {
        var n = U.num(res.count);
        if (n > 0) { newCount = n; }
      }
      // 服务端返回了阈值就用它的（服务端才是权威），否则用本地配置
      var th = (res && res.threshold) ? U.num(res.threshold) : threshold;
      if (!th) { th = SHZU.feedbackThreshold || 20; }
      // 本地计数立即生效：用户点了提交就该立刻看到数字变化
      state.feedback.counts = state.feedback.counts || {};
      state.feedback.counts[dev.id] = newCount;
      state.feedback.threshold = th;
      saveFeedbackCache(state.feedback.counts, th);
      /* 记「本机已投过这个端口」：服务端已经按 client_id 去重了，
       * 这里只是让按钮立刻变成「您已反馈过」而不用等下一次重渲染。 */
      SHZU.markFeedbackDone(dev.id);
      rebuildSnapshotWithFeedback();
      renderCurrent();
      // 抽屉里就地更新，不关掉（用户可能想接着看别的字段）
      var b = waitForCountRow(countRow, newCount);
      countRow.classList.toggle('is-flagged', newCount >= th);
      b.textContent = String(newCount);
      if (newCount >= th) {
        if (!box.querySelector('.fb-flag-line')) {
          box.insertBefore(U.el('div', { class: 'fb-flag-line',
            text: '该端口已被 ' + newCount + ' 位用户反馈不可用，暂按「离线」处理。' }),
            box.firstChild);
        }
      }
      if (res && res.capped) {
        toast('已提交。该端口的反馈计数已达上限（' + newCount + '）', 2600);
      } else {
        toast(newCount >= th
          ? ('已提交，该端口已标记为不可用（' + newCount + '/' + th + '）')
          : ('已提交，感谢反馈（' + newCount + '/' + th + '）'), 2600);
      }
    }).catch(function (err) {
      /* 反馈请求也可能撞上风控 429（反馈是独立的桶，5 次/分钟）。
       * 撞上就走统一的惩罚流程：弹窗 + 锁刷新 + 停发两分钟。 */
      var pen = rateLimitFromError(err);
      if (pen) {
        state.rateLimit.until = 0;
        enterRateLimit(pen);
        return;
      }
      var msg = (err && err.message) ? err.message : '提交失败';
      if (err && err.kind === 'nocloud') {
        msg = '没有配置云中转地址，暂时无法提交反馈';
      }
      toast('提交失败：' + msg, 2800);
    });
  }

  function waitForCountRow(countRow, n) {
    var b = countRow.querySelector('b');
    if (!b) {
      b = U.el('b', { text: String(n) });
      countRow.appendChild(b);
    }
    return b;
  }

  /* 通用确认弹窗。不用 window.confirm：老 WebView 里它会冻结渲染线程，
   * 而且样式完全不可控（需求要求「点击不可用后需要确定是否提交」）。 */
  var confirmCb = null;
  function askConfirm(title, text, onOk) {
    if (!dom.confirmMask) {
      // 极端降级：DOM 缺失时直接执行，不要卡住用户
      if (typeof onOk === 'function') { onOk(); }
      return;
    }
    confirmCb = onOk;
    if (dom.confirmTitle) { dom.confirmTitle.textContent = title; }
    if (dom.confirmText) { dom.confirmText.textContent = text; }
    dom.confirmMask.hidden = false;
  }

  function closeConfirm(ok) {
    if (dom.confirmMask) { dom.confirmMask.hidden = true; }
    var cb = confirmCb;
    confirmCb = null;
    if (ok && typeof cb === 'function') { cb(); }
  }

  function closeSheet() {
    dom.sheetMask.hidden = true;
    document.body.style.overflow = '';
  }

  /* =========================================================
   * 风控惩罚（限流触发后的两分钟静默期）
   * ---------------------------------------------------------
   * 用户要求原文：「如果用户触发了限制，要给它弹窗提醒『您已触发风控限制，
   * 请两分钟后再试』，用户关闭弹窗后不可使用刷新功能，对用户停止下发数据
   * 两分钟，两分钟后恢复」。
   *
   * 为什么前端也要停：服务端已经把**这个客户端**罚了 120 秒，前端如果还每 15
   * 秒自动刷一次，唯一的结果就是把自己的惩罚期一直续上去（第 11 次之后每次请求
   * 都在罚期内，罚期可能被不断刷新），用户永远好不了。所以必须配合：
   *   1. 弹一次窗（不是每拍弹，shownFor 记着）
   *   2. 关窗后把刷新按钮置灰、自动刷新定时器停掉
   *   3. 显示「还剩 N 秒」的倒计时横幅，到 0 自动恢复并立刻拉一次数据
   *
   * 注意这里**只处理硬惩罚**（penalty_seconds > 0）。按 IP 的软拒绝
   * （penalty_seconds === 0，校园 NAT 下同一出口请求太多）不弹窗、不锁刷新 ——
   * 否则就成了「一个人手快，整栋楼被弹窗锁两分钟」，那正是主键要从 IP 改成
   * 客户端的原因。软拒在 api.js / publicfeed.js 里被归成 kind='throttled'，
   * 本节的 rateLimitFromError() 认不出来，自然就不进惩罚流程。
   * ========================================================= */

  /* 当前是否在惩罚期内（读内存 + 存盘兜底，重开 App 也算） */
  function rateLimitRemainingMs() {
    var until = state.rateLimit.until || SHZU.rateLimitUntil();
    if (!until) { return 0; }
    var left = until - Date.now();
    return left > 0 ? left : 0;
  }

  function isRateLimited() {
    return rateLimitRemainingMs() > 0;
  }

  /* 触发惩罚：写盘 + 弹窗 + 锁刷新 + 起倒计时。
   * penaltySec 来自服务端 429 响应（默认 120）。 */
  function enterRateLimit(penaltySec) {
    var sec = Number(penaltySec) || 120;
    if (sec < 5) { sec = 5; }
    var until = Date.now() + sec * 1000;
    // 已经在罚期里且新罚期不比旧的晚 → 不重复处理（避免每秒续期）
    if (state.rateLimit.until && until <= state.rateLimit.until) { return; }
    state.rateLimit.until = until;
    SHZU.setRateLimitUntil(until);
    /* 把客户端配额记录清空：惩罚期满后应该是一个**全新的一分钟窗口**。
     * 不清的话，解锁瞬间窗口里还压着十来条记录，下一次刷新立刻又超限，
     * 用户会陷在「刚解锁就又弹窗」的死循环里。 */
    if (SHZU.clientQuotaReset) { SHZU.clientQuotaReset(); }
    stopAutoRefresh();
    updateRefreshButtonLock();
    renderRateLimitBanner();
    showRateLimitDialog(sec);
    startRateLimitTicker();
  }

  function startRateLimitTicker() {
    if (state.rateLimit.timer) { clearInterval(state.rateLimit.timer); state.rateLimit.timer = null; }
    state.rateLimit.timer = setInterval(function () {
      var left = rateLimitRemainingMs();
      if (left <= 0) {
        clearInterval(state.rateLimit.timer);
        state.rateLimit.timer = null;
        exitRateLimit();
        return;
      }
      renderRateLimitBanner();
      // 弹窗开着时同步更新弹窗里那个倒计时
      updateRateLimitDialogCountdown();
    }, 1000);
  }

  function exitRateLimit() {
    state.rateLimit.until = 0;
    state.rateLimit.shownFor = 0;
    SHZU.setRateLimitUntil(0);
    renderRateLimitBanner();
    updateRefreshButtonLock();
    // 恢复自动刷新并立刻补一次数据（用户等了 120 秒，不该再等一个周期）
    scheduleAutoRefresh();
    /* force:true 很关键 —— 这一发是惩罚结束后的补数据，必须跳过配额检查，
     * 否则解锁瞬间就被自己的配额拦下，界面空白到下一个 15 秒周期。 */
    loadSnapshot({ silent: true, force: true });
    if (dom.btnRefresh) { dom.btnRefresh.classList.remove('is-locked'); }
  }

  /* 刷新按钮的锁定态：惩罚期内置灰 + 禁用。用 disabled 而不是只靠样式，
   * 否则键盘/读屏仍能触发。 */
  function updateRefreshButtonLock() {
    var btn = dom.btnRefresh;
    if (!btn) { return; }
    var locked = isRateLimited();
    btn.disabled = locked;
    btn.classList.toggle('is-locked', locked);
    if (locked) {
      btn.setAttribute('title', '风控限制中，' + Math.ceil(rateLimitRemainingMs() / 1000) + ' 秒后可刷新');
      btn.setAttribute('aria-disabled', 'true');
    } else {
      btn.removeAttribute('title');
      btn.removeAttribute('aria-disabled');
    }
  }

  /* 页面顶部的倒计时横幅（惩罚期内可见） */
  function renderRateLimitBanner() {
    var box = dom.rateLimitBanner;
    if (!box) { return; }
    var left = rateLimitRemainingMs();
    if (left <= 0) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    var txt = box.querySelector('.rate-limit-text');
    if (txt) {
      txt.textContent = '您已触发风控限制，请稍后再试（还需等待 ' +
        Math.ceil(left / 1000) + ' 秒）';
    }
    updateRefreshButtonLock();
  }

  /* 弹窗：只在「新进入惩罚期」时弹一次，不是每拍弹。
   * 文案按用户原文：「您已触发风控限制，请两分钟后再试」。 */
  function showRateLimitDialog(penaltySec) {
    if (!dom.rateLimitMask) { return; }
    state.rateLimit.shownFor = state.rateLimit.until;
    if (dom.rateLimitText) {
      dom.rateLimitText.textContent =
        '您已触发风控限制，请两分钟后再试。关闭本提示后刷新功能将暂停 ' +
        Math.round(penaltySec / 60 * 10) / 10 + ' 分钟（' + penaltySec + ' 秒），' +
        '期间不再向服务器请求数据，倒计时结束后自动恢复。';
    }
    if (dom.rateLimitSub) {
      dom.rateLimitSub.textContent = '倒计时：' + penaltySec + ' 秒';
    }
    dom.rateLimitMask.hidden = false;
  }

  function updateRateLimitDialogCountdown() {
    if (!dom.rateLimitMask || dom.rateLimitMask.hidden) { return; }
    if (!dom.rateLimitSub) { return; }
    var left = Math.ceil(rateLimitRemainingMs() / 1000);
    if (left <= 0) { return; }
    dom.rateLimitSub.textContent = '倒计时：' + left + ' 秒';
  }

  function closeRateLimitDialog() {
    if (dom.rateLimitMask) { dom.rateLimitMask.hidden = true; }
    updateRefreshButtonLock();
  }

  /* =========================================================
   * 历史页
   * ========================================================= */
  function renderHistoryView(rebuildControls) {
    if (rebuildControls) { buildHistoryControls(); }
    updateHistorySegState();
    renderHistoryChart(false);
    renderFleetTotals();
    var hint = dom.historyHint;
    if (hint) {
      var range = findRange(state.history.hours);
      hint.textContent = U.campusName(state.history.campus) + ' · ' + (range ? range.label : state.history.hours + ' 小时');
    }
  }

  function findRange(hours) {
    for (var i = 0; i < SHZU.historyRanges.length; i++) {
      if (SHZU.historyRanges[i].hours === hours) { return SHZU.historyRanges[i]; }
    }
    return null;
  }

  function buildHistoryControls() {
    // 时间范围
    var rangeGroup = dom.rangeGroup;
    rangeGroup.innerHTML = '';
    for (var i = 0; i < SHZU.historyRanges.length; i++) {
      (function (r) {
        var btn = U.el('button', {
          type: 'button',
          class: 'seg-btn' + (state.history.hours === r.hours ? ' is-active' : ''),
          role: 'tab',
          'data-hours': r.hours,
          text: r.label
        });
        btn.addEventListener('click', function () {
          if (state.history.hours === r.hours) { return; }
          state.history.hours = r.hours;
          state.history.bucket = r.bucket;
          SHZU.saveSettings({ historyHours: r.hours });
          updateHistorySegState();
          loadHistory({});
        });
        rangeGroup.appendChild(btn);
      })(SHZU.historyRanges[i]);
    }

    // 校区 chips
    var chips = dom.campusChips;
    chips.innerHTML = '';
    var items = [{ id: 'all', name: '全校', color: '#eef3fa' }].concat(SHZU.campuses);
    for (var j = 0; j < items.length; j++) {
      (function (it) {
        var chip = U.el('button', {
          type: 'button',
          class: 'chip' + (state.history.campus === it.id ? ' is-active' : ''),
          style: '--chip-color:' + it.color,
          role: 'tab',
          'data-campus': it.id
        }, [
          U.el('span', { class: 'chip-dot' }),
          document.createTextNode(it.name)
        ]);
        chip.addEventListener('click', function () {
          if (state.history.campus === it.id) { return; }
          state.history.campus = it.id;
          SHZU.saveSettings({ historyCampus: it.id });
          updateHistorySegState();
          loadHistory({});
        });
        chips.appendChild(chip);
      })(items[j]);
    }
  }

  function updateHistorySegState() {
    var segs = U.$$('#rangeGroup .seg-btn');
    for (var i = 0; i < segs.length; i++) {
      var h = Number(segs[i].getAttribute('data-hours'));
      segs[i].classList.toggle('is-active', h === state.history.hours);
    }
    var chips = U.$$('#campusChips .chip');
    for (var j = 0; j < chips.length; j++) {
      chips[j].classList.toggle('is-active', chips[j].getAttribute('data-campus') === state.history.campus);
    }
  }

  /* 「当前空闲率」的取值：**优先用当前快照**，历史曲线只作兜底。
   *
   * 为什么这是必须的：以前这个数字只从历史点里取（points 最后一个桶）。
   * 而历史点只有 relay 的 /api/history 才有 —— 公网域名上根本没有 relay，
   * 于是网页版的历史页永远是「—」，只有连得上 relay 的平板客户端能看到。
   * 但语义上「当前空闲率」本来就该是「最近一次采集」的数，而快照就是那个数。
   * 历史曲线最多旧 10 分钟（KV 粒度），快照只旧几十秒，谁新一目了然。
   */
  function snapshotTotalsFor(campusId) {
    var snap = state.snapshot;
    if (!snap) { return null; }
    if (!campusId || campusId === 'all') { return snap.totals || null; }
    var list = U.normalizeCampuses(snap.campuses);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === campusId) { return list[i].totals || null; }
    }
    return null;
  }

  function renderHistoryChart(forceSkeleton) {
    var box = dom.chartBox;
    if (!box) { return; }
    var h = state.history;

    // 当前值
    var curVal = dom.chartCurVal;
    var statsBox = dom.chartStats;
    var foot = dom.chartFoot;

    // 快照给出的「此刻」空闲率（严格按 free/(total−unknown) 口径，与首页徽标一致）
    var nowRatio = ratioOf(snapshotTotalsFor(h.campus));
    var nowSnap = state.snapshot;

    function paintCur(ratioVal) {
      if (ratioVal === null || typeof ratioVal !== 'number') {
        curVal.textContent = '—';
        curVal.className = 'chart-cur-val is-none';
        return;
      }
      curVal.textContent = U.pct(ratioVal, 1);
      curVal.className = 'chart-cur-val' + (ratioVal < 0.15 ? ' is-low' : '');
    }

    if (h.loading && !h.data) {
      box.innerHTML = '';
      box.appendChild(U.el('div', { class: 'skel skel-chart' }));
      paintCur(nowRatio);            // 加载中也能先把「现在」显示出来
      statsBox.innerHTML = '';
      foot.textContent = '正在加载历史数据…';
      return;
    }

    if (!h.data || !h.data.points || h.data.points.length === 0) {
      box.innerHTML = '';
      var width = Math.max(260, box.clientWidth || 340);
      var emptyBox = U.el('div', { class: 'chart-box' });
      // charts.js 挂掉时退回纯 DOM 占位：没有 SVG 也要把「暂无历史数据」说清楚，
      // 而不是让整个历史页因为 svgEl undefined 而抛异常。
      var emptySvg = safeChart('svgEl', ['svg', { viewBox: '0 0 ' + width + ' 180', width: width, height: 180, class: 'area-svg' }]);
      if (emptySvg) {
        var emptyRect = safeChart('svgEl', ['rect', { x: 38, y: 12, width: Math.max(10, width - 48), height: 144, class: 'area-empty-box' }]);
        if (emptyRect) { emptySvg.appendChild(emptyRect); }
        var txt = safeChart('svgEl', ['text', { x: width / 2, y: 90, 'text-anchor': 'middle', class: 'c-empty' }]);
        if (txt) {
          txt.textContent = h.error ? '历史数据加载失败' : '暂无历史数据';
          emptySvg.appendChild(txt);
        }
        box.appendChild(emptySvg);
      } else {
        box.appendChild(U.el('div', { class: 'chart-box chart-box-fallback' }, [
          U.el('div', { class: 'c-empty', text: h.error ? '历史数据加载失败' : '暂无历史数据' })
        ]));
      }
      paintCur(nowRatio);
      statsBox.innerHTML = '';
      // 曲线空着也要把「现在多少」说清楚，并告诉用户曲线什么时候会有
      foot.textContent = h.error
        ? ('曲线暂时取不到：' + (h.error.message || '') + '。上面的当前值来自最新一次采集。')
        : ('曲线还在攒数据（每 5~10 分钟一个点，攒够两个点就画）。上面的当前值来自 ' +
           (nowSnap && nowSnap.data_at ? U.fmtAgo(nowSnap.data_at) : '最新一次采集') + '。');
      return;
    }

    var points = h.data.points;
    var last = points[points.length - 1];
    var lastRatio = (typeof last.free_ratio === 'number') ? last.free_ratio : 0;
    /* 有快照就用快照（只旧几十秒），没有才退回曲线最后一点（可能旧 10 分钟）。
     * 这条是「网页端看不到当前空闲率」的正解：以前这里只有曲线，而公网域名上
     * 没有 relay 就没有曲线，数字于是永远是「—」。 */
    paintCur(nowRatio === null ? lastRatio : nowRatio);
    /* 标签文案：2026-10-21 用户先质疑「当前空闲率」是文案错误、要求改成平均，
     * 随后又明确要求改回「当前空闲率」（连下面的折线一起）——按用户口径走，
     * 这里固定显示「当前空闲率」。数值优先取当前快照，其次取最后一个时间桶。 */
    if (dom.chartCurLabel) {
      dom.chartCurLabel.textContent = '当前空闲率';
      dom.chartCurLabel.setAttribute('title', '最近一次采集统计出的空闲率');
    }

    // 统计
    var vals = [];
    for (var i = 0; i < points.length; i++) {
      if (typeof points[i].free_ratio === 'number') { vals.push(points[i].free_ratio); }
    }
    var maxV = vals.length ? Math.max.apply(null, vals) : 0;
    var minV = vals.length ? Math.min.apply(null, vals) : 0;
    var avgV = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : 0;
    statsBox.innerHTML = '';
    statsBox.appendChild(U.el('span', {}, [document.createTextNode('最高 '), U.el('b', { text: U.pct(maxV, 0) })]));
    statsBox.appendChild(U.el('span', {}, [document.createTextNode('最低 '), U.el('b', { text: U.pct(minV, 0) })]));
    statsBox.appendChild(U.el('span', {}, [document.createTextNode('平均 '), U.el('b', { text: U.pct(avgV, 0) })]));

    var color = state.history.campus === 'all' ? '#35d07f' : U.campusColor(state.history.campus);
    box.innerHTML = '';
    // 曲线自己 append 进 box；safeChart 失败时 box 保持空，下面 foot 的说明文字兜住。
    safeChart('areaChart', [box, points, { color: color, height: box.clientWidth < 340 ? 180 : 200 }]);

    var bucketSec = h.data.bucket_seconds || 600;
    var t0 = U.parseTime(points[0].t), t1 = U.parseTime(points[points.length - 1].t);
    var spanTxt = (t0 !== null && t1 !== null)
      ? (U.fmtDateTime(points[0].t) + ' → ' + U.fmtDateTime(points[points.length - 1].t))
      : '';
    foot.textContent = [
      spanTxt,
      '共 ' + points.length + ' 个数据点 · 粒度 ' + bucketText(bucketSec)
    ].filter(Boolean).join(' · ') + originNote(h) + (h.fromCache ? ' · 离线缓存' : '');
  }

  /* 曲线从哪来：relay 最细，云端环形缓冲 10 分钟粒度，本机采样 5 分钟一个点。
   * 用户看到「点很少」时得知道这是数据来源的限制，不是程序坏了。 */
  function originNote(h) {
    if (!h) { return ''; }
    if (h.from_local) { return ' · 本机采样（未连上服务器）'; }
    if (h.from_cloud) { return ' · 云端历史（约 10 分钟一个点）'; }
    return '';
  }

  function renderFleetTotals() {
    var box = dom.fleetTotals;
    if (!box) { return; }
    box.innerHTML = '';
    var snap = state.snapshot;
    var t = snap ? snap.totals : U.zeroTotals();
    var keys = ['free', 'busy', 'offline', 'unknown'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var sm = U.statusMeta(k);
      var v = U.num(t[k]);
      var ratioV = t.total > 0 ? v / t.total : 0;
      var row = U.el('div', { class: 'dist-row' }, [
        U.el('div', { class: 'dist-label' }, [
          U.el('span', {}, [
            U.el('i', { class: 'cnt-dot', style: 'background:' + sm.color }),
            document.createTextNode(sm.label)
          ]),
          U.el('b', { text: v + ' / ' + t.total + ' · ' + U.pct(ratioV, 1) })
        ]),
        U.el('div', { class: 'dist-bar' }, [
          U.el('i', { style: 'width:' + (ratioV * 100).toFixed(1) + '%;background:' + sm.color })
        ])
      ]);
      box.appendChild(row);
    }
  }

  /* =========================================================
   * 设置页
   * ========================================================= */
  function renderSettings() {
    var relay = SHZU.relay || '';
    dom.inputRelay.value = relay;
    if (dom.inputTopic) { dom.inputTopic.value = SHZU.publicTopic || ''; }
    buildRefreshGroup();
    renderSettingsStatus();
    dom.appVersionEl.textContent = SHZU.version;
  }

  function buildRefreshGroup() {
    var group = dom.refreshGroup;
    if (!group) { return; }
    group.innerHTML = '';
    var options = [
      { sec: 15, label: '15 秒' },
      { sec: 30, label: '30 秒' },
      { sec: 60, label: '1 分钟' },
      { sec: 120, label: '2 分钟' },
      { sec: 0, label: '手动' }
    ];
    for (var i = 0; i < options.length; i++) {
      (function (op) {
        var btn = U.el('button', {
          type: 'button',
          class: 'seg-btn' + (state.settings.refreshSeconds === op.sec ? ' is-active' : ''),
          'data-sec': op.sec,
          text: op.label
        });
        btn.addEventListener('click', function () {
          state.settings = SHZU.saveSettings({ refreshSeconds: op.sec });
          scheduleAutoRefresh();
          var acts = U.$$('#refreshGroup .seg-btn');
          for (var k = 0; k < acts.length; k++) {
            acts[k].classList.toggle('is-active', Number(acts[k].getAttribute('data-sec')) === op.sec);
          }
          dom.refreshHint.textContent = op.sec > 0 ? ('每 ' + op.sec + ' 秒自动刷新一次（后台标签页暂停）') : '已关闭自动刷新，只在下拉/点刷新时更新';
        });
        group.appendChild(btn);
      })(options[i]);
    }
    dom.refreshHint.textContent = state.settings.refreshSeconds > 0
      ? ('每 ' + state.settings.refreshSeconds + ' 秒自动刷新一次（后台标签页暂停）')
      : '已关闭自动刷新，只在下拉/点刷新时更新';
  }

  function renderSettingsStatus() {
    var kv = dom.settingsKv;
    if (!kv) { return; }
    kv.innerHTML = '';
    var snap = state.snapshot;
    var srcName = { 'same-origin': '同源（相对路径）', 'query': 'URL 参数 ?relay=', 'storage': 'localStorage / 设置页' }[SHZU.relaySource] || '未知';
    var topicSrc = { 'default': 'App 内置默认值', 'query': 'URL 参数 ?topic=', 'storage': 'localStorage / 设置页' }[SHZU.publicTopicSource] || '未知';
    var cloudSrc = { 'default': 'App 内置默认值', 'query': 'URL 参数 ?cloud=',
                     'storage': 'localStorage / 设置页', 'storage-off': '已在设置页关闭',
                     'query-off': '本次用 ?cloud=off 关闭',
                     /* 用根域名打开时自动识别，用户没配过任何东西 */
                     'same-origin': '当前域名（同源，自动识别）' }[SHZU.publicCloudSource] || '未配置';
    var cloudText = SHZU.publicCloud
      ? (SHZU.publicCloud + '（' + cloudSrc + '）')
      : ('未启用（只走 ntfy；' + cloudSrc + '）');
    var stateText;
    if (!snap) {
      stateText = state.lastError ? '获取失败' : '未加载';
    } else if (state.source === 'public-feed') {
      // 公共频道有两条路：自己的域名（Cloudflare Worker）优先，失败才退 ntfy。
      // 界面上必须说清是哪一条 —— 两条路的配额/新鲜度完全不同，出问题时
      // 「到底走的哪个」是第一个要确认的事。
      if (snap && snap.public_feed_from === 'cloud') {
        stateText = '公共频道（自己的域名）' + (isStaleSnapshot(snap) ? ' · 可能过期' : '');
      } else {
        stateText = '公共频道（ntfy.sh）' + (isStaleSnapshot(snap) ? ' · 可能过期' : '');
      }
    } else if (state.source === 'sw-cache') {
      stateText = '离线缓存（Service Worker）' + (isStaleSnapshot(snap) ? ' · 可能过期' : '');
    } else if (state.source === 'cache') {
      stateText = '离线缓存（本地）' + (isStaleSnapshot(snap) ? ' · 可能过期' : '');
    } else {
      stateText = 'relay 实时' + (isStaleSnapshot(snap) ? ' · 可能过期' : '');
    }
    var rows = [
      ['数据状态', stateText],
      ['公共频道', SHZU.publicTopic + '（' + topicSrc + '）'],
      ['云中转', cloudText],
      ['relay 地址', SHZU.relay || '同源（相对路径）'],
      ['relay 来源', srcName],
      ['采集时间', snap && snap.data_at ? (U.fmtDateTime(snap.data_at) + '（' + U.fmtAgo(snap.data_at) + '）') : '—'],
      ['聚合时间', snap && snap.generated_at ? U.fmtDateTime(snap.generated_at) : '—'],
      ['总桩数', snap ? String(snap.totals.total) : '—'],
      ['服务版本', (snap && snap.source && snap.source.collector) || '—']
    ];
    for (var i = 0; i < rows.length; i++) {
      kv.appendChild(U.el('div', { class: 'kv' }, [
        U.el('dt', { text: rows[i][0] }),
        U.el('dd', { text: rows[i][1] })
      ]));
    }
  }

  function setRelayHint(text, cls) {
    var hint = dom.relayStatus;
    hint.textContent = text || '';
    hint.className = 'hint-line' + (cls ? ' ' + cls : '');
  }

  function setTopicHint(text, cls) {
    var hint = dom.topicStatus;
    if (!hint) { return; }
    hint.textContent = text || '';
    hint.className = 'hint-line' + (cls ? ' ' + cls : '');
  }

  /* 公共频道 topic 就是「频道名」，改它等于换一个数据来源。
   * 写完必须重新加载，否则界面上还是旧频道的数据。 */
  function applyTopic(topic, source) {
    SHZU.publicTopic = topic;
    SHZU.publicTopicSource = source || 'storage';
    if (SHZU.publicFeed) { SHZU.publicFeed.topic = topic; }
    state.snapshot = null;
    state.rawSnapshot = null;
    state.source = 'none';
    state.lastError = null;
    renderSettingsStatus();
    loadSnapshot({ silent: false }).then(function () {
      renderSettingsStatus();
    });
  }

  function doSaveTopic() {
    var raw = String(dom.inputTopic.value || '').trim().replace(/^\/+|\/+$/g, '');
    if (!raw) {
      setTopicHint('topic 不能为空。想恢复默认点「恢复默认」。', 'is-err');
      return;
    }
    if (!SHZU.validTopic(raw)) {
      setTopicHint('topic 只能用字母、数字、下划线和短横线，长度 1-64。', 'is-err');
      return;
    }
    SHZU.lsSet(SHZU.storeKey.topic, raw);
    dom.inputTopic.value = raw;
    setTopicHint('已保存频道：' + raw + '，正在重新加载…', 'is-ok');
    applyTopic(raw, 'storage');
    toast('频道已保存');
  }

  function doTestTopic() {
    var raw = String(dom.inputTopic.value || '').trim().replace(/^\/+|\/+$/g, '');
    if (!raw || !SHZU.validTopic(raw)) {
      setTopicHint('topic 格式不对，检查一下再测。', 'is-err');
      return;
    }
    if (!SHZU.publicFeed) {
      setTopicHint('公共频道模块没加载（publicfeed.js 缺失）。', 'is-err');
      return;
    }
    setTopicHint('正在读频道 ' + raw + ' …', 'is-busy');
    SHZU.publicFeed.fetchSnapshot(raw, { timeout: 12000, attachmentTimeout: 20000 }).then(function (snap) {
      var t = snap.totals;
      setTopicHint('✅ 频道可用：' + snap.campuses.length + ' 个校区、' + t.total +
        ' 个端口（空闲 ' + t.free + '），采集于 ' + U.fmtAgo(snap.data_at) +
        '。注意：点「保存」才会切过去。', 'is-ok');
      toast('频道连通');
    }).catch(function (err) {
      var tip = '';
      if (err && err.kind === 'empty') {
        tip = ' —— 频道存在但还没有数据，检查平板的 publish.py 是否在跑、topic 是否一致。';
      } else if (err && err.kind === 'network') {
        tip = ' —— 连不上 ntfy.sh，检查网络。';
      }
      setTopicHint('❌ 读取失败：' + ((err && err.message) || '未知错误') + tip, 'is-err');
      toast('频道读取失败');
    });
  }

  function doResetTopic() {
    SHZU.lsDel(SHZU.storeKey.topic);
    var def = SHZU.defaultTopic || (SHZU.publicFeed && SHZU.publicFeed.topic) || SHZU.publicTopic;
    dom.inputTopic.value = def;
    setTopicHint('已恢复内置默认频道。', 'is-ok');
    applyTopic(def, 'default');
    toast('已恢复默认频道');
  }

  function doSaveRelay() {
    var raw = String(dom.inputRelay.value || '').trim();
    if (raw && !/^https?:\/\//i.test(raw)) { raw = 'http://' + raw; }
    raw = SHZU.trimSlash(raw);
    if (raw) {
      SHZU.lsSet(SHZU.storeKey.relay, raw);
      SHZU.relay = raw;
      SHZU.relaySource = 'storage';
    } else {
      SHZU.lsDel(SHZU.storeKey.relay);
      SHZU.relay = '';
      SHZU.relaySource = 'same-origin';
    }
    setRelayHint('已保存：' + (SHZU.relay || '同源（相对路径）') + '，正在重新加载数据…', 'is-ok');
    state.snapshot = null;
    state.rawSnapshot = null;
    state.source = 'none';
    state.lastError = null;
    renderSettingsStatus();
    loadSnapshot({ silent: false }).then(function () {
      setRelayHint('已连接，数据已更新。', 'is-ok');
      renderSettingsStatus();
    });
    toast('数据源已保存');
  }

  function doTestRelay() {
    var raw = String(dom.inputRelay.value || '').trim();
    if (raw && !/^https?:\/\//i.test(raw)) { raw = 'http://' + raw; }
    raw = SHZU.trimSlash(raw);
    var base = raw || '';
    var label = base || '同源';
    setRelayHint('正在测试 ' + label + ' /api/health …', 'is-busy');
    api.health(base).then(function (res) {
      var d = res.data;
      var extra = '';
      if (d && typeof d === 'object') {
        var bits = [];
        if (d.ok !== undefined) { bits.push('ok=' + d.ok); }
        if (d.version) { bits.push('版本 ' + d.version); }
        if (d.uptime_s !== undefined) { bits.push('运行 ' + Math.round(d.uptime_s) + 's'); }
        if (d.last_ingest_at || d.last_collect_at) { bits.push('上次采集 ' + U.fmtAgo(d.last_ingest_at || d.last_collect_at)); }
        if (d.consecutive_failures !== undefined) { bits.push('连续失败 ' + d.consecutive_failures); }
        extra = bits.length ? '（' + bits.join('，') + '）' : '';
      }
      setRelayHint('✅ 连通 ' + label + '，HTTP ' + res.status + extra + '。注意：测试不会自动保存，点「保存」才会生效。', 'is-ok');
      toast('连通成功');
    }).catch(function (err) {
      var tip = '';
      if (err && err.kind === 'network') {
        tip = ' —— 常见原因：relay 没启动 / IP 不对 / 手机和平板不在同一 WiFi / 被防火墙拦截。';
        if (global.location.protocol === 'https:' && base.indexOf('http://') === 0) {
          tip += ' 另外 HTTPS 页面不能直连 http 地址（混合内容会被浏览器拦截），请改用同源或 https 地址。';
        }
      }
      setRelayHint('❌ 连接失败：' + (err.message || '未知错误') + tip, 'is-err');
      toast('连接失败');
    });
  }

  function doResetRelay() {
    SHZU.lsDel(SHZU.storeKey.relay);
    SHZU.relay = '';
    SHZU.relaySource = 'same-origin';
    dom.inputRelay.value = '';
    setRelayHint('已恢复为同源相对路径。', 'is-ok');
    renderSettingsStatus();
    toast('已恢复默认');
  }

  function doClearCache() {
    api.clearCaches();
    SHZU.lsDel(BUFFER_KEY);
    state.buffer = [];
    dom.maintHint.textContent = '本地缓存已清除。页面即将重新加载…';
    setTimeout(function () { global.location.reload(); }, 600);
  }

  function doUpdateSW() {
    if (!global.navigator.serviceWorker) {
      dom.maintHint.textContent = '当前浏览器不支持 Service Worker（离线缓存不可用，但页面功能正常）。';
      return;
    }
    dom.maintHint.textContent = '正在检查 Service Worker 更新…';
    global.navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg) {
        dom.maintHint.textContent = '尚未注册 Service Worker（首次访问后会自动注册）。';
        return;
      }
      return reg.update().then(function () {
        dom.maintHint.textContent = '检查完成。若有新版本，刷新页面即可生效。';
        toast('已检查更新');
      });
    }).catch(function (e) {
      dom.maintHint.textContent = '检查更新失败：' + (e && e.message ? e.message : e);
    });
  }

  /* =========================================================
   * 下拉刷新
   * ========================================================= */
  var ptrState = { startY: 0, pulling: false, dist: 0, threshold: 68 };

  function setupPullToRefresh() {
    var ptr = dom.ptr;
    if (!ptr) { return; }
    var scroller = document.scrollingElement || document.documentElement;

    document.addEventListener('touchstart', function (ev) {
      if (ev.touches.length !== 1) { return; }
      if (dom.sheetMask && !dom.sheetMask.hidden) { return; }
      if (scroller.scrollTop > 2) { ptrState.pulling = false; return; }
      ptrState.startY = ev.touches[0].clientY;
      ptrState.pulling = true;
      ptrState.dist = 0;
    }, { passive: true });

    document.addEventListener('touchmove', function (ev) {
      if (!ptrState.pulling || ev.touches.length !== 1) { return; }
      if (scroller.scrollTop > 2) { ptrState.pulling = false; ptr.classList.remove('is-pulling', 'is-ready'); return; }
      var dy = ev.touches[0].clientY - ptrState.startY;
      if (dy <= 0) {
        ptrState.dist = 0;
        ptr.classList.remove('is-pulling', 'is-ready');
        return;
      }
      // 阻尼
      var dist = Math.min(110, dy * 0.55);
      ptrState.dist = dist;
      if (dist > 8) {
        ptr.classList.add('is-pulling');
        if (dist >= ptrState.threshold) { ptr.classList.add('is-ready'); }
        else { ptr.classList.remove('is-ready'); }
        var textEl = ptr.querySelector('.ptr-text');
        if (textEl) { textEl.textContent = dist >= ptrState.threshold ? '松开刷新' : '下拉刷新'; }
        if (dy > 10 && ev.cancelable) { ev.preventDefault(); }
      }
    }, { passive: false });

    document.addEventListener('touchend', function () {
      if (!ptrState.pulling) { return; }
      ptrState.pulling = false;
      if (ptrState.dist >= ptrState.threshold) {
        ptr.classList.add('is-refreshing');
        ptr.classList.remove('is-ready');
        var textEl = ptr.querySelector('.ptr-text');
        if (textEl) { textEl.textContent = '正在刷新…'; }
        var done = function () {
          ptr.classList.remove('is-pulling', 'is-refreshing', 'is-ready');
          if (textEl) { textEl.textContent = '下拉刷新'; }
        };
        var p = loadSnapshot({});
        if (state.view === 'history') {
          p = Promise.all([p, loadHistory({})]);
        }
        p.then(done, done);
        setTimeout(done, 12000);
      } else {
        ptr.classList.remove('is-pulling', 'is-ready');
      }
      ptrState.dist = 0;
    }, { passive: true });

    document.addEventListener('touchcancel', function () {
      ptrState.pulling = false;
      ptrState.dist = 0;
      ptr.classList.remove('is-pulling', 'is-ready');
    }, { passive: true });
  }

  /* =========================================================
   * Service Worker
   * ========================================================= */
  function setupServiceWorker() {
    if (!('serviceWorker' in global.navigator)) { return; }
    if (global.location.protocol !== 'http:' && global.location.protocol !== 'https:') { return; }
    try {
      global.navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (reg) {
        reg.addEventListener && reg.addEventListener('updatefound', function () {});
      }).catch(function () {});
    } catch (e) {}
  }

  /* =========================================================
   * 初始化
   * ========================================================= */
  function cacheDom() {
    dom = {
      topbar: q('topbar'),
      brandSub: q('brandSub'),
      btnRefresh: q('btnRefresh'),
      btnSettings: q('btnSettings'),
      btnBannerRetry: q('btnBannerRetry'),
      btnEmptyRetry: q('btnEmptyRetry'),
      btnErrorRetry: q('btnErrorRetry'),
      staleBanner: q('staleBanner'),
      netBanner: q('netBanner'),
      demoBanner: q('demoBanner'),
      sourceBanner: q('sourceBanner'),
      sourceText: q('sourceText'),
      sourceSub: q('sourceSub'),
      main: q('main'),
      hero: q('hero'),
      heroFree: q('heroFree'),
      heroTotal: q('heroTotal'),
      heroTime: q('heroTime'),
      heroRatio: q('heroRatio'),
      heroDonut: q('heroDonut'),
      heroLegend: q('heroLegend'),
      btnOpenPorts: q('btnOpenPorts'),
      ctaPortsSub: q('ctaPortsSub'),
      freeSectionHead: q('freeSectionHead'),
      freePorts: q('freePorts'),
      freePortsHint: q('freePortsHint'),
      freePortsMore: q('freePortsMore'),
      portStatusGroup: q('portStatusGroup'),
      portCampusChips: q('portCampusChips'),
      portSourceChips: q('portSourceChips'),
      portsLegend: q('portsLegend'),
      portList: q('portList'),
      portsSummary: q('portsSummary'),
      portsEmpty: q('portsEmpty'),
      portsEmptyDesc: q('portsEmptyDesc'),
      campusGrid: q('campusGrid'),
      campusCountHint: q('campusCountHint'),
      homeFootnote: q('homeFootnote'),
      sourcesBox: q('sourcesBox'),
      sourcesList: q('sourcesList'),
      sourcesHint: q('sourcesHint'),
      sourceDetailHead: q('sourceDetailHead'),
      sourceCampusList: q('sourceCampusList'),
      emptyState: q('emptyState'),
      emptyDesc: q('emptyDesc'),
      errorState: q('errorState'),
      errorDesc: q('errorDesc'),
      campusDetailHead: q('campusDetailHead'),
      stationList: q('stationList'),
      rangeGroup: q('rangeGroup'),
      campusChips: q('campusChips'),
      chartBox: q('chartBox'),
      chartCurVal: q('chartCurVal'),
      chartCurLabel: q('chartCurLabel'),
      chartStats: q('chartStats'),
      chartFoot: q('chartFoot'),
      historyHint: q('historyHint'),
      fleetTotals: q('fleetTotals'),
      inputRelay: q('inputRelay'),
      relayStatus: q('relayStatus'),
      inputTopic: q('inputTopic'),
      topicStatus: q('topicStatus'),
      refreshGroup: q('refreshGroup'),
      refreshHint: q('refreshHint'),
      settingsKv: q('settingsKv'),
      maintHint: q('maintHint'),
      appVersionEl: q('appVersion'),
      sheetMask: q('sheetMask'),
      sheetTitle: q('sheetTitle'),
      sheetBody: q('sheetBody'),
      // 首次使用手册
      guideMask: q('guideMask'),
      guideStep: q('guideStep'),
      btnGuideNext: q('btnGuideNext'),
      btnGuideWait: q('btnGuideWait'),
      btnShowGuide: q('btnShowGuide'),
      // 通用确认弹窗（反馈提交确认）
      confirmMask: q('confirmMask'),
      confirmTitle: q('confirmTitle'),
      confirmText: q('confirmText'),
      btnConfirmOk: q('btnConfirmOk'),
      btnConfirmCancel: q('btnConfirmCancel'),
      // 风控惩罚（限流弹窗 + 顶部倒计时横幅）
      rateLimitMask: q('rateLimitMask'),
      rateLimitText: q('rateLimitText'),
      rateLimitSub: q('rateLimitSub'),
      btnRateLimitOk: q('btnRateLimitOk'),
      rateLimitBanner: q('rateLimitBanner'),
      toast: q('toast'),
      ptr: q('ptr')
    };
  }

  function bindEvents() {
    dom.btnRefresh.addEventListener('click', function () {
      var p = loadSnapshot({});
      if (state.view === 'history') { p = Promise.all([p, loadHistory({})]); }
      p.then(function () {
        if (!state.lastError) { toast('已刷新'); }
      });
    });
    dom.btnSettings.addEventListener('click', function () { navigate('settings'); });

    var retry = function () { loadSnapshot({}); };
    if (dom.btnBannerRetry) { dom.btnBannerRetry.addEventListener('click', retry); }
    if (dom.btnEmptyRetry) { dom.btnEmptyRetry.addEventListener('click', retry); }
    if (dom.btnErrorRetry) { dom.btnErrorRetry.addEventListener('click', retry); }

    // 端口表入口：用户要求「一眼看出点哪里能到表」
    if (dom.btnOpenPorts) { dom.btnOpenPorts.addEventListener('click', function () { navigate('ports'); }); }
    if (dom.freePortsMore) { dom.freePortsMore.addEventListener('click', function () { navigate('ports'); }); }
    var backPorts = q('btnBackPorts');
    if (backPorts) { backPorts.addEventListener('click', function () { navigate('home'); }); }
    var backSource = q('btnBackSource');
    if (backSource) { backSource.addEventListener('click', function () { navigate('home'); }); }
    var resetFilter = q('btnPortsResetFilter');
    if (resetFilter) {
      resetFilter.addEventListener('click', function () {
        state.ports.status = 'all';
        state.ports.campus = 'all';
        state.ports.source = 'all';
        renderPorts(false);
      });
    }

    U.$$('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var v = tab.getAttribute('data-tab');
        if (state.view === v) {
          if (v !== 'home') { navigate('home'); }
          return;
        }
        navigate(v);
      });
    });

    q('btnBackCampus').addEventListener('click', function () { navigate('home'); });

    q('btnSaveRelay').addEventListener('click', doSaveRelay);
    q('btnTestRelay').addEventListener('click', doTestRelay);
    q('btnResetRelay').addEventListener('click', doResetRelay);

    var saveTopic = q('btnSaveTopic');
    if (saveTopic) { saveTopic.addEventListener('click', doSaveTopic); }
    var testTopic = q('btnTestTopic');
    if (testTopic) { testTopic.addEventListener('click', doTestTopic); }
    var resetTopic = q('btnResetTopic');
    if (resetTopic) { resetTopic.addEventListener('click', doResetTopic); }

    q('btnClearCache').addEventListener('click', doClearCache);
    q('btnUpdateSW').addEventListener('click', doUpdateSW);
    // 设置页「重新查看使用手册」：点开就是完整两页流程（含 10 秒等待），
    // 和首次安装完全一致，方便用户复查或给同学演示。
    if (dom.btnShowGuide) {
      dom.btnShowGuide.addEventListener('click', function () {
        showGuide();
        toast('使用手册');
      });
    }

    q('btnSheetClose').addEventListener('click', closeSheet);
    dom.sheetMask.addEventListener('click', function (ev) {
      if (ev.target === dom.sheetMask) { closeSheet(); }
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && dom.sheetMask && !dom.sheetMask.hidden) { closeSheet(); }
    });

    /* ---- 首次使用手册 ----
     * 注意：遮罩**不绑**点击关闭，这是需求「不可点击其他位置」的实现方式。
     * Esc 也不关 —— 只有「下一步 / 我已知晓」能关。 */
    if (dom.btnGuideNext) { dom.btnGuideNext.addEventListener('click', guideNext); }
    if (dom.btnGuideWait) {
      dom.btnGuideWait.addEventListener('click', function () {
        // disabled 的按钮本来不会触发 click，这里是双保险
        if (state.guide.okEnabled) { hideGuide(); }
      });
    }
    // 手册开着的时候，把底下的 tabbar / 刷新按钮的点击全部吃掉。
    // 光靠遮罩挡住视觉是不够的：tabbar 是 position:fixed，z-index 40，
    // 遮罩 z-index 200 已经压在它上面，点击落在遮罩上不会穿透。
    // 但键盘 Tab 仍可能聚焦到底层元素，所以额外锁一下 aria-hidden。
    if (dom.guideMask) {
      dom.guideMask.addEventListener('click', function (ev) {
        // 点遮罩空白处什么都不做（明确地什么都不做，不是漏写）
        if (ev.target === dom.guideMask) { ev.stopPropagation(); }
      });
    }

    /* ---- 反馈提交确认弹窗 ---- */
    if (dom.btnConfirmOk) {
      dom.btnConfirmOk.addEventListener('click', function () { closeConfirm(true); });
    }
    if (dom.btnConfirmCancel) {
      dom.btnConfirmCancel.addEventListener('click', function () { closeConfirm(false); });
    }
    if (dom.confirmMask) {
      dom.confirmMask.addEventListener('click', function (ev) {
        if (ev.target === dom.confirmMask) { closeConfirm(false); }
      });
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') { return; }
      if (dom.rateLimitMask && !dom.rateLimitMask.hidden) { closeRateLimitDialog(); return; }
      if (dom.confirmMask && !dom.confirmMask.hidden) { closeConfirm(false); return; }
      if (dom.guideMask && !dom.guideMask.hidden) { return; }  // 手册不响应 Esc
    });

    /* ---- 风控惩罚弹窗 ---- */
    if (dom.btnRateLimitOk) {
      dom.btnRateLimitOk.addEventListener('click', function () { closeRateLimitDialog(); });
    }
    /* 遮罩**不**绑点击关闭：用户要求关掉弹窗后刷新仍锁着，如果随手点一下
     * 空白就消失，用户会以为已经恢复；必须明确点「我知道了」。 */

    global.addEventListener('popstate', function (ev) {
      var st = ev.state;
      if (st && st.view) {
        navigate(st.view, st.campusId, { noHistory: true });
      } else {
        var parsed = parseHash();
        navigate(parsed.view, parsed.campusId, { noHistory: true });
      }
    });

    // 手动改 hash / APK 壳深链进来（#history、#campus/xxx、#source/xxx）时也要切页。
    // 自己 pushState 不会触发 hashchange，所以这里不会有循环。
    global.addEventListener('hashchange', function () {
      var parsed = parseHash();
      // 源详情和校区详情都把上下文 id 存在 hash 的第二段，比较时要按视图取
      // 对应的那个 state 字段，否则 #source/shzu 会被判成「和当前一样」而不切页。
      var curCtx = (state.view === 'source') ? state.sourceId : state.campusId;
      if (parsed.view === state.view && (parsed.campusId || null) === (curCtx || null)) { return; }
      navigate(parsed.view, parsed.campusId, { noHistory: true });
    });

    global.addEventListener('resize', U.debounce(function () {
      if (state.view === 'history') { renderHistoryChart(false); }
    }, 180));

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { return; }
      /* 回到前台：如果惩罚期还没过，不要发请求（loadSnapshot 入口自己会拦，
       * 但这里先跑倒计时/横幅，让用户一回来就看到还剩多久）。 */
      if (isRateLimited()) {
        renderRateLimitBanner();
        updateRefreshButtonLock();
        if (!state.rateLimit.timer) { startRateLimitTicker(); }
        return;
      }
      var t = U.parseTime(state.snapshot && state.snapshot.data_at);
      var age = t === null ? Infinity : Date.now() - t;
      if (age > Math.max(30000, (state.settings.refreshSeconds || 60) * 1000 * 0.9)) {
        if (state.view !== 'settings') { loadSnapshot({ silent: true }); }
      }
    });

    var main = dom.main;
    if (main) {
      main.addEventListener('scroll', onScroll, { passive: true });
    }
    global.addEventListener('scroll', onScroll, { passive: true });
  }

  function onScroll() {
    var top = (document.scrollingElement || document.documentElement).scrollTop;
    if (dom.topbar) { dom.topbar.classList.toggle('is-scrolled', top > 6); }
  }

  function boot() {
    cacheDom();
    state.buffer = loadBuffer();
    state.history.hours = state.settings.historyHours || 24;
    state.history.campus = state.settings.historyCampus || 'all';
    var r = findRange(state.history.hours);
    state.history.bucket = r ? r.bucket : '10m';

    // 反馈计数先从本地缓存恢复：冷启动第一屏就要把「已被 20 人标记不可用」的
    // 端口显示成离线，等网络回来再校正。
    loadFeedbackCache();
    state.feedback.threshold = SHZU.feedbackThreshold || 20;

    // 先渲染缓存（秒开），再拉网络
    var cached = api.cachedSnapshot();
    if (cached) {
      state.rawSnapshot = cached;
      state.snapshot = snapWithFeedback() || cached;
      state.source = 'cache';
    }

    bindEvents();
    setupPullToRefresh();
    updateCampusHint();
    renderBanners();

    /* 冷启动时先看有没有存盘的风控惩罚期。
     * 场景：用户点太快被罚 → 直接杀进程重新打开 App。
     * 不恢复的话，新的 instance 立刻又发一轮请求，正好把罚期续上，
     * 用户会觉得「重开 App 也没用，一直限制我」。
     * 恢复后：起倒计时、锁刷新、显示横幅，但**不弹窗** ——
     * 用户刚被弹过一次，重开再弹一次是骚扰。 */
    var savedUntil = SHZU.rateLimitUntil();
    if (savedUntil) {
      state.rateLimit.until = savedUntil;
      startRateLimitTicker();
      renderRateLimitBanner();
      updateRefreshButtonLock();
      state.rateLimit.shownFor = savedUntil;  // 标记「这个罚期已经告知过了」
    }

    var initial = parseHash();
    navigate(initial.view, initial.campusId, { noHistory: true });
    if (cached) { renderCurrent(); }

    // 首次使用手册：放在渲染之后弹，避免用户先看到一张空白页再看到手册。
    // 用 setTimeout(0) 让首帧先画出来（老 WebView 里同步弹层会白屏一下）。
    if (shouldShowGuide()) {
      setTimeout(function () { showGuide(); }, 0);
    }

    scheduleAutoRefresh();
    loadSnapshot({ silent: true }).then(function () {
      if (state.view === 'history') { loadHistory({}); }
    });
    setupServiceWorker();
    // 每分钟更新一次「x 分钟前」文案
    setInterval(function () {
      if (state.view === 'home' && state.snapshot) {
        dom.heroTime.textContent = state.snapshot.data_at
          ? ('采集 ' + U.fmtClock(state.snapshot.data_at) + ' · ' + U.fmtAgo(state.snapshot.data_at))
          : '无采集时间';
        renderBanners();
      }
    }, 60000);
  }

  function updateCampusHint() {
    if (!dom.campusCountHint) { return; }
    var snap = state.snapshot;
    if (!snap) { dom.campusCountHint.textContent = ''; return; }
    var stations = 0;
    for (var i = 0; i < snap.campuses.length; i++) { stations += snap.campuses[i].stations.length; }
    dom.campusCountHint.textContent = stations + ' 个站点 · ' + snap.totals.total + ' 个桩';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 暴露给测试/调试
  global.SHZU.app = {
    state: state,
    navigate: navigate,
    loadSnapshot: loadSnapshot,
    loadHistory: loadHistory,
    renderCurrent: renderCurrent,
    // 测试用句柄：直接触发渲染，避免只能靠模拟点击
    renderSources: renderSources,
    renderSourceDetail: renderSourceDetail,
    renderPorts: renderPorts,
    toast: toast
  };
})(window);
