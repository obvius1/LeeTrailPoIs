/**
 * Stap 2b — Mapy.cz interne POI-ID's ophalen via /api/poiagg
 *
 * Mapy.cz gebruikt zijn eigen interne ID-nummering (NIET de huidige OSM node-IDs).
 * De review-API vereist die interne IDs.
 *
 * Aanpak:
 *   1. Haal de bbox van cache/search-area.geojson op
 *   2. Splits in tiles van ~0.2° × 0.2° (ruim overlappend)
 *   3. Stuur per tile een FastRPC POST naar https://mapy.com/api/poiagg
 *   4. Parseer de binaire respons → {mapy_id, lat, lon, title}
 *   5. Schrijf cache/mapy-id-lookup.json
 *
 * Dit bestand wordt gebruikt door stap 3 om OSM-POIs te matchen via
 * geografische nabijheid (≤ 100 m) met Mapy.cz interne IDs.
 *
 * Output: cache/mapy-id-lookup.json
 */

import { log, ok, warn, cacheRead, cacheWrite, sleep } from './utils.mjs';

// ── FRPC encoder ──────────────────────────────────────────────────────────────

function frpcDouble(val) {
  const b = Buffer.alloc(9);
  b[0] = 0x18;  // DOUBLE type
  b.writeDoubleLE(val, 1);
  return b;
}

function frpcInt(val) {
  if (val <= 0xFF) {
    return Buffer.from([0x38, val]);        // 1-byte int
  }
  if (val <= 0xFFFF) {
    const b = Buffer.alloc(3);
    b[0] = 0x39;
    b.writeUInt16LE(val, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0x3B;
  b.writeUInt32LE(val >>> 0, 1);
  return b;
}

function frpcString(val) {
  const s = Buffer.from(val, 'utf8');
  return Buffer.concat([Buffer.from([0x20, s.length]), s]);
}

/** Struct: { key: alreadyEncodedBuffer, ... } */
function frpcStruct(obj) {
  const entries = Object.entries(obj);
  const parts = [Buffer.from([0x50, entries.length])];
  for (const [k, v] of entries) {
    const kb = Buffer.from(k, 'utf8');
    parts.push(Buffer.from([kb.length]), kb, v);
  }
  return Buffer.concat(parts);
}

/** Array of already-encoded buffers */
function frpcArray(items) {
  return Buffer.concat([Buffer.from([0x58, items.length]), ...items]);
}

/**
 * Bouw een FRPC lookupbox request.
 * @param {number} minLon  West  (longitude min)
 * @param {number} minLat  South (latitude min)
 * @param {number} maxLon  East  (longitude max)
 * @param {number} maxLat  North (latitude max)
 * @param {number} zoom    Kaart-zoom niveau (18 = max detail)
 */
function buildLookupboxRequest(minLon, minLat, maxLon, maxLat, zoom = 18) {
  const midLat = (minLat + maxLat) / 2;
  const pixelSize = 40075017 * Math.cos(midLat * Math.PI / 180) / (256 * Math.pow(2, zoom));

  const methodName = Buffer.from('lookupbox', 'utf8');
  const params = Buffer.concat([
    frpcDouble(minLon),
    frpcDouble(minLat),
    frpcDouble(maxLon),
    frpcDouble(maxLat),
    frpcStruct({
      zoom:      frpcInt(zoom),
      mapsetId:  frpcInt(3),          // 3 = turistická mapa (tourist map)
      pixelSize: frpcDouble(pixelSize),
      lang:      frpcArray([frpcString('en'), frpcString('cs')]),
    }),
  ]);

  return Buffer.concat([
    Buffer.from([0xCA, 0x11, 0x02, 0x01]),  // FRPC magic + version
    Buffer.from([0x68]),                     // method call type
    Buffer.from([methodName.length]),
    methodName,
    params,
  ]);
}

// ── FRPC response parser ──────────────────────────────────────────────────────

/**
 * Extraheer POIs uit een binaire /api/poiagg lookupbox respons.
 *
 * Bekende patronen (bevestigd via HAR-analyse):
 *   ID     : 02 69 64 3B [4 bytes LE uint32]       (key "id" + INT32)
 *   lat    : 03 6c 61 74 18 [8 bytes LE double]    (key "lat" + DOUBLE)
 *   lon    : 03 6c 6f 6e 18 [8 bytes LE double]    (key "lon" + DOUBLE)
 *   title  : 05 74 69 74 6c 65 20 [len] [bytes]    (key "title" + STRING)
 *
 * @param {Buffer} buf  Raw response bytes (FRPC binary)
 * @returns {Array<{id:number, lat:number, lon:number, title:string}>}
 */
function parsePoiaggResponse(buf) {
  const pois = [];

  // Scan voor patroon "id" key + INT32 type (0x3B)
  const ID_PATTERN = [0x02, 0x69, 0x64, 0x3B];  // len=2, "id", INT32

  for (let i = 0; i < buf.length - 150; i++) {
    // Check id-patroon
    if (buf[i]   !== ID_PATTERN[0] ||
        buf[i+1] !== ID_PATTERN[1] ||
        buf[i+2] !== ID_PATTERN[2] ||
        buf[i+3] !== ID_PATTERN[3]) continue;

    // ID gevonden: lees 4-byte LE uint32
    const id = buf.readUInt32LE(i + 4);
    if (id === 0) continue;  // ongeldige ID

    // Zoek lat/lon in de volgende ~200 bytes
    let lat = null, lon = null, title = null;

    for (let j = i + 8; j < i + 250 && j < buf.length - 18; j++) {
      // lat: 03 6c 61 74 18 [8 bytes]
      if (lat === null &&
          buf[j] === 0x03 && buf[j+1] === 0x6C && buf[j+2] === 0x61 &&
          buf[j+3] === 0x74 && buf[j+4] === 0x18) {
        lat = buf.readDoubleLE(j + 5);
        j += 12;  // skip past lat value
        continue;
      }
      // lon: 03 6c 6f 6e 18 [8 bytes]
      if (lon === null &&
          buf[j] === 0x03 && buf[j+1] === 0x6C && buf[j+2] === 0x6F &&
          buf[j+3] === 0x6E && buf[j+4] === 0x18) {
        lon = buf.readDoubleLE(j + 5);
        j += 12;
        continue;
      }
      // title: 05 74 69 74 6c 65 20 [len] [bytes]
      if (title === null &&
          buf[j] === 0x05 && buf[j+1] === 0x74 && buf[j+2] === 0x69 &&
          buf[j+3] === 0x74 && buf[j+4] === 0x6C && buf[j+5] === 0x65 &&
          buf[j+6] === 0x20) {
        const len = buf[j + 7];
        if (j + 8 + len <= buf.length) {
          title = buf.slice(j + 8, j + 8 + len).toString('utf8');
        }
        j += 7 + len;
        continue;
      }
      // Stop als we de volgende id-patroon tegenkomen
      if (buf[j] === 0x02 && buf[j+1] === 0x69 && buf[j+2] === 0x64 && buf[j+3] === 0x3B) break;
    }

    if (lat !== null && lon !== null) {
      pois.push({ id, lat, lon, title: title ?? '' });
    }
  }

  return pois;
}

// ── Tile-gebaseerde lookupbox-requests ────────────────────────────────────────

const TILE_DEG  = 0.050;  // ~4 km per tile — max bbox die server accepteert bij zoom 18
const OVERLAP   = 0.010;  // ~1 km overlapping rand zodat geen POIs gemist worden
const ZOOM_LEVEL = 18;    // Max detail — alle individuele POIs
const DELAY_MS  = 400;    // Beleefd wachten tussen requests

async function fetchTile(minLon, minLat, maxLon, maxLat) {
  const body = buildLookupboxRequest(minLon, minLat, maxLon, maxLat, ZOOM_LEVEL);

  const res = await fetch('https://mapy.com/api/poiagg', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-frpc',
      'Accept':       'application/x-frpc',
      'Referer':      'https://mapy.com/',
      'Origin':       'https://mapy.com',
    },
    body,
  });

  if (!res.ok) {
    warn(`poiagg HTTP ${res.status} voor tile [${minLon.toFixed(2)},${minLat.toFixed(2)}]`);
    return [];
  }

  const arrBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrBuf);
  return parsePoiaggResponse(buf);
}

// ── Hoofdprogramma ────────────────────────────────────────────────────────────

const searchArea = cacheRead('search-area.geojson');
if (!searchArea) {
  console.error('❌  cache/search-area.geojson niet gevonden. Voer eerst stap 1 uit.');
  process.exit(1);
}

// Haal bbox op van de zoekzone
function getBbox(geojson) {
  const coords = [];
  function collect(c) {
    if (typeof c[0] === 'number') coords.push(c);
    else c.forEach(collect);
  }
  collect(geojson.geometry?.coordinates ?? geojson.coordinates ?? []);
  const lons = coords.map(c => c[0]);
  const lats = coords.map(c => c[1]);
  return {
    minLon: Math.min(...lons), maxLon: Math.max(...lons),
    minLat: Math.min(...lats), maxLat: Math.max(...lats),
  };
}

const bbox = getBbox(searchArea);
log(`Zoekzone bbox: lon [${bbox.minLon.toFixed(3)}, ${bbox.maxLon.toFixed(3)}] lat [${bbox.minLat.toFixed(3)}, ${bbox.maxLat.toFixed(3)}]`);

// Genereer tiles
const tiles = [];
for (let lon = bbox.minLon; lon < bbox.maxLon; lon += TILE_DEG - OVERLAP) {
  for (let lat = bbox.minLat; lat < bbox.maxLat; lat += TILE_DEG - OVERLAP) {
    tiles.push({
      minLon: lon,
      minLat: lat,
      maxLon: Math.min(lon + TILE_DEG, bbox.maxLon),
      maxLat: Math.min(lat + TILE_DEG, bbox.maxLat),
    });
  }
}
log(`${tiles.length} tiles van ${TILE_DEG}° × ${TILE_DEG}° (overlap ${OVERLAP}°)`);

// Haal alle tiles op
const allPois = new Map(); // id → poi (deduplicatie)
let tilesDone = 0;

for (const tile of tiles) {
  const pois = await fetchTile(tile.minLon, tile.minLat, tile.maxLon, tile.maxLat);
  for (const poi of pois) {
    if (!allPois.has(poi.id)) allPois.set(poi.id, poi);
  }
  tilesDone++;
  if (tilesDone % 5 === 0 || tilesDone === tiles.length) {
    log(`  Voortgang: ${tilesDone}/${tiles.length} tiles, ${allPois.size} unieke POIs`);
  }
  await sleep(DELAY_MS);
}

const result = Array.from(allPois.values());
cacheWrite('mapy-id-lookup.json', result);

ok(`Stap 2b voltooid ✓`);
log(`  Unieke Mapy-POIs gevonden: ${result.length}`);
log(`  Opgeslagen in cache/mapy-id-lookup.json`);
