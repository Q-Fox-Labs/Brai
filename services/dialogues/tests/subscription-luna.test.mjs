// ABOUTME: Проверяет private native transport без модели и рабочих credentials.
// ABOUTME: Проверяет фактический выход процесса и отсутствие ambient auth в окружении.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {NativeSocket,createSubscriptionLuna} from '../dist/subscription-luna.js';
test('private stdio передаёт Unicode и ждёт выхода native',async()=>{
 const script="process.stdin.setEncoding('utf8');process.stdin.once('data',x=>{process.stdout.write(JSON.stringify({data:x,ambient:process.env.OPENAI_API_KEY??null})+'\\n')});setInterval(()=>{},1000)";
 const child=new NativeSocket(process.execPath,['-e',script],'/tmp','/tmp');
 const opened=once(child,'open');const message=once(child,'message');
 try{await opened;child.send('Привет');const [raw]=await message;const result=JSON.parse(raw.toString());assert.equal(result.data,'Привет\n');assert.equal(result.ambient,null);}
 finally{const closed=once(child,'close');child.terminate();await closed;assert.equal(child.readyState,3);}
});
test('неявные пути к launcher отклоняются до запуска модели',()=>{
 assert.throws(()=>createSubscriptionLuna({binary:'codex'}),/INVALID_SUBSCRIPTION_CONFIG/);
});
