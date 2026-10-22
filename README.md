# Sporløs

*Vi viser deg toget – hvis det finnes.*

Sanntidsoversikt over tog mellom **Ski og Oslo S**, begge veier, med forsinkelser og innstillinger tydelig markert.

## Hvordan det virker

- Ren statisk webapp (HTML/CSS/JS, ingen byggesteg).
- Data hentes direkte i nettleseren fra Enturs åpne API-er (ingen API-nøkkel, men `ET-Client-Name` er påkrevd):
  - **Geocoder** – slår opp stopp-ID for Ski stasjon og Oslo S første gang (caches i `localStorage`).
  - **Journey Planner v3 (GraphQL)** – henter togavganger fra avgangsstasjonen (`estimatedCalls`, inkludert innstilte), og beholder bare turer som faktisk stopper på destinasjonen senere i ruten.
- Trykk på en avgang for å se togets rute, omtrentlig posisjon (beregnet fra sanntidstider, ikke GPS) og forventet kapasitet (`occupancyStatus`, når operatøren leverer det).
- Oppdateres hvert 30. sekund og når fanen blir aktiv igjen.
- Et tog regnes som forsinket fra 3 minutter (samme grense som Bane NORs punktlighetsmåling).

## Kjør lokalt

```bash
python -m http.server 8000
# åpne http://localhost:8000
```

Retning kan settes i URL: `?retning=oslo` (Ski → Oslo S) eller `?retning=ski` (Oslo S → Ski).

## Publisering

Appen publiseres til **Azure Static Web Apps** av `.github/workflows/azure-static-web-apps.yml`:

- Push til `main` publiserer produksjon.
- Pull requests mot `main` får en egen forhåndsvisnings-URL, som slettes når PR-en lukkes.
- Rotmappen publiseres som den er (ingen byggesteg, ingen API).

Workflowen trenger secret `AZURE_STATIC_WEB_APPS_API_TOKEN` (deployment token fra Azure-portalen: *Static Web App → Overview → Manage deployment token*), lagt inn under *Settings → Secrets and variables → Actions*.

## Konfigurasjon

Se `config.js` – stasjoner, grense for forsinkelse, oppdateringsintervall og antall avganger.

## Datakilde

Data fra [Entur](https://developer.entur.no), lisensiert under NLOD.
