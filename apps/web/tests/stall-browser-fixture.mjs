// ABOUTME: Запускает синтетический сервер данных для браузерной проверки AdminChats.
// ABOUTME: Работает только на loopback и не проверяет интеграцию настоящего NATS.
import { test } from "node:test";
import { createServer as tcpServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

test("ручная браузерная проверка синтетических чатов", async () => {
 const flags = { orphanUnavailable: true, historyFail: false }, sockets = new Set();
 const user = { id:"admin-fixture", name:"Администратор", role:"admin", status:"active", profileId:"p-admin", email:"admin@fixture.invalid" };
 const sergei = { id:"sergei-fixture", name:"SERGEI", profileId:"p-sergei" };
 const orphan = { id:"orphan-fixture", name:"Синтетическая проверка Дневника", profileId:"p-orphan" };
 const reply = (subject, input) => {
  if (subject === "brai.auth.v1.session") {
   const valid = input.headers?.cookie?.includes("fixture-session=fixture-token");
   return { status:200, body:valid ? { user, session:{id:"fixture-session",userId:user.id,expiresAt:"2099-01-01T00:00:00Z"} } : null, setCookies:[] };
  }
  if (subject === "brai.auth.v2.users-list") return { status:200, body:{users:[sergei,orphan]}, setCookies:[] };
  if (subject === "brai.hermes.identity.v1.admin-chats-list") {
   if (input.userId === orphan.id && flags.orphanUnavailable) return { status:503, body:{code:"SOURCE_UNAVAILABLE"}, setCookies:[] };
   const id = input.userId === sergei.id ? "sergei-chat" : "orphan-chat";
   return { status:200, body:{source:"telegram",items:[{id,title:input.userId === sergei.id ? "SERGEI" : "Проверочный чат",updatedAt:"2026-11-10T00:00:00Z"}],nextCursor:null}, setCookies:[] };
  }
  if (subject === "brai.hermes.identity.v1.admin-chats-get") {
   if (flags.historyFail) return { status:503, body:{code:"SOURCE_UNAVAILABLE"}, setCookies:[] };
   return { status:200, body:{source:"telegram",messages:[{id:"1",role:"user",text:"Синтетическое сообщение для проверки истории",createdAt:"2026-11-10T00:00:00Z"}],nextCursor:null}, setCookies:[] };
  }
  return { status:503, body:{code:"SOURCE_UNAVAILABLE"}, setCookies:[] };
 };
 const nats = tcpServer(socket => {
  sockets.add(socket); socket.on("close",()=>sockets.delete(socket));
  socket.write('INFO {"server_id":"fixture","version":"2.10.0","proto":1,"headers":false,"max_payload":1048576}\r\n');
  let buffer=Buffer.alloc(0), subscriptions=new Map();
  socket.on("data", chunk => {
   buffer=Buffer.concat([buffer,chunk]);
   while (true) {
    const end=buffer.indexOf("\r\n"); if(end<0) break;
    const line=buffer.subarray(0,end).toString(), parts=line.split(" ");
    if(parts[0]==="PUB") {
     const length=Number(parts.at(-1)), total=end+2+length+2; if(buffer.length<total) break;
     let input={}; try { input=JSON.parse(buffer.subarray(end+2,end+2+length).toString()); } catch {}
     const response=Buffer.from(JSON.stringify(reply(parts[1],input))), inbox=parts.length===4 ? parts[2] : "";
     for(const [sid,pattern] of subscriptions) if(inbox && (pattern===inbox || pattern.endsWith(".*") && inbox.startsWith(pattern.slice(0,-1)))) {
      socket.write(`MSG ${inbox} ${sid} ${response.length}\r\n`); socket.write(response); socket.write("\r\n");
     }
     buffer=buffer.subarray(total); continue;
    }
    buffer=buffer.subarray(end+2);
    if(parts[0]==="SUB") subscriptions.set(parts.at(-1),parts[1]);
    if(parts[0]==="UNSUB") subscriptions.delete(parts[1]);
    if(parts[0]==="PING") socket.write("PONG\r\n");
   }
  });
 });
 await new Promise(resolve => nats.listen(0,"127.0.0.1",resolve));
 let finish; const done=new Promise(resolve => { finish=resolve; }); let failed=false;
 const control=httpServer((request,response)=>{
  const url=new URL(request.url,"http://127.0.0.1");
  if(url.pathname==="/flags") { for(const key of Object.keys(flags)) if(url.searchParams.has(key)) flags[key]=url.searchParams.get(key)==="1"; }
  else if(url.pathname==="/stop") finish();
  response.writeHead(200,{"content-type":"application/json"}); response.end(JSON.stringify(flags));
 });
 await new Promise(resolve => control.listen(0,"127.0.0.1",resolve));
 const root=resolve(fileURLToPath(new URL("../../..",import.meta.url)));
 const web=resolve(root,"apps/web"), next=resolve(root,"node_modules/next/dist/bin/next");
 const child=spawn(process.execPath,[next,"dev","--webpack","--hostname","127.0.0.1","--port","3190"],{
  cwd:web,stdio:"inherit",env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:"development",NATS_URL:`nats://127.0.0.1:${nats.address().port}`,WEB_ORIGIN:"http://127.0.0.1:3190",WEB_IDENTITY_MODE:"telegram",BRAI_ENVIRONMENT:"dev",BRAI_WEB_AGENT_MODE:"hermes_telegram"}
 });
 child.on("exit",()=>{failed=true;finish();}); process.once("SIGTERM",finish); process.once("SIGINT",finish);
 console.log(`Fixture http://127.0.0.1:3190/agent ; cookie fixture-session=fixture-token ; control http://127.0.0.1:${control.address().port}/flags?orphanUnavailable=1&historyFail=0 ; /stop to finish`);
 await done;
 child.kill("SIGTERM"); for(const socket of sockets) socket.destroy();
 await Promise.all([new Promise(resolve=>nats.close(resolve)),new Promise(resolve=>control.close(resolve))]);
 if(failed) throw new Error("Тестовый Next завершился до остановки стенда");
});
