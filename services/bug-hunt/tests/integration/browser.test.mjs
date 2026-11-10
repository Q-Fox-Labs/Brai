// ABOUTME: Открывает реальный Web и сервисы в одноразовом контуре для браузерной приёмки.
// ABOUTME: Запускается только явным тестом; останавливается собственным marker и закрывает дочерний Web.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {startFixture} from './fixture.mjs';
import {stopChildGroup} from '../process-group.mjs';
const enabled=existsSync(new URL('../../../../tmp/bug-hunt-browser.enable',import.meta.url));
test('explicit isolated browser acceptance',{skip:!enabled,timeout:25*60*1000},async()=>{
 const f=await startFixture(),root=fileURLToPath(new URL('../../../../',import.meta.url));
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
  await f.call('brai.bug_hunt.v1.report',{context:{kind:'web',headers:{cookie:f.adminCookie,origin:f.fixture.origin}},input:{request_id:'browser-'+f.fixture.run,observation:{title:'Ошибка открытия карточки',operation:'Открыть сохранённое обращение',expected:'Карточка открывается',observed:'<script>window.bugHuntInjection=true</script>\nОтображается ошибка.',component_id:'web',diagnostic_text:'Synthetic diagnostic: no tokens or user data.'}}});
  const code=await f.browserCode();
  await writeFile(live,JSON.stringify({mcpURL:f.runtime.mcp.url,token:f.token,userId:f.user.id,origin:f.fixture.origin,code,stop,run:f.fixture.run}),{mode:0o600});
  console.log('BUG_HUNT_BROWSER_READY '+JSON.stringify({origin:f.fixture.origin,code,stop}));
  const until=Date.now()+20*60*1000;
  while(!existsSync(stop)&&Date.now()<until){if(child.exitCode!==null)throw new Error('Web exited: '+tail);await new Promise(r=>setTimeout(r,500));}
  assert.equal(existsSync(stop),true,'Explicit browser stop marker required before timeout');
 }finally{
  try{await stopChildGroup(child);}
  finally{try{await f.close();}finally{await rm(live,{force:true});await rm(stop,{force:true});}}
 }
});
