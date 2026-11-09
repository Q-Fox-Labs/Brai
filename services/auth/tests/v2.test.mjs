// ABOUTME: Проверяет доступ и форму web-операций Auth v2 без внешних сервисов.
// ABOUTME: Подставная БД не заменяет интеграционные тесты конкурентных транзакций.
import test from "node:test";
import assert from "node:assert/strict";
import { v2 } from "../dist/v2.js";
import { validate } from "../dist/schema.js";
const cfg={identityMode:"telegram",origin:"https://fixture.example",trustedOrigins:["https://fixture.example"],secret:"fixture-secret-32-characters-long-enough"};
const good={headers:{origin:cfg.origin,cookie:"session=fixture"},body:{}};
const handler=async()=>Response.json({user:{id:"u1"},session:{id:"s1"}});
function fixture({role="admin",session=true}={}){
 let calls=0;
 const client={async query(sql){calls++;if(sql.includes('FROM "session"'))return {rowCount:session?1:0,rows:[]};if(sql.includes("role IN ('creator','admin')"))return {rowCount:["creator","admin"].includes(role)?1:0,rows:[{role}]};if(sql.startsWith("SELECT u.id"))return {rowCount:1,rows:[{id:"u1",name:"Fixture",role,status:"active",telegramId:"100",profileId:"p1"}]};return {rowCount:0,rows:[]};},release(){}};
 return {pool:{async query(){calls++;return {rows:[{id:"u1",name:"Fixture",role,status:"active",telegramId:"100",profileId:"p1"}]};},async connect(){return client;}},get calls(){return calls;}};
}
test("web admin requires allowed origin, current session and admin role",async()=>{
 const f=fixture();
 const bad=await v2("users-list",{...good,headers:{...good.headers,origin:"https://evil.example"}},cfg,f.pool,handler);
 assert.equal(bad.status,403);assert.equal(f.calls,0);
 const revoked=fixture({session:false});
 assert.equal((await v2("users-list",good,cfg,revoked.pool,handler)).status,401);
 const ordinary=fixture({role:"user"});
 assert.equal((await v2("users-list",good,cfg,ordinary.pool,handler)).status,403);
 const creator=fixture({role:"creator"});
 assert.equal((await v2("users-list",good,cfg,creator.pool,handler)).status,200);
 const list=await v2("users-list",good,cfg,f.pool,handler);
 assert.equal(list.status,200);assert.deepEqual(list.body.users.map(u=>u.id),["u1"]);
 await assert.rejects(()=>v2("role-set",{headers:good.headers,body:{userId:"u1",role:"superuser"}},cfg,f.pool,handler),/Invalid/);
});
test("quarantine is an audit-only target for an active administrator",async()=>{
 const admin=fixture();
 const request={headers:good.headers,body:{userId:'__quarantine__',action:'memory.read'}};
 const audit=await v2('admin-audit',request,cfg,admin.pool,handler);
 assert.equal(audit.status,200);assert.ok(audit.body.auditId);
 const role=await v2('role-set',{headers:good.headers,body:{userId:'__quarantine__',role:'admin'}},cfg,admin.pool,handler);
 assert.equal(role.status,404);
 const ordinary=fixture({role:'user'});
 assert.equal((await v2('admin-audit',request,cfg,ordinary.pool,handler)).status,403);
});

test("published DTO schemas accept valid requests and reject extra fields",()=>{
 validate("TelegramResolveRequest",{telegramId:"123"});
 validate("TelegramLinkRedeemRequest",{telegramId:"123",code:"a".repeat(43)});
 validate("TelegramLinkIssueResponse",{code:"a".repeat(43),expiresAt:"2030-01-01"});
 validate("TelegramUnlinkResponse",{unlinked:true});
 validate("TelegramUnlinkRequest",{telegramId:"123",targetTelegramId:"456"});
 validate("IdentityGetRequest",{userId:"owner"});
 validate("IdentityGetResponse",{user:null,telegramIds:[]});
 assert.throws(()=>validate("TelegramUnlinkRequest",{telegramId:"123"}),/Invalid/);
 assert.throws(()=>validate("IdentityGetRequest",{userId:"owner",telegramId:"456"}),/Invalid/);
 assert.throws(()=>validate("TelegramLinkRedeemRequest",{telegramId:"123",code:"a".repeat(43),userId:"foreign"}),/Invalid/);
 validate("AdminEmptyRequest",{headers:{origin:cfg.origin},body:{}});
 validate("AdminRoleRequest",{headers:{origin:cfg.origin},body:{userId:"u1",role:"admin"}});
 assert.throws(()=>validate("TelegramResolveRequest",{telegramId:"123",role:"admin"}),/Invalid/);
 assert.throws(()=>validate("AdminRoleRequest",{headers:{origin:cfg.origin},body:{userId:"u1",role:"superuser"}}),/Invalid/);
});

test("NATS session returns current identity and never returns the session token",async()=>{
 const {runNats}=await import("../dist/nats.js");const endpoints=new Map();
 const service={addEndpoint(name,options){endpoints.set(name,options.handler);},async stop(){}};
 const nc={services:{async add(){return service;}}};let active=true;
 const pool={async query(){return {rows:active?[{id:"u1",name:"Fixture",role:"user",status:"active",telegramId:"100",profileId:"p1"}]:[]};}};
 const engine=async()=>Response.json({user:{id:"u1",email:"hidden@identity.brai.invalid"},session:{id:"s1",userId:"u1",token:"secret-token",expiresAt:"2030-01-01"}});
 const runtime=await runNats(nc,cfg,engine,pool);
 const request=()=>new Promise((resolve,reject)=>endpoints.get("session")(null,{data:Buffer.from(JSON.stringify(good)),respond:data=>resolve(JSON.parse(data)),respondError:(code,message)=>reject(new Error(code+message))}));
 const response=await request();assert.deepEqual(response.body.session,{id:"s1",userId:"u1",expiresAt:"2030-01-01"});
 assert.equal(response.body.user.role,"user");assert.equal(JSON.stringify(response).includes("secret-token"),false);
 active=false;assert.equal((await request()).body,null);await runtime.stop();
});
