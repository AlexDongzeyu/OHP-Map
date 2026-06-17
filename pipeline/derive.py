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

from . import dates


def order_waypoints(waypoints: list[dict]) -> list[dict]:
    """Chronological, stable sort. Missing dates sort last but keep relative order."""
    INF = 10**9

    def key(item):
        idx, wp = item
        start, _ = dates.year_span(wp.get("date"))
        return (start if start is not None else INF, idx)

    return [wp for _, wp in sorted(enumerate(waypoints), key=key)]


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
    """Verified place+time overlaps between pairs of survivors (deduped, one per pair).

    For each place we merge each survivor's (possibly several) verified waypoints into
    a single date span, then emit one connection per overlapping survivor pair.
    """
    # canonical place -> survivor_id -> [date objects]
    by_place: dict[str, dict[str, list[dict]]] = {}
    for feat in features:
        props = feat["properties"]
        sid = props["survivor_id"]
        for wp in props["waypoints"]:
            if not wp.get("verified") or wp.get("role") not in CONNECTION_ROLES:
                continue
            by_place.setdefault(wp["canonical"], {}).setdefault(sid, []).append(wp.get("date"))

    connections = []
    for place, per_survivor in by_place.items():
        spans = {sid: _merged_span(ds) for sid, ds in per_survivor.items()}
        spans = {sid: span for sid, span in spans.items() if span}
        for sid_a, sid_b in combinations(sorted(spans), 2):
            win = dates.overlap(spans[sid_a], spans[sid_b])
            if not win:
                continue
            lo, hi = win
            window = str(lo) if lo == hi else f"{lo}-{hi}"
            connections.append({
                "place": place,
                "survivorA": sid_a,
                "survivorB": sid_b,
                "overlap_window": window,
                "note": f"Both describe being at {place} around {window}.",
                "verified": True,
            })
    connections.sort(key=lambda c: (c["place"], c["survivorA"], c["survivorB"]))
    return connections
