/**
 * Stap 2 — POI-discovery via Overpass API (OpenStreetMap)
 *
 * Zoekt alle relevante POIs binnen de zoekzone (cache/search-area.geojson).
 * Gebruikt de Overpass API — geen API-key nodig, gratis, open data.
 *
 * Output: cache/pois-raw.json
 *
 * OSM-tags die worden opgehaald:
 *   Accommodatie : tourism=camp_site|alpine_hut|wilderness_hut|guest_house|hostel|chalet|hotel; leisure=camp_site; amenity=shelter
 *   Water        : natural=spring, amenity=drinking_water|water_point|toilets
 *   Eten/winkels : amenity=restaurant|cafe|fast_food|snack_bar|pub; shop=convenience|supermarket
 *   Beziensw.    : waterway=waterfall, tourism=viewpoint, natural=peak|cave_entrance|hot_spring|gorge, historic=castle|ruins
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { log, ok, warn, cacheRead, cacheWrite, cacheExists, fetchWithRetry, sleep, CACHE_DIR } from './utils.mjs';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const CACHE_FILE = 'pois-raw.json';

// ── OSM-tags per categorie ─────────────────────────────────────────────────────

const QUERIES = [
  {
    category: 'accommodation',
    label: 'Accommodatie',
    filter: `(
      node["tourism"="camp_site"];
      node["tourism"="alpine_hut"];
      node["tourism"="wilderness_hut"];
      node["tourism"="guest_house"];
      node["tourism"="hostel"];
      node["tourism"="chalet"];
      node["tourism"="hotel"];
      node["leisure"="camp_site"];
      node["amenity"="shelter"];
      way["tourism"="camp_site"];
      way["tourism"="alpine_hut"];
      way["tourism"="wilderness_hut"];
      way["tourism"="guest_house"];
      way["tourism"="hostel"];
      way["tourism"="chalet"];
      way["tourism"="hotel"];
      way["leisure"="camp_site"];
      way["amenity"="shelter"];
      relation["tourism"="camp_site"];
      relation["tourism"="alpine_hut"];
      relation["tourism"="wilderness_hut"];
      relation["tourism"="guest_house"];
      relation["tourism"="hostel"];
      relation["tourism"="chalet"];
      relation["tourism"="hotel"];
      relation["leisure"="camp_site"];
      relation["amenity"="shelter"];
    )`
  },
  {
    category: 'water',
    label: 'Water',
    filter: `(
      node["natural"="spring"]["drinking_water"!="no"];
      node["amenity"="drinking_water"];
      node["amenity"="water_point"];
      node["amenity"="toilets"];
      way["amenity"="toilets"];
    )`
  },
  {
    category: 'food',
    label: 'Eten & drinken',
    filter: `(
      node["amenity"="restaurant"];
      node["amenity"="cafe"];
      node["amenity"="fast_food"];
      node["amenity"="snack_bar"];
      node["amenity"="pub"];
      node["shop"="convenience"];
      node["shop"="supermarket"];
      way["amenity"="restaurant"];
      way["amenity"="cafe"];
      way["amenity"="snack_bar"];
      way["shop"="supermarket"];
      relation["amenity"="restaurant"];
      relation["shop"="supermarket"];
    )`
  },
  {
    category: 'sights',
    label: 'Bezienswaardigheden',
    filter: `(
      node["waterway"="waterfall"];
      node["tourism"="viewpoint"];
      node["natural"="peak"];
      node["natural"="cave_entrance"];
      node["natural"="hot_spring"];
      node["natural"="gorge"];
      node["historic"="castle"];
      node["historic"="ruins"];
      node["tourism"="attraction"];
      way["waterway"="waterfall"];
      way["natural"="cave_entrance"];
      way["natural"="hot_spring"];
      way["natural"="gorge"];
      way["historic"="castle"];
      way["historic"="ruins"];
      way["tourism"="attraction"];
      relation["natural"="cave_entrance"];
      relation["natural"="gorge"];
      relation["historic"="castle"];
      relation["historic"="ruins"];
      relation["tourism"="attraction"];
    )`
  }
];

// ── Hoofdfunctie ──────────────────────────────────────────────────────────────

// Resume: als cache al bestaat, vroeg stoppen
if (cacheExists(CACHE_FILE)) {
  const existing = cacheRead(CACHE_FILE);
  ok(`Cache gevonden: ${existing.length} POIs al opgeslagen. Stap 2 overgeslagen.`);
  log('   (Verwijder cache/pois-raw.json om opnieuw te beginnen)');
  process.exit(0);
}

const searchArea = cacheRead('search-area.geojson');
if (!searchArea) {
  console.error('❌  cache/search-area.geojson niet gevonden. Voer eerst stap 1 uit.');
  process.exit(1);
}

// Bereken bounding box voor Overpass (snellere pre-filter)
const allCoords = searchArea.geometry.type === 'Polygon'
  ? searchArea.geometry.coordinates[0]
  : searchArea.geometry.coordinates.flat(2);

const lats = allCoords.map(c => c[1]);
const lons = allCoords.map(c => c[0]);
const bbox = `${Math.min(...lats)},${Math.min(...lons)},${Math.max(...lats)},${Math.max(...lons)}`;
log(`Bounding box voor Overpass: ${bbox}`);

// ── Queries uitvoeren ─────────────────────────────────────────────────────────

const allPois = [];
const seenIds = new Set();

for (const q of QUERIES) {
  log(`Querying Overpass: ${q.label}…`);

  // [bbox:...] als globale instelling — geldt voor alle statements in de query
  const query = `[out:json][timeout:60][bbox:${bbox}];
${q.filter};
out center tags;`;

  let data;
  try {
    const res = await fetchWithRetry(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (!res.ok) {
      warn(`Overpass fout voor ${q.label}: HTTP ${res.status}`);
      continue;
    }

    data = await res.json();
  } catch (err) {
    warn(`Overpass netwerk-fout: ${err.message}`);
    continue;
  }

  const elements = data.elements ?? [];
  log(`  → ${elements.length} elementen gevonden in bbox`);

  // Filter: alleen elementen die echt BINNEN de zoekzone vallen
  let inZone = 0;
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!lat || !lon) continue;

    const point = { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] } };
    if (!booleanPointInPolygon(point, searchArea)) continue;

    const key = `${el.type}-${el.id}`;
    if (seenIds.has(key)) continue;
    seenIds.add(key);

    const tags = el.tags ?? {};
    const name = tags.name || tags['name:en'] || tags['name:sq'] || tags['name:sr'] || tags['name:mk'] ||
                 tags['name:al'] || `${q.label} (naamloos)`;

    allPois.push({
      osm_type: el.type,       // node / way / relation
      osm_id: el.id,
      category: q.category,
      name,
      lat,
      lon,
      tags,
      // Wordt later ingevuld:
      mapy_id: null,
      mapy_source: null,
      distance_along_route_km: null,
    });

    inZone++;
  }

  log(`  → ${inZone} binnen de zoekzone`);
  await sleep(1500); // beleefd wachten tussen Overpass-requests
}

log(`\nTotaal: ${allPois.length} POIs gevonden`);

// Sorteer op categorie + naam voor leesbaarheid in de cache
allPois.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

cacheWrite(CACHE_FILE, allPois);
ok(`Stap 2 voltooid ✓  — ${allPois.length} POIs opgeslagen`);

// Samenvatting per categorie
const byCategory = {};
for (const poi of allPois) byCategory[poi.category] = (byCategory[poi.category] ?? 0) + 1;
for (const [cat, n] of Object.entries(byCategory)) {
  log(`  ${cat.padEnd(20)} ${n}`);
}
