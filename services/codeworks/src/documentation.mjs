// ABOUTME: Фиксирует только свои документационные bytes и публикует их без worktree.
// ABOUTME: Private index формирует commit; общий index меняется только по CAS своих entries.
import {createHash} from 'node:crypto';
import {readFile,lstat,realpath,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {command} from './git.mjs';
import {Fault} from './errors.mjs';
const reject=()=>{throw new Fault('OWNERSHIP_CONFLICT');};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(p,args,options={})=>command('git',['-C',p.repo_path,...args],options);
export function documentationPath(p,file){
  return typeof file==='string'&&!path.isAbsolute(file)&&!file.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.'))&&/\.(md|txt|rst|adoc)$/.test(file)&&
    (p.documentation_paths??[]).some(prefix=>file===prefix||file.startsWith(prefix+'/'))&&!p.excluded_paths.some(prefix=>file===prefix||file.startsWith(prefix+'/'));
}
/** Чтение не следует symlink и ограничивает объём журнала. */
export async function documentationBytes(p,file){
  if(!documentationPath(p,file))reject();
  const target=path.join(p.repo_path,file);let item;
  try{item=await lstat(target);}catch(error){if(error.code!=='ENOENT')throw error;return null;}
  if(!item.isFile()||item.isSymbolicLink()||item.size>1048576||await realpath(target)!==target)reject();
  const bytes=await readFile(target);return {bytes:bytes.toString('base64'),sha256:hash(bytes),mode:(item.mode&0o111)?'100755':'100644'};
}
const same=(a,b)=>a===null?b===null:b!==null&&a.sha256===b.sha256&&a.mode===b.mode;
/** Допускает dirty bytes лишь из прежней записи этой сессии; чужой staged diff отвергается. */
export async function beginDocumentation(p,journal,files){
  if((await git(p,['symbolic-ref','HEAD'])).stdout!=='refs/heads/dev')reject();
  const entries={...(journal?.entries??{})};
  for(const file of files){
    const current=await documentationBytes(p,file);
    if(entries[file]){if(!same(current,entries[file].after))reject();continue;}
    if((await git(p,['status','--porcelain=v1','--untracked-files=all','--',file])).stdout)reject();
    entries[file]={before:current,after:current,index:(await git(p,['ls-files','--stage','--',file])).stdout};
  }
  return {...journal,entries};
}
/** Проверяется и при admission, и непосредственно перед планированием/CAS. */
export async function checkDocumentation(p,journal){
  if(!journal?.entries||!Object.keys(journal.entries).length)reject();
  for(const [file,entry]of Object.entries(journal.entries)){
    if(!same(await documentationBytes(p,file),entry.after))reject();
    if((await git(p,['ls-files','--stage','--',file])).stdout!==entry.index)reject();
  }
}
/** Формирует immutable object из journal, никогда не читая общий index для staging. */
export async function planDocumentation(p,op){
  if(process.env.CODEWORKS_LOCK_HELD!=='1')reject();
  const journal=op.request.documentation;await checkDocumentation(p,journal);
  if((await git(p,['symbolic-ref','HEAD'])).stdout!=='refs/heads/dev')reject();
  const parent_sha=(await git(p,['rev-parse','HEAD'])).stdout;
  const remote=(await git(p,['ls-remote','--exit-code','origin','refs/heads/dev'])).stdout.split(/\s/)[0];
  if(remote!==parent_sha)throw new Fault('TARGET_CHANGED');
  for(const [file,entry]of Object.entries(journal.entries)){
    const actual=(await git(p,['ls-tree',parent_sha,'--',file])).stdout;
    const expected=entry.index.replace(' 0\t','\t').replace(' ', ' blob ');
    if(actual!==expected)reject();
  }
  const index=path.join(p.common_dir,'codeworks-docs-'+op.id),env={GIT_INDEX_FILE:index};
  await git(p,['read-tree',parent_sha],{env});
  for(const [file,entry]of Object.entries(journal.entries)){
    if(entry.after===null)await git(p,['update-index','--force-remove','--',file],{env});
    else{
      const bytes=Buffer.from(entry.after.bytes,'base64');if(hash(bytes)!==entry.after.sha256)reject();
      const oid=(await git(p,['hash-object','-w','--stdin'],{input:bytes})).stdout;
      await git(p,['update-index','--add','--cacheinfo',entry.after.mode+','+oid+','+file],{env});
    }
  }
  const tree=(await git(p,['write-tree'],{env})).stdout,date=new Date(op.created_at).toISOString();
  const commit_sha=(await git(p,['-c','commit.gpgsign=false','commit-tree',tree,'-p',parent_sha,'-F','-'],{input:op.request.message+'\n\nCodeworks-Operation: '+op.id+'\n',env:{GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date}})).stdout;
  return {parent_sha,commit_sha,tree,index};
}
/** CAS проверяется снова после crash; запись перед push исключает слепую повторную отправку. */
export async function finishDocumentation(p,op,plan,save=async()=>{}){
  if(process.env.CODEWORKS_LOCK_HELD!=='1')reject();
  const remote=async()=>(await git(p,['ls-remote','--exit-code','origin','refs/heads/dev'])).stdout.split(/\s/)[0];
  if(await remote()===plan.commit_sha){await unlink(plan.index).catch(error=>{if(error.code!=='ENOENT')throw error;});return {commit_sha:plan.commit_sha};}
  const journal=op.request.documentation;
  // Take Git's standard index lock, preserve every foreign entry and only refresh our paths.
  const indexFile=(await git(p,['rev-parse','--path-format=absolute','--git-path','index'])).stdout,lock=indexFile+'.lock';
  await writeFile(lock,'',{flag:'wx',mode:0o600});
  try{
    await writeFile(lock,await readFile(indexFile));
    const env={GIT_INDEX_FILE:lock};
    for(const [file,entry]of Object.entries(journal.entries)){
      if(!same(await documentationBytes(p,file),entry.after))reject();
      const current=(await git(p,['ls-files','--stage','--',file],{env})).stdout;
      const final=(await git(p,['ls-tree',plan.commit_sha,'--',file])).stdout.replace(' blob ',' ').replace('\t',' 0\t');
      if(current!==entry.index&&current!==final)reject();
    }
    if((await git(p,['symbolic-ref','HEAD'])).stdout!=='refs/heads/dev')reject();
    const head=(await git(p,['rev-parse','HEAD'])).stdout;
    if(head!==plan.parent_sha&&head!==plan.commit_sha)throw new Fault('TARGET_CHANGED');
    if(head!==plan.commit_sha)await git(p,['update-ref','refs/heads/dev',plan.commit_sha,plan.parent_sha]);
    for(const file of Object.keys(journal.entries)){
      const final=(await git(p,['ls-tree',plan.commit_sha,'--',file])).stdout;
      if(!final)await git(p,['update-index','--force-remove','--',file],{env});
      else{const [mode,,oid]=final.split(/\s+/);await git(p,['update-index','--add','--cacheinfo',mode+','+oid+','+file],{env});}
    }
    const {rename}=await import('node:fs/promises');await rename(lock,indexFile);
  }finally{await unlink(lock).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  let actual=await remote();
  if(actual!==plan.commit_sha){
    if(actual!==plan.parent_sha)throw new Fault('TARGET_CHANGED');
    if(plan.push_attempted)throw new Fault('GIT_FAILED');
    plan={...plan,push_attempted:true};await save(plan);
    await git(p,['push','origin',plan.commit_sha+':refs/heads/dev'],{allowFailure:true});
    actual=await remote();if(actual!==plan.commit_sha)throw new Fault('GIT_FAILED');
  }
  await unlink(plan.index).catch(error=>{if(error.code!=='ENOENT')throw error;});
  return {commit_sha:plan.commit_sha};
}
