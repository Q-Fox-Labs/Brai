// ABOUTME: Готовит узкое наблюдение отправителя и проверяет owner DTO Контактов.
// ABOUTME: Читает только поставляемые схемы; не импортирует чужую реализацию.
import {readFileSync} from 'node:fs';
import {Ajv} from 'ajv';
import formats from 'ajv-formats';
import {Fault,type Data,type Packet,type Message} from './types.js';
import {inputHash,representable} from './contracts.js';
const ajv=new Ajv({strict:false});(formats as unknown as(a:Ajv)=>void)(ajv);
const load=(p:string)=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const common=load('../../contacts/schemas/common.schema.json'),api=load('../../contacts/schemas/api.schema.json');
for(const s of [load('../../history/schemas/common.schema.json'),load('../../history/schemas/messages.schema.json'),common,api])ajv.addSchema(s);
const request=ajv.compile({$ref:api.$id+'#/definitions/resolveRequest'}),result=ajv.compile({$ref:common.$id+'#/definitions/resolution'}),error=ajv.compile({$ref:common.$id+'#/definitions/error'});
const fields=['name','username','photoArtifactId'];
function instant(value:string):bigint {const ms=Date.parse(value);if(!Number.isFinite(ms))throw new Fault('INVALID_CONTACT_RESULT');const f=value.match(/\.(\d{1,6})(?:Z|[+-]\d\d:\d\d)$/)?.[1]??'';return BigInt(ms)*1000n+BigInt(f.padEnd(6,'0').slice(3));}
/** Исключает пустые строки и непроверенное фото, сохраняя null и original. */
export function contactInput(p:Packet,photoReady=false):{request:Data;diagnostics:Data[]} {
 const a=(p.original.data as Message).author,profile:Data={},empty:string[]=[];
 if(p.original.type!=='message.incoming'||a?.kind!=='human')throw new Fault('INVALID_CONTACT_INPUT');
 for(const k of ['name','username'])if(Object.hasOwn(a,k)){const v=(a as unknown as Data)[k];if(v==='')empty.push(k);else profile[k]=v;}
 if(a.photoArtifactId===null||photoReady&&typeof a.photoArtifactId==='string')profile.photoArtifactId=a.photoArtifactId;
 const q={operationId:p.id+'/contact',packetId:p.id,ownerId:p.ownerId,sourceId:p.source,identity:{namespace:'telegram',externalId:a.id},observedAt:p.receivedAt,profile};
 if(!representable(q)||!request(q)||Buffer.byteLength(JSON.stringify(q))>65536)throw new Fault('INVALID_CONTACT_INPUT');
 return {request:q,diagnostics:empty.length?[{code:'EMPTY_PROFILE_FIELD',fields:empty}]:[]};
}
/** Проверяет привязку сохранённого intent к исходному поступлению. */
export function checkContactRequest(p:Packet,q:Data):void {
 const expected=contactInput(p,typeof (q.profile as Data)?.photoArtifactId==='string').request;
 if(!representable(q)||!request(q)||inputHash(q)!==inputHash(expected))throw new Fault('INVALID_CONTACT_CONTEXT');
}
/** Проверяет снимок, все ссылки и безопасный факт Истории до сохранения результата. */
export function checkContact(p:Packet,v:Data):void {
 const q=p.contactRequest;if(!q)throw new Fault('CONTACT_CONTEXT_VERSION_UNSUPPORTED');checkContactRequest(p,q);
 if(!representable(v)||!result(v)||Buffer.byteLength(JSON.stringify(v))>131072)throw new Fault('INVALID_CONTACT_RESULT');
 const expected={...Object.fromEntries(fields.map(k=>[k,(q.profile as Data)[k]??null])),observedFields:fields.filter(k=>Object.hasOwn(q.profile as Data,k))};
 if(v.operationId!==q.operationId||String(v.packetId).toLowerCase()!==p.id.toLowerCase()||v.ownerId!==p.ownerId||v.sourceId!==p.source||instant(String(v.observedAt))!==instant(String(q.observedAt))||inputHash(v.identity)!==inputHash(q.identity)||inputHash(v.senderSnapshot)!==inputHash(expected))throw new Fault('INVALID_CONTACT_RESULT');
 for(const e of v.historyEvents as Data[]){
  const data=e.data as Data,changed=data?.changedFields;
  if(![101,102].includes(Number(e.type_id))||e.scope_type!=='user'||e.scope_id!==p.ownerId||e.actor_id!==null||e.object_type!=='contact'||String(e.object_id).toLowerCase()!==String(v.contactId).toLowerCase()||!data||inputHash(Object.keys(data).sort())!==inputHash(['changedFields','identityId','operationId'])||data.operationId!==q.operationId||String(data.identityId).toLowerCase()!==String(v.identityId).toLowerCase()||!Array.isArray(changed)||changed.some((k:any)=>!fields.includes(k)||!Object.hasOwn(q.profile as Data,k))||inputHash(changed)!==inputHash(fields.filter(k=>changed.includes(k)))||e.type_id===102&&changed.length===0)throw new Fault('INVALID_CONTACT_RESULT');
 }
}
/** Проверяет известный код и обещанную политику повтора без доверия к тексту ошибки. */
export function contactError(value:unknown,status:number):Fault {
 const codes:Record<string,number>={INVALID_REQUEST:400,UNSUPPORTED_NAMESPACE:400,FORBIDDEN:403,NOT_FOUND:404,REQUEST_ID_CONFLICT:409,INVALID_CURSOR:400,REQUEST_TOO_LARGE:413,RESULT_TOO_LARGE:413,BUSY:503,DATABASE_UNAVAILABLE:503,DEADLINE_EXCEEDED:504,INTERNAL:500};
 if(!representable(value)||!error(value))return new Fault('INVALID_CONTACT_RESULT');
 const v=value as Record<string,any>;
 if(codes[v.code]!==status||v.retryable!==['BUSY','DATABASE_UNAVAILABLE','DEADLINE_EXCEEDED'].includes(v.code))return new Fault('INVALID_CONTACT_RESULT');
 return new Fault(v.code,v.retryable);
}
/** Подтверждение append должно соответствовать сохранённому факту, а не любому JSON. */
export function checkContactHistory(q:Data,value:Data):void {
 const e=value.event as Data;
 if(!e||e.source!=='service_contacts'||e.id!==q.id||e.type_id!==q.type_id||e.scope_type!==q.scope_type||e.scope_id!==q.scope_id||e.object_type!==q.object_type||e.object_id!==q.object_id||e.actor_id!==q.actor_id||instant(String(e.occurred_at))!==instant(String(q.occurred_at))||inputHash(e.data)!==inputHash(q.data))throw new Fault('INVALID_CONTACT_HISTORY_RESULT');
}
