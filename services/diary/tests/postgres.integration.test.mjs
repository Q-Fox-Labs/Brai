// ABOUTME: Проверяет PostgreSQL/RLS и настоящий HTTP/MCP Дневника на отдельном fixture.
// ABOUTME: Auth/Artifacts/STT/Luna порты синтетические; реальная модель проверяется отдельно.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import pg from 'pg';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {migrate} from '../src/migrate.mjs';
import {createStore} from '../src/store.mjs';
import {createAdapters} from '../src/adapters.mjs';
import {createDiaryServer} from '../src/http.mjs';
import {advance,DiaryFault} from '../src/domain.mjs';
test('actual PG/RLS, HTTP upload/disconnect/replay and MCP owner isolation',{skip:!process.env.DIARY_TEST_PG_URL,timeout:30000},async()=>{
 const address=new URL(process.env.DIARY_TEST_PG_URL);
 assert.equal(address.hostname,'127.0.0.1');assert.equal(address.port,'15489');assert.equal(address.pathname,'/diary_fixture');
 const admin=new pg.Client({connectionString:address.href});await admin.connect();
 const cfgRoles={ownerRole:'diary_fixture_owner',appRole:'diary_fixture_app',workerRole:'diary_fixture_worker'};
 for(const role of Object.values(cfgRoles))await admin.query('CREATE ROLE '+role+" LOGIN PASSWORD 'synthetic-fixture'");
 await admin.query('ALTER DATABASE diary_fixture OWNER TO diary_fixture_owner');
 const urlFor=role=>{const u=new URL(address);u.username=role;u.password='synthetic-fixture';return u.href;};
 const owner=new pg.Client({connectionString:urlFor(cfgRoles.ownerRole)});await owner.connect();
 const app=new pg.Pool({connectionString:urlFor(cfgRoles.appRole),max:4}),worker=new pg.Pool({connectionString:urlFor(cfgRoles.workerRole),max:2});
 let service,artifactsServer;const clients=[];
 try{
  await assert.rejects(migrate(owner,{...cfgRoles,appRole:cfgRoles.ownerRole}),/DISTINCT_ROLES_REQUIRED/);
  await admin.query('GRANT diary_fixture_worker TO diary_fixture_app');
  await assert.rejects(migrate(owner,cfgRoles),/RUNTIME_MEMBERSHIP_FORBIDDEN/);
  await admin.query('REVOKE diary_fixture_worker FROM diary_fixture_app');await migrate(owner,cfgRoles);
  const owners={a:{id:'fixture-owner-a',profileId:'fixture-profile-a',status:'active'},b:{id:'fixture-owner-b',profileId:'fixture-profile-b',status:'active'}};
  const assets=new Map(),keys=new Map(),uploads=new Map();
  artifactsServer=createServer(async(req,res)=>{
   const asset=uploads.get(req.url);if(!asset){res.writeHead(404);res.end();return;}
   const chunks=[];try{for await(const chunk of req)chunks.push(chunk);}catch{return;}
   const bytes=Buffer.concat(chunks);asset.status='ready';asset.sizeBytes=bytes.length;asset.sha256=createHash('sha256').update(bytes).digest('hex');
   res.writeHead(201);res.end();
  });await new Promise(r=>artifactsServer.listen(0,'127.0.0.1',r));const assetOrigin='http://127.0.0.1:'+artifactsServer.address().port;
  const nc={async request(subject,data){
   const p=JSON.parse(Buffer.from(data).toString());let result;
   if(subject==='brai.auth.v2.identity-get'){result={user:Object.values(owners).find(u=>u.id===p.userId)??null};}
   else if(subject==='brai.auth.v1.session'){const user=owners[p.headers.cookie];result={status:200,body:user?.status==='active'?{user,session:{id:'fixture',userId:user.id,expiresAt:new Date(Date.now()+60000).toISOString()}}:null};}
   else if(subject==='brai.artifacts.v1.prepare'){
    if(!keys.has(p.requestId)){
     const artifactId=randomUUID(),token=randomUUID().replaceAll('-',''),artifact={artifactId,requestId:p.requestId,ownerId:p.ownerId,kind:p.kind,status:'pending',...p.metadata,sizeBytes:null,sha256:null,createdAt:new Date().toISOString()};
     const value={artifact,uploadUrl:assetOrigin+'/upload/'+token};keys.set(p.requestId,value);assets.set(artifactId,artifact);uploads.set('/upload/'+token,artifact);
    }result=keys.get(p.requestId);
   }else if(subject==='brai.artifacts.v1.get')result=assets.get(p.artifactId);
   else throw Error('UNEXPECTED_SUBJECT');
   return {data:Buffer.from(JSON.stringify(result))};
  }};
  const cfg={origin:'http://fixture.example',allowedHosts:[],maxAudioBytes:1024*1024,artifactsUploadOrigin:assetOrigin,artifactsInternalOrigin:assetOrigin,mcpBindings:[{token:'fixture-a',userId:owners.a.id,profileId:owners.a.profileId},{token:'fixture-b',userId:owners.b.id,profileId:owners.b.profileId}]};
  const ports=createAdapters(cfg,nc),store=createStore(app,worker);
  service=createDiaryServer(cfg,store,ports);await new Promise(r=>service.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+service.address().port;cfg.allowedHosts.push(new URL(base).host);
  const api=async(path,who='a',method='GET',data)=>{const response=await fetch(base+path,{method,headers:{cookie:who,'x-brai-user':owners[who].id,origin:cfg.origin,'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json()};};
  const create={requestId:randomUUID(),text:'Точная запись  первого ноября.\nНовая строка.',eventDate:'2026-11-01'};
  const first=await api('/v1/entries','a','POST',create),repeat=await api('/v1/entries','a','POST',create);assert.equal(first.status,201);assert.equal(first.body.entry.id,repeat.body.entry.id);
  assert.equal((await api('/v1/entry/'+first.body.entry.id,'b')).status,404);
  assert.equal((await api('/v1/entries','a','POST',{...create,text:'Другой текст'})).status,409);
  assert.equal((await api('/v1/entries','a','POST',{...create,ownerId:owners.b.id})).status,400);
  const makeClient=async token=>{const client=new Client({name:'diary-test',version:'1.0.0'},{capabilities:{}});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));clients.push(client);return client;};
  const ca=await makeClient('fixture-a'),cb=await makeClient('fixture-b');
  assert.equal((await ca.listTools()).tools.length,3);
  const written=await ca.callTool({name:'diary_create_text',arguments:{requestId:randomUUID(),text:'Запись агента без даты.'}});
  assert.equal(written.isError,undefined);const record=written.structuredContent.entry;assert.equal(record.eventDate,null);
  assert.equal((await cb.callTool({name:'diary_get',arguments:{id:record.id}})).isError,true);
  assert.equal((await cb.callTool({name:'diary_create_text',arguments:{requestId:randomUUID(),text:'Чужое',ownerId:owners.a.id}})).isError,true);
  const audioInput={requestId:randomUUID(),filename:'synthetic.wav',mimeType:'audio/wav',recordedAt:null,timezone:'UTC'};
  const pendingA=await api('/v1/audio','a','POST',audioInput);
  const acceptedB=await api('/v1/audio','a','POST',{...audioInput,requestId:randomUUID(),filename:'synthetic-b.wav'});
  const bytes=Buffer.from('SYNTHETIC AUDIO BYTES');
  // Ответ принятого PUT закрывается до чтения JSON: original уже ready независимо от browser.
  await new Promise((resolve,reject)=>{const req=httpRequest(base+'/v1/upload/'+acceptedB.body.entry.id,{method:'PUT',headers:{cookie:'a','x-brai-user':owners.a.id,origin:cfg.origin,'x-content-size':String(bytes.length)}},res=>{assert.equal(res.statusCode,202);res.destroy();resolve();});req.once('error',reject);req.end(bytes);});
  const incomplete=await api('/v1/audio','a','POST',{...audioInput,requestId:randomUUID(),filename:'incomplete.wav'});
  await new Promise(resolve=>{const req=httpRequest(base+'/v1/upload/'+incomplete.body.entry.id,{method:'PUT',headers:{cookie:'a','x-brai-user':owners.a.id,origin:cfg.origin,'x-content-size':'1000'}});req.on('error',()=>{});req.write('PARTIAL');setTimeout(()=>{req.destroy();resolve();},30);});
  await new Promise(r=>setTimeout(r,50));assert.equal((await ports.prepared(incomplete.body.entry)).artifact.status,'pending');
  const recovered=await fetch(base+'/v1/upload/'+incomplete.body.entry.id,{method:'PUT',headers:{cookie:'a','x-brai-user':owners.a.id,origin:cfg.origin,'x-content-size':String(bytes.length)},body:bytes});assert.equal(recovered.status,202);await recovered.body?.cancel();
  let modelCalls=0;
  const pipeline={...ports,async transcribe(){return {text:'Первого ноября 2026 года был тест.',provenance:{requestId:randomUUID(),actualModel:{modelId:'synthetic'}}};},async correct(e){modelCalls++;return JSON.stringify({correctedText:e.rawText,eventDate:'2026-11-01',dateStatus:'identified',dateEvidence:'Первого ноября 2026 года'});}};
  await store.next((e,save)=>advance(e,pipeline,save));await store.next((e,save)=>advance(e,pipeline,save));await store.next((e,save)=>advance(e,pipeline,save));
  const ready=await store.get(owners.a.id,acceptedB.body.entry.id);assert.equal(ready.state,'ready');assert.equal(ready.eventDate,'2026-11-01');
  assert.equal((await store.get(owners.a.id,pendingA.body.entry.id)).state,'awaiting_upload');
  const replay=await api('/v1/audio','a','POST',{...audioInput,requestId:acceptedB.body.entry.requestId,filename:'synthetic-b.wav'});assert.equal(replay.body.entry.id,ready.id);assert.equal(replay.body.ready,true);
  const unknown=await store.create(owners.a.id,owners.a.profileId,{...audioInput,requestId:randomUUID(),filename:'unknown.wav'},true);const original=await ports.prepared(unknown);Object.assign(assets.get(original.artifact.artifactId),{status:'ready',sha256:'b'.repeat(64),sizeBytes:1});
  await store.next((e,save)=>advance(e,{...pipeline,async correct(){modelCalls++;throw new DiaryFault('LUNA_OUTCOME_UNKNOWN',409);}},save));
  assert.equal((await store.get(owners.a.id,unknown.id)).state,'needs_attention');
  const calls=modelCalls;for(let i=0;i<3;i++)await store.next((e,save)=>advance(e,pipeline,save));assert.equal(modelCalls,calls);
  const raw=await app.connect();try{await raw.query('BEGIN');await raw.query("SELECT set_config('diary.owner_id',$1,true)",[owners.b.id]);assert.equal((await raw.query('SELECT count(*)::int AS count FROM diary.entries')).rows[0].count,0);await raw.query('ROLLBACK');}finally{raw.release();}
  owners.a.status='blocked';await assert.rejects(ca.callTool({name:'diary_get',arguments:{id:record.id}}));
 }finally{
  await Promise.all(clients.map(c=>c.close().catch(()=>{})));
  for(const server of [service,artifactsServer])if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  await Promise.all([app.end(),worker.end(),owner.end(),admin.end()]);
 }
});
