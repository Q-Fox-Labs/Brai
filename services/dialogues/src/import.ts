// ABOUTME: Однократно переносит выбранный публичный диапазон Codex JSONL через MCP.
// ABOUTME: Читает только заданный чат от точного ID; не является автоматическим захватом.
import { createReadStream } from "node:fs";
import { readFile,open,link,unlink,mkdir,stat,lstat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash,randomUUID } from "node:crypto";
import { resolve,dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { appendInput,canonical,digest } from "./domain.js";
type Snapshot={thread_id:string;start_id:string;cutoff_id:string;messages:any[];sha256:string;source_bytes:number};
const sha=(s:string)=>createHash("sha256").update(s,"utf8").digest("hex");
/** Выбирает только публичные записи после точной границы, без hidden/tool содержимого. */
export async function snapshot(file:string,thread:string,start:string):Promise<Snapshot> {
  let currentTurn="",turnOrder=-1,publicOrder=-1,found=false,matched=false,lineNo=0;
  const turnStarts=new Map<string,unknown>();
  const itemOrders=new Map<string,number>(),messages:any[]=[],seen=new Map<string,string>();
  const reader=createInterface({input:createReadStream(file,{encoding:"utf8"}),crlfDelay:Infinity});
  for await(const line of reader) {
    lineNo++;
    let record:any;
    try{record=JSON.parse(line);}catch{throw new Error("SOURCE_JSON_INVALID");}
    const p=record.payload??{};
    if(record.type==="session_meta"){
      if(p.id!==thread)throw new Error("SOURCE_THREAD_MISMATCH");
      matched=true;
    }
    if(record.type==="event_msg"&&p.type==="task_started"){currentTurn=p.turn_id;turnOrder++;turnStarts.set(currentTurn,p.started_at??null);}
    if(record.type!=="response_item"||p.type!=="message"||!["user","assistant"].includes(p.role))continue;
    if(p.role==="assistant"&&!["commentary","final_answer"].includes(p.phase))continue;
    publicOrder++;
    const itemOrder=itemOrders.get(currentTurn)??0;itemOrders.set(currentTurn,itemOrder+1);
    if(p.id===start)found=true;
    if(!found)continue;
    if(!currentTurn||!p.id)throw new Error("SOURCE_ID_MISSING");
    const blocks=(p.content??[]).filter((x:any)=>x&&typeof x.text==="string").map((x:any)=>x.text);
    const text=blocks.join("");
    const attachments=(p.content??[]).filter((x:any)=>x&&!["input_text","output_text","text"].includes(x.type)).map((x:any)=>{
      const candidate=x.image_url??x.url??x.path;
      return {type:String(x.type??"unknown"),reference:typeof candidate==="string"&&!candidate.startsWith("data:")&&candidate.length<2048?candidate:null};
    });
    const source={kind:"codex_rollout",thread_id:thread,native_message_id:p.id,native_turn_id:currentTurn,native_turn_started_at:turnStarts.get(currentTurn)??null,native_status:p.status??null,journal_recorded_at:record.timestamp??null,record_index:lineNo,text_block_lengths:blocks.map((x:string)=>Array.from(x).length),attachments};
    const message={id:p.id,turn_id:currentTurn,role:p.role,kind:p.role==="user"?"input":p.phase==="commentary"?"commentary":"final",text,message_order:publicOrder,turn_order:turnOrder,item_order:itemOrder,occurred_at:null,source};
    const hash=digest(message);
    if(seen.has(p.id)){if(seen.get(p.id)!==hash)throw new Error("SOURCE_ID_CONFLICT");continue;}
    seen.set(p.id,hash);messages.push(message);
  }
  if(!matched||!found||!messages.length||messages[0].id!==start)throw new Error("SOURCE_BOUNDARY_MISSING");
  return {thread_id:thread,start_id:start,cutoff_id:messages.at(-1).id,messages,sha256:sha(canonical(messages)),source_bytes:(await stat(file)).size};
}
/** Записывает один фиксированный снимок и проверяет каждый исходный текст; выводит только числа/хеши. */
export async function importSnapshot(s:Snapshot,url:string,token:string) {
  const client=new Client({name:"dialogues-explicit-import",version:"1"});
  await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:"Bearer "+token}}}));
  try {
    async function ids(){
      const seen=new Set<string>();let cursor:string|undefined;
      for(let page=0;page<10000;page++){
        const r:any=await client.callTool({name:"dialogues_context_get",arguments:cursor?{cursor}:{dialogue_id:s.thread_id}});
        if(r.isError||!r.structuredContent)throw new Error("IMPORT_CONTEXT_FAILED");
        const x=r.structuredContent;
        for(const d of x.dialogues)for(const t of d.turns)for(const m of t.messages)seen.add(m.id);
        if(!x.continuation_cursor)return seen;cursor=x.continuation_cursor;
      }
      throw new Error("IMPORT_CONTEXT_LIMIT");
    }
    const before=await ids();
    let batches=0;
    for(let i=0;i<s.messages.length;) {
      const messages:any[]=[];
      for(;i<s.messages.length&&messages.length<25;i++){
        const next=[...messages,s.messages[i]];
        const candidate={request_id:"import-"+s.sha256+"-"+batches,dialogue:{id:s.thread_id,channel:"codex",title:"Игра после истока"},messages:next};
        try{appendInput(candidate);}catch{if(!messages.length)throw new Error("SOURCE_MESSAGE_LIMIT");break;}
        messages.push(s.messages[i]);
      }
      const request={request_id:"import-"+s.sha256+"-"+batches,dialogue:{id:s.thread_id,channel:"codex",title:"Игра после истока"},messages};
      const result:any=await client.callTool({name:"dialogues_messages_append",arguments:request});
      if(result.isError)throw new Error("IMPORT_WRITE_FAILED");
      if((result.structuredContent?.messages??[]).length!==messages.length)throw new Error("IMPORT_RECEIPT_MISMATCH");
      batches++;
    }
    for(const m of s.messages) {
      let offset=0,text="";
      for(;;){
        const r:any=await client.callTool({name:"dialogues_message_get",arguments:{dialogue_id:s.thread_id,message_id:m.id,offset,limit:8192}});
        if(r.isError||!r.structuredContent)throw new Error("IMPORT_READ_FAILED");
        const x=r.structuredContent;
        if(x.role!==m.role||x.kind!==m.kind||x.turn_id!==m.turn_id||x.message_order!==String(m.message_order)||x.source.record_index!==m.source.record_index||x.sha256!==sha(m.text))throw new Error("IMPORT_METADATA_MISMATCH");
        text+=x.text;if(x.next_offset===null)break;offset=x.next_offset;
      }
      if(text!==m.text)throw new Error("IMPORT_TEXT_MISMATCH");
    }
    const after=await ids();
    return {thread_id:s.thread_id,start_id:s.start_id,cutoff_id:s.cutoff_id,messages:s.messages.length,batches,source_sha256:s.sha256,verified_texts:s.messages.length,inserted:s.messages.filter(m=>!before.has(m.id)&&after.has(m.id)).length,messages_before:before.size,messages_after:after.size};
  } finally{await client.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [action,file,thread,start]=process.argv.slice(2);
    const url=process.env.DIALOGUES_MCP_URL??"";
    if(!["capture","import"].includes(action)||!file)throw new Error("IMPORT_ARGUMENTS_REQUIRED");
    if(action==="capture"){
      const s=await snapshot(file,thread,start);
      const output=resolve(process.env.DIALOGUES_IMPORT_SNAPSHOT??"");
      if(!output.startsWith("/var/lib/brai-dev/dialogues-import/"))throw new Error("PRIVATE_OUTPUT_REQUIRED");
      await mkdir(dirname(output),{recursive:true,mode:0o700});
      const temporary=output+".partial-"+randomUUID();
      const fd=await open(temporary,"wx",0o600);
      try {
        await fd.writeFile(JSON.stringify(s)+"\n");await fd.sync();await fd.close();
        await link(temporary,output);
        const directory=await open(dirname(output),"r");
        try{await directory.sync();}finally{await directory.close();}
      } finally {await fd.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
      console.log(JSON.stringify({messages:s.messages.length,start_id:s.start_id,cutoff_id:s.cutoff_id,sha256:s.sha256}));
    } else {
      const path=resolve(file),m=await lstat(path);
      if(!path.startsWith("/var/lib/brai-dev/dialogues-import/")||(!m.isFile()||m.nlink!==1||(m.mode&0o077)!==0))throw new Error("PRIVATE_SNAPSHOT_REQUIRED");
      const s=JSON.parse(await readFile(path,"utf8"));
      if(s.thread_id!==thread||s.start_id!==start||sha(canonical(s.messages))!==s.sha256||s.start_id!==s.messages[0]?.id||s.cutoff_id!==s.messages.at(-1)?.id)throw new Error("SNAPSHOT_CHECKSUM_MISMATCH");
      const token=(await readFile(process.env.DIALOGUES_MCP_TOKEN_FILE??"","utf8")).trim();
      console.log(JSON.stringify(await importSnapshot(s,url,token)));
    }
  } catch (error) {const reason=error instanceof Error&&/^[A-Z_]{1,64}$/.test(error.message)?error.message:"UNKNOWN";console.error("DIALOGUES_IMPORT_FAILED:"+reason);process.exitCode=1;}
}
