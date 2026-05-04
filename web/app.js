/**
 * Peaks of the Balkans — Offline POI Viewer
 * Vanilla JS, geen build-tooling nodig.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

let allPois = [];
let filtered = [];
let activeCategory = 'all';
let searchQuery = '';
let userLat = null, userLon = null;
let activeView = 'list';  // 'list' | 'map'

// Leaflet instanties
let leafletMap = null;
let userMarker = null;
let poiMarkers = [];       // { marker, poi } paren

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  registerSW();
  setupOfflineBanner();

  try {
    const res = await fetch('data.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allPois = data.pois ?? [];
    window._routeData = data.route ?? null;
    document.getElementById('loading').style.display = 'none';
    setupViewTabs();
    setupFilters();
    applyFilters();
    setupSearch();
    setupLocate();
  } catch (err) {
    document.getElementById('loading').innerHTML =
      `<div style="text-align:center;padding:40px;color:#ff6b6b">
        <div style="font-size:2rem">⚠️</div>
        <p style="margin-top:8px">Kan data.json niet laden.<br>
        Voer de build-pipeline uit eerst.</p>
        <pre style="font-size:.7rem;margin-top:8px;opacity:.6">${err.message}</pre>
      </div>`;
  }
}

// ── Service Worker registratie ────────────────────────────────────────────────

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ── Offline-banner ────────────────────────────────────────────────────────────

function setupOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  function update() {
    banner.classList.toggle('show', !navigator.onLine);
  }
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

// ── Filter-chips ──────────────────────────────────────────────────────────────

function setupFilters() {
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      activeCategory = chip.dataset.cat;
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      applyFilters();
    });
  });
}

// ── Zoeken ────────────────────────────────────────────────────────────────────

function setupSearch() {
  const input = document.getElementById('search');
  input.addEventListener('input', () => {
    searchQuery = input.value.trim().toLowerCase();
    applyFilters();
  });
}

// ── Filter + render ───────────────────────────────────────────────────────────

function applyFilters() {
  filtered = allPois.filter(poi => {
    if (activeCategory !== 'all' && poi.category !== activeCategory) return false;
    if (searchQuery) {
      const haystack = [
        poi.name,
        poi.description_en ?? '',
        poi.description ?? '',
        ...(poi.reviews ?? []).map(r => r.text_en ?? r.text ?? ''),
      ].join(' ').toLowerCase();
      if (!haystack.includes(searchQuery)) return false;
    }
    return true;
  });

  // Sorteer: als locatie bekend, op afstand; anders op km langs route
  if (userLat !== null) {
    filtered.sort((a, b) => haversine(userLat, userLon, a.lat, a.lon) - haversine(userLat, userLon, b.lat, b.lon));
  }
  // (Standaard al gesorteerd op distance_along_route_km vanuit data.json)

  renderList();
  document.getElementById('stats').textContent =
    `${filtered.length} van ${allPois.length} locaties${userLat ? ' — gesorteerd op afstand van jou' : ''}`;
}

// ── POI-lijst renderen ────────────────────────────────────────────────────────

function renderList() {
  const list = document.getElementById('list');
  const noResults = document.getElementById('no-results');

  if (filtered.length === 0) {
    list.innerHTML = '';
    noResults.classList.add('show');
    return;
  }
  noResults.classList.remove('show');

  list.innerHTML = filtered.map(poi => {
    const thumb = poi.photos?.[0]
      ? `<img class="poi-thumb" src="${esc(poi.photos[0])}" loading="lazy" alt="" onerror="this.style.display='none'">`
      : `<div class="poi-thumb-placeholder">${categoryEmoji(poi.category)}</div>`;

    const topReview = poi.reviews?.[0];
    const snippet = topReview
      ? `"${esc((topReview.text_en || topReview.text || '').slice(0, 90))}…"`
      : (poi.description_en || poi.description || '');

    const starsHtml = poi.rating_stars
      ? `<span class="stars">${starsString(poi.rating_stars)}</span> <span style="font-size:.75rem;color:var(--text2)">${poi.rating_stars.toFixed(1)} (${poi.review_count})</span>`
      : (poi.review_count > 0 ? `<span style="font-size:.75rem;color:var(--text2)">${poi.review_count} review${poi.review_count > 1 ? 's' : ''}</span>` : '');

    return `
      <div class="poi-card" onclick="openDetail(${poi.osm_id},'${poi.osm_type}')">
        <div class="poi-card-inner">
          ${thumb}
          <div class="poi-info">
            <div class="poi-name">${esc(poi.name)}</div>
            <div class="poi-meta">
              <span class="cat-badge ${poi.category}">${categoryLabel(poi.category)}</span>
              <span class="poi-km">km ${poi.distance_along_route_km}</span>
              ${starsHtml}
            </div>
            ${snippet ? `<div class="poi-snippet">${esc(snippet)}</div>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── Detail-weergave ───────────────────────────────────────────────────────────

window.openDetail = function(osmId, osmType) {
  const poi = allPois.find(p => p.osm_id == osmId && p.osm_type === osmType);
  if (!poi) return;

  const detail = document.getElementById('detail');

  // Mini-kaart
  const tileHtml = poi.tile
    ? `<img id="detail-tile" src="${esc(poi.tile)}" alt="Kaart van ${esc(poi.name)}" loading="eager">`
    : `<div id="detail-tile-placeholder">📍 ${esc(poi.name)}<br><small>${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)}</small></div>`;

  // Foto-carousel
  const photosHtml = (poi.photos ?? []).length > 0
    ? `<div id="detail-photos">${poi.photos.map(p =>
        `<img src="${esc(p)}" loading="lazy" alt="" onerror="this.parentNode.removeChild(this)">`
      ).join('')}</div>`
    : '';

  // Beschrijving
  const desc = poi.description_en || poi.description;
  const descHtml = desc ? `<p class="detail-desc">${esc(desc)}</p>` : '';

  // Tags (website, telefoon, openingsuren, …)
  const tagEntries = Object.entries(poi.tags ?? {});
  const tagsHtml = tagEntries.length > 0
    ? `<div class="tag-list">${tagEntries.map(([k, v]) =>
        `<span class="tag">${esc(tagLabel(k))}: ${esc(v)}</span>`
      ).join('')}</div>`
    : '';

  // Coördinaten-tag altijd tonen
  const coordsHtml = `<div class="tag-list">
    <span class="tag">📍 ${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)}</span>
    <span class="tag">km ${poi.distance_along_route_km} langs route</span>
  </div>`;

  // Reviews
  const reviewCount = poi.review_count ?? poi.reviews?.length ?? 0;
  const reviewsHtml = (poi.reviews ?? []).length > 0
    ? `<div id="detail-reviews-title">${reviewCount} review${reviewCount !== 1 ? 's' : ''} via Mapy.cz</div>
       ${poi.reviews.map(r => {
         const langBadge = r.was_translated && r.lang_original
           ? `<span style="font-size:.68rem;background:var(--bg3);padding:1px 5px;border-radius:4px;color:var(--text2)">vertaald uit ${r.lang_original.toUpperCase()}</span>`
           : '';
         const posNeg = (r.positives || r.negatives)
           ? `${r.positives ? `<div style="color:#66bb6a;font-size:.82rem;margin-top:4px">👍 ${esc(r.positives)}</div>` : ''}
              ${r.negatives ? `<div style="color:#ef5350;font-size:.82rem;margin-top:2px">👎 ${esc(r.negatives)}</div>` : ''}`
           : '';
         return `
           <div class="review-card">
             <div class="review-header">
               <span class="review-author">${esc(r.author)} ${langBadge}</span>
               <span class="review-date">${r.stars ? starsString(r.stars) + ' ' : ''}${r.date ? formatDate(r.date) : ''}</span>
             </div>
             <div class="review-english">${esc(r.text_en || r.text || '')}</div>
             ${posNeg}
           </div>`;
       }).join('')}`
    : `<p style="color:var(--text2);font-size:.85rem">Geen reviews gevonden op Mapy.cz voor deze locatie.</p>`;

  // Mapy.cz deeplink
  const mapyUrl = poi.mapy_url ?? `https://mapy.com/en/place/osm-${poi.osm_type === 'node' ? 'N' : poi.osm_type === 'way' ? 'W' : 'R'}${poi.osm_id}/`;
  const openBtn = `<a id="open-mapy-btn" href="${esc(mapyUrl)}" target="_blank" rel="noopener">
    Open op Mapy.cz (vereist internet)
  </a>`;

  const starsHtml = poi.rating_stars
    ? `<span class="stars">${starsString(poi.rating_stars)}</span>
       <span style="font-size:.82rem;color:var(--text2)">${poi.rating_stars.toFixed(1)} / 5 · ${poi.review_count} reviews</span>
       ${poi.rating_caption ? `<span style="font-size:.78rem;color:var(--accent)">${esc(poi.rating_caption)}</span>` : ''}`
    : '';

  detail.innerHTML = `
    <div id="detail-back">
      <button onclick="closeDetail()" aria-label="Terug">‹</button>
      <h2>${esc(poi.name)}</h2>
      <span class="cat-badge ${poi.category}">${categoryLabel(poi.category)}</span>
    </div>

    ${tileHtml}
    ${photosHtml}

    <div id="detail-info">
      <div class="detail-meta">
        ${starsHtml}
      </div>
      ${descHtml}
      ${tagsHtml}
      ${coordsHtml}
      ${reviewsHtml}
      ${openBtn}
      <div style="height: calc(var(--safe-bottom) + 20px)"></div>
    </div>
  `;

  detail.classList.add('open');
  detail.scrollTop = 0;
  // Voorkom scroll op body
  document.body.style.overflow = 'hidden';
};

window.closeDetail = function() {
  document.getElementById('detail').classList.remove('open');
  document.body.style.overflow = '';
};

// Swipe-to-close op detail (iOS-gevoel)
(function() {
  let startY = 0;
  document.addEventListener('touchstart', e => {
    if (document.getElementById('detail').classList.contains('open')) {
      startY = e.touches[0].clientY;
    }
  });
  document.addEventListener('touchend', e => {
    if (!document.getElementById('detail').classList.contains('open')) return;
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 80 && document.getElementById('detail').scrollTop < 5) {
      closeDetail();
    }
  });
})();

// ── Weergave-tabs ─────────────────────────────────────────────────────────────

function setupViewTabs() {
  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeView = btn.dataset.view;
      document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const listEl    = document.getElementById('list');
      const statsEl   = document.getElementById('stats');
      const filtersEl = document.getElementById('filters');
      const mapView   = document.getElementById('map-view');
      const locateBtn = document.getElementById('locate-btn');

      if (activeView === 'map') {
        listEl.style.display    = 'none';
        statsEl.style.display   = 'none';
        filtersEl.style.display = 'none';
        mapView.style.display   = 'block';
        locateBtn.style.bottom  = 'calc(var(--safe-bottom) + 20px)';
        initMap();
      } else {
        listEl.style.display    = '';
        statsEl.style.display   = '';
        filtersEl.style.display = '';
        mapView.style.display   = 'none';
      }
    });
  });
}

// ── Leaflet kaart ─────────────────────────────────────────────────────────────

const CAT_COLORS = {
  accommodation: '#FF6B35',
  water:         '#29B6F6',
  food:          '#E91E63',
  sights:        '#66BB6A',
};

function initMap() {
  if (leafletMap) {
    // Al geïnitialiseerd — refresh markers voor actieve filter
    leafletMap.invalidateSize();
    updateMapMarkers();
    return;
  }

  // Centreer op middelpunt van de route
  const allCoords = window._routeData?.geometry?.coordinates ?? [];
  const midIdx    = Math.floor(allCoords.length / 2);
  const center    = allCoords.length > 0
    ? [allCoords[midIdx][1], allCoords[midIdx][0]]
    : [42.5, 19.9];

  leafletMap = L.map('map', { zoomControl: true }).setView(center, 12);

  // OSM tiles — worden gecached door service worker na eerste gebruik
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
    maxZoom: 18,
    crossOrigin: true,
  }).addTo(leafletMap);

  // Route tekenen
  if (window._routeData) {
    L.geoJSON(window._routeData, {
      style: { color: '#7c6af5', weight: 3, opacity: 0.85 },
    }).addTo(leafletMap);
  }

  updateMapMarkers();

  // Pas kaart aan als GPS al bekend is
  if (userLat !== null) updateUserMarker(userLat, userLon);
}

function updateMapMarkers() {
  if (!leafletMap) return;

  // Verwijder oude markers
  for (const { marker } of poiMarkers) marker.remove();
  poiMarkers = [];

  // Voeg gefilterde POIs toe als circle markers
  for (const poi of allPois) {
    const color = CAT_COLORS[poi.category] ?? '#9E9E9E';

    const marker = L.circleMarker([poi.lat, poi.lon], {
      radius: 8,
      fillColor: color,
      color: '#fff',
      weight: 1.5,
      opacity: 1,
      fillOpacity: 0.9,
    }).addTo(leafletMap);

    const starsStr = poi.rating_stars
      ? `${'★'.repeat(Math.round(poi.rating_stars))} ${poi.rating_stars.toFixed(1)}`
      : (poi.review_count > 0 ? `${poi.review_count} review${poi.review_count > 1 ? 's' : ''}` : '');

    marker.bindPopup(`
      <div class="map-popup-name">${esc(poi.name)}</div>
      <div class="map-popup-meta">
        ${categoryLabel(poi.category)} · km ${poi.distance_along_route_km}
        ${starsStr ? `· ${starsStr}` : ''}
      </div>
      <button class="map-popup-btn" onclick="openDetail(${poi.osm_id},'${poi.osm_type}')">
        Bekijk reviews & foto's
      </button>
    `, { maxWidth: 220 });

    poiMarkers.push({ marker, poi });
  }
}

function updateUserMarker(lat, lon) {
  if (!leafletMap) return;

  if (userMarker) userMarker.remove();

  // Pulserende blauwe stip voor huidige locatie
  const icon = L.divIcon({
    className: '',
    html: '<div class="location-pulse"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

  userMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 })
    .addTo(leafletMap)
    .bindPopup('<b>📍 Jij bent hier</b>');
}

// ── GPS-locatieknop ────────────────────────────────────────────────────────────

function setupLocate() {
  const btn = document.getElementById('locate-btn');
  if (!navigator.geolocation) { btn.style.display = 'none'; return; }

  btn.addEventListener('click', () => {
    btn.textContent = '⏳';
    navigator.geolocation.getCurrentPosition(
      pos => {
        userLat = pos.coords.latitude;
        userLon = pos.coords.longitude;
        btn.textContent = '📍';

        // Update kaartmarker + zoom naar locatie
        updateUserMarker(userLat, userLon);
        if (leafletMap && activeView === 'map') {
          leafletMap.setView([userLat, userLon], Math.max(leafletMap.getZoom(), 14));
        }

        // Sorteer lijst op afstand
        applyFilters();
      },
      () => { btn.textContent = '📍'; },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

// ── Hulpfuncties ──────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function starsString(rating) {
  const full = Math.round(rating);
  return '★'.repeat(Math.min(5, Math.max(0, full))) + '☆'.repeat(Math.max(0, 5 - full));
}

function categoryLabel(cat) {
  return { accommodation: '🏕 Slaap', water: '💧 Water', food: '🍽 Eten', sights: '🏔 Zien' }[cat] ?? cat;
}

function categoryEmoji(cat) {
  return { accommodation: '🏕', water: '💧', food: '🍽', sights: '🏔' }[cat] ?? '📍';
}

function tagLabel(key) {
  const map = {
    website: '🌐 Website', phone: '📞 Tel', email: '✉ Email',
    opening_hours: '🕐 Uren', fee: '💶 Prijs', drinking_water: '💧 Drinkwater',
    ele: '⛰ Hoogte', operator: '🏢 Beheerder', 'addr:city': '🏙 Stad',
    capacity: '🛏 Capaciteit', access: '🚪 Toegang',
  };
  return map[key] ?? key;
}

function formatDate(dateStr) {
  try {
    return new Date(dateStr).toLocaleDateString('nl-BE', { year: 'numeric', month: 'short' });
  } catch {
    return dateStr;
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Start ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
