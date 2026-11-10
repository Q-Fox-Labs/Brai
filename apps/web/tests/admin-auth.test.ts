// ABOUTME: Проверяет серверные границы административных операций Web.
// ABOUTME: Подменяет транспорт и сессию, не обращается к реальным данным.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { ssoConfig } from "../server/sso.ts";
import { Control } from "../../../services/hermes/identity/control.mjs";
let ownerControl: Control | null = null;
let role = "user", sent = 0, payload: unknown;
let responseBody: unknown = { items: [] };
let serviceStatus = "";
class GatewayError extends Error { status: number; code: string; constructor(status: number, code: string) { super(code); this.status = status; this.code = code; } }
const auth = { requireSession: async () => ({ user: { role, status: "active" } }), checkOrigin: (request: Request) => { if (request.headers.get("origin") !== "https://brai.test") throw new GatewayError(403, "ORIGIN"); }, authResponse: (reply: { status: number; body: unknown }) => Response.json(reply.body, { status: reply.status }) };
const gateway = { GatewayError, natsConnection: async () => ({ request: async (_subject: string, data: Uint8Array) => { sent++; payload = JSON.parse(Buffer.from(data).toString()); if (ownerControl) return { data: Buffer.from(JSON.stringify(await ownerControl.invoke(_subject.split(".").at(-1), payload))) }; return serviceStatus ? { data: Buffer.from("not json"), headers: { has: () => true, get: (name: string) => name === "Nats-Service-Error" ? "private upstream text" : serviceStatus } } : { data: Buffer.from(JSON.stringify({ status: 200, body: responseBody, setCookies: [] })) }; } }) };
const imports: Record<string, unknown> = { "@/server/auth": auth, "@/server/sso": { ssoConfig }, "@/server/gateway": gateway, "@/server/http": { failure: (error: GatewayError) => Response.json({ code: error.code }, { status: error.status }) }, "@/server/request-body": { readBoundedJson: (request: Request) => request.json() }, "@/server/admin-download": { adminDownload: async (body: unknown, id: string) => Response.json({ body, id }) } };
const source = readFileSync(resolve(import.meta.dirname, "../app/api/admin/route.ts"), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} as Record<string, (request: Request) => Promise<Response>> };
new Function("require", "module", "exports", output)((name: string) => imports[name], mod, mod.exports);
test("admin operations reject users and bad origin before publishing", async () => {
 sent = 0; role = "user";
 assert.equal((await mod.exports.GET(new Request("https://brai.test/api/admin?operation=users-list"))).status, 403);
 role = "admin";
 assert.equal((await mod.exports.POST(new Request("https://brai.test/api/admin", { method: "POST", body: JSON.stringify({ operation: "invite-create" }) }))).status, 403);
 assert.equal(sent, 0);
});
test("access operations preserve request IDs and require an active administrator and origin", async () => {
 role = "admin"; sent = 0;
 for (const [operation, input] of [["users-add", { telegramId: "123" }], ["users-revoke", { userId: "target" }]] as const) {
  const body = { operation, requestId: "request-id", ...input };
  const response = await mod.exports.POST(new Request("https://brai.test/api/admin", { method: "POST", headers: { origin: "https://brai.test", "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { headers: { origin: "https://brai.test" }, body: { requestId: "request-id", ...input } });
 }
 const response = await mod.exports.GET(new Request("https://brai.test/api/admin?operation=users-operation-get&requestId=request-id"));
 assert.equal(response.status, 200);
 assert.deepEqual(payload, { headers: { origin: "https://brai.test" }, body: { requestId: "request-id" } });
 assert.equal(sent, 3);
});
test("admin data reads require an explicit target and keep the actor cookie", async () => {
 role = "admin"; sent = 0;
 assert.equal((await mod.exports.GET(new Request("https://brai.test/api/admin?operation=admin-memory-list"))).status, 400);
 const response = await mod.exports.GET(new Request("https://brai.test/api/admin?operation=admin-memory-list&userId=target", { headers: { cookie: "session=actor" } }));
 assert.equal(response.status, 200); assert.equal(sent, 1);
 assert.deepEqual(payload, { userId: "target", headers: { cookie: "session=actor", origin: "https://brai.test" } });
});
test("download forwards the authorized descriptor and target to the stream adapter", async () => {
 role = "admin";
 const request = () => new Request("https://brai.test/api/admin?operation=admin-artifacts-download&userId=target&artifactId=file", { headers: { cookie: "session=actor" } });
 responseBody = { artifactId: "file", filename: "тест.txt", sizeBytes: 7, sha256: "a".repeat(64), mimeType: "text/plain" };
 const response = await mod.exports.GET(request());
 assert.equal(response.status, 200);
 assert.deepEqual(await response.json(), { body: responseBody, id: "file" });
 assert.deepEqual(payload, { userId: "target", artifactId: "file", headers: { cookie: "session=actor", origin: "https://brai.test" } });
});
test("NATS service errors preserve safe status before parsing non-JSON bodies", async () => {
 role = "admin";
 try {
  for (const [status, code] of [["400", "INVALID_ARGUMENT"], ["403", "FORBIDDEN"], ["404", "NOT_FOUND"], ["413", "PAYLOAD_TOO_LARGE"], ["503", "SOURCE_UNAVAILABLE"]]) {
   serviceStatus = status;
   const response = await mod.exports.GET(new Request("https://brai.test/api/admin?operation=admin-chats-get&userId=target&chatId=chat"));
   assert.equal(response.status, Number(status)); assert.deepEqual(await response.json(), { code });
  }
 } finally { serviceStatus = ""; }
});
test("archive permits admin reads but rejects user-management writes", async () => {
 role = "admin"; serviceStatus = ""; responseBody = { items: [] }; sent = 0;
 const read = await mod.exports.GET(new Request("https://brai.test/api/admin?operation=admin-memory-list&userId=__quarantine__"));
 assert.equal(read.status, 200); assert.equal(sent, 1);
 for (const operation of ["role-set", "status-set", "sessions-revoke"]) {
  const request = new Request("https://brai.test/api/admin", { method: "POST", headers: { origin: "https://brai.test", "content-type": "application/json" }, body: JSON.stringify({ operation, userId: "__quarantine__" }) });
  assert.equal((await mod.exports.POST(request)).status, 400);
 }
 assert.equal(sent, 1);
});

test("chat tail parameters reach the existing owner API and numeric limits stay numeric", async () => {
 role = "admin"; serviceStatus = ""; responseBody = { messages: [], nextCursor: null };
 const response = await mod.exports.GET(new Request("https://brai.test/api/admin?operation=admin-chats-get&userId=target&chatId=chat&order=desc&limit=50"));
 assert.equal(response.status, 200);
 assert.deepEqual(payload, {userId:"target",chatId:"chat",order:"desc",limit:50,headers:{origin:"https://brai.test"}});
 const count = sent;
 for (const limit of ["0", "101", "50x"]) assert.equal((await mod.exports.GET(new Request("https://brai.test/api/admin?operation=admin-chats-get&userId=target&chatId=c&limit=" + limit))).status, 400);
 assert.equal(sent,count);
});

test("preview keeps the actor session and uses the DEV origin only for the shared Control", async () => {
 const names=["BRAI_ENVIRONMENT","WEB_ORIGIN","WEB_SSO_HUB_ORIGIN","WEB_SSO_PREVIEW_ORIGINS"];
 const saved=names.map(name=>process.env[name]);
 try {
  process.env.BRAI_ENVIRONMENT="dev";process.env.WEB_ORIGIN="https://preview.example.test";
  process.env.WEB_SSO_HUB_ORIGIN="https://dev.example.test";process.env.WEB_SSO_PREVIEW_ORIGINS="https://preview.example.test";
  role="admin";sent=0;serviceStatus="";responseBody={items:[],nextCursor:null};
  for (const operation of ["admin-chats-list","admin-chats-get","admin-artifacts-download"]) {
   const extra=operation==="admin-chats-get"?"&chatId=chat":operation==="admin-artifacts-download"?"&artifactId=file":"";
   const response=await mod.exports.GET(new Request("https://preview.example.test/api/admin?operation="+operation+"&userId=target"+extra,{headers:{cookie:"session=preview-admin"}}));
   assert.equal(response.status,200);
   assert.deepEqual((payload as {headers:unknown}).headers,{cookie:"session=preview-admin",origin:"https://dev.example.test"});
  }
  const response=await mod.exports.GET(new Request("https://preview.example.test/api/admin?operation=users-list",{headers:{cookie:"session=preview-admin"}}));
  assert.equal(response.status,200);
  assert.equal((payload as {headers:{origin:string}}).headers.origin,"https://preview.example.test");
  const before=sent;
  const foreign=await mod.exports.GET(new Request("https://preview.example.test/api/admin?operation=admin-chats-list&userId=target",{headers:{origin:"https://foreign.example.test",cookie:"session=preview-admin"}}));
  assert.equal(foreign.status,403);assert.equal(sent,before);
  role="user";
  assert.equal((await mod.exports.GET(new Request("https://preview.example.test/api/admin?operation=admin-chats-list&userId=target"))).status,403);
  assert.equal(sent,before);
 } finally {names.forEach((name,i)=>{if(saved[i]===undefined)delete process.env[name];else process.env[name]=saved[i];});role="admin";}
});

test("real Control reproduces the preview refusal and accepts the same admin cookie through Web", async () => {
 const names=["BRAI_ENVIRONMENT","WEB_ORIGIN","WEB_SSO_HUB_ORIGIN","WEB_SSO_PREVIEW_ORIGINS"];
 const saved=names.map(name=>process.env[name]);
 let reads=0,audits=0;
 const hub="https://dev.example.test",preview="https://preview.example.test",cookie="session=verified-preview-admin";
 try {
  process.env.BRAI_ENVIRONMENT="dev";process.env.WEB_ORIGIN=preview;
  process.env.WEB_SSO_HUB_ORIGIN=hub;process.env.WEB_SSO_PREVIEW_ORIGINS=preview;
  ownerControl=new Control({origin:hub,cursorKey:"x".repeat(32),
   registry:async()=>({version:1,profiles:{1001:{userId:"target",profileId:"p",status:"active"}}}),
   authCall:async(operation:string,input:{headers:{cookie:string;origin:string}})=>{
    assert.equal(input.headers.cookie,cookie);assert.equal(input.headers.origin,hub);
    if(operation==="session")return {status:200,body:{session:{},user:{id:"actor",role:"admin",status:"active"}}};
    assert.equal(operation,"admin-audit");audits++;return {status:200};
   },
   chatRead:async()=>{reads++;return {items:[{id:"chat",title:"Проверочный диалог",updatedAt:"2026-11-09T00:00:00Z"}],nextCursor:null};},
   memoryRead:undefined,artifactsCall:undefined,telegramSend:undefined,telegramInfo:undefined,toolCatalog:undefined,
   perUserRuntime:undefined,historyCall:undefined,quarantineProfile:undefined,quarantineArtifactsOwnerId:undefined});
  // Прежний payload воспроизводит 403 до чтения и аудита даже при правильной cookie.
  const rejected=await ownerControl.invoke("admin-chats-list",{headers:{cookie,origin:preview},userId:"target"});
  assert.equal(rejected.status,403);assert.equal(reads,0);assert.equal(audits,0);
  role="admin";serviceStatus="";
  const response=await mod.exports.GET(new Request(preview+"/api/admin?operation=admin-chats-list&userId=target",{headers:{cookie}}));
  assert.equal(response.status,200);assert.equal((await response.json()).items[0].title,"Проверочный диалог");
  assert.equal(reads,1);assert.equal(audits,1);
  role="user";
  assert.equal((await mod.exports.GET(new Request(preview+"/api/admin?operation=admin-chats-list&userId=target",{headers:{cookie}}))).status,403);
  assert.equal(reads,1);assert.equal(audits,1);
  role="admin";
  for (const [environment,allowedPreview] of [["prod",preview],["dev","https://other-preview.example.test"]]) {
   process.env.BRAI_ENVIRONMENT=environment;process.env.WEB_SSO_PREVIEW_ORIGINS=allowedPreview;
   const denied=await mod.exports.GET(new Request(preview+"/api/admin?operation=admin-chats-list&userId=target",{headers:{cookie}}));
   assert.equal(denied.status,403);assert.equal(reads,1);assert.equal(audits,1);
  }
 } finally {ownerControl=null;role="admin";names.forEach((name,i)=>{if(saved[i]===undefined)delete process.env[name];else process.env[name]=saved[i];});}
});
