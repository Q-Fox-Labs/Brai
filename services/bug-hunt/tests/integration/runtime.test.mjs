// ABOUTME: Проверяет совместную работу реальных MCP, NATS, Auth и PostgreSQL.
// ABOUTME: Использует только собственную fixture, а не установленный DEV или Telegram владельца.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {connect} from 'nats';
import {Control} from '../../../hermes/identity/control.mjs';
import {createBugHuntCatalog} from '../../../hermes/identity/bug-hunt.mjs';
import {startFixture} from './fixture.mjs';
const observation={title:'Fixture observation',operation:'open',expected:'Ожидалось открытие',observed:'Показана ошибка'};
test('real MCP + NATS + Auth acceptance',async t=>{
 const f=await startFixture();
 const context=cookie=>({kind:'web',headers:{cookie,origin:f.fixture.origin}});
 const web=(op,input,cookie=f.cookie)=>f.call('brai.bug_hunt.v1.'+op,{context:context(cookie),input});
 try{
  const request={request_id:randomUUID(),observation};let receipt;
  await t.test('MCP discovery, report and replay use the authenticated owner',async()=>{
   const tools=(await f.client.listTools()).tools;assert.deepEqual(tools.map(t=>t.name),['bug_hunt_help','bug_hunt_report','bug_hunt_get','bug_hunt_list']);
   const first=await f.client.callTool({name:'bug_hunt_report',arguments:request});assert.equal(first.isError,undefined);receipt=first.structuredContent;
   const replay=await f.client.callTool({name:'bug_hunt_report',arguments:request});assert.equal(replay.structuredContent.case_id,receipt.case_id);assert.equal(replay.structuredContent.replayed,true);
   assert.equal((await web('get',{case_id:receipt.case_id})).case.owner_id,f.user.id);
   const denied=await f.client.callTool({name:'bug_hunt_review',arguments:{}});assert.equal(denied.isError,true);
   const response=await fetch(f.runtime.mcp.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(response.status,401);
  });
  await t.test('Web NATS path applies the same rules and current Auth reviewer permission',async()=>{
   const own=await web('report',{request_id:randomUUID(),observation});
   assert.equal(own.verification_status,'unverified');
   await assert.rejects(web('review',{request_id:randomUUID(),case_id:own.case_id,expected_revision:1,review_state:'triaged',explanation:'Не разрешено'}),e=>e.code==='FORBIDDEN');
   const result=await web('review',{request_id:randomUUID(),case_id:own.case_id,expected_revision:1,review_state:'triaged',explanation:'Проверяющий разобрал наблюдение'},f.adminCookie);
   assert.equal(result.revision,2);
   const read=await web('get',{case_id:own.case_id});assert.equal(read.reviews.items.length,1);assert.equal(read.case.verification_status,'unverified');
  });
  await t.test('personal broker obtains owner through its UID registry and actual Auth',async()=>{
   const uid=45001,profile={status:'active',userId:f.user.id,profileId:f.user.profileId,telegramId:f.user.telegramId};
   const control=new Control({origin:f.fixture.origin,cursorKey:'fixture-control-cursor-at-least-32-bytes',registry:async()=>({version:1,profiles:{[uid]:profile}}),
    authCall:(name,args)=>f.call('brai.auth.v2.'+name,args,f.brokerNc),
    perUserRuntime:async identity=>{
     const catalog=createBugHuntCatalog((subject,input)=>f.call(subject,input,f.brokerNc),identity);
     return {listTools:async()=>catalog.list(),callTool:(...args)=>catalog.call(...args)};
    }});
   const input={request_id:randomUUID(),observation};
   const result=await control.invokeTool(uid,'bug_hunt_report',input);
   assert.equal((await web('get',{case_id:result.case_id})).case.owner_id,f.user.id);
   assert.equal((await control.invokeTool(uid,'bug_hunt_report',input)).report_id,result.report_id);
   await assert.rejects(control.invokeTool(uid,'bug_hunt_review',{}));
   await assert.rejects(control.invokeTool(uid,'bug_hunt_report',{...input,owner_id:'foreign'}));
  });
  await t.test('foreign/absent case IDs, forged owner and unavailable evidence fail safely',async()=>{
   await assert.rejects(web('get',{case_id:randomUUID()}),e=>e.code==='NOT_FOUND');
   const foreign=await web('report',{request_id:randomUUID(),observation},f.adminCookie);
   await assert.rejects(web('get',{case_id:foreign.case_id}),e=>e.code==='NOT_FOUND');
   await assert.rejects(web('report',{request_id:randomUUID(),observation,owner_id:'forged'}),e=>e.code==='INVALID_ARGUMENT');
   await assert.rejects(web('report',{request_id:randomUUID(),observation:{...observation,evidence_artifact_ids:[randomUUID()]}}),e=>e.code==='DEPENDENCY_UNAVAILABLE');
  });
  await t.test('Artifacts metadata uses the public DTO and preserves accepted replay',async()=>{
   const id=randomUUID();let state='ready',owner=f.user.id;
   const artifacts=await f.nc.services.add({name:'fixture_artifacts',version:'1.0.0'});
   artifacts.addEndpoint('get',{subject:'brai.artifacts.v1.get',handler:(error,msg)=>{if(!error)msg.respond(Buffer.from(JSON.stringify({artifactId:id,ownerId:owner,status:state})));}});
   try{
    f.cfg.artifactsEnabled=true;await f.restart();
    const input={request_id:randomUUID(),observation:{...observation,evidence_artifact_ids:[id]}};
    const accepted=await web('report',input);
    state='deleted';assert.equal((await web('report',input)).report_id,accepted.report_id);
    await assert.rejects(web('report',{...input,request_id:randomUUID()}),e=>e.code==='NOT_FOUND');
    state='ready';owner='foreign';
    await assert.rejects(web('report',{...input,request_id:randomUUID()}),e=>e.code==='NOT_FOUND');
    owner=f.user.id;state='pending';
    await assert.rejects(web('report',{...input,request_id:randomUUID()}),e=>e.code==='NOT_FOUND');
   }finally{await artifacts.stop();f.cfg.artifactsEnabled=false;await f.restart();}
  });
  await t.test('ordinary NATS credential cannot submit a forged trusted context',async()=>{
   const eve=await connect({servers:f.fixture.natsURL,user:'eve',pass:'fixture-eve',inboxPrefix:'_INBOX.eve'});
   try{await assert.rejects(eve.request('brai.bug_hunt.v1.report',Buffer.from(JSON.stringify({context:{kind:'hermes',userId:f.user.id,profileId:f.user.profileId},input:{request_id:randomUUID(),observation}})),{timeout:500}));}
   finally{await eve.drain();}
  });
  await t.test('Auth and credential revocation take effect on the next MCP request',async()=>{
   await writeFile(f.principalsPath,JSON.stringify([{...f.entry,enabled:false}]));
   await assert.rejects(f.client.listTools());
   await writeFile(f.principalsPath,JSON.stringify([f.entry]));
   await f.authPool.query("UPDATE brai_identity SET status='blocked' WHERE user_id=$1",[f.user.id]);
   await assert.rejects(f.client.listTools());
   await assert.rejects(web('list',{}),e=>['UNAUTHENTICATED','DEPENDENCY_UNAVAILABLE'].includes(e.code));
   await f.authPool.query("UPDATE brai_identity SET status='active' WHERE user_id=$1",[f.user.id]);
  });
  await t.test('runtime restart preserves accepted observation and idempotency receipt',async()=>{
   await f.restart();
   const value=await web('get',{case_id:receipt.case_id});assert.equal(value.report.id,receipt.report_id);
   // Сам replay проверен отдельной PostgreSQL-проверкой и новым NATS-запросом.
   const rpc={context:{kind:'hermes',userId:f.user.id,profileId:f.user.profileId},input:{request_id:randomUUID(),observation}};
   const first=await f.call('brai.bug_hunt.v1.report',rpc,f.brokerNc);assert.equal((await f.call('brai.bug_hunt.v1.report',rpc,f.brokerNc)).case_id,first.case_id);
  });
 }finally{await f.close();}
});
