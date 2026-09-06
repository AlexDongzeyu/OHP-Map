"""Research queries combine metadata without inventing evidence or widening scope."""
import json

import pytest

from test_collection_tools import _node


SETUP = r"""
globalThis.window={matchMedia:()=>({matches:false})};
const {journeyFilter,collectionResults,collectionPlaces,searchMatchLabels,searchSuggestions}=await import('./js/data.js');
const point=(canonical,asWritten=canonical)=>({canonical,asWritten,locationPrecision:'city'});
const base={hometown:'',conflicts:[],themes:[],initials:'AA',portrait:null,waypoints:[],routeWaypoints:[],videoCount:0,captionedVideoCount:0};
const store={groups:[{name:'First',count:3},{name:'Second',count:3}],journeys:[
 {...base,id:'adler',name:'Amek Adler',group:'First',originCountry:'Poland',captionedVideoCount:2,
  conflicts:['Second World War'],themes:['Displacement'],
  waypoints:[point('Warsaw, Poland'),point('Auschwitz (Oswiecim), Poland'),point('Toronto, Canada'),point('Lviv, Ukraine','Lemberg')]},
 {...base,id:'another-adler',name:'Sophie Adler',group:'First',originCountry:'Poland',waypoints:[point('Warsaw, Poland')]},
 {...base,id:'opray',name:'Gerry O\u2019Pray',group:'Second',waypoints:[point('\u0141\u00f3d\u017a, Poland','Lodz')]},
 {...base,id:'split',name:'New',hometown:'York',group:'Second'},
 {...base,id:'phrase',name:'A person',group:'First',waypoints:[point('New York, United States')]},
 {...base,id:'prefix',name:'New Yorker',group:'Second'},
]};
const state={query:'',groupFilter:new Set(['First','Second']),savedIds:new Set(['another-adler'])};
const ids=(query,extra={})=>collectionResults(store,{...state,query,...extra}).map(journey=>journey.id);
"""


@pytest.mark.parametrize("query,expected", [
    ("Adler Amek", ["adler"]),
    ("Adler, Amek", ["adler"]),
    ("Adler Auschwitz", ["adler"]),
    ("Toronto Warsaw", ["adler"]),
    ('"Second World War" Warsaw', ["adler"]),
    ("displacement adler", ["adler"]),
    ("Gerry O'Pray", ["opray"]),
    ("OPray Gerry", ["opray"]),
    ("LODZ", ["opray"]),
    ("New York", ["phrase", "split", "prefix"]),
    ('"New York"', ["phrase"]),
    ('"new yorker"', ["prefix"]),
    ('"Adl"', []),
    ("Adl", ["adler", "another-adler"]),
    ("\u201cNew York\u201d", ["phrase"]),
    ('"New York', ["phrase"]),
    ('"New York" Warsaw', []),
    ("!!!", []),
    ('""', []),
])
def test_query_terms_and_phrases_use_only_matching_source_fields(query, expected):
    data = _node(SETUP + f"console.log(JSON.stringify(ids({json.dumps(query)})));")
    assert data == expected


def test_composed_queries_intersect_every_existing_collection_scope():
    data = _node(SETUP + r"""
console.log(JSON.stringify({
 saved:ids('Adler Warsaw',{savedOnly:true}),
 shared:ids('Adler Warsaw',{sharedIds:new Set(['adler'])}),
 captions:ids('Adler Warsaw',{captionedOnly:true}),
 origin:ids('Adler Warsaw',{originCountry:'Canada'}),
 place:ids('Adler Warsaw',{placeFilter:'Toronto, Canada'}),
 groups:ids('Adler Warsaw',{groupFilter:new Set(['Second'])}),
 none:ids('Adler Warsaw',{groupFilter:new Set()}),
 places:collectionPlaces(store,{...state,query:'Adler Toronto'}).map(place=>[place.name,place.count]),
}));
""")
    assert data["saved"] == ["another-adler"]
    assert data["shared"] == data["captions"] == data["place"] == ["adler"]
    assert data["origin"] == data["groups"] == data["none"] == []
    assert len(data["places"]) == 4 and all(count == 1 for _, count in data["places"])


def test_match_reasons_cover_distinct_terms_and_preserve_source_spelling():
    data = _node(SETUP + r"""
const person=store.journeys[0],before=JSON.stringify(person);
console.log(JSON.stringify({
 places:searchMatchLabels(person,'Warsaw Toronto'),
 alias:searchMatchLabels(person,'Lemberg'),
 period:searchMatchLabels(person,'"Second World War"'),
 topic:searchMatchLabels(person,'Displacement'),
 name:searchMatchLabels(person,'Adler Amek'),
 untouched:before===JSON.stringify(person),
}));
""")
    assert data["places"] == ["Warsaw, Poland", "Toronto, Canada"]
    assert data["alias"] == ["Lemberg (Lviv, Ukraine)"]
    assert data["period"] == ["Period: Second World War"]
    assert data["topic"] == ["Topic: Displacement"]
    assert not data["name"] and data["untouched"]


def test_spelling_suggestions_keep_the_other_words_and_collection_scope():
    data = _node(SETUP + r"""
const query='Adler aushwitz';
const suggestions=searchSuggestions(store,{...state,query});
console.log(JSON.stringify({
 suggestions,
 valid:suggestions.every(value=>ids(value).length>0&&value.startsWith('Adler ')),
 saved:searchSuggestions(store,{...state,query,savedOnly:true}),
 shared:searchSuggestions(store,{...state,query,sharedIds:new Set(['another-adler'])}),
 query,
}));
""")
    assert "Adler Auschwitz" in data["suggestions"]
    assert data["valid"] and data["query"] == "Adler aushwitz"
    assert data["saved"] == data["shared"] == []


def test_search_result_explanations_escape_source_labels():
    data = _node(SETUP + r"""
const ui=await import('./js/ui.js');
store.journeys[0].waypoints=[point('<img src=x onerror=alert(1)>')];
const result=ui.railInner(store,{...state,query:'img',selectedId:null});
console.log(JSON.stringify({
 escaped:result.html.includes('Matches: &lt;img src=x onerror=alert(1)&gt;'),
 injected:result.html.includes('<img src=x'),
 count:result.total,
}));
""")
    assert data["escaped"] and not data["injected"] and data["count"] == 1


def test_real_archive_combines_names_places_and_cached_terms_without_details():
    data = _node(r"""
import fs from 'node:fs';
globalThis.window={matchMedia:()=>({matches:false})};
const requests=[];
globalThis.fetch=async name=>{
 requests.push(name);
 return {ok:true,json:async()=>JSON.parse(fs.readFileSync(name,'utf8'))};
};
const {loadData,collectionResults}=await import('./js/data.js');
const store=await loadData();
const state={groupFilter:new Set(store.groups.map(group=>group.name))};
const match=query=>collectionResults(store,{...state,query}).map(journey=>journey.id);
const normal=match('Amek Adler'),reversed=match('Adler Amek'),mixed=match('Adler Auschwitz');
const combined=match('Warsaw Toronto'),warsaw=new Set(match('Warsaw')),toronto=new Set(match('Toronto'));
const before=requests.length;
for(const journey of store.journeys){
 Object.defineProperty(journey,'waypoints',{get(){throw new Error('Search rebuilt source fields')}});
}
console.log(JSON.stringify({
 normal,reversed,mixed,combined,
 intersection:combined.every(id=>warsaw.has(id)&&toronto.has(id)),
 cached:match('Toronto Warsaw'),
 lazy:requests.length===before,
}));
""")
    assert data["normal"] == data["reversed"] == ["adler-amek"]
    assert "adler-amek" in data["mixed"]
    assert data["combined"] and data["combined"] == data["cached"]
    assert data["intersection"] and data["lazy"]
