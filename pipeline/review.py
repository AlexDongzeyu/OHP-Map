"""The human-review gate (doc 04 guardrail #2, doc 02 risk R3/R7).

Human verification and publication are separate, explicit states. This module:
* emit_review_queue() — writes unresolved unverified / low-confidence waypoints to
  a CSV and JSON queue for a human to sit with the testimony. This legacy queue is not
  an import format; blank "approved" cells do not authorize any data changes.
* stage() — labels pending routes honestly; strict mode keeps only wholly reviewed
  routes. An account-level label cannot override an unverified waypoint. Existing
  fingerprinted approvals cease to verify a claim when its source identity changes.
* pipeline.review_decisions — exports source-fingerprinted worksheets and checks/
  applies explicit human decisions offline. Run its --help for maintainer commands.

Bundled fictional samples can have hand-entered verified anchors. Nothing in this
module independently verifies a real testimony.
"""
from __future__ import annotations

import csv
import json

from . import config

LOW_CONFIDENCE = 0.85


def _flag(wp: dict, account: dict | None = None) -> str | None:
    audit = wp.get("human_review")
    if account is not None and "human_review" in wp:
        from .review_decisions import source_fingerprint

        if not isinstance(audit, dict) or audit.get("action") not in ("approve", "context", "reject"):
            return "invalid_review"
        action = audit["action"]
        try:
            if audit.get("source_fingerprint") != source_fingerprint(account, wp):
                return "stale_review"
        except ValueError:
            return "stale_review"
        personal = action == "approve"
        if (
            wp.get("verified") is personal
            and (wp.get("evidence") or {}).get("scope") == ("personal" if personal else "contextual")
        ):
            return None
        return "inconsistent_review"
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
        for i, wp in enumerate([*s.get("waypoints", []), *s.get("contextual_places", [])]):
            flag = _flag(wp, s)
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
                    "evidence_scope": wp.get("evidence", {}).get("scope", ""),
                    "evidence_reason": wp.get("evidence", {}).get("reason", ""),
                    "source_quote": wp.get("source_quote", ""),
                    "archive_url": s.get("archive_url", ""),
                    "approved": "",  # legacy worksheet only; never implicitly imported
                })

    with open(config.REVIEW_DIR / "review_queue.json", "w", encoding="utf-8") as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    fields = ["survivor_id", "name", "order", "as_written", "canonical", "role",
              "date", "confidence", "flag", "evidence_scope", "evidence_reason",
              "source_quote", "archive_url", "approved"]
    with open(config.REVIEW_DIR / "review_queue.csv", "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def stage(survivors: list[dict], strict: bool = False) -> list[dict]:
    """Tag each survivor with a review_status and decide what publishes.

    Every survivor keeps only its placeable waypoints. Unresolved route claims
    recorded by the geocoder still prevent a wholly reviewed status. Public profiles
    with none remain pending and discoverable with null geometry. We do NOT silently drop
    unverified records — on a memorial, hiding everything unreviewed would just show
    "0 journeys". Instead each record is labelled honestly:

        review_status = "reviewed"  -> every route waypoint is verified/personal
                        "pending"   -> auto-extracted, awaiting human verification

    The front end renders "pending" records faintly and clearly labelled (doc 09
    Step 2.5, the accepted "looser" option). Pass strict=True to publish only fully
    reviewed records (the conservative memorial setting).
    """
    staged = []
    for s in survivors:
        s = dict(s)
        wps = []
        for wp in s.get("waypoints", []):
            if wp.get("verified") is True and "human_review" in wp:
                flag = _flag(wp, s)
                if flag:
                    wp = {
                        **wp, "verified": False,
                        "evidence": {
                            **(wp.get("evidence") or {}), "scope": "uncertain",
                            "reason": f"{flag}: recorded approval does not support the current route claim",
                        },
                    }
            wps.append(wp)
        s["waypoints"] = wps
        all_verified = bool(wps) and not s.get("unplaced_waypoint_count", 0) and all(
            wp.get("verified") is True
            and (wp.get("evidence") or {}).get("scope", "personal") == "personal"
            for wp in wps
        )
        status = "reviewed" if all_verified else "pending"
        if strict and status != "reviewed":
            continue
        s["review_status"] = status
        staged.append(s)
    return staged


# Backwards-compatible alias used by older callers/tests.
def filter_published(survivors: list[dict]) -> list[dict]:
    """Strict publish: reviewed records only (kept for compatibility)."""
    return stage(survivors, strict=True)
