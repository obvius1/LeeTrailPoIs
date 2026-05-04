/**
 * Stap 4 — Foto's downloaden en verkleinen
 *
 * Mapy.cz levert foto-URLs als templates met {width} en {height}:
 *   https://d34-a.sdn.cz/.../foto.mpo?fl=res,{width},{height},1
 *
 * We vervangen die door echte afmetingen (800×600) en downloaden als WebP.
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
const MAX_WIDTH  = Number(process.env.PHOTO_MAX_WIDTH ?? 800);
const MAX_HEIGHT = Math.round(MAX_WIDTH * 0.75);   // 4:3 verhouding
const WEBP_QUALITY = 75;
const PHOTOS_DIR = join(WEB_DIR, 'assets', 'photos');
const CONCURRENCY = 3;

mkdirSync(PHOTOS_DIR, { recursive: true });
const limit = pLimit(CONCURRENCY);

// ── URL-template oplossen ─────────────────────────────────────────────────────

function resolvePhotoUrl(template, width, height) {
  return template
    .replace('{width}', String(width))
    .replace('{height}', String(height));
}

// ── Hoofdprogramma ────────────────────────────────────────────────────────────

const pois = cacheRead('pois-with-reviews.json');
if (!pois) {
  console.error('❌  cache/pois-with-reviews.json niet gevonden. Voer eerst stap 3 uit.');
  process.exit(1);
}

// Verzamel download-taken
const tasks = [];
for (const poi of pois) {
  const templates = (poi.photo_templates ?? []).slice(0, MAX_PHOTOS);
  for (let i = 0; i < templates.length; i++) {
    const filename = `${poi.osm_type}-${poi.osm_id}-${i}.webp`;
    tasks.push({
      poi,
      template: templates[i].template,
      filename,
      index: i,
    });
  }
}

log(`${tasks.length} foto's te downloaden (max ${MAX_PHOTOS}/POI, ${MAX_WIDTH}×${MAX_HEIGHT}px)…`);

let done = 0, success = 0, skipped = 0;
const poiPhotos = {};  // { "node-123": ["assets/photos/node-123-0.webp", ...] }

await Promise.all(tasks.map(task => limit(async () => {
  const outPath = join(PHOTOS_DIR, task.filename);
  const key = `${task.poi.osm_type}-${task.poi.osm_id}`;

  if (existsSync(outPath)) {
    skipped++;
    poiPhotos[key] = poiPhotos[key] ?? [];
    poiPhotos[key].push(`assets/photos/${task.filename}`);
    done++;
    return;
  }

  // Mapy.cz foto-CDN: vul {width} en {height} in
  const url = resolvePhotoUrl(task.template, MAX_WIDTH, MAX_HEIGHT);

  try {
    const res = await fetchWithRetry(url, {
      headers: { 'Referer': 'https://mapy.com/' }
    });

    if (!res.ok) {
      warn(`HTTP ${res.status}: ${url}`);
      done++;
      return;
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // Mapy.cz levert soms .mpo (stereo-JPEG) — sharp leest dit als gewone JPEG
    await sharp(buffer)
      .resize({ width: MAX_WIDTH, height: MAX_HEIGHT, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(outPath);

    poiPhotos[key] = poiPhotos[key] ?? [];
    poiPhotos[key].push(`assets/photos/${task.filename}`);
    success++;
    await sleep(150);
  } catch (err) {
    warn(`Foto mislukt (${task.filename}): ${err.message}`);
  }

  done++;
  if (done % 20 === 0 || done === tasks.length) {
    log(`Voortgang: ${done}/${tasks.length} (${success} nieuw, ${skipped} gecached)`);
  }
})));

// Foto-paths toevoegen aan POI-data
const updatedPois = pois.map(poi => ({
  ...poi,
  photos: poiPhotos[`${poi.osm_type}-${poi.osm_id}`] ?? [],
}));

cacheWrite('pois-with-photos.json', updatedPois);
ok(`Stap 4 voltooid ✓  — ${success} nieuwe foto's, ${skipped} gecached`);

const totalSize = tasks.length * WEBP_QUALITY; // ruwe schatting
log(`Geschatte totale fotogrootte: ~${Math.round(tasks.length * 80 / 1024)} MB`);
