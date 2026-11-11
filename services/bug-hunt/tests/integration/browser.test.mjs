// ABOUTME: Открывает реальный Web и сервисы в одноразовом контуре для браузерной приёмки.
// ABOUTME: Запускается только явным тестом; останавливается собственным marker и закрывает дочерний Web.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {writeFile,rm,chmod} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {startFixture,fixture} from './fixture.mjs';
import {stopChildGroup} from '../process-group.mjs';
const enabled=existsSync(new URL('../../../../tmp/bug-hunt-browser.enable',import.meta.url));
test('explicit isolated browser acceptance',{skip:!enabled,timeout:46*60*1000},async()=>{
 const qualityRun=process.env.BRAI_BUG_HUNT_BROWSER_QUALITY_RUN??fixture.browserQualityRun;
 if(qualityRun&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(qualityRun))throw new Error('Invalid synthetic quality run');
 const options=qualityRun?{installationId:'bug-hunt-quality-'+qualityRun,userId:'synthetic-quality-'+qualityRun,profileId:'quality-profile-'+qualityRun,telegramId:String(120030000+parseInt(qualityRun.slice(0,7),16)),role:'admin',browserAsReporter:true}:{};
 const f=await startFixture(options),root=fileURLToPath(new URL('../../../../',import.meta.url));
 const stop=join(root,'tmp','bug-hunt-browser-'+f.fixture.run+'.stop'),live=join(root,'tmp','bug-hunt-live.json');
 let tail='',child;
 const keep=chunk=>{tail=(tail+String(chunk)).slice(-4000);};
 try{
  const env={...process.env,CI:'1',BRAI_WEB_STANDALONE_OUTPUT:'0',NEXT_TELEMETRY_DISABLED:'1',NODE_ENV:'production',WEB_ORIGIN:f.fixture.origin,WEB_IDENTITY_MODE:'telegram',WEB_AGENT_MODE:'hermes_telegram',NATS_URL:f.fixture.natsURL,NATS_USER:'web',NATS_PASSWORD:'fixture-web',NATS_INBOX_PREFIX:'_INBOX.web'};
  const port=new URL(f.fixture.origin).port;
  child=spawn('npm',['run','start','--workspace=@brai/web','--','--hostname','127.0.0.1','--port',port],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',keep);child.stderr.on('data',keep);
  let ready=false;
  for(let i=0;i<100;i++){
   if(child.exitCode!==null)throw new Error('Web startup failed: '+tail);
   try{const response=await fetch(f.fixture.origin+'/auth',{signal:AbortSignal.timeout(1000)});if(response.status===200){ready=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,250));
  }
  assert.equal(ready,true,'Web listener must be ready');
  let checkedCaseIds=[],seedCaseIds=[];
  const context={kind:'web',headers:{cookie:qualityRun?f.cookie:f.adminCookie,origin:f.fixture.origin}};
  const web=(operation,input)=>f.call('brai.bug_hunt.v1.'+operation,{context,input});
  if(qualityRun){
   let cursor;
   do{const page=await web('list',{limit:50,...(cursor?{cursor}:{})});checkedCaseIds.push(...page.items.filter(item=>!/^Приёмка \d+: ошибка открытия$/.test(item.title)).map(item=>item.id));cursor=page.next_cursor;}while(cursor);
   for(let i=1;i<=53;i++){
    const receipt=await web('report',{request_id:'browser-'+f.fixture.run+'-'+i,observation:{title:'Приёмка '+i+': ошибка открытия',operation:'Открыть сохранённое обращение',expected:'Карточка открывается',observed:'<script>window.bugHuntInjection=true</script>\nОтображается ошибка.',component_id:'web',component_version:'fixture-v2',diagnostic_text:'Приёмка: синтетическая диагностика.'}});
    seedCaseIds.push(receipt.case_id);
   }
   while(await f.runtime.systemStore.reconcileLocal(50)){}
   const first=await f.call('brai.bug_hunt.v2.enrichment',{context,input:{case_id:seedCaseIds[0]}});
   const last=await f.call('brai.bug_hunt.v2.enrichment',{context,input:{case_id:seedCaseIds[52]}});
   assert.ok(first.local.group_id);assert.equal(last.local.group_id,first.local.group_id);
   const group=await f.call('brai.bug_hunt.v2.groups-get',{context,input:{group_id:first.local.group_id,limit:1}});
   assert.ok(group.group.member_count>=53);
  }else{
   await web('report',{request_id:'browser-'+f.fixture.run,observation:{title:'Ошибка открытия карточки',operation:'Открыть сохранённое обращение',expected:'Карточка открывается',observed:'<script>window.bugHuntInjection=true</script>\nОтображается ошибка.',component_id:'web',diagnostic_text:'Synthetic diagnostic: no tokens or user data.'}});
  }
  const foreign=await f.call('brai.bug_hunt.v1.report',{context:{kind:'web',headers:{cookie:f.adminCookie,origin:f.fixture.origin}},input:{request_id:'browser-foreign-'+f.fixture.run,observation:{title:'Чужая синтетическая карточка',operation:'Открыть карточку',expected:'Карточка',observed:'Ошибка',component_id:'web',component_version:'fixture-foreign-v2'}}});
  await f.runtime.systemStore.indexReport(foreign.report_id);
  const code=await f.browserCode();
  await writeFile(live,JSON.stringify({mcpURL:f.runtime.mcp.url,token:f.token,userId:f.user.id,origin:f.fixture.origin,code,stop,run:f.fixture.run,foreignCaseId:foreign.case_id,...(qualityRun?{qualityRun,checkedCaseIds,seedCaseIds}:{})}),{mode:0o600});await chmod(live,0o600);
  console.log('BUG_HUNT_BROWSER_READY '+JSON.stringify({origin:f.fixture.origin,code,stop}));
  const until=Date.now()+45*60*1000;
  while(!existsSync(stop)&&Date.now()<until){if(child.exitCode!==null)throw new Error('Web exited: '+tail);await new Promise(r=>setTimeout(r,500));}
  assert.equal(existsSync(stop),true,'Explicit browser stop marker required before timeout');
 }finally{
  try{await stopChildGroup(child);}
  finally{try{await f.close();}finally{await rm(live,{force:true});await rm(stop,{force:true});}}
 }
});
