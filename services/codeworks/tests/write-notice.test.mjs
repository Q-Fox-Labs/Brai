// ABOUTME: Проверяет защиту и повторную доставку metadata-only журнала Post.
// ABOUTME: Не подключается к NATS или установленным сервисам.
import test from 'node:test';
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
 const r=saveNotice(d,n),file=path.join(d,r.id+'.json');rmSync(file);symlinkSync('/dev/null',file);assert.throws(()=>listNotices(d,{projectId:'brai'}));assert.throws(()=>ackNotice(d,r.id,n));
});
test('canonical hash ignores object key order, raw digest preserves it',()=>{
 assert.equal(canonicalHash({b:1,a:{z:3,x:2}}),canonicalHash({a:{x:2,z:3},b:1}));assert.notEqual(rawHash({a:1,b:2}),rawHash({b:2,a:1}));
});
test('invalid names and oversized files never get delivered',t=>{
 const d=dir(t);writeFileSync(path.join(d,'unexpected'),'',{mode:0o600});assert.throws(()=>listNotices(d,{projectId:'brai'}),/NOTICE_INVALID/);
});

test('scanner reports invalid entries without starving valid projects',t=>{
 const d=dir(t),n=notice('brai','valid');const r=saveNotice(d,n);writeFileSync(path.join(d,'unexpected'),'',{mode:0o600});
 const entries=scanNotices(d);assert.equal(entries.filter(e=>e.error==='NOTICE_INVALID').length,1);assert.deepEqual(entries.find(e=>e.id===r.id).notice,n);
});
