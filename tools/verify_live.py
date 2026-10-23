#!/usr/bin/env python3
"""Sporløs – sjekker v1-logikken mot live Entur-API.

Kjør:  python3 tools/verify_live.py
Bruker kun standardbiblioteket. Speiler spørringen og filtreringen i app.js
og skriver ut hva appen ville vist i begge retninger, pluss diagnostikk.
"""
import json
import sys
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime

CLIENT = "sgaukerud-sporlos"
JP = "https://api.entur.io/journey-planner/v3/graphql"
GEO = "https://api.entur.io/geocoder/v1/autocomplete"
HEADERS = {"ET-Client-Name": CLIENT}

QUERY = """
query Departures($id: String!, $n: Int!, $range: Int!) {
  stopPlace(id: $id) {
    id name
    estimatedCalls(numberOfDepartures: $n, timeRange: $range, arrivalDeparture: departures,
                   includeCancelledTrips: true, whiteListedModes: [rail]) {
      aimedDepartureTime expectedDepartureTime cancellation stopPositionInPattern date
      quay { publicCode }
      destinationDisplay { frontText }
      serviceJourney {
        id
        line { publicCode }
        estimatedCalls { stopPositionInPattern aimedArrivalTime cancellation quay { stopPlace { id parent { id } } } }
      }
    }
  }
}"""


def get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def post(query, variables):
    body = json.dumps({"query": query, "variables": variables}).encode()
    req = urllib.request.Request(JP, data=body, headers={**HEADERS, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def geocode(text):
    url = f"{GEO}?text={urllib.parse.quote(text)}&layers=venue&size=10"
    feats = get(url).get("features", [])
    print(f"\nGeocoder «{text}»:")
    for f in feats:
        p = f["properties"]
        print(f"  {p['id']:<22} {p['name']:<30} {p.get('category')}")
    rail = [f for f in feats if "railStation" in (f["properties"].get("category") or [])]
    hit = (rail or feats)[0]["properties"]["id"]
    print(f"  -> appen velger {hit}")
    return hit


def check(name, from_id, to_id, n):
    data = post(QUERY, {"id": from_id, "n": n, "range": 3 * 3600})
    if data.get("errors"):
        print(f"\n{name}: GraphQL-feil: {data['errors']}")
        return
    calls = data["data"]["stopPlace"]["estimatedCalls"]
    kept, empty_sj = [], 0
    for c in calls:
        sj_calls = c["serviceJourney"]["estimatedCalls"] or []
        if not sj_calls:
            empty_sj += 1
        later = next((x for x in sj_calls if to_id in (x["quay"]["stopPlace"]["id"], (x["quay"]["stopPlace"].get("parent") or {}).get("id"))
                      and x["stopPositionInPattern"] > c["stopPositionInPattern"]), None)
        if later:
            kept.append((c, later))
    span = ""
    if calls:
        a, b = calls[0]["aimedDepartureTime"][11:16], calls[-1]["aimedDepartureTime"][11:16]
        span = f"{a}–{b}"
    print(f"\n{name} (n={n}): {len(calls)} avganger hentet ({span}), {len(kept)} går til destinasjonen, "
          f"{empty_sj} med tom serviceJourney.estimatedCalls")
    print("  Linjer beholdt:", dict(Counter(c["serviceJourney"]["line"]["publicCode"] for c, _ in kept)))
    for c, arr in kept[:15]:
        print(f"  {c['aimedDepartureTime'][11:16]} -> {(arr['aimedArrivalTime'] or '')[11:16]}  "
              f"{c['serviceJourney']['line']['publicCode']:<5} spor {c['quay']['publicCode'] or '?':<3} "
              f"{c['destinationDisplay']['frontText']}{'  INNSTILT' if c['cancellation'] else ''}")


SIT_QUERY = """
fragment Sit on PtSituationElement {
  id reportType summary { value language } description { value language } advice { value language }
  validityPeriod { startTime endTime } infoLinks { uri label }
}
query($id: String!, $to: String!) {
  stopPlace(id: $id) {
    situations { ...Sit }
    estimatedCalls(numberOfDepartures: 40, whiteListedModes: [rail]) {
      situations { ...Sit }
      serviceJourney { line { id publicCode situations { ...Sit } } }
    }
  }
  destination: stopPlace(id: $to) { situations { ...Sit } }
}"""


def check_situations(from_id, to_id):
    """Speiler avviksmelding-spørringen i app.js og viser hva som regnes som signalfeil."""
    import re
    data = post(SIT_QUERY, {"id": from_id, "to": to_id})
    if data.get("errors"):
        print(f"\nAvviksmeldinger: GraphQL-feil: {data['errors']}")
        return
    d = data["data"]
    found = {}
    def add(sits, where):
        for s in sits or []:
            found.setdefault(s["id"], (s, set()))[1].add(where)
    add(d["stopPlace"]["situations"], "fra-stasjon")
    add(d["destination"]["situations"], "til-stasjon")
    for c in d["stopPlace"]["estimatedCalls"]:
        line = c["serviceJourney"]["line"]
        add(line["situations"], f"linje {line['publicCode']}")
        add(c["situations"], f"avgang {line['publicCode']}")
    print(f"\nAvviksmeldinger: {len(found)} unike")
    for s, where in found.values():
        text = " ".join(t["value"] for k in ("summary", "description", "advice") for t in (s[k] or [])[:1])
        signal = "SIGNALFEIL " if re.search(r"signal|sikringsanlegg|stillverk", text, re.I) else ""
        vp = s.get("validityPeriod") or {}
        print(f"  {signal}[{s['reportType']}] {(s['summary'] or [{'value': '?'}])[0]['value'][:90]}")
        print(f"     {vp.get('startTime', '')[:16]} – {(vp.get('endTime') or '')[:16]}  ({', '.join(sorted(where))})")


def main():
    print("Kjørt", datetime.now().isoformat(timespec="minutes"))
    ski = geocode("Ski stasjon")
    osl = geocode("Oslo S")
    for n in (40, 150):
        check("Ski -> Oslo S", ski, osl, n)
        check("Oslo S -> Ski", osl, ski, n)
    check_situations(ski, osl)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print("FEIL:", repr(e))
        sys.exit(1)
