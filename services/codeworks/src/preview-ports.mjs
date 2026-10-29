// ABOUTME: Подключает Git и удостоверенный CI к координатору веб-превью.
// ABOUTME: Источники читаются из точных Git объектов; сборка в рабочем дереве не выполняется.
import {matchesGlob,posix,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {command} from './git.mjs';
import {canonical} from './ci-verifier.mjs';
import {createGitHub} from './github.mjs';
import {createCIEvidence} from './ci-evidence.mjs';
import {createPreviewAdapter} from './preview-adapter.mjs';

const keys=descriptor=>({build:descriptor.inputs?.build??[],runtime:descriptor.inputs?.runtime??[],dependencies:descriptor.dependencies?.map(d=>({id:d.id,inputs:d.inputs}))??[],npm:descriptor.npm,delivery:descriptor.delivery,commands:{build:descriptor.commands?.build}});
const stable=value=>JSON.stringify(canonical(value));
/** Сопоставляет diff с web build/runtime и явными контрактами зависимостей. */
export function classifyWebChanges(before,after,diff,{lockChanged=false}={}) {
  const patterns=[before,after].flatMap(c=>[...c.inputs.build,...c.inputs.runtime,...c.dependencies.flatMap(d=>d.inputs)]);
  const runtime=diff.some(file=>patterns.some(pattern=>matchesGlob(file,pattern)) || ['package.json','services/codeworks/ci/toolchain.json'].includes(file));
  const backend=diff.some(file=>(file.startsWith('services/')&&!file.startsWith('services/codeworks/')) || (file.startsWith('apps/')&&!file.startsWith('apps/web/')));
  return {web:runtime||lockChanged||stable(keys(before))!==stable(keys(after)),backend};
}
/** Выбирает lock closure веба, включая build-зависимости, без исполнения кода ветки. */
export function previewLockClosure(lock,workspaces) {
  if(!lock?.packages||lock.lockfileVersion<2)throw Error('PREVIEW_LOCK_INVALID');
  const found=new Map(),pending=[];
  const add=(key,workspace=false)=>{if(found.has(key))return;const item=lock.packages[key];if(!item)throw Error('PREVIEW_LOCK_MISSING');found.set(key,item);
    if(item.link){add(item.resolved,true);return;}
    for(const name of Object.keys({...item.dependencies,...(workspace?item.devDependencies:{}),...item.optionalDependencies,...item.peerDependencies})) {
      if(!/^(?:@[^/]+\/)?[^/]+$/.test(name)||name.includes('..')||name.includes('\\'))throw Error('PREVIEW_LOCK_INVALID');
      pending.push({from:key,name,optional:!!item.optionalDependencies?.[name]||!!item.peerDependenciesMeta?.[name]?.optional});
    }
  };
  for(const workspace of workspaces){if(workspace.startsWith('/')||workspace.split('/').includes('..'))throw Error('PREVIEW_LOCK_INVALID');add(workspace==='.'?'':workspace,true);}
  while(pending.length){const {from,name,optional}=pending.pop(),choices=[];
    for(let cursor=from;cursor&&cursor!=='.';cursor=posix.dirname(cursor))if(basename(cursor)!=='node_modules')choices.push(`${cursor}/node_modules/${name}`);
    choices.push('node_modules/'+name);const key=choices.find(candidate=>lock.packages[candidate]);
    if(!key){if(optional)continue;throw Error('PREVIEW_LOCK_MISSING');}add(key);
  }
  return [...found].sort(([a],[b])=>a.localeCompare(b));
}
/** Формирует read-only Git/CI порты с проверенным evidence store и заменяемым adapter. */
export function createPreviewPorts({flowGit,verifier,adapter=createPreviewAdapter(),run=command}) {
  const evidence=createCIEvidence(verifier),github=createGitHub({evidenceStore:evidence});
  const git=(p,args)=>run('git',['-C',p.repo_path,...args]);
  return {
    remote:(p,w)=>flowGit.remote(p,w.branch,{legacy:true}),
    async closed(p,w,head) {
      const leg={branch:w.branch,target:w.kind==='hotfix'?'main':'dev'};
      const open=await github.find(p,leg);if(open)return false;
      const prior=await github.find(p,leg,{state:'all'});
      return !!prior && prior.state==='closed';
    },
    async classify(p,w,head) {
      if(await flowGit.remote(p,w.branch,{legacy:true})!==head)throw Error('PREVIEW_HEAD_CHANGED');
      await git(p,['fetch','--no-tags','--no-write-fetch-head','--no-auto-maintenance','--refmap=','origin',head]);
      if(await flowGit.remote(p,w.branch,{legacy:true})!==head)throw Error('PREVIEW_HEAD_CHANGED');
      await flowGit.validateHead(p,w,head);
      const diff=(await git(p,['diff','--name-only','-z',w.base_sha,head,'--'])).stdout.split('\0').filter(Boolean);
      const before=JSON.parse((await git(p,['show',w.base_sha+':apps/web/component.json'])).stdout);
      const after=JSON.parse((await git(p,['show',head+':apps/web/component.json'])).stdout);
      let lockChanged=false;
      if(diff.includes('package-lock.json')) {
        const oldLock=JSON.parse((await git(p,['show',w.base_sha+':package-lock.json'])).stdout);
        const newLock=JSON.parse((await git(p,['show',head+':package-lock.json'])).stdout);
        lockChanged=stable(previewLockClosure(oldLock,before.npm.workspaces))!==stable(previewLockClosure(newLock,after.npm.workspaces));
      }
      return classifyWebChanges(before,after,diff,{lockChanged});
    },
    async verify(p,sha) {
      const checks=await github.checks(p,sha),check=checks.find(c=>c.sha===sha&&c.ci_verified===true&&c.conclusion==='success');
      if(!check?.ci_evidence)return {verified:false,state:checks.find(c=>c.sha===sha&&c.ci_state)?.ci_state??'CI_NOT_VERIFIED'};
      const entry=check.ci_evidence,proof=await evidence.read(p,entry.run_id,entry.attempt);
      const web=proof?.composition?.components?.find(c=>c.id==='web');
      if(proof?.composition?.source!==sha||proof?.published?.digest!==entry.composition_digest||!web?.artifact?.reference)return {verified:false};
      const policy_sha256=createHash('sha256').update(stable(p.github.ci)).digest('hex');
      return {verified:true,evidence:{...entry,policy_sha256},image_reference:web.artifact.reference};
    },
    adapter,
  };
}
