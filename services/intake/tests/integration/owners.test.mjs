// ABOUTME: Проверяет адаптеры Приёма против настоящих Artifacts и History.
// ABOUTME: Владельцы запускаются отдельными процессами только на синтетических БД fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {connect} from 'nats';
import {Client,Connection} from '@temporalio/client';
import {createPorts} from '../../dist/ports.js';
import {integrationConfig} from './fixtures.mjs';
const cfg=integrationConfig(),root=fileURLToPath(new URL('../../../../',import.meta.url));
function run(script,env){
 const child=spawn(process.execPath,[script],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
 let output='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',b=>{output=(output+b.toString()).slice(-4000);});
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
 return {child,done,output:()=>output,async stop(){if(child.exitCode!==null)return;child.kill('SIGTERM');const killed=setTimeout(()=>child.kill('SIGKILL'),5000);try{await done;}finally{clearTimeout(killed);}}};
}
async function eventually(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('OWNER_START_TIMEOUT');}
test('real file publication, album ordering, reuse, foreign owner and immutable History facts',{skip:!cfg,timeout:60000},async()=>{
 const temp=await mkdtemp(root+'tmp/intake-owner-api-');
 const connection=Connection.lazy({address:cfg.temporalAddress});
 const nc=await connect({servers:cfg.natsUrl,user:'fixture',pass:'intake-test'});
 const url=(role,db)=>'postgresql://'+role+':intake-test@127.0.0.1:25643/'+db;
 const common={NATS_URL:'nats://127.0.0.1:24343',NATS_USER:'fixture',NATS_PASSWORD:'intake-test'};
 const artifactsEnv={...common,ARTIFACTS_DATABASE_URL:url('intake_artifacts_test_app','brai_intake_artifacts_test'),ARTIFACTS_DATA_DIR:temp+'/files',ARTIFACTS_HTTP_PORT:'38114',ARTIFACTS_HTTP_HOST:'127.0.0.1',ARTIFACTS_UPLOAD_BASE_URL:'http://127.0.0.1:38114',ARTIFACTS_INTERNAL_BASE_URL:'http://127.0.0.1:38114'};
 const historyEnv={...common,NATS_INBOX_PREFIX:'_INBOX.history_fixture',HISTORY_APP_DATABASE_URL:url('intake_history_test_app','brai_intake_history_test'),HISTORY_WEB_DATABASE_URL:url('intake_history_test_web','brai_intake_history_test'),HISTORY_CURSOR_HMAC_KEY_FILE:temp+'/key',HISTORY_MCP_HOST:'127.0.0.1',HISTORY_MCP_PORT:'38115',HISTORY_MCP_ALLOWED_HOSTS:'127.0.0.1,localhost',HISTORY_MCP_ALLOWED_ORIGINS:'http://127.0.0.1:38115',HISTORY_MCP_MAX_SESSIONS:'4',HISTORY_MCP_SESSION_IDLE_MS:'60000',HISTORY_GAME_CORE_EVENTS_ENABLED:'false'};
 let art,hist,source;let reads=0;
 const rpc=async(subject,data)=>{const m=await nc.request(subject,Buffer.from(JSON.stringify(data)),{timeout:2000});return {headers:m.headers,data:m.data.length?JSON.parse(new TextDecoder().decode(m.data)):{}};};
 try{
  await writeFile(temp+'/key',Buffer.alloc(32,7));
  const am=run(root+'services/artifacts/dist/migrate.js',{...artifactsEnv,ARTIFACTS_DATABASE_URL:url('intake_artifacts_test_owner','brai_intake_artifacts_test'),ARTIFACTS_OWNER_ROLE:'intake_artifacts_test_owner',ARTIFACTS_APP_ROLE:'intake_artifacts_test_app'});
  assert.equal(await am.done,0,am.output());
  const hm=run(root+'services/history/dist/migrate.js',{HISTORY_OWNER_DATABASE_URL:url('intake_history_test_owner','brai_intake_history_test'),HISTORY_OWNER_ROLE:'intake_history_test_owner',HISTORY_APP_ROLE:'intake_history_test_app',HISTORY_WEB_ROLE:'intake_history_test_web'});
  assert.equal(await hm.done,0,hm.output());
  art=run(root+'services/artifacts/dist/main.js',artifactsEnv);hist=run(root+'services/history/dist/main.js',historyEnv);
  await eventually(async()=>{if(art.child.exitCode!==null)throw Error(art.output());const r=await rpc('brai.artifacts.v1.get',{artifactId:randomUUID()});return r.headers?.get('Nats-Service-Error-Code')==='404';});
  await eventually(async()=>{if(hist.child.exitCode!==null)throw Error(hist.output());const r=await rpc('brai.history.v1.query.list',{user_id:'fixture',limit:1});return !r.headers?.get('Nats-Service-Error-Code');});
  source=createServer((req,res)=>{reads++;res.setHeader('content-type','application/octet-stream');res.end('synthetic-file:'+req.url);});source.listen(0,'127.0.0.1');await once(source,'listening');
  const sourceBase='http://127.0.0.1:'+source.address().port;
  const ports=createPorts(nc,new Client({connection,namespace:'intake_test'}),{sources:{telegram:{fileBaseUrl:sourceBase}},ports:{},artifactBaseUrl:'http://127.0.0.1:38114'});
  const packet={id:randomUUID(),ownerId:'fixture',source:'telegram',receivedAt:new Date().toISOString(),completedAt:new Date().toISOString(),scenario:'incoming.v1',original:{data:{materialId:randomUUID(),attachments:Array.from({length:10},(_,n)=>({fileId:'photo'+n,filename:'photo'+n+'.jpg',mimeType:'image/jpeg',caption:n===0?'Подпись':undefined}))}}};
  const files=await ports.prepareFiles(packet);assert.equal(files.length,10);assert.equal(reads,10);
  assert.deepEqual(files.map(x=>x.position),Array.from({length:10},(_,n)=>n));
  assert.equal(files[0].caption,'Подпись');
  assert.deepEqual(await ports.prepareFiles(packet),files);assert.equal(reads,10);
  const ready={...packet,original:{data:{attachments:files.map(x=>({artifactId:x.artifactId,filename:x.filename,mimeType:x.mimeType}))}}};
  assert.equal((await ports.prepareFiles(ready)).length,10);assert.equal(reads,10);
  await assert.rejects(ports.prepareFiles({...ready,ownerId:'foreign'}),{code:'FORBIDDEN_ARTIFACT'});
  await ports.history(packet,'receive');await ports.history(packet,'receive');await ports.history(packet,'complete');
  const recorded=await rpc('brai.history.v1.query.list',{user_id:'fixture',filters:{source:'service_intake',object_type:'intake_packet',object_id:packet.id},limit:100});
  assert.equal(recorded.headers?.get('Nats-Service-Error-Code'),undefined);
  assert.equal(recorded.data.items.length,2);
 }finally{
  source?.close();await art?.stop();await hist?.stop();await nc.close();await connection.close();await rm(temp,{recursive:true,force:true});
 }
});
