// ABOUTME: Проверяет точный Telegram текст и независимые изображения, аудио и документы.
// ABOUTME: Каждый файловый адрес остаётся за административной проверкой владельца.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {test} from "node:test";
import {createElement, type ComponentType} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import ts from "typescript";
import type {ChatMessage} from "../app/agent/admin-chat-client.ts";
const file=new URL("../app/agent/admin-chats.tsx",import.meta.url),require=createRequire(file);
const output=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const mod={exports:{} as {AdminMessageBody:ComponentType<{message:ChatMessage;owner:string}>}};
new Function("require","module","exports",output)((name:string)=>{
 if(name==="./telegram-rich"){const richFile=new URL("../app/agent/telegram-rich.tsx",import.meta.url), rich={exports:{}}; const code=ts.transpileModule(readFileSync(richFile,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText; new Function("require","module","exports",code)(require,rich,rich.exports);return rich.exports;}
 if(name.endsWith(".css")||name==="./admin-chat-client"||name.startsWith("../"))return {};
 return require(name);
},mod,mod.exports);
const id="11111111-1111-4111-8111-111111111111";
const render=(message:Partial<ChatMessage>)=>renderToStaticMarkup(createElement(mod.exports.AdminMessageBody,{owner:"target-owner",message:{id:"1",role:"assistant",text:"",createdAt:"2026-11-08",...message}}));
test("actual Telegram text is never parsed, trimmed or rewritten",()=>{
 const text='  **буквальный текст**\n[[audio_as_voice]]\nMEDIA:/example/command\n  ';
 const html=render({text});
 assert.ok(html.includes(text));assert.ok(!html.includes("<audio"));assert.ok(!html.includes("<strong"));
});
test("image audio video and document refs use MIME and preserve an empty caption",()=>{
 const html=render({attachments:[
  {artifactId:id,filename:"image.bin",mimeType:"image/png"},
  {artifactId:"22222222-2222-4222-8222-222222222222",filename:"voice.bin",mimeType:"audio/ogg"},
  {artifactId:"33333333-3333-4333-8333-333333333333",filename:"video.bin",mimeType:"video/mp4"},
  {artifactId:"44444444-4444-4444-8444-444444444444",filename:"report.docx",mimeType:"application/octet-stream"}]});
 for(const value of ["<img","<audio","<video","report.docx","userId=target-owner","preview=1"])assert.ok(html.includes(value));
 assert.ok(!html.includes("/private/"));assert.ok(!html.includes("tg-text"));
});
test("two independently delivered errors retain their exact text",()=>{
 for(const text of ["❌ custom rejected the request: HTTP 403","🔑 Подключение отклонено\n\nКод: auth"]){
  assert.ok(render({text}).includes(text));
 }
 assert.equal(render({text:"",attachments:[]}),"");
});

test("actual RichMessage blocks retain text, tables and formatting without interpreting HTML",()=>{
 const html=render({richMessage:{blocks:[
  {type:"paragraph",text:["  Точный ",{type:"bold",text:"ответ"},"  "]},
  {type:"table",cells:[[{text:"Колонка"},{text:"Значение"}],[{text:"А"},{text:"Б"}]]},
  {type:"paragraph",text:{type:"url",text:"<script>literal</script>",url:"javascript:alert(1)"}}
 ]}});
 assert.match(html,/<strong>ответ<\/strong>/);assert.match(html,/<table>/);assert.match(html,/Колонка/);
 assert.ok(html.includes("&lt;script&gt;literal&lt;/script&gt;"));assert.ok(!html.includes("href="));assert.ok(!html.includes("<script>"));
});

test("every attachment has a named direct download card and a readable size",()=>{
 for(const mimeType of ["image/png","audio/ogg","video/mp4","application/pdf","image/svg+xml"]){
  const html=render({messageType:"document",attachments:[{artifactId:id,filename:"Отчёт.pdf",mimeType,sizeBytes:1536}]});
  assert.match(html,/class="tg-file-card"/);assert.match(html,/download="Отчёт.pdf"/);
  assert.ok(html.includes('aria-label="Скачать Отчёт.pdf"'));assert.ok(html.includes("1,5 КБ"));
  if(mimeType==="image/svg+xml")assert.ok(!html.includes("<img"));
  if(mimeType==="image/png")assert.ok(html.includes("<img"));
 }
});
test("voice metadata and unsupported media retain a download without fake players",()=>{
 const voice=render({messageType:"voice",attachments:[{artifactId:id,filename:"voice.ogg",mimeType:"audio/ogg"}]});
 assert.match(voice,/<audio[^>]*controls/);assert.match(voice,/Аудиозапись/);assert.match(voice,/Скачать/);
 const unsupported=render({attachments:[{artifactId:id,filename:"clip.mov",mimeType:"video/quicktime"}]});
 assert.ok(!unsupported.includes("<video"));assert.match(unsupported,/Скачать clip.mov/);
});
