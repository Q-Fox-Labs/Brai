// ABOUTME: Проверяет HTTP-отказы catalog, общую квоту и независимость CI proofs на тестовой PostgreSQL.
// ABOUTME: Настоящие GitHub/OCI адаптеры подключены только к локальному HTTP-стенду; внешние запросы запрещены.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {configured,setup} from './fixture.mjs';
import {createCIEvidence} from '../../src/ci-evidence.mjs';
import {reconcileCatalogPublication} from '../../src/catalog-publication.mjs';
import {createGitHub} from '../../src/github.mjs';
import {createRegistry} from '../../ci/registry.mjs';
import {createActivities} from '../../src/temporal.mjs';
import {runOperation} from '../../src/worker.mjs';
import {createGit} from '../../src/git.mjs';
import {createFlowGit} from '../../src/git-flow.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Минимальный HTTP Actions/OCI стенд хранит точные байты manifests и blobs; заголовки авторизации не сохраняет. */
async function startHTTPFixture({repository,sha,recipe}) {
  const manifests=new Map(),blobs=new Map(),failures=[];
  const state={catalogFailure:null,failedCheck:false,counts:{all:0,api:0,catalogAuth:0,catalogWrites:0,proofDownloads:0,recipeReads:0,pr:0}};
  const check={id:17,name:'Codeworks components',app:{id:42},head_sha:sha,status:'completed',conclusion:'success',details_url:'https://github.com/'+repository+'/actions/runs/123/job/9'};
  const run={id:123,head_sha:sha,path:'.github/workflows/codeworks.yml',event:'push',status:'completed',conclusion:'success',run_attempt:1,repository:{full_name:repository}};
  const job={id:9,name:check.name,head_sha:sha,status:'completed',conclusion:'success',labels:['ubuntu-24.04'],check_run_url:'https://api.github.com/repos/'+repository+'/check-runs/17'};
  const json=(response,status,value,headers={})=>{response.writeHead(status,{'content-type':'application/json',...headers});response.end(JSON.stringify(value));};
  const handler=async(request,response)=>{
    const url=new URL(request.url,'http://fixture.invalid');state.counts.all++;
    if(url.pathname.startsWith('/repos/'+repository+'/')){
      state.counts.api++;
      const endpoint=url.pathname.slice(('/repos/'+repository+'/').length);
      if(endpoint.startsWith('pulls')){
        state.counts.pr++;
        if(state.prFailure)return json(response,state.prFailure,{message:'fixture private transport detail'},{...(state.prFailure===429?{'retry-after':'120'}:{})});
        const pr={number:71,state:'open',merged:false,head:{ref:state.prBranch,sha,repo:{full_name:repository}},base:{ref:'dev',repo:{full_name:repository}},html_url:'https://github.com/'+repository+'/pull/71'};
        return json(response,200,endpoint==='pulls'?[pr]:pr);
      }
      if(endpoint.startsWith('contents/'))state.counts.recipeReads++;
      if(endpoint.includes('/artifacts'))state.counts.proofDownloads++;
      if(endpoint.startsWith('commits/'))return json(response,200,{total_count:1,check_runs:[{...check,...(state.failedCheck?{conclusion:'failure'}:{})}]});
      if(endpoint==='check-runs/17/annotations')return json(response,200,[]);
      if(endpoint==='actions/runs/123'||endpoint==='actions/runs/123/attempts/1')return json(response,200,run);
      if(endpoint==='actions/runs/123/attempts/1/jobs')return json(response,200,{total_count:1,jobs:[job]});
      throw Error('UNEXPECTED_FIXTURE_ACTIONS_ROUTE');
    }
    if(url.pathname==='/token'){
      const catalog=url.searchParams.get('scope')?.startsWith('repository:'+repository+'-components/catalog-v1:');
      if(catalog){
        state.counts.catalogAuth++;
        if(state.catalogFailure===429)return json(response,429,{message:'fixture quota exhausted'},{'retry-after':'120'});
        if(state.catalogFailure===503)return json(response,503,{message:'fixture catalog unavailable'});
      }
      return json(response,200,{token:'fixture-registry-token'});
    }
    const upload=url.pathname.match(/^\/v2\/(.+)\/blobs\/uploads\/([^/]*)$/);
    if(upload&&request.method==='POST'){
      response.writeHead(202,{location:'/v2/'+upload[1]+'/blobs/uploads/fixture'});response.end();return;
    }
    if(upload&&request.method==='PUT'){
      const chunks=[];let size=0;
      for await(const chunk of request){size+=chunk.length;if(size>4*1024*1024)throw Error('FIXTURE_BLOB_LIMIT');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks),digest=url.searchParams.get('digest');
      assert.equal(digest,'sha256:'+hash(bytes));blobs.set(upload[1]+'/'+digest,bytes);
      response.writeHead(201);response.end();return;
    }
    const object=url.pathname.match(/^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/);
    if(object){
      const [,path,kind,reference]=object;
      if(request.method==='GET'){
        const bytes=(kind==='manifests'?manifests:blobs).get(path+'/'+reference);
        if(!bytes)return json(response,404,{message:'fixture object absent'});
        response.writeHead(200,{'content-type':kind==='manifests'?'application/vnd.oci.image.manifest.v1+json':'application/octet-stream'});response.end(bytes);return;
      }
      if(request.method==='PUT'&&kind==='manifests'){
        const chunks=[];for await(const chunk of request)chunks.push(chunk);
        const bytes=Buffer.concat(chunks);manifests.set(path+'/'+reference,bytes);manifests.set(path+'/sha256:'+hash(bytes),bytes);
        if(path.endsWith('/catalog-v1')){
          state.counts.catalogWrites++;
          if(!reference.startsWith('verified-'))state.onCatalogManifest?.();
        }
        response.writeHead(201);response.end();return;
      }
    }
    throw Error('UNEXPECTED_FIXTURE_REGISTRY_ROUTE');
  };
  const server=createServer((request,response)=>{handler(request,response).catch(error=>{failures.push(error);json(response,500,{message:'fixture handler failed'});});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const fetcher=(input,options)=>{
    const target=new URL(input);
    assert(['ghcr.io','api.github.com'].includes(target.hostname),'fixture must reject external destinations');
    return fetch(origin+target.pathname+target.search,options);
  };
  const runBridge=async(executable,args)=>{
    assert.equal(executable,'gh');
    if(args[0]==='auth'){assert.deepEqual(args,['auth','token']);return {code:0,stdout:'fixture-operator-token'};}
    assert.equal(args[0],'api');
    const endpoint=args.at(-1);assert(endpoint.startsWith('repos/'+repository+'/'));
    const response=await fetch(origin+'/'+endpoint),body=await response.text();
    const headers=[...response.headers].map(([name,value])=>name+': '+value).join('\r\n');
    return {code:response.ok?0:1,stdout:'HTTP/1.1 '+response.status+' '+response.statusText+'\r\n'+headers+'\r\n\r\n'+body,stderr:response.ok?'':'fixture HTTP '+response.status};
  };
  return {state,fetcher,runBridge,manifests,failures,reset:()=>{for(const key of Object.keys(state.counts))state.counts[key]=0;},
    close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));},
    catalogAlias:repository+'-components/catalog-v1/verified-'+recipe};
}

test('real HTTP quota/catalog failures preserve verified CI with durable PG retry and bounded requests',{skip:!configured},async t=>{
  const f=await setup({git:createGit({flowGit:createFlowGit({localRemote:true,requireLock:()=>{}})})}),repository='fixture/repository',sha='a'.repeat(40),recipe='b'.repeat(64);
  const http=await startHTTPFixture({repository,sha,recipe});
  try{
    const project=await f.project({github:{repository,required_checks:[{name:'Codeworks components',app_id:42}]}}),{privateKey,publicKey}=generateKeyPairSync('ed25519');
    const keyFile=join(dirname(project.repo_path),'catalog-key.pem');
    await writeFile(keyFile,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    project.github={repository,ci:{check_name:'Codeworks components',app_id:42,workflow_sha256:'c'.repeat(64),recipe_sha256:recipe,reuse_public_key:publicKey.export({type:'spki',format:'pem'})}};
    await f.owner.query('UPDATE codeworks.projects SET config=$2 WHERE id=$1',[project.id,project]);
    await f.owner.query("INSERT INTO codeworks.execution_control(project_id,instance_id,owner) VALUES($1,'fixture','temporal')",[project.id]);
    const registry=createRegistry({repository,username:'fixture',token:'fixture-seed-token',fetcher:http.fetcher});
    const metadata=(kind,key)=>({format:'brai-ci-object-v1',repository,source:sha,runId:'123',attempt:'1',recipe,kind,key});
    const artifact=await registry.publishJSON('probe','runtime-123','fixture.json',{runtime:'fixture'},metadata('runtime','1'.repeat(64)));
    const check=await registry.publishJSON('probe','check-123','fixture.json',{check:'fixture'},metadata('check','2'.repeat(64)));
    const composition={format:'brai-release-composition-v1',repository,source:sha,runId:'123',attempt:'1',workflow:'.github/workflows/codeworks.yml',recipe,billing:{state:'hard-stop-confirmed'},components:[{id:'probe',keys:{artifact:'1'.repeat(64),checks:'2'.repeat(64)},artifact,check}]};
    const published=await registry.publishJSON('release','run-123-1','release.json',composition,metadata('composition','3'.repeat(64)));
    const proof={published,composition},store=createCIEvidence(f.app);await store.save(project,proof);
    let time=Date.parse('2026-11-11T12:00:00Z');t.mock.method(Date,'now',()=>time);
    const adapter=()=>createGitHub({run:http.runBridge,fetcher:http.fetcher,evidenceStore:createCIEvidence(f.app),catalogKeyFile:keyFile,now:()=>time});
    const pass=()=>reconcileCatalogPublication(f.app,project.id,{github:adapter(),now:()=>new Date(time)});
    const verify=async()=>{const rows=await adapter().checks(project,sha);assert.equal(rows[0].ci_state,'CI_VERIFIED');assert.equal(rows[0].ci_verified,true);assert.equal(rows[0].ci_evidence.composition_digest,published.digest);};
    http.reset();await verify();assert.equal(http.state.counts.api,4);assert.equal(http.state.counts.catalogAuth,0);assert.equal(http.state.counts.catalogWrites,0);
    http.state.catalogFailure=429;
    const limited=await pass();assert.equal(limited.reason_code,'GITHUB_RATE_LIMITED');assert.equal(limited.next_attempt_at,'2026-11-11T12:02:00.000Z');
    assert.equal(http.state.counts.catalogAuth,1);assert.deepEqual(await createCIEvidence(f.app).read(project,'123','1'),proof);
    const blockedCount=http.state.counts.all;
    assert.equal((await pass()).state,'waiting');
    await assert.rejects(adapter().checks(project,sha),{code:'GITHUB_RATE_LIMITED'});
    assert.equal(http.state.counts.all,blockedCount,'fresh adapters and project passes must respect the durable shared quota');
    assert.equal((await store.githubRetry(project)).github_reason_code,'GITHUB_RATE_LIMITED');
    time+=120000;http.state.catalogFailure=503;
    const unavailable=await pass();assert.equal(unavailable.reason_code,'GITHUB_UNAVAILABLE');assert.equal(unavailable.next_attempt_at,'2026-11-11T12:03:00.000Z');
    assert.equal(http.state.counts.catalogAuth,2);assert.equal(http.state.counts.catalogWrites,0);
    await verify();assert.equal(http.state.counts.api,8,'fresh live CI reads continue after catalog-only HTTP failure');
    const waitingCount=http.state.counts.all;
    assert.equal((await pass()).state,'waiting');assert.equal(http.state.counts.all,waitingCount);
    assert.deepEqual(await store.read(project,'123','1'),proof);
    time+=60000;http.state.catalogFailure=null;
    const completed=await pass();assert.equal(completed.state,'published');assert.match(completed.published.digest,/^sha256:[0-9a-f]{64}$/);
    assert.equal(http.state.counts.catalogAuth,4,'successful OCI publication obtains separate pull and push grants');
    assert.equal(http.state.counts.catalogWrites,2,'one immutable catalog manifest and one recipe pointer are published');
    assert(http.manifests.has(http.catalogAlias));
    await store.save(project,proof);
    const finishedCount=http.state.counts.all;assert.equal((await pass()).state,'idle');assert.equal(http.state.counts.all,finishedCount);
    const row=(await f.app.query('SELECT catalog_state,catalog_attempts,catalog_result FROM codeworks.verified_ci WHERE project_id=$1',[project.id])).rows[0];
    assert.equal(row.catalog_state,'published');assert.equal(row.catalog_attempts,3);assert.deepEqual(row.catalog_result,completed.published);
    assert.deepEqual(await store.read(project,'123','1'),proof);
    // Реальный Activity wrapper вызывает runOperation; Git-порт фиксирует уже отправленную рабочую ветку.
    const prepared=await f.prepare({project_id:project.id,workspace_key:'quota-pr-recovery',kind:'feature',request_key:randomUUID()});
    const workspace=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0];
    http.state.prBranch=workspace.branch;
    let inspected=0;
    const git={inspect:async()=>{inspected++;return {head:sha,dirty:false};}};
    const flowGit={validateHead:async()=>{},remote:async(_p,ref)=>ref===workspace.branch?sha:'d'.repeat(40),push:async()=>assert.fail('already pushed branch must not be pushed again')};
    const sync=async()=>{
      const id=randomUUID();
      await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','sync','pending','intent',$4)",[id,project.id,workspace.id,{commit_sha:sha}]);
      const command=(await f.app.query('SELECT * FROM codeworks.commands WHERE operation_id=$1',[id])).rows[0];
      return {id,command,advance:async()=>createActivities(f.app,{allowedRepositories:[project.repo_path],execute:runOperation,adapters:{git,flowGit,github:adapter(),deploymentAdapter:null},identity:()=>command.workflow_id}).synchronizeBranch(id,Number(command.generation))};
    };
    const working=await sync();http.state.prFailure=429;
    assert.equal((await working.advance()).status,'awaiting_reconciliation');
    const quota=(await f.app.query('SELECT status,step,error,result FROM codeworks.operations WHERE id=$1',[working.id])).rows[0];
    assert.equal(quota.step,'GITHUB_RATE_LIMITED');assert.equal(quota.error.code,'GITHUB_RATE_LIMITED');assert.equal(quota.result.primary.branch,workspace.branch);
    const deadline=new Date(time+120000).toISOString();
    assert.equal(quota.error.retry_at,deadline);
    assert.equal((await f.app.query('SELECT retry_at FROM codeworks.commands WHERE operation_id=$1',[working.id])).rows[0].retry_at.toISOString(),deadline,'Activity finalizer must preserve the exact shared quota deadline');
    const prCalls=http.state.counts.pr,externalCalls=http.state.counts.all,inspections=inspected;
    assert.equal((await working.advance()).status,'awaiting_reconciliation');
    assert.equal(http.state.counts.pr,prCalls);assert.equal(http.state.counts.all,externalCalls);assert.equal(inspected,inspections,'deferred command must return before external ports');
    time+=120000;http.state.prFailure=null;
    assert.equal((await working.advance()).status,'succeeded');
    assert.equal((await f.app.query('SELECT state,retry_at FROM codeworks.commands WHERE operation_id=$1',[working.id])).rows[0].retry_at,null);
    assert.equal((await f.app.query('SELECT count(*)::int AS n FROM codeworks.commands WHERE operation_id=$1',[working.id])).rows[0].n,1);
    const auth=await sync();http.state.prFailure=401;
    assert.equal((await auth.advance()).status,'awaiting_reconciliation');
    const authRow=(await f.app.query('SELECT step,error FROM codeworks.operations WHERE id=$1',[auth.id])).rows[0];
    assert.equal(authRow.step,'GITHUB_AUTH_REQUIRED');assert.equal(authRow.error.retryable,false);assert.equal(JSON.stringify(authRow).includes('fixture private transport detail'),false);
    http.state.prFailure=null;
    // Потеря сессии после immutable tag не разрешает старому исполнителю записать mutable alias.
    await f.owner.query("UPDATE codeworks.verified_ci SET catalog_state='pending',catalog_next_attempt_at=NULL WHERE project_id=$1",[project.id]);
    for(const key of [...http.manifests.keys()])if(key.includes('/catalog-v1/'))http.manifests.delete(key);
    http.state.counts.catalogWrites=0;let guardedSession;
    const lostPool={connect:async()=>{guardedSession=await f.app.connect();return guardedSession;}};
    http.state.onCatalogManifest=()=>{http.state.onCatalogManifest=null;guardedSession.emit('error',Error('fixture catalog guard lost'));};
    await assert.rejects(reconcileCatalogPublication(lostPool,project.id,{github:adapter(),now:()=>new Date(time)}),/CATALOG_GUARD_LOST/);
    assert.equal(http.state.counts.catalogWrites,1);assert.equal(http.manifests.has(http.catalogAlias),false,'lost pass must not write the recipe alias after losing its guard');
    const leaseCount=http.state.counts.all;
    assert.equal((await pass()).state,'waiting');assert.equal(http.state.counts.all,leaseCount);
    time+=120000;
    assert.equal((await pass()).state,'published');assert.equal(http.state.counts.catalogWrites,2,'new pass reconciles the immutable tag and writes the pointer once');
    assert(http.manifests.has(http.catalogAlias));assert.deepEqual(await store.read(project,'123','1'),proof);
    http.state.failedCheck=true;
    const failed=(await adapter().checks(project,sha))[0];assert.equal(failed.ci_verified,false);assert.equal(failed.ci_state,'EXACT_CI_SUCCESS_REQUIRED');
    assert.equal(http.state.counts.recipeReads,0);assert.equal(http.state.counts.proofDownloads,0);
    await f.owner.query("UPDATE codeworks.verified_ci SET catalog_state='legacy' WHERE project_id=$1",[project.id]);
    const legacyCount=http.state.counts.all;assert.equal((await pass()).state,'idle');assert.equal(http.state.counts.all,legacyCount);
    await assert.rejects(f.app.query("UPDATE codeworks.verified_ci SET proof='{}'"),{code:'42501'});
    assert.deepEqual(http.failures,[]);
  }finally{await http.close();await f.close();}
});
