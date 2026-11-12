// ABOUTME: Ограничивает Git и gh root-оператора фиксированным локальным OS-пользователем.
// ABOUTME: База и оператор остаются root; сервисные команды вне этого контекста не меняются.
import {AsyncLocalStorage} from 'node:async_hooks';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {executionContext} from './execution-context.mjs';
import {readFileSync,constants} from 'node:fs';
import {mkdtemp,open,lstat,realpath,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const context=new AsyncLocalStorage();
const executables={git:'/usr/bin/git',gh:'/usr/bin/gh'};
const cleanOperatorEnvironment=()=>({PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1'});
const fail=code=>{throw Error(code);};
function account(user){
  if(typeof user!=='string'||!/^[a-z_][a-z0-9_-]{0,31}$/.test(user))fail('OPERATOR_USER_INVALID');
  const row=readFileSync('/etc/passwd','utf8').split('\n').map(line=>line.split(':')).find(fields=>fields[0]===user);
  const uid=Number(row?.[2]),gid=Number(row?.[3]);
  if(!row||!Number.isSafeInteger(uid)||uid<=0||!Number.isSafeInteger(gid)||gid<0)fail('OPERATOR_USER_INVALID');
  return {user,uid,gid};
}
function requiredIdentity(){
  if(process.geteuid?.()!==0)fail('OWNER_REQUIRED');
  const identity=context.getStore()?.identity;
  if(!identity)fail('OPERATOR_USER_REQUIRED');
  return identity;
}

/** Включает политику только для настоящего root CLI; отсутствие USER запрещает последующий Git/gh.
 * Пользователь берётся из защищённой операторской конфигурации, а не из аргументов команды.
 */
export function withOperatorCommands(user,work){
  if(process.geteuid?.()!==0)fail('OWNER_REQUIRED');
  return context.run({identity:user===undefined?null:account(user)},work);
}

/** Сохраняет non-root legacy cleanup и completion import; новые команды и attest требуют root.
 * Root всегда получает scoped policy; ENV не заменяет проверку UID и не влияет на агентский legacy путь.
 */
export function runOperatorDispatch(method,work){
  if(process.geteuid?.()===0)return withOperatorCommands(process.env.CODEWORKS_OPERATOR_USER,work);
  if(!['cleanup-import','cleanup-preflight','write-completion-import'].includes(method))fail('OWNER_REQUIRED');
  return work();
}

/** Возвращает фиксированный runuser argv только для Git/gh внутри operator scope.
 * runuser устанавливает HOME и supplementary groups выбранного пользователя; shell не используется.
 * Для обычного сервиса и остальных root-адаптеров возвращает null.
 */
export function operatorCommandSpec(executable,args){
  if(!context.getStore())return null;
  const name=Object.keys(executables).find(key=>executable===key||executable===executables[key]);
  if(!name)return null;
  const identity=requiredIdentity();
  return {
    executable:'/usr/sbin/runuser',
    cwd:'/',
    args:['--user',identity.user,'--',executables[name],...args],
    env:cleanOperatorEnvironment(),
  };
}

/** Создаёт только временный каталог проверки архива; root передаёт свежий inode пользователю Git.
 * До fchown проверяет root UID, 0700, canonical path и совпадение dev/ino открытого дескриптора.
 * Не принимает путь от CLI и не меняет исходный архив, receipt или project directory.
 */
export async function createCleanupArchiveDirectory(){
  const identity=context.getStore()?requiredIdentity():null;
  const temporary=await mkdtemp(identity?'/tmp/codeworks-archive-verify-':path.join(tmpdir(),'codeworks-archive-verify-'));
  if(!identity)return temporary;
  let directory;
  try{
    directory=await open(temporary,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    const captured=await directory.stat(),current=await lstat(temporary);
    if(!captured.isDirectory()||captured.uid!==0||(captured.mode&0o777)!==0o700||!current.isDirectory()||current.isSymbolicLink()||current.uid!==0||current.dev!==captured.dev||current.ino!==captured.ino||await realpath(temporary)!==temporary)fail('OPERATOR_GIT_DIRECTORY_INVALID');
    await directory.chown(identity.uid,identity.gid);
    return temporary;
  }catch(error){await rmdir(temporary).catch(()=>{});throw error;}
  finally{await directory?.close();}
}

const archiveProbeSource="'use strict';\nconst fs=require('node:fs'),path=require('node:path');\nconst [file,nonce]=process.argv.slice(1),uid=process.geteuid();\nif(process.argv.length!==3||!path.isAbsolute(file)||path.normalize(file)!==file||!/^[0-9a-f]{32}$/.test(nonce)||uid<=0)process.exit(64);\nlet descriptor,result={version:1,nonce,uid,status:'readable',errno:null};\ntry{descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}\ncatch(error){result={version:1,nonce,uid,status:'error',errno:typeof error.code==='string'?error.code:'UNKNOWN'};}\nif(descriptor!==undefined)fs.closeSync(descriptor);\nprocess.stdout.write(JSON.stringify(result)+'\\n');";
const transientProbeErrors=new Set(['EIO','EMFILE','ENFILE','ENOSPC','ENOMEM','EAGAIN','EBUSY','ETIMEDOUT','ECONNRESET']);
const unavailableProbe=code=>Object.assign(Error('ARCHIVE_CHECK_UNAVAILABLE'),{code:transientProbeErrors.has(code)?code:'GIT_FAILED'});

/** Только этот статический child читает O_RDONLY|O_NOFOLLOW; wrapper exit code сам по себе не доказывает доступ. */
async function runFixedArchiveReadProbe(spec){
  const signal=executionContext()?.signal;signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(spec.executable,spec.args,{cwd:spec.cwd,env:spec.env,stdio:['ignore','pipe','pipe']});
    let stdout='',overflow=false,timedOut=false,killTimer;
    const stop=()=>{child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),2000);};
    const aborted=()=>stop(),timer=setTimeout(()=>{timedOut=true;stop();},5000);
    const dispose=()=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal?.removeEventListener('abort',aborted);};
    signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
    child.stdout.on('data',chunk=>{if(overflow)return;stdout+=chunk;if(Buffer.byteLength(stdout)>4096){overflow=true;stop();}});
    child.stderr.resume();
    child.once('error',error=>{dispose();reject(error);});
    child.once('close',code=>{
      dispose();
      if(signal?.aborted)reject(signal.reason);
      else if(timedOut)reject(unavailableProbe('ETIMEDOUT'));
      else if(overflow)reject(unavailableProbe());
      else resolve({code,stdout});
    });
  });
}

/** Проверяет чтение уже валидированного bundle выбранным UID; обычный worker не запускает root probe.
 * Только exit 0 и строгий child JSON с одноразовым nonce/ожидаемым UID подтверждают результат.
 * EACCES/EPERM child fs.open требуют решения; wrapper failures, отсутствующий JSON и прочие errno повторяются.
 */
export async function probeOperatorArchiveAccess(file,{runProbe=runFixedArchiveReadProbe}={}){
  if(!context.getStore())return;
  const identity=requiredIdentity();
  if(typeof file!=='string'||!path.isAbsolute(file)||path.normalize(file)!==file)fail('OPERATOR_COMMAND_INVALID');
  const nonce=randomBytes(16).toString('hex');
  const spec={executable:'/usr/sbin/runuser',args:['--user',identity.user,'--',process.execPath,'--input-type=commonjs','--eval',archiveProbeSource,file,nonce],cwd:'/',env:cleanOperatorEnvironment(),nonce,uid:identity.uid};
  let observed;
  try{observed=await runProbe(spec);}
  catch(error){
    executionContext()?.signal?.throwIfAborted();
    if(error?.name==='AbortError'||error?.name==='CancelledFailure')throw error;
    throw unavailableProbe(error?.code);
  }
  executionContext()?.signal?.throwIfAborted();
  if(observed?.code!==0)throw unavailableProbe(observed?.code===null?'ETIMEDOUT':undefined);
  let result;try{result=JSON.parse(observed.stdout);}catch{throw unavailableProbe();}
  if(!result||Array.isArray(result)||Object.keys(result).sort().join(',')!=='errno,nonce,status,uid,version'||result.version!==1||result.nonce!==nonce||result.uid!==identity.uid||!['readable','error'].includes(result.status)||(result.status==='readable'?result.errno!==null:typeof result.errno!=='string'||!/^E[A-Z0-9_]{1,31}$/.test(result.errno)))throw unavailableProbe();
  if(result.status==='readable')return;
  if(['EACCES','EPERM'].includes(result.errno))throw Object.assign(Error('ARCHIVE_ACCESS_FORBIDDEN'),{code:'ARCHIVE_ACCESS_FORBIDDEN'});
  throw unavailableProbe(result.errno);
}
