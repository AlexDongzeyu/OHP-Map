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
    python -m pipeline.scrape_all --reconcile # refresh listings, preserve existing claims

Output: data/source/ohp_all.json — raw records with group + conflict. The build then
extracts places, geocodes, and stages everything as pending review.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from urllib.parse import parse_qs, urljoin, urlsplit

from bs4 import BeautifulSoup

from . import config
from .scrape_ohp import BASE, CACHE_DIR, _get, parse_entry

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
    entries, _ = category_entries(term, refresh=refresh)
    return sorted(slug for slug, entry in entries.items() if not entry["protected"])


def _profile_slug(url: str) -> str | None:
    parsed = urlsplit(urljoin(BASE, url))
    match = re.fullmatch(r"/ohp/([a-z0-9-]+)/?", parsed.path)
    if (
        parsed.scheme in {"http", "https"} and parsed.hostname == urlsplit(BASE).hostname
        and not parsed.username and not parsed.password and not parsed.port and match
    ):
        return match[1]
    return None


def category_entries(term: str, *, refresh: bool = True) -> tuple[dict, list[str]]:
    """Read current anchor/option listings and follow same-category pagination."""
    root = f"{BASE}/ohp-type/{term}/"
    queue, visited, entries = [root], set(), {}
    while queue:
        url = queue.pop(0)
        if url in visited:
            continue
        page_number = len(visited) + 1
        cache = CACHE_DIR / (
            f"_cat_{term}.html" if url == root else f"_cat_{term}_page_{page_number}.html"
        )
        page = _get(url, cache, refresh)
        if page is None:
            raise ValueError(f"Cannot reconcile a missing category listing: {term}")
        visited.add(url)
        soup = BeautifulSoup(page, "html.parser")
        for element in soup.select("a[href], option[value]"):
            value = element.get("href") or element.get("value", "")
            slug = _profile_slug(value)
            if slug:
                protected = bool(re.match(r"^\s*Protected\s*:", element.get_text(" ", strip=True), re.I))
                entry = entries.setdefault(slug, {"group": CATEGORIES[term], "protected": False})
                entry["protected"] = entry["protected"] or protected
            absolute = urljoin(url, value)
            parsed = urlsplit(absolute)
            if parsed.hostname != urlsplit(BASE).hostname:
                continue
            path_page = re.fullmatch(rf"/ohp-type/{re.escape(term)}/page/(\d+)/?", parsed.path)
            query_page = parse_qs(parsed.query).get("paged", [])
            if path_page and int(path_page[1]) > 0:
                next_url = f"{root}page/{int(path_page[1])}/"
            elif parsed.path.rstrip("/") == urlsplit(root).path.rstrip("/") and query_page and query_page[0].isdigit():
                next_url = f"{root}?paged={int(query_page[0])}"
            else:
                continue
            if next_url not in visited and next_url not in queue:
                queue.append(next_url)
    return entries, sorted(visited)


def _group_from_page(page: str) -> str | None:
    soup = BeautifulSoup(page, "html.parser")
    article = soup.select_one("article.type-ohp")
    if not article:
        return None
    groups = {**CATEGORIES, "military-veterans": "Military Veterans"}
    return next((
        groups[value.removeprefix("ohp-type-")]
        for value in article.get("class", [])
        if value.startswith("ohp-type-") and value.removeprefix("ohp-type-") in groups
    ), None)


def reconcile(*, include: list[str] | None = None, refresh_listings: bool = True) -> dict:
    """Reconcile public membership without re-extracting existing geography."""
    from . import media

    source = json.loads(OUT.read_text(encoding="utf-8"))
    original = {record["survivor_id"]: record for record in source["people"]}
    records = dict(original)
    listed, categories = {}, {}
    for term in CATEGORIES:
        entries, pages = category_entries(term, refresh=refresh_listings)
        categories[term] = {
            "urls": pages, "listed": len(entries),
            "public": sum(not entry["protected"] for entry in entries.values()),
            "protected": sum(entry["protected"] for entry in entries.values()),
        }
        for slug, entry in entries.items():
            merged = listed.setdefault(slug, {**entry, "categories": []})
            merged["categories"].append(term)
            merged["protected"] = merged["protected"] or entry["protected"]
    public = {slug for slug, entry in listed.items() if not entry["protected"]}
    protected = {slug for slug, entry in listed.items() if entry["protected"]}
    other_pages = {page["survivor_id"] for page in media.other_source_pages()}
    requested = set(include or [])
    if any(not re.fullmatch(r"[a-z0-9-]+", slug) for slug in requested):
        raise ValueError("Additional profile identifiers must be OHP slugs")
    to_check = ((public - set(original)) | (set(original) - public) | requested) - other_pages
    checked, aliases, unavailable, unresolved = {}, {}, {}, {}
    for slug in sorted(to_check):
        url = f"{BASE}/ohp/{slug}/"
        page = _get(url, CACHE_DIR / f"{slug}.html", True)
        if page is None:
            unresolved[slug] = "fetch-failed"
            continue
        status = media.page_status(page, url)
        target = slug
        if status == "invalid":
            canonical = BeautifulSoup(page, "html.parser").select_one('link[rel="canonical"]')
            target = _profile_slug(canonical.get("href", "")) if canonical else None
            if target and target != slug:
                url = f"{BASE}/ohp/{target}/"
                status = media.page_status(page, url)
                if status == "public":
                    aliases[slug] = target
            else:
                target = slug
        if status == "protected":
            protected.add(slug)
            unavailable[slug] = "protected"
            records.pop(slug, None)
            checked[slug] = {"status": status, "archive_url": url}
            continue
        if status != "public":
            unresolved[slug] = status
            continue
        group = listed.get(target, {}).get("group") or _group_from_page(page) or original.get(slug, {}).get("group")
        if not group:
            unresolved[slug] = "unclassified-public-page"
            continue
        parsed = parse_entry(target, page)
        candidate = {
            "survivor_id": target, "name": parsed["name"], "archive_url": url,
            "theme_tags": [], "text": parsed["quote_text"], "group": group,
            "conflicts": derive_conflict(group, parsed["quote_text"]) if parsed["quote_text"]
            else (["The Holocaust"] if group == "Holocaust Survivors" else []),
        }
        if target not in records:
            records[target] = candidate
        checked[slug] = {"status": "public", "archive_url": url, "canonical_id": target}

    for old_id, new_id in aliases.items():
        if old_id not in original or new_id not in records:
            continue
        current = records[new_id]
        previous = original[old_id]
        records[new_id] = {
            **current, **previous,
            "survivor_id": new_id, "name": current["name"], "archive_url": current["archive_url"],
            "source_aliases": sorted(set(previous.get("source_aliases", [])) | {old_id}),
        }
        records.pop(old_id, None)
    for slug in protected:
        records.pop(slug, None)

    report = {
        "_about": "Fresh public category reconciliation. Protected entries contain only public listing identifiers, never restricted biography or media text.",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "categories": categories,
        "listed_pages": len(listed),
        "listed_public_pages": len(public),
        "listed_protected_pages": sum(entry["protected"] for entry in listed.values()),
        "protected": sorted(protected),
        "other_pages": sorted(other_pages & public),
        "aliases": aliases,
        "detail_checks": checked,
        "unavailable": unavailable,
        "unresolved": unresolved,
        "added": sorted(set(records) - set(original) - set(aliases.values())),
        "unlisted_public_profiles": sorted(set(records) - public),
        "missing_public_profiles": sorted(public - other_pages - set(records) - protected),
        "published_profiles": len(records),
        "requested_ids": sorted(requested),
    }
    if report["missing_public_profiles"]:
        for slug in report["missing_public_profiles"]:
            report["unresolved"].setdefault(slug, "not-reconciled")
    source["people"] = sorted(
        records.values(), key=lambda record: (GROUP_ORDER.index(record["group"]), record["survivor_id"]),
    )
    OUT.write_text(json.dumps(source, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    config.OHP_RECONCILIATION.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if aliases and config.VIMEO_CAPTION_INDEX.exists():
        audit = json.loads(config.VIMEO_CAPTION_INDEX.read_text(encoding="utf-8"))
        for old_id, new_id in aliases.items():
            prior = audit.get("profiles", {}).pop(old_id, None)
            if prior and new_id in records:
                prior["archive_url"] = records[new_id]["archive_url"]
                audit["profiles"].setdefault(new_id, prior)
        config.VIMEO_CAPTION_INDEX.write_text(json.dumps(audit, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        f"Reconciled {len(listed)} listed pages: {len(public)} public, "
        f"{report['listed_protected_pages']} protected; {len(records)} people, "
        f"{len(report['added'])} additions, {len(aliases)} aliases, {len(unresolved)} unresolved.",
        flush=True,
    )
    return report


def derive_conflict(group: str, text: str) -> list[str]:
    """A named source conflict, never a default inferred from birth year or group."""
    from .journey import derive_conflicts
    return derive_conflicts(group, text)


def scrape_all(refresh: bool = False, limit_per: int | None = None) -> list[dict]:
    from .media import other_source_pages, page_status

    records, seen = [], set()
    non_profile_slugs = {page["survivor_id"] for page in other_source_pages()}
    for term, group in CATEGORIES.items():
        slugs = list_category(term, refresh)
        if limit_per:
            slugs = slugs[:limit_per]
        print(f"[{term}] {len(slugs)} entries")
        for i, slug in enumerate(slugs, 1):
            if slug in seen or slug in non_profile_slugs:
                continue
            seen.add(slug)
            html = _get(f"{BASE}/ohp/{slug}/", CACHE_DIR / f"{slug}.html", refresh)
            if not html:
                continue
            rec = parse_entry(slug, html)
            if page_status(html, f"{BASE}/ohp/{slug}/") != "public":
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
    p.add_argument("--reconcile", action="store_true", help="refresh membership without replacing existing extraction input")
    p.add_argument("--include", nargs="*", default=[], help="also check explicitly supplied public profile slugs")
    args = p.parse_args(argv)

    if args.reconcile:
        report = reconcile(include=args.include)
        return 1 if report["unresolved"] else 0
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
