// ABOUTME: Проверяет, что веб Goals читает данные только владельца и не отправляет изменения.
// ABOUTME: Использует подменённый транспорт без обращения к личным данным.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

class GatewayError extends Error {
  status:number; code:string; outcome:string|undefined;
  constructor(status:number,code:string,outcome?:string) {super(code);this.status=status;this.code=code;this.outcome=outcome;}
}
class RequestBodyFailure extends Error {status=400;code="INVALID_ARGUMENT";}
function load(file:string, modules:Record<string,unknown>) {
  const source = readFileSync(new URL(file,import.meta.url),"utf8");
  const output = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const mod:{exports:Record<string,unknown>} = {exports:{}};
  new Function("require","module","exports",output)((name:string) => {if (!(name in modules)) throw new Error(name);return modules[name];},mod,mod.exports);
  return mod.exports;
}
function fixture() {
 const calls:{owner:string;operation:string;input:unknown}[] = [];
 let authorized = true, origin = true, personal = false;
 const route = load("../app/api/goals/route.ts",{
  "@/server/auth":{personalDataScope:(session:{user:{id:string}})=>personal?"brai-personal-v1:"+ "1".repeat(64):session.user.id,checkOrigin:() => {if(!origin) throw new GatewayError(403,"ORIGIN");},requireSession:async () => {if(!authorized) throw new GatewayError(401,"UNAUTHORIZED");return {user:{id:"owner"}};}},
  "@/server/goals":{goalsRequest:async (owner:string,operation:string,input:unknown) => {calls.push({owner,operation,input});return {items:[]};}},
  "@/server/gateway":{GatewayError},
  "@/server/http":{failure:(error:GatewayError) => Response.json({code:error.code,outcome:error.outcome},{status:error.status})},
  "@/server/request-body":{readBoundedJson:async (request:Request) => request.json(),RequestBodyFailure}
 }) as {GET:(request:Request)=>Promise<Response>;POST:(request:Request)=>Promise<Response>};
 return {route,calls,personal:()=>{personal=true;},unauthorize:()=>{authorized=false;},badOrigin:()=>{origin=false;}};
}
function request(operation:string,input:unknown={}) {return new Request("https://example.test/api/goals",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operation,input})});}

test("web rejects every Goals mutation before reaching transport",async () => {
 const f=fixture();
 for (const operation of ["goals_goal_put","goals_focus_put","goals_entry_put","goals_resource_put","goals_need_put","goals_allocation_put","goals_delete","goals_restore"]) {
  const response=await f.route.POST(request(operation,{id:"synthetic"}));
  assert.equal(response.status,403,operation);
  assert.deepEqual(await response.json(),{code:"FORBIDDEN",outcome:"not-published"});
 }
 assert.deepEqual(f.calls,[]);
});
test("overview and history use authenticated owner and reject bad origin",async () => {
 const f=fixture();
 assert.equal((await f.route.GET(new Request("https://example.test/api/goals"))).status,200);
 assert.equal((await f.route.POST(request("goals_history",{entity:"goals",id:"synthetic"}))).status,200);
 assert.deepEqual(f.calls,[{owner:"owner",operation:"goals_overview",input:{}},{owner:"owner",operation:"goals_history",input:{entity:"goals",id:"synthetic"}}]);
 f.badOrigin();assert.equal((await f.route.POST(request("goals_history"))).status,403);
 f.unauthorize();assert.equal((await f.route.GET(new Request("https://example.test/api/goals"))).status,401);
});
test("web gateway independently rejects mutations before connecting",async () => {
 let connections=0;
 const gateway=load("../server/goals.ts",{"./gateway":{GatewayError,natsConnection:async()=>{connections++;throw new Error("unexpected connection");}}}) as {goalsRequest:(owner:string,operation:string,input:unknown)=>Promise<unknown>};
 for (const operation of ["goals_goal_put","goals_focus_put","goals_entry_put","goals_resource_put","goals_need_put","goals_allocation_put","goals_delete","goals_restore"]) {
  await assert.rejects(gateway.goalsRequest("owner",operation,{}),(error:unknown)=>error instanceof GatewayError && error.outcome==="not-published");
 }
 assert.equal(connections,0);
});

test("Telegram Goals uses a fresh personal scope for overview and guessed history keys",async()=>{
 const f=fixture();f.personal();
 assert.equal((await f.route.GET(new Request("https://example.test/api/goals"))).status,200);
 assert.equal((await f.route.POST(request("goals_history",{entity:"goals",id:"old-key"}))).status,200);
 assert.ok(f.calls.every(call=>call.owner==="brai-personal-v1:"+"1".repeat(64)));
 const before=f.calls.length;
 assert.equal((await f.route.POST(request("goals_history",{owner_id:"other"}))).status,200);
 assert.equal(f.calls.at(-1)?.owner,"brai-personal-v1:"+"1".repeat(64));
 assert.equal(f.calls.length,before+1);
});
