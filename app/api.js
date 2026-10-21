/* api.js — 数据层：XHR 请求 + 超时 + localStorage 缓存 + snapshot 规范化
 * 不用 fetch：老 WebView 上 XHR 更稳（fetch 需要 Chrome 42+，但部分定制 WebView 的 fetch 有坑）。
 * 所有请求都带超时，失败抛 SHZU.api.ApiError（kind: network|timeout|http|parse）。
 */
(function (global) {
  'use strict';

  var SHZU = global.SHZU;
  var U = SHZU.util;

  function ApiError(kind, message, extra) {
    this.name = 'ApiError';
    this.kind = kind;
    this.message = message || kind;
    this.status = (extra && extra.status) || 0;
    this.url = (extra && extra.url) || '';
    if (Error.captureStackTrace) { Error.captureStackTrace(this, ApiError); }
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  /* 读自定义响应头。跨域时浏览器只放行「简单响应头」和被 Access-Control-Expose-Headers
   * 显式放行的头；读不到就返回 null，由调用方按「没有标记」处理。
   * 请求根本没发出去时（DNS/断网）getResponseHeader 会抛，老 WebView 上抛的异常
   * 信息还很长，统一吞掉。
   */
  function readHeader(xhr, name) {
    try {
      return xhr.getResponseHeader(name);
    } catch (e) {
      return null;
    }
  }

  /* 这个 URL 是不是打到「我们自己的源」（同源页面 + http(s)）。
   *
   * 这是「能不能安全加自定义请求头」的唯一判据，不能用「有没有配置云地址」代替：
   *   - 同源请求**不经过 CORS**，加 X-Client-Id 不会有任何预检，零成本；
   *   - relay 是另一个源（http://192.168.1.119:8080），它的
   *     Access-Control-Allow-Headers 只白名单了 Content-Type / X-Collector-Token /
   *     Accept 三个，多一个头就会预检失败 → 整条 relay 路径变成「网络不可达」。
   *     （2026-10-21 实测踩过这个坑，见 request() 里的注释。）
   *   - file: 源（APK 内置 UI）下同源请求本来就发不出去，直接返回 false。 */
  function isOwnOrigin(url) {
    try {
      var loc = global.location || {};
      var proto = String(loc.protocol || '');
      if (proto !== 'http:' && proto !== 'https:') { return false; }
      var abs = new URL(url, loc.href);
      return abs.origin === loc.origin;
    } catch (e) { return false; }
  }

  function request(path, opts) {
    var o = opts || {};
    var timeout = o.timeout || SHZU.defaults.requestTimeoutMs;
    var url = SHZU.apiUrl(path);

    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var done = false;
      function finish(fn, arg) {
        if (done) { return; }
        done = true;
        fn(arg);
      }
      try {
        xhr.open('GET', url, true);
        xhr.timeout = timeout;
        // 只发 CORS 简单请求头（Accept 在 safelist 里，不会触发预检）。
        // 千万不要在这里加 Cache-Control / X-Requested-With 之类的自定义头：
        // 它们会让浏览器先发 OPTIONS 预检，而 relay 的 Access-Control-Allow-Headers
        // 只列出 Content-Type / X-Collector-Token / Accept，预检会被拒 → 表现为「网络不可达」。
        // 破缓存靠 URL 上的 ?ts=<时间戳>（见 api.snapshot / api.history），不需要请求头。
        xhr.setRequestHeader('Accept', 'application/json');
        /* 同源时补上限流标识 X-Client-Id。
         *
         * 这是 2026-10-21 的真 bug：App 从自己的域名打开时，快照走的是**同源**
         * 的 /api/snapshot（relay 那条路），而不是 cloudGet。之前只有 cloudGet
         * 加了 X-Client-Id，于是真实的 App 请求全部退化成「按 IP 计数」的宽松
         * 通道 —— 手动点 13 次刷新一次都没触发风控，而服务端其实工作正常
         * （PC 端带固定 X-Client-Id 第 11 次就 429）。
         *
         * 只在同源加：relay 是另一个源，它的 CORS 没白名单这个头，加了会让
         * 预检失败、整条局域网路径变成「网络不可达」。 */
        if (isOwnOrigin(url)) {
          addClientIdHeader(xhr);
        }
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            var txt = xhr.responseText || '';
            var data;
            try {
              data = txt ? JSON.parse(txt) : null;
            } catch (e) {
              finish(reject, new ApiError('parse', '响应不是合法 JSON', { url: url, status: xhr.status }));
              return;
            }
            // Service Worker 从 API 缓存兜底时会打 X-Shzu-Source: sw-cache，
            // 这里把标记透传出去，UI 就能如实显示「离线缓存数据」而不是假装实时。
            //
            // 注意：跨域时这两个头必须由 relay 的 CORS 显式 expose 出来，
            // 否则浏览器会屏蔽，getResponseHeader 读到的全是 null，页面就会把
            // 缓存数据当成实时数据说（实测踩过：relay 未 expose → 静默说谎）。
            var meta = { fromSwCache: false, swAgeSeconds: 0 };
            try {
              var src = readHeader(xhr, 'X-Shzu-Source');
              if (src === 'sw-cache') {
                meta.fromSwCache = true;
                meta.swAgeSeconds = Number(readHeader(xhr, 'X-Shzu-Cache-Age') || 0) || 0;
              }
            } catch (e2) { /* 旧浏览器读不到头，忽略 */ }
            finish(resolve, { data: data, status: xhr.status, url: url, fromSwCache: meta.fromSwCache, swAgeSeconds: meta.swAgeSeconds });
          } else if (xhr.status === 429) {
            /* 同源时 /api/snapshot 的 429 就是 Worker 的风控，必须和 cloudGet
             * 走同一个解析，否则 App 收到的只是一个普通 HTTP 错误 → 不弹窗、
             * 不锁刷新、停发逻辑全部失效（这正是「点 13 次刷新没反应」的第二半）。
             * 跨域 relay 不会回 429，所以这里不需要判断来源。 */
            finish(reject, parseRateLimit(xhr, url));
          } else {
            finish(reject, new ApiError('http', 'HTTP ' + xhr.status, { url: url, status: xhr.status }));
          }
        };
        xhr.onerror = function () {
          finish(reject, new ApiError('network', '网络不可达', { url: url }));
        };
        xhr.ontimeout = function () {
          finish(reject, new ApiError('timeout', '请求超时', { url: url }));
        };
        xhr.onabort = function () {
          finish(reject, new ApiError('network', '请求被取消', { url: url }));
        };
        xhr.send(null);
      } catch (e) {
        finish(reject, new ApiError('network', String(e && e.message || e), { url: url }));
      }
    });
  }

  /* ---------------- localStorage 缓存 ---------------- */
  var CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 缓存超过 7 天视为不可用

  function cachePut(key, payload) {
    // 快照落盘的同时顺手记一个历史采样点（见 recordSample 的注释）
    if (key === SHZU.storeKey.snapshot) { recordSample(payload); }
    try {
      global.localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), payload: payload }));
      return true;
    } catch (e) {
      // 配额满：先清理历史缓存再试一次
      try {
        global.localStorage.removeItem(SHZU.storeKey.history);
        global.localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), payload: payload }));
        return true;
      } catch (e2) { return false; }
    }
  }

  /* ---------------- 本机历史采样（历史页的第三级兜底） ----------------
   *
   * 网页版（https://shzucharge.xyz/）没有 relay，/api/history 是 relay 才有的接口，
   * 以前历史页因此在公网域名上永远空白、连「当前空闲率」都是「—」。现在有三级：
   *   1) relay /api/history            —— 最细（1 分钟桶），只在本机连得上 relay 时
   *   2) 自己的域名 /history           —— Worker 的 KV 环形缓冲，10 分钟粒度，零额外写
   *   3) 本机采样（这里攒的）          —— 完全离线也能看到「我自己看到过的」那几天
   *
   * 采样点格式为省空间用数组：[ts, free, total, {campusId: [free, total]}]。
   * 5 分钟一个槽（同一槽里后来的覆盖先前的），保留 7 天 = 2016 点。
   * 为什么不是 1 分钟：localStorage 只有几 MB，1 分钟 × 7 天 = 10080 点太占地方，
   * 而这一层本来就是兜底，粗一点无所谓。
   */
  var SAMPLE_SLOT_MS = 5 * 60 * 1000;
  var SAMPLE_MAX_POINTS = 2016;

  function readSamples() {
    try {
      var raw = SHZU.lsGet(SHZU.storeKey.samples);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function recordSample(snap) {
    try {
      if (!snap || !snap.totals || !(snap.totals.total > 0)) { return; }
      var at = snap.data_at || snap.generated_at || new Date().toISOString();
      var ms = Date.parse(at);
      if (!isFinite(ms)) { ms = Date.now(); }
      var slot = Math.floor(ms / SAMPLE_SLOT_MS) * SAMPLE_SLOT_MS;
      var camps = {};
      var list = U.normalizeCampuses(snap.campuses) || [];
      for (var i = 0; i < list.length; i++) {
        var tt = list[i].totals || {};
        camps[list[i].id] = [tt.free || 0, tt.total || 0];
      }
      var arr = readSamples();
      var point = [Math.floor(slot / 1000), snap.totals.free || 0, snap.totals.total || 0, camps];
      var last = arr[arr.length - 1];
      if (last && last[0] === point[0]) { arr[arr.length - 1] = point; }
      else { arr.push(point); }
      if (arr.length > SAMPLE_MAX_POINTS) { arr.splice(0, arr.length - SAMPLE_MAX_POINTS); }
      global.localStorage.setItem(SHZU.storeKey.samples, JSON.stringify(arr));
    } catch (e) { /* 配额满 / 隐私模式：攒不了就不攒，绝不影响主流程 */ }
  }

  var BUCKET_SECONDS = { '1m': 60, '5m': 300, '10m': 600, '30m': 1800, '1h': 3600 };

  /* 用本机采样拼一条曲线，形状与 relay 的 /api/history 完全一致。 */
  function localHistory(campus, hours, bucket) {
    var bucketSec = BUCKET_SECONDS[bucket] || 600;
    var campusId = (!campus || campus === 'all') ? null : campus;
    var since = Math.floor((Date.now() - (hours || 24) * 3600 * 1000) / 1000);
    var arr = readSamples();
    var acc = {};
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      if (!Array.isArray(p) || p.length < 3) { continue; }
      var ts = Number(p[0]) | 0;
      if (!ts || ts < since) { continue; }
      var free = Number(p[1]) || 0;
      var total = Number(p[2]) || 0;
      if (campusId) {
        var hit = p[3] && p[3][campusId];
        if (!hit) { continue; }
        free = Number(hit[0]) || 0;
        total = Number(hit[1]) || 0;
      }
      var b = Math.floor(ts / bucketSec) * bucketSec;
      var cur = acc[b] || { n: 0, free: 0, total: 0 };
      cur.n += 1; cur.free += free; cur.total += total;
      acc[b] = cur;
    }
    var keys = [];
    for (var k in acc) { if (Object.prototype.hasOwnProperty.call(acc, k)) { keys.push(Number(k)); } }
    keys.sort(function (a, b) { return a - b; });
    var points = [];
    for (var j = 0; j < keys.length; j++) {
      var v = acc[keys[j]];
      var f = Math.round(v.free / v.n);
      var t = Math.round(v.total / v.n);
      points.push({
        t: new Date(keys[j] * 1000).toISOString(),
        free: f,
        total: t,
        free_ratio: t > 0 ? Math.round((f / t) * 10000) / 10000 : 0
      });
    }
    return normalizeHistory({
      schema: 'shzu.history.v1',
      campus: campus || 'all',
      hours: hours || 24,
      bucket_seconds: bucketSec,
      points: points
    }, campus, hours);
  }

  function cacheGet(key) {
    var raw = SHZU.lsGet(key);
    if (!raw) { return null; }
    try {
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') { return null; }
      var age = Date.now() - (obj.savedAt || 0);
      if (age > CACHE_MAX_AGE_MS) { return null; }
      return obj;
    } catch (e) { return null; }
  }

  /* ---------------- 云中转（Cloudflare Worker）通用请求 ---------------- */

  /* 云地址：与 publicfeed.js 的 cloudBase() 同一口径（都读 SHZU.publicCloud）。
   * 反馈接口挂在云中转上而不是 relay 上 —— 反馈是全站共享的数据，
   * 局域网 relay 没有它，也不该有。 */
  function cloudBase() {
    return String((SHZU && SHZU.publicCloud) || '').replace(/\/+$/, '');
  }

  /* 从 429 响应里解析风控信息。**必须分清两种 429**，这是 2026-10-21 的改动：
   *
   *   硬惩罚（penalty_seconds > 0）—— 带 X-Client-Id 的新版 App 一分钟超 20 次。
   *     App 要弹红色风控弹窗 + 锁住刷新 + 停发请求 120 秒，这是用户明确要求的。
   *     kind='ratelimit'，penaltySeconds=120。
   *
   *   软拒绝（penalty_seconds === 0）—— 不带 X-Client-Id 的老客户端按 IP 兜底，
   *     或者同一个 IP 后面太多人（校园 NAT）把 IP 桶打满。**绝不能按惩罚处理**：
   *     那会「一个人手快，整栋楼被弹窗锁两分钟」。软拒只表示「这一分钟先别请求了」，
   *     刷新按钮不禁用，不弹风控弹窗，只走普通提示。
   *     kind='throttled'，throttleSeconds=本次窗口剩余秒数。
   *
   * 判据看 body.penalty_seconds 这个**显式字段**，不要用「有没有 Retry-After」猜：
   * 软拒也带 Retry-After（它确实要等），靠它补默认值就会把软拒误判成 120 秒惩罚。 */
  function parseRateLimit(xhr, url) {
    var retryAfter = 0;
    try {
      var ra = xhr.getResponseHeader('Retry-After');
      if (ra) { retryAfter = parseInt(ra, 10) || 0; }
    } catch (e) { /* 读不到头就用 body 里的数字 */ }
    var body = null;
    try { body = JSON.parse(xhr.responseText || 'null'); } catch (e) { body = null; }
    var hasPenaltyField = !!(body && typeof body === 'object' && isFinite(Number(body.penalty_seconds)));
    var penalty = 0;
    if (hasPenaltyField) {
      var ps = Number(body.penalty_seconds);
      if (ps > 0) { penalty = Math.floor(ps); }
    } else if (retryAfter > 0) {
      /* 老版本 Worker 没有 penalty_seconds 字段时的兼容：有 Retry-After 就当惩罚。
       * 新 Worker 一定会给 penalty_seconds（软拒时给 0），所以这里不会误伤。 */
      penalty = retryAfter;
    } else {
      penalty = 120;  // 兜底：确实是风控但没给数字
    }
    var msg = (body && typeof body.error === 'string' && body.error)
      ? body.error
      : (penalty ? '您已触发风控限制，请两分钟后再试' : '请求太频繁，请稍后再试');

    if (!penalty) {
      // 软拒绝：不弹风控、不锁刷新，只是这一小段时间别请求
      var soft = new ApiError('throttled', msg, {
        url: url, status: 429, retry_after: retryAfter || 60
      });
      soft.throttleSeconds = retryAfter || 60;
      return soft;
    }

    var err = new ApiError('ratelimit', msg, {
      url: url, status: 429, penalty_seconds: penalty, retry_after: retryAfter
    });
    err.penaltySeconds = penalty;
    err.rateLimited = true;
    return err;
  }

  /* 同一个请求函数里 2xx 走正常解析、429 走 parseRateLimit，其余当普通 http 错。
   * 返回 null 表示「不是错误」，否则返回要 reject 的 ApiError。 */
  function cloudFailure(xhr, url) {
    if (xhr.status >= 200 && xhr.status < 300) { return null; }
    if (xhr.status === 429) { return parseRateLimit(xhr, url); }
    return new ApiError('http', 'HTTP ' + xhr.status, { url: url, status: xhr.status });
  }

  /* 给云请求加限流标识头 X-Client-Id。
   * 值是 localStorage 里一个随机串（见 config.js ensureClientId），只用来把
   * 「我」和「别人」分开，不携带任何设备信息。Worker 的 CORS 已经放行这个头，
   * 否则预检会被拒、请求直接失败。 */
  function addClientIdHeader(xhr) {
    try {
      var cid = SHZU.ensureClientId ? SHZU.ensureClientId() : null;
      if (cid) xhr.setRequestHeader('X-Client-Id', cid);
    } catch (e) { /* 拿不到就不发，Worker 会退回按 IP 计数 */ }
  }

  /* 云中转的 GET。
   * 这里**可以**加自定义头：Worker 的 CORS 配置是我们自己写的、允许
   * Content-Type，不像 relay 那样只白名单了三个头。但为了少一次预检，
   * GET 仍然只发 Accept。 */
  function cloudGet(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var done = false;
      function fin(fn, v) { if (!done) { done = true; fn(v); } }
      try {
        xhr.open('GET', url + (url.indexOf('?') >= 0 ? '&' : '?') + 'ts=' + Date.now(), true);
        xhr.timeout = SHZU.defaults.requestTimeoutMs;
        xhr.setRequestHeader('Accept', 'application/json');
        // 限流用的匿名客户端标识：Worker 按它计数（而不是按 IP）——
        // 校园网整栋楼共用一个出口 IP，按 IP 罚会一次罚一片人。
        // 带了它就会多一次 OPTIONS 预检；Worker 的 Access-Control-Max-Age
        // 是 86400，浏览器会把这个预检结果缓存一整天，实际只有首次多一跳。
        addClientIdHeader(xhr);
        xhr.onload = function () {
          var fail = cloudFailure(xhr, url);
          if (fail) { fin(reject, fail); return; }
          var data = null;
          try { data = JSON.parse(xhr.responseText || 'null'); } catch (e) {
            fin(reject, new ApiError('parse', '响应不是合法 JSON', { url: url }));
            return;
          }
          fin(resolve, data);
        };
        xhr.onerror = function () { fin(reject, new ApiError('network', '网络不可达', { url: url })); };
        xhr.ontimeout = function () { fin(reject, new ApiError('timeout', '请求超时', { url: url })); };
        xhr.send(null);
      } catch (e) {
        fin(reject, new ApiError('network', String(e && e.message || e), { url: url }));
      }
    });
  }

  /* 云中转的 POST（application/json）。
   * 带 Content-Type: application/json 会触发 OPTIONS 预检 —— 这是**预期行为**，
   * Worker 里已经处理了预检（Access-Control-Allow-Methods: GET, POST, OPTIONS）。
   * 注意别学 relay 那条路去「去掉自定义头破预检」：这里是写请求，必须带。 */
  function cloudPost(url, body) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var done = false;
      function fin(fn, v) { if (!done) { done = true; fn(v); } }
      try {
        xhr.open('POST', url, true);
        xhr.timeout = SHZU.defaults.requestTimeoutMs;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('Accept', 'application/json');
        addClientIdHeader(xhr);
        xhr.onload = function () {
          var fail = cloudFailure(xhr, url);
          if (fail) { fin(reject, fail); return; }
          var data = null;
          try { data = JSON.parse(xhr.responseText || 'null'); } catch (e) { data = null; }
          fin(resolve, data);
        };
        xhr.onerror = function () { fin(reject, new ApiError('network', '网络不可达', { url: url })); };
        xhr.ontimeout = function () { fin(reject, new ApiError('timeout', '请求超时', { url: url })); };
        xhr.send(JSON.stringify(body || {}));
      } catch (e) {
        fin(reject, new ApiError('network', String(e && e.message || e), { url: url }));
      }
    });
  }

  /* 归一化 GET /feedback 的返回：
   *   {ok:true, threshold:20, counts:{"<device_id>":N}}
   * 只保留数字 > 0 的项，脏数据直接忽略（一个坏 id 不该让整份计数作废）。 */
  function normalizeFeedback(raw) {
    if (!raw || typeof raw !== 'object') { return null; }
    var src = raw.counts || {};
    var counts = {};
    for (var k in src) {
      if (!src.hasOwnProperty(k)) { continue; }
      var n = Number(src[k]);
      if (isFinite(n) && n > 0) { counts[k] = n; }
    }
    var th = Number(raw.threshold);
    return {
      ok: raw.ok !== false,
      threshold: (isFinite(th) && th > 0) ? th : (SHZU.feedbackThreshold || 20),
      counts: counts
    };
  }

  /* ---------------- snapshot 规范化 ---------------- */
  function normalizeTotals(t) {
    var src = t || {};
    return {
      total: U.num(src.total),
      free: U.num(src.free),
      busy: U.num(src.busy),
      offline: U.num(src.offline),
      unknown: U.num(src.unknown),
      free_ratio: (typeof src.free_ratio === 'number' && isFinite(src.free_ratio)) ? src.free_ratio : 0
    };
  }

  function recomputeTotalsFromStations(stations) {
    var t = U.zeroTotals();
    for (var i = 0; i < (stations || []).length; i++) {
      var st = stations[i] || {};
      var tt = st.totals || U.totalsFromDevices(st.devices);
      t.total += U.num(tt.total);
      t.free += U.num(tt.free);
      t.busy += U.num(tt.busy);
      t.offline += U.num(tt.offline);
      t.unknown += U.num(tt.unknown);
    }
    var denom = t.total - t.unknown;
    t.free_ratio = denom > 0 ? t.free / denom : 0;
    return t;
  }

  function normalizeStation(st) {
    var s = st || {};
    var devices = [];
    for (var i = 0; i < (s.devices || []).length; i++) {
      var d = s.devices[i] || {};
      var status = d.status;
      if (status !== 'free' && status !== 'busy' && status !== 'offline') { status = 'unknown'; }
      devices.push({
        id: String(d.id || ('dev-' + i)),
        code: (d.code === undefined ? null : d.code),
        name: (d.name === undefined ? null : d.name),
        status: status,
        power_w: (typeof d.power_w === 'number' && isFinite(d.power_w)) ? d.power_w : null,
        busy_since: d.busy_since || null,
        order_id: d.order_id || null
      });
    }
    var totals = s.totals ? normalizeTotals(s.totals) : U.totalsFromDevices(devices);
    if (!s.totals) {
      // 契约要求 totals 必填；缺失时用设备实数统计（不是伪造，是重算）
      totals = U.totalsFromDevices(devices);
    }
    return {
      id: String(s.id || ''),
      name: s.name || '未命名充电站',
      campus_id: s.campus_id || '',
      /* 这个站点属于哪个数据源（relay 多源分区后新增的可选字段）。
       * 端口表要用它做「数据源」维度的筛选；老 relay / 公共频道的数据没有
       * 这个字段，值为 null，UI 一律当成「不归属任何单源」= 在「全部」里显示。
       * 注意：本函数是白名单式重建对象，字段不写进 return 就会被静默丢掉。 */
      source_id: s.source_id ? String(s.source_id) : null,
      address: s.address || null,
      lat: (typeof s.lat === 'number') ? s.lat : null,
      lng: (typeof s.lng === 'number') ? s.lng : null,
      updated_at: s.updated_at || null,
      totals: totals,
      devices: devices
    };
  }

  function normalizeSnapshot(raw) {
    if (!raw || typeof raw !== 'object') { throw new ApiError('parse', '快照为空'); }
    if (raw.schema && raw.schema !== 'shzu.snapshot.v1') {
      throw new ApiError('parse', '未知 snapshot schema: ' + raw.schema);
    }
    var campuses = [];
    for (var i = 0; i < (raw.campuses || []).length; i++) {
      var c = raw.campuses[i] || {};
      var stations = [];
      for (var j = 0; j < (c.stations || []).length; j++) {
        stations.push(normalizeStation(c.stations[j]));
      }
      var totals = c.totals ? normalizeTotals(c.totals) : recomputeTotalsFromStations(stations);
      campuses.push({
        id: c.id,
        name: c.name || U.campusName(c.id),
        order: (typeof c.order === 'number') ? c.order : 99,
        totals: totals,
        stations: stations
      });
    }
    campuses = U.normalizeCampuses(campuses);

    var totals = raw.totals ? normalizeTotals(raw.totals) : (function () {
      var t = U.zeroTotals();
      for (var k = 0; k < campuses.length; k++) {
        t.total += campuses[k].totals.total;
        t.free += campuses[k].totals.free;
        t.busy += campuses[k].totals.busy;
        t.offline += campuses[k].totals.offline;
        t.unknown += campuses[k].totals.unknown;
      }
      var denom = t.total - t.unknown;
      t.free_ratio = denom > 0 ? t.free / denom : 0;
      return t;
    })();

    return {
      schema: raw.schema || 'shzu.snapshot.v1',
      generated_at: raw.generated_at || null,
      data_at: raw.data_at || null,
      stale: !!raw.stale,
      demo: !!raw.demo,
      source: raw.source || null,
      // 数据源被风控限流时的提示。这个函数是白名单式重建对象，写在这里的
      // 字段才活得下来；漏掉的话 UI 会把「冻结的数据」当成实时的显示。
      sources: raw.sources || null,
      source_warning: raw.source_warning || null,
      // 公共频道内部又分两条路：自己的域名（Cloudflare Worker）和 ntfy 兜底。
      // 同样必须写进白名单，否则设置页永远显示「公共频道（ntfy.sh）」，
      // 明明走的是自己的域名却告诉用户走的是 ntfy —— 这个白名单坑已经踩过三次了。
      public_feed_from: raw.public_feed_from || null,
      public_feed_cloud: raw.public_feed_cloud || null,
      totals: totals,
      campuses: campuses
    };
  }

  function isStaleByTime(snapshot) {
    var t = U.parseTime(snapshot && snapshot.data_at);
    if (t === null) { return true; }
    return (Date.now() - t) > SHZU.defaults.staleMinutes * 60 * 1000;
  }

  /* =========================================================
   * 反馈叠加层：把「其他用户提交不可用次数 >= 阈值」的端口当成不可用
   * =========================================================
   *
   * 为什么必须在 normalizeSnapshot 之后单独做一层，而不是直接在
   * normalizeSnapshot 里改：反馈计数来自另一个接口（/feedback），
   * 快照本身完全不知道它。而且这份计数是「以后再来」的 —— 冷启动时
   * 先拿 localStorage 的旧计数套一层，网络回来再套一遍，快照对象不能
   * 被就地改坏，所以这里返回一个**浅拷贝 + 重建 stations/devices** 的新对象。
   *
   * ⚠️ 最容易翻车的地方：**改了 device.status 就必须重算 totals**。
   *    relay 已经把 totals 算好送过来了，overlay 把某几个 free 改成
   *    offline 之后如果不重算，就会出现「全校空闲 1034」但端口表里
   *    数来数去只有 1020 个空闲端口 —— 用户一眼就能看出来的错。
   *    这里逐级重算：device → station.totals → campus.totals → snap.totals，
   *    和契约里 free_ratio = free/(total-unknown) 的口径保持一致。
   *
   * 参数：
   *   snap   —— normalizeSnapshot() 出来的快照
   *   counts —— {device_id: 次数} 的映射（可为 null/空对象）
   *   threshold —— 达到多少次算不可用（默认取 SHZU.feedbackThreshold = 20）
   * 返回：新快照对象；counts 为空时原样返回 snap（不制造无意义拷贝）。
   */
  function applyFeedbackOverlay(snap, counts, threshold) {
    if (!snap || !snap.campuses) { return snap; }
    var src = counts || {};
    var th = (typeof threshold === 'number' && threshold > 0)
      ? threshold
      : (SHZU.feedbackThreshold || 20);

    // 先看有没有任何一个端口命中阈值；没有就直接返回原对象，
    // 避免每次刷新都重建一遍几百个设备（端口表全量渲染时这个开销不小）。
    var hits = 0;
    for (var ci = 0; ci < snap.campuses.length; ci++) {
      var sts = snap.campuses[ci].stations || [];
      for (var si = 0; si < sts.length; si++) {
        var dvs = sts[si].devices || [];
        for (var di = 0; di < dvs.length; di++) {
          var n = U.num(src[dvs[di].id]);
          if (n >= th) { hits++; }
        }
      }
    }
    if (!hits) {
      // 没有命中的端口也要把 feedback_count 标上（抽屉里要显示「其他用户
      // 提交不可用次数：N」，N 可能是 5 这种不足以标记的值）。
      return attachFeedbackCounts(snap, src, th);
    }
    return attachFeedbackCounts(snap, src, th, true);
  }

  /* 给每个 device 打上 feedback_count / feedback_flagged，命中阈值的把
   * status 改成 offline（raw_status 保留原值，便于抽屉里说清「本来是什么」）。
   * 逐级重算 totals —— 见上面 applyFeedbackOverlay 的注释。 */
  function attachFeedbackCounts(snap, src, th, flag) {
    var anyChange = false;
    var newCampuses = [];
    for (var ci = 0; ci < snap.campuses.length; ci++) {
      var campus = snap.campuses[ci];
      var newStations = [];
      var campusChanged = false;
      for (var si = 0; si < (campus.stations || []).length; si++) {
        var station = campus.stations[si];
        var newDevices = [];
        var devChanged = false;
        for (var di = 0; di < (station.devices || []).length; di++) {
          var dev = station.devices[di];
          var count = U.num(src[dev.id]);
          var flagged = flag && count >= th;
          var nd = {
            id: dev.id,
            code: dev.code,
            name: dev.name,
            status: flagged ? 'offline' : dev.status,
            power_w: dev.power_w,
            busy_since: dev.busy_since,
            order_id: dev.order_id,
            feedback_count: count
          };
          if (flagged) {
            nd.raw_status = dev.status;
            nd.feedback_flagged = true;
            if (dev.status !== 'offline') { devChanged = true; }
          } else if (dev.raw_status) {
            // 之前套过 overlay、这次没命中了（例如云端计数被清）→ 保持原始状态
            nd.status = dev.raw_status;
            nd.raw_status = dev.raw_status;
          }
          newDevices.push(nd);
        }
        if (devChanged) { anyChange = true; campusChanged = true; }
        var st2 = {
          id: station.id,
          name: station.name,
          campus_id: station.campus_id,
          source_id: station.source_id,
          address: station.address,
          lat: station.lat,
          lng: station.lng,
          updated_at: station.updated_at,
          // 设备状态变了就必须重算站点 totals，否则卡片数字和端口网格对不上
          totals: devChanged ? U.totalsFromDevices(newDevices) : station.totals,
          devices: newDevices
        };
        newStations.push(st2);
      }
      var campusTotals = campus.totals;
      if (campusChanged && campusTotals) {
        campusTotals = recomputeTotalsFromStations(newStations);
      }
      newCampuses.push({
        id: campus.id,
        name: campus.name,
        order: campus.order,
        totals: campusTotals,
        stations: newStations
      });
    }

    var newTotals = snap.totals;
    if (anyChange && newTotals) {
      newTotals = recomputeTotalsFromStations(
        (function () {
          var all = [];
          for (var k = 0; k < newCampuses.length; k++) {
            all = all.concat(newCampuses[k].stations || []);
          }
          return all;
        })()
      );
    }

    var out = {};
    for (var key in snap) {
      if (snap.hasOwnProperty(key)) { out[key] = snap[key]; }
    }
    out.campuses = newCampuses;
    out.totals = newTotals;
    out.feedback_applied = true;
    return out;
  }

  /* 归一化 /api/sources 里每个源的「分校区明细」sources[i].campuses。
   *
   * 契约（relay 1.5）：
   *   "campuses": [{"id":"zhongqu","name":"中区","order":1,
   *                 "totals":{"total":260,"free":57,...},
   *                 "stations": 3}]
   * 注意 stations 这里是**站点个数**（数字），不是站点数组 —— 和 snapshot
   * 里同名但异构的字段很容易看错，这里显式兼容两种形态。
   *
   * 返回 null 表示「这个源没有分校区明细」（公共频道 / 旧 relay），
   * UI 据此把该源那一行降级成不可点，而不是显示一个空白的详情页。 */
  function normalizeSourceCampuses(raw) {
    if (!raw || Object.prototype.toString.call(raw) !== '[object Array]') { return null; }
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i] || {};
      var id = c.id ? String(c.id) : '';
      if (!id) { continue; }
      var stationCount;
      if (Object.prototype.toString.call(c.stations) === '[object Array]') {
        stationCount = c.stations.length;             // 防御：万一是数组
      } else {
        stationCount = numOr(c.stations, 0);
      }
      out.push({
        id: id,
        name: c.name || U.campusName(id),
        order: (typeof c.order === 'number' && isFinite(c.order)) ? c.order : 99,
        totals: normalizeTotals(c.totals),
        stations: stationCount
      });
    }
    // 按六校区固定顺序排（未知 id 排最后），UI 就不用再排一次
    out.sort(function (a, b) {
      var am = U.campusMeta(a.id), bm = U.campusMeta(b.id);
      var ao = am ? (am.order || 0) : a.order;
      var bo = bm ? (bm.order || 0) : b.order;
      if (ao !== bo) { return ao - bo; }
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    return out.length ? out : null;
  }

  /* 归一化 /api/sources 的响应。字段名与 relay 的 shzu.sources.v1 对齐，
   * 多余字段直接丢掉；返回 null 表示「这条链路没有数据源信息」，
   * 调用方据此把整块区域隐藏。 */
  function normalizeSources(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sources)) { return null; }
    var out = [];
    for (var i = 0; i < raw.sources.length; i++) {
      var s = raw.sources[i] || {};
      var id = String(s.source_id || '');
      if (!id) { continue; }
      out.push({
        source_id: id,
        name: s.name || null,
        host: s.host || null,
        updated_at: s.updated_at || null,
        age_s: (typeof s.age_s === 'number' && s.age_s >= 0) ? s.age_s : null,
        stations: numOr(s.stations, 0),
        devices: numOr(s.devices, 0),
        free: numOr(s.free, 0),
        busy: numOr(s.busy, 0),
        offline: numOr(s.offline, 0),
        unknown: numOr(s.unknown, 0),
        throttled: !!s.throttled,
        blocked_since: s.blocked_since || null,
        retry_after: numOr(s.retry_after, null),
        message: s.message || null,
        /* 分校区明细（relay 1.5 新增）。缺省 null → 该源不可点进详情。
         * 白名单式重建：不写在这里的话，新字段会被静默丢掉，UI 一动不动。 */
        campuses: normalizeSourceCampuses(s.campuses)
      });
    }
    return out.length ? out : null;
  }

  function numOr(v, fallback) {
    var n = Number(v);
    return (typeof v === 'number' && isFinite(n)) ? n : fallback;
  }

  /* 判断一个响应是不是「线路格式」（sniffer/publish.py 的 to_wire 产物）。
   *
   * 为什么要认它：当 App/PWA 直接从自己的域名打开（https://shzucharge.xyz/）时，
   * 同源关系会让它优先走「relay」这条路，请求 /api/snapshot；而 Worker 在这个
   * 路径上回的是紧凑线路格式 {v,g,a,st,t,s}，**没有 schema / campuses / stations**。
   *
   * 这个形状喂给 normalizeSnapshot() 不会报错（它把 schema 当可选，用默认值兜底），
   * 但会得到一个 0 校区 0 端口的快照 —— 首页于是显示「暂无充电桩数据」。
   * 这是「网页版打不开/没数据」的真根因，必须先认出来再交给 publicfeed 还原。
   */
  function looksLikeWire(raw) {
    return !!(raw && typeof raw === 'object' && !Array.isArray(raw) &&
      (raw.v === 1 || raw.v === '1') && Array.isArray(raw.s) && !raw.schema);
  }

  /* ---------------- API 封装 ---------------- */

  /* relay 专用超时。
   * APK 启动时会先试局域网 relay（?relay=http://192.168.1.119:8080），人不在那个
   * 局域网里这个请求必然失败。用通用超时 9 秒等它，用户开局就得盯着骨架屏干等；
   * 4 秒（DEFAULTS.relayTimeoutMs）足以让校园网内的 relay 应答，超时立刻转公共
   * 频道。公共频道（publicfeed.js）走自己的 timeout 参数，不受这里影响。 */
  function relayTimeout() {
    var v = SHZU.defaults && SHZU.defaults.relayTimeoutMs;
    return (typeof v === 'number' && v > 0) ? v : 4000;
  }

  var api = {
    ApiError: ApiError,

    snapshot: function () {
      return request('/api/snapshot?ts=' + Date.now(), { timeout: relayTimeout() })
        .then(function (res) {
          var data = res.data;
          /* 同源部署在自己域名上时，/api/snapshot 回的是线路格式，先还原成标准
           * 快照再归一化（详见 looksLikeWire 的注释）。publicfeed.js 的加载顺序
           * 在 api.js 之后，但这里只在「请求回来之后」才用到，所以运行时一定已就绪。 */
          var fromWire = looksLikeWire(data);
          if (fromWire) {
            var pf = SHZU.publicFeed;
            if (!pf || typeof pf.wireToSnapshot !== 'function') {
              throw new ApiError('parse', '收到线路格式数据，但 publicfeed.js 没加载');
            }
            try {
              data = pf.wireToSnapshot(data, {});
            } catch (e) {
              throw new ApiError('parse', '线路格式解析失败：' + (e && e.message || e));
            }
          }
          var snap = normalizeSnapshot(data);
          if (fromWire) {
            /* 数据确实来自「自己的域名」（Worker + KV），只是用同源 relay 这条路取回来的，
             * 标记一下让设置页/横幅能说清楚来源。 */
            snap.from_public_feed = true;
            snap.public_feed_from = 'cloud';
          }
          snap.from_sw_cache = !!res.fromSwCache;
          // SW 缓存兜底的数据不覆盖 localStorage 里的「新鲜」缓存时间戳也行，
          // 但内容是一样的，照常落盘；靠 from_sw_cache 让 UI 显示离线提示。
          cachePut(SHZU.storeKey.snapshot, snap);
          return snap;
        });
    },

    history: function (campus, hours, bucket) {
      var q = '?campus=' + encodeURIComponent(campus || 'all') +
        '&hours=' + encodeURIComponent(hours || 24) +
        '&bucket=' + encodeURIComponent(bucket || '10m') +
        '&ts=' + Date.now();

      function take(raw, from) {
        var h = normalizeHistory(raw, campus, hours);
        h.from_cloud = (from === 'cloud');
        h.from_local = (from === 'local');
        h.origin = from;
        if (from !== 'local') {
          cachePut(SHZU.storeKey.history, { key: historyCacheKey(campus, hours, bucket), data: h, at: Date.now() });
        }
        return h;
      }

      /* 三级取历史，也是「网页端看不到当前空闲率」的修法：
       *   1) relay /api/history  —— 局域网 / relay 直接托管时最细（1 分钟桶）
       *   2) 自己的域名 /history —— Worker 的 KV 环形缓冲（10 分钟粒度，零额外 KV 写）
       *   3) 本机采样            —— 前两级都拿不到时，用自己攒过的点
       * 风控（429 惩罚期）必须冒泡，不能被兜底吞掉 —— 否则用户以为一切正常，
       * 实际上刷新已经被禁了，界面会自相矛盾。 */
      function bail(err) {
        var h = localHistory(campus, hours, bucket);
        if (h.points && h.points.length) {
          h.origin = 'local';
          h.from_local = true;
          return h;
        }
        throw err;
      }

      return request('/api/history' + q, { timeout: relayTimeout() }).then(function (res) {
        /* 同源部署时 Worker 把 /api/history 也接了（别名），但它给的是 KV 环形缓冲
         * （source: 'kv-ring'）而不是 relay 的 SQLite —— 标成 cloud，脚注才会说
         * 「云端历史（约 10 分钟一个点）」，否则用户会以为掉点了是程序坏了。 */
        var origin = (res.data && res.data.source === 'kv-ring') ? 'cloud' : 'relay';
        var h = take(res.data, origin);
        h.from_sw_cache = !!res.fromSwCache;
        return h;
      }).catch(function (err) {
        if (err && (err.kind === 'ratelimit' || err.kind === 'throttled')) { throw err; }
        var base = cloudBase();
        if (!base) { return bail(err); }
        return cloudGet(base + '/history' + q).then(function (data) {
          // 云端环形缓冲刚部署时是空的：本地攒过点就用本地的，别让页面空着
          if (!data || !data.points || !data.points.length) {
            var lh = localHistory(campus, hours, bucket);
            if (lh.points && lh.points.length) {
              lh.origin = 'local';
              lh.from_local = true;
              return lh;
            }
          }
          return take(data, 'cloud');
        }).catch(function (err2) {
          if (err2 && (err2.kind === 'ratelimit' || err2.kind === 'throttled')) { throw err2; }
          return bail(err);
        });
      });
    },

    config: function () {
      return request('/api/config?ts=' + Date.now()).then(function (res) { return res.data || {}; });
    },

    /* GET /api/sources：每个数据源最后一次采集的状态（relay 多源分区接口）。
     *
     * 语义是「尽力而为」：这个接口是 relay 1.4 才有的，公共频道（ntfy）模式下
     * 压根没有 relay，旧版 relay 也会返回 404。所以这里**不 reject**，
     * 失败一律 resolve(null)，让调用方直接整块隐藏数据源区域，
     * 而不会把快照主流程带崩、也不会在 console 里刷红字。
     */
    sources: function () {
      return request('/api/sources?ts=' + Date.now(), { timeout: relayTimeout() })
        .then(function (res) { return normalizeSources(res.data); })
        .catch(function () { return null; });
    },

    /* 从快照自带的 sources 还原数据源列表。
     *
     * 云中转（自己的域名）与公共频道（ntfy）都没有 /api/sources 这条接口，
     * 数据源清单只存在于线路格式里。publicfeed.wireToSnapshot 已经把它补齐成
     * 与 relay 完全同形的结构，这里复用同一个 normalizeSources，保证两条路的
     * UI 行为一致（否则就会出现「网页版有分类、APK 走云端没分类」这种割裂）。 */
    sourceListFromSnapshot: function (snap) {
      if (!snap || !snap.sources || !snap.sources.length) { return null; }
      return normalizeSources({ sources: snap.sources });
    },

    /* GET /feedback —— 全站各端口的「其他用户提交不可用」次数。
     *
     *   {ok:true, threshold:20, counts:{"<device_id>": N}}
     *
     * 和 /api/sources 一样是「尽力而为」：拿不到就 resolve(null)，绝不 reject，
     * 不能因为反馈服务挂了导致快照主流程报错、也绝不弹错误提示。
     * 注意它打的是云中转（Cloudflare Worker）而不是 relay —— 反馈是全站共享的，
     * 局域网 relay 没有这份数据。 */
    feedback: function () {
      var base = cloudBase();
      if (!base) { return Promise.resolve(null); }
      return cloudGet(base + '/feedback').then(function (data) {
        return normalizeFeedback(data);
      }).catch(function () { return null; });
    },

    /* POST /feedback —— 提交一条「该端口现在不可用」。
     * body 用 device_id + kind + client_id，服务端自己累加计数、自己封顶，
     * 客户端不参与「够不够 20 次」的判定（判定用服务端返回的 count）。
     *
     * client_id 是「同一端口每人只能投一次」的去重键：服务端把它记进
     * agg:feedback 的 voters 里，同一个 client_id 再投同一端口会返回
     * {duplicate:true} 且不写 KV。不带它服务端只能退化成按出口 IP 去重，
     * 而校园网整栋楼共用一个 NAT，会把别人投过的票算到你头上。
     * 老版本 App 不带这个字段也仍能用（服务端有 IP 兜底）。 */
    submitFeedback: function (deviceId, kind, clientId) {
      var base = cloudBase();
      if (!base) {
        return Promise.reject(new ApiError('nocloud', '没有配置云中转地址'));
      }
      var body = {
        device_id: String(deviceId || ''),
        kind: String(kind || 'unavailable')
      };
      var cid = String(clientId || '');
      if (cid) { body.client_id = cid; }
      return cloudPost(base + '/feedback', body);
    },

    applyFeedbackOverlay: applyFeedbackOverlay,

    health: function (baseUrl) {
      var url = (baseUrl !== undefined ? SHZU.trimSlash(baseUrl) : SHZU.trimSlash(SHZU.relay)) + '/api/health';
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        var done = false;
        function fin(fn, v) { if (!done) { done = true; fn(v); } }
        try {
          xhr.open('GET', url + (url.indexOf('?') >= 0 ? '&' : '?') + 'ts=' + Date.now(), true);
          xhr.timeout = 6000;
          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
              var data = null;
              try { data = JSON.parse(xhr.responseText || 'null'); } catch (e) { data = xhr.responseText; }
              fin(resolve, { ok: true, status: xhr.status, data: data, url: url });
            } else {
              fin(reject, new ApiError('http', 'HTTP ' + xhr.status, { url: url, status: xhr.status }));
            }
          };
          xhr.onerror = function () { fin(reject, new ApiError('network', '网络不可达', { url: url })); };
          xhr.ontimeout = function () { fin(reject, new ApiError('timeout', '请求超时', { url: url })); };
          xhr.send(null);
        } catch (e) {
          fin(reject, new ApiError('network', String(e && e.message || e), { url: url }));
        }
      });
    },

    normalizeSnapshot: normalizeSnapshot,
    isStaleByTime: isStaleByTime,
    /* 供公共频道（publicfeed.js）把对端数据也落盘，离线时和 relay 数据同等待遇 */
    cachePut: cachePut,
    cacheGet: cacheGet,

    cachedSnapshot: function () {
      var c = cacheGet(SHZU.storeKey.snapshot);
      if (!c || !c.payload) { return null; }
      var snap;
      try { snap = normalizeSnapshot(c.payload); } catch (e) { return null; }
      snap._cachedAt = c.savedAt;
      snap._fromCache = true;
      return snap;
    },

    cachedHistory: function (campus, hours, bucket) {
      var c = cacheGet(SHZU.storeKey.history);
      if (!c || !c.payload || c.payload.key !== historyCacheKey(campus, hours, bucket)) { return null; }
      return c.payload.data;
    },

    clearCaches: function () {
      SHZU.lsDel(SHZU.storeKey.snapshot);
      SHZU.lsDel(SHZU.storeKey.history);
      // 注意：**不清** samples —— 那是用户本机攒的历史，清了历史页就真空了。
      // 用户点「清除本地缓存」是想要干净的快照，不是想把自己攒的曲线一起丢掉。
    },

    /* 供测试/排障：把本机采样和历史兜底暴露出去 */
    localHistory: localHistory,
    readSamples: readSamples
  };

  function historyCacheKey(campus, hours, bucket) {
    return (campus || 'all') + '|' + (hours || 24) + '|' + (bucket || '10m');
  }

  function normalizeHistory(raw, campus, hours) {
    var h = raw || {};
    var points = [];
    for (var i = 0; i < (h.points || []).length; i++) {
      var p = h.points[i] || {};
      if (!p.t) { continue; }
      points.push({
        t: p.t,
        free: U.num(p.free),
        total: U.num(p.total),
        free_ratio: (typeof p.free_ratio === 'number' && isFinite(p.free_ratio)) ? p.free_ratio : 0
      });
    }
    return {
      schema: h.schema || 'shzu.history.v1',
      campus: h.campus || campus || 'all',
      hours: (typeof h.hours === 'number') ? h.hours : (hours || 24),
      bucket_seconds: U.num(h.bucket_seconds) || 600,
      points: points,
      demo: !!h.demo
    };
  }

  SHZU.api = api;
})(window);
