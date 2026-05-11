# Offline Hiking POI Viewer

Offline companion-app voor wandelroutes. Toont Mapy.cz-reviews, foto's en
een interactieve kaart voor campings, guesthouses, waterbronnen, grotten,
warmwaterbronnen en andere bezienswaardigheden — **100% offline** op iPhone via PWA.

## Hoe het werkt

1. **Bouw de data** op je machine (éénmaal, ~20–30 min)
2. **Push naar GitHub** → GitHub Actions deployt automatisch naar GitHub Pages
3. **Open op iPhone** in Safari → "Zet op beginscherm" → vliegtuigmodus aanzetten

---

## Vereisten

- **Node.js 20+** — [nodejs.org](https://nodejs.org)
- **Mapy.com API key** (gratis) — [developer.mapy.com](https://developer.mapy.com)
- **DeepL Free API key** (optioneel, gratis) — [deepl.com/pro-api](https://www.deepl.com/pro-api)

---

## Setup

```powershell
# 1. Dependencies installeren
npm install

# 2. .env aanmaken vanuit template
copy .env.example .env
# Open .env en vul je API-keys in

# 3. GPX-bestand toevoegen
copy jouw-route.gpx data/route.gpx
```

### Optioneel: extra zones toevoegen

Wil je ook een zijpad of alternatieve route meenemen?
Bewerk `data/extra-zones.geojson` en voeg polygonen toe.

---

## Build uitvoeren

```powershell
# Volledige build (alle 7 stappen):
npm run build

# Of stap voor stap (handig bij problemen):
npm run step1    # GPX → zoekzone + buffer
npm run step2    # POIs zoeken via Overpass (OSM)
npm run step3    # Mapy.cz reviews ophalen
npm run step4    # Foto's downloaden
npm run step5    # Reviews vertalen (DeepL, optioneel)
npm run step6    # Kaarttiles genereren (zoom 1–17)
npm run step7    # Alles bundelen naar web/data.json
```

De build is **resume-vriendelijk**: als hij halverwege stopt, gewoon opnieuw
`npm run build` uitvoeren — alles wat al klaar was, wordt overgeslagen.

Stap 7 bumpt automatisch de Service Worker-versie op basis van een hash van
`data.json`, zodat iPhones na een nieuwe build direct de nieuwe data krijgen.

---

## POI-types die worden opgehaald

| Categorie | Types |
|---|---|
| 🏕 Slaap | Camping, alpine hut, onbemande hut, guesthouse, hostel, chalet, hotel, schuilplaats |
| 💧 Water | Drinkwaterbronnen, waterputten, publieke toiletten |
| 🍽 Eten | Restaurant, café, snackbar, pub, winkel, supermarkt |
| 🏔 Zien | Waterval, uitkijkpunt, bergtop, grot, warmwaterbron, kloof, kasteel, ruïne, attractie |

---

## App-functies

- **Lijst + kaart** — schakel tussen lijstweergave en interactieve Leaflet-kaart
- **Offline kaart** — kaarttiles worden gecached (zoom 1–17, ~250 MB)
- **Reviews & foto's** — Mapy.cz reviews met sterren, foto's met datum, lightbox met pinch-to-zoom
- **GPS-locatie** — toon je positie op de kaart
- **Zoeken** — zoek op naam of reviewtekst
- **Favorieten** — sla POIs op met ★
- **Persoonlijke notities** — schrijf aantekeningen per POI (offline opgeslagen)
- **Exporteer / Importeer** — deel favorieten & notities met medewandelaars via AirDrop,
  WhatsApp of iMessage (···-menu rechtsboven); slim samenvoegen bij import
- **Wifi-bewaking** — grote cache-download vraagt bevestiging op mobiele data

---

## Lokaal testen

```powershell
# SPA-modus voorkomt 404 bij herladen:
npx serve web -s

# Of met Python (geen install nodig):
cd web
python -m http.server 3000
```

Open `http://localhost:3000` in je browser.

---

## Deploy naar GitHub Pages

Push naar `main`/`master` → GitHub Actions deployt automatisch.

**Eenmalige instelling** (eenmalig per repo):
GitHub → Settings → Pages → Source: **"GitHub Actions"**

De URL is dan: `https://<gebruikersnaam>.github.io/<reponaam>/`

> Zorg dat `start_url` en `scope` in `web/manifest.webmanifest` overeenkomen
> met het subpad, bv. `"/MijnRepoNaam/"`.

---

## Offline gebruiken op iPhone

1. Open de URL in **Safari** (niet Chrome — iOS Chrome ondersteunt PWA's niet volledig)
2. Tik op **Deel** (⬆) → **Zet op beginscherm**
3. Open de app via het beginscherm-icoon
4. Tik op **"Download kaartdata"** (of wacht op automatische download op WiFi)
5. Zodra 100% gecached: **vliegtuigmodus** aanzetten → app werkt volledig offline

---

## API-keys veiligheid

- `.env` staat in `.gitignore` — **wordt nooit gecommit**
- API-keys worden **enkel gebruikt tijdens de build** op je eigen machine
- De `web/`-folder bevat **geen keys** — enkel de gegenereerde data

---

## Opnieuw builden vóór de trip

Doe een week voor vertrek een nieuwe build om de laatste reviews te hebben:

```powershell
# Verwijder stale cache (bewaar stap 1 en 2 als de route niet veranderd is):
Remove-Item -Force cache\pois-with-reviews.json
Remove-Item -Force cache\pois-with-photos.json
Remove-Item -Force cache\pois-translated.json
Remove-Item -Recurse -Force cache\details

# Volledige verse build:
npm run build

# Commit en push (GitHub Actions deployt automatisch):
git add web/
git commit -m "Pre-trip data refresh"
git push
```

De Service Worker-versie wordt automatisch geüpdatet — iPhone-gebruikers
krijgen de nieuwe data zodra ze de app openen (op de achtergrond).

---

## Bestandsstructuur

```
├── data/
│   ├── route.gpx                  ← jouw GPX (zelf toevoegen)
│   └── extra-zones.geojson        ← optionele extra zones
├── scripts/
│   ├── 1-buffer.mjs               ← GPX → zoekzone
│   ├── 2-discover-pois.mjs        ← POI-discovery via Overpass (OSM)
│   ├── 2b-mapy-ids.mjs            ← Mapy.cz POI-IDs opzoeken
│   ├── 3-fetch-reviews.mjs        ← Mapy.cz reviews ophalen
│   ├── 3b-google-reviews.mjs      ← Google Places reviews (optioneel)
│   ├── 4-download-photos.mjs      ← foto's downloaden
│   ├── 5-translate.mjs            ← DeepL vertaling (optioneel)
│   ├── 6-build-tiles.mjs          ← kaarttiles genereren (zoom 1–17)
│   ├── 7-bundle.mjs               ← data.json bundelen + SW-versie bumpen
│   ├── build-all.mjs              ← alles in één keer
│   ├── generate-icons.mjs         ← PWA-iconen genereren
│   └── spike-mapy-api.mjs         ← test Mapy.cz endpoints
├── web/                           ← de PWA (wordt automatisch gedeployd)
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── sw.js                      ← Service Worker (offline)
│   ├── manifest.webmanifest       ← PWA-manifest
│   ├── icon-192.png               ← app-icoon
│   ├── icon-512.png
│   ├── data.json                  ← gegenereerd door stap 7
│   ├── map-tiles.json             ← lijst van tile-URLs
│   └── assets/                    ← gegenereerde foto's + tiles
├── .github/workflows/deploy.yml   ← GitHub Actions deploy
├── .env.example                   ← API-key template
└── README.md
```
