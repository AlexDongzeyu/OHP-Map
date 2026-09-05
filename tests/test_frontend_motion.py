"""System motion preferences remain live, including older media-query listeners."""
import json
from pathlib import Path
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("legacy", [False, True])
def test_motion_preference_updates_live_bindings_and_unsubscribes(legacy):
    script = r"""
let change;
const query={matches:false};
if(process.argv[1]==='legacy')query.addListener=callback=>{change=callback};
else query.addEventListener=(name,callback)=>{if(name==='change')change=callback};
globalThis.window={matchMedia:()=>query};
const config=await import('./js/config.js');
const states=[],notices=[];
states.push([config.SYSTEM_REDUCED_MOTION,config.motionEnabled()]);
const unsubscribe=config.onMotionPreferenceChange(reduced=>notices.push(reduced));
query.matches=true;change({matches:true});
states.push([config.SYSTEM_REDUCED_MOTION,config.motionEnabled()]);
unsubscribe();
query.matches=false;change({matches:false});
states.push([config.SYSTEM_REDUCED_MOTION,config.motionEnabled()]);
console.log(JSON.stringify({states,notices}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script, "legacy" if legacy else "modern"],
        cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8",
    )
    data = json.loads(result.stdout)
    assert data["states"] == [[False, True], [True, False], [False, True]]
    assert data["notices"] == [True]
