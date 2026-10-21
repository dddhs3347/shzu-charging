/* config.js — 全局配置、relay 地址解析、六校区常量
 * 纯静态、零依赖。任何构建步骤都不需要。
 *
 * 数据来源（按顺序尝试，由 app.js 的 loadSnapshot 执行）：
 *   1. 公共频道（ntfy.sh）——「别人装上就能看」靠它，无需任何配置
 *   2. relay（局域网 / 同源）—— 自己人在校园网内直连，数据最新
 *   3. Service Worker 缓存 / localStorage —— 离线兜底
 *
 * relay 地址解析优先级（高 → 低）：
 *   1. URL 查询参数 ?relay=http://192.168.1.5:8080
 *   2. localStorage["shzu.relay"]（APK 壳 / 设置页写入）
 *   3. 同源（相对路径，即 "" —— 由 relay 直接托管本目录时使用）
 * 解析结果写入 window.SHZU.relay（去掉末尾斜杠）。
 *
 * 公共频道 topic 解析优先级（高 → 低）：
 *   1. URL 查询参数 ?topic=shzu-charger-xxxx
 *   2. localStorage["shzu.topic"]
 *   3. 编译期常量 PUBLIC_TOPIC（重打 APK 才能改）
 */
(function (global) {
  'use strict';

  /* 公共频道默认 topic。必须与 sniffer/publish.py 的 DEFAULT_TOPIC 一致。 */
  var PUBLIC_TOPIC = 'shzu-charger-7f3a9c2e';
  var PUBLIC_NTFY = 'https://ntfy.sh';
  /* 自己的域名（Cloudflare Worker 中转）—— 长期方案，优先于 ntfy。
   *
   * 为什么要换：ntfy.sh 免费版对匿名发布有「每出口 IP 每天 250 条」的硬配额
   * （实测），打光后公共频道整天停更，别人手机上的 App 就停在旧数据上；
   * 而且消息 12 小时过期、附件 3 小时过期。自己的域名没有配额、数据不过期。
   *
   * 留空字符串 = 关闭这条路（退回纯 ntfy 模式）。
   * 这里填的地址必须与 cloudflare/worker.js 部署后绑定的自定义域名一致，
   * 例如 https://api.shzucharge.xyz —— 注意**不要**用 workers.dev 那个
   * 免费子域，实测从国内平板访问它 12 秒超时（和 github.com 一样被阻断）。 */
  var PUBLIC_CLOUD = 'https://api.shzucharge.xyz';

  var STORE_KEY = {
    relay: 'shzu.relay',
    topic: 'shzu.topic',
    cloud: 'shzu.cloud',
    snapshot: 'shzu.cache.snapshot.v1',
    history: 'shzu.cache.history.v1',
    /* 本机自己攒的历史采样（每拿到一次快照记一个点，5 分钟一个槽，留 7 天）。
     * 用于「relay 和云端历史都拿不到」时给历史页兜底 —— 公网域名上没有
     * /api/history，Worker 的环形缓冲又是 10 分钟粒度且新部署时是空的。 */
    samples: 'shzu.samples.v1',
    settings: 'shzu.settings.v1',
    lastOk: 'shzu.lastOk.v1',
    /* 首次使用手册是否已读：'1' = 已读，其它/空 = 没读过，启动时弹手册 */
    guideSeen: 'shzu.guideSeen',
    /* 端口「不可用」反馈计数的本地兜底缓存（断网时仍能显示上次的标记） */
    feedback: 'shzu.feedback',
    /* 本机匿名标识：首次启动生成一次，之后一直复用。
     * 用途是服务端「同一端口每人只能反馈一次」的去重键 —— 不带它服务端只能
     * 退化成按出口 IP 去重，而校园网是整栋楼共用一个 NAT，会把别人投过的票
     * 算到你头上。生成规则见 app.js ensureClientId()。 */
    clientId: 'shzu.clientId.v1',
    /* 本机已经反馈过的端口 id 列表（JSON 数组字符串）。
     * 本地先挡一道，避免用户重复点击白跑一次网络；服务端另有一道去重。 */
    feedbackDone: 'shzu.feedbackDone.v1',
    /* 被风控惩罚的截止时间戳（毫秒）。到点前不刷新、不请求数据。 */
    rateLimit: 'shzu.rateLimit.v1',
    /* 最近若干次数据请求的时刻（JSON 数组，毫秒时间戳）。
     * 客户端自己算「一分钟内请求了几次」，见下面的 clientQuotaCheck()。 */
    requestLog: 'shzu.requestLog.v1'
  };

  /* 客户端侧请求配额：**一分钟内最多发 max 次数据请求，超了就地罚 penaltySec 秒**。
   *
   * 为什么非要客户端自己来管（2026-10-21 实测得出的结论，不是防御性冗余）：
   *   1) APK 在局域网里加载的是平板自己的 relay（http://192.168.x.x:8080），
   *      那条路上**根本没有任何限流**，服务端那套规则完全够不着；
   *   2) 即便走公网 Cloudflare，Worker 的计数存在 caches.default 里，而
   *      Cloudflare 会把同一客户端的请求分散到多个机房，各机房各数一份 ——
   *      实测顺序发 15 次一次都拦不住，只有并发才能撞到阈值。
   * 这两条决定了「一分钟限次」只有在客户端强制才算数。服务端那套继续留着，
   * 它挡的是直接打接口的脚本，两者是纵深不是重复。
   *
   * 上限 10 与 worker.js 的 RATE_LIMITS.data.max 一致；惩罚 120 秒与
   * RATE_LIMITS.data.penaltySec 一致，这样用户看到的文案和体验统一。 */
  var CLIENT_QUOTA = { windowSec: 60, max: 20, penaltySec: 120 };

  /* 日志只保留窗口内 + 一点余量，防止 localStorage 无限增长。
   * 留 1.5 倍窗口而不是严格窗口：算 count 时按 now-windowSec 过滤，
   * 存的时候多留一点，避免边界上把还在窗口里的记录剪掉。 */
  function loadRequestLog() {
    var raw = lsGet(STORE_KEY.requestLog);
    if (!raw) { return []; }
    try {
      var arr = JSON.parse(raw);
      if (Object.prototype.toString.call(arr) !== '[object Array]') { return []; }
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var n = Number(arr[i]);
        if (isFinite(n) && n > 0) { out.push(n); }
      }
      return out;
    } catch (e) { return []; }
  }

  function saveRequestLog(list) {
    // 上限 200 条纯属兜底：正常使用永远到不了
    if (list.length > 200) { list = list.slice(list.length - 200); }
    lsSet(STORE_KEY.requestLog, JSON.stringify(list));
  }

  /* 记一次请求并判断是否超限。**调用即消费配额**，返回：
   *   { allowed: true,  count: n, remaining: m }  放行
   *   { allowed: false, count: n, remaining: 0 }  已被罚，不该发请求
   * now 参数只为测试注入，正常调用不传。
   *
   * 注意语义：第 max 次仍然放行（count 变成 max），第 max+1 次才拦。
   * 也就是「一分钟内最多成功发 max 次」。用户 2026-10-21 要求把上限
 * 从十次放宽到二十次（初版是实现时的十次口径）。 */
  function clientQuotaCheck(now) {
    var t = (typeof now === 'number') ? now : Date.now();
    var windowMs = CLIENT_QUOTA.windowSec * 1000;
    var list = loadRequestLog();
    var keep = [];
    for (var i = 0; i < list.length; i++) {
      if (t - list[i] < windowMs) { keep.push(list[i]); }
    }
    var count = keep.length + 1;   // 加上本次
    if (count > CLIENT_QUOTA.max) {
      saveRequestLog(keep);
      return { allowed: false, count: keep.length, remaining: 0 };
    }
    keep.push(t);
    saveRequestLog(keep);
    return { allowed: true, count: count, remaining: CLIENT_QUOTA.max - count };
  }

  /* 还剩几次可发（只读，不消费配额）。给 UI 提示用。 */
  function clientQuotaRemaining(now) {
    var t = (typeof now === 'number') ? now : Date.now();
    var windowMs = CLIENT_QUOTA.windowSec * 1000;
    var list = loadRequestLog();
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (t - list[i] < windowMs) { n++; }
    }
    var left = CLIENT_QUOTA.max - n;
    return left > 0 ? left : 0;
  }

  /* 清空配额记录。进入惩罚期时调：两分钟后恢复时应当是**全新的一分钟窗口**，
   * 否则刚解锁就又超限，用户永远出不来。 */
  function clientQuotaReset() {
    lsDel(STORE_KEY.requestLog);
  }

  /* 「其他用户提交不可用」达到这个次数后，该端口在 UI 上按不可用/离线处理。
   * ⚠️ 必须与 cloudflare/worker.js 里的 FEEDBACK_THRESHOLD 保持一致，
   *    否则会出现「云端已经不再计入、App 还在标记」或者反过来的错位。 */
  var FEEDBACK_THRESHOLD = 20;

  /* 六校区固定顺序与主题色（与 shared/campus.json 的 order / id 对齐）。
   * 颜色只用于图表与徽标描边，保证深色背景下对比度足够。 */
  var CAMPUSES = [
    { id: 'zhongqu', name: '中区', order: 1, short: '中', color: '#4f9cff' },
    { id: 'beiqu', name: '北区', order: 2, short: '北', color: '#54d6a0' },
    { id: 'dongqu', name: '东区', order: 3, short: '东', color: '#ffb84d' },
    { id: 'beiyuan', name: '北苑新区', order: 4, short: '苑', color: '#c084fc' },
    { id: 'nanqu', name: '南区', order: 5, short: '南', color: '#ff7a8a' },
    { id: 'jiangjunshan', name: '将军山校区', order: 6, short: '将', color: '#38d9d9' }
  ];

  /* 状态色：free 绿 / busy 橙红 / offline 灰 / unknown 深灰 */
  var STATUS = {
    free: { label: '空闲', color: '#35d07f', dim: 'rgba(53,208,127,.16)' },
    busy: { label: '占用', color: '#ff8a4c', dim: 'rgba(255,138,76,.16)' },
    offline: { label: '离线', color: '#8b93a3', dim: 'rgba(139,147,163,.16)' },
    unknown: { label: '未知', color: '#525a68', dim: 'rgba(82,90,104,.16)' }
  };

  var DEFAULTS = {
    // 默认 15 秒：与平板侧源 A 的采集节奏对齐（源 A 每 15 秒一轮、耗时约 5.3 秒）。
    // 以前是 60 秒，那样即使采集端快了，App 还是一分钟才刷一次，等于白优化。
    // 下限 10 秒（loadSettings 的校验），15 在合法区间内。
    refreshSeconds: 15,     // 自动刷新间隔（可配）
    requestTimeoutMs: 9000, // 单请求超时（公共频道 / 历史曲线等「重」请求）
    /* relay（局域网）专用超时：比通用超时短得多。
     * 为什么单独一条：APK 打开时先试局域网 relay（192.168.1.119:8080），
     * 不在同一个 WiFi 里就是连不上。用 9 秒等一个必然失败的请求，用户开局
     * 要盯着骨架屏干等 9 秒才看到公共频道的数据。4 秒足够校园网内的 relay
     * 应答，超时立刻转公共频道。
     * 注意：**只对 relay 的请求生效**，公共频道仍走 requestTimeoutMs。 */
    relayTimeoutMs: 4000,
    staleMinutes: 15,       // 与契约 §2 一致：now - data_at > 15min 视为 stale
    historyHours: 24,
    historyCampus: 'all',
    maxHistoryPoints: 400
  };

  var HISTORY_RANGES = [
    { hours: 6, label: '6 小时', bucket: '1m' },
    { hours: 24, label: '24 小时', bucket: '10m' },
    { hours: 168, label: '7 天', bucket: '30m' }
  ];

  function trimSlash(s) { return String(s || '').replace(/\/+$/, ''); }

  function readQueryRelay() {
    try {
      var m = /[?&]relay=([^&#]*)/.exec(global.location.search || '');
      if (!m) { return ''; }
      var raw = decodeURIComponent(m[1]);
      if (!raw) { return ''; }
      // 允许 ?relay=192.168.1.5:8080 这种省略协议头的写法
      if (!/^https?:\/\//i.test(raw)) { raw = 'http://' + raw; }
      return trimSlash(raw);
    } catch (e) { return ''; }
  }

  function lsGet(key) {
    try { return global.localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }
  function lsSet(key, val) {
    try { global.localStorage.setItem(key, val); return true; } catch (e) { return false; }
  }
  function lsDel(key) {
    try { global.localStorage.removeItem(key); } catch (e) {}
  }

  function resolveRelay() {
    var fromQuery = readQueryRelay();
    if (fromQuery) {
      // URL 参数是"临时覆盖"：同步落盘，方便直接分享链接给平板
      lsSet(STORE_KEY.relay, fromQuery);
      return { url: fromQuery, source: 'query' };
    }
    var stored = trimSlash(lsGet(STORE_KEY.relay));
    /* localStorage 里的 relay 地址是**上一个人/上一次配置**留下的，
     * 在 APK 里它会永久存活并盖掉 MainActivity 的决定：
     *   平板上配过一次 192.168.1.119:8080 → 别人把 APK 装到手机（走 5G，
     *   根本不在那个局域网）→ 手机上启动时没有 ?relay= 参数，config.js 却读到
     *   localStorage 里那条 → app.js 的 preferRelay 判成 true → 先去连一个
     *   必然不可达的局域网地址，每轮白等一次超时，用户看到的是
     *   「网络不可达」而不是公共频道里现成的数据。
     * file:// 源（= APK 内置 UI）没有同源可用地址，此时 storage 里的值
     * 不代表当前用户的选择，直接丢弃；http(s) 页面是用户自己在浏览器里
     * 配的，保留。 */
    if (stored && isFileOrigin()) {
      lsDel(STORE_KEY.relay);
      return { url: '', source: 'file-origin' };
    }
    if (stored) { return { url: stored, source: 'storage' }; }
    return { url: '', source: 'same-origin' };
  }

  function isFileOrigin() {
    try { return String(global.location.protocol || '') === 'file:'; }
    catch (e) { return false; }
  }

  /* topic 只允许这些字符：ntfy 的 topic 规则是 [-_A-Za-z0-9]{1,64} */
  var TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

  function validTopic(s) {
    return TOPIC_RE.test(String(s || ''));
  }

  function readQueryTopic() {
    try {
      var m = /[?&]topic=([^&#]*)/.exec(global.location.search || '');
      if (!m) { return ''; }
      var raw = decodeURIComponent(m[1]).replace(/^\/+|\/+$/g, '');
      return validTopic(raw) ? raw : '';
    } catch (e) { return ''; }
  }

  function resolveTopic() {
    var fromQuery = readQueryTopic();
    if (fromQuery) {
      lsSet(STORE_KEY.topic, fromQuery);
      return { topic: fromQuery, source: 'query' };
    }
    var stored = lsGet(STORE_KEY.topic);
    if (validTopic(stored)) { return { topic: stored, source: 'storage' }; }
    return { topic: PUBLIC_TOPIC, source: 'default' };
  }

  /* 云中转地址只接受 http(s)，且必须是 host[:port][/path] 形态。
   * 末尾斜杠统一去掉 —— 拼接 /snapshot 时不再判断，少一类低级 bug。 */
  var CLOUD_RE = /^https?:\/\/[A-Za-z0-9._:\-]+(\/[A-Za-z0-9._\-\/]*)?$/;

  function validCloud(s) {
    var v = String(s || '').replace(/\s+/g, '');
    v = v.replace(/\/+$/, '');
    if (!v) { return ''; }
    return CLOUD_RE.test(v) ? v : '';
  }

  function readQueryCloud() {
    try {
      var m = /[?&]cloud=([^&#]*)/.exec(global.location.search || '');
      if (!m) { return ''; }
      var raw = String(decodeURIComponent(m[1])).replace(/\s+/g, '');
      /* ?cloud=off 是「本次明确不用云中转」，测试脚本和排障时都要用：
       * 探针要验 ntfy 那条路，就绝不能让它先被云中转抢走。 */
      if (raw === 'off' || raw === '0' || raw === 'none') { return 'off'; }
      return validCloud(raw);
    } catch (e) { return ''; }
  }

  /* 用根域名直接打开 App 时（https://shzucharge.xyz/…），云中转就在同一个
   * 源上：Worker 的 /snapshot、/feedback 都挂在根路径。这时用 location.origin
   * 既省掉一次跨域预检，也不会因为硬编码 api. 子域写错而白屏。
   * 只在 hostname 真的以 shzucharge.xyz 结尾时命中，本地 http.server /
   * 127.0.0.1 / file: 等场景都不受影响。 */
  function sameOriginCloud() {
    try {
      var loc = global.location || {};
      var proto = String(loc.protocol || '');
      var host = String(loc.hostname || '');
      if (proto !== 'http:' && proto !== 'https:') { return ''; }
      if (!/(^|\.)shzucharge\.xyz$/i.test(host)) { return ''; }
      return trimSlash(String(loc.origin || (proto + '//' + loc.host)));
    } catch (e) { return ''; }
  }

  /* 优先级：URL 参数 → localStorage → 同源（根域名） → 编译期常量 → 关闭。
   * localStorage 里存 "off" 表示「用户主动关掉了这条路」，要和「没配过」
   * 区分开，否则关掉之后下次启动又会被编译期常量打开。 */
  function resolveCloud() {
    var fromQuery = readQueryCloud();
    if (fromQuery === 'off') {
      lsSet(STORE_KEY.cloud, 'off');
      return { url: '', source: 'query-off' };
    }
    if (fromQuery) {
      lsSet(STORE_KEY.cloud, fromQuery);
      return { url: fromQuery, source: 'query' };
    }
    var raw = lsGet(STORE_KEY.cloud);
    if (raw === 'off') { return { url: '', source: 'storage-off' }; }
    var stored = validCloud(raw);
    if (stored) { return { url: stored, source: 'storage' }; }
    var same = sameOriginCloud();
    if (same) { return { url: same, source: 'same-origin' }; }
    var def = validCloud(PUBLIC_CLOUD);
    if (def) { return { url: def, source: 'default' }; }
    return { url: '', source: 'none' };
  }

  function apiUrl(path) {
    return trimSlash(global.SHZU.relay) + path;
  }

  function loadSettings() {
    var out = {};
    for (var k in DEFAULTS) { if (DEFAULTS.hasOwnProperty(k)) { out[k] = DEFAULTS[k]; } }
    var raw = lsGet(STORE_KEY.settings);
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.refreshSeconds === 'number' &&
              parsed.refreshSeconds >= 10 && parsed.refreshSeconds <= 600) {
            out.refreshSeconds = Math.round(parsed.refreshSeconds);
          }
          if (typeof parsed.historyHours === 'number') { out.historyHours = parsed.historyHours; }
          if (typeof parsed.historyCampus === 'string') { out.historyCampus = parsed.historyCampus; }
        }
      } catch (e) {}
    }
    return out;
  }

  function saveSettings(patch) {
    var cur = loadSettings();
    for (var k in patch) { if (patch.hasOwnProperty(k)) { cur[k] = patch[k]; } }
    lsSet(STORE_KEY.settings, JSON.stringify(cur));
    return cur;
  }

  /* ===================== 本机匿名标识 =====================
   *
   * 用途：服务端「同一端口每人只能反馈一次」的去重键，以及 App 侧记住
   * 「我投过这个端口了」。
   *
   * 为什么不用别的：
   *   - 不能用 IP —— 校园网是整栋楼共用一个 NAT 出口，按 IP 去重会把
   *     别人投过的票算到你头上，直接废掉这个功能。
   *   - 不能用设备指纹 —— 要么算不准（隐私模式/清缓存就变），
   *     要么像 FingerprintJS 那样收集一堆特征，对这个小工具没必要。
   *   - 就用一个随机串存 localStorage，清了就变新的，代价只是「清缓存后
   *     能再投一次」，可以接受。
   *
   * 格式：`c` + 24 位 hex（共 25 字符），满足服务端 validClientId 的
   * 8~64 位 [A-Za-z0-9_.:-] 要求。生成优先用 crypto.getRandomValues，
   * 老 WebView 没有的话退回 Math.random（够用，不是安全场景）。 */
  function randomHex(len) {
    var out = '';
    var i;
    try {
      var c = global.crypto || global.msCrypto;
      if (c && typeof c.getRandomValues === 'function') {
        var buf = new Uint8Array(Math.ceil(len / 2));
        c.getRandomValues(buf);
        for (i = 0; i < buf.length; i++) {
          var h = buf[i].toString(16);
          out += h.length < 2 ? '0' + h : h;
        }
        return out.slice(0, len);
      }
    } catch (e) { /* 落到下面的 Math.random */ }
    for (i = 0; i < len; i++) { out += Math.floor(Math.random() * 16).toString(16); }
    return out;
  }

  function ensureClientId() {
    var cur = lsGet(STORE_KEY.clientId);
    if (/^[A-Za-z0-9_.:-]{8,64}$/.test(cur)) { return cur; }
    var id = 'c' + randomHex(24);
    lsSet(STORE_KEY.clientId, id);
    return id;
  }

  /* 本机已经反馈过的端口（device_id）列表。
   * 存成 JSON 数组字符串；读坏了就当空数组，绝不抛异常 ——
   * 这只是个「省一次网络请求」的本地缓存，不是业务数据。 */
  function loadFeedbackDone() {
    var raw = lsGet(STORE_KEY.feedbackDone);
    if (!raw) { return []; }
    try {
      var arr = JSON.parse(raw);
      if (Object.prototype.toString.call(arr) !== '[object Array]') { return []; }
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        if (typeof arr[i] === 'string' && arr[i]) { out.push(arr[i]); }
      }
      // 只保留最近 500 条：一个人不可能对 500 个不同端口投过票，
      // 留太多会让 localStorage 值无限增长。
      return out.length > 500 ? out.slice(out.length - 500) : out;
    } catch (e) { return []; }
  }

  function markFeedbackDone(deviceId) {
    var id = String(deviceId || '');
    if (!id) { return loadFeedbackDone(); }
    var list = loadFeedbackDone();
    if (list.indexOf(id) < 0) { list.push(id); }
    if (list.length > 500) { list = list.slice(list.length - 500); }
    lsSet(STORE_KEY.feedbackDone, JSON.stringify(list));
    return list;
  }

  function hasFeedbackDone(deviceId) {
    return loadFeedbackDone().indexOf(String(deviceId || '')) >= 0;
  }

  /* 风控惩罚截止时间（毫秒时间戳）。0 = 没被罚。
   * 存盘是为了「用户在被罚期间关掉 App 再打开」也不会立刻又去撞墙 ——
   * 否则重开一次就又发一轮请求，正好把惩罚期续上，永远好不了。 */
  function rateLimitUntil() {
    var raw = lsGet(STORE_KEY.rateLimit);
    if (!raw) { return 0; }
    var n = parseInt(raw, 10);
    if (!isFinite(n) || n <= 0) { return 0; }
    return n > Date.now() ? n : 0;
  }

  function setRateLimitUntil(ms) {
    var n = Math.floor(Number(ms) || 0);
    if (!(n > Date.now())) { n = 0; }
    if (n) { lsSet(STORE_KEY.rateLimit, String(n)); } else { lsDel(STORE_KEY.rateLimit); }
    return n;
  }

  var resolved = resolveRelay();
  var resolvedTopic = resolveTopic();
  var resolvedCloud = resolveCloud();

  global.SHZU = {
    version: '1.0.0',
    storeKey: STORE_KEY,
    campuses: CAMPUSES,
    status: STATUS,
    defaults: DEFAULTS,
    historyRanges: HISTORY_RANGES,
    /* 「其他用户提交不可用」达到该次数即视为不可用（须与 cloudflare/worker.js 一致） */
    feedbackThreshold: FEEDBACK_THRESHOLD,
    relay: resolved.url,
    relaySource: resolved.source,
    /* 公共频道（ntfy.sh）——「别人装上就能看」的数据来源，无需任何配置 */
    publicTopic: resolvedTopic.topic,
    publicTopicSource: resolvedTopic.source,
    /* 编译期内置默认频道：设置页「恢复默认」用它，不受运行时改写影响 */
    defaultTopic: PUBLIC_TOPIC,
    publicNtfy: PUBLIC_NTFY,
    /* 自己的域名（Cloudflare Worker）。空字符串 = 不用这条路。 */
    publicCloud: resolvedCloud.url,
    publicCloudSource: resolvedCloud.source,
    /* 编译期内置默认云地址：设置页「恢复默认」用它 */
    defaultCloud: validCloud(PUBLIC_CLOUD),
    validCloud: validCloud,
    resolveCloud: resolveCloud,
    validTopic: validTopic,
    resolveTopic: resolveTopic,
    apiUrl: apiUrl,
    resolveRelay: resolveRelay,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    lsGet: lsGet,
    lsSet: lsSet,
    lsDel: lsDel,
    /* 本机匿名标识 / 反馈去重 / 风控惩罚期（详见上面各函数注释） */
    ensureClientId: ensureClientId,
    loadFeedbackDone: loadFeedbackDone,
    markFeedbackDone: markFeedbackDone,
    hasFeedbackDone: hasFeedbackDone,
    rateLimitUntil: rateLimitUntil,
    setRateLimitUntil: setRateLimitUntil,
    /* 客户端侧「一分钟最多 20 次数据请求」配额（服务端/relay 都靠不住时的兜底，
     * 详见上面 CLIENT_QUOTA 的注释） */
    clientQuota: CLIENT_QUOTA,
    clientQuotaCheck: clientQuotaCheck,
    clientQuotaRemaining: clientQuotaRemaining,
    clientQuotaReset: clientQuotaReset,
    loadRequestLog: loadRequestLog,
    trimSlash: trimSlash
  };
})(window);
