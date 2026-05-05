# ─────────────────────────────────────────────────────────────────────────────
# reset-for-new-route.ps1
#
# Gebruik: kopieer eerst het volledige project naar een nieuwe map,
# vervang data/route.gpx door je nieuwe GPX, en run dan dit script.
#
# Wat wordt gewist (route-specifiek):
#   cache/                   alle tussenliggende build-resultaten
#   web/assets/tiles/        mini-kaartjes per POI
#   web/assets/photos/       gedownloade foto's
#   web/data.json            gebundelde output
#   web/map-tiles.json       OSM tile-lijst voor offline caching
#
# Wat blijft staan:
#   data/route.gpx           ← jij hebt dit al vervangen
#   scripts/                 build-pipeline (ongewijzigd)
#   web/  (app/style/sw)     de PWA zelf (ongewijzigd)
#   node_modules/            dependencies
#   .env                     API-keys
# ─────────────────────────────────────────────────────────────────────────────

$root = $PSScriptRoot

Write-Host ""
Write-Host "  Mapy.cz Offline Viewer — reset voor nieuwe route" -ForegroundColor Cyan
Write-Host "  ─────────────────────────────────────────────────"

# Controleer of route.gpx bestaat
$gpx = Join-Path $root "data\route.gpx"
if (-not (Test-Path $gpx)) {
    Write-Host ""
    Write-Host "  ❌  data\route.gpx niet gevonden!" -ForegroundColor Red
    Write-Host "     Kopieer je GPX-bestand naar data\route.gpx en probeer opnieuw."
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "  GPX gevonden: $gpx" -ForegroundColor Green

# Bevestiging vragen
Write-Host ""
Write-Host "  Dit wist: cache/, web/assets/tiles/, web/assets/photos/,"
Write-Host "            web/data.json, web/map-tiles.json"
Write-Host ""
$confirm = Read-Host "  Doorgaan? (j/n)"
if ($confirm -notin @("j", "J", "y", "Y")) {
    Write-Host "  Geannuleerd." -ForegroundColor Yellow
    exit 0
}

Write-Host ""

# Wissen
$toRemove = @(
    "cache",
    "web\assets\tiles",
    "web\assets\photos"
)
foreach ($rel in $toRemove) {
    $path = Join-Path $root $rel
    if (Test-Path $path) {
        Remove-Item -Recurse -Force $path
        Write-Host "  🗑  $rel verwijderd" -ForegroundColor DarkGray
    }
}

foreach ($rel in @("web\data.json", "web\map-tiles.json")) {
    $path = Join-Path $root $rel
    if (Test-Path $path) {
        Remove-Item -Force $path
        Write-Host "  🗑  $rel verwijderd" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "  ✅  Reset klaar! Voer nu uit:" -ForegroundColor Green
Write-Host ""
Write-Host "      npm run build" -ForegroundColor White
Write-Host ""
