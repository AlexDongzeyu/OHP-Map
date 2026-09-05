const HISTORICAL_IDENTITIES = [
  [/^(?:East Germany|German Democratic Republic|Deutsche Demokratische Republik)$/i, "East Germany"],
  [/^(?:West Germany|Federal Republic of Germany)$/i, "West Germany"],
  [/^(?:Soviet Union|USSR)$/i, "Soviet Union"],
  [/^Russian Empire$/i, "Russian Empire"],
  [/^Austria-Hungary$/i, "Austria-Hungary"],
  [/^Ottoman Empire$/i, "Ottoman Empire"],
  [/^Czechoslovak(?:ia| Republic| Federative Republic| Socialist Republic)$/i, "Czechoslovakia"],
  [/^Siam$/i, "Siam"],
  [/^Persia$/i, "Persia"],
];

const GROUPS = [
  ["Canada", /^(?:Dominion of )?Canada$/i],
  ["Australia", /^Australia$/i],
  ["New Zealand", /^(?:Dominion of )?New Zealand$/i],
  ["South Africa", /^(?:Union of )?South Africa$/i],
  ["United States of America", /^(?:United States|US Philippines)$|\bAmerican occupation\b/i],
  ["Germany", /\b(?:German|Germany|Deutsche|Kiautschou|Nazi)\b/i],
  ["France", /\bFrench\b|^France$|^French Republic$|^Indochinese (?:Union|Federation)$|^Kwangchowan$|^La Réunion$|^Upper Senegal and Niger$|^Ubangi-Shari-Chad$|^Protectorate of Mauritania$|^Colony of Madagascar and Dependencies$|^Fezzan-Ghadames Military Territory$/i],
  ["United Kingdom", /\bBritish\b|^United Kingdom|^Crown Colony|^Rhodesia$|^Northern Rhodesia$|^Nyasaland|^Gold Coast|^Trucial States$|^Anglo-Egyptian Sudan$|^Tanganyika Territory$|^Bechuanaland Protectorate$|^Colony and Protectorate of Nigeria$|^(?:Dominion of |Commission Government of )Newfoundland$/i],
  ["Italy", /\bItalian\b|^Italy$|^Kingdom of Italy$/i],
  ["Japan", /\bJapan(?:ese)?\b|^Manchukuo$|^State of Burma$/i],
  ["Netherlands", /\bDutch\b|^Kingdom of the Netherlands$|^Netherlands$/i],
  ["Belgium", /\bBelgian\b|^Belgium$/i],
  ["Portugal", /\bPortuguese\b|^Portugal$|^(?:Province|Colony) of Mozambique$/i],
  ["Spain", /\bSpanish\b|^Spain$/i],
  ["Russia", /^Russia$/i],
  ["Turkey", /^Turkey$/i],
  ["Austria", /^Austria$/i],
  ["Iran", /^Iran$/i],
  ["Thailand", /^Thailand$/i],
  ["Egypt", /^(?:Kingdom|Sultanate) of Egypt$|^Egypt$/i],
  ["Afghanistan", /^(?:Kingdom|Emirate|Protectorate) of Afghanistan$|^Afghanistan$/i],
  ["Pakistan", /^Dominion of Pakistan$|^Pakistan$/i],
  ["Myanmar", /^Burma$|^Myanmar$/i],
  ["China", /^China$|^(?:People's )?Republic of China$/i],
  ["Poland", /^Poland$|^Republic of Poland$/i],
  ["Romania", /^Kingdom of Romania$|^Romania$/i],
  ["Greece", /^Kingdom of Greece$|^Greece$/i],
  ["Bulgaria", /^(?:Tsardom|Kingdom|People's Republic|Republic) of Bulgaria$|^Bulgaria$/i],
];

export function historicalIdentity(name) {
  const historical = HISTORICAL_IDENTITIES.find(([pattern]) => pattern.test(name));
  if (historical) return { controller: historical[1], controller_basis: "historical_name" };
  const group = GROUPS.find(([, pattern]) => pattern.test(name));
  return {
    controller: group?.[0] || name,
    controller_basis: group && group[0] !== name ? "name_grouping" : "source_name",
  };
}

export function alignmentKey(controller) {
  return {
    "Soviet Union": "Russia",
    "Russian Empire": "Russia",
    "Austria-Hungary": "Austria",
    "Ottoman Empire": "Turkey",
    "Czechoslovakia": "Czechia",
    "Persia": "Iran",
    "Siam": "Thailand",
    "West Germany": "Germany",
  }[controller] || controller;
}

export function datedTerritories(features, year) {
  const instant = year + .5;
  const selected = new Map();
  for (const feature of features) {
    const p = feature.properties;
    if (p.start > instant || (p.end != null && p.end <= instant)) continue;
    const key = p.geometry_key
      ? `${p.name}|${p.controller}|${p.kind || ""}|${p.geometry_key}`
      : `record:${p.id}`;
    const existing = selected.get(key);
    if (!existing || p.start > existing.properties.start) selected.set(key, feature);
  }
  return [...selected.values()];
}
