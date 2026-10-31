// ABOUTME: Реализует транзакции Контактов и ограничивает SQL оставшимся deadline.
// ABOUTME: Пул принадлежит программе; исторические квитанции только вставляются.
import type {Pool,PoolClient} from 'pg';
import {Fault,type Context,type Data,type Repository,type Store} from './types.js';
const format=(expression:string)=>"to_char("+expression+" AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')";
const identitySelect="SELECT jsonb_build_object('id',id,'ownerId',owner_id,'contactId',contact_id,'namespace',namespace,'externalId',external_id,'name',name,'username',username,'photoArtifactId',photo_artifact_id,'fieldOrigins',field_origins,'firstObservedAt',"+format('first_observed_at')+",'lastObservedAt',"+format('last_observed_at')+") AS body FROM contacts.contact_identities";
function repository(c:PoolClient,ctx:Context):Repository {
 const q=async(sql:string,args:any[]=[])=>{const remaining=Math.ceil(ctx.deadline-performance.now());if(remaining<=0)throw new Fault('DEADLINE_EXCEEDED');await c.query("SELECT set_config('statement_timeout',$1,true)",[String(remaining)]);return c.query(sql,args);};
 const contact=async(owner:string,id:string):Promise<Data|null>=>{
  const row=(await q("SELECT id,owner_id,"+format('created_at')+" AS created FROM contacts.contacts WHERE owner_id=$1 AND id=$2",[owner,id])).rows[0];if(!row)return null;
  const identities=(await q(identitySelect+' WHERE contact_id=$1 AND owner_id=$2 ORDER BY id',[id,owner])).rows.map(r=>r.body);
  return {id:row.id,ownerId:row.owner_id,createdAt:row.created,identities};
 };
 return {
  async lock(key){await q('SELECT pg_advisory_xact_lock(hashtextextended($1,67312))',[key]);},
  async timestamp(value){return (await q('SELECT '+format(value?'$1::timestamptz':'clock_timestamp()')+' AS stamp',value?[value]:[])).rows[0].stamp;},
  async ready(){for(const t of ['contacts','contact_identities','contact_operations'])await q('SELECT 1 FROM contacts.'+t+' LIMIT 0');},
  async operation(caller,owner,id){const row=(await q('SELECT operation,input_hash,result FROM contacts.contact_operations WHERE caller_id=$1 AND owner_id=$2 AND operation_id=$3',[caller,owner,id])).rows[0];return row?{operation:row.operation,inputHash:row.input_hash,result:row.result}:null;},
  async saveOperation(caller,op,input,digest,result,time){await q('INSERT INTO contacts.contact_operations(caller_id,owner_id,operation_id,operation,input_hash,request,result,committed_at,history_events) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[caller,input.ownerId,input.operationId,op,digest,input,result,time,JSON.stringify(result.historyEvents)]);},
  async identity(owner,external){return (await q(identitySelect+" WHERE owner_id=$1 AND namespace='telegram' AND external_id=$2",[owner,external])).rows[0]?.body??null;},
  async createIdentity(v,time){
   await q('INSERT INTO contacts.contacts(id,owner_id,created_at) VALUES($1,$2,$3)',[v.contactId,v.ownerId,time]);
   await q('INSERT INTO contacts.contact_identities(id,owner_id,contact_id,namespace,external_id,name,username,photo_artifact_id,field_origins,first_observed_at,last_observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[v.id,v.ownerId,v.contactId,v.namespace,v.externalId,v.name,v.username,v.photoArtifactId,v.fieldOrigins,v.firstObservedAt,v.lastObservedAt]);
  },
  async updateIdentity(v){await q('UPDATE contacts.contact_identities SET name=$1,username=$2,photo_artifact_id=$3,field_origins=$4,first_observed_at=$5,last_observed_at=$6 WHERE id=$7 AND owner_id=$8',[v.name,v.username,v.photoArtifactId,v.fieldOrigins,v.firstObservedAt,v.lastObservedAt,v.id,v.ownerId]);},
  contact,
  async list(owner,after,limit,external){const rows=(await q('SELECT c.id FROM contacts.contacts c JOIN contacts.contact_identities i ON i.contact_id=c.id WHERE c.owner_id=$1 AND ($2::uuid IS NULL OR c.id>$2) AND ($3::text IS NULL OR i.external_id=$3) ORDER BY c.id LIMIT $4',[owner,after,external??null,limit])).rows;const out:Data[]=[];for(const row of rows)out.push((await contact(owner,row.id))!);return out;}
 };
}
/** Сохраняет атомарность и удерживает заимствованный клиент до прекращения SQL. */
export function createStore(pool:Pool):Store {return {async transaction<T>(ctx:Context,work:(r:Repository)=>Promise<T>):Promise<T>{
 let c:PoolClient|undefined,begun=false;const error=()=>{};
 try{
  c=await pool.connect();c.on('error',error);
  if(performance.now()>=ctx.deadline)throw new Fault('DEADLINE_EXCEEDED');
  await c.query('BEGIN');begun=true;const result=await work(repository(c,ctx));
  if(performance.now()>=ctx.deadline)throw new Fault('DEADLINE_EXCEEDED');
  await c.query("SELECT set_config('statement_timeout',$1,true)",[String(Math.max(1,Math.ceil(ctx.deadline-performance.now())))]);
  await c.query('COMMIT');begun=false;return result;
 }catch(e){
  if(c&&begun)await c.query('ROLLBACK').catch(()=>{});
  if(e instanceof Fault)throw e;const code=(e as {code?:string})?.code;
  if(code==='57014'||performance.now()>=ctx.deadline)throw new Fault('DEADLINE_EXCEEDED');
  if(['23514','22P02','22008','22007'].includes(code??''))throw new Fault('INVALID_REQUEST');
  throw new Fault('DATABASE_UNAVAILABLE');
 }finally{if(c){c.removeListener('error',error);c.release();}}
 }};}
