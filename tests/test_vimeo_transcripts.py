import json

from pipeline import config, transcript_index


def _documents():
    source = json.loads(
        (config.DATA / "source" / "ohp_all.json").read_text(encoding="utf-8"),
    )
    captions = json.loads(config.VIMEO_CAPTION_INDEX.read_text(encoding="utf-8"))
    return source, captions


def test_caption_index_covers_every_veteran_page():
    source, captions = _documents()
    veteran_ids = {
        person["survivor_id"]
        for person in source["people"]
        if person.get("group") == "Military Veterans"
    }
    assert veteran_ids == set(captions["veterans"])
    assert all(
        entry["video_count"] == len(entry["videos"])
        for entry in captions["veterans"].values()
    )
    total_videos = sum(
        entry["video_count"] for entry in captions["veterans"].values()
    )
    total_captioned = sum(
        entry["captioned_video_count"] for entry in captions["veterans"].values()
    )
    assert total_videos > 5_000
    assert total_captioned > 400


def test_committed_index_contains_no_full_transcripts_or_signed_urls():
    _, captions = _documents()
    serialized = json.dumps(captions)
    assert "WEBVTT" not in serialized
    for entry in captions["veterans"].values():
        for video in entry["videos"].values():
            assert "url" not in video
            assert video["status"] in {
                "captioned",
                "caption-track-unavailable",
                "no-public-captions",
                "unavailable",
            }


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
