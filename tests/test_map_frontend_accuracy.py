"""Runtime accuracy gates, independent of source extraction implementation."""
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def test_uncertain_broad_and_contextual_mentions_are_not_asserted_as_precise_routes():
    script = r"""
import fs from 'node:fs';
globalThis.window = {matchMedia: () => ({matches:false})};
globalThis.fetch = async (name) => ({
  ok:true,
  json:async () => JSON.parse(fs.readFileSync(name, 'utf8')),
});
const {loadData} = await import('./js/data.js');
const store = await loadData();
const norman=store.byId.get('baker-norman');
const wally=store.byId.get('adam-wally');
const routeErrors=store.journeys.flatMap(person => person.routeWaypoints
  .filter(place => (
    (!place.verified && place.evidenceScope!=='personal') ||
    ['country','region'].includes(place.locationPrecision)
  )).map(place => person.id+':'+place.canonical));
const eventErrors=store.events.filter(event => event.people.some(person => {
  const journey=store.byId.get(person.id);
  return !journey.waypoints.some(place => place.canonical===event.place &&
    place.historyYear===event.year && place.evidenceScope==='personal');
}));
console.log(JSON.stringify({
  routeErrors,eventErrors:eventErrors.length,
  norman:{born:norman.born,start:norman.routeStart?.canonical,context:norman.contextualPlaces.map(p=>p.canonical)},
  wally:{routes:wally.routeWaypoints.map(p=>p.canonical),ottawa:wally.waypoints.find(p=>p.canonical==='Ottawa, Canada')},
  billCanadaEvents:store.events.filter(e=>e.place==='Canada'&&e.people.some(p=>p.id==='duncan-bill')).length,
  unassignedHistoricalRegions:store.journeys.filter(j=>j.routeStart?.canonical==='Palestine (historical region)').every(j=>j.originCountry===null),
}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    data = json.loads(result.stdout)
    assert data["routeErrors"] == []
    assert data["eventErrors"] == 0
    assert data["norman"]["born"] == 1916
    assert data["norman"]["start"] == "Toronto, Canada"
    assert "England" in data["norman"]["context"]
    assert "Tanzania" not in data["wally"]["routes"]
    assert data["wally"]["ottawa"]["historyYear"] is None
    assert data["wally"]["ottawa"]["dateAsWritten"] == "80s"
    assert data["billCanadaEvents"] == 0
    assert data["unassignedHistoricalRegions"]


def test_collection_predicate_matches_source_names_accents_and_exact_origins():
    script = r"""
globalThis.window = {matchMedia: () => ({matches:false})};
const {journeyFilter} = await import('./js/data.js');
const groups = new Set(['Military Veterans', 'Community Members']);
const base = {
  name:'Leon', hometown:'Toronto', group:'Military Veterans',
  conflicts:[], themes:[], originCountry:'Canada', waypoints:[],
};
const people = [
  {...base, id:'origin', name:'Leon', originCountry:'Canada'},
  {...base, id:'mention', name:'Other', originCountry:'France',
    waypoints:[{canonical:'Toronto, Canada', asWritten:'Toronto'}]},
  {...base, id:'spelling', name:'Léon', group:'Community Members',
    waypoints:[{canonical:'Lviv, Ukraine', asWritten:'Lemberg'}]},
];
const filter = (state) => people.filter(journeyFilter({groupFilter:groups, ...state})).map(p=>p.id);
console.log(JSON.stringify({
  origin:filter({originCountry:'Canada'}),
  accent:filter({query:'leon'}),
  spelling:filter({query:'lemberg'}),
  empty:filter({groupFilter:new Set()}),
  combined:filter({originCountry:'Canada',query:'lemberg',groupFilter:new Set(['Community Members'])}),
}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    data = json.loads(result.stdout)
    assert data["origin"] == ["origin", "spelling"]
    assert data["accent"] == ["origin", "spelling"]
    assert data["spelling"] == ["spelling"]
    assert data["empty"] == []
    assert data["combined"] == ["spelling"]
