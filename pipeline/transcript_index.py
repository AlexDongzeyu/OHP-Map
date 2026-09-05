"""Read-only access to the committed Vimeo caption-coverage index."""
from __future__ import annotations

import json
from functools import lru_cache

from . import config, media

_FINAL_VIDEO_STATUSES = {
    "captioned",
    "caption-track-unavailable",
    "no-public-captions",
    "unavailable",
}


@lru_cache(maxsize=1)
def _load() -> dict:
    if not config.VIMEO_CAPTION_INDEX.exists():
        return {"profiles": {}}
    return json.loads(config.VIMEO_CAPTION_INDEX.read_text(encoding="utf-8"))


def _coverage(entry: dict) -> dict:
    video_count = int(entry.get("video_count", 0))
    videos = entry.get("videos", {})
    captioned = sum(video.get("status") == "captioned" for video in videos.values())
    available = sum(
        video.get("status") in {"captioned", "no-public-captions", "caption-track-unavailable"}
        for video in videos.values()
    )
    audited = sum(
        video.get("status") in _FINAL_VIDEO_STATUSES
        for video in videos.values()
    )
    if audited < video_count or entry.get("source_status", "public") != "public":
        status = "pending"
    elif captioned == video_count and video_count:
        status = "complete"
    elif captioned:
        status = "partial"
    elif available:
        status = "none"
    elif video_count:
        status = "unavailable"
    else:
        status = "none"
    return {
        "video_count": video_count,
        "video_inventory": media.video_inventory(list(videos)),
        "video_source_inventory": entry.get("source_inventory", media.source_inventory([])),
        "captioned_video_count": captioned,
        "transcript_status": status,
    }


def entry_for(slug: str) -> dict:
    document = _load()
    return document.get("profiles", document.get("veterans", {})).get(slug, {})


def coverage(slug: str, videos: list[dict] | None = None) -> dict:
    entry = entry_for(slug)
    if videos is not None:
        entry = {
            **entry, "video_count": len(videos),
            "source_inventory": media.source_inventory(videos),
            "videos": {video["id"]: video for video in videos},
        }
    return _coverage(entry)
