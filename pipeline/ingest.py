"""Ingest layer (doc 02 Phase 2, doc 04).

One interface, three implementations, so the rest of the pipeline doesn't care
where records came from:

* WordPressRestSource  — Plan A. Reads the WP REST API (the archive runs WordPress,
  so we get clean JSON instead of scraping fragile HTML).
* HtmlScrapeSource     — Plan B fallback, used only if the custom post type isn't
  exposed over REST.
* LocalSource          — the hand-entered anchor survivors (doc 05). This is what
  the bundled sample build uses, and it is the pipeline's golden set.

Each source yields RawRecord dicts:
    { survivor_id, name, archive_url, birth_year?, bio_excerpt?, theme_tags[],
      text (raw testimony, for the extractor) OR waypoints (already structured) }
"""
from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from typing import Iterable

from . import config


def slugify(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return value or "unknown"


class Source(ABC):
    @abstractmethod
    def fetch(self) -> Iterable[dict]:
        """Yield raw survivor records."""
        raise NotImplementedError


class LocalSource(Source):
    """Read the committed hand-entered anchor survivors."""

    def __init__(self, path=config.SOURCE):
        self.path = path

    def fetch(self) -> Iterable[dict]:
        with open(self.path, encoding="utf-8") as fh:
            doc = json.load(fh)
        for rec in doc["survivors"]:
            rec.setdefault("is_sample", doc.get("is_sample", False))
            yield rec


class WordPressRestSource(Source):
    """Plan A: pull the 'Holocaust Survivors' post type from the WP REST API.

    Discovery first (probe /types), then paginate the post-type endpoint. We never
    write back. Network code is imported lazily so offline sample builds don't need
    `requests` installed.
    """

    def __init__(self, base=config.WP_BASE, post_type="ohp", per_page=50, timeout=30):
        self.base = base.rstrip("/")
        self.post_type = post_type
        self.per_page = per_page
        self.timeout = timeout

    def discover(self) -> dict:
        import requests

        resp = requests.get(f"{self.base}/wp-json/wp/v2/types", timeout=self.timeout)
        resp.raise_for_status()
        return resp.json()

    def fetch(self) -> Iterable[dict]:
        import requests

        page = 1
        while True:
            resp = requests.get(
                f"{self.base}/wp-json/wp/v2/{self.post_type}",
                params={"per_page": self.per_page, "page": page, "_embed": 1},
                timeout=self.timeout,
            )
            if resp.status_code == 400:  # WP returns 400 past the last page
                break
            resp.raise_for_status()
            batch = resp.json()
            if not batch:
                break
            for post in batch:
                yield self._to_record(post)
            page += 1

    @staticmethod
    def _strip_html(html: str) -> str:
        return re.sub(r"<[^>]+>", " ", html or "").replace("&nbsp;", " ").strip()

    def _to_record(self, post: dict) -> dict:
        title = (post.get("title") or {}).get("rendered", "")
        content = (post.get("content") or {}).get("rendered", "")
        return {
            "survivor_id": post.get("slug") or slugify(title),
            "name": self._strip_html(title),
            "archive_url": post.get("link", ""),
            "theme_tags": [],  # would come from the embedded taxonomy terms
            "text": self._strip_html(content),
        }


class HtmlScrapeSource(Source):
    """Plan B fallback: parse listing + entry HTML if REST isn't exposed."""

    def __init__(self, base=config.WP_BASE, timeout=30):
        self.base = base.rstrip("/")
        self.timeout = timeout

    def fetch(self) -> Iterable[dict]:
        import requests
        from bs4 import BeautifulSoup

        resp = requests.get(self.base, timeout=self.timeout)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "lxml")
        for link in soup.select("a[href]"):
            href = link.get("href", "")
            if "/holocaust-survivors/" not in href:
                continue
            entry = requests.get(href, timeout=self.timeout)
            entry.raise_for_status()
            esoup = BeautifulSoup(entry.text, "lxml")
            title = (esoup.find("h1").get_text(strip=True) if esoup.find("h1") else href)
            body = esoup.find("article") or esoup.find("main") or esoup.body
            yield {
                "survivor_id": slugify(title),
                "name": title,
                "archive_url": href,
                "theme_tags": [],
                "text": body.get_text(" ", strip=True) if body else "",
            }


class ScrapedSource(Source):
    """Read the committed scraped OHP archive (data/source/ohp_scraped.json)."""

    def __init__(self, path=config.DATA / "source" / "ohp_scraped.json"):
        self.path = path

    def fetch(self) -> Iterable[dict]:
        if not self.path.exists():
            raise FileNotFoundError(
                f"{self.path} not found — run `python -m pipeline.scrape_ohp` first.")
        with open(self.path, encoding="utf-8") as fh:
            doc = json.load(fh)
        for rec in doc.get("survivors", []):
            rec.setdefault("is_sample", False)
            yield rec


class CombinedSource(Source):
    """Curated featured survivors first, then the rest of the scraped archive.

    Featured records (data/source/survivors_curated.json) are hand-ordered examples;
    everything else comes from the scrape. De-duplicated by survivor_id so a curated
    survivor isn't also emitted from the scrape.
    """

    def __init__(self, curated=config.DATA / "source" / "survivors_curated.json",
                 scraped=config.DATA / "source" / "ohp_scraped.json"):
        self.curated = curated
        self.scraped = scraped

    def fetch(self) -> Iterable[dict]:
        seen = set()
        if self.curated.exists():
            with open(self.curated, encoding="utf-8") as fh:
                for rec in json.load(fh).get("survivors", []):
                    rec.setdefault("is_sample", False)
                    rec["featured"] = True
                    seen.add(rec["survivor_id"])
                    yield rec
        for rec in ScrapedSource(self.scraped).fetch():
            if rec["survivor_id"] not in seen:
                yield rec


class AllSource(Source):
    """The whole OHP archive (every ohp-type category), from data/source/ohp_all.json.

    Each record carries 'group' (Holocaust Survivors / Military Veterans / …) and
    'conflicts' (derived era facet). Curated featured survivors are merged in first so
    their hand-checked journeys take precedence over the auto-extracted version.
    """

    def __init__(self, all_path=config.DATA / "source" / "ohp_all.json",
                 curated=config.DATA / "source" / "survivors_curated.json"):
        self.all_path = all_path
        self.curated = curated

    def fetch(self) -> Iterable[dict]:
        seen = set()
        if self.curated.exists():
            with open(self.curated, encoding="utf-8") as fh:
                for rec in json.load(fh).get("survivors", []):
                    rec.setdefault("is_sample", False)
                    rec.setdefault("group", "Holocaust Survivors")
                    rec.setdefault("conflicts", ["The Holocaust"])
                    seen.add(rec["survivor_id"])
                    yield rec
        if not self.all_path.exists():
            raise FileNotFoundError(
                f"{self.all_path} not found — run `python -m pipeline.scrape_all` first.")
        with open(self.all_path, encoding="utf-8") as fh:
            doc = json.load(fh)
        for rec in doc.get("people", []):
            if rec["survivor_id"] in seen:
                continue
            rec.setdefault("is_sample", False)
            yield rec


def get_source(name: str) -> Source:
    name = (name or "local").lower()
    if name == "local":
        return LocalSource()
    if name in ("wordpress", "wp", "rest"):
        return WordPressRestSource()
    if name == "scrape":
        return HtmlScrapeSource()
    if name == "scraped":
        return ScrapedSource()
    if name in ("ohp", "combined"):
        return CombinedSource()
    if name == "all":
        return AllSource()
    raise ValueError(f"unknown source: {name!r}")
