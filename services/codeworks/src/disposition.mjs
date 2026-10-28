// ABOUTME: Проверяет точный перенос результата рабочей области в постоянную ветку.
// ABOUTME: Только читает Git; неподтверждённые и преобразованные результаты блокируют очистку.
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {command} from './git.mjs';
import {Fault} from './errors.mjs';

const sha=value=>typeof value==='string'&&/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const relative=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\x00-\x1f\x7f\\]/.test(value)&&!path.posix.isAbsolute(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..');
const keys=(v,expected)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...expected].sort().join(',');
const reject=()=>{throw new Fault('TRANSFER_UNVERIFIED');};

/** Проверяет все изменения и возвращает снимок доказательства; при сомнении бросает TRANSFER_UNVERIFIED. */
export async function verifyDisposition(project,w,evidence,{allowedRepositories=[],git}={}){
  try{
    if(!keys(evidence,['destination','source_head','source_base','files'])||!keys(evidence.destination,['repo_path','commit_sha'])||!sha(evidence.source_head)||!sha(evidence.source_base)||!sha(evidence.destination.commit_sha)||!Array.isArray(evidence.files)||evidence.files.length>256||!allowedRepositories.includes(evidence.destination.repo_path)||!allowedRepositories.includes(project.repo_path)||w.base_sha&&w.base_sha!==evidence.source_base)reject();
    const destination=evidence.destination.repo_path;
    if(!path.isAbsolute(destination)||await realpath(destination)!==destination||!path.isAbsolute(w.path)||await realpath(w.path)!==w.path)reject();
    const run=git??((repo,args,options)=>command('git',['-C',repo,...args],options));
    const call=async(repo,args,options)=>run(repo,args,options);
    const source=async(...args)=>(await call(w.path,args)).stdout;
    const dest=async(...args)=>(await call(destination,args)).stdout;
    if(await source('rev-parse','--show-toplevel')!==w.path||await dest('rev-parse','--show-toplevel')!==destination||await source('rev-parse','--path-format=absolute','--git-common-dir')!==project.common_dir)reject();
    const head=await source('rev-parse','HEAD');
    if(head!==evidence.source_head||await source('status','--porcelain=v1','--untracked-files=all'))reject();
    if((await call(w.path,['merge-base','--is-ancestor',evidence.source_base,head],{allowFailure:true})).code!==0)reject();
    if(await source('rev-parse',evidence.source_base+'^{commit}')!==evidence.source_base||await dest('rev-parse',evidence.destination.commit_sha+'^{commit}')!==evidence.destination.commit_sha)reject();
    const changes=(await source('diff','--name-status','-z','--no-renames','--no-ext-diff',evidence.source_base,head,'--')).split('\0');
    if(changes.at(-1)==='')changes.pop();
    if(changes.length%2)reject();
    const diff=new Map();
    for(let i=0;i<changes.length;i+=2){const [status,name]=changes.slice(i,i+2);if(!['A','M','D','T'].includes(status)||!relative(name)||diff.has(name))reject();diff.set(name,status);}
    if(diff.size!==evidence.files.length)reject();
    let permanent=null;
    for(const ref of ['refs/heads/dev','refs/heads/main']){
      const current=await call(destination,['rev-parse','--verify',ref+'^{commit}'],{allowFailure:true});
      if(current.code===0&&sha(current.stdout)&&(await call(destination,['merge-base','--is-ancestor',evidence.destination.commit_sha,current.stdout],{allowFailure:true})).code===0){permanent={ref,oid:current.stdout};break;}
    }
    if(!permanent)reject();
    const entry=async(repo,commit,file)=>{
      const result=await call(repo,['--literal-pathspecs','ls-tree','-z','--full-tree',commit,'--',file]);
      if(!result.stdout)return null;
      const match=/^(\d{6}) (blob) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(result.stdout);
      if(!match||match[4]!==file)reject();
      return {mode:match[1],blob:match[3]};
    };
    const seen=new Set(),destinations=new Set(),files=[];
    for(const file of evidence.files){
      if(!keys(file,['status','source_path','destination_path','source_blob','destination_blob'])||!relative(file.source_path)||!relative(file.destination_path)||seen.has(file.source_path)||destinations.has(file.destination_path)||diff.get(file.source_path)!==file.status)reject();
      seen.add(file.source_path);destinations.add(file.destination_path);
      const a=await entry(w.path,head,file.source_path),b=await entry(destination,evidence.destination.commit_sha,file.destination_path),current=await entry(destination,permanent.oid,file.destination_path);
      if(file.status==='D'){
        if(file.source_blob!==null||file.destination_blob!==null||a||b||current)reject();
      }else if(!a||!b||!current||!sha(file.source_blob)||file.source_blob!==a.blob||file.destination_blob!==b.blob||a.blob!==b.blob||a.mode!==b.mode||b.blob!==current.blob||b.mode!==current.mode)reject();
      files.push({...file,source_mode:a?.mode??null,destination_mode:b?.mode??null});
    }
    if(await source('rev-parse','HEAD')!==head||await source('status','--porcelain=v1','--untracked-files=all')||await dest('rev-parse',permanent.ref+'^{commit}')!==permanent.oid)reject();
    return {destination:{...evidence.destination,ref:permanent.ref,ref_oid:permanent.oid},source_head:head,source_base:evidence.source_base,files};
  }catch(error){if(error instanceof Fault&&error.code==='TRANSFER_UNVERIFIED')throw error;throw new Fault('TRANSFER_UNVERIFIED');}
}
