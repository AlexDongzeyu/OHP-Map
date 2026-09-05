"""Heavy archive refreshes run in a deduplicated Durable Object alarm, not HTTP."""
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def test_refresh_is_queued_deduplicated_and_completed_by_an_alarm():
    script = r"""
import fs from 'node:fs';
const stub = `export const PUBLIC_DATA_KEY='current-contract';
export async function syncSurvivors(env){env.calls++;if(env.fail)throw new Error('refresh failed');return {state:env.state};}`;
const stubURL='data:text/javascript;base64,'+Buffer.from(stub).toString('base64');
const source=fs.readFileSync('worker/archive-sync.js','utf8').replace('from "./sync.js"',`from "${stubURL}"`);
const {ArchiveSync}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const values=new Map();
let alarm=null;
const storage={
  get:async key=>values.get(key),
  put:async(key,value)=>values.set(key,value),
  delete:async key=>values.delete(key),
  getAlarm:async()=>alarm,
  setAlarm:async value=>{alarm=value},
};
const env={calls:0,state:'ready'};
const runner=new ArchiveSync({storage,blockConcurrencyWhile:callback=>callback()},env);
const request=path=>new Request('https://internal'+path,{method:'POST'});
const first=await (await runner.fetch(request('/bootstrap'))).json();
const callsBefore=env.calls;
const queued=Number.isFinite(alarm);
const duplicate=await (await runner.fetch(request('/bootstrap'))).json();
alarm=null;
await runner.alarm();
const completed=values.get('prepared-publication');
const jobCleared=!values.has('refresh-request');
const prepared=await (await runner.fetch(request('/bootstrap'))).json();
const manual=await (await runner.fetch(request('/run'))).json();
env.state='already-running';alarm=null;
await runner.alarm();
const deferred=alarm>Date.now();
env.state='ready';env.fail=true;alarm=null;
let error=null;try{await runner.alarm()}catch(failure){error=failure.message}
console.log(JSON.stringify({first,callsBefore,queued,duplicate,completed,jobCleared,prepared,manual,deferred,error,calls:env.calls}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    data = json.loads(result.stdout)
    assert data["first"]["state"] == "queued"
    assert data["callsBefore"] == 0
    assert data["queued"]
    assert data["duplicate"]["state"] == "already-queued"
    assert data["completed"] == "current-contract"
    assert data["jobCleared"]
    assert data["prepared"]["state"] == "already-prepared"
    assert data["manual"]["state"] == "queued"
    assert data["deferred"]
    assert data["error"] == "refresh failed"
    assert data["calls"] == 3
