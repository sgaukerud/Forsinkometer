# 001 – Videre arbeid på Forsinkometer

Mulige neste steg, i omtrent prioritert rekkefølge:

1. **Verifiser mot live API** – åpne appen lokalt, sjekk at Ski stasjon slås opp riktig i Geocoder og at både L2, R21, RE20 m.fl. dukker opp i begge retninger.
2. **Statistikk over tid** – logg avganger (f.eks. GitHub Action hver 5. min som skriver til JSON/SQLite) og vis punktlighet per dag/uke: «Forsinkometer-indeksen». Signalfeil-telleren logger i dag kun lokalt i nettleseren (`sporlos.signal.v1`: dag → strekning → meldings-ID). Samme logikk (ordsøk i `situations`, unike ID-er per dag) kan flyttes inn i den planlagte innsamlingen, så indeksen får «signalfeil per uke» uavhengig av om noen har appen åpen.
3. **Varsler** – push/PWA-varsel når «ditt» tog blir forsinket eller innstilt.
4. **PWA** – manifest og service worker så appen kan legges på hjemskjermen.
5. ~~**Flere strekninger**~~ – gjort: stasjonsvelger, lagrede strekninger i `localStorage` og `?fra=…&til=…`.
6. ~~**Driftsmeldinger og signalfeil-teller**~~ – gjort: avviksmeldinger fra Entur over avgangslista og i avgangsdetaljene, signalfeil-teller i dagsrapporten.
