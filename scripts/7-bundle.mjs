/**
 * Stap 7 — Alles samenvoegen tot web/data.json
 *
 * Berekent de afstand langs de route voor elke POI (voor sortering),
 * verwijdert overbodige velden, en schrijft de finale data.json.
 *
 * Output: web/data.json
 */

import { writeFileSync, copyFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import length from '@turf/length';
import along from '@turf/along';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { log, ok, warn, cacheRead, WEB_DIR, ROOT } from './utils.mjs';

mkdirSync(WEB_DIR, { recursive: true });

// Stap 6 (statische mini-tiles) is vervangen door een interactieve Leaflet mini-kaart.
// Bundel leest nu van stap 5 (pois-translated.json).
const pois  = cacheRead('pois-translated.json');
const route = cacheRead('route.geojson');

// Google Places data (optioneel — gebouwd door stap 3b)
const googleRaw = cacheRead('pois-with-google.json') ?? [];
const googleMap = new Map(googleRaw.map(g => [`${g.osm_type}-${g.osm_id}`, g]));

if (!pois) {
  console.error('❌  cache/pois-translated.json niet gevonden. Voer eerst stap 5 uit.');
  process.exit(1);
}
if (!route) {
  console.error('❌  cache/route.geojson niet gevonden. Voer eerst stap 1 uit.');
  process.exit(1);
}

log('Afstanden langs de route berekenen…');
const totalKm = length(route, { units: 'kilometers' });
log(`Totale routelengte: ${totalKm.toFixed(1)} km`);

const bundled = pois.map(poi => {
  // Bereken dichtstbijzijnde punt op de route
  const point = { type: 'Feature', geometry: { type: 'Point', coordinates: [poi.lon, poi.lat] } };
  const nearest = nearestPointOnLine(route, point, { units: 'kilometers' });
  const distanceKm = nearest.properties.location ?? 0;

  // Google Places data opzoeken
  const gKey  = `${poi.osm_type}-${poi.osm_id}`;
  const gData = googleMap.get(gKey) ?? {};

  // Bouw compact POI-object (verwijder grote/private velden)
  return {
    id: `${poi.osm_type}-${poi.osm_id}`,
    osm_type: poi.osm_type,
    osm_id: poi.osm_id,
    category: poi.category,
    name: poi.name,
    lat: poi.lat,
    lon: poi.lon,
    distance_along_route_km: Math.round(distanceKm * 10) / 10,
    found_on_mapy: poi.found_on_mapy ?? false,
    rating_stars: poi.rating_stars ?? null,
    rating_caption: poi.rating_caption ?? null,
    review_count: poi.review_count ?? poi.reviews?.length ?? 0,
    description: poi.description ?? null,
    description_en: poi.description_en ?? null,
    tags: sanitizeTags(poi.tags),
    reviews: (poi.reviews ?? []).map(r => ({
      author: r.author ?? 'Anoniem',
      date: r.date ?? null,
      stars: r.stars ?? null,
      lang_original: r.lang_original ?? null,
      was_translated: r.was_translated ?? false,
      text_en: r.text_en ?? r.text ?? '',
      positives: r.positives ?? null,
      negatives: r.negatives ?? null,
    })),
    photos: poi.photos ?? [],
    // Datums parallel aan photos[] — null als onbekend (Google-foto's hebben geen datum)
    photo_dates: (poi.photos ?? []).map((_, i) => {
      const t = poi.photo_templates?.[i]?.take_date;
      return t ? String(t).slice(0, 10) : null;  // "2024-07-17"
    }),
    // mapy_url wordt correct gezet door stap 3 (gebruikt mapy_id, niet osm_id)
    mapy_url: poi.mapy_url ?? `https://mapy.com/en/turisticka?x=${poi.lon}&y=${poi.lat}&z=16`,
    // Google Places (leeg als stap 3b niet gedraaid heeft of geen match)
    google_place_id:      gData.google_place_id      ?? null,
    google_rating:        gData.google_rating        ?? null,
    google_total_ratings: gData.google_total_ratings ?? null,
    google_reviews:       gData.google_reviews       ?? [],
    google_photos:        gData.google_photos        ?? [],
    google_phone:         gData.google_phone         ?? null,
    google_website:       gData.google_website       ?? null,
  };
});

// Sorteer op afstand langs de route
bundled.sort((a, b) => a.distance_along_route_km - b.distance_along_route_km);

const output = {
  generated_at: new Date().toISOString(),
  total_km: Math.round(totalKm * 10) / 10,
  route: route,
  pois: bundled,
};

const outPath = join(WEB_DIR, 'data.json');
writeFileSync(outPath, JSON.stringify(output), 'utf8');

const sizeKb = Math.round(JSON.stringify(output).length / 1024);
ok(`Stap 7 voltooid ✓`);
log(`  web/data.json : ${sizeKb} KB`);
log(`  POIs          : ${bundled.length}`);
log(`  Met reviews   : ${bundled.filter(p => p.reviews.length > 0).length}`);
log(`  Met foto's    : ${bundled.filter(p => p.photos.length > 0).length}`);

// Categorie-samenvatting
const cats = {};
for (const p of bundled) cats[p.category] = (cats[p.category] ?? 0) + 1;
for (const [cat, n] of Object.entries(cats)) log(`  ${cat.padEnd(20)} ${n}`);

// ── Leaflet kopiëren vanuit node_modules ──────────────────────────────────────
log('Leaflet kopiëren naar web/…');
const leafletSrc = join(ROOT, 'node_modules', 'leaflet', 'dist');
try {
  // Nieuwere Leaflet-versies bevatten geen leaflet.min.js meer — gebruik leaflet.js als fallback
  const leafletJsSrc = existsSync(join(leafletSrc, 'leaflet.min.js'))
    ? join(leafletSrc, 'leaflet.min.js')
    : join(leafletSrc, 'leaflet.js');
  copyFileSync(leafletJsSrc, join(WEB_DIR, 'leaflet.min.js'));
  copyFileSync(join(leafletSrc, 'leaflet.css'),    join(WEB_DIR, 'leaflet.css'));
  // Marker-iconen (nodig voor Leaflet CSS)
  const imgDst = join(WEB_DIR, 'images');
  mkdirSync(imgDst, { recursive: true });
  for (const img of ['marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png']) {
    const src = join(leafletSrc, 'images', img);
    if (existsSync(src)) copyFileSync(src, join(imgDst, img));
  }
  ok('Leaflet gekopieerd');
} catch (err) {
  warn(`Leaflet kopiëren mislukt: ${err.message}`);
}

// ── Tile-lijst genereren voor offline pre-caching ────────────────────────────
log('Tile-URLs genereren voor offline pre-caching (zoom 12-17)…');

// Laad de zoekzone voor polygon-filtering bij hoge zooms
const searchArea = cacheRead('search-area.geojson');

function latLonToTile(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

/** Converteer tile-coördinaat naar lon/lat */
function tilePxToLonLat(tx, ty, zoom) {
  const n = Math.pow(2, zoom);
  const lon = tx / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n)));
  return [lon, latRad * 180 / Math.PI]; // [lon, lat]
}

/**
 * Controleert of een tile overlapt met de zoekzone-polygon.
 * Checkt middelpunt én alle 4 hoeken — zo worden randtiles niet gemist
 * doordat alleen hun middelpunt buiten het polygon valt.
 */
function tileOverlapsPolygon(x, y, zoom, polygon) {
  const checkPoints = [
    [x + 0.5, y + 0.5], // middelpunt
    [x,       y      ], // NW hoek
    [x + 1,   y      ], // NE hoek
    [x,       y + 1  ], // SW hoek
    [x + 1,   y + 1  ], // SE hoek
  ];
  return checkPoints.some(([tx, ty]) => {
    const [lon, lat] = tilePxToLonLat(tx, ty, zoom);
    const pt = { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] } };
    return booleanPointInPolygon(pt, polygon);
  });
}

const tileUrls = [];
const routeCoords = route.geometry.coordinates;
const minLat = Math.min(...routeCoords.map(c => c[1]));
const maxLat = Math.max(...routeCoords.map(c => c[1]));
const minLon = Math.min(...routeCoords.map(c => c[0]));
const maxLon = Math.max(...routeCoords.map(c => c[0]));

const zoomStats = {};

for (const zoom of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]) {
  const tMin = latLonToTile(maxLat, minLon, zoom); // NW
  const tMax = latLonToTile(minLat, maxLon, zoom); // SE

  // Zoom ≥ 15: filter op zoekzone-polygon voor betere precisie
  // Zoom 12-14: bbox is voldoende (weinig tiles toch)
  const usePolygonFilter = zoom >= 15 && searchArea != null;

  let added = 0;
  for (let x = tMin.x; x <= tMax.x; x++) {
    for (let y = tMin.y; y <= tMax.y; y++) {
      if (usePolygonFilter) {
        if (!tileOverlapsPolygon(x, y, zoom, searchArea)) continue;
      }
      const sub = ['a', 'b', 'c'][(x + y) % 3];
      tileUrls.push(`https://${sub}.tile.openstreetmap.org/${zoom}/${x}/${y}.png`);
      added++;
    }
  }
  zoomStats[zoom] = added;
}

writeFileSync(join(WEB_DIR, 'map-tiles.json'), JSON.stringify(tileUrls));

log(`  Tiles per zoom niveau:`);
let cumMb = 0;
for (const [zoom, count] of Object.entries(zoomStats)) {
  const mb = Math.round(count * 9 / 1024 * 10) / 10; // ~9 KB/tile gemiddeld
  cumMb += mb;
  const flag = Number(zoom) >= 15 ? ' ← polygon-gefilterd' : '';
  log(`    zoom ${zoom}: ${count.toLocaleString()} tiles (~${mb} MB)${flag}`);
}
log(`  Totaal: ${tileUrls.length.toLocaleString()} tiles (~${Math.round(cumMb)} MB)`);
if (!searchArea) warn('  search-area.geojson niet gevonden — bbox gebruikt voor alle zooms');

log('\n🎉  Build klaar! Resultaat staat in web/');
log('   Deploy via: GitHub Pages, Netlify Drop, of gewoon "npx serve web/"');

function sanitizeTags(tags) {
  if (!tags) return {};
  // Behoud nuttige tags voor de weergave, verwijder grote/nutteloze
  const keep = ['website', 'phone', 'email', 'opening_hours', 'fee', 'drinking_water',
                 'ele', 'operator', 'addr:city', 'capacity', 'access',
                 'tourism', 'backcountry', 'informal'];
  const result = {};
  for (const k of keep) {
    if (tags[k]) result[k] = tags[k];
  }
  return result;
}
