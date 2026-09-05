/**
 * Historical identification, not endorsement or a claim about sovereignty.
 *
 * Like the boundary layer, an integer year is sampled at year + 0.5: the UTC
 * midpoint between 1 January and the following 1 January (2 July, at 00:00 in
 * leap years and 12:00 otherwise). Intervals are start-inclusive/end-exclusive.
 * A change after that instant therefore first appears in the following sample.
 *
 * YYYY is an ISO 8601 reduced-precision date, NOT an invented 1 January date.
 * Where a source gives only a transition year, neither adjacent design is
 * returned in that year. An unavailable flag is not evidence of statelessness.
 */

export const HISTORICAL_CONTEXT_META = Object.freeze({
  checkedOn: "2026-09-05",
  sampleYearOffset: 0.5,
  sampleInstant: "UTC midpoint of the selected calendar year (year + 0.5).",
  intervals: "Start inclusive; end exclusive; null end means ongoing.",
  datePrecision: "YYYY-MM-DD is day precision; YYYY is year precision. Uncertain transition years are withheld.",
  purpose: "Neutral historical identification, not endorsement, recognition, or a statement of territorial control.",
  colourPolicy: "SVGs are screen renderings, not measurements of historical cloth. Schematic colours are identified explicitly.",
  resources: "External catalogue or museum links only. Relevance ranges are editorial, not dates of territorial validity. publishedYear is the work's original publication year, or null if unverified.",
  gaps: Object.freeze([
    "Canada: exact change days for the 1892 authorization, 1922 ensign and 1957 red-leaf revision are not established here; those transition years are withheld.",
    "Germany: no invented national flag for Allied occupation between May 1945 and the 1949 federal flag.",
    "Soviet Union: 1922–1924 and the uncertain 1936 transition are withheld; 1955 geometry is never backdated. Russia's imperial, revolutionary and pre-August-1991 republican flags are not verified in this registry.",
    "Poland: no modern national flag is assigned before its 1919 adoption; occupation does not erase the legal flag.",
    "Unlisted controllers and dates return null rather than a modern substitute.",
  ]),
});

const COMMONS = "https://commons.wikimedia.org/wiki/File:";
const CC0 = "https://creativecommons.org/publicdomain/zero/1.0/";
const LICENSE_URLS = {
  "CC0-1.0": CC0,
  "CC-BY-SA-3.0": "https://creativecommons.org/licenses/by-sa/3.0/",
  "CC-BY-SA-4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
};
const CANADA_HISTORY = "https://www.canada.ca/en/canadian-heritage/services/flag-canada-history.html";
const CANADA_ENSIGN = "https://www.gg.ca/en/heraldry/public-register/project/1146";
const GERMANY_HISTORY = "https://www.bundestag.de/en/parliament/symbols/flag";
const FRANCE_HISTORY = "https://www.elysee.fr/en/french-presidency/the-french-flag";
const GERMANY_LAW = "https://www.gesetze-im-internet.de/englisch_gg/englisch_gg.html";
const RUSSIA_1991 = "http://pravo.gov.ru/proxy/ips/?docbody=&nd=102012339&rdk=0";
const RUSSIA_1993 = "http://pravo.gov.ru/proxy/ips/?docbody=&nd=102027590&rdk=0";

function commons(file) {
  return COMMONS + encodeURIComponent(file.replaceAll(" ", "_"));
}

function source(id, file, title, sourceUrl, license, credit, rightsNote, historyUrl = sourceUrl) {
  return Object.freeze({
    id, src: `assets/flags/${file}`, title, publisher: "Wikimedia Commons / cited original source",
    url: sourceUrl, sourceUrl, historyUrl, license, credit,
    licenseUrl: LICENSE_URLS[license] || sourceUrl,
    note: rightsNote,
    checkedOn: HISTORICAL_CONTEXT_META.checkedOn,
  });
}

function diagram(id, file, title, referenceFile, historyUrl, note = "") {
  return Object.freeze({
    ...source(
      id, file, title, commons(referenceFile), "CC0-1.0",
      "OHP Map — original geometric SVG rendering.",
      `Original geometric rendering dedicated to CC0; the cited page documents the underlying flag design. ${note}`.trim(),
      historyUrl,
    ),
    publisher: "OHP Map (SVG); cited official / Commons design documentation",
  });
}

export const FLAG_SOURCES = Object.freeze([
  source("ca-1868", "canada-red-ensign-1868.svg", "Canadian Red Ensign — four-province shield",
    commons("Flag of Canada (1868–1921).svg"), "Public domain",
    "Greentubing~commonswiki; constituent flag artwork credited on the Commons file page.",
    "Commons: PD-self. Sanitized local copy; editorial metadata removed, visible artwork preserved. The filename's 1921 end is not used as an adoption date: the official register dates the new ensign to 1922.", CANADA_ENSIGN),
  source("ca-1922", "canada-red-ensign-1922.svg", "Canadian Red Ensign — 1921 arms, green leaves",
    commons("Flag of Canada (1921–1957).svg"), "Public domain",
    "Hoshie; constituent artwork credited on the Commons file page.",
    "Commons: PD-user (Hoshie). Sanitized local copy. Canada's official register says this ensign was introduced in 1922, after the 1921 grant of arms.", CANADA_ENSIGN),
  source("ca-1957", "canada-red-ensign-1957.svg", "Canadian Red Ensign — 1957 red-leaf revision",
    commons("Flag of Canada (1957–1965).svg"), "Public domain",
    "Denelson83; constituent artwork credited on the Commons file page.",
    "Commons: PD-self, PD-Canada and PD-US-not renewed. Sanitized local copy; insignia restrictions are separate from copyright.", CANADA_ENSIGN),
  source("ca-1965", "canada-1965.svg", "National Flag of Canada — maple leaf",
    commons("Flag of Canada.svg"), "Public domain",
    "George F. G. Stanley (design); E Pluribus Anthony / Mzajac and Commons contributors (SVG).",
    "Commons: PD-Canada. Geometry follows the linked construction sheet. Canada's flag/official-mark rules still apply; this is educational identification, not branding.", CANADA_HISTORY),
  source("gb-1801", "united-kingdom-1801.svg", "Union Flag — 1801 design, 3:5 rendering",
    commons("Flag of the United Kingdom (3-5).svg"), "Public domain",
    "Acts of Union 1800 (design); Yaddah (vector), with earlier SVG contributors credited on Commons.",
    "Commons file explicitly declares public-domain reuse. Sanitized local copy of the 3:5 land rendering, not a royal standard.",
    "https://www.royal.uk/union-jack"),
  source("us-48", "united-states-48-stars.svg", "United States national flag — 48 stars",
    commons("Flag of the United States (1912-1959).svg"), "Public domain",
    "United States flag design; jacobolus (SVG).",
    "Commons explicitly declares public-domain reuse and dates use to 4 July 1912–3 July 1959; sanitized local SVG."),
  source("us-49", "united-states-49-stars.svg", "United States national flag — 49 stars",
    commons("Flag of the United States (1959–1960).svg"), "Public domain",
    "United States Government (design); Gunter Küchler / Berlin (SVG).",
    "Commons explicitly declares public-domain reuse; cites Executive Order 10798 and 4 July 1959–3 July 1960."),
  source("us-50", "united-states-50-stars.svg", "United States national flag — 50 stars",
    commons("Flag of the United States.svg"), "Public domain",
    "United States Government (design); Dbenbenn, Zscout370, Jacobolus, Indolences, Technion and Commons contributors (SVG).",
    "Commons explicitly declares public-domain reuse. The current SVG uses the State Department's screen-colour guidance; historical cloth colours varied.",
    "https://www.archives.gov/federal-register/codification/executive-order/10834.html"),
  diagram("fr-tricolour", "france-tricolour.svg", "French national/civil tricolour — schematic colours",
    "Flag of France.svg", FRANCE_HISTORY,
    "Equal vertical blue, white and red bands. The diagram does not claim a single official RGB specification across two centuries."),
  diagram("de-imperial", "germany-imperial.svg", "German black-white-red national/civil flag",
    "Flag of Germany (1867–1918).svg", GERMANY_HISTORY),
  diagram("de-weimar", "germany-weimar.svg", "Weimar national flag — black-red-gold, 2:3",
    "Flag of Germany (3-2).svg", GERMANY_HISTORY),
  diagram("de-federal", "germany-federal.svg", "German federal national/civil flag — black-red-gold, 3:5",
    "Flag of Germany.svg", GERMANY_LAW),
  source("de-1935", "germany-1935.svg", "German national/merchant flag — 1935 Nazi design",
    commons("Flag of Germany (1935–1945).svg"), "Public domain",
    "German government; vector contributors credited on the Commons file page.",
    "Commons declares the official flag public domain. Educational historical identification only; restrictions on Nazi insignia can apply independently of copyright."),
  source("de-east", "germany-east-1959.svg", "GDR national flag — hammer, compass and wreath",
    commons("Flag of East Germany.svg"), "Public domain",
    "GDR official design; Jwnabd (SVG).",
    "Commons: PD-Flag-Germany. File cites the law of 1 October 1959 and later flag regulations; sanitized local copy."),
  diagram("ru-1991", "russia-1991.svg", "Russian national flag — 1991–1993, 1:2 and azure blue",
    "Flag of Russia (1991–1993).svg", RUSSIA_1991,
    "Separate 1:2, white/azure/scarlet rendering, not the post-1993 2:3 design."),
  diagram("ru-1993", "russia-1993.svg", "Russian national flag — 1993 design, 2:3",
    "Flag of Russia.svg", RUSSIA_1993,
    "Decree No. 2126 of 11 December 1993, not the constitution's 12 December referendum, is the design transition. Exact RGB shades are not prescribed by the law."),
  source("su-1924", "soviet-union-1924.svg", "Soviet Union — 1924 national flag design",
    commons("Flag of the Soviet Union (1924–1936).svg"), "CC-BY-SA-4.0",
    "Supreme Dragon (SVG), via Wikimedia Commons; sanitized by OHP Map.",
    "The file page lists PD-RU-exempt for the official flag and CC BY-SA 4.0 for the vector. This local adaptation is distributed under the creator's CC BY-SA 4.0 grant, not assumed to be CC0. Only editor metadata was removed."),
  source("su-1936", "soviet-union-1936.svg", "Soviet Union — documented pre-1955 national flag",
    commons("Flag of the Soviet Union (1936 – 1955).svg"), "Public domain",
    "rotemliss, derived from the Soviet flag SVG credited on Commons.",
    "Commons: PD-Russia. Sanitized local copy of the separately documented pre-1955 artwork; not the later standardized hammer-and-sickle geometry."),
  source("su-1955", "soviet-union-1955.svg", "Soviet Union — 1955 national flag obverse",
    commons("Flag of the Soviet Union (dark version).svg"), "CC-BY-SA-3.0",
    "Cmapm, derived from Flag of the Soviet Union.svg; sanitized by OHP Map.",
    "Commons: CC BY-SA 3.0. This adaptation retains that licence and the same visible artwork. The page documents 1955 geometry with schematic dark red; the 1980 reverse-side rule is not misrepresented as a new obverse design."),
  diagram("jp-1870", "japan-1870.svg", "Hinomaru — historical 7:10 civil/national design",
    "Flag of Japan (1870–1999).svg", commons("Flag of Japan (1870–1999).svg"),
    "Historical 7:10 proportions with the disc shifted one hundredth of the flag width toward the hoist."),
  diagram("jp-1999", "japan-1999.svg", "Hinomaru — statutory national flag, 2:3",
    "Flag of Japan.svg", commons("Flag of Japan.svg"),
    "Centred disc and 2:3 ratio; not the naval Rising Sun ensign."),
  diagram("pl-1919", "poland-1919.svg", "Polish national/civil flag — 1919 pattern",
    "Flag of Poland (1919–1928).svg", "https://api.sejm.gov.pl/eli/acts/DU/1919/416",
    "Historical crimson is a schematic screen rendering, not a claim of measured cloth colour."),
  diagram("pl-1928", "poland-1928.svg", "Polish national/civil flag — 1928 pattern",
    "Flag of Poland (1928–1980).svg", "https://api.sejm.gov.pl/eli/acts/DU/1927/980",
    "Historical vermilion is a schematic screen rendering. The national bicolour is not suppressed during occupation."),
  diagram("pl-1980", "poland-1980.svg", "Polish national/civil flag — 1980 specification",
    "Flag of Poland.svg", "https://api.sejm.gov.pl/eli/acts/DU/1980/18",
    "Screen approximation of the statutory colours; not the state flag with an eagle."),
]);

const sourcesById = new Map(FLAG_SOURCES.map((entry) => [entry.id, entry]));

function record(id, names, sourceId, label, start, end, note, sourceUrl) {
  const rights = sourcesById.get(sourceId);
  return Object.freeze({
    id, names: Object.freeze(names), sourceId,
    src: rights.src, label, start, end,
    sourceUrl: sourceUrl || rights.historyUrl,
    license: rights.license, credit: rights.credit, note,
  });
}

const CANADA = ["Canada", "Dominion of Canada"];
const UK = ["United Kingdom", "United Kingdom of Great Britain and Northern Ireland", "United Kingdom of Great Britain and Ireland", "UK", "U.K.", "Britain", "Great Britain"];
const US = ["United States of America", "United States", "USA", "U.S.A.", "US", "U.S."];
const GERMANY_REICH = ["Germany", "German Reich", "Deutsches Reich"];
const GERMANY_FEDERAL = ["Germany", "Federal Republic of Germany", "Bundesrepublik Deutschland"];
const WEST_GERMANY = ["West Germany", "FRG", "BRD"];
const EAST_GERMANY = ["East Germany", "German Democratic Republic", "GDR", "DDR", "Deutsche Demokratische Republik"];
const RUSSIA = ["Russia", "Russian Federation", "Российская Федерация", "Россия"];
const SOVIET_UNION = ["Soviet Union", "Union of Soviet Socialist Republics", "USSR", "U.S.S.R.", "СССР", "Союз Советских Социалистических Республик"];
const JAPAN = ["Japan", "Nippon", "Nihon", "日本", "日本国"];
const POLAND = ["Poland", "Republic of Poland", "Polska", "Rzeczpospolita Polska"];

export const FLAG_RECORDS = Object.freeze([
  record("canada-four-provinces", CANADA, "ca-1868",
    "Canadian Red Ensign — four-province civil ensign", "1892", "1922",
    "Authorized for Canadian vessels in 1892; also used unofficially on land. This four-province version is not every locally used Red Ensign, nor Canada's present national flag. The Royal Union Flag also had official use."),
  record("canada-green-leaves", CANADA, "ca-1922",
    "Canadian Red Ensign — civil ensign with 1921 arms", "1922", "1957",
    "The new arms were granted in 1921; the Governor General's register dates their introduction on the ensign to 1922. Green maple leaves; later authorized for government use on land. Not the present national flag."),
  record("canada-red-leaves", CANADA, "ca-1957",
    "Canadian Red Ensign — 1957 civil/government design", "1957", "1965-02-15",
    "Red-leaf revision of the ensign, used before the maple-leaf national flag. The exact 1957 transition day is not established here."),
  record("canada-maple-leaf", CANADA, "ca-1965",
    "Canada — national maple-leaf flag", "1965-02-15", null,
    "Inaugurated on 15 February 1965, following the January proclamation."),
  record("united-kingdom", UK, "gb-1801",
    "United Kingdom — national Union Flag (3:5 land rendering)", "1801-01-01", null,
    "1801 union design. This is the national Union Flag, not the monarch's Royal Standard."),
  record("united-states-48", US, "us-48",
    "United States — national flag, 48 stars", "1912-07-04", "1959-07-04",
    "Six rows of eight stars. The 1959 mid-year sample is still the 48-star flag."),
  record("united-states-49", US, "us-49",
    "United States — national flag, 49 stars", "1959-07-04", "1960-07-04",
    "Alaska's star; seven staggered rows of seven. The 1960 mid-year sample uses this one-year design."),
  record("united-states-50", US, "us-50",
    "United States — national flag, 50 stars", "1960-07-04", null,
    "Hawaii's star. First appears in the atlas's 1961 mid-year sample, not 1960. Modern SVG screen colours do not establish the colours of every historical flag."),
  record("france", ["France", "French Republic", "République française"], "fr-tricolour",
    "France — national/civil tricolour (schematic colours)", "1830", null,
    "The national blue-white-red tricolour was restored in 1830. It is not Pétain's personal standard or the Free French cross-of-Lorraine flag. Shades have varied; this diagram does not assign a modern RGB standard to earlier cloth."),
  record("france-vichy", ["Vichy France", "French State", "État français"], "fr-tricolour",
    "France — national/civil tricolour (schematic colours)", "1940-07-10", "1944-08-25",
    "The national tricolour, not Pétain's personal standard. Identifying the flag does not imply control of all French territory."),
  record("germany-imperial", [...GERMANY_REICH, "German Empire", "Deutsches Kaiserreich"], "de-imperial",
    "Germany — black-white-red national/civil flag", "1871", "1919-08-11",
    "Imperial colours remained in use through the transition before the Weimar constitution. The 1919 mid-year sample precedes the 11 August change."),
  record("germany-weimar", [...GERMANY_REICH, "Weimar Republic"], "de-weimar",
    "Germany — Weimar national flag (2:3)", "1919-08-11", "1933-03-12",
    "Black-red-gold under Article 3 of the Weimar constitution; not the contemporary black-white-red merchant ensign with a canton."),
  record("germany-1933", [...GERMANY_REICH, "Nazi Germany"], "de-imperial",
    "Germany — black-white-red co-national flag", "1933-03-12", "1935-09-15",
    "Restored alongside the Nazi flag in March 1933; this was not the sole national flag. The 1935 mid-year sample still falls in that co-national period."),
  record("germany-1935", [...GERMANY_REICH, "Nazi Germany"], "de-1935",
    "Germany — Nazi national/merchant flag (1935 design)", "1935-09-15", "1945-05-08",
    "Sole national flag from September 1935 until the regime's defeat in May 1945. Displayed solely for historical identification, not endorsement. No successor national flag is invented for Allied occupation."),
  record("germany-federal", GERMANY_FEDERAL, "de-federal",
    "Germany — federal national/civil flag (3:5)", "1949-05-23", null,
    "Article 22 of the Basic Law. Identifies the Federal Republic, including reunified Germany after 3 October 1990; not a claim that West Germany governed the GDR."),
  record("west-germany", WEST_GERMANY, "de-federal",
    "West Germany — federal national/civil flag (3:5)", "1949-05-23", "1990-10-03",
    "The Federal Republic's plain tricolour, not the federal service flag with an eagle."),
  record("east-germany-plain", EAST_GERMANY, "de-federal",
    "East Germany — national flag without emblem", "1949-10-07", "1959-10-01",
    "The GDR initially used the plain black-red-gold tricolour. In particular, the 1959 mid-year sample must not show the later emblem.", GERMANY_HISTORY),
  record("east-germany-emblem", EAST_GERMANY, "de-east",
    "East Germany — national flag with state emblem", "1959-10-01", "1990-10-03",
    "Hammer, compass and wreath added by the law of 1 October 1959. The 1990 mid-year sample precedes reunification."),
  record("russia-1991", [...RUSSIA, "RSFSR", "Russian Soviet Federative Socialist Republic"], "ru-1991",
    "Russia — national tricolour, 1991–1993 design (1:2)", "1991-08-22", "1993-12-11",
    "White, azure blue and scarlet, with 1:2 proportions. Not the Soviet Union's flag. The 1991 mid-year sample precedes adoption and is intentionally unavailable."),
  record("russia-1993", RUSSIA, "ru-1993",
    "Russia — national tricolour, 1993 design (2:3)", "1993-12-11", null,
    "The presidential flag decree of 11 December 1993 changed the proportions and specified white, blue and red. This is not dated to the 12 December constitutional referendum; 1993 still samples the earlier design."),
  record("soviet-union-1924", SOVIET_UNION, "su-1924",
    "Soviet Union — national flag, 1924 design", "1924", "1936",
    "Documented early hammer-and-sickle design, not the 1955 geometry. Exact transition days for this file's 1924–1936 range are not established here. The USSR was only formed in late December 1922; no flag is assigned to the 1922 mid-year sample."),
  record("soviet-union-1936", SOVIET_UNION, "su-1936",
    "Soviet Union — national flag, pre-1955 design", "1936", "1955-08-19",
    "Separate pre-1955 artwork documented as the 1936–1955 variant. The uncertain 1936 transition year is withheld; the 1955 mid-year sample still precedes the new statute."),
  record("soviet-union-1955", SOVIET_UNION, "su-1955",
    "Soviet Union — national flag, 1955 obverse design", "1955-08-19", "1991-12-26",
    "Geometry standardized by the statute of 19 August 1955, with schematic dark red. The 1980 regulation concerned the uncharged reverse, not a new obverse. No use before 1955 is inferred."),
  record("japan-historical", [...JAPAN, "Empire of Japan"], "jp-1870",
    "Japan — Hinomaru civil/national flag (historical 7:10)", "1870-02-27", "1999-08-13",
    "Historical Hinomaru proportions with a slightly hoistward disc. National/civil identification, not the naval Rising Sun ensign and not a claim that occupation authorities always allowed its display."),
  record("japan-statutory", JAPAN, "jp-1999",
    "Japan — statutory national Hinomaru (2:3)", "1999-08-13", null,
    "The 1999 Act on National Flag and Anthem specified the centred-disc, 2:3 design. The mid-year 1999 sample retains the historical geometry."),
  record("poland-1919", POLAND, "pl-1919",
    "Poland — national/civil bicolour (1919 crimson pattern)", "1919-08-25", "1928-03-29",
    "White above crimson, 5:8; schematic screen colours. The law was adopted on 1 August 1919; the Sejm catalogue dates its entry into force to 25 August. No modern Polish flag is assigned to 1914."),
  record("poland-1928", POLAND, "pl-1928",
    "Poland — national/civil bicolour (1928 vermilion pattern)", "1928-03-29", "1980-03-11",
    "White above vermilion, 5:8; schematic screen colours. The legal national flag is retained through German and Soviet occupation; its presence is not a claim of Polish territorial control."),
  record("poland-1980", POLAND, "pl-1980",
    "Poland — national/civil bicolour (1980 colour specification)", "1980-03-11", null,
    "White above red, 5:8; screen approximation of the statutory colours. Not the state/merchant variant bearing an eagle."),
]);

function normalizeController(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").trim().toLocaleLowerCase("en")
    .replace(/\s+/g, " ");
}

function validYear(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d{4}$/.test(value.trim())) return null;
  const year = Number(value);
  return Number.isInteger(year) && year >= 1000 && year <= 9998 ? year : null;
}

function dateLimit(value, isStart) {
  if (value === null) return isStart ? -Infinity : Infinity;
  if (/^\d{4}$/.test(value)) return Date.UTC(Number(value) + (isStart ? 1 : 0), 0, 1);
  return Date.parse(`${value}T00:00:00Z`);
}

const recordsByController = new Map();
for (const entry of FLAG_RECORDS) {
  for (const name of entry.names) {
    const key = normalizeController(name);
    if (!recordsByController.has(key)) recordsByController.set(key, []);
    recordsByController.get(key).push(entry);
  }
}

export function flagFor(controllerName, year) {
  const selectedYear = validYear(year);
  if (selectedYear === null) return null;
  const startOfYear = Date.UTC(selectedYear, 0, 1);
  const instant = startOfYear + (Date.UTC(selectedYear + 1, 0, 1) - startOfYear) / 2;
  const entry = (recordsByController.get(normalizeController(controllerName)) || [])
    .find((candidate) => instant >= dateLimit(candidate.start, true)
      && instant < dateLimit(candidate.end, false));
  if (!entry) return null;
  const { src, label, start, end, sourceUrl, license, credit, note } = entry;
  return { src, label, start, end, sourceUrl, license, credit, note };
}

const CONTEXT_RESOURCES = Object.freeze([
  Object.freeze({
    title: "Map of Europe — The New Student's Reference Work",
    url: commons("NSRW Europe.jpg"),
    publisher: "Rand McNally & Co. / The New Student's Reference Work",
    kind: "map", publishedYear: 1914, from: 1914, to: 1918,
    note: "Original 1914 printed map, volume 2, between pages 633–634; Commons records PD-1923. A period cartographic source, not a modern reconstruction or the atlas's boundary dataset. External scan/catalogue link only.",
  }),
  Object.freeze({
    title: "HQ Twelfth Army Group situation map — 10 September 1944",
    url: commons("(September 10, 1944), HQ Twelfth Army Group situation map. LOC 2004629135.tif"),
    publisher: "U.S. Army / Library of Congress",
    kind: "map", publishedYear: 1944, from: 1939, to: 1948,
    note: "Specific Allied situation map for 10 September 1944, not for every year in this relevance range. LOC item 2004629135, digital ID g5701s.ict21097; Commons records PD-USGov. External catalogue/scan only, not a territorial-recognition authority.",
  }),
  Object.freeze({
    title: "Churchill's Island",
    url: "https://www.nfb.ca/film/churchills_island/",
    publisher: "National Film Board of Canada",
    kind: "video", publishedYear: 1941, from: 1939, to: 1945,
    note: "Stuart Legg's 1941 film about Britain's wartime defences. The NFB identifies it as a propaganda film: a period source to examine critically, not neutral retrospective narration. Official external film page only; no footage is copied or embedded.",
  }),
  Object.freeze({
    title: "Outbreak of the First World War",
    url: "https://www.iwm.org.uk/history/first-world-war/outbreak",
    publisher: "Imperial War Museums",
    kind: "video", publishedYear: null, from: 1914, to: 1918,
    note: "Official museum explainer with video and transcript about the 1914 crisis. Online publication year is not established here; this is retrospective interpretation, not 1914 footage. External link only.",
  }),
  Object.freeze({
    title: "Royal Journey",
    url: "https://www.nfb.ca/film/royal_journey/",
    publisher: "National Film Board of Canada",
    kind: "video", publishedYear: 1951, from: 1949, to: 1957,
    note: "1951 documentary of Princess Elizabeth and the Duke of Edinburgh's tour of Canada and the United States. A period view of post-war Canada, with its original institutional perspective. Link to the official film page; no copied footage or implied reuse licence.",
  }),
  Object.freeze({
    title: "Foreign Relations of the United States — historical documents",
    url: "https://history.state.gov/historicaldocuments",
    publisher: "Office of the Historian, U.S. Department of State",
    kind: "collection", publishedYear: null, from: 1914, to: 2026,
    note: "Official documentary collection of U.S. foreign-policy decisions and diplomacy, organized by administration. A U.S. archival perspective, not an annual world map; publication lags events and coverage varies. Undated collection landing page; external link only.",
  }),
]);

export function resourcesForYear(year) {
  const selectedYear = validYear(year);
  if (selectedYear === null) return [];
  return CONTEXT_RESOURCES.filter((entry) => selectedYear >= entry.from && selectedYear <= entry.to)
    .map((entry) => ({ ...entry }));
}
