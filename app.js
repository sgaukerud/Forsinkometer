// Forsinkometer – sanntid for tog på en valgfri strekning (standard Ski – Oslo S) via Entur Journey Planner v3.
(() => {
  "use strict";

  const CFG = window.SPORLOS_CONFIG;
  const HEADERS = { "ET-Client-Name": CFG.clientName };
  const KEYS = {
    ids: "sporlos.stopIds.v3",
    route: "sporlos.route.v1",
    saved: "sporlos.saved.v1",
    recent: "sporlos.recent.v1",
    signal: "sporlos.signal.v1",
  };

  const $ = (id) => document.getElementById(id);
  const state = { route: null, saved: [], timer: null, picking: null };

  // ---------- Lokal lagring (kun i denne nettleseren) ----------

  function load(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v ?? fallback;
    } catch { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* privat modus o.l. */ }
  }

  const isStation = (s) => s && typeof s.id === "string" && typeof s.name === "string";
  const isRoute = (r) => r && isStation(r.from) && isStation(r.to) && r.from.id !== r.to.id;
  const sameRoute = (a, b) => a.from.id === b.from.id && a.to.id === b.to.id;
  // En lagret strekning gjelder begge veier.
  const samePair = (a, b) => sameRoute(a, b) || (a.from.id === b.to.id && a.to.id === b.from.id);
  const reverse = (r) => ({ from: r.to, to: r.from });
  const station = (s) => ({ id: s.id, name: s.name });

  // ---------- Stasjonsoppslag (Entur Geocoder, kun tog) ----------

  const cleanName = (s) => (s || "").replace(/\s+stasjon$/i, "").trim();
  const norm = (s) => cleanName(s).toLowerCase();
  const isRail = (f) => (f.properties.category || []).includes("railStation");

  async function geocode(text, size = 20) {
    const url = `${CFG.geocoderUrl}?text=${encodeURIComponent(text)}&layers=venue&size=${size}&lang=no`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Geocoder ${res.status}`);
    const data = await res.json();
    return data.features || [];
  }

  // Søk etter togstasjoner til velgeren.
  async function searchStations(text) {
    const seen = new Set();
    return (await geocode(text))
      .filter(isRail)
      .map((f) => ({ id: f.properties.id, name: cleanName(f.properties.name), place: f.properties.locality || f.properties.county || "" }))
      .filter((s) => !seen.has(s.id) && seen.add(s.id));
  }

  // Slå opp én stasjon ut fra navn. «Ski» gir også «Skien», så foretrekk eksakt navnetreff.
  async function lookupStation(query) {
    const features = await geocode(query, 10);
    const exact = (f) => norm(f.properties.name) === norm(query);
    const hit = features.find((f) => isRail(f) && exact(f)) || features.find(isRail);
    if (!hit) throw new Error(`Fant ikke togstasjonen «${query}»`);
    return { id: hit.properties.id, name: cleanName(hit.properties.name) };
  }

  async function cachedLookup(query, fallbackId) {
    const cache = load(KEYS.ids, {});
    const key = norm(query);
    if (isStation(cache[key])) return cache[key];
    let st;
    try {
      st = await lookupStation(query);
    } catch (err) {
      if (!fallbackId) throw err;
      console.warn("Stasjonsoppslag feilet", query, err);
      return { id: fallbackId, name: cleanName(query) };
    }
    cache[key] = st;
    store(KEYS.ids, cache);
    return st;
  }

  async function stationNameById(id) {
    const res = await fetch(CFG.journeyPlannerUrl, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query($id:String!){stopPlace(id:$id){id name}}", variables: { id } }),
    });
    const json = await res.json();
    const sp = json.data?.stopPlace;
    if (!sp) throw new Error(`Ukjent stasjon ${id}`);
    return { id: sp.id, name: cleanName(sp.name) };
  }

  // URL-parameter: enten NSR-ID eller stasjonsnavn.
  const fromParam = (v) => (/^NSR:StopPlace:\d+$/.test(v) ? stationNameById(v) : cachedLookup(v));

  async function defaultRoute() {
    const d = CFG.defaultRoute;
    const [from, to] = await Promise.all([
      cachedLookup(d.from.query, d.from.fallbackId),
      cachedLookup(d.to.query, d.to.fallbackId),
    ]);
    return { from: { id: from.id, name: d.from.name }, to: { id: to.id, name: d.to.name } };
  }

  async function initialRoute() {
    const q = new URLSearchParams(location.search);
    if (q.get("fra") && q.get("til")) {
      const [from, to] = await Promise.all([fromParam(q.get("fra")), fromParam(q.get("til"))]);
      return { from, to };
    }
    const retning = q.get("retning");
    if (retning === "oslo" || retning === "ski") {
      const r = await defaultRoute();
      return retning === "ski" ? reverse(r) : r;
    }
    const saved = load(KEYS.route, null);
    if (isRoute(saved)) return saved;
    // Eldre versjoner husket bare retningen.
    const r = await defaultRoute();
    return load("sporlos.dir", null) === "OSL_SKI" ? reverse(r) : r;
  }

  // ---------- Avganger ----------

  // Avviksmeldinger (SIRI-SX) fra Bane NOR og togselskapene, publisert via Entur.
  const SITUATION = `
    fragment Sit on PtSituationElement {
      id
      reportType
      summary { value language }
      description { value language }
      advice { value language }
      validityPeriod { startTime endTime }
      infoLinks { uri label }
    }`;

  const QUERY = `
    query Departures($id: String!, $to: String!, $n: Int!, $range: Int!) {
      stopPlace(id: $id) {
        id
        name
        latitude
        longitude
        situations { ...Sit }
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
          situations { ...Sit }
          serviceJourney {
            id
            line { id publicCode name transportSubmode situations { ...Sit } }
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
      destination: stopPlace(id: $to) {
        id
        name
        situations { ...Sit }
      }
    }
    ${SITUATION}`;

  async function fetchDepartures(fromId, toId) {
    const res = await fetch(CFG.journeyPlannerUrl, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: QUERY,
        variables: { id: fromId, to: toId, n: CFG.numberOfDepartures, range: CFG.timeRangeSeconds },
      }),
    });
    if (!res.ok) throw new Error(`Journey Planner ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
    const from = json.data?.stopPlace;
    const dest = json.data?.destination;
    const calls = from?.estimatedCalls || [];

    // Behold bare avganger som faktisk stopper på destinasjonen senere i samme tur.
    const kept = calls
      .map((call) => {
        // Ski stasjon og Oslo S er multimodale foreldrestopp i NSR. Sporene (quay) hører til
        // et barnestopp (tog), så vi må sammenligne med både barnet og forelderen.
        const later = (call.serviceJourney?.estimatedCalls || []).find((c) => {
          const sp = c.quay?.stopPlace;
          const atDest = sp?.id === toId || sp?.parent?.id === toId;
          return atDest && c.stopPositionInPattern > call.stopPositionInPattern;
        });
        return later ? { call, later } : null;
      })
      .filter(Boolean)
      .slice(0, CFG.maxShown);

    // Samle avviksmeldinger for strekningen: begge stasjoner, linjene og hver enkelt avgang.
    const sits = new Situations();
    sits.add(from?.situations, `${cleanName(from?.name) || "avgangsstasjonen"}`);
    sits.add(dest?.situations, `${cleanName(dest?.name) || "ankomststasjonen"}`);
    const deps = kept.map(({ call, later }) => {
      const line = call.serviceJourney?.line;
      if (line?.publicCode) sits.add(line.situations, `linje ${line.publicCode}`);
      const own = sits.add(call.situations, line?.publicCode ? `linje ${line.publicCode}` : "enkeltavganger");
      return toDeparture(call, later, own);
    });
    const origin = from?.latitude != null && from?.longitude != null
      ? { id: from.id, name: cleanName(from.name), lat: from.latitude, lon: from.longitude }
      : null;
    return { deps, situations: sits.list(), origin };
  }

  function pickText(list) {
    if (!list?.length) return "";
    const nob = list.find((t) => t.language === "nob" || t.language === "no");
    return (nob || list[0]).value || "";
  }

  // ---------- Avviksmeldinger og signalfeil ----------

  // Fritekst, så vi må lete etter ord. Fanger «signalfeil», «feil på signalanlegget»,
  // «sikringsanlegg», «stillverk» og engelske «signal failure».
  const SIGNAL_RE = /signal|sikringsanlegg|stillverk/i;
  const SOON_MS = 3 * 3600 * 1000; // vis også meldinger som starter de neste tre timene

  function safeLink(links) {
    const l = (links || []).find((x) => /^https?:\/\//i.test(x?.uri || ""));
    return l ? { uri: l.uri, label: l.label || "Les mer" } : null;
  }

  // Samler og slår sammen meldinger fra stopp, linjer og avganger (samme melding dukker opp mange steder).
  class Situations {
    constructor(now = Date.now()) { this.now = now; this.map = new Map(); }

    // Returnerer de relevante meldingene i lista, slik at avgangen kan vise sine egne.
    add(raw, where) {
      const out = [];
      for (const r of raw || []) {
        const summary = pickText(r.summary);
        const description = pickText(r.description);
        if (!summary && !description) continue;
        const start = r.validityPeriod?.startTime ? new Date(r.validityPeriod.startTime) : null;
        const end = r.validityPeriod?.endTime ? new Date(r.validityPeriod.endTime) : null;
        if (end && end < this.now) continue;
        if (start && start - this.now > SOON_MS) continue;
        const id = r.id || summary || description;
        let s = this.map.get(id);
        if (!s) {
          const advice = pickText(r.advice);
          s = {
            id,
            summary: summary || description,
            description: description && description !== summary ? description : "",
            advice,
            start,
            end,
            upcoming: Boolean(start && start > this.now),
            incident: r.reportType === "incident",
            signal: SIGNAL_RE.test(`${summary} ${description} ${advice}`),
            link: safeLink(r.infoLinks),
            where: new Set(),
          };
          this.map.set(id, s);
        }
        if (where) s.where.add(where);
        out.push(s);
      }
      return out.filter((s, i) => out.indexOf(s) === i);
    }

    list() {
      const rank = (s) => (s.signal ? 0 : s.incident ? 1 : 2) + (s.upcoming ? 3 : 0);
      return [...this.map.values()].sort((a, b) => rank(a) - rank(b) || (b.start || 0) - (a.start || 0));
    }
  }

  // Signalfeil-telleren: husker hvilke signalfeil-meldinger vi har sett per dag og strekning,
  // kun i denne nettleseren. Teller unike meldinger, ikke antall oppdateringer.
  const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" });
  const dayKey = (d = new Date()) => dayFmt.format(d);
  const pairKey = (r) => [r.from.id, r.to.id].sort().join("|");

  function logSignals(route, situations, now = new Date()) {
    const log = load(KEYS.signal, {});
    const today = dayKey(now);
    const pair = pairKey(route);
    const active = situations.filter((s) => s.signal && !s.upcoming);
    if (active.length) {
      const day = (log[today] ||= {});
      const seen = (day[pair] ||= {});
      for (const s of active) seen[s.id] ||= { s: s.summary.slice(0, 160), t: now.toISOString() };
    }
    // Rydd: behold 30 dager.
    const cutoff = dayKey(new Date(now - 30 * 864e5));
    for (const k of Object.keys(log)) if (k < cutoff) delete log[k];
    store(KEYS.signal, log);

    const ids = (k) => Object.keys(log[k]?.[pair] || {});
    const week = new Set();
    for (let i = 0; i < 7; i++) ids(dayKey(new Date(now - i * 864e5))).forEach((id) => week.add(id));
    return { active: active.length, today: ids(today).length, week: week.size };
  }

  function toDeparture(call, arrival, situations = []) {
    const aimed = new Date(call.aimedDepartureTime);
    const expected = new Date(call.expectedDepartureTime || call.aimedDepartureTime);
    const delayMin = Math.round((expected - aimed) / 60000);
    const cancelled = Boolean(call.cancellation || arrival.cancellation);
    const status = cancelled ? "cancelled" : delayMin >= CFG.lateThresholdMinutes ? "late" : "ok";

    return {
      journeyId: call.serviceJourney?.id || "",
      fromPos: call.stopPositionInPattern,
      toPos: arrival.stopPositionInPattern,
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

  function renderSummary(deps, signalNow = 0) {
    const late = deps.filter((d) => d.status === "late").length;
    const gone = deps.filter((d) => d.status === "cancelled").length;
    const ok = deps.length - late - gone;
    $("stat-total").textContent = deps.length;
    $("stat-ok").textContent = ok;
    $("stat-late").textContent = late;
    $("stat-cancelled").textContent = gone;
    $("verdict").textContent = signalNow ? "Signalfeil. Selvfølgelig." : verdict(deps.length, late, gone);

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
      el("span", null, `Ingen direktetog fra ${state.route.from.name} til ${state.route.to.name} de neste timene. Kanskje en sykkeltur?`)
    );
    list.append(li);
  }

  function render(deps, situations = [], tally = null) {
    const list = $("departures");
    list.replaceChildren();
    renderSummary(deps, tally?.active || 0);
    renderNext(deps);
    renderAlerts(situations);
    renderTally(tally);

    if (!deps.length) { renderEmpty(list); return; }

    deps.forEach((d, i) => {
      const li = el("li", `dep ${d.status}${d.departed ? " departed" : ""}`);
      if (d.journeyId) {
        li.tabIndex = 0;
        li.setAttribute("role", "button");
        li.setAttribute("aria-haspopup", "dialog");
        li.setAttribute("aria-label", `${t(d.aimed)} ${d.line} ${d.destination}. Vis rute, posisjon og kapasitet`);
        li.addEventListener("click", () => openDetail(d));
        li.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(d); }
        });
      }
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

      for (const s of d.situations) main.append(el("p", s.signal ? "situation signal" : "situation", s.summary));

      if (d.cancelled && state.origin) {
        const beer = el("a", "pils-link", "🍺 Ventepils i nærheten");
        beer.href = pubSearchUrl(state.origin);
        beer.target = "_blank";
        beer.rel = "noopener";
        beer.addEventListener("click", (e) => {
          e.stopPropagation();
          // Har vi detaljvisning, viser vi nærmeste vannhull der i stedet for å sende deg rett til kartet.
          if (d.journeyId) { e.preventDefault(); openDetail(d); }
        });
        beer.addEventListener("keydown", (e) => e.stopPropagation());
        main.append(beer);
      }

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

  const dateFmt = new Intl.DateTimeFormat("nb-NO", { weekday: "short", day: "numeric", month: "numeric", timeZone: "Europe/Oslo" });
  const when = (d) => (dayKey(d) === dayKey() ? t(d) : `${dateFmt.format(d)} ${t(d)}`);

  function validity(s) {
    if (s.upcoming) return `Starter ${when(s.start)}`;
    if (s.start && s.end) return `${when(s.start)}–${when(s.end)}`;
    if (s.start) return `Siden ${when(s.start)}`;
    if (s.end) return `Til ${when(s.end)}`;
    return "";
  }

  function situationItem(s, tag = "li") {
    const item = el(tag, ["alert", s.signal && "signal", s.incident && "incident", s.upcoming && "upcoming"].filter(Boolean).join(" "));
    const head = el("div", "alert-head");
    if (s.signal) head.append(el("span", "tag", "Signalfeil"));
    else if (s.upcoming) head.append(el("span", "tag soft", "Kommer"));
    head.append(el("strong", null, s.summary));
    const meta = [validity(s), s.where.size ? `Gjelder ${[...s.where].join(", ")}` : ""].filter(Boolean).join(" · ");

    const extra = [];
    if (s.description) extra.push(el("p", null, s.description));
    if (s.advice && s.advice !== s.description) extra.push(el("p", "advice", s.advice));
    if (s.link) {
      const a = el("a", null, s.link.label);
      a.href = s.link.uri;
      a.target = "_blank";
      a.rel = "noopener";
      const p = el("p");
      p.append(a);
      extra.push(p);
    }

    if (extra.length) {
      const det = el("details");
      const sum = el("summary");
      sum.append(head);
      if (meta) sum.append(el("span", "alert-meta", meta));
      det.append(sum, el("div", "alert-body"));
      det.lastChild.append(...extra);
      item.append(det);
    } else {
      item.append(head);
      if (meta) item.append(el("span", "alert-meta", meta));
    }
    return item;
  }

  function renderAlerts(situations) {
    const box = $("alerts");
    const list = $("alerts-list");
    // Behold åpne meldinger åpne når lista tegnes på nytt hvert 30. sekund.
    const open = new Set([...list.querySelectorAll("details[open]")].map((d) => d.closest("[data-id]")?.dataset.id));
    list.replaceChildren();
    box.hidden = false;
    // Sammenslått som standard; overskriften viser antall og den viktigste meldingen.
    const signals = situations.filter((s) => s.signal && !s.upcoming).length;
    const count = $("alerts-count");
    count.textContent = situations.length || "";
    count.hidden = !situations.length;
    count.classList.toggle("signal", signals > 0);
    const top = situations[0];
    $("alerts-peek").textContent = top
      ? `${top.signal && !top.upcoming ? "🚦 " : ""}${top.summary}${situations.length > 1 ? ` (+${situations.length - 1})` : ""}`
      : "Ingen akkurat nå. Mistenkelig stille.";
    $("alerts-fold").classList.toggle("signal", signals > 0);
    if (!situations.length) {
      list.append(el("li", "alert none", "Ingen driftsmeldinger fra Bane NOR eller togselskapene akkurat nå. Mistenkelig stille."));
      return;
    }
    situations.forEach((s) => {
      const li = situationItem(s);
      li.dataset.id = s.id;
      if (open.has(s.id)) li.querySelector("details")?.setAttribute("open", "");
      list.append(li);
    });
  }

  function renderTally(tally) {
    const box = $("signal-tally");
    if (!tally) { box.hidden = true; return; }
    box.hidden = false;
    box.classList.toggle("hot", tally.active > 0);
    $("signal-today").textContent = tally.today;
    let note;
    if (tally.active) note = tally.active === 1 ? "1 signalfeil pågår nå." : `${tally.active} signalfeil pågår nå.`;
    else if (tally.today) note = "Ingen akkurat nå. Skinnene puster ut.";
    else note = "Ingen så langt i dag. Dagen er ung.";
    if (tally.week > tally.today) note += ` ${tally.week} siste 7 dager.`;
    $("signal-note").textContent = note;
  }

  function verdict(total, late, gone) {
    if (!total) return "Ingen tog å klage på. Det er også en slags punktlighet.";
    const bad = (late + gone) / total;
    if (gone >= 3) return "Dette blir buss for tog, kjenner vi oss igjen.";
    if (gone > 0) return "Noen tog har forsvunnet sporløst.";
    if (bad >= 0.5) return "Halve tavla er gul. Ta med en kaffe.";
    if (bad > 0) return "Litt rusk i sporet, men det går.";
    return "Alt i rute. Nyt det mens det varer.";
  }

  function setStatus(msg, isError = false) {
    const s = $("status");
    s.querySelector(".status-text").textContent = msg;
    s.classList.toggle("error", isError);
    s.classList.toggle("loading", !isError && msg.startsWith("Henter"));
  }

  // ---------- Togdetaljer: rute, posisjon og kapasitet ----------

  const JOURNEY_FIELDS = (withOccupancy) => `
    query Journey($id: String!) {
      serviceJourney(id: $id) {
        id
        estimatedCalls {
          stopPositionInPattern
          aimedArrivalTime
          expectedArrivalTime
          actualArrivalTime
          aimedDepartureTime
          expectedDepartureTime
          actualDepartureTime
          cancellation
          ${withOccupancy ? "occupancyStatus" : ""}
          quay { publicCode stopPlace { id name } }
        }
      }
    }`;

  let occupancySupported = true;

  async function fetchJourney(id) {
    const run = async (withOcc) => {
      const res = await fetch(CFG.journeyPlannerUrl, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ query: JOURNEY_FIELDS(withOcc), variables: { id } }),
      });
      if (!res.ok) throw new Error(`Journey Planner ${res.status}`);
      return res.json();
    };
    let json = await run(occupancySupported);
    // Skulle API-et ikke kjenne occupancyStatus, prøver vi uten i stedet for å vise ingenting.
    if (occupancySupported && json.errors?.some((e) => /occupancy/i.test(e.message))) {
      occupancySupported = false;
      json = await run(false);
    }
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
    const calls = json.data?.serviceJourney?.estimatedCalls;
    if (!calls?.length) throw new Error("Fant ikke ruten");
    return calls
      .slice()
      .sort((a, b) => a.stopPositionInPattern - b.stopPositionInPattern)
      .map((c) => {
        const d = (v) => (v ? new Date(v) : null);
        return {
          pos: c.stopPositionInPattern,
          name: (c.quay?.stopPlace?.name || "?").replace(/ stasjon$/, ""),
          track: c.quay?.publicCode || "",
          aimedArr: d(c.aimedArrivalTime),
          arr: d(c.actualArrivalTime || c.expectedArrivalTime || c.aimedArrivalTime),
          aimedDep: d(c.aimedDepartureTime),
          dep: d(c.actualDepartureTime || c.expectedDepartureTime || c.aimedDepartureTime),
          hasArrived: Boolean(c.actualArrivalTime),
          hasDeparted: Boolean(c.actualDepartureTime),
          cancelled: Boolean(c.cancellation),
          occupancy: c.occupancyStatus || null,
        };
      });
  }

  // Hvor er toget nå? Bruker faktiske tider når de finnes, ellers forventede.
  function locate(stops, now = Date.now()) {
    const live = stops.filter((s) => !s.cancelled);
    if (!live.length) return { kind: "cancelled" };
    const departed = (s) => s.hasDeparted || (s.dep && s.dep <= now);
    const arrived = (s) => s.hasArrived || (s.arr && s.arr <= now);
    const last = live[live.length - 1];
    if (arrived(last) && last !== live[0]) return { kind: "done", at: last };

    let i = -1;
    live.forEach((s, k) => { if (k < live.length - 1 && departed(s)) i = k; });
    if (i === -1) {
      return arrived(live[0]) ? { kind: "at", at: live[0] } : { kind: "notStarted", at: live[0] };
    }
    const prev = live[i];
    const next = live[i + 1];
    if (arrived(next)) return { kind: "at", at: next };
    const span = (next.arr || next.dep) - prev.dep;
    const frac = span > 0 ? Math.min(1, Math.max(0, (now - prev.dep) / span)) : 0.5;
    return { kind: "between", prev, next, frac };
  }

  function positionText(loc) {
    switch (loc.kind) {
      case "cancelled": return ["Toget er innstilt.", "Det er ikke noe sted. Sporløst, rett og slett."];
      case "done": return [`Har kommet fram til ${loc.at.name}.`, "Reisen er over. Toget hviler."];
      case "notStarted": return [`Har ikke startet ennå.`, `Står trolig på ${loc.at.name} og samler mot, avgang ${t(loc.at.dep)}.`];
      case "at": return [`Står på ${loc.at.name}.`, loc.at.dep ? `Kjører videre ${t(loc.at.dep)}.` : ""];
      default: {
        const left = Math.max(0, Math.round(((loc.next.arr || loc.next.dep) - Date.now()) / 60000));
        return [`Mellom ${loc.prev.name} og ${loc.next.name}.`, left ? `Ankommer ${loc.next.name} om ca. ${left} min.` : `Ruller inn på ${loc.next.name} nå.`];
      }
    }
  }

  const OCCUPANCY = {
    empty: [1, "Nesten tomt", "Velg fritt blant setene."],
    manySeatsAvailable: [2, "God plass", "Sitteplass er så godt som sikret."],
    fewSeatsAvailable: [3, "Få ledige seter", "Albuene kan trenge å jobbe litt."],
    standingRoomOnly: [4, "Bare ståplass", "Hold deg fast og tenk på noe fint."],
    crushedStandingRoomOnly: [5, "Sardinboks", "Du blir kjent med nye mennesker."],
    full: [5, "Fullt", "Vurder neste tog, eller en sykkel."],
    notAcceptingPassengers: [5, "Tar ikke på flere", "Toget har sagt nei."],
  };

  function occupancyInfo(code) {
    const o = OCCUPANCY[code];
    if (o) return { level: o[0], title: o[1], note: o[2] };
    return { level: 0, title: "Ukjent", note: "Ingen data om kapasitet for denne avgangen. Ta sjansen." };
  }

  function bars(level) {
    const wrap = el("span", `bars l${level}`);
    wrap.setAttribute("aria-hidden", "true");
    for (let k = 1; k <= 5; k++) wrap.append(el("i", k <= level ? "on" : null));
    return wrap;
  }

  // ---------- Ventepils: nærmeste vannhull når toget er innstilt ----------

  const PUB_RADIUS_M = 1500;
  const PUB_KINDS = { pub: "Pub", bar: "Bar", biergarten: "Ølhage" };
  const pubCache = new Map(); // stasjons-id -> Promise<pub[]>

  function pubSearchUrl(o) {
    return `https://www.google.com/maps/search/pub/@${o.lat},${o.lon},16z`;
  }

  function walkUrl(o, p) {
    const q = new URLSearchParams({
      api: "1",
      origin: `${o.lat},${o.lon}`,
      destination: `${p.lat},${p.lon}`,
      travelmode: "walking",
    });
    return `https://www.google.com/maps/dir/?${q}`;
  }

  function distanceM(a, b) {
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }

  // Slår opp puber og barer rundt stasjonen i OpenStreetMap (Overpass). Ingen nøkkel, ingen backend.
  function fetchPubs(o) {
    if (pubCache.has(o.id)) return pubCache.get(o.id);
    const q = `[out:json][timeout:15];nwr["amenity"~"^(pub|bar|biergarten)$"]["name"](around:${PUB_RADIUS_M},${o.lat},${o.lon});out center tags 60;`;
    const job = fetch(CFG.overpassUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(q)}`,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Overpass ${res.status}`);
        return res.json();
      })
      .then((json) =>
        (json.elements || [])
          .map((e) => {
            const lat = e.lat ?? e.center?.lat;
            const lon = e.lon ?? e.center?.lon;
            if (lat == null || lon == null) return null;
            const p = { name: e.tags.name, kind: PUB_KINDS[e.tags.amenity] || "Bar", lat, lon };
            p.dist = distanceM(o, p);
            return p;
          })
          .filter(Boolean)
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 3)
      );
    job.catch(() => pubCache.delete(o.id)); // prøv igjen neste gang
    pubCache.set(o.id, job);
    return job;
  }

  function loadPubs(cur) {
    const o = cur.origin;
    if (!o || cur.pubs !== undefined) return;
    cur.pubs = null; // laster
    fetchPubs(o)
      .then((pubs) => { cur.pubs = pubs; })
      .catch((err) => { console.error(err); cur.pubs = { error: err.message }; })
      .finally(() => { if (state.detail === cur) renderDetail(); });
  }

  const PUB_QUIPS = [
    "Toget kommer ikke. Det gjør derimot en halvliter.",
    "Bane NOR har gitt deg fri. Bruk den klokt.",
    "Innstilt tog, innstilt humør? Ikke nødvendigvis.",
    "Neste tog er usikkert. Skummet er sikkert.",
  ];

  function pubCard(cur) {
    const o = cur.origin;
    const card = el("section", "card pils");
    card.append(el("h3", null, "Ventepils"));
    // Fast spøk per avgang, så teksten ikke hopper ved hver oppdatering.
    const seed = [...(cur.dep.journeyId || cur.dep.line || "x")].reduce((n, ch) => n + ch.charCodeAt(0), 0);
    const quip = PUB_QUIPS[seed % PUB_QUIPS.length];
    card.append(el("p", "big", quip));

    const fallback = el("a", "pils-more", "Se alle i kartet");
    fallback.href = pubSearchUrl(o);
    fallback.target = "_blank";
    fallback.rel = "noopener";

    const pubs = cur.pubs;
    if (pubs === null || pubs === undefined) {
      card.append(el("p", "note", `Leter etter nærmeste vannhull ved ${o.name}…`));
    } else if (pubs.error || !pubs.length) {
      card.append(el("p", "note", pubs.error
        ? "Fant ikke kartet akkurat nå. Følg nesa, eller kartet:"
        : `Ingen puber innen ${PUB_RADIUS_M / 1000} km fra ${o.name}. Tørrlagt område. Prøv kartet:`));
      card.append(fallback);
    } else {
      const ol = el("ol", "pubs");
      for (const p of pubs) {
        const li = el("li");
        const a = el("a", null);
        a.href = walkUrl(o, p);
        a.target = "_blank";
        a.rel = "noopener";
        const mins = Math.max(1, Math.round(p.dist / 80));
        a.append(el("strong", null, p.name), el("span", "pub-meta", `${p.kind} · ${Math.round(p.dist / 10) * 10} m · ca. ${mins} min å gå`));
        li.append(a);
        ol.append(li);
      }
      card.append(ol, fallback);
    }
    card.append(el("p", "fine", "Fra OpenStreetMap. Drikk ansvarlig, og husk at toget en dag kommer tilbake."));
    return card;
  }

  function openDetail(dep) {
    const dlg = $("detail");
    state.detail = { dep, stops: null, error: null, origin: dep.cancelled ? state.origin : null, pubs: undefined };
    renderDetail();
    if (!dlg.open) dlg.showModal();
    loadDetail();
  }

  async function loadDetail() {
    const cur = state.detail;
    if (!cur) return;
    try {
      const stops = await fetchJourney(cur.dep.journeyId);
      if (state.detail !== cur) return;
      cur.stops = stops;
      cur.error = null;
    } catch (err) {
      console.error(err);
      if (state.detail !== cur) return;
      cur.error = err.message;
    }
    renderDetail();
  }

  function renderDetail() {
    const cur = state.detail;
    if (!cur) return;
    const d = cur.dep;
    const body = $("detail-body");
    body.replaceChildren();

    $("detail-title").replaceChildren(
      ...(d.line ? [el("span", "line", d.line)] : []),
      el("span", null, ` ${d.destination}`)
    );
    const sub = [`Avgang ${t(d.expected)}`];
    if (d.track) sub.push(`spor ${d.track}`);
    if (d.status === "late") sub.push(`${d.delayMin} min forsinket`);
    if (d.cancelled) sub.push("innstilt");
    $("detail-sub").textContent = sub.join(" · ");

    if (d.cancelled && cur.origin) {
      loadPubs(cur);
      body.append(pubCard(cur));
    }

    // Avviksmeldinger for akkurat denne avgangen
    if (d.situations.length) {
      const sitCard = el("section", "card sits");
      sitCard.append(el("h3", null, "Driftsmeldinger"));
      const ul = el("ul", "alerts-list");
      d.situations.forEach((s) => ul.append(situationItem(s)));
      sitCard.append(ul);
      body.append(sitCard);
    }

    if (cur.error && !cur.stops) {
      body.append(el("p", "detail-msg error", `Klarte ikke å hente ruten (${cur.error}). Toget er kanskje ekstra sporløst i dag.`));
      return;
    }
    if (!cur.stops) {
      body.append(el("div", "skeleton"), el("div", "skeleton"));
      return;
    }

    const stops = cur.stops;
    const loc = locate(stops);

    // Posisjon
    const [posTitle, posNote] = positionText(loc);
    const posCard = el("section", "card pos");
    posCard.append(el("h3", null, "Hvor er toget nå?"), el("p", "big", posTitle));
    if (posNote) posCard.append(el("p", "note", posNote));
    posCard.append(el("p", "fine", "Beregnet fra sanntidstider i ruten, ikke GPS."));
    body.append(posCard);

    // Kapasitet når du går på
    const board = stops.find((s) => s.pos === d.fromPos);
    const occ = occupancyInfo(board?.occupancy);
    const capCard = el("section", `card cap l${occ.level}`);
    const capRow = el("div", "cap-row");
    capRow.append(bars(occ.level), el("p", "big", occ.title));
    capCard.append(el("h3", null, `Kapasitet fra ${board?.name || "din stasjon"}`), capRow, el("p", "note", occ.note));
    body.append(capCard);

    // Rute
    const routeCard = el("section", "card route");
    routeCard.append(el("h3", null, "Rute"));
    const ol = el("ol", "stops");
    const at = loc.kind === "at" || loc.kind === "notStarted" || loc.kind === "done" ? loc.at : null;
    stops.forEach((s) => {
      const cls = ["stop"];
      const inTrip = s.pos >= d.fromPos && s.pos <= d.toPos;
      if (!inTrip) cls.push("outside");
      if (s.pos === d.fromPos) cls.push("board");
      if (s.pos === d.toPos) cls.push("alight");
      if (s.cancelled) cls.push("cancelled");
      const passed = s.hasDeparted || (s.dep && s.dep <= Date.now()) || (s === stops[stops.length - 1] && s.arr && s.arr <= Date.now());
      if (passed && s !== at) cls.push("passed");
      if (s === at) cls.push("here");
      const li = el("li", cls.join(" "));

      const time = el("span", "st-time");
      const planned = s.aimedDep || s.aimedArr;
      const actual = s.dep || s.arr;
      const late = planned && actual && Math.round((actual - planned) / 60000) >= CFG.lateThresholdMinutes;
      if (late) time.append(el("s", null, t(planned)), el("b", null, t(actual)));
      else time.append(t(planned || actual));

      const name = el("span", "st-name", s.name);
      if (s.pos === d.fromPos) name.append(el("em", null, "du går på"));
      if (s.pos === d.toPos) name.append(el("em", null, "du går av"));
      if (s.cancelled) name.append(el("em", "bad", "stopper ikke"));

      li.append(el("span", "st-dot"), time, name);
      if (s === at) li.append(el("span", "train", "🚆"));
      ol.append(li);

      if (loc.kind === "between" && s === loc.prev) {
        const mid = el("li", "stop moving");
        mid.style.setProperty("--frac", loc.frac.toFixed(2));
        mid.append(el("span", "st-dot"), el("span", "st-time"), el("span", "st-name", "på vei"), el("span", "train", "🚆"));
        ol.append(mid);
      }
    });
    routeCard.append(ol);
    body.append(routeCard);
  }

  function closeDetail() {
    state.detail = null;
    const dlg = $("detail");
    if (dlg.open) dlg.close();
  }

  // ---------- Strekning og lagrede strekninger ----------

  function renderRoute() {
    const r = state.route;
    $("from-name").textContent = r.from.name;
    $("to-name").textContent = r.to.name;
    document.title = `${r.from.name} → ${r.to.name} · Forsinkometer`;

    const isSaved = state.saved.some((s) => samePair(s, r));
    const star = $("star");
    star.setAttribute("aria-pressed", String(isSaved));
    star.querySelector("span").textContent = isSaved ? "Lagret" : "Lagre";
    star.title = isSaved ? "Fjern fra mine strekninger" : "Lagre strekningen i denne nettleseren";

    const list = $("saved");
    list.replaceChildren();
    state.saved.forEach((s) => {
      const active = samePair(s, r);
      const li = el("li");
      const b = el("button", active ? "chip active" : "chip");
      b.append(el("span", null, s.from.name), el("span", "arrow", "⇄"), el("span", null, s.to.name));
      b.setAttribute("aria-pressed", String(active));
      b.title = active ? "Snu retning" : `Vis ${s.from.name} – ${s.to.name}`;
      b.addEventListener("click", () => setRoute(active ? reverse(r) : s));
      li.append(b);
      list.append(li);
    });
    list.hidden = !state.saved.length;
  }

  function toggleSaved() {
    const r = state.route;
    const i = state.saved.findIndex((s) => samePair(s, r));
    if (i >= 0) state.saved.splice(i, 1);
    else state.saved = [{ from: station(r.from), to: station(r.to) }, ...state.saved].slice(0, CFG.maxSavedRoutes);
    store(KEYS.saved, state.saved);
    renderRoute();
  }

  function rememberRecent(st) {
    const recent = load(KEYS.recent, []).filter((s) => isStation(s) && s.id !== st.id);
    store(KEYS.recent, [station(st), ...recent].slice(0, 6));
  }

  function setRoute(route) {
    state.route = { from: station(route.from), to: station(route.to) };
    store(KEYS.route, state.route);
    const url = new URL(location.href);
    url.searchParams.delete("retning");
    url.searchParams.set("fra", state.route.from.name);
    url.searchParams.set("til", state.route.to.name);
    history.replaceState(null, "", url);
    renderRoute();
    $("departures").replaceChildren(...Array.from({ length: 4 }, () => el("li", "skeleton")));
    $("next").hidden = true;
    $("alerts").hidden = true;
    $("signal-tally").hidden = true;
    setStatus("Henter avganger …");
    refresh();
  }

  // ---------- Stasjonsvelger ----------

  let searchTimer = null;
  let searchSeq = 0;

  function openPicker(which) {
    state.picking = which;
    $("picker-title").textContent = which === "from" ? "Hvor reiser du fra?" : "Hvor skal du?";
    const input = $("picker-input");
    input.value = "";
    showQuickPicks();
    const dlg = $("picker");
    if (!dlg.open) dlg.showModal();
    input.focus();
  }

  function closePicker() {
    const dlg = $("picker");
    if (dlg.open) dlg.close();
  }

  function stationList(stations, hint) {
    $("picker-hint").textContent = hint;
    const list = $("picker-list");
    list.replaceChildren();
    stations.forEach((s) => {
      const li = el("li");
      const b = el("button", "pick");
      b.append(el("span", "pick-name", s.name));
      if (s.place && norm(s.place) !== norm(s.name)) b.append(el("span", "pick-place", s.place));
      b.addEventListener("click", () => choose(s));
      li.append(b);
      list.append(li);
    });
  }

  function showQuickPicks() {
    const seen = new Set();
    const fromSaved = state.saved.flatMap((r) => [r.from, r.to]);
    const quick = [...load(KEYS.recent, []), ...fromSaved, state.route.from, state.route.to]
      .filter((s) => isStation(s) && !seen.has(s.id) && seen.add(s.id));
    stationList(quick, quick.length ? "Nylig brukt og lagret" : "Skriv for å søke");
  }

  function onSearch() {
    const text = $("picker-input").value.trim();
    clearTimeout(searchTimer);
    if (text.length < 2) { showQuickPicks(); return; }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      $("picker-hint").textContent = "Leter i sporene …";
      try {
        const hits = await searchStations(text);
        if (seq !== searchSeq) return;
        stationList(hits, hits.length ? "" : `Ingen togstasjon heter «${text}». Ennå.`);
      } catch (err) {
        if (seq !== searchSeq) return;
        stationList([], `Søket feilet (${err.message}). Prøv igjen.`);
      }
    }, 250);
  }

  function choose(st) {
    const r = state.route;
    const pick = station(st);
    rememberRecent(pick);
    closePicker();
    let next;
    if (state.picking === "from") next = pick.id === r.to.id ? reverse(r) : { from: pick, to: r.to };
    else next = pick.id === r.from.id ? reverse(r) : { from: r.from, to: pick };
    if (!sameRoute(next, r)) setRoute(next);
  }

  // ---------- Flyt ----------

  // Demomodus: ?demo=innstilt later som at et par av de neste avgangene er innstilt,
  // så man kan se hvordan det ser ut (og finne ventepilsen) uten å vente på Bane NOR.
  const DEMO = new URLSearchParams(location.search).get("demo") === "innstilt";

  function fakeCancellations(deps) {
    const upcoming = deps.filter((d) => !d.departed && !d.cancelled);
    [upcoming[0], upcoming[2]].filter(Boolean).forEach((d) => {
      d.cancelled = true;
      d.partlyCancelled = false;
      d.status = "cancelled";
    });
  }

  async function refresh() {
    const { from, to } = state.route;
    try {
      const { deps, situations, origin } = await fetchDepartures(from.id, to.id);
      if (state.route.from.id !== from.id || state.route.to.id !== to.id) return;
      state.origin = origin;
      if (DEMO) fakeCancellations(deps);
      render(deps, situations, logSignals(state.route, situations));
      setStatus(`Oppdatert ${t(new Date())}${DEMO ? " · Demo: innstillingene er oppdiktet" : ""}`);
      if (state.detail) loadDetail();
    } catch (err) {
      console.error(err);
      setStatus(`Klarte ikke å hente avganger (${err.message}). Prøver igjen snart.`, true);
    }
  }

  async function init() {
    $("pick-from").addEventListener("click", () => openPicker("from"));
    $("pick-to").addEventListener("click", () => openPicker("to"));
    $("swap").addEventListener("click", () => setRoute(reverse(state.route)));
    $("star").addEventListener("click", toggleSaved);

    const picker = $("picker");
    $("picker-close").addEventListener("click", closePicker);
    picker.addEventListener("click", (e) => { if (e.target === picker) closePicker(); });
    $("picker-input").addEventListener("input", onSearch);
    $("picker-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); $("picker-list").querySelector("button")?.click(); }
    });

    const dlg = $("detail");
    $("detail-close").addEventListener("click", closeDetail);
    dlg.addEventListener("close", () => { state.detail = null; });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) closeDetail(); });

    const saved = load(KEYS.saved, null);
    try {
      if (Array.isArray(saved)) state.saved = saved.filter(isRoute);
      else state.saved = [await defaultRoute()]; // første besøk: Ski – Oslo S ligger klar
      state.route = await initialRoute();
    } catch (err) {
      setStatus(`Fant ikke stasjonene: ${err.message}`, true);
      try { state.route = await defaultRoute(); } catch { return; }
    }
    if (!Array.isArray(saved)) store(KEYS.saved, state.saved);
    setRoute(state.route);
    state.timer = setInterval(refresh, CFG.refreshSeconds * 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
  }

  init();
})();
