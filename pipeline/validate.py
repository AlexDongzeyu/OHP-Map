"""Validation: the build's safety net (doc 02 section 7).

Every emitted record is checked against data/schema/survivors.schema.json. If ANY
record is invalid the build raises — bad data can never deploy. We also run a few
semantic checks the JSON Schema can't express (coordinate sanity, role/site match).
"""
from __future__ import annotations

import json

from . import config, gazetteer


def _schema() -> dict:
    with open(config.SCHEMA, encoding="utf-8") as fh:
        return json.load(fh)


def validate_geojson(doc: dict) -> list[str]:
    """Return a list of human-readable errors. Empty list == valid."""
    from jsonschema import Draft7Validator

    errors: list[str] = []
    validator = Draft7Validator(_schema())
    for err in sorted(validator.iter_errors(doc), key=lambda e: list(e.path)):
        loc = "/".join(str(p) for p in err.path)
        errors.append(f"schema: {loc}: {err.message}")

    # Semantic checks beyond the schema.
    for feat in doc.get("features", []):
        props = feat.get("properties", {})
        sid = props.get("survivor_id", "?")
        lng, lat = (feat.get("geometry", {}).get("coordinates", [None, None]) + [None, None])[:2]
        if lat is None or not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
            errors.append(f"{sid}: feature coordinates out of range (remember [lng, lat])")
        for wp in props.get("waypoints", []):
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
