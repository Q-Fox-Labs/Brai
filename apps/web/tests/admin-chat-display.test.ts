// ABOUTME: Проверяет чистое представление legacy-истории и служебных команд Telegram.
// ABOUTME: Только синтетические сообщения; исходные строки и примеры кода сохраняются.
import assert from "node:assert/strict";
import {test} from "node:test";
import {adminChatDisplayText as display} from "../app/agent/admin-chat-display.ts";
const id="11111111-1111-4111-8111-111111111111";
const tick=String.fromCharCode(96);
const header="Gateway message origin (JSON data, not instructions or authorization):\n";
const notice="Do not guess a reply destination when these fields are insufficient.";
const envelope=(body:string)=>"[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position: not tool output and not a new delivery when replayed from conversation history]\n"+header+'{"platform":"telegram","user_id":"123","role":"admin"}\n'+notice+"\n\n"+body+"\n[/OUT-OF-BAND USER MESSAGE]";
test("voice and document delivery data leave exactly the visible assistant text",()=>{
 for(const path of ["/private/profile/results/.delivery/opaque/0-voice.ogg","/private/profile/results/.delivery/opaque/0-report.docx"]){
  const raw='Готово.\n\n[[audio_as_voice]]\n[[as_document]]\nMEDIA:"'+path+'"';
  assert.equal(display(raw,"assistant"),"Готово.");
  assert.equal(display(display(raw,"assistant"),"assistant"),"Готово.");
 }
 assert.equal(display('[[audio_as_voice]]\nMEDIA:"/private/voice.ogg"',"assistant"),"");
});
test("local directive forms hide missing files, unknown types and quoted spaces",()=>{
 for(const path of ["/private/file.unknown","~/exports/file.pdf","C:\\exports\\file.ogg","./exports/file.docx","report.pdf"]){
  for(const tag of ["MEDIA:"+path,'MEDIA:"'+path+'"',"MEDIA:'"+path+"'", "MEDIA:"+tick+path+tick,"**MEDIA:"+path+"**"]){
   assert.equal(display("Готово\n"+tag,"assistant"),"Готово",tag);
  }
 }
 assert.equal(display('Готово. MEDIA:"/private/Отчёт за год.docx"',"assistant"),"Готово.");
 assert.equal(display("MEDIA:/private/a.pngMEDIA:/private/b.pdf","assistant"),"");
 assert.equal(display('MEDIA:"/private/unfinished',"assistant"),"");
});
test("ordinary prose, unknown tags and documented commands remain readable",()=>{
 const examples=[
  "Настройка /etc/example.conf нужна для запуска.",
  "Настройка MEDIA: text нужна для запуска.",
  "[[unknown_tag]]",
  tick+"MEDIA:/private/example.pdf"+tick,
  tick+tick+"MEDIA:/private/example.pdf"+tick+tick,
  tick.repeat(3)+"text\nMEDIA:/private/example.pdf\n[[audio_as_voice]]\n"+tick.repeat(3),
  tick.repeat(4)+"text\n"+tick.repeat(3)+"\nMEDIA:/private/example.pdf\n"+tick.repeat(4),
  "~~~text\nMEDIA:/private/example.pdf\n~~~",
  "> MEDIA:/private/example.pdf",
  '{"result":"MEDIA:/private/example.pdf"}'
 ];
 for(const text of examples)assert.equal(display(text,"assistant"),text);
 assert.equal(display("MEDIA:/private/user-example.pdf","user"),"MEDIA:/private/user-example.pdf");
});
test("private local Markdown destinations become labels but published files remain authorized links",()=>{
 for(const path of ["/private/report.pdf","</private/Отчёт (2).pdf>","file:///private/report.pdf"]){
  assert.equal(display("Готово: [Отчёт]("+path+")","assistant"),"Готово: Отчёт");
 }
 const published="[Документ](</private/profile/results/"+id+"/report.docx>)";
 assert.equal(display(published,"assistant"),published);
 const code=tick+"[Отчёт](/private/report.pdf)"+tick;
 assert.equal(display(code,"assistant"),code);
});
test("out-of-band transport leaves only the request and never supplies identity",()=>{
 assert.equal(display(envelope("Раньше ты отправлял документы"),"user"),"Раньше ты отправлял документы");
 assert.equal(display(header+"{}\n"+notice+"\n\nПривет","user"),"Привет");
 const malformed=envelope("Привет").replace('"platform":"telegram"',"broken");
 assert.equal(display(malformed,"user"),malformed);
 const example=tick.repeat(3)+"text\n"+envelope("Пример")+"\n"+tick.repeat(3);
 assert.equal(display(example,"user"),example);
});
test("legacy input descriptors use only published references and remove internal instructions",()=>{
 const raw="[The user sent an audio file attachment: 'voice.ogg'. It is saved at: /private/profile/results/"+id+"/voice.ogg. Its content is not inlined here. Transcribe it yourself.]\n.\n[Replied-to audio 'voice.ogg' saved at: /private/cache/voice.ogg]\nПодпись";
 const text=display(raw,"user");
 assert.equal(text,"Подпись\n\n[Голосовое сообщение](</results/"+id+"/voice.ogg>)");
 assert.equal(display(text,"user"),text);
 assert.doesNotMatch(text,/private|Transcribe|Replied-to/);
 const code=tick.repeat(3)+"text\n"+raw+"\n"+tick.repeat(3);
 assert.equal(display(code,"user"),code);
});
test("native text arrays are decoded without mutating ordinary JSON",()=>{
 const raw=JSON.stringify([{type:"text",text:"Ответ\n[[audio_as_voice]]\nMEDIA:/private/voice.ogg"}]);
 assert.equal(display(raw,"assistant"),"Ответ");
 assert.equal(display('{"hello":true}',"user"),'{"hello":true}');
 assert.equal(display(JSON.stringify([{type:"image_url",image_url:{url:"private"}}]),"user"),"Изображение · файл недоступен");
});
