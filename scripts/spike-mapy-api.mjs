/**
 * Spike-script: bevestig dat de Mapy.cz review-API werkt.
 * Gebruik: npm run spike
 *
 * Bevestigde endpoint (gevonden via DevTools):
 *   GET https://mapy.com/api/reviews/v1/review/poi/osm/{osm_id}
 *       ?offset=0&limit=50&lang=en&forceTranslation=true
 *
 * Dit script test die endpoint met echte OSM-IDs langs de Peaks of the Balkans.
 * Als je groene vinkjes ziet, is stap 3 klaar om de volledige build te draaien.
 */

import { fetchWithRetry, log, ok, warn, sleep } from './utils.mjs';

const TEST_CASES = [
  { osm_type: 'node', osm_id: 5765131862, name: 'Guesthouse Gjelaj — Valbona (AL)' },
  { osm_type: 'node', osm_id: 6038484760, name: 'Camping Theth (AL)' },
  { osm_type: 'node', osm_id: 5765131860, name: 'Guesthouse Rexhaj — Valbona (AL)' },
];

const BASE = 'https://mapy.com/api/reviews/v1/review/poi/osm';
const PARAMS = 'offset=0&limit=50&lang=en&bestReviewsOnly=false&filterByLang=false&forceTranslation=true';

log('═══════════════════════════════════════════════════════');
log(' Mapy.cz Review API — bevestigingstest                 ');
log(' Endpoint: GET /api/reviews/v1/review/poi/osm/{id}     ');
log('═══════════════════════════════════════════════════════\n');

let totalOk = 0;
let totalReviews = 0;
let totalPhotos = 0;

for (const tc of TEST_CASES) {
  const url = `${BASE}/${tc.osm_id}?${PARAMS}`;
  log(`\n── ${tc.name}`);
  log(`   OSM: ${tc.osm_type}/${tc.osm_id}`);
  log(`   URL: ${url}`);

  try {
    const res = await fetchWithRetry(url, {
      headers: { 'Referer': 'https://mapy.com/', 'Accept': 'application/json' },
    });

    log(`   Status: ${res.status}`);

    if (res.status === 404) {
      warn('   POI niet gevonden op Mapy.cz (OSM-ID bestaat niet in hun database)');
      log('   → Probeer de ID op te zoeken op openstreetmap.org');
      continue;
    }

    if (!res.ok) {
      warn(`   Onverwachte fout ${res.status}`);
      continue;
    }

    const data = await res.json();
    const reviews = data.reviews ?? [];
    const photos  = reviews.flatMap(r => r.gallery ?? []).filter(g => g.status === 'approved');

    ok(`   ✓ ${data.total ?? reviews.length} review(s) | ` +
       `${data.review_rating_stars?.toFixed(1) ?? '?'}★ | ` +
       `${photos.length} foto(s)`);

    // Toon de eerste review als voorbeeld
    if (reviews.length > 0) {
      const r = reviews[0];
      const preview = (r.text ?? '').slice(0, 120);
      log(`   Voorbeeld [${r.lang?.toUpperCase() ?? '?'} ${r.native ? '(origineel)' : '(vertaald)'}]:`);
      log(`   "${preview}${preview.length >= 120 ? '…' : ''}"`);
    }

    // Toon een foto-URL-voorbeeld
    if (photos.length > 0) {
      const resolved = photos[0].urls.default
        .replace('{width}', '800')
        .replace('{height}', '600');
      log(`   Foto-voorbeeld: ${resolved}`);
    }

    totalOk++;
    totalReviews += data.total ?? reviews.length;
    totalPhotos  += photos.length;

  } catch (err) {
    warn(`   Fout: ${err.message}`);
  }

  await sleep(600);
}

log('\n═══════════════════════════════════════════════════════');
if (totalOk === TEST_CASES.length) {
  ok(`Alle ${totalOk}/${TEST_CASES.length} testlocaties bereikbaar ✓`);
  ok(`Totaal: ${totalReviews} reviews, ${totalPhotos} foto's`);
  log('\n🚀  Klaar voor de volledige build:');
  log('   1. Zorg dat data/route.gpx aanwezig is');
  log('   2. Vul .env in met je MAPY_API_KEY (en optioneel DEEPL_API_KEY)');
  log('   3. npm run build');
} else if (totalOk > 0) {
  warn(`${totalOk}/${TEST_CASES.length} locaties bereikbaar — OSM-IDs controleren voor de rest`);
  log('De build werkt ook als sommige POIs niet op Mapy.cz staan → worden overgeslagen.');
} else {
  warn('Geen enkele locatie bereikbaar.');
  warn('Mogelijke oorzaken:');
  warn('  1. Geen internetverbinding');
  warn('  2. Mapy.cz heeft de endpoint gewijzigd');
  warn('  3. Rate-limiting / tijdelijke storing');
  warn('Probeer in een paar minuten opnieuw, of open de URL handmatig in je browser.');
}
log('═══════════════════════════════════════════════════════\n');
