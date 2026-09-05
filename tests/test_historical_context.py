"""Offline contract, chronology, rights and SVG checks for historical context."""

import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
import xml.etree.ElementTree as ET

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "js" / "historical-context.js"
SVG_NS = "http://www.w3.org/2000/svg"
XLINK = "{http://www.w3.org/1999/xlink}href"
FLAG_FIELDS = {"src", "label", "start", "end", "sourceUrl", "license", "credit", "note"}
RESOURCE_FIELDS = {"title", "url", "publisher", "kind", "publishedYear", "from", "to", "note"}


@pytest.fixture(scope="module")
def registry():
    node = shutil.which("node")
    assert node, "Node.js is required to validate the browser-independent ES module"
    script = r"""
import { readFileSync } from "node:fs";
const text = readFileSync(process.argv[1], "utf8");
const m = await import("data:text/javascript;base64," + Buffer.from(text).toString("base64"));
const years = [...Array.from({ length: 113 }, (_, i) => 1914 + i), 1800, 1801,
  1870, 1871, 1872, 1891, 1892, 1893, 1911, 1912, 1913];
const names = [...new Set(m.FLAG_RECORDS.flatMap((entry) => entry.names))];
const samples = Object.fromEntries(names.map((name) => [name,
  Object.fromEntries(years.map((year) => [year, m.flagFor(name, year)]))]));
const invalidYears = [null, undefined, true, false, "", " ", "1960.5", "bad",
  NaN, Infinity, -Infinity, {}, [], 1914.5, 999, 9999];
const unknowns = ["Atlantis", "United States Army Military Government in Korea",
  "German East Africa", "Soviet Civil Administration", "Regency Kingdom of Poland",
  "United States of Venezuela", "France and United Kingdom"];
const originalFlag = m.flagFor("USA", 1960);
originalFlag.label = "mutated";
const originalResources = m.resourcesForYear(1944);
originalResources[0].title = "mutated";
originalResources.push({ title: "injected" });
console.log(JSON.stringify({
  records: m.FLAG_RECORDS,
  sources: m.FLAG_SOURCES,
  metadata: m.HISTORICAL_CONTEXT_META,
  samples,
  resources: Object.fromEntries(years.map((year) => [year, m.resourcesForYear(year)])),
  invalidFlags: invalidYears.map((year) => m.flagFor("USA", year)),
  invalidResources: invalidYears.map((year) => m.resourcesForYear(year)),
  unknownFlags: unknowns.map((name) => m.flagFor(name, 1944)),
  invalidNames: [null, undefined, 42, {}, []].map((name) => m.flagFor(name, 1944)),
  normalized: [m.flagFor("  uNiTeD   StAtEs  ", "1960"), m.flagFor(" u.s.a. ", 1960)],
  freshFlag: m.flagFor("USA", 1960),
  freshResources: m.resourcesForYear(1944),
  frozen: Object.isFrozen(m.FLAG_RECORDS) && Object.isFrozen(m.FLAG_SOURCES)
    && m.FLAG_RECORDS.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.names))
    && m.FLAG_SOURCES.every(Object.isFrozen),
  domGlobals: ["window", "document", "navigator"].filter((name) =>
    new RegExp("\\b" + name + "\\s*\\.").test(text)),
}));
"""
    result = subprocess.run(
        [node, "--input-type=module", "-e", script, str(MODULE)],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    return json.loads(result.stdout)


def flag(registry, controller, year):
    return registry["samples"][controller][str(year)]


def filename(entry):
    return Path(entry["src"]).name if entry is not None else None


@pytest.mark.parametrize(("controller", "year", "expected"), [
    ("USA", 1912, None),
    ("USA", 1913, "united-states-48-stars.svg"),
    ("USA", 1914, "united-states-48-stars.svg"),
    ("USA", 1959, "united-states-48-stars.svg"),
    ("USA", 1960, "united-states-49-stars.svg"),
    ("USA", 1961, "united-states-50-stars.svg"),
    ("USA", 2026, "united-states-50-stars.svg"),
    ("Canada", 1892, None),
    ("Canada", 1893, "canada-red-ensign-1868.svg"),
    ("Canada", 1914, "canada-red-ensign-1868.svg"),
    ("Canada", 1921, "canada-red-ensign-1868.svg"),
    ("Canada", 1922, None),
    ("Canada", 1923, "canada-red-ensign-1922.svg"),
    ("Canada", 1956, "canada-red-ensign-1922.svg"),
    ("Canada", 1957, None),
    ("Canada", 1958, "canada-red-ensign-1957.svg"),
    ("Canada", 1964, "canada-red-ensign-1957.svg"),
    ("Canada", 1965, "canada-1965.svg"),
    ("United Kingdom", 1800, None),
    ("United Kingdom", 1801, "united-kingdom-1801.svg"),
    ("United Kingdom", 1914, "united-kingdom-1801.svg"),
    ("France", 1942, "france-tricolour.svg"),
    ("Vichy France", 1942, "france-tricolour.svg"),
    ("Vichy France", 1939, None),
    ("Vichy France", 1945, None),
    ("Germany", 1914, "germany-imperial.svg"),
    ("Germany", 1919, "germany-imperial.svg"),
    ("Germany", 1920, "germany-weimar.svg"),
    ("Germany", 1932, "germany-weimar.svg"),
    ("Germany", 1933, "germany-imperial.svg"),
    ("Germany", 1935, "germany-imperial.svg"),
    ("Germany", 1936, "germany-1935.svg"),
    ("Germany", 1944, "germany-1935.svg"),
    ("Germany", 1945, None),
    ("Germany", 1946, None),
    ("Germany", 1947, None),
    ("Germany", 1948, None),
    ("Germany", 1949, "germany-federal.svg"),
    ("West Germany", 1948, None),
    ("West Germany", 1949, "germany-federal.svg"),
    ("West Germany", 1990, "germany-federal.svg"),
    ("West Germany", 1991, None),
    ("East Germany", 1949, None),
    ("East Germany", 1950, "germany-federal.svg"),
    ("East Germany", 1959, "germany-federal.svg"),
    ("East Germany", 1960, "germany-east-1959.svg"),
    ("East Germany", 1990, "germany-east-1959.svg"),
    ("East Germany", 1991, None),
    ("Russia", 1990, None),
    ("Russia", 1991, None),
    ("Russia", 1992, "russia-1991.svg"),
    ("Russia", 1993, "russia-1991.svg"),
    ("Russia", 1994, "russia-1993.svg"),
    ("Soviet Union", 1922, None),
    ("Soviet Union", 1923, None),
    ("Soviet Union", 1924, None),
    ("Soviet Union", 1925, "soviet-union-1924.svg"),
    ("Soviet Union", 1935, "soviet-union-1924.svg"),
    ("Soviet Union", 1936, None),
    ("Soviet Union", 1937, "soviet-union-1936.svg"),
    ("Soviet Union", 1944, "soviet-union-1936.svg"),
    ("Soviet Union", 1955, "soviet-union-1936.svg"),
    ("Soviet Union", 1956, "soviet-union-1955.svg"),
    ("Soviet Union", 1991, "soviet-union-1955.svg"),
    ("Soviet Union", 1992, None),
    ("Japan", 1914, "japan-1870.svg"),
    ("Japan", 1944, "japan-1870.svg"),
    ("Japan", 1999, "japan-1870.svg"),
    ("Japan", 2000, "japan-1999.svg"),
    ("Poland", 1914, None),
    ("Poland", 1919, None),
    ("Poland", 1920, "poland-1919.svg"),
    ("Poland", 1927, "poland-1919.svg"),
    ("Poland", 1928, "poland-1928.svg"),
    ("Poland", 1939, "poland-1928.svg"),
    ("Poland", 1940, "poland-1928.svg"),
    ("Poland", 1944, "poland-1928.svg"),
    ("Poland", 1945, "poland-1928.svg"),
    ("Poland", 1979, "poland-1928.svg"),
    ("Poland", 1980, "poland-1980.svg"),
])
def test_dated_design_at_the_atlas_midyear(registry, controller, year, expected):
    assert filename(flag(registry, controller, year)) == expected


def test_precise_transition_dates_and_honest_reduced_precision(registry):
    records = {entry["id"]: entry for entry in registry["records"]}
    assert records["united-states-48"]["start"] == "1912-07-04"
    assert records["united-states-49"]["start"] == "1959-07-04"
    assert records["united-states-50"]["start"] == "1960-07-04"
    assert records["germany-weimar"]["start"] == "1919-08-11"
    assert records["germany-1933"]["start"] == "1933-03-12"
    assert records["germany-1935"]["start"] == "1935-09-15"
    assert records["east-germany-emblem"]["start"] == "1959-10-01"
    assert records["russia-1993"]["start"] == "1993-12-11"
    assert records["canada-maple-leaf"]["start"] == "1965-02-15"
    assert records["canada-green-leaves"]["start"] == "1922"
    assert records["canada-red-leaves"]["start"] == "1957"
    assert registry["metadata"]["sampleYearOffset"] == 0.5
    assert "withheld" in registry["metadata"]["datePrecision"]


def test_pure_module_safe_inputs_and_no_mutable_registry_leak(registry):
    assert registry["domGlobals"] == []
    assert registry["frozen"]
    assert not any(registry["invalidFlags"])
    assert not any(registry["invalidResources"])
    assert not any(registry["invalidNames"])
    assert not any(registry["unknownFlags"])
    assert all(filename(entry) == "united-states-49-stars.svg" for entry in registry["normalized"])
    assert registry["freshFlag"]["label"] != "mutated"
    assert all(entry["title"] not in {"mutated", "injected"} for entry in registry["freshResources"])


def test_lookup_preserves_controller_distinctions_and_flag_roles(registry):
    assert flag(registry, "Russia", 1944) is None
    assert flag(registry, "Soviet Union", 1944) is not None
    assert "co-national" in flag(registry, "Germany", 1933)["label"]
    assert "not the sole" in flag(registry, "Germany", 1935)["note"]
    assert "civil" in flag(registry, "Canada", 1914)["label"]
    assert "national maple-leaf" in flag(registry, "Canada", 1965)["label"]
    assert "not Pétain" in flag(registry, "France", 1942)["note"]
    assert "naval" in flag(registry, "Japan", 1944)["note"]
    assert "occupation" in flag(registry, "Poland", 1944)["note"]
    assert flag(registry, "USSR", 1944) == flag(registry, "Soviet Union", 1944)
    assert flag(registry, "DDR", 1960) == flag(registry, "East Germany", 1960)


def _date_limit(value, is_start):
    if value is None:
        return float("-inf") if is_start else float("inf")
    if re.fullmatch(r"\d{4}", value):
        return datetime(int(value) + int(is_start), 1, 1, tzinfo=timezone.utc).timestamp()
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)
    return datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp()


def test_every_alias_has_nonoverlapping_verified_intervals(registry):
    intervals = {}
    for entry in registry["records"]:
        start = _date_limit(entry["start"], True)
        end = _date_limit(entry["end"], False)
        assert start < end
        for name in entry["names"]:
            intervals.setdefault(name.casefold(), []).append((start, end, entry["id"]))
    for name, rows in intervals.items():
        rows.sort()
        for left, right in zip(rows, rows[1:]):
            assert left[1] <= right[0], (name, left, right)


def test_each_flag_has_an_asset_and_an_explicit_per_file_rights_record(registry):
    sources = {entry["id"]: entry for entry in registry["sources"]}
    assert len(sources) == len(registry["sources"])
    referenced = set()
    for entry in registry["records"]:
        assert FLAG_FIELDS <= entry.keys()
        assert re.fullmatch(r"assets/flags/[a-z0-9-]+\.svg", entry["src"])
        assert (ROOT / entry["src"]).is_file()
        assert re.search(r"national|civil|government", entry["label"], re.I)
        rights = sources[entry["sourceId"]]
        assert entry["src"] == rights["src"]
        assert entry["credit"] == rights["credit"]
        assert entry["license"] == rights["license"]
        assert urlparse(entry["sourceUrl"]).scheme in {"https", "http"}
        assert rights["license"] in {"Public domain", "CC0-1.0", "CC-BY-SA-3.0", "CC-BY-SA-4.0"}
        for key in ("title", "sourceUrl", "historyUrl", "licenseUrl", "credit", "note", "checkedOn"):
            assert rights[key], (entry["id"], key)
        referenced.add(entry["src"])
    files = {path.relative_to(ROOT).as_posix() for path in (ROOT / "assets" / "flags").glob("*.svg")}
    assert referenced == files
    assert {entry["src"] for entry in sources.values()} == files


def test_share_alike_assets_keep_their_actual_licenses_and_attribution(registry):
    sources = {entry["id"]: entry for entry in registry["sources"]}
    assert sources["su-1924"]["license"] == "CC-BY-SA-4.0"
    assert sources["su-1924"]["licenseUrl"] == "https://creativecommons.org/licenses/by-sa/4.0/"
    assert "Supreme Dragon" in sources["su-1924"]["credit"]
    assert sources["su-1955"]["license"] == "CC-BY-SA-3.0"
    assert sources["su-1955"]["licenseUrl"] == "https://creativecommons.org/licenses/by-sa/3.0/"
    assert "Cmapm" in sources["su-1955"]["credit"]
    for source_id, author in (("su-1924", "Supreme Dragon"), ("su-1955", "Cmapm")):
        entry = sources[source_id]
        asset = (ROOT / entry["src"]).read_text(encoding="utf-8")
        assert author in asset
        assert entry["licenseUrl"] in asset
        assert "attribution added by OHP Map" in asset


def _svg(name):
    return ET.parse(ROOT / "assets" / "flags" / name).getroot()


def test_local_svgs_contain_only_safe_self_contained_vector_elements():
    allowed = {
        "svg", "g", "path", "rect", "circle", "ellipse", "polygon", "polyline", "line",
        "defs", "use", "clipPath", "mask", "title", "desc", "style",
        "linearGradient", "radialGradient", "stop",
    }
    for path in (ROOT / "assets" / "flags").glob("*.svg"):
        raw = path.read_text(encoding="utf-8")
        assert "<!DOCTYPE" not in raw.upper()
        assert "<!ENTITY" not in raw.upper()
        root = ET.fromstring(raw)
        assert root.tag == f"{{{SVG_NS}}}svg"
        box = [float(value) for value in re.split(r"[\s,]+", root.attrib["viewBox"])]
        assert len(box) == 4 and box[2] > 0 and box[3] > 0
        ids = [element.attrib["id"] for element in root.iter() if "id" in element.attrib]
        assert len(ids) == len(set(ids)), path.name
        assert any(
            element.tag.rsplit("}", 1)[-1] in {"path", "rect", "polygon", "circle"}
            for element in root.iter()
        ), path.name
        for element in root.iter():
            assert element.tag.startswith(f"{{{SVG_NS}}}")
            name = element.tag.rsplit("}", 1)[-1]
            assert name in allowed, (path.name, name)
            if name == "style":
                assert not re.search(r"@|url\(|expression\(|javascript:", element.text or "", re.I)
            for attribute, value in element.attrib.items():
                local = attribute.rsplit("}", 1)[-1]
                assert not local.lower().startswith("on"), (path.name, attribute)
                assert not re.search(r"javascript:|data:|expression\(", value, re.I)
                if local == "href":
                    assert value.startswith("#") and value[1:] in ids
                for reference in re.findall(r"url\(\s*['\"]?([^)'\"\s]+)", value, re.I):
                    assert reference.startswith("#") and reference[1:] in ids


@pytest.mark.parametrize(("name", "star_id", "expected"), [
    ("united-states-48-stars.svg", "a", 48),
    ("united-states-49-stars.svg", "a", 49),
    ("united-states-50-stars.svg", "s", 50),
])
def test_us_svgs_paint_the_exact_star_count_and_thirteen_stripes(name, star_id, expected):
    root = _svg(name)
    by_id = {element.get("id"): element for element in root.iter() if element.get("id")}

    def instances(element, stack=()):
        local = element.tag.rsplit("}", 1)[-1]
        if local == "defs":
            return 0
        if local == "use":
            target = (element.get("href") or element.get(XLINK))[1:]
            assert target not in stack
            return instances(by_id[target], (*stack, target))
        if element.get("id") == star_id:
            assert local in {"path", "polygon"}
            return 1
        return sum(instances(child, stack) for child in element)

    assert instances(root) == expected
    white_bands = [
        element for element in root.iter()
        if element.get("stroke", "").casefold() in {"#fff", "#ffffff", "white"}
    ]
    assert sum(len(re.findall("[Mm]", element.get("d", ""))) for element in white_bands) == 6
    width, height = map(float, root.attrib["viewBox"].split()[-2:])
    assert width / height == pytest.approx(1.9)


def test_russian_and_japanese_date_variants_differ_in_geometry_not_just_labels():
    old_russia = _svg("russia-1991.svg")
    new_russia = _svg("russia-1993.svg")
    old_box = list(map(float, old_russia.get("viewBox").split()))
    new_box = list(map(float, new_russia.get("viewBox").split()))
    assert old_box[2] / old_box[3] == 2
    assert new_box[2] / new_box[3] == 1.5
    old_colours = {element.get("fill") for element in old_russia.iter()}
    new_colours = {element.get("fill") for element in new_russia.iter()}
    assert old_colours != new_colours
    old_japan = _svg("japan-1870.svg")
    new_japan = _svg("japan-1999.svg")
    old_disc = old_japan.find(f"{{{SVG_NS}}}circle")
    new_disc = new_japan.find(f"{{{SVG_NS}}}circle")
    assert float(old_disc.get("cx")) == 490
    assert float(new_disc.get("cx")) == 450
    assert len(old_japan.findall(f"{{{SVG_NS}}}circle")) == 1
    assert len(new_japan.findall(f"{{{SVG_NS}}}circle")) == 1


def test_resources_are_small_dated_external_context_lists_not_embeds(registry):
    unique = {}
    for year in range(1914, 2027):
        resources = registry["resources"][str(year)]
        assert 1 <= len(resources) <= 3
        assert len({entry["url"] for entry in resources}) == len(resources)
        for entry in resources:
            assert set(entry) == RESOURCE_FIELDS
            assert entry["kind"] in {"map", "video", "collection"}
            assert entry["from"] <= year <= entry["to"]
            assert entry["publishedYear"] is None or isinstance(entry["publishedYear"], int)
            assert entry["title"] and entry["publisher"] and entry["note"]
            parsed = urlparse(entry["url"])
            assert parsed.scheme == "https"
            assert parsed.hostname in {
                "commons.wikimedia.org", "www.iwm.org.uk", "www.nfb.ca", "history.state.gov",
            }
            assert not re.search(r"youtube|youtu\.be|/embed/|\.mp4(?:$|\?)", entry["url"], re.I)
            unique[entry["url"]] = entry
    videos = [entry for entry in unique.values() if entry["kind"] == "video"]
    assert len(videos) == 3
    assert {entry["publishedYear"] for entry in videos} == {None, 1941, 1951}
    maps = [entry for entry in unique.values() if entry["kind"] == "map"]
    assert {entry["publishedYear"] for entry in maps} == {1914, 1944}
    assert all("PD-" in entry["note"] for entry in maps)
