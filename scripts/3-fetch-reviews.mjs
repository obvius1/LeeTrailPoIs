/**
 * Stap 3 — Mapy.cz reviews + foto-URLs ophalen
 *
 * Gebruikt de bevestigde endpoint (gevonden via DevTools):
 *   GET https://mapy.com/api/reviews/v1/review/poi/osm/{osm_id}
 *       ?offset=0&limit=50&lang=en&bestReviewsOnly=false
 *       &filterByLang=false&forceTranslation=true
 *
 * forceTranslation=true → Mapy.cz vertaalt zelf al naar Engels.
 * DeepL is daarvoor NIET meer nodig voor reviews.
 * (Stap 5 gebruikt DeepL nog voor OSM-beschrijvingen in lokale talen.)
 *
 * Foto-URLs zitten in reviews[].gallery[].urls.default als URL-template
 * met {width} en {height} placeholders → worden opgelost in stap 4.
 *
 * Output: cache/details/{osm_type}-{osm_id}.json  (per POI, resume-vriendelijk)
 *         cache/pois-with-reviews.json             (alles samen)
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import pLimit from 'p-limit';
import { log, ok, warn, cacheRead, cacheWrite, cacheExists, fetchWithRetry, sleep, CACHE_DIR } from './utils.mjs';

const DETAILS_DIR = join(CACHE_DIR, 'details');
mkdirSync(DETAILS_DIR, { recursive: true });

const CONCURRENCY = 3;
const DELAY_MS = 800;
const REVIEWS_PER_PAGE = 50;
const limit = pLimit(CONCURRENCY);

// ── Mapy.cz review-API (bevestigd via DevTools) ───────────────────────────────

/**
 * Haalt alle reviews op voor één OSM-ID.
 * Pagineert automatisch als total > REVIEWS_PER_PAGE.
 * @returns { rating_stars, rating_100, total, reviews[], photo_urls[] }
 */
async function fetchMapyReviews(osmId) {
  const base = `https://mapy.com/api/reviews/v1/review/poi/osm/${osmId}`;
  const params = new URLSearchParams({
    lang: 'en',
    bestReviewsOnly: 'false',
    filterByLang: 'false',
    forceTranslation: 'true',
  });

  let allReviews = [];
  let meta = {};
  let offset = 0;

  while (true) {
    params.set('offset', String(offset));
    params.set('limit', String(REVIEWS_PER_PAGE));
    const url = `${base}?${params}`;

    try {
      const res = await fetchWithRetry(url, {
        headers: {
          'Referer': 'https://mapy.com/',
          'Accept': 'application/json',
        },
      });

      if (res.status === 404) return null;     // POI niet bekend op Mapy.cz
      if (!res.ok) {
        warn(`HTTP ${res.status} voor OSM-ID ${osmId}`);
        return null;
      }

      const data = await res.json();

      // Eerste pagina: sla metadata op
      if (offset === 0) {
        meta = {
          rating_stars: data.review_rating_stars ?? null,
          rating_100: data.review_rating ?? null,
          rating_caption: data.review_rating_caption ?? null,
          total: data.total ?? 0,
        };
      }

      const page = data.reviews ?? [];
      allReviews = allReviews.concat(page);

      // Stop als we alles hebben
      if (allReviews.length >= meta.total || page.length < REVIEWS_PER_PAGE) break;
      offset += REVIEWS_PER_PAGE;
      await sleep(DELAY_MS);
    } catch (err) {
      warn(`Netwerk-fout voor OSM ${osmId}: ${err.message}`);
      return null;
    }
  }

  // Verwerk reviews naar ons interne formaat
  const reviews = allReviews.map(r => ({
    id: r.id,
    author: r.user?.name ?? 'Anoniem',
    date: r.updated ? r.updated.slice(0, 10) : null,   // "2024-07-24"
    stars: r.rating != null ? Math.round(r.rating / 20) : null,  // 0-100 → 1-5
    rating_100: r.rating ?? null,
    lang_original: r.lang ?? null,
    was_translated: !(r.native ?? true),
    // forceTranslation=true: text is al in het Engels
    text: r.text ?? '',
    text_en: r.text ?? '',   // zelfde: al vertaald door Mapy.cz
    positives: r.positives ?? null,
    negatives: r.negatives ?? null,
    source: 'mapy-review-api',
  }));

  // Foto-URL-templates uit de gallery van alle reviews
  const photoTemplates = [];
  for (const r of allReviews) {
    for (const img of (r.gallery ?? [])) {
      if (img.urls?.default && img.status === 'approved') {
        photoTemplates.push({
          template: img.urls.default,   // bevat {width} en {height}
          size: img.size ?? [1920, 1080],
          take_date: img.takeDate ?? null,
          visits: img.visits ?? 0,
        });
      }
    }
  }

  // Sorteer foto's op populariteit (meeste bezoeken eerst)
  photoTemplates.sort((a, b) => b.visits - a.visits);

  return { ...meta, reviews, photo_templates: photoTemplates };
}

// ── Per-POI verwerking ────────────────────────────────────────────────────────

async function processPoi(poi) {
  const cacheFile = `details/${poi.osm_type}-${poi.osm_id}.json`;

  if (cacheExists(cacheFile)) {
    return cacheRead(cacheFile);
  }

  const detail = {
    ...poi,
    found_on_mapy: false,
    mapy_url: `https://mapy.com/en/place/osm-${poi.osm_type === 'node' ? 'N' : poi.osm_type === 'way' ? 'W' : 'R'}${poi.osm_id}/`,
    rating_stars: null,
    rating_caption: null,
    review_count: 0,
    reviews: [],
    photo_templates: [],
    photos: [],             // wordt gevuld in stap 4
  };

  const result = await fetchMapyReviews(poi.osm_id);

  if (result) {
    detail.found_on_mapy = true;
    detail.rating_stars = result.rating_stars;
    detail.rating_caption = result.rating_caption;
    detail.review_count = result.total;
    detail.reviews = result.reviews;
    detail.photo_templates = result.photo_templates;
  }

  cacheWrite(cacheFile, detail);
  return detail;
}

// ── Hoofdprogramma ────────────────────────────────────────────────────────────

const pois = cacheRead('pois-raw.json');
if (!pois) {
  console.error('❌  cache/pois-raw.json niet gevonden. Voer eerst stap 2 uit.');
  process.exit(1);
}

log(`${pois.length} POIs verwerken (max ${CONCURRENCY} gelijktijdig, ~${DELAY_MS}ms tussenpauze)…`);
log('forceTranslation=true: Mapy.cz vertaalt reviews zelf naar Engels 🌍');
log('De voortgang wordt per POI gecached → herstart is altijd veilig.\n');

let done = 0;
let foundOnMapy = 0;

const results = await Promise.all(
  pois.map(poi => limit(async () => {
    const detail = await processPoi(poi);
    done++;
    if (detail.found_on_mapy) foundOnMapy++;
    if (done % 10 === 0 || done === pois.length) {
      log(`Voortgang: ${done}/${pois.length} (${foundOnMapy} op Mapy.cz gevonden)`);
    }
    await sleep(DELAY_MS);
    return detail;
  }))
);

cacheWrite('pois-with-reviews.json', results);

const withReviews = results.filter(p => p.reviews.length > 0).length;
const totalPhotos = results.reduce((s, p) => s + p.photo_templates.length, 0);

ok(`Stap 3 voltooid ✓`);
log(`  Gevonden op Mapy.cz : ${foundOnMapy}/${pois.length}`);
log(`  Met reviews         : ${withReviews}/${pois.length}`);
log(`  Foto-templates      : ${totalPhotos} totaal`);
