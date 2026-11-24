// ABOUTME: Хранит членство тем Диалогов и читает архив внутри профиля.
// ABOUTME: Чтение темы или сообщения не создаёт выдачу контекста.
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {DialoguesFault,digest,fail} from './domain.js';
import {ownerTransaction} from './context.js';

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
 const result=await db.query(`WITH RECURSIVE chain(id,merged_into) AS (
  SELECT t.id,CASE WHEN t.merged_into IS NOT NULL THEN COALESCE(tm.topic_id,t.merged_into) END
  FROM dialogues_live.topics t LEFT JOIN dialogues_live.topic_members tm ON tm.owner_id=t.owner_id AND tm.dialogue_id=t.home_dialogue_id
  WHERE t.owner_id=$1 AND t.id=$2
  UNION SELECT t.id,CASE WHEN t.merged_into IS NOT NULL THEN COALESCE(tm.topic_id,t.merged_into) END
  FROM chain c JOIN dialogues_live.topics t ON t.owner_id=$1 AND t.id=c.merged_into
  LEFT JOIN dialogues_live.topic_members tm ON tm.owner_id=t.owner_id AND tm.dialogue_id=t.home_dialogue_id
 ) SELECT id FROM chain WHERE merged_into IS NULL`,[owner,id]);
 return result.rows[0]?.id??fail('NOT_FOUND');
}

/** Выбирает недавние карточки; для старых тем остаётся только доступ по ID и поиск. */
export async function recentTopics(db:PoolClient,owner:string,pinned?:string){
 return (await db.query(`SELECT t.id AS topic_id,left(t.title,128) AS title,max(COALESCE(m.occurred_at,m.recorded_at)) AS last_activity,
  s.version,s.extended,s.compact,s.extended_tokens,s.compact_tokens,s.source_refs
  FROM dialogues_live.topics t JOIN dialogues_live.topic_members tm ON tm.owner_id=t.owner_id AND tm.topic_id=t.id
  JOIN LATERAL (SELECT occurred_at,recorded_at FROM dialogues_live.messages m
   WHERE m.owner_id=tm.owner_id AND m.dialogue_id=tm.dialogue_id AND ${visibleMessage}
   ORDER BY COALESCE(occurred_at,recorded_at) DESC,m.change_seq DESC LIMIT 1) m ON true
  LEFT JOIN LATERAL (SELECT version,extended,compact,extended_tokens,compact_tokens,source_refs FROM dialogues_live.topic_summaries
   WHERE owner_id=t.owner_id AND topic_id=t.id AND membership_version=t.membership_version ORDER BY version DESC LIMIT 1) s ON true
  WHERE t.owner_id=$1 AND t.merged_into IS NULL
  GROUP BY t.id,t.title,s.version,s.extended,s.compact,s.extended_tokens,s.compact_tokens,s.source_refs
  ORDER BY (t.id IS NOT DISTINCT FROM $2) DESC,last_activity DESC,t.id LIMIT 220`,[owner,pinned??null])).rows;
}

/** Выдаёт компактные совпадения без передачи целых сообщений поисковому клиенту. */
export async function searchArchive(db:PoolClient,owner:string,query:string,topic?:string){
 const messageMatches=await db.query(`WITH q AS (
  SELECT plainto_tsquery('pg_catalog.russian',$2) AS words
 ), matched AS (
  SELECT m.dialogue_id,m.id AS message_id,tm.topic_id,m.text,
   strpos(lower(m.text),lower($2)) AS position, m.change_seq,
   ts_rank((${vector}),(SELECT words FROM q)) AS rank
  FROM dialogues_live.messages m
  LEFT JOIN dialogues_live.topic_members tm ON tm.owner_id=m.owner_id AND tm.dialogue_id=m.dialogue_id
  WHERE m.owner_id=$1 AND ($3::text IS NULL OR tm.topic_id=$3) AND ${visibleMessage}
   AND ((${vector}) @@ (SELECT words FROM q) OR strpos(lower(m.text),lower($2))>0)
  ORDER BY (strpos(lower(m.text),lower($2))>0) DESC,rank DESC,m.change_seq DESC,m.dialogue_id,m.id LIMIT 20
 ) SELECT dialogue_id,message_id,topic_id,position>0 AS exact,
  CASE WHEN position>0 THEN greatest(0,position-41) END AS offset,
  substring(text FROM greatest(1,position-40) FOR 240) AS snippet
 FROM matched ORDER BY (position>0) DESC,rank DESC,change_seq DESC,dialogue_id,message_id`,[owner,query,topic??null]);
 const topicMatches=await db.query(`SELECT t.id AS topic_id,left(t.title,128) AS title,
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
 async function get(owner:string,id:string,after?:string){
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
   const receipt={dialogue_id:dialogue,topic_id:topic};
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
 await db.query('UPDATE dialogues_live.topics SET membership_version=membership_version+1 WHERE owner_id=$1 AND id=ANY($2::text[])',[owner,[previous,target]]);
 await db.query(`UPDATE dialogues_live.topics SET merged_into=$3 WHERE owner_id=$1 AND id=$2 AND NOT EXISTS
  (SELECT 1 FROM dialogues_live.topic_members WHERE owner_id=$1 AND topic_id=$2)`,[owner,previous,target]);
 return target;
}
