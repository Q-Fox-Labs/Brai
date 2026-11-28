// ABOUTME: Проверяет доступ к Диалогам при незапущенном рабочем процессе Hermes.
// ABOUTME: Синтетическая БД подтверждает политику, а не реальное подключение NATS.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dialoguesAccess,dialoguesBindings} from '../dist/dialogues-access.js';
const binding={subject:'brai.auth.v2.dialogues-access.'+'a'.repeat(64),userId:'user',profileId:'profile'};
const pool=row=>({query:async(sql,params)=>{assert.deepEqual(params,['user']);return {rows:row?[row]:[]};}});
const base={user_id:'user',profile_id:'profile',role:'guest',status:'active'};
test('активный пользователь не требует Hermes',async()=>assert.equal((await dialoguesAccess(pool(base),binding,{})).allowed,true));
test('Welcome получает только свой допуск до подготовки Hermes',async()=>{
 const welcome={...base,role:'welcome',status:'provisioning'};
 assert.equal((await dialoguesAccess(pool(welcome),binding,{})).allowed,true);
 for(const patch of [{status:'active'},{status:'blocked'},{profile_id:null},{profile_id:'other'}]){
  assert.equal((await dialoguesAccess(pool({...welcome,...patch}),binding,{})).allowed,false);
 }
});
test('явный prepare активирует только доступ к сервису',async()=>{
 assert.equal((await dialoguesAccess(pool({...base,status:'provisioning',kind:'prepare',activate_on_success:true}),binding,{})).allowed,true);
 for(const patch of [{status:'blocked',kind:'prepare',activate_on_success:true},{status:'provisioning',kind:'stop',activate_on_success:true},{status:'provisioning',kind:'prepare',activate_on_success:false},{profile_id:'other'},{role:'unknown'}])assert.equal((await dialoguesAccess(pool({...base,...patch}),binding,{})).allowed,false);
});
test('клиент не выбирает пользователя',async()=>{
 await assert.rejects(dialoguesAccess(pool(base),binding,{userId:'other'}));
 assert.equal((await dialoguesAccess(pool(null),binding,{})).allowed,false);
 await assert.rejects(dialoguesAccess({query:async()=>{throw new Error('down');}},binding,{}));
});
test('subjects уникальны и не содержат wildcard',()=>{
 assert.deepEqual(dialoguesBindings([binding]),[binding]);
 for(const rows of [[binding,binding],[{...binding,subject:'brai.auth.>'}],[{...binding,owner:'other'}]])assert.throws(()=>dialoguesBindings(rows));
});
