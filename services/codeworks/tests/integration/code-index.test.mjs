// ABOUTME: Проверяет перенос и обновления настоящего SocratiCode на отдельном Qdrant и тестовом embedding HTTP.
// ABOUTME: Использует только disposable Git/PG/Temporal fixtures; рабочую установку движка не меняет.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,cp,copyFile,symlink,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {command} from '../../src/git.mjs';
import {indexIdentity} from '../../src/code-index.mjs';
import {setup,configured} from './fixture.mjs';
import {createActivities,deliverCommands} from '../../src/temporal.mjs';
import {Connection,Client as TemporalClient} from '@temporalio/client';
import {Worker,bundleWorkflowCode} from '@temporalio/worker';
import {Context} from '@temporalio/activity';

const enabled=!!process.env.CODEWORKS_INDEX_QDRANT;
const digest=value=>createHash('sha256').update(value).digest('hex');
const uuid=value=>{const h=digest(value);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(work){const end=Date.now()+60000;for(;;){if(await work())return;assert.ok(Date.now()<end,'fixture condition timeout');await sleep(100);}}

test('native index and both graphs copy, refresh, caches and cleanup',{skip:!enabled,timeout:180000},async t=>{
  const tmp=fileURLToPath(new URL('../../../../tmp/',import.meta.url));await mkdir(tmp,{recursive:true});
  const root=await mkdtemp(path.join(tmp,'codeworks-index-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
  // Test-copy only: Node resolves existing dependencies through one symlink, without npm install.
  const packageRoot=root+'/engine';await mkdir(packageRoot);
  await cp('/opt/socraticode/node_modules/socraticode/dist',packageRoot+'/dist',{recursive:true});
  await copyFile('/opt/socraticode/node_modules/socraticode/package.json',packageRoot+'/package.json');
  await symlink('/opt/socraticode/node_modules',packageRoot+'/node_modules');
  const engine=packageRoot+'/dist/index.js',require=createRequire(engine);
  const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  const {QdrantClient}=require('@qdrant/js-client-rest');
  const q=new QdrantClient({url:process.env.CODEWORKS_INDEX_QDRANT,checkCompatibility:false});
  let embeddings=0;
  const http=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const input=raw?JSON.parse(raw):{};
    let body={version:'0.20.0',models:[{name:'bge-m3:latest',model:'bge-m3:latest'}],capabilities:['embedding'],model_info:{'bert.embedding_length':1024,'bert.context_length':8192}};
    if(req.url==='/api/embed'||req.url==='/api/embeddings'){
      const texts=Array.isArray(input.input)?input.input:[input.input??input.prompt??''];embeddings+=texts.length;
      const vectors=texts.map(text=>{const h=createHash('sha256').update(text).digest();return Array.from({length:1024},(_,i)=>(h[i%h.length]+1)/256);});body={embeddings:vectors,embedding:vectors[0]};
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify(body));
  });await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>http.close(resolve)));
  const ollama='http://127.0.0.1:'+http.address().port;
  const env={QDRANT_MODE:'external',QDRANT_URL:process.env.CODEWORKS_INDEX_QDRANT,OLLAMA_MODE:'external',OLLAMA_URL:ollama,OLLAMA_HOST:ollama,EMBEDDING_PROVIDER:'ollama',EMBEDDING_MODEL:'bge-m3',EMBEDDING_DIMENSIONS:'1024',SOCRATICODE_AUTO_RESUME:'off',SOCRATICODE_WATCHER:'manual',LOG_LEVEL:'error'};
  const repo=root+'/source',areas=root+'/areas';await mkdir(repo);await mkdir(areas);
  const git=(...args)=>command('git',['-C',repo,...args]);
  await writeFile(repo+'/.gitignore','node_modules/\n');
  await writeFile(repo+'/leaf.js','export function leaf() { return 1; }\n');
  await writeFile(repo+'/main.js',"import {leaf} from './leaf.js';\nexport function main() { return leaf(); }\n");
  await git('init','-b','dev');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');await git('add','.');await git('commit','-m','base');
  const base=(await git('rev-parse','HEAD')).stdout,w={id:randomUUID(),ownership_token:randomUUID(),path:areas+'/task',kind:'feature',base_sha:base};
  await git('worktree','add','-b','feature/task',w.path,base);
  const clients=[];
  async function client(projectPath){
    const c=new Client({name:'codeworks-index-fixture',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[engine],cwd:projectPath,env:{...process.env,...env},stderr:'ignore'}));clients.push(c);
    return {call:async(name,args={})=>{const r=await c.callTool({name,arguments:{projectPath,...args}},undefined,{timeout:60000});assert.ok(!r.isError,JSON.stringify(r));return r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');},close:()=>c.close()};
  }
  t.after(async()=>{for(const c of clients)await c.close().catch(()=>{});});
  const source=await client(repo);await source.call('codebase_index');
  await until(async()=>/Last operation:.*COMPLETED|Last operation:.*completed/i.test(await source.call('codebase_status')));
  const sourceId=indexIdentity(repo),id=indexIdentity(w.path),collection=identity=>'codebase_'+identity;
  const symbolPoints=(await q.scroll(sourceId+'_symgraph_index',{limit:100,with_payload:true,with_vector:true})).points;
  // Маленький fixture принудительно представляет штатный multipart формат, включая continuation IDs.
  for(const kind of ['name','reverse']){
    const original=symbolPoints.find(p=>p.payload.kind===kind),p=original.payload;
    const seed=kind==='name'?`${sourceId}::nameidx::${p.shard}::gen::${p.generation}`:`${sourceId}::revidx::${Number(p.bucket).toString(16).padStart(2,'0')}::gen::${p.generation}`;
    const write=randomUUID(),empty=kind==='name'?{nameToSymbols:{}}:{reverseEdges:{}};
    await q.upsert(sourceId+'_symgraph_index',{wait:true,points:[{...original,payload:{...p,part:0,parts:2,write}},{...original,id:uuid(seed+'::part1'),payload:{...p,...empty,part:1,parts:2,write}}]});
  }
  const sourceBefore=await q.retrieve('socraticode_metadata',{ids:[uuid(collection(sourceId)),uuid('codegraph_'+sourceId)],with_payload:true});
  const configFile=root+'/socraticode.json';await writeFile(configFile,JSON.stringify({env}));
  const config={engine,socraticodeConfig:configFile,sources:{fixture:{feature:repo,hotfix:repo}}},project={id:'fixture',workspace_root:areas};
  const index={identity:id,source_path:repo,source_sha:base};
  const invoke=async(action,{failure=false}={})=>{
    const started=Date.now();
    const r=await command(process.execPath,[fileURLToPath(new URL('../../src/code-index-engine.mjs',import.meta.url))],{input:JSON.stringify({action,config,project,workspace:w,index}),timeout:60000,allowFailure:true});
    if(failure){assert.notEqual(r.code,0);return;}
    assert.equal(r.code,0,r.stderr);const result=JSON.parse(r.stdout);console.log(JSON.stringify({action,elapsed_ms:Date.now()-started,result,embeddings}));return result;
  };
  await writeFile(repo+'/leaf.js','temporary dirty source');assert.equal((await invoke('clone')).reason,'SOURCE_HAS_CHANGES');await git('checkout','--','leaf.js');
  await git('commit','--allow-empty','-m','advanced');assert.equal((await invoke('clone')).reason,'SOURCE_REVISION_CHANGED');await git('update-ref','refs/heads/dev',base);
  // Прерываем реальную запись файлов символов: повтор обязан восстановить только собственные частичные коллекции.
  let failWrites=true;
  const proxy=createServer(async(req,res)=>{
    if(failWrites&&req.method==='PUT'&&req.url.startsWith('/collections/'+id+'_symgraph_file/points')){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({status:{error:'fixture interruption'}}));return;}
    let body='';for await(const chunk of req)body+=chunk;
    const r=await fetch(process.env.CODEWORKS_INDEX_QDRANT+req.url,{method:req.method,...(body?{body}:{}),headers:{'content-type':'application/json'}});
    res.writeHead(r.status,{'content-type':'application/json'});res.end(await r.text());
  });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>proxy.close(resolve)));
  await writeFile(configFile,JSON.stringify({env:{...env,QDRANT_URL:'http://127.0.0.1:'+proxy.address().port}}));
  await invoke('clone',{failure:true});failWrites=false;
  const countBefore=embeddings;assert.equal((await invoke('clone')).state,'ready');assert.equal(embeddings,countBefore);
  const scroll=async name=>(await q.scroll(name,{limit:100,with_payload:true,with_vector:true})).points;
  const a=await scroll(collection(sourceId)),b=await scroll(collection(id));assert.equal(a.length,b.length);
  for(const p of a){const target=b.find(x=>x.id===p.id);assert.deepEqual(target.vector,p.vector);assert.equal(target.payload.content,p.payload.content);assert.ok(target.payload.filePath.startsWith(w.path+'/'));}
  const oldReader=await client(w.path);
  assert.match(await oldReader.call('codebase_graph_query',{filePath:'main.js'}),/leaf.js/);
  assert.match(await oldReader.call('codebase_symbols',{filePath:'leaf.js'}),/leaf/);
  const meta=async()=>(await q.retrieve(id+'_symgraph_meta',{ids:[uuid(id+'::meta')],with_payload:true}))[0].payload.meta;
  const initial=await meta();assert.equal((await invoke('update')).state,'ready');assert.equal(embeddings,countBefore);assert.equal((await meta()).generation,initial.generation);
  const sourceSearch=await source.call('codebase_search',{query:'leaf function',limit:1}),targetSearch=await oldReader.call('codebase_search',{query:'leaf function',limit:1});
  assert.equal(targetSearch.match(/(?:main|leaf)\.js/)?.[0],sourceSearch.match(/(?:main|leaf)\.js/)?.[0]);
  assert.match(targetSearch,/main.js|leaf.js/);
  // Two long-lived clients reproduce the external writer cache defect before applying compatibility to this copy.
  await writeFile(w.path+'/other.js','export function other() { return 2; }\n');
  await writeFile(w.path+'/main.js',"import {other} from './other.js';\nexport function main() { return other(); }\n");
  assert.equal((await invoke('update')).state,'ready');assert.ok(embeddings>countBefore);
  assert.doesNotMatch(await oldReader.call('codebase_graph_query',{filePath:'main.js'}),/other.js/,'unpatched reader demonstrates stale cache');
  const {prepareGraphFreshness}=await import(pathToFileURL(process.env.CODEWORKS_INDEX_COMPAT_SCRIPT).href);await prepareGraphFreshness(packageRoot);
  await prepareGraphFreshness(packageRoot,{verify:true});
  const freshReader=await client(w.path);assert.match(await freshReader.call('codebase_graph_query',{filePath:'main.js'}),/other.js/);
  assert.match(await freshReader.call('codebase_symbols',{filePath:'other.js'}),/other/);
  await writeFile(w.path+'/third.js','export function third() { return 3; }\n');
  await writeFile(w.path+'/main.js',"import {third} from './third.js';\nexport function main() { return third(); }\n");
  await writeFile(w.path+'/other.js','export function renamedOther() { return 4; }\n');
  assert.equal((await invoke('update')).state,'ready');
  assert.match(await freshReader.call('codebase_graph_query',{filePath:'main.js'}),/third.js/);
  assert.match(await freshReader.call('codebase_symbols',{filePath:'other.js'}),/renamedOther/);
  await rm(w.path+'/other.js');await writeFile(w.path+'/renamed.js',await readFile(w.path+'/third.js'));await rm(w.path+'/third.js');
  await writeFile(w.path+'/main.js',"import {third} from './renamed.js';\nexport function main() { return third(); }\n");
  assert.equal((await invoke('update')).state,'ready');assert.match(await freshReader.call('codebase_graph_query',{filePath:'main.js'}),/renamed.js/);
  assert.ok(!(await scroll(collection(id))).some(p=>['third.js','other.js'].includes(p.payload.relativePath)));
  assert.deepEqual(await q.retrieve('socraticode_metadata',{ids:sourceBefore.map(p=>p.id),with_payload:true}),sourceBefore,'source remains byte-equivalent');
  const inspected=await invoke('inspect');assert.equal(inspected.complete,true);assert.equal(inspected.identity,id);
  assert.equal(inspected.owner.present,true);assert.equal(inspected.owner.tokenMatches,true);assert.equal(inspected.owner.pathMatches,true);
  assert.equal(inspected.resources.collections.length,4);assert.ok(inspected.resources.metadataPoints.includes(collection(id)+'::codeworks-owner'));
  const token=w.ownership_token;w.ownership_token='foreign';await invoke('remove',{failure:true});w.ownership_token=token;
  await rm(w.path,{recursive:true});assert.equal((await invoke('remove')).state,'removed');assert.equal((await invoke('remove')).state,'removed');
  const empty=await invoke('inspect');assert.equal(empty.owner.present,false);assert.deepEqual(empty.resources,{collections:[],metadataPoints:[]});
  await freshReader.call('codebase_graph_query',{filePath:'main.js'});await freshReader.call('codebase_symbols',{filePath:'other.js'});
  assert.ok(!(await q.getCollections()).collections.some(c=>c.name.includes(id)));
  assert.ok((await q.getCollections()).collections.some(c=>c.name===collection(sourceId)));
});

test('real Temporal background index does not block commands or cancellation',{skip:!enabled||!configured,timeout:90000},async t=>{
  const f=await setup(),p=await f.project();t.after(()=>f.close());
  await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'index-fixture','temporal')",[p.id]);
  const connection=await Connection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS,connectTimeout:'5 seconds'}),client=new TemporalClient({connection,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE});
  const taskQueue='codeworks-index-'+randomUUID(),ids=[];let release,entered=false;
  const stalled=new Promise(resolve=>{release=resolve;});t.after(async()=>{release();for(const id of ids)await client.workflow.getHandle(id).terminate('fixture cleanup').catch(()=>{});await connection.close();});
  const activities=createActivities(f.app,{allowedRepositories:[p.repo_path],codeIndex:{maintain:async()=>{entered=true;await Promise.race([stalled,Context.current().cancelled]);},remove:async()=>{}}});
  const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../../src/workflows.cjs',import.meta.url))});
  const native=await (await import('@temporalio/worker')).NativeConnection.connect({address:process.env.CODEWORKS_TEMPORAL_ADDRESS});t.after(()=>native.close());
  const worker=await Worker.create({connection:native,namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE,taskQueue,workflowBundle:bundle,activities,maxConcurrentActivityTaskExecutions:4});
  await worker.runUntil(async()=>{
    const first=await f.h.call('prepare',{project_id:p.id,workspace_key:'index-one',request_key:'index-one'},'codex');
    const register=async operation=>{const r=(await f.app.query('SELECT workflow_id FROM codeworks.commands WHERE operation_id=$1',[operation.operation_id])).rows[0];ids.push(r.workflow_id);};await register(first);
    await deliverCommands(f.app,client,{taskQueue});await until(async()=>(await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[first.operation_id])).rows[0].status==='succeeded');await until(()=>entered);
    const second=await f.h.call('prepare',{project_id:p.id,workspace_key:'index-two',request_key:'index-two'},'codex');await register(second);
    await deliverCommands(f.app,client,{taskQueue});await until(async()=>(await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[second.operation_id])).rows[0].status==='succeeded');
    await Worker.runReplayHistory({workflowBundle:bundle},await client.workflow.getHandle(ids[0]).fetchHistory(),ids[0]);
    const cancelFirst=await f.h.call('workspace.cancel',{project_id:p.id,workspace_id:first.workspace_id,request_key:'cancel-first',reason:'cancel running index'},'codex');
    await deliverCommands(f.app,client,{taskQueue});await until(async()=>(await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[cancelFirst.operation_id])).rows[0].status==='succeeded');
    const cancelled=await f.h.call('workspace.cancel',{project_id:p.id,workspace_id:second.workspace_id,request_key:'cancel-two',reason:'fixture'},'codex');
    release();await deliverCommands(f.app,client,{taskQueue});await until(async()=>(await f.app.query('SELECT status FROM codeworks.operations WHERE id=$1',[cancelled.operation_id])).rows[0].status==='succeeded');
    const state=await f.h.call('status',{project_id:p.id,workspace_id:second.workspace_id},'codex');assert.equal(state.workspace.removed_at,null);
  });
});
