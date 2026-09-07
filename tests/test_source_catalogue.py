"""Map-independent source browsing, bounded pagination and honest snapshot output."""
import json

import pytest

from test_archive_publication import PUBLICATION_SETUP
from test_collection_tools import _node
from test_worker_media import _worker


SETUP = PUBLICATION_SETUP + r"""
const {SOURCE_CATALOGUE_PATH,buildSourceCatalogue}=await import('./worker/collection-pages.js');
const env=await bindings(archive([
 makeFeature('adler-amek',{name:'Amek Adler',group:'Holocaust Survivors',waypoints:[{canonical:'Lodz, Poland',as_written:'Łódź'}]}),
 makeFeature('ferguson-george',{name:'George Ferguson',group:'Military Veterans'}),
]));
const seed=JSON.parse(env.bodies.get('/data/survivors.geojson'));
env.bodies.set(SOURCE_CATALOGUE_PATH,JSON.stringify(buildSourceCatalogue(seed.features,'a'.repeat(64))));
"""


def test_source_catalogue_is_independent_from_live_archive_and_profile_fetches():
    result = _worker(SETUP + r"""
env.OHP_DATA={get(){throw new Error('Do not read live KV')},getWithMetadata(){throw new Error('Do not read live KV')}};
const requested=[];
const original=env.ASSETS.fetch;
env.ASSETS.fetch=request=>{requested.push(new URL(request.url).pathname);return original(request)};
const response=await entry.fetch(new Request('https://test.local/collection?q=Adler+Amek'),env,{});
const html=await response.text();
console.log(JSON.stringify({status:response.status,html,requested}));
""")
    assert result["status"] == 200
    assert 'href="/survivor/adler-amek"' in result["html"]
    assert 'href="/survivor/ferguson-george"' not in result["html"]
    assert "published snapshot" in result["html"]
    assert result["requested"] == ["/data/source-catalogue.json"]
    assert "<script" not in result["html"]
    assert "/releases/" + "a" * 64 + "/css/source-catalogue.css" in result["html"]


def test_source_search_uses_the_shared_unicode_and_phrase_rules():
    result = _worker(SETUP + r"""
const responses=[];
for(const query of ['lodz','Łódź','Adler Amek','"Adler Amek"']){
 const response=await entry.fetch(new Request('https://test.local/collection?q='+encodeURIComponent(query)),env,{});
 const html=await response.text();
 responses.push({query,status:response.status,adler:html.includes('href="/survivor/adler-amek"')});
}
console.log(JSON.stringify(responses));
""")
    assert all(row["status"] == 200 for row in result)
    assert [row["adler"] for row in result] == [True, True, True, False]


@pytest.mark.parametrize("query,status", [
    ("?page=0", 400), ("?page=", 400), ("?page=-1", 400), ("?page=1.5", 400),
    ("?page=1000", 404), ("?group=Missing", 400), ("?q=a&q=b", 400),
    ("?unexpected=1", 400), ("?q=" + "a" * 201, 400),
])
def test_invalid_catalogue_parameters_have_explicit_recovery(query, status):
    result = _worker(SETUP + r"""
const response=await entry.fetch(new Request('https://test.local/collection'+payload),env,{});
console.log(JSON.stringify({status:response.status,cache:response.headers.get('cache-control'),html:await response.text()}));
""", query)
    assert result["status"] == status and result["cache"] == "no-store"
    assert "Return to the first results page" in result["html"]
    assert "Show all source accounts" in result["html"]
    assert 'href="/survivor/' not in result["html"]


def test_zero_one_and_ten_thousand_accounts_keep_html_and_navigation_bounded():
    data = _node(r"""
import {buildSourceCatalogue,renderSourceCatalogue} from './worker/collection-pages.js';
const make=(count)=>Array.from({length:count},(_,index)=>({properties:{
 survivor_id:'person-'+String(index).padStart(5,'0'),name:'Account '+String(index).padStart(5,'0'),
 group:index%2?'Second':'First',waypoints:[],
 source_biography:'A long biography that is deliberately not in the catalogue.',
 profile_media:{private:'not needed for names'},
}}));
const results=[];
for(const size of [0,1,10000]){
 const catalogue=buildSourceCatalogue(make(size));
 const page=renderSourceCatalogue(catalogue,'https://test.local/collection','https://test.local');
 results.push({size,status:page.status,links:(page.body.match(/href="\/survivor\//g)||[]).length,
  bytes:Buffer.byteLength(page.body),media:JSON.stringify(catalogue).includes('profile_media')});
}
const catalogue=buildSourceCatalogue(make(100));
const filtered=renderSourceCatalogue(catalogue,'https://test.local/collection?q=Account&group=First&page=2','https://test.local');
console.log(JSON.stringify({results,filtered:filtered.body}));
""")
    assert [row["links"] for row in data["results"]] == [0, 1, 40]
    assert all(row["status"] == 200 and row["bytes"] < 16000 and not row["media"] for row in data["results"])
    assert "10 accounts found" not in data["filtered"]
    assert "50 accounts found" in data["filtered"] and "Page 2 of 2" in data["filtered"]
    assert 'rel="prev" href="/collection?q=Account&amp;group=First#catalogue-results"' in data["filtered"]
    assert 'action="/collection#catalogue-results"' in data["filtered"]
    assert "person-00080" in data["filtered"] and "person-00081" not in data["filtered"]


def test_catalogue_revalidates_and_supports_head_without_mutating_state():
    result = _worker(SETUP + r"""
const request=new Request('https://test.local/collection');
const response=await entry.fetch(request,env,{});
const cached=await entry.fetch(new Request(request,{headers:{'if-none-match':response.headers.get('etag')}}),env,{});
const head=await entry.fetch(new Request(request,{method:'HEAD'}),env,{});
const post=await entry.fetch(new Request(request,{method:'POST'}),env,{});
const internal=await entry.fetch(new Request('https://test.local/data/source-catalogue.json'),env,{});
console.log(JSON.stringify({status:response.status,cache:response.headers.get('cache-control'),cached:cached.status,head:head.status,
 headBody:await head.text(),post:post.status,internal:internal.status,writes:env.writes.length}));
""")
    assert result["status"] == result["head"] == 200
    assert result["cached"] == 304 and result["headBody"] == ""
    assert result["post"] == 405 and result["internal"] == 404 and result["writes"] == 0
    assert result["cache"] == "public, max-age=0, must-revalidate"


@pytest.mark.parametrize("kind", ["missing", "invalid", "duplicate"])
def test_missing_or_invalid_catalogue_never_becomes_a_successful_empty_list(kind):
    result = _worker(SETUP + r"""
if(payload==='missing')env.bodies.delete(SOURCE_CATALOGUE_PATH);
if(payload==='invalid')env.bodies.set(SOURCE_CATALOGUE_PATH,JSON.stringify({format:1,entries:[null]}));
if(payload==='duplicate'){
 const catalogue=JSON.parse(env.bodies.get(SOURCE_CATALOGUE_PATH));
 catalogue.entries.push(catalogue.entries[0]);
 env.bodies.set(SOURCE_CATALOGUE_PATH,JSON.stringify(catalogue));
}
const response=await entry.fetch(new Request('https://test.local/collection'),env,{});
console.log(JSON.stringify({status:response.status,html:await response.text()}));
""", kind)
    assert result["status"] == 503
    assert "original OHP" in result["html"] or "original oral history" in result["html"]


def test_source_catalogue_text_does_not_become_markup():
    data = _node(r"""
import {buildSourceCatalogue,renderSourceCatalogue} from './worker/collection-pages.js';
const name='A <img src=x onerror=alert(1)> & "name"';
const catalogue=buildSourceCatalogue([{properties:{survivor_id:'literal-source',name,group:'A & B',waypoints:[]}}]);
const page=renderSourceCatalogue(catalogue,'https://test.local/collection?q='+encodeURIComponent('<img'),'https://test.local');
console.log(JSON.stringify({html:page.body}));
""")
    assert "&lt;img" in data["html"] and "<img src=x" not in data["html"]
    assert "A &amp; B" in data["html"]


def test_source_account_has_a_labelled_main_and_non_script_return_path():
    result = _worker(PUBLICATION_SETUP + r"""
const feature=makeFeature('reader');
const html=renderProfileHtml(shell,feature,{origin:'https://test.local'});
console.log(JSON.stringify({html}));
""")
    assert '<main id="server-profile"' in result["html"]
    assert 'aria-labelledby="server-profile-name"' in result["html"]
    assert 'href="/collection">Return to the collection' in result["html"]
