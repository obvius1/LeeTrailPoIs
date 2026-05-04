/**
 * Stap 5 — Reviews vertalen via DeepL Free API
 *
 * Vertaalt review-teksten (Tsjechisch, Sloveens, Albanees, ...) naar Engels.
 * - Gebruikt DeepL Free API (500K tekens/maand gratis)
 * - Cache per tekst-hash → herstart is altijd gratis
 * - Detecteert taal automatisch (DeepL doet dit intern)
 *
 * Output: cache/pois-translated.json
 */

import { createHash } from 'crypto';
import pLimit from 'p-limit';
import { log, ok, warn, cacheRead, cacheWrite, cacheExists, fetchWithRetry, sleep } from './utils.mjs';
import 'dotenv/config';

const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const TARGET_LANG = process.env.TRANSLATE_TARGET_LANG ?? 'EN-GB';
const CONCURRENCY = 3;
const MAX_CHARS_PER_REQUEST = 4500; // DeepL max per request is 5000

// DeepL Free API endpoint (eindigt op :fx in je key)
const isFreeKey = DEEPL_API_KEY?.endsWith(':fx');
const DEEPL_BASE = isFreeKey
  ? 'https://api-free.deepl.com/v2/translate'
  : 'https://api.deepl.com/v2/translate';

if (!DEEPL_API_KEY) {
  console.error('❌  DEEPL_API_KEY niet ingesteld in .env');
  console.error('   Registreer op https://www.deepl.com/pro-api (gratis Free-tier)');
  process.exit(1);
}

// ── Vertaal-cache ─────────────────────────────────────────────────────────────

let transCache = cacheExists('translations.json') ? cacheRead('translations.json') : {};
let newTranslations = 0;
let totalChars = 0;

function hashText(text) {
  return createHash('md5').update(text).digest('hex').slice(0, 16);
}

async function translate(text) {
  if (!text || text.trim().length < 3) return text;

  const hash = hashText(text);
  if (transCache[hash]) return transCache[hash]; // cache hit

  // Knip af op max lengte
  const trimmed = text.length > MAX_CHARS_PER_REQUEST
    ? text.slice(0, MAX_CHARS_PER_REQUEST) + '…'
    : text;

  try {
    const res = await fetchWithRetry(DEEPL_BASE, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: [trimmed],
        target_lang: TARGET_LANG,
        // source_lang: auto-detect
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      warn(`DeepL fout ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const translated = data.translations?.[0]?.text ?? null;

    if (translated) {
      transCache[hash] = translated;
      newTranslations++;
      totalChars += trimmed.length;
    }

    return translated;
  } catch (err) {
    warn(`Vertaalfout: ${err.message}`);
    return null;
  }
}

// ── Hoofdprogramma ────────────────────────────────────────────────────────────

const pois = cacheRead('pois-with-photos.json');
if (!pois) {
  console.error('❌  cache/pois-with-photos.json niet gevonden. Voer eerst stap 4 uit.');
  process.exit(1);
}

// Tel hoeveel teksten vertaald moeten worden
let totalTexts = 0;
for (const poi of pois) {
  if (poi.description && !cacheExists('translations.json')) totalTexts++;
  for (const r of poi.reviews ?? []) {
    if (r.text && !transCache[hashText(r.text)]) totalTexts++;
  }
}
log(`~${totalTexts} teksten te vertalen via DeepL (${TARGET_LANG})…`);

const limit = pLimit(CONCURRENCY);
let done = 0;

const translatedPois = await Promise.all(pois.map(poi => limit(async () => {
  const updated = { ...poi };

  // Vertaal beschrijving
  if (poi.description) {
    updated.description_en = await translate(poi.description);
    await sleep(150);
  }

  // Vertaal elke review-tekst
  updated.reviews = [];
  for (const review of poi.reviews ?? []) {
    const text_en = await translate(review.text);
    updated.reviews.push({ ...review, text_en });
    await sleep(100);
  }

  done++;
  if (done % 20 === 0 || done === pois.length) {
    log(`Voortgang: ${done}/${pois.length} POIs (${newTranslations} nieuwe vertalingen)`);
  }

  return updated;
})));

// Sla vertaal-cache op (incrementeel, zodat volgende run gratis is)
cacheWrite('translations.json', transCache);
cacheWrite('pois-translated.json', translatedPois);

ok(`Stap 5 voltooid ✓`);
log(`  Nieuwe vertalingen : ${newTranslations}`);
log(`  Totale tekens      : ${totalChars.toLocaleString()}`);
log(`  (DeepL Free: 500.000 tekens/maand — je hebt nog ~${Math.max(0, 500000 - totalChars).toLocaleString()} over)`);
