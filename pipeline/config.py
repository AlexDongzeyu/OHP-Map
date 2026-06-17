"""Shared paths and constants for the OHP build pipeline.

Everything downstream imports paths from here so the layout lives in one place.
"""
from __future__ import annotations

from pathlib import Path

# Repo root is the parent of /pipeline.
ROOT = Path(__file__).resolve().parent.parent

DATA = ROOT / "data"
SOURCE = DATA / "source" / "survivors_source.json"
GAZETTEER = DATA / "gazetteer.json"
GEOCODE_CACHE = DATA / "geocode_cache.json"
SCHEMA = DATA / "schema" / "survivors.schema.json"
GOLDEN_DIR = DATA / "golden"
REVIEW_DIR = DATA / "review"

# Build outputs (browser only ever loads these — doc 02 "decouple data from render").
OUT_GEOJSON = DATA / "survivors.geojson"
OUT_PLACE_INDEX = DATA / "place_index.json"
OUT_CONNECTIONS = DATA / "connections.json"

# Time window the front-end scrubber spans (doc 01 / F10).
TIME_MIN = 1933
TIME_MAX = 1950

# WordPress source of truth (doc 04). We only ever READ.
WP_BASE = "https://ohp.crestwood.on.ca"
WP_TYPES = f"{WP_BASE}/wp-json/wp/v2/types"

ROLES = ["birthplace", "ghetto", "camp", "transit", "liberation", "resettlement"]
