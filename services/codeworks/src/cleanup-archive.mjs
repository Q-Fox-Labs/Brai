// ABOUTME: Проверяет закрытый Git bundle перед очисткой исторической области.
// ABOUTME: Не принимает решения о задаче и не изменяет исходный архив или Git refs.
import {realpath,lstat,rm,readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {command} from './git.mjs';
import {executionContext} from './execution-context.mjs';
import {createCleanupArchiveDirectory,probeOperatorArchiveAccess} from './operator-command.mjs';

/** Разделяет отказ доказательства и временный сбой; отмена и потеря допуска не становятся решением оператора. */
export function classifyCleanupArchiveError(error){
  if(executionContext()?.signal?.aborted||['AbortError','CancelledFailure','CanceledError'].includes(error?.name)||['ABORT_ERR','CLEANUP_FENCE_LOST','BRANCH_LIVE_TASK','EXECUTION_CONNECTION_LOST'].includes(error?.code??error?.message))return 'propagate';
  if(['ARCHIVE_UNVERIFIED','ARCHIVE_ACCESS_FORBIDDEN','ENOENT','ENOTDIR','ELOOP'].includes(error?.code)||error?.message==='ARCHIVE_UNVERIFIED')return 'decision';
  if(['EIO','EMFILE','ENFILE','ENOSPC','ENOMEM','EAGAIN','EBUSY','ETIMEDOUT','ECONNRESET','GIT_FAILED'].includes(error?.code))return 'retry';
  return 'propagate';
}

const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':(()=>{throw Error('ARCHIVE_UNVERIFIED');})();
/** Повторно восстанавливает standalone bundle в пустой bare repo и проверяет каждую закреплённую голову. */
export async function verifyCleanupArchive(project,expected,archive,{manifest,run=command}={}){
  const invalid=()=>{throw Error('ARCHIVE_UNVERIFIED');};
  const git=async args=>{
    const result=await run('git',args,{allowFailure:true});
    // AIDEV-NOTE: Отрицательная проверка bundle отличается от оборванного Git или отказа чтения носителя.
    const code=result.code===null?'ETIMEDOUT':/Input\/output error/i.test(result.stderr??'')?'EIO':/Too many open files/i.test(result.stderr??'')?'EMFILE':/No space left on device/i.test(result.stderr??'')?'ENOSPC':null;
    if(code)throw Object.assign(Error('ARCHIVE_CHECK_UNAVAILABLE'),{code});
    return result;
  };
  if(!archive||typeof archive.path!=='string'||!path.isAbsolute(archive.path)||path.normalize(archive.path)!==archive.path||!/^[0-9a-f]{64}$/.test(archive.sha256??'')||!Array.isArray(archive.heads)||!archive.heads.length||!Number.isInteger(project.cleanup_archive_uid)||!Array.isArray(project.cleanup_archive_roots))invalid();
  if(!manifest||manifest.reviewed!==true||manifest.disposition?.type!=='archived'||typeof archive.authorization_ref!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(archive.authorization_ref)||canonical(manifest.disposition.archive)!==canonical(archive)||!archive.receipt||typeof archive.receipt.path!=='string'||!path.isAbsolute(archive.receipt.path)||path.normalize(archive.receipt.path)!==archive.receipt.path||!/^[0-9a-f]{64}$/.test(archive.receipt.sha256??''))invalid();
  const root=path.dirname(archive.path);if(!project.cleanup_archive_roots.includes(root)||await realpath(root)!==root||await realpath(archive.path)!==archive.path)invalid();
  const directory=await lstat(root),file=await lstat(archive.path);
  if(!directory.isDirectory()||directory.isSymbolicLink()||!file.isFile()||file.isSymbolicLink()||directory.uid!==project.cleanup_archive_uid||file.uid!==project.cleanup_archive_uid||(directory.mode&0o022)||(file.mode&0o022))invalid();
  if(path.dirname(archive.receipt.path)!==root||await realpath(archive.receipt.path)!==archive.receipt.path)invalid();
  const receiptStat=await lstat(archive.receipt.path);if(!receiptStat.isFile()||receiptStat.isSymbolicLink()||receiptStat.uid!==project.cleanup_archive_uid||(receiptStat.mode&0o022))invalid();
  const receiptBytes=await readFile(archive.receipt.path);if(hash(receiptBytes)!==archive.receipt.sha256)invalid();
  let receipt;try{receipt=JSON.parse(receiptBytes);}catch{invalid();}
  const source={...manifest,disposition:{...manifest.disposition}};delete source.manifest_sha256;delete source.disposition.archive;
  if(receipt.authorization_ref!==archive.authorization_ref||receipt.source_manifest_sha256!==hash(canonical(source))||canonical(receipt.bundle)!==canonical({path:archive.path,sha256:archive.sha256,heads:archive.heads}))invalid();
  const sorted=archive.heads.map(h=>{if(!h||typeof h.ref!=='string'||!/^refs\/(?:heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(h.ref)||!/^[0-9a-f]{40}$/.test(h.oid??''))invalid();return h.oid+' '+h.ref;}).sort();
  if(new Set(sorted).size!==sorted.length||new Set(archive.heads.map(h=>h.ref)).size!==archive.heads.length)invalid();
  const pinned=[expected?.branch?.oid,expected?.remote?.oid,expected?.tracking?.oid,expected?.worktree?.head].filter(Boolean);
  if(!pinned.length||pinned.some(oid=>!archive.heads.some(h=>h.oid===oid)))invalid();
  const digest=async()=>{const h=createHash('sha256');for await(const chunk of createReadStream(archive.path))h.update(chunk);return h.digest('hex');};
  if(await digest()!==archive.sha256)invalid();
  await probeOperatorArchiveAccess(archive.path);
  const result=await git(['bundle','list-heads',archive.path]);
  if(result.code!==0||JSON.stringify(result.stdout.split('\n').filter(Boolean).sort())!==JSON.stringify(sorted))invalid();
  const temporary=await createCleanupArchiveDirectory();
  try{
    const bare=path.join(temporary,'bare');if((await git(['init','--bare',bare])).code!==0)throw Object.assign(Error('ARCHIVE_CHECK_UNAVAILABLE'),{code:'GIT_FAILED'});
    const verify=await git(['-C',bare,'bundle','verify',archive.path]);if(verify.code!==0)invalid();
    for(const [i,head] of archive.heads.entries()){
      const fetched=await git(['-C',bare,'fetch','--no-tags','--no-write-fetch-head',archive.path,head.ref+':refs/verify/'+i]);if(fetched.code!==0)invalid();
      const checked=await git(['-C',bare,'rev-parse','--verify','refs/verify/'+i+'^{commit}']);if(checked.code!==0||checked.stdout!==head.oid)invalid();
    }
    if((await git(['-C',bare,'fsck','--strict','--no-reflogs'])).code!==0||await digest()!==archive.sha256)invalid();
    const receiptAfter=await lstat(archive.receipt.path);if(receiptAfter.dev!==receiptStat.dev||receiptAfter.ino!==receiptStat.ino||receiptAfter.size!==receiptStat.size||receiptAfter.mtimeMs!==receiptStat.mtimeMs||receiptAfter.uid!==receiptStat.uid||(receiptAfter.mode&0o022)||hash(await readFile(archive.receipt.path))!==archive.receipt.sha256)invalid();
    const after=await lstat(archive.path);if(after.dev!==file.dev||after.ino!==file.ino||after.size!==file.size||after.mtimeMs!==file.mtimeMs||after.uid!==file.uid||(after.mode&0o022))invalid();
    return {sha256:archive.sha256,heads:archive.heads};
  }finally{await rm(temporary,{recursive:true,force:true});}
}
