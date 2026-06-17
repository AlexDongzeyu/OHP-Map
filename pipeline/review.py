"""The human-review gate (doc 04 guardrail #2, doc 02 risk R3/R7).

Nothing extracted publishes until a person confirms it. This module:
* emit_review_queue() — writes every unverified / low-confidence waypoint to a CSV
  and JSON queue for a human to sit with the testimony and approve.
* filter_published() — keeps ONLY verified waypoints, and drops any survivor left
  with no verified waypoints. That filtered set is what renders on the map.

For the bundled sample, the anchors are hand-entered and already verified, so the
queue comes out empty — but the gate is real and runs every build.
"""
from __future__ import annotations

import csv
import json

from . import config

LOW_CONFIDENCE = 0.85


def _flag(wp: dict) -> str | None:
    if not wp.get("verified"):
        return "unverified"
    if wp.get("confidence", 1.0) < LOW_CONFIDENCE:
        return "low_confidence"
    return None


def emit_review_queue(survivors: list[dict]) -> int:
    """Write the review queue (CSV + JSON). Returns the number of queued items."""
    config.REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    rows = []
    for s in survivors:
        for i, wp in enumerate(s.get("waypoints", [])):
            flag = _flag(wp)
            if flag:
                rows.append({
                    "survivor_id": s["survivor_id"],
                    "name": s.get("name", ""),
                    "order": i,
                    "as_written": wp.get("as_written", ""),
                    "canonical": wp.get("canonical", ""),
                    "role": wp.get("role", ""),
                    "date": json.dumps(wp.get("date")),
                    "confidence": wp.get("confidence", ""),
                    "flag": flag,
                    "source_quote": wp.get("source_quote", ""),
                    "archive_url": s.get("archive_url", ""),
                    "approved": "",  # a reviewer sets this to yes/no
                })

    with open(config.REVIEW_DIR / "review_queue.json", "w", encoding="utf-8") as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    fields = ["survivor_id", "name", "order", "as_written", "canonical", "role",
              "date", "confidence", "flag", "source_quote", "archive_url", "approved"]
    with open(config.REVIEW_DIR / "review_queue.csv", "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def filter_published(survivors: list[dict]) -> list[dict]:
    """Keep only verified waypoints; drop survivors with none left."""
    published = []
    for s in survivors:
        verified = [wp for wp in s.get("waypoints", []) if wp.get("verified")]
        if not verified:
            continue
        s = dict(s)
        s["waypoints"] = verified
        published.append(s)
    return published
