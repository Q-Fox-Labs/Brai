// ABOUTME: Проверяет закрытый Git bundle перед очисткой исторической области.
// ABOUTME: Не принимает решения о задаче и не изменяет исходный архив или Git refs.
import {realpath,lstat,mkdtemp,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {command} from './git.mjs';

/** Повторно восстанавливает standalone bundle в пустой bare repo и проверяет каждую закреплённую голову. */
export async function verifyCleanupArchive(project,expected,archive){
  const invalid=()=>{throw Error('ARCHIVE_UNVERIFIED');};
  if(!archive||typeof archive.path!=='string'||!path.isAbsolute(archive.path)||path.normalize(archive.path)!==archive.path||!/^[0-9a-f]{64}$/.test(archive.sha256??'')||!Array.isArray(archive.heads)||!archive.heads.length||!Number.isInteger(project.cleanup_archive_uid)||!Array.isArray(project.cleanup_archive_roots))invalid();
  const root=path.dirname(archive.path);if(!project.cleanup_archive_roots.includes(root)||await realpath(root)!==root||await realpath(archive.path)!==archive.path)invalid();
  const directory=await lstat(root),file=await lstat(archive.path);
  if(!directory.isDirectory()||directory.isSymbolicLink()||!file.isFile()||file.isSymbolicLink()||directory.uid!==project.cleanup_archive_uid||file.uid!==project.cleanup_archive_uid||(directory.mode&0o022)||(file.mode&0o022))invalid();
  const sorted=archive.heads.map(h=>{if(!h||typeof h.ref!=='string'||!/^refs\/(?:heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(h.ref)||!/^[0-9a-f]{40}$/.test(h.oid??''))invalid();return h.oid+' '+h.ref;}).sort();
  if(new Set(sorted).size!==sorted.length||new Set(archive.heads.map(h=>h.ref)).size!==archive.heads.length)invalid();
  const pinned=[expected?.branch?.oid,expected?.remote?.oid,expected?.tracking?.oid,expected?.worktree?.head].filter(Boolean);
  if(!pinned.length||pinned.some(oid=>!archive.heads.some(h=>h.oid===oid)))invalid();
  const digest=async()=>{const h=createHash('sha256');for await(const chunk of createReadStream(archive.path))h.update(chunk);return h.digest('hex');};
  if(await digest()!==archive.sha256)invalid();
  const result=await command('git',['bundle','list-heads',archive.path],{allowFailure:true});
  if(result.code!==0||JSON.stringify(result.stdout.split('\n').filter(Boolean).sort())!==JSON.stringify(sorted))invalid();
  const temporary=await mkdtemp(path.join(tmpdir(),'codeworks-archive-verify-'));
  try{
    const bare=path.join(temporary,'bare');await command('git',['init','--bare',bare]);
    const verify=await command('git',['-C',bare,'bundle','verify',archive.path],{allowFailure:true});if(verify.code!==0)invalid();
    for(const [i,head] of archive.heads.entries()){
      const fetched=await command('git',['-C',bare,'fetch','--no-tags','--no-write-fetch-head',archive.path,head.ref+':refs/verify/'+i],{allowFailure:true});if(fetched.code!==0)invalid();
      const checked=await command('git',['-C',bare,'rev-parse','--verify','refs/verify/'+i+'^{commit}'],{allowFailure:true});if(checked.code!==0||checked.stdout!==head.oid)invalid();
    }
    if((await command('git',['-C',bare,'fsck','--strict','--no-reflogs'],{allowFailure:true})).code!==0||await digest()!==archive.sha256)invalid();
    const after=await lstat(archive.path);if(after.dev!==file.dev||after.ino!==file.ino||after.size!==file.size||after.mtimeMs!==file.mtimeMs||after.uid!==file.uid||(after.mode&0o022))invalid();
    return {sha256:archive.sha256,heads:archive.heads};
  }finally{await rm(temporary,{recursive:true,force:true});}
}
