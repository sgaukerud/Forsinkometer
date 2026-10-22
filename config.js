// Sporløs – konfigurasjon
// Entur krever en identifiserende ET-Client-Name på formen "<organisasjon>-<applikasjon>".
window.SPORLOS_CONFIG = {
  clientName: "sgaukerud-sporlos",
  journeyPlannerUrl: "https://api.entur.io/journey-planner/v3/graphql",
  geocoderUrl: "https://api.entur.io/geocoder/v1/autocomplete",

  // Standardstrekning. Stasjonene slås opp via Entur Geocoder og caches i nettleseren;
  // fallbackId brukes hvis oppslaget feiler.
  defaultRoute: {
    from: { query: "Ski stasjon", name: "Ski", fallbackId: "NSR:StopPlace:60944" },
    to: { query: "Oslo S", name: "Oslo S", fallbackId: "NSR:StopPlace:59872" },
  },
  maxSavedRoutes: 8,

  numberOfDepartures: 40,   // hentes fra avgangsstasjonen før filtrering
  timeRangeSeconds: 3 * 3600,
  maxShown: 12,
  lateThresholdMinutes: 3,  // Bane NOR regner tog som punktlige opp til 3:59
  refreshSeconds: 30,
};
