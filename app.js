// Sporløs – sanntid for tog mellom Ski og Oslo S via Entur Journey Planner v3.
(() => {
  "use strict";

  const CFG = window.SPORLOS_CONFIG;
  const HEADERS = { "ET-Client-Name": CFG.clientName };
  const CACHE_KEY = "sporlos.stopIds.v2";

  const $ = (id) => document.getElementById(id);
  const state = { dir: "SKI_OSL", stopIds: {}, timer: null };

  // ---------- Stasjonsoppslag ----------

  function loadCachedIds() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
  }
  function saveCachedIds(ids) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(ids)); } catch { /* ignorer */ }
  }

  async function lookupStopId(key) {
    const st = CFG.stations[key];
    const url = `${CFG.geocoderUrl}?text=${encodeURIComponent(st.query)}&layers=venue&size=10`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Geocoder ${res.status}`);
    const data = await res.json();
    const features = data.features || [];
    const isRail = (f) => (f.properties.category || []).includes("railStation");
    // Søket «Ski stasjon» gir også «Skien stasjon», så foretrekk eksakt navnetreff.
    const norm = (s) => (s || "").toLowerCase().replace(/\s+stasjon$/, "").trim();
    const exact = (f) => norm(f.properties.name) === norm(st.query);
    const hit = features.find((f) => isRail(f) && exact(f)) || features.find(isRail) || features[0];
    if (!hit) throw new Error(`Fant ikke ${st.query}`);
    return hit.properties.id;
  }

  async function resolveStopIds() {
    const cached = loadCachedIds();
    const ids = {};
    for (const key of Object.keys(CFG.stations)) {
      if (cached[key]) { ids[key] = cached[key]; continue; }
      try {
        ids[key] = await lookupStopId(key);
      } catch (err) {
        console.warn("Stasjonsoppslag feilet", key, err);
        ids[key] = CFG.stations[key].fallbackId;
      }
      if (!ids[key]) throw new Error(`Mangler stopp-ID for ${CFG.stations[key].label}`);
    }
    saveCachedIds(ids);
    return ids;
  }

  // ---------- Avganger ----------

  const QUERY = `
    query Departures($id: String!, $n: Int!, $range: Int!) {
      stopPlace(id: $id) {
        id
        name
        estimatedCalls(
          numberOfDepartures: $n
          timeRange: $range
          arrivalDeparture: departures
          includeCancelledTrips: true
          whiteListedModes: [rail]
        ) {
          aimedDepartureTime
          expectedDepartureTime
          actualDepartureTime
          realtime
          cancellation
          predictionInaccurate
          stopPositionInPattern
          quay { publicCode }
          destinationDisplay { frontText }
          situations {
            summary { value language }
            description { value language }
          }
          serviceJourney {
            id
            line { publicCode name transportSubmode }
            estimatedCalls {
              stopPositionInPattern
              aimedArrivalTime
              expectedArrivalTime
              cancellation
              quay { stopPlace { id parent { id } } }
            }
          }
        }
      }
    }`;

  async function fetchDepartures(fromId, toId) {
    const res = await fetch(CFG.journeyPlannerUrl, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: QUERY,
        variables: { id: fromId, n: CFG.numberOfDepartures, range: CFG.timeRangeSeconds },
      }),
    });
    if (!res.ok) throw new Error(`Journey Planner ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
    const calls = json.data?.stopPlace?.estimatedCalls || [];

    // Behold bare avganger som faktisk stopper på destinasjonen senere i samme tur.
    return calls
      .map((call) => {
        // Ski stasjon og Oslo S er multimodale foreldrestopp i NSR. Sporene (quay) hører til
        // et barnestopp (tog), så vi må sammenligne med både barnet og forelderen.
        const later = (call.serviceJourney?.estimatedCalls || []).find((c) => {
          const sp = c.quay?.stopPlace;
          const atDest = sp?.id === toId || sp?.parent?.id === toId;
          return atDest && c.stopPositionInPattern > call.stopPositionInPattern;
        });
        return later ? toDeparture(call, later) : null;
      })
      .filter(Boolean)
      .slice(0, CFG.maxShown);
  }

  function pickText(list) {
    if (!list?.length) return "";
    const nob = list.find((t) => t.language === "nob" || t.language === "no");
    return (nob || list[0]).value || "";
  }

  function toDeparture(call, arrival) {
    const aimed = new Date(call.aimedDepartureTime);
    const expected = new Date(call.expectedDepartureTime || call.aimedDepartureTime);
    const delayMin = Math.round((expected - aimed) / 60000);
    const cancelled = Boolean(call.cancellation || arrival.cancellation);
    const status = cancelled ? "cancelled" : delayMin >= CFG.lateThresholdMinutes ? "late" : "ok";
    const seen = new Set();
    const situations = (call.situations || [])
      .map((s) => pickText(s.summary) || pickText(s.description))
      .filter((t) => t && !seen.has(t) && seen.add(t));

    return {
      line: call.serviceJourney?.line?.publicCode || "",
      destination: call.destinationDisplay?.frontText || "",
      track: call.quay?.publicCode || "",
      aimed,
      expected,
      arrivalAimed: arrival.aimedArrivalTime ? new Date(arrival.aimedArrivalTime) : null,
      arrivalExpected: arrival.expectedArrivalTime ? new Date(arrival.expectedArrivalTime) : null,
      delayMin,
      realtime: call.realtime,
      inaccurate: call.predictionInaccurate,
      departed: Boolean(call.actualDepartureTime),
      cancelled,
      partlyCancelled: !call.cancellation && Boolean(arrival.cancellation),
      status,
      situations,
    };
  }

  // ---------- Visning ----------

  const fmt = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Oslo" });
  const t = (d) => (d ? fmt.format(d) : "–");

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function minutesUntil(d) {
    return Math.round((d - Date.now()) / 60000);
  }

  function travelMinutes(d) {
    const arr = d.arrivalExpected || d.arrivalAimed;
    return arr ? Math.round((arr - d.expected) / 60000) : null;
  }

  function renderSummary(deps) {
    const late = deps.filter((d) => d.status === "late").length;
    const gone = deps.filter((d) => d.status === "cancelled").length;
    const ok = deps.length - late - gone;
    $("stat-total").textContent = deps.length;
    $("stat-ok").textContent = ok;
    $("stat-late").textContent = late;
    $("stat-cancelled").textContent = gone;
    $("verdict").textContent = verdict(deps.length, late, gone);

    const meter = $("meter");
    const pct = (n) => (deps.length ? `${(n / deps.length) * 100}%` : "0%");
    meter.querySelector(".ok").style.width = pct(ok);
    meter.querySelector(".late").style.width = pct(late);
    meter.querySelector(".gone").style.width = pct(gone);
  }

  function renderNext(deps) {
    const box = $("next");
    const next = deps.find((d) => !d.cancelled && !d.departed && minutesUntil(d.expected) >= 0);
    box.replaceChildren();
    if (!next) { box.hidden = true; return; }
    box.hidden = false;
    box.className = `next ${next.status}`;

    const m = minutesUntil(next.expected);
    box.append(el("span", "label", m <= 1 ? "Løp!" : "Neste tog"));

    const count = el("div", "count");
    if (m <= 0) count.textContent = "Nå";
    else {
      count.append(String(m));
      count.append(el("small", null, "min"));
    }

    const when = el("div", "when");
    if (next.status === "late") when.append(el("s", null, t(next.aimed)));
    when.append(el("span", null, t(next.expected)));

    const sub = el("p", "sub");
    const bits = [];
    if (next.line) bits.push(["Linje ", next.line]);
    if (next.track) bits.push(["Spor ", next.track]);
    const tm = travelMinutes(next);
    if (next.arrivalExpected) bits.push(["Fremme ", `${t(next.arrivalExpected)}${tm ? ` (${tm} min)` : ""}`]);
    bits.forEach(([k, v], i) => {
      if (i) sub.append(" · ");
      sub.append(k, el("b", null, v));
    });
    if (next.status === "late") sub.append(` · ${next.delayMin} min forsinket, som vanlig`);

    box.append(count, when, sub);
  }

  function renderEmpty(list) {
    const li = el("li", "empty");
    li.append(
      el("span", "art", "🌾"),
      el("strong", null, "Helt sporløst."),
      el("span", null, "Ingen tog funnet de neste timene. Kanskje en sykkeltur?")
    );
    list.append(li);
  }

  function render(deps) {
    const list = $("departures");
    list.replaceChildren();
    renderSummary(deps);
    renderNext(deps);

    if (!deps.length) { renderEmpty(list); return; }

    deps.forEach((d, i) => {
      const li = el("li", `dep ${d.status}${d.departed ? " departed" : ""}`);
      li.style.animationDelay = `${Math.min(i, 8) * 30}ms`;

      const time = el("div", "time");
      if (d.status === "ok" || d.cancelled) {
        time.append(el("span", d.cancelled ? "aimed struck" : "aimed", t(d.aimed)));
      } else {
        time.append(el("span", "aimed struck", t(d.aimed)), el("span", "expected", t(d.expected)));
      }

      const main = el("div", "main");
      const head = el("div", "head");
      if (d.line) head.append(el("span", "line", d.line));
      head.append(el("span", "dest", d.destination));
      main.append(head);

      const meta = el("div", "meta");
      if (d.track) meta.append(el("span", "track", `Spor ${d.track}`));
      const parts = [];
      if (d.cancelled) parts.push(d.partlyCancelled ? "stopper ikke på destinasjonen" : "kommer ikke");
      else if (d.arrivalExpected) parts.push(`fremme ${t(d.arrivalExpected)}`);
      if (d.inaccurate) parts.push("usikker prognose");
      if (parts.length) meta.append(`${d.track ? " · " : ""}${parts.join(" · ")}`);
      main.append(meta);

      for (const s of d.situations) main.append(el("p", "situation", s));

      const badge = el("div", "badge");
      if (d.cancelled) badge.textContent = d.partlyCancelled ? "Stopper ikke" : "Innstilt";
      else if (d.status === "late") badge.textContent = `+${d.delayMin} min`;
      else {
        const m = minutesUntil(d.expected);
        badge.textContent = d.departed ? "Gått" : m <= 0 ? "Nå" : m < 15 ? `${m} min` : "I rute";
        if (!d.departed && m < 15) badge.classList.add("soon");
      }

      li.append(time, main, badge);
      list.append(li);
    });
  }

  function verdict(total, late, gone) {
    if (!total) return "Ingen tog å klage på. Det er også en slags punktlighet.";
    const bad = (late + gone) / total;
    if (gone >= 3) return "Dette blir buss for tog, kjenner vi oss igjen.";
    if (gone > 0) return "Noen tog har forsvunnet sporløst.";
    if (bad >= 0.5) return "Signalfeil-stemning. Ta med en kaffe.";
    if (bad > 0) return "Litt rusk i sporet, men det går.";
    return "Alt i rute. Nyt det mens det varer.";
  }

  function setStatus(msg, isError = false) {
    const s = $("status");
    s.querySelector(".status-text").textContent = msg;
    s.classList.toggle("error", isError);
    s.classList.toggle("loading", !isError && msg.startsWith("Henter"));
  }

  // ---------- Flyt ----------

  async function refresh() {
    const { from, to } = CFG.directions[state.dir];
    try {
      const deps = await fetchDepartures(state.stopIds[from], state.stopIds[to]);
      render(deps);
      setStatus(`Oppdatert ${t(new Date())}`);
    } catch (err) {
      console.error(err);
      setStatus(`Klarte ikke å hente avganger (${err.message}). Prøver igjen snart.`, true);
    }
  }

  function setDirection(dir) {
    state.dir = dir;
    document.querySelectorAll(".direction button").forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.dir === dir))
    );
    try { localStorage.setItem("sporlos.dir", dir); } catch { /* ignorer */ }
    const url = new URL(location.href);
    url.searchParams.set("retning", dir === "SKI_OSL" ? "oslo" : "ski");
    history.replaceState(null, "", url);
    setStatus("Henter avganger …");
    refresh();
  }

  function initialDirection() {
    const q = new URLSearchParams(location.search).get("retning");
    if (q === "oslo") return "SKI_OSL";
    if (q === "ski") return "OSL_SKI";
    try { return localStorage.getItem("sporlos.dir") || "SKI_OSL"; } catch { return "SKI_OSL"; }
  }

  async function init() {
    document.querySelectorAll(".direction button").forEach((b) =>
      b.addEventListener("click", () => setDirection(b.dataset.dir))
    );
    try {
      state.stopIds = await resolveStopIds();
    } catch (err) {
      setStatus(`Fant ikke stasjonene: ${err.message}`, true);
      return;
    }
    setDirection(initialDirection());
    state.timer = setInterval(refresh, CFG.refreshSeconds * 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
  }

  init();
})();
