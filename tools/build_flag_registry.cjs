const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_FIELDS = [
  "id", "src", "title", "publisher", "url", "sourceUrl", "historyUrl",
  "license", "licenseUrl", "credit", "note", "checkedOn",
];
const RECORD_FIELDS = ["id", "names", "sourceId", "label", "start", "end", "note", "sourceUrl"];
const COUNTRY_FIELDS = ["id", "name", "names", "currentSourceId", "note"];

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must contain text.`);
}

function requireURL(value, label) {
  requireText(value, label);
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} must be a public source URL.`);
  }
}

function select(value, fields) {
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

function prepareFlagData(input, root = ROOT) {
  if (input?.format !== 1 || !["sources", "records", "countries"].every(key => Array.isArray(input[key]))) {
    throw new Error("The country flag source file has an unsupported format.");
  }
  requireText(input.checkedOn, "Flag catalogue check date");
  requireText(input.audit?.metadataLicense, "Country-name metadata licence");
  if (!Array.isArray(input.audit.assetFailures)) throw new Error("The flag acquisition audit is missing.");
  const result = {
    format: 1, checkedOn: input.checkedOn, metadataLicense: input.audit.metadataLicense,
    summary: { unavailableArtwork: input.audit.assetFailures.length, acquisitionIncomplete: Boolean(input.audit.acquisitionIncomplete) },
    sources: [], records: [], countries: [],
  };
  for (const field of ["sources", "records", "countries"]) {
    const ids = new Set();
    for (const entry of input[field]) {
      requireText(entry.id, `${field} ID`);
      if (ids.has(entry.id)) throw new Error(`Duplicate ${field} ID: ${entry.id}`);
      ids.add(entry.id);
    }
  }
  for (const source of input.sources) {
    for (const field of SOURCE_FIELDS) requireText(source[field], `${source.id}.${field}`);
    for (const field of ["url", "sourceUrl", "historyUrl", "licenseUrl"]) requireURL(source[field], `${source.id}.${field}`);
    if (!/^assets\/flags\/[a-z0-9-]+\.svg$/.test(source.src)) throw new Error(`Unsupported flag asset path: ${source.src}`);
    const body = fs.readFileSync(path.join(root, ...source.src.split("/")), "utf8").replace(/\r\n/g, "\n");
    result.sources.push({
      ...select(source, SOURCE_FIELDS), assetHash: createHash("sha256").update(body).digest("hex"),
    });
  }
  for (const record of input.records) {
    for (const field of ["sourceId", "label", "note", "sourceUrl", "start"]) requireText(record[field], `${record.id}.${field}`);
    requireURL(record.sourceUrl, `${record.id}.sourceUrl`);
    if (!Array.isArray(record.names) || !record.names.length || record.names.some(name => typeof name !== "string" || !name.trim())) {
      throw new Error(`Flag ${record.id} has no valid administration names.`);
    }
    if (![record.start, record.end].every(value => value === null || /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value))) {
      throw new Error(`Flag ${record.id} has an unsupported date precision.`);
    }
    result.records.push(select(record, RECORD_FIELDS));
  }
  for (const country of input.countries) {
    requireText(country.name, `${country.id}.name`);
    if (!Array.isArray(country.names) || country.names.some(name => typeof name !== "string" || !name.trim())) {
      throw new Error(`Country ${country.id} has invalid search aliases.`);
    }
    result.countries.push(select(country, COUNTRY_FIELDS));
  }
  return result;
}

async function buildFlagRegistry({ root = ROOT, check = false } = {}) {
  const input = JSON.parse(fs.readFileSync(path.join(root, "data", "source", "country_flags.json"), "utf8"));
  const data = prepareFlagData(input, root);
  const sourceHash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  const body = "// Generated from data/source/country_flags.json by tools/build_flag_registry.cjs.\n" +
    `export default ${JSON.stringify({ ...data, sourceHash }, null, 2)};\n`;
  const destination = path.join(root, "js", "flag-catalogue-data.js");
  const existing = fs.existsSync(destination) ? fs.readFileSync(destination, "utf8").replace(/\r\n/g, "\n") : null;
  if (check && existing !== body) throw new Error("The public flag module is stale. Run node tools/build_flag_registry.cjs.");
  if (!check && existing !== body) fs.writeFileSync(destination, body);

  const registry = await import(pathToFileURL(path.join(root, "js", "historical-context.js")).href);
  const intervals = new Map(), sourceIds = new Set(), recordIds = new Set();
  for (const source of registry.FLAG_SOURCES) {
    if (sourceIds.has(source.id)) throw new Error(`Duplicate flag source: ${source.id}`);
    sourceIds.add(source.id);
  }
  for (const record of registry.FLAG_RECORDS) {
    if (recordIds.has(record.id)) throw new Error(`Duplicate flag record: ${record.id}`);
    recordIds.add(record.id);
    const range = registry.flagInterval(record);
    if (!(range.start < range.end)) throw new Error(`Flag ${record.id} has invalid or indeterminate use dates.`);
    for (const name of record.names) {
      const key = name.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/g, " ");
      if (!intervals.has(key)) intervals.set(key, []);
      intervals.get(key).push({ ...range, id: record.id });
    }
  }
  for (const [name, rows] of intervals) {
    rows.sort((a, b) => a.start - b.start);
    for (let index = 1; index < rows.length; index++) {
      if (rows[index - 1].end > rows[index].start) {
        throw new Error(`Conflicting dated flags for ${name}: ${rows[index - 1].id}, ${rows[index].id}`);
      }
    }
  }
  registry.flagCatalogue(2026);
  return { sources: registry.FLAG_SOURCES.length, records: registry.FLAG_RECORDS.length, countries: data.countries.length, sourceHash };
}

module.exports = { buildFlagRegistry, prepareFlagData };

if (require.main === module) {
  buildFlagRegistry({ check: process.argv.includes("--check") }).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
