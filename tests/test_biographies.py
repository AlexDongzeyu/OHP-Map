"""Full biographies remain on demand, source-bound and distinct from excerpts."""
import json
from pathlib import Path
import subprocess

import pytest

from test_archive_publication import PUBLICATION_SETUP
from test_worker_media import _worker


ROOT = Path(__file__).resolve().parents[1]


def test_profile_biography_is_source_bound_and_conditionally_cached():
    result = _worker(PUBLICATION_SETUP + r"""
const feature=makeFeature('person',{source_biography:'The complete source biography. A second source sentence.'});
const env=await bindings(archive([feature]));
const index=JSON.parse(env.bodies.get('/data/index.json'));
const detail=index.features[0].properties.detail_url;
const hash=detail.match(/\.([a-f0-9]{64})\.json$/)[1];
const path=`https://test.local/data/biographies/person.${hash}.json`;
const response=await entry.fetch(new Request(path),env,{});
const body=await response.json(),etag=response.headers.get('etag');
const cached=await entry.fetch(new Request(path,{headers:{'if-none-match':etag}}),env,{});
const head=await entry.fetch(new Request(path,{method:'HEAD'}),env,{});
const post=await entry.fetch(new Request(path,{method:'POST'}),env,{});
console.log(JSON.stringify({body,status:response.status,cache:response.headers.get('cache-control'),cached:cached.status,head:head.status,headBody:await head.text(),post:post.status,hash}));
""")
    assert result["status"] == result["head"] == 200
    assert result["body"]["text"].startswith("The complete source biography.")
    assert result["body"]["profile_hash"] == result["hash"]
    assert result["body"]["survivor_id"] == "person"
    assert result["body"]["provenance"] == "profile_snapshot"
    assert result["cache"] == "public, max-age=0, must-revalidate"
    assert result["cached"] == 304 and result["headBody"] == "" and result["post"] == 405


@pytest.mark.parametrize("kind,status", [("matching", 200), ("wrong-source", 404), ("wrong-excerpt", 409), ("excerpt-only", 404), ("missing", 404)])
def test_bundled_biography_requires_the_matching_source_and_excerpt(kind, status):
    result = _worker(PUBLICATION_SETUP + r"""
const feature=makeFeature('person');
const env=await bindings(archive([feature]));
if(payload!=='missing')env.bodies.set('/data/biographies/person.json',JSON.stringify({
 source_url:payload==='wrong-source'?'https://ohp.crestwood.on.ca/ohp/another/':feature.properties.archive_url,
 excerpt:payload==='wrong-excerpt'?'Different source excerpt.':feature.properties.bio_excerpt,
 text:'A longer original public biography, not the short map introduction.',
 kind:payload==='excerpt-only'?'excerpt':'source_biography',
}));
const index=JSON.parse(env.bodies.get('/data/index.json'));
const hash=index.features[0].properties.detail_url.match(/\.([a-f0-9]{64})\.json$/)[1];
const response=await entry.fetch(new Request(`https://test.local/data/biographies/person.${hash}.json`),env,{});
const internal=await entry.fetch(new Request('https://test.local/data/biographies/person.json'),env,{});
const unknown=await entry.fetch(new Request('https://test.local/data/biographies/person.'+'f'.repeat(64)+'.json'),env,{});
console.log(JSON.stringify({status:response.status,body:await response.json(),internal:internal.status,unknown:unknown.status}));
""", kind)
    assert result["status"] == status
    assert result["internal"] == result["unknown"] == 404
    if status == 200:
        assert result["body"]["provenance"] == "bundled_source_snapshot"
        assert "longer original public biography" in result["body"]["text"]
    else:
        assert "error" in result["body"]


def test_reader_loads_full_biography_only_on_demand_and_rejects_wrong_identity():
    script = r"""
import fs from 'node:fs';
globalThis.window={matchMedia:()=>({matches:false})};
const raw=JSON.parse(fs.readFileSync('data/survivors.geojson','utf8'));
const original=raw.features.find(f=>f.properties.survivor_id==='ferguson-george');
const feature=structuredClone(original);
delete feature.properties.source_biography;
const hash='a'.repeat(64),detail=`/data/profiles/ferguson-george.${hash}.json`;
const props=structuredClone(feature.properties);
delete props.profile_media;delete props.bio_excerpt;delete props.contextual_places;
props.detail_url=detail;
let wrong=true,biographyRequests=0;
globalThis.fetch=async name=>{
 if(name==='data/index.json')return {ok:true,json:async()=>({...raw,features:[{...feature,properties:props}]})};
 if(name===detail.slice(1))return {ok:true,json:async()=>structuredClone(feature)};
 if(name.startsWith('data/biographies/')){
   biographyRequests++;
   await new Promise(resolve=>setTimeout(resolve,10));
   return {ok:true,json:async()=>({format:1,survivor_id:wrong?'wrong':'ferguson-george',profile_hash:hash,
    source_url:feature.properties.archive_url,text:'A complete biography with <script>literal source text</script>.',
    provenance:'bundled_source_snapshot'})};
 }
 return {ok:true,json:async()=>JSON.parse(fs.readFileSync(name,'utf8'))};
};
const {loadData,BiographyError}=await import('./js/data.js');
const ui=await import('./js/ui.js');
const store=await loadData({compact:true});await store.loadProfile('ferguson-george');
const journey=store.byId.get('ferguson-george'),excerpt=journey.bio,source=JSON.stringify(journey.sourceProperties);
const initially=biographyRequests;
let rejected=false;
try{await store.loadBiography(journey.id)}catch(error){rejected=error instanceof BiographyError}
const failed=journey.biographyState;
wrong=false;
await Promise.all([store.loadBiography(journey.id),store.loadBiography(journey.id)]);
await store.loadBiography(journey.id);
const content=ui.biographyContent(journey);
console.log(JSON.stringify({initially,rejected,failed,requests:biographyRequests,state:journey.biographyState,
 excerptPreserved:journey.bio===excerpt,sourcePreserved:JSON.stringify(journey.sourceProperties)===source,
 complete:journey.fullBiography.includes('complete biography'),escaped:content.includes('&lt;script&gt;')&&!content.includes('<script>')}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script], cwd=ROOT,
        check=True, capture_output=True, text=True, encoding="utf-8",
    )
    data = json.loads(result.stdout)
    assert data["initially"] == 0 and data["rejected"] and data["failed"] == "error"
    assert data["requests"] == 2 and data["state"] == "ready"
    assert data["excerptPreserved"] and data["sourcePreserved"] and data["complete"] and data["escaped"]
