// ABOUTME: Проверяет client Local AI readiness и declared idle settings через fake NATS.
// ABOUTME: Запускает реальный сценарий с подменой только файлов и внешнего транспорта.
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const path=new URL('../roles/brai_install/files/install_models.mjs',import.meta.url);
const source=readFileSync(path,'utf8').replace(/^import .*;\n/gm,'').replace("const {subjects}=await import(root+'/contracts/index.mjs');","const {subjects}=contracts;");
const profileIds=['llama_cpp','gigaam_pytorch','embeddinggemma2_llama_cpp','silero_pytorch'];
/** Исполнить owner script, сохраняя только исходящие DTO и безопасный exitCode. */
async function execute(settings){
 const calls=[];const manifest={installed:{prod:{'local-ai':'sha256:'+'a'.repeat(64)}},local_ai:{'production/local_ai':{settings}}};
 const subjects={modelsList:'list',modelsGet:'get',modelsInstall:'install',operationsGet:'operation',modelsConfigure:'configure'};
 const context={contracts:{subjects},randomUUID:()=> '00000000-0000-4000-8000-000000000000',setTimeout:callback=>callback(),console:{log(){},error(){}},process:{argv:['node','script','prod','inputs','manifest'],env:{BRAI_INSTALL_NPM_ROOT:'/fake',BRAI_INSTALL_ROOT:'/fixture'}}};
 context.fs={existsSync:()=>false,readFileSync(file){if(file==='inputs')return JSON.stringify({provision:{user:'fixture',password:'synthetic'}});if(file==='manifest')return JSON.stringify(manifest);if(file.endsWith('/projects/production.json'))return JSON.stringify({services:{local_ai:{environment:{LOCAL_AI_CONFIG_JSON:JSON.stringify({runtime:Object.fromEntries(profileIds.map(id=>[id,{}]))})}}}});const id=profileIds.find(id=>file.endsWith('/profiles/'+id+'.json'));assert.ok(id);return JSON.stringify({modelId:id+'-model',source:{revision:'pinned'}});},writeFileSync(){throw Error('Unexpected installation');},renameSync(){throw Error('Unexpected installation');}};
 context.createRequire=()=>()=>({JSONCodec:()=>({encode:x=>x,decode:x=>x}),connect:async()=>({close:async()=>{},request:async(subject,payload)=>{calls.push({subject,payload});if(subject==='list'){assert.ok(payload.filter);return {data:{items:[],nextCursor:null}};}if(subject==='get')return {data:{installationState:'installed',revision:'pinned'}};if(subject==='configure')return {data:payload};throw Error('Unexpected mutation');}})});
 await vm.runInNewContext('(async()=>{'+source+'})()',context);
 return {calls,exitCode:context.process.exitCode};
}

test('readiness filter and settings are applied to already installed models',async()=>{
 const result=await execute({embeddinggemma2_llama_cpp:{idleUnloadSeconds:null},silero_pytorch:{idleUnloadSeconds:600}});
 assert.equal(result.exitCode,undefined);
 const configured=result.calls.filter(x=>x.subject==='configure');assert.equal(configured.length,2);
 assert.equal(configured[0].payload.profileId,'embeddinggemma2_llama_cpp');assert.equal(configured[0].payload.idleUnloadSeconds,null);
 assert.equal(configured[1].payload.profileId,'silero_pytorch');assert.equal(configured[1].payload.idleUnloadSeconds,600);
});
test('absent declared settings preserve existing defaults',async()=>{
 const result=await execute(undefined);assert.equal(result.exitCode,undefined);assert.equal(result.calls.filter(x=>x.subject==='configure').length,0);
});
test('invalid declared setting is rejected before configuration write',async()=>{
 const result=await execute({embeddinggemma2_llama_cpp:{idleUnloadSeconds:0}});assert.equal(result.exitCode,1);assert.equal(result.calls.filter(x=>x.subject==='configure').length,0);
});
