// Household Hub service worker: installable PWA and an offline fallback for the app shell.
// API responses are never cached — inventory must always come live from Grocy.
const CACHE = "hub-shell-v1";
const SHELL = ["/icons/icon-192.png", "/icons/icon-512.png", "/zxing/zxing_reader.wasm"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Immutable build assets and the decoder: cache first.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/zxing/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            const copy = res.clone();
            if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // Pages: network first, fall back to the last copy when offline.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          if (res.ok && !res.redirected) caches.open(CACHE).then((c) => c.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request).then((hit) => hit || new Response("Offline — reconnect to the home network.", { status: 503, headers: { "Content-Type": "text/plain" } }))),
    );
  }
});
