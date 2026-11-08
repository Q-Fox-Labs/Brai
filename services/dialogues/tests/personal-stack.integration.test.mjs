// ABOUTME: Проверяет RLS, MCP и личные инструменты Hermes на настоящей fixture PostgreSQL.
// ABOUTME: Тридцать синтетических логинов используют одинаковые ID и независимые доставки.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createStore} from '../dist/store.js';
import {startMcp} from '../dist/mcp.js';
import {createJobs} from '../dist/jobs.js';
import {DialoguesFault} from '../dist/domain.js';
import {bindOwner} from '../dist/isolation.js';
import {connectMcpEndpoint} from '../../hermes/runtime.mjs';
const url=process.env.DIALOGUES_ISOLATION_TEST_URL;
test('30 владельцев: личный транспорт, одинаковые ID, страницы, ACK и finish',{skip:!url},async()=>{
 const admin=new Pool({connectionString:url}),pools=[],servers=[],clients=[];
 const results=[],started=performance.now();
 try{
  assert.equal((await admin.query('SELECT current_user actor')).rows[0].actor,'dialogues_fixture_owner');
  for(let i=0;i<30;i++){
   const role='dialogues_stack_'+i,binding={userId:'synthetic-user-'+i,ownerId:'synthetic-user-'+i,profileId:'synthetic-profile-'+i};
   await admin.query("CREATE ROLE "+role+" LOGIN PASSWORD 'synthetic-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT");
   await bindOwner(admin,'dialogues_fixture_owner',role,binding);
   const u=new URL(url);u.username=role;u.password='synthetic-fixture';
   const pool=new Pool({connectionString:u.toString(),max:2,idleTimeoutMillis:10000});pools.push(pool);
   const config={host:'127.0.0.1',port:0,owner:binding.ownerId,hosts:['127.0.0.1:3009'],origins:['http://127.0.0.1:3009'],
    token:randomUUID().replaceAll('-',''),personal:{...binding,authorize:async()=>{
     const current=(await pool.query('SELECT * FROM dialogues_access.current_binding()')).rows[0];
     if(current?.user_id!==binding.userId||current.profile_id!==binding.profileId)throw Error('revoked');
    }}};
   const server=await startMcp(createStore(pool,'cursor-key-'+i),config);servers.push(server);config.hosts.push(new URL(server.url).host);config.origins.push(new URL(server.url).origin);
   const client=await connectMcpEndpoint({url:server.url,token:config.token,...binding},{endpointName:'dialogues'});clients.push(client);
   const context={consumer_id:'same-consumer',context_instance_id:'same-instance'};
   let seq=0;const request=()=> 'stack-'+i+'-'+(++seq);
   const call=async(action,args,ctx=context)=>{
    const reply=await client.call('dialogues_exchange',{action,arguments:args,context:ctx});
    assert.equal(reply.isError,undefined,JSON.stringify(reply));
    return reply.structuredContent;
   };
   const consume=async(response,ctx=context)=>{
    let page=response.context;
    if(response.context_error)page=(await client.call('dialogues_exchange',{action:'page',arguments:response.context_error.arguments})).structuredContent;
    const items=[...(page?.items??[])];const delivery_id=page?.delivery_id;
    while(page?.continuation_cursor){
     page=(await client.call('dialogues_exchange',{action:'page',arguments:{request_id:response.context_request_id,...ctx,continuation_cursor:page.continuation_cursor}})).structuredContent;
     items.push(...page.items);
    }
    if(delivery_id){
     const ack=await client.call('dialogues_context_ack',{request_id:request(),...ctx,delivery_id});
     assert.equal(ack.structuredContent.acknowledged,true);
    }
    assert(!JSON.stringify(items).includes('private-user-'+((i+1)%30)+':'));
    return {items,delivery_id};
   };
   results.push({i,pool,binding,call,consume,request,client,context,config,server});
  }
  const runs=await Promise.allSettled(results.map(async record=>{
   const {i,call,consume,request}=record;
   const original='private-user-'+i+':'+ 'Синтетический текст 😀'.repeat(6000);
   const input=await call('input',{request_id:request(),dialogue:{id:'same-dialogue',channel:'synthetic'},messages:[{id:'same-message',text:original,summary:'private-user-'+i+':'+ 'Большая сводка 😀'.repeat(6000)}]});
   const received=await consume(input);record.delivery=received.delivery_id;
   assert.equal((await record.pool.query('SELECT count(*)::int n FROM dialogues_live.messages')).rows[0].n,1);
   const final=await call('finish',{request_id:request(),dialogue_id:'same-dialogue',turn_id:input.turn_id,expected_version:input.version,final:{id:'same-final',text:'Готово '+i}});
   assert.equal(final.status,'completed');
   const fresh={consumer_id:'new-consumer',context_instance_id:'new-instance'};
   const next=await call('poll',{request_id:request(),dialogue_id:'same-dialogue'},fresh);
   const loaded=await consume(next,fresh);
   assert(JSON.stringify(loaded.items).includes('private-user-'+i+':'));
  }));
  for(const run of runs)if(run.status==='rejected')throw run.reason;
  const first=results[0],second=results[1];
  const foreign=await second.client.call('dialogues_context_ack',{request_id:second.request(),...second.context,delivery_id:first.delivery});
  assert.equal(foreign.isError,true);
  assert(!JSON.stringify(foreign).includes('private-user-0:'));
  const wrong=await fetch(second.server.url,{method:'POST',headers:{Authorization:'Bearer '+second.config.token,'x-brai-user-id':first.binding.userId,'x-brai-profile-id':first.binding.profileId}});
  assert.equal(wrong.status,403);
  await admin.query("UPDATE dialogues_access.sys_owner_bindings SET enabled=false WHERE login_role='dialogues_stack_0'");
  await assert.rejects(first.call('read',{request_id:first.request(),dialogue_id:'same-dialogue',message_id:'same-message'}));
  const background=results[2],owner=background.binding.ownerId;
  const store=createStore(background.pool,'background-key');
  await store.append(owner,{request_id:'background-seed',dialogue:{id:'background',channel:'synthetic'},
   messages:Array.from({length:10},(_,i)=>({id:'job-'+i,turn_id:'job-turn',role:'user',kind:'input',text:'Синтетический факт '+i}))});
  let busyProbe=true,busyRun=true,permitted=true;
  const jobs=createJobs(background.pool,owner,{
   async probe(){if(busyProbe)throw new DialoguesFault('LUNA_BUSY');return {};},
   async run(){if(busyRun)throw new DialoguesFault('LUNA_BUSY');return 'Полная сводка 37 🧠'.repeat(6000);}
  },async()=>{if(!permitted)throw Error('Auth blocked');});
  await jobs.tick();
  let queued=(await background.pool.query("SELECT * FROM dialogues_live.summary_jobs WHERE dialogue_id='background'")).rows[0];
  assert.equal(queued.state,'queued');assert.equal(queued.attempts,0);
  busyProbe=false;await background.pool.query("UPDATE dialogues_live.summary_jobs SET available_at=now() WHERE dialogue_id='background'");
  await jobs.tick();
  queued=(await background.pool.query("SELECT * FROM dialogues_live.summary_jobs WHERE dialogue_id='background'")).rows[0];
  assert.equal(queued.state,'queued');assert.equal(queued.attempts,0);
  permitted=false;await assert.rejects(jobs.tick());permitted=true;busyRun=false;
  await background.pool.query("UPDATE dialogues_live.summary_jobs SET available_at=now() WHERE dialogue_id='background'");
  await jobs.tick();
  assert.equal((await background.pool.query("SELECT state FROM dialogues_live.summary_jobs WHERE dialogue_id='background'")).rows[0].state,'succeeded');
  assert.equal((await results[3].pool.query('SELECT count(*)::int n FROM dialogues_live.summary_jobs')).rows[0].n,0);
  await jobs.stop();
  const connections=(await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename LIKE 'dialogues_stack_%'")).rows[0].n;
  assert(connections<=60);
  console.log(JSON.stringify({owners:30,elapsedMs:Math.round(performance.now()-started),processRssBytes:process.memoryUsage().rss,connections}));
 }finally{
  await Promise.all(clients.map(c=>c.close()));await Promise.all(servers.map(s=>s.close()));
  await Promise.all(pools.map(p=>p.end()));await admin.end();
 }
});
