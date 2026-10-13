const SHELL = 'shell-v1';
const APPS = 'apps-v1';
const SHELL_FILES = ['/', '/launcher.js', '/style.css', '/manifest.webmanifest', '/icon.svg', '/api/tools'];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== APPS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Drop cached files of superseded tool versions.
self.addEventListener('message', (e) => {
  const { type, prefix, keep } = e.data ?? {};
  if (type !== 'prune' || !prefix?.startsWith('/apps/')) return;
  e.waitUntil(
    caches.open(APPS).then(async (cache) => {
      for (const req of await cache.keys()) {
        const p = new URL(req.url).pathname;
        if (p.startsWith(prefix) && !p.startsWith(keep)) await cache.delete(req);
      }
    }),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  const parts = url.pathname.split('/');
  // /apps/<tool>/<version>/... is immutable, so the cache can win.
  if (parts[1] === 'apps' && parts[3]) return e.respondWith(cacheFirst(request));
  if (url.pathname === '/api/versions' || SHELL_FILES.includes(url.pathname)) {
    return e.respondWith(networkFirst(request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(APPS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.status === 200) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request, { ignoreSearch: true });
  try {
    // Only race a timeout when there is something to fall back to.
    const res = await (cached
      ? Promise.race([fetch(request), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), NETWORK_TIMEOUT_MS))])
      : fetch(request));
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}
