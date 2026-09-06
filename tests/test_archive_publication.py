"""Compact publishing, immutable details, canonical HTML and HTTP safety contracts."""
import hashlib
import json
from pathlib import Path
import shutil
import uuid

import pytest

from test_worker_media import _worker
from test_worker_snapshot import SETUP


ROOT = Path(__file__).resolve().parents[1]

PUBLICATION_SETUP = SETUP + r"""
const {prepareArchive,contentHash,stableJSON,profilePath,profileKey,INDEX_FORMAT} = publicationModule;
const {renderProfileHtml} = await import('./worker/profile-pages.js');
const makeFeature = (id, extra={}) => ({
  type:'Feature',geometry:{type:'Point',coordinates:[-79.38,43.65]},
  properties:{
    survivor_id:id,name:`Account ${id}`,group:'Community Members',birth_year:1920,
    conflicts:['Second World War'],theme_tags:['School'],archive_url:`https://ohp.crestwood.on.ca/ohp/${id}/`,
    portrait:`assets/portraits/${id}.webp`,portrait_rights:'Reuse permission granted by the author.',portrait_faces:1,
    video_count:1,captioned_video_count:0,transcript_status:'pending',review_status:'pending',
    bio_excerpt:'An original public source excerpt.',
    profile_media:{images:[],videos:[{id:'123',embed_url:'https://player.vimeo.com/video/123?h=public123'}]},
    video_source_inventory:'1:abc',contextual_places:[{source_quote:'A family reference.'}],
    waypoints:[{
      canonical:'Toronto, Canada',as_written:'Toronto',role:'resettlement',lat:43.65,lng:-79.38,
      date:{start:'1946',end:'1946',precision:'year'},verified:false,confidence:0.9,location_precision:'city',
      evidence:{scope:'personal',reason:'source-biography',source_url:'https://source.test/evidence'},
      source_quote:'He came to Toronto.',location_note:'A long coordinate qualification.',
      location_source_url:'https://source.test/place',
    }],
    ...extra,
  },
});
const archive = features => ({...doc,metadata:{...doc.metadata,count:features.length},features});
const shell = '<!DOCTYPE html><html><head><title>Generic archive</title><meta name="description" content="generic">' +
  '<meta property="og:title" content="generic"><link rel="canonical" href="https://wrong.test/">' +
  '<link href="css/style.css" rel="stylesheet"></head><body><svg><use href="#icon"></use></svg>' +
  '<div id="stage"></div><script src="vendor/gsap/gsap.min.js"></script><script type="module" src="js/app.js"></script></body></html>';
async function bindings(seed=archive([])) {
  const bodies=new Map([['/index.html',shell],['/data/survivors.geojson',JSON.stringify(seed)]]);
  const built=await prepareArchive(seed,'seed',({id,hash,body})=>bodies.set(profilePath(id,hash),body));
  bodies.set('/data/catalog.json',JSON.stringify(built.catalog));
  bodies.set('/data/index.json',JSON.stringify(built.index));
  bodies.set('/sitemap.xml',publicationModule.renderSitemap(built.catalog));
  const values=new Map(),writes=[],reads=[],state=new Map();
  const storage={
    get:async key=>state.get(key),put:async(key,value)=>{
      if(typeof key==='object'){for(const [name,item] of Object.entries(key))state.set(name,structuredClone(item))}
      else state.set(key,structuredClone(value));
    },
    delete:async key=>state.delete(key),
  };
  const env={
    storage,values,writes,reads,state,bodies,
    OHP_DATA:{
      get:async(key,type)=>{const value=values.get(key)?.value;return value ? type==='json'?JSON.parse(value):value : null},
      getWithMetadata:async(key,{type}={})=>{
        reads.push({key,type});
        const found=values.get(key);
        return {value:found ? type==='json'?JSON.parse(found.value):new Response(found.value).body : null,metadata:found?.metadata||null};
      },
      put:async(key,value,options={})=>{
        if(env.failWrite?.(key))throw new Error('Simulated detail write failure');
        if(key===worker.INDEX_KEY){
          const index=JSON.parse(value);
          if(index.metadata.publication_version!==options.metadata.version)throw new Error('Mixed index revision');
          for(const feature of index.features){
            const path=feature.properties.detail_url;
            if(!bodies.has(path)&&!values.has(path.slice(1)))throw new Error('Index references an unwritten profile');
          }
        }
        values.set(key,{value,metadata:options.metadata});
        writes.push({key,value,options});
      },
    },
    ASSETS:{fetch:async request=>{
      const pathname=new URL(request.url).pathname;
      if(!bodies.has(pathname))return new Response('Missing static asset',{status:404});
      const body=bodies.get(pathname);
      const etag=`"${await contentHash(body)}"`;
      const type=pathname.endsWith('.html')?'text/html; charset=utf-8':
        pathname.endsWith('.xml')?'application/xml':'application/json; charset=utf-8';
      const headers={'content-type':type,etag};
      if(request.headers.get('if-none-match')===etag)return new Response(null,{status:304,headers});
      return new Response(request.method==='HEAD'?null:body,{headers});
    }},
  };
  return env;
}
"""


@pytest.fixture
def build_directory():
    # Test output stays inside this checkout and never modifies public/ or data/.
    directory = ROOT / "tests" / f".archive-build-{uuid.uuid4().hex}"
    directory.mkdir()
    try:
        yield directory
    finally:
        shutil.rmtree(directory)


def test_compact_index_preserves_browse_fields_but_detail_is_the_complete_original():
    result = _worker(PUBLICATION_SETUP + r"""
      const original=makeFeature('canonical',{source_aliases:['old-name']});
      const details=[];
      const {index,catalog}=await prepareArchive(archive([original]),'version',item=>details.push(item));
      const parsed=JSON.parse(details[0].body);
      const reordered={properties:{...original.properties},geometry:original.geometry,type:'Feature'};
      console.log(JSON.stringify({
        index,catalog,original,parsed,hash:details[0].hash,
        reorderedHash:await contentHash(stableJSON(reordered)),body:details[0].body,
      }));
    """)
    compact = result["index"]["features"][0]
    original = result["original"]
    assert result["parsed"] == original
    assert compact["geometry"] == original["geometry"]
    for key in (
        "survivor_id", "source_aliases", "name", "group", "birth_year", "conflicts", "theme_tags",
        "archive_url", "portrait", "portrait_rights", "portrait_faces", "video_count",
        "captioned_video_count", "transcript_status", "review_status",
    ):
        assert compact["properties"][key] == original["properties"][key]
    for key in ("profile_media", "bio_excerpt", "video_source_inventory", "contextual_places"):
        assert key not in compact["properties"]
    place = compact["properties"]["waypoints"][0]
    assert place["evidence"] == {"scope": "personal", "reason": "source-biography"}
    assert not {"source_quote", "location_note", "location_source_url"} & place.keys()
    assert result["catalog"]["aliases"] == {"old-name": "canonical"}
    assert result["hash"] == result["reorderedHash"]
    assert hashlib.sha256(result["body"].encode()).hexdigest() == result["hash"]
    assert compact["properties"]["detail_url"] == f"/data/profiles/canonical.{result['hash']}.json"
    assert "h=public123" in result["parsed"]["properties"]["profile_media"]["videos"][0]["embed_url"]


def test_real_archive_compact_transfer_budget_and_all_source_ids_are_preserved():
    result = _worker(r"""
      const zlib=await import('node:zlib');
      const archiveDoc=JSON.parse(fs.readFileSync('data/survivors.geojson','utf8'));
      const {index,catalog}=await publicationModule.prepareArchive(archiveDoc,'measurement');
      const body=JSON.stringify(index),full=JSON.stringify(archiveDoc);
      console.log(JSON.stringify({
        count:index.features.length,sourceCount:archiveDoc.features.length,
        ids:index.features.map(f=>f.properties.survivor_id),
        sourceIds:archiveDoc.features.map(f=>f.properties.survivor_id),
        bytes:Buffer.byteLength(body),gzip:zlib.gzipSync(body).length,
        fullBytes:Buffer.byteLength(full),fullGzip:zlib.gzipSync(full).length,
        aliases:catalog.aliases,
      }));
    """)
    assert result["count"] == result["sourceCount"] >= 1176
    assert result["ids"] == result["sourceIds"]
    assert result["aliases"]["thomas-jack"] == "thomas-jack-c"
    assert result["bytes"] <= 3_000_000
    assert result["gzip"] <= 350_000
    assert result["bytes"] < result["fullBytes"] * 0.25
    assert result["gzip"] < result["fullGzip"] * 0.25


def test_assembler_emits_source_led_html_sitemap_and_retained_immutable_details(build_directory):
    result = _worker(PUBLICATION_SETUP + r"""
      const {buildArchiveAssets}=await import('./tools/build_archive_assets.cjs');
      const first=makeFeature('first',{name:'A & B <Account>',source_aliases:['earlier-name'],bio_excerpt:'Curated map introduction.'});
      const second=makeFeature('second',{name:'No licensed portrait',portrait_rights:'See source rights.'});
      const previous=makeFeature('first',{bio_excerpt:'An older public snapshot.'});
      const original='The original public biography, exactly as recorded. <script>Not executable</script> & a source quotation.';
      const stats=await buildArchiveAssets({
        out:payload,doc:archive([first,second]),shell,origin:'https://archive.test',
        sourceProfiles:{
          first:{source_status:'public',quote_text:original},
          private:{source_status:'protected',quote_text:'Do not publish this private text.'},
        },
        previousDocuments:[archive([previous])],
      });
      const path=await import('node:path');
      const read=name=>fs.readFileSync(path.join(payload,...name.split('/')),'utf8');
      const index=JSON.parse(read('data/index.json'));
      const firstPath=index.features[0].properties.detail_url;
      const hash=firstPath.match(/\.([a-f0-9]{64})\.json$/)[1];
      const secondHash=index.features[1].properties.detail_url.match(/\.([a-f0-9]{64})\.json$/)[1];
      const oldHash=await contentHash(stableJSON(previous));
      console.log(JSON.stringify({
        stats,first,body:read(firstPath.slice(1)),html:read(`data/profile-pages/first.${hash}.html`),
        unlicensedHtml:read(`data/profile-pages/second.${secondHash}.html`),
        sitemap:read('sitemap.xml'),notFound:read('404.html'),robots:read('robots.txt'),
        previous:JSON.parse(read(`data/profiles/first.${oldHash}.json`)),original,
      }));
    """, str(build_directory))
    assert result["stats"]["profiles"] == 2
    assert result["stats"]["retained_details"] == 1
    assert json.loads(result["body"]) == result["first"]
    html = result["html"]
    assert 'id="server-profile"' in html
    assert "<h1" in html and "A &amp; B &lt;Account&gt;" in html
    assert "The original public biography, exactly as recorded." in html
    assert "Curated map introduction." not in html
    assert "<script>Not executable</script>" not in html
    assert "&lt;script&gt;Not executable&lt;/script&gt;" in html
    assert 'rel="canonical" href="https://archive.test/survivor/first"' in html
    assert 'property="og:url" content="https://archive.test/survivor/first"' in html
    assert 'property="og:image" content="https://archive.test/assets/social-preview.png"' in html
    assert 'name="twitter:title"' in html and 'name="twitter:image"' in html
    assert "Map references have not been fully reviewed" in html
    assert "Toronto, Canada" in html and "1946" in html
    assert 'href="https://ohp.crestwood.on.ca/ohp/first/"' in html
    assert 'href="/css/style.css"' in html and 'src="/js/app.js"' in html
    assert 'src="/vendor/gsap/gsap.min.js"' in html
    assert 'href="#icon"' in html and "<base" not in html
    assert "generic" not in html.lower() and "wrong.test" not in html
    assert "assets/portraits/second.webp" not in result["unlicensedHtml"]
    assert result["sitemap"].count("<url>") == 3
    assert "/survivor/first" in result["sitemap"] and "/survivor/second" in result["sitemap"]
    assert "earlier-name" not in result["sitemap"] and "private" not in result["sitemap"]
    assert "Page not found" in result["notFound"] and 'href="/#/explore"' in result["notFound"]
    assert "Sitemap: https://archive.test/sitemap.xml" in result["robots"]
    assert result["previous"]["properties"]["bio_excerpt"] == "An older public snapshot."


def test_seed_bootstrap_writes_no_profile_keys_and_only_changed_live_details_are_written():
    result = _worker(PUBLICATION_SETUP + r"""
      const seed=archive([makeFeature('first'),makeFeature('second',{source_aliases:['alias']})]);
      const env=await bindings(seed);
      const publish=doc=>worker.publishCurrentData(env,doc,{storage:env.storage});
      const first=await publish(seed);
      const seedWrites=env.writes.filter(write=>write.key.startsWith('data/profiles/')).length;
      const changed=structuredClone(seed);
      changed.features[0].properties.profile_media.videos[0].embed_url='https://player.vimeo.com/video/123?h=newhash123';
      const update=await publish(changed);
      const oldIndex=JSON.parse(env.values.get(worker.INDEX_KEY).value);
      const oldPath=oldIndex.features[0].properties.detail_url;
      const updateWrites=env.writes.filter(write=>write.key.startsWith('data/profiles/')).length;
      await publish(changed);
      const repeatWrites=env.writes.filter(write=>write.key.startsWith('data/profiles/')).length;
      changed.features[0].properties.bio_excerpt='A later exact source excerpt.';
      await publish(changed);
      const old=await entry.fetch(new Request('https://test.local'+oldPath),env,{});
      const current=JSON.parse(env.values.get(worker.INDEX_KEY).value);
      const indexRecord=env.values.get(worker.INDEX_KEY);
      const catalogRecord=env.values.get(worker.CATALOG_KEY);
      const fullRecord=env.values.get(worker.DATA_KEY);
      console.log(JSON.stringify({
        first,seedWrites,update,updateWrites,repeatWrites,
        oldStatus:old.status,oldBody:await old.json(),current,oldPath,
        indexVersion:current.metadata.publication_version,
        versions:[indexRecord.metadata.version,catalogRecord.metadata.version,fullRecord.metadata.version],
        full:JSON.parse(fullRecord.value),changed,
        fullWrites:env.writes.filter(write=>write.key===worker.DATA_KEY).length,
        compatibilityWrites:env.writes.filter(write=>write.key===worker.PUBLIC_DATA_KEY).length,
      }));
    """)
    assert result["first"]["complete"] and result["first"]["seed_profiles"] == 2
    assert result["seedWrites"] == 0
    assert result["update"]["written"] == 1
    assert result["updateWrites"] == result["repeatWrites"] == 1
    assert result["oldStatus"] == 200
    assert result["oldBody"]["properties"]["bio_excerpt"] == "An original public source excerpt."
    assert result["oldPath"] != result["current"]["features"][0]["properties"]["detail_url"]
    assert set(result["versions"]) == {result["indexVersion"]}
    assert result["full"] == result["changed"]
    assert result["fullWrites"] == 4 and result["compatibilityWrites"] == 0


def test_large_live_bootstrap_stages_bounded_batches_without_publishing_partial_index_or_losing_live_rows():
    result = _worker(PUBLICATION_SETUP + r"""
      const env=await bindings();
      const live=archive(Array.from({length:65},(_,index)=>makeFeature(`person-${index}`)));
      const first=await worker.publishCurrentData(env,live,{storage:env.storage});
      const noFirstIndex=!env.values.has(worker.INDEX_KEY);
      const full=await entry.fetch(new Request('https://test.local/data/survivors.geojson'),env,{});
      const fullCount=(await full.json()).features.length;
      globalThis.fetch=async()=>{throw new Error('A staged snapshot must finish before another source refresh')};
      const second=await worker.syncSurvivors(env,{publicationStorage:env.storage});
      const noSecondIndex=!env.values.has(worker.INDEX_KEY);
      const third=await worker.syncSurvivors(env,{publicationStorage:env.storage});
      const index=JSON.parse(env.values.get(worker.INDEX_KEY).value);
      console.log(JSON.stringify({
        first,second,third,noFirstIndex,noSecondIndex,fullCount,index,
        fullWrites:env.writes.filter(write=>write.key===worker.DATA_KEY).length,
        detailWrites:env.writes.filter(write=>write.key.startsWith('data/profiles/')).length,
        pending:[...env.state.keys()].filter(key=>key.endsWith(':preparing')),
      }));
    """)
    assert result["first"]["written"] == 30 and result["first"]["remaining"] == 35
    assert result["second"]["state"] == "preparing-index"
    assert result["second"]["publication"]["written"] == 30
    assert result["second"]["publication"]["remaining"] == 5
    assert result["third"]["state"] == "ready"
    assert result["third"]["publication"]["written"] == 5
    assert result["noFirstIndex"] and result["noSecondIndex"]
    assert result["fullCount"] == len(result["index"]["features"]) == 65
    assert result["index"]["metadata"]["publication_version"] == result["first"]["version"]
    assert result["fullWrites"] == 1 and result["detailWrites"] == 65
    assert result["pending"] == []


@pytest.mark.parametrize("decision", ["reject", "context", "stale", "legacy-pending"])
def test_pending_publication_reconciles_a_new_seed_before_resuming(decision):
    result = _worker(PUBLICATION_SETUP + r"""
      const env=await bindings();
      const live=archive(Array.from({length:31},(_,index)=>makeFeature(`person-${index}`)));
      live.features[0].properties.bio_excerpt='A newer live biography must survive seed review import.';
      live.features[0].properties.profile_media.videos[0].embed_url='https://player.vimeo.com/video/123?h=livehash123';
      const newer=live.features[1].properties.waypoints[0];
      newer.verified=true;
      newer.human_review={
        action:'approve',source_fingerprint:'sha256:'+'b'.repeat(64),reviewer:'Synthetic test reviewer',
        reviewed_at:'2026-09-05',source_url:live.features[1].properties.archive_url,
        rationale:'Synthetic newer live decision.',original_evidence:{scope:'uncertain'},original_collection:'waypoints',
      };
      live.features[1].properties.review_status='reviewed';
      const first=await worker.publishCurrentData(env,live,{storage:env.storage});
      const pendingKey=[...env.state.keys()].find(key=>key.endsWith(':preparing'));
      if(payload==='legacy-pending')delete env.state.get(pendingKey).seed_version;
      const reviewed=structuredClone(live.features[0]);
      reviewed.properties.bio_excerpt='Older seeded biography.';
      reviewed.properties.profile_media.videos[0].embed_url='https://player.vimeo.com/video/123?h=seedhash123';
      const point=reviewed.properties.waypoints[0];
      const action=payload==='context'?'context':'reject';
      point.human_review={
        action:payload==='stale'?'approve':action,source_fingerprint:'sha256:'+'a'.repeat(64),
        reviewer:'Synthetic test reviewer',reviewed_at:'2026-09-05',source_url:reviewed.properties.archive_url,
        rationale:'Synthetic source-bound decision.',original_evidence:{scope:'personal'},original_collection:'waypoints',
      };
      point.verified=false;
      point.evidence=payload==='stale'
        ?{scope:'uncertain',reason:'stale_review: source quotation changed'}
        :{scope:'contextual',reason:`human-review-${action}`};
      if(payload==='stale')point.source_quote='The revised source no longer supports the earlier approval.';
      else{reviewed.properties.waypoints=[];reviewed.properties.contextual_places=[point];reviewed.geometry=null}
      const older=structuredClone(live.features[1]);
      older.properties.waypoints[0].human_review.reviewed_at='2026-09-01';
      const changedSeed=archive([reviewed,older,makeFeature('removed-since-seed')]);
      const prepared=await prepareArchive(changedSeed,'review-deployment',({id,hash,body})=>env.bodies.set(profilePath(id,hash),body));
      env.bodies.set('/data/catalog.json',JSON.stringify(prepared.catalog));
      env.bodies.set('/data/survivors.geojson',JSON.stringify(changedSeed));
      const writesBefore=env.writes.length;
      globalThis.fetch=async()=>{throw new Error('Staging must reconcile the seed, not scrape external source pages')};
      const status=await worker.syncSurvivors(env,{publicationStorage:env.storage});
      const full=JSON.parse(env.values.get(worker.DATA_KEY).value);
      const index=env.values.has(worker.INDEX_KEY)?JSON.parse(env.values.get(worker.INDEX_KEY).value):null;
      console.log(JSON.stringify({
        first,status,fullCount:full.features.length,firstProfile:full.features[0],newerProfile:full.features[1],point,newer,
        indexCount:index?.features.length,indexVersion:index?.metadata.publication_version,
        fullVersion:env.values.get(worker.DATA_KEY).metadata.version,
        contentRevision:full.metadata.content_revision,expectedRevision:live.metadata.content_revision,
        detailWrites:env.writes.slice(writesBefore).filter(write=>write.key.startsWith('data/profiles/')).length,
        totalWrites:env.writes.length-writesBefore,
      }));
    """, decision)
    assert result["first"]["complete"] is False and result["first"]["written"] == 30
    assert result["status"]["state"] == "ready"
    assert result["fullCount"] == result["indexCount"] == 31
    properties = result["firstProfile"]["properties"]
    assert properties["review_status"] == "pending"
    assert properties["bio_excerpt"] == "A newer live biography must survive seed review import."
    assert "h=livehash123" in properties["profile_media"]["videos"][0]["embed_url"]
    if decision == "stale":
        assert properties["waypoints"] == [result["point"]]
        assert properties["waypoints"][0]["verified"] is False
    else:
        assert properties["waypoints"] == []
        assert properties["contextual_places"] == [result["point"]]
    assert result["status"]["publication"]["rebased"] is True
    assert result["status"]["publication"]["seed_version"] == "review-deployment"
    assert result["newerProfile"]["properties"]["waypoints"] == [result["newer"]]
    assert result["fullVersion"] == result["indexVersion"] != result["first"]["version"]
    assert result["contentRevision"] == result["expectedRevision"]
    assert result["detailWrites"] == 2
    assert result["totalWrites"] <= 39


def test_interrupted_seed_rebase_recovers_its_new_full_snapshot_without_losing_reviews():
    result = _worker(PUBLICATION_SETUP + r"""
      const env=await bindings();
      const live=archive(Array.from({length:31},(_,index)=>makeFeature(`person-${index}`)));
      const first=await worker.publishCurrentData(env,live,{storage:env.storage});
      const reviewed=structuredClone(live.features[0]);
      const point=reviewed.properties.waypoints.pop();
      point.human_review={
        action:'reject',source_fingerprint:'sha256:'+'a'.repeat(64),reviewer:'Synthetic test reviewer',
        reviewed_at:'2026-09-05',source_url:reviewed.properties.archive_url,rationale:'Synthetic rejection.',
        original_evidence:{scope:'personal'},original_collection:'waypoints',
      };
      point.evidence={scope:'contextual',reason:'human-review-reject'};
      reviewed.properties.contextual_places=[point];reviewed.geometry=null;
      const seed=archive([reviewed]);
      const next=await prepareArchive(seed,'next-seed',({id,hash,body})=>env.bodies.set(profilePath(id,hash),body));
      env.bodies.set('/data/catalog.json',JSON.stringify(next.catalog));
      env.bodies.set('/data/survivors.geojson',JSON.stringify(seed));
      const put=env.storage.put;
      let interrupted=false;
      env.storage.put=async(key,value)=>{
        if(typeof key==='string'&&key.endsWith(':preparing')&&!value.replacement&&value.metadata.version!==first.version&&!interrupted){
          interrupted=true;throw new Error('Interrupted after the new full KV write');
        }
        return put(key,value);
      };
      let error='';
      try{await worker.syncSurvivors(env,{publicationStorage:env.storage})}catch(failure){error=failure.message}
      const replacementVersion=env.values.get(worker.DATA_KEY).metadata.version;
      const status=await worker.syncSurvivors(env,{publicationStorage:env.storage});
      const index=JSON.parse(env.values.get(worker.INDEX_KEY).value);
      const full=JSON.parse(env.values.get(worker.DATA_KEY).value);
      console.log(JSON.stringify({
        error,status,replacementVersion,indexVersion:index.metadata.publication_version,
        feature:full.features[0],point,fullWrites:env.writes.filter(write=>write.key===worker.DATA_KEY).length,
      }));
    """)
    assert "Interrupted" in result["error"]
    assert result["status"]["state"] == "ready"
    assert result["indexVersion"] == result["replacementVersion"]
    assert result["fullWrites"] == 2
    assert result["feature"]["properties"]["waypoints"] == []
    assert result["feature"]["properties"]["contextual_places"] == [result["point"]]


def test_failed_detail_write_preserves_the_prior_index_and_reuses_successful_staged_writes():
    result = _worker(PUBLICATION_SETUP + r"""
      const seed=archive([makeFeature('first'),makeFeature('second')]);
      const env=await bindings(seed);
      await worker.publishCurrentData(env,seed,{storage:env.storage});
      const before=env.values.get(worker.INDEX_KEY).value;
      const changed=structuredClone(seed);
      changed.features.forEach(feature=>feature.properties.bio_excerpt='A changed source excerpt.');
      env.failWrite=key=>key.startsWith('data/profiles/second.');
      let error;
      try{await worker.publishCurrentData(env,changed,{storage:env.storage})}catch(failure){error=failure.message}
      const preserved=env.values.get(worker.INDEX_KEY).value===before;
      env.failWrite=null;
      const retry=await worker.syncSurvivors(env,{publicationStorage:env.storage});
      console.log(JSON.stringify({
        error,preserved,retry,
        firstWrites:env.writes.filter(write=>write.key.startsWith('data/profiles/first.')).length,
        secondWrites:env.writes.filter(write=>write.key.startsWith('data/profiles/second.')).length,
      }));
    """)
    assert result["preserved"] and "Simulated" in result["error"]
    assert result["retry"]["state"] == "ready"
    assert result["retry"]["publication"]["written"] == 1
    assert result["firstWrites"] == result["secondWrites"] == 1


def test_sqlite_backups_cover_kv_replication_lag_and_old_seed_hashes_without_full_archive_reads():
    result = _worker(PUBLICATION_SETUP + r"""
      const seed=archive([makeFeature('person')]);
      const env=await bindings(seed);
      await worker.publishCurrentData(env,seed,{storage:env.storage});
      const oldPath=JSON.parse(env.values.get(worker.INDEX_KEY).value).features[0].properties.detail_url;
      const changed=structuredClone(seed);
      changed.features[0].properties.bio_excerpt='Updated public biography excerpt.';
      await worker.publishCurrentData(env,changed,{storage:env.storage});
      const path=JSON.parse(env.values.get(worker.INDEX_KEY).value).features[0].properties.detail_url;
      env.bodies.delete(oldPath);
      env.values.delete(path.slice(1));
      const {ArchiveSync}=await import(runnerURL);
      const runner=new ArchiveSync({storage:env.storage},env);
      const requests=[];
      env.ARCHIVE_SYNC={
        idFromName:name=>name,
        get:()=>({fetch:async url=>{requests.push(url);return runner.fetch(new Request(url))}}),
      };
      const parse=JSON.parse;
      JSON.parse=()=>{throw new Error('Recovery must not parse the full archive')};
      let older,current;
      try{
        older=await entry.fetch(new Request('https://test.local'+oldPath),env,{});
        current=await entry.fetch(new Request('https://test.local'+path),env,{});
      }finally{JSON.parse=parse}
      console.log(JSON.stringify({
        older:await older.json(),current:await current.json(),requests,
        sources:[older.headers.get('x-ohp-source'),current.headers.get('x-ohp-source')],
        fullReads:env.reads.filter(read=>read.key===worker.DATA_KEY).length,
        profileKVWrites:env.writes.filter(write=>write.key.startsWith('data/profiles/')).length,
      }));
    """)
    assert result["older"]["properties"]["bio_excerpt"] == "An original public source excerpt."
    assert result["current"]["properties"]["bio_excerpt"] == "Updated public biography excerpt."
    assert result["sources"] == ["durable", "durable"]
    assert len(result["requests"]) == 2
    assert all("/data/profiles/person." in request for request in result["requests"])
    assert result["fullReads"] == 0
    assert result["profileKVWrites"] == 1


def test_durable_alarm_never_spends_another_profile_batch_inside_the_same_hour():
    result = _worker(PUBLICATION_SETUP + r"""
      const env=await bindings();
      await worker.publishCurrentData(env,archive(Array.from({length:65},(_,index)=>makeFeature(`person-${index}`))),{storage:env.storage});
      let alarm=null,now=Date.now();
      Date.now=()=>now;
      env.storage.getAlarm=async()=>alarm;
      env.storage.setAlarm=async value=>{alarm=value};
      const {ArchiveSync}=await import(runnerURL);
      const runner=new ArchiveSync({storage:env.storage,blockConcurrencyWhile:callback=>callback()},env);
      await runner.alarm();
      const firstWrites=env.writes.length;
      const firstAlarm=alarm;
      await runner.alarm();
      const retryWrites=env.writes.length;
      now+=60*60*1000;
      await runner.alarm();
      console.log(JSON.stringify({
        firstWrites,retryWrites,firstAlarm,previousNow:now-60*60*1000,
        prepared:env.state.get('prepared-publication'),expected:worker.INDEX_KEY,
        indexCount:JSON.parse(env.values.get(worker.INDEX_KEY).value).features.length,
        maxDailyWrites:24*(publicationModule.PROFILE_WRITE_BUDGET+9),
      }));
    """)
    assert result["firstWrites"] == result["retryWrites"]
    assert result["firstAlarm"] == result["previousNow"] + 60 * 60 * 1000
    assert result["prepared"] == result["expected"]
    assert result["indexCount"] == 65
    assert result["maxDailyWrites"] == 936 < 1000


def test_imported_seed_review_decisions_survive_live_refresh_without_losing_live_media():
    result = _worker(PUBLICATION_SETUP + r"""
      const live=archive([makeFeature('reviewed')]);
      live.features[0].properties.profile_media.videos[0].embed_url='https://player.vimeo.com/video/123?h=livehash123';
      const seed=structuredClone(live);
      const point=seed.features[0].properties.waypoints.pop();
      point.human_review={
        action:'reject',source_fingerprint:'sha256:'+'a'.repeat(64),reviewer:'Synthetic test reviewer',
        reviewed_at:'2026-09-01',source_url:'https://ohp.crestwood.on.ca/ohp/reviewed/',
        rationale:'Synthetic fixture: this is a family reference, not a personal route.',
      };
      point.location_note='Preserve the exact reviewed coordinate qualification.';
      point.evidence={scope:'contextual',reason:'human-review-reject'};
      seed.features[0].properties.contextual_places=[point];
      seed.features[0].properties.profile_media.videos[0].embed_url='https://player.vimeo.com/video/123?h=seedhash123';
      seed.features[0].geometry=null;
      const env=await bindings(seed);
      env.values.set(worker.DATA_KEY,{value:JSON.stringify(live),metadata:worker.publicationMetadata(live)});
      globalThis.fetch=async()=>new Response('<html>No newly listed profiles</html>');
      await worker.syncSurvivors(env,{publicationStorage:env.storage});
      const published=JSON.parse(env.values.get(worker.DATA_KEY).value).features[0];
      const fresh=makeFeature('reviewed',{bio_excerpt:'A newly scraped automatic summary.'});
      const refreshed=worker.mergeFeature(published,fresh);
      console.log(JSON.stringify({published,refreshed,point}));
    """)
    published = result["published"]["properties"]
    assert published["waypoints"] == [] and result["published"]["geometry"] is None
    assert published["contextual_places"] == [result["point"]]
    assert published["review_status"] == "pending"
    assert "h=livehash123" in published["profile_media"]["videos"][0]["embed_url"]
    refreshed = result["refreshed"]["properties"]
    assert refreshed["waypoints"] == []
    assert refreshed["contextual_places"] == [result["point"]]
    assert refreshed["bio_excerpt"] == published["bio_excerpt"]


def test_mixed_seed_reviews_do_not_inherit_a_cached_fully_reviewed_status():
    result = _worker(PUBLICATION_SETUP + r"""
      const cached=archive([makeFeature('mixed',{review_status:'reviewed'})]);
      cached.features[0].properties.waypoints[0].verified=true;
      const seeded=structuredClone(cached);
      const approved=seeded.features[0].properties.waypoints[0];
      approved.human_review={
        action:'approve',source_fingerprint:'sha256:'+'b'.repeat(64),reviewer:'Synthetic test reviewer',
        reviewed_at:'2026-09-01',source_url:'https://ohp.crestwood.on.ca/ohp/mixed/',
        rationale:'Synthetic fixture approval.',original_evidence:{scope:'uncertain'},original_collection:'waypoints',
      };
      const pending={...structuredClone(approved),canonical:'Canada',as_written:'Canada',verified:false};
      delete pending.human_review;
      pending.evidence={scope:'uncertain',reason:'requires-human-review'};
      seeded.features[0].properties.waypoints.push(pending);
      const rejected=structuredClone(approved);
      rejected.verified=false;
      rejected.evidence={scope:'contextual',reason:'human-review-reject'};
      rejected.human_review={...rejected.human_review,action:'reject',rationale:'Synthetic family reference.'};
      seeded.features[0].properties.contextual_places=[rejected];
      seeded.features[0].properties.review_status='pending';
      const env=await bindings(seeded);
      env.values.set(worker.DATA_KEY,{value:JSON.stringify(cached),metadata:worker.publicationMetadata(cached)});
      globalThis.fetch=async()=>new Response('<html>No listed profiles</html>');
      await worker.syncSurvivors(env,{publicationStorage:env.storage});
      const published=JSON.parse(env.values.get(worker.DATA_KEY).value);
      const refreshed=worker.mergeFeature(published.features[0],makeFeature('mixed'));
      console.log(JSON.stringify({published,refreshed,approved,rejected}));
    """)
    assert result["published"]["metadata"]["reviewed"] == 0
    assert result["published"]["metadata"]["pending"] == 1
    for feature in (result["published"]["features"][0], result["refreshed"]):
        properties = feature["properties"]
        assert properties["review_status"] == "pending"
        assert [point["verified"] for point in properties["waypoints"]] == [True, False]
        assert properties["waypoints"][0] == result["approved"]
        assert properties["contextual_places"] == [result["rejected"]]


@pytest.mark.parametrize("unplaced", [0, 2])
def test_seed_review_collections_carry_or_clear_their_unplaced_claim_count(unplaced):
    result = _worker(PUBLICATION_SETUP + r"""
      const cached=archive([makeFeature('unplaced-review',{unplaced_waypoint_count:9})]);
      const seeded=structuredClone(cached);
      const properties=seeded.features[0].properties;
      const approved=properties.waypoints[0];
      approved.verified=true;
      approved.human_review={
        action:'approve',source_fingerprint:'sha256:'+'c'.repeat(64),reviewer:'Synthetic test reviewer',
        reviewed_at:'2026-09-01',source_url:properties.archive_url,
        rationale:'Synthetic fixture approval.',original_evidence:{scope:'uncertain'},original_collection:'waypoints',
      };
      if(payload)properties.unplaced_waypoint_count=payload;
      else delete properties.unplaced_waypoint_count;
      properties.review_status=payload?'pending':'reviewed';
      const env=await bindings(seeded);
      env.values.set(worker.DATA_KEY,{value:JSON.stringify(cached),metadata:worker.publicationMetadata(cached)});
      globalThis.fetch=async()=>new Response('<html>No listed profiles</html>');
      await worker.syncSurvivors(env,{publicationStorage:env.storage});
      const published=JSON.parse(env.values.get(worker.DATA_KEY).value).features[0];
      const index=JSON.parse(env.values.get(worker.INDEX_KEY).value).features[0];
      const refreshed=worker.mergeFeature(published,makeFeature('unplaced-review'));
      console.log(JSON.stringify({published,index,refreshed,approved}));
    """, unplaced)
    for feature in (result["published"], result["index"], result["refreshed"]):
        properties = feature["properties"]
        assert properties["review_status"] == ("pending" if unplaced else "reviewed")
        if unplaced:
            assert properties["unplaced_waypoint_count"] == unplaced
        else:
            assert "unplaced_waypoint_count" not in properties
    assert result["published"]["properties"]["waypoints"][0] == result["approved"]
    assert result["refreshed"]["properties"]["waypoints"][0] == result["approved"]


@pytest.mark.parametrize("identity", ["id", "url"])
def test_migration_downgrades_fingerprinted_approvals_when_account_identity_changes(identity):
    result = _worker(PUBLICATION_SETUP + r"""
      const previous=makeFeature(payload==='id'?'old-id':'person',{review_status:'reviewed'});
      if(payload==='url')previous.properties.archive_url='https://ohp.crestwood.on.ca/ohp/earlier-page/';
      const point=previous.properties.waypoints[0];
      point.verified=true;
      point.human_review={
        action:'approve',source_fingerprint:'sha256:'+'d'.repeat(64),reviewer:'Synthetic test reviewer',
        reviewed_at:'2026-09-01',source_url:previous.properties.archive_url,rationale:'Synthetic recorded approval.',
        original_evidence:{scope:'uncertain'},original_collection:'waypoints',
      };
      const seed=makeFeature('person',payload==='id'?{source_aliases:['old-id']}:{});
      const migrated=worker.migrateCachedData(archive([previous]),archive([seed]));
      console.log(JSON.stringify({previous,migrated}));
    """, identity)
    original = result["previous"]["properties"]["waypoints"][0]
    feature = result["migrated"]["features"][0]
    point = feature["properties"]["waypoints"][0]
    assert feature["properties"]["survivor_id"] == "person"
    assert feature["properties"]["archive_url"] == "https://ohp.crestwood.on.ca/ohp/person/"
    assert feature["properties"]["review_status"] == "pending"
    assert result["migrated"]["metadata"]["reviewed"] == 0
    assert point["verified"] is False and point["evidence"]["scope"] == "uncertain"
    assert "stale_review" in point["evidence"]["reason"]
    assert {key: value for key, value in point.items() if key not in ("verified", "evidence")} == {
        key: value for key, value in original.items() if key not in ("verified", "evidence")
    }


def test_adopting_seed_reviews_keeps_the_seed_account_identity_with_its_audit():
    result = _worker(PUBLICATION_SETUP + r"""
      const live=archive([makeFeature('person')]);
      live.features[0].properties.archive_url='https://ohp.crestwood.on.ca/ohp/earlier-page/';
      const seeded=archive([makeFeature('person',{review_status:'reviewed'})]);
      const point=seeded.features[0].properties.waypoints[0];
      point.verified=true;
      point.human_review={
        action:'approve',source_fingerprint:'sha256:'+'e'.repeat(64),reviewer:'Synthetic test reviewer',
        reviewed_at:'2026-09-01',source_url:seeded.features[0].properties.archive_url,
        rationale:'Synthetic seeded approval.',original_evidence:{scope:'uncertain'},original_collection:'waypoints',
      };
      const env=await bindings(seeded);
      env.values.set(worker.DATA_KEY,{value:JSON.stringify(live),metadata:worker.publicationMetadata(live)});
      globalThis.fetch=async()=>new Response('<html>No listed profiles</html>');
      await worker.syncSurvivors(env,{publicationStorage:env.storage});
      const feature=JSON.parse(env.values.get(worker.DATA_KEY).value).features[0];
      console.log(JSON.stringify({feature,seeded:seeded.features[0]}));
    """)
    properties = result["feature"]["properties"]
    assert properties["archive_url"] == result["seeded"]["properties"]["archive_url"]
    assert properties["survivor_id"] == result["seeded"]["properties"]["survivor_id"]
    assert properties["waypoints"] == result["seeded"]["properties"]["waypoints"]
    assert properties["review_status"] == "reviewed"


def test_same_revision_seed_invalidations_override_cached_approvals_without_reactivating_old_audits():
    result = _worker(PUBLICATION_SETUP + r"""
      const cached=archive([makeFeature('stale',{review_status:'reviewed'})]);
      const previous=cached.features[0].properties.waypoints[0];
      previous.verified=true;
      previous.human_review={
        action:'approve',source_fingerprint:'sha256:'+'f'.repeat(64),reviewer:'Synthetic test reviewer',
        reviewed_at:'2026-09-01',source_url:cached.features[0].properties.archive_url,
        rationale:'Synthetic earlier approval.',original_evidence:{scope:'uncertain'},original_collection:'waypoints',
      };
      const seeded=structuredClone(cached);
      const current=seeded.features[0].properties.waypoints[0];
      current.source_quote='A changed source quotation requiring a fresh review.';
      current.verified=false;
      current.evidence={scope:'uncertain',reason:'stale_review: source identity no longer matches the retained audit'};
      seeded.features[0].properties.review_status='pending';
      const env=await bindings(seeded);
      env.values.set(worker.DATA_KEY,{value:JSON.stringify(cached),metadata:worker.publicationMetadata(cached)});
      globalThis.fetch=async()=>new Response('<html>No listed profiles</html>');
      await worker.syncSurvivors(env,{publicationStorage:env.storage});
      const published=JSON.parse(env.values.get(worker.DATA_KEY).value);
      const index=JSON.parse(env.values.get(worker.INDEX_KEY).value);
      const refreshed=worker.mergeFeature(published.features[0],makeFeature('stale'));
      console.log(JSON.stringify({
        published,index,refreshed,current,oldHash:await contentHash(stableJSON(cached.features[0])),
        expectedRevision:cached.metadata.content_revision,
      }));
    """)
    assert result["published"]["metadata"]["content_revision"] == result["expectedRevision"]
    assert result["published"]["metadata"]["reviewed"] == 0
    for feature in (result["published"]["features"][0], result["refreshed"]):
        assert feature["properties"]["review_status"] == "pending"
        assert feature["properties"]["waypoints"][0] == result["current"]
        assert feature["properties"]["waypoints"][0]["verified"] is False
        assert feature["properties"]["waypoints"][0]["human_review"]["action"] == "approve"
    assert result["oldHash"] not in result["index"]["features"][0]["properties"]["detail_url"]


@pytest.mark.parametrize("other_decision", ["older", "omitted"])
def test_review_conflicts_are_resolved_per_point_with_seed_winning_same_day_replacements(other_decision):
    result = _worker(PUBLICATION_SETUP + r"""
      const cached=archive([makeFeature('point-conflicts')]);
      const first=cached.features[0].properties.waypoints[0];
      first.verified=true;
      first.human_review={
        action:'approve',source_fingerprint:'sha256:'+'a'.repeat(64),reviewer:'Synthetic test reviewer',
        reviewed_at:'2026-09-01',source_url:cached.features[0].properties.archive_url,
        rationale:'Synthetic first approval.',original_evidence:{scope:'uncertain'},original_collection:'waypoints',
      };
      const second=structuredClone(first);
      second.canonical='London, United Kingdom';
      second.as_written='London';
      second.lat=51.5074;second.lng=-0.1278;
      second.source_quote='A distinct source quotation for London.';
      second.human_review={...second.human_review,source_fingerprint:'sha256:'+'b'.repeat(64),reviewed_at:'2026-09-03'};
      const pending=structuredClone(second);
      pending.canonical='Berlin, Germany';pending.as_written='Berlin';pending.lat=52.52;pending.lng=13.405;
      pending.verified=false;delete pending.human_review;
      pending.evidence={scope:'uncertain',reason:'requires-human-review'};
      cached.features[0].properties.waypoints=[first,second,pending];
      cached.features[0].properties.contextual_places=[];
      const seeded=structuredClone(cached);
      const sameDay=structuredClone(first);
      sameDay.verified=false;
      sameDay.evidence={scope:'contextual',reason:'human-review-reject: synthetic same-day replacement'};
      sameDay.human_review={...sameDay.human_review,action:'reject',rationale:'Synthetic same-day replacement.'};
      const older=structuredClone(second);
      older.verified=false;older.evidence={scope:'contextual',reason:'human-review-context'};
      older.human_review={...older.human_review,action:'context',reviewed_at:'2026-09-02'};
      seeded.features[0].properties.waypoints=[structuredClone(pending)];
      seeded.features[0].properties.contextual_places=[sameDay,older];
      if(payload==='omitted'){
        second.verified=false;
        second.evidence={scope:'contextual',reason:'human-review-reject'};
        second.human_review={...second.human_review,action:'reject'};
        cached.features[0].properties.waypoints=[first,pending];
        cached.features[0].properties.contextual_places=[second];
        const automatic=structuredClone(second);
        delete automatic.human_review;
        automatic.evidence={scope:'personal',reason:'automatic-source-match'};
        seeded.features[0].properties.waypoints.push(automatic);
        seeded.features[0].properties.contextual_places=[sameDay];
      }
      const env=await bindings(seeded);
      env.values.set(worker.DATA_KEY,{value:JSON.stringify(cached),metadata:worker.publicationMetadata(cached)});
      globalThis.fetch=async()=>new Response('<html>No listed profiles</html>');
      await worker.syncSurvivors(env,{publicationStorage:env.storage});
      const published=JSON.parse(env.values.get(worker.DATA_KEY).value);
      await worker.syncSurvivors(env,{publicationStorage:env.storage});
      const repeated=JSON.parse(env.values.get(worker.DATA_KEY).value);
      console.log(JSON.stringify({published,repeated,sameDay,second}));
    """, other_decision)
    feature = result["published"]["features"][0]
    properties = feature["properties"]
    if other_decision == "older":
        assert properties["contextual_places"] == [result["sameDay"]]
        approved = next(point for point in properties["waypoints"] if point["canonical"] == "London, United Kingdom")
        assert approved == result["second"]
    else:
        assert {point["canonical"]: point for point in properties["contextual_places"]} == {
            "Toronto, Canada": result["sameDay"], "London, United Kingdom": result["second"],
        }
        assert not any(point["canonical"] == "London, United Kingdom" for point in properties["waypoints"])
    assert any(point["canonical"] == "Berlin, Germany" and point["verified"] is False for point in properties["waypoints"])
    assert not any(point["canonical"] == "Toronto, Canada" for point in properties["waypoints"])
    assert properties["review_status"] == "pending"
    assert result["published"]["metadata"]["reviewed"] == 0
    assert result["repeated"]["features"][0] == feature


@pytest.mark.parametrize("path", ["/data/index.json", "/sitemap.xml"])
@pytest.mark.parametrize("method", ["GET", "HEAD", "conditional"])
def test_compact_and_sitemap_endpoints_stream_and_revalidate_without_parsing(path, method):
    result = _worker(SETUP + r"""
      const metadata={...worker.publicationMetadata(doc),index_format:1};
      let cancelled=false;
      const stream=new ReadableStream({cancel(){cancelled=true}});
      const request=new Request('https://test.local'+payload.path,{
        method:payload.method==='HEAD'?'HEAD':'GET',
        headers:payload.method==='conditional'?{'if-none-match':`W/"${metadata.version}"`}:{},
      });
      const reads=[];
      const parse=JSON.parse;
      JSON.parse=()=>{throw new Error('HTTP must not parse the index or archive')};
      let response;
      try{
        response=await entry.fetch(request,{
          OHP_DATA:{getWithMetadata:async(key,options)=>{reads.push({key,options});return {value:stream,metadata}}},
        },{});
      }finally{JSON.parse=parse}
      const same=response.body===stream;
      if(same)await response.body.cancel();
      console.log(JSON.stringify({
        status:response.status,same,cancelled,reads,
        expectedKey:payload.path==='/sitemap.xml'?worker.SITEMAP_KEY:worker.INDEX_KEY,
        cache:response.headers.get('cache-control'),csp:response.headers.get('content-security-policy'),
      }));
    """, {"path": path, "method": method})
    assert result["status"] == (304 if method == "conditional" else 200)
    assert result["same"] == (method == "GET")
    assert result["cancelled"]
    assert result["reads"] == [{"key": result["expectedKey"], "options": {"type": "stream"}}]
    assert "immutable" not in result["cache"]
    assert "script-src 'self'" in result["csp"]


def test_live_profile_routes_render_real_metadata_alias_redirects_and_nonempty_404s():
    result = _worker(PUBLICATION_SETUP + r"""
      const env=await bindings();
      const feature=makeFeature('canonical',{
        name:'Real Person',source_aliases:['older-slug'],source_biography:'A literal source biography.',
      });
      await worker.publishCurrentData(env,archive([feature]),{storage:env.storage});
      const page=await entry.fetch(new Request('https://test.local/survivor/canonical'),env,{});
      const html=await page.text(),etag=page.headers.get('etag');
      const cached=await entry.fetch(new Request('https://test.local/survivor/canonical',{headers:{'if-none-match':etag}}),env,{});
      const alias=await entry.fetch(new Request('https://test.local/survivor/older-slug'),env,{});
      const trailing=await entry.fetch(new Request('https://test.local/survivor/canonical/'),env,{});
      const statuses=[];
      for(const path of ['/survivor/missing','/survivor/constructor','/survivor/canonical/extra','/unknown/path']){
        const response=await entry.fetch(new Request('https://test.local'+path),env,{});
        statuses.push({path,status:response.status,body:await response.text(),cache:response.headers.get('cache-control')});
      }
      console.log(JSON.stringify({
        html,status:page.status,cache:page.headers.get('cache-control'),cachedStatus:cached.status,cachedBody:await cached.text(),
        aliasStatus:alias.status,location:alias.headers.get('location'),trailing:trailing.status,statuses,
      }));
    """)
    assert result["status"] == 200
    assert "<title>Real Person | Crestwood Oral History Project</title>" in result["html"]
    assert 'id="server-profile"' in result["html"]
    assert "A literal source biography." in result["html"]
    assert "og:url" in result["html"] and "/survivor/canonical" in result["html"]
    assert result["cachedStatus"] == 304 and result["cachedBody"] == ""
    assert "immutable" not in result["cache"]
    assert result["aliasStatus"] == result["trailing"] == 301
    assert result["location"] == "/survivor/canonical"
    for missing in result["statuses"]:
        assert missing["status"] == 404
        assert "Page not found" in missing["body"] and 'href="/#/explore"' in missing["body"]
        assert missing["cache"] == "no-store"


def test_seed_profile_html_is_served_without_reading_the_full_or_individual_feature():
    result = _worker(PUBLICATION_SETUP + r"""
      const feature=makeFeature('seed-person');
      const seed=archive([feature]),env=await bindings(seed);
      const catalog=JSON.parse(env.bodies.get('/data/catalog.json'));
      const html=renderProfileHtml(shell,feature,{sourceText:'Original source biography from the build.'});
      env.bodies.set(`/data/profile-pages/seed-person.${catalog.profiles['seed-person']}.html`,html);
      const parse=JSON.parse;
      JSON.parse=text=>{
        if(text.includes('"type":"Feature"')||text.includes('"type":"FeatureCollection"'))throw new Error('HTML must use the prepared seed page');
        return parse(text);
      };
      let response;
      try{response=await entry.fetch(new Request('https://test.local/survivor/seed-person'),env,{})}
      finally{JSON.parse=parse}
      console.log(JSON.stringify({
        status:response.status,body:await response.text(),
        fullReads:env.reads.filter(read=>read.key===worker.DATA_KEY||read.key.startsWith('data/profiles/')).length,
      }));
    """)
    assert result["status"] == 200
    assert "Original source biography from the build." in result["body"]
    assert result["fullReads"] == 0


def test_legacy_live_html_uses_literal_source_biography_instead_of_a_curated_map_introduction():
    result = _worker(PUBLICATION_SETUP + r"""
      const env=await bindings();
      const feature=makeFeature('person',{bio_excerpt:'A curated map introduction, not a quotation.'});
      env.bodies.set('/data/biographies/person.json',JSON.stringify({
        source_url:feature.properties.archive_url,text:'The literal biography from the public OHP source.',
        excerpt:'An earlier map introduction.',
      }));
      await worker.publishCurrentData(env,archive([feature]),{storage:env.storage});
      const response=await entry.fetch(new Request('https://test.local/survivor/person'),env,{});
      console.log(JSON.stringify({status:response.status,html:await response.text()}));
    """)
    assert result["status"] == 200
    assert "The literal biography from the public OHP source." in result["html"]
    assert "A curated map introduction, not a quotation." not in result["html"]


@pytest.mark.parametrize("kind", ["bundled", "kv"])
def test_only_exact_hashed_detail_responses_receive_immutable_caching(kind):
    result = _worker(PUBLICATION_SETUP + r"""
      const archiveDoc=archive([makeFeature('person')]);
      const env=await bindings(payload==='bundled'?archiveDoc:archive([]));
      await worker.publishCurrentData(env,archiveDoc,{storage:env.storage});
      const index=JSON.parse(env.values.get(worker.INDEX_KEY).value);
      const path=index.features[0].properties.detail_url;
      const response=await entry.fetch(new Request('https://test.local'+path),env,{});
      const etag=response.headers.get('etag');
      const body=await response.json();
      const cached=await entry.fetch(new Request('https://test.local'+path,{headers:{'if-none-match':`W/${etag}`}}),env,{});
      const head=await entry.fetch(new Request('https://test.local'+path,{method:'HEAD'}),env,{});
      const absent=await entry.fetch(new Request('https://test.local/data/profiles/person.'+'f'.repeat(64)+'.json'),env,{});
      const mutable=await entry.fetch(new Request('https://test.local/js/app.js'),{
        ASSETS:{fetch:async()=>new Response('const application=1',{headers:{'cache-control':'public, max-age=31536000, immutable'}})},
      },{});
      console.log(JSON.stringify({
        body,status:response.status,cache:response.headers.get('cache-control'),source:response.headers.get('x-ohp-source'),
        cached:cached.status,cachedBody:await cached.text(),head:head.status,headBody:await head.text(),
        absent:absent.status,absentBody:await absent.json(),absentCache:absent.headers.get('cache-control'),mutableCache:mutable.headers.get('cache-control'),
      }));
    """, kind)
    assert result["status"] == 200 and result["source"] == kind
    assert "max-age=31536000, immutable" in result["cache"]
    assert result["body"]["properties"]["survivor_id"] == "person"
    assert result["cached"] == 304 and result["cachedBody"] == ""
    assert result["head"] == 200 and result["headBody"] == ""
    assert result["absent"] == 404 and result["absentCache"] == "no-store"
    assert result["absentBody"]["collection_url"] == "/#/explore"
    assert result["mutableCache"] == "public, max-age=0, must-revalidate"


def test_headers_cover_html_data_errors_and_intended_crestwood_vimeo_embeds():
    result = _worker(PUBLICATION_SETUP + r"""
      const env=await bindings(archive([makeFeature('person')]));
      const requests=[
        new Request('https://test.local/'),
        new Request('https://test.local/data/index.json'),
        new Request('https://test.local/not-found'),
        new Request('https://test.local/data/index.json',{method:'POST'}),
        new Request('https://test.local/__sync',{method:'POST'}),
      ];
      const responses=[];
      for(const request of requests){
        const response=await entry.fetch(request,env,{});
        responses.push({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
      }
      console.log(JSON.stringify(responses));
    """)
    assert [response["status"] for response in result] == [200, 200, 404, 405, 503]
    for response in result:
        headers = response["headers"]
        csp = headers["content-security-policy"]
        assert "script-src 'self'" in csp and "unsafe-eval" not in csp
        assert "style-src 'self' 'unsafe-inline'" in csp
        assert "https://player.vimeo.com" in csp and "https://ohp.crestwood.on.ca" in csp
        assert "frame-ancestors 'self' https://crestwood.on.ca" in csp
        assert "https://*.crestwood.on.ca" in csp
        assert "x-frame-options" not in headers
        assert headers["x-content-type-options"] == "nosniff"
        assert headers["referrer-policy"] == "strict-origin-when-cross-origin"
        assert "camera=()" in headers["permissions-policy"]
        assert 'fullscreen=(self "https://player.vimeo.com")' in headers["permissions-policy"]
        if response["status"] >= 400:
            assert headers["cache-control"] == "no-store" and response["body"]


def test_worker_owns_headers_routing_and_real_not_found_responses():
    import tomllib

    config = tomllib.loads((ROOT / "wrangler.toml").read_text(encoding="utf-8"))
    assert config["assets"]["run_worker_first"] is True
    assert config["assets"]["html_handling"] == "none"
    assert config["assets"]["not_found_handling"] == "none"
    assert config["vars"]["SITE_ORIGIN"] == "https://ohpmap.alexdong0414.workers.dev"
    assert config["durable_objects"]["bindings"] == [{"name": "ARCHIVE_SYNC", "class_name": "ArchiveSync"}]
