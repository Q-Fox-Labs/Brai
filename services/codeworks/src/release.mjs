// ABOUTME: Продолжает durable Git flow feature, promotion и hotfix через явные порты.
// ABOUTME: Merge не означает CI или установленный выпуск; неопределённую публикацию сначала сверяет чтением.
import { Fault } from './errors.mjs';
const waiting=(status,reason)=>({status,reason});
/** Один ограниченный проход. save фиксирует все намерения ДО Git/GitHub мутаций; evidence — доверенный owner state. */
export async function advanceRelease({project:p,workspace:w,operation:op,release}, {git,github,inspect,save,evidence,checkpoint=async()=>{}}) {
  const flow=release.details;
  const persist=async()=>save(flow);
  const mutation=async(leg,key,work)=>{
    leg[key]=true;await persist();await checkpoint('before-'+key);
    await work();await checkpoint('after-'+key);
  };
  if(!p.github)return waiting('awaiting_execution','GIT_FLOW_NOT_CONFIGURED');
  const current=await inspect(p,w);
  if(current.dirty||current.head!==release.requested_sha)throw new Fault('CONFLICT','Workspace differs from the pinned release request.');
  await git.validateHead(p,w,release.requested_sha);
  if(!flow.primary){
    const target=w.kind==='feature'?'dev':'main';
    const target_sha=await git.remote(p,target);
    if(!target_sha||target_sha===release.requested_sha)throw new Fault('CONFLICT','Release has no new commit for this target.');
    if(w.kind==='hotfix'){
      const installed=await evidence('prod');
      if(!installed||installed.commit_sha!==w.base_sha||target_sha!==w.base_sha)throw new Fault('PRODUCTION_BASE_MISMATCH');
    }
    flow.primary={branch:w.branch,head:release.requested_sha,target,target_sha};await persist();
  }
  for(const name of w.kind==='hotfix'?['primary','backport']:['primary']){
    if(!flow[name]){
      flow[name]={branch:w.branch,head:release.requested_sha,target:'dev',target_sha:await git.remote(p,'dev')};await persist();
    }
    const leg=flow[name];
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
        if(leg.pr_attempted)return waiting('awaiting_reconciliation','PR_CREATE_UNCERTAIN');
        const marker='Запрос слияния отдельной области Codeworks. Проверки относятся к закреплённому head; выпуск ждёт CI итогового merge commit и независимое подтверждение установки.\n\nCodeworks workspace '+w.id+'; pinned '+leg.head+'; target '+leg.target+'; base '+leg.target_sha+'.';
        await mutation(leg,'pr_attempted',async()=>{pr=await github.create(p,leg,marker);});
      }
      if(!pr.body?.includes('Codeworks workspace '+w.id+';')||pr.head?.sha!==leg.head||pr.head?.ref!==leg.branch||pr.base?.ref!==leg.target||pr.head?.repo?.full_name?.toLowerCase()!==p.github.repository.toLowerCase()||pr.base?.repo?.full_name?.toLowerCase()!==p.github.repository.toLowerCase())throw new Fault('CONFLICT','PR head, repository or target differs from pinned intent.');
      leg.pr_number=pr.number;leg.pr_url=pr.html_url;await persist();
      if(leg.merge_sha&&await git.verifyMerge(p,leg)){
        if(!pr.merged||pr.merge_commit_sha!==leg.merge_sha)return waiting('awaiting_reconciliation','GITHUB_MERGE_NOT_CONFIRMED');
        leg.merged=true;await persist();
      }else{
        if(pr.merged||pr.state!=='open')throw new Fault('CONFLICT','PR was closed or merged outside this durable candidate.');
        if(await git.remote(p,leg.target)!==leg.target_sha)throw new Fault('TARGET_CHANGED','Target changed; a new release intent and checks are required.');
        if(leg.merge_push_attempted)return waiting('awaiting_reconciliation','MERGE_PUSH_UNCERTAIN');
        if(!checksPassed(p.github.required_checks,await github.checks(p,leg.head),leg.head))return waiting('awaiting_ci','HEAD_CHECKS_REQUIRED');
        await git.fetch(p,leg.target,leg.target_sha);
        if(!leg.merge_sha){leg.merge_sha=await git.candidate(p,leg,op.created_at,op.id);await persist();}
        // AIDEV-NOTE: Повторное чтение закрывает обычные races; no-force push атомарно защищает последний промежуток.
        const fresh=await github.get(p,leg.pr_number);
        if(fresh.head?.sha!==leg.head||fresh.state!=='open')throw new Fault('CONFLICT');
        if(!checksPassed(p.github.required_checks,await github.checks(p,leg.head),leg.head))return waiting('awaiting_ci','HEAD_CHECKS_REQUIRED');
        if(await git.remote(p,leg.target)!==leg.target_sha)throw new Fault('TARGET_CHANGED');
        await mutation(leg,'merge_push_attempted',()=>git.push(p,leg.target,leg.merge_sha));
        if(!await git.verifyMerge(p,leg))return waiting('awaiting_reconciliation','MERGE_PUSH_UNCERTAIN');
        const merged=await github.get(p,leg.pr_number);
        if(!merged.merged||merged.merge_commit_sha!==leg.merge_sha)return waiting('awaiting_reconciliation','GITHUB_MERGE_NOT_CONFIRMED');
        leg.merged=true;await persist();
      }
    }
    if(!checksPassed(p.github.required_checks,await github.checks(p,leg.merge_sha),leg.merge_sha))return waiting('awaiting_ci','MERGE_CHECKS_REQUIRED');
    const target=leg.target==='main'?'prod':'dev';
    const installed=await evidence(target,leg.merge_sha);
    if(!installed)return waiting('awaiting_deployment','EXACT_MERGE_DEPLOYMENT_REQUIRED');
    leg.deployment_evidence_id=installed.id;await persist();
  }
  return waiting('succeeded','VERIFIED_RELEASE_COMPLETED');
}
/** Fail closed: absent, pending, failed, skipped, wrong app или SHA не дают merge/release. */
export function checksPassed(required,checks,sha) {
  return required?.length>0&&required.every(r=>{
    const matching=checks.filter(c=>c.name===r.name&&c.app_id===r.app_id);
    return matching.length===1&&matching[0].sha===sha&&matching[0].status==='completed'&&matching[0].conclusion==='success';
  });
}
