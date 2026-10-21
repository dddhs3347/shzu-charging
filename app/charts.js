/* charts.js — 手写 SVG 图表（零依赖、零外部库）
 * 提供：环形图 donut、堆叠横向条形图 stackBar、迷你趋势 sparkline、
 *       历史面积折线图 areaChart（含坐标轴/网格/hover+touch 提示）。
 * 兼容 Chrome 80 级 WebView：不使用可选链以外的过新语法，不使用 CSS :has()。
 */
(function (global) {
  'use strict';

  var U = global.SHZU.util;
  var NS = 'http://www.w3.org/2000/svg';
  var uid = 0;

  function svgEl(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (!attrs.hasOwnProperty(k)) { continue; }
        var v = attrs[k];
        if (v === null || v === undefined) { continue; }
        n.setAttribute(k, v);
      }
    }
    return n;
  }
  function svgText(x, y, text, cls, anchor) {
    var t = svgEl('text', { x: x, y: y, class: cls || 'c-axis' });
    if (anchor) { t.setAttribute('text-anchor', anchor); }
    t.textContent = text;
    return t;
  }
  function fmtPctShort(r) { return Math.round(r * 100) + '%'; }

  /* ============================================================
   * 环形图：状态分布（free / busy / offline / unknown）
   * opts: { size, thickness, totals, centerLabel, centerSub }
   * ============================================================ */
  function donut(opts) {
    var o = opts || {};
    var size = o.size || 132;
    var thickness = o.thickness || 14;
    var t = o.totals || { total: 0, free: 0, busy: 0, offline: 0, unknown: 0 };
    var total = t.total || 0;

    var vb = 100;
    var r = (vb - thickness) / 2;   // 半径（viewBox 坐标）
    var cx = vb / 2, cy = vb / 2;
    var C = 2 * Math.PI * r;

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + vb + ' ' + vb,
      class: 'donut-svg',
      width: size, height: size,
      role: 'img',
      'aria-label': '空闲率环形图'
    });

    // 底环
    svg.appendChild(svgEl('circle', {
      cx: cx, cy: cy, r: r, fill: 'none',
      'stroke-width': thickness,
      class: 'donut-track'
    }));

    var order = ['free', 'busy', 'offline', 'unknown'];
    var segs = [];

    if (total > 0) {
      var offset = 0;
      for (var i = 0; i < order.length; i++) {
        var key = order[i];
        var val = U.num(t[key]);
        if (val <= 0) { continue; }
        var frac = val / total;
        var len = Math.max(0, C * frac - (frac < 1 ? 1.2 : 0)); // 段间留细缝
        var seg = svgEl('circle', {
          cx: cx, cy: cy, r: r, fill: 'none',
          'stroke-width': thickness,
          'stroke-linecap': 'butt',
          'stroke-dasharray': '0 ' + C.toFixed(2),
          'stroke-dashoffset': '0',
          transform: 'rotate(-90 ' + cx + ' ' + cy + ')',
          class: 'donut-seg seg-' + key
        });
        seg.setAttribute('data-len', len.toFixed(2));
        seg.setAttribute('data-off', offset.toFixed(2));
        seg.setAttribute('data-c', C.toFixed(2));
        seg.style.stroke = (global.SHZU.status[key] || {}).color || '#525a68';
        svg.appendChild(seg);
        segs.push(seg);
        offset += C * frac;
      }
    }

    // 中心文字
    // 注意：这里的比率必须和 hero 上的「空闲率」pill 用同一口径
    // （契约 free_ratio = free / (total - unknown)），否则会出现
    // 环中心写 47%、旁边写 50.0% 的自相矛盾。
    var denom = total - U.num(t.unknown);
    var freeRatio = denom > 0 ? (U.num(t.free) / denom) : 0;
    var centerMain = (o.centerLabel !== undefined) ? o.centerLabel
      : (total > 0 ? String(U.num(t.free)) : '—');
    var centerSub = (o.centerSub !== undefined) ? o.centerSub
      : (total > 0 ? '空闲率 ' + U.pct(freeRatio, 1) : '暂无数据');

    var g = svgEl('g', { class: 'donut-center' });
    var t1 = svgEl('text', {
      x: cx, y: cy - 3, 'text-anchor': 'middle', class: 'donut-main'
    });
    t1.textContent = centerMain;
    g.appendChild(t1);
    var t2 = svgEl('text', {
      x: cx, y: cy + 15, 'text-anchor': 'middle', class: 'donut-sub'
    });
    t2.textContent = centerSub;
    g.appendChild(t2);
    svg.appendChild(g);

    // 入场动画（老 WebView 不支持 rAF 时直接落终值）
    (global.requestAnimationFrame || function (cb) { return setTimeout(cb, 0); })(function () {
      for (var j = 0; j < segs.length; j++) {
        var s = segs[j];
        s.setAttribute('stroke-dasharray', s.getAttribute('data-len') + ' ' + s.getAttribute('data-c'));
        s.setAttribute('stroke-dashoffset', '-' + s.getAttribute('data-off'));
      }
    });

    return svg;
  }

  /* ============================================================
   * 堆叠横向条形图：free 绿 / busy 橙 / offline 灰 / unknown 深灰
   * opts: { totals, height }
   * ============================================================ */
  function stackBar(opts) {
    var o = opts || {};
    var t = o.totals || {};
    var total = U.num(t.total);
    var h = o.height || 8;
    var W = 100;
    var wrap = document.createElement('div');
    wrap.className = 'stackbar';
    wrap.style.height = h + 'px';

    if (total <= 0) {
      var empty = document.createElement('span');
      empty.className = 'stackbar-empty';
      wrap.appendChild(empty);
      return wrap;
    }

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + (h * 4),
      preserveAspectRatio: 'none',
      class: 'stackbar-svg',
      'aria-hidden': 'true'
    });
    var vbH = h * 4;
    var x = 0;
    var keys = ['free', 'busy', 'offline', 'unknown'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = U.num(t[k]);
      if (v <= 0) { continue; }
      var w = (v / total) * W;
      // 保证最后一个可见段至少 0.6 宽度，避免细到看不见
      if (w < 0.6) { w = 0.6; }
      var rect = svgEl('rect', {
        x: x.toFixed(3), y: 0,
        width: w.toFixed(3), height: vbH,
        class: 'stackbar-seg seg-' + k
      });
      rect.style.fill = (global.SHZU.status[k] || {}).color || '#525a68';
      svg.appendChild(rect);
      x += w;
    }
    wrap.appendChild(svg);
    return wrap;
  }

  /* ============================================================
   * 迷你趋势 sparkline（可选）
   * values: [{t, free_ratio}]，按时间升序
   * ============================================================ */

  // 判断一组观测是否值得画迷你趋势：
  // 点数太少（< 4）画不出形状，数值几乎不变（极差 < 1%）画出来只是一根水平细线，
  // 在卡片里会被误读成多余的分隔线/第二根条形图。两种情况都应当整块不画。
  function hasTrend(values) {
    var list = [];
    for (var i = 0; i < (values || []).length; i++) {
      var v = values[i];
      if (v && typeof v.free_ratio === 'number' && isFinite(v.free_ratio)) { list.push(v.free_ratio); }
    }
    if (list.length < 4) { return false; }
    return (Math.max.apply(null, list) - Math.min.apply(null, list)) >= 0.01;
  }

  function sparkline(values, opts) {
    var o = opts || {};
    var W = o.width || 100, H = o.height || 26;
    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      preserveAspectRatio: 'none',
      class: 'spark-svg',
      'aria-hidden': 'true'
    });
    var list = [];
    for (var i = 0; i < (values || []).length; i++) {
      var v = values[i];
      if (v && typeof v.free_ratio === 'number' && isFinite(v.free_ratio)) { list.push(v.free_ratio); }
    }
    if (list.length < 2) { return svg; }

    // 什么情况下不画迷你趋势：
    //  1) 点数 < 4：2~3 个点连起来的直线/折角在卡片里读不出趋势；
    //  2) 数值几乎不变（极差 < 1%）：此时画出来就是一根贯穿卡片的水平细线，
    //     用户会把它当成一条多余的分隔线或第二根条形图，反而误导。
    // 两种情况下都返回空的占位 svg —— 没有趋势就不画，等数据攒出真实波动再出现。
    var min = Math.min.apply(null, list), max = Math.max.apply(null, list);
    if (list.length < 4 || (max - min) < 0.01) {
      svg.setAttribute('class', 'spark-svg is-placeholder');
      return svg;
    }

    // Y 轴范围：以数据为中心上下留白。
    // 不能用固定下限（比如 min(x, 0.2)），否则数据几乎不变时线会被顶到顶部、
    // 下面的渐变填充变成一整块实心色块，看起来像多了一根错误的条形图。
    var span = max - min;
    var padY = Math.max(0.06, span * 0.45);
    var lo = Math.max(0, (min + max) / 2 - Math.max(padY, span / 2 + 0.01));
    var hi = Math.min(1, (min + max) / 2 + Math.max(padY, span / 2 + 0.01));
    if (hi - lo < 0.04) {
      var mid = (lo + hi) / 2;
      lo = Math.max(0, mid - 0.02);
      hi = Math.min(1, mid + 0.02);
      if (hi - lo < 0.04) { lo = Math.max(0, hi - 0.04); }
    }

    var pad = 1.5;
    var n = list.length;
    var pts = [];
    for (var j = 0; j < n; j++) {
      var px = pad + (W - pad * 2) * (j / (n - 1));
      var py = H - pad - (H - pad * 2) * ((list[j] - lo) / (hi - lo));
      pts.push(px.toFixed(2) + ',' + py.toFixed(2));
    }
    var color = o.color || '#35d07f';

    var gid = 'spark-grad-' + (++uid);
    var defs = svgEl('defs', {});
    var grad = svgEl('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '0.42' }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0' }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    // 走到这里说明点数 ≥ 4 且极差 ≥ 1%，可以放心画面积渐变 + 折线
    svg.appendChild(svgEl('path', {
      d: 'M' + pts.join(' L') + ' L' + (W - pad).toFixed(2) + ',' + H + ' L' + pad + ',' + H + ' Z',
      fill: 'url(#' + gid + ')',
      stroke: 'none'
    }));
    svg.appendChild(svgEl('path', {
      d: 'M' + pts.join(' L'),
      fill: 'none',
      stroke: color,
      'stroke-width': 1.4,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
      'vector-effect': 'non-scaling-stroke'
    }));
    return svg;
  }

  /* ============================================================
   * 历史面积折线图
   * points: [{t, free, total, free_ratio}]
   * opts: { height, onEmpty }
   * 返回 DOM 容器（含 svg + tooltip 层）
   * ============================================================ */
  function areaChart(container, points, opts) {
    var o = opts || {};
    var U2 = U;
    var nodes = container;
    nodes.innerHTML = '';

    var list = [];
    var raw = points || [];
    for (var i = 0; i < raw.length; i++) {
      var p = raw[i];
      if (!p || !p.t) { continue; }
      var tms = U2.parseTime(p.t);
      if (tms === null) { continue; }
      var tot = U2.num(p.total);
      var ratio = (typeof p.free_ratio === 'number' && isFinite(p.free_ratio))
        ? p.free_ratio
        : (tot > 0 ? U2.num(p.free) / tot : null);
      list.push({ t: tms, total: tot, free: U2.num(p.free), ratio: (tot > 0 ? ratio : null) });
    }
    list.sort(function (a, b) { return a.t - b.t; });

    var H = o.height || 200;
    var rect = nodes.getBoundingClientRect ? nodes.getBoundingClientRect() : null;
    var W = Math.max(260, Math.floor((rect && rect.width) || (o.width || 340)));

    var padL = 38, padR = 10, padT = 12, padB = 24;
    var innerW = Math.max(10, W - padL - padR);
    var innerH = Math.max(10, H - padT - padB);

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      width: W, height: H,
      class: 'area-svg',
      role: 'img',
      'aria-label': '当前空闲率折线图'
    });

    // 无数据
    if (list.length === 0) {
      svg.appendChild(svgEl('rect', {
        x: padL, y: padT, width: innerW, height: innerH,
        class: 'area-empty-box'
      }));
      svg.appendChild(svgText(W / 2, H / 2, '暂无历史数据', 'c-empty', 'middle'));
      nodes.appendChild(svg);
      return { svg: svg, points: [] };
    }

    // X 轴范围
    var t0 = list[0].t, t1 = list[list.length - 1].t;
    if (t1 === t0) { t1 = t0 + 60 * 1000; }
    var span = t1 - t0;

    // Y 轴范围（自适应，百分比）
    var vals = [];
    for (var q = 0; q < list.length; q++) { if (list[q].ratio !== null) { vals.push(list[q].ratio); } }
    var minV = vals.length ? Math.min.apply(null, vals) : 0;
    var maxV = vals.length ? Math.max.apply(null, vals) : 1;
    var lo = Math.max(0, Math.floor((minV - 0.06) * 10) / 10);
    var hi = Math.min(1, Math.ceil((maxV + 0.06) * 10) / 10);
    if (hi - lo < 0.1) { hi = Math.min(1, lo + 0.1); if (hi - lo < 0.1) { lo = Math.max(0, hi - 0.1); } }
    // 强制 4 等分，保证刻度是 25% 的整数倍不好看；这里用等分即可
    var yTicks = 4;

    function xOf(tms) { return padL + innerW * ((tms - t0) / span); }
    function yOf(ratio) { return padT + innerH * (1 - (ratio - lo) / (hi - lo)); }

    // 网格 + Y 轴刻度
    var gGrid = svgEl('g', { class: 'area-grid' });
    for (var g = 0; g <= yTicks; g++) {
      var yy = padT + innerH * (g / yTicks);
      gGrid.appendChild(svgEl('line', {
        x1: padL, y1: yy.toFixed(2), x2: W - padR, y2: yy.toFixed(2),
        class: 'area-gridline'
      }));
      var tv = lo + (hi - lo) * (1 - g / yTicks);
      gGrid.appendChild(svgText(padL - 6, yy + 3.5, fmtPctShort(tv), 'c-axis', 'end'));
    }
    svg.appendChild(gGrid);

    // X 轴刻度
    var xTicks = W < 360 ? 3 : 4;
    var gX = svgEl('g', { class: 'area-xaxis' });
    for (var xi = 0; xi <= xTicks; xi++) {
      var xv = t0 + span * (xi / xTicks);
      var xn = xOf(xv);
      gX.appendChild(svgEl('line', {
        x1: xn.toFixed(2), y1: padT + innerH, x2: xn.toFixed(2), y2: padT + innerH + 4,
        class: 'area-tick'
      }));
      var anchor = xi === 0 ? 'start' : (xi === xTicks ? 'end' : 'middle');
      gX.appendChild(svgText(xn, padT + innerH + 16,
        U2.fmtAxisTime(xv, span), 'c-axis', anchor));
    }
    svg.appendChild(gX);

    // 折线 + 面积（空档断开）
    var segs = [];
    var cur = [];
    for (var s = 0; s < list.length; s++) {
      if (list[s].ratio === null) {
        if (cur.length) { segs.push(cur); cur = []; }
      } else {
        cur.push(list[s]);
      }
    }
    if (cur.length) { segs.push(cur); }

    var gid = 'area-grad-' + (++uid);
    var defs = svgEl('defs', {});
    var grad = svgEl('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': o.color || '#35d07f', 'stop-opacity': '0.36' }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': o.color || '#35d07f', 'stop-opacity': '0.02' }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    for (var sg = 0; sg < segs.length; sg++) {
      var seg = segs[sg];
      if (!seg.length) { continue; }
      var d = '';
      for (var pi = 0; pi < seg.length; pi++) {
        var px = xOf(seg[pi].t), py = yOf(seg[pi].ratio);
        d += (pi === 0 ? 'M' : 'L') + px.toFixed(2) + ',' + py.toFixed(2);
        if (pi < seg.length - 1) { d += ' '; }
      }
      if (seg.length > 1) {
        var x0 = xOf(seg[0].t).toFixed(2);
        var x1b = xOf(seg[seg.length - 1].t).toFixed(2);
        var baseY = (padT + innerH).toFixed(2);
        svg.appendChild(svgEl('path', {
          d: d + ' L' + x1b + ',' + baseY + ' L' + x0 + ',' + baseY + ' Z',
          fill: 'url(#' + gid + ')', stroke: 'none', class: 'area-fill'
        }));
      }
      svg.appendChild(svgEl('path', {
        d: d, fill: 'none',
        stroke: o.color || '#35d07f',
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        class: 'area-line'
      }));
    }

    // 最后一个点的强调圆点
    var lastPt = list[list.length - 1];
    if (lastPt && lastPt.ratio !== null) {
      svg.appendChild(svgEl('circle', {
        cx: xOf(lastPt.t).toFixed(2), cy: yOf(lastPt.ratio).toFixed(2),
        r: 3.2, class: 'area-dot-last'
      }));
    }

    // 交互层
    var gHover = svgEl('g', { class: 'area-hover', style: 'display:none' });
    var hoverLine = svgEl('line', {
      x1: 0, y1: padT, x2: 0, y2: padT + innerH, class: 'area-hover-line'
    });
    var hoverDot = svgEl('circle', { cx: 0, cy: 0, r: 4, class: 'area-hover-dot' });
    gHover.appendChild(hoverLine);
    gHover.appendChild(hoverDot);
    svg.appendChild(gHover);

    nodes.appendChild(svg);

    // tooltip
    var tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.style.display = 'none';
    nodes.appendChild(tip);

    var activeIdx = -1;

    function nearestIndex(px) {
      var best = -1, bestD = Infinity;
      for (var i2 = 0; i2 < list.length; i2++) {
        if (list[i2].ratio === null) { continue; }
        var d2 = Math.abs(xOf(list[i2].t) - px);
        if (d2 < bestD) { bestD = d2; best = i2; }
      }
      return best;
    }

    function showAt(clientX) {
      var r = svg.getBoundingClientRect();
      if (!r.width) { return; }
      var px = (clientX - r.left) * (W / r.width);
      var idx = nearestIndex(px);
      if (idx < 0) { return; }
      var pt = list[idx];
      var cxp = xOf(pt.t), cyp = yOf(pt.ratio);
      gHover.style.display = '';
      hoverLine.setAttribute('x1', cxp.toFixed(2));
      hoverLine.setAttribute('x2', cxp.toFixed(2));
      hoverDot.setAttribute('cx', cxp.toFixed(2));
      hoverDot.setAttribute('cy', cyp.toFixed(2));

      var body = '<b>' + U2.escapeHtml(U2.fmtDateTime(new Date(pt.t).toISOString())) + '</b>' +
        '<span>当前空闲率 <em>' + fmtPctShort(pt.ratio) + '</em></span>' +
        '<span>' + pt.free + ' / ' + pt.total + ' 空闲</span>';
      tip.innerHTML = body;
      tip.style.display = 'block';
      var scale = r.width / W;
      var left = cxp * scale;
      var top = cyp * scale;
      var tw = tip.offsetWidth || 120;
      tip.style.left = Math.max(2, Math.min(r.width - tw - 2, left - tw / 2)) + 'px';
      tip.style.top = Math.max(0, top - (tip.offsetHeight || 56) - 10) + 'px';
      activeIdx = idx;
    }

    function hide() {
      gHover.style.display = 'none';
      tip.style.display = 'none';
      activeIdx = -1;
    }

    function onMove(ev) {
      var e = ev.touches && ev.touches.length ? ev.touches[0] : ev;
      if (!e) { return; }
      showAt(e.clientX);
      if (ev.type === 'touchmove') { ev.preventDefault(); }
    }

    svg.addEventListener('mousemove', onMove, { passive: true });
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('touchstart', function (ev) { onMove(ev); }, { passive: true });
    svg.addEventListener('touchmove', onMove, { passive: false });
    svg.addEventListener('touchend', function () { setTimeout(hide, 1800); });
    svg.addEventListener('touchcancel', hide);

    return { svg: svg, points: list, showAt: showAt, hide: hide, width: W, height: H, activeIdx: function () { return activeIdx; } };
  }

  global.SHZU.charts = {
    donut: donut,
    stackBar: stackBar,
    sparkline: sparkline,
    hasTrend: hasTrend,
    areaChart: areaChart,
    svgEl: svgEl
  };
})(window);
