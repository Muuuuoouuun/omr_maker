const CACHE_VERSION = "omr-maker-v10";
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const CACHE_FIRST_PATHS = new Set([
  "/offline.html",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icon.png",
  "/logo.png",
  "/apple-touch-icon.png",
  "/browserconfig.xml",
  "/pdf.worker.min.mjs",
  "/screenshots/omr-mobile-home.jpg",
  "/screenshots/omr-wide-home.jpg",
]);

const APP_SHELL = [
  "/",
  "/pwa-check",
  "/offline.html",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icon.png",
  "/logo.png",
  "/pdf.worker.min.mjs",
  "/apple-touch-icon.png",
  "/browserconfig.xml",
  "/screenshots/omr-mobile-home.jpg",
  "/screenshots/omr-wide-home.jpg",
  "/icons/favicon-16.png",
  "/icons/favicon-32.png",
  "/icons/favicon-48.png",
  "/icons/icon-48.png",
  "/icons/icon-72.png",
  "/icons/icon-96.png",
  "/icons/icon-128.png",
  "/icons/icon-144.png",
  "/icons/icon-152.png",
  "/icons/icon-167.png",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-384.png",
  "/icons/icon-512.png",
  "/icons/maskable-icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/mstile-150.png",
];
const NAVIGATION_CACHE_PATHS = new Set([
  "/",
  "/pwa-check",
  "/student/dashboard",
  "/student/history",
]);
const NAVIGATION_CACHE_PREFIXES = [
  "/solve/",
  "/student/review/",
];

function rememberRuntimeResponse(request, response) {
  if (!response.ok) return Promise.resolve();

  const copy = response.clone();
  return caches.open(RUNTIME_CACHE)
    .then(cache => cache.put(request, copy))
    .catch(() => undefined);
}

function canRememberNavigation(pathname) {
  return NAVIGATION_CACHE_PATHS.has(pathname)
    || NAVIGATION_CACHE_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

async function readNavigationFallback(request, url) {
  const cached = await caches.match(request);
  if (cached) return cached;

  if (url.pathname === "/") {
    const cachedHome = await caches.match("/");
    if (cachedHome) return cachedHome;
  }

  if (url.pathname === "/pwa-check") {
    const cachedPwaCheck = await caches.match("/pwa-check");
    if (cachedPwaCheck) return cachedPwaCheck;
  }

  if (canRememberNavigation(url.pathname)) {
    const cachedHome = await caches.match("/");
    if (cachedHome) return cachedHome;
  }

  return caches.match("/offline.html");
}

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith("omr-maker-") && ![APP_SHELL_CACHE, RUNTIME_CACHE].includes(key))
          .map(key => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", event => {
  if (event.data?.type !== "OMR_SKIP_WAITING") return;
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_next/webpack-hmr")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (canRememberNavigation(url.pathname)) {
            event.waitUntil(rememberRuntimeResponse(request, response));
          }
          return response;
        })
        .catch(async () => {
          return readNavigationFallback(request, url);
        }),
    );
    return;
  }

  if (
    url.pathname.startsWith("/_next/static/")
    || url.pathname.startsWith("/icons/")
    || url.pathname.startsWith("/startup/")
    || CACHE_FIRST_PATHS.has(url.pathname)
  ) {
    event.respondWith(
      caches.match(request).then(async cached => {
        const refresh = fetch(request).then(response => {
          rememberRuntimeResponse(request, response);
          return response;
        });

        if (cached) {
          refresh.catch(() => undefined);
          return cached;
        }

        try {
          return await refresh;
        } catch (error) {
          const shellFallback = await caches.match(url.pathname);
          if (shellFallback) return shellFallback;
          throw error;
        }
      }),
    );
  }
});
