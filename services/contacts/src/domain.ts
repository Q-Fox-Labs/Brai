// ABOUTME: Сопоставляет аккаунты и применяет наблюдения в одной транзакции.
// ABOUTME: Снимок поступления не заполняется нынешними значениями профиля.
import {randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {canonical,fields,hash,request,response} from './contracts.js';
import {Fault,type Caller,type Data,type Store,type Context} from './types.js';
/** Строит неизменяемый снимок только из данного наблюдения. */
export function snapshot(profile:Data):Data{return {...Object.fromEntries(fields.map(k=>[k,profile[k]??null])),observedFields:fields.filter(k=>Object.hasOwn(profile,k))};}
/** Выбирает происхождение по времени микросекунд и устойчивому UTF-8 порядку. */
export function newer(a:Data,b:Data|null):boolean {if(!b)return true;for(const k of ['observedAt','sourceId','callerId','operationId']){const order=Buffer.compare(Buffer.from(a[k]),Buffer.from(b[k]));if(order)return order>0;}return false;}
/** Применяет покомпонентную LWW-проекцию; старые наблюдения не откатывают профиль. */
export function observe(current:Data,profile:Data,origin:Data):{identity:Data;changedFields:string[]}{
 const identity=structuredClone(current),changedFields:string[]=[];
 for(const k of fields)if(Object.hasOwn(profile,k)&&newer(origin,identity.fieldOrigins[k])){
  const value=k==='photoArtifactId'&&typeof profile[k]==='string'?profile[k].toLowerCase():profile[k];
  if(identity[k]!==value)changedFields.push(k);identity[k]=value;identity.fieldOrigins[k]=origin;
 }
 identity.firstObservedAt=identity.firstObservedAt<origin.observedAt?identity.firstObservedAt:origin.observedAt;
 identity.lastObservedAt=identity.lastObservedAt>origin.observedAt?identity.lastObservedAt:origin.observedAt;
 return {identity,changedFields};
}
function cursor(key:Buffer,scope:Data,after:string):string {const body=Buffer.from(canonical({scope,after})).toString('base64url');return body+'.'+createHmac('sha256',key).update(body).digest('base64url');}
function position(key:Buffer,scope:Data,value:string|null):string|null {
 if(value===null)return null;
 try{const [b,s,...rest]=value.split('.'),actual=Buffer.from(s,'base64url'),expected=createHmac('sha256',key).update(b).digest();if(rest.length||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();const p=JSON.parse(Buffer.from(b,'base64url').toString());if(canonical(p.scope)!==canonical(scope)||typeof p.after!=='string'||!/^[a-f0-9-]{36}$/.test(p.after))throw Error();return p.after;}catch{throw new Fault('INVALID_CURSOR');}
}
/** Собирает операции вокруг транзакционного порта, не зная транспорта. */
export function createService(store:Store,callers:Record<string,Caller>,key:Buffer){
 return {async execute(op:string,callerId:string,input:Data,ctx:Context):Promise<Data>{
  const q=request(op,input),binding=callers[callerId];
  if(op==='status'){try{await store.transaction(ctx,r=>r.ready());return {ready:true,database:true,configuration:true,contractVersion:'1'};}catch{return {ready:false,database:false,configuration:true,contractVersion:'1'};}}
  if(!binding||!binding.operations.includes(op)||!binding.ownerIds.includes(q.ownerId)||(['resolve','profile.observe'].includes(op)&&!binding.sourceIds.includes(q.sourceId)))throw new Fault('FORBIDDEN');
  return store.transaction(ctx,async r=>{
   let result:Data;
   if(op==='resolve'||op==='profile.observe'){
    await r.lock('operation/'+canonical([callerId,q.ownerId,q.operationId]));
    q.observedAt=await r.timestamp(q.observedAt);
    const digest=hash(q),prior=await r.operation(callerId,q.ownerId,q.operationId);
    if(prior){if(prior.operation!==op||prior.inputHash!==digest)throw new Fault('REQUEST_ID_CONFLICT');response(op,prior.result);return prior.result;}
    await r.lock('identity/'+canonical([q.ownerId,'telegram',q.identity.externalId]));
    const time=await r.timestamp();let current=await r.identity(q.ownerId,q.identity.externalId);const created=!current;
    if(!current){if(op==='profile.observe')throw new Fault('NOT_FOUND');current={id:randomUUID(),contactId:randomUUID(),ownerId:q.ownerId,namespace:'telegram',externalId:q.identity.externalId,name:null,username:null,photoArtifactId:null,fieldOrigins:{name:null,username:null,photoArtifactId:null},firstObservedAt:q.observedAt,lastObservedAt:q.observedAt};}
    const {identity,changedFields}=observe(current,q.profile,{observedAt:q.observedAt,sourceId:q.sourceId,callerId,operationId:q.operationId});
    if(created)await r.createIdentity(identity,time);else await r.updateIdentity(identity);
    const historyEvents=created||changedFields.length?[{id:randomUUID(),type_id:created?101:102,occurred_at:time,actor_id:null,scope_type:'user',scope_id:q.ownerId,object_type:'contact',object_id:identity.contactId,data:{operationId:q.operationId,identityId:identity.id,changedFields}}]:[];
    const common={operationId:q.operationId,ownerId:q.ownerId,sourceId:q.sourceId,observedAt:q.observedAt,contactId:identity.contactId,identityId:identity.id,identity:q.identity,historyEvents};
    result=op==='resolve'?{...common,contactResolutionId:randomUUID(),packetId:q.packetId,senderSnapshot:snapshot(q.profile)}:{...common,profile:q.profile,changedFields,committedAt:time};
    response(op,result);await r.saveOperation(callerId,op,q,digest,result,time);
   }else if(op==='contacts.get'){const contact=await r.contact(q.ownerId,q.contactId);if(!contact)throw new Fault('NOT_FOUND');result=contact;}
   else if(op==='operations.get'){const prior=await r.operation(callerId,q.ownerId,q.operationId);if(!prior)throw new Fault('NOT_FOUND');result={operation:prior.operation,result:prior.result};}
   else if(op==='contacts.list'){
    const scope={callerId,ownerId:q.ownerId,namespace:q.namespace??null,externalId:q.externalId??null,limit:q.limit},after=position(key,scope,q.cursor);
    const rows=await r.list(q.ownerId,after,q.limit+1,q.externalId),items:Data[]=[];let nextCursor:string|null=null;
    for(const row of rows){if(items.length===q.limit||Buffer.byteLength(JSON.stringify({items:[...items,row],nextCursor:cursor(key,scope,row.id)}))>131072){if(!items.length)throw new Fault('RESULT_TOO_LARGE');nextCursor=cursor(key,scope,items.at(-1)!.id);break;}items.push(row);}
    result={items,nextCursor};
   }else throw new Fault('INVALID_REQUEST');
   response(op,result);return result;
  });
 }};
}
