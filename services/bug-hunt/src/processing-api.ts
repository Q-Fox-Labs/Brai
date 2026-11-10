// ABOUTME: Открывает оператору состояние, паузу, retry и проверенную активацию поколения.
// ABOUTME: Доверие задаёт точный NATS ACL; предметный JSON не назначает owner или полномочия.
import {readFileSync} from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {validUnicode,type Principal} from "./contracts.js";
import {SystemFault} from "./system-contracts.js";
export const processingOperations=["status","pause","retry","activate-generation"] as const;
export type ProcessingOperation=typeof processingOperations[number];
const schema=JSON.parse(readFileSync(new URL("../schemas/processing-v2.schema.json",import.meta.url),"utf8"));
const ajv=new Ajv.default({strict:true});addFormats.default(ajv);ajv.addSchema(schema);
interface OperatorStore {
 activateGeneration(p:Principal,input:{request_id:string;generation:string;expected_active_generation:string;reason:string}):Promise<unknown>;
 processingStatus(p:Principal):Promise<unknown>;
 pause(p:Principal,input:{request_id:string;paused:boolean;reason:string}):Promise<unknown>;
 retryUnknown(p:Principal,input:{request_id:string;job_id:string;business_attempt_id:string;reason:string}):Promise<unknown>;
}
/** Выполняется исключительно на operator-only subject без пользовательского context. */
export async function invokeProcessing(store:OperatorStore,operation:ProcessingOperation,value:unknown) {
 if(!processingOperations.includes(operation))throw new SystemFault("FORBIDDEN");
 if(Buffer.byteLength(JSON.stringify(value))>65536)throw new SystemFault("REQUEST_TOO_LARGE");
 if(!validUnicode(value)||!ajv.getSchema(schema.$id+"#/definitions/"+operation)!(value))throw new SystemFault("INVALID_ARGUMENT");
 const principal:Principal={ownerId:"operator",actorId:"nats:operator",source:"codex",reviewer:true};
 const result=operation==="status"?await store.processingStatus(principal):operation==="pause"?await store.pause(principal,value as any):operation==="retry"?await store.retryUnknown(principal,value as any):await store.activateGeneration(principal,value as any);
 if(Buffer.byteLength(JSON.stringify(result))>262144-4096)throw new SystemFault("RESULT_TOO_LARGE",operation==="status"?"not_accepted":"unknown");
 if(!validUnicode(result)||!ajv.getSchema(schema.$id+"#/definitions/"+operation+"Response")!(result))throw new SystemFault("INTERNAL",operation==="status"?"not_accepted":"unknown");
 return result;
}
