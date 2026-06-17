"""Date helpers for fuzzy testimony dates (doc 01 "the time scrubber").

Testimony dates are often vague ("the winter of '44"). We represent a waypoint as
active over a YEAR RANGE and never invent day-level precision. These helpers are
unit-tested (tests/test_dates.py) because the scrubber's correctness depends on them.
"""
from __future__ import annotations

import re


def parse_year(token: str | None) -> int | None:
    """Pull a 4-digit year out of 'YYYY', 'YYYY-MM', 'YYYY-MM-DD', or free text."""
    if not token:
        return None
    m = re.search(r"(1[89]\d\d|20\d\d)", str(token))
    return int(m.group(1)) if m else None


def year_span(date: dict | None) -> tuple[int | None, int | None]:
    """Return (start_year, end_year) for a waypoint date object."""
    if not date:
        return (None, None)
    start = parse_year(date.get("start"))
    end = parse_year(date.get("end")) or start
    if start is None:
        start = end
    if start is not None and end is not None and end < start:
        start, end = end, start
    return (start, end)


def is_active(date: dict | None, year: int) -> bool:
    """Is this waypoint 'active' in the given year? Inclusive of the fuzzy range."""
    start, end = year_span(date)
    if start is None:
        return False
    return start <= year <= (end if end is not None else start)


def overlap(a: dict | None, b: dict | None) -> tuple[int, int] | None:
    """Return the overlapping (start_year, end_year) of two date objects, or None."""
    a0, a1 = year_span(a)
    b0, b1 = year_span(b)
    if a0 is None or b0 is None:
        return None
    a1 = a1 if a1 is not None else a0
    b1 = b1 if b1 is not None else b0
    lo, hi = max(a0, b0), min(a1, b1)
    return (lo, hi) if lo <= hi else None
