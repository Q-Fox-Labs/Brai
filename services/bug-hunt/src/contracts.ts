// ABOUTME: Определяет закрытые DTO и пределы операций bug-hunt.
// ABOUTME: Не принимает владельца или полномочия в предметных аргументах.
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";

export const limits = { requestBytes: 65536, responseBytes: 262144, page: 20, maxPage: 50, active: 8, queue: 16, deadlineMs: 10000 } as const;
const schemaDocument=JSON.parse(readFileSync(new URL("../schemas/messages.schema.json", import.meta.url), "utf8"));
export const schemas = schemaDocument.definitions as Record<"report"|"get"|"list"|"review"|"status", object>;
export type Operation = keyof typeof schemas;
export type ReviewState = "new" | "triaged" | "archived";
export type Source = "codex" | "hermes" | "web";
export interface Principal { ownerId: string; actorId: string; source: Source; reviewer: boolean }
export interface Observation {
 title:string; operation:string; expected:string; observed:string; component_id?:string;
 steps?:string|null; component_version?:string|null; commit_sha?:string|null; deployment_revision?:string|null;
 error_code?:string|null; diagnostic_text?:string|null; client_occurred_at?:string|null;
 run_id?:string|null; conversation_ref?:string|null; supersedes_report_id?:string|null; evidence_artifact_ids?:string[];
}
export interface ReportInput {request_id:string;observation:Observation}
export interface ReviewInput {request_id:string;case_id:string;expected_revision:number;review_state:ReviewState;explanation:string}
export interface ListInput {cursor?:string;limit?:number;filters?:{review_state?:ReviewState;component_id?:string;source?:Source;registered_from?:string;registered_to?:string}}
export interface GetInput {case_id:string;cursor?:string;limit?:number}
export const codes = ["INVALID_ARGUMENT","REQUEST_TOO_LARGE","RESULT_TOO_LARGE","UNAUTHENTICATED","FORBIDDEN","NOT_FOUND","IDEMPOTENCY_CONFLICT","REVISION_CONFLICT","BUSY","DATABASE_UNAVAILABLE","DEPENDENCY_UNAVAILABLE","DEADLINE_EXCEEDED","INTERNAL"] as const;
export type FaultCode = typeof codes[number];
/** Ошибка контракта без исходного SQL или пользовательского текста. */
export class Fault extends Error {
 constructor(public code:FaultCode, public outcome:"not_accepted"|"unknown" = "not_accepted") { super(code); }
}
const ajv = new Ajv.default({allErrors:false,strict:true});
addFormats.default(ajv);
ajv.addSchema(schemaDocument);
const validators = Object.fromEntries(["report","get","list","review","status"].map(name=>[name,ajv.getSchema(schemaDocument.$id+"#/definitions/"+name)!]));
/** Проверяет Unicode рекурсивно, включая ключи; отвергает NUL и непарные surrogate. */
export function validUnicode(value: unknown): boolean {
 if(typeof value==="string") return !/[\u0000]/u.test(value) && !/[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g,""));
 if(Array.isArray(value)) return value.every(validUnicode);
 if(value && typeof value==="object") return Object.entries(value).every(([k,v])=>validUnicode(k)&&validUnicode(v));
 return true;
}
/** Валидирует весь запрос без усечения и без допуска дополнительных полей. */
export function validate(operation:Operation, value:unknown):void {
 let raw:string;try {raw=JSON.stringify(value);}catch {throw new Fault("INVALID_ARGUMENT");}
 if(!raw || Buffer.byteLength(raw)>limits.requestBytes) throw new Fault("REQUEST_TOO_LARGE");
 if(!validUnicode(value)||!validators[operation](value)) throw new Fault("INVALID_ARGUMENT");
}
/** Канонический предметный JSON: порядок ключей не влияет на ключ повтора. */
export function canonical(value:unknown):string {
 if(Array.isArray(value)) return "["+value.map(canonical).join(",")+"]";
 if(value && typeof value==="object") return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical((value as Record<string,unknown>)[k])).join(",")+"}";
 return JSON.stringify(value);
}
/** Возвращает только закрытый безопасный DTO ошибки. */
export function failure(error:unknown, mutation=false) {
 const fault=error instanceof Fault?error:new Fault("INTERNAL",mutation?"unknown":"not_accepted");
 return {code:fault.code,message:fault.code,outcome:fault.outcome,retryable:["BUSY","DATABASE_UNAVAILABLE","DEPENDENCY_UNAVAILABLE","DEADLINE_EXCEEDED"].includes(fault.code)};
}
