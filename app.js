/* STEP 3 / STEP 8 app shell. Plan B: poll JSON under the public Supabase
   prefix /d/{DATA_PATH}/state.json. DATA_PATH comes from the #d= fragment,
   then localStorage. No keys and no token in these files.
   Full screens, odometer, SSE (plan A) and Account settings land later. */
(function () {
  "use strict";

  var SUPABASE_URL = "https://ibfqospmcpiuwemxoqbo.supabase.co";
  var BUCKET = "desk";
  var POLL_MS = 15000;
  var LS_KEY = "desk_data_path";

  function stashDataPath() {
    var hash = window.location.hash || "";
    var m = /(?:^|#|&)d=([^&]+)/.exec(hash);
    if (m && m[1]) {
      try { window.localStorage.setItem(LS_KEY, m[1]); } catch (e) {}
      // Keep the fragment: an iOS Home Screen app has its own storage, so the
      // saved Home Screen URL must still carry #d= for the first launch.
    }
  }

  function getDataPath() {
    try { return window.localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; }
  }

  function $(id) {
    return document.getElementById(id);
  }

  function formatUsd(n) {
    var v = Number(n);
    if (!isFinite(v)) return "—";
    return "$" + v.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function setOffline(on) {
    var app = $("app");
    var status = $("conn-status");
    if (app) app.classList.toggle("offline", !!on);
    if (status) {
      if (on) status.removeAttribute("hidden");
      else status.setAttribute("hidden", "");
    }
  }

  function setEmpty(text) {
    var el = $("empty-msg");
    if (el) el.textContent = text || "";
  }

  function applyState(state) {
    if (!state || typeof state !== "object") return;
    if (state.balance != null) {
      var bal = $("balance");
      if (bal) bal.textContent = formatUsd(state.balance);
    }
    if (state.mode) {
      var badge = $("paper-badge");
      if (badge) badge.textContent = String(state.mode);
    }
    setEmpty("");
    setOffline(false);
  }


  // Backup when a Home Screen launch has no #d= (iOS can drop it): paste the
  // Telegram link once; only the d= part is kept, in this app's own storage.
  function showPasteBox() {
    if (document.getElementById("dp-paste")) return;
    var home = document.getElementById("home");
    if (!home) return;
    var box = document.createElement("div");
    box.id = "dp-paste";
    box.style.cssText = "margin:24px 16px;display:flex;flex-direction:column;gap:10px";
    var inp = document.createElement("input");
    inp.type = "url"; inp.placeholder = "Paste your Desk link from Telegram";
    inp.autocomplete = "off"; inp.autocapitalize = "off"; inp.spellcheck = false;
    inp.style.cssText = "background:#1c1c1e;color:#fff;border:0;border-radius:10px;padding:12px;font-size:16px";
    var btn = document.createElement("button");
    btn.type = "button"; btn.textContent = "Connect";
    btn.style.cssText = "background:#0a84ff;color:#fff;border:0;border-radius:10px;padding:12px;font-size:17px;font-weight:600";
    btn.addEventListener("click", function () {
      var mm = /(?:#|&|^)d=([A-Za-z0-9_\-]{32,})/.exec((inp.value || "").trim());
      if (!mm) { inp.value = ""; inp.placeholder = "That link has no #d= part, copy it again"; return; }
      try { window.localStorage.setItem(LS_KEY, mm[1]); } catch (e) {}
      box.remove(); setEmpty("Waiting for the first trade"); poll();
    });
    box.appendChild(inp); box.appendChild(btn); home.appendChild(box);
  }

  function poll() {
    var dp = getDataPath();
    if (!dp) {
      setEmpty("Open the link from Telegram"); showPasteBox();
      setOffline(false);
      return;
    }
    var url = SUPABASE_URL +
      "/storage/v1/object/public/" + BUCKET +
      "/d/" + encodeURIComponent(dp) +
      "/state.json?ts=" + Date.now();
    fetch(url, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("http " + res.status);
        return res.json();
      })
      .then(function (state) {
        applyState(state);
      })
      .catch(function () {
        // Keep the last rendered value; only show a subtle offline state.
        setOffline(true);
      });
  }

  stashDataPath();

  if (!getDataPath()) {
    setEmpty("Open the link from Telegram"); showPasteBox();
  } else {
    setEmpty("Waiting for the first trade");
  }

  poll();
  setInterval(poll, POLL_MS);

  document.querySelectorAll(".tabbar button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".tabbar button").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
    });
  });
})();
