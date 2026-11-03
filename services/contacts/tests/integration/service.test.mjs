// ABOUTME: Проверяет все операции Контактов через настоящий процесс/БД/NATS.
// ABOUTME: Сценарии ограничены disposable БД и синтетическими аккаунтами.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {startContacts,observation,enabled,eventually} from './fixture.mjs';
const options={skip:!enabled,timeout:45000};let f;
test.before(async()=>{if(enabled)f=await startContacts();});
test.after(async()=>{await f?.close();});
test('six operations, isolated owners, two bots, current profile and receipts',options,async()=>{
 assert.equal((await f.rpc('status')).ready,true);
 const q=observation({identity:{namespace:'telegram',externalId:'10001'}}),one=await f.rpc('resolve',q);
 const two=await f.rpc('resolve',observation({identity:q.identity,sourceId:'telegram_other',profile:{username:'same'}}));
 assert.equal(one.contactId,two.contactId);
 const foreign=await f.rpc('resolve',observation({identity:q.identity,ownerId:'foreign'}));assert.notEqual(one.contactId,foreign.contactId);
 assert.equal((await f.rpc('contacts.get',{ownerId:'fixture',contactId:one.contactId})).identities[0].username,'same');
 await assert.rejects(f.rpc('contacts.get',{ownerId:'foreign',contactId:one.contactId}),{code:'NOT_FOUND'});
 assert.equal((await f.rpc('operations.get',{ownerId:q.ownerId,operationId:q.operationId})).result.contactId,one.contactId);
 const {packetId,...observe}=observation({identity:q.identity,profile:{photoArtifactId:null}});
 const receipt=await f.rpc('profile.observe',observe);assert.equal(receipt.contactId,one.contactId);
 await assert.rejects(f.rpc('profile.observe',{...observe,operationId:randomUUID(),identity:{namespace:'telegram',externalId:'900000001'}}),{code:'NOT_FOUND'});
 await assert.rejects(f.rpc('resolve',{...q,operationId:randomUUID(),sourceId:'spoof'}),{code:'FORBIDDEN'});
});
test('concurrent first resolution creates one identity; same username does not merge',options,async()=>{
 const identity={namespace:'telegram',externalId:'10002'},results=await Promise.all(Array.from({length:6},()=>f.rpc('resolve',observation({identity,profile:{username:'shared'}}))));
 assert.equal(new Set(results.map(x=>x.contactId)).size,1);
 assert.equal(Number((await f.owner.query('SELECT count(*) AS n FROM contacts.contact_identities WHERE owner_id=$1 AND external_id=$2',['fixture',identity.externalId])).rows[0].n),1);
 assert.notEqual(results[0].contactId,(await f.rpc('resolve',observation({identity:{namespace:'telegram',externalId:'10003'},profile:{username:'shared'}}))).contactId);
});
test('microseconds, null, immutable replay, operation conflict and restart',options,async()=>{
 const q=observation({identity:{namespace:'telegram',externalId:'10004'},observedAt:'2026-10-31T00:00:00.000001Z'}),one=await f.rpc('resolve',q);
 const newer=observation({identity:q.identity,observedAt:'2026-10-31T00:00:00.000002Z',profile:{name:'New',username:null}});
 await f.rpc('resolve',newer);const late=await f.rpc('resolve',observation({...q,operationId:randomUUID(),packetId:randomUUID(),profile:{name:'Old'}}));
 assert.equal(late.senderSnapshot.name,'Old');assert.equal((await f.rpc('contacts.get',{ownerId:'fixture',contactId:one.contactId})).identities[0].name,'New');
 assert.deepEqual(await f.rpc('resolve',q),one);
 await assert.rejects(f.rpc('resolve',{...q,profile:{name:'Changed'}}),{code:'REQUEST_ID_CONFLICT'});
 const {packetId,...other}=q;await assert.rejects(f.rpc('profile.observe',other),{code:'REQUEST_ID_CONFLICT'});
 await f.restart();assert.deepEqual(await f.rpc('resolve',q),one);
 const m=f.migrate();assert.equal(await m.done,0,m.output());
});
test('pagination signs owner/filter/caller scope; restricted NATS identity cannot write',options,async()=>{
 const first=await f.rpc('contacts.list',{ownerId:'fixture',limit:1});assert.equal(first.items.length,1);assert.ok(first.nextCursor);
 const second=await f.rpc('contacts.list',{ownerId:'fixture',limit:1,cursor:first.nextCursor});assert.notEqual(second.items[0].id,first.items[0].id);
 await assert.rejects(f.rpc('contacts.list',{ownerId:'foreign',limit:1,cursor:first.nextCursor}),{code:'INVALID_CURSOR'});
 await assert.rejects(f.rpc('contacts.list',{ownerId:'fixture',limit:2,cursor:first.nextCursor}),{code:'INVALID_CURSOR'});
 assert.equal((await f.rpc('contacts.list',{ownerId:'fixture',namespace:'telegram',externalId:'10001'})).items.length,1);
 assert.ok((await f.rpc('contacts.list',{ownerId:'fixture'},f.reader,'reader_test')).items.length);
 let denied=false;const sub=f.reader.status();const watcher=(async()=>{for await(const s of sub){if(s.type==='error'){denied=true;break;}}})();
 await f.reader.publish('brai.contacts.v1.resolve.admin_test',Buffer.from(JSON.stringify(observation())));await f.reader.flush();await eventually(()=>denied);sub.stop();await watcher;
});
test('rollback before receipt leaves no contact or identity; runtime cannot edit history',options,async()=>{
 const id='10005',q=observation({operationId:'rollback-'+randomUUID(),identity:{namespace:'telegram',externalId:id}});
 await f.owner.query("CREATE OR REPLACE FUNCTION contacts.test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_id LIKE 'rollback-%' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$");
 await f.owner.query('CREATE TRIGGER synthetic_fail BEFORE INSERT ON contacts.contact_operations FOR EACH ROW EXECUTE FUNCTION contacts.test_fail_receipt()');
 try{await assert.rejects(f.rpc('resolve',q));assert.equal((await f.owner.query('SELECT 1 FROM contacts.contact_identities WHERE external_id=$1',[id])).rowCount,0);}
 finally{await f.owner.query('DROP TRIGGER synthetic_fail ON contacts.contact_operations');await f.owner.query('DROP FUNCTION contacts.test_fail_receipt()');}
 const result=await f.rpc('resolve',q);assert.ok(result.contactId);
 for(const sql of ["UPDATE contacts.contact_operations SET input_hash='bad'","DELETE FROM contacts.contact_operations","UPDATE contacts.contact_identities SET external_id='9'","UPDATE contacts.contacts SET owner_id='foreign'","CREATE TABLE contacts.forbidden(id int)"])await assert.rejects(f.app.query(sql),{code:'42501'});
});
test('SQL lock deadline, overload and connection termination release resources without crash',options,async()=>{
 const q=observation({identity:{namespace:'telegram',externalId:'10006'}});
 const holder=await f.owner.connect();await holder.query('BEGIN');
 await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,67312))",['identity/'+JSON.stringify(['fixture','telegram','10006'])]);
 const pending=f.rpc('resolve',q).catch(e=>e);
 try{const pid=await eventually(async()=>(await f.app.query("SELECT pid FROM pg_stat_activity WHERE application_name='service_contacts' AND wait_event_type='Lock'")).rows[0]?.pid);await f.app.query('SELECT pg_terminate_backend($1)',[pid]);assert.equal((await pending).code,'DATABASE_UNAVAILABLE');}
 finally{await holder.query('ROLLBACK');holder.release();}
 assert.equal((await f.rpc('status')).ready,true);
 const h=await f.owner.connect();await h.query('BEGIN');await h.query("SELECT pg_advisory_xact_lock(hashtextextended($1,67312))",['identity/'+JSON.stringify(['fixture','telegram','10007'])]);
 try{const results=await Promise.all(Array.from({length:20},()=>f.rpc('resolve',observation({identity:{namespace:'telegram',externalId:'10007'}})).catch(e=>e)));assert.ok(results.some(x=>x.code==='BUSY'));assert.ok(results.some(x=>x.code==='DEADLINE_EXCEEDED'));}
 finally{await h.query('ROLLBACK');h.release();}
 assert.equal((await f.rpc('status')).ready,true);
 await f.restart('postgresql://contacts_test:intake-test@127.0.0.1:1/brai_contacts_test');assert.equal((await f.rpc('status')).ready,false);await f.restart();assert.equal((await f.rpc('status')).ready,true);
});
test('wire limits, closed DTO, malformed UTF-8 and uppercase input UUID replay policy',options,async()=>{
 await assert.rejects(f.rpc('resolve',{...observation(),extra:true}),{code:'INVALID_REQUEST'});
 for(const bytes of [Buffer.from([255]),Buffer.alloc(65537,32)]){const r=await f.admin.request('brai.contacts.v1.resolve.admin_test',bytes,{timeout:8000});assert.ok(['INVALID_REQUEST','REQUEST_TOO_LARGE'].includes(JSON.parse(new TextDecoder().decode(r.data)).code));}
 const q=observation({packetId:'AABBCCDD-AABB-4CCD-8EEE-AABBCCDDEEFF',identity:{namespace:'telegram',externalId:'10008'}}),result=await f.rpc('resolve',q);
 assert.equal(result.packetId,q.packetId);await assert.rejects(f.rpc('resolve',{...q,packetId:q.packetId.toLowerCase()}),{code:'REQUEST_ID_CONFLICT'});
});

test('lost response after COMMIT replays the same receipt and records bounded standalone RPC sample',options,async()=>{
 const q=observation({identity:{namespace:'telegram',externalId:'10009'}});
 f.admin.publish('brai.contacts.v1.resolve.admin_test',Buffer.from(JSON.stringify(q)));await f.admin.flush();
 const committed=await eventually(async()=>(await f.owner.query('SELECT result FROM contacts.contact_operations WHERE caller_id=$1 AND owner_id=$2 AND operation_id=$3',['admin_test',q.ownerId,q.operationId])).rows[0]?.result);
 assert.deepEqual(await f.rpc('resolve',q),committed);assert.deepEqual(await f.rpc('resolve',q),committed);
 const samples=[];for(let i=0;i<20;i++){const start=performance.now();await f.rpc('contacts.get',{ownerId:'fixture',contactId:committed.contactId});samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);
 const status=await readFile('/proc/'+f.pid()+'/status','utf8');
 console.log(JSON.stringify({contactsBenchmark:{samples:20,p50ms:samples[10],p95ms:samples[19],rssKiB:Number(status.match(/VmRSS:\s+(\d+)/)?.[1]),note:'Standalone process; sequential small get calls, not a load capacity guarantee'}}));
});
