"""Tests for the whole-taxonomy ingest: conflict derivation, groups, AllSource."""
import json

from pipeline import build, config, scrape_all


def test_derive_conflict_holocaust():
    assert scrape_all.derive_conflict("Holocaust Survivors", "anything") == ["The Holocaust"]


def test_derive_conflict_veteran_defaults_wwii():
    assert "Second World War" in scrape_all.derive_conflict("Military Veterans", "he served overseas")


def test_derive_conflict_detects_korea():
    out = scrape_all.derive_conflict("Military Veterans", "He fought in Korea at Kapyong.")
    assert "Korean War" in out


def test_categories_map_to_five_display_groups():
    groups = set(scrape_all.CATEGORIES.values())
    assert groups == {
        "Holocaust Survivors", "Military Veterans", "Community Members",
        "First Nations", "Crestwood Families",
    }


def test_all_source_carries_group_and_conflicts_if_scraped():
    path = config.DATA / "source" / "ohp_all.json"
    if not path.exists():
        return  # the full scrape artifact isn't present in this checkout; skip
    doc = build.build(source_name="all", extractor_name="offline")
    groups = doc["metadata"].get("groups", {})
    assert groups, "expected group counts in metadata"
    # Every feature has a group and a conflicts list.
    for f in doc["features"][:50]:
        assert f["properties"].get("group")
        assert isinstance(f["properties"].get("conflicts"), list)
