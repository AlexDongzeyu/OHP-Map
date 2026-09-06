"""Stable source-reference links and transparent, scoped related reading."""
import json
from pathlib import Path
import subprocess

from pipeline.review_decisions import source_fingerprint


ROOT = Path(__file__).resolve().parents[1]


def _node(code):
    result = subprocess.run(
        ["node", "--input-type=module", "-e", code],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    return json.loads(result.stdout)


def test_browser_reference_keys_match_every_existing_review_fingerprint():
    data = json.loads((ROOT / "data/survivors.geojson").read_text(encoding="utf-8"))
    expected = [
        source_fingerprint(feature["properties"], point)
        for feature in data["features"]
        for collection in ("waypoints", "contextual_places")
        for point in feature["properties"].get(collection, [])
    ]
    actual = _node(r"""
import fs from 'node:fs';
import {sourceReferenceTargets} from './js/reference-links.js';
const data=JSON.parse(fs.readFileSync('data/survivors.geojson','utf8'));
const keys=[];
for(const feature of data.features)keys.push(...(await sourceReferenceTargets(feature.properties)).map(target=>target.key));
console.log(JSON.stringify(keys));
""")
    assert len(expected) > 3800
    assert actual == expected


def test_reference_identity_survives_reordering_and_reclassification_but_not_source_changes():
    data = _node(r"""
import fs from 'node:fs';
import {sourceReferenceTargets,sourceReferenceKey} from './js/reference-links.js';
const account=JSON.parse(fs.readFileSync('data/survivors.geojson','utf8')).features
 .find(feature=>feature.properties.survivor_id==='adam-wally').properties;
const original=account.waypoints[0];
const key=await sourceReferenceKey(account,original);
const reclassified={...original,verified:true,confidence:1,evidence:{scope:'contextual'}};
const same=await sourceReferenceKey(account,reclassified);
const moved={...account,waypoints:account.waypoints.slice(1).reverse(),contextual_places:[reclassified]};
const matches=(await sourceReferenceTargets(moved)).filter(target=>target.key===key);
const changed=await sourceReferenceKey(account,{...original,source_quote:original.source_quote+' Changed source.'});
const corrected=await sourceReferenceKey(account,{...original,lat:original.lat+.01});
console.log(JSON.stringify({same:key===same,matches:matches.map(({collection,index})=>({collection,index})),changed:key!==changed,corrected:key!==corrected}));
""")
    assert data["same"] and data["changed"] and data["corrected"]
    assert data["matches"] == [{"collection": "contextual_places", "index": 0}]


def test_reference_links_are_clean_and_invalid_or_ambiguous_targets_are_detectable():
    data = _node(r"""
import fs from 'node:fs';
import {referenceLink,isReferenceKey,sourceReferenceTargets,sourceReferenceKey,ReferenceLinkError} from './js/reference-links.js';
const account=JSON.parse(fs.readFileSync('data/survivors.geojson','utf8')).features[0].properties;
const key=await sourceReferenceKey(account,account.waypoints[0]);
const url=new URL(referenceLink({id:account.survivor_id},key,'https://example.test/survivor/private?q=private#/explore?list=private&saved=1'));
const duplicate={...account,waypoints:[account.waypoints[0],account.waypoints[0]],contextual_places:[]};
let invalid=false;
try{await sourceReferenceKey(account,{...account.waypoints[0],lat:null})}
catch(error){invalid=error instanceof ReferenceLinkError}
console.log(JSON.stringify({
  path:url.pathname,hash:url.hash,keys:[...url.searchParams.keys()],value:url.searchParams.get('ref'),
  valid:isReferenceKey(key),bad:isReferenceKey('<script>'),
  duplicate:(await sourceReferenceTargets(duplicate)).filter(target=>target.key===key).length,invalid,
}));
""")
    assert data["path"].startswith("/survivor/")
    assert data["hash"] == "" and data["keys"] == ["ref"]
    assert data["valid"] and not data["bad"] and data["invalid"]
    assert data["value"].startswith("sha256:") and data["duplicate"] == 2


def test_related_reading_uses_distinct_specific_places_within_current_results():
    data = _node(r"""
globalThis.window={matchMedia:()=>({matches:false})};
const {relatedAccounts}=await import('./js/data.js');
const point=(canonical,locationPrecision='city')=>({canonical,locationPrecision,asWritten:canonical});
const base={hometown:'',conflicts:[],themes:[],group:'First',captionedVideoCount:0,contextualPlaces:[]};
const journeys=[
 {...base,id:'a',name:'A',waypoints:[point('Toronto'),point('Birkenau','site'),point('Canada','country')]},
 {...base,id:'b',name:'B',captionedVideoCount:1,waypoints:[point('Toronto'),point('Toronto')]},
 {...base,id:'c',name:'C',waypoints:[point('Toronto'),point('Birkenau','site')]},
 {...base,id:'d',name:'D',waypoints:[point('Canada','country')]},
 {...base,id:'e',name:'E',waypoints:[],contextualPlaces:[point('Toronto')]},
];
const store={journeys,byId:new Map(journeys.map(j=>[j.id,j])),groups:[{name:'First'}]};
const state={selectedId:'a',query:'',groupFilter:new Set(['First']),savedIds:new Set(['a','b'])};
console.log(JSON.stringify({
 all:relatedAccounts(store,state).map(match=>({id:match.journey.id,places:match.places})),
 saved:relatedAccounts(store,{...state,savedOnly:true}).map(match=>match.journey.id),
 shared:relatedAccounts(store,{...state,sharedIds:new Set(['a','c'])}).map(match=>match.journey.id),
 captions:relatedAccounts(store,{...state,captionedOnly:true}).map(match=>match.journey.id),
 none:relatedAccounts(store,{...state,selectedId:'d'}).length,
}));
""")
    assert data["all"] == [
        {"id": "c", "places": ["Toronto", "Birkenau"]},
        {"id": "b", "places": ["Toronto"]},
    ]
    assert data["saved"] == ["b"] and data["shared"] == ["c"] and data["captions"] == ["b"]
    assert data["none"] == 0
