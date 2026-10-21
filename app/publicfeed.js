/* publicfeed.js — 公共频道读取层：让「别人装上 App 就能看」成立
 *
 * 为什么需要这一层
 * ----------------
 * 数据源 charge.shzu.edu.cn 没有 CORS 头，浏览器不能直连；别人也不可能连到
 * 你平板的局域网。所以平板用 sniffer/publish.py 把压缩后的快照推到 ntfy.sh
 * 公共频道，本文件负责把它读回来，还原成标准 snapshot 形状交给 app.js。
 *
 * 数据格式（与 sniffer/publish.py 的 to_wire 严格对应，改一端必须改另一端）
 * ------------------------------------------------------------------
 *   {"v":1,"g":生成时间,"a":数据时间,"st":0/1,
 *    "t":[总,空闲,占用,离线,未知,空闲率],
 *    "s":[["beiqu-01","北区14号公寓","1-1,1-2,...","ffbbbb..."] , ...]}
 * 状态字符 f=f 空闲 b=占用 o=离线 u=未知。
 *
 * 读法（实测 ntfy 行为）
 * ---------------------
 *   GET https://ntfy.sh/<topic>/json?poll=1                  → NDJSON，重放整个频道缓存
 *   GET https://ntfy.sh/<topic>/json?poll=1&since=<消息 id>   → 只返回该消息**之后**的新消息
 * 实测本频道无游标一次就是 164 KB / 439 条，且 ntfy 的
 * `visitor-attachment-daily-bandwidth-limit`（500 MB/天）**把 poll 重放也算进去**。
 * App 每 15 秒无游标轮询 ≈ 950 MB/天，一天就超。所以轮询必须带游标：
 * 带游标时频道安静会返回 200 + 空体（不是报错），据此直接复用上次快照。
 * 从消息列表里挑**最后一条带 attachment 的**消息，下载它的 attachment.url。
 * 两个端点都带 Access-Control-Allow-Origin: *，浏览器可直接跨域读。
 * 消息正文里还有一行 `SHZU1|...` 摘要，附件挂了时用来兜底显示全校数字。
 *
 * 降级顺序（app.js 负责调用顺序，本文件只提供能力）
 *   公共频道 → relay（局域网/同源）→ Service Worker 缓存 → localStorage
 *
 * 省流量的三道措施（发布端也已节流，见 sniffer/publish.py 的 --min-interval）
 *   ① poll 带 since 游标，不重放整个频道（省掉最大头：164 KB → 几十字节）；
 *   ② 最新附件消息 id 没变 → 复用上次结果，不下载附件；
 *   ③ HTTP 429（突发速率限制）→ 返回上次结果，不当作错误。
 *   没有这三道时，App 每 15 秒会重放 164 KB 并重下 12 KB 同一份文件。
 */
(function (global) {
  'use strict';

  var SHZU = global.SHZU;
  var U = SHZU.util;

  var STATUS_BY_CHAR = { f: 'free', b: 'busy', o: 'offline', u: 'unknown' };
  /* 状态字符 → 中文（只用于错误信息与调试，UI 文案仍走 config.js 的 status） */
  var FEED_PREFIX = 'SHZU1|';
  /* 正文内嵌线路数据的前缀（publish.py embed_line 产出）。
   * 刻意与 FEED_PREFIX 区分开：老版本 App 只找 'SHZU1|'，看到 'SHZU1Z|'
   * 会当作不认识的内容忽略，行为完全不变 —— 这样发布端先上、App 后升，
   * 中间任何时刻都不会互相打断。 */
  var EMBED_PREFIX = 'SHZU1Z|';

  function FeedError(kind, message, extra) {
    this.name = 'FeedError';
    this.kind = kind;
    this.message = message || kind;
    this.url = (extra && extra.url) || '';
    if (Error.captureStackTrace) { Error.captureStackTrace(this, FeedError); }
  }
  FeedError.prototype = Object.create(Error.prototype);
  FeedError.prototype.constructor = FeedError;

  /* ---------------- 消息级去重 + 限流容忍 ---------------- */
  /* 为什么要这一层
   * --------------
   * 发布端已经节流到「最短 60 秒 + 内容没变不发」，但 App 每 15 秒刷一次。
   * 于是绝大多数轮询拿回的是**同一个**附件，白白下载 12 KB，还更容易撞上
   * ntfy 的突发速率限制（实测 code=42901 too many requests）。
   * 做法：记住上次用过的消息 id。最新附件消息没变 → 直接复用上次还原好的
   * snapshot，一个字节都不下载。变了才去下。
   *
   * 同时把 HTTP 429 单独归类为 'throttled'：它是「等一会儿就好」，不是数据坏了。
   * 有缓存就返回缓存（页面继续显示），没有缓存才当失败处理 —— 否则用户会看到
   * 「公共频道没有数据」，其实只是刚才请求密了点。
   *
   * 增量游标（比上面那层更要紧，见文件头实测数据）
   * ------------------------------------------------
   * 光靠「id 没变就不下载」省不下多少：ntfy 的 poll 不带游标时会把**整个频道
   * 缓存重放一遍**，实测本频道一次 164 KB / 439 条；App 每 15 秒拉一次 =
   * 每天约 950 MB，而 ntfy 的读侧日带宽配额是 500 MB（附件与 poll 重放都算），
   * 一天就会把所有人（包括别的 IP 无关的访客）一起限掉。
   * 所以 poll 必须带 since=<上次最后一条消息 id>，实测无新消息时返回空体。
   */
  var memo = {};   /* topic -> {id, cursor, snap}，按频道分开存 */

  /* 从 FeedError 里认出「被限流」，用于降级到缓存而不是报错 */
  function isThrottled(err) {
    return !!(err && (err.kind === 'throttled' || err.throttled));
  }

  /* 一批消息里的最后一条 id（ntfy 按时间正序返回，即最新那条） */
  function lastMessageId(messages) {
    if (!messages || !messages.length) { return null; }
    var m = messages[messages.length - 1];
    return (m && m.id) ? String(m.id) : null;
  }

  /* 从 429 响应里识别「是不是我们自己 Worker 的风控惩罚」。
   *
   * **必须分清硬惩罚和软拒绝**（2026-10-21 限流改版后新增的区分）：
   *   - 硬惩罚：body.penalty_seconds > 0，带 X-Client-Id 的新版 App 一分钟超 20 次。
   *     返回 kind='ratelimit'，交给 app.js 弹窗 + 锁刷新 + 停发 120 秒。
   *   - 软拒绝：body.penalty_seconds === 0，不带 client_id 的老客户端按 IP 兜底，
   *     或校园 NAT 同一 IP 人太多。**绝不能当惩罚** —— 那会「一个人手快，整栋楼
   *     被弹窗锁两分钟」。返回 kind='throttled'（普通限流，不锁刷新、不弹窗）。
   *   - 不是我们 Worker 的 429（ntfy 的 42901/42908）：返回 null，交给调用方
   *     按原来的 ntfy 分支处理。
   *
   * 判据必须是 body.penalty_seconds 这个显式字段，不能靠「有没有 Retry-After」猜：
   * 软拒也带 Retry-After，拿它补默认值就会把软拒误判成 120 秒惩罚。 */
  function readRateLimit(xhr, url) {
    var body = null;
    try { body = JSON.parse(xhr.responseText || 'null'); } catch (e) { body = null; }
    var isObj = !!(body && typeof body === 'object');
    var flagged = !!(isObj && body.rate_limited);
    var hasField = !!(isObj && isFinite(Number(body.penalty_seconds)));
    if (!flagged && !hasField) { return null; }
    var ps = hasField ? Math.floor(Number(body.penalty_seconds)) : 0;
    var msg = (isObj && typeof body.error === 'string' && body.error) ? body.error : '';
    if (ps > 0) {
      var err = new FeedError('ratelimit', msg || '您已触发风控限制，请两分钟后再试',
        { url: url, status: 429, penalty_seconds: ps });
      err.penaltySeconds = ps;
      err.rateLimited = true;
      return err;
    }
    // 软拒绝：只是这一小段时间别请求，不锁刷新、不弹风控弹窗
    var retryAfter = 0;
    try {
      var ra = xhr.getResponseHeader('Retry-After');
      if (ra) { retryAfter = parseInt(ra, 10) || 0; }
    } catch (e) { /* 读不到就按 60 秒算 */ }
    var soft = new FeedError('throttled', msg || '请求太频繁，请稍后再试',
      { url: url, status: 429, retry_after: retryAfter || 60 });
    soft.throttleSeconds = retryAfter || 60;
    return soft;
  }

  function httpGet(url, timeoutMs, responseType) {
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
        xhr.timeout = timeoutMs || 15000;
        if (responseType) { xhr.responseType = responseType; }
        // 只发简单请求头，不触发 OPTIONS 预检
        xhr.setRequestHeader('Accept', '*/*');
        // 只有打我们自己的云时才带限流标识（ntfy 不认识这个头，带了会多一次预检）
        try {
          var cloudBase = SHZU.publicCloud || '';
          var cid = (cloudBase && url.indexOf(cloudBase) === 0 && SHZU.ensureClientId) ? SHZU.ensureClientId() : null;
          if (cid) { xhr.setRequestHeader('X-Client-Id', cid); }
        } catch (e) { /* 拿不到就不发，Worker 会退回按 IP 计数 */ }
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            finish(resolve, { text: (responseType ? '' : (xhr.responseText || '')), status: xhr.status, url: url });
          } else if (xhr.status === 429) {
            /* 429 有两个来源，必须分清：
             *   - ntfy 的 42901/42908，是公共频道的限流（没有惩罚期，稍后重试即可）
             *   - 我们自己 Worker 的风控，是「一分钟超 20 次 → 罚 120 秒」，
             *     body 里带 rate_limited:true 和 penalty_seconds，App 收到后要
             *     弹窗 + 锁刷新 + 停发请求。当成普通 throttled 吞掉的话，
             *     用户点刷新就会「什么都没发生」，还以为 App 卡了。 */
            var pen = readRateLimit(xhr, url);
            if (pen) { finish(reject, pen); return; }
            finish(reject, new FeedError('throttled', '公共频道限流，稍后自动重试', { url: url }));
          } else {
            finish(reject, new FeedError('http', 'HTTP ' + xhr.status, { url: url }));
          }
        };
        xhr.onerror = function () { finish(reject, new FeedError('network', '网络不可达', { url: url })); };
        xhr.ontimeout = function () { finish(reject, new FeedError('timeout', '请求超时', { url: url })); };
        xhr.onabort = function () { finish(reject, new FeedError('network', '请求被取消', { url: url })); };
        xhr.send(null);
      } catch (e) {
        finish(reject, new FeedError('network', String((e && e.message) || e), { url: url }));
      }
    });
  }

  /* ---------------- NDJSON 解析 ---------------- */
  /* ntfy 返回 application/x-ndjson，一行一个 JSON。坏行跳过而不是整体失败。 */
  function parseNdjson(text) {
    var out = [];
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s+|\s+$/g, '');
      if (!line) { continue; }
      try { out.push(JSON.parse(line)); } catch (e) { /* 跳过坏行 */ }
    }
    return out;
  }

  /* 从消息列表里挑最新一条带附件的消息（ntfy 按时间正序返回） */
  function pickLatestAttachment(messages) {
    var picked = null;
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m && m.attachment && m.attachment.url) { picked = m; }
    }
    return picked;
  }

  /* 从消息正文里解析摘要（附件下载失败时的兜底） */
  function parseSummary(messages) {
    var last = null;
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var txt = m && m.message;
      if (typeof txt === 'string' && txt.indexOf(FEED_PREFIX) === 0) { last = txt; }
    }
    if (!last) { return null; }
    var parts = last.split('|');
    // SHZU1|generated_at|data_at|stale|total,free,busy,offline,unknown
    if (parts.length < 5) { return null; }
    var nums = String(parts[4] || '').split(',');
    if (nums.length < 5) { return null; }
    var n = [];
    for (var k = 0; k < 5; k++) {
      var v = parseInt(nums[k], 10);
      n.push(isFinite(v) ? v : 0);
    }
    return {
      generated_at: parts[1] || null,
      data_at: parts[2] || null,
      stale: parts[3] === '1',
      totals: {
        total: n[0], free: n[1], busy: n[2], offline: n[3], unknown: n[4],
        free_ratio: (n[0] - n[4]) > 0 ? (n[1] / (n[0] - n[4])) : 0
      }
    };
  }

  /* ---------------- wire → snapshot ---------------- */
  /* 把线路格式还原成标准 snapshot 形状（api.js 的 normalizeSnapshot 能吃）。
   * 关键：站点 id 形如 `zhongqu-01`，前两段（到最后一个 '-'）就是 campus_id。 */
  function campusIdOfStation(stationId) {
    var i = String(stationId || '').lastIndexOf('-');
    if (i <= 0) { return '_unassigned'; }
    return String(stationId).slice(0, i);
  }

  function wireToSnapshot(wire, opts) {
    if (!wire || typeof wire !== 'object') { throw new FeedError('parse', '公共频道数据为空'); }
    if (wire.v !== 1) {
      throw new FeedError('parse', '公共频道数据版本不支持：' + wire.v + '（App 需要 v1）');
    }
    var stations = wire.s || [];
    if (!stations.length) { throw new FeedError('parse', '公共频道里没有站点数据'); }

    var byCampus = {};
    var order = [];
    for (var i = 0; i < stations.length; i++) {
      var row = stations[i] || [];
      var sid = String(row[0] || '');
      var sname = String(row[1] || '未命名充电站');
      var codes = String(row[2] || '').split(',');
      var chars = String(row[3] || '');
      var cid = campusIdOfStation(sid);

      var devices = [];
      for (var j = 0; j < chars.length; j++) {
        var ch = chars.charAt(j);
        var status = STATUS_BY_CHAR[ch] || 'unknown';
        // 端口 id 用「站 id + 三位序号」，与 relay 的稳定 id 规则一致
        var seq = j + 1;
        var devId = sid + '-' + (seq < 10 ? '00' + seq : (seq < 100 ? '0' + seq : '' + seq));
        devices.push({
          id: devId,
          code: codes[j] || String(seq),
          name: null,
          status: status,
          power_w: null,
          busy_since: null,
          order_id: null
        });
      }
      var tot = U.totalsFromDevices(devices);
      var station = {
        id: sid,
        name: sname,
        campus_id: cid,
        address: null,
        lat: null,
        lng: null,
        updated_at: wire.a || null,
        totals: tot,
        // 线路第 5 位是数据源 id（shzu / lvcc）。没有 relay 的 /api/sources 时，
        // 端口表的「全部来源 / 石河子 / 充充充」筛选就靠它。
        // 老线路只有 4 位，这里给 null，UI 会归到「全部来源」。
        source_id: row.length > 4 && row[4] ? String(row[4]) : null,
        devices: devices
      };
      if (!byCampus[cid]) { byCampus[cid] = []; order.push(cid); }
      byCampus[cid].push(station);
    }

    var campuses = [];
    for (var c = 0; c < order.length; c++) {
      var cid2 = order[c];
      var list = byCampus[cid2];
      var ct = U.zeroTotals();
      for (var s = 0; s < list.length; s++) {
        ct.total += list[s].totals.total;
        ct.free += list[s].totals.free;
        ct.busy += list[s].totals.busy;
        ct.offline += list[s].totals.offline;
        ct.unknown += list[s].totals.unknown;
      }
      var cdenom = ct.total - ct.unknown;
      ct.free_ratio = cdenom > 0 ? ct.free / cdenom : 0;
      campuses.push({
        id: cid2,
        name: U.campusName(cid2),
        order: (U.campusMeta(cid2) || {}).order || 99,
        totals: ct,
        stations: list
      });
    }
    campuses = U.normalizeCampuses(campuses);

    // totals 优先用发布端算好的（它与 relay 一致），缺失时重算
    var totals;
    var t = wire.t;
    if (t && t.length >= 5) {
      var denom = Math.max(0, (t[0] | 0) - (t[4] | 0));
      totals = {
        total: t[0] | 0, free: t[1] | 0, busy: t[2] | 0,
        offline: t[3] | 0, unknown: t[4] | 0,
        free_ratio: denom > 0 ? (t[1] | 0) / denom : 0
      };
    } else {
      totals = U.zeroTotals();
      for (var q = 0; q < campuses.length; q++) {
        totals.total += campuses[q].totals.total;
        totals.free += campuses[q].totals.free;
        totals.busy += campuses[q].totals.busy;
        totals.offline += campuses[q].totals.offline;
        totals.unknown += campuses[q].totals.unknown;
      }
      var d2 = totals.total - totals.unknown;
      totals.free_ratio = d2 > 0 ? totals.free / d2 : 0;
    }

    return {
      schema: 'shzu.snapshot.v1',
      generated_at: wire.g || null,
      data_at: wire.a || null,
      stale: !!wire.st,
      demo: false,
      // source 让 UI 能如实标注「公共频道数据」，与 relay 直连区分开
      source: {
        kind: 'public-feed',
        applet: (opts && opts.applet) || '石河子大学充电桩',
        collector: (opts && opts.collector) || 'publicfeed.js',
        confidence: 1.0
      },
      totals: totals,
      campuses: campuses,
      from_public_feed: true,
      // 采集端带过来的数据源限流提示。走公共频道的人看不到 relay，
      // 只能靠这两个字段才知道「数据停在某时某分」而不是自己 App 坏了。
      sources: sourcesFromWire(wire, wire.a || null),
      source_warning: wire.w || null
    };
  }

  /* 线路里的 src → 与 relay `/api/sources` 完全同形的数据源列表。
   *
   * 为什么必须同形：云中转 / 公共频道模式下没有 `/api/sources` 这条接口，
   * 首页「数据源」区块和端口表的「全部来源」筛选都只认这个形状。2026-10-20
   * 用户报「这次给的 APK 里没有充充充和石河子大学充电桩的分类了」——就是因为
   * 那时线路里只有 `src: [{id, ok, name, host...}]`，没有任何端口统计，
   * 前端拿到一份「没有 free/devices 的源」直接整块隐藏了。
   */
  function sourcesFromWire(wire, dataAt) {
    var rows = wire && wire.src;
    if (!rows || !rows.length) { return null; }
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i] || {};
      var id = String(s.id || '');
      if (!id) { continue; }
      var campuses = null;
      var stationSum = 0;
      if (s.c && s.c.length) {
        campuses = [];
        for (var j = 0; j < s.c.length; j++) {
          var row = s.c[j] || [];
          var cid = String(row[0] || '');
          if (!cid) { continue; }
          var ct = {
            total: row[1] | 0, free: row[2] | 0, busy: row[3] | 0,
            offline: row[4] | 0, unknown: row[5] | 0
          };
          var cdenom = Math.max(0, ct.total - ct.unknown);
          ct.free_ratio = cdenom > 0 ? ct.free / cdenom : 0;
          var cnt = row[6] | 0;
          stationSum += cnt;
          campuses.push({
            id: cid,
            name: U.campusName(cid),
            order: (U.campusMeta(cid) || {}).order || 99,
            totals: ct,
            stations: cnt
          });
        }
        if (!campuses.length) { campuses = null; }
      }
      // t = [total, free, busy, offline, unknown]（发布端按端口逐个数的，
      // 比 devices_number 可靠 —— 后者在源 A 上与真实端口数对不上）
      var t = (s.t && s.t.length >= 5) ? s.t : null;
      out.push({
        source_id: id,
        name: s.name || null,
        host: s.host || null,
        updated_at: dataAt || null,
        age_s: null,
        stations: stationSum,
        devices: t ? (t[0] | 0) : 0,
        free: t ? (t[1] | 0) : 0,
        busy: t ? (t[2] | 0) : 0,
        offline: t ? (t[3] | 0) : 0,
        unknown: t ? (t[4] | 0) : 0,
        throttled: !!s.throttled,
        blocked_since: s.blocked_since || null,
        retry_after: s.retry_after || null,
        // 被风控冻结的端口数：界面上要能说清「这 N 个端口的数据停在上轮」
        frozen_ports: (typeof s.frozen_ports === 'number') ? s.frozen_ports : null,
        message: s.message || null,
        campuses: campuses
      });
    }
    return out.length ? out : null;
  }

  /* ---------------- 对外 API ---------------- */

  /* 读 topic 的消息列表（NDJSON → 数组）
   *
   * cursor 传上次拿到的最后一条消息 id，就只返回它之后的新消息；
   * 没有新消息时 ntfy 返回 200 + 空体，这里补一个空数组而不是当失败
   * （否则「频道安静」会被误报成「频道坏了」）。 */
  function fetchMessages(topic, opts) {
    var o = opts || {};
    var base = SHZU.trimSlash(o.ntfy || SHZU.publicFeed.ntfy);
    var url = base + '/' + encodeURIComponent(topic) + '/json?poll=1';
    if (o.cursor) { url += '&since=' + encodeURIComponent(o.cursor); }
    return httpGet(url, o.timeout || 15000).then(function (res) {
      var msgs = parseNdjson(res.text);
      if (!msgs.length) {
        if (o.cursor) {
          // 带游标时为空是正常的：说明自上次之后没人发过新快照。
          if (o.allowEmpty) { return []; }
          throw new FeedError('empty', '公共频道还没有数据（平板端还没发布过）', { url: url });
        }
        throw new FeedError('empty', '公共频道还没有数据（平板端还没发布过）', { url: url });
      }
      return msgs;
    });
  }

  /* 下载附件并解析成 snapshot
   * 三道节省 / 三道容错：
   *   ① 最新附件消息 id 与上次相同 → 直接复用上次结果，零下载；
   *   ② poll 被限流 / 附件下载失败 / 频道里没有附件 → 返回 memo 里的旧快照；
   *   ③ memo **按 topic 分别记**，换频道绝不会看到上一个频道的数据。
   * 真正抛错只有一种：手上什么都没有（别人第一次装、频道还是空的）。
   * 那种情况必须报错，否则用户会看到一片空白却不知道为什么。 */
  /* 从消息正文里找内嵌的线路数据（SHZU1Z| + gzip+base64url）
   * --------------------------------------------------------------
   * 附件只有 3 小时寿命、正文有 12 小时。发布端撞上日配额停更几小时后，
   * 频道里最后那条消息还在、附件 URL 已经 404 —— 别人手机冷启动时手上
   * 没有任何缓存，就只能拿到这个 404，页面显示「公共频道也失败：HTTP 404」。
   * 发布端从 2026-10-20 起会把整份线路数据 gzip 后也塞进正文
   * （实测 12941 → 2965 字节，4000 上限内），所以附件拿不到时还有第二条路。
   * 倒序找：从最新一条往回，第一条解得开的就是最新的完整数据。 */
  function parseEmbedded(messages) {
    if (!SHZU.inflate || typeof SHZU.inflate.gunzipToText !== 'function') { return null; }
    for (var i = messages.length - 1; i >= 0; i--) {
      var m = messages[i];
      var txt = m && m.message;
      if (typeof txt !== 'string') { continue; }
      var at = txt.indexOf(EMBED_PREFIX);
      if (at < 0) { continue; }
      var b64 = txt.slice(at + EMBED_PREFIX.length);
      /* 正文可能只是摘要行（超限时发布端会跳过内嵌），先做长度体检再解码，
       * 避免对着几百字节的残留 base64 白跑一次 inflate */
      if (!b64 || b64.length < 64) { continue; }
      try {
        var wire = JSON.parse(SHZU.inflate.gunzipToText(b64));
        if (wire && wire.s && wire.s.length) {
          return { wire: wire, id: m.id || null, message: txt };
        }
      } catch (e) {
        /* 这一条解不开就往回再找一条 —— ntfy 静默截断过的消息属于这种情况 */
      }
    }
    return null;
  }

  /* ---------------- 自己的域名（Cloudflare Worker） ---------------- */
  /* 为什么这条路要排在 ntfy 前面
   * --------------------------
   * ntfy.sh 免费版有「每出口 IP 每天 250 条」的发布配额（实测），打光后
   * 公共频道整天停更，别人手机上的 App 就停在旧数据上；而且消息 12 小时过期、
   * 附件 3 小时过期。自己的域名走 Cloudflare Worker + KV，没有配额、数据不过期。
   *
   * 协议比 ntfy 简单一个数量级：GET /snapshot 直接返回线路格式 JSON，
   * 没有 NDJSON、没有消息列表、没有附件二次下载。失败时才退回 ntfy 频道，
   * 老频道作为兜底继续活着（老版本 APK 也还在读它）。 */
  function cloudBase() {
    return String((SHZU && SHZU.publicCloud) || '').replace(/\/+$/, '');
  }

  /* 新疆出口到 Cloudflare 的延迟实测在 2.4s ~ 19.6s 之间大幅波动（同一台平板、
   * 同一个 anycast 段，前一次 / 2.4s、后一次 /app.js 19.6s 都见过，还有 45s
   * 直接超时的情况）。所以云中转的超时给 15 秒而不是 8 秒，并且**网络类失败
   * 再试一次** —— 单次抖动就报「云中转失败」会让用户误以为服务挂了，转而去看
   * 已经停更的 ntfy 频道，反而拿到更旧的数据。 */
  var CLOUD_TIMEOUT_MS = 15000;
  var CLOUD_RETRIES = 1;
  var CLOUD_RETRY_DELAY_MS = 800;

  function cloudAttempt(url, timeoutMs) {
    return httpGet(url, timeoutMs).then(function (res) {
      var wire;
      try {
        wire = JSON.parse(res.text);
      } catch (e) {
        throw new FeedError('parse', '云中转返回的不是合法 JSON', { url: url });
      }
      return wire;
    });
  }

  function fetchCloudSnapshot(opts) {
    var o = opts || {};
    var base = cloudBase();
    if (!base) {
      return Promise.reject(new FeedError('nocloud', '没有配置云中转地址', {}));
    }
    var url = base + '/snapshot';
    var timeoutMs = o.cloudTimeout || o.timeout || CLOUD_TIMEOUT_MS;

    function attempt(n) {
      return cloudAttempt(url, timeoutMs).then(function (wire) {
        var snap = wireToSnapshot(wire, o);
        snap.public_feed_from = 'cloud';
        snap.public_feed_cloud = base;
        if (n > 1) { snap.public_feed_retried = n; }
        return snap;
      }, function (err) {
        // 只有「超时 / 网络断了」值得重试；4xx/5xx 与解析失败重试也是白试。
        var retryable = err && (err.kind === 'timeout' || err.kind === 'network');
        if (!retryable || n > CLOUD_RETRIES) { throw err; }
        return new Promise(function (resolve) {
          setTimeout(resolve, CLOUD_RETRY_DELAY_MS);
        }).then(function () { return attempt(n + 1); });
      });
    }
    return attempt(1);
  }

  function fetchSnapshot(topic, opts) {
    var o = opts || {};
    /* 云中转优先，失败退回 ntfy。
     * 两个都失败时把两边的失败原因都拼进 message：只报 ntfy 的错误会让用户
     * 以为配置的域名根本没被用上，排查时看不出到底是哪一条挂了。 */
    if (cloudBase() && !o.forceNtfy) {
      return fetchCloudSnapshot(o).then(function (snap) {
        snap.public_feed_topic = topic;
        return snap;
      }, function (cloudErr) {
        return fetchNtfySnapshot(topic, o).then(null, function (ntfyErr) {
          throw new FeedError(ntfyErr.kind || 'network',
            (cloudErr.message || '云中转失败') + '；公共频道也失败：' +
              (ntfyErr.message || '未知错误'),
            { cloud: cloudErr, ntfy: ntfyErr });
        });
      });
    }
    return fetchNtfySnapshot(topic, o);
  }

  function fetchNtfySnapshot(topic, opts) {
    var o = opts || {};
    var mem = memoFor(topic);
    // 已经有快照才用游标；冷启动必须先全量拿一次才能知道频道里有什么。
    var first = { timeout: o.timeout, ntfy: o.ntfy };
    if (mem.snap && mem.cursor) {
      first.cursor = mem.cursor;
      first.allowEmpty = true;
    }
    return fetchMessages(topic, first).then(function (msgs) {
      if (!msgs.length) {
        // 带游标且没有新消息：数据没变，直接复用。零下载、零解析。
        if (mem.snap) {
          mem.last_checked_at = Date.now();
          return shallowCopy(mem.snap);
        }
        throw new FeedError('empty', '公共频道还没有数据（平板端还没发布过）', {});
      }
      var summary = parseSummary(msgs);
      var picked = pickLatestAttachment(msgs);
      var latestId = lastMessageId(msgs);
      // 游标**不要在这里就推进**：下面附件下载可能失败。提前推进等于把那条
      // 消息划过去了，下次 poll 从它之后开始，于是这份附件再也不会被重试，
      // 页面会永远停在旧快照上 —— 而频道里明明有一份新的、能下下来。
      // 正确做法是「处理完再推进」，下载失败就保持原游标、下轮重来。
      if (!picked) {
        // 频道有消息但没附件（发布端在退避、预算用尽、或附件已过期）。
        // 先试正文内嵌的线路数据（活 12 小时），再退到旧快照。
        var emb0 = parseEmbedded(msgs);
        if (emb0) {
          var snap0 = wireToSnapshot(emb0.wire, o);
          snap0.public_feed_message_id = emb0.id;
          snap0.public_feed_topic = topic;
          snap0.public_feed_summary = summary;
          snap0.public_feed_from = 'message';
          advanceCursor(mem, latestId);
          mem.id = emb0.id;
          mem.snap = snap0;
          return snap0;
        }
        advanceCursor(mem, latestId);
        if (mem.snap) { return staleMemo(mem, summary, topic); }
        throw new FeedError('empty', '公共频道里没有快照附件', {});
      }
      if (mem.snap && mem.id && picked.id && picked.id === mem.id) {
        // 同一份快照：复用。但摘要每次都刷新 —— 它跟 poll 同一次响应，
        // 没有额外开销，而且能反映发布端刚算出的全校数字。
        advanceCursor(mem, latestId);
        var hit = shallowCopy(mem.snap);
        hit.public_feed_summary = summary;
        hit.public_feed_message_id = picked.id;
        mem.snap = hit;
        return hit;
      }
      var attUrl = picked.attachment.url;
      return httpGet(attUrl, o.attachmentTimeout || 20000).then(function (res) {
        var wire;
        try {
          wire = JSON.parse(res.text);
        } catch (e) {
          throw new FeedError('parse', '快照附件不是合法 JSON', { url: attUrl });
        }
        var snap = wireToSnapshot(wire, o);
        snap.public_feed_message_id = picked.id || null;
        snap.public_feed_topic = topic;
        snap.public_feed_summary = summary;
        mem.id = picked.id || null;
        mem.snap = snap;
        advanceCursor(mem, latestId);   // 这条确认拿到手了，才算处理完
        return snap;
      }, function (attErr) {
        // 附件挂了（3 小时过期 / 网络抖 / 被限流）。**先试正文内嵌线路数据**：
        // 那份数据跟着消息正文活 12 小时，附件早过期时它还在。手机上「一装上
        // 就报 HTTP 404」正是栽在这条缺失的兜底上。
        // 注意不动游标：附件下轮还会再试（它可能只是网络抖）。
        var emb = parseEmbedded(msgs);
        if (emb) {
          var snap2 = wireToSnapshot(emb.wire, o);
          snap2.public_feed_message_id = emb.id;
          snap2.public_feed_topic = topic;
          snap2.public_feed_summary = summary;
          snap2.public_feed_from = 'message';
          mem.id = emb.id;
          mem.snap = snap2;
          return snap2;
        }
        if (mem.snap) { return staleMemo(mem, summary, topic, attErr); }
        throw attErr;
      });
    }, function (err) {
      // 限流或网络抖动：只要手上还有上次读到的，就用它（页面照常显示数字）
      if (mem.snap) { return staleMemo(mem, null, topic, err); }
      throw err;
    });
  }

  /* 推进游标：只在「这条消息已经处理完」时调用。
   * 提前推进的代价是永久丢数据（见 fetchSnapshot 里的注释），所以这个
   * 动作只出现在三个确认完成的分支里。 */
  function advanceCursor(mem, id) {
    if (id) { mem.cursor = String(id); }
    mem.last_checked_at = Date.now();
  }

  /* 取得某个 topic 的缓存槽。key 用完整 topic 字符串 —— 用户可以在设置里
   * 改频道，也可用 ?topic= 临时换；两种情况下都不能串到别人的数据。
   * cursor 跟 snap 存在同一个槽里：换了频道就是一套全新的游标，不会拿旧频道的
   * 游标去问新频道（那样会直接返回空，然后永远读不到新频道的历史消息）。 */
  function memoFor(topic) {
    var key = String(topic || '');
    if (!memo[key]) { memo[key] = { id: null, cursor: null, snap: null }; }
    return memo[key];
  }

  function shallowCopy(src) {
    var copy = {};
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) { copy[k] = src[k]; }
    }
    return copy;
  }

  /* 把缓存里的快照标成「这是上次读到的」后交出去。
   * 必须复制而不是就地改：同一个对象会被 state.snapshot 等多处引用，
   * 就地改会让 UI 以为数据是刚拿到的。 */
  function staleMemo(mem, summary, topic, cause) {
    var copy = shallowCopy(mem.snap);
    copy.public_feed_topic = topic;
    if (summary) { copy.public_feed_summary = summary; }
    if (cause) { copy.public_feed_error = cause.message || String(cause); }
    return copy;
  }

  /* 只拿摘要（极轻量：1 次请求，用于启动时先显示全校数字） */
  function fetchSummary(topic, opts) {
    var o = opts || {};
    return fetchMessages(topic, o).then(function (msgs) {
      var summary = parseSummary(msgs);
      if (!summary) { throw new FeedError('empty', '公共频道里没有摘要', {}); }
      return summary;
    });
  }

  SHZU.publicFeed = {
    FeedError: FeedError,
    isThrottled: isThrottled,
    /* 默认频道。改这里必须与 sniffer/publish.py 的 DEFAULT_TOPIC 一致，
     * 同时要重打 APK（APK 内嵌副本自带这个常量）。 */
    topic: 'shzu-charger-7f3a9c2e',
    ntfy: 'https://ntfy.sh',
    fetchSnapshot: fetchSnapshot,
    fetchCloudSnapshot: fetchCloudSnapshot,
    cloudBase: cloudBase,
    fetchSummary: fetchSummary,
    fetchMessages: fetchMessages,
    wireToSnapshot: wireToSnapshot,
    parseNdjson: parseNdjson,
    parseSummary: parseSummary,
    pickLatestAttachment: pickLatestAttachment,
    lastMessageId: lastMessageId,
    campusIdOfStation: campusIdOfStation
  };
})(window);
