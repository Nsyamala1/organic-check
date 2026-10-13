/* Organic Check offline support: app shell from cache, product lookups fall back to the last copy seen. */
const VERSION = "oc-v1";
const SHELL = ["/", "/barcode-detector.js", "/plu-data.js", "/manifest.webmanifest", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function networkFirst(req) {
  return fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreVary: true }).then((hit) => hit || Promise.reject(new Error("offline"))));
}
function staleWhileRevalidate(req) {
  return caches.match(req).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith("/api/")) return;
    if (req.mode === "navigate") { e.respondWith(networkFirst(new Request("/", { credentials: "same-origin" }))); return; }
    e.respondWith(staleWhileRevalidate(req));
    return;
  }
  if (url.hostname === "world.openfoodfacts.org" && url.pathname.startsWith("/api/v2/product/")) { e.respondWith(networkFirst(req)); return; }
  if (url.hostname === "images.openfoodfacts.org" || url.hostname === "fonts.gstatic.com" || url.hostname === "fonts.googleapis.com") { e.respondWith(staleWhileRevalidate(req)); }
});
