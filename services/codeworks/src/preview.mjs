// ABOUTME: Сверяет долговечную очередь веб-превью проекта с Git, CI и операторским адаптером.
// ABOUTME: Публикация не держит DB-транзакцию; неизвестный результат сначала проверяется.
import {randomUUID} from 'node:crypto';
import {observePreview,renewPreview,acceptPreviewProof,beginPreviewAction,reconcilePreviewAction} from './preview-domain.mjs';

const fields=['desired_sha','pending_sha','pending_cancel','deployed_sha','image_reference','deployed_image_reference','ci_proof','generation','deployed_generation','slot_id','state','queue_ticket','published_at','expires_at','last_sync_operation_id','action','action_generation','backend_changed','error'];
async function locked(pool,projectId,work) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    if(!(await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',['codeworks:web-preview:'+projectId])).rows[0].acquired){await db.query('ROLLBACK');return null;}
    const result=await work(db);await db.query('COMMIT');return result;
  } catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;} finally{db.release();}
}
async function save(db,row) {
  await db.query('UPDATE codeworks.web_previews SET '+fields.map((field,i)=>field+'=$'+(i+2)).join(',')+',updated_at=now() WHERE id=$1',[row.id,...fields.map(field=>row[field]??null)]);
}
async function mutate(pool,projectId,id,fn) {
  return locked(pool,projectId,async db=>{
    const row=(await db.query('SELECT * FROM codeworks.web_previews WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)return null;
    const next=await fn(row,db);if(next && next!==row)await save(db,next);return next;
  });
}

/** Один ограниченный проход: до восьми наблюдений HEAD и не более одного внешнего действия. */
export async function reconcilePreviewProject(pool,projectId,ports,{cursor=null,batchSize=8}={}) {
  const project=(await pool.query('SELECT config FROM codeworks.projects WHERE id=$1',[projectId])).rows[0]?.config;
  if(!project?.web_preview?.enabled)return {cursor:null};
  const config=project.web_preview,ttl=config.ttl_seconds??172800;
  const candidates=(await pool.query(`SELECT w.*,r.lifecycle,r.state AS workflow_state FROM codeworks.workspaces w
    LEFT JOIN codeworks.workflow_registry r ON r.workspace_id=w.id
    WHERE w.project_id=$1 AND ($2::uuid IS NULL OR w.id>$2::uuid)
      AND (r.lifecycle='active' OR EXISTS(SELECT 1 FROM codeworks.web_previews v WHERE v.workspace_id=w.id AND (v.slot_id IS NOT NULL OR v.state IN ('waiting_ci','queued','publishing','failed'))) )
    ORDER BY w.id LIMIT $3`,[projectId,cursor,batchSize])).rows;
  for(const w of candidates) {
    let row=(await pool.query('SELECT * FROM codeworks.web_previews WHERE workspace_id=$1',[w.id])).rows[0];
    const active=w.lifecycle==='active'&&w.workflow_state!=='completed'&&!w.removed_at;
    let head=null,closed=!active;
    if(active) {
      try {head=await ports.remote(project,w);if(head)closed=await ports.closed(project,w,head);else closed=true;}
      catch {continue;}
    }
    if(closed) {
      if(row)await mutate(pool,projectId,row.id,r=>r.action?{...r,pending_cancel:true}:r.slot_id?beginPreviewAction({...r,pending_cancel:true},'remove'):{...r,state:'expired',queue_ticket:null,pending_cancel:false});
      continue;
    }
    if(!head || (head===w.base_sha && !row))continue;
    if(!row) {
      row=await locked(pool,projectId,async db=>{
        const id=randomUUID();
        await db.query("INSERT INTO codeworks.web_previews(id,project_id,workspace_id,desired_sha,generation,state) VALUES($1,$2,$3,$4,1,'waiting_ci') ON CONFLICT(workspace_id) DO NOTHING",[id,projectId,w.id,head]);
        return (await db.query('SELECT * FROM codeworks.web_previews WHERE workspace_id=$1',[w.id])).rows[0];
      });
    }
    if(!row)continue;
    row=await mutate(pool,projectId,row.id,r=>observePreview(r,head));
    if(!row)continue;
    const sync=(await pool.query("SELECT id,request->>'commit_sha' AS sha FROM codeworks.operations WHERE workspace_id=$1 AND kind='sync' AND status='succeeded' AND NOT archived ORDER BY updated_at DESC,id DESC LIMIT 1",[w.id])).rows[0];
    if(sync)row=await mutate(pool,projectId,row.id,r=>renewPreview(r,sync.id,sync.sha,new Date().toISOString(),ttl));
    if(!row || row.action || row.state!=='waiting_ci')continue;
    let change,proof;
    try {change=await ports.classify(project,w,row.desired_sha);if(change.web)proof=await ports.verify(project,row.desired_sha);}
    catch {await mutate(pool,projectId,row.id,r=>r.desired_sha===row.desired_sha&&!r.action?{...r,error:'PREVIEW_INPUT_UNAVAILABLE'}:r);continue;}
    if(!change.web){await mutate(pool,projectId,row.id,r=>r.desired_sha===row.desired_sha&&!r.action?(r.slot_id?beginPreviewAction({...r,backend_changed:!!change.backend},'remove'):{...r,state:'unsupported',backend_changed:!!change.backend}):r);continue;}
    if(!proof?.verified){await mutate(pool,projectId,row.id,r=>r.desired_sha===row.desired_sha&&!r.action?{...r,error:/^CI_[A-Z0-9_]+$/.test(proof?.state??'')?proof.state:'CI_NOT_VERIFIED'}:r);continue;}
    await mutate(pool,projectId,row.id,async(r,db)=>{
      if(r.desired_sha!==row.desired_sha||r.action)return r;
      const ticket=r.queue_ticket??(await db.query("SELECT nextval('codeworks.web_preview_ticket') AS ticket")).rows[0].ticket;
      return {...acceptPreviewProof(r,row.generation,proof.evidence,proof.image_reference,ticket),backend_changed:!!change.backend};
    });
  }
  // Expiry and finalization reserve their slot until adapter confirms actual absence.
  const admitted=await locked(pool,projectId,async db=>{
    const expired=(await db.query("SELECT * FROM codeworks.web_previews WHERE project_id=$1 AND slot_id IS NOT NULL AND action IS NULL AND expires_at<=now() ORDER BY expires_at LIMIT 1 FOR UPDATE",[projectId])).rows[0];
    if(expired){const next=beginPreviewAction(expired,'remove');await save(db,next);return next;}
    const used=(await db.query('SELECT slot_id FROM codeworks.web_previews WHERE project_id=$1 AND slot_id IS NOT NULL',[projectId])).rows.map(r=>r.slot_id);
    const free=config.slots.find(s=>!used.includes(s.id))?.id;
    const row=(await db.query("SELECT v.* FROM codeworks.web_previews v JOIN codeworks.workspaces w ON w.id=v.workspace_id JOIN codeworks.workflow_registry r ON r.workspace_id=w.id WHERE v.project_id=$1 AND v.state='queued' AND v.action IS NULL AND r.lifecycle='active' AND r.state<>'completed' AND w.removed_at IS NULL AND ($2::boolean OR v.slot_id IS NOT NULL) ORDER BY v.queue_ticket LIMIT 1 FOR UPDATE OF v",[projectId,!!free])).rows[0];
    if(!row)return;
    const slot=row.slot_id??free;
    if(slot){const next=beginPreviewAction(row,'publish',slot);await save(db,next);return next;}
  });
  const action=admitted??(await pool.query("SELECT * FROM codeworks.web_previews WHERE project_id=$1 AND action IS NOT NULL ORDER BY updated_at LIMIT 1",[projectId])).rows[0];
  if(action) {
    let eligible=true,currentHead,superseded=!!action.pending_cancel;
    if(action.action==='publish') {
      const w=(await pool.query(`SELECT w.*,r.lifecycle,r.state AS workflow_state FROM codeworks.workspaces w LEFT JOIN codeworks.workflow_registry r ON r.workspace_id=w.id WHERE w.id=$1`,[action.workspace_id])).rows[0];
      try {
        eligible=!!w&&w.lifecycle==='active'&&w.workflow_state!=='completed'&&!w.removed_at;
        if(eligible){currentHead=await ports.remote(project,w);const closed=!currentHead||await ports.closed(project,w,currentHead);superseded=superseded||(!closed&&currentHead!==action.desired_sha&&action.pending_sha===currentHead);eligible=!closed&&currentHead===action.desired_sha;}
      } catch {eligible=null;}
      if(eligible===null)return {cursor:candidates.length===batchSize?candidates.at(-1).id:null};
      // Новый intent ещё не вызывал adapter, поэтому его можно отменить без опасного предположения о внешнем исходе.
      if(!eligible && admitted?.id===action.id) {
        await mutate(pool,projectId,action.id,r=>{
          if(r.action!=='publish'||Number(r.action_generation)!==Number(action.action_generation))return r;
          let next={...r,action:null,action_generation:null,queue_ticket:null,state:'expired'};
          if(currentHead && currentHead!==r.desired_sha)next=observePreview(next,currentHead);
          else if(r.deployed_sha)next=beginPreviewAction(next,'remove');
          else next.slot_id=null;
          return next;
        });
        return {cursor:candidates.length===batchSize?candidates.at(-1).id:null};
      }
    }
    let result=await ports.adapter(admitted?.id===action.id?action.action:'inspect',action.id,Number(action.action_generation));
    if(!admitted && ((action.action==='publish' && (eligible||superseded) && ['absent','pending'].includes(result.status)) || (action.action==='remove' && ['ready','pending'].includes(result.status))))
      result=await ports.adapter(action.action,action.id,Number(action.action_generation));
    await mutate(pool,projectId,action.id,r=>{const next=reconcilePreviewAction(r,result,new Date().toISOString(),ttl);return next===r?{...r}:next;});
  }
  return {cursor:candidates.length===batchSize?candidates.at(-1).id:null};
}
