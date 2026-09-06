"""Offline, source-bound human review for trusted repository maintainers.

No command fetches evidence, authenticates a reviewer, or changes the live site.
Students/teachers supply decisions; a trusted maintainer checks the cited source,
reviews the file, and supplies it again on every rebuild. Keep that file in version
control. Never treat a worksheet download or a browser submission as approval.

Review commands (output paths must be new, distinct files):
    python -m pipeline.review_decisions export --dataset data\\survivors.geojson \
        --survivor-id ACCOUNT-ID --output worksheet.json
    python -m pipeline.review_decisions check --dataset data\\survivors.geojson \
        --decisions decisions.json
    python -m pipeline.review_decisions apply --dataset data\\survivors.geojson \
        --decisions decisions.json --output reviewed-candidate.geojson

Rebuild with the same explicit decision file, using the normal build outputs:
    python -m pipeline.build --review-decisions decisions.json

Worksheet schema:
    {"schema_version": "ohp-review-worksheet/v1",
     "account": {"survivor_id": str, "name": str, "archive_url": str},
     "instructions": str,
     "entries": [{"source_fingerprint": "sha256:<64 lowercase hex characters>",
                  "collection": "waypoints" | "contextual_places", "index": int,
                  "waypoint": {original waypoint, unchanged},
                  "decision": {"action": "", "reviewer": "", "reviewed_at": "",
                               "source_url": "", "rationale": ""}}]}

Separate decision-file schema (all fields required; unknown fields are errors):
    {"schema_version": "ohp-review-decisions/v1",
     "decisions": [{"survivor_id": str, "source_fingerprint": str,
                    "action": "approve" | "context" | "reject",
                    "reviewer": str, "reviewed_at": "YYYY-MM-DD",
                    "source_url": "https://...", "rationale": str}]}

Only include completed decisions, one per source fingerprint. ``approve`` means
the reviewer explicitly confirms this person's presence, the source quote, place,
role, date, and representative coordinates. It can promote a contextual mention
only through that explicit decision. ``context`` confirms a non-personal mention;
``reject`` rejects the proposed personal-place claim, NOT the testimony. Both keep
the full original point in contextual_places, unverified, with a review explanation.
No action changes a quote, canonical name, date, coordinates, or confidence.
Corrections are deliberately unsupported: correct the source/normalization through
the existing curation process, rebuild, then export and review the new fingerprint.

``apply`` writes only a candidate GeoJSON, not derived indices or publication
artifacts. The normal build with --review-decisions regenerates those consistently.
The account gate means every remaining route point is verified/personal; it does
not certify the whole interview or turn unrelated contextual places into a route.
Browser source downloads may use a one-account FeatureCollection with null feature
geometry and complete original properties. Export/check/apply accept that input;
waypoint coordinates are still required. Only an explicitly requested candidate
output receives derived feature geometry; the downloaded source stays unchanged.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import date
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
from urllib.parse import urlsplit

from . import config, derive, review, validate

WORKSHEET_SCHEMA = "ohp-review-worksheet/v1"
DECISIONS_SCHEMA = "ohp-review-decisions/v1"
FINGERPRINT_VERSION = "ohp-waypoint/v1"
COLLECTIONS = ("waypoints", "contextual_places")
ACTIONS = ("approve", "context", "reject")
DECISION_FIELDS = {
    "survivor_id", "source_fingerprint", "action", "reviewer",
    "reviewed_at", "source_url", "rationale",
}
INSTRUCTIONS = (
    "This worksheet is not an approval and cannot update the public archive. "
    "Check each claim against the linked testimony. In a separate JSON file with "
    'schema_version "ohp-review-decisions/v1", put completed entries in "decisions": '
    "survivor_id, source_fingerprint, action, reviewer, reviewed_at (YYYY-MM-DD), "
    "source_url, rationale. Do not copy blank decisions. Approve explicitly confirms "
    "this person's presence, quotation, place, role, date and representative coordinates; "
    "context/reject retain the source outside the personal route. Confidence is unchanged. "
    "Do not edit waypoint fields to correct a claim: ask the maintainer to correct the "
    "source and export a fresh worksheet. A trusted repository maintainer must check and "
    "import the decision file and pass --review-decisions on subsequent builds. "
    "Reviewer names and rationales will be included in the published point's audit."
)


class ReviewError(ValueError):
    """An invalid, ambiguous, or stale review must not produce any output."""


def _text(value, label: str, maximum: int = 4000) -> str:
    if (
        not isinstance(value, str) or not value.strip() or value != value.strip()
        or len(value) > maximum or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value)
    ):
        raise ReviewError(f"{label} must be nonblank, trimmed text (at most {maximum} characters)")
    return value


def _url(value, label: str) -> str:
    value = _text(value, label, 2048)
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").encode("idna").decode("ascii")
        port = parsed.port
    except (ValueError, UnicodeError) as exc:
        raise ReviewError(f"{label} must be an absolute HTTP(S) source URL") from exc
    if (
        parsed.scheme not in ("http", "https") or not host
        or parsed.username is not None or parsed.password is not None
        or re.search(r"\s|\\", value) or re.search(r"%(?![0-9a-fA-F]{2})", value)
        or (port is not None and not 1 <= port <= 65535)
        or not all(re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?", label)
                   for label in host.split("."))
    ):
        raise ReviewError(f"{label} must be an absolute HTTP(S) source URL without credentials")
    return value


def _coordinate(value, limit: int) -> str:
    if type(value) not in (int, float) or not math.isfinite(value) or not -limit <= value <= limit:
        raise ReviewError("A fingerprint requires finite, in-range numeric lat/lng coordinates")
    return struct.pack(">d", 0.0 if value == 0 else float(value)).hex()


def source_fingerprint(account: dict, waypoint: dict) -> str:
    """Return ``sha256:`` + SHA-256 hex of this exact, versioned source identity.

    Cross-language contract: UTF-8 encode compact JSON of the following array, with
    literal Unicode (no ASCII escaping), no Unicode normalization, and no spaces:

      ["ohp-waypoint/v1", account.survivor_id, account.archive_url,
       wp.as_written, wp.canonical, wp.role,
       [wp.date.start, wp.date.end, wp.date.precision, wp.date.as_written ?? null],
       wp.source_quote ?? null,
       [float64hex(wp.lat), float64hex(wp.lng), wp.location_precision ?? null,
        wp.location_note ?? null, wp.location_source_url ?? null,
        wp.location_coordinate_source_url ?? null]]

    float64hex is 16 lowercase hexadecimal digits of an IEEE-754 binary64 value,
    big endian; normalize negative zero to positive zero. In JS use
    DataView.setFloat64(0, value === 0 ? 0 : value, false), then hex-encode its 8
    bytes. Every optional missing/null value above is JSON null. Required values
    must not be defaulted. Date extensions require a new fingerprint version.

    The collection/index, verified flag, evidence classification, review audit and
    confidence are excluded: review may reclassify a point but cannot change its
    source identity. Matching always recomputes the hash from the actual point,
    never from an earlier stored audit. Ambiguous duplicate identities fail closed
    on import; worksheets retain them and explain the need for source disambiguation.
    """
    if not isinstance(account, dict) or not isinstance(waypoint, dict):
        raise ReviewError("Fingerprint account and waypoint must be objects")
    sid = _text(account.get("survivor_id"), "survivor_id", 200)
    if not re.fullmatch(r"[a-z0-9-]+", sid):
        raise ReviewError("survivor_id must use lowercase letters, numbers and hyphens")
    archive_url = _url(account.get("archive_url"), "archive_url")
    for field in ("as_written", "canonical", "role"):
        _text(waypoint.get(field), f"waypoint.{field}")
    if waypoint["role"] not in config.ROLES:
        raise ReviewError("waypoint.role is not a supported route role")
    when = waypoint.get("date")
    if (
        not isinstance(when, dict) or not {"start", "end", "precision"} <= when.keys()
        or when.keys() - {"start", "end", "precision", "as_written"}
        or when.get("precision") not in ("day", "month", "year", "range", "unknown")
        or any(value is not None and not isinstance(value, str) for value in when.values())
    ):
        raise ReviewError("waypoint.date must use the supported start/end/precision/as_written fields")
    optional_fields = (
        "source_quote", "location_precision", "location_note",
        "location_source_url", "location_coordinate_source_url",
    )
    if any(waypoint.get(key) is not None and not isinstance(waypoint[key], str)
           for key in optional_fields):
        raise ReviewError("Waypoint quotation and coordinate provenance must be strings or null")
    payload = [
        FINGERPRINT_VERSION, sid, archive_url,
        waypoint["as_written"], waypoint["canonical"], waypoint["role"],
        [when.get(key) for key in ("start", "end", "precision", "as_written")],
        waypoint.get("source_quote"),
        [_coordinate(waypoint.get("lat"), 90), _coordinate(waypoint.get("lng"), 180),
         *[waypoint.get(key) for key in optional_fields[1:]]],
    ]
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _unique_keys(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ReviewError(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def _invalid_constant(value: str):
    raise ReviewError(f"Non-finite JSON number: {value}")


def _load_json(path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8-sig"),
                      object_pairs_hook=_unique_keys, parse_constant=_invalid_constant)


def validate_decisions(document: dict) -> list[dict]:
    """Validate the whole decision file before matching or modifying any records."""
    if (
        not isinstance(document, dict) or set(document) != {"schema_version", "decisions"}
        or document.get("schema_version") != DECISIONS_SCHEMA
    ):
        raise ReviewError(f"Expected a separate {DECISIONS_SCHEMA} file, not an edited worksheet")
    rows = document["decisions"]
    if not isinstance(rows, list) or not rows:
        raise ReviewError("decisions must contain at least one explicit, completed decision")
    seen = set()
    for number, row in enumerate(rows, 1):
        label = f"decision {number}"
        if not isinstance(row, dict) or set(row) != DECISION_FIELDS:
            raise ReviewError(f"{label} requires exactly: {', '.join(sorted(DECISION_FIELDS))}; "
                              "waypoint corrections are not supported")
        sid = _text(row["survivor_id"], f"{label}.survivor_id", 200)
        if not re.fullmatch(r"[a-z0-9-]+", sid):
            raise ReviewError(f"{label}.survivor_id is invalid")
        fingerprint = row["source_fingerprint"]
        if not isinstance(fingerprint, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", fingerprint):
            raise ReviewError(f"{label}.source_fingerprint must be a worksheet SHA-256 fingerprint")
        if row["action"] not in ACTIONS:
            raise ReviewError(f"{label}.action must be approve, context or reject")
        reviewer = _text(row["reviewer"], f"{label}.reviewer", 200)
        if "\n" in reviewer or "\r" in reviewer or reviewer.casefold() in {
            "anonymous", "unknown", "reviewer", "your name", "tbd", "todo", "n/a",
        }:
            raise ReviewError(f"{label}.reviewer must identify the actual human reviewer")
        reviewed_at = row["reviewed_at"]
        if not isinstance(reviewed_at, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", reviewed_at):
            raise ReviewError(f"{label}.reviewed_at must be YYYY-MM-DD")
        try:
            reviewed_date = date.fromisoformat(reviewed_at)
        except ValueError as exc:
            raise ReviewError(f"{label}.reviewed_at is not a valid calendar date") from exc
        if reviewed_date > date.today():
            raise ReviewError(f"{label}.reviewed_at cannot be in the future")
        _url(row["source_url"], f"{label}.source_url")
        _text(row["rationale"], f"{label}.rationale")
        key = (sid, fingerprint)
        if key in seen:
            raise ReviewError(f"{label} duplicates a decision for the same source fingerprint")
        seen.add(key)
    return rows


def load_decisions(path) -> dict:
    document = _load_json(path)
    validate_decisions(document)
    return document


def _accounts(survivors: list[dict]) -> dict[str, dict]:
    accounts = {}
    for survivor in survivors:
        sid = survivor.get("survivor_id")
        if not isinstance(sid, str) or sid in accounts:
            raise ReviewError("Dataset must have distinct string survivor_id values")
        accounts[sid] = survivor
    return accounts


def export_worksheet(document: dict, survivor_id: str) -> dict:
    """Export every route and contextual point for exactly one loaded account."""
    _validate_document(document, allow_source_snapshot=True)
    accounts = _accounts([feature["properties"] for feature in document["features"]])
    if survivor_id not in accounts:
        raise ReviewError(f"Account {survivor_id!r} is not in this dataset")
    account = accounts[survivor_id]
    entries = []
    seen = set()
    duplicates = set()
    for collection in COLLECTIONS:
        for index, waypoint in enumerate(account.get(collection, [])):
            fingerprint = source_fingerprint(account, waypoint)
            if fingerprint in seen:
                duplicates.add(fingerprint)
            seen.add(fingerprint)
            entries.append({
                "source_fingerprint": fingerprint, "collection": collection, "index": index,
                "waypoint": deepcopy(waypoint),
                "decision": {key: "" for key in
                             ("action", "reviewer", "reviewed_at", "source_url", "rationale")},
            })
    return {
        "schema_version": WORKSHEET_SCHEMA,
        "account": {key: account.get(key, "") for key in ("survivor_id", "name", "archive_url")},
        "instructions": INSTRUCTIONS + (
            f" This account has {len(duplicates)} ambiguous duplicate source fingerprint(s). "
            "Those entries cannot be imported until the maintainer disambiguates the source; "
            "other distinct entries can still be reviewed."
            if duplicates else ""
        ),
        "entries": entries,
    }


def apply_decisions(survivors: list[dict], document: dict) -> list[dict]:
    """Return a deep copy with all decisions applied, or fail without mutation.

    Exactly one actual source point must match each decision. Reapplying the same
    file is idempotent, including after a point has moved between collections.
    One active decision per point belongs in the version-controlled file; replacing
    it explicitly replaces the active audit, while its Git history remains intact.
    """
    rows = validate_decisions(document)
    accounts = _accounts(survivors)
    by_source = {}
    for sid in {row["survivor_id"] for row in rows}:
        if sid not in accounts:
            raise ReviewError(f"Unknown account {sid!r}; export from the current dataset")
        for collection in COLLECTIONS:
            for waypoint in accounts[sid].get(collection, []):
                key = (sid, source_fingerprint(accounts[sid], waypoint))
                by_source.setdefault(key, []).append(waypoint)
    decisions = {}
    for row in rows:
        key = (row["survivor_id"], row["source_fingerprint"])
        matches = by_source.get(key, [])
        if len(matches) != 1:
            reason = "stale or missing" if not matches else "ambiguous duplicate"
            raise ReviewError(f"{row['survivor_id']}: {reason} source fingerprint; "
                              "export a fresh worksheet and review the current source")
        if row["action"] == "approve" and not (matches[0].get("source_quote") or "").strip():
            raise ReviewError(f"{row['survivor_id']}: approval requires a source quote; "
                              "correct the source and export a fresh worksheet")
        decisions[key] = row

    result = deepcopy(survivors)
    for account in result:
        if not any(sid == account["survivor_id"] for sid, _ in decisions):
            continue
        classified = {key: [] for key in COLLECTIONS}
        for collection in COLLECTIONS:
            for waypoint in account.get(collection, []):
                fingerprint = source_fingerprint(account, waypoint)
                row = decisions.get((account["survivor_id"], fingerprint))
                destination = collection
                if row:
                    previous = waypoint.get("human_review") or {}
                    if not isinstance(previous, dict):
                        raise ReviewError(f"{account['survivor_id']}: malformed existing human_review audit")
                    if previous.get("source_fingerprint") != fingerprint:
                        previous = {}
                    original_evidence = previous.get("original_evidence", waypoint.get("evidence"))
                    original_collection = previous.get("original_collection", collection)
                    waypoint["human_review"] = {
                        **{key: value for key, value in row.items() if key != "survivor_id"},
                        "original_evidence": deepcopy(original_evidence),
                        "original_collection": original_collection,
                    }
                    personal = row["action"] == "approve"
                    waypoint["verified"] = personal
                    waypoint["evidence"] = {
                        **(waypoint.get("evidence") or {}),
                        "scope": "personal" if personal else "contextual",
                        "reason": f"human-review-{row['action']}: {row['rationale']}",
                    }
                    destination = "waypoints" if personal else "contextual_places"
                classified[destination].append(waypoint)
        account.update(classified)
        account["waypoints"] = derive.order_waypoints(account["waypoints"])
    return review.stage(result)


def _validate_document(document: dict, *, allow_source_snapshot: bool = False) -> None:
    # Check shape first: the existing semantic validator expects schema-shaped data.
    from jsonschema import Draft7Validator

    schema = validate._schema()
    if allow_source_snapshot:
        schema["definitions"]["survivor"].pop("allOf", None)
    errors = list(Draft7Validator(schema).iter_errors(document))
    if errors:
        raise ReviewError(f"Invalid generated dataset: {errors[0].message}")
    checked = document
    if allow_source_snapshot:
        checked = deepcopy(document)
        for feature in checked["features"]:
            waypoints = feature["properties"]["waypoints"]
            if feature["geometry"] is None and waypoints:
                # A source-only download omits derived geometry, not source coordinates.
                feature["geometry"] = {
                    "type": "Point", "coordinates": [waypoints[0]["lng"], waypoints[0]["lat"]],
                }
    validate.assert_valid(checked)


def apply_document(document: dict, decisions: dict, strict: bool = False) -> dict:
    """Apply to a generated GeoJSON and recompute geometry and publication counts."""
    _validate_document(document, allow_source_snapshot=True)
    survivors = apply_decisions([feature["properties"] for feature in document["features"]], decisions)
    staged = review.stage(survivors, strict=strict)
    by_id = {account["survivor_id"]: account for account in staged}
    result = deepcopy(document)
    features = []
    for feature in result["features"]:
        account = by_id.get(feature["properties"]["survivor_id"])
        if account is None:
            continue
        feature["properties"] = account
        home = next((wp for wp in account["waypoints"] if wp["role"] == "birthplace"),
                    account["waypoints"][0] if account["waypoints"] else None)
        feature["geometry"] = {"type": "Point", "coordinates": [home["lng"], home["lat"]]} if home else None
        features.append(feature)
    result["features"] = features
    groups = {}
    for account in staged:
        group = account.get("group", "Holocaust Survivors")
        groups[group] = groups.get(group, 0) + 1
    reviewed = sum(account["review_status"] == "reviewed" for account in staged)
    result.setdefault("metadata", {}).update({
        "count": len(staged), "reviewed": reviewed, "pending": len(staged) - reviewed,
        "placed": sum(bool(account["waypoints"]) for account in staged),
        "unplaced": sum(not account["waypoints"] for account in staged), "groups": groups,
        "sample_data": any(account.get("is_sample", False) for account in staged),
    })
    _validate_document(result)
    return result


def _write_new_output(path, document: dict, inputs: list) -> None:
    output = Path(path)
    if any(output.resolve() == Path(source).resolve() for source in inputs):
        raise ReviewError("Output must be distinct from every source input")
    if output.exists():
        raise ReviewError("Output already exists; choose a new path (no files are overwritten)")
    payload = (json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    # Exclusive creation also protects hardlinks/symlinks and concurrent writers.
    with output.open("xb") as handle:
        handle.write(payload)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Offline human review for trusted maintainers; never edits source files or the live site.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            'Decision JSON: {"schema_version":"ohp-review-decisions/v1","decisions":[...]}\n'
            "Each completed decision requires survivor_id, source_fingerprint, action,\n"
            "reviewer, reviewed_at (YYYY-MM-DD), source_url (HTTP/S), and rationale.\n"
            "approve = confirmed personal presence; context/reject = retained outside the route.\n"
            "No corrections, blank approvals, duplicate targets, or stale fingerprints are accepted.\n"
            "Keep decisions in version control and pass --review-decisions to every pipeline.build.\n"
            "Check source credibility yourself: the CLI cannot authenticate reviewers or evidence."
        ),
    )
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export", help="write a per-account worksheet with blank decisions")
    export.add_argument("--dataset", required=True, help="generated GeoJSON or a complete browser source FeatureCollection")
    export.add_argument("--survivor-id", required=True, help="exact account survivor_id")
    export.add_argument("--output", required=True, help="new worksheet JSON path")
    for name in ("check", "apply"):
        command = commands.add_parser(name, help="validate all decisions without writing" if name == "check"
                                      else "write a reviewed candidate GeoJSON to a new explicit path")
        command.add_argument("--dataset", required=True, help="generated GeoJSON or a complete browser source FeatureCollection")
        command.add_argument("--decisions", required=True, help="separate completed decision JSON file")
        command.add_argument("--strict", action="store_true", help="keep only accounts whose whole route is verified")
        if name == "apply":
            command.add_argument("--output", required=True, help="new candidate GeoJSON path (not a source input)")
    args = parser.parse_args(argv)
    try:
        document = _load_json(args.dataset)
        if args.command == "export":
            worksheet = export_worksheet(document, args.survivor_id)
            _write_new_output(args.output, worksheet, [args.dataset])
            print(f"[review] Exported {len(worksheet['entries'])} blank entries for {args.survivor_id}.")
        else:
            decisions = load_decisions(args.decisions)
            candidate = apply_document(document, decisions, strict=args.strict)
            if args.command == "apply":
                _write_new_output(args.output, candidate, [args.dataset, args.decisions])
            verb = "Checked" if args.command == "check" else "Applied"
            print(f"[review] {verb} {len(decisions['decisions'])} decisions; "
                  f"{candidate['metadata']['reviewed']} reviewed, {candidate['metadata']['pending']} pending accounts. "
                  "No source files or live publication changed.")
    except (OSError, ValueError) as exc:
        print(f"[review] {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
