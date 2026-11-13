/* Canvas charts (STEP 8). Home line, Coin candles, Analyst score ring.
   Drawn by hand on <canvas>, devicePixelRatio aware. No chart library. */
(function (global) {
  "use strict";

  var GREEN = "#00d35a";
  var RED = "#ff453a";
  var ORANGE = "#ff9f0a";
  var TRACK = "#2c2c2e";
  var SECONDARY = "rgba(235,235,245,0.6)";
  var TERTIARY = "rgba(235,235,245,0.3)";
  var BLUE = "#0a84ff";
  var YELLOW = "#ffd60a";

  function reduced() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {
      return false;
    }
  }

  function setup(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, rect.width);
    var h = Math.max(1, rect.height);
    var bw = Math.round(w * dpr);
    var bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h, dpr: dpr };
  }

  function parseT(t) {
    if (t == null) return 0;
    var ms = Date.parse(t);
    return isFinite(ms) ? ms : 0;
  }

  /* ----- Home line -----
     Green stroke, gradient fill under the line, dashed line at start.
     New point slides in over 250ms; marks fade in over 200ms.
     Marks never overlap: a later mark moves up a row. */
  var lineAnim = { key: "", from: 0, t0: 0 };

  function drawLine(canvas, opts) {
    if (!canvas) return;
    opts = opts || {};
    var s = setup(canvas);
    var ctx = s.ctx, w = s.w, h = s.h;
    var points = (opts.points || []).filter(function (p) {
      return p && p.v != null && isFinite(Number(p.v)) && p.t;
    });
    var start = opts.start;
    var marks = opts.marks || [];
    var empty = !!opts.empty;
    var padL = 16, padR = 16, padT = 36, padB = 18;
    var iw = Math.max(1, w - padL - padR);
    var ih = Math.max(1, h - padT - padB);

    var vals = points.map(function (p) { return Number(p.v); });
    if (start != null && isFinite(Number(start))) vals.push(Number(start));
    var vmin = vals.length ? Math.min.apply(null, vals) : 0;
    var vmax = vals.length ? Math.max.apply(null, vals) : 1;
    if (vmax - vmin < 1e-9) {
      vmin -= 1;
      vmax += 1;
    }
    // A little headroom so the line isn't on the edge.
    var span = vmax - vmin;
    vmin -= span * 0.08;
    vmax += span * 0.08;

    function yOf(v) {
      return padT + ih * (1 - (Number(v) - vmin) / (vmax - vmin));
    }
    function xOf(i, n, t) {
      if (n <= 1) return padL + iw / 2;
      return padL + (iw * i) / (n - 1);
    }

    // Time-based x if we have timestamps spanning a range.
    var times = points.map(function (p) { return parseT(p.t); });
    var t0 = times.length ? Math.min.apply(null, times) : 0;
    var t1 = times.length ? Math.max.apply(null, times) : 1;
    function xAt(i, t) {
      if (t1 > t0 && t) {
        return padL + iw * ((parseT(t) - t0) / (t1 - t0));
      }
      return xOf(i, points.length, t);
    }

    // Dashed start line — always, including the empty state.
    if (start != null && isFinite(Number(start))) {
      var ys = yOf(Number(start));
      ctx.save();
      ctx.strokeStyle = TERTIARY;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, ys);
      ctx.lineTo(padL + iw, ys);
      ctx.stroke();
      ctx.restore();
    }

    if (empty || points.length === 0) return;

    // Slide the newest point in over 250ms.
    var n = points.length;
    var last = points[n - 1];
    var lastX = xAt(n - 1, last.t);
    var lastY = yOf(last.v);
    var key = (last.t || "") + ":" + String(last.v);
    var now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    var slide = 1;
    if (!reduced() && opts.animate !== false) {
      if (lineAnim.key !== key) {
        // If we already had a previous last point, slide from its x.
        var prevX = lineAnim.key ? (lineAnim.from || lastX - 16) : lastX;
        lineAnim = { key: key, from: prevX, t0: now };
      }
      var u = Math.min(1, (now - lineAnim.t0) / 250);
      // ease-out
      u = 1 - Math.pow(1 - u, 3);
      slide = u;
      lastX = lineAnim.from + (xAt(n - 1, last.t) - lineAnim.from) * u;
      if (u < 1 && typeof opts.onFrame === "function") {
        requestAnimationFrame(function () { opts.onFrame(); });
      }
    }

    var coords = [];
    for (var i = 0; i < n; i++) {
      var x = xAt(i, points[i].t);
      var y = yOf(points[i].v);
      if (i === n - 1) x = lastX;
      coords.push({ x: x, y: y });
    }

    // Gradient fill under the line (this is the chart, not a card).
    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    for (var j = 1; j < coords.length; j++) ctx.lineTo(coords[j].x, coords[j].y);
    ctx.lineTo(coords[coords.length - 1].x, padT + ih);
    ctx.lineTo(coords[0].x, padT + ih);
    ctx.closePath();
    var grd = ctx.createLinearGradient(0, padT, 0, padT + ih);
    grd.addColorStop(0, "rgba(0, 211, 90, 0.28)");
    grd.addColorStop(1, "rgba(0, 211, 90, 0)");
    ctx.fillStyle = grd;
    ctx.fill();

    // Stroke
    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    for (var k = 1; k < coords.length; k++) ctx.lineTo(coords[k].x, coords[k].y);
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // Marks above the line. Later marks that would overlap move up a row.
    // Fade in over 200ms when the mark set first appears.
    if (!marks.length) return;
    var placed = [];
    var fade = 1;
    if (!reduced()) {
      var markKey = marks.map(function (mk) { return (mk.t || "") + ":" + (mk.label || ""); }).join("|");
      if (drawLine._mk !== markKey) {
        drawLine._mk = markKey;
        drawLine._mkT0 = now;
      }
      fade = Math.min(1, (now - (drawLine._mkT0 || now)) / 200);
      if (fade < 1 && typeof opts.onFrame === "function") {
        requestAnimationFrame(function () { opts.onFrame(); });
      }
    }
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.font = "600 11px 'SF Pro Text', Inter, -apple-system, sans-serif";
    ctx.textBaseline = "bottom";
    for (var m = 0; m < marks.length; m++) {
      var mk = marks[m];
      if (!mk || !mk.t) continue;
      var mx = xAt(0, mk.t);
      // nearest point y
      var my = lastY;
      if (start != null) my = yOf(Number(start));
      for (var pi = 0; pi < points.length; pi++) {
        if (points[pi].t === mk.t) { my = yOf(points[pi].v); break; }
      }
      var label = String(mk.label || "");
      var tw = ctx.measureText(label).width;
      var tx = Math.min(Math.max(padL, mx - tw / 2), padL + iw - tw);
      var ty = my - 8;
      // Push up if overlapping a previous mark.
      var rowH = 14;
      var safety = 0;
      while (safety < 8) {
        var hit = false;
        for (var q = 0; q < placed.length; q++) {
          var pr = placed[q];
          if (Math.abs(pr.y - ty) < rowH && !(tx + tw + 4 < pr.x || pr.x + pr.w + 4 < tx)) {
            hit = true;
            break;
          }
        }
        if (!hit) break;
        ty -= rowH;
        safety++;
      }
      placed.push({ x: tx, y: ty, w: tw });
      var color = mk.color || (mk.kind === "bought" ? BLUE : mk.kind === "stopped" ? RED : GREEN);
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.fillText(label, tx, ty);
    }
    ctx.restore();
  }

  /* ----- Coin candles: 1-minute OHLC, volume bars = change of volume.m5.
     Orange dashed "Risk trailing stop" at the current exit line. */
  function drawCandles(canvas, opts) {
    if (!canvas) return;
    opts = opts || {};
    var s = setup(canvas);
    var ctx = s.ctx, w = s.w, h = s.h;
    var candles = (opts.candles || []).filter(function (c) {
      return c && c.c != null && isFinite(Number(c.c));
    });
    var padL = 16, padR = 16, padT = 16, padB = 8;
    var volH = 44;
    var ih = Math.max(1, h - padT - padB - volH - 8);
    var iw = Math.max(1, w - padL - padR);

    if (!candles.length) {
      ctx.fillStyle = TERTIARY;
      ctx.font = "14px 'SF Pro Text', Inter, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No candles yet", w / 2, h / 2);
      return;
    }

    var highs = candles.map(function (c) { return Number(c.h != null ? c.h : c.c); });
    var lows = candles.map(function (c) { return Number(c.l != null ? c.l : c.c); });
    var vmin = Math.min.apply(null, lows);
    var vmax = Math.max.apply(null, highs);
    var exitPx = opts.exitLine != null ? Number(opts.exitLine) : null;
    if (exitPx != null && isFinite(exitPx)) {
      vmin = Math.min(vmin, exitPx);
      vmax = Math.max(vmax, exitPx);
    }
    if (vmax - vmin < 1e-12) {
      vmin *= 0.99;
      vmax *= 1.01;
      if (vmax === vmin) { vmin -= 1; vmax += 1; }
    }
    var span = vmax - vmin;
    vmin -= span * 0.06;
    vmax += span * 0.06;

    function yOf(v) {
      return padT + ih * (1 - (Number(v) - vmin) / (vmax - vmin));
    }

    var n = candles.length;
    var gap = Math.max(1.5, Math.min(3, iw / n * 0.18));
    var cw = Math.max(3, (iw / n) - gap);

    // A faint close-price path so a series of dojis still reads as a move.
    ctx.beginPath();
    for (var li = 0; li < n; li++) {
      var lx = padL + (iw * (li + 0.5)) / n;
      var ly = yOf(Number(candles[li].c));
      if (li === 0) ctx.moveTo(lx, ly);
      else ctx.lineTo(lx, ly);
    }
    ctx.strokeStyle = "rgba(235, 235, 245, 0.22)";
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    ctx.stroke();

    // Exit line, behind candles (in front of the path).
    if (exitPx != null && isFinite(exitPx)) {
      var ye = yOf(exitPx);
      ctx.save();
      ctx.strokeStyle = ORANGE;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, ye);
      ctx.lineTo(padL + iw, ye);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ORANGE;
      ctx.font = "500 11px 'SF Pro Text', Inter, -apple-system, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      var elabel = opts.exitLabel || "Risk trailing stop";
      ctx.fillText(elabel, padL + iw, ye - 3);
      ctx.restore();
    }

    for (var i = 0; i < n; i++) {
      var c = candles[i];
      var o = Number(c.o != null ? c.o : c.c);
      var hi = Number(c.h != null ? c.h : c.c);
      var lo = Number(c.l != null ? c.l : c.c);
      var cl = Number(c.c);
      var up = cl >= o;
      var col = up ? GREEN : RED;
      var x = padL + (iw * (i + 0.5)) / n;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yOf(hi));
      ctx.lineTo(x, yOf(lo));
      ctx.stroke();
      var y1 = yOf(Math.max(o, cl));
      var y2 = yOf(Math.min(o, cl));
      // Doji (o≈c, or a single tick in a minute): keep a visible 3px body.
      var bh = Math.max(3, y2 - y1);
      var yBody = (y1 + y2) / 2 - bh / 2;
      ctx.fillStyle = col;
      ctx.fillRect(x - cw / 2, yBody, cw, bh);
    }

    // Volume bars (change of volume.m5; may be negative).
    var vols = candles.map(function (c) { return c.v == null ? 0 : Number(c.v); });
    var amax = 0;
    for (var vi = 0; vi < vols.length; vi++) {
      var a = Math.abs(vols[vi]);
      if (isFinite(a) && a > amax) amax = a;
    }
    var vBase = padT + ih + 10;
    var vMid = vBase + volH / 2;
    if (amax > 0) {
      for (var vj = 0; vj < n; vj++) {
        var vv = vols[vj];
        if (!isFinite(vv) || vv === 0) continue;
        var vh = (Math.abs(vv) / amax) * (volH / 2 - 2);
        var vx = padL + (iw * (vj + 0.5)) / n;
        ctx.fillStyle = vv >= 0 ? "rgba(0,211,90,0.45)" : "rgba(255,69,58,0.45)";
        if (vv >= 0) ctx.fillRect(vx - cw / 2, vMid - vh, cw, vh);
        else ctx.fillRect(vx - cw / 2, vMid, cw, vh);
      }
    }
    // Zero line for volume.
    ctx.strokeStyle = TERTIARY;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, vMid);
    ctx.lineTo(padL + iw, vMid);
    ctx.stroke();
  }

  /* ----- Score ring 0-100, green from 70. ----- */
  function drawScoreRing(canvas, opts) {
    if (!canvas) return;
    opts = opts || {};
    var s = setup(canvas);
    var ctx = s.ctx, w = s.w, h = s.h;
    var score = opts.score;
    var greenFrom = opts.greenFrom == null ? 70 : Number(opts.greenFrom);
    var cx = w / 2, cy = h / 2;
    var r = Math.min(w, h) * 0.38;
    var lw = Math.max(8, r * 0.16);
    ctx.lineCap = "round";
    ctx.lineWidth = lw;
    ctx.strokeStyle = TRACK;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    var has = score != null && isFinite(Number(score));
    if (has) {
      var v = Math.max(0, Math.min(100, Number(score)));
      var frac = v / 100;
      var start = -Math.PI / 2;
      var end = start + frac * Math.PI * 2;
      ctx.strokeStyle = v >= greenFrom ? GREEN : YELLOW;
      ctx.beginPath();
      if (frac >= 1) ctx.arc(cx, cy, r, 0, Math.PI * 2);
      else if (frac > 0) ctx.arc(cx, cy, r, start, end);
      ctx.stroke();
    }

    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 " + Math.round(r * 0.72) + "px 'SF Pro Display', Inter, -apple-system, sans-serif";
    ctx.fillText(has ? String(Math.round(Number(score))) : "—", cx, cy + 2);
  }

  global.DeskCharts = {
    drawLine: drawLine,
    drawCandles: drawCandles,
    drawScoreRing: drawScoreRing,
    _setup: setup,
    _reduced: reduced
  };
})(this);
