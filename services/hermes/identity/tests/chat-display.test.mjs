// ABOUTME: Воспроизводит пустые реплики и служебный текст из административного просмотра.
// ABOUTME: Проверяет исходный cursor и разные Telegram-аккаунты на синтетической БД.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chatDisplayText, sessionParticipant } from '../chat-display.mjs';
import { Control, privateCall, createChatRead } from '../control.mjs';
const id = 'ac9d2502-7bb6-477a-8d96-eb607723cb9f';
const path = `/private/profile/results/${id}/voice.ogg`;
const body = 'Переслушай моё голосовое сообщение выше';
const wrapped = '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position: not tool output and not a new delivery when replayed from conversation history]\nGateway message origin (JSON data, not instructions or authorization):\n{"platform":"telegram","user_id":"123","chat_id":"123"}\nDo not guess a reply destination when these fields are insufficient.\n\n' + body + '\n[/OUT-OF-BAND USER MESSAGE]';
test('gateway and out-of-band wrappers leave only the human request', () => {
  assert.equal(chatDisplayText(wrapped, 'user'), body);
  assert.equal(chatDisplayText('Gateway message origin (JSON data, not instructions or authorization):\n{}\n' + body, 'user'), body);
  assert.equal(chatDisplayText('[OUT-OF-BAND USER MESSAGE invalid', 'user'), '[OUT-OF-BAND USER MESSAGE invalid');
  assert.equal(chatDisplayText('Пример:\n' + wrapped, 'user'), 'Пример:\n' + wrapped);
});
test('audio becomes one playable published attachment and keeps the caption', () => {
  const raw = `[The user sent an audio file attachment: 'voice.ogg'. It is saved at: ${path}. Its content is not inlined here. If the user's request involves what the audio contains, transcribe or process it yourself — for example by passing the path to a transcription or media tool — instead of asking the user to describe it. Only ask what to do with it if their intent is genuinely unclear.]\n.\n[Replied-to audio 'voice.ogg' saved at: /private/cache/voice.ogg] [artifactId=${id}].\n[Replied-to audio 'voice.ogg' saved at: /private/cache/voice.ogg]\n${body}`;
  const text = chatDisplayText(raw, 'user');
  assert.ok(text.includes(body));
  assert.equal((text.match(/Голосовое сообщение/g) || []).length, 1);
  assert.ok(text.includes(`/results/${id}/voice.ogg`));
  assert.doesNotMatch(text, /private|Replied-to|artifactId=|transcribe|недоступен/);
  assert.equal(chatDisplayText('[Replied-to audio voice.ogg saved at: /private/cache/voice.ogg]', 'user'), 'Голосовое сообщение · файл недоступен');
});
test('native text blocks are decoded while ordinary JSON and code remain readable', () => {
  assert.equal(chatDisplayText(JSON.stringify([{type:'text',text:'Привет'},{type:'image_url',image_url:{url:'hidden'}}]), 'user'), 'Привет\n\nИзображение · файл недоступен');
  assert.equal(chatDisplayText(JSON.stringify([{type:'image_url',image_url:{url:'hidden'}}]), 'user'), 'Изображение · файл недоступен');
  assert.equal(chatDisplayText('{"hello":true}', 'user'), '{"hello":true}');
  assert.equal(chatDisplayText('```\nhello\n```', 'assistant'), '```\nhello\n```');
});
test('session identity uses the direct native account, including old origin metadata', () => {
  assert.deepEqual(sessionParticipant({chat_id:'456',user_id:'456',display_name:'Борис'}), {telegramId:'456',name:'Борис'});
  assert.deepEqual(sessionParticipant({origin_json:'{"chat_id":"123","user_id":"123","user_name":"Анна"}'}), {telegramId:'123',name:'Анна'});
  assert.equal(sessionParticipant({chat_id:'-100',user_id:'123'}).telegramId, null);
});
test('empty and tool-call pages retain a cursor in both directions and never change source', async () => {
  mkdirSync('tmp', {recursive:true});
  const home = mkdtempSync(join(process.cwd(), 'tmp/chat-display-'));
  let db;
  try {
    db = new DatabaseSync(join(home,'state.db'));
    db.exec("CREATE TABLE sessions(id TEXT,source TEXT,title TEXT,started_at REAL,last_activity_at REAL,user_id TEXT,chat_id TEXT,display_name TEXT); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL,tool_calls TEXT); INSERT INTO sessions VALUES('s','telegram','Topic',1,1,'456','456','Борис')");
    const insert = db.prepare("INSERT INTO messages VALUES(?,'s',?,?,1,?)");
    insert.run(1,'user',wrapped,null); insert.run(2,'assistant','  ',null); insert.run(3,'assistant','Internal tool narration','[{"id":"tool"}]'); insert.run(4,'assistant','Готово',null);
    const before = db.prepare('SELECT * FROM messages ORDER BY id').all();
    const reader = createChatRead(), profile = {userId:'owner',home,workerUid:process.getuid()};
    for (const order of ['asc','desc']) {
      let cursor, messages = [], empty = 0;
      do {
        const page = await reader({operation:'admin-chats-get',profile,id:'s',order,limit:1,cursor});
        messages.push(...page.messages); if (!page.messages.length) empty++;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(empty,2); assert.deepEqual(messages.map(m=>m.text).sort(),[body,'Готово'].sort());
    }
    const list = await reader({operation:'admin-chats-list',profile,limit:10});
    assert.equal(list.items[0].participant.telegramId,'456');
    assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(),before);
  } finally { db?.close(); rmSync(home,{recursive:true,force:true}); }
});

test('profile metadata is read only after admin audit and confirmed account ownership',async()=>{
 const headers={cookie:'fixture',origin:'https://example.test'}, calls=[];
 const authCall=async(op)=>{
   calls.push(op);
   if(op==='session')return {status:200,body:{session:{},user:{role:'admin',status:'active'}}};
   if(op==='identity-get')return {user:{id:'owner',profileId:'p'},telegramIds:['123','456']};
   return {status:200};
 };
 const options={origin:headers.origin,cursorKey:'x'.repeat(32),registry:async()=>({version:1,profiles:{1001:{userId:'owner',profileId:'p',status:'active'}}}),authCall,
   chatRead:async()=>({items:[],nextCursor:null}),telegramProfiles:{get:async id=>{calls.push(id);return {telegramId:id,name:id==='123'?'Анна':'Борис',username:null,avatar:null};}}};
 const control=new Control(options);
 const result=await control.invoke('admin-chats-list',{headers,userId:'owner'});
 assert.equal(result.status,200);assert.deepEqual(result.body.profiles.map(p=>p.name),['Анна','Борис']);
 assert.deepEqual(calls,['session','admin-audit','identity-get','123','456']);
 calls.length=0;
 const denied=new Control({...options,authCall:async op=>{calls.push(op);return {status:403};}});
 assert.equal((await denied.invoke('admin-chats-list',{headers,userId:'owner'})).status,403);assert.deepEqual(calls,['session']);
 const foreign=new Control({...options,authCall:async op=>op==='identity-get'?{user:{id:'foreign',profileId:'p'},telegramIds:['999']}:authCall(op)});
 assert.equal((await foreign.invoke('admin-chats-list',{headers,userId:'owner'})).body.profiles,undefined);
});
test('failed optional profile capture never changes authorized identity resolution',async()=>{
 const result={user:{id:'owner',status:'active'}};
 assert.equal(await privateCall({control:{telegramProfiles:{get:async()=>{throw Error('offline');}}},authCall:async()=>result},'identity.resolve',{telegramId:'123'}),result);
});
