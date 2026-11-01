// ABOUTME: Проверяет завершение по точным идентификаторам штатного API исполнителя.
// ABOUTME: Выполняющийся, чужой или отсутствующий item не освобождает писателя.
import test from 'node:test';
import assert from 'node:assert/strict';
import {executorProof,readExecutorItems} from '../src/executor-completion.mjs';
import {mkdtemp,mkdir,chmod,symlink,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
const call={id:'call',project_id:'p',workspace_id:'w',executor_id:'codex',session_id:'s',turn_id:'t',tool_use_id:'inner',tool_name:'Bash',state:'uncertain',admitted_at:new Date().toISOString(),payload_sha256:'a'.repeat(64),rewritten_sha256:'b'.repeat(64)};
test('terminal command and failed nested file change produce distinct private API evidence',()=>{
  const entry={turnId:'t',item:{id:'inner',type:'commandExecution',status:'completed',exitCode:0}};
  assert.equal(executorProof(call,entry).outcome,'success');
  assert.equal(executorProof({...call,tool_name:'apply_patch'},{turnId:'t',item:{id:'inner',type:'fileChange',status:'failed'}}).outcome,'error');
  for(const other of [{...entry,turnId:'other'},{...entry,item:{...entry.item,id:'other'}},{...entry,item:{...entry.item,status:'inProgress'}},{...entry,item:{...entry.item,exitCode:null}}])assert.equal(executorProof(call,other),null);
});

test('read-only socket alias verifies both child lineage fields before reading its terminal item',async t=>{
  const root=await mkdtemp('/tmp/cw-executor-api-');await mkdir(root+'/alias',{mode:0o700});await mkdir(root+'/target',{mode:0o700});
  const server=createServer(),sockets=new WebSocketServer({server}),methods=[];
  t.after(async()=>{for(const socket of sockets.clients)socket.terminate();await new Promise(r=>sockets.close(r));await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  await new Promise(r=>server.listen(root+'/target/api.sock',r));await chmod(root+'/target/api.sock',0o600);await symlink(root+'/target/api.sock',root+'/alias/api.sock');
  sockets.on('connection',ws=>ws.on('message',bytes=>{const m=JSON.parse(String(bytes));if(m.id===undefined)return;methods.push(m.method);let result={};if(m.method==='thread/read')result={thread:{id:'child',parentThreadId:'parent',source:{subAgent:{thread_spawn:{parent_thread_id:'parent',depth:1}}}}};if(m.method==='thread/turns/list')result={data:[{id:'turn',items:[{id:'inner',type:'commandExecution',status:'completed',exitCode:0}]}],nextCursor:null};ws.send(JSON.stringify({id:m.id,result}));}));
  const page=await readExecutorItems(root+'/alias/api.sock','child','turn',null,'parent');assert.equal(page.data[0].item.id,'inner');
  assert.deepEqual(methods,['initialize','thread/read','thread/turns/list']);
  await assert.rejects(readExecutorItems(root+'/alias/api.sock','child','turn',null,'foreign'),/EXECUTOR_LINEAGE_INVALID/);
  assert.deepEqual(methods.slice(3),['initialize','thread/read']);
});


test('nested executor verifies every ancestor and rejects inconsistent, cyclic or excessive lineage',async t=>{
  const root=await mkdtemp('/tmp/cw-nested-api-'),socket=root+'/api.sock';
  const server=createServer(),sockets=new WebSocketServer({server}),methods=[];
  t.after(async()=>{for(const client of sockets.clients)client.terminate();await new Promise(r=>sockets.close(r));await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  await new Promise(r=>server.listen(socket,r));await chmod(socket,0o600);
  const info=(id,parent,depth)=>({id,parentThreadId:parent,source:{subAgent:{thread_spawn:{parent_thread_id:parent,depth}}}});
  let lineage={grandchild:info('grandchild','child',2),child:info('child','parent',1)};
  sockets.on('connection',ws=>ws.on('message',bytes=>{const m=JSON.parse(String(bytes));if(m.id===undefined)return;methods.push(m.method);let result={};if(m.method==='thread/read')result={thread:lineage[m.params.threadId]};if(m.method==='thread/turns/list')result={data:[{id:'turn',items:[{id:'inner',type:'commandExecution',status:'completed',exitCode:0}]}],nextCursor:null};ws.send(JSON.stringify({id:m.id,result}));}));
  assert.equal((await readExecutorItems(socket,'grandchild','turn',null,'parent')).data[0].item.id,'inner');
  assert.deepEqual(methods,['initialize','thread/read','thread/read','thread/turns/list']);
  const valid=structuredClone(lineage);
  for(const broken of [
    {...valid,child:info('child','foreign',1)},
    {...valid,child:info('child','grandchild',1)},
    {...valid,child:info('child','parent',2)},
    {...valid,grandchild:info('grandchild','parent',2)},
    {...valid,grandchild:info('grandchild','child',33)},
    {...valid,child:{...info('child','parent',1),parentThreadId:'foreign'}},
  ]){
    lineage=broken;methods.length=0;
    await assert.rejects(readExecutorItems(socket,'grandchild','turn',null,'parent'),/EXECUTOR_LINEAGE_INVALID/);
    assert.ok(!methods.includes('thread/turns/list'),'unverified descendant items must not be read');
  }
});
