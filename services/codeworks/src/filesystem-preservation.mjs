// ABOUTME: Подтверждает сохранность игнорируемых файлов перед удалением рабочей области.
// ABOUTME: Не читает содержимое root-only архива и не изменяет исходные данные.
import {open,lstat,realpath,readlink,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {Fault} from './errors.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const validRelative=value=>typeof value==='string'&&value.length>0&&!path.isAbsolute(value)&&!value.split('/').some(x=>!x||x==='.'||x==='..')&&!value.includes('\\');
const stamp=st=>[st.dev,st.ino,st.mode,st.size,st.mtimeNs,st.ctimeNs].map(String).join(':');
const child=(fd,name)=>Buffer.concat([Buffer.from('/proc/self/fd/'+fd+'/'),Buffer.isBuffer(name)?name:Buffer.from(name)]);
const changed=()=>{throw new Fault('TARGET_CHANGED','Filesystem preservation could not be verified.');};

/** Считает content/type/mode и symlink snapshot, не следуя symlink и не записывая имена или содержимое. */
export async function snapshotPreservedTree(workspacePath,relativePath){
 if(typeof workspacePath!=='string'||!path.isAbsolute(workspacePath)||path.normalize(workspacePath)!==workspacePath||!validRelative(relativePath)||await realpath(workspacePath)!==workspacePath)changed();
 const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;let workspace,root;const openParents=[];
 try{
  workspace=await open(workspacePath,flags);let dir=workspace;
  for(const part of relativePath.split('/')){dir=await open(child(dir.fd,part),flags);openParents.push(dir);}
  root=dir;const h=createHash('sha256');let entries=0;
  const record=value=>{if(++entries>1000000)changed();h.update(JSON.stringify(value)+'\n');};
  const walk=async(handle,prefix,depth)=>{
   if(depth>128)changed();const before=await handle.stat({bigint:true});if(!before.isDirectory())changed();
   record({path:prefix.toString('hex'),type:'directory',mode:String(before.mode&0o7777n)});
   const names=await readdir('/proc/self/fd/'+handle.fd,{encoding:'buffer'});names.sort(Buffer.compare);
   for(const name of names){
    const target=child(handle.fd,name),entryPath=prefix.length?Buffer.concat([prefix,Buffer.from('/'),name]):name;
    const beforeEntry=await lstat(target,{bigint:true});
    if(beforeEntry.isSymbolicLink()){
     const link=await readlink(target,{encoding:'buffer'}),after=await lstat(target,{bigint:true});if(stamp(beforeEntry)!==stamp(after))changed();
     record({path:entryPath.toString('hex'),type:'symlink',mode:String(beforeEntry.mode&0o7777n),target:link.toString('hex')});
    }else if(beforeEntry.isDirectory()){
     const next=await open(target,flags);try{const opened=await next.stat({bigint:true});if(stamp(beforeEntry)!==stamp(opened))changed();await walk(next,entryPath,depth+1);}finally{await next.close();}
    }else if(beforeEntry.isFile()){
     const file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{
      const opened=await file.stat({bigint:true});if(!opened.isFile()||stamp(beforeEntry)!==stamp(opened))changed();const content=createHash('sha256');
      for await(const chunk of file.createReadStream({autoClose:false}))content.update(chunk);
      const after=await file.stat({bigint:true});if(stamp(opened)!==stamp(after))changed();
      record({path:entryPath.toString('hex'),type:'file',mode:String(opened.mode&0o7777n),size:String(opened.size),sha256:content.digest('hex')});
     }finally{await file.close();}
    }else changed();
   }
   if(stamp(before)!==stamp(await handle.stat({bigint:true})))changed();
  };
  await walk(root,Buffer.alloc(0),0);return {sha256:h.digest('hex'),entries};
 }catch(error){if(error?.code==='TARGET_CHANGED')throw error;changed();}
 finally{for(const h of openParents.reverse())await h.close().catch(()=>{});await workspace?.close().catch(()=>{});}
}

async function trustedDirectory(directory){
 if(!path.isAbsolute(directory)||path.normalize(directory)!==directory||await realpath(directory)!==directory)changed();
 for(let current=directory;;current=path.dirname(current)){const s=await lstat(current,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0n||(s.mode&0o022n))changed();if(current==='/')break;}
}
const statMetadata=s=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtime_ns:String(s.mtimeNs),ctime_ns:String(s.ctimeNs),mode:String(s.mode&0o7777n),uid:String(s.uid)});
const exactKeys=(obj,keys)=>obj&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).sort().join(',')===[...keys].sort().join(',');

/** Проверяет owner receipt и metadata защищённого архива; source phase также пересчитывает дерево. */
export async function verifyFilesystemPreservation(project,w,proof,{phase='source'}={}){
 try{
  if(!['source','archive'].includes(phase)||!exactKeys(proof,['receipt_path','receipt_sha256'])||typeof proof.receipt_path!=='string'||!path.isAbsolute(proof.receipt_path)||path.normalize(proof.receipt_path)!==proof.receipt_path||!/^[a-f0-9]{64}$/.test(proof.receipt_sha256??''))changed();
  await trustedDirectory(path.dirname(proof.receipt_path));if(await realpath(proof.receipt_path)!==proof.receipt_path)changed();
  const handle=await open(proof.receipt_path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes,receiptStat;
  try{receiptStat=await handle.stat({bigint:true});if(!receiptStat.isFile()||receiptStat.uid!==0n||receiptStat.nlink!==1n||![0o440n,0o600n].includes(receiptStat.mode&0o777n)||receiptStat.size>16384n)changed();bytes=await handle.readFile();if(stamp(receiptStat)!==stamp(await handle.stat({bigint:true})))changed();}finally{await handle.close();}
  if(digest(bytes)!==proof.receipt_sha256)changed();const receipt=JSON.parse(bytes);
  if(!exactKeys(receipt,['version','project_id','workspace_id','workspace_path','source_relative_path','source_snapshot_sha256','source_entries','archive'])||receipt.version!==1||receipt.project_id!==project.id||receipt.workspace_id!==w.id||receipt.workspace_path!==w.path||!validRelative(receipt.source_relative_path)||!/^[a-f0-9]{64}$/.test(receipt.source_snapshot_sha256??'')||!Number.isSafeInteger(receipt.source_entries)||receipt.source_entries<1)changed();
  const a=receipt.archive;if(!exactKeys(a,['path','sha256','dev','ino','size','mtime_ns','ctime_ns','mode','uid'])||typeof a.path!=='string'||!path.isAbsolute(a.path)||path.normalize(a.path)!==a.path||!/^[a-f0-9]{64}$/.test(a.sha256??'')||!['dev','ino','size','mtime_ns','ctime_ns','mode','uid'].every(k=>typeof a[k]==='string'&&/^\d+$/.test(a[k])))changed();
  await trustedDirectory(path.dirname(a.path));const before=await lstat(a.path,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.uid!==0n||before.nlink!==1n||![0o400n,0o600n].includes(before.mode&0o777n)||JSON.stringify(statMetadata(before))!==JSON.stringify({dev:a.dev,ino:a.ino,size:a.size,mtime_ns:a.mtime_ns,ctime_ns:a.ctime_ns,mode:a.mode,uid:a.uid}))changed();
  if(phase==='source'){const snapshot=await snapshotPreservedTree(w.path,receipt.source_relative_path);if(snapshot.sha256!==receipt.source_snapshot_sha256||snapshot.entries!==receipt.source_entries)changed();}
  const after=await lstat(a.path,{bigint:true});if(stamp(before)!==stamp(after))changed();return {receipt_sha256:proof.receipt_sha256,source_snapshot_sha256:receipt.source_snapshot_sha256,source_entries:receipt.source_entries};
 }catch(error){if(error?.code==='TARGET_CHANGED')throw error;changed();}
}

