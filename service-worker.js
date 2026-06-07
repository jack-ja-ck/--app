const CACHE_NAME = "worship-app-v21";
const NETWORK_FIRST_PATHS = [
  "/index.html",
  "/app.js",
  "/style.css",
  "/service-worker.js",
  "index.html",
  "app.js",
  "style.css",
  "service-worker.js"
];

function isNetworkFirstRequest(url) {
  try {
    const path = new URL(url).pathname || "";
    const base = path.split("/").pop() || path;
    return NETWORK_FIRST_PATHS.some((p) => path.endsWith(p) || base === p.replace(/^\//, ""));
  } catch (_e) {
    return false;
  }
}
const ASSETS = [
  "index.html",
  "manifest.json",
  "manifest.github.json",
  "robots.txt",
  "sitemap.xml",
  "app.js",
  "style.css",
  "cross.jpg",
  "icons/favicon.ico",
  "icons/favicon.svg",
  "icons/favicon-dark.svg",
  "icons/favicon-16x16.png",
  "icons/favicon-32x32.png",
  "icons/favicon-48x48.png",
  "icons/logo.svg",
  "icons/logo-dark.svg",
  "icons/apple-touch-icon.png",
  "icons/android-chrome-192x192.png",
  "icons/android-chrome-512x512.png",
  "js/utils.js",
  "js/state.js",
  "js/router.js",
  "js/ui.js",
  "js/data.js",
  "js/actions.js",
  "js/fonts.js",
  "js/font-loader.js"
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
  if (event.request.method !== "GET") return;
  const url = event.request.url;
  if (isNetworkFirstRequest(url)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(caches.match(event.request).then((cachedResponse) => cachedResponse || fetch(event.request)));
});
