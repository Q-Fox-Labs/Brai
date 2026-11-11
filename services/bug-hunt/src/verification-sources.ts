// ABOUTME: Читает только закреплённые Git blobs из разрешённого registry и сохраняет provenance.
// ABOUTME: Не использует рабочий checkout, не скачивает код и не следует symlink или секретным путям.
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {VerificationFault as VF,type Snapshot} from "./verification.js";
import {verificationHash as hash} from "./verification-store.js";
const run=promisify(execFile);
export interface SourceRegistration {id:string;repository:string;components:string[];paths:string[];externalAllowed:boolean}
/** Создаёт reader с операторским registry; модель может выбирать лишь разрешённые относительные paths. */
export function sourceReader(registry:SourceRegistration[]){
 return {async read(snapshot:Snapshot,id:string,path:string,first=1,last=200){
  const source=snapshot.source,entry=registry.find(r=>r.id===id&&r.components.includes(source?.component_id??""));
  if(!source||source.id!==id||!entry||!/^[a-f0-9]{40}$/.test(source.commit))throw new VF("SOURCE_UNAVAILABLE");
  if(!path||path.length>500||path.startsWith("/")||path.includes("\\")||path.split("/").some(p=>!p||p==="."||p===".."||p.startsWith(".")||/^(?:auth|credentials|secrets|private|usercustom)(?:[._-]|$)/i.test(p))||!entry.paths.some(p=>path===p||p.endsWith("/")&&path.startsWith(p)))throw new VF("SOURCE_FORBIDDEN");
  if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<1||last<first||last-first>=200)throw new VF("INVALID_ARGUMENT");
  const args=["--no-replace-objects","--git-dir="+entry.repository];
  const env={PATH:"/usr/bin:/bin",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_NO_REPLACE_OBJECTS:"1",GIT_OPTIONAL_LOCKS:"0",HOME:"/nonexistent"};
  try{
   const tree=await run("/usr/bin/git",[...args,"ls-tree","-z",source.commit,"--",path],{env,timeout:3000,maxBuffer:2048});
   const record=tree.stdout.split("\0").filter(Boolean);if(record.length!==1||!record[0].startsWith("100644 blob ")&&!record[0].startsWith("100755 blob "))throw new VF("SOURCE_FORBIDDEN");
   const blob=/^[0-9]+ blob ([a-f0-9]{40})\t/.exec(record[0]);if(!blob||record[0].slice(record[0].indexOf("\t")+1)!==path)throw new VF("SOURCE_FORBIDDEN");
   const result=await run("/usr/bin/git",[...args,"cat-file","blob",blob[1]],{env,timeout:3000,maxBuffer:65536,encoding:"buffer"});
   const text=new TextDecoder("utf8",{fatal:true}).decode(result.stdout);
   if(text.includes("\0"))throw new VF("UNSUPPORTED_SOURCE");
   const lines=text.split("\n"),slice=lines.slice(first-1,last).join("\n");
   return {text:slice,sha256:hash(slice),external_allowed:entry.externalAllowed,provenance:{source_id:id,component_id:source.component_id,commit:source.commit,path,blob_sha256:hash(text),git_blob:blob[1],first_line:first,last_line:Math.min(last,lines.length),complete:first===1&&last>=lines.length}};
  }catch(e){if(e instanceof VF)throw e;throw new VF("SOURCE_UNAVAILABLE");}
 }};
}
