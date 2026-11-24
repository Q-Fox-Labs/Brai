// ABOUTME: Готовит техническое подключение существующего пользователя Better Auth.
// ABOUTME: Создаёт только DB-login и закрытые runtime inputs, не создаёт аккаунтов Auth.
import {Pool} from 'pg';
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {migrate} from './migrate.js';
import {migrateIsolation,bindOwner} from './isolation.js';
const quote=(v:string)=>'"'+v.replaceAll('"','""')+'"';
const secret=()=>randomBytes(32).toString('base64url');
/** Записывает закрытый файл атомарно, без раскрытия секрета в stdout. */
function save(path:string,value:unknown){const temp=path+'.new';writeFileSync(temp,JSON.stringify(value),{mode:0o600});renameSync(temp,path);}
try{
 let raw='';for await(const chunk of process.stdin)raw+=chunk;
 const {operatorFile,account,directory,stateDirectory,provider,payload,providerPayload=payload,uid}=JSON.parse(raw);
 const op=JSON.parse(readFileSync(operatorFile,'utf8'));
 const auth=new Pool({connectionString:op.authDatabaseURL,max:1});
 const admin=new Pool({connectionString:op.dialoguesAdminDatabaseURL,max:1});
 const owner=new Pool({connectionString:op.dialoguesOwnerDatabaseURL,max:1});
 try{
  const identity=(await auth.query('SELECT i.user_id,i.profile_id FROM brai_identity i JOIN "user" u ON u.id=i.user_id WHERE i.user_id=$1',[account.user_id])).rows[0];
  if(!identity||identity.profile_id!==account.profile_id)throw new Error('EXISTING_AUTH_USER_REQUIRED');
  mkdirSync(stateDirectory,{recursive:true,mode:0o700});
  const path=stateDirectory+'/connection.json';
  const id=createHash('sha256').update(account.user_id).digest('hex');
  let state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;
  // AIDEV-NOTE: Не меняем пароль существующего login и не переписываем owner_id истории.
  const hasBindings=(await owner.query("SELECT to_regclass('dialogues_access.sys_owner_bindings') AS name")).rows[0].name;
  const previous=hasBindings?(await owner.query('SELECT login_role,owner_id,profile_id FROM dialogues_access.sys_owner_bindings WHERE user_id=$1',[account.user_id])).rows[0]:undefined;
  if(previous&&!state){
   if(!account.connection_file)throw new Error('EXISTING_CONNECTION_IMPORT_REQUIRED');
   state=JSON.parse(readFileSync(account.connection_file,'utf8'));
  }
  if(!state){state={userId:account.user_id,profileId:account.profile_id,ownerId:account.owner_id??account.user_id,login:'brai_dlg_'+id.slice(0,32),password:secret(),token:secret(),cursor:secret(),natsPassword:secret()};save(path,state);}
  if(state.userId!==account.user_id||state.profileId!==account.profile_id||previous&&(previous.login_role!==state.login||previous.owner_id!==state.ownerId||previous.profile_id!==state.profileId))throw new Error('CONNECTION_CONFLICT');
  if(!state.natsPassword)state.natsPassword=secret();
  if(!existsSync(path))save(path,state);
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(state.login))throw new Error('INVALID_LOGIN');
  const role=(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[state.login])).rowCount;
  if(!role)await admin.query('CREATE ROLE '+quote(state.login)+" LOGIN PASSWORD '"+state.password.replaceAll("'","''")+"' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION");
  const database=new URL(op.dialoguesOwnerDatabaseURL).pathname.slice(1);
  await admin.query('GRANT CONNECT ON DATABASE '+quote(database)+' TO '+quote(state.login));
  if(!previous)await migrate(owner,op.dialoguesOwnerRole,state.login);
  // AIDEV-NOTE: Старые привязки тоже получают добавочные таблицы и права до запуска нового runtime.
  if(!previous||!(await owner.query('SELECT 1 FROM dialogues_live.migrations WHERE version=7')).rowCount)
   await migrateIsolation(owner,op.dialoguesOwnerRole);
  await bindOwner(owner,op.dialoguesOwnerRole,state.login,{userId:state.userId,profileId:state.profileId,ownerId:state.ownerId});
  const databaseURL=new URL(op.dialoguesRuntimeDatabaseURL??op.dialoguesOwnerDatabaseURL);databaseURL.username=state.login;databaseURL.password=state.password;
  const check=new Pool({connectionString:databaseURL.href,max:1});try{await check.query('SELECT 1');}finally{await check.end();}
  const subject='brai.auth.v2.dialogues-access.'+id,inbox='_INBOX.dialogues.'+id;
  const socket='/run/'+account.unit+'-credential/credentials.sock';
  const helper=providerPayload+'/services/providers/codex-auth/helper.py';
  save(account.credential_config,{version:1,socket,stateRoot:account.credential_state,peerUid:uid,provider});
  save(directory+'/launch.json',{credentialConfig:account.credential_config,helperProgram:{path:helper,sha256:createHash('sha256').update(readFileSync(helper)).digest('hex')}});
  save(directory+'/subscription.json',{binary:provider.codex,node:provider.node,python:provider.python,credentialClient:providerPayload+'/services/providers/codex-auth/client.py',credentialSocket:socket,sourceRef:provider.providerSourceReceipt.sha256,home:account.home,cwd:account.home,catalogPath:account.home+'/models.json'});
  save(directory+'/nats.json',{user:state.login,pass:state.natsPassword});
  writeFileSync(directory+'/token',state.token,{mode:0o600});writeFileSync(directory+'/cursor',state.cursor,{mode:0o600});
  if(state.operatorToken)writeFileSync(directory+'/operator-token',state.operatorToken,{mode:0o600});
  const env={...(state.operatorToken?{DIALOGUES_OPERATOR_TOKEN_FILE:directory+'/operator-token'}:{}),DIALOGUES_DATABASE_URL:databaseURL.href,DIALOGUES_MCP_TOKEN_FILE:directory+'/token',DIALOGUES_CURSOR_KEY_FILE:directory+'/cursor',DIALOGUES_MCP_PORT:String(account.port),DIALOGUES_MCP_HOST:'127.0.0.1',DIALOGUES_MCP_ALLOWED_HOSTS:'127.0.0.1:'+account.port+',localhost:'+account.port,DIALOGUES_MCP_ALLOWED_ORIGINS:'http://127.0.0.1',DIALOGUES_MCP_USER_ID:state.userId,DIALOGUES_MCP_PROFILE_ID:state.profileId,DIALOGUES_MCP_OWNER_ID:state.ownerId,DIALOGUES_AUTH_SUBJECT:subject,DIALOGUES_NATS_CREDS_FILE:directory+'/nats.json',DIALOGUES_NATS_SERVERS:op.natsServers.join(','),DIALOGUES_NATS_INBOX_PREFIX:inbox,DIALOGUES_SUBSCRIPTION_CONFIG_FILE:directory+'/subscription.json',DIALOGUES_SUMMARY_ENABLED:'true',...(op.natsCAFile?{DIALOGUES_NATS_CA_FILE:op.natsCAFile}:{})};
  writeFileSync(directory+'/runtime.env',Object.entries(env).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600});
  save(directory+'/endpoint.json',{enabled:true,url:'http://127.0.0.1:'+account.port+'/mcp',userId:state.userId,profileId:state.profileId,token:state.token});
  save(directory+'/admission.json',{binding:{subject,userId:state.userId,profileId:state.profileId},nats:{user:state.login,password:state.natsPassword,permissions:{publish:{allow:[subject]},subscribe:{allow:[inbox+'.>']}}}});
 }finally{await Promise.all([auth.end(),admin.end(),owner.end()]);}
 process.stdout.write('{"ok":true}\n');
}catch{console.error('DIALOGUES_PROVISION_FAILED');process.exitCode=1;}
