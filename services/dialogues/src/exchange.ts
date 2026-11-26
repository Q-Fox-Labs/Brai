// ABOUTME: Объединяет управление ходом и выдачу контекста в одном MCP-входе.
// ABOUTME: Операция сохраняется до выдачи; неизвестный исход не повторяется вслепую.
import {createHash} from 'node:crypto';
import {bytes,DialoguesFault,fail,id,limits,object} from './domain.js';
import type {createStore} from './store.js';
import type {DeliveryCommit} from './context.js';

type Store=ReturnType<typeof createStore>;
const contextId=(request:string,consumer:string,instance:string)=>'exchange-context-'+createHash('sha256').update(JSON.stringify([request,consumer,instance])).digest('hex');

/** Выполняет одну операцию и, кроме успешного финала, возвращает доступный контекст. */
export async function exchange(store:Store,owner:string,raw:unknown,afterResponse?:DeliveryCommit) {
 const a=object(raw,['action','arguments','context']);
 const args=object(a.arguments??{},['request_id','dialogue','dialogue_id','turn_id','expected_version','messages','reconciled_no_final','changes','final','cursor','continuation_cursor','consumer_id','context_instance_id','reset','message_id','message_ids','offset','limit','target','summary_version','through_message_id','text','final_message_id','evidence','topic_id','query','after','format','input_ids','archive_only']);
 if(typeof a.action!=='string')fail('INVALID_ARGUMENT');
 const supplied=a.context===undefined?undefined:object(a.context,['consumer_id','context_instance_id','reset','format']);
 const context=supplied&&{consumer_id:supplied.consumer_id,context_instance_id:supplied.context_instance_id??'default',reset:supplied.reset,format:supplied.format};
 if(context){id(context.consumer_id);id(context.context_instance_id);if(context.reset!==undefined&&typeof context.reset!=='boolean')fail('INVALID_ARGUMENT');}
 if(a.action==='page')return store.pull(owner,args);
 if(a.action==='dialogue_get'){id(args.request_id);id(args.dialogue_id);return store.dialogueGet(owner,args.dialogue_id,args.cursor);}
 if(a.action==='read_many'){id(args.request_id);return store.readMany(owner,args.message_ids,args.cursor);}
 if(a.action==='topic_get'){
  id(args.topic_id);id(args.request_id);
  if(args.after!==undefined)id(args.after);
  return store.topics.get(owner,args.topic_id,args.after);
 }
 if(a.action==='topic_move'){
  id(args.request_id);id(args.dialogue_id);
  if(args.topic_id!==null)id(args.topic_id);
  return store.topics.move(owner,args.request_id,args.dialogue_id,args.topic_id);
 }
 if(a.action==='search'){
  id(args.request_id);if(args.topic_id!==undefined)id(args.topic_id);
  return store.topics.search(owner,args.query,args.topic_id);
 }
 const archive=['read','history','snapshot'].includes(a.action)&&(!context||args.archive_only===true);
 const automatic=['input','poll'].includes(a.action)&&!context;
 if(!context&&!archive&&!automatic&&!['update','finish'].includes(a.action))throw new DialoguesFault('INVALID_ARGUMENT',{field:'context',expected:'стабильный идентификатор потребителя'});
 if(!['input','update','finish','import','summary','repair','read','snapshot','history','poll'].includes(a.action))return fail('UNKNOWN_OPERATION');
 id(args.request_id);
 id(args.dialogue_id??args.dialogue?.id);
 if(automatic){
  const dialogue=args.dialogue_id??args.dialogue.id;
  return store.inThread(owner,dialogue,async()=>{
   const input=a.action==='input';
   const receipt=input?await store.turnInput(owner,args):{request_id:args.request_id,dialogue_id:dialogue};
   if(!input)await store.logExchange(owner,args.request_id,'poll',dialogue,null);
   const request_id=contextId(args.request_id,dialogue,'server');
   const inputs=input?args.messages.map((message:{id:string})=>message.id):[];
   try{
    return {...receipt,context:await store.pullThread(owner,dialogue,request_id,inputs,afterResponse)};
   }catch(error){
    return {...receipt,context_error:{code:error instanceof DialoguesFault?error.code:'CONTEXT_UNAVAILABLE'}};
   }
  });
 }
 let receipt:any;
 try {
  switch(a.action){
   case 'input': receipt=await store.turnInput(owner,args);break;
   case 'update': receipt=await store.turnUpdate(owner,args);break;
   case 'finish': return await store.turnFinish(owner,args);
   case 'import': receipt=await store.append(owner,args);break;
   case 'summary': receipt=await store.summary(owner,args);break;
   case 'repair': receipt=await store.turnRepair(owner,args);break;
   case 'read': {const {request_id,archive_only,...query}=args;id(request_id);receipt={request_id,...await store.message(owner,query)};break;}
   case 'snapshot': {const {request_id,archive_only,...query}=args;id(request_id);receipt={request_id,...await store.turnGet(owner,query)};break;}
   case 'history': {const {request_id,archive_only,...query}=args;id(request_id);receipt={request_id,...await store.history(owner,query)};break;}
   case 'poll': id(args.request_id);id(args.dialogue_id);receipt={request_id:args.request_id,dialogue_id:args.dialogue_id};break;
   default: return fail('UNKNOWN_OPERATION');
  }
 } catch(error) {
  if(a.action!=='finish'||!(error instanceof DialoguesFault)||!['PENDING_RESULTS','VERSION_CONFLICT'].includes(error.code))throw error;
  const snapshot=await store.turnGet(owner,{dialogue_id:args.dialogue_id,turn_id:args.turn_id});
  receipt={request_id:args.request_id,dialogue_id:args.dialogue_id,turn_id:args.turn_id,status:'rejected',code:error.code,...error.details,snapshot};
 }
 const dialogue=receipt.dialogue_id??args.dialogue_id??args.dialogue?.id;id(dialogue);id(args.request_id);
 if(['read','history','snapshot','poll'].includes(a.action)||receipt.status==='rejected')
  await store.logExchange(owner,args.request_id,receipt.status==='rejected'?'finish_rejected':a.action,dialogue,args.turn_id??null,(receipt.pending??[]).map((x:any)=>x.id));
 if(archive||!context)return receipt;
 const request_id=contextId(args.request_id,context!.consumer_id,context!.context_instance_id);
 const omitted=(context?.format==='compact'||context?.format==='index')&&a.action==='input'?{input_ids:args.messages.map((message:{id:string})=>message.id)}:{};
 const query={request_id,dialogue_id:dialogue,...context,...omitted};
 try{
  const page=await store.pull(owner,query);
  const result={...receipt,context_request_id:request_id,context:page};
  if(bytes(result)<=limits.responseBytes-256)return result;
  return {...receipt,context_request_id:request_id,context_error:{code:'CONTEXT_DEFERRED',arguments:query}};
 }catch(error){
  return {...receipt,context_request_id:request_id,context_error:{code:error instanceof DialoguesFault?error.code:'CONTEXT_UNAVAILABLE',arguments:query}};
 }
}
