const SEARCH_FOLDS = {
  "\u0142": "l", "\u00f8": "o", "\u0111": "d", "\u00f0": "d", "\u0127": "h",
  "\u0131": "i", "\u00df": "ss", "\u00e6": "ae", "\u0153": "oe", "\u00fe": "th",
};

export function normalizeSearch(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[\u0142\u00f8\u0111\u00f0\u0127\u0131\u00df\u00e6\u0153\u00fe]/g, letter => SEARCH_FOLDS[letter]).trim();
}

export function searchValue(value) {
  return normalizeSearch(value).replace(/['\u2018\u2019\u02bc]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function searchParts(query) {
  const text = String(query || "").replace(/[\u201c\u201d]/g, '"');
  return [...text.matchAll(/"([^"]*)"?|(\S+)/g)].map(match => {
    const value = searchValue(match[1] ?? match[2]);
    const quoted = match[1] !== undefined;
    return {
      value, quoted, start: match.index, end: match.index + match[0].length,
      phrase: quoted ? new RegExp(`(?:^|\\s)${value}(?=\\s|$)`, "u") : null,
    };
  }).filter(part => part.value);
}

export function matchesSearchPart(text, part) {
  return part.phrase ? part.phrase.test(text) : text.includes(part.value);
}
