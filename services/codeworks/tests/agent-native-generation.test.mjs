// ABOUTME: Проверяет поколения native-сессии после доверенного release cleanup.
// ABOUTME: Core и sandbox — явные doubles; реальные Unix sockets и persisted sessions проходят restart.
import test,{mock} from 'node:test';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createAgentHost,socketCall} from '../src/agent-host.mjs';

async function fixture(t,change=()=>{},executor='codex') {
  // Unix socket path ограничен ядром; длинный managed workspace сюда не помещается.
  const state=await mkdtemp(tmpdir()+'/cwg-'),id=randomUUID(),workspace=randomUUID(),operation=randomUUID(),identity=randomUUID();
  const args={project_id:'brai',workspace_id:workspace,session_id:id,expected_epoch:1,target:'prod',commit_sha:'a'.repeat(40),idempotency_key:'own-release'};
  const old={id,native_key:executor+':'+identity,project_id:'brai',executor_id:executor,kind:'hotfix',workspace_key:id,workspace_id:workspace,revoked:true,context:{element_id:randomUUID()},release_request:{key:'old-release',args}};
  const receipt={operation:{id:operation,project_id:'brai',workspace_id:workspace,executor_id:executor,kind:'request-release',request:{...args},status:'succeeded',result:{state:'succeeded',details:{cleanup:{removed:true}}}}};
  const f={state,id,old,receipt,identity,prepared:[],calls:[],accepted:{operation_id:operation,workspace_id:workspace}};
  f.releases=new Map([[args.idempotency_key,{args,accepted:f.accepted,receipt}]]);
  await change(f);await writeFile(state+'/'+id+'.json',JSON.stringify(old));
  const project={id:'brai',repo_path:state+'/repo',workspace_root:state+'/areas',allowed_paths:['.'],excluded_paths:[]};
  const call=async(method,request,executor)=>{
    f.calls.push({method,request,executor});
    if(method==='project.get')return {project};
    if(method==='request-release'){
      let release=f.releases.get(request.idempotency_key);
      if(!release){
        const p=f.prepared.find(p=>p.workspace_id===request.workspace_id&&p.session_id===request.session_id);
        assert.ok(p,'release must belong to a prepared current writer');
        await f.host.quiesce({workspace:{id:p.workspace_id},executorId:executor,sessionId:p.session_id});
        const id=randomUUID(),args={...request};
        release={args,accepted:{operation_id:id,workspace_id:p.workspace_id},receipt:{operation:{id,project_id:'brai',workspace_id:p.workspace_id,executor_id:executor,kind:'request-release',request:args,status:'pending',result:{state:'pending',details:{}}}}};
        f.releases.set(args.idempotency_key,release);
      }
      assert.deepEqual(request,release.args);return release.accepted;
    }
    if(method==='operation-status'){
      const release=[...f.releases.values()].find(r=>r.accepted.operation_id===request.operation_id);
      if(release)return release.receipt;
      assert.ok(f.prepared.some(p=>p.operation_id===request.operation_id));return {operation:{status:'succeeded'}};
    }
    if(method==='prepare-write'){
      const p={...request,operation_id:randomUUID(),workspace_id:randomUUID()};f.prepared.push(p);
      return {operation_id:p.operation_id,workspace_id:p.workspace_id};
    }
    if(method==='status'){
      const p=f.prepared.find(p=>p.workspace_id===request.workspace_id);
      assert.ok(p,'old removed workspace must not be inspected');
      return {workspace:{id:p.workspace_id,path:project.workspace_root+'/'+p.workspace_id,kind:p.kind,preparation_state:'ready',writer:{state:'active',executor_id:executor,session_id:p.session_id,epoch:1}},git:{head:'b'.repeat(40)}};
    }
    assert.fail('Unexpected method: '+method);
  };
  f.start=async()=>{f.host=await createAgentHost({state_root:state,projects:['brai'],adapter_project_id:'brai',executors:{codex:{},hermes:{}},require_immutable:false,bwrap:'/bin/true'},call);};
  f.lookup=()=>socketCall(state+'/control.sock',{action:'lookup_native',executor_id:executor,native_session_id:identity});
  f.send=async request=>{
    const key=await readFile(state+'/'+executor+'.key'),payload=JSON.stringify({native_session_id:identity,request});
    return socketCall(state+'/'+executor+'.adapter.sock',{payload,signature:createHmac('sha256',key).update(payload).digest('hex')});
  };
  f.scoped=request=>socketCall(state+'/'+id+'.sock',request);
  f.saved=async sessionId=>JSON.parse(await readFile(state+'/'+sessionId+'.json','utf8'));
  t.after(async()=>{await f.host?.close();await rm(state,{recursive:true,force:true});});
  await f.start();return f;
}

for(const executor of ['codex','hermes'])test(executor+' cleanup rotation serializes writes, retains old receipt and survives restart',async t=>{
  const f=await fixture(t,undefined,executor);
  const next=await f.send({action:'status'});assert.equal(next.workspace,null);assert.notEqual(next.session_id,f.id);
  let saved=await f.saved(next.session_id);
  assert.equal(saved.kind,'feature');assert.equal(saved.workspace_key,next.session_id);assert.equal(saved.context,undefined);
  assert.equal((await f.saved(f.id)).successor_id,next.session_id);
  assert.equal((await f.send({action:'command',mode:'read',argv:['/bin/true']})).root,f.state+'/repo');
  assert.equal(f.prepared.length,0);
  const results=await Promise.all(Array.from({length:12},()=>f.send({action:'command',mode:'write',argv:['/bin/true']})));
  assert.equal(f.prepared.length,1);assert.equal(f.prepared[0].kind,'feature');assert.equal(f.prepared[0].session_id,next.session_id);
  assert.equal(new Set(results.map(r=>r.root)).size,1);assert.notEqual(results[0].root,f.state+'/repo');
  assert.deepEqual(await f.send({action:'request-release',request_key:'old-release'}),f.receipt);
  assert.equal((await f.lookup()).revoked,false);
  await assert.rejects(f.scoped({action:'command',mode:'write',argv:['/bin/true']}),/WRITER_FENCED/);
  await f.host.close();await f.start();
  assert.equal((await f.lookup()).session_id,next.session_id);
  assert.deepEqual(await f.send({action:'request-release',request_key:'old-release'}),f.receipt);
  assert.equal((await f.lookup()).revoked,false);assert.equal(f.prepared.length,1);
});

test('concurrent first writes after cleanup create exactly one successor and workspace',async t=>{
  const f=await fixture(t);
  const results=await Promise.all(Array.from({length:12},()=>f.send({action:'command',mode:'write',argv:['/bin/true']})));
  assert.equal(f.prepared.length,1);
  const next=await f.lookup();
  assert.notEqual(next.session_id,f.id);
  assert.equal((await f.saved(f.id)).successor_id,next.session_id);
  assert.equal(f.prepared[0].session_id,next.session_id);
  assert.equal(new Set(results.map(r=>r.root)).size,1);
});

test('restart completes durable successor pointer before its file was created',async t=>{
  const successor=randomUUID();
  const f=await fixture(t,f=>{f.old.successor_id=successor;});
  assert.equal((await f.lookup()).session_id,successor);
  const saved=await f.saved(successor);
  assert.equal(saved.kind,'feature');assert.equal(saved.workspace_key,successor);assert.equal(saved.revoked,false);
  assert.equal(saved.workspace_id,undefined);assert.equal(saved.native_key,undefined);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'project.get');
  await f.host.close();await f.start();
  assert.equal((await f.send({action:'status'})).session_id,successor);
  assert.deepEqual(await f.send({action:'request-release',request_key:'old-release'}),f.receipt);
});


test('three generations retain both predecessor release keys and latest lookup',async t=>{
  const middle=randomUUID(),latest=randomUUID();
  let prior;
  const f=await fixture(t,async f=>{
    f.old.successor_id=middle;
    const args={...f.old.release_request.args,workspace_id:randomUUID(),session_id:middle,idempotency_key:'middle-release',target:'dev'};
    const operation={...f.receipt.operation,id:randomUUID(),workspace_id:args.workspace_id,request:args};
    prior={args,accepted:{operation_id:operation.id,workspace_id:args.workspace_id},receipt:{operation}};
    f.releases.set(args.idempotency_key,prior);
    await writeFile(f.state+'/'+middle+'.json',JSON.stringify({id:middle,project_id:'brai',executor_id:'codex',workspace_id:args.workspace_id,revoked:true,successor_id:latest,release_request:{key:'middle-release',args}}));
    await writeFile(f.state+'/'+latest+'.json',JSON.stringify({id:latest,project_id:'brai',executor_id:'codex',kind:'feature',workspace_key:latest,revoked:false}));
  });
  assert.equal((await f.lookup()).session_id,latest);
  assert.equal((await f.send({action:'status'})).session_id,latest);
  assert.deepEqual(await f.send({action:'request-release',request_key:'old-release'}),f.receipt);
  assert.deepEqual(await f.send({action:'request-release',request_key:'middle-release'}),prior.receipt);
  await f.host.close();await f.start();
  assert.equal((await f.lookup()).session_id,latest);
  assert.equal((await f.lookup()).revoked,false);
  assert.deepEqual(await f.send({action:'request-release',request_key:'old-release'}),f.receipt);
});

const refusals={
  quiesce:f=>{delete f.old.release_request;},
  transfer:f=>{delete f.old.release_request;f.old.transferred=true;},
  'wrong accepted workspace':f=>{f.accepted.workspace_id=randomUUID();},
  'wrong operation id':f=>{f.receipt.operation.id=randomUUID();},
  'wrong workspace':f=>{f.receipt.operation.workspace_id=randomUUID();},
  'wrong project':f=>{f.receipt.operation.project_id='foreign';},
  'wrong executor':f=>{f.receipt.operation.executor_id='hermes';},
  'wrong operation kind':f=>{f.receipt.operation.kind='commit';},
  'wrong target':f=>{f.receipt.operation.request.target='dev';},
  'wrong session':f=>{f.receipt.operation.request.session_id=randomUUID();},
  'wrong commit':f=>{f.receipt.operation.request.commit_sha='b'.repeat(40);},
  'wrong epoch':f=>{f.receipt.operation.request.expected_epoch=2;},
  'wrong idempotency key':f=>{f.receipt.operation.request.idempotency_key='foreign';},
  'saved project mismatch':f=>{f.old.release_request.args={...f.old.release_request.args,project_id:'foreign'};},
  'saved workspace mismatch':f=>{f.old.release_request.args={...f.old.release_request.args,workspace_id:randomUUID()};},
  'saved session mismatch':f=>{f.old.release_request.args={...f.old.release_request.args,session_id:randomUUID()};},
  'cleanup truthy string':f=>{f.receipt.operation.result.details.cleanup.removed='true';},
  'wrong result state':f=>{f.receipt.operation.result.state='failed';},
  'cleanup false':f=>{f.receipt.operation.result.details.cleanup.removed=false;},
  'cleanup missing':f=>{delete f.receipt.operation.result.details.cleanup;},
  ...Object.fromEntries(['pending','running','awaiting_ci','awaiting_deployment','awaiting_reconciliation','failed'].map(status=>[status,f=>{f.receipt.operation.status=status;}]))
};
for(const [reason,change]of Object.entries(refusals))test('native session remains fenced: '+reason,async t=>{
  const f=await fixture(t,change);
  await assert.rejects(f.send({action:'command',mode:'write',argv:['/bin/true']}),/WRITER_FENCED/);
  assert.equal(f.prepared.length,0);assert.equal((await f.lookup()).session_id,f.id);
  assert.equal((await f.saved(f.id)).successor_id,undefined);
});
test('Hermes quiesce without release remains fenced',async t=>{
  const f=await fixture(t,refusals.quiesce,'hermes');
  await assert.rejects(f.send({action:'command',mode:'write',argv:['/bin/true']}),/WRITER_FENCED/);
  assert.equal((await f.lookup()).session_id,f.id);assert.equal(f.prepared.length,0);
});

test('three automatic transitions preserve every own release receipt and active latest writer',async t=>{
  const f=await fixture(t),receipts=[['old-release',f.receipt]],ids=[f.id];
  for(let generation=1;generation<=3;generation++){
    await f.send({action:'command',mode:'write',argv:['/bin/true']});
    const current=await f.lookup();ids.push(current.session_id);
    assert.equal(new Set(ids).size,ids.length);
    if(generation===3)break;
    const key='generation-'+generation;
    const accepted=await f.send({action:'request-release',request_key:key});
    const release=[...f.releases.values()].find(r=>r.accepted.operation_id===accepted.operation_id);
    assert.equal((await f.send({action:'request-release',request_key:key})).operation.status,'pending');
    assert.equal((await f.lookup()).revoked,true);
    release.receipt.operation.status='succeeded';
    release.receipt.operation.result={state:'succeeded',details:{cleanup:{removed:true}}};
    receipts.push([key,release.receipt]);
  }
  assert.equal(f.prepared.length,3);
  const latest=await f.lookup();assert.equal(latest.revoked,false);
  for(const [key,receipt]of receipts)assert.deepEqual(await f.send({action:'request-release',request_key:key}),receipt);
  assert.deepEqual(await f.lookup(),latest);
  await f.host.close();await f.start();
  assert.deepEqual(await f.lookup(),latest);
  for(const [key,receipt]of receipts)assert.deepEqual(await f.send({action:'request-release',request_key:key}),receipt);
});

test('close waits for the lock child close event after stdin EOF',async t=>{
  // Управляем только событием выхода lock child: EOF сам по себе ещё не освобождает lock.
  const lock=new EventEmitter();lock.stdout=new PassThrough();lock.stdin=new PassThrough();
  let eof;const ended=new Promise(resolve=>{eof=resolve;});lock.stdin.once('finish',eof);
  const spawn=childProcess.spawn;
  const replacement=mock.method(childProcess,'spawn',(file,...args)=>{
    if(file!=='/usr/bin/flock')return spawn(file,...args);
    queueMicrotask(()=>lock.stdout.write('locked'));return lock;
  });
  syncBuiltinESMExports();
  let closing;
  try{
    const f=await fixture(t);let closed=false;
    closing=f.host.close().then(()=>{closed=true;});
    await ended;await Promise.resolve();
    assert.equal(closed,false,'close must remain pending until the lock process has closed');
    lock.emit('close',0);await closing;
    assert.equal(closed,true);
  }finally{
    lock.emit('close',0);await closing;
    replacement.mock.restore();syncBuiltinESMExports();
  }
});
