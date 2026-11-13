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
      // Drop the fragment so the path is not left in the URL bar or history share.
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
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

  function poll() {
    var dp = getDataPath();
    if (!dp) {
      setEmpty("Open the link from Telegram");
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
    setEmpty("Open the link from Telegram");
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
