// ABOUTME: Создаёт и проверяет только доказанно принадлежащие Codeworks Git worktree.
// ABOUTME: Не присваивает существующие ветки/пути, сохраняет чужие и dirty области и не устанавливает пакеты.
import { spawn } from 'node:child_process';
import { lstat, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { Fault } from './errors.mjs';
import {executionContext} from './execution-context.mjs';
const relative=value=>value==='.'||(!path.isAbsolute(value)&&!value.split('/').some(p=>!p||p==='.'||p==='..')&&!value.includes('\\'));
async function exists(file) { try { return await lstat(file); } catch(error) { if(error.code==='ENOENT') return null; throw error; } }
/** Запускает фиксированный executable без shell; наследует flock FD только в локальном Git helper или legacy worker. */
export async function command(executable,args,{cwd,allowFailure=false,timeout=120000,input,env={}}={}) {
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',overflow=false,abortKill;
    const signal=executionContext()?.signal;signal?.throwIfAborted();
    const inherited=process.env.CODEWORKS_LOCK_HELD==='1';
    const child=spawn(executable,args,{cwd,env:{...process.env,...env,GIT_TERMINAL_PROMPT:'0'},stdio:inherited?[input===undefined?'ignore':'pipe','pipe','pipe',3]:[input===undefined?'ignore':'pipe','pipe','pipe']});
    if(input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(input);}
    const abort=()=>{child.kill('SIGTERM');abortKill=setTimeout(()=>child.kill('SIGKILL'),5000);};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    const dispose=()=>{if(abortKill)clearTimeout(abortKill);signal?.removeEventListener('abort',abort);};
    const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
    const killTimer=setTimeout(()=>child.kill('SIGKILL'),timeout+5000);
    child.stdout.on('data',chunk=>{if(overflow)return;stdout+=chunk; if(Buffer.byteLength(stdout)>1048576){overflow=true;child.kill('SIGTERM');}});
    child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk;});
    child.once('error',()=>{dispose();clearTimeout(timer);clearTimeout(killTimer);reject(new Fault('GIT_FAILED','External command could not start.'));});
    child.once('close',code=>{dispose();clearTimeout(timer);clearTimeout(killTimer); if(signal?.aborted)reject(signal.reason);else if(overflow||(!allowFailure&&code!==0))reject(new Fault('GIT_FAILED','Git operation failed; owned resources and intent were preserved.'));else resolve({code,stdout:stdout.trim(),stderr});});
  });
}
/** Подтверждает отсутствие всех проверенных Git ресурсов. */
export function gitResourcesAbsent(o) {
  return o?.remote?.known===true && !o.branch.oid && !o.ownership.oid && !o.remote.oid && !o.tracking?.oid && !o.worktree.registered && !o.worktree.pathExists;
}
/** Адаптер Git/preparer; локальные мутации требуют унаследованный flock FD 3. */
export function createGit({flowGit}={}) {
  const git=(project,args,options={})=>command('git',['-C',project.repo_path,...args],options);
  const local=(w,args,options={})=>command('git',['-C',w.path,...args],options);
  function requireLock() { if(process.env.CODEWORKS_LOCK_HELD!=='1')throw new Fault('INTERNAL','Git mutation requires the project lock.'); }
  async function topology(project) {
    if(await realpath(project.repo_path)!==project.repo_path||await realpath(project.workspace_root)!==project.workspace_root)throw new Fault('OWNERSHIP_CONFLICT');
    const top=(await git(project,['rev-parse','--show-toplevel'])).stdout;
    const common=(await git(project,['rev-parse','--path-format=absolute','--git-common-dir'])).stdout;
    if(top!==project.repo_path||common!==project.common_dir||await realpath(common)!==common)throw new Fault('OWNERSHIP_CONFLICT');
  }
  const ownershipRef=w=>'refs/codeworks/ownership/'+w.id;
  const ownership=w=>JSON.stringify({workspace_id:w.id,token:w.ownership_token,branch:w.branch,base_sha:w.base_sha,path:w.path});
  async function branches(project,w) {
    const result=await git(project,['show-ref','--verify','--quiet','refs/heads/'+w.branch],{allowFailure:true});
    const proof=await git(project,['show-ref','--verify','--quiet',ownershipRef(w)],{allowFailure:true});
    if(result.code===1&&proof.code===1)return null;
    if(result.code!==0||proof.code!==0)throw new Fault('OWNERSHIP_CONFLICT','Existing branch has no matching Codeworks ownership proof.');
    const marker=await git(project,['cat-file','blob',ownershipRef(w)],{allowFailure:true});
    if(marker.code!==0||marker.stdout!==ownership(w))throw new Fault('OWNERSHIP_CONFLICT','Existing branch has no matching Codeworks ownership proof.');
    return (await git(project,['rev-parse','refs/heads/'+w.branch])).stdout;
  }
  async function registration(project,w) {
    const raw=(await git(project,['worktree','list','--porcelain','-z'])).stdout;
    const entries=raw.split('\0\0').map(block=>Object.fromEntries(block.split('\0').filter(Boolean).map(line=>{const i=line.indexOf(' ');return [line.slice(0,i),line.slice(i+1)];})));
    const byBranch=entries.filter(e=>e.branch==='refs/heads/'+w.branch);
    const byPath=entries.find(e=>e.worktree===w.path);
    if(byBranch.some(e=>e.worktree!==w.path))throw new Fault('OWNERSHIP_CONFLICT','Owned branch is attached to another directory.');
    if(!byPath)return null;
    if(byPath.branch!=='refs/heads/'+w.branch||byPath.locked!=='codeworks:'+w.ownership_token)throw new Fault('OWNERSHIP_CONFLICT','Existing worktree has no matching Codeworks ownership proof.');
    const stat=await exists(w.path);
    if(!stat?.isDirectory()||stat.isSymbolicLink()||await realpath(w.path)!==w.path)throw new Fault('OWNERSHIP_CONFLICT');
    const common=(await local(w,['rev-parse','--path-format=absolute','--git-common-dir'])).stdout;
    const top=(await local(w,['rev-parse','--show-toplevel'])).stdout;
    if(common!==project.common_dir||top!==w.path)throw new Fault('OWNERSHIP_CONFLICT');
    return byPath;
  }
  async function inspectResources(project,w,{manifest}={}) {
    await topology(project);
    const branchRef='refs/heads/'+w.branch, ownerRef=manifest?.ownership?.ref??ownershipRef(w);
    if(!/^refs\/codeworks\/ownership\/[A-Za-z0-9-]+$/.test(ownerRef))throw new Fault('OWNERSHIP_CONFLICT');
    const readRef=async ref=>{const r=await git(project,['rev-parse','--verify','--quiet',ref],{allowFailure:true});if(r.code===1)return null;if(r.code!==0)throw new Fault('GIT_FAILED');return r.stdout;};
    const branch=await readRef(branchRef),owner=await readRef(ownerRef),trackingRef='refs/remotes/origin/'+w.branch,tracking=await readRef(trackingRef);
    const marker=owner?(await git(project,['cat-file','blob',ownerRef])).stdout:null;
    const matches=!!marker&&marker===ownership(w);
    const raw=(await git(project,['worktree','list','--porcelain','-z'])).stdout;
    const entries=raw.split('\0\0').map(block=>Object.fromEntries(block.split('\0').filter(Boolean).map(line=>{const i=line.indexOf(' ');return [line.slice(0,i),line.slice(i+1)];})));
    if(entries.some(e=>e.branch===branchRef&&e.worktree!==w.path))throw new Fault('OWNERSHIP_CONFLICT');
    const entry=entries.find(e=>e.worktree===w.path),st=await exists(w.path);
    const pathExists=!!st,canonical=st?.isDirectory()&&!st.isSymbolicLink()&&await realpath(w.path)===w.path;
    const owned=!!entry&&entry.branch===branchRef&&entry.locked==='codeworks:'+w.ownership_token;
    let head=entry?.HEAD??null,dirty=null;
    if(entry&&canonical){head=(await local(w,['rev-parse','HEAD'])).stdout;dirty=!!(await local(w,['status','--porcelain=v1','--untracked-files=all'])).stdout;}
    const flow=project.github?(flowGit??(await import('./git-flow.mjs')).createFlowGit()):null;
    const remote=flow?await flow.remote(project,w.branch,{legacy:!!manifest}):null;
    return {tracking:{ref:trackingRef,oid:tracking},branch:{ref:branchRef,oid:branch},ownership:{ref:ownerRef,oid:owner,matches},remote:{ref:branchRef,oid:remote,known:true},worktree:{path:w.path,registered:!!entry,pathExists,head,dirty,owned,lock:entry?.locked??null}};
  }
  function authorize(project,w,expected,manifest) {
    if(!expected||expected.branch.ref!=='refs/heads/'+w.branch||expected.ownership.ref!==(manifest?.ownership?.ref??ownershipRef(w))||expected.remote.ref!==expected.branch.ref||expected.tracking?.ref!=='refs/remotes/origin/'+w.branch||expected.worktree.path!==w.path||!path.isAbsolute(w.path)||w.path===project.repo_path)throw new Fault('OWNERSHIP_CONFLICT');
    if(['dev','main'].includes(w.branch))throw new Fault('OWNERSHIP_CONFLICT');
    if(manifest){
      if(!(project.legacy_workspace_roots??[]).some(root=>path.isAbsolute(root)&&path.dirname(w.path)===root)||manifest.manifestVersion!==1||manifest.reviewed!==true||manifest.project_id!==project.id||manifest.common_dir!==project.common_dir||manifest.workspace_id!==w.id||manifest.branch?.ref!==expected.branch.ref||manifest.branch?.oid!==expected.branch.oid||manifest.ownership?.ref!==expected.ownership.ref||manifest.ownership?.oid!==expected.ownership.oid||manifest.remote?.ref!==expected.remote.ref||manifest.remote?.oid!==expected.remote.oid||(expected.tracking.oid!==null&&(manifest.tracking?.ref!==expected.tracking.ref||manifest.tracking?.oid!==expected.tracking.oid))||manifest.worktree?.path!==w.path||manifest.worktree?.registered!==expected.worktree.registered||manifest.worktree?.lock!==expected.worktree.lock||manifest.worktree?.head!==expected.worktree.head||!Array.isArray(manifest.provenance)||!manifest.provenance.length||!manifest.disposition||!/^[0-9a-f]{64}$/.test(manifest.manifest_sha256))throw new Fault('OWNERSHIP_CONFLICT');
    }else if(!w.path.startsWith(project.workspace_root+'/')||!expected.ownership.matches&&(expected.branch.oid||expected.ownership.oid))throw new Fault('OWNERSHIP_CONFLICT');
  }
  async function cleanupStep(project,w,expected,step,{manifest}={}) {
    if(!['remote','worktree','local_refs'].includes(step))throw new Fault('INVALID_ARGUMENT');
    if(step!=='remote')requireLock();
    authorize(project,w,expected,manifest);
    const current=await inspectResources(project,w,{manifest});
    for(const field of ['branch','ownership','remote','tracking'])if(current[field].oid!==null&&current[field].oid!==expected[field].oid)throw new Fault('TARGET_CHANGED');
    if(current.worktree.registered&&(!expected.worktree.registered||current.worktree.lock!==expected.worktree.lock||current.worktree.head!==expected.worktree.head))throw new Fault('TARGET_CHANGED');
    if(current.worktree.pathExists&&!expected.worktree.pathExists)throw new Fault('TARGET_CHANGED');
    if(current.ownership.oid&&!manifest&&!current.ownership.matches)throw new Fault('OWNERSHIP_CONFLICT');
    if(manifest?.ownership?.payload_hash&&current.ownership.oid){const payload=(await git(project,['cat-file','blob',current.ownership.ref])).stdout;if(createHash('sha256').update(payload).digest('hex')!==manifest.ownership.payload_hash)throw new Fault('OWNERSHIP_CONFLICT');}
    let changed=false;
    if(step==='remote'&&current.remote.oid){const flow=flowGit??(await import('./git-flow.mjs')).createFlowGit({requireLock:()=>{}});await flow.removeBranch(project,w.branch,current.remote.oid,{legacy:!!manifest});changed=true;}
    if(step==='worktree'&&current.worktree.registered){
      if(!manifest&&!current.worktree.owned)throw new Fault('OWNERSHIP_CONFLICT');
      if(current.worktree.pathExists&&(current.worktree.dirty!==false||!current.worktree.owned))throw new Fault('OWNERSHIP_CONFLICT');
      if(current.worktree.lock)await git(project,['worktree','unlock',w.path]);
      await git(project,['worktree','remove',...(current.worktree.pathExists?[]:['--force']),w.path]);changed=true;
    } else if(step==='worktree'&&current.worktree.pathExists)throw new Fault('OWNERSHIP_CONFLICT');
    if(step==='local_refs'){
      if(current.worktree.registered||current.worktree.pathExists||current.remote.oid)throw new Fault('OWNERSHIP_CONFLICT');
      const tracking='refs/remotes/origin/'+w.branch;const trackingResult=await git(project,['rev-parse','--verify','--quiet',tracking],{allowFailure:true});
      if(![0,1].includes(trackingResult.code))throw new Fault('GIT_FAILED');
      if(trackingResult.code===0&&trackingResult.stdout!==expected.tracking.oid)throw new Fault('TARGET_CHANGED');
      const lines=[];if(trackingResult.code===0)lines.push('delete '+tracking+' '+trackingResult.stdout);if(current.branch.oid)lines.push('delete '+current.branch.ref+' '+current.branch.oid);if(current.ownership.oid)lines.push('delete '+current.ownership.ref+' '+current.ownership.oid);
      if(lines.length){await git(project,['update-ref','--stdin'],{input:'start\n'+lines.join('\n')+'\nprepare\ncommit\n'});changed=true;}
    }
    return {step,outcome:changed?'removed':'already_absent',observation:await inspectResources(project,w,{manifest})};
  }
  return {
    inspectResources, cleanupStep,
    /** Проверяет канонические каталоги и политику без изменения Git. */
    async validateProject(project) {
      await topology(project);
      if(project.workspace_root===project.repo_path||project.workspace_root.startsWith(project.common_dir+'/'))throw new Fault('INVALID_ARGUMENT');
      if(!project.allowed_paths.every(relative)||!project.excluded_paths.every(relative))throw new Fault('INVALID_ARGUMENT','Policy paths must be normalized repository-relative prefixes.');
      for(const prefix of project.documentation_paths??[]) {
        if(prefix==='.'||!relative(prefix)||!project.allowed_paths.some(p=>p==='.'||prefix===p||prefix.startsWith(p+'/'))||project.excluded_paths.some(p=>prefix===p||prefix.startsWith(p+'/')))throw new Fault('INVALID_ARGUMENT');
        const absolute=path.join(project.repo_path,prefix);
        if(await realpath(absolute)!==absolute||(await lstat(absolute)).isSymbolicLink())throw new Fault('INVALID_ARGUMENT');
      }
      if(!path.isAbsolute(project.preparer_path)||!(await lstat(project.preparer_path)).isFile())throw new Fault('INVALID_ARGUMENT');
      if(project.node_version!==process.version.slice(1)||project.platform!==process.platform+'-'+process.arch)throw new Fault('DEPENDENCIES_INCOMPATIBLE','Node version or platform differs from the registered project.');
    },
    /** Закрепляет существующий remote ref; не выполняет fetch и не переходит на другую базу. */
    async readBase(project,kind) {
      await topology(project);
      const ref=project.git_flow[kind+'_base'];
      const base=(await git(project,['rev-parse','--verify',ref+'^{commit}'])).stdout;
      if(project.github){
        const {createFlowGit}=await import('./git-flow.mjs');
        if(await (flowGit??createFlowGit()).remote(project,kind==='hotfix'?'main':'dev')!==base)throw new Fault('TARGET_CHANGED','Refresh origin refs before preparing a workspace.');
      }
      return base;
    },
    /** Проверяет ветку, worktree registration и ownership; никогда не принимает стороннюю область. */
    async inspect(project,w) {
      await topology(project);
      const head=await branches(project,w);
      if(!head||!await registration(project,w))throw new Fault('OWNERSHIP_CONFLICT');
      if((await local(w,['symbolic-ref','--short','HEAD'])).stdout!==w.branch)throw new Fault('OWNERSHIP_CONFLICT');
      return {head:(await local(w,['rev-parse','HEAD'])).stdout,branch:w.branch,dirty:!!(await local(w,['status','--porcelain=v1','--untracked-files=all'])).stdout};
    },
    /** Убирает clean own worktree и ветку выпуска; remote удаляет до потери локального ownership. */
    async cleanup(project,w,heads,acceptedHead,{remoteOnly=false,localOnly=false}={}) {
      if(!remoteOnly)requireLock();await topology(project);
      if(!heads.length||!w.path.startsWith(project.workspace_root+'/')||w.path===project.repo_path)return false;
      const head=await branches(project,w);
      const flow=project.github?(flowGit??(await import('./git-flow.mjs')).createFlowGit()):null;
      if(!head)return !await exists(w.path)&&(localOnly||!flow||await flow.remote(project,w.branch)===null);
      if(flow&&head!==acceptedHead)return false;
      for(const target of heads)if(!/^[0-9a-f]{40}$/.test(target)||(await git(project,['merge-base','--is-ancestor',head,target],{allowFailure:true})).code!==0)return false;
      const registered=await registration(project,w);
      if(registered){if((await this.inspect(project,w)).dirty)return false;}
      else if(await exists(w.path))return false;
      if(flow&&!localOnly)await flow.removeBranch(project,w.branch,acceptedHead);
      if(remoteOnly)return true;
      if(registered){
        await git(project,['worktree','unlock',w.path]);
        try{await git(project,['worktree','remove',w.path]);}catch(error){await git(project,['worktree','lock','--reason','codeworks:'+w.ownership_token,w.path],{allowFailure:true});throw error;}
      }
      const proof=(await git(project,['rev-parse',ownershipRef(w)])).stdout;
      await git(project,['update-ref','--stdin'],{input:'start\ndelete refs/heads/'+w.branch+' '+head+'\ndelete '+ownershipRef(w)+' '+proof+'\nprepare\ncommit\n'});
      return true;
    },
    /** Атомарно создаёт ветку и постоянный ownership ref; intent уже сохранён в БД. */
    async branch(project,w) {
      requireLock();await topology(project);
      const current=await branches(project,w);
      if(current){if(current!==w.base_sha)throw new Fault('OWNERSHIP_CONFLICT');return;}
      if(await exists(w.path))throw new Fault('OWNERSHIP_CONFLICT','Workspace path already exists without owned Git registration.');
      const blob=(await git(project,['hash-object','-w','--stdin'],{input:ownership(w)})).stdout;
      await git(project,['update-ref','--stdin'],{input:'start\ncreate '+ownershipRef(w)+' '+blob+'\ncreate refs/heads/'+w.branch+' '+w.base_sha+'\nprepare\ncommit\n'});
    },
    /** Создаёт или сверяет только свою регистрацию worktree под общим Git flock. */
    async registerCheckout(project,w) {
      requireLock(); await topology(project);
      if(await branches(project,w)!==w.base_sha)throw new Fault('OWNERSHIP_CONFLICT');
      const registered=await registration(project,w);
      if(!registered) {
        if(await exists(w.path))throw new Fault('OWNERSHIP_CONFLICT','Workspace path is occupied; nothing was changed.');
        // AIDEV-NOTE: no-checkout отделяет durable Git registration от заполнения файлов.
        // Подготовка обязательна ниже; no-checkout не даёт области права ready.
        await git(project,['worktree','add','--no-checkout','--lock','--reason','codeworks:'+w.ownership_token,w.path,w.branch]);
      }
      if(!await registration(project,w))throw new Fault('OWNERSHIP_CONFLICT');
    },
    /** Заполняет только индекс и файлы собственного дерева; общая регистрация уже завершена. */
    async checkout(project,w,{registered=false}={}) {
      requireLock();if(registered){await topology(project);if(!await registration(project,w))throw new Fault('OWNERSHIP_CONFLICT');}else await this.registerCheckout(project,w);
      const index=(await local(w,['rev-parse','--path-format=absolute','--git-path','index'])).stdout;
      if(!await exists(index))await local(w,['read-tree',w.base_sha]);
      const indexTree=(await local(w,['write-tree'])).stdout;
      if(indexTree!==(await git(project,['rev-parse',w.base_sha+'^{tree}'])).stdout)throw new Fault('OWNERSHIP_CONFLICT','Workspace index differs from the frozen base.');
      // Без --force Git сохраняет существующие файлы; последующая проверка отвергает чужие изменения.
      await local(w,['checkout-index','--all'],{allowFailure:true});
      if((await local(w,['status','--porcelain=v1','--untracked-files=all'])).stdout)throw new Fault('OWNERSHIP_CONFLICT','Incomplete workspace has edits; recovery preserved them.');
    },
    /** Использует только зарегистрированный подготовщик и затем его read-only --check. */
    async dependencies(project,w) {
      requireLock();await this.inspect(project,w);
      if(process.version.slice(1)!==project.node_version||process.platform+'-'+process.arch!==project.platform)throw new Fault('DEPENDENCIES_INCOMPATIBLE','Node/platform mismatch; no installation was attempted.');
      await Promise.all([readFile(path.join(project.repo_path,'package-lock.json')),readFile(path.join(w.path,'package-lock.json'))]).catch(()=>{throw new Fault('DEPENDENCIES_INCOMPATIBLE','MISSING_LOCKFILE; no installation was attempted.');});
      for(const args of [[w.path],['--check',w.path]]) {
        const result=await command(project.preparer_path,args,{allowFailure:true});
        if(result.code!==0) {
          const reason=result.stderr.match(/(?:UNPREPARED_WORKSPACE_DEPENDENCY|LOCKFILE_MISMATCH|NODE_VERSION_MISMATCH|NPM_VERSION_MISMATCH|MANIFEST_MISMATCH|PACKAGE_VERSION_MISMATCH|MISSING_PACKAGE|WORKSPACE_OUTSIDE_WORKTREE|UNMANAGED_[A-Z_]+|MISSING_OR_UNLOADABLE_NEXT_NATIVE_PACKAGE|MISSING_[A-Z_]+)/)?.[0]??'PREPARER_REJECTED';
          throw new Fault('DEPENDENCIES_INCOMPATIBLE',reason+'; dependencies were not installed.');
        }
      }
    },
  };
}
