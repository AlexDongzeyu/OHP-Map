"""Geographic and semantic safeguards for the curated place system."""
import json
import re

from pipeline import config, gazetteer, validate
from pipeline.extract import OfflineExtractor


UNSAFE_NATIONALITY_ALIASES = {
    "american", "austrian", "czech", "dutch", "english", "french",
    "galician", "german", "greek", "hungarian", "irish", "lithuanian",
    "polish", "romanian", "russian", "scottish",
}


def test_nationality_adjectives_are_not_treated_as_places():
    document = json.loads(config.GAZETTEER.read_text(encoding="utf-8"))
    aliases = document["aliases"]
    assert UNSAFE_NATIONALITY_ALIASES.isdisjoint(aliases)
    assert len(document["revision"]) == 16


def test_nationality_descriptions_do_not_create_false_waypoints():
    text = (
        "She attended a French class during the German occupation, "
        "then met American troops, supported U.S. operations, and later taught English."
    )
    assert OfflineExtractor().extract(text) == []


def test_qualified_city_and_country_create_one_waypoint():
    waypoints = OfflineExtractor().extract(
        "He trained in Glasgow, Scotland, then served in Dublin, Ireland.",
    )
    assert [waypoint["as_written"] for waypoint in waypoints] == ["Glasgow", "Dublin"]


def test_separate_city_and_country_mentions_remain_distinct():
    waypoints = OfflineExtractor().extract(
        "He trained across Scotland before reporting to Glasgow.",
    )
    assert [waypoint["as_written"] for waypoint in waypoints] == ["Scotland", "Glasgow"]


def test_qualified_resettlement_city_keeps_birthplace_context():
    waypoints = OfflineExtractor().extract(
        "Alex was born in Vienna, Austria. His family later fled to Hungary.",
    )
    assert [
        (gazetteer.normalize(waypoint["as_written"]), waypoint["role"])
        for waypoint in waypoints
    ] == [("Vienna, Austria", "birthplace"), ("Hungary", "transit")]


def test_ambiguous_city_names_resolve_to_cities_not_regions_or_camps():
    assert gazetteer.normalize("Lublin") == "Lublin, Poland"
    assert gazetteer.normalize("Moscow") == "Moscow, Russia"
    assert gazetteer.normalize("Dublin") == "Dublin, Ireland"
    assert gazetteer.normalize("Glasgow") == "Glasgow, Scotland"
    assert gazetteer.normalize("New Glasgow") == "New Glasgow, Canada"


def test_country_geometry_guard_accepts_france_and_rejects_africa():
    assert validate.coordinate_country_error("France", 46.2276, 2.2137) is None
    assert validate.coordinate_country_error("France", 5.0, 20.0)
    assert validate.coordinate_country_error("Bratislava, Slovakia", 48.2082, 16.3738)


def test_every_country_qualified_cache_entry_passes_geometry_guard():
    cache = json.loads(config.GEOCODE_CACHE.read_text(encoding="utf-8"))
    errors = [
        error
        for canonical, record in cache.items()
        if canonical != "_about"
        for error in [
            validate.coordinate_country_error(
                canonical,
                record["lat"],
                record["lng"],
            )
        ]
        if error
    ]
    assert errors == []


def test_known_ambiguous_profiles_use_the_correct_places():
    document = json.loads(config.OUT_GEOJSON.read_text(encoding="utf-8"))
    gazetteer_revision = json.loads(
        config.GAZETTEER.read_text(encoding="utf-8"),
    )["revision"]
    assert document["metadata"]["gazetteer_revision"] == gazetteer_revision
    assert document["metadata"]["content_revision"] == config.CONTENT_REVISION
    features = {
        feature["properties"]["survivor_id"]: feature["properties"]
        for feature in document["features"]
    }
    fraser_places = {
        waypoint["canonical"] for waypoint in features["fraser-bill"]["waypoints"]
    }
    sever_places = {
        waypoint["canonical"] for waypoint in features["sever-dave"]["waypoints"]
    }
    assert fraser_places == {"New Glasgow, Canada"}
    assert "United States" not in sever_places
    for survivor_id in ("eisen-alex", "preger-george-2"):
        roles = {
            waypoint["canonical"]: waypoint["role"]
            for waypoint in features[survivor_id]["waypoints"]
        }
        assert roles["Vienna, Austria"] == "birthplace"


def test_published_data_has_no_qualified_country_route_legs():
    document = json.loads(config.OUT_GEOJSON.read_text(encoding="utf-8"))
    duplicates = []
    for feature in document["features"]:
        waypoints = feature["properties"]["waypoints"]
        cities = [waypoint for waypoint in waypoints if "," in waypoint["canonical"]]
        for country in (waypoint for waypoint in waypoints if "," not in waypoint["canonical"]):
            for city in cities:
                pattern = (
                    rf"\b{re.escape(city['as_written'])}\s*,\s*$"
                )
                quote = country.get("source_quote", "")
                country_matches = list(
                    re.finditer(rf"\b{re.escape(country['as_written'])}\b", quote, re.IGNORECASE),
                )
                if not country_matches:
                    continue
                if all(
                    re.search(pattern, quote[:match.start()], re.IGNORECASE)
                    for match in country_matches
                ):
                    duplicates.append(
                        (feature["properties"]["survivor_id"], city["canonical"], country["canonical"]),
                    )
    assert duplicates == []
