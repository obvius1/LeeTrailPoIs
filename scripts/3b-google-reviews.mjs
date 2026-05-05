/**
 * Stap 3b — Google Places reviews + foto's ophalen
 *
 * Voor elke niet-water POI:
 *   1. Zoek de bijbehorende Google Place via "Find Place from Text"
 *      (naam + coördinaten als locatiebias, max 200 m)
 *   2. Haal Place Details op (max 5 reviews + foto-referenties)
 *   3. Download foto's (max 3/POI, omgezet naar WebP)
 *   4. Sla op in cache/google/{osm_type}-{osm_id}.json (resume-vriendelijk)
 *
 * Vereist: GOOGLE_API_KEY in .env
 *   → Google Cloud Console → Places API (legacy) inschakelen
 *
 * Kosten (eerste run, ~560 POIs):
 *   Find Place     : ~440 calls × $0.017 ≈ $7.50
 *   Place Details  : ~200 calls × $0.020 ≈ $4.00
 *   Totaal         : ~$11.50 (ruim binnen gratis $200/maand credit)
 *   Herstart       : enkel nieuwe POIs — rest is gecached
 *
 * Output: cache/pois-with-google.json
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { log, ok, warn, cacheRead, cacheWrite, cacheExists, fetchWithRetry, sleep, CACHE_DIR, WEB_DIR } from './utils.mjs';
import 'dotenv/config';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const PHOTOS_DIR     = join(WEB_DIR, 'assets', 'photos');
const GOOGLE_DIR     = join(CACHE_DIR, 'google');
const CONCURRENCY    = 2;    // Google wil niet te snel na elkaar
const MAX_PHOTOS     = Math.min(Number(process.env.MAX_PHOTOS_PER_POI ?? 5), 10); // Google geeft max 10 foto-refs
const PHOTO_WIDTH    = Number(process.env.PHOTO_MAX_WIDTH ?? 800);
const PHOTO_HEIGHT   = Math.round(PHOTO_WIDTH * 0.75);
const MAX_DIST_M     = 200;  // max afstand (m) voor een geldige match
const DELAY_MS       = 600;

mkdirSync(PHOTOS_DIR, { recursive: true });
mkdirSync(GOOGLE_DIR, { recursive: true });

// ── Geen API-key → graceful skip ──────────────────────────────────────────────

if (!GOOGLE_API_KEY || GOOGLE_API_KEY === 'jouw-google-api-key-hier') {
  warn('GOOGLE_API_KEY niet ingesteld — stap 3b overgeslagen.');
  warn('Voeg GOOGLE_API_KEY=... toe aan .env voor Google-reviews.');
  const pois = cacheRead('pois-with-reviews.json') ?? [];
  cacheWrite('pois-with-google.json', pois.map(p => ({
    osm_type: p.osm_type, osm_id: p.osm_id, google_place_id: null,
  })));
  process.exit(0);
}

// ── Hulpfuncties ──────────────────────────────────────────────────────────────

function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Google Places API ─────────────────────────────────────────────────────────

async function findPlace(name, lat, lon) {
  const params = new URLSearchParams({
    input:        name,
    inputtype:    'textquery',
    locationbias: `circle:${MAX_DIST_M}@${lat},${lon}`,
    fields:       'place_id,name,geometry,rating,user_ratings_total',
    language:     'en',
    key:          GOOGLE_API_KEY,
  });
  try {
    const res  = await fetchWithRetry(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?${params}`);
    if (!res.ok) { warn(`Find Place HTTP ${res.status} voor "${name}"`); return null; }
    const data = await res.json();
    if (data.status === 'REQUEST_DENIED') { warn(`Find Place: ${data.error_message}`); return null; }
    const c = data.candidates?.[0];
    if (!c) return null;
    // Verificeer dat het echt dichtbij is
    const d = distM(lat, lon, c.geometry.location.lat, c.geometry.location.lng);
    return d <= MAX_DIST_M ? c : null;
  } catch (err) {
    warn(`Find Place fout "${name}": ${err.message}`);
    return null;
  }
}

async function getPlaceDetails(placeId, fields = 'name,rating,user_ratings_total,reviews,photos,formatted_phone_number,international_phone_number,website') {
  const params = new URLSearchParams({
    place_id:     placeId,
    fields,
    language:     'en',
    reviews_sort: 'newest',
    key:          GOOGLE_API_KEY,
  });
  try {
    const res  = await fetchWithRetry(`https://maps.googleapis.com/maps/api/place/details/json?${params}`);
    if (!res.ok) { warn(`Place Details HTTP ${res.status}`); return null; }
    const data = await res.json();
    if (data.status !== 'OK') { warn(`Place Details: ${data.status}`); return null; }
    return data.result;
  } catch (err) {
    warn(`Place Details fout ${placeId}: ${err.message}`);
    return null;
  }
}

async function downloadGooglePhoto(photoRef, outPath) {
  const params = new URLSearchParams({
    maxwidth:        '800',
    photo_reference: photoRef,
    key:             GOOGLE_API_KEY,
  });
  try {
    const res = await fetchWithRetry(`https://maps.googleapis.com/maps/api/place/photo?${params}`);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    await sharp(buf)
      .resize({ width: PHOTO_WIDTH, height: PHOTO_HEIGHT, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(outPath);
    return true;
  } catch (err) {
    warn(`Google foto fout: ${err.message}`);
    return false;
  }
}

// ── Per-POI verwerking ────────────────────────────────────────────────────────

async function processPoiGoogle(poi) {
  const cacheFile = `google/${poi.osm_type}-${poi.osm_id}.json`;

  if (cacheExists(cacheFile)) {
    const cached = cacheRead(cacheFile);
    // Patch: place_id bekend maar google_phone nog niet opgehaald → enkel Details bijvragen
    if (cached.google_place_id && !('google_phone' in cached)) {
      await sleep(DELAY_MS);
      const details = await getPlaceDetails(
        cached.google_place_id,
        'formatted_phone_number,international_phone_number,website',
      );
      cached.google_phone   = details?.international_phone_number
                           ?? details?.formatted_phone_number
                           ?? null;
      cached.google_website = details?.website ?? null;
      cacheWrite(cacheFile, cached);
    }
    return cached;
  }

  // Water-POIs (bronnen, drinkwaterpunten) overslaan
  if (poi.category === 'water') {
    const r = { osm_type: poi.osm_type, osm_id: poi.osm_id, google_place_id: null };
    cacheWrite(cacheFile, r);
    return r;
  }

  const result = { osm_type: poi.osm_type, osm_id: poi.osm_id, google_place_id: null };

  // 1) Find Place
  await sleep(DELAY_MS);
  const candidate = await findPlace(poi.name, poi.lat, poi.lon);
  if (!candidate) {
    cacheWrite(cacheFile, result);
    return result;
  }

  result.google_place_id    = candidate.place_id;
  result.google_name        = candidate.name;

  // 2) Place Details
  await sleep(DELAY_MS);
  const details = await getPlaceDetails(candidate.place_id);
  if (!details) {
    cacheWrite(cacheFile, result);
    return result;
  }

  result.google_rating        = details.rating ?? null;
  result.google_total_ratings = details.user_ratings_total ?? 0;
  result.google_phone         = details.international_phone_number
                             ?? details.formatted_phone_number
                             ?? null;
  result.google_website       = details.website ?? null;

  result.google_reviews = (details.reviews ?? []).map(r => ({
    author:        r.author_name ?? 'Anoniem',
    rating:        r.rating ?? null,
    text:          r.text ?? '',
    date:          r.time ? new Date(r.time * 1000).toISOString().slice(0, 10) : null,
    relative_time: r.relative_time_description ?? null,
    lang:          r.language ?? null,
  }));

  // 3) Foto's downloaden
  const refs = (details.photos ?? []).slice(0, MAX_PHOTOS);
  result.google_photos = [];
  for (let i = 0; i < refs.length; i++) {
    const filename = `${poi.osm_type}-${poi.osm_id}-g${i}.webp`;
    const outPath  = join(PHOTOS_DIR, filename);
    if (existsSync(outPath) || await downloadGooglePhoto(refs[i].photo_reference, outPath)) {
      result.google_photos.push(`assets/photos/${filename}`);
    }
    if (i < refs.length - 1) await sleep(300);
  }

  cacheWrite(cacheFile, result);
  return result;
}

// ── Hoofdprogramma ────────────────────────────────────────────────────────────

const pois = cacheRead('pois-with-reviews.json');
if (!pois) {
  console.error('❌  cache/pois-with-reviews.json niet gevonden. Voer eerst stap 3 uit.');
  process.exit(1);
}

log(`${pois.length} POIs verwerken voor Google Places…`);
log('(water-categorie overgeslagen, per POI gecached → herstart altijd veilig)\n');

const limit  = pLimit(CONCURRENCY);
let done = 0, found = 0, withReviews = 0, totalPhotos = 0;

const results = await Promise.all(pois.map(poi => limit(async () => {
  const r = await processPoiGoogle(poi);
  done++;
  if (r.google_place_id)        found++;
  if (r.google_reviews?.length) withReviews++;
  totalPhotos += r.google_photos?.length ?? 0;
  if (done % 25 === 0 || done === pois.length) {
    log(`Voortgang: ${done}/${pois.length} (${found} gevonden, ${withReviews} met reviews)`);
  }
  return r;
})));

cacheWrite('pois-with-google.json', results);

ok(`Stap 3b voltooid ✓`);
log(`  Gevonden op Google Maps : ${found}/${pois.length}`);
log(`  Met Google reviews      : ${withReviews}`);
log(`  Google foto's           : ${totalPhotos}`);
