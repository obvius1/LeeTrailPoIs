/**
 * Service Worker — zorgt voor 100% offline werking
 *
 * Strategie: bij installatie alles pre-cachen (foto's + tiles + data).
 * Daarna: cache-first voor alle requests.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `peaks-pois-${CACHE_VERSION}`;

// Bestanden die altijd pre-gecached worden (app shell)
const PRECACHE_STATIC = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/leaflet.min.js',
  '/leaflet.css',
  '/manifest.webmanifest',
  '/data.json',
  '/map-tiles.json',
];

// ── Install: pre-cache app shell ──────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // App shell
      await cache.addAll(PRECACHE_STATIC);

      // Laad data.json om alle assets te kennen
      try {
        const res = await fetch('/data.json');
        const data = await res.json();
        const assets = [];

        for (const poi of data.pois ?? []) {
          if (poi.tile) assets.push('/' + poi.tile);
          for (const photo of poi.photos ?? []) {
            assets.push('/' + photo);
          }
        }

        // Cache in batches van 50 om geen timeout te triggeren
        for (let i = 0; i < assets.length; i += 50) {
          const batch = assets.slice(i, i + 50);
          await Promise.allSettled(batch.map(url => cache.add(url).catch(() => {})));
        }

        console.log(`[SW] ${assets.length} POI-assets gecached`);

        // Pre-cache kaart-tiles (zoom 12-14, gegenereerd door build)
        try {
          const tilesRes = await fetch('/map-tiles.json');
          const tileUrls = await tilesRes.json();
          let tilesDone = 0;
          for (let i = 0; i < tileUrls.length; i += 20) {
            const batch = tileUrls.slice(i, i + 20);
            await Promise.allSettled(batch.map(url => cache.add(url).catch(() => {})));
            tilesDone += batch.length;
          }
          console.log(`[SW] ${tilesDone} kaart-tiles gecached`);
        } catch (err) {
          console.warn('[SW] Kaart-tiles pre-cachen mislukt (geen internet?):', err.message);
        }
      } catch (err) {
        console.warn('[SW] Kon assets niet pre-cachen:', err.message);
      }
    })
  );

  // Activeer direct (geen wachten op oude tab)
  self.skipWaiting();
});

// ── Activate: oude caches opruimen ────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('peaks-pois-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: cache-first ────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  // Enkel GET requests cachen
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // Niet in cache — probeer netwerk en cache het resultaat
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Volledig offline en niet in cache — geef een fallback
        return new Response(
          '<h2>Offline</h2><p>Dit bestand is niet gecached. Verbind internet voor de eerste keer.</p>',
          { headers: { 'Content-Type': 'text/html' } }
        );
      });
    })
  );
});
