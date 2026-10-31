// ABOUTME: Преобразует пакет Приёма в owner DTO Каналов и проверяет полный Resolution.
// ABOUTME: Импортирует только опубликованную JSON Schema, не код или БД Каналов.
import {readFileSync} from 'node:fs';
import {Ajv} from 'ajv';
import formatsModule from 'ajv-formats';
import {Fault,type Packet,type Data} from './types.js';
import {inputHash,representable} from './contracts.js';
const ajv=new Ajv({strict:false});(formatsModule as unknown as (a:Ajv)=>void)(ajv);
const schema=JSON.parse(readFileSync(new URL('../../channels/schemas/common.schema.json',import.meta.url),'utf8'));
ajv.addSchema(schema);
const input=ajv.compile({$ref:schema.$id+'#/definitions/resolveRequest'}),output=ajv.compile({$ref:schema.$id+'#/definitions/resolution'}),error=ajv.compile({$ref:schema.$id+'#/definitions/error'});
const statuses:Record<string,number>={INVALID_ARGUMENT:400,FORBIDDEN:403,NOT_FOUND:404,CHANNEL_NOT_FOUND:404,AMBIGUOUS_CHANNEL:409,DISABLED:409,VERSION_CONFLICT:409,REQUEST_ID_CONFLICT:409,DESTINATION_CONFLICT:409,HISTORICAL_CONTEXT_UNAVAILABLE:409,INVALID_RULE_SET:422,UNSUPPORTED_PROFILE:422,REQUEST_TOO_LARGE:413,RESPONSE_TOO_LARGE:413,BUSY:503,NOT_READY:503};
function instant(value:string):bigint{
 const ms=Date.parse(value);if(!Number.isFinite(ms))throw new Fault('INVALID_CHANNEL_RESULT');
 const fraction=value.match(/\.(\d{1,6})(?:Z|[+-]\d\d:\d\d)$/)?.[1]??'';
 return BigInt(ms)*1000n+BigInt(fraction.padEnd(6,'0').slice(3));
}
/** Передаёт только факты/идентичность; initialFields профиля сообщения пока пусты. */
export function channelRequest(p:Packet,reply:Record<string,any>|null=null):Data {
 const d=p.original.data,incoming=p.original.type==='message.incoming',raw=d.sourceRef as Data;
 if(!raw||!d.author)throw new Fault('INVALID_CHANNEL_INPUT');
 if(!incoming&&(!reply?.resolutionId||!p.original.causationId))throw new Fault('CHANNEL_CONTEXT_VERSION_UNSUPPORTED');
 const hasText=typeof d.text==='string'&&d.text.length>0||(d.attachments as Data[]).some(a=>typeof a.caption==='string'&&a.caption.length>0);
 const kinds=new Set<string>();if(hasText)kinds.add('text');
 for(const a of d.attachments as Data[]){const prefix=String(a.mimeType).split('/')[0];kinds.add(['image','audio','video'].includes(prefix)?prefix:'document');}
 const q={operationId:p.id+'/channel',packetId:p.id,ownerId:p.ownerId,sourceId:p.source,asOf:p.receivedAt,eventType:p.original.type,direction:incoming?'incoming':'outgoing',sourceRef:{botId:raw.botId,chatId:raw.chatId,threadId:raw.threadId??null},author:{kind:(d.author as Data).kind,id:(d.author as Data).id},facts:{hasText,contentKinds:['text','image','audio','video','document'].filter(k=>kinds.has(k))},initialFields:{},replyTo:incoming?null:{packetId:p.original.causationId,resolutionId:reply!.resolutionId}};
 if(!representable(q)||!input(q))throw new Fault('INVALID_CHANNEL_INPUT');return q;
}
/** Проверяет схему, привязку запроса и неизменяемое назначение ответа. */
export function checkResolution(p:Packet,v:Record<string,any>,reply:Record<string,any>|null=null):void{
 if(!representable(v)||!output(v)||Buffer.byteLength(JSON.stringify(v))>131072)throw new Fault('INVALID_CHANNEL_RESULT');
 const ext=v.snapshot.channel.extensions;
 const bounded=(x:any,d=0):boolean=>d<=8&&(!x||typeof x!=='object'||Object.values(x).every(y=>bounded(y,d+1)));
 if(Buffer.byteLength(JSON.stringify(ext))>8192||!bounded(ext))throw new Fault('INVALID_CHANNEL_RESULT');
 const q=channelRequest(p,reply);
 if(v.packetId!==p.id||v.ownerId!==p.ownerId||v.sourceId!==p.source||instant(v.asOf)!==instant(p.receivedAt)||v.processing.scenario!==p.scenario||v.destination.connectionId!==v.connectionId||inputHash(v.snapshot.rules)!==v.rulesVersion||inputHash(v.type)!==inputHash(v.snapshot.connection.type))throw new Fault('INVALID_CHANNEL_RESULT');
 const {transport,connectionId,...address}=v.destination;
 if(inputHash(address)!==inputHash(q.sourceRef))throw new Fault('INVALID_CHANNEL_RESULT');
 if(reply){
  if(v.basedOnResolutionId!==reply.resolutionId||v.connectionId!==reply.connectionId||v.channelId!==reply.channelId||v.connectionVersion!==reply.connectionVersion||v.channelVersion!==reply.channelVersion||v.rulesVersion!==reply.rulesVersion||v.locationRef!==reply.locationRef||instant(v.policyAsOf)!==instant(reply.policyAsOf)||inputHash(v.destination)!==inputHash(reply.destination)||inputHash(v.snapshot)!==inputHash(reply.snapshot))throw new Fault('REPLY_ROUTE_CONFLICT');
 }else if(v.basedOnResolutionId!==null||instant(v.policyAsOf)!==instant(v.asOf))throw new Fault('INVALID_CHANNEL_RESULT');
 if(inputHash(Object.keys(v.assignments).sort())!==inputHash(Object.keys(v.fieldOrigins).sort()))throw new Fault('INVALID_CHANNEL_RESULT');
 const rules=new Map<string,{rule:Record<string,any>,index:number}>(),applied=new Set<string>();
 for(const [index,rule]of v.snapshot.rules.entries()){
  if(rules.has(rule.id))throw new Fault('INVALID_CHANNEL_RESULT');
  rules.set(rule.id,{rule,index});
 }
 let previousPriority=-Infinity,previousIndex=-1;
 for(const a of v.appliedRules){
  const found=rules.get(a.ruleId);
  if(!found||applied.has(a.ruleId)||a.rulesVersion!==v.rulesVersion||a.priority!==found.rule.priority||a.priority<previousPriority||a.priority===previousPriority&&found.index<previousIndex)throw new Fault('INVALID_CHANNEL_RESULT');
  applied.add(a.ruleId);previousPriority=a.priority;previousIndex=found.index;
 }
 for(const [key,raw]of Object.entries(v.fieldOrigins)){
  const origin=raw as Record<string,any>;
  if(origin.source==='input'){
   if(!Object.hasOwn(q.initialFields as Data,key)||inputHash(v.assignments[key])!==inputHash((q.initialFields as Data)[key]))throw new Fault('INVALID_CHANNEL_RESULT');
  }else{
   const sourceRule=rules.get(origin.ruleId)?.rule;
   const assignment=sourceRule?.assign.find((a:Data)=>a.field===key&&a.mode===origin.mode);
   if(origin.rulesVersion!==v.rulesVersion||!applied.has(origin.ruleId)||!assignment||inputHash(assignment.value)!==inputHash(v.assignments[key]))throw new Fault('INVALID_CHANNEL_RESULT');
  }
 }
}
/** Сохраняет только известный безопасный код и признак технического повтора. */
export function channelError(value:unknown,status:number):Fault{
 const v=value as Record<string,any>;
 if(!representable(v)||!error(v)||!Object.hasOwn(statuses,v.code)||statuses[v.code]!==status||v.retryable!==(status===503))return new Fault('INVALID_CHANNEL_RESULT');
 return new Fault(v.code,v.retryable);
}
