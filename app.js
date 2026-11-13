/* STEP 8 app. Plan B: poll published JSON under
   {SUPABASE}/storage/v1/object/public/desk/d/{dp}/ using PATH_MAP.
   DATA_PATH comes from the #d= fragment, then localStorage. The fragment
   is kept so an iOS Home Screen launch still carries #d=.
   Every FOMO link is the exact string from the JSON (links.py). JS never
   builds a FOMO URL. Writes (settings, pause, mode) are described as
   Telegram commands — they are not faked. */
(function () {
  "use strict";

  var SUPABASE_URL = "https://ibfqospmcpiuwemxoqbo.supabase.co";
  var BUCKET = "desk";
  var STATE_MS = 15000;
  var HEAVY_MS = 60000;
  var LS_KEY = "desk_data_path";
  var LS_TOKEN = "desk_app_token";

  var CHART_FILE = {
    LIVE: "chart-LIVE.json",
    "1H": "chart-1H.json",
    "4H": "chart-4H.json",
    "1D": "chart-1D.json",
    "1W": "chart-1W.json",
    ALL: "chart-ALL.json"
  };
  var RANGES = ["LIVE", "1H", "4H", "1D", "1W", "ALL"];
  var AGENT_ORDER = ["scanner", "auditor", "analyst", "executor", "risk"];
  var AGENT_TITLE = {
    scanner: "Scanner",
    auditor: "Auditor",
    analyst: "Analyst",
    executor: "Executor",
    risk: "Risk"
  };

  var cache = {
    state: null,
    charts: {},
    activity: null,
    account: null,
    settings: null,
    coins: {},
    audits: {},
    decisions: {},
    lastOk: null
  };
  var ui = {
    tab: "home",
    screen: "home",
    mint: null,
    agent: null,
    group: null,
    range: "LIVE",
    q: "",
    loading: true,
    offline: false,
    retryIn: 0,
    wantsConnect: false
  };
  var timers = { state: null, heavy: null, retry: null, retryTick: null };
  var heavyAt = 0;
  var fetchedAt = {};
  var odoPrev = null;
  var auditPlayed = {};

  var el = {
    app: null,
    stage: null,
    tabbar: null,
    offline: null,
    sheet: null
  };

  /* ---------- data path & hash (do not regress Home Screen) ---------- */

  function stashDataPath() {
    var hash = window.location.hash || "";
    var m = /(?:^|#|&)d=([^&]+)/.exec(hash);
    if (m && m[1]) {
      try { window.localStorage.setItem(LS_KEY, m[1]); } catch (e) {}
      // Keep the fragment: an iOS Home Screen app has its own storage, so the
      // saved Home Screen URL must still carry #d= for the first launch.
    }
    // Plan A may pass #t= once; stash quietly, never display, never send on plan B.
    var tm = /(?:^|#|&)t=([^&]+)/.exec(hash);
    if (tm && tm[1]) {
      try { window.localStorage.setItem(LS_TOKEN, tm[1]); } catch (e) {}
    }
  }

  function getDataPath() {
    try { return window.localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; }
  }

  function parseHash() {
    var hash = window.location.hash || "";
    var out = { d: "", s: "home", m: "", a: "", g: "", r: "" };
    var q = hash.charAt(0) === "#" ? hash.slice(1) : hash;
    q.split("&").forEach(function (part) {
      var i = part.indexOf("=");
      if (i < 1) return;
      var k = part.slice(0, i);
      var v = decodeURIComponent(part.slice(i + 1));
      if (k === "d") out.d = v;
      else if (k === "s") out.s = v;
      else if (k === "m") out.m = v;
      else if (k === "a") out.a = v;
      else if (k === "g") out.g = v;
      else if (k === "r") out.r = v;
    });
    return out;
  }

  function writeHash(next, replace) {
    var dp = getDataPath();
    var parts = [];
    if (dp) parts.push("d=" + dp);
    var s = next.s || "home";
    if (s && s !== "home") parts.push("s=" + encodeURIComponent(s));
    if (next.m) parts.push("m=" + encodeURIComponent(next.m));
    if (next.a) parts.push("a=" + encodeURIComponent(next.a));
    if (next.g) parts.push("g=" + encodeURIComponent(next.g));
    if (next.r && next.r !== "LIVE") parts.push("r=" + encodeURIComponent(next.r));
    var h = "#" + parts.join("&");
    if ((window.location.hash || "#") === h) return;
    if (replace) history.replaceState(null, "", h);
    else history.pushState(null, "", h);
  }

  function applyHash() {
    stashDataPath();
    var h = parseHash();
    if (h.r && RANGES.indexOf(h.r) >= 0) ui.range = h.r;
    if (h.s === "coin" && h.m) {
      ui.screen = "coin"; ui.tab = "home"; ui.mint = h.m;
    } else if (h.s === "audit" && h.m) {
      ui.screen = "audit"; ui.tab = "activity"; ui.mint = h.m;
    } else if (h.s === "search") {
      ui.screen = "search"; ui.tab = "home";
    } else if (h.s === "agents") {
      ui.screen = "agents"; ui.tab = "agents"; ui.agent = h.a || null;
    } else if (h.s === "activity") {
      ui.screen = "activity"; ui.tab = "activity";
    } else if (h.s === "account") {
      ui.screen = "account"; ui.tab = "account"; ui.group = h.g || null;
    } else {
      ui.screen = "home"; ui.tab = "home"; ui.mint = null;
    }
  }

  function go(screen, opts) {
    opts = opts || {};
    ui.screen = screen;
    if (screen === "home" || screen === "agents" || screen === "activity" || screen === "account") {
      ui.tab = screen;
    }
    if (opts.mint != null) ui.mint = opts.mint;
    if (opts.agent != null) ui.agent = opts.agent;
    if (opts.group != null) ui.group = opts.group;
    writeHash({
      s: screen,
      m: opts.mint || (screen === "coin" || screen === "audit" ? ui.mint : ""),
      a: opts.agent || "",
      g: opts.group || "",
      r: ui.range
    }, opts.replace);
    render();
    onScreenOpen(screen);
  }

  /* ---------- fetch ---------- */

  function fileUrl(rel) {
    var dp = getDataPath();
    if (!dp) return "";
    return SUPABASE_URL +
      "/storage/v1/object/public/" + BUCKET +
      "/d/" + encodeURIComponent(dp) +
      "/" + rel +
      "?ts=" + Date.now();
  }

  function getJson(rel) {
    var url = fileUrl(rel);
    if (!url) return Promise.reject(new Error("no path"));
    return fetch(url, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("http " + res.status);
      return res.json();
    });
  }

  function markOk() {
    cache.lastOk = new Date();
    ui.offline = false;
    ui.retryIn = 0;
    if (timers.retry) { clearTimeout(timers.retry); timers.retry = null; }
    if (timers.retryTick) { clearInterval(timers.retryTick); timers.retryTick = null; }
    paintOffline();
  }

  function markFail() {
    ui.offline = true;
    if (!ui.retryIn) ui.retryIn = Math.round(STATE_MS / 1000);
    paintOffline();
    if (!timers.retryTick) {
      timers.retryTick = setInterval(function () {
        if (ui.retryIn > 0) ui.retryIn -= 1;
        paintOffline();
      }, 1000);
    }
    if (!timers.retry) {
      timers.retry = setTimeout(function () {
        timers.retry = null;
        pollState();
      }, (ui.retryIn || 15) * 1000);
    }
  }

  function fmtLast(d) {
    if (!d) return "—";
    try {
      return new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false, timeZone: "Europe/London"
      }).format(d);
    } catch (e) {
      return "—";
    }
  }

  function paintOffline() {
    if (!el.offline) return;
    if (!ui.offline) {
      el.offline.setAttribute("hidden", "");
      el.app && el.app.classList.remove("has-offline");
      return;
    }
    var last = cache.lastOk ? fmtLast(cache.lastOk) : "never";
    var n = Math.max(0, ui.retryIn);
    el.offline.textContent = "Desk offline · retrying in " + n + "s · last update " + last;
    el.offline.removeAttribute("hidden");
    el.app && el.app.classList.add("has-offline");
  }

  function pollState() {
    if (!getDataPath()) return Promise.resolve();
    return getJson("state.json").then(function (state) {
      if (!state || typeof state !== "object") throw new Error("bad state");
      cache.state = state;
      ui.loading = false;
      markOk();
      // Re-render if we're on a screen that uses state, keeping last good numbers.
      if (ui.screen === "home" || ui.screen === "agents" || ui.screen === "account") {
        render();
      } else {
        // Still refresh PAPER badge / offline chrome.
        paintChrome();
      }
    }).catch(function () {
      ui.loading = false;
      markFail();
      // Keep last good numbers on screen. Never a blank, never a made-up number.
      if (!cache.state) render();
    });
  }

  function pollHeavy(force) {
    if (!getDataPath()) return Promise.resolve();
    var now = Date.now();
    if (!force && now - heavyAt < HEAVY_MS - 500) return Promise.resolve();
    heavyAt = now;
    var jobs = [
      getJson(CHART_FILE[ui.range] || CHART_FILE.LIVE).then(function (c) {
        if (c) cache.charts[c.range || ui.range] = c;
      }).catch(function () {}),
      getJson("activity.json").then(function (a) { if (a) cache.activity = a; }).catch(function () {}),
      getJson("account.json").then(function (a) { if (a) cache.account = a; }).catch(function () {}),
      getJson("settings.json").then(function (a) { if (a) cache.settings = a; }).catch(function () {})
    ];
    return Promise.all(jobs).then(function () {
      if (ui.screen === "home" || ui.screen === "activity" || ui.screen === "account") render();
    });
  }

  function onScreenOpen(screen) {
    if (!getDataPath()) return;
    if (screen === "home") {
      ensureChart(ui.range);
      if (!cache.activity) getJson("activity.json").then(function (a) { cache.activity = a; render(); }).catch(function () {});
    } else if (screen === "agents") {
      AGENT_ORDER.forEach(function (n) { ensureDecisions(n); });
    } else if (screen === "activity") {
      getJson("activity.json").then(function (a) { cache.activity = a; render(); }).catch(function () {});
    } else if (screen === "account") {
      Promise.all([
        getJson("account.json").then(function (a) { cache.account = a; }),
        getJson("settings.json").then(function (a) { cache.settings = a; })
      ]).then(function () { render(); }).catch(function () { render(); });
    } else if (screen === "coin" && ui.mint) {
      getJson("coin/" + ui.mint + ".json").then(function (c) {
        cache.coins[ui.mint] = c;
        render();
      }).catch(function () { render(); });
    } else if (screen === "audit" && ui.mint) {
      getJson("audit/" + ui.mint + ".json").then(function (c) {
        cache.audits[ui.mint] = c;
        render();
      }).catch(function () { render(); });
    } else if (screen === "search") {
      AGENT_ORDER.forEach(function (n) { ensureDecisions(n); });
    }
  }

  function ensureChart(range) {
    var key = range || "LIVE";
    getJson(CHART_FILE[key] || CHART_FILE.LIVE).then(function (c) {
      if (c) cache.charts[c.range || key] = c;
      if (ui.screen === "home") paintHomeChart();
    }).catch(function () {});
  }

  function ensureDecisions(name) {
    getJson("agents/" + name + "/decisions.json").then(function (d) {
      cache.decisions[name] = d;
      if (ui.screen === "agents" || ui.screen === "search") render();
    }).catch(function () {});
  }

  /* ---------- formatters: never invent a number ---------- */

  function isNum(n) {
    return n != null && n !== "" && isFinite(Number(n));
  }

  function fmtUsd(n, cents) {
    if (!isNum(n)) return "—";
    var opt = { minimumFractionDigits: cents === false ? 0 : 2, maximumFractionDigits: cents === false ? 0 : 2 };
    return "$" + Number(n).toLocaleString("en-US", opt);
  }

  function fmtCompact(n) {
    if (!isNum(n)) return "—";
    var v = Number(n);
    var sign = v < 0 ? "-" : "";
    var a = Math.abs(v);
    if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
    if (a >= 1e3) return sign + "$" + (a / 1e3).toFixed(a >= 1e4 ? 1 : 1) + "K";
    return sign + "$" + a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtPrice(n) {
    if (!isNum(n)) return "—";
    var v = Math.abs(Number(n));
    var d = 2;
    if (v > 0 && v < 1e-6) d = 10;
    else if (v < 1e-4) d = 8;
    else if (v < 0.01) d = 6;
    else if (v < 1) d = 4;
    else d = 2;
    return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtPct(n, signed) {
    if (!isNum(n)) return "—";
    var v = Number(n);
    var body = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var sign = v < 0 ? "-" : (signed ? "+" : "");
    return sign + body + "%";
  }

  function fmtMult(n) {
    if (!isNum(n)) return "—";
    return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "\u00d7";
  }

  function fmtTime(iso) {
    if (!iso) return "";
    try {
      return new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London"
      }).format(new Date(iso));
    } catch (e) { return ""; }
  }

  function fmtTimeout(s) {
    if (!isNum(s)) return "—";
    var t = Math.max(0, Math.round(Number(s)));
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m";
    return t + "s";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* Use a FOMO URL only if the JSON already gave us a complete https URL.
     Never construct or rewrite one. */
  function fomoHref(url) {
    if (!url || typeof url !== "string") return "";
    if (url.indexOf("https://") !== 0) return "";
    return url;
  }

  function reduced() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch (e) { return false; }
  }

  /* ---------- odometer ---------- */

  function odoString(n) {
    return "$" + Number(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function paintOdo(root, value) {
    if (!root) return;
    if (!isNum(value)) {
      root.textContent = "—";
      root.removeAttribute("data-s");
      return;
    }
    var s = odoString(value);
    var prev = root.getAttribute("data-s");
    root.setAttribute("data-s", s);
    var instant = reduced() || prev == null;
    if (instant) {
      root.innerHTML = "";
      var wrap = document.createElement("div");
      wrap.className = "odo";
      s.split("").forEach(function (ch) {
        wrap.appendChild(odoGlyph(ch, ch, true));
      });
      root.appendChild(wrap);
      fitOdo(root);
      return;
    }
    var wrap = root.querySelector(".odo");
    if (!wrap || prev.length !== s.length) {
      // Length changed (e.g. $999.00 → $1,000.00): rebuild, still roll digits that exist.
      root.innerHTML = "";
      wrap = document.createElement("div");
      wrap.className = "odo";
      s.split("").forEach(function (ch, i) {
        var from = (prev[i] && /[0-9]/.test(prev[i]) && /[0-9]/.test(ch)) ? prev[i] : ch;
        wrap.appendChild(odoGlyph(ch, from, false));
      });
      root.appendChild(wrap);
    } else {
      var kids = wrap.children;
      for (var i = 0; i < s.length; i++) {
        updateGlyph(kids[i], s[i], prev[i]);
      }
    }
    // Stagger right to left, 30ms, only changed digits.
    var delay = 0;
    var kids2 = wrap.children;
    for (var j = s.length - 1; j >= 0; j--) {
      var g = kids2[j];
      if (!g || !g.classList.contains("odo-col")) continue;
      var strip = g.querySelector(".odo-strip");
      if (!strip) continue;
      var changed = prev[j] !== s[j];
      if (changed) {
        strip.classList.add("roll");
        strip.style.transitionDelay = delay + "ms";
        delay += 30;
        (function (el) {
          setTimeout(function () { el.classList.remove("roll"); el.style.transitionDelay = "0ms"; }, 600 + delay + 40);
        })(strip);
      }
    }
    fitOdo(root);
  }

  function odoGlyph(ch, from, instant) {
    if (!/[0-9]/.test(ch)) {
      var s = document.createElement("span");
      s.className = ch === "." ? "odo-dot" : (ch === "$" ? "odo-sym" : "odo-sep");
      s.textContent = ch;
      return s;
    }
    var col = document.createElement("span");
    col.className = "odo-col";
    var strip = document.createElement("span");
    strip.className = "odo-strip" + (instant ? "" : " roll");
    for (var d = 0; d <= 9; d++) {
      var sp = document.createElement("span");
      sp.textContent = String(d);
      strip.appendChild(sp);
    }
    var start = /[0-9]/.test(from) ? Number(from) : Number(ch);
    strip.style.transform = "translateY(-" + start + "em)";
    col.appendChild(strip);
    if (!instant && start !== Number(ch)) {
      // Force layout then roll.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          strip.style.transform = "translateY(-" + Number(ch) + "em)";
        });
      });
    } else {
      strip.style.transform = "translateY(-" + Number(ch) + "em)";
    }
    return col;
  }

  function updateGlyph(node, ch, prev) {
    if (!node) return;
    if (!/[0-9]/.test(ch)) {
      node.textContent = ch;
      return;
    }
    if (!node.classList.contains("odo-col")) return;
    var strip = node.querySelector(".odo-strip");
    if (!strip) return;
    strip.style.transform = "translateY(-" + Number(ch) + "em)";
  }

  function fitOdo(root) {
    var wrap = root.querySelector(".odo");
    if (!wrap) return;
    wrap.style.fontSize = "";
    var max = root.parentElement ? root.parentElement.clientWidth - 80 : 280;
    if (max < 80) max = 280;
    var size = 72;
    wrap.style.fontSize = size + "px";
    // Shrink between 66 and 100 as specified; go down to 48 if needed for huge stacks.
    while (wrap.scrollWidth > max && size > 48) {
      size -= 2;
      wrap.style.fontSize = size + "px";
    }
  }

  /* ---------- chrome ---------- */

  function paintChrome() {
    if (!el.app || !el.tabbar) return;
    var push = ui.screen === "coin" || ui.screen === "audit" || ui.screen === "search" || !getDataPath();
    el.app.classList.toggle("has-tabs", !push);
    el.app.classList.toggle("no-tabs", push);
    var mode = (cache.state && cache.state.mode) || (cache.account && cache.account.mode) || "PAPER";
    el.app.setAttribute("data-mode", mode);
    el.tabbar.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === ui.tab);
    });
    paintOffline();
  }

  function navHome() {
    var mode = (cache.state && cache.state.mode) || "PAPER";
    return (
      '<header class="navbar">' +
        '<button type="button" class="avatar-wrap" data-act="account" aria-label="Account">' +
          '<span class="avatar-btn">G</span>' +
        "</button>" +
        '<button type="button" class="navbar-title" data-act="account" style="background:none;border:0;padding:0;min-height:44px;">' +
          "Grok Bot <span class=\"chev\">›</span>" +
        "</button>" +
        (mode === "PAPER" ? '<span class="paper-badge">PAPER</span>' : "") +
        '<div class="navbar-right">' +
          '<button type="button" class="icon-btn" data-act="search" aria-label="Search">' +
            '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 16.6 20 20.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' +
          "</button>" +
          '<button type="button" class="icon-btn" data-act="bell" aria-label="Notifications">' +
            '<svg viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5L19.5 18H4.5L6 16.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10 18.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' +
          "</button>" +
        "</div>" +
      "</header>"
    );
  }

  function navBack(title, extra) {
    var mode = (cache.state && cache.state.mode) || "PAPER";
    return (
      '<header class="navbar">' +
        '<button type="button" class="icon-btn back-btn" data-act="back" aria-label="Back">' +
          '<svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        "</button>" +
        '<div class="navbar-title">' + esc(title || "") + "</div>" +
        (extra || "") +
        (mode === "PAPER" && (ui.screen === "coin") ? '<span class="paper-badge">PAPER</span>' : "") +
      "</header>"
    );
  }

  /* ---------- Home ---------- */

  function renderHome() {
    var st = cache.state;
    if (ui.loading && !st) return skeletonHome();
    if (!st && !getDataPath()) return renderConnect();
    if (!st) return skeletonHome();

    var today = st.today_pct;
    var cls = "flat";
    var todayTxt = "—";
    if (isNum(today)) {
      var tv = Number(today);
      cls = tv > 0.0005 ? "up" : (tv < -0.0005 ? "down" : "flat");
      todayTxt = fmtPct(tv, true);
    }
    var mult = isNum(st.multiplier) ? fmtMult(st.multiplier) : "—";
    var running = st.agents_running != null ? String(st.agents_running) : "—";
    var agents = Array.isArray(st.agents) ? st.agents : [];
    var act = (cache.activity && cache.activity.rows) || [];
    var last5 = act.slice(0, 5);
    var noTrades = isHomeEmpty(st);

    var html = navHome() +
      '<div class="home-hero">' +
        '<div class="hero-row">' +
          '<div class="odo-wrap" id="odo" aria-label="Balance"></div>' +
        "</div>" +
        '<div class="hero-meta">' +
          '<span class="today-pct ' + cls + '">' + esc(todayTxt) + "</span>" +
          (isNum(st.multiplier)
            ? '<span class="mult-pill' + (Number(st.multiplier) === 1 ? " flat" : "") + '">' + esc(mult) + "</span>"
            : "") +
        "</div>" +
      "</div>" +
      '<div class="screen-pad">' +
        '<div class="chart-box" id="home-chart-box">' +
          '<canvas id="home-chart"></canvas>' +
          (noTrades ? '<div class="chart-empty">Waiting for the first trade</div>' : "") +
        "</div>" +
        '<div class="range-switch" role="tablist">' +
          RANGES.map(function (r) {
            return '<button type="button" data-act="range" data-range="' + r + '"' +
              (ui.range === r ? ' class="active"' : "") + ">" + r + "</button>";
          }).join("") +
        "</div>" +
      "</div>" +
      '<div class="section-h">Agents <span class="muted">· ' + esc(running) + " running</span></div>" +
      '<div class="carousel" id="agent-carousel">' +
        agents.map(renderAgentCard).join("") +
      "</div>" +
      '<div class="section-h">Activity <button type="button" class="link" data-act="activity">See all</button></div>' +
      (last5.length
        ? '<div class="act-list">' + last5.map(renderActRow).join("") + "</div>"
        : '<div class="empty-note">Nothing yet tonight</div>');

    el.stage.innerHTML = html;
    paintOdo(document.getElementById("odo"), st.balance);
    paintHomeChart();
  }

  function isHomeEmpty(st) {
    var chart = cache.charts[ui.range] || cache.charts.LIVE;
    var marks = chart && chart.marks ? chart.marks.length : 0;
    var act = cache.activity && cache.activity.rows ? cache.activity.rows.length : 0;
    if (marks > 0 || act > 0) return false;
    // Flat at night start (or no movement) counts as waiting for the first trade.
    if (isNum(st.balance) && isNum(st.night_start) && Math.abs(Number(st.balance) - Number(st.night_start)) < 0.005) {
      return true;
    }
    if (isNum(st.today_pct) && Math.abs(Number(st.today_pct)) < 0.0005) return true;
    return !chart || !(chart.points && chart.points.length);
  }

  function paintHomeChart() {
    var canvas = document.getElementById("home-chart");
    if (!canvas || !globalThis.DeskCharts) return;
    var chart = cache.charts[ui.range] || cache.charts.LIVE;
    var st = cache.state || {};
    var empty = isHomeEmpty(st);
    var points = (chart && chart.points) || [];
    var start = (chart && chart.start != null) ? chart.start : st.night_start;
    DeskCharts.drawLine(canvas, {
      points: empty ? [] : points,
      start: start,
      marks: (chart && chart.marks) || [],
      empty: empty,
      animate: !empty,
      onFrame: function () { paintHomeChart(); }
    });
  }

  function skeletonHome() {
    el.stage.innerHTML = navHome() +
      '<div class="home-hero"><div class="sk sk-balance"></div><div class="sk sk-line"></div></div>' +
      '<div class="screen-pad"><div class="sk sk-chart"></div></div>' +
      '<div class="section-h">Agents</div>' +
      '<div class="carousel"><div class="sk sk-card"></div></div>' +
      '<div class="section-h">Activity</div>' +
      '<div class="sk sk-row"></div><div class="sk sk-row"></div>';
  }

  /* ---------- Agent cards (Home carousel) ---------- */

  function renderAgentCard(a) {
    if (!a) return "";
    var name = a.name || "";
    var body = "";
    if (name === "scanner") body = cardScanner(a);
    else if (name === "auditor") body = cardAuditor(a);
    else if (name === "analyst") body = cardAnalyst(a);
    else if (name === "executor") body = cardExecutor(a);
    else if (name === "risk") body = cardRisk(a);
    return '<button type="button" class="agent-card" data-act="agents" data-agent="' + esc(name) + '">' +
      body + "</button>";
  }

  function cardScanner(a) {
    var feed = Array.isArray(a.feed) ? a.feed : [];
    var rows = feed.slice(0, 7).map(function (f) {
      var kill = f.verdict === "kill" || f.verdict === "drop";
      return '<div class="feed-row ' + (kill ? "kill" : "pass") + '">' +
        '<span class="nm">' + esc(f.name || f.symbol || "") + "</span>" +
        '<span class="why">' + esc(f.text || f.reason || (kill ? "" : "→ auditor")) + "</span>" +
      "</div>";
    }).join("");
    var empty = !feed.length;
    return '<div class="ac-top"><div class="ac-name scanner">Scanner</div></div>' +
      '<div class="ac-count">' + esc(a.label || ((a.count != null ? a.count : "—") + " pools")) + "</div>" +
      (empty
        ? '<div class="ac-empty">' + esc(a.subtitle || "Listening for graduations") + "</div>"
        : '<div class="ac-feed">' + rows + "</div>");
  }

  function cardAuditor(a) {
    var layers = Array.isArray(a.layers) ? a.layers : [];
    // Always 8 strips (empty = unchecked).
    var strips = "";
    for (var n = 1; n <= 8; n++) {
      var ly = null;
      for (var i = 0; i < layers.length; i++) if (layers[i].n === n) ly = layers[i];
      var cls = "layer-strip";
      if (ly && ly.pass === true) cls += " on";
      else if (ly && ly.pass === false) cls += " off";
      var LAYER_N = {
        1: "Mint authority", 2: "Freeze authority", 3: "Dev wallet", 4: "Top 10 holders",
        5: "Liquidity", 6: "Pool age", 7: "Bundled wallets", 8: "Delegations"
      };
      var label = (ly && ly.name) ? ly.name : (LAYER_N[n] || "");
      strips += '<div class="' + cls + '"><span class="tick"></span><span class="ln">' + esc(label) + "</span></div>";
    }
    var taken = a.label || ((a.count_taken != null ? a.count_taken : "—") + " taken apart");
    return '<div class="ac-top"><div class="ac-name auditor">Auditor</div></div>' +
      '<div class="ac-count">' + esc(taken) + "</div>" +
      '<div class="layer-grid">' + strips + "</div>" +
      '<div class="ac-headline">' + esc(a.headline || "") + "</div>" +
      '<div class="ac-rejected">' + esc(a.rejected_label || "") + "</div>";
  }

  function cardAnalyst(a) {
    return '<div class="ac-top"><div class="ac-name analyst">Analyst</div></div>' +
      '<div class="ac-count">' + esc(a.label || "Scoring") + "</div>" +
      '<div class="ring-wrap"><canvas class="score-ring" data-score="' +
        (isNum(a.score) ? String(a.score) : "") +
        '" data-green="' + (a.green_from != null ? String(a.green_from) : "70") +
        '"></canvas></div>';
  }

  function cardExecutor(a) {
    var bar = a.bar || "idle";
    var pct = isNum(a.bar_pct) ? Number(a.bar_pct) : 0;
    var txt = a.bar_text || "";
    return '<div class="ac-top"><div class="ac-name executor">Executor</div></div>' +
      '<div class="ac-count">' + esc(a.label || ((a.count != null ? a.count : "—") + " trades")) + "</div>" +
      '<div class="exec-size">' + esc(a.size_label || "") + "</div>" +
      (bar === "idle" && !txt ? "" :
        '<div class="exec-bar-track"><div class="exec-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="exec-bar-text' + (bar === "filled" ? " done" : "") + '">' + esc(txt) + "</div>");
  }

  function cardRisk(a) {
    var pills = a.pills || {};
    return '<div class="ac-top"><div class="ac-name risk">Risk</div></div>' +
      '<div class="ac-count">' + esc(a.label || "Guarding") + "</div>" +
      '<div class="pill-row">' +
        (pills.stop ? '<span class="pill stop">' + esc(pills.stop) + "</span>" : "") +
        (pills.trail ? '<span class="pill trail">' + esc(pills.trail) + "</span>" : "") +
      "</div>";
  }

  function paintRings() {
    if (!globalThis.DeskCharts) return;
    document.querySelectorAll("canvas.score-ring").forEach(function (c) {
      var raw = c.getAttribute("data-score");
      var score = raw === "" || raw == null ? null : Number(raw);
      var gf = Number(c.getAttribute("data-green") || 70);
      DeskCharts.drawScoreRing(c, { score: isNum(score) ? score : null, greenFrom: gf });
    });
  }

  /* ---------- Activity ---------- */

  function renderActRow(r) {
    if (!r) return "";
    var kind = r.kind || "";
    var vcls = "act-value";
    if (kind === "sold") vcls += " up";
    else if (kind === "stopped") vcls += " down";
    else if (kind === "rejected") vcls += " skip";
    var act = (kind === "rejected") ? "open-audit" : "open-coin";
    return '<button type="button" class="act-row" data-act="' + act + '" data-mint="' + esc(r.mint || "") + '">' +
      '<div class="act-left">' +
        '<div class="act-title">' + esc(r.title || "") + "</div>" +
        '<div class="act-sub">' + esc(r.subtitle || "") + "</div>" +
      "</div>" +
      '<div class="' + vcls + '">' + esc(r.value || "") + "</div>" +
    "</button>";
  }

  function renderActivity() {
    if (ui.loading && !cache.activity && !cache.state) {
      el.stage.innerHTML = '<header class="navbar"><div class="navbar-title">Activity</div></header>' +
        '<div class="sk sk-row"></div><div class="sk sk-row"></div><div class="sk sk-row"></div>';
      return;
    }
    var rows = (cache.activity && cache.activity.rows) || [];
    el.stage.innerHTML =
      '<header class="navbar"><div class="navbar-title">Activity</div></header>' +
      (rows.length
        ? '<div class="act-list">' + rows.map(renderActRow).join("") + "</div>"
        : '<div class="empty-note">Nothing yet tonight</div>');
  }

  /* ---------- Agents tab ---------- */

  function renderAgents() {
    var st = cache.state;
    var html = '<header class="navbar"><div class="navbar-title">Agents</div></header>';
    if (ui.loading && !st) {
      el.stage.innerHTML = html + '<div class="sk sk-row"></div><div class="sk sk-row"></div>';
      return;
    }
    AGENT_ORDER.forEach(function (name) {
      var card = agentFromState(name);
      var dec = cache.decisions[name];
      var status = (dec && dec.status) || (card && card.status) || "down";
      var count = (dec && dec.today_count != null) ? dec.today_count
        : (card && (card.count != null ? card.count : card.count_taken));
      var paused = status === "paused";
      var riskLocked = name === "risk" && card && card.open > 0;
      var decisions = (dec && dec.decisions) || [];
      html += '<section class="agent-block" id="agent-' + name + '">' +
        '<div class="agent-block-h">' +
          '<span class="status-dot ' + esc(status) + '"></span>' +
          '<div><div class="nm">' + esc(AGENT_TITLE[name]) + "</div>" +
          '<div class="cnt">' + (count != null ? esc(String(count)) + " today" : "") + "</div></div>" +
          '<div class="switch-wrap">' +
            '<span class="switch-lbl">' + (paused ? "Paused" : (riskLocked ? "Locked" : "Running")) + "</span>" +
            '<button type="button" class="sw' + (paused ? "" : " on") + (riskLocked ? " locked" : "") +
              '" data-act="pause" data-agent="' + name + '" data-paused="' + (paused ? "1" : "0") +
              '" data-locked="' + (riskLocked ? "1" : "0") + '" aria-label="Pause or resume"></button>'.replace(
                "</button>", '<span class="knob"></span></button>'
              ) +
          "</div>" +
        "</div>";
      if (!decisions.length) {
        html += '<div class="empty-note" style="padding:20px 16px">No decisions yet tonight</div>';
      } else {
        decisions.forEach(function (d) {
          html += renderDecision(name, d);
        });
      }
      html += '<button type="button" class="settings-shortcut" data-act="settings" data-group="' + name + '">Settings</button>';
      html += "</section>";
    });
    el.stage.innerHTML = html;
    if (ui.agent) {
      var target = document.getElementById("agent-" + ui.agent);
      if (target) setTimeout(function () { target.scrollIntoView({ block: "start" }); }, 30);
    }
  }

  function agentFromState(name) {
    var st = cache.state;
    if (!st || !Array.isArray(st.agents)) return null;
    for (var i = 0; i < st.agents.length; i++) if (st.agents[i].name === name) return st.agents[i];
    return null;
  }

  function renderDecision(agent, d) {
    var v = (d.verdict || "").toLowerCase();
    var vcls = "dec-verdict";
    if (v === "pass" || v === "filled" || v === "bought") vcls += " pass";
    else if (v === "kill" || v === "fail" || v === "rejected" || v === "skip" || v === "skipped") vcls += " fail";
    var isReject = v === "fail" || v === "rejected" || (agent === "auditor" && v !== "pass") || (agent === "analyst" && v === "fail");
    var act = isReject ? "open-audit" : "open-coin";
    var reason = d.reason || "";
    if (d.score != null && d.model) reason = (reason ? reason + " · " : "") + "score " + d.score;
    return '<button type="button" class="' + "dec-row" + '" data-act="' + act + '" data-mint="' + esc(d.mint || "") + '">' +
      '<div class="dec-time">' + esc(fmtTime(d.ts)) + "</div>" +
      '<div class="dec-body"><div class="nm">' + esc(d.name || d.symbol || "") + "</div>" +
        '<div class="rs">' + esc(reason) + "</div></div>" +
      '<div class="' + vcls + '">' + esc(d.verdict || "") + "</div>" +
    "</button>";
  }

  /* ---------- Coin ---------- */

  function renderCoin() {
    var mint = ui.mint;
    var coin = mint ? cache.coins[mint] : null;
    var title = (coin && (coin.name || coin.symbol)) || "Coin";
    if (!coin) {
      el.stage.innerHTML = navBack(title) +
        (ui.loading || !mint
          ? '<div class="screen-pad"><div class="sk sk-balance"></div><div class="sk sk-chart"></div></div>'
          : '<div class="empty-note">No data for this coin yet</div>');
      return;
    }
    var idLine = esc(coin.symbol || "") +
      (coin.chain ? " · " + esc(coin.chain) : "") +
      (coin.age ? " · " + esc(coin.age) : "");
    var shield = coin.shield ? '<span class="shield">' + esc(coin.shield) + "</span>" : "";
    var chg = coin.change_since_entry_pct;
    var since = "";
    if (isNum(chg)) {
      var up = Number(chg) >= 0;
      since = '<div class="since ' + (up ? "up" : "down") + '">' +
        (up ? "▲ " : "▼ ") + esc(fmtPct(chg, false)) + " since entry</div>";
    }
    var stats = coin.stats || {};
    var holders = stats.holders == null ? "n/a" : String(stats.holders);
    var pos = coin.position;
    var posHtml = "";
    if (pos) {
      posHtml = '<div class="pos-card"><h3>Your position · ' +
        (isNum(pos.size_usd) ? esc(fmtUsd(pos.size_usd)) + " in" : "") +
        " · " + esc(pos.agent || "Executor") + "</h3></div>";
      posHtml += '<div class="exit-card"><h3>Exit</h3>' +
        '<div class="exit-line"><span class="k">Stop line</span><span>' +
          (isNum(pos.stop_price) ? esc(fmtPrice(pos.stop_price)) : "—") +
          (isNum(pos.stop_pct) ? " · −" + esc(String(pos.stop_pct).replace(/\.0$/, "")) + "%" : "") +
        "</span></div>" +
        '<div class="exit-line"><span class="k">Trail line</span><span>' +
          (isNum(pos.trail_line) ? esc(fmtPrice(pos.trail_line)) : "—") +
          (isNum(pos.trail_pct) ? " · " + esc(String(pos.trail_pct).replace(/\.0$/, "")) + "%" : "") +
        "</span></div>" +
        '<div class="exit-line"><span class="k">Time left</span><span>' +
          esc(fmtTimeout(pos.timeout_left_s)) +
        "</span></div></div>";
    }
    // Coin screen without a position: no exit card. (spec)
    var href = fomoHref(coin.coin_url);
    var btn = coin.button || (pos ? "Sell on FOMO" : "Buy on FOMO");
    var btnHtml = href
      ? '<a class="btn-fomo" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(btn) + "</a>"
      : "";

    el.stage.innerHTML = navBack(title) +
      '<div class="coin-id">' + idLine + shield + "</div>" +
      '<div class="price-lg">' + esc(fmtPrice(coin.price)) + "</div>" +
      since +
      '<div class="candle-box"><canvas id="coin-chart"></canvas></div>' +
      '<div class="stats-grid">' +
        stat("Market cap", fmtCompact(stats.market_cap)) +
        stat("Liquidity", fmtCompact(stats.liquidity)) +
        stat("24h volume", fmtCompact(stats.volume_h24)) +
        stat("Holders", holders) +
      "</div>" +
      posHtml +
      btnHtml;

    var canvas = document.getElementById("coin-chart");
    if (canvas && globalThis.DeskCharts) {
      var exitPx = null, exitLabel = null;
      if (coin.exit_line && coin.exit_line.price != null) {
        exitPx = coin.exit_line.price;
        exitLabel = coin.exit_line.label || "Risk trailing stop";
      }
      DeskCharts.drawCandles(canvas, {
        candles: coin.candles || [],
        exitLine: exitPx,
        exitLabel: exitLabel
      });
    }
  }

  function stat(k, v) {
    return '<div class="stat"><div class="stat-lbl">' + esc(k) + '</div><div class="stat-val">' + esc(v) + "</div></div>";
  }

  /* ---------- Auditor ---------- */

  function renderAudit() {
    var mint = ui.mint;
    var audit = mint ? cache.audits[mint] : null;
    var title = (audit && (audit.name || audit.symbol)) || "Auditor";
    if (!audit) {
      el.stage.innerHTML = navBack("Auditor") +
        '<div class="empty-note">No coin taken apart yet</div>' +
        auditToggleHtml();
      return;
    }
    var hcls = audit.passed === true ? "ok" : (audit.passed === false ? "rej" : "");
    var layers = Array.isArray(audit.layers) ? audit.layers.slice() : [];
    layers.sort(function (a, b) { return (a.n || 0) - (b.n || 0); });
    // Fill 1-8
    var byN = {};
    layers.forEach(function (ly) { byN[ly.n] = ly; });
    var discHtml = '<div class="disc-list" id="disc-list">';
    for (var n = 1; n <= 8; n++) {
      var ly = byN[n] || { n: n, name: "", pass: null, value: "not checked" };
      discHtml += '<div class="disc-row" data-n="' + n + '">' +
        '<div class="disc" data-pass="' + (ly.pass === true ? "1" : ly.pass === false ? "0" : "") + '">' +
          '<span class="mark"></span></div>' +
        '<div class="disc-meta"><div class="disc-name">' + esc(ly.name || ("Layer " + n)) + "</div>" +
          '<div class="disc-val">' + esc(ly.value || "") + "</div></div>" +
      "</div>";
    }
    discHtml += "</div>";
    var href = fomoHref(audit.coin_url);
    var btn = href
      ? '<a class="btn-fomo" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">Open on FOMO</a>'
      : "";

    el.stage.innerHTML = navBack(title) +
      '<div class="audit-head">' +
        '<div class="audit-headline ' + hcls + '">' + esc(audit.headline || "") + "</div>" +
        (audit.sub ? '<div class="audit-sub">' + esc(audit.sub) + "</div>" : "") +
      "</div>" +
      discHtml +
      auditToggleHtml() +
      btn;
    playAuditBeam(audit, mint);
  }

  function auditToggleHtml() {
    var on = true;
    if (cache.settings && cache.settings.settings && cache.settings.settings["auditor.enabled"]) {
      on = !!cache.settings.settings["auditor.enabled"].value;
    }
    return '<button type="button" class="audit-toggle" data-act="auditor-toggle">' +
      '<div><div class="lbl">Take apart before buying</div>' +
      '<div class="hint">Changed in Telegram</div></div>' +
      '<span class="sw' + (on ? " on" : "") + '"><span class="knob"></span></span>' +
    "</button>";
  }

  function playAuditBeam(audit, mint) {
    var rows = document.querySelectorAll("#disc-list .disc-row");
    if (!rows.length) return;
    var key = mint + ":" + (audit.ts || "");
    var instant = reduced() || auditPlayed[key];
    auditPlayed[key] = true;
    function apply(i, beam) {
      var disc = rows[i] && rows[i].querySelector(".disc");
      if (!disc) return;
      var p = disc.getAttribute("data-pass");
      disc.classList.remove("beam", "pass", "fail");
      var mark = disc.querySelector(".mark");
      if (beam && p === "") {
        // Server has not sent a result — wait, never invent.
        disc.classList.add("beam");
        if (mark) mark.textContent = "";
        return "wait";
      }
      if (beam && !instant) {
        disc.classList.add("beam");
        if (mark) mark.textContent = "";
        return "beam";
      }
      if (p === "1") {
        disc.classList.add("pass");
        if (mark) mark.textContent = "✓";
      } else if (p === "0") {
        disc.classList.add("fail");
        if (mark) mark.textContent = "×";
      }
      return p === "" ? "wait" : "done";
    }
    if (instant) {
      for (var i = 0; i < rows.length; i++) apply(i, false);
      return;
    }
    var step = 0;
    function next() {
      if (step > 0) apply(step - 1, false);
      if (step >= rows.length) return;
      var st = apply(step, true);
      var wait = 350;
      if (st === "wait") {
        // Server slower: keep the beam here. We'll try again shortly; no fake result.
        setTimeout(next, 200);
        return;
      }
      // After the beam, 150ms to green or red.
      setTimeout(function () {
        apply(step, false);
        step += 1;
        setTimeout(next, 150);
      }, wait);
    }
    next();
  }

  /* ---------- Account ---------- */

  function renderAccount() {
    var acc = cache.account;
    var st = cache.state;
    var mode = (acc && acc.mode) || (st && st.mode) || "PAPER";
    var stack = (acc && acc.stack != null) ? acc.stack : (st && st.balance);
    var html = '<header class="navbar"><div class="navbar-title">Account</div>' +
      (mode === "PAPER" ? '<span class="paper-badge">PAPER</span>' : "") + "</header>";

    html += '<div class="group-title">Mode</div><div class="group">';
    html += '<div class="row static"><span class="k">Desk mode</span>' +
      '<div class="seg">' +
        '<button type="button" data-act="mode" data-mode="PAPER"' + (mode === "PAPER" ? ' class="on"' : "") + ">PAPER</button>" +
        '<button type="button" data-act="mode" data-mode="LIVE"' + (mode === "LIVE" ? ' class="on"' : "") + ">LIVE</button>" +
      "</div></div>";
    html += '<button type="button" class="row" data-act="stack"><span class="k">Stack</span>' +
      '<span class="v chev">' + esc(isNum(stack) ? fmtUsd(stack) : "—") + "</span></button>";
    html += "</div>";
    html += '<p class="note">Mode and stack are changed in Telegram on this setup.</p>';

    var handle = acc && acc.fomo_handle ? acc.fomo_handle : "";
    var profile = acc ? fomoHref(acc.profile_url) : "";
    var signup = acc ? fomoHref(acc.signup_url) : "";
    html += '<div class="group-title">FOMO</div><div class="group">';
    if (profile) {
      html += '<a class="row" href="' + esc(profile) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="k">Your FOMO profile</span><span class="v chev">' +
        esc(handle ? "@" + handle : "Open") + "</span></a>";
    } else {
      html += '<div class="row static"><span class="k">Your FOMO profile</span><span class="v">—</span></div>';
    }
    if (signup) {
      html += '<button type="button" class="row" data-act="invite" data-url="' + esc(signup) + '">' +
        '<span class="k">Invite a friend</span><span class="v chev">Share</span></button>';
    }
    html += "</div>";

    var tg = acc && acc.telegram && acc.telegram.connected;
    html += '<div class="group-title">Telegram</div><div class="group">';
    html += '<div class="row static"><span class="k">Telegram</span>' +
      '<span class="v' + (tg ? " ok" : "") + '">' + (tg ? "Connected" : "Not connected") + "</span></div>";
    html += '<button type="button" class="row" data-act="test-push"><span class="k">Send test push</span>' +
      '<span class="v chev"></span></button>';
    html += "</div>";

    var wp = acc && acc.web_push;
    html += '<div class="group-title">Notifications</div><div class="group">';
    html += '<div class="row static stack"><span class="k">Web push</span><span class="v">' +
      esc((wp && wp.reason) || "Plan B has no POST /api/push; Telegram only.") +
      "</span></div></div>";

    html += '<div class="group-title">Settings</div>';
    html += '<p class="note">Read-only here. Change a value in Telegram. The full sliders land in a later step.</p>';
    html += renderSettingsGroups();

    el.stage.innerHTML = html;
    if (ui.group) {
      var target = document.getElementById("grp-" + ui.group);
      if (target) setTimeout(function () { target.scrollIntoView({ block: "start" }); }, 30);
    }
  }

  function renderSettingsGroups() {
    var s = cache.settings;
    if (!s || !s.groups) return '<div class="empty-note">Settings have not loaded yet</div>';
    var order = ["scanner", "auditor", "analyst", "executor", "risk", "desk"];
    var html = "";
    order.forEach(function (g) {
      var grp = s.groups[g];
      if (!grp) return;
      var title = g.charAt(0).toUpperCase() + g.slice(1);
      html += '<div class="group-title" id="grp-' + g + '">' + esc(title) + "</div><div class=\"group\">";
      Object.keys(grp).forEach(function (key) {
        var e = grp[key];
        var val = e && e.value;
        var shown = typeof val === "boolean" ? (val ? "on" : "off") : (val == null ? "—" : String(val));
        var short = (key.indexOf(g + ".") === 0) ? key.slice(g.length + 1) : key;
        html += '<div class="set-row">' +
          '<div class="set-k">' + esc(short) + "</div>" +
          '<div class="set-v">' + esc(shown) + "</div>" +
          (e && e.doc ? '<div class="set-doc">' + esc(e.doc) + "</div>" : "") +
        "</div>";
      });
      html += "</div>";
    });
    return html;
  }

  /* ---------- Search ---------- */

  function renderSearch() {
    var html = navBack("Search") +
      '<div class="search-bar">' +
        '<input id="search-q" type="search" placeholder="Name, symbol or mint" value="' + esc(ui.q) + '" autocomplete="off" autocorrect="off" spellcheck="false">' +
        '<button type="button" class="search-cancel" data-act="back">Cancel</button>' +
      "</div>";
    var hits = searchHits(ui.q);
    if (!ui.q) {
      html += '<div class="empty-note">Search a name, symbol or mint from tonight</div>';
    } else if (!hits.length) {
      html += '<div class="empty-note">No matches</div>';
    } else {
      html += '<div class="act-list">';
      hits.forEach(function (h) {
        html += '<button type="button" class="act-row" data-act="open-coin" data-mint="' + esc(h.mint) + '">' +
          '<div class="act-left"><div class="act-title">' + esc(h.name) + "</div>" +
          '<div class="act-sub">' + esc(h.sub) + "</div></div></button>";
      });
      html += "</div>";
    }
    el.stage.innerHTML = html;
    var inp = document.getElementById("search-q");
    if (inp) {
      inp.addEventListener("input", function () {
        ui.q = inp.value || "";
        // Re-render results only: keep focus.
        var keep = inp.selectionStart;
        renderSearch();
        var n = document.getElementById("search-q");
        if (n) { n.focus(); n.setSelectionRange(keep, keep); }
      });
      setTimeout(function () { inp.focus(); }, 20);
    }
  }

  function searchHits(q) {
    q = (q || "").trim().toLowerCase();
    if (!q) return [];
    var seen = {};
    var out = [];
    function add(mint, name, symbol, sub) {
      if (!mint || seen[mint]) return;
      var hay = ((name || "") + " " + (symbol || "") + " " + mint).toLowerCase();
      if (hay.indexOf(q) < 0) return;
      seen[mint] = true;
      out.push({ mint: mint, name: name || symbol || mint.slice(0, 8), sub: sub || symbol || "" });
    }
    var st = cache.state;
    if (st && Array.isArray(st.agents)) {
      st.agents.forEach(function (a) {
        (a.feed || []).forEach(function (f) { add(f.mint, f.name, f.symbol, f.text || f.reason || ""); });
        if (a.mint) add(a.mint, a.name_of_coin, "", a.headline || a.label || "");
      });
    }
    ((cache.activity && cache.activity.rows) || []).forEach(function (r) {
      add(r.mint, r.title, "", r.subtitle || "");
    });
    AGENT_ORDER.forEach(function (n) {
      var d = cache.decisions[n];
      ((d && d.decisions) || []).forEach(function (x) {
        add(x.mint, x.name, x.symbol, x.reason || x.verdict || "");
      });
    });
    Object.keys(cache.coins).forEach(function (m) {
      var c = cache.coins[m];
      add(m, c.name, c.symbol, c.age || "");
    });
    return out.slice(0, 40);
  }

  /* ---------- Connect (paste-link backup) ---------- */

  function renderConnect() {
    el.stage.innerHTML =
      '<header class="navbar"><div class="navbar-title">Desk</div></header>' +
      '<div class="paste-box" id="dp-paste">' +
        "<p>Open the link from Telegram, or paste it here. The app keeps the private part of the address on this device.</p>" +
        '<input type="url" id="dp-input" placeholder="Paste your Desk link from Telegram" autocomplete="off" autocapitalize="off" spellcheck="false">' +
        '<button type="button" class="connect-btn" id="dp-go">Connect</button>' +
      "</div>";
    var inp = document.getElementById("dp-input");
    var btn = document.getElementById("dp-go");
    function tryConnect() {
      var mm = /(?:#|&|^)d=([A-Za-z0-9_\-]{32,})/.exec((inp.value || "").trim());
      if (!mm) {
        inp.value = "";
        inp.placeholder = "That link has no #d= part, copy it again";
        return;
      }
      try { window.localStorage.setItem(LS_KEY, mm[1]); } catch (e) {}
      writeHash({ s: "home" }, true);
      ui.loading = true;
      render();
      pollState().then(function () { pollHeavy(true); });
    }
    if (btn) btn.addEventListener("click", tryConnect);
    if (inp) inp.addEventListener("keydown", function (e) { if (e.key === "Enter") tryConnect(); });
  }

  /* ---------- Telegram sheets (writes are not faked) ---------- */

  function openSheet(title, body, cmd) {
    if (!el.sheet) return;
    el.sheet.innerHTML = '<div class="sheet-card" role="dialog" aria-modal="true">' +
      '<div class="sheet-handle"></div>' +
      "<h2>" + esc(title) + "</h2>" +
      "<p>" + body + "</p>" +
      (cmd ? '<div class="cmd">' + esc(cmd) + "</div>" : "") +
      '<button type="button" class="ok" data-act="close-sheet">OK</button>' +
    "</div>";
    el.sheet.removeAttribute("hidden");
  }

  function closeSheet() {
    if (!el.sheet) return;
    el.sheet.setAttribute("hidden", "");
    el.sheet.innerHTML = "";
  }

  function toast(msg) {
    var t = document.createElement("div");
    t.className = "copied-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1800);
  }

  function onInvite(url) {
    url = fomoHref(url);
    if (!url) return;
    if (navigator.share) {
      navigator.share({ title: "FOMO", url: url }).catch(function () { copyUrl(url); });
    } else {
      copyUrl(url);
    }
  }

  function copyUrl(url) {
    var done = function () { toast("Link copied"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(function () { fallbackCopy(url, done); });
    } else {
      fallbackCopy(url, done);
    }
  }

  function fallbackCopy(url, done) {
    var ta = document.createElement("textarea");
    ta.value = url;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) {}
    ta.remove();
  }

  /* ---------- events ---------- */

  function onTap(e) {
    var t = e.target;
    if (t.closest && t.closest("#sheet") && t.id === "sheet" || (t === el.sheet)) {
      closeSheet();
      return;
    }
    var node = t.closest("[data-act]");
    if (!node) return;
    var act = node.getAttribute("data-act");
    if (act === "close-sheet") { closeSheet(); return; }
    if (act === "home") { go("home"); return; }
    if (act === "agents") { go("agents", { agent: node.getAttribute("data-agent") || "" }); return; }
    if (act === "activity") { go("activity"); return; }
    if (act === "account") { go("account"); return; }
    if (act === "search") { go("search"); return; }
    if (act === "back") {
      if (window.history.length > 1) history.back();
      else go("home", { replace: true });
      return;
    }
    if (act === "range") {
      var r = node.getAttribute("data-range");
      if (RANGES.indexOf(r) >= 0 && r !== ui.range) {
        ui.range = r;
        writeHash({ s: ui.screen, r: r }, true);
        ensureChart(r);
        render();
      }
      return;
    }
    if (act === "open-coin") {
      var m = node.getAttribute("data-mint");
      if (m) go("coin", { mint: m });
      return;
    }
    if (act === "open-audit") {
      var ma = node.getAttribute("data-mint");
      if (ma) go("audit", { mint: ma });
      return;
    }
    if (act === "settings") {
      go("account", { group: node.getAttribute("data-group") || "" });
      return;
    }
    if (act === "bell") {
      openSheet("Notifications",
        "Pushes come through Telegram on this setup. There is no web-push inbox here.");
      return;
    }
    if (act === "pause") {
      var agent = node.getAttribute("data-agent");
      var locked = node.getAttribute("data-locked") === "1";
      var paused = node.getAttribute("data-paused") === "1";
      var title = AGENT_TITLE[agent] || agent;
      if (locked) {
        openSheet("Risk is locked",
          "Risk cannot be paused while a position is open. Close the position first, then pause it in Telegram.");
        return;
      }
      if (paused) {
        openSheet("Resume " + title,
          "This switch is not changed from the app on this setup. Resume the agent in Telegram.",
          "resume " + title);
      } else {
        openSheet("Pause " + title,
          "This switch is not changed from the app on this setup. Pause the agent in Telegram.",
          "pause " + title);
      }
      return;
    }
    if (act === "mode") {
      var want = node.getAttribute("data-mode");
      var cur = (cache.account && cache.account.mode) || (cache.state && cache.state.mode) || "PAPER";
      if (want === cur) return;
      if (want === "LIVE") {
        openSheet("Switch to LIVE",
          "LIVE is confirmed in Telegram, not from the app on this setup. You will need to type LIVE, and the desk needs at least one full PAPER night.",
          "live");
      } else {
        openSheet("Switch to PAPER",
          "Mode is changed in Telegram on this setup.",
          "paper");
      }
      return;
    }
    if (act === "stack") {
      openSheet("Set stack",
        "The LIVE stack is set in Telegram on this setup. PAPER equity is reconstructed from the starting stack and positions.",
        "stack 1240");
      return;
    }
    if (act === "invite") {
      onInvite(node.getAttribute("data-url"));
      return;
    }
    if (act === "test-push") {
      openSheet("Send test push",
        "Test pushes are sent from Telegram on this setup. Send this command to the desk bot.",
        "test");
      return;
    }
    if (act === "auditor-toggle") {
      openSheet("Take apart before buying",
        "This follows settings.auditor.enabled (on by default). Turning it off is done in Telegram, and the desk asks twice. It is not changed from the app on this setup.",
        "set auditor.enabled");
      return;
    }
  }

  function onTab(e) {
    var btn = e.currentTarget;
    var tab = btn.getAttribute("data-tab");
    if (tab) go(tab);
  }

  /* ---------- render ---------- */

  function render() {
    if (!el.stage) return;
    paintChrome();
    if (!getDataPath()) {
      renderConnect();
      return;
    }
    if (ui.screen === "home") renderHome();
    else if (ui.screen === "agents") renderAgents();
    else if (ui.screen === "activity") renderActivity();
    else if (ui.screen === "account") renderAccount();
    else if (ui.screen === "coin") renderCoin();
    else if (ui.screen === "audit") renderAudit();
    else if (ui.screen === "search") renderSearch();
    else renderHome();
    paintRings();
  }

  /* Fix: leftover "not checked" layers on a finished audit must not hold the beam. */
  var _playAuditBeam = playAuditBeam;
  playAuditBeam = function (audit, mint) {
    var rows = document.querySelectorAll("#disc-list .disc-row");
    if (!rows.length) return;
    var key = mint + ":" + (audit.ts || "");
    var instant = reduced() || auditPlayed[key];
    auditPlayed[key] = true;
    function finish(i) {
      var disc = rows[i] && rows[i].querySelector(".disc");
      if (!disc) return;
      disc.classList.remove("beam");
      var p = disc.getAttribute("data-pass");
      var mark = disc.querySelector(".mark");
      if (p === "1") { disc.classList.add("pass"); if (mark) mark.textContent = "\u2713"; }
      else if (p === "0") { disc.classList.add("fail"); if (mark) mark.textContent = "\u00d7"; }
    }
    if (instant) {
      for (var i = 0; i < rows.length; i++) finish(i);
      return;
    }
    var completed = audit.passed === true || audit.passed === false;
    var step = 0;
    function next() {
      if (step >= rows.length) return;
      var disc = rows[step].querySelector(".disc");
      var p = disc ? disc.getAttribute("data-pass") : "";
      if (p === "" && completed) {
        // Remaining layers were not checked. Leave them grey. Do not invent a colour.
        return;
      }
      if (disc) {
        disc.classList.add("beam");
        var mark = disc.querySelector(".mark");
        if (mark) mark.textContent = "";
      }
      if (p === "") {
        // Live audit still in flight: wait on this layer.
        setTimeout(next, 250);
        return;
      }
      setTimeout(function () {
        finish(step);
        step += 1;
        setTimeout(next, 150);
      }, 350);
    }
    next();
  };

  /* ---------- resize / charts ---------- */

  var resizeTick = null;
  function onResize() {
    if (resizeTick) cancelAnimationFrame(resizeTick);
    resizeTick = requestAnimationFrame(function () {
      if (ui.screen === "home") {
        paintHomeChart();
        var o = document.getElementById("odo");
        if (o && cache.state) fitOdo(o);
      }
      if (ui.screen === "coin") {
        var c = document.getElementById("coin-chart");
        var coin = ui.mint && cache.coins[ui.mint];
        if (c && coin && globalThis.DeskCharts) {
          var exitPx = coin.exit_line && coin.exit_line.price;
          DeskCharts.drawCandles(c, {
            candles: coin.candles || [],
            exitLine: exitPx,
            exitLabel: (coin.exit_line && coin.exit_line.label) || "Risk trailing stop"
          });
        }
      }
      paintRings();
    });
  }

  /* ---------- boot ---------- */

  function startPolls() {
    if (timers.state) clearInterval(timers.state);
    if (timers.heavy) clearInterval(timers.heavy);
    timers.state = setInterval(pollState, STATE_MS);
    timers.heavy = setInterval(function () { pollHeavy(true); }, HEAVY_MS);
  }

  function boot() {
    el.app = document.getElementById("app");
    el.stage = document.getElementById("stage");
    el.tabbar = document.getElementById("tabbar");
    el.offline = document.getElementById("offline-bar");
    el.sheet = document.getElementById("sheet");

    stashDataPath();
    applyHash();

    el.tabbar.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", onTab);
    });
    el.app.addEventListener("click", onTap);
    window.addEventListener("popstate", function () {
      applyHash();
      render();
      onScreenOpen(ui.screen);
    });
    window.addEventListener("hashchange", function () {
      var had = !!getDataPath();
      stashDataPath();
      if (getDataPath() && !had) {
        ui.loading = true;
        applyHash();
        render();
        pollState().then(function () { return pollHeavy(true); }).then(function () {
          onScreenOpen(ui.screen);
        });
        startPolls();
      }
    });
    window.addEventListener("resize", onResize);
    window.addEventListener("pageshow", function () { stashDataPath(); });

    render();
    if (getDataPath()) {
      pollState().then(function () { return pollHeavy(true); }).then(function () {
        onScreenOpen(ui.screen);
      });
      startPolls();
    }
  }

  window.__desk = {
    pollNow: function () { return pollState().then(function () { return pollHeavy(true); }); },
    go: go,
    cache: cache,
    ui: ui,
    render: render,
    stopPolls: function () {
      if (timers.state) { clearInterval(timers.state); timers.state = null; }
      if (timers.heavy) { clearInterval(timers.heavy); timers.heavy = null; }
      if (timers.retry) { clearTimeout(timers.retry); timers.retry = null; }
      if (timers.retryTick) { clearInterval(timers.retryTick); timers.retryTick = null; }
    },
    startPolls: startPolls,
    markFail: markFail,
    paintOffline: paintOffline
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
