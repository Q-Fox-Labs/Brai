// ABOUTME: Сохраняет метаданные завершённых native вызовов для повторной доставки.
// ABOUTME: Не хранит содержимое входа или вывода и не удостоверяет источник события.
import {createHash,randomUUID} from 'node:crypto';
import {constants as C,openSync,closeSync,writeFileSync,readFileSync,fsyncSync,fstatSync,lstatSync,realpathSync,readdirSync,linkSync,unlinkSync} from 'node:fs';
import path from 'node:path';
const MAX_BYTES=16*1024,MAX_FILES=4096;
const sort=value=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])])):value;
/** Хеширует JSON без изменения порядка ключей, как прежний hook. */
export const rawHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Хеширует JSON с рекурсивно упорядоченными ключами. */
export const canonicalHash=value=>rawHash(sort(value));
function ensureNotice(notice) {
  const keys=['canonical_input_sha256','input_sha256','outcome','project_id','session_id','tool_name','tool_use_id','turn_id'];
  if(!notice || Object.keys(notice).sort().join(',')!=='executor_id,request,version' || notice.version!==1 || !/^[a-z][a-z0-9_]{0,63}$/.test(notice.executor_id??''))throw Error('NOTICE_INVALID');
  const r=notice.request;
  if(!r || typeof r!=='object' || Array.isArray(r) || Object.keys(r).sort().join(',')!==keys.join(',') || !['success','error'].includes(r.outcome) || !/^[a-f0-9]{64}$/.test(r.input_sha256??'') || !/^[a-f0-9]{64}$/.test(r.canonical_input_sha256??''))throw Error('NOTICE_INVALID');
  for(const name of ['project_id','session_id','turn_id','tool_use_id','tool_name'])if(typeof r[name]!=='string'||!r[name]||r[name].length>255||/[\x00-\x1f]/.test(r[name]))throw Error('NOTICE_INVALID');
  const bytes=Buffer.from(JSON.stringify({version:1,executor_id:notice.executor_id,request:Object.fromEntries(keys.map(k=>[k,r[k]]))})+'\n');
  if(bytes.length>MAX_BYTES)throw Error('NOTICE_TOO_LARGE');
  return bytes;
}
function noticeId(n){const r=n.request;return canonicalHash([r.project_id,n.executor_id,r.session_id,r.turn_id,r.tool_use_id]);}
/** Проверяет защищённый существующий каталог; не создаёт его. */
export function validateSpool(dir) {
  if(typeof dir!=='string'||!path.isAbsolute(dir)||path.normalize(dir)!==dir||realpathSync(dir)!==dir)throw Error('NOTICE_SPOOL_INVALID');
  const st=lstatSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||(st.mode&0o700)!==0o700||(typeof process.getuid==='function'&&st.uid!==process.getuid()))throw Error('NOTICE_SPOOL_INVALID');
}
function syncDir(dir){const fd=openSync(dir,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function readEntry(dir,id){
  if(!/^[a-f0-9]{64}$/.test(id))throw Error('NOTICE_INVALID');
  const target=path.join(dir,id+'.json');const fd=openSync(target,C.O_RDONLY|C.O_NOFOLLOW);try{
    const st=fstatSync(fd),current=lstatSync(target);if(st.dev!==current.dev||st.ino!==current.ino||current.isSymbolicLink())throw Error('NOTICE_INVALID');const own=typeof process.getuid!=='function'||st.uid===process.getuid();
    if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o777)!==0o600||!own||st.size>MAX_BYTES)throw Error('NOTICE_INVALID');
    const bytes=readFileSync(fd);if(bytes.length!==st.size||bytes.length>MAX_BYTES)throw Error('NOTICE_INVALID');
    const notice=JSON.parse(bytes.toString('utf8'));const canonical=ensureNotice(notice);
    if(!bytes.equals(canonical)||noticeId(notice)!==id)throw Error('NOTICE_INVALID');
    return {notice,bytes,dev:st.dev,ino:st.ino};
  }finally{closeSync(fd);}
}
/** Сначала синхронизирует файл и каталог; не заменяет существующую запись. */
export function saveNotice(dir,notice){
  validateSpool(dir);const bytes=ensureNotice(notice),id=noticeId(notice),target=path.join(dir,id+'.json');
  if(readdirSync(dir).length>=MAX_FILES){try{const old=readEntry(dir,id);if(old.bytes.equals(bytes))return {id};throw Error('WRITE_CALL_MISMATCH');}catch(error){if(error.code==='ENOENT')throw Error('NOTICE_SPOOL_FULL');throw error;}}
  const temp=path.join(dir,'.'+randomUUID()+'.tmp');let created=false;
  try{
    const fd=openSync(temp,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);created=true;
    try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
    try{linkSync(temp,target);}catch(error){if(error.code!=='EEXIST')throw error;const old=readEntry(dir,id);if(!old.bytes.equals(bytes))throw Error('WRITE_CALL_MISMATCH');}
    syncDir(dir);unlinkSync(temp);created=false;syncDir(dir);return {id};
  }finally{if(created)try{unlinkSync(temp);syncDir(dir);}catch{}}
}
/** Сканирует ограниченный журнал; испорченная запись не блокирует соседние. */
export function scanNotices(dir){
  validateSpool(dir);const names=readdirSync(dir);if(names.length>MAX_FILES)throw Error('NOTICE_SPOOL_FULL');const out=[];
  for(const name of names.sort()){
    const match=name.match(/^([a-f0-9]{64})\.json$/);
    if(!match){if(/^\.[a-f0-9-]+\.tmp$/.test(name))continue;out.push({id:null,error:'NOTICE_INVALID'});continue;}
    try{out.push({id:match[1],notice:readEntry(dir,match[1]).notice});}
    catch{out.push({id:match[1],error:'NOTICE_INVALID'});}
  }
  return out;
}
/** Возвращает ограниченную порцию записей конкретного проекта до лимита. */
export function listNotices(dir,{projectId,limit=32}={}){
  if(typeof projectId!=='string'||!projectId||!Number.isInteger(limit)||limit<1||limit>MAX_FILES)throw Error('NOTICE_INVALID');
  const entries=scanNotices(dir);if(entries.some(entry=>entry.error))throw Error('NOTICE_INVALID');
  return entries.filter(entry=>entry.notice.request.project_id===projectId).slice(0,limit);
}
/** Удаляет только прежнюю запись после durable подтверждения получателя. */
export function ackNotice(dir,id,notice){
  validateSpool(dir);const expected=ensureNotice(notice);let entry;
  try{entry=readEntry(dir,id);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(!entry.bytes.equals(expected))throw Error('WRITE_CALL_MISMATCH');
  const target=path.join(dir,id+'.json'),current=lstatSync(target);
  if(current.dev!==entry.dev||current.ino!==entry.ino||current.isSymbolicLink())throw Error('WRITE_CALL_MISMATCH');
  unlinkSync(target);syncDir(dir);
}
