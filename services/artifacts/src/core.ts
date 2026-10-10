// ABOUTME: Реализует жизненный цикл artifacts через явные порты хранения.
// ABOUTME: Не зависит от PostgreSQL, файловой системы и транспорта.
import {randomUUID,randomBytes} from "node:crypto";
import type {Artifact, ArtifactReference, ReferenceScope, ReferenceQueryScope, ReferenceAttachment, ArtifactOutputBinding, OutputBindRequest, OutputQueryScope} from "../contracts/index.mjs";
import type {ArtifactsStore,ArtifactFiles,StoreSession,ArtifactRecord,Metadata,ListInput,LinkRecord,StoreItems} from "./ports.js";
import {ArtifactError,storageError} from "./errors.js";
export type CoreConfig={uploadBaseURL:string;internalBaseURL:string;externalBaseURL?:string;maxUploadBytes:number;staleTempAgeMs:number;maxResultBytes?:number;maxPageSize?:number;maxReferenceItems?:number;maxReferenceAttachments?:number;maxRelations?:number;reconcileBatchSize?:number};
export type CoreOptions={store:ArtifactsStore;files:ArtifactFiles;config:CoreConfig;now?:()=>number};
type PrepareInput={requestId:string;ownerId:string;kind:Artifact["kind"];metadata:Metadata};
type ReserveInput={scope:ReferenceScope;clientUserMessageId:string;commandHash:string;attachments:ReferenceAttachment[]};
const key=(id:string)=>`artifact:${id.toLowerCase()}`;
const scopeKey=(scope:ReferenceScope)=>`reference:${JSON.stringify([scope.ownerId,scope.projectId,scope.threadId,scope.operationId])}`;
const canonical=(value:unknown):string=>JSON.stringify(value,(_,v)=>v && typeof v==="object" && !Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const conflict=()=>new ArtifactError("CONFLICT");
function timestamp(value:string) {if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,19)!==value.slice(0,19))throw new ArtifactError("INVALID_ARGUMENT");}
const isUuid=(v:unknown):v is string=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
function localInput(operation:string,value:unknown,limits:{page?:number;items?:number;attachments?:number}) {
  const fail=()=>{throw new ArtifactError("INVALID_ARGUMENT");};
  const str=(v:unknown,max=256)=>{if(typeof v!=="string"||!v.trim())fail();let length=0;for(const _ of v as string)if(++length>max)fail();};
  const uuid=(v:unknown)=>{if(!isUuid(v))fail();};
  const object=(v:unknown):any=>{if(!v||typeof v!=="object"||Array.isArray(v))fail();return v;};
  const input=object(value);
  const scope=(v:unknown,operationId=true)=>{const s=object(v);str(s.ownerId,128);str(s.projectId);str(s.threadId);if(operationId)str(s.operationId);};
  const metadata=(v:unknown,patch=false)=>{
    const m=object(v),allowed=["title","filename","extension","mimeType","source","geotag","materialCreatedAt","details"];
    if(!Object.keys(m).length||Object.keys(m).some(k=>!allowed.includes(k)))fail();
    for(const [field,max] of [["title",512],["filename",1024],["mimeType",255],["source",128]] as const)if(!patch||m[field]!==undefined)str(m[field],max);
    if(!patch||m.extension!==undefined){if(typeof m.extension!=="string"||m.extension.length>32||!/^[a-zA-Z0-9._-]*$/.test(m.extension))fail();}
    for(const k of ["geotag","details"])if(m[k]!==undefined)object(m[k]);
    if(!patch&&m.materialCreatedAt===null)fail();
    if(m.materialCreatedAt!==undefined&&m.materialCreatedAt!==null){if(typeof m.materialCreatedAt!=="string")fail();timestamp(m.materialCreatedAt);}
  };
  if(["prepare","update","delete","relationAdd","relationRemove","linkCreate","linkRevoke"].includes(operation))str(input.requestId);
  if(["get","update","delete","relationList","linkCreate"].includes(operation))uuid(input.artifactId);
  switch(operation){
    case "prepare":str(input.ownerId,128);if(!["original","copy"].includes(input.kind))fail();metadata(input.metadata);break;
    case "update":metadata(input.metadata,true);break;
    case "list":{const f=object(input.filter);str(f.ownerId,128);if(f.kind!==undefined&&!["original","copy"].includes(f.kind)||f.status!==undefined&&!["pending","ready","deleting","deleted","failed"].includes(f.status))fail();if(f.source!==undefined)str(f.source,128);if(!["createdAt","sizeBytes"].includes(input.sort)||!["asc","desc"].includes(input.order)||!Number.isSafeInteger(input.limit)||input.limit<1||!Number.isSafeInteger(input.offset)||input.offset<0)fail();if(limits.page!==undefined&&input.limit>limits.page)throw new ArtifactError("PAYLOAD_TOO_LARGE");break;}
    case "stats":str(input.ownerId,128);break;
    case "relationAdd":case "relationRemove":uuid(input.modelArtifactId);uuid(input.originalArtifactId);break;
    case "referenceReserve":scope(input.scope);str(input.clientUserMessageId);if(typeof input.commandHash!=="string"||!/^[0-9a-f]{64}$/.test(input.commandHash))fail();if(!Array.isArray(input.attachments))fail();if(limits.attachments!==undefined&&input.attachments.length>limits.attachments)throw new ArtifactError("PAYLOAD_TOO_LARGE");for(const a of input.attachments){object(a);uuid(a.originalArtifactId);uuid(a.modelArtifactId);}break;
    case "outputBind":scope(input,false);str(input.turnId);str(input.itemId);if(!Array.isArray(input.artifactIds)||!input.artifactIds.length)fail();for(const id of input.artifactIds)uuid(id);if(new Set(input.artifactIds.map((id:string)=>id.toLowerCase())).size!==input.artifactIds.length)fail();break;
    case "outputList":scope(input,false);if(!Array.isArray(input.itemIds))fail();for(const id of input.itemIds)str(id);break;
    case "referenceGet":scope(input.scope);break;
    case "referenceConfirm":scope(input.scope);str(input.clientUserMessageId);str(input.turnId);str(input.itemId);break;
    case "referenceUpdateState":scope(input.scope);if(!["unknown","not-sent"].includes(input.state))fail();break;
    case "referenceList":scope(input.scope,false);if(!Array.isArray(input.nativeItemIds))fail();if(limits.items!==undefined&&input.nativeItemIds.length>limits.items)throw new ArtifactError("PAYLOAD_TOO_LARGE");for(const id of input.nativeItemIds)str(id);break;
    case "linkCreate":if(input.expiresAt!==undefined){if(typeof input.expiresAt!=="string")fail();timestamp(input.expiresAt);}break;
    case "linkRevoke":str(input.linkId);break;
    case "get":case "delete":case "relationList":break;
    default:fail();
  }
}
/** Собирает прикладные операции; config уже проверена процессом сборки. */
export function createArtifactsCore({store,files,config,now=Date.now}:CoreOptions) {
  if(!Number.isSafeInteger(config.maxUploadBytes)||config.maxUploadBytes<0||config.maxUploadBytes>2*1024*1024*1024||!Number.isFinite(config.staleTempAgeMs)||config.staleTempAgeMs<0)throw new ArtifactError("INVALID_ARGUMENT");
  const limits={page:config.maxPageSize,items:config.maxReferenceItems,attachments:config.maxReferenceAttachments,relations:config.maxRelations,batch:config.reconcileBatchSize??100};
  const maxResultBytes=config.maxResultBytes??1048576;
  if([...Object.values(limits),maxResultBytes].some(v=>v!==undefined&&(!Number.isSafeInteger(v)||v<1)))throw new ArtifactError("INVALID_ARGUMENT");
  const resultBytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
  async function collect<T,U>(source:StoreItems<T>,map:(value:T)=>U,envelope:Record<string,unknown>,maxItems?:number,field="items"):Promise<U[]> {
    const items:U[]=[];let bytes=resultBytes({...envelope,[field]:[]});
    // AIDEV-NOTE: Бюджет проверяется по каждому DTO; return iterator закрывает PG cursor при переполнении.
    for await(const value of source){const item=map(value);bytes+=resultBytes(item)+(items.length?1:0);if(bytes>maxResultBytes||maxItems!==undefined&&items.length>=maxItems)throw new ArtifactError("PAYLOAD_TOO_LARGE");items.push(item);}
    return items;
  }
  const date=()=>new Date(now()).toISOString();
  const token=()=>randomBytes(32).toString("base64url");
  const base=(url:string)=>url.replace(/\/$/,"");
  const view=(record:ArtifactRecord):Artifact=>{
    const artifact={...record.artifact};delete artifact.internalUrl;
    if(artifact.status==="ready")artifact.internalUrl=base(config.internalBaseURL)+"/files/"+artifact.artifactId;
    return artifact;
  };
  async function locked<T>(keys:string[],work:(session:StoreSession,signal:AbortSignal)=>Promise<T>,tryOnly=false):Promise<T|undefined> {
    try{return await store.withLocks(keys,work,tryOnly);}catch(error){throw storageError(error);}
  }
  async function required(session:StoreSession,id:string) {const record=await session.artifact(id);if(!record)throw new ArtifactError("NOT_FOUND");return record;}
  async function ready(session:StoreSession,id:string,owner?:string) {const record=await required(session,id);if(record.artifact.status!=="ready"||owner!==undefined&&record.artifact.ownerId!==owner)throw conflict();return record;}
  async function save(session:StoreSession,record:ArtifactRecord) {record.artifact.updatedAt=date();await session.saveArtifact(record);}
  async function prepare(input:PrepareInput) {
    return locked([`prepare:${input.requestId}`],async session=>{
      const before=await session.prepared(input.requestId);
      const prepareInput={ownerId:input.ownerId,kind:input.kind,metadata:input.metadata};
      if(before){if(canonical(before.prepareInput)!==canonical(prepareInput))throw conflict();return {artifact:view(before),uploadUrl:base(config.uploadBaseURL)+"/upload/"+before.uploadToken};}
      const record:ArtifactRecord={artifact:{artifactId:randomUUID(),ownerId:input.ownerId,requestId:input.requestId,kind:input.kind,status:"pending",...input.metadata,sizeBytes:null,sha256:null,createdAt:date(),updatedAt:date()},prepareInput,uploadToken:token()};
      await session.saveArtifact(record,true);
      return {artifact:view(record),uploadUrl:base(config.uploadBaseURL)+"/upload/"+record.uploadToken};
    });
  }
  async function get(id:string) {return locked([],async session=>view(await required(session,id)));}
  async function update(input:{artifactId:string;metadata:Omit<Partial<Metadata>,"materialCreatedAt">&{materialCreatedAt?:string|null}}) {
    return locked([key(input.artifactId)],async session=>{
      const record=await required(session,input.artifactId);
      if(record.artifact.status==="deleting"||record.artifact.status==="deleted")throw conflict();
      const patch={...input.metadata};delete patch.materialCreatedAt;
      Object.assign(record.artifact,patch);
      if(input.metadata.materialCreatedAt===null)delete record.artifact.materialCreatedAt;
      else if(input.metadata.materialCreatedAt!==undefined)record.artifact.materialCreatedAt=input.metadata.materialCreatedAt;
      await save(session,record);return view(record);
    });
  }
  async function remove(id:string) {
    return locked([key(id)],async session=>{
      const record=await required(session,id);
      if(record.artifact.status==="deleted")return view(record);
      if(record.artifact.status!=="ready"&&record.artifact.status!=="deleting")throw conflict();
      if(record.artifact.status==="ready"){record.artifact.status="deleting";delete record.artifact.internalUrl;await save(session,record);}
      // AIDEV-NOTE: deleting фиксируется до unlink, чтобы разрешения закрылись сразу.
      await files.remove(record.artifact.artifactId);
      record.artifact.status="deleted";record.artifact.deletedAt=date();await save(session,record);return view(record);
    });
  }
  async function relation(input:{modelArtifactId:string;originalArtifactId:string},add:boolean) {
    return locked([key(input.modelArtifactId),key(input.originalArtifactId)],async session=>{
      const model=await required(session,input.modelArtifactId), original=await required(session,input.originalArtifactId);
      if(model.artifact.ownerId!==original.artifact.ownerId||model.artifact.kind!=="copy"||original.artifact.kind!=="original")throw conflict();
      const existing=await session.relation(model.artifact.artifactId,original.artifact.artifactId);
      const relation=existing??{modelArtifactId:model.artifact.artifactId,originalArtifactId:original.artifact.artifactId,createdAt:date()};
      if(add){if(model.artifact.status!=="ready"||original.artifact.status!=="ready")throw conflict();if(!existing)await session.saveRelation(relation);}
      else await session.removeRelation(relation.modelArtifactId,relation.originalArtifactId);
      return {relation};
    });
  }
  async function reserve(input:ReserveInput) {
    const ids=input.attachments.flatMap(a=>[a.originalArtifactId,a.modelArtifactId]);
    return locked([scopeKey(input.scope),...ids.map(key)],async session=>{
      const existing=await session.reference(input.scope);
      if(existing){if(existing.clientUserMessageId!==input.clientUserMessageId||existing.commandHash!==input.commandHash||canonical(existing.attachments)!==canonical(input.attachments))throw conflict();return {created:false,reference:existing};}
      for(const id of [...new Set(ids)])await ready(session,id,input.scope.ownerId);
      const reference:ArtifactReference={...input,state:"pending",createdAt:date(),updatedAt:date()};await session.saveReference(reference,true);
      return {created:true,reference};
    });
  }
  async function referenceMutation(input:{scope:ReferenceScope;clientUserMessageId?:string;turnId?:string;itemId?:string;state?:"unknown"|"not-sent"}) {
    return locked([scopeKey(input.scope)],async session=>{
      const reference=await session.reference(input.scope);if(!reference)throw new ArtifactError("NOT_FOUND");
      if(input.state){if(reference.state==="confirmed")throw conflict();reference.state=input.state;}
      else {
        if(reference.clientUserMessageId!==input.clientUserMessageId)throw conflict();
        if(reference.state==="confirmed"&&(reference.turnId!==input.turnId||reference.itemId!==input.itemId))throw conflict();
        reference.state="confirmed";reference.turnId=input.turnId!;reference.itemId=input.itemId!;
      }
      reference.updatedAt=date();await session.saveReference(reference);return {reference};
    });
  }
  async function bindOutput(input:OutputBindRequest) {
    const normalized={ownerId:input.ownerId,projectId:input.projectId,threadId:input.threadId,turnId:input.turnId,itemId:input.itemId,artifactIds:input.artifactIds.map(id=>id.toLowerCase())};
    const bindingKey=`output:${JSON.stringify([input.ownerId,input.projectId,input.threadId,input.itemId])}`;
    return locked([bindingKey,...normalized.artifactIds.map(key)],async session=>{
      const existing=await session.output(normalized,input.itemId);
      // AIDEV-NOTE: Точный повтор не проверяет ready снова: история сохраняется после удаления байтов.
      if(existing){if(existing.turnId!==input.turnId||canonical(existing.artifactIds)!==canonical(normalized.artifactIds))throw conflict();return {binding:existing};}
      for(const id of normalized.artifactIds)await ready(session,id,input.ownerId);
      const binding:ArtifactOutputBinding={...normalized,createdAt:date()};await session.saveOutput(binding);return {binding};
    });
  }
  async function linkCreate(input:{requestId:string;artifactId:string;expiresAt?:string}) {
    if(!config.externalBaseURL)throw new ArtifactError("SHARING_NOT_CONFIGURED");
    return locked([`link-request:${input.requestId}`,key(input.artifactId)],async session=>{
      const existing=await session.requestedLink(input.requestId);
      if(existing){if(existing.link.artifactId.toLowerCase()!==input.artifactId.toLowerCase()||existing.expiresInput!==(input.expiresAt??null))throw conflict();return {link:existing.link};}
      const record=await ready(session,input.artifactId);
      if(input.expiresAt&&Date.parse(input.expiresAt)<=now())throw new ArtifactError("INVALID_ARGUMENT");
      const grantToken=token();
      const grant:LinkRecord={link:{linkId:randomUUID(),artifactId:record.artifact.artifactId,url:base(config.externalBaseURL!)+"/share/"+grantToken,expiresAt:input.expiresAt??null,revokedAt:null},requestId:input.requestId,expiresInput:input.expiresAt??null,token:grantToken};
      await session.saveLink(grant,true);return {link:grant.link};
    });
  }
  /** Обрабатывает локальную операцию; wire-схемы и subject проверяет входной адаптер. */
  async function execute(operation:string,request:unknown):Promise<unknown> {
    localInput(operation,request,limits);
    const input=request as any;
    let result:unknown;
    switch(operation){
      case "prepare":result=await prepare(input);break;
      case "get":result=await get(input.artifactId);break;
      case "update":result=await update(input);break;
      case "delete":result=await remove(input.artifactId);break;
      case "list":result=await locked([],async session=>{const list=await session.list(input as ListInput),envelope={total:list.total,limit:input.limit,offset:input.offset,sort:input.sort,order:input.order};return {...envelope,items:await collect(list.items,artifact=>view({artifact} as ArtifactRecord),envelope)};});break;
      case "stats":result=await locked([],session=>session.stats(input.ownerId));break;
      case "relationAdd":result=await relation(input,true);break;
      case "relationRemove":result=await relation(input,false);break;
      case "relationList":result=await locked([],async session=>{await required(session,input.artifactId);return {items:await collect(await session.relations(input.artifactId),item=>item,{},limits.relations)};});break;
      case "referenceReserve":result=await reserve(input);break;
      case "referenceGet":result=await locked([],async session=>{const reference=await session.reference(input.scope);if(!reference)throw new ArtifactError("NOT_FOUND");return {reference};});break;
      case "referenceConfirm":case "referenceUpdateState":result=await referenceMutation(input);break;
      case "referenceList":result=await locked([],async session=>({items:await collect(await session.references(input.scope as ReferenceQueryScope,input.nativeItemIds),item=>item,{},limits.items)}));break;
      case "outputBind":result=await bindOutput(input);break;
      case "outputList":result=await locked([],async session=>({bindings:await collect(await session.outputs(input as OutputQueryScope,input.itemIds),item=>item,{},undefined,"bindings")}));break;
      case "linkCreate":result=await linkCreate(input);break;
      case "linkRevoke":result=await locked([`link:${input.linkId}`],async session=>{const record=await session.link(input.linkId);if(!record)throw new ArtifactError("NOT_FOUND");record.link.revokedAt??=date();await session.saveLink(record);return {link:record.link};});break;
      default:throw new ArtifactError("INVALID_ARGUMENT");
    }
    if(resultBytes(result)>maxResultBytes)throw new ArtifactError("PAYLOAD_TOO_LARGE");
    return result;
  }
  async function recover(session:StoreSession,record:ArtifactRecord):Promise<"ready"|"failed"|undefined> {
    if(record.artifact.status!=="pending"&&record.artifact.status!=="failed")return;
    if(record.publication){
      const published=await files.inspect(record.artifact.artifactId);
      if(published&&published.sizeBytes===record.publication.sizeBytes&&published.sha256===record.publication.sha256){
        record.artifact.status="ready";record.artifact.sizeBytes=published.sizeBytes;record.artifact.sha256=published.sha256;record.artifact.internalUrl=base(config.internalBaseURL)+"/files/"+record.artifact.artifactId;
        const temp=record.publication.tempName;delete record.publication;await save(session,record);await files.removeTemp(temp);return "ready";
      }
      // AIDEV-NOTE: Неизвестные опубликованные байты не удаляем при сверке.
      const temp=record.publication.tempName;delete record.publication;record.artifact.status="failed";await save(session,record);await files.removeTemp(temp);return "failed";
    }
    if(record.artifact.status==="pending"&&Date.parse(record.artifact.updatedAt)<=now()-config.staleTempAgeMs){record.artifact.status="failed";await save(session,record);return "failed";}
  }
  /** Сохраняет ограниченный поток; успех только после публикации файла и записи ready. */
  async function upload(uploadToken:string,source:AsyncIterable<Uint8Array>,signal?:AbortSignal):Promise<Artifact> {
    const found=await locked([],session=>session.uploading(uploadToken));if(!found)throw new ArtifactError("NOT_FOUND");
    return (await locked([key(found.artifact.artifactId)],async(session,lockSignal)=>{
      const record=await required(session,found.artifact.artifactId);
      await recover(session,record);
      if(record.artifact.status!=="pending"&&record.artifact.status!=="failed")throw conflict();
      const combined=signal?AbortSignal.any([signal,lockSignal]):lockSignal;
      combined.throwIfAborted();
      let publication;
      try{publication=await files.write(record.artifact.artifactId,source,config.maxUploadBytes,combined);}
      catch(error){record.artifact.status="failed";await save(session,record).catch(()=>{});throw error;}
      combined.throwIfAborted();
      record.artifact.status="pending";record.publication=publication;
      // AIDEV-NOTE: Намерение фиксируется до FS; при потерянном commit ответ не считаем успехом.
      await save(session,record);
      combined.throwIfAborted();
      await files.publish(record.artifact.artifactId,publication);
      record.artifact.status="ready";record.artifact.sizeBytes=publication.sizeBytes;record.artifact.sha256=publication.sha256;record.artifact.internalUrl=base(config.internalBaseURL)+"/files/"+record.artifact.artifactId;
      delete record.publication;await save(session,record);return view(record);
    }))!;
  }
  /** Проверяет готовность без выдачи содержимого; неизвестные и неготовые ID закрыты. */
  async function downloadable(artifactId:string):Promise<Artifact> {
    if(!isUuid(artifactId))throw new ArtifactError("NOT_FOUND");
    return (await locked([key(artifactId)],async session=>view(await ready(session,artifactId))))!;
  }
  /** Проверяет отдельное разрешение, срок, отзыв и состояние файла. */
  async function shared(grantToken:string):Promise<Artifact> {
    if(!config.externalBaseURL)throw new ArtifactError("SHARING_NOT_CONFIGURED");
    const found=await locked([],session=>session.shared(grantToken));if(!found)throw new ArtifactError("NOT_FOUND");
    return (await locked([key(found.link.artifactId),`link:${found.link.linkId}`],async session=>{
      const current=await session.link(found.link.linkId);
      if(!current||current.link.revokedAt||current.link.expiresAt&&Date.parse(current.link.expiresAt)<=now())throw new ArtifactError("NOT_FOUND");
      const artifact=await required(session,current.link.artifactId);if(artifact.artifact.status!=="ready")throw new ArtifactError("NOT_FOUND");return view(artifact);
    }))!;
  }
  /** Завершает опубликованные операции и deleting, очищает только просроченные temp. */
  async function reconcile() {
    const result={ready:0,failed:0,deleted:0,temps:0};
    let afterId:string|undefined;
    while(true){
      const unfinished=(await locked([],session=>session.unfinished(afterId,limits.batch)))!;
      if(!unfinished.length)break;
      for(const id of unfinished)await locked([key(id)],async session=>{
        const record=await required(session,id);
        if(record.artifact.status==="deleting"){
          await files.remove(id);record.artifact.status="deleted";record.artifact.deletedAt=date();await save(session,record);result.deleted++;
        }else {const outcome=await recover(session,record);if(outcome)result[outcome]++;}
      },true);
      afterId=unfinished.at(-1);
    }
    for await(const temp of files.staleTemps(now()-config.staleTempAgeMs))await locked([key(temp.artifactId)],async session=>{
      const record=await session.artifact(temp.artifactId);
      if(record?.publication?.tempName===temp.tempName)return;
      await files.removeTemp(temp.tempName);result.temps++;
    },true);
    return result;
  }
  return {execute,upload,downloadable,shared,reconcile};
}
export type ArtifactsCore=ReturnType<typeof createArtifactsCore>;
