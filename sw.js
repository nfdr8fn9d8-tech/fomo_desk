/* Service worker (STEP 8 PUSH). On plan A it would handle web-push clicks
   (opening links.coin_url) and a thin app-shell cache. Plan B has no web
   push — Telegram is the notifier — so this file is a no-op install. */
self.addEventListener("install", function (event) {
  self.skipWaiting();
});
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});
