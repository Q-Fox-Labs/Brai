// ABOUTME: Проверяет полное ограниченное чтение памяти через Unix HTTP и подписанные части.
// ABOUTME: Использует синтетические данные и не обращается к рабочим профилям.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { Control, createMemoryReader } from '../control.mjs';

async function fixture(handler) {
 const root = mkdtempSync(join(tmpdir(), 'memory-detail-')), socketPath = join(root, 'memory.sock');
 const server = createServer(handler);
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
 return { socketPath, async close() { await new Promise(resolve => server.close(resolve)); rmSync(root, {recursive:true,force:true}); } };
}
function setup(memoryRead) {
 let active = true, audit = 0, epoch = 'e', actor = 'actor';
 const c = new Control({ origin:'https://example.test', cursorKey:'x'.repeat(32),
  registry:async()=>({version:1,profiles:{'1001':{userId:'u',profileId:'p',memoryEpoch:epoch,status:'active'},'1002':{userId:'v',profileId:'q',memoryEpoch:'e',status:'active'}}}),
  authCall:async op=> op === 'session'
   ? {status:200,body:{user:{id:actor,role:'admin',status:active?'active':'blocked'},session:{}}}
   : (audit++, {status:200}), memoryRead });
 return { c, revoke:()=>{active=false;}, restore:()=>{active=true;}, audits:()=>audit, setEpoch:value=>{epoch=value;}, setActor:value=>{actor=value;} };
}
const headers={cookie:'session=one',origin:'https://example.test'};
const input={headers,userId:'u',memoryId:'m'};

test('Unix HTTP detail over 1 MiB returns complete audited ordered chunks', async () => {
 const value={id:'m',profileId:'p',memory:'Я'.repeat(700000),metadata:{source:'fixture'}}, raw=JSON.stringify(value);
 const f=await fixture((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(raw);});
 try {
  const {c,revoke,restore,audits}=setup(createMemoryReader(f.socketPath));
  const first=await c.invoke('admin-memory-get',input);
  assert.equal(first.status,200);
  assert.ok(Buffer.byteLength(JSON.stringify(first))<900000);
  assert.equal(first.body.userId,'u');
  assert.equal(first.body.offset,0);
  assert.ok(first.body.nextCursor);
  const stolen=await c.invoke('admin-memory-get',{...input,headers:{...headers,cookie:'session=other'},cursor:first.body.nextCursor});
  assert.equal(stolen.status,400);
  const cross=await c.invoke('admin-memory-get',{...input,userId:'v',cursor:first.body.nextCursor});
  assert.equal(cross.status,400);
  revoke();
  assert.equal((await c.invoke('admin-memory-get',{...input,cursor:first.body.nextCursor})).status,403);
  restore();
  const parts=[Buffer.from(first.body.chunkBase64,'base64')]; let cursor=first.body.nextCursor, offset=parts[0].length;
  while(cursor) {
   const next=await c.invoke('admin-memory-get',{...input,cursor});
   assert.equal(next.status,200);
   assert.equal(next.body.snapshotId,first.body.snapshotId);
   assert.equal(next.body.offset,offset);
   assert.ok(Buffer.byteLength(JSON.stringify(next))<900000);
   const part=Buffer.from(next.body.chunkBase64,'base64');parts.push(part);offset+=part.length;cursor=next.body.nextCursor;
  }
  const assembled=Buffer.concat(parts);
  assert.equal(assembled.toString(),raw);
  assert.equal(createHash('sha256').update(assembled).digest('hex'),first.body.sha256);
  assert.ok(audits()>=parts.length);
  assert.notEqual((await c.invoke('admin-memory-get',{...input,cursor:first.body.nextCursor})).status,200);
 } finally {await f.close();}
});

test('invalid offset and changed memory ID cannot reuse a snapshot', async () => {
 const f=await fixture((req,res)=>res.end(JSON.stringify({id:'m',profileId:'p',memory:'x'.repeat(500000)})));
 try {
  const {c}=setup(createMemoryReader(f.socketPath));
  const first=await c.invoke('admin-memory-get',input);
  const forged=c.encodeCursor({operation:'admin-memory-get',userId:'u',id:'m',query:null,limit:50,actor:'actor',
   session:createHmac('sha256','x'.repeat(32)).update(headers.cookie).digest('hex'),profileId:'p',memoryEpoch:'e'},first.body.snapshotId+':1');
  assert.equal((await c.invoke('admin-memory-get',{...input,cursor:forged})).status,503);
  assert.equal((await c.invoke('admin-memory-get',{...input,memoryId:'other',cursor:first.body.nextCursor})).status,400);
 } finally {await f.close();}
});

test('oversized or interrupted Unix HTTP response rejects promptly', async () => {
 let mode='oversize';
 const f=await fixture((req,res)=>{
  if(mode==='oversize') {res.writeHead(200,{'content-length':String(16*1024*1024+1)});res.flushHeaders();}
  else {res.writeHead(200,{'content-length':'10000'});res.write('partial');res.destroy();}
 });
 try {
  const reader=createMemoryReader(f.socketPath);
  for(const kind of ['oversize','closed']) {
   mode=kind;
   await assert.rejects(Promise.race([reader({operation:'admin-memory-get',profile:{userId:'u'},id:'m'}),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('test timeout')),1500))]), error=>error.message==='SOURCE_UNAVAILABLE');
  }
 } finally {await f.close();}
});

test('snapshot cursor cannot cross administrator or profile epoch', async () => {
 const f=await fixture((req,res)=>res.end(JSON.stringify({id:'m',profileId:'p',memory:'x'.repeat(500000)})));
 try {
  const {c,setEpoch,setActor}=setup(createMemoryReader(f.socketPath));
  const first=await c.invoke('admin-memory-get',input);
  setActor('other-admin');
  assert.equal((await c.invoke('admin-memory-get',{...input,cursor:first.body.nextCursor})).status,400);
  setActor('actor');setEpoch('new-epoch');
  assert.equal((await c.invoke('admin-memory-get',{...input,cursor:first.body.nextCursor})).status,400);
 } finally {await f.close();}
});

test('large record reads are bounded to four concurrent upstream requests', async () => {
 let release, called=0;
 const gate=new Promise(resolve=>{release=resolve;});
 const {c}=setup(async()=>{called++;await gate;return {id:'m',profileId:'p',memory:'x'};});
 const pending=Array.from({length:4},()=>c.invoke('admin-memory-get',input));
 try {
  for(let i=0;i<100&&called<4;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(called,4);
  assert.equal((await c.invoke('admin-memory-get',input)).status,503);
 } finally {release();}
 assert.deepEqual((await Promise.all(pending)).map(value=>value.status),[200,200,200,200]);
});
