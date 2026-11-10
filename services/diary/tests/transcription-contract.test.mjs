// ABOUTME: Проверяет настоящую границу Diary → HTTP Transcription по owner JSON Schema.
// ABOUTME: Повтор после restart сохраняет UUID, разные части и попытки не смешиваются.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createAdapters} from '../src/adapters.mjs';
import {assertDto} from '../../transcription/contracts/index.mjs';
test('part requests satisfy the owner wire contract and preserve retry identity',async t=>{
 const ownerId='owner-contract',profileId=randomUUID(),entryId=randomUUID();
 const submitted=[],requestId=randomUUID();
 const server=createServer(async(req,res)=>{
  let input='';
  for await(const chunk of req)input+=chunk;
  let value;try{
   const body=JSON.parse(input);
   assert.equal(req.url,'/internal/identity/transcription');
   assert.equal(body.principal.ownerId,ownerId);
   if(body.method==='request.submit'){
    assertDto('PublicSubmitParams',body.params);submitted.push(body.params);
    value={request:{requestId,taskState:'succeeded'}};
   }else{
    assert.equal(body.method,'result.get');
    value={state:'available',result:{text:'Текст',actualModel:{kind:'local',modelId:'fixture'}}};
   }
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
  }catch{
   res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({errorCode:'INVALID_ARGUMENT'}));
  }
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const cfg={transcriptionOrigin:'http://127.0.0.1:'+server.address().port,transcriptionToken:'fixture',origin:'http://diary.invalid'};
 const nc={async request(){return {data:Buffer.from(JSON.stringify({user:{id:ownerId,profileId,status:'active'}}))};}};
 const e={id:entryId,ownerId,profileId,audioArtifactId:randomUUID()};
 const part={index:0,artifactId:randomUUID()},second={index:1,artifactId:randomUUID()};
 const ports=createAdapters(cfg,nc);
 assert.equal((await ports.transcribePart(e,part)).text,'Текст');
 const first=submitted.at(-1).clientIdempotencyKey;
 await createAdapters(cfg,nc).transcribePart(structuredClone(e),structuredClone(part));
 assert.equal(submitted.at(-1).clientIdempotencyKey,first);
 await ports.transcriptionStatus({...e,audioProcessing:{parts:[part]}});
 assert.equal(submitted.at(-1).clientIdempotencyKey,first);
 await ports.transcribePart(e,second);const next=submitted.at(-1).clientIdempotencyKey;
 await ports.transcribePart({...e,transcriptionRetry:{key:randomUUID()}},part);const retried=submitted.at(-1).clientIdempotencyKey;
 await ports.transcribePart({...e,id:randomUUID()},part);const other=submitted.at(-1).clientIdempotencyKey;
 assert.equal(new Set([first,next,retried,other]).size,4);
 assert.equal(submitted.length,6);
});
