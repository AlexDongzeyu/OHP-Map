import { ID_PATTERN, siteOrigin, xmlEscape as esc } from "./publication.js";
import { RELEASE_HASH_PATTERN, rewriteStaticHtml } from "./static-assets.js";
import { searchValue, searchParts, matchesSearchPart } from "../js/search-query.js";

export const SOURCE_CATALOGUE_PATH = "/data/source-catalogue.json";
const PAGE_SIZE = 40;

export function buildSourceCatalogue(features, release = null) {
  const entries = features.map(({ properties }) => ({
    id: properties.survivor_id,
    name: properties.name,
    group: properties.group || "Recorded accounts",
    search: [
      properties.name, properties.group, ...(properties.conflicts || []), ...(properties.theme_tags || []),
      ...(properties.waypoints || []).flatMap(place => [place.canonical, place.as_written]),
    ].map(searchValue).filter(Boolean).join("\n"),
  })).sort((a, b) => a.name.localeCompare(b.name, "en-CA") || a.id.localeCompare(b.id));
  return { format: 1, release, entries };
}

function catalogueAddress(query, group, page = 1) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (group) params.set("group", group);
  if (page !== 1) params.set("page", String(page));
  return `/collection${params.size ? `?${params}` : ""}`;
}

export function renderSourceCatalogue(catalogue, address, origin) {
  if (catalogue?.format !== 1 || (catalogue.release != null && !RELEASE_HASH_PATTERN.test(catalogue.release)) ||
      !Array.isArray(catalogue.entries) || catalogue.entries.some(entry =>
        !entry || typeof entry.id !== "string" || !ID_PATTERN.test(entry.id) ||
        !["name", "group", "search"].every(key => typeof entry[key] === "string")) ||
      new Set(catalogue.entries.map(entry => entry.id)).size !== catalogue.entries.length) {
    throw new Error("The published source catalogue is invalid.");
  }
  const params = new URL(address).searchParams;
  const query = params.get("q") || "", group = params.get("group") || "";
  const rawPage = params.has("page") ? params.get("page") : "1";
  const page = Number(rawPage);
  const groups = [...new Set(catalogue.entries.map(entry => entry.group))].sort((a, b) => a.localeCompare(b));
  const invalid = query.length > 200 || (group && !groups.includes(group)) ||
    !/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(page) ||
    [...params.keys()].some(key => !["q", "group", "page"].includes(key) || params.getAll(key).length !== 1);
  const parts = searchParts(query);
  const matches = invalid ? [] : catalogue.entries.filter(entry =>
    (!group || entry.group === group) && (!query.trim() || parts.length && parts.every(part => matchesSearchPart(entry.search, part))));
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const missing = !invalid && page > pages;
  const status = invalid ? 400 : missing ? 404 : 200;
  const entries = status === 200 ? matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : [];
  const title = "Source catalogue | Crestwood Oral History Project";
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="description" content="Browse public oral history accounts without loading the interactive map.">
<link rel="canonical" href="${esc(siteOrigin(origin) + catalogueAddress(query, group, status === 200 ? page : 1))}">
${params.size ? '<meta name="robots" content="noindex,follow">' : ""}
<link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/source-catalogue.css">
</head><body class="source-catalogue">
<a class="catalogue-skip" href="#catalogue-results">Skip to accounts</a>
<header><a class="catalogue-brand" href="/">Journeys</a><nav aria-label="Archive navigation"><a href="/#/explore">Interactive collection</a>
<a href="https://ohp.crestwood.on.ca/" rel="noopener">Original OHP archive</a></nav></header>
<main>
<h1>Source catalogue</h1>
<p class="catalogue-intro">Read accounts without loading the map. This edition of the catalogue contains ${catalogue.entries.length.toLocaleString("en-CA")} accounts.
The interactive collection may have more recent source updates.</p>
<form action="/collection#catalogue-results" method="get" class="catalogue-search">
<label>Find an account<input name="q" type="search" maxlength="200" value="${esc(query)}" placeholder="Name, place or period" aria-describedby="catalogue-search-help"></label>
<label>Community<select name="group"><option value="">All communities</option>${groups.map(name =>
    `<option value="${esc(name)}"${name === group ? " selected" : ""}>${esc(name)}</option>`).join("")}</select></label>
<button type="submit">Search</button></form>
<p id="catalogue-search-help">Every word must match. Double quotes keep a phrase together. Search covers recorded names, places, periods and topics, not complete transcripts.</p>
<section id="catalogue-results" tabindex="-1" aria-labelledby="catalogue-result-title">
<h2 id="catalogue-result-title">${invalid ? "This catalogue address is not supported" : missing ? "This results page is not available"
    : `${matches.length.toLocaleString("en-CA")} ${matches.length === 1 ? "account" : "accounts"}${query || group ? " found" : ""}`}</h2>
${status !== 200 ? `<p>${invalid ? "Keep searches to 200 characters or fewer. Choose one of the listed communities and use a whole page number of 1 or higher."
    : "The selected page is outside these results."}</p><a href="${esc(catalogueAddress(query.length <= 200 ? query : "", groups.includes(group) ? group : ""))}">Return to the first results page</a>`
    : entries.length ? `<ul class="catalogue-accounts">${entries.map(entry =>
      `<li><a href="/survivor/${esc(entry.id)}?reader=source"><span>${esc(entry.name)}</span><small>${esc(entry.group)}</small></a></li>`).join("")}</ul>`
      : '<p>No accounts in this edition match every search term. Try fewer words, another spelling or a different community.</p>'}
${status === 200 && pages > 1 ? `<nav class="catalogue-pages" aria-label="Results pages">
${page > 1 ? `<a rel="prev" href="${esc(catalogueAddress(query, group, page - 1))}#catalogue-results">Previous</a>` : "<span></span>"}
<span>Page ${page} of ${pages}</span>
${page < pages ? `<a rel="next" href="${esc(catalogueAddress(query, group, page + 1))}#catalogue-results">Next</a>` : "<span></span>"}</nav>` : ""}
${query || group || status !== 200 ? '<p><a href="/collection">Show all source accounts</a></p>' : ""}
</section>
<footer>Written biographies and mapped references are not verbatim interview transcripts. The interactive maps require JavaScript;
this catalogue and the source account pages do not.</footer>
</main></body></html>`;
  return { body: rewriteStaticHtml(body, catalogue.release, siteOrigin(origin)), status };
}
