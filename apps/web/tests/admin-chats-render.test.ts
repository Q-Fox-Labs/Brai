// ABOUTME: Проверяет опубликованные файлы в административной переписке.
// ABOUTME: Примеры кода не становятся вложениями; каждый URL содержит выбранного владельца.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {test} from "node:test";
import {createElement, type ComponentType} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import ts from "typescript";
import {adminChatDisplayText} from "../app/agent/admin-chat-display.ts";
const file=new URL("../app/agent/admin-chats.tsx",import.meta.url),require=createRequire(file);
const output=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const mod={exports:{} as {AdminMessageBody:ComponentType<{message:{id:string;role:"assistant";text:string;createdAt:string};owner:string}>}};
new Function("require","module","exports",output)((name:string)=>{
 if(name.endsWith(".css")||name==="./admin-chat-client")return {};
 if(name==="./admin-chat-display")return {adminChatDisplayText};
 if(name==="./markdown")return {default:({text}:{text:string})=>createElement("pre",null,text)};
 if(name.startsWith("../"))return {};
 return require(name);
},mod,mod.exports);
const id="11111111-1111-4111-8111-111111111111",link="![Изображение](</home/test/results/"+id+"/image.png>)";
const render=(text:string)=>renderToStaticMarkup(createElement(mod.exports.AdminMessageBody,{owner:"target-owner",message:{id:"1",role:"assistant",text,createdAt:"2026-11-08"}}));
test("published media use the admin owner check and do not expose a local file URL",()=>{
 const html=render("Готово. "+link);
 assert.match(html,/Готово/);assert.match(html,/userId=target-owner/);assert.match(html,/artifactId=11111111/);assert.match(html,/preview=1/);
 assert.ok(!html.includes("/home/test"));assert.ok(html.includes("<img"));
});
test("fenced, escaped and inline code references stay text without network media",()=>{
 const tick=String.fromCharCode(96);
 for(const text of ["~~~\n"+link+"\n~~~",tick.repeat(3)+"\n"+link+"\n"+tick.repeat(3),tick+link+tick,"\\"+link]){
  const html=render(text);assert.ok(!html.includes("<img"));assert.ok(!html.includes("preview=1"));assert.ok(html.includes("/home/test/results/"));
 }
});
test("delivery commands never render private paths or invent delivered attachments",()=>{
 const html=render('Вот ответ.\n\n[[audio_as_voice]]\nMEDIA:"/private/profile/results/.delivery/opaque/0-voice.ogg"');
 assert.match(html,/Вот ответ/);assert.doesNotMatch(html,/MEDIA:|audio_as_voice|private|delivery|<audio|preview=1/);
 assert.equal(render('[[as_document]]\nMEDIA:"/private/report.docx"'),"");
});
