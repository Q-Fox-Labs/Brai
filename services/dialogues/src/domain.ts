// ABOUTME: Задаёт проверяемые правила прямой записи и чтения диалогов.
// ABOUTME: Не обращается к PostgreSQL, сети, моделям или другим сервисам.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const limits = { messageBytes:1_048_576, requestBytes:2_097_152, responseBytes:65_024, metadataBytes:8_192 };
export class DialoguesFault extends Error {
  constructor(public code:string, public details?:Record<string,unknown>) {super(code);}
}
/** Завершает операцию предметной ошибкой без исходного текста. */
export function fail(code:string):never {throw new DialoguesFault(code);}
export const bytes = (value:unknown) => Buffer.byteLength(typeof value==="string" ? value : JSON.stringify(value),"utf8");
/** Канонизирует JSON для проверки безопасного повтора записи. */
export function canonical(value:unknown):string {
  if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
  if(value && typeof value==="object")return "{"+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+":"+canonical(v)).join(",")+"}";
  return JSON.stringify(value);
}
export const digest = (value:unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function object(value:unknown, keys:string[]):Record<string,any> {
  if(!value || typeof value!=="object" || Array.isArray(value))fail("INVALID_ARGUMENT");
  const result=value as Record<string,any>;
  if(Object.keys(result).some(k=>!keys.includes(k)))fail("INVALID_ARGUMENT");
  return result;
}
export function id(value:unknown):string {
  if(typeof value!=="string" || !/^[A-Za-z0-9_.:/-]{1,256}$/.test(value))fail("INVALID_ARGUMENT");
  return value;
}
export function text(value:unknown, maximum:number, empty=false):string {
  if(typeof value!=="string" || (!empty&&!value.trim()) || bytes(value)>maximum || value.includes("\u0000"))fail("INVALID_ARGUMENT");
  return value;
}
/** Саммари не имеет собственного лимита размера; транспорт ограничен отдельно. */
export function summaryText(value:unknown):string {
  if(typeof value!=="string"||!value.trim()||value.includes("\u0000"))fail("INVALID_ARGUMENT");
  return value;
}
export function integer(value:unknown, defaultValue?:number):number {
  if(value===undefined && defaultValue!==undefined)return defaultValue;
  if(!Number.isSafeInteger(value) || Number(value)<0)fail("INVALID_ARGUMENT");
  return Number(value);
}
export function timestamp(value:unknown):string|null {
  if(value===undefined||value===null)return null;
  if(typeof value!=="string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))fail("INVALID_ARGUMENT");
  return value;
}
export type MessageInput = {
  id:string;turn_id:string;role:"user"|"assistant";kind:"input"|"commentary"|"final";text:string;
  message_order?:number;turn_order?:number;item_order?:number;occurred_at:string|null;source:Record<string,unknown>;
  turn_status?:"in_progress"|"completed"|"interrupted"|"failed";summary?:string;
};
export type Append = {request_id:string;dialogue:{id:string;channel:string;title?:string};messages:MessageInput[]};
/** Проверяет один атомарный пакет; пересказ не заменяет оригинал. */
export function appendInput(raw:unknown):Append {
  if(bytes(raw)>limits.requestBytes)fail("REQUEST_TOO_LARGE");
  const arg=object(raw,["request_id","dialogue","messages"]);
  id(arg.request_id);
  const dialogue=object(arg.dialogue,["id","channel","title"]);
  id(dialogue.id);id(dialogue.channel);
  if(dialogue.title!==undefined)text(dialogue.title,1024);
  if(!Array.isArray(arg.messages)||arg.messages.length<1||arg.messages.length>100)fail("INVALID_ARGUMENT");
  const seen=new Set<string>();
  const messages=arg.messages.map((raw:unknown)=>{
    const m=object(raw,["id","turn_id","role","kind","text","message_order","turn_order","item_order","occurred_at","source","turn_status","summary"]);
    id(m.id);id(m.turn_id);
    if(seen.has(m.id))fail("DUPLICATE_MESSAGE_ID");seen.add(m.id);
    if(!["user","assistant"].includes(m.role)||!["input","commentary","final"].includes(m.kind)||((m.role==="user")!==(m.kind==="input")))fail("INVALID_ARGUMENT");
    text(m.text,limits.messageBytes,true);
    for(const key of ["message_order","turn_order","item_order"])if(m[key]!==undefined)integer(m[key]);
    if(m.turn_status!==undefined&&!["in_progress","completed","interrupted","failed"].includes(m.turn_status))fail("INVALID_ARGUMENT");
    const source=m.source??{kind:"agent"};
    if(!source||typeof source!=="object"||Array.isArray(source)||bytes(source)>limits.metadataBytes)fail("INVALID_ARGUMENT");
    if(m.summary!==undefined)summaryText(m.summary);
    return {...m,occurred_at:timestamp(m.occurred_at),source} as MessageInput;
  });
  return {request_id:arg.request_id,dialogue:dialogue as Append["dialogue"],messages};
}
export type SummaryInput={request_id:string;dialogue_id:string;target:"message"|"dialogue";message_id?:string;through_message_id?:string;expected_version:string|null;text:string};
/** Саммари имеет явный источник и optimistic version, включая первоначальную запись. */
export function summaryInput(raw:unknown):SummaryInput {
  const a=object(raw,["request_id","dialogue_id","target","message_id","through_message_id","expected_version","text"]);
  id(a.request_id);id(a.dialogue_id);summaryText(a.text);
  if(!["message","dialogue"].includes(a.target))fail("INVALID_ARGUMENT");
  if(a.expected_version!==null && (typeof a.expected_version!=="string"||!/^[1-9]\d*$/.test(a.expected_version)))fail("INVALID_ARGUMENT");
  if(a.target==="message"){id(a.message_id);if(a.through_message_id!==undefined)fail("INVALID_ARGUMENT");}
  else {id(a.through_message_id);if(a.message_id!==undefined)fail("INVALID_ARGUMENT");}
  return a as SummaryInput;
}
export type Cursor={v:1;owner:string;mode:"bootstrap"|"delta"|"history"|"checkpoint";scope:string|null;from:string;through:string;offset:number};
/** Подписывает stateless cursor; он не является разрешением на чужое чтение. */
export function encodeCursor(cursor:Cursor,key:string):string {
  const data=Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return data+"."+createHmac("sha256",key).update("dialogues-v1:"+data).digest("base64url");
}
export function decodeCursor(raw:string,key:string,owner:string):Cursor {
  try {
    if(raw.length>4096)fail("INVALID_CURSOR");
    const [data,sig,extra]=raw.split(".");
    if(!data||!sig||extra)fail("INVALID_CURSOR");
    const expected=createHmac("sha256",key).update("dialogues-v1:"+data).digest();
    const supplied=Buffer.from(sig,"base64url");
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))fail("INVALID_CURSOR");
    const c=JSON.parse(Buffer.from(data,"base64url").toString("utf8"));
    object(c,["v","owner","mode","scope","from","through","offset"]);
    if(c.v!==1||c.owner!==owner||!["bootstrap","delta","history","checkpoint"].includes(c.mode)||!/^\d+$/.test(c.from)||!/^\d+$/.test(c.through)||BigInt(c.from)>BigInt(c.through))fail("INVALID_CURSOR");
    integer(c.offset);
    if(c.scope!==null)id(c.scope);
    return c;
  } catch {return fail("INVALID_CURSOR");}
}
/** Возвращает ограниченный Unicode-фрагмент, не меняя хранимый текст. */
export function fragment(value:string,offset=0,length=4096) {
  const chars=Array.from(value);
  if(offset>chars.length)fail("INVALID_OFFSET");
  const end=Math.min(offset+length,chars.length);
  return {text:chars.slice(offset,end).join(""),offset,next_offset:end<chars.length?end:null,total_chars:chars.length,truncated:end<chars.length||offset>0};
}
