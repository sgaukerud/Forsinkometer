# 001 – Videre arbeid på Sporløs

Mulige neste steg, i omtrent prioritert rekkefølge:

1. **Verifiser mot live API** – åpne appen lokalt, sjekk at Ski stasjon slås opp riktig i Geocoder og at både L2, R21, RE20 m.fl. dukker opp i begge retninger.
2. **Statistikk over tid** – logg avganger (f.eks. GitHub Action hver 5. min som skriver til JSON/SQLite) og vis punktlighet per dag/uke: «Sporløs-indeksen».
3. **Varsler** – push/PWA-varsel når «ditt» tog blir forsinket eller innstilt.
4. **PWA** – manifest og service worker så appen kan legges på hjemskjermen.
5. **Flere strekninger** – gjør stasjonsparet konfigurerbart via URL (`?fra=…&til=…`).
