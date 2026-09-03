"""Validation: the build's safety net (doc 02 section 7).

Every emitted record is checked against data/schema/survivors.schema.json. If ANY
record is invalid the build raises — bad data can never deploy. We also run a few
semantic checks the JSON Schema can't express (coordinate sanity, role/site match).
"""
from __future__ import annotations

import json
from functools import lru_cache
from math import cos, hypot, radians

from . import config, gazetteer


_COUNTRY_ALIASES = {
    "England": "United Kingdom",
    "Scotland": "United Kingdom",
    "UK": "United Kingdom",
    "USA": "United States of America",
    "United States": "United States of America",
    "Korea": "South Korea",
    "Czechoslovakia": "Czechia",
    "Hong Kong": "China",
    "Ontario": "Canada",
}
_COUNTRY_BOUNDARY_TOLERANCE_KM = 25


def _schema() -> dict:
    with open(config.SCHEMA, encoding="utf-8") as fh:
        return json.load(fh)


@lru_cache(maxsize=1)
def _countries() -> dict:
    path = config.DATA / "atlas-world.json"
    with open(path, encoding="utf-8") as fh:
        world = json.load(fh)
    return {
        feature["properties"]["name"]: feature["geometry"]
        for feature in world["features"]
    }


def _point_in_ring(lng: float, lat: float, ring: list) -> bool:
    inside = False
    previous = len(ring) - 1
    for index, (point_lng, point_lat) in enumerate(ring):
        prior_lng, prior_lat = ring[previous]
        crosses = (point_lat > lat) != (prior_lat > lat)
        if crosses:
            boundary_lng = (
                (prior_lng - point_lng) * (lat - point_lat) /
                (prior_lat - point_lat) + point_lng
            )
            if lng < boundary_lng:
                inside = not inside
        previous = index
    return inside


def _point_in_geometry(lng: float, lat: float, geometry: dict) -> bool:
    polygons = (
        [geometry["coordinates"]]
        if geometry["type"] == "Polygon"
        else geometry["coordinates"]
    )
    for polygon in polygons:
        if _point_in_ring(lng, lat, polygon[0]) and not any(
            _point_in_ring(lng, lat, hole) for hole in polygon[1:]
        ):
            return True
    return False


def _distance_to_ring_km(lng: float, lat: float, ring: list) -> float:
    longitude_scale = 111.32 * cos(radians(lat))
    latitude_scale = 111.32
    nearest = float("inf")
    for start, end in zip(ring, ring[1:]):
        ax = (start[0] - lng) * longitude_scale
        ay = (start[1] - lat) * latitude_scale
        bx = (end[0] - lng) * longitude_scale
        by = (end[1] - lat) * latitude_scale
        dx, dy = bx - ax, by - ay
        denominator = dx * dx + dy * dy
        position = max(0, min(1, -(ax * dx + ay * dy) / denominator)) if denominator else 0
        nearest = min(nearest, hypot(ax + position * dx, ay + position * dy))
    return nearest


def _distance_to_geometry_km(lng: float, lat: float, geometry: dict) -> float:
    polygons = (
        [geometry["coordinates"]]
        if geometry["type"] == "Polygon"
        else geometry["coordinates"]
    )
    return min(_distance_to_ring_km(lng, lat, polygon[0]) for polygon in polygons)


def coordinate_country_error(canonical: str, lat: float, lng: float) -> str | None:
    token = canonical.split(",")[-1].strip() if "," in canonical else canonical
    expected = _COUNTRY_ALIASES.get(token, token)
    geometry = _countries().get(expected)
    if not geometry:
        return None
    if _point_in_geometry(lng, lat, geometry):
        return None
    # The compact Natural Earth geometry is coarse around coastlines and borders.
    if _distance_to_geometry_km(lng, lat, geometry) <= _COUNTRY_BOUNDARY_TOLERANCE_KM:
        return None
    return f"{canonical} resolves to ({lat}, {lng}), outside {expected}"


def validate_geojson(doc: dict) -> list[str]:
    """Return a list of human-readable errors. Empty list == valid."""
    from jsonschema import Draft7Validator

    errors: list[str] = []
    validator = Draft7Validator(_schema())
    for err in sorted(validator.iter_errors(doc), key=lambda e: list(e.path)):
        loc = "/".join(str(p) for p in err.path)
        errors.append(f"schema: {loc}: {err.message}")

    # Semantic checks beyond the schema.
    checked_places = {}
    for feat in doc.get("features", []):
        props = feat.get("properties", {})
        sid = props.get("survivor_id", "?")
        lng, lat = (feat.get("geometry", {}).get("coordinates", [None, None]) + [None, None])[:2]
        if lat is None or not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
            errors.append(f"{sid}: feature coordinates out of range (remember [lng, lat])")
        for wp in props.get("waypoints", []):
            canonical = wp.get("canonical", "")
            wp_lat, wp_lng = wp.get("lat"), wp.get("lng")
            if canonical not in checked_places and isinstance(wp_lat, (int, float)) and isinstance(wp_lng, (int, float)):
                checked_places[canonical] = coordinate_country_error(
                    canonical,
                    wp_lat,
                    wp_lng,
                )
            if checked_places.get(canonical):
                errors.append(f"{sid}: {checked_places[canonical]}")
            expected = gazetteer.known_site_role(wp.get("canonical", ""))
            # A known *camp* mislabelled as e.g. birthplace is the classic LLM error.
            if expected == "camp" and wp.get("role") in ("birthplace", "resettlement"):
                errors.append(
                    f"{sid}: {wp.get('canonical')} is a known camp but labelled "
                    f"'{wp.get('role')}' — check the extraction"
                )
    return errors


def assert_valid(doc: dict) -> None:
    errors = validate_geojson(doc)
    if errors:
        raise ValueError("Data validation failed:\n  " + "\n  ".join(errors))
