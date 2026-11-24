// ABOUTME: Собирает ограниченный стартовый контекст из тем и свежих сообщений.
// ABOUTME: Тексты архива дочитываются по ссылкам, изменения считаются от подтверждённой выдачи.
import type {PoolClient} from 'pg';
import {Tiktoken} from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';
import {recentTopics,visibleMessage} from './topics.js';

export const topicLimits={extended:400,compact:50,message:200} as const;
let encoding:Tiktoken|undefined;
/** Измеряет обычный текст закреплённым токенизатором o200k_base. */
export function countContextTokens(text:string){
 return (encoding??=new Tiktoken(o200k)).encode(text,[],[]).length;
}

type View=Record<string,string>;
type TopicCard={topic_id:string;title:string|null;last_activity:Date;version:string|null;extended:string|null;compact:string|null;
 extended_tokens:number|null;compact_tokens:number|null;source_refs:unknown[]|null};

/** Строит проекцию карточек, включая замену формата и удаление вытесненных тем. */
export function topicCardChanges(topics:TopicCard[],previous:View){
 const items:Record<string,unknown>[]=[];
 const view:View={};
 for(const [i,topic] of topics.entries()){
  const tier=i<20?'extended':'compact';
  const identity=topic.topic_id;
  const version=topic.version??null;
  view[identity]=JSON.stringify([version,tier,topic.title,topic.last_activity]);
  if(previous[identity]===view[identity])continue;
  items.push({type:'topic_summary',topic_id:identity,title:topic.title,last_activity:topic.last_activity,tier,version,
   text:topic[tier],tokens:topic[tier==='extended'?'extended_tokens':'compact_tokens'],summary_status:version?'ready':'pending',
   ...(tier==='extended'&&topic.source_refs?.length?{source_refs:topic.source_refs}:{})});
 }
 for(const id of Object.keys(previous))if(!Object.hasOwn(view,id))items.push({type:'topic_removed',topic_id:id});
 return {items,view};
}

/** Ищет однозначную отсылку по номеру задачи, имени файла или названию темы. */
async function referencedTopic(db:PoolClient,owner:string,dialogue:string|undefined){
 if(!dialogue)return undefined;
 // AIDEV-NOTE: Используем первый ввод текущего треда, без запуска Луны в запросе.
 const message=(await db.query(`SELECT m.text FROM dialogues_live.messages m
 WHERE m.owner_id=$1 AND m.dialogue_id=$2 AND m.kind='input' ORDER BY m.message_order LIMIT 1`,[owner,dialogue])).rows[0];
 if(!message)return undefined;
 const candidates=(await db.query(`SELECT t.id FROM dialogues_live.topics t
 LEFT JOIN LATERAL (SELECT extended FROM dialogues_live.topic_summaries
  WHERE owner_id=t.owner_id AND topic_id=t.id AND membership_version=t.membership_version ORDER BY version DESC LIMIT 1) s ON true
 WHERE t.owner_id=$1 AND t.merged_into IS NULL AND s.extended IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM dialogues_live.topic_members tm WHERE tm.owner_id=t.owner_id AND tm.topic_id=t.id AND tm.dialogue_id=$2)
 AND ((t.title IS NOT NULL AND lower(t.title)<>lower($2) AND strpos(lower($3),lower(t.title))>0 AND cardinality(string_to_array(t.title,' '))>=2)
  OR EXISTS (SELECT 1 FROM regexp_matches($3,'(PR[[:space:]#]*[0-9]+|[[:alnum:]_-]+[.](ts|js|py|yml|md))','gi') r
    WHERE strpos(lower(s.extended),lower(r[1]))>0)) LIMIT 2`,[owner,dialogue,message.text])).rows;
 return candidates.length===1?candidates[0].id:undefined;
}

/** Считает карточки и новые сообщения внутри той же транзакции, что и выдачу. */
export async function collectCompact(db:PoolClient,owner:string,options:{
 boundary:string;checkpoint:string;bootstrap:boolean;dialogue?:string;inputIds:string[];previous:View
}){
 const {boundary,checkpoint,bootstrap,dialogue,inputIds,previous}=options;
 const pinned=await referencedTopic(db,owner,dialogue);
 const topics=await recentTopics(db,owner,pinned);
 const {items,view}=topicCardChanges(topics,previous);
 const selected=(await db.query(`SELECT m.id AS message_id,m.dialogue_id,m.role,m.kind,m.message_order,
  COALESCE(m.occurred_at,m.recorded_at) AS occurred_at,m.change_seq,
  COALESCE(c.text,CASE WHEN char_length(m.text)<=100 THEN m.text ELSE s.text END) AS text,
  c.text IS NULL AND char_length(m.text)<=100 AS exact,GREATEST(c.change_seq,s.change_seq) AS summary_change_seq,
  CASE WHEN m.kind='final' THEN t.completion_seq END AS completion_seq
 FROM dialogues_live.messages m
 JOIN dialogues_live.turns t ON t.owner_id=m.owner_id AND t.dialogue_id=m.dialogue_id AND t.id=m.turn_id
 LEFT JOIN LATERAL (SELECT version,text,change_seq FROM dialogues_live.message_summaries
  WHERE owner_id=m.owner_id AND dialogue_id=m.dialogue_id AND message_id=m.id AND change_seq<=$2 ORDER BY version DESC LIMIT 1) s ON true
 LEFT JOIN dialogues_live.message_compact_summaries c ON c.owner_id=m.owner_id AND c.dialogue_id=m.dialogue_id
  AND c.message_id=m.id AND c.source_version=CASE WHEN char_length(m.text)<=100 THEN 0 ELSE s.version END AND c.change_seq<=$2
 WHERE m.owner_id=$1 AND m.change_seq<=$2 AND ${visibleMessage}
  AND ($3::text IS NULL OR m.dialogue_id<>$3 OR NOT(m.id=ANY($4::text[])))
  AND ($5::boolean OR m.change_seq>$6 OR GREATEST(c.change_seq,s.change_seq)>$6
   OR (m.kind='final' AND t.completion_seq>$6))
 ORDER BY COALESCE(m.occurred_at,m.recorded_at) DESC,m.change_seq DESC,m.dialogue_id,m.id
 LIMIT (CASE WHEN $5::boolean THEN 20 ELSE NULL END)`,
 [owner,boundary,dialogue??null,inputIds,bootstrap,checkpoint])).rows.reverse();
 for(const {text,exact,change_seq,summary_change_seq,completion_seq,...message} of selected){
  const tokens=text?countContextTokens(text):0;
  items.push({type:'message_representation',...message,
   ...(tokens>0&&tokens<=topicLimits.message?{text,tokens,representation:exact?'original':'summary'}:{representation:'reference',read_action:'read'})});
 }
 const active=(await db.query(`SELECT t.dialogue_id,t.id AS turn_id,t.version,t.status,t.purpose,t.constraints_text,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'formulation',r.formulation) ORDER BY r.id)
   FROM dialogues_live.turn_results r WHERE r.owner_id=t.owner_id AND r.dialogue_id=t.dialogue_id AND r.turn_id=t.id
   AND r.kind='work' AND r.status='pending'),'[]'::jsonb) AS pending
 FROM dialogues_live.turns t WHERE t.owner_id=$1 AND t.managed
 AND (CASE WHEN $2::boolean THEN t.status<>'completed' ELSE t.change_seq>$3 END)
 ORDER BY t.dialogue_id,t.id`,[owner,bootstrap,checkpoint])).rows;
 for(const {purpose,constraints_text,pending,...turn} of active){
  if(turn.status==='completed'){items.push({type:'turn_closed',...turn});continue;}
  items.push({type:'turn_work',...turn,text:JSON.stringify({purpose,constraints:constraints_text,pending}),read_action:'snapshot'});
 }
 return {items,view,selected: selected.length,missing:topics.filter(t=>!t.version).length};
}
