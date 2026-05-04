/**
 * Stap 3 — Mapy.cz reviews + foto-URLs ophalen
 *
 * Voor elke OSM-POI uit stap 2 proberen we de bijhorende Mapy.cz-pagina te vinden
 * en alle reviews + foto-URLs te extraheren.
 *
 * HOE HET WERKT
 * ─────────────
 * Mapy.cz heeft geen publieke reviews-API. We gebruiken twee technieken:
 *
 * 1) HTML-scraping van de place-detailpagina:
 *    https://mapy.com/en/place/osm-N{osm_id}/
 *    → Bevat JSON-LD structured data + server-side rendered reviews.
 *
 * 2) XHR-API (best-guess endpoints, zie SPIKE_INSTRUCTIONS hieronder):
 *    De pagina laadt reviews dynamisch via een intern endpoint.
 *
 * ALS DE AUTOMATISCHE SCRAPING FAALT:
 *    Lees SPIKE.md voor instructies om de juiste API-endpoint te vinden
 *    via Chrome/Firefox DevTools (duurt 10-15 minuten, eenmalig).
 *
 * Output: cache/details/{osm_type}-{osm_id}.json  (per POI)
 *         cache/pois-with-reviews.json             (alles samen)
 */

import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import pLimit from 'p-limit';
import { log, ok, warn, cacheRead, cacheWrite, cacheExists, fetchWithRetry, sleep, CACHE_DIR } from './utils.mjs';

const DETAILS_DIR = join(CACHE_DIR, 'details');
mkdirSync(DETAILS_DIR, { recursive: true });

const CONCURRENCY = 2;           // max 2 gelijktijdige requests naar Mapy.cz
const DELAY_MS = 1200;           // wacht ~1.2s tussen requests
const limit = pLimit(CONCURRENCY);

// ── Mapy.cz endpoints om te proberen ─────────────────────────────────────────
//
// We proberen meerdere endpoints in volgorde. De eerste die werkt, wordt gebruikt.
// Als GEEN van deze werkt: zie SPIKE.md.

async function fetchMapyPlaceHtml(osmType, osmId) {
  // Mapy.com URL-formaat voor OSM-plaatsen
  const nodeType = osmType === 'node' ? 'N' : osmType === 'way' ? 'W' : 'R';
  const url = `https://mapy.com/en/place/osm-${nodeType}${osmId}/`;

  try {
    const res = await fetchWithRetry(url, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-GB,en;q=0.9',
      }
    });
    if (!res.ok) return null;
    return { url, html: await res.text() };
  } catch {
    return null;
  }
}

async function fetchMapyReviewsApi(osmType, osmId) {
  // Probeer de interne Mapy.com review-API (best-guess endpoints)
  // Één van deze zou moeten werken — als geen werkt, zie SPIKE.md.

  const nodeType = osmType === 'node' ? 'node' : osmType === 'way' ? 'way' : 'relation';
  const candidates = [
    // Nieuwste Mapy.com API (meest waarschijnlijk)
    `https://api.mapy.com/v1/poi/reviews?source=osm&osmType=${nodeType}&id=${osmId}&lang=en&offset=0&limit=50`,
    `https://api.mapy.com/v1/poi/${osmId}/reviews?source=osm&lang=en`,
    // Oudere Mapy.cz API
    `https://pro.mapy.cz/api/reviews?source=osm&id=${osmId}&lang=en`,
    `https://api.mapy.cz/reviews?source=osm&id=${osmId}`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetchWithRetry(url, {
        headers: { 'Referer': `https://mapy.com/en/place/osm-N${osmId}/` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data && (data.reviews || data.items || Array.isArray(data))) {
          log(`    ✓ Reviews API gevonden: ${url}`);
          return { url, data };
        }
      }
    } catch {
      // volgende endpoint proberen
    }
    await sleep(300);
  }
  return null;
}

// ── HTML-parsing: JSON-LD + fallback text ─────────────────────────────────────

function extractFromHtml(html, sourceUrl) {
  const result = {
    found_on_mapy: false,
    mapy_url: sourceUrl,
    name: null,
    description: null,
    rating: null,
    review_count: null,
    reviews: [],
    photo_urls: [],
    raw_jsonld: null,
  };

  if (!html) return result;

  // 1) Zoek JSON-LD structured data (<script type="application/ld+json">)
  const jsonLdMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of jsonLdMatches) {
    try {
      const obj = JSON.parse(match[1]);
      // Array of objects or single object
      const items = Array.isArray(obj) ? obj : [obj];
      for (const item of items) {
        if (item['@type'] === 'LocalBusiness' || item['@type'] === 'TouristAttraction' ||
            item['@type'] === 'Accommodation' || item['@type'] === 'LodgingBusiness' ||
            item['@type'] === 'Place') {
          result.found_on_mapy = true;
          result.raw_jsonld = item;
          result.name = item.name ?? result.name;
          result.description = item.description ?? result.description;
          if (item.aggregateRating) {
            result.rating = parseFloat(item.aggregateRating.ratingValue) || null;
            result.review_count = parseInt(item.aggregateRating.reviewCount) || null;
          }
          // Reviews in JSON-LD
          if (Array.isArray(item.review)) {
            for (const r of item.review) {
              result.reviews.push({
                author: r.author?.name ?? r.author ?? 'Anoniem',
                date: r.datePublished ?? null,
                stars: parseFloat(r.reviewRating?.ratingValue) || null,
                text: r.reviewBody ?? r.description ?? '',
                text_en: null,
                source: 'jsonld',
              });
            }
          }
          // Foto's
          if (item.image) {
            const imgs = Array.isArray(item.image) ? item.image : [item.image];
            for (const img of imgs) {
              const url = typeof img === 'string' ? img : img?.url;
              if (url) result.photo_urls.push(url);
            }
          }
        }
      }
    } catch { /* ongeldige JSON — overslaan */ }
  }

  // 2) Zoek Open Graph afbeelding als fallback foto
  const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1];
  if (ogImage && !result.photo_urls.includes(ogImage)) {
    result.photo_urls.push(ogImage);
  }

  // 3) Zoek Mapy.cz eigen foto-CDN links
  const mapyPhotos = [...html.matchAll(/https?:\/\/[a-z0-9-]+\.mapy\.cz\/[^"' \n]+\.(jpg|jpeg|png|webp)/gi)];
  for (const m of mapyPhotos) {
    if (!result.photo_urls.includes(m[0])) result.photo_urls.push(m[0]);
  }

  // 4) Controleer of de pagina überhaupt gevonden werd (404-pagina herkennen)
  if (html.includes('"statusCode":404') || html.includes('page-not-found') || html.length < 500) {
    result.found_on_mapy = false;
  } else if (result.name || result.reviews.length > 0) {
    result.found_on_mapy = true;
  } else if (!html.includes('404') && html.length > 5000) {
    // Pagina bestaat maar bevat geen gestructureerde data — markeer als gevonden
    result.found_on_mapy = true;
  }

  return result;
}

function parseReviewsFromApi(apiData) {
  if (!apiData) return [];
  const raw = apiData.reviews || apiData.items || (Array.isArray(apiData) ? apiData : []);
  return raw.map(r => ({
    author: r.author?.name ?? r.username ?? r.nick ?? 'Anoniem',
    date: r.date ?? r.created_at ?? r.timestamp ?? null,
    stars: r.rating ?? r.stars ?? r.score ?? null,
    text: r.text ?? r.body ?? r.content ?? '',
    text_en: null,
    source: 'api',
  }));
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
    mapy_url: null,
    name_mapy: null,
    description: null,
    rating: null,
    review_count: null,
    reviews: [],
    photo_urls: [],
  };

  // A) Probeer HTML te scrapen
  const htmlResult = await fetchMapyPlaceHtml(poi.osm_type, poi.osm_id);
  if (htmlResult) {
    await sleep(DELAY_MS);
    const parsed = extractFromHtml(htmlResult.html, htmlResult.url);
    Object.assign(detail, parsed);
    detail.mapy_url = htmlResult.url;
  }

  // B) Als HTML weinig reviews gaf, probeer de API-endpoint
  if (detail.reviews.length < 3) {
    await sleep(DELAY_MS);
    const apiResult = await fetchMapyReviewsApi(poi.osm_type, poi.osm_id);
    if (apiResult) {
      const apiReviews = parseReviewsFromApi(apiResult.data);
      // Merge: voeg API-reviews toe die nog niet in de HTML-reviews zitten
      const existingTexts = new Set(detail.reviews.map(r => r.text.slice(0, 50)));
      for (const r of apiReviews) {
        if (!existingTexts.has(r.text.slice(0, 50))) {
          detail.reviews.push(r);
          detail.found_on_mapy = true;
        }
      }
    }
  }

  // Begrens tot max 20 meest recente reviews
  detail.reviews = detail.reviews
    .sort((a, b) => (b.date ?? '') > (a.date ?? '') ? 1 : -1)
    .slice(0, 20);

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
log('Dit kan 10-30 minuten duren afhankelijk van het aantal POIs.');
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
    return detail;
  }))
);

cacheWrite('pois-with-reviews.json', results);

const withReviews = results.filter(p => p.reviews.length > 0).length;
ok(`Stap 3 voltooid ✓`);
log(`  Gevonden op Mapy.cz : ${foundOnMapy}/${pois.length}`);
log(`  Met reviews         : ${withReviews}/${pois.length}`);

if (foundOnMapy < pois.length * 0.3) {
  warn('Minder dan 30% van de POIs gevonden op Mapy.cz.');
  warn('De automatische review-API werkt mogelijk niet (Mapy.cz heeft hem gewijzigd).');
  warn('👉  Lees SPIKE.md voor instructies om de endpoint zelf te vinden via DevTools.');
}
