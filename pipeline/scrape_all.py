"""Ingest the WHOLE Crestwood OHP archive — every ohp-type category, not just
Holocaust survivors (doc 13 §4.2: "pull the whole taxonomy"). Each person is tagged
with their archive group and a derived conflict/era facet.

    /ohp-type/holocaust-survivors/   -> group "Holocaust Survivors"
    /ohp-type/military-veterans-al/  -> group "Military Veterans"
    /ohp-type/military-veterans-mz/  -> group "Military Veterans"
    /ohp-type/community-members/     -> group "Community Members"
    /ohp-type/first-nations/         -> group "First Nations"
    /ohp-type/crestwood-families/    -> group "Crestwood Families"

Pages are cached on disk so rebuilds are reproducible and never re-hammer the site.

    python -m pipeline.scrape_all            # cached pages if present
    python -m pipeline.scrape_all --refresh  # re-fetch everything

Output: data/source/ohp_all.json — raw records with group + conflict. The build then
extracts places, geocodes, and stages everything as pending review.
"""
from __future__ import annotations

import argparse
import json
import re

from . import config
from .scrape_ohp import BASE, CACHE_DIR, SLUG_RE, _get, parse_entry

OUT = config.DATA / "source" / "ohp_all.json"

# Archive taxonomy term -> (display group, ordering weight).
CATEGORIES = {
    "holocaust-survivors": "Holocaust Survivors",
    "military-veterans-al": "Military Veterans",
    "military-veterans-mz": "Military Veterans",
    "community-members": "Community Members",
    "first-nations": "First Nations",
    "crestwood-families": "Crestwood Families",
}

GROUP_ORDER = ["Holocaust Survivors", "Military Veterans", "Community Members",
               "First Nations", "Crestwood Families"]


def list_category(term: str, refresh: bool) -> list[str]:
    html = _get(f"{BASE}/ohp-type/{term}/", CACHE_DIR / f"_cat_{term}.html", refresh)
    if not html:
        return []
    return sorted(set(SLUG_RE.findall(html)))


def derive_conflict(group: str, text: str) -> list[str]:
    """A light, honest conflict/era facet (doc 13 §4.7). Holocaust for survivors;
    for veterans, detect named conflicts in the bio, defaulting to WWII."""
    if group == "Holocaust Survivors":
        return ["The Holocaust"]
    low = text.lower()
    found = []
    if re.search(r"\bkorea(n)?\b", low):
        found.append("Korean War")
    if re.search(r"\b(world war ii|wwii|second world war|1939|1940|1941|1942|1943|1944|1945|normandy|dieppe|d-?day)\b", low):
        found.append("Second World War")
    if re.search(r"\b(world war i|wwi|first world war|1914|1915|1916|1917|1918)\b", low):
        found.append("First World War")
    if re.search(r"\b(afghanistan|bosnia|peacekeep|cyprus|suez)\b", low):
        found.append("Peacekeeping & later service")
    if group == "Military Veterans" and not found:
        found.append("Second World War")
    return found


def scrape_all(refresh: bool = False, limit_per: int | None = None) -> list[dict]:
    records, seen = [], set()
    for term, group in CATEGORIES.items():
        slugs = list_category(term, refresh)
        if limit_per:
            slugs = slugs[:limit_per]
        print(f"[{term}] {len(slugs)} entries")
        for i, slug in enumerate(slugs, 1):
            if slug in seen:
                continue
            seen.add(slug)
            html = _get(f"{BASE}/ohp/{slug}/", CACHE_DIR / f"{slug}.html", refresh)
            if not html:
                continue
            rec = parse_entry(slug, html)
            if not rec["text"]:
                continue
            rec["group"] = group
            rec["conflicts"] = derive_conflict(group, rec["text"])
            records.append(rec)
            if i % 50 == 0:
                print(f"  …{term} {i}/{len(slugs)}")
    return records


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Scrape the whole Crestwood OHP archive.")
    p.add_argument("--refresh", action="store_true", help="re-fetch from the live site")
    p.add_argument("--limit-per", type=int, default=None, help="cap entries per category (testing)")
    args = p.parse_args(argv)

    records = scrape_all(refresh=args.refresh, limit_per=args.limit_per)
    by_group = {}
    for r in records:
        by_group[r["group"]] = by_group.get(r["group"], 0) + 1
    OUT.write_text(json.dumps({"is_sample": False, "source": "scrape-all",
                               "group_order": GROUP_ORDER, "people": records},
                              ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nScraped {len(records)} people -> {OUT.relative_to(config.ROOT)}")
    for g in GROUP_ORDER:
        if by_group.get(g):
            print(f"  {g}: {by_group[g]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
