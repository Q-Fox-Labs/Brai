// ABOUTME: Проверяет отложенный media-переход Gemma и физическое завершение native children.
// ABOUTME: Процессы настоящие, HTTP заменён peer; веса, сеть и внешние зависимости не нужны.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createProfileRuntimeFactory } from '../dist/lifecycle/runtime-factory.js';
const context = signal => ({ ownerId: 'test', operationId: 'test', deadlineAt: new Date(Date.now()+10000).toISOString(), signal: signal ?? new AbortController().signal });
function alive(pid) { try { process.kill(pid,0); return true; } catch { return false; } }
async function fixture(cancelMedia=false) {
  const root=await mkdtemp('/tmp/local-ai-gemma-lifecycle-');
  const log=root+'/children.ndjson';
  const child=root+'/child.mjs';
  await writeFile(child, `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');setInterval(()=>{},1000);`);
  await writeFile(root+'/image','synthetic');
  const launches=async()=>{try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{return [];}};
  const controller=new AbortController();
  const profile={deferredMedia:true,executable:process.execPath,cwd:root,args:[child,'--model','{{modelPath}}','--mmproj','{{mmprojPath}}'],startupTimeoutMs:2000,requestTimeoutMs:1000,stopGraceMs:1000,maxLineBytes:100000,host:'127.0.0.1',port:()=>12345,dimensions:768,contextTokens:2048,maxBatchTokens:2048,queryInstruction:'task: search result | query: ',documentInstruction:'title: none | text: ',symmetricInstruction:'task: sentence similarity | query: '};
  const model={model:{modelId:'gemma',revision:'rev',profileId:'embeddinggemma2_llama_cpp'},installation:{modelId:'gemma',revision:'rev',profileId:'embeddinggemma2_llama_cpp',directory:root,files:[{path:'main.gguf'},{path:'mmproj-embeddinggemma-2-Q8_0.gguf'}]}};
  const factory=createProfileRuntimeFactory({profiles:{llama_cpp:profile,embeddinggemma2_llama_cpp:profile},fetch:async(url,init)=>{
    if(url.pathname==='/health') {
      const latest=(await launches()).at(-1);
      if(!latest||!alive(latest.pid)) return new Response('',{status:503});
      if(cancelMedia&&latest.args.includes('--mmproj')) {controller.abort();return new Response('',{status:503});}
      return new Response('',{status:200});
    }
    if(url.pathname==='/tokenize')return Response.json({tokens:[1]});
    const body=JSON.parse(init.body);
    return Response.json({data:body.input.map((_,index)=>({index,embedding:Array.from({length:768},(_,i)=>Number(i===0))}))});
  }});
  const runtime=await factory.open(model,context());
  return {root,runtime,model,launches,controller};
}
test('Gemma loads no projector for text, switches once for media and retains full runner for text',async()=>{
  const f=await fixture();
  let exited=false;f.runtime.exited.then(()=>{exited=true;});
  try {
    const first=(await f.launches())[0];assert.ok(first.args.includes('--no-mmproj'));assert.ok(!first.args.includes('--mmproj'));
    await f.runtime.embed({model:f.model.model,texts:['memory fact'],purpose:'document'},context());
    assert.equal((await f.launches()).length,1);
    const vector=await f.runtime.embed({model:f.model.model,purpose:'document',inputs:[{type:'image_artifact',localPath:f.root+'/image',mimeType:'image/png'}]},context());
    assert.equal(vector.vectors[0].length,768);
    const children=await f.launches();assert.equal(children.length,2);assert.ok(!alive(children[0].pid));assert.ok(alive(children[1].pid));assert.ok(children[1].args.includes('--mmproj'));assert.ok(!children[1].args.includes('--no-mmproj'));assert.equal(exited,false);
    await f.runtime.embed({model:f.model.model,texts:['another fact'],purpose:'query'},context());
    await f.runtime.embed({model:f.model.model,purpose:'document',inputs:[{type:'image_artifact',localPath:f.root+'/image',mimeType:'image/png'}]},context());
    assert.equal((await f.launches()).length,2);
    await f.runtime.close();await f.runtime.close();await f.runtime.exited;
    assert.ok((await f.launches()).every(x=>!alive(x.pid)));
  } finally {await f.runtime.close();await f.runtime.exited;await rm(f.root,{recursive:true});}
});
test('cancellation during Gemma media activation confirms exit of both successive children',async()=>{
  const f=await fixture(true);
  try {
    await assert.rejects(f.runtime.embed({model:f.model.model,purpose:'document',inputs:[{type:'image_artifact',localPath:f.root+'/image',mimeType:'image/png'}]},context(f.controller.signal)),error=>error.code==='CANCELLED');
    await f.runtime.exited;
    const children=await f.launches();assert.equal(children.length,2);assert.ok(children.every(x=>!alive(x.pid)));
    await assert.rejects(f.runtime.embed({model:f.model.model,texts:['after cancellation'],purpose:'query'},context()),error=>error.code==='ENGINE_UNAVAILABLE');
  } finally {await f.runtime.close();await f.runtime.exited;await rm(f.root,{recursive:true});}
});
