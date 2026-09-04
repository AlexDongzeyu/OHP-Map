import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VectorTile } from "@mapbox/vector-tile";
import { geoEqualEarth, geoPath } from "d3-geo";
import { PbfReader } from "pbf";
import { feature as topojsonFeature } from "topojson-client";
import { topology } from "topojson-server";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SOURCE_URL = "https://vtiles.openhistoricalmap.org/maps/ohm_admin/0/0/0.pbf";
const MIN_YEAR = 1914;
const MAX_YEAR = 2026;
const ERA_ART_YEARS = [1914, 1944, 1960, 1991, 2026];
const EXCLUDED_TYPES = new Set([
  "autonomous_region",
  "culture",
  "episcopal_conference",
  "governorate",
  "princely_state",
  "province",
  "soviet_federative_socialist_republic",
  "soviet_socialist_republic",
]);
const EXCLUDED_NAMES = [
  /\breservation\b/i,
  /^Kingdom of Sine$/i,
  /^Kingdom of Travancore$/i,
];

function controllerFor(name) {
  const rules = [
    ["Canada", /^(?:Dominion of )?Canada$/i],
    ["Australia", /^Australia$/i],
    ["New Zealand", /^(?:Dominion of )?New Zealand$/i],
    ["South Africa", /^(?:Union of )?South Africa$/i],
    ["United States of America", /^(?:United States|US Philippines)$|\bAmerican occupation\b/i],
    ["Germany", /\b(?:German|Germany|Deutsche|Kiautschou|Nazi)\b/i],
    ["France", /\bFrench\b|^France$|^French Republic$|^Indochinese (?:Union|Federation)$|^Kwangchowan$|^La Réunion$|^Upper Senegal and Niger$|^Ubangi-Shari-Chad$|^Protectorate of Mauritania$|^Colony of Madagascar and Dependencies$|^Fezzan-Ghadames Military Territory$/i],
    ["United Kingdom", /\bBritish\b|^United Kingdom|^Crown Colony|^Rhodesia$|^Northern Rhodesia$|^Nyasaland|^Gold Coast|^Trucial States$|^Anglo-Egyptian Sudan$|^Tanganyika Territory$|^Bechuanaland Protectorate$|^Colony and Protectorate of Nigeria$|^(?:Dominion of |Commission Government of )Newfoundland$/i],
    ["Italy", /\bItalian\b|^Italy$|^Kingdom of Italy$/i],
    ["Japan", /\bJapan(?:ese)?\b|^Manchukuo$/i],
    ["Netherlands", /\bDutch\b|^Kingdom of the Netherlands$|^Netherlands$/i],
    ["Belgium", /\bBelgian\b|^Belgium$/i],
    ["Portugal", /\bPortuguese\b|^Portugal$|^(?:Province|Colony) of Mozambique$/i],
    ["Spain", /\bSpanish\b|^Spain$/i],
    ["Russia", /^Russian Empire$|^Soviet Union$|^USSR$|^Russia$/i],
    ["Turkey", /^Ottoman Empire$|^Turkey$/i],
    ["Austria", /^Austria-Hungary$|^Austria$/i],
    ["Iran", /^Persia$|^Iran$/i],
    ["Thailand", /^Siam$|^Thailand$/i],
    ["Egypt", /^(?:Kingdom|Sultanate) of Egypt$|^Egypt$/i],
    ["Afghanistan", /^(?:Kingdom|Emirate|Protectorate) of Afghanistan$|^Afghanistan$/i],
    ["Pakistan", /^Dominion of Pakistan$|^Pakistan$/i],
    ["Myanmar", /^Burma$|^Myanmar$/i],
    ["Japan", /^State of Burma$/i],
    ["China", /^China$|^(?:People's )?Republic of China$/i],
    ["Poland", /^Poland$|^Republic of Poland$/i],
    ["Czechia", /^Czechoslovakia$|^Czechoslovak Republic$/i],
    ["Romania", /^Kingdom of Romania$|^Romania$/i],
    ["Greece", /^Kingdom of Greece$|^Greece$/i],
    ["Bulgaria", /^(?:Tsardom|Kingdom|People's Republic|Republic) of Bulgaria$|^Bulgaria$/i],
  ];
  return rules.find(([, pattern]) => pattern.test(name))?.[0] || name;
}

function overlapsTargetPeriod(start, end) {
  return start <= MAX_YEAR + 0.999 && (end == null || end > MIN_YEAR);
}

function activeAt(feature, year) {
  const instant = year + 0.5;
  const { start, end } = feature.properties;
  return start <= instant && (end == null || end > instant);
}

const dataDir = path.join(ROOT, "data");
const boundaryPath = path.join(dataDir, "historical_boundaries.json");
const refresh = process.argv.includes("--refresh");
const boundaryExists = await fs.stat(boundaryPath).then(
  () => true,
  (error) => error.code === "ENOENT" ? false : Promise.reject(error),
);

let output;
if (refresh || !boundaryExists) {
  const response = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "CrestwoodOHP-Map-BoundaryBuilder/1.0" },
  });
  if (!response.ok) {
    throw new Error(`OpenHistoricalMap boundary download failed: ${response.status}`);
  }

  const tile = new VectorTile(new PbfReader(new Uint8Array(await response.arrayBuffer())));
  const layer = tile.layers.boundaries;
  if (!layer) throw new Error("OpenHistoricalMap tile is missing its boundaries layer");

  const refreshedFeatures = [];
  for (let index = 0; index < layer.length; index++) {
    const source = layer.feature(index);
    const properties = source.properties;
    if (Number(properties.admin_level) !== 2) continue;

    const name = properties.name_en || properties.name || properties.official_name;
    const start = Number(properties.start_decdate);
    const parsedEnd = Number(properties.end_decdate);
    const end = Number.isFinite(parsedEnd) ? parsedEnd : null;
    const kind = String(properties.border_type || "");
    if (!name || !Number.isFinite(start) || !overlapsTargetPeriod(start, end)) continue;
    if (EXCLUDED_TYPES.has(kind) || EXCLUDED_NAMES.some((pattern) => pattern.test(name))) continue;

    refreshedFeatures.push({
      type: "Feature",
      properties: {
        id: properties.osm_id,
        name,
        controller: controllerFor(name),
        start,
        end,
        kind: kind || null,
        disputed: properties.disputed || 0,
        area_km2: Number(properties.area_km2) || null,
      },
      geometry: source.toGeoJSON(0, 0, 0).geometry,
    });
  }

  output = topology({ territories: { type: "FeatureCollection", features: refreshedFeatures } }, 10000);
  output.metadata = {
    source: "OpenHistoricalMap ohm_admin z0",
    source_url: SOURCE_URL,
    source_license: "CC0",
    source_terms: "https://www.openhistoricalmap.org/copyright",
    sampling: "Mid-year state (July 2) for whole-year navigation",
    min_year: MIN_YEAR,
    max_year: MAX_YEAR,
    feature_count: refreshedFeatures.length,
  };
  await fs.writeFile(boundaryPath, `${JSON.stringify(output)}\n`);
} else {
  output = JSON.parse(await fs.readFile(boundaryPath, "utf8"));
}

const features = topojsonFeature(output, output.objects.territories).features;

const years = [];
for (let year = MIN_YEAR; year <= MAX_YEAR; year++) {
  const changes = features.filter((feature) => {
    const { start, end } = feature.properties;
    return Math.floor(start) === year || (end != null && Math.floor(end) === year);
  }).length;
  years.push({
    year,
    active: features.filter((feature) => activeAt(feature, year)).length,
    changes,
  });
}
const index = {
  source: "OpenHistoricalMap",
  source_license: "CC0",
  min_year: MIN_YEAR,
  max_year: MAX_YEAR,
  years,
};

const historyAssetDir = path.join(ROOT, "assets", "history");
await fs.mkdir(historyAssetDir, { recursive: true });
await fs.writeFile(
  path.join(dataDir, "historical_boundary_index.json"),
  `${JSON.stringify(index, null, 2)}\n`,
);

for (const year of ERA_ART_YEARS) {
  const active = features.filter((feature) => activeAt(feature, year));
  const activeCollection = { type: "FeatureCollection", features: active };
  const projection = geoEqualEarth().fitExtent([[12, 12], [688, 388]], activeCollection);
  const draw = geoPath(projection).digits(1);
  const paths = active.map((feature) => {
    const shade = Math.abs(String(feature.properties.controller).split("").reduce(
      (hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0,
      0,
    )) % 3;
    const opacity = [0.34, 0.43, 0.52][shade];
    return `<path d="${draw(feature)}" fill="#B9CBD6" fill-opacity="${opacity}" stroke="#E5EDF2" stroke-opacity=".34" stroke-width=".6"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 400" role="img" aria-label="Historical territory map for ${year}"><g>${paths}</g></svg>\n`;
  await fs.writeFile(path.join(historyAssetDir, `atlas-${year}.svg`), svg);
}

const bytes = Buffer.byteLength(JSON.stringify(output));
console.log(
  `Wrote ${features.length} dated territories (${Math.round(bytes / 1024)} KB TopoJSON) ` +
  `and ${ERA_ART_YEARS.length} era maps.`,
);
