/**
 * Spike-script: test of de Mapy.cz review-API bereikbaar is.
 *
 * Gebruik: npm run spike
 *
 * Test met een bekende camping langs de Peaks of the Balkans route
 * (OSM node ID van "Camping Babino Polje" of andere bekende plek).
 * Geeft duidelijke output zodat je kunt bepalen welk endpoint werkt.
 */

import { fetchWithRetry, log, ok, warn } from './utils.mjs';

// Testlocatie: bekende camping op de Peaks of the Balkans route
// OSM-IDs hier aanpassen naar een plek die jij kent op Mapy.cz
const TEST_CASES = [
  { osm_type: 'node', osm_id: 1234567,  name: 'Test node (pas ID aan)' },
  { osm_type: 'way',  osm_id: 12345678, name: 'Test way (pas ID aan)'  },
];

// Hoe OSM-IDs vinden?
// 1. Ga naar https://www.openstreetmap.org
// 2. Zoek een camping langs de Peaks of the Balkans route
// 3. Klik op de camping → zie URL: /node/12345678 of /way/12345678
// 4. Vervang de ID hierboven

log('═══════════════════════════════════════════');
log(' Mapy.cz API Spike — endpoint discovery    ');
log('═══════════════════════════════════════════\n');

for (const tc of TEST_CASES) {
  log(`\nTest: ${tc.name} (${tc.osm_type} ${tc.osm_id})`);

  // ── Test 1: HTML pagina ───────────────────────────────────────────────────
  const nodeType = tc.osm_type === 'node' ? 'N' : tc.osm_type === 'way' ? 'W' : 'R';
  const htmlUrl = `https://mapy.com/en/place/osm-${nodeType}${tc.osm_id}/`;

  log(`\n[HTML] ${htmlUrl}`);
  try {
    const res = await fetchWithRetry(htmlUrl, { headers: { 'Accept': 'text/html' } });
    log(`  Status: ${res.status}`);
    if (res.ok) {
      const html = await res.text();
      const hasJsonLd = html.includes('application/ld+json');
      const has404 = html.includes('"statusCode":404') || html.toLowerCase().includes('page not found');
      log(`  Lengte: ${html.length} tekens`);
      log(`  JSON-LD gevonden: ${hasJsonLd}`);
      log(`  404-indicatie: ${has404}`);
      if (hasJsonLd && !has404) ok('  → HTML-scraping zou werken voor deze POI');
    }
  } catch (err) {
    warn(`  Fout: ${err.message}`);
  }

  // ── Test 2: Kandidaat-API endpoints ──────────────────────────────────────
  const candidates = [
    `https://api.mapy.com/v1/poi/reviews?source=osm&osmType=${tc.osm_type}&id=${tc.osm_id}&lang=en`,
    `https://api.mapy.com/v1/poi/${tc.osm_id}/reviews?source=osm`,
    `https://pro.mapy.cz/api/reviews?source=osm&id=${tc.osm_id}`,
    `https://pro.mapy.cz/review?service=place&operation=list&source=osm&id=${tc.osm_id}`,
    `https://api.mapy.cz/v1/poi?source=osm&id=${tc.osm_id}`,
  ];

  for (const url of candidates) {
    log(`\n[API] ${url}`);
    try {
      const res = await fetchWithRetry(url, {
        headers: { 'Referer': htmlUrl, 'Accept': 'application/json' }
      });
      log(`  Status: ${res.status}`);
      if (res.ok) {
        const text = await res.text();
        log(`  Lengte: ${text.length} tekens`);
        log(`  Preview: ${text.slice(0, 200)}`);
        ok(`  ✓ DIT ENDPOINT WERKT! Voeg het toe bovenaan de candidates-lijst in 3-fetch-reviews.mjs`);
        break;
      }
    } catch (err) {
      warn(`  Fout: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

log('\n═══════════════════════════════════════════');
log('Tip: als geen enkel endpoint werkt, gebruik');
log('DevTools (F12 → Network) op mapy.com.');
log('Zie SPIKE.md voor gedetailleerde instructies.');
log('═══════════════════════════════════════════\n');
