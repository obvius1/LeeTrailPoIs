/**
 * Stap 3 — Mapy.cz reviews + foto-URLs ophalen
 *
 * Gebruikt de bevestigde endpoint (gevonden via DevTools):
 *   GET https://mapy.com/api/reviews/v1/review/poi/osm/{mapy_internal_id}
 *       ?offset=0&limit=50&lang=en&bestReviewsOnly=false
 *       &filterByLang=false&forceTranslation=true
 *
 * BELANGRIJK: het ID in de URL is NIET het huidige OSM node-ID, maar
 * Mapy.cz's eigen interne ID. Die worden opgehaald door stap 2b via
 * /api/poiagg en opgeslagen in cache/mapy-id-lookup.json.
 * Per Overpass POI zoeken we de geografisch dichtstbijzijnde Mapy-POI
 * (binnen 150 m) en gebruiken dat interne ID.
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

// ── Mapy-ID lookup (interne IDs via stap 2b) ──────────────────────────────────

/**
 * Bereken afstand in meters tussen twee lat/lon punten (Haversine).
 */
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/**
 * Bouw een ruimtelijke index van Mapy-POIs voor snelle nearest-neighbour.
 * Retourneert een functie findMapyId(lat, lon, maxDistM) → mapy_id | null.
 */
function buildMapyIndex(mapyPois) {
  if (!mapyPois || mapyPois.length === 0) {
    warn('Geen mapy-id-lookup beschikbaar — reviews zullen leeg zijn.');
    warn('Voer eerst stap 2b uit: node scripts/2b-mapy-ids.mjs');
    return () => null;
  }
  log(`Mapy-ID lookup geladen: ${mapyPois.length} POIs`);

  return function findMapyId(lat, lon, maxDistM = 150) {
    let bestId = null;
    let bestDist = maxDistM;
    for (const mp of mapyPois) {
      const d = distanceMeters(lat, lon, mp.lat, mp.lon);
      if (d < bestDist) {
        bestDist = d;
        bestId = mp.id;
      }
    }
    return bestId;
  };
}

const DETAILS_DIR = join(CACHE_DIR, 'details');
mkdirSync(DETAILS_DIR, { recursive: true });

const CONCURRENCY = 3;
const DELAY_MS = 800;
const REVIEWS_PER_PAGE = 50;
const limit = pLimit(CONCURRENCY);

// Publieke frontend-key van Mapy.com (embedded in hun web-app, niet geheim)
// Gebruikt voor de szn/v1/media endpoint (plaatsfoto's los van reviews)
const MAPY_MEDIA_KEY = 'lg5ZalppPu2Npg_CNogecHAiRn7fFEY_Fumq7Ye4H28';

// ── Mapy.cz review-API (bevestigd via DevTools) ───────────────────────────────

/**
 * Haalt alle reviews op voor één Mapy-intern ID.
 * Pagineert automatisch als total > REVIEWS_PER_PAGE.
 * @param {number} mapyId  Mapy.cz interne POI-ID (van stap 2b)
 * @returns { rating_stars, rating_100, total, reviews[], photo_urls[] } | null
 */
async function fetchMapyReviews(mapyId) {
  const base = `https://mapy.com/api/reviews/v1/review/poi/osm/${mapyId}`;
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
        warn(`HTTP ${res.status} voor Mapy-ID ${mapyId}`);
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
      warn(`Netwerk-fout voor Mapy-ID ${mapyId}: ${err.message}`);
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

// ── Mapy.cz media-API (plaatsfoto's los van reviews) ─────────────────────────

/**
 * Haalt plaatsfoto's op via de szn/v1/media endpoint.
 * Dit zijn foto's die gebruikers uploaden naar een plek — NIET gekoppeld aan reviews.
 * Hetzelfde {width}/{height} template-formaat als review-gallery foto's.
 */
async function fetchMediaPhotos(mapyId) {
  const url = `https://api.mapy.com/szn/v1/media/poi/osm/${mapyId}?lang=en&sort=default&limit=50&offset=0`;
  try {
    const res = await fetchWithRetry(url, {
      headers: {
        'x-mapy-api-key': MAPY_MEDIA_KEY,
        'Accept':         'application/json',
        'Origin':         'https://mapy.com',
        'Referer':        'https://mapy.com/',
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.media ?? [])
      .filter(m => m.status === 'approved')
      .map(m => {
        const placeholder = m.urls?.find(u => u.type === 'placeholder');
        if (!placeholder) return null;
        return {
          template: placeholder.url,   // bevat {width} en {height}
          visits:   m.viewCount ?? 0,
          source:   'mapy-media',
          take_date: m.date ? String(m.date).slice(0, 10) : null,
        };
      })
      .filter(Boolean);
  } catch (err) {
    warn(`Media-foto fout ${mapyId}: ${err.message}`);
    return [];
  }
}

// ── Per-POI verwerking ────────────────────────────────────────────────────────

async function processPoi(poi, findMapyId) {
  const cacheFile = `details/${poi.osm_type}-${poi.osm_id}.json`;

  if (cacheExists(cacheFile)) {
    const cached = cacheRead(cacheFile);
    // Patch: mapy_id beschikbaar maar nog geen media-foto's (nieuwe bron)
    if (cached.mapy_id && (cached.photo_templates ?? []).length === 0) {
      await sleep(DELAY_MS);
      const mediaPhotos = await fetchMediaPhotos(cached.mapy_id);
      if (mediaPhotos.length > 0) {
        cached.photo_templates = mediaPhotos;
        cacheWrite(cacheFile, cached);
      }
    }
    // Patch: corrigeer oude mapy_url die osm_id gebruikte i.p.v. mapy_id
    if (cached.mapy_id && cached.mapy_url && cached.mapy_url.includes(`id=${cached.osm_id}`)) {
      cached.mapy_url = `https://mapy.com/en/turisticka?source=osm&id=${cached.mapy_id}&x=${cached.lon}&y=${cached.lat}&z=16`;
      cacheWrite(cacheFile, cached);
    }
    return cached;
  }

  // Zoek Mapy.cz interne ID op basis van geografische nabijheid
  const mapyId = findMapyId(poi.lat, poi.lon);

  const detail = {
    ...poi,
    found_on_mapy: false,
    mapy_id: mapyId ?? null,
    // Correct formaat: mapy_id (intern Mapy-ID), niet osm_id
    mapy_url: mapyId
      ? `https://mapy.com/en/turisticka?source=osm&id=${mapyId}&x=${poi.lon}&y=${poi.lat}&z=16`
      : `https://mapy.com/en/turisticka?x=${poi.lon}&y=${poi.lat}&z=16`,
    rating_stars: null,
    rating_caption: null,
    review_count: 0,
    reviews: [],
    photo_templates: [],
    photos: [],             // wordt gevuld in stap 4
  };

  if (mapyId) {
    const result = await fetchMapyReviews(mapyId);

    if (result) {
      detail.found_on_mapy = true;
      detail.rating_stars = result.rating_stars;
      detail.rating_caption = result.rating_caption;
      detail.review_count = result.total;
      detail.reviews = result.reviews;
      detail.photo_templates = result.photo_templates;
    }

    // Media-foto's ophalen (los van reviews — aparte bron)
    await sleep(DELAY_MS);
    const mediaPhotos = await fetchMediaPhotos(mapyId);
    // Voeg media-foto's toe die nog niet via reviews binnen kwamen
    const existingTemplates = new Set(detail.photo_templates.map(p => p.template));
    for (const mp of mediaPhotos) {
      if (!existingTemplates.has(mp.template)) {
        detail.photo_templates.push(mp);
      }
    }
    detail.photo_templates.sort((a, b) => b.visits - a.visits);
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

// Laad Mapy-ID lookup (gebouwd door stap 2b)
const mapyLookup = cacheRead('mapy-id-lookup.json');
const findMapyId = buildMapyIndex(mapyLookup);

log(`${pois.length} POIs verwerken (max ${CONCURRENCY} gelijktijdig, ~${DELAY_MS}ms tussenpauze)…`);
log('forceTranslation=true: Mapy.cz vertaalt reviews zelf naar Engels 🌍');
log('De voortgang wordt per POI gecached → herstart is altijd veilig.\n');

let done = 0;
let foundOnMapy = 0;

const results = await Promise.all(
  pois.map(poi => limit(async () => {
    const detail = await processPoi(poi, findMapyId);
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
