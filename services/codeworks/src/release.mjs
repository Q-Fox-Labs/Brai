// ABOUTME: Продолжает GitHub синхронизацию и выпуски feature/hotfix через явные порты.
// ABOUTME: Merge не означает CI или установленный выпуск; неопределённую публикацию сначала сверяет чтением.
import { Fault } from './errors.mjs';
const waiting=(status,reason)=>({status,reason});
function validatePR(p,w,leg,pr) {
  if(!pr||!pr.body?.includes('Codeworks workspace '+w.id+';')||pr.head?.ref!==leg.branch||pr.base?.ref!==leg.target||pr.head?.repo?.full_name?.toLowerCase()!==p.github.repository.toLowerCase()||pr.base?.repo?.full_name?.toLowerCase()!==p.github.repository.toLowerCase()||(leg.pr_number&&pr.number!==leg.pr_number))throw new Fault('PR_IDENTITY_CONFLICT','PR identity differs from pinned intent.');
}
async function confirmPRHead(p,w,leg,pr,github,git) {
  validatePR(p,w,leg,pr);
  if(pr.head?.sha===leg.head)return {pr};
  if(await git.remote(p,leg.branch)!==leg.head)return {wait:waiting('awaiting_reconciliation','PR_HEAD_PENDING')};
  // AIDEV-NOTE: GitHub может отставать от подтверждённого push; идентичность проверяется при каждом чтении.
  for(let attempt=0;attempt<2;attempt++) {
    pr=await github.get(p,pr.number);
    validatePR(p,w,leg,pr);
    if(pr.head?.sha===leg.head)return {pr};
  }
  return {wait:waiting('awaiting_reconciliation','PR_HEAD_UNCONFIRMED')};
}
/** Один проход; save фиксирует намерения до мутаций, evidence читает доверенную установку.
 * deploy(target,sha,proof,retryOf) возвращает {operation_id,status}; retryOf разрешает одну явную попытку.
 */
export async function advanceRelease({project:p,workspace:w,operation:op,release}, {git,github,inspect,save,evidence,deploy,acquire,releaseLane=async()=>{},verifyEvidence=async()=>true,checkpoint=async()=>{}}) {
  if(!['feature','hotfix'].includes(w.kind))throw new Fault('INVALID_ARGUMENT');
  const queued=!!acquire;acquire??=async()=>true;
  const flow=release.details;
  const persist=async()=>save(flow);
  const checkGate=async(leg,sha,stage,fallback)=>{
    const checks=await github.checks(p,sha);
    if(!checksPassed(p.github.required_checks,checks,sha))return waiting('awaiting_ci',checks.find(c=>c.ci_state&&c.ci_state!=='CI_VERIFIED')?.ci_state??fallback);
    const pinnedRetry=stage==='merge'&&leg.deployment_retry_of;
    if(pinnedRetry&&!leg.merge_ci)throw new Fault('CONFLICT','Deployment retry requires the original verified merge proof.');
    if(p.github.ci){
      const proof=checks.find(c=>c.name===p.github.ci.check_name&&c.app_id===p.github.ci.app_id&&c.ci_verified)?.ci_evidence;
      if(!proof)return waiting('awaiting_ci','CI_COMPOSITION_REQUIRED');
      // AIDEV-NOTE: Свежие проверки обязательны, а technical retry устанавливает прежний immutable proof.
      if(!pinnedRetry){leg[stage+'_ci']=proof;await persist();}
    }
    return null;
  };
  const mutation=async(leg,key,work)=>{
    leg[key]=true;await persist();await checkpoint('before-'+key);
    await work();await checkpoint('after-'+key);
  };
  if(!p.github)return waiting('awaiting_execution','GIT_FLOW_NOT_CONFIGURED');
  const current=await inspect(p,w);
  if(current.dirty||current.head!==release.requested_sha)throw new Fault('CONFLICT','Workspace differs from the pinned release request.');
  await git.validateHead(p,w,release.requested_sha);
  // После попытки main push сначала сверяется её исход; backport вправе добавить этот hotfix в dev.
  if(w.kind==='hotfix'&&!flow.primary?.merge_push_attempted)await git.validateHotfixSource(p,w,release.requested_sha);
  if(!flow.primary){
    const head={head:release.requested_sha};
    const headGate=queued?await checkGate(head,head.head,'head','HEAD_CHECKS_REQUIRED'):null;if(headGate)return headGate;
    if(!await acquire(w.kind==='feature'?'dev':'prod'))return waiting('awaiting_execution','TARGET_QUEUE');
    const target=w.kind==='feature'?'dev':'main';
    const target_sha=await git.remote(p,target);
    if(!target_sha||target_sha===release.requested_sha)throw new Fault('CONFLICT','Release has no new commit for this target.');
    if(w.kind==='hotfix'){
      const installed=await evidence('prod');
      if(!installed||installed.commit_sha!==w.base_sha||target_sha!==w.base_sha)throw new Fault('PRODUCTION_BASE_MISMATCH');
    }
    flow.primary={branch:w.branch,head:release.requested_sha,target,target_sha,...(head.head_ci?{head_ci:head.head_ci}:{})};await persist();
  }
  for(const name of w.kind==='hotfix'?['primary','backport']:['primary']){
    if(!flow[name]){
      const head={head:release.requested_sha};
      const headGate=queued?await checkGate(head,head.head,'head','HEAD_CHECKS_REQUIRED'):null;if(headGate)return headGate;
      if(!await acquire('dev'))return waiting('awaiting_execution','TARGET_QUEUE');
      flow[name]={branch:w.branch,head:release.requested_sha,target:'dev',target_sha:await git.remote(p,'dev')};await persist();
    }
    const leg=flow[name],lane=leg.target==='main'?'prod':'dev';
    if(leg.deployment_evidence_id){
      if(!await verifyEvidence(leg.deployment_evidence_id,lane,leg.merge_sha))throw new Fault('CONFLICT','Confirmed installation evidence is missing.');
      await releaseLane(lane);continue;
    }
    const queuedGate=queued?await checkGate(leg,leg.head,'head','HEAD_CHECKS_REQUIRED'):null;if(queuedGate)return queuedGate;
    if(!await acquire(lane))return waiting('awaiting_execution','TARGET_QUEUE');
    if(!leg.merged){
      const remote=await git.remote(p,leg.branch);
      if(remote!==leg.head){
        if(remote)throw new Fault('CONFLICT','Published branch differs from pinned head.');
        if(leg.push_attempted)return waiting('awaiting_reconciliation','BRANCH_PUSH_UNCERTAIN');
        await mutation(leg,'push_attempted',()=>git.push(p,leg.branch,leg.head));
        if(await git.remote(p,leg.branch)!==leg.head)return waiting('awaiting_reconciliation','BRANCH_PUSH_UNCERTAIN');
      }
      let pr=leg.pr_number?await github.get(p,leg.pr_number):await github.find(p,leg);
      if(!pr){
        if(leg.pr_attempted){
          const historical=await github.find(p,leg,{state:'all',workspaceId:w.id,head:leg.head});
          if(historical)validatePR(p,w,leg,historical);
          return waiting('awaiting_reconciliation','PR_CREATE_UNCERTAIN');
        }
        const marker='Запрос слияния отдельной области Codeworks. Проверки относятся к закреплённому head; выпуск ждёт CI итогового merge commit и независимое подтверждение установки.\n\nCodeworks workspace '+w.id+'; pinned '+leg.head+'; target '+leg.target+'; base '+leg.target_sha+'.';
        await mutation(leg,'pr_attempted',async()=>{pr=await github.create(p,leg,marker);});
      }
      const confirmed=await confirmPRHead(p,w,leg,pr,github,git);if(confirmed.wait)return confirmed.wait;pr=confirmed.pr;
      leg.pr_number=pr.number;leg.pr_url=pr.html_url;await persist();
      if(leg.merge_sha&&await git.verifyMerge(p,leg)){
        if(!pr.merged||pr.merge_commit_sha!==leg.merge_sha)return waiting('awaiting_reconciliation','GITHUB_MERGE_NOT_CONFIRMED');
        leg.merged=true;await persist();
      }else{
        if(pr.merged||pr.state!=='open')throw new Fault('CONFLICT','PR was closed or merged outside this durable candidate.');
        if(await git.remote(p,leg.target)!==leg.target_sha)throw new Fault('TARGET_CHANGED','Target changed; a new release intent and checks are required.');
        if(leg.merge_push_attempted)return waiting('awaiting_reconciliation','MERGE_PUSH_UNCERTAIN');
        const headGate=await checkGate(leg,leg.head,'head','HEAD_CHECKS_REQUIRED');if(headGate)return headGate;
        await git.fetch(p,leg.target,leg.target_sha);
        if(!leg.merge_sha){leg.merge_sha=await git.candidate(p,leg,op.created_at,op.id);await persist();}
        if(w.kind==='hotfix'&&name==='primary')await git.validateHotfixSource(p,w,leg.head);
        // AIDEV-NOTE: Повторное чтение закрывает обычные races; no-force push атомарно защищает последний промежуток.
        const fresh=await github.get(p,leg.pr_number);
        const freshConfirmed=await confirmPRHead(p,w,leg,fresh,github,git);if(freshConfirmed.wait)return freshConfirmed.wait;
        if(freshConfirmed.pr.merged||freshConfirmed.pr.state!=='open')throw new Fault('CONFLICT');
        const freshGate=await checkGate(leg,leg.head,'head','HEAD_CHECKS_REQUIRED');if(freshGate)return freshGate;
        if(await git.remote(p,leg.target)!==leg.target_sha)throw new Fault('TARGET_CHANGED');
        await mutation(leg,'merge_push_attempted',()=>git.push(p,leg.target,leg.merge_sha));
        if(!await git.verifyMerge(p,leg))return waiting('awaiting_reconciliation','MERGE_PUSH_UNCERTAIN');
        const merged=await github.get(p,leg.pr_number);
        const mergedConfirmed=await confirmPRHead(p,w,leg,merged,github,git);if(mergedConfirmed.wait)return mergedConfirmed.wait;
        if(!mergedConfirmed.pr.merged||mergedConfirmed.pr.merge_commit_sha!==leg.merge_sha)return waiting('awaiting_reconciliation','GITHUB_MERGE_NOT_CONFIRMED');
        leg.merged=true;await persist();
      }
    }
    const mergeGate=await checkGate(leg,leg.merge_sha,'merge','MERGE_CHECKS_REQUIRED');if(mergeGate)return mergeGate;
    const target=leg.target==='main'?'prod':'dev';
    const installed=await evidence(target,leg.merge_sha);
    if(!installed){
      if(await git.remote(p,leg.target)!==leg.merge_sha)throw new Fault('TARGET_CHANGED','Target advanced before installation; this release cannot replace it.');
      if(deploy&&leg.merge_ci){
        const deployment=await deploy(target,leg.merge_sha,leg.merge_ci,leg.deployment_retry_of??null);
        leg.deployment_operation_id=deployment.operation_id;await persist();
        if(deployment.status==='failed')return waiting('failed','DEPLOYMENT_FAILED');
      }
      return waiting('awaiting_deployment','EXACT_MERGE_DEPLOYMENT_REQUIRED');
    }
    leg.deployment_evidence_id=installed.id;await persist();await releaseLane(target);
  }
  return waiting('succeeded','VERIFIED_RELEASE_COMPLETED');
}
/** Публикует рабочую ветку и PR без принятия задачи, слияния и развёртывания. */
export async function advanceSync({project:p,workspace:w,operation:op,details}, {git,github,inspect,save,checkpoint=async()=>{}}) {
  if(!p.github)throw new Fault('CONFLICT','GitHub is not configured.');
  const current=await inspect(p,w),head=op.request.commit_sha;
  if(current.dirty||current.head!==head)throw new Fault('CONFLICT','Workspace changed during synchronization.');
  await git.validateHead(p,w,head);
  const leg=details.primary??={branch:w.branch,head,target:w.kind==='feature'?'dev':'main',target_sha:await git.remote(p,w.kind==='feature'?'dev':'main')};
  await save(details);
  if(await git.remote(p,w.branch)!==head){
    leg.push_attempted=true;await save(details);await checkpoint('before-sync-push');
    await git.push(p,w.branch,head);await checkpoint('after-sync-push');
    if(await git.remote(p,w.branch)!==head)return waiting('awaiting_reconciliation','BRANCH_PUSH_UNCERTAIN');
  }
  let pr=await github.find(p,leg);
  if(!pr){
    if(leg.pr_attempted){
      const historical=await github.find(p,leg,{state:'all',workspaceId:w.id,head:leg.head});
      if(historical)validatePR(p,w,leg,historical);
      return waiting('awaiting_reconciliation','PR_CREATE_UNCERTAIN');
    }
    leg.pr_attempted=true;await save(details);
    pr=await github.create(p,leg,'Codeworks workspace '+w.id+'; working branch.');
  }
  const confirmed=await confirmPRHead(p,w,leg,pr,github,git);if(confirmed.wait)return confirmed.wait;pr=confirmed.pr;
  if(pr.state!=='open'||pr.merged)throw new Fault('CONFLICT','Working PR is already closed.');
  leg.pr_number=pr.number;leg.pr_url=pr.html_url;await save(details);
  return waiting('succeeded','SYNCHRONIZED');
}
/** Fail closed: absent, pending, failed, skipped, wrong app или SHA не дают merge/release. */
export function checksPassed(required,checks,sha) {
  return required?.length>0&&required.every(r=>{
    const matching=checks.filter(c=>c.name===r.name&&c.app_id===r.app_id);
    return matching.length===1&&matching[0].sha===sha&&matching[0].status==='completed'&&matching[0].conclusion==='success';
  });
}
