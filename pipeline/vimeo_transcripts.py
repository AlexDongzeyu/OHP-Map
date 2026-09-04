"""Audit public Vimeo caption tracks referenced by OHP veteran pages.

The full VTT text stays in the ignored transcript cache. The committed index stores
only availability and provenance metadata so the website can report coverage without
republishing interview transcripts.
"""
from __future__ import annotations

import argparse
import json
import re
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone

from curl_cffi import requests

from . import config


_VIDEO_RE = re.compile(r"player\.vimeo\.com/video/(\d+)")
_PLAYER_CONFIG = "window.playerConfig = "
_FINAL_STATUSES = {
    "captioned",
    "caption-track-unavailable",
    "no-public-captions",
    "unavailable",
}


def _veterans() -> list[dict]:
    document = json.loads(
        (config.DATA / "source" / "ohp_all.json").read_text(encoding="utf-8"),
    )
    return sorted(
        (
            person for person in document["people"]
            if person.get("group") == "Military Veterans"
        ),
        key=lambda person: person["survivor_id"],
    )


def _video_ids(slug: str) -> list[str]:
    page = config.DATA / "source" / "pages_cache" / f"{slug}.html"
    if not page.exists():
        raise FileNotFoundError(f"Missing cached OHP page: {page}")
    html = page.read_text(encoding="utf-8", errors="ignore")
    return list(dict.fromkeys(_VIDEO_RE.findall(html)))


def _load_index() -> dict:
    if config.VIMEO_CAPTION_INDEX.exists():
        return json.loads(config.VIMEO_CAPTION_INDEX.read_text(encoding="utf-8"))
    return {
        "_about": (
            "Vimeo caption availability for OHP military-veteran videos. "
            "Full caption text is cached locally and is not committed or published."
        ),
        "source": "Public Vimeo player metadata linked from OHP pages",
        "veterans": {},
    }


def _sync_video_inventory(entry: dict, video_ids: list[str]) -> None:
    current_ids = set(video_ids)
    entry["video_count"] = len(video_ids)
    entry["videos"] = {
        video_id: video
        for video_id, video in entry.get("videos", {}).items()
        if video_id in current_ids
    }


def _write_index(document: dict) -> None:
    document["updated_at"] = datetime.now(timezone.utc).isoformat()
    temporary = config.VIMEO_CAPTION_INDEX.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(config.VIMEO_CAPTION_INDEX)


def _english_track(tracks: list[dict]) -> dict | None:
    return next(
        (
            track for track in tracks
            if str(track.get("lang", "")).lower().startswith("en")
        ),
        tracks[0] if tracks else None,
    )


def _check_video(video_id: str, archive_url: str) -> dict:
    checked_at = datetime.now(timezone.utc).isoformat()
    url = f"https://player.vimeo.com/video/{video_id}?title=0&byline=0"
    response = requests.get(
        url,
        headers={"Referer": archive_url},
        impersonate="chrome",
        timeout=45,
    )
    if response.status_code in {401, 403, 404}:
        return {
            "id": video_id,
            "status": "unavailable",
            "http_status": response.status_code,
            "checked_at": checked_at,
        }
    response.raise_for_status()
    offset = response.text.find(_PLAYER_CONFIG)
    if offset < 0:
        raise ValueError("Vimeo player config was not present")
    offset += len(_PLAYER_CONFIG)
    player, _ = json.JSONDecoder().raw_decode(response.text[offset:])
    video = player.get("video", {})
    tracks = player.get("request", {}).get("text_tracks", [])
    selected = _english_track(tracks)
    result = {
        "id": video_id,
        "title": video.get("title") or "",
        "duration_seconds": video.get("duration") or 0,
        "checked_at": checked_at,
    }
    if not selected:
        result["status"] = "no-public-captions"
        return result
    caption_response = requests.get(
        selected["url"],
        impersonate="chrome",
        timeout=45,
    )
    if caption_response.status_code in {401, 403, 404}:
        result.update({
            "status": "caption-track-unavailable",
            "caption_id": selected.get("id"),
            "language": selected.get("lang"),
            "label": selected.get("label"),
            "provenance": selected.get("provenance"),
            "caption_http_status": caption_response.status_code,
        })
        return result
    caption_response.raise_for_status()
    config.TRANSCRIPT_CACHE.mkdir(parents=True, exist_ok=True)
    caption_path = config.TRANSCRIPT_CACHE / f"{video_id}.vtt"
    caption_path.write_text(caption_response.text, encoding="utf-8")
    result.update({
        "status": "captioned",
        "caption_id": selected.get("id"),
        "language": selected.get("lang"),
        "label": selected.get("label"),
        "provenance": selected.get("provenance"),
        "caption_bytes": len(caption_response.content),
    })
    return result


def audit(
    *,
    refresh: bool = False,
    limit_veterans: int | None = None,
    workers: int = 3,
    delay: float = 0.3,
) -> dict:
    document = _load_index()
    veterans = _veterans()
    if limit_veterans:
        veterans = veterans[:limit_veterans]

    jobs = []
    for veteran in veterans:
        slug = veteran["survivor_id"]
        ids = _video_ids(slug)
        entry = document["veterans"].setdefault(slug, {
            "archive_url": veteran["archive_url"],
            "videos": {},
        })
        entry["archive_url"] = veteran["archive_url"]
        _sync_video_inventory(entry, ids)
        for video_id in ids:
            existing = entry["videos"].get(video_id, {})
            if refresh or existing.get("status") not in _FINAL_STATUSES:
                jobs.append((slug, video_id, veteran["archive_url"]))

    print(f"Auditing {len(jobs)} Vimeo videos across {len(veterans)} veterans.")
    completed = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        pending = {}
        job_iter = iter(jobs)
        exhausted = False
        while pending or not exhausted:
            while len(pending) < max(1, workers) and not exhausted:
                try:
                    slug, video_id, archive_url = next(job_iter)
                except StopIteration:
                    exhausted = True
                    break
                pending[pool.submit(_check_video, video_id, archive_url)] = (
                    slug,
                    video_id,
                )
                time.sleep(max(0, delay))
            if not pending:
                continue
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                slug, video_id = pending.pop(future)
                try:
                    result = future.result()
                except (requests.RequestsError, ValueError) as error:
                    result = {
                        "id": video_id,
                        "status": "error",
                        "error": str(error),
                        "checked_at": datetime.now(timezone.utc).isoformat(),
                    }
                document["veterans"][slug]["videos"][video_id] = result
                completed += 1
                if completed % 25 == 0:
                    _write_index(document)
                    print(f"  {completed}/{len(jobs)} checked")

    for entry in document["veterans"].values():
        videos = list(entry["videos"].values())
        entry["captioned_video_count"] = sum(
            video.get("status") == "captioned" for video in videos
        )
        entry["available_video_count"] = sum(
            video.get("status") in {"captioned", "no-public-captions"}
            for video in videos
        )
        entry.pop("highlight", None)
    _write_index(document)
    return document


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Audit and cache public Vimeo captions for OHP veterans.",
    )
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--limit-veterans", type=int)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--delay", type=float, default=0.3)
    args = parser.parse_args(argv)
    document = audit(
        refresh=args.refresh,
        limit_veterans=args.limit_veterans,
        workers=args.workers,
        delay=args.delay,
    )
    entries = list(document["veterans"].values())
    print(
        f"Indexed {len(entries)} veterans: "
        f"{sum(entry.get('video_count', 0) for entry in entries)} videos, "
        f"{sum(entry.get('captioned_video_count', 0) for entry in entries)} captioned.",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
