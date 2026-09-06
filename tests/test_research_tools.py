"""Local reading lists and source-grounded reference tools."""
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


def test_saved_accounts_preserve_aliases_unknown_entries_and_other_tab_changes():
    data = _node(r"""
import {SAVED_ACCOUNTS_KEY,readSavedAccounts,updateSavedAccount} from './js/research-tools.js';
const byId=new Map([
  ['canonical',{id:'canonical'}],['old-alias',{id:'canonical'}],['second',{id:'second'}],
]);
let value=JSON.stringify({version:1,ids:['old-alias','canonical','not-currently-public']});
const storage={getItem:key=>{if(key!==SAVED_ACCOUNTS_KEY)throw new Error('wrong key');return value},
  setItem:(key,next)=>{value=next}};
const initial=[...readSavedAccounts(storage,byId)];
updateSavedAccount(storage,byId,'second',true);
const saved=JSON.parse(value);
updateSavedAccount(storage,byId,'old-alias',false);
console.log(JSON.stringify({initial,saved,removed:JSON.parse(value)}));
""")
    assert data["initial"] == ["canonical", "not-currently-public"]
    assert data["saved"] == {"version": 1, "ids": ["canonical", "not-currently-public", "second"]}
    assert data["removed"] == {"version": 1, "ids": ["not-currently-public", "second"]}


@pytest.mark.parametrize("value", ['{', '[]', '{"version":2,"ids":[]}', '{"version":1,"ids":[42]}',
                                 '{"version":1,"ids":["<script>"]}'])
def test_invalid_saved_lists_are_not_silently_overwritten(value):
    data = _node("""
import {decodeSavedAccounts,SavedAccountsError} from './js/research-tools.js';
let rejected=false;
try { decodeSavedAccounts(%s,new Map()); }
catch(error){rejected=error instanceof SavedAccountsError;}
console.log(JSON.stringify({rejected}));
""" % json.dumps(value))
    assert data["rejected"]


def test_failed_storage_writes_propagate_and_do_not_return_a_successful_save():
    data = _node(r"""
import {updateSavedAccount,isSavedAccountsFailure} from './js/research-tools.js';
let value=JSON.stringify({version:1,ids:['first']});
const storage={getItem:()=>value,setItem:()=>{throw new DOMException('Blocked','QuotaExceededError')}};
let failure=null,returned=false;
try{updateSavedAccount(storage,new Map([['second',{id:'second'}]]),'second',true);returned=true}
catch(error){failure=isSavedAccountsFailure(error)}
console.log(JSON.stringify({failure,returned,value:JSON.parse(value)}));
""")
    assert data == {"failure": True, "returned": False, "value": {"version": 1, "ids": ["first"]}}


def test_account_references_are_canonical_and_cite_only_the_original_page():
    data = _node(r"""
import {accountLink,accountCitation} from './js/research-tools.js';
const account={id:'adam-wally',name:'Wally Adam',archiveUrl:'https://ohp.crestwood.on.ca/ohp/adam-wally/'};
console.log(JSON.stringify({
  link:accountLink(account,'https://example.test/map/?release=test#/survivor/adam-wally?q=private&saved=1'),
  citation:accountCitation(account,new Date(2026,8,6,12)),
}));
""")
    assert data["link"] == "https://example.test/map/#/survivor/adam-wally"
    assert data["citation"] == (
        'Crestwood Oral History Project. "Wally Adam." '
        'https://ohp.crestwood.on.ca/ohp/adam-wally/ Accessed September 6, 2026.'
    )
    assert "interviewed" not in data["citation"].lower()


def test_clipboard_permission_failure_is_distinguished_from_unexpected_errors():
    data = _node(r"""
import {copyText} from './js/research-tools.js';
let output=null,unexpected=false;
const success=await copyText('source reference',{writeText:async text=>{output=text}});
const unavailable=await copyText('text',undefined);
const blocked=await copyText('text',{writeText:async()=>{throw new DOMException('Denied','NotAllowedError')}});
try{await copyText('text',{writeText:async()=>{throw new Error('Unexpected failure')}})}
catch(error){unexpected=error.message==='Unexpected failure'}
console.log(JSON.stringify({success,output,unavailable,blocked,unexpected}));
""")
    assert data == {"success": True, "output": "source reference", "unavailable": False,
                    "blocked": False, "unexpected": True}


def test_collection_order_is_stable_across_pages_and_saved_filters():
    data = _node(r"""
globalThis.window={matchMedia:()=>({matches:false})};
const {collectionResults}=await import('./js/data.js');
const base={hometown:'',conflicts:[],themes:[],waypoints:[]};
const store={groups:[{name:'First'},{name:'Second'}],journeys:[
  {...base,id:'a',name:'A',group:'Second'},{...base,id:'b',name:'B',group:'First'},
  {...base,id:'c',name:'C',group:'Second'},{...base,id:'d',name:'D',group:'First'},
]};
const state={query:'',groupFilter:new Set(['First','Second']),savedIds:new Set(['c','d'])};
console.log(JSON.stringify({
  all:collectionResults(store,state).map(j=>j.id),
  saved:collectionResults(store,{...state,savedOnly:true}).map(j=>j.id),
  empty:collectionResults(store,{...state,savedOnly:true,savedIds:new Set()}).length,
}));
""")
    assert data == {"all": ["b", "d", "a", "c"], "saved": ["d", "c"], "empty": 0}


def test_every_public_account_has_a_valid_reference():
    data = _node(r"""
import fs from 'node:fs';
globalThis.window={matchMedia:()=>({matches:false})};
globalThis.fetch=async name=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(name,'utf8'))});
const {loadData}=await import('./js/data.js');
const {accountLink,accountCitation}=await import('./js/research-tools.js');
const store=await loadData();
let valid=0;
for(const journey of store.journeys){
  const citation=accountCitation(journey,new Date(2026,8,6,12));
  const link=accountLink(journey,'https://example.test/');
  if(citation.includes(journey.archiveUrl)&&link.includes(journey.id))valid++;
}
console.log(JSON.stringify({valid,total:store.journeys.length}));
""")
    assert data["valid"] == data["total"]
    assert data["total"] > 1000
