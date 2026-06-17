"""Plan B ingest: scrape the Crestwood OHP archive (doc 09 Part 1, doc 02 R1).

The 'ohp' custom post type is NOT exposed over the WordPress REST API (confirmed:
/wp-json/wp/v2/ohp returns rest_no_route), so we fall back to HTML scraping:

    listing page  /ohp-type/holocaust-survivors/   -> all /ohp/{slug}/ survivor links
    each survivor /ohp/{slug}/                      -> display name + bio text

Pages are cached under data/source/pages_cache/ so a rebuild is reproducible and never
re-hammers the live site. Run:

    python -m pipeline.scrape_ohp            # use cached pages if present
    python -m pipeline.scrape_ohp --refresh  # re-fetch everything from the live site

Output: data/source/ohp_scraped.json — raw records {survivor_id, name, archive_url,
text}. The build then extracts places, geocodes, and stages them as pending review.
"""
from __future__ import annotations

import argparse
import html as H
import json
import re
import time
from pathlib import Path

from . import config

BASE = config.WP_BASE
LISTING = f"{BASE}/ohp-type/holocaust-survivors/"
CACHE_DIR = config.DATA / "source" / "pages_cache"
OUT = config.DATA / "source" / "ohp_scraped.json"
UA = "Mozilla/5.0 (compatible; CrestwoodOHP-Map/1.0; +https://github.com/AlexDongzeyu/OHP-Map)"

SLUG_RE = re.compile(r'href="https://ohp\.crestwood\.on\.ca/ohp/([a-z0-9\-]+)/"')


def _get(url: str, cache_path: Path, refresh: bool) -> str | None:
    """Return page HTML, using the disk cache when possible. None on failure."""
    if cache_path.exists() and not refresh:
        return cache_path.read_text(encoding="utf-8", errors="ignore")
    import requests

    for attempt in range(3):
        try:
            resp = requests.get(url, headers={"User-Agent": UA}, timeout=40)
            resp.raise_for_status()
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(resp.text, encoding="utf-8")
            time.sleep(0.3)  # be polite to the archive
            return resp.text
        except requests.RequestException as exc:
            if attempt == 2:
                print(f"  [skip] {url}: {exc}")
                return None
            time.sleep(1.0 + attempt)
    return None


def list_slugs(refresh: bool = False) -> list[str]:
    html = _get(LISTING, CACHE_DIR / "_listing.html", refresh)
    slugs = sorted(set(SLUG_RE.findall(html)))
    return slugs


def _clean(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", " ", fragment)
    text = H.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def parse_entry(slug: str, html: str) -> dict:
    body = re.sub(r"<script.*?</script>", " ", html, flags=re.S)
    body = re.sub(r"<style.*?</style>", " ", body, flags=re.S)

    # Display name: the <title> is "Lastname, Firstname – CRESTWOOD".
    name = slug.replace("-", " ").title()
    tm = re.search(r"<title>(.*?)</title>", body, flags=re.S)
    if tm:
        raw = _clean(tm.group(1))
        raw = re.split(r"\s*[–\-|]\s*CRESTWOOD", raw, flags=re.I)[0].strip()
        if raw and "welcome" not in raw.lower():
            name = _format_name(raw)

    # Bio text: the entry-content block.
    cm = re.search(r'class="[^"]*entry-content[^"]*"[^>]*>(.*?)</div>', body, flags=re.S)
    text = _clean(cm.group(1)) if cm else ""
    # Trim boilerplate tails ("Videos", interviewer credits) that follow the bio.
    text = re.split(r"\bVideos\b", text)[0].strip()

    return {
        "survivor_id": slug,
        "name": name,
        "archive_url": f"{BASE}/ohp/{slug}/",
        "theme_tags": [],
        "text": text,
    }


def _format_name(raw: str) -> str:
    # "Carmelly, Felicia" -> "Felicia Carmelly"
    if "," in raw:
        last, first = [p.strip() for p in raw.split(",", 1)]
        return f"{first} {last}".strip()
    return raw.strip()


def scrape(refresh: bool = False, limit: int | None = None) -> list[dict]:
    slugs = list_slugs(refresh)
    if limit:
        slugs = slugs[:limit]
    records = []
    for i, slug in enumerate(slugs, 1):
        html = _get(f"{BASE}/ohp/{slug}/", CACHE_DIR / f"{slug}.html", refresh)
        if not html:
            continue
        rec = parse_entry(slug, html)
        if rec["text"]:
            records.append(rec)
        if i % 25 == 0:
            print(f"  …scraped {i}/{len(slugs)}")
    return records


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Scrape the Crestwood OHP survivor archive.")
    p.add_argument("--refresh", action="store_true", help="re-fetch from the live site")
    p.add_argument("--limit", type=int, default=None, help="cap survivors (for testing)")
    args = p.parse_args(argv)

    records = scrape(refresh=args.refresh, limit=args.limit)
    OUT.write_text(json.dumps({"is_sample": False, "source": "scrape",
                               "survivors": records}, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    print(f"Scraped {len(records)} survivors with bios -> {OUT.relative_to(config.ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
