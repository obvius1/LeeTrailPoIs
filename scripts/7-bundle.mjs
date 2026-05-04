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
import { log, ok, warn, cacheRead, WEB_DIR, ROOT } from './utils.mjs';

mkdirSync(WEB_DIR, { recursive: true });

const pois = cacheRead('pois-with-tiles.json');
const route = cacheRead('route.geojson');

if (!pois) {
  console.error('❌  cache/pois-with-tiles.json niet gevonden. Voer eerst stap 6 uit.');
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
    tile: poi.tile ?? null,
    mapy_url: poi.mapy_url ?? null,
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
  copyFileSync(join(leafletSrc, 'leaflet.min.js'), join(WEB_DIR, 'leaflet.min.js'));
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
log('Tile-URLs genereren voor offline pre-caching (zoom 12-14)…');

function latLonToTile(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

const tileUrls = [];
const lats = output.pois.map(p => p.lat).concat(
  route.geometry.coordinates.map(c => c[1])
);
const lons = output.pois.map(p => p.lon).concat(
  route.geometry.coordinates.map(c => c[0])
);
const minLat = Math.min(...lats), maxLat = Math.max(...lats);
const minLon = Math.min(...lons), maxLon = Math.max(...lons);

for (const zoom of [12, 13, 14]) {
  const tMin = latLonToTile(maxLat, minLon, zoom); // NW
  const tMax = latLonToTile(minLat, maxLon, zoom); // SE
  for (let x = tMin.x; x <= tMax.x; x++) {
    for (let y = tMin.y; y <= tMax.y; y++) {
      // Verspreid over OSM-subdomains a/b/c
      const sub = ['a','b','c'][(x + y) % 3];
      tileUrls.push(`https://${sub}.tile.openstreetmap.org/${zoom}/${x}/${y}.png`);
    }
  }
}

writeFileSync(join(WEB_DIR, 'map-tiles.json'), JSON.stringify(tileUrls));
log(`  ${tileUrls.length} tiles voor zoom 12-14 (≈${Math.round(tileUrls.length * 15 / 1024)} MB)`);

log('\n🎉  Build klaar! Resultaat staat in web/');
log('   Deploy via: GitHub Pages, Netlify Drop, of gewoon "npx serve web/"');

function sanitizeTags(tags) {
  if (!tags) return {};
  // Behoud nuttige tags voor de weergave, verwijder grote/nutteloze
  const keep = ['website', 'phone', 'email', 'opening_hours', 'fee', 'drinking_water',
                 'ele', 'operator', 'addr:city', 'capacity', 'access'];
  const result = {};
  for (const k of keep) {
    if (tags[k]) result[k] = tags[k];
  }
  return result;
}
