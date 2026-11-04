// ABOUTME: Хранит live-диалоги и собирает ограниченные снимки контекста PostgreSQL.
// ABOUTME: Каждая запись блокирует владельца до commit; архивная схема не используется.
import type { Pool, PoolClient } from "pg";
import {createTurns} from "./turns.js";
import {createContext} from "./context.js";
import {enqueueDialogue} from "./jobs.js";
import { createHash } from "node:crypto";
import { appendInput, summaryInput, canonical, digest, decodeCursor, encodeCursor, fail, id, integer, object, limits, type Cursor, DialoguesFault } from "./domain.js";

const sha=(s:string)=>createHash("sha256").update(s,"utf8").digest("hex");
const headSQL="SELECT COALESCE(MAX(change_seq),0)::text AS seq FROM dialogues_live.requests WHERE owner_id=$1";
const cleanFault=(e:any)=> e instanceof DialoguesFault ? e : new DialoguesFault(e?.code==="23505"?"CONFLICT":e?.code==="23503"?"NOT_FOUND":e?.code==="22003"?"INVALID_ARGUMENT":"INTERNAL");
type DB=Pick<Pool,"connect">;
/** Соединяет предметные правила с приватной live-схемой, без доступа к архиву. */
export function createStore(pool:DB,key:string) {
  async function mutation(owner:string,requestId:string,operation:string,input:unknown,write:(db:PoolClient,seq:string)=>Promise<any>) {
    const db=await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["dialogues-live:"+owner]);
      const hash=digest(input);
      const old=(await db.query("SELECT operation,hash,result FROM dialogues_live.requests WHERE owner_id=$1 AND id=$2",[owner,requestId])).rows[0];
      if(old) {
        if(old.operation!==operation||old.hash!==hash)fail("REQUEST_CONFLICT");
        await db.query("COMMIT");return old.result;
      }
      const seq=(await db.query("SELECT nextval('dialogues_live.change_seq')::text AS seq")).rows[0].seq;
      const result=await write(db,seq);
      await db.query("INSERT INTO dialogues_live.requests(owner_id,id,operation,hash,result,change_seq) VALUES($1,$2,$3,$4,$5,$6)",[owner,requestId,operation,hash,result,seq]);
      await db.query("COMMIT");
      return result;
    } catch(e) {await db.query("ROLLBACK").catch(()=>{});throw cleanFault(e);}
    finally {db.release();}
  }
  async function append(owner:string,raw:unknown) {
    const arg=appendInput(raw);
    return mutation(owner,arg.request_id,"messages_append",arg,async(db,seq)=>{
      const d=arg.dialogue;
      const existing=(await db.query("SELECT channel FROM dialogues_live.dialogues WHERE owner_id=$1 AND id=$2",[owner,d.id])).rows[0];
      if(existing&&existing.channel!==d.channel)fail("DIALOGUE_CONFLICT");
      await db.query("INSERT INTO dialogues_live.dialogues(owner_id,id,channel,title) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,id) DO NOTHING",[owner,d.id,d.channel,d.title??d.id]);
      if(d.title!==undefined)await db.query("UPDATE dialogues_live.dialogues SET title=$3 WHERE owner_id=$1 AND id=$2",[owner,d.id,d.title]);
      const saved=[];let enqueue=false;
      for(const m of arg.messages) {
        const previous=(await db.query("SELECT payload,content_hash,message_order FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3",[owner,d.id,m.id])).rows[0];
        const {summary,turn_status,...payload}=m;
        if(previous) {
          if(canonical(previous.payload)!==canonical(payload))fail("MESSAGE_CONFLICT");
          if(summary!==undefined) {
            const current=(await db.query("SELECT text FROM dialogues_live.message_summaries WHERE owner_id=$1 AND dialogue_id=$2 AND message_id=$3 ORDER BY version DESC LIMIT 1",[owner,d.id,m.id])).rows[0];
            if(current&&current.text!==summary)fail("SUMMARY_CONFLICT");
            if(!current)await db.query("INSERT INTO dialogues_live.message_summaries(owner_id,dialogue_id,message_id,version,text,source_hash,change_seq) VALUES($1,$2,$3,1,$4,$5,$6)",[owner,d.id,m.id,summary,previous.content_hash,seq]);
          }
          saved.push({id:m.id,sha256:previous.content_hash,message_order:previous.message_order,replayed:true});
          continue;
        }
        const turn=(await db.query("SELECT turn_order,managed,status,reconciled_through_order FROM dialogues_live.turns WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3",[owner,d.id,m.turn_id])).rows[0];
        if(turn?.managed && (m.kind!=="final" || turn.status==="completed"))fail("MANAGED_TURN_REQUIRES_TURN_OPERATIONS");
        if(turn?.managed && (await db.query("SELECT 1 FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3 AND kind='final' AND message_order>COALESCE($4::bigint,-1)",[owner,d.id,m.turn_id,turn.reconciled_through_order])).rowCount)fail("FINAL_RECONCILIATION_REQUIRED");
        if(turn&&!turn.managed&&m.kind!=='final'&&m.turn_status!==undefined&&m.turn_status!=='completed'&&(await db.query("SELECT 1 FROM dialogues_live.turns WHERE owner_id=$1 AND dialogue_id=$2 AND managed AND status<>'completed'",[owner,d.id])).rowCount)fail('MANAGED_TURN_OPEN');
        if(!turn && (await db.query("SELECT 1 FROM dialogues_live.turns WHERE owner_id=$1 AND dialogue_id=$2 AND managed AND status<>'completed'",[owner,d.id])).rowCount)fail("MANAGED_TURN_OPEN");
        if(turn&&m.turn_order!==undefined&&String(m.turn_order)!==turn.turn_order)fail("TURN_CONFLICT");
        const turnOrder=m.turn_order??(turn?Number(turn.turn_order):Number((await db.query("SELECT COALESCE(MAX(turn_order),-1)+1 AS n FROM dialogues_live.turns WHERE owner_id=$1 AND dialogue_id=$2",[owner,d.id])).rows[0].n));
        integer(turnOrder);
        await db.query("INSERT INTO dialogues_live.turns(owner_id,dialogue_id,id,turn_order,status,change_seq) VALUES($1,$2,$3,$4,'in_progress',$5) ON CONFLICT(owner_id,dialogue_id,id) DO NOTHING",[owner,d.id,m.turn_id,turnOrder,seq]);
        const tail=(await db.query("SELECT COALESCE(MAX(message_order),-1)::text AS n FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2",[owner,d.id])).rows[0].n;
        const order=m.message_order??Number(BigInt(tail)+1n);
        if(BigInt(order)<=BigInt(tail))fail("ORDER_CONFLICT");
        const item=m.item_order??Number((await db.query("SELECT COALESCE(MAX(item_order),-1)+1 AS n FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND turn_id=$3",[owner,d.id,m.turn_id])).rows[0].n);
        integer(order);integer(item);
        const hash=sha(m.text);
        await db.query("INSERT INTO dialogues_live.messages(owner_id,dialogue_id,turn_id,id,role,kind,message_order,item_order,text,payload,content_hash,occurred_at,source,change_seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",[owner,d.id,m.turn_id,m.id,m.role,m.kind,order,item,m.text,payload,hash,m.occurred_at,m.source,seq]);
        if(summary!==undefined)await db.query("INSERT INTO dialogues_live.message_summaries(owner_id,dialogue_id,message_id,version,text,source_hash,change_seq) VALUES($1,$2,$3,1,$4,$5,$6)",[owner,d.id,m.id,summary,hash,seq]);
        const status=turn?.managed?undefined:(m.kind==="final"?"completed":m.turn_status);
        if(turn?.managed)await db.query("UPDATE dialogues_live.turns SET version=version+1,updated_at=now(),change_seq=$4 WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3",[owner,d.id,m.turn_id,seq]);
        if(status)await db.query("UPDATE dialogues_live.turns SET status=$4,completion_seq=CASE WHEN $4='completed' THEN COALESCE(completion_seq,$5) ELSE completion_seq END,change_seq=$5 WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3",[owner,d.id,m.turn_id,status,seq]);
        if(!turn?.managed)enqueue=true;
        saved.push({id:m.id,sha256:hash,message_order:String(order),replayed:false});
      }
      if(enqueue)await enqueueDialogue(db,owner,d.id,seq,false);
      return {request_id:arg.request_id,dialogue_id:d.id,change_seq:seq,messages:saved};
    });
  }
  async function summary(owner:string,raw:unknown) {
    const arg=summaryInput(raw);
    return mutation(owner,arg.request_id,"summary_put",arg,async(db,seq)=>{
      const sourceId=arg.target==="message"?arg.message_id:arg.through_message_id;
      const source=(await db.query("SELECT content_hash,message_order FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3",[owner,arg.dialogue_id,sourceId])).rows[0];
      if(!source)fail("NOT_FOUND");
      const table=arg.target==="message"?"message_summaries":"dialogue_summaries";
      const values:any[]=[owner,arg.dialogue_id];
      let where="owner_id=$1 AND dialogue_id=$2";
      if(arg.target==="message"){values.push(arg.message_id);where+=" AND message_id=$3";}
      const old=(await db.query("SELECT version"+(arg.target==="dialogue"?",through_order":"")+" FROM dialogues_live."+table+" WHERE "+where+" ORDER BY version DESC LIMIT 1",values)).rows[0];
      if((old?.version??null)!==arg.expected_version)fail("VERSION_CONFLICT");
      const version=old?String(BigInt(old.version)+1n):"1";
      if(arg.target==="message")await db.query("INSERT INTO dialogues_live.message_summaries(owner_id,dialogue_id,message_id,version,text,source_hash,change_seq) VALUES($1,$2,$3,$4,$5,$6,$7)",[owner,arg.dialogue_id,arg.message_id,version,arg.text,source.content_hash,seq]);
      else {
        if(old&&BigInt(source.message_order)<BigInt(old.through_order))fail("COVERAGE_CONFLICT");
        await db.query("INSERT INTO dialogues_live.dialogue_summaries(owner_id,dialogue_id,version,text,through_message_id,through_order,change_seq) VALUES($1,$2,$3,$4,$5,$6,$7)",[owner,arg.dialogue_id,version,arg.text,arg.through_message_id,source.message_order,seq]);
      }
      return {request_id:arg.request_id,target:arg.target,dialogue_id:arg.dialogue_id,message_id:arg.message_id??null,version,through_message_id:arg.through_message_id??null,change_seq:seq};
    });
  }
  async function message(owner:string,raw:unknown) {
    const a=object(raw,["dialogue_id","message_id","offset","limit","target","summary_version"]);
    id(a.dialogue_id);const target=a.target??'original';
    if(!['original','message_summary','dialogue_summary'].includes(target))fail('INVALID_ARGUMENT');
    if(target!=='dialogue_summary')id(a.message_id);else if(a.message_id!==undefined)fail('INVALID_ARGUMENT');
    if(a.summary_version!==undefined&&(typeof a.summary_version!=='string'||!/^[1-9][0-9]*$/.test(a.summary_version)||target==='original'))fail('INVALID_ARGUMENT');
    const offset=integer(a.offset,0),limit=integer(a.limit,4096);
    if(limit<1||limit>8192)fail("INVALID_ARGUMENT");
    const db=await pool.connect();
    try {
      if(target!=='original'){
        const row=(await db.query(target==='message_summary'
         ?"SELECT dialogue_id,message_id,version,source_hash,text FROM dialogues_live.message_summaries WHERE owner_id=$1 AND dialogue_id=$2 AND message_id=$3 AND ($4::bigint IS NULL OR version=$4) ORDER BY version DESC LIMIT 1"
         :"SELECT dialogue_id,version,through_message_id,through_order,text FROM dialogues_live.dialogue_summaries WHERE owner_id=$1 AND dialogue_id=$2 AND ($3::bigint IS NULL OR version=$3) ORDER BY version DESC LIMIT 1",
         target==='message_summary'?[owner,a.dialogue_id,a.message_id,a.summary_version??null]:[owner,a.dialogue_id,a.summary_version??null])).rows[0];
        if(!row)fail('NOT_FOUND');
        const chars=Array.from(row.text),total=chars.length;if(offset>total)fail('INVALID_OFFSET');
        const body={...row,target,representation:'summary_fragment',offset,text:chars.slice(offset,offset+limit).join(''),next_offset:offset+limit<total?offset+limit:null,total_chars:total,total_bytes:Buffer.byteLength(row.text),text_sha256:sha(row.text),offset_unit:'unicode_codepoints',text_complete:offset===0&&offset+limit>=total};
        return body;
      }
      const row=(await db.query("SELECT id,dialogue_id,turn_id,role,kind,message_order,item_order,source,occurred_at,recorded_at,content_hash AS sha256,substring(text FROM $4::integer FOR $5::integer) AS text,char_length(text) AS total_chars FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND id=$3",[owner,a.dialogue_id,a.message_id,offset+1,limit])).rows[0];
      if(!row)fail("NOT_FOUND");
      if(offset>row.total_chars)fail("INVALID_OFFSET");
      return {...row,offset,next_offset:offset+Array.from(row.text).length<row.total_chars?offset+Array.from(row.text).length:null};
    } catch(e){throw cleanFault(e);}finally{db.release();}
  }
  async function context(owner:string,raw:unknown) {
    const a=object(raw,["cursor","dialogue_id"]);
    if(a.dialogue_id!==undefined)id(a.dialogue_id);
    if(a.cursor!==undefined&&typeof a.cursor!=="string")fail("INVALID_CURSOR");
    const prior=a.cursor?decodeCursor(a.cursor,key,owner):null;
    if(prior&&a.dialogue_id!==undefined&&a.dialogue_id!==prior.scope)fail("INVALID_CURSOR");
    const db=await pool.connect();
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const max=(await db.query(headSQL,[owner])).rows[0].seq;
      const scope=prior?.scope??a.dialogue_id??null;
      const c:Cursor=prior&&prior.mode!=="checkpoint"?prior:{v:1,owner,scope,mode:prior?"delta":scope?"history":"bootstrap",from:prior?.through??"0",through:max,offset:0};
      if(BigInt(c.through)>BigInt(max))fail("INVALID_CURSOR");
      // AIDEV-NOTE: Cutoff selects immutable message/summary versions, never wall-clock dates.
      const conditions=c.mode==="history" ? "true" : c.mode==="bootstrap"
        ? "EXISTS(SELECT 1 FROM chosen x WHERE x.dialogue_id=m.dialogue_id AND x.id=m.turn_id)"
        : "(m.change_seq>$3 OR EXISTS(SELECT 1 FROM dialogues_live.message_summaries z WHERE z.owner_id=m.owner_id AND z.dialogue_id=m.dialogue_id AND z.message_id=m.id AND z.change_seq>$3 AND z.change_seq<=$2))";
      const chosen=`WITH chosen AS (
        SELECT t.dialogue_id,t.id,t.turn_order,MIN(f.change_seq) AS completed
        FROM dialogues_live.turns t
        JOIN dialogues_live.messages f ON f.owner_id=t.owner_id AND f.dialogue_id=t.dialogue_id
          AND f.turn_id=t.id AND f.kind='final' AND (NOT t.managed OR t.final_message_id=f.id) AND f.change_seq<=$2
        WHERE t.owner_id=$1 AND $3::bigint>=0 AND EXISTS(
          SELECT 1 FROM dialogues_live.messages u WHERE u.owner_id=t.owner_id
            AND u.dialogue_id=t.dialogue_id AND u.turn_id=t.id AND u.role='user' AND u.change_seq<=$2)
        GROUP BY t.dialogue_id,t.id,t.turn_order
        ORDER BY MIN(f.change_seq) DESC,t.turn_order DESC,t.dialogue_id,t.id LIMIT 50
      ), ds AS (
        SELECT DISTINCT ON(dialogue_id) dialogue_id,version,change_seq,through_order
        FROM dialogues_live.dialogue_summaries WHERE owner_id=$1 AND change_seq<=$2
        ORDER BY dialogue_id,version DESC
      ), candidates AS (`;
      const latestFinal=c.mode!=="bootstrap"?"":` AND (m.kind<>'final' OR m.message_order=(
        SELECT MAX(f.message_order) FROM dialogues_live.messages f
        WHERE f.owner_id=m.owner_id AND f.dialogue_id=m.dialogue_id AND f.turn_id=m.turn_id
          AND f.kind='final' AND f.change_seq<=$2))`;
      const query=chosen+`
        SELECT 'message' AS type,m.dialogue_id,m.turn_id,m.id,t.turn_order,m.message_order,0::bigint AS version
        FROM dialogues_live.messages m
        JOIN dialogues_live.turns t ON t.owner_id=m.owner_id AND t.dialogue_id=m.dialogue_id AND t.id=m.turn_id
        WHERE m.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM dialogues_live.turns z WHERE z.owner_id=m.owner_id AND z.dialogue_id=m.dialogue_id AND z.id=m.turn_id AND z.managed AND m.kind='final' AND z.final_message_id IS DISTINCT FROM m.id) AND m.change_seq<=$2 AND ($5::text IS NULL OR m.dialogue_id=$5)`
        +(c.mode==="bootstrap"?" AND m.kind<>'commentary'":"")+" AND "+conditions+latestFinal+`
        UNION ALL
        SELECT 'dialogue_summary',ds.dialogue_id,'','',-1::bigint,-1::bigint,ds.version
        FROM ds WHERE ($5::text IS NULL OR ds.dialogue_id=$5) AND `+(c.mode!=="delta"?"true":"ds.change_seq>$3")+`
        UNION ALL
        SELECT 'coverage_gap',m.dialogue_id,'','',-2::bigint,-2::bigint,0::bigint
        FROM dialogues_live.messages m LEFT JOIN ds ON ds.dialogue_id=m.dialogue_id
        WHERE m.owner_id=$1 AND NOT EXISTS(SELECT 1 FROM dialogues_live.turns z WHERE z.owner_id=m.owner_id AND z.dialogue_id=m.dialogue_id AND z.id=m.turn_id AND z.managed AND m.kind='final' AND z.final_message_id IS DISTINCT FROM m.id) AND m.change_seq<=$2 AND ($5::text IS NULL OR m.dialogue_id=$5)
          AND m.message_order>COALESCE(ds.through_order,-1) AND `
        +(c.mode!=="delta"?"true":"(m.change_seq>$3 OR ds.change_seq>$3)")+`
        GROUP BY m.dialogue_id
      ) SELECT * FROM candidates ORDER BY dialogue_id,turn_order,message_order,id,type LIMIT 65 OFFSET $4`;
      const candidates=(await db.query(query,[owner,c.through,c.from,c.offset,c.scope])).rows;
      const result:any={mode:c.mode,dialogue_id:c.scope,through_seq:c.through,dialogues:[],continuation_cursor:null,next_cursor:null};
      let taken=0;
      for(const item of candidates.slice(0,64)) {
        let entry:any;
        if(item.type==="message") {
          const r=(await db.query("SELECT m.id,m.dialogue_id,m.turn_id,m.role,m.kind,m.message_order,m.item_order,m.source,m.occurred_at,m.content_hash AS sha256,s.version AS summary_version,CASE WHEN s.text IS NULL THEN left(m.text,4096) ELSE s.text END AS text,CASE WHEN s.text IS NULL THEN char_length(m.text) ELSE char_length(s.text) END AS total_chars FROM dialogues_live.messages m LEFT JOIN LATERAL(SELECT text,version FROM dialogues_live.message_summaries WHERE owner_id=m.owner_id AND dialogue_id=m.dialogue_id AND message_id=m.id AND change_seq<=$4 ORDER BY version DESC LIMIT 1)s ON true WHERE m.owner_id=$1 AND m.dialogue_id=$2 AND m.id=$3",[owner,item.dialogue_id,item.id,c.through])).rows[0];
          entry={...r,representation:r.summary_version?"summary":"original",truncated:!r.summary_version&&r.total_chars>Array.from(r.text).length,next_offset:!r.summary_version&&r.total_chars>Array.from(r.text).length?Array.from(r.text).length:null};
        } else if(item.type==="dialogue_summary") {
          entry=(await db.query("SELECT dialogue_id,version,text,through_message_id,through_order FROM dialogues_live.dialogue_summaries WHERE owner_id=$1 AND dialogue_id=$2 AND version=$3",[owner,item.dialogue_id,item.version])).rows[0];
        } else {
          entry=(await db.query("SELECT COALESCE((SELECT MAX(through_order) FROM dialogues_live.dialogue_summaries WHERE owner_id=$1 AND dialogue_id=$2 AND change_seq<=$3),-1)::text AS summary_through_order,MAX(message_order)::text AS last_message_order FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND change_seq<=$3",[owner,item.dialogue_id,c.through])).rows[0];
        }
        const previous=JSON.parse(JSON.stringify(result));
        let group=result.dialogues.find((d:any)=>d.id===item.dialogue_id);
        if(!group) {
          const d=(await db.query("SELECT id,channel,left(title,128) AS title FROM dialogues_live.dialogues WHERE owner_id=$1 AND id=$2",[owner,item.dialogue_id])).rows[0];
          group={...d,turns:[],summary:null};result.dialogues.push(group);
        }
        if(item.type==="dialogue_summary")group.summary=entry;
        else if(item.type==="coverage_gap")group.coverage_gap=entry;
        else {
          let turn=group.turns.find((t:any)=>t.id===item.turn_id);
          if(!turn){turn={id:item.turn_id,turn_order:item.turn_order,messages:[]};group.turns.push(turn);}
          turn.messages.push(entry);
        }
        result.continuation_cursor=encodeCursor({...c,offset:c.offset+taken+1},key);
        if(Buffer.byteLength(JSON.stringify(result))>limits.responseBytes-256) {
          Object.assign(result,previous);
          if(!taken)fail(item.type==="dialogue_summary"||entry?.summary_version?"LARGE_SUMMARY_REQUIRES_CONTEXT_PULL":"RESPONSE_ITEM_TOO_LARGE");
          break;
        }
        taken++;
      }
      const more=taken<candidates.length;
      result.continuation_cursor=more?encodeCursor({...c,offset:c.offset+taken},key):null;
      result.next_cursor=more?null:encodeCursor({...c,mode:"checkpoint",offset:0},key);
      await db.query("COMMIT");return result;
    } catch(e){await db.query("ROLLBACK").catch(()=>{});throw cleanFault(e);}finally{db.release();}
  }
  return {append,summary,context,message,...createContext(pool,key),...createTurns(pool,key,mutation)};
}
