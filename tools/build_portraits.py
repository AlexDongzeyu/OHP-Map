"""Build rights-cleared profile portraits from Crestwood OHP galleries.

The project owner stated on 2026-09-02 that they authored the OHP photographs and
granted permission to reuse them in this map. This script keeps source attribution
and the permission basis in data/portraits/manifest.json.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
import json
from pathlib import Path
import re
from threading import Lock
import time
from urllib.parse import urlparse

from bs4 import BeautifulSoup
import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
import requests


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "source" / "ohp_all.json"
PAGE_CACHE = ROOT / "data" / "source" / "pages_cache"
OUT_DIR = ROOT / "assets" / "portraits"
MANIFEST = ROOT / "data" / "portraits" / "manifest.json"
RIGHTS = (
    "Reuse permission granted by the photograph author and project owner "
    "on 2026-09-02 for the OHP Map."
)
UA = "CrestwoodOHP-Map-Portraits/1.0 (+https://github.com/AlexDongzeyu/OHP-Map)"
BAD_FILENAME_WORDS = {
    "and", "with", "wife", "husband", "family", "students", "class",
    "crew", "group", "interview", "team", "friends",
}
NON_PORTRAIT_WORDS = {
    "certificate", "document", "recognition", "newspaper", "letter",
    "passport", "plaque", "grave", "tombstone",
}
GOOD_FILENAME_WORDS = {"portrait", "headshot", "profile", "solo"}
RELATIONSHIP_WORDS = {
    "father", "mother", "parents", "grandfather", "grandmother",
    "maternal", "paternal", "son", "daughter",
}
FACE_CASCADE = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)
FACE_LOCK = Lock()
MAX_CANDIDATES = 8


def _candidate_images(html: str, name: str) -> list[tuple[int, str]]:
    soup = BeautifulSoup(html, "lxml")
    ordered_name_tokens = [
        token.lower() for token in re.findall(r"[A-Za-z]{3,}", name)
    ]
    name_tokens = set(ordered_name_tokens)
    first_name = ordered_name_tokens[0] if ordered_name_tokens else ""
    candidates: list[tuple[int, int, str]] = []
    seen = set()
    for order, image in enumerate(soup.select(".entry-content img, article img")):
        url = image.get("src") or image.get("data-src") or ""
        if "/wp-content/uploads/" not in url or url in seen:
            continue
        if urlparse(url).hostname != "ohp.crestwood.on.ca":
            continue
        seen.add(url)
        haystack = f"{url} {image.get('alt', '')}".lower()
        words = set(re.findall(r"[a-z]{3,}", haystack))
        score = sum(6 for token in name_tokens if token in haystack)
        score += sum(4 for token in GOOD_FILENAME_WORDS if token in words)
        score -= sum(2 for token in BAD_FILENAME_WORDS if token in words)
        score -= sum(10 for token in NON_PORTRAIT_WORDS if token in words)
        normalized = re.sub(r"[^a-z]+", "-", haystack)
        if first_name and re.search(
            rf"\b{re.escape(first_name)}-?s?-(?:"
            + "|".join(sorted(RELATIONSHIP_WORDS))
            + r")\b",
            normalized,
        ):
            score -= 20
        if first_name and re.search(
            rf"\b{re.escape(first_name)}[-_ ]+(?:left|right|center|centre|seated|standing)\b",
            haystack,
        ):
            score += 8
        if "attachment-thumbnail" in (image.get("class") or []):
            score += 2
        candidates.append((score, -order, url))
    candidates.sort(reverse=True)
    return [(score, url) for score, _, url in candidates]


def _faces(image: Image.Image) -> list[tuple[int, int, int, int]]:
    array = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2GRAY)
    with FACE_LOCK:
        faces = FACE_CASCADE.detectMultiScale(
            array,
            scaleFactor=1.08,
            minNeighbors=4,
            minSize=(18, 18),
        )
    return [tuple(int(value) for value in face) for face in faces]


def _face_score(
    image: Image.Image,
    faces: list[tuple[int, int, int, int]],
) -> float:
    if not faces:
        return -100
    return 40 - max(0, len(faces) - 1) * 0.5


def _center_on_face(
    image: Image.Image,
    faces: list[tuple[int, int, int, int]],
) -> Image.Image:
    image = ImageOps.exif_transpose(image).convert("RGB")
    return ImageOps.fit(
        image,
        (192, 192),
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    )


def _download_candidate(url: str) -> tuple[Image.Image, list[tuple[int, int, int, int]]]:
    response = requests.get(url, headers={"User-Agent": UA}, timeout=40)
    response.raise_for_status()
    try:
        with Image.open(BytesIO(response.content)) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
    except UnidentifiedImageError as error:
        raise ValueError(f"{url} is not a readable image") from error
    return image, _faces(image)


def _build_one(record: dict, force: bool = False) -> dict | None:
    slug = record["survivor_id"]
    page = PAGE_CACHE / f"{slug}.html"
    if not page.exists():
        return None
    candidates = _candidate_images(
        page.read_text(encoding="utf-8", errors="ignore"),
        record.get("name", ""),
    )
    if not candidates:
        return None

    selected = None
    last_error = None
    for filename_score, source_url in candidates[:MAX_CANDIDATES]:
        try:
            image, faces = _download_candidate(source_url)
        except (requests.RequestException, OSError, ValueError) as error:
            last_error = error
            continue
        score = filename_score + _face_score(image, faces)
        if selected is None or score > selected[0]:
            selected = (score, source_url, image, faces)
        if faces:
            break
    if selected is None:
        if last_error:
            raise last_error
        return None
    if selected[0] < 0 and candidates[0][0] < 2:
        return None

    score, source_url, image, faces = selected
    target = OUT_DIR / f"{slug}.webp"
    if force or not target.exists():
        portrait = _center_on_face(image, faces)
        target.parent.mkdir(parents=True, exist_ok=True)
        portrait.save(target, "WEBP", quality=82, method=6)
        time.sleep(0.04)

    return {
        "survivor_id": slug,
        "name": record.get("name", ""),
        "group": record.get("group", ""),
        "portrait": f"assets/portraits/{slug}.webp",
        "portrait_rights": RIGHTS,
        "source_url": source_url,
        "selection_score": round(score, 2),
        "faces_detected": len(faces),
    }


def build(group: str | None, limit: int | None, workers: int, force: bool) -> dict:
    source_doc = json.loads(SOURCE.read_text(encoding="utf-8"))
    records = [
        record for record in source_doc["people"]
        if not group or record.get("group") == group
    ]
    if limit:
        records = records[:limit]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    entries: dict[str, dict] = {}
    failures: list[dict] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(_build_one, record, force): record for record in records}
        for index, future in enumerate(as_completed(futures), 1):
            record = futures[future]
            try:
                result = future.result()
                if result:
                    entries[result["survivor_id"]] = result
            except (requests.RequestException, OSError, ValueError) as error:
                failures.append({
                    "survivor_id": record["survivor_id"],
                    "error": str(error),
                })
            if index % 100 == 0:
                print(f"Processed {index}/{len(records)} profiles")

    manifest = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "https://ohp.crestwood.on.ca/",
        "permission_basis": RIGHTS,
        "selection":
            "Highest-scoring OHP gallery thumbnail by subject-name, solo-photo filename, "
            "and detected-face signals; non-face candidates are rejected.",
        "size": "192x192 WebP",
        "requested_group": group or "all",
        "records_considered": len(records),
        "portraits_built": len(entries),
        "failures": failures,
        "portraits": [entries[key] for key in sorted(entries)],
    }
    if not group and not limit:
        for path in OUT_DIR.glob("*.webp"):
            if path.stem not in entries:
                path.unlink()
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Built {len(entries)} portraits with {len(failures)} failures.")
    return manifest


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Build OHP profile portraits.")
    parser.add_argument("--group", default=None, help="Only process one archive group")
    parser.add_argument("--limit", type=int, default=None, help="Limit profiles for testing")
    parser.add_argument("--workers", type=int, default=6, help="Concurrent image downloads")
    parser.add_argument("--force", action="store_true", help="Replace existing portrait files")
    args = parser.parse_args(argv)
    manifest = build(args.group, args.limit, args.workers, args.force)
    return 1 if manifest["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
