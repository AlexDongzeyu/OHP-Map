"""Tests for the real-data path: scraper parsing, review staging, and the OHP build."""
import json

from pipeline import build, config, ingest, review, scrape_ohp


def test_scraper_parses_name_and_bio_from_cached_page():
    page = config.DATA / "source" / "pages_cache" / "carmelly-felicia.html"
    if not page.exists():
        return  # cache not present in this checkout; skip
    rec = scrape_ohp.parse_entry("carmelly-felicia", page.read_text(encoding="utf-8", errors="ignore"))
    assert rec["name"] == "Felicia Carmelly"  # "Carmelly, Felicia" -> "Felicia Carmelly"
    assert "Transnistria" in rec["text"]
    assert rec["archive_url"].endswith("/ohp/carmelly-felicia/")


def test_review_stage_labels_pending_vs_reviewed():
    survivors = [
        {"survivor_id": "p", "waypoints": [{"verified": False}, {"verified": True}]},
        {"survivor_id": "r", "waypoints": [{"verified": True}]},
        {"survivor_id": "empty", "waypoints": []},
    ]
    staged = {s["survivor_id"]: s for s in review.stage(survivors)}
    assert staged["p"]["review_status"] == "pending"
    assert staged["r"]["review_status"] == "reviewed"
    assert "empty" not in staged  # no placeable waypoints -> dropped


def test_review_stage_strict_drops_pending():
    survivors = [
        {"survivor_id": "p", "waypoints": [{"verified": False}]},
        {"survivor_id": "r", "waypoints": [{"verified": True}]},
    ]
    ids = {s["survivor_id"] for s in review.stage(survivors, strict=True)}
    assert ids == {"r"}


def test_ohp_build_is_schema_valid_and_populated():
    scraped = config.DATA / "source" / "ohp_scraped.json"
    if not scraped.exists():
        return  # scrape artifact not present; skip
    doc = build.build(source_name="ohp", extractor_name="offline")
    from pipeline import validate
    assert validate.validate_geojson(doc) == []
    assert doc["metadata"]["count"] > 50  # the real archive populates the map
    # Featured survivors are present and flagged.
    featured = [f for f in doc["features"] if f["properties"].get("featured")]
    assert any(f["properties"]["survivor_id"] == "baranek-martin" for f in featured)


def test_ohp_connections_are_labelled_candidates_not_assertions():
    if not (config.DATA / "source" / "ohp_scraped.json").exists():
        return
    build.build(source_name="ohp", extractor_name="offline")
    conns = json.loads(config.OUT_CONNECTIONS.read_text(encoding="utf-8"))
    for c in conns:
        if not c["verified"]:
            # Never assert two real people were together (doc 04 guardrail #3).
            assert "not a claim that they met" in c["note"]
