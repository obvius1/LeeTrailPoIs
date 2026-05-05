/**
 * Stap 6 — Mini-kaartjes genereren via Mapy.com Static Images API
 *
 * Maakt voor elke POI een klein raster-kaartje (~400×300 px, zoom 15).
 * Marker op de exacte POI-locatie.
 *
 * Vereist: MAPY_API_KEY in .env
 * Registreer gratis op https://developer.mapy.com/
 *
 * Output: web/assets/tiles/{osm_type}-{osm_id}.png
 *
 * Documentatie: https://developer.mapy.com/rest-api-mapy-cz/function/static-maps/
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import pLimit from 'p-limit';
import { log, ok, warn, cacheRead, cacheWrite, fetchWithRetry, sleep, WEB_DIR } from './utils.mjs';
import 'dotenv/config';

const MAPY_API_KEY = process.env.MAPY_API_KEY;
const TILES_DIR = join(WEB_DIR, 'assets', 'tiles');
const CONCURRENCY = 2;
const TILE_WIDTH = 400;
const TILE_HEIGHT = 280;
const ZOOM = 15;

mkdirSync(TILES_DIR, { recursive: true });

if (!MAPY_API_KEY) {
  console.error('❌  MAPY_API_KEY niet ingesteld in .env');
  console.error('   Registreer gratis op https://developer.mapy.com/');
  process.exit(1);
}

const limit = pLimit(CONCURRENCY);

const pois = cacheRead('pois-translated.json');
if (!pois) {
  console.error('❌  cache/pois-translated.json niet gevonden. Voer eerst stap 5 uit.');
  process.exit(1);
}

log(`${pois.length} mini-kaartjes genereren…`);

let done = 0;
let success = 0;
let skipped = 0;

await Promise.all(pois.map(poi => limit(async () => {
  const filename = `${poi.osm_type}-${poi.osm_id}.png`;
  const outPath = join(TILES_DIR, filename);

  if (existsSync(outPath)) {
    skipped++;
    done++;
    return;
  }

  // Mapy.com Static Images API
  // Documentatie: https://developer.mapy.com/rest-api-mapy-cz/function/static-maps/
  // URL-formaat: /v1/static/map?apikey=...&lon={lon}&lat={lat}&zoom={z}&width={w}&height={h}&mapset=outdoor&markers=color:NAME;size:normal;{lon},{lat}
  const markerColor = categoryToColor(poi.category);
  const url = new URL('https://api.mapy.com/v1/static/map');
  url.searchParams.set('apikey', MAPY_API_KEY);
  url.searchParams.set('lon', String(poi.lon));
  url.searchParams.set('lat', String(poi.lat));
  url.searchParams.set('zoom', String(ZOOM));
  url.searchParams.set('width', String(TILE_WIDTH));
  url.searchParams.set('height', String(TILE_HEIGHT));
  url.searchParams.set('mapset', 'outdoor');  // outdoor = topokaart met wandelpaden
  // Marker: kleur afhankelijk van categorie (named colors, niet hex)
  url.searchParams.set('markers', `color:${markerColor};size:normal;${poi.lon},${poi.lat}`);

  try {
    const res = await fetchWithRetry(url.toString(), {
      headers: { 'Referer': 'https://github.com/LaurenSchouppe' }
    });

    if (!res.ok) {
      warn(`Mapy Static API fout ${res.status} voor ${poi.name}`);
      done++;
      return;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(outPath, buffer);
    success++;
    await sleep(600); // beleefd: ~2 req/s
  } catch (err) {
    warn(`Tile mislukt (${filename}): ${err.message}`);
  }

  done++;
  if (done % 25 === 0 || done === pois.length) {
    log(`Voortgang: ${done}/${pois.length} tiles (${success} nieuw, ${skipped} gecached)`);
  }
})));

// Voeg tile-bestandsnamen toe aan de data
const updatedPois = pois.map(poi => ({
  ...poi,
  tile: `assets/tiles/${poi.osm_type}-${poi.osm_id}.png`,
}));

cacheWrite('pois-with-tiles.json', updatedPois);
ok(`Stap 6 voltooid ✓  — ${success} nieuwe tiles, ${skipped} gecached`);

function categoryToColor(category) {
  // Mapy.com named marker colors
  switch (category) {
    case 'accommodation': return 'orange';
    case 'water':         return 'blue';
    case 'food':          return 'red';
    case 'sights':        return 'green';
    default:              return 'grey';
  }
}
