// ABOUTME: Проверяет native OCI catalog transport и reconcile без Docker, сети или секретов.
// ABOUTME: Реальные JSON/tar/gzip/digest проходят write/read пути через ограниченный HTTP double.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRegistry,sha256} from './registry.mjs';
test('small owner catalog roundtrips immutable OCI; lost response reuses the published content',async()=>{
  const objects=new Map(),uploads=new Map();let writes=0,blobs=0;
  const fetcher=async(url,options={})=>{
    const u=new URL(url),method=options.method??'GET',body=options.body;
    if(u.pathname==='/token')return {ok:true,json:async()=>({token:'synthetic-in-memory'})};
    if(method==='POST') {
      const location=u.origin+u.pathname+'fixture';uploads.set(location,true);
      return {status:202,headers:new Headers({location})};
    }
    if(method==='PUT') {
      writes++;
      if(u.pathname.includes('/blobs/uploads/')) {
        assert(uploads.has(u.origin+u.pathname));assert.equal(u.searchParams.get('digest'),'sha256:'+sha256(body));
        objects.set(u.pathname.split('/blobs/uploads/')[0]+'/blobs/'+u.searchParams.get('digest'),Buffer.from(body));blobs++;
      }else{
        objects.set(u.pathname,Buffer.from(body));objects.set(u.pathname.split('/manifests/')[0]+'/manifests/sha256:'+sha256(body),Buffer.from(body));
      }
      return {status:201};
    }
    const bytes=objects.get(u.pathname);
    return {ok:!!bytes,status:bytes?200:404,arrayBuffer:async()=>bytes};
  };
  const registry=createRegistry({repository:'owner/repo',username:'owner',token:'fixture',fetcher});
  const value={catalog:{entries:[{digest:'sha256:'+'a'.repeat(64)}]},signature:'fixture'};
  const first=await registry.publishJSON('catalog','content-tag','catalog.json',value,{format:'catalog',key:'content'},{alias:'verified'});
  assert.deepEqual(await registry.readJSON('catalog',first.digest,'catalog.json'),value);
  assert.equal(blobs,2);assert.equal(writes,4);
  const recovered=await registry.lookup('catalog','content-tag');
  const repeat=await registry.publishJSON('catalog','content-tag','catalog.json',value,{format:'catalog',key:'content'},{alias:'verified',existing:recovered});
  assert.equal(repeat.digest,first.digest);assert.equal(blobs,2);assert.equal(writes,5);
  assert.equal((await registry.lookup('catalog','verified')).digest,first.digest);
  const manifest=JSON.parse(objects.get('/v2/owner/repo-components/catalog/manifests/'+first.digest));
  const config=JSON.parse(objects.get('/v2/owner/repo-components/catalog/blobs/'+manifest.config.digest));
  assert.equal(config.config.Labels['org.opencontainers.image.source'],'https://github.com/owner/repo','first owner publish links the exact repository for Actions permission inheritance');
  objects.set('/v2/owner/repo-components/catalog/blobs/'+manifest.layers[0].digest,Buffer.from('corrupted'));
  await assert.rejects(registry.readJSON('catalog',first.digest,'catalog.json'),/REGISTRY_DIGEST_MISMATCH/);
});
