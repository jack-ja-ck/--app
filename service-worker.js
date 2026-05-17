const CACHE_NAME = "worship-app-v6";
const ASSETS = [
  "index.html",
  "manifest.json",
  "manifest.github.json",
  "app.js",
  "style.css",
  "cross.jpg",
  "icon-192.png",
  "icon-512.png",
  "js/utils.js",
  "js/state.js",
  "js/router.js",
  "js/ui.js",
  "js/data.js",
  "js/actions.js",
  "js/fonts.js"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[SW] 缓存核心文件…");
      return Promise.all(
        ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn("[SW] 跳过缓存:", url, err);
          })
        )
      );
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => cachedResponse || fetch(event.request))
  );
});
