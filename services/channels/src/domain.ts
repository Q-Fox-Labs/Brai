// ABOUTME: Выполняет операции Каналов и фиксирует решения в транзакционном порте.
// ABOUTME: Не знает SQL, транспортных credentials и внутреннего устройства Приёма.
import {randomUUID} from 'node:crypto';
import {request,response,profile,hash,canonical} from './contracts.js';
import {evaluate,checkRules} from './rules.js';
import {encodeCursor,decodeCursor} from './cursor.js';
import {Fault,type Data,type Entity,type Caller,type Store,type Repository,type Context} from './types.js';
const permitted=(b:Caller,owner:string)=>b.ownerIds.includes(owner);
const sameUuid=(left:string,right:string)=>left.toLowerCase()===right.toLowerCase();
function scope(b:Caller,e:Entity|null,owner:string):Entity {
 if(!e||e.ownerId!==owner)throw new Fault('NOT_FOUND');
 // AIDEV-NOTE: Старые body/квитанции сохраняют регистр; сравнение UUID не переписывает историю.
 if(b.connectionIds!==null&&!b.connectionIds.some(id=>sameUuid(id,e.connectionId??e.id)))throw new Fault('FORBIDDEN');
 return e;
}
const address=(r:Data)=>({botId:r.botId,chatId:r.chatId,threadId:r.threadId});
function outputProfileMatch(p:Data|null):boolean {return !!p&&hash({...p,name:profile.name})===hash(profile);}
async function current(r:Repository,kind:'connection'|'channel',e:Entity):Promise<Data>{
 const v=await r.version(kind,e.id,e.currentVersion);if(!v)throw new Fault('NOT_READY');return v;
}
function enabled(...versions:Data[]){if(versions.some(v=>!v.settings.enabled))throw new Fault('DISABLED');}
function humanAllowed(author:string,...versions:Data[]){if(versions.some(v=>!v.settings.allowedActorIds.includes(author)))throw new Fault('FORBIDDEN');}
/** Создаёт прикладной API с явной конфигурацией caller и ключом пагинации. */
export function createService(store:Store,callers:Record<string,Caller>,cursorKey:Buffer){
 async function mutation(r:Repository,op:string,callerId:string,b:Caller,q:Data):Promise<Data>{
  await r.lockKey('command/'+canonical([callerId,q.ownerId,q.requestId]));
  const digest=hash({operation:op,request:q}),prior=await r.receipt(callerId,q.ownerId,q.requestId);
  if(prior){
   if(prior.inputHash!==digest)throw new Fault('REQUEST_ID_CONFLICT');
   const result=prior.result;scope(b,{...result,currentVersion:result.version},q.ownerId);
   return prior;
  }
  const kind=op.startsWith('connections')?'connection':'channel',create=op.endsWith('.create');
  let e:Entity,old:Data|null=null;
  if(kind==='connection'){
   if(create){
    if(b.connectionIds!==null||!b.sourceIds.includes(q.sourceId))throw new Fault('FORBIDDEN');
    if(!outputProfileMatch(await r.profile(q.type)))throw new Fault('UNSUPPORTED_PROFILE');
    e={id:randomUUID(),ownerId:q.ownerId,type:q.type,sourceId:q.sourceId,botId:q.botId,currentVersion:1};
   }else{e=scope(b,await r.connection(q.connectionId,'write'),q.ownerId);old=await current(r,kind,e);}
  }else{
   let id=q.connectionId;
   if(!create){const found=await r.channel(q.channelId);if(!found||found.ownerId!==q.ownerId)throw new Fault('NOT_FOUND');id=found.connectionId;}
   const connection=scope(b,await r.connection(id,'read'),q.ownerId);
   if(create){
    if(q.address.botId!==connection.botId||q.kind==='dialog'&&(q.address.threadId!==null||q.parentId!==null)||q.kind==='topic'&&q.address.threadId===null)throw new Fault('INVALID_ARGUMENT');
    let parentId:string|null=null;
    if(q.parentId){const parent=scope(b,await r.channel(q.parentId,'read'),q.ownerId);if(parent.kind!=='dialog'||!sameUuid(parent.connectionId,connection.id)||parent.address.chatId!==q.address.chatId)throw new Fault('INVALID_ARGUMENT');parentId=parent.id;}
    e={id:randomUUID(),ownerId:q.ownerId,connectionId:connection.id,kind:q.kind,address:q.address,parentId,currentVersion:1};
   }else{e=scope(b,await r.channel(q.channelId,'write'),q.ownerId);old=await current(r,kind,e);}
   checkRules(q.settings.rules);
  }
  if(!create&&q.expectedVersion!==e.currentVersion)throw new Fault('VERSION_CONFLICT');
  const time=await r.now(old?.effectiveFrom),version=create?1:e.currentVersion+1;
  if(version>2147483647)throw new Fault('VERSION_CONFLICT');
  const {currentVersion,...identity}=e;
  const result={...identity,version,effectiveFrom:time,recordedAt:time,settings:q.settings,...(kind==='channel'?{rulesVersion:hash(q.settings.rules)}:{})};
  const changed=Object.keys(q.settings).filter(k=>!old||canonical(old.settings[k])!==canonical(q.settings[k])).sort();
  const historyEvent={id:randomUUID(),type_id:create?101:1301,occurred_at:time,actor_id:q.actorId,scope_type:'user',scope_id:q.ownerId,object_type:kind==='connection'?'channel_connection':'channel',object_id:e.id,data:{operation:op,requestId:q.requestId,version,previousVersion:old?.version??null,changes:changed}};
  const receipt={requestId:q.requestId,operation:op,ownerId:q.ownerId,inputHash:digest,committedAt:time,result,historyEvent};
  response(op,receipt);
  if(create)await r.insertIdentity(kind,e);
  await r.insertVersion(kind,e,{value:result,actorId:q.actorId,reason:q.reason});
  await r.saveReceipt(callerId,receipt);
  return receipt;
 }
 async function resolve(r:Repository,callerId:string,b:Caller,q:Data):Promise<Data>{
  const incoming=q.direction==='incoming';
  if(q.eventType!==(incoming?'message.incoming':'message.outgoing')||q.author.kind!==(incoming?'human':'agent')||incoming&&q.replyTo!==null||!incoming&&q.replyTo===null)throw new Fault('INVALID_ARGUMENT');
  if(!(incoming?b.sourceIds:b.replySourceIds).includes(q.sourceId))throw new Fault('FORBIDDEN');
  if(incoming&&!/^[1-9][0-9]*$/.test(q.author.id))throw new Fault('INVALID_ARGUMENT');
  if(q.facts.hasText!==q.facts.contentKinds.includes('text')||!q.facts.contentKinds.length)throw new Fault('INVALID_ARGUMENT');
  await r.lockKey('resolve/'+canonical([callerId,q.ownerId,q.operationId]));
  const digest=hash(q),prior=await r.resolution(callerId,q.ownerId,q.operationId);
  if(prior){if(prior.hash!==digest)throw new Fault('REQUEST_ID_CONFLICT');scope(b,{id:prior.result.connectionId,ownerId:q.ownerId,currentVersion:0},q.ownerId);return prior.result;}
  let connection:Entity,channel:Entity,cv:Data,hv:Data,parent:Data|null=null;
  if(incoming){
   connection=scope(b,await r.connectionBySource(q.sourceId),q.ownerId);
   if(connection.botId!==q.sourceRef.botId)throw new Fault('FORBIDDEN');
   const found=await r.channelByAddress(connection.id,q.sourceRef);if(!found)throw new Fault('CHANNEL_NOT_FOUND');
   channel=scope(b,found,q.ownerId);
   cv=(await r.version('connection',connection.id,undefined,q.asOf))!;
   hv=(await r.version('channel',channel.id,undefined,q.asOf))!;
   if(!cv||!hv)throw new Fault('HISTORICAL_CONTEXT_UNAVAILABLE');
   enabled(cv,hv);humanAllowed(q.author.id,cv,hv);
  }else{
   const stored=await r.resolutionById(q.replyTo.resolutionId);
   if(!stored||stored.result.ownerId!==q.ownerId||stored.result.packetId!==q.replyTo.packetId||stored.input.direction!=='incoming')throw new Fault('NOT_FOUND');
   parent=stored.result;if(!parent)throw new Fault('NOT_READY');
   if(canonical(address(parent.destination))!==canonical(q.sourceRef))throw new Fault('DESTINATION_CONFLICT');
   connection=scope(b,await r.connection(parent.connectionId,'read'),q.ownerId);
   channel=scope(b,await r.channel(parent.channelId,'read'),q.ownerId);
   cv=(await r.version('connection',connection.id,parent.connectionVersion))!;
   hv=(await r.version('channel',channel.id,parent.channelVersion))!;
   if(!cv||!hv)throw new Fault('HISTORICAL_CONTEXT_UNAVAILABLE');
  }
  enabled(await current(r,'connection',connection),await current(r,'channel',channel));
  const asOf=await r.timestamp(q.asOf),destination=parent?.destination??{transport:'telegram',connectionId:connection.id,...q.sourceRef};
  const result={resolutionId:randomUUID(),packetId:q.packetId,ownerId:q.ownerId,sourceId:q.sourceId,asOf,policyAsOf:parent?.policyAsOf??asOf,type:cv.type,connectionId:connection.id,connectionVersion:cv.version,channelId:channel.id,channelVersion:hv.version,rulesVersion:hv.rulesVersion,locationRef:parent?.locationRef??hv.settings.locationRef,destination,processing:{mode:'temporal',scenario:incoming?'incoming.v1':'outgoing.v1'},...evaluate(hv.settings.rules,q,hv.rulesVersion),basedOnResolutionId:parent?.resolutionId??null,snapshot:{connection:{name:cv.settings.name,type:cv.type},channel:{name:hv.settings.name,extensions:hv.settings.extensions},rules:hv.settings.rules}};
  response('resolve',result);await r.saveResolution(callerId,q,digest,result);return result;
 }
 async function delivery(r:Repository,b:Caller,q:Data):Promise<Data>{
  const stored=await r.resolutionById(q.resolutionId);
  if(!stored||stored.result.ownerId!==q.ownerId)throw new Fault('NOT_FOUND');
  const result=stored.result;
  if(hash(result.destination)!==q.destinationHash)throw new Fault('DESTINATION_CONFLICT');
  const connection=scope(b,await r.connection(result.connectionId,'read'),q.ownerId),channel=scope(b,await r.channel(result.channelId,'read'),q.ownerId);
  if(canonical(address(result.destination))!==canonical(channel.address)||connection.botId!==result.destination.botId)throw new Fault('DESTINATION_CONFLICT');
  const cv=await current(r,'connection',connection),hv=await current(r,'channel',channel);enabled(cv,hv);
  const origin=result.basedOnResolutionId?await r.resolutionById(result.basedOnResolutionId):stored;
  if(!origin||origin.result.ownerId!==q.ownerId||origin.input.author.kind!=='human')throw new Fault('NOT_READY');
  humanAllowed(origin.input.author.id,cv,hv);
  return {allowed:true,resolutionId:result.resolutionId,destinationHash:q.destinationHash,checkedAt:await r.now(),connectionVersion:cv.version,channelVersion:hv.version,credentialsRef:cv.settings.credentialsRef};
 }
 return {
  /** Проверяет собственную схему и установленный профиль без обращения к соседям. */
  async ready():Promise<void>{await store.transaction({deadline:performance.now()+5000},async r=>{await r.ready();if(!outputProfileMatch(await r.profile()))throw new Fault('NOT_READY');});},
  /** Исполняет один запрос; успешный результат валидируется до COMMIT. */
  async execute(op:string,callerId:string,input:unknown,context:Context={deadline:performance.now()+5000}):Promise<Data>{
   const q=request(op,input);
   if(op==='status'){let database=true;try{await this.ready();}catch{database=false;}return {ready:database,database,configuration:true,contractVersion:'1'};}
   const b=Object.hasOwn(callers,callerId)?callers[callerId]:null;
   if(!b||!b.operations.includes(op)||q.ownerId!==undefined&&!permitted(b,q.ownerId))throw new Fault('FORBIDDEN');
   return store.transaction(context,async r=>{
    let result:Data;
    if(op.endsWith('.create')||op.endsWith('.publish'))result=await mutation(r,op,callerId,b,q);
    else if(op==='resolve')result=await resolve(r,callerId,b,q);
    else if(op==='delivery.check')result=await delivery(r,b,q);
    else if(op==='operations.get'){
     result=(await r.receipt(callerId,q.ownerId,q.requestId))!;if(!result)throw new Fault('NOT_FOUND');
     scope(b,{...result.result,currentVersion:result.result.version},q.ownerId);
    }else if(op==='types.get'){result=(await r.profile(q.type))!;if(!result)throw new Fault('UNSUPPORTED_PROFILE');}
    else if(op.endsWith('.get')){
     const kind=op.startsWith('connections')?'connection':'channel',id=kind==='connection'?q.connectionId:q.channelId;
     const e=scope(b,kind==='connection'?await r.connection(id):await r.channel(id),q.ownerId);
     result=(await r.version(kind,e.id,q.version??e.currentVersion))!;if(!result)throw new Fault('NOT_FOUND');
    }else{
     const kind=op==='types.list'?'profile':op==='connections.list'?'connection':'channel';
     if(q.connectionId)scope(b,await r.connection(q.connectionId),q.ownerId);
     const cursorScope={op,callerId,ownerId:q.ownerId??null,connectionId:q.connectionId??null},after=decodeCursor(cursorKey,cursorScope,q.cursor);
     const rows=await r.list(kind,q.ownerId,b.connectionIds,after,q.limit+1,q.connectionId),items:Data[]=[];let nextCursor:string|null=null;
     for(const row of rows){
      if(items.length===q.limit)break;
      const candidate={items:[...items,row],nextCursor:encodeCursor(cursorKey,cursorScope,kind==='profile'?row.type.code+'/'+row.type.version:row.id)};
      if(Buffer.byteLength(JSON.stringify(candidate))>131072){if(!items.length)throw new Fault('RESPONSE_TOO_LARGE');break;}items.push(row);
     }
     if(rows.length>items.length&&items.length){const last=items.at(-1)!;nextCursor=encodeCursor(cursorKey,cursorScope,kind==='profile'?last.type.code+'/'+last.type.version:last.id);}
     result={items,nextCursor};
    }
    response(op,result);return result;
   });
  }
 };
}
