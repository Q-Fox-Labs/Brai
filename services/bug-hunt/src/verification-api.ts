// ABOUTME: Проверяет закрытые DTO v3 и направляет операции в предметное хранилище.
// ABOUTME: Owner и operator scope приходят только из аутентифицированного транспорта.
import {readFileSync} from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {validUnicode,Fault,type Principal} from "./contracts.js";
import {VerificationFault as VF} from "./verification.js";
import type {createVerificationStore} from "./verification-store.js";
const document=JSON.parse(readFileSync(new URL("../schemas/verification-v3.schema.json",import.meta.url),"utf8"));
const ajv=new Ajv.default({strict:true});addFormats.default(ajv);ajv.addSchema(document);
export const verificationOperations=["run-request","get","list","evidence-get","cancel","review"] as const;
export type VerificationOperation=typeof verificationOperations[number];
export const verificationSchemas=Object.fromEntries(Object.entries(document.definitions).map(([name,schema])=>[name,{...schema as object,definitions:document.definitions}])) as Record<string,object>;
/** Отвергает большой или невалидный полный вход до обращения к хранилищу. */
export function validateVerification(op:string,input:unknown){
 if(!["status","pause",...verificationOperations].includes(op)||!validUnicode(input))throw new VF("INVALID_ARGUMENT");
 if(Buffer.byteLength(JSON.stringify(input)??"")>65536)throw new VF("REQUEST_TOO_LARGE");
 if(!ajv.getSchema(document.$id+"#/definitions/"+op)!(input))throw new VF("INVALID_ARGUMENT");
}
/** Выполняет только owner-scoped операции; операторские pause/status имеют отдельные subjects. */
export async function invokeVerification(store:ReturnType<typeof createVerificationStore>,op:VerificationOperation,p:Principal,input:any){
 validateVerification(op,input);
 let value;
 if(op==="run-request")value=await store.request(p,input);
 else if(op==="get")value=await store.get(p,input.investigation_id,input.review_before_revision);
 else if(op==="list")value=await store.list(p,input);
 else if(op==="evidence-get")value=await store.evidence(p,input);
 else if(op==="cancel")value=await store.cancel(p,input);
 else value=await store.review(p,input);
 if(Buffer.byteLength(JSON.stringify(value))>258048)throw new VF("RESULT_TOO_LARGE");
 return value;
}
/** Преобразует сбой в безопасную ошибку, сохраняя неопределённость принятой мутации. */
export function verificationFailure(e:unknown,mutation=false){const known=e instanceof VF||e instanceof Fault;return {code:known?e.code:"INTERNAL",message:known?e.code:"INTERNAL",outcome:known?e.outcome:mutation?"unknown":"not_accepted",retryable:known&&["BUSY","DATABASE_UNAVAILABLE"].includes(e.code)};}
export const verificationTools=[
 {name:"bug_hunt_verification_run",operation:"run-request",description:"Явно запросить проверку своей case/group или ограниченной pending порции. Регистрация наблюдения сама проверку не запускает.",inputSchema:verificationSchemas["run-request"]},
 {name:"bug_hunt_verification_get",operation:"get",description:"Прочитать фактическое состояние, доказательства, вывод и область применимости проверки.",inputSchema:verificationSchemas.get,annotations:{readOnlyHint:true,idempotentHint:true}},
 {name:"bug_hunt_verification_list",operation:"list",description:"Прочитать ограниченную страницу своих расследований.",inputSchema:verificationSchemas.list,annotations:{readOnlyHint:true,idempotentHint:true}},
 {name:"bug_hunt_verification_evidence",operation:"evidence-get",description:"Прочитать разрешённый фрагмент доказательства своей проверки.",inputSchema:verificationSchemas["evidence-get"],annotations:{readOnlyHint:true,idempotentHint:true}}
] as const;
