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
import { createLuna } from "./luna.js";
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
/** Импортирует фиксированный снимок через новый MCP и проверяет исходные тексты. */
export async function importSnapshot(s:Snapshot,url:string,token:string) {
  const client=new Client({name:"dialogues-explicit-import",version:"2"});
  await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:"Bearer "+token}}}));
  const round=randomUUID();
  const context={consumer_id:"import:"+s.sha256,context_instance_id:"import:"+s.sha256+":"+round};
  let luna:ReturnType<typeof createLuna>|undefined;
  try {
    async function call(action:string,args:Record<string,unknown>){
      const r:any=await client.callTool({name:"dialogues_exchange",arguments:{action,arguments:args,context}});
      if(r.isError||!r.structuredContent)throw new Error("IMPORT_EXCHANGE_FAILED");
      const result=r.structuredContent;let page=result.context;
      if(result.context_error){
        if(result.context_error.code!=="CONTEXT_DEFERRED")throw new Error("IMPORT_CONTEXT_FAILED");
        const deferred:any=await client.callTool({name:"dialogues_exchange",arguments:{action:"page",arguments:result.context_error.arguments}});
        if(deferred.isError||!deferred.structuredContent)throw new Error("IMPORT_CONTEXT_FAILED");
        page=deferred.structuredContent;
      }
      const delivery=page?.delivery_id;
      while(page?.continuation_cursor){
        const x:any=await client.callTool({name:"dialogues_exchange",arguments:{action:"page",arguments:{request_id:result.context_request_id,consumer_id:context.consumer_id,context_instance_id:context.context_instance_id,continuation_cursor:page.continuation_cursor}}});
        if(x.isError||!x.structuredContent)throw new Error("IMPORT_CONTEXT_FAILED");page=x.structuredContent;
      }
      if(delivery){
        const ack:any=await client.callTool({name:"dialogues_context_ack",arguments:{request_id:"import-ack:"+round+":"+sha(String(args.request_id)),...context,delivery_id:delivery}});
        if(ack.isError||!ack.structuredContent?.acknowledged)throw new Error("IMPORT_ACK_FAILED");
      }
      return result;
    }
    async function ids(label:string){
      const seen=new Set<string>();let cursor:string|undefined,index=0;
      for(;;){
        const x=await call("history",{request_id:"import-history:"+s.sha256+":"+round+":"+label+":"+index++,dialogue_id:s.thread_id,...(cursor?{cursor}:{})});
        for(const item of x.items??[])if(item.type==="message")seen.add(item.id);
        if(!x.continuation_cursor)return seen;cursor=x.continuation_cursor;
      }
    }
    const before=await ids("before");
    let batches=0,inserted=0;
    const prepared=[];
    for(const source of s.messages){
      const m={...source};
      if(Array.from(m.text as string).length>100&&!m.summary&&before.has(m.id)){
        let offset=0,part=0,summary="";
        for(;;){
          const x=await call("read",{request_id:"import-summary:"+s.sha256+":"+round+":"+sha(m.id)+":"+part++,dialogue_id:s.thread_id,message_id:m.id,target:"message_summary",offset,limit:8192});
          summary+=x.text;if(x.next_offset===null)break;offset=x.next_offset;
        }
        m.summary=summary;
      }
      if(Array.from(m.text as string).length>100&&!m.summary){
        if(!luna){
          const socket=process.env.DIALOGUES_CODEX_SOCKET_URL,cwd=process.env.DIALOGUES_SUMMARY_CWD;
          if(!socket||!cwd)throw new Error("IMPORT_SUMMARIZER_REQUIRED");
          luna=createLuna(socket,cwd);await luna.probe();
        }
        const chars=Array.from(m.text as string);let summary="";
        for(let offset=0;offset<chars.length;offset+=12000)
          summary=await luna.run(JSON.stringify({previous_summary:summary,original_fragment:chars.slice(offset,offset+12000).join(""),message_complete:offset+12000>=chars.length}),{},async()=>{});
        m.summary=summary;
      }
      prepared.push(m);
    }
    for(let i=0;i<prepared.length;){
      const messages:any[]=[];
      for(;i<prepared.length&&messages.length<25;i++){
        const next=[...messages,prepared[i]];
        const candidate={request_id:"import-"+s.sha256+"-"+batches,dialogue:{id:s.thread_id,channel:"codex",title:"Игра после истока"},messages:next};
        try{appendInput(candidate);}catch{if(!messages.length)throw new Error("SOURCE_MESSAGE_LIMIT");break;}
        messages.push(prepared[i]);
      }
      const request={request_id:"import-"+s.sha256+"-"+batches,dialogue:{id:s.thread_id,channel:"codex",title:"Игра после истока"},messages};
      const result=await call("import",request);
      if((result.messages??[]).length!==messages.length)throw new Error("IMPORT_RECEIPT_MISMATCH");
      inserted+=result.messages.filter((m:any)=>!m.replayed).length;batches++;
    }
    for(const m of s.messages) {
      let offset=0,text="",part=0;
      for(;;){
        const x=await call("read",{request_id:"import-read:"+s.sha256+":"+round+":"+sha(m.id)+":"+part++,dialogue_id:s.thread_id,message_id:m.id,offset,limit:8192});
        if(x.role!==m.role||x.kind!==m.kind||x.turn_id!==m.turn_id||x.message_order!==String(m.message_order)||x.source.record_index!==m.source.record_index||x.sha256!==sha(m.text))throw new Error("IMPORT_METADATA_MISMATCH");
        text+=x.text;if(x.next_offset===null)break;offset=x.next_offset;
      }
      if(text!==m.text)throw new Error("IMPORT_TEXT_MISMATCH");
    }
    const after=await ids("after");
    return {thread_id:s.thread_id,start_id:s.start_id,cutoff_id:s.cutoff_id,messages:s.messages.length,batches,source_sha256:s.sha256,verified_texts:s.messages.length,inserted,messages_before:before.size,messages_after:after.size};
  } finally{await luna?.close();await client.close();}
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
