// ABOUTME: Подключает модельные порты к NATS Services и схемам владельцев.
// ABOUTME: Не повторяет invoke и не обращается к модельным runtime напрямую.
import {readFileSync} from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type {NatsConnection} from "nats";
import {ModelFault,type EmbeddingPort,type ClassifierPort} from "./processing.js";
const encoder=new TextEncoder(),decoder=new TextDecoder();
function validators(path:string,names:string[]){
 const document=JSON.parse(readFileSync(new URL(path,import.meta.url),"utf8"));
 const ajv=new Ajv.default({strict:false,allErrors:false});addFormats.default(ajv);
 ajv.addFormat("rfc3339-microseconds",{type:"string",validate:(value:string)=>/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)&&Number.isFinite(Date.parse(value))});
 const base="urn:bug-hunt:"+path.replace(/[^a-z0-9]/gi,"-");
 ajv.addSchema({...document,$id:base},base);
 return Object.fromEntries(names.map(name=>[name,ajv.compile({$ref:base+"#/definitions/"+name})]));
}
const local=validators("../../local-ai/schemas/messages.schema.json",["EmbedRequest","EmbedResponse","ErrorResponse"]);
const providers=validators("../../providers/schemas/v1.schema.json",["decideRequest","operation","operationKey","error"]);
/** Создаёт ограниченные NATS-порты; схемы берутся только у владельцев API. */
export function createModelPorts(options:{connection:NatsConnection;timeoutMs?:number}):{embedding:EmbeddingPort;classifier:ClassifierPort}{
 const timeout=Math.max(1000,Math.min(options.timeoutMs??35000,40000));
 async function call(subject:string,body:unknown,invoke:boolean,kind:"embed"|"decide"|"get"):Promise<unknown>{
  const validate=kind==="embed"?local.EmbedRequest:kind==="decide"?providers.decideRequest:providers.operationKey;
  const request=encoder.encode(JSON.stringify(body));
  if(request.byteLength>65536||!validate(body))throw new ModelFault("INVALID_REQUEST","not_sent");
  let reply;
  try{reply=await options.connection.request(subject,request,{timeout});}catch{throw new ModelFault(invoke?"MODEL_OUTCOME_UNKNOWN":"MODEL_STATUS_UNAVAILABLE");}
  if(reply.data.byteLength>262144)throw new ModelFault("MODEL_RESULT_TOO_LARGE");
  let value:any;try{value=JSON.parse(decoder.decode(reply.data));}catch{throw new ModelFault("MODEL_PROTOCOL");}
  if(reply.headers?.has("Nats-Service-Error")||reply.headers?.has("Nats-Service-Error-Code")){
   if(!(kind==="embed"?local.ErrorResponse:providers.error)(value))throw new ModelFault("MODEL_PROTOCOL");
   const error=value as {code:string;outcome?:string};
   const code=error.code;
   // AIDEV-NOTE: Только документированные отказы до приёма получают not_sent.
   const outcome=error.outcome==="not_sent"?"not_sent":kind==="embed"&&["BUSY","INVALID_ARGUMENT","MODEL_NOT_FOUND","MODEL_NOT_INSTALLED","UNSUPPORTED_OPERATION","INPUT_TOO_LARGE"].includes(code)?"not_sent":error.outcome==="failed"?"failed":"unknown";
   throw new ModelFault(code,outcome);
  }
  if(!(kind==="embed"?local.EmbedResponse:providers.operation)(value))throw new ModelFault("MODEL_PROTOCOL");
  return value;
 }
 return {
  embedding:{invoke:body=>call("brai.local_ai.v1.invoke.embed",body,true,"embed")},
  classifier:{invoke:body=>call("brai.providers.v1.invoke.decide",body,true,"decide"),get:(ownerId,operationId)=>call("brai.providers.v1.operations.get",{ownerId,operationId},false,"get")},
 };
}
