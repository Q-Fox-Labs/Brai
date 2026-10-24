// ABOUTME: Устанавливает immutable Codeworks A/B только в изолированный Ansible fixture.
// ABOUTME: Управляет лишь PID собственного launcher; рабочие службы и Temporal server не трогает.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {verifyPackage} from '../../components/package-runtime.mjs';
const [action,input,id]=process.argv.slice(2),c=JSON.parse(fs.readFileSync(input));
const ensure=(v,code)=>{if(!v)throw Error(code);};
ensure(['prepare','start','upgrade','stop'].includes(action)&&new URL(c.databaseURL).pathname==='/brai_codeworks_temporal_test'&&/^codeworks-fixture-/.test(c.taskQueue),'FIXTURE_REQUIRED');
const base=fs.realpathSync(path.dirname(input));ensure(/\/tmp\/codeworks-temporal\/ansible-[a-f0-9-]{36}$/.test(base),'ISOLATED_FIXTURE_ROOT_REQUIRED');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),json=file=>JSON.parse(fs.readFileSync(file));
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value)+'\n',{mode:0o600});
/** Проверяет точные байты, самостоятельный npm closure и наличие native SDK без родительских пакетов. */
function payload(value){const p=fs.realpathSync(value);ensure(p.startsWith('/tmp/codeworks-temporal-artifact-'),'ISOLATED_PAYLOAD_REQUIRED');verifyPackage(p,'codeworks');return p;}
/** Останавливает только свой процесс с совпадающим launcher и private input, сохраняя отдельный Ansible job. */
async function stop(){
  if(!fs.existsSync(base+'/pid.json'))return;
  const pid=json(base+'/pid.json').pid;
  ensure(Number.isSafeInteger(pid)&&pid>1,'FIXTURE_PID_REQUIRED');
  let argv;try{argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0');}catch(error){if(error.code==='ENOENT')return;throw error;}
  ensure(argv[1]===base+'/runtime.mjs'&&argv[2]===input,'FOREIGN_PROCESS_PRESERVED');
  process.kill(pid,'SIGTERM');
  for(let i=0;i<150;i++){try{process.kill(pid,0);}catch{return;}await sleep(100);if(fs.existsSync('/proc/'+pid+'/stat')&&fs.readFileSync('/proc/'+pid+'/stat','utf8').split(' ')[2]==='Z')return;}
  throw Error('FIXTURE_STOP_TIMEOUT');
}
/** Запускает настоящий runtime из поставки вне репозитория; секреты остаются в private input. */
async function start(p){
  const launcher=`import fs from 'node:fs';import{pathToFileURL}from'node:url';const c=JSON.parse(fs.readFileSync(process.argv[2]));for(const[k,v]of Object.entries(c.environment))process.env[k]=v;const p=fs.realpathSync(new URL('./current',import.meta.url));const{startRuntime}=await import(pathToFileURL(p+'/services/codeworks/src/runtime.mjs'));const r=await startRuntime({databaseURL:c.databaseURL,allowedRepositories:c.allowedRepositories});fs.writeFileSync(new URL('./ready',import.meta.url),String(process.pid));process.on('SIGTERM',async()=>{await r.close();process.exit(0)});`;
  fs.writeFileSync(base+'/runtime.mjs',launcher,{mode:0o600});
  const next=base+'/current.new';fs.symlinkSync(p,next);fs.renameSync(next,base+'/current');
  fs.rmSync(base+'/ready',{force:true});
  const log=fs.openSync(base+'/runtime.log','a',0o600);
  const child=spawn(process.execPath,[base+'/runtime.mjs',input],{cwd:p,detached:true,stdio:['ignore',log,log],env:{PATH:process.env.PATH,NODE_PATH:'',NODE_OPTIONS:''}});fs.closeSync(log);child.unref();write(base+'/pid.json',{pid:child.pid,payload:p});
  for(let i=0;i<150;i++){if(fs.existsSync(base+'/ready')){ensure(fs.realpathSync('/proc/'+child.pid+'/cwd')===p,'PAYLOAD_PROCESS_MISMATCH');return;}await sleep(100);}
  throw Error('FIXTURE_START_TIMEOUT');
}
if(action==='prepare'){
  const original=fs.realpathSync(c.original);ensure(original.startsWith(fs.realpathSync(c.source)+'/tmp/component-packages/codeworks-'),'FIXTURE_ARTIFACT_REQUIRED');verifyPackage(original,'codeworks');
  for(const key of ['artifactA','artifactB']){ensure(/^\/tmp\/codeworks-temporal-artifact-[a-f0-9-]{36}-[ab]$/.test(c[key]),'ISOLATED_PAYLOAD_REQUIRED');fs.cpSync(original,c[key],{recursive:true});}
  const bundle='services/codeworks/dist/workflows.js';fs.copyFileSync(c.nextBundle,c.artifactB+'/'+bundle);
  const m=json(c.artifactB+'/artifact-manifest.json'),file=m.files.find(v=>v.path===bundle),bytes=fs.readFileSync(c.artifactB+'/'+bundle);
  file.sha256=createHash('sha256').update(bytes).digest('hex');file.size=bytes.length;file.mode=fs.statSync(c.artifactB+'/'+bundle).mode&0o777;
  m.bytes=m.files.reduce((n,v)=>n+v.size,0);m.payloadHash=createHash('sha256').update(JSON.stringify({files:m.files,runtime:m.runtime,runtimePackages:m.runtimePackages})).digest('hex');
  write(c.artifactB+'/artifact-manifest.json',m);payload(c.artifactA);payload(c.artifactB);
}else if(action==='stop'){await stop();for(const key of ['artifactA','artifactB']){if(fs.existsSync(c[key])){ensure(/^\/tmp\/codeworks-temporal-artifact-[a-f0-9-]{36}-[ab]$/.test(c[key]),'ISOLATED_PAYLOAD_REQUIRED');fs.rmSync(c[key],{recursive:true});}}}
else if(action==='start')await start(payload(c.artifactA));
else{
  ensure(/^[0-9a-f-]{36}$/.test(id),'OPERATION_REQUIRED');
  const db=new Pool({connectionString:c.databaseURL,max:1});
  try{
    const d=(await db.query("SELECT d.* FROM codeworks.deployments d JOIN codeworks.operations o ON o.id=d.operation_id WHERE d.operation_id=$1 AND o.kind='rollout' AND NOT o.archived",[id])).rows[0];
    const p=payload(c.artifactB),manifest=json(p+'/artifact-manifest.json');
    ensure(d&&d.project_id===c.projectId&&d.target==='dev'&&d.composition.components[0].artifact.digest==='sha256:'+manifest.payloadHash,'ADMITTED_FIXTURE_ROLLOUT_REQUIRED');
    const operation=base+'/'+id;fs.mkdirSync(operation,{recursive:true});
    if(fs.existsSync(operation+'/result.json'))process.exit(0);
    fs.writeFileSync(operation+'/installation.json',JSON.stringify({operation_id:id,ansible_pid:process.ppid}),{flag:'wx',mode:0o600});
    await sleep(1200);await stop();await start(p);
    const receipt={operation_id:id,project_id:d.project_id,target:d.target,commit_sha:d.commit_sha,composition_digest:d.composition_digest,composition:d.composition,verified:true,evidence_url:'https://fixture.invalid/ansible/'+id};
    write(operation+'/result.json',{status:'succeeded',receipt});
  }finally{await db.end();}
}
