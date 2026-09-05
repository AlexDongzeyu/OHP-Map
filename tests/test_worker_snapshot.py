"""Serve validated publications without parsing a large archive on HTTP requests."""
import pytest

from test_worker_media import _worker


SETUP = r"""
const doc = {
  type:'FeatureCollection',
  metadata:{
    gazetteer_revision:worker.GAZETTEER_REVISION,
    content_revision:worker.CONTENT_REVISION,
    time_min:worker.HISTORY_MIN_YEAR,
    time_max:worker.HISTORY_MAX_YEAR,
  },
  features:[],
};
const syncURL = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const runnerSource = fs.readFileSync('worker/archive-sync.js','utf8')
  .replace('from "./sync.js"', `from ${JSON.stringify(syncURL)}`);
const runnerURL = `data:text/javascript;base64,${Buffer.from(runnerSource).toString('base64')}`;
const entrySource = fs.readFileSync('worker/index.js','utf8')
  .replace('from "./sync.js"', `from ${JSON.stringify(syncURL)}`)
  .replace('from "./archive-sync.js"', `from ${JSON.stringify(runnerURL)}`);
const entry = (await import(`data:text/javascript;base64,${Buffer.from(entrySource).toString('base64')}`)).default;
"""


def test_current_publication_is_streamed_without_reading_or_parsing_the_body():
    result = _worker(SETUP + r"""
      const metadata = worker.publicationMetadata(doc);
      const text = JSON.stringify(doc);
      const stream = new Response(text).body;
      const reads = [];
      const env = {
        OHP_DATA:{
          get:async()=>{throw new Error('HTTP must not read the processing cache')},
          getWithMetadata:async(key,options)=>{reads.push({key,options});return {value:stream,metadata}},
        },
        ASSETS:{fetch:async()=>{throw new Error('unexpected bundled fallback')}},
      };
      const request = new Request('https://test.local/data/survivors.geojson');
      const parse = JSON.parse;
      JSON.parse = ()=>{throw new Error('HTTP must not parse the archive')};
      let response;
      try { response=await entry.fetch(request,env,{}); }
      finally { JSON.parse=parse; }
      const sameStream = response.body===stream;
      console.log(JSON.stringify({
        sameStream,reads,status:response.status,text:await response.text(),
        source:response.headers.get('x-ohp-source'),etag:response.headers.get('etag'),
        expected:text,dataKey:worker.DATA_KEY,version:metadata.version,
      }));
    """)
    assert result["sameStream"]
    assert result["reads"] == [{"key": result["dataKey"], "options": {"type": "stream"}}]
    assert result["status"] == 200
    assert result["source"] == "kv"
    assert result["text"] == result["expected"]
    assert result["etag"] == f'"{result["version"]}"'


@pytest.mark.parametrize("kind", ["etag", "weak-etag", "head"])
def test_unchanged_or_head_requests_do_not_download_the_archive(kind):
    result = _worker(SETUP + r"""
      const metadata=worker.publicationMetadata(doc);
      let cancelled=false;
      const stream=new ReadableStream({cancel(){cancelled=true}});
      const tag=`"${metadata.version}"`;
      const request=new Request('https://test.local/data/survivors.geojson',{
        method:payload==='head'?'HEAD':'GET',
        headers:payload==='head'?{}:{'if-none-match':payload==='weak-etag'?`"older", W/${tag}`:tag},
      });
      const response=await entry.fetch(request,{
        OHP_DATA:{getWithMetadata:async()=>({value:stream,metadata})},
      },{});
      console.log(JSON.stringify({status:response.status,cancelled,body:await response.text(),etag:response.headers.get('etag'),tag}));
    """, kind)
    assert result["status"] == (200 if kind == "head" else 304)
    assert result["cancelled"]
    assert result["body"] == ""
    assert result["etag"] == result["tag"]


@pytest.mark.parametrize("kind", ["missing", "old-revision", "missing-metadata"])
def test_unvalidated_publications_use_the_explicit_bundled_fallback(kind):
    result = _worker(SETUP + r"""
      let cancelled=false;
      const metadata=worker.publicationMetadata(doc);
      if(payload==='old-revision')metadata.content_revision='old';
      const stream=payload==='missing'?null:new ReadableStream({cancel(){cancelled=true}});
      const warnings=[];
      console.warn=(message)=>warnings.push(message);
      const response=await entry.fetch(new Request('https://test.local/data/survivors.geojson'),{
        OHP_DATA:{getWithMetadata:async(key)=>key===worker.DATA_KEY
          ?{value:stream,metadata:payload==='missing-metadata'?null:metadata}:{value:null,metadata:null}},
        ASSETS:{fetch:async()=>new Response('bundled archive',{headers:{'content-type':'application/json'}})},
      },{});
      console.log(JSON.stringify({cancelled,warnings,status:response.status,body:await response.text(),source:response.headers.get('x-ohp-source')}));
    """, kind)
    assert result["cancelled"] == (kind != "missing")
    assert result["warnings"]
    assert result["status"] == 200
    assert result["body"] == "bundled archive"
    assert result["source"] == "bundled"


def test_publication_attaches_revision_metadata_without_duplicate_data_writes():
    result = _worker(SETUP + r"""
      const writes=[];
      await worker.publishCurrentData({OHP_DATA:{put:async(key,value,options)=>writes.push({key,value,options})}},doc);
      const published=writes.find(write=>write.key===worker.DATA_KEY);
      console.log(JSON.stringify({
        writes,processingKey:worker.DATA_KEY,publicKey:worker.PUBLIC_DATA_KEY,
        current:worker.isCurrentPublication(published.options.metadata),
      }));
    """)
    assert len(result["writes"]) == 1
    assert result["writes"][0]["key"] == result["processingKey"]
    assert result["current"]


def test_a_validated_snapshot_bridges_legacy_metadata_without_overwriting_live_data():
    result = _worker(SETUP + r"""
      const metadata=worker.publicationMetadata(doc);
      let legacyCancelled=false,writes=0;
      const legacy=new ReadableStream({cancel(){legacyCancelled=true}});
      const published=new Response(JSON.stringify(doc)).body;
      const reads=[];
      const response=await entry.fetch(new Request('https://test.local/data/survivors.geojson'),{
        OHP_DATA:{
          getWithMetadata:async(key,options)=>{
            reads.push({key,options});
            return key===worker.DATA_KEY?{value:legacy,metadata:null}:{value:published,metadata};
          },
          put:async()=>{writes++},
        },
        ASSETS:{fetch:async()=>{throw new Error('unexpected fallback')}},
      },{});
      console.log(JSON.stringify({
        legacyCancelled,writes,reads,sameStream:response.body===published,
        source:response.headers.get('x-ohp-publication'),dataKey:worker.DATA_KEY,publicKey:worker.PUBLIC_DATA_KEY,
      }));
    """)
    assert result["legacyCancelled"]
    assert result["sameStream"]
    assert result["writes"] == 0
    assert result["source"] == "validated-snapshot"
    assert [entry["key"] for entry in result["reads"]] == [result["dataKey"], result["publicKey"]]


def test_outdated_publications_are_rejected_before_any_write():
    result = _worker(SETUP + r"""
      doc.metadata.content_revision='old';
      let writes=0,error=null;
      try {await worker.publishCurrentData({OHP_DATA:{put:async()=>{writes++}}},doc)}
      catch(failure){error=failure.message}
      console.log(JSON.stringify({writes,error}));
    """)
    assert result["writes"] == 0
    assert "outdated" in result["error"]


def test_cron_queues_the_durable_runner_without_reading_the_archive():
    result = _worker(SETUP + r"""
      const requests=[],background=[];
      const env={
        OHP_DATA:{get:async()=>{throw new Error('cron must not parse archive data')}},
        ARCHIVE_SYNC:{
          idFromName:name=>name,
          get:id=>({fetch:async(url,options)=>{requests.push({id,url,method:options.method});return new Response(null,{status:202})}}),
        },
      };
      await entry.scheduled({},env,{waitUntil:promise=>background.push(promise)});
      await Promise.all(background);
      console.log(JSON.stringify({requests,count:background.length}));
    """)
    assert result["count"] == 1
    assert result["requests"] == [{
        "id": "archive", "url": "https://archive-sync.internal/run", "method": "POST",
    }]


def test_compatibility_reads_queue_background_preparation_without_buffering():
    result = _worker(SETUP + r"""
      const metadata=worker.publicationMetadata(doc);
      const stream=new Response(JSON.stringify(doc)).body;
      const requests=[],background=[];
      const response=await entry.fetch(new Request('https://test.local/data/survivors.geojson'),{
        OHP_DATA:{getWithMetadata:async(key)=>key===worker.DATA_KEY?{value:null,metadata:null}:{value:stream,metadata}},
        ARCHIVE_SYNC:{
          idFromName:name=>name,
          get:()=>({fetch:async(url)=>{requests.push(url);return new Response(null,{status:202})}}),
        },
      },{waitUntil:promise=>background.push(promise)});
      const sameStream=response.body===stream;
      await Promise.all(background);
      console.log(JSON.stringify({sameStream,requests}));
    """)
    assert result["sameStream"]
    assert result["requests"] == ["https://archive-sync.internal/bootstrap"]
