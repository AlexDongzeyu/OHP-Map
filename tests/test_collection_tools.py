"""Place discovery and explicit, private-by-default reading-list handoff."""
import json
from pathlib import Path
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _node(code):
    result = subprocess.run(
        ["node", "--input-type=module", "-e", code],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    return json.loads(result.stdout)


def test_place_index_counts_accounts_not_mentions_and_matches_the_replacement_filter():
    data = _node(r"""
globalThis.window={matchMedia:()=>({matches:false})};
const {collectionPlaces,collectionResults}=await import('./js/data.js');
const point=(canonical,asWritten=canonical)=>({canonical,asWritten,locationPrecision:'city'});
const base={hometown:'',conflicts:[],themes:[],contextualPlaces:[]};
const store={groups:[{name:'First'},{name:'Second'}],journeys:[
  {...base,id:'a',name:'A',group:'First',waypoints:[point('Łódź, Poland','Lodz'),point('Łódź, Poland'),point('London')]},
  {...base,id:'b',name:'B',group:'First',waypoints:[point('Łódź, Poland'),point('Toronto')]},
  {...base,id:'c',name:'C',group:'Second',waypoints:[point('Toronto'),point('Toronto')]},
  {...base,id:'d',name:'D',group:'First',waypoints:[],contextualPlaces:[point('Warsaw')]},
]};
const state={query:'',groupFilter:new Set(['First','Second']),placeFilter:'London',savedIds:new Set(['a'])};
const all=collectionPlaces(store,state);
const consistent=all.every(place=>collectionResults(store,{...state,placeFilter:place.name}).length===place.count);
console.log(JSON.stringify({
  all,consistent,
  saved:collectionPlaces(store,{...state,savedOnly:true}),
  shared:collectionPlaces(store,{...state,sharedIds:new Set(['b'])}),
  filtered:collectionPlaces(store,{...state,query:'B'}),
  noGroups:collectionPlaces(store,{...state,groupFilter:new Set()}),
}));
""")
    counts = {place["name"]: place["count"] for place in data["all"]}
    assert counts == {"London": 1, "Łódź, Poland": 2, "Toronto": 2}
    assert data["consistent"] and not data["noGroups"]
    assert "lodz" in next(place["searchText"] for place in data["all"] if place["name"].startswith("Ł"))
    assert {place["name"] for place in data["saved"]} == {"London", "Łódź, Poland"}
    assert all(place["count"] == 1 for place in data["shared"])
    assert {place["name"] for place in data["filtered"]} == {"Łódź, Poland", "Toronto"}


def test_shared_links_include_only_the_selected_ids_and_keep_aliases_and_missing_accounts():
    data = _node(r"""
import {collectionLink,decodeCollectionIds,accountLink} from './js/research-tools.js';
const byId=new Map([['old',{id:'canonical'}],['canonical',{id:'canonical'}],['second',{id:'second'}]]);
const url=new URL(collectionLink(['canonical','second','canonical'],
  'https://example.test/survivor/private?q=secret#/explore?saved=1&origin=Canada'));
console.log(JSON.stringify({
  url:url.href,path:url.pathname,search:url.search,hash:url.hash,
  ids:[...decodeCollectionIds(new URLSearchParams(url.hash.split('?')[1]).get('list'),byId)],
  aliases:[...decodeCollectionIds('old,canonical,not-yet-available',byId)],
  individual:accountLink({id:'canonical'},url.href),
}));
""")
    assert data["path"] == "/" and data["search"] == ""
    assert "private" not in data["url"] and "secret" not in data["url"]
    assert "saved" not in data["hash"] and "origin" not in data["hash"]
    assert data["ids"] == ["canonical", "second"]
    assert data["aliases"] == ["canonical", "not-yet-available"]
    assert data["individual"] == "https://example.test/survivor/canonical"


@pytest.mark.parametrize("value", ["", "a,,b", "<script>", "a/b", "a" * 7001])
def test_invalid_shared_links_are_explicitly_rejected(value):
    data = _node("""
import {decodeCollectionIds,CollectionLinkError} from './js/research-tools.js';
let rejected=false;
try{decodeCollectionIds(%s,new Map())}catch(error){rejected=error instanceof CollectionLinkError}
console.log(JSON.stringify({rejected}));
""" % json.dumps(value))
    assert data["rejected"]


def test_large_link_recovery_does_not_silently_truncate_the_selection():
    data = _node(r"""
import {collectionLink,CollectionLinkError} from './js/research-tools.js';
const ids=Array.from({length:1000},(_,index)=>`person-${index}`);
let error='';
try{collectionLink(ids,'https://example.test/')}catch(failure){
  if(!(failure instanceof CollectionLinkError))throw failure;error=failure.message;
}
console.log(JSON.stringify({error,count:ids.length}));
""")
    assert "download" in data["error"] and "too large" in data["error"]
    assert data["count"] == 1000


def test_adding_a_shared_list_merges_once_without_erasing_private_or_unavailable_ids():
    data = _node(r"""
import {addSavedAccounts} from './js/research-tools.js';
const byId=new Map([['old',{id:'canonical'}],['canonical',{id:'canonical'}],['second',{id:'second'}]]);
let value=JSON.stringify({version:1,ids:['private-existing','not-currently-public','old']});
let writes=0;
const storage={getItem:()=>value,setItem:(_,next)=>{writes++;value=next}};
const ids=addSavedAccounts(storage,byId,['canonical','second','second']);
console.log(JSON.stringify({writes,ids:[...ids],stored:JSON.parse(value)}));
""")
    assert data["writes"] == 1
    assert data["ids"] == ["private-existing", "not-currently-public", "canonical", "second"]
    assert data["stored"]["ids"] == data["ids"]


def test_bulk_save_failures_do_not_return_success_or_replace_existing_data():
    data = _node(r"""
import {addSavedAccounts,isSavedAccountsFailure} from './js/research-tools.js';
const original=JSON.stringify({version:1,ids:['private-existing']});
let value=original,writes=0,blocked=false,invalid=false;
const byId=new Map([['a',{id:'a'}]]);
const storage={getItem:()=>value,setItem:()=>{writes++;throw new DOMException('Blocked','QuotaExceededError')}};
try{addSavedAccounts(storage,byId,['missing'])}catch(error){invalid=isSavedAccountsFailure(error)}
try{addSavedAccounts(storage,byId,['a'])}catch(error){blocked=isSavedAccountsFailure(error)}
console.log(JSON.stringify({blocked,invalid,writes,unchanged:value===original}));
""")
    assert data == {"blocked": True, "invalid": True, "writes": 1, "unchanged": True}


def test_downloaded_sources_are_complete_citations_not_inferred_transcripts():
    data = _node(r"""
import {collectionCitations,CitationError} from './js/research-tools.js';
const journeys=[
  {name:'Amek Adler',archiveUrl:'https://ohp.crestwood.on.ca/ohp/adler-amek/'},
  {name:'Martin Baranek',archiveUrl:'https://ohp.crestwood.on.ca/ohp/baranek-martin/'},
];
let invalid=false;
try{collectionCitations([{name:'Unsupported',archiveUrl:'https://unrelated.test/'}])}
catch(error){invalid=error instanceof CitationError}
console.log(JSON.stringify({text:collectionCitations(journeys,new Date(2026,8,6,12)),invalid}));
""")
    assert '2 accounts' in data["text"]
    assert '"Amek Adler."' in data["text"] and '"Martin Baranek."' in data["text"]
    assert data["text"].count("Accessed September 6, 2026.") == 2
    assert "not verbatim transcripts" in data["text"] and "No interview dates are inferred" in data["text"]
    assert data["invalid"]
