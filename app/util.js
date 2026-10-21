/* util.js — 无依赖工具函数（兼容 Chrome 80 级 WebView：ES5 + 少量 ES6 语法） */
(function (global) {
  'use strict';

  var SHZU = global.SHZU;

  /* ---------- DOM ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!attrs.hasOwnProperty(k)) { continue; }
        var v = attrs[k];
        if (v === null || v === undefined || v === false) { continue; }
        if (k === 'class') { node.className = v; }
        else if (k === 'text') { node.textContent = v; }
        else if (k === 'html') { node.innerHTML = v; }
        else if (k === 'dataset') {
          for (var d in v) { if (v.hasOwnProperty(d)) { node.setAttribute('data-' + d, v[d]); } }
        } else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else { node.setAttribute(k, v); }
      }
    }
    if (children) {
      var list = Object.prototype.toString.call(children) === '[object Array]' ? children : [children];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c === null || c === undefined || c === false) { continue; }
        node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      }
    }
    return node;
  }

  /* ---------- 数字 / 百分比 ---------- */
  function pct(ratio, digits) {
    if (typeof ratio !== 'number' || !isFinite(ratio)) { return '—'; }
    var d = (digits === undefined) ? 1 : digits;
    return (ratio * 100).toFixed(d) + '%';
  }
  function ratio(free, total) {
    if (!total || total <= 0) { return 0; }
    return free / total;
  }
  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  /* ---------- 时间 ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function parseTime(iso) {
    if (!iso) { return null; }
    var t = Date.parse(iso);
    return isNaN(t) ? null : t;
  }

  function fmtClock(iso) {
    var t = parseTime(iso);
    if (t === null) { return '—'; }
    var d = new Date(t);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtDateTime(iso) {
    var t = parseTime(iso);
    if (t === null) { return '—'; }
    var d = new Date(t);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtAxisTime(ms, spanMs) {
    var d = new Date(ms);
    var day = (d.getMonth() + 1) + '/' + d.getDate();
    var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (spanMs > 36 * 3600 * 1000) { return day; }
    return hm;
  }

  function fmtAgo(iso) {
    var t = parseTime(iso);
    if (t === null) { return '—'; }
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 0) { s = 0; }
    if (s < 10) { return '刚刚'; }
    if (s < 60) { return s + ' 秒前'; }
    if (s < 3600) { return Math.floor(s / 60) + ' 分钟前'; }
    if (s < 86400) { return Math.floor(s / 3600) + ' 小时前'; }
    return Math.floor(s / 86400) + ' 天前';
  }

  function fmtDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) { return null; }
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h > 0) { return h + ' 小时 ' + m + ' 分'; }
    if (m > 0) { return m + ' 分钟'; }
    return s + ' 秒';
  }

  /* ---------- 校区 ---------- */
  function campusMeta(id) {
    var list = SHZU.campuses;
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
    return null;
  }
  function campusName(id) {
    var m = campusMeta(id);
    if (m) { return m.name; }
    if (id === 'all') { return '全校'; }
    if (id === '_unassigned') { return '未归类'; }
    return id || '未知校区';
  }
  function campusColor(id) {
    var m = campusMeta(id);
    return m ? m.color : '#7d8798';
  }
  function statusMeta(s) {
    return SHZU.status[s] || SHZU.status.unknown;
  }

  /* 六校区固定顺序：按 config.js 里 CAMPUSES 的顺序，缺失的补 0 值占位。
   * 契约规定 relay 必须返回 6 项，这里仍做防御式补齐，避免 UI 缺卡。 */
  function normalizeCampuses(rawCampuses) {
    var byId = {};
    var extra = [];
    var list = rawCampuses || [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || !c.id) { continue; }
      if (campusMeta(c.id)) { byId[c.id] = c; } else { extra.push(c); }
    }
    var out = [];
    for (var j = 0; j < SHZU.campuses.length; j++) {
      var meta = SHZU.campuses[j];
      var c2 = byId[meta.id];
      out.push(c2 ? c2 : {
        id: meta.id, name: meta.name, order: meta.order,
        totals: { total: 0, free: 0, busy: 0, offline: 0, unknown: 0, free_ratio: 0 },
        stations: []
      });
    }
    // _unassigned 等虚拟区放在最后
    for (var k = 0; k < extra.length; k++) { out.push(extra[k]); }
    return out;
  }

  function zeroTotals() {
    return { total: 0, free: 0, busy: 0, offline: 0, unknown: 0, free_ratio: 0 };
  }
  function totalsOf(obj) {
    var t = (obj && obj.totals) || {};
    var total = num(t.total), free = num(t.free), busy = num(t.busy),
        offline = num(t.offline), unknown = num(t.unknown);
    var denom = total - unknown;
    return {
      total: total, free: free, busy: busy, offline: offline, unknown: unknown,
      free_ratio: denom > 0 ? free / denom : 0
    };
  }
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

  /* 由设备列表重算 totals（站点/桩数据缺失时的兜底，不伪造：== 实数统计） */
  function totalsFromDevices(devices) {
    var t = zeroTotals();
    var list = devices || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i] && list[i].status;
      if (s === 'free') { t.free++; }
      else if (s === 'busy') { t.busy++; }
      else if (s === 'offline') { t.offline++; }
      else { t.unknown++; }
      t.total++;
    }
    var denom = t.total - t.unknown;
    t.free_ratio = denom > 0 ? t.free / denom : 0;
    return t;
  }

  function deviceCode(dev, idx) {
    if (dev && dev.code) { return String(dev.code); }
    if (dev && dev.name) { return String(dev.name); }
    if (dev && dev.id) {
      var m = /-(\d+)$/.exec(dev.id);
      if (m) { return m[1]; }
      return String(dev.id);
    }
    return String(idx + 1);
  }

  /* ---------- 其他 ---------- */
  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }
  var raf = global.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
  var caf = global.cancelAnimationFrame || function (id) { clearTimeout(id); };

  global.SHZU.util = {
    $: $, $$: $$, el: el,
    pct: pct, ratio: ratio, clamp: clamp, num: num,
    parseTime: parseTime, fmtClock: fmtClock, fmtDateTime: fmtDateTime,
    fmtAxisTime: fmtAxisTime, fmtAgo: fmtAgo, fmtDuration: fmtDuration,
    campusMeta: campusMeta, campusName: campusName, campusColor: campusColor,
    statusMeta: statusMeta, normalizeCampuses: normalizeCampuses,
    zeroTotals: zeroTotals, totalsOf: totalsOf, totalsFromDevices: totalsFromDevices,
    deviceCode: deviceCode,
    escapeHtml: escapeHtml, debounce: debounce, raf: raf, caf: caf
  };
})(window);
