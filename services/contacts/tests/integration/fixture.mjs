// ABOUTME: Запускает настоящий процесс Контактов только в disposable стенде.
// ABOUTME: Использует отдельные БД/роли и ограниченные NATS identities.
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {connect} from 'nats';
import {Pool} from 'pg';
export const root=fileURLToPath(new URL('../../../../',import.meta.url));
export const enabled=process.env.INTAKE_TEST_DISPOSABLE==='1';
export const url=role=>'postgresql://'+role+':intake-test@127.0.0.1:25643/brai_contacts_test';
/** Запускает только явно названный entrypoint worktree. */
export function run(script,env){const child=spawn(process.execPath,[root+script],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let output='';for(const p of [child.stdout,child.stderr])p.on('data',b=>{output=(output+b).slice(-4000);});const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});return {child,done,output:()=>output,async stop(){if(child.exitCode!==null)return;child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),6000);try{await done;}finally{clearTimeout(timer);}}};}
/** Ожидает проверяемое условие в ограниченное время. */
export async function eventually(fn,ms=15000){let last;const end=Date.now()+ms;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await new Promise(r=>setTimeout(r,30));}throw last??Error('CONDITION_TIMEOUT');}
/** Создаёт валидный независимый запрос наблюдения. */
export function observation(extra={}){return {operationId:randomUUID(),packetId:randomUUID(),ownerId:'fixture',sourceId:'telegram',identity:{namespace:'telegram',externalId:'456'},observedAt:new Date().toISOString(),profile:{name:'Alice'},...extra};}
/** Поднимает standalone Contacts с ограниченными полномочиями, без Temporal. */
export async function startContacts(){
 if(!enabled)throw Error('DISPOSABLE_REQUIRED');
 const temp=await mkdtemp(root+'tmp/contacts-test-'),clients=[];
 const owner=new Pool({connectionString:url('contacts_test_owner'),max:2}),app=new Pool({connectionString:url('contacts_test'),max:4});
 let process;
 try{
 const migrate=()=>run('services/contacts/dist/migrate.js',{CONTACTS_OWNER_DATABASE_URL:url('contacts_test_owner'),CONTACTS_RUNTIME_ROLE:'contacts_test'});
 const m=migrate();if(await m.done!==0)throw Error(m.output());
 await owner.query('TRUNCATE contacts.contact_operations,contacts.contact_identities,contacts.contacts');
 const callers={admin_test:{ownerIds:['fixture','foreign'],sourceIds:['telegram','telegram_other'],operations:['resolve','profile.observe','contacts.get','contacts.list','operations.get']},intake_test:{ownerIds:['fixture'],sourceIds:['telegram'],operations:['resolve']},reader_test:{ownerIds:['fixture'],sourceIds:[],operations:['contacts.get','contacts.list']}};
 await writeFile(temp+'/key',Buffer.alloc(32,17),{mode:0o600});
 await writeFile(temp+'/nats.json',JSON.stringify({user:'contacts',pass:'intake-test',inboxPrefix:'_INBOX.contacts'}),{mode:0o600});
 const config={databaseUrl:url('contacts_test'),natsUrl:'nats://127.0.0.1:24343',natsOptionsFile:temp+'/nats.json',cursorKeyFile:temp+'/key',callers};
 await writeFile(temp+'/runtime.json',JSON.stringify(config),{mode:0o600});
 const client=async name=>{const c=await connect({servers:config.natsUrl,user:'contacts_'+name,pass:'intake-test',inboxPrefix:'_INBOX.contacts_'+name});clients.push(c);return c;};
 const admin=await client('admin'),reader=await client('reader');
 const rpc=async(op,q={},nc=admin,caller='admin_test')=>{const m=await nc.request('brai.contacts.v1.'+op+(op==='status'?'':'.'+caller),Buffer.from(JSON.stringify(q)),{timeout:8000});const v=JSON.parse(new TextDecoder().decode(m.data));if(m.headers?.get('Nats-Service-Error-Code'))throw Object.assign(Error(v.code),v,{status:Number(m.headers.get('Nats-Service-Error-Code'))});return v;};
 process=run('services/contacts/dist/main.js',{CONTACTS_CONFIG:temp+'/runtime.json'});await eventually(async()=>(await rpc('status')).ready);
 return {owner,app,admin,reader,rpc,migrate,temp,pid:()=>process.child.pid,
 async restart(databaseUrl=url('contacts_test')){await process.stop();await writeFile(temp+'/runtime.json',JSON.stringify({...config,databaseUrl}),{mode:0o600});process=run('services/contacts/dist/main.js',{CONTACTS_CONFIG:temp+'/runtime.json'});await eventually(async()=>{await rpc('status');return true;});},
 async close(){await process.stop();await Promise.all(clients.map(c=>c.close()));await app.end();await owner.end();await rm(temp,{recursive:true,force:true});}};
 }catch(e){await process?.stop();await Promise.all(clients.map(c=>c.close()));await owner.end();await app.end();await rm(temp,{recursive:true,force:true});throw e;}
}
