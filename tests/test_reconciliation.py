import json
import shutil
from uuid import uuid4

from pipeline import config, media, scrape_all


def test_listing_reconciliation_reads_options_protection_and_pagination(monkeypatch):
    root = "https://ohp.crestwood.on.ca/ohp-type/community-members/"
    pages = {
        root: """
          <a href="/ohp/first/">First</a>
          <option value="/ohp/second/">Second</option>
          <a href="/ohp/private/">Private</a>
          <option value="/ohp/private/">Protected: Private</option>
          <a href="/ohp-type/community-members/page/2/">Next</a>
          <a href="https://other.invalid/ohp/intruder/">Not the archive</a>
        """,
        root + "page/2/": '<a href="/ohp/third/">Third</a><a href="/ohp-type/community-members/">Previous</a>',
    }
    calls = []

    def get(url, path, refresh):
        calls.append((url, refresh))
        return pages[url]

    monkeypatch.setattr(scrape_all, "_get", get)
    entries, visited = scrape_all.category_entries("community-members")
    assert set(entries) == {"first", "second", "third", "private"}
    assert entries["private"]["protected"] is True
    assert entries["second"]["protected"] is False
    assert visited == sorted(pages)
    assert all(refresh for _, refresh in calls)


def test_reconciliation_preserves_renamed_claims_and_excludes_newly_protected_text(monkeypatch):
    root = config.DATA / "source" / f".reconcile-test-{uuid4().hex}"
    root.mkdir()
    try:
        source_path = root / "source.json"
        report_path = root / "report.json"
        index_path = root / "captions.json"
        original = {
            "survivor_id": "old-name", "name": "Old Name",
            "archive_url": "https://ohp.crestwood.on.ca/ohp/old-name/",
            "group": "Community Members", "conflicts": [], "theme_tags": [],
            "text": "He was born in Toronto in 1944.",
            "waypoints": [{
                "as_written": "Toronto", "canonical": "Toronto, Canada", "role": "birthplace",
                "date": {"start": "1944", "end": "1944", "precision": "year"},
                "verified": True, "confidence": 1, "source_quote": "He was born in Toronto in 1944.",
            }],
        }
        private = {**original, "survivor_id": "private", "text": "Previously public but now restricted biography."}
        source_path.write_text(json.dumps({"people": [original, private]}), encoding="utf-8")
        video = {"id": "123", "embed_url": "https://player.vimeo.com/video/123", "status": "no-public-captions"}
        index_path.write_text(json.dumps({"profiles": {"old-name": {
            "archive_url": original["archive_url"], "videos": {"123": video},
        }}}), encoding="utf-8")
        monkeypatch.setattr(scrape_all, "OUT", source_path)
        monkeypatch.setattr(scrape_all, "CACHE_DIR", root)
        monkeypatch.setattr(config, "OHP_RECONCILIATION", report_path)
        monkeypatch.setattr(config, "VIMEO_CAPTION_INDEX", index_path)
        monkeypatch.setattr(media, "other_source_pages", lambda: [])
        listing = {
            "new-name": {"group": "Community Members", "protected": False},
            "public-empty": {"group": "Community Members", "protected": False},
            "private": {"group": "Community Members", "protected": True},
        }
        monkeypatch.setattr(scrape_all, "category_entries", lambda term, refresh=True: (
            (listing if term == "community-members" else {}), [f"https://ohp.crestwood.on.ca/ohp-type/{term}/"],
        ))
        public = (
            '<link rel="canonical" href="https://ohp.crestwood.on.ca/ohp/new-name/">'
            '<title>Current Name – CRESTWOOD</title><div class="entry-content">'
            '<p>He later visited London in 1948.</p></div>'
        )
        pages = {
            "old-name": public, "new-name": public,
            "public-empty": '<title>Empty Profile – CRESTWOOD</title><div class="entry-content"></div>',
            "private": '<div class="entry-content"><form class="post-password-form"><input name="post_password"></form></div>',
        }
        monkeypatch.setattr(scrape_all, "_get", lambda url, path, refresh: pages[url.rstrip("/").split("/")[-1]])
        report = scrape_all.reconcile()
        records = {record["survivor_id"]: record for record in json.loads(source_path.read_text(encoding="utf-8"))["people"]}
        assert set(records) == {"new-name", "public-empty"}
        assert records["new-name"]["text"] == original["text"]
        assert records["new-name"]["waypoints"] == original["waypoints"]
        assert records["new-name"]["source_aliases"] == ["old-name"]
        assert records["public-empty"]["text"] == ""
        assert report["aliases"] == {"old-name": "new-name"}
        assert report["protected"] == ["private"]
        assert report["missing_public_profiles"] == []
        assert report["unresolved"] == {}
        assert private["text"] not in report_path.read_text(encoding="utf-8")
        assert private["text"] not in source_path.read_text(encoding="utf-8")
        retained = json.loads(index_path.read_text(encoding="utf-8"))["profiles"]
        assert set(retained) == {"new-name"}
        assert retained["new-name"]["videos"]["123"] == video
        assert retained["new-name"]["archive_url"].endswith("/new-name/")
    finally:
        shutil.rmtree(root)


def test_current_public_listing_coverage_is_explicit_and_complete():
    report = json.loads(config.OHP_RECONCILIATION.read_text(encoding="utf-8"))
    source = json.loads((config.DATA / "source" / "ohp_all.json").read_text(encoding="utf-8"))
    ids = {record["survivor_id"] for record in source["people"]}
    assert report["published_profiles"] == len(ids)
    assert not report["missing_public_profiles"]
    assert not report["unresolved"]
    assert not report["unlisted_public_profiles"]
    assert not (set(report["protected"]) & ids)
    assert len(ids) + len(report["other_pages"]) == report["listed_public_pages"]
    assert report["aliases"].get("thomas-jack") == "thomas-jack-c"
    assert "thomas-jack-c" in ids and "thomas-jack" not in ids
    assert {"norton-bruce", "sullivan-steve"} <= ids
