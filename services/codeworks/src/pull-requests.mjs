// ABOUTME: Хранит неизменяемую привязку PR к области и целевой ветке Codeworks.
// ABOUTME: Описание GitHub не используется; вызывающий проверяет живые refs, репозитории и SHA.
import {Fault} from './errors.mjs';

/** Порт get/bind работает под execution guard области; повтор не меняет прежний номер PR. */
export function createPullRequests(db) {
  const verify=(p,w,leg,row)=>{
    if(row&&(row.repository!==p.github.repository.toLowerCase()||row.branch!==leg.branch||row.project_id!==p.id||row.workspace_id!==w.id||row.target!==leg.target||(leg.pr_number&&Number(row.pr_number)!==leg.pr_number)))throw new Fault('PR_IDENTITY_CONFLICT','Stored PR binding differs from pinned intent.');
    return row?Number(row.pr_number):null;
  };
  const read=async(w,leg)=>(await db.query('SELECT * FROM codeworks.pull_requests WHERE workspace_id=$1 AND target=$2',[w.id,leg.target])).rows[0];
  return {
    get:async(p,w,leg)=>verify(p,w,leg,await read(w,leg)),
    bind:async(p,w,leg,pr)=>{
      await db.query('INSERT INTO codeworks.pull_requests(workspace_id,project_id,repository,branch,target,pr_number) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[w.id,p.id,p.github.repository.toLowerCase(),leg.branch,leg.target,pr.number]);
      const number=verify(p,w,leg,await read(w,leg));
      if(number!==pr.number)throw new Fault('PR_IDENTITY_CONFLICT','PR is already bound to another workspace or number.');
    },
  };
}
