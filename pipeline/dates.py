"""Date helpers for fuzzy testimony dates (doc 01 "the time scrubber").

Testimony dates are often vague ("the winter of '44"). Explicit calendar precision
is retained; fuzzy years and unknown centuries never acquire an invented day/year.
Year-range helpers remain available to the scrubber.
"""
from __future__ import annotations

import re
from datetime import date as calendar_date


_YEAR = r"(?:1[6-9]\d{2}|20\d{2})"
_MONTH = (
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
    r"Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?"
)
_MONTHS = {name: index for index, name in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1,
)}
_DATE_TOKEN = re.compile(
    rf"\b(?P<mdy>(?P<m1>{_MONTH})\s+(?P<d1>\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s+(?P<y1>{_YEAR}))\b"
    rf"|\b(?P<dmy>(?P<d2>\d{{1,2}})(?:st|nd|rd|th)?\s+(?P<m2>{_MONTH})\s*,?\s+(?P<y2>{_YEAR}))\b"
    rf"|\b(?P<month>(?P<m3>{_MONTH})\s+(?P<y3>{_YEAR}))\b"
    rf"|\b(?P<range>(?P<y4>{_YEAR})\s*(?:[-–—]|to)\s*(?P<y5>{_YEAR}|\d{{1,2}}))\b"
    rf"|\b(?P<decade>{_YEAR})['’]?s\b"
    rf"|\b(?P<year>{_YEAR})\b"
    r"|(?<!\w)(?P<shorthand>['’]?\d{2}['’]?s)\b",
    re.I,
)


def unknown_date(as_written: str | None = None) -> dict:
    value = {"start": None, "end": None, "precision": "unknown"}
    if as_written:
        value["as_written"] = as_written
    return value


def date_mentions(text: str) -> list[tuple[int, int, dict]]:
    """Read literal calendar dates/ranges; a shorthand decade has no assumed century."""
    results = []
    for match in _DATE_TOKEN.finditer(text):
        literal = match.group(0)
        value = unknown_date(literal)
        if match["mdy"] or match["dmy"]:
            suffix = "1" if match["mdy"] else "2"
            year, month, day = int(match[f"y{suffix}"]), _MONTHS[match[f"m{suffix}"][:3].lower()], int(match[f"d{suffix}"])
            try:
                token = calendar_date(year, month, day).isoformat()
                value = {"start": token, "end": token, "precision": "day"}
            except ValueError:
                pass
        elif match["month"]:
            token = f"{match['y3']}-{_MONTHS[match['m3'][:3].lower()]:02}"
            value = {"start": token, "end": token, "precision": "month"}
        elif match["range"]:
            start, tail = match["y4"], match["y5"]
            end = tail if len(tail) == 4 else start[:-len(tail)] + tail
            if int(end) >= int(start):
                value = {"start": start, "end": end, "precision": "range"}
        elif match["decade"]:
            year = int(match["decade"])
            if year % 10 == 0:
                value = {"start": str(year), "end": str(year + 9), "precision": "range", "as_written": literal}
        elif match["year"]:
            token = match["year"]
            value = {"start": token, "end": token, "precision": "year"}
        qualifier = re.search(r"\b(before|after|until|since|about|around|circa|approximately|early|late|mid)\s*$", text[:match.start()], re.I)
        if qualifier:
            # An open/fuzzy bound is not an assertion that the event occurred in that year.
            literal = text[qualifier.start():match.end()]
            value = {**value, "as_written": literal} if match["decade"] and qualifier[1].lower() in {"early", "late", "mid"} else unknown_date(literal)
        results.append((match.start(), match.end(), value))
    return results


def parse_year(token: str | None) -> int | None:
    """Pull a 4-digit year out of 'YYYY', 'YYYY-MM', 'YYYY-MM-DD', or free text."""
    if not token:
        return None
    m = re.search(_YEAR, str(token))
    return int(m.group(0)) if m else None


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
