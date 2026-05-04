# Peaks of the Balkans — Offline POI Viewer

Offline companion-app voor de Peaks of the Balkans wandelroute (~10 dagen).
Toont Mapy.cz-reviews, foto's en mini-kaartjes voor campings, guesthouses,
waterbronnen en bezienswaardigheden — **100% offline** op iPhone via PWA.

## Hoe het werkt

1. **Bouw de data** op je Windows-machine (éénmaal, ~30 min)
2. **Deploy** de `web/` folder naar GitHub Pages
3. **Open op iPhone** in Safari → "Add to Home Screen" → vliegtuigmodus aanzetten

---

## Vereisten

- **Node.js 20+** — [nodejs.org](https://nodejs.org)
- **Mapy.com API key** (gratis) — [developer.mapy.com](https://developer.mapy.com)
- **DeepL Free API key** (gratis) — [deepl.com/pro-api](https://www.deepl.com/pro-api)

---

## Setup

```bash
# 1. Dependencies installeren
npm install

# 2. .env aanmaken vanuit template
copy .env.example .env
# Open .env in Notepad en vul je API-keys in

# 3. GPX-bestand toevoegen
copy jouw-route.gpx data/route.gpx
```

### Optioneel: extra zones toevoegen

Wil je ook een zijpad of alternatieve route meenemen?
Bewerk `data/extra-zones.geojson` en voeg polygonen toe.
Zie het bestand voor een voorbeeld.

---

## Build uitvoeren

```bash
# Volledige build (alle 7 stappen):
npm run build

# Of stap voor stap (handig bij problemen):
npm run step1    # GPX → zoekzone
npm run step2    # POIs zoeken
npm run step3    # Mapy.cz reviews ophalen
npm run step4    # Foto's downloaden
npm run step5    # Reviews vertalen
npm run step6    # Mini-kaartjes genereren
npm run step7    # data.json samenvoegen
```

De build is **resume-vriendelijk**: als hij halverwege stopt, gewoon opnieuw
`npm run build` uitvoeren — alles wat al klaar was, wordt overgeslagen.

### Eerste keer: spike uitvoeren

Stap 3 gebruikt een best-guess voor de Mapy.cz review-API.
Test of dat werkt:

```bash
# Pas eerst in scripts/spike-mapy-api.mjs de OSM-IDs aan
# naar bekende plekken langs jouw route, dan:
npm run spike
```

Als minder dan 30% van de POIs reviews heeft na stap 3, zie **SPIKE.md**
voor instructies om de correcte endpoint te vinden via DevTools (15 min).

---

## Lokaal testen

```bash
# Eenvoudige lokale server:
npx serve web/

# Open http://localhost:3000 in je browser
```

---

## Deploy naar GitHub Pages

```bash
# 1. Commit de web/ folder
git add web/ --force   # (web/assets/ staan niet in .gitignore)
git commit -m "Build: update POI data"
git push

# 2. Activeer GitHub Pages:
#    GitHub → Settings → Pages → Source: "Deploy from a branch" → main / web
```

De URL is dan: `https://jouwgebruikersnaam.github.io/MapyReviewOfflineViewer/`

---

## Offline gebruiken op iPhone

1. Open de URL in **Safari** (niet Chrome — iOS Chrome ondersteunt Service Workers niet goed)
2. Tik op **Deel** (🔗) → **Zet op beginscherm**
3. Eenmaal geladen: **vliegtuigmodus** aanzetten → app werkt volledig offline

---

## API-keys veiligheid

- Je `.env` bestand staat in `.gitignore` — **wordt nooit gecommit**
- De API-keys worden **enkel gebruikt tijdens de build** op je eigen machine
- De `web/` folder die naar GitHub gaat bevat **geen keys** — enkel de gegenereerde data

---

## Opnieuw builden vóór de trip

Doe een week voor vertrek een nieuwe build om de laatste reviews te hebben:

```bash
# Verwijder de cache om verse data te halen:
rm -r cache/

# Voer de build opnieuw uit:
npm run build

# Commit en push:
git add web/
git commit -m "Pre-trip data refresh"
git push
```

Open de URL opnieuw in Safari op je iPhone — de Service Worker updatet automatisch.

---

## Structuur

```
MapyReviewOfflineViewer/
├── data/
│   ├── route.gpx             ← jouw GPX (zelf toevoegen)
│   └── extra-zones.geojson   ← optionele extra zones
├── scripts/
│   ├── 1-buffer.mjs          ← GPX → zoekzone
│   ├── 2-discover-pois.mjs   ← OSM Overpass POI-discovery
│   ├── 3-fetch-reviews.mjs   ← Mapy.cz reviews scrapen
│   ├── 4-download-photos.mjs ← foto's downloaden
│   ├── 5-translate.mjs       ← DeepL vertaling
│   ├── 6-build-tiles.mjs     ← mini-kaartjes
│   ├── 7-bundle.mjs          ← data.json samenvoegen
│   ├── build-all.mjs         ← alles in één keer
│   └── spike-mapy-api.mjs    ← test Mapy.cz endpoints
├── web/                      ← de PWA (deploy dit)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── sw.js                 ← Service Worker (offline)
│   ├── manifest.webmanifest  ← PWA-manifest
│   ├── data.json             ← gegenereerd
│   └── assets/               ← gegenereerde foto's + tiles
├── .env.example              ← API-key template
├── SPIKE.md                  ← DevTools-instructies voor reviews
└── README.md
```
