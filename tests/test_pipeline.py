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
