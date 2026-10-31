// ABOUTME: Реализует ограниченный транзакционный PostgreSQL порт Каналов.
// ABOUTME: SQL и блокировки локализованы здесь; слот не освобождается до rollback/COMMIT.
import type {Pool,PoolClient} from 'pg';
import {Fault,type Store,type Repository,type Data,type Entity,type Context} from './types.js';
function repository(c:PoolClient,context:Context):Repository {
 const q=async(sql:string,values:any[]=[])=>{
  const remaining=Math.floor(context.deadline-performance.now());if(remaining<=0)throw new Fault('NOT_READY');
  await c.query("SELECT set_config('statement_timeout',$1,true)",[String(remaining)]);
  if(performance.now()>=context.deadline)throw new Fault('NOT_READY');
  return c.query(sql,values);
 };
 const identities={connection:'channel_connections',channel:'channels'},versions={connection:'channel_connection_versions',channel:'channel_versions'};
 const idColumn={connection:'connection_id',channel:'channel_id'};
 const identity=async(kind:'connection'|'channel',id:string,lock?:'read'|'write')=>{
  const r=await q('SELECT body,current_version FROM channels.'+identities[kind]+' WHERE id=$1'+(lock==='read'?' FOR SHARE':lock==='write'?' FOR UPDATE':''),[id]);
  return r.rows[0]?{...r.rows[0].body,currentVersion:r.rows[0].current_version}:null;
 };
 return {
  async lockKey(key){await q('SELECT pg_advisory_xact_lock(hashtextextended($1,816325))',[key]);},
  async now(previous){return (await q(`SELECT to_char(GREATEST(clock_timestamp(),COALESCE($1::timestamptz+interval '1 microsecond','-infinity'::timestamptz)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`,[previous??null])).rows[0].time;},
  async timestamp(value){return (await q(`SELECT to_char($1::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`,[value])).rows[0].time;},
  async ready(){for(const table of ['sys_channel_types','channel_connections','channel_connection_versions','channels','channel_versions','channel_resolutions','channel_operation_receipts'])await q('SELECT 1 FROM channels.'+table+' LIMIT 0');},
  async profile(type={code:'telegram',version:1}){const r=(await q('SELECT descriptor,name FROM channels.sys_channel_types WHERE code=$1 AND version=$2',[type.code,type.version])).rows[0];return r?{...r.descriptor,name:r.name}:null;},
  connection:(id,lock)=>identity('connection',id,lock),
  channel:(id,lock)=>identity('channel',id,lock),
  async connectionBySource(source){const r=(await q('SELECT id FROM channels.channel_connections WHERE source_id=$1',[source])).rows[0];return r?identity('connection',r.id,'read'):null;},
  async channelByAddress(connectionId,address){
   const rows=(await q('SELECT id FROM channels.channels WHERE connection_id=$1 AND chat_id=$2 AND thread_id IS NOT DISTINCT FROM $3',[connectionId,address.chatId,address.threadId])).rows;
   if(rows.length>1)throw new Fault('AMBIGUOUS_CHANNEL');return rows[0]?identity('channel',rows[0].id,'read'):null;
  },
  async version(kind,id,version,asOf){
   const values:any[]=[id];let where='';
   if(version!==undefined){values.push(version);where=' AND version=$2';}
   if(asOf!==undefined){values.push(asOf);where=' AND effective_at<=$2::timestamptz';}
   return (await q('SELECT body FROM channels.'+versions[kind]+' WHERE '+idColumn[kind]+'=$1'+where+' ORDER BY version DESC LIMIT 1',values)).rows[0]?.body??null;
  },
  async insertIdentity(kind,e){
   if(kind==='connection')await q('INSERT INTO channels.channel_connections(id,owner_id,type_code,type_version,source_id,bot_id,current_version,body) VALUES($1,$2,$3,$4,$5,$6,1,$7)',[e.id,e.ownerId,e.type.code,e.type.version,e.sourceId,e.botId,e]);
   else await q('INSERT INTO channels.channels(id,owner_id,connection_id,kind,chat_id,thread_id,parent_id,current_version,body) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)',[e.id,e.ownerId,e.connectionId,e.kind,e.address.chatId,e.address.threadId,e.parentId,e]);
  },
  async insertVersion(kind,e,v){
   await q('INSERT INTO channels.'+versions[kind]+'('+idColumn[kind]+',version,effective_at,actor_id,reason,body) VALUES($1,$2,$3,$4,$5,$6)',[e.id,v.value.version,v.value.effectiveFrom,v.actorId,v.reason,v.value]);
   await q('UPDATE channels.'+identities[kind]+' SET current_version=$2 WHERE id=$1',[e.id,v.value.version]);
  },
  async receipt(caller,owner,id){return (await q('SELECT body FROM channels.channel_operation_receipts WHERE caller_id=$1 AND owner_id=$2 AND request_id=$3',[caller,owner,id])).rows[0]?.body??null;},
  async saveReceipt(caller,r){await q('INSERT INTO channels.channel_operation_receipts(caller_id,owner_id,request_id,input_hash,body) VALUES($1,$2,$3,$4,$5)',[caller,r.ownerId,r.requestId,r.inputHash,r]);},
  async resolution(caller,owner,id){return (await q('SELECT input_hash AS hash,input,result FROM channels.channel_resolutions WHERE caller_id=$1 AND owner_id=$2 AND operation_id=$3',[caller,owner,id])).rows[0]??null;},
  async resolutionById(id){return (await q('SELECT input_hash AS hash,input,result FROM channels.channel_resolutions WHERE id=$1',[id])).rows[0]??null;},
  async saveResolution(caller,input,hash,result){await q('INSERT INTO channels.channel_resolutions(id,caller_id,owner_id,operation_id,input_hash,input,result) VALUES($1,$2,$3,$4,$5,$6,$7)',[result.resolutionId,caller,input.ownerId,input.operationId,hash,input,result]);},
  async list(kind,owner,allowed,after,limit,filter){
   if(kind==='profile')return (await q("SELECT descriptor||jsonb_build_object('name',name) AS body FROM channels.sys_channel_types WHERE code||'/'||version>$1 ORDER BY code||'/'||version LIMIT $2",[after??'',limit])).rows.map(r=>r.body);
   const name=kind==='connection'?'channel_connections':'channels',ver=kind==='connection'?'channel_connection_versions':'channel_versions',col=kind==='connection'?'connection_id':'channel_id';
   return (await q('SELECT v.body FROM channels.'+name+' i JOIN channels.'+ver+' v ON v.'+col+'=i.id AND v.version=i.current_version WHERE i.owner_id=$1 AND ($2::uuid IS NULL OR i.id>$2::uuid) AND ($3::uuid[] IS NULL OR '+(kind==='connection'?'i.id':'i.connection_id')+'=ANY($3::uuid[]))'+(kind==='channel'?' AND ($5::uuid IS NULL OR i.connection_id=$5::uuid)':'')+' ORDER BY i.id LIMIT $4',[owner,after,allowed,limit,...(kind==='channel'?[filter??null]:[])])).rows.map(r=>r.body);
  }
 };
}
/** Пул принадлежит программе; доменные ошибки сохраняются, ошибки PostgreSQL безопасны. */
export function createStore(pool:Pool):Store {
 return {async transaction<T>(context:Context,work:(r:Repository)=>Promise<T>):Promise<T>{
  let c:PoolClient|undefined,begun=false;
  try{
   c=await pool.connect();if(performance.now()>=context.deadline)throw new Fault('NOT_READY');
   await c.query('BEGIN');begun=true;
   const value=await work(repository(c,context));
   if(performance.now()>=context.deadline)throw new Fault('NOT_READY');
   await c.query('COMMIT');begun=false;return value;
  }catch(e){
   if(c&&begun)await c.query('ROLLBACK').catch(()=>{});
   if(e instanceof Fault)throw e;
   const code=(e as {code?:string})?.code;
   if(code==='23505')throw new Fault('VERSION_CONFLICT');
   if(['23503','23514','22P02'].includes(code??''))throw new Fault('INVALID_ARGUMENT');
   throw new Fault('NOT_READY');
  }finally{c?.release();}
 }};
}
