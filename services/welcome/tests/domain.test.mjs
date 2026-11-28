// ABOUTME: Проверяет серверные решения Welcome и скользящее окно квот.
// ABOUTME: Навык модели, Telegram и внешние сервисы не требуются для этих проверок.
import test from 'node:test';
import assert from 'node:assert/strict';
import {charges,decision,nextQuestion,nextSlot,referralCode} from '../src/domain.mjs';
import {dialogueId} from '../src/service.mjs';

test('выбывание квоты происходит отдельно для каждого из последних 24 часов',()=>{
 const now=Date.parse('2026-11-28T12:00:00Z');
 const day=86400000;
 assert.deepEqual(nextSlot([now-day,now-day+60000,now-5000],2,now),{denied:true,at:'2026-11-28T12:01:00.000Z'});
 assert.deepEqual(nextSlot([now-day,now-day+60000,now-5000],1,now),{denied:true,at:'2026-11-29T11:59:55.000Z'});
 assert.deepEqual(nextSlot([now-day,now-5000],2,now),{denied:false,at:null});
 assert.deepEqual(nextSlot([],0,now),{denied:true,at:null});
});
test('анкета, переключатели и рефералы не списываются как прямые запросы',()=>{
 for(const action of ['apply','question','voice-on','voice-off','referral'])assert.deepEqual(charges(action),{request:false,image:false});
 assert.deepEqual(charges('image'),{request:true,image:true});
 assert.deepEqual(charges('answer'),{request:true,image:false});
 assert.equal(nextQuestion({}),'occupation');
 assert.equal(nextQuestion({occupation:'Врач'}),'purpose');
 assert.equal(nextQuestion({occupation:'Врач',purpose:'Ведение личного дневника'}),null);
 assert.equal(decision({action:'question',text:'',valid:true},null).action,'answer');
 assert.throws(()=>decision({action:'shell',text:'df',valid:true},null));
});
test('реферальный параметр отделён от приглашений и ключ чата устойчив',()=>{
 assert.equal(referralCode('/start ref_woRj-z_2'),'woRj-z_2');
 assert.equal(referralCode('/start@brai_ai_test_bot invite_abcdef'),null);
 assert.equal(dialogueId({botId:'123',telegramId:'456'}),'telegram:123:456:0');
 assert.equal(dialogueId({botId:'123',telegramId:'456',threadId:'7'}),'telegram:123:456:7');
});
