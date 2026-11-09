// ABOUTME: Проверяет объединение профилей и восстановление живой переписки после разрыва.
// ABOUTME: Использует синтетические ответы существующего HTTP API без реальных пользователей.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AdminChatError, chatParticipant, adminChatKey, latestAdminChat, loadAdminChats, mergeAdminMessages, type AdminChat, type ChatMessage } from "../app/agent/admin-chat-client.ts";
const chat: AdminChat = { id: "same", title: "Чат", updatedAt: "2026-11-08T00:00:00Z", owner: { id: "u1", name: "Анна", profileId: "p1" } };
const message = (id: number): ChatMessage => ({ id: String(id), role: "user", text: "Сообщение " + id, createdAt: "2026-11-08T00:00:00Z" });

test("all owners and archive pages stay distinct; one failed profile keeps its previous chats", async () => {
 const saved = globalThis.fetch, requests: URL[] = [];
 try {
  globalThis.fetch = (async (input: string | URL | Request) => {
   const url = new URL(String(input), "https://fixture.test"); requests.push(url);
   const q = url.searchParams, owner = q.get("userId");
   if (q.get("operation") === "users-list") return Response.json({users:[chat.owner,{id:"u2",name:"Иван",profileId:"p2"}]});
   if (owner === "u2") return new Response("",{status:503});
   return Response.json({items:[{id:q.get("cursor") ? "older" : "same",title:"Чат",updatedAt:chat.updatedAt}],nextCursor:owner === "u1" && !q.get("cursor") ? "next" : null});
  }) as typeof fetch;
  const old = {...chat,owner:{id:"u2",name:"Иван"}};
  const result = await loadAdminChats([old],new AbortController().signal);
  assert.equal(result.chats.length,4);
  assert.equal(new Set(result.chats.map(adminChatKey)).size,4);
  assert.deepEqual(result.unavailable,["Иван"]);
  assert.ok(result.chats.some(c=>c.owner.id==="__quarantine__"));
  assert.equal(requests.filter(q=>q.searchParams.get("userId")==="u1").length,2);
 } finally { globalThis.fetch=saved; }
});
test("reconnect recovers more than fifty new messages without a gap and owner never comes from message text", async () => {
 const saved = globalThis.fetch; let calls=0;
 try {
  globalThis.fetch = (async (input: string | URL | Request) => {
   const q=new URL(String(input),"https://fixture.test").searchParams;
   assert.equal(q.get("userId"),"u1"); assert.equal(q.get("chatId"),"same"); assert.equal(q.get("order"),"desc"); calls++;
   const end=q.get("cursor") ? Number(q.get("cursor")) : 170, start=Math.max(1,end-49);
   return Response.json({messages:Array.from({length:end-start+1},(_,i)=>message(start+i)),nextCursor:start>1 ? String(start-1):null});
  }) as typeof fetch;
  const result=await latestAdminChat(chat,"1",new AbortController().signal);
  const merged=mergeAdminMessages([message(1)],result.messages);
  assert.equal(calls,4); assert.deepEqual(merged.map(m=>m.id),Array.from({length:170},(_,i)=>String(i+1)));
  assert.equal(result.nextCursor,null);
  assert.equal(mergeAdminMessages(merged,[{...message(170),text:"Изменено"}]).at(-1)?.text,"Изменено");
 } finally { globalThis.fetch=saved; }
});
test("revoked access fails the whole refresh and never returns a partial user collection", async () => {
 const saved=globalThis.fetch;
 try {
  globalThis.fetch=(async(input:string|URL|Request)=>{
   const q=new URL(String(input),"https://fixture.test").searchParams;
   return q.get("operation")==="users-list" ? Response.json({users:[chat.owner]}) : new Response("",{status:403});
  }) as typeof fetch;
  await assert.rejects(loadAdminChats([chat],new AbortController().signal),(error:unknown)=>error instanceof AdminChatError&&error.status===403);
 } finally { globalThis.fetch=saved; }
});

test("empty internal pages do not hide the latest human messages",async()=>{
 const saved=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=(async(input:string|URL|Request)=>{
   calls++;const q=new URL(String(input),"https://fixture.test").searchParams;
   return Response.json(q.get("cursor")==="second"?{messages:[message(2)],nextCursor:null}:{messages:[],nextCursor:"second"});
  }) as typeof fetch;
  const result=await latestAdminChat(chat,"1",new AbortController().signal);
  assert.equal(calls,2);assert.deepEqual(result.messages.map(m=>m.id),["2"]);
 }finally{globalThis.fetch=saved;}
});
test("linked Telegram accounts keep their own name and username",()=>{
 assert.equal(chatParticipant({...chat,participant:{telegramId:"456",name:"Борис",username:"boris"}}),"Борис · @boris");
 assert.equal(chatParticipant({...chat,participant:{telegramId:"456",name:""}}),"456");
});
