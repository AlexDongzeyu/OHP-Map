"""Read-only access to the committed Vimeo caption-coverage index."""
from __future__ import annotations

import json
from functools import lru_cache

from . import config

_FINAL_VIDEO_STATUSES = {
    "captioned",
    "caption-track-unavailable",
    "no-public-captions",
    "unavailable",
}


@lru_cache(maxsize=1)
def _load() -> dict:
    if not config.VIMEO_CAPTION_INDEX.exists():
        return {"veterans": {}}
    return json.loads(config.VIMEO_CAPTION_INDEX.read_text(encoding="utf-8"))


def _coverage(entry: dict) -> dict:
    video_count = int(entry.get("video_count", 0))
    captioned = int(entry.get("captioned_video_count", 0))
    available = int(entry.get("available_video_count", 0))
    videos = entry.get("videos", {})
    audited = sum(
        video.get("status") in _FINAL_VIDEO_STATUSES
        for video in videos.values()
    )
    video_ids = sorted(videos)
    inventory_hash = 2166136261
    for character in ",".join(video_ids):
        inventory_hash ^= ord(character)
        inventory_hash = (inventory_hash * 16777619) & 0xFFFFFFFF
    if audited < video_count:
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
        "video_inventory": f"{len(video_ids)}:{inventory_hash:08x}",
        "captioned_video_count": captioned,
        "transcript_status": status,
    }


def coverage(slug: str) -> dict:
    entry = _load().get("veterans", {}).get(slug, {})
    return _coverage(entry)
