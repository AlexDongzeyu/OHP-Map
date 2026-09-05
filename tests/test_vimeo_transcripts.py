import json
import hashlib
import shutil
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from pipeline import config, media, transcript_index, vimeo_transcripts as audit
from pipeline.vimeo_transcripts import _sync_video_inventory


@pytest.fixture
def workspace(monkeypatch):
    path = config.DATA / "source" / f".caption-test-{uuid4().hex}"
    path.mkdir()
    monkeypatch.setattr(config, "TRANSCRIPT_CACHE", path / "captions")
    monkeypatch.setattr(config, "VIMEO_CAPTION_INDEX", path / "index.json")
    monkeypatch.setattr(audit, "CACHE_DIR", path / "pages")
    yield path
    transcript_index._load.cache_clear()
    shutil.rmtree(path)


def _documents():
    source = json.loads(
        (config.DATA / "source" / "ohp_all.json").read_text(encoding="utf-8"),
    )
    captions = json.loads(config.VIMEO_CAPTION_INDEX.read_text(encoding="utf-8"))
    return source, captions


def test_caption_index_covers_every_public_archive_group():
    source, captions = _documents()
    profile_ids = {person["survivor_id"] for person in source["people"]}
    assert profile_ids == set(captions["profiles"])
    assert all(
        entry["video_count"] == len(entry["videos"])
        for entry in captions["profiles"].values()
    )
    total_videos = sum(
        entry["video_count"] for entry in captions["profiles"].values()
    )
    total_captioned = sum(
        entry["captioned_video_count"] for entry in captions["profiles"].values()
    )
    assert total_videos > 9_000
    assert total_captioned > 400
    assert {entry["group"] for entry in captions["profiles"].values()} == {
        person["group"] for person in source["people"]
    }
    assert all(entry["source_status"] == "public" for entry in captions["profiles"].values())
    assert captions["summary"]["statuses"].get("pending", 0) == 0
    assert set(captions["other_pages"]) == {page["survivor_id"] for page in media.other_source_pages()}
    assert captions["summary"]["source_page_count"] == len(captions["profiles"]) + len(captions["other_pages"])


def test_committed_index_contains_no_full_transcripts_or_signed_urls():
    _, captions = _documents()
    serialized = json.dumps(captions)
    assert "WEBVTT" not in serialized
    for value in ("https://captions.", "signature=", "expires=", "token="):
        assert value not in serialized.lower()
    for entry in [*captions["profiles"].values(), *captions["other_pages"].values()]:
        for video in entry["videos"].values():
            assert "url" not in video
            assert video["status"] in media.VIDEO_STATUSES
            reference = media.safe_vimeo_reference(video["embed_url"])
            assert reference and reference["id"] == video["id"]
            assert all("url" not in track for track in video.get("tracks", []))


def test_caption_coverage_status_is_derived_consistently():
    coverage = transcript_index.coverage("adam-wally")
    assert coverage["video_count"] == 6
    assert coverage["video_inventory"] == "6:b91d421c"
    assert coverage["captioned_video_count"] == 6
    assert coverage["transcript_status"] == "complete"


def test_transient_caption_errors_remain_pending():
    coverage = transcript_index._coverage({
        "video_count": 1,
        "captioned_video_count": 0,
        "available_video_count": 0,
        "videos": {"123": {"status": "error"}},
    })
    assert coverage["transcript_status"] == "pending"


@pytest.mark.parametrize(("tracks", "complete", "expected"), [
    ([{"status": "cached"}, {"status": "error"}], False, 1),
    ([{"status": "cached"}], False, 1),
    ([{"status": "cached"}, {"status": "pending"}], False, 1),
    ([{"status": "cached"}], True, 0),
])
def test_cli_does_not_report_success_with_incomplete_track_audits(monkeypatch, tracks, complete, expected):
    document = {
        "profiles": {
            "person": {
                "source_status": "public", "group": "Military Veterans",
                "videos": {"123": {
                    "id": "123", "status": "captioned",
                    "tracks": tracks, "track_audit_complete": complete,
                }},
            },
        },
        "other_pages": {},
    }
    audit._summarize(document)
    document["summary"]["cache_integrity"] = {"missing_or_invalid_tracks": 0}
    monkeypatch.setattr(audit, "audit", lambda **kwargs: document)
    assert audit.main([]) == expected


def test_resumed_audit_prunes_removed_video_ids():
    entry = {
        "video_count": 2,
        "videos": {
            "1": {"status": "captioned"},
            "2": {"status": "no-public-captions"},
        },
    }
    _sync_video_inventory(entry, ["1"])
    assert entry["video_count"] == 1
    assert set(entry["videos"]) == {"1"}


def test_source_fingerprint_detects_unlisted_hash_changes_without_breaking_id_fingerprint():
    before = media.safe_vimeo_reference("https://player.vimeo.com/video/123?h=abc123def0")
    after = media.safe_vimeo_reference("https://player.vimeo.com/video/123?h=fed987abc0")
    assert media.video_inventory([before["id"]]) == media.video_inventory([after["id"]])
    assert media.source_inventory([before]) != media.source_inventory([after])


def test_legacy_veteran_index_migrates_without_discarding_checks(workspace):
    entry = {
        "archive_url": "https://ohp.crestwood.on.ca/ohp/person/",
        "videos": {"123": {"id": "123", "status": "unavailable"}},
    }
    config.VIMEO_CAPTION_INDEX.write_text(json.dumps({"veterans": {"person": entry}}), encoding="utf-8")
    migrated = audit._load_index()
    assert migrated["profiles"]["person"] == entry
    assert "veterans" not in migrated
    assert migrated["version"] == 2


def test_recent_results_require_matching_source_and_access_reference():
    video = media.safe_vimeo_reference("https://player.vimeo.com/video/123?h=abcdef1234")
    result = {
        "id": "123", "status": "unavailable", "checked_at": datetime.now(timezone.utc).isoformat(),
        "embed_url": video["embed_url"],
    }
    assert audit._reusable(result, video, same_source=True, max_age_days=7)
    assert not audit._reusable(result, video, same_source=False, max_age_days=7)
    assert not audit._reusable({**result, "id": "124"}, video, same_source=True, max_age_days=7)
    assert not audit._reusable(
        {**result, "embed_url": "https://player.vimeo.com/video/123"},
        video, same_source=True, max_age_days=7,
    )
    assert not audit._reusable(
        {**result, "checked_at": "2020-01-01T00:00:00+00:00"},
        video, same_source=True, max_age_days=7,
    )
    legacy = {key: value for key, value in result.items() if key != "embed_url"}
    assert not audit._reusable(legacy, video, same_source=True, max_age_days=7)
    ordinary = media.safe_vimeo_reference("https://player.vimeo.com/video/123?title=0")
    assert audit._reusable(legacy, ordinary, same_source=True, max_age_days=7)


class Response:
    def __init__(self, body, status=200):
        self.status_code = status
        self.text = body
        self.content = body.encode("utf-8")

    def raise_for_status(self):
        if self.status_code >= 400:
            raise ValueError("HTTP response error")


def test_every_public_track_is_cached_without_persisting_signed_urls(workspace, monkeypatch):
    video = media.safe_vimeo_reference("https://player.vimeo.com/video/123?h=abcdef1234")
    player = {
        "video": {"title": "Actual chapter title"},
        "request": {"text_tracks": [
            {"id": 11, "lang": "en", "label": "English", "url": "https://captions.cloud.vimeo.com/en?token=private"},
            {"id": 12, "lang": "fr", "label": "French", "url": "https://captions.cloud.vimeo.com/fr?token=private"},
        ]},
    }
    vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nPublic test caption.\n"
    calls = []

    def request(url, *args, **kwargs):
        calls.append(url)
        return Response("window.playerConfig = " + json.dumps(player)) if "player.vimeo" in url else Response(vtt)

    monkeypatch.setattr(audit, "_request", request)
    result = audit._check_video(video, "https://ohp.crestwood.on.ca/ohp/person/")
    assert calls[0] == video["embed_url"]
    assert result["status"] == "captioned"
    assert result["cached_track_count"] == 2
    assert {track["language"] for track in result["tracks"]} == {"en", "fr"}
    assert all(audit._cache_valid(track) for track in result["tracks"])
    assert {path.name for path in config.TRANSCRIPT_CACHE.iterdir()} == {"123.vtt", "123.12.vtt"}
    assert "token" not in json.dumps(result)
    assert "Public test caption" not in json.dumps(result)
    assert audit._reusable(result, video, same_source=True, max_age_days=7)
    (config.TRANSCRIPT_CACHE / "123.12.vtt").unlink()
    assert not audit._reusable(result, video, same_source=True, max_age_days=7)


def test_missing_or_corrupt_caption_cache_invalidates_completed_audit(workspace):
    config.TRANSCRIPT_CACHE.mkdir()
    data = b"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nExample.\n"
    track = {
        "status": "cached", "cache_file": "123.vtt", "caption_bytes": len(data),
        "caption_sha256": hashlib.sha256(data).hexdigest(),
    }
    path = config.TRANSCRIPT_CACHE / track["cache_file"]
    assert not audit._cache_valid(track)
    path.write_bytes(data)
    assert audit._cache_valid(track)
    path.write_bytes(data.replace(b"Example", b"Changed"))
    assert not audit._cache_valid(track)
    assert not audit._cache_valid({**track, "cache_file": "../123.vtt"})


@pytest.mark.parametrize("caption_status,expected", [(403, "caption-track-unavailable"), (500, "error")])
def test_caption_access_failures_are_not_reported_as_no_public_captions(workspace, monkeypatch, caption_status, expected):
    player = {
        "video": {}, "request": {"text_tracks": [{
            "id": 11, "lang": "en", "url": "https://captions.cloud.vimeo.com/en?token=private",
        }]},
    }
    monkeypatch.setattr(audit, "_request", lambda url, *args, **kwargs: (
        Response("window.playerConfig = " + json.dumps(player))
        if "player.vimeo" in url else Response("unavailable", caption_status)
    ))
    result = audit._check_video("123", "https://ohp.crestwood.on.ca/ohp/person/")
    assert result["status"] == expected
    assert "token" not in json.dumps(result)


def test_all_profile_audit_fetches_missing_source_and_reconciles_inventory(workspace, monkeypatch):
    person = {
        "survivor_id": "person", "name": "Person", "group": "Community Members",
        "archive_url": "https://ohp.crestwood.on.ca/ohp/person/",
    }
    source = '<div class="entry-content"><a href="https://player.vimeo.com/video/123?h=abcdef1234">School memories</a></div>'
    monkeypatch.setattr(audit, "_profiles", lambda group=None: [person])
    monkeypatch.setattr(media, "other_source_pages", lambda: [])
    fetched = []

    def get(url, path, refresh):
        fetched.append((url, path, refresh))
        return source

    monkeypatch.setattr(audit, "_get", get)
    monkeypatch.setattr(audit, "_check_video", lambda video, url, gate=None: {
        "id": video["id"], "embed_url": video["embed_url"],
        "checked_at": datetime.now(timezone.utc).isoformat(), "status": "no-public-captions",
    })
    document = audit.audit(workers=1, delay=0)
    entry = document["profiles"]["person"]
    assert fetched[0][0] == person["archive_url"]
    assert entry["video_order"] == ["123"]
    assert entry["group"] == "Community Members"
    assert entry["videos"]["123"]["source_title"] == "School memories"
    assert document["summary"]["statuses"] == {"no-public-captions": 1}
    assert transcript_index._coverage(entry)["transcript_status"] == "none"


def test_recorded_caption_cache_is_intact_when_local_cache_is_present():
    if not config.TRANSCRIPT_CACHE.exists():
        pytest.skip("Complete VTT files are intentionally not committed")
    _, document = _documents()
    tracks = [
        track for entry in [*document["profiles"].values(), *document["other_pages"].values()]
        for video in entry["videos"].values() for track in video.get("tracks", [])
        if track["status"] == "cached"
    ]
    assert tracks
    assert all(audit._cache_valid(track) for track in tracks)
