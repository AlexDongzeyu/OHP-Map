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


def sentence_spans(text: str) -> list[tuple[int, int]]:
    """Offsets of abbreviation-aware source sentences, including an unfinished tail."""
    boundaries = [0, *_sentence_endings(text)]
    if boundaries[-1] != len(text):
        boundaries.append(len(text))
    return [(left, right) for left, right in zip(boundaries, boundaries[1:]) if text[left:right].strip()]


_CLAUSE_BREAK = re.compile(
    r";\s*"
    r"|(?:,\s*)?\b(?:and|but|while|where|when|before|after|as)\s+"
    r"(?=(?:he|she|they|we|I|his|her|their|my|our)\b)"
    r"|(?:,\s*)?\b(?:and(?:\s+then)?|then|before|after)\s+"
    r"(?=(?:later\s+|finally\s+)?(?:mov(?:ed|ing)|sett(?:led|ling)|arriv(?:ed|ing)|"
    r"return(?:ed|ing)|travell?(?:ed|ing)|went|came|fled|escaped|serv(?:ed|ing)|"
    r"liv(?:ed|ing)|grew up|was raised|immigrat(?:ed|ing)|emigrat(?:ed|ing)|work(?:ed|ing))\b)",
    re.I,
)
_NAMED_CLAUSE_BREAK = re.compile(
    r"(?:,\s*|\b(?:and|but|before|after|when|while|where|as)\s+)"
    r"(?=[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+"
    r"(?:was|were|had|has|is|faced|went|came|moved|served|worked|joined|found|recalled)\b)",
)


def clause_spans(text: str) -> list[tuple[int, int]]:
    """Split only explicit clause boundaries; never use a character-radius window."""
    spans = []
    for left, right in sentence_spans(text):
        sentence = text[left:right]
        def boundary(match):
            joint_subject = (
                re.search(r"\b(?:[A-Z][a-z]+|(?i:he|she|I|we|they))\s*$", sentence[:match.start()])
                and re.match(r"(?:his|her|their|my|our)\s+(?:family|parents?|father|mother)\b", sentence[match.end():], re.I)
                and re.search(r"\band\s+$", match.group(0), re.I)
            )
            return not joint_subject

        cuts = sorted({0, len(sentence), *(
            match.end()
            for pattern in (_CLAUSE_BREAK, _NAMED_CLAUSE_BREAK)
            for match in pattern.finditer(sentence)
            if boundary(match)
        )})
        spans.extend(
            (left + start, left + end) for start, end in zip(cuts, cuts[1:])
            if sentence[start:end].strip()
        )
    return spans


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
