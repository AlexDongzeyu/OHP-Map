"""Derived artifacts: place index + verified connection layer (doc 02 section 4)."""
from pipeline import derive


def _feature(sid, waypoints):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0, 0]},
            "properties": {"survivor_id": sid, "waypoints": waypoints}}


def _wp(canonical, role, start, end, verified=True):
    return {"canonical": canonical, "role": role,
            "date": {"start": start, "end": end, "precision": "range"},
            "verified": verified}


def test_place_index_groups_survivors_by_place():
    feats = [
        _feature("a", [_wp("Auschwitz", "camp", "1944", "1944")]),
        _feature("b", [_wp("Auschwitz", "camp", "1944", "1944")]),
        _feature("c", [_wp("Krakow", "ghetto", "1941", "1942")]),
    ]
    idx = derive.build_place_index(feats)
    assert idx["Auschwitz"] == ["a", "b"]
    assert idx["Krakow"] == ["c"]


# Connections only form at real persecution sites listed in the gazetteer.
AUSCHWITZ = "Auschwitz (Oswiecim), Poland"


def test_connections_only_on_verified_overlap():
    feats = [
        _feature("a", [_wp(AUSCHWITZ, "camp", "1944", "1945")]),
        _feature("b", [_wp(AUSCHWITZ, "camp", "1944", "1944")]),
        _feature("c", [_wp(AUSCHWITZ, "camp", "1946", "1947")]),  # no time overlap
    ]
    conns = derive.build_connections(feats)
    pairs = {(c["survivorA"], c["survivorB"]) for c in conns}
    assert ("a", "b") in pairs
    assert ("a", "c") not in pairs and ("b", "c") not in pairs


def test_connection_verified_flag_reflects_both_endpoints():
    # Unverified waypoints still form a *candidate* connection, flagged verified=False.
    feats = [
        _feature("a", [_wp(AUSCHWITZ, "camp", "1944", "1944", verified=False)]),
        _feature("b", [_wp(AUSCHWITZ, "camp", "1944", "1944", verified=True)]),
    ]
    conns = derive.build_connections(feats)
    assert len(conns) == 1
    assert conns[0]["verified"] is False
    assert "unverified" in conns[0]["note"].lower()


def test_two_verified_waypoints_make_a_verified_connection():
    feats = [
        _feature("a", [_wp(AUSCHWITZ, "camp", "1944", "1944", verified=True)]),
        _feature("b", [_wp(AUSCHWITZ, "camp", "1944", "1944", verified=True)]),
    ]
    conns = derive.build_connections(feats)
    assert len(conns) == 1 and conns[0]["verified"] is True


def test_non_persecution_places_do_not_connect():
    # Two people both ending in Toronto is expected, not a coincidence.
    feats = [
        _feature("a", [_wp("Toronto, Canada", "resettlement", "1948", "1948")]),
        _feature("b", [_wp("Toronto, Canada", "resettlement", "1948", "1948")]),
    ]
    assert derive.build_connections(feats) == []
