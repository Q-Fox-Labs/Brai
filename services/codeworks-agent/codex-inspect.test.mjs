// ABOUTME: Проверяет независимость readonly inspect от host и bounds private port.
// ABOUTME: Child process заменён транспортным портом; реальные namespace mounts проверяет isolated acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createReadonlyInspector,validateInspect} from './codex-inspect.mjs';
const identity='11111111-1111-4111-8111-111111111111';
test('Inspect rejects foreign fields, cwd, missing identity, argv overflow and NUL',()=>{
  for(const request of [
    {action:'inspect',native_session_id:identity,argv:['cat'],cwd:'/'},
    {action:'inspect',native_session_id:'other',argv:['cat']},
    {action:'inspect',native_session_id:identity,argv:[]},
    {action:'inspect',native_session_id:identity,argv:Array(129).fill('a')},
    {action:'inspect',native_session_id:identity,argv:['bad\0arg']},
  ])assert.throws(()=>validateInspect(request));
});
async function fixture(output='ok') {
  const root=await mkdtemp(path.join(tmpdir(),'cw-inspect-'));
  await writeFile(path.join(root,'.env'),'private');
  const descriptor={project:{repo_path:root,workspace_root:root+'/workspaces',excluded_paths:['.git','node_modules','.env']},state_root:'/state',hidden_paths:['/home/agent','/etc/brai-dev']};
  let invocation;
  const inspect=createReadonlyInspector({descriptor,controlSocket:'/fixed/control',call:async()=>{throw new Error('CORE_DOWN');},
    execute(executable,args,options) {
      invocation={executable,args,options};
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      let closed=false;const close=code=>{if(!closed){closed=true;child.emit('close',code);}};
      child.kill=()=>{setImmediate(()=>close(null));return true;};
      setImmediate(()=>{child.stdout.write(output);close(0);});return child;
    }});
  return {root,inspect,invocation:()=>invocation,close:()=>rm(root,{recursive:true,force:true})};
}
test('Core outage still runs diagnostics against labelled readonly source with secret mask and no network',async()=>{
  const f=await fixture();
  try {
    const result=await f.inspect({action:'inspect',native_session_id:identity,argv:['unknown-command','argument']});
    assert.equal(result.stdout,'ok');assert.equal(result.root,f.root);assert.equal(result.source_fallback,true);
    const run=f.invocation();assert.equal(run.executable,'/usr/bin/bwrap');
    assert.ok(run.args.includes('--unshare-net'));assert.ok(run.args.includes('--ro-bind'));
    assert.equal(run.args.includes('--bind'),false);
    assert.ok(run.args.includes('/dev/null'));assert.ok(run.args.includes(path.join(f.root,'.env')));
    assert.deepEqual(run.options.stdio,['ignore','pipe','pipe']);
    assert.deepEqual(run.args.slice(-2),['unknown-command','argument']);
  }finally{await f.close();}
});
test('Even escaped output fits the one MiB response budget',async()=>{
  const f=await fixture('\0'.repeat(300000));
  try {
    const result=await f.inspect({action:'inspect',native_session_id:identity,argv:['unknown']});
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=1024*1024);
    assert.ok(result.stdout.length<300000);
  }finally{await f.close();}
});
