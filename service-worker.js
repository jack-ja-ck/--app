const CACHE_NAME = "worship-app-v2";
const ASSETS = [
  "./",
  "index.html",
  "app.js",
  "style.css",
  "cross.jpg",
  "js/utils.js",
  "js/state.js",
  "js/router.js",
  "js/ui.js",
  "js/data.js",
  "js/actions.js",
  "js/fonts.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("缓存核心文件...");
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
});
