"""End-to-end build: the data that ships must be schema-valid and self-consistent."""
from pipeline import build, config, validate


def test_full_build_is_schema_valid():
    doc = build.build(source_name="local", extractor_name="offline")
    assert validate.validate_geojson(doc) == []
    assert doc["features"], "build produced no survivors"


def test_geojson_coordinate_order_is_lng_lat():
    doc = build.build(source_name="local", extractor_name="offline")
    for feat in doc["features"]:
        lng, lat = feat["geometry"]["coordinates"]
        assert -180 <= lng <= 180 and -90 <= lat <= 90
        # Europe/Canada longitudes are small or negative; latitudes are 40-60ish.
        assert lat > abs(lng) or lng < 0, "coordinates look swapped (lat/lng)"


def test_every_published_waypoint_is_verified_and_placed():
    doc = build.build(source_name="local", extractor_name="offline")
    for feat in doc["features"]:
        for wp in feat["properties"]["waypoints"]:
            assert wp["verified"] is True
            assert "lat" in wp and "lng" in wp
            assert wp["canonical"]


def test_connections_reference_real_survivors_and_are_verified():
    build.build(source_name="local", extractor_name="offline")
    import json
    survivors = {f["properties"]["survivor_id"]
                 for f in json.loads(config.OUT_GEOJSON.read_text(encoding="utf-8"))["features"]}
    conns = json.loads(config.OUT_CONNECTIONS.read_text(encoding="utf-8"))
    assert conns, "sample data should surface at least one verified connection"
    for c in conns:
        assert c["verified"] is True
        assert c["survivorA"] in survivors and c["survivorB"] in survivors
        assert c["survivorA"] != c["survivorB"]


def test_public_unplaced_profiles_are_published_without_invented_coordinates(monkeypatch):
    class Source:
        def fetch(self):
            return [
                {
                    "survivor_id": "public-unplaced-test", "name": "Public profile",
                    "archive_url": "https://ohp.crestwood.on.ca/ohp/public-unplaced-test/",
                    "text": "This public summary describes teaching and family memories.",
                    "group": "Community Members",
                },
                {
                    "survivor_id": "protected-test", "name": "Protected",
                    "archive_url": "https://ohp.crestwood.on.ca/ohp/protected-test/",
                    "text": "Enter a password.", "protected": True,
                },
            ]

    monkeypatch.setattr(build.ingest, "get_source", lambda name: Source())
    monkeypatch.setattr(build.review, "emit_review_queue", lambda records: 0)
    monkeypatch.setattr(build, "_write", lambda path, data: None)
    document = build.build(source_name="all")
    assert document["metadata"]["count"] == 1
    assert document["metadata"]["unplaced"] == 1
    feature = document["features"][0]
    assert feature["geometry"] is None
    assert feature["properties"]["waypoints"] == []
    assert feature["properties"]["review_status"] == "pending"
    assert feature["properties"]["bio_excerpt"].endswith(".")
    assert validate.validate_geojson(document) == []
    feature["geometry"] = {"type": "Point", "coordinates": [0, 0]}
    assert validate.validate_geojson(document)
