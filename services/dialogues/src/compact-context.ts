// ABOUTME: Собирает ограниченный стартовый контекст из тем и свежих сообщений.
// ABOUTME: Тексты архива дочитываются по ссылкам, изменения считаются от подтверждённой выдачи.
import type {PoolClient} from 'pg';
import {Tiktoken} from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';
import {bytes,digest,limits} from './domain.js';
import {recentTopics,visibleMessage} from './topics.js';
import {linkedDialogueIds,matchesTopicReference} from './topic-references.js';

export const topicLimits={extended:400,compact:50,message:200} as const;
let encoding:Tiktoken|undefined;
/** Измеряет обычный текст закреплённым токенизатором o200k_base. */
export function countContextTokens(text:string){
 return (encoding??=new Tiktoken(o200k)).encode(text,[],[]).length;
}

/** Даёт выдержку саммари в пределах лимита выдачи соответствующего уровня. */
export function contextExcerpt(text:string,limit:number){
 const tokenizer=encoding??=new Tiktoken(o200k);
 // AIDEV-NOTE: Токенизация длинной непрерывной строки дорогая. Для выдержки достаточно ограниченного начала.
 const prefix=text.slice(0,limit*4).replace(/[\uD800-\uDBFF]$/u,'');
 const encoded=tokenizer.encode(prefix,[],[]);
 return encoded.length<=limit?{text:prefix,truncated:prefix.length<text.length}:
  {text:tokenizer.decode(encoded.slice(0,limit)).replace(/\uFFFD$/u,'').trimEnd(),truncated:true};
}

type View=Record<string,string>;
type TopicCard={topic_id:string;title:string|null;version:string|null;extended:string|null;compact:string|null};

const quote=(value:string)=>JSON.stringify(value);
const indexInstruction='В dialogues_exchange: topic_get(T…) — свёртки бесед; dialogue_get(D…) — сообщения; read_many([M…]) — оригиналы. -T… убирает тему из списка.';

/** Сравнивает короткие строки с последней подтверждённой выдачей. */
export function topicIndexChanges(topics:TopicCard[],previous:View){
 const lines:string[]=[];
 const view:View={};
 for(const [index,{topic_id,title,extended,compact}] of topics.entries()){
  const summary=index<20?extended:compact;
  const line=topic_id+' '+quote(title??'')+' '+(summary?quote(summary):'[свёртка готовится]');
  view[topic_id]=digest(line);
  if(previous[topic_id]!==view[topic_id])lines.push(line);
 }
 for(const id of Object.keys(previous))if(!Object.hasOwn(view,id))lines.push('-'+id);
 return {lines,view};
}

/** Ищет однозначную отсылку по номеру задачи, имени файла или названию темы. */
async function referencedTopic(db:PoolClient,owner:string,dialogue:string|undefined){
 if(!dialogue)return undefined;
 // AIDEV-NOTE: Используем первый ввод текущего треда, без запуска Луны в запросе.
 const message=(await db.query(`SELECT m.text FROM dialogues_live.messages m
 WHERE m.owner_id=$1 AND m.dialogue_id=$2 AND m.kind='input' ORDER BY m.message_order LIMIT 1`,[owner,dialogue])).rows[0];
 if(!message)return undefined;
 const candidates=(await db.query(`SELECT t.id,COALESCE(t.title,'') AS title,s.extended,
  EXISTS(SELECT 1 FROM dialogues_live.topic_members linked
   WHERE linked.owner_id=t.owner_id AND linked.topic_id=t.id AND linked.dialogue_id=ANY($3::text[])) AS linked
 FROM dialogues_live.topics t
 JOIN LATERAL (SELECT extended FROM dialogues_live.topic_summaries
  WHERE owner_id=t.owner_id AND topic_id=t.id AND membership_version=t.membership_version ORDER BY version DESC LIMIT 1) s ON true
 WHERE t.owner_id=$1 AND t.merged_into IS NULL
 AND NOT EXISTS(SELECT 1 FROM dialogues_live.topic_members tm WHERE tm.owner_id=t.owner_id AND tm.topic_id=t.id AND tm.dialogue_id=$2)`,[owner,dialogue,linkedDialogueIds(message.text)])).rows;
 const linked=candidates.filter(candidate=>candidate.linked);
 if(linked.length)return linked.length===1?linked[0].id:undefined;
 const matches=candidates.filter(candidate=>matchesTopicReference(message.text,candidate.title,candidate.extended));
 return matches.length===1?matches[0].id:undefined;
}

/** Считает карточки и новые сообщения внутри той же транзакции, что и выдачу. */
export async function collectCompact(db:PoolClient,owner:string,options:{
 boundary:string;checkpoint:string;bootstrap:boolean;dialogue?:string;inputIds:string[];automatic?:boolean;previous:View
}){
 const {boundary,checkpoint,bootstrap,dialogue,inputIds,automatic,previous}=options;
 const pinned=await referencedTopic(db,owner,dialogue);
 const topics=await recentTopics(db,owner,pinned,automatic?dialogue:undefined);
 const {lines,view}=topicIndexChanges(topics,previous);
 const selected=(await db.query(`SELECT 'M'||m.short_id AS message_id,'D'||d.short_id AS dialogue_ref,m.role,
  c.text IS NULL AND char_length(m.text)<=100 AS exact,
  COALESCE(c.text,CASE WHEN char_length(m.text)<=100 THEN m.text ELSE s.text END) AS text
 FROM dialogues_live.messages m
 JOIN dialogues_live.dialogues d ON d.owner_id=m.owner_id AND d.id=m.dialogue_id
 JOIN dialogues_live.turns t ON t.owner_id=m.owner_id AND t.dialogue_id=m.dialogue_id AND t.id=m.turn_id
 LEFT JOIN LATERAL (SELECT version,text,change_seq FROM dialogues_live.message_summaries
  WHERE owner_id=m.owner_id AND dialogue_id=m.dialogue_id AND message_id=m.id AND change_seq<=$2 ORDER BY version DESC LIMIT 1) s ON true
 LEFT JOIN dialogues_live.message_compact_summaries c ON c.owner_id=m.owner_id AND c.dialogue_id=m.dialogue_id
  AND c.message_id=m.id AND c.source_version=CASE WHEN char_length(m.text)<=100 THEN 0 ELSE s.version END AND c.change_seq<=$2
 WHERE m.owner_id=$1 AND m.change_seq<=$2 AND ${visibleMessage}
  AND ($3::text IS NULL OR m.dialogue_id<>$3 OR (NOT $7::boolean AND NOT(m.id=ANY($4::text[]))))
  AND ($5::boolean OR m.change_seq>$6 OR GREATEST(c.change_seq,s.change_seq)>$6
   OR (m.kind='final' AND t.completion_seq>$6))
 ORDER BY COALESCE(m.occurred_at,m.recorded_at) DESC,m.change_seq DESC,m.dialogue_id,m.id
 LIMIT (CASE WHEN $5::boolean THEN 20 ELSE NULL END)`,
 [owner,boundary,dialogue??null,inputIds,bootstrap,checkpoint,Boolean(automatic&&!bootstrap)])).rows.reverse();
 const messages:string[]=[];
 if(selected.length)messages.push(bootstrap?'Последние сообщения':'Новые сообщения');
 for(const {text,message_id,role,exact} of selected){
  const speaker=role==='user'?'Пользователь':'Агент';
  if(!text){messages.push(message_id+' '+speaker+' [оригинал по запросу]');continue;}
  const excerpt=contextExcerpt(text,topicLimits.message);
  const label=exact?(excerpt.truncated?' [выдержка] ':' '):' [свёртка] ';
  messages.push(message_id+' '+speaker+label+quote(excerpt.text));
 }
 const active=(await db.query(`SELECT t.dialogue_id,'D'||d.short_id AS dialogue_ref,t.id AS turn_id,t.version,t.status,t.purpose,t.constraints_text,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'formulation',r.formulation) ORDER BY r.id)
   FROM dialogues_live.turn_results r WHERE r.owner_id=t.owner_id AND r.dialogue_id=t.dialogue_id AND r.turn_id=t.id
   AND r.kind='work' AND r.status='pending'),'[]'::jsonb) AS pending
 FROM dialogues_live.turns t JOIN dialogues_live.dialogues d ON d.owner_id=t.owner_id AND d.id=t.dialogue_id
 WHERE t.owner_id=$1 AND t.managed AND ($4::text IS NULL OR t.dialogue_id<>$4)
 AND (CASE WHEN $2::boolean THEN t.status<>'completed' ELSE t.change_seq>$3 END)
 ORDER BY t.dialogue_id,t.id`,[owner,bootstrap,checkpoint,automatic?dialogue??null:null])).rows;
 const work:string[]=[];
 for(const {purpose,constraints_text,pending,dialogue_id,turn_id,version,status} of active){
  const reference='Ход '+quote(dialogue_id)+' '+quote(turn_id)+' '+quote(version)+' '+quote(status);
  if(status==='completed'){work.push(reference);continue;}
  const detail=contextExcerpt(JSON.stringify({purpose,constraints:constraints_text,pending}),topicLimits.message);
  work.push(reference+' '+quote(detail.text)+(detail.truncated?' [подробнее в snapshot]':''));
 }
 let text=[indexInstruction,...lines,...messages,...work].join('\n');
 if(automatic&&bytes({text})>limits.requestBytes-limits.responseBytes-limits.metadataBytes){
  const byDialogue=new Map<string,number>();
  for(const {dialogue_ref} of selected)byDialogue.set(dialogue_ref,(byDialogue.get(dialogue_ref)??0)+1);
  text=[indexInstruction,...lines,'Сообщения по беседам',
   ...Array.from(byDialogue,([id,count])=>id+' '+count),
   ...active.map(({dialogue_ref,status})=>dialogue_ref+' '+status)].join('\n');
 }
 const items=lines.length||messages.length||work.length?[{type:'context_index',text}]:[];
 return {items,view,selected:selected.length,missing:topics.filter(topic=>!topic.version).length};
}
