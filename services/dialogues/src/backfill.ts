// ABOUTME: Создаёт недостающие саммари длинных исторических сообщений.
// ABOUTME: Возобновляет обработку после сбоя и не изменяет оригиналы.
import {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {hostFetch} from './fence-http.js';
import {createLuna,type Execution} from './luna.js';
import {id,summaryText} from './domain.js';

type Summarizer=Pick<ReturnType<typeof createLuna>,'run'|'probe'>;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Обрабатывает каждого владельца последовательно; повтор не перезаписывает готовые саммари. */
export async function backfill(pool:Pool,owner:string,luna:Summarizer,fence?:{id:string;wait:()=>Promise<void>}){
 const db=await pool.connect();
 let locked=false,ownerLocked=false,probed=false,completed=0;
 try{
  const lock=(await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",['dialogues-backfill:'+owner])).rows[0].locked;
  if(!lock)throw new Error('BACKFILL_BUSY');locked=true;
  if(fence){
   id(fence.id);
   if(Buffer.byteLength(fence.id)>48)throw new Error('FENCE_ID_TOO_LONG');
   if((await db.query("SELECT 1 FROM dialogues_live.exchange_events WHERE owner_id=$1 AND event_id=$2",[owner,'fence:'+fence.id])).rowCount)throw new Error('FENCE_ID_REUSED');
   await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['dialogues-live:'+owner]);ownerLocked=true;
  }
  for(;;){
   const message=(await db.query(`SELECT m.dialogue_id,m.id,m.text,m.content_hash FROM dialogues_live.messages m
    WHERE m.owner_id=$1 AND char_length(m.text)>100 AND NOT EXISTS(
      SELECT 1 FROM dialogues_live.message_summaries s WHERE s.owner_id=m.owner_id AND s.dialogue_id=m.dialogue_id AND s.message_id=m.id
    ) ORDER BY m.dialogue_id,m.message_order,m.id LIMIT 1`,[owner])).rows[0];
   if(!message)break;
   if(!probed){await luna.probe();probed=true;}
   await db.query(`INSERT INTO dialogues_live.message_backfill(owner_id,dialogue_id,message_id,source_hash)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[owner,message.dialogue_id,message.id,message.content_hash]);
   let progress=(await db.query('SELECT * FROM dialogues_live.message_backfill WHERE owner_id=$1 AND dialogue_id=$2 AND message_id=$3',[owner,message.dialogue_id,message.id])).rows[0];
   if(progress.source_hash!==message.content_hash||progress.state!=='pending')throw new Error('BACKFILL_SOURCE_CONFLICT');
   const chars=Array.from(message.text as string);
   while(progress.next_offset<chars.length){
    const end=Math.min(progress.next_offset+12000,chars.length);
    const input=JSON.stringify({previous_summary:progress.working_summary??'',original_fragment:chars.slice(progress.next_offset,end).join(''),message_complete:end===chars.length});
    const result=summaryText(await luna.run(input,progress.execution??{},async (execution:Execution)=>{
     await db.query("UPDATE dialogues_live.message_backfill SET execution=$4,updated_at=now() WHERE owner_id=$1 AND dialogue_id=$2 AND message_id=$3",[owner,message.dialogue_id,message.id,execution]);
    }));
    progress=(await db.query("UPDATE dialogues_live.message_backfill SET next_offset=$4,working_summary=$5,execution='{}'::jsonb,updated_at=now() WHERE owner_id=$1 AND dialogue_id=$2 AND message_id=$3 RETURNING *",[owner,message.dialogue_id,message.id,end,result])).rows[0];
   }
   await db.query('BEGIN');
   try{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['dialogues-live:'+owner]);
    const exists=(await db.query('SELECT 1 FROM dialogues_live.message_summaries WHERE owner_id=$1 AND dialogue_id=$2 AND message_id=$3',[owner,message.dialogue_id,message.id])).rowCount;
    if(!exists){
     const seq=(await db.query("SELECT nextval('dialogues_live.change_seq')::text AS seq")).rows[0].seq;
     const event='backfill:'+hash(owner+'\\0'+message.dialogue_id+'\\0'+message.id);
     const receipt={dialogue_id:message.dialogue_id,message_id:message.id,version:'1',change_seq:seq};
     await db.query('INSERT INTO dialogues_live.message_summaries(owner_id,dialogue_id,message_id,version,text,source_hash,change_seq) VALUES($1,$2,$3,1,$4,$5,$6)',[owner,message.dialogue_id,message.id,summaryText(progress.working_summary),message.content_hash,seq]);
     await db.query("INSERT INTO dialogues_live.requests(owner_id,id,operation,hash,result,change_seq) VALUES($1,$2,'message_backfill',$3,$4,$5)",[owner,event,hash(event),receipt,seq]);
    }
    await db.query("UPDATE dialogues_live.message_backfill SET state='done',working_summary=NULL,execution='{}'::jsonb,updated_at=now() WHERE owner_id=$1 AND dialogue_id=$2 AND message_id=$3",[owner,message.dialogue_id,message.id]);
    await db.query('COMMIT');completed++;
   }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
  }
  if(fence){
   await db.query("INSERT INTO dialogues_live.exchange_events(owner_id,event_id,event_type,turn_id) VALUES($1,$2,'cutover_fence_ready',pg_backend_pid()::text)",[owner,'fence:'+fence.id]);
   await fence.wait();
  }
  return {completed};
 }finally{
  if(ownerLocked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['dialogues-live:'+owner]).catch(()=>{});
  if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['dialogues-backfill:'+owner]).catch(()=>{});
  db.release();
 }
}

/** Закрывает последние записи старой версии после остановки прежнего писателя. */
export async function ensureBackfilled(pool:Pool,owner:string,luna:Summarizer){
 const missing=async()=>Boolean((await pool.query("SELECT 1 FROM dialogues_live.messages m WHERE m.owner_id=$1 AND char_length(m.text)>100 AND NOT EXISTS(SELECT 1 FROM dialogues_live.message_summaries s WHERE s.owner_id=m.owner_id AND s.dialogue_id=m.dialogue_id AND s.message_id=m.id) LIMIT 1",[owner])).rowCount);
 if(await missing())await backfill(pool,owner,luna);
 if(await missing())throw new Error('BACKFILL_REQUIRED');
}

/** Удерживает границу до появления нового MCP и освобождает её при сбое или timeout. */
async function waitForNewServer(url:string,token:string){
 const deadline=Date.now()+30*60*1000;
 while(Date.now()<deadline){
  const client=new Client({name:'dialogues-cutover-fence',version:'1'});
  try{
   const transport=new StreamableHTTPClientTransport(new URL(url),{...(process.env.DIALOGUES_FENCE_HOST?{fetch:hostFetch(process.env.DIALOGUES_FENCE_HOST)}:{}),requestInit:{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)}});
   await client.connect(transport);
   const names=(await client.listTools()).tools.map(x=>x.name).sort();
   if(names.length===2&&names[0]==='dialogues_context_ack'&&names[1]==='dialogues_exchange')return;
  }catch{/* Прежняя версия или смена контейнера: ждём до общей границы. */}
  finally{await client.close().catch(()=>{});}
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 throw new Error('CUTOVER_TIMEOUT');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const fenceMode=process.argv[2]==='--fence';
 const fenceId=process.env.DIALOGUES_FENCE_ID??'';
 const pool=new Pool({connectionString:process.env.DIALOGUES_DATABASE_URL,...(fenceMode?{application_name:'dialogues-fence:'+fenceId}:{})});
 const luna=createLuna(process.env.DIALOGUES_CODEX_SOCKET_URL??'',process.env.DIALOGUES_SUMMARY_CWD??'');
 const owner=process.env.DIALOGUES_MCP_OWNER_ID??'';
 try{
  if(!owner)throw new Error('BACKFILL_OWNER_REQUIRED');
  let fence: {id:string;wait:()=>Promise<void>}|undefined;
  if(fenceMode){
   id(fenceId);
   const url=process.env.DIALOGUES_FENCE_MCP_URL??'',token=readFileSync(process.env.DIALOGUES_MCP_TOKEN_FILE??'','utf8').trim();
   if(!url||!token)throw new Error('CUTOVER_INPUT_REQUIRED');
   fence={id:fenceId,wait:()=>waitForNewServer(url,token)};
  }
  const result=await backfill(pool,owner,luna,fence);
  console.log(JSON.stringify({status:'completed',...result}));
 }catch{console.error('BACKFILL_FAILED');process.exitCode=1;}
 finally{await luna.close();await pool.end();}
}
