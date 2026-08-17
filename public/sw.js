// Service worker: makes the app installable and gives it a usable offline
// shell. It deliberately never touches /api/ - cleaning data is always live,
// never cached, so nobody acts on a stale checklist.
//
// Shell files use network-first, not cache-first: on a phone that's rarely
// offline, that means everyone gets the latest deploy immediately, and the
// cache only kicks in as a fallback when there's genuinely no connection.
// Bump CACHE when the shell's file list changes.
const CACHE = 'bc-shell-v5';
const SHELL = [
  '/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest', '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return; // always live, never cached

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Only a real, successful, same-origin response is worth keeping. A
        // 404 or a 500 - which is what a request mid-deploy can come back as -
        // used to be cached like any other, and a cached 404 for /app.js
        // leaves the page sitting on "Loading…" until the cache is cleared.
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
