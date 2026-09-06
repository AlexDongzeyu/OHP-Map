"""Human-review tests use fictional claims only; no production artifacts are built."""
from copy import deepcopy
import csv
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

import pytest

from pipeline import build, config, review, review_decisions as decisions, validate


@pytest.fixture
def files():
    # Keep all test-created files inside this checkout, never in an OS temp folder.
    directory = Path(__file__).resolve().parent / f".review-files-{uuid.uuid4().hex}"
    directory.mkdir()
    try:
        yield directory
    finally:
        shutil.rmtree(directory)


def _waypoint(place, canonical, lat, lng, year, confidence, scope="uncertain"):
    return {
        "as_written": place, "canonical": canonical, "role": "transit",
        "lat": lat, "lng": lng, "location_precision": "city",
        "date": {"start": year, "end": year, "precision": "year"},
        "source_quote": f'Fictional test quotation: “The witness mentions {place} in {year}.”',
        "confidence": confidence, "verified": False,
        "evidence": {"scope": scope, "reason": "synthetic-test-claim"},
    }


@pytest.fixture
def dataset():
    account = {
        "survivor_id": "fictional-review-fixture", "name": "Fictional review fixture",
        "archive_url": "https://example.test/accounts/fictional-review-fixture",
        "is_sample": True, "group": "Test fixtures", "theme_tags": [],
        "review_status": "pending",
        "waypoints": [
            _waypoint("Warsaw", "Warsaw, Poland", 52.2297, 21.0122, "1944", 0.42),
            _waypoint("Toronto", "Toronto, Canada", 43.6532, -79.3832, "1950", 0.66),
        ],
        "contextual_places": [
            _waypoint("Berlin", "Berlin, Germany", 52.52, 13.405, "1943", 0.57, "contextual"),
        ],
    }
    return {
        "type": "FeatureCollection", "metadata": {"notice": "Fictional test data", "count": 1},
        "features": [build._to_feature(account)],
    }


def _account(dataset):
    return dataset["features"][0]["properties"]


def _decision(account, waypoint, action="approve"):
    return {
        "survivor_id": account["survivor_id"],
        "source_fingerprint": decisions.source_fingerprint(account, waypoint),
        "action": action, "reviewer": "Fictional reviewer (test only)",
        "reviewed_at": "2020-02-29", "source_url": account["archive_url"] + "#quotation",
        "rationale": "Synthetic fixture: checked the quotation, personal presence, date, role and coordinates.",
    }


def _document(*rows):
    return {"schema_version": decisions.DECISIONS_SCHEMA, "decisions": list(rows)}


def _write(path, document):
    path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    return path


def test_export_is_a_per_account_blank_worksheet_and_does_not_mutate_source(dataset):
    before = deepcopy(dataset)
    account = _account(dataset)
    worksheet = decisions.export_worksheet(dataset, account["survivor_id"])
    assert worksheet["schema_version"] == "ohp-review-worksheet/v1"
    assert worksheet["account"] == {key: account[key] for key in ("survivor_id", "name", "archive_url")}
    assert [(entry["collection"], entry["index"]) for entry in worksheet["entries"]] == [
        ("waypoints", 0), ("waypoints", 1), ("contextual_places", 0),
    ]
    assert len({entry["source_fingerprint"] for entry in worksheet["entries"]}) == 3
    for entry in worksheet["entries"]:
        assert set(entry["decision"]) == {"action", "reviewer", "reviewed_at", "source_url", "rationale"}
        assert all(value == "" for value in entry["decision"].values())
        assert entry["waypoint"] == account[entry["collection"]][entry["index"]]
    assert "trusted repository maintainer" in worksheet["instructions"]
    assert dataset == before
    worksheet["entries"][0]["waypoint"]["verified"] = True
    assert dataset == before
    with pytest.raises(decisions.ReviewError, match="separate"):
        decisions.validate_decisions(worksheet)


def test_unplaced_account_worksheet_has_no_invented_entries(dataset):
    account = _account(dataset)
    account["waypoints"] = []
    account["contextual_places"] = []
    dataset["features"][0]["geometry"] = None
    assert decisions.export_worksheet(dataset, account["survivor_id"])["entries"] == []


def test_browser_source_snapshot_exports_the_same_fingerprints_without_geometry_or_input_changes(dataset, files):
    account = _account(dataset)
    expected = decisions.export_worksheet(dataset, account["survivor_id"])
    snapshot = deepcopy(dataset)
    snapshot["features"][0]["geometry"] = None
    snapshot["metadata"] = {
        "source": "browser-profile-download", "content_revision": "fixture-revision",
        "exported_at": "2020-02-29T12:00:00Z", "notice": "Source for trusted human review, not an approval.",
    }
    before = deepcopy(snapshot)
    assert decisions.export_worksheet(snapshot, account["survivor_id"]) == expected
    source = _write(files / "browser-source.geojson", snapshot)
    source_bytes = source.read_bytes()
    worksheet = files / "worksheet.json"
    assert decisions.main([
        "export", "--dataset", str(source), "--survivor-id", account["survivor_id"],
        "--output", str(worksheet),
    ]) == 0
    assert json.loads(worksheet.read_text(encoding="utf-8")) == expected
    assert snapshot == before and source.read_bytes() == source_bytes


def test_browser_source_snapshot_also_supports_check_apply_without_overwriting_the_download(dataset, files):
    account = _account(dataset)
    dataset["features"][0]["geometry"] = None
    source = _write(files / "browser-source.geojson", dataset)
    source_bytes = source.read_bytes()
    file = _write(files / "decisions.json", _document(_decision(account, account["waypoints"][0])))
    assert decisions.main(["check", "--dataset", str(source), "--decisions", str(file)]) == 0
    output = files / "candidate.geojson"
    assert decisions.main([
        "apply", "--dataset", str(source), "--decisions", str(file), "--output", str(output),
    ]) == 0
    candidate = json.loads(output.read_text(encoding="utf-8"))
    assert candidate["features"][0]["geometry"]["coordinates"] == [21.0122, 52.2297]
    assert _account(candidate)["waypoints"][0]["verified"] is True
    assert _account(candidate)["review_status"] == "pending"
    assert source.read_bytes() == source_bytes
    assert validate.validate_geojson(candidate) == []


def test_browser_source_snapshot_cannot_omit_waypoint_coordinates(dataset, files):
    account = _account(dataset)
    dataset["features"][0]["geometry"] = None
    account["waypoints"][0].pop("lat")
    source = _write(files / "incomplete-source.geojson", dataset)
    before = source.read_bytes()
    output = files / "worksheet.json"
    assert decisions.main([
        "export", "--dataset", str(source), "--survivor-id", account["survivor_id"],
        "--output", str(output),
    ]) == 2
    assert not output.exists() and source.read_bytes() == before


def test_explicit_partial_approval_is_personal_but_account_remains_pending(dataset):
    account = _account(dataset)
    before = deepcopy(dataset)
    decision_file = _document(_decision(account, account["waypoints"][0]))
    decision_before = deepcopy(decision_file)
    candidate = decisions.apply_document(dataset, decision_file)
    result = _account(candidate)
    approved, pending = result["waypoints"]
    assert approved["verified"] is True
    assert approved["evidence"]["scope"] == "personal"
    assert approved["confidence"] == 0.42
    assert approved["source_quote"] == account["waypoints"][0]["source_quote"]
    assert approved["human_review"] == {
        **{key: value for key, value in decision_file["decisions"][0].items() if key != "survivor_id"},
        "original_collection": "waypoints",
        "original_evidence": account["waypoints"][0]["evidence"],
    }
    assert pending == account["waypoints"][1]
    assert result["contextual_places"] == account["contextual_places"]
    assert result["review_status"] == "pending"
    assert candidate["metadata"]["pending"] == 1
    assert decisions.apply_document(dataset, decision_file, strict=True)["features"] == []
    assert dataset == before and decision_file == decision_before
    assert validate.validate_geojson(candidate) == []


def test_all_route_approvals_qualify_for_strict_publication_without_promoting_context(dataset):
    account = _account(dataset)
    file = _document(*[_decision(account, wp) for wp in account["waypoints"]])
    candidate = decisions.apply_document(dataset, file, strict=True)
    assert _account(candidate)["review_status"] == "reviewed"
    assert candidate["metadata"]["count"] == candidate["metadata"]["reviewed"] == 1
    assert candidate["metadata"]["pending"] == 0
    assert _account(candidate)["contextual_places"] == account["contextual_places"]
    assert [wp["confidence"] for wp in _account(candidate)["waypoints"]] == [0.42, 0.66]
    assert validate.validate_geojson(candidate) == []


@pytest.mark.parametrize("action", ["context", "reject"])
def test_non_route_decisions_retain_testimony_and_explanation(dataset, action):
    account = _account(dataset)
    original = deepcopy(account["waypoints"][0])
    row = _decision(account, original, action)
    candidate = decisions.apply_document(dataset, _document(row))
    result = _account(candidate)
    assert len(result["waypoints"]) == 1
    retained = next(wp for wp in result["contextual_places"] if wp["canonical"] == original["canonical"])
    assert retained["verified"] is False and retained["evidence"]["scope"] == "contextual"
    assert retained["human_review"]["action"] == action
    assert retained["human_review"]["rationale"] == row["rationale"]
    assert retained["human_review"]["original_evidence"] == original["evidence"]
    for key in ("source_quote", "canonical", "as_written", "date", "lat", "lng", "confidence", "role"):
        assert retained[key] == original[key]
    assert result["review_status"] == "pending"
    assert candidate["features"][0]["geometry"]["coordinates"] == [-79.3832, 43.6532]
    assert validate.validate_geojson(candidate) == []


def test_all_rejected_route_claims_remain_discoverable_with_null_geometry(dataset):
    account = _account(dataset)
    file = _document(*[_decision(account, wp, "reject") for wp in account["waypoints"]])
    candidate = decisions.apply_document(dataset, file)
    assert len(candidate["features"]) == 1
    assert candidate["features"][0]["geometry"] is None
    assert _account(candidate)["waypoints"] == []
    assert len(_account(candidate)["contextual_places"]) == 3
    assert candidate["metadata"]["unplaced"] == candidate["metadata"]["pending"] == 1


def test_context_becomes_personal_only_with_an_explicit_personal_approval(dataset):
    account = _account(dataset)
    contextual = account["contextual_places"][0]
    candidate = decisions.apply_document(dataset, _document(_decision(account, contextual)))
    promoted = next(wp for wp in _account(candidate)["waypoints"] if wp["canonical"] == contextual["canonical"])
    assert promoted["verified"] is True and promoted["evidence"]["scope"] == "personal"
    assert promoted["human_review"]["original_collection"] == "contextual_places"
    assert promoted["confidence"] == contextual["confidence"]
    assert _account(candidate)["contextual_places"] == []
    assert _account(candidate)["review_status"] == "pending"


@pytest.mark.parametrize("point,extra", [
    ({"verified": False}, {}),
    ({"verified": "yes"}, {}),
    ({"verified": True, "evidence": {"scope": "uncertain"}}, {}),
    ({"verified": True, "evidence": {"scope": "contextual"}}, {}),
    ({"verified": True}, {"unplaced_waypoint_count": 1}),
])
def test_account_label_never_bypasses_actual_route_gate(point, extra):
    account = {"survivor_id": "fixture", "review_status": "reviewed", "waypoints": [point], **extra}
    assert review.stage([account])[0]["review_status"] == "pending"
    assert review.filter_published([account]) == []
    assert account["review_status"] == "reviewed"


def test_legacy_verified_routes_work_but_empty_reviewed_labels_do_not():
    assert review.stage([{"waypoints": [{"verified": True}]}])[0]["review_status"] == "reviewed"
    assert review.stage([{"waypoints": [], "review_status": "reviewed"}])[0]["review_status"] == "pending"


@pytest.mark.parametrize("field,value", [
    ("source_quote", "A changed fictional quotation."),
    ("canonical", "Warszawa, Poland"),
    ("as_written", "Warszawa"),
    ("role", "liberation"),
    ("date", {"start": "1943", "end": "1944", "precision": "range"}),
    ("lat", 52.22970001),
    ("lng", 21.01220001),
    ("location_precision", "region"),
    ("location_note", "A new qualification of the representative coordinates."),
    ("location_source_url", "https://example.test/changed-source"),
    ("location_coordinate_source_url", "https://example.test/changed-coordinate-source"),
])
def test_any_changed_source_identity_rejects_stale_approval(dataset, field, value):
    account = _account(dataset)
    file = _document(_decision(account, account["waypoints"][0]))
    account["waypoints"][0][field] = value
    before = deepcopy(dataset)
    with pytest.raises(decisions.ReviewError, match="stale"):
        decisions.apply_document(dataset, file)
    assert dataset == before


@pytest.mark.parametrize("field,value", [
    ("survivor_id", "different-fictional-account"),
    ("archive_url", "https://example.test/another-source"),
])
def test_account_and_archive_source_are_bound_to_fingerprint(dataset, field, value):
    account = _account(dataset)
    file = _document(_decision(account, account["waypoints"][0]))
    account[field] = value
    with pytest.raises(decisions.ReviewError, match="stale|Unknown account"):
        decisions.apply_document(dataset, file)


@pytest.mark.parametrize("actions", [
    ("approve", "approve", "context"),
    ("reject", "approve", "context"),
    ("context", "reject", "approve"),
])
def test_reapplication_is_idempotent_after_reclassification(dataset, actions):
    account = _account(dataset)
    points = account["waypoints"] + account["contextual_places"]
    file = _document(*[_decision(account, wp, action) for wp, action in zip(points, actions)])
    first = decisions.apply_document(dataset, file)
    second = decisions.apply_document(first, file)
    assert first == second
    assert decisions.apply_decisions([_account(first)], file) == [_account(first)]
    assert [wp["confidence"] for wp in points] == [0.42, 0.66, 0.57]


def test_explicit_replacement_can_revoke_approval_without_losing_original_evidence(dataset):
    account = _account(dataset)
    row = _decision(account, account["waypoints"][0])
    first = decisions.apply_document(dataset, _document(row))
    replacement = {**row, "action": "reject", "rationale": "Synthetic second review: not personal presence."}
    result = decisions.apply_document(first, _document(replacement))
    point = next(wp for wp in _account(result)["contextual_places"] if wp["canonical"] == "Warsaw, Poland")
    assert point["verified"] is False
    assert point["human_review"]["original_evidence"] == account["waypoints"][0]["evidence"]
    assert point["human_review"]["rationale"] == replacement["rationale"]
    assert decisions.apply_document(result, _document(replacement)) == result


@pytest.mark.parametrize("field,value", [
    ("reviewer", ""), ("reviewer", None), ("reviewer", {}), ("reviewer", "unknown"),
    ("reviewer", "  Fictional reviewer  "), ("reviewer", "First\nSecond"),
    ("reviewed_at", ""), ("reviewed_at", None), ("reviewed_at", "2020-02-30"),
    ("reviewed_at", "2020-2-01"), ("reviewed_at", "20200201"),
    ("reviewed_at", "2020-02-01T00:00:00Z"), ("reviewed_at", "2999-01-01"),
    ("source_url", ""), ("source_url", "relative-source"), ("source_url", "javascript:alert(1)"),
    ("source_url", "https://"), ("source_url", "file:///testimony"),
    ("source_url", "https://example.test:99999/path"), ("source_url", "https://example.test:wrong/path"),
    ("source_url", "https://user:password@example.test/path"), ("source_url", "https://example..test/path"),
    ("source_url", "https://example.test/a b"), ("source_url", "https://example.test/%wrong"),
    ("rationale", ""), ("rationale", None), ("action", ""), ("action", "accept"), ("action", True),
])
def test_malformed_decision_fields_fail_without_mutation(dataset, field, value):
    account = _account(dataset)
    row = _decision(account, account["waypoints"][0])
    row[field] = value
    before = deepcopy(dataset)
    with pytest.raises(decisions.ReviewError):
        decisions.apply_document(dataset, _document(row))
    assert dataset == before


@pytest.mark.parametrize("extra", [{"lat": 0}, {"date": "1945"}, {"canonical": "Other place"}, {"confidence": 1.0}])
def test_corrections_and_confidence_overrides_are_not_silently_accepted(dataset, extra):
    account = _account(dataset)
    row = {**_decision(account, account["waypoints"][0]), **extra}
    with pytest.raises(decisions.ReviewError, match="corrections are not supported"):
        decisions.apply_document(dataset, _document(row))


def test_missing_quote_cannot_be_approved_but_can_be_retained_as_context(dataset):
    account = _account(dataset)
    account["waypoints"][0]["source_quote"] = None
    row = _decision(account, account["waypoints"][0])
    with pytest.raises(decisions.ReviewError, match="requires a source quote"):
        decisions.apply_document(dataset, _document(row))
    result = decisions.apply_document(dataset, _document({**row, "action": "context"}))
    assert any(wp["source_quote"] is None for wp in _account(result)["contextual_places"])


def test_duplicate_decisions_and_ambiguous_source_points_fail_closed(dataset):
    account = _account(dataset)
    row = _decision(account, account["waypoints"][0])
    with pytest.raises(decisions.ReviewError, match="duplicates a decision"):
        decisions.apply_document(dataset, _document(row, row))
    account["waypoints"].append(deepcopy(account["waypoints"][0]))
    with pytest.raises(decisions.ReviewError, match="ambiguous duplicate"):
        decisions.apply_document(dataset, _document(row))
    worksheet = decisions.export_worksheet(dataset, account["survivor_id"])
    assert len(worksheet["entries"]) == 4
    assert "ambiguous duplicate" in worksheet["instructions"]
    assert all(not entry["decision"]["action"] for entry in worksheet["entries"])


@pytest.mark.parametrize("coordinate", [True, "52.2297", None, float("nan"), float("inf"), 91])
def test_fingerprint_rejects_invalid_coordinates(dataset, coordinate):
    account = _account(dataset)
    account["waypoints"][0]["lat"] = coordinate
    with pytest.raises(decisions.ReviewError, match="finite"):
        decisions.source_fingerprint(account, account["waypoints"][0])


def test_fingerprint_cross_language_contract_handles_unicode_and_numeric_identity(dataset):
    account = _account(dataset)
    waypoint = account["waypoints"][0]
    waypoint["source_quote"] = 'Synthetic “Łódź” test\nwith quote " and Unicode \u2028 separator.'
    waypoint["lat"], waypoint["lng"] = -0.0, 1e-8
    script = r"""
      const crypto = require('node:crypto'), fs = require('node:fs');
      const {account, wp} = JSON.parse(fs.readFileSync(0, 'utf8'));
      function float64hex(value) {
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setFloat64(0, value === 0 ? 0 : value, false);
        return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
      }
      const payload = [
        'ohp-waypoint/v1', account.survivor_id, account.archive_url,
        wp.as_written, wp.canonical, wp.role,
        [wp.date.start, wp.date.end, wp.date.precision, wp.date.as_written ?? null],
        wp.source_quote ?? null,
        [float64hex(wp.lat), float64hex(wp.lng), wp.location_precision ?? null,
         wp.location_note ?? null, wp.location_source_url ?? null,
         wp.location_coordinate_source_url ?? null],
      ];
      console.log('sha256:' + crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'));
    """
    result = subprocess.run(
        ["node", "-e", script], input=json.dumps({"account": account, "wp": waypoint}),
        capture_output=True, text=True, check=True, cwd=config.ROOT,
    )
    assert result.stdout.strip() == decisions.source_fingerprint(account, waypoint)
    before = decisions.source_fingerprint(account, waypoint)
    waypoint.update(verified=True, confidence=0.99, evidence={"scope": "personal"}, human_review={"note": "ignored"})
    assert decisions.source_fingerprint(account, waypoint) == before
    waypoint["lat"] = 0
    assert decisions.source_fingerprint(account, waypoint) == before


def test_cli_export_check_apply_and_repeat_only_write_requested_new_outputs(dataset, files):
    source = _write(files / "source.geojson", dataset)
    before = source.read_bytes()
    account = _account(dataset)
    worksheet = files / "worksheet.json"
    assert decisions.main(["export", "--dataset", str(source), "--survivor-id", account["survivor_id"],
                           "--output", str(worksheet)]) == 0
    exported = json.loads(worksheet.read_text(encoding="utf-8"))
    assert all(not entry["decision"]["action"] for entry in exported["entries"])
    file = _write(files / "decisions.json", _document(_decision(account, account["waypoints"][0])))
    decision_before = file.read_bytes()
    before_check = {path.name: path.read_bytes() for path in files.iterdir()}
    assert decisions.main(["check", "--dataset", str(source), "--decisions", str(file)]) == 0
    assert {path.name: path.read_bytes() for path in files.iterdir()} == before_check
    output = files / "candidate.geojson"
    assert decisions.main(["apply", "--dataset", str(source), "--decisions", str(file),
                           "--output", str(output)]) == 0
    repeated = files / "repeated.geojson"
    assert decisions.main(["apply", "--dataset", str(output), "--decisions", str(file),
                           "--output", str(repeated)]) == 0
    assert output.read_bytes() == repeated.read_bytes()
    assert source.read_bytes() == before and file.read_bytes() == decision_before
    assert {path.name for path in files.iterdir()} == {
        "source.geojson", "worksheet.json", "decisions.json", "candidate.geojson", "repeated.geojson",
    }


@pytest.mark.parametrize("invalid", ["stale", "malformed", "duplicate", "correction"])
def test_cli_invalid_batch_has_no_partial_output_or_source_changes(dataset, files, invalid):
    account = _account(dataset)
    first, second = [_decision(account, wp) for wp in account["waypoints"]]
    if invalid == "stale":
        second["source_fingerprint"] = "sha256:" + "0" * 64
    elif invalid == "malformed":
        second["reviewer"] = ""
    elif invalid == "duplicate":
        second = deepcopy(first)
    else:
        second["lat"] = 0
    source = _write(files / "source.geojson", dataset)
    file = _write(files / "decisions.json", _document(first, second))
    output = files / "candidate.geojson"
    originals = {path: path.read_bytes() for path in (source, file)}
    args = ["apply", "--dataset", str(source), "--decisions", str(file), "--output", str(output)]
    assert decisions.main(args) == 2
    assert not output.exists()
    output.write_text("Existing output must remain untouched.", encoding="utf-8")
    existing = output.read_bytes()
    assert decisions.main(args) == 2
    assert output.read_bytes() == existing
    assert all(path.read_bytes() == content for path, content in originals.items())
    assert decisions.main(["check", "--dataset", str(source), "--decisions", str(file)]) == 2


def test_cli_never_overwrites_input_or_existing_output_even_with_valid_decisions(dataset, files):
    account = _account(dataset)
    source = _write(files / "source.geojson", dataset)
    file = _write(files / "decisions.json", _document(_decision(account, account["waypoints"][0])))
    existing = files / "existing.json"
    existing.write_text("Do not overwrite.", encoding="utf-8")
    for output in (source, file, existing):
        before = output.read_bytes()
        assert decisions.main(["apply", "--dataset", str(source), "--decisions", str(file),
                               "--output", str(output)]) == 2
        assert output.read_bytes() == before


@pytest.mark.parametrize("raw", [
    '{"schema_version":"ohp-review-decisions/v1","decisions":[]}',
    '{"schema_version":"ohp-review-decisions/v1","decisions":[],"decisions":[]}',
    '{"schema_version":"ohp-review-decisions/v1","decisions":[NaN]}',
    '{"schema_version":"ohp-review-decisions/v1","decisions":[Infinity]}',
])
def test_invalid_json_and_empty_decisions_fail_without_outputs(dataset, files, raw):
    source = _write(files / "source.geojson", dataset)
    file = files / "decisions.json"
    file.write_text(raw, encoding="utf-8")
    output = files / "candidate.geojson"
    assert decisions.main(["apply", "--dataset", str(source), "--decisions", str(file),
                           "--output", str(output)]) == 2
    assert not output.exists()


@pytest.mark.parametrize("command", [[], ["export"], ["check"], ["apply"]])
def test_cli_help_is_available_without_inputs_or_side_effects(command):
    result = subprocess.run(
        [sys.executable, "-m", "pipeline.review_decisions", *command, "--help"],
        cwd=config.ROOT, capture_output=True, text=True, check=True,
    )
    assert "usage:" in result.stdout
    assert not result.stderr


def test_cli_process_has_nonzero_exit_status_on_stale_decisions(dataset, files):
    account = _account(dataset)
    row = _decision(account, account["waypoints"][0])
    row["source_fingerprint"] = "sha256:" + "0" * 64
    source = _write(files / "source.geojson", dataset)
    file = _write(files / "decisions.json", _document(row))
    output = files / "candidate.geojson"
    result = subprocess.run(
        [sys.executable, "-m", "pipeline.review_decisions", "apply", "--dataset", str(source),
         "--decisions", str(file), "--output", str(output)],
        cwd=config.ROOT, capture_output=True, text=True,
    )
    assert result.returncode == 2 and "stale" in result.stderr
    assert not output.exists()


def test_queue_remains_csv_json_compatible_and_does_not_requeue_current_human_decisions(dataset, files, monkeypatch):
    account = _account(dataset)
    candidate = decisions.apply_document(dataset, _document(
        _decision(account, account["waypoints"][0]),
        _decision(account, account["contextual_places"][0], "context"),
    ))
    monkeypatch.setattr(config, "REVIEW_DIR", files)
    assert review.emit_review_queue([_account(candidate)]) == 1
    rows = json.loads((files / "review_queue.json").read_text(encoding="utf-8"))
    assert rows[0]["canonical"] == "Toronto, Canada" and rows[0]["approved"] == ""
    with (files / "review_queue.csv").open(encoding="utf-8", newline="") as handle:
        csv_rows = list(csv.DictReader(handle))
    assert set(csv_rows[0]) == set(rows[0])
    assert csv_rows[0]["flag"] == "unverified"
    approved = _account(candidate)["waypoints"][0]
    approved["source_quote"] += " Changed after review."
    assert review._flag(approved, _account(candidate)) == "stale_review"


def test_stored_audit_cannot_keep_changed_high_confidence_claims_verified(dataset):
    account = _account(dataset)
    file = _document(*[_decision(account, wp) for wp in account["waypoints"]])
    reviewed = decisions.apply_document(dataset, file)
    changed = _account(reviewed)
    changed["waypoints"][0]["confidence"] = 0.99
    changed["waypoints"][0]["source_quote"] += " Changed since the recorded review."
    before = deepcopy(changed)
    assert review._flag(changed["waypoints"][0], changed) == "stale_review"
    staged = review.stage([changed])[0]
    assert staged["review_status"] == "pending"
    assert staged["waypoints"][0]["verified"] is False
    assert staged["waypoints"][0]["evidence"]["scope"] == "uncertain"
    assert staged["waypoints"][0]["confidence"] == 0.99
    assert staged["waypoints"][0]["human_review"] == changed["waypoints"][0]["human_review"]
    assert changed == before
    assert review.stage([changed], strict=True) == []
    with pytest.raises(decisions.ReviewError, match="stale"):
        decisions.apply_document(reviewed, file)


@pytest.mark.parametrize("audit", [None, {}, [], "not an audit"])
def test_malformed_stored_audit_cannot_verify_a_route(dataset, audit):
    account = _account(dataset)
    account["waypoints"] = [account["waypoints"][0]]
    account["waypoints"][0].update(verified=True, confidence=0.99, human_review=audit)
    candidate = review.stage([account])[0]
    assert candidate["review_status"] == "pending"
    assert candidate["waypoints"][0]["verified"] is False
    assert review._flag(account["waypoints"][0], account) == "invalid_review"


def test_new_source_review_does_not_inherit_an_obsolete_original_evidence_snapshot(dataset):
    account = _account(dataset)
    reviewed = decisions.apply_document(dataset, _document(_decision(account, account["waypoints"][0])))
    changed = _account(reviewed)
    changed["waypoints"][0]["source_quote"] += " A corrected fictional quotation."
    changed["waypoints"][0]["evidence"] = {"scope": "uncertain", "reason": "new-extraction-fixture"}
    new_decision = _decision(changed, changed["waypoints"][0])
    result = decisions.apply_document(reviewed, _document(new_decision))
    assert _account(result)["waypoints"][0]["human_review"]["original_evidence"] == {
        "scope": "uncertain", "reason": "new-extraction-fixture",
    }


def _mock_build(monkeypatch, dataset):
    source = deepcopy(_account(dataset))
    cache = {
        wp["canonical"]: {"lat": wp["lat"], "lng": wp["lng"], "precision": wp["location_precision"]}
        for key in decisions.COLLECTIONS for wp in source[key]
    }
    for key in decisions.COLLECTIONS:
        for wp in source[key]:
            wp.pop("lat")
            wp.pop("lng")
    writes = {"data": [], "queue": [], "cache": []}

    class Source:
        def fetch(self):
            return [deepcopy(source)]

    def emit_queue(records):
        writes["queue"].append(deepcopy(records))
        return sum(bool(review._flag(wp, account)) for account in records
                   for key in decisions.COLLECTIONS for wp in account[key])

    monkeypatch.setattr(build.ingest, "get_source", lambda name: Source())
    monkeypatch.setattr(build, "_record_to_survivor", lambda record, extractor: deepcopy(record))
    monkeypatch.setattr(build.geocode, "load_cache", lambda: deepcopy(cache))
    monkeypatch.setattr(build.geocode, "geocode", lambda canonical, cache, allow_network=False: cache.get(canonical))
    monkeypatch.setattr(build.geocode, "save_cache", lambda cache: writes["cache"].append(deepcopy(cache)))
    monkeypatch.setattr(build.review, "emit_review_queue", emit_queue)
    monkeypatch.setattr(build, "_write", lambda path, data: writes["data"].append((path, deepcopy(data))))
    return source, cache, writes


def _source_hashes():
    return {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in (
        config.SOURCE, config.OUT_GEOJSON, config.OUT_PLACE_INDEX, config.OUT_CONNECTIONS, config.GEOCODE_CACHE,
    )}


def test_build_replays_explicit_file_after_geocoding_without_mutating_source_inputs(dataset, files, monkeypatch):
    source, cache, writes = _mock_build(monkeypatch, dataset)
    placed = build._geocode_survivor(source, cache, False, [])
    decision_file = _write(files / "decisions.json", _document(
        *[_decision(placed, wp) for wp in placed["waypoints"]],
        _decision(placed, placed["contextual_places"][0], "context"),
    ))
    originals = _source_hashes()
    source_before = deepcopy(source)
    first = build.build(source_name="local", strict=True, review_decisions=decision_file)
    second = build.build(source_name="local", strict=True, review_decisions=decision_file)
    assert first == second
    assert first["metadata"]["reviewed"] == 1 and first["metadata"]["pending"] == 0
    assert all(wp["verified"] for wp in _account(first)["waypoints"])
    assert [wp["confidence"] for wp in _account(first)["waypoints"]] == [0.42, 0.66]
    assert len(writes["data"]) == 6 and len(writes["queue"]) == 2
    assert writes["cache"] == []
    assert source == source_before and _source_hashes() == originals
    assert validate.validate_geojson(first) == []


@pytest.mark.parametrize("invalid", ["stale", "malformed"])
def test_build_bad_decisions_write_no_queue_cache_or_publication(dataset, files, monkeypatch, invalid):
    source, cache, writes = _mock_build(monkeypatch, dataset)
    placed = build._geocode_survivor(source, cache, False, [])
    first, second = [_decision(placed, wp) for wp in placed["waypoints"]]
    if invalid == "stale":
        second["source_fingerprint"] = "sha256:" + "0" * 64
    else:
        second["reviewed_at"] = "2020-02-30"
    file = _write(files / "decisions.json", _document(first, second))
    originals = _source_hashes()
    with pytest.raises(decisions.ReviewError):
        build.build(source_name="local", allow_network=True, review_decisions=file)
    assert writes == {"data": [], "queue": [], "cache": []}
    assert _source_hashes() == originals


def test_build_keeps_unplaceable_claims_in_queue_and_prevents_false_whole_route_review(dataset, files, monkeypatch):
    source, cache, writes = _mock_build(monkeypatch, dataset)
    placed = build._geocode_survivor(source, cache, False, [])
    file = _write(files / "decisions.json", _document(
        *[_decision(placed, wp) for wp in placed["waypoints"]],
        _decision(placed, placed["contextual_places"][0], "context"),
    ))
    missing = deepcopy(source["waypoints"][0])
    missing.update(as_written="Unresolved test place", canonical="Unresolved test place")
    source["waypoints"].append(missing)
    candidate = build.build(source_name="local", review_decisions=file)
    assert _account(candidate)["review_status"] == "pending"
    assert _account(candidate)["unplaced_waypoint_count"] == 1
    assert missing in writes["queue"][0][0]["waypoints"]
    assert review.stage([_account(candidate)], strict=True) == []


def test_build_decisions_cannot_be_a_generated_output_path(monkeypatch):
    monkeypatch.setattr(build.decision_review, "load_decisions",
                        lambda path: pytest.fail("Must reject output/input alias before reading"))
    with pytest.raises(ValueError, match="distinct"):
        build.build(review_decisions=config.OUT_GEOJSON)


def test_build_rejects_output_hardlinks_without_overwriting_the_decision_file(files, monkeypatch):
    input_path = files / "decisions.json"
    input_path.write_text("This input must not be overwritten.", encoding="utf-8")
    output_path = files / "output.json"
    try:
        output_path.hardlink_to(input_path)
    except OSError:
        pytest.skip("This filesystem does not support creating hardlinks")
    monkeypatch.setattr(config, "OUT_GEOJSON", output_path)
    with pytest.raises(ValueError, match="distinct"):
        build.build(review_decisions=input_path)
    assert input_path.read_text(encoding="utf-8") == "This input must not be overwritten."
