// ABOUTME: Ограниченный замер приёма и текстового индекса в отдельной PostgreSQL fixture.
// ABOUTME: Запускается явно с BUG_HUNT_LOAD_RUN=<новый UUID>; модели не вызываются.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {Pool} from 'pg';
import {createStore} from '../../dist/storage.js';
import {createSystemStore} from '../../dist/system-store.js';
import {createProcessingStore} from '../../dist/processing-store.js';
import {invokeSystem} from '../../dist/system-contracts.js';
import {observationHash} from '../../dist/processing.js';

const run=process.env.BUG_HUNT_LOAD_RUN;
if(!run||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(run))throw Error('BUG_HUNT_LOAD_RUN must be a new UUID');
const count=Number(process.env.BUG_HUNT_LOAD_COUNT??500);
if(!Number.isInteger(count)||count<500||count>980)throw Error('count must be 500..980; total is limited to 1000');
const fixture=JSON.parse(readFileSync(new URL('../../../../tmp/bug-hunt-test.json',import.meta.url),'utf8'));
function fixtureURL(role){
 const raw=fixture[role+'URL'],u=new URL(raw);
 if(u.protocol!=='postgresql:'||u.hostname!=='127.0.0.1'||u.port!=='18585'||u.pathname!=='/brai_bug_hunt_test'||u.username!=='bug_hunt_'+role)throw Error('Dedicated fixture required');
 return raw;
}
const app=new Pool({connectionString:fixtureURL('app'),max:4,connectionTimeoutMillis:2000});
const background=new Pool({connectionString:fixtureURL('app'),max:2,connectionTimeoutMillis:2000});
const installationId='bug-hunt-load-'+run,ownerId='synthetic-load-'+run;
const principal={ownerId,actorId:'synthetic-load',source:'codex',reviewer:false};
const foreign={...principal,ownerId:'synthetic-other-'+run};
const options={installationId,cursorKey:'synthetic-load-cursor-key-at-least-32-bytes',maxReports:1000,reportsPerMinute:1000};
const store=createStore(app,options),system=createSystemStore(background,options);
const processing=createProcessingStore(background,{...options,leaseMs:60000,intakeReserveBytes:1048576});
const input=i=>({request_id:run+':'+i,observation:{title:'Synthetic repeated fault',operation:'save',component_id:'fixture-load',component_version:'1',expected:'Saved',observed:'Synthetic load marker disappears',error_code:'LOAD_FIXTURE'}});
const durations={intake:[],replay:[],indexBatch:[],mixedIntake:[],search:[],group:[],reconcile:[]};
const timed=async(name,fn)=>{const start=performance.now();try{return await fn();}finally{durations[name].push(performance.now()-start);}};
async function parallel(items,width,fn){let next=0;await Promise.all(Array.from({length:width},async()=>{while(next<items.length){const i=next++;await fn(items[i],i);}}));}
const query=async()=> (await app.query('SELECT (SELECT count(*)::int FROM report WHERE installation_id=$1 AND owner_id=$2) reports,(SELECT count(*)::int FROM processing_job WHERE installation_id=$1 AND owner_id=$2) jobs',[installationId,ownerId])).rows[0];
const summary=values=>{const a=[...values].sort((x,y)=>x-y),at=q=>Number(a[Math.ceil(a.length*q)-1].toFixed(2));return {n:a.length,p50_ms:at(.5),p95_ms:at(.95),max_ms:at(1)};};
const call=(op,p,args)=>invokeSystem(system,op,p,args);
try{
 assert.deepEqual(await query(),{reports:0,jobs:0},'UUID must identify a fresh scope');
 const receipts=[];
 const start=performance.now();
 await parallel(Array.from({length:count},(_,i)=>i),4,async i=>{receipts[i]=await timed('intake',()=>store.report(principal,input(i),async()=>{}));assert.equal(receipts[i].replayed,false);});
 const intakeElapsed=performance.now()-start;
 assert.deepEqual(await query(),{reports:count,jobs:count*3});
 const before=(await app.query('SELECT id,observation FROM report WHERE installation_id=$1 AND owner_id=$2',[installationId,ownerId])).rows;
 const hashes=new Map(before.map(row=>[row.id,observationHash(row.observation)]));
 await parallel(Array.from({length:50},(_,i)=>i),4,async i=>{const result=await timed('replay',()=>store.report(principal,input(i),async()=>{}));assert.equal(result.replayed,true);assert.equal(result.report_id,receipts[i].report_id);});
 assert.deepEqual(await query(),{reports:count,jobs:count*3},'replay must not create rows');
 let indexed=0,n;
 do{n=await timed('indexBatch',()=>system.reconcileLocal(50));indexed+=n;}while(n);
 assert.equal(indexed,count);
 const groupRows=await app.query('SELECT group_id,count(*)::int n FROM group_membership WHERE installation_id=$1 AND owner_id=$2 GROUP BY group_id',[installationId,ownerId]);
 assert.equal(groupRows.rowCount,1);assert.equal(groupRows.rows[0].n,count);
 const groupId=groupRows.rows[0].group_id;
 const mixedStart=performance.now();
 await Promise.all([
  parallel(Array.from({length:20},(_,i)=>count+i),4,async i=>{const result=await timed('mixedIntake',()=>store.report(principal,input(i),async()=>{}));assert.equal(result.replayed,false);}),
  parallel(Array.from({length:20}),1,async()=>{const result=await timed('search',()=>call('search',principal,{query:'LOAD_FIXTURE',limit:10}));assert.ok(result.items.length>0);}),
  parallel(Array.from({length:20}),1,async()=>{const result=await timed('group',()=>call('groups-get',principal,{group_id:groupId,limit:10}));assert.ok(result.group.member_count>=count);}),
  parallel(Array.from({length:20}),1,async()=>{assert.equal(await timed('reconcile',()=>processing.reconcile(50)),0);})
 ]);
 const mixedElapsed=performance.now()-mixedStart;
 while(await system.reconcileLocal(50)){}
 assert.deepEqual(await query(),{reports:count+20,jobs:(count+20)*3});
 const grouped=await app.query('SELECT group_id,count(*)::int n FROM group_membership WHERE installation_id=$1 AND owner_id=$2 GROUP BY group_id',[installationId,ownerId]);
 assert.equal(grouped.rowCount,1);assert.equal(grouped.rows[0].n,count+20);
 const after=(await app.query('SELECT id,observation FROM report WHERE installation_id=$1 AND owner_id=$2',[installationId,ownerId])).rows;
 for(const row of after)if(hashes.has(row.id))assert.equal(observationHash(row.observation),hashes.get(row.id));
 assert.equal(hashes.size,count);
 assert.equal((await call('search',foreign,{query:'LOAD_FIXTURE'})).items.length,0);
 await assert.rejects(call('groups-get',foreign,{group_id:groupId}),e=>e.code==='NOT_FOUND');
 await assert.rejects(app.query('UPDATE report SET observation=observation WHERE installation_id=$1',[installationId]),e=>e.code==='42501');
 await assert.rejects(app.query('DELETE FROM report WHERE installation_id=$1',[installationId]),e=>e.code==='42501');
 console.log(JSON.stringify({status:'ok',run,initial_reports:count,final_reports:count+20,jobs:(count+20)*3,replays:50,new_rows_from_replay:0,indexed,groups:grouped.rowCount,original_hashes_checked:hashes.size,intake_elapsed_ms:Number(intakeElapsed.toFixed(2)),mixed_elapsed_ms:Number(mixedElapsed.toFixed(2)),latency:Object.fromEntries(Object.entries(durations).map(([key,values])=>[key,summary(values)])),pool_limits:{foreground:4,background:2},models:'not invoked'},null,2));
}finally{await Promise.all([app.end(),background.end()]);}
