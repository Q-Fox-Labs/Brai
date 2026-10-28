// ABOUTME: Подтверждает доставку результата закрытой попытки последующим установленным выпуском DEV.
// ABOUTME: Только читает Git и доверенные записи Codeworks; не меняет попытки и не удаляет ресурсы.
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
const canonical=value=>JSON.stringify(sorted(value));

/** Проверяет неизменные записи доставки и отсутствие новой незавершённой работы. */
export async function recheckPublication(db,project,workspace,proof,{ignoreOperationId=null,lock=false}={}) {
  if(!proof||workspace.kind!=='feature'||proof.project_id!==workspace.project_id||proof.workspace_id!==workspace.id)return false;
  const result=await db.query(`SELECT a.requested_sha,a.closed_at,a.state,ao.status AS original_status,
      i.operation_id AS installed_operation_id,d.commit_sha,d.target,d.project_id,d.composition_digest,d.composition,d.receipt,
      ro.status AS rollout_status,de.id AS evidence_id,de.created_at AS evidence_at,
      b.operation_id AS delivery_release_id,b.state AS delivery_release_state,b.details AS delivery_release_details,
      bo.status AS delivery_operation_status
    FROM codeworks.releases a JOIN codeworks.operations ao ON ao.id=a.operation_id
    JOIN codeworks.installed i ON i.project_id=$1 AND i.target='dev'
    JOIN codeworks.deployments d ON d.operation_id=i.operation_id AND d.project_id=i.project_id AND d.target=i.target
    JOIN codeworks.operations ro ON ro.id=d.operation_id AND NOT ro.archived
    JOIN codeworks.deployment_evidence de ON de.id=$3 AND de.project_id=d.project_id AND de.target=d.target
      AND de.commit_sha=d.commit_sha AND de.evidence_url=d.receipt->>'evidence_url'
    JOIN codeworks.releases b ON b.operation_id=d.release_operation_id
    JOIN codeworks.operations bo ON bo.id=b.operation_id AND NOT bo.archived
    WHERE a.operation_id=$2 AND a.workspace_id=$4 AND NOT ao.archived
      AND NOT EXISTS(SELECT 1 FROM codeworks.releases later JOIN codeworks.operations lo ON lo.id=later.operation_id
        WHERE later.workspace_id=a.workspace_id AND NOT lo.archived AND (later.created_at,later.operation_id)>(a.created_at,a.operation_id))
      AND NOT EXISTS(SELECT 1 FROM codeworks.deployments newer JOIN codeworks.operations n ON n.id=newer.operation_id
        WHERE newer.project_id=d.project_id AND newer.target='dev' AND NOT n.archived
          AND newer.created_at>d.created_at AND (newer.receipt->>'verified') IS DISTINCT FROM 'true')
      ${lock?'FOR SHARE OF a,ao,i,d,ro,de,b,bo':''}`,
    [workspace.project_id,proof.original_attempt_id,proof.deployment_evidence_id,workspace.id]);
  const row=result.rows[0],receipt=row?.receipt;
  const legs=[row?.delivery_release_details?.primary,row?.delivery_release_details?.backport];
  const delivered=legs.some(leg=>leg?.target==='dev'&&leg.merged===true&&leg.merge_sha===proof.installed_commit&&leg.deployment_evidence_id===proof.deployment_evidence_id);
  if(!row||row.state!=='failed'||row.original_status!=='failed'||!row.closed_at||row.delivery_release_state!=='succeeded'||row.delivery_operation_status!=='succeeded'||!delivered||row.rollout_status!=='succeeded'||new Date(row.evidence_at)<=new Date(row.closed_at)||row.target!=='dev'||row.project_id!==workspace.project_id||row.requested_sha!==proof.source_accepted_sha||row.commit_sha!==proof.installed_commit||row.installed_operation_id!==proof.deployment_operation_id||row.delivery_release_id!==proof.delivery_release_operation_id||receipt?.verified!==true||receipt.operation_id!==row.installed_operation_id||receipt.project_id!==row.project_id||receipt.target!==row.target||receipt.commit_sha!==row.commit_sha||receipt.composition_digest!==row.composition_digest||canonical(receipt.composition)!==canonical(row.composition))return false;
  if((await db.query("SELECT 1 FROM codeworks.write_calls WHERE workspace_id=$1 AND state IN ('preparing','in_flight','uncertain') LIMIT 1",[workspace.id])).rowCount)return false;
  if((await db.query("SELECT 1 FROM codeworks.operations WHERE workspace_id=$1 AND NOT archived AND kind<>'cleanup' AND id IS DISTINCT FROM $2::uuid AND status IN ('pending','running','awaiting_execution','awaiting_ci','awaiting_deployment','awaiting_reconciliation') LIMIT 1",[workspace.id,ignoreOperationId])).rowCount)return false;
  return true;
}

/** Проверяет exact HEAD, все Git OID и актуальный подтверждённый DEV; возвращает proof либо null. */
export async function verifyPublication(db,project,workspace,{git,flowGit,ignoreOperationId=null}={}) {
  if(workspace.kind!=='feature'||!git||!flowGit)return null;
  const attempt=(await db.query("SELECT r.operation_id,r.requested_sha FROM codeworks.releases r JOIN codeworks.operations o ON o.id=r.operation_id WHERE r.workspace_id=$1 AND NOT o.archived AND r.state='failed' AND o.status='failed' AND r.closed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM codeworks.releases later JOIN codeworks.operations lo ON lo.id=later.operation_id WHERE later.workspace_id=r.workspace_id AND NOT lo.archived AND (later.created_at,later.operation_id)>(r.created_at,r.operation_id)) ORDER BY r.created_at DESC,r.operation_id DESC LIMIT 1",[workspace.id])).rows[0];
  if(!attempt)return null;
  const installed=(await db.query(`SELECT d.operation_id,d.release_operation_id,d.commit_sha,de.id AS evidence_id FROM codeworks.installed i
    JOIN codeworks.deployments d ON d.operation_id=i.operation_id
    JOIN codeworks.deployment_evidence de ON de.project_id=d.project_id AND de.target=d.target AND de.commit_sha=d.commit_sha AND de.evidence_url=d.receipt->>'evidence_url'
    WHERE i.project_id=$1 AND i.target='dev' ORDER BY de.created_at DESC,de.id DESC LIMIT 1`,[workspace.project_id])).rows[0];
  if(!installed)return null;
  const resources=await git.inspectResources(project,workspace);
  if(!resources.worktree?.registered||!resources.worktree?.pathExists||!resources.worktree?.owned||resources.worktree?.dirty!==false||resources.worktree?.head!==attempt.requested_sha||resources.branch?.oid!==attempt.requested_sha||resources.remote?.known!==true)return null;
  for(const sha of [resources.worktree.head,resources.branch.oid,resources.remote.oid,resources.tracking?.oid].filter(Boolean))if(!await flowGit.ancestor(project,sha,installed.commit_sha))return null;
  const proof={project_id:workspace.project_id,workspace_id:workspace.id,original_attempt_id:attempt.operation_id,source_accepted_sha:attempt.requested_sha,installed_commit:installed.commit_sha,deployment_evidence_id:installed.evidence_id,deployment_operation_id:installed.operation_id,delivery_release_operation_id:installed.release_operation_id,resources};
  return await recheckPublication(db,project,workspace,proof,{ignoreOperationId})?proof:null;
}
