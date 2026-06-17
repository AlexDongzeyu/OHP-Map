"""Crestwood OHP survivor-map build pipeline.

Modules:
    config    paths and constants
    ingest    WordPress REST (Plan A) / HTML scrape (Plan B) / local source
    extract   LLM extractor (primary) + deterministic offline fallback
    gazetteer historical place-name normalization + known-site validation
    geocode   build-time geocoding with a committed cache
    dates     fuzzy-date helpers for the time scrubber
    derive    place index + verified connection layer + waypoint ordering
    validate  JSON-schema + semantic validation (build fails on bad data)
    review    the human-review gate
    build     the orchestrator (run: python -m pipeline.build)
"""
