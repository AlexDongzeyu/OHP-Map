import json
import re

from pipeline import config
from pipeline.text import _ABBREVIATIONS, sentence_excerpt


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
