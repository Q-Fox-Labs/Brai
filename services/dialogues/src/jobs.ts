// ABOUTME: Ведёт PostgreSQL очередь свёрток и один последовательный исполнитель.
// ABOUTME: Публикует покрытие только целиком, с lease и CAS предыдущей версии.
import type {Pool,PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {ownerTransaction} from './context.js';
import {digest,fail,summaryText,DialoguesFault} from './domain.js';
import type {Execution,createLuna} from './luna.js';
/** Под owner lock фиксирует точный префикс, не дублируя активное задание. */
export async function enqueueDialogue(db:PoolClient,owner:string,dialogue:string,boundary:string,idle:boolean){
 const previous=(await db.query('SELECT version,through_order,text FROM dialogues_live.dialogue_summaries WHERE owner_id=$1 AND dialogue_id=$2 ORDER BY version DESC LIMIT 1',[owner,dialogue])).rows[0];
 const from=String(BigInt(previous?.through_order??'-1')+1n);
 const tail=(await db.query(`SELECT count(*)::integer AS count,max(message_order)::text AS through_order,max(recorded_at) AS last_at
 FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND message_order>=$3 AND change_seq<=$4 AND kind IN('input','final')`,[owner,dialogue,from,boundary])).rows[0];
 if(!tail.count||tail.count<10&&(!idle||Date.now()-Date.parse(tail.last_at)<6*3600000))return false;
 const blocked=(await db.query("SELECT 1 FROM dialogues_live.summary_jobs WHERE owner_id=$1 AND dialogue_id=$2 AND (state IN('queued','running') OR (state='failed' AND through_order>=$3)) LIMIT 1",[owner,dialogue,tail.through_order])).rowCount;
 if(blocked)return false;
 const last=(await db.query('SELECT id FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND message_order=$3',[owner,dialogue,tail.through_order])).rows[0];
 await db.query(`INSERT INTO dialogues_live.summary_jobs(owner_id,id,dialogue_id,previous_version,from_order,through_order,through_message_id,boundary_seq,state,progress)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9) ON CONFLICT DO NOTHING`,[owner,randomUUID(),dialogue,previous?.version??null,from,tail.through_order,last.id,boundary,{last_order:String(BigInt(from)-1n),offset:0,working_summary:previous?.text??'',execution:{}}]);
 return true;
}
/** Работает только с защищённым owner; внешний исполнитель заменяем в тестах. */
export function createJobs(pool:Pool,owner:string,luna:Pick<ReturnType<typeof createLuna>,'run'|'probe'>){
 let running=false,stopping=false,timer:NodeJS.Timeout|undefined,active:Promise<void>|undefined,verified=false;
 async function schedule(){
  return ownerTransaction(pool,owner,async db=>{
   const boundary=(await db.query('SELECT COALESCE(max(change_seq),0)::text AS seq FROM dialogues_live.requests WHERE owner_id=$1',[owner])).rows[0].seq;
   const ds=(await db.query('SELECT id FROM dialogues_live.dialogues WHERE owner_id=$1',[owner])).rows;
   for(const d of ds)await enqueueDialogue(db,owner,d.id,boundary,true);
  });
 }
 async function claim(){
  return ownerTransaction(pool,owner,async db=>{
   const job=(await db.query(`SELECT * FROM dialogues_live.summary_jobs WHERE owner_id=$1 AND
    ((state='queued' AND available_at<=now()) OR (state='running' AND lease_until<now())) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[owner])).rows[0];
   if(!job)return null;
   if(job.attempts>=3){await db.query("UPDATE dialogues_live.summary_jobs SET state='failed',error_code='ATTEMPTS_EXHAUSTED',lease_id=NULL,lease_until=NULL WHERE owner_id=$1 AND id=$2",[owner,job.id]);return null;}
   const lease=randomUUID();
   return (await db.query("UPDATE dialogues_live.summary_jobs SET state='running',attempts=attempts+1,lease_id=$3,lease_until=now()+interval '3 minutes' WHERE owner_id=$1 AND id=$2 RETURNING *",[owner,job.id,lease])).rows[0];
  });
 }
 async function save(job:any,progress:any){
  const execution:Execution=progress.execution?.native_thread_id?progress.execution:progress.probe_execution??{};
  const r=await pool.query(`UPDATE dialogues_live.summary_jobs SET progress=$4,native_thread_id=$5,native_turn_id=$6,native_launch_id=$7,execution_state=$8,lease_until=now()+interval '3 minutes'
   WHERE owner_id=$1 AND id=$2 AND lease_id=$3 AND state='running'`,[owner,job.id,job.lease_id,progress,execution.native_thread_id??null,execution.native_turn_id??null,execution.native_launch_id??null,execution.execution_state??'not_started']);
  if(r.rowCount!==1)fail('LEASE_LOST');
 }
 async function publish(job:any,value:string){
  summaryText(value);
  return ownerTransaction(pool,owner,async db=>{
   const held=(await db.query("SELECT lease_id,state FROM dialogues_live.summary_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE",[owner,job.id])).rows[0];
   if(held?.state!=='running'||held.lease_id!==job.lease_id)fail('LEASE_LOST');
   const old=(await db.query('SELECT version FROM dialogues_live.dialogue_summaries WHERE owner_id=$1 AND dialogue_id=$2 ORDER BY version DESC LIMIT 1',[owner,job.dialogue_id])).rows[0];
   if((old?.version??null)!==job.previous_version){
    await db.query("UPDATE dialogues_live.summary_jobs SET state='stale',lease_id=NULL,lease_until=NULL,error_code='VERSION_CONFLICT' WHERE owner_id=$1 AND id=$2",[owner,job.id]);
   }else{
    const seq=(await db.query("SELECT nextval('dialogues_live.change_seq')::text AS seq")).rows[0].seq,version=String(BigInt(job.previous_version??'0')+1n);
    await db.query('INSERT INTO dialogues_live.dialogue_summaries(owner_id,dialogue_id,version,text,through_message_id,through_order,change_seq) VALUES($1,$2,$3,$4,$5,$6,$7)',[owner,job.dialogue_id,version,value,job.through_message_id,job.through_order,seq]);
    const receipt={job_id:job.id,dialogue_id:job.dialogue_id,version,through_message_id:job.through_message_id,change_seq:seq};
    await db.query("INSERT INTO dialogues_live.requests(owner_id,id,operation,hash,result,change_seq) VALUES($1,$2,'internal_summary',$3,$4,$5)",[owner,'summary-job:'+job.id,digest(receipt),receipt,seq]);
    await db.query("UPDATE dialogues_live.summary_jobs SET state='succeeded',lease_id=NULL,lease_until=NULL,error_code=NULL WHERE owner_id=$1 AND id=$2",[owner,job.id]);
   }
   const boundary=(await db.query('SELECT COALESCE(max(change_seq),0)::text AS seq FROM dialogues_live.requests WHERE owner_id=$1',[owner])).rows[0].seq;
   await enqueueDialogue(db,owner,job.dialogue_id,boundary,true);
  });
 }
 async function execute(job:any){
  let progress=job.progress;
  const heartbeat=setInterval(()=>{void pool.query("UPDATE dialogues_live.summary_jobs SET lease_until=now()+interval '3 minutes' WHERE owner_id=$1 AND id=$2 AND lease_id=$3 AND state='running'",[owner,job.id,job.lease_id]).catch(()=>{});},30000);heartbeat.unref();
  try{
   for(;;){
    if(stopping)fail('WORKER_STOPPING');
    const rows=(await pool.query(`SELECT id,role,kind,message_order,occurred_at,recorded_at,content_hash,char_length(text) AS total_chars,
      substring(text FROM CASE WHEN message_order=(SELECT min(message_order) FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND change_seq<=$3 AND message_order>$4 AND message_order<=$5 AND kind IN('input','final')) THEN $6::integer ELSE 1 END FOR 12000) AS fragment
      FROM dialogues_live.messages WHERE owner_id=$1 AND dialogue_id=$2 AND change_seq<=$3 AND message_order>$4 AND message_order<=$5 AND kind IN('input','final') ORDER BY message_order LIMIT 32`,
      [owner,job.dialogue_id,job.boundary_seq,progress.last_order,job.through_order,progress.offset+1])).rows;
    if(!rows.length)break;
    let budget=12000,nextOrder=progress.last_order,nextOffset=progress.offset;
    const originals=[];
    for(const row of rows){
      const offset:number=originals.length===0?progress.offset:0;
      const fragment=Array.from(row.fragment).slice(0,budget).join(''),length=Array.from(fragment).length,end=offset+length;
      originals.push({id:row.id,role:row.role,kind:row.kind,message_order:row.message_order,occurred_at:row.occurred_at,recorded_at:row.recorded_at,
        sha256:row.content_hash,offset,total_chars:row.total_chars,original_fragment:fragment,message_complete:end===row.total_chars});
      budget-=length;
      if(end===row.total_chars){nextOrder=row.message_order;nextOffset=0;}else{nextOffset=end;break;}
      if(budget<=0)break;
    }
    const input=JSON.stringify({previous_summary:progress.working_summary,originals});
    const result=await luna.run(input,progress.execution??{},async execution=>{progress={...progress,execution};await save(job,progress);});
    summaryText(result);
    progress={...progress,completed_chunks:[...(progress.completed_chunks??[]),{from_order:progress.last_order,from_offset:progress.offset,through_order:nextOrder,through_offset:nextOffset,execution:progress.execution}],working_summary:result,last_order:nextOrder,offset:nextOffset,execution:{}};
    await save(job,progress);
   }
   await publish(job,progress.working_summary);
  }catch(e){
   const code=e instanceof DialoguesFault?e.code:'SUMMARY_EXECUTION_FAILED';
   // AIDEV-NOTE: Ambiguous execution сохраняет IDs и при повторе только читается.
   await pool.query(`UPDATE dialogues_live.summary_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
    available_at=now()+make_interval(secs=>30*attempts),lease_id=NULL,lease_until=NULL,error_code=$4
    WHERE owner_id=$1 AND id=$2 AND lease_id=$3 AND state='running'`,[owner,job.id,job.lease_id,code]);
  }finally{clearInterval(heartbeat);}
 }
 /** Один шаг позволяет проверить очередь без таймеров и реальной модели. */
 async function tick(){
  if(running||stopping)return;running=true;
  try{await schedule();const job=await claim();if(!job)return;if(!verified){try{await luna.probe(job.progress.probe_execution??{},async execution=>{job.progress={...job.progress,probe_execution:execution};await save(job,job.progress);});verified=true;}catch(e){await pool.query("UPDATE dialogues_live.summary_jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,available_at=now()+make_interval(secs=>30*attempts),lease_id=NULL,lease_until=NULL,error_code=$4 WHERE owner_id=$1 AND id=$2 AND lease_id=$3",[owner,job.id,job.lease_id,e instanceof DialoguesFault?e.code:'LUNA_PROBE_FAILED']);return;}}await execute(job);}
  finally{running=false;}
 }
 /** Старт и минута тишины проверяются в том же процессе, без нового сервиса. */
 function start(){
  const wake=()=>{if(active||stopping)return;const task=tick().catch(()=>{});active=task;void task.finally(()=>{if(active===task)active=undefined;});};
  wake();timer=setInterval(wake,60000);timer.unref();
 }
 return {schedule,claim,publish,execute,tick,start,async stop(){stopping=true;if(timer)clearInterval(timer);await active;}};
}
