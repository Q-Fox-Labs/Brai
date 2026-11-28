// ABOUTME: Проверяет доступ к личным Диалогам независимо от готовности Hermes.
// ABOUTME: Владелец задан защищённой конфигурацией endpoint, а не запросом клиента.
import type {Pool} from 'pg';
export type DialoguesBinding={subject:string;userId:string;profileId:string};
/** Проверяет конфигурацию отдельных subjects; NATS ACL выдаёт клиенту только его subject. */
export function dialoguesBindings(value:unknown):DialoguesBinding[]{
 if(!Array.isArray(value))throw new Error('INVALID_DIALOGUES_BINDINGS');
 const subjects=new Set<string>();
 return value.map(row=>{
  if(!row||Object.keys(row).sort().join(',')!=='profileId,subject,userId'||
   typeof row.subject!=='string'||!/^brai\.auth\.v2\.dialogues-access\.[a-f0-9]{64}$/.test(row.subject)||
   typeof row.userId!=='string'||!row.userId||typeof row.profileId!=='string'||!row.profileId||subjects.has(row.subject))throw new Error('INVALID_DIALOGUES_BINDINGS');
  subjects.add(row.subject);return row;
 });
}
/** Возвращает только principal и право доступа; ошибки БД не становятся разрешением. */
export async function dialoguesAccess(pool:Pool,binding:DialoguesBinding,input:unknown){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('Invalid request');
 const row=(await pool.query(`SELECT i.user_id,i.profile_id,i.role,i.status,
  o.kind,o.activate_on_success FROM brai_identity i
  LEFT JOIN brai_user_operation o ON o.user_id=i.user_id AND o.generation=i.lifecycle_generation
  WHERE i.user_id=$1`,[binding.userId])).rows[0];
 // AIDEV-NOTE: prepare с явным намерением активации не ждёт подтверждения Hermes.
 const allowed=Boolean(row&&row.profile_id===binding.profileId&&(
  row.role==='welcome'&&row.status==='provisioning'||
  ['creator','admin','user','guest'].includes(row.role)&&
   (row.status==='active'||row.status==='provisioning'&&row.kind==='prepare'&&row.activate_on_success===true)
 ));
 return {allowed,userId:binding.userId,profileId:binding.profileId};
}
