"""Golden-set extraction quality + the anti-hallucination grounding rule.

We measure the OFFLINE extractor against hand-checked cases. The key invariant for
any extractor (offline or LLM) is grounding: it must never return a place that is
not literally in the source text (doc 08 weakness #3).
"""
import json
from pathlib import Path

import pytest

from pipeline import config, extract, gazetteer

GOLDEN = sorted(p for p in config.GOLDEN_DIR.glob("*.json"))


def _canonical_sequence(text):
    ex = extract.OfflineExtractor()
    seq, seen = [], set()
    for wp in ex.extract(text):
        canon = gazetteer.normalize(wp["as_written"]) or wp["as_written"]
        if canon not in seen:
            seen.add(canon)
            seq.append(canon)
    return seq


@pytest.mark.parametrize("path", GOLDEN, ids=[p.stem for p in GOLDEN])
def test_offline_extractor_matches_golden(path):
    case = json.loads(Path(path).read_text(encoding="utf-8"))
    assert _canonical_sequence(case["text"]) == case["expected_canonical"]


@pytest.mark.parametrize("path", GOLDEN, ids=[p.stem for p in GOLDEN])
def test_extraction_is_grounded_in_source_text(path):
    case = json.loads(Path(path).read_text(encoding="utf-8"))
    low = case["text"].lower()
    for wp in extract.OfflineExtractor().extract(case["text"]):
        assert wp["as_written"].lower() in low
        assert wp["verified"] is False  # extractor output is never auto-trusted


def test_golden_set_is_present():
    assert GOLDEN, "expected at least one golden case in data/golden/"
