"""Text cleanup shared by the archive build pipeline."""
from __future__ import annotations

import re


_SENTENCE_END = re.compile(r"""[.!?](?:["”’')\]]+)?(?=\s|$)""")
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
        return f"{clean.rstrip(' ,;:-')}."

    before = [end for end in endings if end <= limit]
    if before:
        return clean[:before[-1]].strip()

    after = next((end for end in endings if end <= limit + 240), None)
    if after:
        return clean[:after].strip()

    cut = clean[:limit].rsplit(" ", 1)[0].rstrip(" ,;:-")
    return f"{cut}."
