// ABOUTME: Проверяет постоянный кэш миниатюр без настоящего Telegram и пользовательских данных.
// ABOUTME: Рестарт, конкуренция, закрытое фото и сетевые ошибки не вызывают бесконечных загрузок.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTelegramProfiles, telegramPhotoDownload } from '../telegram-profiles.mjs';
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'telegram-profile-'));
  chmodSync(root,0o700);
  return root;
}
test('profile is fetched once, survives restart and keeps two accounts separate', async () => {
  const root=fixture(); let calls=0, photos=0;
  try {
    const options={path:join(root,'cache.db'),requireRoot:false,
      info:async(_,id)=>{calls++;return {id,type:'private',first_name:id==='123'?'Анна':'Борис',username:'user_'+id,photo:{small_file_id:'small'}};},
      download:async(file,max)=>{photos++;assert.equal(file,'small');assert.equal(max,24576);return Buffer.from([255,216,255,217]);}};
    const cache=createTelegramProfiles(options);
    const values=await Promise.all(Array.from({length:10},()=>cache.get('123')));
    assert.equal(calls,1);assert.equal(photos,1);assert.equal(values[0].name,'Анна');assert.match(values[0].avatar,/^data:image\/jpeg;base64,/);
    assert.deepEqual(await createTelegramProfiles(options).get('123'),values[0]);assert.equal(calls,1);
    assert.equal((await cache.get('456')).name,'Борис');assert.equal(calls,2);assert.equal(statSync(options.path).mode&0o777,0o600);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('no photo is a durable result; failure is rate limited and never blocks identity',async()=>{
  const root=fixture();let calls=0;
  try {
    const options={path:join(root,'cache.db'),requireRoot:false,info:async(_,id)=>{calls++;if(id==='456')throw Error('offline');return {id,type:'private',first_name:'Анна'};},download:async()=>{throw Error('should not fetch');}};
    const cache=createTelegramProfiles(options);
    assert.equal((await cache.get('123')).avatar,null);await createTelegramProfiles(options).get('123');assert.equal(calls,1);
    assert.equal((await cache.get('456')).avatar,null);await createTelegramProfiles(options).get('456');assert.equal(calls,2);
    assert.equal(await cache.get('../bad'),null);assert.equal(calls,2);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('photo download stops at the byte limit and rejects external paths and redirects',async()=>{
  let reads=0,cancelled=false;
  const request=async url=>{
    assert.ok(url.startsWith('https://api.telegram.org/'));
    if(url.includes('/getFile'))return Response.json({ok:true,result:{file_path:'photos/small.jpg'}});
    return new Response(new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(20000));},cancel(){cancelled=true;}}));
  };
  await assert.rejects(telegramPhotoDownload('fixture',request)('small'),/PHOTO_TOO_LARGE/);
  assert.ok(reads<5);assert.equal(cancelled,true);
  await assert.rejects(telegramPhotoDownload('fixture',async()=>Response.json({ok:true,result:{file_path:'https://foreign.test/a.jpg'}}))('small'),/PHOTO_UNAVAILABLE/);
});
