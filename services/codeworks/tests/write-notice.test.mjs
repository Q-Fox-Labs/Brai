// ABOUTME: Проверяет защиту и повторную доставку metadata-only журнала Post.
// ABOUTME: Не подключается к NATS или установленным сервисам.
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtempSync,chmodSync,rmSync,readdirSync,writeFileSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import {saveNotice,listNotices,scanNotices,ackNotice,canonicalHash,rawHash} from '../src/write-notice.mjs';
const notice=(project='brai',tool='t')=>({version:1,executor_id:'codex',request:{project_id:project,session_id:'s',turn_id:'u',tool_use_id:tool,tool_name:'apply_patch',input_sha256:'a'.repeat(64),canonical_input_sha256:'b'.repeat(64),outcome:'success'}});
function dir(t){const d=mkdtempSync('/tmp/cw-notice-');t.after(()=>rmSync(d,{recursive:true,force:true}));return d;}
test('persist, deduplicate, filter before limit and acknowledge exact metadata',t=>{
 const d=dir(t),a=notice('a','1'),b=notice('b','2'),r=saveNotice(d,a),r2=saveNotice(d,a);assert.deepEqual(r,r2);saveNotice(d,b);
 assert.deepEqual(listNotices(d,{projectId:'b',limit:1}).map(x=>x.notice),[b]);assert.equal(readdirSync(d).length,2);
 assert.throws(()=>saveNotice(d,{...a,request:{...a.request,outcome:'error'}}),/WRITE_CALL_MISMATCH/);
 assert.throws(()=>ackNotice(d,r.id,{...a,request:{...a.request,outcome:'error'}}),/WRITE_CALL_MISMATCH/);
 ackNotice(d,r.id,a);ackNotice(d,r.id,a);assert.deepEqual(listNotices(d,{projectId:'a'}),[]);assert.equal(readdirSync(d).length,1);
});
test('rejects symlink, unsafe permissions and non-metadata payload',t=>{
 const d=dir(t),n=notice();chmodSync(d,0o755);assert.throws(()=>saveNotice(d,n));chmodSync(d,0o500);assert.throws(()=>saveNotice(d,n));chmodSync(d,0o700);
 assert.throws(()=>saveNotice(d,{...n,patch:'private'}),/NOTICE_INVALID/);assert.throws(()=>saveNotice(d,{...n,request:{...n.request,tool_response:'private'}}),/NOTICE_INVALID/);
 const r=saveNotice(d,n),file=path.join(d,r.id+'.json');rmSync(file);symlinkSync('/dev/null',file);assert.deepEqual(listNotices(d,{projectId:'brai'}),[]);assert.throws(()=>ackNotice(d,r.id,n));
});
test('canonical hash ignores object key order, raw digest preserves it',()=>{
 assert.equal(canonicalHash({b:1,a:{z:3,x:2}}),canonicalHash({a:{x:2,z:3},b:1}));assert.notEqual(rawHash({a:1,b:2}),rawHash({b:2,a:1}));
});
test('invalid names and oversized files never get delivered',t=>{
 const d=dir(t);writeFileSync(path.join(d,'unexpected'),'',{mode:0o600});assert.deepEqual(listNotices(d,{projectId:'brai'}),[]);
});

test('scanner reports invalid entries without starving valid projects',t=>{
 const d=dir(t),n=notice('brai','valid');const r=saveNotice(d,n);writeFileSync(path.join(d,'unexpected'),'',{mode:0o600});
 const entries=scanNotices(d);assert.equal(entries.filter(e=>e.error==='NOTICE_INVALID').length,1);assert.deepEqual(entries.find(e=>e.id===r.id).notice,n);
});

test('crash after temp fsync is recovered without another user action',t=>{
 const d=dir(t),n=notice(),script="import {saveNotice} from "+JSON.stringify(new URL('../src/write-notice.mjs',import.meta.url).href)+";saveNotice(process.argv[1],JSON.parse(process.argv[2]),{checkpoint:()=>process.exit(77)});";
 const child=spawnSync(process.execPath,['--input-type=module','-e',script,d,JSON.stringify(n)]);assert.equal(child.status,77);assert.ok(readdirSync(d).some(name=>name.endsWith('.tmp')));
 const entries=scanNotices(d);assert.equal(entries.length,1);assert.deepEqual(entries[0].notice,n);ackNotice(d,entries[0].id,n);assert.deepEqual(readdirSync(d),[]);
});
test('malformed abandoned temp remains diagnostic without blocking valid records',t=>{
 const d=dir(t),n=notice(),r=saveNotice(d,n);writeFileSync(path.join(d,'.00000000-0000-4000-8000-000000000001.tmp'),'{broken',{mode:0o600});
 const entries=scanNotices(d);assert.ok(entries.some(e=>e.id===r.id));assert.ok(entries.some(e=>e.error==='NOTICE_INVALID'));assert.equal(listNotices(d,{projectId:'brai'}).length,1);assert.ok(readdirSync(d).some(name=>name.endsWith('.tmp')));
});


test('legacy v1 notices remain readable and v2 records explicit execution status',t=>{
 const d=dir(t),v1=notice('brai','legacy'),v2={version:2,executor_id:'codex',request:{...notice('brai','new').request,execution_status:'not_started',outcome:'error'}};
 saveNotice(d,v1);saveNotice(d,v2);const entries=listNotices(d,{projectId:'brai'});assert.deepEqual(entries.map(e=>e.notice).sort((a,b)=>a.version-b.version),[v1,v2]);
 assert.throws(()=>saveNotice(d,{...v2,request:{...v2.request,outcome:'success'}}),/NOTICE_INVALID/);
 assert.throws(()=>saveNotice(d,{...v2,request:{...v2.request,execution_status:'other'}}),/NOTICE_INVALID/);
});


test('overfull journal drains valid notices with cursor despite invalid files',t=>{
 const d=dir(t),a=notice('brai','a'),b=notice('brai','b'),first=saveNotice(d,a),second=saveNotice(d,b);
 for(let i=0;i<4097;i++)writeFileSync(path.join(d,'invalid-'+String(i).padStart(5,'0')),'',{mode:0o600});
 assert.throws(()=>saveNotice(d,notice('brai','new')),/NOTICE_SPOOL_FULL/);assert.equal(saveNotice(d,a).id,first.id);
 const ids=[first.id,second.id].sort();const one=scanNotices(d,{projectId:'brai',limit:1});assert.equal(one[0].id,ids[0]);const two=scanNotices(d,{projectId:'brai',limit:1,cursor:one[0].id});assert.equal(two[0].id,ids[1]);assert.equal(scanNotices(d,{projectId:'brai',limit:1,cursor:two[0].id})[0].id,ids[0]);
 ackNotice(d,first.id,a);ackNotice(d,second.id,b);assert.equal(readdirSync(d).length,4097);
});
