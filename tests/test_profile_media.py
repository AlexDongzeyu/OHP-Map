import json
import shutil
from uuid import uuid4

import pytest

from pipeline import build, config, extract, ingest, media, scrape_ohp


HTML = """
<img src="https://ohp.crestwood.on.ca/wp-content/uploads/site-logo.png">
<article><div class="entry-content">
  <p>A public biography.</p>
  <div id="ohp-video">
    <a href="https://player.vimeo.com/video/123?title=0&amp;h=abcdef1234&amp;token=never-publish">1. Early life &amp; school</a>
    <a href="https://player.vimeo.com/video/124">Watch video</a>
    <a href="https://player.vimeo.com/video/123">Duplicate player</a>
    <a href="https://vimeo.com/125/987abc654f">3. Returning home</a>
    <a href="https://player.vimeo.com.invalid/video/126">Not an official player</a>
  </div>
  <div id="ohp-photo">
    <a href="https://ohp.crestwood.on.ca/wp-content/uploads/2020/portrait.jpg">
      <img src="https://ohp.crestwood.on.ca/wp-content/uploads/2020/portrait-150x150.jpg" alt="A source caption">
    </a>
    <img src="https://ohp.crestwood.on.ca/wp-content/uploads/2020/portrait-300x300.jpg">
    <img src="https://ohp.crestwood.on.ca/wp-content/uploads/2020/family.jpg">
    <img src="https://ohp.crestwood.on.ca/wp-content/uploads/2020/site-logo.png">
    <img src="https://ohp.crestwood.on.ca/wp-content/themes/logo.png">
  </div>
</div><!-- .entry-content --></article>
"""
ARCHIVE_URL = "https://ohp.crestwood.on.ca/ohp/person/"


def test_source_chapter_order_titles_and_public_unlisted_references_are_preserved():
    result = media.parse_profile_media(HTML, ARCHIVE_URL, "A Person")
    videos = result["videos"]
    assert [video["id"] for video in videos] == ["123", "124", "125"]
    assert [video["title"] for video in videos] == [
        "1. Early life & school", "Interview chapter 2", "3. Returning home",
    ]
    assert "h=abcdef1234" in videos[0]["embed_url"]
    assert "h=987abc654f" in videos[2]["embed_url"]
    assert "token" not in json.dumps(result)
    assert all(video["status"] == "pending" for video in videos)


def test_gallery_uses_original_source_images_without_duplicate_sizes_or_site_decoration():
    images = media.parse_profile_media(HTML, ARCHIVE_URL, "A Person")["images"]
    assert len(images) == 2
    assert images[0]["url"].endswith("/portrait.jpg")
    assert images[0]["caption"] == "A source caption"
    assert images[0]["full_url"] == images[0]["source_url"]
    assert images[1]["caption"] == "Photograph from A Person's OHP archive."
    assert all(image["credit"] and image["rights"] for image in images)


def test_avif_source_photographs_are_supported_without_replacing_the_cleared_local_portrait():
    url = "https://ohp.crestwood.on.ca/wp-content/uploads/2024/08/police-awards.avif"
    assert media.safe_photo_url(url) == url
    result = media.parse_profile_media(
        f'<div class="entry-content"><img src="{url}"></div>', ARCHIVE_URL,
    )
    assert result["images"][0]["source_url"] == url


@pytest.mark.parametrize("url", [
    "javascript:alert(1)", "https://player.vimeo.com.invalid/video/123",
    "https://player.vimeo.com@other.invalid/video/123", "https://player.vimeo.com:8443/video/123",
    "https://captions.cloud.vimeo.com/texttrack/123?token=secret",
    "https://player.vimeo.com/video/123/config", "https://vimeo.com/manage/videos/123",
    "https://player.vimeo.com/video/123?h=%E0%A4%A",
    "https://player.vimeo.com/video/123?h=abc",
    "https://player.vimeo.com/video/123?h=abcdef1234&h=987654fedc",
])
def test_nonofficial_or_nonplayer_references_are_rejected(url):
    assert media.safe_vimeo_reference(url) is None


def test_a_later_public_hash_repairs_an_earlier_bare_duplicate_in_place():
    source = """<div class="entry-content">
      <a href="https://player.vimeo.com/video/1">First chapter</a>
      <a href="https://player.vimeo.com/video/2">Second chapter</a>
      <a href="https://player.vimeo.com/video/1?h=abcdef1234">First chapter again</a>
    </div>"""
    videos = media.parse_profile_media(source, ARCHIVE_URL)["videos"]
    assert [video["id"] for video in videos] == ["1", "2"]
    assert videos[0]["title"] == "First chapter"
    assert "h=abcdef1234" in videos[0]["embed_url"]


def test_protected_pages_never_yield_biography_or_media():
    source = HTML.replace('<p>A public biography.</p>', '<form class="post-password-form"><input name="post_password"></form>')
    assert media.page_status(source, ARCHIVE_URL) == "protected"
    assert media.parse_profile_media(source, ARCHIVE_URL) == {"images": [], "videos": []}
    assert media.biography_text(source) == ""


def test_media_only_page_does_not_turn_a_chapter_title_into_a_biography():
    source = '<div class="entry-content"><div id="ohp-video"><a href="https://player.vimeo.com/video/123">Canada memories</a></div></div>'
    record = scrape_ohp.parse_entry("media-only", source)
    assert record["text"] == ""
    assert record["quote_text"] == ""
    assert len(record["profile_media"]["videos"]) == 1


def test_wrong_source_canonical_and_error_pages_are_invalid():
    assert media.page_status("<h1>Server error</h1>", ARCHIVE_URL) == "invalid"
    assert media.page_status(
        '<link rel="canonical" href="https://ohp.crestwood.on.ca/ohp/different/">' + HTML,
        ARCHIVE_URL,
    ) == "invalid"


def test_biography_preserves_words_continued_in_a_second_html_block():
    source = """<article><div class="entry-content">
      <div>Doug was born in Toronto. He graduated from Upper Canada College and the</div>
      <div>University of Toronto. His later work is described here.</div>
      <div id="ohp-video"><a href="https://player.vimeo.com/video/123">Video chapter title</a></div>
      <div id="ohp-photo"><img src="https://ohp.crestwood.on.ca/wp-content/uploads/2020/photo.jpg"></div>
    </div><!-- .entry-content --></article>"""
    assert media.biography_text(source) == (
        "Doug was born in Toronto. He graduated from Upper Canada College and the "
        "University of Toronto. His later work is described here."
    )


@pytest.mark.parametrize("url", [
    "https://ohp.crestwood.on.ca/wp-content/uploads/bad%zz.jpg",
    "https://ohp.crestwood.on.ca/wp-content/uploads/bad%E0%A4%A.jpg",
])
def test_malformed_photo_encoding_is_rejected_without_permissive_recovery(url):
    assert media.safe_photo_url(url) is None
    assert media.parse_profile_media(
        f'<div class="entry-content"><img src="{url}"></div>', ARCHIVE_URL,
    )["images"] == []


def test_local_primary_reuses_cleared_manifest_source_without_losing_gallery(monkeypatch):
    root = config.ROOT / "data" / "source" / f".media-test-{uuid4().hex}"
    path = root / "assets" / "portraits" / "person.webp"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"local-image-fixture")
    try:
        monkeypatch.setattr(config, "ROOT", root)
        monkeypatch.setattr(config, "DATA", root / "data")
        monkeypatch.setattr(media, "_portraits", lambda: {
            "person": {
                "portrait": "assets/portraits/person.webp",
                "portrait_rights": "Reuse permission granted.",
                "source_url": "https://ohp.crestwood.on.ca/wp-content/uploads/2020/portrait-150x150.jpg",
            },
        })
        source = media.parse_profile_media(HTML, ARCHIVE_URL, "A Person")
        record = {"survivor_id": "person", "name": "A Person", "archive_url": ARCHIVE_URL, "profile_media": source}
        bare = media.safe_vimeo_reference("https://player.vimeo.com/video/124")
        checked = {"videos": {"124": {**bare, "title": "Actual player chapter title", "status": "captioned", "language": "en"}}}
        result = media.profile_media(record, checked)
        assert len(result["images"]) == 2
        assert result["images"][0]["url"] == "assets/portraits/person.webp"
        assert result["images"][0]["source_url"].endswith("/portrait.jpg")
        assert result["images"][0]["primary"] is True
        assert result["images"][0]["rights"] == "Reuse permission granted."
        assert result["images"][0]["full_url"] == result["images"][0]["source_url"]
        assert "full_url" not in result["images"][1]
        assert result["videos"][1]["title"] == "Actual player chapter title"
        assert result["videos"][1]["status"] == "captioned"
        assert result["videos"][0]["status"] == "pending"
    finally:
        shutil.rmtree(root)


def test_distilled_source_snapshot_covers_profiles_without_private_caption_material():
    source = json.loads((config.DATA / "source" / "ohp_all.json").read_text(encoding="utf-8"))
    snapshot = json.loads(config.PROFILE_MEDIA_INDEX.read_text(encoding="utf-8"))
    assert set(snapshot["profiles"]) == {record["survivor_id"] for record in source["people"]}
    assert set(snapshot["other_pages"]) == {record["survivor_id"] for record in media.other_source_pages()}
    serialized = json.dumps(snapshot)
    assert "WEBVTT" not in serialized
    assert "https://captions." not in serialized
    assert "token=" not in serialized
    assert all(entry["source_status"] == "public" for entry in snapshot["profiles"].values())


def test_quotes_and_galleries_build_without_the_ignored_html_cache(monkeypatch):
    records = {record["survivor_id"]: record for record in ingest.AllSource().fetch()}
    portraits = {
        entry["survivor_id"]: entry for entry in json.loads(
            (config.DATA / "portraits" / "manifest.json").read_text(encoding="utf-8")
        )["portraits"]
    }
    monkeypatch.setattr(config, "DATA", config.ROOT / f".absent-source-{uuid4().hex}")
    monkeypatch.setattr(media, "_portraits", lambda: portraits)
    record = build._record_to_survivor(records["scott-doug"], extract.OfflineExtractor())
    assert record["profile_media"]["images"]
    assert any(image.get("primary") for image in record["profile_media"]["images"])
    assert record["video_count"] > 0
    assert record["waypoints"][1]["source_quote"] == (
        "He graduated from Upper Canada College and the University of Toronto."
    )
    empty = build._record_to_survivor(records["vertes-berlina"], extract.OfflineExtractor())
    assert empty["bio_excerpt"] == ""
    assert empty["waypoints"] == []
    assert len(empty["profile_media"]["videos"]) == 7
