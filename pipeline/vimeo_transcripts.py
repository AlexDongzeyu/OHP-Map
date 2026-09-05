"""Resumable audit of every public Vimeo chapter linked from every OHP group.

Only safe public source/player references and coverage metadata are published.
Signed caption URLs stay in memory; complete VTTs stay in the ignored local cache.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import threading
import time
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from curl_cffi import requests

from . import config, media
from .scrape_ohp import CACHE_DIR, _get


_FINAL_STATUSES = {
    "captioned", "caption-track-unavailable", "no-public-captions", "unavailable",
}
_PLAYER_CONFIG = re.compile(r"(?:window\.)?playerConfig\s*=\s*")
_UNAVAILABLE_HTTP = {401, 403, 404, 410}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RequestGate:
    """Space all player and caption requests, not just thread submissions."""

    def __init__(self, delay: float):
        self.delay = max(0, delay)
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self) -> None:
        with self.lock:
            time.sleep(max(0, self.next_at - time.monotonic()))
            self.next_at = time.monotonic() + self.delay


def _profiles(group: str | None = None) -> list[dict]:
    document = json.loads(
        (config.DATA / "source" / "ohp_all.json").read_text(encoding="utf-8"),
    )
    return sorted(
        (person for person in document["people"] if not group or person.get("group") == group),
        key=lambda person: person["survivor_id"],
    )


def _video_ids(slug: str) -> list[str]:
    page = CACHE_DIR / f"{slug}.html"
    if not page.exists():
        raise FileNotFoundError(f"Missing cached OHP page: {slug}")
    inventory = media.parse_profile_media(
        page.read_text(encoding="utf-8"), f"{config.WP_BASE}/ohp/{slug}/",
    )
    return [video["id"] for video in inventory["videos"]]


def _load_index() -> dict:
    if config.VIMEO_CAPTION_INDEX.exists():
        document = json.loads(config.VIMEO_CAPTION_INDEX.read_text(encoding="utf-8"))
    else:
        document = {}
    legacy = document.pop("veterans", {})
    document.setdefault("profiles", {}).update({
        slug: entry for slug, entry in legacy.items() if slug not in document.get("profiles", {})
    })
    document.setdefault("other_pages", {})
    document.update({
        "version": 2,
        "_about": (
            "Vimeo caption availability for all public OHP archive groups and registered non-profile pages. "
            "Public embed references preserve source-supplied unlisted hashes. "
            "Signed caption URLs and full caption text are never published."
        ),
        "source": "Public Vimeo player metadata linked from OHP pages",
    })
    return document


def _sync_video_inventory(entry: dict, videos: list) -> None:
    ids = [video if isinstance(video, str) else video["id"] for video in videos]
    entry["video_count"] = len(ids)
    entry["video_order"] = ids
    entry["video_inventory"] = media.video_inventory(ids)
    entry["videos"] = {
        video_id: entry.get("videos", {}).get(video_id, {"id": video_id, "status": "pending"})
        for video_id in ids
    }
    if videos and isinstance(videos[0], dict):
        entry["source_inventory"] = media.source_inventory(videos)
    elif not videos:
        entry["source_inventory"] = media.source_inventory([])


def _write_index(document: dict) -> None:
    document["updated_at"] = _now()
    config.VIMEO_CAPTION_INDEX.parent.mkdir(parents=True, exist_ok=True)
    staging = config.VIMEO_CAPTION_INDEX.with_suffix(".writing")
    staging.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    staging.replace(config.VIMEO_CAPTION_INDEX)


def _english_track(tracks: list[dict]) -> dict | None:
    return next(
        (track for track in tracks if str(track.get("lang", track.get("language", ""))).lower().startswith("en")),
        tracks[0] if tracks else None,
    )


def _valid_vtt(data: bytes) -> bool:
    text = data.decode("utf-8-sig", errors="replace").lstrip()
    return text.startswith("WEBVTT") and bool(re.search(
        r"(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}",
        text,
    ))


def _cache_valid(track: dict) -> bool:
    filename = track.get("cache_file", "")
    if not re.fullmatch(r"\d+(?:\.[a-zA-Z0-9_-]+)?\.vtt", filename):
        return False
    path = config.TRANSCRIPT_CACHE / filename
    if not path.is_file():
        return False
    data = path.read_bytes()
    return (
        _valid_vtt(data)
        and len(data) == track.get("caption_bytes")
        and hashlib.sha256(data).hexdigest() == track.get("caption_sha256")
    )


def _reusable(existing: dict, video: dict, *, same_source: bool, max_age_days: int) -> bool:
    if (
        not same_source or existing.get("status") not in _FINAL_STATUSES
        or existing.get("id") != video["id"]
    ):
        return False
    try:
        checked = datetime.fromisoformat(existing["checked_at"])
        if checked.tzinfo is None:
            return False
        age = datetime.now(timezone.utc) - checked
        if age < -timedelta(minutes=5) or age > timedelta(days=max_age_days):
            return False
    except (KeyError, TypeError, ValueError):
        return False
    if existing.get("embed_url"):
        if media.access_reference(existing) != media.access_reference(video):
            return False
    elif media.access_reference(video)[1]:
        return False  # The old auditor discarded source-supplied unlisted hashes.
    if existing["status"] in {"captioned", "caption-track-unavailable"}:
        tracks = existing.get("tracks", [])
        if not existing.get("track_audit_complete") or not tracks:
            return False  # Legacy selected-track audits did not inventory every track.
        if any(track.get("status") == "error" for track in tracks):
            return False
        if any(track.get("status") == "cached" and not _cache_valid(track) for track in tracks):
            return False
        if existing["status"] == "captioned" and not any(
            track.get("status") == "cached" for track in tracks
        ):
            return False
    return True


def _request(url: str, gate: RequestGate | None = None, **kwargs):
    if gate:
        gate.wait()
    return requests.get(url, impersonate="chrome", timeout=45, **kwargs)


def _caption_url(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        return (
            parsed.scheme == "https" and not parsed.username and not parsed.password
            and not parsed.port and bool(parsed.hostname)
            and any(
                parsed.hostname == domain or parsed.hostname.endswith("." + domain)
                for domain in ("vimeo.com", "vimeocdn.com")
            )
        )
    except (TypeError, ValueError):
        return False


def _check_video(video: dict | str, archive_url: str, gate: RequestGate | None = None) -> dict:
    if isinstance(video, str):
        video = media.safe_vimeo_reference(f"https://player.vimeo.com/video/{video}")
    reference = media.safe_vimeo_reference(video.get("embed_url", ""))
    if not reference:
        raise ValueError("invalid-public-embed-reference")
    video_id = reference["id"]
    result = {
        "id": video_id, "embed_url": reference["embed_url"], "checked_at": _now(),
    }
    response = _request(reference["embed_url"], gate, headers={"Referer": archive_url})
    if response.status_code in _UNAVAILABLE_HTTP:
        return {**result, "status": "unavailable", "http_status": response.status_code}
    response.raise_for_status()
    match = _PLAYER_CONFIG.search(response.text)
    if not match:
        if re.search(r"(?:this video is private|password|video (?:does not exist|is unavailable))", response.text, re.I):
            return {**result, "status": "unavailable", "reason": "player-access-restricted"}
        raise ValueError("player-metadata-not-present")
    player, _ = json.JSONDecoder().raw_decode(response.text[match.end():])
    metadata = player.get("video", {})
    result.update({
        "title": metadata.get("title") or "",
        "duration_seconds": metadata.get("duration") or 0,
    })
    tracks = player.get("request", {}).get("text_tracks") or []
    if not tracks:
        return {**result, "status": "no-public-captions", "tracks": [], "track_audit_complete": True}
    preferred = _english_track(tracks)
    audited = []
    for position, track in enumerate(tracks):
        item = {
            "id": track.get("id"),
            "language": track.get("lang"),
            "label": track.get("label"),
            "provenance": track.get("provenance"),
        }
        if not _caption_url(track.get("url", "")):
            audited.append({**item, "status": "unavailable", "reason": "invalid-caption-reference"})
            continue
        try:
            caption = _request(track["url"], gate)
            if caption.status_code in _UNAVAILABLE_HTTP:
                audited.append({**item, "status": "unavailable", "http_status": caption.status_code})
                continue
            caption.raise_for_status()
            data = caption.content
            if not _valid_vtt(data):
                audited.append({**item, "status": "unavailable", "reason": "invalid-vtt"})
                continue
            token = re.sub(r"[^a-zA-Z0-9_-]", "", str(track.get("id") or position))
            filename = f"{video_id}.vtt" if track is preferred else f"{video_id}.{token}.vtt"
            config.TRANSCRIPT_CACHE.mkdir(parents=True, exist_ok=True)
            (config.TRANSCRIPT_CACHE / filename).write_bytes(data)
            audited.append({
                **item, "status": "cached", "cache_file": filename,
                "caption_bytes": len(data), "caption_sha256": hashlib.sha256(data).hexdigest(),
            })
        except (requests.RequestsError, ValueError) as error:
            # Exception messages can contain signed caption URLs; never persist them.
            audited.append({**item, "status": "error", "reason": type(error).__name__})
    cached = [track for track in audited if track["status"] == "cached"]
    selected = _english_track(cached)
    result.update({
        "status": "captioned" if cached else (
            "error" if any(track["status"] == "error" for track in audited)
            else "caption-track-unavailable"
        ),
        "tracks": audited,
        "track_audit_complete": not any(track["status"] == "error" for track in audited),
        "cached_track_count": len(cached),
    })
    if selected:
        result.update({
            "caption_id": selected["id"], "language": selected["language"],
            "label": selected["label"], "provenance": selected["provenance"],
            "caption_bytes": selected["caption_bytes"],
        })
    return result


def _summarize(document: dict, *, check_cache: bool = False) -> dict:
    statuses, groups, source_statuses = Counter(), {}, Counter()
    tracks, unique_ids = [], set()
    incomplete_track_audits = 0
    entries = [
        (section, entry)
        for section in ("profiles", "other_pages")
        for entry in document.get(section, {}).values()
    ]
    for section, entry in entries:
        videos = list(entry.get("videos", {}).values())
        counts = Counter(video.get("status", "pending") for video in videos)
        statuses.update(counts)
        unique_ids.update(entry.get("videos", {}))
        entry["captioned_video_count"] = counts["captioned"]
        entry["available_video_count"] = sum(
            counts[status] for status in ("captioned", "no-public-captions", "caption-track-unavailable")
        )
        entry.pop("highlight", None)
        source_statuses[entry.get("source_status", "pending")] += 1
        group = groups.setdefault(entry.get("group", "Unknown"), {
            "profiles": 0, "pages": 0, "videos": 0, "statuses": Counter(),
        })
        group["profiles"] += int(section == "profiles")
        group["pages"] += 1
        group["videos"] += len(videos)
        group["statuses"].update(counts)
        tracks.extend(track for video in videos for track in video.get("tracks", []))
        incomplete_track_audits += sum(
            video.get("track_audit_complete") is False
            or (
                video.get("status") in {"captioned", "caption-track-unavailable"}
                and not video.get("track_audit_complete")
            )
            for video in videos
        )
    summary = {
        "profile_count": len(document["profiles"]), "video_count": sum(statuses.values()),
        "other_page_count": len(document.get("other_pages", {})),
        "source_page_count": len(entries),
        "profile_video_count": sum(
            len(entry.get("videos", {})) for entry in document["profiles"].values()
        ),
        "unique_video_count": len(unique_ids),
        "profiles_with_videos": sum(bool(entry.get("videos")) for entry in document["profiles"].values()),
        "profiles_without_videos": sum(not entry.get("videos") for entry in document["profiles"].values()),
        "statuses": dict(statuses), "groups": groups, "source_statuses": dict(source_statuses),
        "track_count": len(tracks),
        "cached_track_count": sum(track.get("status") == "cached" for track in tracks),
        "track_statuses": dict(Counter(track.get("status", "pending") for track in tracks)),
        "incomplete_track_audits": incomplete_track_audits,
    }
    if check_cache:
        cached = [track for track in tracks if track.get("status") == "cached"]
        filenames = {track["cache_file"] for track in cached}
        on_disk = {path.name for path in config.TRANSCRIPT_CACHE.glob("*.vtt")}
        summary["cache_integrity"] = {
            "referenced_files": len(filenames),
            "files_on_disk": len(on_disk),
            "unreferenced_files": len(on_disk - filenames),
            "valid_tracks": sum(_cache_valid(track) for track in cached),
            "missing_or_invalid_tracks": sum(not _cache_valid(track) for track in cached),
        }
    document["summary"] = summary
    return summary


def audit(
    *, refresh: bool = False, limit_profiles: int | None = None,
    limit_veterans: int | None = None, group: str | None = None,
    workers: int = 3, delay: float = 0.3, max_age_days: int = 7,
    refresh_pages: bool = False,
) -> dict:
    document = _load_index()
    if limit_veterans is not None:
        group, limit_profiles = "Military Veterans", limit_veterans
    profiles = _profiles(group)
    if limit_profiles is not None:
        profiles = profiles[:limit_profiles]
    other_pages = [
        page for page in media.other_source_pages() if not group or page.get("group") == group
    ] if limit_profiles is None else []
    if not group and limit_profiles is None:
        ids = {person["survivor_id"] for person in profiles}
        document["profiles"] = {
            slug: entry for slug, entry in document["profiles"].items() if slug in ids
        }
        other_ids = {page["survivor_id"] for page in other_pages}
        document["other_pages"] = {
            slug: entry for slug, entry in document["other_pages"].items() if slug in other_ids
        }
    jobs, reused, source_failures = [], 0, 0
    sources = [("profiles", person) for person in profiles] + [
        ("other_pages", page) for page in other_pages
    ]
    for section, person in sources:
        slug, archive_url = person["survivor_id"], person["archive_url"]
        entry = document[section].setdefault(slug, {"videos": {}})
        same_source = entry.get("archive_url") == archive_url
        entry.update(archive_url=archive_url, group=person.get("group"), inventory_checked_at=_now())
        path = CACHE_DIR / f"{slug}.html"
        page = _get(archive_url, path, refresh_pages)
        status = media.page_status(page, archive_url) if page else "error"
        if status == "invalid" and not refresh_pages:
            page = _get(archive_url, path, True)
            status = media.page_status(page, archive_url) if page else "error"
        entry["source_status"] = status
        if status != "public":
            _sync_video_inventory(entry, [])
            source_failures += 1
            continue
        videos = media.parse_profile_media(page, archive_url, person.get("name", ""))["videos"]
        _sync_video_inventory(entry, videos)
        for video in videos:
            existing = entry["videos"].get(video["id"], {})
            if not refresh and _reusable(
                existing, video, same_source=same_source, max_age_days=max_age_days,
            ):
                existing["embed_url"] = video["embed_url"]
                if video.get("source_title"):
                    existing["source_title"] = video["source_title"]
                reused += 1
                continue
            entry["videos"][video["id"]] = {
                "id": video["id"], "embed_url": video["embed_url"],
                "source_title": video.get("source_title", ""), "status": "pending",
            }
            jobs.append((section, slug, video, archive_url))
    _summarize(document)
    _write_index(document)
    print(
        f"Auditing {len(jobs)} Vimeo chapters across {len(profiles)} profiles "
        f"and {len(other_pages)} non-profile pages; "
        f"reusing {reused} recent valid results; {source_failures} source failures.",
        flush=True,
    )
    completed, gate = 0, RequestGate(delay)
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        pending, job_iter, exhausted = {}, iter(jobs), False
        while pending or not exhausted:
            while len(pending) < max(1, workers) and not exhausted:
                try:
                    section, slug, video, archive_url = next(job_iter)
                except StopIteration:
                    exhausted = True
                    break
                pending[pool.submit(_check_video, video, archive_url, gate)] = (section, slug, video)
            if not pending:
                continue
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                section, slug, video = pending.pop(future)
                try:
                    result = future.result()
                except (requests.RequestsError, ValueError, TypeError, KeyError) as error:
                    result = {
                        "id": video["id"], "embed_url": video["embed_url"],
                        "status": "error", "reason": type(error).__name__, "checked_at": _now(),
                    }
                result["source_title"] = video.get("source_title", "")
                document[section][slug]["videos"][video["id"]] = result
                completed += 1
                if completed % 25 == 0:
                    _summarize(document)
                    _write_index(document)
                    print(f"  {completed}/{len(jobs)} checked", flush=True)
    summary = _summarize(document, check_cache=True)
    _write_index(document)
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True), flush=True)
    return document


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="recheck even recent completed audits")
    parser.add_argument("--refresh-pages", action="store_true", help="refetch public OHP source pages")
    parser.add_argument("--limit-profiles", type=int)
    parser.add_argument("--limit-veterans", type=int, help="legacy alias: limit the veteran group")
    parser.add_argument("--group", help="optional archive group; all groups are audited by default")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--delay", type=float, default=0.3)
    parser.add_argument("--max-age-days", type=int, default=7)
    args = parser.parse_args(argv)
    document = audit(**vars(args))
    summary = document["summary"]
    return 1 if (
        summary["statuses"].get("error") or summary["statuses"].get("pending")
        or summary["track_statuses"].get("error") or summary["track_statuses"].get("pending")
        or summary["incomplete_track_audits"]
        or summary["cache_integrity"]["missing_or_invalid_tracks"]
        or any(status != "public" for status in summary["source_statuses"])
    ) else 0


if __name__ == "__main__":
    raise SystemExit(main())
