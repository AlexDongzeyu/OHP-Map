"""Fuzzy-date helpers that drive the time scrubber (doc 01)."""
from pipeline import dates


def test_parse_year_formats():
    assert dates.parse_year("1944") == 1944
    assert dates.parse_year("1944-03") == 1944
    assert dates.parse_year("1944-03-21") == 1944
    assert dates.parse_year("winter 1944") == 1944
    assert dates.parse_year(None) is None
    assert dates.parse_year("no year here") is None


def test_year_span_handles_missing_and_reversed():
    assert dates.year_span({"start": "1942", "end": "1944"}) == (1942, 1944)
    assert dates.year_span({"start": "1944", "end": None}) == (1944, 1944)
    assert dates.year_span({"start": None, "end": "1945"}) == (1945, 1945)
    # reversed input is normalized
    assert dates.year_span({"start": "1945", "end": "1942"}) == (1942, 1945)
    assert dates.year_span(None) == (None, None)


def test_is_active_over_a_range():
    d = {"start": "1942", "end": "1944"}
    assert dates.is_active(d, 1942)
    assert dates.is_active(d, 1943)
    assert dates.is_active(d, 1944)
    assert not dates.is_active(d, 1941)
    assert not dates.is_active(d, 1945)


def test_overlap():
    a = {"start": "1942", "end": "1944"}
    b = {"start": "1943", "end": "1945"}
    assert dates.overlap(a, b) == (1943, 1944)
    c = {"start": "1946", "end": "1947"}
    assert dates.overlap(a, c) is None
