"""Public OHP gallery and chapter references, without interview transcript text.

``python -m pipeline.media`` distills cached public pages into ohp_profile_media.json.
That committed snapshot keeps complete source quotations and media available to
offline builds even when the ignored HTML and private VTT caches are absent.
"""
from __future__ import annotations

import argparse
import html
import json
import re
from functools import lru_cache
from urllib.parse import parse_qsl, quote, unquote, urlencode, urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup

from . import config


VIDEO_STATUSES = {
    "captioned", "no-public-captions", "unavailable",
    "caption-track-unavailable", "pending", "error",
}
_EMBED_PARAMETERS = {
    "h", "title", "byline", "portrait", "color", "badge", "autopause", "dnt",
}
_DECORATIVE = re.compile(
    r"(?:^|[/_.\s-])(?:logo|favicon|spinner|placeholder|background|banner|icon|loading)"
    r"(?:[/_.\s-]|$)", re.I,
)
_GENERIC_TITLE = re.compile(
    r"^(?:\d+[.\s-]*)?(?:vimeo(?: video player)?|video|play|watch|watch video|"
    r"click (?:here|to watch))$", re.I,
)
PHOTO_RIGHTS = "See the OHP source page for photograph credits and reuse rights."
PHOTO_CREDIT = "Crestwood Oral History Project"


def video_inventory(video_ids: list[str]) -> str:
    """Keep the original ID-only fingerprint for older datasets and clients."""
    return _fingerprint(sorted(set(video_ids)))


def _fingerprint(values: list[str]) -> str:
    value = 2166136261
    for character in ",".join(values):
        value = ((value ^ ord(character)) * 16777619) & 0xFFFFFFFF
    return f"{len(values)}:{value:08x}"


def source_inventory(videos: list[dict]) -> str:
    return _fingerprint(sorted(
        f"{video['id']}|{video['embed_url']}" for video in videos
    ))


def _decoded_component(value: str) -> str | None:
    if re.search(r"%(?![a-fA-F0-9]{2})", value):
        return None
    try:
        return unquote(value, errors="strict")
    except UnicodeDecodeError:
        return None


def safe_vimeo_reference(value: str, base: str = config.WP_BASE) -> dict | None:
    """Retain only official player references and public unlisted access hashes."""
    try:
        parsed = urlsplit(urljoin(base, html.unescape(value or "").strip()))
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.hostname not in {"player.vimeo.com", "vimeo.com", "www.vimeo.com"}
            or parsed.username or parsed.password or parsed.port
            or _decoded_component(parsed.path + parsed.query + parsed.fragment) is None
        ):
            return None
        pattern = (
            r"/video/(\d+)(?:/([a-fA-F0-9]{6,64}))?/?"
            if parsed.hostname == "player.vimeo.com"
            else r"/(\d+)(?:/([a-fA-F0-9]{6,64}))?/?"
        )
        match = re.fullmatch(pattern, parsed.path)
        if not match:
            return None
        parameters = {}
        for key, item in parse_qsl(parsed.query):
            if key not in _EMBED_PARAMETERS:
                continue
            if key == "h":
                if not re.fullmatch(r"[a-zA-Z0-9]{6,64}", item) or (
                    key in parameters and parameters[key] != item
                ):
                    return None
                parameters[key] = item
            elif re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", item):
                parameters[key] = item
        if match[2] and "h" not in parameters:
            parameters["h"] = match[2]
        query = urlencode(sorted(parameters.items()))
        embed = urlunsplit(("https", "player.vimeo.com", f"/video/{match[1]}", query, ""))
        return {"id": match[1], "url": embed, "embed_url": embed}
    except (TypeError, ValueError):
        return None


def access_reference(video: dict) -> tuple[str, str]:
    """Presentation options do not change whether a public video can be opened."""
    reference = safe_vimeo_reference(video.get("embed_url", ""))
    if not reference:
        return "", ""
    params = dict(parse_qsl(urlsplit(reference["embed_url"]).query))
    return reference["id"], params.get("h", "")


def safe_photo_url(value: str, base: str = config.WP_BASE) -> str | None:
    try:
        parsed = urlsplit(urljoin(base, html.unescape(value or "").strip()))
        decoded = _decoded_component(parsed.path)
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.hostname != urlsplit(config.WP_BASE).hostname
            or parsed.username or parsed.password or parsed.port
            or not parsed.path.startswith("/wp-content/uploads/")
            or decoded is None
            or _decoded_component(parsed.query + parsed.fragment) is None
            or any(part in {".", ".."} for part in decoded.split("/"))
            or "\\" in decoded
            or not re.search(r"\.(?:jpe?g|png|webp|gif|avif)$", parsed.path, re.I)
            or _DECORATIVE.search(parsed.path)
        ):
            return None
        return urlunsplit((
            "https", parsed.hostname, quote(parsed.path, safe="/%:@!$&'()*+,;=-._~"), "", "",
        ))
    except (TypeError, ValueError):
        return None


def photo_key(url: str) -> str | None:
    decoded = _decoded_component(urlsplit(url).path)
    return re.sub(r"-\d+x\d+(?=\.[^.]+$)", "", decoded) if decoded is not None else None


def _title(value: str) -> str:
    value = re.sub(r"\s+", " ", value or "").strip()
    return "" if _GENERIC_TITLE.fullmatch(value) else value


def page_status(page: str, archive_url: str) -> str:
    soup = BeautifulSoup(page, "html.parser")
    if soup.select_one("form.post-password-form, input[name=post_password]"):
        return "protected"
    if not soup.select_one(".entry-content"):
        return "invalid"
    canonical = soup.select_one('link[rel="canonical"]')
    if canonical and canonical.get("href"):
        expected = urlsplit(archive_url).path.rstrip("/")
        reference = urlsplit(canonical["href"])
        if (
            reference.path.rstrip("/") != expected
            or reference.hostname != urlsplit(archive_url).hostname
        ):
            return "invalid"
    return "public"


def biography_text(page: str) -> str:
    soup = BeautifulSoup(page, "html.parser")
    if soup.select_one("form.post-password-form, input[name=post_password]"):
        return ""
    content = soup.select_one(".entry-content")
    if content is None:
        return ""
    for block in content.select("#ohp-video, #ohp-photo, .gallery, script, style"):
        block.decompose()
    return re.sub(r"\s+", " ", content.get_text(" ", strip=True)).strip()


def other_source_pages() -> list[dict]:
    if not config.OHP_MEDIA_PAGES.exists():
        return []
    return json.loads(config.OHP_MEDIA_PAGES.read_text(encoding="utf-8")).get("pages", [])


@lru_cache(maxsize=1)
def _source_index() -> dict:
    if not config.PROFILE_MEDIA_INDEX.exists():
        return {}
    return json.loads(config.PROFILE_MEDIA_INDEX.read_text(encoding="utf-8")).get("profiles", {})


def _source_record(record: dict) -> dict:
    entry = _source_index().get(record["survivor_id"], {})
    return entry if entry.get("archive_url") == record.get("archive_url") else {}


def parse_profile_media(page: str, archive_url: str, name: str = "") -> dict:
    soup = BeautifulSoup(page, "html.parser")
    if soup.select_one("form.post-password-form, input[name=post_password]"):
        return {"images": [], "videos": []}
    content = soup.select_one(".entry-content")
    if content is None:
        return {"images": [], "videos": []}
    videos: dict[str, dict] = {}
    for element in content.select("a[href], iframe[src], iframe[data-src]"):
        value = element.get("href") or element.get("src") or element.get("data-src")
        reference = safe_vimeo_reference(value, archive_url)
        if not reference:
            continue
        title = _title(
            element.get_text(" ", strip=True) if element.name == "a"
            else element.get("title", "")
        )
        prior = videos.get(reference["id"])
        if prior:
            if access_reference(reference)[1] and not access_reference(prior)[1]:
                prior.update(reference)
            if not prior.get("source_title") and title:
                prior.update(title=title, source_title=title)
            continue
        videos[reference["id"]] = {
            **reference,
            "title": title or f"Interview chapter {len(videos) + 1}",
            "source_title": title,
            "status": "pending",
        }

    images: dict[str, dict] = {}
    for image in content.select("img"):
        thumbnail = safe_photo_url(image.get("data-src") or image.get("src"), archive_url)
        if not thumbnail or _DECORATIVE.search(
            " ".join(image.get("class", [])) + " " + image.get("alt", "")
        ):
            continue
        anchor = image.find_parent("a")
        original = safe_photo_url(anchor.get("href", ""), archive_url) if anchor else None
        source = original or thumbnail
        key = photo_key(source)
        if key in images:
            if original and not re.search(r"-\d+x\d+(?=\.[^.]+$)", urlsplit(original).path):
                images[key]["full_url"] = original
            continue
        figure = image.find_parent("figure")
        figcaption = figure.find("figcaption") if figure else None
        caption = (
            figcaption.get_text(" ", strip=True) if figcaption
            else image.get("alt", "") or (anchor.get("title", "") if anchor else "")
        )
        images[key] = {
            "url": source,
            "source_url": source,
            "caption": re.sub(r"\s+", " ", caption).strip()
            or (f"Photograph from {name}'s OHP archive." if name else "OHP archive photograph."),
            "credit": PHOTO_CREDIT,
            "rights": PHOTO_RIGHTS,
        }
        if original and not re.search(r"-\d+x\d+(?=\.[^.]+$)", urlsplit(original).path):
            images[key]["full_url"] = original
    return {"images": list(images.values()), "videos": list(videos.values())}


@lru_cache(maxsize=1)
def _portraits() -> dict[str, dict]:
    path = config.DATA / "portraits" / "manifest.json"
    if not path.exists():
        return {}
    manifest = json.loads(path.read_text(encoding="utf-8"))
    return {entry["survivor_id"]: entry for entry in manifest.get("portraits", [])}


@lru_cache(maxsize=1400)
def _cached_media(path: str, modified: int, archive_url: str, name: str) -> dict:
    from pathlib import Path

    page = Path(path).read_text(encoding="utf-8")
    status = page_status(page, archive_url)
    if status != "public":
        return {"images": [], "videos": [], "quote_text": "", "source_status": status}
    return {
        **parse_profile_media(page, archive_url, name),
        "quote_text": biography_text(page), "source_status": status,
    }


def is_protected(record: dict) -> bool:
    if record.get("protected"):
        return True
    page = config.DATA / "source" / "pages_cache" / f"{record['survivor_id']}.html"
    if page.exists():
        return _cached_media(
            str(page), page.stat().st_mtime_ns, record.get("archive_url", ""), record.get("name", ""),
        )["source_status"] == "protected"
    return _source_record(record).get("source_status") == "protected"


def source_text_for(record: dict) -> str:
    page = config.DATA / "source" / "pages_cache" / f"{record['survivor_id']}.html"
    if page.exists():
        return _cached_media(
            str(page), page.stat().st_mtime_ns, record.get("archive_url", ""), record.get("name", ""),
        )["quote_text"]
    quote_text = record.get("quote_text")
    if quote_text is not None:
        return quote_text
    quote_text = _source_record(record).get("quote_text")
    return quote_text if quote_text is not None else record.get("text", "")


def profile_media(record: dict, audit_entry: dict | None = None) -> dict:
    slug = record["survivor_id"]
    archive_url = record.get("archive_url", "")
    page = config.DATA / "source" / "pages_cache" / f"{slug}.html"
    source = record.get("profile_media") or _source_record(record) or {"images": [], "videos": []}
    if page.exists():
        source = _cached_media(str(page), page.stat().st_mtime_ns, archive_url, record.get("name", ""))
    images = [dict(image) for image in source.get("images", [])]
    portraits = _portraits()
    portrait = next(
        (portraits[key] for key in [slug, *record.get("source_aliases", [])] if key in portraits),
        None,
    )
    if portrait and portrait.get("portrait_rights") and safe_photo_url(portrait.get("source_url")):
        local_path = str(portrait.get("portrait", ""))
        if (
            re.fullmatch(r"assets/portraits/[a-z0-9-]+\.webp", local_path)
            and (config.ROOT / local_path).is_file()
        ):
            key = photo_key(portrait["source_url"])
            matching = next((image for image in images if photo_key(image["source_url"]) == key), None)
            images = [image for image in images if photo_key(image["source_url"]) != key]
            primary = {
                "url": local_path,
                "source_url": matching["source_url"] if matching else portrait["source_url"],
                "caption": matching["caption"] if matching else f"{record.get('name', 'Interviewee')} — OHP archive photograph.",
                "credit": PHOTO_CREDIT,
                "rights": portrait["portrait_rights"],
                "primary": True,
            }
            full_url = matching.get("full_url") if matching else None
            if safe_photo_url(full_url) and photo_key(full_url) == key:
                primary["full_url"] = full_url
            images.insert(0, primary)
    for image in images:
        if not image.get("primary"):
            image.pop("full_url", None)
    audited = (audit_entry or {}).get("videos", {})
    videos = []
    for source_video in source.get("videos", []):
        reference = safe_vimeo_reference(source_video.get("embed_url", ""))
        if not reference:
            continue
        checked = audited.get(reference["id"], {})
        if access_reference(checked) != access_reference(reference):
            checked = {}
        video = {
            **reference,
            "title": source_video.get("source_title") or checked.get("title") or source_video["title"],
            "status": checked.get("status", "pending"),
        }
        if video["status"] not in VIDEO_STATUSES:
            video["status"] = "pending"
        if checked.get("language"):
            video["language"] = checked["language"]
        videos.append(video)
    return {"images": images, "videos": videos}


def snapshot_sources(*, refresh_pages: bool = False) -> dict:
    """Persist distilled public references so builds never depend on ignored HTML."""
    from .scrape_ohp import CACHE_DIR, _get

    people = json.loads(
        (config.DATA / "source" / "ohp_all.json").read_text(encoding="utf-8"),
    )["people"]
    document = {
        "_about": (
            "Public OHP biography, gallery and chapter references for reproducible offline builds. "
            "No interview caption text or signed caption URLs are stored here."
        ),
        "profiles": {}, "other_pages": {},
    }
    for section, records in (("profiles", people), ("other_pages", other_source_pages())):
        for record in records:
            archive_url = record["archive_url"]
            page = _get(archive_url, CACHE_DIR / f"{record['survivor_id']}.html", refresh_pages)
            status = page_status(page, archive_url) if page else "error"
            if status != "public":
                raise ValueError(f"Cannot snapshot {record['survivor_id']}: source is {status}")
            document[section][record["survivor_id"]] = {
                "archive_url": archive_url, "source_status": status,
                "quote_text": biography_text(page),
                **parse_profile_media(page, archive_url, record.get("name", "")),
            }
    config.PROFILE_MEDIA_INDEX.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    _source_index.cache_clear()
    print(
        f"Saved public media sources for {len(document['profiles'])} profiles and "
        f"{len(document['other_pages'])} non-profile pages."
    )
    return document


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh-pages", action="store_true", help="refetch OHP pages before snapshotting")
    args = parser.parse_args(argv)
    snapshot_sources(refresh_pages=args.refresh_pages)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
