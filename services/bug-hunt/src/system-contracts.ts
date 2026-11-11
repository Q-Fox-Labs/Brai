// ABOUTME: Задаёт закрытые v2 DTO и единое транспортно-независимое ядро систематизации.
// ABOUTME: Не меняет v1 Fault и не допускает область владельца в предметном входе.
import {readFileSync} from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {Fault,codes,validUnicode,type Principal} from "./contracts.js";

export const systemOperations=["search","similar","enrichment","groups-list","groups-get","membership-update","proposal-resolve","classification-override"] as const;
export type SystemOperation=typeof systemOperations[number];
export type SystemFaultCode=typeof codes[number]|"CURSOR_STALE"|"INDEX_NOT_READY"|"PROCESSING_PENDING";
/** Безопасная v2 ошибка; unknown требует повтора прежнего request_id. */
export class SystemFault extends Error {
 constructor(public code:SystemFaultCode,public outcome:"not_accepted"|"unknown"="not_accepted"){super(code);}
}
const document=JSON.parse(readFileSync(new URL("../schemas/v2.schema.json",import.meta.url),"utf8"));
const ajv=new Ajv.default({strict:true,allErrors:false});addFormats.default(ajv);ajv.addSchema(document);
export const systemSchemas=Object.fromEntries(systemOperations.map(op=>[op,document.definitions[op]])) as Record<SystemOperation,object>;
export const systemResponseSchemas=Object.fromEntries(systemOperations.map(op=>[op,document.definitions[op+"Response"]])) as Record<SystemOperation,object>;
const check=(name:string,value:unknown)=>ajv.getSchema(document.$id+"#/definitions/"+name)!(value);
/** Валидирует полный вход, Unicode и 64 КиБ UTF-8 без молчаливого усечения. */
export function validateSystem(operation:SystemOperation,value:unknown):void {
 let raw:string|undefined;try{raw=JSON.stringify(value);}catch{throw new SystemFault("INVALID_ARGUMENT");}
 if(!raw)throw new SystemFault("INVALID_ARGUMENT");
 if(Buffer.byteLength(raw)>65536)throw new SystemFault("REQUEST_TOO_LARGE");
 if(!systemOperations.includes(operation)||!validUnicode(value)||!check(operation,value))throw new SystemFault("INVALID_ARGUMENT");
}
export interface SystemFilters {review_state?:string;component_id?:string;source?:string;error_code?:string;registered_from?:string;registered_to?:string}
export interface PageInput {cursor?:string;limit?:number}
export interface GroupsListInput extends PageInput {case_id?:string}
export interface SearchInput extends PageInput {query:string;filters?:SystemFilters}
export interface SimilarInput extends PageInput {case_id:string;filters?:SystemFilters}
export interface GroupRevision {group_id:string;revision:number}
export interface MembershipInput {request_id:string;case_ids:string[];target_group_id?:string|null;expected_revisions:GroupRevision[];explanation:string;exclude_from_auto?:boolean}
export interface Labels {suspected_type?:string;suspected_impact?:string}
export interface OverrideInput {request_id:string;case_id:string;expected_revision:number;labels:Labels;explanation:string}
export interface ProposalInput {request_id:string;proposal_id:string;decision:"accepted"|"rejected";expected_revisions:GroupRevision[];explanation:string}
export interface SystemStore {
 search(p:Principal,input:SearchInput):Promise<unknown>;
 similar(p:Principal,input:SimilarInput):Promise<unknown>;
 enrichment(p:Principal,input:{case_id:string}):Promise<unknown>;
 groupsList(p:Principal,input:GroupsListInput):Promise<unknown>;
 groupsGet(p:Principal,input:PageInput&{group_id:string;history_cursor?:string;history_limit?:number}):Promise<unknown>;
 membershipUpdate(p:Principal,input:MembershipInput):Promise<unknown>;
 resolveProposal(p:Principal,input:ProposalInput):Promise<unknown>;
 classificationOverride(p:Principal,input:OverrideInput):Promise<unknown>;
 status(p?:Principal):Promise<unknown>;
}
/** Проверяет вход, полномочия и закрытый ответ для NATS, Web и MCP. */
export async function invokeSystem(store:SystemStore,operation:SystemOperation,p:Principal,input:unknown):Promise<unknown>{
 validateSystem(operation,input);
 if(!p.ownerId||!p.actorId)throw new SystemFault("UNAUTHENTICATED");
 const mutation=["membership-update","proposal-resolve","classification-override"].includes(operation);
 if(mutation&&!p.reviewer)throw new SystemFault("FORBIDDEN");
 let result:unknown;
 switch(operation){
 case "search":result=await store.search(p,input as SearchInput);break;
 case "similar":result=await store.similar(p,input as SimilarInput);break;
 case "enrichment":result=await store.enrichment(p,input as {case_id:string});break;
 case "groups-list":result=await store.groupsList(p,input as GroupsListInput);break;
 case "groups-get":result=await store.groupsGet(p,input as PageInput&{group_id:string});break;
 case "membership-update":result=await store.membershipUpdate(p,input as MembershipInput);break;
 case "proposal-resolve":result=await store.resolveProposal(p,input as ProposalInput);break;
 case "classification-override":result=await store.classificationOverride(p,input as OverrideInput);break;
 }
 if(Buffer.byteLength(JSON.stringify(result))>262144-4096)throw new SystemFault("RESULT_TOO_LARGE",mutation?"unknown":"not_accepted");
 if(!validUnicode(result)||!check(operation+"Response",result))throw new SystemFault("INTERNAL",mutation?"unknown":"not_accepted");
 return result;
}
/** Возвращает только закрытые коды без SQL, наблюдения или upstream body. */
export function systemFailure(error:unknown,mutation=false){
 const fault=error instanceof SystemFault?error:error instanceof Fault?new SystemFault(error.code,error.outcome):new SystemFault("INTERNAL",mutation?"unknown":"not_accepted");
 return {code:fault.code,message:fault.code,outcome:fault.outcome,retryable:["BUSY","DATABASE_UNAVAILABLE","DEPENDENCY_UNAVAILABLE","DEADLINE_EXCEEDED","INDEX_NOT_READY","PROCESSING_PENDING"].includes(fault.code)};
}
