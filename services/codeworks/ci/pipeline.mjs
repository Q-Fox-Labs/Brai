// ABOUTME: Планирует один CI job, повторно использует immutable OCI и ограничивает компоненты двумя workers.
// ABOUTME: Все проверки завершаются до первой публикации; развёртывание и миграции здесь отсутствуют.
import {existsSync,mkdirSync,readFileSync,writeFileSync,cpSync,rmSync,mkdtempSync} from 'node:fs';
import {join,resolve,dirname,posix} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {discover,fingerprints,json,digestFiles} from '../components/graph.mjs';
import {buildOutputDigest,verifyBuildReceipt} from '../components/cli.mjs';
import {verifyPackage,packageComponent} from '../components/package-runtime.mjs';
import {createRegistry,run,sha256} from './registry.mjs';
import {recipeFiles,verifyRecipeAt,loadRunProof,downloadProof} from '../src/ci-verifier.mjs';
import {verifyCatalog,catalogContains} from './catalog.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
export {recipeFiles};
/** Build receipt key stays local; registry identity also pins the accepted CI recipe. */
export const buildSnapshotTag=(key,recipe)=>'build-'+sha256(key+recipe);
const save=(path,value)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2)+'\n');};
const stamp=()=>new Date().toISOString();
/** Обрабатывает независимые части максимум двумя workers, останавливая новые работы после ошибки. */
export async function bounded(items,work,limit=2) {
  let cursor=0,failure;const results=[];
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(!failure&&cursor<items.length){const index=cursor++;try{results[index]=await work(items[index]);}catch(error){failure??=error;}}}));
  if(failure)throw failure;return results;
}
/** Явные множества сборки, проверок, упаковки и reuse; полный SHA не участвует в content keys. */
export function selectWork(items) {
  return {
    build:items.filter(x=>!x.artifactHit&&!x.buildHit&&x.hasBuild).map(x=>x.id),
    check:items.filter(x=>!x.checkHit&&x.hasCheck).map(x=>x.id),
    package:items.filter(x=>!x.artifactHit).map(x=>x.id),
    reuse:items.filter(x=>x.artifactHit).map(x=>x.id),
    needsDependencies:items.some(x=>x.hasNpm&&(!x.artifactHit||(!x.checkHit&&x.hasCheck))),
  };
}
async function github(endpoint,token) {
  const response=await fetch(`https://api.github.com/${endpoint}`,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`CI_IDENTITY_UNAVAILABLE: ${response.status}`);return response.json();
}
/** Не принимает опубликованный объект неуспешного, другого или ещё исполняющегося run. */
export async function reusable(hit,expected,{repository,token,readRun,readRecipe,readOriginProof,catalog}={}) {
  if(!hit)return false;
  const m=hit.metadata;
  if(m.format!=='brai-ci-object-v1'||m.repository!==repository||m.key!==expected.key||m.kind!==expected.kind||m.recipe!==expected.recipe||!/^\d+$/.test(m.runId)||!/^\d+$/.test(m.attempt)||!/^[0-9a-f]{40}$/.test(m.source))throw Error('REUSE_IDENTITY_MISMATCH');
  const doc=await (readRun??((id,attempt)=>github(`repos/${repository}/actions/runs/${id}/attempts/${attempt}`,token)))(m.runId,m.attempt);
  if(doc.repository?.full_name!==repository||doc.head_sha!==m.source||doc.path!=='.github/workflows/codeworks.yml'||doc.event!=='push'||doc.status!=='completed'||doc.conclusion!=='success'||String(doc.run_attempt)!==m.attempt)return false;
  if(!await (readRecipe??((source,recipe)=>verifyRecipeAt(endpoint=>github(`repos/${repository}/${endpoint}`,token),source,recipe)))(m.source,expected.recipe))return false;
  if(catalogContains(catalog,expected.id,hit))return true;
  const proof=await (readOriginProof??((id,attempt,source)=>loadRunProof(endpoint=>github(`repos/${repository}/${endpoint}`,token),artifact=>downloadProof({repository,token},artifact),id,attempt,source)))(m.runId,m.attempt,m.source);
  const component=proof?.composition?.components?.find(c=>c.id===expected.id),kind=expected.kind==='runtime'?'artifact':expected.kind==='build'?'build':'check';
  if(component?.[kind]?.digest!==hit.digest||(kind==='artifact'?component?.keys?.artifact:kind==='build'?component?.keys?.build:component?.keys?.checks)!==expected.key)return false;
  return true;
}
function config(env=process.env) {
  for(const name of ['GITHUB_REPOSITORY','GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_TOKEN','GITHUB_ACTOR'])if(!env[name])throw Error(`CI_CONFIGURATION_REQUIRED: ${name}`);
  if(env.GITHUB_EVENT_NAME!=='push')throw Error('EXACT_PUSH_WORKFLOW_REQUIRED');
  if(env.CODEWORKS_ZERO_EXTRA_POLICY!=='account-wide-actions-usd0-stop-usage'||!env.CODEWORKS_BILLING_CONFIRMED_AT)throw Error('BILLING_CONFIRMATION_REQUIRED');
  return {repository:env.GITHUB_REPOSITORY,source:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,token:env.GITHUB_TOKEN,username:env.GITHUB_ACTOR};
}
async function plan(cfg,registry) {
  const started=Date.now(),recipe=digestFiles(root,recipeFiles),target=process.env.CODEWORKS_TARGET??'dev';
  if(!['dev','prod'].includes(target))throw Error('INVALID_TARGET');
  const toolchain=json(join(root,'services/codeworks/ci/toolchain.json'));
  if(process.versions.node!==toolchain.node||`${process.platform}/${process.arch==='x64'?'amd64':process.arch}`!==toolchain.platform)throw Error('TOOLCHAIN_MISMATCH');
  const graph=discover(root,{base:process.env.CODEWORKS_BASE_REF??'refs/remotes/origin/dev',allowMissingBuildOutputs:true});
  const docker=await run('docker',['version','--format','{{.Client.Version}}/{{.Server.Version}}'],{quiet:true});
  const buildx=await run('docker',['buildx','version'],{quiet:true});
  const dockerToolchain=docker.stdout.trim()+';'+buildx.stdout.trim();
  const variant=target==='dev'?'development':'production';
  let reuseCatalog=null;
  if(process.env.CODEWORKS_REUSE_PUBLIC_KEY) {
    const hit=await registry.lookup('catalog','verified-'+recipe);
    if(hit) {
      const document=await registry.readJSON('catalog',hit.digest,'catalog.json');
      if(!verifyCatalog(document,process.env.CODEWORKS_REUSE_PUBLIC_KEY,{repository:cfg.repository,recipe}))throw Error('CI_CATALOG_UNTRUSTED');
      reuseCatalog={reference:hit.reference,digest:hit.digest,document};
    }
  }
  const runs=new Map(),recipes=new Map(),proofs=new Map();
  const reusePorts={...cfg,catalog:reuseCatalog?.document,readRun:(id,attempt)=>{const key=id+'/'+attempt;if(!runs.has(key))runs.set(key,github(`repos/${cfg.repository}/actions/runs/${id}/attempts/${attempt}`,cfg.token));return runs.get(key);},readRecipe:(source,expected)=>{if(!recipes.has(source))recipes.set(source,verifyRecipeAt(endpoint=>github(`repos/${cfg.repository}/${endpoint}`,cfg.token),source,expected));return recipes.get(source);},readOriginProof:(id,attempt,source)=>{const key=id+'/'+attempt;if(!proofs.has(key))proofs.set(key,loadRunProof(endpoint=>github(`repos/${cfg.repository}/${endpoint}`,cfg.token),artifact=>downloadProof(cfg,artifact),id,attempt,source));return proofs.get(key);}};
  const items=await bounded(graph.order.filter(id=>graph.components.get(id).environments.includes(target)),async id=>{
    const c=graph.components.get(id),keys=fingerprints(root,c,{variant});
    keys.artifact=sha256(keys.artifact+recipe+dockerToolchain);keys.checks=sha256(keys.checks+recipe+dockerToolchain);
    const [artifact,check,build]=await Promise.all([registry.lookup(id,'input-'+keys.artifact),registry.lookup(id,'check-'+keys.checks),c.commands.build?registry.lookup(id,buildSnapshotTag(keys.build,recipe)):null]);
    const [artifactHit,checkHit,buildHit]=await Promise.all([reusable(artifact,{id,key:keys.artifact,kind:'runtime',recipe},reusePorts),reusable(check,{id,key:keys.checks,kind:'check',recipe},reusePorts),c.commands.build?reusable(build,{id,key:keys.build,kind:'build',recipe},reusePorts):false]);
    return {id,keys,hasBuild:!!c.commands.build,hasCheck:!!c.commands.check,hasNpm:!!c.npm.workspaces.length,artifact:artifactHit?artifact:null,check:checkHit?check:null,build:buildHit?build:null,artifactHit,checkHit,buildHit};
  });
  return {format:'brai-ci-plan-v1',source:cfg.source,recipe,target,variant,dockerToolchain,reuseCatalog,createdAt:stamp(),planningMs:Date.now()-started,items,sets:selectWork(items)};
}
async function extract(registryHit,destination,commands=run) {
  await commands('docker',['pull',registryHit.reference]);
  const {stdout}=await commands('docker',['create','--entrypoint','/not-executed',registryHit.reference],{quiet:true});
  const id=stdout.trim();if(!/^[0-9a-f]{64}$/.test(id))throw Error('INVALID_EXTRACTION_CONTAINER');
  try{mkdirSync(destination,{recursive:true});await commands('docker',['cp',`${id}:/payload/.`,destination]);}finally{await commands('docker',['rm',id],{quiet:true});}
}
async function restoreOutputs(item,c,root,commands) {
  const selected=item.artifactHit?item.artifact:item.build;
  const artifactPath=join(root,'tmp/ci-restored',item.id);await extract(selected,artifactPath,commands);
  const artifact=verifyPackage(artifactPath,item.id);
  if(artifact.payloadHash!==selected.metadata.payloadHash)throw Error('RESTORED_PAYLOAD_IDENTITY_MISMATCH');
  for(const path of c.delivery.files.filter(path=>/\/(?:dist|\.next)(?:\/|$)/.test(path))) {
    rmSync(join(root,path),{recursive:true,force:true});mkdirSync(dirname(join(root,path)),{recursive:true});cpSync(join(artifactPath,path),join(root,path),{recursive:true});
  }
  save(join(root,'tmp/component-state',item.id+'.json'),{build:item.keys.build,outputDigest:c.commands.build?buildOutputDigest(root,c):undefined});
}
function runtimeContext(root,c,payload) {
  const context=mkdtempSync(join(root,'tmp/ci-context-'));mkdirSync(join(context,'payload'));cpSync(payload.path,join(context,'payload'),{recursive:true});
  const base=c.delivery.kind==='oci-context'?json(join(root,'services/codeworks/ci/toolchain.json')).nodeBase:'scratch';
  const command=c.delivery.command??(c.delivery.entrypoints.length?['node',posix.relative(c.directory,c.delivery.entrypoints[0])]:[]);
  const workdir=c.delivery.kind==='oci-context'?`/payload/${c.directory}`:'/payload';
  writeFileSync(join(context,'Dockerfile'),`FROM ${base}\nCOPY payload/ /payload/\nWORKDIR ${workdir}\n${c.delivery.kind==='oci-context'?`CMD ${JSON.stringify(command)}\n`:''}`);
  return context;
}
/** Выполняет зафиксированный plan; commands/registry — явные порты для изолированной проверки ошибок. */
export async function executePlan(cfg,registry,plan,{repositoryRoot=root,commands=run}={}) {
  const root=repositoryRoot;
  if(plan.source!==cfg.source||plan.recipe!==digestFiles(root,recipeFiles))throw Error('PLAN_INPUTS_CHANGED');
  const started=Date.now(),graph=discover(root,{allowMissingBuildOutputs:true}),finished=new Set(),prepared=new Map();
  // AIDEV-NOTE: Restore только generated outputs. Исходники и node_modules из чужого receipt не перезаписываются.
  const restored=new Map();
  const ensureOutputs=item=>{if(!restored.has(item.id))restored.set(item.id,restoreOutputs(item,graph.components.get(item.id),root,commands));return restored.get(item.id);};
  for(const item of plan.items)if(item.hasBuild&&((item.artifactHit&&!item.checkHit)||(!item.artifactHit&&item.buildHit)))await ensureOutputs(item);
  const provenance=(kind,key)=>({format:'brai-ci-object-v1',repository:cfg.repository,source:cfg.source,runId:cfg.runId,attempt:cfg.attempt,recipe:plan.recipe,kind,key});
  while(finished.size<plan.items.length) {
    const ready=plan.items.filter(item=>!finished.has(item.id)&&graph.components.get(item.id).dependencies.every(d=>!plan.items.some(x=>x.id===d.id)||finished.has(d.id)));
    if(!ready.length)throw Error('CI_GRAPH_BLOCKED');
    await bounded(ready,async item=>{
      const c=graph.components.get(item.id),entry={...item,buildMs:0,checkMs:0,packageMs:0};
      // Зависимому компилятору могут требоваться dist соседа даже когда поставка соседа полностью reused.
      for(const d of c.dependencies)if(d.delivery.some(path=>/\/(?:dist|\.next)(?:\/|$)/.test(path)&&!existsSync(join(root,path)))) {
        const source=plan.items.find(x=>x.id===d.id);if(source?.artifactHit)await ensureOutputs(source);
      }
      const env={...process.env,BRAI_WEB_VARIANT:plan.variant,BRAI_WEB_STANDALONE_OUTPUT:'0',CI:'1',NEXT_TELEMETRY_DISABLED:'1'};
      const cli=async action=>{
        // CI check/package не вправе использовать convenience CLI и скрыто пересобирать компонент.
        if(action==='check'||action==='package')verifyBuildReceipt(root,c,undefined,item.keys.build);
        return commands(process.execPath,['services/codeworks/components/cli.mjs',action,item.id,'--only','--base',cfg.source],{cwd:root,env});
      };
      if(!item.artifactHit&&!item.buildHit&&c.commands.build){const t=Date.now();await cli('build');entry.buildMs=Date.now()-t;}
      if(!item.checkHit&&c.commands.check){const t=Date.now();await cli('check');entry.checkMs=Date.now()-t;}
      if(!item.artifactHit&&item.id==='instaloader') {
        const context=mkdtempSync(join(root,'tmp/ci-instaloader-'));cpSync(join(root,c.directory),context,{recursive:true});
        const docker=readFileSync(join(context,'Dockerfile'),'utf8').replace(/^FROM .+$/m,'FROM '+json(join(root,'services/codeworks/ci/toolchain.json')).pythonBase);
        writeFileSync(join(context,'Dockerfile'),docker);
        entry.externalImage=registry.reference(item.id,'smoke-'+cfg.runId+'-'+cfg.attempt);entry.context=context;
        const metadata={...provenance('runtime',item.keys.artifact),payloadHash:null,componentType:c.type,deliveryKind:'external-cli'};
        const buildArgs=['buildx','build','--load','--provenance=false','--platform','linux/amd64','--label','app.brai.codeworks='+JSON.stringify(metadata),'-t',entry.externalImage];
        if(process.env.CODEWORKS_DISABLE_CACHE!=='1')buildArgs.push('--cache-from',`type=registry,ref=${registry.reference(item.id,'layers')}`,'--cache-to','type=inline');
        const t=Date.now();const output=await run('docker',[...buildArgs,context]);entry.buildMs=Date.now()-t;entry.layerCacheHits=(output.stdout+'\n'+output.stderr).match(/\bCACHED\b/g)?.length??0;
        const checkStarted=Date.now();await run('docker',['run','--rm','--pull','never','--network','none','--read-only',entry.externalImage,'--help']);entry.checkMs=Date.now()-checkStarted;
      }
      if(!item.artifactHit&&item.id!=='instaloader') {
        const t=Date.now();await cli('package');entry.packageMs=Date.now()-t;
        const state=json(join(root,'tmp/component-state',item.id+'.json'));entry.payload=verifyPackage(state.packagePath,item.id);
        if(c.delivery.kind==='oci-context') {
          entry.context=runtimeContext(root,c,entry.payload);entry.externalImage=registry.reference(item.id,'smoke-'+cfg.runId+'-'+cfg.attempt);
          const metadata={...provenance('runtime',item.keys.artifact),payloadHash:entry.payload.payloadHash,componentType:c.type,deliveryKind:c.delivery.kind};
          const args=['buildx','build','--load','--provenance=false','--platform','linux/amd64','--label','app.brai.codeworks='+JSON.stringify(metadata),'-t',entry.externalImage];
          if(process.env.CODEWORKS_DISABLE_CACHE!=='1')args.push('--cache-from',`type=registry,ref=${registry.reference(item.id,'layers')}`,'--cache-to','type=inline');
          const t=Date.now(),built=await commands('docker',[...args,entry.context]);entry.packageMs+=Date.now()-t;entry.layerCacheHits=(built.stdout+'\n'+built.stderr).match(/\bCACHED\b/g)?.length??0;
          const script="import{execFileSync}from'node:child_process';\n"+c.delivery.entrypoints.filter(p=>/\.(?:mjs|cjs|js)$/.test(p)).map(p=>`execFileSync(process.execPath,['--check',${JSON.stringify('/payload/'+p)}]);`).join('\n')+'\n'+c.delivery.smokeImports.map(p=>`await import(${JSON.stringify('file:///payload/'+p)}${p.endsWith('.json')?",{with:{type:'json'}}":''});`).join('\n');
          const checked=Date.now();await commands('docker',['run','--rm','--pull','never','--network','none','--read-only','--entrypoint','node',entry.externalImage,'--input-type=module','--eval',script]);entry.checkMs+=Date.now()-checked;
        }
      }
      prepared.set(item.id,entry);finished.add(item.id);
    });
  }
  // Проверка не вправе поменять исходники/recipe и затем опубликовать прежние keys.
  if(plan.recipe!==digestFiles(root,recipeFiles))throw Error('CHECK_CHANGED_RECIPE');
  for(const item of plan.items) {
    const now=fingerprints(root,graph.components.get(item.id),{variant:plan.variant});
    if(now.build!==item.keys.build||sha256(now.artifact+plan.recipe+(plan.dockerToolchain??''))!==item.keys.artifact||sha256(now.checks+plan.recipe+(plan.dockerToolchain??''))!==item.keys.checks)throw Error(`CHECK_CHANGED_SOURCE: ${item.id}`);
    const payload=prepared.get(item.id).payload;if(payload)verifyPackage(payload.path,item.id);
    if(item.hasBuild&&(!item.artifactHit||!item.checkHit))verifyBuildReceipt(root,graph.components.get(item.id),undefined,item.keys.build);
  }
  const records=[];
  // Ни один check не может упасть после начала publication: все проверки выше завершены.
  for(const item of plan.items) {
    const entry=prepared.get(item.id),c=graph.components.get(item.id);
    let artifact=item.artifact,check=item.check,build=item.build;
    if(item.hasBuild&&!item.buildHit&&!item.artifactHit) {
      const snapshot=await packageComponent(root,{...c,npm:{workspaces:[]},delivery:{kind:'ready-files',files:c.delivery.files,entrypoints:[],smokeImports:[],systemRequirements:[]}},join(root,'tmp/ci-build-snapshots'));
      const context=mkdtempSync(join(root,'tmp/ci-build-'));mkdirSync(join(context,'payload'));cpSync(snapshot.path,join(context,'payload'),{recursive:true});
      writeFileSync(join(context,'Dockerfile'),'FROM scratch\nCOPY payload/ /payload/\n');
      build=await registry.publish(item.id,buildSnapshotTag(item.keys.build,plan.recipe),context,{...provenance('build',item.keys.build),payloadHash:snapshot.payloadHash});
    }
    if(!item.artifactHit) {
      const context=entry.context??runtimeContext(root,c,entry.payload);
      artifact=await registry.publish(item.id,'input-'+item.keys.artifact,context,{...provenance('runtime',item.keys.artifact),payloadHash:entry.payload?.payloadHash??null,componentType:c.type,deliveryKind:item.id==='instaloader'?'external-cli':c.delivery.kind},{layers:process.env.CODEWORKS_DISABLE_CACHE!=='1',existingImage:entry.externalImage});
    }
    if(!item.checkHit) {
      const context=mkdtempSync(join(root,'tmp/ci-check-'));save(join(context,'check.json'),{source:cfg.source,id:item.id,key:item.keys.checks});
      writeFileSync(join(context,'Dockerfile'),'FROM scratch\nCOPY check.json /check.json\n');
      check=await registry.publish(item.id,'check-'+item.keys.checks,context,provenance('check',item.keys.checks));
    }
    records.push({id:item.id,type:c.type,keys:item.keys,artifact,check,build,reused:item.artifactHit,reusedBuild:item.buildHit,checkedNow:!item.checkHit,buildMs:entry.buildMs,checkMs:entry.checkMs,packageMs:entry.packageMs,layerCacheHits:entry.layerCacheHits??artifact.layerCacheHits??0,systemRequirements:c.delivery.systemRequirements,deploy:c.deploy});
  }
  const dependencyPath=join(root,'tmp/ci-dependency-ms');
  const composition={format:'brai-release-composition-v1',repository:cfg.repository,source:cfg.source,runId:cfg.runId,attempt:cfg.attempt,workflow:'.github/workflows/codeworks.yml',recipe:plan.recipe,target:plan.target,reuseCatalog:plan.reuseCatalog?{reference:plan.reuseCatalog.reference,digest:plan.reuseCatalog.digest}:null,toolchain:{...json(join(root,'services/codeworks/ci/toolchain.json')),docker:plan.dockerToolchain??null},createdAt:stamp(),billing:{state:'hard-stop-confirmed',basis:'operator-confirmed account-wide Actions USD 0 with Stop usage',confirmedAt:process.env.CODEWORKS_BILLING_CONFIRMED_AT,quota:'unavailable-to-workflow-token'},components:records,retired:[...graph.components.values()].filter(c=>c.status==='retired').map(c=>({id:c.id,reason:c.reason,renamedTo:c.renamedTo})),measurements:{planningMs:plan.planningMs,dependencyMs:existsSync(dependencyPath)?Number(readFileSync(dependencyPath,'utf8')):0,executionMs:Date.now()-started,builds:plan.sets.build.length+(plan.items.some(x=>x.id==='instaloader'&&!x.artifactHit)?1:0),packages:plan.sets.package.length,reuse:plan.sets.reuse.length,checks:plan.sets.check.length,artifactBytes:records.reduce((n,c)=>n+c.artifact.bytes,0),dependencyDownloadCacheHit:process.env.CODEWORKS_DEPENDENCY_CACHE_HIT==='true',layerCacheHits:records.reduce((n,c)=>n+c.layerCacheHits,0),optionalCacheDisabled:process.env.CODEWORKS_DISABLE_CACHE==='1'}};
  const context=mkdtempSync(join(root,'tmp/ci-release-'));save(join(context,'release.json'),composition);writeFileSync(join(context,'Dockerfile'),'FROM scratch\nCOPY release.json /release.json\n');
  const published=await registry.publish('release','run-'+cfg.runId+'-'+cfg.attempt,context,provenance('composition',sha256(readFileSync(join(context,'release.json')))));
  save(join(root,'tmp/ci-result.json'),{composition,published});
  if(process.env.GITHUB_STEP_SUMMARY)writeFileSync(process.env.GITHUB_STEP_SUMMARY,`Composition: ${published.reference}\n\n\`\`\`json\n${JSON.stringify(composition.measurements,null,2)}\n\`\`\`\n`,{flag:'a'});
}
/** plan не требует npm; run разрешён только внутри заранее допущенного push job. */
export async function main(action=process.argv[2]) {
  const cfg=config(),registry=createRegistry(cfg),path=join(root,'tmp/ci-plan.json');
  if(action==='plan') {
    const result=await plan(cfg,registry);save(path,result);
    if(process.env.GITHUB_OUTPUT)writeFileSync(process.env.GITHUB_OUTPUT,`needs_dependencies=${result.sets.needsDependencies}\n`,{flag:'a'});
    console.log(JSON.stringify(result.sets,null,2));
  } else if(action==='run'){await registry.login();await executePlan(cfg,registry,json(path));}
  else throw Error('USAGE: pipeline.mjs plan|run');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
