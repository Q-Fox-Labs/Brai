// ABOUTME: Содержит сценарии регистрации и ручного разбора наблюдений.
// ABOUTME: Ядро зависит только от предметных портов и не знает транспорт или SQL.
import { Fault, limits, validate, type Operation, type Principal, type ReportInput, type ReviewInput, type GetInput, type ListInput } from "./contracts.js";

export interface Store {
 report(principal:Principal,input:ReportInput,validateNew:()=>Promise<void>):Promise<unknown>;
 review(principal:Principal,input:ReviewInput):Promise<unknown>;
 get(principal:Principal,input:GetInput):Promise<unknown>;
 list(principal:Principal,input:ListInput,operator:boolean):Promise<unknown>;
 status():Promise<unknown>;
}
export interface Dependencies {
 store:Store;
 evidence(ownerId:string,artifactIds:string[]):Promise<void>;
}
/** Проверяет допустимый ручной переход; архивирование не является проверкой дефекта. */
export function assertReviewTransition(previous:string,next:string):void {
 const allowed:Record<string,string[]>={new:["triaged","archived"],triaged:["archived"],archived:["new"]};
 if(!allowed[previous]?.includes(next))throw new Fault("INVALID_ARGUMENT");
}
/** Создаёт единственное ядро для MCP, Web и доверенного broker. */
export function createHandlers({store,evidence}:Dependencies) {
 return {
  async invoke(operation:Operation,principal:Principal,input:unknown,operator=false):Promise<unknown> {
   validate(operation,input);
   if(!principal.ownerId || !principal.actorId) throw new Fault("UNAUTHENTICATED");
   if((operator||operation==="review"||operation==="status")&&!principal.reviewer) throw new Fault("FORBIDDEN");
   let value:unknown;
   if(operation==="report") {
    const report=input as ReportInput;
    // Проверка доказательств находится в транзакционном порту после поиска replay:
    // старую квитанцию можно прочитать, даже если доказательство позднее удалено.
    value=await store.report(principal,report,async()=>{const ids=report.observation.evidence_artifact_ids??[];if(ids.length)await evidence(principal.ownerId,ids);});
   }
   else if(operation==="review") value=await store.review(principal,input as ReviewInput);
   else if(operation==="get") value=await store.get(principal,input as GetInput);
   else if(operation==="list") value=await store.list(principal,input as ListInput,operator);
   else value=await store.status();
   if(Buffer.byteLength(JSON.stringify(value))>limits.responseBytes-4096)throw new Fault("RESULT_TOO_LARGE",operation==="report"||operation==="review"?"unknown":"not_accepted");
   return value;
  },
 };
}
export type Handlers=ReturnType<typeof createHandlers>;
