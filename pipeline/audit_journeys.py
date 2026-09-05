"""Audit the bounded journey corrections against a release, using local sources only.

    python -m pipeline.audit_journeys --baseline 626623f
"""
from __future__ import annotations

import argparse
import json
import subprocess
from collections import Counter

from . import config, dates, journey


def audit(current: dict, baseline: dict, baseline_revision: str) -> dict:
    old = {feature["properties"]["survivor_id"]: feature["properties"] for feature in baseline["features"]}
    source = {
        record["survivor_id"]: record for record in json.loads(
            (config.DATA / "source" / "ohp_all.json").read_text(encoding="utf-8"),
        )["people"]
    }
    counts = Counter(profiles_scanned=len(current["features"]))
    reasons, uncertain_reasons = Counter(), Counter()
    corrected, unresolved, samples = [], [], {}
    for feature in current["features"]:
        props = feature["properties"]
        sid = props["survivor_id"]
        previous = old.get(sid, {})
        before = {wp["canonical"]: wp for wp in previous.get("waypoints", [])}
        after = {wp["canonical"]: wp for wp in props.get("waypoints", [])}
        contexts = props.get("contextual_places", [])
        counts["contextual_mentions"] += len(contexts)
        counts["profiles_with_contextual_mentions"] += bool(contexts)
        counts["profiles_with_committed_source"] += sid in source
        reasons.update(wp["evidence"]["reason"] for wp in contexts)
        changes = {}
        moved = [
            {"canonical": wp["canonical"], "reason": wp["evidence"]["reason"], "source_quote": wp["source_quote"]}
            for wp in contexts if wp["canonical"] in before and wp["canonical"] not in after
        ]
        if moved:
            changes["route_to_context"] = moved
            counts["route_places_reclassified_as_context"] += len(moved)
            counts["unsupported_birthplace_roles_removed"] += sum(
                before[wp["canonical"]]["role"] == "birthplace" for wp in moved
            )
        roles, date_changes = [], []
        for canonical, waypoint in after.items():
            prior = before.get(canonical)
            if not prior:
                continue
            if prior["role"] != waypoint["role"]:
                roles.append([canonical, prior["role"], waypoint["role"]])
                counts["role_corrections"] += 1
                counts["unsupported_birthplace_roles_removed"] += prior["role"] == "birthplace"
            if prior["date"] != waypoint["date"]:
                date_changes.append({"canonical": canonical, "before": prior["date"], "after": waypoint["date"]})
                counts["date_corrections"] += 1
                counts["unsupported_exact_dates_removed"] += (
                    bool(prior["date"].get("start")) and not waypoint["date"].get("start")
                )
                counts["post_1959_dates_added_or_corrected"] += (dates.parse_year(waypoint["date"].get("start")) or 0) >= 1960
        if roles:
            changes["roles"] = roles
        if date_changes:
            changes["dates"] = date_changes
        for field in ("birth_year", "conflicts"):
            if props.get(field) != previous.get(field):
                changes[field] = {"before": previous.get(field), "after": props.get(field)}
                counts[f"{field}_corrections"] += 1
        if changes:
            corrected.append({"survivor_id": sid, **changes})
        ambiguities = [
            {
                "canonical": wp["canonical"], "reason": wp["evidence"]["reason"],
                **({"date_as_written": wp["date"]["as_written"]} if wp["date"].get("as_written") else {}),
            }
            for wp in after.values() if wp.get("evidence", {}).get("scope") == "uncertain"
        ]
        fuzzy = [
            {"canonical": wp["canonical"], "as_written": wp["date"]["as_written"]}
            for wp in after.values()
            if wp["date"].get("as_written") and wp["date"]["precision"] == "unknown"
        ]
        if ambiguities or fuzzy:
            unresolved.append({"survivor_id": sid, "uncertain_places": ambiguities, "fuzzy_dates": fuzzy})
        uncertain_reasons.update(wp["reason"] for wp in ambiguities)
        counts["uncertain_route_places"] += len(ambiguities)
        counts["unknown_fuzzy_dates_retained"] += len(fuzzy)
        counts["reviewed_records_preserved"] += props.get("review_status") == "reviewed"
        if sid in {"baker-norman", "adam-wally"}:
            fields = ("birth_year", "birth_date", "conflicts", "waypoints", "contextual_places")
            samples[sid] = {
                "archive_url": props["archive_url"],
                "before": {field: previous.get(field) for field in fields},
                "after": {field: props.get(field) for field in fields},
            }
    counts["profiles_with_corrections"] = len(corrected)
    counts["profiles_needing_attribution_or_date_review"] = len(unresolved)
    return {
        "scope": "All current public records; deterministic source-pattern audit, not human verification.",
        "baseline_revision": baseline_revision,
        "journey_revision": journey.REVISION,
        "source": "Committed OHP source records and cached source quotations; no network or model inference.",
        "counts": dict(counts),
        "contextual_reasons": dict(reasons),
        "uncertainty_reasons": dict(uncertain_reasons),
        "limitations": [
            "Rules are deliberately bounded, not general subject resolution; ambiguous subjects remain uncertain.",
            "Dates attach to explicit clauses/place lists. No adjacent-sentence or service-era date inheritance.",
            "Unknown/fuzzy dates do not establish an exact year; shorthand decades have no assumed century.",
            "Reviewed records and waypoints retain their claims; curated claims are flagged, not heuristically rewritten.",
            "Place coverage is limited to the supplied gazetteer. This audit does not certify coordinates or every route.",
            "Source conflicts are named associations, not a verified service chronology; birth-only and ancestor-only mentions are excluded.",
        ],
        "samples": samples,
        "corrections": corrected,
        "unresolved": unresolved,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default="626623f")
    args = parser.parse_args(argv)
    baseline = subprocess.run(
        ["git", "--no-pager", "show", f"{args.baseline}:data/survivors.geojson"],
        cwd=config.ROOT, capture_output=True, text=True, encoding="utf-8", check=True,
    )
    current = json.loads(config.OUT_GEOJSON.read_text(encoding="utf-8"))
    report = audit(current, json.loads(baseline.stdout), args.baseline)
    path = config.REVIEW_DIR / "journey_accuracy_audit.json"
    path.write_text(json.dumps(report, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps(report["counts"], sort_keys=True))
    print(f"Audit written to {path.relative_to(config.ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
