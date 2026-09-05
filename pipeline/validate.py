"""Validation: the build's safety net (doc 02 section 7).

Every emitted record is checked against data/schema/survivors.schema.json. If ANY
record is invalid the build raises — bad data can never deploy. We also run a few
semantic checks the JSON Schema can't express (coordinate sanity, role/site match).
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from math import cos, hypot, radians

from . import config, gazetteer, media


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
        geometry = feat.get("geometry")
        if geometry is not None:
            lng, lat = (geometry.get("coordinates", [None, None]) + [None, None])[:2]
            if (
                not isinstance(lat, (int, float)) or not isinstance(lng, (int, float))
                or not (-90 <= lat <= 90) or not (-180 <= lng <= 180)
            ):
                errors.append(f"{sid}: feature coordinates out of range (remember [lng, lat])")
        profile_media = props.get("profile_media")
        if profile_media:
            videos = profile_media.get("videos", [])
            ids = [video.get("id") for video in videos]
            if len(set(ids)) != len(ids) or len(videos) != props.get("video_count", len(videos)):
                errors.append(f"{sid}: video inventory count or identifiers disagree")
            for video in videos:
                reference = media.safe_vimeo_reference(video.get("embed_url"))
                if (
                    not reference or reference["id"] != video.get("id")
                    or reference["embed_url"] != video.get("embed_url")
                    or video.get("url") != reference["url"]
                ):
                    errors.append(f"{sid}: unsafe or mismatched public video reference")
            for image in profile_media.get("images", []):
                if not media.safe_photo_url(image.get("source_url")):
                    errors.append(f"{sid}: image lacks an official OHP photograph source")
                if image.get("full_url") and (
                    not image.get("primary")
                    or not re.fullmatch(r"assets/portraits/[a-z0-9-]+\.webp", image.get("url", ""))
                    or not media.safe_photo_url(image["full_url"])
                    or media.photo_key(image["full_url"]) != media.photo_key(image["source_url"])
                ):
                    errors.append(f"{sid}: uncropped photograph must be the same cleared primary source")
        if props.get("captioned_video_count", 0) > props.get("video_count", 0):
            errors.append(f"{sid}: caption coverage exceeds the chapter inventory")
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
            documented_camp_birth = wp.get("role") == "birthplace" and (
                wp.get("verified") or props.get("review_status") == "reviewed" or (
                    wp.get("evidence", {}).get("scope") == "personal"
                    and re.search(r"\bborn\b", wp.get("source_quote", ""), re.I)
                )
            )
            if expected == "camp" and wp.get("role") in ("birthplace", "resettlement") and not documented_camp_birth:
                errors.append(
                    f"{sid}: {wp.get('canonical')} is a known camp but labelled "
                    f"'{wp.get('role')}' — check the extraction"
                )
    return errors


def assert_valid(doc: dict) -> None:
    errors = validate_geojson(doc)
    if errors:
        raise ValueError("Data validation failed:\n  " + "\n  ".join(errors))
