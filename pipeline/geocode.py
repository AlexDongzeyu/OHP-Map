"""Build-time geocoding with a committed cache (doc 02 N4, doc 04).

Geocoding happens ONCE, at build time, and the result is cached in
data/geocode_cache.json (committed to the repo). The browser never geocodes.

By default we only read the cache, so the build is fully offline and reproducible.
Pass allow_network=True to fall back to Nominatim (throttled to 1 req/sec per their
usage policy) for any canonical name not yet cached; new results are written back to
the cache so they're committed and never fetched again.
"""
from __future__ import annotations

import json
import time

from . import config

_NOMINATIM = "https://nominatim.openstreetmap.org/search"
_USER_AGENT = "crestwood-ohp-map/1.0 (build pipeline; contact maintainer)"


def load_cache() -> dict:
    with open(config.GEOCODE_CACHE, encoding="utf-8") as fh:
        return json.load(fh)


def save_cache(cache: dict) -> None:
    with open(config.GEOCODE_CACHE, "w", encoding="utf-8") as fh:
        json.dump(cache, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def geocode(canonical: str, cache: dict, allow_network: bool = False):
    """Return {'lat','lng',...} for a canonical name, or None if unresolved.

    Cache hits cost nothing. Misses are only fetched when allow_network=True.
    """
    if canonical in cache and isinstance(cache[canonical], dict) and "lat" in cache[canonical]:
        return cache[canonical]
    if not allow_network:
        return None

    import requests  # imported lazily so offline builds need no network stack

    time.sleep(1.0)  # Nominatim policy: max 1 request/second
    resp = requests.get(
        _NOMINATIM,
        params={"q": canonical, "format": "json", "limit": 1},
        headers={"User-Agent": _USER_AGENT},
        timeout=30,
    )
    resp.raise_for_status()
    hits = resp.json()
    if not hits:
        return None
    rec = {
        "lat": float(hits[0]["lat"]),
        "lng": float(hits[0]["lon"]),
        "source": "nominatim",
        "precision": "city",
    }
    cache[canonical] = rec
    return rec
