// ABOUTME: Хранит членство тем Диалогов и читает архив внутри профиля.
// ABOUTME: Чтение темы или сообщения не создаёт выдачу контекста.
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {bytes,DialoguesFault,digest,fail,limits,shortNumber} from './domain.js';
import {ownerTransaction} from './context.js';
import {contextExcerpt,topicLimits} from './compact-context.js';

type DB=Pick<Pool,'connect'>;
export const topicId=(dialogue:string)=>'topic-'+createHash('sha256').update(dialogue).digest('hex');
const vector="CASE WHEN octet_length(m.text)<=65024 THEN to_tsvector('pg_catalog.russian',m.text) ELSE ''::tsvector END";

// AIDEV-NOTE: Подтверждённый финал виден только после завершения управляемого хода.
export const visibleMessage=`m.kind IN ('input','final') AND NOT EXISTS(
 SELECT 1 FROM dialogues_live.turns z WHERE z.owner_id=m.owner_id AND z.dialogue_id=m.dialogue_id
 AND z.id=m.turn_id AND z.managed AND m.kind='final'
 AND (z.final_message_id IS DISTINCT FROM m.id OR z.completion_seq IS NULL))`;

/** Создаёт одну тему на тред безопасно при повторе операции или запуске пересчёта. */
export async function ensureTopic(db:PoolClient,owner:string,dialogue:string){
 const id=topicId(dialogue);
 await db.query(`INSERT INTO dialogues_live.topics(owner_id,id,title,home_dialogue_id)
 SELECT owner_id,$3,title,id FROM dialogues_live.dialogues WHERE owner_id=$1 AND id=$2
 AND NOT EXISTS (SELECT 1 FROM dialogues_live.topic_members WHERE owner_id=$1 AND dialogue_id=$2)
 ON CONFLICT DO NOTHING`,[owner,dialogue,id]);
 await db.query(`INSERT INTO dialogues_live.topic_members(owner_id,dialogue_id,topic_id)
 SELECT owner_id,$2,id FROM dialogues_live.topics WHERE owner_id=$1 AND id=$3 AND merged_into IS NULL
 ON CONFLICT DO NOTHING`,[owner,dialogue,id]);
}

async function resolveTopic(db:PoolClient,owner:string,id:string):Promise<string>{
 const number=shortNumber(id,'T');
 const result=await db.query(`WITH RECURSIVE chain(id,merged_into) AS (
  SELECT t.id,CASE WHEN t.merged_into IS NOT NULL THEN COALESCE(tm.topic_id,t.merged_into) END
  FROM dialogues_live.topics t LEFT JOIN dialogues_live.topic_members tm ON tm.owner_id=t.owner_id AND tm.dialogue_id=t.home_dialogue_id
  WHERE t.owner_id=$1 AND (t.id=$2 OR t.short_id=$3)
  UNION SELECT t.id,CASE WHEN t.merged_into IS NOT NULL THEN COALESCE(tm.topic_id,t.merged_into) END
  FROM chain c JOIN dialogues_live.topics t ON t.owner_id=$1 AND t.id=c.merged_into
  LEFT JOIN dialogues_live.topic_members tm ON tm.owner_id=t.owner_id AND tm.dialogue_id=t.home_dialogue_id
 ) SELECT id FROM chain WHERE merged_into IS NULL`,[owner,id,number]);
 return result.rows[0]?.id??fail('NOT_FOUND');
}

/** Выбирает недавние карточки; для старых тем остаётся только доступ по ID и поиск. */
export async function recentTopics(db:PoolClient,owner:string,pinned?:string,currentDialogue?:string,legacy=false){
 return (await db.query(`WITH recent AS (SELECT t.id,CASE WHEN $4::boolean THEN t.id ELSE 'T'||t.short_id END AS topic_id,left(t.title,128) AS title,
  EXISTS(SELECT 1 FROM dialogues_live.topic_members own WHERE own.owner_id=t.owner_id
   AND own.topic_id=t.id AND own.dialogue_id=$3) AS includes_current,
  max(COALESCE(m.occurred_at,m.recorded_at)) AS last_activity,s.version,s.extended,s.compact,s.extended_tokens,s.compact_tokens,s.source_refs
  FROM dialogues_live.topics t JOIN dialogues_live.topic_members tm ON tm.owner_id=t.owner_id AND tm.topic_id=t.id
  JOIN LATERAL (SELECT occurred_at,recorded_at FROM dialogues_live.messages m
   WHERE m.owner_id=tm.owner_id AND m.dialogue_id=tm.dialogue_id AND ${visibleMessage}
  AND ($3::text IS NULL OR tm.dialogue_id<>$3)
   ORDER BY COALESCE(occurred_at,recorded_at) DESC,m.change_seq DESC LIMIT 1) m ON true
  LEFT JOIN LATERAL (SELECT version,extended,compact,extended_tokens,compact_tokens,source_refs FROM dialogues_live.topic_summaries
   WHERE owner_id=t.owner_id AND topic_id=t.id AND membership_version=t.membership_version ORDER BY version DESC LIMIT 1) s ON true
  WHERE t.owner_id=$1 AND t.merged_into IS NULL
  GROUP BY t.owner_id,t.id,t.short_id,t.title,s.version,s.extended,s.compact,s.extended_tokens,s.compact_tokens,s.source_refs
  ORDER BY (t.id IS NOT DISTINCT FROM $2) DESC,last_activity DESC,t.id LIMIT 220
  )
  SELECT recent.*,fallback.text AS fallback FROM recent
  LEFT JOIN LATERAL (
   SELECT string_agg(left(concat_ws(' ',ds.text,ms.text),1600),' '
    ORDER BY GREATEST(ds.change_seq,ms.change_seq) DESC,tm.dialogue_id) AS text
   FROM dialogues_live.topic_members tm
   LEFT JOIN LATERAL (SELECT text,change_seq,through_order FROM dialogues_live.dialogue_summaries
    WHERE owner_id=tm.owner_id AND dialogue_id=tm.dialogue_id ORDER BY version DESC LIMIT 1) ds ON true
   LEFT JOIN LATERAL (
    SELECT s.text,GREATEST(m.change_seq,s.change_seq) AS change_seq FROM dialogues_live.messages m
    JOIN LATERAL (SELECT text,change_seq FROM dialogues_live.message_summaries
     WHERE owner_id=m.owner_id AND dialogue_id=m.dialogue_id AND message_id=m.id ORDER BY version DESC LIMIT 1) s ON true
    WHERE m.owner_id=tm.owner_id AND m.dialogue_id=tm.dialogue_id AND ${visibleMessage}
    AND m.message_order>COALESCE(ds.through_order,-1)
    ORDER BY m.message_order DESC LIMIT 1
   ) ms ON true
   WHERE tm.owner_id=$1 AND tm.topic_id=recent.id AND COALESCE(ds.text,ms.text) IS NOT NULL
    AND ($3::text IS NULL OR tm.dialogue_id<>$3)
  ) fallback ON (recent.version IS NULL OR recent.includes_current) AND NOT $4::boolean
  ORDER BY (recent.id IS NOT DISTINCT FROM $2) DESC,last_activity DESC,recent.id`,[owner,pinned??null,currentDialogue??null,legacy])).rows;
}

/** Выдаёт компактные совпадения без передачи целых сообщений поисковому клиенту. */
export async function searchArchive(db:PoolClient,owner:string,query:string,topic?:string){
 const messageMatches=await db.query(`WITH q AS (
  SELECT plainto_tsquery('pg_catalog.russian',$2) AS words
 ), matched AS (
  SELECT m.dialogue_id,m.id AS message_id,tm.topic_id,'T'||t.short_id AS topic_ref,m.text,
   strpos(lower(m.text),lower($2)) AS position, m.change_seq,
   ts_rank((${vector}),(SELECT words FROM q)) AS rank
  FROM dialogues_live.messages m
  LEFT JOIN dialogues_live.topic_members tm ON tm.owner_id=m.owner_id AND tm.dialogue_id=m.dialogue_id
  LEFT JOIN dialogues_live.topics t ON t.owner_id=tm.owner_id AND t.id=tm.topic_id
  WHERE m.owner_id=$1 AND ($3::text IS NULL OR tm.topic_id=$3) AND ${visibleMessage}
   AND ((${vector}) @@ (SELECT words FROM q) OR strpos(lower(m.text),lower($2))>0)
  ORDER BY (strpos(lower(m.text),lower($2))>0) DESC,rank DESC,m.change_seq DESC,m.dialogue_id,m.id LIMIT 20
 ) SELECT dialogue_id,message_id,topic_id,topic_ref,position>0 AS exact,
  CASE WHEN position>0 THEN greatest(0,position-41) END AS offset,
  substring(text FROM greatest(1,position-40) FOR 240) AS snippet
 FROM matched ORDER BY (position>0) DESC,rank DESC,change_seq DESC,dialogue_id,message_id`,[owner,query,topic??null]);
 const topicMatches=await db.query(`SELECT t.id AS topic_id,'T'||t.short_id AS topic_ref,left(t.title,128) AS title,
  left(s.compact,240) AS snippet,COALESCE(strpos(lower(t.title),lower($2))>0,false) AS exact
  FROM dialogues_live.topics t
  LEFT JOIN LATERAL (SELECT extended,compact FROM dialogues_live.topic_summaries WHERE owner_id=t.owner_id AND topic_id=t.id AND membership_version=t.membership_version ORDER BY version DESC LIMIT 1) s ON true
  WHERE t.owner_id=$1 AND t.merged_into IS NULL AND ($3::text IS NULL OR t.id=$3)
   AND (strpos(lower(concat_ws(' ',t.title,s.extended)),lower($2))>0
    OR to_tsvector('pg_catalog.russian',concat_ws(' ',t.title,s.extended)) @@ plainto_tsquery('pg_catalog.russian',$2))
  ORDER BY exact DESC,t.id LIMIT 20`,[owner,query,topic??null]);
 return {messages:messageMatches.rows,topics:topicMatches.rows};
}

/** Открывает тему и ограниченную страницу тредов либо перемещает тред с сохранением ID. */
export function createTopics(pool:DB){
 async function getLegacy(owner:string,id:string,after?:string){
  const db=await pool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const topic=await resolveTopic(db,owner,id);
   const card=(await db.query(`SELECT t.id AS topic_id,left(t.title,128) AS title,s.version,s.extended AS text,s.source_refs
    FROM dialogues_live.topics t LEFT JOIN LATERAL (SELECT version,extended,source_refs FROM dialogues_live.topic_summaries
    WHERE owner_id=t.owner_id AND topic_id=t.id AND membership_version=t.membership_version ORDER BY version DESC LIMIT 1) s ON true
    WHERE t.owner_id=$1 AND t.id=$2`,[owner,topic])).rows[0];
   const dialogues=(await db.query(`SELECT d.id AS dialogue_id,left(d.title,128) AS title,d.channel FROM dialogues_live.topic_members tm
    JOIN dialogues_live.dialogues d ON d.owner_id=tm.owner_id AND d.id=tm.dialogue_id
    WHERE tm.owner_id=$1 AND tm.topic_id=$2 AND ($3::text IS NULL OR d.id>$3) ORDER BY d.id LIMIT 51`,[owner,topic,after??null])).rows;
   await db.query('COMMIT');
   const page=dialogues.slice(0,50);
   return {...card,dialogues:page,next_after:dialogues.length>page.length?page.at(-1).dialogue_id:null};
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
 }
 async function get(owner:string,id:string,after?:string){
  if(!shortNumber(id,'T'))return getLegacy(owner,id,after);
  const db=await pool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const topic=await resolveTopic(db,owner,id);
   const card=(await db.query(`SELECT 'T'||t.short_id AS topic_id,left(t.title,128) AS title,s.version,s.extended AS text,
    (SELECT jsonb_agg(jsonb_build_object('message_id','M'||m.short_id) ORDER BY ref.ordinality)
     FROM jsonb_array_elements(s.source_refs) WITH ORDINALITY ref(value,ordinality)
     JOIN dialogues_live.messages m ON m.owner_id=t.owner_id AND m.dialogue_id=ref.value->>'dialogue_id'
      AND m.id=ref.value->>'message_id' AND ${visibleMessage}) AS source_refs
    FROM dialogues_live.topics t LEFT JOIN LATERAL (SELECT version,extended,source_refs FROM dialogues_live.topic_summaries
    WHERE owner_id=t.owner_id AND topic_id=t.id AND membership_version=t.membership_version ORDER BY version DESC LIMIT 1) s ON true
    WHERE t.owner_id=$1 AND t.id=$2`,[owner,topic])).rows[0];
   const afterNumber=after===undefined?null:shortNumber(after,'D');
   if(after!==undefined&&!afterNumber)fail('INVALID_CURSOR');
   const rows=(await db.query(`SELECT 'D'||d.short_id AS dialogue_id,left(d.title,128) AS title,COALESCE(s.text,recent.text) AS summary,
    s.through_order IS NOT NULL AND EXISTS(SELECT 1 FROM dialogues_live.messages m
     WHERE m.owner_id=d.owner_id AND m.dialogue_id=d.id AND m.message_order>s.through_order AND ${visibleMessage}) AS summary_incomplete
    FROM dialogues_live.topic_members tm JOIN dialogues_live.dialogues d ON d.owner_id=tm.owner_id AND d.id=tm.dialogue_id
    LEFT JOIN LATERAL (SELECT text,through_order FROM dialogues_live.dialogue_summaries
     WHERE owner_id=d.owner_id AND dialogue_id=d.id ORDER BY version DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (
     SELECT string_agg(excerpt,' ' ORDER BY message_order) AS text FROM (
      SELECT left(CASE WHEN char_length(m.text)<=100 THEN m.text ELSE ms.text END,4096) AS excerpt,m.message_order
      FROM dialogues_live.messages m
      LEFT JOIN LATERAL (SELECT text FROM dialogues_live.message_summaries
       WHERE owner_id=m.owner_id AND dialogue_id=m.dialogue_id AND message_id=m.id ORDER BY version DESC LIMIT 1) ms ON true
      WHERE m.owner_id=d.owner_id AND m.dialogue_id=d.id AND ${visibleMessage}
      ORDER BY m.message_order DESC LIMIT 20
     ) excerpts
    ) recent ON s.text IS NULL
    WHERE tm.owner_id=$1 AND tm.topic_id=$2 AND ($3::bigint IS NULL OR d.short_id>$3)
    ORDER BY d.short_id LIMIT 51`,[owner,topic,afterNumber])).rows;
   const dialogues=[];
   for(const {dialogue_id,title,summary,summary_incomplete} of rows.slice(0,50)){
    const excerpt=summary?contextExcerpt(summary,topicLimits.extended):null;
    const row={dialogue_id,title,summary:excerpt?.text??null,...(excerpt?.truncated?{summary_excerpt:true}:{}),
     ...(summary_incomplete?{summary_incomplete:true}:{})};
    if(bytes({...card,dialogues:[...dialogues,row]})>limits.responseBytes-1024)break;
    dialogues.push(row);
   }
   if(rows.length&&!dialogues.length)fail('RESPONSE_ITEM_TOO_LARGE');
   await db.query('COMMIT');
   return {...card,dialogues,next_after:rows.length>dialogues.length?dialogues.at(-1)!.dialogue_id:null};
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
 }
 async function search(owner:string,query:string,topic?:string){
  if(!query.trim())throw new DialoguesFault('INVALID_ARGUMENT',{field:'arguments.query',expected:'непустой запрос'});
  const db=await pool.connect();
  try{return await searchArchive(db,owner,query.trim(),topic===undefined?undefined:await resolveTopic(db,owner,topic));}
  finally{db.release();}
 }
 async function move(owner:string,requestId:string,dialogue:string,destination:string|null){
  return ownerTransaction(pool,owner,async db=>{
   const operation='topic_move';
   const hash=digest([dialogue,destination]);
   const previous=(await db.query('SELECT operation,hash,result FROM dialogues_live.requests WHERE owner_id=$1 AND id=$2',[owner,requestId])).rows[0];
   if(previous){if(previous.operation!==operation||previous.hash!==hash)fail('REQUEST_CONFLICT');return previous.result;}
   const topic=await moveTopicMember(db,owner,dialogue,destination);
   await db.query('UPDATE dialogues_live.topic_members SET manually_assigned=true WHERE owner_id=$1 AND dialogue_id=$2',[owner,dialogue]);
   const {topic_id}=(await db.query("SELECT 'T'||short_id AS topic_id FROM dialogues_live.topics WHERE owner_id=$1 AND id=$2",[owner,topic])).rows[0];
   const receipt={dialogue_id:dialogue,topic_id:destination&&shortNumber(destination,'T')?topic_id:topic};
   await db.query("INSERT INTO dialogues_live.requests(owner_id,id,operation,hash,result,change_seq) VALUES($1,$2,$3,$4,$5,nextval('dialogues_live.change_seq'))",[owner,requestId,operation,hash,receipt]);
   return receipt;
  });
 }
 return {get,search,move};
}

/** Переносит тред под блокировкой владельца; пустая прежняя тема сохраняется как ссылка. */
export async function moveTopicMember(db:PoolClient,owner:string,dialogue:string,destination:string|null){
 const previous=(await db.query('SELECT topic_id FROM dialogues_live.topic_members WHERE owner_id=$1 AND dialogue_id=$2',[owner,dialogue])).rows[0]?.topic_id;
 if(!previous)fail('NOT_FOUND');
 const own=topicId(dialogue);
 const target=destination===null?own:await resolveTopic(db,owner,destination);
 if(previous===target)return target;
 if(destination===null){
  await db.query(`INSERT INTO dialogues_live.topic_separations(owner_id,dialogue_id,separated_from)
   SELECT owner_id,$2,dialogue_id FROM dialogues_live.topic_members
    WHERE owner_id=$1 AND topic_id=$3 AND dialogue_id<>$2 ON CONFLICT DO NOTHING`,[owner,dialogue,previous]);
  await db.query('UPDATE dialogues_live.topics SET merged_into=NULL WHERE owner_id=$1 AND id=$2',[owner,own]);
 }
 await db.query('UPDATE dialogues_live.topic_members SET topic_id=$3 WHERE owner_id=$1 AND dialogue_id=$2',[owner,dialogue,target]);
 await db.query("UPDATE dialogues_live.topics SET membership_version=membership_version+1,dirty_seq=nextval('dialogues_live.change_seq') WHERE owner_id=$1 AND id=ANY($2::text[])",[owner,[previous,target]]);
 await db.query(`UPDATE dialogues_live.topics SET merged_into=$3 WHERE owner_id=$1 AND id=$2 AND NOT EXISTS
  (SELECT 1 FROM dialogues_live.topic_members WHERE owner_id=$1 AND topic_id=$2)`,[owner,previous,target]);
 return target;
}
