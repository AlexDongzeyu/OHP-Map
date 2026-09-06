"""Whole static trees share a bounded, content-addressed release prefix."""
import json
from pathlib import Path
import shutil
import subprocess
import uuid

import pytest


ROOT = Path(__file__).resolve().parents[1]
SENTINEL = 'const STATIC_ASSET_ROOT = "../";'
SHELL = """<!doctype html><html><head><title>Archive</title>
<link rel="icon" href="assets/icon.svg">
<link rel="preload" href="/vendor/fonts/example.woff2" as="font">
<link rel="stylesheet" href="./css/style.css"></head><body>
<svg><use href="#icon"></use></svg><a href="/data/index.json">Data</a>
<script src="vendor/library.js"></script><script type="module" src="/js/app.js"></script>
</body></html>"""


def _node(code, payload=None):
    bootstrap = r"""
      import fs from 'node:fs';
      import path from 'node:path';
      import assert from 'node:assert/strict';
      import {createHash} from 'node:crypto';
      import {buildStaticRelease,prepareStaticRelease,captureStaticReleases,restorePublishedReleases} from './tools/build_static_release.cjs';
      import {rewriteStaticHtml,staticReleaseFromHtml,isReleaseAssetPath} from './worker/static-assets.js';
      import {secureResponse,SECURITY_HEADERS} from './worker/headers.js';
      import {renderProfileHtml} from './worker/profile-pages.js';
      const payload=JSON.parse(fs.readFileSync(0,'utf8'));
      const hash=body=>createHash('sha256').update(body).digest('hex');
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", bootstrap + code],
        cwd=ROOT, input=json.dumps(payload), capture_output=True, text=True,
        encoding="utf-8", timeout=90,
    )
    assert result.returncode == 0, result.stderr[-5000:]
    return json.loads(result.stdout)


@pytest.fixture
def static_project():
    root = ROOT / "tests" / f".static-release-{uuid.uuid4().hex}"
    files = {
        "js/config.js": SENTINEL + '\r\nexport const resource = value => value.startsWith("data/") ? new URL(`/${value}`, import.meta.url) : new URL(value, new URL(STATIC_ASSET_ROOT, import.meta.url));\r\n',
        "js/app.js": 'import "./lib/part.js";\nexport const load=()=>import("./lazy.js");\nconst image=new URL("../assets/icon.svg",import.meta.url);\n',
        "js/lib/part.js": 'export const text="import statements and CSS url() are not rewritten";\n',
        "js/lazy.js": "export const lazy=true;\n",
        "css/style.css": '@import "./tokens.css";\nbody { background: url("../assets/icon.svg#shape"); }\n',
        "css/tokens.css": '@font-face { font-family:Example; src:url("../vendor/fonts/example.woff2"); }\n',
        "assets/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"><g id="shape"/></svg>',
        "assets/portraits/person.webp": b"\x00\xfffixture-portrait",
        "assets/social-preview.png": b"\x89PNGfixture-social-preview",
        "vendor/fonts/example.woff2": b"\x00\x01fixture-font",
        "vendor/library.js": "/* preserved vendor license */\nconst library={};\n",
        "vendor/atlas/map.json": '{"type":"Topology","objects":{}}',
        "worker/server-profile.css": "#server-profile { color: navy; }\n",
        "index.html": SHELL,
        "public/index.html": SHELL,
        "public/data/index.json": '{"type":"FeatureCollection","features":[]}',
    }
    for name, body in files.items():
        file = root.joinpath(*name.split("/"))
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(body if isinstance(body, bytes) else body.encode())
    (root / "assets" / "empty").mkdir()
    try:
        yield root
    finally:
        shutil.rmtree(root)


def test_complete_trees_keep_relative_dependencies_aliases_and_data_urls(static_project):
    result = _node(r"""
      const root=payload,out=path.join(root,'public');
      const originalConfig=fs.readFileSync(path.join(root,'js','config.js'),'utf8');
      const sourceHashes=Object.fromEntries(prepareStaticRelease(root).files.map(file=>[file.path,hash(file.source)]));
      const stats=await buildStaticRelease({root,origin:'https://archive.test'});
      const release=path.join(out,'releases',stats.hash);
      const manifest=JSON.parse(fs.readFileSync(path.join(out,...stats.manifest_url.slice(1).split('/')),'utf8'));
      const registry=JSON.parse(fs.readFileSync(path.join(out,...stats.registry_url.slice(1).split('/')),'utf8'));
      assert.equal(manifest.hash,stats.hash);
      assert.equal(registry.current,stats.hash);
      for(const file of manifest.files){
        const alias=fs.readFileSync(path.join(out,...file.path.split('/')));
        const compiled=fs.readFileSync(path.join(release,...file.path.split('/')));
        assert.equal(hash(alias),file.source_sha256);
        assert.equal(hash(compiled),file.sha256);
        assert.equal(sourceHashes[file.path],file.source_sha256);
        if(file.path!=='js/config.js')assert.deepEqual(alias,compiled);
      }
      const config=fs.readFileSync(path.join(release,'js','config.js'),'utf8');
      const html=fs.readFileSync(path.join(out,'index.html'),'utf8');
      const base='https://archive.test'+stats.prefix;
      const dependencies=[
        new URL('./lib/part.js',base+'js/app.js'),
        new URL('./lazy.js',base+'js/app.js'),
        new URL('../assets/icon.svg',base+'js/app.js'),
        new URL('./tokens.css',base+'css/style.css'),
        new URL('../vendor/fonts/example.woff2',base+'css/tokens.css'),
      ];
      for(const url of dependencies)assert.ok(fs.existsSync(path.join(out,...url.pathname.slice(1).split('/'))));
      console.log(JSON.stringify({
        stats,config,originalConfig,html,
        sourceUnchanged:fs.readFileSync(path.join(root,'js','config.js'),'utf8')===originalConfig,
        alias:fs.readFileSync(path.join(out,'js','config.js'),'utf8'),
        script:fs.readFileSync(path.join(release,'js','app.js'),'utf8'),
        css:fs.readFileSync(path.join(release,'css','style.css'),'utf8'),
        noReleaseData:!fs.existsSync(path.join(release,'data')),
        rootData:fs.readFileSync(path.join(out,'data','index.json'),'utf8'),
        empty:fs.existsSync(path.join(release,'assets','empty')),
      }));
    """, str(static_project))
    prefix = result["stats"]["prefix"]
    assert result["stats"]["manifest_url"] == prefix + "release-manifest.json"
    assert result["stats"]["registry_url"] == "/releases.json"
    assert result["sourceUnchanged"] and result["alias"] == result["originalConfig"]
    assert result["config"] == result["originalConfig"].replace(SENTINEL, f'const STATIC_ASSET_ROOT = "{prefix}";')
    assert 'new URL(`/${value}`, import.meta.url)' in result["config"]
    assert 'import "./lib/part.js"' in result["script"] and 'import("./lazy.js")' in result["script"]
    assert '@import "./tokens.css"' in result["css"] and 'url("../assets/icon.svg#shape")' in result["css"]
    assert f'src="{prefix}js/app.js"' in result["html"]
    assert f'src="{prefix}vendor/library.js"' in result["html"]
    assert f'href="{prefix}vendor/fonts/example.woff2"' in result["html"]
    assert f'href="{prefix}css/style.css"' in result["html"]
    assert 'href="#icon"' in result["html"] and "<base" not in result["html"]
    assert 'href="/data/index.json"' in result["html"]
    assert result["noReleaseData"] and json.loads(result["rootData"])["type"] == "FeatureCollection"
    assert result["empty"]


def test_release_hash_is_content_based_and_only_two_complete_releases_are_retained(static_project):
    result = _node(r"""
      const root=payload,out=path.join(root,'public');
      const first=await buildStaticRelease({root});
      const original=fs.readFileSync(path.join(root,'css','style.css'));
      fs.utimesSync(path.join(root,'css','style.css'),new Date(0),new Date(0));
      const same=await buildStaticRelease({root});
      fs.appendFileSync(path.join(root,'css','style.css'),'\n.new { color:blue; }\n');
      const second=await buildStaticRelease({root});
      const oldStyle=fs.readFileSync(path.join(out,'releases',first.hash,'css','style.css'));
      assert.deepEqual(oldStyle,original);
      fs.appendFileSync(path.join(root,'vendor','library.js'),'\nconst revision=2;\n');
      const third=await buildStaticRelease({root});
      const beforeRepeat=fs.readFileSync(path.join(out,'index.html'),'utf8');
      const repeated=await buildStaticRelease({root});
      assert.equal(fs.readFileSync(path.join(out,'index.html'),'utf8'),beforeRepeat);
      console.log(JSON.stringify({
        first,same,second,third,repeated,
        directories:fs.readdirSync(path.join(out,'releases')).sort(),
        registry:JSON.parse(fs.readFileSync(path.join(out,'releases.json'),'utf8')),
      }));
    """, str(static_project))
    assert result["first"]["hash"] == result["same"]["hash"]
    assert len({result["first"]["hash"], result["second"]["hash"], result["third"]["hash"]}) == 3
    assert result["second"]["previous"] == result["first"]["hash"]
    assert result["third"]["previous"] == result["second"]["hash"]
    assert result["repeated"]["hash"] == result["third"]["hash"]
    assert result["repeated"]["previous"] == result["second"]["hash"]
    assert set(result["directories"]) == {result["second"]["hash"], result["third"]["hash"]}
    assert result["registry"]["current"] == result["third"]["hash"]


def test_prepared_snapshot_is_used_for_copying_and_survives_clean_output_assembly(static_project):
    result = _node(r"""
      const root=payload,out=path.join(root,'public');
      const first=await buildStaticRelease({root});
      fs.appendFileSync(path.join(root,'css','style.css'),'\n.before-plan { color:green; }\n');
      const prepared=prepareStaticRelease(root);
      const expected=prepared.files.find(file=>file.path==='css/style.css').body;
      const previous=captureStaticReleases(out);
      fs.appendFileSync(path.join(root,'css','style.css'),'\n.after-plan { color:red; }\n');
      fs.rmSync(out,{recursive:true,force:true});
      const built=await buildStaticRelease({root,prepared,previous});
      assert.deepEqual(fs.readFileSync(path.join(out,'releases',built.hash,'css','style.css')),expected);
      assert.ok(fs.readFileSync(path.join(root,'css','style.css'),'utf8').includes('after-plan'));
      console.log(JSON.stringify({first,built,hashMatches:built.hash===prepared.hash,priorExists:fs.existsSync(path.join(out,'releases',first.hash))}));
    """, str(static_project))
    assert result["hashMatches"] and result["priorExists"]
    assert result["built"]["previous"] == result["first"]["hash"]


def test_retention_budget_drops_only_the_optional_previous_tree_and_fails_if_current_cannot_fit(static_project):
    result = _node(r"""
      const root=payload,out=path.join(root,'public');
      const first=await buildStaticRelease({root});
      fs.appendFileSync(path.join(root,'css','style.css'),'\n.changed {}\n');
      const bounded=await buildStaticRelease({root,maxAssets:first.total_files});
      const before=fs.readFileSync(path.join(out,'releases.json'),'utf8');
      let error='';
      try{await buildStaticRelease({root,maxAssets:bounded.total_files-1})}catch(failure){error=failure.message}
      console.log(JSON.stringify({
        first,bounded,error,unchanged:fs.readFileSync(path.join(out,'releases.json'),'utf8')===before,
        trees:fs.readdirSync(path.join(out,'releases')),
      }));
    """, str(static_project))
    assert result["bounded"]["retained_releases"] == 1 and result["bounded"]["previous"] is None
    assert result["bounded"]["total_files"] <= result["first"]["total_files"]
    assert result["trees"] == [result["bounded"]["hash"]]
    assert "asset limit" in result["error"] and result["unchanged"]


@pytest.mark.parametrize("problem", ["sentinel", "tampering"])
def test_bad_sentinel_or_modified_old_release_fails_without_overwriting_output(static_project, problem):
    result = _node(r"""
      const root=payload.root,out=path.join(root,'public');
      const first=await buildStaticRelease({root});
      const before=fs.readFileSync(path.join(out,'releases.json'),'utf8');
      if(payload.problem==='sentinel')fs.appendFileSync(path.join(root,'js','config.js'),'\nconst STATIC_ASSET_ROOT = "../";\n');
      else fs.appendFileSync(path.join(out,'releases',first.hash,'css','style.css'),'\n.tampered {}\n');
      let error='';
      try{await buildStaticRelease({root})}catch(failure){error=failure.message}
      console.log(JSON.stringify({error,unchanged:fs.readFileSync(path.join(out,'releases.json'),'utf8')===before}));
    """, {"root": str(static_project), "problem": problem})
    assert result["unchanged"]
    assert ("sentinel" if problem == "sentinel" else "modified") in result["error"]


def test_builder_refuses_outputs_inside_source_directories(static_project):
    result = _node(r"""
      const before=fs.readFileSync(path.join(payload,'js','config.js'));
      let error='';
      try{await buildStaticRelease({root:payload,out:path.join(payload,'js','generated')})}catch(failure){error=failure.message}
      console.log(JSON.stringify({
        error,unchanged:before.equals(fs.readFileSync(path.join(payload,'js','config.js'))),
        created:fs.existsSync(path.join(payload,'js','generated')),
      }));
    """, str(static_project))
    assert "outside the source trees" in result["error"]
    assert result["unchanged"] and not result["created"]


def test_generated_and_live_profile_shells_use_the_release_without_relocating_source_or_data_urls(static_project):
    result = _node(r"""
      const root=payload,out=path.join(root,'public'),origin='https://archive.test';
      const shell=fs.readFileSync(path.join(root,'index.html'),'utf8');
      const feature={type:'Feature',geometry:null,properties:{
        survivor_id:'person',name:'Fixture Person',review_status:'pending',waypoints:[],
        archive_url:'https://ohp.crestwood.on.ca/ohp/person/',bio_excerpt:'An original source quotation.',
        portrait:'assets/portraits/person.webp',portrait_rights:'Reuse permission granted by the author.',
      }};
      const directory=path.join(out,'data','profile-pages');fs.mkdirSync(directory,{recursive:true});
      fs.writeFileSync(path.join(directory,'person.html'),renderProfileHtml(shell,feature,{origin}));
      const stats=await buildStaticRelease({root,origin});
      const rootHtml=fs.readFileSync(path.join(out,'index.html'),'utf8');
      const generated=fs.readFileSync(path.join(directory,'person.html'),'utf8');
      const live=renderProfileHtml(rootHtml,feature,{origin});
      const rewrite=html=>rewriteStaticHtml(html,stats.hash,origin);
      console.log(JSON.stringify({
        stats,generated,live,marker:staticReleaseFromHtml(rootHtml),
        idempotent:rewrite(rewrite(rootHtml))===rewrite(rootHtml),
        stylesheet:fs.existsSync(path.join(out,'releases',stats.hash,'css','server-profile.css')),
      }));
    """, str(static_project))
    prefix = result["stats"]["prefix"]
    assert result["marker"] == result["stats"]["hash"]
    assert result["idempotent"] and result["stylesheet"]
    for html in (result["generated"], result["live"]):
        assert f'src="{prefix}js/app.js"' in html
        assert f'href="{prefix}css/server-profile.css"' in html
        assert f'src="{prefix}assets/portraits/person.webp"' in html
        assert f'content="https://archive.test{prefix}assets/social-preview.png"' in html
        assert 'href="https://archive.test/survivor/person"' in html
        assert 'href="https://ohp.crestwood.on.ca/ohp/person/"' in html
        assert 'href="/data/index.json"' in html and 'href="#icon"' in html
        assert "<base" not in html and f"{prefix}data/" not in html


@pytest.mark.parametrize("resource", ["js/app.js", "css/style.css", "vendor/fonts/example.woff2", "assets/icon.svg"])
@pytest.mark.parametrize("method", ["GET", "HEAD", "conditional", "range"])
def test_content_addressed_static_responses_are_immutable_and_keep_conditional_headers(resource, method):
    result = _node(r"""
      const pathname='/releases/'+'a'.repeat(64)+'/'+payload.resource;
      const request=new Request('https://archive.test'+pathname,{
        method:payload.method==='HEAD'?'HEAD':'GET',headers:payload.method==='range'?{range:'bytes=0-11'}:{},
      });
      const status=payload.method==='conditional'?304:payload.method==='range'?206:200;
      const response=await secureResponse(new Response(status===304?null:'static bytes',{
        status,headers:{etag:'"asset-etag"','content-type':'text/plain',...(status===206?{'content-range':'bytes 0-11/24'}:{})},
      }),request);
      console.log(JSON.stringify({status:response.status,body:await response.text(),headers:Object.fromEntries(response.headers),valid:isReleaseAssetPath(pathname)}));
    """, {"resource": resource, "method": method})
    assert result["valid"]
    assert result["status"] == (304 if method == "conditional" else 206 if method == "range" else 200)
    assert result["body"] == ("static bytes" if method in ("GET", "range") else "")
    assert result["headers"]["cache-control"] == "public, max-age=31536000, immutable"
    assert result["headers"]["etag"] == '"asset-etag"'
    assert result["headers"]["x-content-type-options"] == "nosniff"
    if method == "range":
        assert result["headers"]["content-range"] == "bytes 0-11/24"


@pytest.mark.parametrize("path", [
    "/js/app.js", "/css/style.css", "/assets/icon.svg", "/vendor/library.js", "/server-profile.css",
    "/releases/latest/js/app.js", "/releases/" + "a" * 63 + "/js/app.js",
    "/releases/" + "a" * 64 + "/data/index.json",
    "/releases/" + "a" * 64 + "/assets/%2fdata.json",
    "/releases/" + "a" * 64 + "/assets/%252e%252e/file.svg",
])
def test_plain_aliases_and_non_static_or_invalid_release_paths_never_become_immutable(path):
    result = _node(r"""
      const response=await secureResponse(new Response('bytes',{headers:{'cache-control':'public, max-age=31536000, immutable'}}),
        new Request('https://archive.test'+payload));
      console.log(JSON.stringify({cache:response.headers.get('cache-control'),valid:isReleaseAssetPath(payload)}));
    """, path)
    assert not result["valid"]
    assert result["cache"] == "public, max-age=0, must-revalidate"


def test_release_misses_never_get_long_caching_and_csp_allows_exactly_the_three_ohp_image_hosts():
    result = _node(r"""
      const response=await secureResponse(new Response('Missing',{status:404}),
        new Request('https://archive.test/releases/'+'a'.repeat(64)+'/js/missing.js'));
      const images=SECURITY_HEADERS['content-security-policy'].split('; ').find(value=>value.startsWith('img-src '));
      console.log(JSON.stringify({cache:response.headers.get('cache-control'),images}));
    """)
    assert result["cache"] == "no-store"
    hosts = {item for item in result["images"].split() if item.startswith("https:")}
    assert hosts == {
        "https://ohp.crestwood.on.ca",
        "https://crestwood.on.ca",
        "https://www.crestwood.on.ca",
    }
