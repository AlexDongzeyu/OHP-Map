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
        "birth_year": rec.get("birth_year"),
        "bio_excerpt": rec.get("bio_excerpt", ""),
        "archive_url": rec.get("archive_url", ""),
        "media_url": rec.get("media_url"),
        "portrait": rec.get("portrait"),
        "portrait_rights": rec.get("portrait_rights"),
        "theme_tags": rec.get("theme_tags", []),
        "waypoints": waypoints,
    }


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


def build(source_name="local", extractor_name="offline", allow_network=False) -> dict:
    warnings: list[str] = []
    source = ingest.get_source(source_name)
    extractor = extract.get_extractor(extractor_name)
    cache = geocode.load_cache()

    survivors = [_record_to_survivor(rec, extractor) for rec in source.fetch()]

    # Human-review gate: queue everything unverified, publish only verified.
    queued = review.emit_review_queue(survivors)
    survivors = review.filter_published(survivors)

    # Geocode (cache-only unless --allow-network), then drop any waypoint we can't place.
    survivors = [_geocode_survivor(s, cache, allow_network, warnings) for s in survivors]
    survivors = [s for s in survivors if s["waypoints"]]
    if allow_network:
        geocode.save_cache(cache)

    features = [_to_feature(s) for s in survivors]
    doc = {
        "type": "FeatureCollection",
        "metadata": {
            "generator": "pipeline/build.py",
            "source": source_name,
            "extractor": extractor_name,
            "count": len(features),
            "time_min": config.TIME_MIN,
            "time_max": config.TIME_MAX,
            "sample_data": any(f["properties"].get("is_sample") for f in features),
            "notice": "Records flagged is_sample are FICTIONAL illustrative data, not real testimony.",
        },
        "features": features,
    }

    validate.assert_valid(doc)  # raises on any invalid record — bad data can't deploy

    place_index = derive.build_place_index(features)
    connections = derive.build_connections(features)

    _write(config.OUT_GEOJSON, doc)
    _write(config.OUT_PLACE_INDEX, place_index)
    _write(config.OUT_CONNECTIONS, connections)

    print(f"[build] source={source_name} extractor={extractor_name}")
    print(f"[build] survivors published: {len(features)} | review queue: {queued}")
    print(f"[build] places indexed: {len(place_index)} | connections: {len(connections)}")
    for w in warnings:
        print(f"[warn] {w}")
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
    p.add_argument("--source", default="local", help="local | wordpress | scrape")
    p.add_argument("--extractor", default="offline", help="offline | anthropic | openai")
    p.add_argument("--allow-network", action="store_true",
                   help="permit live geocoding for cache misses (writes back to cache)")
    p.add_argument("--discover", action="store_true", help="probe the WP REST API and exit")
    args = p.parse_args(argv)

    if args.discover:
        return _discover()
    try:
        build(args.source, args.extractor, args.allow_network)
    except ValueError as exc:  # validation failure
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
