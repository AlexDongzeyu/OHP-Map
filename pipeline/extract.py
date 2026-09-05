"""Extraction layer (doc 01 "use an LLM as the primary engine", doc 04 Phase 2).

Turns raw testimony text into an ordered list of structured waypoints
({as_written, role, date, confidence, verified, source_quote}).

Two implementations behind one interface:

* LLMExtractor    — the primary engine. Prompts a Claude/GPT-class model for STRICT
  JSON, then GROUNDS every result: any place the model returns that does not appear
  in the source text is dropped (the anti-hallucination rule, doc 08 weakness #3).
  Needs an API key from the environment; never hard-coded.
* OfflineExtractor — deterministic fallback so the pipeline runs with no key and no
  network. It scans the text for gazetteer-known place names in order of appearance.
  Lower confidence, never auto-verified — exactly what the human-review gate is for.

Nothing produced here is ever marked verified=true automatically. Public records
remain pending human review, and non-personal mentions are kept outside their routes.
"""
from __future__ import annotations

import json
import os
import re
from abc import ABC, abstractmethod

from . import journey


class Extractor(ABC):
    @abstractmethod
    def extract(self, text: str) -> list[dict]:
        raise NotImplementedError


PROMPT = """You extract structured journeys from Holocaust survivor testimony.
Return STRICT JSON only: a list of waypoint objects in chronological order.
Each waypoint: {{"as_written": <place exactly as the text spells it>,
"role": one of ["birthplace","ghetto","camp","transit","liberation","resettlement"],
"date": {{"start": "YYYY" or "YYYY-MM" or null, "end": same or null,
"precision": one of ["day","month","year","range","unknown"]}},
"source_quote": <the short verbatim span that supports this waypoint>}}.
Rules: use ONLY places explicitly named in the text; never invent or infer a place
that is not written; if a date is vague, widen the range and lower precision rather
than guessing. Output JSON array only, no prose.

TESTIMONY:
{text}
"""


def _grounded(waypoints: list[dict], text: str) -> list[dict]:
    """Drop any waypoint whose as-written place is not literally in the source text."""
    low = text.lower()
    kept = []
    for wp in waypoints:
        name = (wp.get("as_written") or "").strip()
        if name and name.lower() in low:
            wp.setdefault("confidence", 0.6)
            wp["verified"] = False  # never trust the extractor; human gate decides
            kept.append(wp)
    return kept


class OfflineExtractor(Extractor):
    """Literal source places with explicit personal/contextual/uncertain attribution."""

    def extract_evidence(self, text: str, name: str = "") -> dict:
        return journey.extract_evidence(text, name)

    def extract(self, text: str, name: str = "") -> list[dict]:
        return self.extract_evidence(text, name)["waypoints"]


class LLMExtractor(Extractor):
    """Primary engine. Wraps a Claude/GPT-class model; output is strictly grounded."""

    def __init__(self, provider="anthropic", model=None):
        self.provider = provider
        self.model = model

    def extract(self, text: str) -> list[dict]:
        raw = self._call(PROMPT.format(text=text))
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            # tolerate a model that wraps JSON in prose / fences
            m = re.search(r"\[.*\]", raw, re.S)
            data = json.loads(m.group(0)) if m else []
        return _grounded(data if isinstance(data, list) else [], text)

    def _call(self, prompt: str) -> str:
        if self.provider == "anthropic":
            from anthropic import Anthropic  # imported lazily

            client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
            msg = client.messages.create(
                model=self.model or "claude-3-5-sonnet-latest",
                max_tokens=2000,
                messages=[{"role": "user", "content": prompt}],
            )
            return msg.content[0].text
        if self.provider == "openai":
            from openai import OpenAI

            client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
            resp = client.chat.completions.create(
                model=self.model or "gpt-4o",
                messages=[{"role": "user", "content": prompt}],
            )
            return resp.choices[0].message.content
        raise ValueError(f"unknown provider: {self.provider!r}")


def get_extractor(name: str) -> Extractor:
    name = (name or "offline").lower()
    if name == "offline":
        return OfflineExtractor()
    if name in ("anthropic", "claude"):
        return LLMExtractor(provider="anthropic")
    if name in ("openai", "gpt"):
        return LLMExtractor(provider="openai")
    raise ValueError(f"unknown extractor: {name!r}")
