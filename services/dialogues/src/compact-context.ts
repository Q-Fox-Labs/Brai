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
type LegacyTopicCard={topic_id:string;title:string|null;last_activity:Date;version:string|null;extended:string|null;compact:string|null;
 extended_tokens:number|null;compact_tokens:number|null;source_refs:unknown[]|null};

/** Строит проекцию карточек, включая замену формата и удаление вытесненных тем. */
export function topicCardChanges(topics:LegacyTopicCard[],previous:View){
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
 const selected=(await db.query(`SELECT 'M'||m.short_id AS message_id,m.role,
  GREATEST(m.change_seq,c.change_seq,s.change_seq,CASE WHEN m.kind='final' THEN t.completion_seq END)::text AS revision,
  char_length(m.text)<=100 AS exact,
  CASE WHEN char_length(m.text)<=100 THEN m.text ELSE COALESCE(c.text,s.text) END AS text
 FROM dialogues_live.messages m
 JOIN dialogues_live.turns t ON t.owner_id=m.owner_id AND t.dialogue_id=m.dialogue_id AND t.id=m.turn_id
 LEFT JOIN LATERAL (SELECT version,text,change_seq FROM dialogues_live.message_summaries
  WHERE owner_id=m.owner_id AND dialogue_id=m.dialogue_id AND message_id=m.id AND change_seq<=$2 ORDER BY version DESC LIMIT 1) s ON char_length(m.text)>100
 LEFT JOIN dialogues_live.message_compact_summaries c ON c.owner_id=m.owner_id AND c.dialogue_id=m.dialogue_id
  AND c.message_id=m.id AND c.source_version=s.version AND c.change_seq<=$2
 WHERE m.owner_id=$1 AND m.change_seq<=$2 AND ${visibleMessage}
  AND ($3::text IS NULL OR m.dialogue_id<>$3 OR (NOT $7::boolean AND NOT(m.id=ANY($4::text[]))))
  AND ($5::boolean OR m.change_seq>$6 OR GREATEST(c.change_seq,s.change_seq)>$6
   OR (m.kind='final' AND t.completion_seq>$6))
 ORDER BY COALESCE(m.occurred_at,m.recorded_at) DESC,m.change_seq DESC,m.dialogue_id,m.id
 LIMIT (CASE WHEN $5::boolean THEN 20 ELSE NULL END)`,
 [owner,boundary,dialogue??null,inputIds,bootstrap,checkpoint,Boolean(automatic&&!bootstrap)])).rows.reverse();
 const messageLine=({text,message_id,role,exact}:any)=>{
  const speaker=role==='user'?'Пользователь':'Агент';
  if(text===null)return message_id+' '+speaker+' [оригинал по запросу]';
  const label=exact?' ':' [свёртка] ';
  return message_id+' '+speaker+label+quote(exact?text:contextExcerpt(text,topicLimits.message).text);
 };
 const active=(await db.query(`SELECT t.dialogue_id,'D'||d.short_id AS dialogue_ref,t.id AS turn_id,t.version,t.status,t.purpose,t.constraints_text,t.change_seq::text AS revision,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'formulation',r.formulation) ORDER BY r.id)
   FROM dialogues_live.turn_results r WHERE r.owner_id=t.owner_id AND r.dialogue_id=t.dialogue_id AND r.turn_id=t.id
   AND r.kind='work' AND r.status='pending'),'[]'::jsonb) AS pending
 FROM dialogues_live.turns t JOIN dialogues_live.dialogues d ON d.owner_id=t.owner_id AND d.id=t.dialogue_id
 WHERE t.owner_id=$1 AND t.managed AND ($4::text IS NULL OR t.dialogue_id<>$4)
 AND (CASE WHEN $2::boolean THEN t.status<>'completed' ELSE t.change_seq>$3 END)
 ORDER BY t.dialogue_id,t.id`,[owner,bootstrap,checkpoint,automatic?dialogue??null:null])).rows;
 const workLine=({purpose,constraints_text,pending,dialogue_id,turn_id,version,status}:any)=>{
  const reference='Ход '+quote(dialogue_id)+' '+quote(turn_id)+' '+quote(version)+' '+quote(status);
  if(status==='completed')return reference;
  const detail=contextExcerpt(JSON.stringify({purpose,constraints:constraints_text,pending}),topicLimits.message);
  return reference+' '+quote(detail.text)+(detail.truncated?' [подробнее в snapshot]':'');
 };
 const messages=selected.map(row=>({revision:BigInt(row.revision),line:messageLine(row)}));
 const work=active.map(row=>({revision:BigInt(row.revision),line:workLine(row)}));
 const heading=bootstrap?'Последние сообщения':'Новые сообщения';
 const remaining='Остальные изменения придут при следующем input.';
 let through=BigInt(boundary);
 const budget=limits.requestBytes-limits.responseBytes-limits.metadataBytes;
 const fixed=[indexInstruction,...lines];
 const render=()=>{
  const visible=messages.filter(row=>row.revision<=through).map(row=>row.line);
  return [...fixed,...(visible.length?[heading,...visible]:[]),...work.filter(row=>row.revision<=through).map(row=>row.line),
   ...(through<BigInt(boundary)?[remaining]:[])].join('\n');
 };
 let text=render();
 const tokenBudget=20*topicLimits.extended+200*topicLimits.compact+20*topicLimits.message;
 if(automatic&&(bytes({text})>budget||!bootstrap&&text.length>tokenBudget&&countContextTokens(text)>tokenBudget)){
  const revisions=new Map<bigint,{bytes:number;tokens:number}>();
  for(const row of [...messages,...work]){
   const cost=revisions.get(row.revision)??{bytes:0,tokens:0};
   cost.bytes+=bytes(row.line)+1;
   cost.tokens+=countContextTokens(row.line)+1;
   revisions.set(row.revision,cost);
  }
  const prefix=[...fixed,heading,remaining].join('\n');
  let availableBytes=budget-bytes({text:prefix});
  let availableTokens=bootstrap?Infinity:Math.max(0,tokenBudget-countContextTokens(prefix));
  for(const [index,[revision,cost]] of Array.from(revisions).sort(([a],[b])=>a<b?-1:1).entries()){
   if(cost.bytes>availableBytes||cost.tokens>availableTokens&&(index>0||lines.length>0)){through=revision-1n;break;}
   availableBytes-=cost.bytes;
   availableTokens-=cost.tokens;
  }
  text=render();
 }
 const items=lines.length||messages.length||work.length?[{type:'context_index',text}]:[];
 return {items,view,through:String(through),selected:messages.filter(row=>row.revision<=through).length,missing:topics.filter(topic=>!topic.version).length};
}

/** Считает карточки и новые сообщения внутри той же транзакции, что и выдачу. */
export async function collectLegacyCompact(db:PoolClient,owner:string,options:{
 boundary:string;checkpoint:string;bootstrap:boolean;dialogue?:string;inputIds:string[];previous:View
}){
 const {boundary,checkpoint,bootstrap,dialogue,inputIds,previous}=options;
 const pinned=await referencedTopic(db,owner,dialogue);
 const topics=await recentTopics(db,owner,pinned,undefined,true);
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
 return {items,view,through:boundary,selected: selected.length,missing:topics.filter(t=>!t.version).length};
}
