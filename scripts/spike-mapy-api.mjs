/**
 * Spike-script: test of de Mapy.cz review-API bereikbaar is.
 * Gebruik: npm run spike
 *
 * Bevindingen vorige run:
 *  - HTML is SPA-shell (13.500 chars, geen JSON-LD) → HTML-scraping werkt NIET
 *  - GET /api/... → 404  (verkeerde paden)
 *  - GET pro.mapy.cz/... → 405 Method Not Allowed → endpoints BESTAAN maar willen POST + XML-RPC
 *
 * Deze run test:
 *  1. POST + XML-RPC op pro.mapy.cz (FastRPC protocol)
 *  2. Officiële Mapy.com suggest-API voor plaatsinfo
 *  3. Echte OSM-IDs langs de Peaks of the Balkans route
 */

import { fetchWithRetry, log, ok, warn, sleep } from './utils.mjs';

// ── Echte testlocaties langs de Peaks of the Balkans ─────────────────────────
// Gevonden via https://www.openstreetmap.org (filter: tourism=camp_site, guest_house)
// Vervang met jouw eigen bekende plekken als deze IDs niet meer kloppen.
const TEST_CASES = [
  {
    name: 'Guesthouse Gjelaj — Valbona (AL)',
    osm_type: 'node',
    osm_id: 5765131862,   // https://www.openstreetmap.org/node/5765131862
  },
  {
    name: 'Camping Theth (AL)',
    osm_type: 'node',
    osm_id: 6038484760,   // https://www.openstreetmap.org/node/6038484760
  },
  {
    name: 'Guesthouse Rexhaj — Valbona (AL)',
    osm_type: 'node',
    osm_id: 5765131860,   // https://www.openstreetmap.org/node/5765131860
  },
];

// ── XML-RPC helper ────────────────────────────────────────────────────────────

function xmlRpcCall(methodName, params) {
  const members = Object.entries(params).map(([key, val]) => {
    const valueTag = typeof val === 'number' && Number.isInteger(val)
      ? `<i8>${val}</i8>`
      : `<string>${val}</string>`;
    return `<member><name>${key}</name><value>${valueTag}</value></member>`;
  }).join('\n');

  return `<?xml version="1.0"?><methodCall>
<methodName>${methodName}</methodName>
<params><param><value><struct>
${members}
</struct></value></param></params>
</methodCall>`;
}

async function postXmlRpc(endpoint, methodName, params) {
  const body = xmlRpcCall(methodName, params);
  try {
    const res = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'Accept': 'application/json, text/xml, */*',
        'Origin': 'https://mapy.com',
        'Referer': 'https://mapy.com/',
      },
      body,
    });
    return res;
  } catch (err) {
    return { ok: false, status: `ERR: ${err.message}`, text: async () => '' };
  }
}

// ── Officiële Mapy.com Suggest-API ────────────────────────────────────────────

async function tryOfficialSuggestApi(name) {
  const url = `https://api.mapy.com/v1/suggest?lang=en&query=${encodeURIComponent(name)}&type=poi&limit=3`;
  log(`\n[OFFICIAL SUGGEST] ${url}`);
  try {
    const res = await fetchWithRetry(url, { headers: { 'Accept': 'application/json' } });
    log(`  Status: ${res.status}`);
    if (res.ok) {
      const data = await res.json();
      const items = data.items ?? data.results ?? [];
      if (items.length > 0) {
        ok(`  Gevonden: ${items.length} resultaten`);
        for (const item of items.slice(0, 2)) {
          log(`  - ${item.name ?? item.label} | source=${item.source ?? '?'} id=${item.id ?? '?'} | ${JSON.stringify(item).slice(0, 120)}`);
        }
        return items;
      } else {
        log(`  Geen resultaten. Response: ${JSON.stringify(data).slice(0, 200)}`);
      }
    }
  } catch (err) {
    warn(`  Fout: ${err.message}`);
  }
  return [];
}

// ── Hoofdprogramma ────────────────────────────────────────────────────────────

log('═══════════════════════════════════════════');
log(' Mapy.cz API Spike v2 — POST + XML-RPC     ');
log('═══════════════════════════════════════════\n');

// XML-RPC methode-namen om te proberen (educated guesses)
const REVIEW_METHODS = [
  'place.getReviews',
  'place.reviewList',
  'review.list',
  'poi.getReviews',
  'entity.reviews',
];

const DETAIL_METHODS = [
  'place.getDetail',
  'place.detail',
  'poi.getDetail',
  'entity.get',
];

const PRO_ENDPOINTS = [
  'https://pro.mapy.cz/review',
  'https://pro.mapy.cz/poi',
  'https://pro.mapy.cz/poilist',
  'https://pro.mapy.cz/search',
];

for (const tc of TEST_CASES) {
  log(`\n${'─'.repeat(55)}`);
  log(`Test: ${tc.name}`);
  log(`OSM: ${tc.osm_type}/${tc.osm_id}`);
  log(`${'─'.repeat(55)}`);

  const nodeType = tc.osm_type === 'node' ? 'N' : tc.osm_type === 'way' ? 'W' : 'R';
  const mapy_url = `https://mapy.com/en/place/osm-${nodeType}${tc.osm_id}/`;

  // ── Test A: Officiële suggest-API ─────────────────────────────────────────
  await tryOfficialSuggestApi(tc.name.split('—')[0].trim());
  await sleep(500);

  // ── Test B: POST + XML-RPC voor details ──────────────────────────────────
  log('\n[XML-RPC DETAIL] Probeer place.getDetail via POST...');
  let detailWorked = false;
  for (const endpoint of PRO_ENDPOINTS) {
    for (const method of DETAIL_METHODS.slice(0, 2)) {
      const res = await postXmlRpc(endpoint, method, {
        source: 'osm',
        id: tc.osm_id,
        lang: 'en',
      });
      const statusStr = String(res.status);
      if (res.ok || statusStr === '200') {
        const text = await res.text();
        ok(`  ✓ WERKT: ${method} @ ${endpoint}`);
        log(`  Preview: ${text.slice(0, 300)}`);
        detailWorked = true;
        break;
      } else {
        log(`  ${statusStr}  ${method} @ ${endpoint.replace('https://pro.mapy.cz', '')}`);
      }
      await sleep(200);
    }
    if (detailWorked) break;
  }

  // ── Test C: POST + XML-RPC voor reviews ──────────────────────────────────
  log('\n[XML-RPC REVIEWS] Probeer review-methodes via POST...');
  let reviewsWorked = false;
  for (const endpoint of PRO_ENDPOINTS) {
    for (const method of REVIEW_METHODS) {
      const res = await postXmlRpc(endpoint, method, {
        source: 'osm',
        id: tc.osm_id,
        lang: 'en',
        offset: 0,
        limit: 10,
      });
      const statusStr = String(res.status);
      if (res.ok || statusStr === '200') {
        const text = await res.text();
        ok(`  ✓ WERKT: ${method} @ ${endpoint}`);
        log(`  Preview: ${text.slice(0, 400)}`);
        reviewsWorked = true;
        break;
      } else {
        log(`  ${statusStr}  ${method} @ ${endpoint.replace('https://pro.mapy.cz', '')}`);
      }
      await sleep(200);
    }
    if (reviewsWorked) break;
  }

  if (!detailWorked && !reviewsWorked) {
    warn('  Geen enkel XML-RPC endpoint werkte voor deze POI.');
  }

  await sleep(1000);
}

log('\n═══════════════════════════════════════════');
log('Als alles 400/404/405 geeft:');
log('→ DevTools stap (zie SPIKE.md) is nodig.');
log('→ Stuur de Request URL + eerste 5 regels');
log('   Response naar Lauren zodat het script');
log('   bijgewerkt kan worden.');
log('═══════════════════════════════════════════\n');
