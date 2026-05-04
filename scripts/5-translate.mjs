/**
 * Stap 5 — Vertalingen afwerken via DeepL Free API
 *
 * Reviews zijn al vertaald door Mapy.cz (forceTranslation=true in stap 3).
 * DeepL wordt hier enkel nog gebruikt voor OSM-tags die niet in het Engels zijn
 * (bv. beschrijvingen, opening_hours-tekst, operatornamen in lokale talen).
 *
 * Als je geen DeepL key hebt: de stap wordt overgeslagen en alles werkt nog steeds —
 * enkel OSM-beschrijvingen blijven in de lokale taal.
 *
 * Output: cache/pois-translated.json
 */

import { createHash } from 'crypto';
import pLimit from 'p-limit';
import { log, ok, warn, cacheRead, cacheWrite, cacheExists, fetchWithRetry, sleep } from './utils.mjs';
import 'dotenv/config';

const DEEPL_API_KEY   = process.env.DEEPL_API_KEY;
const TARGET_LANG     = process.env.TRANSLATE_TARGET_LANG ?? 'EN-GB';
const CONCURRENCY     = 3;

// DeepL Free API endpoint (key eindigt op :fx)
const isFreeKey = DEEPL_API_KEY?.endsWith(':fx');
const DEEPL_BASE = isFreeKey
  ? 'https://api-free.deepl.com/v2/translate'
  : 'https://api.deepl.com/v2/translate';

const pois = cacheRead('pois-with-photos.json');
if (!pois) {
  console.error('❌  cache/pois-with-photos.json niet gevonden. Voer eerst stap 4 uit.');
  process.exit(1);
}

// ── Geen DeepL key → alles doorgeven zonder vertaling ────────────────────────

if (!DEEPL_API_KEY) {
  warn('DEEPL_API_KEY niet ingesteld — OSM-beschrijvingen worden niet vertaald.');
  warn('Reviews zijn al vertaald door Mapy.cz → app werkt volledig zonder DeepL.');
  log('Kopieer pois-with-photos.json als pois-translated.json...');
  cacheWrite('pois-translated.json', pois);
  ok('Stap 5 overgeslagen (geen DeepL key) — data doorgegeven ✓');
  process.exit(0);
}

// ── Vertaal-cache ─────────────────────────────────────────────────────────────

let transCache = cacheExists('translations.json') ? cacheRead('translations.json') : {};
let newTranslations = 0;

function hashText(text) {
  return createHash('md5').update(text).digest('hex').slice(0, 16);
}

// Detecteer simpele heuristiek: is de tekst waarschijnlijk al Engels?
function likelyEnglish(text) {
  if (!text) return true;
  // Snelle check: bevat veel Engelse stopwoorden?
  const eng = /\b(the|and|is|of|in|to|a|for|with|at|from|this|that|are|was|it)\b/gi;
  const matches = (text.match(eng) ?? []).length;
  return matches >= 2 || text.length < 20;
}

async function translate(text) {
  if (!text || text.trim().length < 5) return null;
  if (likelyEnglish(text)) return null;     // al Engels → niet vertalen

  const hash = hashText(text);
  if (transCache[hash]) return transCache[hash];

  const trimmed = text.length > 4500 ? text.slice(0, 4500) + '…' : text;

  try {
    const res = await fetchWithRetry(DEEPL_BASE, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: [trimmed], target_lang: TARGET_LANG }),
    });

    if (!res.ok) {
      warn(`DeepL fout ${res.status}`);
      return null;
    }

    const data = await res.json();
    const translated = data.translations?.[0]?.text ?? null;
    if (translated) {
      transCache[hash] = translated;
      newTranslations++;
    }
    return translated;
  } catch (err) {
    warn(`Vertaalfout: ${err.message}`);
    return null;
  }
}

// ── Hoofdprogramma ────────────────────────────────────────────────────────────

log('DeepL-vertaling van OSM-beschrijvingen…');
log('(Reviews zijn al in het Engels dankzij Mapy.cz forceTranslation ✓)');

const limitFn = pLimit(CONCURRENCY);
let done = 0;

const translatedPois = await Promise.all(pois.map(poi => limitFn(async () => {
  const updated = { ...poi };

  // Vertaal OSM-beschrijving als die niet in het Engels is
  const osmDesc = poi.tags?.description ?? poi.tags?.['description:en'] ?? null;
  if (osmDesc) {
    updated.description = osmDesc;
    const en = await translate(osmDesc);
    updated.description_en = en ?? (likelyEnglish(osmDesc) ? osmDesc : null);
    if (en) await sleep(100);
  }

  // Reviews hoeven NIET hertaald — al gedaan door Mapy.cz
  // text_en is gelijk aan text (stap 3 zette ze al gelijk)

  done++;
  if (done % 30 === 0 || done === pois.length) {
    log(`Voortgang: ${done}/${pois.length} POIs (${newTranslations} nieuwe vertalingen)`);
  }

  return updated;
})));

cacheWrite('translations.json', transCache);
cacheWrite('pois-translated.json', translatedPois);

ok(`Stap 5 voltooid ✓  — ${newTranslations} nieuwe DeepL-vertalingen`);
