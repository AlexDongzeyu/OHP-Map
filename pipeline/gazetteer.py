"""Place gazetteer + normalization (doc 01 "geocoding problem").

Two jobs:
1. normalize(): map a survivor's *as-written* exonym (Lemberg, Pressburg, Cracow)
   to ONE canonical modern name, so the same place geocodes once and clusters
   correctly. The survivor's original spelling is always preserved upstream.
2. known_site_role(): the deterministic backstop. If the LLM (or a human) labels a
   well-known camp/ghetto with the wrong role, this force-match catches it.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache

from . import config


@lru_cache(maxsize=1)
def _load() -> dict:
    with open(config.GAZETTEER, encoding="utf-8") as fh:
        return json.load(fh)


def _key(name: str) -> str:
    """Lowercase + strip surrounding punctuation/whitespace for alias lookup."""
    return re.sub(r"[\s]+", " ", name.strip().lower()).strip(" .,;:")


def normalize(as_written: str) -> str | None:
    """Return the canonical modern name for an as-written place, or None if unknown.

    Unknown places are intentionally returned as None rather than guessed — an
    honest "unplaced" is better than a wrong pin (doc 08 weakness #9).
    """
    if not as_written:
        return None
    aliases = _load()["aliases"]
    key = _key(as_written)
    if key in aliases:
        return aliases[key]
    # Allow "the Lemberg ghetto" style phrasing by testing each token-run.
    for alias, canonical in aliases.items():
        if re.search(rf"\b{re.escape(alias)}\b", key):
            return canonical
    return None


def known_site_role(canonical: str) -> str | None:
    """Return the canonical role for a known camp/ghetto, else None."""
    return _load()["known_sites"].get(canonical)


def known_sites() -> dict[str, str]:
    return dict(_load()["known_sites"])
