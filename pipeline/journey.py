"""Bounded source-attribution rules shared conceptually with worker/sync.js.

These are evidence labels, not a natural-language understanding or review system.
Only explicit non-personal subjects are removed from routes; uncertainty remains visible.
"""
from __future__ import annotations

import re

from . import dates, gazetteer
from .text import clause_spans, source_sentence


REVISION = "source-evidence-v1"
_NEGATED_BIRTH = re.compile(r"\b(?:not|never)\s+(?:(?:actually|really)\s+)?born\b|\bborn\s+not\s+in\b", re.I)
_RELATIVE = r"(?:parents?|father|mother|grandparents?|grandfather|grandmother|ancestors?)"
_ANCESTOR_SUBJECT = re.compile(
    rf"(?:^|[,:]\s*|\b(?:and|but)\s+)\s*(?:(?:his|her|their|my|our)\s+|"
    rf"[A-Z][\w’'\ufffd-]*(?:\s+[A-Z][\w’'\ufffd-]*){{0,2}}(?:[’'\ufffd]s)\s+)(?:\w+\s+)?{_RELATIVE}\b"
    r"[^;]*?\b(?:born|was|were|had|became|hailed|came|moved|emigrated|immigrated|lived|served|fought|worked|grew)\b",
    re.I,
)
_WITH_PERSON = re.compile(
    r"\b(?:with|alongside|including|took|taking|brought|bringing)\s+(?:him|her|me|them|the children)\b"
    r"|\b(?:he|she|I|we)\s+and\s+(?:his|her|my|our)\b"
    r"|\band\s+(?:he|she|I)\b",
    re.I,
)
_PERSON_ACTION = re.compile(
    r"\b(?:born|grew up|raised|lived|living|resid(?:ed|es|ing)|sett(?:led|ling)|"
    r"mov(?:e|ed|ing)|immigrat(?:ed|ing)|emigrat(?:ed|ing)|fled|escap(?:ed|ing)|"
    r"deport(?:ed|ation)|sent|taken|took|brought|explor(?:e|ed)|arriv(?:ed|ing)|went|came|coming|return(?:ed|ing)|"
    r"travell?(?:ed|ing)|served|serving|stationed|trained|training|worked|working|"
    r"studied|attended|visited|survived|liberated|liberation|imprisoned|held|"
    r"spent|remained|was in|were in|was at|were at|was based|were based|headed|landed)\b",
    re.I,
)
_PERSON_SUBJECT = re.compile(r"\b(?:he|she|I|we|they|him|her|his|my|our)\b", re.I)
_SETTLEMENT = re.compile(
    r"\b(?:sett(?:led|ling)|immigrat(?:ed|ing)|emigrat(?:ed|ing)|"
    r"mov(?:ed|ing)|move|relocat(?:ed|ing)|liv(?:ed|ing|es)|"
    r"resid(?:ed|es|ing)|grew up|raised|made (?:a|their|his|her) home)\b",
    re.I,
)

def _named_participant(clause: str, name: str) -> bool:
    tokens = [token for token in name.split() if len(token) > 2]
    if not tokens:
        return False
    person = rf"\b(?:{'|'.join(re.escape(token) for token in tokens)})\b(?![’'\ufffd]s)"
    relative = rf"(?:(?:his|her|their|my|our|the)\s+)?{_RELATIVE}\b"
    return bool(re.search(
        rf"(?:{person}\s+and\s+{relative}|{relative}\s+and\s+{person}|"
        rf"\b(?:with|alongside|including|took|taking|brought|bringing)\s+{person})",
        clause, re.I,
    ))


def scope_for(clause: str, before: str = "", name: str = "") -> dict:
    """Use only explicit exclusion patterns; family membership alone is not exclusion."""
    ancestor = _ANCESTOR_SUBJECT.search(clause)
    accompanying = bool(_WITH_PERSON.search(clause)) or _named_participant(clause, name)
    if ancestor and not accompanying:
        preceding = before if before else clause
        remainder = preceding[ancestor.start():]
        child_named = any(
            re.search(rf"\b{re.escape(token)}\b(?![’'\ufffd]s)", preceding[ancestor.end():], re.I)
            for token in name.split() if len(token) > 2
        )
        if child_named or re.search(r"\b(?:family|children|him|them|us|we)\b", remainder, re.I):
            return {"scope": "uncertain", "reason": "family-participation-unspecified"}
        if not before or ancestor.end() <= len(before):
            return {"scope": "contextual", "reason": "ancestor-only"}
        return {"scope": "uncertain", "reason": "subject-not-established"}
    if re.search(r"\b(?:his|her|their|my|our)\s+(?:son|daughter|brother|sister|husband|wife|uncle|aunt)\b", before or clause, re.I) and not accompanying:
        return {"scope": "uncertain", "reason": "relative-subject-unresolved"}
    if re.search(rf"\b(?:to|of)\s+(?:\w+\s+)?parents\s+(?:from|born in)\s*$", before, re.I):
        return {"scope": "contextual", "reason": "ancestor-origin"}
    if re.search(r"\b(?:unlike|compared (?:with|to)|similar to)\s*$", before, re.I):
        return {"scope": "contextual", "reason": "comparison"}
    if re.search(r"\b(?:regiment|army|navy|air force)\s+of\s*$", before, re.I):
        return {"scope": "contextual", "reason": "military-unit-name"}
    if re.search(
        r"^\s*(?:In\s+\d{4}\s*,?\s*)?(?:Nazi\s+Germany|Germany|the Nazis|Hitler|"
        r"the Soviet Union|Japan)\s+(?:had\s+)?(?:invaded|occupied|annexed|attacked)\b",
        clause, re.I,
    ):
        return {"scope": "contextual", "reason": "historical-event"}
    named = any(re.search(rf"\b{re.escape(token)}\b", clause, re.I) for token in name.split() if len(token) > 2)
    if _PERSON_ACTION.search(clause) and (
        _PERSON_SUBJECT.search(clause) or named or re.search(r"^\s*(?:Born|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+was born)\b", clause)
    ):
        if re.search(r"\b(?:his|her|their|the)\s+family\b", clause, re.I) and not (
            accompanying or re.search(r"\b(?:he|she|I|we)\b", clause, re.I) or named
        ):
            return {"scope": "uncertain", "reason": "family-membership-unspecified"}
        return {"scope": "personal", "reason": "explicit-personal-context"}
    return {"scope": "uncertain", "reason": "subject-not-established"}


def role_for(canonical: str, before: str, after: str, evidence: dict) -> str:
    if evidence["scope"] == "contextual":
        return gazetteer.known_site_role(canonical) or "transit"
    # Birth must name this location, not merely occur elsewhere in its sentence.
    born = re.search(
        r"\bborn\b(?:(?!\b(?:from|to|moved|lived|grew|parents)\b).)*\b(?:in|at|is)\b"
        r"(?:(?!\b(?:from|to|near|outside|moved|moving|lived|living|grew|raised|parents|went|came|settled|trained|served|worked)\b).)*$",
        before, re.I,
    )
    if born and evidence["scope"] == "personal" and not _NEGATED_BIRTH.search(before):
        return "birthplace"
    if re.search(r"\bliberated\s+(?:at|in|from)\s+(?:(?!\b(?:and|then|before|after|moved|travelled|went|came)\b).)*$", before, re.I):
        return "liberation"
    if gazetteer.known_site_role(canonical):
        return gazetteer.known_site_role(canonical)
    destination = re.search(r"\b(?:to|in|at)\b(?:(?!\b(?:from|through|via|towards|of)\b).)*$", before, re.I)
    if destination and _SETTLEMENT.search(before):
        return "resettlement"
    if destination and re.search(r"\b(?:came|arrived|went|returned|coming|return)\b", before, re.I) and re.search(
        r"\bwhere\b[^.!?]*\b(?:remained|lives?|settled|home)\b", after, re.I,
    ):
        return "resettlement"
    return "transit"


def _place_date(clause: str, hit: tuple, local_hits: list[tuple]) -> dict:
    mentions = dates.date_mentions(clause)
    if not mentions:
        era = re.search(r"\bduring\s+the\s+(?:Second|First)\s+World\s+War\b", clause, re.I)
        return dates.unknown_date(era.group(0) if era else None)
    assigned = []
    for start, end, value in mentions:
        def gap(place):
            return max(start - place[1], place[0] - end, 0)
        closest = min(local_hits, key=gap)
        # A shared place list belongs to one predicate/date, not a second journey clause.
        lo, hi = min(hit[0], closest[0]), max(hit[1], closest[1])
        between = clause[lo:hi]
        for place in reversed(local_hits):
            if lo <= place[0] and place[1] <= hi:
                between = between[:place[0] - lo] + " " * (place[1] - place[0]) + between[place[1] - lo:]
        shared_list = bool(re.fullmatch(r"(?:\s|,|\band\b|\bor\b|\bvia\b|\bthrough\b)+", between, re.I))
        if closest == hit or shared_list:
            assigned.append(value)
    if len(assigned) == 1:
        return dict(assigned[0])
    return dates.unknown_date(" / ".join(
        clause[start:end] for start, end, _ in mentions
    ) if assigned else None)


def place_hits(text: str) -> list[tuple[int, int, str]]:
    aliases = gazetteer._load()["aliases"]
    hits = sorted(
        ((match.start(), match.end(), aliases[alias])
         for alias in aliases for match in re.finditer(rf"\b{re.escape(alias)}\b", text, re.I)),
        key=lambda hit: (hit[0], -(hit[1] - hit[0])),
    )
    accepted = []
    for hit in hits:
        start, end, canonical = hit
        if any(start < previous[1] and end > previous[0] for previous in accepted):
            continue
        previous = accepted[-1] if accepted else None
        if "," not in canonical and previous and "," in previous[2] and re.fullmatch(r"\s*,\s*", text[previous[1]:start]):
            continue
        accepted.append(hit)
    return accepted


def extract_evidence(text: str, name: str = "") -> dict:
    hits = place_hits(text)
    clauses = clause_spans(text)
    routes, contextual = {}, {}
    birth_dates = []
    for left, right in clauses:
        clause = text[left:right]
        subject = scope_for(clause, name=name)
        if re.search(r"\bborn\b", clause, re.I) and subject["scope"] == "personal" and not _NEGATED_BIRTH.search(clause):
            values = dates.date_mentions(clause)
            if len(values) == 1:
                birth_dates.append(values[0][2])
        local_hits = [(start - left, end - left, canonical) for start, end, canonical in hits if left <= start < right]
        for hit in local_hits:
            start, end, canonical = hit
            before, after = clause[:start], clause[end:]
            evidence = scope_for(clause, before, name)
            quote = source_sentence(text, left + start, left + end)
            role = role_for(canonical, before, quote[quote.lower().find(text[left + start:left + end].lower()) + end - start:], evidence)
            date = _place_date(clause, hit, local_hits)
            if re.search(r"\bborn\b", clause, re.I) and role != "birthplace" and evidence["scope"] != "contextual":
                date = dates.unknown_date()
                evidence = {"scope": "uncertain", "reason": "birth-context-not-place-evidence"}
            waypoint = {
                "as_written": text[left + start:left + end],
                "role": role,
                "date": date,
                "confidence": 0.5 if evidence["scope"] == "personal" else 0.35,
                "verified": False,
                "source_quote": quote,
                "evidence": evidence,
            }
            target = contextual if evidence["scope"] == "contextual" else routes
            previous = target.get(canonical)
            if previous is None or (
                target is routes and (
                    (role == "birthplace" and previous["role"] != "birthplace")
                    or (evidence["scope"] == "personal" and previous["evidence"]["scope"] == "uncertain")
                )
            ):
                target[canonical] = waypoint
    exact_births = {value["start"] for value in birth_dates if value["precision"] in {"day", "month", "year"}}
    birth_date = next((value for value in birth_dates if value["start"] in exact_births), dates.unknown_date()) if len(exact_births) == 1 else dates.unknown_date()
    return {
        "waypoints": list(routes.values()), "contextual_places": list(contextual.values()),
        "birth_date": birth_date, "birth_year": dates.parse_year(birth_date["start"]),
    }


def derive_conflicts(group: str, text: str, name: str = "") -> list[str]:
    if group == "Holocaust Survivors":
        return ["The Holocaust"]
    patterns = [
        ("Korean War", r"\b(?:Korean War|Korea)\b"),
        ("Second World War", r"\b(?:world war ii|wwii|second world war|normandy|dieppe|d-?day)\b"),
        ("First World War", r"\b(?:world war i|wwi|first world war|great war)\b"),
        ("Cold War", r"\bcold war\b"),
        ("Peacekeeping & later service", r"\b(?:afghanistan|bosnia|peacekeep\w*|cyprus|suez)\b"),
    ]
    eligible = []
    for left, right in clause_spans(text):
        clause = text[left:right]
        if scope_for(clause, name=name)["scope"] == "contextual" or re.search(r"\bborn\b", clause, re.I):
            continue
        eligible.append(clause)
    return [label for label, pattern in patterns if any(re.search(pattern, clause, re.I) for clause in eligible)]
