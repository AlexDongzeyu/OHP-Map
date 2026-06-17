"""Waypoint ordering: journeys must read chronologically (doc 04)."""
from pipeline import derive


def test_order_is_chronological():
    wps = [
        {"as_written": "Auschwitz", "date": {"start": "1944", "end": "1944"}},
        {"as_written": "Lemberg", "date": {"start": "1925", "end": "1925"}},
        {"as_written": "Janowska", "date": {"start": "1943", "end": "1943"}},
    ]
    ordered = [w["as_written"] for w in derive.order_waypoints(wps)]
    assert ordered == ["Lemberg", "Janowska", "Auschwitz"]


def test_order_is_stable_for_equal_dates():
    wps = [
        {"as_written": "A", "date": {"start": "1944", "end": "1944"}},
        {"as_written": "B", "date": {"start": "1944", "end": "1944"}},
    ]
    ordered = [w["as_written"] for w in derive.order_waypoints(wps)]
    assert ordered == ["A", "B"]


def test_undated_stops_keep_their_place_among_dated_ones():
    # A leading undated birthplace should stay first (it inherits the next year),
    # and an undated final stop should stay last (it inherits the previous year).
    wps = [
        {"as_written": "Home", "role": "birthplace", "date": {"start": None, "end": None}},
        {"as_written": "Camp", "role": "camp", "date": {"start": "1943", "end": "1943"}},
        {"as_written": "Toronto", "role": "resettlement", "date": {"start": None, "end": None}},
    ]
    ordered = [w["as_written"] for w in derive.order_waypoints(wps)]
    assert ordered == ["Home", "Camp", "Toronto"]


def test_fully_undated_journey_falls_back_to_role_order():
    wps = [
        {"as_written": "Auschwitz", "role": "camp", "date": {"start": None, "end": None}},
        {"as_written": "Home", "role": "birthplace", "date": {"start": None, "end": None}},
        {"as_written": "Toronto", "role": "resettlement", "date": {"start": None, "end": None}},
    ]
    ordered = [w["as_written"] for w in derive.order_waypoints(wps)]
    assert ordered == ["Home", "Auschwitz", "Toronto"]
