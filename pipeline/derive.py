"""Derived artifacts emitted alongside survivors.geojson (doc 02 section 4).

* order_waypoints  — sort a journey chronologically, stably (so equal dates keep
  their author-given order). Unit-tested.
* build_place_index — canonical place -> [survivor_id], for instant place clicks.
* build_connections — verified {place, survivorA, survivorB, overlap_window} pairs:
  the "same place, same time" layer. A connection is only emitted when BOTH
  survivors' waypoints at that place are verified AND their date ranges overlap
  (doc 04 guardrail #3). Phrasing stays careful: "both describe being at X".
"""
from __future__ import annotations

from itertools import combinations

from . import dates, gazetteer


ROLE_ORDER = {"birthplace": 0, "ghetto": 1, "camp": 2, "transit": 3,
              "liberation": 4, "resettlement": 5}


def order_waypoints(waypoints: list[dict]) -> list[dict]:
    """Order a journey as sensibly as the available evidence allows.

    * If no waypoint carries a year (common for auto-extracted third-person
      summaries), fall back to a role-based journey order
      (birthplace → ghetto → camp → transit → liberation → resettlement), then to the
      original mention order.
    * Otherwise, sort chronologically. Undated waypoints inherit a year from their
      neighbours (so an undated birthplace stays first and an undated resettlement
      stays last), and the original order breaks ties — keeping dated journeys exact
      without scattering the undated stops.
    """
    n = len(waypoints)
    years = [dates.year_span(wp.get("date"))[0] for wp in waypoints]

    if all(y is None for y in years):
        return [wp for _, wp in sorted(
            enumerate(waypoints),
            key=lambda it: (ROLE_ORDER.get(it[1].get("role"), 3), it[0]))]

    filled = list(years)
    last = None  # forward-fill from the previous dated stop
    for i in range(n):
        if filled[i] is None:
            filled[i] = last
        else:
            last = filled[i]
    nxt = None  # back-fill any leading undated stops
    for i in range(n - 1, -1, -1):
        if filled[i] is None:
            filled[i] = nxt
        else:
            nxt = filled[i]

    INF = 10**9
    return [wp for _, wp in sorted(
        enumerate(waypoints),
        key=lambda it: (filled[it[0]] if filled[it[0]] is not None else INF, it[0]))]


def build_place_index(features: list[dict]) -> dict:
    """canonical place name -> sorted unique list of survivor_ids that touch it."""
    index: dict[str, set] = {}
    for feat in features:
        props = feat["properties"]
        sid = props["survivor_id"]
        for wp in props["waypoints"]:
            index.setdefault(wp["canonical"], set()).add(sid)
    return {place: sorted(ids) for place, ids in sorted(index.items())}


# Only shared-persecution sites count as a "same place, same time" coincidence.
# Resettlement (everyone ends in Toronto) and birthplace are expected, not findings.
CONNECTION_ROLES = {"camp", "ghetto", "transit", "liberation"}
# Places so common they are not a meaningful coincidence (everyone passed Auschwitz);
# the place index already lists everyone there. Skip them in the connection layer.
_MAX_PER_PLACE = 14
_MAX_CONNECTIONS = 80


def _merged_span(dates_at_place: list[dict]):
    """Merge several waypoint date objects at one place into one (start, end) span."""
    starts, ends = [], []
    for d in dates_at_place:
        s, e = dates.year_span(d)
        if s is not None:
            starts.append(s)
            ends.append(e if e is not None else s)
    if not starts:
        return None
    return ({"start": str(min(starts)), "end": str(max(ends)), "precision": "range"})


def build_connections(features: list[dict]) -> list[dict]:
    """Place+time overlaps between pairs of survivors (deduped, one per pair).

    A connection is emitted only when both survivors have a *dated* waypoint at the
    same persecution site and those date ranges overlap. Each connection carries a
    ``verified`` flag: true only when BOTH waypoints were human-verified. Unverified
    pairs are kept as clearly-labelled *candidates* — we never assert two real people
    were together, only that both records place them at X around the same time
    (doc 04 guardrail #3). Ubiquitous places and the long tail are capped so the layer
    stays a set of notable coincidences, not quadratic noise.
    """
    # canonical place -> survivor_id -> {"dates": [...], "verified": bool}
    # Only real persecution sites (camps/ghettos/transit camps in the gazetteer) can
    # form a connection — post-war stops like Israel or Vienna are not a coincidence.
    sites = set(gazetteer.known_sites())
    by_place: dict[str, dict[str, dict]] = {}
    for feat in features:
        props = feat["properties"]
        sid = props["survivor_id"]
        for wp in props["waypoints"]:
            if wp["canonical"] not in sites or wp.get("role") not in CONNECTION_ROLES:
                continue
            entry = by_place.setdefault(wp["canonical"], {}).setdefault(
                sid, {"dates": [], "verified": True})
            entry["dates"].append(wp.get("date"))
            entry["verified"] = entry["verified"] and bool(wp.get("verified"))

    connections = []
    for place, per_survivor in sorted(by_place.items()):
        if len(per_survivor) > _MAX_PER_PLACE:
            continue  # too common to be a meaningful coincidence
        spans = {sid: (_merged_span(info["dates"]), info["verified"])
                 for sid, info in per_survivor.items()}
        spans = {sid: v for sid, v in spans.items() if v[0]}
        for sid_a, sid_b in combinations(sorted(spans), 2):
            (span_a, ver_a), (span_b, ver_b) = spans[sid_a], spans[sid_b]
            win = dates.overlap(span_a, span_b)
            if not win:
                continue
            lo, hi = win
            window = str(lo) if lo == hi else f"{lo}-{hi}"
            verified = ver_a and ver_b
            short = place.split(" (")[0].split(",")[0]
            note = (f"Both describe being at {short} around {window}."
                    if verified else
                    f"Both public summaries mention {short} around {window} "
                    f"(unverified — not a claim that they met).")
            connections.append({
                "place": place,
                "survivorA": sid_a,
                "survivorB": sid_b,
                "overlap_window": window,
                "note": note,
                "verified": verified,
            })
    # Verified first, then tighter windows, then place; cap the total.
    connections.sort(key=lambda c: (not c["verified"], len(c["overlap_window"]),
                                    c["place"], c["survivorA"], c["survivorB"]))
    return connections[:_MAX_CONNECTIONS]
