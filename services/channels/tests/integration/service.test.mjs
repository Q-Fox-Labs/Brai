// ABOUTME: Проверяет самостоятельный процесс Каналов на настоящих PostgreSQL и NATS.
// ABOUTME: Проверки ограничены синтетической БД и не отправляют сообщения Telegram.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {connect} from 'nats';
import {createStore} from '../../dist/storage.js';
import {createService} from '../../dist/domain.js';
import {enabled,startChannels,seed,incoming,metadata,rule,run,url,eventually} from './fixture.mjs';
test('standalone: fourteen operations, immutable receipts, historical routing and limits',{skip:!enabled,timeout:120000},async t=>{
 const f=await startChannels();let lock;
 try{
  await f.owner.query('TRUNCATE channels.channel_operation_receipts,channels.channel_resolutions,channels.channel_versions,channels.channels,channels.channel_connection_versions,channels.channel_connections');
  const {c,h,settings,channelSettings}=await seed(f),cid=c.result.id,hid=h.result.id;
  await t.test('idempotent migration, profile names and minimal runtime permissions',async()=>{
   await f.owner.query("UPDATE channels.sys_channel_types SET name='Operator label'");
   const m=f.migrate();assert.equal(await m.done,0,m.output());
   assert.equal((await f.rpc('types.get',{type:{code:'telegram',version:1}})).name,'Operator label');
   assert.equal((await f.rpc('types.list',{})).items.length,1);
   assert.equal((await f.rpc('connections.get',{ownerId:'fixture',connectionId:cid})).version,1);
   assert.equal((await f.rpc('channels.get',{ownerId:'fixture',channelId:hid},f.reader,'reader_test')).version,1);
   assert.equal((await f.rpc('connections.list',{ownerId:'fixture'})).items.length,1);
   assert.equal((await f.rpc('channels.list',{ownerId:'fixture',connectionId:cid})).items.length,1);
   for(const sql of ["DELETE FROM channels.channel_versions","UPDATE channels.channel_versions SET body='{}'","UPDATE channels.channels SET body='{}'","CREATE TABLE channels.forbidden(id int)","INSERT INTO channels.sys_channel_types VALUES('x',1,'x','{}')"])await assert.rejects(f.app.query(sql),{code:'42501'});
   assert.equal(Number((await f.owner.query("SELECT count(*) n FROM information_schema.tables WHERE table_schema='channels'")).rows[0].n),7);
  });
  const q=incoming(),first=await f.rpc('resolve',q);
  await t.test('receipt repeat, altered keys, spoofed source, owner and author',async()=>{
   assert.deepEqual(await f.rpc('resolve',q),first);
   await assert.rejects(f.rpc('resolve',{...q,initialFields:{title:'different'}}),{code:'REQUEST_ID_CONFLICT'});
   assert.deepEqual(await f.rpc('operations.get',{ownerId:'fixture',requestId:c.requestId}),c);
   await assert.rejects(f.rpc('resolve',incoming({ownerId:'foreign'})),{code:'NOT_FOUND'});
   await assert.rejects(f.rpc('resolve',incoming({sourceRef:{botId:'999',chatId:'456',threadId:'7'}})),{code:'FORBIDDEN'});
   await assert.rejects(f.rpc('resolve',incoming({sourceRef:{botId:'123',chatId:'456',threadId:null}})),{code:'CHANNEL_NOT_FOUND'});
   await assert.rejects(f.rpc('resolve',incoming({author:{kind:'human',id:'999'}})),{code:'FORBIDDEN'});
   await assert.rejects(f.rpc('channels.create',{...metadata(),connectionId:cid,kind:'topic',address:h.result.address,parentId:null,settings:channelSettings}),{code:'VERSION_CONFLICT'});
   await assert.rejects(f.rpc('connections.create',{...metadata(),type:{code:'telegram',version:1},sourceId:'telegram_other',botId:'123',settings}),{code:'VERSION_CONFLICT'});
   await assert.rejects(f.rpc('resolve',{...q,extra:true}),{code:'INVALID_ARGUMENT'});
  });
  await t.test('concurrent CAS, replay before expectedVersion and exact historical boundary',async()=>{
   const publish={...metadata(),channelId:hid,expectedVersion:1,settings:{...channelSettings,locationRef:'space:new',rules:[rule('new')]}};
   const values=await Promise.allSettled([f.rpc('channels.publish',publish),f.rpc('channels.publish',{...publish,requestId:randomUUID()})]);
   assert.equal(values.filter(v=>v.status==='fulfilled').length,1);assert.equal(values.find(v=>v.status==='rejected').reason.code,'VERSION_CONFLICT');
   const changed=values.find(v=>v.status==='fulfilled').value,actual={...publish,requestId:changed.requestId};
   assert.deepEqual(await f.rpc('channels.publish',actual),changed);
   await assert.rejects(f.rpc('channels.publish',{...actual,reason:'changed'}),{code:'REQUEST_ID_CONFLICT'});
   assert.equal((await f.rpc('resolve',incoming({asOf:changed.result.effectiveFrom}))).channelVersion,2);
   const before=(await f.owner.query("SELECT to_char(($1::timestamptz-interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') t",[changed.result.effectiveFrom])).rows[0].t;
   assert.equal((await f.rpc('resolve',incoming({asOf:before}))).channelVersion,1);
   assert.deepEqual(await f.rpc('resolve',q),first);
   const reply=incoming({sourceId:'fixture_hermes',eventType:'message.outgoing',direction:'outgoing',author:{kind:'agent',id:'hermes'},replyTo:{packetId:first.packetId,resolutionId:first.resolutionId}});
   const out=await f.rpc('resolve',reply);assert.equal(out.locationRef,'space:initial');assert.equal(out.channelVersion,1);assert.equal(out.sourceId,'fixture_hermes');
   await assert.rejects(f.rpc('resolve',{...reply,operationId:randomUUID(),replyTo:{...reply.replyTo,packetId:randomUUID()}}),{code:'NOT_FOUND'});
   await assert.rejects(f.rpc('resolve',{...reply,operationId:randomUUID(),sourceRef:{...reply.sourceRef,chatId:'999'}}),{code:'DESTINATION_CONFLICT'});
   const check={ownerId:'fixture',resolutionId:out.resolutionId,destinationHash:f.hash(out.destination)};
   assert.equal((await f.rpc('delivery.check',check,f.delivery,'delivery_test')).allowed,true);
   const revoke=await f.rpc('channels.publish',{...metadata(),channelId:hid,expectedVersion:2,settings:{...changed.result.settings,allowedActorIds:['999']}});
   await assert.rejects(f.rpc('delivery.check',check,f.delivery,'delivery_test'),{code:'FORBIDDEN'});
   const disable=await f.rpc('connections.publish',{...metadata(),connectionId:cid,expectedVersion:1,settings:{...settings,enabled:false}});
   await assert.rejects(f.rpc('delivery.check',check,f.delivery,'delivery_test'),{code:'DISABLED'});
   assert.deepEqual(await f.rpc('resolve',q),first);
   await f.rpc('connections.publish',{...metadata(),connectionId:cid,expectedVersion:disable.result.version,settings});
   await f.rpc('channels.publish',{...metadata(),channelId:hid,expectedVersion:revoke.result.version,settings:channelSettings});
  });
  await t.test('receipt fact reaches real History exactly once through coordinator API',async()=>{
   const nc=await connect({servers:'nats://127.0.0.1:24343',user:'fixture',pass:'intake-test',inboxPrefix:'_INBOX.channels_audit'});
   let history;
   const rpc=async(subject,input)=>{const m=await nc.request(subject,Buffer.from(JSON.stringify(input)),{timeout:3000});assert.equal(m.headers?.get('Nats-Service-Error-Code'),undefined);return JSON.parse(new TextDecoder().decode(m.data));};
   try{
    const migration=run('services/history/dist/migrate.js',{HISTORY_OWNER_DATABASE_URL:url('intake_history_test_owner','brai_intake_history_test'),HISTORY_OWNER_ROLE:'intake_history_test_owner',HISTORY_APP_ROLE:'intake_history_test_app',HISTORY_WEB_ROLE:'intake_history_test_web'});
    assert.equal(await migration.done,0,migration.output());
    history=run('services/history/dist/main.js',{NATS_URL:'nats://127.0.0.1:24343',NATS_USER:'fixture',NATS_PASSWORD:'intake-test',NATS_INBOX_PREFIX:'_INBOX.history_fixture',HISTORY_APP_DATABASE_URL:url('intake_history_test_app','brai_intake_history_test'),HISTORY_WEB_DATABASE_URL:url('intake_history_test_web','brai_intake_history_test'),HISTORY_CURSOR_HMAC_KEY_FILE:f.temp+'/key',HISTORY_MCP_HOST:'127.0.0.1',HISTORY_MCP_PORT:'38115',HISTORY_MCP_ALLOWED_HOSTS:'127.0.0.1,localhost',HISTORY_MCP_ALLOWED_ORIGINS:'http://127.0.0.1:38115',HISTORY_MCP_MAX_SESSIONS:'4',HISTORY_MCP_SESSION_IDLE_MS:'60000',HISTORY_GAME_CORE_EVENTS_ENABLED:'false'});
    await eventually(async()=>{if(history.child.exitCode!==null)throw Error(history.output());await rpc('brai.history.v1.query.list',{user_id:'fixture',limit:1});return true;});
    await rpc('brai.history.v1.append.service_channels',c.historyEvent);
    await rpc('brai.history.v1.append.service_channels',c.historyEvent);
    const list=await rpc('brai.history.v1.query.list',{user_id:'fixture',filters:{source:'service_channels',object_type:'channel_connection',object_id:cid},limit:100});
    assert.equal(list.items.length,1);assert.equal(list.items[0].id,c.historyEvent.id);
   }finally{await history?.stop();await nc.close();}
  });
  await t.test('second bot, null topic uniqueness and protected pagination',async()=>{
   const other=await seed(f,{sourceId:'telegram_other',botId:'124'});
   assert.equal((await f.rpc('resolve',incoming({sourceId:'telegram_other',sourceRef:{botId:'124',chatId:'456',threadId:'7'}}))).connectionId,other.c.result.id);
   const dialog={...metadata(),connectionId:cid,kind:'dialog',address:{botId:'123',chatId:'456',threadId:null},parentId:null,settings:channelSettings};
   await f.rpc('channels.create',dialog);
   await assert.rejects(f.rpc('channels.create',{...dialog,requestId:randomUUID()}),{code:'VERSION_CONFLICT'});
   const page=await f.rpc('channels.list',{ownerId:'fixture',limit:1});assert.ok(page.nextCursor);
   assert.equal((await f.rpc('channels.list',{ownerId:'fixture',limit:1,cursor:page.nextCursor})).items.length,1);
   await assert.rejects(f.rpc('channels.list',{ownerId:'fixture',limit:1,cursor:page.nextCursor},f.reader,'reader_test'),{code:'INVALID_ARGUMENT'});
   const denied=await connect({servers:'nats://127.0.0.1:24343',user:'channels_denied',pass:'intake-test',inboxPrefix:'_INBOX.channels_denied'});
   try{await assert.rejects(denied.request('brai.channels.v1.connections.list.admin_test',Buffer.from('{}'),{timeout:150}));}finally{await denied.close();}
  });
  await t.test('rollback between version and receipt leaves no accepted fragments',async()=>{
   const before=await f.rpc('channels.get',{ownerId:'fixture',channelId:hid}),store=createStore(f.app);
   const broken={transaction:(ctx,work)=>store.transaction(ctx,r=>work(new Proxy(r,{get:(o,k)=>k==='saveReceipt'?async()=>{throw Error('INJECTED');}:Reflect.get(o,k)})))};
   const api=createService(broken,{admin_test:{ownerIds:['fixture'],operations:['channels.publish'],sourceIds:[],replySourceIds:[],connectionIds:null}},Buffer.alloc(32,7));
   const cmd={...metadata(),channelId:hid,expectedVersion:before.version,settings:{...channelSettings,name:'rollback'}};
   await assert.rejects(api.execute('channels.publish','admin_test',cmd),{code:'NOT_READY'});
   assert.deepEqual(await f.rpc('channels.get',{ownerId:'fixture',channelId:hid}),before);
   await assert.rejects(f.rpc('operations.get',{ownerId:'fixture',requestId:cmd.requestId}),{code:'NOT_FOUND'});
  });
  await t.test('eight slots, SQL timeout, released resources and request size',async()=>{
   const v=await f.rpc('connections.get',{ownerId:'fixture',connectionId:cid});
   lock=await f.owner.connect();await lock.query('BEGIN');await lock.query('SELECT 1 FROM channels.channel_connections WHERE id=$1 FOR UPDATE',[cid]);
   const pending=Array.from({length:8},()=>f.rpc('connections.publish',{...metadata(),connectionId:cid,expectedVersion:v.version,settings}).then(()=>null,e=>e.code));
   await new Promise(r=>setTimeout(r,200));await assert.rejects(f.rpc('resolve',incoming()),{code:'BUSY'});
   assert.ok((await Promise.all(pending)).every(x=>x==='NOT_READY'));
   await lock.query('ROLLBACK');lock.release();lock=null;assert.equal((await f.rpc('status')).ready,true);
   const m=await f.admin.request('brai.channels.v1.resolve.admin_test',Buffer.alloc(65537,32),{timeout:1000});
   assert.equal(JSON.parse(new TextDecoder().decode(m.data)).code,'REQUEST_TOO_LARGE');
  });
  await t.test('unavailable schema and profile semantic collision fail explicitly',async()=>{
   await f.owner.query("UPDATE channels.sys_channel_types SET descriptor=jsonb_set(descriptor,'{capabilities}', '[]')");
   const m=f.migrate();assert.notEqual(await m.done,0);assert.match(m.output(),/PROFILE_SEMANTICS_CONFLICT/);
   await f.owner.query("UPDATE channels.sys_channel_types SET descriptor=$1",[JSON.parse(await readFile(new URL('../../profiles/telegram.v1.json',import.meta.url),'utf8'))]);
   await f.owner.query('REVOKE USAGE ON SCHEMA channels FROM channels_test');
   try{
    await assert.rejects(f.rpc('resolve',incoming()),{code:'NOT_READY'});
    assert.equal((await f.rpc('status')).ready,false);
   }finally{await f.owner.query('GRANT USAGE ON SCHEMA channels TO channels_test');}
   await eventually(async()=>(await f.rpc('status')).ready);
  });
  await t.test('active SQL connection loss does not kill the process; closed endpoint recovers',async()=>{
   lock=await f.owner.connect();await lock.query('BEGIN');await lock.query('SELECT 1 FROM channels.channel_connections WHERE id=$1 FOR UPDATE',[cid]);
   const pending=f.rpc('resolve',incoming()).then(()=>null,e=>e.code);
   const pid=await eventually(async()=>(await f.app.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND application_name='service_channels' AND wait_event_type='Lock'")).rows[0]?.pid);
   assert.equal((await f.app.query('SELECT pg_terminate_backend($1) killed',[pid])).rows[0].killed,true);
   assert.equal(await pending,'NOT_READY');
   await lock.query('ROLLBACK');lock.release();lock=null;
   assert.equal((await f.rpc('status')).ready,true);
   assert.ok(process.kill(f.pid(),0));
   await f.restart('postgresql://channels_test:intake-test@127.0.0.1:1/brai_channels_test');
   assert.equal((await f.rpc('status')).ready,false);
   await assert.rejects(f.rpc('resolve',incoming()),{code:'NOT_READY'});
   await f.restart();assert.equal((await f.rpc('status')).ready,true);
  });
  await t.test('publish and first resolve serialize to a complete historical version',async()=>{
   for(let n=0;n<5;n++){
    const old=await f.rpc('channels.get',{ownerId:'fixture',channelId:hid});
    const q=incoming();
    const [published,resolved]=await Promise.all([
     f.rpc('channels.publish',{...metadata(),channelId:hid,expectedVersion:old.version,settings:{...channelSettings,name:'race'+n,rules:[rule('race'+n)]}}),
     f.rpc('resolve',q)
    ]);
    const expected=resolved.asOf<published.result.effectiveFrom?old:published.result;
    assert.equal(resolved.channelVersion,expected.version);
    assert.equal(resolved.rulesVersion,expected.rulesVersion);
    assert.deepEqual(resolved.snapshot.rules,expected.settings.rules);
    assert.deepEqual(await f.rpc('resolve',q),resolved);
   }
  });
  await t.test('restart keeps resolution and benchmark records RPC latency and RSS',async()=>{
   await f.restart();assert.deepEqual(await f.rpc('resolve',q),first);
   const times=[];for(let n=0;n<30;n++){const at=performance.now();await f.rpc('resolve',incoming());times.push(performance.now()-at);}
   times.sort((a,b)=>a-b);const status=await readFile('/proc/'+f.pid()+'/status','utf8');
   console.log(JSON.stringify({channelsBenchmark:{samples:30,p50ms:times[15],p95ms:times[28],rssKiB:Number(status.match(/VmRSS:\s+(\d+)/)[1])}}));
  });
 }finally{if(lock){await lock.query('ROLLBACK');lock.release();}await f.close();}
});
