// ABOUTME: Обслуживает настройки, журнал, список посетителей и решения по заявкам.
// ABOUTME: Проверяет действующую сессию администратора и не доверяет actor из запроса.
import {randomUUID} from 'node:crypto';
import {nextSlot} from './domain.mjs';
import {usage} from './storage.mjs';

const settingsFields={
 enabled:'boolean',model:'string',reasoning:'string',image_enabled:'boolean',request_limit:'number',image_limit:'number'
};
const validLimit=value=>Number.isInteger(value)&&value>=0&&value<=2147483647;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const fault=(status,message)=>Object.assign(Error(message),{status});

/** Все вызовы выполняются после проверки той же администраторской сессии Auth. */
export function welcomeAdmin(pool,auth,model) {
 async function audit(db,actor,action,target=null){
  await db.query('INSERT INTO welcome.audit(id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),actor.id,action,target]);
 }
 return async function handle(operation,input,headers){
  const actor=await auth.admin(headers);
  if(!actor)throw fault(403,'FORBIDDEN');
  switch(operation){
   case 'settings':{
    const {rows:[value]}=await pool.query('SELECT * FROM welcome.settings WHERE singleton');
    return {value,models:await model.catalog()};
   }
   case 'save-settings':{
    if(Object.entries(settingsFields).some(([key,type])=>typeof input[key]!==type)||!validLimit(input.request_limit)||!validLimit(input.image_limit))
     throw fault(400,'INVALID_SETTINGS');
    const selected=(await model.catalog()).find(entry=>entry.id===input.model);
    if(!selected?.reasoning.includes(input.reasoning))throw fault(400,'UNAVAILABLE_MODEL_SELECTION');
    const db=await pool.connect();
    try{
     await db.query('BEGIN');
     await db.query(`UPDATE welcome.settings SET enabled=$1,model=$2,reasoning=$3,image_enabled=$4,
      request_limit=$5,image_limit=$6 WHERE singleton`,Object.keys(settingsFields).map(key=>input[key]));
     await audit(db,actor,'settings.update');
     await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    return {saved:true};
   }
   case 'visitors':{
    const {rows}=await pool.query(`SELECT own.user_id,own.profile_id,own.telegram_id,own.name,own.username,
     origin.name AS inviter_name,origin.username AS inviter_username FROM welcome.visitors own
     LEFT JOIN welcome.visitors origin ON origin.user_id=own.inviter_id ORDER BY own.name,own.user_id`);
    const {rows:[settings]}=await pool.query('SELECT * FROM welcome.settings WHERE singleton');
    return {items:await Promise.all(rows.map(async row=>{
     const meter=await usage(pool,row.user_id);
     return {...row,requests:meter.requests.length,images:meter.images.length,requestLimit:settings.request_limit,imageLimit:settings.image_limit,
      requestNext:nextSlot(meter.requests,settings.request_limit,+meter.now).at,
      imageNext:nextSlot(meter.images,settings.image_limit,+meter.now).at};
    }))};
   }
   case 'chats': {
    const {rows}=await pool.query(`SELECT t.user_id,t.dialogue_id,min(t.created_at) AS opened_at,max(t.created_at) AS updated_at,
     v.name,v.username FROM welcome.turns t JOIN welcome.visitors v ON v.user_id=t.user_id
     GROUP BY t.user_id,t.dialogue_id,v.name,v.username ORDER BY updated_at DESC`);
    await audit(pool,actor,'chats.list');
    return {items:rows};
   }
   case 'messages':{
    const {rows}=await pool.query(`SELECT bot_id,update_id,input_text,result,created_at FROM welcome.turns
     WHERE user_id=$1 AND dialogue_id=$2 ORDER BY created_at,update_id`,[input.userId,input.dialogueId]);
    await audit(pool,actor,'chats.read',input.userId);
    return {items:rows};
   }
   case 'applications':{
    const {rows}=await pool.query(`SELECT a.*,v.name,v.username,v.telegram_id FROM welcome.applications a
     JOIN welcome.visitors v ON v.user_id=a.user_id ORDER BY a.created_at DESC`);
    for(const row of rows)if(row.status==='approving'){
     const status=await auth.operation(headers,'welcome-guest:'+row.id);
     if(status?.body?.operation?.state==='succeeded'){
      await pool.query("UPDATE welcome.applications SET status='approved' WHERE id=$1 AND status='approving'",[row.id]);
      row.status='approved';
     }
     row.operation=status?.body?.operation;
    }
    return {items:rows};
   }
   case 'decision':{
    if(!['approve','reject'].includes(input.decision)||!uuid.test(input.applicationId??''))throw fault(400,'INVALID_DECISION');
    const db=await pool.connect();
    let selected;
    try{
     await db.query('BEGIN');
     selected=(await db.query(`SELECT a.*,v.telegram_id FROM welcome.applications a JOIN welcome.visitors v ON v.user_id=a.user_id
      WHERE a.id=$1 FOR UPDATE OF a`,[input.applicationId])).rows[0];
     if(!selected)throw fault(404,'NOT_FOUND');
     const status=input.decision==='approve'?'approving':'rejected';
     if(selected.status==='pending'){
      await db.query('UPDATE welcome.applications SET status=$2,decided_by=$3,decided_at=clock_timestamp() WHERE id=$1',[selected.id,status,actor.id]);
      await audit(db,actor,'application.'+input.decision,selected.user_id);
     }else if(selected.status!==status&&!(input.decision==='approve'&&selected.status==='approved')){
      throw fault(409,'ALREADY_DECIDED');
     }
     await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
    if(input.decision==='reject'||selected.status==='approved')return {status:input.decision==='reject'?'rejected':'approved'};
    const grant=await auth.approve(headers,selected.telegram_id,'welcome-guest:'+selected.id);
    if(grant.status!==200)throw fault(grant.status,'WELCOME_GRANT_FAILED');
    await pool.query('UPDATE welcome.applications SET operation_id=$2 WHERE id=$1',[selected.id,grant.body.operation.id]);
    return {status:'approving',operation:grant.body.operation};
   }
   default:throw fault(404,'NOT_FOUND');
  }
 };
}
