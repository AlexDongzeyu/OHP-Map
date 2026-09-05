import json
from math import atan2, cos, radians, sin, sqrt

from pipeline import config, gazetteer
from tools.build_gazetteer import PLACES, location_precision


def test_country_and_region_references_are_not_labelled_as_cities():
    for name in ("Canada", "France", "Germany", "Tanzania", "Kenya", "United Kingdom"):
        assert location_precision(name, PLACES[name]) == "country"
    for name in ("Normandy, France", "Korea", "Palestine (historical region)", "Soviet Union (historical region)"):
        assert location_precision(name, PLACES[name]) == "region"
    assert location_precision("Aldershot, England", PLACES["Aldershot, England"]) == "city"
    assert location_precision("Treblinka, Poland", PLACES["Treblinka, Poland"]) == "site"


def test_distinct_towns_camps_and_battle_regions_have_distinct_canonical_names():
    gazetteer._load.cache_clear()
    expected = {
        "Birkenau": "Birkenau (Auschwitz II), Poland",
        "Auschwitz": "Auschwitz (Oswiecim), Poland",
        "Oświęcim": "Oswiecim, Poland",
        "Waterloo, Quebec": "Waterloo, Quebec, Canada",
        "University of Waterloo": "Waterloo, Ontario, Canada",
        "Falaise": "Falaise, France",
        "Falaise Pocket": "Falaise Pocket, France",
        "Juno Beach": "Juno Beach, France",
        "Scheldt": "Scheldt estuary",
        "Palestine": "Palestine (historical region)",
        "United Kingdom": "United Kingdom",
        "Soviet Union": "Soviet Union (historical region)",
    }
    for text, canonical in expected.items():
        assert gazetteer.normalize(text) == canonical
    assert gazetteer.normalize("Dora") is None
    assert gazetteer.normalize("D-Day") is None
    assert gazetteer.normalize("Waterloo") is None


def _distance(a, b):
    lat0, lat1 = radians(a["lat"]), radians(b["lat"])
    dlat, dlng = lat1 - lat0, radians(b["lng"] - a["lng"])
    h = sin(dlat / 2) ** 2 + cos(lat0) * cos(lat1) * sin(dlng / 2) ** 2
    return 6371.0088 * 2 * atan2(sqrt(h), sqrt(1 - h))


def test_previously_conflated_coordinates_are_meaningfully_separate():
    assert _distance(PLACES["Falaise, France"], PLACES["Caen, France"]) > 25
    assert _distance(PLACES["Waterloo, Quebec, Canada"], PLACES["Kitchener, Canada"]) > 500
    assert _distance(PLACES["Birkenau (Auschwitz II), Poland"], PLACES["Auschwitz (Oswiecim), Poland"]) > 1.5
    assert _distance(PLACES["Juno Beach, France"], PLACES["Normandy, France"]) > 10


def test_generated_precision_and_new_sources_match_the_curated_table():
    cache = json.loads(config.GEOCODE_CACHE.read_text(encoding="utf-8"))
    assert set(cache) - {"_about"} == set(PLACES)
    for name, place in PLACES.items():
        assert cache[name]["precision"] == location_precision(name, place)
    for name in ("Falaise, France", "Waterloo, Quebec, Canada", "Waterloo, Ontario, Canada", "Birkenau (Auschwitz II), Poland"):
        assert cache[name]["source_url"].startswith("https://")
