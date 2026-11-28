// ABOUTME: Готовит персональный MCP для Welcome по постоянной привязке Auth.
// ABOUTME: Использует тот же live store, отдельный PostgreSQL LOGIN и проверки RLS.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {Pool} from 'pg';
import {createStore} from './store.js';
import {bindOwner,verifyOwnerConnection} from './isolation.js';
import {startMcp} from './mcp.js';

type Identity={id:string;profileId:string;role:string;status:string};
type Binding={userId:string;profileId:string};
type Dependency={owner:Pool;administrator:Pool;ownerRole:string;databaseURL:string;
 authorize:(userId:string)=>Promise<Identity|null>; secret:string; grantToken:string; publicOrigin:string};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const allowed=(user:Identity|null,binding:Binding)=>user?.id===binding.userId&&user.profileId===binding.profileId&&
 (user.role==='welcome'&&user.status==='provisioning'||
 ['guest','user','admin','creator'].includes(user.role)&&['provisioning','active'].includes(user.status));

function matches(header:string|undefined, token:string) {
 const text=Buffer.from(header??'');
 const expected=Buffer.from('Bearer '+token);
 return text.length===expected.length&&timingSafeEqual(text,expected);
}

/** Открывает персональный MCP по закрытой операторской выдаче и точной паре Auth. */
export function welcomeOwner(dependency:Dependency) {
 const handles=new Map<string,Promise<Awaited<ReturnType<typeof open>>>>();
 const key=(purpose:string, binding:Binding)=>createHmac('sha256',dependency.secret).update(JSON.stringify([purpose,binding.userId,binding.profileId])).digest('base64url');
 const publicOrigin=new URL(dependency.publicOrigin).origin;
 if(dependency.secret.length<32||dependency.grantToken.length<32||dependency.secret===dependency.grantToken||!publicOrigin.startsWith('http')||!publicOrigin.includes('://')) throw Error('WELCOME_DIALOGUES_CONFIG');

 async function open(binding:Binding) {
  const user=await dependency.authorize(binding.userId);
  if(!allowed(user,binding)) throw Error('PERSONAL_AUTH_DENIED');
  const login='brai_welcome_'+createHash('sha256').update(binding.userId).digest('hex').slice(0,32);
  const credentials=key('postgres',binding);
  const applied=await dependency.administrator.connect();
  try{
   await applied.query('BEGIN');
   await applied.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['welcome-dialogues:'+binding.userId]);
   const prior=(await dependency.owner.query("SELECT login_role,owner_id,profile_id FROM dialogues_access.sys_owner_bindings WHERE user_id=$1",[binding.userId])).rows[0];
   if(prior&&(prior.login_role!==login||prior.owner_id!==binding.userId||prior.profile_id!==binding.profileId)) throw Error('WELCOME_DIALOGUES_BINDING_CONFLICT');
   if(!prior&&user?.role!=='welcome') throw Error('PERSONAL_AUTH_DENIED');
   const role=await applied.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[login]);
   if(!role.rowCount)await applied.query("CREATE ROLE "+quote(login)+" LOGIN PASSWORD '"+credentials+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT");
   await applied.query('GRANT CONNECT ON DATABASE '+quote(decodeURIComponent(new URL(dependency.databaseURL).pathname.slice(1)))+' TO '+quote(login));
   await applied.query('COMMIT');
  }catch(error){await applied.query('ROLLBACK').catch(()=>{});throw error;}finally{applied.release();}
  const owner={...binding,ownerId:binding.userId};
  await bindOwner(dependency.owner,dependency.ownerRole,login,owner);
  const address=new URL(dependency.databaseURL);
  address.username=login;address.password=credentials;
  const pool=new Pool({connectionString:address.href,max:2,idleTimeoutMillis:10_000,connectionTimeoutMillis:3000,statement_timeout:10_000});
  pool.on('error',()=>{});
  try{
   await verifyOwnerConnection(pool,owner);
   const token=key('mcp',binding);
   const config={host:'127.0.0.1',port:0,owner:owner.ownerId,hosts:['127.0.0.1'],origins:[publicOrigin],token,
    personal:{...owner,authorize:async()=>{
     if(!allowed(await dependency.authorize(binding.userId),binding)) throw Error('PERSONAL_AUTH_DENIED');
     const row=(await pool.query('SELECT * FROM dialogues_access.current_binding()')).rows[0];
     if(row?.user_id!==binding.userId||row?.owner_id!==owner.ownerId||row?.profile_id!==binding.profileId)
      throw Error('PERSONAL_AUTH_DENIED');
    }}};
   const listener=await startMcp(createStore(pool,key('cursor',binding)),config);
   config.hosts.push(new URL(listener.url).host);
   return {token,url:listener.url,close:async()=>{await listener.close();await pool.end();}};
  }catch(error){await pool.end();throw error;}
 }
 function get(binding:Binding) {
  let active=handles.get(binding.userId);
  if(!active){
   active=open(binding).catch(error=>{handles.delete(binding.userId);throw error;});
   handles.set(binding.userId,active);
  }
  return active;
 }
 const server=createServer(async(req,res)=>{
  try{
   if(req.method==='POST'&&(req.url==='/endpoint'||req.url==='/existing-endpoint')){
    if(!matches(req.headers.authorization,dependency.grantToken)){res.writeHead(401).end();return;}
    const raw=[] as Buffer[];let bytes=0;
    for await (const block of req){bytes+=block.length;if(bytes>512){res.writeHead(413).end();return;}raw.push(block);}
    const value=JSON.parse(Buffer.concat(raw).toString()) as Binding;
    if(!uuid.test(value?.userId)||!uuid.test(value?.profileId)){res.writeHead(400).end();return;}
    const url=publicOrigin+'/mcp/'+value.userId;
    if(req.url==='/existing-endpoint'){
     const mapped=await dependency.owner.query(
      "SELECT 1 FROM dialogues_access.sys_owner_bindings WHERE user_id=$1 AND profile_id=$2 AND starts_with(login_role,'brai_welcome_') AND enabled",
      [value.userId,value.profileId]);
     if(!mapped.rowCount){res.writeHead(404).end();return;}
     const identity=await dependency.authorize(value.userId);
     if(identity?.id!==value.userId||identity.profileId!==value.profileId){res.writeHead(403).end();return;}
     res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'})
      .end(JSON.stringify({...value,url,token:key('mcp',value)}));
     return;
    }
    if(!allowed(await dependency.authorize(value.userId),value)){res.writeHead(403).end();return;}
    const endpoint=await get(value);
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({...value,url,token:endpoint.token}));
    return;
   }
   const userId=req.url?.startsWith('/mcp/')?req.url.slice(5):'';
   const profileId=req.headers['x-brai-profile-id'];
   if(!uuid.test(userId)||req.headers['x-brai-user-id']!==userId||typeof profileId!=='string'||!uuid.test(profileId)){
    res.writeHead(404).end();return;
   }
   const binding={userId,profileId};
   if(!matches(req.headers.authorization,key('mcp',binding))){res.writeHead(401).end();return;}
   const endpoint=await get(binding);
   const headers:Record<string,string>={authorization:'Bearer '+endpoint.token,'x-brai-user-id':userId,'x-brai-profile-id':profileId};
   for (const field of ['accept','content-type','mcp-session-id','mcp-protocol-version','last-event-id']){
    const value=req.headers[field];if(typeof value==='string')headers[field]=value;
   }
   const signal=new AbortController();
   res.once('close',()=>signal.abort());
   const init:RequestInit&{duplex?:'half'}={method:req.method,headers,signal:signal.signal};
   if(req.method==='POST'){init.body=Readable.toWeb(req) as ReadableStream;init.duplex='half';}
   const reply=await fetch(endpoint.url,init);
   res.writeHead(reply.status,Object.fromEntries([...reply.headers].filter(([name])=>name!=='transfer-encoding')));
   if(reply.body)Readable.fromWeb(reply.body as import('node:stream/web').ReadableStream).on('error',()=>res.destroy()).pipe(res);
   else res.end();
  }catch(error){
   if(!res.headersSent)res.writeHead(error instanceof Error&&error.message==='PERSONAL_AUTH_DENIED'?403:503);
   res.end();
  }
 });
 return {server,async close(){
  server.closeAllConnections();
  await new Promise<void>(done=>server.close(()=>done()));
  await Promise.allSettled([...handles.values()].map(async item=>(await item).close()));
 }};
}
