# Sporløs

*Vi viser deg toget – hvis det finnes.*

Sanntidsoversikt over tog mellom **Ski og Oslo S**, begge veier, med forsinkelser og innstillinger tydelig markert.

## Hvordan det virker

- Ren statisk webapp (HTML/CSS/JS, ingen byggesteg).
- Data hentes direkte i nettleseren fra Enturs åpne API-er (ingen API-nøkkel, men `ET-Client-Name` er påkrevd):
  - **Geocoder** – slår opp stopp-ID for Ski stasjon og Oslo S første gang (caches i `localStorage`).
  - **Journey Planner v3 (GraphQL)** – henter togavganger fra avgangsstasjonen (`estimatedCalls`, inkludert innstilte), og beholder bare turer som faktisk stopper på destinasjonen senere i ruten.
- Oppdateres hvert 30. sekund og når fanen blir aktiv igjen.
- Et tog regnes som forsinket fra 3 minutter (samme grense som Bane NORs punktlighetsmåling).

## Kjør lokalt

```bash
python -m http.server 8000
# åpne http://localhost:8000
```

Retning kan settes i URL: `?retning=oslo` (Ski → Oslo S) eller `?retning=ski` (Oslo S → Ski).

## Publisering

`.github/workflows/pages.yml` publiserer til GitHub Pages ved push til `main`.
Slå på Pages under *Settings → Pages → Source: GitHub Actions*.

## Konfigurasjon

Se `config.js` – stasjoner, grense for forsinkelse, oppdateringsintervall og antall avganger.

## Datakilde

Data fra [Entur](https://developer.entur.no), lisensiert under NLOD.
