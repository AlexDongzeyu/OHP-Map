"""Caption-led discovery and honest, source-complete print output."""
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def _node(code):
    result = subprocess.run(
        ["node", "--input-type=module", "-e", code],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    return json.loads(result.stdout)


def test_caption_filter_intersects_search_places_and_private_or_shared_lists():
    data = _node(r"""
globalThis.window={matchMedia:()=>({matches:false})};
const {collectionResults,collectionPlaces}=await import('./js/data.js');
const {captionedResultCount,filterSummary}=await import('./js/ui.js');
const base={hometown:'',conflicts:[],themes:[],waypoints:[{canonical:'London',asWritten:'London',locationPrecision:'city'}]};
const store={groups:[{name:'First'},{name:'Second'}],journeys:[
  {...base,id:'a',name:'A',group:'First',videoCount:8,captionedVideoCount:0},
  {...base,id:'b',name:'B',group:'First',videoCount:8,captionedVideoCount:3},
  {...base,id:'c',name:'C',group:'Second',videoCount:1,captionedVideoCount:1},
]};
const state={groupFilter:new Set(['First','Second']),query:'',captionedOnly:true,savedIds:new Set(['a','b'])};
console.log(JSON.stringify({
  all:collectionResults(store,state).map(j=>j.id),
  saved:collectionResults(store,{...state,savedOnly:true}).map(j=>j.id),
  shared:collectionResults(store,{...state,sharedIds:new Set(['a','c'])}).map(j=>j.id),
  query:collectionResults(store,{...state,query:'A'}).map(j=>j.id),
  places:collectionPlaces(store,state),
  count:captionedResultCount(store,state),summary:filterSummary(store,state),
  unfiltered:collectionResults(store,{...state,captionedOnly:false}).length,
}));
""")
    assert data["all"] == ["b", "c"]
    assert data["saved"] == ["b"] and data["shared"] == ["c"]
    assert data["query"] == []
    assert data["places"][0]["count"] == data["count"] == 2
    assert data["summary"] == "All + captions" and data["unfiltered"] == 3


SOURCE_SETUP = r"""
import fs from 'node:fs';
globalThis.window={matchMedia:()=>({matches:false})};
globalThis.fetch=async name=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(name,'utf8'))});
const {loadData}=await import('./js/data.js');
const ui=await import('./js/ui.js');
const store=await loadData();
const accessed=new Date(2026,8,6,12);
const address='https://example.test/survivor/ferguson-george?q=private#/explore?saved=1';
"""


def test_printed_account_preserves_every_reference_summary_and_source_citation():
    data = _node(SOURCE_SETUP + r"""
const journey=store.byId.get('ferguson-george');
const html=ui.printAccount(journey,address,accessed);
console.log(JSON.stringify({
  count:journey.waypoints.length,
  allPlaces:journey.waypoints.every(place=>html.includes(place.canonical.replace(/&/g,'&amp;'))),
  summary:html.includes(journey.bio.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')),
  citation:html.includes('Accessed September 6, 2026.'),
  source:html.includes(journey.archiveUrl),
  context:html.includes('Other places in the source'),
  honest:html.includes('not been fully reviewed')&&html.includes('not a verbatim interview transcript'),
  privateFilter:html.includes('q=private')||html.includes('saved=1'),
  interactive:html.includes('data-place-step')||html.includes('<iframe'),
}));
""")
    assert data["count"] == 14 and data["allPlaces"] and data["summary"]
    assert data["citation"] and data["source"] and data["context"] and data["honest"]
    assert not data["privateFilter"] and not data["interactive"]


def test_printing_unloaded_details_is_explicitly_incomplete():
    data = _node(SOURCE_SETUP + r"""
const journey=store.byId.get('adam-wally');
journey.detailState='unloaded';journey.bio='';
const html=ui.printAccount(journey,address,accessed);
console.log(JSON.stringify({
  incomplete:html.includes('not a complete reading sheet'),
  references:html.includes('class="print-references"'),
  source:html.includes(journey.archiveUrl),
}));
""")
    assert data["incomplete"] and data["source"]
    assert not data["references"]


def test_printed_audit_does_not_reinstate_a_stale_approval():
    data = _node(SOURCE_SETUP + r"""
const journey=store.byId.get('adam-wally');
journey.waypoints[0].humanReview={
  action:'approve',reviewer:'Test reviewer',reviewed_at:'2026-09-01',
  rationale:'A changed source needs checking again.',source_url:journey.archiveUrl,
};
journey.waypoints[0].verified=false;
const html=ui.printAccount(journey,address,accessed);
console.log(JSON.stringify({stale:html.includes('Prior review needs rechecking'),checked:html.includes('Human-checked reference.')}));
""")
    assert data["stale"] and not data["checked"]


def test_printed_reading_list_keeps_exact_selection_and_unavailable_notice():
    data = _node(SOURCE_SETUP + r"""
const journeys=['adler-amek','baranek-martin'].map(id=>store.byId.get(id));
const html=ui.printReadingList(journeys,address,accessed,1);
console.log(JSON.stringify({
  count:html.includes('Sources for 2 accounts'),
  first:html.includes('Amek Adler'),second:html.includes('Martin Baranek'),
  excluded:html.includes('Wally Adam'),missing:html.includes('1 account in the shared link is not available'),
  dates:(html.match(/Accessed September 6, 2026/g)||[]).length,
  privateFilter:html.includes('q=private')||html.includes('saved=1'),
  caveat:html.includes('do not infer interview dates'),
}));
""")
    assert data["count"] and data["first"] and data["second"] and data["missing"] and data["caveat"]
    assert data["dates"] == 2 and not data["excluded"] and not data["privateFilter"]
