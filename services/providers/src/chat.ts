// ABOUTME: Собирает ограниченный SSE chat и готовит продолжение caller tools.
// ABOUTME: Не исполняет инструменты; сохраняет raw provider message до нормализации Proxy.
import { Failure } from "./core.js";
import { boundedJson, canonical, type Json } from "./json.js";
import type { OperationStore } from "./operations.js";
export const CHAT_LIMITS=Object.freeze({streamBytes:1048576,frameBytes:32768,frames:8192,textBytes:8192,toolBytes:4096,tools:8,stateBytes:24576,events:16384,deliveryBytes:32768});
export const CHAT_MODEL="deepseek/deepseek-v3.2";
export const CHAT_ROUTE="deepinfra/fp4";
export type Message={role:string;[key:string]:Json};
export type Tool={type:"function";function:{name:string;description?:string;parameters:Record<string,Json>}};
export type ChatRequest={operationId:string;ownerId:string;connectionId:string;provider:string;model:string;deadlineAt:string;streamInbox:string;messages:{role:"system"|"user";content:string}[];tools:Tool[];maxTokens:number;toolChoice:"auto"|"none"|"required";continuation?:{operationId:string};toolResults?:{id:string;content:string}[]};
export type ToolCall={index:number;id:string;name:string;arguments:Record<string,Json>};
export type ChatPart={type:"text.delta";text:string}|{type:"tool_call.delta";index:number;id:string|null;name:string;argumentsDelta:string}|{type:"tool_call.ready";call:ToolCall}|{type:"usage";usage:Usage};
export type StreamEvent=({type:"started"}|ChatPart|{type:"completed"}|{type:"error";code:string;partial:true})&{operationId:string;sequence:number};
export type EventSink=(event:StreamEvent)=>boolean;
export type Usage={inputTokens:number;outputTokens:number}|null;
export type ChatCompletion={actualModel:string;text:string;toolCalls:ToolCall[];finishReason:string;usage:Usage;message:Message};
export type ChatPort=(request:ChatRequest,messages:Message[],signal:AbortSignal,emit:(event:ChatPart)=>void)=>Promise<ChatCompletion>;
const fail=()=>new Failure("UPSTREAM_PROTOCOL","unknown");
const bytes=(s:string)=>Buffer.byteLength(s);
const record=(v:unknown):v is Record<string,Json>=>v!==null&&typeof v==="object"&&!Array.isArray(v);

/** Единственный допустимый chat профиль; произвольные upstream параметры caller не передаёт. */
export function chatWire(input:ChatRequest,messages:Message[]) {
  return {model:input.model,messages,stream:true,stream_options:{include_usage:true},max_tokens:input.maxTokens,...(input.tools.length?{tools:input.tools,tool_choice:input.toolChoice}:{}),reasoning:{enabled:false},provider:{only:[CHAT_ROUTE],order:[CHAT_ROUTE],require_parameters:true,allow_fallbacks:false}};
}

/** Инкрементальный UTF-8 SSE parser; пределы действуют до JSON.parse. EOF без [DONE] не успех. */
export function createSseParser(onChunk:(chunk:Record<string,Json>)=>void) {
  const decoder=new TextDecoder("utf-8",{fatal:true});let buffer="",total=0,frames=0,done=false;
  function consume(text:string) {
    buffer+=text;
    for(;;){const match=/\r?\n\r?\n/.exec(buffer);if(!match)break;
      const frame=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);
      if(bytes(frame)>CHAT_LIMITS.frameBytes || ++frames>CHAT_LIMITS.frames)throw fail();
      const data=frame.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).replace(/^ /,"")).join("\n");
      if(!data)continue;
      if(done)throw fail();
      if(data==="[DONE]"){done=true;continue;}
      let chunk:unknown;try{chunk=JSON.parse(data);}catch{throw fail();}
      if(!record(chunk)||!boundedJson(chunk))throw fail();onChunk(chunk);
    }
    if(bytes(buffer)>CHAT_LIMITS.frameBytes)throw fail();
  }
  return {
    push(chunk:Uint8Array){total+=chunk.byteLength;if(total>CHAT_LIMITS.streamBytes)throw fail();consume(decoder.decode(chunk,{stream:true}));},
    end(){consume(decoder.decode());if(buffer.trim()!==""||!done)throw fail();}
  };
}
/** Читает до завершения и при ошибке закрывает upstream reader без повторной отправки. */
export async function consumeSse(body:ReadableStream<Uint8Array>,onChunk:(chunk:Record<string,Json>)=>void) {
  const reader=body.getReader(),parser=createSseParser(onChunk);
  try{for(;;){const part=await reader.read();if(part.done)break;parser.push(part.value);}parser.end();}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}

/** Сохраняет неизвестный provider field целиком; повтор поля обязан совпадать, иначе отказ без потерь. */
function preserve(target:Record<string,Json>,key:string,value:Json) {
  if(!Object.hasOwn(target,key)){Object.defineProperty(target,key,{value:structuredClone(value),writable:true,enumerable:true,configurable:true});return;}
  if(canonical(target[key])!==canonical(value))throw fail();
}
/** Принятый flat scalar JSON Schema subset не исполняет refs, regex или пользовательский код. */
function validArguments(tool:Tool,args:Record<string,Json>) {
  const schema=tool.function.parameters,properties=schema.properties as Record<string,Record<string,Json>>,required=schema.required as string[];
  return required.every(key=>Object.hasOwn(args,key))&&Object.entries(args).every(([key,value])=>{
    if(!Object.hasOwn(properties,key))return false;
    const type=properties[key].type;
    return type==="integer"?Number.isSafeInteger(value):typeof value===type;
  });
}
/** Собирает один выбор и несколько чередующихся tools; ready выдаётся только после полного finish. */
export function createChatAssembler(request:Pick<ChatRequest,"tools">,emit:(event:ChatPart)=>void=()=>{}) {
  let text="",finishReason:string|null=null,actualModel="",usage:Usage=null,finished=false;
  const tools=new Map<number,{id:string;name:string;arguments:string;extra:Record<string,Json>;functionExtra:Record<string,Json>}>();
  const extra:Record<string,Json>=Object.create(null);
  function push(chunk:Record<string,Json>) {
    if(finished||chunk.error)throw fail();
    if(typeof chunk.model==="string"){if(actualModel&&actualModel!==chunk.model)throw fail();actualModel=chunk.model;}
    if(chunk.usage!=null){const u=chunk.usage;if(!record(u)||!Number.isSafeInteger(u.prompt_tokens)||!Number.isSafeInteger(u.completion_tokens)||(u.prompt_tokens as number)<0||(u.completion_tokens as number)<0)throw fail();usage={inputTokens:u.prompt_tokens as number,outputTokens:u.completion_tokens as number};emit({type:"usage",usage});}
    if(!Array.isArray(chunk.choices)||chunk.choices.length>1)throw fail();
    if(!chunk.choices.length)return;
    const choice=chunk.choices[0];if(!record(choice)||choice.index!==0||!record(choice.delta))throw fail();
    const delta=choice.delta;
    // AIDEV-NOTE: OpenRouter usage frame повторяет finish_reason и пустую assistant delta.
    // Это accounting, не второй finish и не разрешение принимать новые tokens/tools после finish.
    if(finishReason!==null){
      if(choice.finish_reason!=null&&(choice.finish_reason!==finishReason||chunk.usage==null)||delta.content!=null&&delta.content!==""||delta.tool_calls!=null&&(!Array.isArray(delta.tool_calls)||delta.tool_calls.length>0))throw fail();
      if(delta.role!=null&&delta.role!=="assistant")throw fail();
      for(const [k,v]of Object.entries(delta))if(!["role","content","tool_calls"].includes(k)&&v!=null)preserve(extra,k,v);
      return;
    }
    if(delta.role!=null&&delta.role!=="assistant")throw fail();
    if(delta.content!=null){if(typeof delta.content!=="string")throw fail();text+=delta.content;if(bytes(text)>CHAT_LIMITS.textBytes)throw fail();if(delta.content)emit({type:"text.delta",text:delta.content});}
    if(delta.tool_calls!=null){if(!Array.isArray(delta.tool_calls))throw fail();for(const fragment of delta.tool_calls){
      if(!record(fragment)||!Number.isInteger(fragment.index)||(fragment.index as number)<0||(fragment.index as number)>=CHAT_LIMITS.tools)throw fail();
      const index=fragment.index as number;let tool=tools.get(index);if(!tool){tool={id:"",name:"",arguments:"",extra:Object.create(null),functionExtra:Object.create(null)};tools.set(index,tool);}
      if(fragment.type!=null&&fragment.type!=="function")throw fail();
      if(fragment.id!=null){if(typeof fragment.id!=="string"||!fragment.id||bytes(fragment.id)>255||tool.id&&tool.id!==fragment.id)throw fail();tool.id=fragment.id;}
      const fn=fragment.function;if(fn!=null&&!record(fn))throw fail();
      const f=fn as Record<string,Json>|undefined;
      if(f?.name!=null){if(typeof f.name!=="string")throw fail();tool.name+=f.name;if(bytes(tool.name)>64)throw fail();}
      const part=f?.arguments??"";if(typeof part!=="string")throw fail();tool.arguments+=part;if(bytes(tool.arguments)>CHAT_LIMITS.toolBytes)throw fail();
      for(const [k,v]of Object.entries(fragment))if(!["index","type","id","function"].includes(k))preserve(tool.extra,k,v);
      for(const [k,v]of Object.entries(f??{}))if(!["name","arguments"].includes(k))preserve(tool.functionExtra,k,v);
      emit({type:"tool_call.delta",index,id:tool.id||null,name:tool.name,argumentsDelta:part});
    }}
    for(const [k,v]of Object.entries(delta))if(!["role","content","tool_calls"].includes(k)&&v!=null)preserve(extra,k,v);
    if(choice.finish_reason!=null){if(typeof choice.finish_reason!=="string"||!choice.finish_reason||bytes(choice.finish_reason)>64||finishReason!==null)throw fail();finishReason=choice.finish_reason;}
  }
  return {push,
    finish():ChatCompletion {
      if(finished||!actualModel||finishReason===null)throw fail();finished=true;
      const calls:ToolCall[]=[],raw:Json[]=[];const ids=new Set<string>();
      for(const [index,t]of [...tools].sort((a,b)=>a[0]-b[0])){
        let args:unknown;try{args=JSON.parse(t.arguments);}catch{throw fail();}
        const definition=request.tools.find(tool=>tool.function.name===t.name);
        if(index!==calls.length||!t.id||ids.has(t.id)||!record(args)||!boundedJson(args)||!definition||!validArguments(definition,args))throw fail();ids.add(t.id);
        calls.push({index,id:t.id,name:t.name,arguments:args});raw.push({...t.extra,id:t.id,type:"function",function:{...t.functionExtra,name:t.name,arguments:t.arguments}});
      }
      if((calls.length>0)!==(finishReason==="tool_calls"))throw fail();
      // AIDEV-NOTE: Только complete tool_calls может стать исполняемым; length/content_filter tools не выдаёт ready.
      for(const call of calls)emit({type:"tool_call.ready",call});
      const message:Message={...extra,role:"assistant",content:text||null,...(raw.length?{tool_calls:raw}:{})};
      if(bytes(JSON.stringify(message))>CHAT_LIMITS.stateBytes)throw fail();
      return {actualModel,text,toolCalls:calls,finishReason,usage,message};
    }
  };
}

/** Разрешает durable continuation только того же owner, connection, provider/model и полного набора tool IDs. */
export async function chatMessages(store:OperationStore,input:ChatRequest,now:number):Promise<Message[]> {
  let messages:Message[]=[];
  if(input.continuation){
    const old=await store.find(input.ownerId,input.continuation.operationId,now);
    const r=old?.result;
    if(!old||old.phase!=="succeeded"||old.resultExpiresAt===null||old.resultExpiresAt<=now||!record(r)||r.connectionId!==input.connectionId||r.provider!==input.provider||r.requestedModel!==input.model||!record(r.continuation)||typeof r.continuation.state!=="string"||!Array.isArray(r.toolCalls))throw new Failure("INVALID_CONTINUATION","not_sent");
    try{messages=JSON.parse(Buffer.from(r.continuation.state,"base64url").toString("utf8"));}catch{throw new Failure("INVALID_CONTINUATION","not_sent");}
    const expected=r.toolCalls.map(c=>(c as Record<string,Json>).id),results=input.toolResults??[];
    if(results.length!==expected.length||new Set(results.map(r=>r.id)).size!==results.length||results.some(r=>!expected.includes(r.id))||r.toolCalls.some(c=>!input.tools.some(tool=>tool.function.name===(c as Record<string,Json>).name)))throw new Failure("INVALID_CONTINUATION","not_sent");
    messages.push(...results.map(r=>({role:"tool",tool_call_id:r.id,content:r.content})));
  }else if(input.toolResults?.length||!input.messages.length)throw new Failure("INVALID_REQUEST","not_sent");
  messages.push(...input.messages);
  if(messages.length>64||bytes(JSON.stringify(messages))>CHAT_LIMITS.stateBytes)throw new Failure("INVALID_REQUEST","not_sent");
  if(new Set(input.tools.map(t=>t.function.name)).size!==input.tools.length||input.toolChoice==="required"&&!input.tools.length)throw new Failure("INVALID_REQUEST","not_sent");
  for(const tool of input.tools){const s=tool.function.parameters;if((s.required as string[]).some(key=>!Object.hasOwn(s.properties as object,key)))throw new Failure("INVALID_REQUEST","not_sent");}
  return messages;
}

/** Строит полный durable итог; opaque state не принимается от caller, только через ссылку operationId. */
export function chatResult(input:ChatRequest,messages:Message[],result:ChatCompletion,deliveryInterrupted:boolean):Json {
  if(result.actualModel!==input.model)throw fail();
  const state=JSON.stringify([...messages,result.message]);if(bytes(state)>CHAT_LIMITS.stateBytes)throw fail();
  return {provider:input.provider,requestedModel:input.model,actualModel:result.actualModel,connectionId:input.connectionId,text:result.text,toolCalls:result.toolCalls as unknown as Json,finishReason:result.finishReason,usage:result.usage,partial:false,streamDelivery:deliveryInterrupted?"interrupted":"unconfirmed",continuation:{operationId:input.operationId,state:Buffer.from(state).toString("base64url")}};
}
