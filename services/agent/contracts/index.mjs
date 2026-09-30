// ABOUTME: Экспортирует браузерно-безопасную проверку DTO и событий agent.
// ABOUTME: Использует статические JSON-импорты; файловый доступ оставлен генератору и тестам.
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import messagesSchema from '../schemas/messages.schema.json' with { type: 'json' };
import codexSchema from './codex/schema.json' with { type: 'json' };
import { EventSchema } from '@ag-ui/core/schemas';

export { messagesSchema };

/** Subjects внешней границы NATS Services и Core NATS. */
export const subjects = Object.freeze({
  projects:'brai.agent.v1.query.projects', status:'brai.agent.v1.query.status',
  threads:'brai.agent.v1.query.threads', thread:'brai.agent.v1.query.thread',
  history:'brai.agent.v1.query.history', threadCreate:'brai.agent.v1.command.thread.create',
  turnStart:'brai.agent.v1.command.turn.start', turnSteer:'brai.agent.v1.command.turn.steer',
  turnInterrupt:'brai.agent.v1.command.turn.interrupt', requestRespond:'brai.agent.v1.command.request.respond',
  event:'brai.agent.v1.event',
});

/** Ограничения внешнего контракта; реализация сервиса обязана их соблюдать. */
export const limits=Object.freeze({
  loadedThreads:16,activeTurns:4,pendingRpc:64,pendingForms:64,
  uiQueue:64,clients:128,queuePerClient:64,ledgerEntries:4096,
  inputTextBytes:65536,upstreamFrameBytes:2097152,natsSseFrameBytes:1048576,
  snapshotBytes:786432,historyResponseBytes:786432,metadataBytes:65536,
  pendingFormsBytes:131072,pendingFormBytes:32768,readTimeoutMs:10000,mutationAcceptanceTimeoutMs:12000,
});

const ownAjv=new Ajv({allErrors:true,strict:true,coerceTypes:false,useDefaults:false,removeAdditional:false});
addFormats(ownAjv);
const runtimeSchema=structuredClone(messagesSchema);
const replaceExternalRefs=value=>{if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){if(key==='$ref'&&typeof child==='string'&&child.startsWith('https://brai.dev/contracts/codex/schema.json#/definitions/')){delete value.$ref;value.type='object';}else replaceExternalRefs(child);}};
replaceExternalRefs(runtimeSchema.definitions);
const upstreamAjv=new Ajv({allErrors:true,strict:false,validateFormats:false,coerceTypes:false,useDefaults:false,removeAdditional:false});
upstreamAjv.addSchema(codexSchema,'https://brai.dev/contracts/codex/schema.json');
const ownCheck=schema=>ownAjv.compile(schema);
const dtoNames=Object.keys(messagesSchema.definitions).filter(name=>name.endsWith('Request')||name.endsWith('Response')||name==='ThreadSnapshot'||name==='PendingRequest');
const dtoValidators=new Map(dtoNames.map(name=>[name,ownCheck({$schema:messagesSchema.$schema,definitions:runtimeSchema.definitions,$ref:`#/definitions/${name}`})]));
const envelopeValidator=ownCheck({$schema:messagesSchema.$schema,definitions:runtimeSchema.definitions,$ref:'#/definitions/EventEnvelope'});
const customNames={
  'brai.agent.output':'CustomOutput','brai.agent.diff':'CustomDiff',
  'brai.agent.request.opened':'CustomRequestOpened','brai.agent.request.resolved':'CustomRequestResolved',
  'brai.agent.connection':'CustomConnection','brai.agent.truncation':'CustomTruncation',
  'brai.agent.resync-required':'CustomResyncRequired',
};
const customValidators=new Map(Object.entries(customNames).map(([name,def])=>[name,ownCheck({$schema:messagesSchema.$schema,definitions:runtimeSchema.definitions,$ref:`#/definitions/${def}`})]));
const requestResponseNames={
  'command-approval':['CommandExecutionRequestApprovalParams','CommandExecutionRequestApprovalResponse'],
  'file-change-approval':['FileChangeRequestApprovalParams','FileChangeRequestApprovalResponse'],
  permissions:['PermissionsRequestApprovalParams','PermissionsRequestApprovalResponse'],
  question:['ToolRequestUserInputParams','ToolRequestUserInputResponse'],
};
const upstreamValidators=new Map(Object.entries(requestResponseNames).map(([kind,[params,response]])=>[kind,[
  upstreamAjv.compile({$ref:`https://brai.dev/contracts/codex/schema.json#/definitions/${params}`}),
  upstreamAjv.compile({$ref:`https://brai.dev/contracts/codex/schema.json#/definitions/${response}`}),
]]));
const bytes=value=>{try{return new TextEncoder().encode(JSON.stringify(value)).byteLength;}catch{return Infinity;}};
const metadataNames=new Set(['ProjectsResponse','ThreadsResponse']);

/** Проверяет DTO без изменения значения и учитывает UTF-8 размер сериализованного JSON. */
export function validateDto(name,value){
  const check=dtoValidators.get(name);
  if(!check||bytes(value)===Infinity||!check(value))return false;
  const size=bytes(value),cap=name==='ThreadSnapshot'?limits.snapshotBytes:name==='HistoryResponse'?limits.historyResponseBytes:limits.natsSseFrameBytes;
  if(!Number.isFinite(size)||size>cap)return false;
  if(metadataNames.has(name)){
    const list=name==='ProjectsResponse'?value.projects:value.threads;
    if(list.reduce((sum,item)=>sum+bytes(item),0)>limits.metadataBytes)return false;
  }
  if(name==='RequestRespondRequest'&&!upstreamValidators.get(value.kind)?.[1](value.answer))return false;
  if(name==='PendingRequest'&&!validPendingRequest(value))return false;
  if(name==='ThreadSnapshot'){
    if(value.pendingRequests.some(item=>!validPendingRequest(item)))return false;
    if(value.pendingRequests.reduce((sum,item)=>sum+bytes(item),0)>limits.pendingFormsBytes)return false;
    if(!EventSchema.safeParse({type:'MESSAGES_SNAPSHOT',messages:value.messages}).success)return false;
  }
  if((name==='TurnStartRequest'||name==='TurnSteerRequest')&&bytes(value)>limits.inputTextBytes)return false;
  return true;
}

/** Выбрасывает безопасную ошибку без включения входных данных. */
export function assertDto(name,value){if(!validateDto(name,value))throw new TypeError(`Некорректный DTO ${name} или превышен предел размера`);}

/** Проверяет строгий local envelope и реальную схему AG-UI для события. */
export function validateEventEnvelope(value){
  if(!envelopeValidator(value)||bytes(value)>limits.natsSseFrameBytes||!validateAguiEvent(value.event))return false;
  return true;
}

/** Проверяет стандартное или типизированное CUSTOM событие через SDK AG-UI. */
export function validateAguiEvent(event){
  if(!EventSchema.safeParse(event).success)return false;
  if(event.type!=='CUSTOM')return true;
  const check=customValidators.get(event.name);
  if(!check||!check(event.value))return false;
  return event.name!=='brai.agent.request.opened'||validPendingRequest(event.value.request);
}

/** Проверяет ответ по upstream-схеме и ограничениям конкретного ожидающего запроса. */
export function validateUpstreamAnswer(kind,answer,params){
  const pair=upstreamValidators.get(kind);
  if(!pair||!pair[0](params)||!pair[1](answer))return false;
  if(kind==='command-approval'&&Array.isArray(params.availableDecisions)){
    if(!params.availableDecisions.some(decision=>deepEqual(decision,answer.decision)))return false;
  }
  if(kind==='question'){
    const questionIds=new Set(params.questions.map(question=>question.id));
    const answerIds=Object.keys(answer.answers??{});
    if(answerIds.length!==questionIds.size||answerIds.some(id=>!questionIds.has(id)))return false;
  }
  if(kind==='permissions'){
    if(answer.scope!=='turn'||answer.strictAutoReview===true)return false;
    if(!permissionSubset(answer.permissions,params.permissions))return false;
  }
  return true;
}

function validPendingRequest(item){
  if(bytes(item)>limits.pendingFormBytes)return false;
  if(item?.kind==='unsupported')return true;
  return Boolean(upstreamValidators.get(item?.kind)?.[0](item.params));
}

function deepEqual(left,right){
  if(left===right)return true;
  if(!left||!right||typeof left!=='object'||typeof right!=='object')return false;
  if(Array.isArray(left)||Array.isArray(right))return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((value,index)=>deepEqual(value,right[index]));
  const leftKeys=Object.keys(left).sort(),rightKeys=Object.keys(right).sort();
  return leftKeys.length===rightKeys.length&&leftKeys.every((key,index)=>key===rightKeys[index]&&deepEqual(left[key],right[key]));
}

function permissionSubset(granted,requested){
  if(granted===null||granted===undefined)return true;
  if(requested===null||requested===undefined)return false;
  if(typeof granted==='boolean')return !granted||requested===true;
  if(Array.isArray(granted))return Array.isArray(requested)&&granted.every(value=>requested.some(candidate=>deepEqual(value,candidate)));
  if(typeof granted==='object')return Object.entries(granted).every(([key,value])=>permissionSubset(value,requested[key]));
  return granted===requested;
}

/** Возвращает размер JSON в UTF-8; цикл или несериализуемое значение даёт Infinity. */
export function serializedBytes(value){return bytes(value);}
