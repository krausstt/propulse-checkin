/**
 * sw.js - caches the app shell so the booth survives a dead venue WiFi.
 *
 * WHAT THIS FILE MUST NEVER DO
 * It must never go near ws://localhost:9998. Local network requests from a
 * service worker fail by specification, which is why the socket lives in the
 * foreground document. A service worker that tried to "help" with the scanner
 * link would fail in a way that looks exactly like an LNA block.
 *
 * It also never caches registrant data. The roster arrives either as the
 * bundled synthetic sample or from a file the technician picks on the phone,
 * and lives in IndexedDB. Nothing with a real visitor name in it passes here.
 *
 * Strategy: stale-while-revalidate. The booth gets an instant, offline-capable
 * load, and a new deploy is picked up on the following launch. Cache-first with
 * no revalidation would strand five SureMDM phones on a stale build with no way
 * to push them forward; network-first would stall the booth every time the
 * venue WiFi went sideways.
 */

const VERSION = 'v1';
const CACHE = `propulse-shell-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
  'demo-roster.sample.json',
  'src/mai.js',
  'src/ws.js',
  'src/scan.js',
  'src/roster.js',
  'src/outbox.js',
  'src/idb.js',
];

self.addEventListener('install', event => {
  // addAll is all-or-nothing: one 404 would leave the booth with no cache at
  // all and no clue why, so each asset is cached independently.
  event.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(e => console.warn('precache miss', u, e)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;

  // Only ever our own GETs. Anything cross-origin, and every non-GET (the
  // check-in POST above all), goes straight to the network untouched.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then(res => {
          if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => null);

      // Serve the cache immediately when we have it, refresh in the background.
      if (cached) { event.waitUntil(network); return cached; }

      const fresh = await network;
      if (fresh) return fresh;

      // Offline, first launch, nothing cached. A navigation gets the shell if
      // we somehow have it; otherwise be honest rather than hang.
      if (request.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      return new Response('offline and not cached', { status: 503, statusText: 'offline' });
    })
  );
});

/** Escape hatch. If a bad shell ever ships to the phones, the page can post
 *  {type:'PURGE'} to drop every cache and unregister, instead of somebody
 *  clearing site data on five managed devices by hand. */
self.addEventListener('message', event => {
  if (event.data?.type === 'PURGE') {
    event.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => self.registration.unregister())
        .then(() => self.clients.matchAll())
        .then(cs => cs.forEach(c => c.navigate(c.url)))
    );
  }
});
