// ABOUTME: Проверяет и удаляет только явно закреплённые orphan Git refs.
// ABOUTME: Не создаёт фиктивную область, не удаляет каталоги и индексы и не обращается к БД.
import {realpath} from 'node:fs/promises';
import {command} from './git.mjs';
import {createFlowGit} from './git-flow.mjs';
import {Fault} from './errors.mjs';
const validRef=ref=>typeof ref==='string'&&/^refs\/heads\/(?:feature|hotfix|codex)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref);
/** Только после полного чтения refs и отсутствия любых маркеров/регистраций ветки. */
export function branchResourcesAbsent(value){return !!value&&value.remote?.known===true&&value.branch?.oid===null&&value.remote?.oid===null&&value.tracking?.oid===null&&value.ownership?.ref===null&&value.ownership?.oid===null&&value.worktree?.path===null&&value.worktree?.registered===false&&value.index?.scope==='not_allocated_by_codeworks';}
/** Возвращает адаптер Git refs; local_refs требует унаследованный project flock. */
export function createBranchCleanup({flowGit=createFlowGit({requireLock:()=>{}})}={}){
 const git=(p,args,opts={})=>command('git',['-C',p.repo_path,...args],opts);
 const refOid=async(p,ref)=>{const r=await git(p,['rev-parse','--verify','--quiet',ref],{allowFailure:true});if(r.code===1)return null;if(r.code!==0)throw new Fault('GIT_FAILED');return r.stdout;};
 const inspect=async(p,subject,{localOnly=false}={})=>{
  const ref=subject?.ref;if(!validRef(ref))throw new Fault('INVALID_ARGUMENT');
  if(await realpath(p.repo_path)!==p.repo_path||await realpath(p.common_dir)!==p.common_dir||(await git(p,['rev-parse','--show-toplevel'])).stdout!==p.repo_path||(await git(p,['rev-parse','--path-format=absolute','--git-common-dir'])).stdout!==p.common_dir)throw new Fault('OWNERSHIP_CONFLICT');
  const branch=ref.slice('refs/heads/'.length),local=await refOid(p,ref),trackingRef='refs/remotes/origin/'+branch,tracking=await refOid(p,trackingRef);
  const markers=(await git(p,['for-each-ref','--format=%(refname)','refs/codeworks/ownership/'])).stdout.split('\n').filter(Boolean);
  for(const marker of markers){let data;try{data=JSON.parse((await git(p,['cat-file','blob',marker])).stdout);}catch{throw new Fault('OWNERSHIP_CONFLICT');}if(typeof data.branch!=='string'||data.branch===branch)throw new Fault('OWNERSHIP_CONFLICT');}
  const raw=(await git(p,['worktree','list','--porcelain','-z'])).stdout;
  for(const block of raw.split('\0\0'))if(block.split('\0').includes('branch '+ref))throw new Fault('OWNERSHIP_CONFLICT');
  const remote=localOnly?null:await flowGit.remote(p,branch,{legacy:true});
  return {branch:{ref,oid:local},remote:{ref,oid:remote,known:!localOnly},tracking:{ref:trackingRef,oid:tracking},ownership:{ref:null,oid:null},worktree:{path:null,registered:false},index:{scope:'not_allocated_by_codeworks'}};
 };
 const cleanupStep=async(p,subject,expected,step)=>{
  if(!['remote','local_refs'].includes(step)||!expected||expected.branch?.ref!==subject.ref||expected.remote?.ref!==subject.ref||expected.tracking?.ref!=='refs/remotes/origin/'+subject.ref.slice('refs/heads/'.length)||expected.remote.known!==true||expected.ownership?.ref!==null||expected.ownership?.oid!==null||expected.worktree?.path!==null||expected.worktree?.registered!==false||expected.index?.scope!=='not_allocated_by_codeworks')throw new Fault('INVALID_ARGUMENT');
  if(step==='local_refs'&&process.env.CODEWORKS_LOCK_HELD!=='1')throw new Fault('INTERNAL');
  const current=await inspect(p,subject,{localOnly:step==='local_refs'});
  for(const name of (step==='remote'?['branch','tracking','remote']:['branch','tracking']))if(current[name].oid!==null&&current[name].oid!==expected[name].oid)throw new Fault('TARGET_CHANGED');
  let changed=false;
  if(step==='remote'&&current.remote.oid){await flowGit.removeBranch(p,subject.ref.slice('refs/heads/'.length),current.remote.oid,{legacy:true});changed=true;}
  if(step==='local_refs'){
   const lines=[];for(const name of ['branch','tracking'])if(current[name].oid)lines.push('delete '+current[name].ref+' '+current[name].oid);
   if(lines.length){await git(p,['update-ref','--stdin'],{input:'start\n'+lines.join('\n')+'\nprepare\ncommit\n'});changed=true;}
  }
  return {step,outcome:changed?'removed':'already_absent',observation:await inspect(p,subject,{localOnly:step==='local_refs'})};
 };
 return {inspect,cleanupStep};
}
