// ABOUTME: Публикует устойчивый v1 и каталог через NATS Services.
// ABOUTME: Control path имеет отдельные восемь слотов, без ожидания inference.
import type { NatsConnection } from "nats";
import { Failure } from "./core.js";
import { listModels, getModel, catalogVersion } from "./catalog.js";
import { boundedJson, V1_LIMITS, type Operations, type DecideRequest } from "./operations.js";
import { v1Validator } from "./v1-schema.js";
/** Единственный v1 instance; broker ACL должен удостоверять доверенного caller owner. */
export async function registerProvidersV1(nc:NatsConnection,operations:Operations) {
  const service=await nc.services.add({name:"brai_providers_v1",version:"1.0.0",description:"Durable owner scoped operations",queue:"brai_providers_v1"});
  let controls=0;
  const endpoints:[string,string,string,boolean,(input:Record<string,unknown>)=>unknown][]=[
    ["invoke.decide","decideRequest","operation",false,input=>operations.invoke(input as DecideRequest)],
    ["operations.get","operationKey","operation",true,input=>operations.get(input.ownerId as string,input.operationId as string)],
    ["operations.cancel","operationKey","operation",true,input=>operations.cancel(input.ownerId as string,input.operationId as string)],
    ["models.list","modelsListRequest","modelsListResponse",true,()=>({version:catalogVersion,models:listModels()})],
    ["models.get","modelsGetRequest","model",true,input=>{const card=getModel(input.provider as string,input.model as string);if(!card)throw new Failure("NOT_FOUND","not_sent");return card;}],
    ["status","statusRequest","statusResponse",true,()=>operations.status()]
  ];
  for(const [suffix,requestName,responseName,control,handle] of endpoints) {
    const validInput=v1Validator(requestName),validOutput=v1Validator(responseName);
    service.addEndpoint(suffix.replaceAll(".","_"),{subject:`brai.providers.v1.${suffix}`,handler:async(_error,message)=>{
      let held=false;
      try {
        if(message.data.byteLength>(control?2048:V1_LIMITS.requestBytes))throw new Failure("INVALID_REQUEST","not_sent");
        let input:unknown;
        try{input=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(message.data));}catch{throw new Failure("INVALID_REQUEST","not_sent");}
        if(!boundedJson(input) || !validInput(input))throw new Failure("INVALID_REQUEST","not_sent");
        if(control){if(controls>=V1_LIMITS.controlConcurrency)throw new Failure("OVERLOADED","not_sent");controls++;held=true;}
        const result=await handle(input as Record<string,unknown>);
        if(!validOutput(result) || Buffer.byteLength(JSON.stringify(result))>V1_LIMITS.resultBytes+8192)throw new Failure("UPSTREAM_PROTOCOL","unknown");
        message.respond(JSON.stringify(result));
      } catch(error) {
        const safe=error instanceof Failure?error:new Failure("STORAGE_UNAVAILABLE","not_sent");
        message.respondError(500,safe.code,new TextEncoder().encode(JSON.stringify({code:safe.code,outcome:safe.outcome})));
      } finally {if(held)controls--;}
    }});
  }
  return service;
}
