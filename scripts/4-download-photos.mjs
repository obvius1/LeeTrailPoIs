/**
 * Stap 4 — Foto's downloaden en verkleinen
 *
 * Downloadt foto-URLs uit de reviews-data, verkleint ze naar max 800px breed
 * en zet ze om naar WebP voor kleine bestandsgrootte.
 *
 * Output: web/assets/photos/{osm_type}-{osm_id}-{index}.webp
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { log, ok, warn, cacheRead, cacheWrite, fetchWithRetry, sleep, WEB_DIR } from './utils.mjs';
import 'dotenv/config';

const MAX_PHOTOS = Number(process.env.MAX_PHOTOS_PER_POI ?? 4);
const MAX_WIDTH = Number(process.env.PHOTO_MAX_WIDTH ?? 800);
const WEBP_QUALITY = 75;
const PHOTOS_DIR = join(WEB_DIR, 'assets', 'photos');
const CONCURRENCY = 3;

mkdirSync(PHOTOS_DIR, { recursive: true });

const limit = pLimit(CONCURRENCY);

const pois = cacheRead('pois-with-reviews.json');
if (!pois) {
  console.error('❌  cache/pois-with-reviews.json niet gevonden. Voer eerst stap 3 uit.');
  process.exit(1);
}

// Verzamel alle foto-taken
const tasks = [];
for (const poi of pois) {
  const photoUrls = (poi.photo_urls ?? []).slice(0, MAX_PHOTOS);
  for (let i = 0; i < photoUrls.length; i++) {
    const filename = `${poi.osm_type}-${poi.osm_id}-${i}.webp`;
    tasks.push({ poi, url: photoUrls[i], filename, index: i });
  }
}

log(`${tasks.length} foto's te downloaden (max ${MAX_PHOTOS} per POI)…`);

let done = 0;
let success = 0;
let skipped = 0;

// Bouw een kaart van poi_id → foto-bestandsnamen
const poiPhotos = {};

await Promise.all(tasks.map(task => limit(async () => {
  const outPath = join(PHOTOS_DIR, task.filename);

  if (existsSync(outPath)) {
    // Al gedownload — hergebruik
    skipped++;
    const key = `${task.poi.osm_type}-${task.poi.osm_id}`;
    poiPhotos[key] = poiPhotos[key] ?? [];
    poiPhotos[key].push(`assets/photos/${task.filename}`);
    done++;
    return;
  }

  try {
    const res = await fetchWithRetry(task.url, {
      headers: { 'Referer': 'https://mapy.com/' }
    });

    if (!res.ok) {
      warn(`HTTP ${res.status} voor foto: ${task.url}`);
      done++;
      return;
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    await sharp(buffer)
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(outPath);

    const key = `${task.poi.osm_type}-${task.poi.osm_id}`;
    poiPhotos[key] = poiPhotos[key] ?? [];
    poiPhotos[key].push(`assets/photos/${task.filename}`);

    success++;
    await sleep(200);
  } catch (err) {
    warn(`Foto mislukt (${task.filename}): ${err.message}`);
  }

  done++;
  if (done % 20 === 0 || done === tasks.length) {
    log(`Voortgang: ${done}/${tasks.length} foto's (${success} nieuw, ${skipped} gecached)`);
  }
})));

// Update pois-with-reviews.json met de foto-bestandsnamen
const updatedPois = pois.map(poi => ({
  ...poi,
  photos: poiPhotos[`${poi.osm_type}-${poi.osm_id}`] ?? [],
}));

cacheWrite('pois-with-photos.json', updatedPois);

ok(`Stap 4 voltooid ✓  — ${success} nieuwe foto's, ${skipped} gecached`);
