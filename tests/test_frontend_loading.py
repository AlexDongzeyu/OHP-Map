"""Bounded browser-data recovery without substituting or hiding failed data."""
import json
from pathlib import Path
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def loading_results():
    script = r"""
import fs from 'node:fs';
import path from 'node:path';
globalThis.window = {matchMedia: () => ({matches:false})};
const {loadData} = await import('./js/data.js');
const results = {};
for (const mode of ['healthy','temporary-http','temporary-network','temporary-body',
  'persistent-http','persistent-network','missing','invalid-json','long-outage']) {
  let requests = 0, notices = 0;
  const delays = [], warnings = [];
  console.warn = message => warnings.push(message);
  globalThis.setTimeout = (callback, delay) => {
    delays.push(delay); queueMicrotask(callback); return 0;
  };
  globalThis.fetch = async name => {
    if (name.endsWith('survivors.geojson')) {
      requests++;
      const first = requests === 1;
      if (mode === 'persistent-network' || (mode === 'temporary-network' && first)) {
        throw new TypeError('Network interruption');
      }
      if (mode === 'persistent-http' || mode === 'long-outage' || (mode === 'temporary-http' && first)) {
        return {ok:false,status:503,headers:new Headers(mode === 'long-outage' ? {'retry-after':'10'} : {})};
      }
      if (mode === 'missing') return {ok:false,status:404};
      if (mode === 'invalid-json') return {ok:true,json:async()=>{throw new SyntaxError('Invalid JSON')}};
      if (mode === 'temporary-body' && first) return {ok:true,json:async()=>{throw new TypeError('Interrupted response body')}};
    }
    return {ok:true,json:async()=>JSON.parse(fs.readFileSync(name.split('/').join(path.sep),'utf8'))};
  };
  let people = null, error = null;
  try {
    const store = await loadData({onRetry:()=>{notices++}});
    people = store.journeys.length;
  } catch (failure) {
    error = failure.name;
  }
  results[mode] = {requests,notices,delays,warnings:warnings.length,people,error};
}
console.log(JSON.stringify(results));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    return json.loads(result.stdout)


@pytest.mark.parametrize("mode", ["temporary-http", "temporary-network", "temporary-body"])
def test_transient_requests_retry_once_and_return_real_data(loading_results, mode):
    result = loading_results[mode]
    assert result["requests"] == 2
    assert result["notices"] == result["warnings"] == 1
    assert result["delays"] == [600]
    assert result["people"] == loading_results["healthy"]["people"]
    assert result["people"] > 1000
    assert result["error"] is None


@pytest.mark.parametrize("mode", ["persistent-http", "persistent-network"])
def test_persistent_failures_are_not_returned_as_success(loading_results, mode):
    result = loading_results[mode]
    assert result["requests"] == 2
    assert result["notices"] == 1
    assert result["error"] is not None
    assert result["people"] is None


@pytest.mark.parametrize("mode", ["missing", "invalid-json", "long-outage"])
def test_non_transient_or_long_failures_do_not_loop(loading_results, mode):
    result = loading_results[mode]
    assert result["requests"] == 1
    assert result["notices"] == result["warnings"] == 0
    assert result["delays"] == []
    assert result["error"] is not None
    assert result["people"] is None
