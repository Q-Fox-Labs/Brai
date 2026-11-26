// ABOUTME: Читает историю и оригиналы по коротким ID внутри одного профиля.
// ABOUTME: Страницы архива не меняют границу подтверждённого контекста.
import type {Pool} from 'pg';
import {contextExcerpt,topicLimits} from './compact-context.js';
import {contextPages} from './context.js';
import {bytes,decodeCursor,digest,encodeCursor,fail,hasAttachmentsSql,limits,shortNumber,sourceAttachments} from './domain.js';
const resolvableMessage=`NOT EXISTS(
 SELECT 1 FROM dialogues_live.turns t WHERE t.owner_id=m.owner_id AND t.dialogue_id=m.dialogue_id
  AND t.id=m.turn_id AND t.managed AND m.kind='final'
  AND (t.final_message_id IS DISTINCT FROM m.id OR t.completion_seq IS NULL))`;

export function createArchiveReader(pool:Pick<Pool,'connect'>,key:string){
 async function history(owner:string,dialogue:string,token?:string){
  const cursor=token===undefined?null:decodeCursor(token,key,owner);
  if(cursor&&(cursor.mode!=='dialogue'||cursor.scope!==dialogue))fail('INVALID_CURSOR');
  const db=await pool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const scoped=(await db.query('SELECT id FROM dialogues_live.dialogues WHERE owner_id=$1 AND short_id=$2',
    [owner,shortNumber(dialogue,'D')])).rows[0];
   if(!scoped)fail('NOT_FOUND');
   const boundary=cursor?.through??(await db.query(
    'SELECT COALESCE(max(change_seq),0)::text AS seq FROM dialogues_live.requests WHERE owner_id=$1',[owner])).rows[0].seq;
   const rows=(await db.query(`SELECT 'M'||m.short_id AS message_id,m.role,char_length(m.text)<=100 AS exact,
    ${hasAttachmentsSql('m.source')} AS has_attachments,
    CASE WHEN char_length(m.text)<=100 THEN m.text ELSE COALESCE(c.text,s.text) END AS text
    FROM dialogues_live.messages m JOIN dialogues_live.turns t
     ON t.owner_id=m.owner_id AND t.dialogue_id=m.dialogue_id AND t.id=m.turn_id
    LEFT JOIN LATERAL (SELECT version,text FROM dialogues_live.message_summaries
     WHERE owner_id=m.owner_id AND dialogue_id=m.dialogue_id AND message_id=m.id AND change_seq<=$3 ORDER BY version DESC LIMIT 1) s ON true
    LEFT JOIN dialogues_live.message_compact_summaries c ON c.owner_id=m.owner_id AND c.dialogue_id=m.dialogue_id
     AND c.message_id=m.id AND c.source_version=s.version AND c.change_seq<=$3
    WHERE m.owner_id=$1 AND m.dialogue_id=$2 AND m.change_seq<=$3
     AND (m.kind<>'final' OR NOT t.managed OR (t.final_message_id=m.id AND t.completion_seq<=$3))
    ORDER BY m.message_order,m.id`,[owner,scoped.id,boundary])).rows;
   const items=rows.map(({message_id,role,exact,text,has_attachments})=>({
    type:'message_representation',message_id,role,representation:exact?'original':text?'summary':'reference',
    ...(has_attachments?{attachments:true}:{}),
    ...(text===null?{}:{text:exact?text:contextExcerpt(text,topicLimits.message).text})
   }));
   const pages=contextPages({dialogue_id:dialogue,through_seq:boundary},items,
    offset=>encodeCursor({v:1,owner,mode:'dialogue',scope:dialogue,from:'0',through:boundary,offset},key));
   const page=pages[cursor?.offset??0];
   if(!page)fail('INVALID_CURSOR');
   await db.query('COMMIT');
   return page;
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
 }

 async function readMany(owner:string,ids:unknown,token?:string){
  if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length)fail('INVALID_ARGUMENT');
  const numbers=ids.map(value=>typeof value==='string'?shortNumber(value,'M'):null);
  if(numbers.some(value=>value===null))fail('INVALID_ARGUMENT');
  const scope=digest(ids);
  const cursor=token===undefined?null:decodeCursor(token,key,owner);
  if(cursor&&(cursor.mode!=='originals'||cursor.scope!==scope||cursor.through!==String(ids.length)
   ||BigInt(cursor.from)>=BigInt(ids.length)))fail('INVALID_CURSOR');
  const db=await pool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const found=(await db.query(`SELECT count(*)::int AS count FROM dialogues_live.messages m
    WHERE m.owner_id=$1 AND m.short_id=ANY($2::bigint[]) AND ${resolvableMessage}`,[owner,numbers])).rows[0].count;
   if(found!==ids.length)fail('NOT_FOUND');
   let index=Number(cursor?.from??0),offset=cursor?.offset??0;
   const messages:{message_id:string;text:string;offset:number;next_offset:number|null;total_chars:number;attachments?:unknown[]}[]=[];
   let responseBytes=0;
   while(index<ids.length){
    const row=(await db.query(`SELECT substring(text FROM $3::int+1 FOR 8192) AS text,char_length(text) AS total_chars,source
     FROM dialogues_live.messages WHERE owner_id=$1 AND short_id=$2`,[owner,numbers[index],offset])).rows[0];
    const end=offset+Array.from(row.text).length;
    if(end>row.total_chars)fail('INVALID_CURSOR');
    const next=end<row.total_chars?end:null;
    const attachments=offset===0?sourceAttachments(row.source):[];
    const item={message_id:ids[index],text:row.text,offset,next_offset:next,total_chars:row.total_chars,
     ...(attachments.length?{attachments}:{})};
    const size=bytes(item)+1;
    if(messages.length&&responseBytes+size>limits.responseBytes-1024)break;
    messages.push(item);
    responseBytes+=size;
    if(next!==null){offset=next;break;}
    index++;offset=0;
   }
   await db.query('COMMIT');
   return {messages,continuation_cursor:index<ids.length?
    encodeCursor({v:1,owner,mode:'originals',scope,from:String(index),through:String(ids.length),offset},key):null};
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
 }
 return {history,readMany};
}
