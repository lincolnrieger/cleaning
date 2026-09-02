// Service worker: makes the app installable and gives it a usable offline
// shell. It deliberately never touches /api/ - cleaning data is always live,
// never cached, so nobody acts on a stale checklist.
//
// Shell files race the network against the cache. Network-first with no time
// limit was the wrong trade: the fallback only fired on a network *error*,
// never on a slow one, so a phone on weak camp signal sat on "Loading…"
// waiting for a 140KB app.js it already had a perfectly good copy of. Now the
// network gets NET_MS to win; after that the cached copy is served and the
// network response, whenever it lands, refreshes the cache for next time.
//
// The cost is that a deploy can be one load late on a slow connection. That is
// worth it: nobody stands in a wet bathroom watching a spinner to be sure they
// have this morning's build.
// Bump CACHE when the shell's file list changes.
const CACHE = 'bc-shell-v6';
const NET_MS = 2000;
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

  const network = fetch(event.request).then((res) => {
    // Only a real, successful, same-origin response is worth keeping. A 404 or
    // a 500 - which is what a request mid-deploy can come back as - used to be
    // cached like any other, and a cached 404 for /app.js leaves the page
    // sitting on "Loading…" until the cache is cleared.
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(event.request, copy));
    }
    return res;
  });
  // A rejection is handled below, but only on the path that waits for it; this
  // keeps a late failure from surfacing as an unhandled rejection.
  network.catch(() => {});

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (!cached) return network; // nothing to fall back to, so wait for it

    let timer;
    const patience = new Promise((resolve) => {
      timer = setTimeout(() => resolve(cached), NET_MS);
    });
    try {
      return await Promise.race([network.catch(() => cached), patience]);
    } finally {
      clearTimeout(timer);
    }
  })());
});
