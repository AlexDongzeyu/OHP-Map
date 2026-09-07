"""Local saved-list backup and additive recovery contracts."""
import json

import pytest

from test_research_tools import _node


def test_backup_round_trips_the_entire_selection_without_filters_or_source_data():
    data = _node(r"""
import {savedListFile,decodeSavedListFile} from './js/research-tools.js';
const byId=new Map([['old-name',{id:'canonical'}],['canonical',{id:'canonical'}]]);
const text=savedListFile(['old-name','canonical','temporarily-unavailable','canonical']);
console.log(JSON.stringify({file:JSON.parse(text),restored:[...decodeSavedListFile(text,byId)]}));
""")
    assert data["file"] == {"format": "ohp-saved-accounts", "version": 1,
                            "ids": ["old-name", "canonical", "temporarily-unavailable"]}
    assert data["restored"] == ["canonical", "temporarily-unavailable"]


@pytest.mark.parametrize("count", [0, 1, 10_000])
def test_backup_zero_one_and_ten_thousand_accounts_are_not_truncated(count):
    data = _node(r"""
import {savedListFile,decodeSavedListFile} from './js/research-tools.js';
const ids=Array.from({length:%d},(_,index)=>`account-${index}`);
const text=savedListFile(ids),restored=[...decodeSavedListFile(text,new Map())];
console.log(JSON.stringify({count:restored.length,identical:JSON.stringify(ids)===JSON.stringify(restored)}));
""" % count)
    assert data == {"count": count, "identical": True}


@pytest.mark.parametrize("file", [
    None, 12, "", "{", "null", "[]",
    '{"version":1,"ids":["adam-wally"]}',
    '{"format":"ohp-saved-accounts","version":2,"ids":[]}',
    '{"format":"ohp-saved-accounts","version":1,"ids":null}',
    '{"format":"ohp-saved-accounts","version":1,"ids":[1]}',
    '{"format":"ohp-saved-accounts","version":1,"ids":["../survivor/adam-wally"]}',
    '{"format":"ohp-saved-accounts","version":1,"ids":["<img onerror=alert(1)>"]}',
    '{"format":"ohp-saved-accounts","version":1,"ids":["Łódź"]}',
    '{"format":"ohp-saved-accounts","version":1,"ids":[],"notes":"not retained"}',
    '{"format":"ohp-saved-accounts","version":1,"ids":[],"__proto__":{"polluted":true}}',
])
def test_unsupported_files_are_rejected_without_a_write(file):
    data = _node("""
import {decodeSavedListFile,SavedListFileError,SavedAccountsError} from './js/research-tools.js';
let rejected=false;
try { decodeSavedListFile(%s,new Map()); }
catch(error) { rejected=error instanceof SavedListFileError||error instanceof SavedAccountsError; }
console.log(JSON.stringify({rejected,polluted:Boolean({}.polluted)}));
""" % json.dumps(file))
    assert data == {"rejected": True, "polluted": False}


def test_file_limits_measure_utf8_bytes_and_reject_extra_accounts():
    data = _node(r"""
import {decodeSavedListFile,savedListFile,SavedListFileError,MAX_SAVED_LIST_FILE_BYTES} from './js/research-tools.js';
const large=JSON.stringify({format:'ohp-saved-accounts',version:1,ids:['a'.repeat(MAX_SAVED_LIST_FILE_BYTES)]});
const unicode=JSON.stringify({format:'ohp-saved-accounts',version:1,ids:['\u00e9'.repeat(500000)]});
const failures=[];
for(const run of [()=>decodeSavedListFile(large,new Map()),()=>decodeSavedListFile(unicode,new Map()),
  ()=>savedListFile(Array.from({length:10001},(_,index)=>`account-${index}`))]){
  try{run();failures.push(false)}catch(error){failures.push(error instanceof SavedListFileError)}
}
console.log(JSON.stringify({failures}));
""")
    assert data["failures"] == [True, True, True]


def test_restore_merges_the_latest_storage_and_preserves_missing_ids():
    data = _node(r"""
import {restoreSavedList,SAVED_ACCOUNTS_KEY} from './js/research-tools.js';
let value=JSON.stringify({version:1,ids:['other-tab-save','not-currently-public']});
let writes=0;
const storage={getItem:key=>{if(key!==SAVED_ACCOUNTS_KEY)throw Error('wrong key');return value},
  setItem:(key,text)=>{if(key!==SAVED_ACCOUNTS_KEY)throw Error('wrong key');writes++;value=text}};
const byId=new Map([['old-alias',{id:'canonical'}],['canonical',{id:'canonical'}]]);
const first=restoreSavedList(storage,byId,['old-alias','canonical','missing-from-backup']);
const second=restoreSavedList(storage,byId,['old-alias','missing-from-backup']);
console.log(JSON.stringify({first:[...first.ids],added:first.added,again:second.added,writes,stored:JSON.parse(value).ids}));
""")
    expected = ["other-tab-save", "not-currently-public", "canonical", "missing-from-backup"]
    assert data == {"first": expected, "added": 2, "again": 0, "writes": 1, "stored": expected}


@pytest.mark.parametrize("mode", ["corrupt", "blocked-read", "blocked-write", "oversized-merge", "invalid-ids"])
def test_failed_restores_leave_previous_data_unchanged(mode):
    data = _node("""
import {restoreSavedList,SavedListFileError,isSavedAccountsFailure} from './js/research-tools.js';
const mode=%s;
const initial=mode==='corrupt'?'{"version":2,"ids":["existing"]}':
  JSON.stringify({version:1,ids:mode==='oversized-merge'?Array.from({length:10000},(_,i)=>`existing-${i}`):['existing']});
let value=initial,writes=0,rejected=false,returned=false;
const storage={getItem:()=>{if(mode==='blocked-read')throw new DOMException('Denied','SecurityError');return value},
  setItem:(key,next)=>{if(mode==='blocked-write')throw new DOMException('Full','QuotaExceededError');writes++;value=next}};
try { restoreSavedList(storage,new Map(),mode==='invalid-ids'?['<script>']:['new-account']);returned=true; }
catch(error) { rejected=error instanceof SavedListFileError||isSavedAccountsFailure(error); }
console.log(JSON.stringify({unchanged:value===initial,writes,rejected,returned}));
""" % json.dumps(mode))
    assert data == {"unchanged": True, "writes": 0, "rejected": True, "returned": False}


def test_only_account_ids_enter_the_file_and_preview_escapes_source_names():
    data = _node(r"""
globalThis.window={matchMedia:()=>({matches:false})};
const {savedListFile}=await import('./js/research-tools.js');
const {savedListFilePreview,savedListDialog}=await import('./js/ui.js');
const byId=new Map([['known',{id:'known',name:'<img src=x onerror=alert(1)>',
  sourceProperties:{private:'not part of a backup'}}]]);
const preview=savedListFilePreview(new Set(['known','missing']),{byId});
const dialog=savedListDialog({savedIds:new Set(),savedError:''});
console.log(JSON.stringify({file:JSON.parse(savedListFile(['known','missing'])),escaped:preview.includes('&lt;img'),
  noImage:!preview.includes('<img'),missing:preview.includes('not available'),hasRestore:dialog.includes('type="file"'),
  scope:dialog.includes('regardless of filters'),autofocus:dialog.includes('aria-describedby="saved-backup-help" autofocus')}));
""")
    assert data == {"file": {"format": "ohp-saved-accounts", "version": 1, "ids": ["known", "missing"]},
                    "escaped": True, "noImage": True, "missing": True, "hasRestore": True,
                    "scope": True, "autofocus": True}


def test_unavailable_saved_ids_are_counted_and_do_not_look_like_an_unused_list():
    data = _node(r"""
globalThis.window={matchMedia:()=>({matches:false})};
const {railInner,readingListTools,savedViewLabel,savedListDialog,exploreHint}=await import('./js/ui.js');
const store={journeys:[],byId:new Map(),groups:[]};
const state={savedOnly:true,savedIds:new Set(['not-currently-public']),groupFilter:new Set(),query:'',savedError:''};
const empty=railInner(store,state).html,tools=readingListTools(store,state);
console.log(JSON.stringify({unavailable:empty.includes('Saved accounts are missing from this version of the archive'),
  notEmpty:!empty.includes('Keep an account for later'),retained:tools.includes('remains in your saved list and backups'),
  retry:tools.includes('data-act="reload-collection"'),
  count:savedViewLabel(store,{...state,savedOnly:false}).includes('<span>1</span>'),
  map:exploreHint(store,state,0).includes('These saved accounts are missing from this version of the archive'),
  secondary:savedListDialog(state).includes('class="btn btn-ghost" data-download-saved-backup')}));
""")
    assert all(data.values()), data


@pytest.mark.parametrize("mode", ["empty", "filtered", "error"])
def test_missing_saved_disclosure_does_not_replace_other_empty_or_error_states(mode):
    data = _node("""
globalThis.window={matchMedia:()=>({matches:false})};
const {railInner,readingListTools,exploreHint}=await import('./js/ui.js');
const mode=%s;
const journey={id:'available',name:'Available Account',group:'First',hometown:'',
  conflicts:[],themes:[],waypoints:[]};
const store={journeys:mode==='filtered'?[journey]:[],
  byId:new Map(mode==='filtered'?[['available',journey]]:[]),groups:[{name:'First',count:1}]};
const state={savedOnly:true,savedIds:new Set(mode==='empty'?[]:mode==='filtered'?['available','missing']:['missing']),
  groupFilter:new Set(mode==='filtered'?[]:['First']),query:'',
  savedError:mode==='error'?'Storage could not be read':''};
console.log(JSON.stringify({html:railInner(store,state).html,tools:readingListTools(store,state),
  hint:exploreHint(store,state,0)}));
""" % json.dumps(mode))
    assert "Saved accounts are missing from this version of the archive" not in data["html"]
    if mode == "empty":
        assert "Keep an account for later" in data["html"]
        assert "not available in this version of the archive" not in data["tools"]
        assert "saved list is empty" in data["hint"]
    elif mode == "filtered":
        assert "No communities selected" in data["html"]
        assert "Show all saved accounts" in data["html"]
        assert "1 account is" in data["tools"]
        assert "No accounts match these filters" in data["hint"]
    else:
        assert "Saved accounts are unavailable" in data["html"]
        assert "not available in this version of the archive" not in data["tools"]
        assert "saved list could not be read" in data["hint"]
