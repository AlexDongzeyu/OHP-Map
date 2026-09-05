import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def test_historical_identity_area_and_duplicate_selection():
    script = r"""
import fs from 'node:fs';
import {feature} from './tools/historical-boundaries/node_modules/topojson-client/src/index.js';
import {geoArea} from './tools/historical-boundaries/node_modules/d3-geo/src/index.js';
import {historicalIdentity, alignmentKey, datedTerritories} from './js/historical-identity.js';
const topology=JSON.parse(fs.readFileSync('data/historical_boundaries.json','utf8'));
const features=feature(topology,topology.objects.territories).features;
const source=features.filter(f=>f.properties.name==='Tanganyika Territory'&&f.properties.start<=1944.5&&(f.properties.end==null||f.properties.end>1944.5));
const selected=datedTerritories(features,1944).filter(f=>f.properties.name==='Tanganyika Territory');
console.log(JSON.stringify({
  east:historicalIdentity('East Germany'),
  soviet:historicalIdentity('Soviet Union'),
  empire:historicalIdentity('Austria-Hungary'),
  czech:historicalIdentity('Czechoslovakia'),
  alignment:alignmentKey('Soviet Union'),
  sourceCount:source.length, selectedCount:selected.length,
  wrongAreas:features.filter(f=>Math.abs(f.properties.area_km2-geoArea(f)*6371.0088**2)>.06).map(f=>f.properties.id),
  metadata:topology.metadata
}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    data = json.loads(result.stdout)
    assert data["east"]["controller"] == "East Germany"
    assert data["soviet"]["controller"] == "Soviet Union"
    assert data["empire"]["controller"] == "Austria-Hungary"
    assert data["czech"]["controller"] == "Czechoslovakia"
    assert data["alignment"] == "Russia"
    assert data["sourceCount"] > data["selectedCount"] == 1
    assert data["wrongAreas"] == []
    assert data["metadata"]["coordinate_reference_system"] == "OGC:CRS84"
    assert "not official land area" in data["metadata"]["area_method"]


def test_geometry_audit_is_current_and_does_not_claim_perfect_history():
    topology = ROOT / "data" / "historical_boundaries.json"
    quality = json.loads((ROOT / "data" / "historical_boundary_quality.json").read_text(encoding="utf-8"))
    index = json.loads((ROOT / "data" / "historical_boundary_index.json").read_text(encoding="utf-8"))
    assert quality["input_sha256"] == hashlib.sha256(topology.read_bytes()).hexdigest()
    assert index["quality"] == quality
    assert index["geometry_sha256"] == quality["input_sha256"]
    assert quality["features"] == 1181
    assert quality["null"] == quality["empty"] == quality["invalid"] == 0
    assert "Valid geometry is not proof" in quality["limitations"][0]
    alternatives = [pair for pair in quality["relationships"] if pair["kind"] == "alternative"]
    assert any(pair["name"] == "Soviet Union" for pair in alternatives)
    year = next(entry for entry in quality["years"] if entry["year"] == 1944)
    assert year["alternative_record_ids"]
