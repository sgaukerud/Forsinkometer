// Sporløs – konfigurasjon
// Entur krever en identifiserende ET-Client-Name på formen "<organisasjon>-<applikasjon>".
window.SPORLOS_CONFIG = {
  clientName: "sgaukerud-sporlos",
  journeyPlannerUrl: "https://api.entur.io/journey-planner/v3/graphql",
  geocoderUrl: "https://api.entur.io/geocoder/v1/autocomplete",

  // Stasjonene slås opp via Entur Geocoder ved første lasting og caches i nettleseren.
  // fallbackId brukes hvis oppslaget feiler.
  stations: {
    SKI: { query: "Ski stasjon", label: "Ski", fallbackId: null },
    OSL: { query: "Oslo S", label: "Oslo S", fallbackId: "NSR:StopPlace:59872" },
  },

  directions: {
    SKI_OSL: { from: "SKI", to: "OSL" },
    OSL_SKI: { from: "OSL", to: "SKI" },
  },

  numberOfDepartures: 40,   // hentes fra avgangsstasjonen før filtrering
  timeRangeSeconds: 3 * 3600,
  maxShown: 12,
  lateThresholdMinutes: 3,  // Bane NOR regner tog som punktlige opp til 3:59
  refreshSeconds: 30,
};
