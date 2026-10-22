# Sporløs

*Vi viser deg toget – hvis det finnes.*

Sanntidsoversikt over tog mellom **Ski og Oslo S** (eller hvilke som helst to togstasjoner du velger), begge veier, med forsinkelser og innstillinger tydelig markert.

## Hvordan det virker

- Ren statisk webapp (HTML/CSS/JS, ingen byggesteg).
- Data hentes direkte i nettleseren fra Enturs åpne API-er (ingen API-nøkkel, men `ET-Client-Name` er påkrevd):
  - **Geocoder** – stasjonssøk (kun togstasjoner) og oppslag av stopp-ID fra navn (caches i `localStorage`).
  - **Journey Planner v3 (GraphQL)** – henter togavganger fra avgangsstasjonen (`estimatedCalls`, inkludert innstilte), og beholder bare turer som faktisk stopper på destinasjonen senere i ruten.
- Trykk på en avgang for å se togets rute, omtrentlig posisjon (beregnet fra sanntidstider, ikke GPS) og forventet kapasitet (`occupancyStatus`, når operatøren leverer det).
- Oppdateres hvert 30. sekund og når fanen blir aktiv igjen.
- Et tog regnes som forsinket fra 3 minutter (samme grense som Bane NORs punktlighetsmåling).

## Kjør lokalt

```bash
python -m http.server 8000
# åpne http://localhost:8000
```

## Velg og lagre strekninger

- Trykk på **Fra** eller **Til** for å søke opp en annen togstasjon. ⇄ snur retningen.
- ☆ **Lagre** legger strekningen i «mine strekninger» (knappene under). Trykk på en lagret strekning for å bytte til den, og én gang til for å snu retningen.
- Alt lagres kun lokalt i nettleseren (`localStorage`) – ingen innlogging, ingen database. Ny enhet eller tømt nettleser betyr blanke ark.

URL-parametere:

- `?fra=Lillestrøm&til=Oslo S` – stasjonsnavn eller NSR-ID (`NSR:StopPlace:…`).
- `?retning=oslo` (Ski → Oslo S) eller `?retning=ski` (Oslo S → Ski) virker fortsatt.

## Publisering

Appen publiseres til **Azure Static Web Apps** av `.github/workflows/azure-static-web-apps.yml`:

- Push til `main` publiserer produksjon.
- Pull requests mot `main` får en egen forhåndsvisnings-URL, som slettes når PR-en lukkes.
- Rotmappen publiseres som den er (ingen byggesteg, ingen API).

Workflowen trenger secret `AZURE_STATIC_WEB_APPS_API_TOKEN` (deployment token fra Azure-portalen: *Static Web App → Overview → Manage deployment token*), lagt inn under *Settings → Secrets and variables → Actions*.

## Konfigurasjon

Se `config.js` – standardstrekning, grense for forsinkelse, oppdateringsintervall og antall avganger.

## Datakilde

Data fra [Entur](https://developer.entur.no), lisensiert under NLOD.
