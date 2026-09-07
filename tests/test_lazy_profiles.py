"""Compact startup loads only the selected, revision-matched account details."""
import json
from pathlib import Path
import struct
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def test_compact_model_lazy_details_cache_errors_and_evidence_counts():
    script = r"""
import fs from 'node:fs';
globalThis.window={matchMedia:()=>({matches:false})};
const raw=JSON.parse(fs.readFileSync('data/survivors.geojson','utf8'));
const originals=raw.features.filter(f=>['adam-wally','baker-norman'].includes(f.properties.survivor_id));
const details=new Map();
const index={...raw,features:originals.map(feature=>{
  const props=structuredClone(feature.properties);
  const url=`/data/profiles/${props.survivor_id}.${'a'.repeat(64)}.json`;
  details.set(url.slice(1),feature);
  for(const key of ['profile_media','bio_excerpt','contextual_places','video_source_inventory'])delete props[key];
  props.waypoints=props.waypoints.map(place=>{
    const copy={...place};delete copy.source_quote;delete copy.location_note;return copy;
  });
  props.detail_url=url;
  return {...feature,properties:props};
})};
const requests=[];
let wrong=true;
globalThis.fetch=async name=>{
  requests.push(name);
  if(name==='data/index.json')return {ok:true,json:async()=>structuredClone(index)};
  if(details.has(name)){
    await new Promise(resolve=>setTimeout(resolve,10));
    const feature=structuredClone(details.get(name));
    if(wrong&&feature.properties.survivor_id==='baker-norman')feature.properties.survivor_id='wrong';
    return {ok:true,json:async()=>feature};
  }
  if(name==='data/survivors.geojson')throw new Error('startup fetched the full archive');
  return {ok:true,json:async()=>JSON.parse(fs.readFileSync(name,'utf8'))};
};
const {loadData,evidenceCounts}=await import('./js/data.js');
const store=await loadData({compact:true});
const startup=[...requests];
const wally=store.byId.get('adam-wally');
const before={state:wally.detailState,bio:wally.bio,videos:wally.media.videos.length};
wally.waypoints[0].px=42;wally.waypoints[0].py=84;
await Promise.all([store.loadProfile(wally.id),store.loadProfile(wally.id)]);
await store.loadProfile(wally.id);
const wallyCalls=requests.filter(name=>name.includes('/adam-wally.')).length;
let rejected=false;
try{await store.loadProfile('baker-norman')}catch(error){rejected=/match/.test(error.message)}
const failed=store.byId.get('baker-norman').detailState;
wrong=false;await store.loadProfile('baker-norman');
const counts=evidenceCounts(wally);
console.log(JSON.stringify({
  startup,before,wallyCalls,identity:wally===store.byId.get('adam-wally'),
  loaded:wally.detailState,bio:wally.bio.length,videos:wally.media.videos.length,pixel:wally.waypoints[0].px,
  rejected,failed,retried:store.byId.get('baker-norman').detailState,
  counts,hasSource:wally.sourceProperties.waypoints.some(place=>place.source_quote),
}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    data = json.loads(result.stdout)
    assert data["startup"] == ["data/index.json", "data/war_context.json", "data/historical_boundary_index.json"]
    assert data["before"] == {"state": "unloaded", "bio": "", "videos": 0}
    assert data["wallyCalls"] == 1
    assert data["identity"]
    assert data["loaded"] == data["retried"] == "ready"
    assert data["bio"] > 100 and data["videos"] > 0 and data["hasSource"]
    assert data["pixel"] == 42
    assert data["rejected"] and data["failed"] == "error"
    counts = data["counts"]
    assert counts["route"] + counts["broad"] + counts["review"] == counts["total"]


def test_spelling_suggestions_offer_real_archive_terms_without_changing_query():
    script = r"""
import fs from 'node:fs';
globalThis.window={matchMedia:()=>({matches:false})};
globalThis.fetch=async name=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(name,'utf8'))});
const {loadData,searchSuggestions}=await import('./js/data.js');
const store=await loadData();
const state={query:'aushwitz',groupFilter:new Set(store.groups.map(group=>group.name))};
console.log(JSON.stringify({suggestions:searchSuggestions(store,state),query:state.query}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    data = json.loads(result.stdout)
    assert "Auschwitz" in data["suggestions"]
    assert data["query"] == "aushwitz"


def test_server_profile_navigation_uses_supported_routes_and_exposes_recovery():
    script = r"""
import fs from 'node:fs';
import {renderProfileHtml,renderErrorHtml} from './worker/profile-pages.js';
const feature=JSON.parse(fs.readFileSync('data/survivors.geojson','utf8')).features[0];
const html=renderProfileHtml('<html><head></head><body></body></html>',feature);
console.log(JSON.stringify({
  links:[...`${html}${renderErrorHtml(404)}`.matchAll(/href="\/#([^"]+)"/g)].map(match=>match[1]),
  id:html.includes(`data-survivor-id="${feature.properties.survivor_id}"`),
  retry:html.includes('data-server-profile-retry hidden'),
  status:html.includes('data-server-profile-status role="status"'),
  catalogue:html.includes('href="/collection"')&&renderErrorHtml(404).includes('href="/collection"'),
}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    data = json.loads(result.stdout)
    assert data["links"] == ["/explore"]
    assert data["id"] and data["retry"] and data["status"] and data["catalogue"]


def test_social_previews_use_licensed_originals_or_a_large_raster_fallback():
    script = r"""
import fs from 'node:fs';
import {renderProfileHtml} from './worker/profile-pages.js';
const feature=JSON.parse(fs.readFileSync('data/survivors.geojson','utf8')).features
  .find(feature=>feature.properties.survivor_id==='adler-amek');
const shell='<html><head></head><body></body></html>';
const image=html=>/property="og:image" content="([^"]+)"/.exec(html)[1];
const original=image(renderProfileHtml(shell,feature));
feature.properties.portrait_rights='All rights reserved; no reuse permission';
const denied=renderProfileHtml(shell,feature);
console.log(JSON.stringify({original,fallback:image(denied),dimensions:denied.includes('content="1200"')&&denied.includes('content="630"')}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    data = json.loads(result.stdout)
    assert data["original"].startswith("https://ohp.crestwood.on.ca/wp-content/uploads/")
    assert data["fallback"].endswith("/assets/social-preview.png")
    assert data["dimensions"]
    assert struct.unpack(">II", (ROOT / "assets/social-preview.png").read_bytes()[16:24]) == (1200, 630)
