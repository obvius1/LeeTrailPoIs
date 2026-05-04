/**
 * Stap 1 — GPX → zoekzone
 *
 * Leest data/route.gpx, bouwt een 1 km buffer rond de track,
 * en voegt optionele extra-zones.geojson samen.
 * Output: cache/search-area.geojson (de zoekzone) en cache/route.geojson (de track zelf).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { XMLParser } from 'fast-xml-parser';
import buffer from '@turf/buffer';
import union from '@turf/union';
import { log, ok, warn, cacheWrite, ROOT, DATA_DIR } from './utils.mjs';
import 'dotenv/config';

const BUFFER_KM = Number(process.env.BUFFER_KM ?? 1);
const GPX_FILE = join(DATA_DIR, 'route.gpx');
const EXTRA_ZONES_FILE = join(DATA_DIR, 'extra-zones.geojson');

// ── Stap 1a: GPX inlezen ─────────────────────────────────────────────────────

if (!existsSync(GPX_FILE)) {
  console.error(`\n❌  Bestand niet gevonden: ${GPX_FILE}`);
  console.error('   Kopieer je GPX-bestand naar data/route.gpx en probeer opnieuw.\n');
  process.exit(1);
}

log(`GPX inlezen: ${GPX_FILE}`);
const gpxXml = readFileSync(GPX_FILE, 'utf8');

// Parseer GPX met fast-xml-parser (geen kwetsbare afhankelijkheden)
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const gpxObj = parser.parse(gpxXml);
const gpxRoot = gpxObj.gpx ?? gpxObj.GPX ?? {};

/**
 * Haal coördinaten op uit een GPX trkpt/rtept array.
 * GPX-formaat: <trkpt lat="..." lon="..."><ele>...</ele></trkpt>
 */
function extractCoords(points) {
  if (!points) return [];
  const arr = Array.isArray(points) ? points : [points];
  return arr
    .map(pt => {
      const lon = parseFloat(pt['@_lon']);
      const lat = parseFloat(pt['@_lat']);
      if (isNaN(lat) || isNaN(lon)) return null;
      const ele = parseFloat(pt.ele);
      return isNaN(ele) ? [lon, lat] : [lon, lat, ele];
    })
    .filter(Boolean);
}

// Probeer track (trk), anders route (rte)
let lineCoords = [];
let routeName = 'Route';

if (gpxRoot.trk) {
  const trks = Array.isArray(gpxRoot.trk) ? gpxRoot.trk : [gpxRoot.trk];
  routeName = trks[0].name ?? routeName;
  for (const trk of trks) {
    const segs = Array.isArray(trk.trkseg) ? trk.trkseg : [trk.trkseg ?? {}];
    for (const seg of segs) {
      lineCoords = lineCoords.concat(extractCoords(seg.trkpt));
    }
  }
} else if (gpxRoot.rte) {
  const rtes = Array.isArray(gpxRoot.rte) ? gpxRoot.rte : [gpxRoot.rte];
  routeName = rtes[0].name ?? routeName;
  for (const rte of rtes) {
    lineCoords = lineCoords.concat(extractCoords(rte.rtept));
  }
}

if (lineCoords.length < 2) {
  console.error('❌  Geen track- of routepunten gevonden in het GPX-bestand.');
  console.error('   Controleer of het bestand <trk>/<trkpt> of <rte>/<rtept> bevat.');
  process.exit(1);
}

const routeLine = {
  type: 'Feature',
  properties: { name: routeName },
  geometry: { type: 'LineString', coordinates: lineCoords },
};

log(`Track gevonden: ${lineCoords.length} coördinaten`);
cacheWrite('route.geojson', routeLine);
ok('route.geojson opgeslagen');

// ── Stap 1b: Buffer bouwen ────────────────────────────────────────────────────

log(`Buffer bouwen: ${BUFFER_KM} km`);
const buffered = buffer(routeLine, BUFFER_KM, { units: 'kilometers' });
log('Buffer klaar');

// ── Stap 1c: Extra zones toevoegen ────────────────────────────────────────────

let searchArea = buffered;

if (existsSync(EXTRA_ZONES_FILE)) {
  const extraGeoJson = JSON.parse(readFileSync(EXTRA_ZONES_FILE, 'utf8'));
  const realFeatures = extraGeoJson.features.filter(
    f => f.geometry && !f._comment // sla template-items over
  );

  if (realFeatures.length > 0) {
    log(`${realFeatures.length} extra zone(s) gevonden, samenvoegen…`);
    for (const zone of realFeatures) {
      searchArea = union(searchArea, zone) ?? searchArea;
    }
    ok('Extra zones samengevoegd');
  } else {
    log('extra-zones.geojson bevat alleen template-items — overgeslagen');
  }
} else {
  log('Geen extra-zones.geojson gevonden — enkel GPX-buffer gebruiken');
}

cacheWrite('search-area.geojson', searchArea);
ok(`search-area.geojson opgeslagen`);

// Toon bounding box voor snelle visuele check
const coords = searchArea.geometry?.coordinates?.[0] ?? searchArea.geometry?.coordinates?.[0]?.[0] ?? [];
if (coords.length > 0) {
  const lons = coords.map(c => c[0]);
  const lats = coords.map(c => c[1]);
  log(`Bounding box: N${Math.max(...lats).toFixed(4)} S${Math.min(...lats).toFixed(4)} ` +
      `E${Math.max(...lons).toFixed(4)} W${Math.min(...lons).toFixed(4)}`);
  log('👉  Controleer het resultaat op https://geojson.io (kopieer cache/search-area.geojson)');
}

ok('Stap 1 voltooid ✓');
