// ABOUTME: Проверяет реальные payload и ошибки мультимодального llama adapter.
// ABOUTME: Дочерний процесс настоящий; HTTP заменён ограниченным deterministic peer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createProfileRuntimeFactory } from '../dist/lifecycle/runtime-factory.js';
const context = () => ({ ownerId: 'test', operationId: 'test', deadlineAt: new Date(Date.now()+10000).toISOString(), signal: new AbortController().signal });
test('Gemma task prefixes, mmproj and media payload preserve ordering; overflow stays INPUT_TOO_LARGE', async () => {
  const root = await mkdtemp('/tmp/local-ai-multimodal-');
  const media = root + '/media';
  await writeFile(media, 'synthetic');
  const requests = [];
  let oversized = false;
  const profile = { executable: process.execPath, cwd: root, args: ['-e', 'setInterval(()=>{},1000)', '{{mmprojPath}}'],
    startupTimeoutMs: 1000, requestTimeoutMs: 1000, stopGraceMs: 1000, maxLineBytes: 100000,
    host: '127.0.0.1', port: () => 12345, dimensions: 768, contextTokens: 2048, maxBatchTokens: 2048,
    queryInstruction: 'task: search result | query: ', documentInstruction: 'title: none | text: ', symmetricInstruction: 'task: sentence similarity | query: ' };
  const factory = createProfileRuntimeFactory({ profiles: { llama_cpp: profile, embeddinggemma2_llama_cpp: profile }, fetch: async (url, init) => {
    if (url.pathname === '/health') return new Response('', {status:200});
    const body = JSON.parse(init.body);
    if (url.pathname === '/tokenize') return Response.json({tokens:[1]});
    requests.push(body);
    if (oversized) return new Response('too large to process', {status:500});
    return Response.json({data:body.input.map((_,index)=>({index,embedding:Array.from({length:768},(_,i)=>i===0?1:0)}))});
  } });
  const model = {model:{modelId:'gemma',revision:'rev',profileId:'embeddinggemma2_llama_cpp'},installation:{
    modelId:'gemma',revision:'rev',profileId:'embeddinggemma2_llama_cpp',directory:root,
    files:[{path:'main.gguf'},{path:'mmproj-embeddinggemma-2-Q8_0.gguf'}],
  }};
  const runtime = await factory.open(model, context());
  try {
    for (const [purpose,prefix] of [['query','task: search result | query: '],['document','title: none | text: '],['symmetric','task: sentence similarity | query: ']]) {
      await runtime.embed({model:model.model,texts:['needle'],purpose},context());
      assert.deepEqual(requests.at(-1).input,[prefix+'needle']);
    }
    await runtime.embed({model:model.model,purpose:'document',inputs:[
      {type:'image_artifact',localPath:media,mimeType:'image/png'},
      {type:'audio_artifact',localPath:media,mimeType:'audio/wav'},
      {type:'video_artifact',localPath:media,mimeType:'video/mp4'},
    ]},context());
    const parts = requests.at(-1).input.map(item=>item.content[0]);
    assert.equal(parts[0].type,'image_url'); assert.match(parts[0].image_url.url,/^data:image\/png;base64,/);
    assert.equal(parts[1].type,'input_audio'); assert.equal(parts[2].type,'input_video');
    oversized=true;
    await assert.rejects(runtime.embed({model:model.model,purpose:'document',inputs:[{type:'video_artifact',localPath:media,mimeType:'video/mp4'}]},context()),error=>error.code==='INPUT_TOO_LARGE');
  } finally { await runtime.close(); await runtime.exited; await rm(root,{recursive:true}); }
});
