"""Account map overviews expose geography without inventing missing routes."""
from test_collection_tools import _node


def test_all_located_accounts_get_a_map_not_only_connected_routes():
    data = _node(r"""
import fs from 'node:fs';
globalThis.window={matchMedia:()=>({matches:false})};
globalThis.fetch=async name=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(name,'utf8'))});
const {loadData}=await import('./js/data.js');
const {accountMapOverview}=await import('./js/ui.js');
const store=await loadData();
let mapped=0,unlocated=0,withoutRoute=0;
const failures=[];
for(const journey of store.journeys){
 const points=journey.waypoints.filter(point=>Number.isFinite(point.lng)&&Number.isFinite(point.lat));
 const html=accountMapOverview(journey);
 if(points.length){
  mapped++;if(journey.routeWaypoints.length<2)withoutRoute++;
  if(!html.includes('data-mini')||!html.includes('Current borders')||!html.includes('Open larger map'))failures.push(journey.id);
 }else{
  unlocated++;
  if(html.includes('data-mini')||!html.includes('No account locations to plot yet.')||!html.includes(journey.archiveUrl))failures.push(journey.id);
 }
}
console.log(JSON.stringify({accounts:store.journeys.length,mapped,unlocated,withoutRoute,failures}));
""")
    assert data["mapped"] + data["unlocated"] == data["accounts"]
    assert data["mapped"] > 1000 and data["withoutRoute"] > 700
    assert not data["failures"]


def test_single_broad_unreviewed_and_repeated_points_do_not_promise_a_route():
    data = _node(r"""
globalThis.window={matchMedia:()=>({matches:false})};
const {accountMapOverview}=await import('./js/ui.js');
const p={canonical:'Toronto, Canada',lng:-79.38,lat:43.65,verified:false,evidenceScope:'personal',locationPrecision:'city'};
const base={name:'A source <script>name</script>',archiveUrl:'https://ohp.crestwood.on.ca/ohp/test/',waypoints:[],routeWaypoints:[]};
const show=(points,routePoints=points)=>accountMapOverview({...base,waypoints:points,routeWaypoints:routePoints});
const single=show([p]),repeated=show([p,{...p}]);
const broad=show([{...p,locationPrecision:'country'},{...p,lng:2.3,locationPrecision:'country'}]);
const unreviewed=show([{...p,evidenceScope:'uncertain'},{...p,lng:2.3,evidenceScope:'uncertain'}]);
const route=show([p,{...p,lng:2.3}]);
console.log(JSON.stringify({
 noPromise:[single,repeated,broad,unreviewed].every(html=>html.includes('data-mini')&&!html.includes('Lines connect')),
 route:route.includes('Lines connect source-linked city and site references, not exact travel paths.'),
 escaped:single.includes('&lt;script&gt;')&&!single.includes('<script>'),
}));
""")
    assert data["noPromise"] and data["route"] and data["escaped"]


def test_absent_or_invalid_coordinates_do_not_render_an_empty_svg():
    data = _node(r"""
globalThis.window={matchMedia:()=>({matches:false})};
const {accountMapOverview}=await import('./js/ui.js');
const journey={name:'Unlocated account',archiveUrl:'https://ohp.crestwood.on.ca/ohp/test/',
 waypoints:[{lat:null,lng:null},{lat:Infinity,lng:NaN}],routeWaypoints:[]};
const html=accountMapOverview(journey);
console.log(JSON.stringify({empty:html.includes('data-mini'),source:html.includes(journey.archiveUrl),notice:html.includes('No account locations to plot yet.')}));
""")
    assert not data["empty"] and data["source"] and data["notice"]
