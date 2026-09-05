"""Audit committed historical geometry locally; never repair or fetch it.

Run after build.mjs. The report identifies coincident duplicate geometry and
overlapping dated alternatives without choosing an invented historical border.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
from itertools import combinations
import json
import math
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]


def antimeridian_crossing(geometry):
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return any(
        abs(a[0] - b[0]) > 180
        for polygon in polygons for ring in polygon for a, b in zip(ring, ring[1:])
    )


def audit():
    os.environ["PROJ_NETWORK"] = "OFF"
    import geopandas as gpd
    import pyproj
    import shapely

    source = ROOT / "data" / "historical_boundaries.json"
    content = source.read_bytes()
    topology = json.loads(content)
    if topology["metadata"].get("coordinate_reference_system") != "OGC:CRS84":
        raise ValueError("The historical source must explicitly identify longitude/latitude CRS84")
    script = """
import fs from 'node:fs';
import {feature} from './tools/historical-boundaries/node_modules/topojson-client/src/index.js';
const topology = JSON.parse(fs.readFileSync('data/historical_boundaries.json','utf8'));
console.log(JSON.stringify(feature(topology, topology.objects.territories)));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    features = json.loads(result.stdout)["features"]
    frame = gpd.GeoDataFrame.from_features(features, crs="OGC:CRS84")
    if frame.id.duplicated().any():
        raise ValueError("Historical source identifiers are not unique")
    groups = defaultdict(list)
    crossing = set()
    for index, feature in enumerate(features):
        p = feature["properties"]
        if antimeridian_crossing(feature["geometry"]):
            crossing.add(p["id"])
        groups[(p["name"], p["controller"], p.get("kind"))].append((index, p))

    relationships = []
    for (name, controller, _), records in groups.items():
        for (a_index, a), (b_index, b) in combinations(records, 2):
            start = max(a["start"], b["start"])
            end = min(a["end"] if a["end"] is not None else math.inf,
                      b["end"] if b["end"] is not None else math.inf)
            if start >= end or end <= 1914 or start >= 2027:
                continue
            if a["id"] in crossing or b["id"] in crossing:
                continue
            left, right = frame.geometry.iloc[a_index], frame.geometry.iloc[b_index]
            if not left.is_valid or not right.is_valid or not left.relate_pattern(right, "T********"):
                continue
            relationships.append({
                "name": name, "controller": controller,
                "ids": [a["id"], b["id"]],
                "start": start, "end": None if math.isinf(end) else end,
                "kind": "duplicate" if left.equals(right) else "alternative",
            })
    years = []
    for year in range(1914, 2027):
        instant = year + .5
        active = [pair for pair in relationships if pair["start"] <= instant and (pair["end"] is None or pair["end"] > instant)]
        years.append({
            "year": year,
            "alternative_record_ids": sorted({identifier for pair in active if pair["kind"] == "alternative" for identifier in pair["ids"]}),
            "duplicate_pairs": sum(pair["kind"] == "duplicate" for pair in active),
        })
    return {
        "source": "Committed OpenHistoricalMap zoom-zero topology",
        "input_sha256": hashlib.sha256(content).hexdigest(),
        "crs": "OGC:CRS84",
        "method": "Topological interior-intersection tests on source polygons; coincident geometry is distinguished from nonidentical alternatives. No metric measurement in angular units and no automatic repairs.",
        "software": {"geopandas": gpd.__version__, "shapely": shapely.__version__, "pyproj": pyproj.__version__, "topojson_client": "3.1.0"},
        "features": len(frame),
        "null": int(frame.geometry.isna().sum()),
        "empty": int(frame.is_empty.sum()),
        "invalid": int((~frame.is_valid).sum()),
        "geometry_types": dict(Counter(frame.geom_type)),
        "antimeridian_records_not_compared": sorted(crossing),
        "relationships": relationships,
        "years": years,
        "limitations": [
            "Valid geometry is not proof of geographic or historical accuracy.",
            "The source is a generalized world-scale vector tile, not survey geometry or a daily front-line record.",
            "Nonidentical overlapping records are disclosed, not silently merged into an invented border.",
            "Administration grouping can be inferred from names; it is not independently verified effective control.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="write the committed audit report")
    args = parser.parse_args()
    report = audit()
    if args.write:
        index_path = ROOT / "data" / "historical_boundary_index.json"
        index = json.loads(index_path.read_text(encoding="utf-8"))
        if index.get("geometry_sha256") != report["input_sha256"]:
            raise ValueError("Run build.mjs before publishing an audit for changed geometry")
        target = ROOT / "data" / "historical_boundary_quality.json"
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        index["quality"] = report
        index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("features", "null", "empty", "invalid", "geometry_types")}))
    print(json.dumps({"relationships": len(report["relationships"]), "unassessed_antimeridian_records": len(report["antimeridian_records_not_compared"])}))
    return 1 if report["null"] or report["empty"] or report["invalid"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
