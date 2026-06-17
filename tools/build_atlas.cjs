// Build a compact Europe basemap (data/atlas-europe.json) from the vendored
// world-atlas TopoJSON. Trims to a Europe + Mediterranean + Near-East window and
// rounds coordinates so the client downloads ~120 KB instead of 756 KB, while keeping
// crisp 50m coastlines. Run via tools/assemble_site.cjs and standalone:
//   node tools/build_atlas.cjs
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "vendor", "atlas", "countries-110m.json");
const OUT = path.join(ROOT, "data", "atlas-europe.json");

// Visible window (lng/lat). Toronto + other trans-frame places are drawn as
// off-map anchors by the client, so North America is intentionally excluded.
const BOX = { west: -26, east: 62, south: 27, north: 72 };

function intersectsBox(coords) {
  // coords: array of [lng,lat]; true if any vertex is inside the window.
  for (const ring of coords) {
    for (const pt of ring) {
      const [x, y] = Array.isArray(pt[0]) ? [null, null] : pt;
      if (x === null) continue;
      if (x >= BOX.west && x <= BOX.east && y >= BOX.south && y <= BOX.north) return true;
    }
  }
  return false;
}

function roundRings(geom) {
  const r = (n) => Math.round(n * 100) / 100;
  const walk = (a) =>
    typeof a[0] === "number" ? [r(a[0]), r(a[1])] : a.map(walk);
  return { ...geom, coordinates: walk(geom.coordinates) };
}

function flattenRings(geom) {
  // Return a flat list of rings for the bbox test, regardless of Polygon/MultiPolygon.
  if (geom.type === "Polygon") return geom.coordinates;
  if (geom.type === "MultiPolygon") return geom.coordinates.flat();
  return [];
}

function main() {
  const topojson = require(path.join(ROOT, "vendor", "topojson", "topojson-client.min.js"));
  const topo = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const fc = topojson.feature(topo, topo.objects.countries);

  const kept = [];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    if (!intersectsBox(flattenRings(f.geometry))) continue;
    kept.push({
      type: "Feature",
      properties: { name: f.properties && f.properties.name },
      geometry: roundRings(f.geometry),
    });
  }

  const out = { type: "FeatureCollection", window: BOX, features: kept };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`atlas-europe.json: ${kept.length} countries, ${kb} KB`);
}

main();
