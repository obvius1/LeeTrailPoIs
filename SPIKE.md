# Mapy.cz Review-API — DevTools Spike-instructies

> Lees dit als stap 3 minder dan 30% van de POIs met reviews vindt.
> Het duurt 15-20 minuten en hoeft maar eenmalig.

## Waarom dit nodig is

Mapy.cz heeft geen publieke reviews-API gedocumenteerd. Stap 3 probeert
een aantal bekende endpoint-patronen, maar die kunnen veranderd zijn.
Deze handleiding beschrijft hoe je de juiste URL zelf vindt via DevTools.

---

## Stap-voor-stap (Chrome of Firefox)

### 1. Open een Mapy.cz-plaatspagina

Ga naar `https://mapy.com/en/` en zoek een camping of guesthouse
langs de Peaks of the Balkans route. Klik op het markerpunt op de kaart.
De URL wordt nu iets als:

```
https://mapy.com/en/place/osm-N12345678/
```

Noteer de `osm-N{ID}` of `base-{ID}` in de URL — dat is de Mapy.cz ID.

### 2. Open DevTools Network tab

- **Chrome/Edge**: F12 → tab "Network"
- **Firefox**: F12 → tab "Network"

Filter: klik op **XHR** of **Fetch** om alleen API-calls te zien.

### 3. Scrolleer naar de reviews-sectie

Scroll op de pagina omlaag naar de reviews. Terwijl je scrollt, verschijnen
er nieuwe netwerkverzoeken in DevTools.

### 4. Vind de review-request

Zoek een request die:
- Naar `api.mapy.com` of `pro.mapy.cz` gaat
- `/review` of `/reviews` in de URL heeft
- JSON teruggeeft met een array van objecten (author, text, rating, ...)

Klik op die request → tab **Preview** om de structuur te zien.

### 5. Kopieer de URL

Kopieer de volledige URL (inclusief query-parameters).
Ze ziet er vermoedelijk zo uit:

```
https://api.mapy.com/v1/poi/reviews?source=osm&id=12345678&lang=en&offset=0&limit=20
```

of

```
https://pro.mapy.cz/review?service=place&operation=list&source=osm&id=12345678
```

### 6. Zoek ook de foto-request

Herhaal voor foto's: scroll naar de fotosectie, vind de API-call die
foto-URLs teruggeeft.

---

## De gevonden URL invoegen in het project

Open `scripts/3-fetch-reviews.mjs` en zoek de functie `fetchMapyReviewsApi`.
Voeg jouw URL toe bovenaan de `candidates`-array:

```js
const candidates = [
  // ← jouw gevonden URL hier, met ${osmId} i.p.v. het echte ID:
  `https://api.mapy.com/v1/poi/reviews?source=osm&id=${osmId}&lang=en&offset=0&limit=50`,
  // ... bestaande kandidaten
];
```

Verwijder daarna `cache/details/` (of specifieke POI-cache-bestanden) en
voer stap 3 opnieuw uit.

---

## Alternatief: handmatig toevoegen

Als het ophalen van reviews via de API moeilijk blijft, kan je ook
reviews handmatig kopiëren voor de meest kritieke plekken.

Maak een bestand `data/manual-reviews.json`:

```json
[
  {
    "osm_id": 12345678,
    "osm_type": "node",
    "reviews": [
      {
        "author": "Jan",
        "date": "2024-07-15",
        "stars": 2,
        "text": "Eigenaar was onvriendelijk, douche werkte niet.",
        "text_en": "Owner was unfriendly, shower didn't work."
      }
    ]
  }
]
```

`scripts/3-fetch-reviews.mjs` laadt dit bestand automatisch als het bestaat
en voegt de reviews samen met de automatisch opgehaalde.
