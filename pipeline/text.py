"""Text cleanup shared by the archive build pipeline."""
from __future__ import annotations

import re


_SENTENCE_END = re.compile(r"""[.!?](?:["”’')\]]+)?(?=\s|$)|(?<=\d{4})\.(?=[A-Z][a-z])""")
_COMPLETE_END = re.compile(r"""[.!?](?:["”’')\]]+)?$""")
_ABBREVIATIONS = {
    "adm", "apr", "assoc", "aug", "ave", "blvd", "brig", "ca", "capt",
    "cmdr", "co", "col", "corp", "cpl", "dec", "dept", "dr", "ed", "est",
    "etc", "feb", "fig", "ft", "gen", "hon", "inc", "jan", "jr", "jul",
    "jun", "lt", "ltd", "maj", "mar", "mr", "mrs", "ms", "mt", "no",
    "nov", "oct", "pm", "prof", "pvt", "rd", "rev", "sep", "sept", "sgt",
    "sqn", "sr", "st", "vol", "vs",
}


def _sentence_endings(text: str) -> list[int]:
    endings = []
    for match in _SENTENCE_END.finditer(text):
        end = match.end()
        if match.group(0).startswith(".") and end < len(text):
            token_match = re.search(r"([A-Za-z][A-Za-z.]*)\.$", text[:end])
            token = token_match.group(1).lower().replace(".", "") if token_match else ""
            dotted_initials = bool(
                token_match and re.fullmatch(r"(?:[A-Za-z]\.){1,5}", token_match.group(0)),
            )
            if token in _ABBREVIATIONS or dotted_initials:
                continue
        endings.append(end)
    return endings


def source_sentence(text: str, start: int, end: int) -> str:
    """Return the complete source sentence(s) containing a literal matched span."""
    if not 0 <= start < end <= len(text):
        raise ValueError("The source span must be inside the source text")
    endings = _sentence_endings(text)
    left = max((boundary for boundary in endings if boundary <= start), default=0)
    right = next((boundary for boundary in endings if boundary >= end), len(text))
    return text[left:right].strip()


def repair_source_quote(waypoint: dict, text: str) -> dict:
    """Expand an unreviewed supporting quotation without re-extracting its claims."""
    if waypoint.get("verified") or not text:
        return waypoint
    quote = waypoint.get("source_quote") or ""
    fragments = [part.strip() for part in re.split(r"\s*(?:…|\.{3})\s*", quote) if part.strip()]
    spans, cursor = [], 0
    for fragment in fragments:
        match = re.search(re.escape(fragment), text[cursor:], re.I)
        if not match:
            spans = []
            break
        spans.append((cursor + match.start(), cursor + match.end()))
        cursor += match.end()
    if spans:
        complete = source_sentence(text, spans[0][0], spans[-1][1])
    else:
        place = waypoint.get("as_written") or ""
        matches = list(re.finditer(rf"\b{re.escape(place)}\b", text, re.I)) if place else []
        if len(matches) != 1:
            return waypoint  # An ambiguous mention cannot safely replace an old quotation.
        complete = source_sentence(text, matches[0].start(), matches[0].end())
    return {**waypoint, "source_quote": complete}


def sentence_excerpt(text: str, limit: int = 520) -> str:
    """Return complete source sentences near the requested character limit."""
    clean = re.sub(r"\s+", " ", (text or "")).strip()
    clean = re.sub(r"\s*…\s*$", "", clean).strip()
    if not clean:
        return clean
    endings = _sentence_endings(clean)
    if len(clean) <= limit:
        if _COMPLETE_END.search(clean):
            return clean
        if endings:
            return clean[:endings[-1]].strip()
        return clean

    before = [end for end in endings if end <= limit]
    if before:
        return clean[:before[-1]].strip()

    if endings:
        return clean[:endings[0]].strip()
    return clean
