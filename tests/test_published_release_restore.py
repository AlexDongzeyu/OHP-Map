"""Production restores the verified published release, not an unpublished local build."""
import tomllib

import pytest

from test_static_releases import ROOT, _node, static_project


SETUP = r"""
const root=payload.root||payload,out=path.join(root,'public');
const originalConfig=fs.readFileSync(path.join(root,'js','config.js'),'utf8');
fs.writeFileSync(path.join(root,'js','config.js'),originalConfig.replace(/\r\n/g,'\n'));
const published=await buildStaticRelease({root,origin:'https://published.test'});
const bodies=new Map();
const capture=directory=>{
  for(const item of fs.readdirSync(directory,{withFileTypes:true})){
    const full=path.join(directory,item.name);
    if(item.isDirectory())capture(full);
    else bodies.set('/'+path.relative(out,full).split(path.sep).join('/'),fs.readFileSync(full));
  }
};
capture(out);
fs.writeFileSync(path.join(root,'js','config.js'),originalConfig);
fs.appendFileSync(path.join(root,'js','app.js'),'\nexport const nextRelease=true;\n');
const prepared=prepareStaticRelease(root);
fs.rmSync(out,{recursive:true,force:true});
const requests=[];
const serve=async(url,options={})=>{
  const parsed=new URL(url);
  requests.push({path:parsed.pathname,origin:parsed.origin,method:options.method,redirect:options.redirect});
  const body=bodies.get(decodeURIComponent(parsed.pathname));
  return body===undefined?new Response('Not found',{status:404}):new Response(body);
};
"""


def test_clean_checkout_restores_actual_published_lf_release_over_http(static_project):
    result = _node(SETUP + r"""
      const {createServer}=await import('node:http');
      const server=createServer((request,response)=>{
        const pathname=new URL(request.url,'http://localhost').pathname;
        requests.push({path:pathname,method:request.method});
        const body=bodies.get(decodeURIComponent(pathname));
        response.writeHead(body===undefined?404:200,{'content-type':pathname.endsWith('.json')?'application/json':'application/octet-stream'});
        response.end(body===undefined?'Not found':body);
      });
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      let restored,built;
      try{
        restored=await restorePublishedReleases({origin:`http://127.0.0.1:${server.address().port}`,prepared});
        assert.equal(fs.existsSync(out),false);
        built=await buildStaticRelease({
          root,prepared,previous:restored.releases,requiredPreviousHash:restored.requiredHash,
        });
      }finally{
        await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});
      }
      const oldConfig=fs.readFileSync(path.join(out,'releases',published.hash,'js','config.js'));
      assert.deepEqual(oldConfig,bodies.get(`/releases/${published.hash}/js/config.js`));
      const oldImage=fs.readFileSync(path.join(out,'releases',published.hash,'assets','portraits','person.webp'));
      assert.deepEqual(oldImage,bodies.get(`/releases/${published.hash}/assets/portraits/person.webp`));
      console.log(JSON.stringify({
        published:published.hash,current:prepared.hash,built,restored:{
          hash:restored.publishedHash,required:restored.requiredHash,first:restored.firstRelease,
        },requests,oldUsesLf:!oldConfig.toString('utf8').includes('\r\n'),
      }));
    """, str(static_project))
    assert result["current"] != result["published"]
    assert result["restored"] == {
        "hash": result["published"], "required": result["published"], "first": False,
    }
    assert result["built"]["previous"] == result["published"]
    assert result["built"]["retained_releases"] == 2
    assert result["oldUsesLf"]
    assert all(request["method"] == "GET" for request in result["requests"])
    assert any(request["path"] == f"/releases/{result['published']}/js/config.js" for request in result["requests"])
    assert sum(request["path"] == "/releases.json" for request in result["requests"]) == 2


@pytest.mark.parametrize("failure", ["registry-503", "missing-file", "corrupt-file", "unsafe-path", "changed-registry", "network"])
def test_required_restore_failures_never_fall_back_to_a_local_hash_or_write_output(static_project, failure):
    result = _node(SETUP + r"""
      let registryReads=0;
      if(payload.failure==='unsafe-path'){
        const manifest=JSON.parse(bodies.get(`/releases/${published.hash}/release-manifest.json`));
        manifest.files[0].path='assets/../../outside.txt';
        const invalidHash=hash(JSON.stringify([manifest.format,manifest.builder,manifest.directories,
          manifest.files.map(file=>[file.path,file.source_sha256])]));
        manifest.hash=invalidHash;
        bodies.set('/releases.json',Buffer.from(JSON.stringify({format:1,current:invalidHash,previous:null})));
        bodies.set(`/releases/${invalidHash}/release-manifest.json`,Buffer.from(JSON.stringify(manifest)));
      }
      const fetcher=async(url,options)=>{
        const pathname=new URL(url).pathname;
        if(payload.failure==='network')throw new Error('Network unavailable');
        if(pathname==='/releases.json'){
          registryReads++;
          if(payload.failure==='registry-503')return new Response('Unavailable',{status:503});
          if(payload.failure==='changed-registry'&&registryReads>1){
            return new Response(JSON.stringify({format:1,current:'f'.repeat(64),previous:null}));
          }
        }
        if(pathname.endsWith('/js/config.js')){
          if(payload.failure==='missing-file')return new Response('Missing',{status:404});
          if(payload.failure==='corrupt-file')return new Response('Changed bytes behind an immutable URL');
        }
        return serve(url,options);
      };
      let error='';
      try{await restorePublishedReleases({origin:'https://published.test',prepared,fetcher})}catch(failure){error=failure.message}
      console.log(JSON.stringify({error,noOutput:!fs.existsSync(out),requests}));
    """, {"root": str(static_project), "failure": failure})
    assert result["error"]
    assert result["noOutput"]
    assert all(request["origin"] == "https://published.test" for request in result["requests"])
    assert not any("outside" in request["path"] for request in result["requests"])
    if failure == "changed-registry":
        assert "changed during restoration" in result["error"]
    if failure == "unsafe-path":
        assert "manifest" in result["error"]


@pytest.mark.parametrize("page", ["legacy", "hashed", "unrecognized"])
def test_only_a_confirmed_unversioned_site_can_bootstrap_without_a_registry(static_project, page):
    result = _node(SETUP + r"""
      bodies.delete('/releases.json');
      bodies.set('/',payload.page==='legacy'
        ?fs.readFileSync(path.join(root,'index.html'))
        :payload.page==='hashed'?bodies.get('/index.html'):Buffer.from('<html>Unexpected response</html>'));
      let restored,error='';
      try{restored=await restorePublishedReleases({origin:'https://published.test',prepared,fetcher:serve})}
      catch(failure){error=failure.message}
      console.log(JSON.stringify({first:restored?.firstRelease,hash:restored?.requiredHash,releases:restored?.releases.length,error,noOutput:!fs.existsSync(out)}));
    """, {"root": str(static_project), "page": page})
    assert result["noOutput"]
    if page == "legacy":
        assert result["first"] is True and result["hash"] is None and result["releases"] == 0
        assert result["error"] == ""
    else:
        assert "registry is missing" in result["error"]


def test_required_published_predecessor_is_never_pruned_to_satisfy_the_asset_cap(static_project):
    result = _node(SETUP + r"""
      const restored=await restorePublishedReleases({origin:'https://published.test',prepared,fetcher:serve});
      let error='';
      try{
        await buildStaticRelease({
          root,prepared,previous:restored.releases,requiredPreviousHash:restored.requiredHash,
          maxAssets:2*prepared.files.length+3,
        });
      }catch(failure){error=failure.message}
      console.log(JSON.stringify({error,noOutput:!fs.existsSync(out)}));
    """, str(static_project))
    assert "required published release cannot fit" in result["error"]
    assert result["noOutput"]


def test_unchanged_redeploy_restores_the_published_previous_tree(static_project):
    result = _node(r"""
      const root=payload,out=path.join(root,'public');
      const first=await buildStaticRelease({root});
      fs.appendFileSync(path.join(root,'css','style.css'),'\n.changed {}\n');
      const current=await buildStaticRelease({root});
      const snapshot=captureStaticReleases(out);
      const bodies=new Map([['/releases.json',fs.readFileSync(path.join(out,'releases.json'))]]);
      for(const release of snapshot){
        bodies.set(`/releases/${release.hash}/release-manifest.json`,Buffer.from(JSON.stringify(release.manifest)));
        for(const file of release.files)bodies.set(`/releases/${release.hash}/${file.path}`,file.body);
      }
      const prepared=prepareStaticRelease(root);
      fs.rmSync(out,{recursive:true,force:true});
      const restored=await restorePublishedReleases({
        origin:'https://published.test',prepared,
        fetcher:async url=>new Response(bodies.get(new URL(url).pathname),{status:bodies.has(new URL(url).pathname)?200:404}),
      });
      const built=await buildStaticRelease({root,prepared,previous:restored.releases,requiredPreviousHash:restored.requiredHash});
      console.log(JSON.stringify({first:first.hash,current:current.hash,restored:restored.requiredHash,built}));
    """, str(static_project))
    assert result["restored"] == result["first"]
    assert result["built"]["hash"] == result["current"]
    assert result["built"]["previous"] == result["first"]


def test_production_build_requires_published_restore_while_local_build_remains_offline():
    config = tomllib.loads((ROOT / "wrangler.toml").read_text(encoding="utf-8"))
    assert config["build"]["command"] == "node tools/assemble_site.cjs --restore-published"
    assembly = (ROOT / "tools" / "assemble_site.cjs").read_text(encoding="utf-8")
    assert 'process.argv.includes("--restore-published")' in assembly
    assert "restorePublishedReleases({ prepared: staticRelease })" in assembly
    assert "requiredPreviousHash: published?.requiredHash" in assembly
    assert assembly.index("await restorePublishedReleases") < assembly.index("execSync(")
