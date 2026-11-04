// ABOUTME: Формирует неизменные выдачи 50 сообщений и свёрток.
// ABOUTME: ACK продвигает только checkpoint свёрток.
import type {Pool,PoolClient} from 'pg';
import {randomUUID,createHmac,timingSafeEqual,createHash} from 'node:crypto';
import {object,id,digest,fail,limits,DialoguesFault} from './domain.js';
type DB=Pick<Pool,'connect'>;
/** Сериализует снимок с commit записей владельца. */
export async function ownerTransaction<T>(pool:DB,owner:string,fn:(db:PoolClient)=>Promise<T>):Promise<T>{
 const db=await pool.connect();
 try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['dialogues-live:'+owner]);const result=await fn(db);await db.query('COMMIT');return result;}
 catch(e){await db.query('ROLLBACK').catch(()=>{});throw e instanceof DialoguesFault?e:new DialoguesFault('INTERNAL');}finally{db.release();}
}
function cursor(key:string,owner:string,consumer:string,instance:string,delivery:string,index:number){
 const value=Buffer.from(JSON.stringify([owner,consumer,instance,delivery,index])).toString('base64url');return value+'.'+createHmac('sha256',key).update('dialogues-v2:'+value).digest('base64url');
}
function parseCursor(key:string,raw:unknown,owner:string,consumer:string,instance:string):[string,number]{
 try{if(typeof raw!=='string'||raw.length>4096)fail('INVALID_CURSOR');const [value,sig,extra]=raw.split('.');if(extra||!value||!sig)fail('INVALID_CURSOR');
 const expected=createHmac('sha256',key).update('dialogues-v2:'+value).digest(),actual=Buffer.from(sig,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))fail('INVALID_CURSOR');
 const p=JSON.parse(Buffer.from(value,'base64url').toString());if(p.length!==5||p[0]!==owner||p[1]!==consumer||p[2]!==instance||!Number.isSafeInteger(p[4])||p[4]<1)fail('INVALID_CURSOR');id(p[3]);return [p[3],p[4]];}catch{return fail('INVALID_CURSOR');}
}
/** Сохраняет полный состав, разделяя его только границами страниц. */
export function contextPages(metadata:Record<string,any>,items:any[],makeCursor:(index:number)=>string){
 const common={...metadata,summary_size_policy:'no_per_summary_limit',
  summary_utf8_bytes:items.filter(i=>i.type==='dialogue_summary'||i.type==='message_representation'&&i.summary_version).reduce((n,i)=>n+Buffer.byteLength(i.text??''),0),
  manifest_text_utf8_bytes:items.reduce((n,i)=>n+Buffer.byteLength(i.text??''),0)};
 const envelope=(item:any)=>({...common,page_count:Number.MAX_SAFE_INTEGER,page_index:Number.MAX_SAFE_INTEGER,items:[item],continuation_cursor:makeCursor(Number.MAX_SAFE_INTEGER)});
 const budget=limits.responseBytes-256;
 const expanded:any[]=[];
 for(const item of items){
  if(Buffer.byteLength(JSON.stringify(envelope(item)))<=budget){expanded.push(item);continue;}
  if(typeof item.text!=='string'||!(item.type==='dialogue_summary'||item.type==='message_representation'&&item.summary_version||item.type==='turn_work'))fail('RESPONSE_ITEM_TOO_LARGE');
  const {text,truncated,next_offset,read_tool,...identity}=item;
  let total=0;for(const ch of text)total++;
  const info={total_chars:total,total_bytes:Buffer.byteLength(text),text_sha256:createHash('sha256').update(text,'utf8').digest('hex'),offset_unit:'unicode_codepoints',
   coverage:item.type==='dialogue_summary'?{through_message_id:item.through_message_id,through_order:item.through_order}:{message_id:item.message_id}};
  const kind=item.type==='dialogue_summary'?'dialogue_summary_fragment':item.type==='turn_work'?'turn_work_fragment':'message_summary_fragment';
  const fragment=(part:string,offset:number,next:number|null)=>({...identity,...info,type:kind,representation:'summary_fragment',text:part,offset,next_offset:next,is_last_fragment:next===null,text_complete:offset===0&&next===null});
  const available=budget-Buffer.byteLength(JSON.stringify(envelope(fragment('',Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER))));
  if(available<6)fail('RESPONSE_ITEM_TOO_LARGE');
  const pieces:any[]=[];let part='',cost=0,offset=0,end=0;
  for(const ch of text){
   const extra=Buffer.byteLength(JSON.stringify(ch))-2;
   if(part&&cost+extra>available){pieces.push(fragment(part,offset,end));part='';cost=0;offset=end;}
   part+=ch;cost+=extra;end++;
  }
  if(part)pieces.push(fragment(part,offset,null));
  expanded.push({...identity,...info,type:item.type,representation:'summary_fragments',text_format:'fragments',text_complete:false,fragment_count:pieces.length},...pieces);
 }
 const pages:any[]=[];let page:any={...common,page_count:Number.MAX_SAFE_INTEGER,page_index:0,items:[],continuation_cursor:null};
 for(const item of expanded){page.items.push(item);page.continuation_cursor=makeCursor(pages.length+1);
  if(Buffer.byteLength(JSON.stringify(page))>budget){page.items.pop();if(!page.items.length)fail('RESPONSE_ITEM_TOO_LARGE');pages.push(page);page={...common,page_count:Number.MAX_SAFE_INTEGER,page_index:pages.length,items:[item],continuation_cursor:makeCursor(pages.length+1)};
   if(Buffer.byteLength(JSON.stringify(page))>budget)fail('RESPONSE_ITEM_TOO_LARGE');}
 }
 page.continuation_cursor=null;pages.push(page);for(const p of pages)p.page_count=pages.length;return pages;
}
/** Создаёт owner-bound pull/ack отдельно от прежнего context_get. */
export function createContext(pool:DB,key:string){
 async function pull(owner:string,raw:unknown){
 const a=object(raw,['request_id','consumer_id','context_instance_id','reset','continuation_cursor','dialogue_id']);id(a.request_id);id(a.consumer_id);id(a.context_instance_id);if(a.reset!==undefined&&typeof a.reset!=='boolean')fail('INVALID_ARGUMENT');if(a.dialogue_id!==undefined)id(a.dialogue_id);
 let normalized:any={request_id:a.request_id,consumer_id:a.consumer_id,context_instance_id:a.context_instance_id,reset:a.reset??false,...(a.dialogue_id===undefined?{}:{dialogue_id:a.dialogue_id})};
 return ownerTransaction(pool,owner,async db=>{
 let delivery=(await db.query('SELECT * FROM dialogues_live.context_deliveries WHERE owner_id=$1 AND request_id=$2',[owner,a.request_id])).rows[0];let index=0;
 if(a.continuation_cursor!==undefined){
  const [did,n]=parseCursor(key,a.continuation_cursor,owner,a.consumer_id,a.context_instance_id);if(!delivery||delivery.id!==did)fail('INVALID_CURSOR');index=n;
  // Пропущенные параметры наследуются, в том числе для выдач до миграции 004.
  const original=delivery.request_options;
  if(original){if(a.reset===undefined)normalized.reset=original.reset;if(a.dialogue_id===undefined&&original.dialogue_id!==undefined)normalized.dialogue_id=original.dialogue_id;}
  else if(a.reset===undefined){const withReset={...normalized,reset:true};if(delivery.request_hash===digest(withReset))normalized=withReset;}
 }
 if(delivery&&delivery.request_hash!==digest(normalized))fail('REQUEST_CONFLICT');
 if(!delivery){
 await db.query('INSERT INTO dialogues_live.context_consumers(owner_id,consumer_id,context_instance_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[owner,a.consumer_id,a.context_instance_id]);
 const consumer=(await db.query('SELECT * FROM dialogues_live.context_consumers WHERE owner_id=$1 AND consumer_id=$2 AND context_instance_id=$3',[owner,a.consumer_id,a.context_instance_id])).rows[0];
 if(consumer.active_delivery_id)await db.query("UPDATE dialogues_live.context_deliveries SET state='superseded' WHERE owner_id=$1 AND id=$2 AND state='active'",[owner,consumer.active_delivery_id]);
 const bootstrap=normalized.reset||!consumer.bootstrapped,checkpoint=bootstrap?'0':consumer.checkpoint;
 const boundary=(await db.query('SELECT COALESCE(MAX(change_seq),0)::text AS seq FROM dialogues_live.requests WHERE owner_id=$1',[owner])).rows[0].seq,deliveryId=randomUUID();
 // AIDEV-NOTE: Время задаёт отбор, sequence задаёт видимость committed версий.
 const selected=(await db.query(`SELECT m.id,m.dialogue_id,m.turn_id,m.role,m.kind,m.message_order,m.item_order,m.source,m.occurred_at,m.recorded_at,m.change_seq,m.content_hash AS sha256,
 COALESCE(m.occurred_at,m.recorded_at) AS effective_at,CASE WHEN m.occurred_at IS NULL THEN 'recorded_at_fallback' ELSE 'occurred_at' END AS time_provenance,
 s.version AS summary_version,s.text AS summary_text,left(m.text,1024) AS original_fragment,char_length(m.text) AS total_chars
 FROM dialogues_live.messages m LEFT JOIN LATERAL(SELECT version,text FROM dialogues_live.message_summaries WHERE owner_id=m.owner_id AND dialogue_id=m.dialogue_id AND message_id=m.id AND change_seq<=$2 ORDER BY version DESC LIMIT 1)s ON true
 WHERE m.owner_id=$1 AND m.change_seq<=$2 AND m.kind IN('input','final') AND NOT EXISTS(SELECT 1 FROM dialogues_live.turns z WHERE z.owner_id=m.owner_id AND z.dialogue_id=m.dialogue_id AND z.id=m.turn_id AND z.managed AND m.kind='final' AND z.final_message_id IS DISTINCT FROM m.id) ORDER BY COALESCE(m.occurred_at,m.recorded_at) DESC,m.change_seq DESC,m.message_order DESC,m.dialogue_id DESC,m.id DESC LIMIT 50`,[owner,boundary])).rows.reverse();
 selected.forEach((m,i)=>m.global_order=i);
 const all=(await db.query(`SELECT d.id AS dialogue_id,d.channel,d.title,s.version,s.text,s.through_message_id,s.through_order,s.change_seq,
 (SELECT count(*)::integer FROM dialogues_live.messages m WHERE m.owner_id=d.owner_id AND m.dialogue_id=d.id AND m.kind IN('input','final') AND NOT EXISTS(SELECT 1 FROM dialogues_live.turns z WHERE z.owner_id=m.owner_id AND z.dialogue_id=m.dialogue_id AND z.id=m.turn_id AND z.managed AND m.kind='final' AND z.final_message_id IS DISTINCT FROM m.id) AND m.change_seq<=$2 AND m.message_order>COALESCE(s.through_order,-1)) AS uncovered_messages,
 (SELECT max(message_order)::text FROM dialogues_live.messages m WHERE m.owner_id=d.owner_id AND m.dialogue_id=d.id AND m.kind IN('input','final') AND NOT EXISTS(SELECT 1 FROM dialogues_live.turns z WHERE z.owner_id=m.owner_id AND z.dialogue_id=m.dialogue_id AND z.id=m.turn_id AND z.managed AND m.kind='final' AND z.final_message_id IS DISTINCT FROM m.id) AND m.change_seq<=$2) AS last_message_order
 FROM dialogues_live.dialogues d LEFT JOIN LATERAL(SELECT * FROM dialogues_live.dialogue_summaries WHERE owner_id=d.owner_id AND dialogue_id=d.id AND change_seq<=$2 ORDER BY version DESC LIMIT 1)s ON true
 WHERE d.owner_id=$1 AND EXISTS(SELECT 1 FROM dialogues_live.messages m WHERE m.owner_id=d.owner_id AND m.dialogue_id=d.id AND m.change_seq<=$2) ORDER BY d.id`,[owner,boundary])).rows;
 const items:any[]=[];
 for(const d of all){const chosen=selected.filter(m=>m.dialogue_id===d.dialogue_id),includeSummary=bootstrap||(d.version&&BigInt(d.change_seq)>BigInt(checkpoint));if(!chosen.length&&!includeSummary)continue;
 items.push({type:'dialogue',dialogue_id:d.dialogue_id,channel:d.channel,title:d.title,coverage:{status:!d.version?'missing_summary':d.uncovered_messages?'partial':'complete',uncovered_messages:d.uncovered_messages,summary_version:d.version??null,through_message_id:d.through_message_id??null,through_order:d.through_order??null,last_message_order:d.last_message_order}});
 if(includeSummary&&d.version)items.push({type:'dialogue_summary',dialogue_id:d.dialogue_id,version:d.version,text:d.text,through_message_id:d.through_message_id,through_order:d.through_order,overlap_is_independent_evidence:false});
 // Метаданные и текст разделены, чтобы JSON escaping не переполнил одну запись.
 for(const m of chosen){const {summary_text,original_fragment,...meta}=m;items.push({type:'message',...meta,summary_status:m.summary_version?'available':'missing',representation:m.summary_version?'summary':'original'});
 const text=m.summary_version?summary_text:original_fragment,offset=Array.from(text).length;items.push({type:'message_representation',dialogue_id:d.dialogue_id,message_id:m.id,summary_version:m.summary_version,text,truncated:!m.summary_version&&offset<m.total_chars,next_offset:!m.summary_version&&offset<m.total_chars?offset:null,read_tool:!m.summary_version&&offset<m.total_chars?'dialogues_message_get':null});}}
 if(a.dialogue_id!==undefined){
 const t=(await db.query("SELECT id,version::text,status,purpose,constraints_text,final_message_id,reconciled_through_order FROM dialogues_live.turns WHERE owner_id=$1 AND dialogue_id=$2 AND managed AND status<>'completed'",[owner,a.dialogue_id])).rows[0];
 if(t){const messages=(await db.query("SELECT id,role,kind,text,source,occurred_at,recorded_at,message_order,item_order,content_hash AS sha256 FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 AND kind IN ('input','final') ORDER BY message_order",[owner,a.dialogue_id,t.id])).rows;
 for(const m of messages)if(m.kind==='final')m.final_state=t.final_message_id===m.id?'recorded':(t.reconciled_through_order!==null&&BigInt(m.message_order)<=BigInt(t.reconciled_through_order)?'reconciled_absent':'awaiting_reconciliation');
 const results=(await db.query('SELECT id,kind,formulation,source_refs,status,result,verification,reason,remainder,created_at,updated_at FROM dialogues_live.turn_results WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 ORDER BY created_at,id',[owner,a.dialogue_id,t.id])).rows;
 items.push({type:'turn_work',dialogue_id:a.dialogue_id,turn_id:t.id,version:t.version,text:JSON.stringify({dialogue_id:a.dialogue_id,turn_id:t.id,version:t.version,status:t.status,purpose:t.purpose,constraints:t.constraints_text,messages,results,pending:results.filter((r:any)=>r.kind==='work'&&r.status==='pending')})});}
 }
 const metadata={delivery_id:deliveryId,consumer_id:a.consumer_id,context_instance_id:a.context_instance_id,through_seq:boundary,summaries_mode:bootstrap?'bootstrap':'updates',summaries_from_seq:checkpoint,selected_count:selected.length,
 missing_dialogue_summaries:all.filter(d=>!d.version).length,partial_dialogue_summaries:all.filter(d=>d.version&&d.uncovered_messages).length,context_status:'complete_paginated_manifest',window_fit:'consumer_must_read_all_pages_and_report_model_window_limit',overlap_is_independent_evidence:false};
 const pages=contextPages(metadata,items,n=>cursor(key,owner,a.consumer_id,a.context_instance_id,deliveryId,n));
 delivery=(await db.query("INSERT INTO dialogues_live.context_deliveries(owner_id,id,consumer_id,context_instance_id,request_id,request_hash,through_seq,pages,state,request_options) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9) RETURNING *",[owner,deliveryId,a.consumer_id,a.context_instance_id,a.request_id,digest(normalized),boundary,JSON.stringify(pages),JSON.stringify(normalized)])).rows[0];
 await db.query('UPDATE dialogues_live.context_consumers SET active_delivery_id=$4,checkpoint=$5,bootstrapped=$6 WHERE owner_id=$1 AND consumer_id=$2 AND context_instance_id=$3',[owner,a.consumer_id,a.context_instance_id,deliveryId,checkpoint,bootstrap?false:consumer.bootstrapped]);}
 if(index>=delivery.pages.length)fail('INVALID_CURSOR');if(index>0&&!delivery.served_pages.includes(index-1))fail('PAGES_INCOMPLETE');
 await db.query('UPDATE dialogues_live.context_deliveries SET served_pages=CASE WHEN $3=ANY(served_pages) THEN served_pages ELSE array_append(served_pages,$3) END WHERE owner_id=$1 AND id=$2',[owner,delivery.id,index]);return delivery.pages[index];});
 }
 async function ack(owner:string,raw:unknown){
 const a=object(raw,['request_id','consumer_id','context_instance_id','delivery_id']);for(const k of ['request_id','consumer_id','context_instance_id','delivery_id'])id(a[k]);
 return ownerTransaction(pool,owner,async db=>{
 const prior=(await db.query('SELECT operation,hash,result FROM dialogues_live.requests WHERE owner_id=$1 AND id=$2',[owner,a.request_id])).rows[0];
 if(prior){if(prior.operation!=='context_ack'||prior.hash!==digest(a))fail('REQUEST_CONFLICT');return prior.result;}
 const d=(await db.query('SELECT * FROM dialogues_live.context_deliveries WHERE owner_id=$1 AND id=$2 AND consumer_id=$3 AND context_instance_id=$4',[owner,a.delivery_id,a.consumer_id,a.context_instance_id])).rows[0];if(!d)fail('NOT_FOUND');if(d.state==='superseded')fail('DELIVERY_SUPERSEDED');
 if(d.state==='acked'){if(d.receipt.request_id!==a.request_id)fail('REQUEST_CONFLICT');return d.receipt;}if(d.served_pages.length!==d.pages.length)fail('PAGES_INCOMPLETE');
 const receipt={request_id:a.request_id,delivery_id:d.id,consumer_id:a.consumer_id,context_instance_id:a.context_instance_id,summaries_checkpoint:d.through_seq,acknowledged:true,missing_dialogue_summaries:d.pages[0].missing_dialogue_summaries,partial_dialogue_summaries:d.pages[0].partial_dialogue_summaries};
 await db.query("UPDATE dialogues_live.context_deliveries SET state='acked',receipt=$3 WHERE owner_id=$1 AND id=$2",[owner,d.id,receipt]);await db.query('UPDATE dialogues_live.context_consumers SET checkpoint=$4,bootstrapped=true,active_delivery_id=NULL WHERE owner_id=$1 AND consumer_id=$2 AND context_instance_id=$3 AND active_delivery_id=$5',[owner,a.consumer_id,a.context_instance_id,d.through_seq,d.id]);
 const seq=(await db.query("SELECT nextval('dialogues_live.change_seq')::text AS seq")).rows[0].seq;
 await db.query("INSERT INTO dialogues_live.requests(owner_id,id,operation,hash,result,change_seq) VALUES($1,$2,'context_ack',$3,$4,$5)",[owner,a.request_id,digest(a),receipt,seq]);return receipt;});
 }
 return {pull,ack};
}
