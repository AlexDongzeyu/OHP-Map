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


def test_missing_dates_sort_last_without_crashing():
    wps = [
        {"as_written": "Unknown", "date": {"start": None, "end": None}},
        {"as_written": "Home", "date": {"start": "1930", "end": "1930"}},
    ]
    ordered = [w["as_written"] for w in derive.order_waypoints(wps)]
    assert ordered == ["Home", "Unknown"]
