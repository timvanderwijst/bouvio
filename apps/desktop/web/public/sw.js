// Cuna web: keeps the app shell so the app starts offline. Hub calls
// (REST, the WebSocket) always go to the network and are never cached.
const CACHE = "cuna-shell-v1";
const SCOPE = new URL(self.registration.scope);
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      // Also take the hashed bundles the shell points at.
      const html = await (await cache.match("./"))?.text();
      const assets = [...new Set((html ?? "").match(/assets\/[\w.-]+\.(?:js|css)/g) ?? [])];
      await cache.addAll(assets).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;

  // Pages: the newest from the network, the cached shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && url.pathname === SCOPE.pathname) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("./", copy));
          }
          return res;
        })
        .catch(async () => (await caches.match("./")) ?? Response.error()),
    );
    return;
  }

  // Hashed bundles and icons never change under the same name: cache first.
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
