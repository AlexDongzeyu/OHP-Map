"""Bounded source claims: no guessed birthplaces, inherited years or ancestor routes."""
import copy
import json

import pytest

from pipeline import build, config, dates, extract, geocode, journey, review, validate
from test_worker_media import _worker


def _places(text, name=""):
    evidence = journey.extract_evidence(text, name)
    return {wp["as_written"]: wp for wp in evidence["waypoints"]}, evidence["contextual_places"]


def _source(slug):
    return next(
        record for record in json.loads(
            (config.DATA / "source" / "ohp_all.json").read_text(encoding="utf-8"),
        )["people"] if record["survivor_id"] == slug
    )


@pytest.mark.parametrize("origin", [
    "His father was born in England in 1916.",
    "Norm's parents hailed from Riegate, England and had emigrated to Canada before the Great War.",
    "Her mother, born in England in 1916, later worked in Canada.",
    "Norman Baker's father was born in England in 1916.",
])
def test_ancestor_origins_are_context_not_the_persons_birthplace(origin):
    places, contextual = _places(origin + " She was born September 1, 1940 in Toronto.")
    assert set(places) == {"Toronto"}
    assert places["Toronto"]["role"] == "birthplace"
    assert places["Toronto"]["date"] == {"start": "1940-09-01", "end": "1940-09-01", "precision": "day"}
    assert contextual and all(wp["evidence"]["scope"] == "contextual" for wp in contextual)
    assert contextual[0]["source_quote"] == origin


@pytest.mark.parametrize("text", [
    "He fled with his parents to France in 1941.",
    "She and her family escaped to France in 1941.",
    "His parents took him to France in 1941.",
    "Her parents escaped with her to France in 1941.",
])
def test_child_travelling_with_parents_is_personal_evidence(text):
    places, contextual = _places(text)
    assert list(places) == ["France"]
    assert places["France"]["evidence"]["scope"] == "personal"
    assert not contextual


@pytest.mark.parametrize(("text", "scope"), [
    ("His parents moved to France with David in 1937.", "personal"),
    ("David and his father moved to France in 1937.", "personal"),
    ("His father and David moved to France in 1937.", "personal"),
    ("His father took David to France in 1937.", "personal"),
    ("David's parents moved to France in 1937.", "contextual"),
    ("His parents moved to France with David's father in 1937.", "contextual"),
])
def test_named_family_participants_are_retained_without_possessive_false_positives(text, scope):
    expected = journey.extract_evidence(text, "David")
    actual = _worker("""
      console.log(JSON.stringify(worker.extractEvidence(payload.text, payload.name)));
    """, {"text": text, "name": "David"})
    for field in ("waypoints", "contextual_places"):
        for place in actual[field]:
            assert place.pop("canonical") == journey.gazetteer.normalize(place["as_written"])
    assert actual == expected
    field = "waypoints" if scope == "personal" else "contextual_places"
    assert expected[field][0]["as_written"] == "France"
    assert expected[field][0]["evidence"]["scope"] == scope


def test_family_membership_is_not_guessed_or_discarded():
    places, contextual = _places("His family later fled to Hungary.")
    assert places["Hungary"]["evidence"]["scope"] == "uncertain"
    assert not contextual
    places, contextual = _places("His wife was born in England in 1940.")
    assert places["England"]["evidence"]["scope"] == "uncertain"
    assert places["England"]["role"] != "birthplace"
    assert not contextual


@pytest.mark.parametrize(("name", "text", "place"), [
    ("Bernard Mussmand", "When his father became concerned about the state of affairs in Germany, the family moved to southern France.", "France"),
    ("Judith Nemes Black", "While her father was dealing with difficult conditions, Judith and her mother were forced into the Budapest ghetto.", "Budapest ghetto"),
    ("Judith Nemes Black", "Judith recalls that she loved her new nation, but her parents were looking for different opportunities, and the family moved again, this time to Canada.", "Canada"),
])
def test_ancestor_clause_does_not_discard_a_compound_family_journey(name, text, place):
    places, contextual = _places(text, name)
    assert place in places
    assert places[place]["evidence"]["scope"] in {"personal", "uncertain"}
    assert not any(wp["as_written"] == place for wp in contextual)


@pytest.mark.parametrize(("literal", "start", "precision"), [
    ("September 1, 1916", "1916-09-01", "day"),
    ("1 September 1916", "1916-09-01", "day"),
    ("Sept. 1st, 1916", "1916-09-01", "day"),
    ("September 1916", "1916-09", "month"),
    ("1916", "1916", "year"),
])
def test_literal_birth_dates_keep_source_precision(literal, start, precision):
    evidence = journey.extract_evidence(f"Mr. Baker was born {literal} in Toronto.", "Norman Baker")
    assert evidence["birth_year"] == 1916
    assert evidence["birth_date"]["start"] == start
    assert evidence["birth_date"]["precision"] == precision
    assert evidence["waypoints"][0]["date"] == evidence["birth_date"]


def test_post_1960_year_and_unrelated_birth_year_are_clause_bound():
    places, _ = _places(
        "He was born in Toronto in 1940 and moved to Ottawa in 1962. "
        "He later visited France. In 2004 he settled in Glasgow.",
    )
    assert places["Toronto"]["date"]["start"] == "1940"
    assert places["Ottawa"]["date"]["start"] == "1962"
    assert places["France"]["date"]["start"] is None
    assert places["Glasgow"]["date"]["start"] == "2004"
    assert places["Glasgow"]["role"] == "resettlement"


def test_neighboring_date_is_not_spread_to_another_place_in_the_same_sentence():
    places, _ = _places(
        "In 1944 he was born in Toronto, but he later went to France before moving to Canada.",
    )
    assert places["Toronto"]["date"]["start"] == "1944"
    assert all(places[name]["date"]["start"] is None for name in ("France", "Canada"))
    assert all(places[name]["role"] != "birthplace" for name in ("France", "Canada"))


def test_birth_year_is_not_attached_to_a_later_childhood_place_or_negated_birth():
    places, _ = _places("He was born in 1940 and grew up in Toronto.")
    assert places["Toronto"]["role"] == "resettlement"
    assert places["Toronto"]["date"]["start"] is None
    places, _ = _places("He was born near Toronto in 1940.")
    assert places["Toronto"]["role"] != "birthplace"
    assert places["Toronto"]["date"]["start"] is None
    evidence = journey.extract_evidence("He was not born in Toronto in 1940.")
    assert evidence["birth_year"] is None
    assert evidence["waypoints"][0]["role"] != "birthplace"


def test_full_decades_are_ranges_and_shorthand_decades_remain_unknown():
    places, _ = _places("He lived in Glasgow in the early 1960s. He moved to Ottawa as the 80s began.")
    assert places["Glasgow"]["date"] == {
        "start": "1960", "end": "1969", "precision": "range", "as_written": "early 1960s",
    }
    assert places["Ottawa"]["date"] == dates.unknown_date("80s")
    assert dates.date_mentions("around 1965")[0][2] == dates.unknown_date("around 1965")
    assert dates.date_mentions("February 30, 1944")[0][2]["precision"] == "unknown"


def test_no_unsupported_first_birthplace_or_country_based_settlement():
    places, _ = _places("She visited England and Canada. She settled in Glasgow in 1972.")
    assert places["England"]["role"] == places["Canada"]["role"] == "transit"
    assert places["Glasgow"]["role"] == "resettlement"
    assert not any(wp["role"] == "birthplace" for wp in places.values())


def test_clear_historical_and_comparison_mentions_do_not_become_route_legs():
    places, contextual = _places(
        "Germany invaded Poland in 1939. Unlike England, he found Canada welcoming. "
        "He fled to France in 1940.",
    )
    assert set(places) == {"Canada", "France"}
    assert {wp["as_written"] for wp in contextual} == {"Germany", "Poland", "England"}
    assert all(wp["source_quote"] for wp in contextual)


def test_norman_baker_birth_is_toronto_not_his_parents_england():
    record = _source("baker-norman")
    survivor = build._record_to_survivor(record, extract.OfflineExtractor())
    placed = build._geocode_survivor(survivor, geocode.load_cache(), False, [])
    feature = build._to_feature(placed)
    births = [wp for wp in placed["waypoints"] if wp["role"] == "birthplace"]
    assert [(wp["canonical"], wp["date"]["start"]) for wp in births] == [("Toronto, Canada", "1916-09-01")]
    assert placed["birth_year"] == 1916
    assert "First World War" not in placed["conflicts"]
    assert all(wp["canonical"] != "England" for wp in placed["waypoints"])
    assert any(wp["canonical"] == "England" for wp in placed["contextual_places"])
    assert feature["geometry"]["coordinates"] == [births[0]["lng"], births[0]["lat"]]
    assert births[0]["location_precision"] == "city"


def test_ancestor_only_profile_keeps_evidence_without_an_invented_map_anchor():
    survivor = build._record_to_survivor({
        "survivor_id": "context-only-test", "name": "Context Only",
        "archive_url": "https://ohp.crestwood.on.ca/ohp/context-only-test/",
        "text": "His father was born in England in 1916.", "group": "Community Members",
    }, extract.OfflineExtractor())
    survivor = build._geocode_survivor(survivor, geocode.load_cache(), False, [])
    feature = build._to_feature(survivor)
    assert feature["geometry"] is None
    assert survivor["waypoints"] == []
    assert survivor["contextual_places"][0]["evidence"]["scope"] == "contextual"
    assert "location_precision" in survivor["contextual_places"][0]
    assert validate.validate_geojson({"type": "FeatureCollection", "features": [feature]}) == []


def test_cache_provenance_is_shared_by_pipeline_worker_and_existing_live_rows():
    record = {
        "survivor_id": "location-provenance-test", "name": "Example Person",
        "archive_url": "https://ohp.crestwood.on.ca/ohp/location-provenance-test/",
        "group": "Military Veterans", "profile_media": {"images": [], "videos": []},
        "text": (
            "He visited Juno Beach in 1962. His father was born in Great Britain in 1902. "
            "He later moved to Canada."
        ),
    }
    cache = geocode.load_cache()
    survivor = build._geocode_survivor(
        build._record_to_survivor(record, extract.OfflineExtractor()), cache, False, [],
    )
    actual = _worker("""
      const feature = worker.toFeature(payload);
      const cached = {
        metadata: {gazetteer_revision: worker.GAZETTEER_REVISION, content_revision: worker.CONTENT_REVISION,
          time_min: worker.HISTORY_MIN_YEAR, time_max: worker.HISTORY_MAX_YEAR},
        features: [{
          ...feature, properties: {...feature.properties,
            waypoints: feature.properties.waypoints.map((wp) => ({
              ...wp, location_note: 'Obsolete note', location_source_url: 'https://example.test/obsolete',
            })),
            contextual_places: feature.properties.contextual_places.map((wp) => {
              const {location_note, location_source_url, location_coordinate_source_url, ...old} = wp;
              return old;
            }),
          },
        }],
      };
      let writes = 0;
      const env = {OHP_DATA: {put: async () => {writes++;}}};
      const migrated = await worker.ensureCurrentData(env, cached);
      const unchanged = await worker.ensureCurrentData(env, migrated);
      console.log(JSON.stringify({feature, migrated, writes, unchanged: unchanged === migrated}));
    """, record)
    for key in ("waypoints", "contextual_places"):
        assert actual["feature"]["properties"][key] == survivor[key]
        assert actual["migrated"]["features"][0]["properties"][key] == survivor[key]
        for waypoint in survivor[key]:
            entry = cache[waypoint["canonical"]]
            for output, source in (
                ("location_precision", "precision"), ("location_note", "note"),
                ("location_source_url", "source_url"), ("location_coordinate_source_url", "coordinate_source_url"),
            ):
                assert waypoint.get(output) == entry.get(source)
    assert actual["writes"] == 1
    assert actual["unchanged"] is True
    assert survivor["waypoints"][0]["canonical"] == "Juno Beach, France"
    assert survivor["waypoints"][0]["location_precision"] == "region"
    assert survivor["contextual_places"][0]["canonical"] == "Great Britain"
    assert "not a synonym for England" in survivor["contextual_places"][0]["location_note"]


def test_reviewed_location_annotations_are_preserved_when_cache_metadata_is_added():
    record = {
        "survivor_id": "reviewed-provenance-test", "name": "Reviewed person", "review_status": "reviewed",
        "archive_url": "https://ohp.crestwood.on.ca/ohp/reviewed-provenance-test/",
        "waypoints": [{
            "as_written": "Juno Beach", "canonical": "Juno Beach, France", "role": "transit",
            "date": dates.unknown_date(), "verified": True, "confidence": 1,
            "location_note": "Reviewer's qualified location statement.",
            "location_source_url": "https://example.test/reviewed-source",
        }],
    }
    survivor = build._geocode_survivor(
        build._record_to_survivor(record, extract.OfflineExtractor()), geocode.load_cache(), False, [],
    )
    result = _worker("""
      const cached = {
        metadata: {gazetteer_revision: worker.GAZETTEER_REVISION, content_revision: worker.CONTENT_REVISION,
          time_min: worker.HISTORY_MIN_YEAR, time_max: worker.HISTORY_MAX_YEAR},
        features: [{type: 'Feature', geometry: null, properties: payload}],
      };
      const updated = await worker.ensureCurrentData({OHP_DATA: {put: async () => {}}}, cached);
      console.log(JSON.stringify(updated.features[0].properties.waypoints[0]));
    """, record)
    for waypoint in (survivor["waypoints"][0], result):
        assert waypoint["location_note"] == record["waypoints"][0]["location_note"]
        assert waypoint["location_source_url"] == record["waypoints"][0]["location_source_url"]
        assert waypoint["location_precision"] == geocode.load_cache()["Juno Beach, France"]["precision"]


def test_wally_adams_own_cold_war_service_is_not_his_fathers_world_war():
    record = _source("adam-wally")
    evidence = journey.extract_evidence(record["text"], record["name"])
    places = {wp["as_written"]: wp for wp in evidence["waypoints"]}
    assert journey.derive_conflicts(record["group"], record["text"], record["name"]) == ["Cold War"]
    assert evidence["birth_year"] is None
    assert places["Winnipeg"]["role"] == "birthplace"
    assert places["Winnipeg"]["date"]["precision"] == "unknown"
    assert places["Ottawa"]["date"] == dates.unknown_date("80s")


def test_source_documented_birth_in_a_camp_is_not_overridden_by_site_taxonomy():
    survivor = build._record_to_survivor(_source("orosz-angela"), extract.OfflineExtractor())
    survivor = build._geocode_survivor(survivor, geocode.load_cache(), False, [])
    births = [wp for wp in survivor["waypoints"] if wp["role"] == "birthplace"]
    assert [(wp["canonical"], wp["date"]["start"]) for wp in births] == [
        ("Birkenau (Auschwitz II), Poland", "1944-12-21"),
    ]
    assert validate.validate_geojson({"type": "FeatureCollection", "features": [build._to_feature(survivor)]}) == []


def test_reviewed_and_curated_claims_are_not_rewritten_by_automatic_rules():
    record = {
        "survivor_id": "reviewed-test", "name": "Reviewed person", "review_status": "reviewed",
        "birth_year": 1902, "conflicts": ["Reviewed conflict"], "text": "Her father came from England.",
        "waypoints": [{
            "as_written": "England", "canonical": "England", "role": "birthplace",
            "date": {"start": "1902", "end": "1902", "precision": "year"},
            "lat": 51, "lng": 0, "source_quote": "Human-reviewed source", "verified": True, "confidence": 1,
        }],
    }
    original = copy.deepcopy(record)
    survivor = build._record_to_survivor(record, extract.OfflineExtractor())
    survivor = review.stage([build._geocode_survivor(survivor, geocode.load_cache(), False, [])])[0]
    assert record == original
    assert survivor["review_status"] == "reviewed"
    assert survivor["birth_year"] == 1902 and survivor["conflicts"] == ["Reviewed conflict"]
    assert {key: value for key, value in survivor["waypoints"][0].items() if key != "location_precision"} == original["waypoints"][0]
    curated = {**record, "review_status": "pending", "waypoints": [{**record["waypoints"][0], "verified": False}]}
    result = build._record_to_survivor(curated, extract.OfflineExtractor())
    assert result["waypoints"][0]["role"] == "birthplace"
    assert result["waypoints"][0]["evidence"]["scope"] == "uncertain"
    unplaced = {**record, "waypoints": [], "text": "He was born in Toronto in 1940."}
    assert build._record_to_survivor(unplaced, extract.OfflineExtractor())["waypoints"] == []


def test_worker_matches_pipeline_evidence_for_regressions_and_source_examples():
    cases = [
        {"name": "", "text": "His father was born in England in 1916. He was born Sept. 1st, 1940 in Toronto."},
        {"name": "", "text": "His parents took him to France in 1941."},
        {"name": "", "text": "He was born in Toronto in 1940 and moved to Ottawa in 1962. He later visited London."},
        {"name": "", "text": "He lived in Glasgow in the early 1960s. He moved to Ottawa as the 80s began."},
        {"name": "", "text": "Germany invaded Poland in 1939. Unlike England, he found Canada welcoming."},
        {"name": "", "text": "He was born in Łódź in 1924."},
        _source("baker-norman"), _source("adam-wally"), _source("black-judith"), _source("bernard-mussmand"),
    ]
    results = _worker("""
      console.log(JSON.stringify(payload.map((record) => {
        const evidence = worker.extractEvidence(record.text, record.name);
        for (const key of ['waypoints', 'contextual_places']) {
          evidence[key] = evidence[key].map(({canonical, ...waypoint}) => waypoint);
        }
        return {evidence, conflicts: worker.deriveConflicts(record.group || 'Military Veterans', record.text, record.name)};
      })));
    """, cases)
    for case, result in zip(cases, results):
        assert result["evidence"] == journey.extract_evidence(case["text"], case["name"])
        assert result["conflicts"] == journey.derive_conflicts(case.get("group", "Military Veterans"), case["text"], case["name"])


def test_worker_migrates_evidence_revision_without_overwriting_reviewed_records():
    result = _worker("""
      const oldWaypoint = {
        as_written: 'England', canonical: 'England', role: 'birthplace',
        lat: 52.3555, lng: -1.1743, confidence: 0.5, verified: false,
        date: {start: '1944', end: '1944', precision: 'year'},
        source_quote: 'His parents came from England.',
      };
      const old = (id, review = false, verified = false) => ({
        type: 'Feature', geometry: {type: 'Point', coordinates: [-1.1743, 52.3555]},
        properties: {survivor_id: id, name: id, review_status: review ? 'reviewed' : 'pending',
          birth_year: 1944, conflicts: ['First World War'], waypoints: [{...oldWaypoint, verified}]},
      });
      const cached = {metadata: {gazetteer_revision: worker.GAZETTEER_REVISION, content_revision: 'old'}, features: [
        old('unreviewed'), old('reviewed', true), old('part-reviewed', false, true),
      ]};
      const seed = {features: cached.features.map((feature) => worker.toFeature({
        survivor_id: feature.properties.survivor_id, name: 'Norman Baker', group: 'Military Veterans',
        text: 'His parents came from England. Norman Baker was born September 1, 1916 in Toronto.',
        archive_url: 'https://ohp.crestwood.on.ca/ohp/baker-norman/',
        profile_media: {images: [], videos: []},
      }))};
      console.log(JSON.stringify({cached, seed, migrated: worker.migrateCachedData(cached, seed)}));
    """)
    fresh = result["migrated"]["features"][0]
    assert fresh["geometry"] == result["seed"]["features"][0]["geometry"]
    assert fresh["properties"]["birth_year"] == 1916
    assert fresh["properties"]["waypoints"][0]["canonical"] == "Toronto, Canada"
    assert fresh["properties"]["contextual_places"][0]["canonical"] == "England"
    for old, new in zip(result["cached"]["features"][1:], result["migrated"]["features"][1:]):
        assert old["geometry"] == new["geometry"]
        assert old["properties"]["birth_year"] == new["properties"]["birth_year"]
        assert {k: v for k, v in new["properties"]["waypoints"][0].items() if k != "location_precision"} == old["properties"]["waypoints"][0]
    for feature in result["migrated"]["features"]:
        assert all("location_precision" in wp for wp in feature["properties"]["waypoints"])
