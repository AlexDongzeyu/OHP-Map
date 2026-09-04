"""Integrity checks for the sourced historical war context layer."""
import json

from pipeline import config


def _load():
    context = json.loads((config.DATA / "war_context.json").read_text(encoding="utf-8"))
    world = json.loads((config.DATA / "atlas-world.json").read_text(encoding="utf-8"))
    countries = {feature["properties"]["name"] for feature in world["features"]}
    return context, countries


def _at(context, year):
    matches = [
        period for period in context["periods"]
        if period["start"] <= year <= period["end"]
    ]
    assert len(matches) == 1
    return matches[0]


def test_historical_periods_cover_every_timeline_year_once():
    context, _ = _load()
    for year in range(1914, 2027):
        _at(context, year)


def test_every_status_country_exists_in_the_runtime_basemap():
    context, countries = _load()
    unknown = {
        country
        for period in context["periods"]
        for key in ("coalition", "opposition", "occupied")
        for country in period[key]
        if country not in countries
    }
    assert unknown == set()


def test_opposing_sides_never_overlap():
    context, _ = _load()
    for period in context["periods"]:
        assert set(period["coalition"]).isdisjoint(period["opposition"])


def test_key_war_years_have_expected_alignments():
    context, _ = _load()

    first_world_war = _at(context, 1917)
    assert "Canada" in first_world_war["coalition"]
    assert "United States of America" in first_world_war["coalition"]
    assert "Germany" in first_world_war["opposition"]

    second_world_war = _at(context, 1944)
    assert second_world_war["archive_conflict"] == "Second World War"
    assert "Canada" in second_world_war["coalition"]
    assert "Germany" in second_world_war["opposition"]
    assert {"Bulgaria", "Finland", "Romania"} <= set(second_world_war["opposition"])
    assert second_world_war["opposition_label"] == "Axis powers and co-belligerents"
    assert "Netherlands" in second_world_war["occupied"]

    opening_western_campaign = _at(context, 1940)
    assert "Bulgaria" not in opening_western_campaign["opposition"]

    continuation_war = _at(context, 1941)
    assert "Finland" in continuation_war["opposition"]
    assert continuation_war["opposition_label"] == "Axis powers and co-belligerents"

    korean_war = _at(context, 1951)
    assert korean_war["archive_conflict"] == "Korean War"
    assert "Canada" in korean_war["coalition"]
    assert "North Korea" in korean_war["opposition"]


def test_nonwar_periods_do_not_claim_belligerents():
    context, _ = _load()
    for year in (1925, 1948, 1955, 1989, 2026):
        period = _at(context, year)
        assert period["archive_conflict"] is None
        assert period["coalition"] == []
        assert period["opposition"] == []


def test_historical_topology_contains_dated_control_areas():
    topology = json.loads(
        (config.DATA / "historical_boundaries.json").read_text(encoding="utf-8"),
    )
    assert topology["type"] == "Topology"
    assert topology["metadata"]["source_license"] == "CC0"
    territories = topology["objects"]["territories"]["geometries"]
    assert len(territories) > 1000
    assert all(
        territory["properties"].get("name") and
        isinstance(territory["properties"].get("start"), (int, float))
        for territory in territories
    )
    controllers = {
        territory["properties"]["name"]: territory["properties"]["controller"]
        for territory in territories
    }
    assert controllers["Dominion of Canada"] == "Canada"
    assert controllers["British Raj"] == "United Kingdom"
    assert controllers["United States"] == "United States of America"
    assert controllers["United States of Venezuela"] == "United States of Venezuela"

    def names_at(year):
        instant = year + 0.5
        return {
            territory["properties"]["name"]
            for territory in territories
            if territory["properties"]["start"] <= instant and (
                territory["properties"]["end"] is None or
                territory["properties"]["end"] > instant
            )
        }

    assert {"Austria-Hungary", "German Reich", "Dominion of Canada"} <= names_at(1914)
    assert {"German Reich", "Soviet Union", "Canada"} <= names_at(1944)
    assert {"North Korea (1948-1953)", "South Korea"} <= names_at(1951)
    assert {"Canada", "Germany", "Russia", "Ukraine"} <= names_at(2026)


def test_historical_index_covers_every_year_and_marks_changes():
    index = json.loads(
        (config.DATA / "historical_boundary_index.json").read_text(encoding="utf-8"),
    )
    assert index["source_license"] == "CC0"
    assert [entry["year"] for entry in index["years"]] == list(range(1914, 2027))
    assert all(entry["active"] >= 140 for entry in index["years"])
    assert any(entry["changes"] >= 30 for entry in index["years"])


def test_representative_era_maps_are_lightweight_svg_assets():
    for year in (1914, 1944, 1960, 1991, 2026):
        path = config.ROOT / "assets" / "history" / f"atlas-{year}.svg"
        content = path.read_text(encoding="utf-8")
        assert content.startswith("<svg ")
        assert "Historical territory map" in content
        assert path.stat().st_size < 300_000
