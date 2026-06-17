"""Build orchestrator (doc 02 architecture, doc 04 phases).

    ingest -> extract -> normalize -> review gate -> geocode -> validate -> emit

Run it:
    python -m pipeline.build                      # offline sample build (default)
    python -m pipeline.build --source wordpress --extractor anthropic --allow-network
    python -m pipeline.build --discover           # just probe the WP REST API

The browser only ever loads the emitted JSON; nothing here runs at page load.
"""
from __future__ import annotations

import argparse
import json
import sys

from . import config, derive, extract, gazetteer, geocode, ingest, review, validate


def _normalize_waypoint(wp: dict) -> dict:
    """Fill canonical name + force-match known-site role. Keeps as_written intact."""
    wp = dict(wp)
    canonical = gazetteer.normalize(wp.get("as_written", ""))
    wp["canonical"] = canonical or wp.get("as_written", "")
    wp["resolved"] = canonical is not None
    return wp


def _record_to_survivor(rec: dict, extractor) -> dict:
    """Produce a survivor dict with normalized, ordered waypoints (pre-geocode)."""
    if rec.get("waypoints"):
        waypoints = [_normalize_waypoint(wp) for wp in rec["waypoints"]]
    else:  # raw testimony text -> run the extractor
        waypoints = [_normalize_waypoint(wp) for wp in extractor.extract(rec.get("text", ""))]
    waypoints = derive.order_waypoints(waypoints)
    return {
        "survivor_id": rec["survivor_id"],
        "name": rec.get("name", ""),
        "is_sample": rec.get("is_sample", False),
        "featured": rec.get("featured", False),
        "group": rec.get("group", "Holocaust Survivors"),
        "conflicts": rec.get("conflicts", []),
        "birth_year": rec.get("birth_year"),
        "bio_excerpt": rec.get("bio_excerpt", "") or _auto_excerpt(rec),
        "archive_url": rec.get("archive_url", ""),
        "media_url": rec.get("media_url"),
        "portrait": rec.get("portrait"),
        "portrait_rights": rec.get("portrait_rights"),
        "theme_tags": rec.get("theme_tags", []),
        "waypoints": waypoints,
    }


def _auto_excerpt(rec: dict, limit: int = 320) -> str:
    """First sentence(s) of the scraped bio, for records without a curated excerpt."""
    text = (rec.get("text") or "").strip()
    if not text:
        return ""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    dot = cut.rfind(". ")
    return (cut[: dot + 1] if dot > 80 else cut).strip() + " …"


def _geocode_survivor(s: dict, cache: dict, allow_network: bool, warnings: list) -> dict:
    placed = []
    for wp in s["waypoints"]:
        coords = geocode.geocode(wp["canonical"], cache, allow_network=allow_network)
        if not coords:
            warnings.append(f"{s['survivor_id']}: no coordinates for "
                            f"{wp['canonical']!r} (as written {wp['as_written']!r}) — dropped")
            continue
        wp = dict(wp)
        wp["lat"] = round(coords["lat"], 6)
        wp["lng"] = round(coords["lng"], 6)
        wp.pop("resolved", None)
        placed.append(wp)
    s = dict(s)
    s["waypoints"] = placed
    return s


def _to_feature(s: dict) -> dict:
    """Point geometry at the hometown (birthplace, else first waypoint)."""
    home = next((wp for wp in s["waypoints"] if wp["role"] == "birthplace"), s["waypoints"][0])
    props = {k: v for k, v in s.items()}
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [home["lng"], home["lat"]]},
        "properties": props,
    }


def build(source_name="local", extractor_name="offline", allow_network=False,
          strict=False, featured=None) -> dict:
    warnings: list[str] = []
    source = ingest.get_source(source_name)
    extractor = extract.get_extractor(extractor_name)
    cache = geocode.load_cache()
    featured = set(featured or [])

    survivors = [_record_to_survivor(rec, extractor) for rec in source.fetch()]

    # Human-review gate: queue everything unverified for a person to confirm.
    queued = review.emit_review_queue(survivors)

    # Geocode (cache-only unless --allow-network), dropping any waypoint we can't place.
    survivors = [_geocode_survivor(s, cache, allow_network, warnings) for s in survivors]
    survivors = [s for s in survivors if s["waypoints"]]
    if allow_network:
        geocode.save_cache(cache)

    # Tag review status; optionally publish only fully-reviewed records.
    survivors = review.stage(survivors, strict=strict)
    for s in survivors:
        if s["survivor_id"] in featured:
            s["featured"] = True

    features = [_to_feature(s) for s in survivors]
    reviewed = sum(1 for f in features if f["properties"].get("review_status") == "reviewed")
    pending = len(features) - reviewed
    group_counts = {}
    for f in features:
        g = f["properties"].get("group", "Holocaust Survivors")
        group_counts[g] = group_counts.get(g, 0) + 1
    doc = {
        "type": "FeatureCollection",
        "metadata": {
            "generator": "pipeline/build.py",
            "source": source_name,
            "extractor": extractor_name,
            "count": len(features),
            "reviewed": reviewed,
            "pending": pending,
            "groups": group_counts,
            "time_min": config.TIME_MIN,
            "time_max": config.TIME_MAX,
            "sample_data": any(f["properties"].get("is_sample") for f in features),
            "notice": (
                "Pending records are auto-extracted from public archive summaries and "
                "await human verification and permission; they are not authoritative. "
                "Records flagged is_sample are fictional illustrative data."
            ),
        },
        "features": features,
    }

    validate.assert_valid(doc)  # raises on any invalid record — bad data can't deploy

    place_index = derive.build_place_index(features)
    connections = derive.build_connections(features)

    _write(config.OUT_GEOJSON, doc)
    _write(config.OUT_PLACE_INDEX, place_index)
    _write(config.OUT_CONNECTIONS, connections)

    print(f"[build] source={source_name} extractor={extractor_name} strict={strict}")
    print(f"[build] published: {len(features)} ({reviewed} reviewed, {pending} pending) "
          f"| review queue: {queued}")
    for g, n in sorted(group_counts.items(), key=lambda kv: -kv[1]):
        print(f"           {g}: {n}")
    print(f"[build] places indexed: {len(place_index)} | connections: {len(connections)} "
          f"({sum(1 for c in connections if c['verified'])} verified)")
    for w in warnings[:10]:
        print(f"[warn] {w}")
    if len(warnings) > 10:
        print(f"[warn] …and {len(warnings) - 10} more unplaced waypoints")
    return doc


def _write(path, obj) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def _discover() -> int:
    src = ingest.WordPressRestSource()
    try:
        types = src.discover()
    except Exception as exc:  # noqa: BLE001 - report any network/HTTP failure plainly
        print(f"[discover] REST probe failed: {exc}")
        return 1
    print("[discover] post types exposed by the REST API:")
    for key, meta in types.items():
        name = meta.get("name", key) if isinstance(meta, dict) else key
        print(f"  - {key}: {name}")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Build the OHP survivor map dataset.")
    p.add_argument("--source", default="all",
                   help="all (whole archive, default) | ohp | local | scraped | wordpress | scrape")
    p.add_argument("--extractor", default="offline", help="offline | anthropic | openai")
    p.add_argument("--allow-network", action="store_true",
                   help="permit live geocoding for cache misses (writes back to cache)")
    p.add_argument("--strict", action="store_true",
                   help="publish only human-reviewed records (drop pending)")
    p.add_argument("--featured", default="",
                   help="comma-separated survivor_ids to flag as featured")
    p.add_argument("--discover", action="store_true", help="probe the WP REST API and exit")
    args = p.parse_args(argv)

    if args.discover:
        return _discover()
    featured = [s for s in args.featured.split(",") if s]
    try:
        build(args.source, args.extractor, args.allow_network,
              strict=args.strict, featured=featured)
    except ValueError as exc:  # validation failure
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
