import json
import re

from pipeline import config
from pipeline.text import _ABBREVIATIONS, repair_source_quote, sentence_excerpt, source_sentence
from pipeline.extract import OfflineExtractor


def test_sentence_excerpt_never_leaves_a_partial_sentence():
    text = (
        "One complete sentence about early life. "
        "A second complete sentence about military service. "
        "A third sentence that should not be cut in the middle of its final words."
    )
    excerpt = sentence_excerpt(text, limit=90)
    assert excerpt == (
        "One complete sentence about early life. "
        "A second complete sentence about military service."
    )
    assert excerpt.endswith(".")


def test_sentence_excerpt_removes_legacy_trailing_ellipsis():
    assert sentence_excerpt("A complete archived sentence. …") == "A complete archived sentence."


def test_sentence_excerpt_removes_a_short_legacy_fragment():
    assert sentence_excerpt(
        "A complete archived sentence. This fragment was cu",
    ) == "A complete archived sentence."


def test_sentence_excerpt_does_not_stop_at_abbreviations():
    text = (
        "Mr. Bibla served with Maj. Smith in the U.S. Army near St. Catharines. "
        "On Nov. 10 he reported to Ft. McClellan. He returned home after the war."
    )
    assert sentence_excerpt(text, limit=75) == (
        "Mr. Bibla served with Maj. Smith in the U.S. Army near St. Catharines."
    )


def test_python_browser_and_worker_share_the_same_abbreviations():
    for relative in ("js/data.js", "worker/sync.js"):
        source = (config.ROOT / relative).read_text(encoding="utf-8")
        match = re.search(
            r"const SENTENCE_ABBREVIATIONS = new Set\(\[(.*?)\]\);",
            source,
            re.DOTALL,
        )
        assert match
        values = re.sub(r",\s*$", "", match.group(1))
        javascript_values = set(json.loads(f"[{values}]"))
        assert javascript_values == _ABBREVIATIONS


def test_sentence_excerpt_can_include_the_next_nearby_sentence_end():
    text = "A deliberately long opening sentence that reaches just beyond the requested limit."
    assert sentence_excerpt(text, limit=60) == text


def test_source_sentence_contains_the_complete_abbreviation_aware_sentence():
    text = (
        "He left home. Mr. Bibla served with Maj. Smith in the U.S. Army near "
        "St. Catharines before reporting to Ft. McClellan. He later returned home."
    )
    start = text.index("St.")
    assert source_sentence(text, start, start + len("St. Catharines")) == (
        "Mr. Bibla served with Maj. Smith in the U.S. Army near St. Catharines "
        "before reporting to Ft. McClellan."
    )


def test_missing_space_after_a_year_does_not_pull_a_trailing_title_into_a_quote():
    text = "He was interviewed in London, Ontario in August 2023.Davis, Frank"
    start = text.index("London")
    assert source_sentence(text, start, start + len("London, Ontario")) == (
        "He was interviewed in London, Ontario in August 2023."
    )


def test_long_source_sentences_and_unpunctuated_sources_are_not_falsely_completed():
    text = "A source sentence " + "continues with its original wording " * 40 + "and ends here."
    assert sentence_excerpt(text, limit=60) == text
    assert sentence_excerpt("A source without terminal punctuation") == "A source without terminal punctuation"
    assert source_sentence("He returned to Canada", 15, 21) == "He returned to Canada"


def test_wider_quotation_does_not_widen_the_date_or_role_heuristics():
    text = (
        "In 1944 he was born far away and " + "worked with his family " * 8 +
        "before he came to Canada where he remained."
    )
    waypoint = OfflineExtractor().extract(text)[0]
    assert waypoint["source_quote"] == text
    assert waypoint["date"]["start"] is None
    assert waypoint["role"] == "resettlement"
    assert not any(key.startswith("_") for key in waypoint)


def test_seeded_quote_repairs_only_text_and_respects_verified_claims():
    text = "He left in 1939. He went to Canada in 1948, where he remained."
    waypoint = {
        "as_written": "Canada", "source_quote": "went to Canada",
        "date": {"start": "1949", "end": "1949", "precision": "year"},
        "role": "transit", "lat": 43, "lng": -79, "verified": False,
    }
    repaired = repair_source_quote(waypoint, text)
    assert repaired["source_quote"] == "He went to Canada in 1948, where he remained."
    assert {key: value for key, value in repaired.items() if key != "source_quote"} == {
        key: value for key, value in waypoint.items() if key != "source_quote"
    }
    verified = {**waypoint, "verified": True}
    assert repair_source_quote(verified, text) == verified
    assert repair_source_quote(
        {**waypoint, "source_quote": "went to Canada … he remained"}, text,
    )["source_quote"] == repaired["source_quote"]


def test_missing_ambiguous_support_is_not_replaced_with_an_invented_quote():
    waypoint = {"as_written": "Canada", "source_quote": "a missing old passage", "verified": False}
    assert repair_source_quote(waypoint, "He visited Canada. He returned to Canada.") == waypoint


def test_every_archive_biography_produces_complete_sentences():
    document = json.loads(
        (config.DATA / "source" / "ohp_all.json").read_text(encoding="utf-8"),
    )
    failures = []
    for person in document["people"]:
        excerpt = sentence_excerpt(person.get("text", ""))
        if excerpt and not re.search(r"""[.!?](?:["”’')\]]+)?$""", excerpt):
            failures.append(person["survivor_id"])
    assert failures == []
