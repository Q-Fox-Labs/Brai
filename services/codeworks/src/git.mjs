// ABOUTME: Создаёт и проверяет только доказанно принадлежащие Codeworks Git worktree.
// ABOUTME: Не присваивает существующие ветки/пути, не удаляет файлы и не устанавливает пакеты.
import { spawn } from 'node:child_process';
import { lstat, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Fault } from './errors.mjs';
const relative=value=>value==='.'||(!path.isAbsolute(value)&&!value.split('/').some(p=>!p||p==='.'||p==='..')&&!value.includes('\\'));
async function exists(file) { try { return await lstat(file); } catch(error) { if(error.code==='ENOENT') return null; throw error; } }
/** Запускает фиксированный executable без shell; наследует flock FD только в worker. */
export async function command(executable,args,{cwd,allowFailure=false,timeout=120000,input}={}) {
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',overflow=false;
    const inherited=process.env.CODEWORKS_LOCK_HELD==='1';
    const child=spawn(executable,args,{cwd,env:{...process.env,GIT_TERMINAL_PROMPT:'0'},stdio:inherited?[input===undefined?'ignore':'pipe','pipe','pipe',3]:[input===undefined?'ignore':'pipe','pipe','pipe']});
    if(input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(input);}
    const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
    const killTimer=setTimeout(()=>child.kill('SIGKILL'),timeout+5000);
    child.stdout.on('data',chunk=>{if(overflow)return;stdout+=chunk; if(Buffer.byteLength(stdout)>1048576){overflow=true;child.kill('SIGTERM');}});
    child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk;});
    child.once('error',()=>{clearTimeout(timer);clearTimeout(killTimer);reject(new Fault('GIT_FAILED','External command could not start.'));});
    child.once('close',code=>{clearTimeout(timer);clearTimeout(killTimer); if(overflow||(!allowFailure&&code!==0))reject(new Fault('GIT_FAILED','Git operation failed; owned resources and intent were preserved.'));else resolve({code,stdout:stdout.trim(),stderr});});
  });
}
/** Адаптер Git/preparer; изменение вызывается только worker под проектным flock. */
export function createGit() {
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
  return {
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
    async readBase(project,kind) { await topology(project); return (await git(project,['rev-parse','--verify',project.git_flow[kind+'_base']+'^{commit}'])).stdout; },
    /** Проверяет ветку, worktree registration и ownership; никогда не принимает стороннюю область. */
    async inspect(project,w) {
      await topology(project);
      const head=await branches(project,w);
      if(!head||!await registration(project,w))throw new Fault('OWNERSHIP_CONFLICT');
      if((await local(w,['symbolic-ref','--short','HEAD'])).stdout!==w.branch)throw new Fault('OWNERSHIP_CONFLICT');
      return {head:(await local(w,['rev-parse','HEAD'])).stdout,branch:w.branch,dirty:!!(await local(w,['status','--porcelain=v1','--untracked-files=all'])).stdout};
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
    /** Возобновляет только свой checkout, заполняя отсутствующие файлы без перезаписи существующих. */
    async checkout(project,w) {
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
