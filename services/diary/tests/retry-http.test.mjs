// ABOUTME: Проверяет настоящий HTTP повтора, Auth/Origin и запрет выбора владельца в JSON.
// ABOUTME: Предметный повтор подменён портом; его транзакция и RLS проверяются отдельно.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDiaryServer} from '../src/http.mjs';
import {DiaryFault} from '../src/domain.mjs';
test('HTTP retry derives owner from Auth, rejects foreign entries and ignores no unsafe input',async()=>{
 const entryId=randomUUID(),retryId=randomUUID(),calls=[];
 const cfg={origin:'https://diary.test',allowedHosts:[]};
 const store={async get(owner,key){assert.equal(owner,'owner');if(key!==entryId)throw new DiaryFault('NOT_FOUND',404);return {id:entryId};},
  async retry(...args){calls.push(args);return {state:'scheduled',entryId};}};
 const ports={async authenticate(req){if(req.headers.cookie!=='session=owner')throw new DiaryFault('UNAUTHORIZED',401);return {id:'owner',profileId:'profile'};}};
 const server=createDiaryServer(cfg,store,ports);await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const base='http://127.0.0.1:'+server.address().port;cfg.allowedHosts.push(new URL(base).host);
 const headers={origin:cfg.origin,cookie:'session=owner','content-type':'application/json'};
 const send=(path,body,extra={})=>fetch(base+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
 try{
  const response=await send('/v1/retry/'+entryId,{requestId:retryId});assert.equal(response.status,202);assert.equal(response.headers.get('cache-control'),'private, no-store');await response.json();
  assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,4),['owner','profile',entryId,retryId]);assert.equal(calls[0][4],ports);
  for(const body of [{requestId:retryId,ownerId:'foreign'},{requestId:retryId,profileId:'foreign'},{requestId:retryId,model:'foreign'},null,[]]){
   const r=await send('/v1/retry/'+entryId,body);assert.equal(r.status,400);await r.arrayBuffer();
  }
  for(const [path,extra,status]of [['/v1/retry/'+randomUUID(),{},404],['/v1/retry/'+entryId,{origin:'https://foreign.test'},403],['/v1/retry/'+entryId,{cookie:''},401]]){
   const r=await send(path,{requestId:retryId},extra);assert.equal(r.status,status);await r.arrayBuffer();
  }
  const read=await fetch(base+'/v1/retry/'+entryId,{headers:{cookie:'session=owner'}});assert.equal(read.status,404);await read.arrayBuffer();
  assert.equal(calls.length,1);
 }finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
});
