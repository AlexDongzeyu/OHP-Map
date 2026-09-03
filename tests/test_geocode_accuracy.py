"""Geographic and semantic safeguards for the curated place system."""
import json

from pipeline import config, gazetteer, validate
from pipeline.extract import OfflineExtractor


UNSAFE_NATIONALITY_ALIASES = {
    "american", "austrian", "czech", "dutch", "english", "french",
    "galician", "german", "greek", "hungarian", "irish", "lithuanian",
    "polish", "romanian", "russian", "scottish",
}


def test_nationality_adjectives_are_not_treated_as_places():
    aliases = json.loads(config.GAZETTEER.read_text(encoding="utf-8"))["aliases"]
    assert UNSAFE_NATIONALITY_ALIASES.isdisjoint(aliases)


def test_nationality_descriptions_do_not_create_false_waypoints():
    text = (
        "She attended a French class during the German occupation, "
        "then met American troops, supported U.S. operations, and later taught English."
    )
    assert OfflineExtractor().extract(text) == []


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
