/* Simple runtime-caching service worker.
 * Keeps the app usable offline after the first successful load.
 */

const CACHE_NAME = 'tube-map-v1';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Activate immediately so users get offline support on first install.
    self.skipWaiting();
    const cache = await caches.open(CACHE_NAME);
    // Pre-cache the app shell entry points. Other assets are cached at runtime.
    await cache.addAll(['./', './index.html', './manifest.webmanifest', './london-tube.json']);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    self.clients.claim();
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== CACHE_NAME)
        .map((k) => caches.delete(k)),
    );
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET for same-origin.
  if (req.method !== 'GET') {
    return;
  }
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  const isNav = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    if (isNav) {
      try {
        const fresh = await fetch(req);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cached = await cache.match('./index.html');
        return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    }

    const cached = await cache.match(req);
    if (cached) {
      return cached;
    }

    const res = await fetch(req);
    // Cache successful same-origin responses.
    if (res && res.ok) {
      cache.put(req, res.clone());
    }
    return res;
  })());
});

