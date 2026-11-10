// ABOUTME: Проверяет фактический Telegram источник, вложения и правки через защищённые снимки.
// ABOUTME: Использует временные профили; native заглушки не принимаются за сообщения Telegram.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createChatRead, Control } from '../control.mjs';

test('Telegram source preserves exact text and media; changes update old messages without a model fallback', async () => {
 const root=mkdtempSync(join(process.cwd(),'tmp/exact-telegram-')), pid='11111111-1111-4111-8111-111111111111';
 const home=join(root,'worker'), journal=join(root,'journals'), directory=join(journal,pid);
 mkdirSync(home);mkdirSync(directory,{recursive:true});
 const path=join(directory,'telegram.sqlite3'), db=new DatabaseSync(path);
 db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,chat TEXT,thread TEXT,telegram_id TEXT,direction TEXT,name TEXT,username TEXT,text TEXT,at TEXT,edited TEXT,kind TEXT,attachments TEXT,deleted INTEGER);
 CREATE TABLE changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,message INTEGER);`);
 const insert=db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
 const exact=['❌ HTTP 403: Error code: 403','🔑 Подключение отклонено\n\n  👩‍💻  '];
 const ref={artifactId:'22222222-2222-4222-8222-222222222222',filename:'voice.bin',mimeType:'audio/ogg'};
 for(let i=1;i<=60;i++){
  insert.run(i,'123','topic',''+i,i<3?'out':'in','Имя 👩‍💻','actual_user',exact[i-1]??'  **буквальный текст**  ','2026-01-01T00:00:00Z',null,i===60?'voice':'text',JSON.stringify(i===60?[ref]:[]),0);
  db.prepare('INSERT INTO changes(message) VALUES(?)').run(i);
 }
 const filesRoot=join(home,'brai-files');mkdirSync(filesRoot);
 const filesDb=new DatabaseSync(join(filesRoot,'files.sqlite'));
 filesDb.exec('CREATE TABLE items(artifact TEXT,ref TEXT,source TEXT,position INTEGER)');
 const input={artifactId:'33333333-3333-4333-8333-333333333333',filename:'photo.bin',mimeType:'image/png',localPath:'/private/not-public'};
 filesDb.prepare('INSERT INTO items VALUES(?,?,?,?)').run(input.artifactId,JSON.stringify(input),JSON.stringify({platform:'telegram',chat:'123',thread:'topic',messageId:'59'}),0);
 filesDb.prepare('INSERT INTO items VALUES(?,?,?,?)').run(ref.artifactId,JSON.stringify(ref),JSON.stringify({platform:'telegram',chat:'456',thread:'topic',messageId:'59'}),0);
 filesDb.close();
 const native=new DatabaseSync(join(home,'state.db'));
 native.exec("CREATE TABLE sessions(id TEXT,source TEXT,chat_id TEXT,thread_id TEXT,title TEXT,display_name TEXT,last_activity_at INTEGER);CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp INTEGER);INSERT INTO sessions VALUES('native','telegram','123','older','Историческая тема','Имя из Telegram',1);INSERT INTO messages VALUES(1,'native','assistant','Your request was not processed.',1)");
 native.close();
 const profile={userId:'owner',profileId:pid,home,workerUid:process.getuid()};
 const reader=createChatRead({telegramJournalRoot:journal,telegramJournalUid:process.getuid()});
 const request={source:'telegram',operation:'admin-chats-get',profile,id:JSON.stringify(['123','topic']),order:'desc',limit:100};
 try{
  const list=await reader({...request,operation:'admin-chats-list'});
  assert.equal(list.source,'telegram');assert.equal(list.items[0].participant.name,'Имя 👩‍💻');
  const metadata=await reader({...request,operation:'admin-chats-list',cursor:list.nextCursor});
  assert.equal(metadata.items[0].title,'Историческая тема');
  assert.equal(metadata.items[0].participant.name,'Имя из Telegram');
  assert.deepEqual((await reader({...request,id:metadata.items[0].id})).messages,[]);
  const all=await reader(request);
  assert.deepEqual(all.messages.slice(0,2).map(m=>m.text),exact);
  assert.deepEqual(all.messages.at(-1).attachments,[ref]);
  assert.equal(all.messages.at(-2).attachments[0].artifactId,input.artifactId);
  assert.equal(all.messages.at(-2).attachments.length,1);
  assert.ok(!JSON.stringify(all).includes('/private/'));
  assert.ok(!JSON.stringify(all).includes('Your request'));
  db.prepare("UPDATE messages SET text='  исправлено  ',edited='2026-01-02' WHERE id=1").run();
  db.prepare('INSERT INTO changes(message) VALUES(1)').run();
  db.prepare("UPDATE messages SET deleted=1,text='',attachments='[]' WHERE id=2").run();
  db.prepare('INSERT INTO changes(message) VALUES(2)').run();
  const update=await reader({...request,cursor:all.updatesCursor,limit:1});
  assert.equal(update.messages[0].text,'  исправлено  ');assert.ok(update.nextCursor);
  const deleted=await reader({...request,cursor:update.nextCursor,limit:1});
  assert.equal(deleted.messages[0].deleted,true);
  const headers={cookie:'session',origin:'https://test.invalid'};
  const control=new Control({origin:headers.origin,cursorKey:'k'.repeat(32),registry:async()=>({version:1,profiles:{[process.getuid()]:{...profile,status:'active'}}}),
   authCall:async name=>name==='session'?{status:200,body:{session:{},user:{role:'admin',status:'active'}}}:{status:200},chatRead:reader});
  const page=await control.invoke('admin-chats-get',{headers,userId:'owner',source:'telegram',chatId:request.id,order:'desc',limit:1});
  assert.equal(page.status,200);assert.ok(page.body.updatesCursor.includes('.'));
  const changed=await control.invoke('admin-chats-get',{headers,userId:'owner',source:'native',chatId:request.id,order:'desc',limit:1,cursor:page.body.updatesCursor});
  assert.equal(changed.status,400);
  const foreign=await control.invoke('admin-chats-get',{headers,userId:'foreign',source:'telegram',chatId:request.id});
  assert.equal(foreign.status,404);
  const beforeLarge=(await reader(request)).updatesCursor;
  db.exec("ALTER TABLE messages ADD COLUMN rich TEXT");
  const rich=JSON.stringify({blocks:[{type:'paragraph',text:'я'.repeat(24000)}]});
  db.prepare("UPDATE messages SET text='',rich=?,kind='rich' WHERE id>=3").run(rich);
  for(let id=3;id<=60;id++)db.prepare('INSERT INTO changes(message) VALUES(?)').run(id);
  let cursor, ids=[];
  do{const chunk=await reader({...request,cursor});assert.ok(Buffer.byteLength(JSON.stringify(chunk))<=900000);ids.push(...chunk.messages.map(m=>m.id));cursor=chunk.nextCursor;}while(cursor);
  assert.equal(new Set(ids).size,60);
  cursor=beforeLarge;ids=[];
  do{const chunk=await reader({...request,cursor});assert.ok(Buffer.byteLength(JSON.stringify(chunk))<=900000);ids.push(...chunk.messages.map(m=>m.id));cursor=chunk.nextCursor;}while(cursor);
  assert.equal(new Set(ids).size,58);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
