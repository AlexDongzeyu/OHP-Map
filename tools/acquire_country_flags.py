"""Acquire native-proportion flags and audit their dated use (Python stdlib only).

Run ``python tools\\acquire_country_flags.py --acquire`` to acquire public source
snapshots and regenerate data/source/country_flags.json and world-*.svg assets.
Run ``python tools\\acquire_country_flags.py --validate`` for offline validation.
Run ``python tools\\acquire_country_flags.py --replay`` to restore missing assets
from the recorded upstream revisions without rediscovering or changing dates.
``--acquire --offline`` makes a validated checkpoint from cached public sources;
unacquired artwork is explicitly quarantined, never replaced with a modern flag.
The acquisition cache is project-local; --clean-cache removes it after a run.
The checked-on date and editorial exception tables are deliberately pinned;
review both before acquiring a newer historical/current snapshot.

Current catalogue references are deliberately separate from dated use records.
Wikidata is a chronology lead, not permission to backdate a contemporary image.
Existing curated records and their assets are never rewritten.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import date, datetime, timezone
import hashlib
from html import unescape
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import shutil
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "source" / "country_flags.json"
CACHE = ROOT / ".country-flag-acquisition"
CHECKED = "2026-09-07"
SANITIZER_VERSION = 1
SVG = "http://www.w3.org/2000/svg"
XLINK = "http://www.w3.org/1999/xlink"
COMMONS = "https://commons.wikimedia.org/w/api.php"
WIKIDATA = "https://www.wikidata.org/w/api.php"
WIKIPEDIA = "https://en.wikipedia.org/w/api.php"
ADOPTION_PAGE = "List of countries by date of current flag adoption"
ADOPTION_URL = "https://en.wikipedia.org/wiki/List_of_countries_by_date_of_current_flag_adoption"
USER_AGENT = "OHPMapFlagImporter/1.0 (educational historical atlas; public data)"
COUNTRY_FLAGS_REVISION = "c09927e63705529bbf59ca6684cd9b23225dddad"
FLAG_ICONS_REVISION = "v7.5.0"
SAFE_ELEMENTS = {
    "svg", "g", "path", "rect", "circle", "ellipse", "polygon", "polyline",
    "line", "defs", "use", "clipPath", "mask", "title", "desc", "style", "text",
    "linearGradient", "radialGradient", "stop",
}
LICENSE_URLS = {
    "Public domain": "https://commons.wikimedia.org/wiki/Commons:Public_domain",
    "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
    "CC-BY-SA-4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
    "CC-BY-SA-3.0": "https://creativecommons.org/licenses/by-sa/3.0/",
    "CC-BY-SA-2.5": "https://creativecommons.org/licenses/by-sa/2.5/",
    "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
    "CC-BY-3.0": "https://creativecommons.org/licenses/by/3.0/",
}
PRESERVED_CURRENT = {
    "ca": "ca-1965", "us": "us-50", "fr": "fr-tricolour",
    "de": "de-federal", "ru": "ru-1993", "jp": "jp-1999", "pl": "pl-1980",
}
PRESERVED_ENTITIES = {"Q16", "Q30", "Q142", "Q183", "Q159", "Q17", "Q36", "Q145", "Q15180", "Q16957"}
COUNTRY_ALIASES = {
    "bs": ["Bahamas", "The Bahamas"], "gm": ["Gambia", "The Gambia"],
    "bo": ["Bolivia"], "bn": ["Brunei"], "cd": ["Democratic Republic of the Congo", "Dem. Rep. Congo"],
    "cg": ["Republic of the Congo", "Congo"], "ci": ["Ivory Coast", "Côte d'Ivoire", "Cote d'Ivoire"],
    "cv": ["Cape Verde", "Cabo Verde"], "cz": ["Czechia", "Czech Republic"],
    "fm": ["Micronesia", "Federated States of Micronesia"], "ir": ["Iran"],
    "kp": ["North Korea"], "kr": ["South Korea"], "la": ["Laos"],
    "md": ["Moldova"], "ps": ["Palestine"], "ru": ["Russia", "Russian Federation"],
    "sy": ["Syria", "Syrian Arab Republic", "Syrian Republic"], "tw": ["Taiwan", "Republic of China"],
    "tz": ["Tanzania"], "us": ["United States of America", "United States", "USA"],
    "gb": ["United Kingdom", "UK", "Great Britain"], "va": ["Vatican City", "Holy See"],
    "ve": ["Venezuela"], "vn": ["Vietnam"], "ba": ["Bosnia and Herzegovina", "Bosnia and Herz."],
    "cf": ["Central African Republic", "Central African Rep."],
    "do": ["Dominican Republic", "Dominican Rep."], "gq": ["Equatorial Guinea", "Eq. Guinea"],
    "fk": ["Falkland Islands", "Falkland Is."],
    "tf": ["French Southern Territories", "French Southern and Antarctic Lands", "Fr. S. Antarctic Lands"],
    "mk": ["North Macedonia", "Macedonia", "FYR Macedonia"],
    "ss": ["South Sudan", "S. Sudan"], "sb": ["Solomon Islands", "Solomon Is."],
    "eh": ["Western Sahara", "W. Sahara", "Sahrawi Arab Democratic Republic"],
    "sz": ["Eswatini", "eSwatini", "Swaziland"],
    "tl": ["Timor-Leste", "East Timor"], "tr": ["Turkey", "Türkiye"],
    "et": ["Ethiopia", "Ethiopia (1993-)"], "nr": ["Nauru", "Naoero"],
    "st": ["São Tomé and Príncipe", "Sao Tome and Principe"],
    "to": ["Tonga", "Kingdom of Tonga"], "vc": ["Saint Vincent and the Grenadines", "St Vincent and the Grenadines"],
    "sh": ["Saint Helena, Ascension and Tristan da Cunha", "Saint Helena and Dependencies"],
    "xk": ["Kosovo"], "xc": ["Northern Cyprus", "N. Cyprus"], "xs": ["Somaliland"],
}
COUNTRY_NAMES = {
    key: names[0] for key, names in COUNTRY_ALIASES.items()
}
ISO_ENTITY_OVERRIDE = {"aq": "Q51", "cy": "Q229", "nl": "Q55", "xk": "Q1246", "xc": "Q23681", "xs": "Q34754"}
SHARED_NATIONAL = {
    "bl": "fr", "gf": "fr", "gp": "fr", "mf": "fr", "mq": "fr", "nc": "fr",
    "pm": "fr", "re": "fr", "tf": "fr", "wf": "fr", "yt": "fr",
    "bq": "nl", "bv": "no", "sj": "no", "hm": "au", "um": "us", "sh": "gb",
}
COUNTRY_NOTES = {
    "aq": "Antarctica has no national flag. No unofficial Antarctic proposal is presented as a national flag.",
    "af": "Current reference: flag used by the Taliban de facto authorities since 2021; this is not diplomatic recognition. The displaced Republic tricolour remains a separately dated historical design.",
    "sy": "Current reference: the post-Assad national flag under the 2025 constitutional declaration. The 1980–2024 government design and the earlier independence flag are separate dated records.",
    "xc": "Northern Cyprus: de facto administration recognized as a state only by Turkey. XC is an internal identifier, not an assigned ISO code. The flag identifies that administration, not internationally recognized sovereignty.",
    "xs": "Somaliland: self-declared, de facto administration with limited international recognition. XS is an internal identifier, not an assigned ISO code. Its flag is not Somalia's national flag or proof of territorial control.",
    "xk": "Kosovo: partially recognized state. XK is a user-assigned, not officially assigned ISO code. Its national flag is an identifier, not a position on contested sovereignty.",
    "eh": "Western Sahara: flag of the Sahrawi Arab Democratic Republic / Polisario, not a flag shared by all controlling authorities. Status is disputed; much of the territory is administered by Morocco.",
    "sh": "The combined Saint Helena, Ascension and Tristan da Cunha territory has no unified local ensign. The UK national Union Flag is shown in its sovereign-national role, not Saint Helena island's Blue Ensign.",
    "nc": "French national flag in its inherited national role; New Caledonia also flies the Kanak flag. This entry is not an assertion of a single territorial flag or universal political identification.",
    "tw": "Republic of China (Taiwan) national flag. Distinct from the People's Republic of China; historical China records are separately bounded.",
    "ps": "Palestinian national flag; state recognition and actual territorial control are distinct from flag identification.",
    "io": "British Indian Ocean Territory: territorial government ensign. Sovereignty arrangements and control are not inferred from this current flag reference.",
    "ax": "Flag of the autonomous Åland Islands, not a separate sovereign national flag.",
    "gb": "The current catalogue reference uses the native 1:2 Union Flag. Existing dated curation separately preserves its documented 3:5 land rendering.",
    "tg": "The current reference preserves the national flag's native golden-ratio proportions, not the alternative 3:2 SVG supplied by a preferred Wikidata statement.",
}
CURRENT_FILES = {
    "af": "Flag of the Taliban.svg", "sy": "Flag of Syria (2025-).svg",
    "gb": "Flag of the United Kingdom (1-2).svg", "xc": "Flag of the Turkish Republic of Northern Cyprus.svg",
    "xs": "Flag of Somaliland.svg", "eh": "Flag of the Sahrawi Arab Democratic Republic.svg",
    "ch": "Flag of Switzerland.svg", "np": "Flag of Nepal.svg",
    "va": "Flag of Vatican City.svg", "cn": "Flag of the People's Republic of China.svg",
    "tw": "Flag of the Republic of China.svg", "hk": "Flag of Hong Kong.svg",
    "mo": "Flag of Macau.svg", "ax": "Flag of Åland.svg",
    "tg": "Flag of Togo.svg",
}
MANUAL_ENTITIES = {
    "Q38", "Q29", "Q148", "Q668", "Q155", "Q258", "Q79", "Q796", "Q794", "Q858", "Q889",
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def public_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in {"https", "http"} or parts.username or parts.password:
        raise ValueError(f"Not a public HTTP(S) source URL: {url}")
    if parts.hostname not in {
        "commons.wikimedia.org", "upload.wikimedia.org", "www.wikidata.org",
        "en.wikipedia.org", "query.wikidata.org", "raw.githubusercontent.com",
        "api.github.com", "codeload.github.com",
    }:
        raise ValueError(f"Acquisition host not allowlisted: {parts.hostname}")
    return url


class Fetcher:
    def __init__(self, refresh: bool = False, offline: bool = False):
        CACHE.mkdir(exist_ok=True)
        self.refresh = refresh
        self.offline = offline
        if refresh and offline:
            raise ValueError("--refresh and --offline cannot be combined")
        self.last_request = {}
        self.pacing = {}
        self.log = []

    def get(self, url: str, *, binary: bool = False) -> bytes:
        public_url(url)
        key = digest(url.encode())
        target = CACHE / (key + (".bin" if binary else ".json"))
        if target.exists() and not self.refresh:
            return target.read_bytes()
        if self.offline:
            raise RuntimeError("Deferred in offline checkpoint: original source bytes have not yet been acquired")
        host = urlsplit(url).hostname
        for attempt in range(6):
            elapsed = time.monotonic() - self.last_request.get(host, 0)
            pace = self.pacing.get(host, 12 if host == "upload.wikimedia.org" else 1.2)
            time.sleep(max(0, pace - elapsed))
            try:
                request = Request(url, headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "image/svg+xml" if binary else "application/json",
                })
                self.last_request[host] = time.monotonic()
                with urlopen(request, timeout=120) as response:
                    public_url(response.url)
                    data = response.read()
                target.write_bytes(data)
                self.log.append({"url": url, "sha256": digest(data)})
                return data
            except HTTPError as error:
                if error.code not in {429, 500, 502, 503, 504}:
                    raise
                retry = error.headers.get("Retry-After", "")
                if retry.isdigit():
                    delay = int(retry)
                else:
                    from email.utils import parsedate_to_datetime
                    try:
                        delay = max(0, (parsedate_to_datetime(retry) - datetime.now(timezone.utc)).total_seconds())
                    except (TypeError, ValueError):
                        delay = 4 * 2**attempt
                delay = max(delay, pace * (attempt + 1))
                if error.code == 429:
                    self.pacing[host] = min(60, pace * 2)
                detail = plain(error.read().decode("utf-8", errors="replace"))[:180]
                print(json.dumps({"retryHost": host, "waitSeconds": delay, "status": error.code,
                                  "resource": urlsplit(url).path.rsplit("/", 1)[-1], "detail": detail}), flush=True)
                time.sleep(delay)
            except (URLError, TimeoutError):
                if attempt == 5:
                    raise
                time.sleep(4 * 2**attempt)
        raise RuntimeError(f"Source unavailable after rate-limited retries: {url}")

    def json(self, base: str, params: dict | None = None):
        url = base + ("?" + urlencode(params) if params else "")
        data = json.loads(self.get(url))
        if isinstance(data, dict) and "error" in data:
            raise ValueError(f"API failure: {data['error']}")
        return data


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        if tag in {"style", "script"}:
            self.hidden += 1
        if tag in {"br", "p", "li", "div"}:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in {"style", "script"} and self.hidden:
            self.hidden -= 1


def plain(value: str) -> str:
    parser = PlainText()
    parser.feed(value or "")
    return re.sub(r"\s+", " ", "".join(parser.parts)).strip()


def file_url(title: str) -> str:
    return "https://commons.wikimedia.org/wiki/" + quote(title.replace(" ", "_"), safe=":")


def normalize(value: str) -> str:
    import unicodedata
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value).strip()).casefold()


def batches(values, size=40):
    values = list(values)
    for offset in range(0, len(values), size):
        yield values[offset:offset + size]


def inventory():
    atlas = json.loads((ROOT / "public" / "data" / "atlas-world.json").read_text(encoding="utf-8"))
    history = json.loads((ROOT / "data" / "historical_boundaries.json").read_text(encoding="utf-8"))
    geometries = history["objects"]["territories"]["geometries"]
    base = sorted({row["properties"]["name"] for row in atlas["features"]})
    all_names = sorted({row["properties"]["controller"] for row in geometries})
    active = sorted({
        row["properties"]["controller"] for row in geometries
        if row["properties"]["start"] <= 2026.5 < (row["properties"]["end"] or 9999)
    })
    return base, all_names, active


def wikidata_entities(fetcher, ids):
    result = {}
    for batch in batches(sorted(set(ids))):
        data = fetcher.json(WIKIDATA, {
            "action": "wbgetentities", "ids": "|".join(batch),
            "props": "info|claims|labels|aliases", "languages": "en", "format": "json",
        })
        result.update(data["entities"])
    return result


def claim_value(claim):
    return claim.get("mainsnak", {}).get("datavalue", {}).get("value")


def reduced_time(snak):
    value = snak.get("datavalue", {}).get("value", {})
    precision = value.get("precision", 0)
    if precision not in {9, 10, 11} or value.get("before", 0) or value.get("after", 0):
        return None
    if not value.get("time", "").startswith("+"):
        return None
    if value.get("calendarmodel") != "http://www.wikidata.org/entity/Q1985727":
        return None
    return value["time"][1:][:{9: 4, 10: 7, 11: 10}[precision]]


def claim_summary(qid, entity, claim):
    qualifiers = claim.get("qualifiers", {})
    def times(prop):
        return [reduced_time(snak) for snak in qualifiers.get(prop, [])]
    roles = {
        prop: [snak.get("datavalue", {}).get("value") for snak in values]
        for prop, values in qualifiers.items() if prop not in {"P580", "P582"}
    }
    return {
        "entity": qid, "entityLabel": entity.get("labels", {}).get("en", {}).get("value", qid),
        "statement": claim["id"], "rank": claim.get("rank"),
        "file": claim_value(claim), "starts": times("P580"), "ends": times("P582"),
        "qualifiers": roles, "hasReferences": bool(claim.get("references")),
        "sourceUrl": "https://www.wikidata.org/wiki/" + qid + "#" + claim["id"].replace("$", "-"),
    }


def commons_metadata(fetcher, titles):
    result = {}
    if not fetcher.refresh:
        saved = {}
        for name in ("all-metadata.json", "current-metadata.json"):
            path = CACHE / name
            if path.exists():
                saved.update(json.loads(path.read_text(encoding="utf-8")))
        result = {title: saved[title] for title in set(titles)
                  if title in saved and not saved[title].get("unfetched")}
    missing = sorted(set(titles) - set(result))
    if fetcher.offline:
        result.update({title: {"title": title, "unfetched": True} for title in missing})
        return result
    for batch in batches(missing):
        data = fetcher.json(COMMONS, {
            "action": "query", "titles": "|".join(batch), "prop": "imageinfo",
            "iiprop": "url|extmetadata|sha1|timestamp|size", "format": "json",
            "redirects": 1,
        })
        query = data.get("query", {})
        pages = {row["title"]: row for row in query.get("pages", {}).values()}
        redirects = {row["from"]: row["to"] for key in ("normalized", "redirects") for row in query.get(key, [])}
        for title in batch:
            target, seen = title, set()
            while target in redirects and target not in seen:
                seen.add(target)
                target = redirects[target]
            result[title] = pages.get(target, {"title": target, "missing": ""})
    return result


class AdoptionTable(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.row = None
        self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        elif tag in {"td", "th"} and self.row is not None:
            self.cell = ""

    def handle_data(self, data):
        if self.cell is not None:
            self.cell += data

    def handle_endtag(self, tag):
        if tag in {"td", "th"} and self.cell is not None:
            self.row.append(re.sub(r"\s+", " ", self.cell).strip())
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None


def adoption_rows(html):
    table = AdoptionTable()
    table.feed(html)
    result = {}
    for row in table.rows:
        if len(row) != 4 or row[0] == "Country":
            continue
        first = re.sub(r"\[[^]]*]", "", row[1])
        latest = re.sub(r"\[[^]]*]", "", row[3])
        dates = [table_date(first), table_date(latest)]
        dates = [value for value in dates if value]
        if dates:
            latest_year = max(value[:4] for value in dates)
            precise = max((value for value in dates if value.startswith(latest_year)), key=len)
            result[normalize(row[0])] = {"start": precise, "cells": row}
    return result


def table_date(text):
    months = {name: number for number, name in enumerate(
        ("January", "February", "March", "April", "May", "June", "July", "August",
         "September", "October", "November", "December"), 1)}
    month_pattern = "|".join(months)
    match = re.match(rf"^(\d{{1,2}}) ({month_pattern}) (\d{{4}})\b", text)
    if match:
        day, month, year = match.groups()
        return date(int(year), months[month], int(day)).isoformat()
    match = re.match(rf"^({month_pattern}) (\d{{1,2}}),? (\d{{4}})\b", text)
    if match:
        month, day, year = match.groups()
        return date(int(year), months[month], int(day)).isoformat()
    match = re.match(rf"^({month_pattern}) (\d{{4}})\b", text)
    if match:
        month, year = match.groups()
        return f"{year}-{months[month]:02}"
    match = re.match(r"^(\d{4})(?:\b|$)", text)
    return match[1] if match else None


def role_rejection(filename):
    if not isinstance(filename, str):
        return "No flag image value"
    if not filename.lower().endswith(".svg"):
        return "Not a native SVG image"
    if re.search(r"1935.?1945|nazi|swastika|ss[_ -]flag|wappenstandarte", filename, re.I):
        return "Nazi insignia excluded; existing neutral DE record is preserved"
    if re.search(r"royal.standard|presidential|standard.of|naval|war.flag|war.ensign|air.force|army|military|jack.of|coat.of.arms|banner.of.arms|emblem.of|unofficial|proposed|proposal|construction|vertical|map.of|icon|logo", filename, re.I):
        return "Royal, military, proposed, emblem-only or non-national image role"
    return None


def make_countries(country_index, iso, entities):
    by_iso = defaultdict(list)
    for row in iso["results"]["bindings"]:
        by_iso[row["iso"]["value"].lower()].append(row["item"]["value"].rsplit("/", 1)[-1])
    input_rows = [row for row in country_index if row.get("iso") or row["code"] == "xk"]
    input_rows += [{"code": "xc", "name": "Northern Cyprus"}, {"code": "xs", "name": "Somaliland"}]
    countries, choices, qid_to_code = [], {}, {}
    for row in input_rows:
        code = row["code"].lower()
        qids = by_iso.get(code, [])
        qid = ISO_ENTITY_OVERRIDE.get(code) or (qids[0] if len(qids) == 1 else None)
        entity = entities.get(qid, {})
        name = COUNTRY_NAMES.get(code, row["name"])
        names = list(dict.fromkeys([name] + COUNTRY_ALIASES.get(code, []) + [row["name"]]))
        country = {"id": code.upper(), "name": name, "names": names}
        if code in COUNTRY_NOTES:
            country["note"] = COUNTRY_NOTES[code]
        if code in SHARED_NATIONAL and code not in COUNTRY_NOTES:
            country["note"] = "Inherited sovereign-national flag, not a separate local or territorial flag."
        countries.append(country)
        if qid:
            qid_to_code[qid] = code
        if code == "aq" or code in SHARED_NATIONAL:
            continue
        if code in PRESERVED_CURRENT:
            choices[code] = {"sourceId": PRESERVED_CURRENT[code], "qid": qid, "preserved": True}
            continue
        statements = [claim_summary(qid, entity, claim) for claim in entity.get("claims", {}).get("P41", [])]
        candidates = [
            statement for statement in statements
            if not statement["ends"] and statement["rank"] != "deprecated"
            and not role_rejection(statement["file"])
        ]
        preferred = [statement for statement in candidates if statement["rank"] == "preferred"]
        candidate_files = set(statement["file"] for statement in preferred or candidates)
        override = CURRENT_FILES.get(code)
        if override:
            filename = override
        elif len(candidate_files) == 1:
            filename = next(iter(candidate_files))
        else:
            filename = f"Flag of {name}.svg"
        matching = [statement for statement in candidates if statement["file"] == filename]
        choices[code] = {
            "file": filename, "qid": qid, "currentCandidates": candidates,
            "statement": matching[0] if len(matching) == 1 else None,
            "ambiguous": len(candidate_files) > 1 and not override,
            "sourceId": "world-" + code + "-current",
        }
    return countries, choices, qid_to_code


def fetch_articles(fetcher):
    titles = [f"Flag of {name}" for name in (
        "Italy", "Spain", "China", "India", "Brazil", "South Africa", "Egypt", "Iraq", "Iran",
        "Syria", "Afghanistan", "Yugoslavia", "Czechoslovakia", "Russia", "the Soviet Union",
        "the United Kingdom", "Rhodesia", "Hong Kong", "Myanmar", "Ethiopia", "Nepal",
        "the Democratic Republic of the Congo", "Libya", "Saudi Arabia", "Malaysia",
        "Sri Lanka", "Fiji", "Jamaica", "Uganda", "Kenya", "Nigeria", "Sierra Leone",
        "the Gambia", "Northern Rhodesia", "Nyasaland", "Aden", "the Gold Coast",
        "the Federation of Rhodesia and Nyasaland", "North Borneo", "French Indochina",
        "Hungary", "Anguilla", "the Isle of Man", "Wallis and Futuna", "Puerto Rico",
    )]
    result = {}
    for batch in batches(titles):
        data = fetcher.json(WIKIPEDIA, {
            "action": "query", "titles": "|".join(batch), "prop": "revisions",
            "rvprop": "ids|content", "rvslots": "main", "redirects": 1, "format": "json",
        })
        for page in data["query"]["pages"].values():
            if not page.get("revisions"):
                continue
            revision = page["revisions"][0]
            text = revision["slots"]["main"]["*"]
            key = re.sub(r"[^a-z0-9]+", "-", page["title"].lower()).strip("-")
            (CACHE / (key + ".wiki")).write_text(text, encoding="utf-8")
            result[page["title"]] = {"revision": revision["revid"], "sha256": digest(text.encode())}
    return result


def chronology_url(name):
    if name in {"Aden", "the Straits Settlements"}:
        return "https://en.wikipedia.org/wiki/" + {
            "Aden": "Aden_Colony", "the Straits Settlements": "Straits_Settlements",
        }[name]
    return "https://en.wikipedia.org/wiki/Flag_of_" + quote(name.replace(" ", "_"), safe="")


def manual_records():
    result = []

    def add(code, name, filename, start, end, role="national", note="", aliases=(), history=None, source_id=None):
        result.append({
            "id": f"world-{code}-{start}", "names": [name, *aliases],
            "file": filename, "sourceId": source_id,
            "label": f"{name} — {role} flag ({start}" + (f"–{end})" if end else " onward)"),
            "start": start, "end": end, "note": note or "Documented historical design; source date precision is retained. Screen colours are not measurements of historical cloth.",
            "sourceUrl": history or chronology_url(name), "evidence": "editorial chronology",
        })

    for filename, start, end in [
        ("Flag of Italy (1861–1946).svg", "1861", "1946"),
        ("Flag of Italy (1946–2003).svg", "1946", "2003"),
        ("Flag of Italy (2003–2006).svg", "2003", "2006"),
        ("Flag of Italy.svg", "2006", None),
    ]:
        add("it", "Italy", filename, start, end, "national/civil",
            "Savoy-shield kingdom design or the separately specified republican tricolour. Sources distinguish proclamation, decree and publication dates; the transition years are withheld rather than inventing a precise operative day.")
    for filename, start, end, note in [
        ("Flag of Spain (1785–1873, 1875–1931).svg", "1875", "1931", "Monarchical national design; the royal standard is not used."),
        ("Flag of the Second Spanish Republic.svg", "1931", "1939", "Second Republic national tricolour. Civil-war factional flags coexisted; no single flag is asserted to identify every controlling faction."),
        ("Flag of Spain (1938–1945).svg", "1939", "1945", "Franco-government national design, assigned to generic Spain only after the 1939 end of the civil war; earlier Nationalist factional use is not backdated to all Spain."),
        ("Flag of Spain (1945–1977).svg", "1945", "1977", "Government national design, not a personal or military standard."),
        ("Flag of Spain (1977–1981).svg", "1977", "1981", "Transitional national design with the revised eagle."),
        ("Flag of Spain.svg", "1981", None, "Current national/state design with the constitutional coat of arms. The 1981 law, colour specification and construction decree have different dates; that year is withheld."),
    ]:
        add("es", "Spain", filename, start, end, "government/national", note)
    add("cn", "China", "Flag of China (1912–1928).svg", "1912", "1928", "Republic-era national",
        "Five-colour republican design; not a Qing, party, military or presidential standard. Fragmented and competing authority is not represented as one uniform administration.")
    add("cn", "China", "Flag of the Republic of China.svg", "1928", "1949-10-01", "Republic-era national",
        "Republic of China national design on the mainland. Taiwan/Republic of China references remain a separate identity; this record does not describe PRC control before October 1949.")
    add("cn", "China", "Flag of the People's Republic of China.svg", "1949-10-01", None, "People's Republic national",
        "Design approved on 27 September 1949; this national-government record begins with the PRC's proclamation on 1 October, not with earlier party or army flags.")
    add("in-colonial", "India", "British Raj Red Ensign.svg", "1880", "1947-08-15", "colonial civil ensign",
        "British India's Star of India Red Ensign, documented for civil maritime use from 1880; never described as a universally flown sovereign Indian national flag. The Union Flag and official standards had different roles.",
        aliases=("British Raj",), history=chronology_url("India"))
    add("in", "India", "Flag of India.svg", "1947-08-15", None, "national/civil",
        "Adopted by the Constituent Assembly on 22 July 1947 and used as the new state's national flag from independence on 15 August. Wikidata's 1946 adoption year is rejected.")
    add("in-dominion", "Dominion of India", "Flag of India.svg", "1947-08-15", "1950-01-26", "national/civil",
        "The same Ashoka Chakra national design continued when the republic replaced the dominion.", history=chronology_url("India"))
    for filename, start, end, stars in [
        ("Flag of Brazil (1889–1960).svg", "1889-11-19", "1960-04-14", 21),
        ("Flag of Brazil (1960–1968).svg", "1960-04-14", "1968-05-28", 22),
        ("Flag of Brazil (1968–1992).svg", "1968-05-28", "1992-05-11", 23),
        ("Flag of Brazil.svg", "1992-05-11", None, 27),
    ]:
        add("br", "Brazil", filename, start, end, "national/civil",
            f"Separately documented {stars}-star design. The modern 27-star artwork is not substituted for earlier federal compositions.")
    add("za-ensign", "South Africa", "Red Ensign of South Africa (1912–1951).svg", "1912", "1928-05-31",
        "civil ensign", "South African Red Ensign in civil-maritime and unofficial land use; the Union Flag retained official national status. The ensign continued at sea after 1928, but this series then selects the new national flag.")
    add("za", "South Africa", "Flag of South Africa (1928–1994, dark colors).svg", "1928-05-31", "1994-04-27",
        "national", "Historical national design with miniature flags; identified without endorsement of apartheid. The unsupported Wikidata end date 20 April 1994 is not used.")
    add("za", "South Africa", "Flag of South Africa.svg", "1994-04-27", None)
    for filename, start, end, note in [
        ("Flag of Egypt (1882–1922).svg", "1882", "1922", "Historical Egyptian national design during the khedival/sultanate period; not the Ottoman sultan's personal standard."),
        ("Flag of Egypt 1922.svg", "1922", "1958", "Green crescent-and-three-stars national flag of the kingdom; it remained a co-official national design in the early republic, alongside the Liberation Flag."),
        ("Flag of the United Arab Republic (1958–1971), Flag of Syria (1980–2024).svg", "1958", "1972", "United Arab Republic two-star national design, retained by Egypt after Syria left the union. Wikidata's erroneous 1999 end is rejected."),
        ("Flag of Egypt (1972–1984).svg", "1972", "1984-10-04", "National Federation-of-Arab-Republics design with the hawk."),
        ("Flag of Egypt.svg", "1984-10-04", None, "National design with the Eagle of Saladin; the unsupported 1983 Wikidata start is rejected."),
    ]:
        add("eg", "Egypt", filename, start, end, "national", note)
    for filename, start, end, note in [
        ("Flag of Iraq (1924–1959).svg", "1924-07-10", "1959", "Kingdom/early republic national flag; not the king's standard. Sources disagree about the 1958–1959 replacement, so no precise replacement day is asserted."),
        ("Flag of Iraq (1959–1963).svg", "1959", "1963-07-31", "Qasim-era national design. The source year is retained without trusting a potentially normalized January 1 date."),
        ("Flag of Iraq (1963–1991).svg", "1963-07-31", "1991", "Three-star national design before the takbir inscription."),
        ("Flag of Iraq (1991–2004).svg", "1991", "2004", "National design with the Saddam-era script. Conflicting January 1991 days are withheld as a year-level transition."),
        ("Flag of Iraq (2004–2008).svg", "2004", "2008-01-22", "National transition design with Kufic script; the year-only 2004 transition is deliberately withheld."),
        ("Flag of Iraq.svg", "2008-01-22", None, "Current national design, with the three stars removed."),
    ]:
        add("iq", "Iraq", filename, start, end, "national", note)
    for filename, start, end in [
        ("Civil flag of Persia (1907–1933).svg", "1907", "1933"),
        ("Civil flag of Iran (1933–1964).svg", "1933", "1964"),
        ("Civil flag of Iran (1964–1980).svg", "1964", "1980-07"),
        ("Flag of Iran.svg", "1980-07", None),
    ]:
        add("ir", "Iran", filename, start, end, "national/civil",
            "Historical civil tricolours are distinct from the lion-and-sun state flag and royal/naval standards. The current Islamic Republic emblem is not backdated. The documented July 1980 transition month is withheld.",
            aliases=("Persia",) if end else ())
    for filename, start, end, note in [
        ("Flag of Syria (1930–1958, 1961–1963).svg", "1932", "1958-02-22", "Independence-era national design. Conflicting mandate-era 1930/1932 accounts are not converted to a fabricated day."),
        ("Flag of the United Arab Republic (1958–1971), Flag of Syria (1980–2024).svg", "1958-02-22", "1961-09-28", "Two-star flag of the Egyptian–Syrian union, not the later three-star Syrian design."),
        ("Flag of Syria (1930–1958, 1961–1963).svg", "1961-09-28", "1963-03-08", "Restored independence-era design after withdrawal from the union."),
        ("Flag of Syria (1963–1972).svg", "1963-03-08", "1972-01-01", "Three-star Ba'ath-era national design; distinct from the two-star UAR/1980 flag."),
        ("Flag of Syria (1972–1980).svg", "1972-01-01", "1980-03-29", "Federation-of-Arab-Republics national design."),
        ("Flag of the United Arab Republic (1958–1971), Flag of Syria (1980–2024).svg", "1980-03-29", "2024-12-08", "Assad-era government national design; not a claim that the government controlled every area during the civil war."),
        ("Flag of Syria (2025-).svg", "2025-03-13", None, "Constitutional-declaration national design, including its current 2:3 proportions. The December 2024 caretaker/opposition use of an earlier design does not backdate the 2025 artwork."),
    ]:
        aliases = ["Syrian Republic"] if start in {"1932", "1961-09-28"} else []
        if start >= "1961-09-28":
            aliases.append("Syrian Arab Republic")
        add("sy", "Syria", filename, start, end, "government/national", note, aliases=aliases)
    af_history = chronology_url("Afghanistan")
    af_rows = [
        ("Flag of Afghanistan (1901–1919).svg", "1901", "1919", ()),
        ("Flag of Afghanistan (1926–1928).svg", "1926", "1928", ()),
        ("Flag of Afghanistan (1928–1929).svg", "1928", "1929", ()),
        ("Flag of Afghanistan (1929).svg", "1929-01", "1929-10", ()),
        ("Flag of Afghanistan (1929–1931).svg", "1929-10", "1931-03-27", ()),
        ("Flag of Afghanistan (1931–1973).svg", "1931-03-27", "1973-07-17", ()),
        ("Flag of Afghanistan (1973–1974).svg", "1973-07-17", "1974-05-09", ("Republic of Afghanistan",)),
        ("Flag of Afghanistan (1974–1978).svg", "1974-05-09", "1978-04-27", ("Republic of Afghanistan",)),
        ("Flag of Afghanistan (1978).svg", "1978-04-27", "1978-10-19", ("Democratic Republic of Afghanistan",)),
        ("Flag of Afghanistan (1978–1980).svg", "1978-10-19", "1980-04-22", ("Democratic Republic of Afghanistan",)),
        ("Flag of Afghanistan (1980–1987).svg", "1980-04-22", "1987-11-30", ("Democratic Republic of Afghanistan",)),
        ("Flag of Afghanistan (1987–1992).svg", "1987-11-30", "1992-04-27", ("Democratic Republic of Afghanistan",)),
        ("Flag of Afghanistan (1992).svg", "1992-04-27", "1992-12-07", ("Islamic State of Afghanistan",)),
        ("Flag of Afghanistan (1992–2001).svg", "1992-12-07", "1996-09-27", ("Islamic State of Afghanistan",)),
        ("Flag of Taliban (original).svg", "1996-09-27", "1997-10-27", ("Islamic Emirate of Afghanistan (1996–2001)",)),
        ("Flag of the Taliban.svg", "1997-10-27", "2001-11-13", ("Islamic Emirate of Afghanistan (1996–2001)",)),
        ("Flag of Afghanistan (2001–2002).svg", "2001-11-13", "2002-01-28", ("Islamic State of Afghanistan",)),
        ("Flag of Afghanistan (2002–2004).svg", "2002-01-28", "2002-06-27", ("Transitional Islamic State of Afghanistan",)),
        ("Flag of Afghanistan (2002–2004, variant with golden arms).svg", "2002-06-27", "2004-10-09", ("Transitional Islamic State of Afghanistan",)),
        ("Flag of Afghanistan (2004–2021, variant).svg", "2004-10-09", "2013-08-19", ("Islamic Republic of Afghanistan",)),
        ("Flag of Afghanistan (2013–2021).svg", "2013-08-19", "2021-08-15", ("Islamic Republic of Afghanistan",)),
        ("Flag of the Taliban.svg", "2021-08-15", None, ()),
    ]
    for filename, start, end, aliases in af_rows:
        role = "de facto government" if "Taliban" in filename else "government/national"
        add("af", "Afghanistan", filename, start, end, role,
            "Date-bounded design, not a claim of universal territorial control or diplomatic recognition. Republican, communist and Taliban-era designs are distinct. Uncertain transition months/years and the unsupported 1919–1926 interval remain unassigned.",
            aliases=aliases, history=af_history)
    for code, name, filename, start, end, aliases in [
        ("cs", "Czechoslovakia", "Flag of Bohemia.svg", "1918", "1920-03-30", ()),
        ("cs", "Czechoslovakia", "Flag of the Czech Republic.svg", "1920-03-30", "1939", ()),
        ("cs", "Czechoslovakia", "Flag of the Czech Republic.svg", "1945", "1993-01-01", ()),
        ("cs-federal", "Czech and Slovak Federative Republic", "Flag of the Czech Republic.svg", "1990", "1993-01-01", ()),
        ("yu-kingdom", "Kingdom of Yugoslavia", "Flag of Yugoslavia (1918–1941).svg", "1918-12-01", "1941", ("Kingdom of Serbs, Croats and Slovenes", "Yugoslavia")),
        ("yu-democratic", "Democratic Federal Yugoslavia", "Flag of Yugoslavia (1943–1946).svg", "1943", "1946", ("Yugoslavia",)),
        ("yu-socialist", "Socialist Federal Republic of Yugoslavia", "Flag of Yugoslavia (1946-1992).svg", "1946-01-31", "1992-04-27", ("FPR Yugoslavia", "Federal People's Republic of Yugoslavia", "Yugoslavia")),
        ("yu-federal", "Federal Republic of Yugoslavia", "Flag of Serbia and Montenegro (1992–2006).svg", "1992-04-27", "2003-02-04", ("Yugoslavia",)),
        ("yu-union", "Serbia and Montenegro", "Flag of Serbia and Montenegro (1992–2006).svg", "2003-02-04", "2006-06-05", ()),
    ]:
        add(code, name, filename, start, end, "national",
            "Historical state's national design, not an automatic alias for any modern successor. Occupation, governments in exile and competing administrations are not treated as uniform territorial control.",
            aliases=aliases, history=chronology_url("Czechoslovakia" if code.startswith("cs") else "Yugoslavia"))
    add("iq-mandate", "Mandatory Iraq", "Flag of the Arab Federation.svg", "1921-08-23", "1924-07-10", "national/mandate government",
        "Early Hashemite design under the British mandate; the same design was later reused by the 1958 Arab Federation. It is not the British Union Flag or a royal standard.", history=chronology_url("Iraq"))
    add("iq-mandate", "Mandatory Iraq", "Flag of Iraq (1924–1959).svg", "1924-07-10", "1932-10-03", "national/mandate government",
        "The two-star Hashemite national design in the mandate period; independent kingdom use is separately bounded.", history=chronology_url("Iraq"))
    add("iq-kingdom", "Hashemite Kingdom of Iraq", "Flag of Iraq (1924–1959).svg", "1932-10-03", "1958-07-14", "national",
        "The kingdom's national design, not the monarch's personal standard; it briefly continued under the republic but this kingdom identity ends at the 1958 revolution.", history=chronology_url("Iraq"))
    add("eg-republic", "Republic of Egypt", "Flag of Egypt 1922.svg", "1953-06-18", "1958-02-22", "co-national",
        "The green national flag remained co-official in the early republic alongside the Liberation Flag; this series selects one documented national design, not a president's standard.", history=chronology_url("Egypt"))
    add("uar", "United Arab Republic", "Flag of the United Arab Republic (1958–1971), Flag of Syria (1980–2024).svg",
        "1958-02-22", "1971", "national", "Two-star Egyptian–Syrian union flag, retained by Egypt after Syria's withdrawal until the state was renamed.", history=chronology_url("Egypt"))
    add("ru-empire", "Russian Empire", "Flag of Russia.svg", "1896", "1917", "national/civil",
        "Imperial white-blue-red national/civil design. This record is ONLY for the Russian Empire; it is not added to Russia, the USSR or RSFSR aliases. Historical colours were not a modern RGB standard.",
        history=chronology_url("Russia"))
    for code, name, filename, start, end, aliases in [
        ("mm", "Myanmar", "Flag of Burma (1948–1974).svg", "1948-01-04", "1974-01-03", ()),
        ("mm", "Myanmar", "Flag of Myanmar (1974–2010).svg", "1974-01-03", "2010-10-21", ()),
        ("ly-kingdom", "Libya", "Flag of Libya.svg", "1951-12-24", "1969-09-01", ("Kingdom of Libya",)),
        ("ly-republic", "Libya", "Flag of Libya (1969–1972).svg", "1969-09-01", "1972-01-01", ("Libyan Arab Republic",)),
        ("ly-federation", "Libya", "Flag of Libya (1972–1977).svg", "1972-01-01", "1977-11-19", ()),
        ("ly-green", "Libya", "Flag of Libya (1977–2011).svg", "1977-11-19", "2011", ()),
        ("cd-zaire", "Democratic Republic of the Congo", "Flag of Zaire (1971–1997).svg", "1971-10-27", "1997-05-17", ("Zaire",)),
    ]:
        add(code, name, filename, start, end, "national",
            "Documented former national design, not a modern substitute. Current references and later specification changes are separately bounded.",
            aliases=aliases, history=chronology_url(name))
    for code, name, filename, start, end, aliases, history in [
        ("aden", "Aden Colony", "Flag of Aden (1937–1963).svg", "1937", "1963", (), "Aden"),
        ("rhodesia-colony", "Southern Rhodesia", "Flag of Southern Rhodesia (1924–1964).svg", "1924", "1964", (), "Rhodesia"),
        ("rhodesia-blue", "Southern Rhodesia", "Flag of Rhodesia (1964–1968).svg", "1964", "1968", ("Rhodesia",), "Rhodesia"),
        ("rhodesia-udi", "Southern Rhodesia", "Flag of Rhodesia (1968–1979).svg", "1968", "1979", ("Rhodesia",), "Rhodesia"),
        ("rhodesia-federation", "Federation of Rhodesia and Nyasaland", "Flag of Rhodesia and Nyasaland (1953–1963).svg", "1953", "1963", (), "the Federation of Rhodesia and Nyasaland"),
        ("northern-rhodesia", "Northern Rhodesia", "Flag of Northern Rhodesia (1939–1964).svg", "1939", "1964", (), "Northern Rhodesia"),
        ("nyasaland", "Nyasaland", "Flag of Nyasaland (1919–1925).svg", "1919", "1925", (), "Nyasaland"),
        ("nyasaland", "Nyasaland", "Flag of Nyasaland (1925–1964).svg", "1925", "1964", (), "Nyasaland"),
        ("hk-colonial", "British Hong Kong", "Flag of Hong Kong (1871–1876).svg", "1871", "1876", ("Hong Kong",), "Hong Kong"),
        ("hk-colonial", "British Hong Kong", "Flag of Hong Kong (1876–1955).svg", "1876", "1955", ("Hong Kong",), "Hong Kong"),
        ("hk-colonial", "British Hong Kong", "Flag of Hong Kong (1955–1959).svg", "1955", "1959", ("Hong Kong",), "Hong Kong"),
        ("hk-colonial", "British Hong Kong", "Flag of Hong Kong (1959–1997).svg", "1959", "1997-07-01", ("Hong Kong",), "Hong Kong"),
        ("north-borneo", "North Borneo", "Flag of North Borneo (1902–1946).svg", "1902", "1946", ("Colony of North Borneo",), "North Borneo"),
        ("north-borneo", "North Borneo", "Flag of North Borneo (1948–1963).svg", "1948", "1963", ("Colony of North Borneo",), "North Borneo"),
        ("malaya-federated", "Federated Malay States", "Flag of Malaya (1896–1950).svg", "1896", "1946", (), "Malaysia"),
        ("malaya-union", "Malayan Union", "Flag of Malaya (1896–1950).svg", "1946", "1948", (), "Malaysia"),
        ("malaya-federation", "Federation of Malaya", "Flag of Malaya (1896–1950).svg", "1948", "1950", (), "Malaysia"),
        ("malaya-federation", "Federation of Malaya", "Flag of Malaya (1950–1963).svg", "1950", "1963-09-16", (), "Malaysia"),
        ("straits", "Colony of the Straits Settlement", "Flag of the British Straits Settlements (1904–1925).svg", "1904", "1925", (), "the Straits Settlements"),
        ("straits", "Colony of the Straits Settlement", "Flag of the British Straits Settlements (1925–1946).svg", "1925", "1946", (), "the Straits Settlements"),
        ("ceylon-colonial", "British Ceylon", "Flag of Ceylon (1875–1948).svg", "1875", "1948-02-04", (), "Sri Lanka"),
        ("burma-colonial", "British Burma", "Flag of Burma (1939–1941, 1945–1948).svg", "1939", "1941", (), "Myanmar"),
        ("burma-colonial", "British Burma", "Flag of Burma (1939–1941, 1945–1948).svg", "1945", "1948-01-04", (), "Myanmar"),
        ("fiji-colonial", "Colony of Fiji", "Flag of Fiji (1908–1924).svg", "1908", "1924", (), "Fiji"),
        ("fiji-colonial", "Colony of Fiji", "Flag of Fiji (1924–1970).svg", "1924", "1970-10-10", (), "Fiji"),
        ("jamaica-colonial", "Colony of Jamaica", "Flag of Jamaica (1906–1957).svg", "1906", "1957", (), "Jamaica"),
        ("jamaica-colonial", "Colony of Jamaica", "Flag of Jamaica (1957–1962).svg", "1957", "1962", (), "Jamaica"),
        ("uganda-colonial", "Protectorate of Uganda", "Flag of the Uganda Protectorate.svg", "1914", "1962-10-09", (), "Uganda"),
        ("kenya-colonial", "Protectorate of Kenya", "Flag of Kenya (1921–1963).svg", "1921", "1963-12-12", (), "Kenya"),
        ("gambia-colonial", "Gambia Colony and Protectorate", "Flag of The Gambia (1889–1965).svg", "1889", "1965-02-18", (), "the Gambia"),
        ("sierra-leone-colonial", "Sierra Leone Protectorate", "Flag of Sierra Leone (1889–1916).svg", "1889", "1916", (), "Sierra Leone"),
        ("sierra-leone-colonial", "Sierra Leone Protectorate", "Flag of Sierra Leone (1916–1961).svg", "1916", "1961-04-27", (), "Sierra Leone"),
        ("gold-coast", "Gold Coast", "Flag of the Gold Coast (1877–1957).svg", "1877", "1957-03-06", (), "the Gold Coast"),
        ("nigeria-colonial", "Federation of Nigeria", "Flag of Nigeria (1914–1952).svg", "1914", "1952", (), "Nigeria"),
        ("nigeria-colonial", "Federation of Nigeria", "Flag of Nigeria (1952–1960).svg", "1952", "1960-10-01", (), "Nigeria"),
    ]:
        role = "de facto government/national" if code == "rhodesia-udi" else "colonial government/civil"
        if code == "malaya-federation":
            role = "federation national/civil (colonial before independence)"
        add(code, name, filename, start, end, role,
            "Documented national/civil or colonial-government flag/ensign as labelled, not a royal or military standard or proof of uninterrupted control. "
            "Wartime occupations, internal jurisdictions and other concurrent flag roles are not collapsed into one sovereignty claim. "
            "Year-only transitions remain withheld."
            + (" Rhodesia after UDI was an unrecognized white-minority regime." if code == "rhodesia-udi" else ""),
            aliases=aliases, history=chronology_url(history))
    for code, name, start, end, aliases in [
        ("fr-indochina", "French Indochina", "1887", "1954", ()),
        ("fr-madagascar", "Colony of Madagascar", "1897", "1958", ()),
        ("fr-middle-congo", "Colony of Middle Congo", "1910", "1958", ()),
        ("fr-niger", "Colony of Niger", "1922", "1958", ()),
        ("fr-mauritania", "Mauritania Colony", "1920", "1958", ()),
        ("fr-upper-volta", "Upper Volta Protectorate", "1919", "1932", ()),
        ("fr-upper-volta", "Upper Volta Protectorate", "1947", "1958", ()),
        ("fr-guadeloupe", "Colony of Guadelupe", "1830", "1946", ()),
    ]:
        add(code, name, None, start, end, "inherited French national/civil",
            "French national tricolour in the colonial administration's inherited national role, not an invented distinctive territorial ensign. "
            "The cited administration history bounds this identity; the existing French source separately documents the tricolour and its schematic historical colours.",
            aliases=aliases, history="https://en.wikipedia.org/wiki/" + quote({
                "Colony of Madagascar": "French Madagascar", "Colony of Middle Congo": "French Congo",
                "Colony of Niger": "Colony of Niger", "Mauritania Colony": "Colonial Mauritania",
                "Upper Volta Protectorate": "French Upper Volta", "Colony of Guadelupe": "History of Guadeloupe",
            }.get(name, name).replace(" ", "_")), source_id="fr-tricolour")
    add("hu", "Hungary", "Flag of Hungary.svg", "2000", None, "government/national, 1:2",
        "The plain tricolour was restored in 1957, but the government flag's current 1:2 proportion is specified by the 2000 decree. This particular graphic is not backdated to unspecified earlier proportions; the uncorroborated 1989–2003 competing statement is quarantined.")
    add("ai", "Anguilla", "Flag of Anguilla.svg", "1999-01-25", None, "territorial government/civil",
        "The Blue Ensign was adopted in 1990, but this current coat-of-arms rendering is bounded by the documented 25 January 1999 arms modification, not backdated to the first ensign.")
    add("im", "Isle of Man", "Flag of the Isle of Man.svg", "1932", None, "territorial civil/government",
        "The source documents official use in 1932, with conflicting accounts of an earlier date; the year is retained conservatively. A Crown Dependency flag, not a separate sovereign state's national flag.",
        history=chronology_url("the Isle of Man"))
    add("hk", "Hong Kong", "Flag of Hong Kong.svg", "1997-07-01", None, "territorial government/civil",
        "The bauhinia design was approved in 1990 but this SAR-government use record begins with the 1 July 1997 handover, not earlier colonial rule.")
    add("pr", "Puerto Rico", "Flag of Puerto Rico.svg", "1995-08-03", None, "territorial government/civil",
        "The current medium-blue rendering is conservatively bounded by the 1995 regulation and common usage, not the 1895 revolutionary first use or the darker-blue commonwealth rendering of 1952. The law names colours but does not prescribe a unique blue shade; this is not a claim of sovereignty.")
    add("nc", "New Caledonia", None, "1853", None, "inherited French national/civil",
        "The French national tricolour in its inherited national role from French annexation. The Kanak flag is also flown; this is not a unique local flag, a political endorsement or a claim of universal resident identification.",
        source_id="fr-tricolour", history=chronology_url("New Caledonia"))
    add("tf", COUNTRY_NAMES["tf"], None, "1955", None, "inherited French national/civil",
        "The French national flag identifies the administration, bounded here by the overseas territory's 1955 creation. It is not the administrator's personal flag or a claim that Antarctica has a national flag.",
        aliases=tuple(COUNTRY_ALIASES["tf"][1:]), source_id="fr-tricolour",
        history="https://en.wikipedia.org/wiki/French_Southern_and_Antarctic_Lands")
    add("wf", "Wallis and Futuna", None, "1961", None, "inherited French national/civil",
        "France's national flag is the only official flag, not the unofficial local red-and-canton design. This record conservatively begins with overseas-territory status in 1961, not an invented adoption of a distinct flag.",
        source_id="fr-tricolour", history=chronology_url("Wallis and Futuna"))
    add("sh", "Saint Helena, Ascension and Tristan da Cunha", None, "2009-09-01", None, "inherited UK national/civil",
        "The combined territory has no unified local ensign. The Union Flag identifies the sovereign-national role under the constitution effective 1 September 2009, not Saint Helena island's local ensign or a new national-flag adoption.",
        source_id="gb-1801", history="https://en.wikipedia.org/wiki/Saint_Helena,_Ascension_and_Tristan_da_Cunha")
    et_lion = "Flag of Ethiopia (1897-1936; 1941-1974).svg"
    et_plain = "Flag of Ethiopia (1991–1996).svg"
    et_old_star = "Flag of Ethiopia (1996).svg"
    for filename, start, end, aliases, role in [
        ("Flag of Ethiopia (1897-1914).svg", "1897", "1914", ("Ethiopian Empire",), "national"),
        (et_lion, "1914", "1936", ("Ethiopian Empire",), "national"),
        (et_lion, "1941", "1974", ("Ethiopian Empire",), "national"),
        ("Flag of Ethiopia (1975–1987).svg", "1975", "1987", ("Ethiopia (1962-1991)",), "civil"),
        ("Flag of Ethiopia (1987–1991).svg", "1987", "1991", ("Ethiopia (1962-1991)",), "government/national"),
        (et_plain, "1991", "1996", (), "civil"),
        (et_old_star, "1996-10-31", "2009-05-16", ("Ethiopia (1993-)",), "national"),
        ("Flag of Ethiopia.svg", "2009-05-16", None, ("Ethiopia (1993-)",), "national"),
    ]:
        add("et", "Ethiopia", filename, start, end, role,
            "Separately documented imperial, civil, socialist-government or federal design as labelled. The 2009 larger-emblem artwork is not backdated to 1996; the overlapping and incorrect Wikidata precision is not used. Occupation and uncertain transition years remain explicit gaps.",
            aliases=aliases)
    for code, name, filename, start, end in [
        ("et-1942", "Ethiopia (1942-1952)", et_lion, "1942", "1952"),
        ("et-federation", "Ethiopian–Eritrean Federation (1952-1962)", et_lion, "1952", "1962"),
        ("et-1962", "Ethiopia (1962-1991)", et_lion, "1962", "1974"),
        ("et-1991", "Ethiopia (1991-1993)", et_plain, "1991", "1993"),
        ("et-1993", "Ethiopia (1993-)", et_plain, "1993", "1996"),
    ]:
        add(code, name, filename, start, end, "national/civil",
            "The documented flag period is restricted to this exact dated boundary-controller identity. The name's reduced-precision transition years are withheld rather than assigning a successor flag.",
            history=chronology_url("Ethiopia"))
    return result


def date_limit(value, start):
    if value is None:
        return float("inf")
    if not re.fullmatch(r"\d{4}(?:-\d{2}(?:-\d{2})?)?", value):
        raise ValueError(f"Invalid reduced-precision date: {value}")
    parts = [int(part) for part in value.split("-")]
    if len(parts) == 1:
        year = parts[0] + int(start)
        return datetime(year, 1, 1, tzinfo=timezone.utc).timestamp()
    if len(parts) == 2:
        year, month = parts
        if start:
            month += 1
            if month == 13:
                year, month = year + 1, 1
        return datetime(year, month, 1, tzinfo=timezone.utc).timestamp()
    return datetime(*parts, tzinfo=timezone.utc).timestamp()


def effective_range(record):
    return date_limit(record["start"], True), date_limit(record["end"], False)


def year_in(record, year):
    sample = (datetime(year, 1, 1, tzinfo=timezone.utc).timestamp()
              + datetime(year + 1, 1, 1, tzinfo=timezone.utc).timestamp()) / 2
    start, end = effective_range(record)
    return start <= sample < end


def choose_records(countries, choices, qid_to_code, entities, statements, adoption_html, historical):
    by_code = {row["id"].lower(): row for row in countries}
    table = adoption_rows(adoption_html)
    manual = manual_records()
    manual_names = {normalize(name) for row in manual for name in row["names"]}
    manual_current_names = {normalize(name) for row in manual if row["end"] is None for name in row["names"]}
    records = list(manual)
    quarantine, scope_excluded = [], 0
    current_keys = set()
    for code, choice in choices.items():
        if choice.get("preserved") or choice.get("qid") in PRESERVED_ENTITIES:
            continue
        country = by_code[code]
        if normalize(country["name"]) in manual_current_names:
            continue
        statement = choice.get("statement")
        starts = (statement or {}).get("starts", [])
        start = starts[0] if len(starts) == 1 and starts[0] else None
        row = next((table[normalize(name)] for name in country["names"] if normalize(name) in table), None)
        chronology = (statement or {}).get("sourceUrl") or file_url("File:" + choice["file"])
        note = "Current design, not its earliest ancestral use. Screen colours are not measurements of historical cloth."
        if row and (start is None or int(row["start"][:4]) > int(start[:4])):
            if start is not None:
                quarantine.append({"statement": statement, "reason": "Current SVG has a later design/specification date in the adoption chronology", "replacementStart": row["start"]})
            start = row["start"]
            chronology = ADOPTION_URL
            note += " The latest documented design/specification date is used conservatively, not the first-use column; reduced-precision transition periods are withheld."
        elif row and start and row["start"][:4] == start[:4]:
            other = row["start"]
            if other.startswith(start) and len(other) > len(start):
                start, chronology = other, ADOPTION_URL
            elif not (start.startswith(other) or other.startswith(start)):
                common = start[:7] if len(start) >= 7 and len(other) >= 7 and start[:7] == other[:7] else start[:4]
                quarantine.append({"statement": statement, "reason": "Sources disagree on transition month/day", "adoptionTableDate": other, "retainedPrecision": common})
                start, chronology = common, ADOPTION_URL
                note += " Conflicting day/month claims are quarantined; only their common month or year is retained, with that transition period withheld."
        if code == "tw":
            start, chronology = "1949", chronology_url("the Republic of China")
            note += " This Taiwan-labelled record begins with the 1949 relocation of the ROC government; mainland China has a separate historical record."
        if not start:
            quarantine.append({"country": country["name"], "file": choice["file"], "reason": "Current reference only: no supported design-adoption date"})
            continue
        record = {
            "id": f"world-{code}-current-use", "names": country["names"], "file": choice["file"],
            "sourceId": choice["sourceId"], "label": country["name"] + " — current national/civil flag",
            "start": start, "end": None, "sourceUrl": chronology,
            "note": note + (" " + country["note"] if country.get("note") else ""),
            "evidence": "current design chronology",
        }
        if code in {"io", "ai", "bm", "ky", "fk", "gi", "ms", "pn", "tc", "vg", "gs", "gg", "je", "im", "ax", "cx", "cc", "nf", "pf", "gl", "fo", "pr", "gu", "mp", "as", "vi", "aw", "cw", "sx", "hk", "mo"}:
            record["label"] = country["name"] + " — territorial civil/government flag"
        records.append(record)
        current_keys.add((choice.get("qid"), choice["file"]))

    for statement in statements:
        qid, filename = statement["entity"], statement["file"]
        if qid in PRESERVED_ENTITIES:
            quarantine.append({"statement": statement, "reason": "Existing curated country's dates, Nazi neutral identifier, occupation gap and Russia/USSR separation take precedence"})
            continue
        code = qid_to_code.get(qid)
        names = by_code[code]["names"] if code else historical.get(qid, [])
        if not names:
            quarantine.append({"statement": statement, "reason": "No reviewed administration alias mapping"})
            continue
        if qid in MANUAL_ENTITIES or (not code and normalize(names[0]) in manual_names):
            quarantine.append({"statement": statement, "reason": "Explicitly reviewed flag-history sequence replaces raw claims for this entity"})
            continue
        if (qid, filename) in current_keys and not statement["ends"]:
            continue
        reason = role_rejection(filename)
        if not reason and statement["rank"] == "deprecated":
            reason = "Deprecated source statement"
        if not reason and (len(statement["starts"]) != 1 or not statement["starts"][0]):
            reason = "Missing, ambiguous, non-Gregorian or insufficiently precise flag start date"
        if not reason and (len(statement["ends"]) != 1 or not statement["ends"][0]):
            reason = "No bounded end date for a non-current design; entity lifespan is not a flag chronology"
        if reason:
            quarantine.append({"statement": statement, "reason": reason})
            continue
        start, end = statement["starts"][0], statement["ends"][0]
        if int(end[:4]) < 1914:
            scope_excluded += 1
            continue
        if role_rejection(filename):
            continue
        if statement["qualifiers"].keys() & {"P31", "P366", "P3831", "P518", "P1535", "P5102"}:
            quarantine.append({"statement": statement, "reason": "Flag-type, scope, use or role qualifiers require independent review"})
            continue
        years_in_file = re.findall(r"\b(?:18|19|20)\d{2}\b", filename)
        if years_in_file and (int(start[:4]) < int(years_in_file[0]) or
                              (len(years_in_file) == 2 and int(end[:4]) > int(years_in_file[1]))):
            quarantine.append({"statement": statement, "reason": "Statement dates conflict with the explicitly dated artwork filename"})
            continue
        if (qid, filename) in current_keys:
            quarantine.append({"statement": statement, "reason": "Earlier reuse of a current SVG requires a separately verified historical rendering"})
            continue
        role = "civil ensign" if "ensign" in filename.lower() else "national/civil flag"
        if any(word in (names[0] + filename).lower() for word in ("colon", "protectorate", "mandate")):
            role = "colonial government/civil flag"
        records.append({
            "id": "world-wd-" + statement["statement"].replace("$", "-").lower(),
            "names": names, "file": filename, "sourceId": None,
            "label": names[0] + " — historical " + role,
            "start": start, "end": end, "sourceUrl": statement["sourceUrl"],
            "note": "Date-qualified Wikidata P41 statement (CC0); source precision retained. "
                    + ("The statement has references. " if statement["hasReferences"] else "The statement has no independent reference attached; it is source-derived, not a claim of exhaustive historical verification. ")
                    + "National/civil or explicitly colonial design, not a personal or military standard; screen colours are illustrative.",
            "evidence": "Wikidata date qualifiers",
        })

    # A manual segment wins only when the same artwork and period were explicitly
    # reviewed; unrelated overlaps are quarantined rather than clipped into dates.
    filtered = []
    for record in records:
        if record["evidence"] == "Wikidata date qualifiers":
            aliases = {normalize(name) for name in record["names"]}
            a, b = effective_range(record)
            if any(aliases & {normalize(name) for name in row["names"]} and
                   a < effective_range(row)[1] and effective_range(row)[0] < b
                   for row in manual):
                quarantine.append({"record": record, "reason": "Conflicts with an explicitly reviewed historical sequence"})
                continue
        filtered.append(record)
    invalid = set()
    by_alias = defaultdict(list)
    for record in filtered:
        try:
            start, end = effective_range(record)
        except ValueError:
            invalid.add(record["id"])
            quarantine.append({"record": record, "reason": "Invalid source interval"})
            continue
        if start >= end:
            invalid.add(record["id"])
            quarantine.append({"record": record, "reason": "No usable interval at the documented date precision"})
            continue
        for name in record["names"]:
            by_alias[normalize(name)].append((start, end, record))
    for name, rows in by_alias.items():
        rows.sort(key=lambda row: (row[0], row[1], row[2]["id"]))
        for index, (start, end, record) in enumerate(rows):
            for other_start, other_end, other in rows[index + 1:]:
                if other_start >= end:
                    break
                if record["id"] == other["id"]:
                    continue
                invalid.update([record["id"], other["id"]])
                quarantine.append({"alias": name, "recordIds": [record["id"], other["id"]], "reason": "Overlapping usable designs: both candidates quarantined, no invented transition"})
    return [record for record in filtered if record["id"] not in invalid], quarantine, scope_excluded


def license_fields(info):
    metadata = info.get("extmetadata", {})
    value = lambda name: plain(metadata.get(name, {}).get("value", ""))
    short = value("LicenseShortName")
    if short == "Public domain":
        license_id = "Public domain"
    elif short in {"CC0", "CC0 1.0"}:
        license_id = "CC0-1.0"
    elif re.fullmatch(r"CC BY(?:-SA)? [234]\.[05]", short):
        license_id = short.replace(" ", "-")
    elif short == "OGL-om 1.0":
        raise ValueError("OGL-Oman excludes official government emblems; a separately licensed rendering is required")
    else:
        raise ValueError(f"Unreviewed per-file licence: {short or '(absent)'}")
    license_url = value("LicenseUrl") or LICENSE_URLS.get(license_id)
    if not license_url:
        raise ValueError(f"Missing licence URL for {license_id}")
    if license_url.startswith("//"):
        license_url = "https:" + license_url
    artist = value("Artist")
    credit = artist or "Creator not specified in Commons metadata; source file history identifies contributors."
    if license_id == "OGL-OM-1.0":
        credit = "Sultanate of Oman government information; SVG contributors identified in the linked Commons file history."
    if license_id.startswith("CC-BY") and (not artist or artist.casefold() in {"see below.", "unknown", "unknown author"}):
        raise ValueError("Attribution licence without usable author metadata")
    return license_id, license_url, credit


def normalize_svg_whitespace(root, preserve=False):
    preserve = preserve or root.tag.rsplit("}", 1)[-1] in {"text", "title", "desc"} or root.get(
        "{http://www.w3.org/XML/1998/namespace}space") == "preserve"
    if not preserve and root.text is not None and not root.text.strip():
        root.text = None
    if root.tag == "{" + SVG + "}style" and root.text:
        root.text = re.sub(r"(?m)^[ \t]+$", "", root.text)
    for child in root:
        normalize_svg_whitespace(child, preserve)
        if not preserve and child.tail is not None and not child.tail.strip():
            child.tail = None


def sanitize_svg(raw, source):
    text = raw.decode("utf-8-sig")
    if "<!ENTITY" in text.upper():
        raise ValueError("SVG contains an XML entity declaration")
    text = re.sub(r"<!DOCTYPE[^>]*(?:\[[\s\S]*?\]\s*)?>", "", text, flags=re.I)
    root = ET.fromstring(text)
    if root.tag != f"{{{SVG}}}svg":
        raise ValueError("SVG root namespace is not the SVG namespace")
    for parent in list(root.iter()):
        for child in list(parent):
            if not child.tag.startswith("{" + SVG + "}") or child.tag.rsplit("}", 1)[-1] in {"metadata", "script"}:
                parent.remove(child)
    references = set()
    for element in root.iter():
        for attribute, value in element.attrib.items():
            if attribute.rsplit("}", 1)[-1] == "href" and value.startswith("#"):
                references.add(value[1:])
            references.update(re.findall(r"url\(\s*['\"]?#([^)'\"\s]+)", value))
    for parent in list(root.iter()):
        for child in list(parent):
            if child.tag == "{" + SVG + "}text" and not "".join(child.itertext()).strip():
                child_ids = {node.get("id") for node in child.iter() if node.get("id")}
                if not child_ids & references:
                    parent.remove(child)
    for definitions in list(root.iter("{" + SVG + "}defs")):
        for child in list(definitions):
            if child.tag.rsplit("}", 1)[-1] in SAFE_ELEMENTS:
                continue
            subtree = set(child.iter())
            child_ids = {element.get("id") for element in subtree if element.get("id")}
            referenced = set()
            for element in root.iter():
                if element in subtree:
                    continue
                for attribute, value in element.attrib.items():
                    if attribute.rsplit("}", 1)[-1] == "href" and value.startswith("#"):
                        referenced.add(value[1:])
                    referenced.update(re.findall(r"url\(\s*['\"]?#([^)'\"\s]+)", value))
                if element.tag == "{" + SVG + "}style":
                    referenced.update(re.findall(r"url\(\s*['\"]?#([^)'\"\s]+)", element.text or ""))
            if not child_ids & referenced:
                definitions.remove(child)
    for element in root.iter():
        name = element.tag.rsplit("}", 1)[-1]
        if name not in SAFE_ELEMENTS:
            raise ValueError(f"Visible SVG element requires review: {name}")
        for attribute in list(element.attrib):
            local = attribute.rsplit("}", 1)[-1]
            if (attribute.startswith("{") and not attribute.startswith("{" + XLINK + "}") and
                    not attribute.startswith("{http://www.w3.org/XML/1998/namespace}")) or local.lower().startswith("on") or attribute == "{http://www.w3.org/XML/1998/namespace}base":
                del element.attrib[attribute]
        if name == "style" and re.search(r"@|url\(|expression\(|javascript:", element.text or "", re.I):
            raise ValueError("SVG stylesheet contains non-self-contained or unsupported constructs")
    if "viewBox" not in root.attrib:
        dimensions = []
        for dimension in ("width", "height"):
            match = re.fullmatch(r"([+-]?(?:\d*\.?\d+)(?:[eE][+-]?\d+)?)(px|pt|in|cm|mm)?", root.get(dimension, ""))
            if not match:
                raise ValueError("SVG has neither native viewBox nor usable intrinsic dimensions")
            factor = {None: 1, "px": 1, "pt": 96 / 72, "in": 96, "cm": 96 / 2.54, "mm": 96 / 25.4}[match[2]]
            dimensions.append(float(match[1]) * factor)
        root.set("viewBox", f"0 0 {dimensions[0]:g} {dimensions[1]:g}")
    root.set("viewBox", " ".join(re.split(r"[\s,]+", root.attrib["viewBox"].strip())))
    desc = ET.Element("{" + SVG + "}desc")
    desc.text = (
        f"{source['title']}. Source: {source['sourceUrl']}. "
        f"Credit: {source['credit']}. Licence: {source['license']} ({source['licenseUrl']}). "
        f"Original content SHA-256: {source['upstreamSha256']}. "
        "Sanitized local copy; editor metadata removed and attribution added by OHP Map; "
        "visible vector artwork and native proportions preserved. Flag/insignia restrictions may exist independently of copyright."
    )
    root.insert(0, desc)
    normalize_svg_whitespace(root)
    ET.register_namespace("", SVG)
    ET.register_namespace("xlink", XLINK)
    data = ET.tostring(root, encoding="unicode") + "\n"
    validate_svg(data)
    return data, root.attrib["viewBox"]


def validate_svg(data):
    if "<!DOCTYPE" in data.upper() or "<!ENTITY" in data.upper():
        raise ValueError("Unsafe XML declaration in local SVG")
    root = ET.fromstring(data)
    if root.tag != "{" + SVG + "}svg":
        raise ValueError("SVG root namespace is invalid")
    box = [float(part) for part in re.split(r"[\s,]+", root.attrib["viewBox"].strip())]
    if len(box) != 4 or not all(math.isfinite(value) for value in box) or box[2] <= 0 or box[3] <= 0:
        raise ValueError("Invalid native SVG viewBox")
    ids = [element.get("id") for element in root.iter() if element.get("id")]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate SVG IDs")
    if not any(element.tag.rsplit("}", 1)[-1] in {"path", "rect", "circle", "polygon"} for element in root.iter()):
        raise ValueError("No vector flag artwork")
    for element in root.iter():
        if not element.tag.startswith("{" + SVG + "}"):
            raise ValueError("Foreign SVG element namespace")
        name = element.tag.rsplit("}", 1)[-1]
        if name not in SAFE_ELEMENTS:
            raise ValueError(f"Disallowed SVG element {name}")
        if name == "style" and re.search(r"@|url\(|expression\(|javascript:", element.text or "", re.I):
            raise ValueError("Unsafe SVG stylesheet")
        for attribute, value in element.attrib.items():
            local = attribute.rsplit("}", 1)[-1]
            if local.lower().startswith("on") or re.search(r"javascript:|data:|expression\(", value, re.I):
                raise ValueError("Unsafe SVG attribute")
            if attribute == "{http://www.w3.org/XML/1998/namespace}base":
                raise ValueError("SVG xml:base could resolve local-looking references externally")
            if local == "href" and (not value.startswith("#") or value[1:] not in ids):
                raise ValueError("Non-local or missing SVG reference")
            for reference in re.findall(r"url\(\s*['\"]?([^)'\"\s]+)", value, re.I):
                if not reference.startswith("#") or reference[1:] not in ids:
                    raise ValueError("Non-local SVG paint or clipping reference")
    return box


def make_source(fetcher, source_id, page, history_url, note, existing=None):
    info = page["imageinfo"][0]
    rights_revision = None
    if source_id == "world-om-current":
        proof = fetcher.json(COMMONS, {
            "action": "query", "revids": 382511724, "prop": "revisions",
            "rvprop": "ids|timestamp|content", "rvslots": "main", "format": "json",
        })
        revision = next(iter(proof["query"]["pages"].values()))["revisions"][0]
        permission = revision["slots"]["main"]["*"]
        if "{{PD-OpenClipart}}" not in permission or "1995-present" not in permission:
            raise ValueError("Oman archived vector's public-domain release cannot be verified")
        rights_revision = "https://commons.wikimedia.org/w/index.php?title=File:Flag_of_Oman.svg&oldid=382511724"
        info = {
            "url": "https://upload.wikimedia.org/wikipedia/commons/archive/d/dd/20220607135013%21Flag_of_Oman.svg",
            "timestamp": "2019-09-10T13:57:21Z", "sha1": "514055cba3505222e5299ecbf28d8a693645ec17",
            "extmetadata": {
                "LicenseShortName": {"value": "Public domain"},
                "LicenseUrl": {"value": "https://commons.wikimedia.org/wiki/Template:PD-OpenClipart"},
                "Artist": {"value": "Open Clip Art original; FDRMRZUSA (2019 SVG revision); earlier contributors identified in the Commons file history."},
                "Credit": {"value": "Commons file-description revision 382511724: source Open Clip Art; permission PD-OpenClipart and PD-ineligible; dated 1995-present."},
                "Copyrighted": {"value": "False"},
                "Restrictions": {"value": "insignia"},
            },
        }
        note += (
            " Uses the archived 2019 rendering of the 1995-present design and its explicit PD-OpenClipart release. "
            "The live file's OGL-Oman metadata is not relied upon because that licence excludes official government emblems."
        )
    license_id, license_url, credit = license_fields(info)
    parts = urlsplit(info["url"])
    download = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    rights = {key: value["value"] for key, value in info.get("extmetadata", {}).items()
              if key in {"Artist", "Credit", "LicenseShortName", "LicenseUrl", "UsageTerms", "Copyrighted", "AttributionRequired", "Restrictions"}}
    rights_note = note + " Per-file Commons licence metadata is retained, not a blanket claim that all flags are public domain. Insignia and national-symbol restrictions are separate from copyright."
    if existing and all([
        existing.get("id") == source_id,
        existing.get("commonsSha1") == info.get("sha1"),
        existing.get("title") == page["title"].removeprefix("File:"),
        existing.get("rightsMetadata") == rights,
        existing.get("license") == license_id, existing.get("licenseUrl") == license_url,
        existing.get("credit") == credit,
        existing.get("sourceUrl") == (rights_revision or file_url(page["title"])),
        existing.get("sanitizerVersion") == SANITIZER_VERSION,
        re.fullmatch(r"assets/flags/world-[a-z0-9-]+\.svg", existing.get("src", "")),
    ]):
        local = ROOT.joinpath(*existing["src"].split("/"))
        if local.exists() and digest(local.read_bytes()) == existing.get("assetSha256"):
            validate_svg(local.read_text(encoding="utf-8"))
            return {**existing, "historyUrl": history_url, "note": rights_note, "checkedOn": CHECKED}
    raw = fetcher.get(download, binary=True)
    if info.get("sha1") and hashlib.sha1(raw).hexdigest() != info["sha1"]:
        raise ValueError("Downloaded artwork does not match its Commons metadata revision hash")
    source = {
        "id": source_id, "src": f"assets/flags/{source_id}.svg",
        "title": page["title"].removeprefix("File:"),
        "publisher": "Wikimedia Commons / credited original author",
        "url": file_url(page["title"]), "sourceUrl": rights_revision or file_url(page["title"]),
        "historyUrl": history_url, "license": license_id, "licenseUrl": license_url,
        "credit": credit, "checkedOn": CHECKED,
        "note": rights_note, "sanitizerVersion": SANITIZER_VERSION,
        "downloadUrl": download, "commonsPageId": page["pageid"],
        "commonsRevisionTimestamp": info.get("timestamp"), "commonsSha1": info.get("sha1"),
        "upstreamSha256": digest(raw),
        "rightsMetadata": rights,
    }
    text, viewbox = sanitize_svg(raw, source)
    source["assetSha256"] = digest(text.encode())
    source["nativeViewBox"] = viewbox
    destination = ROOT.joinpath(*source["src"].split("/"))
    destination.write_text(text, encoding="utf-8", newline="\n")
    return source


def preserved_registry():
    text = (ROOT / "js" / "historical-context.js").read_text(encoding="utf-8")
    constants = {}
    for name, value in re.findall(r"const ([A-Z_]+) = (\[[^\]]*]);", text):
        constants[name] = re.findall(r'"([^"]+)"', value)
    pattern = (
        r'record\("([^"]+)",\s*(\[[^\]]*]|[A-Z_]+),\s*"([^"]+)",\s*'
        r'"([^"]+)",\s*"([^"]+)",\s*(null|"[^"]+")'
    )
    records = []
    for record_id, aliases, source_id, label, start, end in re.findall(pattern, text):
        if aliases.startswith("["):
            names = []
            for spread, literal in re.findall(r'\.\.\.([A-Z_]+)|"([^"]+)"', aliases):
                names.extend(constants[spread] if spread else [literal])
        else:
            names = constants[aliases]
        records.append({"id": record_id, "names": names, "sourceId": source_id,
                        "label": label, "start": start, "end": json.loads(end)})
    ids = set(re.findall(r'(?:source|diagram)\("([^"]+)"', text))
    if len(records) < 28:
        raise ValueError("Unable to read all existing curated records without modifying their module")
    return records, ids


def catalogue_audit(countries, records, sources, quarantine, failures, snapshots, scope_excluded):
    base, historical, active = inventory()
    aliases = {normalize(name): row for row in countries for name in row["names"]}
    preserved, _ = preserved_registry()
    all_records = preserved + records
    dated = {normalize(name) for row in all_records if year_in(row, 2026) for name in row["names"]}
    has_current = lambda name: bool(aliases.get(normalize(name), {}).get("currentSourceId"))
    has_country = lambda name: normalize(name) in aliases
    missing_catalogue = sorted({name for name in base + active if not has_country(name)})
    if missing_catalogue:
        raise ValueError(f"Mapped names missing from country catalogue: {missing_catalogue}")
    represented = {normalize(name) for row in all_records for name in row["names"]}
    all_historical_missing = [name for name in historical if normalize(name) not in represented]
    samples = {}
    for year in [1914, 1939, 1944, 1960, 1990, 2026]:
        boundary = json.loads((ROOT / "data" / "historical_boundaries.json").read_text(encoding="utf-8"))
        names = sorted({geometry["properties"]["controller"]
                        for geometry in boundary["objects"]["territories"]["geometries"]
                        if geometry["properties"]["start"] <= year + 0.5 < (geometry["properties"]["end"] or 9999)})
        available = {normalize(name) for row in all_records if year_in(row, year) for name in row["names"]}
        samples[str(year)] = {
            "controllers": len(names), "datedFlagAvailable": sum(normalize(name) in available for name in names),
            "unresolved": [name for name in names if normalize(name) not in available],
        }
    from collections import Counter
    return {
        "policy": {
            "currentReferences": "A currentSourceId is a catalogue reference only, not a historical validity interval.",
            "dates": "Start-inclusive/end-exclusive, sampled at UTC calendar midpoint. YYYY withholds its entire transition year; YYYY-MM withholds that month. No inferred January 1.",
            "chronology": "Editorial flag-history sequences and otherwise usable date-qualified Wikidata statements are distinguished. An unreferenced P41 statement is a source lead, not exhaustive independent historical verification.",
            "conflicts": "Unresolved overlapping designs are quarantined in full; no guessed transitions or manufactured continuous timelines.",
            "geometry": "Native SVG viewBox and proportions retained; no 4:3 or square normalization.",
            "existingCuration": "All 28 existing dated records are read-only and preserved. Nazi-era Germany remains the existing neutral DE identifier, Germany's 1945–1948 gap remains empty, and Russia, Russian Empire, RSFSR and USSR are not interchangeable.",
            "rights": "Per-file licence and authorship metadata; no claim that every flag design or SVG is universally public domain. National-symbol restrictions are distinct from copyright.",
        },
        "counts": {
            "countries": len(countries), "currentReferences": sum(bool(row.get("currentSourceId")) for row in countries),
            "newSources": len(sources), "newDatedRecords": len(records), "preservedDatedRecords": len(preserved),
            "allDatedRecords": len(all_records), "basemapNames": len(base), "active2026Controllers": len(active),
            "allHistoricalControllers": len(historical),
            "basemapCurrentReferences": sum(has_current(name) for name in base),
            "active2026CurrentReferences": sum(has_current(name) for name in active),
            "active2026DatedFlags": sum(normalize(name) in dated for name in active),
            "historicalControllerAliasesWithRecords": sum(normalize(name) in represented for name in historical),
            "quarantined": len(quarantine), "outOfScopePre1914Statements": scope_excluded,
        },
        "unresolved": {
            "missingCountryEntries": missing_catalogue,
            "basemapWithoutCurrentReference": [name for name in base if not has_current(name)],
            "active2026WithoutCurrentReference": [name for name in active if not has_current(name)],
            "active2026WithoutDatedFlag": [name for name in active if normalize(name) not in dated],
            "countriesWithoutCurrentReference": [row["name"] for row in countries if not row.get("currentSourceId")],
            "historicalControllersWithoutAnyDatedRecord": all_historical_missing,
        },
        "yearSamples": samples,
        "licenseCounts": dict(sorted(Counter(row["license"] for row in sources).items())),
        "licenseNotes": [
            "The live Oman SVG is marked OGL-OM-1.0, whose terms exclude official government emblems. This catalogue instead uses an archived 2019 rendering of the 1995-present flag with an explicitly verified PD-OpenClipart release in Commons revision 382511724; it does not relicense the live OGL file.",
            "Share-alike SVG adaptations retain their actual CC-BY-SA licence and author credit in both the manifest and SVG desc.",
            "The flag-icons ISO/name list is factual metadata distributed under MIT: Copyright (c) 2013 Panayiotis Lipiridis. The MIT notice is retained in metadataLicense below.",
            "The hampusborgos repository was a native-proportion research lead only; its blanket public-domain declaration is not used to override any per-file Commons licence.",
        ],
        "metadataLicense": (
            "Copyright (c) 2013 Panayiotis Lipiridis\n\n"
            "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files "
            '(the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, '
            "publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, "
            "subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial "
            'portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO '
            "THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS "
            "BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION "
            "WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE."
        ),
        "upstream": snapshots,
        "assetFailures": failures,
        "acquisitionIncomplete": any("deferred" in row["reason"].lower() for row in failures),
        "acquisitionNotes": [
            "The initial September 2026 acquisition encountered persistent Wikimedia upload HTTP 429 responses, including Retry-After: 600, despite honoring the waits and reducing request frequency.",
            "Deferred artwork is listed individually below with its candidate chronology retained in quarantine. Cached, licensed artwork is published; no missing historical graphic is filled with a modern substitute.",
            "A subsequent --acquire can resume enrichment. Unchanged assets already verified in this manifest are reused without downloading them again; --replay restores the exact recorded SVG revisions.",
        ],
        "quarantineReasonCounts": dict(sorted(Counter(row["reason"] for row in quarantine).items())),
        "chronologyConflicts": [
            row for row in quarantine
            if row["reason"].startswith(("Overlapping usable designs", "Sources disagree on transition"))
        ],
        "editorialCorrections": [
            "India: 1946 in the raw statement is rejected; adoption was July 1947 and the new state's national use starts at independence in August 1947.",
            "Italy and Spain: conflicting decree, proclamation and publication days are not manufactured into exact transitions; documented transition years are withheld.",
            "South Africa: the 1928 flag ends at the 27 April 1994 transition, not the raw statement's 20 April.",
            "Egypt: the raw 1983 current-design start and 1999 UAR-design end are rejected in favour of the documented historical sequence.",
            "Syria: the 2025 constitutional 2:3 graphic is not backdated to the December 2024 caretaker/opposition use of an earlier design.",
            "Afghanistan: the 1930/1931 error and inclusive last-use days are reconciled against the flag-history gallery; conflicting October 1929 days are reduced to month precision.",
            "Ethiopia: the current larger-emblem graphic begins in May 2009; it is not treated as the unchanged 1996 drawing.",
            "Hungary: the present government flag's 1:2 specification is bounded by the 2000 decree; an overlapping 1989–2003 colour-variant claim is not selected blindly.",
            "Honduras: the sources describe a January 2026 return to the darker blue flag; differing January days are reduced to month precision rather than continuing the stale 2022 turquoise graphic.",
            "All existing curated Germany, Canada, France, UK, USA, Japan, Poland and Russia/USSR records are preserved, including the neutral Nazi-era identifier and occupation gaps.",
        ],
        "quarantine": quarantine,
    }


def acquire(fetcher):
    existing_sources = {}
    if OUTPUT.exists():
        previous = json.loads(OUTPUT.read_text(encoding="utf-8"))
        existing_sources = {row.get("commonsPageId"): row for row in previous["sources"]}
    country_index, iso, entities, statements, adoption = discover(fetcher)
    countries, choices, qid_to_code = make_countries(country_index, iso, entities)
    historical = json.loads((CACHE / "historical-index.json").read_text(encoding="utf-8"))
    records, quarantine, scope_excluded = choose_records(
        countries, choices, qid_to_code, entities, statements, adoption["parse"]["text"]["*"], historical)
    titles = ["File:" + choice["file"] for choice in choices.values() if choice.get("file")]
    titles += ["File:" + record["file"] for record in records if record.get("file")]
    metadata = commons_metadata(fetcher, titles)
    (CACHE / "all-metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    (CACHE / "proposed-records.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    source_by_page, source_by_title, sources, failures = {}, {}, [], []
    _, existing_source_ids = preserved_registry()

    def obtain(filename, source_id, history_url, note):
        title = "File:" + filename
        page = metadata.get(title)
        if not page or not page.get("imageinfo"):
            reason = "Deferred in offline checkpoint: source metadata not yet acquired" if page and page.get("unfetched") else "Commons source file unavailable"
            failures.append({"file": filename, "reason": reason})
            return None
        page_id = page["pageid"]
        if page_id in source_by_page:
            source_by_title[title] = source_by_page[page_id]
            return source_by_page[page_id]
        try:
            source = make_source(fetcher, source_id, page, history_url, note, existing_sources.get(page_id))
        except (ValueError, ET.ParseError, HTTPError, URLError, RuntimeError) as error:
            info = page["imageinfo"][0]
            failures.append({
                "file": filename, "sourceId": source_id, "reason": str(error),
                "sourceUrl": file_url(page["title"]), "downloadUrl": info["url"],
                "commonsPageId": page_id, "commonsSha1": info.get("sha1"),
                "commonsRevisionTimestamp": info.get("timestamp"),
            })
            source_by_page[page_id] = None
            print(f"Quarantined asset {filename}: {error}", flush=True)
            return None
        sources.append(source)
        source_by_page[page_id] = source["id"]
        source_by_title[title] = source["id"]
        return source["id"]

    for code, choice in choices.items():
        if choice.get("preserved"):
            continue
        source_id = obtain(
            choice["file"], choice["sourceId"],
            (choice.get("statement") or {}).get("sourceUrl") or file_url("File:" + choice["file"]),
            "Current catalogue reference, not authority to backdate the image.",
        )
        choice["sourceId"] = source_id
    for index, record in enumerate(records):
        filename = record["file"]
        if record.get("sourceId") in existing_source_ids:
            continue
        title = "File:" + filename
        slug = re.sub(r"[^a-z0-9]+", "-", filename.removesuffix(".svg").lower()).strip("-")[:65]
        source_id = source_by_title.get(title) or obtain(
            filename, "world-" + slug + "-" + digest(title.encode())[:8],
            record["sourceUrl"], "Dated historical/civil/government design; national-symbol restrictions may apply.",
        )
        if source_id:
            record["sourceId"] = source_id
        else:
            record["sourceId"] = None
            quarantine.append({"record": record, "reason": "Artwork missing, licence unresolved or SVG failed safe-vector validation"})
        if index and index % 50 == 0:
            print(f"Resolved {index}/{len(records)} dated records; {len(sources)} SVG sources", flush=True)
    records = [{key: value for key, value in record.items() if key not in {"file", "evidence"}}
               for record in records if record["sourceId"]]
    by_country_code = {row["id"].lower(): row for row in countries}
    for code, choice in choices.items():
        if choice.get("sourceId"):
            by_country_code[code]["currentSourceId"] = choice["sourceId"]
        else:
            country = by_country_code[code]
            country["note"] = (country.get("note", "") + " The current artwork was withheld because acquisition or safe-vector/licence validation failed; see audit.assetFailures.").strip()
    for code, parent in SHARED_NATIONAL.items():
        source_id = by_country_code[parent].get("currentSourceId")
        if source_id:
            by_country_code[code]["currentSourceId"] = source_id
    snapshots = {
        "isoNames": {
            "url": f"https://raw.githubusercontent.com/lipis/flag-icons/{FLAG_ICONS_REVISION}/country.json",
            "revision": FLAG_ICONS_REVISION, "sha256": digest(json.dumps(country_index, sort_keys=True).encode()),
            "hashEncoding": "Canonical JSON with sorted object keys, ASCII-escaped strings, UTF-8 bytes",
            "license": "MIT", "licenseUrl": f"https://github.com/lipis/flag-icons/blob/{FLAG_ICONS_REVISION}/LICENSE",
        },
        "wikidata": {
            "url": "https://www.wikidata.org/wiki/Property:P41", "license": "CC0-1.0",
            "licenseUrl": LICENSE_URLS["CC0-1.0"], "entities": len(entities),
            "statements": len(statements), "sha256": digest(json.dumps(statements, sort_keys=True).encode()),
            "hashEncoding": "Canonical JSON with sorted object keys, ASCII-escaped strings, UTF-8 bytes",
            "entityRevisions": {qid: entity.get("lastrevid") for qid, entity in sorted(entities.items())},
        },
        "adoptionTable": {
            "url": ADOPTION_URL, "oldid": adoption["parse"]["revid"],
            "sha256": digest(adoption["parse"]["text"]["*"].encode()),
            "note": "Latest design/specification dates, not first-use dates; reduced precision is preserved conservatively.",
        },
        "reviewedFlagArticles": json.loads((CACHE / "article-revisions.json").read_text(encoding="utf-8")),
    }
    data = {
        "format": 1, "checkedOn": CHECKED,
        "sources": sorted(sources, key=lambda row: row["id"]),
        "records": sorted(records, key=lambda row: (row["names"][0], row["start"], row["id"])),
        "countries": sorted(countries, key=lambda row: row["name"]),
    }
    data["audit"] = catalogue_audit(
        data["countries"], data["records"], data["sources"], quarantine, failures, snapshots, scope_excluded)
    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    wanted = {ROOT.joinpath(*row["src"].split("/")) for row in sources}
    for asset in (ROOT / "assets" / "flags").glob("world-*.svg"):
        if asset not in wanted:
            asset.unlink()
    validate()


def replay(fetcher):
    data = json.loads(OUTPUT.read_text(encoding="utf-8"))
    restored = 0
    for source in data["sources"]:
        target = ROOT.joinpath(*source["src"].split("/"))
        if target.exists() and digest(target.read_bytes()) == source["assetSha256"]:
            continue
        raw = fetcher.get(source["downloadUrl"], binary=True)
        if digest(raw) != source["upstreamSha256"]:
            response = fetcher.json(COMMONS, {
                "action": "query", "titles": "File:" + source["title"], "prop": "imageinfo",
                "iiprop": "url|timestamp|sha1", "iistart": source["commonsRevisionTimestamp"],
                "iilimit": 1, "format": "json",
            })
            info = next(iter(response["query"]["pages"].values())).get("imageinfo", [{}])[0]
            if info.get("timestamp") != source["commonsRevisionTimestamp"]:
                raise ValueError(f"Recorded source revision unavailable: {source['id']}")
            parts = urlsplit(info["url"])
            raw = fetcher.get(urlunsplit((parts.scheme, parts.netloc, parts.path, "", "")), binary=True)
        if digest(raw) != source["upstreamSha256"]:
            raise ValueError(f"Recorded source content hash cannot be reproduced: {source['id']}")
        text, viewbox = sanitize_svg(raw, source)
        if digest(text.encode()) != source["assetSha256"] or viewbox != source["nativeViewBox"]:
            raise ValueError(f"Sanitization is not reproducible for {source['id']}")
        target.write_text(text, encoding="utf-8", newline="\n")
        restored += 1
    print(json.dumps({"restoredAssets": restored, "chronologyUnchanged": True}), flush=True)
    validate()


def validate():
    data = json.loads(OUTPUT.read_text(encoding="utf-8"))
    if data["format"] != 1 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", data["checkedOn"]):
        raise ValueError("Invalid catalogue format/check date")
    preserved, existing_sources = preserved_registry()
    source_ids = existing_sources | {row["id"] for row in data["sources"]}
    for key in ("sources", "records", "countries"):
        ids = [row["id"] for row in data[key]]
        if len(ids) != len(set(ids)):
            raise ValueError(f"Duplicate {key} identifiers")
    for source in data["sources"]:
        for key in ("id", "src", "title", "publisher", "url", "sourceUrl", "historyUrl",
                    "license", "licenseUrl", "credit", "note", "checkedOn"):
            if not isinstance(source.get(key), str) or not source[key].strip():
                raise ValueError(f"Missing source field {source['id']}.{key}")
        if not re.fullmatch(r"assets/flags/world-[a-z0-9-]+\.svg", source["src"]):
            raise ValueError(f"Source asset outside the importer's ownership: {source['src']}")
        for key in ("url", "sourceUrl", "historyUrl", "licenseUrl"):
            parsed = urlsplit(source[key])
            if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
                raise ValueError(f"Invalid public source URL: {source[key]}")
        path = ROOT.joinpath(*source["src"].split("/"))
        raw = path.read_bytes()
        if digest(raw) != source["assetSha256"]:
            raise ValueError(f"SVG content hash differs from manifest: {path.name}")
        validate_svg(raw.decode())
        root = ET.fromstring(raw)
        if root.attrib["viewBox"] != source["nativeViewBox"]:
            raise ValueError(f"Native proportions changed: {path.name}")
        text = raw.decode()
        for credit in (source["credit"], source["licenseUrl"]):
            if credit not in unescape(text):
                raise ValueError(f"Asset lost attribution: {path.name}")
        if role_rejection(source["title"]):
            raise ValueError(f"Source has an excluded flag role: {source['title']}")
    expected = {source["src"] for source in data["sources"]}
    assets = {path.relative_to(ROOT).as_posix() for path in (ROOT / "assets" / "flags").glob("world-*.svg")}
    if assets != expected:
        raise ValueError("Unreferenced or missing world flag asset")
    intervals = defaultdict(list)
    for record in preserved + data["records"]:
        if record["sourceId"] not in source_ids:
            raise ValueError(f"Unknown source ID in {record['id']}: {record['sourceId']}")
        start, end = effective_range(record)
        if start >= end:
            raise ValueError(f"Empty effective interval in {record['id']}")
        for name in record["names"]:
            intervals[normalize(name)].append((start, end, record["id"]))
    for name, rows in intervals.items():
        rows.sort()
        for left, right in zip(rows, rows[1:]):
            if left[1] > right[0] and left[2] != right[2]:
                raise ValueError(f"Conflicting intervals for {name}: {left[2]}, {right[2]}")
    for record in data["records"]:
        for key in ("id", "sourceId", "label", "start", "note", "sourceUrl"):
            if not isinstance(record.get(key), str) or not record[key].strip():
                raise ValueError(f"Missing dated record field {record['id']}.{key}")
        if not record["names"] or any(not isinstance(name, str) or not name.strip() for name in record["names"]):
            raise ValueError(f"Invalid administration aliases in {record['id']}")
    for country in data["countries"]:
        if country["names"][0] != country["name"]:
            raise ValueError(f"Canonical country name is not the first alias: {country['id']}")
        if country.get("currentSourceId") and country["currentSourceId"] not in source_ids:
            raise ValueError(f"Unknown current source for {country['name']}")
        if country["id"] == "AQ" and country.get("currentSourceId"):
            raise ValueError("Antarctica must not have a national flag")
    for record in data["records"]:
        if {normalize(name) for name in record["names"]} & {"germany", "german reich", "soviet union", "ussr", "russia", "rsfsr"}:
            raise ValueError(f"Expanded record overrides protected curation: {record['id']}")
    current_by_id = {row["id"]: row for row in data["sources"]}
    for code, ratio in {"CH": 1, "VA": 1, "GB": 2, "TG": (1 + math.sqrt(5)) / 2}.items():
        country = next(row for row in data["countries"] if row["id"] == code)
        if not country.get("currentSourceId"):
            continue
        box = validate_svg(ROOT.joinpath(*current_by_id[country["currentSourceId"]]["src"].split("/")).read_text(encoding="utf-8"))
        if abs(box[2] / box[3] - ratio) > 1e-3:
            raise ValueError(f"{code} lost its native proportions")
    print(json.dumps({"validated": True, **data["audit"]["counts"],
                      "unresolvedCurrent": data["audit"]["unresolved"]["basemapWithoutCurrentReference"],
                      "assetFailures": len(data["audit"]["assetFailures"]),
                      "licenses": data["audit"]["licenseCounts"]}), flush=True)


def discover(fetcher):
    if fetcher.offline:
        load = lambda name: json.loads((CACHE / name).read_text(encoding="utf-8"))
        adoption = {"parse": {
            "text": {"*": (CACHE / "adoption.html").read_text(encoding="utf-8")},
            "revid": load("adoption-revision.json")["oldid"],
        }}
        return load("country-index.json"), load("iso-index.json"), load("entities.json"), load("statements.json"), adoption
    countries = fetcher.json(
        f"https://raw.githubusercontent.com/lipis/flag-icons/{FLAG_ICONS_REVISION}/country.json")
    query = """SELECT DISTINCT ?item ?iso ?label WHERE {
      ?item wdt:P297 ?iso; rdfs:label ?label.
      FILTER(LANG(?label) = "en")
    } ORDER BY ?iso ?item"""
    iso = fetcher.json("https://query.wikidata.org/sparql", {"format": "json", "query": query})
    (CACHE / "iso-index.json").write_text(json.dumps(iso, ensure_ascii=False, indent=2), encoding="utf-8")
    (CACHE / "country-index.json").write_text(json.dumps(countries, ensure_ascii=False, indent=2), encoding="utf-8")
    ids = {row["item"]["value"].rsplit("/", 1)[-1] for row in iso["results"]["bindings"]}
    historical_ids = {}
    for batch in batches(HISTORICAL_TITLES):
        pages = fetcher.json(WIKIPEDIA, {
            "action": "query", "titles": "|".join(batch),
            "prop": "pageprops", "ppprop": "wikibase_item", "redirects": 1, "format": "json",
        })["query"]
        redirects = {row["from"]: row["to"] for key in ("normalized", "redirects") for row in pages.get(key, [])}
        by_title = {row["title"]: row for row in pages["pages"].values()}
        for title in batch:
            target, seen = title, set()
            while target in redirects and target not in seen:
                seen.add(target)
                target = redirects[target]
            qid = by_title.get(target, {}).get("pageprops", {}).get("wikibase_item")
            if qid:
                historical_ids[qid] = HISTORICAL_TITLES[title]
    (CACHE / "historical-index.json").write_text(json.dumps(historical_ids, ensure_ascii=False, indent=2), encoding="utf-8")
    ids.update(historical_ids)
    entities = wikidata_entities(fetcher, ids)
    (CACHE / "entities.json").write_text(json.dumps(entities, ensure_ascii=False, indent=2), encoding="utf-8")
    statements = [claim_summary(qid, entity, claim) for qid, entity in entities.items()
                  for claim in entity.get("claims", {}).get("P41", [])]
    (CACHE / "statements.json").write_text(json.dumps(statements, ensure_ascii=False, indent=2), encoding="utf-8")
    adoption = fetcher.json(WIKIPEDIA, {
        "action": "parse", "page": ADOPTION_PAGE, "prop": "text|revid", "format": "json", "redirects": 1,
    })
    (CACHE / "adoption.html").write_text(adoption["parse"]["text"]["*"], encoding="utf-8")
    (CACHE / "adoption-revision.json").write_text(json.dumps({"oldid": adoption["parse"]["revid"]}), encoding="utf-8")
    articles = fetch_articles(fetcher)
    (CACHE / "article-revisions.json").write_text(json.dumps(articles, indent=2), encoding="utf-8")
    plans = make_countries(countries, iso, entities)
    (CACHE / "current-plan.json").write_text(json.dumps(plans[1], ensure_ascii=False, indent=2), encoding="utf-8")
    metadata = commons_metadata(fetcher, ["File:" + choice["file"] for choice in plans[1].values() if choice.get("file")])
    (CACHE / "current-metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"isoCountries": sum(row.get("iso", False) for row in countries),
                      "entities": len(entities), "flagStatements": len(statements),
                      "currentFilesMissing": [title for title, page in metadata.items() if not page.get("imageinfo")],
                      "ambiguousCurrent": [code for code, choice in plans[1].items() if choice.get("ambiguous")]}))
    return countries, iso, entities, statements, adoption


HISTORICAL_TITLES = {
    "Ottoman Empire": ["Ottoman Empire"],
    "Soviet Union": ["Soviet Union"],
    "East Germany": ["East Germany"],
    "Russian Empire": ["Russian Empire"],
    "Russian Republic": ["Russian Republic"],
    "Austria-Hungary": ["Austria-Hungary"],
    "Czechoslovakia": ["Czechoslovakia", "Czech and Slovak Federative Republic"],
    "Kingdom of Yugoslavia": ["Kingdom of Yugoslavia", "Kingdom of Serbs, Croats and Slovenes"],
    "Socialist Federal Republic of Yugoslavia": ["Socialist Federal Republic of Yugoslavia", "FPR Yugoslavia",
                                               "Federal People's Republic of Yugoslavia"],
    "Democratic Federal Yugoslavia": ["Democratic Federal Yugoslavia"],
    "Serbia and Montenegro": ["Serbia and Montenegro"],
    "British Raj": ["British Raj"],
    "United Arab Republic": ["United Arab Republic"],
    "Mandatory Iraq": ["Mandatory Iraq"],
    "Kingdom of Iraq": ["Hashemite Kingdom of Iraq"],
    "Kingdom of Egypt": ["Kingdom of Egypt"],
    "South Vietnam": ["South Vietnam"],
    "North Vietnam": ["North Vietnam"],
    "French Indochina": ["French Indochina"],
    "Kosovo": ["Kosovo"],
    "Northern Cyprus": ["Northern Cyprus", "N. Cyprus"],
    "Somaliland": ["Somaliland"],
    "Republic of China (1912–1949)": ["Republic of China (1912–1949)"],
    "Empire of China (1915–1916)": ["Empire of China"],
    "Qing dynasty": ["Qing dynasty"],
    "Republic of Afghanistan (1973–1978)": ["Republic of Afghanistan"],
    "Democratic Republic of Afghanistan": ["Democratic Republic of Afghanistan"],
    "Islamic State of Afghanistan": ["Islamic State of Afghanistan"],
    "Islamic Emirate of Afghanistan (1996–2001)": ["Islamic Emirate of Afghanistan (1996–2001)"],
    "Islamic Republic of Afghanistan": ["Islamic Republic of Afghanistan"],
    "Transitional Islamic State of Afghanistan": ["Transitional Islamic State of Afghanistan"],
    "Principality of Albania": ["Principality of Albania"],
    "Albanian Republic": ["Albanian Republic"],
    "Albanian Kingdom (1928–1939)": ["Albanian Kingdom"],
    "People's Socialist Republic of Albania": ["People's Socialist Republic of Albania", "People's Republic of Albania"],
    "Ethiopian Empire": ["Ethiopian Empire"],
    "People's Democratic Republic of Ethiopia": ["Ethiopia (1962-1991)"],
    "Derg": ["Derg"],
    "North Yemen": ["North Yemen"],
    "South Yemen": ["South Yemen"],
    "Yemen Arab Republic": ["Yemen Arab Republic"],
    "Mutawakkilite Kingdom of Yemen": ["Mutawakkilite Kingdom of Yemen"],
    "Aden Colony": ["Aden Colony"],
    "Aden Protectorate": ["Aden Protectorate"],
    "Federation of South Arabia": ["Federation of South Arabia", "Federation of Arab Emirates of the South"],
    "Colony of Southern Rhodesia": ["Southern Rhodesia"],
    "Rhodesia": ["Rhodesia"],
    "Federation of Rhodesia and Nyasaland": ["Federation of Rhodesia and Nyasaland"],
    "Northern Rhodesia": ["Northern Rhodesia"],
    "Nyasaland": ["Nyasaland"],
    "Belgian Congo": ["Belgian Congo"],
    "Congo Free State": ["Congo Free State"],
    "Zaire": ["Zaire"],
    "British Hong Kong": ["British Hong Kong"],
    "North Borneo": ["North Borneo", "Colony of North Borneo"],
    "Federated Malay States": ["Federated Malay States"],
    "Malayan Union": ["Malayan Union"],
    "Federation of Malaya": ["Federation of Malaya"],
    "Straits Settlements": ["Colony of the Straits Settlement"],
    "British Ceylon": ["British Ceylon"],
    "Dominion of Ceylon": ["Dominion of Ceylon"],
    "Dominion of India": ["Dominion of India"],
    "Commonwealth of the Philippines": ["Commonwealth of the Philippines"],
    "Second Philippine Republic": ["Second Philippine Republic"],
    "British Burma": ["British Burma"],
    "Dutch East Indies": ["Dutch East Indies"],
    "United States of Indonesia": ["United States of Indonesia"],
    "Italian Libya": ["Italian Libya"],
    "Kingdom of Libya": ["Kingdom of Libya"],
    "Libyan Arab Republic": ["Libyan Arab Republic"],
    "Jamahiriya": ["Jamahiriya"],
    "Saar Protectorate": ["Saar Protectorate"],
    "Free City of Danzig": ["Free City of Danzig"],
    "Free Territory of Trieste": ["Free Territory of Trieste"],
    "Kingdom of Serbia": ["Kingdom of Serbia"],
    "Kingdom of Montenegro": ["Kingdom of Montenegro"],
    "State of Slovenes, Croats and Serbs": ["State of Slovenes, Croats and Serbs"],
    "Irish Free State": ["Irish Free State"],
    "Kingdom of Iceland": ["Kingdom of Iceland"],
    "Kingdom of Hungary (1920–1946)": ["Kingdom of Hungary"],
    "Hungarian People's Republic": ["Hungarian People's Republic"],
    "Socialist Republic of Romania": ["Socialist Republic of Romania", "Romanian People's Republic"],
    "People's Republic of Bulgaria": ["People's Republic of Bulgaria"],
    "Mali Federation": ["Mali Federation"],
    "Republic of Dahomey": ["Republic of Dahomey", "Dahomey"],
    "Republic of Upper Volta": ["Upper Volta"],
    "Tanganyika": ["Tanganyika"],
    "Sultanate of Zanzibar": ["Sultanate of Zanzibar"],
    "People's Republic of Zanzibar": ["People's Republic of Zanzibar"],
    "Zanzibar Protectorate": ["Zanzibar Protectorate"],
    "State of Somaliland": ["State of Somaliland"],
    "Somali Democratic Republic": ["Somali Democratic Republic"],
    "Somali Republic": ["Somali Republic"],
    "Biafra": ["Biafra"],
    "Empire of Vietnam": ["Empire of Vietnam"],
    "State of Vietnam": ["State of Vietnam"],
    "Republic of South Vietnam": ["Provisional Revolutionary Government of the Republic of South Vietnam"],
    "French protectorate in Morocco": ["French protectorate in Morocco"],
    "French protectorate of Tunisia": ["French protectorate of Tunisia"],
    "French Madagascar": ["Colony of Madagascar"],
    "French Upper Volta": ["Upper Volta Protectorate"],
    "French Niger": ["Colony of Niger"],
    "French Dahomey": ["French Dahomey"],
    "French Algeria": ["French Algeria"],
    "French Cameroon": ["French Cameroon"],
    "French Togoland": ["French Togoland"],
    "French Equatorial Africa": ["French Equatorial Africa"],
    "French West Africa": ["French West Africa"],
    "French mandate for Syria and the Lebanon": ["Levant States"],
    "Mandatory Syria": ["Syrian Republic", "State of Syria"],
    "Alawite State": ["Alawite State"],
    "Jabal Druze State": ["Jabal al-Druze", "Souaida"],
    "State of Aleppo": ["State of Aleppo"],
    "State of Damascus": ["State of Damascus"],
    "State of Greater Lebanon": ["State of Greater Lebanon"],
    "Syrian Federation": ["Syrian Federation"],
    "Hatay State": ["Hatay State"],
    "Emirate of Transjordan": ["Emirate of Transjordan", "Transjordan"],
    "Mandatory Palestine": ["Palestine Mandate"],
    "New Hebrides": ["New Hebrides / Nouvelles-Hébrides"],
    "Gilbert and Ellice Islands": ["Gilbert and Ellice Islands Colony"],
    "Gilbert Islands": ["Gilbert Islands Colony"],
    "British Solomon Islands": ["British Solomon Islands"],
    "Colony of Fiji": ["Colony of Fiji"],
    "Colony of Jamaica": ["Colony of Jamaica"],
    "Colony of the Bahamas": ["Colony of the Bahamas"],
    "Colony of Barbados": ["Colony of Barbados"],
    "Colony of Trinidad and Tobago": ["Trinidad and Tobago Colony"],
    "Basutoland": ["Colony of Basutoland"],
    "Bechuanaland Protectorate": ["Bechuanaland Protectorate"],
    "Uganda Protectorate": ["Protectorate of Uganda"],
    "Kenya Colony": ["Protectorate of Kenya"],
    "Gambia Colony and Protectorate": ["Gambia Colony and Protectorate"],
    "Sierra Leone Colony and Protectorate": ["Sierra Leone Protectorate"],
    "Gold Coast (British colony)": ["Gold Coast"],
    "Southern Nigeria Protectorate": ["Colony and Protectorate of Southern Nigeria"],
    "Northern Nigeria Protectorate": ["Northern Nigeria Protectorate"],
    "Colony and Protectorate of Nigeria": ["Federation of Nigeria"],
    "Portuguese Angola": ["Portuguese Angola"],
    "Portuguese Mozambique": ["State of Mozambique"],
    "Portuguese Guinea": ["Portuguese Guinea"],
    "Portuguese Timor": ["Portuguese Timor"],
    "Danish West Indies": ["Danish West Indies"],
    "Tibetan Empire": ["Tibetan Empire"],
    "Tibet (1912–1951)": ["Tibet"],
    "Tuvan People's Republic": ["Tuvan People's Republic"],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--discover", action="store_true", help="Cache source chronology for editorial review")
    parser.add_argument("--acquire", action="store_true", help="Acquire and regenerate the catalogue")
    parser.add_argument("--validate", action="store_true", help="Validate the persisted catalogue offline")
    parser.add_argument("--replay", action="store_true", help="Restore exact recorded SVG revisions without changing chronology")
    parser.add_argument("--refresh", action="store_true", help="Explicitly refresh public source snapshots")
    parser.add_argument("--offline", action="store_true", help="Use only already acquired public source snapshots")
    parser.add_argument("--clean-cache", action="store_true", help="Remove only this importer's project-local cache")
    args = parser.parse_args()
    if args.discover:
        discover(Fetcher(args.refresh, args.offline))
    elif args.acquire:
        acquire(Fetcher(args.refresh, args.offline))
    elif args.validate:
        validate()
    elif args.replay:
        replay(Fetcher(args.refresh, args.offline))
    else:
        parser.print_help()
    if args.clean_cache and CACHE.exists():
        shutil.rmtree(CACHE)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, HTTPError, URLError) as error:
        print(f"Flag acquisition failed: {error}", file=sys.stderr)
        sys.exit(1)
