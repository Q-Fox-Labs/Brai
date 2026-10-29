// ABOUTME: Выполняет Git шаги с immutable объектами и атомарной проверкой remote refs.
// ABOUTME: Публикует без перезаписи истории; удаляет только ветку задачи с точным ожидаемым SHA.
import { command } from './git.mjs';
import { Fault } from './errors.mjs';
const sha=value=>/^[0-9a-f]{40}$/.test(value);
const branch=value=>/^(?:dev|main|(?:feature|hotfix)\/[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(value)&&value.length<=72;
/** Создаёт адаптер; localRemote разрешён только изолированным fixture, не runtime-конфигурацией. */
export function createFlowGit({run=command,localRemote=false,requireLock=()=>{if(process.env.CODEWORKS_LOCK_HELD!=='1')throw new Fault('INTERNAL','Git mutation requires the project lock.');}}={}) {
  const git=(p,args,options)=>run('git',['-C',p.repo_path,...args],options);
  const locked=requireLock;
  async function origin(p) {
    const url=(await git(p,['remote','get-url','--push','--all','origin'])).stdout;
    const read=(await git(p,['remote','get-url','--all','origin'])).stdout;
    const expected='https://github.com/'+p.github.repository+'.git';
    if(url!==read||(!localRemote&&url!==expected))throw new Fault('OWNERSHIP_CONFLICT','Origin differs from registered GitHub repository.');
  }
  async function readRemote(p,b) {
    await origin(p);
    const raw=(await git(p,['ls-remote','--refs','origin','refs/heads/'+b])).stdout;
    if(!raw)return null;
    const rows=raw.split('\n');const [head,ref]=rows[0].split(/\s+/);
    if(rows.length!==1||!sha(head)||ref!=='refs/heads/'+b)throw new Fault('GIT_FAILED');
    return head;
  }
  async function remote(p,b,{legacy=false}={}) {
    if(!branch(b)&&!(legacy&&/^(?:codex|feature)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(b)))throw new Fault('INVALID_ARGUMENT');
    return readRemote(p,b);
  }
  async function remoteHistorical(p,b) {
    if(!/^(?:(?:feature|hotfix)\/[A-Za-z0-9][A-Za-z0-9._-]*|release\/codeworks-[0-9a-f-]{36})$/.test(b))throw new Fault('INVALID_ARGUMENT');
    return readRemote(p,b);
  }
  async function ancestor(p,a,b){if(!sha(a)||!sha(b))throw new Fault('INVALID_ARGUMENT');return (await git(p,['merge-base','--is-ancestor',a,b],{allowFailure:true})).code===0;}
  async function fetch(p,b,expected) {
    locked();await origin(p);if(!branch(b)||!sha(expected))throw new Fault('INVALID_ARGUMENT');
    // AIDEV-NOTE: FETCH_HEAD и общие tracking refs нельзя использовать как результат параллельного fetch.
    if(await remote(p,b)!==expected)throw new Fault('TARGET_CHANGED');
    await git(p,['fetch','--no-tags','--no-write-fetch-head','--no-auto-maintenance','--refmap=','origin',expected]);
    if(await remote(p,b)!==expected)throw new Fault('TARGET_CHANGED');
    await git(p,['cat-file','-e',expected+'^{commit}']);
  }
  return {
    remote,remoteHistorical,ancestor,
    /** Fetch не меняет checkout; результат должен совпасть с закреплённой remote версией. */
    fetch,
    /** Требует происхождение от frozen base; hotfix не может импортировать merge dev. */
    async validateHead(p,w,head) {
      if(!await ancestor(p,w.base_sha,head))throw new Fault('CONFLICT');
      if(!['feature','hotfix'].includes(w.kind))throw new Fault('INVALID_ARGUMENT');
      if(w.kind==='hotfix'&&(await git(p,['rev-list','--min-parents=2',w.base_sha+'..'+head])).stdout)throw new Fault('CONFLICT','Hotfix must be linear from the installed production base.');
    },
    /** Сверяет commit ancestry со свежим dev до публикации main; copied/cherry-picked строки этим не определяются. */
    async validateHotfixSource(p,w,head) {
      const dev=await remote(p,'dev');if(!dev)throw new Fault('CONFLICT','Hotfix requires the current dev ancestry.');
      await fetch(p,'dev',dev);
      const added=(await git(p,['rev-list','--count',head,'^'+w.base_sha])).stdout;
      const independent=(await git(p,['rev-list','--count',head,'^'+w.base_sha,'^'+dev])).stdout;
      if(added!==independent)throw new Fault('CONFLICT','Hotfix contains unreleased dev commits.');
    },
    /** Создаёт детерминированный commit с ровно двумя закреплёнными parents; конфликт не меняет ветки. */
    async candidate(p,leg,date,operationId) {
      locked();if(!sha(leg.target_sha)||!sha(leg.head))throw new Fault('INVALID_ARGUMENT');
      const result=await git(p,['merge-tree','--write-tree',leg.target_sha,leg.head],{allowFailure:true});
      if(result.code!==0)throw new Fault('MERGE_CONFLICT','Merge conflict; owned branch and worktree preserved.');
      const tree=result.stdout.split('\n')[0];if(!sha(tree))throw new Fault('GIT_FAILED');
      return (await git(p,['-c','commit.gpgsign=false','commit-tree',tree,'-p',leg.target_sha,'-p',leg.head],{input:'Codeworks '+operationId+' '+leg.target+'\n',env:{GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date}})).stdout;
    },
    /** Безусловный force запрещён; сервер атомарно отвергает divergent concurrent target. */
    async push(p,b,head) {
      locked();await origin(p);if(!branch(b)||!sha(head))throw new Fault('INVALID_ARGUMENT');
      await git(p,['push','--porcelain','origin',head+':refs/heads/'+b]);
    },
    /** Удаляет только feature/hotfix ref с ожидаемым SHA; отсутствие после сбоя означает успех. */
    async removeBranch(p,b,expected,{legacy=false}={}) {
      locked();if((!branch(b)&&!(legacy&&/^(?:codex|feature)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(b)))||(!b.startsWith('feature/')&&!b.startsWith('hotfix/')&&!(legacy&&b.startsWith('codex/')))||!sha(expected))throw new Fault('INVALID_ARGUMENT');
      const current=await remote(p,b,{legacy});if(current===null)return;
      if(current!==expected)throw new Fault('TARGET_CHANGED','Task branch changed after release; cleanup preserved it.');
      await git(p,['push','--porcelain','--force-with-lease=refs/heads/'+b+':'+expected,'origin',':refs/heads/'+b]);
      if(await remote(p,b,{legacy})!==null)throw new Fault('TARGET_CHANGED','Task branch still exists; retry cleanup after inspection.');
    },
    /** Доказывает точные parents слияния и наличие commit в фактическом remote target. */
    async verifyMerge(p,leg) {
      const current=await remote(p,leg.target);if(!current)return false;
      await this.fetch(p,leg.target,current);
      const parents=(await git(p,['rev-list','--parents','-n','1',leg.merge_sha])).stdout.split(' ');
      if(parents.join(' ')!==[leg.merge_sha,leg.target_sha,leg.head].join(' '))throw new Fault('CONFLICT','Merge parents differ from durable candidate.');
      return ancestor(p,leg.merge_sha,current);
    },
  };
}
